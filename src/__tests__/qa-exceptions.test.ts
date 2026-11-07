// QA（Q-02）：例外系の組み合わせシナリオ。
// 切断・ホスト交代・リロード・同時操作・連打・タイムアウト・途中参加・満員を、疑似ネットワーク上で決定的に再現する。
// 時刻は SimClock だけを使い、通信の乱数とゲーム側の Math.random はシード固定（sync.test.ts と同じ方針）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '../games/micro/core';
import type { RushState } from '../games/rush/logic';
import { ROOM_TIMINGS } from '../room/engine';
import { MAX_ROOM_PLAYERS, START_GUARD_MS, type RoomState } from '../room/logic';
import { createSimRoom, rushBot, type CounterState, type SimPeer } from './sim/harness';

const seedGameRandom = (seed: number) => vi.spyOn(Math, 'random').mockImplementation(rng(seed));
beforeEach(() => {
  seedGameRandom(4242);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Room = ReturnType<typeof createSimRoom>;
type Wire = { t?: string; seq?: number; action?: { type?: string; action?: { type?: string } } };

const snap = (p: SimPeer) => p.engine.getSnapshot();
const stateOf = (p: SimPeer) => snap(p).state as RoomState;
const counter = (p: SimPeer) => stateOf(p).game?.state as CounterState;
const rush = (p: SimPeer) => stateOf(p).game?.state as RushState;
const inc = { type: 'game', action: { type: 'inc' } } as const;
const submit = (success: boolean) => ({ type: 'game', action: { type: 'submit', result: { score: success ? 1 : 0, success } } }) as const;

// 全員が入り、引き継ぎ判定の猶予（接続から 9 秒）も過ぎた部屋
const readyRoom = (ids: string[], opts: Partial<Parameters<typeof createSimRoom>[0]> = {}) => {
  const room = createSimRoom({ ids, ...opts });
  expect(room.sim.clock.runUntil(() => ids.every((id) => snap(room.peers[id]).state?.players.length === ids.length), 30000)).toBe(true);
  room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  return room;
};

const start = (room: Room, host: string, gameId: string, online = Object.keys(room.peers)) => {
  room.peers[host].engine.dispatch({ type: 'selectGame', gameId });
  room.peers[host].engine.dispatch({ type: 'startGame', online });
  expect(room.sim.clock.runUntil(() => online.every((id) => snap(room.peers[id]).state?.game?.id === gameId), 10000)).toBe(true);
};

const hostIs = (room: Room, host: string, ids: string[]) => () => ids.every((id) => snap(room.peers[id]).state?.hostId === host);

// ---------------------------------------------------------------------------
describe('QA: ホスト交代の組み合わせ', () => {
  it('二重ホスト中に参加者がリロードしても、3 秒以内に 1 人のホストへ収束し、リロードした人も同じ状態になる', () => {
    const room = readyRoom(['a', 'b', 'c', 'd']);
    start(room, 'a', 'counter');
    let cut = true;
    room.sim.dropWhere((_m, from, to) => cut && ((from === 'b' && to === 'c') || (from === 'c' && to === 'b')), Number.POSITIVE_INFINITY);
    room.peers.a.node.freeze();
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost && snap(room.peers.c).isHost, 15000)).toBe(true);
    // 二重ホストの最中に d がリロード
    room.peers.d.reload();
    room.settle(500);
    cut = false;
    expect(room.sim.clock.runUntil(() => hostIs(room, 'b', ['b', 'c', 'd'])() && snap(room.peers.d).status === 'ready', 3000)).toBe(true);
    room.settle(3000);
    expect(room.converged(['b', 'c', 'd'])).toBe(true);
    expect(stateOf(room.peers.d).players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ラッシュ中にホストを freeze → 他の人が引き継ぎ → 旧ホストを thaw しても、進行は巻き戻らず全員一致する', () => {
    const ids = ['a', 'b', 'c'];
    const room = readyRoom(ids);
    const bots = ids.map((id) => rushBot(room.peers[id], { success: true, delayMs: 400 }));
    start(room, 'a', 'rush');
    room.settle(3000);
    room.peers.a.node.freeze();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 12000)).toBe(true);
    // 新ホストでステージが 2 つ以上進む
    const stageAtTakeover = rush(room.peers.b).stage;
    expect(room.sim.clock.runUntil(() => rush(room.peers.c).stage >= stageAtTakeover + 2, 40000)).toBe(true);
    const progressed = rush(room.peers.c).stage;
    room.peers.a.node.thaw();
    room.peers.a.engine.resume();
    expect(room.sim.clock.runUntil(() => snap(room.peers.a).state?.hostId === 'b', 3000)).toBe(true);
    room.settle(2000);
    expect(room.converged()).toBe(true);
    expect(rush(room.peers.c).stage).toBeGreaterThanOrEqual(progressed);
    expect(snap(room.peers.a).isHost).toBe(false);
    // 止まっていた a は提出できなかったステージでライフを失うが、b と c は成功を送り続けたのでミス扱いにならない
    const r = rush(room.peers.b);
    expect(r.lives.b).toBe(r.startLives);
    expect(r.lives.c).toBe(r.startLives);
    bots.forEach((s) => s());
  });

  it('ホストが状態を配る前にタブを閉じても、参加者の未確認 submit は新ホストへ再送されて成功扱いになる', () => {
    const room = readyRoom(['a', 'b', 'c']);
    start(room, 'a', 'rush');
    const r0 = rush(room.peers.a);
    // プレイ開始後に c が提出。a は受け取って処理するが、その直後（間引きの配信より前）に閉じる
    room.sim.clock.runUntil(() => room.peers.c.engine.now() >= r0.round.startAt + 300, 10000, 1);
    // a の state 配信を落として「処理したが配れなかった」状況を作る
    let block = true;
    room.sim.dropWhere((m, from) => block && from === 'a' && (m as Wire).t === 'state', Number.POSITIVE_INFINITY);
    room.peers.c.engine.dispatch(submit(true));
    room.settle(100);
    expect(rush(room.peers.a).round.results.c).toBeDefined();
    room.peers.a.engine.dispose();
    block = false;
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 2000)).toBe(true);
    expect(room.sim.clock.runUntil(() => rush(room.peers.b).round.results.c?.success === true, 2000)).toBe(true);
    expect(room.sim.clock.runUntil(() => rush(room.peers.c).phase === 'result', 20000)).toBe(true);
    expect(rush(room.peers.c).lastFailed).not.toContain('c');
  });

  it('ホストが「退出」ボタンで抜けた場合も、ラッシュは止まらずに次のホストのタイマーで進む', () => {
    const ids = ['a', 'b', 'c'];
    const room = readyRoom(ids);
    const bots = ['b', 'c'].map((id) => rushBot(room.peers[id], { success: true, delayMs: 300 }));
    start(room, 'a', 'rush');
    room.settle(1000);
    const stage = rush(room.peers.b).stage;
    room.peers.a.engine.leave();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 1000)).toBe(true);
    expect(room.sim.clock.runUntil(() => rush(room.peers.c).stage >= stage + 2, 30000)).toBe(true);
    expect(stateOf(room.peers.c).players.map((p) => p.id)).toEqual(['b', 'c']);
    bots.forEach((s) => s());
  });

  it('スリープ明けの参加者は、ホストが変わっていても自分が誤って引き継がず、新ホストに従う', () => {
    const room = readyRoom(['a', 'b', 'c']);
    // b が寝ている間に a が閉じ、c は… ではなく b より後の c が引き継ぐことはない（参加順で b が先）。
    // b が寝ているので c から見て b はオフライン → c が引き継ぐ
    room.peers.b.node.freeze();
    room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
    room.peers.a.engine.dispose();
    expect(room.sim.clock.runUntil(() => snap(room.peers.c).isHost, 2000)).toBe(true);
    room.settle(20000);
    room.peers.b.node.thaw();
    room.settle(15000);
    expect(snap(room.peers.b).state?.hostId).toBe('c');
    expect(snap(room.peers.b).isHost).toBe(false);
    expect(room.converged(['b', 'c'])).toBe(true);
  });

  it('ホストが状態配信の直後に何度も切断・再接続（フラッピング）しても、ホストは交代せず参加者の操作は 1 回ずつ届く', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    for (let i = 0; i < 5; i++) {
      room.peers.a.node.disconnect();
      room.peers.b.engine.dispatch(inc);
      room.settle(1500);
      room.peers.a.node.restore();
      room.settle(1500);
    }
    room.settle(3000);
    expect(room.hostIds()).toEqual(['a', 'a']);
    expect(counter(room.peers.a).count.b).toBe(5);
    expect(counter(room.peers.b).count.b).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('QA: リロード', () => {
  it('ラッシュで提出済みの参加者がリロードすると、提出済みのまま同じステージに戻る（E-03）', () => {
    const room = readyRoom(['a', 'b'], { cond: { latencyMs: 200 } });
    start(room, 'a', 'rush');
    const r0 = rush(room.peers.a);
    room.sim.clock.runUntil(() => room.peers.b.engine.now() >= r0.round.startAt + 200, 10000, 1);
    room.peers.b.engine.dispatch(submit(true));
    expect(room.sim.clock.runUntil(() => rush(room.peers.b).round.results.b !== undefined, 2000)).toBe(true);
    room.peers.b.reload();
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).status === 'ready', 1500)).toBe(true);
    expect(rush(room.peers.b).stage).toBe(r0.stage);
    expect(rush(room.peers.b).round.results.b?.success).toBe(true);
  });

  it('リロード後の新しい操作は、リロード前に処理済みの seq に埋もれずに届く', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    for (let i = 0; i < 3; i++) room.peers.b.engine.dispatch(inc);
    room.settle(1000);
    expect(counter(room.peers.a).count.b).toBe(3);
    room.peers.b.reload();
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).status === 'ready', 2000)).toBe(true);
    room.peers.b.engine.dispatch(inc);
    room.settle(1000);
    expect(counter(room.peers.a).count.b).toBe(4);
    expect(stateOf(room.peers.a).acks.b).toBe(4);
  });

  it('参加者がリロードを 1 秒以内に 3 回くり返しても、同じ 1 人として部屋に残る', () => {
    const room = readyRoom(['a', 'b']);
    for (let i = 0; i < 3; i++) {
      room.peers.b.reload();
      room.settle(300);
    }
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).status === 'ready', 3000)).toBe(true);
    room.settle(2000);
    expect(stateOf(room.peers.a).players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(room.hostIds()).toEqual(['a', 'a']);
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-01）
  it('QA-BUG-01: 部屋を作って 9 秒以内にホストがリロードしても、3 秒以内に復帰できる（AC-29 の境界）', () => {
    // 部屋を作った直後（参加者が入って数秒）にホストがリロードする
    const room = createSimRoom({ ids: ['a', 'b'] });
    expect(room.sim.clock.runUntil(() => stateOf(room.peers.a)?.players.length === 2, 3000)).toBe(true);
    room.settle(2000);
    room.peers.a.reload();
    const t0 = room.sim.clock.now();
    room.sim.clock.runUntil(() => snap(room.peers.a).status === 'ready', 15000);
    expect(snap(room.peers.a).status).toBe('ready');
    // 実際は約 7.5 秒（b が接続から 9 秒たつまで引き継がないため）
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(3000);
  });

  // 修正後に skip を外す（QA-BUG-01 の別パターン）
  it('QA-BUG-01: ホストのリロードの 1 秒後に参加者もリロードしても、「見つかりません」を出さずに 3 秒以内に戻る', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.a.reload();
    room.settle(1000);
    room.peers.b.reload();
    const t0 = room.sim.clock.now();
    const seen = new Set<string>();
    room.sim.clock.runUntil(() => {
      seen.add(snap(room.peers.b).status);
      return snap(room.peers.a).status === 'ready' && snap(room.peers.b).status === 'ready';
    }, 20000);
    // 実際は約 8.5 秒かかり、その間 b に「部屋が見つかりません」が出る
    expect(seen.has('notfound')).toBe(false);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(3000);
  });

  // 修正後に skip を外す（QA-BUG-01 の別パターン。E2E で観測：offline→online の直後にホストがタブを閉じると交代に約 7.8 秒）
  it('QA-BUG-01: 次のホスト候補がタブ復帰（resume）した直後でも、ホストの bye から 1 秒以内に交代する（AC-25）', () => {
    const room = readyRoom(['a', 'b', 'c']);
    start(room, 'a', 'counter');
    room.peers.b.engine.resume();
    room.settle(1000);
    room.peers.a.engine.dispose();
    const t0 = room.sim.clock.now();
    room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 15000);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(1000);
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-02）
  it.skip('QA-BUG-02: 2 人の部屋で 2 人ともほぼ同時にリロードしても、部屋は失われない', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    room.peers.a.engine.dispatch(inc);
    room.settle(500);
    room.peers.a.reload();
    room.peers.b.reload();
    room.sim.clock.runUntil(() => snap(room.peers.a).status === 'ready' && snap(room.peers.b).status === 'ready', 15000);
    expect(snap(room.peers.a).status).toBe('ready');
    expect(snap(room.peers.b).status).toBe('ready');
    expect(counter(room.peers.b).count.a).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('QA: 同時操作・連打', () => {
  it('10 人部屋で全員が同じ瞬間に提出しても、全員クリア扱いになり、締め切りが短縮されて結果へ進む', () => {
    const ids = Array.from({ length: MAX_ROOM_PLAYERS }, (_, i) => `p${i}`);
    const room = readyRoom(ids, { cond: { latencyMs: 50, jitterMs: 100 } });
    start(room, 'p0', 'rush');
    const r0 = rush(room.peers.p0);
    room.sim.clock.runUntil(() => room.peers.p0.engine.now() >= r0.round.startAt + 300, 10000, 1);
    for (const id of ids) room.peers[id].engine.dispatch(submit(true));
    expect(room.sim.clock.runUntil(() => rush(room.peers.p0).phase === 'result', 5000)).toBe(true);
    // 全員そろったので、締め切り（endsAt）まで待たずに判定へ進んでいる
    expect(room.peers.p0.engine.now()).toBeLessThan(r0.round.endsAt);
    room.settle(1000);
    for (const id of ids) {
      const r = rush(room.peers[id]);
      expect(r.lastFailed).toEqual([]);
      expect(Object.values(r.cleared)).toEqual(ids.map(() => 1));
    }
  });

  it('参加者が submit を連打（同じステージで 5 回）しても、最初の結果だけが採用される', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'rush');
    const r0 = rush(room.peers.a);
    room.sim.clock.runUntil(() => room.peers.b.engine.now() >= r0.round.startAt + 300, 10000, 1);
    room.peers.b.engine.dispatch(submit(true));
    for (let i = 0; i < 4; i++) room.peers.b.engine.dispatch(submit(false));
    room.settle(1000);
    expect(rush(room.peers.a).round.results.b?.success).toBe(true);
  });

  it('ホストがスタートを 0.2 秒おきに 5 回押しても、ゲームは 1 回だけ始まる。1.5 秒後の「もう一度」は効く', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.a.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
    for (let i = 0; i < 5; i++) {
      room.peers.a.engine.dispatch({ type: 'startGame', online: ['a', 'b'] });
      room.settle(200);
    }
    const first = stateOf(room.peers.b).game?.startedAt;
    expect(first).toBeDefined();
    expect(stateOf(room.peers.a).chat.filter((m) => m.by === null && m.text.includes('開始しました'))).toHaveLength(1);
    room.settle(1500);
    room.peers.a.engine.dispatch({ type: 'startGame', online: ['a', 'b'] });
    room.settle(500);
    expect(stateOf(room.peers.b).game?.startedAt).not.toBe(first);
  });

  it('2 人が同時にチャットしても、両方とも全員に届く（遅延 300ms）', () => {
    const room = readyRoom(['a', 'b', 'c'], { cond: { latencyMs: 300 } });
    room.peers.b.engine.dispatch({ type: 'chat', text: 'B です' });
    room.peers.c.engine.dispatch({ type: 'chat', text: 'C です' });
    room.settle(2000);
    for (const id of ['a', 'b', 'c']) {
      const texts = stateOf(room.peers[id]).chat.filter((m) => m.by !== null).map((m) => m.text);
      expect(texts.sort()).toEqual(['B です', 'C です']);
    }
  });

  it('参加者がチャットを連打（1 秒で 10 件）しても追加は 3 件までで、ブロック解除後の発言は通る', () => {
    const room = readyRoom(['a', 'b']);
    for (let i = 0; i < 10; i++) {
      room.peers.b.engine.dispatch({ type: 'chat', text: `連投${i}` });
      room.settle(100);
    }
    room.settle(1000);
    expect(stateOf(room.peers.a).chat.filter((m) => m.by === 'b')).toHaveLength(3);
    room.settle(3000);
    room.peers.b.engine.dispatch({ type: 'chat', text: '解除後' });
    room.settle(500);
    expect(stateOf(room.peers.b).chat.at(-1)?.text).toBe('解除後');
  });
});

