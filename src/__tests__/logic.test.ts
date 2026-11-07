import { describe, expect, it } from 'vitest';
import { GAMES } from '../games/registry';
import * as majority from '../games/majority/logic';
import * as reaction from '../games/reaction/logic';
import * as wordwolf from '../games/wordwolf/logic';
import * as yubisuma from '../games/yubisuma/logic';
import {
  CHAT_RATE,
  chatBlockedUntil,
  compareStates,
  createRoom,
  pickNextHost,
  reduceRoom,
  takeOverHost,
  type RoomState,
} from '../room/logic';

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
