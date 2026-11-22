// 需要を測る最小限の計測の「何を送るか」を決める純粋関数（設計 docs/dev/02-architecture.md §14.3〜§14.6）。
// 送信・ストレージ・時刻の取得はここでは行わない（送信は analytics.ts、配線は src/room/roomMetrics.ts）。
// registry.ts を import しないのは、各ゲームの View（React）まで読み込んでテストが重くなるため。
// ゲーム ID の一覧は呼び出し側が gameIds として渡す
import type { RoomState } from '../room/logic';

// yt-bio：YouTube のプロフィールのリンク、yt-long：YouTube の横長のまとめ動画の概要欄（marketing/sns/plan.md §7.1）
export type Src = 'stream' | 'x' | 'tiktok' | 'guide' | 'yt-bio' | 'yt-long' | 'none' | 'other';
export type WaitBucket = '0-1' | '1-3' | '3-5' | '5-10' | '10+';
export type RehostBucket = '7d' | '28d' | 'no';
export type StageBucket = '1-4' | '5-9' | '10-14' | '15+';
export type JoinVia = 'qr' | 'code' | 'link';
export type ErrorKind = 'failed' | 'notfound' | 'full';
export type InviteMethod = 'share' | 'copy' | 'qr';
export type Seq = 1 | 2 | 3 | 4 | 5;
export type RefName =
  | 'google'
  | 'yahoo'
  | 'bing'
  | 'duckduckgo'
  | 'x'
  | 'line'
  | 'instagram'
  | 'facebook'
  | 'youtube'
  | 'twitch'
  | 'tiktok'
  | 'discord'
  | 'hatena'
  | 'other';

export type MetricEvent =
  | { name: 'room_create'; data: { src: Src; rehost: RehostBucket; was_guest: boolean; after_practice: boolean } }
  | { name: 'invite_share'; data: { method: InviteMethod; n: number } }
  | { name: 'room_join'; data: { via: JoinVia } }
  | { name: 'game_start'; data: { game: string; n: number; seq: Seq; wait?: WaitBucket } }
  | { name: 'room_enjoyed'; data: { peak: number; game: string } }
  | { name: 'room_error'; data: { kind: ErrorKind } }
  | { name: 'practice_over'; data: { stage: StageBucket; best: boolean } }
  | { name: 'rules_open'; data: { game: string } };

// 部屋の記録（§14.4）。全員の端末が持ち、送るのはそのときのホストだけ。
// createdAt：この端末が「部屋を作る」で作り room_create を送った時刻（送ったかどうかの印を兼ねる）。
// joined：この部屋で room_join を送ったか（同じタブ・同じ部屋で 1 回だけにする）。
// startsSent：この部屋で送った game_start の数（1 部屋 30 件まで。R-5）
export type RoomTally = {
  games: number;
  peak: number;
  enjoyed: boolean;
  lastStartedAt: number | null;
  createdAt: number | null;
  startsSent: number;
  joined: boolean;
};

// 北極星（楽しまれたルーム）の条件。08 §1.2
export const ENJOYED_MIN_GAMES = 2;
export const ENJOYED_MIN_PEAK = 3;
// 偽の状態で startedAt だけ変え続けられても、1 時間 60 件の上限より手前で止まるように（R-5）
export const GAME_START_MAX_PER_ROOM = 30;
// 部屋の人数の上限（MAX_ROOM_PLAYERS と同じ）。これを外れる人数は送らない（M-1）
const PLAYERS_MIN = 1;
const PLAYERS_MAX = 10;
const COUNTER_MAX = 1_000_000;

export const isPlayerCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= PLAYERS_MIN && n <= PLAYERS_MAX;

export const emptyTally = (createdAt: number | null): RoomTally => ({
  games: 0,
  peak: 0,
  enjoyed: false,
  lastStartedAt: null,
  createdAt,
  startsSent: 0,
  joined: false,
});

const isCounter = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isTimeOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

// sessionStorage から読んだ部屋の記録を検証する。壊れた値は null（呼び出し側は数え直す）。例外は投げない
export const parseTally = (raw: string | null): RoomTally | null => {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (
    !isCounter(r.games, COUNTER_MAX) ||
    !isCounter(r.peak, PLAYERS_MAX) ||
    typeof r.enjoyed !== 'boolean' ||
    !isTimeOrNull(r.lastStartedAt) ||
    !isTimeOrNull(r.createdAt) ||
    !isCounter(r.startsSent, COUNTER_MAX) ||
    typeof r.joined !== 'boolean'
  )
    return null;
  // 知っている項目だけで作り直す（余計なキーを持ち越さない）
  return {
    games: r.games,
    peak: r.peak,
    enjoyed: r.enjoyed,
    lastStartedAt: r.lastStartedAt,
    createdAt: r.createdAt,
    startsSent: r.startsSent,
    joined: r.joined,
  };
};

