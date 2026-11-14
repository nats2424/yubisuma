# いまの状況（引き継ぎ用）

新しいセッションで作業を再開するときは、このファイル → `docs/NORTH_STAR.md` → `docs/DECISIONS.md` → `CLAUDE.md` の順に読めば、会話の履歴なしで続きから始められる。
オーケストレーターは、区切りのよいところでこのファイルを更新する。

- 最終更新：2026-11-14（Supabase 作成・Cloudflare Pages で初公開。実機確認待ち）
- 依頼の窓口：「Agent roles directory structure」セッション（オーケストレーター）に一本化。作業ブランチは `claude/agent-roles-directory-x2dzcl`
- 旧セッション「マルチプレイミニゲームサイト」は使わない（中身は PR #1 で `main` に取り込み済み）

## 終わったこと
- SUKIMA（Vite + React の Web 版）のオンライン対戦の堅牢化、不具合・セキュリティ修正、デザイン案 B の適用 → PR #1 で `main` にマージ済み（テスト 222 件通過）
- 役割ごとのエージェント体制（`.claude/agents/`、`.claude/agent-roles/`、担当範囲チェック、提案のレビュー手順）
- ターゲット・ユーザージャーニー・PMF 戦略・マーケティング計画（`docs/dev/06`〜`10`）。飲み会は狙わず、最優先は「通話しながら」と「ひとり用」
- SNS 運用計画（`marketing/sns/plan.md`）と調査（`marketing/sns/research/`）
- 組織の方向（`docs/NORTH_STAR.md`、PO 確認済み）：SUKIMA は 1 作品目で、最優先は SNS のフォロワーを増やすこと

## 進行中
- **公開**：手順書 `docs/dev/11-launch-guide.md` 完成。公開アドレス https://sukima-ee3.pages.dev/ 。PO が Supabase（無料・東京、Legacy の anon キー使用、Allow public access オン）を作成し、Cloudflare Pages で公開してトップが開けた（最初に誤って Workers で作り、Pages で作り直した）。**次は PO の実機確認（11 §3、AC-M1〜M4）**
- 申し送り（CTO の報告より）：①新形式の publishable キー対応（Backend、旧 anon キーは 2026 年末ごろ廃止予定）②Supabase 無料の 7 日停止がデータベース未使用でも起きるか要確認 ③README を Cloudflare Pages の手順に更新（Client）④手順書に Workers と Pages の見分け方を目立たせる（CTO）⑤`.nvmrc` 追加は任意
- 収益目標の検討（`docs/strategy/revenue-target/`）：01 たたき台 → 02 CTO・PdM レビュー → 03 批評 → PO の回答 Q1〜Q8 → 04 Marketing の改訂 → **05 最終案（完成、PO の判断待ち：D-36〜D-40）**

- 市場と稼ぎ方の見直し（`docs/strategy/market-review/`）：**05 最終案（完成、PO の判断待ち：D-41〜D-44）**

## 決まったこと（2026-11-14）
- 方向の 6 件を承認：D-36 SNS は作り手の名義／D-37 1 年目はフォロワー 3,000・週 10 部屋（お金の目標なし）／D-38 営業なし・応援メンバーが本命候補・PMF 前は課金しない／D-41 2 作品目の前に SUKIMA で需要を測る／D-42 URL で入る人は誰も払わない／D-44 広告は最後の手段
- D-22 公開先は Cloudflare Pages
- D-02 当面は無料の `○○.pages.dev`。需要が見えてから独自ドメインを検討

## PO の判断待ち（詳細は `docs/DECISIONS.md`）
- D-02 ドメイン、D-17 PMF 前は収益化しない、D-18〜D-20 集客・SNS 体制・収益化の原則、D-22 ホスティング、D-25〜D-28 攻める場面・宅飲みの試遊・落ち着いた配色・広告、D-29〜D-35 SNS の立ち上げ
- 収益目標の最終案：D-36〜D-40（`docs/DECISIONS.md` の E）

## まだ手を付けていないこと
- 実機での確認（D-03：PO が手元の端末で行う）と、その後の公開（D-04）
- Supabase のプロジェクト作成（D-01：無料プランで開始）
- Cloudflare・Supabase の公式情報の確認（`docs/research/cloudflare-checklist.md`）
- ジャーニーの Must 8 件の実装（D-14 で承認済み）、録画モード、`?s=` の計測、SNS 用の画像
- 次フェーズに回した不具合：QA-BUG-03・05、状態の古い候補が引き継ぐケース

## 次にやること（2026-11-14 時点。新しいセッションへの引き継ぎ）
1. **公開の手順書**：PO が自分で行う Supabase のプロジェクト作成（無料プラン、Realtime の「Private channels only」をオフ）と、Cloudflare Pages での公開（GitHub 連携、環境変数 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`、ビルドコマンド `npm run build`、出力 `dist`）を、PO 向けにやさしい手順書にする。あわせて、実機での確認（D-03、AC-M1〜M5）の手順も用意する。公式情報を確かめられない部分は `docs/research/cloudflare-checklist.md` のとおり「要確認」と書く
2. **公開前に入れる改善 8 件**（`docs/dev/07-user-journey.md` の Must、D-14 で承認済み）：LINE に貼ったときのプレビュー画像（OGP）、共有文、結果画面の「次へ」、1 人のロビーの招待導線など。役割ごとのエージェント（client・backend・designer → qa → reviewer）で進める
3. **需要を測る仕組み**（D-41）：V-1〜V-3 のための最小限の計測（匿名の計測は D-12 で承認済み）
4. **PO に聞くこと**：D-40（Supabase を月 5,000 円までなら一時的に有料にしてよいか）、D-02 の理由（PO が共有予定）、残りの判断待ち
