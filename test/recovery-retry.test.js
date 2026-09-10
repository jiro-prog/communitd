import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecoveryService } from '../src/recovery-wiring.js';
import { RecoveryStore } from '../src/recovery.js';
import { JobRunStore } from '../src/jobruns.js';

// ---- /retry の実体 (§11.3) — 実ストア (mkdtemp) + 偽の Discord / キュー / OS ----

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

/** 止まった job の記録の材料 (jobRuns へ流し込む) */
const stalledRun = (over = {}) => ({
  id: 'j1', acceptedAt: T0 - minutes(60), startedAt: T0 - minutes(59), reason: 'verify-failed', endedAt: T0 - minutes(30), ...over,
});

function harness({
  tasks, runs = [], contracts = {}, paused = false, jobsItems = { active: [], waiting: [] },
  inspect = null, available = ['opus', 'opus2', 'fable'], reissue = null, hopBudget = undefined,
  gitDirty = () => true, postAs = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-retry-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  for (const r of runs) {
    jobRuns.open({ id: r.id, taskId: r.taskId ?? '77', threadId: r.threadId ?? 'T77', botKey: r.botKey ?? 'opus' }, { now: r.acceptedAt });
    if (r.startedAt) jobRuns.start(r.id, { now: r.startedAt });
    if (r.spawn) jobRuns.noteSpawn(r.id, { pid: r.spawn.pid, at: r.spawn.at, runtime: 'claude' });
    if (r.reason) jobRuns.finish(r.id, { reason: r.reason, now: r.endedAt });
  }
  if (runs.some((r) => r.reconcile)) jobRuns.reconcileOnStartup({ now: T0 - minutes(5) });
  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  const posts = [];
  const logs = [];
  const budgets = new Map();
  if (hopBudget !== undefined) budgets.set('T77', hopBudget);
  const service = createRecoveryService({
    board: {
      list: ({ channel } = {}) => tasks.filter((t) => !channel || t.channel === channel),
      findByThread: (id) => tasks.find((t) => t.threadId === id) ?? null,
    },
    jobRuns,
    contracts: { list: (threadId, key) => contracts[`${threadId}:${key}`] ?? [] },
    pauseStore: { paused },
    channels: ['kt'],
    autonomyFor: () => ({ worker: { bots: ['opus'] }, reviewer: 'opus2', directionFile: 'docs/direction.md' }),
    now: () => T0,
    log: (l) => logs.push(l),
    recoveryStore,
    jobs: { active: new Map(jobsItems.active.map((i) => [i.laneKey ?? i.threadId, i])), waiting: jobsItems.waiting },
    hops: {
      taskBudget: (t) => budgets.get(t) ?? null,
      grantTaskBudget: (t, n) => { budgets.set(t, (budgets.get(t) ?? 0) + n); return budgets.get(t); },
    },
    inspectProcess: inspect,
    availableBotKeys: () => available,
    botUserId: (key) => ({ opus: 'O1', opus2: 'O2', fable: 'F1' })[key] ?? null,
    postAs: postAs ?? (async (p) => { posts.push(p); }),
    reissueReview: reissue,
    gitDirty,
  });
  return { service, posts, logs, jobRuns, recoveryStore, budgets };
}

test('retry: 復旧待ちの in-progress は担当以外の client から再開メッセージを投げ、世代と門番を記録する', async () => {
  const h = harness({
    tasks: [task()],
    runs: [stalledRun({ spawn: { pid: 1, at: T0 - minutes(59) } })],
  });
  const out = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(out.ok, true, out.reason);
  assert.match(out.reason, /^🔁 #77 は in-progress — 担当 opus/);
  assert.equal(out.target, 'worker');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].botKey, 'fable');
  assert.equal(h.posts[0].threadId, 'T77');
  assert.deepEqual(h.posts[0].mentionUserIds, ['O1']);
  assert.match(h.posts[0].text, /^<@O1>\n/);
  assert.match(h.posts[0].text, /試行 2/);
  assert.match(h.posts[0].text, /verify-failed/);
  assert.match(h.posts[0].text, /前回の変更が残っている/);
  assert.match(h.posts[0].text, /残り job 予算: 17 job/);
  assert.match(h.posts[0].text, /docs\/direction\.md/);
  // 世代の台帳
  const entry = h.recoveryStore.get('77');
  assert.equal(entry.generation, 1);
  // 送信までが分かっているので `sent` (受付は受け手の job が閉じる — §11.3)
  assert.equal(entry.attempts[0].result, 'sent');
  assert.equal(entry.attempts[0].kind, 'manual');
  assert.equal(entry.attempts[0].by, 'U1');
  assert.equal(entry.attempts[0].previousRunId, 'j1');
  assert.equal(entry.attempts[0].targetBotKey, 'opus');
  assert.match(h.posts[0].text, /\n再開要求 77-1$/, '送達不明のときに探す印が無い');
  // 門番は台帳の残高で組み直す (増やさない)
  assert.equal(h.budgets.get('T77'), 17);
  assert.deepEqual(h.service.inFlightIds(), []);
  assert.ok(h.logs.some((l) => /起こし直し \(manual \/ 再開要求 77-1 \/ 投稿は fable\)/.test(l)), h.logs.join(' | '));
});