export const waitBucket = (ms: number): WaitBucket => {
  if (!Number.isFinite(ms) || ms < 60_000) return '0-1';
  const min = ms / 60_000;
  if (min < 3) return '1-3';
  if (min < 5) return '3-5';
  if (min < 10) return '5-10';
  return '10+';
};

// 状態を 1 つ受け取り、新しい記録と送るイベントを返す（§14.4）。isHost が偽なら events は常に空。
// game.id が gameIds にない・人数が 1〜10 の整数でない状態は、記録を変えずに events を空で返す（M-1。
// 偽の状態で、攻撃者の決めた文字列や人数をホストの端末から送らせないため）
export const observeRoom = (
  t: RoomTally,
  state: RoomState,
  isHost: boolean,
  now: number,
  gameIds: ReadonlySet<string>,
): { tally: RoomTally; events: MetricEvent[] } => {
  const same = { tally: t, events: [] as MetricEvent[] };
  const game = state.game;
  if (!game || typeof game !== 'object') return same;
  if (typeof game.startedAt !== 'number' || !Number.isFinite(game.startedAt)) return same;
  if (game.startedAt === t.lastStartedAt) return same;
  if (typeof game.id !== 'string' || !gameIds.has(game.id)) return same;
  const n = Array.isArray(game.players) ? game.players.length : NaN;
  if (!isPlayerCount(n)) return same;

  const games = Math.min(t.games + 1, COUNTER_MAX);
  const peak = Math.max(t.peak, n);
  const seq = Math.min(games, 5) as Seq;
  const events: MetricEvent[] = [];
  let startsSent = t.startsSent;
  if (isHost && startsSent < GAME_START_MAX_PER_ROOM) {
    const data: { game: string; n: number; seq: Seq; wait?: WaitBucket } = { game: game.id, n, seq };
    // 引き継いだホストは作成時刻を知らない（createdAt が null）ので付けない
    if (seq === 1 && t.createdAt !== null) data.wait = waitBucket(now - t.createdAt);
    events.push({ name: 'game_start', data });
    startsSent += 1;
  }
  let enjoyed = t.enjoyed;
  if (!enjoyed && games >= ENJOYED_MIN_GAMES && peak >= ENJOYED_MIN_PEAK) {
    // ゲストのままでも立てる。あとでホストを引き継いだ人が二重に送らないように
    enjoyed = true;
    if (isHost) events.push({ name: 'room_enjoyed', data: { peak, game: game.id } });
  }
  return { tally: { ...t, games, peak, enjoyed, lastStartedAt: game.startedAt, startsSent }, events };
};

const SRC_ALLOWED: readonly Src[] = ['stream', 'x', 'tiktok', 'guide', 'yt-bio', 'yt-long'];

const searchParams = (search: string): URLSearchParams | null => {
  try {
    return new URLSearchParams(search);
  } catch {
    return null;
  }
};

// '?s=stream' → 'stream'。許可外は 'other'、印なしは 'none'
export const parseSrc = (search: string): Src => {
  const s = searchParams(search)?.get('s');
  if (s === null || s === undefined) return 'none';
  return (SRC_ALLOWED as readonly string[]).includes(s) ? (s as Src) : 'other';
};

// '?via=qr' だけ認める（QR の URL の印。M-C3）
export const parseVia = (search: string): 'qr' | null => (searchParams(search)?.get('via') === 'qr' ? 'qr' : null);

