import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContractWiring } from '../src/bridge/contracts.js';
import { createDiscordWiring } from '../src/bridge/discord.js';
import { createMessageWiring } from '../src/bridge/messages.js';
import { createRunRecorder } from '../src/bridge/recorder.js';
import { bindContract, formatContractTag } from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { HopTracker } from '../src/hops.js';
import { createLifecycle } from '../src/interactions.js';
import { JobRunStore } from '../src/jobruns.js';
import { JobQueue, laneKeyFor } from '../src/queue.js';
import { planRecovery } from '../src/recovery.js';
import { ContractStore } from '../src/store.js';
import { deriveTaskStatus } from '../src/taskstatus.js';

// src/bridge/messages.js — Discord のメッセージが job になるまでの入口 (onMessage)。
// hops・キュー・実行記録・契約は本物、Discord のメッセージとスレッドだけ偽物。
// job の中身 (runJob) は呼ばれたことと渡された cc を見るだけ。

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

const NONCE = 'abcdef0123456789';

function fakeThread(id = 'T1', { parentName = 'kt' } = {}) {
  const thread = {
    id,
    sent: [],
    parent: { name: parentName },
    isThread: () => true,
    send: async (payload) => {
      const message = { id: `${id}-m${thread.sent.length + 1}`, edits: [], edit: async (p) => { message.edits.push(p); } };
      thread.sent.push({ ...payload, message });
      return message;
    },
  };
  return thread;
}

function fakeMessage({
  authorId = 'U1', bot = false, content = '<@F> こんにちは', channel = fakeThread(), id = 'M1',
  member = null, // ロールで許可するときだけ渡す (メンション経路は GuildMember 形)
} = {}) {
  const msg = {
    id,
    content,
    cleanContent: content.replace(/<@\w+>\s*/g, ''),
    author: { id: authorId, bot, displayName: authorId, username: authorId },
    member,
    guildId: 'G',
    guild: { roles: { botRoleFor: () => null } },
    inGuild: () => true,
    channel,
    hasThread: false,
    replies: [],
    reply: async (payload) => { msg.replies.push(payload); },
    attachments: new Map(),
    reference: null,
  };
  return msg;
}

function harness(t, {
  maxHops = 12, maxSelfHops = 3, jobRuns = null, recovery = null, society = null,
  ownerTargets = [{ userId: 'SO', displayName: 'そう' }], withInbox = true,
  allowedRoleIds = null, // 書くと「このロールを持つ人」も通る (secrets の任意キー)
  maintenanceBotIds = null, // 書くと「作者がメンテ用に登録した bot」も通る (secrets の任意キー)
  board = null, // タスクのボード (findByThread だけ使う)。null = タスクを持たない配備
  channel = {}, // チャンネル kt の設定へ上書きする分 (autonomy・cwd の差し替え)
  intakeBot = false, // 受付 bot (manager / userId M) を足す
  intake = null, // 受付の配線 (handlePost を受けるだけの偽物)
} = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-messages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = canonicalCwd(dir);
  const config = {
    guildId: 'G',
    allowedUserIds: ['U1'],
    ...(allowedRoleIds ? { allowedRoleIds } : {}),
    ...(maintenanceBotIds ? { maintenanceBotIds } : {}),
    channels: { kt: { cwd: dir, verify: 'npm test', ...channel } },
    // 受付 bot の判定 (intakeBotKeyOf) は config.bots を、userId は registry を見る — 両方に置く
    bots: intakeBot ? { manager: { displayName: 'Manager', intake: true } } : {},
  };
  const bots = new Map([
    ['fable', { key: 'fable', userId: 'F', client: {}, cfg: { displayName: 'Fable' } }],
    ['opus', { key: 'opus', userId: 'O', client: {}, cfg: { displayName: 'Opus' } }],
    ...(intakeBot ? [['manager', { key: 'manager', userId: 'M', client: {}, cfg: { displayName: 'Manager', intake: true } }]] : []),
  ]);
  const discord = createDiscordWiring({ config, bots });
  const hops = new HopTracker(maxHops, maxSelfHops);
  const jobs = new JobQueue();
  const runs = jobRuns ?? new JobRunStore(join(dir, 'job-runs.json'));
  const contracts = new ContractStore(join(dir, 'contracts.json'));
  const contractWiring = createContractWiring({ contracts, botKeyOf: discord.botKeyOf });
  const lifecycle = createLifecycle();
  const enqueued = [];
  const jobCalls = [];
  const spent = [];
  const closed = [];
  const hopLimits = [];
  const messages = createMessageWiring({
    config,
    bots,
    hops,
    jobs,
    board,
    jobRuns: runs,
    recovery,
    society,
    lifecycle,
    limits: { maxHops, maxSelfHops },
    runRecorder: createRunRecorder({ jobRuns: runs }),
    enqueue: (item) => { enqueued.push(item); },
    runJob: async (...args) => { jobCalls.push(args); return 'ok'; },
    claimContract: contractWiring.claimContract,
    discardContractFor: contractWiring.discardContractFor,
    noteJobSpent: (threadId) => spent.push(threadId),
    closeInboxForThread: (threadId) => closed.push(threadId),
    channelConfigFor: discord.channelConfigFor,
    botKeyOf: discord.botKeyOf,
    botRoleFor: discord.botRoleFor,
    otherBotMentionIds: discord.otherBotMentionIds,
    ownerTargets,
    noteHopLimit: withInbox ? (p) => hopLimits.push(p) : null,
    intake,
  });
  const fable = bots.get('fable');
  return { ...io, dir, cwd, bots, fable, hops, jobs, jobRuns: runs, contracts, lifecycle, enqueued, jobCalls, spent, closed, hopLimits, ...messages };
}

test('人間のメンション: hop を戻し、受信箱を閉じ、⏳ を出して受付を記録し、job を積む', async (t) => {
  const h = harness(t);
  h.hops.take('T1');
  const thread = fakeThread('T1');
  const msg = fakeMessage({ channel: thread });
  await h.onMessage(h.fable, msg);

  assert.equal(h.hops.hops('T1'), 0, '人間の発言で hop を戻していない');
  assert.deepEqual(h.closed, ['T1']);
  assert.equal(thread.sent.length, 1);
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました');
  assert.equal(h.enqueued.length, 1);
  const item = h.enqueued[0];
  assert.equal(item.threadId, 'T1');
  assert.equal(item.botKey, 'fable');
  assert.equal(item.channelName, 'kt');
  assert.equal(item.initiativeJob, false);
  assert.equal(item.placeholder.id, 'T1-m1');
  assert.equal(item.handle.stopRequested, false);
  assert.equal(typeof item.onStop, 'function');

  const record = h.jobRuns.get(item.jobId);
  assert.equal(record.threadId, 'T1');
  assert.equal(record.botKey, 'fable');
  assert.equal(record.channelName, 'kt');
  assert.equal(record.cwd, h.cwd);
  assert.deepEqual(record.trigger, { messageId: 'M1', byBotKey: null, kind: 'human' });
  assert.equal(record.contractState, 'none');
  assert.equal(record.placeholderId, 'T1-m1');
  assert.equal(record.stage, 'queued');

  // item.run は runJob へ受付時の材料をそのまま渡す
  const outcome = {};
  assert.equal(await item.run({}, null, outcome), 'ok');
  assert.equal(h.jobCalls.length, 1);
  const [bot, triggerMsg, jobThread, cc, placeholder, handle, , claimed, recorder] = h.jobCalls[0];
  assert.equal(bot, h.fable);
  assert.equal(triggerMsg, msg);
  assert.equal(jobThread, thread);
  assert.deepEqual(cc, { cwd: h.cwd, verify: 'npm test', channelName: 'kt', repoRoot: h.cwd });
  assert.equal(placeholder.id, 'T1-m1');
  assert.equal(handle, item.handle);
  assert.deepEqual(claimed, { entry: null, error: null });
  assert.equal(recorder.id, item.jobId);
  assert.deepEqual(h.spent, [], '人間起点の job を予算に記帳している');
});

test('チャンネルでのメンションは起点メッセージからスレッドを生やす', async (t) => {
  const h = harness(t);
  const thread = fakeThread('T-new');
  const channel = { id: 'C1', name: 'kt', isThread: () => false };
  const msg = fakeMessage({ channel, content: '<@F> 新しい話題\n2 行目' });
  msg.startThread = async ({ name }) => { msg.threadName = name; return thread; };
  await h.onMessage(h.fable, msg);
  assert.equal(msg.threadName, '新しい話題 2 行目');
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました');
  assert.equal(h.enqueued[0].threadId, 'T-new');
});

