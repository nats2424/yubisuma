// 録画モード：SNS 用の動画を、デモモード（同じブラウザの別タブ同士）を Playwright で自動操作して撮るためのもの
// （marketing/sns/plan.md §2.1、docs/dev/10-marketing-monetization.md §2.3）。
// URL の形：?rec=1&seed=123&topic=ビール&micro=balloon,color,math&name=たろう#/r/ABCD
// - デモモードのときだけ有効。Supabase につながる本番（online）では常に無効にする。
//   本番で乱数やお題を URL から決められると、ホストが展開を仕組める（不正の余地）ため
// - 帯を消す・名前を入れる・URL を読むのは画面側（Client）。ここは読み取りと乱数の差し替えだけ
import { enabledMicroIds } from '../games/micro/tuning';
import { rng, setRandomSource, setRecordingScript } from '../games/random';
import { NAME_MAX } from './identity';

export type RecordingConfig = {
  seed: number;
  // ワードウルフは 1 つ目の語（お題データの語と一致したときだけ）、多数派は問題文の一致したものを順に出す
  topics: string[];
  // ラッシュのミニゲームの順（ステージ 1 から。長さを超えたら先頭に戻る）
  micro: string[];
  // 画面に出す名前（Client が使う）。未指定は null
  name: string | null;
};

export const DEFAULT_RECORDING_SEED = 1;
const TOPIC_MAX = 10;
const TOPIC_LEN_MAX = 60;
const MICRO_MAX = 50;

// URL の search（'?rec=1&…'）を読む。録画モードでない・online のときは null。例外は投げない
export const parseRecording = (search: string, online: boolean): RecordingConfig | null => {
  if (online) return null;
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (p.get('rec') !== '1') return null;
  const rawSeed = p.get('seed');
  const n = rawSeed !== null && /^\d{1,10}$/.test(rawSeed) ? Number(rawSeed) : NaN;
  const seed = Number.isSafeInteger(n) ? n >>> 0 : DEFAULT_RECORDING_SEED;
  const topics = p
    .getAll('topic')
    .map((t) => t.trim())
    .filter((t) => t !== '' && t.length <= TOPIC_LEN_MAX)
    .slice(0, TOPIC_MAX);
  const enabled = new Set(enabledMicroIds());
  const micro = (p.get('micro') ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => enabled.has(m))
    .slice(0, MICRO_MAX);
  const rawName = (p.get('name') ?? '').trim();
  const name = rawName === '' ? null : Array.from(rawName).slice(0, NAME_MAX).join('');
  return { seed, topics, micro, name };
};

let active: RecordingConfig | null = null;

// 録画モードを始める（null なら止める）。乱数をシード付きに、お題・ミニゲームの順を台本に差し替える。
// online が真なら何もしない（parseRecording を通さずに呼ばれても本番では効かない二重の止め）。
// 戻り値は有効になった設定（無効なら null）
export const applyRecording = (cfg: RecordingConfig | null, online: boolean): RecordingConfig | null => {
  if (online || cfg === null) {
    active = null;
    setRandomSource(null);
    setRecordingScript(null);
    return null;
  }
  active = { ...cfg, topics: [...cfg.topics], micro: [...cfg.micro] };
  setRandomSource(rng(cfg.seed));
  setRecordingScript({ topics: cfg.topics, micro: cfg.micro });
  return active;
};

// 画面側の入口：起動時に 1 回呼ぶ（例：startRecordingMode(location.search, isOnlineMode)）
export const startRecordingMode = (search: string, online: boolean): RecordingConfig | null =>
  applyRecording(parseRecording(search, online), online);

// 録画モード中か（帯を消す・計測を送らない判定に使う）
export const isRecordingMode = (): boolean => active !== null;
export const recordingConfig = (): RecordingConfig | null => active;
