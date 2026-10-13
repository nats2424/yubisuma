import { Panel, nameOf } from '../../components/ui';
import { microMeta, resultOf } from '../micro/core';
import MicroStage from '../micro/MicroStage';
import type { GameViewProps } from '../types';
import { speedAt, type RushAction, type RushState } from './logic';

export default function RushView({ state: s, me, players, send, now }: GameViewProps<RushState, RushAction>) {
  const playing = s.order.includes(me);
  const ranking = [...s.order].sort((a, b) => s.points[b] - s.points[a]);
  const total = s.playlist.length;

  if (s.phase === 'over') {
    const top = s.points[ranking[0]];
    return (
      <Panel title="最終結果">
        <ol className="ranking">
          {ranking.map((id) => (
            <li key={id} className={s.points[id] === top ? 'first' : ''}>
              <span>
                {s.points[id] === top && '🏆 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">{s.points[id]}pt</span>
            </li>
          ))}
        </ol>
        <p className="hint">成功で1pt、成功者の中でトップスコアならさらに1pt。</p>
      </Panel>
    );
  }

  const speed = speedAt(s.stage);
  return (
    <div className="stack">
      <div className="rush-header">
        <span className="pill">
          STAGE {s.stage}/{total}
        </span>
        {speed > 1 && <span className="pill">SPEED ×{speed.toFixed(2)}</span>}
      </div>

      {s.phase === 'play' ? (
        <MicroStage
          round={s.round}
          playing={playing}
          now={now}
          existing={s.round.results[me]}
          label={`STAGE ${s.stage}`}
          onSubmit={(result) => send({ type: 'submit', result })}
        />
      ) : (
        <Panel title={`STAGE ${s.stage}「${microMeta(s.round.microId).title}」の結果`}>
          <ul className="tally">
            {s.order.map((id) => {
              const r = resultOf(s.round, id);
              return (
                <li key={id}>
                  <span>
                    {nameOf(players, id)}
                    {s.lastTop.includes(id) && <span className="tag good">TOP +1</span>}
                  </span>
                  <span className={r.success ? 'ok-text' : 'muted'}>
                    {r.success ? '成功' : '失敗'} <span className="mono muted">{r.score}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <Panel title="スコア">
        <ul className="tally">
          {ranking.map((id) => (
            <li key={id}>
              <span>{nameOf(players, id)}</span>
              <span className="mono">
                {s.phase === 'play' && (id in s.round.results ? '✓ ' : '… ')}
                {s.points[id]}pt
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
