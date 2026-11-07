import { Panel, nameOf } from '../../components/ui';
import Hearts from '../micro/Hearts';
import MicroStage from '../micro/MicroStage';
import StageTrack from '../micro/StageTrack';
import { speedForStage } from '../micro/core';
import type { GameViewProps } from '../types';
import { alive, ranking, type RushAction, type RushState } from './logic';

export default function RushView({ state: s, me, players, send, now }: GameViewProps<RushState, RushAction>) {
  const startLives = s.startLives;
  const meAlive = s.lives[me] > 0;
  const rank = ranking(s);

  if (s.phase === 'over') {
    const top = s.cleared[rank[0]];
    return (
      <Panel title="ゲームオーバー">
        <ol className="ranking">
          {rank.map((id) => (
            <li key={id} className={s.cleared[id] === top ? 'first' : ''}>
              <span>
                {s.cleared[id] === top && top > 0 && '🏆 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">{s.cleared[id]}ステージ クリア</span>
            </li>
          ))}
        </ol>
      </Panel>
    );
  }

  const speedUp = s.stage > 1 && speedForStage(s.stage) > speedForStage(s.stage - 1);
  return (
    <div className="stack">
      <div className="rush-header">
        <span className="stage-wrap">
          <span className="stage-no">STAGE {s.stage}</span>
          <StageTrack stage={s.stage} />
        </span>
        {s.order.includes(me) && <Hearts lives={s.lives[me] ?? 0} max={startLives} />}
      </div>

      {s.phase === 'play' ? (
        <MicroStage
          round={s.round}
          playing={meAlive}
          now={now}
          existing={s.round.results[me]}
          label={speedUp ? 'SPEED UP!' : `STAGE ${s.stage}`}
          waitingMessage={alive(s).length > 1 ? 'みんなを待っています' : ''}
          missNote="ライフが1つ減った"
          onSubmit={(result) => send({ type: 'submit', result })}
        />
      ) : (
        <div className={`micro-intro ${s.lastFailed.includes(me) ? 'ng' : meAlive ? 'ok' : ''}`}>
          <p className="micro-title">
            {s.lastFailed.includes(me) ? (s.lives[me] > 0 ? 'ミス！' : 'ゲームオーバー') : meAlive ? 'クリア！' : '観戦中'}
          </p>
          <p className="micro-hint">残り {alive(s).length}人</p>
        </div>
      )}

      <Panel title={`残り ${alive(s).length}人`}>
        <ul className="tally">
          {rank.map((id) => (
            <li key={id} className={s.lives[id] > 0 ? '' : 'out'}>
              <span>
                {nameOf(players, id)}
                {s.phase === 'result' && s.lastFailed.includes(id) && <span className="tag bad">ミス</span>}
                {s.phase === 'play' && s.lives[id] > 0 && id in s.round.results && <span className="tag good">済</span>}
              </span>
              <Hearts lives={s.lives[id]} max={startLives} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
