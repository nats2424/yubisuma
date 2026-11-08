import { describe, expect, it } from 'vitest';
import { GAMES } from '../games/registry';
import { createRoom, reduceRoom, type RoomState } from '../room/logic';
import { allowRate, parseRoomAction, parseRoomState, parseWireMessage } from '../room/protocol';

const CODE = 'ABCD';
const room = (): RoomState => {
  let s = createRoom(CODE, { id: 'a', name: 'A' }, 'reaction');
  s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
  s = reduceRoom(s, { type: 'chat', text: 'hi' }, 'b', 10, GAMES);
  return s;
};
const stateMsg = (state: unknown) => ({ v: 2, t: 'state', from: 'a', state, sentAt: 1 });

describe('parseWireMessage（AC-01）', () => {
  it('正しいメッセージはそのまま通る', () => {
    const s = room();
    expect(parseWireMessage(stateMsg(s), CODE)).toEqual(stateMsg(s));
    expect(parseWireMessage({ v: 2, t: 'action', from: 'b', seq: 1, action: { type: 'chat', text: 'x' } }, CODE)).toEqual({
      v: 2,
      t: 'action',
      from: 'b',
      seq: 1,
      action: { type: 'chat', text: 'x' },
    });
    for (const t of ['sync', 'hb', 'bye']) expect(parseWireMessage({ v: 2, t, from: 'b' }, CODE)).toEqual({ v: 2, t, from: 'b' });
    expect(parseWireMessage({ v: 2, t: 'join', from: 'b', name: 'B' }, CODE)).toEqual({ v: 2, t: 'join', from: 'b', name: 'B' });
  });

  it('null・数値・配列・文字列・未知の t・from が文字列でない・版違いは例外なく null', () => {
    const bad: unknown[] = [
      null,
      undefined,
      0,
      42,
      'state',
      [],
      [1, 2],
      {},
      { v: 2, t: 'nope', from: 'b' },
      { v: 2, t: 'hb', from: 1 },
      { v: 2, t: 'hb', from: null },
      { v: 2, t: 'hb', from: '' },
      { v: 2, t: 'hb', from: 'x'.repeat(41) },
      { v: 2, t: 'hb' },
      { t: 'hb', from: 'b' }, // 旧クライアント
      { v: 1, t: 'hb', from: 'b' },
      { v: '2', t: 'hb', from: 'b' },
      { v: 2, t: 'action', from: 'b', seq: 0, action: { type: 'leave' } },
      { v: 2, t: 'action', from: 'b', seq: -1, action: { type: 'leave' } },
      { v: 2, t: 'action', from: 'b', seq: 1.5, action: { type: 'leave' } },
      { v: 2, t: 'action', from: 'b', seq: '1', action: { type: 'leave' } },
      { v: 2, t: 'action', from: 'b', seq: Number.NaN, action: { type: 'leave' } },
      { v: 2, t: 'action', from: 'b', seq: 1 },
      { v: 2, t: 'state', from: 'a', state: room(), sentAt: 'now' },
      { v: 2, t: 'state', from: 'a', state: room() },
      { v: 2, t: 'join', from: 'b', name: 3 },
    ];
    for (const raw of bad) {
      expect(() => parseWireMessage(raw, CODE)).not.toThrow();
      expect(parseWireMessage(raw, CODE)).toBeNull();
    }
  });
});

