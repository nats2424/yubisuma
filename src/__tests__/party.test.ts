import { describe, expect, it } from 'vitest';
import { rankByScore, startMicroRound, submitMicro } from '../games/micro/core';
import * as rush from '../games/rush/logic';
import * as sugo from '../games/sugoroku/logic';

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

describe('sugoroku', () => {
  it('buys a star when passing it with enough coins', () => {
    let s = sugo.init(P, 0, {});
    const p = sugo.currentPlayer(s);
    s = { ...s, starAt: 2, coins: { ...s.coins, [p]: 25 } };
    s = sugo.roll(s, 0, 4);
    expect(s.pos[p]).toBe(4);
    expect(s.stars[p]).toBe(1);
    // 25 - 20 + 青マス3
    expect(s.coins[p]).toBe(8);
    expect(s.starAt).not.toBe(2);
    expect(s.phase).toBe('moved');
  });

  it('red square never goes negative', () => {
    let s = sugo.init(P, 0, {});
    const p = sugo.currentPlayer(s);
    s = { ...s, starAt: 20, coins: { ...s.coins, [p]: 1 } };
    s = sugo.roll(s, 0, 3);
    expect(s.coins[p]).toBe(0);
  });

  it('only the current player can roll', () => {
    const s = sugo.init(P, 0, {});
    const other = s.order.find((id) => id !== sugo.currentPlayer(s))!;
    expect(sugo.reduce(s, { type: 'roll' }, other, 0)).toBe(s);
  });

  it('runs a full game on timeouts with minigame awards', () => {
    let s = sugo.init(P, 0, { rounds: 3 });
    let steps = 0;
    let sawMini = false;
    while (s.phase !== 'over' && steps++ < 500) {
      if (s.phase === 'minigame' && s.mini) {
        sawMini = true;
        s.order.forEach((id, i) => (s = sugo.reduce(s, { type: 'submit', result: { score: i * 10, success: true } }, id, 0)));
        expect(s.phase).toBe('miniResult');
        expect(Math.max(...Object.values(s.miniAwards))).toBe(10);
        continue;
      }
      const sch = sugo.schedule(s)!;
      s = sugo.reduce(s, sch.action, 'system', sch.at);
      Object.values(s.coins).forEach((c) => expect(c).toBeGreaterThanOrEqual(0));
    }
    expect(sawMini).toBe(true);
    expect(s.phase).toBe('over');
    expect(s.round).toBe(3);
  });
});
