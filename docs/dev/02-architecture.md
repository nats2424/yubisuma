# 02. アーキテクチャ設計 — オンライン対戦の実用化（MVP Must）

- 作成：CTO（2026-11-07）
- 入力：`docs/dev/01-pdm-spec.md`（以下「PdM 仕様」）、`CLAUDE.md`、現行コード（`src/lib/transport.ts` / `src/room/*` / `src/components/{Room,Home}.tsx` / `src/games/{types,registry}.ts` / `src/games/{rush,micro}/*` / `src/__tests__/*`）
- 前提：サーバーは持たない（静的ホスティング + Supabase Realtime Broadcast のみ）。ホスト権威型を維持。Supabase キーはないので、検証は**疑似ネットワーク上の自動テスト**で行う。
- 範囲：PdM 仕様 5 章の **Must（MVP-1〜11）** のみ。Should（MVP-12〜15）と 6 章の対象外は設計に含めない。ただしコストがほぼゼロで、後から入れると契約が変わるもの 2 点だけは先に入れる（§10 ADR-11）。

---

## 0. 要約

1. `useRoom.ts` の中身（受信処理・tick・引き継ぎ判定）を、React に依存しない **`RoomEngine`**（`src/room/engine.ts`）に移す。依存（通信・時計・ストレージ・ゲーム一覧）はすべて注入する。`useRoom` は薄いラッパーになる。
2. 通信層を **「1 回分の接続（Link）」と「接続状態の管理（ManagedTransport）」**に分ける。Supabase 固有コードは Link だけ。再試行・再接続の状態機械は Link を差し替えた疑似ネットワーク上でそのままテストできる。
3. メッセージは `src/room/protocol.ts` の純粋関数で**形を検証してから**使う。アクションには参加者ごとの `seq` を付け、処理済み seq は `RoomState.acks` に持つ（ホスト交代で引き継がれる）。
4. ホストの状態配信は **200ms 間引き**（PdM 案の 100ms から変更。§8 の見積もりによる）。
5. 担当境界：**Backend = `src/lib/` `src/room/` `src/games/` `src/__tests__/`、Client = `src/components/` `src/App.tsx` `src/styles.css` `README.md` `index.html`**。両者の契約は `src/room/types.ts`（§9.3 に全文）で固定する。

---

## 1. モジュール構成

### 1.1 全体図

```
React（Client 担当）                     React 非依存（Backend 担当）
┌──────────────────────────┐
│ components/Room.tsx 他   │
│   useRoom() ─────────────┼──▶ room/useRoom.ts（薄いラッパー：engine 生成・ブラウザイベント配線）
└──────────────────────────┘          │
                                       ▼
                               room/engine.ts  RoomEngine
                               ├─ room/logic.ts     純粋：reduceRoom / acceptAction / compareStates …
                               ├─ room/protocol.ts  純粋：WireMessage 型・parse・レート制限
                               ├─ lib/transport.ts  ManagedTransport（接続状態機械）
                               │     └─ Link：supabaseLink / localLink（本番）・SimLink（テスト）
                               └─ lib/clock.ts      Clock：realClock（本番）・SimClock（テスト）
```

### 1.2 ファイル一覧

| ファイル | 新規/変更 | 担当 | 責務 |
| --- | --- | --- | --- |
| `src/lib/clock.ts` | 新規 | Backend | 時計とタイマーの抽象。本番は `Date.now` / `setTimeout` |
| `src/lib/transport.ts` | 全面変更 | Backend | `Link`（1 回分の接続）と `ManagedTransport`（connecting/connected/reconnecting/failed の状態機械、初回リトライ、再接続）。`isOnlineMode` は現行どおり公開 |
| `src/room/types.ts` | 新規 | Backend（**中身は本書 §9.3 で固定**） | Client との契約型：`RoomHandle` / `RoomStatus` / `ConnectionStatus` |
| `src/room/protocol.ts` | 新規 | Backend | `WireMessage` 型、`parseWireMessage` / `parseRoomAction` / `parseRoomState`、サイズ上限、レート制限の純粋関数 |
| `src/room/engine.ts` | 新規 | Backend | `RoomEngine`：受信処理・tick・ホスト引き継ぎ・同期要求・未確認アクションの再送・配信間引き・スナップショット |
| `src/room/logic.ts` | 変更 | Backend | `RoomState.acks` 追加、`acceptAction`、`startGame` 二重防止、チャット 3 件/3 秒、`reduce` 例外保護、`chatBlockedUntil` |
| `src/room/useRoom.ts` | 全面変更 | Backend | engine を生成し `useSyncExternalStore` で購読。`visibilitychange` / `pageshow` / `online` / `offline` / `pagehide` を engine に渡す |
| `src/games/micro/tuning.ts` | 新規 | Backend | ミニゲーム調整値の一元化と `validateTuning` |
| `src/games/micro/{core.ts, action.tsx, brain.tsx, MicroStage.tsx}` | 変更 | Backend | 直書きの数値を `tuning.ts` 参照に置き換えるだけ（見た目・挙動は不変） |
| `src/games/rush/logic.ts` | 変更 | Backend | テンポ値を `tuning.ts` から読む |
| `src/games/registry.ts` | 変更 | Backend | ラッシュのルール文言・ライフ選択肢を `tuning.ts` から生成 |
| `src/__tests__/sim/network.ts` | 新規 | Backend | 疑似ネットワーク（`SimNetwork` / `SimClock` / `SimLink`） |
| `src/__tests__/sim/harness.ts` | 新規 | Backend | 複数端末のルームを組み立てるテスト補助（`createSimRoom`・ラッシュ用 bot） |
| `src/__tests__/{protocol,transport,sync,tuning}.test.ts` | 新規 | Backend | §6.4 の AC 対応表どおり |
| `src/__tests__/logic.test.ts` | 追記 | Backend | 純粋ロジックの AC |
| `src/components/Room.tsx` | 変更 | Client | 新しい `status` / `connection` の画面分岐、「再接続中…」帯、満員画面、`retry()`、チャット制限の UI |
| `src/components/Chat.tsx` | 変更 | Client | 送信ボタンの一時無効化（`blockedUntil` を props で受ける） |
| `src/components/Practice.tsx` | 変更 | Client | `INTRO_MS` などの直書きを `tuning.ts` の値に置き換え、ルール文言を生成関数から取る |
| `src/App.tsx` | 変更 | Client | 「このコードで部屋を作る」で同じハッシュでも Room を作り直す（E-12） |
| `src/styles.css` | 変更 | Client | 帯・満員画面のスタイル（360px 幅） |
| `README.md` | 変更 | Client | Vercel 手順、しくみの説明の更新（数値は本書 §4 の値を使う） |
| `CLAUDE.md` | 変更 | Backend | 「構成」に `engine.ts` / `protocol.ts` / `tuning.ts` / `__tests__/sim/` を追記（最後に 1 回） |

変更しないもの：`src/games/types.ts`（`GameDef` / `GameViewProps` は据え置き）、各ゲームの `View.tsx`、`vite.config.ts`、`package.json`（**新しい依存は入れない**。jsdom / Testing Library も入れない → ADR-9）。

### 1.3 公開インターフェース（型シグネチャ）

#### `src/lib/clock.ts`

```ts
// タイマーの取り消し関数を返す形にして、本番とテストで ID 型の違いを気にしなくてよいようにする
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}
export const realClock: Clock;
```

#### `src/lib/transport.ts`

```ts
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

// 1 回分の接続。Supabase なら 1 つの RealtimeChannel、テストなら SimLink
export type LinkEvents = {
  onOpen(): void;                 // 送受信可能になった（初回・ライブラリによる自動再参加の両方）
  onDown(reason: string): void;   // CHANNEL_ERROR / TIMED_OUT / CLOSED
  onMessage(msg: unknown): void;
};
export interface Link {
  send(msg: unknown): void;
  close(): void;
}
export type LinkFactory = (roomCode: string, ev: LinkEvents) => Link;

// アプリが使う通信層。自分が送ったメッセージは自分には届かない（現行どおり）
export interface Transport {
  readonly status: ConnectionStatus;
  send(msg: unknown): boolean;                         // connected 以外では送らず false
  onMessage(cb: (msg: unknown) => void): () => void;   // 戻り値で購読解除
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  reconnect(): void;                                   // 今すぐ張り直す（failed からの再試行もこれ）
  nudge(): void;                                       // 復帰時：failed なら reconnect()、reconnecting で Link が 5 秒以上前のものなら作り直す（R-01）
  setNetworkOnline(online: boolean): void;             // navigator の online/offline を伝える
  close(): void;
}

export const isOnlineMode: boolean;                    // 現行どおり（Client も参照）
export const supabaseLinkFactory: LinkFactory;
export const localLinkFactory: LinkFactory;            // BroadcastChannel（デモ）。即 onOpen
export function createManagedTransport(factory: LinkFactory, roomCode: string, clock: Clock): Transport;
export function createTransport(roomCode: string): Transport; // isOnlineMode で factory を選ぶ
```

#### `src/room/protocol.ts`

```ts
export const PROTOCOL_VERSION = 2;          // 旧クライアント（v なし）のメッセージは捨てる
export const MAX_ID_LEN = 40;
export const MAX_STATE_BYTES = 64 * 1024;   // AC-22 の上限（UTF-8 バイト）

export type WireMessage =
  | { v: 2; t: 'state'; from: string; state: RoomState; sentAt: number }
  | { v: 2; t: 'action'; from: string; seq: number; action: RoomAction }
  | { v: 2; t: 'join'; from: string; name: string }
  | { v: 2; t: 'sync'; from: string }
  | { v: 2; t: 'hb'; from: string }
  | { v: 2; t: 'bye'; from: string };

// 不正なら null（例外は投げない）
export function parseWireMessage(raw: unknown, roomCode: string): WireMessage | null;
export function parseRoomAction(raw: unknown): RoomAction | null;
export function parseRoomState(raw: unknown, roomCode: string): RoomState | null;

// 直近 windowMs に limit 件まで。純粋関数（履歴配列を返す）
export function allowRate(history: readonly number[], now: number, limit: number, windowMs: number):
  { ok: boolean; history: number[] };
```

#### `src/room/logic.ts`（追加・変更分）

```ts
export type RoomState = {
  // …現行のフィールド…
  // 参加者ごとの処理済み最大 seq。メンバーの分だけ持つ（最大 10 件）
  acks: Record<string, number>;
};

export const CHAT_MAX_LEN = 200;                           // export に変更
export const CHAT_RATE = { count: 3, windowMs: 3000 } as const;
export const START_GUARD_MS = 1500;

// seq 付きアクションの受付。重複・古い seq・非メンバーなら null（状態を変えない）
// 受け付けた場合は reduce の結果が変わらなくても acks を進めた新しい状態を返す
export function acceptAction(
  state: RoomState, by: string, seq: number, action: RoomAction, now: number, games: GameRegistry,
): RoomState | null;

// この時刻までチャットを送れない（送れるなら 0）。Client のボタン無効化とホストの判定で同じ式を使う
export function chatBlockedUntil(state: RoomState, me: string, now: number): number;
```

- **Phase 0 で調整**：`chatBlockedUntil` の数え方を明確にした。直近 `windowMs` 内（`at > now - windowMs`）の自分の発言が `count` 件以上なら、新しい方から数えて `count` 件目の `at + windowMs` を返す（スライディングウィンドウ。3 件送った直後なら直近 3 件のうち最も古い発言の `at + 3000`）。その時刻以降、または件数が足りなければ 0。

`reduceRoom` の変更：
- `game` / `gameSystem`：`def.reduce` を `try/catch` で包み、例外なら `state` をそのまま返す（AC-04）。
- `startGame`：`state.game && now - state.game.startedAt < START_GUARD_MS` なら無視（AC-21）。
- `chat`：`chatBlockedUntil(state, by, now) > now` なら無視（AC-20）。`state.chat` の `by` / `at` から数えるので追加の状態は不要。
- `leave` / `kick`：`acks` から対象を削除。`join`：`acks[by]` は作らない（最初の seq 受付時に作る）。
- `createRoom`：`acks: {}`。

#### `src/room/engine.ts`

```ts
export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void; }

export type EngineDeps = {
  code: string; me: string; name: string; create: boolean;
  transport: Transport; clock: Clock; storage: KeyValueStore; games: GameRegistry;
};

export type EngineSnapshot = {
  status: RoomStatus;
  connection: ConnectionStatus;
  state: RoomState | null;
  isHost: boolean;
  online: Set<string>;
};

export class RoomEngine {
  constructor(deps: EngineDeps);
  start(): void;
  dispose(): void;                       // bye を送り、タイマー停止、transport.close
  // useSyncExternalStore 用：変化がない限り同じオブジェクトを返す
  getSnapshot(): EngineSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: RoomAction): void;
  now(): number;                         // ルーム共通時計（ホスト基準）
  leave(): void;
  retry(): void;
  // ブラウザイベント（useRoom が配線する。テストでは直接呼ぶ）
  resume(): void;                        // visibilitychange→visible / pageshow / online
  setNetworkOnline(online: boolean): void;
  pageHide(): void;                      // bye 送信
}

export const ROOM_TIMINGS: { /* §4 の表の値 */ };
```

#### `src/room/useRoom.ts`

```ts
// シグネチャは現行どおり。戻り値の型だけ src/room/types.ts の RoomHandle に変わる
export function useRoom(code: string, me: string, name: string, create: boolean): RoomHandle;
export type { RoomHandle, RoomStatus, ConnectionStatus } from './types';
```

---

## 2. メッセージプロトコル

### 2.1 メッセージ種別

| 種別 | 送る人 | いつ | 受けた側 |
| --- | --- | --- | --- |
| `state` | ホスト | 状態変化時（200ms 間引き）、2.5 秒ごとの定期再送、同期要求への応答 | `compareStates` で新しければ採用 |
| `action` | 参加者 | `dispatch` 時と再送時（同じ seq） | ホストだけが処理。他は無視 |
| `join` | 未参加者 | 自分のいない `state` を受けたとき・状態待ちの間（1 秒に 1 回まで） | ホストが `reduceRoom(join)`。冪等なので seq なし |
| `sync` | 状態を持っていない端末 | 接続直後・再接続直後・状態待ちの間 1 秒ごと | ホストは状態を配信（相手ごと 1 秒 1 回まで）。§5.3 の特例あり |
| `hb` | 参加者（ホスト以外） | 3 秒ごと。直前 3 秒に他のメッセージを送っていれば省略 | `lastSeen` 更新のみ |
| `bye` | 全員 | `pagehide`・退出・engine 破棄 | `lastSeen` を消し、「明示的に去った」印を付ける |

- 全メッセージに `v: 2` と `from`（1〜40 文字）を付ける。`v` が違うものは捨てる（デプロイ直後に古いタブが混ざっても壊れないように）。
- **受信したら何でも** `lastSeen[from]` を更新する（`hb` 以外も生存通知を兼ねる）。
- `state` は「全員宛て」のブロードキャストしかないので、同期要求への応答も全員に届く。宛先指定はしない。

### 2.2 受信データの検証（F2）

`parseWireMessage` の検査内容。どれかに違反したら `null`（黙って捨てる）。

| 対象 | 検査 |
| --- | --- |
| 共通 | オブジェクトである / `v === 2` / `t` が既知 / `from` が 1〜40 文字の文字列 |
| `state.state` | `code` が自部屋と一致、`epoch` `version` が正の安全な整数、`hostId` が文字列、`players` が `{id: string, name: string}` の配列（最大 10）、`selectedGame` が文字列、`gameOptions` がオブジェクト（値は数値）、`chat` が配列（最大 100、各要素の `id/name/text` が文字列・`by` が文字列か null・`at` が数値）、`game` が null か `{id: string, players: 配列, startedAt: 数値, state: 任意}`、`acks` がオブジェクト（値は非負整数、最大 20 件。旧形式で欠けていれば `{}` を補う） |
| `state.sentAt` | 有限の数値 |
| `action.seq` | 正の安全な整数 |
| `action.action`（`parseRoomAction`） | `type` ごと：`join.name` 文字列 / `kick.target` 文字列 / `chat.text` 文字列（受信時 1000 文字まで、`reduceRoom` で 200 に切る）/ `selectGame.gameId` 文字列 / `setOption.key` 文字列・`value` 有限数 / `startGame.online` 文字列配列（最大 20）/ `game.action` は存在すること（中身はゲームの `reduce` が検証） / `gameSystem` は**ネットワークから受け付けない**（ホスト自身のタイマー専用） |
| `join.name` | 文字列（`reduceRoom` で 10 文字に切る） |

