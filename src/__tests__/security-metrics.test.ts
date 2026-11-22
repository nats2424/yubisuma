// Security：最小計測の実装後レビュー（docs/dev/02-architecture.md §14.8、docs/dev/05-security-report.md §8.4）。
// 外部へは送らない：送り先（sink）はすべて配列に積むだけの偽物で、製品の fetch は数える関数に差し替える（0 回）。
// 時刻は注入した値と疑似ネットワークの仮想時計だけを使い、実時間・Date.now()・偽タイマーは使わない。
// 攻撃者は「部屋のコードを知っていて、任意の JSON を任意の from で送れる端末」（security-engine.test.ts と同じ）
import { afterEach, describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import { GAME_IDS, GAME_ID_SET } from '../games/ids';
import {
  createAnalytics,
  createBrowserSink,
  createFetchSink,
  createOptOut,
  doNotTrackWith,
  isAllowedUrl,
  metricsAllowed,
  metricsAllowedWith,
  RATE_LIMIT,
  UMAMI_ENDPOINT,
  type AnalyticsDeps,
  type MetricsEnv,
  type Payload,
} from '../lib/analytics';
import { pageUrl, parseTally, referrerName, referrerUrl, REFERRER_URLS, routePath, type MetricEvent } from '../lib/metrics';
import { createEntryMarks, DAY_KEYS, type MetricsStore } from '../lib/metricsStore';
import type { Link } from '../lib/transport';
import { ROOM_TIMINGS } from '../room/engine';
import type { RoomState } from '../room/logic';
import { createRoomMetrics, type RoomMetrics } from '../room/roomMetrics';
import { createSimRoom, ROOM_CODE } from './sim/harness';

const PROD = 'sukima-ee3.pages.dev';
// 疑似ネットワークのテスト用ゲーム（counter）も「登録済み」として扱う一覧
const SIM_IDS: ReadonlySet<string> = new Set([...GAME_IDS, 'counter']);

const memStore = (): MetricsStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
};

