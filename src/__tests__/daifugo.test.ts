import { describe, expect, it } from 'vitest';
import { canPlay, init, JOKER, rankOf, reduce, schedule, type DaifugoState } from '../games/daifugo/logic';
import { GAMES } from '../games/registry';
import { createRoom, reduceRoom } from '../room/logic';

const P = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));

// 手札と手番を指定した状態を作る
const setup = (hands: Record<string, string[]>, extra: Partial<DaifugoState> = {}): DaifugoState => ({
  ...init(P.slice(0, Object.keys(hands).length), 0, { rounds: 1 }),
  hands,
  turn: 'a',
  phase: 'play',
  field: null,
  lastPlayer: null,
  passed: [],
  ...extra,
});

describe('daifugo', () => {
  it('deals all 53 cards and starts with the D3 holder', () => {
    const s = init(P, 0, {});
    const all = Object.values(s.hands).flat();
    expect(all).toHaveLength(53);
    expect(new Set(all).size).toBe(53);
    expect(s.hands[s.turn]).toContain('D3');
    expect(s.rounds).toBe(5);
  });

  it('requires same count and higher rank; joker is wild', () => {
    const s = setup({ a: ['S5', 'H5', 'S9', JOKER], b: ['S3', 'D7'], c: ['C4'] }, { field: { cards: ['S4', 'H4'], by: 'c', rank: 4 }, lastPlayer: 'c' });
    expect(canPlay(s, 'a', ['S5', 'H5'])).toBe(true);
    expect(canPlay(s, 'a', ['S9', JOKER])).toBe(true);
    expect(canPlay(s, 'a', ['S9'])).toBe(false);
    expect(canPlay(s, 'a', ['S5', 'S9'])).toBe(false);
    expect(canPlay(s, 'b', ['S3'])).toBe(false); // 手番ではない
  });

  it('everyone passing clears the field back to the last player', () => {
    let s = setup({ a: ['S9', 'S3'], b: ['S4', 'S5'], c: ['C4', 'C5'] });
    s = reduce(s, { type: 'play', cards: ['S9'] }, 'a', 0);
    expect(s.turn).toBe('b');
    s = reduce(s, { type: 'pass' }, 'b', 0);
    s = reduce(s, { type: 'pass' }, 'c', 0);
    expect(s.turn).toBe('a');
    expect(s.field).toBeNull();
    // 親はパスできない
    expect(reduce(s, { type: 'pass' }, 'a', 0)).toBe(s);
  });

  it('8 cuts the field and the same player leads again', () => {
    let s = setup({ a: ['S8', 'S3'], b: ['S4'], c: ['C4'] }, { field: { cards: ['C5'], by: 'c', rank: 5 }, lastPlayer: 'c' });
    s = reduce(s, { type: 'play', cards: ['S8'] }, 'a', 0);
    expect(s.field).toBeNull();
    expect(s.turn).toBe('a');
  });

  it('four of a kind starts a revolution', () => {
    let s = setup({ a: ['S6', 'H6', 'D6', 'C6', 'S3'], b: ['S4', 'S13'], c: ['C4'] });
    s = reduce(s, { type: 'play', cards: ['S6', 'H6', 'D6', 'C6'] }, 'a', 0);
    expect(s.revolution).toBe(true);
    s = { ...s, field: { cards: ['S9'], by: 'c', rank: 9 }, turn: 'b', passed: [] };
    expect(canPlay(s, 'b', ['S4'])).toBe(true);
    expect(canPlay(s, 'b', ['S13'])).toBe(false);
  });

  it('spade 3 beats a single joker', () => {
    const s = setup({ a: ['S3', 'H4'], b: ['S5'], c: ['C4'] }, { field: { cards: [JOKER], by: 'b', rank: 16 }, lastPlayer: 'b' });
    expect(canPlay(s, 'a', ['S3'])).toBe(true);
    const next = reduce(s, { type: 'play', cards: ['S3'] }, 'a', 0);
    expect(next.field).toBeNull();
    expect(next.turn).toBe('a');
  });

  it('finishing order gives points and ends the round', () => {
    let s = setup({ a: ['S9'], b: ['S4', 'S5'], c: ['C4', 'C10'] });
    s = reduce(s, { type: 'play', cards: ['S9'] }, 'a', 0);
    expect(s.finished).toEqual(['a']);
    s = reduce(s, { type: 'pass' }, 'b', 0);
    s = reduce(s, { type: 'play', cards: ['C10'] }, 'c', 0);
    s = reduce(s, { type: 'pass' }, 'b', 0);
    // c が親で再開
    expect(s.turn).toBe('c');
    s = reduce(s, { type: 'play', cards: ['C4'] }, 'c', 0);
    expect(s.phase).toBe('roundEnd');
    expect(s.finished).toEqual(['a', 'c', 'b']);
    expect(s.scores).toEqual({ a: 2, b: 0, c: 1 });
  });

  it('exchanges cards from round 2', () => {
    let s = init(P, 0, { rounds: 2 });
    s = { ...s, phase: 'roundEnd', prevPlacing: ['a', 'b', 'c', 'd'], deadline: 0 };
    s = reduce(s, { type: 'next' }, 'system', 0);
    expect(s.phase).toBe('exchange');
    expect(s.exchange).toEqual({ a: { to: 'd', count: 2 }, b: { to: 'c', count: 1 } });
    // 大貧民は一番強いカードを渡している
    const max = (h: string[]) => Math.max(...h.map(rankOf));
    expect(max(s.hands.a)).toBeGreaterThanOrEqual(max(s.hands.d));
    s = reduce(s, { type: 'give', cards: s.hands.a.slice(0, 2) }, 'a', 0);
    s = reduce(s, { type: 'give', cards: s.hands.b.slice(0, 1) }, 'b', 0);
    expect(s.phase).toBe('play');
    expect(s.turn).toBe('d');
    expect(Object.values(s.hands).flat()).toHaveLength(53);
  });

  it('timeouts alone always finish the whole game', () => {
    for (let trial = 0; trial < 20; trial++) {
      let s = init(P.slice(0, 3 + (trial % 4 === 3 ? 1 : trial % 3)), 0, { rounds: 3 });
      let steps = 0;
      while (s.phase !== 'over' && steps++ < 5000) {
        const sch = schedule(s)!;
        s = reduce(s, sch.action, 'system', sch.at);
        expect(Object.values(s.hands).flat().length).toBeLessThanOrEqual(53);
      }
      expect(s.phase).toBe('over');
    }
  });

  it('random legal play finishes rounds', () => {
    for (let trial = 0; trial < 30; trial++) {
      let s = init(P, 0, { rounds: 2 });
      let steps = 0;
      while (s.phase !== 'over' && steps++ < 5000) {
        if (s.phase === 'play') {
          const hand = s.hands[s.turn];
          const options = [...hand.map((c) => [c]), ...hand.flatMap((c, i) => hand.slice(i + 1).map((d) => [c, d]))].filter((cs) =>
            canPlay(s, s.turn, cs),
          );
          if (options.length && (!s.field || Math.random() < 0.7)) {
            s = reduce(s, { type: 'play', cards: options[Math.floor(Math.random() * options.length)] }, s.turn, 0);
          } else if (s.field) {
            s = reduce(s, { type: 'pass' }, s.turn, 0);
          } else {
            throw new Error('leader has no legal play');
          }
        } else {
          s = reduce(s, schedule(s)!.action, 'system', 0);
        }
      }
      expect(s.phase).toBe('over');
      expect(Object.values(s.scores).reduce((a, b) => a + b, 0)).toBe(2 * (0 + 1 + 2 + 3));
    }
  });

  it('room passes host-chosen options to the game', () => {
    let room = createRoom('ABCD', P[0], 'daifugo');
    for (const p of P.slice(1, 3)) room = reduceRoom(room, { type: 'join', name: p.name }, p.id, 0, GAMES);
    room = reduceRoom(room, { type: 'setOption', key: 'rounds', value: 10 }, 'a', 0, GAMES);
    expect(reduceRoom(room, { type: 'setOption', key: 'rounds', value: 7 }, 'a', 0, GAMES)).toBe(room);
    room = reduceRoom(room, { type: 'startGame', online: ['a', 'b', 'c'] }, 'a', 0, GAMES);
    expect((room.game!.state as DaifugoState).rounds).toBe(10);
  });
});
