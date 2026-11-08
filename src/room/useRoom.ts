import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DEFAULT_GAME, GAMES } from '../games/registry';
import { realClock } from '../lib/clock';
import { createTransport } from '../lib/transport';
import { RoomEngine, type EngineSnapshot, type KeyValueStore } from './engine';
import type { RoomHandle } from './types';

// 契約型は types.ts に置き、既存の import（Room.tsx など）のためにここからも再エクスポートする
export type { RoomHandle, RoomStatus, ConnectionStatus } from './types';

// リロード時の復元用スナップショットはタブごと（sessionStorage）。使えない環境でも動作は続ける
const sessionStore: KeyValueStore = {
  get: (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // 保存できなくても続行
    }
  },
};

const noop = () => {};
const noopSubscribe = () => noop;

// 同期処理の中身は RoomEngine（engine.ts）にあり、ここは engine の生成・購読とブラウザイベントの配線だけを行う
export function useRoom(code: string, me: string, name: string, create: boolean): RoomHandle {
  const [engine, setEngine] = useState<RoomEngine | null>(null);

  useEffect(() => {
    const e = new RoomEngine({
      code,
      me,
      name,
      create,
      transport: createTransport(code),
      clock: realClock,
      storage: sessionStore,
      games: GAMES,
      defaultGame: DEFAULT_GAME,
    });
    e.start();
    setEngine(e);

    const onVisible = () => {
      if (document.visibilityState === 'visible') e.resume();
    };
    const onPageShow = () => e.resume();
    const onOnline = () => e.setNetworkOnline(true);
    const onOffline = () => e.setNetworkOnline(false);
    const onPageHide = () => e.pageHide();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pagehide', onPageHide);
      e.dispose();
      setEngine((cur) => (cur === e ? null : cur));
    };
    // 名前の変更では作り直さない（入室時の名前だけを使う。旧実装と同じ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, me, create]);

  // engine ができる前（最初の描画）に返す値。変化しないよう me ごとに固定する
  const initial = useMemo<EngineSnapshot>(
    () => ({ status: 'connecting', connection: 'connecting', state: null, isHost: false, online: new Set([me]) }),
    [me],
  );
  const subscribe = useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : noopSubscribe()), [engine]);
  const getSnapshot = useCallback(() => (engine ? engine.getSnapshot() : initial), [engine, initial]);
  const snap = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo<RoomHandle>(
    () => ({
      status: snap.status,
      connection: snap.connection,
      state: snap.state,
      me,
      isHost: snap.isHost,
      online: snap.online,
      dispatch: engine?.dispatch ?? noop,
      now: engine?.now ?? Date.now,
      leave: engine?.leave ?? noop,
      retry: engine?.retry ?? noop,
    }),
    [snap, me, engine],
  );
}
