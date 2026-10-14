import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIntakeWiring, INTAKE_FAILED_EMOJI, INTAKE_RECEIVED_EMOJI } from '../src/bridge/intake.js';
import { NARROWED_DENY_TOOLS } from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { INTAKE_SCHEMA, INTAKE_TOOLS } from '../src/intake.js';
import { createLifecycle } from '../src/interactions.js';

// src/bridge/intake.js — 受付 (チャンネル直下の振り分け) の配線。
// runClaude と Discord (投稿・チャンネル・スレッド) は偽物、判断 (src/intake.js) と役割文 (roles/intake.md) は本物。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-11T12:00:00Z');

function captureConsole(t) {
  const logs = [];
  const errors = [];
  const { log, error } = console;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  return { logs, errors };
}

/** 偽のスレッド (送った payload を順に残す) */
function fakeThread(id, { archived = false, parentId = 'C1' } = {}) {
  const thread = {
    id,
    archived,
    parentId,
    sent: [],
    unarchived: false,
    isThread: () => true,
    send: async (payload) => { thread.sent.push(payload); return { id: `${id}-m${thread.sent.length}` }; },
    setArchived: async (value) => { thread.unarchived = value === false; thread.archived = value; },
  };
  return thread;
}

/** 偽のテキストチャンネル (直近の発言・スレッド一覧・threads.create) */
function fakeChannel({ recent = [], active = [], archived = [] } = {}) {
  const channel = {
    id: 'C1',
    name: 'kt',
    created: [],
    sent: [],
    isThread: () => false,
    send: async (payload) => { channel.sent.push(payload); return {}; },
    messages: {
      fetch: async (opts) => { channel.fetchOpts = opts; return new Map(recent.map((m) => [m.id, m])); },
    },
    threads: {
      fetchActive: async () => ({ threads: new Map(active.map((t) => [t.id, t])) }),
      fetchArchived: async () => ({ threads: new Map(archived.map((t) => [t.id, t])) }),
      create: async ({ name }) => {
        const thread = fakeThread(`T-c${channel.created.length + 1}`);
        thread.name = name;
        channel.created.push(thread);
        return thread;
      },
    },
  };
  return channel;
}

function fakePost(channel, { id = 'P1', content = 'ログイン画面が真っ白になる' } = {}) {
  const msg = {
    id,
    content,
    cleanContent: content,
    url: `https://discord.com/channels/G/C1/${id}`,
    author: { id: 'U1', bot: false, username: 'so' },
    member: { displayName: 'そう' },
    channel,
    hasThread: false,
    attachments: new Map(),
    reactions: [],
    removed: [],
    replies: [],
    started: [],
    react: async (emoji) => {
      msg.reactions.push(emoji);
      return { users: { remove: async (userId) => { msg.removed.push([emoji, userId]); } } };
    },
    reply: async (payload) => { msg.replies.push(payload); return {}; },
    startThread: async ({ name }) => {
      const thread = fakeThread(`T-${id}`);
      thread.name = name;
      msg.started.push(thread);
      return thread;
    },
  };
  return msg;
}

const BOT_ENTRIES = [
  { key: 'fable', displayName: 'Fable', userId: 'F', rolePromptFile: 'roles/manager.md' },
  { key: 'opus', displayName: 'Opus', userId: 'O', rolePromptFile: 'roles/worker.md' },
  // 起動していない bot には回さない
  { key: 'sol', displayName: 'Sol', userId: null, rolePromptFile: 'roles/reviewer.md' },
];

