import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary, { CrashScreen } from './components/ErrorBoundary';
import './styles.css';

// StrictMode は開発時にエフェクトを二重実行し Realtime チャンネルの張り直しが起きるため使わない
// 最後の砦のエラー境界：どの画面で描画が例外を投げても、真っ白にせず再読み込みを促す
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary fallback={() => <CrashScreen />}>
    <App />
  </ErrorBoundary>,
);