describe('parseRoomAction（AC-02）', () => {
  it('型違いのフィールドは null', () => {
    const bad: unknown[] = [
      null,
      1,
      [],
      { type: 'nope' },
      { type: 'join', name: 1 },
      { type: 'join' },
      { type: 'chat', text: 1 },
      { type: 'chat', text: null },
      { type: 'chat', text: 'x'.repeat(1001) },
      { type: 'setOption', key: 'lives', value: '3' },
      { type: 'setOption', key: 'lives', value: Number.POSITIVE_INFINITY },
      { type: 'setOption', key: 1, value: 3 },
      { type: 'kick', target: 1 },
      { type: 'selectGame', gameId: {} },
      { type: 'startGame', online: 'a' },
      { type: 'startGame', online: [1] },
      { type: 'startGame', online: Array.from({ length: 21 }, (_, i) => `p${i}`) },
      { type: 'game' },
      // ホストのタイマー専用のアクションはネットワークから受け付けない
      { type: 'gameSystem', action: { type: 'next' } },
    ];
    for (const raw of bad) {
      expect(() => parseRoomAction(raw)).not.toThrow();
      expect(parseRoomAction(raw)).toBeNull();
    }
  });

  it('余計なフィールドは落として組み立て直す', () => {
    expect(parseRoomAction({ type: 'chat', text: 'x', extra: 1 })).toEqual({ type: 'chat', text: 'x' });
    expect(parseRoomAction({ type: 'game', action: { type: 'submit' } })).toEqual({ type: 'game', action: { type: 'submit' } });
  });

  it('不正なアクションを受け付けた結果、ホストの状態は変わらない', () => {
    // engine は parse が null のものを捨てるので、ここでは「null にならず通ったものも reduceRoom が無害」まで確かめる
    const s = room();
    const ok = parseRoomAction({ type: 'setOption', key: 'nope', value: 1 })!;
    expect(reduceRoom(s, ok, 'a', 0, GAMES)).toBe(s);
  });
});

describe('parseRoomState（AC-03）', () => {
  it('players が配列でない・epoch が数値でない・別の部屋コードは採用しない', () => {
    const s = room();
    const bad: unknown[] = [
      { ...s, players: 'a' },
      { ...s, players: { a: 1 } },
      { ...s, players: [{ id: 1, name: 'A' }] },
      { ...s, players: Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: 'x' })) },
      { ...s, epoch: '1' },
      { ...s, epoch: 0 },
      { ...s, epoch: Number.NaN },
      { ...s, version: 1.5 },
      { ...s, code: 'WXYZ' },
      { ...s, hostId: 3 },
      { ...s, chat: 'x' },
      { ...s, chat: [{ id: 'x', by: 1, name: '', text: '', at: 0 }] },
      { ...s, chat: Array.from({ length: 101 }, () => s.chat[0]) },
      { ...s, gameOptions: { rush: { lives: '3' } } },
      { ...s, game: { id: 'rush', players: 'x', state: {}, startedAt: 0 } },
      { ...s, game: 1 },
      { ...s, acks: { b: -1 } },
      { ...s, acks: { b: '1' } },
      { ...s, acks: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, 1])) },
      null,
      [],
    ];
    for (const raw of bad) {
      expect(() => parseRoomState(raw, CODE)).not.toThrow();
      expect(parseRoomState(raw, CODE)).toBeNull();
      expect(parseWireMessage(stateMsg(raw), CODE)).toBeNull();
    }
  });

  it('旧形式（acks なし）は空の acks を補う', () => {
    const { acks: _drop, ...old } = room();
    expect(parseRoomState(old, CODE)?.acks).toEqual({});
  });

  it('"__proto__" をキーに持つ acks でもプロトタイプを汚さない', () => {
    const raw = JSON.parse(`{"__proto__": 5, "b": 1}`) as unknown;
    const parsed = parseRoomState({ ...room(), acks: raw }, CODE);
    expect(parsed).not.toBeNull();
    expect(Object.getPrototypeOf(parsed!.acks)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('allowRate', () => {
  it('直近 windowMs に limit 件まで。超過分は履歴に足さない', () => {
    let h: number[] = [];
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = allowRate(h, 100 + i, 3, 1000);
      results.push(r.ok);
      h = r.history;
    }
    expect(results).toEqual([true, true, true, false, false]);
    expect(h).toEqual([100, 101, 102]);
    // 窓を抜けたらまた通る
    expect(allowRate(h, 1100, 3, 1000).ok).toBe(true);
  });
});