- `game.state` の中身はゲームごとに形が違うので検証しない（ホストが作ったものを信頼する。友達同士の前提：PdM 仕様 6 章）。
- ホストの `reduceRoom` は `try/catch` で保護（AC-04）。`schedule()` も engine 側で `try/catch` し、例外ならタイマーを張らない。

### 2.3 連番・重複除去・再送・ACK（F4）

**ACK は専用メッセージを作らず、`state.acks[自分]` で受け取る**（状態は全員に配られているため、追加のメッセージ数ゼロ）。

参加者側（engine 内）：

```
nextSeq   : 次に使う seq（1 から）
outbox    : { seq, action, firstSentAt, lastSentAt }[]   最大 50 件

dispatch(action)（自分がホストでないとき）:
  outbox.push({ seq: nextSeq++, action, firstSentAt: now, lastSentAt: now }); 送信

state を採用したとき:
  ack = state.acks[me] ?? 0
  nextSeq = max(nextSeq, ack + 1)          // リロード後に seq が 1 から始まっても追い越せる
  ホストが変わった採用なら → 直ちに再送処理

再送処理（tick ごと / 再接続直後 / タブ復帰直後 / ホストが変わったとき）:
  outbox から firstSentAt が 10 秒より前のものを捨てる（古い操作を後から適用しない）
  採用中の state.acks[me] より大きい seq を、seq の昇順に、lastSentAt から 1 秒以上経っていれば同じ seq で再送
```

- **確認済みでも 10 秒間は outbox から消さない**のがポイント。二重ホストで負けた側が処理した操作は、勝った側の状態（`acks` が小さい）を採用した瞬間に「未確認」に戻り、自動で勝った側へ再送される（E-06 / F6 の要件）。
- 自分がホストになった瞬間（引き継ぎ時）は、outbox の未確認分を `acceptAction` で自分の状態に順に適用する（送り先がいなくなった操作を失わない）。

ホスト側：

```
action を受信:
  allowRate（その人の直近 1 秒の受付履歴, 上限 10）→ 超過なら捨てる（acks は進めない＝本人が再送できる）
  next = acceptAction(state, from, seq, action, now, games)
    - from がメンバーでない → null
    - seq <= acks[from] → null（重複・古いもの。AC-12 / AC-13）
    - それ以外 → reduceRoom の結果に acks[from] = seq を載せて返す（reduce で変化がなくても新しい状態）
  null でなければ version+1 して commit → 配信要求
```

- 順序入れ替わり：seq 5 が先に処理されると `acks=5` になり、後から届いた seq 4 は捨てられる（AC-13）。参加者側も `seq <= ack` は再送しない。
- ホスト交代後も `acks` は `RoomState` の一部として引き継がれる（AC-15）。
- ホスト自身の操作は seq なしでローカル即時適用（現行どおり）。
- 退出（`leave`）は seq 付きで**同じ seq を 2 回連続で送る**（退出後は再送できないため。重複は seq で無害）。

### 2.4 状態配信の間引き（F5）

```
requestBroadcast():   // commit・同期要求・古いホストへの反論 から呼ぶ
  経過 = now - lastStateSentAt
  経過 >= 200ms → 今すぐ最新状態を送る
  そうでなければ → (lastStateSentAt + 200ms) に 1 回だけ送るタイマー（既にあれば何もしない）
  ※ タイマー発火時は「その時点の最新状態」を送る → 最後の変更は必ず届く
定期再送: lastStateSentAt から 2.5 秒経ったら送る（ホストの生存通知を兼ねる。ホストは hb を送らない）
```

- 上限はホストの状態配信 **5 件/秒**（PdM 案は 10 件/秒。変更理由は §8 と ADR-5）。AC-18 の「10 件以下」は満たす。
- ローカルの画面（`setState`）は間引かない。ホストの操作感は即時のまま。
- スナップショット保存（sessionStorage）は最大 1 秒に 1 回 + `pagehide` 時。

### 2.5 レート制限・サイズ上限

| 対象 | 上限 | 場所 | 超過時 |
| --- | --- | --- | --- |
| ホストの状態配信 | 5 件/秒（200ms 間引き） | engine | まとめて最新 1 件 |
| 参加者 1 人のアクション + join | 10 件/秒 | engine（ホスト側、メモリ上の履歴） | 捨てる。acks を進めない |
| チャット | 1 人 3 件/3 秒 | `logic.ts`（`state.chat` から数える） | ホストで捨てる。Client は `chatBlockedUntil` でボタン無効化 |
| 同期要求への応答 | 相手ごと 1 回/秒 | engine | 無視（全体の配信は上の間引きに合流） |
| `startGame` | 開始から 1.5 秒以内は無視 | `logic.ts` | 状態を変えない |
| outbox | 50 件・10 秒 | engine | 古いものから捨てる |
| 状態 JSON | 64KB（UTF-8） | テスト（AC-22） | — |
| 受信テキスト | `from` 40 / `chat.text` 1000 / `join.name` 任意長→10 に切る | protocol / logic | 捨てる or 切る |

**状態サイズの実測**（CTO が試算スクリプトで確認）：10 人（名前 10 文字）・チャット 60 件 × 200 文字（全角）・大富豪 6 人・`acks` 10 件で **約 45.7KB（UTF-8）**。うちチャットが 43.4KB、大富豪の状態は約 0.8KB。64KB に収まるので `CHAT_KEEP = 60` は据え置く（ADR-10）。`acks` の追加は約 0.3KB で影響なし（PdM 仕様 8 章への回答）。

---

## 3. 接続状態の状態遷移（F1）

### 3.1 ManagedTransport の状態機械

```
             new Link            onOpen
 (start) ─▶ connecting ───────────────────────▶ connected ◀──────────────┐
              │  ▲                                 │                      │ onOpen
   onDown /   │  │ 待機 1s→2s→4s 後に新しい Link    │ onDown / offline     │
   5s 無応答  │  │（最大 3 回リトライ）              ▼                      │
              ├──┘                              reconnecting ─────────────┘
              │ 4 回目も失敗                       │  8 秒たっても戻らない → Link を作り直す（繰り返し）
              ▼                                   │  online イベント / reconnect() → 今すぐ作り直す
            failed ── reconnect() ──▶ connecting（リトライ回数リセット）
```

| 値 | 内容 |
| --- | --- |
| `CONNECT_TIMEOUT_MS` | 5000（1 回の接続試行の待ち。Supabase 既定 10 秒では `failed` まで 47 秒かかるため短縮） |
| `RETRY_DELAYS_MS` | `[1000, 2000, 4000]`（初回接続の自動リトライ 3 回。最悪 約 27 秒で `failed`） |
| `REBUILD_AFTER_MS` | 8000（`reconnecting` が続いたら Link を作り直す間隔） |

- 一度 `connected` になった後は `failed` にしない（自動復旧を待ち続け、帯で知らせる）。
- `send` は `connected` のときだけ実際に送る。それ以外は送らずに `false`（realtime-js の REST 自動フォールバックを使わない。確実性は seq 再送と同期要求で担保する → ADR-6）。
- Supabase Link：`subscribe` コールバックの `SUBSCRIBED` → `onOpen`、`CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` → `onDown`。realtime-js 2.117.3 はソケット再接続時にチャンネルへ自動で再参加し、同じコールバックに `SUBSCRIBED` を再度通知する（ソース確認済み）。`close()` は `removeChannel`。
- Local Link（デモモード）：生成直後に `onOpen`。以後ずっと `connected`。
- `setNetworkOnline(false)`：`connected` なら `reconnecting` へ。`setNetworkOnline(true)`：`reconnecting` / `failed` なら `reconnect()`。
- `nudge()`（R-01 で追加）：engine の `resume()` が呼ぶ。`failed` なら `reconnect()`、`reconnecting` は今の Link を作ってから `NUDGE_REBUILD_MIN_MS`（= `CONNECT_TIMEOUT_MS`）以上経っていれば作り直す。`connecting`（初回のリトライ中）と作ったばかりの Link はそのまま待つ。`online` と `visibilitychange` / `pageshow` がほぼ同時に来ても Link（本番では WebSocket）を 1 本しか作らないため。

### 3.2 アプリ層の無通信検知（engine）

ソケットが生きているように見えて何も届かない状態（トンネル等。realtime-js のハートビート検知は数十秒かかる）に備え、engine は次を行う：

- 他のメンバーがオンラインだったのに、**誰からも 9 秒受信がない**（`connected` 中）→ `transport.reconnect()` を 1 回呼ぶ。次に何か受信するまで繰り返さない（全員が本当にいなくなった部屋で帯が出続けないように）。

### 3.3 UI に渡す値

engine は `status`（画面の種類）と `connection`（通信状態）を分けて渡す。

| `status` | 条件 | 画面（文言は PdM 仕様どおり） |
| --- | --- | --- |
| `connecting` | 状態未取得で、下のどれでもない | 「接続中…」 |
| `failed` | 状態未取得 かつ `connection === 'failed'` | 「接続できませんでした」＋「再試行」（`retry()`） |
| `notfound` | `connected` になってから 8 秒、状態が来ない（`create` でもなく復元もしない） | 「部屋 XXXX が見つかりません」＋「このコードで部屋を作る」。後から状態が届けば `ready` に戻る |
| `full` | 自分のいない状態を受け、`players.length >= 10`、このセッションで一度もメンバーになっていない | 「この部屋は満員です（最大 10 人）」＋「トップへ」。以後 `join` を送らない |
| `ready` | 状態を持っている | 通常画面。**`connection !== 'connected'` なら上部に「再接続中…」の帯**（ゲーム画面は消さない） |
| `left` | 自分で `leave()` した | 「部屋を退出しました」 |
| `kicked` | メンバーだった自分が、自分のいない状態を受けた | 最低限 `left` と同じ画面で可。「ホストにより外されました」の出し分けは Should（MVP-13） |

---

## 4. タイマー値（`ROOM_TIMINGS`）

| 名前 | 値 | 現行 | 用途 |
| --- | --- | --- | --- |
| `TICK_MS` | 500 | 500 | engine の定期処理 |
| `HEARTBEAT_MS` | 3000 | 2500 | 参加者の生存通知（直前に何か送っていれば省略） |
| `HOST_RESYNC_MS` | 2500 | 5000 | ホストの定期状態配信（ホストは hb を送らない） |
| `OFFLINE_AFTER_MS` | 9000 | 9000 | オンライン判定・ホスト喪失判定 |
| `LONE_TAKEOVER_MS` | 30000 | なし | 自分以外誰もオンラインでないときの引き継ぎ待ち（ADR-7） |
| `STALL_MS` | 9000 | なし | §3.2 の無通信検知 |
| `STATE_THROTTLE_MS` | 200 | なし | 状態配信の間引き |
| `SYNC_RETRY_MS` | 1000 | なし | 状態待ちの間の同期要求の間隔 |
| `SYNC_REPLY_MIN_MS` | 1000 | なし | 同じ相手の同期要求に応える最小間隔 |
| `RESTORE_AFTER_MS` | 3000 | 3500 | 誰の声も聞こえないとき、スナップショットから復元するまで |
| `JOIN_TIMEOUT_MS` | 8000 | 8000 | `connected` からの「部屋が見つかりません」 |
| `RESEND_MS` | 1000 | なし | 未確認アクションの再送間隔 |
| `PENDING_TTL_MS` | 10000 | なし | 未確認アクションの寿命 |
| `ACTION_RATE` | 10 件 / 1000ms | なし | ホストの 1 人あたり受付上限 |
| `RESUME_GAP_MS` | 3000 | なし | tick の間隔がこれを超えたら「スリープ明け」とみなして `resume()` |

時刻の基準：`lastSeen` やタイマーはローカル時計（`clock.now()`）、ゲームの時刻（`schedule().at` / `endsAt`）はルーム共通時計（`engine.now()` = ローカル + ホストとの差の推定、現行方式）。

---

## 5. アルゴリズム

### 5.1 起動と参加

```
start():
  transport を購読
  connected になったら（初回も再接続も）:
    connectedAt = now
    create なら（初回だけ）: createRoom → commit → 配信
    そうでなく状態がないなら: sync と join を送る
    状態があるなら: sync（ホスト以外）/ 状態配信（ホスト）、再送処理
tick（状態がないとき）:
  connected 中、SYNC_RETRY_MS ごとに sync + join
  connected から RESTORE_AFTER_MS 経過 かつ 状態を持つ端末（state・action・hb の送り手）から一度も受信していない
    かつ スナップショットに自分がいる → takeOverHost(snapshot) で自分がホストとして復元（AC-30）
  connected から JOIN_TIMEOUT_MS 経過 → status = notfound
    （状態を持つ端末の声を聞いていれば JOIN_TIMEOUT_MS + OFFLINE_AFTER_MS。§13.1 P2-10）
```

- 「誰からも受信していない」ことを復元の条件にするのは、生きている部屋に古いスナップショットの世代（epoch+1）を被せて巻き戻さないため。ホストが生きていれば sync に必ず状態で答える。
- （QA-BUG-02 で変更）状態待ちの端末は sync・join（・bye）しか送らない（`resume()` の hb も状態があるときだけ送る）。そこで「状態待ちの端末の声」は復元を止める理由に数えない。2 人が同時にリロードした部屋では両方が復元し、同じ世代の競合として `compareStates`（hostId の小さい方）で 1 人に収束する。状態を持つ参加者は、sync を受けたとき直前 `SYNC_REPLY_MIN_MS` に何も送っていなければ hb を送り、生きている部屋で復元させない。

### 5.2 状態の受信

```
on state(msg):
  cur がある かつ compareStates(msg.state, cur) <= 0:
    自分がホスト かつ cur の方が新しい → requestBroadcast()（古いホストに反論。E-07）
    return
  msg.state.hostId === msg.from なら時計ずれのサンプルに追加（ホストが変わったらサンプルをリセット）
  採用：commit(msg.state, 配信しない)
    → 自分がホストでなくなった場合はゲームのタイマーを止める（AC-27）
  自分が players にいる   → wasMember = true、nextSeq を acks で繰り上げ、ホストが変わったなら再送
  自分がいない:
    wasMember → status = kicked、以後送信しない
    players.length >= 10 → status = full、以後 join を送らない
    それ以外 → join（1 秒に 1 回まで）
```

### 5.3 ホスト交代（F6）

```
tick（自分がホストでない・メンバーである）:
  前提: connection === 'connected' かつ now - max(connectedAt, resumedAt) >= OFFLINE_AFTER_MS
  host = cur.hostId
  ホスト喪失 = (host が bye 済み) または (host から OFFLINE_AFTER_MS 受信なし)
  ホスト喪失 かつ pickNextHost(cur, online − 最後に join を送ってきた人, host) === me:   // §13.1 P2-10
    自分以外のオンラインメンバーがいる                         → 引き継ぐ
    いない: host が bye 済み、または全員から LONE_TAKEOVER_MS 受信なし → 引き継ぐ
引き継ぐ:
  next = takeOverHost(cur, me, now)（epoch+1）
  outbox の未確認分を acceptAction で順に適用
  commit → 即配信 → reschedule（予定時刻を過ぎていれば delay 0 で即実行。AC-28）

特例（ホストがリロードした場合）:
  現在のホスト自身から sync が届いた = ホストが状態を失った → その host を bye 扱いにする
  （ホストは sync を送らない設計なので、ホストからの sync はリロード後の新しい engine だけ）
```

- 所要時間：無通信なら 9 秒 + tick 0.5 秒 ≒ **9.5 秒**で新ホスト（AC-24 の 12 秒以内）。`bye` なら次の tick で **0.5 秒以内**（AC-25）。
- **二重ホストの収束**（AC-26）：両方が引き継いだ直後に配信する → 互いに受け取り、`compareStates` で負けた側は勝った側を採用、勝った側は負けた側の古い状態に反論配信。メッセージが欠けても定期再送 2.5 秒で収束する（目標 3 秒以内）。負けた側が処理した操作は §2.3 の outbox で勝った側へ再送される。
- **復帰した旧ホスト**（AC-27）：スリープ明けにタイマーが先に発火して古い世代の状態を配信しても、他の端末は世代が古いので捨て、新ホストが反論配信する。旧ホストは新しい世代を採用した時点でタイマーを止める。
- **ホストのリロード**（AC-29）：`pagehide` の `bye` → 0.5 秒で交代。`bye` が欠けても新しい engine の `sync` で特例が働く。本人は sync への応答で参加者として復帰（片道 200ms なら約 0.5〜1.5 秒）。`startedAt` は変わらない。

