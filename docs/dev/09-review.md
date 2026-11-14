# 09 最終レビュー（Reviewer）

- 対象：`git diff e00dde5..HEAD -- src index.html vite.config.ts package.json public README.md CLAUDE.md`（HEAD = 2947cf1、50 ファイル・+7310 / −1111）
- 基準：`CLAUDE.md` のコーディング規約。設計意図は `docs/dev/02-architecture.md`・`04-qa-report.md`・`05-security-report.md` で確認
- 前提の確認（HEAD でクリーンな作業ツリー）

| コマンド | 結果 |
| --- | --- |
| `npm run typecheck` | OK（エラーなし） |
| `npm test` | OK：15 ファイル、210 件通過、2 件 skip（QA-BUG-03・QA-BUG-05。どちらも 04 で「次フェーズ・見送り」と判断済みの既知の票） |
| `npm run build` | OK（JS 325.9KB / gzip 102.5KB、CSS 35.7KB） |
| `VITE_BASE=/yubisuma/ npx vite build`（README の確認手順、出力先は作業用ディレクトリ） | favicon・JS・CSS がすべて `/yubisuma/` 配下を指す |

## 総評

通信まわりを「`Link`（1 回分の接続）／`ManagedTransport`（状態機械）／`RoomEngine`（React 非依存の同期処理）／`useRoom`（ブラウザイベントの配線だけ）」に分けた構成は筋がよく、時計・通信・ストレージを注入しているおかげで、疑似ネットワーク上で本番と同じコードを決定的にテストできています。受信データの検証（`protocol.ts`）は「既知のフィールドだけで組み立て直す」「`Object.prototype` の名前を ID として拒否する」「入れ子の深さを再帰なしで数える」など丁寧で、`any`・`dangerouslySetInnerHTML`・テストでの実時間依存（`Date.now()` / `vi.useFakeTimers` / 実タイマー）は見つかりませんでした。純粋関数（`logic.ts` / `protocol.ts` / 各 `logic.ts` / `tuning.ts`）に `Date.now()` や DOM・ストレージ・通信は入っていません。タイマー・リスナー・チャンネルの解除（`dispose` / `close` / `useEffect` の後始末）も一通り確認し、漏れはありませんでした。

ただし、実際に動かして確かめた不具合が 2 件あります（R-01：`online` イベント 1 回で Link を 2 回作る、R-02：bye を送ったあと戻ってきたメンバーが他の端末の `departed` に残り続ける）。どちらも、部屋が止まる・状態が壊れるところまでは至らず、最後は 1 つの状態にそろうので **必須ではなく推奨** としました。必須の指摘はありません。

## 指摘一覧

重大度：**必須**＝マージ前に直す／**推奨**＝早めに直す（次の修正で可）／**好み**＝任意

| ID | 重大度 | ファイル:行 | 担当 |
| --- | --- | --- | --- |
| R-01 | 推奨 | `src/room/engine.ts:272-277`（`setNetworkOnline`）・`244-256`（`resume`）／`src/lib/transport.ts:155-165` | Backend |
| R-02 | 推奨 | `src/room/engine.ts:327-330`・`350-353`・`517` | Backend |
| R-03 | 推奨 | `README.md:96` | Client |
| R-04 | 好み | `src/room/logic.ts:111` | Backend |
| R-05 | 好み | `src/__tests__/security-engine.test.ts:187-189` | Backend |
| R-06 | 好み | `src/games/micro/core.ts:33-36` | Backend |
| R-07 | 好み | `src/room/logic.ts:181`（ほか `185`・`192`・`217`） | Backend |
| R-08 | 好み | `src/room/logic.ts:97-99`・`178` | Backend |

### R-01（推奨）`online` イベント 1 回で Link を 2 回作り、1 本目をすぐ捨てる

