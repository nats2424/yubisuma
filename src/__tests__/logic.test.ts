import { describe, expect, it } from 'vitest';
import { GAMES } from '../games/registry';
import * as majority from '../games/majority/logic';
import * as reaction from '../games/reaction/logic';
import * as wordwolf from '../games/wordwolf/logic';
import * as yubisuma from '../games/yubisuma/logic';
import type { GameDef } from '../games/types';
import {
  acceptAction,
  CHAT_MAX_LEN,
  CHAT_RATE,
  chatBlockedUntil,
  compareStates,
  createRoom,
  pickNextHost,
  reduceRoom,
  START_GUARD_MS,
  takeOverHost,
  type RoomState,
} from '../room/logic';
import { MAX_STATE_BYTES } from '../room/protocol';

const P = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

describe('room', () => {
  it('join / start / game action / end', () => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    expect(s.players.map((p) => p.id)).toEqual(['a', 'b']);
    // ホスト以外は開始できない
    expect(reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'b', 0, GAMES)).toBe(s);
    s = reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'a', 0, GAMES);
    expect(s.game?.id).toBe('reaction');
    // 途中参加者は観戦扱い（ゲームのアクションは無視）
    s = reduceRoom(s, { type: 'join', name: 'C' }, 'c', 0, GAMES);
    const before = s;
    expect(reduceRoom(s, { type: 'game', action: { type: 'early' } }, 'c', 0, GAMES)).toBe(before);
    s = reduceRoom(s, { type: 'endGame' }, 'a', 0, GAMES);
    expect(s.game).toBeNull();
  });

  it('host leaving hands over host', () => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    s = reduceRoom(s, { type: 'leave' }, 'a', 0, GAMES);
    expect(s.hostId).toBe('b');
  });

  it('host takeover wins over stale host state', () => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    expect(pickNextHost(s, new Set(['b']), 'a')).toBe('b');
    const taken = takeOverHost(s, 'b', 0);
    const staleButBusy = { ...s, version: s.version + 50 };
    expect(compareStates(taken, staleButBusy)).toBeGreaterThan(0);
  });
});

describe('yubisuma', () => {
  it('caller who hits lowers a hand; finishes when both down', () => {
    let s = yubisuma.init(P.slice(0, 2));
    s = { ...s, caller: 'a' };
    s = yubisuma.reduce(s, { type: 'choose', thumbs: 1, call: 3 }, 'a', 0);
    expect(s.phase).toBe('choose');
    s = yubisuma.reduce(s, { type: 'choose', thumbs: 2 }, 'b', 0);
    expect(s.phase).toBe('reveal');
    expect(s.last?.hit).toBe(true);
    expect(s.hands.a).toBe(1);
    s = yubisuma.reduce(s, { type: 'next' }, 'system', 0);
    expect(s.caller).toBe('b');
    expect(yubisuma.maxCall(s)).toBe(3);
  });

  it('rejects invalid thumbs', () => {
    const s = yubisuma.init(P);
    const notCaller = s.order.find((id) => id !== s.caller)!;
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: 3 }, notCaller, 0)).toBe(s);
  });

  it('game ends with one player left', () => {
    let s = yubisuma.init(P.slice(0, 2));
    s = { ...s, caller: 'a', hands: { a: 1, b: 2 } };
    s = yubisuma.reduce(s, { type: 'choose', thumbs: 0, call: 0 }, 'a', 0);
    s = yubisuma.reduce(s, { type: 'choose', thumbs: 0 }, 'b', 0);
    expect(s.phase).toBe('over');
    expect(s.finished).toEqual(['a']);
  });
});

