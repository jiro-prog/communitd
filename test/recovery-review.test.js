import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecoveryService } from '../src/recovery-wiring.js';
import { RecoveryStore, classifySendError, planRetry, requestMarker, retryMessage } from '../src/recovery.js';
import { JobRunStore } from '../src/jobruns.js';

// docs/reviews/2026-09-05-recovery-review.md の Critical 3 件の回帰テスト。
// 実ストア (mkdtemp) + 偽の Discord / OS / 日次予算。

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

function harness({
  tasks = [task()], failedRuns = 1, reconciled = [], postAs = null, inspect = null, findRequestMessage = null,
  dayJobsLeft = 10, mode = 'manual', contracts = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-review-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  for (const t of tasks) {
    for (let i = 0; i < failedRuns; i += 1) {
      const id = `${t.id}-f${i}`;
      jobRuns.open({ id, taskId: t.id, threadId: t.threadId, botKey: 'opus', channelName: 'kt' }, { now: T0 - minutes(60 - i) });
      jobRuns.start(id, { now: T0 - minutes(59 - i) });
      jobRuns.noteSpawn(id, { pid: 500 + i, at: T0 - minutes(59 - i), runtime: 'claude' });
      jobRuns.noteModelResult(id, { ok: false, error: 'API Error: 529' }, { now: T0 - minutes(30) });
      jobRuns.finish(id, { reason: 'failed(API Error: 529)', now: T0 - minutes(30), evidence: { hooks: true, traceReadable: true, toolCalls: 0, gitChanged: false } });
    }
  }
  for (const r of reconciled) {
    jobRuns.open({ id: r.id, taskId: r.taskId ?? '77', threadId: r.threadId ?? 'T77', botKey: r.botKey ?? 'opus', channelName: 'kt' }, { now: r.at });
    jobRuns.start(r.id, { now: r.at + 1000 });
    if (r.pid) jobRuns.noteSpawn(r.id, { pid: r.pid, at: r.at + 2000, runtime: 'claude' });
  }
  if (reconciled.length > 0) jobRuns.reconcileOnStartup({ now: T0 - minutes(5) });
  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  const posts = [];
  const logs = [];
  const inspected = [];
  const budget = { left: dayJobsLeft, reserved: 0, refunded: 0 };
  const service = createRecoveryService({
    board: {
      list: ({ channel } = {}) => tasks.filter((t) => !channel || t.channel === channel),
      findByThread: (id) => tasks.find((t) => t.threadId === id) ?? null,
    },
    jobRuns,
    contracts: { list: (threadId, key) => contracts[`${threadId}:${key}`] ?? [] },
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
    inspectProcess: inspect
      ? async (pid) => { inspected.push(pid); return inspect(pid); }
      : null,
    findRequestMessage,
    dayJobsLeftFor: () => budget.left,
    reserveDayJob: () => { if (budget.left <= 0) return false; budget.left -= 1; budget.reserved += 1; return true; },
    refundDayJob: () => { budget.left += 1; budget.refunded += 1; },
  });
  return { service, posts, logs, inspected, jobRuns, recoveryStore, budget };
}

// ---- Critical 1: 送信完了から受付までの間に重複送信できる ----

test('送信成功後・受付前の連打は 2 件目を断り、受付で要求が閉じてから次を打てる', async () => {
  const h = harness();
  const first = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.sent, true);
  assert.equal(first.requestId, '再開要求 77-1');
  // Gateway の受付がまだ (実行記録もキューも前の失敗のまま) — 状態だけ見ると復旧待ち
  assert.equal(h.service.statusOf(task()).status, 'recovery-wait');
  const second = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /再開要求 77-1\) は送信済みで、opus の受付待ち/);
  assert.equal(h.posts.length, 1, '受付前に 2 通目を送っている');
  assert.equal(h.recoveryStore.get('77').generation, 1, '受付前に世代が進んでいる');
  assert.equal(h.recoveryStore.openRequest('77').result, 'sent');

  // 受け手の job が受け付けた (index.js の受付点が呼ぶ) — 起動メッセージの ID で照合
  const accepted = h.service.noteAccepted({ taskId: '77', triggerMessageId: 'M1', botKey: 'opus', runId: 'j-new' });
  assert.equal(accepted.generation, 1);
  assert.equal(accepted.result, 'accepted');
  assert.equal(accepted.runId, 'j-new');
  assert.equal(h.recoveryStore.openRequest('77'), null);
  // 別の投稿 ID では閉じない
  const h2 = harness();
  await h2.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(h2.service.noteAccepted({ taskId: '77', triggerMessageId: 'M-other', botKey: 'fable', runId: 'x' }), null);
  assert.equal(h2.recoveryStore.openRequest('77').result, 'sent');

  // 受け付けた job が終わって再び止まったら、新しい要求を出せる
  h.jobRuns.open({ id: 'j-new', taskId: '77', threadId: 'T77', botKey: 'opus', channelName: 'kt', trigger: { messageId: 'M1', byBotKey: 'fable' } }, { now: T0 + minutes(1) });
  h.jobRuns.start('j-new', { now: T0 + minutes(1) });
  h.jobRuns.finish('j-new', { reason: 'failed(API Error: 500)', now: T0 + minutes(2) });
  const third = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 + minutes(3) });
  assert.equal(third.ok, true, third.reason);
  assert.equal(h.posts.length, 2);
  assert.equal(h.recoveryStore.get('77').generation, 2);
});

