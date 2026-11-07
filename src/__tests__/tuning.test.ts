import { describe, expect, it } from 'vitest';
import { LIVES, MICRO_META, microMeta, nextMicroId, startMicroRound, speedForStage as coreSpeedForStage } from '../games/micro/core';
import { VERDICT_MS } from '../games/micro/MicroStage';
import { enabledMicroIds, TUNING, speedForStage, speedUpRuleText, validateTuning, type Tuning } from '../games/micro/tuning';
import { GAMES } from '../games/registry';
import * as rush from '../games/rush/logic';

// 複製して一部だけ壊すための補助（元の TUNING は変えない）
const clone = (): Tuning => JSON.parse(JSON.stringify(TUNING)) as Tuning;

// 一元化する前のコードに直書きされていた値（AC-44：同じ値で移したことの確認用）
const LEGACY = {
  speedForStage: (stage: number) => Math.min(2, 1 + Math.floor((stage - 1) / 5) * 0.15),
  meta: {
    mash: [5000, true],
    stop: [5000, true],
    whack: [6000, true],
    dodge: [6000, true],
    balloon: [6000, true],
    count: [6000, true],
    color: [7000, true],
    math: [7000, true],
    odd: [6000, true],
    timing: [6000, false],
  } as Record<string, [number, boolean]>,
};

describe('tuning', () => {
  it('speedUpRuleText() が「5ステージごと」を含む', () => {
    expect(speedUpRuleText()).toContain('5ステージごと');
  });

  it('AC-42: 何ステージごとに速くなるかを変えると、ルール説明文の数値も変わる', () => {
    expect(speedUpRuleText({ ...TUNING, speed: { ...TUNING.speed, everyStages: 3 } })).toContain('3ステージごと');
    // ラッシュのルール文言は調整値から作られている
    expect(GAMES.rush.rules.join('')).toContain(speedUpRuleText());
    expect(GAMES.rush.options?.[0]).toMatchObject({ key: 'lives', default: TUNING.lives.default });
    expect(GAMES.rush.options?.[0].choices.map((c) => c.value)).toEqual([...TUNING.lives.choices]);
  });

  it('AC-44: 一元化前と同じ値（スピードカーブ・ライフ・判定表示・各ミニゲームの制限時間）', () => {
    for (let stage = 1; stage <= 30; stage++) {
      expect(speedForStage(stage)).toBe(LEGACY.speedForStage(stage));
      expect(coreSpeedForStage(stage)).toBe(LEGACY.speedForStage(stage));
    }
    expect(LIVES).toBe(4);
    expect(VERDICT_MS).toBe(1500);
    expect(TUNING.rush).toEqual({ introMs: 2400, resultMs: 2500, verdictMs: 1600, graceMs: 2500 });
    expect(TUNING.solo.introMs).toBe(2000);
    expect(TUNING.stage.minPlayMs).toBe(800);
    expect(MICRO_META.map((m) => m.id)).toEqual(Object.keys(LEGACY.meta));
    for (const m of MICRO_META) expect([m.baseMs, m.scales]).toEqual(LEGACY.meta[m.id]);
    expect(microMeta('timing').title).toBe('3秒ぴったり！');
    // ラッシュの締め切り = 開始 + 制限時間 + 猶予 2500ms
    const r = startMicroRound('mash', 0, 1, 2400);
    expect(r.endsAt - r.startAt - r.duration).toBe(2500);
    expect(rush.init([{ id: 'a', name: 'A' }], 0).round.startAt).toBe(2400);
  });

  it('AC-43: validateTuning(TUNING) は違反なし', () => {
    expect(validateTuning(TUNING)).toEqual([]);
  });

  it('AC-43: 違反を 1 つずつ入れた複製で、該当する説明が出る', () => {
    const cases: [string, (t: Tuning) => void, RegExp][] = [
      ['時間が 0', (t) => (t.rush.introMs = 0), /rush\.introMs は正の数/],
      ['時間が負', (t) => (t.stage.minPlayMs = -1), /stage\.minPlayMs は正の数/],
      ['params の時間が 0', (t) => (t.micro.count.params.showMaxMs = 0), /micro\.count\.params\.showMaxMs は正の数/],
      ['最高速度で 2000ms 未満', (t) => (t.micro.mash.baseMs = 3000), /micro\.mash: 最高速度/],
      ['倍率の上限を上げすぎ', (t) => (t.speed.max = 4), /micro\.color: 最高速度/],
      ['速くならないゲームが 2000ms 未満', (t) => (t.micro.timing.baseMs = 1500), /micro\.timing: 最高速度/],
      [
        '有効なミニゲームが 1 種類',
        (t) => {
          for (const id of Object.keys(t.micro)) t.micro[id].enabled = id === 'mash';
        },
        /2 種類以上/,
      ],
      ['ライフの既定値が選択肢にない', (t) => (t.lives.default = 7), /lives\.default（7）が lives\.choices に含まれていません/],
      ['スピードの上げ幅が 0', (t) => (t.speed.step = 0), /speed\.step は正の数/],
      ['何ステージごとが 0', (t) => (t.speed.everyStages = 0), /speed\.everyStages は 1 以上の整数/],
      ['min > max', (t) => (t.micro.count.params.min = 20), /min（20）が max（12）より大きく/],
      ['xxxMin > xxxMax', (t) => (t.micro.balloon.params.limitMin = 40), /limitMin（40）が limitMax（28）より大きく/],
      ['xxxMinMs > xxxMaxMs', (t) => (t.micro.stop.params.periodMinMs = 2000), /periodMinMs（2000）が periodMaxMs（1400）より大きく/],
      ['割合が 1 を超える', (t) => (t.micro.whack.params.needRatio = 1.5), /needRatio は 0 より大きく 1 以下/],
    ];
    for (const [label, breakIt, message] of cases) {
      const t = clone();
      breakIt(t);
      const errors = validateTuning(t);
      expect(errors.some((e) => message.test(e)), `${label}: ${errors.join(' / ')}`).toBe(true);
    }
    // 壊していない複製は違反なし（壊し方の確認が元の TUNING に漏れていない）
    expect(validateTuning(clone())).toEqual([]);
  });

  it('AC-45: enabled: false のミニゲームは 100 回出題しても一度も出ない', () => {
    const t = clone();
    t.micro.mash.enabled = false;
    t.micro.timing.enabled = false;
    expect(enabledMicroIds(t)).not.toContain('mash');
    let prev: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      prev = nextMicroId(prev, t);
      seen.add(prev);
    }
    expect(seen.has('mash')).toBe(false);
    expect(seen.has('timing')).toBe(false);
    expect(seen.size).toBeGreaterThanOrEqual(2);
    // 既定（全部有効）なら全種類が出る
    expect(enabledMicroIds()).toEqual(Object.keys(TUNING.micro));
  });
});
