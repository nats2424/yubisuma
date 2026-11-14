import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { goHome, goRoom } from '../App';
import { CATEGORIES, GAMES, gamesIn } from '../games/registry';
import { CATEGORY_INFO, resolveOptions, type GameDef } from '../games/types';
import { getPlayerId, getSavedName, NAME_MAX, saveName } from '../lib/identity';
import { isOnlineMode } from '../lib/transport';
import { chatBlockedUntil, MAX_ROOM_PLAYERS, type RoomState } from '../room/logic';
import { useRoom, type RoomHandle } from '../room/useRoom';
import Chat from './Chat';
import GameIcon, { ChatIcon } from './GameIcon';
import ErrorBoundary, { CrashScreen, reloadPage } from './ErrorBoundary';
import { Brand, DemoBanner } from './Layout';
import { roomUrl, inviteText, shareOrCopy, copyText, canWebShare } from './share';
import { ConfirmButton, Panel } from './ui';

type Props = { code: string; create: boolean; initialGame?: string; onCreated: () => void };

export default function Room({ code, create, initialGame, onCreated }: Props) {
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
        {/* 招待 URL から来た人が最初に見る画面。「友達からの招待」「登録不要」を添えて、名前を入れるだけだと伝える */}
        <main className="center join-wrap">
          <form className="panel entry join-card" onSubmit={submit}>
            <span className="invite">友達からの招待です</span>
            <h2 className="join-title">
              部屋<span className="code-chip">{code}</span>に参加
            </h2>
            <label className="field">
              <span className="label">ニックネーム</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} autoFocus />
            </label>
            <button className="btn primary block" type="submit" disabled={!name.trim()}>
              参加する
            </button>
            <p className="note">登録・インストールは不要です</p>
          </form>
        </main>
      </div>
    );
  }

  return <RoomConnected code={code} create={create} initialGame={initialGame} name={name.trim()} />;
}

