import { RealtimeClient, type RealtimeChannel } from '@supabase/supabase-js';
import { realClock, type Clock } from './clock';

// 通信層（設計 docs/dev/02-architecture.md §1.3・§3.1）。
// 「1 回分の接続（Link）」と「接続状態の管理（ManagedTransport）」に分ける。
// Supabase 固有のコードは supabaseLinkFactory だけに閉じ、再試行・再接続の状態機械は疑似ネットワークで同じコードのままテストする。

// 通信層の接続状態。Client 契約（src/room/types.ts）から参照する
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

// 1 回分の接続。Supabase なら 1 つの RealtimeChannel、テストなら疑似ネットワークの SimLink
export type LinkEvents = {
  onOpen(): void; // 送受信可能になった（初回・ライブラリによる自動再参加の両方）
  onDown(reason: string): void; // CHANNEL_ERROR / TIMED_OUT / CLOSED
  onMessage(msg: unknown): void;
};
export interface Link {
  send(msg: unknown): void;
  close(): void;
}
export type LinkFactory = (roomCode: string, ev: LinkEvents) => Link;

// アプリが使う通信層。自分が送ったメッセージは自分には届かない
export interface Transport {
  readonly status: ConnectionStatus;
  send(msg: unknown): boolean; // connected 以外では送らず false
  onMessage(cb: (msg: unknown) => void): () => void; // 戻り値で購読解除
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  reconnect(): void; // 今すぐ張り直す（failed からの再試行もこれ）
  setNetworkOnline(online: boolean): void; // navigator の online/offline を伝える
  close(): void;
}

// 1 回の接続試行の待ち。Supabase 既定の 10 秒だと failed まで 47 秒かかるので短くする
export const CONNECT_TIMEOUT_MS = 5000;
// 初回接続の自動リトライの間隔（3 回。最悪 約 27 秒で failed）
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
// reconnecting が続いたら Link を作り直す間隔
export const REBUILD_AFTER_MS = 8000;

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isOnlineMode = Boolean(supabaseUrl && supabaseKey);

// Supabase Realtime の Broadcast（DB テーブル不要）。
// Link ごとに RealtimeClient（＝ WebSocket）を 1 つ作る。共有のクライアントだと、
// 同じ topic のチャンネルは removeChannel が非同期で終わるまで channel() が古いものを返し、作り直しにならないため。
// 作り直しはソケットが死んでいる疑いがあるときなので、ソケットごと新しくする方が確実でもある
export const supabaseLinkFactory: LinkFactory = (roomCode, ev) => {
  const url = new URL('realtime/v1', supabaseUrl!.endsWith('/') ? supabaseUrl! : `${supabaseUrl!}/`);
  url.protocol = url.protocol.replace('http', 'ws');
  const client = new RealtimeClient(url.href, {
    params: { apikey: supabaseKey!, eventsPerSecond: 20 },
    accessToken: async () => supabaseKey!,
  });
  const channel: RealtimeChannel = client.channel(`sukima:${roomCode}`, {
    config: { broadcast: { self: false, ack: false } },
  });
  let closed = false;
  channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
    if (!closed) ev.onMessage(payload);
  });
  // realtime-js はソケット再接続時にチャンネルへ自動で再参加し、同じコールバックに SUBSCRIBED を再度通知する
  channel.subscribe((status) => {
    if (closed) return;
    if (status === 'SUBSCRIBED') ev.onOpen();
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') ev.onDown(status);
  });
  return {
    send: (msg) => {
      void channel.send({ type: 'broadcast', event: 'msg', payload: msg });
    },
    close: () => {
      if (closed) return;
      closed = true;
      void client.removeChannel(channel).finally(() => void client.disconnect());
    },
  };
};

// Supabase 未設定時のデモ用：同じブラウザのタブ間で BroadcastChannel を使う。生成直後に onOpen
export const localLinkFactory: LinkFactory = (roomCode, ev) => {
  const bc = new BroadcastChannel(`sukima:${roomCode}`);
  let closed = false;
  bc.onmessage = (e: MessageEvent) => {
    if (!closed) ev.onMessage(e.data);
  };
  // 呼び出し側の初期化が終わってから通知する
  queueMicrotask(() => {
    if (!closed) ev.onOpen();
  });
  return {
    send: (msg) => bc.postMessage(msg),
    close: () => {
      closed = true;
      bc.close();
    },
  };
};

