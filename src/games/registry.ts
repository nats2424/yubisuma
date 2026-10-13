import type { GameCategory, GameDef } from './types';
import * as daifugo from './daifugo/logic';
import DaifugoView from './daifugo/View';
import * as majority from './majority/logic';
import MajorityView from './majority/View';
import * as reaction from './reaction/logic';
import ReactionView from './reaction/View';
import * as wordwolf from './wordwolf/logic';
import WordWolfView from './wordwolf/View';
import * as yubisuma from './yubisuma/logic';
import YubisumaView from './yubisuma/View';

export const GAME_LIST: GameDef[] = [
  {
    id: 'wordwolf',
    name: 'ワードウルフ',
    emoji: '🐺',
    tagline: '1人だけ違うお題。会話から少数派を見抜け',
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
    View: WordWolfView,
  },
  {
    id: 'majority',
    name: '多数派ゲーム',
    emoji: '⚖️',
    tagline: '「みんなはどっち？」を読み当てる',
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
    View: MajorityView,
  },
  {
    id: 'reaction',
    name: '反射神経バトル',
    emoji: '⚡',
    tagline: '画面が光った瞬間にタップ。一番速いのは誰だ',
    rules: [
      '画面が緑に変わったらすぐタップ。早すぎるとフライング。',
      '全5ラウンドの反応時間の合計で勝負。',
      'フライング・押し忘れは1000ms扱い。',
    ],
    minPlayers: 1,
    maxPlayers: 10,
    minutes: '約1分',
    category: 'quick',
    init: reaction.init,
    reduce: reaction.reduce,
    schedule: reaction.schedule,
    View: ReactionView,
  },
  {
    id: 'yubisuma',
    name: '指スマ',
    emoji: '👍',
    tagline: 'いっせーの！で上がる親指の合計を当てる',
    rules: [
      '全員が両手の親指を何本上げるか（0〜残りの手の数）を決めます。',
      'コール役は合わせて「全員の親指の合計」を予想します。',
      '的中したらコール役は片手を下ろせます。両手を下ろせたら上がり。最後に残った人の負け。',
    ],
    minPlayers: 2,
    maxPlayers: 8,
    minutes: '約3〜5分',
    category: 'quick',
    init: yubisuma.init,
    reduce: yubisuma.reduce,
    schedule: yubisuma.schedule,
    View: YubisumaView,
  },
  {
    id: 'daifugo',
    name: '大富豪',
    emoji: '🃏',
    tagline: 'おなじみのトランプゲーム。ラウンドを重ねて頂点へ',
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
    View: DaifugoView,
  },
];

export const GAMES: Record<string, GameDef> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
export const DEFAULT_GAME = GAME_LIST[0].id;

export const CATEGORIES: GameCategory[] = ['quick', 'long'];
export const gamesIn = (category: GameCategory) => GAME_LIST.filter((g) => g.category === category);
