import { speedForStage } from './tuning';

// 何ステージ目かを数字のスコアではなく「道のり」で見せる（06 §5.5：数値スコアは出さない）。
// 10 ステージずつの区間を丸で並べ、済み＝塗り・現在＝大きい丸・スピードアップする段＝四角の旗、と形でも区別する。
// 旗の位置は調整値（speedForStage）から読むだけで、判定や進行には関わらない
const SPAN = 10;

export default function StageTrack({ stage }: { stage: number }) {
  const from = Math.floor((stage - 1) / SPAN) * SPAN + 1;
  return (
    <span className="track" aria-hidden>
      {Array.from({ length: SPAN }, (_, i) => {
        const n = from + i;
        const flag = n > 1 && speedForStage(n) > speedForStage(n - 1);
        const cls = [n < stage ? 'done' : n === stage ? 'cur' : '', flag ? 'flag' : ''].filter(Boolean).join(' ');
        return <i key={n} className={cls} />;
      })}
    </span>
  );
}