### 5.4 タブ復帰・スリープ明け（F9）

```
resume():   // visibilitychange→visible / pageshow / online、または tick 間隔 > RESUME_GAP_MS を検知
  resumedAt = now     // 9 秒間は引き継ぎ判定をしない（古い lastSeen で誤って引き継がないため）
  transport.status !== 'connected' → transport.nudge()（張り直したばかりの Link は捨てない。R-01）
  hb を送る
  自分がホスト → requestBroadcast()（他の誰かが新しいホストなら反論されて自分が降りる）
  ホストでない → sync を送る + 再送処理
```

- 目標「2 秒以内に最新状態」：`sync` → ホストの即応答（間引きの先頭は即送信）で、往復遅延 + α。
- 非表示中のホストが 9 秒以上止まったら他の人が引き継ぐ（現行どおり）。
- **スリープ明けの誤引き継ぎ防止が重要**：JS が止まっている間に `lastSeen` が全部古くなるので、`resumedAt` の猶予がないと復帰直後に「全員オフライン → 自分がホスト」となり、より新しい世代で部屋を巻き戻してしまう。

---

## 6. 疑似ネットワーク（テスト用）

### 6.1 構成

`src/__tests__/sim/network.ts`（vitest の対象パターン `*.test.ts` に当たらないので、テストとしては実行されない）

```ts
export class SimClock implements Clock {   // 仮想時刻。全端末で共有
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  advance(ms: number): void;               // 時刻を進め、期限の来たタイマーを順に実行
  runUntil(pred: () => boolean, maxMs: number, stepMs?: number): boolean;
}

export type LinkConditions = {
  latencyMs?: number;    // 片道の固定遅延（既定 20）
  jitterMs?: number;     // 0〜jitter の一様ゆらぎ（順序入れ替わりはここから自然に起きる）
  lossRate?: number;     // 0〜1。送信ごとに受信者別に判定
};

export class SimNetwork {
  constructor(opts?: { seed?: number });   // 欠落・ゆらぎはシード付き乱数で決定的にする
  readonly clock: SimClock;
  node(id: string, cond?: LinkConditions): SimNode;
  // 条件に合うメッセージを count 件だけ確実に落とす（AC-11 / AC-16 用）
  dropWhere(pred: (msg: unknown, from: string, to: string) => boolean, count?: number): void;
  readonly log: { at: number; from: string; msg: unknown }[];   // 送信ログ（AC-18 / AC-23 の数え上げ）
}

export interface SimNode {
  readonly linkFactory: LinkFactory;
  clockFor(skewMs?: number): Clock;        // 端末ごとの時計のずれ
  set(cond: LinkConditions): void;
  failConnects(n: number): void;           // 次の n 回の接続試行を onDown にする（AC-05 / AC-06）
  disconnect(): void;                      // onDown を通知し、以後送受信を落とす（AC-07）
  restore(): void;                         // ライブラリの自動再参加を模して onOpen
  freeze(): void;                          // スリープ：この端末のタイマーを止め、送受信を黙って落とす
  thaw(): void;                            // 復帰：溜まったタイマーを実行（resume() はテスト側で呼ぶ）
}
```

- メッセージは送信時に `JSON.parse(JSON.stringify(msg))` で複製する（実際の通信と同じく参照が共有されない・シリアライズ不能な値を検出する）。
- 接続試行は既定 50ms 後に `onOpen`。

`src/__tests__/sim/harness.ts`

```ts
export function createSimRoom(opts: {
  ids: string[];                 // ids[0] が create=true のホスト
  cond?: LinkConditions; seed?: number;
}): {
  sim: SimNetwork;
  peers: Record<string, SimPeer>;
  settle(ms?: number): void;     // 時刻を進める
  hostIds(): string[];           // 各端末が思っているホスト
};
export interface SimPeer {
  engine: RoomEngine; node: SimNode; storage: KeyValueStore;
  reload(): void;                // pageHide → dispose → 同じ id・storage で create=false の engine を作り直す
}
// ラッシュ用 bot：新しいステージ（seed が変わった）を見たら startAt + delayMs に submit を 1 回 dispatch
export function rushBot(peer: SimPeer, opts: { success: boolean; delayMs: number }): () => void;
```

### 6.2 方針

- engine には `SimClock` と `createManagedTransport(node.linkFactory, ...)` を注入する。**本番と同じ engine・同じ ManagedTransport** が動き、違うのは Link と Clock だけ。
- `vi.useFakeTimers` は使わない（全端末が 1 つの仮想時刻を共有し、端末ごとの停止＝スリープを表現するため）。
- 乱数はシード固定。AC-17 のような確率的な条件も、毎回同じ結果になる（フレークしない）。シードを 3 種類で回すテストにして偶然の合格を避ける。

### 6.3 AC-17（遅延・欠落下のラッシュ）の組み立て例

```
createSimRoom({ ids: ['a','b','c'], cond: { latencyMs: 0, jitterMs: 500, lossRate: 0.2 }, seed })
各 peer に rushBot(success: true, delayMs: 500)
a が selectGame('rush') → startGame
stage が 11 になるまで（または over）settle
ネットワークを正常に戻して 3 秒 settle
→ 3 人の state.game.state の stage / lives / cleared が一致
→ 全員 lives が開始時のまま（成功を送った人がミス扱いになっていない）
```

成立の根拠：`submit` は `startAt + 0.5s` に送られ、締め切り `endsAt = startAt + duration（10 ステージまでは 4.3 秒以上）+ 猶予 2.5 秒` までに 1 秒間隔で 6 回前後送られる。全部欠ける確率は 0.2^6 ≈ 0.006%。

### 6.4 AC とテストの対応

| ファイル | AC |
| --- | --- |
| `protocol.test.ts` | AC-01, 02, 03 |
| `logic.test.ts`（追記） | AC-04, 12, 13, 15（`acceptAction` の純粋テスト）, 20, 21, 22（最大構成の JSON を `TextEncoder` で測る） |
| `transport.test.ts` | AC-05, 06（`reconnect()` で再試行）, 07（状態） |
| `sync.test.ts` | AC-08, 09, 10, 11, 14, 16, 17, 18, 19, 23, 24, 25, 26, 27, 28, 29, 30, 31 |
| `tuning.test.ts` | AC-42, 43, 44（既存テストがそのまま通ることも含む） |
| 手動 | AC-06（画面）, 07（表示）, 31（表示）, 32, 36, 38, 39, 41, 46, AC-M 系 |
| AC-37 | 既に満たしている（CTO が `VITE_BASE=/yubisuma/` でビルドし、JS・CSS・favicon が `/yubisuma/` 配下を指すことを確認済み）。確認コマンドを README に載せる：`VITE_BASE=/yubisuma/ npm run build && grep -E 'src=|href=' dist/index.html` |

AC-23（連打で通信 1 件）：DOM のテスト環境は入れないので（ADR-9）、engine レベルで「`submit` を 1 回 dispatch すると、送信ログ上の `action` は同じ seq のものだけ（再送を含む）」を検証する。連打がローカル state で完結し `onDone` が seed ごとに 1 回なのは `MicroStage` の既存実装で、変更しないことをレビューで担保する。

---

## 7. ミニゲーム調整値の集約（F11）

### 7.1 `src/games/micro/tuning.ts`

```ts
export type MicroTuning = {
  enabled: boolean;      // false ならラッシュとひとり用チャレンジの出題から外す（ADR-11）
  baseMs: number;        // 基本の制限時間。大きくすると易しい
  scales: boolean;       // ステージが進むと速くなるか
  params: Record<string, number>;  // ゲームごとの難易度値（下表）
};

export const TUNING = {
  rush:  { introMs: 2400, resultMs: 2500, verdictMs: 1600, graceMs: 2500 },
  solo:  { introMs: 2000 },
  stage: { verdictMs: 1500, minPlayMs: 800 },
  speed: { everyStages: 5, step: 0.15, max: 2.0 },
  lives: { default: 4, choices: [3, 4, 5] },
  micro: {
    mash:    { enabled: true, baseMs: 5000, scales: true,  params: { tapsPerSec: 5 } },
    stop:    { enabled: true, baseMs: 5000, scales: true,  params: { zoneWidthPct: 12, periodMinMs: 900, periodMaxMs: 1400 } },
    whack:   { enabled: true, baseMs: 6000, scales: true,  params: { needRatio: 0.6, targetLifeMinMs: 600 } },
    dodge:   { enabled: true, baseMs: 6000, scales: true,  params: { gapMinMs: 260, gapBaseMs: 380, fallMinMs: 1100, fallMaxMs: 1700 } },
    balloon: { enabled: true, baseMs: 6000, scales: true,  params: { limitMin: 12, limitMax: 28, minTaps: 10 } },
    count:   { enabled: true, baseMs: 6000, scales: true,  params: { min: 5, max: 12, showMaxMs: 1600, showRatio: 0.3 } },
    color:   { enabled: true, baseMs: 7000, scales: true,  params: { needCorrect: 3, maxMiss: 0 } },
    math:    { enabled: true, baseMs: 7000, scales: true,  params: { needCorrect: 3 } },
    odd:     { enabled: true, baseMs: 6000, scales: true,  params: { gridSize: 25 } },
    timing:  { enabled: true, baseMs: 6000, scales: false, params: { targetMs: 3000, toleranceMs: 250 } },
  },
} satisfies Tuning;   // 各値の横に「大きくすると易しい/難しい」を日本語コメントで書く

export function speedForStage(stage: number, t?: Tuning): number;  // core.ts から移す（core は再エクスポート）
export function speedUpRuleText(t?: Tuning): string;               // 「5ステージごとにスピードアップ」
export function enabledMicroIds(t?: Tuning): string[];
export function validateTuning(t: Tuning): string[];               // 違反の説明の配列。空なら妥当
```

- **Phase 0 で調整**：本書に `Tuning` 型の定義がなかったので、`TUNING` の形どおりに次で確定した（`lives.choices` は `readonly number[]`、`micro` は `Record<string, MicroTuning>`）。`speedForStage` / `speedUpRuleText` は `(stage, t = TUNING)` / `(t = TUNING)` の既定引数で実装。Phase 0 では `enabledMicroIds` / `validateTuning` は未実装（B-20）。
  `type Tuning = { rush: {introMs; resultMs; verdictMs; graceMs}; solo: {introMs}; stage: {verdictMs; minPlayMs}; speed: {everyStages; step; max}; lives: {default; choices}; micro: Record<string, MicroTuning> }`（値はすべて `number`）

- `params` のキー名は上の表を初期案とし、Backend が `action.tsx` / `brain.tsx` を移すときに確定してよい（Client は参照しない）。数式中の係数（例：大きさの見た目 `0.05`）など「難易度ではない見た目の値」は移さない。
- `MICRO_META` は `title` / `hint` だけを持つ表示用データとして `core.ts` に残し、`baseMs` / `scales` は `TUNING.micro` から合成する（`microMeta(id)` の戻り値の形は変えない）。
- `nextMicroId` は `enabledMicroIds()` から選ぶ。ひとり用の「1つずつ練習」一覧は全種類のまま。
- 引数 `t` は妥当性テストで改変版を渡すためのもの。本番は既定の `TUNING`。

### 7.2 ルール文言の連動

- `registry.ts` のラッシュの `rules[1]` を `` `失敗するとライフが1つ減り、0になったら脱落。${speedUpRuleText()}。` `` に、`options.lives` を `TUNING.lives` から生成する。
- `Practice.tsx`（Client）の説明文 `5ステージごとにスピードアップ` も `speedUpRuleText()` を使う。

### 7.3 妥当性テスト（`tuning.test.ts`）

`validateTuning` が検査する：すべての時間が正 / `baseMs / speed.max >= 2000`（`scales: true` のもの。`false` は `baseMs >= 2000`）/ `enabled` が 2 種以上 / `lives.default ∈ lives.choices` / `speed.step > 0` / `min <= max` 系。テストは「`TUNING` で `[]`」と「各違反を入れた複製で該当メッセージが出る」の両方を書く（AC-43「違反する値にするとテストが失敗する」を、壊した複製で機械的に確認する）。AC-42 は `speedUpRuleText({...TUNING, speed: {...TUNING.speed, everyStages: 3}})` が「3ステージごと」を含むことを確認。

---

## 8. Supabase の上限見積もり（PdM 仕様 8 章への回答）

### 8.1 前提（**要再確認**：公開前に Supabase の料金・クォータページで最新値を確認すること）

| 項目 | Free | Pro |
| --- | --- | --- |
| 同時接続 | 200 | 500（超過は従量） |
| メッセージ数/月 | 200 万 | 500 万込み、超過 100 万あたり約 $2.5 |
| メッセージ/秒（プロジェクト全体） | 100 | 500 |
| Broadcast 1 件の大きさ | 256KB | 3MB |

数え方は保守的に「**1 回の送信 = 受信者数ぶん**」とする（送信者を数えない場合はこれより少し少ない）。

### 8.2 1 部屋あたりの見積もり（本設計の値）

| 場面 | 送信/秒（部屋全体） | 配信/秒（× 受信者数） | 1 時間あたり |
| --- | --- | --- | --- |
| 4 人・ロビーで放置 | hb 3/3s + 再送 0.4 = 1.4 | × 3 = 約 4 | 約 1.5 万 |
| 4 人・ラッシュ | hb・submit・状態 ≈ 2.2 | × 3 = 約 7 | 約 2.5 万 |
| 10 人・ラッシュ（定常） | ≈ 5.5 | × 9 = 約 50 | 約 18 万 |
| 10 人・ラッシュ（全員が同時に提出した瞬間） | 状態 5 + submit 9 | × 9 = 約 125（1〜2 秒間） | — |

- **配信間引き 100ms（10 件/秒）だと**、10 人部屋の瞬間値が状態だけで 10 × 9 = 90 件/秒となり、Free の 100 件/秒に 1 部屋で届く。**200ms（5 件/秒）に変更**して瞬間値を半分にした（ADR-5）。200ms の遅れは「済」マークの表示が少し遅れる程度で、各自のミニゲームはローカルなので体感に影響しない。
- 月間：Free（200 万）で 4 人ラッシュ約 80 時間/月。友達内の公開なら足りるが、一般公開で人が増えると不足する。**公開時は Pro を推奨**（500 万込み + 従量。10 人ラッシュ 100 時間 ≈ 1800 万 ≈ 超過 $33）。
- 状態 1 件はチャット満杯でも 46KB で、Free の 256KB に収まる。ただしチャットが長い部屋では帯域（46KB × 5 件/秒 × 受信者）が大きいので、次フェーズ候補として「チャットを状態から分離」を記録する（ADR-10）。
- クライアント設定 `eventsPerSecond: 20` は維持。ホストの送信は状態 5 件/秒 + α で十分下回る。

---

## 9. 並列実装のための担当境界（最重要）

### 9.1 ファイル所有表

**同じファイルを両者が編集しない。** 下表にないファイルを触る必要が出たら CTO に相談。

| 担当 | 所有するファイル（このフェーズで編集してよい） |
| --- | --- |
| **Backend** | `src/lib/**`（`transport.ts` `clock.ts` `identity.ts`）、`src/room/**`（`types.ts` `protocol.ts` `engine.ts` `logic.ts` `useRoom.ts`）、`src/games/**`（`micro/*` `rush/*` `registry.ts` `types.ts` を含む全部）、`src/__tests__/**`、`CLAUDE.md`、`package.json`（原則変更なし） |
| **Client** | `src/components/**`（`Room.tsx` `Home.tsx` `Chat.tsx` `Practice.tsx` `Layout.tsx` `ui.tsx`、新規コンポーネントもここ）、`src/App.tsx`、`src/main.tsx`、`src/styles.css`、`README.md`、`index.html`、`.env.example` |
| CTO / PdM | `docs/dev/**` |

- ユーザーの指示では「View は Client」だが、このフェーズの Must で View に必要な変更は**ミニゲームの数値の置き換えだけ**で、それは調整値（Backend）と一体なので、`src/games/**` は View も含めて Backend の所有とする。Client はゲームの View を触らない。
- 「観戦中」の共通表示（Should）を後で入れる場合も、場所は `Room.tsx` の `GameArea`（Client）で、`src/games/**` は触らない。

### 9.2 Backend の互換性ルール

