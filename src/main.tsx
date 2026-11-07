import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode は開発時にエフェクトを二重実行し Realtime チャンネルの張り直しが起きるため使わない
createRoot(document.getElementById('root')!).render(<App />);
