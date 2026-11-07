// ルームの同期エンジン（設計 docs/dev/02-architecture.md §1〜§5）。
// React に依存せず、通信・時計・ストレージ・ゲーム一覧はすべて注入する。
// 本番は useRoom が realClock と Supabase / BroadcastChannel の Transport を渡し、
// テストは疑似ネットワークの Clock と Link を渡して、複数端末を 1 プロセスで動かす。
//
// 時刻の基準：lastSeen やタイマーはローカル時計（clock.now()）、
// ゲームの時刻（schedule().at / endsAt / startedAt）はルーム共通時計（now() = ローカル + ホストとの差の推定）。
import type { Clock } from '../lib/clock';
import type { ConnectionStatus, Transport } from '../lib/transport';
import {
  acceptAction,
  ackOf,
  compareStates,
  createRoom,
  hasKnownGames,
  isImplausibleJump,
  MAX_ROOM_PLAYERS,
  pickNextHost,
  reduceRoom,
  takeOverHost,
  type GameRegistry,
  type RoomAction,
  type RoomState,
} from './logic';
import { allowRate, parseRoomState, parseWireMessage, PROTOCOL_VERSION, type WireMessage } from './protocol';
import type { RoomStatus } from './types';

// タイマー値（設計 §4）
export const ROOM_TIMINGS = {
  TICK_MS: 500, // 定期処理
  HEARTBEAT_MS: 3000, // 参加者の生存通知（直前に何か送っていれば省略）
  HOST_RESYNC_MS: 2500, // ホストの定期状態配信（ホストは hb を送らない）
  OFFLINE_AFTER_MS: 9000, // オンライン判定・ホスト喪失判定
  LONE_TAKEOVER_MS: 30000, // 自分以外誰もオンラインでないときの引き継ぎ待ち（ADR-7）
  STALL_MS: 9000, // 無通信検知（§3.2）
  STATE_THROTTLE_MS: 200, // 状態配信の間引き（ADR-5）
  SYNC_RETRY_MS: 1000, // 状態待ちの間の同期要求の間隔
  SYNC_REPLY_MIN_MS: 1000, // 同じ相手の同期要求に応える最小間隔
  RESTORE_AFTER_MS: 3000, // 誰の声も聞こえないとき、スナップショットから復元するまで
  JOIN_TIMEOUT_MS: 8000, // connected からの「部屋が見つかりません」
  RESEND_MS: 1000, // 未確認アクションの再送間隔
  PENDING_TTL_MS: 10000, // 未確認アクションの寿命
  OUTBOX_MAX: 50, // 未確認アクションの保持件数
  ACTION_RATE: { count: 10, windowMs: 1000 }, // ホストの 1 人あたり受付上限（アクション + join）
  JOIN_MIN_MS: 1000, // join の送信間隔の下限
  RESUME_GAP_MS: 3000, // tick の間隔がこれを超えたら「スリープ明け」とみなして resume()
  SAVE_MIN_MS: 1000, // スナップショット保存の間隔の下限
} as const;

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type EngineDeps = {
  code: string;
  me: string;
  name: string;
  create: boolean;
  transport: Transport;
  clock: Clock;
  storage: KeyValueStore;
  games: GameRegistry;
  // 部屋を作るときに最初に選ばれているゲーム。省略時は games の先頭（Phase 1 で追加した任意項目）
  defaultGame?: string;
};

export type EngineSnapshot = {
  status: RoomStatus;
  connection: ConnectionStatus;
  state: RoomState | null;
  isHost: boolean;
  online: Set<string>;
};

type Pending = { seq: number; action: RoomAction; firstSentAt: number; lastSentAt: number };

export const snapshotKey = (code: string) => `sukima:room:${code}`;

export class RoomEngine {
  private readonly d: EngineDeps;
  private readonly t = ROOM_TIMINGS;

  private state: RoomState | null = null;
  private connection: ConnectionStatus;
  // 自分で退出した / 外された / 満員。これになったら以後送らない（full は受信だけ続ける）
  private terminal: 'left' | 'kicked' | 'full' | null = null;
  private notFound = false;
  private started = false;
  private disposed = false;
  private createdOnce = false;
  // このセッションで一度でもメンバーになったか（満員と外されたの区別に使う）
  private wasMember = false;