- **Client が今 import しているシンボルは消さない・意味を変えない**。移動するなら元の場所から再エクスポートする。対象：`isOnlineMode`（transport）、`RoomState` `ChatMessage` `RoomAction` `MAX_ROOM_PLAYERS`（logic）、`useRoom` `RoomHandle`（useRoom）、`GAMES` `CATEGORIES` `gamesIn`（registry）、`CATEGORY_INFO` `resolveOptions`（types）、`LIVES` `nextMicroId` `speedForStage` `startMicroRound` `MICRO_META` `MicroResult` `MicroRound`（micro/core）、`VERDICT_MS`（MicroStage）、`MicroStage` `Hearts`（default export）。
- `RoomState` へのフィールド追加（`acks`）は Client に影響しない（Client は `acks` を読まない）。

### 9.3 契約：`src/room/types.ts`（全文。Backend はこのとおりに作り、変更には CTO の承認が要る）

```ts
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
```

`useRoom(code, me, name, create): RoomHandle` のシグネチャは現行どおり。`RoomHandle` は `useRoom.ts` からも再エクスポートする（Room.tsx の既存 import がそのまま通る）。

- **Phase 0 で調整**：契約の型は本節の全文どおりで変更なし。暫定 `useRoom`（B-02）は `connection` を常に `'connected'`、`retry` を `location.reload()` で返し、`'full'` / `'kicked'` はまだ返さない（ホストに外されたときは旧実装どおり `'left'`）。これらは B-15〜B-18 で engine に移すときに出すようになる。

### 9.4 契約：Client が使う純粋関数・定数

| 提供元（Backend） | シンボル | Client での用途 |
| --- | --- | --- |
| `src/room/logic.ts` | `chatBlockedUntil(state, me, now): number` / `CHAT_RATE` / `CHAT_MAX_LEN` / `MAX_ROOM_PLAYERS` | `Chat` の送信ボタンを `room.now() < chatBlockedUntil(...)` の間無効化。満員文言の人数 |
| `src/games/micro/tuning.ts` | `TUNING.solo.introMs` / `TUNING.lives.default` / `TUNING.stage.verdictMs` / `speedUpRuleText()` / `speedForStage` | `Practice.tsx` の直書き（`INTRO_MS = 2000`、`LIVES`、`VERDICT_MS`、「5ステージごとに」）の置き換え |
| `src/lib/transport.ts` | `isOnlineMode` | デモモード表示（現行どおり） |

### 9.5 Client の作業一覧（Must）

1. `Room.tsx`：`status` の分岐を §3.3 の表どおりに（`'error'` → `'failed'`、`full` 画面追加、`kicked` は最低限 `left` と同じ）。「再試行」は `location.reload()` ではなく `room.retry()`。
2. 「再接続中…」の帯：`status === 'ready' && connection !== 'connected'`。画面上部の細い帯、ゲーム画面は消さない。360px で崩れない。
3. `App.tsx`：`goRoom(code, true)` が現在と同じハッシュでも Room を作り直す（例：作成要求ごとに増える `createNonce` を持ち、Room の `key` を `${code}:${nonce}` にする）。AC-32。
4. `Chat.tsx`：`blockedUntil`（と `now`）を受け取り、送信ボタンを一時無効化。Room から渡す。
5. `Practice.tsx`：§9.4 の置き換え。
6. `README.md`：Vercel 手順（§11）、「しくみ」の数値更新（ホスト交代は「約 10 秒」で可、再接続中表示、満員）、AC-37 の確認コマンド。
7. トップのデモモード表示：**既に `Home.tsx` にある**（PdM 仕様の「ルーム画面にのみ」は事実誤認）。確認のみ。

### 9.6 進め方

1. **Phase 0（Backend、最初に単独で push）**：`src/room/types.ts`（§9.3 全文）、`ConnectionStatus` 型を `transport.ts` に追加、`useRoom` を新しい `RoomHandle` の形で返す暫定版（中身は旧実装のまま。`connection: 'connected'` 固定、`retry` は `location.reload()`、`'error'` → `'failed'`）、`chatBlockedUntil` / `CHAT_RATE`、`tuning.ts` の `TUNING` と `speedUpRuleText`。`typecheck` / `test` / `build` が通る状態にする。
2. **Phase 1（並列）**：Backend は engine・protocol・transport・テスト・調整値の移行。Client は §9.5。互いのファイルは触らないので、どちらが先に終わってもビルドは通る。
3. **Phase 2（結合）**：Client の手動確認（デモモードで 2 タブ、AC-39）。帯の確認はブラウザの開発者ツールでオフラインにして行う。

---

## 10. 判断の記録（ADR）

| # | 決定 | 理由 / 代替案 |
| --- | --- | --- |
| ADR-1 | 同期処理を React 非依存の `RoomEngine` クラスに移し、Transport・Clock・Storage・games を注入する（PdM 8 章「同期処理の分け方」への回答） | 疑似ネットワーク上で複数端末を 1 プロセスで動かすため。純粋関数＋reducer への全面分解も検討したが、タイマー・購読・再送が絡み、移行コストが高い。純粋にできる部分（検証・acks・レート判定）だけ `protocol.ts` / `logic.ts` に出す |
| ADR-2 | 通信層を Link（1 回分の接続）と ManagedTransport（状態機械）に分ける | リトライ・再接続のロジックを本番と同じコードのままテストできる。Supabase 固有部分は 50 行程度に閉じる |
| ADR-3 | 処理済み seq を `RoomState.acks` に持つ（PdM 8 章への回答：賛成）。ACK 専用メッセージは作らない | ホスト交代で自動的に引き継がれる。サイズは最大 10 件で約 0.3KB。状態は全員に配られるので ACK のための追加送信がゼロ |
| ADR-4 | 送信済みアクションは確認後も 10 秒間保持し、「採用中の状態の acks より大きいもの」を再送する | 二重ホストで負けた側が処理した操作を、勝った側へ自動で届け直せる（PdM F6 の要件）。保持件数は最大 50 |
| ADR-5 | 状態配信の間引きを **100ms → 200ms** に変更 | §8 の見積もりで、10 人部屋の瞬間値が 100ms だと Free のメッセージ/秒上限に 1 部屋で届くため。AC-18（10 件/秒以下）は満たす。体感への影響は小さい |
| ADR-6 | `connected` 以外では送信しない（realtime-js の REST 自動フォールバックを使わない） | 送信失敗を検知できない経路を残さず、確実性を seq 再送 + 同期要求に一本化する。REST 送信がレート上限を食うのも避ける |
| ADR-7 | 引き継ぎは `connected` のときだけ。自分しかオンラインにいない場合は 30 秒待つ（`bye` を受けていれば即時）。復帰直後 9 秒は引き継がない | 孤立した端末やスリープ明けの端末が新しい世代を作って、生きている部屋を巻き戻す事故（E-02）を防ぐ。代償：2 人部屋でホストの電池が突然切れると、残った 1 人がホストになるまで 30 秒かかる（`bye` が届けば 0.5 秒） |
| ADR-8 | 満員は専用メッセージを作らず状態から判定。ホストからの `sync` は「ホストがリロードした」とみなして交代を始める | メッセージ種別を増やさない。ホストは `sync` を送らない設計なので誤判定しない |
| ADR-9 | DOM テスト環境（jsdom / Testing Library）は入れない。UI の AC は手動、AC-23 は engine レベルで検証 | 依存追加なしで済ませる。UI の変更は Client の手動確認で十分な規模 |
| ADR-10 | `CHAT_KEEP = 60` は据え置き。チャットの状態からの分離は次フェーズ候補 | 実測 45.7KB で 64KB 以内。分離はメッセージ種別・同期方式の追加になり MVP には重い |
| ADR-11 | Should のうち 2 点だけ先に入れる：`RoomStatus` に `'kicked'`、`MicroTuning` に `enabled` | どちらも engine / 調整値の形に関わり、後から足すと契約が変わる。コストはほぼゼロ（kicked は現行の left 判定の分岐、enabled は出題の絞り込み 1 行）。UI の出し分けや OGP・エラー境界・コード衝突確認は入れない |
| ADR-12 | プロトコルに `v: 2` を付け、違う版は捨てる | デプロイ直後、キャッシュの古いタブと新しいタブが同じ部屋に入っても互いに壊さない（古い側には「見つかりません」と出る） |
| ADR-13 | 需要の計測は **Umami Cloud（無料の Hobby）に、自前の小さな送信関数から直接送る**（Umami の読み込みスクリプトは使わない）。北極星は端末の中で判定し、部屋コードも使い捨ての部屋 ID も送らない。ゲーム ID は登録の一覧のものだけ、参照元は許可一覧の名前だけ、本番のホスト名のときだけ送る（Security 05 §8 の M-1〜M-3）（§14） | Cloudflare Web Analytics はハッシュ URL と独自イベントに対応しないため北極星が測れない。自前（Pages Functions など）は集計画面まで作る必要があり、PMF 前には重い。スクリプトを読み込まないので、何を送るかをこちらで全部決められ、外部のコードも動かさない |

### PdM 仕様から変えた点（まとめ）

| 項目 | PdM 仕様 | 本設計 | 理由 |
| --- | --- | --- | --- |
| 状態配信の間引き | 100ms（10 件/秒） | 200ms（5 件/秒） | ADR-5 |
| ホストの定期再送 | 5 秒 | 2.5 秒（ホストは hb を送らない） | 二重ホストを 3 秒以内に収束させるため。送信数は現行（hb 2.5 秒 + 再送 5 秒）より減る |
| 参加者の hb | 2.5 秒 | 3 秒（他の送信があれば省略） | メッセージ数の節約 |
| ひとりだけ残ったときの引き継ぎ | 9 秒 | 30 秒（`bye` があれば即時） | ADR-7 |
| リロード時の復元 | 3.5 秒 | 3 秒、かつ誰の声も聞こえないときだけ | 生きている部屋を巻き戻さないため |
| 初回接続のタイムアウト | 指定なし（ライブラリ既定 10 秒） | 1 回 5 秒 | `failed` まで最悪 47 秒 → 27 秒 |
| 満員の通知 | 「満員」を返す or 状態から判定 | 状態から判定（専用メッセージなし） | ADR-8 |
| AC-23 の検証方法 | 自動 | engine レベルの自動 + レビュー | ADR-9 |
| F10 トップのデモ表示 | 未実装とされている | 実装済み（`Home.tsx`）。確認のみ | 事実確認 |
| AC-37 サブパス | 要対応 | 対応済み（ビルドで確認）。手順を README に載せるだけ | 事実確認 |

---

## 11. デプロイ

