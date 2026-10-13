import { allSubmitted, MICRO_IDS, rankByScore, startMicroRound, submitMicro, type MicroRound } from '../micro/core';
import { pick, shuffle, type GameOptions, type GamePlayer, type Scheduled } from '../types';

export type Square = 'start' | 'blue' | 'red' | 'lucky' | 'bad';

// 盤面は24マスの周回コース
export const BOARD: Square[] = [
  'start', 'blue', 'blue', 'red', 'blue', 'lucky', 'blue', 'blue',
  'red', 'blue', 'bad', 'blue',
  'blue', 'lucky', 'blue', 'red', 'blue', 'blue', 'bad', 'blue',
  'lucky', 'blue', 'red', 'blue',
];

export const START_COINS = 10;
export const STAR_COST = 20;
export const MINI_AWARDS = [10, 6, 3, 1];
const ROLL_MS = 20_000;
export const STEP_MS = 280;
const MOVED_MS = 2600;
const MINI_RESULT_MS = 5500;

// mention はプレイヤーIDで、表示時に「〇〇さん」に置き換える
export type MoveEvent = { text: string; mention?: string };
export type MoveLog = { by: string; dice: number; from: number; at: number; events: MoveEvent[] };

export type SugorokuState = {
  order: string[];
  rounds: number;
  round: number;
  turnIdx: number;
  phase: 'roll' | 'moved' | 'minigame' | 'miniResult' | 'over';
  pos: Record<string, number>;
  coins: Record<string, number>;
  stars: Record<string, number>;
  starAt: number;
  last: MoveLog | null;
  deadline: number;
  mini: MicroRound | null;
  miniAwards: Record<string, number>;
  seq: number;
};

export type SugorokuAction =
  | { type: 'roll' }
  | { type: 'submit'; result: unknown }
  | { type: 'timeout'; seq: number };

export const currentPlayer = (s: SugorokuState) => s.order[s.turnIdx];

export const standings = (s: SugorokuState) =>
  [...s.order].sort((a, b) => s.stars[b] - s.stars[a] || s.coins[b] - s.coins[a]);

const relocateStar = (exclude: number) => {
  const candidates = BOARD.map((_, i) => i).filter((i) => i !== 0 && i !== exclude);
  return pick(candidates);
};

export const init = (players: GamePlayer[], now: number, options: GameOptions = {}): SugorokuState => {
  const order = shuffle(players.map((p) => p.id));
  return {
    order,
    rounds: options.rounds ?? 8,
    round: 1,
    turnIdx: 0,
    phase: 'roll',
    pos: Object.fromEntries(order.map((id) => [id, 0])),
    coins: Object.fromEntries(order.map((id) => [id, START_COINS])),
    stars: Object.fromEntries(order.map((id) => [id, 0])),
    starAt: relocateStar(0),
    last: null,
    deadline: now + ROLL_MS,
    mini: null,
    miniAwards: {},
    seq: 0,
  };
};

