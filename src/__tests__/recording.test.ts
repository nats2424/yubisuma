// 録画モード（src/lib/recording.ts・src/games/random.ts）と計測の新しい印（yt-bio・yt-long）
import { afterEach, describe, expect, it } from 'vitest';
import { applyRecording, isRecordingMode, parseRecording, startRecordingMode, DEFAULT_RECORDING_SEED } from '../lib/recording';
import { random, recordingScript } from '../games/random';
import { init as wordwolfInit } from '../games/wordwolf/logic';
import { init as majorityInit } from '../games/majority/logic';
import { QUESTIONS } from '../games/majority/questions';
import { WORD_PAIRS } from '../games/wordwolf/words';
import { init as rushInit, reduce as rushReduce, type RushState } from '../games/rush/logic';
import { init as daifugoInit } from '../games/daifugo/logic';
import { nextMicroId } from '../games/micro/core';
import { enabledMicroIds } from '../games/micro/tuning';
import { pageUrl, parseSrc } from '../lib/metrics';
import { checkEvent, isAllowedUrl, metricsAllowedWith, type MetricsEnv } from '../lib/analytics';

const players = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id }));

afterEach(() => {
  applyRecording(null, false);
});

// ラッシュをステージ n まで進めて、出たミニゲームの順と seed を返す
const rushRun = (stages: number) => {
  // 誰も答えないとライフが減るので、最後まで続くようライフを多めにする
  let s: RushState = rushInit(players, 0, { lives: 10 });
  const out: [string, number][] = [[s.round.microId, s.round.seed]];
  for (let i = 1; i < stages; i++) {
    s = rushReduce(s, { type: 'timeout', stage: s.stage }, 'system', 1000 * i);
    s = rushReduce(s, { type: 'next' }, 'system', 1000 * i + 1);
    out.push([s.round.microId, s.round.seed]);
  }
  return out;
};

describe('parseRecording', () => {
  it('デモモードで ?rec=1 のときだけ有効', () => {
    expect(parseRecording('?rec=1&seed=123', false)).toEqual({ seed: 123, topics: [], micro: [], name: null });
    expect(parseRecording('?seed=123', false)).toBeNull();
    expect(parseRecording('?rec=0&seed=123', false)).toBeNull();
    expect(parseRecording('', false)).toBeNull();
  });

  it('本番（Supabase 設定あり）では常に無効', () => {
    expect(parseRecording('?rec=1&seed=123', true)).toBeNull();
    expect(startRecordingMode('?rec=1&seed=123', true)).toBeNull();
    expect(isRecordingMode()).toBe(false);
    // parseRecording を通さず設定を渡しても効かない
    expect(applyRecording({ seed: 1, topics: ['ビール'], micro: ['mash'], name: null }, true)).toBeNull();
    expect(isRecordingMode()).toBe(false);
    expect(recordingScript().topics).toEqual([]);
  });

  it('壊れた値は既定値・無視', () => {
    expect(parseRecording('?rec=1&seed=abc', false)?.seed).toBe(DEFAULT_RECORDING_SEED);
    expect(parseRecording('?rec=1&seed=-5', false)?.seed).toBe(DEFAULT_RECORDING_SEED);
    expect(parseRecording('?rec=1&micro=mash,nope,,stop', false)?.micro).toEqual(['mash', 'stop'].filter((m) => enabledMicroIds().includes(m)));
    expect(parseRecording('?rec=1&topic=%20&topic=' + 'x'.repeat(61), false)?.topics).toEqual([]);
  });

  it('お題は複数指定でき、名前は 10 文字まで', () => {
    const c = parseRecording(`?rec=1&topic=${encodeURIComponent('ビール')}&topic=b&name=${encodeURIComponent('あいうえおかきくけこさ')}`, false);
    expect(c?.topics).toEqual(['ビール', 'b']);
    expect(c?.name).toBe('あいうえおかきくけこ');
  });
});

