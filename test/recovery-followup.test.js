import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecoveryService } from '../src/recovery-wiring.js';
import { RecoveryStore, classifySendError, parseRequestMarker, requestMarker } from '../src/recovery.js';
import { JobRunStore } from '../src/jobruns.js';

// 復旧まわりの見直しで残った残作業 A (受付側で失効した要求を断る) と
// B (送達不明を未送信と断定しない) の回帰テスト。

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();
const FABLE = { key: 'fable' };

const task = (over = {}) => ({
  id: '77', channel: 'kt', title: 'lint', state: 'in-progress', threadId: 'T77', branch: 'task/77',
  jobsSpent: 3, jobBudget: 20,
  createdAt: iso(T0 - minutes(600)), updatedAt: iso(T0 - minutes(60)),
  history: [{ at: iso(T0 - minutes(60)), from: 'approved', to: 'in-progress', by: 'scheduler' }],
  ...over,
});

function harness({ postAs = null, findRequestMessage = null, dayJobsLeft = 10, mode = 'manual', verifyDelayMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-followup-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  jobRuns.open({ id: 'f0', taskId: '77', threadId: 'T77', botKey: 'opus', channelName: 'kt' }, { now: T0 - minutes(60) });
  jobRuns.start('f0', { now: T0 - minutes(59) });
  jobRuns.noteSpawn('f0', { pid: 500, at: T0 - minutes(59), runtime: 'claude' });
  jobRuns.noteModelResult('f0', { ok: false, error: 'API Error: 529' }, { now: T0 - minutes(30) });
  jobRuns.finish('f0', { reason: 'failed(API Error: 529)', now: T0 - minutes(30), evidence: { hooks: true, traceReadable: true, toolCalls: 0, gitChanged: false } });
  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  const posts = [];
  const logs = [];
  const budget = { left: dayJobsLeft, reserved: 0, refunded: 0 };
  const tasks = [task()];
  const make = () => createRecoveryService({
    board: {
      list: ({ channel } = {}) => tasks.filter((t) => !channel || t.channel === channel),
      findByThread: (id) => tasks.find((t) => t.threadId === id) ?? null,
    },
    jobRuns,
    pauseStore: { paused: false },
    channels: ['kt'],
    autonomyFor: () => ({
      worker: { bots: ['opus'] }, reviewer: 'opus2', directionFile: '',
      recovery: { mode: mode === 'auto' ? 'auto' : 'observe', graceMin: 1, maxAutoRetries: 2, retryDelaysMin: [1, 2] },
    }),
    now: () => T0,
    log: (l) => logs.push(l),
    recoveryStore,
    availableBotKeys: () => ['opus', 'opus2', 'fable'],
    botUserId: (key) => ({ opus: 'O1', opus2: 'O2', fable: 'F1' })[key] ?? null,
    postAs: postAs ?? (async (p) => { posts.push(p); return { id: `M${posts.length}` }; }),
    findRequestMessage,
    dayJobsLeftFor: () => budget.left,
    reserveDayJob: () => { if (budget.left <= 0) return false; budget.left -= 1; budget.reserved += 1; return true; },
    refundDayJob: () => { budget.left += 1; budget.refunded += 1; },
    ...(verifyDelayMs === undefined ? {} : { verifyDelayMs }),
  });
  return { service: make(), make, posts, logs, jobRuns, recoveryStore, budget };
}

/** 受け手の job が受け付けた (index.js の受付点と同じ手順: 実行記録を作り、要求を閉じる) */
function accept(h, { messageId, runId, at }) {
  h.jobRuns.open({ id: runId, taskId: '77', threadId: 'T77', botKey: 'opus', channelName: 'kt', trigger: { messageId, byBotKey: 'fable' } }, { now: at });
  return h.service.noteAccepted({ taskId: '77', triggerMessageId: messageId, botKey: 'opus', runId, at });
}

// ---- A. 期限切れの再開要求を受付側でも無効化する ----

test('parseRequestMarker は印だけを読む', () => {
  assert.deepEqual(parseRequestMarker('本文\n再開要求 77-3'), { taskId: '77', generation: 3 });
  assert.deepEqual(parseRequestMarker(requestMarker('abc', 12)), { taskId: 'abc', generation: 12 });
  assert.equal(parseRequestMarker('<@O1>\n普通の handoff'), null);
  assert.equal(parseRequestMarker('再開要求 77-0'), null);
  assert.equal(parseRequestMarker(''), null);
  assert.equal(parseRequestMarker(null), null);
});

test('screenTrigger: 印の無い投稿は通し、有効な要求だけを通す', () => {
  const h = harness();
  assert.deepEqual(h.service.screenTrigger({ threadId: 'T77', content: '<@O1>\n普通の handoff', botKey: 'opus' }), { ok: true, request: null });
  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 });
  h.recoveryStore.settle('77', 1, 'sent', { messageId: 'M1', now: T0 });
  const ok = h.service.screenTrigger({ threadId: 'T77', content: `<@O1>\n…\n${requestMarker('77', 1)}`, botKey: 'opus', messageId: 'M1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request, { taskId: '77', generation: 1 });
  // 送信結果がまだ返っていない (pending) 要求も通す — Gateway が REST より先に届く
  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 + 1 });
  assert.equal(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 2), botKey: 'opus', messageId: 'M2' }).ok, true);
});

