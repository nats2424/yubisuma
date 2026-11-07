import { useEffect, useRef, useState } from 'react';
import type { MicroResult } from './core';

// マウントからの経過ミリ秒（毎フレーム更新）
export function useElapsed(running = true) {
  const start = useRef(performance.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    let id = 0;
    const loop = () => {
      setElapsed(performance.now() - start.current);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [running]);
  return elapsed;
}

// 制限時間になったら最新の結果で終了する
export function useTimeUp(duration: number, getResult: () => MicroResult, onDone: (r: MicroResult) => void) {
  const latest = useRef(getResult);
  latest.current = getResult;
  useEffect(() => {
    const id = setTimeout(() => onDone(latest.current()), duration);
    return () => clearTimeout(id);
  }, [duration, onDone]);
}

export type MicroProps = {
  seed: number;
  duration: number;
  onDone: (r: MicroResult) => void;
};