test('retry: 担当自身の client から打たれたら別の bot を投げ手にする / 門番があれば触らない', async () => {
  const h = harness({ tasks: [task()], runs: [stalledRun({ reason: 'failed(API Error: 529)' })], hopBudget: 5 });
  const out = await h.service.retry({ thread: { id: 'T77' }, bot: { key: 'opus' }, userId: 'U1' });
  assert.equal(out.ok, true, out.reason);
  assert.notEqual(h.posts[0].botKey, 'opus');
  assert.equal(h.budgets.get('T77'), 5, '既にある門番を積み増している');
});

test('retry: 走っている・未消費契約・pause・対象なしでは起こさず、台帳にも世代を積まない', async () => {
  const running = harness({ tasks: [task()], runs: [stalledRun()], jobsItems: { active: [{ threadId: 'T77', laneKey: 'L' }], waiting: [] } });
  const r1 = await running.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /起こし直しません/);
  assert.equal(running.recoveryStore.get('77'), null);
  assert.equal(running.posts.length, 0);

  const waiting = harness({ tasks: [task()], runs: [stalledRun()], jobsItems: { active: [], waiting: [{ threadId: 'T77' }] } });
  assert.equal((await waiting.service.retry({ thread: { id: 'T77' }, bot: FABLE })).ok, false);

  const contracted = harness({ tasks: [task()], runs: [stalledRun()], contracts: { 'T77:opus': [{ kind: 'delegation', toBotKey: 'opus' }] } });
  assert.match((await contracted.service.retry({ thread: { id: 'T77' }, bot: FABLE })).reason, /未消費の契約/);

  const paused = harness({ tasks: [task()], runs: [stalledRun()], paused: true });
  assert.match((await paused.service.retry({ thread: { id: 'T77' }, bot: FABLE })).reason, /停止中/);

  const none = await paused.service.retry({ thread: { id: 'nope' }, bot: FABLE });
  assert.match(none.reason, /対応するタスクがありません/);
});

test('retry: 連打しても 1 回だけ (await の前に排他を取る)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ tasks: [task()], runs: [stalledRun()], postAs: async () => { await gate; } });
  const first = h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  const second = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /進行中/);
  assert.deepEqual(h.service.inFlightIds(), ['77']);
  release();
  assert.equal((await first).ok, true);
  assert.equal(h.recoveryStore.get('77').generation, 1, '連打で世代が 2 つ積まれている');
  assert.deepEqual(h.service.inFlightIds(), []);
});

