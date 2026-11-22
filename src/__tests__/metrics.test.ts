// 計測の純粋関数（M-B1。設計 docs/dev/02-architecture.md §14.3〜§14.6）
import { describe, expect, it } from 'vitest';
import { GAME_IDS, GAME_ID_SET } from '../games/ids';
import { GAMES } from '../games/registry';
import {
  dayString,
  emptyTally,
  GAME_START_MAX_PER_ROOM,
  inviteShareEvent,
  observeRoom,
  pageUrl,
  parseSrc,
  parseTally,
  parseVia,
  practiceOverEvent,
  referrerName,
  referrerUrl,
  REFERRER_URLS,
  rehostBucket,
  roomCreateEvent,
  routePath,
  rulesOpenEvent,
  stageBucket,
  waitBucket,
  withinDays,
  type MetricEvent,
  type RoomTally,
} from '../lib/metrics';
import { createEntryMarks, type MetricsStore } from '../lib/metricsStore';
import { createRoom, type RoomState } from '../room/logic';

const ids = GAME_ID_SET;
const players = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `N${i}` }));
const stateWith = (game: { id: string; n: number; startedAt: number } | null): RoomState => ({
  ...createRoom('ABCD', { id: 'p0', name: 'N0' }, 'rush'),
  game: game ? { id: game.id, players: players(game.n), state: {}, startedAt: game.startedAt } : null,
});

// 端末 1 台分の記録を持ち、状態を順に流す
const device = (createdAt: number | null = null) => {
  let t: RoomTally = emptyTally(createdAt);
  const events: MetricEvent[] = [];
  return {
    see(state: RoomState, isHost: boolean, now = 0) {
      const r = observeRoom(t, state, isHost, now, ids);
      t = r.tally;
      events.push(...r.events);
      return r.events;
    },
    get tally() {
      return t;
    },
    events,
  };
};

describe('ゲームの ID の一覧', () => {
  it('registry の ID と一致する（計測用の一覧が古くならない）', () => {
    expect([...GAME_IDS].sort()).toEqual(Object.keys(GAMES).sort());
  });
});

