import { describe, expect, it } from 'vitest';
import { MAX_ROOM_PLAYERS, type RoomState } from '../room/logic';
import { ROOM_TIMINGS } from '../room/engine';
import type { RushState } from '../games/rush/logic';
import { createSimRoom, rushBot, type CounterState, type SimPeer } from './sim/harness';

// 疑似ネットワーク上のシナリオテスト（設計 §6.4）。時刻は SimClock だけを使い、乱数はシード固定なので毎回同じ結果になる
const snap = (p: SimPeer) => p.engine.getSnapshot();
const stateOf = (p: SimPeer) => snap(p).state as RoomState;
const counter = (p: SimPeer) => stateOf(p).game?.state as CounterState;
const inc = { type: 'game', action: { type: 'inc' } } as const;

// 全員が入り、引き継ぎ判定の猶予（接続から 9 秒）も過ぎた部屋
const readyRoom = (ids: string[], opts: Parameters<typeof createSimRoom>[0] extends infer O ? Partial<O> : never = {}) => {
  const room = createSimRoom({ ids, ...opts });
  room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  for (const id of ids) {
    expect(snap(room.peers[id]).status).toBe('ready');
    expect(stateOf(room.peers[id]).players.map((p) => p.id)).toEqual(ids);
  }
  return room;
};

const startCounter = (room: ReturnType<typeof createSimRoom>, host: string) => {
  room.peers[host].engine.dispatch({ type: 'selectGame', gameId: 'counter' });
  room.peers[host].engine.dispatch({ type: 'startGame', online: Object.keys(room.peers) });
  room.settle(500);
};