// ハッシュの画面を、送ってよい URL に置き換える。部屋コードは付けない。
// '#/privacy' は null（説明を読みに来た人を数えない。R-9）。分岐は App.tsx の route と同じ
export const routePath = (hash: string): '/' | '/practice' | '/r' | null => {
  if (hash.startsWith('#/privacy')) return null;
  if (hash.startsWith('#/practice')) return '/practice';
  if (/^#\/r\/[A-Za-z0-9]+/.test(hash)) return '/r';
  return '/';
};

// ページ表示の url：routePath の値に、許可した印（?s=）だけを付ける。印なしならそのまま
export const pageUrl = (path: '/' | '/practice' | '/r', src: Src): string => (src === 'none' ? path : `${path}?s=${src}`);

// 参照元の許可一覧（§14.3。CTO の仮置き。足し引きは Marketing・PdM）。
// 先頭のドメインが、Umami に送る固定の URL になる
const REFERRERS: readonly (readonly [Exclude<RefName, 'other'>, readonly string[]])[] = [
  ['google', ['google.com', 'google.co.jp']],
  ['yahoo', ['yahoo.co.jp', 'yahoo.com']],
  ['bing', ['bing.com']],
  ['duckduckgo', ['duckduckgo.com']],
  ['x', ['x.com', 't.co', 'twitter.com']],
  ['line', ['line.me']],
  ['instagram', ['instagram.com']],
  ['facebook', ['facebook.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['twitch', ['twitch.tv']],
  ['tiktok', ['tiktok.com']],
  ['discord', ['discord.com']],
  ['hatena', ['hatena.ne.jp']],
];

// 参照元を、許可一覧の名前か 'other' にする。空・自分のサイトなら ''。
// オリジンそのものは返さない（https://taro-yamada.github.io のようにオリジンが人や勤め先を指すため。M-2）
export const referrerName = (referrer: string, selfOrigin: string): RefName | '' => {
  if (!referrer) return '';
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return 'other';
  }
  if (url.origin === selfOrigin) return '';
  if (url.protocol !== 'https:') return 'other';
  const host = url.hostname.toLowerCase();
  for (const [name, domains] of REFERRERS) {
    // 完全一致かサブドメインだけ（evilgoogle.com は当たらない）
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return name;
  }
  return 'other';
};

// 名前を Umami に送る固定の URL に置き換える（Umami の参照元の画面はドメインで集計するため。§14.3）
export const OTHER_REFERRER_URL = 'https://other.invalid';
export const referrerUrl = (name: RefName | ''): string => {
  if (name === '') return '';
  if (name === 'other') return OTHER_REFERRER_URL;
  const hit = REFERRERS.find(([n]) => n === name);
  return hit ? `https://${hit[1][0]}` : OTHER_REFERRER_URL;
};
// 送ってよい referrer の値の一覧（analytics.ts の二段目の検査で使う）
export const REFERRER_URLS: ReadonlySet<string> = new Set(['', OTHER_REFERRER_URL, ...REFERRERS.map(([, d]) => `https://${d[0]}`)]);

const DAY_MS = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// 端末の暦での日付（YYYY-MM-DD）。端末に置くのはこれだけ（§14.4）
export const dayString = (now: number): string => {
  const d = new Date(now);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 'YYYY-MM-DD' を UTC の日の通し番号にする。形が違う・存在しない日付は null
const dayIndex = (s: string | null): number | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
};

// last が today の days 日前まで（当日を含む）なら真。壊れた値・未来の日付は偽
export const withinDays = (last: string | null, today: string, days: number): boolean => {
  const a = dayIndex(last);
  const b = dayIndex(today);
  if (a === null || b === null) return false;
  const diff = b - a;
  return diff >= 0 && diff <= days;
};

export const rehostBucket = (lastHostDay: string | null, today: string): RehostBucket => {
  if (withinDays(lastHostDay, today, 7)) return '7d';
  if (withinDays(lastHostDay, today, 28)) return '28d';
  return 'no';
};

export const stageBucket = (cleared: number): StageBucket => {
  if (!Number.isFinite(cleared) || cleared <= 4) return '1-4';
  if (cleared <= 9) return '5-9';
  if (cleared <= 14) return '10-14';
  return '15+';
};

// 以下、画面の操作で送るイベントを組み立てる。値が範囲外なら null（送らない）

export const roomCreateEvent = (o: {
  src: Src;
  lastHostDay: string | null;
  lastGuestDay: string | null;
  lastPracticeDay: string | null;
  today: string;
}): MetricEvent => ({
  name: 'room_create',
  data: {
    src: o.src,
    rehost: rehostBucket(o.lastHostDay, o.today),
    was_guest: dayIndex(o.lastGuestDay) !== null,
    after_practice: withinDays(o.lastPracticeDay, o.today, 7),
  },
});

export const inviteShareEvent = (method: InviteMethod, n: number): MetricEvent | null =>
  isPlayerCount(n) ? { name: 'invite_share', data: { method, n } } : null;

export const roomJoinEvent = (via: JoinVia): MetricEvent => ({ name: 'room_join', data: { via } });

export const roomErrorEvent = (kind: ErrorKind): MetricEvent => ({ name: 'room_error', data: { kind } });

export const practiceOverEvent = (cleared: number, best: boolean): MetricEvent => ({
  name: 'practice_over',
  data: { stage: stageBucket(cleared), best },
});

export const rulesOpenEvent = (game: string, gameIds: ReadonlySet<string>): MetricEvent | null =>
  gameIds.has(game) ? { name: 'rules_open', data: { game } } : null;
