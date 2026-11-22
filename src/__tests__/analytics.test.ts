// 計測の送信（M-B2）と部屋の配線（M-B3）。設計 docs/dev/02-architecture.md §14.5〜§14.7、05 §8。
// 外部へは送らない：送り先はすべて配列に積むだけの偽物。製品の送り先は fetch を数える関数に差し替えて 0 回を確かめる。
// 時刻は注入した値と疑似ネットワークの仮想時計だけを使う
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_IDS, GAME_ID_SET } from '../games/ids';
import {
  createAnalytics,
  createBrowserSink,
  createFetchSink,
  createOptOut,
  doNotTrackWith,
  metricsAllowed,
  metricsAllowedWith,
  RATE_LIMIT,
  type AnalyticsDeps,
  type MetricsEnv,
  type Payload,
} from '../lib/analytics';
import { emptyTally, type MetricEvent } from '../lib/metrics';
import { createEntryMarks, DAY_KEYS, type MetricsStore } from '../lib/metricsStore';
import type { RoomState } from '../room/logic';
import { createRoomMetrics, type RoomMetricsDeps } from '../room/roomMetrics';
import { createSimRoom, type SimPeer } from './sim/harness';

const PROD = 'sukima-ee3.pages.dev';

const fakeDeps = (over: Partial<AnalyticsDeps> = {}) => {
  const sent: Payload[] = [];
  let now = 1_000_000;
  const deps: AnalyticsDeps = {
    sink: (p) => sent.push(p),
    websiteId: 'test-website-id',
    enabled: () => true,
    now: () => now,
    gameIds: GAME_ID_SET,
    version: '0.1.0',
    env: { hostname: PROD, language: 'ja-JP', screen: '390x844' },
    ...over,
  };
  return { sent, deps, a: createAnalytics(deps), advance: (ms: number) => (now += ms) };
};

const gameStart: MetricEvent = { name: 'game_start', data: { game: 'rush', n: 3, seq: 1 } };

const memStore = (): MetricsStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
};
const throwingStore: MetricsStore = {
  get: () => {
    throw new Error('denied');
  },
  set: () => {
    throw new Error('denied');
  },
  remove: () => {
    throw new Error('denied');
  },
};

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

// 未処理の Promise の拒否は、マイクロタスクが空になった後に通知される。待つのは「次のマクロタスク」までで、時間には依存しない
const flushMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
type Proc = { on(ev: string, f: (r: unknown) => void): void; off(ev: string, f: (r: unknown) => void): void };
const proc = (globalThis as unknown as { process: Proc }).process;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('① 送らない条件（§14.5 の 1〜6。送るたびに判定）', () => {
  it('条件がそろったときだけ送る', () => {
    expect(metricsAllowedWith(okEnv())).toBe(true);
  });

  it('どれか 1 つでも当たれば送らない', () => {
    const cases: Partial<MetricsEnv>[] = [
      { online: false }, // デモモード
      { dev: true },
      { mode: 'test' },
      { websiteId: '' },
      { websiteId: '   ' },
      { hostname: () => `abc.${PROD}` }, // Preview
      { hostname: () => 'localhost' },
      { hostname: () => `${PROD}.evil.com` },
      { hostname: () => '127.0.0.1' },
      { hostname: () => PROD.toUpperCase() },
      { prodHost: '' },
      {
        hostname: () => {
          throw new Error('no location');
        },
      },
      { optedOut: () => true },
      { doNotTrack: () => true },
    ];
    for (const c of cases) {
      const { a, sent } = fakeDeps({ enabled: () => metricsAllowedWith(okEnv(c)) });
      a.pageview('/');
      a.track(gameStart, '/r');
      expect(sent).toHaveLength(0);
    }
  });

  it('「追跡しない」：DNT の 1・yes、window.doNotTrack、GPC、navigator が無い・例外', () => {
    const win = {};
    expect(doNotTrackWith(() => ({}), () => win)).toBe(false);
    expect(doNotTrackWith(() => ({ doNotTrack: '0' }), () => win)).toBe(false);
    expect(doNotTrackWith(() => ({ doNotTrack: 'unspecified' }), () => win)).toBe(false);
    expect(doNotTrackWith(() => ({ doNotTrack: '1' }), () => win)).toBe(true);
    expect(doNotTrackWith(() => ({ doNotTrack: 'yes' }), () => win)).toBe(true);
    expect(doNotTrackWith(() => ({}), () => ({ doNotTrack: '1' }))).toBe(true);
    expect(doNotTrackWith(() => ({ globalPrivacyControl: true }), () => win)).toBe(true);
    expect(doNotTrackWith(() => undefined, () => win)).toBe(true);
    expect(
      doNotTrackWith(
        () => {
          throw new Error('x');
        },
        () => win,
      ),
    ).toBe(true);
    const trap = Object.defineProperty({}, 'doNotTrack', {
      get() {
        throw new Error('x');
      },
    });
    expect(doNotTrackWith(() => trap, () => win)).toBe(true);
  });

  it('「送らない」の設定：押した直後から止まり、保存に失敗しても止まったまま。壊れた値は送らない側', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const o = createOptOut(() => storage);
    expect(o.isOff()).toBe(false);
    const { a, sent } = fakeDeps({ enabled: () => metricsAllowedWith(okEnv({ optedOut: () => o.isOff() })) });
    a.pageview('/');
    expect(o.set(true)).toBe(true);
    a.pageview('/');
    expect(sent).toHaveLength(1);
    expect(data.get('sukima:metrics:off')).toBe('1');
    // 別のタブ（モジュール変数なし）でも保存値で止まる
    expect(createOptOut(() => storage).isOff()).toBe(true);
    data.set('sukima:metrics:off', '0');
    expect(createOptOut(() => storage).isOff()).toBe(false);
    for (const broken of ['abc', 'true', '', '2']) {
      data.set('sukima:metrics:off', broken);
      expect(createOptOut(() => storage).isOff()).toBe(true);
    }

    // 保存が例外を投げる（プライベートモードなど）
    const failing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const f = createOptOut(() => failing);
    expect(f.isOff()).toBe(true); // 読めないときは送らない側
    expect(f.set(true)).toBe(false);
    expect(f.isOff()).toBe(true);
    // 保存できなくても、このタブで選んだ値を保つ
    expect(f.set(false)).toBe(false);
    expect(f.isOff()).toBe(false);
  });

  it('テストの実行時の製品の判定は常に偽（MODE === test）', () => {
    expect(metricsAllowed()).toBe(false);
  });
});