// 接続状態の状態機械（設計 §3.1）
//   connecting --onOpen--> connected --onDown/offline--> reconnecting --onOpen--> connected
//   connecting --onDown/5 秒無応答--> 1s/2s/4s 待って新しい Link（3 回まで）--4 回目も失敗--> failed
//   reconnecting は 8 秒ごとに Link を作り直す。failed は reconnect() で connecting に戻る（リトライ回数リセット）
//   一度 connected になった後は failed にしない（自動復旧を待ち続ける）
class ManagedTransport implements Transport {
  status: ConnectionStatus = 'connecting';
  private link: Link | null = null;
  // Link の世代。古い Link から遅れて届く通知を無視するため
  private gen = 0;
  private attempt = 0;
  private everConnected = false;
  private closed = false;
  private cancelTimer: (() => void) | null = null;
  private readonly msgListeners = new Set<(msg: unknown) => void>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();

  constructor(
    private readonly factory: LinkFactory,
    private readonly roomCode: string,
    private readonly clock: Clock,
  ) {
    this.openLink();
  }

  send(msg: unknown): boolean {
    // connected 以外では送らない（REST の自動フォールバックを使わない。確実性は seq 再送と同期要求で担保する。ADR-6）
    if (this.closed || this.status !== 'connected' || !this.link) return false;
    try {
      this.link.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  onMessage(cb: (msg: unknown) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  reconnect(): void {
    if (this.closed) return;
    this.attempt = 0;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    this.openLink();
  }

  setNetworkOnline(online: boolean): void {
    if (this.closed) return;
    if (!online) {
      if (this.status === 'connected') {
        this.setStatus('reconnecting');
        this.armTimer(() => this.openLink(), REBUILD_AFTER_MS);
      }
      return;
    }
    if (this.status === 'reconnecting' || this.status === 'failed') this.reconnect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.gen++;
    this.closeLink();
    this.msgListeners.clear();
    this.statusListeners.clear();
  }

  private openLink() {
    if (this.closed) return;
    this.clearTimer();
    this.closeLink();
    const gen = ++this.gen;
    // 待ちのタイマーは Link を作る前に張る（Link が同期的に onOpen しても正しく解除されるように）
    if (this.everConnected) this.armTimer(() => this.openLink(), REBUILD_AFTER_MS);
    else this.armTimer(() => this.handleDown(gen, 'timeout'), CONNECT_TIMEOUT_MS);
    const link = this.factory(this.roomCode, {
      onOpen: () => this.handleOpen(gen),
      onDown: (reason) => this.handleDown(gen, reason),
      onMessage: (msg) => {
        if (gen !== this.gen || this.closed) return;
        this.msgListeners.forEach((cb) => cb(msg));
      },
    });
    if (gen === this.gen) this.link = link;
    else link.close();
  }

  private handleOpen(gen: number) {
    if (gen !== this.gen || this.closed) return;
    this.clearTimer();
    this.attempt = 0;
    this.everConnected = true;
    this.setStatus('connected');
  }

  private handleDown(gen: number, _reason: string) {
    if (gen !== this.gen || this.closed) return;
    if (this.status === 'connected') {
      // ライブラリの自動再参加を待つ。戻らなければ REBUILD_AFTER_MS で作り直す
      this.setStatus('reconnecting');
      this.armTimer(() => this.openLink(), REBUILD_AFTER_MS);
      return;
    }
    if (this.status !== 'connecting') return; // reconnecting 中は作り直しのタイマーに任せる
    this.clearTimer();
    this.gen++;
    this.closeLink();
    if (this.attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[this.attempt++];
      this.armTimer(() => this.openLink(), delay);
    } else {
      this.setStatus('failed');
    }
  }

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  private armTimer(fn: () => void, ms: number) {
    this.clearTimer();
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = null;
      fn();
    }, ms);
  }

  private clearTimer() {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private closeLink() {
    const link = this.link;
    this.link = null;
    try {
      link?.close();
    } catch {
      // 閉じるときの失敗は無視（もう使わない）
    }
  }
}

export function createManagedTransport(factory: LinkFactory, roomCode: string, clock: Clock): Transport {
  return new ManagedTransport(factory, roomCode, clock);
}

export const createTransport = (roomCode: string): Transport =>
  createManagedTransport(isOnlineMode ? supabaseLinkFactory : localLinkFactory, roomCode, realClock);