test('送達不明の送信は要求を残して塞ぎ、スレッドの印で照合できたときだけ解ける', async () => {
  let fail = true;
  const posts = [];
  const h = harness({
    postAs: async (p) => { posts.push(p); if (fail) throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }); return { id: 'M9' }; },
    findRequestMessage: async () => ({ messageId: null, complete: true }),
  });
  const first = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 });
  assert.equal(first.ok, false);
  assert.equal(first.sent, 'unknown');
  assert.match(first.reason, /送達が不明/);
  assert.equal(h.recoveryStore.openRequest('77').result, 'send-unknown');
  assert.equal(h.budget.refunded, 0, '手動では予約しないが、不明は戻さない側');

  // 送信から時間が経っていないうちは、全件走査で見つからなくても不明のまま (照会時に見えていない可能性)
  fail = false;
  const early = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 + minutes(1) });
  assert.equal(early.ok, false);
  assert.match(early.reason, /送達が不明/);
  assert.equal(posts.length, 1);

  // 2 回目 (十分に経過): 要求以降の投稿を全件走査して無い → 確実に送れていないので failed にして送り直せる
  const second = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1', at: T0 + minutes(3) });
  assert.equal(second.ok, true, second.reason);
  assert.equal(posts.length, 2);
  const attempts = h.recoveryStore.get('77').attempts;
  assert.match(attempts[0].result, /^failed\(送達なしを確認/);
  assert.equal(attempts[1].result, 'sent');
  assert.equal(attempts[1].messageId, 'M9');

  // 投稿が見つかったなら送信済み扱いになり、受付待ちとして塞ぐ (再送しない)
  const found = harness({
    postAs: async () => { throw new Error('socket hang up'); },
    findRequestMessage: async ({ marker }) => (marker === requestMarker('77', 1) ? 'M-found' : null),
  });
  await found.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  const again = await found.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(again.ok, false);
  assert.match(again.reason, /送信済みで、opus の受付待ち/);
  assert.equal(found.recoveryStore.openRequest('77').result, 'sent');
  assert.equal(found.recoveryStore.openRequest('77').messageId, 'M-found');

  // 照合できない (Discord が返らない) 間は塞いだまま
  const dark = harness({
    postAs: async () => { throw new Error('ECONNRESET'); },
    findRequestMessage: async () => { throw new Error('still down'); },
  });
  await dark.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  const blocked = await dark.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /送達が不明/);

  // 確実な失敗 (権限・不明チャンネル) は failed で、すぐ打ち直せる
  const definite = harness({ postAs: async () => { throw new Error('Missing Access'); } });
  const r = await definite.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(r.sent, false);
  assert.match(definite.recoveryStore.get('77').attempts[0].result, /^failed\(Missing Access/);
  assert.equal(definite.recoveryStore.openRequest('77'), null);
  assert.equal(classifySendError(new Error('Missing Access')), 'failed');
  assert.equal(classifySendError({ name: 'AbortError' }), 'unknown');
});

test('送信済みで猶予内に受け付けられなかった要求は期限切れになり、もう一度打てる', async () => {
  const h = harness();
  await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 });
  const soon = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(2) });
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /\(2 分前\)/);
  const late = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, at: T0 + minutes(6) });
  assert.equal(late.ok, true, late.reason);
  const attempts = h.recoveryStore.get('77').attempts;
  assert.equal(attempts[0].result, 'expired');
  assert.equal(attempts[1].result, 'sent');
  assert.ok(h.logs.some((l) => /期限切れ/.test(l)));
});

