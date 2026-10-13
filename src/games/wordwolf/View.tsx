import { useState } from 'react';
import { Countdown, Panel, Spectating, nameOf } from '../../components/ui';
import type { GameViewProps } from '../types';
import { type WordWolfAction, type WordWolfState } from './logic';

export default function WordWolfView({ state: s, me, players, send, now }: GameViewProps<WordWolfState, WordWolfAction>) {
  const [peek, setPeek] = useState(false);
  const playing = s.order.includes(me);
  const myWord = s.words[me];
  const myVote = s.votes[me];
  const reveal = peek || s.phase === 'result';

  return (
    <div className="stack">
      {playing ? (
        <Panel title="あなたのお題" aside={<span className="pill">ウルフ {s.wolves.length}人</span>}>
          <button className={`word-card${reveal ? ' open' : ''}`} onClick={() => setPeek((v) => !v)}>
            {reveal ? myWord : 'タップしてお題を見る'}
          </button>
          <p className="hint">
            お題について話し合い、1人だけ違うお題を持つ「ウルフ」を探しましょう。自分がウルフかもしれません。
          </p>
        </Panel>
      ) : (
        <Spectating />
      )}

      {s.phase === 'talk' && (
        <Panel title="話し合い" aside={<Countdown until={s.talkEndsAt} now={now} label="残り" />}>
          <p className="hint">チャットや通話でお題について話しましょう。お題そのものを言うのはNG。</p>
          {playing && (
            <div className="row">
              <button className="btn" onClick={() => send({ type: 'extend' })}>
                +1分延長
              </button>
              <button className="btn primary" onClick={() => send({ type: 'toVote' })}>
                投票へ進む
              </button>
            </div>
          )}
        </Panel>
      )}

      {s.phase === 'vote' && (
        <Panel title="投票" aside={<span className="pill">{Object.keys(s.votes).length}/{s.order.length}</span>}>
          <p className="hint">ウルフだと思う人に投票してください（変更可）。</p>
          <div className="vote-list">
            {s.order.map((id) => (
              <button
                key={id}
                className={`vote-item${myVote === id ? ' selected' : ''}`}
                disabled={!playing || id === me}
                onClick={() => send({ type: 'vote', target: id })}
              >
                <span>{nameOf(players, id)}</span>
                <span className={`tag${id in s.votes ? ' good' : ''}`}>{id in s.votes ? '投票済' : '未投票'}</span>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {s.phase === 'result' && s.result && (
        <Panel title="結果">
          <div className={`result-banner${s.result.citizensWin ? ' hit' : ' miss'}`}>
            <p className="muted">
              {s.result.executed ? `${nameOf(players, s.result.executed)}さんが選ばれました` : '同票のため誰も選ばれませんでした'}
            </p>
            <p className="big-text">{s.result.citizensWin ? '市民の勝ち！' : 'ウルフの勝ち！'}</p>
            <p>
              ウルフ: <strong>{s.wolves.map((id) => nameOf(players, id)).join('、')}</strong>
            </p>
          </div>
          <dl className="word-reveal">
            <div>
              <dt>市民のお題</dt>
              <dd>{s.citizenWord}</dd>
            </div>
            <div>
              <dt>ウルフのお題</dt>
              <dd>{s.wolfWord}</dd>
            </div>
          </dl>
          <ul className="tally">
            {s.order.map((id) => (
              <li key={id}>
                <span>
                  {nameOf(players, id)}
                  {s.wolves.includes(id) && <span className="tag bad">ウルフ</span>}
                </span>
                <span className="muted">
                  {s.result!.tally[id] ?? 0}票 ← {Object.entries(s.votes).filter(([, t]) => t === id).map(([v]) => nameOf(players, v)).join('、') || '—'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
