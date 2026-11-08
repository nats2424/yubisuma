// 疑似ネットワーク（設計 docs/dev/02-architecture.md §6.1）。
// 遅延・ゆらぎ・欠落・切断・スリープを、仮想時刻とシード付き乱数で決定的に再現する。
// 本番と同じ ManagedTransport / RoomEngine に、Link と Clock だけ差し替えて使う。
// ファイル名が *.test.ts ではないので、vitest のテストとしては実行されない。
import type { Clock } from '../../lib/clock';
import type { Link, LinkEvents, LinkFactory } from '../../lib/transport';

// ---------- 仮想時計 ----------

type Timer = { at: number; order: number; fn: () => void; cancelled: boolean };

// 全端末で共有する仮想時刻。advance で進めた分だけ、期限の来たタイマーを時刻順に実行する
export class SimClock implements Clock {
  private t = 0;
  private order = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: Timer = { at: this.t + Math.max(0, ms), order: this.order++, fn, cancelled: false };
    // 期限 → 登録順で並べる（同時刻のタイマーも毎回同じ順で動かすため）
    let i = this.timers.length;
    while (i > 0 && (this.timers[i - 1].at > timer.at || (this.timers[i - 1].at === timer.at && this.timers[i - 1].order > timer.order))) i--;
    this.timers.splice(i, 0, timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    const target = this.t + Math.max(0, ms);
    for (;;) {
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      if (next.cancelled) continue;
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }

  // 条件が成り立つまで stepMs ずつ進める。maxMs を超えたら諦めて false（無限ループ防止）
  runUntil(pred: () => boolean, maxMs: number, stepMs = 10): boolean {
    const end = this.t + maxMs;
    while (!pred()) {
      if (this.t >= end) return false;
      this.advance(Math.min(stepMs, end - this.t));
    }
    return true;
  }
}

// ---------- シード付き乱数（mulberry32） ----------

const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------- ネットワーク ----------

export type LinkConditions = {
  latencyMs?: number; // 片道の固定遅延（既定 20）
  jitterMs?: number; // 0〜jitter の一様ゆらぎ（順序入れ替わりはここから自然に起きる）
  lossRate?: number; // 0〜1。送信ごとに受信者別に判定
};

// 接続試行が onOpen になるまでの時間
export const SIM_CONNECT_MS = 50;

export interface SimNode {
  readonly id: string;
  readonly linkFactory: LinkFactory;
  clockFor(skewMs?: number): Clock; // 端末ごとの時計のずれ
  set(cond: LinkConditions): void;
  failConnects(n: number): void; // 次の n 回の接続試行を onDown にする
  disconnect(): void; // onDown を通知し、以後送受信を落とす（restore まで接続もできない）
  restore(): void; // ライブラリの自動再参加を模して onOpen
  freeze(): void; // スリープ：この端末のタイマーを止め、送受信を黙って落とす
  thaw(): void; // 復帰：溜まったタイマーを実行（resume() はテスト側で呼ぶ）
  readonly frozen: boolean;
}

type SimLink = { room: string; ev: LinkEvents; open: boolean; closed: boolean };
type DropRule = { pred: (msg: unknown, from: string, to: string) => boolean; remaining: number };

class SimNodeImpl implements SimNode {
  cond: Required<LinkConditions>;
  links: SimLink[] = [];
  down = false;
  frozen = false;
  private failNext = 0;
  private pending: { fn: () => void; cancelled: () => boolean }[] = [];
  readonly linkFactory: LinkFactory;

  constructor(
    readonly id: string,
    private readonly net: SimNetwork,
    cond: LinkConditions,
  ) {
    this.cond = { latencyMs: 20, jitterMs: 0, lossRate: 0, ...cond };
    this.linkFactory = (room, ev) => this.createLink(room, ev);
  }

  // この端末のタイマー。凍結中に期限が来たものは thaw まで溜めておく
  timer(fn: () => void, ms: number): () => void {
    let cancelled = false;
    const cancel = this.net.clock.setTimeout(() => {
      if (cancelled) return;
      if (this.frozen) this.pending.push({ fn, cancelled: () => cancelled });
      else fn();
    }, ms);
    return () => {
      cancelled = true;
      cancel();
    };
  }

  clockFor(skewMs = 0): Clock {
    return {
      now: () => this.net.clock.now() + skewMs,
      setTimeout: (fn, ms) => this.timer(fn, ms),
    };
  }