- **内容**：`RoomEngine.setNetworkOnline(true)` は `transport.setNetworkOnline(true)` を呼び、`ManagedTransport` は `reconnecting` / `failed` なら `reconnect()` で新しい Link を作ります（transport.ts:164）。続けて engine は `this.resume()` を呼び、`resume` は `transport.status !== 'connected'`（いまは `reconnecting`）を見て `transport.reconnect()` をもう一度呼ぶので（engine.ts:251-253）、作ったばかりの Link を閉じて 2 本目を作ります。
- **確認**：疑似ネットワークで、接続済みの engine に `setNetworkOnline(false)` → `setNetworkOnline(true)` を呼び、LinkFactory の呼び出し回数を数えると **2 回** でした（一時的なテストファイルで確認し、削除済み）。
- **理由**：本番の Link は 1 本ごとに `RealtimeClient`（WebSocket）を作るので、復帰のたびに WebSocket を 1 本開いてすぐ閉じることになります。スマホでは `online` と `visibilitychange` / `pageshow` がほぼ同時に来やすく、`reconnecting` 中の `resume()` も同じく張り直したばかりの Link を捨てます。接続が遅い回線で接続待ちを毎回やり直すことになり、復帰が遅れます。初回接続中（`connecting`）に `resume()` が来た場合も `attempt` が 0 に戻ります。
- **修正案**：`resume()` での張り直しは「`failed`、または `connected` 以外がしばらく続いている」ときだけにする。最小の修正なら、engine の `setNetworkOnline(true)` では transport 側に張り直しを任せ、`resume()` の `transport.reconnect()` を `transport.status === 'failed'`（または `reconnecting` が一定時間以上続いた場合）に絞る。`transport.test.ts` か `sync.test.ts` に「online 1 回で Link は 1 本」のテストを足す。

### R-02（推奨）bye を送ったあと戻ってきたメンバーが、他の端末の `departed` に残り続ける

- **内容**：`bye` を受けると `departed` に入れます（engine.ts:350-353）が、外すのは「その人から `state` を受けたとき」だけです（335 行）。`joining` は `state` / `action` / `hb` を受けると外しているのに（327-330 行）、`departed` は外していません。`pruneTables` もメンバーの分は残すので（746-748 行）、ホストでないメンバーが `pageHide`（bfcache など）で bye を送ったあと `resume` で戻ってくると、他の端末の `departed` にずっと残ります。
- **確認**：3 人の部屋（h・b・c）で b が `pageHide()` → 1 秒後に `resume()` → 5 秒待つと、c の `departed` は `['b']` のままでした（一時的なテストファイルで確認し、削除済み）。
- **理由**：`checkTakeover` の猶予中の候補（517 行）は「`departed` にいないメンバー」なので、c が接続・復帰直後の猶予中にホストの bye を受けると、生きている b を飛ばして自分を選びます。b も（猶予外なら）自分を選ぶので、同じ世代のホストが 2 人できます。`compareStates` で b に収束するので壊れはしませんが、QA-BUG-07 で直した「先の人を飛ばす」と同じ形の誤りが、この経路では残っています。
- **修正案**：327-330 行の `state` / `action` / `hb` を受けたときの処理で `this.departed.delete(msg.from)` も行う（335 行の `state` のときだけの削除はまとめられる）。QA-BUG-07 のテストの近くに「bye のあと戻ったメンバーは猶予中も候補に入る」テストを足す。

### R-03（推奨）README の「切れている間の操作は自動で送り直します」に期限がない

- **内容**：README:96 は「切れている間の操作は、つながり直したあとに自動で送り直します」と書いていますが、未確認の操作は `PENDING_TTL_MS`（10 秒）を過ぎると捨てます（engine.ts:561-565、設計 AC-14・02 §4）。
- **理由**：切断は再接続の作り直し（8 秒）を含めると 10 秒を超えることが普通にあり、利用者は「送ったはずの操作が消えた」と感じます。説明と実際の挙動がずれています。
- **修正案**：「切れてから 10 秒以内の操作は、つながり直したあとに自動で送り直します（それより古い操作は取り消されます）」のように期限を書く。

