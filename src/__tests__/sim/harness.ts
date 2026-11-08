// 疑似ネットワーク上に複数端末のルームを組み立てるテスト補助（設計 §6.1）。
// 本番と同じ RoomEngine・ManagedTransport を使い、違うのは Link と Clock だけ。
import { GAMES } from '../../games/registry';
import type { GameDef } from '../../games/types';
import type { RushState } from '../../games/rush/logic';
import { createManagedTransport } from '../../lib/transport';
import { RoomEngine, type KeyValueStore } from '../../room/engine';
import type { GameRegistry } from '../../room/logic';
import { SimNetwork, type LinkConditions, type SimNode } from './network';

export const ROOM_CODE = 'SIMR';

export const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
};

// テスト用の小さなゲーム。count は人ごとの適用回数、fired は schedule の発火
export type CounterState = { count: Record<string, number>; fireAt: number; fired: boolean };
export const counterGame: GameDef<CounterState, { type: 'inc' } | { type: 'fire' }> = {
  id: 'counter',
  name: 'カウンター',
  emoji: '',
  tagline: '',
  rules: [],
  minPlayers: 1,
  maxPlayers: 10,
  minutes: '',
  category: 'quick',
  init: (_players, now) => ({ count: {}, fireAt: now + 1000, fired: false }),
  reduce: (s, a, by) => {
    if (a.type === 'inc' && by !== 'system') return { ...s, count: { ...s.count, [by]: (s.count[by] ?? 0) + 1 } };
    if (a.type === 'fire' && by === 'system' && !s.fired) return { ...s, fired: true };
    return s;
  },
  schedule: (s) => (s.fired ? null : { at: s.fireAt, action: { type: 'fire' } }),
  View: () => null,
};

export const SIM_GAMES: GameRegistry = { ...GAMES, counter: counterGame };

export interface SimPeer {
  readonly id: string;
  engine: RoomEngine;
  readonly node: SimNode;
  readonly storage: KeyValueStore;
  // pageHide → dispose → 同じ id・storage で create=false の engine を作り直す
  reload(): void;
}

export function createSimRoom(opts: {
  ids: string[]; // ids[0] が create=true のホスト
  cond?: LinkConditions;
  seed?: number;
  skews?: Record<string, number>; // 端末ごとの時計のずれ
  games?: GameRegistry;
  // false なら ids[1..] を作らない（後から addPeer で入れる）
  joinAll?: boolean;
}) {
  const sim = new SimNetwork({ seed: opts.seed ?? 1 });
  const games = opts.games ?? SIM_GAMES;
  const peers: Record<string, SimPeer> = {};

  const makeEngine = (id: string, node: SimNode, storage: KeyValueStore, create: boolean) => {
    const clock = node.clockFor(opts.skews?.[id] ?? 0);
    const engine = new RoomEngine({
      code: ROOM_CODE,
      me: id,
      name: id.toUpperCase(),
      create,
      transport: createManagedTransport(node.linkFactory, ROOM_CODE, clock),
      clock,
      storage,
      games,
      defaultGame: 'counter',
    });
    engine.start();
    return engine;
  };

  const addPeer = (id: string, create = false, cond = opts.cond): SimPeer => {
    const node = sim.node(id, cond);
    const storage = memoryStore();
    const peer: SimPeer = {
      id,
      node,
      storage,
      engine: makeEngine(id, node, storage, create),
      reload() {
        this.engine.pageHide();
        this.engine.dispose();
        this.engine = makeEngine(id, node, storage, false);
      },
    };
    peers[id] = peer;
    return peer;
  };

  opts.ids.forEach((id, i) => {
    if (i === 0 || opts.joinAll !== false) addPeer(id, i === 0);
  });

  return {
    sim,
    peers,
    addPeer,
    settle(ms = 3000) {
      sim.clock.advance(ms);
    },
    hostIds(): (string | null)[] {
      return Object.values(peers).map((p) => p.engine.getSnapshot().state?.hostId ?? null);
    },
    // 全端末が同じホスト・同じ版の状態を持っている
    converged(ids = Object.keys(peers)): boolean {
      const states = ids.map((id) => peers[id].engine.getSnapshot().state);
      const first = states[0];
      return !!first && states.every((s) => s && s.hostId === first.hostId && s.epoch === first.epoch && s.version === first.version);
    },
    // 送信ログから種類で絞る
    sent(from: string, t: string, sinceMs = 0) {
      return sim.log.filter((e) => e.from === from && e.at >= sinceMs && (e.msg as { t?: string }).t === t);
    },
  };
}

// ラッシュ用 bot：新しいステージ（seed が変わった）を見たら startAt + delayMs に submit を 1 回 dispatch する。
// 端末のタイマーを使うので freeze 中は止まる。リロード後も peer.engine を見直して動き続ける
export function rushBot(peer: SimPeer, opts: { success: boolean; delayMs: number }): () => void {
  const clock = peer.node.clockFor();
  let lastSeed: number | null = null;
  let stopped = false;
  let cancelPoll: (() => void) | null = null;
  const poll = () => {
    if (stopped) return;
    cancelPoll = clock.setTimeout(poll, 50);
    const st = peer.engine.getSnapshot().state;
    if (!st?.game || st.game.id !== 'rush') return;
    const rush = st.game.state as RushState;
    if (rush.phase !== 'play' || rush.round.seed === lastSeed || !(rush.lives[peer.id] > 0)) return;
    if (peer.id in rush.round.results) {
      lastSeed = rush.round.seed;
      return;
    }
    const seed = rush.round.seed;
    lastSeed = seed;
    clock.setTimeout(
      () => {
        if (stopped) return;
        peer.engine.dispatch({ type: 'game', action: { type: 'submit', result: { score: opts.success ? 1 : 0, success: opts.success } } });
      },
      Math.max(0, rush.round.startAt + opts.delayMs - peer.engine.now()),
    );
  };
  poll();
  return () => {
    stopped = true;
    cancelPoll?.();
  };
}
