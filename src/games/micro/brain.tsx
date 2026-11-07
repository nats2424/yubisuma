import { useMemo, useState } from 'react';
import { randInt, rng } from './core';
import { useElapsed, useTimeUp, type MicroProps } from './hooks';

function TimeBar({ elapsed, duration }: { elapsed: number; duration: number }) {
  return (
    <div className="micro-timebar">
      <span style={{ width: `${Math.max(0, 100 - (elapsed / duration) * 100)}%` }} />
    </div>
  );
}

const shuffleWith = <T,>(r: () => number, arr: T[]) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// かぞえろ：一瞬表示されるマークの数を答える
export function Count({ seed, duration, onDone }: MicroProps) {
  const q = useMemo(() => {
    const r = rng(seed);
    const n = randInt(r, 5, 12);
    const icon = ['⭐', '🍎', '🐟', '🎲', '🍺'][randInt(r, 0, 4)];
    const dots = Array.from({ length: n }, () => ({ x: 6 + r() * 82, y: 12 + r() * 70 }));
    const options = shuffleWith(r, [n, n + (r() < 0.5 ? 1 : -1), n + (r() < 0.5 ? 2 : -2)]);
    return { n, icon, dots, options };
  }, [seed]);
  const showMs = Math.min(1600, duration * 0.3);
  const elapsed = useElapsed();
  const [answer, setAnswer] = useState<number | null>(null);
  useTimeUp(duration, () => ({ score: 0, success: false }), onDone);
  const choose = (v: number) => {
    if (answer !== null) return;
    setAnswer(v);
    const ok = v === q.n;
    onDone({ score: ok ? Math.max(1, Math.round(duration - elapsed)) : 0, success: ok });
  };
  return (
    <div className="micro-stage">
      <TimeBar elapsed={elapsed} duration={duration} />
      {elapsed < showMs ? (
        q.dots.map((d, i) => (
          <span key={i} className="count-dot" style={{ left: `${d.x}%`, top: `${d.y}%` }}>
            {q.icon}
          </span>
        ))
      ) : (
        <div className="micro-choices">
          <p>{q.icon} はいくつ？</p>
          <div className="row">
            {q.options.map((v) => (
              <button key={v} className="choice" onPointerDown={() => choose(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const COLORS = [
  { name: 'あか', css: '#e04a3f' },
  { name: 'あお', css: '#2f6fe0' },
  { name: 'みどり', css: '#2f9e5b' },
  { name: 'きいろ', css: '#e0b11f' },
];

// 文字の色：ストループ課題。正解数を競う
export function ColorWord({ seed, duration, onDone }: MicroProps) {
  const questions = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: 30 }, () => {
      const word = randInt(r, 0, 3);
      let ink = randInt(r, 0, 3);
      if (ink === word) ink = (ink + 1 + randInt(r, 0, 2)) % 4;
      return { word, ink };
    });
  }, [seed]);
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [miss, setMiss] = useState(0);
  const elapsed = useElapsed();
  useTimeUp(duration, () => ({ score: Math.max(0, correct - miss), success: correct >= 3 && miss === 0 }), onDone);
  const q = questions[idx % questions.length];
  const pick = (i: number) => {
    if (i === q.ink) setCorrect((c) => c + 1);
    else setMiss((m) => m + 1);
    setIdx((n) => n + 1);
  };
  return (
    <div className="micro-stage center-col">
      <TimeBar elapsed={elapsed} duration={duration} />
      <p className="color-word" style={{ color: COLORS[q.ink].css }}>
        {COLORS[q.word].name}
      </p>
      <div className="color-buttons">
        {COLORS.map((c, i) => (
          <button key={c.name} style={{ background: c.css }} onPointerDown={() => pick(i)} aria-label={c.name} />
        ))}
      </div>
      <p className="muted">
        正解 {correct}　ミス {miss}
      </p>
    </div>
  );
}

// 計算：3択の暗算を時間内にできるだけ多く
export function MathQuiz({ seed, duration, onDone }: MicroProps) {
  const questions = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: 30 }, () => {
      const op = randInt(r, 0, 2);
      const a = op === 1 ? randInt(r, 2, 9) : randInt(r, 11, 59);
      const b = op === 1 ? randInt(r, 2, 9) : randInt(r, 3, 39);
      const ans = op === 0 ? a + b : op === 1 ? a * b : a - b;
      const text = `${a} ${['+', '×', '−'][op]} ${b}`;
      const options = shuffleWith(r, [ans, ans + (op === 1 ? a : 10) * (r() < 0.5 ? 1 : -1), ans + (r() < 0.5 ? 1 : -1) * randInt(r, 1, 3)]);
      return { text, ans, options };
    });
  }, [seed]);
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [miss, setMiss] = useState(0);
  const elapsed = useElapsed();
  useTimeUp(duration, () => ({ score: Math.max(0, correct - miss), success: correct >= 3 && correct > miss }), onDone);
  const q = questions[idx % questions.length];
  const pick = (v: number) => {
    if (v === q.ans) setCorrect((c) => c + 1);
    else setMiss((m) => m + 1);
    setIdx((n) => n + 1);
  };
  return (
    <div className="micro-stage center-col">
      <TimeBar elapsed={elapsed} duration={duration} />
      <p className="micro-big small">{q.text}</p>
      <div className="row">
        {q.options.map((v, i) => (
          <button key={`${idx}-${i}`} className="choice wide" onPointerDown={() => pick(v)}>
            {v}
          </button>
        ))}
      </div>
      <p className="muted">
        正解 {correct}　ミス {miss}
      </p>
    </div>
  );
}

const ODD_PAIRS: [string, string][] = [
  ['😀', '😃'],
  ['🍺', '🍻'],
  ['🌕', '🌝'],
  ['🐶', '🐕'],
  ['🍎', '🍅'],
  ['⏰', '⏱️'],
  ['🌲', '🌳'],
  ['🚗', '🚙'],
];

// 仲間はずれ：1つだけ違う絵文字を探す
export function Odd({ seed, duration, onDone }: MicroProps) {
  const q = useMemo(() => {
    const r = rng(seed);
    const [base, odd] = ODD_PAIRS[randInt(r, 0, ODD_PAIRS.length - 1)];
    const size = 25;
    return { base, odd, size, oddAt: randInt(r, 0, size - 1) };
  }, [seed]);
  const [state, setState] = useState<'play' | 'ok' | 'ng'>('play');
  const elapsed = useElapsed(state === 'play');
  useTimeUp(duration, () => ({ score: 0, success: false }), onDone);
  const tap = (i: number) => {
    if (state !== 'play') return;
    const ok = i === q.oddAt;
    setState(ok ? 'ok' : 'ng');
    onDone({ score: ok ? Math.max(1, Math.round(duration - elapsed)) : 0, success: ok });
  };
  return (
    <div className="micro-stage center-col">
      <TimeBar elapsed={elapsed} duration={duration} />
      <div className="odd-grid">
        {Array.from({ length: q.size }, (_, i) => (
          <button key={i} onPointerDown={() => tap(i)} className={state !== 'play' && i === q.oddAt ? 'found' : ''}>
            {i === q.oddAt ? q.odd : q.base}
          </button>
        ))}
      </div>
    </div>
  );
}

// 3秒ぴったり：途中から時間が見えなくなる
export function Timing({ duration, onDone }: MicroProps) {
  const TARGET = 3000;
  const [tapped, setTapped] = useState<number | null>(null);
  const elapsed = useElapsed(tapped === null);
  useTimeUp(duration, () => ({ score: 0, success: false }), onDone);
  const tap = () => {
    if (tapped !== null) return;
    setTapped(elapsed);
    const diff = Math.abs(elapsed - TARGET);
    onDone({ score: Math.max(0, Math.round(3000 - diff)), success: diff <= 250 });
  };
  const shown = tapped ?? elapsed;
  return (
    <div className="micro-stage center-col" onPointerDown={tap}>
      <p className="micro-big mono">{tapped !== null || elapsed < 1000 ? (shown / 1000).toFixed(2) : '?.??'}</p>
      {tapped !== null && <p>{tapped > TARGET ? '+' : '−'}{(Math.abs(tapped - TARGET) / 1000).toFixed(2)}秒</p>}
      <p className="muted">画面のどこでもタップ</p>
    </div>
  );
}
