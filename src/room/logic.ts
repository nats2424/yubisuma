import { resolveOptions, type GameDef, type GameOptions, type GamePlayer } from '../games/types';

export const MAX_ROOM_PLAYERS = 10;
const CHAT_KEEP = 60;
// Client が入力欄の上限表示に使うので export する
export const CHAT_MAX_LEN = 200;
// チャットの連投制限：1 人あたり windowMs の間に count 件まで（AC-20）
export const CHAT_RATE = { count: 3, windowMs: 3000 } as const;
// ゲーム開始からこの時間内の startGame は無視する（「もう一度」の二重押しで二重に始まらないように。AC-21）
export const START_GUARD_MS = 1500;
// 処理済み seq からこれより大きく飛んだ seq は受け付けない（SEC-02）。
// 他人の ID で巨大な seq を送られ、その人の以後の seq がすべて「処理済み」扱いになるのを防ぐ。
// 正規の参加者は未確認の再送が最大 OUTBOX_MAX（50）件なので、この範囲に収まる
export const SEQ_JUMP_MAX = 1000;

export type RoomPlayer = { id: string; name: string };

export type ChatMessage = {
  id: string;
  by: string | null; // null はシステムメッセージ
  name: string;
  text: string;
  at: number;
};

export type RoomState = {
  code: string;
  // ホストが交代するたびに増える世代番号。古いホストの状態を無視するために使う
  epoch: number;
  version: number;
  hostId: string;
  players: RoomPlayer[];
  selectedGame: string;
  // ゲームごとのホスト設定
  gameOptions: Record<string, GameOptions>;
  game: { id: string; players: GamePlayer[]; state: unknown; startedAt: number } | null;
  chat: ChatMessage[];
  // 参加者ごとの処理済み最大 seq（設計 §2.3）。状態の一部なのでホスト交代でも引き継がれる。
  // ACK 専用のメッセージは作らず、参加者はこの値を見て再送をやめる
  acks: Record<string, number>;
};

export type RoomAction =
  | { type: 'join'; name: string }
  | { type: 'leave' }
  | { type: 'kick'; target: string }
  | { type: 'chat'; text: string }
  | { type: 'selectGame'; gameId: string }
  | { type: 'setOption'; key: string; value: number }
  | { type: 'startGame'; online: string[] }
  | { type: 'endGame' }
  | { type: 'game'; action: unknown }
  | { type: 'gameSystem'; action: unknown };

export type GameRegistry = Record<string, GameDef>;

export const createRoom = (code: string, host: RoomPlayer, defaultGame: string): RoomState => ({
  code,
  epoch: 1,
  version: 1,
  hostId: host.id,
  players: [host],
  selectedGame: defaultGame,
  gameOptions: {},
  game: null,
  chat: [],
  acks: {},
});

// a の方が新しい（採用すべき）状態なら正
export const compareStates = (a: RoomState, b: RoomState): number => {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  // 同じ世代でホストが競合した場合は ID の小さい方を正とする
  if (a.hostId !== b.hostId) return a.hostId < b.hostId ? 1 : -1;
  return a.version - b.version;
};

// 今の状態から世代・版がこれより大きく飛んだ状態は採用しない（SEC-01）。
// 巨大な epoch / version（MAX_SAFE_INTEGER など）の偽の状態 1 通を採用すると、以後の正しい状態がすべて「古い」扱いになるか、
// 次の +1 が安全な整数を超えて全員に捨てられ、攻撃者が去っても部屋が戻らないため。
// 絶対値の上限では「上限ちょうど」を送られると同じことが起きるので、相対で見る。
// 版は世代が変わっても引き継がれる（takeOverHost は version + 1）ので、世代に関係なく比べる。
// 上限は、長く離れていた参加者が追いつけなくなることのないよう十分大きく取る（5 件/秒で 1 日 ≒ 43 万版）
export const EPOCH_JUMP_MAX = 1000;
export const VERSION_JUMP_MAX = 1_000_000;
export const isImplausibleJump = (next: RoomState, cur: RoomState): boolean =>
  next.epoch > cur.epoch + EPOCH_JUMP_MAX || next.version > cur.version + VERSION_JUMP_MAX;