  set(cond: LinkConditions) {
    this.cond = { ...this.cond, ...cond };
  }

  failConnects(n: number) {
    this.failNext = n;
  }

  disconnect() {
    this.down = true;
    for (const l of this.links) {
      if (l.closed || !l.open) continue;
      l.open = false;
      l.ev.onDown('CHANNEL_ERROR');
    }
  }

  restore() {
    this.down = false;
    for (const l of this.links) {
      if (l.closed || l.open) continue;
      l.open = true;
      l.ev.onOpen();
    }
  }

  freeze() {
    this.frozen = true;
  }

  thaw() {
    this.frozen = false;
    const run = this.pending;
    this.pending = [];
    for (const p of run) if (!p.cancelled()) p.fn();
  }

  private createLink(room: string, ev: LinkEvents): Link {
    const link: SimLink = { room, ev, open: false, closed: false };
    this.links = [...this.links.filter((l) => !l.closed), link];
    // 接続試行。失敗指定があれば onDown、ネットワークが落ちていれば応答なし（restore で開く）
    this.timer(() => {
      if (link.closed || link.open) return;
      if (this.failNext > 0) {
        this.failNext--;
        ev.onDown('CHANNEL_ERROR');
        return;
      }
      if (this.down) return;
      link.open = true;
      ev.onOpen();
    }, SIM_CONNECT_MS);
    return {
      send: (msg) => {
        if (link.closed || !link.open || this.down || this.frozen) return;
        this.net.deliver(this, room, msg);
      },
      close: () => {
        link.closed = true;
        link.open = false;
      },
    };
  }

  receivable(room: string): SimLink[] {
    if (this.down || this.frozen) return [];
    return this.links.filter((l) => l.room === room && l.open && !l.closed);
  }
}

export class SimNetwork {
  readonly clock = new SimClock();
  readonly log: { at: number; from: string; msg: unknown }[] = [];
  private readonly nodes: SimNodeImpl[] = [];
  private readonly rand: () => number;
  private rules: DropRule[] = [];

  constructor(opts: { seed?: number } = {}) {
    this.rand = seeded(opts.seed ?? 1);
  }

  node(id: string, cond: LinkConditions = {}): SimNode {
    const n = new SimNodeImpl(id, this, cond);
    this.nodes.push(n);
    return n;
  }

  // 条件に合うメッセージを count 件だけ確実に落とす（受信者ごとに 1 件と数える）
  dropWhere(pred: (msg: unknown, from: string, to: string) => boolean, count = 1): void {
    this.rules.push({ pred, remaining: count });
  }

  clearDrops(): void {
    this.rules = [];
  }

  // 全端末の通信条件をまとめて変える（ネットワークを正常に戻すときなど）
  setAll(cond: LinkConditions): void {
    for (const n of this.nodes) n.set(cond);
  }

  /** @internal SimNode から呼ぶ */
  deliver(from: SimNodeImpl, room: string, msg: unknown): void {
    // 実際の通信と同じく参照を共有させない（シリアライズできない値もここで検出される）
    const wire = JSON.stringify(msg);
    this.log.push({ at: this.clock.now(), from: from.id, msg: JSON.parse(wire) });
    for (const to of this.nodes) {
      if (to === from) continue;
      const rule = this.rules.find((r) => r.remaining > 0 && r.pred(JSON.parse(wire), from.id, to.id));
      if (rule) {
        rule.remaining--;
        continue;
      }
      // 送信側と受信側の条件のうち厳しい方を使う（全員に同じ条件を入れたとき、その値どおりになるように）
      const loss = Math.max(from.cond.lossRate, to.cond.lossRate);
      const latency = Math.max(from.cond.latencyMs, to.cond.latencyMs);
      const jitter = Math.max(from.cond.jitterMs, to.cond.jitterMs);
      // 乱数は条件にかかわらず毎回 2 つ引き、条件を変えても後続の乱数列がずれないようにする
      const rLoss = this.rand();
      const rJitter = this.rand();
      if (rLoss < loss) continue;
      const delay = latency + rJitter * jitter;
      this.clock.setTimeout(() => {
        for (const l of to.receivable(room)) l.ev.onMessage(JSON.parse(wire));
      }, delay);
    }
  }
}
