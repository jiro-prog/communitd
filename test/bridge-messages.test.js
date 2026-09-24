import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { JobQueue } from '../src/queue.js';
import { ContractStore } from '../src/store.js';

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
} = {}) {
  const msg = {
    id,
    content,
    cleanContent: content.replace(/<@\w+>\s*/g, ''),
    author: { id: authorId, bot, displayName: authorId, username: authorId },
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
} = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-messages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = canonicalCwd(dir);
  const config = { guildId: 'G', allowedUserIds: ['U1'], channels: { kt: { cwd: dir, verify: 'npm test' } }, bots: {} };
  const bots = new Map([
    ['fable', { key: 'fable', userId: 'F', client: {}, cfg: { displayName: 'Fable' } }],
    ['opus', { key: 'opus', userId: 'O', client: {}, cfg: { displayName: 'Opus' } }],
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
    board: null,
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

test('失効した再開要求は hop と予算を消費する前に断る', async (t) => {
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

// ---- 社会の印が付いた起動 ----

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
