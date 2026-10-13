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
  it('scores stages and ends', () => {
    let s = rush.init(P, 0, { stages: 2 });
    expect(s.playlist).toHaveLength(2);
    s = rush.reduce(s, { type: 'submit', result: { score: 10, success: true } }, 'a', 0);
    s = rush.reduce(s, { type: 'submit', result: { score: 20, success: true } }, 'b', 0);
    s = rush.reduce(s, { type: 'submit', result: { score: 50, success: false } }, 'c', 0);
    expect(s.phase).toBe('result');
    expect(s.points).toEqual({ a: 1, b: 2, c: 0 });
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    expect(s.stage).toBe(2);
    // 未提出のまま時間切れ
    s = rush.reduce(s, rush.schedule(s)!.action, 'system', 0);
    expect(s.phase).toBe('result');
    s = rush.reduce(s, { type: 'next' }, 'system', 0);
    expect(s.phase).toBe('over');
  });
});
