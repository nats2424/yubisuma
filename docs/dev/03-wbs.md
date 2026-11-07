# 03. WBS（職種別タスク分解）— オンライン対戦の実用化（MVP Must）

- 作成：PjM（2026-11-07）
- 入力：`docs/dev/01-pdm-spec.md`（以下「PdM 仕様」、AC-xx）、`docs/dev/02-architecture.md`（以下「設計」、§番号）、`CLAUDE.md`、現行コード
- 範囲：PdM 仕様 5 章の Must（MVP-1〜11）。Should（MVP-12〜15）は設計どおり入れない。例外は設計 ADR-11 の 2 点（`RoomStatus` の `'kicked'`、`MicroTuning.enabled`）だけで、AC-45 のテストは手間がかからないので B-20 で書く
- 職種：Backend（B）/ Client（C）/ QA（Q）/ Security（S）/ Reviewer（R）。職種ごとに別のサブエージェントが担当する
- 粒度：1 タスク = 1 コミットで終わり、確かめられる大きさ（PjM の判断基準）

---

## 0. 要約

| Phase | 担当 | タスク数 | 終わったと言える条件（マイルストーン） |
| --- | --- | --- | --- |
| Phase 0 | Backend 単独 | 4（B-01〜B-04） | **M0**：契約の型・暫定 `useRoom`・`chatBlockedUntil`・`TUNING` がそろい、`typecheck` / `test` / `build` が通る。ここから Client が着手できる |
| Phase 1 | Backend と Client が並列 | Backend 12（B-10〜B-21）、Client 7（C-01〜C-07） | **M1**：設計 §6.4 の自動 AC のテストがすべてあり、通る。Client の画面分岐・帯・README がそろう |
| Phase 2 | QA と Security が並列 | QA 5（Q-01〜Q-05）、Security 4（S-01〜S-04） | **M2**：AC の対応表が埋まり、手動確認の結果と不具合票がそろう。必須の不具合が直っている（直すのは元の担当者。§5） |
| Phase 3 | Reviewer | 3（R-01〜R-03） | **M3**：Approve。公開できる状態（AC-M の実機確認だけが残る） |
| 合計 | | **35** | |

**クリティカルパス**（Backend の engine 系の列。ここが遅れると全体が遅れる）

```
B-01 → B-02 → B-10 → B-11 → B-12 → B-15 → B-16 → B-17 → B-18 → B-19
     → Q-02 / Q-04 → （不具合の修正 B-9x / C-9x）→ R-01 → R-03
```

- Client（C-01〜C-07）は M0 のあとすぐ始められ、クリティカルパスより短い。余った時間は Phase 2 の修正待ちに充てる。
- Backend は 1 体のサブエージェントなので、同じ Phase 1 の中でも順番に進める。おすすめの順番：B-10 → B-11 → B-13 → B-14 → B-12 → B-15 → B-16 → B-17 → B-18 → B-19 → B-20 → B-21。B-20（調整値の移行）は engine と関係しないので最後に回し、時間が押したらここを後ろにずらす（engine が先）。

---

## 1. 担当境界（ファイル所有表）

設計 §9.1 をこのフェーズの割り当てとして確定する。**同じファイルを 2 つの職種が同じ Phase で編集しない。**

| 担当 | 編集してよいファイル | Phase |
| --- | --- | --- |
| Backend | `src/lib/**`、`src/room/**`、`src/games/**`（View を含む）、`src/__tests__/*.test.ts`、`src/__tests__/sim/**`、`CLAUDE.md`。`package.json` は変えない（依存を足さない。ADR-9） | 0, 1, 修正 |
| Client | `src/components/**`、`src/App.tsx`、`src/main.tsx`、`src/styles.css`、`README.md`、`index.html`、`.env.example` | 1, 修正 |
| QA | `src/__tests__/qa/**`（新規）、`docs/dev/04-qa-report.md`（新規） | 2 |
| Security | `src/__tests__/security/**`（新規）、`docs/dev/05-security-review.md`（新規） | 2 |
| Reviewer | `docs/dev/06-review.md`（新規） | 3 |
| PjM | `docs/dev/03-wbs.md`（本書。進捗の更新もここ） | 全期間 |
| CTO / PdM | `docs/dev/01-*.md` `docs/dev/02-*.md` | 全期間 |

- **例外 X-1（PjM 承認済み）**：B-02 だけ `src/components/Room.tsx` を編集してよい。中身は `'error'` を `'failed'` に置き換える 3 か所だけ（70〜74 行目付近）。理由：設計 §9.3 の `RoomStatus` に `'error'` がないため、`useRoom` の戻り値の型を変えると `Room.tsx` の `status === 'error'` が TS2367（比較の型が重ならない）で型エラーになる（PjM が同じ形の比較を `tsc --strict` にかけて確認した）。Phase 0 は Client の着手前なので衝突しない。Client は C-01 でこの部分を書き直してよい。
- QA と Security は、製品コード（`src/` のうちテスト以外）と Backend のテスト・`sim/` を**読むだけ**にする。不具合を見つけたら直さずに票にし、元の担当者が直す（§5）。
- `src/__tests__/qa/**` と `src/__tests__/security/**` は vitest の既定の対象パターン（`**/*.test.ts`）に入るので、設定を変えずに `npm test` で走る。
- 表にないファイル（`vite.config.ts`、`tsconfig.json`、`package-lock.json`、`public/**` など）を触る必要が出たら、PjM と CTO に相談する。