// サイコロを振って進み、マスの効果を適用する（dice はテスト用に指定可）
export const roll = (s: SugorokuState, now: number, dice = 1 + Math.floor(Math.random() * 6)): SugorokuState => {
  const by = currentPlayer(s);
  const coins = { ...s.coins };
  const stars = { ...s.stars };
  const events: MoveEvent[] = [];
  let starAt = s.starAt;
  const from = s.pos[by];
  let at = from;

  for (let i = 1; i <= dice; i++) {
    at = (from + i) % BOARD.length;
    if (at === starAt) {
      if (coins[by] >= STAR_COST) {
        coins[by] -= STAR_COST;
        stars[by] += 1;
        events.push({ text: `⭐ ${STAR_COST}コインでスターをゲット！` });
        starAt = relocateStar(at);
      } else {
        events.push({ text: `⭐ スター…でもコインが足りない（${STAR_COST}必要）` });
      }
    }
  }

  const others = s.order.filter((id) => id !== by);
  switch (BOARD[at]) {
    case 'blue':
      coins[by] += 3;
      events.push({ text: '青マス：+3コイン' });
      break;
    case 'red': {
      const lost = Math.min(3, coins[by]);
      coins[by] -= lost;
      events.push({ text: `赤マス：-${lost}コイン` });
      break;
    }
    case 'lucky': {
      const kind = Math.floor(Math.random() * 3);
      if (kind === 0) {
        coins[by] += 10;
        events.push({ text: 'ラッキー！ +10コイン' });
      } else if (kind === 1) {
        let got = 0;
        for (const id of others) {
          const g = Math.min(2, coins[id]);
          coins[id] -= g;
          got += g;
        }
        coins[by] += got;
        events.push({ text: `ラッキー！ みんなから2コインずつ（+${got}）` });
      } else {
        coins[by] += dice * 2;
        events.push({ text: `ラッキー！ 出目×2で +${dice * 2}コイン` });
      }
      break;
    }
    case 'bad': {
      if (Math.random() < 0.5 || others.length === 0) {
        const lost = Math.min(8, coins[by]);
        coins[by] -= lost;
        events.push({ text: `ハプニング！ -${lost}コイン` });
      } else {
        const to = pick(others);
        const given = Math.min(5, coins[by]);
        coins[by] -= given;
        coins[to] += given;
        events.push({ text: `ハプニング！ ${given}コインをプレゼント →`, mention: to });
      }
      break;
    }
    case 'start':
      break;
  }

  return {
    ...s,
    coins,
    stars,
    starAt,
    pos: { ...s.pos, [by]: at },
    last: { by, dice, from, at: now, events },
    phase: 'moved',
    deadline: now + dice * STEP_MS + MOVED_MS,
    seq: s.seq + 1,
  };
};

const startMini = (s: SugorokuState, now: number): SugorokuState => {
  const prev = s.mini?.microId;
  const microId = pick(MICRO_IDS.filter((id) => id !== prev));
  // すごろくのミニゲームは少しゆっくりめ
  return { ...s, phase: 'minigame', mini: startMicroRound(microId, now, 0.9), miniAwards: {}, seq: s.seq + 1 };
};

const finishMini = (s: SugorokuState, now: number): SugorokuState => {
  const coins = { ...s.coins };
  const miniAwards: Record<string, number> = {};
  for (const r of rankByScore(s.mini!, s.order)) {
    const award = r.result.score > 0 ? (MINI_AWARDS[r.rank] ?? MINI_AWARDS[MINI_AWARDS.length - 1]) : 0;
    miniAwards[r.id] = award;
    coins[r.id] += award;
  }
  return { ...s, coins, miniAwards, phase: 'miniResult', deadline: now + MINI_RESULT_MS, seq: s.seq + 1 };
};

const afterMove = (s: SugorokuState, now: number): SugorokuState => {
  if (s.turnIdx + 1 < s.order.length) {
    return { ...s, turnIdx: s.turnIdx + 1, phase: 'roll', deadline: now + ROLL_MS, seq: s.seq + 1 };
  }
  return startMini(s, now);
};

export const reduce = (s: SugorokuState, a: SugorokuAction, by: string, now: number): SugorokuState => {
  switch (a.type) {
    case 'roll':
      if (s.phase !== 'roll' || by !== currentPlayer(s)) return s;
      return roll(s, now);
    case 'submit': {
      if (s.phase !== 'minigame' || !s.mini || !s.order.includes(by)) return s;
      const mini = submitMicro(s.mini, by, a.result);
      if (mini === s.mini) return s;
      const next = { ...s, mini };
      return allSubmitted(mini, s.order) ? finishMini(next, now) : next;
    }
    case 'timeout': {
      if (by !== 'system' || a.seq !== s.seq) return s;
      switch (s.phase) {
        case 'roll':
          return roll(s, now);
        case 'moved':
          return afterMove(s, now);
        case 'minigame':
          return finishMini(s, now);
        case 'miniResult':
          if (s.round >= s.rounds) return { ...s, phase: 'over' };
          return { ...s, round: s.round + 1, turnIdx: 0, phase: 'roll', deadline: now + ROLL_MS, seq: s.seq + 1 };
        default:
          return s;
      }
    }
  }
};

export const schedule = (s: SugorokuState): Scheduled<SugorokuAction> => {
  if (s.phase === 'over') return null;
  const at = s.phase === 'minigame' && s.mini ? s.mini.endsAt : s.deadline;
  return { at, action: { type: 'timeout', seq: s.seq } };
};
