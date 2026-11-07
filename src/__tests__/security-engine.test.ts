// Security（S-01 / S-02）：Broadcast 上の攻撃者を疑似ネットワークに入れて、engine の受信処理を攻める。
// 攻撃者は「同じ部屋のコードを知っていて、任意の JSON を任意の from で送れる端末」（開発者ツールを使う参加者・コードを推測した第三者）。
// 防げていないもの（要修正）は票 ID 付きの it.skip。票と許容リスクは docs/dev/05-security-report.md。
import { describe, expect, it } from 'vitest';
import type { Link } from '../lib/transport';
import { RoomEngine, ROOM_TIMINGS } from '../room/engine';
import type { RoomState } from '../room/logic';
import { createSimRoom, memoryStore, ROOM_CODE, SIM_GAMES, type SimPeer } from './sim/harness';
import { SimNetwork } from './sim/network';

const snap = (p: SimPeer) => p.engine.getSnapshot();
const stateOf = (p: SimPeer) => snap(p).state as RoomState;

// 全員が入り、引き継ぎ判定の猶予も過ぎた部屋に、攻撃者の Link を 1 本つなぐ
const attackedRoom = (ids = ['a', 'b', 'c']) => {
  const room = createSimRoom({ ids });
  room.settle(ROOM_TIMINGS.OFFLINE_AFTER_MS + 1000);
  const node = room.sim.node('evil');
  const inbox: unknown[] = [];
  const link: Link = node.linkFactory(ROOM_CODE, { onOpen: () => {}, onDown: () => {}, onMessage: (m) => inbox.push(m) });
  room.settle(100);
  const send = (msg: Record<string, unknown>) => link.send({ v: 2, ...msg });
  return { room, inbox, send, peers: room.peers };
};

