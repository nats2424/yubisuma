import { useCallback, useEffect, useRef, useState } from 'react';
import { goHome } from '../App';
import { isMetricsOptedOut, metricsAllowed, setMetricsOptOut } from '../lib/analytics';
import { Brand } from './Layout';
import { Panel } from './ui';

// 匿名の利用統計の説明（docs/dev/02-architecture.md §14.5・M-C7）。
// 外部送信規律の「公表」の 3 項目（送る情報・送り先・目的）と「送らない」の切り替えを 1 か所にまとめ、
// 単独の画面（#/privacy）と、部屋・ひとり用の画面のモーダルで同じ中身を使う。
// 送り先の運営会社は Umami Software, Inc.（米国。Umami の DPA に記載）
export function PrivacyContent() {
  const [off, setOff] = useState(isMetricsOptedOut);
  const [saveFailed, setSaveFailed] = useState(false);
  const choose = (v: boolean) => {
    // 保存に失敗しても、このタブでは選んだ値を保つ（analytics 側の仕様。R-2）。失敗したことだけを伝える
    const saved = setMetricsOptOut(v);
    setOff(isMetricsOptedOut());
    setSaveFailed(!saved);
  };
  // 「送る」を選んでいても、追跡しない・GPC・本番以外・ID 未設定などで実際には送らないことがある。
  // 選んだ値だけを見て「送る」と出すと事実と違うので、送るかどうかの判定（metricsAllowed）そのものを見て表示する。
  // 描画のたびに判定するので、ボタンを押して再描画されれば最新になる
  const status = off ? '送らない' : metricsAllowed() ? '送る' : '送っていません（ブラウザの設定などのため）';
  return (
    <div className="privacy-body">
      <ul className="privacy-list">
        <li>目的：SUKIMA がどのくらい遊ばれているかを数えて、改善するためです。</li>
        <li>
          送るもの：
          <ul className="privacy-sublist">
            <li>開いた画面の種類（トップ・ひとり用・部屋）と、来た元のサイトの種類（検索・SNS など）。</li>
            <li>
              部屋を作った・入った・招待した・ゲームを始めた・ルールを開いた・つながらなかった、などの出来事と、その時の人数・ゲームの種類・部屋で何回目のゲームか。
            </li>
            <li>部屋への入り方（QR・コード・リンク）。</li>
            <li>
              前に遊んだことがあるかの区分け（前にもホストしたか（7 日・28 日以内）、前は参加者だったか、ひとり用のあとか）。
            </li>
            <li>ひとり用で進んだステージの区分け（1〜4 など）と、自己ベストを更新したか。</li>
            <li>画面の大きさ、言語、ブラウザの種類、アプリの版。</li>
          </ul>
        </li>
        <li>送らないもの：名前、チャット、部屋コード、ゲームの中の手・答え・得点。</li>
        <li>送り先：Umami Software, Inc.（米国）のアクセス解析サービス「Umami Cloud」。</li>
        <li>
          SUKIMA はあなたを見分ける番号を作らず、Cookie も使いません。ただし送り先の Umami
          は、届いたIPアドレス（ネットの住所）とブラウザの種類から、短い期間の訪問のまとまりと、おおまかな地域（国・地域）を出します（Umami
          はIPアドレスそのものは保存しないと説明しています）。
        </li>
        <li>
          この端末の中に、最後に部屋を作った・参加した・ひとり用を遊んだ日付と、「送らない」の設定を保存します。また、このタブを閉じるまで、部屋ごとの遊んだ回数・人数と、どこから来たかの印を保存します。どれもそのままは送らず、上の区分けを作るのに使います（「送らない」のときは、設定のほかは保存しません）。
        </li>
        <li>
          ほかに通信するところ：遊ぶための通信（Supabase）、文字の形（Google Fonts）、サイトの配信（Cloudflare）。これらのサービスにも、仕組み上、あなたのIPアドレスが届きます。
        </li>
        <li>送りたくないとき：下の「送らない」を押すと、この端末からは送りません。</li>
      </ul>
      <div className="privacy-switch">
        <p className="label" id="privacy-switch-label">
          この端末からの送信：<strong>{status}</strong>
        </p>
        <div className="segmented" role="group" aria-labelledby="privacy-switch-label">
          <button className={off ? 'selected' : ''} aria-pressed={off} onClick={() => choose(true)}>
            送らない
          </button>
          <button className={off ? '' : 'selected'} aria-pressed={!off} onClick={() => choose(false)}>
            送る
          </button>
        </div>
        <p className="privacy-status" role="status" aria-live="polite">
          {saveFailed ? 'この端末では設定を保存できません。このタブを閉じるまでは選んだ設定を守ります。' : ''}
        </p>
      </div>
      <p className="note">※ ブラウザで「追跡しない」を設定している場合は、最初から送りません。</p>
    </div>
  );
}

// 単独の画面（#/privacy）。トップの一番下のリンクから来る。アプリの中から来たら履歴で戻り、直接開いたらトップへ
export function PrivacyPage({ cameFromApp }: { cameFromApp: boolean }) {
  const back = () => {
    if (cameFromApp) history.back();
    else goHome();
  };
  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <button className="btn small ghost" onClick={back}>
          戻る
        </button>
      </header>
      <main className="privacy-main">
        <Panel title="匿名の利用統計について">
          <PrivacyContent />
        </Panel>
      </main>
    </div>
  );
}

// 部屋・ひとり用の画面に置く目立たない小さなリンク（M-5）。画面を移らずにモーダルで開くので、
// 部屋を抜けない・挑戦が途切れない。閉じると元の画面に戻る
export function PrivacyLink() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    ref.current?.focus();
  }, []);
  return (
    <>
      <button ref={ref} className="foot-link" onClick={() => setOpen(true)} aria-haspopup="dialog">
        匿名の利用統計について
      </button>
      {open && <PrivacyDialog onClose={close} />}
    </>
  );
}

function PrivacyDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div className="privacy-backdrop" onClick={onClose}>
      <div
        className="privacy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-head">
          <h2 id="privacy-dialog-title">匿名の利用統計について</h2>
          <button className="btn small ghost" onClick={onClose} autoFocus>
            閉じる
          </button>
        </header>
        <PrivacyContent />
      </div>
    </div>
  );
}
