import { describe, expect, it } from 'vitest';
import {
  PENALTY_MS,
  roundRanking,
  roundWinners,
  totalRanking,
  type Outcome,
  type ReactionState,
} from '../games/reaction/logic';

const state = (current: Record<string, Outcome>, history: Record<string, Outcome>[] = [current]): ReactionState => ({
  order: ['a', 'b', 'c', 'd'],
  round: history.length,
  phase: 'result',
  until: 0,
  current,
  history,
});

describe('反射神経の順位付け', () => {
  it('通常：速い順に 1〜4 位', () => {
    const s = state({ a: 300, b: 200, c: 400, d: 250 });
    expect(roundRanking(s)).toEqual([
      { id: 'b', outcome: 200, rank: 1 },
      { id: 'd', outcome: 250, rank: 2 },
      { id: 'a', outcome: 300, rank: 3 },
      { id: 'c', outcome: 400, rank: 4 },
    ]);
    expect(roundWinners(s)).toEqual(['b']);
  });

  it('同タイムは同順位で、次の順位は飛ぶ（参加順のまま並ぶ）', () => {
    const s = state({ a: 250, b: 200, c: 200, d: 300 });
    expect(roundRanking(s).map((r) => [r.id, r.rank])).toEqual([
      ['b', 1],
      ['c', 1],
      ['a', 3],
      ['d', 4],
    ]);
    expect(roundWinners(s)).toEqual(['b', 'c']);
  });

  it('フライング・押し忘れは順位なしで後ろ（フライング→押し忘れの順）', () => {
    const s = state({ a: 'miss', b: 'foul', c: 320, d: 'foul' });
    expect(roundRanking(s).map((r) => [r.id, r.rank])).toEqual([
      ['c', 1],
      ['b', null],
      ['d', null],
      ['a', null],
    ]);
    expect(roundWinners(s)).toEqual(['c']);
  });

  it('全員ノーカウントなら 1 位なし', () => {
    const s = state({ a: 'foul', b: 'miss', c: 'foul', d: 'miss' });
    expect(roundRanking(s).every((r) => r.rank === null)).toBe(true);
    expect(roundWinners(s)).toEqual([]);
  });

  it('まだ押していない人（undefined）も順位なしで後ろ', () => {
    const s = { ...state({ b: 210 }), phase: 'go' as const };
    expect(roundRanking(s).map((r) => [r.id, r.rank])).toEqual([
      ['b', 1],
      ['a', null],
      ['c', null],
      ['d', null],
    ]);
  });

  it('累計は合計が少ない順（ペナルティ込み・同点は参加順）', () => {
    const r1: Record<string, Outcome> = { a: 300, b: 'foul', c: 200, d: 300 };
    const r2: Record<string, Outcome> = { a: 300, b: 200, c: 'miss', d: 300 };
    const s = state(r2, [r1, r2]);
    // a=600, b=PENALTY+200, c=200+PENALTY, d=600
    expect(PENALTY_MS).toBeGreaterThan(400);
    expect(totalRanking(s)).toEqual(['a', 'd', 'b', 'c']);
  });
});