describe('起動と参加（B-15）', () => {
  it('部屋を作るとホストになり、他の人が入ってくる', () => {
    const room = createSimRoom({ ids: ['a', 'b', 'c'] });
    expect(room.sim.clock.runUntil(() => room.converged() && stateOf(room.peers.a).players.length === 3, 3000)).toBe(true);
    expect(room.hostIds()).toEqual(['a', 'a', 'a']);
    expect(snap(room.peers.a).isHost).toBe(true);
    expect(snap(room.peers.b).isHost).toBe(false);
    expect(snap(room.peers.b).online.has('a')).toBe(true);
  });

  it('参加者の操作はホストに届いて全員に反映される', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.b.engine.dispatch({ type: 'chat', text: 'こんにちは' });
    room.settle(500);
    expect(stateOf(room.peers.a).chat.at(-1)?.text).toBe('こんにちは');
    expect(stateOf(room.peers.b).chat.at(-1)?.text).toBe('こんにちは');
    expect(stateOf(room.peers.b).acks.b).toBe(1);
  });

  it('AC-08: 片道 200ms の遅延で、リロードしたメンバーが 1.5 秒以内に元の画面に戻る', () => {
    const room = readyRoom(['a', 'b'], { cond: { latencyMs: 200 } });
    startCounter(room, 'a');
    room.settle(2000);
    const before = stateOf(room.peers.a);
    room.peers.b.reload();
    expect(snap(room.peers.b).state).toBeNull();
    const ok = room.sim.clock.runUntil(() => snap(room.peers.b).status === 'ready', 1500);
    expect(ok).toBe(true);
    expect(stateOf(room.peers.b).game?.startedAt).toBe(before.game?.startedAt);
    expect(stateOf(room.peers.b).hostId).toBe('a');
  });

  it('AC-09: 再接続直後とタブ復帰直後に同期要求を送り、ホストは即座に返す。同じ相手には 1 秒に 1 回まで', () => {
    const room = readyRoom(['a', 'b']);
    // 再接続直後
    room.peers.b.node.disconnect();
    room.settle(1000);
    const t0 = room.sim.clock.now();
    room.peers.b.node.restore();
    room.settle(100);
    expect(room.sent('b', 'sync', t0)).toHaveLength(1);
    expect(room.sent('a', 'state', t0).length).toBeGreaterThanOrEqual(1);

    // 前の返信から 1 秒以上あけ、ホストの定期配信の直後にそろえてから、タブ復帰を 5 回（100ms おき）
    room.settle(1500);
    expect(room.sim.clock.runUntil(() => room.sim.log.at(-1)?.from === 'a', 3000, 1)).toBe(true);
    room.settle(300);
    const t1 = room.sim.clock.now();
    for (let i = 0; i < 5; i++) {
      room.peers.b.engine.resume();
      room.settle(100);
    }
    expect(room.sent('b', 'sync', t1)).toHaveLength(5);
    const replies = room.sent('a', 'state', t1).filter((e) => e.at < t1 + 900);
    expect(replies).toHaveLength(1);
    // 返信は同期要求が届いてから間引き（200ms）以内
    expect(replies[0].at - t1).toBeLessThanOrEqual(ROOM_TIMINGS.STATE_THROTTLE_MS + 50);
  });

  it('AC-10: 状態が来ないまま 8 秒で notfound、接続自体ができなければ failed（区別される）', () => {
    // ホスト（ids[0]）がいない部屋に参加者だけが来る
    const room = createSimRoom({ ids: ['host'], joinAll: false });
    room.peers.host.engine.dispose();
    const b = room.addPeer('b');
    const z = room.addPeer('z');
    z.node.failConnects(100);
    room.settle(ROOM_TIMINGS.JOIN_TIMEOUT_MS - 500);
    expect(snap(b).status).toBe('connecting');
    room.settle(1000);
    expect(snap(b).status).toBe('notfound');
    expect(snap(b).connection).toBe('connected');
    room.settle(30000);
    expect(snap(z).status).toBe('failed');
    expect(snap(z).connection).toBe('failed');
    expect(snap(b).status).toBe('notfound');
  });

  it('notfound / failed から retry() で（ページを読み直さずに）入り直せる', () => {
    const room = createSimRoom({ ids: ['a'] });
    const b = room.addPeer('b');
    b.node.failConnects(4);
    room.settle(40000);
    expect(snap(b).status).toBe('failed');
    b.engine.retry();
    expect(snap(b).status).toBe('connecting');
    expect(room.sim.clock.runUntil(() => snap(b).status === 'ready' && stateOf(b).players.some((p) => p.id === 'b'), 3000)).toBe(true);
  });

  it('AC-18: 1 秒に 50 回状態が変わっても配信は 1 秒あたり 10 件以下で、最後の状態は必ず届く', () => {
    const room = readyRoom(['a', 'b']);
    startCounter(room, 'a');
    room.settle(1000);
    const t0 = room.sim.clock.now();
    for (let i = 0; i < 50; i++) {
      room.peers.a.engine.dispatch(inc);
      room.settle(20);
    }
    const sent = room.sent('a', 'state', t0).filter((e) => e.at < t0 + 1000);
    expect(sent.length).toBeLessThanOrEqual(10);
    room.settle(500);
    expect(counter(room.peers.a).count.a).toBe(50);
    expect(counter(room.peers.b).count.a).toBe(50);
    expect(stateOf(room.peers.b).version).toBe(stateOf(room.peers.a).version);
  });

  it('AC-30: ひとりだけの部屋でホストがリロードしても、ロビーの選択やゲーム進行が元どおりに戻る', () => {
    const room = createSimRoom({ ids: ['a'] });
    room.settle(500);
    room.peers.a.engine.dispatch({ type: 'selectGame', gameId: 'counter' });
    room.peers.a.engine.dispatch({ type: 'startGame', online: ['a'] });
    room.peers.a.engine.dispatch(inc);
    room.peers.a.engine.dispatch(inc);
    room.settle(500);
    const before = stateOf(room.peers.a);
    room.peers.a.reload();
    expect(room.sim.clock.runUntil(() => snap(room.peers.a).status === 'ready', ROOM_TIMINGS.RESTORE_AFTER_MS + 1000)).toBe(true);
    const after = stateOf(room.peers.a);
    expect(after.hostId).toBe('a');
    expect(after.selectedGame).toBe('counter');
    expect(after.game?.startedAt).toBe(before.game?.startedAt);
    expect((after.game?.state as CounterState).count.a).toBe(2);
    expect(after.epoch).toBe(before.epoch + 1);
  });

  it('生きている部屋では、リロードした参加者がスナップショットで部屋を巻き戻さない', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.b.reload();
    room.settle(ROOM_TIMINGS.RESTORE_AFTER_MS + 2000);
    expect(room.hostIds()).toEqual(['a', 'a']);
    expect(stateOf(room.peers.b).epoch).toBe(stateOf(room.peers.a).epoch);
  });

  it('AC-31: 10 人の部屋に 11 人目が入ろうとすると full になり、以後 join を送らない', () => {
    const ids = Array.from({ length: MAX_ROOM_PLAYERS }, (_, i) => `p${i}`);
    const room = createSimRoom({ ids });
    room.settle(5000);
    expect(stateOf(room.peers.p0).players).toHaveLength(MAX_ROOM_PLAYERS);
    const extra = room.addPeer('zz');
    expect(room.sim.clock.runUntil(() => snap(extra).status === 'full', 3000)).toBe(true);
    const t0 = room.sim.clock.now();
    room.settle(20000);
    expect(snap(extra).status).toBe('full');
    expect(room.sent('zz', 'join', t0)).toHaveLength(0);
    expect(stateOf(room.peers.p0).players.map((p) => p.id)).not.toContain('zz');
  });

  it('外された人は kicked になり、以後送らない', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.a.engine.dispatch({ type: 'kick', target: 'b' });
    room.settle(500);
    expect(snap(room.peers.b).status).toBe('kicked');
    const t0 = room.sim.clock.now();
    room.settle(10000);
    expect(room.sim.log.filter((e) => e.from === 'b' && e.at >= t0)).toHaveLength(0);
  });

  it('退出すると left になり、ホストが退出するとオンラインの人に譲る', () => {
    const room = readyRoom(['a', 'b', 'c']);
    room.peers.c.engine.leave();
    room.settle(500);
    expect(snap(room.peers.c).status).toBe('left');
    expect(stateOf(room.peers.a).players.map((p) => p.id)).toEqual(['a', 'b']);
    room.peers.a.engine.leave();
    room.settle(500);
    expect(snap(room.peers.a).status).toBe('left');
    expect(stateOf(room.peers.b).hostId).toBe('b');
    expect(snap(room.peers.b).isHost).toBe(true);
    expect(stateOf(room.peers.b).players.map((p) => p.id)).toEqual(['b']);
  });
});