describe('② 送りすぎの止め', () => {
  it('1 時間に 60 件まで。61 件目を捨て、1 時間たてば再び送る', () => {
    const { a, sent, advance } = fakeDeps();
    for (let i = 0; i < RATE_LIMIT.count + 1; i++) a.track(gameStart, '/r');
    expect(sent).toHaveLength(60);
    advance(RATE_LIMIT.windowMs - 1);
    a.pageview('/');
    expect(sent).toHaveLength(60);
    advance(1);
    a.pageview('/');
    expect(sent).toHaveLength(61);
  });
});

describe('③ 失敗を漏らさない', () => {
  it('sink が例外を投げても呼び出し側に漏れない', () => {
    const { a } = fakeDeps({
      sink: () => {
        throw new Error('boom');
      },
    });
    expect(() => a.pageview('/')).not.toThrow();
    expect(() => a.track(gameStart, '/r')).not.toThrow();
    const b = fakeDeps({
      enabled: () => {
        throw new Error('boom');
      },
      now: () => {
        throw new Error('boom');
      },
    });
    expect(() => b.a.track(gameStart, '/r')).not.toThrow();
  });

  it('fetch の拒否・同期の例外・JSON にできない値が、呼び出し側にも未処理の Promise にも漏れない', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    proc.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const rejecting = createFetchSink(() => () => {
        calls++;
        return Promise.reject(new Error('network'));
      });
      const throwing = createFetchSink(() => () => {
        throw new Error('sync');
      });
      const { a } = fakeDeps({ sink: rejecting });
      a.pageview('/');
      a.track(gameStart, '/r');
      expect(calls).toBe(2);
      expect(() => throwing({ type: 'event', payload: { website: 'x', hostname: PROD, url: '/', referrer: '', language: '', screen: '', title: 'SUKIMA' } })).not.toThrow();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => rejecting(cyclic as unknown as Payload)).not.toThrow();
      expect(() => createFetchSink(() => undefined)(cyclic as unknown as Payload)).not.toThrow();
      await flushMacrotask();
      await flushMacrotask();
      expect(unhandled).toEqual([]);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('⑤ 製品の送り先はテストの実行時に fetch を呼ばない', () => {
  it('globalThis.fetch を数える関数に差し替えて 0 回', () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(''));
    }) as typeof fetch;
    const sink = createBrowserSink();
    const { a } = fakeDeps({ sink });
    for (let i = 0; i < 5; i++) {
      a.pageview('/');
      a.track(gameStart, '/r');
    }
    sink({ type: 'event', payload: { website: 'x', hostname: PROD, url: '/', referrer: '', language: '', screen: '', title: 'SUKIMA' } });
    expect(calls).toBe(0);
  });
});

