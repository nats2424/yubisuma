import { useCallback, useRef, useState } from 'react';
import { useTicker } from '../../components/ui';
import { microMeta, type MicroResult, type MicroRound } from './core';
import { MICRO_COMPONENTS } from './registry';
import { TUNING } from './tuning';

type Props = {
  round: MicroRound;
  playing: boolean;
  now: () => number;
  onSubmit: (r: MicroResult) => void;
  // ホストが既に受け取っている自分の結果（リロード時など）
  existing?: MicroResult;
  label?: string;
  waitingMessage?: string;
  // true なら判定表示を出したままにする（ひとり用：親が次へ進める）
  holdVerdict?: boolean;
};

// 終わった直後、ゲーム画面に判定を重ねて見せる時間
export const VERDICT_MS = TUNING.stage.verdictMs;

// 瞬間ミニゲーム1本分の進行：指示表示 → プレイ → 結果待ち
export default function MicroStage({ round, playing, now, onSubmit, existing, label, waitingMessage = 'みんなを待っています', holdVerdict = false }: Props) {
  useTicker(100);
  const meta = microMeta(round.microId);
  const Game = MICRO_COMPONENTS[round.microId];
  const [local, setLocal] = useState<{ seed: number; result: MicroResult; at: number } | null>(null);
  const sent = useRef<number | null>(null);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  // プレイ開始時に決めた制限時間（再描画のたびに変わらないよう固定）
  const playDuration = useRef<{ seed: number; ms: number } | null>(null);

  // 子ゲームのタイマーがリセットされないよう、seed ごとに同一の関数を渡す
  const done = useCallback(
    (r: MicroResult) => {
      if (sent.current === round.seed) return;
      sent.current = round.seed;
      setLocal({ seed: round.seed, result: r, at: Date.now() });
      submitRef.current(r);
    },
    [round.seed],
  );

  const t = now();
  const myResult = local?.seed === round.seed ? local.result : (existing ?? null);

  if (t < round.startAt) {
    const sec = Math.ceil((round.startAt - t) / 1000);
    return (
      <div className="micro-intro">
        {label && <p className="micro-label">{label}</p>}
        <p className="micro-title">{meta.title}</p>
        <p className="micro-hint">{meta.hint}</p>
        <p className="micro-count">{sec}</p>
      </div>
    );
  }

  if (!playing) {
    return (
      <div className="micro-intro">
        <p className="micro-title">{meta.title}</p>
        <p className="micro-hint">観戦中…</p>
      </div>
    );
  }

  // 直後はゲーム画面をそのまま残し、判定を重ねて表示（自分の結果が見えるように）
  const showVerdict =
    local?.seed === round.seed && (holdVerdict || Date.now() - local.at < VERDICT_MS) && playDuration.current?.seed === round.seed;

  if (myResult && !showVerdict) {
    return (
      <div className={`micro-intro ${myResult.success ? 'ok' : 'ng'}`}>
        <p className="micro-title">{myResult.success ? 'クリア！' : 'ミス！'}</p>
        {waitingMessage && <p className="micro-hint">{waitingMessage}</p>}
      </div>
    );
  }

  // 開始に遅れて画面を開いた場合は残り時間だけ遊ぶ
  if (playDuration.current?.seed !== round.seed) {
    playDuration.current = { seed: round.seed, ms: Math.max(TUNING.stage.minPlayMs, round.startAt + round.duration - t) };
  }
  return (
    <div className="micro-play">
      <p className="micro-title-sm">{meta.title}</p>
      <div className="micro-frozen">
        <Game key={round.seed} seed={round.seed} duration={playDuration.current.ms} onDone={done} />
        {showVerdict && myResult && (
          <div className={`micro-verdict ${myResult.success ? 'ok' : 'ng'}`}>
            <span>{myResult.success ? 'クリア！' : 'ミス！'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
