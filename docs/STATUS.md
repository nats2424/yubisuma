# いまの状況（引き継ぎ用）

新しいセッションで作業を再開するときは、このファイル → `docs/NORTH_STAR.md` → `docs/DECISIONS.md` → `CLAUDE.md` の順に読めば、会話の履歴なしで続きから始められる。
オーケストレーターは、区切りのよいところでこのファイルを更新する。

- 最終更新：2026-11-11（市場の見直しの最終案まで）
- 依頼の窓口：「Agent roles directory structure」セッション（オーケストレーター）に一本化。作業ブランチは `claude/agent-roles-directory-x2dzcl`
- 旧セッション「マルチプレイミニゲームサイト」は使わない（中身は PR #1 で `main` に取り込み済み）

## 終わったこと
- SUKIMA（Vite + React の Web 版）のオンライン対戦の堅牢化、不具合・セキュリティ修正、デザイン案 B の適用 → PR #1 で `main` にマージ済み（テスト 222 件通過）
- 役割ごとのエージェント体制（`.claude/agents/`、`.claude/agent-roles/`、担当範囲チェック、提案のレビュー手順）
- ターゲット・ユーザージャーニー・PMF 戦略・マーケティング計画（`docs/dev/06`〜`10`）。飲み会は狙わず、最優先は「通話しながら」と「ひとり用」
- SNS 運用計画（`marketing/sns/plan.md`）と調査（`marketing/sns/research/`）
- 組織の方向（`docs/NORTH_STAR.md`、PO 確認済み）：SUKIMA は 1 作品目で、最優先は SNS のフォロワーを増やすこと

## 進行中
- 収益目標の検討（`docs/strategy/revenue-target/`）：01 たたき台 → 02 CTO・PdM レビュー → 03 批評 → PO の回答 Q1〜Q8 → 04 Marketing の改訂 → **05 最終案（完成、PO の判断待ち：D-36〜D-40）**

- 市場と稼ぎ方の見直し（`docs/strategy/market-review/`）：**05 最終案（完成、PO の判断待ち：D-41〜D-44）**

## PO の判断待ち（詳細は `docs/DECISIONS.md`）
- D-02 ドメイン、D-17 PMF 前は収益化しない、D-18〜D-20 集客・SNS 体制・収益化の原則、D-22 ホスティング、D-25〜D-28 攻める場面・宅飲みの試遊・落ち着いた配色・広告、D-29〜D-35 SNS の立ち上げ
- 収益目標の最終案：D-36〜D-40（`docs/DECISIONS.md` の E）

## まだ手を付けていないこと
- 実機での確認（D-03：PO が手元の端末で行う）と、その後の公開（D-04）
- Supabase のプロジェクト作成（D-01：無料プランで開始）
- Cloudflare・Supabase の公式情報の確認（`docs/research/cloudflare-checklist.md`）
- ジャーニーの Must 8 件の実装（D-14 で承認済み）、録画モード、`?s=` の計測、SNS 用の画像
- 次フェーズに回した不具合：QA-BUG-03・05、状態の古い候補が引き継ぐケース
