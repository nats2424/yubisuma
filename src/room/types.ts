// Backend と Client の契約型（設計 docs/dev/02-architecture.md §9.3）。
// Client はこの型だけを頼りに画面を作るので、変更には CTO の承認が要る
import type { ConnectionStatus } from '../lib/transport';
import type { RoomAction, RoomState } from './logic';

export type { ConnectionStatus };

// 画面の種類。Room.tsx はこれで分岐する
export type RoomStatus =
  | 'connecting' // 初回接続中、または部屋の状態を待っている →「接続中…」
  | 'failed'     // 接続できない（自動リトライ後）→「接続できませんでした」+「再試行」(retry)
  | 'notfound'   // 接続できたがホストから状態が来ない →「部屋 XXXX が見つかりません」
  | 'full'       // 満員 →「この部屋は満員です（最大 10 人）」+「トップへ」
  | 'ready'      // 通常画面（state は必ず非 null）
  | 'left'       // 自分で退出した
  | 'kicked';    // ホストに外された（MVP では left と同じ表示で可）

export type RoomHandle = {
  status: RoomStatus;
  // 通信状態。status === 'ready' かつ connection !== 'connected' のとき「再接続中…」の帯を出す
  connection: ConnectionStatus;
  state: RoomState | null;
  me: string;
  isHost: boolean;
  // オンラインのメンバー ID（自分を含む）。GameViewProps.online にそのまま渡せるよう Set のまま
  online: Set<string>;
  // ホストならローカル即時適用、参加者なら seq 付きで送信・自動再送
  dispatch: (action: RoomAction) => void;
  // ルーム共通時計（ホスト基準）の現在時刻
  now: () => number;
  leave: () => void;
  // failed / notfound からページ再読み込みなしで接続し直す
  retry: () => void;
};
