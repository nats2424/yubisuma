import type { ReactNode } from 'react';

// 案B「ポップ・ステッカー」のゲームアイコン。
// 絵文字は端末ごとに絵柄が変わるため、全ゲーム同じ作法（色付きの円ステッカー＋白い図形＋墨線）で描いた SVG にそろえる。
// GameDef の型は変えず（契約変更を避ける）、UI 側でゲーム ID → 絵柄の対応表を持つ。
// 新しいゲームを足すときは「直径 42 の円・ゲーム色の平塗り・白い図形 1 つ・墨線 2.5」で 1 枚追加する。
// 墨線と白は両テーマ共通（ステッカーは紙に印刷されたもの、という見立て）なので色は固定値にしている
const INK = '#1c1a17';
const ln = { stroke: INK, strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round' } as const;

const Disc = ({ fill }: { fill: string }) => <circle {...ln} cx="24" cy="24" r="21" fill={fill} />;

const ICONS: Record<string, ReactNode> = {
  // ワードウルフ：猫に見えないよう、とがった鼻先と横に張った頬で狼の顔にした（Designer 指摘の描き直し）
  wordwolf: (
    <>
      <Disc fill="#9b7bf0" />
      <path {...ln} d="M11 30 L12 10 L20 17 H28 L36 10 L37 30 L29 34 L24 41 L19 34 Z" fill="#fff" />
      <path {...ln} d="M19 33 L24 28 L29 33" fill="none" />
      <path d="M21 37 L24 40 L27 37 Z" fill={INK} />
      <path d="M16 24 L21 26 M32 24 L27 26" stroke={INK} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  majority: (
    <>
      <Disc fill="#2bb3a3" />
      <path {...ln} d="M24 11 V36 M14 15 H34 M18 38 H30" fill="none" />
      <path {...ln} d="M9 26 L14 15 L19 26 Z M29 26 L34 15 L39 26 Z" fill="#fff" />
    </>
  ),
  reaction: (
    <>
      <Disc fill="#ffd23f" />
      <path {...ln} d="M27 8 L14 27 H23 L20 40 L34 20 H25 Z" fill="#fff" />
    </>
  ),
  rush: (
    <>
      <Disc fill="#ff5b3a" />
      <path {...ln} d="M24 8 L28 18 L39 15 L31 24 L39 33 L28 30 L24 40 L20 30 L9 33 L17 24 L9 15 L20 18 Z" fill="#fff" />
    </>
  ),
  yubisuma: (
    <>
      <Disc fill="#ff9cc2" />
      <path {...ln} d="M17 22 H21 L24 11 Q28 11 28 16 L27 21 H34 Q37 22 35 26 L33 35 Q32 37 29 37 H17 Z" fill="#fff" />
      <path {...ln} d="M12 22 H17 V37 H12 Z" fill="#fff" />
    </>
  ),
  daifugo: (
    <>
      <Disc fill="#4a74f5" />
      <rect {...ln} x="15" y="10" width="18" height="28" rx="3" fill="#fff" />
      <path {...ln} d="M18 22 L19 15 L22 19 L24 14 L26 19 L29 15 L30 22 Z" fill="#ffd23f" />
      <path d="M24 26 L28 31 H20 Z" fill={INK} />
    </>
  ),
};

// 対応表にないゲーム（版ずれで届いた未知の ID など）は、登録の絵文字をそのまま出す
export default function GameIcon({ id, emoji, size = 44 }: { id: string; emoji?: string; size?: number }) {
  const art = Object.hasOwn(ICONS, id) ? ICONS[id] : undefined;
  if (!art) {
    return (
      <span className="game-icon-fallback" style={{ fontSize: Math.round(size * 0.6), width: size, height: size }} aria-hidden>
        {emoji}
      </span>
    );
  }
  return (
    <svg className="game-icon" width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false">
      {art}
    </svg>
  );
}

// チャットを開くボタンの吹き出し（絵文字 💬 の代わり）。線の色は文字色に追従させる
export function ChatIcon() {
  return (
    <svg width="22" height="20" viewBox="0 0 20 18" aria-hidden focusable="false">
      <path
        d="M3 2 H17 Q18 2 18 3 V11 Q18 12 17 12 H8 L4 16 V12 H3 Q2 12 2 11 V3 Q2 2 3 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
