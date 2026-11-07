import type { ComponentType } from 'react';
import { Balloon, Dodge, Mash, Stop, Whack } from './action';
import { ColorWord, Count, MathQuiz, Odd, Timing } from './brain';
import type { MicroProps } from './hooks';

export const MICRO_COMPONENTS: Record<string, ComponentType<MicroProps>> = {
  mash: Mash,
  stop: Stop,
  whack: Whack,
  dodge: Dodge,
  balloon: Balloon,
  count: Count,
  color: ColorWord,
  math: MathQuiz,
  odd: Odd,
  timing: Timing,
};
