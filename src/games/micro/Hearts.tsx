export default function Hearts({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="hearts" aria-label={`ライフ ${lives}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < lives ? 'heart' : 'heart lost'}>
          ♥
        </span>
      ))}
    </span>
  );
}
