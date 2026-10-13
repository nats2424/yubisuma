import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { randInt, rng } from './core';
import { useElapsed, useTimeUp, type MicroProps } from './hooks';

function TimeBar({ elapsed, duration }: { elapsed: number; duration: number }) {
  return (
    <div className="micro-timebar">
      <span style={{ width: `${Math.max(0, 100 - (elapsed / duration) * 100)}%` }} />
    </div>
  );
}

// 連打：制限時間内のタップ数
export function Mash({ duration, onDone }: MicroProps) {
  const [count, setCount] = useState(0);
  const elapsed = useElapsed();
  const target = Math.round((duration / 1000) * 5);
  useTimeUp(duration, () => ({ score: count, success: count >= target }), onDone);
  return (
    <div className="micro-stage center-col">
      <TimeBar elapsed={elapsed} duration={duration} />
      <p className="micro-big">{count}</p>
      <p className="muted">目標 {target}回</p>
      <button className="mash-button" onPointerDown={() => setCount((c) => c + 1)}>
        連打！
      </button>
    </div>
  );
}

// 止めろ：往復する針をゾーン内で止める
export function Stop({ seed, duration, onDone }: MicroProps) {
  const { zone, period } = useMemo(() => {
    const r = rng(seed);
    return { zone: 15 + r() * 60, period: 900 + r() * 500 };
  }, [seed]);
  const ZONE_W = 12;
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const elapsed = useElapsed(stoppedAt === null);
  const phase = (elapsed % (period * 2)) / period;
  const pos = (phase < 1 ? phase : 2 - phase) * 100;
  const shown = stoppedAt ?? pos;
  useTimeUp(duration, () => ({ score: 0, success: false }), onDone);

  const tap = () => {
    if (stoppedAt !== null) return;
    setStoppedAt(pos);
    const dist = Math.abs(pos - (zone + ZONE_W / 2));
    onDone({ score: Math.max(0, Math.round(1000 - dist * 20)), success: dist <= ZONE_W / 2 });
  };
  return (
    <div className="micro-stage center-col" onPointerDown={tap}>
      <TimeBar elapsed={elapsed} duration={duration} />
      <div className="stop-bar">
        <span className="stop-zone" style={{ left: `${zone}%`, width: `${ZONE_W}%` }} />
        <span className="stop-needle" style={{ left: `${shown}%` }} />
      </div>
      <p className="muted">画面のどこでもタップで止める</p>
    </div>
  );
}

// タッチ：次々に出る的をタップ
export function Whack({ seed, duration, onDone }: MicroProps) {
  const targets = useMemo(() => {
    const r = rng(seed);
    const life = Math.max(600, duration / 6);
    const list: { t: number; x: number; y: number; life: number }[] = [];
    for (let t = 200; t < duration - 400; t += life * 0.6) list.push({ t, x: 8 + r() * 76, y: 10 + r() * 72, life });
    return list;
  }, [seed, duration]);
  const [hit, setHit] = useState<Set<number>>(new Set());
  const elapsed = useElapsed();
  const need = Math.ceil(targets.length * 0.6);
  useTimeUp(duration, () => ({ score: hit.size, success: hit.size >= need }), onDone);
  return (
    <div className="micro-stage">
      <TimeBar elapsed={elapsed} duration={duration} />
      <span className="micro-corner">
        {hit.size}/{need}
      </span>
      {targets.map((tg, i) =>
        elapsed >= tg.t && elapsed < tg.t + tg.life && !hit.has(i) ? (
          <button
            key={i}
            className="whack-target"
            style={{ left: `${tg.x}%`, top: `${tg.y}%` }}
            onPointerDown={() => setHit((h) => new Set(h).add(i))}
            aria-label="的"
          />
        ) : null,
      )}
    </div>
  );
}

// よけろ：落ちてくる物を左右移動でよける
export function Dodge({ seed, duration, onDone }: MicroProps) {
  const rocks = useMemo(() => {
    const r = rng(seed);
    const list: { t: number; x: number; fall: number }[] = [];
    const gap = Math.max(260, (380 * duration) / 6000);
    for (let t = 300; t < duration - 600; t += gap * (0.6 + r() * 0.8)) list.push({ t, x: 4 + r() * 92, fall: 1100 + r() * 600 });
    return list;
  }, [seed, duration]);
  const [x, setX] = useState(50);
  const [hitAt, setHitAt] = useState<number | null>(null);
  const elapsed = useElapsed(hitAt === null);
  const stage = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useTimeUp(duration, () => ({ score: Math.round(hitAt ?? duration), success: hitAt === null }), onDone);

  const move = (e: PointerEvent) => {
    if (hitAt !== null || !stage.current) return;
    const rect = stage.current.getBoundingClientRect();
    setX(Math.max(4, Math.min(96, ((e.clientX - rect.left) / rect.width) * 100)));
  };

  const PLAYER_Y = 86;
  const visible = rocks
    .map((rk) => ({ ...rk, y: ((elapsed - rk.t) / rk.fall) * 100 }))
    .filter((rk) => rk.y >= -5 && rk.y <= 105);
  if (hitAt === null && !done.current && visible.some((rk) => Math.abs(rk.y - PLAYER_Y) < 6 && Math.abs(rk.x - x) < 7)) {
    done.current = true;
    // 描画中に state を変えないよう次のタイミングで反映
    queueMicrotask(() => setHitAt(elapsed));
  }
  return (
    <div className="micro-stage dodge" ref={stage} onPointerMove={move} onPointerDown={move}>
      <TimeBar elapsed={elapsed} duration={duration} />
      {visible.map((rk, i) => (
        <span key={i} className="rock" style={{ left: `${rk.x}%`, top: `${rk.y}%` }}>
          ●
        </span>
      ))}
      <span className={`dodger${hitAt !== null ? ' hit' : ''}`} style={{ left: `${x}%`, top: `${PLAYER_Y}%` }}>
        {hitAt !== null ? '💥' : '🙂'}
      </span>
    </div>
  );
}

// ふくらませろ：割れる手前で止める（割れる回数は隠れている）
export function Balloon({ seed, duration, onDone }: MicroProps) {
  const limit = useMemo(() => randInt(rng(seed), 12, 28), [seed]);
  const [taps, setTaps] = useState(0);
  const [stopped, setStopped] = useState(false);
  const popped = taps > limit;
  const elapsed = useElapsed(!stopped && !popped);
  const result = () => ({ score: popped ? 0 : taps * 10, success: !popped && taps >= 10 });
  useTimeUp(duration, result, onDone);

  const pump = () => {
    if (stopped || popped) return;
    const next = taps + 1;
    setTaps(next);
    if (next > limit) {
      setStopped(true);
      onDone({ score: 0, success: false });
    }
  };
  const stop = () => {
    if (stopped || popped) return;
    setStopped(true);
    onDone(result());
  };
  return (
    <div className="micro-stage center-col">
      <TimeBar elapsed={elapsed} duration={duration} />
      <button className="balloon" onPointerDown={pump} style={{ transform: `scale(${0.5 + Math.min(taps, 30) * 0.05})` }}>
        {popped ? '💥' : '🎈'}
      </button>
      <p className="micro-big small">{taps}</p>
      <button className="btn" onPointerDown={stop} disabled={stopped || popped}>
        ここでストップ
      </button>
    </div>
  );
}