- **Vercel**：リポジトリを連携 → Framework Preset「Vite」、Build Command `npm run build`、Output Directory `dist`、環境変数 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`（Production と Preview の両方）。ハッシュルーティングなので `vercel.json`（リライト）は不要。ルート公開なので `VITE_BASE` は設定しない。
- **環境変数はビルド時に埋め込まれる**（Vite の仕様）。値を変えたら再デプロイが必要、と README に書く。入れ忘れるとトップに「デモモード」帯が出る（既存）。
- **サブパス（GitHub Pages 等）**：`VITE_BASE=/yubisuma/`。`vite.config.ts` は対応済みで、`index.html` の `/favicon.png` も Vite が `/yubisuma/favicon.png` に書き換えることを確認済み。
- **Supabase 側**：Realtime の「Private channels only」は無効（公開チャンネルを使うため）。テーブル・SQL は不要。クライアントに含めるのは anon キーのみ。
- 確認：`npm run build && npm run preview` でデモモード 2 タブ（AC-39）。

---

## 12. リスク

| リスク | 影響 | 対策・残る課題 |
| --- | --- | --- |
| 実機の Supabase 挙動が疑似ネットワークと違う（再参加の通知順、REST フォールバック、レート制限時の切断） | 実機でだけ再接続が戻らない等 | Link を 50 行程度に閉じ、`REBUILD_AFTER_MS` で作り直す保険。AC-M1〜M5 を公開前に必ず実施 |
| 複数端末が同時に孤立して、それぞれ世代を進める | 復帰時にどちらかの進行が巻き戻る | ADR-7 で大半を防ぐ。完全な防止にはサーバーか合意が要るため対象外（友達同士の前提） |
| ラッシュでオフラインの参加者を毎回待つ（E-21） | テンポ低下 | PdM 仕様どおり対象外。次フェーズ |
| メッセージ数が Free を超える | 月の途中で使えなくなる | §8。公開時は Pro 推奨。利用状況を Supabase ダッシュボードで見る |
| 大きいチャット履歴で状態が重い | モバイル回線の帯域 | ADR-10（次フェーズで分離） |
| `game.state` の中身は検証しない | 悪意ある「ホスト」が View を壊せる | 友達同士の前提で許容。View のエラー境界は Should（MVP-15） |

---

## 13. Phase 1 で変更・確定した点（Backend、B-10〜B-21）

契約（§9.3 の `src/room/types.ts`）と §9.2 の export は変えていない。以下は設計の意図を保ったまま実装で決めた・調整した点。

| # | 対象 | 内容 | 理由 |
| --- | --- | --- | --- |
| P1-1 | `supabaseLinkFactory`（§3.1） | **Phase 1 で変更**：Link ごとに `RealtimeClient`（WebSocket）を 1 つ作り、`close()` は `removeChannel` の後に `disconnect`。共有の `createClient` は使わない（`@supabase/supabase-js` が再エクスポートする `RealtimeClient` を使うので依存は増えない） | realtime-js 2.117.3 の `channel()` は同じ topic のチャンネルがあるとそれを返す。`removeChannel` は非同期なので、共有クライアントだと作り直し直後に古い（閉じかけの）チャンネルが返り、作り直しにならない。さらに古いチャンネルが閉じたときの `_remove` が topic 一致で新しいチャンネルまで一覧から消す。作り直しはソケットが死んでいる疑いがあるときなので、ソケットごと新しくする方が確実 |
| P1-2 | `Transport`（§1.3） | 旧 `Transport`（`ready: Promise`）は §1.3 の形に置き換えた。Client は `Transport` を import していないので影響なし | 設計どおり |
| P1-3 | `EngineDeps` | **Phase 1 で追加（後方互換）**：任意項目 `defaultGame?: string`（部屋を作るときに選ばれているゲーム。省略時は `games` の先頭）。`useRoom` は `DEFAULT_GAME` を渡す | engine を registry から独立させ、テストで別のゲーム一覧を注入できるようにするため |
| P1-4 | ホスト喪失の判定（§5.3） | `bye` を受けた人と「ホストからの `sync`」を `departed` に入れ、ホスト喪失を即時判定する。`departed` はその人から `state`・`action`・`hb`（状態を持つ端末だけが送るもの）を受けたら外す（`bye` の後に bfcache から戻った人が配信・操作・生存通知を再開した場合など。`action`・`hb` は R-02 で追加）。`sync` / `join` など、それ以外の受信による `lastSeen` の更新では外さない | リロードしたホストの新しい engine は sync / join を送り続けるので、`lastSeen` だけで判定すると「ホストは生きている」と見えて誰も引き継がず、全員が止まる |
| P1-5 | 無通信検知（§3.2） | 条件に「`lastSeen` に誰かいる（全員が `bye` で去ったのではない）」を加えた | 全員が明示的に去った部屋で張り直しをしない |
| P1-6 | 状態の採用（§5.2） | 採用した状態の `hostId` が自分で、直前まで自分がホストでなかった場合（旧ホストの退出で譲られた）、outbox の未確認分を適用してから配信する | 引き継ぎ時（§5.3）と同じく、送り先を失った操作を失わないため。配信で他の人の `departed` も外れる |
| P1-7 | `status`（§3.3） | 状態を持っていれば、自分がまだ `players` にいなくても（join の処理待ち）`ready` を返す（旧実装と同じ）。`full` / `kicked` / `left` になった engine は以後送信しない（`full` は受信だけ続ける） | 旧実装の画面遷移を変えないため |
| P1-8 | `retry()` | `notfound`（接続済み）からも `transport.reconnect()` で張り直し、`notfound` を解除して `connecting` に戻す | ページを読み直さずに「接続 → sync / join → 8 秒待ち」をやり直せるように |
| P1-9 | 欠落 20% の観察（AC-17） | 欠落 20% では、ホストの定期配信（2.5 秒）が 4 回続けて落ちて参加者が誤って引き継ぐことがある（30 シード中 1 シードで発生）。その場合も状態は収束し、ライフ・クリア数は全員一致し、ミス扱いは起きない。テストは「全員のホストが 1 人に一致」までを見る | 設計どおりの値（`OFFLINE_AFTER_MS` 9 秒・`HOST_RESYNC_MS` 2.5 秒）の範囲の挙動。実機で頻発するようなら、ホストの定期配信の間隔を短くするか、喪失判定を「他の参加者からも聞こえない」ことに広げるのが次の候補 |
| P1-10 | 疑似ネットワーク（§6.1） | 送信側と受信側の条件のうち厳しい方（遅延・ゆらぎ・欠落率それぞれの最大）を使う。乱数は 1 通につき受信者ごとに 2 つ必ず引く。ネットワーク落ち（`disconnect`）中の接続試行は応答しない（`restore` で開く）。`clearDrops()` / `setAll()` を追加。`createSimRoom` に `skews` / `games` / `joinAll`、戻り値に `addPeer` / `converged` / `sent` を追加 | 全員に同じ条件を入れたとき、その値どおりになるように。条件を変えても後続の乱数列がずれないように |
| P1-11 | テストの決定性 | `sync.test.ts` はゲーム側の `Math.random`（ラッシュの出題・seed）もシード付き乱数に差し替える（`vi.spyOn`。時計の偽装ではない） | 出題でステージの長さが変わると、通信の回数＝疑似ネットワークの乱数の消費が変わり、結果が実行ごとに変わるため |
| P1-12 | 調整値（§7.1） | `params` のキーを確定：`whack.lifeDivisor`（6）と `timing.visibleMs`（1000）を追加。`timing` の指示文「3秒ぴったり！」は `targetMs` から作る。`nextMicroId(prev, t = TUNING)` に調整値の引数を追加（既存の呼び方はそのまま）。`startMicroRound` の `introMs` の既定値は `TUNING.rush.introMs`（2400。旧 2500 は製品コードからは使われていなかった）。`validateTuning` は §7.3 に加えて `params` の `…Ms` が正・`…Ratio` が 0〜1・`speed.everyStages` が 1 以上の整数・`speed.max` が 1 以上も見る | AC-41 の「同じ意味の数値の直書きを残さない」。当たり判定（よけろの距離 6/7 など）や配置・大きさの係数は見た目・操作感の値として各ファイルに残した |

### 13.1 Phase 2 の不具合票対応（Backend：SEC-01〜06、QA-BUG-01・02・04・07）

タイマー値（`ROOM_TIMINGS`）は**変えていない**。契約（`src/room/types.ts`）も変えていない。追加した上限値と挙動の変更は次のとおり。

| # | 票 | 対象 | 内容 | 理由 |
| --- | --- | --- | --- | --- |
| P2-1 | SEC-01 | `logic.ts` `isImplausibleJump`・`engine.ts` `onState` | 今の状態から `epoch` が `EPOCH_JUMP_MAX`（1000）、`version` が `VERSION_JUMP_MAX`（100 万）を超えて飛んだ状態は採用しない（世代に関係なく両方見る）。自分がホストなら捨てたうえで配り直す | 巨大値の偽の状態 1 通で、以後の正しい状態が古い扱い／+1 が安全な整数を超えて捨てられ、部屋が戻らなくなるのを防ぐ。版は 5 件/秒で 1 日 ≒ 43 万なので長時間離れた参加者も追いつける |
| P2-2 | SEC-02 | `logic.ts` `acceptAction`（`SEQ_JUMP_MAX` = 1000） | 処理済み seq + 1000 を超える seq は受け付けない | 他人の ID で巨大な seq を送り、その人を締め出すのを防ぐ。正規の再送は最大 `OUTBOX_MAX`（50）件 |
| P2-3 | SEC-03 | `protocol.ts` `isId` | プレイヤー ID は `[A-Za-z0-9_-]` の 1〜40 文字で、`Object.prototype` にある名前（`__proto__` / `constructor` など）でないこと | 各ゲームが ID をオブジェクトのキーに使うため。正規の ID は `p_` + 英数字 |
| P2-4 | SEC-04 | `logic.ts` `hasKnownGames`・`engine.ts` `onState` / `loadSnapshot` | `selectedGame` と `game.id` が登録（`games` の自分のプロパティ）にない状態は採用・復元しない | 未知のゲーム ID で全員の画面が真っ白になるのを防ぐ。版ずれでは古いタブがその状態を受け付けなくなる（表示側の防御は Client） |
| P2-5 | SEC-05 | `protocol.ts` `parseRoomState`（`MAX_GAME_STATE_DEPTH` = 64）・`engine.ts` `saveNow` | `game.state` の入れ子が 64 段を超える状態は捨てる（再帰なしで数える）。スナップショットの `JSON.stringify` も try の中で行う | `JSON.stringify` の `RangeError` が受信処理の外へ漏れるのを防ぐ |
| P2-6 | SEC-06 | `engine.ts` `pruneTables`（tick ごと） | メンバーでも現在のホストでもない ID の `lastSeen`（`OFFLINE_AFTER_MS` 経過後）・`departed`、窓を過ぎた `rate`・`syncReplyAt` を消す。メンバーの `lastSeen` は残す（P1-5 を変えない） | 毎回違う from の flood で表が際限なく増えないように |
| P2-7 | QA-BUG-01 | `engine.ts` `checkTakeover` | 接続・復帰から `OFFLINE_AFTER_MS` の猶予は、ホストが `departed`（bye・ホストからの sync）のときは飛ばす | 猶予は古い `lastSeen` での誤判定を防ぐためのもので、明示的な離脱には不要。交代・ホストのリロード復帰が約 8 秒かかっていた |
| P2-8 | QA-BUG-02 | `engine.ts` `tickWaiting` / `resume` / `onSync` | §5.1 の復元条件を「状態を持つ端末（state・action・hb の送り手）から受信していない」に変更。状態待ちの端末は hb を送らない。状態を持つ参加者は sync を受けたら（直前 1 秒に何も送っていなければ）hb を返す | 2 人同時リロードで、互いの sync・join を聞いた両方が復元せず部屋が消えていた。両方が復元しても同じ世代の競合として収束する |
| P2-9 | QA-BUG-04 | `engine.ts` `onState` | 自分のいない状態を受けて `kicked` にするのは、同じ世代・同じホストのときだけ。ホストか世代が変わっていれば join し直す | 旧ホストだけが受け付けた参加者が、交代後に「外されました」になっていた。交代と kick が重なった場合は入り直せてしまうが、kick はやり直せる |

- ~~既知の残り（票外・既存の挙動）~~ → P2-10 で修正：ホストが bye なしで消え（freeze・電池切れ）、次のホスト候補がその直後にリロードすると、候補は状態待ち（sync・join を送り続ける）なのでオンラインに見え、他の参加者は候補に譲って引き継がず、候補は状態を持つ参加者の声が聞こえるので復元もしない。修正前（`heardOther`）も同じ。

| # | 票 | 対象 | 内容 | 理由 |
| --- | --- | --- | --- | --- |
| P2-10 | 票外（上記） | `engine.ts` `handleRaw` / `checkTakeover` / `pruneTables` | 最後に `join` を送ってきた端末を `joining` に入れ（`state`・`action`・`hb`・`bye` を受けたら外す）、`checkTakeover` の `pickNextHost` に渡すオンライン集合から除く。`othersOnline`（ADR-7 の 30 秒待ちを飛ばす条件）には数えたまま。メンバー以外の行は tick ごとに消す | `join` を送るのは状態待ちの端末か、受けた状態に自分がいない端末で、どちらも自分では引き継がない（`checkTakeover` は自分がメンバーの状態を持つときだけ動く）。`sync` は状態を持つ参加者も接続・復帰時に送るので印にしない。他人の ID を騙った `join` でその人を候補から外せるが、hb 等の偽装と同程度で、次の候補が引き継ぐだけ |
| P2-10 | 同上 | `engine.ts` `tickWaiting` | 状態を持つ端末の声を聞いている状態待ちの端末は、「見つかりません」までを `JOIN_TIMEOUT_MS + OFFLINE_AFTER_MS`（17 秒）に延ばす（聞いていなければ従来どおり 8 秒。AC-10 は不変） | 部屋は生きていて、bye なしのホスト喪失なら引き継ぎ（喪失判定 9 秒 + tick）の後に状態が届く。8 秒のままだと交代の直前に一瞬 notfound が出る。タイマー値（`ROOM_TIMINGS`）自体は変えていない |

- テスト：`qa-exceptions.test.ts`「ホストが bye なしで消えた直後に次のホスト候補がリロードしても…」「…候補 2 人が続けてリロードしても…」（修正前は両方失敗）。

| # | 票 | 対象 | 内容 | 理由 |
| --- | --- | --- | --- | --- |
| P2-11 | QA-BUG-07 | `engine.ts` `checkTakeover` | 接続・復帰から `OFFLINE_AFTER_MS` の猶予中に bye 等でホスト喪失を知ったときは、`pickNextHost` に渡す候補を `this.online` ではなく「`departed` にいないメンバー全員」（`joining` は従来どおり除く）とする。猶予を過ぎた端末は従来どおり `this.online`。タイマー値（`ROOM_TIMINGS`）は変えていない | P2-7 で猶予を飛ばした結果、猶予中の端末は `lastSeen` が空か古く、オンラインが自分だけに見えて参加順の先の人を飛ばして名乗っていた（スリープ明けなら古い状態で名乗り、`hostId` の大小で勝つと進行が巻き戻る）。猶予中は「聞こえない＝いない」と言えないので、先の人に譲る。その人が bye なしで消えていれば、猶予を過ぎた端末が実際の `lastSeen` で判定して引き継ぐ（全員が猶予中なら猶予明けに従来どおり判定＝P2-7 以前と同じ約 9 秒）。QA-BUG-01 の即時交代は、次の候補自身が猶予中でも自分を選ぶので保たれる |

- テスト：`qa-final.test.ts`「QA-BUG-07: …」2 件（skip を外して通過）、「QA-BUG-07 の修正後も、参加順で先の人が bye なしで消えていれば…」。
- 既知の残り：スリープ明けで状態が古い端末が**参加順でちょうど次の候補**のときに bye が届くと、他の端末はその端末に譲り、その端末は古い状態で引き継ぐ（巻き戻りうる）。「状態が古い」ことを他の端末へ伝える手段がプロトコルにないため。次フェーズで、引き継ぎ直後に参加者の持つ版を突き合わせる・sync 応答で鮮度を知らせるなどを CTO と検討する。

### 最終レビュー（09）対応

| # | 票 | 対象 | 内容 | 理由 |
| --- | --- | --- | --- | --- |
| P2-12 | R-01 | `transport.ts` `nudge`・`engine.ts` `resume` | `resume()` の張り直しを `reconnect()` から `nudge()` に変更（§3.1） | `online` 1 回で Link を 2 本作り、1 本目をすぐ捨てていた。初回接続中の `resume()` でリトライ回数も 0 に戻っていた |
| P2-13 | R-02 | `engine.ts` `handleRaw` | `departed` を `state` だけでなく `action`・`hb` の受信でも外す（P1-4） | bye のあと戻ったメンバーが他の端末の `departed` に残り、猶予中の引き継ぎ候補から外れて QA-BUG-07 と同じ「先の人を飛ばす」が起きていた |

- テスト：`review-fixes.test.ts`「R-01: …」「R-02: …」。

### 13.2 最小計測の実装（Backend：M-B1〜M-B5。設計は §14）

| 点 | 決めたこと | 理由 |
| --- | --- | --- |
| 置き場所 | `src/lib/metrics.ts`（純粋関数）・`src/lib/metricsStore.ts`（端末の中の日付・入口の印・部屋の記録のキー）・`src/lib/analytics.ts`（送信・送らない条件・Client 用の入口）・`src/room/roomMetrics.ts`（部屋の配線。React なし）・`src/room/useRoomMetrics.ts`（フック）・`src/games/ids.ts`（ゲーム ID の一覧） | フックの中身を React なしで疑似ネットワークに流して確かめるため。`ids.ts` は registry（View を読み込む）を計測から読まないため。registry と一致することはテストで確かめる |
| `RoomTally` | §14.6 の型に `joined`（この部屋で `room_join` を送ったか）を足した。`createdAt` は「この端末が作って `room_create` を送った時刻」で、送ったかどうかの印を兼ねる | リロードで `room_create`・`room_join` を数え直さないため（sessionStorage に記録ごと置く） |
| `AnalyticsDeps` | `version`（`data.v`）を足した。`v` は `package.json` を `import { version }` で読む（`vite.config.ts` の `define` は不要） | 設計どおり全イベントに `v` と `mode: 'online'` を付ける。ページ表示には付けない（Umami の pageview は data を持たない） |
| 二段目の検査 | イベント名ごとに許可するキーと値の形を表で持ち、外れたら送らない。`url` は `/`・`/practice`・`/r` と `?s=<許可した値>` だけ、`referrer` は固定の URL か空だけ | `metrics.ts` に不具合があっても外に出ないため（R-4） |
| 送り方 | `fetch` に `credentials: 'omit'`・`referrerPolicy: 'no-referrer'` を足した | Cookie を付けない。`?s=` が消える前の数百ミリ秒にページの URL を Referer で送らない【要確認：Umami が Referer なしの受信を受け付けるか。§14.10 の 2 と一緒に本番で 1 回確かめる】 |
| 送らない設定 | `setMetricsOptOut(off)` は保存できたかを真偽で返す。このタブで選んだ値は保存の失敗・読み取りの例外より優先する | Client が「この端末では設定を保存できません」を出すため（R-2）。選んでいないときに読むと例外なら送らない側 |
| 1 時間 60 件 | タブの中の変数で数える（リロードで 0 に戻る） | 目的は不具合による無限送信の止め。偽の状態への備えは部屋ごとの上限（`game_start` 30 件・`room_enjoyed` 1 回）を sessionStorage で持つ |
| `room_error` | 同じフック（同じ画面）の中で種類ごとに 1 回 | 再試行で何度出ても数えない |
| 環境変数 | `import.meta.env.VITE_UMAMI_WEBSITE_ID`・`VITE_UMAMI_HOST`・`DEV`・`MODE` を名前で読む。`vite-env.d.ts` は足していない（`vite/client` の型で通る。`transport.ts` と同じ書き方） | `security-static.test.ts` の「読む環境変数の一覧」を 4 つ足して更新した |

- テスト：`metrics.test.ts`（M-B1 ①〜⑨）、`analytics.test.ts`（M-B2 ①〜⑧、④ は疑似ネットワークの 4 人の部屋で 5 ゲーム・ホスト交代・再接続・リロード、M-B3 の配線）。

### 13.3 録画モード（Backend 側。SNS の自動録画。marketing/sns/plan.md §2.1・10 §2.3）

| 点 | 決めたこと | 理由 |
| --- | --- | --- |
| 乱数の入口 | ゲームの乱数（`shuffle`・`pick`・ミニゲームの選択と seed・反射神経の待ち時間）は `src/games/random.ts` の `random()` を通す。既定は呼ぶたびに `Math.random` を読む | 録画のときだけシード付き（mulberry32）に差し替えるため。既存テストの `vi.spyOn(Math, 'random')` もそのまま効く |
| URL | `?rec=1&seed=<0〜4294967295>&topic=<語>&topic=<語>&micro=<id>,<id>&name=<名前>`（ハッシュの前）。`src/lib/recording.ts` の `parseRecording`・`startRecordingMode` | `topic` は複数可（区切り文字と衝突しない）。ワードウルフは 1 つ目がお題データの語と一致すれば市民側、多数派は問題文が一致したものを先頭から順に。`micro` は有効な ID だけ、ステージ順に繰り返す |
| 本番では無効 | `online`（Supabase 設定あり）なら `parseRecording` も `applyRecording` も無効 | ホストが URL で展開を仕組めないようにする（二重の止め） |
| 計測 | `MetricsEnv.recording`（省略可）を足し、`metricsAllowed` は `isRecordingMode` を渡す | 自動操作の録画を利用として数えない（デモモードはもともと送らないが、条件として明示） |
| 印 | `Src` に `yt-bio`・`yt-long` を足した（`SRC_ALLOWED`・二段目の検査・`url` の形も） | YouTube のプロフィールのリンク・まとめ動画の概要欄（plan.md §7.1） |

- テスト：`recording.test.ts`。

---

## 14. 需要を測る最小限の計測（J-23。D-11・D-12・D-41）

- 作成：CTO（2026-11-21）。**状態：設計。Security の設計レビュー（1 回目。`docs/dev/05-security-report.md` §8）の必須 M-1〜M-5 を反映済み（2026-11-21）。§14.11 の受け入れるリスクを PO が了承したら実装に入る**
- Security の指摘の反映先：M-1 → §14.3 #5・#6・§14.6 `observeRoom`・M-B1／M-2 → §14.3 #1・§14.6 `referrerName`／M-3 → §14.5 送らない条件・M-B4・M-C8・11 §2-4／M-4・M-5 → §14.5 説明文と置き場所・M-C7。推奨 R-1〜R-10 の取り込みは §14.7 の末尾の表
- 入力：`docs/NORTH_STAR.md`、`docs/DECISIONS.md`（D-11・D-12・D-25・D-41・D-45〜D-49）、`docs/dev/08-pmf-strategy.md` §1・§2、`docs/strategy/market-review/05-strategy-manager-final.md` §3.1、`docs/dev/11-launch-guide.md`、`docs/research/cloudflare-checklist.md` §5
- 外部の情報は**検索結果の要約で確かめた**（umami.is・docs.umami.is はこの環境から本文を開けない）。数字・仕様には【確認済み（検索）】【要確認】を付けた。要確認は §14.10 にまとめた
- 08 §2.3 のイベント案から**数を絞り、`rid`（使い捨ての部屋 ID）をやめた**。理由は §14.3 の冒頭

### 14.1 結論

1. **道具：Umami Cloud の無料プラン（Hobby）**。Umami の読み込みスクリプトは入れず、Backend が書く 100 行ほどの送信関数から Umami の受け口（`/api/send`）へ直接送る。
2. **北極星は端末の中で判定する**：ホストの端末が「この部屋で始まったゲーム数」と「参加人数の最大」を手元で数え、条件（2 ゲーム以上・3 人以上）を初めて満たしたゲーム開始の瞬間に `room_enjoyed` を 1 回だけ送る。週の件数＝週の「楽しまれたルーム」。部屋コードも部屋ごとの ID も送らない。
3. **今入れる：V-1（人数）・V-2（`?s=stream` の印）。V-3 は送り方だけ今決め、ページは 2027 年 1 月**（Client・Marketing。05 §3.1 の期限どおり）。
4. **PO の手間**：最初に 15 分（Umami の登録と、Cloudflare に値を 1 つ入れる）。その後は週 2 分の確認（§14.7。AI に任せる案は PO 判断）。

### 14.2 道具の比較

| 観点 | **Umami Cloud（Hobby）** | Cloudflare Web Analytics | 自前（Cloudflare Pages Functions ＋保存先） |
| --- | --- | --- | --- |
| 費用 | 無料。月 10 万イベント・サイト 1 つ・保存 6 か月【確認済み（検索）。公式ページの本文は要確認】。超えたら Pro 月 20 ドル（約 3,000 円。100 万イベント）で予算の内 | 無料 | 無料枠の範囲なら 0 円の見込み【要確認】 |
| Cookie・同意表示 | Cookie を使わない（公式の説明）【確認済み（検索）】。同意の表示は出さず、説明のページと「送らない」設定を置く（§14.5） | Cookie を使わないとされる【要確認】 | 作り方しだい（Cookie なしで作れる） |
| 独自イベント（部屋作成・ゲーム開始） | 送れる。名前 50 文字まで、項目 50 個まで、文字列 500 文字まで【確認済み（検索）】 | **送れない**（ページ表示だけ）【公式の記述は見つからず、二次情報。要確認】 | 何でも送れる |
| ハッシュ URL（`#/r/XXXX`） | こちらが送る URL を決めるので問題なし（`/r` だけ送る） | **ハッシュの画面遷移に対応しない**（公式の SPA の説明）【確認済み（検索）】→ 部屋・ひとり用の区別すら取れない | 問題なし |
| 部屋コードを送らない | 送る中身を全部こちらで組み立てるので、確実に送らない | ハッシュは送られないので送らない | 確実に送らない |
| PO の手間 | 登録 10 分＋値を 1 つ入れる 5 分。週の確認は画面で 1 つの数字を見るだけ | Pages の画面でオンにするだけ（5 分）。ただし北極星が出ないので意味が薄い | 保存先の作成・つなぎ込みに PO の操作が要る。集計の画面も作る必要があり、AI の作業も大きい（3〜5 人日の見込み） |
| 方針との相性 | 「サーバーを持たない」を保てる | 同左 | サーバー処理を持つことになる（今は使わない方針。cloudflare-checklist 冒頭） |
| 弱点 | 広告ブロッカーで Umami の送り先が止められることがある【要確認】→ 数は**下限**として読む。外部の会社にデータを預ける | 北極星・V-1・V-2 が測れない | 作って直す手間。PMF 前にやることではない |