test('チャンネルでのメンションでスレッドを立てられなければ、起点メッセージと同じ ID のスレッドを取って続ける', async (t) => {
  // 両 bot 同時メンションの race: 相手の client が先に立てていると startThread が落ちる (160004)。
  // メッセージ起点のスレッドの ID は元メッセージの ID と同じ
  const h = harness(t);
  const thread = fakeThread('M1');
  const fetched = [];
  const channel = { id: 'C1', name: 'kt', isThread: () => false, threads: { fetch: async (id) => { fetched.push(id); return thread; } } };
  const msg = fakeMessage({ channel });
  msg.startThread = async () => { throw new Error('A thread has already been created for this message'); };
  await h.onMessage(h.fable, msg);
  assert.deepEqual(fetched, ['M1']);
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました');
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0].threadId, 'M1');
  assert.deepEqual(h.errors, []);
});

test('スレッドを立てられず取りにも行けなければ、⏳ も job も出さずにログ 1 行で終える', async (t) => {
  const h = harness(t);
  const cases = [
    ['M1', async () => { throw new Error('Unknown Channel'); }], // 取得が reject
    ['M2', async () => null], // 取得は通ったがスレッドが無い
  ];
  for (const [id, fetch] of cases) {
    const sent = [];
    const channel = { id: 'C1', name: 'kt', isThread: () => false, send: async (p) => { sent.push(p); }, threads: { fetch } };
    const msg = fakeMessage({ channel, id });
    msg.startThread = async () => { throw new Error('Missing Permissions'); };
    await h.onMessage(h.fable, msg);
    assert.deepEqual(sent, [], `${id}: チャンネルへ何か出している`);
    assert.deepEqual(msg.replies, [], `${id}: 返信で何か出している`);
  }
  assert.equal(h.enqueued.length, 0);
  assert.deepEqual(h.jobRuns.list(), [], 'スレッドの無い受付を記録している');
  assert.deepEqual(h.errors, ['[fable] スレッド作成/取得に失敗 (msg M1)', '[fable] スレッド作成/取得に失敗 (msg M2)']);
});

test('スレッドが既に生えている起点メッセージでは新しく立てず、そのスレッドで受け付ける', async (t) => {
  const h = harness(t);
  const thread = fakeThread('T-existing');
  const calls = [];
  const channel = { id: 'C1', name: 'kt', isThread: () => false, threads: { fetch: async (id) => { calls.push(`fetch:${id}`); return null; } } };
  const msg = fakeMessage({ channel });
  msg.hasThread = true;
  msg.thread = thread;
  msg.startThread = async () => { calls.push('startThread'); return fakeThread('T-new'); };
  await h.onMessage(h.fable, msg);
  assert.deepEqual(calls, [], '既にあるスレッドを使わずに立て直している');
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました');
  assert.equal(h.enqueued[0].threadId, 'T-existing');
});

test('許可ロールを持つ人のメンションは通る (roleIds の配線)', async (t) => {
  // 純関数のテストだけでは呼び出し元での `roleIds:` 渡し忘れを検出できない。
  // メンション経路の member はキャッシュ済みの GuildMember 形 (roles.cache は Collection)
  const h = harness(t, { allowedRoleIds: ['R1'] });
  const withRole = { roles: { cache: new Map([['R1', {}]]) } };
  await h.onMessage(h.fable, fakeMessage({ authorId: 'U9', member: withRole }));
  assert.equal(h.enqueued.length, 1, 'ロールを持つ人が通っていない');

  // 別のロールしか持っていない / member が取れないなら今までどおり黙って落ちる
  await h.onMessage(h.fable, fakeMessage({
    authorId: 'U9', id: 'M2', channel: fakeThread('T2'), member: { roles: { cache: new Map([['R2', {}]]) } },
  }));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'U9', id: 'M3', channel: fakeThread('T3') }));
  assert.equal(h.enqueued.length, 1);
});

test('入口で捨てるもの: 自分の発言・DM・認可外・受付停止中・未登録チャンネル', async (t) => {
  const h = harness(t);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'F', bot: true, content: '<@F> 自分の多行\n発言' }));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'U9' }));
  const dm = fakeMessage();
  dm.inGuild = () => false;
  await h.onMessage(h.fable, dm);
  await h.onMessage(h.fable, fakeMessage({ content: '<@O> Opus 宛' }));
  assert.equal(h.enqueued.length, 0);

  const unregistered = fakeMessage({ channel: fakeThread('T2', { parentName: 'zzz' }) });
  await h.onMessage(h.fable, unregistered);
  // **何と食い違っているのかを出す。** 「未登録です」だけだと、綴り違いなのか場所違いなのかが
  // Discord 側から分からない (実地の導入で詰まった: 2026-09-12)。スレッドなら親の名前で判定
  assert.equal(
    unregistered.replies[0].content,
    '⚠️ このチャンネル (`zzz`) は config.policy.json の channels に未登録です'
    + ' — 登録されているのは `kt` (名前は完全一致・スレッドは親チャンネルの名前で判定)',
  );
  assert.equal(h.enqueued.length, 0);

  h.lifecycle.stopAccepting();
  const late = fakeMessage();
  await h.onMessage(h.fable, late);
  assert.equal(late.channel.sent.length, 0, '受付停止中に ⏳ を出している');
  assert.equal(h.enqueued.length, 0);
});

test('受付停止中の契約つき handoff は、捨てる前に対応する契約も捨てる', async (t) => {
  const h = harness(t);
  const entry = bindContract({
    id: 'c1', nonce: NONCE, kind: 'report',
    contract: { body: 'b', changed_files: [], did: ['x'], verification: 'v', remaining: [] },
    threadId: 'T1', fromBotKey: 'opus', toBotKey: 'fable', cwd: h.cwd, channelName: 'kt', at: new Date().toISOString(),
  });
  h.contracts.push('T1', 'fable', entry);
  h.lifecycle.stopAccepting();
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: `<@F>\n${formatContractTag(NONCE)}` }));
  assert.equal(h.contracts.list('T1', 'fable').length, 0, '受付停止中に捨てた handoff の契約が残っている');
  assert.ok(h.logs.some((l) => l.includes('起動しない handoff の契約を捨てました (受付停止中)')), h.logs.join('\n'));
});

test('bot 起点の handoff: 契約を受付時に取り出して job に束縛し、予算を記帳する', async (t) => {
  const h = harness(t);
  const entry = bindContract({
    id: 'c1', nonce: NONCE, kind: 'report',
    contract: { body: 'b', changed_files: [], did: ['x'], verification: 'v', remaining: [] },
    threadId: 'T1', fromBotKey: 'opus', toBotKey: 'fable', cwd: h.cwd, channelName: 'kt', at: new Date().toISOString(),
  });
  h.contracts.push('T1', 'fable', entry);
  const msg = fakeMessage({ authorId: 'O', bot: true, content: `<@F>\n${formatContractTag(NONCE)}` });
  await h.onMessage(h.fable, msg);

  assert.equal(h.enqueued.length, 1);
  assert.deepEqual(h.spent, ['T1'], 'bot 起点の job を記帳していない');
  assert.equal(h.hops.hops('T1'), 1);
  assert.equal(h.contracts.list('T1', 'fable').length, 0, '受付時に契約を取り出していない');
  const record = h.jobRuns.get(h.enqueued[0].jobId);
  assert.deepEqual(record.trigger, { messageId: 'M1', byBotKey: 'opus', kind: 'bot' });
  assert.equal(record.contractState, 'bound');
  assert.equal(record.contract.nonce, NONCE);
  assert.equal(record.intent.contractExpected, true);
  await h.enqueued[0].run({}, null, {});
  const claimed = h.jobCalls[0][7];
  assert.equal(claimed.entry.id, 'c1');
  assert.equal(claimed.expected, true);
});

test('bot 起点はスレッド内だけで、hop 上限に達したら見送るたびに知らせる', async (t) => {
  const h = harness(t, { maxHops: 1 });
  const channel = { id: 'C1', name: 'kt', isThread: () => false, sent: [], send: async () => {} };
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel }));
  assert.equal(h.enqueued.length, 0, 'チャンネル直の bot 投稿で job を立てている');

  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 1 回目', channel: thread }));
  assert.equal(h.enqueued.length, 1);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 2 回目', channel: thread, id: 'M2' }));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 3 回目', channel: thread, id: 'M3' }));
  assert.equal(h.enqueued.length, 1);
  const warnings = thread.sent.filter((p) => p.content.startsWith('⚠️ bot 間ホップが上限 (1) に達したため'));
  assert.equal(warnings.length, 2, '見送るたびに知らせていない (見送りは契約を捨てるので黙らない)');
  assert.match(warnings[0].content, /Fable の起動を見送りました/);
  assert.match(warnings[0].content, /続けるには人間が発言してください/);
});