---

## 2. Phase 0（Backend 単独。M0 まで Client は待つ）

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| B-01 | 契約の型：`ConnectionStatus` 型を `transport.ts` に**足すだけ**（実装は変えない）。`src/room/types.ts` を設計 §9.3 の全文どおりに作る | `src/lib/transport.ts`、`src/room/types.ts`（新規） | なし | （全 AC の前提） | `npm run typecheck` が通る。`src/room/types.ts` と設計 §9.3 のコードブロックを並べて、コメントを除いた型の中身が一致する（R-01 でも見る） |
| B-02 | 暫定 `useRoom`：戻り値を `RoomHandle`（types.ts）にする。中身は旧実装のまま、`connection: 'connected'` 固定、`retry` は `location.reload()`、`'error'` は `'failed'` で返す。`useRoom.ts` から `RoomHandle` / `RoomStatus` / `ConnectionStatus` を再エクスポート。例外 X-1 として `Room.tsx` の `'error'` を `'failed'` に置き換える | `src/room/useRoom.ts`、`src/components/Room.tsx`（X-1 の 3 か所だけ） | B-01 | AC-06・07・31 の土台 | `typecheck` / `test` / `build` が通る。`git diff src/components/Room.tsx` が `'error'` → `'failed'` の置き換えだけ |
| B-03 | チャット制限の純粋関数：`CHAT_MAX_LEN` を export、`CHAT_RATE = {count:3, windowMs:3000}`、`chatBlockedUntil(state, me, now)` を追加（`state.chat` の `by` / `at` から数える）。`reduceRoom` への組み込みは B-14 でやる | `src/room/logic.ts`、`src/__tests__/logic.test.ts` | なし | AC-20（Client 側の土台） | `logic.test.ts` に「3 件送ったあとは 3 件目の `at + 3000` を返す」「2 件までなら 0」「他人のチャットは数えない」がある。`npm test` が通る |
| B-04 | 調整値の入口：`src/games/micro/tuning.ts` に `Tuning` 型・`TUNING`（設計 §7.1 の値で、今の値と同じ）・`speedForStage(stage, t?)`・`speedUpRuleText(t?)` を置く。`core.ts` などの置き換えは B-20 でやる（ここではまだ読ませない） | `src/games/micro/tuning.ts`（新規）、`src/__tests__/tuning.test.ts`（新規） | なし | AC-42 の土台 | `tuning.test.ts` に「`speedUpRuleText()` が『5ステージごと』を含む」「`speedForStage` が `core.ts` の旧実装と 1〜30 ステージで同じ値を返す」がある。**M0 判定**：`npm run typecheck && npm test && npm run build` が通る |

M0 を確認したら PjM が Client に着手を伝える。Phase 0 の終わりに Backend は、Client が使える export を一覧にして渡す（設計 §9.2 / §9.4 と同じであることの確認）。

---

## 3. Phase 1（Backend と Client が並列）

