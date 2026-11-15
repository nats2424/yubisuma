import type { GamePlayer, Scheduled } from '../types';

export const ROUNDS = 5;
export const PENALTY_MS = 1000;
const READY_MS = 2500;
const GO_TIMEOUT_MS = 3000;
const RESULT_MS = 5500;
// これより速い反応は見てから押していないとみなしてフライング
export const MIN_HUMAN_MS = 100;

export type Outcome = number | 'foul' | 'miss';

export type ReactionState = {
  order: string[];
  round: number;
  phase: 'ready' | 'wait' | 'go' | 'result' | 'over';
  // 現在フェーズが終わる（次へ進む）時刻
  until: number;
  current: Record<string, Outcome>;
  history: Record<string, Outcome>[];
};

export type ReactionAction = { type: 'tap'; ms: number } | { type: 'early' } | { type: 'advance' };

export const scoreOf = (o: Outcome | undefined) => (typeof o === 'number' ? o : PENALTY_MS);

export const totals = (s: ReactionState) =>
  Object.fromEntries(s.order.map((id) => [id, s.history.reduce((sum, r) => sum + scoreOf(r[id]), 0)]));

export const init = (players: GamePlayer[], now: number): ReactionState => ({
  order: players.map((p) => p.id),
  round: 1,
  phase: 'ready',
  until: now + READY_MS,
  current: {},
  history: [],
});

const finishRound = (s: ReactionState, now: number): ReactionState => {
  const current = Object.fromEntries(s.order.map((id) => [id, s.current[id] ?? 'miss'])) as Record<string, Outcome>;
  return { ...s, phase: 'result', current, history: [...s.history, current], until: now + RESULT_MS };
};

export const reduce = (s: ReactionState, a: ReactionAction, by: string, now: number): ReactionState => {
  if (a.type === 'advance') {
    if (by !== 'system') return s;
    switch (s.phase) {
      case 'ready':
        return { ...s, phase: 'wait', until: now + 1500 + Math.random() * 3000 };
      case 'wait':
        // 全員フライングしていたら即結果
        if (s.order.every((id) => id in s.current)) return finishRound(s, now);
        return { ...s, phase: 'go', until: now + GO_TIMEOUT_MS };
      case 'go':
        return finishRound(s, now);
      case 'result':
        if (s.round >= ROUNDS) return { ...s, phase: 'over' };
        return { ...s, round: s.round + 1, phase: 'ready', until: now + READY_MS, current: {} };
      default:
        return s;
    }
  }

  if (!s.order.includes(by) || by in s.current) return s;
  if (a.type === 'early') {
    if (s.phase !== 'wait' && s.phase !== 'ready') return s;
    return { ...s, current: { ...s.current, [by]: 'foul' } };
  }
  if (s.phase !== 'go') return s;
  const ms = Math.round(a.ms);
  const outcome: Outcome = !(ms >= MIN_HUMAN_MS) ? 'foul' : Math.min(ms, GO_TIMEOUT_MS);
  const next = { ...s, current: { ...s.current, [by]: outcome } };
  return s.order.every((id) => id in next.current) ? finishRound(next, now) : next;
};

export const schedule = (s: ReactionState): Scheduled<ReactionAction> =>
  s.phase === 'over' ? null : { at: s.until, action: { type: 'advance' } };

// 終了判定（結果画面・共有の表示に使う）。'result' はラウンドごとの結果で、まだ続く
export const isOver = (s: ReactionState): boolean => s.phase === 'over';

// ── 順位付け（表示用の純粋関数。View から呼ぶ） ──

// ラウンド内の並び：タイムが速い順、続いてフライング・押し忘れ（同じ扱いの中は参加順のまま）
const roundSortKey = (o: Outcome | undefined) => (typeof o === 'number' ? o : o === 'foul' ? 1e9 : 2e9);

export type RoundRow = { id: string; outcome: Outcome | undefined; rank: number | null };

// 今のラウンドの順位表。同タイムは同順位にする（1 位が 2 人いても両方「1 位」と言い合えるように）。
// フライング・押し忘れは順位なし（null）で、タイムのある人の後ろに並べる
export const roundRanking = (s: ReactionState): RoundRow[] => {
  const cur = s.current;
  const times = s.order.map((id) => cur[id]).filter((x): x is number => typeof x === 'number');
  // Array.prototype.sort は安定ソートなので、同じキーの中は参加順のまま
  return [...s.order]
    .sort((a, b) => roundSortKey(cur[a]) - roundSortKey(cur[b]))
    .map((id) => {
      const o = cur[id];
      const rank = typeof o === 'number' ? 1 + times.filter((x) => x < o).length : null;
      return { id, outcome: o, rank };
    });
};

// 今のラウンドの 1 位（同タイムなら複数）。全員ノーカウントなら空
export const roundWinners = (s: ReactionState): string[] =>
  roundRanking(s)
    .filter((r) => r.rank === 1)
    .map((r) => r.id);

// 累計の順位（合計が少ない順。同点は参加順のまま）
export const totalRanking = (s: ReactionState): string[] => {
  const total = totals(s);
  return [...s.order].sort((a, b) => total[a] - total[b]);
};
