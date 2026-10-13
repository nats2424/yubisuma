// 瞬間ミニゲーム（数秒で終わる小さなゲーム）の共通部分。
// 各端末がローカルで遊び、結果（スコアと成否）だけをホストに送る。
// 配置などの乱数は seed から生成するので、全員が同じ問題を遊ぶ。

export type MicroResult = { score: number; success: boolean };

export type MicroMeta = {
  id: string;
  // 画面に大きく出す指示（メイドイン〜風の一言）
  title: string;
  hint: string;
  baseMs: number;
  // ラッシュで速くなるか（時間感覚のゲームなどは固定）
  scales: boolean;
};

export const MICRO_META: MicroMeta[] = [
  { id: 'mash', title: '連打！', hint: 'ボタンをとにかく連打', baseMs: 5000, scales: true },
  { id: 'stop', title: '止めろ！', hint: '針が緑のゾーンに来たらタップ', baseMs: 5000, scales: true },
  { id: 'whack', title: 'タッチ！', hint: '出てきた的をタップ', baseMs: 6000, scales: true },
  { id: 'dodge', title: 'よけろ！', hint: '指（マウス）を左右に動かして落下物をよける', baseMs: 6000, scales: true },
  { id: 'balloon', title: 'ふくらませろ！', hint: 'タップでふくらむ。割れる前にストップ', baseMs: 6000, scales: true },
  { id: 'count', title: 'かぞえろ！', hint: '一瞬だけ出るマークの数は？', baseMs: 6000, scales: true },
  { id: 'color', title: '文字の色は？', hint: '書いてある言葉ではなく「文字の色」を選ぶ', baseMs: 7000, scales: true },
  { id: 'math', title: '計算！', hint: '正しい答えを選ぶ', baseMs: 7000, scales: true },
  { id: 'odd', title: '仲間はずれ！', hint: '1つだけ違うものをタップ', baseMs: 6000, scales: true },
  { id: 'timing', title: '3秒ぴったり！', hint: 'スタートから3秒だと思ったらタップ', baseMs: 6000, scales: false },
];

export const MICRO_IDS = MICRO_META.map((m) => m.id);
export const microMeta = (id: string) => MICRO_META.find((m) => m.id === id) ?? MICRO_META[0];

// シード付き乱数（mulberry32）
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const randInt = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

// ---------- ホスト側のラウンド管理 ----------

const INTRO_MS = 2500;
// 通信遅延・時計のずれを吸収する猶予
const GRACE_MS = 2500;

export type MicroRound = {
  microId: string;
  seed: number;
  startAt: number;
  duration: number;
  endsAt: number;
  results: Record<string, MicroResult>;
};

export const startMicroRound = (microId: string, now: number, speed = 1): MicroRound => {
  const meta = microMeta(microId);
  const duration = Math.round(meta.scales ? meta.baseMs / speed : meta.baseMs);
  const startAt = now + INTRO_MS;
  return {
    microId,
    seed: Math.floor(Math.random() * 2 ** 31),
    startAt,
    duration,
    endsAt: startAt + duration + GRACE_MS,
    results: {},
  };
};

export const submitMicro = (round: MicroRound, by: string, result: unknown): MicroRound => {
  if (by in round.results || !result || typeof result !== 'object') return round;
  const { score, success } = result as Partial<MicroResult>;
  if (typeof score !== 'number' || !Number.isFinite(score)) return round;
  return {
    ...round,
    results: { ...round.results, [by]: { score: Math.max(0, Math.min(100000, Math.round(score))), success: success === true } },
  };
};

export const allSubmitted = (round: MicroRound, order: string[]) => order.every((id) => id in round.results);

export const resultOf = (round: MicroRound, id: string): MicroResult => round.results[id] ?? { score: 0, success: false };

// スコアの高い順に順位（同点は同順位）を付ける
export const rankByScore = (round: MicroRound, order: string[]): { id: string; rank: number; result: MicroResult }[] => {
  const rows = order.map((id) => ({ id, result: resultOf(round, id) }));
  rows.sort((a, b) => b.result.score - a.result.score);
  return rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.result.score === r.result.score) }));
};
