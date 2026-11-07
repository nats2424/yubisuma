import { useEffect, useState } from 'react';
import { Countdown, Panel, Spectating, nameOf } from '../../components/ui';
import type { GameViewProps } from '../types';
import { canPlay, JOKER, rankOf, suitOf, titleOf, type Card, type DaifugoAction, type DaifugoState } from './logic';

const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

function CardFace({ card, selected, onClick }: { card: Card; selected?: boolean; onClick?: () => void }) {
  const suit = suitOf(card);
  const isJoker = card === JOKER;
  const red = suit === 'H' || suit === 'D';
  const rank = rankOf(card);
  const content = isJoker ? (
    <span className="card-joker">JOKER</span>
  ) : (
    <>
      <span className="card-rank">{RANK_LABEL[rank] ?? rank}</span>
      <span className="card-suit">{SUIT_SYMBOL[suit]}</span>
    </>
  );
  const cls = `card${red ? ' red' : ''}${isJoker ? ' joker' : ''}${selected ? ' selected' : ''}`;
  return onClick ? (
    <button className={cls} onClick={onClick} aria-pressed={selected}>
      {content}
    </button>
  ) : (
    <span className={cls}>{content}</span>
  );
}

export default function DaifugoView({ state: s, me, players, send, now }: GameViewProps<DaifugoState, DaifugoAction>) {
  const [selected, setSelected] = useState<Card[]>([]);
  // 手番や場が変わったら選択を解除
  useEffect(() => setSelected([]), [s.seq, s.phase]);

  const playing = s.order.includes(me);
  const hand = s.hands[me] ?? [];
  const n = s.order.length;
  const myTurn = s.phase === 'play' && s.turn === me;
  const myExchange = s.phase === 'exchange' ? s.exchange[me] : undefined;
  const toggle = (c: Card) => setSelected((sel) => (sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]));
  const valid = myTurn && canPlay(s, me, selected);

  const ranking = [...s.order].sort((a, b) => s.scores[b] - s.scores[a]);
  const prevTitle = (id: string) => {
    const i = s.prevPlacing.indexOf(id);
    return i >= 0 ? titleOf(i, n) : null;
  };

  if (s.phase === 'over') {
    const top = s.scores[ranking[0]];
    return (
      <Panel title="最終結果">
        <ol className="ranking">
          {ranking.map((id) => (
            <li key={id} className={s.scores[id] === top ? 'first' : ''}>
              <span>
                {s.scores[id] === top && '👑 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">{s.scores[id]}pt</span>
            </li>
          ))}
        </ol>
        <p className="hint">{s.rounds}ラウンドの合計。1位から順に {n - 1}〜0pt。</p>
      </Panel>
    );
  }

  return (
    <div className="stack">
      <Panel
        title={`ラウンド ${s.round}/${s.rounds}`}
        aside={
          <div className="row">
            {s.revolution && <span className="pill revolution">革命中</span>}
            {(s.phase === 'play' || s.phase === 'exchange') && <Countdown until={s.deadline} now={now} />}
          </div>
        }
      >
        {s.phase === 'play' && (
          <>
            <div className="field">
              {s.field ? (
                <>
                  <div className="field-cards">
                    {s.field.cards.map((c) => (
                      <CardFace key={c} card={c} />
                    ))}
                  </div>
                  <span className="muted">{nameOf(players, s.field.by)}</span>
                </>
              ) : (
                <span className="muted">場は空です。{nameOf(players, s.turn)}さんから好きなカードを出せます</span>
              )}
            </div>
            <p className="turn-line">
              {myTurn ? <strong>あなたの番です</strong> : `${nameOf(players, s.turn)}さんの番`}
            </p>
          </>
        )}
        {s.phase === 'exchange' && (
          <p className="notice">
            カード交換中…（大貧民・貧民は一番強いカードを自動で渡しました）
            {Object.keys(s.exchange).length > 0 &&
              ` ${Object.keys(s.exchange).map((id) => nameOf(players, id)).join('、')}さんが選んでいます`}
          </p>
        )}
        {s.phase === 'roundEnd' && (
          <ol className="ranking">
            {s.finished.map((id, i) => (
              <li key={id} className={i === 0 ? 'first' : ''}>
                <span>
                  {titleOf(i, n)} — {nameOf(players, id)}
                </span>
                <span className="mono">+{n - 1 - i}pt</span>
              </li>
            ))}
          </ol>
        )}
        {s.log.length > 0 && s.phase === 'play' && (
          <ul className="event-log">
            {s.log.slice(-3).map((e, i) => (
              <li key={i}>
                {nameOf(players, e.by)}：{e.text}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {playing ? (
        <Panel
          title={myExchange ? `${nameOf(players, myExchange.to)}さんに渡すカードを${myExchange.count}枚選択` : `手札 ${hand.length}枚`}
        >
          {hand.length > 0 ? (
            <div className="hand">
              {hand.map((c) => (
                <CardFace key={c} card={c} selected={selected.includes(c)} onClick={() => toggle(c)} />
              ))}
            </div>
          ) : (
            <p className="notice">上がりました！ほかの人の対戦を見守りましょう。</p>
          )}
          {myExchange && (
            <button
              className="btn primary block"
              disabled={selected.length !== myExchange.count}
              onClick={() => send({ type: 'give', cards: selected })}
            >
              {selected.length}/{myExchange.count}枚 渡す
            </button>
          )}
          {myTurn && (
            <div className="hand-actions">
              <button className="btn" disabled={!s.field} onClick={() => send({ type: 'pass' })}>
                パス
              </button>
              <button className="btn primary" disabled={!valid} onClick={() => send({ type: 'play', cards: selected })}>
                {selected.length ? `${selected.length}枚 出す` : 'カードを選択'}
              </button>
            </div>
          )}
          {myTurn && selected.length > 0 && !valid && (
            <p className="hint">
              {s.field
                ? `場と同じ${s.field.cards.length}枚で、${s.revolution ? 'より弱い' : 'より強い'}カードを出してください`
                : '同じ数字のカード（ジョーカーは代用可）を1〜4枚選んでください'}
            </p>
          )}
        </Panel>
      ) : (
        <Spectating />
      )}

      <Panel title="プレイヤー">
        <ul className="tally">
          {s.order.map((id) => {
            const place = s.finished.indexOf(id);
            return (
              <li key={id} className={s.phase === 'play' && s.turn === id ? 'is-turn' : ''}>
                <span>
                  {nameOf(players, id)}
                  {prevTitle(id) && <span className="tag">{prevTitle(id)}</span>}
                  {place >= 0 && s.phase === 'play' && <span className="tag good">{place + 1}位抜け</span>}
                  {s.phase === 'play' && s.passed.includes(id) && <span className="tag">パス</span>}
                </span>
                <span className="mono">
                  {s.hands[id].length}枚<span className="muted"> {s.scores[id]}pt</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