describe('wordwolf', () => {
  it('assigns one wolf and resolves votes', () => {
    let s = wordwolf.init(P, 0);
    expect(s.wolves).toHaveLength(1);
    const wolf = s.wolves[0];
    expect(s.words[wolf]).toBe(s.wolfWord);
    expect(s.citizenWord).not.toBe(s.wolfWord);
    s = wordwolf.reduce(s, { type: 'toVote' }, 'system', 0);
    const citizens = s.order.filter((id) => id !== wolf);
    for (const id of citizens) s = wordwolf.reduce(s, { type: 'vote', target: wolf }, id, 0);
    s = wordwolf.reduce(s, { type: 'vote', target: citizens[0] }, wolf, 0);
    expect(s.phase).toBe('result');
    expect(s.result?.citizensWin).toBe(true);
  });

  it('cannot vote for yourself', () => {
    let s = wordwolf.reduce(wordwolf.init(P, 0), { type: 'toVote' }, 'a', 0);
    expect(wordwolf.reduce(s, { type: 'vote', target: 'a' }, 'a', 0)).toBe(s);
  });
});

describe('reaction', () => {
  it('runs rounds and penalises fouls', () => {
    let s = reaction.init(P.slice(0, 2), 0);
    s = reaction.reduce(s, { type: 'advance' }, 'system', 0); // wait
    s = reaction.reduce(s, { type: 'early' }, 'b', 0);
    s = reaction.reduce(s, { type: 'advance' }, 'system', 0); // go
    expect(s.phase).toBe('go');
    s = reaction.reduce(s, { type: 'tap', ms: 250 }, 'a', 0);
    expect(s.phase).toBe('result');
    expect(reaction.totals(s)).toEqual({ a: 250, b: reaction.PENALTY_MS });
    // 人間離れした反応はフライング扱い
    expect(reaction.reduce({ ...s, phase: 'go', current: {} }, { type: 'tap', ms: 20 }, 'a', 0).current.a).toBe('foul');
  });
});

describe('majority', () => {
  it('awards majority', () => {
    let s = majority.init(P, 0);
    s = majority.reduce(s, { type: 'answer', choice: 'a' }, 'a', 0);
    s = majority.reduce(s, { type: 'answer', choice: 'a' }, 'b', 0);
    s = majority.reduce(s, { type: 'answer', choice: 'b' }, 'c', 0);
    expect(s.phase).toBe('reveal');
    expect(s.scores).toEqual({ a: 1, b: 1, c: 0 });
    s = majority.reduce(s, { type: 'next' }, 'a', 0);
    expect(s.round).toBe(2);
  });
});

describe('chatBlockedUntil', () => {
  const room = (): RoomState => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    return s;
  };
  const say = (s: RoomState, by: string, at: number) => reduceRoom(s, { type: 'chat', text: 'hi' }, by, at, GAMES);

  it('2 件までなら 0', () => {
    let s = room();
    s = say(s, 'a', 1000);
    s = say(s, 'a', 1100);
    expect(chatBlockedUntil(s, 'a', 1200)).toBe(0);
  });

  it('3 件送ったあとは 3 件目（新しい方から数えて）の at + 3000 を返す', () => {
    let s = room();
    s = say(s, 'a', 1000);
    s = say(s, 'a', 1100);
    s = say(s, 'a', 1200);
    expect(CHAT_RATE).toEqual({ count: 3, windowMs: 3000 });
    // 直近 3 件のうち最も古い 1000 が窓を抜けるまで送れない
    expect(chatBlockedUntil(s, 'a', 1300)).toBe(4000);
    expect(chatBlockedUntil(s, 'a', 3999)).toBe(4000);
    expect(chatBlockedUntil(s, 'a', 4000)).toBe(0);
  });

  it('同時刻に 3 件なら その at + 3000', () => {
    let s = room();
    for (let i = 0; i < 3; i++) s = say(s, 'a', 2000);
    expect(chatBlockedUntil(s, 'a', 2000)).toBe(5000);
  });

  it('他人のチャットは数えない', () => {
    let s = room();
    s = say(s, 'b', 1000);
    s = say(s, 'b', 1100);
    s = say(s, 'b', 1200);
    s = say(s, 'a', 1250);
    expect(chatBlockedUntil(s, 'a', 1300)).toBe(0);
    expect(chatBlockedUntil(s, 'b', 1300)).toBe(4000);
  });
});

