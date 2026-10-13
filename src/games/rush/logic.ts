import {
  allSubmitted,
  MICRO_IDS,
  rankByScore,
  resultOf,
  startMicroRound,
  submitMicro,
  type MicroRound,
} from '../micro/core';
import { shuffle, type GameOptions, type GamePlayer, type Scheduled } from '../types';

const RESULT_MS = 4000;
// ステージごとに速くなる割合
const SPEEDUP = 0.07;

export type RushState = {
  order: string[];
  playlist: string[];
  stage: number;
  phase: 'play' | 'result' | 'over';
  round: MicroRound;
  points: Record<string, number>;
  // 直近ステージで成功した人・トップボーナスを得た人
  lastSuccess: string[];
  lastTop: string[];
  until: number;
};

export type RushAction = { type: 'submit'; result: unknown } | { type: 'timeout'; stage: number } | { type: 'next' };

export const speedAt = (stage: number) => 1 + (stage - 1) * SPEEDUP;

export const init = (players: GamePlayer[], now: number, options: GameOptions = {}): RushState => {
  const order = players.map((p) => p.id);
  const stages = options.stages ?? 10;
  // 同じゲームが続かないよう、一巡ずつシャッフルしてつなげる
  const playlist: string[] = [];
  while (playlist.length < stages) playlist.push(...shuffle(MICRO_IDS));
  return {
    order,
    playlist: playlist.slice(0, stages),
    stage: 1,
    phase: 'play',
    round: startMicroRound(playlist[0], now, speedAt(1)),
    points: Object.fromEntries(order.map((id) => [id, 0])),
    lastSuccess: [],
    lastTop: [],
    until: 0,
  };
};

const finishStage = (s: RushState, now: number): RushState => {
  const success = s.order.filter((id) => resultOf(s.round, id).success);
  // 成功者の中でスコア最上位に +1 ボーナス
  const ranked = rankByScore(s.round, success);
  const top = ranked.filter((r) => r.rank === 0 && r.result.score > 0).map((r) => r.id);
  const points = { ...s.points };
  success.forEach((id) => (points[id] += 1));
  if (success.length > 1) top.forEach((id) => (points[id] += 1));
  return {
    ...s,
    phase: 'result',
    points,
    lastSuccess: success,
    lastTop: success.length > 1 ? top : [],
    until: now + RESULT_MS,
  };
};

export const reduce = (s: RushState, a: RushAction, by: string, now: number): RushState => {
  switch (a.type) {
    case 'submit': {
      if (s.phase !== 'play' || !s.order.includes(by)) return s;
      const round = submitMicro(s.round, by, a.result);
      if (round === s.round) return s;
      const next = { ...s, round };
      return allSubmitted(round, s.order) ? finishStage(next, now) : next;
    }
    case 'timeout':
      if (by !== 'system' || s.phase !== 'play' || a.stage !== s.stage) return s;
      return finishStage(s, now);
    case 'next': {
      if (by !== 'system' || s.phase !== 'result') return s;
      if (s.stage >= s.playlist.length) return { ...s, phase: 'over' };
      const stage = s.stage + 1;
      return { ...s, stage, phase: 'play', round: startMicroRound(s.playlist[stage - 1], now, speedAt(stage)) };
    }
  }
};

export const schedule = (s: RushState): Scheduled<RushAction> => {
  if (s.phase === 'play') return { at: s.round.endsAt, action: { type: 'timeout', stage: s.stage } };
  if (s.phase === 'result') return { at: s.until, action: { type: 'next' } };
  return null;
};
