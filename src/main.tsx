import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary, { CrashScreen } from './components/ErrorBoundary';
import { captureEntryMarks, trackPageview } from './lib/analytics';
import './styles.css';

// 入口の印（?s= 来た元・?via=qr QR から）をタブの中に移してから、アドレス欄から消す（M-C1・R-10）。
// 残すと、リロードで数え直したり、このページの URL を共有したときに印が広がったりするため。ほかのクエリは残す
captureEntryMarks(location.search);
try {
  const url = new URL(location.href);
  if (url.searchParams.has('s') || url.searchParams.has('via')) {
    url.searchParams.delete('s');
    url.searchParams.delete('via');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
} catch {
  // 消せなくても遊びは続ける
}
// ページ表示：起動時に 1 回と、ハッシュの画面が変わるたびに 1 回。#/privacy は analytics 側で送らない（R-9）
trackPageview(location.hash);
window.addEventListener('hashchange', () => trackPageview(location.hash));

// StrictMode は開発時にエフェクトを二重実行し Realtime チャンネルの張り直しが起きるため使わない
// 最後の砦のエラー境界：どの画面で描画が例外を投げても、真っ白にせず再読み込みを促す
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary fallback={() => <CrashScreen />}>
    <App />
  </ErrorBoundary>,
);
