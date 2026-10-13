import type { GamePlayer, Scheduled } from '../types';

export const HANDS = 2;
const REVEAL_MS = 4000;

export type YubisumaResult = {
  caller: string;
  call: number;
  total: number;
  hit: boolean;
  thumbs: Record<string, number>;
};

export type YubisumaState = {
  order: string[];
  hands: Record<string, number>;
  // 両手を下ろせた順（上がった順）
  finished: string[];
  caller: string;
  phase: 'choose' | 'reveal' | 'over';
  thumbs: Record<string, number>;
  call: number | null;
  round: number;
  last: YubisumaResult | null;
  revealUntil: number;
};

export type YubisumaAction =
  | { type: 'choose'; thumbs: number; call?: number }
  | { type: 'next' };

export const activePlayers = (s: YubisumaState) => s.order.filter((id) => s.hands[id] > 0);
export const maxCall = (s: YubisumaState) => activePlayers(s).reduce((sum, id) => sum + s.hands[id], 0);

export const init = (players: GamePlayer[]): YubisumaState => {
  const order = players.map((p) => p.id);
  return {
    order,
    hands: Object.fromEntries(order.map((id) => [id, HANDS])),
    finished: [],
    caller: order[Math.floor(Math.random() * order.length)],
    phase: 'choose',
    thumbs: {},
    call: null,
    round: 1,
    last: null,
    revealUntil: 0,
  };
};

const nextCaller = (s: YubisumaState, from: string): string => {
  const idx = s.order.indexOf(from);
  for (let i = 1; i <= s.order.length; i++) {
    const id = s.order[(idx + i) % s.order.length];
    if (s.hands[id] > 0) return id;
  }
  return from;
};

export const reduce = (s: YubisumaState, a: YubisumaAction, by: string, now: number): YubisumaState => {
  if (a.type === 'next') {
    if (by !== 'system' || s.phase !== 'reveal') return s;
    return { ...s, phase: 'choose', caller: nextCaller(s, s.caller), thumbs: {}, call: null, round: s.round + 1 };
  }

  if (s.phase !== 'choose' || !(s.hands[by] > 0)) return s;
  const thumbs = Math.trunc(a.thumbs);
  if (!(thumbs >= 0 && thumbs <= s.hands[by])) return s;
  let call = s.call;
  if (by === s.caller) {
    if (a.call === undefined) return s;
    const c = Math.trunc(a.call);
    if (!(c >= 0 && c <= maxCall(s))) return s;
    call = c;
  }
  const next: YubisumaState = { ...s, thumbs: { ...s.thumbs, [by]: thumbs }, call };

  const active = activePlayers(next);
  if (!active.every((id) => id in next.thumbs) || next.call === null) return next;

  // 全員出そろったら判定
  const total = active.reduce((sum, id) => sum + next.thumbs[id], 0);
  const hit = total === next.call;
  const hands = { ...next.hands };
  const finished = [...next.finished];
  if (hit) {
    hands[next.caller] -= 1;
    if (hands[next.caller] === 0) finished.push(next.caller);
  }
  const result: YubisumaResult = { caller: next.caller, call: next.call, total, hit, thumbs: next.thumbs };
  const remaining = next.order.filter((id) => hands[id] > 0);
  return {
    ...next,
    hands,
    finished,
    last: result,
    phase: remaining.length <= 1 ? 'over' : 'reveal',
    revealUntil: now + REVEAL_MS,
  };
};

export const schedule = (s: YubisumaState): Scheduled<YubisumaAction> =>
  s.phase === 'reveal' ? { at: s.revealUntil, action: { type: 'next' } } : null;
