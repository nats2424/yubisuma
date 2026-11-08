export const SITE_NAME = 'SUKIMA';

// ロゴは「SUKI」と「MA」の間を斜めの“隙間”で切ったステッカー。読み上げでは SUKIMA と一続きに読ませる
export function Brand() {
  return (
    <a className="brand" href="#/" aria-label={SITE_NAME}>
      <span className="logo" aria-hidden>
        SUKI
        <i className="logo-slit" />
        MA
      </span>
    </a>
  );
}

export function DemoBanner() {
  return (
    <div className="demo-banner">
      デモモード：Supabase未設定のため、同じブラウザ内の別タブ同士でのみ遊べます（README参照）。
    </div>
  );
}
