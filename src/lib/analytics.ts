// 計測の送信の部品（設計 docs/dev/02-architecture.md §14.5・§14.6）。
// - 送り先（sink）は必ず注入する。製品の送り先（fetch で Umami へ）を作るのは createBrowserSink だけで、
//   テストの実行時（MODE === 'test'）は何もしない送り先を返す（外部へ送らない二重の止め）
// - 「送らない条件」は送るたびに判定する（途中で「送らない」や「追跡しない」を選んでも次から止まる）
// - 送る値は表（§14.3）のものだけ。metrics.ts に不具合があっても外に出ないよう、ここでも形を確かめる（R-4）
import { version as packageVersion } from '../../package.json';
import { GAME_ID_SET } from '../games/ids';
import {
  isPlayerCount,
  pageUrl,
  practiceOverEvent,
  referrerName,
  referrerUrl,
  REFERRER_URLS,
  routePath,
  rulesOpenEvent,
  inviteShareEvent,
  dayString,
  type InviteMethod,
  type MetricEvent,
} from './metrics';
import { browserLocal, browserSession, clearMetricsRecords, createEntryMarks, DAY_KEYS, gatedStore } from './metricsStore';
import { isOnlineMode } from './transport';

export type PayloadData = Record<string, string | number | boolean>;
export type Payload = {
  type: 'event';
  payload: {
    website: string;
    hostname: string;
    url: string;
    referrer: string;
    language: string;
    screen: string;
    title: string;
    name?: string;
    data?: PayloadData;
  };
};
export type Sink = (p: Payload) => void;

export type AnalyticsDeps = {
  sink: Sink;
  websiteId: string;
  // §14.5 の「送らない条件」。送るたびに呼ぶ。例外は「送らない」
  enabled: () => boolean;
  now: () => number;
  // 二段目の検査で、送ってよい game の値（R-4）
  gameIds: ReadonlySet<string>;
  // アプリの版（package.json の version）。全イベントの data.v に付ける
  version: string;
  // hostname は location.hostname ではなく VITE_UMAMI_HOST の固定値（M-3）
  env: { hostname: string; language: string; screen: string };
};

export type Analytics = {
  pageview(url: string, referrer?: string): void;
  track(e: MetricEvent, url: string): void;
};

// 送り先（Umami Cloud の現行の公式ドキュメント docs.umami.is/docs/api/sending-stats。古い説明の cloud.umami.is/api/send ではない）
export const UMAMI_ENDPOINT = 'https://gateway.umami.is/api/send';
export const DEFAULT_PROD_HOST = 'sukima-ee3.pages.dev';
export const OPT_OUT_KEY = 'sukima:metrics:off';
// useEffect の不具合などで無限に送り、無料枠を食いつぶすのを防ぐ（§14.6）
export const RATE_LIMIT = { count: 60, windowMs: 3_600_000 } as const;
export const TITLE = 'SUKIMA';
const STRING_MAX = 50;

// ---- 二段目の検査（R-4） ----

type Check = (v: unknown, gameIds: ReadonlySet<string>) => boolean;
const oneOf =
  (...xs: string[]): Check =>
  (v) =>
    typeof v === 'string' && xs.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
const players: Check = (v) => isPlayerCount(v);
const intIn =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const gameId: Check = (v, ids) => typeof v === 'string' && v.length <= STRING_MAX && ids.has(v);

type Schema = { required: Record<string, Check>; optional?: Record<string, Check> };
const SCHEMAS: Record<MetricEvent['name'], Schema> = {
  room_create: {
    required: {
      src: oneOf('stream', 'x', 'tiktok', 'guide', 'none', 'other'),
      rehost: oneOf('7d', '28d', 'no'),
      was_guest: bool,
      after_practice: bool,
    },
  },
  invite_share: { required: { method: oneOf('share', 'copy', 'qr'), n: players } },
  room_join: { required: { via: oneOf('qr', 'code', 'link') } },
  game_start: {
    required: { game: gameId, n: players, seq: intIn(1, 5) },
    optional: { wait: oneOf('0-1', '1-3', '3-5', '5-10', '10+') },
  },
  room_enjoyed: { required: { peak: intIn(3, 10), game: gameId } },
  room_error: { required: { kind: oneOf('failed', 'notfound', 'full') } },
  practice_over: { required: { stage: oneOf('1-4', '5-9', '10-14', '15+'), best: bool } },
  rules_open: { required: { game: gameId } },
};

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// 表のとおりなら送る data（知っているキーだけで作り直したもの）、外れたら null
export const checkEvent = (e: unknown, gameIds: ReadonlySet<string>): { name: string; data: PayloadData } | null => {
  if (typeof e !== 'object' || e === null) return null;
  const { name, data } = e as { name?: unknown; data?: unknown };
  if (typeof name !== 'string' || !has(SCHEMAS, name)) return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const schema = SCHEMAS[name as MetricEvent['name']];
  const src = data as Record<string, unknown>;
  const out: PayloadData = {};
  for (const k of Object.keys(src)) {
    if (!has(schema.required, k) && !(schema.optional && has(schema.optional, k))) return null;
  }
  for (const [k, check] of Object.entries(schema.required)) {
    if (!has(src, k) || !check(src[k], gameIds)) return null;
    out[k] = src[k] as string | number | boolean;
  }
  for (const [k, check] of Object.entries(schema.optional ?? {})) {
    if (!has(src, k)) continue;
    if (!check(src[k], gameIds)) return null;
    out[k] = src[k] as string | number | boolean;
  }
  return { name, data: out };
};

