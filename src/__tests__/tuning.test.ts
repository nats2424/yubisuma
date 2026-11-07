import { describe, expect, it } from 'vitest';
import { LIVES, MICRO_META, speedForStage as legacySpeedForStage } from '../games/micro/core';
import { VERDICT_MS } from '../games/micro/MicroStage';
import { TUNING, speedForStage, speedUpRuleText } from '../games/micro/tuning';

describe('tuning', () => {
  it('speedUpRuleText() が「5ステージごと」を含む', () => {
    expect(speedUpRuleText()).toContain('5ステージごと');
    expect(speedUpRuleText({ ...TUNING, speed: { ...TUNING.speed, everyStages: 3 } })).toContain('3ステージごと');
  });

  it('speedForStage が core.ts の旧実装と 1〜30 ステージで同じ値を返す', () => {
    for (let stage = 1; stage <= 30; stage++) {
      expect(speedForStage(stage)).toBe(legacySpeedForStage(stage));
    }
  });

  it('現行コードの直書きと同じ値を持つ（B-20 の置き換えで挙動が変わらないように）', () => {
    expect(TUNING.lives.default).toBe(LIVES);
    expect(TUNING.stage.verdictMs).toBe(VERDICT_MS);
    for (const m of MICRO_META) {
      expect(TUNING.micro[m.id as keyof typeof TUNING.micro]).toMatchObject({ baseMs: m.baseMs, scales: m.scales });
    }
    expect(Object.keys(TUNING.micro).sort()).toEqual(MICRO_META.map((m) => m.id).sort());
  });
});