type Wire = { t?: string; seq?: number; action?: { type?: string; action?: { type?: string } } };
const isAction = (m: unknown) => (m as Wire).t === 'action';
const isSubmit = (m: unknown) => isAction(m) && (m as Wire).action?.type === 'game' && (m as Wire).action?.action?.type === 'submit';
const rush = (p: SimPeer) => stateOf(p).game?.state as RushState;

const startRush = (room: ReturnType<typeof createSimRoom>, host: string) => {
  room.peers[host].engine.dispatch({ type: 'selectGame', gameId: 'rush' });
  room.peers[host].engine.dispatch({ type: 'startGame', online: Object.keys(room.peers) });
  room.settle(300);
  for (const p of Object.values(room.peers)) expect(stateOf(p).game?.id).toBe('rush');
};

describe('連番・再送・受付上限（B-16）', () => {
  it('AC-11: 参加者のアクションが 1 回欠落しても、1〜2 秒後の再送でホストに 1 回だけ適用される', () => {
    const room = readyRoom(['a', 'b']);
    startCounter(room, 'a');
    room.sim.dropWhere((m, from, to) => isAction(m) && from === 'b' && to === 'a', 1);
    const t0 = room.sim.clock.now();
    room.peers.b.engine.dispatch(inc);
    room.settle(900);
    expect(counter(room.peers.a).count.b).toBeUndefined();
    expect(room.sim.clock.runUntil(() => counter(room.peers.a).count.b === 1, 1200)).toBe(true);
    expect(room.sim.clock.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(2000);
    room.settle(5000);
    expect(counter(room.peers.a).count.b).toBe(1);
    expect(counter(room.peers.b).count.b).toBe(1);
    // 確認できたら再送をやめる
    const sends = room.sim.log.filter((e) => e.from === 'b' && isAction(e.msg));
    expect(sends).toHaveLength(2);
  });

  it('AC-14: 送信から 10 秒以上たった未確認アクションは再送されない', () => {
    const room = readyRoom(['a', 'b']);
    startCounter(room, 'a');
    let cut = true;
    room.sim.dropWhere((m, from) => cut && isAction(m) && from === 'b', Number.POSITIVE_INFINITY);
    const t0 = room.sim.clock.now();
    room.peers.b.engine.dispatch(inc);
    room.settle(15000);
    const sends = room.sim.log.filter((e) => e.from === 'b' && isAction(e.msg));
    expect(sends.length).toBeGreaterThan(3);
    expect(sends.every((e) => e.at - t0 < ROOM_TIMINGS.PENDING_TTL_MS)).toBe(true);
    cut = false;
    room.settle(5000);
    expect(counter(room.peers.a).count.b).toBeUndefined();
  });

  it('AC-16: ラッシュの submit が最初の送信で欠落しても、締め切り前の再送で成功扱いになる', () => {
    const room = readyRoom(['a', 'b']);
    const bots = ['a', 'b'].map((id) => rushBot(room.peers[id], { success: true, delayMs: 500 }));
    room.sim.dropWhere((m, from) => isSubmit(m) && from === 'b', 1);
    startRush(room, 'a');
    const start = rush(room.peers.a);
    expect(room.sim.clock.runUntil(() => rush(room.peers.a).phase === 'result', 20000)).toBe(true);
    const after = rush(room.peers.a);
    expect(after.cleared).toEqual({ a: 1, b: 1 });
    expect(after.lives).toEqual(start.lives);
    // 欠落した 1 回のあと再送された
    expect(room.sim.log.filter((e) => e.from === 'b' && isSubmit(e.msg)).length).toBeGreaterThanOrEqual(2);
    bots.forEach((stop) => stop());
  });

  it('AC-19: 1 人から 1 秒に 30 件届いても処理は 10 件以下、他の人の操作は通常どおり処理される', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startCounter(room, 'a');
    for (let i = 0; i < 30; i++) room.peers.b.engine.dispatch(inc);
    room.peers.c.engine.dispatch(inc);
    room.settle(900);
    expect(counter(room.peers.a).count.b).toBeLessThanOrEqual(ROOM_TIMINGS.ACTION_RATE.count);
    expect(counter(room.peers.a).count.c).toBe(1);
    // 捨てた分は acks を進めないので、本人の再送で後から届く（操作は失われない）
    room.settle(5000);
    expect(counter(room.peers.a).count.b).toBe(30);
  });

  it('AC-23: submit を 1 回 dispatch すると、通信に流れる action は同じ seq のもの（再送を含む）だけ', () => {
    const room = readyRoom(['a', 'b']);
    startRush(room, 'a');
    // 確実に再送も起きるよう、最初の 2 回を落とす
    room.sim.dropWhere((m, from) => isSubmit(m) && from === 'b', 2);
    const t0 = room.sim.clock.now();
    room.peers.b.engine.dispatch({ type: 'game', action: { type: 'submit', result: { score: 20, success: true } } });
    room.settle(5000);
    const sends = room.sim.log.filter((e) => e.from === 'b' && e.at >= t0 && isAction(e.msg));
    expect(sends.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sends.map((e) => (e.msg as Wire).seq)).size).toBe(1);
    expect(rush(room.peers.a).round.results.b).toEqual({ score: 20, success: true });
  });
});