describe('同じシードで同じ結果', () => {
  it('乱数の列が同じ', () => {
    startRecordingMode('?rec=1&seed=42', false);
    const a = Array.from({ length: 5 }, random);
    startRecordingMode('?rec=1&seed=42', false);
    const b = Array.from({ length: 5 }, random);
    startRecordingMode('?rec=1&seed=43', false);
    const c = Array.from({ length: 5 }, random);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('各ゲームの init とラッシュの展開が同じ', () => {
    const run = () => ({
      ww: wordwolfInit(players, 0),
      mj: majorityInit(players, 0),
      df: daifugoInit(players, 0),
      rush: rushRun(6),
    });
    startRecordingMode('?rec=1&seed=7', false);
    const a = run();
    startRecordingMode('?rec=1&seed=7', false);
    const b = run();
    expect(a).toEqual(b);
  });
});

describe('お題・ミニゲームの順の指定', () => {
  it('ワードウルフ：指定した語が市民側になる（お題データにある語だけ）', () => {
    const [x, y] = WORD_PAIRS[1];
    startRecordingMode(`?rec=1&seed=1&topic=${encodeURIComponent(y)}`, false);
    const s = wordwolfInit(players, 0);
    expect(s.citizenWord).toBe(y);
    expect(s.wolfWord).toBe(x);
    startRecordingMode('?rec=1&seed=1&topic=nothing', false);
    const t = wordwolfInit(players, 0);
    expect(WORD_PAIRS.some((p) => p.includes(t.citizenWord) && p.includes(t.wolfWord))).toBe(true);
  });

  it('多数派：指定した問題が先頭から順に出る', () => {
    const q1 = QUESTIONS[3].q;
    const q2 = QUESTIONS[0].q;
    startRecordingMode(`?rec=1&seed=1&topic=${encodeURIComponent(q1)}&topic=${encodeURIComponent(q2)}&topic=nothing`, false);
    const s = majorityInit(players, 0, { rounds: 5 });
    expect(s.questions.map((q) => q.q).slice(0, 2)).toEqual([q1, q2]);
    expect(s.questions).toHaveLength(5);
    expect(new Set(s.questions.map((q) => q.q)).size).toBe(5);
  });

  it('ラッシュ：指定した順に出し、長さを超えたら先頭に戻る', () => {
    const ids = enabledMicroIds().slice(0, 3);
    startRecordingMode(`?rec=1&seed=1&micro=${ids.join(',')}`, false);
    expect(rushRun(5).map(([id]) => id)).toEqual([ids[0], ids[1], ids[2], ids[0], ids[1]]);
  });

  it('台本がなければ stage を渡してもふだんどおり（直前と同じものは出ない）', () => {
    for (let i = 0; i < 50; i++) expect(nextMicroId('mash', undefined, 2)).not.toBe('mash');
  });

  it('録画モードを止めると台本も消える', () => {
    startRecordingMode('?rec=1&topic=a&micro=mash', false);
    expect(isRecordingMode()).toBe(true);
    applyRecording(null, false);
    expect(isRecordingMode()).toBe(false);
    expect(recordingScript()).toEqual({ topics: [], micro: [] });
  });
});

describe('計測', () => {
  const okEnv = (over: Partial<MetricsEnv> = {}): MetricsEnv => ({
    online: true,
    dev: false,
    mode: 'production',
    websiteId: 'w',
    prodHost: 'sukima.example',
    hostname: () => 'sukima.example',
    optedOut: () => false,
    doNotTrack: () => false,
    ...over,
  });

  it('録画モードの端末は送らない', () => {
    expect(metricsAllowedWith(okEnv())).toBe(true);
    expect(metricsAllowedWith(okEnv({ recording: () => false }))).toBe(true);
    expect(metricsAllowedWith(okEnv({ recording: () => true }))).toBe(false);
    expect(
      metricsAllowedWith(
        okEnv({
          recording: () => {
            throw new Error('x');
          },
        }),
      ),
    ).toBe(false);
  });

  it('yt-bio・yt-long の印を認める', () => {
    expect(parseSrc('?s=yt-bio')).toBe('yt-bio');
    expect(parseSrc('?s=yt-long')).toBe('yt-long');
    expect(parseSrc('?s=yt-other')).toBe('other');
    expect(isAllowedUrl(pageUrl('/', 'yt-bio'))).toBe(true);
    expect(isAllowedUrl(pageUrl('/r', 'yt-long'))).toBe(true);
    const ev = { name: 'room_create', data: { src: 'yt-long', rehost: 'no', was_guest: false, after_practice: false } };
    expect(checkEvent(ev, new Set())).not.toBeNull();
  });
});
