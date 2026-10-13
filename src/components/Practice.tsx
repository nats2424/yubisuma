import { useState } from 'react';
import { MICRO_META, startMicroRound, type MicroResult, type MicroRound } from '../games/micro/core';
import MicroStage from '../games/micro/MicroStage';
import { Brand } from './Layout';
import { Panel } from './ui';

const now = () => Date.now();

// 瞬間ミニゲームをひとりで試せるページ（通信なし）
export default function Practice() {
  const [round, setRound] = useState<MicroRound | null>(null);
  const [result, setResult] = useState<MicroResult | null>(null);
  const [random, setRandom] = useState(false);
  const [best, setBest] = useState<Record<string, number>>({});

  const play = (id: string, isRandom = random) => {
    setRandom(isRandom);
    setResult(null);
    setRound(startMicroRound(id, now()));
  };
  const playRandom = () => {
    const pool = MICRO_META.filter((m) => m.id !== round?.microId);
    play(pool[Math.floor(Math.random() * pool.length)].id, true);
  };
  const onSubmit = (r: MicroResult) => {
    if (!round) return;
    setResult(r);
    setBest((b) => ({ ...b, [round.microId]: Math.max(b[round.microId] ?? 0, r.score) }));
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <a className="btn small ghost" href="#/">
          トップへ
        </a>
      </header>
      <main className="practice-main">
        {round ? (
          <div className="stack">
            <MicroStage key={round.seed} round={round} playing now={now} onSubmit={onSubmit} label="練習" waitingMessage="" />
            {result && (
              <div className="row practice-actions">
                <button className="btn primary" onClick={() => (random ? playRandom() : play(round.microId))}>
                  {random ? '次のゲーム' : 'もう一度'}
                </button>
                <button className="btn" onClick={() => setRound(null)}>
                  一覧へ
                </button>
              </div>
            )}
          </div>
        ) : (
          <Panel title="瞬間ミニゲームを練習" aside={<button className="btn small primary" onClick={playRandom}>ランダムで連続プレイ</button>}>
            <p className="hint">ミニゲームラッシュで出てくるゲームを、ひとりで試せます。</p>
            <div className="practice-grid">
              {MICRO_META.map((m) => (
                <button key={m.id} className="game-option" onClick={() => play(m.id, false)}>
                  <span className="game-name">{m.title}</span>
                  <span className="game-meta">{m.hint}</span>
                  {best[m.id] !== undefined && <span className="tag good">ベスト {best[m.id]}</span>}
                </button>
              ))}
            </div>
          </Panel>
        )}
      </main>
    </div>
  );
}
