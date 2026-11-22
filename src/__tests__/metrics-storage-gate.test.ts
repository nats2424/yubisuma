// R-15：送らない条件に当たる端末では、計測の記録（日付・部屋の記録・入口の印）を端末に書かない。
// 「送らない」に切り替えたら、既にある記録を消す（設定値そのものは残す）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_ID_SET } from '../games/ids';
import {
  doNotTrackWith,
  isMetricsOptedOut,
  metricsAllowedWith,
  OPT_OUT_KEY,
  setMetricsOptOut,
  trackPracticeOver,
  type MetricsEnv,
} from '../lib/analytics';
import { clearMetricsRecords, createEntryMarks, DAY_KEYS, gatedStore, METRICS_KEY_PREFIX, type MetricsStore } from '../lib/metricsStore';
import type { RoomState } from '../room/logic';
import { createRoomMetrics } from '../room/roomMetrics';

const PROD = 'sukima-ee3.pages.dev';

const okEnv = (over: Partial<MetricsEnv> = {}): MetricsEnv => ({
  online: true,
  dev: false,
  mode: 'production',
  websiteId: 'test-website-id',
  prodHost: PROD,
  hostname: () => PROD,
  optedOut: () => false,
  doNotTrack: () => false,
  ...over,
});

const memStore = (): MetricsStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
};

// Web Storage の最小の偽物（length・key・getItem・setItem・removeItem）
const fakeStorage = (init: Record<string, string> = {}): Storage => {
  const data = new Map<string, string>(Object.entries(init));
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
};
const keysOf = (s: Storage): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.key(i) as string);
  return out.sort();
};

const baseState = (hostId: string, playerIds: string[], game: RoomState['game'] = null): RoomState => ({
  code: 'ABCD',
  epoch: 1,
  version: 1,
  hostId,
  players: playerIds.map((id) => ({ id, name: id })),
  selectedGame: 'rush',
  gameOptions: {},
  game,
  chat: [],
  acks: {},
});
const ready = (state: RoomState, isHost: boolean) => ({ status: 'ready' as const, state, isHost });

// ホスト 1 台とゲスト 1 台で、部屋を作る・参加する・ゲームを始める・入口の印を読む、まで進めて、
// 実際のストレージ（その下の mem）に何が書かれたかを返す
const playThrough = (allowed: () => boolean) => {
  const raw = { hostLocal: memStore(), hostSession: memStore(), guestLocal: memStore(), guestSession: memStore() };
  const now = new Date(2026, 10, 22, 12).getTime();
  const hostMarks = createEntryMarks(gatedStore(raw.hostSession, allowed));
  hostMarks.capture('?s=x');
  const guestMarks = createEntryMarks(gatedStore(raw.guestSession, allowed));
  guestMarks.capture('?s=x&via=qr');
  const host = createRoomMetrics({
    create: true,
    me: 'h',
    track: () => {},
    session: gatedStore(raw.hostSession, allowed),
    local: gatedStore(raw.hostLocal, allowed),
    gameIds: GAME_ID_SET,
    src: () => hostMarks.src(),
    takeJoinVia: () => hostMarks.takeJoinVia(),
  });
  const guest = createRoomMetrics({
    create: false,
    me: 'g',
    track: () => {},
    session: gatedStore(raw.guestSession, allowed),
    local: gatedStore(raw.guestLocal, allowed),
    gameIds: GAME_ID_SET,
    src: () => guestMarks.src(),
    takeJoinVia: () => guestMarks.takeJoinVia(),
  });
  const game = { id: 'rush', players: [{ id: 'h', name: 'h' }, { id: 'g', name: 'g' }], state: {}, startedAt: now + 1 };
  host.update(ready(baseState('h', ['h']), true), now);
  host.update(ready(baseState('h', ['h', 'g']), true), now);
  guest.update(ready(baseState('h', ['h', 'g']), false), now);
  host.update(ready(baseState('h', ['h', 'g'], game), true), now + 60_000);
  guest.update(ready(baseState('h', ['h', 'g'], game), false), now + 60_000);
  // 入口の印は読めること（このタブの中では使える）
  expect(hostMarks.src()).toBe('x');
  return raw;
};