describe('⑥ 二段目の検査（R-4）', () => {
  it('表にないキー・51 文字以上の文字列・一覧にない game・オブジェクトの値・範囲外の数は送らない', () => {
    const { a, sent } = fakeDeps();
    const bad: unknown[] = [
      { name: 'game_start', data: { game: 'rush', n: 3, seq: 1, name: '山田' } },
      { name: 'game_start', data: { game: 'x'.repeat(51), n: 3, seq: 1 } },
      { name: 'game_start', data: { game: 'counter', n: 3, seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: { v: 3 }, seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: 11, seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: 3, seq: 6 } },
      { name: 'game_start', data: { game: 'rush', n: 3 } },
      { name: 'game_start', data: { game: 'rush', n: 3, seq: 1, wait: '1h' } },
      { name: 'room_enjoyed', data: { peak: 2, game: 'rush' } },
      { name: 'room_join', data: { via: ['qr'] } },
      { name: 'room_create', data: { src: 'stream', rehost: '7d', was_guest: 'yes', after_practice: false } },
      { name: 'rules_open', data: { game: '__proto__' } },
      { name: 'unknown_event', data: {} },
      { name: '__proto__', data: {} },
      { name: 'room_error', data: null },
      { name: 'room_error', data: ['failed'] },
      null,
      'room_error',
    ];
    for (const e of bad) a.track(e as MetricEvent, '/r');
    expect(sent).toHaveLength(0);
    // url・referrer も許可した形だけ
    for (const url of ['/r/SIMR', '#/r/SIMR', '/?s=<script>', '/r?s=stream&via=qr', 'https://evil', '']) {
      a.pageview(url);
      a.track(gameStart, url);
    }
    a.pageview('/', 'https://taro-yamada.github.io');
    a.pageview('/', 'other');
    expect(sent).toHaveLength(0);
    // 正しいものは送る
    a.track({ name: 'game_start', data: { game: 'rush', n: 3, seq: 1, wait: '0-1' } }, '/r');
    a.pageview('/practice?s=stream', 'https://google.com');
    expect(sent).toHaveLength(2);
  });
});

describe('⑦⑧ 送信内容の形', () => {
  it('hostname は常に固定値、referrer は固定の URL か空、title は SUKIMA。data に mode と v が付く', () => {
    const { a, sent } = fakeDeps();
    a.pageview('/r', 'https://other.invalid');
    a.track(gameStart, '/r');
    expect(sent[0]).toEqual({
      type: 'event',
      payload: { website: 'test-website-id', hostname: PROD, url: '/r', referrer: 'https://other.invalid', language: 'ja-JP', screen: '390x844', title: 'SUKIMA' },
    });
    expect(sent[1].payload).toMatchObject({ hostname: PROD, referrer: '', name: 'game_start', data: { game: 'rush', n: 3, seq: 1, mode: 'online', v: '0.1.0' } });
  });

  it('偽の fetch がトークン入りの応答を返しても、応答を読まず、次の送信が同じ形', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reads: string[] = [];
    // 応答のどの項目に触れたかを数える（Promise の解決で見られる then だけは除く）
    const response = new Proxy(
      { ok: true, headers: { 'x-umami-cache': 'TOKEN' }, json: async () => ({ cache: 'TOKEN' }), text: async () => 'TOKEN' },
      {
        get(target, key, recv) {
          if (key !== 'then') reads.push(String(key));
          return Reflect.get(target, key, recv);
        },
      },
    );
    const sink = createFetchSink(() => (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response);
    });
    const { a } = fakeDeps({ sink });
    a.track(gameStart, '/r');
    await flushMacrotask();
    a.track(gameStart, '/r');
    await flushMacrotask();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0].url).toBe('https://gateway.umami.is/api/send');
    expect(calls[0].init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' } });
    expect(String(calls[0].init.body)).not.toContain('TOKEN');
    expect(reads).toEqual([]);
  });
});

// ---- 部屋の配線（M-B3）と、疑似ネットワークでの漏えい確認（M-B2 ④） ----

const SIM_IDS = new Set([...GAME_IDS, 'counter']);

type Device = { session: MetricsStore; local: MetricsStore; tracker: ReturnType<typeof createRoomMetrics>; deps: RoomMetricsDeps };

