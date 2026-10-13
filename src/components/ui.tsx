import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GamePlayer } from '../games/types';

// 一定間隔で再描画する（カウントダウン表示用）
export function useTicker(intervalMs = 250) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function Countdown({ until, now, label }: { until: number; now: () => number; label?: string }) {
  useTicker(250);
  const remain = Math.max(0, Math.ceil((until - now()) / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return (
    <span className={`countdown${remain <= 10 ? ' urgent' : ''}`}>
      {label && <span className="countdown-label">{label}</span>}
      {m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}秒`}
    </span>
  );
}

export const nameOf = (players: GamePlayer[], id: string) => players.find((p) => p.id === id)?.name ?? '???';

export function Panel({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {(title || aside) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spectating() {
  return <p className="notice">観戦中です。次のゲームから参加できます。</p>;
}

// confirm() が使えない環境（埋め込み表示など）でも動く2段階確認ボタン
export function ConfirmButton({
  className,
  label,
  confirmLabel,
  onConfirm,
}: {
  className: string;
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const click = () => {
    if (armed) {
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 3000);
  };
  return (
    <button className={`${className}${armed ? ' armed' : ''}`} onClick={click}>
      {armed ? confirmLabel : label}
    </button>
  );
}
