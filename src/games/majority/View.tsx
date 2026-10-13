import { Countdown, Panel, Spectating, nameOf } from '../../components/ui';
import type { GameViewProps } from '../types';
import { type Choice, type MajorityAction, type MajorityState } from './logic';

export default function MajorityView({ state: s, me, players, send, now }: GameViewProps<MajorityState, MajorityAction>) {
  const q = s.questions[s.round - 1];
  const playing = s.order.includes(me);
  const mine = s.answers[me];
  const ranking = [...s.order].sort((a, b) => s.scores[b] - s.scores[a]);

  if (s.phase === 'over') {
    const top = s.scores[ranking[0]];
    return (
      <Panel title="最終結果">
        <ol className="ranking">
          {ranking.map((id) => (
            <li key={id} className={s.scores[id] === top ? 'first' : ''}>
              <span>
                {s.scores[id] === top && '🏆 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">{s.scores[id]}pt</span>
            </li>
          ))}
        </ol>
        <p className="hint">多数派を当てるほど「世間の感覚」に近い人です。</p>
      </Panel>
    );
  }

  const names = (c: Choice) =>
    s.order.filter((id) => s.answers[id] === c).map((id) => nameOf(players, id));

  return (
    <div className="stack">
      <Panel
        title={`Q${s.round}/${s.rounds}`}
        aside={
          s.phase === 'answer' ? (
            <Countdown until={s.until} now={now} label="残り" />
          ) : (
            <span className="pill">{s.majority ? '多数派に+1pt' : '同数のためポイントなし'}</span>
          )
        }
      >
        <p className="question">{q.q}</p>
        <p className="hint">みんなが選びそうな方を選ぼう。多数派になれば得点。</p>
        <div className="ab">
          {(['a', 'b'] as const).map((c) => {
            const label = c === 'a' ? q.a : q.b;
            const isMajority = s.phase === 'reveal' && s.majority === c;
            return (
              <button
                key={c}
                className={`ab-option${mine === c ? ' selected' : ''}${isMajority ? ' majority' : ''}`}
                disabled={!playing || s.phase !== 'answer'}
                onClick={() => send({ type: 'answer', choice: c })}
              >
                <span className="ab-label">{label}</span>
                {s.phase === 'reveal' && (
                  <span className="ab-count">
                    {names(c).length}人<small>{names(c).join('、')}</small>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {s.phase === 'answer' && (
          <p className="notice">
            回答 {Object.keys(s.answers).length}/{s.order.length}
            {mine && '（変更できます）'}
          </p>
        )}
        {s.phase === 'reveal' && playing && (
          <button className="btn primary" onClick={() => send({ type: 'next' })}>
            {s.round >= s.rounds ? '結果を見る' : '次の質問へ'}
          </button>
        )}
      </Panel>
      {!playing && <Spectating />}
      <Panel title="スコア">
        <ul className="tally">
          {ranking.map((id) => (
            <li key={id}>
              <span>{nameOf(players, id)}</span>
              <span className="mono">{s.scores[id]}pt</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
