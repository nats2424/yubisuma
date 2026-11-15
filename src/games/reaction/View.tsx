import { useLayoutEffect, useRef } from 'react';
import { Panel, Spectating, nameOf } from '../../components/ui';
import type { GamePlayer, GameViewProps } from '../types';
import { PENALTY_MS, ROUNDS, totals, type Outcome, type ReactionAction, type ReactionState } from './logic';

const fmt = (o: Outcome | undefined) =>
  o === undefined ? '—' : o === 'foul' ? 'フライング' : o === 'miss' ? '押し忘れ' : `${o}ms`;

// ラウンド内の並び：タイムが速い順、続いてフライング・押し忘れ（同じ扱いの中は参加順のまま）
const roundSortKey = (o: Outcome | undefined) => (typeof o === 'number' ? o : o === 'foul' ? 1e9 : 2e9);

// 同タイムは同順位にする（1 位が 2 人いても両方「1 位」と言い合えるように）
const rankOf = (cur: Record<string, Outcome>, id: string): number | null => {
  const o = cur[id];
  if (typeof o !== 'number') return null;
  return 1 + Object.values(cur).filter((x) => typeof x === 'number' && x < o).length;
};

// 今どのラウンドかを点で見せる（終わったラウンドは塗り、今のラウンドは大きく）
function RoundDots({ round }: { round: number }) {
  return (
    <span className="reaction-dots" aria-hidden="true">
      {Array.from({ length: ROUNDS }, (_, i) => (
        <span key={i} className={i < round - 1 ? 'done' : i === round - 1 ? 'now' : ''} />
      ))}
    </span>
  );
}

// ラウンドごとの結果。対面で画面を見せ合って盛り上がれるよう、1 位を大きく真ん中に出す
function RoundResult({
  s,
  me,
  players,
  playing,
  total,
}: {
  s: ReactionState;
  me: string;
  players: GamePlayer[];
  playing: boolean;
  total: Record<string, number>;
}) {
  const cur = s.current;
  const order = [...s.order].sort((a, b) => roundSortKey(cur[a]) - roundSortKey(cur[b]));
  const winners = order.filter((id) => rankOf(cur, id) === 1);
  const best = winners.length > 0 ? cur[winners[0]] : undefined;
  const mine = cur[me];
  const myRank = rankOf(cur, me);
  const fouls = order.filter((id) => cur[id] === 'foul');
  const misses = order.filter((id) => cur[id] === 'miss');
  const last = s.round >= ROUNDS;

  return (
    <section className="reaction-result" aria-live="polite">
      <p className="reaction-result-label">
        ROUND {s.round} の結果
        <span className="reaction-result-of"> / 全{ROUNDS}</span>
      </p>

      {winners.length > 0 ? (
        <div className="reaction-winner">
          <span className="reaction-winner-badge">🏆 1位</span>
          <span className="reaction-winner-name">{winners.map((id) => nameOf(players, id)).join('・')}</span>
          <span className="reaction-winner-time">{fmt(best)}</span>
        </div>
      ) : (
        <div className="reaction-winner none">
          <span className="reaction-winner-name">全員ノーカウント</span>
        </div>
      )}

      {playing && (
        <p className={`reaction-mine${typeof mine === 'number' ? '' : ' bad'}`}>
          <span>あなた</span>
          <b className="mono">{fmt(mine)}</b>
          {myRank !== null && <b className="reaction-mine-rank">{myRank}位</b>}
        </p>
      )}

      <ol className="reaction-round-list">
        {order.map((id) => {
          const r = rankOf(cur, id);
          const o = cur[id];
          const cls = [r === 1 ? 'first' : '', typeof o === 'number' ? '' : 'out', id === me ? 'me' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <li key={id} className={cls}>
              <span className="reaction-rank">{r ?? '×'}</span>
              <span className="reaction-name">{nameOf(players, id)}</span>
              <span className="reaction-time mono">
                {fmt(o)}
                <span className="reaction-total">計{total[id]}ms</span>
              </span>
            </li>
          );
        })}
      </ol>

      {(fouls.length > 0 || misses.length > 0) && (
        <p className="hint reaction-penalty">
          {fouls.length > 0 && <span>フライング：{fouls.map((id) => nameOf(players, id)).join('・')}</span>}
          {misses.length > 0 && <span>押し忘れ：{misses.map((id) => nameOf(players, id)).join('・')}</span>}
          <span>（{PENALTY_MS}ms 扱い）</span>
        </p>
      )}
      <p className="reaction-next">{last ? 'まもなく最終結果' : `まもなく ROUND ${s.round + 1}`}</p>
    </section>
  );
}

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

  // ラウンドの結果は押すパッドを出さず、画面の真ん中に大きく出す（誤タップもしない）
  if (s.phase === 'result') {
    return <RoundResult s={s} me={me} players={players} playing={playing} total={total} />;
  }

  const padState = s.phase === 'go' ? 'go' : s.phase === 'wait' ? 'wait' : 'ready';
  const padText =
    mine === 'foul'
      ? 'フライング！'
      : typeof mine === 'number'
        ? `${mine}ms`
        : s.phase === 'ready'
          ? `ROUND ${s.round}`
          : s.phase === 'wait'
            ? '待って…'
            : '押せ！';
  // 'ready' は次のラウンドの区切り。何ラウンド目か・まもなく始まることを見せる
  const showReady = s.phase === 'ready' && mine === undefined;

  return (
    <div className="stack">
      {playing ? (
        <button className={`reaction-pad ${padState}${mine !== undefined ? ' done' : ''}`} onPointerDown={onTap}>
          <span className="reaction-round">
            {s.round}/{ROUNDS}
          </span>
          {showReady && <span className="reaction-sub">全{ROUNDS}ラウンド</span>}
          <span className="reaction-text">{padText}</span>
          {showReady && (
            <>
              <RoundDots round={s.round} />
              <span className="reaction-sub">{s.round === 1 ? 'まもなくスタート' : '次のラウンド、まもなく'}</span>
              <span className="reaction-sub small">緑になったらタップ・早押しはフライング</span>
            </>
          )}
          {s.phase === 'wait' && mine === undefined && <span className="reaction-sub">緑になったらタップ</span>}
        </button>
      ) : (
        <>
          {s.phase === 'ready' && (
            <p className="reaction-result-label">
              ROUND {s.round}
              <span className="reaction-result-of"> / 全{ROUNDS}</span>
            </p>
          )}
          <Spectating />
        </>
      )}

      <Panel title="途中経過">
        <ul className="tally">
          {ranking.map((id) => (
            <li key={id}>
              <span>{nameOf(players, id)}</span>
              <span className="mono">
                {id in s.current ? fmt(s.current[id]) : ''}
                <span className="muted"> 計{total[id]}ms</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