**推奨：Umami Cloud（Hobby）**。北極星・V-1・V-2 を測れるのはこれと自前だけで、自前は手間が大きい。

- **読み込みスクリプトを使わない理由**：① 外部の JavaScript をページで動かさない（中身が変わってもこちらは気づけない）② Umami のスクリプトは URL・ハッシュ・参照元をそのまま送るので、部屋コードが混じる余地を残したくない ③ 送る項目を表（§14.3）のとおりに固定でき、テストで確かめられる。
- **Cloudflare Web Analytics は入れない**（二重に計測しても、PO が見る画面が増えるだけ）。Pages の画面に「Web Analytics を有効にする」の案内が出ても押さない。
- **移る条件**：月 7 万イベント（上限の 70%）を超えたら、Pro（月 20 ドル）か自前に移るかを決める（それ自体が良い兆候）。広告ブロッカーでの欠けが大きいと分かったら、同じ場所（自分のドメイン）から送れるよう Pages Functions で中継する案を CTO が出す。**偽のイベントが続いたら**（週の確認で `room_enjoyed > room_create`、1 時間に数十件の急な山、本番以外の hostname や来訪のない国からの件数、が 2 週続く。Supabase の接続数・メッセージ数と合わない。05 §8.3 R-09）も、Pages Functions で中継し、Origin の確認と件数の上限を付ける案を CTO が出す（Website ID を公開しなくて済む）。

### 14.3 送るイベントと項目

**`rid` をやめた理由**：08 §2.1 の `rid` は部屋ごとに付く ID で、同じ部屋のイベントをつなげられる（Umami の画面ではつなげて見られず、手間の割に使えない）。端末の中で数えて「条件を満たした瞬間」に送れば、ID なしで北極星・L1・L10 が出せる。送る ID が 1 つもない方が、Security の確認も説明文も短くなる。

**共通**：すべてのイベントに `mode`（`online` だけ送る。デモモードでは何も送らない）と `v`（アプリの版。`package.json` の version をビルド時に埋める）を付ける。端末の種類（スマホ・PC）は Umami が画面の大きさと UA から自動で分けるので、`dev` は送らない。

| # | 名前 | 送る端末・時点 | 項目（値） | 使う指標 |
| --- | --- | --- | --- | --- |
| 1 | （ページ表示） | 全員：画面が変わったとき（`home` / `practice` / `room`）。Umami の pageview として送る | `url`：`/`・`/practice`・`/r` のどれか（**コードは付けない**）。印があれば `?s=stream` などを付ける（許可した値だけ）。`referrer`：ページを開いた最初の 1 回だけ、参照元が**許可一覧（下の表）に当たればその名前**、当たらなければ `other`、空・自分のサイトなら空（**オリジンは送らない**。`https://taro-yamada.github.io` のようにオリジン自体が人や勤め先を指すため。M-2）。`#/privacy` ではページ表示を送らない（R-9） | 流入・V-3 |
| 2 | `room_create` | ホスト：「部屋を作る」で作った部屋が初めて `ready` になったとき | `src`：`stream` / `x` / `tiktok` / `guide` / `none`（`?s=` の印。許可した値以外は `other`）。`rehost`：`7d` / `28d` / `no`（この端末で前にホストした日から）。`was_guest`：真偽（この端末で前にゲスト参加したことがあるか）。`after_practice`：真偽（7 日以内にこの端末でひとり用を遊んだか） | P2・P3・L4・L5・**V-2** |
| 3 | `invite_share` | ホスト：招待の共有・コピーが成功したとき、QR を開いたとき | `method`：`share` / `copy` / `qr`。`n`：その時点の人数（1〜10 の整数。外れたら送らない） | L3・対面の導線（D-25・J-27） |
| 4 | `room_join` | ゲスト：部屋の状態を初めて受け取り、自分がメンバーに入ったとき（同じタブで同じ部屋なら 1 回だけ。リロードで数え直さない） | `via`：`qr`（QR の URL の印）/ `code`（トップでコードを入れた）/ `link`（それ以外） | L2 の代わり・対面の導線 |
| 5 | `game_start` | ホスト：自分がホストのときに、新しいゲームが始まったのを状態で見たとき（`state.game.startedAt` が変わった） | `game`：ゲーム ID（**`src/games/registry.ts` の ID の一覧にあるものだけ**。ない状態は数えも送りもしない。M-1）。`n`：ゲームの参加人数（**1〜10 の整数だけ**。外れた状態は数えも送りもしない。区分けは集計で行う）。`seq`：この部屋で何ゲーム目か（`1`〜`4`、5 以上は `5`）。`wait`：`seq` が 1 のときだけ、部屋を作ってからの分（`0-1` / `1-3` / `3-5` / `5-10` / `10+`）。引き継いだホストは作成時刻を知らないので付けない | L1・L6・L8・L10・**V-1** |
| 6 | `room_enjoyed` | ホスト：ゲーム開始の瞬間に、この部屋が**初めて**北極星の条件を満たしたとき（§14.4） | `peak`：これまでのゲームの参加人数の最大（3〜10 の整数。数えた状態の `n` からだけ作る）。`game`：その瞬間に始まったゲーム ID（#5 と同じく一覧のものだけ） | **北極星**・**V-1**（8〜10 人の割合） |
| 7 | `room_error` | 全員：「接続できませんでした」「見つかりません」「満員」を初めて出したとき（同じ画面で 1 回） | `kind`：`failed` / `notfound` / `full` | L9 |
| 8 | `practice_over` | ひとり用：1 回の挑戦が終わったとき | `stage`：`1-4` / `5-9` / `10-14` / `15+`。`best`：真偽（自己ベストを更新したか） | 入口の量・L5 |
| 9 | `rules_open` | 全員：「くわしいルール」を開いたとき（J-26 の折りたたみを開いたとき） | `game`：ゲーム ID（一覧のものだけ） | H10（ひと言で足りているか） |

**参照元の許可一覧（初期案。CTO の仮置き。名前の追加・削除は Marketing・PdM が決める）**

参照元の URL のホスト名が、下のドメインと**完全に一致するか、そのサブドメイン**（`www.google.com`・`l.instagram.com` など。`evilgoogle.com` は当たらない）で、かつ `https:` のときだけ名前にする。それ以外（`http:`・`file:`・IP アドレス・解釈できない文字列・一覧にないドメイン）は `other`。参照元が空か自分のサイトなら空。

| 名前 | ドメイン | 主な用途 |
| --- | --- | --- |
| `google` | `google.com`・`google.co.jp` | 検索（V-3） |
| `yahoo` | `yahoo.co.jp`・`yahoo.com` | 検索（V-3） |
| `bing` | `bing.com` | 検索（V-3） |
| `duckduckgo` | `duckduckgo.com` | 検索（V-3） |
| `x` | `t.co`・`x.com`・`twitter.com` | SNS |
| `line` | `line.me` | 招待（LINE のアプリ内ブラウザは参照元を付けないことが多い） |
| `instagram` | `instagram.com` | SNS |
| `facebook` | `facebook.com` | SNS |
| `youtube` | `youtube.com`・`youtu.be` | 配信（V-2 の補助） |
| `twitch` | `twitch.tv` | 配信（V-2 の補助） |
| `tiktok` | `tiktok.com` | SNS |
| `discord` | `discord.com` | 配信・コミュニティ |
| `hatena` | `hatena.ne.jp` | ブックマーク |

- 人が自分の名前でサブドメインを持てるドメイン（`github.io`・`pages.dev`・`blogspot.com`・`note.com` の個人ページのような形）は**一覧に入れない**（M-2 の趣旨）。足すときは Security に確かめる。
- Umami へは名前をそのまま `referrer` に入れず、名前ごとの**固定の URL**（`google` → `https://google.com`、`other` → `https://other.invalid`）に置き換えて送る。Umami の参照元の画面がドメインで集計するため【要確認：Umami が URL でない参照元をどう扱うか。実装の時に Backend が確かめる】。

**後回し（今は送らない）**

| 08 の案 | 理由 | 入れる時期の目安 |
| --- | --- | --- |
| `join_view`・`joined.ms`（L2 そのもの） | 「開いたが入れなかった」は `room_error` とページ表示の `/r` で大まかに見える。秒数は試遊の観察（D-48）で取る | L2 が問題になったら |
| `game_end`・`room_close`・`host_takeover` | 北極星・L1 は `game_start` の `seq` と `room_enjoyed` で出る。`room_close` は届かないことが多い。引き継ぎの補正は `rid` をやめたので不要 | 不要の見込み |
| `practice_start`・`practice_share`・`practice_to_room` | ページ表示の `/practice` と `room_create.after_practice` で足りる | ひとり用を改善するとき |
| `feedback`（1 タップ感想） | 画面の追加になる。試遊とアンケートで取る | Phase 1 の途中で PdM が判断 |
| 端末ごとの `named` | 使い道が薄い | 不要 |

**V-1〜V-3 の扱い**

| # | 今 | 後 |
| --- | --- | --- |
| V-1 大きめの部屋 | **今入れる**：`room_enjoyed.peak`（8〜10 の割合）と `game_start.n` | 30 人以上の需要は測れない（部屋は 10 人まで。05 §3.1 のとおり弱いサインとして読む） |
| V-2 配信での利用 | **今入れる**：`?s=stream` の印を読み、`room_create.src` に載せる（数えるのは「`s=stream` から作られた部屋の数」）。印つき URL の置き場所と「配信で使って OK」の文言は Client（2027 年 2 月まで。05 §7） | 配信者の数は計測では数えない（同じ人を見分けないため。05 G-7）。SNS Marketer の検索で数える |
| V-3 余興ページへの検索来訪 | **送り方だけ今決める**：説明ページは検索に出すため**ハッシュではない本物のパス**（例：`/yokyo/`。名前は Marketing・Client）にし、そのページでもページ表示（`url` はそのパス、`referrer` は許可一覧の名前）を送る。参照元が `google`・`yahoo`・`bing`・`duckduckgo` の表示数＝検索来訪 | ページは 2027 年 1 月末まで（Client）。検索語と順位は Umami では分からないので、Google Search Console（無料）を使う。登録は PO の作業になる（10 分）ので、ページを出すときに PO 判断として出す |

**量の見積もり**【仮定】：4 人の部屋で 3 ゲーム遊ぶと、ページ表示 4＋作成 1＋招待 1＋参加 3＋開始 3＋楽しまれた 1 ＝ 約 13 件。トップ・ひとり用の表示を足しても、月 10 万件は**部屋にして月 5,000 前後**まで持つ。Phase 1（〜100 部屋）では上限の 2% 程度。

### 14.4 北極星の数え方（端末の中の判定）

部屋ごとの小さな記録（以下「部屋の記録」）を**全員の端末**が持ち、送るのはそのときのホストだけにする。

```
部屋の記録 = { games: number, peak: number, enjoyed: boolean, lastStartedAt: number | null, createdAt: number | null }
```

1. 端末は部屋の状態を受け取るたびに、`state.game.startedAt` が `lastStartedAt` と違えば「新しいゲームが始まった」とみなし、`games += 1`、`peak = max(peak, game.players.length)` にする（ホストもゲストも同じ）。ただし `game.id` が登録の一覧にない、または `game.players.length` が 1〜10 の整数でない状態は**数えない**（記録を変えない。偽の状態 R-02 で、攻撃者の決めた文字列をホストの端末から送らせないため。M-1）。
2. その瞬間に**自分がホストなら** `game_start` を送る。
3. 1 の更新で `games >= 2 && peak >= 3` が**初めて**真になり、かつ自分がホストなら `room_enjoyed` を送る。真になったら `enjoyed = true`（ゲストのままでも立てる）。
4. 部屋の記録はタブの `sessionStorage`（キーは `sukima:m:room:` ＋部屋コード。**端末の中だけで、送らない**）に置き、リロードで数え直さない。部屋を出たら消す。