describe('acceptAction / 連番と重複除去（AC-12・13・15）', () => {
  const room = (): RoomState => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    s = reduceRoom(s, { type: 'join', name: 'C' }, 'c', 0, GAMES);
    return s;
  };
  const chat = (text: string) => ({ type: 'chat' as const, text });

  it('createRoom は acks を空で持つ', () => {
    expect(room().acks).toEqual({});
  });

  it('AC-12: 同じ seq が 3 回届いても適用は 1 回だけ', () => {
    let s = room();
    for (let i = 0; i < 3; i++) s = acceptAction(s, 'b', 1, chat('hi'), 1000 + i, GAMES) ?? s;
    expect(s.chat.filter((m) => m.by === 'b')).toHaveLength(1);
    expect(s.acks.b).toBe(1);
  });

  it('AC-13: seq 5 が seq 4 より先に届いたら、後から来た 4 は捨てる', () => {
    let s = room();
    s = acceptAction(s, 'b', 5, chat('five'), 1000, GAMES)!;
    expect(s.acks.b).toBe(5);
    expect(acceptAction(s, 'b', 4, chat('four'), 1100, GAMES)).toBeNull();
    expect(s.chat.filter((m) => m.by === 'b').map((m) => m.text)).toEqual(['five']);
  });

  it('reduce で変化がなくても受け付けたら acks は進む', () => {
    const s = room();
    // ホスト以外の selectGame は無視されるが、seq は処理済みになる（参加者が再送をやめられるように）
    const next = acceptAction(s, 'b', 1, { type: 'selectGame', gameId: 'rush' }, 0, GAMES)!;
    expect(next.selectedGame).toBe(s.selectedGame);
    expect(next.acks.b).toBe(1);
  });

  it('非メンバー・gameSystem・不正な seq は null', () => {
    const s = room();
    expect(acceptAction(s, 'z', 1, chat('x'), 0, GAMES)).toBeNull();
    expect(acceptAction(s, 'b', 1, { type: 'gameSystem', action: {} }, 0, GAMES)).toBeNull();
    expect(acceptAction(s, 'b', 0, chat('x'), 0, GAMES)).toBeNull();
    expect(acceptAction(s, 'b', 1.5, chat('x'), 0, GAMES)).toBeNull();
    expect(acceptAction(s, '__proto__', 1, chat('x'), 0, GAMES)).toBeNull();
  });

  it('AC-15: ホスト交代後も処理済み seq が引き継がれ、再送されても二重適用しない', () => {
    let s = room();
    s = acceptAction(s, 'c', 1, chat('one'), 1000, GAMES)!;
    s = acceptAction(s, 'c', 2, chat('two'), 1100, GAMES)!;
    // 旧ホスト a が落ちて b が引き継ぐ
    const taken = takeOverHost(s, 'b', 2000);
    expect(taken.acks).toEqual({ c: 2 });
    // c が未確認だと思って再送した seq 2 は新ホストでも捨てられる
    expect(acceptAction(taken, 'c', 2, chat('two'), 2100, GAMES)).toBeNull();
    expect(acceptAction(taken, 'c', 3, chat('three'), 2200, GAMES)?.acks.c).toBe(3);
  });

  it('leave / kick で acks から消え、leave の重複は捨てる', () => {
    let s = room();
    s = acceptAction(s, 'b', 1, chat('x'), 0, GAMES)!;
    s = acceptAction(s, 'c', 1, chat('y'), 0, GAMES)!;
    s = acceptAction(s, 'b', 2, { type: 'leave' }, 10, GAMES)!;
    expect(s.players.map((p) => p.id)).toEqual(['a', 'c']);
    expect(s.acks).toEqual({ c: 1 });
    expect(acceptAction(s, 'b', 2, { type: 'leave' }, 20, GAMES)).toBeNull();
    s = reduceRoom(s, { type: 'kick', target: 'c' }, 'a', 30, GAMES);
    expect(s.acks).toEqual({});
  });
});