test('screenTrigger: 期限切れ・受付済み・送れなかった・台帳に無い・宛先違い・別の投稿・別タスクは断る', () => {
  const h = harness();
  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 });
  h.recoveryStore.settle('77', 1, 'sent', { messageId: 'M1', now: T0 });
  h.recoveryStore.expire('77', 1, { now: T0 + minutes(6) });
  const expired = h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 1), botKey: 'opus', messageId: 'M1' });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /^再開要求 77-1 は起動しません — 猶予内に受け付けられず期限切れ/);

  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 + minutes(6) });
  h.recoveryStore.settle('77', 2, 'sent', { messageId: 'M2', now: T0 + minutes(6) });
  h.recoveryStore.markAccepted('77', { triggerMessageId: 'M2', botKey: 'opus', runId: 'j2', now: T0 + minutes(7) });
  const dup = h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 2), botKey: 'opus', messageId: 'M2' });
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /既に受け付け済みです \(job j2\)/);

  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 + minutes(8) });
  h.recoveryStore.settle('77', 3, 'failed(Missing Access)', { now: T0 + minutes(8) });
  assert.match(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 3), botKey: 'opus' }).reason, /送れなかったと記録された/);

  assert.match(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 9), botKey: 'opus' }).reason, /台帳に無い/);

  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 + minutes(9) });
  h.recoveryStore.settle('77', 4, 'sent', { messageId: 'M4', now: T0 + minutes(9) });
  assert.match(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 4), botKey: 'opus2', messageId: 'M4' }).reason, /宛先は opus で、opus2 宛ではありません/);
  assert.match(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 4), botKey: 'opus', messageId: 'M-copy' }).reason, /記録された投稿 \(M4\) と違う投稿/);
  assert.match(h.service.screenTrigger({ threadId: 'T-other', content: requestMarker('77', 4), botKey: 'opus' }).reason, /このスレッドのタスク \(無し\) の要求ではありません/);
  assert.match(h.service.screenTrigger({ threadId: 'T77', content: requestMarker('78', 1), botKey: 'opus' }).reason, /このスレッドのタスク \(#77\) の要求ではありません/);
});

