// QA 最終再確認：ブラウザ E2E で見つけた事象を疑似ネットワークで決定的に再現する（docs/dev/04-qa-report.md §6）。
// 時刻は SimClock だけを使い、通信の乱数とゲーム側の Math.random はシード固定（qa-exceptions.test.ts と同じ方針）。
// 失敗するもの（不具合票）は票 ID を名前に入れた it.skip。修正担当は修正後に skip を外すこと。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '../games/micro/core';
import { ROOM_TIMINGS } from '../room/engine';
import type { RoomState } from '../room/logic';
import { createSimRoom, type CounterState, type SimPeer } from './sim/harness';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockImplementation(rng(4242));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const snap = (p: SimPeer) => p.engine.getSnapshot();
const stateOf = (p: SimPeer) => snap(p).state as RoomState;

// 全員が入り、引き継ぎ判定の猶予（接続から 9 秒）も過ぎた部屋
const readyRoom = (ids: string[]) => {
  const room = createSimRoom({ ids });
  expect(room.sim.clock.runUntil(() => ids.every((id) => snap(room.peers[id]).state?.players.length === ids.length), 30000)).toBe(true);
  room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  return room;
};

// [ホスト, 次の候補, スリープする人] の部屋で counter を始め、スリープ中に次の候補が 20 回操作したあと、
// スリープ明けの直後（新しい状態を受け取る前）にホストがタブを閉じる
const resumeThenBye = (ids: string[]) => {
  const [host, next, sleeper] = ids;
  const room = readyRoom(ids);
  room.peers[host].engine.dispatch({ type: 'selectGame', gameId: 'counter' });
  room.peers[host].engine.dispatch({ type: 'startGame', online: ids });
  expect(room.sim.clock.runUntil(() => ids.every((id) => stateOf(room.peers[id]).game?.id === 'counter'), 10000)).toBe(true);
  room.peers[sleeper].node.freeze();
  for (let i = 0; i < 20; i++) {
    room.peers[next].engine.dispatch({ type: 'game', action: { type: 'inc' } });
    room.settle(500);
  }
  const countOf = (id: string) => (stateOf(room.peers[id]).game?.state as CounterState).count[next] ?? 0;
  expect(countOf(next)).toBe(20);
  room.peers[sleeper].node.thaw();
  room.peers[sleeper].engine.resume();
  room.peers[host].engine.dispose();
  room.settle(4000);
  return { room, next, sleeper, countOf };
};

describe('QA 最終再確認：接続・復帰直後の端末がホストの bye を受けたとき', () => {
  // 二重ホストでは hostId の小さい方が勝つので、スリープする人の ID が次の候補より大きいと、仮に名乗っても負けて問題が表に出ない
  it('スリープする人の ID が次の候補より大きい部屋では、進行は巻き戻らず次の候補がホストになる', () => {
    const { room, next, sleeper, countOf } = resumeThenBye(['a', 'b', 'c']);
    expect(room.converged([next, sleeper])).toBe(true);
    expect(countOf(next)).toBe(20);
    expect(stateOf(room.peers[next]).hostId).toBe(next);
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-07）
  it.skip('QA-BUG-07: スリープ明け直後の参加者（ID が小さい）がホストの bye を受けても、古い状態で引き継いで進行を巻き戻さない', () => {
    const { room, next, sleeper, countOf } = resumeThenBye(['m', 'n', 'a']);
    expect(room.converged([next, sleeper])).toBe(true);
    // 実際は a が古い状態のまま epoch 2 でホストを名乗り、n の epoch 2 に ID の大小で勝って、n の操作が 20 → 18 に巻き戻る
    expect(countOf(next)).toBe(20);
    expect(stateOf(room.peers[next]).hostId).toBe(next);
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-07）
  it.skip('QA-BUG-07: 参加して 1 秒以内の端末がホストの bye を受けても、自分をホストにせず次の候補（b）に譲る', () => {
    const room = readyRoom(['a', 'b', 'c']);
    const x = room.addPeer('x');
    expect(room.sim.clock.runUntil(() => snap(x).state?.players.some((p) => p.id === 'x') === true, 3000)).toBe(true);
    // x はまだ b・c の hb を聞いていない（hb は 3 秒おき）ので、x から見たオンラインは自分だけ
    room.peers.a.engine.dispose();
    let xClaimed = false;
    for (let t = 0; t < 4000; t += 100) {
      room.settle(100);
      if (snap(x).isHost) xClaimed = true;
    }
    expect(room.converged(['b', 'c', 'x'])).toBe(true);
    // 実際は x が 300ms 以内に epoch 2 でホストを名乗り、全員が x をホストにする（参加順で先の b・c を飛ばす）
    expect(xClaimed).toBe(false);
    expect(stateOf(room.peers.b).hostId).toBe('b');
  });
});
