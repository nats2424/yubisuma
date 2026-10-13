import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GAMES, DEFAULT_GAME } from '../games/registry';
import { createTransport, type Transport } from '../lib/transport';
import {
  compareStates,
  createRoom,
  pickNextHost,
  reduceRoom,
  takeOverHost,
  type RoomAction,
  type RoomState,
} from './logic';

// 通信メッセージ
type WireMessage =
  | { t: 'state'; from: string; state: RoomState; sentAt: number }
  | { t: 'action'; from: string; action: RoomAction }
  | { t: 'hb'; from: string }
  | { t: 'bye'; from: string };

const HEARTBEAT_MS = 2500;
const OFFLINE_AFTER_MS = 9000;
const HOST_RESYNC_MS = 5000;
const JOIN_TIMEOUT_MS = 8000;
// リロード時、他に誰もいなければ保存しておいた状態から部屋を復元するまでの待ち時間
const RESTORE_AFTER_MS = 3500;

const storageKey = (code: string) => `sukima:room:${code}`;
const saveSnapshot = (s: RoomState) => {
  try {
    sessionStorage.setItem(storageKey(s.code), JSON.stringify(s));
  } catch {
    // 保存できなくても続行
  }
};
const loadSnapshot = (code: string): RoomState | null => {
  try {
    const raw = sessionStorage.getItem(storageKey(code));
    return raw ? (JSON.parse(raw) as RoomState) : null;
  } catch {
    return null;
  }
};

export type RoomStatus = 'connecting' | 'ready' | 'notfound' | 'error' | 'left';

export type RoomHandle = {
  status: RoomStatus;
  state: RoomState | null;
  me: string;
  isHost: boolean;
  online: Set<string>;
  dispatch: (action: RoomAction) => void;
  now: () => number;
  leave: () => void;
};

