// ライフは「塗りのハート」と「点線のハート」で形を変え、色が分からなくても残りが数えられるようにする
const HEART_D = 'M14 24 C4 17 2 12 2 8 C2 4 5 2 8 2 C11 2 13 4 14 6 C15 4 17 2 20 2 C23 2 26 4 26 8 C26 12 24 17 14 24Z';

export default function Hearts({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="hearts" role="img" aria-label={`ライフ ${lives}`}>
      {Array.from({ length: max }, (_, i) => (
        <svg key={i} className={i < lives ? 'heart' : 'heart lost'} viewBox="0 0 28 26" aria-hidden focusable="false">
          <path className="heart-body" d={HEART_D} />
          {i < lives && <path className="heart-shine" d="M7 7 Q8 5 10 5" />}
        </svg>
      ))}
    </span>
  );
}
