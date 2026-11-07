// ミニゲームの調整値を 1 か所に集めたもの（設計 docs/dev/02-architecture.md §7.1）。
// ラッシュ・ひとり用・各ミニゲームの本体（core.ts / action.tsx / brain.tsx / MicroStage.tsx / rush/logic.ts / registry.ts）は
// ここから読むので、数値を変えるだけで反映される。値を変えたら `npm test`（validateTuning の妥当性テスト）で範囲を確かめる。
// 「大きくすると易しい / 難しい」を各値の横に書いている。難易度に関係しない見た目の係数（大きさ・配置など）は各ファイルに残している。

export type MicroTuning = {
  enabled: boolean; // false ならラッシュとひとり用チャレンジの出題から外す（ADR-11）
  baseMs: number; // 基本の制限時間。大きくすると易しい
  scales: boolean; // ステージが進むと速くなるか
  params: Record<string, number>; // ゲームごとの難易度値（下の TUNING.micro のコメント参照）
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
  // baseMs はどれも「大きくすると易しい」。scales が true のものはステージが進むと baseMs / 倍率 になる
  micro: {
    mash: {
      enabled: true,
      baseMs: 5000,
      scales: true,
      params: {
        tapsPerSec: 5, // 目標の 1 秒あたりタップ数（目標回数 = 制限時間 × これ）。大きくすると難しい
      },
    },
    stop: {
      enabled: true,
      baseMs: 5000,
      scales: true,
      params: {
        zoneWidthPct: 12, // 緑のゾーンの幅（%）。大きくすると易しい
        periodMinMs: 900, // 針の片道の時間の下限。小さくすると速くて難しい
        periodMaxMs: 1400, // 針の片道の時間の上限。小さくすると速くて難しい
      },
    },
    whack: {
      enabled: true,
      baseMs: 6000,
      scales: true,
      params: {
        needRatio: 0.6, // クリアに必要な命中率（0〜1）。大きくすると難しい
        targetLifeMinMs: 600, // 的が出ている時間の下限。大きくすると易しい
        lifeDivisor: 6, // 的が出ている時間 = 制限時間 ÷ これ（下限あり）。大きくすると的がすぐ消えて難しい
      },
    },
    dodge: {
      enabled: true,
      baseMs: 6000,
      scales: true,
      params: {
        gapMinMs: 260, // 落下物の間隔の下限。小さくすると密になって難しい
        gapBaseMs: 380, // 基本制限時間のときの落下物の間隔（速くなると比例して縮む）。小さくすると難しい
        fallMinMs: 1100, // 落ちきるまでの時間の下限。小さくすると速くて難しい
        fallMaxMs: 1700, // 落ちきるまでの時間の上限。小さくすると速くて難しい
      },
    },
    balloon: {
      enabled: true,
      baseMs: 6000,
      scales: true,
      params: {
        limitMin: 12, // 割れるまでの回数の下限（隠れている）。大きくすると易しい
        limitMax: 28, // 割れるまでの回数の上限。大きくすると易しい
        minTaps: 10, // クリアに必要な最低タップ数。大きくすると難しい（limitMin 以下にする）
      },
    },
    count: {
      enabled: true,
      baseMs: 6000,
      scales: true,
      params: {
        min: 5, // マークの数の下限。大きくすると難しい
        max: 12, // マークの数の上限。大きくすると難しい
        showMaxMs: 1600, // マークを見せる時間の上限。大きくすると易しい
        showRatio: 0.3, // マークを見せる時間 = 制限時間 × これ（上限あり）。大きくすると易しい
      },
    },
    color: {
      enabled: true,
      baseMs: 7000,
      scales: true,
      params: {
        needCorrect: 3, // クリアに必要な正解数。大きくすると難しい
        maxMiss: 0, // 許すミスの数。大きくすると易しい
      },
    },
    math: {
      enabled: true,
      baseMs: 7000,
      scales: true,
      params: {
        needCorrect: 3, // クリアに必要な正解数（かつ正解がミスより多いこと）。大きくすると難しい
      },
    },
    odd: {
      enabled: true,
      baseMs: 6000,
      scales: true,
      params: {
        gridSize: 25, // 並べる数（5×5）。大きくすると難しい。並びは CSS の 5 列なので 5 の倍数にする
      },
    },
    // 時間感覚のゲームなので速くしない
    timing: {
      enabled: true,
      baseMs: 6000,
      scales: false,
      params: {
        targetMs: 3000, // 狙う時間。指示文の「3秒」もここから作る
        toleranceMs: 250, // 許容誤差（±）。大きくすると易しい
        visibleMs: 1000, // 経過時間が見えている時間。大きくすると易しい
      },
    },
  },
} satisfies Tuning;