test('A: 第 1 要求 → 期限超過 → 第 2 要求 → 第 1 投稿が遅着、で起動するのは 1 件 (再配送と再起動を挟んでも)', async () => {
  const h = harness();
  const first = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 });
  assert.equal(first.ok, true, first.reason);
  const second = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 + minutes(6) });
  assert.equal(second.ok, true, second.reason);
  assert.equal(h.posts.length, 2);
  assert.equal(h.recoveryStore.attemptOf('77', 1).result, 'expired');
  assert.equal(h.recoveryStore.attemptOf('77', 2).result, 'sent');

  // 第 1 投稿 (M1) が遅れて届く → 受付側で断る (job は作らない)
  const late = h.service.screenTrigger({ threadId: 'T77', content: h.posts[0].text, botKey: 'opus', messageId: 'M1' });
  assert.equal(late.ok, false);
  assert.match(late.reason, /期限切れ/);
  // 第 2 投稿 (M2) → 通す → 受付で閉じる
  const fresh = h.service.screenTrigger({ threadId: 'T77', content: h.posts[1].text, botKey: 'opus', messageId: 'M2' });
  assert.equal(fresh.ok, true);
  const accepted = accept(h, { messageId: 'M2', runId: 'j2', at: T0 + minutes(7) });
  assert.equal(accepted.generation, 2);
  // 同じイベントの再配送は断る
  assert.match(h.service.screenTrigger({ threadId: 'T77', content: h.posts[1].text, botKey: 'opus', messageId: 'M2' }).reason, /再配送/);
  // 再起動 (同じ台帳で作り直したサービス) でも判定は同じ
  const restarted = h.make();
  assert.equal(restarted.screenTrigger({ threadId: 'T77', content: h.posts[0].text, botKey: 'opus', messageId: 'M1' }).ok, false);
  assert.equal(restarted.screenTrigger({ threadId: 'T77', content: h.posts[1].text, botKey: 'opus', messageId: 'M2' }).ok, false);
  assert.equal(h.jobRuns.forThread('T77').filter((r) => r.trigger?.messageId).length, 1, '投入された job が 1 件でない');
});

test('A (逆順): 第 1 投稿が期限内に受け付けられれば、その後の /retry は走っている job を理由に断る', async () => {
  const h = harness();
  const first = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 });
  assert.equal(first.ok, true, first.reason);
  assert.equal(h.service.screenTrigger({ threadId: 'T77', content: h.posts[0].text, botKey: 'opus', messageId: 'M1' }).ok, true);
  accept(h, { messageId: 'M1', runId: 'j1', at: T0 + minutes(1) });
  h.jobRuns.start('j1', { now: T0 + minutes(1) });
  const second = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 + minutes(6) });
  assert.equal(second.ok, false);
  assert.match(second.reason, /実行中/);
  assert.equal(h.posts.length, 1);
});

test('Gateway が REST より先に届いて受け付けた要求を、遅れて返った送信結果で上書きしない', () => {
  const h = harness();
  h.recoveryStore.begin('77', { target: 'worker', targetBotKey: 'opus', now: T0 });
  // 送信結果 (settle) の前に受付が来た
  const accepted = h.recoveryStore.markAccepted('77', { triggerMessageId: 'M1', botKey: 'opus', runId: 'j1', now: T0 + 100 });
  assert.equal(accepted.result, 'accepted');
  h.recoveryStore.settle('77', 1, 'sent', { messageId: 'M1', now: T0 + 500 });
  const after = h.recoveryStore.attemptOf('77', 1);
  assert.equal(after.result, 'accepted', '受付済みが送信済みへ戻っている');
  assert.equal(after.messageId, 'M1');
  assert.equal(h.recoveryStore.openRequest('77'), null);
});

// ---- B. 送達不明を未送信と断定しない ----

