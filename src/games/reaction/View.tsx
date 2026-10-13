import { useLayoutEffect, useRef } from 'react';
import { Panel, Spectating, nameOf } from '../../components/ui';
import type { GameViewProps } from '../types';
import { PENALTY_MS, ROUNDS, totals, type Outcome, type ReactionAction, type ReactionState } from './logic';

const fmt = (o: Outcome | undefined) =>
  o === undefined ? '—' : o === 'foul' ? 'フライング' : o === 'miss' ? '押し忘れ' : `${o}ms`;

export default function ReactionView({ state: s, me, players, send }: GameViewProps<ReactionState, ReactionAction>) {
  const goSeenAt = useRef<number | null>(null);
  const playing = s.order.includes(me);
  const mine = s.current[me];

  // 「押せ！」が画面に出た瞬間を自分の端末の時計で記録する（通信遅延の影響を受けない）
  useLayoutEffect(() => {
    goSeenAt.current = s.phase === 'go' ? performance.now() : null;
  }, [s.phase, s.round]);

  const onTap = () => {
    if (!playing || mine !== undefined) return;
    if (s.phase === 'go' && goSeenAt.current !== null) {
      send({ type: 'tap', ms: performance.now() - goSeenAt.current });
    } else if (s.phase === 'wait' || s.phase === 'ready') {
      send({ type: 'early' });
    }
  };

  const total = totals(s);
  const ranking = [...s.order].sort((a, b) => total[a] - total[b]);

  if (s.phase === 'over') {
    return (
      <Panel title="最終結果">
        <ol className="ranking">
          {ranking.map((id, i) => (
            <li key={id} className={i === 0 ? 'first' : ''}>
              <span>
                {i === 0 && '🏆 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">{total[id]}ms</span>
            </li>
          ))}
        </ol>
        <p className="hint">{ROUNDS}回の反応時間の合計。フライング・押し忘れは{PENALTY_MS}ms扱い。</p>
      </Panel>
    );
  }

  const padState =
    s.phase === 'go' ? 'go' : s.phase === 'wait' ? 'wait' : s.phase === 'ready' ? 'ready' : 'result';
  const padText =
    mine === 'foul'
      ? 'フライング！'
      : typeof mine === 'number'
        ? `${mine}ms`
        : s.phase === 'ready'
          ? `ROUND ${s.round}`
          : s.phase === 'wait'
            ? '待って…'
            : s.phase === 'go'
              ? '押せ！'
              : '—';

  return (
    <div className="stack">
      {playing ? (
        <button className={`reaction-pad ${padState}${mine !== undefined ? ' done' : ''}`} onPointerDown={onTap}>
          <span className="reaction-round">
            {s.round}/{ROUNDS}
          </span>
          <span className="reaction-text">{padText}</span>
          {s.phase === 'wait' && mine === undefined && <span className="reaction-sub">緑になったらタップ</span>}
        </button>
      ) : (
        <Spectating />
      )}

      <Panel title={s.phase === 'result' ? `ROUND ${s.round} の結果` : '途中経過'}>
        <ul className="tally">
          {ranking.map((id) => (
            <li key={id}>
              <span>{nameOf(players, id)}</span>
              <span className="mono">
                {s.phase === 'result' ? fmt(s.current[id]) : id in s.current ? fmt(s.current[id]) : ''}
                <span className="muted"> 計{total[id]}ms</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
