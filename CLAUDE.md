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

- `src/lib/transport.ts` — 通信層（Supabase Broadcast / 未設定時は BroadcastChannel のデモモード）
- `src/room/` — ルーム状態（`logic.ts` は純粋関数）と同期フック（`useRoom.ts`）
- `src/games/<id>/{logic.ts, View.tsx}` — 各ゲーム。`src/games/registry.ts` に登録する
- `src/games/micro/` — 瞬間ミニゲーム（ラッシュ・ひとり用チャレンジで使用）
- `src/components/` — 画面（Home / Room / Practice など）
- `src/__tests__/` — テスト

## コーディング規約

- **ホスト権威型**：ゲーム状態の更新はホスト端末の `reduce` / `schedule` だけが行う。View は `send(action)` で操作を送るだけ。
- **純粋関数**：`reduce` / `schedule` / `init` 以外のロジック関数も含め、`src/room/logic.ts` と各 `logic.ts` に副作用（DOM・ストレージ・通信・`Date.now()`）を入れない。時刻は引数の `now` を使う。乱数は `init` や `reduce` 内で使ってよい（ホストでのみ実行されるため）。
- **入力は信用しない**：他端末から届くメッセージ・アクションは形と権限を検証し、不正なものは状態を変えずに無視する（例外を投げない）。
- **型**：`any` は `GameDef` の汎用部分以外で使わない。受信データは `unknown` で受けて絞り込む。
- **UI**：スマホ（幅 360px 程度）で崩れないこと。表示文言は日本語。ユーザー入力（名前・チャット）は React のテキストとして描画し、`dangerouslySetInnerHTML` は使わない。
- **テスト**：ロジックを変えたら `src/__tests__/` に単体テストを追加する。
- **コメント**：日本語で、「なぜそうするか」を書く。
- **秘密情報**：`.env.local` はコミットしない。クライアントに含めてよいのは Supabase の anon キーだけ。