test('retry: 要照合は子プロセスを OS に聞き、生きていれば断り、居なければ記録を閉じて起こす', async () => {
  const reconciled = stalledRun({ reason: null, endedAt: null, spawn: { pid: 4242, at: T0 - minutes(59) }, reconcile: true });
  const alive = harness({
    tasks: [task()], runs: [reconciled],
    inspect: async () => ({ alive: true, createdAt: T0 - minutes(59), name: 'claude.exe', command: 'claude -p', error: null }),
  });
  const r1 = await alive.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /pid 4242\) が\*\*まだ生きています\*\*/);
  assert.equal(alive.jobRuns.get('j1').stage, 'reconcile', '生きているのに要照合を閉じている');

  const unknown = harness({ tasks: [task()], runs: [reconciled], inspect: null });
  assert.match((await unknown.service.retry({ thread: { id: 'T77' }, bot: FABLE })).reason, /生存を確かめられません/);

  const failing = harness({ tasks: [task()], runs: [reconciled], inspect: async () => { throw new Error('powershell ENOENT'); } });
  assert.match((await failing.service.retry({ thread: { id: 'T77' }, bot: FABLE })).reason, /生存を確かめられません/);

  const gone = harness({
    tasks: [task()], runs: [reconciled],
    inspect: async () => ({ alive: false, createdAt: null, name: null, command: null, error: null }),
  });
  const r3 = await gone.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(r3.ok, true, r3.reason);
  const closed = gone.jobRuns.get('j1');
  assert.equal(closed.stage, 'ended');
  assert.equal(closed.outcome, 'unknown');
  assert.equal(closed.reconcile.how, 'retry:process-gone');
  assert.equal(closed.reconcile.resolvedBy, 'U1');
  assert.equal(gone.posts.length, 1);
  assert.match(gone.posts[0].text, /試行 2/);
});

test('retry: 実行記録が無い旧タスクは警告つきで起こす (記録なしの旨を本文に書く)', async () => {
  const old = harness({ tasks: [task()], runs: [] });
  const out = await old.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /確認できていません/);
  assert.match(old.posts[0].text, /実行記録が無い/);
  assert.match(old.posts[0].text, /試行 1/);
});

test('retry: review はレビューの出し直し (共通判定) へつなぎ、結果を世代へ書く', async () => {
  const h = harness({
    tasks: [task({ state: 'review' })],
    runs: [stalledRun({ reason: 'ok' })],
    reissue: async ({ thread, bot }) => ({ ok: true, reason: `#77 のレビューを出し直しました (${thread.id} / ${bot.key})` }),
  });
  // 直前の job の next は human (report) で猶予も過ぎているので、review の復旧待ち
  const out = await h.service.retry({ thread: { id: 'T77' }, bot: FABLE, userId: 'U1' });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.target, 'reviewer');
  assert.match(out.reason, /レビュー担当 \(opus2\)/);
  assert.match(out.reason, /出し直しました \(T77 \/ fable\)/);
  assert.equal(h.posts.length, 0, 'review で worker を起こしている');
  assert.equal(h.recoveryStore.get('77').attempts[0].result, 'sent');
  assert.equal(h.recoveryStore.get('77').attempts[0].target, 'reviewer');
  assert.equal(h.recoveryStore.get('77').attempts[0].targetBotKey, 'opus2');

  const failing = harness({
    tasks: [task({ state: 'review' })],
    runs: [stalledRun({ reason: 'ok' })],
    reissue: async () => ({ ok: false, reason: '⚠️ レビュー担当 (opus2) が起動していません' }),
  });
  const ng = await failing.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(ng.ok, false);
  assert.match(ng.reason, /^⚠️ レビュー担当/);
  assert.match(failing.recoveryStore.get('77').attempts[0].result, /^failed\(/);

  const unwired = harness({ tasks: [task({ state: 'review' })], runs: [stalledRun({ reason: 'ok' })], reissue: null });
  assert.match((await unwired.service.retry({ thread: { id: 'T77' }, bot: FABLE })).reason, /配線されていません/);
});

test('retry: 予算が無ければ増やさずに断り、投稿に失敗したら世代に failed を残す', async () => {
  const spent = harness({ tasks: [task({ jobsSpent: 20, jobBudget: 20 })], runs: [stalledRun()] });
  const r = await spent.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /勝手に増やしません/);
  assert.equal(spent.budgets.has('T77'), false);

  const broken = harness({ tasks: [task()], runs: [stalledRun()], postAs: async () => { throw new Error('Missing Access'); } });
  const out = await broken.service.retry({ thread: { id: 'T77' }, bot: FABLE });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Missing Access/);
  assert.match(broken.recoveryStore.get('77').attempts[0].result, /^failed\(Missing Access/);

  // 台帳が無ければ機能ごと無効 (黙って起こさない)
  const noStore = createRecoveryService({
    board: { list: () => [], findByThread: () => task() },
    jobRuns: new JobRunStore(join(mkdtempSync(join(tmpdir(), 'communitd-retry-')), 'job-runs.json')),
  });
  assert.match((await noStore.retry({ thread: { id: 'T77' } })).reason, /配線されていません/);
});