// ---- メンテ用の bot (maintenanceBotIds) ----

test('メンテ bot: チャンネル直下のメンションで新しいスレッドを生やして job を積み、メンテ経由と記録する', async (t) => {
  const h = harness(t, { maintenanceBotIds: ['MB'] });
  const thread = fakeThread('T-maint');
  const channel = { id: 'C1', name: 'kt', isThread: () => false };
  const msg = fakeMessage({ authorId: 'MB', bot: true, channel, content: '<@F> 3 行を撮って' });
  msg.startThread = async () => thread;
  await h.onMessage(h.fable, msg);

  assert.equal(h.enqueued.length, 1, 'メンテ bot のチャンネル直下の依頼で job を立てていない');
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました — 🔧 メンテ bot 経由の依頼');
  const record = h.jobRuns.get(h.enqueued[0].jobId);
  assert.deepEqual(record.trigger, { messageId: 'M1', byBotKey: null, kind: 'maintenance' });
  assert.deepEqual(h.closed, [], 'メンテ bot の発言で作者の受信箱を閉じている');
  assert.deepEqual(h.spent, [], '新しい仕事の起点を予算に記帳している');
});

test('メンテ bot: スレッド内では bot と同じく hop を消費し、上限で見送る (人間のようにリセットしない)', async (t) => {
  const h = harness(t, { maintenanceBotIds: ['MB'], maxHops: 1 });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'MB', bot: true, channel: thread, content: '<@F> 1 回目' }));
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.hops.hops('T1'), 1, 'メンテ bot の発言が hop を消費していない');
  assert.deepEqual(h.spent, ['T1']);

  await h.onMessage(h.fable, fakeMessage({ authorId: 'MB', bot: true, channel: thread, content: '<@F> 2 回目', id: 'M2' }));
  assert.equal(h.enqueued.length, 1, 'hop 上限を超えてメンテ bot の依頼で job を立てている');
  assert.ok(thread.sent.some((p) => p.content.startsWith('⚠️ bot 間ホップが上限 (1) に達したため')));
  assert.equal(h.hops.hops('T1'), 1, 'メンテ bot の発言で hop をリセットしている');
});

test('メンテ bot: 登録していない bot はチャンネル直下でもスレッド内でも無視する', async (t) => {
  const h = harness(t, { maintenanceBotIds: ['MB'] });
  const channel = { id: 'C1', name: 'kt', isThread: () => false };
  const top = fakeMessage({ authorId: 'XB', bot: true, channel, content: '<@F> よその bot' });
  top.startThread = async () => fakeThread('T-x');
  await h.onMessage(h.fable, top);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'XB', bot: true, content: '<@F> よその bot', id: 'M2' }));
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.hops.hops('T1'), 0);
});

test('メンテ bot: 自前の bot の ID を書いても権限は広がらない (チャンネル直下は通らない)', async (t) => {
  const h = harness(t, { maintenanceBotIds: ['O'] });
  const channel = { id: 'C1', name: 'kt', isThread: () => false, sent: [], send: async () => {} };
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, channel, content: '<@F> 自前の bot' }));
  assert.equal(h.enqueued.length, 0, '自前の bot がメンテ扱いでチャンネル直下から job を立てている');
});

test('hop 上限の見送りは毎回 owner を呼び、/inbox に残す', async (t) => {
  const h = harness(t, { maxHops: 1 });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 1 本目', channel: thread }));
  assert.equal(h.enqueued.length, 1);
  for (const id of ['M2', 'M3']) {
    await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 続き', channel: thread, id }));
  }
  const notices = thread.sent.filter((p) => p.content.startsWith('⚠️ bot 間ホップが上限 (1)'));
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(
      notice.content,
      '⚠️ bot 間ホップが上限 (1) に達したため Fable の起動を見送りました。<@SO> 続けるには人間が発言してください。',
    );
    assert.deepEqual(notice.allowedMentions.users, ['SO'], 'owner を実際にメンションしていない');
  }
  // 見送りのたびに受信箱へ (閉じるのは人間の発言 = closeInboxForThread)
  assert.deepEqual(
    h.hopLimits.map((p) => [p.threadId, p.botKey, p.reason, p.channelName]),
    [['T1', 'fable', 'bot 間ホップが上限 (1)', 'kt'], ['T1', 'fable', 'bot 間ホップが上限 (1)', 'kt']],
  );
  assert.equal(h.hopLimits[0].messageId, notices[0].message.id, '送れた投稿の ID を記録していない');
});

test('見送りの本文は、実際に捨てた契約があるときだけ「捨てました」と書く', async (t) => {
  const h = harness(t, { maxHops: 0 });
  const thread = fakeThread('T1');
  // 印なし
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> ふつうの handoff', channel: thread }));
  assert.equal(thread.sent.length, 1);
  assert.equal(/委譲契約は捨てました/.test(thread.sent[0].content), false, '契約が無いのに捨てたと言っている');
  // 印はあるがストアに無い (失効した後・既に取り出された後) — 捨てていないので言わない
  await h.onMessage(h.fable, fakeMessage({
    authorId: 'O', bot: true, content: '<@F> 頼みます\n`契約:deadbeefcafe`', channel: thread, id: 'M2',
  }));
  assert.equal(
    /委譲契約は捨てました/.test(thread.sent[1].content),
    false,
    '印があるだけで「捨てました」と言っている (実際には落ちていない)',
  );
  // ストアに居る契約を捨てたときだけ書く
  h.contracts.push('T1', 'fable', { fromBotKey: 'opus', nonce: 'deadbeefcafe', at: new Date().toISOString() });
  await h.onMessage(h.fable, fakeMessage({
    authorId: 'O', bot: true, content: '<@F> 頼みます\n`契約:deadbeefcafe`', channel: thread, id: 'M3',
  }));
  assert.equal(
    thread.sent[2].content,
    '⚠️ bot 間ホップが上限 (0) に達したため Fable の起動を見送りました。<@SO> 続けるには人間が発言してください。\n'
    + 'この起動に付いていた委譲契約は捨てました — 続ける場合は委譲元に出し直させてください',
  );
});

test('予算切れでも、契約を捨てたときは黙らない (捨てていなければ従来どおり 1 回)', async (t) => {
  const h = harness(t);
  const thread = fakeThread('T1');
  h.hops.grantTaskBudget('T1', 0);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel: thread }));
  assert.match(thread.sent[0].content, /^⚠️ このタスクの job 予算を使い切ったため停止/);
  assert.deepEqual(thread.sent[0].allowedMentions.users, [], '契約を捨てていないのに owner を呼んでいる');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel: thread, id: 'M2' }));
  assert.equal(thread.sent.length, 1, '契約の無い予算切れを繰り返し出している');
  // 契約付きの handoff が来たら、捨てたことを必ず伝える (黙って消すと委譲元が待ち続ける)
  h.contracts.push('T1', 'fable', { fromBotKey: 'opus', nonce: 'cafebabe1234', at: new Date().toISOString() });
  await h.onMessage(h.fable, fakeMessage({
    authorId: 'O', bot: true, content: '<@F> 頼みます\n`契約:cafebabe1234`', channel: thread, id: 'M3',
  }));
  assert.equal(thread.sent.length, 2);
  assert.match(thread.sent[1].content, /^⚠️ このタスクの job 予算を使い切ったため停止/);
  assert.match(thread.sent[1].content, /この起動に付いていた委譲契約は捨てました/);
  // 委譲元 bot はこの通知でメンションされない — 気づけるのは人間だけなので owner を呼ぶ
  assert.deepEqual(thread.sent[1].allowedMentions.users, ['SO'], '捨てたのに owner を呼んでいない');
  assert.deepEqual(h.hopLimits, [], '予算切れを見送りとして /inbox へ入れている');
});

test('owner が未設定の配備ではメンションなしで同じ本文を出す', async (t) => {
  const h = harness(t, { maxHops: 0, ownerTargets: [] });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel: thread }));
  assert.equal(
    thread.sent[0].content,
    '⚠️ bot 間ホップが上限 (0) に達したため Fable の起動を見送りました。続けるには人間が発言してください。',
  );
  assert.deepEqual(thread.sent[0].allowedMentions.users, []);
});

