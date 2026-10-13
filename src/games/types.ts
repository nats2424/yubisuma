import type { ComponentType } from 'react';

export type GamePlayer = { id: string; name: string };

// ゲームが時間経過で進む場合に、ホストが指定時刻に実行するアクション
export type Scheduled<A> = { at: number; action: A } | null;

export type GameViewProps<S, A> = {
  state: S;
  me: string;
  // 参加者（ゲーム開始時のメンバー）。途中参加者は観戦扱い
  players: GamePlayer[];
  online: Set<string>;
  isHost: boolean;
  send: (action: A) => void;
  // ルーム共通時計（ホスト基準）の現在時刻
  now: () => number;
};

// ゲーム定義。reduce/schedule はホストの端末上でのみ実行される純粋関数。
export interface GameDef<S = any, A = any> {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  rules: string[];
  minPlayers: number;
  maxPlayers: number;
  minutes: string;
  init: (players: GamePlayer[], now: number) => S;
  // by はプレイヤーID。タイマー由来のアクションは 'system'
  reduce: (state: S, action: A, by: string, now: number) => S;
  schedule?: (state: S) => Scheduled<A>;
  View: ComponentType<GameViewProps<S, A>>;
}

export const shuffle = <T,>(arr: readonly T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