const hostIs = (room: ReturnType<typeof createSimRoom>, host: string, ids: string[]) => () =>
  ids.every((id) => snap(room.peers[id]).state?.hostId === host);

describe('ホスト交代・復帰（B-17）', () => {
  it('AC-24: ホストが無通信になって 12 秒以内に参加順で最古のオンラインメンバーが新ホストになり、ゲームのタイマーが再開する', () => {
    const room = readyRoom(['a', 'b', 'c']);
    const bots = ['b', 'c'].map((id) => rushBot(room.peers[id], { success: true, delayMs: 500 }));
    startRush(room, 'a');
    room.settle(1000);
    room.peers.a.node.freeze();
    const t0 = room.sim.clock.now();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 12000)).toBe(true);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(12000);
    expect(snap(room.peers.b).isHost).toBe(true);
    const stage = rush(room.peers.b).stage;
    // 新ホストのタイマーでステージが進む
    expect(room.sim.clock.runUntil(() => rush(room.peers.c).stage > stage, 20000)).toBe(true);
    bots.forEach((stop) => stop());
  });

  it('AC-25: ホストの bye を受けてから 1 秒以内に新ホストが決まる', () => {
    const room = readyRoom(['a', 'b', 'c']);
    room.peers.a.engine.dispose();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 1000)).toBe(true);
  });

  it('AC-26: 2 人が同じ世代で同時にホストを引き継いでも、3 秒以内に全員のホストが 1 人に一致する', () => {
    const room = readyRoom(['a', 'b', 'c', 'd']);
    // b と c の間だけ通信が切れた状態でホストが落ちる → b も c も「自分が次のホスト」と判断する
    let cut = true;
    room.sim.dropWhere((_m, from, to) => cut && ((from === 'b' && to === 'c') || (from === 'c' && to === 'b')), Number.POSITIVE_INFINITY);
    room.peers.a.node.freeze();
    expect(
      room.sim.clock.runUntil(() => snap(room.peers.b).isHost && snap(room.peers.c).isHost, 15000),
    ).toBe(true);
    expect(stateOf(room.peers.b).epoch).toBe(stateOf(room.peers.c).epoch);
    cut = false;
    const t0 = room.sim.clock.now();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c', 'd']), 3000)).toBe(true);
    expect(room.sim.clock.now() - t0).toBeLessThanOrEqual(3000);
    expect(snap(room.peers.c).isHost).toBe(false);
    room.settle(3000);
    expect(room.converged(['b', 'c', 'd'])).toBe(true);
  });

  it('二重ホストで負けた側が処理した操作は、勝った側へ再送されて失われない', () => {
    const room = readyRoom(['a', 'b', 'c', 'd']);
    startCounter(room, 'a');
    let cut = true;
    room.sim.dropWhere((_m, from, to) => cut && ((from === 'b' && to === 'c') || (from === 'c' && to === 'b')), Number.POSITIVE_INFINITY);
    room.peers.a.node.freeze();
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost && snap(room.peers.c).isHost, 15000)).toBe(true);
    // d の操作は c（負ける側）にだけ届く
    let toB = true;
    room.sim.dropWhere((m, from, to) => toB && isAction(m) && from === 'd' && to === 'b', Number.POSITIVE_INFINITY);
    room.peers.d.engine.dispatch(inc);
    room.settle(300);
    expect(counter(room.peers.c).count.d).toBe(1);
    expect(counter(room.peers.b).count.d).toBeUndefined();
    toB = false;
    cut = false;
    expect(room.sim.clock.runUntil(() => room.converged(['b', 'c', 'd']) && counter(room.peers.b).count.d === 1, 5000)).toBe(true);
    expect(stateOf(room.peers.d).hostId).toBe('b');
  });

  it('AC-27: 復帰した旧ホストは新しい世代を受けた時点でホストでなくなり、以後状態を配らない', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startRush(room, 'a');
    room.settle(500);
    room.peers.a.node.freeze();
    expect(room.sim.clock.runUntil(hostIs(room, 'b', ['b', 'c']), 12000)).toBe(true);
    room.settle(5000);
    const newer = stateOf(room.peers.c);
    // 旧ホストの復帰：溜まっていたタイマーが先に動いて古い世代を配っても無視される
    room.peers.a.node.thaw();
    room.peers.a.engine.resume();
    expect(room.sim.clock.runUntil(() => snap(room.peers.a).state?.hostId === 'b', 3000)).toBe(true);
    expect(snap(room.peers.a).isHost).toBe(false);
    expect(stateOf(room.peers.c).epoch).toBeGreaterThanOrEqual(newer.epoch);
    expect(stateOf(room.peers.c).hostId).toBe('b');
    const t0 = room.sim.clock.now();
    room.settle(15000);
    expect(room.sent('a', 'state', t0)).toHaveLength(0);
    expect(room.hostIds()).toEqual(['b', 'b', 'b']);
  });

  it('AC-28: 引き継いだ時点で予定時刻を過ぎていたタイマーは即時実行される', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startCounter(room, 'a');
    // 発火予定（開始 1 秒後）の前にホストが止まる
    expect(counter(room.peers.a).fired).toBe(false);
    room.peers.a.node.freeze();
    room.settle(3000);
    // 予定時刻は過ぎたが、止まったホストのタイマーは動かない
    expect(counter(room.peers.b).fired).toBe(false);
    // 1ms 刻みで進め、引き継いだのと同じ瞬間に発火していることを確かめる
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost, 12000, 1)).toBe(true);
    expect(counter(room.peers.b).fired).toBe(true);
    room.settle(500);
    expect(counter(room.peers.c).fired).toBe(true);
  });

  it('引き継いだホストは、送り先を失った自分の未確認の操作を自分で適用する', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startCounter(room, 'a');
    room.peers.a.node.freeze();
    room.settle(500);
    room.peers.b.engine.dispatch(inc);
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost, 12000)).toBe(true);
    expect(counter(room.peers.b).count.b).toBe(1);
    room.settle(500);
    expect(counter(room.peers.c).count.b).toBe(1);
  });

  it('AC-29: ホストがリロードしてもゲームは初期化されず、本人は参加者として 3 秒以内に戻る', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startCounter(room, 'a');
    room.peers.a.engine.dispatch(inc);
    room.settle(500);
    const startedAt = stateOf(room.peers.b).game?.startedAt;
    room.peers.a.reload();
    expect(
      room.sim.clock.runUntil(
        () => snap(room.peers.a).status === 'ready' && hostIs(room, 'b', ['a', 'b', 'c'])(),
        3000,
      ),
    ).toBe(true);
    expect(snap(room.peers.a).isHost).toBe(false);
    for (const id of ['a', 'b', 'c']) {
      expect(stateOf(room.peers[id]).game?.startedAt).toBe(startedAt);
      expect(counter(room.peers[id]).count.a).toBe(1);
    }
  });

  it('AC-29: bye が欠けても、リロードしたホストからの sync で交代が始まる', () => {
    const room = readyRoom(['a', 'b', 'c']);
    startCounter(room, 'a');
    room.sim.dropWhere((m, from) => from === 'a' && (m as Wire).t === 'bye', Number.POSITIVE_INFINITY);
    room.peers.a.reload();
    expect(room.sim.clock.runUntil(() => snap(room.peers.a).status === 'ready' && hostIs(room, 'b', ['a', 'b', 'c'])(), 3000)).toBe(true);
  });

  it('自分しかオンラインにいないときは 30 秒待ってから引き継ぐ（ADR-7）', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.a.node.freeze();
    room.settle(20000);
    expect(snap(room.peers.b).state?.hostId).toBe('a');
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).isHost, 15000)).toBe(true);
  });

  it('スリープ明けの参加者は、古い lastSeen で誤ってホストを引き継がない', () => {
    const room = readyRoom(['a', 'b', 'c']);
    room.peers.b.node.freeze();
    room.settle(20000);
    // resume() は呼ばない：tick の間隔からスリープ明けを検知する
    room.peers.b.node.thaw();
    room.settle(15000);
    expect(room.hostIds()).toEqual(['a', 'a', 'a']);
    expect(stateOf(room.peers.b).epoch).toBe(1);
  });

  it('何も届かなくなったら 9 秒で張り直す（無通信検知）', () => {
    const room = readyRoom(['a', 'b']);
    const seen: string[] = [];
    room.peers.b.engine.subscribe(() => seen.push(snap(room.peers.b).connection));
    let cut = true;
    room.sim.dropWhere((_m, _from, to) => cut && to === 'b', Number.POSITIVE_INFINITY);
    room.settle(ROOM_TIMINGS.STALL_MS + 1000);
    expect(seen).toContain('reconnecting');
    cut = false;
    expect(room.sim.clock.runUntil(() => snap(room.peers.b).connection === 'connected', 2000)).toBe(true);
    room.settle(3000);
    expect(room.hostIds()).toEqual(['a', 'a']);
  });

  it('AC-07（engine）: 切断中も state と ready を保ち、connection だけが reconnecting になる', () => {
    const room = readyRoom(['a', 'b']);
    room.peers.b.node.disconnect();
    expect(snap(room.peers.b).status).toBe('ready');
    expect(snap(room.peers.b).connection).toBe('reconnecting');
    expect(snap(room.peers.b).state).not.toBeNull();
    // 切断中の操作は再接続後に届く
    room.peers.b.engine.dispatch({ type: 'chat', text: 'トンネル' });
    room.settle(3000);
    room.peers.b.node.restore();
    room.settle(500);
    expect(snap(room.peers.b).connection).toBe('connected');
    expect(stateOf(room.peers.a).chat.at(-1)?.text).toBe('トンネル');
  });
});
