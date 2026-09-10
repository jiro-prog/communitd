import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLimits } from '../src/attachments.js';
import {
  INFRA_PREFIXES,
  attachmentSuffix,
  createPromptBuilder,
  formatLine,
  speakerName,
} from '../src/bridge/prompt.js';

// src/bridge/prompt.js — スレッドの transcript から prompt を組む配線。Discord の fetch を偽物にし、
// 既読位置の進め方 (取りこぼさない) と起点投稿の合流を固定する。取捨の判断 (src/transcript.js) は本物。

function msg(id, author, content, { bot = false, attachments = [] } = {}) {
  return {
    id: String(id),
    author: { id: author, bot, displayName: author, username: author },
    member: null,
    content,
    cleanContent: content,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    createdTimestamp: Number(id),
  };
}

function thread({ before = [], after = [], pages = null, starter = null, fail = false } = {}) {
  const calls = [];
  return {
    id: 'T1',
    calls,
    messages: {
      fetch: async (query) => {
        calls.push(query);
        if (fail) throw new Error('Missing Access');
        if (query.after && pages) return new Map((pages[query.after] ?? []).map((m) => [m.id, m]));
        const list = query.after ? after : before;
        return new Map(list.map((m) => [m.id, m]));
      },
    },
    fetchStarterMessage: async () => { calls.push('starter'); return starter; },
  };
}

function builder({ fetchLimit = 80, transcriptCharBudget = 100000 } = {}) {
  const bots = new Map([['fable', { key: 'fable', userId: 'F' }]]);
  return createPromptBuilder({ bots, limits: { fetchLimit, transcriptCharBudget, attachments: resolveLimits() } });
}

const BOT = { key: 'fable', userId: 'F' };

test('isInfraMessage は自前 bot の運用メッセージだけを除外の対象にする', () => {
  const { isInfraMessage } = builder();
  for (const prefix of INFRA_PREFIXES) {
    assert.equal(isInfraMessage(msg(1, 'F', `${prefix} 作業中`, { bot: true })), true, prefix);
  }
  assert.equal(isInfraMessage(msg(2, 'U1', '⏳ 人間が同じ絵文字で書いた')), false);
  assert.equal(isInfraMessage(msg(3, 'F', 'bot の本文', { bot: true })), false);
  assert.equal(isInfraMessage(msg(4, 'F', '📋 git 差分は検収材料なので除外しない', { bot: true })), false);
});

test('新規セッション: 起点投稿 + 遡り + トリガー以降 を並べ、運用メッセージと自分の発言を落とす', async () => {
  const { buildPrompt } = builder();
  const trigger = msg(104, 'U1', 'やって');
  const t = thread({
    starter: msg(50, 'U1', '最初の依頼'),
    before: [msg(101, 'U1', 'こんにちは'), msg(102, 'F', '⚙️ Fable 作業中…', { bot: true }), msg(103, 'F', 'bot の返答', { bot: true })],
    after: [msg(105, 'U1', '追記')],
  });
  const out = await buildPrompt(BOT, trigger, t, null, false);
  assert.equal(out.prompt, [
    '# Discord スレッドの新着発言 (文脈)',
    '[U1]: 最初の依頼',
    '[U1]: こんにちは',
    '[U1]: 追記',
    '',
    '# あなた宛の指示',
    '[U1]: やって',
  ].join('\n'));
  assert.equal(out.lastSeenId, '105', '既読位置は実際に渡した最新の snowflake');
  assert.equal(out.contextMessages, 3);
  assert.equal(out.omittedMessages, 0);
  assert.deepEqual(out.images, []);
  assert.deepEqual(t.calls, [{ before: '104', limit: 80 }, { after: '104', limit: 80 }, 'starter']);

  // resume できない履歴の再構築では自分の過去発言も載せる
  const withSelf = await buildPrompt(BOT, trigger, t, null, true);
  assert.match(withSelf.prompt, /\[F\]: bot の返答/);
  assert.equal(withSelf.contextMessages, 4);
});

