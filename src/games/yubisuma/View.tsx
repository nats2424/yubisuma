import { useEffect, useState } from 'react';
import { Panel, nameOf } from '../../components/ui';
import type { GameViewProps } from '../types';
import { activePlayers, HANDS, maxCall, type YubisumaAction, type YubisumaState } from './logic';

const Hands = ({ count, up }: { count: number; up?: number }) => (
  <span className="hands" aria-label={`残り${count}本`}>
    {Array.from({ length: HANDS }, (_, i) => (
      <span key={i} className={`hand${i < count ? '' : ' gone'}${up !== undefined && i < up ? ' up' : ''}`}>
        {i < count ? (up !== undefined && i < up ? '👍' : '✊') : '·'}
      </span>
    ))}
  </span>
);

export default function YubisumaView({ state: s, me, players, send }: GameViewProps<YubisumaState, YubisumaAction>) {
  const [thumbs, setThumbs] = useState<number | null>(null);
  const [call, setCall] = useState<number | null>(null);
  useEffect(() => {
    setThumbs(null);
    setCall(null);
  }, [s.round]);

  const amActive = s.hands[me] > 0;
  const amCaller = s.caller === me;
  const submitted = me in s.thumbs && (!amCaller || s.call !== null);
  const waitingFor = activePlayers(s).filter((id) => !(id in s.thumbs));
  const max = maxCall(s);

  const canSubmit = thumbs !== null && (!amCaller || call !== null);
  const submit = () => {
    if (thumbs === null) return;
    send(amCaller ? { type: 'choose', thumbs, call: call ?? 0 } : { type: 'choose', thumbs });
  };

  return (
    <div className="stack">
      <Panel title={`ラウンド ${s.round}`} aside={<span className="pill">コール: {nameOf(players, s.caller)}</span>}>
        <ul className="seat-list">
          {s.order.map((id) => {
            const shown = s.phase !== 'choose' ? s.last?.thumbs[id] : undefined;
            return (
              <li key={id} className={`seat${id === s.caller ? ' is-caller' : ''}${id === me ? ' is-me' : ''}`}>
                <span className="seat-name">
                  {nameOf(players, id)}
                  {s.hands[id] === 0 && <span className="tag good">上がり{s.finished.indexOf(id) + 1}位</span>}
                </span>
                {s.hands[id] > 0 ? (
                  <Hands count={s.hands[id]} up={shown} />
                ) : (
                  <span className="muted">🙌</span>
                )}
                {s.phase === 'choose' && s.hands[id] > 0 && (
                  <span className={`tag${id in s.thumbs ? ' good' : ''}`}>{id in s.thumbs ? 'OK' : '考え中'}</span>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      {s.phase !== 'choose' && s.last && (
        <Panel>
          <div className={`result-banner${s.last.hit ? ' hit' : ''}`}>
            <p className="muted">
              {nameOf(players, s.last.caller)}さんのコール「{s.last.call}」
            </p>
            <p className="big-number">{s.last.total}</p>
            <p>{s.last.hit ? `的中！${nameOf(players, s.last.caller)}さんは片手を下ろします` : 'はずれ'}</p>
          </div>
          {s.phase === 'over' && (
            <div className="ranking">
              <h3>結果</h3>
              <ol>
                {[...s.finished, ...s.order.filter((id) => s.hands[id] > 0)].map((id, i, arr) => (
                  <li key={id}>
                    {nameOf(players, id)}
                    {i === arr.length - 1 && <span className="tag bad">負け</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>
      )}

      {s.phase === 'choose' && amActive && !submitted && (
        <Panel title={amCaller ? 'あなたのコール番です' : '親指を何本上げる？'}>
          <div className="stack">
            <div>
              <p className="label">上げる親指</p>
              <div className="choices">
                {Array.from({ length: s.hands[me] + 1 }, (_, n) => (
                  <button key={n} className={`choice${thumbs === n ? ' selected' : ''}`} onClick={() => setThumbs(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {amCaller && (
              <div>
                <p className="label">合計は何本？（0〜{max}）</p>
                <div className="choices">
                  {Array.from({ length: max + 1 }, (_, n) => (
                    <button key={n} className={`choice${call === n ? ' selected' : ''}`} onClick={() => setCall(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button className="btn primary" disabled={!canSubmit} onClick={submit}>
              {amCaller ? `「${call ?? '?'}」でいっせーの！` : '決定'}
            </button>
          </div>
        </Panel>
      )}

      {s.phase === 'choose' && (submitted || !amActive) && (
        <p className="notice">
          {amActive ? '決定しました。' : ''}
          {waitingFor.length > 0 && `${waitingFor.map((id) => nameOf(players, id)).join('、')} さんを待っています…`}
        </p>
      )}
    </div>
  );
}
