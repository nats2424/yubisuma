import { describe, expect, it } from 'vitest';
import { rankByScore, startMicroRound, submitMicro } from '../games/micro/core';
import * as rush from '../games/rush/logic';

const P = ['a', 'b', 'c'].map((id) => ({ id, name: id }));

describe('micro core', () => {
  it('validates submissions and ranks ties together', () => {
    let r = startMicroRound('mash', 0);
    expect(r.startAt).toBeGreaterThan(0);
    r = submitMicro(r, 'a', { score: 30, success: true });
    expect(submitMicro(r, 'a', { score: 99, success: true })).toBe(r); // 二重送信は無視
    expect(submitMicro(r, 'b', { score: 'x' })).toBe(r);
    r = submitMicro(r, 'b', { score: 30, success: true });
    r = submitMicro(r, 'c', { score: 5, success: false });
    expect(rankByScore(r, ['a', 'b', 'c']).map((x) => x.rank)).toEqual([0, 0, 2]);
  });

  it('speeds up scaling games only', () => {
    expect(startMicroRound('mash', 0, 2).duration).toBe(2500);
    expect(startMicroRound('timing', 0, 2).duration).toBe(6000);
  });
});

describe('rush', () => {
  const ok = { score: 1, success: true };
  const ng = { score: 0, success: false };
  const run = (s: rush.RushState, results: Record<string, typeof ok>) => {
    for (const [id, r] of Object.entries(results)) s = rush.reduce(s, { type: 'submit', result: r }, id, 0);
    return s;
  };

  it('loses a life on failure and continues until everyone is out', () => {
    let s = rush.init(P.slice(0, 2), 0, { lives: 2 });
    s = run(s, { a: ok, b: ng });
    expect(s.phase).toBe('result');
    expect(s.lives).toEqual({ a: 2, b: 1 });
    expect(s.cleared).toEqual({ a: 1, b: 0 });
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    expect(s.stage).toBe(2);
    s = run(s, { a: ok, b: ng });
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    // b は脱落、a だけで続行
    expect(rush.alive(s)).toEqual(['a']);
    expect(rush.reduce(s, { type: 'submit', result: ok }, 'b', 0)).toBe(s);
    // 時間切れ（未提出）は失敗扱い
    s = rush.reduce(s, rush.schedule(s)!.action, 'system', 0);
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    s = rush.reduce(s, rush.schedule(s)!.action, 'system', 0);
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    expect(s.phase).toBe('over');
    expect(rush.ranking(s)).toEqual(['a', 'b']);
  });

  it('never repeats the same microgame twice in a row', () => {
    let s = rush.init(P.slice(0, 1), 0, {});
    for (let i = 0; i < 30; i++) {
      const prev = s.round.microId;
      s = run(s, { a: ok });
      s = rush.reduce(s, { type: 'next' }, 'system', 0);
      expect(s.round.microId).not.toBe(prev);
    }
  });
});
