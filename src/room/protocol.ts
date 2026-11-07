// 通信メッセージの形と検証（設計 docs/dev/02-architecture.md §2）。
// 他端末から届くものは信用せず、ここで形を確かめてから使う。不正なものは null を返して黙って捨てる（例外は投げない）。
// 返す値は受信データをそのまま使わず、既知のフィールドだけで新しく組み立てる（余計なキーやプロトタイプを持ち込まないため）。
import type { ChatMessage, RoomAction, RoomPlayer, RoomState } from './logic';

export const PROTOCOL_VERSION = 2; // 旧クライアント（v なし）のメッセージは捨てる
export const MAX_ID_LEN = 40;
export const MAX_STATE_BYTES = 64 * 1024; // AC-22 の上限（UTF-8 バイト）

// 受信時の上限。超えたものは捨てる（ホスト側の切り詰めとは別の、明らかに異常なデータの足切り）
const MAX_PLAYERS = 10;
const MAX_CHAT = 100;
const MAX_ACKS = 20;
const MAX_ONLINE = 20;
const MAX_CHAT_TEXT = 1000;
const MAX_NAME = 1000;
const MAX_KEYS = 50;

export type WireMessage =
  | { v: 2; t: 'state'; from: string; state: RoomState; sentAt: number }
  | { v: 2; t: 'action'; from: string; seq: number; action: RoomAction }
  | { v: 2; t: 'join'; from: string; name: string }
  | { v: 2; t: 'sync'; from: string }
  | { v: 2; t: 'hb'; from: string }
  | { v: 2; t: 'bye'; from: string };

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown, max = Infinity): x is string => typeof x === 'string' && x.length <= max;
// プレイヤー ID（from・players[].id・hostId・kick.target・startGame.online）。正規の ID は 'p_' + 英数字。
// 各ゲームは ID をオブジェクトのキーに使うので、Object.prototype にある名前（__proto__ / constructor / toString など）は
// 拒否する（票の集計が消える・「提出済み」扱いになるなどを防ぐ。SEC-03）。文字種も英数字・_・- に絞る
const ID_RE = /^[A-Za-z0-9_-]+$/;
const isId = (x: unknown): x is string =>
  typeof x === 'string' && x.length >= 1 && x.length <= MAX_ID_LEN && ID_RE.test(x) && !(x in Object.prototype);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isPosInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const isNonNegInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

// 値がすべて条件を満たすオブジェクトだけを、自分のプロパティとして作り直す。
// Object.fromEntries は "__proto__" も普通のキーとして定義するので、プロトタイプを書き換えられない
const recordOf = <T>(x: unknown, maxKeys: number, each: (v: unknown) => T | null): Record<string, T> | null => {
  if (!isObj(x)) return null;
  const entries = Object.entries(x);
  if (entries.length > maxKeys) return null;
  const out: [string, T][] = [];
  for (const [k, v] of entries) {
    const parsed = each(v);
    if (parsed === null) return null;
    out.push([k, parsed]);
  }
  return Object.fromEntries(out);
};

const parsePlayer = (x: unknown): RoomPlayer | null =>
  isObj(x) && isId(x.id) && isStr(x.name, MAX_NAME) ? { id: x.id, name: x.name } : null;