// url は '/'・'/practice'・'/r' と許可した印（?s=）だけ（部屋コードやハッシュを送らない）
const URL_RE = /^\/(practice|r)?(\?s=(stream|x|tiktok|guide|other))?$/;
export const isAllowedUrl = (url: unknown): url is string => typeof url === 'string' && URL_RE.test(url);

// ---- 送信の部品 ----

export const createAnalytics = (deps: AnalyticsDeps): Analytics => {
  const sentAt: number[] = [];
  const allowed = (): boolean => {
    try {
      return deps.enabled() === true && deps.websiteId.trim() !== '';
    } catch {
      return false;
    }
  };
  // 1 タブあたり 1 時間に RATE_LIMIT.count 件まで
  const takeSlot = (): boolean => {
    let now: number;
    try {
      now = deps.now();
    } catch {
      return false;
    }
    if (!Number.isFinite(now)) return false;
    while (sentAt.length && now - sentAt[0] >= RATE_LIMIT.windowMs) sentAt.shift();
    if (sentAt.length >= RATE_LIMIT.count) return false;
    sentAt.push(now);
    return true;
  };
  const send = (url: string, referrer: string, ev?: { name: string; data: PayloadData }) => {
    if (!takeSlot()) return;
    const payload: Payload = {
      type: 'event',
      payload: {
        website: deps.websiteId.trim(),
        hostname: deps.env.hostname,
        url,
        referrer,
        language: deps.env.language,
        screen: deps.env.screen,
        title: TITLE,
      },
    };
    if (ev) {
      payload.payload.name = ev.name;
      // mode はデモモードでは送らないので常に online
      payload.payload.data = { ...ev.data, mode: 'online', v: deps.version.slice(0, STRING_MAX) };
    }
    try {
      deps.sink(payload);
    } catch {
      // 失敗は握りつぶす（遊びを止めない・再送しない）
    }
  };
  return {
    pageview(url, referrer = '') {
      try {
        if (!allowed() || !isAllowedUrl(url) || !REFERRER_URLS.has(referrer)) return;
        send(url, referrer);
      } catch {
        // 呼び出し側（画面）に例外を漏らさない
      }
    },
    track(e, url) {
      try {
        if (!allowed() || !isAllowedUrl(url)) return;
        const ev = checkEvent(e, deps.gameIds);
        if (!ev) return;
        send(url, '', ev);
      } catch {
        // 同上
      }
    },
  };
};

type FetchLike = (input: string, init: RequestInit) => unknown;

