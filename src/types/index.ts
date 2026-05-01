// ルームのステータス型
export type RoomStatus = 'waiting' | 'playing' | 'finished';

// プレイヤーのステータス型
// waiting: 未宣言、committed: 宣言済み（未公開）、revealed: 公開済み
export type PlayerStatus = 'waiting' | 'committed' | 'revealed';

// プレイヤー型
export type Player = {
  id: string;
  name: string;
  fingers: number | null;    // 出した本数（0〜5）。revealed前はnull
  prediction: number | null; // 合計予想。revealed前はnull
  status: PlayerStatus;
  is_winner: boolean;
};

// ルーム型
export type Room = {
  id: string;
  code: string;              // 4桁のルームコード（例: "4823"）
  status: RoomStatus;
  players: Player[];
  host_id: string;           // ホストプレイヤーのID
  max_players: number;       // 最大参加人数（2〜4）
  current_round: number;     // 現在のラウンド数
};

// ナビゲーションのルートパラメータ型
export type RootStackParamList = {
  Home: undefined;
  Room: { roomCode: string; playerId: string; playerName: string };
};
