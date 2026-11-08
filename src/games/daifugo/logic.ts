import { shuffle, type GameOptions, type GamePlayer, type Scheduled } from '../types';

// カードは文字列で表す。スート(S/H/D/C) + 強さ(3〜15: J=11, Q=12, K=13, A=14, 2=15)。ジョーカーは 'JK'
export type Card = string;
export const JOKER: Card = 'JK';
const JOKER_RANK = 16;

export const TURN_MS = 45_000;
const EXCHANGE_MS = 40_000;
const ROUND_END_MS = 9_000;

export const rankOf = (c: Card) => (c === JOKER ? JOKER_RANK : Number(c.slice(1)));
export const suitOf = (c: Card) => (c === JOKER ? 'J' : c[0]);

export const newDeck = (): Card[] => {
  const deck: Card[] = [JOKER];
  for (const suit of ['S', 'H', 'D', 'C']) for (let r = 3; r <= 15; r++) deck.push(`${suit}${r}`);
  return deck;
};

// 表示・並び替え用（革命は考慮しない素の強さ）
export const sortHand = (cards: Card[]) =>
  [...cards].sort((a, b) => rankOf(a) - rankOf(b) || suitOf(a).localeCompare(suitOf(b)));

export type Field = { cards: Card[]; by: string; rank: number };

export type DaifugoState = {
  order: string[];
  rounds: number;
  round: number;
  phase: 'exchange' | 'play' | 'roundEnd' | 'over';
  hands: Record<string, Card[]>;
  field: Field | null;
  lastPlayer: string | null;
  passed: string[];
  turn: string;
  revolution: boolean;
  // このラウンドで上がった順
  finished: string[];
  // 前ラウンドの順位（カード交換と称号表示に使う）
  prevPlacing: string[];
  scores: Record<string, number>;
  // カード交換で、富豪側が渡すべき相手と枚数
  exchange: Record<string, { to: string; count: number }>;
  deadline: number;
  // 手番ごとに増える番号（タイムアウトの取り違え防止）
  seq: number;
  // 直近の出来事（革命・8切り・上がりなど）
  log: { by: string; text: string }[];
};

export type DaifugoAction =
  | { type: 'play'; cards: Card[] }
  | { type: 'pass' }
  | { type: 'give'; cards: Card[] }
  | { type: 'timeout'; seq: number }
  | { type: 'next' };

export const titleOf = (place: number, n: number): string => {
  if (place === 0) return '大富豪';
  if (place === n - 1) return '大貧民';
  if (n >= 4 && place === 1) return '富豪';
  if (n >= 4 && place === n - 2) return '貧民';
  return '平民';
};

const pointsFor = (place: number, n: number) => n - 1 - place;

// 出したカードの組の強さ。不正な組なら null
export const setRank = (cards: Card[]): number | null => {
  if (cards.length < 1 || cards.length > 4) return null;
  const normal = cards.filter((c) => c !== JOKER);
  if (normal.length === 0) return cards.length === 1 ? JOKER_RANK : null;
  const r = rankOf(normal[0]);
  return normal.every((c) => rankOf(c) === r) ? r : null;
};

const strength = (rank: number, revolution: boolean) =>
  rank === JOKER_RANK ? Infinity : revolution ? -rank : rank;

const isSpade3Return = (field: Field | null, cards: Card[]) =>
  field?.rank === JOKER_RANK && field.cards.length === 1 && cards.length === 1 && cards[0] === 'S3';

export const canPlay = (s: DaifugoState, by: string, cards: Card[]): boolean => {
  if (s.phase !== 'play' || s.turn !== by) return false;
  const hand = s.hands[by];
  if (new Set(cards).size !== cards.length || !cards.every((c) => hand.includes(c))) return false;
  const r = setRank(cards);
  if (r === null) return false;
  if (!s.field) return true;
  if (isSpade3Return(s.field, cards)) return true;
  return cards.length === s.field.cards.length && strength(r, s.revolution) > strength(s.field.rank, s.revolution);
};

const isActive = (s: DaifugoState, id: string) => s.hands[id].length > 0;