### 3.1 Backend

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| B-10 | `Clock` インターフェースと `realClock` | `src/lib/clock.ts`（新規） | M0 | （基盤） | `typecheck` が通る |
| B-11 | 疑似ネットワーク：`transport.ts` に `Link` / `LinkEvents` / `LinkFactory` 型を足し、`SimClock` / `SimNetwork` / `SimNode`（遅延・ゆらぎ・欠落・`dropWhere`・`failConnects`・`disconnect`/`restore`・`freeze`/`thaw`・送信ログ・シード付き乱数・送信時の JSON 複製）を作る（設計 §6.1） | `src/lib/transport.ts`（型だけ）、`src/__tests__/sim/network.ts`（新規）、`src/__tests__/sim.test.ts`（新規） | B-10 | AC-17 などの土台（F12 / MVP-1） | `sim.test.ts` に「同じシードなら送信ログが毎回同じ」「欠落率 0 なら全部届く」「`freeze` 中のタイマーは `thaw` まで動かない」がある。`npm test` が通る |
| B-12 | `ManagedTransport`：connecting / connected / reconnecting / failed の状態機械、`CONNECT_TIMEOUT_MS` 5000・`RETRY_DELAYS_MS` [1000,2000,4000]・`REBUILD_AFTER_MS` 8000、`send` は connected のときだけ、`setNetworkOnline`、`reconnect()`。`supabaseLinkFactory`（SUBSCRIBED → onOpen、CHANNEL_ERROR / TIMED_OUT / CLOSED → onDown）、`localLinkFactory`、`createTransport`（設計 §3.1） | `src/lib/transport.ts`、`src/__tests__/transport.test.ts`（新規） | B-11 | AC-05、AC-06（自動部分）、AC-07（状態） | `npx vitest run src/__tests__/transport.test.ts` で AC-05 / 06 / 07 のテストが通る。`isOnlineMode` の export が残っている |
| B-13 | `protocol.ts`：`WireMessage`（`v: 2`）、`parseWireMessage` / `parseRoomAction` / `parseRoomState`（設計 §2.2 の表どおり。`gameSystem` はネットワークから受け付けない）、`allowRate`、`MAX_ID_LEN` / `MAX_STATE_BYTES` | `src/room/protocol.ts`（新規）、`src/__tests__/protocol.test.ts`（新規） | M0 | AC-01、02、03 | `protocol.test.ts` に AC-01〜03 のケース（null・数値・配列・未知の `t`・`from` が文字列でない、`join.name` / `chat.text` / `setOption.value` の型違い、`players` が配列でない、`epoch` が数値でない、別の部屋コード）があり、どれも例外を出さず `null` になる |
| B-14 | `logic.ts`：`RoomState.acks`、`acceptAction`、`START_GUARD_MS`（startGame の二重防止）、`reduceRoom` のチャット制限（`chatBlockedUntil`）、`def.reduce` の try/catch、`leave` / `kick` で `acks` から消す、`createRoom` で `acks: {}`（設計 §1.3） | `src/room/logic.ts`、`src/__tests__/logic.test.ts` | B-03 | AC-04、12、13、15、20、21、22 | `logic.test.ts` に AC ごとのテストがある（AC-22 は 10 人・チャット 60 件×200 字・大富豪 6 人中盤・acks 10 件の状態を `TextEncoder` で測り 64KB 以下）。既存のテスト 25 件も通る |
| B-15 | `RoomEngine` 本体：起動・参加・`sync` / `join` / `hb` / `bye`、状態の受信と採用、`status`（connecting / failed / notfound / full / ready / left / kicked）、`commit`、200ms 間引き配信と 2.5 秒の定期再送、同期要求への返信（相手ごと 1 秒 1 回）、スナップショットからの復元（設計 §2.1・§2.4・§3.3・§4・§5.1・§5.2）。テスト補助 `createSimRoom` | `src/room/engine.ts`（新規）、`src/__tests__/sim/harness.ts`（新規）、`src/__tests__/sync.test.ts`（新規） | B-12、B-13、B-14 | AC-08、09、10、18、30、31 | `sync.test.ts` に左の AC のテストがあり、通る |
| B-16 | engine：seq と未確認アクション（outbox 50 件・10 秒、1 秒ごとの再送、`acks` での確認、確認後も 10 秒保持）、ホスト側の 1 人 10 件/秒の受付上限（設計 §2.3） | `src/room/engine.ts`、`src/__tests__/sync.test.ts`、`src/__tests__/sim/harness.ts`（`rushBot` を追加） | B-15 | AC-11、14、16、19、23 | `sync.test.ts` に左の AC のテストがある（AC-23 は「`submit` を 1 回 dispatch すると送信ログの `action` が同じ seq だけ」を見る） |
| B-17 | engine：ホスト交代（無通信 9 秒・`bye`・`LONE_TAKEOVER_MS`・接続直後と復帰直後 9 秒は判定しない）、引き継ぎ時の outbox 適用と `reschedule`（期限切れは即実行）、二重ホストの収束と古いホストへの反論、ホストからの `sync` の特例、`resume()`、無通信検知 `STALL_MS`、tick 間隔からのスリープ明け検知（設計 §3.2・§5.3・§5.4） | `src/room/engine.ts`、`src/__tests__/sync.test.ts` | B-16 | AC-24、25、26、27、28、29 | `sync.test.ts` に左の AC のテストがある |
| B-18 | `useRoom.ts` を差し替え：engine を作り `useSyncExternalStore` で購読。`visibilitychange` / `pageshow` / `online` / `offline` / `pagehide` を engine に渡す。`retry` は `engine.retry()`（ページを読み直さない）。シグネチャと再エクスポートは変えない | `src/room/useRoom.ts` | B-17 | AC-06、07、09、AC-16 のブラウザ側の配線（F9） | `typecheck` / `test` / `build` が通る。`useRoom.ts` に受信処理・tick のロジックが残っていない（engine に移っている） |
| B-19 | 遅延とゆらぎ・欠落下のラッシュ通しテスト：3 人・片道 0〜500ms のゆらぎ・欠落 20%・10 ステージ。シード 3 種類で回す（設計 §6.3） | `src/__tests__/sync.test.ts` | B-16、B-17 | AC-17 | 3 シードとも、3 人の `stage` / `lives` / `cleared` が一致し、ライフが減っていない。`npm test` を 3 回続けて流しても毎回通る |
| B-20 | 調整値の移行：`tuning.ts` に `validateTuning` / `enabledMicroIds` を足し、`core.ts`（`LIVES`・`speedForStage`・`nextMicroId`・`MICRO_META` の `baseMs`/`scales`）・`action.tsx`・`brain.tsx`・`MicroStage.tsx`（`VERDICT_MS`）・`rush/logic.ts`・`registry.ts`（ルール文言・ライフの選択肢）の直書きを `TUNING` 参照に置き換える。値は今と同じ。設計 §9.2 の export は名前と意味を残す | `src/games/micro/{tuning.ts, core.ts, action.tsx, brain.tsx, MicroStage.tsx}`、`src/games/rush/logic.ts`、`src/games/registry.ts`、`src/__tests__/tuning.test.ts` | M0（B-04） | AC-41、42、43、44、45（Should だが手間が少ないので書く） | `tuning.test.ts` に「`validateTuning(TUNING)` が空」「違反を 1 つずつ入れた複製で該当メッセージが出る」「`everyStages: 3` で『3ステージごと』」「`enabled: false` の id が 100 回出題して出ない」がある。既存の rush / micro 関連テストが手を入れずに通る。`grep` で `action.tsx` / `brain.tsx` に難易度の数値の直書きが残っていない（R-01 でも確認） |
| B-21 | `CLAUDE.md` の「構成」に `engine.ts` / `protocol.ts` / `types.ts` / `clock.ts` / `tuning.ts` / `__tests__/sim/` を足す（最後に 1 回） | `CLAUDE.md` | B-18、B-20 | — | `CLAUDE.md` に新しいファイルがすべて載っている。**M1（Backend 分）**：`npm run typecheck && npm test && npm run build` が通る |

