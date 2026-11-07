// Security（S-01 / S-02）：受信検証・権限・プロトタイプ汚染・壊れた値の大量投入。
// 脅威モデルと票は docs/dev/05-security-report.md。
// 防げているものは通常のテスト、防げていないもの（要修正）は票 ID を名前に入れた it.skip にしてある。
// 修正したら skip を外して通ることを確かめる（票を閉じる条件）。
import { afterEach, describe, expect, it } from 'vitest';
import { rng } from '../games/micro/core';
import { GAMES } from '../games/registry';
import { acceptAction, ackOf, createRoom, reduceRoom, type RoomAction, type RoomState } from '../room/logic';
import { parseRoomAction, parseRoomState, parseWireMessage } from '../room/protocol';

const CODE = 'ABCD';
// a がホスト、b・c が参加者の部屋
const room = (): RoomState => {
  let s = createRoom(CODE, { id: 'a', name: 'A' }, 'wordwolf');
  s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
  s = reduceRoom(s, { type: 'join', name: 'C' }, 'c', 0, GAMES);
  return s;
};
const wire = (x: Record<string, unknown>) => ({ v: 2, from: 'b', ...x });

// プロトタイプ汚染の検出：テスト後に Object.prototype に何も増えていないこと
const protoKeys = () => Object.getOwnPropertyNames(Object.prototype).sort();
const PROTO_BEFORE = protoKeys();
afterEach(() => {
  expect(protoKeys()).toEqual(PROTO_BEFORE);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

// ---------- 壊れた値の生成（シード固定で毎回同じ） ----------

const nasty: unknown[] = [
  undefined,
  null,
  true,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 2,
  '',
  'a',
  'x'.repeat(100_000),
  '__proto__',
  'constructor',
  'toString',
  [],
  {},
  Object.create(null),
  () => 1,
  Symbol('s'),
  10n,
];

const deep = (depth: number): unknown => {
  let o: Record<string, unknown> = {};
  const root = o;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    o.a = next;
    o = next;
  }
  return root;
};

const randomValue = (r: () => number, depth = 0): unknown => {
  const k = Math.floor(r() * 10);
  if (depth > 3 || k < 4) return nasty[Math.floor(r() * nasty.length)];
  if (k < 6) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  const keys = ['v', 't', 'from', 'seq', 'action', 'state', 'type', 'name', 'text', 'value', 'key', 'online', 'target', 'gameId', '__proto__', 'constructor'];
  const o: Record<string, unknown> = {};
  // JSON.parse と同じく "__proto__" も自分のプロパティとして作る（代入だとこのテスト自身がプロトタイプを差し替えてしまう）
  for (let i = 0; i < 1 + Math.floor(r() * 5); i++) {
    const value = randomValue(r, depth + 1);
    Object.defineProperty(o, keys[Math.floor(r() * keys.length)], { value, enumerable: true, writable: true, configurable: true });
  }
  return o;
};

// 正しいメッセージの一部だけを壊したもの（境界の近くを狙う）
const mutate = (r: () => number, base: Record<string, unknown>): unknown => {
  const keys = Object.keys(base);
  const k = keys[Math.floor(r() * keys.length)];
  return { ...base, [k]: randomValue(r) };
};

describe('壊れた値の大量投入（S-02）', () => {
  const r = rng(20261107);
  const s = room();
  const bases: Record<string, unknown>[] = [
    wire({ t: 'action', seq: 1, action: { type: 'chat', text: 'hi' } }),
    wire({ t: 'action', seq: 1, action: { type: 'game', action: { type: 'vote', target: 'c' } } }),
    wire({ t: 'join', name: 'B' }),
    wire({ t: 'state', state: s, sentAt: 1 }),
    { ...s },
  ];

  it('parseWireMessage / parseRoomAction / parseRoomState は 5000 件のランダム・半壊の値で例外を投げない', () => {
    for (let i = 0; i < 5000; i++) {
      const raw = i % 2 === 0 ? randomValue(r) : mutate(r, bases[i % bases.length]);
      expect(() => parseWireMessage(raw, CODE)).not.toThrow();
      expect(() => parseRoomAction(raw)).not.toThrow();
      expect(() => parseRoomState(raw, CODE)).not.toThrow();
    }
  });

  it('parse を通ったアクションを acceptAction に入れても例外を投げず、ホストの状態を書き換えない', () => {
    for (let i = 0; i < 3000; i++) {
      const raw = mutate(r, bases[i % 2]);
      const msg = parseWireMessage(raw, CODE);
      if (!msg || msg.t !== 'action') continue;
      const before = JSON.stringify(s);
      expect(() => acceptAction(s, msg.from, msg.seq, msg.action, 1000, GAMES)).not.toThrow();
      // 入力の state は破壊的に変更されない
      expect(JSON.stringify(s)).toBe(before);
    }
  });

  it('NaN / Infinity / 負 / 小数 / 安全でない整数の seq は捨てる', () => {
    for (const seq of [NaN, Infinity, -Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 2, '1', null]) {
      expect(parseWireMessage(wire({ t: 'action', seq, action: { type: 'leave' } }), CODE)).toBeNull();
      if (typeof seq === 'number') expect(acceptAction(room(), 'b', seq, { type: 'leave' }, 0, GAMES)).toBeNull();
    }
  });

  it('巨大な文字列は受信時に捨てる（from 41 文字・chat 1001 文字・名前 1001 文字）', () => {
    expect(parseWireMessage({ v: 2, t: 'hb', from: 'x'.repeat(41) }, CODE)).toBeNull();
    expect(parseWireMessage(wire({ t: 'action', seq: 1, action: { type: 'chat', text: 'x'.repeat(1001) } }), CODE)).toBeNull();
    expect(parseWireMessage(wire({ t: 'join', name: 'x'.repeat(1001) }), CODE)).toBeNull();
    // 受け付ける長さでも、ホストで名前 10 文字・チャット 200 文字に切る
    let st = reduceRoom(room(), { type: 'join', name: 'y'.repeat(1000) }, 'd', 0, GAMES);
    expect(st.players.find((p) => p.id === 'd')?.name).toHaveLength(10);
    st = reduceRoom(st, { type: 'chat', text: 'z'.repeat(1000) }, 'd', 0, GAMES);
    expect(st.chat.at(-1)?.text).toHaveLength(200);
  });

  it('深い入れ子（10 万段）の game アクションでも例外を投げず、状態は変わらない', () => {
    let s0 = room();
    s0 = reduceRoom(s0, { type: 'startGame', online: ['a', 'b', 'c'] }, 'a', 0, GAMES);
    const parsed = parseWireMessage(wire({ t: 'action', seq: 1, action: { type: 'game', action: deep(100_000) } }), CODE);
    expect(parsed?.t).toBe('action');
    if (parsed?.t !== 'action') return;
    const next = acceptAction(s0, 'b', 1, parsed.action, 10, GAMES);
    expect(next?.game?.state).toBe(s0.game?.state);
  });

  it('players・chat・acks・startGame.online の件数上限を超えた状態・アクションは捨てる', () => {
    const s0 = room();
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: 'n' }));
    expect(parseRoomState({ ...s0, players: many }, CODE)).toBeNull();
    expect(parseRoomState({ ...s0, chat: Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, by: 'a', name: 'A', text: 't', at: 0 })) }, CODE)).toBeNull();
    expect(parseRoomState({ ...s0, acks: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, 1])) }, CODE)).toBeNull();
    expect(parseRoomAction({ type: 'startGame', online: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toBeNull();
  });
});

