import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { goHome, goRoom } from '../App';
import { CATEGORIES, GAMES, gamesIn } from '../games/registry';
import { CATEGORY_INFO, resolveOptions } from '../games/types';
import { getPlayerId, getSavedName, NAME_MAX, saveName } from '../lib/identity';
import { isOnlineMode } from '../lib/transport';
import type { RoomState } from '../room/logic';
import { useRoom, type RoomHandle } from '../room/useRoom';
import Chat from './Chat';
import { Brand, DemoBanner } from './Layout';
import { Panel } from './ui';

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

  if (status === 'left') {
    return (
      <Message title="部屋を退出しました">
        <button className="btn primary" onClick={goHome}>
          トップへ
        </button>
      </Message>
    );
  }
  if (status === 'notfound' || status === 'error') {
    return (
      <Message title={status === 'error' ? '接続できませんでした' : `部屋 ${code} が見つかりません`}>
        <p className="muted">
          {status === 'error' ? '通信環境を確認してもう一度お試しください。' : 'コードが正しいか、ホストがまだ部屋にいるか確認してください。'}
        </p>
        <div className="row">
          <button className="btn" onClick={() => location.reload()}>
            再試行
          </button>
          {status === 'notfound' && (
            <button className="btn primary" onClick={() => goRoom(code, true)}>
              このコードで部屋を作る
            </button>
          )}
        </div>
      </Message>
    );
  }
  if (!state) {
    return (
      <Message title="接続中…">
        <p className="muted">部屋 {code} に入っています</p>
      </Message>
    );
  }
  return <RoomScreen room={room} state={state} />;
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
  const url = `${location.origin}${location.pathname}#/r/${code}`;
  const share = async () => {
    const text = `SUKIMAで遊ぼう！ 部屋コード: ${code}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'SUKIMA', text, url });
        return;
      } catch {
        // キャンセル時はコピーにフォールバックしない
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      prompt('このURLを共有してください', url);
    }
  };
  return (
    <button className="btn small" onClick={share}>
      {copied ? 'コピーしました' : '招待する'}
    </button>
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

  const leave = () => {
    if (confirm('部屋を退出しますか？')) room.leave();
  };

  const chat = <Chat messages={state.chat} me={me} onSend={(text) => dispatch({ type: 'chat', text })} />;

  return (
    <div className="page room">
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
          <button className="btn small ghost" onClick={leave}>
            退出
          </button>
        </div>
      </header>
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
              <button className="link" onClick={() => confirm(`${p.name}さんを退出させますか？`) && onKick(p.id)}>
                外す
              </button>
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
