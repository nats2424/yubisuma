import type { GameDef } from './types';
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
      '3分間、お題について話し合います。お題そのものを口にするのはNG。',
      '最後に投票。少数派（ウルフ）を当てれば市民の勝ち、外れるか同票ならウルフの勝ち。',
    ],
    minPlayers: 3,
    maxPlayers: 10,
    minutes: '約5分',
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
      '2択の質問が5問出ます。',
      '自分の好みではなく「多数派になりそうな方」を選びます。',
      '多数派を選んだ人に1ポイント。同数ならポイントなし。',
    ],
    minPlayers: 3,
    maxPlayers: 10,
    minutes: '約3分',
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
    init: yubisuma.init,
    reduce: yubisuma.reduce,
    schedule: yubisuma.schedule,
    View: YubisumaView,
  },
];

export const GAMES: Record<string, GameDef> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));
export const DEFAULT_GAME = GAME_LIST[0].id;
