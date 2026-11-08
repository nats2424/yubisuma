// 最終レビュー（docs/dev/09-review.md）の指摘を疑似ネットワークで決定的に再現するテスト。
// 時刻は SimClock だけを使い、ゲーム側の Math.random はシード固定（qa-final.test.ts と同じ方針）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '../games/micro/core';
import { ROOM_TIMINGS } from '../room/engine';
import { createSimRoom, type SimPeer } from './sim/harness';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockImplementation(rng(4242));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const snap = (p: SimPeer) => p.engine.getSnapshot();

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
