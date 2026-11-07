// Security（S-01 / S-02）：各ゲームのチート耐性。
// 「ホストが検証できるもの」（不正な手・手番外・タイマー専用アクションの偽装）は防げていることを確かめる。
// 「各端末の自己申告に頼るもの」「状態が全員に配られるので見えてしまうもの」は許容リスク（報告書 R-04〜R-06）として、
// 現状の挙動をテストで記録する（仕様が変わったらここを見直す）。
import { describe, expect, it } from 'vitest';
import * as daifugo from '../games/daifugo/logic';
import * as majority from '../games/majority/logic';
import * as reaction from '../games/reaction/logic';
import * as rush from '../games/rush/logic';
import * as wordwolf from '../games/wordwolf/logic';
import * as yubisuma from '../games/yubisuma/logic';

const players = (ids: string[]) => ids.map((id) => ({ id, name: id.toUpperCase() }));
const P3 = players(['a', 'b', 'c']);

describe('大富豪：不正な手はホストで捨てる', () => {
  const s = daifugo.init(P3, 0, { rounds: 1 });
  const turn = s.turn;
  const other = s.order.find((id) => id !== turn)!;
  const notMine = s.hands[other][0];
  const mine = s.hands[turn][0];

  it('持っていないカード・手番でない人・同じカードの水増し・配列でない値は出せない', () => {
    expect(daifugo.reduce(s, { type: 'play', cards: [notMine] }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'play', cards: [s.hands[other][0]] }, other, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'play', cards: [mine, mine] }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'play', cards: 'S3' as unknown as string[] }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'play', cards: [{}] as unknown as string[] }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'play', cards: ['JK', 'JK', 'JK', 'JK', 'JK'] }, turn, 1)).toBe(s);
  });

  it('場がないときのパス・タイマー専用アクション（timeout / next）の偽装は効かない', () => {
    expect(daifugo.reduce(s, { type: 'pass' }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'timeout', seq: s.seq }, turn, 1)).toBe(s);
    expect(daifugo.reduce(s, { type: 'next' }, turn, 1)).toBe(s);
  });

  it('交換フェーズ以外の give は効かない', () => {
    expect(daifugo.reduce(s, { type: 'give', cards: [mine] }, turn, 1)).toBe(s);
  });

  it('（許容リスク R-05 の確認）全員の手札が game.state に入って全員に配られる', () => {
    // 開発者ツールで他人の手札が見える。サーバーなしで隠すには端末ごとの暗号化が要る（MVP 対象外）
    expect(Object.keys(s.hands).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('ミニゲームラッシュ：submit の偽装', () => {
  const s = rush.init(P3, 0);

  it('タイマー専用アクション（timeout / next）は参加者が送っても効かない', () => {
    expect(rush.reduce(s, { type: 'timeout', stage: s.stage }, 'a', 1)).toBe(s);
    expect(rush.reduce({ ...s, phase: 'result' }, { type: 'next' }, 'a', 1).phase).toBe('result');
  });

  it('二重提出・数値でないスコア・脱落者・参加者以外の提出は捨てる。スコアは 0〜100000 に丸める', () => {
    const once = rush.reduce(s, { type: 'submit', result: { score: 10, success: true } }, 'a', 3000);
    expect(rush.reduce(once, { type: 'submit', result: { score: 99, success: false } }, 'a', 3001)).toBe(once);
    for (const result of [null, 'win', { score: NaN, success: true }, { score: Infinity, success: true }, { success: true }]) {
      expect(rush.reduce(s, { type: 'submit', result }, 'b', 3000)).toBe(s);
    }
    expect(rush.reduce({ ...s, lives: { ...s.lives, b: 0 } }, { type: 'submit', result: { score: 1, success: true } }, 'b', 3000).round.results.b).toBeUndefined();
    expect(rush.reduce(s, { type: 'submit', result: { score: 1, success: true } }, 'zz', 3000)).toBe(s);
    const big = rush.reduce(s, { type: 'submit', result: { score: 1e12, success: 'yes' } }, 'c', 3000);
    expect(big.round.results.c).toEqual({ score: 100000, success: false });
  });

  it('（許容リスク R-04 の確認）成否は自己申告なので、遊ばずに success: true を送っても成功になる', () => {
    // ミニゲームは各端末で遊び結果だけを送る設計（micro/core.ts）。開始前（startAt 前）の提出も受け付ける
    const cheated = rush.reduce(s, { type: 'submit', result: { score: 0, success: true } }, 'a', s.round.startAt - 1);
    expect(cheated.round.results.a.success).toBe(true);
  });
});

describe('反射神経：タイムの偽装', () => {
  const s = reaction.init(P3, 0);
  const go: reaction.ReactionState = { ...s, phase: 'go', until: 3000 };

  it('advance（タイマー専用）は参加者が送っても効かない', () => {
    expect(reaction.reduce(s, { type: 'advance' }, 'a', 1)).toBe(s);
  });

  it('NaN / 負 / 100ms 未満はフライング、上限は 3 秒、二度押しは無視、go 中の early は無視', () => {
    expect(reaction.reduce(go, { type: 'tap', ms: NaN }, 'a', 1).current.a).toBe('foul');
    expect(reaction.reduce(go, { type: 'tap', ms: -5 }, 'a', 1).current.a).toBe('foul');
    expect(reaction.reduce(go, { type: 'tap', ms: 99 }, 'a', 1).current.a).toBe('foul');
    expect(reaction.reduce(go, { type: 'tap', ms: 1e9 }, 'a', 1).current.a).toBe(3000);
    const once = reaction.reduce(go, { type: 'tap', ms: 250 }, 'a', 1);
    expect(reaction.reduce(once, { type: 'tap', ms: 120 }, 'a', 2)).toBe(once);
    expect(reaction.reduce(go, { type: 'early' }, 'a', 1)).toBe(go);
    expect(reaction.reduce(go, { type: 'tap', ms: 200 }, 'zz', 1)).toBe(go);
  });

  it('（許容リスク R-04 の確認）タイムは自己申告なので 100ms と申告すれば最速になる', () => {
    // さらに wait 中の state.until（＝合図の時刻）が全員に配られるので、合図を待たずに押す自動化もできる
    expect(reaction.reduce(go, { type: 'tap', ms: 100 }, 'a', 1).current.a).toBe(100);
  });
});

describe('ワードウルフ：投票とお題', () => {
  const s = wordwolf.init(P3, 0);
  const vote: wordwolf.WordWolfState = { ...s, phase: 'vote' };

  it('自分・参加者以外への投票、system を名乗った投票、トーク中の投票は捨てる', () => {
    expect(wordwolf.reduce(vote, { type: 'vote', target: 'a' }, 'a', 1)).toBe(vote);
    expect(wordwolf.reduce(vote, { type: 'vote', target: 'zz' }, 'a', 1)).toBe(vote);
    expect(wordwolf.reduce(vote, { type: 'vote', target: 'b' }, 'system', 1)).toBe(vote);
    expect(wordwolf.reduce(s, { type: 'vote', target: 'b' }, 'a', 1)).toBe(s);
  });

  it('（許容リスク R-05 の確認）全員のお題とウルフが game.state に入って全員に配られる', () => {
    expect(Object.keys(s.words).sort()).toEqual(['a', 'b', 'c']);
    expect(s.wolves).toHaveLength(1);
  });
});

describe('指スマ・多数決：範囲外の値', () => {
  it('指スマ：持っている手より多い親指・範囲外のコール・NaN は捨てる', () => {
    const s = yubisuma.init(P3);
    const caller = s.caller;
    const other = s.order.find((id) => id !== caller)!;
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: 3 }, other, 1)).toBe(s);
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: -1 }, other, 1)).toBe(s);
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: NaN }, other, 1)).toBe(s);
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: 1, call: 7 }, caller, 1)).toBe(s);
    expect(yubisuma.reduce(s, { type: 'choose', thumbs: 1 }, caller, 1)).toBe(s);
    expect(yubisuma.reduce(s, { type: 'next' }, other, 1)).toBe(s);
  });

  it('多数決：a / b 以外の選択・参加者以外・next の偽装は捨てる', () => {
    const s = majority.init(P3, 0);
    expect(majority.reduce(s, { type: 'answer', choice: 'c' as 'a' }, 'a', 1)).toBe(s);
    expect(majority.reduce(s, { type: 'answer', choice: 'a' }, 'zz', 1)).toBe(s);
    expect(majority.reduce(s, { type: 'next' }, 'a', 1)).toBe(s);
  });
});
