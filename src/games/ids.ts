// 登録しているゲームの ID の一覧（計測で「送ってよい game の値」に使う。docs/dev/02 §14.6 M-1）。
// registry.ts は各ゲームの View（React）を読み込むので、計測の部品（src/lib/analytics.ts）からは
// こちらを使う。registry と食い違わないことは src/__tests__/metrics.test.ts で確かめる
export const GAME_IDS: readonly string[] = ['wordwolf', 'majority', 'reaction', 'rush', 'daifugo'];

export const GAME_ID_SET: ReadonlySet<string> = new Set(GAME_IDS);