const makeAnalytics = (over: Partial<AnalyticsDeps> = {}) => {
  const sent: Payload[] = [];
  let now = 1_000_000;
  const a = createAnalytics({
    sink: (p) => sent.push(p),
    websiteId: 'test-website-id',
    enabled: () => true,
    now: () => now,
    gameIds: GAME_ID_SET,
    version: '0.1.0',
    env: { hostname: PROD, language: 'ja-JP', screen: '390x844' },
    ...over,
  });
  return { a, sent, advance: (ms: number) => (now += ms) };
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

const gameStart: MetricEvent = { name: 'game_start', data: { game: 'rush', n: 3, seq: 1 } };

// 端末 1 台分の「部屋の計測」と送信の部品（本番の useRoomMetrics と同じく url は '/r'）
const device = (me: string, create: boolean, sent: Payload[], now: () => number, gameIds = SIM_IDS) => {
  const a = createAnalytics({
    sink: (p) => sent.push(p),
    websiteId: 'w',
    enabled: () => true,
    now,
    gameIds,
    version: '0.1.0',
    env: { hostname: PROD, language: 'ja', screen: '1x1' },
  });
  const session = memStore();
  const local = memStore();
  const tracker: RoomMetrics = createRoomMetrics({
    create,
    me,
    track: (e) => a.track(e, '/r'),
    session,
    local,
    gameIds,
    src: () => 'none',
    takeJoinVia: () => 'link',
  });
  return { a, tracker, session, local };
};

// 全員が入った部屋に攻撃者の Link を 1 本つなぎ、全端末の計測を仮想時計で回す
const attackedMeteredRoom = (ids = ['a', 'b', 'c'], gameIds = SIM_IDS) => {
  const room = createSimRoom({ ids });
  const sent: Payload[] = [];
  const devices = Object.fromEntries(ids.map((id, i) => [id, device(id, i === 0, sent, () => room.sim.clock.now(), gameIds)]));
  const feed = () => {
    for (const id of ids) {
      const p = room.peers[id];
      devices[id].tracker.update(p.engine.getSnapshot(), p.engine.now());
    }
  };
  const run = (ms: number, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      room.settle(step);
      feed();
    }
  };
  run(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  const link: Link = room.sim.node('evil').linkFactory(ROOM_CODE, { onOpen: () => {}, onDown: () => {}, onMessage: () => {} });
  run(200);
  const send = (msg: Record<string, unknown>) => link.send({ v: 2, ...msg });
  const stateOf = (id: string) => room.peers[id].engine.getSnapshot().state as RoomState;
  return { room, sent, devices, run, send, stateOf };
};

const namesOf = (sent: Payload[]) => sent.map((p) => p.payload.name).filter((n): n is string => !!n);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('M-1: 部屋の他人に、ホストの端末から任意の値を送らせない', () => {
  it('M-1: 偽の状態の game.id（一覧にない文字列）を受けたホストは、その文字列を送らない', () => {
    const { sent, send, run, stateOf } = attackedMeteredRoom();
    const cur = stateOf('a');
    const secret = '山田太郎 090-xxxx';
    // b をホストにし、登録にないゲーム ID のゲームが始まったことにする（R-02 で誰でも送れる）
    send({
      t: 'state',
      from: 'evil',
      state: { ...cur, epoch: cur.epoch + 1, hostId: 'b', game: { id: secret, players: cur.players, state: {}, startedAt: 12_345 } },
      sentAt: 0,
    });
    run(500, 50);
    // 一段目：engine が登録にないゲームの状態を採用しない（SEC-04 の対策）
    expect(stateOf('b').hostId).toBe('a');
    // 二段目：engine を通らずに（版ずれ・将来の不具合で）同じ状態が計測に届いても送らない
    const d = device('b', false, sent, () => 0, GAME_ID_SET);
    const forged = { ...cur, hostId: 'b', game: { id: secret, players: cur.players, state: {}, startedAt: 12_345 } };
    d.tracker.update({ status: 'ready', state: forged, isHost: true }, 0);
    d.tracker.update({ status: 'ready', state: { ...forged, game: { ...forged.game, startedAt: 12_346 } }, isHost: true }, 0);
    expect(JSON.stringify(sent)).not.toContain('山田');
    for (const p of sent) {
      const g = p.payload.data?.game;
      if (g !== undefined) expect(GAME_ID_SET.has(String(g))).toBe(true);
    }
    expect(namesOf(sent).filter((n) => n === 'game_start' || n === 'room_enjoyed')).toEqual([]);
  });

  it('M-1: 偽の状態の人数（0・11・小数・負）で n / peak が 1〜10 の整数に収まる', () => {
    // (1) parse を通る範囲：game.players を 0 人・11 人にした状態を疑似ネットワークで送る
    const { sent, send, run, stateOf } = attackedMeteredRoom();
    const cur = stateOf('a');
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, name: `X${i}` }));
    let v = cur.version;
    for (const [i, ps] of [[], many].entries()) {
      v += 100;
      send({ t: 'state', from: 'evil', state: { ...cur, epoch: cur.epoch + 1, version: v, hostId: 'b', game: { id: 'rush', players: ps, state: {}, startedAt: 50_000 + i } }, sentAt: 0 });
      run(300, 50);
    }
    // (2) observeRoom に直接：players を配列でないもの・小数長に見せかけるものを渡す
    const direct: Payload[] = [];
    const d = device('h', false, direct, () => 0, GAME_ID_SET);
    const base = { ...cur, hostId: 'h' };
    const weird: unknown[] = [{ length: 3.5 }, { length: -1 }, 'abc', null, Array.from({ length: 11 })];
    weird.forEach((players, i) => {
      d.tracker.update({ status: 'ready', state: { ...base, game: { id: 'rush', players, state: {}, startedAt: 9_000 + i } } as unknown as RoomState, isHost: true }, 0);
    });
    for (const p of [...sent, ...direct]) {
      for (const k of ['n', 'peak'] as const) {
        const x = p.payload.data?.[k];
        if (x !== undefined) {
          expect(Number.isInteger(x)).toBe(true);
          expect(x as number).toBeGreaterThanOrEqual(1);
          expect(x as number).toBeLessThanOrEqual(10);
        }
      }
    }
    expect(namesOf(direct)).toEqual([]);
  });

  it('M-1: startedAt だけ変えた偽の状態の連打で、game_start は 1 時間 60 件を超えず、room_enjoyed は 1 部屋 1 回', () => {
    const { sent, send, run, stateOf } = attackedMeteredRoom();
    const cur = stateOf('a');
    for (let i = 0; i < 500; i++) {
      send({
        t: 'state',
        from: 'evil',
        state: { ...cur, epoch: cur.epoch + 1, version: cur.version + 1000 * (i + 1), hostId: 'b', game: { id: 'rush', players: cur.players, state: {}, startedAt: 100_000 + i } },
        sentAt: 0,
      });
      run(20, 20);
    }
    const names = namesOf(sent);
    const starts = names.filter((n) => n === 'game_start').length;
    // 攻撃は効いている（被害者の端末から送らせられる：許容リスク R-09）が、上限で止まる
    expect(starts).toBeGreaterThan(1);
    expect(starts).toBeLessThanOrEqual(30);
    expect(sent.length).toBeLessThanOrEqual(RATE_LIMIT.count * 3); // 3 端末それぞれ 1 時間 60 件まで
    expect(names.filter((n) => n === 'room_enjoyed').length).toBeLessThanOrEqual(1);
    // 1 タブの上限そのもの：500 件呼んでも 60 件
    const { a, sent: one } = makeAnalytics();
    for (let i = 0; i < 500; i++) a.track(gameStart, '/r');
    expect(one).toHaveLength(RATE_LIMIT.count);
  });
});

