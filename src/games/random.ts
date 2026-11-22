// ゲームのロジック（ホストの init / reduce / ミニゲームの選択）が使う乱数の入口。
// ふだんは Math.random。録画モード（src/lib/recording.ts。デモモードのときだけ）では、
// シード付きの決まった乱数と、お題・ミニゲームの順の指定に差し替える。
// 乱数を各 logic.ts に直接 Math.random と書かず、ここを通すのは、SNS 用の録画で同じ展開を再現するため。
// 既定の乱数は呼ぶたびに Math.random を読む（テストが vi.spyOn(Math, 'random') で差し替えられるように）

// シード付き乱数（mulberry32）。micro/core.ts の rng もこれ
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

const mathRandom = () => Math.random();
let source: () => number = mathRandom;

// 0 以上 1 未満。差し替えた乱数が範囲外を返しても、配列の外を指さないように丸める
export const random = (): number => {
  const v = source();
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0;
};

// null で Math.random に戻す
export const setRandomSource = (fn: (() => number) | null): void => {
  source = fn ?? mathRandom;
};

// 録画の台本：お題（ワードウルフ・多数派）とラッシュのミニゲームの順。空なら指定なし（ふだんどおり乱数）
export type RecordingScript = { topics: readonly string[]; micro: readonly string[] };
const EMPTY_SCRIPT: RecordingScript = { topics: [], micro: [] };
let script: RecordingScript = EMPTY_SCRIPT;

export const setRecordingScript = (s: RecordingScript | null): void => {
  script = s ? { topics: [...s.topics], micro: [...s.micro] } : EMPTY_SCRIPT;
};
export const recordingScript = (): RecordingScript => script;