export function useRoom(code: string, me: string, name: string, create: boolean): RoomHandle {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [online, setOnline] = useState<Set<string>>(() => new Set([me]));

  const stateRef = useRef<RoomState | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const lastSeen = useRef(new Map<string, number>());
  const onlineRef = useRef<Set<string>>(new Set([me]));
  // ルーム共通時計とのずれ（ホスト時刻 - 自分の時刻）。サンプル中の最大値＝遅延最小の推定を使う
  const offsetSamples = useRef<number[]>([]);
  const offset = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftRef = useRef(false);

  const now = useCallback(() => Date.now() + offset.current, []);

  const send = useCallback((msg: WireMessage) => transportRef.current?.send(msg), []);

  const isHostNow = () => stateRef.current?.hostId === me;

  // ゲームのタイマー（ホストのみ）
  const reschedule = useCallback((s: RoomState) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (s.hostId !== me || !s.game) return;
    const scheduled = GAMES[s.game.id]?.schedule?.(s.game.state);
    if (!scheduled) return;
    const delay = Math.max(0, scheduled.at - now());
    timer.current = setTimeout(() => applyAsHost({ type: 'gameSystem', action: scheduled.action }, me), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, now]);

  const commit = useCallback(
    (s: RoomState, broadcast: boolean) => {
      stateRef.current = s;
      setState(s);
      saveSnapshot(s);
      setStatus('ready');
      if (broadcast) send({ t: 'state', from: me, state: s, sentAt: now() });
      reschedule(s);
    },
    [me, now, reschedule, send],
  );

  function applyAsHost(action: RoomAction, by: string) {
    const cur = stateRef.current;
    if (!cur || cur.hostId !== me) return;
    const next = reduceRoom(cur, action, by, now(), GAMES);
    if (next === cur) return;
    commit({ ...next, version: next.version + 1 }, true);
  }

  const dispatch = useCallback(
    (action: RoomAction) => {
      if (isHostNow()) applyAsHost(action, me);
      else send({ t: 'action', from: me, action });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me, send],
  );

  const refreshOnline = useCallback(() => {
    const t = Date.now();
    const ids = new Set<string>([me]);
    lastSeen.current.forEach((seen, id) => {
      if (t - seen < OFFLINE_AFTER_MS) ids.add(id);
    });
    const prev = onlineRef.current;
    const changed = ids.size !== prev.size || [...ids].some((id) => !prev.has(id));
    if (changed) {
      onlineRef.current = ids;
      setOnline(ids);
    }
    return ids;
  }, [me]);

  useEffect(() => {
    const transport = createTransport(code);
    transportRef.current = transport;
    let disposed = false;
    leftRef.current = false;
    const joinedAt = Date.now();

    transport.onMessage((raw) => {
      const msg = raw as WireMessage;
      if (!msg || typeof msg !== 'object' || !('t' in msg) || msg.from === me || leftRef.current) return;
      lastSeen.current.set(msg.from, Date.now());

      switch (msg.t) {
        case 'state': {
          const cur = stateRef.current;
          if (cur && compareStates(msg.state, cur) <= 0) {
            // 自分の方が新しいホスト状態なら上書きし返す
            if (cur.hostId === me && compareStates(cur, msg.state) > 0) {
              send({ t: 'state', from: me, state: cur, sentAt: now() });
            }
            return;
          }
          if (msg.state.hostId === msg.from) {
            if (cur?.hostId !== msg.from) offsetSamples.current = [];
            offsetSamples.current = [...offsetSamples.current, msg.sentAt - Date.now()].slice(-10);
            offset.current = Math.max(...offsetSamples.current);
          }
          commit(msg.state, false);
          if (!msg.state.players.some((p) => p.id === me)) {
            // 自分がいない状態＝追い出された or まだ参加処理前
            if (cur?.players.some((p) => p.id === me)) {
              leftRef.current = true;
              setStatus('left');
            }
            else send({ t: 'action', from: me, action: { type: 'join', name } });
          }
          break;
        }
        case 'action':
          if (isHostNow()) applyAsHost(msg.action, msg.from);
          break;
        case 'hb':
          // 状態を持っていない新規参加者向けにホストは即座に状態を返す
          if (isHostNow() && stateRef.current && !stateRef.current.players.some((p) => p.id === msg.from)) {
            send({ t: 'state', from: me, state: stateRef.current, sentAt: now() });
          }
          break;
        case 'bye':
          lastSeen.current.delete(msg.from);
          refreshOnline();
          break;
      }
    });

    transport.ready
      .then(() => {
        if (disposed) return;
        if (create) {
          commit(createRoom(code, { id: me, name }, DEFAULT_GAME), true);
        } else {
          send({ t: 'action', from: me, action: { type: 'join', name } });
        }
        send({ t: 'hb', from: me });
      })
      .catch(() => !disposed && setStatus('error'));

    let lastResync = Date.now();
    let lastHeartbeat = 0;
    const tick = setInterval(() => {
      if (leftRef.current) return;
      const t = Date.now();
      if (t - lastHeartbeat >= HEARTBEAT_MS) {
        send({ t: 'hb', from: me });
        lastHeartbeat = t;
      }
      const ids = refreshOnline();
      const cur = stateRef.current;

      if (!cur) {
        const snapshot = t - joinedAt > RESTORE_AFTER_MS ? loadSnapshot(code) : null;
        if (snapshot?.players.some((p) => p.id === me)) {
          commit(takeOverHost(snapshot, me, now()), true);
        } else if (t - joinedAt > JOIN_TIMEOUT_MS) setStatus((s) => (s === 'connecting' ? 'notfound' : s));
        else if (t - lastHeartbeat < 1000) send({ t: 'action', from: me, action: { type: 'join', name } });
        return;
      }
      if (cur.hostId === me) {
        if (t - lastResync > HOST_RESYNC_MS) {
          send({ t: 'state', from: me, state: cur, sentAt: now() });
          lastResync = t;
        }
        return;
      }
      // ホストが落ちたら、参加順で最も古いオンラインのメンバーが引き継ぐ
      const hostSeen = lastSeen.current.get(cur.hostId) ?? 0;
      if (t - joinedAt > OFFLINE_AFTER_MS && t - hostSeen > OFFLINE_AFTER_MS && cur.players.some((p) => p.id === me)) {
        if (pickNextHost(cur, ids, cur.hostId) === me) {
          commit(takeOverHost(cur, me, now()), true);
        }
      }
    }, 500);

    const onVisible = () => {
      if (document.visibilityState === 'visible') send({ t: 'hb', from: me });
    };
    const onPageHide = () => send({ t: 'bye', from: me });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      disposed = true;
      clearInterval(tick);
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
      send({ t: 'bye', from: me });
      transport.close();
      transportRef.current = null;
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, me, create]);

  const leave = useCallback(() => {
    const cur = stateRef.current;
    if (cur) {
      if (cur.hostId === me) {
        // ホストが抜ける場合は、オンラインの人にホストを譲ってから抜ける
        const left = reduceRoom(cur, { type: 'leave' }, me, now(), GAMES);
        const nextHost = pickNextHost(left, onlineRef.current, me) ?? left.hostId;
        send({ t: 'state', from: me, state: { ...left, hostId: nextHost, epoch: left.epoch + 1, version: left.version + 1 }, sentAt: now() });
      } else {
        send({ t: 'action', from: me, action: { type: 'leave' } });
      }
    }
    leftRef.current = true;
    if (timer.current) clearTimeout(timer.current);
    setStatus('left');
  }, [me, now, send]);

  const isHost = state?.hostId === me;
  return useMemo(
    () => ({ status, state, me, isHost, online, dispatch, now, leave }),
    [status, state, me, isHost, online, dispatch, now, leave],
  );
}
