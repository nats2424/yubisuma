import type { GameCategory, GameDef } from './types';
import { speedUpRuleText, TUNING } from './micro/tuning';
import * as daifugo from './daifugo/logic';
import DaifugoView from './daifugo/View';
import * as majority from './majority/logic';
import MajorityView from './majority/View';
import * as reaction from './reaction/logic';
import * as rush from './rush/logic';
import RushView from './rush/View';
import ReactionView from './reaction/View';
import * as wordwolf from './wordwolf/logic';
import WordWolfView from './wordwolf/View';

export const GAME_LIST: GameDef[] = [
  {
    id: 'wordwolf',
    name: 'ワードウルフ',
    emoji: '🐺',
    tagline: '1人だけ違うお題。会話から少数派を見抜け',
    oneLiner: 'お題について話して、1 人だけ違うお題の人を当てよう',
    rules: [
      '全員にお題が配られますが、1人（6人以上なら2人）だけ少し違うお題を持っています。',
      '制限時間（標準3分）でお題について話し合います。お題そのものを口にするのはNG。',
      '最後に投票。少数派（ウルフ）を当てれば市民の勝ち、外れるか同票ならウルフの勝ち。',
    ],
    minPlayers: 3,
    maxPlayers: 10,
    minutes: '約5分',
    category: 'quick',
    options: [
      {
        key: 'talkMinutes',
        label: '話し合い',
        choices: [
          { value: 2, label: '2分' },
          { value: 3, label: '3分' },
          { value: 5, label: '5分' },
        ],
        default: 3,
      },
    ],
    init: wordwolf.init,
    reduce: wordwolf.reduce,
    schedule: wordwolf.schedule,
    isOver: wordwolf.isOver,
    View: WordWolfView,
  },
  {
    id: 'majority',
    name: '多数派ゲーム',
    emoji: '⚖️',
    tagline: '「みんなはどっち？」を読み当てる',
    oneLiner: 'みんなが選びそうな方を選ぼう',
    rules: [
      '2択の質問が5問（または10問）出ます。',
      '自分の好みではなく「多数派になりそうな方」を選びます。',
      '多数派を選んだ人に1ポイント。同数ならポイントなし。',
    ],
    minPlayers: 3,
    maxPlayers: 10,
    minutes: '約3分',
    category: 'quick',
    options: [
      {
        key: 'rounds',
        label: '問題数',
        choices: [
          { value: 5, label: '5問' },
          { value: 10, label: '10問' },
        ],
        default: 5,
      },
    ],
    init: majority.init,
    reduce: majority.reduce,
    schedule: majority.schedule,
    isOver: majority.isOver,
    View: MajorityView,
  },
  {
    id: 'reaction',
    name: '反射神経バトル',
    emoji: '⚡',
    tagline: '画面が光った瞬間にタップ。一番速いのは誰だ',
    oneLiner: '緑になったら、すぐタップ',
    rules: [
      '画面が緑に変わったらすぐタップ。早すぎるとフライング。',
      '全5ラウンドの反応時間の合計で勝負。',
      'フライング・押し忘れは1000ms扱い。',
    ],
    minPlayers: 1,
    maxPlayers: 10,
    minutes: '約1〜2分',
    category: 'quick',
    init: reaction.init,
    reduce: reaction.reduce,
    schedule: reaction.schedule,
    isOver: reaction.isOver,
    View: ReactionView,
  },
  {
    id: 'rush',
    name: 'ミニゲームラッシュ',
    emoji: '💥',
    tagline: '数秒のミニゲームが次々に。どこまで生き残れるか',
    oneLiner: '出た指示どおりに、すぐ操作。ミスするとライフが減る',
    rules: [
      '「連打！」「よけろ！」「止めろ！」など、数秒で終わるミニゲームが次々に出ます。全員同時に挑戦。',
      // 数値は調整値から作る（調整しても説明と食い違わないように。AC-42）
      `失敗するとライフが1つ減り、0になったら脱落。${speedUpRuleText()}。`,
      '最後まで生き残った人の勝ち。順位はクリアしたステージ数で決まります。',
    ],
    minPlayers: 1,
    maxPlayers: 10,
    minutes: '約2〜5分',
    category: 'quick',
    options: [
      {
        key: 'lives',
        label: 'ライフ',
        choices: TUNING.lives.choices.map((n) => ({ value: n, label: String(n) })),
        default: TUNING.lives.default,
      },
    ],
    init: rush.init,
    reduce: rush.reduce,
    schedule: rush.schedule,
    isOver: rush.isOver,
    View: RushView,
  },
  {
    id: 'daifugo',
    name: '大富豪',
    emoji: '🃏',
    tagline: 'おなじみのトランプゲーム。ラウンドを重ねて頂点へ',
    oneLiner: '前より強いカードを出して、早く手札をなくそう',
    rules: [
      '場と同じ枚数で、より強いカードを出していきます（3が最弱、2が最強、ジョーカーは万能）。出せない・出さないときはパス。',
      '全員がパスしたら場が流れ、最後に出した人から再開。8を出すと「8切り」で即流れます。',
      '同じ数字4枚で「革命」（強さが逆転）。ジョーカー1枚にはスペードの3で返せます。',
      '手札を早くなくした順に順位が決まり、次のラウンドは大貧民⇔大富豪で2枚、貧民⇔富豪で1枚カードを交換。',
      '持ち時間は1手45秒。時間切れはパス（親のときは一番弱いカードを自動で出します）。',
    ],
    minPlayers: 3,
    maxPlayers: 6,
    minutes: '20〜40分',
    category: 'long',
    options: [
      {
        key: 'rounds',
        label: 'ラウンド数',
        choices: [
          { value: 3, label: '3回（約20分）' },
          { value: 5, label: '5回（約30分）' },
          { value: 10, label: '10回（約1時間）' },
        ],
        default: 5,
      },
    ],
    init: daifugo.init,
    reduce: daifugo.reduce,
    schedule: daifugo.schedule,
    isOver: daifugo.isOver,
    View: DaifugoView,
  },
];

export const GAMES: Record<string, GameDef> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
// 部屋を作ったときに最初に選ばれているゲーム（D-45 / J-07）。
// 1 人から遊べて指示だけで分かるラッシュを最初の 1 本にする（ワードウルフは説明が要るので 2 本目以降に向く）。
// 一覧の並び（GAME_LIST）とは切り離して、ここで明示する
export const DEFAULT_GAME: string = 'rush';

export const CATEGORIES: GameCategory[] = ['quick', 'long'];
export const gamesIn = (category: GameCategory) => GAME_LIST.filter((g) => g.category === category);