describe('プロトタイプ汚染（S-02）', () => {
  // JSON.parse は "__proto__" を普通のキーとして作るので、実際のネットワーク経由と同じ形にする
  const evilJson = (s: RoomState) =>
    JSON.parse(
      JSON.stringify(s)
        .replace('"gameOptions":{}', '"gameOptions":{"__proto__":{"polluted":1},"constructor":{"prototype":1}}')
        .replace('"acks":{}', '"acks":{"__proto__":5,"constructor":3}'),
    );

  it('gameOptions / acks に __proto__ / constructor を入れた状態でも Object.prototype は汚れない', () => {
    const parsed = parseRoomState(evilJson(room()), CODE);
    expect(parsed).not.toBeNull();
    expect(Object.getPrototypeOf(parsed!.gameOptions)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed!.acks)).toBe(Object.prototype);
    // 継承されたプロパティを処理済み seq として拾わない
    expect(ackOf(parsed!, 'toString')).toBe(0);
    // 汚染キーを持った状態からルームを進めても汚染しない
    const next = reduceRoom(parsed!, { type: 'setOption', key: '__proto__', value: 1 }, 'a', 0, GAMES);
    expect(next).toBe(parsed);
  });

  it('アクションに __proto__ を含めても余計なキーは落とされる', () => {
    const raw = JSON.parse('{"type":"chat","text":"hi","__proto__":{"polluted":1},"isHost":true}');
    expect(parseRoomAction(raw)).toEqual({ type: 'chat', text: 'hi' });
    const msg = JSON.parse('{"v":2,"t":"hb","from":"b","__proto__":{"polluted":1}}');
    expect(parseWireMessage(msg, CODE)).toEqual({ v: 2, t: 'hb', from: 'b' });
  });

  it.skip('SEC-03: Object.prototype にある名前（__proto__ / constructor / toString など）はプレイヤー ID として受け付けない', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(parseWireMessage({ v: 2, t: 'join', from: id, name: 'X' }, CODE)).toBeNull();
      const s = room();
      expect(parseRoomState({ ...s, players: [...s.players, { id, name: 'X' }] }, CODE)).toBeNull();
    }
  });
});

