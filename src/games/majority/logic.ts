import { shuffle, type GameOptions, type GamePlayer, type Scheduled } from '../types';
import { recordingScript } from '../random';
import { QUESTIONS, type Question } from './questions';

export const ROUNDS = 5;
const ANSWER_MS = 25_000;
const REVEAL_MS = 8_000;

export type Choice = 'a' | 'b';

export type MajorityState = {
  order: string[];
  rounds: number;
  questions: Question[];
  round: number;
  phase: 'answer' | 'reveal' | 'over';
  until: number;
  answers: Record<string, Choice>;
  scores: Record<string, number>;
  // 直近ラウンドの多数派（同数なら null）
  majority: Choice | null;
};

export type MajorityAction = { type: 'answer'; choice: Choice } | { type: 'next' };

// 出題を選ぶ。topics（録画の台本）に問題文（q）と一致するものがあれば、その順で先頭に並べ、
// 残りは乱数で埋める。一致しないお題は無視する
export const pickQuestions = (rounds: number, topics: readonly string[] = []): Question[] => {
  const fixed: Question[] = [];
  for (const t of topics) {
    const q = QUESTIONS.find((x) => x.q === t);
    if (q && !fixed.includes(q)) fixed.push(q);
  }
  const rest = shuffle(QUESTIONS.filter((q) => !fixed.includes(q)));
  return [...fixed, ...rest].slice(0, rounds);
};

export const init = (players: GamePlayer[], now: number, options: GameOptions = {}): MajorityState => {
  const order = players.map((p) => p.id);
  const rounds = Math.min(options.rounds ?? ROUNDS, QUESTIONS.length);
  return {
    order,
    rounds,
    questions: pickQuestions(rounds, recordingScript().topics),
    round: 1,
    phase: 'answer',
    until: now + ANSWER_MS,
    answers: {},
    scores: Object.fromEntries(order.map((id) => [id, 0])),
    majority: null,
  };
};

const reveal = (s: MajorityState, now: number): MajorityState => {
  const votes = Object.values(s.answers);
  const a = votes.filter((v) => v === 'a').length;
  const b = votes.filter((v) => v === 'b').length;
  const majority: Choice | null = a === b ? null : a > b ? 'a' : 'b';
  const scores = { ...s.scores };
  if (majority) s.order.forEach((id) => s.answers[id] === majority && (scores[id] += 1));
  return { ...s, phase: 'reveal', until: now + REVEAL_MS, majority, scores };
};

export const reduce = (s: MajorityState, act: MajorityAction, by: string, now: number): MajorityState => {
  if (act.type === 'next') {
    if (s.phase === 'answer' && by === 'system') return reveal(s, now);
    if (s.phase !== 'reveal') return s;
    if (s.round >= s.rounds) return { ...s, phase: 'over' };
    return { ...s, round: s.round + 1, phase: 'answer', until: now + ANSWER_MS, answers: {}, majority: null };
  }
  if (s.phase !== 'answer' || !s.order.includes(by) || (act.choice !== 'a' && act.choice !== 'b')) return s;
  const next = { ...s, answers: { ...s.answers, [by]: act.choice } };
  return s.order.every((id) => id in next.answers) ? reveal(next, now) : next;
};

export const schedule = (s: MajorityState): Scheduled<MajorityAction> =>
  s.phase === 'over' ? null : { at: s.until, action: { type: 'next' } };

// 終了判定（結果画面・共有の表示に使う）
export const isOver = (s: MajorityState): boolean => s.phase === 'over';