test('継続セッション: 既読位置から前方ページネーションし、起点投稿は積み直さない', async () => {
  const { buildPrompt } = builder();
  const trigger = msg(204, 'U1', '続き');
  const pages = {
    102: Array.from({ length: 100 }, (_, i) => msg(103 + i, 'U1', `発言 ${i}`)),
    202: [msg(203, 'U1', 'ほぼ最後'), trigger, msg(205, 'U1', '後続')],
  };
  const t = thread({ pages, starter: msg(50, 'U1', '最初の依頼') });
  const out = await buildPrompt(BOT, trigger, t, { lastMessageId: '102', sessionId: 'S', cwd: 'x' }, false);
  assert.equal(out.lastSeenId, '205');
  assert.equal(t.calls.includes('starter'), false, '継続セッションで起点投稿を取りに行っている');
  assert.deepEqual(t.calls, [{ after: '102', limit: 100 }, { after: '202', limit: 100 }]);
  assert.match(out.prompt, /\[U1\]: 発言 0\n/);
  assert.match(out.prompt, /\[U1\]: 後続\n\n# あなた宛の指示\n\[U1\]: 続き$/);
  assert.equal(out.contextMessages, 102);
});

test('履歴が読めなければ既読位置を進めず、トリガーだけで続行する', async () => {
  const { buildPrompt } = builder();
  const trigger = msg(300, 'U1', '読めない');
  const kept = await buildPrompt(BOT, trigger, thread({ fail: true }), { lastMessageId: '250', sessionId: 'S', cwd: 'x' }, false);
  assert.equal(kept.lastSeenId, '250', '取りこぼした未読を既読にしている');
  assert.equal(kept.prompt, '[U1]: 読めない');
  assert.equal(kept.contextMessages, 0);

  const fresh = await buildPrompt(BOT, trigger, thread({ fail: true }), null, false);
  assert.equal(fresh.lastSeenId, '300', '新規セッションでは少なくともトリガーまで進める');
});

test('文字数予算を超えた遡り分は落として省略の見出しだけ残す (既読位置は動かない)', async () => {
  const { buildPrompt } = builder({ transcriptCharBudget: 40 });
  const trigger = msg(110, 'U1', 'やって');
  const t = thread({ before: [msg(101, 'U1', 'あ'.repeat(30)), msg(102, 'U1', 'い'.repeat(30)), msg(103, 'U1', '短い')] });
  const out = await buildPrompt(BOT, trigger, t, null, false);
  assert.ok(out.omittedMessages > 0, '予算内に収めていない');
  assert.match(out.prompt, /^# Discord スレッドの新着発言 \(文脈\)\n\(起点投稿を除く過去 \d+ 件を省略\)\n/);
  assert.equal(out.lastSeenId, '110');
  assert.equal(out.prompt.includes('あああ'), false);
});

test('speakerName / formatLine / attachmentSuffix は添付 1 件ずつ入力番号を添える', () => {
  const refs = new Map([['a1', '画像 #1'], ['t1', 'テキスト #1']]);
  const m = msg(1, 'U1', '見て\n2 行目', { attachments: [{ id: 'a1', name: 'a.png' }, { id: 't1', name: 'b.md' }, { id: 'x', name: null }] });
  assert.equal(speakerName(m), '[U1]');
  assert.equal(speakerName({ ...m, member: { displayName: '表示名' } }), '[表示名]');
  assert.equal(attachmentSuffix(m, refs), ' [添付: a.png → 画像 #1, b.md → テキスト #1, (名前なし)]');
  assert.equal(attachmentSuffix(msg(2, 'U1', 'x'), refs), '');
  assert.equal(formatLine(m, refs), '[U1]: 見て\n  2 行目 [添付: a.png → 画像 #1, b.md → テキスト #1, (名前なし)]');
  assert.equal(formatLine(msg(3, 'U1', '', { attachments: [{ id: 'z', name: 'z.png' }] }), null), '[U1]: (添付のみ) [添付: z.png]');
  assert.equal(formatLine(msg(4, 'U1', ''), null), '[U1]: (空)');
});
