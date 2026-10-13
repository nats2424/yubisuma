import { Countdown, Panel, nameOf, useTicker } from '../../components/ui';
import { microMeta } from '../micro/core';
import MicroStage from '../micro/MicroStage';
import type { GameViewProps } from '../types';
import {
  BOARD,
  currentPlayer,
  standings,
  STAR_COST,
  STEP_MS,
  type SugorokuAction,
  type SugorokuState,
} from './logic';

export const PLAYER_COLORS = ['#e8735a', '#4a90d9', '#52b788', '#e0b11f', '#9b6dd6', '#e05d9b', '#3fb6b0', '#8a8f98'];

// 24マスを 8×6 の外周に時計回りで並べる
const cellOf = (i: number): { row: number; col: number } => {
  if (i < 8) return { row: 1, col: i + 1 };
  if (i < 12) return { row: i - 6, col: 8 };
  if (i < 20) return { row: 6, col: 8 - (i - 12) };
  return { row: 6 - (i - 19), col: 1 };
};

const SQUARE_LABEL: Record<string, string> = { start: 'GO', blue: '+3', red: '−3', lucky: '!', bad: '?' };

export default function SugorokuView({ state: s, me, players, send, now }: GameViewProps<SugorokuState, SugorokuAction>) {
  useTicker(100);
  const color = (id: string) => PLAYER_COLORS[s.order.indexOf(id) % PLAYER_COLORS.length];
  const t = now();
  const turn = currentPlayer(s);
  const playing = s.order.includes(me);

  // 移動アニメーション：移動中のプレイヤーは1マスずつ進んで見せる
  const moving = s.phase === 'moved' && s.last ? s.last : null;
  const stepsShown = moving ? Math.min(moving.dice, Math.floor((t - moving.at) / STEP_MS)) : 0;
  const shownPos = (id: string) =>
    moving && moving.by === id ? (moving.from + stepsShown) % BOARD.length : s.pos[id];
  const arrived = moving ? stepsShown >= moving.dice : false;

  if (s.phase === 'over') {
    const order = standings(s);
    return (
      <Panel title="最終結果">
        <ol className="ranking">
          {order.map((id, i) => (
            <li key={id} className={i === 0 ? 'first' : ''}>
              <span>
                {i === 0 && '👑 '}
                {nameOf(players, id)}
              </span>
              <span className="mono">
                ⭐{s.stars[id]}　🪙{s.coins[id]}
              </span>
            </li>
          ))}
        </ol>
        <p className="hint">スターの数、同数ならコインの多い人が勝ち。</p>
      </Panel>
    );
  }

  if (s.phase === 'minigame' && s.mini) {
    return (
      <div className="stack">
        <div className="rush-header">
          <span className="pill">
            ラウンド {s.round}/{s.rounds} ミニゲーム
          </span>
          <span className="pill">1位 +10 / 2位 +6 / 3位 +3</span>
        </div>
        <MicroStage
          round={s.mini}
          playing={playing}
          now={now}
          existing={s.mini.results[me]}
          label="ミニゲーム"
          onSubmit={(result) => send({ type: 'submit', result })}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <Panel
        title={`ラウンド ${s.round}/${s.rounds}${s.round === s.rounds ? '（ラスト！）' : ''}`}
        aside={s.phase === 'roll' && <Countdown until={s.deadline} now={now} />}
      >
        <div className="board">
          {BOARD.map((sq, i) => {
            const { row, col } = cellOf(i);
            const here = s.order.filter((id) => shownPos(id) === i);
            return (
              <div key={i} className={`sq sq-${sq}${i === s.starAt ? ' has-star' : ''}`} style={{ gridRow: row, gridColumn: col }}>
                <span className="sq-label">{i === s.starAt ? '⭐' : SQUARE_LABEL[sq]}</span>
                {here.length > 0 && (
                  <span className="tokens">
                    {here.map((id) => (
                      <span key={id} className={`token${id === me ? ' me' : ''}`} style={{ background: color(id) }} />
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          <div className="board-center">
            {s.phase === 'roll' &&
              (turn === me ? (
                <button className="btn primary dice-button" onClick={() => send({ type: 'roll' })}>
                  🎲 サイコロを振る
                </button>
              ) : (
                <p>
                  <span className="dot-inline" style={{ background: color(turn) }} />
                  {nameOf(players, turn)}さんの番
                </p>
              ))}
            {moving && (
              <>
                <p className="dice-face">{arrived ? moving.dice : '🎲'}</p>
                <p className="muted">
                  <span className="dot-inline" style={{ background: color(moving.by) }} />
                  {nameOf(players, moving.by)}
                </p>
                {arrived &&
                  moving.events.map((e, i) => (
                    <p key={i} className="board-event">
                      {e.text}
                      {e.mention && ` ${nameOf(players, e.mention)}さん`}
                    </p>
                  ))}
              </>
            )}
            {s.phase === 'miniResult' && s.mini && (
              <>
                <p className="board-event">「{microMeta(s.mini.microId).title}」の結果</p>
                <ul className="mini-awards">
                  {[...s.order]
                    .sort((a, b) => (s.mini!.results[b]?.score ?? 0) - (s.mini!.results[a]?.score ?? 0))
                    .map((id) => (
                      <li key={id}>
                        <span className="dot-inline" style={{ background: color(id) }} />
                        {nameOf(players, id)} <strong>+{s.miniAwards[id] ?? 0}</strong>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>
        </div>
        <p className="hint">
          ⭐を通過・到着したとき{STAR_COST}コインあればスターと交換。青+3 / 赤−3 / ! ラッキー / ? ハプニング。毎ラウンド最後に全員でミニゲーム。
        </p>
      </Panel>

      <Panel title="プレイヤー">
        <ul className="tally">
          {standings(s).map((id) => (
            <li key={id} className={s.phase === 'roll' && id === turn ? 'is-turn' : ''}>
              <span>
                <span className="dot-inline" style={{ background: color(id) }} />
                {nameOf(players, id)}
              </span>
              <span className="mono">
                ⭐{s.stars[id]}　🪙{s.coins[id]}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
