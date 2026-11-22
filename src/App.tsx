import { useEffect, useState } from 'react';
import Home from './components/Home';
import Practice from './components/Practice';
import { PrivacyPage } from './components/Privacy';
import Room from './components/Room';
import { normalizeRoomCode, ROOM_CODE_LENGTH } from './lib/identity';

// ハッシュルーティング: #/ ＝ トップ、#/practice ＝ ひとりで練習、#/r/ABCD ＝ ルーム、#/privacy ＝ 匿名の利用統計の説明
type Route = { page: 'home' } | { page: 'practice' } | { page: 'privacy' } | { page: 'room'; code: string };

const parse = (): Route => {
  if (location.hash.startsWith('#/privacy')) return { page: 'privacy' };
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
// 作成時にホストが最初に選んでおくゲーム（ひとり用の「友達と勝負する」→ ラッシュ。J-06）。未指定なら既定のゲーム
let createdGame: string | undefined;
// 作成要求ごとに増やす番号。Room の key に含め、同じハッシュのままでも Room を作り直す（AC-32）
let createNonce = 0;
// ハッシュが変わらない遷移（「部屋が見つかりません」→「このコードで部屋を作る」）は hashchange が起きないので、App へ直接知らせる
const routeListeners = new Set<() => void>();

export const goRoom = (code: string, create = false, initialGame?: string) => {
  if (create) {
    createdCode = code;
    createdGame = initialGame;
    createNonce += 1;
  }
  const hash = `#/r/${code}`;
  if (location.hash === hash) routeListeners.forEach((f) => f());
  else location.hash = hash;
};
export const goHome = () => {
  location.hash = '#/';
};

const onCreated = () => {
  createdCode = null;
  createdGame = undefined;
};

export default function App() {
  const [route, setRoute] = useState<Route>(parse);
  const [nonce, setNonce] = useState(createNonce);
  // 説明の画面の「戻る」で、アプリの中から来たなら履歴で戻る（直接開いたときに履歴で外のサイトへ出ないように）
  const [navigated, setNavigated] = useState(false);
  useEffect(() => {
    const onRoute = () => {
      setNavigated(true);
      setRoute(parse());
      setNonce(createNonce);
    };
    window.addEventListener('hashchange', onRoute);
    routeListeners.add(onRoute);
    return () => {
      window.removeEventListener('hashchange', onRoute);
      routeListeners.delete(onRoute);
    };
  }, []);

  if (route.page === 'room') {
    const create = createdCode === route.code;
    return (
      <Room
        key={`${route.code}:${nonce}`}
        code={route.code}
        create={create}
        initialGame={create ? createdGame : undefined}
        onCreated={onCreated}
      />
    );
  }
  if (route.page === 'practice') return <Practice />;
  if (route.page === 'privacy') return <PrivacyPage cameFromApp={navigated} />;
  return <Home />;
}
