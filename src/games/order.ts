import type { GameDef } from './types';

type PlayerRange = Pick<GameDef, 'minPlayers' | 'maxPlayers'>;

// 人数は端末から届く値なので、数でない・負の値でも例外にせず「誰もいない」として扱う（入力は信用しない）
const safeCount = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// 今の人数 n でこのゲームを始められるか（room/logic の startGame の人数判定と同じ式）
export const canPlayWith = (def: PlayerRange, n: number): boolean => {
  const c = safeCount(n);
  return c >= def.minPlayers && c <= def.maxPlayers;
};

// 「あと n 人」の表示用。足りていれば 0（多すぎる場合も 0。足りないわけではないので別の表示に任せる）
export const playersShort = (def: Pick<GameDef, 'minPlayers'>, n: number): number => Math.max(0, def.minPlayers - safeCount(n));

// 今の人数で遊べるゲームを先に並べる（J-07）。遊べるもの同士・遊べないもの同士は元の順を保つ。
// 元の配列は変えない
export const sortGamesForPlayers = <T extends PlayerRange>(defs: readonly T[], n: number): T[] => {
  const ok: T[] = [];
  const ng: T[] = [];
  for (const d of defs) (canPlayWith(d, n) ? ok : ng).push(d);
  return [...ok, ...ng];
};