### R-04（好み）`pickNextHost` の説明コメントが `chatBlockedUntil` の上に来ている

- **内容**：logic.ts:111 の「オンラインのメンバーから次のホスト候補を選ぶ（参加順で最も古い人）」は `pickNextHost`（125 行）の説明ですが、間に `chatBlockedUntil` とその説明が挿入され、`chatBlockedUntil` の説明の 1 行目に見えます。
- **理由**：次に読む人が `chatBlockedUntil` の役割を取り違えます（CLAUDE.md の「なぜそうするか」を書くコメントの趣旨に反する）。
- **修正案**：111 行を `pickNextHost` の直前（124 行の後）へ移す。

### R-05（好み）SEC-06 のテストのコメントが修正前の「現状」のまま

- **内容**：security-engine.test.ts:187-188 は「現状：lastSeen（と rate・syncReplyAt）はメンバー以外の ID も消さずに持ち続け…」と書いていますが、`pruneTables`（engine.ts:740-759）で修正済みで、テストは skip なしで通っています。
- **理由**：テストの意図（「増えないこと」を縛る）と説明が逆になって見えます。
- **修正案**：「メンバー以外の ID の行は tick ごとに消える（SEC-06 の修正）ことを確かめる」に書き換える。

### R-06（好み）`MICRO_META` の合成が型アサーション頼み

- **内容**：core.ts:34 は `(TUNING.micro as Record<string, MicroTuning>)[m.id]` で引いており、`MICRO_TEXT` に足した ID が `TUNING.micro` になければ `t` が `undefined` になり、モジュールの読み込み時に例外になります（型では検出できない）。現状は tuning.test.ts の AC-44（51 行・112 行）が ID の並びを縛っているので壊れてはいません。
- **理由**：ミニゲームを 1 つ足すときに、型エラーではなく画面全体が出ない形で気づくことになります。
- **修正案**：`MICRO_TEXT` を `satisfies Record<keyof typeof TUNING.micro, …>` のような ID をキーにした形にするか、`TUNING.micro` の ID の型（`keyof typeof TUNING.micro`）で `id` を型付けしてアサーションを外す。

### R-07（好み）`reduceRoom` のゲーム引きが `hasGame` と揃っていない

- **内容**：SEC-04 で `hasGame`（`hasOwnProperty`）を入れましたが、`reduceRoom` の `selectGame`（181 行）は `!games[action.gameId]` のままで、`'constructor'` などの継承プロパティを「登録あり」と見ます。
- **理由**：`selectGame` はホスト自身の操作だけが通り（他端末からは `isHost` で弾く）、他の端末は `hasKnownGames` で採用しないので実害はホスト自身の画面に限られます。ただ、同じファイルに 2 通りの判定が並ぶのは次の人が迷います。
- **修正案**：181 行を `!hasGame(games, action.gameId)` にする（185・192・217 行も同じ関数で引くと揃う）。

### R-08（好み）`logic.ts` にモジュール変数 `msgSeq` が残っている

- **内容**：`systemMessage` とチャットの ID に、モジュールレベルの可変カウンタ `msgSeq` を使っています（e00dde5 から引き継いだもの）。
- **理由**：CLAUDE.md は `logic.ts` を純粋関数と定めています。ID の一意性のためだけなら実害はありませんが、同じ入力で結果（チャット ID）が変わるので、テストで状態を丸ごと比べにくくなります。
- **修正案**：次フェーズで、ID を `${by}_${now}_${state.chat.length}` のように状態から作るか、`version` を使う形にする。急ぎではありません。

## 良かった点