test('/inbox を持たない配備でも見送りの通知は出る', async (t) => {
  const h = harness(t, { maxHops: 0, withInbox: false });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel: thread }));
  assert.equal(thread.sent.length, 1);
  assert.deepEqual(h.hopLimits, []);
});

test('人間が発言してホップが戻った後の見送りでも、また知らせる', async (t) => {
  const h = harness(t, { maxHops: 1 });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 1 本目', channel: thread }));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 見送り', channel: thread, id: 'M2' }));
  assert.equal(h.hopLimits.length, 1);
  // 人間の発言でリセット (受信箱もここで閉じる)
  await h.onMessage(h.fable, fakeMessage({ authorId: 'U1', content: 'つづけて', channel: thread, id: 'M3' }));
  assert.deepEqual(h.closed, ['T1']);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 2 本目', channel: thread, id: 'M4' }));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> また見送り', channel: thread, id: 'M5' }));
  assert.equal(h.hopLimits.length, 2, 'リセット後の見送りを知らせていない');
  assert.equal(thread.sent.filter((p) => p.content.startsWith('⚠️ bot 間ホップが上限 (1)')).length, 2);
});

test('連続自己呼び出しの上限でも、見送るたびに知らせて /inbox に残す', async (t) => {
  const h = harness(t, { maxSelfHops: 1 });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'F', bot: true, content: '<@F>', channel: thread }));
  assert.equal(h.enqueued.length, 1);
  for (const id of ['M2', 'M3']) {
    await h.onMessage(h.fable, fakeMessage({ authorId: 'F', bot: true, content: '<@F>', channel: thread, id }));
  }
  const notices = thread.sent.filter((p) => p.content.startsWith('⚠️ 連続自己呼び出しが上限 (1)'));
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /Fable の起動を見送りました。<@SO> 続けるには人間が発言してください。/);
  assert.deepEqual(
    h.hopLimits.map((p) => [p.threadId, p.reason]),
    [['T1', '連続自己呼び出しが上限 (1)'], ['T1', '連続自己呼び出しが上限 (1)']],
  );
});

test('タスクの job 予算が尽きたら「発言しても再開しない」と伝える (hop 上限と混ぜない)', async (t) => {
  const h = harness(t);
  const thread = fakeThread('T1');
  h.hops.grantTaskBudget('T1', 0);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> hi', channel: thread }));
  assert.equal(h.enqueued.length, 0);
  assert.match(thread.sent[0].content, /^⚠️ このタスクの job 予算を使い切ったため停止。\*\*発言しても再開しません\*\*/);
  assert.match(thread.sent[0].content, /追い予算を出す/);
});

test('自己呼び出しは制御メッセージの形だけ通し、連続上限で別枠に止める', async (t) => {
  const h = harness(t, { maxSelfHops: 1 });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'F', bot: true, content: '<@F>', channel: thread }));
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.hops.selfHops('T1', 'fable'), 1);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'F', bot: true, content: '<@F>', channel: thread, id: 'M2' }));
  assert.equal(h.enqueued.length, 1);
  assert.match(thread.sent.at(-1).content, /^⚠️ 連続自己呼び出しが上限 \(1\) に達したため Fable の起動を見送りました/);
  assert.equal(h.hops.hops('T1'), 1, '止めるターンに bot 間ホップを消費している');
  // 別の担当が動けば自己の連鎖は切れる
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 別の担当から', channel: thread, id: 'M3' }));
  assert.equal(h.enqueued.length, 2);
  assert.equal(h.hops.selfHops('T1', 'fable'), 0);
});

test('失効した再開要求 (§11.3) は hop と予算を消費する前に断る', async (t) => {
  const screened = [];
  const recovery = {
    screenTrigger: (p) => { screened.push(p); return { ok: false, reason: '再開要求 7-2 は期限切れです' }; },
    noteAccepted: () => null,
  };
  const h = harness(t, { recovery });
  const thread = fakeThread('T1');
  h.hops.grantTaskBudget('T1', 3);
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 再開要求 7-2', channel: thread }));
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.hops.taskBudget('T1'), 3, '断った投稿で予算を減らしている');
  assert.equal(h.hops.hops('T1'), 0, '断った投稿で hop を消費している');
  assert.deepEqual(screened, [{ threadId: 'T1', content: '<@F> 再開要求 7-2', botKey: 'fable', messageId: 'M1' }]);
  assert.equal(thread.sent[0].content, '⏹ 再開要求 7-2 は期限切れです');
  assert.ok(h.logs.some((l) => l === '[recovery] 再開要求 7-2 は期限切れです (thread:T1 msg:M1)'), h.logs.join('\n'));
  // 人間の投稿は照合しない
  await h.onMessage(h.fable, fakeMessage({ channel: thread, id: 'M2' }));
  assert.equal(screened.length, 1);
  assert.equal(h.enqueued.length, 1);
});

test('受付の記録に失敗した job は起動せず、⏳ を ❌ に直して理由を出す', async (t) => {
  const h = harness(t, { jobRuns: { open: () => { throw new Error('EACCES: data/job-runs.json'); } } });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ channel: thread }));
  assert.equal(h.enqueued.length, 0);
  const placeholder = thread.sent[0].message;
  assert.equal(placeholder.edits.length, 1);
  assert.match(placeholder.edits[0].content, /^❌ Fable を起動しませんでした — 受付を保存できません\nEACCES: data\/job-runs\.json\n→ data\/ の書き込み権限と空き容量を確認してから再メンションしてください$/);
  assert.ok(h.errors.some((e) => e.includes('受付を記録できないため起動しません')), h.errors.join('\n'));
});

test('契約を取り出した後で束縛を記録できない job は起動せず ❌ に直し、取り出した契約があるときだけ委譲し直しを頼む', async (t) => {
  const h = harness(t);
  // 受付の記録 (open) は通り、その後の契約の束縛だけが書けない
  h.jobRuns.bindContract = () => { throw new Error('EACCES: data/job-runs.json'); };
  const entry = bindContract({
    id: 'c1', nonce: NONCE, kind: 'report',
    contract: { body: 'b', changed_files: [], did: ['x'], verification: 'v', remaining: [] },
    threadId: 'T1', fromBotKey: 'opus', toBotKey: 'fable', cwd: h.cwd, channelName: 'kt', at: new Date().toISOString(),
  });
  h.contracts.push('T1', 'fable', entry);
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: `<@F>\n${formatContractTag(NONCE)}`, channel: thread }));
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.contracts.list('T1', 'fable').length, 0, '契約を取り出していない (消費済みと書く前提が崩れている)');
  const placeholder = thread.sent[0].message;
  assert.equal(placeholder.edits.length, 1);
  assert.equal(
    placeholder.edits[0].content,
    '❌ Fable を起動しませんでした — 受付を保存できません\n'
    + 'EACCES: data/job-runs.json (取り出した契約は消費済みなので委譲し直してください)\n'
    + '→ data/ の書き込み権限と空き容量を確認してから再メンションしてください',
  );
  assert.ok(h.errors.some((e) => e.includes('契約の束縛を記録できないため起動しません: EACCES')), h.errors.join('\n'));

  // 契約の無い起動: 同じく起動しないが、消費した契約が無いので委譲し直しは頼まない
  const plain = fakeThread('T2');
  await h.onMessage(h.fable, fakeMessage({ channel: plain, id: 'M2' }));
  assert.equal(h.enqueued.length, 0);
  assert.equal(
    plain.sent[0].message.edits[0].content,
    '❌ Fable を起動しませんでした — 受付を保存できません\n'
    + 'EACCES: data/job-runs.json\n'
    + '→ data/ の書き込み権限と空き容量を確認してから再メンションしてください',
  );
});

test('待機中の取り消し (onStop) は実行記録を cancelled で閉じ、実行中なら停止の指示だけ残す', async (t) => {
  const h = harness(t);
  await h.onMessage(h.fable, fakeMessage({ channel: fakeThread('T1') }));
  await h.onMessage(h.fable, fakeMessage({ channel: fakeThread('T2'), id: 'M2' }));
  const [waiting, running] = h.enqueued;
  waiting.onStop({ kind: 'shutdown', waiting: true });
  assert.equal(h.jobRuns.get(waiting.jobId).outcome, 'cancelled');
  assert.equal(h.jobRuns.get(waiting.jobId).stopKind, 'shutdown');
  running.onStop({ kind: 'human', waiting: false });
  assert.equal(h.jobRuns.get(running.jobId).stage, 'queued', '実行中の停止指示で終端にしている');
  assert.equal(h.jobRuns.get(running.jobId).stopKind, 'human');
});

