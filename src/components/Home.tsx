import { useState, type FormEvent } from 'react';
import { goRoom } from '../App';
import { CATEGORIES, gamesIn } from '../games/registry';
import { CATEGORY_INFO } from '../games/types';
import { generateRoomCode, getSavedName, NAME_MAX, normalizeRoomCode, ROOM_CODE_LENGTH, saveName } from '../lib/identity';
import { isOnlineMode } from '../lib/transport';
import { Brand, DemoBanner } from './Layout';

export default function Home() {
  const [name, setName] = useState(getSavedName);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const validName = () => {
    const n = name.trim();
    if (!n) {
      setError('ニックネームを入力してください');
      return null;
    }
    saveName(n);
    return n;
  };

  const create = () => {
    if (!validName()) return;
    goRoom(generateRoomCode(), true);
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!validName()) return;
    const c = normalizeRoomCode(code);
    if (c.length !== ROOM_CODE_LENGTH) {
      setError(`${ROOM_CODE_LENGTH}文字のルームコードを入力してください`);
      return;
    }
    goRoom(c);
  };

  return (
    <div className="page home">
      <header className="topbar">
        <Brand />
      </header>
      {!isOnlineMode && <DemoBanner />}

      <main className="home-main">
        <section className="hero">
          <p className="eyebrow">隙間時間の、ちょっとした遊び場</p>
          <h1>
            URLを送るだけで、
            <br />
            すぐにみんなで。
          </h1>
          <p className="lead">登録不要・ダウンロード不要。スキマ時間にサクッと1〜5分、週末はじっくり何戦も。スマホでもPCでも。</p>
        </section>

        <section className="panel entry">
          <label className="field">
            <span className="label">ニックネーム</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              maxLength={NAME_MAX}
              placeholder={`${NAME_MAX}文字まで`}
              autoComplete="nickname"
            />
          </label>
          <button className="btn primary block" onClick={create}>
            部屋を作る
          </button>
          <div className="divider">
            <span>コードで参加</span>
          </div>
          <form className="join-row" onSubmit={join}>
            <input
              className="code-input"
              value={code}
              onChange={(e) => {
                setCode(normalizeRoomCode(e.target.value));
                setError('');
              }}
              placeholder="ABCD"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              aria-label="ルームコード"
            />
            <button className="btn" type="submit">
              参加
            </button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>

        {CATEGORIES.map((cat) => (
          <section key={cat} className="game-catalog">
            <h2>
              {CATEGORY_INFO[cat].label}
              <span className="catalog-sub">{CATEGORY_INFO[cat].description}</span>
            </h2>
            <ul className="catalog-grid">
              {gamesIn(cat).map((g) => (
                <li key={g.id} className="catalog-item">
                  <span className="catalog-emoji" aria-hidden>
                    {g.emoji}
                  </span>
                  <div>
                    <h3>{g.name}</h3>
                    <p>{g.tagline}</p>
                    <p className="meta">
                      {g.minPlayers === g.maxPlayers ? g.minPlayers : `${g.minPlayers}〜${g.maxPlayers}`}人 · {g.minutes}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}