test('classifySendError: 既定は unknown。4xx・既知のコード・送信が始まらない文面だけ failed', () => {
  assert.equal(classifySendError(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })), 'unknown');
  assert.equal(classifySendError(Object.assign(new Error('Internal Server Error'), { status: 500 })), 'unknown');
  assert.equal(classifySendError(Object.assign(new Error('Bad Gateway'), { status: 502 })), 'unknown');
  assert.equal(classifySendError(new Error('boom')), 'unknown');
  assert.equal(classifySendError(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), 'unknown');
  assert.equal(classifySendError({ name: 'AbortError' }), 'unknown');
  assert.equal(classifySendError(null), 'unknown');
  assert.equal(classifySendError(Object.assign(new Error('Missing Access'), { status: 403, code: 50001 })), 'failed');
  assert.equal(classifySendError(Object.assign(new Error('Unknown Channel'), { code: 10003 })), 'failed');
  assert.equal(classifySendError(Object.assign(new Error('You are being rate limited.'), { status: 429 })), 'failed');
  assert.equal(classifySendError(new Error('Missing Access')), 'failed');
  assert.equal(classifySendError(new Error('opus は起動していません')), 'failed');
  assert.equal(classifySendError(new Error('スレッド T77 を取得できません')), 'failed');
  assert.equal(classifySendError(new Error('スレッド T77 は archive されています')), 'failed');
});

test('B: ソケット断・5xx は要求を送達不明として残し、日次予約を戻さず、走査が不完全なら不明のまま', async () => {
  const socket = harness({ mode: 'auto', postAs: async () => { throw Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }); } });
  await socket.service.autoTick({ at: T0 });
  assert.equal(socket.recoveryStore.openRequest('77').result, 'send-unknown');
  assert.equal(socket.budget.reserved, 1);
  assert.equal(socket.budget.refunded, 0, '送達不明で日次予算を戻している');

  const http500 = harness({ mode: 'auto', postAs: async () => { throw Object.assign(new Error('Internal Server Error'), { status: 500 }); } });
  await http500.service.autoTick({ at: T0 });
  assert.equal(http500.recoveryStore.openRequest('77').result, 'send-unknown');
  assert.equal(http500.budget.refunded, 0);

  // 走査が不完全 (最新 N 件だけ・戻り値が完全性を主張しない) なら、時間が経っても不明のまま
  let fail = true;
  const partial = harness({
    postAs: async () => { if (fail) throw new Error('other side closed'); return { id: 'M2' }; },
    findRequestMessage: async () => ({ messageId: null, complete: false }),
  });
  await partial.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 });
  fail = false;
  const later = await partial.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(30) });
  assert.equal(later.ok, false);
  assert.match(later.reason, /送達が不明/);
  assert.ok(partial.logs.some((l) => /走査が不完全/.test(l)), partial.logs.join(' | '));
  const bare = harness({
    postAs: async () => { if (fail) throw new Error('other side closed'); return { id: 'M2' }; },
    findRequestMessage: async () => null, // 完全性を主張しない戻り
  });
  fail = true;
  await bare.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 });
  fail = false;
  assert.equal((await bare.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(30) })).ok, false);

  // 完全な走査で無く、送信から十分に経った → failed に確定して送り直せる
  fail = true;
  const complete = harness({
    postAs: async () => { if (fail) throw new Error('other side closed'); return { id: 'M2' }; },
    findRequestMessage: async ({ since }) => { assert.equal(since, T0, '要求の作成時刻を渡していない'); return { messageId: null, complete: true }; },
    verifyDelayMs: minutes(2),
  });
  await complete.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 });
  fail = false;
  assert.equal((await complete.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(1) })).ok, false, '猶予前に確定している');
  const resent = await complete.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(3) });
  assert.equal(resent.ok, true, resent.reason);
  assert.match(complete.recoveryStore.attemptOf('77', 1).result, /^failed\(送達なしを確認/);
  // 送れていないと記録された第 1 要求の投稿が遅れて届いても、受付側が断る (A と合わせて成立)
  assert.equal(complete.service.screenTrigger({ threadId: 'T77', content: requestMarker('77', 1), botKey: 'opus' }).ok, false);
});
