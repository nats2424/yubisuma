# 05. セキュリティレビュー（S-01〜S-04）

- 作成：Security（2026-11-07）
- 対象：`3f1252e` 時点の `src/lib/` `src/room/`（protocol / logic / engine / useRoom）`src/games/**/logic.ts` `src/components/`（Chat / Room / Home）
- 入力：`CLAUDE.md`、`docs/dev/01-pdm-spec.md`（PdM 仕様）、`docs/dev/02-architecture.md`（設計）§2.2・§2.5・§10・§12、`docs/dev/03-wbs.md` S-01〜S-04
- テスト：`src/__tests__/security-{protocol,engine,games,static}.test.ts`（41 件が通り、要修正の 7 件は票 ID 付きの `it.skip`）
- WBS では成果物名が `05-security-review.md`、テストが `src/__tests__/security/` になっているが、依頼に合わせて本書とテストのファイル名を決めた（中身は S-01〜S-04 のとおり）

---

## 0. 要約

1. **受信検証は設計 §2.2 のとおりにできている**。壊れた値・ランダムな値 8000 件、10 万段の入れ子、`NaN` / `Infinity` / 負の seq、巨大な文字列、`__proto__` / `constructor` を入れたキーでも、例外は出ず Object.prototype も汚れない。`gameSystem` はネットワークから入らず、ホストしかできない操作を参加者が送っても効かない。各ゲームの「不正な手」（持っていないカード、手番外、範囲外の値、タイマー専用アクションの偽装）もホストで捨てている。XSS につながる API の使用、秘密情報の混入、依存パッケージの既知の脆弱性はない。
2. **要修正は 6 件（中 4・低 2）**。どれも数行〜十数行で直せて、「1 通の偽メッセージで部屋が壊れたまま戻らない」「ID の付け方でゲームの判定がおかしくなる」「画面が真っ白になる」を防ぐもの。署名や認証の導入は含めていない。
3. **防げないもの（許容するリスク）は 8 件**。根っこは「`from` は自己申告」「状態に署名がない」「状態が部屋の全員に配られる」「チャンネルは anon キー（公開）だけで入れる」の 4 つで、サーバーなしの Broadcast 構成では原理的に防げない。友達同士で遊ぶ前提（PdM 仕様 6 章）で受け入れるかどうか、**プロダクトオーナーの承認が必要**（§5.2、WBS H-5）。

---

## 1. 前提と攻撃者モデル

| 記号 | 攻撃者 | できること |
| --- | --- | --- |
| A1 | 同じ部屋の悪意ある参加者（開発者ツールを使う） | 部屋に届くメッセージをすべて読める。任意の JSON を任意の `from` で送れる。自分の端末のコード（View・engine）を書き換えられる |
| A2 | 部屋コードを推測した、または URL を手に入れた第三者 | A1 と同じ（チャンネル名は `sukima:<コード>`。anon キーはビルドに含まれる公開値なので、誰でもどのチャンネルにも入れる）。メンバーでなくても送受信できる |
| A3 | ホスト本人 | A1 に加えて、`reduce` / `schedule` を自分の端末で実行するので、ゲームの状態そのものを好きに作れる |

- 守るもの：ゲームの公平性、部屋が使える状態（可用性）、利用者の端末（XSS）、Supabase プロジェクト（秘密情報・利用枠）。
- 守らないもの（PdM 仕様 6 章「不正対策（チート・なりすまし防止）は対象外」）：A1〜A3 からの完全な防御。ここでは **安く防げるものだけ要修正** とし、残りは §5 に許容するリスクとして明文化する。

---

## 2. 確認したコマンドと結果（S-03）

