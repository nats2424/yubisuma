import { pick, shuffle, type GamePlayer, type Scheduled } from '../types';
import { WORD_PAIRS } from './words';

export const TALK_MS = 3 * 60 * 1000;
export const EXTEND_MS = 60 * 1000;

export type WordWolfState = {
  phase: 'talk' | 'vote' | 'result';
  order: string[];
  words: Record<string, string>;
  wolves: string[];
  citizenWord: string;
  wolfWord: string;
  talkEndsAt: number;
  votes: Record<string, string>;
  result: { executed: string | null; tally: Record<string, number>; citizensWin: boolean } | null;
};

export type WordWolfAction =
  | { type: 'extend' }
  | { type: 'toVote' }
  | { type: 'vote'; target: string };

export const wolfCount = (n: number) => (n >= 6 ? 2 : 1);

export const init = (players: GamePlayer[], now: number): WordWolfState => {
  const order = players.map((p) => p.id);
  const pair = shuffle(pick(WORD_PAIRS));
  const [citizenWord, wolfWord] = pair;
  const wolves = shuffle(order).slice(0, wolfCount(order.length));
  return {
    phase: 'talk',
    order,
    words: Object.fromEntries(order.map((id) => [id, wolves.includes(id) ? wolfWord : citizenWord])),
    wolves,
    citizenWord,
    wolfWord,
    talkEndsAt: now + TALK_MS,
    votes: {},
    result: null,
  };
};

const tally = (s: WordWolfState): WordWolfState => {
  const counts: Record<string, number> = {};
  Object.values(s.votes).forEach((t) => (counts[t] = (counts[t] ?? 0) + 1));
  const max = Math.max(...Object.values(counts));
  const top = Object.keys(counts).filter((id) => counts[id] === max);
  // 同票の場合は処刑なし＝ウルフの勝ち
  const executed = top.length === 1 ? top[0] : null;
  return {
    ...s,
    phase: 'result',
    result: { executed, tally: counts, citizensWin: executed !== null && s.wolves.includes(executed) },
  };
};

export const reduce = (s: WordWolfState, a: WordWolfAction, by: string, now: number): WordWolfState => {
  switch (a.type) {
    case 'extend':
      if (s.phase !== 'talk') return s;
      return { ...s, talkEndsAt: Math.max(s.talkEndsAt, now) + EXTEND_MS };
    case 'toVote':
      if (s.phase !== 'talk') return s;
      return { ...s, phase: 'vote' };
    case 'vote': {
      if (s.phase !== 'vote' || by === 'system' || !s.order.includes(a.target) || a.target === by) return s;
      const next = { ...s, votes: { ...s.votes, [by]: a.target } };
      return s.order.every((id) => id in next.votes) ? tally(next) : next;
    }
  }
};

export const schedule = (s: WordWolfState): Scheduled<WordWolfAction> =>
  s.phase === 'talk' ? { at: s.talkEndsAt, action: { type: 'toVote' } } : null;
