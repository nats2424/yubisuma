# SUKIMA — 開発ガイド

大人向け・隙間時間のブラウザミニゲーム集。部屋を作って URL を送り、友達と遊ぶ。
スタック：Vite + React 19 + TypeScript（strict）/ Supabase Realtime Broadcast（DB テーブルなし）/ vitest。

## コマンド

- `npm run dev` — 開発サーバー
- `npm run typecheck` — 型チェック
- `npm test` — テスト（vitest）
- `npm run build` — 本番ビルド

変更後は `typecheck` / `test` / `build` がすべて通ること。

## 構成

- `src/lib/transport.ts` — 通信層。`Link`（1 回分の接続：Supabase Broadcast / 未設定時は BroadcastChannel のデモモード）と `ManagedTransport`（connecting / connected / reconnecting / failed の状態機械・リトライ・再接続）
- `src/lib/clock.ts` — 時計とタイマーの抽象（本番は `realClock`、テストは疑似ネットワークの仮想時計）
- `src/room/types.ts` — Client との契約型（`RoomHandle` / `RoomStatus` / `ConnectionStatus`）。変更には CTO の承認が要る
- `src/room/logic.ts` — ルーム状態の純粋関数（`reduceRoom` / `acceptAction` / `chatBlockedUntil` など）
- `src/room/protocol.ts` — 通信メッセージ（`v: 2`）の型と検証（`parseWireMessage` など）・レート制限の純粋関数
- `src/room/engine.ts` — `RoomEngine`：受信処理・tick・ホスト引き継ぎ・同期要求・未確認アクションの再送・配信間引き。React に依存せず、通信・時計・ストレージを注入する
- `src/room/useRoom.ts` — engine を作って購読する薄いフック（ブラウザイベントの配線だけ）
- `src/games/<id>/{logic.ts, View.tsx}` — 各ゲーム。`src/games/registry.ts` に登録する
- `src/games/micro/` — 瞬間ミニゲーム（ラッシュ・ひとり用チャレンジで使用）。テンポ・難易度の数値は `tuning.ts` に集め、各ファイルに直書きしない（`validateTuning` の妥当性テストあり）
- `src/components/` — 画面（Home / Room / Practice など）
- `src/__tests__/` — テスト。`sim/` は疑似ネットワーク（`network.ts`：遅延・欠落・切断・スリープをシード付き乱数と仮想時刻で再現）と複数端末の組み立て（`harness.ts`）。通信のテストは実時間・`Date.now()`・`vi.useFakeTimers` を使わず、決定的に書く

## コーディング規約

- **ホスト権威型**：ゲーム状態の更新はホスト端末の `reduce` / `schedule` だけが行う。View は `send(action)` で操作を送るだけ。
- **純粋関数**：`reduce` / `schedule` / `init` 以外のロジック関数も含め、`src/room/logic.ts` と各 `logic.ts` に副作用（DOM・ストレージ・通信・`Date.now()`）を入れない。時刻は引数の `now` を使う。乱数は `init` や `reduce` 内で使ってよい（ホストでのみ実行されるため）。
- **入力は信用しない**：他端末から届くメッセージ・アクションは形と権限を検証し、不正なものは状態を変えずに無視する（例外を投げない）。
- **型**：`any` は `GameDef` の汎用部分以外で使わない。受信データは `unknown` で受けて絞り込む。
- **UI**：スマホ（幅 360px 程度）で崩れないこと。表示文言は日本語。ユーザー入力（名前・チャット）は React のテキストとして描画し、`dangerouslySetInnerHTML` は使わない。
- **テスト**：ロジックを変えたら `src/__tests__/` に単体テストを追加する。
- **コメント**：日本語で、「なぜそうするか」を書く。
- **秘密情報**：`.env.local` はコミットしない。クライアントに含めてよいのは Supabase の anon キーだけ。