describe('漏えい', () => {
  it('漏えい: 名前・チャット・部屋コード・プレイヤー ID が、全端末・全イベントの送信内容に現れない', () => {
    const ids = ['p_host01', 'p_guest2', 'p_guest3', 'p_guest4'];
    const { room, sent, send, run, stateOf } = attackedMeteredRoom(ids);
    const secretNames = ['山田太郎', '佐藤花子', '鈴木一郎', 'Tanaka'];
    ids.forEach((id, i) => room.peers[id].engine.dispatch({ type: 'join', name: secretNames[i] }));
    room.peers.p_guest3.engine.dispatch({ type: 'chat', text: 'ひみつの合言葉 090-1234-5678' });
    run(2000);
    const hostOf = () => stateOf('p_guest2').hostId;
    const startGame = () => {
      const host = room.peers[hostOf()];
      host.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
      host.engine.dispatch({ type: 'startGame', online: [...host.engine.getSnapshot().online] });
      run(2000);
    };
    startGame();
    startGame();
    room.peers.p_host01.node.freeze();
    run(20_000);
    expect(hostOf()).not.toBe('p_host01');
    startGame();
    room.peers.p_guest3.node.disconnect();
    run(2000);
    room.peers.p_guest3.node.restore();
    run(5000);
    startGame();
    // 攻撃者が、名前を game.id に入れた偽の状態で p_guest4 をホストにする
    const cur = stateOf('p_guest2');
    send({ t: 'state', from: 'evil', state: { ...cur, epoch: cur.epoch + 1, hostId: 'p_guest4', game: { id: '鈴木一郎', players: cur.players, state: {}, startedAt: 777 } }, sentAt: 0 });
    run(1000);
    startGame();

    expect(namesOf(sent).filter((n) => n === 'game_start').length).toBeGreaterThanOrEqual(4);
    const all = JSON.stringify(sent);
    for (const s of [ROOM_CODE, ROOM_CODE.toLowerCase(), ...ids, ...secretNames, 'ひみつ', '090-1234', 'evil']) {
      expect(all).not.toContain(s);
    }
    expect(all).not.toMatch(/p_/i);
    expect(all).not.toMatch(/#/);
  });

  it('漏えい: url は /・/practice・/r と許可した印だけ', () => {
    const hashes = ['#/r/ABCD', '#/r/ABCD?x=1', '#/privacy', '#/privacy/x', '#/../', `#/${'A'.repeat(100_000)}`, '', '#/practice?code=ABCD', '#/r/'];
    const searches = ['?s=<script>alert(1)</script>', '?s=stream&via=qr&utm_source=x', '?s=x', '', '?s=', '?via=qr', '?s=%00'];
    const urls: string[] = [];
    for (const search of searches) {
      const marks = createEntryMarks(memStore());
      marks.capture(search);
      for (const hash of hashes) {
        const { a, sent } = makeAnalytics();
        const path = routePath(hash);
        if (hash.startsWith('#/privacy')) expect(path).toBeNull(); // R-9：説明の画面は数えない
        if (path === null) continue;
        a.pageview(pageUrl(path, marks.src()), '');
        expect(sent).toHaveLength(1);
        urls.push(sent[0].payload.url);
      }
    }
    for (const u of urls) expect(u).toMatch(/^\/(practice|r)?(\?s=(stream|x|tiktok|guide|other))?$/);
    expect(JSON.stringify(urls)).not.toMatch(/ABCD|script|utm|via|AAAA/);
    // 二段目：許可外の url を直接渡しても送らない
    const { a, sent } = makeAnalytics();
    for (const u of ['/r/ABCD', '/#/r/ABCD', '/?s=stream&via=qr', '/privacy', 'https://evil.example/', '/?s=<x>']) {
      expect(isAllowedUrl(u)).toBe(false);
      a.pageview(u, '');
      a.track(gameStart, u);
    }
    expect(sent).toHaveLength(0);
  });
});

describe('M-2: 参照元', () => {
  it('M-2: 参照元は許可したオリジンの名前か other か空', () => {
    const self = `https://${PROD}`;
    const cases: [string, string][] = [
      ['https://taro-yamada.github.io/x', 'other'],
      ['http://192.168.0.10:3000', 'other'],
      ['https://intra.example.co.jp/wiki/山田', 'other'],
      ['file:///C:/Users/taro/a.html', 'other'],
      ['javascript:alert(1)', 'other'],
      ['not a url', 'other'],
      [`${self}/#/r/ABCD`, ''],
      ['', ''],
      ['https://www.google.com/search?q=山田太郎', 'google'],
      ['https://evilgoogle.com/', 'other'],
      ['https://google.com.evil.example/', 'other'],
      ['http://www.google.com/', 'other'], // https 以外は名前にしない
      ['https://t.co/abc', 'x'],
    ];
    for (const [ref, want] of cases) {
      const name = referrerName(ref, self);
      expect(name).toBe(want);
      const url = referrerUrl(name);
      expect(REFERRER_URLS.has(url)).toBe(true);
      expect(url).not.toMatch(/taro|192\.168|intra|search|山田|abc/);
    }
    // 二段目：一覧にない参照元を直接渡すと送らない
    const { a, sent } = makeAnalytics();
    a.pageview('/', 'https://taro-yamada.github.io');
    a.pageview('/', 'https://www.google.com/search?q=x');
    expect(sent).toHaveLength(0);
  });
});

describe('M-3・送らない条件', () => {
  it('M-3: 本番のホスト名以外では送らない', () => {
    for (const h of [`abc.${PROD}`, 'localhost', `${PROD}.evil.com`, '127.0.0.1', `${PROD}.`, ` ${PROD}`, 'SUKIMA-EE3.PAGES.DEV', '']) {
      const { a, sent } = makeAnalytics({ enabled: () => metricsAllowedWith(okEnv({ hostname: () => h })) });
      a.pageview('/');
      a.track(gameStart, '/r');
      expect(sent).toHaveLength(0);
    }
    const { a, sent } = makeAnalytics({ enabled: () => metricsAllowedWith(okEnv()) });
    a.pageview('/');
    expect(sent).toHaveLength(1);
    // payload の hostname は実際の場所ではなく固定値
    expect(sent[0].payload.hostname).toBe(PROD);
  });

  it('送らない条件: デモ・開発・テスト・値が空・送らない設定・DNT・GPC のそれぞれで 0 件', () => {
    const dnt = (nav: () => unknown, win: () => unknown = () => ({})) => () => doNotTrackWith(nav, win);
    const thrower = () => {
      throw new Error('denied');
    };
    const cases: Partial<MetricsEnv>[] = [
      { online: false },
      { dev: true },
      { mode: 'test' },
      { websiteId: '' },
      { websiteId: ' \n' },
      { optedOut: () => true },
      { optedOut: thrower },
      { doNotTrack: dnt(() => ({ doNotTrack: '1' })) },
      { doNotTrack: dnt(() => ({ doNotTrack: 'yes' })) },
      { doNotTrack: dnt(() => ({}), () => ({ doNotTrack: '1' })) },
      { doNotTrack: dnt(() => ({ globalPrivacyControl: true })) },
      { doNotTrack: dnt(() => undefined) },
      { doNotTrack: dnt(thrower) },
      {
        doNotTrack: dnt(
          () =>
            new Proxy(
              {},
              {
                get: () => {
                  throw new Error('getter');
                },
              },
            ),
        ),
      },
    ];
    for (const c of cases) {
      const { a, sent } = makeAnalytics({ enabled: () => metricsAllowedWith(okEnv(c)) });
      a.pageview('/');
      a.track(gameStart, '/r');
      expect(sent).toHaveLength(0);
    }
    // 送るたびに判定する：途中で DNT を立てると次から止まる
    let flag: unknown = '0';
    const { a, sent } = makeAnalytics({ enabled: () => metricsAllowedWith(okEnv({ doNotTrack: dnt(() => ({ doNotTrack: flag })) })) });
    a.pageview('/');
    flag = '1';
    a.pageview('/');
    expect(sent).toHaveLength(1);
    // 製品の判定（テストの実行時）は常に偽
    expect(metricsAllowed()).toBe(false);
  });

  it('送らない設定: 押した直後から同じタブで止まり、保存に失敗しても止まったまま', () => {
    const failing = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    const opt = createOptOut(() => failing);
    const { a, sent } = makeAnalytics({ enabled: () => metricsAllowedWith(okEnv({ optedOut: () => opt.isOff() })) });
    a.pageview('/');
    expect(opt.set(true)).toBe(false); // 保存に失敗したことは返す（画面がそれを伝える）
    a.pageview('/');
    a.track(gameStart, '/r');
    expect(sent).toHaveLength(1);
    expect(opt.isOff()).toBe(true);
    // 壊れた値・読めないストレージは「送らない」側
    for (const v of ['abc', 'true', '', ' 0', '00']) {
      expect(createOptOut(() => ({ getItem: () => v, setItem: () => {} })).isOff()).toBe(true);
    }
    const unreadable = createOptOut(() => ({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    }));
    expect(unreadable.isOff()).toBe(true);
    expect(createOptOut(() => ({ getItem: () => '0', setItem: () => {} })).isOff()).toBe(false);
  });
});

describe('失敗', () => {
  it('失敗: sink の同期の例外・fetch の拒否が、呼び出し側にも未処理の Promise にも漏れない', async () => {
    type Proc = { on(ev: string, f: (r: unknown) => void): void; off(ev: string, f: (r: unknown) => void): void };
    const proc = (globalThis as unknown as { process: Proc }).process;
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    proc.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const rejecting = createFetchSink(() => () => {
        calls++;
        return Promise.reject(new TypeError('Failed to fetch'));
      });
      // 部屋の計測を、拒否する送り先・例外を投げる送り先で回しても、部屋は進み続ける
      const room = createSimRoom({ ids: ['a', 'b', 'c'] });
      const trackers = ['a', 'b', 'c'].map((id, i) => {
        const a = createAnalytics({ sink: i === 0 ? rejecting : () => { throw new Error('sync'); }, websiteId: 'w', enabled: () => true, now: () => room.sim.clock.now(), gameIds: SIM_IDS, version: '0', env: { hostname: PROD, language: '', screen: '' } });
        return { id, t: createRoomMetrics({ create: i === 0, me: id, track: (e) => a.track(e, '/r'), session: memStore(), local: memStore(), gameIds: SIM_IDS, src: () => 'none', takeJoinVia: () => 'link' }) };
      });
      const run = (ms: number) => {
        for (let t = 0; t < ms; t += 100) {
          room.settle(100);
          for (const { id, t: tr } of trackers) expect(() => tr.update(room.peers[id].engine.getSnapshot(), room.peers[id].engine.now())).not.toThrow();
        }
      };
      run(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
      for (let g = 0; g < 3; g++) {
        room.peers.a.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
        room.peers.a.engine.dispatch({ type: 'startGame', online: ['a', 'b', 'c'] });
        run(2000);
      }
      expect(calls).toBeGreaterThanOrEqual(3); // room_create と game_start を送ろうとした
      expect(room.converged()).toBe(true);
      expect(room.peers.c.engine.getSnapshot().state?.game?.id).toBe('counter');
      // 応答が来ない（永遠に保留）の fetch でも同じ
      expect(() => createFetchSink(() => () => new Promise(() => {}))({ type: 'event', payload: { website: 'w', hostname: PROD, url: '/', referrer: '', language: '', screen: '', title: 'SUKIMA' } })).not.toThrow();
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });

  it('失敗: 応答の中身を読まず、次の送信に付けない', async () => {
    const inits: RequestInit[] = [];
    let reads = 0;
    const response = {
      ok: true,
      status: 200,
      get headers() {
        reads++;
        return new Headers({ 'x-umami-cache': 'token-abc' });
      },
      json: () => {
        reads++;
        return Promise.resolve({ cache: 'token-abc', sessionId: 's1' });
      },
      text: () => {
        reads++;
        return Promise.resolve('token-abc');
      },
    };
    const sink = createFetchSink(() => (_url, init) => {
      inits.push(init);
      return Promise.resolve(response);
    });
    const { a } = makeAnalytics({ sink });
    a.track(gameStart, '/r');
    await Promise.resolve();
    await Promise.resolve();
    a.track(gameStart, '/r');
    expect(inits).toHaveLength(2);
    expect(reads).toBe(0);
    expect(inits[1]).toEqual(inits[0]);
    expect(JSON.stringify(inits)).not.toContain('token-abc');
    // Cookie を付けない・ページの URL を Referer で送らない
    expect(inits[0].credentials).toBe('omit');
    expect(inits[0].referrerPolicy).toBe('no-referrer');
  });
});

describe('二段目・ストレージ', () => {
  it('二段目: 表にないキー・長すぎる文字列・オブジェクトの値を含むイベントは送らない', () => {
    const { a, sent } = makeAnalytics();
    const bad: unknown[] = [
      { name: 'game_start', data: { game: 'rush', n: 3, seq: 1, name: '山田' } },
      { name: 'game_start', data: { game: 'rush'.repeat(20), n: 3, seq: 1 } },
      { name: 'game_start', data: { game: { toString: () => 'rush' }, n: 3, seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: '3', seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: 3.5, seq: 1 } },
      { name: 'game_start', data: { game: 'rush', n: 3, seq: 6 } },
      { name: 'game_start', data: { game: 'constructor', n: 3, seq: 1 } },
      { name: 'game_start', data: { game: '__proto__', n: 3, seq: 1 } },
      { name: 'room_enjoyed', data: { peak: 11, game: 'rush' } },
      { name: 'room_join', data: { via: 'link', code: 'ABCD' } },
      { name: 'room_join', data: [] },
      { name: 'room_join', data: null },
      { name: 'invite_share', data: { method: 'copy', n: [3] } },
      { name: 'room_create', data: { src: 'https://evil', rehost: 'no', was_guest: false, after_practice: false } },
      { name: 'chat', data: { text: 'x' } },
      { name: 'toString', data: {} },
      { name: '__proto__', data: {} },
      JSON.parse('{"name":"room_join","data":{"via":"link","__proto__":{"x":1}}}'),
      'room_join',
      null,
    ];
    for (const e of bad) a.track(e as MetricEvent, '/r');
    expect(sent).toHaveLength(0);
    // 正しいものは、知っているキーだけで作り直して送る
    a.track(gameStart, '/r');
    expect(Object.keys(sent[0].payload.data!).sort()).toEqual(['game', 'mode', 'n', 'seq', 'v']);
  });

  it('ストレージ: 壊れた部屋の記録・日付を読んでも例外を出さず、送る値は区分けだけ', () => {
    for (const raw of ['{', '{"games":1e309}', '{"__proto__":{}}', 'null', '[]', '"x"', '{"games":-1,"peak":0,"enjoyed":false,"lastStartedAt":null,"createdAt":null,"startsSent":0,"joined":false}']) {
      expect(() => parseTally(raw)).not.toThrow();
      expect(parseTally(raw)).toBeNull();
    }
    const huge = 'Z'.repeat(1_000_000);
    const sent: Payload[] = [];
    const d = device('h', true, sent, () => 0, GAME_ID_SET);
    d.session.set(`sukima:m:room:ABCD`, '{"games":1e309,"__proto__":{"enjoyed":true}}');
    d.local.set(DAY_KEYS.host, '9999-99-99');
    d.local.set(DAY_KEYS.guest, huge);
    d.local.set(DAY_KEYS.practice, '2026-02-30');
    const now = new Date(2026, 10, 22, 12).getTime();
    const ps = ['h', 'g', 'k'].map((id) => ({ id, name: id }));
    const state: RoomState = { code: 'ABCD', epoch: 1, version: 1, hostId: 'h', players: ps, selectedGame: 'rush', gameOptions: {}, game: null, chat: [], acks: {} };
    expect(() => d.tracker.update({ status: 'ready', state, isHost: true }, now)).not.toThrow();
    expect(() => d.tracker.update({ status: 'ready', state: { ...state, game: { id: 'rush', players: ps, state: {}, startedAt: now } }, isHost: true }, now + 1)).not.toThrow();
    expect(namesOf(sent)).toEqual(['room_create', 'game_start']);
    const all = JSON.stringify(sent);
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(all).not.toContain('ZZZZ');
    expect(all).not.toContain('ABCD');
    expect(sent[0].payload.data).toMatchObject({ rehost: 'no', after_practice: false });
    // 入口の印：保存された値が壊れていても許可した値にしかならない
    const s = memStore();
    s.set('sukima:m:src', '<script>');
    expect(createEntryMarks(s).src()).toBe('other');
  });
});

describe('静的', () => {
  // テスト以外の製品コード（src 配下）
  const sources = Object.entries(import.meta.glob<string>(['../**/*.{ts,tsx}', '!./**'], { query: '?raw', import: 'default', eager: true }));

  it('静的: Umami のスクリプトを読み込まない・送り先は 1 つだけ', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(indexHtml).not.toMatch(/umami|script\.js|data-website-id/i);
    for (const [, code] of sources) {
      expect(code).not.toMatch(/<script[^>]*umami|script\.js|data-website-id/i);
      expect(code).not.toMatch(/sendBeacon|XMLHttpRequest|new WebSocket\(|new Image\(/);
    }
    // fetch( と送り先の URL は analytics.ts だけ（Supabase の通信は supabase-js の中）
    const fetchers = sources.filter(([, c]) => /\bfetch\s*\(/.test(c.replace(/\/\/.*$/gm, ''))).map(([p]) => p);
    expect(fetchers).toEqual(['../lib/analytics.ts']);
    const umamiFiles = sources.filter(([, c]) => /umami\.is/.test(c)).map(([p]) => p);
    expect(umamiFiles).toEqual(['../lib/analytics.ts']);
    expect(UMAMI_ENDPOINT).toBe('https://gateway.umami.is/api/send');
    // テストの実行時、製品の送り先は fetch を呼ばない
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(''));
    }) as typeof fetch;
    createBrowserSink()({ type: 'event', payload: { website: 'w', hostname: PROD, url: '/', referrer: '', language: '', screen: '', title: 'SUKIMA' } });
    expect(calls).toBe(0);
  });

  it('静的: 計測が logic.ts・engine.ts・各ゲームの logic.ts から呼ばれない', () => {
    const pure = sources.filter(([p]) => /\/room\/(logic|engine|protocol)\.ts$|\/games\/[^/]+\/logic\.ts$|\/games\/micro\/[^/]+\.ts$/.test(p));
    expect(pure.length).toBeGreaterThan(5);
    for (const [p, code] of pure) {
      expect([p, /from ['"][^'"]*(analytics|metrics|metricsStore|roomMetrics|useRoomMetrics)['"]/.test(code)]).toEqual([p, false]);
    }
    // metrics.ts（純粋関数）は送信・ストレージ・時刻の取得を持たない
    const metrics = sources.find(([p]) => p.endsWith('/lib/metrics.ts'))![1].replace(/\/\/.*$/gm, '');
    expect(metrics).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|Date\.now\(|location\.|navigator\./);
  });
});
