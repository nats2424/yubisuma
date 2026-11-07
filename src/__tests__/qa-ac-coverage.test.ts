// QA（Q-01 / Q-02）：既存テストが純粋関数レベルでしか押さえていない AC を engine（疑似ネットワーク）レベルで補強し、
// 回帰の柱（AC-17・AC-26）を別のシードと条件で回す。
// 時刻は SimClock だけを使い、通信の乱数とゲーム側の Math.random はシード固定。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '../games/micro/core';
import type { RushState } from '../games/rush/logic';
import { createManagedTransport, type Transport } from '../lib/transport';
import { ROOM_TIMINGS } from '../room/engine';
import type { RoomState } from '../room/logic';
import { PROTOCOL_VERSION } from '../room/protocol';
import { createSimRoom, ROOM_CODE, rushBot, type CounterState, type SimPeer } from './sim/harness';

const seedGameRandom = (seed: number) => vi.spyOn(Math, 'random').mockImplementation(rng(seed));
beforeEach(() => {
  seedGameRandom(777);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Room = ReturnType<typeof createSimRoom>;
type Wire = { t?: string; seq?: number; from?: string; action?: { type?: string; action?: { type?: string } } };

const snap = (p: SimPeer) => p.engine.getSnapshot();
const stateOf = (p: SimPeer) => snap(p).state as RoomState;
const counter = (p: SimPeer) => stateOf(p).game?.state as CounterState;
const rush = (p: SimPeer) => stateOf(p).game?.state as RushState;
const inc = { type: 'game', action: { type: 'inc' } } as const;
const isAction = (m: unknown) => (m as Wire).t === 'action';

const readyRoom = (ids: string[], opts: Partial<Parameters<typeof createSimRoom>[0]> = {}) => {
  const room = createSimRoom({ ids, ...opts });
  expect(room.sim.clock.runUntil(() => ids.every((id) => snap(room.peers[id]).state?.players.length === ids.length), 30000)).toBe(true);
  room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  return room;
};

const start = (room: Room, host: string, gameId: string, online = Object.keys(room.peers)) => {
  room.peers[host].engine.dispatch({ type: 'selectGame', gameId });
  room.peers[host].engine.dispatch({ type: 'startGame', online });
  expect(room.sim.clock.runUntil(() => online.every((id) => snap(room.peers[id]).state?.game?.id === gameId), 10000)).toBe(true);
};

const hostIs = (room: Room, host: string, ids: string[]) => () => ids.every((id) => snap(room.peers[id]).state?.hostId === host);

// 部屋に生の（壊れた・偽装した）メッセージを流す端末。engine を持たず Transport だけを使う
const rogue = (room: Room, id = 'rogue'): Transport => {
  const node = room.sim.node(id);
  const t = createManagedTransport(node.linkFactory, ROOM_CODE, node.clockFor());
  expect(room.sim.clock.runUntil(() => t.status === 'connected', 1000)).toBe(true);
  return t;
};

// ---------------------------------------------------------------------------
describe('QA: 受信データの検証を engine で（AC-01〜03）', () => {
  it('AC-01（engine）: 壊れた受信データを大量に流しても、ホスト・参加者とも例外を出さず状態は変わらない', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    room.settle(1000);
    const beforeA = stateOf(room.peers.a);
    const beforeB = stateOf(room.peers.b);
    const t = rogue(room);
    const junk: unknown[] = [
      null, 0, 1.5, 'state', [], [1, 2], true, {},
      { v: 2 }, { v: 2, t: 'nope', from: 'x' }, { v: 2, t: 'state', from: 5 },
      { v: 1, t: 'hb', from: 'x' }, { t: 'state', from: 'x', state: beforeA },
      { v: 2, t: 'state', from: 'x', state: null, sentAt: 0 },
      { v: 2, t: 'state', from: 'x', state: { ...beforeA, players: 'nope' }, sentAt: 0 },
      { v: 2, t: 'state', from: 'x', state: { ...beforeA, epoch: '99' }, sentAt: 0 },
      { v: 2, t: 'state', from: 'x', state: { ...beforeA, code: 'ZZZZ', epoch: 99 }, sentAt: 0 },
      { v: 2, t: 'action', from: 'b', seq: 'x', action: inc },
      { v: 2, t: 'action', from: 'b', seq: 99, action: null },
      { v: 2, t: 'action', from: 'b', seq: 99, action: { type: 'gameSystem', action: { type: 'fire' } } },
      { v: 2, t: 'join', from: 'x', name: 42 },
      { v: 2, t: 'sync', from: '' },
      { v: 2, t: 'bye', from: 'x'.repeat(41) },
    ];
    expect(() => {
      for (const m of junk) t.send(m);
      room.settle(1000);
    }).not.toThrow();
    expect(stateOf(room.peers.a).version).toBe(beforeA.version);
    expect(stateOf(room.peers.b).version).toBe(beforeB.version);
    expect(counter(room.peers.a).fired).toBe(true);
    expect(room.hostIds()).toEqual(['a', 'a']);
  });

  it('AC-02（engine）: 型違いのアクションをホストに送っても状態は変わらず、その後の正常なアクションは処理される', () => {
    const room = readyRoom(['a', 'b']);
    const t = rogue(room);
    const before = stateOf(room.peers.a);
    const bad = [
      { type: 'join', name: 1 },
      { type: 'chat', text: { evil: true } },
      { type: 'setOption', key: 'lives', value: '3' },
      { type: 'kick', target: 0 },
      { type: 'startGame', online: 'all' },
    ];
    bad.forEach((action, i) => t.send({ v: PROTOCOL_VERSION, t: 'action', from: 'b', seq: 100 + i, action }));
    room.settle(500);
    expect(stateOf(room.peers.a).version).toBe(before.version);
    expect(stateOf(room.peers.a).acks.b ?? 0).toBe(before.acks.b ?? 0);
    room.peers.b.engine.dispatch({ type: 'chat', text: 'ふつうの発言' });
    room.settle(500);
    expect(stateOf(room.peers.a).chat.at(-1)?.text).toBe('ふつうの発言');
  });

  it('AC-03（engine）: 別の部屋コードの state・players が配列でない state は、より新しい世代でも採用しない', () => {
    const room = readyRoom(['a', 'b']);
    const t = rogue(room);
    const cur = stateOf(room.peers.b);
    t.send({ v: PROTOCOL_VERSION, t: 'state', from: 'rogue', state: { ...cur, code: 'ZZZZ', epoch: 50, hostId: 'rogue' }, sentAt: 0 });
    t.send({ v: PROTOCOL_VERSION, t: 'state', from: 'rogue', state: { ...cur, players: {}, epoch: 50, hostId: 'rogue' }, sentAt: 0 });
    t.send({ v: PROTOCOL_VERSION, t: 'state', from: 'rogue', state: { ...cur, epoch: Number.NaN, hostId: 'rogue' }, sentAt: 0 });
    room.settle(500);
    expect(room.hostIds()).toEqual(['a', 'a']);
    expect(stateOf(room.peers.b).epoch).toBe(cur.epoch);
  });
});

// ---------------------------------------------------------------------------
describe('QA: 連番の重複除去を engine で（AC-12・13・15）', () => {
  it('AC-12（engine）: 同じ seq のアクションが 3 回届いても、適用は 1 回だけ', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    const t = rogue(room);
    const seq = (stateOf(room.peers.a).acks.b ?? 0) + 1;
    for (let i = 0; i < 3; i++) t.send({ v: PROTOCOL_VERSION, t: 'action', from: 'b', seq, action: inc });
    room.settle(500);
    expect(counter(room.peers.a).count.b).toBe(1);
    expect(stateOf(room.peers.a).acks.b).toBe(seq);
  });

  it('AC-13（engine）: seq 5 が seq 4 より先に届くと 5 を処理し、後から届いた 4 は破棄される', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    const t = rogue(room);
    t.send({ v: PROTOCOL_VERSION, t: 'action', from: 'b', seq: 5, action: { type: 'chat', text: '五' } });
    room.settle(100);
    t.send({ v: PROTOCOL_VERSION, t: 'action', from: 'b', seq: 4, action: { type: 'chat', text: '四' } });
    room.settle(500);
    const texts = stateOf(room.peers.a).chat.filter((m) => m.by === 'b').map((m) => m.text);
    expect(texts).toEqual(['五']);
    expect(stateOf(room.peers.a).acks.b).toBe(5);
  });

  it('AC-15（engine）: 旧ホストで処理済みのアクションを、確認を受け取れなかった参加者が新ホストへ再送しても二重適用されない', () => {
    const room = readyRoom(['a', 'b', 'c']);
    start(room, 'a', 'counter');
    // a が処理した結果は c にだけ届き、b には届かない（b は確認できないまま）
    let block = true;
    room.sim.dropWhere((m, from, to) => block && from === 'a' && to === 'b' && (m as Wire).t === 'state', Number.POSITIVE_INFINITY);
    room.peers.b.engine.dispatch(inc);
    room.settle(300);
    expect(counter(room.peers.c).count.b).toBe(1);
    expect(counter(room.peers.b).count.b).toBeUndefined();
    room.peers.a.engine.dispose();
    block = false;
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 2000)).toBe(true);
    room.settle(3000);
    // b は参加順で最古なので b が引き継ぐ。b 自身の outbox を自分で適用しても、c 経由ではなく自分の状態に二重に足さない
    expect(counter(room.peers.b).count.b).toBe(1);
    expect(counter(room.peers.c).count.b).toBe(1);
  });

  it('AC-15（engine・新ホストが別人）: 処理済みの再送は新ホストで捨てられる', () => {
    const room = readyRoom(['a', 'b', 'c']);
    start(room, 'a', 'counter');
    let block = true;
    room.sim.dropWhere((m, from, to) => block && from === 'a' && to === 'c' && (m as Wire).t === 'state', Number.POSITIVE_INFINITY);
    room.peers.c.engine.dispatch(inc);
    room.settle(300);
    expect(counter(room.peers.b).count.c).toBe(1);
    expect(counter(room.peers.c).count.c).toBeUndefined();
    room.peers.a.engine.dispose();
    block = false;
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 2000)).toBe(true);
    room.settle(3000);
    // 新ホスト b は a の処理済み seq（acks）を引き継いでいる。c の再送（同じ seq）が遅れて届いても b で弾かれる
    const seq = room.sim.log.find((e) => e.from === 'c' && isAction(e.msg))?.msg as Wire;
    expect(stateOf(room.peers.b).acks.c).toBe(seq.seq);
    const t = rogue(room);
    for (let i = 0; i < 3; i++) t.send({ v: PROTOCOL_VERSION, t: 'action', from: 'c', seq: seq.seq, action: inc });
    room.settle(1000);
    expect(counter(room.peers.b).count.c).toBe(1);
    expect(counter(room.peers.c).count.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('QA: 回帰の柱を別条件で（AC-17・24・26）', () => {
  // Q-02：AC-17 を既存（101/202/303）と別の 10 シードで回す
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`AC-17（追加シード ${seed}）: 片道 0〜500ms・欠落 20% で 3 人が 10 ステージ進めても一致し、成功がミス扱いにならない`, () => {
      seedGameRandom(seed * 1000 + 7);
      const ids = ['a', 'b', 'c'];
      const room = createSimRoom({ ids, cond: { latencyMs: 0, jitterMs: 500, lossRate: 0.2 }, seed: seed * 31 });
      expect(room.sim.clock.runUntil(() => ids.every((id) => snap(room.peers[id]).state?.players.length === 3), 30000)).toBe(true);
      const bots = ids.map((id) => rushBot(room.peers[id], { success: true, delayMs: 500 }));
      start(room, 'a', 'rush');
      const startLives = rush(room.peers.a).startLives;
      // ホストが交代することもあるので、全員が見ている最新の状態で判定する
      const leader = () => Object.values(room.peers).reduce((m, p) => ((snap(p).state?.version ?? 0) > (snap(m).state?.version ?? 0) && snap(p).isHost ? p : m), room.peers.a);
      expect(room.sim.clock.runUntil(() => rush(leader()).stage >= 11 || rush(leader()).phase === 'over', 300000, 50)).toBe(true);
      room.sim.setAll({ latencyMs: 20, jitterMs: 0, lossRate: 0 });
      room.settle(3000);
      expect(room.sim.clock.runUntil(() => room.converged(), 5000, 1)).toBe(true);
      const finals = ids.map((id) => rush(room.peers[id]));
      for (const f of finals) {
        expect(f.stage).toBe(finals[0].stage);
        expect(f.lives).toEqual(finals[0].lives);
        expect(f.cleared).toEqual(finals[0].cleared);
      }
      expect(finals[0].stage).toBeGreaterThanOrEqual(11);
      expect(finals[0].lives).toEqual({ a: startLives, b: startLives, c: startLives });
      expect(new Set(room.hostIds()).size).toBe(1);
      bots.forEach((s) => s());
    });
  }

  it('AC-17（時計のずれ）: 端末の時計が +5 秒・-3 秒ずれていても、成功を送った人がミス扱いにならない', () => {
    const ids = ['a', 'b', 'c'];
    const room = readyRoom(ids, { skews: { b: 5000, c: -3000 }, cond: { latencyMs: 80, jitterMs: 120 } });
    const bots = ids.map((id) => rushBot(room.peers[id], { success: true, delayMs: 500 }));
    start(room, 'a', 'rush');
    expect(room.sim.clock.runUntil(() => rush(room.peers.a).stage >= 6, 120000, 50)).toBe(true);
    room.settle(2000);
    const r = rush(room.peers.a);
    expect(r.lives).toEqual({ a: r.startLives, b: r.startLives, c: r.startLives });
    expect(r.cleared.b).toBe(r.cleared.a);
    expect(r.cleared.c).toBe(r.cleared.a);
    bots.forEach((s) => s());
  });

  it('AC-24（遅延 300ms・欠落 10%）: ホストが無通信になって 12 秒以内に新ホストが決まり、ラッシュが再開する', () => {
    const ids = ['a', 'b', 'c'];
    // 参加順を固定するため、悪い通信条件は全員が入ってから入れる
    const room = readyRoom(ids, { seed: 99 });
    room.sim.setAll({ latencyMs: 300, lossRate: 0.1 });
    const bots = ['b', 'c'].map((id) => rushBot(room.peers[id], { success: true, delayMs: 500 }));
    start(room, 'a', 'rush');
    room.settle(1000);
    room.peers.a.node.freeze();
    const t0 = room.sim.clock.now();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 12000)).toBe(true);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(12000);
    const stage = rush(room.peers.b).stage;
    expect(room.sim.clock.runUntil(() => rush(room.peers.c).stage > stage, 20000)).toBe(true);
    bots.forEach((s) => s());
  });

  for (const seed of [11, 12, 13]) {
    it(`AC-26（欠落 20%・seed ${seed}）: 二重ホストになっても、通信が戻れば全員のホストが 1 人に一致する`, () => {
      // 参加順（＝次のホスト候補の順）を a,b,c,d に固定するため、ゆらぎは全員が入ってから入れる
      const room = readyRoom(['a', 'b', 'c', 'd'], { seed });
      room.sim.setAll({ latencyMs: 30, jitterMs: 100 });
      let cut = true;
      room.sim.dropWhere((_m, from, to) => cut && ((from === 'b' && to === 'c') || (from === 'c' && to === 'b')), Number.POSITIVE_INFINITY);
      room.peers.a.node.freeze();
      expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost && snap(room.peers.c).isHost, 15000)).toBe(true);
      room.sim.setAll({ lossRate: 0.2 });
      cut = false;
      // 欠落 20% では定期配信（2.5 秒）が落ちることがあるので、3 秒ではなく 6 秒（定期配信 2 回分）を許す
      expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c', 'd']), 6000)).toBe(true);
      room.sim.setAll({ lossRate: 0 });
      room.settle(3000);
      expect(room.converged(['b', 'c', 'd'])).toBe(true);
    });
  }
});
