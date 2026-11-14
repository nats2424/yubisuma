// 共有の小さな道具。部屋の招待（J-02・J-03）と、ひとり用の記録共有（J-05）で同じ動きにする

export type ShareResult = 'shared' | 'copied' | 'aborted' | 'failed';

// 公開しているページの基準 URL（ルート公開でもサブパス公開でも、今のページの場所から作る）
const baseUrl = () => `${location.origin}${location.pathname}`;
export const roomUrl = (code: string) => `${baseUrl()}#/r/${code}`;
export const practiceUrl = () => `${baseUrl()}#/practice`;

// 招待文（J-03）。受け取った人が「何をするのか・登録不要・タップで入れる」をひと目で分かるようにする
export const inviteText = (code: string, gameName: string | undefined) =>
  ['SUKIMA で遊ぼう！タップするだけで参加（登録不要）', gameName ? `ゲーム：${gameName}` : null, `部屋コード：${code}`]
    .filter((l): l is string => l !== null)
    .join('\n');

// 記録の共有文（J-05）。数値スコアではなく「n ステージ」で見せる方針（06・07）に合わせる
export const recordText = (cleared: number) => `SUKIMA で ${cleared} ステージ。超えられる？`;

// Web Share はタッチ端末だけで使う（PC の共有シートは使いにくく、コピーの方が貼り付けやすい）
export const canWebShare = () => typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 共有シートを開き、使えなければ「本文＋URL」をコピーする。貼り付け先（LINE・Slack）でも文と URL がそろうように
export async function shareOrCopy({ title, text, url }: { title: string; text: string; url: string }): Promise<ShareResult> {
  if (canWebShare()) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      // キャンセルはそのまま終える。共有が使えない場合はコピーへ
      if ((e as Error).name === 'AbortError') return 'aborted';
    }
  }
  return (await copyText(`${text}\n${url}`)) ? 'copied' : 'failed';
}
