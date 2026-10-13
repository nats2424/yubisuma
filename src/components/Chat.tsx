import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../room/logic';

export default function Chat({ messages, me, onSend }: { messages: ChatMessage[]; me: string; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
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
      <form className="chat-form" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="メッセージ" enterKeyHint="send" />
        <button className="btn primary" type="submit" disabled={!text.trim()}>
          送信
        </button>
      </form>
    </div>
  );
}
