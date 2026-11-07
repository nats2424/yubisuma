import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { goHome, goRoom } from '../App';
import { CATEGORIES, GAMES, gamesIn } from '../games/registry';
import { CATEGORY_INFO, resolveOptions } from '../games/types';
import { getPlayerId, getSavedName, NAME_MAX, saveName } from '../lib/identity';
import { isOnlineMode } from '../lib/transport';
import { chatBlockedUntil, MAX_ROOM_PLAYERS, type RoomState } from '../room/logic';
import { useRoom, type RoomHandle } from '../room/useRoom';
import Chat from './Chat';
import { Brand, DemoBanner } from './Layout';
import { ConfirmButton, Panel } from './ui';

type Props = { code: string; create: boolean; onCreated: () => void };

export default function Room({ code, create, onCreated }: Props) {
  const [name, setName] = useState(getSavedName);
  const [confirmed, setConfirmed] = useState(() => Boolean(getSavedName()));

  useEffect(() => {
    if (create) onCreated();
  }, [create, onCreated]);

  if (!confirmed) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim()) return;
      saveName(name.trim());
      setConfirmed(true);
    };
    return (
      <div className="page">
        <header className="topbar">
          <Brand />
        </header>
        <main className="center">
          <form className="panel entry" onSubmit={submit}>
            <h2>
              部屋 <span className="mono">{code}</span> に参加
            </h2>
            <label className="field">
              <span className="label">ニックネーム</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} autoFocus />
            </label>
            <button className="btn primary block" type="submit" disabled={!name.trim()}>
              参加する
            </button>
          </form>
        </main>
      </div>
    );
  }

  return <RoomConnected code={code} create={create} name={name.trim()} />;
}