### 3.2 Client

すべて M0（B-01〜B-04）のあとに始める。Client は `src/room/types.ts` の型と設計 §9.4 の関数だけを頼りにし、engine の中身を前提にしない。

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| C-01 | `Room.tsx` の画面分岐を設計 §3.3 の表どおりに：`failed`（「接続できませんでした」＋「再試行」= `room.retry()`）、`notfound`、`full`（「この部屋は満員です（最大 10 人）」＋「トップへ」。人数は `MAX_ROOM_PLAYERS` から）、`kicked`（最低限 `left` と同じ画面）。`location.reload()` を使わない | `src/components/Room.tsx`、`src/styles.css` | M0 | AC-06（画面）、10（画面の区別）、31（画面） | `typecheck` / `build` が通る。`Room.tsx` に `location.reload` が残っていない。`RoomStatus` の 7 値すべてに分岐がある（`switch` の網羅か、全値を書いた `if` の並び） |
| C-02 | 「再接続中…」の帯：`status === 'ready' && connection !== 'connected'` のとき画面上部に細い帯を出す。ゲーム画面は消さない。360px 幅で崩れない | `src/components/Room.tsx`、`src/styles.css` | C-01 | AC-07（表示） | `typecheck` / `build` が通る。帯のスタイルが固定の高さ・折り返しで 360px でも 1〜2 行に収まる（Q-04 で確認） |
| C-03 | 「このコードで部屋を作る」の修正：`goRoom(code, true)` で作成要求ごとに増える `createNonce` を持ち、Room の `key` を `${code}:${nonce}` にする（同じハッシュでも Room を作り直す） | `src/App.tsx`（必要なら `src/components/Room.tsx` の呼び出し側） | M0 | AC-32 | `typecheck` / `build` が通る。Q-04 で手動確認 |
| C-04 | チャットの送信制限 UI：`Chat` に `blockedUntil` と `now` を渡し、`now() < blockedUntil` の間は送信ボタンを無効にする（`chatBlockedUntil(state, me, room.now())`）。解除のための再描画を時刻で起こす | `src/components/Chat.tsx`、`src/components/Room.tsx` | M0（B-03） | AC-20（UI） | `typecheck` / `build` が通る。`CHAT_MAX_LEN` を Chat の入力上限に使う |
| C-05 | `Practice.tsx` の直書きを置き換え：`INTRO_MS` → `TUNING.solo.introMs`、`LIVES` → `TUNING.lives.default`、`VERDICT_MS` → `TUNING.stage.verdictMs`、「5ステージごとにスピードアップ」→ `speedUpRuleText()`、`speedForStage` は `tuning.ts` から | `src/components/Practice.tsx` | M0（B-04） | AC-41、42、44 | `typecheck` / `build` が通る。`Practice.tsx` に `2000` と「5ステージ」の直書きが残っていない |
| C-06 | `README.md`：Vercel の公開手順（設計 §11：リポジトリ連携・Build Command `npm run build`・Output `dist`・環境変数 2 つを Production と Preview に・値を変えたら再デプロイ・Supabase の「Private channels only」は無効）、「しくみ」の数値の更新（ホスト交代は約 10 秒、再接続中の表示、満員）、サブパス公開の確認コマンド `VITE_BASE=/yubisuma/ npm run build && grep -E 'src=\|href=' dist/index.html` | `README.md` | なし | AC-36、37 | README に左の項目がすべてある。書いた確認コマンドを実際に流し、出力が `/yubisuma/` 配下を指す |
| C-07 | トップのデモモード表示の確認：設計 §9.5-7 のとおり `Home.tsx` にすでにある。Supabase 未設定でビルドし、表示を確認するだけ（直す必要があったときだけ直す） | （原則なし。必要なら `src/components/Home.tsx`） | なし | AC-38 | 確認結果（表示の有無）を Client の完了報告に書く。**M1（Client 分）**：`npm run typecheck && npm test && npm run build` が通る |

---

## 4. Phase 2（QA と Security が並列。M1 のあと）