describe('なりすまし・権限（S-01）', () => {
  it('ホストの ID を名乗ったアクションは、ホスト自身が「自分の送信」として捨てる', () => {
    const { room, send, peers } = attackedRoom();
    send({ t: 'action', from: 'a', seq: 1, action: { type: 'kick', target: 'b' } });
    send({ t: 'action', from: 'a', seq: 2, action: { type: 'startGame', online: ['a', 'b', 'c'] } });
    room.settle(500);
    expect(stateOf(peers.a).players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(stateOf(peers.a).game).toBeNull();
  });

  it('メンバーでない ID のアクション・gameSystem・版違い・別の部屋コードの状態は採用されない', () => {
    const { room, send, peers } = attackedRoom();
    const before = stateOf(peers.a);
    send({ t: 'action', from: 'evil', seq: 1, action: { type: 'chat', text: 'spam' } });
    send({ t: 'action', from: 'b', seq: 99, action: { type: 'gameSystem', action: { type: 'fire' } } });
    send({ v: 1, t: 'state', from: 'evil', state: { ...before, epoch: before.epoch + 5, hostId: 'evil' }, sentAt: 0 });
    send({ t: 'state', from: 'evil', state: { ...before, code: 'ZZZZ', epoch: before.epoch + 5, hostId: 'evil' }, sentAt: 0 });
    room.settle(500);
    for (const id of ['a', 'b', 'c']) {
      expect(stateOf(peers[id]).hostId).toBe('a');
      expect(stateOf(peers[id]).chat.some((m) => m.text === 'spam')).toBe(false);
    }
  });

  it('同期要求を 1 秒に 200 件（毎回違う ID）送っても、ホストの状態配信は間引かれて 1 秒 5〜6 件に収まる', () => {
    const { room, send } = attackedRoom();
    const t0 = room.sim.clock.now();
    for (let i = 0; i < 200; i++) {
      send({ t: 'sync', from: `x${i}` });
      room.settle(5);
    }
    const states = room.sent('a', 'state', t0).filter((e) => e.at < t0 + 1000);
    expect(states.length).toBeLessThanOrEqual(6);
  });

  it('1 人の ID で 1 秒に 100 件のアクションを送っても、ホストが処理するのは 10 件以下', () => {
    const { room, send, peers } = attackedRoom();
    const base = stateOf(peers.a).acks.b ?? 0;
    for (let i = 1; i <= 100; i++) send({ t: 'action', from: 'b', seq: base + i, action: { type: 'selectGame', gameId: 'rush' } });
    room.settle(900);
    expect(stateOf(peers.a).acks.b - base).toBeLessThanOrEqual(10);
  });

  it('（許容リスク R-02 の確認）epoch を 1 つ進めた偽の状態を送ると、誰でもホストを名乗れる', () => {
    // 状態に署名がなく from も自己申告なので、サーバーなし構成では防げない（報告書 R-02）
    const { room, send, peers } = attackedRoom();
    const cur = stateOf(peers.a);
    // 第三者（evil）が c をホストにした状態を送る。ホストだった a も含め全員が採用し、c がホストとして動き出す
    send({ t: 'state', from: 'evil', state: { ...cur, epoch: cur.epoch + 1, hostId: 'c', chat: [] }, sentAt: 0 });
    room.settle(500);
    expect(room.hostIds()).toEqual(['c', 'c', 'c']);
  });
});

describe('SEC-01: 巨大な epoch / version の偽の状態 1 通で部屋が壊れる', () => {
  it('SEC-01: version = MAX_SAFE_INTEGER の偽の状態のあとも、ホストの変更が参加者に届く', () => {
    // 現状：全員（ホストも）が偽の状態を採用し、ホストの次の version（MAX_SAFE_INTEGER + 1）が
    // parseRoomState の「安全な整数」検査で全員に捨てられる。以後この部屋の変更は誰にも届かない
    const { room, send, peers } = attackedRoom();
    const cur = stateOf(peers.a);
    send({ t: 'state', from: 'a', state: { ...cur, version: Number.MAX_SAFE_INTEGER }, sentAt: 0 });
    room.settle(500);
    peers.a.engine.dispatch({ type: 'chat', text: 'まだ届く？' });
    room.settle(3000);
    expect(stateOf(peers.b).chat.at(-1)?.text).toBe('まだ届く？');
    expect(stateOf(peers.c).chat.at(-1)?.text).toBe('まだ届く？');
  });

  it('SEC-01: epoch = MAX_SAFE_INTEGER の偽の状態のあとも、ホスト交代で全員が新ホストにそろう', () => {
    // 現状：ホストが去ると引き継いだ人の epoch が MAX_SAFE_INTEGER + 1 になり、他の全員に捨てられて部屋が割れる
    const { room, send, peers } = attackedRoom();
    const cur = stateOf(peers.a);
    send({ t: 'state', from: 'a', state: { ...cur, epoch: Number.MAX_SAFE_INTEGER }, sentAt: 0 });
    room.settle(500);
    peers.a.engine.leave();
    room.settle(5000);
    expect(room.converged(['b', 'c'])).toBe(true);
    expect(stateOf(peers.c).hostId).toBe('b');
  });
});

describe('SEC-04: 未知のゲーム ID を含む状態', () => {
  it('SEC-04: selectedGame / game.id が登録にない（constructor・__proto__ を含む）状態は採用しない', () => {
    // 現状：parseRoomState は文字列であることしか見ないので採用され、Room.tsx の Lobby が GAMES[selectedGame].id で
    // 例外を投げ、エラー境界がないため全員の画面が真っ白になる（デプロイ直後の版ずれでも起こる）
    const { room, send, peers } = attackedRoom();
    const cur = stateOf(peers.a);
    send({ t: 'state', from: 'a', state: { ...cur, version: cur.version + 1, selectedGame: 'constructor' }, sentAt: 0 });
    room.settle(300);
    send({
      t: 'state',
      from: 'a',
      state: { ...cur, version: cur.version + 2, game: { id: '__proto__', players: cur.players, state: {}, startedAt: 0 } },
      sentAt: 0,
    });
    room.settle(300);
    for (const id of ['a', 'b', 'c']) {
      const s = stateOf(peers[id]);
      expect(Object.hasOwn(SIM_GAMES, s.selectedGame)).toBe(true);
      if (s.game) expect(Object.hasOwn(SIM_GAMES, s.game.id)).toBe(true);
    }
  });
});

describe('SEC-05 / SEC-06: 異常な量・形のデータ', () => {
  it('SEC-05: 深い入れ子（10 万段）の game.state を含む状態を受けても、受信処理が例外を外に漏らさない', () => {
    // 疑似ネットワークは JSON.stringify を通すので、Transport の受信コールバックへ直接渡す。
    // 現状：採用後のスナップショット保存（engine.saveNow の JSON.stringify）が RangeError を投げ、
    // Transport の受信コールバックまで例外が抜ける（CLAUDE.md「例外を投げない」に反する。以後の保存のたびに再発）
    const sim = new SimNetwork({ seed: 1 });
    const clock = sim.node('b').clockFor();
    let push: (m: unknown) => void = () => {};
    const engine = new RoomEngine({
      code: ROOM_CODE,
      me: 'b',
      name: 'B',
      create: false,
      transport: {
        status: 'connected',
        send: () => true,
        onMessage: (cb) => {
          push = cb;
          return () => {};
        },
        onStatus: () => () => {},
        reconnect: () => {},
        setNetworkOnline: () => {},
        close: () => {},
      },
      clock,
      storage: memoryStore(),
      games: SIM_GAMES,
    });
    engine.start();
    const base: RoomState = {
      code: ROOM_CODE,
      epoch: 1,
      version: 1,
      hostId: 'a',
      players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      selectedGame: 'counter',
      gameOptions: {},
      game: null,
      chat: [],
      acks: {},
    };
    push({ v: 2, t: 'state', from: 'a', state: base, sentAt: 0 });
    sim.clock.advance(ROOM_TIMINGS.SAVE_MIN_MS + 100);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 100_000; i++) {
      const next: Record<string, unknown> = {};
      deep.a = next;
      deep = next;
    }
    const evil = { ...base, version: 2, game: { id: 'counter', players: base.players, state: root, startedAt: 0 } };
    expect(() => push({ v: 2, t: 'state', from: 'a', state: evil, sentAt: 0 })).not.toThrow();
    expect(() => sim.clock.advance(5000)).not.toThrow();
  });

  it('SEC-06: 毎回違う送信元 ID の hb を大量に送られても、生存確認の表が際限なく増えない', () => {
    // 現状：lastSeen（と rate・syncReplyAt）はメンバー以外の ID も消さずに持ち続け、
    // 受信のたびに refreshOnline が全件をなめる。長時間の flood でホスト端末が重くなる。
    // engine の内部の表を直接見る（観測できる公開 API がないため。実装の名前が変わったらここも直す）
    const { room, send, peers } = attackedRoom();
    for (let i = 0; i < 3000; i++) {
      send({ t: i % 2 ? 'hb' : 'sync', from: `x${i}` });
      if (i % 100 === 0) room.settle(10);
    }
    room.settle(ROOM_TIMINGS.LONE_TAKEOVER_MS + 1000);
    const internals = peers.a.engine as unknown as { lastSeen: Map<string, number>; rate: Map<string, number[]>; syncReplyAt: Map<string, number> };
    expect(internals.lastSeen.size).toBeLessThan(100);
    expect(internals.rate.size).toBeLessThan(100);
    expect(internals.syncReplyAt.size).toBeLessThan(100);
  });
});
