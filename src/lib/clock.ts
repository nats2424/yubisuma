// 時計とタイマーの抽象（設計 docs/dev/02-architecture.md §1.3）。
// 同期処理（RoomEngine / ManagedTransport）はこれを注入して使う。
// 本番は Date.now / setTimeout、テストは疑似ネットワークの仮想時計を渡し、
// 複数端末を 1 プロセスで決定的に動かせるようにする。

// タイマーの取り消し関数を返す形にして、本番とテストで ID 型の違いを気にしなくてよいようにする
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, Math.max(0, ms));
    return () => globalThis.clearTimeout(id);
  },
};