// fetch で送る送り先。応答は読まない・保存しない（Umami が返すセッション用のトークンを次に付けると、
// 端末の ID と同じになる。R-3）。非同期の失敗は try で捕まらないので、Promise の側でも握りつぶす
export const createFetchSink =
  (getFetch: () => FetchLike | undefined, endpoint: string = UMAMI_ENDPOINT): Sink =>
  (p) => {
    try {
      const f = getFetch();
      if (typeof f !== 'function') return;
      const body = JSON.stringify(p);
      const r = f(endpoint, {
        method: 'POST',
        keepalive: true,
        // Cookie を付けない・ページの URL を Referer で送らない（ページの URL に ?s= が残っている瞬間があるため）
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
        (r as PromiseLike<unknown>).then(undefined, () => {});
      }
    } catch {
      // 失敗は握りつぶす
    }
  };

const noopSink: Sink = () => {};

// 製品の送り先。テストの実行時は何もしない（fetch を呼ばない）
export const createBrowserSink = (): Sink =>
  import.meta.env.MODE === 'test'
    ? noopSink
    : createFetchSink(() => (typeof fetch === 'function' ? (input, init) => fetch(input, init) : undefined));

// ---- 送らない条件（§14.5 の 1〜6） ----

export type MetricsEnv = {
  online: boolean; // 1. デモモードでない
  dev: boolean; // 2. 開発中
  mode: string; // 2. 'test' なら送らない
  websiteId: string; // 3. 空なら送らない
  prodHost: string; // 4. 本番のホスト名
  hostname: () => string; // 4. 実際の location.hostname
  optedOut: () => boolean; // 5. 「送らない」を選んだ
  doNotTrack: () => boolean; // 6. 「追跡しない」の設定
};

// どれか 1 つでも当たれば偽。例外も偽
export const metricsAllowedWith = (env: MetricsEnv): boolean => {
  try {
    if (!env.online) return false;
    if (env.dev || env.mode === 'test') return false;
    if (!env.websiteId.trim()) return false;
    // 完全一致だけ（Preview の <枝>.sukima-ee3.pages.dev・localhost・他サイトのコピーを落とす。M-3）
    if (!env.prodHost || env.hostname() !== env.prodHost) return false;
    if (env.optedOut()) return false;
    if (env.doNotTrack()) return false;
    return true;
  } catch {
    return false;
  }
};

// 「追跡しない」：navigator.doNotTrack・window.doNotTrack が '1' か 'yes'、または GPC。
// navigator が無い・読むと例外のときも「追跡しない」側に倒す（R-1）
export const doNotTrackWith = (getNav: () => unknown, getWin: () => unknown): boolean => {
  try {
    const nav = getNav() as { doNotTrack?: unknown; globalPrivacyControl?: unknown } | null | undefined;
    if (!nav || typeof nav !== 'object') return true;
    const win = getWin() as { doNotTrack?: unknown } | null | undefined;
    const flags = [nav.doNotTrack, win && typeof win === 'object' ? win.doNotTrack : undefined];
    if (flags.some((f) => f === '1' || f === 'yes')) return true;
    return nav.globalPrivacyControl === true;
  } catch {
    return true;
  }
};

export type OptOut = {
  isOff(): boolean;
  // 保存できたら真。保存に失敗しても、このタブでは選んだ値を保つ（R-2）
  set(off: boolean): boolean;
};

// 「送らない」の設定。値は '1'（送らない）・'0'（送る）・なし（初期。送る）だけを認め、
// 読むと例外・壊れた値は「送らない」側に倒す（R-2）
export const createOptOut = (getStorage: () => Pick<Storage, 'getItem' | 'setItem'>): OptOut => {
  let inTab: boolean | null = null;
  return {
    isOff() {
      if (inTab !== null) return inTab;
      try {
        const v = getStorage().getItem(OPT_OUT_KEY);
        if (v === null || v === '0') return false;
        return true;
      } catch {
        return true;
      }
    },
    set(off) {
      inTab = off;
      try {
        getStorage().setItem(OPT_OUT_KEY, off ? '1' : '0');
        return true;
      } catch {
        return false;
      }
    },
  };
};

// ---- 製品用の 1 つ（ビルド時の値は Cloudflare の Production だけに入れる。M-C8） ----

// 環境変数は 1 つずつ名前で読む（Vite がビルド時に置き換える。security-static の「読む環境変数の一覧」の検査に載せるため）
const WEBSITE_ID = String(import.meta.env.VITE_UMAMI_WEBSITE_ID ?? '').trim();
const PROD_HOST = String(import.meta.env.VITE_UMAMI_HOST ?? '').trim() || DEFAULT_PROD_HOST;

const optOut = createOptOut(() => localStorage);
// 「送らない」に切り替えたら、それまでに置いた計測の記録（日付・部屋の記録・入口の印）を消す（R-15）。
// 記録は送るイベントの区分けにしか使わないので、送らないと決めた人の端末に残す理由がない。
// また、あとで「送る」に戻したとき、送らなかった期間をまたいだ古い日付で「久しぶり」などの区分けを作らないため。
// 「送らない」の設定値そのもの（sukima:metrics:off）は残す（消すと次に開いたとき送る側に戻ってしまう）。
// 「送る」に戻したときは何も消さない（消すものがない）
export const setMetricsOptOut = (off: boolean): boolean => {
  const saved = optOut.set(off);
  if (off) {
    try {
      if (typeof localStorage !== 'undefined') clearMetricsRecords(localStorage);
    } catch {
      // ストレージが使えなくても切り替えは続ける
    }
    try {
      if (typeof sessionStorage !== 'undefined') clearMetricsRecords(sessionStorage);
    } catch {
      // 同上
    }
  }
  return saved;
};
export const isMetricsOptedOut = (): boolean => optOut.isOff();

export const metricsAllowed = (): boolean =>
  metricsAllowedWith({
    online: isOnlineMode,
    dev: import.meta.env.DEV === true,
    mode: String(import.meta.env.MODE),
    websiteId: WEBSITE_ID,
    prodHost: PROD_HOST,
    hostname: () => location.hostname,
    optedOut: () => optOut.isOff(),
    doNotTrack: () =>
      doNotTrackWith(
        () => (typeof navigator === 'undefined' ? undefined : navigator),
        () => (typeof window === 'undefined' ? undefined : window),
      ),
  });

// 言語・画面の大きさは Umami の区分けに使われる。形の決まった短い値だけを送る
const browserLanguage = (): string => {
  try {
    const l = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '');
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(l) ? l : '';
  } catch {
    return '';
  }
};
const browserScreen = (): string => {
  try {
    if (typeof screen === 'undefined') return '';
    const w = Math.round(screen.width);
    const h = Math.round(screen.height);
    return w > 0 && h > 0 && w < 100_000 && h < 100_000 ? `${w}x${h}` : '';
  } catch {
    return '';
  }
};

