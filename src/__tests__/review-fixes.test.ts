// 最終レビュー（docs/dev/09-review.md）の指摘を疑似ネットワークで決定的に再現するテスト。
// 時刻は SimClock だけを使い、ゲーム側の Math.random はシード固定（qa-final.test.ts と同じ方針）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '../games/micro/core';
import { createManagedTransport, REBUILD_AFTER_MS, type LinkFactory } from '../lib/transport';
import { RoomEngine, ROOM_TIMINGS } from '../room/engine';
import { createRoom, reduceRoom } from '../room/logic';
import { createSimRoom, memoryStore, ROOM_CODE, SIM_GAMES, type SimPeer } from './sim/harness';
import { SimNetwork } from './sim/network';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockImplementation(rng(4242));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const snap = (p: SimPeer) => p.engine.getSnapshot();

// Link を作った回数を数えられる 1 人部屋（本番と同じ ManagedTransport・RoomEngine）
const countedEngine = () => {
  const net = new SimNetwork({ seed: 1 });
  const node = net.node('h');
  let links = 0;
  const factory: LinkFactory = (room, ev) => {
    links++;
    return node.linkFactory(room, ev);
  };
  const clock = node.clockFor();
  const engine = new RoomEngine({
    code: ROOM_CODE,
    me: 'h',
    name: 'H',
    create: true,
    transport: createManagedTransport(factory, ROOM_CODE, clock),
    clock,
    storage: memoryStore(),
    games: SIM_GAMES,
    defaultGame: 'counter',
  });
  engine.start();
  return { net, node, engine, links: () => links };
};

describe('R-01：復帰のたびに Link を二重に作らない', () => {
  it('R-01: online イベント 1 回で作る Link は 1 本', () => {
    const { net, engine, links } = countedEngine();
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
    engine.setNetworkOnline(false);
    const before = links();
    engine.setNetworkOnline(true);
    expect(links() - before).toBe(1);
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
  });

  it('R-01: online の直後に visibilitychange / pageshow の resume が来ても、張り直したばかりの Link を捨てない', () => {
    const { net, engine, links } = countedEngine();
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
    engine.setNetworkOnline(false);
    const before = links();
    engine.setNetworkOnline(true);
    engine.resume();
    engine.resume();
    expect(links() - before).toBe(1);
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
  });

  it('R-01: 初回接続中（connecting）の resume では張り直さない', () => {
    const { engine, links } = countedEngine();
    expect(engine.getSnapshot().connection).toBe('connecting');
    engine.resume();
    expect(links()).toBe(1);
  });

  it('R-01: failed の transport は nudge() で接続し直す（resume からの再試行は従来どおり）', () => {
    const net = new SimNetwork({ seed: 1 });
    const node = net.node('a');
    node.failConnects(4);
    const t = createManagedTransport(node.linkFactory, ROOM_CODE, node.clockFor());
    expect(net.clock.runUntil(() => t.status === 'failed', 60000)).toBe(true);
    t.nudge();
    expect(t.status).toBe('connecting');
    expect(net.clock.runUntil(() => t.status === 'connected', 5000)).toBe(true);
  });

  it('R-01 の修正後も、reconnecting が続いている Link は resume で今すぐ作り直す', () => {
    const { net, node, engine, links } = countedEngine();
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
    node.disconnect();
    expect(engine.getSnapshot().connection).toBe('reconnecting');
    net.clock.advance(REBUILD_AFTER_MS - 1000);
    const before = links();
    engine.resume();
    expect(links() - before).toBe(1);
    node.restore();
    expect(net.clock.runUntil(() => engine.getSnapshot().connection === 'connected', 5000)).toBe(true);
  });
});

// engine の内部表（テストからの観察用）
const departedOf = (p: SimPeer) => [...(p.engine as unknown as { departed: Set<string> }).departed];

describe('R-02：bye のあと戻ってきたメンバーを「去った人」に残さない', () => {
  const backAfterBye = () => {
    const ids = ['h', 'b', 'c'];
    const room = createSimRoom({ ids });
    expect(room.sim.clock.runUntil(() => ids.every((id) => snap(room.peers[id]).state?.players.length === 3), 30000)).toBe(true);
    room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
    // b が bfcache などで pageHide（bye を送る）→ 1 秒後に戻る
    room.peers.b.engine.pageHide();
    room.settle(1000);
    room.peers.b.engine.resume();
    room.settle(5000);
    return room;
  };

  it('R-02: bye を送ったあと戻って hb を送っている b は、他の端末の departed に残らない', () => {
    const room = backAfterBye();
    expect(departedOf(room.peers.c)).toEqual([]);
    expect(departedOf(room.peers.h)).toEqual([]);
  });

  it('R-02: 戻った b は、c が猶予中にホストの bye を受けても次のホスト候補に入る（c が b を飛ばして名乗らない）', () => {
    const room = backAfterBye();
    // c は復帰直後（猶予中）にホストの bye を受ける。b は一瞬固まっていて先に名乗れない
    room.peers.b.node.freeze();
    room.peers.c.engine.resume();
    room.peers.h.engine.dispose();
    let cClaimed = false;
    for (let t = 0; t < 1500; t += 100) {
      room.settle(100);
      if (snap(room.peers.c).isHost) cClaimed = true;
    }
    // 修正前は c の departed に b が残り、猶予中の候補から b を外して c が 500ms 以内に自分を選んでいた
    expect(cClaimed).toBe(false);
    room.peers.b.node.thaw();
    expect(room.sim.clock.runUntil(() => room.converged(['b', 'c']) && snap(room.peers.c).state?.hostId === 'b', 20000)).toBe(true);
  });
});

describe('R-07：reduceRoom のゲーム引きを hasGame にそろえる', () => {
  const base = createRoom('ABCD', { id: 'h', name: 'H' }, 'counter');

  it('R-07: ホスト自身でも、継承プロパティの名前（constructor など）は selectGame できない', () => {
    for (const gameId of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(reduceRoom(base, { type: 'selectGame', gameId }, 'h', 0, SIM_GAMES)).toBe(base);
    }
  });

  it('R-07: selectedGame が継承プロパティの名前でも、startGame・setOption は状態を変えない（例外も投げない）', () => {
    const odd = { ...base, selectedGame: 'constructor' };
    expect(reduceRoom(odd, { type: 'startGame', online: ['h'] }, 'h', 0, SIM_GAMES)).toBe(odd);
    expect(reduceRoom(odd, { type: 'setOption', key: 'x', value: 1 }, 'h', 0, SIM_GAMES)).toBe(odd);
  });

  it('R-07: 登録済みのゲームは従来どおり選べる', () => {
    expect(reduceRoom(base, { type: 'selectGame', gameId: 'rush' }, 'h', 0, SIM_GAMES).selectedGame).toBe('rush');
  });
});
