// 部屋の計測のフック（設計 docs/dev/02-architecture.md §14.6・M-B3）。Room.tsx から 1 行で呼ぶ。
// 中身は roomMetrics.ts にあり、ここは製品の送り先・ストレージをつなぎ、room の変化を渡すだけ。
// 送信は useEffect の中だけで行う（描画中・reduce の中では送らない。R-3）
import { useEffect, useRef } from 'react';
import { GAME_ID_SET } from '../games/ids';
import { analytics, entryMarks, metricsLocal, metricsSession } from '../lib/analytics';
import { createRoomMetrics, type RoomMetrics } from './roomMetrics';
import type { RoomHandle } from './types';

export function useRoomMetrics(room: RoomHandle, opts: { create: boolean }): void {
  const tracker = useRef<RoomMetrics | null>(null);
  const { me } = room;
  const { create } = opts;

  useEffect(() => {
    tracker.current = createRoomMetrics({
      create,
      me,
      track: (e) => analytics.track(e, '/r'),
      // 送らない条件に当たる端末では書き込まないストレージ（R-15）
      session: metricsSession,
      local: metricsLocal,
      gameIds: GAME_ID_SET,
      src: () => entryMarks.src(),
      takeJoinVia: () => entryMarks.takeJoinVia(),
    });
    return () => {
      tracker.current = null;
    };
  }, [me, create]);

  useEffect(() => {
    tracker.current?.update({ status: room.status, state: room.state, isHost: room.isHost }, room.now());
  }, [room.status, room.state, room.isHost, room.now, me, create]);
}