  // ルーム共通時計とのずれ（ホスト時刻 - 自分の時刻）。サンプル中の最大値＝遅延最小の推定を使う
  private offsetSamples: number[] = [];
  private offset = 0;

  // 生存確認（ローカル時計）
  private readonly lastSeen = new Map<string, number>();
  // bye を送ってきた人、または状態を失った（sync を送ってきた）ホスト。ホスト喪失の即時判定に使う
  private readonly departed = new Set<string>();
  // 最後に join を送ってきた（＝自分をメンバーと見なしていない）端末。state・action・hb を受けたら外す。
  // join を送るのは状態待ちの端末か、受け取った状態に自分がいない端末で、どちらも checkTakeover でホストを引き継がない。
  // そういう端末をホスト候補に数えると、他の全員が引き継ぎを任せたまま誰も引き継がず部屋が固まる（P2-10）
  private readonly joining = new Set<string>();
  private online: Set<string>;
  private lastRecvAt: number | null = null;
  // 状態を持つ端末（state・action・hb を送る端末）の声を聞いたか。状態待ちの端末は sync・join・bye しか送らない。
  // スナップショットからの復元の条件に使う（QA-BUG-02：互いの sync・join を聞いただけの 2 人が、どちらも復元しなかった）
  private heardStateful = false;
  private stallFired = false;

  private connectedAt = Number.NEGATIVE_INFINITY;
  private resumedAt = Number.NEGATIVE_INFINITY;
  private joinWaitFrom: number | null = null;
  private lastTickAt = 0;

  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastStateSentAt = Number.NEGATIVE_INFINITY;
  private lastSyncAt = Number.NEGATIVE_INFINITY;
  private lastJoinAt = Number.NEGATIVE_INFINITY;
  private lastSaveAt = Number.NEGATIVE_INFINITY;

  // 参加者側：送ったアクション（確認後も PENDING_TTL_MS の間は残す。ADR-4）
  private outbox: Pending[] = [];
  private nextSeq = 1;

  // ホスト側：参加者ごとの受付履歴と同期要求への返信時刻
  private readonly rate = new Map<string, number[]>();
  private readonly syncReplyAt = new Map<string, number>();