- **層の分け方とテストの組み立て**：`Link` と `ManagedTransport` の分離で、Supabase 固有のコードが `supabaseLinkFactory` だけに閉じています。疑似ネットワーク（`sim/network.ts`）は仮想時計・シード付き乱数・同時刻タイマーの順序固定まで揃っていて、遅延・欠落・切断・スリープを含むテストが毎回同じ結果になります。ゲーム側の `Math.random` も各テストの `beforeEach` で固定し `afterEach` で戻しています。
- **タイマーの扱い**：`ManagedTransport` は Link の世代番号で古い Link の通知を捨て、タイマーを Link より先に張ることで「同期的に `onOpen` する Link」でも正しく解除されます。`RoomEngine` は tick を最初に張り直してから処理するので、途中で例外が出ても tick が止まりません。`dispose` は全タイマー・購読・transport を解除しています。
- **受信データの検証**：`protocol.ts` は受信値を使い回さず既知のフィールドだけで組み立て直し、`recordOf`（`Object.fromEntries`）・`ackOf`（`hasOwnProperty`）・`isId`（`x in Object.prototype` の拒否）でプロトタイプ汚染の経路を塞いでいます。`withinDepth` が再帰を使わないのも的確です。`isImplausibleJump` を絶対値でなく相対で見る理由がコメントに書かれているのも良い。
- **ゲームの不具合でルームを止めない**：`init` / `reduce` / `schedule` の例外を `reduceRoom` と `reschedule` で受け止め、画面側は `ErrorBoundary` を 3 層（全体・部屋・ゲーム枠）に置いています。ゲーム枠の境界に `key={game.startedAt}` を付けて次のゲームで失敗表示を持ち越さないのも良い。
- **React 側**：`useSyncExternalStore` と「変化がない限り同じスナップショットを返す」`emit`、`online` の Set を変化時だけ作り直す `refreshOnline` で、tick ごとの無駄な再描画がありません。`RoomStatus` の分岐を `never` で網羅しているのも良い。
- **UI の安全**：名前・チャットはすべて React のテキストとして描画され、`security-static.test.ts` で `dangerouslySetInnerHTML` などの不使用を機械的に縛っています。
- **調整値の一元化**：`tuning.ts` の `validateTuning` が「最高速度で遊べない」「Min > Max」などの壊れ方を説明文つきで返し、ルール文言も調整値から生成していて、数値と説明がずれません。
- **CLAUDE.md**：構成・コマンド・規約の記述は実装と一致していました（`types.ts` の契約型、`engine.ts` の役割、`useRoom.ts` が薄いフックであること、通信のテストで実時間を使わないこと、`tuning.ts` への集約）。

## 判断

**Approve**

必須の指摘はありません。R-01・R-02（Backend）と R-03（Client）は推奨として、次の修正で対応してください。好み（R-04〜R-08）は任意です。QA-BUG-03・QA-BUG-05 の skip は 04 の判断どおり次フェーズの既知の票として扱います。

## 対応結果（Backend）