### 4.1 QA

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| Q-01 | テスト計画と AC 対応表：PdM 仕様の全 AC（AC-01〜46、AC-M1〜M5）ごとに「自動ならテストのファイル名と `it` の名前」「手動なら手順」「対象外なら理由（Should など）」を書く。自動の AC にテストがないものを洗い出す | `docs/dev/04-qa-report.md`（新規） | M1 | 全 AC | 対応表に空欄がない。テストがない自動 AC は不具合票（§5）にする |
| Q-02 | 追加の異常系シナリオ：組み合わせのケースを足す。例：二重ホスト中に参加者がリロード、ラッシュ中にホストを `freeze` → 他の人が引き継ぎ → 旧ホストを `thaw`、10 人部屋で全員が同時に提出、別の 10 シードで AC-17、欠落 20% で 11 人目が入る、スリープ明けの端末が誤って引き継がない | `src/__tests__/qa/*.test.ts`（新規。`sim/` は読むだけで import して使う） | M1 | AC-08〜31 の補強、E-01〜E-19 | 追加テストが `npm test` で走る。落ちたテストは `it.skip` にせず、不具合票の ID をコメントに書いて `it.fails` か `it.todo` にし、票と対応させる |
| Q-03 | 不安定さの検査：`npm test` を 10 回続けて流す。`npx vitest run --sequence.shuffle` も 3 回流す。1 回でも落ちたテストを記録する。テスト全体の所要時間も記録する | `docs/dev/04-qa-report.md` | Q-02 | AC-17、26 など | 10 回とも全件通る。落ちたものがあれば再現するシードと手順つきで票にする |
| Q-04 | 手動確認：`npm run build && npm run preview` のデモモードで 2 タブ（部屋作成 → 参加 → ラッシュ開始 → 終了）、開発者ツールのオフラインで「再接続中…」帯、11 タブ目で満員画面、「このコードで部屋を作る」、トップのデモモード表示、Practice の文言、数値スコアが出ないこと、360px 幅の表示 | `docs/dev/04-qa-report.md` | M1 | AC-06（画面）、07（表示）、31（表示）、32、38、39、41、44（プレイ感）、46 | 項目ごとに OK / NG と、NG なら再現手順・期待結果・実際の結果がある。ブラウザが使えない場合は §8 の H-3 に従う |
| Q-05 | 不具合の優先度づけとリリース判定の所見：票を「必須 / 推奨 / 次フェーズ」に分け、修正後に再確認する | `docs/dev/04-qa-report.md` | Q-01〜Q-04、修正タスク | — | 必須の票がすべて「修正済み・再確認済み」。リリース可否の所見（AC-M が未実施であることを含めて）を書く |

### 4.2 Security

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| S-01 | 脅威モデルと受信検証のレビュー：`protocol.ts` / `logic.ts` / `engine.ts` を、設計 §2.2・§2.5 の表に照らして確認する（`from` の長さ、`gameSystem` を受け付けない、ホスト以外からの `state` の扱い、非メンバーのアクション、サイズ上限、レート制限、`v` の違うメッセージ） | `docs/dev/05-security-review.md`（新規） | M1 | AC-01〜04、18〜20 | 検査項目ごとに「対策済み / 許容 / 要修正」がある。要修正は票にする |
| S-02 | 悪意ある入力のテスト：ランダムな値や壊れた値を大量に `parseWireMessage` / `parseRoomAction` / `parseRoomState` / `acceptAction` に入れる。`__proto__` や `constructor` を `acks` / `gameOptions` のキーに入れる、巨大な文字列、深い入れ子、`NaN` / `Infinity` / 負の seq | `src/__tests__/security/*.test.ts`（新規） | M1 | AC-01〜04、12 | 例外が出ず、状態が変わらない（またはプロトタイプが汚染されない）ことを検証するテストが `npm test` で通る。落ちたら Q-02 と同じ書き方で票と対応させる |
| S-03 | フロントエンドと秘密情報：`dangerouslySetInnerHTML` / `innerHTML` を使っていないこと、名前・チャットがテキストとして描画されること、`.env.local` が `.gitignore` に入っていて履歴にないこと、`dist/` に anon キー以外の鍵（`service_role` など）がないこと、`npm audit --omit=dev` の結果（ネットワークが使えなければその旨を記録） | `docs/dev/05-security-review.md` | M1 | AC-36（README の秘密情報の注意）、CLAUDE.md の規約 | 確認したコマンドと結果がレポートにある |
| S-04 | 許容するリスクを文書にする：なりすまし（`from` は自己申告）、悪意あるホストによる `game.state` の改ざん、Broadcast が部屋の全員に届くこと、部屋コードの推測、REST フォールバックを使わないこと。§8 の H-5 で人間に判断してもらう材料にする | `docs/dev/05-security-review.md` | S-01 | — | リスクごとに「影響・起こりやすさ・今回の扱い・次フェーズの案」がある |

---

## 5. 不具合の修正の流れ（Phase 2 と Phase 3 の間）

- QA / Security / Reviewer は不具合を**直さず**、票（ID：`BUG-xx`、レポートの中に書く）にする。票には再現手順・期待結果・実際の結果・関係する AC・**直す担当（ファイル所有表で決まる）**を書く。
- PjM が票を振り分け、修正タスクを `B-9x`（Backend）/ `C-9x`（Client）として本書に追記する。修正は所有表どおりの担当者が行い、元のテストまたは QA / Security のテストが通ることを完了条件にする。
- 修正中も Backend と Client は互いのファイルを触らない。原因が契約（`types.ts`）にある場合は CTO の承認を取ってから Backend が直し、Client に知らせる。
- 修正のあと、票を出した職種が再確認して閉じる（Q-05 / S-01 に記録）。

