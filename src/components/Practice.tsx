import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MICRO_META, microMeta, nextMicroId, startMicroRound, type MicroResult, type MicroRound } from '../games/micro/core';
import Hearts from '../games/micro/Hearts';
import MicroStage from '../games/micro/MicroStage';
import StageTrack from '../games/micro/StageTrack';
import { speedForStage, speedUpRuleText, TUNING } from '../games/micro/tuning';
import { goRoom } from '../App';
import { generateRoomCode, getSavedName, NAME_MAX, saveName } from '../lib/identity';
import { Brand } from './Layout';
import { practiceUrl, recordText, shareOrCopy } from './share';
import { Panel } from './ui';

const now = () => Date.now();
// 調整値は tuning.ts に集約している（AC-41）。ひとり用は通信がないので開始前表示を短めにしてある
const INTRO_MS = TUNING.solo.introMs;
const LIVES = TUNING.lives.default;
const VERDICT_MS = TUNING.stage.verdictMs;
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
  | { kind: 'challenge'; stage: number; lives: number; cleared: number; round: MicroRound }
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
    setMode({ kind: 'challenge', stage: 1, lives: LIVES, cleared: 0, round: startMicroRound(nextMicroId(), now(), 1, INTRO_MS) });

  const onChallengeResult = (r: MicroResult) => {
    if (mode.kind !== 'challenge') return;
    const lives = r.success ? mode.lives : mode.lives - 1;
    // 記録は実際にクリアしたゲームの数
    const cleared = r.success ? mode.cleared + 1 : mode.cleared;
    const { stage, round } = mode;
    setMode({ ...mode, lives, cleared });
    // ゲーム画面に判定を重ねて見せてから次へ
    timer.current = setTimeout(() => {
      if (lives <= 0) {
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
        cleared,
        round: startMicroRound(nextMicroId(round.microId), now(), speedForStage(next), INTRO_MS),
      });
    }, VERDICT_MS);
  };

  const playSingle = (id: string) => setMode({ kind: 'single', round: startMicroRound(id, now(), 1, INTRO_MS), result: null });

  let body;
  if (mode.kind === 'challenge') {
    const speedUp = mode.stage > 1 && speedForStage(mode.stage) > speedForStage(mode.stage - 1);
    body = (
      <div className="stack">
        <div className="rush-header">
          <span className="stage-wrap">
            <span className="stage-no">
              STAGE {mode.stage}
              <small> クリア {mode.cleared}</small>
            </span>
            <StageTrack stage={mode.stage} />
          </span>
          <Hearts lives={mode.lives} max={LIVES} />
        </div>
        <MicroStage
          key={mode.round.seed}
          round={mode.round}
          playing
          now={now}
          waitingMessage=""
          holdVerdict
          missNote="ライフが1つ減った"
          onSubmit={onChallengeResult}
          label={speedUp ? 'SPEED UP!' : `STAGE ${mode.stage}`}
        />
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
        <OverExtras cleared={mode.cleared} />
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
          holdVerdict
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
            数秒のミニゲームが次々に出ます。失敗するとライフが減り、{LIVES}回ミスでゲームオーバー。{speedUpRuleText()}。
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

// ゲームオーバー画面の「広める」導線：記録の共有（J-05）と、ラッシュで友達と勝負する部屋作り（J-06）
function OverExtras({ cleared }: { cleared: number }) {
  const [note, setNote] = useState('');
  // 名前が保存されていなければ、部屋を作る前に名前だけ聞く（トップに戻らずに済むように）
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState(getSavedName);

  const shareRecord = async () => {
    const r = await shareOrCopy({ title: 'SUKIMA', text: recordText(cleared), url: practiceUrl() });
    if (r === 'copied') setNote('記録をコピーしました。LINEなどに貼り付けてください');
    else if (r === 'failed') setNote(`コピーできませんでした：${practiceUrl()}`);
  };

  const createRoom = () => goRoom(generateRoomCode(), true, 'rush');
  const versus = () => {
    if (getSavedName().trim()) createRoom();
    else setAsking(true);
  };
  const submitName = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    saveName(n);
    createRoom();
  };

  return (
    <div className="over-extras">
      {asking ? (
        <form className="panel entry versus-name" onSubmit={submitName}>
          <label className="field">
            <span className="label">ニックネーム</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder={`${NAME_MAX}文字まで`}
              autoComplete="nickname"
              autoFocus
            />
          </label>
          <button className="btn primary block" type="submit" disabled={!name.trim()}>
            ラッシュの部屋を作る
          </button>
        </form>
      ) : (
        // 「もう一度」が主ボタンなので、ここは白いボタンにして主従を分ける
        <button className="btn block" onClick={versus}>
          友達と勝負する
          <small className="btn-sub">ミニゲームラッシュで</small>
        </button>
      )}
      <button className="btn block" onClick={shareRecord}>
        記録を共有
      </button>
      <p className="invite-note" role="status" aria-live="polite">
        {note}
      </p>
    </div>
  );
}