describe('ホストの保護（AC-04・20・21）', () => {
  const boom: GameDef<{ n: number }, { type: string }> = {
    id: 'boom',
    name: 'boom',
    emoji: '',
    tagline: '',
    rules: [],
    minPlayers: 1,
    maxPlayers: 10,
    minutes: '',
    category: 'quick',
    init: () => ({ n: 0 }),
    reduce: (s, a) => {
      if (a.type === 'boom') throw new Error('boom');
      return { n: s.n + 1 };
    },
    View: () => null,
  };
  const games = { ...GAMES, boom };

  it('AC-04: ゲームの reduce が例外を投げても状態を変えず、その後の正常なアクションは処理される', () => {
    let s = createRoom('ABCD', P[0], 'boom');
    s = reduceRoom(s, { type: 'startGame', online: ['a'] }, 'a', 0, games);
    const before = s;
    expect(reduceRoom(s, { type: 'game', action: { type: 'boom' } }, 'a', 10, games)).toBe(before);
    s = reduceRoom(s, { type: 'game', action: { type: 'ok' } }, 'a', 20, games);
    expect(s.game?.state).toEqual({ n: 1 });
  });

  it('AC-20: 3 秒以内に 5 件チャットしても追加されるのは 3 件まで', () => {
    let s = createRoom('ABCD', P[0], 'reaction');
    for (let i = 0; i < 5; i++) s = reduceRoom(s, { type: 'chat', text: `m${i}` }, 'a', 1000 + i * 500, GAMES);
    expect(s.chat.filter((m) => m.by === 'a').map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);
    // 窓を抜ければまた送れる
    s = reduceRoom(s, { type: 'chat', text: 'later' }, 'a', 4000, GAMES);
    expect(s.chat.filter((m) => m.by === 'a')).toHaveLength(4);
  });

  it('AC-21: 「もう一度」を 1 秒以内に 2 回押しても再初期化は 1 回だけ', () => {
    let s = createRoom('ABCD', P[0], 'reaction');
    s = reduceRoom(s, { type: 'join', name: 'B' }, 'b', 0, GAMES);
    s = reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'a', 0, GAMES);
    expect(s.game?.startedAt).toBe(0);
    // ゲーム終了後に「もう一度」を 2 回
    s = reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'a', 60000, GAMES);
    expect(s.game?.startedAt).toBe(60000);
    expect(reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'a', 60800, GAMES)).toBe(s);
    const later = reduceRoom(s, { type: 'startGame', online: ['a', 'b'] }, 'a', 60000 + START_GUARD_MS, GAMES);
    expect(later.game?.startedAt).toBe(60000 + START_GUARD_MS);
  });
});

describe('AC-22: 状態のサイズ', () => {
  it('10 人・チャット 60 件（各 200 文字）・大富豪 6 人・acks 10 件の JSON が 64KB 以下', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ id: `player-${i}-${'x'.repeat(30)}`, name: 'あいうえおかきくけこ' }));
    let s = createRoom('ABCD', players[0], 'daifugo');
    for (const p of players.slice(1)) s = reduceRoom(s, { type: 'join', name: p.name }, p.id, 0, GAMES);
    expect(s.players).toHaveLength(10);
    s = reduceRoom(s, { type: 'startGame', online: players.slice(0, 6).map((p) => p.id) }, players[0].id, 0, GAMES);
    expect(s.game?.id).toBe('daifugo');
    expect(s.game?.players).toHaveLength(6);
    const text = 'あ'.repeat(CHAT_MAX_LEN);
    s = {
      ...s,
      chat: Array.from({ length: 60 }, (_, i) => {
        const p = players[i % 10];
        return { id: `${p.id}_${1700000000000 + i}_${i}`, by: p.id, name: p.name, text, at: 1700000000000 + i };
      }),
      acks: Object.fromEntries(players.map((p) => [p.id, 123456])),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(s)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_STATE_BYTES);
  });
});