test('stopNoticeFor は予算切れと hop 上限を混ぜない', (t) => {
  const h = harness(t);
  const fallback = { reason: 'hop', text: 'hop 上限' };
  assert.equal(h.stopNoticeFor('T-none', fallback), fallback, '予算を配っていないスレッドで予算切れの文面を出している');
  h.hops.grantTaskBudget('T1', 2);
  assert.equal(h.stopNoticeFor('T1', fallback), fallback);
  h.hops.grantTaskBudget('T0', 0);
  assert.equal(h.stopNoticeFor('T0', fallback).reason, 'タスクの job 予算切れ');
});

// ---- 社会の印が付いた起動 (docs/society-ledger.md §5・S2-2) ----

/** screenAction / noteAccepted の呼ばれ方を記録する偽の society 配線 */
function fakeSociety({ screen = null, accept = { ok: true } } = {}) {
  const calls = { screen: [], accept: [], settled: [] };
  return {
    calls,
    noteSettled: (actionId, fields) => {
      calls.settled.push({ actionId, ...fields });
      return { ok: true };
    },
    screenAction: (args) => {
      calls.screen.push(args);
      return screen ?? { ok: true, action: { actionId: 'A-1', caseId: 'C-1', claimGeneration: 1 } };
    },
    noteAccepted: (actionId, opts) => {
      calls.accept.push({ actionId, ...opts });
      return accept;
    },
  };
}

const ACTION_TRIGGER = '<@F> 案件 C-1 / investigate\n`案件:A-1`';

test('社会の起動: hop を消費せず、日次枠は消費し、記録に案件が残る', async (t) => {
  const society = fakeSociety();
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  const msg = fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread });
  await h.onMessage(h.fable, msg);

  // **hop より前に照合している** (見送る job で hop を減らさない)
  assert.equal(h.hops.hops('T1'), 0, 'bot 間ホップを消費している');
  assert.equal(society.calls.screen.length, 1);
  assert.deepEqual(society.calls.screen[0], {
    content: ACTION_TRIGGER, messageId: 'M1', botKey: 'fable', threadId: 'T1',
  });
  // チャンネルの日次枠は従来どおり消費する (予算の統合は S3)
  assert.deepEqual(h.spent, ['T1']);

  assert.equal(h.enqueued.length, 1);
  const record = h.jobRuns.get(h.enqueued[0].jobId);
  assert.deepEqual(record.society, { caseId: 'C-1', actionId: 'A-1', claimGeneration: 1 });
  // 受付は enqueue より前に、その job の ID で保存されている
  assert.deepEqual(society.calls.accept, [{ actionId: 'A-1', runId: h.enqueued[0].jobId, messageId: 'M1' }]);
  // 実行記録から操作 ID で引ける
  assert.deepEqual(h.jobRuns.forAction('A-1').map((r) => r.id), [h.enqueued[0].jobId]);
  // runJob へも素通しする (S2-3 が実行文脈に使う)
  assert.deepEqual(h.enqueued[0].run({}, undefined, {}) instanceof Promise, true);
});

test('社会の起動: 照合に落ちたら ⏹ を出して起動せず、hop も予算も触らない', async (t) => {
  const society = fakeSociety({ screen: { ok: false, reason: '案件 A-1 は起動しません — 既に受け付け済みです' } });
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));

  assert.equal(h.enqueued.length, 0);
  assert.equal(h.hops.hops('T1'), 0);
  assert.deepEqual(h.spent, []);
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].content, /^⏹ 案件 A-1 は起動しません/);
});

test('社会の起動: 停止中の案件は ⏹ で断り、再開の口をそのまま伝える', async (t) => {
  // 印を見た時点で案件が止まっている形 (送った後に人が /stop した) — 起動せず、
  // screenAction が返した理由をそのままスレッドへ出す (再開の打ち方が人に残る)
  const society = fakeSociety({
    screen: { ok: false, reason: '案件 C-1 は停止中なので起動しません (再開は `/case resume:C-1`)' },
  });
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));

  assert.equal(h.enqueued.length, 0, '止めた案件の起動を受け付けている');
  assert.deepEqual(h.spent, [], '起こさない job で日次枠を消費している');
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].content, /^⏹ 案件 C-1 は停止中なので起動しません/);
  assert.match(thread.sent[0].content, /\/case resume:C-1/);
});

test('社会の起動: 受付を台帳へ保存できなければ enqueue せず ❌ を出す', async (t) => {
  const society = fakeSociety({ accept: { ok: false, code: 'already-accepted', reason: '既に job-9 で受け付けている' } });
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));

  assert.equal(h.enqueued.length, 0, '受付を保存できないまま実行キューへ渡さない');
  const placeholder = thread.sent[0].message;
  assert.equal(placeholder.edits.length, 1);
  const edited = placeholder.edits[0]?.content ?? String(placeholder.edits[0]);
  assert.match(edited, /^❌/);
  assert.match(edited, /案件 A-1 の受付を社会台帳へ保存できません/);
});

test('社会の起動: 印の無い bot 発言は従来どおり hop を消費する (回帰)', async (t) => {
  const society = fakeSociety({ screen: { ok: true, action: null } });
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> ふつうの handoff', channel: thread }));

  assert.equal(h.hops.hops('T1'), 1, '印の無い起動でホップが減っていない');
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.jobRuns.get(h.enqueued[0].jobId).society, null);
  assert.deepEqual(society.calls.accept, []);
});

test('社会の起動: 受付を保存できなければ実行記録も終端まで書く (幻の受付を残さない)', async (t) => {
  const society = fakeSociety({ accept: { ok: false, code: 'write-error', reason: 'EACCES: data/society.json' } });
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));

  assert.equal(h.enqueued.length, 0);
  // **queued のまま残さない** — 残すと照合が「外で job が立った」と読んで予算を焼く
  const records = h.jobRuns.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].stage, 'ended');
  assert.equal(records[0].outcome, 'cancelled');
  assert.equal(records[0].startedAt, null, '走っていないので startedAt は無い');
  assert.match(records[0].stageDetail, /社会台帳へ受付を保存できず/);
  // ❌ の文言は社会台帳の理由を書く (data/ の権限の話にしない)
  const edited = thread.sent[0].message.edits[0]?.content ?? String(thread.sent[0].message.edits[0]);
  assert.match(edited, /案件 A-1 の受付を社会台帳へ保存できません/);
  assert.match(edited, /社会台帳 \(data\/society\.json\) を直すか/);
  assert.equal(/書き込み権限と空き容量/.test(edited), false);
});

test('社会の起動: 待機中に取り消された job は Action も終端まで書く', async (t) => {
  const society = fakeSociety();
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));
  assert.equal(h.enqueued.length, 1);

  // /stop・/restart で待機中の item が dequeue された形 (runItem は走らない)
  h.enqueued[0].onStop({ kind: 'human', waiting: true });

  const record = h.jobRuns.get(h.enqueued[0].jobId);
  assert.equal(record.outcome, 'cancelled');
  assert.deepEqual(society.calls.settled, [{
    actionId: 'A-1', runId: h.enqueued[0].jobId, outcome: 'cancelled', reason: '待機中に取り消し',
  }]);
});

test('社会の起動: 自己呼び出しの連鎖は bridge 起点で切れる', async (t) => {
  const society = fakeSociety();
  const h = harness(t, { society, maxSelfHops: 2 });
  const thread = fakeThread('T1');
  // Fable が自分で 2 連続 → 次の自己呼び出しは上限
  h.hops.takeSelf('T1', 'fable');
  h.hops.takeSelf('T1', 'fable');
  // 社会の起動 (bridge が投げた 1 本) が入る
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));
  assert.equal(h.enqueued.length, 1);
  // 連鎖が切れているので、この後の自己呼び出しはまた最初から数える
  assert.equal(h.hops.takeSelf('T1', 'fable').allowed, true);
});

test('社会の起動: off の配備では印付きの発言も従来どおり通る (C15)', async (t) => {
  // off の society 配線は印を見ずに素通しする (印の書き方を説明した文で起動が止まらない)
  const society = { screenAction: () => ({ ok: true, action: null }), noteAccepted: () => ({ ok: true }) };
  const h = harness(t, { society });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({
    authorId: 'O', bot: true, content: '<@F> S2-2 では `案件:A-12` の印で送ります', channel: thread,
  }));
  assert.equal(h.enqueued.length, 1, '印の付いた文字列が本文にあるだけで止めない');
  assert.equal(h.hops.hops('T1'), 1, '印なし扱いなので従来どおり hop を消費する');
  assert.equal(h.jobRuns.get(h.enqueued[0].jobId).society, null);
  assert.equal(thread.sent.filter((s) => String(s.content ?? '').startsWith('⏹')).length, 0);
});

