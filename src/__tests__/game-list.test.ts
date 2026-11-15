// D-50（指スマを一覧から外す）・D-45（J-07 既定ゲームをラッシュに・J-26 ひと言）のテスト。
import { describe, expect, it } from 'vitest';
import { canPlayWith, playersShort, sortGamesForPlayers } from '../games/order';
import { DEFAULT_GAME, GAME_LIST, GAMES } from '../games/registry';
import { createRoom, hasKnownGames, reduceRoom, type RoomState } from '../room/logic';
import { snapshotKey } from '../room/engine';
import { createSimRoom, memoryStore, ROOM_CODE, SIM_GAMES } from './sim/harness';
import { RoomEngine } from '../room/engine';
import { createManagedTransport } from '../lib/transport';
import { SimNetwork } from './sim/network';

const A = { id: 'a', name: 'A' };

describe('D-45 / J-07：最初に選ばれているゲーム', () => {
  it('既定はミニゲームラッシュで、登録にある', () => {
    expect(DEFAULT_GAME).toBe('rush');
    expect(Object.hasOwn(GAMES, DEFAULT_GAME)).toBe(true);
    expect(createRoom('ABCD', A, DEFAULT_GAME).selectedGame).toBe('rush');
  });

  it('既定ゲームは 1 人から遊べる（部屋を作った直後に始められる）', () => {
    expect(canPlayWith(GAMES[DEFAULT_GAME], 1)).toBe(true);
  });
});

describe('sortGamesForPlayers', () => {
  const defs = [
    { id: 'w', minPlayers: 3, maxPlayers: 10 },
    { id: 'r', minPlayers: 1, maxPlayers: 10 },
    { id: 'd', minPlayers: 3, maxPlayers: 6 },
    { id: 'x', minPlayers: 1, maxPlayers: 2 },
  ];
  const ids = (n: number) => sortGamesForPlayers(defs, n).map((d) => d.id);

  it('遊べる人数のものを先に、それぞれ元の順を保つ', () => {
    expect(ids(1)).toEqual(['r', 'x', 'w', 'd']);
    expect(ids(2)).toEqual(['r', 'x', 'w', 'd']);
    expect(ids(3)).toEqual(['w', 'r', 'd', 'x']);
    expect(ids(7)).toEqual(['w', 'r', 'd', 'x']);
    expect(ids(11)).toEqual(['w', 'r', 'd', 'x']);
  });

  it('元の配列は変えず、件数も変わらない', () => {
    const before = defs.map((d) => d.id);
    expect(sortGamesForPlayers(defs, 1)).toHaveLength(defs.length);
    expect(defs.map((d) => d.id)).toEqual(before);
  });

  it('数でない・負の人数でも例外にせず 0 人として扱う', () => {
    for (const n of [NaN, -1, Infinity, -Infinity]) {
      expect(() => sortGamesForPlayers(defs, n)).not.toThrow();
      expect(ids(n)).toEqual(['w', 'r', 'd', 'x']);
    }
  });

  it('本物の一覧：1 人なら 1 人用のゲーム（反射神経・ラッシュ）が先頭に来る', () => {
    const sorted = sortGamesForPlayers(GAME_LIST, 1).map((d) => d.id);
    expect(sorted.slice(0, 2)).toEqual(['reaction', 'rush']);
    expect(sorted).toHaveLength(GAME_LIST.length);
  });

  it('playersShort：「あと n 人」', () => {
    expect(playersShort({ minPlayers: 3 }, 1)).toBe(2);
    expect(playersShort({ minPlayers: 3 }, 3)).toBe(0);
    expect(playersShort({ minPlayers: 3 }, 20)).toBe(0);
    expect(playersShort({ minPlayers: 3 }, NaN)).toBe(3);
  });
});

describe('D-45 / J-26：ひと言（oneLiner）', () => {
  it('すべてのゲームに 1 行の空でないひと言がある', () => {
    for (const def of GAME_LIST) {
      expect(def.oneLiner.trim().length, def.id).toBeGreaterThan(0);
      expect(def.oneLiner, def.id).not.toMatch(/\n/);
      // スマホのロビーで 1〜2 行に収まる程度に短く
      expect(def.oneLiner.length, def.id).toBeLessThanOrEqual(30);
    }
  });
});

