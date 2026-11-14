// GameDef.isOver（終了判定）と共有文のテスト（09-review「公開前の改善のレビュー」推奨 1・4）。
// isOver は Room.tsx の旧判定（ワードウルフは 'result'、ほかは 'over'）と同じ結果になることを確かめる。
import { describe, expect, it } from 'vitest';
import { GAME_LIST, GAMES } from '../games/registry';
import type { GamePlayer } from '../games/types';
import { inviteText, recordText } from '../components/share';

const players: GamePlayer[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));

// ゲームごとの phase の全種類と、終了とみなす phase
const PHASES: Record<string, { over: string; ongoing: string[] }> = {
  wordwolf: { over: 'result', ongoing: ['talk', 'vote'] },
  majority: { over: 'over', ongoing: ['answer', 'reveal'] },
  reaction: { over: 'over', ongoing: ['ready', 'wait', 'go', 'result'] },
  rush: { over: 'over', ongoing: ['play', 'result'] },
  yubisuma: { over: 'over', ongoing: ['choose', 'reveal'] },
  daifugo: { over: 'over', ongoing: ['exchange', 'play', 'roundEnd'] },
};

describe('GameDef.isOver', () => {
  it('登録されたすべてのゲームが isOver を持ち、表に載っている', () => {
    for (const def of GAME_LIST) {
      expect(typeof def.isOver, def.id).toBe('function');
      expect(Object.hasOwn(PHASES, def.id), def.id).toBe(true);
    }
  });

  for (const [id, { over, ongoing }] of Object.entries(PHASES)) {
    describe(id, () => {
      const def = GAMES[id];
      const base = def.init(players, 0, {});

      it('開始直後は終わっていない', () => {
        expect(def.isOver!(base)).toBe(false);
      });

      it(`'${over}' は終了`, () => {
        expect(def.isOver!({ ...base, phase: over })).toBe(true);
      });

      for (const ph of ongoing) {
        it(`'${ph}' は途中`, () => {
          expect(def.isOver!({ ...base, phase: ph })).toBe(false);
        });
      }
    });
  }
});

describe('share の文面', () => {
  it('inviteText：ゲーム名ありは 3 行', () => {
    expect(inviteText('ABCD', '指スマ')).toBe(
      'SUKIMA で遊ぼう！タップするだけで参加（登録不要）\nゲーム：指スマ\n部屋コード：ABCD',
    );
  });

  it('inviteText：ゲーム名なしはゲーム行を出さない', () => {
    expect(inviteText('ABCD', undefined)).toBe('SUKIMA で遊ぼう！タップするだけで参加（登録不要）\n部屋コード：ABCD');
  });

  it('recordText：ステージ数で見せる', () => {
    expect(recordText(7)).toBe('SUKIMA で 7 ステージ。超えられる？');
    expect(recordText(0)).toBe('SUKIMA で 0 ステージ。超えられる？');
  });
});
