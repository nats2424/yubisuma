// 計測のために端末の中に置く値（設計 docs/dev/02-architecture.md §14.4・§14.5）。
// 置くのは日付（YYYY-MM-DD）・部屋の記録・入口の印だけで、どれも送らない（送るのは区分けだけ）。
// プライベートモードなどでストレージが使えなくても例外を出さず、「無いもの」として扱う
import { parseSrc, parseVia, type JoinVia, type Src } from './metrics';

export type MetricsStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

const wrap = (storage: () => Storage): MetricsStore => ({
  get: (key) => {
    try {
      return storage().getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      storage().setItem(key, value);
    } catch {
      // 保存できなくても遊びは続ける（数え直すだけ）
    }
  },
  remove: (key) => {
    try {
      storage().removeItem(key);
    } catch {
      // 同上
    }
  },
});

export const browserLocal: MetricsStore = wrap(() => localStorage);
export const browserSession: MetricsStore = wrap(() => sessionStorage);

// 「最後に〜した日」（localStorage）。日付だけを置き、端末を見分ける ID は作らない
export const DAY_KEYS = {
  host: 'sukima:m:lastHost',
  guest: 'sukima:m:lastGuest',
  practice: 'sukima:m:lastPractice',
} as const;

// 部屋の記録（sessionStorage）。部屋コードはキーに入るが、端末の中だけで送らない。
// 想定外の形のコードは保存しない（キーに任意の文字列を入れない）
export const tallyKey = (code: string): string | null => (/^[A-Z0-9]{1,8}$/.test(code) ? `sukima:m:room:${code}` : null);

// 入口の印（?s= と ?via=）。Client が起動時に読み、アドレス欄から消したあともタブの中で使う（M-C1）
const SRC_KEY = 'sukima:m:src';
const VIA_KEY = 'sukima:m:via';

export type EntryMarks = {
  capture(search: string): void;
  src(): Src;
  markJoinByCode(): void;
  takeJoinVia(): JoinVia;
};

export const createEntryMarks = (session: MetricsStore): EntryMarks => {
  let src: Src | null = null;
  let qr: boolean | null = null;
  let byCode = false;
  return {
    capture(search) {
      const s = parseSrc(search);
      // 印のない URL で開き直しても、前に読んだ印は消さない（同じタブの中で使い続ける）
      if (s !== 'none') {
        src = s;
        session.set(SRC_KEY, s);
      }
      if (parseVia(search) === 'qr') {
        qr = true;
        session.set(VIA_KEY, 'qr');
      }
    },
    src() {
      if (src === null) {
        // 保存した値も許可した値だけを受け付ける（壊れた値は 'other' か 'none' になる）
        const saved = session.get(SRC_KEY);
        src = saved ? parseSrc(`?s=${encodeURIComponent(saved)}`) : 'none';
      }
      return src;
    },
    markJoinByCode() {
      byCode = true;
    },
    // 次の room_join の via を決めて、印を使い切る（2 つ目の部屋に QR の印を持ち越さない）
    takeJoinVia() {
      if (qr === null) qr = session.get(VIA_KEY) === 'qr';
      const via: JoinVia = byCode ? 'code' : qr ? 'qr' : 'link';
      byCode = false;
      qr = false;
      session.remove(VIA_KEY);
      return via;
    },
  };
};
