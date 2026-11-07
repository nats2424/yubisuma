// ミニゲームの調整値を 1 か所に集める入口（設計 docs/dev/02-architecture.md §7.1）。
// Phase 0 では値の置き場と小さな関数だけを用意し、core.ts などの直書きはまだ置き換えない（B-20 で移す）。
// 値は現行コードの直書きと同じにしてあるので、置き換えても挙動は変わらない。

export type MicroTuning = {
  enabled: boolean; // false ならラッシュとひとり用チャレンジの出題から外す（ADR-11）
  baseMs: number; // 基本の制限時間。大きくすると易しい
  scales: boolean; // ステージが進むと速くなるか
  params: Record<string, number>; // ゲームごとの難易度値。キー名は B-20 で action.tsx / brain.tsx を移すときに確定する
};

export type Tuning = {
  rush: { introMs: number; resultMs: number; verdictMs: number; graceMs: number };
  solo: { introMs: number };
  stage: { verdictMs: number; minPlayMs: number };
  speed: { everyStages: number; step: number; max: number };
  lives: { default: number; choices: readonly number[] };
  micro: Record<string, MicroTuning>;
};

export const TUNING = {
  rush: {
    introMs: 2400, // ラッシュの各ステージ前の「次は○○！」表示。大きくすると易しい
    resultMs: 2500, // ステージ結果の表示時間（難易度には影響しない）
    verdictMs: 1600, // 成否表示の時間（難易度には影響しない）
    graceMs: 2500, // 制限時間後に結果の到着を待つ猶予。大きくすると通信が遅くても失敗扱いになりにくい
  },
  solo: {
    introMs: 2000, // ひとり用チャレンジの開始前表示。大きくすると易しい
  },
  stage: {
    verdictMs: 1500, // MicroStage の成否表示時間（難易度には影響しない）
    minPlayMs: 800, // 遅れて始まっても最低限遊べる時間。大きくすると易しい
  },
  speed: {
    everyStages: 5, // 何ステージごとに速くなるか。大きくすると易しい
    step: 0.15, // 1 段階で上がる倍率。大きくすると難しい
    max: 2.0, // 倍率の上限。大きくすると難しい
  },
  lives: {
    default: 4, // ラッシュ・チャレンジの初期ライフ。大きくすると易しい
    choices: [3, 4, 5], // ホストが選べるライフ
  },
  micro: {
    // baseMs：大きくすると易しい。params の各値の向きは B-20 で移すときに書く
    mash: { enabled: true, baseMs: 5000, scales: true, params: { tapsPerSec: 5 } },
    stop: { enabled: true, baseMs: 5000, scales: true, params: { zoneWidthPct: 12, periodMinMs: 900, periodMaxMs: 1400 } },
    whack: { enabled: true, baseMs: 6000, scales: true, params: { needRatio: 0.6, targetLifeMinMs: 600 } },
    dodge: { enabled: true, baseMs: 6000, scales: true, params: { gapMinMs: 260, gapBaseMs: 380, fallMinMs: 1100, fallMaxMs: 1700 } },
    balloon: { enabled: true, baseMs: 6000, scales: true, params: { limitMin: 12, limitMax: 28, minTaps: 10 } },
    count: { enabled: true, baseMs: 6000, scales: true, params: { min: 5, max: 12, showMaxMs: 1600, showRatio: 0.3 } },
    color: { enabled: true, baseMs: 7000, scales: true, params: { needCorrect: 3, maxMiss: 0 } },
    math: { enabled: true, baseMs: 7000, scales: true, params: { needCorrect: 3 } },
    odd: { enabled: true, baseMs: 6000, scales: true, params: { gridSize: 25 } },
    // 時間感覚のゲームなので速くしない
    timing: { enabled: true, baseMs: 6000, scales: false, params: { targetMs: 3000, toleranceMs: 250 } },
  },
} satisfies Tuning;

// 何ステージ目か → スピード倍率。everyStages ごとに step ずつ速くなり、max で頭打ち。
// 式は core.ts の旧実装と同じ順で計算し、浮動小数の結果まで一致させる
export const speedForStage = (stage: number, t: Tuning = TUNING): number =>
  Math.min(t.speed.max, 1 + Math.floor((stage - 1) / t.speed.everyStages) * t.speed.step);

// ルール説明の文言。数値を変えたときに説明だけ古いまま残らないよう、調整値から作る
export const speedUpRuleText = (t: Tuning = TUNING): string => `${t.speed.everyStages}ステージごとにスピードアップ`;