- **なぜ全員が数えるか**：ホストが交代しても、新しいホストは参加者として同じ数を数えてきたので、`seq` が続き、`room_enjoyed` は「条件が初めて真になったゲーム開始」を行ったホスト 1 人だけが送る（二重に数えない）。
- **「3 人以上」の読み方**：「その部屋で始まったゲームのうち、どれかの参加者が 3 人以上」とした（08 §1.2 の「3 人以上がゲームに参加し」）。**PdM に確定してもらう**（他人が 2 人のゲームを 2 回は含まない、という点だけが違う）。
- **ずれる場合（許容する）**：① 途中から入った人がホストを引き継ぐと、その人の `games` は少ないので、条件を満たすのが遅れるか、すでに数えた部屋を数え直すことがある（引き継ぎは参加順の古い人から選ぶので、途中参加者がホストになるのはまれ）② 二重ホストの数秒（ADR-7）に両方が送る ③ 広告ブロッカーで送れない（下限として読む）④ デモモードは送らない。
- **端末の中の真偽値**（`rehost`・`was_guest`・`after_practice`）：`localStorage` に「最後にホストした日」「最後にゲスト参加した日」「最後にひとり用を遊んだ日」を**日付（YYYY-MM-DD）だけ**置き、送るのは区分けだけ（08 §2.1 の方針どおり）。端末を見分ける ID は作らない・送らない。

### 14.5 プライバシー

**送らないもの（テストで確かめる）**

| もの | 扱い |
| --- | --- |
| 名前・チャットの中身 | 送らない。送信関数は名前・チャットを受け取る引数を持たない |
| 部屋コード | 送らない。URL は `/r` に置き換える。ハッシュ・参照元のパスも送らない |
| プレイヤー ID（`p_…`、`localStorage`） | 送らない。部屋の記録のキー・中身にも入れない（コードはキーに入るが `sessionStorage` の中だけ） |
| 端末・人を見分ける ID | SUKIMA は作らない。Cookie は使わない。Umami の応答（セッション用のトークン）は読まない・保存しない・次の送信に付けない（付けると端末の ID と同じになる。R-3）。ただし Umami 側は、届いた IP と UA から短い期間の訪問のまとまり（セッション）を自分で作り、同じ人の一連のイベントをつなげて持つ（M-4。説明文に書く） |
| IP アドレス | こちらでは扱わない。送信の仕組み上 Umami のサーバーには届き、Umami は IP から国・地域を出す。Umami は IP を保存せず、日ごとに変わる値と混ぜて訪問者を数える、と説明している【要確認：検索では実装の説明が食い違った。塩の入れ替え周期も】 |
| 参照元のオリジン・フル URL・検索語 | 送らない。許可一覧（§14.3）の名前か `other` だけ（オリジン自体が人や勤め先を指すことがあるため。M-2） |
| ページの hostname | 実際の `location.hostname` ではなく**固定値**（`VITE_UMAMI_HOST`）を送る（M-3） |
| ゲームの中身（お題・回答・スコア） | 送らない。送るのは表の値だけ（ゲーム ID・人数・区分け） |

**送らない条件**（どれか 1 つでも当たれば送らない。**送るたびに**判定する）：

1. デモモード（`isOnlineMode` が偽）
2. 開発中（`import.meta.env.DEV`）、テスト（`import.meta.env.MODE === 'test'`）
3. 送り先の値（`VITE_UMAMI_WEBSITE_ID`）が空
4. **`location.hostname` が本番のホスト名（ビルド時の値 `VITE_UMAMI_HOST`、既定 `sukima-ee3.pages.dev`）と完全一致しない**（M-3）。Preview（`<枝>.sukima-ee3.pages.dev`）・`localhost`・`127.0.0.1`・`npm run preview`・他のサイトに置かれたコピー（`sukima-ee3.pages.dev.evil.com` など）はここで落ちる
5. 利用者が「送らない」を選んだ（`localStorage` の `sukima:metrics:off`）。保存に失敗したとき（プライベートモードなど）は、タブの中の変数で「送らない」を保つ。値は `'1'`（送らない）・`'0'`（送る）・なし（初期。送る）だけを認め、読むと例外・それ以外の壊れた値は**送らない側**に倒す。押した瞬間から同じタブの次の送信が止まる（R-2）
6. ブラウザの「追跡しない」設定：`navigator.doNotTrack`・`window.doNotTrack`（古い Safari など）が `'1'` か `'yes'`、または `navigator.globalPrivacyControl === true`。`navigator` が無い・読むと例外のときも送らない（R-1）

- 録画・自動操作のスクリプト（`marketing/sns/`）は、`sukima:metrics:off` を立ててから本番を開く（SNS Marketer への依頼。M-3）。

**説明文：要る**。理由：① D-12 の条件（匿名の計測）を利用者に分かる形で示す ② 電気通信事業法の外部送信規律（利用者の情報を外部へ送るときの「公表」など）が SUKIMA に当たるかは**要確認**だが、当たっても「公表」と「送らない設定」で足りる形にしておく【確認済み（検索）：規律は通知・公表・同意・オプトアウトのいずれかを求める】。

- **置き場所**：ハッシュの画面 `#/privacy`（新設）。トップの一番下に「匿名の利用統計について」のリンク（08 §2.2 の一文を兼ねる）。**部屋とひとり用の画面にも、目立たない小さなリンク**（既存のメニュー・ルール欄・フッターなど、遊びの邪魔にならない所。場所は Client・Designer が決める）を置く。ゲストの多くは部屋の URL から直接入りトップを見ないので、そこから 1〜2 回の操作で届くようにする（外部送信規律の「公表」の考え方。M-5）。
- **中身（Client が貼る案。文言は PdM・Security が確認）**：公表で求められる 3 項目（送る情報・送り先・目的）と「送らない」を揃える（M-4・M-5）。

> **匿名の利用統計について**
> - 目的：SUKIMA がどのくらい遊ばれているかを数えて、改善するためです。
> - 送るもの：開いた画面の種類（トップ・ひとり用・部屋）、部屋を作った・ゲームを始めた・招待した、などの出来事と、その時の人数・ゲームの種類。来た元のサイトの種類（検索・SNS など）。画面の大きさ、言語、ブラウザの種類。
> - 送らないもの：名前、チャット、部屋コード、遊んだ内容。
> - 送り先：Umami Software, Inc. のアクセス解析サービス「Umami Cloud」。
> - SUKIMA はあなたを見分ける番号を作らず、Cookie も使いません。ただし送り先の Umami は、届いた IP アドレス（ネットの住所）とブラウザの種類から、短い期間の訪問のまとまりと、おおまかな地域（国・地域）を出します（Umami は IP アドレスそのものは保存しないと説明しています）。
> - この端末の中に、最後に遊んだ日付と「送らない」の設定だけを保存します（日付は送りません）。
> - ほかに通信するところ：遊ぶための通信（Supabase）、文字の形（Google Fonts）、サイトの配信（Cloudflare）。これらのサービスにも、仕組み上、あなたの IP アドレスが届きます。
> - 送りたくないとき：下の「送らない」を押すと、この端末からは送りません。
> 　［送らない］／［送る］
> ※ ブラウザで「追跡しない」を設定している場合は、最初から送りません。

- 会社名「Umami Software, Inc.」は【要確認】（§14.10 の 8）。公開の前に Umami の規約・プライバシーの頁で正式名称と所在国を確かめて書く（確かめられないまま公開しない）。

- **子どもが遊ぶ場合**（NORTH_STAR §4）：年齢は聞かない・送らない。そもそも個人の情報を集めないので、子ども向けの別の扱いは作らない。説明文はふりがななしでも読める短い言葉にする（上の案）。名前・チャットを送らないことは、子どもが本名を入れた場合にも効く。

### 14.6 作りの方針

- **置き場所**：計測は `logic.ts`・`engine.ts`・各ゲームの `logic.ts` に入れない（08 §2.1）。部屋の記録の判定は**純粋関数**（`src/lib/metrics.ts`）、送信は注入できる送り先を持つ小さな部品（`src/lib/analytics.ts`）、部屋の配線はフック（`src/room/useRoomMetrics.ts`）に置く。
- **契約（`src/room/types.ts`）は変えない**。フックは `RoomHandle` を受け取るだけ。
- **外部へ送らない仕組み（テスト）**：送り先 `sink` を必ず注入する。製品の送り先（`fetch` で Umami へ）を作るのは `createBrowserSink()` だけで、`createAnalytics` は「送らない条件」（§14.5）に当たると `sink` を呼ばない。テストは配列に積むだけの偽の `sink` を渡し、製品の送り先は作らない。加えて、テストの実行時（`MODE === 'test'`）は `createBrowserSink()` が何もしない送り先を返す（二重の止め）。
- **送り方**：`fetch(送り先, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body })`。失敗は握りつぶす（遊びを止めない・再送しない）。握りつぶしは `try { ... } catch {}` に加えて **`fetch(...).catch(() => {})` も必須**（非同期の失敗は `try` で捕まらず、未処理の Promise の拒否になる）。`JSON.stringify` も `try` の中。応答は**読まない**（R-3）。送信は `useEffect` と画面の操作の後だけで呼び、`reduce`・描画中には呼ばない。送り先は `https://gateway.umami.is/api/send`【要確認：古い説明は `cloud.umami.is/api/send`】。`sendBeacon` は JSON だと CORS の事前確認に当たるので使わない。
- **送りすぎの止め**：1 タブあたり 1 時間に 60 件まで（`useEffect` の不具合で無限に送り、無料枠を食いつぶすのを防ぐ）。加えて種類ごとの上限を部屋の記録（`sessionStorage`）で持つ：`game_start` は 1 部屋 30 件まで、`room_enjoyed` は 1 部屋 1 回（偽の状態で `startedAt` だけ変え続けられても、60 件より手前で止まる。R-5）。
- **二段目の検査**（R-4）：`createAnalytics.track` の側でも、`data` のキーが §14.3 の表のものか、値が文字列（50 文字以下・`game` は登録の一覧のもの）・整数・真偽のどれかかを見て、外れたらそのイベントを送らない（`metrics.ts` に不具合があっても外に出ない）。
- **`observeRoom` の入力の検証（M-1。仕様）**：
  - `state.game.id` が `gameIds`（`src/games/registry.ts` の ID の一覧。呼び出し側のフックが渡す）にないときは、記録を変えず、イベントも返さない。
  - `state.game.players.length` が 1〜10 の整数でないときも同じ。`peak` は数えた状態の人数からだけ作るので、常に 1〜10 の整数。
  - `metrics.ts` が registry を直接 import しないのは、registry が各ゲームの View（React）を読み込み、純粋関数のテストが重くなるため。

```ts
// src/lib/metrics.ts（純粋関数。時刻は引数）
export type MetricEvent =
  | { name: 'room_create'; data: { src: Src; rehost: '7d' | '28d' | 'no'; was_guest: boolean; after_practice: boolean } }
  | { name: 'invite_share'; data: { method: 'share' | 'copy' | 'qr'; n: number } }
  | { name: 'room_join'; data: { via: 'qr' | 'code' | 'link' } }
  | { name: 'game_start'; data: { game: string; n: number; seq: 1 | 2 | 3 | 4 | 5; wait?: WaitBucket } }
  | { name: 'room_enjoyed'; data: { peak: number; game: string } }
  | { name: 'room_error'; data: { kind: 'failed' | 'notfound' | 'full' } }
  | { name: 'practice_over'; data: { stage: '1-4' | '5-9' | '10-14' | '15+'; best: boolean } }
  | { name: 'rules_open'; data: { game: string } };
export type Src = 'stream' | 'x' | 'tiktok' | 'guide' | 'none' | 'other';
export type WaitBucket = '0-1' | '1-3' | '3-5' | '5-10' | '10+';
export type RoomTally = { games: number; peak: number; enjoyed: boolean; lastStartedAt: number | null; createdAt: number | null; startsSent: number };
export type RefName = 'google' | 'yahoo' | 'bing' | 'duckduckgo' | 'x' | 'line' | 'instagram' | 'facebook' | 'youtube' | 'twitch' | 'tiktok' | 'discord' | 'hatena' | 'other';

export const emptyTally = (createdAt: number | null): RoomTally;
// 状態を 1 つ受け取り、新しい記録と送るイベントを返す。isHost が偽なら events は常に空。
// game.id が gameIds にない・人数が 1〜10 の整数でない状態は、記録を変えずに events を空で返す（M-1）
export const observeRoom = (t: RoomTally, state: RoomState, isHost: boolean, now: number, gameIds: ReadonlySet<string>): { tally: RoomTally; events: MetricEvent[] };
export const parseSrc = (search: string): Src;            // '?s=stream' → 'stream'。許可外は 'other'、なしは 'none'
export const parseVia = (search: string): 'qr' | null;    // '?via=qr' だけ認める
export const routePath = (hash: string): '/' | '/practice' | '/r' | null; // '#/privacy' は null（ページ表示を送らない。R-9）
export const referrerName = (referrer: string, selfOrigin: string): RefName | ''; // 許可一覧（§14.3）の名前か 'other'。空・自分なら ''（M-2）
export const rehostBucket = (lastHostDay: string | null, today: string): '7d' | '28d' | 'no';
export const stageBucket = (cleared: number): '1-4' | '5-9' | '10-14' | '15+';
export const waitBucket = (ms: number): WaitBucket;

// src/lib/analytics.ts
export type Payload = { type: 'event'; payload: { website: string; hostname: string; url: string; referrer: string; language: string; screen: string; title: string; name?: string; data?: Record<string, string | number | boolean> } };
export type Sink = (p: Payload) => void;
// env.hostname は location.hostname ではなく VITE_UMAMI_HOST の固定値（M-3）。gameIds は二段目の検査用（R-4）
export type AnalyticsDeps = { sink: Sink; websiteId: string; enabled: () => boolean; now: () => number; gameIds: ReadonlySet<string>; env: { hostname: string; language: string; screen: string } };
export const createAnalytics = (deps: AnalyticsDeps): { pageview(url: string, referrer?: string): void; track(e: MetricEvent, url: string): void };
export const createBrowserSink = (): Sink;               // MODE === 'test' では何もしない送り先
export const metricsAllowed = (): boolean;               // §14.5 の「送らない条件」1〜6 をまとめて判定。送るたびに呼ぶ。例外は false
export const setMetricsOptOut = (off: boolean): void;     // localStorage 'sukima:metrics:off'
export const analytics: ReturnType<typeof createAnalytics>; // 製品用の 1 つ（main から使う）
```

- `title` は常に `SUKIMA`、`screen` は `"${screen.width}x${screen.height}"`（Umami の端末の区分けに使われる）。ページの `document.title` や `location.href` は使わない。
- `url` は `routePath` の値に、許可した印（`?s=…`）だけを付けたもの。`routePath` が `null`（`#/privacy`）ならページ表示を送らない。
- `hostname` は常に `VITE_UMAMI_HOST` の固定値。`referrer` は `referrerName` の名前を §14.3 の固定の URL に置き換えたもの（空なら空）。

### 14.7 作業票

#### Backend（約 1.5 人日）