test('社会の起動: society を持たない配備では何も変わらない (回帰)', async (t) => {
  const h = harness(t);
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: ACTION_TRIGGER, channel: thread }));
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.hops.hops('T1'), 1);
  assert.equal(h.jobRuns.get(h.enqueued[0].jobId).society, null);
});

// --- タスクのスレッドの作業ディレクトリ (taskWorktreeFor — docs/social-engineering.md §8-2) ---
// タスクのスレッドの job は、そのタスクの作業ツリー (.worktrees/task-N) で走る。ここが壊れると
// job が本体のチェックアウトで走り、ベースブランチを直接書き換える。
// git は本物 (一時ディレクトリの中だけ)、ボードは findByThread だけの偽物。

const TASK = { id: 99 };
// 初期ブランチと baseBranch を揃える (既定の main は fixture に無い)。opus はレビュー担当
const AUTONOMY = { enabled: true, reviewer: 'opus', baseBranch: 'master' };

/** スレッド ID → タスク。既定はスレッド T1 = タスク 99 */
function fakeBoard(tasks = { T1: TASK }) {
  return { findByThread: (threadId) => tasks[threadId] ?? null };
}

/**
 * git が dir をリポジトリの中と見ていないこと。`git -C` は祖先を遡って .git を探すので、
 * 一時ディレクトリの祖先にリポジトリがある (か GIT_DIR が効いている) 環境で進めると、
 * 作業ツリーの用意が**本物のリポジトリ**に向く。そういう環境ではテストを飛ばす
 */
function outsideAnyRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore', windowsHide: true });
    return false;
  } catch {
    return true;
  }
}

/** master に 1 コミットと `.worktrees/` の無視設定を持つ一時リポジトリ。用意できない環境では null */
function tempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-messages-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  if (!outsideAnyRepo(dir)) return null;
  const path = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--initial-branch=master', path], { windowsHide: true });
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  // prepareWorktree は `.worktrees/` が無視されていないと作らない (verify を汚さないための門)
  writeFileSync(join(path, '.gitignore'), '.worktrees/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  const worktreeCount = () => git('worktree', 'list', '--porcelain')
    .split('\n').filter((line) => line.startsWith('worktree ')).length;
  return { repo: canonicalCwd(path), git, worktreeCount };
}

const worktreeLogs = (h) => h.logs.filter((line) => line.startsWith('[worktree]'));

test('taskWorktreeFor: ボードを持たない配備では {} (チャンネル本体のまま走る)', async (t) => {
  const h = harness(t);
  // 実在しないパス — git を 1 回でも叩けば {error} になるので、{} が「叩いていない」の証拠になる
  const canonical = join(h.dir, 'no-such-repo');
  const configured = { channelName: 'kt', autonomy: AUTONOMY };
  assert.deepEqual(await h.taskWorktreeFor({ configured, canonical, bot: h.fable, channel: fakeThread('T1') }), {});
  assert.equal(existsSync(canonical), false);
});

test('taskWorktreeFor: スレッドでない・タスクが無い・planTaskCwd が不要と言うときは {} を返し、git を叩かない', async (t) => {
  const h = harness(t, { board: fakeBoard() });
  const canonical = join(h.dir, 'no-such-repo');
  const configured = { channelName: 'kt', autonomy: AUTONOMY };
  const cases = [
    ['スレッドでない', { channel: { id: 'T1', isThread: () => false } }],
    ['タスクのスレッドではない', { channel: fakeThread('T2') }],
    ['自律運転が無効', { configured: { channelName: 'kt', autonomy: { ...AUTONOMY, enabled: false } } }],
    ['自律運転の設定が無い', { configured: { channelName: 'kt' } }],
    ['レビュー担当は本体で走る', { bot: h.bots.get('opus') }],
  ];
  for (const [label, override] of cases) {
    const result = await h.taskWorktreeFor({ configured, canonical, bot: h.fable, channel: fakeThread('T1'), ...override });
    assert.deepEqual(result, {}, label);
  }
  assert.equal(existsSync(canonical), false);
  assert.deepEqual(worktreeLogs(h), []);
});

test('taskWorktreeFor: タスクのスレッドでは .worktrees/task-N を用意して返し、2 回目は作り直さず再利用する', async (t) => {
  const fixture = tempRepo(t);
  if (!fixture) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const { repo, git, worktreeCount } = fixture;
  const h = harness(t, { board: fakeBoard() });
  const args = { configured: { channelName: 'kt', autonomy: AUTONOMY }, canonical: repo, bot: h.fable, channel: fakeThread('T1') };

  const first = await h.taskWorktreeFor(args);
  // 期待値は作った後に実パスから作る (8.3 形式・junction で文字列の形が変わる)
  const worktree = canonicalCwd(join(repo, '.worktrees', 'task-99'));
  assert.ok(worktree, '作業ツリーが作られていない');
  assert.deepEqual(first, { cwd: worktree });
  assert.notEqual(first.cwd, repo, '本体のチェックアウトを返している');
  assert.equal(
    execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true }).trim(),
    'task/99',
  );
  assert.equal(git('branch', '--show-current'), 'master', '本体のブランチが動いた');
  assert.equal(worktreeCount(), 2, '本体 + task-99 の 2 つになっていない');
  assert.equal(worktreeLogs(h).length, 1);
  assert.match(worktreeLogs(h)[0], /^\[worktree\] kt: タスク 99 の作業ツリーを用意 \(task\/99 ← master \//);

  const second = await h.taskWorktreeFor(args);
  assert.deepEqual(second, first);
  assert.equal(worktreeCount(), 2, '2 回目で作業ツリーを二重に作っている');
  assert.equal(worktreeLogs(h).length, 1, '再利用なのに「用意」と出している');
});

test('taskWorktreeFor: 同じタスクへ重なった 2 本は 1 本の用意を待ち合わせる (片方が git のエラーで落ちない)', async (t) => {
  const fixture = tempRepo(t);
  if (!fixture) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const { repo, worktreeCount } = fixture;
  const h = harness(t, { board: fakeBoard() });
  const args = { configured: { channelName: 'kt', autonomy: AUTONOMY }, canonical: repo, bot: h.fable, channel: fakeThread('T1') };
  const [a, b] = await Promise.all([h.taskWorktreeFor(args), h.taskWorktreeFor(args)]);
  assert.deepEqual(a, { cwd: canonicalCwd(join(repo, '.worktrees', 'task-99')) });
  assert.deepEqual(b, a);
  assert.equal(worktreeCount(), 2);
});

test('タスクのスレッドの job は作業ツリーで走る (cc.cwd・レーン・実行記録)。repoRoot は本体のまま', async (t) => {
  const fixture = tempRepo(t);
  if (!fixture) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const { repo, git } = fixture;
  const h = harness(t, { board: fakeBoard(), channel: { cwd: repo, autonomy: AUTONOMY } });
  const thread = fakeThread('T1');
  await h.onMessage(h.fable, fakeMessage({ channel: thread }));

  const worktree = canonicalCwd(join(repo, '.worktrees', 'task-99'));
  assert.ok(worktree, '作業ツリーが作られていない');
  assert.equal(thread.sent[0].content, '⏳ Fable が受け付けました');
  assert.equal(h.enqueued.length, 1);
  const item = h.enqueued[0];
  assert.equal(item.laneKey, laneKeyFor(worktree), 'レーンが本体の鍵になっている');
  const record = h.jobRuns.get(item.jobId);
  assert.equal(record.cwd, worktree);
  assert.equal(record.taskId, '99'); // 実行記録は文字列で持つ
  await item.run({}, null, {});
  const cc = h.jobCalls[0][3];
  assert.equal(cc.cwd, worktree, 'job が本体のチェックアウトで走る');
  assert.equal(cc.repoRoot, repo);
  assert.equal(git('branch', '--show-current'), 'master');
});