const withLog = (s: DaifugoState, by: string, text: string): DaifugoState => ({
  ...s,
  log: [...s.log, { by, text }].slice(-6),
});

// 次の手番へ。全員パスして最後に出した人まで戻ったら場を流す
const advance = (s: DaifugoState, from: string, now: number): DaifugoState => {
  const n = s.order.length;
  const start = s.order.indexOf(from);
  let cleared = false;
  for (let i = 1; i <= n * 2; i++) {
    const id = s.order[(start + i) % n];
    if (!cleared && s.field && id === s.lastPlayer) cleared = true;
    if (cleared) {
      if (isActive(s, id)) return { ...s, field: null, passed: [], lastPlayer: null, turn: id, deadline: now + TURN_MS, seq: s.seq + 1 };
      continue;
    }
    if (!isActive(s, id) || s.passed.includes(id)) continue;
    return { ...s, turn: id, deadline: now + TURN_MS, seq: s.seq + 1 };
  }
  // 残っている人がいない（ラウンド終了処理済み）場合のみ到達
  return s;
};

const deal = (s: DaifugoState, now: number): DaifugoState => {
  const deck = shuffle(newDeck());
  const n = s.order.length;
  // 前ラウンドの大富豪から配る（端数は上位に）
  const seating = s.prevPlacing.length ? s.prevPlacing : s.order;
  const hands: Record<string, Card[]> = Object.fromEntries(s.order.map((id) => [id, []]));
  deck.forEach((c, i) => hands[seating[i % n]].push(c));
  for (const id of s.order) hands[id] = sortHand(hands[id]);

  let next: DaifugoState = {
    ...s,
    hands,
    field: null,
    lastPlayer: null,
    passed: [],
    revolution: false,
    finished: [],
    exchange: {},
    seq: s.seq + 1,
  };

  if (s.prevPlacing.length === 0) {
    // 初回はダイヤの3を持つ人から
    const first = s.order.find((id) => hands[id].includes('D3')) ?? s.order[0];
    return { ...next, phase: 'play', turn: first, deadline: now + TURN_MS };
  }

  // 2ラウンド目以降はカード交換。貧民側は最強のカードを自動で献上
  const p = s.prevPlacing;
  const pairs: [string, string, number][] = [[p[0], p[n - 1], 2]];
  if (n >= 4) pairs.push([p[1], p[n - 2], 1]);
  const exchange: DaifugoState['exchange'] = {};
  for (const [rich, poor, count] of pairs) {
    const best = sortHand(next.hands[poor]).slice(-count);
    next = {
      ...next,
      hands: {
        ...next.hands,
        [poor]: next.hands[poor].filter((c) => !best.includes(c)),
        [rich]: sortHand([...next.hands[rich], ...best]),
      },
    };
    exchange[rich] = { to: poor, count };
  }
  return { ...next, phase: 'exchange', exchange, turn: p[n - 1], deadline: now + EXCHANGE_MS };
};

export const init = (players: GamePlayer[], now: number, options: GameOptions = {}): DaifugoState => {
  const order = players.map((p) => p.id);
  return deal(
    {
      order,
      rounds: options.rounds ?? 5,
      round: 1,
      phase: 'play',
      hands: {},
      field: null,
      lastPlayer: null,
      passed: [],
      turn: order[0],
      revolution: false,
      finished: [],
      prevPlacing: [],
      scores: Object.fromEntries(order.map((id) => [id, 0])),
      exchange: {},
      deadline: now,
      seq: 0,
      log: [],
    },
    now,
  );
};

const give = (s: DaifugoState, by: string, cards: Card[], now: number): DaifugoState => {
  const ex = s.exchange[by];
  if (!ex || cards.length !== ex.count || new Set(cards).size !== cards.length || !cards.every((c) => s.hands[by].includes(c)))
    return s;
  const exchange = { ...s.exchange };
  delete exchange[by];
  const next: DaifugoState = {
    ...s,
    exchange,
    hands: {
      ...s.hands,
      [by]: s.hands[by].filter((c) => !cards.includes(c)),
      [ex.to]: sortHand([...s.hands[ex.to], ...cards]),
    },
  };
  if (Object.keys(exchange).length > 0) return next;
  // 交換が終わったら大貧民から開始
  return { ...next, phase: 'play', deadline: now + TURN_MS, seq: s.seq + 1 };
};