test('再起動を挟んでも、送信済み要求は実行記録の受付 (起動メッセージの ID) と照合して閉じる', async () => {
  const h = harness();
  await h.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  // 前プロセスが落ちる前に受け手の job は受け付けていた (実行記録に trigger.messageId が残る)
  h.jobRuns.open({ id: 'j-acc', taskId: '77', threadId: 'T77', botKey: 'opus', channelName: 'kt', trigger: { messageId: 'M1', byBotKey: 'fable' } }, { now: T0 + 1000 });
  // 新プロセス: 同じストアで service を作り直して照合
  const restarted = createRecoveryService({
    board: { list: () => [task()], findByThread: () => task() },
    jobRuns: h.jobRuns,
    channels: ['kt'],
    autonomyFor: () => ({ worker: { bots: ['opus'] }, reviewer: 'opus2' }),
    now: () => T0 + minutes(1),
    recoveryStore: h.recoveryStore,
    availableBotKeys: () => ['opus', 'fable'],
    botUserId: () => 'O1',
    postAs: async () => ({ id: 'M2' }),
  });
  const closed = restarted.reconcileRequests();
  assert.deepEqual(closed, [{ taskId: '77', generation: 1, runId: 'j-acc' }]);
  assert.equal(h.recoveryStore.openRequest('77'), null);
  assert.equal(h.recoveryStore.get('77').attempts[0].result, 'accepted');
  // reviewer 宛 (ID が取れない要求) は宛先 bot と時刻で照合する
  const r = harness({ tasks: [task({ state: 'review' })] });
  r.recoveryStore.begin('77', { kind: 'manual', target: 'reviewer', targetBotKey: 'opus2', now: T0 });
  r.recoveryStore.settle('77', 1, 'sent', { now: T0 });
  r.jobRuns.open({ id: 'j-rev', taskId: '77', threadId: 'T77', botKey: 'opus2', channelName: 'kt', trigger: { messageId: 'CM', byBotKey: 'fable' } }, { now: T0 + 500 });
  assert.equal(r.service.reconcileRequests().length, 1);
  assert.equal(r.recoveryStore.get('77').attempts[0].result, 'accepted');
});

test('planRetry は openRequest の有無だけで判断できる (純粋)', () => {
  const status = { status: 'recovery-wait', reason: 'x', since: T0 - minutes(30), waitedMs: minutes(30), next: 'recovery', run: { id: 'j1' } };
  const base = { task: task(), status, workerKeys: ['opus'], reviewerKey: 'opus2', availableBotKeys: ['opus', 'fable'], now: T0 };
  assert.equal(planRetry(base).ok, true);
  const sent = planRetry({ ...base, openRequest: { generation: 3, result: 'sent', sentAt: iso(T0 - minutes(1)), targetBotKey: 'opus' } });
  assert.equal(sent.ok, false);
  assert.match(sent.reason, /再開要求 77-3\) は送信済みで、opus の受付待ちです \(1 分前\)/);
  const unknown = planRetry({ ...base, openRequest: { generation: 4, result: 'send-unknown', at: iso(T0) } });
  assert.match(unknown.reason, /送達が不明/);
  assert.match(unknown.reason, /「再開要求 77-4」/);
  const pending = planRetry({ ...base, openRequest: { generation: 5, result: 'pending', at: iso(T0) } });
  assert.equal(pending.ok, false);
  // 印は本文の末尾に必ず残る (長い題でも)
  const text = retryMessage({ task: task({ title: 'あ'.repeat(3000) }), botUserId: 'O1', requestId: requestMarker('77', 9) });
  assert.ok(text.endsWith('\n再開要求 77-9'));
  assert.ok(text.length <= 1900);
});

// ---- Critical 2: 最新の子だけを照合し、他の未照合記録も閉じてしまう ----