// 状態が参照するゲーム（selectedGame・game.id）がすべてこの端末の登録にあるか（SEC-04）。
// 登録にない ID（constructor・__proto__ などを含む）の状態を採用すると、画面が GAMES[id] を引けず全員が真っ白になる。
// 悪意だけでなくデプロイ直後の版ずれ（新しい版のタブが新ゲームを選ぶ）でも起こるので、採用前に確かめる。
// 継承プロパティを拾わないよう hasOwnProperty で見る
const hasGame = (games: GameRegistry, id: string): boolean => Object.prototype.hasOwnProperty.call(games, id);
export const hasKnownGames = (state: RoomState, games: GameRegistry): boolean =>
  hasGame(games, state.selectedGame) && (state.game === null || hasGame(games, state.game.id));

let msgSeq = 0;
const systemMessage = (text: string, now: number): ChatMessage => ({
  id: `s${now}_${msgSeq++}`,
  by: null,
  name: '',
  text,
  at: now,
});

const withChat = (state: RoomState, msg: ChatMessage): RoomState => ({
  ...state,
  chat: [...state.chat, msg].slice(-CHAT_KEEP),
});

// この時刻までチャットを送れない（送れるなら 0）。
// 追加の状態を持たず state.chat の by / at から数えるので、ホスト交代後も同じ判定になる。
// Client のボタン無効化とホストの受付判定で同じ式を使い、表示と実際の挙動をずらさない。
// 直近 windowMs 内の自分の発言が count 件以上なら、そのうち古い方から数えて
// 「新しい方から count 件目」が窓を抜ける時刻まで待たせる（スライディングウィンドウ）
export const chatBlockedUntil = (state: RoomState, me: string, now: number): number => {
  const recent = state.chat.filter((m) => m.by === me && m.at > now - CHAT_RATE.windowMs).map((m) => m.at);
  if (recent.length < CHAT_RATE.count) return 0;
  recent.sort((a, b) => a - b);
  const until = recent[recent.length - CHAT_RATE.count] + CHAT_RATE.windowMs;
  return until > now ? until : 0;
};

// オンラインのメンバーから次のホスト候補を選ぶ（参加順で最も古い人）
export const pickNextHost = (state: RoomState, online: Set<string>, exclude?: string): string | null =>
  state.players.find((p) => p.id !== exclude && online.has(p.id))?.id ?? null;

export const takeOverHost = (state: RoomState, me: string, now: number): RoomState => {
  const name = state.players.find((p) => p.id === me)?.name ?? '?';
  return withChat(
    { ...state, epoch: state.epoch + 1, version: state.version + 1, hostId: me },
    systemMessage(`${name}さんがホストになりました`, now),
  );
};

