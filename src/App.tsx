import { useEffect, useState } from 'react';
import Home from './components/Home';
import Practice from './components/Practice';
import Room from './components/Room';
import { normalizeRoomCode, ROOM_CODE_LENGTH } from './lib/identity';

// ハッシュルーティング: #/ ＝ トップ、#/practice ＝ ひとりで練習、#/r/ABCD ＝ ルーム
type Route = { page: 'home' } | { page: 'practice' } | { page: 'room'; code: string };

const parse = (): Route => {
  if (location.hash.startsWith('#/practice')) return { page: 'practice' };
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9]+)/);
  if (m) {
    const code = normalizeRoomCode(m[1]);
    if (code.length === ROOM_CODE_LENGTH) return { page: 'room', code };
  }
  return { page: 'home' };
};

// 「部屋を作る」から来たルームコード（このタブで作成した場合のみホストとして初期化する）
let createdCode: string | null = null;

export const goRoom = (code: string, create = false) => {
  if (create) createdCode = code;
  location.hash = `#/r/${code}`;
};
export const goHome = () => {
  location.hash = '#/';
};

export default function App() {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route.page === 'room') {
    const create = createdCode === route.code;
    return <Room key={route.code} code={route.code} create={create} onCreated={() => (createdCode = null)} />;
  }
  if (route.page === 'practice') return <Practice />;
  return <Home />;
}
