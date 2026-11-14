# SUKIMA — 開発ガイド

隙間時間のブラウザミニゲーム集（大人中心）。部屋を作って URL を送り、友達と遊ぶ。私たちの 1 作品目（方向は `docs/NORTH_STAR.md`）。
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

## エージェント運用（オーケストレーター向け）

**すべての役割は、仕事の前に `docs/NORTH_STAR.md`（ビジョン・SUKIMA の役割・制約・判断の優先順位）を読む。**

役割ごとのサブエージェントを `.claude/agents/<役割>.md` に定義している。役割の中身（責務・判断基準）は `.claude/agent-roles/<役割>.md`。

### 担当範囲と道具

| 役割 | 編集してよいファイル | 道具 | 作業場所 |
| --- | --- | --- | --- |
| backend | `src/lib/**`、`src/room/**`、`src/games/**/*.ts`、`src/__tests__/**`、`docs/dev/02` §13、04/05/09 の担当票 | 読み・書き・Bash | worktree |
| client | `src/components/**`、`src/App.tsx`、`src/main.tsx`、`src/styles.css`、`src/games/**/*.tsx`、`index.html`、`public/**`、`README.md`、`design/implemented/**`、04/05/09 の担当票 | 読み・書き・Bash | worktree |
| qa | `src/__tests__/qa-*.test.ts`、`docs/dev/04-qa-report.md` | 読み・書き・Bash | worktree |
| security | `src/__tests__/security-*.test.ts`、`docs/dev/05-security-report.md` | 読み・書き・Bash | worktree |
| designer | `design/**`（`design/implemented/` を除く） | 読み・書き・Bash | worktree |
| pdm | `docs/dev/01`・`06`・`07`・`08`、`docs/strategy/<テーマ>/NN-pdm-*.md` | 読み・書き（Bash なし） | ルート |
| cto | `docs/dev/02-architecture.md`、`docs/dev/11-launch-guide.md`（公開の手順書）、`docs/strategy/<テーマ>/NN-cto-*.md`（`src/room/types.ts` の変更承認） | 読み・書き（Bash なし） | ルート |
| pjm | `docs/dev/03-wbs.md`、`docs/strategy/<テーマ>/NN-pjm-*.md` | 読み・書き（Bash なし） | ルート |
| marketing | `docs/dev/10-marketing-monetization.md`、`docs/strategy/<テーマ>/NN-marketing-*.md` | 読み・書き（Bash なし） | ルート |
| sns-marketer | `marketing/sns/**`（投稿パック・動画・録画スクリプト） | 読み・書き・Bash（投稿はしない） | worktree |
| strategy-manager | `docs/strategy/<テーマ>/NN-strategy-manager-*.md` | 読み・書き（Bash なし） | ルート |
| reviewer | なし（結果は報告で返し、オーケストレーターが `docs/dev/09-review.md` に保存） | 読み・Bash（編集なし） | ルート |
| オーケストレーター | `CLAUDE.md`、`.claude/**`、`docs/NORTH_STAR.md`、`docs/STATUS.md`、`docs/DECISIONS.md`、`docs/strategy/*/00-brief.md`、`vite.config.ts`、`package.json`、`.gitignore` | すべて | ルート |

### 手順

1. **コードを書く役割（backend・client・qa・security・designer・sns-marketer）は、1 人で動かすときも必ず `isolation: worktree` で起動する。** メインの作業フォルダで直接編集させない。
2. 資料だけを書く役割（pdm・cto・pjm・marketing・strategy-manager）と reviewer はルートで動かしてよい。
3. マージの前に担当範囲を確認する：`python3 .claude/scripts/check-scope.py <役割> <base>..<worktree のブランチ>`。範囲外の変更があれば、理由を確かめてから取り込むか差し戻す。
4. マージ後に `npm run typecheck`・`npm test`・`npm run build` を通してから push し、worktree とブランチを消す。
5. 道具の制限は「どの道具を使えるか」までで、Write/Edit がどのファイルを書けるかまでは縛れない。範囲の確認は手順 3 で行う。
6. 使用量の上限に当たらないよう、同時に動かすサブエージェントは 2 つまでにする。
7. プロダクトオーナーの判断が必要な事項は `docs/DECISIONS.md` に追記し、通知する。
8. 区切りのよいところで `docs/STATUS.md`（引き継ぎ用の現況）を更新する。会話が長くなったら、新しいセッションで STATUS → NORTH_STAR → DECISIONS → CLAUDE.md を読んで再開できるようにしておく。

### 提案のレビュー手順（数字や戦略を含む提案）

収益目標・価格・KPI・公開判断など、数字や戦略を含む提案は、オーケストレーターが 1 人で答えず、次の流れを通してからプロダクトオーナーに出す。資料は `docs/strategy/<テーマ>/` に番号順に置く。

1. `00-brief.md`：オーケストレーターが、問い・前提・PO の発言・制約を書く
2. `01-<担当>-draft.md`：担当の役割がたたき台を書く（例：収益なら marketing）
3. `02-<役割>-review.md`：関係する役割がそれぞれの立場でレビューする（費用は cto、PMF との整合は pdm など。同時に 2 つまで）
4. `03-strategy-manager-critique.md`：戦略マネージャーが、たたき台とレビューをまとめて批評する
5. `04-<担当>-revised.md`：担当の役割が指摘を受けて直す（必要なら 3〜4 をもう 1 往復）
6. `05-strategy-manager-final.md`：戦略マネージャーが最終案・幅・確度・残った論点・PO 判断事項をまとめる
7. オーケストレーターが確認してプロダクトオーナーに出し、判断事項を `docs/DECISIONS.md` に追記する

使用量が増えるので、対象は重要な提案に絞る。軽い質問はオーケストレーターが答えてよいが、その場合は「レビューを通していない」と明記する。
