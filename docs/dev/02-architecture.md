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
  ホスト喪失 かつ pickNextHost(cur, online, host) === me:
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
  transport.status !== 'connected' → transport.reconnect()
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
| P1-4 | ホスト喪失の判定（§5.3） | `bye` を受けた人と「ホストからの `sync`」を `departed` に入れ、ホスト喪失を即時判定する。`departed` はその人から `state` を受けたら外す（`bye` の後に bfcache から戻ったホストが配信を再開した場合など）。`lastSeen` の更新では外さない | リロードしたホストの新しい engine は sync / join を送り続けるので、`lastSeen` だけで判定すると「ホストは生きている」と見えて誰も引き継がず、全員が止まる |
| P1-5 | 無通信検知（§3.2） | 条件に「`lastSeen` に誰かいる（全員が `bye` で去ったのではない）」を加えた | 全員が明示的に去った部屋で張り直しをしない |
| P1-6 | 状態の採用（§5.2） | 採用した状態の `hostId` が自分で、直前まで自分がホストでなかった場合（旧ホストの退出で譲られた）、outbox の未確認分を適用してから配信する | 引き継ぎ時（§5.3）と同じく、送り先を失った操作を失わないため。配信で他の人の `departed` も外れる |
| P1-7 | `status`（§3.3） | 状態を持っていれば、自分がまだ `players` にいなくても（join の処理待ち）`ready` を返す（旧実装と同じ）。`full` / `kicked` / `left` になった engine は以後送信しない（`full` は受信だけ続ける） | 旧実装の画面遷移を変えないため |
| P1-8 | `retry()` | `notfound`（接続済み）からも `transport.reconnect()` で張り直し、`notfound` を解除して `connecting` に戻す | ページを読み直さずに「接続 → sync / join → 8 秒待ち」をやり直せるように |
| P1-9 | 欠落 20% の観察（AC-17） | 欠落 20% では、ホストの定期配信（2.5 秒）が 4 回続けて落ちて参加者が誤って引き継ぐことがある（30 シード中 1 シードで発生）。その場合も状態は収束し、ライフ・クリア数は全員一致し、ミス扱いは起きない。テストは「全員のホストが 1 人に一致」までを見る | 設計どおりの値（`OFFLINE_AFTER_MS` 9 秒・`HOST_RESYNC_MS` 2.5 秒）の範囲の挙動。実機で頻発するようなら、ホストの定期配信の間隔を短くするか、喪失判定を「他の参加者からも聞こえない」ことに広げるのが次の候補 |
| P1-10 | 疑似ネットワーク（§6.1） | 送信側と受信側の条件のうち厳しい方（遅延・ゆらぎ・欠落率それぞれの最大）を使う。乱数は 1 通につき受信者ごとに 2 つ必ず引く。ネットワーク落ち（`disconnect`）中の接続試行は応答しない（`restore` で開く）。`clearDrops()` / `setAll()` を追加。`createSimRoom` に `skews` / `games` / `joinAll`、戻り値に `addPeer` / `converged` / `sent` を追加 | 全員に同じ条件を入れたとき、その値どおりになるように。条件を変えても後続の乱数列がずれないように |
| P1-11 | テストの決定性 | `sync.test.ts` はゲーム側の `Math.random`（ラッシュの出題・seed）もシード付き乱数に差し替える（`vi.spyOn`。時計の偽装ではない） | 出題でステージの長さが変わると、通信の回数＝疑似ネットワークの乱数の消費が変わり、結果が実行ごとに変わるため |
| P1-12 | 調整値（§7.1） | `params` のキーを確定：`whack.lifeDivisor`（6）と `timing.visibleMs`（1000）を追加。`timing` の指示文「3秒ぴったり！」は `targetMs` から作る。`nextMicroId(prev, t = TUNING)` に調整値の引数を追加（既存の呼び方はそのまま）。`startMicroRound` の `introMs` の既定値は `TUNING.rush.introMs`（2400。旧 2500 は製品コードからは使われていなかった）。`validateTuning` は §7.3 に加えて `params` の `…Ms` が正・`…Ratio` が 0〜1・`speed.everyStages` が 1 以上の整数・`speed.max` が 1 以上も見る | AC-41 の「同じ意味の数値の直書きを残さない」。当たり判定（よけろの距離 6/7 など）や配置・大きさの係数は見た目・操作感の値として各ファイルに残した |
