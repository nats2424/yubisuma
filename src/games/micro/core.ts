// 瞬間ミニゲーム（数秒で終わる小さなゲーム）の共通部分。
// 各端末がローカルで遊び、結果（スコアと成否）だけをホストに送る。
// 配置などの乱数は seed から生成するので、全員が同じ問題を遊ぶ。
import { enabledMicroIds, speedForStage, TUNING, type MicroTuning, type Tuning } from './tuning';

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

// 表示用の文言だけをここに持ち、制限時間（baseMs / scales）は調整値 TUNING.micro から合成する
const TIMING_SEC = TUNING.micro.timing.params.targetMs / 1000;
// id を TUNING.micro のキーで型付けし、調整値のないミニゲームを足したら型エラーで気づけるようにする（R-06）
type MicroId = keyof typeof TUNING.micro;
const MICRO_TEXT: (Pick<MicroMeta, 'title' | 'hint'> & { id: MicroId })[] = [
  { id: 'mash', title: '連打！', hint: 'ボタンをとにかく連打' },
  { id: 'stop', title: '止めろ！', hint: '針が緑のゾーンに来たらタップ' },
  { id: 'whack', title: 'タッチ！', hint: '出てきた的をタップ' },
  { id: 'dodge', title: 'よけろ！', hint: '指（マウス）を左右に動かして落下物をよける' },
  { id: 'balloon', title: 'ふくらませろ！', hint: 'タップでふくらむ。割れる前にストップ' },
  { id: 'count', title: 'かぞえろ！', hint: '一瞬だけ出るマークの数は？' },
  { id: 'color', title: '文字の色は？', hint: '書いてある言葉ではなく「文字の色」を選ぶ' },
  { id: 'math', title: '計算！', hint: '正しい答えを選ぶ' },
  { id: 'odd', title: '仲間はずれ！', hint: '1つだけ違うものをタップ' },
  { id: 'timing', title: `${TIMING_SEC}秒ぴったり！`, hint: `スタートから${TIMING_SEC}秒だと思ったらタップ` },
];

export const MICRO_META: MicroMeta[] = MICRO_TEXT.map((m) => {
  const t: MicroTuning = TUNING.micro[m.id];
  return { ...m, baseMs: t.baseMs, scales: t.scales };
});

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

export const LIVES = TUNING.lives.default;

// 何ステージ目か → スピード倍率（調整値は tuning.ts。既存の import のためにここからも公開する）
export { speedForStage };

// 直前と同じゲームが続かないように次のゲームを選ぶ。enabled: false のミニゲームは出さない
export const nextMicroId = (prev?: string, t: Tuning = TUNING) => {
  const enabled = new Set(enabledMicroIds(t));
  const pool = MICRO_IDS.filter((id) => id !== prev && enabled.has(id));
  return pool[Math.floor(Math.random() * pool.length)];
};

export type MicroRound = {
  microId: string;
  seed: number;
  startAt: number;
  duration: number;
  endsAt: number;
  results: Record<string, MicroResult>;
};

export const startMicroRound = (microId: string, now: number, speed = 1, introMs: number = TUNING.rush.introMs): MicroRound => {
  const meta = microMeta(microId);
  const duration = Math.round(meta.scales ? meta.baseMs / speed : meta.baseMs);
  const startAt = now + introMs;
  return {
    microId,
    seed: Math.floor(Math.random() * 2 ** 31),
    startAt,
    duration,
    // 通信遅延・時計のずれを吸収する猶予
    endsAt: startAt + duration + TUNING.rush.graceMs,
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
