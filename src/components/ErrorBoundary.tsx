import { Component, type ErrorInfo, type ReactNode } from 'react';

// 描画中の例外で React がツリーごと外し、画面が真っ白になるのを防ぐ（SEC-04 / MVP-15）。
// game.state は検証しない設計（R-02 / R-03）なので、想定外の形の状態で View が投げることはありうる
type Props = { fallback: (reset: () => void) => ReactNode; children: ReactNode };
type State = { failed: boolean };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 原因の調査用にコンソールへは残す（画面にはエラーの中身を出さない）
    console.error('[SUKIMA] 画面の描画に失敗しました', error, info.componentStack);
  }

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}

export const reloadPage = () => location.reload();

// 部屋の外枠ごと落ちたときの全画面の表示。トップへ戻る導線も残す
export function CrashScreen() {
  return (
    <div className="page">
      <main className="center">
        <div className="panel entry message">
          <h2>
            画面を表示<wbr />
            できませんでした
          </h2>
          <p className="muted">ページを再読み込みしてください。</p>
          <div className="row message-actions">
            <button className="btn primary" onClick={reloadPage}>
              再読み込み
            </button>
            <button
              className="btn"
              onClick={() => {
                location.hash = '#/';
                location.reload();
              }}
            >
              トップへ
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