// ホスト端末で実行されるルームの状態遷移。変化がなければ同じオブジェクトを返す
export const reduceRoom = (
  state: RoomState,
  action: RoomAction,
  by: string,
  now: number,
  games: GameRegistry,
): RoomState => {
  const isHost = by === state.hostId;
  const player = state.players.find((p) => p.id === by);

  switch (action.type) {
    case 'join': {
      const name = action.name.trim().slice(0, 10) || 'ゲスト';
      if (player) {
        if (player.name === name) return state;
        return { ...state, players: state.players.map((p) => (p.id === by ? { ...p, name } : p)) };
      }
      if (state.players.length >= MAX_ROOM_PLAYERS) return state;
      return withChat(
        { ...state, players: [...state.players, { id: by, name }] },
        systemMessage(`${name}さんが入室しました`, now),
      );
    }
    case 'leave':
    case 'kick': {
      const target = action.type === 'leave' ? by : action.target;
      if (action.type === 'kick' && (!isHost || target === by)) return state;
      const leaving = state.players.find((p) => p.id === target);
      if (!leaving) return state;
      const players = state.players.filter((p) => p.id !== target);
      const hostId = target === state.hostId ? (players[0]?.id ?? state.hostId) : state.hostId;
      const verb = action.type === 'leave' ? '退室しました' : '退室させられました';
      // 抜けた人の処理済み seq は捨てる（acks はメンバーの分だけ持つ）
      const acks = Object.fromEntries(Object.entries(state.acks ?? {}).filter(([id]) => id !== target));
      return withChat({ ...state, players, hostId, acks }, systemMessage(`${leaving.name}さんが${verb}`, now));
    }
    case 'chat': {
      const text = action.text.trim().slice(0, CHAT_MAX_LEN);
      if (!player || !text) return state;
      // 連投はホストで捨てる。Client のボタン無効化と同じ式で判定する（AC-20）
      if (chatBlockedUntil(state, by, now) > now) return state;
      return withChat(state, { id: `${by}_${now}_${msgSeq++}`, by, name: player.name, text, at: now });
    }
    case 'selectGame': {
      if (!isHost || !games[action.gameId] || state.game) return state;
      return { ...state, selectedGame: action.gameId };
    }
    case 'setOption': {
      const def = games[state.selectedGame];
      const opt = def?.options?.find((o) => o.key === action.key);
      if (!isHost || state.game || !opt || !opt.choices.some((c) => c.value === action.value)) return state;
      const cur = state.gameOptions?.[def.id] ?? {};
      return { ...state, gameOptions: { ...state.gameOptions, [def.id]: { ...cur, [action.key]: action.value } } };
    }
    case 'startGame': {
      const def = games[state.selectedGame];
      if (!isHost || !def) return state;
      if (state.game && now - state.game.startedAt < START_GUARD_MS) return state;
      const online = new Set(action.online);
      const gamePlayers = state.players.filter((p) => online.has(p.id) || p.id === by);
      if (gamePlayers.length < def.minPlayers || gamePlayers.length > def.maxPlayers) return state;
      let gameState: unknown;
      try {
        gameState = def.init(gamePlayers, now, resolveOptions(def, state.gameOptions?.[def.id]));
      } catch {
        // ゲーム側の不具合でルーム全体を止めない
        return state;
      }
      return withChat(
        { ...state, game: { id: def.id, players: gamePlayers, state: gameState, startedAt: now } },
        systemMessage(`「${def.name}」を開始しました`, now),
      );
    }
    case 'endGame': {
      if (!isHost || !state.game) return state;
      return { ...state, game: null };
    }
    case 'game':
    case 'gameSystem': {
      if (!state.game) return state;
      const def = games[state.game.id];
      if (!def) return state;
      let actor: string;
      if (action.type === 'gameSystem') {
        if (!isHost) return state;
        actor = 'system';
      } else {
        if (!state.game.players.some((p) => p.id === by)) return state;
        actor = by;
      }
      let next: unknown;
      try {
        next = def.reduce(state.game.state, action.action, actor, now);
      } catch {
        // 想定外の形のアクションでゲームの reduce が例外を投げても、状態を変えずに続ける（AC-04）
        return state;
      }
      if (next === state.game.state || next === undefined) return state;
      return { ...state, game: { ...state.game, state: next } };
    }
  }
};

// 自分のものとして持っているキーだけを見る（"__proto__" などの ID でプロトタイプの値を拾わないように）
export const ackOf = (state: RoomState, id: string): number =>
  state.acks && Object.prototype.hasOwnProperty.call(state.acks, id) ? state.acks[id] : 0;

// seq 付きアクションの受付（設計 §2.3）。重複・古い seq・非メンバー・ネットワークから来てはいけない種類なら null（状態を変えない）。
// 受け付けた場合は reduce の結果が変わらなくても acks を進めた新しい状態を返す（参加者が再送をやめられるように）
export const acceptAction = (
  state: RoomState,
  by: string,
  seq: number,
  action: RoomAction,
  now: number,
  games: GameRegistry,
): RoomState | null => {
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  // gameSystem はホスト自身のタイマー専用
  if (action.type === 'gameSystem') return null;
  if (!state.players.some((p) => p.id === by)) return null;
  const ack = ackOf(state, by);
  if (seq <= ack || seq > ack + SEQ_JUMP_MAX) return null;
  const next = reduceRoom(state, action, by, now, games);
  // 退出した人の acks は作らない（leave の重複送信は非メンバーとして捨てられる）
  if (!next.players.some((p) => p.id === by)) return next;
  return { ...next, acks: { ...next.acks, [by]: seq } };
};
