import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

// 招待 URL の QR コード（D-25：対面で集まっている人をすぐ部屋に入れる）。
// 部屋の URL を第三者に送らないよう、外部の QR 生成サービスは使わずブラウザ内で作る。
// ライブラリの createSvgTag は文字列を返すので innerHTML が要る。それを避け、
// セルの明暗だけを読んで React の <path> として描く。

// 読み取りに要る白い余白（クワイエットゾーン）。規格の推奨どおり 4 セル分取る
const QUIET = 4;

// 黒いセルを 1 本の path にまとめる（セルごとに <rect> を作ると数百〜千個の要素になるため）
function qrPath(text: string): { size: number; d: string } {
  // 誤り訂正 M：URL が短いので型番を上げすぎず、画面の反射や指のかぶりにもある程度耐える
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
  }
  return { size: n + QUIET * 2, d };
}

export default function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  return (
    // ダークテーマでも反転させず、常に白地に黒で描く（反転した QR は読めないカメラがある）
    <svg
      className={`qr${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
