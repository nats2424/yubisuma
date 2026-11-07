import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { CHAT_MAX_LEN, type ChatMessage } from '../room/logic';

type Props = {
  messages: ChatMessage[];
  me: string;
  onSend: (text: string) => void;
  // この時刻（ルーム共通時計）まで送信できない。0 なら制限なし（chatBlockedUntil の戻り値）
  blockedUntil: number;
  now: () => number;
};

export default function Chat({ messages, me, onSend, blockedUntil, now }: Props) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  // 制限の解除はメッセージの到着と関係なく時間だけで起きるので、解除時刻に自分で再描画する
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const blocked = blockedUntil > 0 && now() < blockedUntil;

  useEffect(() => {
    const wait = blockedUntil - now();
    if (blockedUntil <= 0 || wait <= 0) return;
    const t = setTimeout(rerender, wait + 50);
    return () => clearTimeout(t);
  }, [blockedUntil, now]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // 送信中に制限がかかった場合は入力を消さずに残し、解除後にそのまま送れるようにする
    if (!text.trim() || blocked) return;
    onSend(text);
    setText('');
  };

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <p className="muted chat-empty">まだメッセージはありません</p>}
        {messages.map((m) =>
          m.by === null ? (
            <p key={m.id} className="chat-system">
              {m.text}
            </p>
          ) : (
            <p key={m.id} className={`chat-msg${m.by === me ? ' mine' : ''}`}>
              <span className="chat-name">{m.name}</span>
              <span className="chat-text">{m.text}</span>
            </p>
          ),
        )}
      </div>
      {blocked && (
        <p className="chat-limit" role="status">
          連続で送信したため、少し待ってから送ってください
        </p>
      )}
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={CHAT_MAX_LEN}
          placeholder="メッセージ"
          enterKeyHint="send"
          aria-label="チャットのメッセージ"
        />
        <button className="btn primary" type="submit" disabled={!text.trim() || blocked}>
          送信
        </button>
      </form>
    </div>
  );
}