describe('D-50：指スマを外した後に古い端末・保存データから yubisuma が届く', () => {
  it('一覧・登録にない', () => {
    expect(GAME_LIST.some((g) => g.id === 'yubisuma')).toBe(false);
    expect(Object.hasOwn(GAMES, 'yubisuma')).toBe(false);
  });

  it('selectGame で yubisuma を選ぼうとしても無視される', () => {
    const s = createRoom('ABCD', A, DEFAULT_GAME);
    const next = reduceRoom(s, { type: 'selectGame', gameId: 'yubisuma' }, 'a', 0, GAMES);
    expect(next).toBe(s);
  });

  it('selectedGame が yubisuma の状態からの開始・設定変更は例外にならず無視される', () => {
    const s: RoomState = { ...createRoom('ABCD', A, DEFAULT_GAME), selectedGame: 'yubisuma' };
    expect(hasKnownGames(s, GAMES)).toBe(false);
    expect(reduceRoom(s, { type: 'startGame', online: ['a'] }, 'a', 0, GAMES)).toBe(s);
    expect(reduceRoom(s, { type: 'setOption', key: 'lives', value: 3 }, 'a', 0, GAMES)).toBe(s);
  });

  it('遊んでいる途中の yubisuma の状態も「登録にない」と判定される', () => {
    const base = createRoom('ABCD', A, DEFAULT_GAME);
    const s: RoomState = { ...base, game: { id: 'yubisuma', players: [A], state: {}, startedAt: 0 } };
    expect(hasKnownGames(s, GAMES)).toBe(false);
    expect(reduceRoom(s, { type: 'game', action: { type: 'choose', thumbs: 1 } }, 'a', 0, GAMES)).toBe(s);
  });

  it('古い版のホストが yubisuma を選んだ状態を配っても、新しい版の端末は採用しない', () => {
    const room = createSimRoom({ ids: ['a', 'b'] });
    room.settle(3000);
    const cur = room.peers.a.engine.getSnapshot().state as RoomState;
    const node = room.sim.node('old');
    const link = node.linkFactory(ROOM_CODE, { onOpen: () => {}, onDown: () => {}, onMessage: () => {} });
    room.settle(100);
    link.send({ v: 2, t: 'state', from: 'a', state: { ...cur, version: cur.version + 1, selectedGame: 'yubisuma' }, sentAt: 0 });
    room.settle(500);
    for (const id of ['a', 'b']) {
      const s = room.peers[id].engine.getSnapshot().state as RoomState;
      expect(s.selectedGame).not.toBe('yubisuma');
      expect(Object.hasOwn(SIM_GAMES, s.selectedGame)).toBe(true);
    }
  });

  it('保存データ（スナップショット）の yubisuma は復元せず、部屋を作るときは既定ゲームで始まる', () => {
    const sim = new SimNetwork({ seed: 3 });
    const node = sim.node('a');
    const clock = node.clockFor(0);
    const storage = memoryStore();
    const old: RoomState = {
      ...createRoom(ROOM_CODE, A, 'yubisuma'),
      game: { id: 'yubisuma', players: [A], state: { phase: 'choose' }, startedAt: 0 },
    };
    storage.set(snapshotKey(ROOM_CODE), JSON.stringify(old));
    let engine: RoomEngine | null = null;
    expect(() => {
      engine = new RoomEngine({
        code: ROOM_CODE,
        me: 'a',
        name: 'A',
        create: true,
        transport: createManagedTransport(node.linkFactory, ROOM_CODE, clock),
        clock,
        storage,
        games: GAMES,
        defaultGame: DEFAULT_GAME,
      });
      engine.start();
      sim.clock.advance(3000);
    }).not.toThrow();
    const s = engine!.getSnapshot().state as RoomState;
    expect(s.selectedGame).toBe('rush');
    expect(s.game).toBeNull();
  });
});
