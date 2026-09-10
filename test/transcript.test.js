import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTranscript } from '../src/transcript.js';

const BOT = 'BOT1';

/** discord.js の Message のうち selectTranscript が触る分だけの最小スタブ */
function msg(id, createdTimestamp, authorId = 'human', content = '') {
  return { id: String(id), author: { id: authorId }, createdTimestamp, content };
}

const ids = (list) => list.map((m) => m.id);
/** 既定の呼び方 (予算なし) — messages だけ見たいテスト用 */
const pick = (args) => ids(selectTranscript(args).messages);

test('親起点 + スレッド返信が一度ずつ createdTimestamp 正順で並ぶ', () => {
  // 起点は親チャンネル側なので必ず最古。history はあえて逆順で渡す
  const starter = msg('100', 1000);
  const history = [msg('300', 3000, 'sol'), msg('200', 2000)];

  assert.deepEqual(pick({ starter, history, triggerId: '400', botUserId: BOT }), [
    '100',
    '200',
    '300',
  ]);
});

test('起点投稿がトリガー自身なら注入しない (チャンネル直メンション)', () => {
  // 人間が親チャンネルで直接メンション → その発言から startThread されるので starter === trigger
  const trigger = msg('100', 1000);
  const out = pick({
    starter: trigger,
    history: [msg('200', 2000, 'sol')],
    triggerId: trigger.id,
    botUserId: BOT,
  });

  assert.deepEqual(out, ['200']);
});

test('starter なし (継続セッション相当) は従来どおりスレッド分のみ', () => {
  const out = pick({
    starter: null,
    required: [msg('300', 3000), msg('200', 2000, 'sol')],
    triggerId: '400',
    botUserId: BOT,
  });

  assert.deepEqual(out, ['200', '300']);
});

test('starter が history にも現れても一度だけに畳む', () => {
  const starter = msg('100', 1000);
  const out = pick({
    starter,
    history: [msg('100', 1000), msg('200', 2000)],
    triggerId: '400',
    botUserId: BOT,
  });

  assert.deepEqual(out, ['100', '200']);
});

test('自分の発言は既定で除外し、includeSelf=true なら残す (起点も同じ扱い)', () => {
  const args = {
    starter: msg('100', 1000, BOT),
    history: [msg('200', 2000, 'human'), msg('300', 3000, BOT)],
    triggerId: '400',
    botUserId: BOT,
  };

  assert.deepEqual(pick(args), ['200']);
  assert.deepEqual(pick({ ...args, includeSelf: true }), ['100', '200', '300']);
});

test('isInfra が真のメッセージは起点でも除外する', () => {
  const out = pick({
    starter: msg('100', 1000, BOT, '⏳ 受け付けました'),
    history: [msg('200', 2000)],
    triggerId: '400',
    botUserId: BOT,
    includeSelf: true,
    isInfra: (m) => m.content.startsWith('⏳'),
  });

  assert.deepEqual(out, ['200']);
});

test('起点も発言も空なら空配列 (取得失敗時に落ちない)', () => {
  assert.deepEqual(
    selectTranscript({ starter: null, triggerId: '400', botUserId: BOT }),
    { messages: [], omitted: 0 },
  );
});

// ---- 文字数予算 ----

/** 1 発言 = 10 文字として測る */
const measure = () => 10;

test('予算内なら 1 件も落とさず omitted は 0', () => {
  const out = selectTranscript({
    starter: null,
    history: [msg('200', 2000), msg('300', 3000)],
    triggerId: '400',
    botUserId: BOT,
    charBudget: 100,
    measure,
  });

  assert.deepEqual(ids(out.messages), ['200', '300']);
  assert.equal(out.omitted, 0);
});

test('予算超過は history の古い方から連続して落とす', () => {
  const out = selectTranscript({
    starter: null,
    history: [msg('100', 1000), msg('200', 2000), msg('300', 3000), msg('400', 4000)],
    triggerId: '900',
    botUserId: BOT,
    charBudget: 25, // 10 文字 × 2 件まで
    measure,
  });

  assert.deepEqual(ids(out.messages), ['300', '400']);
  assert.equal(out.omitted, 2);
});

test('starter と required は予算を超えても落ちない (落とすと恒久欠落するため)', () => {
  const out = selectTranscript({
    starter: msg('100', 1000),
    history: [msg('200', 2000), msg('300', 3000)],
    required: [msg('500', 5000), msg('600', 6000)],
    triggerId: '900',
    botUserId: BOT,
    charBudget: 10, // starter だけで使い切る
    measure,
  });

  assert.deepEqual(ids(out.messages), ['100', '500', '600']);
  assert.equal(out.omitted, 2);
});

test('予算は starter の分を差し引いてから history に配る', () => {
  const args = {
    starter: msg('100', 1000),
    history: [msg('200', 2000), msg('300', 3000)],
    triggerId: '900',
    botUserId: BOT,
    measure,
  };

  // starter 10 + history 20 = 30 — ちょうど収まる
  assert.deepEqual(ids(selectTranscript({ ...args, charBudget: 30 }).messages), [
    '100',
    '200',
    '300',
  ]);
  // 1 文字足りなければ最古の history が 1 件落ちる
  const tight = selectTranscript({ ...args, charBudget: 29 });
  assert.deepEqual(ids(tight.messages), ['100', '300']);
  assert.equal(tight.omitted, 1);
});

test('除外された発言は予算を消費しない (自分の発言・運用メッセージ)', () => {
  const out = selectTranscript({
    starter: null,
    history: [msg('100', 1000, BOT), msg('200', 2000, BOT), msg('300', 3000, 'human')],
    triggerId: '900',
    botUserId: BOT,
    charBudget: 10,
    measure,
  });

  assert.deepEqual(ids(out.messages), ['300']);
  assert.equal(out.omitted, 0);
});

test('charBudget 未指定・0 は無制限 (既存の呼び出しを変えない)', () => {
  const history = Array.from({ length: 50 }, (_, i) => msg(100 + i, 1000 + i));
  for (const charBudget of [undefined, 0, -1]) {
    const out = selectTranscript({
      starter: null,
      history,
      triggerId: '900',
      botUserId: BOT,
      charBudget,
      measure,
    });
    assert.equal(out.messages.length, 50);
    assert.equal(out.omitted, 0);
  }
});