| ID | 結果 | コミット | 内容 |
| --- | --- | --- | --- |
| R-01 | 修正済み | 028cf13 | `Transport.nudge()` を追加し、`resume()` は `reconnect()` の代わりにこれを呼ぶ。`failed` なら `reconnect()`、`reconnecting` は今の Link を作ってから `CONNECT_TIMEOUT_MS`（5 秒）以上経っていれば作り直し、作ったばかりの Link と `connecting`（初回リトライ中）はそのまま待つ。`online` 1 回で作る Link は 1 本、直後に `resume()` が 2 回続いても 1 本、初回接続中の `resume()` で張り直さない（リトライ回数も戻らない）ことを確認。長く `reconnecting` の Link は従来どおり `resume()` で今すぐ作り直す |
| R-02 | 修正済み | ac834e1 | `state` / `action` / `hb` を受けたときに `joining` と同じく `departed` からも外す（`state` だけの削除はまとめた）。`sync` / `join` では外さない（P1-4 の「リロードしたホストの sync / join で生きていると見なさない」を保つ）。3 人の部屋で b が bye → 戻ったあと c の `departed` が空になること、c が猶予中にホストの bye を受けても b を飛ばして名乗らず b に収束することを確認 |
| R-03 | 修正済み | 96d3329 | README を「切れてから 10 秒以内の操作は、つながり直したあとに自動で送り直します（それより古い操作は取り消されます）」に変更（README は Client 担当だが、今回の依頼に基づき Backend がこの 1 文だけ修正） |
| R-04 | 修正済み | 3882da8 | コメントを `pickNextHost` の直前へ移動 |
| R-05 | 修正済み | 4321389 | SEC-06 のテストのコメントを修正後の挙動（メンバー以外の行は tick ごとに消える）の説明に変更 |
| R-06 | 修正済み | 9cd4629 | `MICRO_TEXT` の `id` を `keyof typeof TUNING.micro` で型付けし、型アサーションを外した（調整値のない ID を足すと型エラーになることを確認） |
| R-07 | 修正済み | 85862f1 | `selectGame` を `hasGame`、`setOption` / `startGame` / `game` の引きを `hasGame` を通す `gameOf` にそろえた。登録済みのゲームの挙動は変わらない |
| R-08 | 修正済み | f88a21c | `msgSeq` を削除。ID は `withChat` で状態から決める（同じ時刻の既存メッセージの末尾番号の最大 + 1。形式は従来どおり `s{at}_{n}` / `{by}_{at}_{n}`）。ID は React の key にだけ使われ、`compareStates` などの比較には使っていないので、同期の挙動は変わらない。同じ入力で状態が丸ごと一致すること、同じミリ秒に複数件でも ID が重ならないことを確認 |

- 再現テスト：`src/__tests__/review-fixes.test.ts`（12 件）。R-01 の 3 件・R-02 の 2 件は修正前に失敗することを確認してから修正した。R-07 の継承プロパティ名の `selectGame` も修正前は失敗。
- 設計書：`docs/dev/02-architecture.md` の §3.1・§5.4・P1-4 を更新し、P2-12（R-01）・P2-13（R-02）を追記。
- 残る注意（R-02）：bye より後に、その人が bye の直前に送った `hb` / `action` が（遅延のゆらぎで順序が入れ替わって）届くと、去った扱いが外れて `lastSeen` の判定（9 秒）に戻る。修正前から `state` で同じことが起きうる形で、bye が届かなかった場合と同じ挙動に落ちるだけなので許容した。
- 確認：`npm run typecheck` OK、`npm test` 5 回連続で 16 ファイル・222 件通過・2 件 skip（QA-BUG-03・05、従来どおり）・失敗 0、`npm run build` OK（JS 326.3KB / gzip 102.7KB）。

---

## 公開前の改善（J-01〜J-06・README）のレビュー（2026-11-14）

- 対象：`3e5da02..8234304`（ブランチ `claude/agent-roles-directory-x2dzcl`）
- 判定：**Approve**（必須の指摘なし）。テスト 222 件通過
- 確認した観点：ホスト権威型（作成直後の `selectGame` はホスト確定後にローカルで処理され、二重送信なし）、XSS（共有文に入るのは検証済みの部屋コードと登録済みのゲーム名だけ）、360px の表示、Web Share 非対応時のコピー失敗の扱い

### 推奨（次の作業で対応）
1. `Room.tsx` の終了判定（`FINAL_PHASE`）を `GameDef.isOver(state)` に移し、各ゲームの単体テストを足す（Backend → Client）
2. 招待カードのコピー失敗の文が 1.8 秒で消える。失敗の文は残し、タイマーは押すたびに解除する（Client）
3. 1 人のロビーのヒントを「上のカードからURLを送りましょう」に（Client）
4. `share.ts` の `inviteText` / `recordText` の単体テスト（Backend か QA）
5. `index.html` の公開アドレスの直書き：独自ドメインへ移るときの確認項目を `docs/dev/11` に足す（CTO）
6. オンライン人数の数え方の重複を関数にまとめる（Client、好み）