function harness(t, {
  output = { body: 'わかりました', actions: [] },
  respond = null, // (opts) => Promise<result> — 既定は output を返す成功
  runs = [],
  tasks = null, // 板 (null = 板の無い配備)
  jobRuns = null, // 実行記録の読み出しを差し替える (既定は runs を返す)
  board = null, // 板の読み出しを差し替える (既定は tasks を返す)
  threads = {}, // client.channels.fetch で引けるスレッド
  rolePromptFile = 'roles/intake.md',
  configured = {},
} = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-intake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = canonicalCwd(dir);
  const lifecycle = createLifecycle();
  const calls = [];
  const runClaudeImpl = async (opts) => {
    calls.push(opts);
    if (respond) return respond(opts);
    return { ok: true, structuredOutput: output, usage: { inputTokens: 1200, outputTokens: 80 } };
  };
  const config = {
    claudeBin: 'claude',
    bots: {
      fable: { tokenEnv: 'FABLE_DISCORD_TOKEN' },
      opus: { tokenEnv: 'OPUS_DISCORD_TOKEN' },
      manager: { tokenEnv: 'MANAGER_DISCORD_TOKEN', intake: true },
    },
  };
  const intake = createIntakeWiring({
    config,
    root: ROOT,
    jobRuns: jobRuns ?? { list: ({ channel }) => runs.filter((r) => r.channelName === channel) },
    board: board ?? (tasks ? { list: ({ channel }) => tasks.filter((x) => x.channel === channel) } : null),
    lifecycle,
    botEntries: () => BOT_ENTRIES,
    runClaudeImpl,
    now: () => NOW,
  });
  const bot = {
    key: 'manager',
    userId: 'M',
    cfg: { displayName: 'Manager', model: 'opus', rolePromptFile, intake: true },
    client: { channels: { fetch: async (id) => threads[id] ?? null } },
  };
  return {
    ...io, intake, bot, calls, lifecycle, cwd,
    configured: { cwd: dir, channelName: 'kt', intake: true, ...configured },
  };
}

const contents = (sent) => sent.map((p) => p.content);

const RECENT_HEADING = '# チャンネル直下の直近の発言 (古い順・この投稿の前まで)';
const TABLE_HEADING = '# このチャンネルのスレッド (最後の動きが新しい順)';

/** プロンプトの 1 節 (見出しの次の行から空行の手前まで) */
function sectionOf(prompt, heading) {
  const lines = prompt.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `見出しが無い: ${heading}`);
  const end = lines.indexOf('', start + 1);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

test('runClaude は読むだけ・新しいセッション・常に構造化・roles/intake.md だけで呼ぶ', async (t) => {
  const h = harness(t);
  const channel = fakeChannel({
    recent: [
      { id: 'R2', createdTimestamp: 2, cleanContent: '2 通目', author: { bot: true, username: 'manager' }, member: { displayName: 'Manager' } },
      { id: 'R1', createdTimestamp: 1, cleanContent: '1 通目', author: { bot: false, username: 'so' }, member: { displayName: 'そう' } },
    ],
  });
  await h.intake.handlePost(h.bot, fakePost(channel), { configured: h.configured });

  assert.equal(h.calls.length, 1);
  const opts = h.calls[0];
  assert.equal(opts.cwd, h.cwd);
  assert.equal(opts.model, 'opus');
  assert.equal(opts.effort, 'low', 'bot に effort が無いときは low');
  assert.equal(opts.rolePromptFile, resolve(ROOT, 'roles/intake.md'));
  assert.equal(opts.resume, false);
  assert.equal(opts.sessionId, undefined);
  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.tools, [...INTAKE_TOOLS]);
  assert.deepEqual(opts.allowedTools, [...INTAKE_TOOLS]);
  assert.deepEqual(opts.disallowedTools, [...NARROWED_DENY_TOOLS]);
  assert.equal(opts.strictMcp, true);
  assert.equal(opts.settingSources, '');
  assert.deepEqual(opts.addDirs, []);
  assert.equal(opts.settingsFile, undefined, 'hooks (verify) を付けている');
  assert.equal(opts.jsonSchema, INTAKE_SCHEMA);
  assert.deepEqual(opts.scrubEnvKeys, ['FABLE_DISCORD_TOKEN', 'OPUS_DISCORD_TOKEN', 'MANAGER_DISCORD_TOKEN']);
  assert.equal(typeof opts.handle.abort, 'function');

  // プロンプト: 投稿・直近 (古い順・この投稿の前まで)・回せる担当 (起動している bot だけ、役つき)
  assert.match(opts.prompt, /# 受付する投稿\n\[そう\]\nログイン画面が真っ白になる/);
  assert.match(opts.prompt, /\[そう\]: 1 通目\n\[Manager \(bot\)\]: 2 通目/);
  assert.deepEqual(channel.fetchOpts, { limit: 20, before: 'P1' });
  assert.match(opts.prompt, /- fable \(Fable\) — manager\n- opus \(Opus\) — worker/);
  assert.doesNotMatch(opts.prompt, /- sol/);

  // 計測の 1 行 (受付 1 回の消費 — 設計メモの未決)
  assert.ok(h.logs.some((l) => /^\[job intake-P1 manager thread:C1\] .*tok in 1\.2k, out 80.*intake-ok \(行動 0\)/.test(l)), h.logs.join('\n'));
});