// 有効なミニゲームの ID（TUNING.micro の並び順）。ラッシュとひとり用チャレンジはここから出題する
export const enabledMicroIds = (t: Tuning = TUNING): string[] =>
  Object.entries(t.micro)
    .filter(([, m]) => m.enabled)
    .map(([id]) => id);

// 遊べる下限の制限時間（最高速度時）
export const MIN_PLAYABLE_MS = 2000;

// 調整値の妥当性。違反の説明（日本語）の配列を返し、空なら妥当（AC-43）。
// 数値を変えたときに「速すぎて遊べない」「出題できない」などの壊れ方をテストで機械的に見つけるため
export function validateTuning(t: Tuning): string[] {
  const errors: string[] = [];
  const positive = (path: string, v: number) => {
    if (!(Number.isFinite(v) && v > 0)) errors.push(`${path} は正の数にしてください（今は ${v}）`);
  };
  for (const [group, values] of [
    ['rush', t.rush],
    ['solo', t.solo],
    ['stage', t.stage],
  ] as const) {
    for (const [k, v] of Object.entries(values)) positive(`${group}.${k}`, v);
  }

  if (!(Number.isInteger(t.speed.everyStages) && t.speed.everyStages >= 1)) errors.push(`speed.everyStages は 1 以上の整数にしてください（今は ${t.speed.everyStages}）`);
  if (!(t.speed.step > 0)) errors.push(`speed.step は正の数にしてください（今は ${t.speed.step}）`);
  if (!(t.speed.max >= 1)) errors.push(`speed.max は 1 以上にしてください（今は ${t.speed.max}）`);

  if (!t.lives.choices.every((c) => Number.isInteger(c) && c >= 1)) errors.push('lives.choices は 1 以上の整数だけにしてください');
  if (!t.lives.choices.includes(t.lives.default)) errors.push(`lives.default（${t.lives.default}）が lives.choices に含まれていません`);

  const ids = Object.keys(t.micro);
  if (enabledMicroIds(t).length < 2) errors.push('有効なミニゲーム（enabled: true）は 2 種類以上にしてください（同じゲームが続かないようにするため）');
  for (const id of ids) {
    const m = t.micro[id];
    positive(`micro.${id}.baseMs`, m.baseMs);
    // 最高速度時の制限時間（startMicroRound と同じ丸め）
    const fastest = Math.round(m.scales ? m.baseMs / t.speed.max : m.baseMs);
    if (fastest < MIN_PLAYABLE_MS) {
      errors.push(`micro.${id}: 最高速度（×${t.speed.max}）の制限時間が ${fastest}ms で、${MIN_PLAYABLE_MS}ms 未満です`);
    }
    for (const [k, v] of Object.entries(m.params)) {
      if (!Number.isFinite(v)) errors.push(`micro.${id}.params.${k} が数値ではありません`);
      else if (k.endsWith('Ms')) positive(`micro.${id}.params.${k}`, v);
      if (k.endsWith('Ratio') && !(v > 0 && v <= 1)) errors.push(`micro.${id}.params.${k} は 0 より大きく 1 以下にしてください（今は ${v}）`);
      // xxxMin / xxxMinMs / min と、対になる Max の大小
      const maxKey = k === 'min' ? 'max' : k.includes('Min') ? k.replace('Min', 'Max') : null;
      if (maxKey && maxKey in m.params && v > m.params[maxKey]) {
        errors.push(`micro.${id}.params: ${k}（${v}）が ${maxKey}（${m.params[maxKey]}）より大きくなっています`);
      }
    }
  }
  return errors;
}

// 何ステージ目か → スピード倍率。everyStages ごとに step ずつ速くなり、max で頭打ち。
// 式は core.ts の旧実装と同じ順で計算し、浮動小数の結果まで一致させる
export const speedForStage = (stage: number, t: Tuning = TUNING): number =>
  Math.min(t.speed.max, 1 + Math.floor((stage - 1) / t.speed.everyStages) * t.speed.step);

// ルール説明の文言。数値を変えたときに説明だけ古いまま残らないよう、調整値から作る
export const speedUpRuleText = (t: Tuning = TUNING): string => `${t.speed.everyStages}ステージごとにスピードアップ`;