const makeDevice = (
  me: string,
  create: boolean,
  track: (e: MetricEvent) => void,
  stores: { session?: MetricsStore; local?: MetricsStore } = {},
): Device => {
  const session = stores.session ?? memStore();
  const local = stores.local ?? memStore();
  const marks = createEntryMarks(session);
  const deps: RoomMetricsDeps = {
    create,
    me,
    track,
    session,
    local,
    gameIds: SIM_IDS,
    src: () => marks.src(),
    takeJoinVia: () => marks.takeJoinVia(),
  };
  return { session, local, deps, tracker: createRoomMetrics(deps) };
};

describe('④ 漏えい：名前・チャット・部屋コード・プレイヤー ID が、全端末・全イベントの送信内容に現れない', () => {
  it('4 人の部屋で 5 ゲーム・ホスト交代 1 回・再接続 1 回・リロード 1 回', () => {
    const ids = ['p_host01', 'p_guest2', 'p_guest3', 'p_guest4'];
    const room = createSimRoom({ ids, seed: 3 });
    const sent: Payload[] = [];
    const devices: Record<string, Device> = {};
    const analyticsOf: Record<string, ReturnType<typeof createAnalytics>> = {};
    for (const [i, id] of ids.entries()) {
      // 端末ごとに送信の部品を持つ（本番と同じく 1 タブに 1 つ）
      const a = createAnalytics({ ...fakeDeps().deps, sink: (p) => sent.push(p), now: () => room.sim.clock.now(), gameIds: SIM_IDS });
      analyticsOf[id] = a;
      devices[id] = makeDevice(id, i === 0, (e) => a.track(e, '/r'));
      a.pageview('/r', '');
    }
    devices.p_guest2.deps.src = () => 'stream';
    const feed = () => {
      for (const id of ids) {
        const p: SimPeer = room.peers[id];
        devices[id].tracker.update(p.engine.getSnapshot(), p.engine.now());
      }
    };
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        room.settle(100);
        feed();
      }
    };
    const hostOf = () => room.peers.p_guest2.engine.getSnapshot().state!.hostId;
    const startGame = () => {
      const host = room.peers[hostOf()];
      host.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
      host.engine.dispatch({ type: 'startGame', online: [...host.engine.getSnapshot().online] });
      run(2000);
    };

    run(10_000);
    // 名前を本名らしく変え、チャットに目印を入れる
    const secretNames = ['山田太郎', '佐藤花子', '鈴木一郎', 'Tanaka'];
    ids.forEach((id, i) => room.peers[id].engine.dispatch({ type: 'join', name: secretNames[i] }));
    room.peers.p_guest3.engine.dispatch({ type: 'chat', text: 'ひみつの合言葉 090-1234-5678' });
    run(2000);
    expect(room.peers.p_host01.engine.getSnapshot().state!.chat.some((c) => c.text.includes('ひみつ'))).toBe(true);

    startGame();
    startGame();
    // ホストが落ちて引き継ぎ
    room.peers.p_host01.node.freeze();
    run(20_000);
    expect(hostOf()).not.toBe('p_host01');
    startGame();
    // 再接続
    room.peers.p_guest3.node.disconnect();
    run(2000);
    room.peers.p_guest3.node.restore();
    run(5000);
    // リロード（同じ sessionStorage・localStorage で作り直す）
    room.peers.p_guest4.reload();
    const d4 = devices.p_guest4;
    devices.p_guest4 = makeDevice('p_guest4', false, d4.deps.track, { session: d4.session, local: d4.local });
    run(5000);
    startGame();
    startGame();

    const names = sent.map((p) => p.payload.name).filter(Boolean);
    expect(names.filter((n) => n === 'room_create')).toHaveLength(1);
    expect(names.filter((n) => n === 'room_join')).toHaveLength(3); // リロードで数え直さない
    expect(names.filter((n) => n === 'room_enjoyed')).toHaveLength(1);
    const seqs = sent.filter((p) => p.payload.name === 'game_start').map((p) => p.payload.data!.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const all = JSON.stringify(sent);
    for (const secret of ['SIMR', 'simr', ...ids, ...ids.map((i) => i.toUpperCase()), ...secretNames, 'ひみつ', '090-1234']) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/p_/i);
    // 端末の中に置いた日付も送らない
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // 送ったキーは表のものだけ
    for (const p of sent) {
      expect(Object.keys(p.payload).sort()).toEqual(
        p.payload.name ? ['data', 'hostname', 'language', 'name', 'referrer', 'screen', 'title', 'url', 'website'] : ['hostname', 'language', 'referrer', 'screen', 'title', 'url', 'website'],
      );
      expect(p.payload.url).toBe('/r');
    }
  });
});