export const analytics: Analytics = createAnalytics({
  sink: createBrowserSink(),
  websiteId: WEBSITE_ID,
  enabled: metricsAllowed,
  now: () => Date.now(),
  gameIds: GAME_ID_SET,
  version: packageVersion,
  env: { hostname: PROD_HOST, language: browserLanguage(), screen: browserScreen() },
});

// ---- 画面（Client）から呼ぶ入口。どれも例外を投げず、送らない条件に当たれば何もしない ----

// 計測の記録を書くストレージ。送らない条件に当たる端末では書き込まない（R-15）
export const metricsLocal = gatedStore(browserLocal, metricsAllowed);
export const metricsSession = gatedStore(browserSession, metricsAllowed);

export const entryMarks = createEntryMarks(metricsSession);

const currentHash = (): string => {
  try {
    return location.hash;
  } catch {
    return '';
  }
};
// イベントに付ける url（印は付けない。部屋の画面なら '/r'）
const eventUrl = (): string => routePath(currentHash()) ?? '/';

let referrerSent = false;

// 起動時に 1 回：?s= と ?via= を読んでタブの中に置く。このあと Client が history.replaceState で消す（M-C1）
export const captureEntryMarks = (search: string): void => {
  try {
    entryMarks.capture(search);
  } catch {
    // 印が読めなくても遊びは続ける
  }
};

// 画面が変わるたびに呼ぶ。'#/privacy' では送らない（R-9）。参照元は最初の 1 回だけ付ける
export const trackPageview = (hash: string = currentHash()): void => {
  try {
    const path = routePath(hash);
    if (path === null) return;
    let ref = '';
    if (!referrerSent) {
      referrerSent = true;
      ref = referrerUrl(referrerName(typeof document === 'undefined' ? '' : document.referrer, location.origin));
    }
    analytics.pageview(pageUrl(path, entryMarks.src()), ref);
  } catch {
    // 同上
  }
};

// トップでコードを入れて参加するとき、goRoom の前に呼ぶ（room_join.via が 'code' になる。M-C4）
export const markJoinByCode = (): void => entryMarks.markJoinByCode();

// 招待の共有・コピーが成功したとき（shared / copied）、QR を開いたとき。n はその時点の人数（M-C2）
export const trackInviteShare = (method: InviteMethod, n: number): void => {
  const e = inviteShareEvent(method, n);
  if (e) analytics.track(e, eventUrl());
};

// ひとり用の 1 回の挑戦が終わったとき。cleared はクリアしたステージ数、best は自己ベストを更新したか（M-C5）
export const trackPracticeOver = (cleared: number, best: boolean, now: number = Date.now()): void => {
  try {
    metricsLocal.set(DAY_KEYS.practice, dayString(now));
  } catch {
    // 保存できなくても続ける
  }
  analytics.track(practiceOverEvent(cleared, best), eventUrl());
};

// 「くわしいルール」を開いたとき（M-C6）
export const trackRulesOpen = (game: string): void => {
  const e = rulesOpenEvent(game, GAME_ID_SET);
  if (e) analytics.track(e, eventUrl());
};