function RoomConnected({ code, create, name }: { code: string; create: boolean; name: string }) {
  const [me] = useState(getPlayerId);
  const room = useRoom(code, me, name, create);
  const { status, state } = room;

  // RoomStatus の全値をここで出し分ける。値が増えたら default の never で型エラーになり、分岐の漏れに気づける
  switch (status) {
    case 'ready':
      // 契約上 ready なら state は非 null だが、念のため null なら接続中の表示に倒す
      return state ? <RoomScreen room={room} state={state} /> : <Connecting code={code} />;
    case 'connecting':
      return <Connecting code={code} />;
    case 'failed':
      return (
        <Message title="接続できませんでした">
          <p className="muted">通信環境を確認してもう一度お試しください。</p>
          <div className="row message-actions">
            <button className="btn primary" onClick={room.retry}>
              再試行
            </button>
            <button className="btn" onClick={goHome}>
              トップへ
            </button>
          </div>
        </Message>
      );
    case 'notfound':
      return (
        <Message title={`部屋 ${code} が見つかりません`}>
          <p className="muted">コードが正しいか、ホストがまだ部屋にいるか確認してください。</p>
          <div className="row message-actions">
            <button className="btn" onClick={room.retry}>
              再試行
            </button>
            <button className="btn primary" onClick={() => goRoom(code, true)}>
              このコードで部屋を作る
            </button>
          </div>
        </Message>
      );
    case 'full':
      return (
        <Message title="この部屋は満員です">
          <p className="muted">1つの部屋に入れるのは最大{MAX_ROOM_PLAYERS}人です。空きが出るまで待つか、別の部屋を作ってください。</p>
          <div className="row message-actions">
            <button className="btn primary" onClick={goHome}>
              トップへ
            </button>
          </div>
        </Message>
      );
    case 'kicked':
      // 「もう一度参加する」（MVP-13, Should）は今回入れない。自分で退出したと誤解されないよう文言だけ分ける
      return (
        <Message title="ホストにより部屋から外されました">
          <div className="row message-actions">
            <button className="btn primary" onClick={goHome}>
              トップへ
            </button>
          </div>
        </Message>
      );
    case 'left':
      return (
        <Message title="部屋を退出しました">
          <div className="row message-actions">
            <button className="btn primary" onClick={goHome}>
              トップへ
            </button>
          </div>
        </Message>
      );
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function Connecting({ code }: { code: string }) {
  return (
    <Message title="接続中…">
      <p className="muted">
        部屋 <span className="mono">{code}</span> に入っています
      </p>
    </Message>
  );
}

// 一度つながった後に通信が切れている間、画面上部に出す細い帯。ゲーム画面は消さずに上へ重ねる
function ReconnectBanner() {
  return (
    <div className="conn-banner" role="status" aria-live="polite">
      <span className="conn-spinner" aria-hidden />
      <span>
        再接続中…<span className="conn-sub">通信が戻ると自動で続きから再開します</span>
      </span>
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <header className="topbar">
        <Brand />
      </header>
      <main className="center">
        <div className="panel entry message">
          <h2>{title}</h2>
          {children}
        </div>
      </main>
    </div>
  );
}

function ShareButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const url = `${location.origin}${location.pathname}#/r/${code}`;
  const share = async () => {
    const text = `SUKIMAで遊ぼう！ 部屋コード: ${code}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'SUKIMA', text, url });
        return;
      } catch (e) {
        // ユーザーがキャンセルした場合はそのまま終了、共有が使えない場合はコピーへ
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // クリップボードが使えない環境では URL を表示する
      setShown(url);
    }
  };
  return (
    <>
      <button className="btn small" onClick={share}>
        {copied ? 'コピーしました' : '招待する'}
      </button>
      {shown && (
        <div className="share-popover" role="dialog" aria-label="招待URL">
          <input id="share-url" readOnly value={shown} onFocus={(e) => e.currentTarget.select()} autoFocus />
          <button className="btn small ghost" onClick={() => setShown(null)}>
            閉じる
          </button>
        </div>
      )}
    </>
  );
}

function RoomScreen({ room, state }: { room: RoomHandle; state: RoomState }) {
  const { me, isHost, online, dispatch } = room;
  const [chatOpen, setChatOpen] = useState(false);
  const [seenChat, setSeenChat] = useState(state.chat.length);
  const wide = useMediaQuery('(min-width: 960px)');
  const chatVisible = wide || chatOpen;
  useEffect(() => {
    if (chatVisible) setSeenChat(state.chat.length);
  }, [chatVisible, state.chat.length]);
  const unread = state.chat.slice(seenChat).filter((m) => m.by !== null && m.by !== me).length;

  // 連投制限はホストの reduceRoom が最終判断する。ここでは同じ規則でボタンを先に止め、送っても消える操作をさせない（AC-20）
  const chat = (
    <Chat
      messages={state.chat}
      me={me}
      onSend={(text) => dispatch({ type: 'chat', text })}
      blockedUntil={chatBlockedUntil(state, me, room.now())}
      now={room.now}
    />
  );

  return (
    <div className="page room">
      <div className="room-top">
        <header className="topbar">
          <Brand />
          <div className="room-meta">
            <span className="room-code" title="ルームコード">
              <span className="muted room-label">ROOM</span> <span className="mono">{state.code}</span>
            </span>
            <ShareButton code={state.code} />
            {!wide && (
              <button className="btn small chat-toggle" onClick={() => setChatOpen(true)} aria-label="チャットを開く">
                💬{unread > 0 && <span className="badge">{unread}</span>}
              </button>
            )}
            <ConfirmButton className="btn small ghost" label="退出" confirmLabel="本当に退出" onConfirm={room.leave} />
          </div>
        </header>
        {room.connection !== 'connected' && <ReconnectBanner />}
      </div>
      {!isOnlineMode && <DemoBanner />}

      <div className="room-layout">
        <main className="room-main">
          {state.game ? <GameArea room={room} state={state} /> : <Lobby room={room} state={state} />}
          <Members state={state} me={me} isHost={isHost} online={online} onKick={(id) => dispatch({ type: 'kick', target: id })} />
        </main>
        {wide ? (
          <aside className="room-side">
            <Panel title="チャット">{chat}</Panel>
          </aside>
        ) : (
          <>
            {chatOpen && (
              <div className="sheet-backdrop" onClick={() => setChatOpen(false)}>
                <div className="sheet" onClick={(e) => e.stopPropagation()}>
                  <header className="panel-head">
                    <h2>チャット</h2>
                    <button className="btn small ghost" onClick={() => setChatOpen(false)}>
                      閉じる
                    </button>
                  </header>
                  {chat}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function Members({
  state,
  me,
  isHost,
  online,
  onKick,
}: {
  state: RoomState;
  me: string;
  isHost: boolean;
  online: Set<string>;
  onKick: (id: string) => void;
}) {
  return (
    <Panel title={`メンバー ${state.players.length}人`}>
      <ul className="members">
        {state.players.map((p) => (
          <li key={p.id} className={online.has(p.id) ? '' : 'offline'}>
            <span className={`dot${online.has(p.id) ? ' on' : ''}`} aria-label={online.has(p.id) ? 'オンライン' : 'オフライン'} />
            <span className="member-name">
              {p.name}
              {p.id === me && <span className="muted">（あなた）</span>}
            </span>
            {p.id === state.hostId && <span className="tag">ホスト</span>}
            {isHost && p.id !== me && !online.has(p.id) && (
              <ConfirmButton className="link" label="外す" confirmLabel="外す？（もう一度タップ）" onConfirm={() => onKick(p.id)} />
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Lobby({ room, state }: { room: RoomHandle; state: RoomState }) {
  const { isHost, online, dispatch } = room;
  const selected = GAMES[state.selectedGame];
  const options = resolveOptions(selected, state.gameOptions?.[selected.id]);
  const count = state.players.filter((p) => online.has(p.id)).length;
  const tooFew = count < selected.minPlayers;
  const tooMany = count > selected.maxPlayers;

  return (
    <div className="stack">
      <Panel title="ゲームを選ぶ" aside={!isHost && <span className="pill">ホストが選びます</span>}>
        {CATEGORIES.map((cat) => (
          <div key={cat} className="picker-group">
            <p className="picker-label">
              {CATEGORY_INFO[cat].label}
              <span className="muted"> {CATEGORY_INFO[cat].description}</span>
            </p>
            <div className="game-picker">
              {gamesIn(cat).map((g) => (
                <button
                  key={g.id}
                  className={`game-option${g.id === state.selectedGame ? ' selected' : ''}`}
                  disabled={!isHost}
                  onClick={() => dispatch({ type: 'selectGame', gameId: g.id })}
                >
                  <span className="game-emoji" aria-hidden>
                    {g.emoji}
                  </span>
                  <span className="game-name">{g.name}</span>
                  <span className="game-meta">
                    {g.minPlayers}〜{g.maxPlayers}人 · {g.minutes}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </Panel>

      <Panel title={`${selected.emoji} ${selected.name}`}>
        <p className="lead-sm">{selected.tagline}</p>
        <ol className="rules">
          {selected.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
        {selected.options?.map((opt) => (
          <div key={opt.key} className="option-row">
            <span className="label">{opt.label}</span>
            <div className="segmented">
              {opt.choices.map((c) => (
                <button
                  key={c.value}
                  className={options[opt.key] === c.value ? 'selected' : ''}
                  disabled={!isHost}
                  onClick={() => dispatch({ type: 'setOption', key: opt.key, value: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {isHost ? (
          <>
            <button
              className="btn primary block"
              disabled={tooFew || tooMany}
              onClick={() => dispatch({ type: 'startGame', online: [...online] })}
            >
              スタート（{count}人）
            </button>
            {tooFew && <p className="hint">あと{selected.minPlayers - count}人必要です。「招待する」からURLを送りましょう。</p>}
            {tooMany && <p className="hint">このゲームは{selected.maxPlayers}人までです。</p>}
          </>
        ) : (
          <p className="notice">ホストがゲームを開始するのを待っています…</p>
        )}
      </Panel>
    </div>
  );
}

function GameArea({ room, state }: { room: RoomHandle; state: RoomState }) {
  const { me, isHost, online, dispatch, now } = room;
  const game = state.game!;
  const def = GAMES[game.id];
  const [showRules, setShowRules] = useState(false);

  if (!def) return <p className="notice">未対応のゲームです</p>;
  const View = def.View;

  return (
    <div className="stack">
      <div className="game-header">
        <h1>
          <span aria-hidden>{def.emoji}</span> {def.name}
        </h1>
        <div className="row">
          <button className="btn small ghost" onClick={() => setShowRules((v) => !v)}>
            ルール
          </button>
          {isHost && (
            <>
              <button className="btn small ghost" onClick={() => dispatch({ type: 'startGame', online: [...online] })}>
                もう一度
              </button>
              <button className="btn small ghost" onClick={() => dispatch({ type: 'endGame' })}>
                ロビーへ
              </button>
            </>
          )}
        </div>
      </div>
      {showRules && (
        <Panel>
          <ol className="rules">
            {def.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </Panel>
      )}
      <View
        key={game.startedAt}
        state={game.state}
        me={me}
        players={game.players}
        online={online}
        isHost={isHost}
        now={now}
        send={(action: unknown) => dispatch({ type: 'game', action })}
      />
    </div>
  );
}