describe('部屋の配線（M-B3）', () => {
  const ready = (state: RoomState, isHost: boolean) => ({ status: 'ready' as const, state, isHost });
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

  it('room_create は作った部屋が初めて ready になったとき 1 回。区分けは端末の日付から作り、日付を更新する', () => {
    const events: MetricEvent[] = [];
    const d = makeDevice('h', true, (e) => events.push(e));
    const now = new Date(2026, 10, 22, 12).getTime();
    d.local.set(DAY_KEYS.host, '2026-11-01');
    d.local.set(DAY_KEYS.practice, '2026-11-20');
    d.tracker.update({ status: 'connecting', state: null, isHost: false }, now);
    d.tracker.update(ready(baseState('h', ['h']), true), now);
    d.tracker.update(ready(baseState('h', ['h', 'g']), true), now);
    expect(events).toEqual([{ name: 'room_create', data: { src: 'none', rehost: '28d', was_guest: false, after_practice: true } }]);
    expect(d.local.get(DAY_KEYS.host)).toBe('2026-11-22');
    // 作ってから 2 分後の最初のゲームに wait が付く
    d.tracker.update(ready(baseState('h', ['h', 'g'], { id: 'rush', players: [], state: {}, startedAt: now }), true), now + 120_000);
    expect(events).toHaveLength(1); // 0 人のゲームは数えない
    const g = { id: 'rush', players: [{ id: 'h', name: 'h' }, { id: 'g', name: 'g' }], state: {}, startedAt: now + 1 };
    d.tracker.update(ready(baseState('h', ['h', 'g'], g), true), now + 120_000);
    expect(events[1]).toEqual({ name: 'game_start', data: { game: 'rush', n: 2, seq: 1, wait: '1-3' } });
  });

  it('room_join はゲストで初めてメンバーに入ったとき 1 回。room_error は種類ごとに 1 回。退出で記録を消す', () => {
    const events: MetricEvent[] = [];
    const d = makeDevice('g', false, (e) => events.push(e));
    d.tracker.update({ status: 'failed', state: null, isHost: false }, 0);
    d.tracker.update({ status: 'failed', state: null, isHost: false }, 0);
    d.tracker.update({ status: 'connecting', state: null, isHost: false }, 0);
    d.tracker.update({ status: 'notfound', state: null, isHost: false }, 0);
    d.tracker.update(ready(baseState('h', ['h']), false), 0); // まだメンバーでない
    d.tracker.update(ready(baseState('h', ['h', 'g']), false), 0);
    d.tracker.update(ready(baseState('h', ['h', 'g']), false), 0);
    expect(events).toEqual([
      { name: 'room_error', data: { kind: 'failed' } },
      { name: 'room_error', data: { kind: 'notfound' } },
      { name: 'room_join', data: { via: 'link' } },
    ]);
    expect(d.local.get(DAY_KEYS.guest)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.session.get('sukima:m:room:ABCD')).not.toBe(null);
    d.tracker.update({ status: 'left', state: null, isHost: false }, 0);
    expect(d.session.get('sukima:m:room:ABCD')).toBe(null);
  });

  it('ストレージが使えない・壊れた値でも例外を出さず、送るのは区分けだけ', () => {
    const events: MetricEvent[] = [];
    const d = makeDevice('h', true, (e) => events.push(e), { session: throwingStore, local: throwingStore });
    expect(() => {
      d.tracker.update(ready(baseState('h', ['h']), true), 0);
      d.tracker.update({ status: 'left', state: null, isHost: false }, 0);
    }).not.toThrow();
    expect(events.map((e) => e.name)).toEqual(['room_create']);

    const session = memStore();
    const local = memStore();
    session.set('sukima:m:room:ABCD', '{"__proto__":{"enjoyed":true}}');
    local.set(DAY_KEYS.host, 'x'.repeat(100_000));
    local.set(DAY_KEYS.guest, '9999-99-99');
    const got: MetricEvent[] = [];
    const e = makeDevice('h', true, (ev) => got.push(ev), { session, local });
    e.tracker.update(ready(baseState('h', ['h']), true), 0);
    expect(got).toEqual([{ name: 'room_create', data: { src: 'none', rehost: 'no', was_guest: false, after_practice: false } }]);
    // 壊れた記録は数え直して上書きする
    expect(JSON.parse(session.get('sukima:m:room:ABCD')!)).toMatchObject({ ...emptyTally(0), createdAt: 0 });
  });

  it('track が例外を投げても部屋の画面に漏れない', () => {
    const d = makeDevice('h', true, () => {
      throw new Error('boom');
    });
    expect(() => d.tracker.update(ready(baseState('h', ['h']), true), 0)).not.toThrow();
  });
});
