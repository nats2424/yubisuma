# いまの状況（引き継ぎ用）

新しいセッションで作業を再開するときは、このファイル → `docs/NORTH_STAR.md` → `docs/DECISIONS.md` → `CLAUDE.md` の順に読めば、会話の履歴なしで続きから始められる。
オーケストレーターは、区切りのよいところでこのファイルを更新する。

- 最終更新：2026-11-26（ブランド決定：WATTO〈確認待ち〉・一言の約束・性格。前からの判断待ちを決定。SNS 計画に型 C〈もしもストーリー〉と AI ボイス。PO が Umami 登録中〈リージョンは US を推奨〉）
- 依頼の窓口：「Agent roles directory structure」セッション（オーケストレーター）に一本化。作業ブランチは `claude/agent-roles-directory-x2dzcl`
- 旧セッション「マルチプレイミニゲームサイト」は使わない（中身は PR #1 で `main` に取り込み済み）

## 終わったこと
- SUKIMA（Vite + React の Web 版）のオンライン対戦の堅牢化、不具合・セキュリティ修正、デザイン案 B の適用 → PR #1 で `main` にマージ済み（テスト 222 件通過）
- 役割ごとのエージェント体制（`.claude/agents/`、`.claude/agent-roles/`、担当範囲チェック、提案のレビュー手順）
- ターゲット・ユーザージャーニー・PMF 戦略・マーケティング計画（`docs/dev/06`〜`10`）。飲み会は狙わず、最優先は「通話しながら」と「ひとり用」
- SNS 運用計画（`marketing/sns/plan.md`）と調査（`marketing/sns/research/`）
- 組織の方向（`docs/NORTH_STAR.md`、PO 確認済み）：SUKIMA は 1 作品目で、最優先は SNS のフォロワーを増やすこと

## 進行中
- **ブランド**（`docs/strategy/brand/05`）：D-67〜D-69 決定。名前 WATTO は PO のハンドル・J-PlatPat 確認待ち（落ちたら PATTO→DOTTO）。表示名は当面「SUKIMA｜WATTO」
- **SNS**：plan.md に型 C（もしもストーリー→SUKIMA）、AI ボイス（VOICEVOX 1 声固定の案）、note 月 1 本。PO 判断 D-70〜D-74。**次の実装**：計測の `?s=` に `note`（と Instagram を始めるなら `ig`）を追加
- PO の手作業の順：Umami 登録 → QR の読み取り確認 → WATTO の確認（50〜65 分）→ 翌週に SNS アカウント作成（2.5〜3.5 時間）→ 試遊 4 組
- D-39：専門家への相談は PO が自分で行う（AI は勝手に依頼しない）。D-40：有料に切り替える前に毎回 PO の承認
- **最小計測（J-23）**：PR #5 で main に反映（`VITE_UMAMI_WEBSITE_ID` 未設定なので送信なし）。PO が Umami に登録し Production に ID を入れたら開始（手順は 02 §14.7 の PO の手順）。送り先 gateway.umami.is・運営 Umami Software, Inc.（米国）は検索で確認済み。User-Agent の要件はブラウザ既定で足りるか、登録後の Realtime で確かめる
- **ジャンルの需要**（`docs/strategy/genre-demand/` 05 完成）：PO 判断 D-58〜D-62。Gemini の調査結果（需要・YouTube 運用の 2 本のプロンプトを PO に渡し済み）待ち。届いたら 05 に追補、YouTube の方は marketing/sns/plan.md に反映
- **YouTube ショートの運用**：Gemini の調査を反映して plan.md §7 を新設（導線はプロフィールの 1 つ目のリンク＋関連動画の横長まとめ動画、量産型対策、PO の手間は SNS 全体で週 2 時間まで）。PO 判断 D-64〜D-66。**次の実装**：録画モード（ショート制作の前提）、計測の `?s=` 許可一覧に `yt-bio`・`yt-long`（今は stream・x・tiktok・guide のみ）
- **需要の最終案に Gemini の追補**（競合 Qdan のワードウルフ公式ブラウザ版・BoardGameJoin）。D-63：見せ方の先頭をラッシュ・反射神経・多数派へ
- **SNS**：参考アカウント調査 `marketing/sns/research/2026-11-reference-accounts.md`、plan.md を対面向けに改訂。D-53 作り手の名義の名前が未定
- 環境：公開サイト・公式情報を開ける作業環境「yubisuma」を作成済み（次のセッションで選ぶと使える）
- **D-25（2026-11-15）最優先は対面のスキマ時間**（通話しながらは将来、凝ったゲームを作るときに再検討）。PdM が 06・07・08 を改訂済み。新しい改善候補は 07 §4.2（J-26〜J-36）。PO 判断待ち D-45〜D-50
- `main` に反映済み：PR #3（QR コード J-27、OGP 対面版、反射神経のラウンド結果）、PR #4（指スマ削除 D-50、ひと言ルール J-26、人数で並べる J-07）。次の推奨は 09-review.md 末尾（README の所要時間、並びの入れ替わり抑制、UnknownGame の文言、反射神経のペナルティ行など）
- 残る作業：J-23 最小計測（D-41、CTO・Security レビュー要）、07 の Should（J-28 見せる用の全画面表示など）、PdM の観察シート、marketing・sns-marketer の対面への合わせ直し
- 他ロールへの依頼（PdM より）：marketing（10 の訴求を対面へ）、sns-marketer（動画形式②を対面の手元に）、designer（06 §5.10）、qa（J-15 対面の観点・J-36）、PdM（観察シート）
- **公開**：手順書 `docs/dev/11-launch-guide.md` 完成。公開アドレス https://sukima-ee3.pages.dev/ 。PO が Supabase（無料・東京、Legacy の anon キー使用、Allow public access オン）を作成し、Cloudflare Pages で公開してトップが開けた（最初に誤って Workers で作り、Pages で作り直した）。**次は PO の実機確認（11 §3、AC-M1〜M4）**
- **公開前の改善**：J-01（OGP 画像 `public/ogp.png`・タグ）・J-02〜J-06・README の Cloudflare 化を実装し、Reviewer が Approve（`docs/dev/09-review.md`）。推奨 1〜4・6 も対応済み（`GameDef.isOver` など）。**PR #2 で `main` にマージ済み（2026-11-14、Cloudflare が自動で再公開）**。残り：J-23 最小計測（D-41 の計測と合わせて、CTO・Security レビュー要）、推奨 5（独自ドメイン移行時の確認項目を 11 に追加）
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