// ---------------------------------------------------------------------------
describe('QA: タイムアウト・切断', () => {
  it('ラッシュのステージ中ずっと切断していた参加者は失敗扱い、他の人の進行は止まらない（F9 の仕様どおり）', () => {
    const room = readyRoom(['a', 'b', 'c']);
    const bots = ['a', 'b'].map((id) => rushBot(room.peers[id], { success: true, delayMs: 300 }));
    start(room, 'a', 'rush');
    room.peers.c.node.disconnect();
    expect(room.sim.clock.runUntil(() => rush(room.peers.a).phase === 'result', 20000)).toBe(true);
    expect(rush(room.peers.a).lastFailed).toEqual(['c']);
    room.peers.c.node.restore();
    expect(room.sim.clock.runUntil(() => room.converged(), 3000)).toBe(true);
    expect(snap(room.peers.c).connection).toBe('connected');
    bots.forEach((s) => s());
  });

  it('切断中に提出した submit は、締め切り前に復帰すれば成功扱いになる（E-01）', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'rush');
    const r0 = rush(room.peers.a);
    room.sim.clock.runUntil(() => room.peers.b.engine.now() >= r0.round.startAt + 200, 10000, 1);
    room.peers.b.node.disconnect();
    room.peers.b.engine.dispatch(submit(true));
    room.settle(1500);
    room.peers.b.node.restore();
    expect(room.sim.clock.runUntil(() => rush(room.peers.a).phase === 'result', 20000)).toBe(true);
    expect(rush(room.peers.a).lastFailed).toEqual(['a']);
    expect(rush(room.peers.a).cleared.b).toBe(1);
  });

  it('初回接続がずっと失敗する端末は failed、retry 後に通信が戻れば入室できる（AC-06 の engine 側）', () => {
    const room = readyRoom(['a']);
    const z = room.addPeer('z');
    z.node.failConnects(1000);
    room.settle(40000);
    expect(snap(z).status).toBe('failed');
    z.node.failConnects(0);
    z.engine.retry();
    expect(room.sim.clock.runUntil(() => snap(z).status === 'ready' && stateOf(room.peers.a).players.some((p) => p.id === 'z'), 3000)).toBe(true);
  });

  it('参加者が 30 秒オフラインのあいだもホストは交代せず、戻った参加者は最新状態に追いつく（E-02）', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    room.peers.b.node.disconnect();
    for (let i = 0; i < 5; i++) room.peers.a.engine.dispatch(inc);
    room.settle(30000);
    expect(snap(room.peers.b).connection).toBe('reconnecting');
    expect(snap(room.peers.b).status).toBe('ready');
    room.peers.b.node.restore();
    expect(room.sim.clock.runUntil(() => counter(room.peers.b).count.a === 5, 2000)).toBe(true);
    expect(room.hostIds()).toEqual(['a', 'a']);
  });
});