test('bot の effort は受付にも効き、チャンネルの編成で回せる担当を絞る', async (t) => {
  const h = harness(t, { configured: { roster: ['opus'] } });
  h.bot.cfg.effort = 'medium';
  await h.intake.handlePost(h.bot, fakePost(fakeChannel()), { configured: h.configured });
  assert.equal(h.calls[0].effort, 'medium');
  assert.match(h.calls[0].prompt, /- opus \(Opus\) — worker/);
  assert.doesNotMatch(h.calls[0].prompt, /- fable/);
});

test('その場で答える: 本文だけを返信し、⏳ を付けて外す。本文の生メンションは潰す', async (t) => {
  const h = harness(t, { output: { body: 'それは <@123456789012345678> の担当ですが、答えは README の 3 章です', actions: [] } });
  const channel = fakeChannel();
  const post = fakePost(channel);
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  assert.deepEqual(post.reactions, [INTAKE_RECEIVED_EMOJI]);
  assert.deepEqual(post.removed, [[INTAKE_RECEIVED_EMOJI, 'M']]);
  assert.equal(post.replies.length, 1);
  assert.doesNotMatch(post.replies[0].content, /<@123456789012345678>/);
  assert.match(post.replies[0].content, /README の 3 章です$/);
  assert.deepEqual(post.replies[0].allowedMentions.users, []);
  assert.deepEqual(post.started, []);
  assert.deepEqual(channel.created, []);
});

test('新しいスレッド 1 本: 元の投稿から立て、依頼文 → 専用のメンション 1 通の順で担当を起こす', async (t) => {
  const h = harness(t, {
    output: { body: 'スレッドへ回しました', actions: [{ kind: 'new_thread', title: 'ログイン画面の白画面', assignee: 'fable', brief: '再現手順を確かめて直す' }] },
  });
  const channel = fakeChannel();
  const post = fakePost(channel);
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  assert.equal(post.started.length, 1);
  const thread = post.started[0];
  assert.equal(thread.name, 'ログイン画面の白画面');
  assert.deepEqual(contents(thread.sent), ['📥 受付からの依頼\n再現手順を確かめて直す', '<@F>']);
  // 起点の発言は担当が fetchStarter で読む — 引用しない
  assert.doesNotMatch(thread.sent[0].content, /元の投稿/);
  assert.deepEqual(thread.sent[0].allowedMentions.users, [], '依頼文で通知を飛ばした');
  assert.deepEqual(thread.sent[1].allowedMentions.users, ['F']);
  assert.equal(post.replies[0].content, 'スレッドへ回しました\n\n→ 新規 <#T-P1> (fable)');
  assert.deepEqual(channel.created, []);
});