test('作業ツリーを用意できないタスクのスレッドでは、本体で走らせずに断る (job を立てない・契約も捨てる)', async (t) => {
  const h = harness(t, { board: fakeBoard(), channel: { autonomy: AUTONOMY } });
  // h.dir は git でない一時ディレクトリ。祖先にリポジトリがあると本物に作業ツリーを生やしうる
  if (!outsideAnyRepo(h.dir)) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const direct = await h.taskWorktreeFor({
    configured: { channelName: 'kt', autonomy: AUTONOMY }, canonical: h.cwd, bot: h.fable, channel: fakeThread('T1'),
  });
  assert.deepEqual(Object.keys(direct), ['error']);
  // 後ろは git のメッセージ (ロケール依存) なので前方だけ見る
  assert.match(direct.error, /^タスク 99 の作業ツリーを用意できません: /);

  // 人間のメンション: ⏳ を出さず、⚠️ で理由を返す。記録は not-started の終端 1 件だけ
  const thread = fakeThread('T1');
  const msg = fakeMessage({ channel: thread });
  await h.onMessage(h.fable, msg);
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0].content, /^⚠️ タスク 99 の作業ツリーを用意できません: /);
  assert.equal(thread.sent.length, 0, '⏳ を出している');
  assert.equal(h.enqueued.length, 0, '本体で job を積んでいる');
  const [refused, ...rest] = h.jobRuns.list();
  assert.deepEqual(rest, []);
  assert.equal(refused.stage, 'ended');
  assert.equal(refused.outcome, 'not-started');
  assert.equal(refused.next, 'recovery');
  assert.equal(refused.reason, 'worktree-unavailable');
  assert.equal(refused.stageDetail, msg.replies[0].content.replace(/^⚠️ /, '').slice(0, 200));
  assert.equal(refused.taskId, '99');
  assert.equal(refused.threadId, 'T1');
  assert.equal(refused.botKey, 'fable');
  assert.equal(refused.channelName, 'kt');
  assert.equal(refused.cwd, h.cwd, '作業ツリーは無いので本体のパスを残す');
  assert.deepEqual(refused.trigger, { messageId: 'M1', byBotKey: null, kind: 'human' });
  assert.equal(refused.placeholderId, null);
  assert.equal(refused.spawn, null);
  assert.equal(refused.contractState, 'none');

  // bot 起点の契約つき handoff: 契約を捨て、hop も予算も消費しない
  const entry = bindContract({
    id: 'c1', nonce: NONCE, kind: 'report',
    contract: { body: 'b', changed_files: [], did: ['x'], verification: 'v', remaining: [] },
    threadId: 'T1', fromBotKey: 'opus', toBotKey: 'fable', cwd: h.cwd, channelName: 'kt', at: new Date().toISOString(),
  });
  h.contracts.push('T1', 'fable', entry);
  const handoff = fakeMessage({ authorId: 'O', bot: true, content: `<@F>\n${formatContractTag(NONCE)}`, channel: thread, id: 'M2' });
  await h.onMessage(h.fable, handoff);
  assert.match(handoff.replies[0].content, /^⚠️ タスク 99 の作業ツリーを用意できません: /);
  assert.equal(h.contracts.list('T1', 'fable').length, 0, '起動しない handoff の契約が残っている');
  assert.ok(h.logs.some((l) => l.includes('起動しない handoff の契約を捨てました (作業ツリーを用意できない)')), h.logs.join('\n'));
  assert.equal(h.hops.hops('T1'), 0);
  assert.deepEqual(h.spent, []);
  assert.equal(h.enqueued.length, 0);
  assert.equal(existsSync(join(h.dir, '.worktrees')), false);
  // 断った handoff も 1 件。契約は捨てたので束縛しない (pending を残すと「消費したのに束縛が無い」に見える)
  const handoffRecord = h.jobRuns.list().find((r) => r.trigger.messageId === 'M2');
  assert.equal(h.jobRuns.list().length, 2);
  assert.equal(handoffRecord.outcome, 'not-started');
  assert.deepEqual(handoffRecord.trigger, { messageId: 'M2', byBotKey: 'opus', kind: 'bot' });
  assert.equal(handoffRecord.contractState, 'none');
  assert.equal(handoffRecord.contract, null);
});

test('作業ツリーで断った記録は、前の job の「返信待ち」を上書きして「起動できなかった」の復旧待ちに出す (自動復旧は拾わない)', async (t) => {
  const h = harness(t, { board: fakeBoard(), channel: { autonomy: AUTONOMY } });
  if (!outsideAnyRepo(h.dir)) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  // 前の job: 報告して人間の返信待ちで終わった
  const T0 = Date.now() - 60 * 60000;
  h.jobRuns.open({ id: 'prev', taskId: '99', threadId: 'T1', botKey: 'fable' }, { now: T0 });
  h.jobRuns.finish('prev', { reason: 'ok', now: T0 + 60000 });
  const task = { id: 99, state: 'in-progress', jobBudget: 20, jobsSpent: 1, updatedAt: new Date(T0).toISOString() };
  const statusNow = () => deriveTaskStatus({ task, runs: h.jobRuns.forThread('T1'), now: Date.now() + 10 * 60000 });
  assert.equal(statusNow().status, 'reply-wait', '前提: 断る前は返信待ちに見えている');

  await h.onMessage(h.fable, fakeMessage({ channel: fakeThread('T1') }));
  const status = statusNow();
  assert.equal(status.status, 'recovery-wait');
  assert.match(status.reason, /^起動できなかった: タスク 99 の作業ツリーを用意できません: .* \(fable\)$/s);
  assert.equal(status.next, 'recovery');
  assert.equal(status.run.outcome, 'not-started');

  // 自動復旧: 起こし直しても同じ結果 (設定の不備) なので observe に留める — 起こさない
  const plan = planRecovery({
    task,
    status,
    config: { mode: 'auto', graceMin: 5, maxAutoRetries: 3, retryDelaysMin: [5, 15, 30] },
    dayJobsLeft: 10,
    now: Date.now() + 60 * 60000,
  });
  assert.equal(plan.action, 'observe');
  assert.equal(plan.safety, 'config');
  assert.match(plan.reason, /^設定・契約の不備 \(タスク 99 の作業ツリーを用意できません: /);
});

test('作業ツリーで断った記録を書けなくても、従来どおり ⚠️ で断り、例外を外へ出さない', async (t) => {
  const jobRuns = { refuse: () => { throw new Error('EACCES: data/job-runs.json'); } };
  const h = harness(t, { board: fakeBoard(), channel: { autonomy: AUTONOMY }, jobRuns });
  if (!outsideAnyRepo(h.dir)) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const thread = fakeThread('T1');
  const msg = fakeMessage({ channel: thread });
  await h.onMessage(h.fable, msg);
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0].content, /^⚠️ タスク 99 の作業ツリーを用意できません: /);
  assert.equal(thread.sent.length, 0);
  assert.equal(h.enqueued.length, 0);
  assert.ok(
    h.errors.some((e) => e === '[jobruns] 作業ツリーを用意できず断った job を記録できませんでした: EACCES: data/job-runs.json'),
    h.errors.join('\n'),
  );
});