| 確認 | コマンド・方法 | 結果 |
| --- | --- | --- |
| 依存パッケージ（本番） | `npm audit --omit=dev` | `found 0 vulnerabilities`（ネットワーク使用可で実行） |
| 依存パッケージ（開発含む） | `npm audit` | `found 0 vulnerabilities` |
| HTML 文字列の描画 | `grep -rn "dangerouslySetInnerHTML\|innerHTML\|outerHTML\|insertAdjacentHTML\|document.write\|eval(\|new Function" src`（テスト以外） | 該当なし。`security-static.test.ts` で回帰チェック |
| 名前・チャットの描画 | `Chat.tsx` / `Room.tsx`（Members・Lobby）を精読 | `{m.name}` `{m.text}` `{p.name}` は React のテキスト子要素。`href` / `src` / `style` に受信データを入れている箇所なし（`style` は固定の色・計算した数値だけ） |
| `.env.local` | `.gitignore` に `.env` と `.env*.local`。`git log --all -- '.env' '.env.local'` | 履歴に `.env` / `.env.local` はない（`.env.example` だけ。値は空） |
| 履歴の鍵 | `git log --all -p \| grep -E "service_role\|eyJhbGciOi"` | README・WBS の注意書きの 2 行だけ（鍵の値はない） |
| `dist/` の鍵 | `npm run build` の後 `grep -rlE "service_role\|sb_secret_\|eyJhbGciOi" dist` | 該当なし（Supabase 未設定でビルド。設定時に入るのは `VITE_SUPABASE_URL` と anon キーだけ） |
| クライアントが読む環境変数 | `import.meta.env.*` を全検索 | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` だけ（`VITE_BASE` は `vite.config.ts` のビルド時のみ） |

---

## 3. 脅威ごとの評価

判定：**対策済み** ／ **要修正**（§4 の票）／ **許容**（§5 のリスク）

### 3.1 なりすまし・権限

| # | 脅威 | 攻撃者 | 判定 | 根拠・テスト |
| --- | --- | --- | --- | --- |
| T-01 | 他人の ID を名乗って操作・チャット・退出させる | A1・A2 | 許容 R-01 | `from` は自己申告。メンバーの ID は状態に載っていて誰でも分かる。`security-protocol`「許容リスク R-01 の確認」 |
| T-02 | ホストの ID を名乗ってアクション（kick・startGame など）を送る | A1・A2 | 対策済み | ホストは `from === me` を捨て、ホスト以外はアクションを処理しない。`security-engine`「ホストの ID を名乗ったアクションは…捨てる」 |
| T-03 | 参加者が kick / selectGame / setOption / startGame / endGame を送る | A1 | 対策済み | `reduceRoom` の `isHost` 判定。`security-protocol`「参加者からの kick…」 |
| T-04 | メンバーでない ID のアクション、途中参加者のゲーム操作 | A2 | 対策済み | `acceptAction` / `game.players` 判定 |
| T-05 | `gameSystem`（ホストのタイマー専用）をネットワークから送る | A1・A2 | 対策済み | `parseRoomAction` が `null`、`acceptAction` も `null` |
| T-06 | `bye` / `sync` をホストの ID で偽装して、ホスト交代を起こす | A1・A2 | 許容 R-01 | `departed` に入り即時交代。from が自己申告である限り防げない。交代しても状態は引き継がれ、ゲームは続く |
| T-07 | epoch を 1 進めた偽の状態でホストを乗っ取る・状態を書き換える | A1・A2 | 許容 R-02 | 状態に署名がない。`security-engine`「許容リスク R-02 の確認」 |
| T-08 | **epoch / version を巨大値（`MAX_SAFE_INTEGER`）にした偽の状態 1 通で、以後の配信が全員に捨てられ部屋が壊れたまま戻らない** | A1・A2 | **要修正 SEC-01** | §4 |
| T-09 | **他人の ID で seq = `MAX_SAFE_INTEGER` を送り、その人を永久に操作できなくする** | A1・A2 | **要修正 SEC-02** | §4 |
| T-10 | 同じ seq・古い seq の再送（リプレイ） | A1・A2 | 対策済み | `acks`。`security-protocol`「同じ seq・古い seq は二重に適用しない」 |
| T-11 | ホスト本人による不正（好きな状態を作る、他人の操作を捨てる、タイマーをいじる） | A3 | 許容 R-03 | ホスト権威型の前提そのもの |

### 3.2 不正なメッセージ（型・サイズ・入れ子・プロトタイプ汚染）

| # | 脅威 | 判定 | 根拠・テスト |
| --- | --- | --- | --- |
| T-12 | 型違い・`null`・配列・関数・Symbol・BigInt・未知の `t`・版違い・別の部屋コード | 対策済み | ランダム・半壊の値 5000 件 + 3000 件で例外なし（`security-protocol`「壊れた値の大量投入」）。版違い・別コードの状態は採用されない（`security-engine`） |
| T-13 | `NaN` / `Infinity` / 負 / 小数 / 安全でない整数の seq・epoch・version | 対策済み | `isPosInt`。ただし「安全な整数の範囲内で巨大」は SEC-01 / SEC-02 |
| T-14 | 巨大な文字列（from・名前・チャット） | 対策済み | from 40・chat 1000・name 1000 文字で足切り、ホストで名前 10・チャット 200 に切る |
| T-15 | 件数の多い配列・オブジェクト（players・chat・acks・online・gameOptions） | 対策済み | 10 / 100 / 20 / 20 / 50 件の上限 |
| T-16 | 深い入れ子の `game.action` | 対策済み | 中身はゲームの `reduce` が見るだけで、`reduceRoom` の `try/catch` もある。10 万段で例外なし |
| T-17 | **深い入れ子の `game.state`（偽の状態）** | **要修正 SEC-05** | 採用後のスナップショット保存の `JSON.stringify` が `RangeError`。受信処理の外まで例外が漏れる |
| T-18 | `acks` / `gameOptions` / アクションのキーに `__proto__` / `constructor` | 対策済み | `recordOf` が `Object.fromEntries` で自分のプロパティとして作り直し、`ackOf` は `hasOwnProperty`。テスト後に Object.prototype が増えていないことを毎回確認 |
| T-19 | **Object.prototype にある名前（`__proto__` / `constructor` / `toString` …）をプレイヤー ID にする** | **要修正 SEC-03** | §4。ワードウルフで処刑されない、大富豪が交換フェーズで止まる |
| T-20 | **未知の `selectedGame` / `game.id`（`constructor` などを含む）の状態** | **要修正 SEC-04** | §4。全員の画面が真っ白。版ずれでも起こる |
| T-21 | `game.state` の中身の改ざん（View が想定しない形） | 許容 R-02 / R-03 | 設計 §2.2・§12 で「検証しない」と決めている。View のエラー境界は Should（MVP-15） |

### 3.3 過剰送信

| # | 脅威 | 判定 | 根拠・テスト |
| --- | --- | --- | --- |
| T-22 | 1 人の ID でアクションを連打 | 対策済み | 10 件/秒（`ACTION_RATE`）。100 件送って処理 10 件以下（`security-engine`）。AC-19 も既存テストあり |
| T-23 | チャットの連投 | 対策済み | 3 件/3 秒。ホストの `reduceRoom` で捨てる |
| T-24 | 毎回違う ID で `sync` を連打して配信を増やす | 対策済み | 返信は 200ms 間引きに合流。200 件/秒送ってもホストの状態配信は 1 秒 6 件以下（`security-engine`） |
| T-25 | 毎回違う ID でレート制限を回避する（`join` で 10 人を偽のメンバーで埋める含む） | 許容 R-08 | レート制限は `from` 単位。ID は自己申告 |
| T-26 | **毎回違う ID の `hb` / `sync` で、生存確認の表が際限なく増える** | **要修正 SEC-06** | §4 |
| T-27 | Supabase プロジェクト全体への大量送信（全部屋の停止・利用枠の消費） | 許容 R-07 | `eventsPerSecond: 20` はクライアント側の設定で、攻撃者は外せる |
| T-28 | REST フォールバック送信 | 対策済み（設計判断） | ADR-6 で `connected` 以外は送らない。セキュリティ上の追加リスクはない |

### 3.4 ゲームごとのチート

| # | 脅威 | 判定 | 根拠・テスト |
| --- | --- | --- | --- |
| T-29 | ラッシュ：`submit` の二重提出・数値でないスコア・脱落者や部外者の提出・`timeout` / `next` の偽装 | 対策済み | `submitMicro` / `rush.reduce`（`security-games`） |
| T-30 | ラッシュ：遊ばずに `success: true` を送る、開始前に送る | 許容 R-04 | ミニゲームは各端末で遊んで結果だけ送る設計 |
| T-31 | 反射神経：`NaN`・負・二度押し・`advance` の偽装 | 対策済み | 100ms 未満・`NaN` はフライング、上限 3 秒 |
| T-32 | 反射神経：100ms と申告する、`wait` 中の `state.until`（合図の時刻）を見て自動で押す | 許容 R-04 | タイムは自己申告。合図の時刻も状態に載る |
| T-33 | 大富豪：持っていないカード・手番外・水増し・配列でない値・交換外の give・`timeout` / `next` の偽装 | 対策済み | `canPlay` / `give` / `by !== 'system'`（`security-games`） |
| T-34 | 大富豪：他人の手札を見る | 許容 R-05 | 全員の `hands` が `game.state` に入り全員に配られる |
| T-35 | ワードウルフ：自分・部外者への投票、`system` を名乗った投票 | 対策済み | `wordwolf.reduce` |
| T-36 | ワードウルフ：お題・ウルフを覗く | 許容 R-05 | `words` / `wolves` が全員に配られる（README に注意書きあり） |
| T-37 | 多数決：他人の回答を見てから答える | 許容 R-05 | 回答中の `answers` が全員に配られる |
| T-38 | 指スマ：持っている手より多い親指・範囲外のコール | 対策済み | `yubisuma.reduce` |

### 3.5 XSS・秘密情報・その他

| # | 脅威 | 判定 | 根拠 |
| --- | --- | --- | --- |
| T-39 | 名前・チャットでの XSS | 対策済み | React のテキストとして描画。HTML 文字列の API・受信データ入りの `href` / `src` なし（§2、`security-static`） |
| T-40 | 秘密情報の混入（service_role・`.env.local`） | 対策済み | §2 |
| T-41 | 依存パッケージの既知の脆弱性 | 対策済み | `npm audit --omit=dev` 0 件 |
| T-42 | 部屋コードの推測・盗み聞き・第三者の参加 | 許容 R-06 | 31^4 ≒ 92 万通り、公開チャンネル |
| T-43 | 部屋コード・プレイヤー ID が `Math.random` 由来 | 許容（任意の改善 §6） | 他人の端末の乱数状態は観測できないので、予測による実害は小さい |

---

## 4. 要修正の票

重大度：**高** = 公開前に必須／**中** = 公開前に直したい（修正コストが小さい）／**低** = 時間があれば。担当は設計 §9.1 のファイル所有に従う。

### SEC-01（中）巨大な epoch / version の偽の状態 1 通で、部屋が壊れたまま戻らない

- 担当：Backend（`src/room/engine.ts` の `onState`、必要なら `src/room/protocol.ts`）
- 再現：
  1. 参加者（または部屋コードを知る第三者）が `{v:2, t:'state', from:<ホスト>, state:{...現在の状態, version: 9007199254740991}}` を 1 通送る。
  2. 全員（ホストも）が「新しい状態」として採用する。ホストの次の変更は `version = 2^53` になり、`parseRoomState` の「安全な整数」検査で全員に捨てられる。以後、参加者の画面は止まったまま。リロードしても同期要求の応答が捨てられて「部屋が見つかりません」になる。
  3. `epoch: 9007199254740991` の場合は、ホストが去った時点で引き継いだ人の `epoch + 1` が全員に捨てられ、部屋が割れる。
- 影響：偽の状態での乗っ取り（R-02）は攻撃者が去れば元に戻るが、これは**攻撃者が去っても戻らない**。部屋を作り直すしかない。
- 修正案：`onState` で、今の状態があるとき **今より大きく飛んだ世代・版を捨てる**（例：`epoch > cur.epoch + 1000`、または同じ epoch で `version > cur.version + 1_000_000`）。自分がホストなら捨てたうえで `requestBroadcast()` して周りを正しい状態に戻す。絶対値の上限（例：2^31）だけでは「上限ちょうど」を送られると同じことが起きるので、相対の検査が本体。上限値は「長時間離れていた参加者が追いつけなくなる」ことのないよう十分大きく取る（5 件/秒で 1 日 ≒ 43 万版）。
- テスト：`security-engine.test.ts` の `SEC-01: version = MAX_SAFE_INTEGER の偽の状態のあとも、ホストの変更が参加者に届く`、`SEC-01: epoch = MAX_SAFE_INTEGER の偽の状態のあとも、ホスト交代で全員が新ホストにそろう`

### SEC-02（中）他人の ID で巨大な seq を送ると、その人はこの部屋で二度と操作できない

- 担当：Backend（`src/room/logic.ts` の `acceptAction`）
- 再現：`{v:2, t:'action', from:'<被害者>', seq: 9007199254740991, action:{type:'chat', text:'x'}}` を送る。ホストが `acks[被害者] = MAX_SAFE_INTEGER` にする。被害者の次の seq（`MAX_SAFE_INTEGER + 1`）は `parseWireMessage` で捨てられ、被害者は退出（`leave` も seq 付き）を含めて何もできなくなる。`acks` は状態に入ってホスト交代でも引き継がれるので、リロードでも直らない。
- 影響：特定の人を狙ってゲームから締め出せる（操作の代行自体は R-01 で許容しているが、こちらは恒久的）。
- 修正案：`acceptAction` で `seq > ackOf(state, by) + 1000` を `null` にする（未確認の再送は最大 50 件なので、正規の操作はこの範囲に収まる）。protocol 側で seq の上限（例：2^31）も設けると、参加者側の `nextSeq` が安全な整数を超える心配もなくなる。
- テスト：`security-protocol.test.ts` の `SEC-02: 処理済み seq から大きく飛んだ seq（MAX_SAFE_INTEGER など）は受け付けない`

### SEC-03（中）`__proto__` / `constructor` などをプレイヤー ID にすると、ゲームの判定がおかしくなる

- 担当：Backend（`src/room/protocol.ts` の `isId`）
- 再現：開発者ツールで `from: '__proto__'` として `join` する（`isId` は 1〜40 文字なら何でも通す）。
  - **ワードウルフ**：`tally` の `counts` が通常のオブジェクトなので、`counts['__proto__'] = …` がプロトタイプの差し替えになり票が消える。`__proto__` の人に全員が投票しても `tally: {}`・処刑なし。ウルフがこの ID を使えば**絶対に処刑されない**（確認済み）。
  - **大富豪**：`__proto__` が大富豪になると `exchange['__proto__'] = …` が消え、3 人部屋では交換フェーズのまま**ゲームが進まなくなる**（`timeout` も状態を変えない。確認済み）。4 人以上では献上だけ受けて渡さなくてよくなる。
  - 反射神経・ラッシュ・多数決・指スマ：`id in obj` が継承プロパティで真になり、`constructor` などの人は常に「提出済み」扱いになる（本人が操作できず、全員そろった判定も早まる）。
- 修正案：`isId` で `x in Object.prototype` の名前を拒否する（あわせて `/^[A-Za-z0-9_-]+$/` に絞るとなお良い。正規の ID は `p_` + 英数字）。`isId` は `from`・`players[].id`・`hostId`・`kick.target`・`startGame.online` に使われているので、1 か所で全経路が塞がる。各ゲームの集計を `Object.create(null)` / `Map` にするのは任意（多重の防御）。
- テスト：`security-protocol.test.ts` の `SEC-03: Object.prototype にある名前（__proto__ / constructor / toString など）はプレイヤー ID として受け付けない`

### SEC-04（中）未知のゲーム ID を含む状態で、全員の画面が真っ白になる

- 担当：Backend（`src/room/engine.ts`：採用前の検査）＋ Client（`src/components/Room.tsx`：表示側の防御）
- 再現：`selectedGame: 'constructor'`（または登録にない任意の文字列）の状態を送る。`parseRoomState` は文字列であることしか見ないので全員が採用し、`Lobby` の `GAMES[state.selectedGame]` が `undefined`（`constructor` なら `Object` 関数）になって `selected.id` / `selected.minPlayers` で例外。エラー境界がないのでアプリ全体が真っ白になる。`game.id: '__proto__'` も `GameArea` の `if (!def)` をすり抜けて `def.View` が `undefined` になり同じ結果。
- 影響：悪意だけでなく、**デプロイ直後の版ずれ**（新しいタブが新ゲームを選び、古いタブが受け取る）でも起こる。
- 修正案：
  - Backend：`onState`（とスナップショット復元）で `Object.hasOwn(games, selectedGame)` と、`game` があれば `Object.hasOwn(games, game.id)` を確かめ、満たさない状態は採用しない（`parseRoomState` に `games` を渡す形でもよい）。
  - Client：`GAMES[...]` の参照を `Object.hasOwn` 付きにし、見つからなければ「未対応のゲームです」を出す（`GameArea` の既存の表示を `Lobby` にも）。
- テスト：`security-engine.test.ts` の `SEC-04: selectedGame / game.id が登録にない（constructor・__proto__ を含む）状態は採用しない`
- Client 対応（済み）：`src/components/Room.tsx` のゲーム参照を `findGame`（`Object.hasOwn(GAMES, id)`）に統一。登録にない `selectedGame` はゲーム選択欄を残したまま、`game.id` はゲーム枠に「このゲームは新しいバージョンで追加されました。ページを再読み込みしてください」と「再読み込み」（ホストには「ロビーへ」も）を出す。あわせてエラー境界 `src/components/ErrorBoundary.tsx` を、ゲームの View（メンバー・チャットは残してゲーム枠だけ「ゲーム画面を表示できませんでした」）・部屋の画面全体・アプリ全体（`main.tsx`）の 3 か所に入れた（MVP-15 の View のエラー境界、R-02 / T-21 の画面破壊も緩和）。E2E（Playwright、360 / 1280px）で `selectedGame: 'constructor'`・`game.id: '__proto__'`・形の壊れた大富豪の `game.state` を BroadcastChannel から送り、いずれも真っ白にならず該当の表示になること、ページエラー 0 件を確認（Backend の採用前検査は未マージの状態で確認）

### SEC-05（低）深い入れ子の `game.state` を受けると、受信処理から例外が漏れる

- 担当：Backend（`src/room/engine.ts` の `saveNow`）
- 再現：10 万段の入れ子を `game.state` に入れた状態を送る（前回の保存から 1 秒以上あと）。採用後の `saveNow` の `JSON.stringify` が `RangeError` を投げ、`handleRaw` の途中（`stopHostTimers`・`emit` の前）で Transport の受信コールバックまで抜ける。以後の保存タイマーでも毎回投げる。
- 影響：CLAUDE.md「不正なものは状態を変えずに無視する（例外を投げない）」に反する。画面の更新が止まる・ホストのタイマーが止まらないなど、状態の食い違いが起きうる。
- 修正案：`saveNow` の `JSON.stringify` を `try/catch` に入れる（`safeSet` の中で文字列化する）。採用前に `game.state` の深さを見る（例：64 段まで）のも可。
- テスト：`security-engine.test.ts` の `SEC-05: 深い入れ子（10 万段）の game.state を含む状態を受けても、受信処理が例外を外に漏らさない`

### SEC-06（低）毎回違う ID のメッセージで、生存確認の表が際限なく増える

- 担当：Backend（`src/room/engine.ts`：`lastSeen` / `rate` / `syncReplyAt`）
- 再現：`hb` / `sync` を毎回違う `from` で 3000 件送る。30 秒たっても `lastSeen` に 3000 件以上残り（`rate`・`syncReplyAt` も同様）、受信のたびの `refreshOnline` がその全件をなめる。
- 影響：長時間続けられると端末（特にホスト）のメモリと CPU を食い、操作が重くなる。
- 修正案：`refreshOnline` で、メンバー（`state.players`）でも現在のホストでもない ID のうち `OFFLINE_AFTER_MS` を過ぎたものを `lastSeen` から消す。`rate` / `syncReplyAt` も窓を過ぎたものを消す。メンバーの `lastSeen` は今どおり残す（`checkStall` の「全員が去った」判定・P1-5 を変えないため）。
- テスト：`security-engine.test.ts` の `SEC-06: 毎回違う送信元 ID の hb を大量に送られても、生存確認の表が際限なく増えない`（engine の内部の表を直接見ている。名前を変えたらテストも直す）

### 票の一覧

| ID | 重大度 | 要約 | 担当 | skip テスト | 状態 |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | 中 | 巨大 epoch / version の偽の状態 1 通で部屋が恒久的に壊れる | Backend | `security-engine` SEC-01 ×2 | 修正済み（Backend：`isImplausibleJump` で epoch +1000・version +100 万を超える飛びを捨てる。ホストは配り直す） |
| SEC-02 | 中 | 他人の ID で巨大 seq を送ると、その人は二度と操作できない | Backend | `security-protocol` SEC-02 | 修正済み（Backend：`acceptAction` で処理済み seq + `SEQ_JUMP_MAX`（1000）超を捨てる） |
| SEC-03 | 中 | `__proto__` 等の ID でワードウルフ処刑不能・大富豪停止 | Backend | `security-protocol` SEC-03 | 修正済み（Backend：`isId` を `[A-Za-z0-9_-]` かつ `Object.prototype` にない名前に限定） |
| SEC-04 | 中 | 未知の `selectedGame` / `game.id` で全員の画面が真っ白（版ずれでも） | Backend + Client | `security-engine` SEC-04 | Backend 側修正済み（`hasKnownGames` で採用・復元前に確認）。表示側のガードは Client |
| SEC-05 | 低 | 深い入れ子の `game.state` で受信処理から例外が漏れる | Backend | `security-engine` SEC-05 | 修正済み（Backend：`game.state` の入れ子 64 段まで。`saveNow` の文字列化を try 内に） |
| SEC-06 | 低 | 違う ID の大量送信で生存確認の表が増え続ける | Backend | `security-engine` SEC-06 | 修正済み（Backend：tick ごとに非メンバーの `lastSeen` / `departed` と期限切れの `rate` / `syncReplyAt` を削除） |

閉じる条件：対応する `it.skip` を `it` に戻して `npm test` が通ること（Security が再確認して本書に記録する。WBS §5）。

**Backend 対応（2026-11-07）**：SEC-01〜06 の Backend 分を修正し、対応する `it.skip` 7 件をすべて `it` に戻して通過（SEC-05 は `parseRoomState` の深さ上限の単体テストを 1 件追加）。テストの期待値は変更していない。上限値と挙動は設計 §13.1 P2-1〜P2-6。Security の再確認待ち。

---

## 5. 許容するリスク（S-04）

### 5.1 一覧

| ID | リスク | 影響 | 起こりやすさ | 今回の扱い | 次フェーズの案 |
| --- | --- | --- | --- | --- | --- |
| R-01 | **なりすまし**：`from` は自己申告。他人として操作・チャット・退出（相手は「外された」画面になる）させられる。`bye` / `sync` をホストの ID で送ってホスト交代を起こせる | 中：嫌がらせ・ゲームの妨害。データの持ち出しはない | 低（友達同士）。部屋コードを知る第三者なら可能 | 許容。README の注意書きを維持 | 参加ごとの鍵（端末で鍵ペアを作り、`join` で公開鍵を登録し、メッセージに署名）。Supabase Presence や認証付きチャンネルの利用 |
| R-02 | **偽の状態による乗っ取り・改ざん**：状態に署名がないので、参加者でも第三者でも `epoch + 1` の状態でホストを名乗り、メンバー・チャット・ゲームの中身を書き換えられる。View が想定しない `game.state` で画面を壊せる | 高：その部屋のゲームは成り立たない（攻撃者が去れば交代で戻る。戻らないものは SEC-01） | 低（友達同士）〜中（コードが漏れた場合） | 許容。SEC-01・SEC-04・SEC-05 で「戻らない」「全員の画面が消える」だけは防ぐ | 状態に署名（ホストの公開鍵を部屋作成時に固定）。View のエラー境界（MVP-15） |
| R-03 | **ホスト本人の不正**：ホストは `reduce` を自分の端末で実行するので、好きな状態を作れる・他人の操作を捨てられる・タイマーを操作できる | 高：ホストの思いどおりの結果になる | 低（友達同士） | 許容（ホスト権威型の前提。サーバーなしでは原理的に防げない） | サーバー（Edge Function 等）でゲームを進める |
| R-04 | **自己申告の結果**：ラッシュの成否・スコア、反射神経のタイムは端末が申告する。反射神経は合図の時刻（`wait` 中の `until`）も配られるので自動化できる | 中：そのゲームの勝敗が不正になる | 低（開発者ツールの操作が要る） | 許容 | 反射神経はホストの受信時刻と合図の時刻の差で上限を付ける（遅延で不利になるので要調整）。合図の時刻は `go` の直前まで配らない |
| R-05 | **隠すべき情報が全員に配られる**：大富豪の全員の手札、ワードウルフの全員のお題とウルフ、多数決の回答中の答え | 中：覗いた人が有利になる | 低（開発者ツールの操作が要る。README で告知済み） | 許容 | 端末ごとの公開鍵で秘密の部分だけ暗号化して配る。ワードウルフは「自分のお題だけ」を個別に届ける仕組み |
| R-06 | **部屋コードの推測・盗み聞き**：コードは 31^4 ≒ 92 万通り。チャンネルは公開（Private channels は使わない）で、anon キーはビルドに含まれる公開値。コードを知る人は誰でもチャットとゲームの内容を読め、R-01・R-02 の攻撃ができる | 中：チャットの内容が第三者に読まれうる | 低（特定の部屋を狙うには推測が必要。総当たりは Supabase の接続数上限に当たる） | 許容。チャットに個人情報を書かない旨を案内するのが望ましい | コードを 6 文字にする（約 8.9 億通り。入力の手間とのトレードオフ）。部屋ごとの合言葉を URL のフラグメントに入れて暗号化 |
| R-07 | **Supabase プロジェクト全体への過剰送信**：`eventsPerSecond: 20` はクライアント側の設定で、anon キーを持つ人は外して大量に送れる。同じプロジェクトの全部屋が影響を受け、月間メッセージ枠を使い切ると全体が止まる | 高：サイト全体が使えなくなる | 低（意図的な攻撃が要る） | 許容。ただし公開時に Supabase の利用上限（Spend cap）とダッシュボードの監視を設定する（設計 §8） | サーバー側のレート制限（認証付きチャンネル・RLS） |
| R-08 | **レート制限・満員の回避**：上限は `from` 単位なので、ID を変えれば回避できる。偽の `join` で 10 人を埋めて「満員」にできる（ホストが外しても別 ID で入り直せる） | 中：部屋が使えなくなる（作り直せば回避可） | 低 | 許容。ホストの配信は 200ms 間引きで上限があり、全体の送信量は増えない（`security-engine` で確認） | R-01 の署名と合わせて「参加の承認」を入れる |

### 5.2 プロダクトオーナーの承認が必要な事項（WBS H-5）

次の 4 点を「友達同士で遊ぶ前提（PdM 仕様 6 章）」で受け入れるか、公開前に判断してほしい。

1. **部屋の参加者、または部屋コードを知る第三者は、なりすまし・ホストの乗っ取り・状態の改ざんができる**（R-01・R-02・R-08）。防ぐには署名か認証の基盤が要り、MVP の範囲を超える。
2. **ホスト本人と、開発者ツールを使う参加者は、ゲームで不正ができる**（R-03・R-04・R-05）。大富豪の手札、ワードウルフのお題、多数決の回答は覗ける（README に注意書きあり）。
3. **部屋の会話は、部屋コードを知る人なら誰でも読める**（R-06）。部屋コードは 4 文字（約 92 万通り）のまま。
4. **anon キーを使った大量送信で、サイト全体が止まる可能性がある**（R-07）。公開時に Supabase の利用上限と監視を設定することを条件にしたい。

一般公開（知らない人同士のマッチング等）をする場合は、1〜3 は受け入れられない水準になるので、署名・認証を次フェーズの必須項目にすることを勧める。

---

## 6. 任意の改善（票にしないもの）

- 部屋コード・プレイヤー ID の生成を `crypto.getRandomValues` にする（`src/lib/identity.ts`。コストは小さいが、他人の端末の乱数状態は観測できないため実害は小さい）。
- 状態を採用する条件に「`msg.from` が新しい状態の `hostId` か、今のホスト（譲渡）である」を加える。from は自己申告なので攻撃者には効かないが、他端末の不具合で混ざった状態を捨てる防御にはなる。
- チャット・名前の制御文字（双方向テキストの上書き文字など）を `reduceRoom` で取り除く（表示のなりすまし対策。React のテキスト描画なので XSS にはならない）。

---

## 7. 追加したテスト

| ファイル | 内容 | 件数 |
| --- | --- | --- |
| `src/__tests__/security-protocol.test.ts` | 壊れた値の大量投入（シード固定）、seq の異常値、巨大文字列、深い入れ子、件数上限、プロトタイプ汚染、権限、リプレイ、チャット連投、R-01 の確認 | 15（+ skip 2：SEC-02・SEC-03） |
| `src/__tests__/security-engine.test.ts` | 疑似ネットワークに攻撃者の Link をつないだ攻撃：ホスト ID の偽装、部外者・gameSystem・版違い・別コード、sync の連打、アクションの連打、R-02 の確認 | 5（+ skip 5：SEC-01 ×2・SEC-04・SEC-05・SEC-06） |
| `src/__tests__/security-games.test.ts` | 各ゲームの不正な手・タイマー専用アクションの偽装・範囲外の値、R-04・R-05 の確認 | 14 |
| `src/__tests__/security-static.test.ts` | HTML 文字列の API・eval・受信データ入りの href/src がないこと、`.gitignore`・`.env.example`・環境変数・鍵の直書き | 7 |

「許容リスクの確認」のテストは現状の挙動を記録したもの。対策を入れて挙動が変わったら、そのテストを書き換える。
