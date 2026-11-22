// 部屋の計測の配線（設計 docs/dev/02-architecture.md §14.4・M-B3）。React に依存しない部品で、
// フック（useRoomMetrics.ts）は room の変化をここへ渡すだけ。テストは疑似ネットワークの engine の
// スナップショットを直接渡して確かめる。engine・logic・types には手を入れない（計測を同期の処理から切り離す）
import {
  dayString,
  emptyTally,
  observeRoom,
  parseTally,
  roomCreateEvent,
  roomErrorEvent,
  roomJoinEvent,
  type ErrorKind,
  type JoinVia,
  type MetricEvent,
  type RoomTally,
  type Src,
} from '../lib/metrics';
import { DAY_KEYS, tallyKey, type MetricsStore } from '../lib/metricsStore';
import type { RoomHandle } from './types';

export type RoomMetricsDeps = {
  create: boolean;
  me: string;
  track: (e: MetricEvent) => void;
  session: MetricsStore; // 部屋の記録
  local: MetricsStore; // 最後にホスト／ゲスト参加／ひとり用を遊んだ日
  gameIds: ReadonlySet<string>;
  src: () => Src;
  takeJoinVia: () => JoinVia;
};

export type RoomView = Pick<RoomHandle, 'status' | 'state' | 'isHost'>;

export type RoomMetrics = { update(view: RoomView, now: number): void };

const ERROR_STATUSES: readonly string[] = ['failed', 'notfound', 'full'];

// 注入されたストレージが例外を投げても、「無いもの」として続ける（プライベートモードなど）
const safeStore = (s: MetricsStore): MetricsStore => ({
  get: (k) => {
    try {
      return s.get(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      s.set(k, v);
    } catch {
      // 保存できなくても続ける（数え直すだけ）
    }
  },
  remove: (k) => {
    try {
      s.remove(k);
    } catch {
      // 同上
    }
  },
});

export const createRoomMetrics = (input: RoomMetricsDeps): RoomMetrics => {
  const deps: RoomMetricsDeps = {
    ...input,
    session: safeStore(input.session),
    local: safeStore(input.local),
    src: () => {
      try {
        return input.src();
      } catch {
        return 'none';
      }
    },
    takeJoinVia: () => {
      try {
        return input.takeJoinVia();
      } catch {
        return 'link';
      }
    },
  };
  // 「接続できませんでした」などは同じ画面で 1 回だけ（再試行で何度出ても数えない）
  const errorsSent = new Set<string>();
  let code: string | null = null;
  let tally: RoomTally | null = null;

  const save = (t: RoomTally) => {
    const key = code === null ? null : tallyKey(code);
    if (key) deps.session.set(key, JSON.stringify(t));
  };

  const update = (view: RoomView, now: number) => {
    const { status, state } = view;
    if (ERROR_STATUSES.includes(status)) {
      if (!errorsSent.has(status)) {
        errorsSent.add(status);
        deps.track(roomErrorEvent(status as ErrorKind));
      }
      return;
    }
    if (status === 'left' || status === 'kicked') {
      // 部屋を出たら記録を消す（§14.4 の 4）
      const key = code === null ? null : tallyKey(code);
      if (key) deps.session.remove(key);
      code = null;
      tally = null;
      return;
    }
    if (status !== 'ready' || !state) return;

    if (tally === null || code !== state.code) {
      code = state.code;
      const key = tallyKey(code);
      tally = (key ? parseTally(deps.session.get(key)) : null) ?? emptyTally(null);
    }
    let t = tally;
    const events: MetricEvent[] = [];
    const today = dayString(now);

    // room_create：「部屋を作る」で作った部屋が初めて ready になったとき（自分がホストのとき）
    if (deps.create && t.createdAt === null && view.isHost && state.hostId === deps.me) {
      events.push(
        roomCreateEvent({
          src: deps.src(),
          lastHostDay: deps.local.get(DAY_KEYS.host),
          lastGuestDay: deps.local.get(DAY_KEYS.guest),
          lastPracticeDay: deps.local.get(DAY_KEYS.practice),
          today,
        }),
      );
      deps.local.set(DAY_KEYS.host, today);
      t = { ...t, createdAt: now };
    }

    // room_join：ゲストで初めて自分がメンバーに入ったとき（同じタブ・同じ部屋で 1 回。リロードで数え直さない）
    if (!deps.create && !t.joined && state.hostId !== deps.me && state.players.some((p) => p.id === deps.me)) {
      events.push(roomJoinEvent(deps.takeJoinVia()));
      deps.local.set(DAY_KEYS.guest, today);
      t = { ...t, joined: true };
    }

    const r = observeRoom(t, state, view.isHost, now, deps.gameIds);
    t = r.tally;
    events.push(...r.events);

    if (t !== tally) {
      tally = t;
      save(t);
    }
    for (const e of events) deps.track(e);
  };

  return {
    update(view, now) {
      try {
        update(view, now);
      } catch {
        // 計測の不具合で部屋の画面を止めない
      }
    },
  };
};