| # | 内容 | 完了の条件 |
| --- | --- | --- |
| M-B1 | `src/lib/metrics.ts`：§14.6 の型と純粋関数。`observeRoom` は §14.4 の手順どおり（ホストのときだけイベントを返す、`room_enjoyed` は初めて条件を満たした 1 回だけ、`seq` は 5 で頭打ち、`wait` は `createdAt` があり `seq === 1` のときだけ）。**`game` は `gameIds` の一覧にあるときだけ、`n`・`peak` は 1〜10 の整数だけ（外れた状態は数えず送らない。M-1）**。`game_start` は 1 部屋 30 件まで（R-5）。`referrerName` は §14.3 の許可一覧（M-2）。`routePath('#/privacy')` は `null`（R-9） | 単体テスト（`src/__tests__/metrics.test.ts`）：① ゲスト→ホスト交代でも `seq` が続き、`room_enjoyed` が全端末を通して 1 回 ② 2 人で 2 ゲーム・3 人で 1 ゲームでは送らない ③ 同じ `startedAt` の状態を何度受けても数えない ④ `parseSrc` が許可外を `other` にする ⑤ `routePath('#/r/ABCD')` が `/r`、`'#/privacy'` が `null` ⑥ `referrerName` が一覧のドメイン（サブドメインを含む）を名前に、`https://taro-yamada.github.io/x`・`http://192.168.0.10:3000`・`https://intra.example.co.jp`・`https://evilgoogle.com`・`http://www.google.com`・`file:///`・`not a url` を `other` に、空・自分のオリジンを空にする ⑦ 区分けの境界値 ⑧ **登録にない `game.id`・11 人以上・0 人・小数の人数の状態で、返すイベントの `game` が一覧内、`n`・`peak` が 1〜10 の整数に収まる（または返さない）** ⑨ `startedAt` だけ変えた状態を 500 回で `game_start` が 30 件で止まる |
| M-B2 | `src/lib/analytics.ts`：送信の部品。送り先の注入、送らない条件（§14.5 の 1〜6。送るたびに判定）、1 時間 60 件の上限、失敗の握りつぶし（`fetch(...).catch` まで）、応答を読まない、二段目の検査、`hostname` の固定 | テスト：偽の `sink` で ① 送らない条件それぞれで 0 件（`hostname` が `abc.sukima-ee3.pages.dev`・`localhost`・`sukima-ee3.pages.dev.evil.com`・`127.0.0.1`、DNT の `'1'`・`'yes'`・`window.doNotTrack`・GPC、`navigator` の読み取りが例外、「送らない」の値が壊れている・保存が例外を投げる、を含む）② 61 件目を捨てる ③ `sink` が例外を投げても、`fetch` が拒否しても、呼び出し側にも未処理の Promise にも漏れない ④ **どのイベントの送信内容を `JSON.stringify` しても、部屋コード・名前・プレイヤー ID・チャット文が含まれない**（疑似ネットワーク `createSimRoom` で名前・チャット・コードを入れた部屋を回し、全端末の `observeRoom` の出力を `createAnalytics` に通して確かめる）⑤ `createBrowserSink()` がテストの実行時に `fetch` を呼ばない（`globalThis.fetch` を数えるだけの関数に差し替えて 0 回。時計の偽装ではない）⑥ 表にないキー・51 文字以上の文字列・一覧にない `game`・オブジェクトの値を含むイベントを `track` に直接渡すと 0 件（R-4）⑦ 送信内容の `hostname` が常に固定値、`referrer` が固定の URL か空 ⑧ 偽の `fetch` がトークン入りの応答を返しても、次の送信が同じ形（R-3） |
| M-B3 | `src/room/useRoomMetrics.ts`：`useRoomMetrics(room: RoomHandle, opts: { create: boolean })`。部屋の記録を `sessionStorage` に読み書きし、`room.state` が変わるたびに `observeRoom`（`gameIds` は registry の ID の一覧）を呼んで送る。`room_create`（create が真で初めて `ready`）・`room_join`（ゲストで初めて自分がメンバー。同じタブ・同じ部屋で 1 回）・`room_error`（`failed` / `notfound` / `full` を初めて出したとき）もここで送る。`localStorage` の「最後にホスト／ゲスト参加した日」を更新する | `useRoom.ts`・`engine.ts`・`types.ts` を変えない。ストレージが使えない（プライベートモード）ときも例外を出さず、送らないか数え直すだけ |
| M-B4 | ビルド時の値：`VITE_UMAMI_WEBSITE_ID`（空なら送らない）、`VITE_UMAMI_HOST`（本番のホスト名。空なら `sukima-ee3.pages.dev`。§14.5 の条件 4 と payload の `hostname` に使う）、`v`（`package.json` の version）。`vite-env.d.ts` の型 | `npm run typecheck`・`test`・`build` が通る。`.env.local` の例を README に書くのは Client |
| M-B5 | §13 に実装で決めた点を書き足す | — |

- `v` の埋め込みに `vite.config.ts` の `define` が要る場合は、オーケストレーターの担当なので依頼として出す（`import.meta.env` で済むならそれでよい）。

#### Client（約 1 人日）

| # | 内容 | 完了の条件 |
| --- | --- | --- |
| M-C1 | `main.tsx`（または `App.tsx`）：起動時に `?s=` と `?via=` を読み、タブの中（モジュール変数＋`sessionStorage`）に置いてから、`history.replaceState` でアドレス欄から消す（リロード・共有で印が広がらないように）。画面が変わるたびに `analytics.pageview(routePath(location.hash) + 印)`（`null` なら送らない）。参照元は最初の 1 回だけ（`referrerName`） | 部屋の URL をコピー・共有しても `?s=`・**`?via=`** が付かない（R-10）。ハッシュの遷移でページ表示が 1 回ずつ。`#/privacy` を開いてもページ表示を送らない（R-9） |
| M-C2 | `Room.tsx`：`useRoomMetrics(room, { create })` を 1 行。招待の共有・コピーが成功したとき（`shared` / `copied`）と QR を開いたときに `invite_share` | キャンセル（`aborted`）・失敗は送らない |
| M-C3 | `share.ts`：`roomUrl(code, { via: 'qr' })` で `?via=qr` を付けた URL を作れるようにし、QR だけに使う（`https://…/?via=qr#/r/ABCD`）。招待の共有・コピーは今のまま | QR を読んだ端末で `room_join.via` が `qr`。Cloudflare Pages で `/?via=qr` が開けること（実機で 1 回） |
| M-C4 | `Home.tsx`：コードを入れて参加したときに、`room_join.via = 'code'` になる印を渡す（`goRoom` の前にモジュール変数を立てるなど） | — |
| M-C5 | `Practice.tsx`：1 回の挑戦が終わったら `practice_over`。`localStorage` の「最後にひとり用を遊んだ日」を更新（関数は Backend の `metrics.ts` を使う） | — |
| M-C6 | ルールの折りたたみ（J-26）を開いたときに `rules_open` | J-26 の実装に合わせる |
| M-C7 | `#/privacy` の画面（§14.5 の文、「送らない／送る」の切り替え）と、トップの一番下のリンク、**部屋とひとり用の画面の目立たない小さなリンク**（M-5） | 幅 360px で崩れない。切り替えが再読み込み後も残る。保存に失敗したときは「この端末では設定を保存できません」と出し、同じタブでは送らないを保つ（R-2）。**部屋・ひとり用の画面から 1〜2 回の操作で説明に届き、戻ると部屋に戻れる（部屋を抜けない）**。説明文に送り先の正式名称と目的がある（M-5） |
| M-C8 | README：計測の値（`VITE_UMAMI_WEBSITE_ID`・`VITE_UMAMI_HOST`）、**Cloudflare の Production だけに入れ、Preview には入れないこと**（M-3）、デモ・開発・本番以外のホスト名では送らないこと | — |

#### Security

- 確認観点は §14.8。設計の段階で 1 回、Backend・Client の実装の後に 1 回。結果は `docs/dev/05-security-report.md` に、足りないテストは `src/__tests__/security-metrics.test.ts` に書く。

#### PO（初回 15 分・その後 週 2 分）

1. **Umami Cloud に登録する（10 分）**：`https://cloud.umami.is` を開いて登録（メールか GitHub。クレジットカードが要るかは要確認）。「Add website」で、名前 `SUKIMA`、ドメイン `sukima-ee3.pages.dev` を入れる。表示された **Website ID**（`xxxxxxxx-xxxx-…` の形）をコピーする。**2 段階認証があればオンにする。「Share URL」（公開のダッシュボード）は作らない**（地域・時刻・端末のつながった記録が誰にでも見えるため。R-7）。
2. **Cloudflare に入れる（5 分）**：Cloudflare の SUKIMA のプロジェクト →「Settings」→「Variables and Secrets」で、**「Production」だけに** `VITE_UMAMI_WEBSITE_ID` ＝ 1 の値を「Text」で足し、「Retry deployment」で作り直す（`docs/dev/11-launch-guide.md` §2-4 と同じ操作）。Preview には入れない（試作の版を数えないため）。Website ID は公開されてよい値。
3. **確かめる（1・2 の 15 分に含む）**：公開されたサイトを開き、Umami の画面の「Realtime」に 1 人出れば完了。
4. **週 1 回（2 分）**：Umami の「Events」で、期間を「過去 7 日」にして `room_enjoyed` の件数を見て、チャットに送る（スクリーンショット 1 枚でよい）。11 §6 の週 5 分の確認と同じ日に行う。AI が自分で見る案は PO 判断 2。
- 実装がマージされたら、CTO が 11 の手順書に 1〜4 を移す。
- 保存は 6 か月なので、週の数字は AI が `docs/` に書き写して残す（PdM。08 の記録の表）。書き写すのは**週の件数などの集計だけ**。Realtime・地域・セッションの画面のスクリーンショットは `docs/` に貼らない（R-7）。

#### Security の推奨（05 §8.2）の取り込み

| # | 扱い | 入れた所・入れない理由 |
| --- | --- | --- |
| R-1 | 入れる | §14.5 の条件 6、M-B2 ① |
| R-2 | 入れる | §14.5 の条件 5、M-B2 ①、M-C7 |
| R-3 | 入れる | §14.6 の送り方、§14.5 の表、M-B2 ③⑧ |
| R-4 | 入れる | §14.6 の二段目の検査、M-B2 ⑥ |
| R-5 | 入れる | §14.6 の送りすぎの止め（`game_start` は 1 部屋 30 件）、M-B1 ⑨ |
| R-6 | **今回は入れない** | CSP（`public/_headers`）はまだ無く、入れるなら Supabase・Google Fonts まで含めた別の票になる。CSP の票を立てるときに `connect-src` に `gateway.umami.is` を足し `script-src` に足さないこと、`Referrer-Policy: strict-origin-when-cross-origin` の明示を完了条件にする（Referrer-Policy は今のブラウザの既定と同じで、今回の差は小さい） |
| R-7 | 入れる | PO の手順 1、書き写しの決まり（上） |
| R-8 | 入れる（判断の条件として） | §14.9 の 2（B は API キーを閲覧だけに限れると分かってから） |
| R-9 | 入れる | `routePath` が `null`、M-B1 ⑤、M-C1 |
| R-10 | 入れる | M-C1 の完了条件 |

### 14.8 Security のレビューが要る点

実装の**前**（設計）と**後**（コード）の 2 回。**1 回目は済み**（05 §8、2026-11-21。必須 M-1〜M-5 は本節に反映）。2 回目は実装の後に、05 §8.4 の再現テスト（`src/__tests__/security-metrics.test.ts`）を Security が書いて行う。

1. 送信内容に部屋コード・名前・チャット・プレイヤー ID・ハッシュ・参照元のパスが入らないこと（M-B2 ④ のテストが十分か）。`game` の値がゲーム ID の一覧の中だけか（登録にない ID を送らない）
2. 外部へ通信する先が 1 つ増えること（`gateway.umami.is`）。将来 CSP（`_headers`）を入れるなら `connect-src` に足す。Umami のスクリプトを読み込まないこと
3. 「送らない条件」（デモ・開発・テスト・値が空・送らない設定・追跡しない設定）がすべて効くこと。Preview の版で送らないこと
4. 1 時間 60 件の上限で、不具合や悪意の操作（ホストの「もう一度」の連打など）で無料枠を食いつぶさないこと。他の端末から届くメッセージで送信を起こせる経路が、状態の変化（ゲーム開始）だけであること
5. `sessionStorage`・`localStorage` に置く値（日付・部屋の記録）が送られないこと、壊れた値を読んでも例外を出さないこと
6. 説明文（§14.5）の内容が実装と一致していること。外部送信規律の「公表」として足りるか【要確認】
7. Umami Cloud 側：IP の扱い・データの置き場所（国）・保存期間【要確認】。PO のアカウントの守り（2 段階認証があれば使う）

### 14.9 PO 判断事項

| # | 決めること | 推奨 | 理由 |
| --- | --- | --- | --- |
| 1 | 計測の道具を **Umami Cloud（無料）**にし、PO の名前で登録する | 採る | 北極星・V-1・V-2 が測れて、費用 0 円・初回 15 分。D-12 の候補どおり |
| 2 | 週の数字の確かめ方：A. PO が週 1 回、画面の数字を送る（週 2 分）／ B. Umami の API キーを AI に渡し、AI が取りに行く（PO の手間 0。ただし秘密の値を 1 つ預けることになり、`api.umami.is` への接続の許可が要る。Hobby で API が使えるかは要確認） | **まず A**。B は API が使えて、**キーを閲覧だけに限れる**と分かってから（R-8） | B は秘密の値の扱いが増える。限れないキーでは設定の変更・データの削除までできる。週 2 分なら NORTH_STAR §5 の 1 番に大きく反しない |
| 4 | §14.11 の受け入れるリスク（R-09〜R-14）を了承する。R-11 は A／B を選ぶ | 全部了承。R-11 は **A** | Security も同じ意見（05 §8.3） |
| 5 | 参照元の許可一覧（§14.3）の初期案 | 仮置きのまま実装に入り、Marketing・PdM が足し引きする | 一覧にないものは `other` に入るだけで、後から足せる |
| 3 | 無料枠の 70%（月 7 万件）を超えたら、Pro（月 20 ドル）に移るか、自前に移るか | そのときに決める（今は決めない） | 超えるのは部屋が月 3,000 を超えたころ【仮定】で、それ自体が良い兆候 |

- V-3 の Google Search Console の登録（10 分）は、説明ページを出すとき（2027 年 1 月）に別に出す。

### 14.10 要確認の一覧

1. Umami Cloud の Hobby の上限（月 10 万イベント・サイト 1 つ・保存 6 か月）と、**超えたときに止まるか・課金されるか**。登録でクレジットカードが要るか
2. Umami Cloud の送り先（`gateway.umami.is/api/send` か `cloud.umami.is/api/send` か）と、ブラウザから直接送ったときに CORS で受け付けるか（Umami のスクリプト自身が同じ送り方なので受け付ける見込み）
3. Umami の IP の扱い（保存しない・日ごとの値と混ぜる、の実装）と、データの置き場所（国）
4. Hobby で、イベントの項目（`peak`・`src` など）ごとの集計画面が使えるか。API キーが使えるか（PO 判断 2）
5. 広告ブロッカーが `gateway.umami.is` を止めるか（止めるなら数は下限として読み、必要なら Pages Functions で中継）
6. Cloudflare Web Analytics が独自イベントを送れないこと・Cookie を使わないことの公式の記述（比べた結論は変わらない見込み）
7. 外部送信規律が SUKIMA（利用者どうしのチャットを含む個人運営のサイト）に当たるか（当たっても §14.5 の公表と「送らない」で足りる形にしてある。専門家への確認はしない前提で PO に了承を求める：§14.11 R-14）
8. Umami Cloud の運営会社の正式名称（Umami Software, Inc. か）と所在国。セッションの値（IP＋UA に混ぜる塩）の入れ替え周期
9. Umami の `/api/send` が、URL でない・固定の URL の `referrer` をどう集計するか（§14.3 の固定の URL で足りるか）

**参照（検索結果。2026-11-21）**：[Umami Cloud FAQ](https://docs.umami.is/docs/cloud/faq)、[Umami Sending stats](https://docs.umami.is/docs/api/sending-stats)、[Umami Track events](https://docs.umami.is/docs/track-events)、[Umami: GDPR compliant website analytics](https://umami.is/blog/gdpr-compliant-website-analytics)、[Cloudflare Web Analytics for SPAs](https://developers.cloudflare.com/web-analytics/get-started/web-analytics-spa/)、[総務省 外部送信規律](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu.html)

### 14.11 受け入れるリスク（PO 判断用。05 §8.3 の要約）

どれも遊ぶ人の害は小さく、防ぐ手間の方が大きいため「受け入れる」を勧める（Security も同意）。了承をもらってから実装に入る。

| ID | どういうことか（平易に） | 勧め |
| --- | --- | --- |
| R-09 | 誰でも偽の数字を送れるので、数字が水増しされることがある（遊ぶ人の害はない）。週の確認で不自然な山を見て、続いたら送り方を変える（§14.2） | 受け入れる |
| R-10 | 計測サービスの画面を見られる人なら、「何時ごろ・どの地域で・何人で・何を遊んだか」から特定の集まりを推測できる。名前や会話は入らない。見られるのは PO のアカウントだけ | 受け入れる |
| R-11 | 海外（EU）の規則では、端末に日付を保存するのに同意が要るとされうる。A：このまま（説明と「送らない」で足りるとみる）／B：日付を保存しない（「前にも遊んだ人か」が分からなくなる） | 受け入れる（A） |
| R-12 | ページを開いた最初の 1 件は、「送らない」を押す前に送られる（送るのは画面の種類だけ）。「追跡しない」の設定の人には最初から送らない | 受け入れる |
| R-13 | 広告ブロッカーなどで数が欠ける。数字は「少なくともこれだけ」と読む | 受け入れる |
| R-14 | 法律（外部送信規律）に当たるかを専門家には確かめていない。当たっても足りる形（送るもの・送り先・目的の説明と「送らない」）にはしてある | 受け入れる（専門家への確認は今はしない） |