const parsePlayers = (x: unknown, max: number): RoomPlayer[] | null => {
  if (!Array.isArray(x) || x.length > max) return null;
  const out: RoomPlayer[] = [];
  for (const p of x) {
    const parsed = parsePlayer(p);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
};

const parseChat = (x: unknown): ChatMessage | null => {
  if (!isObj(x) || !isStr(x.id, 200) || !isStr(x.name, MAX_NAME) || !isStr(x.text, MAX_CHAT_TEXT) || !isNum(x.at)) return null;
  if (x.by !== null && !isId(x.by)) return null;
  return { id: x.id, by: x.by, name: x.name, text: x.text, at: x.at };
};

// game.state の入れ子の上限（SEC-05）。正規のゲームの状態は数段なので十分に大きい。
// 深すぎる入れ子は JSON.stringify（保存・配信）や View の描画で RangeError を投げるので、受信の時点で捨てる
export const MAX_GAME_STATE_DEPTH = 64;

// 再帰を使わずに深さを数える（深い入れ子そのものでスタックを溢れさせないため）。上限を超えた時点で打ち切る
const withinDepth = (root: unknown, max: number): boolean => {
  const stack: [unknown, number][] = [[root, 1]];
  while (stack.length > 0) {
    const [x, depth] = stack.pop()!;
    if (typeof x !== 'object' || x === null) continue;
    if (depth > max) return false;
    for (const v of Object.values(x)) {
      if (typeof v === 'object' && v !== null) stack.push([v, depth + 1]);
    }
  }
  return true;
};

export function parseRoomState(raw: unknown, roomCode: string): RoomState | null {
  if (!isObj(raw)) return null;
  if (raw.code !== roomCode) return null;
  if (!isPosInt(raw.epoch) || !isPosInt(raw.version) || !isId(raw.hostId) || !isStr(raw.selectedGame, 100)) return null;
  const players = parsePlayers(raw.players, MAX_PLAYERS);
  if (!players) return null;
  const gameOptions = recordOf(raw.gameOptions, MAX_KEYS, (v) => recordOf(v, MAX_KEYS, (n) => (isNum(n) ? n : null)));
  if (!gameOptions) return null;
  if (!Array.isArray(raw.chat) || raw.chat.length > MAX_CHAT) return null;
  const chat: ChatMessage[] = [];
  for (const m of raw.chat) {
    const parsed = parseChat(m);
    if (!parsed) return null;
    chat.push(parsed);
  }
  let game: RoomState['game'] = null;
  if (raw.game !== null) {
    const g = raw.game;
    if (!isObj(g) || !isStr(g.id, 100) || !isNum(g.startedAt)) return null;
    const gamePlayers = parsePlayers(g.players, MAX_PLAYERS);
    if (!gamePlayers) return null;
    // ゲームの中身はゲームごとに形が違うので検証しない（ホストが作ったものを信頼する。設計 §2.2）。
    // ただし入れ子の深さだけは見る（SEC-05）
    if (!withinDepth(g.state, MAX_GAME_STATE_DEPTH)) return null;
    game = { id: g.id, players: gamePlayers, state: g.state, startedAt: g.startedAt };
  }
  // 旧形式（acks なし）なら空で補う
  const acks = raw.acks === undefined ? {} : recordOf(raw.acks, MAX_ACKS, (v) => (isNonNegInt(v) ? v : null));
  if (!acks) return null;
  return {
    code: raw.code,
    epoch: raw.epoch,
    version: raw.version,
    hostId: raw.hostId,
    players,
    selectedGame: raw.selectedGame,
    gameOptions,
    game,
    chat,
    acks,
  };
}

// ネットワークから受け付けるアクション。gameSystem はホスト自身のタイマー専用なので受け付けない
export function parseRoomAction(raw: unknown): RoomAction | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'join':
      return isStr(raw.name, MAX_NAME) ? { type: 'join', name: raw.name } : null;
    case 'leave':
      return { type: 'leave' };
    case 'kick':
      return isId(raw.target) ? { type: 'kick', target: raw.target } : null;
    case 'chat':
      return isStr(raw.text, MAX_CHAT_TEXT) ? { type: 'chat', text: raw.text } : null;
    case 'selectGame':
      return isStr(raw.gameId, 100) ? { type: 'selectGame', gameId: raw.gameId } : null;
    case 'setOption':
      return isStr(raw.key, 100) && isNum(raw.value) ? { type: 'setOption', key: raw.key, value: raw.value } : null;
    case 'startGame': {
      const online = raw.online;
      if (!Array.isArray(online) || online.length > MAX_ONLINE || !online.every(isId)) return null;
      return { type: 'startGame', online: [...online] };
    }
    case 'endGame':
      return { type: 'endGame' };
    case 'game':
      // 中身の検証はゲームの reduce が行う（ここでは存在だけ確かめる）
      return 'action' in raw && raw.action !== undefined ? { type: 'game', action: raw.action } : null;
    default:
      return null;
  }
}

export function parseWireMessage(raw: unknown, roomCode: string): WireMessage | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION || !isId(raw.from)) return null;
  const from = raw.from;
  switch (raw.t) {
    case 'state': {
      if (!isNum(raw.sentAt)) return null;
      const state = parseRoomState(raw.state, roomCode);
      return state ? { v: 2, t: 'state', from, state, sentAt: raw.sentAt } : null;
    }
    case 'action': {
      if (!isPosInt(raw.seq)) return null;
      const action = parseRoomAction(raw.action);
      return action ? { v: 2, t: 'action', from, seq: raw.seq, action } : null;
    }
    case 'join':
      return isStr(raw.name, MAX_NAME) ? { v: 2, t: 'join', from, name: raw.name } : null;
    case 'sync':
    case 'hb':
    case 'bye':
      return { v: 2, t: raw.t, from };
    default:
      return null;
  }
}

// 直近 windowMs に limit 件まで。純粋関数（呼び出し側が返された履歴を持ち回る）。
// 超過したときは履歴に足さない（捨てた分で枠を食わないように）
export function allowRate(
  history: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): { ok: boolean; history: number[] } {
  const recent = history.filter((t) => t > now - windowMs);
  if (recent.length >= limit) return { ok: false, history: recent };
  return { ok: true, history: [...recent, now] };
}