// ---------------------------------------------------------------------------
describe('QA: 途中参加・満員・外された人', () => {
  it('AC-33（自動）: ゲーム中に参加した人は players に入るが game.players には入らず、ゲーム操作は無視される。次のゲームでは参加者になる', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    const late = room.addPeer('late');
    expect(room.sim.clock.runUntil(() => snap(late).status === 'ready' && stateOf(late).players.some((p) => p.id === 'late'), 3000)).toBe(true);
    expect(stateOf(late).game?.players.map((p) => p.id)).toEqual(['a', 'b']);
    late.engine.dispatch(inc);
    room.settle(2000);
    expect(counter(room.peers.a).count.late).toBeUndefined();
    // 操作は受け付けた（acks は進む）ので、途中参加者が再送し続けることはない
    expect(stateOf(room.peers.a).acks.late).toBe(1);
    room.settle(START_GUARD_MS);
    room.peers.a.engine.dispatch({ type: 'startGame', online: [...snap(room.peers.a).online] });
    room.settle(500);
    expect(stateOf(late).game?.players.map((p) => p.id)).toEqual(['a', 'b', 'late']);
  });

  it('欠落 20% の通信でも、11 人目は満員になり、部屋には入らず、満員判定後は join を送らない', () => {
    const ids = Array.from({ length: MAX_ROOM_PLAYERS }, (_, i) => `p${i}`);
    const room = createSimRoom({ ids, cond: { latencyMs: 30, jitterMs: 200, lossRate: 0.2 }, seed: 7 });
    expect(room.sim.clock.runUntil(() => stateOf(room.peers.p0)?.players.length === MAX_ROOM_PLAYERS, 30000)).toBe(true);
    const extra = room.addPeer('zz');
    expect(room.sim.clock.runUntil(() => snap(extra).status === 'full', 10000)).toBe(true);
    const t0 = room.sim.clock.now();
    room.settle(20000);
    expect(snap(extra).status).toBe('full');
    expect(room.sent('zz', 'join', t0)).toHaveLength(0);
    expect(stateOf(room.peers.p0).players.map((p) => p.id)).not.toContain('zz');
    expect(new Set(room.hostIds()).size).toBe(1);
  });

  it('8 人の部屋に 4 人が同時に入ろうとしても、入れるのは 10 人まで。あふれた 2 人は満員になる', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const room = readyRoom(ids);
    const newcomers = ['x1', 'x2', 'x3', 'x4'].map((id) => room.addPeer(id));
    room.settle(5000);
    expect(stateOf(room.peers.p0).players).toHaveLength(MAX_ROOM_PLAYERS);
    const statuses = newcomers.map((p) => snap(p).status).sort();
    expect(statuses).toEqual(['full', 'full', 'ready', 'ready']);
    // 入れた 2 人は自分が players にいる
    for (const p of newcomers) {
      if (snap(p).status === 'ready') expect(stateOf(p).players.some((q) => q.id === p.id)).toBe(true);
    }
  });

  it('満員の部屋に空きが出ても、満員表示中の端末は勝手に入らない（以後 join を送らない仕様）', () => {
    const ids = Array.from({ length: MAX_ROOM_PLAYERS }, (_, i) => `p${i}`);
    const room = readyRoom(ids);
    const extra = room.addPeer('zz');
    expect(room.sim.clock.runUntil(() => snap(extra).status === 'full', 3000)).toBe(true);
    room.peers.p9.engine.leave();
    room.settle(5000);
    expect(snap(extra).status).toBe('full');
    expect(stateOf(room.peers.p0).players).toHaveLength(MAX_ROOM_PLAYERS - 1);
  });

  it('満員の端末は、ホストが落ちてもホストを引き継がない', () => {
    const ids = Array.from({ length: MAX_ROOM_PLAYERS }, (_, i) => `p${i}`);
    const room = readyRoom(ids);
    const extra = room.addPeer('zz');
    expect(room.sim.clock.runUntil(() => snap(extra).status === 'full', 3000)).toBe(true);
    room.peers.p0.engine.dispose();
    room.settle(15000);
    expect(snap(extra).isHost).toBe(false);
    expect(snap(room.peers.p1).isHost).toBe(true);
  });

  it('AC-34（自動の一部）: 外された人が入り直す（新しい engine・同じ ID）と、もう一度メンバーになれる', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.a.engine.dispatch({ type: 'kick', target: 'b' });
    room.settle(500);
    expect(snap(room.peers.b).status).toBe('kicked');
    // 「トップへ」→ 同じ部屋コードで入り直す（タブは同じなので ID とストレージも同じ）
    room.peers.b.reload();
    expect(room.sim.clock.runUntil(() => stateOf(room.peers.a).players.some((p) => p.id === 'b') && snap(room.peers.b).status === 'ready', 3000)).toBe(true);
    expect(snap(room.peers.b).status).toBe('ready');
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-04）
  it.skip('QA-BUG-04: 旧ホストだけが受け付けた参加者は、ホスト交代後に「外されました」にならず自動で入り直す', () => {
    const room = readyRoom(['a', 'b']);
    // x の参加を a が処理した状態が、b にだけ届かない
    let block = true;
    room.sim.dropWhere((m, from, to) => block && from === 'a' && to === 'b' && (m as Wire).t === 'state', Number.POSITIVE_INFINITY);
    const x = room.addPeer('x');
    room.settle(1000);
    expect(stateOf(x).players.map((p) => p.id)).toEqual(['a', 'b', 'x']);
    expect(stateOf(room.peers.b).players.map((p) => p.id)).toEqual(['a', 'b']);
    // その直後に a がタブを閉じる → b が x のいない状態で引き継ぐ
    room.peers.a.engine.dispose();
    block = false;
    room.settle(3000);
    // 実際は x が 'kicked'（「ホストにより部屋から外されました」）になり、以後何も送らない
    expect(snap(x).status).toBe('ready');
    expect(stateOf(room.peers.b).players.map((p) => p.id)).toContain('x');
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-05）
  it.skip('QA-BUG-05: 受信だけ止まった（ソケットは生きている）参加者が 30 秒後にホストを名乗っても、復帰後に部屋の進行を巻き戻さない（E-02）', () => {
    const room = readyRoom(['a', 'b']);
    start(room, 'a', 'counter');
    let cut = true;
    room.sim.dropWhere((_m, from, to) => cut && (from === 'b' || to === 'b'), Number.POSITIVE_INFINITY);
    for (let i = 0; i < 60; i++) {
      room.peers.a.engine.dispatch(inc);
      room.settle(1000);
    }
    // 孤立した b は ADR-7 の 30 秒待ちのあと epoch 2 でホストを名乗っている
    expect(snap(room.peers.b).isHost).toBe(true);
    cut = false;
    room.settle(5000);
    expect(room.converged()).toBe(true);
    // 実際は b の古い状態（epoch 2）が a の進行（epoch 1・60 回）を上書きし、a のカウントが消える
    expect(counter(room.peers.a).count.a).toBe(60);
  });

  // 修正後に skip を外す（docs/dev/04-qa-report.md QA-BUG-03）
  it.skip('QA-BUG-03: （AC-35, Should）既存の部屋と同じコードで部屋を作っても、既存の部屋の状態は上書きされない', () => {
    // 既存の部屋：ホスト m（ID が大きい）と参加者 n
    const room = createSimRoom({ ids: ['m', 'n'] });
    room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
    room.peers.m.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
    room.peers.m.engine.dispatch({ type: 'startGame', online: ['m', 'n'] });
    room.settle(500);
    const before = stateOf(room.peers.n);
    // 別の人（ID が小さい）が同じコードで「部屋を作る」
    room.addPeer('a', true);
    room.settle(3000);
    expect(stateOf(room.peers.n).hostId).toBe('m');
    expect(stateOf(room.peers.n).game?.startedAt).toBe(before.game?.startedAt);
  });
});
