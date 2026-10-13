export const SITE_NAME = 'SUKIMA';

export function Brand() {
  return (
    <a className="brand" href="#/">
      <span className="brand-mark" aria-hidden />
      {SITE_NAME}
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