test('1 投稿から複数: threads.create で立て、それぞれに元の投稿を引用する', async (t) => {
  const h = harness(t, {
    output: {
      body: '2 つに分けました',
      actions: [
        { kind: 'new_thread', title: '白画面', assignee: 'fable', brief: '白画面を直す' },
        { kind: 'new_thread', title: 'README の誤字', assignee: 'opus', brief: '誤字を直す' },
      ],
    },
  });
  const channel = fakeChannel();
  const post = fakePost(channel, { content: '白画面になる。あと README に誤字 <@123456789012345678>' });
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  assert.deepEqual(post.started, []);
  assert.deepEqual(channel.created.map((th) => th.name), ['白画面', 'README の誤字']);
  for (const [i, who] of [[0, 'F'], [1, 'O']]) {
    const sent = channel.created[i].sent;
    assert.equal(sent.length, 2);
    assert.match(sent[0].content, /元の投稿 — そう \(https:\/\/discord\.com\/channels\/G\/C1\/P1\):\n> 白画面になる。/);
    assert.doesNotMatch(sent[0].content, /<@123456789012345678>/, '引用の生メンションが残っている');
    assert.equal(sent[1].content, `<@${who}>`);
  }
  assert.match(post.replies[0].content, /→ 新規 <#T-c1> \(fable\)\n→ 新規 <#T-c2> \(opus\)$/);
});

test('既存スレッドへ中継: 表にあるスレッドだけ・アーカイブ済みは戻してから・元の投稿を引用', async (t) => {
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const archivedThread = fakeThread('T9', { archived: true });
  const h = harness(t, {
    runs: [{ id: 'r1', threadId: 'T9', botKey: 'opus', channelName: 'kt', stage: 'ended', next: 'human', acceptedAt: recent, endedAt: recent }],
    threads: { T9: archivedThread },
    output: {
      body: '作業中のスレッドへ回しました',
      actions: [
        { kind: 'route', thread_id: 'T9', assignee: 'opus', brief: '同じ画面の続き' },
        { kind: 'route', thread_id: 'T404', assignee: 'opus', brief: '幻のスレッド' },
        { kind: 'new_thread', title: '別件', assignee: 'sol', brief: '起動していない担当' },
      ],
    },
  });
  const channel = fakeChannel({ archived: [{ id: 'T9', name: '白画面の調査', archived: true }] });
  const post = fakePost(channel);
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  // 表にスレッドが載っている (名前は Discord から、状態は実行記録から)
  assert.match(h.calls[0].prompt, /- T9 「白画面の調査」 担当: opus \/ 状態: 人の番 \(報告済み・質問中\) \/ 最後の動き: 1 時間前 \/ アーカイブ済み/);
  assert.equal(archivedThread.unarchived, true);
  assert.equal(archivedThread.sent.length, 2);
  assert.match(archivedThread.sent[0].content, /^📥 受付からの依頼\n同じ画面の続き\n\n元の投稿 — そう/);
  assert.equal(archivedThread.sent[1].content, '<@O>');
  const reply = post.replies[0].content;
  assert.match(reply, /→ 中継 <#T9> \(opus\)/);
  assert.match(reply, /⚠️ 実行しなかった \(2 件目\): 表に無いスレッド: "T404"/);
  assert.match(reply, /⚠️ 実行しなかった \(3 件目\): 呼べない担当: "sol"/);
  assert.deepEqual(post.started, [], '落とした行動まで実行した');
});

test('中継先が別チャンネルのスレッドなら投げず、失敗を返信に出す', async (t) => {
  const recent = new Date(NOW - 60 * 1000).toISOString();
  const elsewhere = fakeThread('T9', { parentId: 'C-other' });
  const h = harness(t, {
    runs: [{ id: 'r1', threadId: 'T9', botKey: 'opus', channelName: 'kt', stage: 'ended', next: 'human', acceptedAt: recent, endedAt: recent }],
    threads: { T9: elsewhere },
    output: { body: '回しました', actions: [{ kind: 'route', thread_id: 'T9', assignee: 'opus', brief: '続き' }] },
  });
  const post = fakePost(fakeChannel());
  await h.intake.handlePost(h.bot, post, { configured: h.configured });
  assert.deepEqual(elsewhere.sent, []);
  assert.match(post.replies[0].content, /⚠️ 中継 <#T9> → opus: このチャンネルのスレッドではありません/);
});

test('失敗: モデルが落ちた・様式違反・役割文の版違いは何も起こさず、❌ と「直接メンションして」を返す', async (t) => {
  const cases = [
    [{ respond: async () => ({ ok: false, error: 'timeout after 10 min' }) }, /timeout after 10 min/],
    [{ respond: async () => ({ ok: true, structuredOutput: null }) }, /出力の様式違反: 出力がオブジェクトではない/],
    [{ rolePromptFile: 'roles/_does-not-exist.md' }, /役割文を読めません/],
  ];
  for (const [opts, reason] of cases) {
    const h = harness(t, opts);
    const channel = fakeChannel();
    const post = fakePost(channel);
    await h.intake.handlePost(h.bot, post, { configured: h.configured });
    assert.deepEqual(post.reactions, [INTAKE_RECEIVED_EMOJI, INTAKE_FAILED_EMOJI]);
    assert.deepEqual(post.removed, [[INTAKE_RECEIVED_EMOJI, 'M']]);
    assert.match(post.replies[0].content, /^⚠️ 受付できませんでした \(/);
    assert.match(post.replies[0].content, reason);
    assert.match(post.replies[0].content, /bot を直接メンションしてください$/);
    assert.deepEqual(post.started, []);
    assert.deepEqual(channel.created, []);
  }
});

test('受付の途中で例外 (runClaude が reject など): ❌ と「内部エラー」を返し、スレッドを立てない', async (t) => {
  const h = harness(t, { respond: async () => { throw new Error('spawn claude ENOENT'); } });
  const channel = fakeChannel();
  const post = fakePost(channel);
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  assert.equal(h.calls.length, 1);
  assert.deepEqual(post.reactions, [INTAKE_RECEIVED_EMOJI, INTAKE_FAILED_EMOJI]);
  assert.deepEqual(post.removed, [[INTAKE_RECEIVED_EMOJI, 'M']]);
  assert.deepEqual(contents(post.replies), [
    '⚠️ 受付できませんでした (内部エラー: spawn claude ENOENT) — bot を直接メンションしてください',
  ]);
  assert.deepEqual(post.started, []);
  assert.deepEqual(channel.created, []);
  assert.ok(h.errors.includes('[intake msg:P1] 受付で例外 spawn claude ENOENT'), h.errors.join('\n'));
  assert.ok(h.logs.some((l) => /^\[job intake-P1 manager thread:C1\] .*intake-failed: 内部エラー: spawn claude ENOENT/.test(l)), h.logs.join('\n'));
  assert.equal(h.intake.inflight, 0);
});

// 改行の無い本文なので chunkText は 1900 字ちょうどで切る (1900 / 1900 / 200 の 3 通)
const LONG_PARTS = ['あ'.repeat(1900), 'い'.repeat(1900), 'う'.repeat(200)];
/** 送った 1 通の形 (先頭の字 × 字数) — 落ちたときの差分を読める長さにする */
const shape = (content) => `${content[0]}×${content.length}`;

test('1900 字を超える返答: 1 通目は投稿への返信、残りはチャンネルへ続けて送る', async (t) => {
  const h = harness(t, { output: { body: LONG_PARTS.join(''), actions: [] } });
  const channel = fakeChannel();
  const post = fakePost(channel);
  await h.intake.handlePost(h.bot, post, { configured: h.configured });

  assert.deepEqual(contents(post.replies).map(shape), ['あ×1900']);
  assert.deepEqual(contents(channel.sent).map(shape), ['い×1900', 'う×200']);
  assert.equal([...contents(post.replies), ...contents(channel.sent)].join(''), LONG_PARTS.join(''));
  for (const p of [...post.replies, ...channel.sent]) assert.deepEqual(p.allowedMentions.users, [], 'メンションを通した');
  assert.deepEqual(h.errors, []);
});

test('長い返答を途中で送れなければそこで止め、残りは送らずにログを出す', async (t) => {
  // failAt 0 = 投稿への返信 (1 通目) で落とす / 1 = チャンネルへの 1 回目 (2 通目) で落とす。3 通目はどちらでも送らない
  for (const failAt of [0, 1]) {
    const h = harness(t, { output: { body: LONG_PARTS.join(''), actions: [] } });
    const channel = fakeChannel();
    const post = fakePost(channel);
    const attempts = [];
    const sender = (via) => async (payload) => {
      attempts.push(`${via} ${shape(payload.content)}`);
      if (attempts.length === failAt + 1) throw new Error('Missing Permissions');
      return {};
    };
    post.reply = sender('reply');
    channel.send = sender('send');
    await h.intake.handlePost(h.bot, post, { configured: h.configured });

    assert.deepEqual(attempts, ['reply あ×1900', 'send い×1900'].slice(0, failAt + 1), `failAt ${failAt}: 落ちた後も送り続けた`);
    assert.deepEqual(h.errors, ['[intake msg:P1] 返信を送れませんでした: Missing Permissions']);
    // 送れなくても受付そのものは終わる (計測の 1 行が出て、数が戻る)
    assert.ok(h.logs.some((l) => /^\[job intake-P1 manager thread:C1\] .*intake-ok \(行動 0\)/.test(l)), h.logs.join('\n'));
    assert.equal(h.intake.inflight, 0);
  }
});

test('実行記録・板の読み出しが投げても、その分が表から抜けるだけで受付は続く', async (t) => {
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const runs = [{ id: 'r1', threadId: 'T9', botKey: 'opus', channelName: 'kt', stage: 'ended', next: 'human', acceptedAt: recent, endedAt: recent }];
  // 実行記録の無いスレッドでも、板の未完了のタスクは表に載る
  const tasks = [{ id: 7, threadId: 'T5', channel: 'kt', state: 'review' }];
  const broken = (what) => ({ list: () => { throw new Error(`${what} が壊れている`); } });
  const fromRuns = '- T9 「(名前不明)」 担当: opus / 状態: 人の番 (報告済み・質問中) / 最後の動き: 1 時間前';
  const fromBoard = '- T5 「(名前不明)」 担当: 不明 / 状態: レビュー待ち / 最後の動き: 不明 / 板のタスク #7 (review)';
  const runsError = '[intake] 実行記録を読めません (表から抜けます): job-runs.json が壊れている';
  const boardError = '[intake] 板を読めません (表から抜けます): board.json が壊れている';
  const cases = [
    { label: '実行記録', jobRuns: broken('job-runs.json'), table: [fromBoard], errors: [runsError] },
    { label: '板', board: broken('board.json'), table: [fromRuns], errors: [boardError] },
    {
      label: '両方',
      jobRuns: broken('job-runs.json'),
      board: broken('board.json'),
      table: ['(なし — 回せる既存のスレッドは無い)'],
      errors: [runsError, boardError],
    },
  ];
  for (const c of cases) {
    const h = harness(t, { runs, tasks, jobRuns: c.jobRuns, board: c.board });
    const post = fakePost(fakeChannel());
    await h.intake.handlePost(h.bot, post, { configured: h.configured });

    assert.equal(h.calls.length, 1, `${c.label}: 受付ごと止まった`);
    assert.deepEqual(sectionOf(h.calls[0].prompt, TABLE_HEADING), c.table, c.label);
    assert.deepEqual(h.errors, c.errors, c.label);
    assert.deepEqual(post.reactions, [INTAKE_RECEIVED_EMOJI], c.label);
    assert.deepEqual(contents(post.replies), ['わかりました'], c.label);
  }
});

test('直近の発言・稼働中 / アーカイブ済みのスレッドが取れなくても、無しのまま続けて振り分ける', async (t) => {
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const runs = [
    { id: 'r1', threadId: 'T1', botKey: 'opus', channelName: 'kt', stage: 'ended', next: 'human', acceptedAt: recent, endedAt: recent },
    { id: 'r2', threadId: 'T2', botKey: 'fable', channelName: 'kt', stage: 'ended', next: 'human', acceptedAt: recent, endedAt: recent },
  ];
  const row = (id, name, botKey, archived = false) =>
    `- ${id} 「${name}」 担当: ${botKey} / 状態: 人の番 (報告済み・質問中) / 最後の動き: 1 時間前${archived ? ' / アーカイブ済み' : ''}`;
  const ERRORS = {
    messages: '[intake msg:P1] 直近の発言を取れません (無しで続けます): messages 503',
    active: '[intake] 稼働中のスレッドを取れません: active 503',
    archived: '[intake] アーカイブ済みのスレッドを取れません: archived 503',
  };
  const cases = [
    { broken: ['messages'], recent: ['(なし)'], table: [row('T1', '稼働中の調査', 'opus'), row('T2', '済んだ調査', 'fable', true)] },
    // 稼働中が取れなくても、アーカイブ済みは取りに行く / アーカイブ済みだけ取れなければ、稼働中の名前は残る
    { broken: ['active'], recent: ['[そう]: 前の発言'], table: [row('T1', '(名前不明)', 'opus'), row('T2', '済んだ調査', 'fable', true)] },
    { broken: ['archived'], recent: ['[そう]: 前の発言'], table: [row('T1', '稼働中の調査', 'opus'), row('T2', '(名前不明)', 'fable')] },
    // Discord から何も取れなくても、表は実行記録から組める
    { broken: ['messages', 'active', 'archived'], recent: ['(なし)'], table: [row('T1', '(名前不明)', 'opus'), row('T2', '(名前不明)', 'fable')] },
  ];
  for (const c of cases) {
    const label = c.broken.join(' + ');
    const target = fakeThread('T1');
    const h = harness(t, {
      runs,
      threads: { T1: target },
      output: { body: '回しました', actions: [{ kind: 'route', thread_id: 'T1', assignee: 'opus', brief: '続き' }] },
    });
    const channel = fakeChannel({
      recent: [{ id: 'R1', createdTimestamp: 1, cleanContent: '前の発言', author: { bot: false, username: 'so' }, member: { displayName: 'そう' } }],
      active: [{ id: 'T1', name: '稼働中の調査', archived: false }],
      archived: [{ id: 'T2', name: '済んだ調査', archived: true }],
    });
    const fail = (what) => async () => { throw new Error(`${what} 503`); };
    if (c.broken.includes('messages')) channel.messages.fetch = fail('messages');
    if (c.broken.includes('active')) channel.threads.fetchActive = fail('active');
    if (c.broken.includes('archived')) channel.threads.fetchArchived = fail('archived');
    const post = fakePost(channel);
    await h.intake.handlePost(h.bot, post, { configured: h.configured });

    assert.equal(h.calls.length, 1, `${label}: 受付ごと止まった`);
    assert.deepEqual(sectionOf(h.calls[0].prompt, RECENT_HEADING), c.recent, label);
    assert.deepEqual(sectionOf(h.calls[0].prompt, TABLE_HEADING), c.table, label);
    // 直近とスレッド一覧は並行して取るので、ログの順は問わない
    assert.deepEqual([...h.errors].sort(), c.broken.map((k) => ERRORS[k]).sort(), label);
    assert.equal(target.sent.length, 2, `${label}: 依頼文 → メンションの 2 通になっていない`);
    assert.equal(target.sent[1].content, '<@O>', `${label}: 担当を起こしていない`);
    assert.equal(post.replies[0].content, '回しました\n\n→ 中継 <#T1> (opus)', label);
  }
});

test('チャンネルごとに直列: 2 通目は 1 通目が終わってから振り分ける', async (t) => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(t, {
    respond: async (opts) => {
      const first = /1 通目の投稿/.test(opts.prompt);
      order.push(first ? 'start-1' : 'start-2');
      if (first) await gate;
      order.push(first ? 'end-1' : 'end-2');
      return { ok: true, structuredOutput: { body: 'ok', actions: [] } };
    },
  });
  const channel = fakeChannel();
  const p1 = h.intake.handlePost(h.bot, fakePost(channel, { id: 'P1', content: '1 通目の投稿' }), { configured: h.configured });
  const p2 = h.intake.handlePost(h.bot, fakePost(channel, { id: 'P2', content: '2 通目の投稿' }), { configured: h.configured });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start-1'], '1 通目の途中で 2 通目が走った');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('停止: 受付を閉じていれば何もしない / 全体停止は走っている受付を撃ち、積まれていた受付も走らせない', async (t) => {
  const closed = harness(t);
  closed.lifecycle.stopAccepting();
  const quiet = fakePost(fakeChannel());
  await closed.intake.handlePost(closed.bot, quiet, { configured: closed.configured });
  assert.deepEqual(quiet.reactions, []);
  assert.deepEqual(quiet.replies, []);
  assert.equal(closed.calls.length, 0);

  let started;
  const running = new Promise((r) => { started = r; });
  const h = harness(t, {
    respond: (opts) => new Promise((resolveRun) => {
      // runClaude と同じく、handle.abort で子を止めたら aborted で返る
      opts.handle.abort = () => { opts.handle.stopRequested = true; resolveRun({ ok: false, aborted: true }); };
      started();
    }),
  });
  const channel = fakeChannel();
  const first = fakePost(channel, { id: 'P1' });
  const second = fakePost(channel, { id: 'P2' });
  const p1 = h.intake.handlePost(h.bot, first, { configured: h.configured });
  const p2 = h.intake.handlePost(h.bot, second, { configured: h.configured });
  await running;
  assert.equal(h.intake.abortAll(), 2, '走っている分と待っている分を数えていない');
  await Promise.all([p1, p2]);
  assert.equal(h.calls.length, 1, '積まれていた受付を走らせた');
  for (const post of [first, second]) {
    assert.match(post.replies[0].content, /^⏹ 受付を止めたため、この投稿は振り分けていません/);
    assert.deepEqual(post.removed, [[INTAKE_RECEIVED_EMOJI, 'M']]);
  }
  assert.equal(h.intake.inflight, 0);
});