const endRoundIfDone = (s: DaifugoState, now: number): DaifugoState | null => {
  const remaining = s.order.filter((id) => isActive(s, id));
  if (remaining.length > 1) return null;
  const finished = [...s.finished, ...remaining];
  const n = s.order.length;
  const scores = { ...s.scores };
  finished.forEach((id, i) => (scores[id] += pointsFor(i, n)));
  return {
    ...s,
    finished,
    scores,
    prevPlacing: finished,
    phase: 'roundEnd',
    field: null,
    deadline: now + ROUND_END_MS,
    seq: s.seq + 1,
  };
};

const play = (s: DaifugoState, by: string, cards: Card[], now: number): DaifugoState => {
  if (!canPlay(s, by, cards)) return s;
  const rank = setRank(cards)!;
  const hand = s.hands[by].filter((c) => !cards.includes(c));
  let next: DaifugoState = {
    ...s,
    hands: { ...s.hands, [by]: hand },
    field: { cards, by, rank },
    lastPlayer: by,
  };
  if (hand.length === 0) {
    next = withLog({ ...next, finished: [...next.finished, by] }, by, `${next.finished.length + 1}番目に上がり`);
  }

  const notes: string[] = [];
  if (cards.length === 4) {
    next = { ...next, revolution: !next.revolution };
    notes.push(next.revolution ? '革命！' : '革命返し！');
  }
  const cut = rank === 8 || isSpade3Return(s.field, cards);
  if (cut) notes.push(rank === 8 ? '8切り' : 'スペ3返し');
  if (notes.length) next = withLog(next, by, notes.join(' '));

  const ended = endRoundIfDone(next, now);
  if (ended) return ended;

  if (cut) {
    // 場を流して同じ人から（上がっていれば次の人から）
    next = { ...next, field: null, passed: [], lastPlayer: null };
    if (isActive(next, by)) return { ...next, turn: by, deadline: now + TURN_MS, seq: next.seq + 1 };
  }
  return advance(next, by, now);
};

export const reduce = (s: DaifugoState, a: DaifugoAction, by: string, now: number): DaifugoState => {
  switch (a.type) {
    case 'play':
      return play(s, by, Array.isArray(a.cards) ? a.cards : [], now);
    case 'pass': {
      if (s.phase !== 'play' || s.turn !== by || !s.field) return s;
      return advance({ ...s, passed: [...s.passed, by] }, by, now);
    }
    case 'give':
      return s.phase === 'exchange' ? give(s, by, Array.isArray(a.cards) ? a.cards : [], now) : s;
    case 'timeout': {
      if (by !== 'system' || a.seq !== s.seq) return s;
      if (s.phase === 'exchange') {
        // 時間切れの人は弱いカードを自動で渡す
        let next = s;
        for (const [rich, ex] of Object.entries(s.exchange)) next = give(next, rich, sortHand(next.hands[rich]).slice(0, ex.count), now);
        return next;
      }
      if (s.phase !== 'play') return s;
      if (s.field) return advance({ ...s, passed: [...s.passed, s.turn] }, s.turn, now);
      // 親で時間切れなら一番弱いカードを1枚出す
      const weakest = s.revolution ? sortHand(s.hands[s.turn]).filter((c) => c !== JOKER).slice(-1) : sortHand(s.hands[s.turn]).slice(0, 1);
      return play(s, s.turn, weakest.length ? weakest : [JOKER], now);
    }
    case 'next': {
      if (by !== 'system' || s.phase !== 'roundEnd') return s;
      if (s.round >= s.rounds) return { ...s, phase: 'over' };
      return deal({ ...s, round: s.round + 1, log: [] }, now);
    }
  }
};

export const schedule = (s: DaifugoState): Scheduled<DaifugoAction> => {
  if (s.phase === 'roundEnd') return { at: s.deadline, action: { type: 'next' } };
  if (s.phase === 'play' || s.phase === 'exchange') return { at: s.deadline, action: { type: 'timeout', seq: s.seq } };
  return null;
};