test('未照合が複数あれば全件を照合し、古い子が生きていれば断って 1 件も閉じない', async () => {
  const alive = new Set([1001]);
  const h = harness({
    failedRuns: 0,
    reconciled: [
      { id: 'j1', at: T0 - minutes(50), pid: 1001 },
      { id: 'j2', at: T0 - minutes(20), pid: 1002 },
    ],
    inspect: (pid) => (alive.has(pid)
      ? { alive: true, createdAt: T0 - minutes(50) + 2000, name: 'claude.exe', command: 'claude -p', error: null }
      : { alive: false, createdAt: null, name: null, command: null, error: null }),
  });
  assert.match(h.service.statusOf(task()).reason, /未照合 2 件/);
  const out = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /pid 1001\) が\*\*まだ生きています\*\*/);
  assert.deepEqual([...h.inspected].sort(), [1001, 1002], '全件を照会していない');
  assert.equal(h.jobRuns.get('j1').stage, 'reconcile');
  assert.equal(h.jobRuns.get('j2').stage, 'reconcile', '生きている子が居るのに別の記録を閉じている');
  assert.equal(h.posts.length, 0);

  // 古い子だけ照会不能 → 断る
  const dim = harness({
    failedRuns: 0,
    reconciled: [{ id: 'j1', at: T0 - minutes(50), pid: 1001 }, { id: 'j2', at: T0 - minutes(20), pid: 1002 }],
    inspect: (pid) => (pid === 1001
      ? { alive: false, createdAt: null, name: null, command: null, error: 'powershell が返らない' }
      : { alive: false, createdAt: null, name: null, command: null, error: null }),
  });
  const r2 = await dim.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /pid 1001\) の生存を確かめられません/);
  assert.equal(dim.jobRuns.get('j2').stage, 'reconcile');

  // 全件消滅 (複数 bot の記録が混在) → 全件閉じて起こす
  const gone = harness({
    failedRuns: 0,
    reconciled: [
      { id: 'j1', at: T0 - minutes(50), pid: 1001 },
      { id: 'j2', at: T0 - minutes(20), pid: 1002, botKey: 'opus2' },
      { id: 'j3', at: T0 - minutes(10) }, // pid の無い (導入前の) 記録
    ],
    inspect: () => ({ alive: false, createdAt: null, name: null, command: null, error: null }),
  });
  const r3 = await gone.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(r3.ok, true, r3.reason);
  assert.deepEqual([...gone.inspected].sort(), [1001, 1002]);
  assert.equal(gone.jobRuns.get('j1').reconcile.how, 'retry:process-gone');
  assert.equal(gone.jobRuns.get('j2').reconcile.how, 'retry:process-gone');
  assert.equal(gone.jobRuns.get('j3').reconcile.how, 'retry:unverified');
  assert.ok(r3.warnings.some((w) => /pid の無い未照合記録 1 件/.test(w)));
  assert.equal(gone.posts.length, 1);
});

// ---- Critical 3: 自動復旧は日次残高を読むが、消費を記録しない ----

test('自動復旧は送信前に日次予算を予約し、残高 1・候補 2 件なら 1 件しか起こさない', async () => {
  const h = harness({
    mode: 'auto',
    dayJobsLeft: 1,
    tasks: [task(), task({ id: '78', threadId: 'T78' })],
  });
  const out = await h.service.autoTick({ at: T0 });
  assert.equal(h.posts.length, 1, `残高 1 で ${h.posts.length} 件起こした`);
  assert.equal(h.budget.reserved, 1);
  assert.equal(h.budget.left, 0);
  assert.deepEqual(out.decisions.map((d) => d.action).sort(), ['observe', 'retry']);
  const skipped = out.decisions.find((d) => d.action === 'observe');
  assert.match(skipped.reason, /日次予算/);
  const counts = ['77', '78'].map((id) => h.recoveryStore.recoveryOf(id)?.autoCount ?? 0);
  assert.deepEqual(counts.sort(), [0, 1]);
});

test('自動復旧の予約は、確実に送れなかったときだけ戻し、送達不明では戻さない', async () => {
  const definite = harness({ mode: 'auto', dayJobsLeft: 5, postAs: async () => { throw new Error('Missing Access'); } });
  await definite.service.autoTick({ at: T0 });
  assert.equal(definite.budget.reserved, 1);
  assert.equal(definite.budget.refunded, 1);
  assert.equal(definite.budget.left, 5);

  const unknown = harness({ mode: 'auto', dayJobsLeft: 5, postAs: async () => { throw new Error('ETIMEDOUT'); } });
  await unknown.service.autoTick({ at: T0 });
  assert.equal(unknown.budget.reserved, 1);
  assert.equal(unknown.budget.refunded, 0, '送達不明で残高を戻している');
  assert.equal(unknown.recoveryStore.openRequest('77').result, 'send-unknown');
  // 次の tick は送達不明の要求が塞ぐので、新たに予約も送信もしない
  const before = unknown.budget.reserved;
  await unknown.service.autoTick({ at: T0 + minutes(1) });
  assert.equal(unknown.budget.reserved, before + 1, '予約はするが');
  assert.equal(unknown.budget.refunded, 1, 'retry が「送達不明で塞がれている」と確実に分かったので戻す');

  // 送れた (sent) は戻さない。予約が無ければ (observe) 何も動かさない
  const ok = harness({ mode: 'auto', dayJobsLeft: 5 });
  await ok.service.autoTick({ at: T0 });
  assert.equal(ok.budget.reserved, 1);
  assert.equal(ok.budget.refunded, 0);
  const observe = harness({ mode: 'observe', dayJobsLeft: 5 });
  await observe.service.autoTick({ at: T0 });
  assert.equal(observe.budget.reserved, 0);
});