describe('権限：ホストしかできない操作・メンバー以外の操作（S-01）', () => {
  it('gameSystem（ホストのタイマー専用）はネットワークから受け付けない', () => {
    expect(parseRoomAction({ type: 'gameSystem', action: { type: 'toVote' } })).toBeNull();
    expect(acceptAction(room(), 'b', 1, { type: 'gameSystem', action: {} }, 0, GAMES)).toBeNull();
  });

  it('参加者からの kick / selectGame / setOption / startGame / endGame は状態を変えない（seq だけ進む）', () => {
    const s = room();
    const actions: RoomAction[] = [
      { type: 'kick', target: 'c' },
      { type: 'selectGame', gameId: 'rush' },
      { type: 'setOption', key: 'talkMinutes', value: 1 },
      { type: 'startGame', online: ['a', 'b', 'c'] },
    ];
    actions.forEach((a, i) => {
      const next = acceptAction(s, 'b', i + 1, a, 0, GAMES)!;
      expect({ ...next, acks: {} }).toEqual({ ...s, acks: {} });
      expect(next.acks.b).toBe(i + 1);
    });
    const started = reduceRoom(s, { type: 'startGame', online: ['a', 'b', 'c'] }, 'a', 0, GAMES);
    expect(acceptAction(started, 'b', 1, { type: 'endGame' }, 5000, GAMES)!.game).not.toBeNull();
  });

  it('メンバーでない ID からのアクションは捨てる', () => {
    expect(acceptAction(room(), 'stranger', 1, { type: 'chat', text: 'hi' }, 0, GAMES)).toBeNull();
    expect(acceptAction(room(), 'stranger', 1, { type: 'leave' }, 0, GAMES)).toBeNull();
  });

  it('途中参加者（game.players にいない人）のゲーム操作は無視される', () => {
    let s = reduceRoom(room(), { type: 'startGame', online: ['a', 'b', 'c'] }, 'a', 0, GAMES);
    s = reduceRoom(s, { type: 'join', name: 'D' }, 'd', 1, GAMES);
    const next = acceptAction(s, 'd', 1, { type: 'game', action: { type: 'toVote' } }, 2, GAMES)!;
    expect(next.game?.state).toBe(s.game?.state);
  });

  it('同じ seq・古い seq は二重に適用しない（リプレイ）', () => {
    const s1 = acceptAction(room(), 'b', 5, { type: 'chat', text: 'one' }, 0, GAMES)!;
    expect(acceptAction(s1, 'b', 5, { type: 'chat', text: 'one' }, 10_000, GAMES)).toBeNull();
    expect(acceptAction(s1, 'b', 4, { type: 'chat', text: 'old' }, 10_000, GAMES)).toBeNull();
  });

  it('チャットの連投は 3 秒に 3 件まで（ホストで捨てる）', () => {
    let s = room();
    for (let i = 0; i < 10; i++) s = reduceRoom(s, { type: 'chat', text: `m${i}` }, 'b', 100 * i, GAMES);
    expect(s.chat.filter((m) => m.by === 'b')).toHaveLength(3);
  });

  it('（許容リスク R-01 の確認）他人の ID を名乗った操作は、その人の操作として適用される', () => {
    // from は自己申告なので、b が c を名乗って c を退出させられる。サーバーなし構成では防げない（報告書 R-01）
    const s = acceptAction(room(), 'c', 1, { type: 'leave' }, 0, GAMES)!;
    expect(s.players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it.skip('SEC-02: 処理済み seq から大きく飛んだ seq（MAX_SAFE_INTEGER など）は受け付けない', () => {
    // 現状：c を名乗って seq = MAX_SAFE_INTEGER を送ると acks.c が上限になり、
    // c の次の seq（MAX_SAFE_INTEGER + 1）は parseWireMessage で捨てられるため、c はこの部屋で二度と操作できない
    const s = room();
    expect(acceptAction(s, 'c', Number.MAX_SAFE_INTEGER, { type: 'chat', text: 'x' }, 0, GAMES)).toBeNull();
    expect(acceptAction(s, 'c', 1_000_000, { type: 'chat', text: 'x' }, 0, GAMES)).toBeNull();
    // 通常の範囲（未確認の再送は最大 50 件）は受け付ける
    expect(acceptAction(s, 'c', 50, { type: 'chat', text: 'x' }, 0, GAMES)).not.toBeNull();
  });
});
