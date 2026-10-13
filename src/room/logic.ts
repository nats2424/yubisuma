import type { GameDef, GamePlayer } from '../games/types';

export const MAX_ROOM_PLAYERS = 10;
const CHAT_KEEP = 60;
const CHAT_MAX_LEN = 200;

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
  game: { id: string; players: GamePlayer[]; state: unknown; startedAt: number } | null;
  chat: ChatMessage[];
};

export type RoomAction =
  | { type: 'join'; name: string }
  | { type: 'leave' }
  | { type: 'kick'; target: string }
  | { type: 'chat'; text: string }
  | { type: 'selectGame'; gameId: string }
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
  game: null,
  chat: [],
});

// a の方が新しい（採用すべき）状態なら正
export const compareStates = (a: RoomState, b: RoomState): number => {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  // 同じ世代でホストが競合した場合は ID の小さい方を正とする
  if (a.hostId !== b.hostId) return a.hostId < b.hostId ? 1 : -1;
  return a.version - b.version;
};

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
      return withChat({ ...state, players, hostId }, systemMessage(`${leaving.name}さんが${verb}`, now));
    }
    case 'chat': {
      const text = action.text.trim().slice(0, CHAT_MAX_LEN);
      if (!player || !text) return state;
      return withChat(state, { id: `${by}_${now}_${msgSeq++}`, by, name: player.name, text, at: now });
    }
    case 'selectGame': {
      if (!isHost || !games[action.gameId] || state.game) return state;
      return { ...state, selectedGame: action.gameId };
    }
    case 'startGame': {
      const def = games[state.selectedGame];
      if (!isHost || !def) return state;
      const online = new Set(action.online);
      const gamePlayers = state.players.filter((p) => online.has(p.id) || p.id === by);
      if (gamePlayers.length < def.minPlayers || gamePlayers.length > def.maxPlayers) return state;
      return withChat(
        { ...state, game: { id: def.id, players: gamePlayers, state: def.init(gamePlayers, now), startedAt: now } },
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
      const next = def.reduce(state.game.state, action.action, actor, now);
      if (next === state.game.state) return state;
      return { ...state, game: { ...state.game, state: next } };
    }
  }
};
