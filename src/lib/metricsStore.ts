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

// 送らない条件に当たる端末（「送らない」・本番以外のホスト・DNT・GPC・デモモード・開発中）では書き込まない（R-15）。
// 記録は送るイベントの区分けを作るためだけのもので、送らない端末に置いておく理由がないため。
// 読み出し・削除はそのまま通す（読むだけなら何も残らず、消すのは残さない方向なので安全）。
// allowed が例外を投げたら「書かない」側に倒す
export const gatedStore = (store: MetricsStore, allowed: () => boolean): MetricsStore => ({
  get: (key) => store.get(key),
  set: (key, value) => {
    let ok = false;
    try {
      ok = allowed();
    } catch {
      ok = false;
    }
    if (ok) store.set(key, value);
  },
  remove: (key) => store.remove(key),
});

// 計測の記録のキーはすべてこの接頭辞で始まる（日付・部屋の記録・入口の印）。
// 「送らない」の設定（sukima:metrics:off）はこの接頭辞に当たらない
export const METRICS_KEY_PREFIX = 'sukima:m:';

// 計測の記録を消す（「送らない」に切り替えたとき。R-15）。消すのは METRICS_KEY_PREFIX のキーだけで、
// 「送らない」の設定やゲームの自己ベストなど他のキーには触らない。ストレージが使えなくても例外を出さない
export const clearMetricsRecords = (storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void => {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(METRICS_KEY_PREFIX)) keys.push(k);
    }
    // 走査しながら消すと添字がずれるので、集めてから消す
    for (const k of keys) {
      try {
        storage.removeItem(k);
      } catch {
        // 1 つ消せなくても残りは消す
      }
    }
  } catch {
    // ストレージが使えない（プライベートモードなど）：消すものもない
  }
};

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
