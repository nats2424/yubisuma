import { useEffect, useRef, useState } from 'react';
import {
  LIVES,
  MICRO_META,
  microMeta,
  nextMicroId,
  speedForStage,
  startMicroRound,
  type MicroResult,
  type MicroRound,
} from '../games/micro/core';
import Hearts from '../games/micro/Hearts';
import MicroStage from '../games/micro/MicroStage';
import { Brand } from './Layout';
import { Panel } from './ui';

const now = () => Date.now();
// ひとり用は通信がないのでテンポよく
const INTRO_MS = 1300;
const FLASH_MS = 900;
const BEST_KEY = 'sukima:challengeBest';

const loadBest = () => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};
const saveBest = (n: number) => {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {
    // 保存できなくても続行
  }
};

type Mode =
  | { kind: 'title' }
  | { kind: 'challenge'; stage: number; lives: number; round: MicroRound; flash: MicroResult | null }
  | { kind: 'over'; cleared: number; newBest: boolean }
  | { kind: 'single'; round: MicroRound; result: MicroResult | null };

// ひとりで遊ぶページ：ライフ制で何ステージまで行けるか挑戦。1つずつの練習もできる
export default function Practice() {
  const [mode, setMode] = useState<Mode>({ kind: 'title' });
  const [best, setBest] = useState(loadBest);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const startChallenge = () =>
    setMode({ kind: 'challenge', stage: 1, lives: LIVES, round: startMicroRound(nextMicroId(), now(), 1, INTRO_MS), flash: null });

  const onChallengeResult = (r: MicroResult) => {
    if (mode.kind !== 'challenge') return;
    const lives = r.success ? mode.lives : mode.lives - 1;
    const { stage, round } = mode;
    setMode({ ...mode, lives, flash: r });
    timer.current = setTimeout(() => {
      if (lives <= 0) {
        const cleared = stage - 1;
        const newBest = cleared > best;
        if (newBest) {
          setBest(cleared);
          saveBest(cleared);
        }
        setMode({ kind: 'over', cleared, newBest });
        return;
      }
      const next = stage + 1;
      setMode({
        kind: 'challenge',
        stage: next,
        lives,
        round: startMicroRound(nextMicroId(round.microId), now(), speedForStage(next), INTRO_MS),
        flash: null,
      });
    }, FLASH_MS);
  };

  const playSingle = (id: string) => setMode({ kind: 'single', round: startMicroRound(id, now(), 1, INTRO_MS), result: null });

  let body;
  if (mode.kind === 'challenge') {
    const speedUp = mode.stage > 1 && speedForStage(mode.stage) > speedForStage(mode.stage - 1);
    body = (
      <div className="stack">
        <div className="rush-header">
          <span className="stage-no">STAGE {mode.stage}</span>
          <Hearts lives={mode.lives} max={LIVES} />
        </div>
        {mode.flash ? (
          <div className={`micro-intro ${mode.flash.success ? 'ok' : 'ng'}`}>
            <p className="micro-title">{mode.flash.success ? 'クリア！' : mode.lives > 0 ? 'ミス！' : 'ゲームオーバー'}</p>
          </div>
        ) : (
          <MicroStage
            key={mode.round.seed}
            round={mode.round}
            playing
            now={now}
            onSubmit={onChallengeResult}
            label={speedUp ? 'SPEED UP!' : `STAGE ${mode.stage}`}
          />
        )}
      </div>
    );
  } else if (mode.kind === 'over') {
    body = (
      <div className="challenge-over">
        <p className="micro-label">GAME OVER</p>
        <p className="challenge-record">
          {mode.cleared}
          <small>ステージ クリア</small>
        </p>
        <p className="muted">{mode.newBest ? '自己ベスト更新！' : `自己ベスト ${best}ステージ`}</p>
        <div className="row practice-actions">
          <button className="btn primary" onClick={startChallenge}>
            もう一度
          </button>
          <button className="btn" onClick={() => setMode({ kind: 'title' })}>
            戻る
          </button>
        </div>
      </div>
    );
  } else if (mode.kind === 'single') {
    body = (
      <div className="stack">
        <MicroStage
          key={mode.round.seed}
          round={mode.round}
          playing
          now={now}
          label="練習"
          waitingMessage=""
          onSubmit={(r) => setMode({ ...mode, result: r })}
        />
        {mode.result && (
          <div className="row practice-actions">
            <button className="btn primary" onClick={() => playSingle(mode.round.microId)}>
              もう一度
            </button>
            <button className="btn" onClick={() => setMode({ kind: 'title' })}>
              戻る
            </button>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <div className="stack">
        <section className="challenge-hero">
          <p className="micro-label">ひとりでチャレンジ</p>
          <h1>どこまで行ける？</h1>
          <p className="muted">
            数秒のミニゲームが次々に出ます。失敗するとライフが減り、{LIVES}回ミスでゲームオーバー。5ステージごとにスピードアップ。
          </p>
          <button className="btn primary challenge-start" onClick={startChallenge}>
            スタート
          </button>
          {best > 0 && <p className="muted">自己ベスト {best}ステージ</p>}
        </section>
        <Panel title="1つずつ練習">
          <div className="practice-grid">
            {MICRO_META.map((m) => (
              <button key={m.id} className="game-option" onClick={() => playSingle(m.id)}>
                <span className="game-name">{microMeta(m.id).title}</span>
                <span className="game-meta">{m.hint}</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <a className="btn small ghost" href="#/">
          トップへ
        </a>
      </header>
      <main className="practice-main">{body}</main>
    </div>
  );
}