function RoomConnected({ code, create, initialGame, name }: { code: string; create: boolean; initialGame?: string; name: string }) {
  const [me] = useState(getPlayerId);
  const room = useRoom(code, me, name, create);
  const { status, state } = room;
  // 作成時に指定されたゲームを、部屋ができた直後に 1 回だけ選ぶ（J-06）。
  // useRoom の既定ゲームは固定なので、ホストの通常の「ゲームを選ぶ」操作で切り替える
  const pendingGame = useRef(create ? initialGame : undefined);
  useEffect(() => {
    const g = pendingGame.current;
    if (!g || status !== 'ready' || !state || !room.isHost) return;
    pendingGame.current = undefined;
    if (!state.game && state.selectedGame !== g && findGame(g)) room.dispatch({ type: 'selectGame', gameId: g });
  }, [status, state, room]);

  // RoomStatus の全値をここで出し分ける。値が増えたら default の never で型エラーになり、分岐の漏れに気づける
  switch (status) {
    case 'ready':
      // 契約上 ready なら state は非 null だが、念のため null なら接続中の表示に倒す
      // 部屋の画面のどこかで描画が例外を投げても、真っ白ではなく再読み込みを促す表示にする（SEC-04）
      return state ? (
        <ErrorBoundary fallback={() => <CrashScreen />}>
          <RoomScreen room={room} state={state} />
        </ErrorBoundary>
      ) : (
        <Connecting code={code} />
      );
    case 'connecting':
      return <Connecting code={code} />;
    case 'failed':
      return (
        <Message
          mark="!"
          title={
            <>
              接続<wbr />
              できませんでした
            </>
          }
        >
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
        <Message
          mark="?"
          title={
            <>
              部屋 <span className="mono">{code}</span> が<wbr />
              見つかりません
            </>
          }
        >
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
        <Message
          mark="満"
          title={
            <>
              この部屋は満員です<wbr />
              （最大{MAX_ROOM_PLAYERS}人）
            </>
          }
        >
          <p className="muted">空きが出るまで待つか、トップから別の部屋を作ってください。</p>
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
        <Message
          mark="!"
          title={
            <>
              ホストにより<wbr />
              部屋から外されました
            </>
          }
        >
          <p className="muted">続けて遊ぶには、トップから部屋に入り直してください。</p>
          <div className="row message-actions">
            <button className="btn primary" onClick={goHome}>
              トップへ
            </button>
          </div>
        </Message>
      );
    case 'left':
      return (
        <Message mark="→" title="部屋を退出しました">
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
    <Message mark="…" title="接続中…">
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
        再接続中…<span className="conn-sub">自動でつなぎ直しています</span>
      </span>
    </div>
  );
}

// 状態ごとの記号ステッカー（「!」「?」「満」など）を見出しに添え、色だけに頼らず状況が分かるようにする
function Message({ title, mark, children }: { title: ReactNode; mark?: string; children?: ReactNode }) {
  return (
    <div className="page">
      <header className="topbar">
        <Brand />
      </header>
      <main className="center">
        <div className="panel entry message">
          {mark && (
            <span className="message-mark" aria-hidden>
              {mark}
            </span>
          )}
          <h2>{title}</h2>
          {children}
        </div>
      </main>
    </div>
  );
}

function ShareButton({ code, gameName }: { code: string; gameName: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const url = roomUrl(code);
  const share = async () => {
    const r = await shareOrCopy({ title: 'SUKIMA', text: inviteText(code, gameName), url });
    if (r === 'copied') {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else if (r === 'failed') {
      // クリップボードが使えない環境では URL を表示する
      setShown(url);
    }
  };
  return (
    <>
      <button className="btn small" onClick={share}>
        {/* 狭い画面（QA-BUG-08）では文言を詰める／2 行にして、ヘッダーの 1 行に収める。
            1 つの span に包むのは、.btn が flex なので子要素の間に gap が入ってしまうため */}
        <span className="btn-label">
          {copied ? (
            <>
              コピー<span className="only-wide">しました</span>
              <span className="only-narrow">
                <br />
                済み
              </span>
            </>
          ) : (
            <>
              招待<span className="only-wide">する</span>
            </>
          )}
        </span>
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
            <ShareButton code={state.code} gameName={findGame(state.game?.id ?? state.selectedGame)?.name} />
            {!wide && (
              <button className="btn small chat-toggle" onClick={() => setChatOpen(true)} aria-label="チャットを開く">
                <ChatIcon />
                {unread > 0 && <span className="badge">{unread}</span>}
              </button>
            )}
            <ConfirmButton
              className="btn small ghost exit-btn"
              label="退出"
              confirmLabel={
                <span className="btn-label">
                  本当に
                  <span className="only-narrow">
                    <br />
                  </span>
                  退出
                </span>
              }
              onConfirm={room.leave}
            />
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
    <Panel className="members-panel" title={`メンバー ${state.players.length}人`}>
      <ul className="members">
        {state.players.map((p) => (
          <li key={p.id} className={online.has(p.id) ? '' : 'offline'}>
            <span className={`dot${online.has(p.id) ? ' on' : ''}`} aria-label={online.has(p.id) ? 'オンライン' : 'オフライン'} />
            <span className="member-name">
              {p.name}
              {p.id === me && <span className="muted">（あなた）</span>}
              {/* 点の塗り／点線だけでなく文言でもオフラインを示す */}
              {!online.has(p.id) && <span className="muted">（オフライン）</span>}
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

// 受信した状態のゲーム ID は他端末の自己申告なので、登録表の自前のキーだけを引く。
// GAMES['constructor'] や GAMES['__proto__'] のような Object.prototype 由来の値を拾わないため（SEC-04）
function findGame(id: unknown): GameDef | undefined {
  return typeof id === 'string' && Object.hasOwn(GAMES, id) ? GAMES[id] : undefined;
}

// 登録にないゲーム。悪意のほか、デプロイ直後の版ずれ（新しい版のタブが新ゲームを選んだ）でも起こる
function UnknownGame({ onLobby }: { onLobby?: () => void }) {
  return (
    <Panel title="未対応のゲームです">
      <p className="lead-sm">このゲームは新しいバージョンで追加されました。ページを再読み込みしてください。</p>
      <div className="row">
        <button className="btn primary" onClick={reloadPage}>
          再読み込み
        </button>
        {onLobby && (
          <button className="btn" onClick={onLobby}>
            ロビーへ
          </button>
        )}
      </div>
    </Panel>
  );
}

// ゲームの View が例外を投げたときの表示。メンバー・チャットは残したまま、このゲーム枠だけを差し替える
function GameCrashed({ onRetry, onLobby }: { onRetry: () => void; onLobby?: () => void }) {
  return (
    <Panel title="ゲーム画面を表示できませんでした">
      <p className="lead-sm">ページを再読み込みしてください。</p>
      <div className="row">
        <button className="btn primary" onClick={reloadPage}>
          再読み込み
        </button>
        <button className="btn" onClick={onRetry}>
          もう一度表示
        </button>
        {onLobby && (
          <button className="btn" onClick={onLobby}>
            ロビーへ
          </button>
        )}
      </div>
    </Panel>
  );
}

// ホスト 1 人のロビーで最初に見せる招待カード（J-02）。URL を見せ、コピーと共有を大きいボタンで並べる
function InviteCard({ code, gameName }: { code: string; gameName: string | undefined }) {
  const url = roomUrl(code);
  const [note, setNote] = useState('');
  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(''), 1800);
  };
  const copyUrl = async () => {
    flash((await copyText(url)) ? 'URLをコピーしました' : 'コピーできませんでした。URLを長押ししてコピーしてください');
  };
  const share = async () => {
    const r = await shareOrCopy({ title: 'SUKIMA', text: inviteText(code, gameName), url });
    if (r === 'copied') flash('招待文をコピーしました。LINEなどに貼り付けてください');
    else if (r === 'failed') flash('コピーできませんでした。URLを長押ししてコピーしてください');
  };
  return (
    <Panel className="invite-panel" title="友達を招待しよう">
      <p className="lead-sm">URLを送ると、タップするだけで参加できます（登録不要）。</p>
      <input
        className="invite-url mono"
        readOnly
        value={url}
        aria-label="招待URL"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="invite-actions">
        <button className="btn primary" onClick={share}>
          {canWebShare() ? '招待を送る' : '招待文をコピー'}
        </button>
        <button className="btn" onClick={copyUrl}>
          URLをコピー
        </button>
      </div>
      <p className="invite-note" role="status" aria-live="polite">
        {note}
      </p>
    </Panel>
  );
}

function Lobby({ room, state }: { room: RoomHandle; state: RoomState }) {
  const { isHost, online, dispatch } = room;
  const selected = findGame(state.selectedGame);
  // ホストしかいない間は、次にやることが「招待」だけなので大きく出す（J-02）。
  // 2 人以上になったら消し、招待はヘッダーの小さい「招待する」に任せる
  const alone = isHost && state.players.filter((p) => online.has(p.id)).length <= 1;

  return (
    // スマホでは「次に遊ぶゲーム → メンバー → ゲームを選ぶ」の順に並べる（CSS の order）。
    // ゲストが最初に「これから何が始まるか」を見られるようにするため（design/README.md）
    <div className="lobby">
      {alone && <InviteCard code={state.code} gameName={selected?.name} />}
      <Panel className="picker-panel" title="ゲームを選ぶ" aside={!isHost && <span className="pill">ホストが選びます</span>}>
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
                  <GameIcon id={g.id} emoji={g.emoji} size={34} />
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

      {/* 選択中のゲームが登録にないときも、ゲームの選択欄は残す（ホストが手元にあるゲームを選び直せる） */}
      {selected ? <SelectedGame room={room} state={state} selected={selected} /> : <UnknownGame />}
    </div>
  );
}

function SelectedGame({ room, state, selected }: { room: RoomHandle; state: RoomState; selected: GameDef }) {
  const { isHost, online, dispatch } = room;
  const options = resolveOptions(selected, state.gameOptions?.[selected.id]);
  const count = state.players.filter((p) => online.has(p.id)).length;
  const tooFew = count < selected.minPlayers;
  const tooMany = count > selected.maxPlayers;

  return (
    <Panel className="selected-panel" title="次に遊ぶゲーム" aside={!isHost && <span className="pill">ホストが選びます</span>}>
      <div className="now-head">
        <GameIcon id={selected.id} emoji={selected.emoji} size={56} />
        <div>
          <h3>{selected.name}</h3>
          <p className="lead-sm">{selected.tagline}</p>
        </div>
      </div>
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
        <p className="notice waiting">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          ホストがゲームを開始するのを待っています…
        </p>
      )}
    </Panel>
  );
}

function GameArea({ room, state }: { room: RoomHandle; state: RoomState }) {
  const { me, isHost, online, dispatch, now } = room;
  const game = state.game!;
  const def = findGame(game.id);
  const [showRules, setShowRules] = useState(false);
  // ホストだけはロビーへ戻して、手元にあるゲームを選び直せる
  const toLobby = isHost ? () => dispatch({ type: 'endGame' }) : undefined;

  if (!def) return <UnknownGame onLobby={toLobby} />;
  const View = def.View;
  const over = isGameOver(def.id, game.state);

  return (
    <div className="stack">
      <div className="game-header">
        <h1>
          <GameIcon id={def.id} emoji={def.emoji} size={36} />
          {def.name}
        </h1>
        <div className="row">
          <button className="btn small ghost" onClick={() => setShowRules((v) => !v)}>
            ルール
          </button>
          {/* 終わった後は結果の直下に大きいボタンを出すので、見出し横の小さいボタンはゲーム中だけにする */}
          {isHost && !over && (
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
      {/* 新しいゲームが始まったら（startedAt が変わったら）境界も作り直し、前回の失敗表示を持ち越さない */}
      <ErrorBoundary key={game.startedAt} fallback={(reset) => <GameCrashed onRetry={reset} onLobby={toLobby} />}>
        <View
          state={game.state}
          me={me}
          players={game.players}
          online={online}
          isHost={isHost}
          now={now}
          send={(action: unknown) => dispatch({ type: 'game', action })}
        />
      </ErrorBoundary>
      {over && <NextActions room={room} state={state} def={def} />}
    </div>
  );
}

// ゲームが終わったこと（結果表示）を表す phase。GameDef に終了判定がまだないので、画面側で状態の phase を読む。
// ワードウルフだけは結果が 'result'（ほかのゲームの 'result' はラウンドの途中経過）
const FINAL_PHASE: Record<string, string> = { wordwolf: 'result' };
function isGameOver(id: string, s: unknown): boolean {
  if (typeof s !== 'object' || s === null || !('phase' in s)) return false;
  const final = Object.hasOwn(FINAL_PHASE, id) ? FINAL_PHASE[id] : 'over';
  return s.phase === final;
}

// 結果の直下に出す「次の行動」（J-04）。ホストは大きいボタンで次へ、ゲストには待っていることを示して固まって見えないようにする
function NextActions({ room, state, def }: { room: RoomHandle; state: RoomState; def: GameDef }) {
  const { isHost, online, dispatch } = room;
  if (!isHost) {
    return (
      <p className="notice waiting next-wait">
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        ホストが次を選んでいます…
      </p>
    );
  }
  const count = state.players.filter((p) => online.has(p.id)).length;
  const tooFew = count < def.minPlayers;
  const tooMany = count > def.maxPlayers;
  return (
    <div className="next-actions">
      <button
        className="btn primary block"
        disabled={tooFew || tooMany}
        onClick={() => dispatch({ type: 'startGame', online: [...online] })}
      >
        もう一度
      </button>
      <button className="btn block" onClick={() => dispatch({ type: 'endGame' })}>
        別のゲームを選ぶ
      </button>
      {tooFew && <p className="hint">「{def.name}」はあと{def.minPlayers - count}人必要です。</p>}
      {tooMany && <p className="hint">「{def.name}」は{def.maxPlayers}人までです。</p>}
    </div>
  );
}