test('作業ツリーの断り以外は記録の扱いが変わらない: タスクでないスレッド・作業ディレクトリ解決不能・失効した再開要求', async (t) => {
  // タスクでないスレッド: 作業ツリーを用意せず本体で受け付ける (記録は queued の 1 件)
  const h = harness(t, { board: fakeBoard(), channel: { autonomy: AUTONOMY } });
  await h.onMessage(h.fable, fakeMessage({ channel: fakeThread('T2') }));
  assert.equal(h.enqueued.length, 1);
  assert.deepEqual(h.jobRuns.list().map((r) => [r.threadId, r.stage, r.outcome]), [['T2', 'queued', null]]);

  // 作業ディレクトリを解決できない: ⚠️ で断り、記録は残さない
  const missing = harness(t, { board: fakeBoard(), channel: { cwd: join(tmpdir(), 'communitd-no-such-dir', 'x'), autonomy: AUTONOMY } });
  const msg = fakeMessage({ channel: fakeThread('T1') });
  await missing.onMessage(missing.fable, msg);
  assert.match(msg.replies[0].content, /^⚠️ 作業ディレクトリを解決できません \(kt: /);
  assert.deepEqual(missing.jobRuns.list(), []);

  // 失効した再開要求: ⏹ で断り、記録は残さない
  const recovery = { screenTrigger: () => ({ ok: false, reason: '再開要求 7-2 は期限切れです' }), noteAccepted: () => null };
  const stale = harness(t, { recovery });
  const thread = fakeThread('T1');
  await stale.onMessage(stale.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 再開要求 7-2', channel: thread }));
  assert.equal(thread.sent[0].content, '⏹ 再開要求 7-2 は期限切れです');
  assert.deepEqual(stale.jobRuns.list(), []);
});

test('タスクのスレッドで受け付けた job は再開要求を閉じる (§11.3)。ボードに無いスレッド・recovery の無い配備では呼ばない', async (t) => {
  // 送信完了から受付までの窓で同じタスクをもう一度起こさないための照合点。
  // チャンネルは自律運転なし = planTaskCwd が作業ツリーを要らないと言う (git を叩かない)
  const noted = [];
  let closed = { generation: 2 };
  const recovery = {
    screenTrigger: () => ({ ok: true, request: null }),
    noteAccepted: (p) => { noted.push(p); return closed; },
  };
  const h = harness(t, { board: fakeBoard(), recovery });
  const recoveryLogs = () => h.logs.filter((line) => line.startsWith('[recovery]'));
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 再開要求 99-2', channel: fakeThread('T1') }));
  assert.equal(h.enqueued.length, 1);
  const { jobId } = h.enqueued[0];
  assert.deepEqual(noted, [{ taskId: 99, triggerMessageId: 'M1', botKey: 'fable', runId: jobId }]);
  assert.deepEqual(recoveryLogs(), [`[recovery] #99 の再開要求 99-2 を受付済みにしました (job ${jobId})`]);
  assert.deepEqual(worktreeLogs(h), []);

  // 閉じる要求が無かった: 照合はするがログは出さず、job はそのまま積む
  closed = null;
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 続き', channel: fakeThread('T1'), id: 'M2' }));
  assert.equal(h.enqueued.length, 2);
  assert.deepEqual(noted.map((p) => p.triggerMessageId), ['M1', 'M2']);
  assert.equal(recoveryLogs().length, 1);

  // ボードに無いスレッド (taskId が無い): 照合しない
  await h.onMessage(h.fable, fakeMessage({ authorId: 'O', bot: true, content: '<@F> 別件', channel: fakeThread('T2'), id: 'M3' }));
  assert.equal(h.enqueued.length, 3);
  assert.equal(noted.length, 2, 'タスクの無いスレッドで再開要求を閉じに行っている');

  // recovery を持たない配備: タスクのスレッドでも照合せずに積む
  const bare = harness(t, { board: fakeBoard() });
  await bare.onMessage(bare.fable, fakeMessage({ channel: fakeThread('T1') }));
  assert.equal(bare.enqueued.length, 1);
  assert.equal(bare.jobRuns.get(bare.enqueued[0].jobId).taskId, '99', 'タスクのスレッドとして受け付けていない');
});

// ---- 受付 (docs/notes/2026-10-11-intake.md) ----

/** 受付の配線の偽物 — 受けた投稿を記録するだけ */
function fakeIntake() {
  const posts = [];
  return { posts, handlePost: async (bot, msg, { configured }) => { posts.push({ bot: bot.key, msg, configured }); } };
}

const intakeChannel = () => ({ id: 'C1', name: 'kt', isThread: () => false });

test('受付: 有効なチャンネルの直下の人間の投稿は受付 bot だけが受け、他の bot は起きない', async (t) => {
  const intake = fakeIntake();
  const h = harness(t, { intakeBot: true, intake, channel: { intake: true } });
  const msg = fakeMessage({ channel: intakeChannel(), content: 'ログイン画面が真っ白になる' });
  msg.startThread = async () => { throw new Error('スレッドを立てた'); };
  for (const key of ['fable', 'opus', 'manager']) await h.onMessage(h.bots.get(key), msg);
  assert.equal(intake.posts.length, 1);
  assert.equal(intake.posts[0].bot, 'manager');
  assert.equal(intake.posts[0].configured.channelName, 'kt');
  assert.equal(h.enqueued.length, 0);

  // 受付 bot への明示メンションも受付が受ける
  await h.onMessage(h.bots.get('manager'), fakeMessage({ channel: intakeChannel(), content: '<@M> これ見て' }));
  assert.equal(intake.posts.length, 2);
});

test('受付: 特定の bot へのメンションはその bot へ直行し (逃げ道)、受付は受けない — ロールのピルでも', async (t) => {
  const intake = fakeIntake();
  const h = harness(t, { intakeBot: true, intake, channel: { intake: true } });
  const thread = fakeThread('T-new');
  const msg = fakeMessage({ channel: intakeChannel(), content: '<@O> 直してほしい' });
  msg.startThread = async () => thread;
  await h.onMessage(h.bots.get('manager'), msg);
  await h.onMessage(h.bots.get('opus'), msg);
  assert.equal(intake.posts.length, 0);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0].botKey, 'opus');

  // 入力補完で管理ロールが選ばれた形 (<@&role>) も「opus 宛」として受付は見送る
  const roleMsg = fakeMessage({ channel: intakeChannel(), content: '<@&R-O> 直してほしい' });
  roleMsg.guild = { roles: { botRoleFor: (userId) => (userId === 'O' ? { id: 'R-O' } : null) } };
  await h.onMessage(h.bots.get('manager'), roleMsg);
  assert.equal(intake.posts.length, 0);
});

test('受付: 有効なチャンネルの直下では返信で起動しない (返信先も取りに行かない)。無効なチャンネルは今までどおり', async (t) => {
  const intake = fakeIntake();
  const h = harness(t, { intakeBot: true, intake, channel: { intake: true } });
  let fetched = 0;
  const reply = (channel) => {
    const msg = fakeMessage({ channel, content: 'それで進めて' });
    msg.reference = { messageId: 'X', type: 0, channelId: channel.id };
    msg.fetchReference = async () => { fetched += 1; return { author: { id: 'O' } }; };
    msg.startThread = async () => fakeThread('T-new');
    return msg;
  };
  await h.onMessage(h.bots.get('opus'), reply(intakeChannel()));
  assert.equal(h.enqueued.length, 0);
  assert.equal(fetched, 0, '起動しないのに返信先を取りに行った');

  const plain = harness(t, { intakeBot: true, intake });
  await plain.onMessage(plain.bots.get('opus'), reply(intakeChannel()));
  assert.equal(plain.enqueued.length, 1, '受付の無いチャンネルの返信起動まで止めた');
});

test('受付: 中継 (受付 bot の投稿) はスレッドの中で人間の重みで通る — hop を戻し・受信箱を閉じ・予算を減らさず・relay と記録', async (t) => {
  const h = harness(t, { intakeBot: true, intake: fakeIntake(), channel: { intake: true } });
  h.hops.take('T1');
  const thread = fakeThread('T1');
  await h.onMessage(h.bots.get('opus'), fakeMessage({ authorId: 'M', bot: true, content: '<@O>', channel: thread }));

  assert.equal(h.hops.hops('T1'), 0, '中継で hop を戻していない');
  assert.deepEqual(h.closed, ['T1'], '中継で受信箱を閉じていない');
  assert.deepEqual(h.spent, [], '中継をタスクの job 予算に記帳した');
  assert.equal(h.enqueued.length, 1);
  assert.equal(thread.sent[0].content, '⏳ Opus が受け付けました — 📥 受付経由の依頼');
  assert.deepEqual(h.jobRuns.get(h.enqueued[0].jobId).trigger, { messageId: 'M1', byBotKey: 'manager', kind: 'relay' });
});

test('受付: 中継はチャンネル直下では何も起こさない — 本文に <@id> が紛れても', async (t) => {
  const h = harness(t, { intakeBot: true, intake: fakeIntake(), channel: { intake: true } });
  const msg = fakeMessage({ authorId: 'M', bot: true, content: '<@O> の件はスレッドへ回しました', channel: intakeChannel() });
  msg.startThread = async () => { throw new Error('スレッドを立てた'); };
  await h.onMessage(h.bots.get('opus'), msg);
  await h.onMessage(h.bots.get('fable'), msg);
  assert.equal(h.enqueued.length, 0);
  assert.deepEqual(msg.replies, []);
});

test('受付: 受付 bot は通常の job を走らせない — スレッドで呼ばれても・無効なチャンネルでも何もしない', async (t) => {
  const intake = fakeIntake();
  const h = harness(t, { intakeBot: true, intake, channel: { intake: true } });
  const thread = fakeThread('T1');
  await h.onMessage(h.bots.get('manager'), fakeMessage({ content: '<@M> ここも見て', channel: thread }));
  assert.equal(thread.sent.length, 0);
  assert.equal(h.enqueued.length, 0);
  assert.equal(intake.posts.length, 0);

  const off = harness(t, { intakeBot: true, intake });
  await off.onMessage(off.bots.get('manager'), fakeMessage({ content: '<@M> 受付して', channel: intakeChannel() }));
  assert.equal(intake.posts.length, 0);
  assert.equal(off.enqueued.length, 0);
});