---

## 6. Phase 3（Reviewer。M2 のあと）

| ID | 内容 | 触るファイル | 依存 | AC | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| R-01 | 差分レビュー：`da9f651`（設計の commit）からの差分を `CLAUDE.md` の規約に照らす（ホスト権威、純粋関数に `Date.now()` などの副作用がない、受信は `unknown` で受けて絞り込む、`any` を使わない、日本語のコメント、`dangerouslySetInnerHTML` を使わない）。契約（§9.3 と `types.ts` の一致）、互換性ルール（設計 §9.2 の export が残っている）、調整値の直書きが残っていない（AC-41）も見る | `docs/dev/06-review.md`（新規） | M2 | AC-41、全体 | 指摘ごとに重大度（必須 / 推奨 / 好み）・理由・代替案がある |
| R-02 | 通信まわりの追加レビュー：`engine.ts` / `transport.ts` / `protocol.ts` を、Security の指摘（S-01〜S-04）が反映されたかの観点で見る。タイマーの解除漏れ・購読の解除漏れ・`dispose` 後の送信がないか | `docs/dev/06-review.md` | R-01、S-01〜S-04 | AC-24〜30 など | 確認結果が書かれ、Security の要修正の票がすべて閉じている |
| R-03 | 最終ゲート：`npm run typecheck && npm test && npm run build` を流す。Q-01 の対応表で Must の自動 AC がすべて「テストあり・通過」であること、Q-05 の必須の票が閉じていることを確かめ、Approve か Request changes を出す | `docs/dev/06-review.md` | R-01、R-02、Q-05 | 全 Must AC | Approve。Request changes なら修正タスク（§5）を作って R-03 をやり直す |

---

## 7. 並列作業で衝突しないことの確認（チェックリスト）

PjM が Phase 1 の開始前と M1 の時点で確かめる。

- [x] **編集するファイルが重ならない**：§3.1 の「触るファイル」はすべて `src/lib/` `src/room/` `src/games/` `src/__tests__/`（`qa/` `security/` を除く）`CLAUDE.md` の中、§3.2 はすべて `src/components/` `src/App.tsx` `src/styles.css` `README.md` の中で、共通するファイルは 0 件。
- [x] **例外は Phase 0 だけ**：Backend が Client のファイルに触るのは B-02 の `Room.tsx`（X-1）だけで、Client の着手前に終わる。
- [x] **Client が使うものは M0 の時点でそろっている**：`RoomHandle` / `RoomStatus` / `ConnectionStatus`（B-01・B-02）、`retry` / `connection`（B-02 の暫定版）、`chatBlockedUntil` / `CHAT_RATE` / `CHAT_MAX_LEN`（B-03）、`TUNING` / `speedUpRuleText` / `speedForStage`（B-04）、`MAX_ROOM_PLAYERS` / `isOnlineMode`（既存）。
- [x] **Backend は Client が import しているものを消さない**：設計 §9.2 の一覧に加え、PjM が現行の import を見て次も対象にした：`microMeta`（`Practice.tsx` が使う）、`getPlayerId` / `getSavedName` / `saveName` / `NAME_MAX` / `generateRoomCode` / `normalizeRoomCode` / `ROOM_CODE_LENGTH`（`identity.ts`）、`GamePlayer`（`games/types.ts`）。B-20 で `core.ts` / `MicroStage.tsx` を変えても `LIVES` / `VERDICT_MS` などは再エクスポートで残す。
- [x] **Phase 1 のあいだ契約は動かさない**：`src/room/types.ts` の変更は CTO の承認が必要（設計 §9.3）。変えたときは PjM が Client に知らせ、Client の作業を一度止める。
- [x] **どちらが先に終わってもビルドが通る**：Client は暫定 `useRoom`（B-02）でも本物（B-18）でも同じ型で動く。Backend の B-20 は値を変えないので、Client の C-05 の前でも後でも表示は同じ。
- [x] **依存を足さない**：`package.json` / `package-lock.json` はどちらも変えない（ADR-9）。`vite.config.ts` / `tsconfig.json` も変えない。
- [x] **CSS は Client だけ**：Backend は `src/styles.css` を触らない。B-20 は View の数値を置き換えるだけで class 名を足さない。
- [x] **文書の置き場所が分かれている**：Backend は `CLAUDE.md`、Client は `README.md`、QA / Security / Reviewer はそれぞれ `docs/dev/04` `05` `06`。
- [ ] **作業場所を分ける（Phase 1 の開始前に決める）**：2 体が同じ作業ツリーで同時に動くと、片方の書きかけのファイルでもう片方の `typecheck` / `test` が落ちる。Backend と Client は別々の git worktree（またはブランチ）で作業し、M1 で合わせる。ファイルが重ならないので合わせるときに衝突は起きない。コミットや push をしてよいかは §8 の H-6 による。
- [ ] **M1 で合わせたあとに 1 回通す**：両方の変更を合わせた状態で `npm run typecheck && npm test && npm run build` を流す（Phase 2 の開始条件）。

