import {
  LIVES,
  nextMicroId,
  resultOf,
  speedForStage,
  startMicroRound,
  submitMicro,
  type MicroRound,
} from '../micro/core';
import { TUNING } from '../micro/tuning';
import type { GameOptions, GamePlayer, Scheduled } from '../types';

// テンポの値は調整値（micro/tuning.ts）から読む。
// 通信があるので指示表示はひとり用より少し長め
const INTRO_MS = TUNING.rush.introMs;
const RESULT_MS = TUNING.rush.resultMs;
// 全員そろってから結果画面へ移るまでの間（自分の判定を見る時間）
const VERDICT_MS = TUNING.rush.verdictMs;

export type RushState = {
  order: string[];
  stage: number;
  phase: 'play' | 'result' | 'over';
  round: MicroRound;
  startLives: number;
  lives: Record<string, number>;
  // クリアしたステージ数
  cleared: Record<string, number>;
  // 直近ステージで失敗した人
  lastFailed: string[];
  until: number;
};

export type RushAction = { type: 'submit'; result: unknown } | { type: 'timeout'; stage: number } | { type: 'next' };

export const alive = (s: RushState) => s.order.filter((id) => s.lives[id] > 0);

// 順位：クリア数が多い順（同数なら残りライフ）
export const ranking = (s: RushState) =>
  [...s.order].sort((a, b) => s.cleared[b] - s.cleared[a] || s.lives[b] - s.lives[a]);

export const init = (players: GamePlayer[], now: number, options: GameOptions = {}): RushState => {
  const order = players.map((p) => p.id);
  const lives = options.lives ?? LIVES;
  return {
    order,
    stage: 1,
    phase: 'play',
    round: startMicroRound(nextMicroId(), now, speedForStage(1), INTRO_MS),
    startLives: lives,
    lives: Object.fromEntries(order.map((id) => [id, lives])),
    cleared: Object.fromEntries(order.map((id) => [id, 0])),
    lastFailed: [],
    until: 0,
  };
};

const finishStage = (s: RushState, now: number): RushState => {
  const lives = { ...s.lives };
  const cleared = { ...s.cleared };
  const lastFailed: string[] = [];
  for (const id of alive(s)) {
    if (resultOf(s.round, id).success) cleared[id] += 1;
    else {
      lives[id] -= 1;
      lastFailed.push(id);
    }
  }
  return { ...s, lives, cleared, lastFailed, phase: 'result', until: now + RESULT_MS };
};

export const reduce = (s: RushState, a: RushAction, by: string, now: number): RushState => {
  switch (a.type) {
    case 'submit': {
      if (s.phase !== 'play' || !(s.lives[by] > 0)) return s;
      const round = submitMicro(s.round, by, a.result);
      if (round === s.round) return s;
      const next = { ...s, round };
      // 全員そろったら締め切りを早める（判定を見せてから結果へ）
      if (alive(s).every((id) => id in round.results)) {
        return { ...next, round: { ...round, endsAt: Math.min(round.endsAt, now + VERDICT_MS) } };
      }
      return next;
    }
    case 'timeout':
      if (by !== 'system' || s.phase !== 'play' || a.stage !== s.stage) return s;
      return finishStage(s, now);
    case 'next': {
      if (by !== 'system' || s.phase !== 'result') return s;
      if (alive(s).length === 0) return { ...s, phase: 'over' };
      const stage = s.stage + 1;
      return {
        ...s,
        stage,
        phase: 'play',
        round: startMicroRound(nextMicroId(s.round.microId), now, speedForStage(stage), INTRO_MS),
      };
    }
  }
};

export const schedule = (s: RushState): Scheduled<RushAction> => {
  if (s.phase === 'play') return { at: s.round.endsAt, action: { type: 'timeout', stage: s.stage } };
  if (s.phase === 'result') return { at: s.until, action: { type: 'next' } };
  return null;
};

// 終了判定（結果画面・共有の表示に使う）。'result' はラウンドごとの結果で、まだ続く
export const isOver = (s: RushState): boolean => s.phase === 'over';