describe('R-15 送らない条件では計測の記録を書かない', () => {
  const nav = (n: unknown) => () => doNotTrackWith(() => n, () => ({}));
  const cases: [string, Partial<MetricsEnv>][] = [
    ['「送らない」を選んだ', { optedOut: () => true }],
    ['本番以外のホスト（Preview）', { hostname: () => `abc.${PROD}` }],
    ['localhost', { hostname: () => 'localhost' }],
    ['DNT（navigator.doNotTrack = 1）', { doNotTrack: nav({ doNotTrack: '1' }) }],
    ['GPC', { doNotTrack: nav({ globalPrivacyControl: true }) }],
    ['デモモード', { online: false }],
    ['開発中', { dev: true }],
    ['テスト', { mode: 'test' }],
    ['サイト ID なし', { websiteId: '' }],
    ['判定が例外', { hostname: () => { throw new Error('no location'); } }],
  ];

  it('比較：送る条件がそろっていれば日付・部屋の記録・入口の印を書く', () => {
    const raw = playThrough(() => metricsAllowedWith(okEnv()));
    expect(raw.hostLocal.data.get(DAY_KEYS.host)).toBe('2026-11-22');
    expect(raw.guestLocal.data.get(DAY_KEYS.guest)).toBe('2026-11-22');
    expect(raw.hostSession.data.get('sukima:m:room:ABCD')).toBeTruthy();
    expect(raw.guestSession.data.get('sukima:m:src')).toBe('x');
  });

  for (const [name, over] of cases) {
    it(`${name}：localStorage・sessionStorage に何も書かない`, () => {
      const raw = playThrough(() => metricsAllowedWith(okEnv(over)));
      for (const s of Object.values(raw)) expect([...s.data.keys()]).toEqual([]);
    });
  }

  it('allowed が例外を投げたら書かない。読み出し・削除は通す', () => {
    const raw = memStore();
    raw.set(DAY_KEYS.host, '2026-11-01');
    const g = gatedStore(raw, () => {
      throw new Error('boom');
    });
    g.set(DAY_KEYS.guest, '2026-11-22');
    expect(raw.data.has(DAY_KEYS.guest)).toBe(false);
    expect(g.get(DAY_KEYS.host)).toBe('2026-11-01');
    g.remove(DAY_KEYS.host);
    expect(raw.data.size).toBe(0);
  });

  it('途中で「送らない」に切り替えた後は、部屋の記録を書き足さない', () => {
    let off = false;
    const allowed = () => metricsAllowedWith(okEnv({ optedOut: () => off }));
    const session = memStore();
    const local = memStore();
    const t = createRoomMetrics({
      create: true,
      me: 'h',
      track: () => {},
      session: gatedStore(session, allowed),
      local: gatedStore(local, allowed),
      gameIds: GAME_ID_SET,
      src: () => 'none',
      takeJoinVia: () => 'link',
    });
    t.update(ready(baseState('h', ['h', 'g']), true), 0);
    const before = session.data.get('sukima:m:room:ABCD');
    expect(before).toBeTruthy();
    off = true;
    session.data.clear(); // 切り替えで消えた状態
    const game = { id: 'rush', players: [{ id: 'h', name: 'h' }, { id: 'g', name: 'g' }], state: {}, startedAt: 1 };
    t.update(ready(baseState('h', ['h', 'g'], game), true), 60_000);
    expect(session.data.size).toBe(0);
  });
});

describe('R-15 製品の入口（ブラウザのストレージ）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('trackPracticeOver はテスト実行時（送らない条件）に localStorage へ日付を書かない', () => {
    const ls = fakeStorage();
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('sessionStorage', fakeStorage());
    trackPracticeOver(3, true, new Date(2026, 10, 22, 12).getTime());
    expect(keysOf(ls)).toEqual([]);
  });

  it('「送る」に戻しても記録は消さない。「送らない」に切り替えると計測の記録だけを消し、設定値は残す', () => {
    const ls = fakeStorage({
      [DAY_KEYS.host]: '2026-11-01',
      [DAY_KEYS.guest]: '2026-11-02',
      [DAY_KEYS.practice]: '2026-11-03',
      'sukima:best:rush': '12', // 計測以外のキー（例）は消さない
    });
    const ss = fakeStorage({
      'sukima:m:room:ABCD': '{}',
      'sukima:m:src': 'x',
      'sukima:m:via': 'qr',
      'sukima:name': 'たろう',
    });
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('sessionStorage', ss);

    expect(setMetricsOptOut(false)).toBe(true);
    expect(keysOf(ls)).toContain(DAY_KEYS.host);
    expect(keysOf(ss)).toContain('sukima:m:src');

    expect(setMetricsOptOut(true)).toBe(true);
    expect(isMetricsOptedOut()).toBe(true);
    expect(ls.getItem(OPT_OUT_KEY)).toBe('1');
    expect(keysOf(ls)).toEqual(['sukima:best:rush', OPT_OUT_KEY].sort());
    expect(keysOf(ss)).toEqual(['sukima:name']);
    // 設定値のキーは計測の記録の接頭辞に当たらない（消す対象に入らない）
    expect(OPT_OUT_KEY.startsWith(METRICS_KEY_PREFIX)).toBe(false);
  });

  it('ストレージが使えなくても「送らない」への切り替えは例外を出さない', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => setMetricsOptOut(true)).not.toThrow();
    expect(isMetricsOptedOut()).toBe(true);
  });

  it('clearMetricsRecords は 1 つ消せなくても残りを消す', () => {
    const ls = fakeStorage({ [DAY_KEYS.host]: 'a', [DAY_KEYS.guest]: 'b' });
    const orig = ls.removeItem.bind(ls);
    const s: Pick<Storage, 'length' | 'key' | 'removeItem'> = {
      get length() {
        return ls.length;
      },
      key: (i) => ls.key(i),
      removeItem: (k) => {
        if (k === DAY_KEYS.host) throw new Error('denied');
        orig(k);
      },
    };
    clearMetricsRecords(s);
    expect(keysOf(ls)).toEqual([DAY_KEYS.host]);
  });
});