---

## 8. 人間（プロダクトオーナー）の判断が必要な事項

| ID | 判断事項 | いつまでに | 判断がないとき（チームの仮置き） |
| --- | --- | --- | --- |
| H-1 | **Supabase のプラン**（Free か Pro か）。設計 §8 では、Free（200 万メッセージ/月）だと 4 人ラッシュで月 80 時間ほどで、一般公開なら Pro（約 $25/月 + 従量）を勧めている。あわせて Supabase のプロジェクトを作り、URL と anon キーを用意し、Realtime の「Private channels only」を無効にすること | 公開の前（AC-M の実機確認の前） | Free を前提に作る。コードはプランに関係なく同じ |
| H-2 | **公開先と公開範囲**：Vercel（設計の推奨、ルートで公開）か GitHub Pages など（サブパス `VITE_BASE=/yubisuma/`）か。独自ドメインを使うか。友達だけに URL を渡すのか、一般に公開するのか。公開の時期 | C-06（README）の前に分かると手戻りがない。遅くとも公開の前 | Vercel・ルート公開を前提に README を書く。サブパスの手順も 1 行載せる |
| H-3 | **実機確認（AC-M1〜M5）と手動確認の担当**：Supabase キーを使った iPhone / Android / PC での確認、10 人規模の確認を誰がいつやるか。エージェントの環境でブラウザが使えない場合、Q-04 の手動確認（AC-39 など）を人間がやるか | Q-04 の開始時（手動確認）、公開の前（AC-M） | Q-04 はエージェントができる範囲（ビルド・preview の起動・HTML の確認）だけ行い、残りを人間向けの手順として 04-qa-report.md に残す。PdM 仕様どおり AC-M は今回のリリース判定に入れないが、**公開は AC-M1〜M4 の確認後**（PdM 仕様 8 章）とする |
| H-4 | **公開してよいか（AC-M をどこまで終えたら公開するか）**：PdM 仕様は「MVP-1〜11 完了 + AC-M1〜M4 の確認後」を想定している。この条件で良いか | R-03 の Approve の後 | PdM 仕様の想定どおり |
| H-5 | **許容するリスクの承認**：なりすまし・チート対策をしない（友達同士の前提、PdM 仕様 6 章）、悪意あるホストが画面を壊せる、2 人部屋でホストの電池が突然切れると交代まで 30 秒かかる（ADR-7）。一般公開する場合も受け入れられるか | S-04 のあと、公開の前 | 友達同士で遊ぶ前提で受け入れる（README の注意書きを維持） |
| H-6 | **Git の運用**：サブエージェントがコミット・push・PR 作成をしてよいか、どのブランチに入れるか（今は `claude/agent-roles-directory-x2dzcl`）、worktree を使ってよいか | Phase 0 の開始前 | 各サブエージェントはコミットせず、作業ツリーに変更を残して人間に確認してもらう。その場合 Backend と Client は順番に作業ツリーを使うことになり、並列の効果が下がる（§9 のリスク R-8） |

### チーム内で決めた事項（人間の判断は不要。記録のみ）

- 状態配信の間引きは 200ms（設計 ADR-5。PdM 仕様の 100ms から変更。AC-18 の上限は満たす）。PdM に共有済みとして扱い、異論があれば Phase 1 の B-15 の前に PjM へ。
- Should（MVP-12〜15、AC-33〜35・40）は今回入れない。ADR-11 の 2 点と、AC-45 のテストだけ書く。
- 例外 X-1（B-02 の `Room.tsx` の 3 か所）を認める。
- 手動確認（CTO 設計 §9.6 では Phase 2 で Client が行うとしていたもの）は Q-04 として QA が行い、Client は不具合の修正で待機する。
- QA と Security のテストは `src/__tests__/qa/` と `src/__tests__/security/` に分け、Backend のテストと `sim/` は読むだけにする。

---

## 9. リスク一覧と対処