  private cancelTick: (() => void) | null = null;
  private cancelGame: (() => void) | null = null;
  private cancelBroadcast: (() => void) | null = null;
  private cancelSave: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: EngineSnapshot;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.connection = deps.transport.status;
    this.online = new Set([deps.me]);
    this.snapshot = { status: 'connecting', connection: this.connection, state: null, isHost: false, online: this.online };
  }

  // ---------- 公開 API ----------

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const { transport } = this.d;
    this.unsubs.push(
      transport.onMessage((m) => this.handleRaw(m)),
      transport.onStatus((s) => this.handleStatus(s)),
    );
    this.lastTickAt = this.local();
    this.cancelTick = this.d.clock.setTimeout(() => this.tick(), this.t.TICK_MS);
    // 生成直後に既につながっている Transport もある
    this.handleStatus(transport.status);
  }

  // bye を送り、タイマー停止、transport.close
  dispose(): void {
    if (this.disposed) return;
    if (this.terminal !== 'left') {
      this.sendWire({ v: PROTOCOL_VERSION, t: 'bye', from: this.d.me });
      this.saveNow();
    }
    this.disposed = true;
    for (const c of [this.cancelTick, this.cancelGame, this.cancelBroadcast, this.cancelSave]) c?.();
    this.cancelTick = this.cancelGame = this.cancelBroadcast = this.cancelSave = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.d.transport.close();
    this.listeners.clear();
  }

  // useSyncExternalStore 用：変化がない限り同じオブジェクトを返す
  getSnapshot = (): EngineSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // ホストならローカル即時適用、参加者なら seq 付きで送信（未確認なら自動再送）
  dispatch = (action: RoomAction): void => {
    if (this.disposed || this.terminal || !this.state) return;
    if (this.isHostNow()) {
      this.applyAsHost(action, this.d.me);
      return;
    }
    // ホストのタイマー専用のアクションは送らない（受け側でも捨てられる）
    if (action.type === 'gameSystem') return;
    const entry: Pending = { seq: this.nextSeq++, action, firstSentAt: this.local(), lastSentAt: Number.NEGATIVE_INFINITY };
    this.outbox.push(entry);
    if (this.outbox.length > this.t.OUTBOX_MAX) this.outbox.splice(0, this.outbox.length - this.t.OUTBOX_MAX);
    if (this.sendWire(this.actionMsg(entry.seq, action))) entry.lastSentAt = this.local();
  };

  // ルーム共通時計（ホスト基準）
  now = (): number => this.d.clock.now() + this.offset;

  leave = (): void => {
    if (this.disposed || this.terminal === 'left') return;
    const cur = this.state;
    const { me } = this.d;
    if (cur && !this.terminal && cur.players.some((p) => p.id === me)) {
      if (this.isHostNow()) {
        // ホストが抜ける場合は、オンラインの人にホストを譲ってから抜ける
        const left = reduceRoom(cur, { type: 'leave' }, me, this.now(), this.d.games);
        const nextHost = pickNextHost(left, this.online, me) ?? left.players[0]?.id ?? left.hostId;
        const handed: RoomState = { ...left, hostId: nextHost, epoch: left.epoch + 1, version: left.version + 1 };
        this.sendWire({ v: PROTOCOL_VERSION, t: 'state', from: me, state: handed, sentAt: this.now() });
      } else {
        // 退出後は再送できないので、同じ seq を 2 回続けて送る（重複は seq で無害）
        const msg = this.actionMsg(this.nextSeq++, { type: 'leave' });
        this.sendWire(msg);
        this.sendWire(msg);
      }
    }
    this.sendWire({ v: PROTOCOL_VERSION, t: 'bye', from: me });
    this.terminal = 'left';
    this.stopHostTimers();
    // 退出した部屋を、次に同じコードで入ったときに復元しない
    this.cancelSave?.();
    this.cancelSave = null;
    this.safeSet('');
    this.emit();
  };

  // failed / notfound からページ再読み込みなしで接続し直す
  retry = (): void => {
    if (this.disposed || this.terminal === 'left' || this.terminal === 'kicked') return;
    this.notFound = false;
    this.joinWaitFrom = null;
    this.d.transport.reconnect();
    this.emit();
  };

  // visibilitychange→visible / pageshow / online、または tick の間隔からスリープ明けを検知したとき
  resume = (): void => {
    if (this.disposed || this.terminal === 'left' || this.terminal === 'kicked') return;
    const now = this.local();
    // この後 OFFLINE_AFTER_MS は引き継ぎ判定をしない（止まっている間に古くなった lastSeen で誤って引き継がないため）
    this.resumedAt = now;
    this.lastTickAt = now;
    const { transport, me } = this.d;
    if (transport.status !== 'connected') {
      // つながったら handleStatus → onConnected が同期要求を送る
      transport.reconnect();
      this.emit();
      return;
    }
    // hb は状態を持つ端末だけが送る（状態待ちの端末の hb を、復元を止める「状態を持つ端末の声」と取り違えないように）
    if (this.state) this.sendWire({ v: PROTOCOL_VERSION, t: 'hb', from: me });
    if (!this.state) {
      this.sendSync();
      this.sendJoin(true);
    } else if (this.isHostNow()) {
      // 他の誰かが新しいホストになっていれば、反論されて自分が降りる
      this.requestBroadcast();
    } else {
      this.sendSync();
      this.resendPending(true);
    }
    this.emit();
  };

  setNetworkOnline = (online: boolean): void => {
    if (this.disposed) return;
    this.d.transport.setNetworkOnline(online);
    if (online) this.resume();
    else this.emit();
  };

  // ページを閉じる・隠す直前。bye を送り、スナップショットを保存する
  pageHide = (): void => {
    if (this.disposed || this.terminal === 'left') return;
    this.sendWire({ v: PROTOCOL_VERSION, t: 'bye', from: this.d.me });
    this.saveNow();
  };

  // ---------- 受信 ----------

  private handleStatus(s: ConnectionStatus) {
    if (this.disposed) return;
    this.connection = s;
    if (s === 'connected') this.onConnected();
    this.emit();
  }

  private onConnected() {
    const now = this.local();
    this.connectedAt = now;
    if (this.terminal) return;
    const { me, name, create, code } = this.d;
    if (!this.state) {
      if (create && !this.createdOnce) {
        this.createdOnce = true;
        const defaultGame = this.d.defaultGame ?? Object.keys(this.d.games)[0] ?? '';
        this.commit(createRoom(code, { id: me, name }, defaultGame), true);
        return;
      }
      if (this.joinWaitFrom === null) this.joinWaitFrom = now;
      this.sendSync();
      this.sendJoin(true);
      return;
    }
    if (this.isHostNow()) this.requestBroadcast();
    else {
      this.sendSync();
      this.resendPending(true);
    }
  }

  private handleRaw(raw: unknown) {
    if (this.disposed || this.terminal === 'left' || this.terminal === 'kicked') return;
    const msg = parseWireMessage(raw, this.d.code);
    if (!msg || msg.from === this.d.me) return;
    const now = this.local();
    // 何を受けても生存通知を兼ねる
    this.lastSeen.set(msg.from, now);
    this.lastRecvAt = now;
    if (msg.t === 'state' || msg.t === 'action' || msg.t === 'hb') {
      this.heardStateful = true;
      this.joining.delete(msg.from);
    }
    this.stallFired = false;
    switch (msg.t) {
      case 'state':
        // ホストとして状態を配っているので、去った扱いを取り消す
        this.departed.delete(msg.from);
        this.onState(msg);
        break;
      case 'action':
        this.onAction(msg.from, msg.seq, msg.action);
        break;
      case 'join':
        this.joining.add(msg.from);
        this.onJoin(msg.from, msg.name);
        break;
      case 'sync':
        this.onSync(msg.from);
        break;
      case 'hb':
        break;
      case 'bye':
        this.lastSeen.delete(msg.from);
        this.departed.add(msg.from);
        this.joining.delete(msg.from);
        break;
    }
    this.refreshOnline();
    this.emit();
  }

  private onState(msg: Extract<WireMessage, { t: 'state' }>) {
    const cur = this.state;
    const { me } = this.d;
    // 登録にないゲームを指す状態は採用しない（SEC-04）。比較より前に見て、ホストの反論の対象にもしない
    if (!hasKnownGames(msg.state, this.d.games)) return;
    if (cur && compareStates(msg.state, cur) <= 0) {
      // 古いホストからの状態には、自分の方が新しいホストなら反論する（E-07）
      if (this.isHostNow() && compareStates(cur, msg.state) > 0) this.requestBroadcast();
      return;
    }
    if (cur && isImplausibleJump(msg.state, cur)) {
      // 世代・版が大きく飛んだ偽の状態は捨て、自分がホストなら正しい状態を配り直す（SEC-01）
      if (this.isHostNow()) this.requestBroadcast();
      return;
    }
    if (msg.state.hostId === msg.from) {
      if (cur?.hostId !== msg.from) this.offsetSamples = [];
      this.offsetSamples = [...this.offsetSamples, msg.sentAt - this.local()].slice(-10);
      this.offset = Math.max(...this.offsetSamples);
    }
    const prevHost = cur?.hostId;
    // 外されたと判断できるのは、同じホスト・同じ世代のまま自分が消えたときだけ（kick はホストが今の世代で行う）。
    // ホストが変わって自分がいないのは、旧ホストだけが自分の参加を受け付けていた取りこぼしなので、入り直す（QA-BUG-04）
    const sameReign = !!cur && cur.epoch === msg.state.epoch && cur.hostId === msg.state.hostId;
    const wasMember = this.wasMember && sameReign;
    const wasHost = this.isHostNow();
    this.setState(msg.state);
    // 自分がホストでなくなったら、ゲームのタイマーと配信予定を止める（AC-27）
    if (wasHost && msg.state.hostId !== me) this.stopHostTimers();
    const mine = msg.state.players.some((p) => p.id === me);
    if (mine) {
      // リロード後に seq が 1 から始まっても、処理済みの seq を追い越せるようにする
      this.nextSeq = Math.max(this.nextSeq, ackOf(msg.state, me) + 1);
      if (msg.state.hostId === me && !wasHost) this.becomeHost(msg.state);
      else if (prevHost !== msg.state.hostId) this.resendPending(true);
    } else if (wasMember) {
      this.terminal = 'kicked';
      this.stopHostTimers();
    } else if (msg.state.players.length >= MAX_ROOM_PLAYERS) {
      this.terminal = 'full';
    } else {
      this.sendJoin(false);
    }
    this.reschedule();
  }

  private onAction(from: string, seq: number, action: RoomAction) {
    if (!this.isHostNow() || !this.state || !this.rateOk(from)) return;
    const next = acceptAction(this.state, from, seq, action, this.now(), this.d.games);
    if (next) this.commitAsHost(next);
  }

  private onJoin(from: string, name: string) {
    if (!this.isHostNow() || !this.state || !this.rateOk(from)) return;
    const next = reduceRoom(this.state, { type: 'join', name }, from, this.now(), this.d.games);
    if (next !== this.state) this.commitAsHost(next);
  }

  private onSync(from: string) {
    const cur = this.state;
    if (!cur) return;
    if (!this.isHostNow()) {
      // ホストは sync を送らないので、ホストからの sync はリロードで状態を失った新しい engine。交代を始める（ADR-8）
      if (cur.hostId === from) this.departed.add(from);
      // 状態待ちの端末に「状態を持つ参加者がいる」ことを知らせ、生きている部屋で復元させない（QA-BUG-02 の修正の裏側）。
      // 直前に何か送っていれば、それで足りるので省く
      else if (this.local() - this.lastSentAt >= this.t.SYNC_REPLY_MIN_MS && !this.terminal) {
        this.sendWire({ v: PROTOCOL_VERSION, t: 'hb', from: this.d.me });
      }
      return;
    }
    const now = this.local();
    const last = this.syncReplyAt.get(from) ?? Number.NEGATIVE_INFINITY;
    if (now - last < this.t.SYNC_REPLY_MIN_MS) return;
    this.syncReplyAt.set(from, now);
    this.requestBroadcast();
  }

  private rateOk(from: string): boolean {
    const r = allowRate(this.rate.get(from) ?? [], this.local(), this.t.ACTION_RATE.count, this.t.ACTION_RATE.windowMs);
    this.rate.set(from, r.history);
    return r.ok;
  }

  // ---------- 定期処理 ----------

  private tick() {
    if (this.disposed) return;
    const now = this.local();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    this.cancelTick = this.d.clock.setTimeout(() => this.tick(), this.t.TICK_MS);
    if (this.terminal === 'left' || this.terminal === 'kicked') return;
    if (gap > this.t.RESUME_GAP_MS) this.resume();
    this.pruneTables(now);
    this.refreshOnline();
    const connected = this.d.transport.status === 'connected';
    const cur = this.state;
    if (this.terminal === 'full') {
      // 満員：何も送らない
    } else if (!cur) {
      this.tickWaiting(now, connected);
    } else if (this.isHostNow()) {
      if (now - this.lastStateSentAt >= this.t.HOST_RESYNC_MS) this.requestBroadcast();
      this.checkStall(now, connected);
    } else {
      if (connected && now - this.lastSentAt >= this.t.HEARTBEAT_MS) this.sendWire({ v: PROTOCOL_VERSION, t: 'hb', from: this.d.me });
      if (!cur.players.some((p) => p.id === this.d.me)) this.sendJoin(false);
      this.resendPending(false);
      this.checkTakeover(now, connected);
      this.checkStall(now, connected);
    }
    this.emit();
  }

  private tickWaiting(now: number, connected: boolean) {
    if (!connected) return;
    if (this.joinWaitFrom === null) this.joinWaitFrom = now;
    if (now - this.lastSyncAt >= this.t.SYNC_RETRY_MS) {
      this.sendSync();
      this.sendJoin(true);
    }
    // 状態を持つ端末の声が聞こえないときだけ、保存しておいた状態から自分がホストとして復元する（AC-30）。
    // 生きている部屋に古いスナップショットの世代を被せて巻き戻さないため。
    // 状態待ちの端末（同時にリロードした人）の sync・join は数えない。そういう端末どうしが同時に復元しても、
    // 同じ世代の競合として compareStates（hostId の小さい方）で 1 人に収束する（QA-BUG-02）
    if (!this.heardStateful && now - this.connectedAt >= this.t.RESTORE_AFTER_MS) {
      const snap = this.loadSnapshot();
      if (snap && snap.players.some((p) => p.id === this.d.me)) {
        this.commit(takeOverHost(snap, this.d.me, this.now()), true);
        return;
      }
    }
    // 状態を持つ端末の声が聞こえていれば部屋はある。ホストが bye なしで消えた直後なら、引き継ぎ（喪失判定 OFFLINE_AFTER_MS）を
    // 待ってから状態が届くので、その分だけ「見つかりません」を遅らせる（P2-10：交代の直前に一瞬 notfound が出ないように）
    const timeout = this.t.JOIN_TIMEOUT_MS + (this.heardStateful ? this.t.OFFLINE_AFTER_MS : 0);
    if (now - this.joinWaitFrom >= timeout) this.notFound = true;
  }

  // ホスト交代（設計 §5.3）
  private checkTakeover(now: number, connected: boolean) {
    const cur = this.state;
    const { me } = this.d;
    if (!cur || !connected || !cur.players.some((p) => p.id === me)) return;
    const host = cur.hostId;
    // ホストが明示的に去った（bye・ホストからの sync）ことは、受け取った時点で確かな事実
    const hostGone = this.departed.has(host);
    // 接続直後・復帰直後は lastSeen が当てにならないので、「しばらく聞こえない」での判定はしない。
    // ただし明示的な離脱は古い lastSeen の誤判定ではないので猶予を飛ばす（QA-BUG-01：猶予が bye にも効き、交代に約 8 秒かかっていた）
    if (!hostGone && now - Math.max(this.connectedAt, this.resumedAt) < this.t.OFFLINE_AFTER_MS) return;
    const seen = this.lastSeen.get(host);
    const lost = hostGone || seen === undefined || now - seen >= this.t.OFFLINE_AFTER_MS;
    // 引き継げない端末（join を送っている＝状態待ちなど）は、オンラインでも候補から外す（P2-10）
    const candidates = new Set([...this.online].filter((id) => !this.joining.has(id)));
    if (!lost || pickNextHost(cur, candidates, host) !== me) return;
    const othersOnline = cur.players.some((p) => p.id !== me && p.id !== host && this.online.has(p.id));
    const lone = this.lastRecvAt === null || now - this.lastRecvAt >= this.t.LONE_TAKEOVER_MS;
    // 自分しかいないときは長めに待つ（孤立した端末が新しい世代を作って部屋を巻き戻さないように。ADR-7）
    if (othersOnline || hostGone || lone) this.takeOver();
  }

  // ソケットが生きているように見えて何も届かない状態に備える（§3.2）
  private checkStall(now: number, connected: boolean) {
    if (!connected || this.stallFired || this.lastRecvAt === null || this.lastSeen.size === 0) return;
    if (now - this.lastRecvAt < this.t.STALL_MS) return;
    if (now - Math.max(this.connectedAt, this.resumedAt) < this.t.STALL_MS) return;
    // 次に何か受信するまで繰り返さない（全員が本当にいなくなった部屋で帯が出続けないように）
    this.stallFired = true;
    this.d.transport.reconnect();
  }

  private takeOver() {
    const cur = this.state;
    if (!cur) return;
    const next = this.applyOutbox(takeOverHost(cur, this.d.me, this.now()));
    this.commit(next, true);
  }

  // 旧ホストの退出で譲られたとき：送り先がいなくなった自分の操作を自分で適用し、配信して知らせる
  private becomeHost(s: RoomState) {
    const applied = this.applyOutbox(s);
    this.commit(applied === s ? s : { ...applied, version: applied.version + 1 }, true);
  }

  // 未確認の自分の操作を、自分がホストの状態に順に適用する（引き継ぎで操作を失わないように）
  private applyOutbox(s: RoomState): RoomState {
    this.pruneOutbox();
    let next = s;
    for (const e of this.outbox) {
      if (e.seq <= ackOf(next, this.d.me)) continue;
      next = acceptAction(next, this.d.me, e.seq, e.action, this.now(), this.d.games) ?? next;
    }
    return next;
  }

  private pruneOutbox() {
    const now = this.local();
    // 古い操作を後から適用しない（AC-14）
    this.outbox = this.outbox.filter((e) => now - e.firstSentAt < this.t.PENDING_TTL_MS);
  }

  // 採用中の状態の acks より大きい seq を、昇順に、同じ seq で再送する
  private resendPending(force: boolean) {
    const cur = this.state;
    if (!cur || this.isHostNow() || this.terminal) return;
    this.pruneOutbox();
    const ack = ackOf(cur, this.d.me);
    const now = this.local();
    for (const e of this.outbox) {
      if (e.seq <= ack) continue;
      if (!force && now - e.lastSentAt < this.t.RESEND_MS) continue;
      if (this.sendWire(this.actionMsg(e.seq, e.action))) e.lastSentAt = now;
    }
  }

  // ---------- ホストの状態更新と配信 ----------

  private applyAsHost(action: RoomAction, by: string) {
    const cur = this.state;
    if (!cur || !this.isHostNow()) return;
    const next = reduceRoom(cur, action, by, this.now(), this.d.games);
    if (next !== cur) this.commitAsHost(next);
  }

  private commitAsHost(next: RoomState) {
    this.commit({ ...next, version: next.version + 1 }, true);
  }

  private commit(s: RoomState, broadcast: boolean) {
    this.setState(s);
    if (broadcast) this.requestBroadcast();
    this.reschedule();
    this.emit();
  }

  private setState(s: RoomState) {
    this.state = s;
    if (s.players.some((p) => p.id === this.d.me)) this.wasMember = true;
    this.scheduleSave();
  }

  // 状態配信の間引き（設計 §2.4）。先頭は即送信、間引いた分は期限に「その時点の最新状態」を送るので最後の変更は必ず届く
  private requestBroadcast() {
    if (!this.isHostNow()) return;
    const now = this.local();
    const elapsed = now - this.lastStateSentAt;
    if (elapsed >= this.t.STATE_THROTTLE_MS) {
      this.cancelBroadcast?.();
      this.cancelBroadcast = null;
      this.sendStateNow();
    } else if (!this.cancelBroadcast) {
      this.cancelBroadcast = this.d.clock.setTimeout(() => {
        this.cancelBroadcast = null;
        this.sendStateNow();
      }, this.lastStateSentAt + this.t.STATE_THROTTLE_MS - now);
    }
  }

  private sendStateNow() {
    const cur = this.state;
    if (!cur || !this.isHostNow()) return;
    if (this.sendWire({ v: PROTOCOL_VERSION, t: 'state', from: this.d.me, state: cur, sentAt: this.now() })) {
      this.lastStateSentAt = this.local();
    }
  }

  // ゲームのタイマー（ホストのみ）。予定時刻を過ぎていれば delay 0 で即実行（AC-28）
  private reschedule() {
    this.cancelGame?.();
    this.cancelGame = null;
    const cur = this.state;
    if (!cur || !cur.game || !this.isHostNow()) return;
    const def = this.d.games[cur.game.id];
    if (!def?.schedule) return;
    let scheduled: ReturnType<NonNullable<typeof def.schedule>>;
    try {
      scheduled = def.schedule(cur.game.state);
    } catch {
      // ゲーム側の不具合ではタイマーを張らない（ルームは止めない）
      return;
    }
    if (!scheduled) return;
    const action: unknown = scheduled.action;
    this.cancelGame = this.d.clock.setTimeout(
      () => {
        this.cancelGame = null;
        this.applyAsHost({ type: 'gameSystem', action }, this.d.me);
      },
      Math.max(0, scheduled.at - this.now()),
    );
  }

  private stopHostTimers() {
    this.cancelGame?.();
    this.cancelBroadcast?.();
    this.cancelGame = this.cancelBroadcast = null;
  }

  // ---------- 送信 ----------

  private sendWire(msg: WireMessage): boolean {
    if (this.disposed) return false;
    const ok = this.d.transport.send(msg);
    if (ok) this.lastSentAt = this.local();
    return ok;
  }

  private actionMsg(seq: number, action: RoomAction): WireMessage {
    return { v: PROTOCOL_VERSION, t: 'action', from: this.d.me, seq, action };
  }

  private sendSync() {
    this.lastSyncAt = this.local();
    this.sendWire({ v: PROTOCOL_VERSION, t: 'sync', from: this.d.me });
  }

  private sendJoin(force: boolean) {
    if (this.terminal) return;
    const now = this.local();
    if (!force && now - this.lastJoinAt < this.t.JOIN_MIN_MS) return;
    this.lastJoinAt = now;
    this.sendWire({ v: PROTOCOL_VERSION, t: 'join', from: this.d.me, name: this.d.name });
  }

  // ---------- スナップショット（リロード時の復元用） ----------

  private scheduleSave() {
    const now = this.local();
    if (now - this.lastSaveAt >= this.t.SAVE_MIN_MS) this.saveNow();
    else if (!this.cancelSave) {
      this.cancelSave = this.d.clock.setTimeout(() => this.saveNow(), this.lastSaveAt + this.t.SAVE_MIN_MS - now);
    }
  }

  private saveNow() {
    this.cancelSave?.();
    this.cancelSave = null;
    this.lastSaveAt = this.local();
    if (this.state && this.terminal !== 'left') this.safeSet(() => JSON.stringify(this.state));
  }

  // 文字列化も try の中で行う（想定外の形の状態で JSON.stringify が投げても、受信処理やタイマーの外へ漏らさない。SEC-05）
  private safeSet(value: string | (() => string)) {
    try {
      this.d.storage.set(snapshotKey(this.d.code), typeof value === 'function' ? value() : value);
    } catch {
      // 保存できなくても続行
    }
  }

  private loadSnapshot(): RoomState | null {
    try {
      const raw = this.d.storage.get(snapshotKey(this.d.code));
      const snap = raw ? parseRoomState(JSON.parse(raw), this.d.code) : null;
      // 古い版で保存した、今の登録にないゲームの状態は復元しない（SEC-04）
      return snap && hasKnownGames(snap, this.d.games) ? snap : null;
    } catch {
      return null;
    }
  }

  // ---------- 状態の公開 ----------

  private local(): number {
    return this.d.clock.now();
  }

  private isHostNow(): boolean {
    return !!this.state && this.state.hostId === this.d.me && this.terminal !== 'left' && this.terminal !== 'kicked';
  }

  // 送信元ごとの表から、もう要らない行を消す（SEC-06）。
  // 毎回違う from の hb / sync / bye を送り続けられても、表と受信のたびの refreshOnline の走査が際限なく増えないように。
  // メンバーと現在のホストの lastSeen は古くても残す（checkStall の「全員が去った」判定・P1-5 を変えないため）
  private pruneTables(now: number) {
    const cur = this.state;
    const keep = (id: string) => !!cur && (id === cur.hostId || cur.players.some((p) => p.id === id));
    this.lastSeen.forEach((seen, id) => {
      if (!keep(id) && now - seen >= this.t.OFFLINE_AFTER_MS) this.lastSeen.delete(id);
    });
    if (cur) this.departed.forEach((id) => {
      if (!keep(id)) this.departed.delete(id);
    });
    // 引き継ぎの候補選びにしか使わないので、メンバー以外（状態がなければ全員）は消してよい。次の join でまた入る
    this.joining.forEach((id) => {
      if (!keep(id)) this.joining.delete(id);
    });
    this.rate.forEach((history, id) => {
      if (history.every((t) => t <= now - this.t.ACTION_RATE.windowMs)) this.rate.delete(id);
    });
    this.syncReplyAt.forEach((at, id) => {
      if (now - at >= this.t.SYNC_REPLY_MIN_MS) this.syncReplyAt.delete(id);
    });
  }

  private refreshOnline() {
    const now = this.local();
    const ids = new Set<string>([this.d.me]);
    this.lastSeen.forEach((seen, id) => {
      if (now - seen < this.t.OFFLINE_AFTER_MS) ids.add(id);
    });
    const prev = this.online;
    if (ids.size !== prev.size || [...ids].some((id) => !prev.has(id))) this.online = ids;
  }

  private computeStatus(): RoomStatus {
    if (this.terminal) return this.terminal;
    if (this.state) return 'ready';
    if (this.connection === 'failed') return 'failed';
    if (this.notFound) return 'notfound';
    return 'connecting';
  }

  private emit() {
    if (this.disposed) return;
    const s = this.snapshot;
    const status = this.computeStatus();
    const isHost = this.isHostNow();
    if (s.status === status && s.connection === this.connection && s.state === this.state && s.isHost === isHost && s.online === this.online) {
      return;
    }
    this.snapshot = { status, connection: this.connection, state: this.state, isHost, online: this.online };
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        // 購読側の失敗で同期処理を止めない
      }
    });
  }
}