describe('observeRoom（§14.4）', () => {
  it('① ゲスト→ホスト交代でも seq が続き、room_enjoyed が全端末を通して 1 回', () => {
    const a = device(0); // 作った人（最初のホスト）
    const b = device(); // ゲスト（あとで引き継ぐ）
    const c = device();
    const g1 = stateWith({ id: 'rush', n: 3, startedAt: 1000 });
    a.see(g1, true);
    b.see(g1, false);
    c.see(g1, false);
    // a が抜け、b がホストを引き継いで 2 ゲーム目
    const g2 = stateWith({ id: 'wordwolf', n: 3, startedAt: 5000 });
    b.see(g2, true);
    c.see(g2, false);
    const g3 = stateWith({ id: 'majority', n: 3, startedAt: 9000 });
    b.see(g3, true);
    c.see(g3, false);

    const all = [...a.events, ...b.events, ...c.events];
    expect(all.filter((e) => e.name === 'room_enjoyed')).toEqual([{ name: 'room_enjoyed', data: { peak: 3, game: 'wordwolf' } }]);
    expect(all.filter((e) => e.name === 'game_start').map((e) => (e.data as { seq: number }).seq)).toEqual([1, 2, 3]);
    // ゲストのままでも enjoyed は立つ（あとで引き継いでも二重に送らない）
    expect(c.tally.enjoyed).toBe(true);
    expect(c.events).toEqual([]);
  });

  it('② 2 人で 2 ゲーム・3 人で 1 ゲームでは送らない。3 人以上のゲームが 1 つあれば 2 ゲーム目で送る', () => {
    const two = device();
    two.see(stateWith({ id: 'rush', n: 2, startedAt: 1 }), true);
    two.see(stateWith({ id: 'rush', n: 2, startedAt: 2 }), true);
    expect(two.events.some((e) => e.name === 'room_enjoyed')).toBe(false);

    const one = device();
    one.see(stateWith({ id: 'rush', n: 3, startedAt: 1 }), true);
    expect(one.events.some((e) => e.name === 'room_enjoyed')).toBe(false);

    // 「どれかのゲームの参加者が 3 人以上」（§14.4 の読み方）
    const mixed = device();
    mixed.see(stateWith({ id: 'rush', n: 3, startedAt: 1 }), true);
    mixed.see(stateWith({ id: 'rush', n: 2, startedAt: 2 }), true);
    expect(mixed.events.filter((e) => e.name === 'room_enjoyed')).toEqual([{ name: 'room_enjoyed', data: { peak: 3, game: 'rush' } }]);
    mixed.see(stateWith({ id: 'rush', n: 10, startedAt: 3 }), true);
    expect(mixed.events.filter((e) => e.name === 'room_enjoyed')).toHaveLength(1);
  });

  it('③ 同じ startedAt の状態を何度受けても数えない。ゲームなしの状態も数えない', () => {
    const d = device();
    const s = stateWith({ id: 'rush', n: 4, startedAt: 100 });
    for (let i = 0; i < 20; i++) d.see(s, true);
    d.see(stateWith(null), true);
    d.see(s, true);
    expect(d.tally.games).toBe(1);
    expect(d.events).toHaveLength(1);
  });

  it('ゲストには events を返さない。seq は 5 で頭打ち、wait は createdAt があり seq === 1 のときだけ', () => {
    const guest = device(0);
    guest.see(stateWith({ id: 'rush', n: 3, startedAt: 1 }), false);
    expect(guest.events).toEqual([]);
    expect(guest.tally.games).toBe(1);

    const host = device(0);
    for (let i = 1; i <= 7; i++) host.see(stateWith({ id: 'rush', n: 2, startedAt: i }), true, 4 * 60_000);
    const starts = host.events.filter((e) => e.name === 'game_start');
    expect(starts.map((e) => (e.data as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(starts[0].data).toEqual({ game: 'rush', n: 2, seq: 1, wait: '3-5' });
    expect(starts.slice(1).every((e) => !('wait' in e.data))).toBe(true);

    // 引き継いだホスト（作成時刻を知らない）は wait を付けない
    const took = device(null);
    took.see(stateWith({ id: 'rush', n: 2, startedAt: 1 }), true, 10);
    expect(took.events[0].data).toEqual({ game: 'rush', n: 2, seq: 1 });
  });

  it('⑧ 登録にない game.id・11 人以上・0 人・小数の人数の状態では、記録を変えず送らない', () => {
    const d = device(0);
    const before = d.tally;
    const bad: RoomState[] = [
      stateWith({ id: '山田太郎 090-xxxx', n: 3, startedAt: 1 }),
      stateWith({ id: 'counter', n: 3, startedAt: 2 }),
      stateWith({ id: '__proto__', n: 3, startedAt: 3 }),
      stateWith({ id: 'rush', n: 11, startedAt: 4 }),
      stateWith({ id: 'rush', n: 0, startedAt: 5 }),
    ];
    // 小数・負・巨大な長さ（parse を通らない形も observeRoom に直接渡す）
    const odd = (len: unknown, startedAt: unknown = 6): RoomState =>
      ({ ...stateWith(null), game: { id: 'rush', players: { length: len }, state: {}, startedAt } }) as unknown as RoomState;
    bad.push(odd(2.5), odd(-1), odd(1e9), odd(3, NaN), odd(3, 'x'));
    for (const s of bad) d.see(s, true);
    expect(d.events).toEqual([]);
    expect(d.tally).toBe(before);

    // 正しい状態を混ぜても、返すイベントの値は一覧内・1〜10 の整数に収まる
    for (let i = 0; i < 30; i++) {
      d.see(stateWith({ id: i % 2 ? 'rush' : 'not-a-game', n: (i % 13) + 0, startedAt: 100 + i }), true);
    }
    expect(d.events.length).toBeGreaterThan(0);
    for (const e of d.events) {
      const data = e.data as Record<string, unknown>;
      if ('game' in data) expect(GAME_ID_SET.has(data.game as string)).toBe(true);
      for (const k of ['n', 'peak']) {
        if (k in data) {
          expect(Number.isInteger(data[k])).toBe(true);
          expect(data[k]).toBeGreaterThanOrEqual(1);
          expect(data[k]).toBeLessThanOrEqual(10);
        }
      }
    }
    expect(d.tally.peak).toBeLessThanOrEqual(10);
  });

  it('⑨ startedAt だけ変えた状態を 500 回受けても、game_start は 30 件で止まり、room_enjoyed は 1 回', () => {
    const d = device(0);
    for (let i = 0; i < 500; i++) d.see(stateWith({ id: 'rush', n: 4, startedAt: 1000 + i }), true);
    expect(d.events.filter((e) => e.name === 'game_start')).toHaveLength(GAME_START_MAX_PER_ROOM);
    expect(d.events.filter((e) => e.name === 'room_enjoyed')).toHaveLength(1);
    expect(d.tally.games).toBe(500);
  });
});

describe('印・画面・参照元', () => {
  it('④ parseSrc は許可した値だけ。許可外は other、なしは none', () => {
    expect(parseSrc('?s=stream')).toBe('stream');
    expect(parseSrc('?s=x&via=qr')).toBe('x');
    expect(parseSrc('?s=tiktok')).toBe('tiktok');
    expect(parseSrc('?s=guide')).toBe('guide');
    expect(parseSrc('')).toBe('none');
    expect(parseSrc('?via=qr')).toBe('none');
    expect(parseSrc('?s=')).toBe('other');
    expect(parseSrc('?s=<script>')).toBe('other');
    expect(parseSrc('?s=Stream')).toBe('other');
    expect(parseSrc('?s=山田')).toBe('other');
    expect(parseVia('?via=qr')).toBe('qr');
    expect(parseVia('?via=QR')).toBe(null);
    expect(parseVia('?s=stream')).toBe(null);
  });

  it('⑤ routePath は部屋コードを落とし、#/privacy では null', () => {
    expect(routePath('#/r/ABCD')).toBe('/r');
    expect(routePath('#/r/ABCD?x=1')).toBe('/r');
    expect(routePath('#/practice')).toBe('/practice');
    expect(routePath('')).toBe('/');
    expect(routePath('#/')).toBe('/');
    expect(routePath('#/../')).toBe('/');
    expect(routePath('#/' + 'A'.repeat(10_000))).toBe('/');
    expect(routePath('#/privacy')).toBe(null);
    expect(pageUrl('/r', 'stream')).toBe('/r?s=stream');
    expect(pageUrl('/', 'none')).toBe('/');
  });

  it('⑥ referrerName は許可一覧の名前か other、空・自分なら空（オリジンを返さない）', () => {
    const self = 'https://sukima-ee3.pages.dev';
    const cases: [string, string][] = [
      ['https://www.google.com/search?q=%E5%B1%B1%E7%94%B0', 'google'],
      ['https://google.co.jp/', 'google'],
      ['https://search.yahoo.co.jp/search?p=x', 'yahoo'],
      ['https://www.bing.com/', 'bing'],
      ['https://duckduckgo.com/', 'duckduckgo'],
      ['https://t.co/abc', 'x'],
      ['https://x.com/', 'x'],
      ['https://l.instagram.com/', 'instagram'],
      ['https://m.facebook.com/', 'facebook'],
      ['https://youtu.be/x', 'youtube'],
      ['https://www.twitch.tv/', 'twitch'],
      ['https://www.tiktok.com/', 'tiktok'],
      ['https://discord.com/channels/1', 'discord'],
      ['https://b.hatena.ne.jp/', 'hatena'],
      ['https://line.me/R/', 'line'],
      ['https://taro-yamada.github.io/x', 'other'],
      ['http://192.168.0.10:3000', 'other'],
      ['https://intra.example.co.jp', 'other'],
      ['https://evilgoogle.com', 'other'],
      ['https://google.com.evil.com', 'other'],
      ['http://www.google.com', 'other'],
      ['file:///', 'other'],
      ['javascript:alert(1)', 'other'],
      ['not a url', 'other'],
      ['', ''],
      ['https://sukima-ee3.pages.dev/#/r/ABCD', ''],
    ];
    for (const [ref, want] of cases) expect([ref, referrerName(ref, self)]).toEqual([ref, want]);
  });

  it('referrerUrl は固定の URL か空。どの名前も送ってよい値の一覧に入る', () => {
    expect(referrerUrl('google')).toBe('https://google.com');
    expect(referrerUrl('x')).toBe('https://x.com');
    expect(referrerUrl('other')).toBe('https://other.invalid');
    expect(referrerUrl('')).toBe('');
    for (const n of ['google', 'yahoo', 'bing', 'duckduckgo', 'x', 'line', 'instagram', 'facebook', 'youtube', 'twitch', 'tiktok', 'discord', 'hatena', 'other', ''] as const) {
      expect(REFERRER_URLS.has(referrerUrl(n))).toBe(true);
    }
  });
});

describe('⑦ 区分けの境界値', () => {
  it('waitBucket', () => {
    expect(waitBucket(-5)).toBe('0-1');
    expect(waitBucket(NaN)).toBe('0-1');
    expect(waitBucket(59_999)).toBe('0-1');
    expect(waitBucket(60_000)).toBe('1-3');
    expect(waitBucket(179_999)).toBe('1-3');
    expect(waitBucket(180_000)).toBe('3-5');
    expect(waitBucket(299_999)).toBe('3-5');
    expect(waitBucket(300_000)).toBe('5-10');
    expect(waitBucket(599_999)).toBe('5-10');
    expect(waitBucket(600_000)).toBe('10+');
  });

  it('stageBucket', () => {
    expect([0, 1, 4, 5, 9, 10, 14, 15, 99, NaN].map(stageBucket)).toEqual(['1-4', '1-4', '1-4', '5-9', '5-9', '10-14', '10-14', '15+', '15+', '1-4']);
  });

  it('rehostBucket・withinDays（壊れた日付・未来の日付は「なし」）', () => {
    const today = '2026-11-22';
    expect(rehostBucket('2026-11-22', today)).toBe('7d');
    expect(rehostBucket('2026-11-15', today)).toBe('7d');
    expect(rehostBucket('2026-11-14', today)).toBe('28d');
    expect(rehostBucket('2026-10-25', today)).toBe('28d');
    expect(rehostBucket('2026-10-24', today)).toBe('no');
    expect(rehostBucket(null, today)).toBe('no');
    expect(rehostBucket('9999-99-99', today)).toBe('no');
    expect(rehostBucket('2026-02-30', today)).toBe('no');
    expect(rehostBucket('2026-11-23', today)).toBe('no');
    expect(rehostBucket('x'.repeat(100_000), today)).toBe('no');
    expect(withinDays('2025-12-31', '2026-01-01', 1)).toBe(true);
  });

  it('dayString は YYYY-MM-DD', () => {
    expect(dayString(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const d = new Date(2026, 0, 5, 12);
    expect(dayString(d.getTime())).toBe('2026-01-05');
  });
});

describe('画面の操作で送るイベント', () => {
  it('room_create は区分けだけ（日付そのものを入れない）', () => {
    const e = roomCreateEvent({ src: 'stream', lastHostDay: '2026-11-20', lastGuestDay: '2026-01-01', lastPracticeDay: '2026-11-10', today: '2026-11-22' });
    expect(e).toEqual({ name: 'room_create', data: { src: 'stream', rehost: '7d', was_guest: true, after_practice: false } });
    expect(JSON.stringify(e)).not.toMatch(/2026/);
    const first = roomCreateEvent({ src: 'none', lastHostDay: null, lastGuestDay: '9999-99-99', lastPracticeDay: null, today: '2026-11-22' });
    expect(first.data).toEqual({ src: 'none', rehost: 'no', was_guest: false, after_practice: false });
  });

  it('人数・ゲーム ID が範囲外なら null', () => {
    expect(inviteShareEvent('copy', 3)).toEqual({ name: 'invite_share', data: { method: 'copy', n: 3 } });
    expect(inviteShareEvent('copy', 0)).toBe(null);
    expect(inviteShareEvent('copy', 11)).toBe(null);
    expect(inviteShareEvent('qr', 2.5)).toBe(null);
    expect(rulesOpenEvent('rush', ids)).toEqual({ name: 'rules_open', data: { game: 'rush' } });
    expect(rulesOpenEvent('evil', ids)).toBe(null);
    expect(practiceOverEvent(12, true)).toEqual({ name: 'practice_over', data: { stage: '10-14', best: true } });
  });
});

describe('ストレージの値（壊れた値で例外を出さない）', () => {
  it('parseTally は正しい形だけを受け付ける', () => {
    const ok = { ...emptyTally(5), games: 2, peak: 3 };
    expect(parseTally(JSON.stringify(ok))).toEqual(ok);
    for (const raw of [null, '', '{', 'null', '[]', '1', '{"games":1e309}', '{"__proto__":{}}', JSON.stringify({ ...ok, peak: 11 }), JSON.stringify({ ...ok, games: -1 }), JSON.stringify({ ...ok, enjoyed: 'yes' })]) {
      expect(parseTally(raw)).toBe(null);
    }
    // 余計なキーは持ち越さない
    expect(Object.keys(parseTally(JSON.stringify({ ...ok, name: '山田' }))!)).not.toContain('name');
  });

  it('入口の印：src はタブの中で保ち、via は 1 回使い切る。code の印が優先', () => {
    const data = new Map<string, string>();
    const store: MetricsStore = { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
    const m = createEntryMarks(store);
    m.capture('?s=stream&via=qr');
    expect(m.src()).toBe('stream');
    // リロード後（モジュール変数が消えた）も sessionStorage から読む
    const again = createEntryMarks(store);
    again.capture('');
    expect(again.src()).toBe('stream');
    expect(again.takeJoinVia()).toBe('qr');
    expect(again.takeJoinVia()).toBe('link');
    again.markJoinByCode();
    expect(again.takeJoinVia()).toBe('code');
    // 壊れた保存値は許可した値に丸める
    data.set('sukima:m:src', '<script>');
    expect(createEntryMarks(store).src()).toBe('other');
  });
});