| # | リスク | 影響 | 起こりやすさ | 対処 |
| --- | --- | --- | --- | --- |
| R-1 | **Phase 0 の契約がずれる**（`types.ts` が設計 §9.3 と違う、暫定 `useRoom` の値の意味が本物と違う） | Client が作った画面分岐が B-18 の後に動かない。手戻り | 中 | `types.ts` は §9.3 を写すだけにする（B-01 の完了条件）。暫定版も同じ型を返すので型のずれは `typecheck` で見つかる。意味のずれ（例：`notfound` に戻る条件）は §3.3 の表を Client の唯一の根拠にする。契約の変更は CTO 承認と PjM からの通知が必須 |
| R-2 | **Phase 0 で型エラーが出る**（契約から `'error'` がなくなり `Room.tsx` が TS2367 になる） | M0 で `typecheck` が通らず Client が始められない | 高（PjM が確認済み） | 例外 X-1 で B-02 が 3 か所だけ直す |
| R-3 | **疑似ネットワークのテストが不安定**（実時間・実タイマーが混ざる、乱数のシードが固定されていない、Map の順番に頼る、テストが遅い） | CI がたまに落ちて信用できなくなる。AC-17 / AC-26 の結果が偶然になる | 中 | 設計 §6.2 のとおり `SimClock` だけを使い、`vi.useFakeTimers` と `Date.now()` を使わない。乱数はシード付きにして 3 シードで回す（B-19）。B-11 で決定性の自己テストを書く。Q-03 で 10 回 + 順番シャッフルで流す。1 テストの仮想時間に上限（`runUntil` の `maxMs`）を付け、無限ループを防ぐ |
| R-4 | **Supabase の実機確認ができない**（キーがない、実際の再参加の通知順・レート制限での切断が疑似ネットワークと違う） | 実機でだけ再接続が戻らないなどの不具合が公開後に見つかる | 中 | Supabase 固有のコードを `supabaseLinkFactory` の 50 行ほどに閉じる（B-12）。`REBUILD_AFTER_MS` で張り直す保険。R-02 で Link の扱いを重点的に見る。公開は AC-M1〜M4 の後（H-3・H-4）。手順は QA が 04-qa-report.md に残す |
| R-5 | **Backend に作業が集中する**（クリティカルパスがすべて Backend、engine の 3 タスクが大きい） | Phase 1 が延びる。Client が待つ | 高 | 順番を engine 優先にし、B-20（調整値）は最後に回す。B-15〜B-17 のどれかが 1 コミットに収まらないときは、PjM と相談して AC 単位でさらに分ける。Client は担当境界の都合で手伝えないので、Client の空き時間は README と手動確認の準備に使う |
| R-6 | **Client が engine の完成前に本物の動作を確認できない**（暫定版は `connection` が常に `connected`） | 帯・満員・failed の画面が B-18 まで実際には出ない | 高 | Client は型に沿って書き、表示の確認は Q-04（M1 の後）でまとめて行う。必要なら Client が開発中だけ一時的に `room` の値を差し替えて見た目を確かめ、コミットには入れない |
| R-7 | **調整値を移すときにプレイ感が変わる**（値の写し間違い、`speedForStage` の丸めの違い） | 既存テストが落ちる、気づかずに難易度が変わる | 中 | B-04 で旧実装と 1〜30 ステージの値の一致をテストする。B-20 は「値を変えない」ことを完了条件にし、既存テストに手を入れない。Q-04 で触って確かめる（AC-44） |
| R-8 | **同じ作業ツリーで 2 体が同時に作業する** | 書きかけのファイルで相手の `typecheck` / `test` が落ちる。どちらの変更か分からなくなる | 中（H-6 次第） | worktree か別ブランチに分ける（§7）。分けられないなら、Backend と Client は作業ツリーを使う時間をずらし、PjM がその順番を決める |
| R-9 | **手動確認がエージェント環境でできない**（ブラウザがない） | AC-06 / 07 / 31 / 32 / 38 / 39 / 46 が未確認のまま残る | 中 | H-3 で人間に頼む。頼めない場合は「未確認」とはっきり書いてリリース判定（Q-05）に含める |
| R-10 | **新しめの道具の癖**（TypeScript 7・vitest 5・Vite 8） | 想定外の型エラーやテスト実行の違い | 低 | 新しい書き方を持ち込まず、既存コードに合わせる。問題が出たら依存は変えずに CTO に相談 |
| R-11 | **Supabase の料金・上限が設計時の値から変わっている** | 見積もり（設計 §8）が外れ、月の途中で使えなくなる | 低〜中 | 公開前に料金ページで確かめる（H-1 の判断材料として PjM が人間に渡す） |
| R-12 | **QA / Security が見つけた不具合の修正で、担当境界をまたぐ** | 修正の手戻り、ファイルの衝突 | 中 | §5 のとおり直すのは所有者だけ。契約に関わる修正は CTO 承認の後に Backend → Client の順で行う |

---

## 10. AC と担当タスクの対応（Must）

| AC | 作るタスク | 確かめるタスク |
| --- | --- | --- |
| AC-01〜03 | B-13 | S-01、S-02、Q-01 |
| AC-04 | B-14 | S-02、Q-01 |
| AC-05 | B-12 | Q-01 |
| AC-06 | B-12、B-18、C-01 | Q-04 |
| AC-07 | B-12、B-18、C-02 | Q-04 |
| AC-08、09 | B-15、B-18 | Q-02 |
| AC-10 | B-15、C-01 | Q-01、Q-04 |
| AC-11、14、16、19、23 | B-16 | Q-02 |
| AC-12、13、15 | B-14（純粋）、B-16（engine） | S-02、Q-02 |
| AC-17 | B-19 | Q-02、Q-03 |
| AC-18 | B-15 | S-01、Q-02 |
| AC-20 | B-03、B-14、C-04 | Q-04 |
| AC-21、22 | B-14 | Q-01 |
| AC-24〜29 | B-17 | Q-02、Q-03、R-02 |
| AC-30、31 | B-15、C-01 | Q-02、Q-04 |
| AC-32 | C-03 | Q-04 |
| AC-36、37 | C-06 | S-03、R-01 |
| AC-38 | C-07 | Q-04 |
| AC-39 | （結合） | Q-04 |
| AC-41〜44 | B-04、B-20、C-05 | R-01、Q-04 |
| AC-46 | （変更なしの維持） | Q-04 |
| AC-M1〜M5 | — | H-3（人間） |
