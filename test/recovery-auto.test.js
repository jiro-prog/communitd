import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RECOVERY_ACTIONS, RecoveryStore, classifySideEffects, planRecovery } from '../src/recovery.js';
import { createRecoveryService } from '../src/recovery-wiring.js';
import { JobRunStore } from '../src/jobruns.js';
import { ContractStore, PauseStore } from '../src/store.js';
import { TaskBoardStore } from '../src/board.js';
import { HopTracker } from '../src/hops.js';
import { JobQueue } from '../src/queue.js';
import { createBoardWiring } from '../src/bridge/board.js';
import { createDiscordWiring } from '../src/bridge/discord.js';
import { INFRA_PREFIXES } from '../src/bridge/prompt.js';
import { createRecoveryWiring } from '../src/bridge/recovery.js';
import {
  AUTONOMY_RECOVERY_KEYS,
  DEFAULT_RECOVERY_MODE,
  RECOVERY_MODES,
  resolveAutonomy,
  validateAutonomy,
} from '../src/config.js';
import { formatStatus, summarizeStatus } from '../src/status.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();

// ---- 設定 (§11.4) ----

test('autonomy.recovery は既定 auto / 5 分 / 3 回 / [5, 15, 30] で、書けば上書きできる', () => {
  const def = resolveAutonomy({ autonomy: { enabled: true } }).recovery;
  assert.deepEqual(def, { mode: 'auto', graceMin: 5, maxAutoRetries: 3, retryDelaysMin: [5, 15, 30] });
  assert.equal(DEFAULT_RECOVERY_MODE, 'auto');
  const custom = resolveAutonomy({
    autonomy: { recovery: { mode: 'observe', graceMin: 10, maxAutoRetries: 0, retryDelaysMin: [1, 2, 3] } },
  }).recovery;
  assert.deepEqual(custom, { mode: 'observe', graceMin: 10, maxAutoRetries: 0, retryDelaysMin: [1, 2, 3] });
  // 読めない値は既定へ (検証は別に落とす)
  assert.equal(resolveAutonomy({ autonomy: { recovery: { mode: 'yes' } } }).recovery.mode, 'auto');
  assert.deepEqual(resolveAutonomy({ autonomy: { recovery: { retryDelaysMin: [] } } }).recovery.retryDelaysMin, [5, 15, 30]);
});

test('autonomy.recovery の未知キー・型違い・範囲外は起動時に拒否する', () => {
  const at = (autonomy) => validateAutonomy(autonomy, { channel: 'kt', botKeys: ['opus'], hasVerify: true });
  assert.deepEqual(at({ recovery: { mode: 'auto', graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] } }), []);
  assert.deepEqual(at({ recovery: {} }), []);
  assert.ok(at({ recovery: 'auto' }).some((e) => e.includes('channels.kt.autonomy.recovery はオブジェクト')));
  assert.ok(at({ recovery: { mod: 'auto' } }).some((e) => e.includes('channels.kt.autonomy.recovery.mod は不明なキー')));
  assert.ok(at({ recovery: { mod: 'auto' } }).some((e) => e.includes(AUTONOMY_RECOVERY_KEYS.join(' / '))));
  assert.ok(at({ recovery: { mode: 'on' } }).some((e) => e.includes('recovery.mode は') && e.includes(RECOVERY_MODES.join(' | '))));
  assert.ok(at({ recovery: { graceMin: 0 } }).some((e) => e.includes('recovery.graceMin')));
  assert.ok(at({ recovery: { graceMin: '5' } }).some((e) => e.includes('recovery.graceMin')));
  assert.ok(at({ recovery: { maxAutoRetries: -1 } }).some((e) => e.includes('recovery.maxAutoRetries')));
  assert.deepEqual(at({ recovery: { maxAutoRetries: 0 } }), [], '0 (自動では起こさない) は書けるべき');
  assert.ok(at({ recovery: { retryDelaysMin: [] } }).some((e) => e.includes('recovery.retryDelaysMin')));
  assert.ok(at({ recovery: { retryDelaysMin: [5, 0] } }).some((e) => e.includes('recovery.retryDelaysMin')));
  assert.ok(at({ recovery: { retryDelaysMin: 5 } }).some((e) => e.includes('recovery.retryDelaysMin')));
});

// ---- 副作用の見立て ----

const run = (over = {}) => ({
  id: 'j1', botKey: 'opus', stage: 'ended', outcome: 'failed', reason: 'failed(API Error: 529)', stageDetail: 'API Error: 529',
  stopKind: null, modelResult: 'failed', spawn: { pid: 1, at: iso(T0 - minutes(59)), runtime: 'claude' },
  evidence: { hooks: true, traceReadable: true, toolCalls: 0, gitChanged: false }, endedAt: iso(T0 - minutes(30)),
  ...over,
});

test('classifySideEffects: 起動前は none、起動後は軌跡 0 件 + git 差分なしだけ none-observed、それ以外は unknown', () => {
  assert.equal(classifySideEffects(run({ spawn: null, modelResult: null, outcome: 'internal-error' })), 'none');
  assert.equal(classifySideEffects(run()), 'none-observed');
  assert.equal(classifySideEffects(run({ evidence: { hooks: true, traceReadable: true, toolCalls: 3, gitChanged: false } })), 'unknown');
  assert.equal(classifySideEffects(run({ evidence: { hooks: true, traceReadable: true, toolCalls: 0, gitChanged: true } })), 'unknown');
  // hooks が無い / trace が読めない = 「何もしなかった」とは言えない
  assert.equal(classifySideEffects(run({ evidence: { hooks: false, traceReadable: null, toolCalls: null, gitChanged: false } })), 'unknown');
  assert.equal(classifySideEffects(run({ evidence: { hooks: true, traceReadable: false, toolCalls: 0, gitChanged: false } })), 'unknown');
  assert.equal(classifySideEffects(run({ evidence: null })), 'unknown');
  assert.equal(classifySideEffects(run({ outcome: 'not-started', stageDetail: 'role-unreadable', spawn: null })), 'config');
  assert.equal(classifySideEffects(run({ outcome: 'deliver-failed', modelResult: 'ok' })), 'delivered-model');
  assert.equal(classifySideEffects(run({ outcome: 'verify-failed', modelResult: 'ok' })), 'delivered-model');
  assert.equal(classifySideEffects(null), 'unknown');
});

// ---- planRecovery ----

const task = (over = {}) => ({ id: '77', channel: 'kt', state: 'in-progress', threadId: 'T77', jobsSpent: 3, jobBudget: 20, ...over });
const stalled = (r = run()) => ({ status: 'recovery-wait', reason: '実行失敗', since: T0 - minutes(30), waitedMs: minutes(30), next: 'recovery', run: r });
const CONFIG = { mode: 'auto', graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] };
const plan = (over = {}) => planRecovery({
  task: task(), status: stalled(), config: CONFIG, recovery: null, paused: false, backoffUntil: 0,
  dayJobsLeft: 10, jobRunsHealthy: true, taskKind: 'board', now: T0, ...over,
});

test('planRecovery: 副作用なしの失敗は間隔を過ぎていれば retry、まだなら schedule (最も遅い開始可能時刻)', () => {
  const now = plan();
  assert.equal(now.action, 'retry');
  assert.match(now.reason, /自動再試行 1 回目 \(復旧待ち \/ 副作用なし\)/);
  assert.ok(RECOVERY_ACTIONS.includes(now.action));
  // 終了から 2 分しか経っていない → 5 分後に予定
  const soon = plan({ status: stalled(run({ endedAt: iso(T0 - minutes(2)) })) });
  assert.equal(soon.action, 'schedule');
  assert.equal(soon.nextAt, T0 + minutes(3));
  // 2 回目は 15 分
  const second = plan({ status: stalled(run({ endedAt: iso(T0 - minutes(10)) })), recovery: { autoCount: 1, nextAutoAt: null } });
  assert.equal(second.action, 'schedule');
  assert.equal(second.nextAt, T0 + minutes(5));
  assert.match(second.reason, /2 回目/);
  // バックオフが最も遅ければそれを採る
  const backoff = plan({ backoffUntil: T0 + minutes(40) });
  assert.equal(backoff.action, 'schedule');
  assert.equal(backoff.nextAt, T0 + minutes(40));
  // 猶予が間隔より長ければ猶予
  const grace = plan({ config: { ...CONFIG, graceMin: 60, retryDelaysMin: [1] } });
  assert.equal(grace.action, 'schedule');
  assert.equal(grace.nextAt, T0 + minutes(30));
});

test('planRecovery: 観測 mode は起こさず「自動なら今起こす」を返し、off は判定しない', () => {
  const observe = plan({ config: { ...CONFIG, mode: 'observe' } });
  assert.equal(observe.action, 'observe');
  assert.match(observe.reason, /\[観測\] 自動なら今起こす/);
  const off = plan({ config: { ...CONFIG, mode: 'off' } });
  assert.equal(off.action, 'none');
  // 予定は観測 mode でも立てる (時刻が来ても起こさない)
  assert.equal(plan({ config: { ...CONFIG, mode: 'observe' }, status: stalled(run({ endedAt: iso(T0 - minutes(1)) })) }).action, 'schedule');
});

test('planRecovery: 副作用が始まっていても・verify NG・配送失敗・再起動やタイムアウトの中断も、作業ツリーの続きとして起こす', () => {
  // 2026-10-07 まではどれも observe (手動 /retry) だった。#87 (実行エラー) が 1 か月止まったのはここ
  const unknown = plan({ status: stalled(run({ evidence: { hooks: true, traceReadable: true, toolCalls: 4, gitChanged: true } })) });
  assert.equal(unknown.action, 'retry');
  assert.equal(unknown.safety, 'unknown');
  assert.match(unknown.reason, /作業ツリーの続きから/);
  const verifyNg = plan({ status: stalled(run({ outcome: 'verify-failed', modelResult: 'ok' })) });
  assert.equal(verifyNg.safety, 'delivered-model');
  assert.equal(verifyNg.action, 'retry');
  assert.equal(plan({ status: stalled(run({ outcome: 'deliver-failed', modelResult: 'ok' })) }).action, 'retry');
  // 実行中のタイムアウト (failed + stopKind timeout) は復旧待ちとして来る
  assert.equal(plan({ status: stalled(run({ stopKind: 'timeout' })) }).action, 'retry');
  // 再起動で切れた job は「中断」として来る
  const shutdown = plan({ status: { ...stalled(run({ outcome: 'aborted', stopKind: 'shutdown' })), status: 'stopped', stopKind: 'shutdown' } });
  assert.equal(shutdown.action, 'retry');
  assert.match(shutdown.reason, /中断 \(shutdown\)/);
  // 起動前の内部エラー (Discord の transcript 取得失敗など) は none
  const before = plan({ status: stalled(run({ spawn: null, modelResult: null, outcome: 'internal-error', evidence: null })) });
  assert.equal(before.action, 'retry');
  assert.equal(before.safety, 'none');
});

test('planRecovery: 人間の /stop と設定の不備だけは自動で起こさない', () => {
  const human = plan({ status: { ...stalled(run({ outcome: 'aborted', stopKind: 'human' })), status: 'stopped', stopKind: 'human' } });
  assert.equal(human.action, 'none');
  assert.match(human.reason, /人間の停止/);
  // 停止前に人間が止めた (stopped-before-start) も同じ
  assert.equal(plan({ status: { ...stalled(run({ outcome: 'stopped', stopKind: 'human', spawn: null })), status: 'stopped' } }).action, 'none');
  const config = plan({ status: stalled(run({ outcome: 'not-started', stageDetail: 'role-unreadable', spawn: null })) });
  assert.equal(config.action, 'observe');
  assert.match(config.reason, /設定・契約の不備/);
});

test('planRecovery: 要照合は起こす側に照合を任せて retry、実行記録が 1 件も無いタスクは状態に入った時刻から数える', () => {
  // 前プロセスの job が要照合 (子が残っていないかは /retry と同じ入口の livenessOf が見る)
  const reconciling = plan({ status: { ...stalled(run({ stage: 'reconcile', outcome: null, endedAt: null, observedAt: iso(T0 - minutes(30)) })), status: 'reconcile' } });
  assert.equal(reconciling.action, 'retry');
  assert.match(reconciling.reason, /要照合/);
  // 起動メッセージが受け付けられなかった (記録 0 件) — 30 分前に in-progress へ入った
  const never = plan({ status: { status: 'reconcile', reason: '実行記録が無い', since: T0 - minutes(30), next: 'human', run: null } });
  assert.equal(never.action, 'retry');
  assert.equal(never.safety, 'unknown');
  // 入って 2 分なら猶予 (5 分) まで待つ
  const fresh = plan({ status: { status: 'reconcile', reason: '実行記録が無い', since: T0 - minutes(2), next: 'human', run: null } });
  assert.equal(fresh.action, 'schedule');
  assert.equal(fresh.nextAt, T0 + minutes(3));
});

test('planRecovery: 間隔は直前の job の終わりと直前の再開要求の遅い方から数える (送信前の失敗で枠を撃ち切らない)', () => {
  // 2026-10-06: 送信前に失敗した自動再試行は job を残さず、数週間前の終わりから数えて 1 分おきに 3 回撃った
  const weeksAgo = run({ endedAt: iso(T0 - minutes(14 * 24 * 60)) });
  const afterFailed = plan({ status: stalled(weeksAgo), recovery: { autoCount: 1, nextAutoAt: null, lastAt: iso(T0 - minutes(1)) } });
  assert.equal(afterFailed.action, 'schedule');
  assert.equal(afterFailed.nextAt, T0 - minutes(1) + minutes(15));
  assert.match(afterFailed.reason, /2 回目.*間隔 15 分/);
  // 間隔を過ぎていれば起こす
  assert.equal(plan({ status: stalled(weeksAgo), recovery: { autoCount: 1, lastAt: iso(T0 - minutes(16)) } }).action, 'retry');
  // lastAt が無い (従来の形)・読めないときは、これまでどおり job の終わりから数える
  assert.equal(plan({ status: stalled(weeksAgo), recovery: { autoCount: 1, nextAutoAt: null } }).action, 'retry');
  assert.equal(plan({ status: stalled(weeksAgo), recovery: { autoCount: 1, lastAt: null } }).action, 'retry');
  assert.equal(plan({ status: stalled(weeksAgo), recovery: { autoCount: 1, lastAt: 'いつか' } }).action, 'retry');
  // 要求の後に job が走って終わったなら、job の終わりが起点 (従来どおり)
  const ranAfter = plan({ status: stalled(run({ endedAt: iso(T0 - minutes(2)) })), recovery: { autoCount: 1, lastAt: iso(T0 - minutes(20)) } });
  assert.equal(ranAfter.nextAt, T0 - minutes(2) + minutes(15));
  // 記録 0 件の要照合 (状態に入った時刻が起点) でも同じ
  const never = { status: 'reconcile', reason: '実行記録が無い', since: T0 - minutes(14 * 24 * 60), next: 'human', run: null };
  const reconcile = plan({ status: never, recovery: { autoCount: 1, lastAt: iso(T0 - minutes(1)) } });
  assert.equal(reconcile.action, 'schedule');
  assert.equal(reconcile.nextAt, T0 - minutes(1) + minutes(15));
  assert.equal(plan({ status: never, recovery: { autoCount: 1 } }).action, 'retry');
});

test('planRecovery: 上限・pause・予算・日次予算・台帳の不信・対象外の種別で止まる', () => {
  assert.match(plan({ recovery: { autoCount: 2 } }).reason, /上限 \(2 回\)/);
  assert.equal(plan({ recovery: { autoCount: 2 } }).action, 'observe');
  assert.equal(plan({ config: { ...CONFIG, maxAutoRetries: 0 } }).action, 'observe');
  assert.match(plan({ paused: true }).reason, /停止中/);
  assert.match(plan({ task: task({ jobsSpent: 20 }) }).reason, /job 予算が残っていない/);
  assert.match(plan({ dayJobsLeft: 0 }).reason, /日次予算/);
  assert.match(plan({ dayJobsLeft: null }).reason, /日次予算/);
  const halt = plan({ jobRunsHealthy: false });
  assert.equal(halt.action, 'halt');
  assert.match(halt.reason, /制御台帳が信用できない \(job-runs\.json\)/);
  // 実行記録以外の制御台帳が読めないときも同じ (§12.3 (1))。理由に対象ファイルが入る
  const other = plan({ brokenLedgers: [{ file: 'pause.json', reason: 'JSON として読めません' }] });
  assert.equal(other.action, 'halt');
  assert.match(other.reason, /制御台帳が信用できない \(pause\.json\)/);
  assert.equal(plan({ brokenLedgers: [] }).action, 'retry', '健全なら止めない');
  assert.equal(plan({ taskKind: 'apply' }).action, 'none');
  assert.equal(plan({ taskKind: 'scout' }).action, 'none');
  // 拾うのは復旧待ち・中断・要照合だけ (返信待ち・承認待ち・走っている・blocked は対象外)
  for (const other of ['reply-wait', 'approval-wait', 'running', 'blocked', 'retry-scheduled']) {
    assert.equal(plan({ status: { ...stalled(), status: other } }).action, 'none', other);
  }
  // 復旧待ちなのに直前の記録が無いのは材料不足 (要照合だけが記録 0 件を許す)
  assert.equal(plan({ status: { ...stalled(), run: null } }).action, 'none');
  assert.equal(plan({ status: stalled(run({ endedAt: 'いつか', observedAt: null })) }).action, 'observe');
});

// ---- autoTick (配線) ----

/** 読めない pause.json を開いた本物の store (退避しないので paused 側へ倒れる) */
function brokenPauseStore(dir) {
  const file = join(dir, 'pause.json');
  writeFileSync(file, '{ 壊れた', 'utf8');
  return new PauseStore(file);
}

function harness({
  mode = 'auto', tasks, runs = [], paused = false, dayJobsLeft = 10, breakStore = false,
  breakPause = false, isApply = () => false, contracts = null, notify = null,
  available = ['opus', 'opus2', 'fable'], reissue = null, threadAs = null, reserveDayJob = null, refundDayJob = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-auto-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  for (const r of runs) {
    jobRuns.open({ id: r.id, taskId: r.taskId ?? '77', threadId: r.threadId ?? 'T77', botKey: r.botKey ?? 'opus' }, { now: r.acceptedAt });
    jobRuns.start(r.id, { now: r.startedAt });
    if (r.spawn) jobRuns.noteSpawn(r.id, { pid: r.spawn, at: r.startedAt + 1000, runtime: 'claude' });
    if (r.model) jobRuns.noteModelResult(r.id, r.model, { now: r.endedAt });
    jobRuns.finish(r.id, { reason: r.reason, now: r.endedAt, evidence: r.evidence ?? null, stopKind: r.stopKind ?? null });
  }
  if (breakStore) jobRuns.writeFailures.push({ at: iso(T0), message: 'EACCES' });
  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  const posts = [];
  const logs = [];
  const service = createRecoveryService({
    board: {
      list: ({ channel } = {}) => tasks.filter((t) => !channel || t.channel === channel),
      findByThread: (id) => tasks.find((t) => t.threadId === id) ?? null,
    },
    jobRuns,
    contracts,
    // 読めない pause.json は「停止していない」ではない (§12.3 (1))
    pauseStore: breakPause ? brokenPauseStore(dir) : { paused },
    channels: ['kt'],
    notify,
    autonomyFor: () => ({
      worker: { bots: ['opus'] }, reviewer: 'opus2', directionFile: '',
      recovery: { mode, graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] },
    }),
    now: () => T0,
    log: (l) => logs.push(l),
    recoveryStore,
    availableBotKeys: () => available,
    botUserId: (key) => ({ opus: 'O1', opus2: 'O2', fable: 'F1' })[key] ?? null,
    postAs: async (p) => { posts.push(p); },
    reissueReview: reissue,
    threadAs,
    dayJobsLeftFor: () => dayJobsLeft,
    reserveDayJob,
    refundDayJob,
    isApplyTask: isApply,
  });
  return { service, posts, logs, jobRuns, recoveryStore };
}

const safeFailure = (over = {}) => ({
  id: 'j1', acceptedAt: T0 - minutes(60), startedAt: T0 - minutes(59), endedAt: T0 - minutes(30), spawn: 4242,
  model: { ok: false, error: 'API Error: 529 Overloaded' }, reason: 'failed(API Error: 529 Overloaded)',
  evidence: { hooks: true, traceReadable: true, toolCalls: 0, gitChanged: false }, ...over,
});

test('autoTick (auto): 副作用なしの失敗を 1 回起こし、世代に auto と回数を残す。observe では起こさない', async () => {
  const auto = harness({ tasks: [task()], runs: [safeFailure()] });
  const out = await auto.service.autoTick();
  assert.deepEqual(out.decisions.map((d) => [d.taskId, d.action]), [['77', 'retry']]);
  assert.equal(auto.posts.length, 1);
  assert.match(auto.posts[0].text, /自動復旧/);
  assert.notEqual(auto.posts[0].botKey, 'opus');
  const entry = auto.recoveryStore.get('77');
  assert.equal(entry.auto.count, 1);
  assert.equal(entry.attempts[0].kind, 'auto');
  assert.equal(entry.attempts[0].result, 'sent');
  assert.ok(auto.logs.some((l) => /起こしました/.test(l)));

  const observe = harness({ mode: 'observe', tasks: [task()], runs: [safeFailure()] });
  const seen = await observe.service.autoTick();
  assert.deepEqual(seen.decisions.map((d) => d.action), ['observe']);
  assert.equal(observe.posts.length, 0);
  assert.equal(observe.recoveryStore.get('77'), null, '観測 mode で台帳を動かしている');
  assert.ok(observe.logs.some((l) => /\[観測\] 自動なら今起こす/.test(l)));
  // 同じ判断は毎 tick 書かない
  const before = observe.logs.length;
  await observe.service.autoTick();
  assert.equal(observe.logs.length, before);
});

test('autoTick: 間隔前は予定を台帳へ書き (1 回だけ)、時刻が来たら起こす。予定は状態に「再開予定」として出る', async () => {
  const h = harness({ tasks: [task()], runs: [safeFailure({ endedAt: T0 - minutes(2) })] });
  const first = await h.service.autoTick();
  assert.deepEqual(first.decisions.map((d) => d.action), ['schedule']);
  assert.equal(h.recoveryStore.recoveryOf('77').nextAutoAt, iso(T0 + minutes(3)));
  assert.equal(h.posts.length, 0);
  const scheduledLogs = h.logs.filter((l) => /予定/.test(l)).length;
  await h.service.autoTick();
  assert.equal(h.logs.filter((l) => /予定/.test(l)).length, scheduledLogs, '同じ予定を毎 tick 書き直している');
  // 状態は再開予定 (復旧待ちの一覧には出ない)
  assert.equal(h.service.statusOf(task()).status, 'retry-scheduled');
  assert.deepEqual(h.service.rows(), []);
  // 時刻が来た
  const due = await h.service.autoTick({ at: T0 + minutes(4) });
  assert.deepEqual(due.decisions.map((d) => d.action), ['retry']);
  assert.equal(h.posts.length, 1);
  assert.equal(h.recoveryStore.recoveryOf('77').nextAutoAt, null);
});

test('autoTick: 送信前に失敗した自動再試行の 1 分後の見回りでは起こさず、直前の試行から間隔を空けて予定する', async () => {
  // job の終わりは 30 分前 (猶予も 1 回目の間隔も過ぎている)。1 回目の自動再試行が 1 分前に送信前に失敗した
  const h = harness({ tasks: [task()], runs: [safeFailure()] });
  const { generation } = h.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(1) });
  h.recoveryStore.settle('77', generation, 'failed(送信できない)', { now: T0 - minutes(1) });
  const out = await h.service.autoTick();
  assert.deepEqual(out.decisions.map((d) => d.action), ['schedule']);
  assert.equal(h.posts.length, 0);
  assert.equal(h.recoveryStore.recoveryOf('77').nextAutoAt, iso(T0 + minutes(14)));
  assert.equal(h.recoveryStore.recoveryOf('77').autoCount, 1, '予定で回数を使っている');
  const due = await h.service.autoTick({ at: T0 + minutes(15) });
  assert.deepEqual(due.decisions.map((d) => d.action), ['retry']);
  assert.equal(h.posts.length, 1);
});

test('autoTick: 再起動で切れたタスクは続きから起こし、人間の /stop で止めたものは起こさない', async () => {
  const shutdown = harness({ tasks: [task()], runs: [safeFailure({ model: null, reason: 'aborted', stopKind: 'shutdown' })] });
  assert.equal(shutdown.service.statusOf(task()).status, 'stopped');
  const out = await shutdown.service.autoTick();
  assert.deepEqual(out.decisions.map((d) => d.action), ['retry']);
  assert.equal(shutdown.posts.length, 1);
  assert.match(shutdown.posts[0].text, /自動復旧/);

  const human = harness({ tasks: [task()], runs: [safeFailure({ model: null, reason: 'aborted', stopKind: 'human' })] });
  const stopped = await human.service.autoTick();
  assert.deepEqual(stopped.decisions.map((d) => d.action), ['none']);
  assert.equal(human.posts.length, 0);
});

test('autoTick: 起動メッセージが受け付けられず実行記録が 0 件のタスクを、猶予を過ぎたら担当で起こす', async () => {
  // understanding-map #91 の最初の形: scheduler が in-progress にしたが worker の job が 1 本も立たなかった
  const h = harness({ tasks: [task({ updatedAt: iso(T0 - minutes(30)) })], runs: [] });
  assert.equal(h.service.statusOf(task({ updatedAt: iso(T0 - minutes(30)) })).status, 'reconcile');
  const out = await h.service.autoTick();
  assert.deepEqual(out.decisions.map((d) => d.action), ['retry']);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].mentionUserIds, ['O1']);
});

test('autoTick: 起こし直しが断られ続けても、同じ理由のログは 1 回だけ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-auto-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  const r = safeFailure();
  jobRuns.open({ id: r.id, taskId: '77', threadId: 'T77', botKey: 'opus' }, { now: r.acceptedAt });
  jobRuns.start(r.id, { now: r.startedAt });
  jobRuns.noteSpawn(r.id, { pid: r.spawn, at: r.startedAt + 1000, runtime: 'claude' });
  jobRuns.noteModelResult(r.id, r.model, { now: r.endedAt });
  jobRuns.finish(r.id, { reason: r.reason, now: r.endedAt, evidence: r.evidence });
  const logs = [];
  const service = createRecoveryService({
    board: { list: () => [task()], findByThread: () => task() },
    jobRuns,
    // 未消費の契約が居るので /retry と同じ入口が毎回断る
    contracts: { list: () => [{ kind: 'delegation', toBotKey: 'opus' }] },
    channels: ['kt'],
    autonomyFor: () => ({ worker: { bots: ['opus'] }, reviewer: 'opus2', recovery: { mode: 'auto', graceMin: 5, maxAutoRetries: 3, retryDelaysMin: [5] } }),
    now: () => T0,
    log: (l) => logs.push(l),
    recoveryStore: new RecoveryStore(join(dir, 'recovery.json')),
    availableBotKeys: () => ['opus', 'fable'],
    botUserId: () => 'O1',
    postAs: async () => {},
    dayJobsLeftFor: () => 10,
  });
  await service.autoTick();
  await service.autoTick();
  await service.autoTick();
  assert.equal(logs.filter((l) => /起こせませんでした/.test(l)).length, 1);
});

test('autoTick: 上限に達したら復旧待ちに残す / 副作用のある失敗も起こす / 適用 task は対象外 / pause 中は起こさない', async () => {
  const capped = harness({ tasks: [task()], runs: [safeFailure()] });
  capped.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(50) });
  capped.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(40) });
  const out = await capped.service.autoTick();
  assert.equal(out.decisions[0].action, 'observe');
  assert.match(out.decisions[0].reason, /上限/);
  assert.equal(capped.posts.length, 0);
  assert.equal(capped.service.rows().length, 1, '上限超過が復旧待ちから消えている');

  // 副作用が始まっていても、同じブランチ・同じ作業ツリーの続きとして起こす (2026-10-07 まで手動だった)
  const dirty = harness({ tasks: [task()], runs: [safeFailure({ evidence: { hooks: true, traceReadable: true, toolCalls: 7, gitChanged: true } })] });
  assert.equal((await dirty.service.autoTick()).decisions[0].action, 'retry');
  assert.equal(dirty.posts.length, 1);
  assert.match(dirty.posts[0].text, /同じブランチ・同じ作業ツリーの続き/);

  const apply = harness({ tasks: [task()], runs: [safeFailure()], isApply: () => true });
  assert.equal((await apply.service.autoTick()).decisions[0].action, 'none');

  // pause 中: in-progress の復旧待ちとして判定には来るが、起こさない
  const paused = harness({ tasks: [task()], runs: [safeFailure()], paused: true });
  const p = await paused.service.autoTick();
  assert.equal(p.decisions[0].action, 'observe');
  assert.match(p.decisions[0].reason, /停止中/);
  assert.equal(paused.posts.length, 0);
});

test('autoTick: 実行記録の台帳が信用できなければ何も起こさず halt を残す', async () => {
  const h = harness({ tasks: [task()], runs: [safeFailure()], breakStore: true });
  const out = await h.service.autoTick();
  assert.equal(out.halted, true);
  assert.equal(out.decisions[0].action, 'halt');
  assert.equal(h.posts.length, 0);
  assert.ok(h.logs.some((l) => /⛔/.test(l)));
});

test('autoTick: 実行記録以外の制御台帳 (pause.json) が読めないときも halt し、理由にファイルを出す', async () => {
  const h = harness({ tasks: [task()], runs: [safeFailure()], breakPause: true });
  const out = await h.service.autoTick();
  assert.equal(out.halted, true);
  assert.equal(out.decisions[0].action, 'halt');
  assert.match(out.decisions[0].reason, /制御台帳が信用できない \(pause\.json\)/);
  assert.equal(h.posts.length, 0);
});

test('autoTick: 起こせなかった (走っている・契約が居る) ときは予定を残さない', async () => {
  const h = harness({ tasks: [task()], runs: [safeFailure()] });
  // 判定は retry だが、実体の retry が断る状況を作る: 未消費契約
  const contracts = { list: () => [{ kind: 'delegation', toBotKey: 'opus' }] };
  const dir = mkdtempSync(join(tmpdir(), 'communitd-auto-'));
  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  recoveryStore.scheduleAuto('77', { nextAt: T0 - 1 });
  const blocked = createRecoveryService({
    board: { list: () => [task()], findByThread: () => task() },
    jobRuns: h.jobRuns,
    contracts,
    channels: ['kt'],
    autonomyFor: () => ({ worker: { bots: ['opus'] }, reviewer: 'opus2', recovery: { mode: 'auto', graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] } }),
    now: () => T0,
    log: () => {},
    recoveryStore,
    availableBotKeys: () => ['opus', 'fable'],
    botUserId: () => 'O1',
    postAs: async () => {},
    dayJobsLeftFor: () => 10,
  });
  const out = await blocked.autoTick();
  // 状態は復旧待ちなので判定は retry、実体は契約で断る → 予定は消える
  assert.equal(out.decisions[0].action, 'retry');
  assert.equal(recoveryStore.recoveryOf('77').nextAutoAt, null);
  assert.equal(recoveryStore.recoveryOf('77').autoCount, 0, '起こしていないのに回数が増えている');
});

// 同じチャンネルの 2 件目 (#77) — 1 件目 (#76) の失敗で見回り全体が止まらないことを見る
const firstTask = () => task({ id: '76', threadId: 'T76' });

test('autoTick: 1 件の状態を判定できなくても、同じチャンネルの次のタスクを判定して起こす', async () => {
  const h = harness({
    tasks: [firstTask(), task()],
    runs: [safeFailure({ id: 'j0', taskId: '76', threadId: 'T76' }), safeFailure()],
  });
  // #76 の実行記録だけ読めない (statusOf が throw する)
  const forThread = h.jobRuns.forThread.bind(h.jobRuns);
  h.jobRuns.forThread = (threadId) => {
    if (threadId === 'T76') throw new Error('job-runs.json の行が壊れている');
    return forThread(threadId);
  };
  const out = await h.service.autoTick();

  assert.deepEqual(out.decisions.map((d) => [d.taskId, d.action]), [['77', 'retry']]);
  assert.ok(h.logs.includes('[recovery] #76 の状態を判定できません (自動復旧は見送り): job-runs.json の行が壊れている'), h.logs.join('\n'));
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].threadId, 'T77');
  assert.equal(h.recoveryStore.get('76'), null, '判定できないタスクの台帳を動かしている');
  assert.equal(h.recoveryStore.get('77').auto.count, 1);
});

test('autoTick: 1 件の予定を記録できなくても次のタスクの判断を続け、例外を外へ出さない。書けなかった予定は次の tick で書き直す', async () => {
  const h = harness({
    tasks: [firstTask(), task()],
    runs: [
      safeFailure({ id: 'j0', taskId: '76', threadId: 'T76', endedAt: T0 - minutes(2) }),
      safeFailure({ endedAt: T0 - minutes(2) }),
    ],
  });
  const scheduleAuto = h.recoveryStore.scheduleAuto.bind(h.recoveryStore);
  h.recoveryStore.scheduleAuto = (taskId, opts) => {
    if (taskId === '76') throw new Error('disk full');
    return scheduleAuto(taskId, opts);
  };
  const out = await h.service.autoTick();

  assert.deepEqual(out.decisions.map((d) => [d.taskId, d.action]), [['76', 'schedule'], ['77', 'schedule']]);
  assert.ok(h.logs.includes('[recovery] #76 の予定を記録できませんでした: disk full'), h.logs.join('\n'));
  assert.equal(h.recoveryStore.recoveryOf('76')?.nextAutoAt ?? null, null);
  assert.equal(h.recoveryStore.recoveryOf('77').nextAutoAt, iso(T0 + minutes(3)), '1 件目の失敗で 2 件目の予定が止まっている');
  assert.equal(h.posts.length, 0);

  // 台帳が直れば、次の tick で同じ予定を書く (書けなかった予定を「書いた」ことにしない)
  delete h.recoveryStore.scheduleAuto;
  await h.service.autoTick();
  assert.equal(h.recoveryStore.recoveryOf('76').nextAutoAt, iso(T0 + minutes(3)));
});

// ---- 自動復旧が起こさない・起こせなかった理由を、復旧待ちの行と停滞の通知に出す ----
// 見回り (sweep) は自動復旧 (autoTick) より先に走る (src/bridge/scheduler.js) ので、試験も同じ順で回す。
// 起動後の最初の見回りは 🛟 を 1 周待たせるので、「動いている最中に止まった」場面は boot で 1 周回してから
// タスクを載せる

const collect = () => {
  const notices = [];
  return { notices, notify: async (p) => { notices.push(p); return true; } };
};

/** 自動の上限 (2 回) を使い切った復旧待ち */
function cappedHarness(over = {}) {
  const h = harness({ tasks: [task()], runs: [safeFailure()], ...over });
  h.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(50) });
  h.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(40) });
  return h;
}

/** 起動後の 1 周 (止まったタスクがまだ無い) を本番の順で回す */
async function boot(h) {
  await h.service.sweep();
  await h.service.autoTick();
}

test('上限に達したタスクは、/inbox・/status の行と停滞の通知の理由の先頭に上限が出て、通知の出し直しは 1 回だけ', async () => {
  const { notices, notify } = collect();
  const tasks = [];
  const h = cappedHarness({ notify, tasks });
  await boot(h);
  tasks.push(task()); // 動いている最中に止まった (人間の /retry の後の job も失敗した、など)
  await h.service.sweep();
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0].text, /上限/, '判断の前の通知に上限が載っている');
  await h.service.autoTick();

  const [row] = h.service.rows();
  assert.match(row.status.reason, /^自動復旧: 自動再試行の上限 \(2 回\) に達した/);
  assert.doesNotMatch(h.service.statusOf(task()).reason, /自動復旧/, '判断の材料 (statusOf) に表示の前置きが混ざった');
  // /status は理由を 60 字で切る — 前置きが状態名の直後に切られずに残る
  const status = formatStatus(summarizeStatus({ channelName: 'kt', tasks: [task()], statusOf: (t) => h.service.displayStatusOf(t), now: T0 }));
  assert.match(status, /\(復旧待ち: 自動復旧: 自動再試行の上限 \(2 回\) に達した/);

  await h.service.sweep();
  assert.equal(notices.length, 2, '自動が諦めたのに出し直していない');
  assert.match(notices[1].text, /理由: 自動復旧: 自動再試行の上限 \(2 回\) に達した/);
  assert.match(notices[1].text, /出し直しました/);
  for (let i = 0; i < 3; i += 1) {
    await h.service.autoTick();
    await h.service.sweep();
  }
  assert.equal(notices.length, 2, '同じ問題で出し直しを撒いている');
});

test('再起動直後 (sweep → autoTick → sweep): 上限に達したタスクの 🛟 は判断を載せた 1 通だけ', async () => {
  const { notices, notify } = collect();
  const h = cappedHarness({ notify });
  const first = await h.service.sweep();
  assert.equal(first.held, true);
  assert.equal(first.rows.length, 1);
  assert.equal(notices.length, 0, '判断の前に 🛟 を出している (後で出し直しが 2 通目になる)');
  await h.service.autoTick();
  await h.service.sweep();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /理由: 自動復旧: 自動再試行の上限 \(2 回\) に達した/);
  assert.doesNotMatch(notices[0].text, /出し直しました/);
  for (let i = 0; i < 3; i += 1) {
    await h.service.autoTick();
    await h.service.sweep();
  }
  assert.equal(notices.length, 1, '再起動直後の上限のタスクに 2 通出している');
});

test('起動後に待たせるのは最初の見回りの 1 周だけ (autoTick が回らなくても次の見回りでは出す)', async () => {
  const { notices, notify } = collect();
  const h = cappedHarness({ notify });
  assert.equal((await h.service.sweep()).held, true);
  // 受付停止中などで autoTick が回らなかった
  const second = await h.service.sweep();
  assert.notEqual(second.held, true);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0].text, /理由: 自動復旧/);
});

test('送信前に断られた理由を行と通知に出し、断りの文言が tick ごとに変わっても出し直しは 1 回。起こせたら前置きは消える', async () => {
  const { notices, notify } = collect();
  let toBotKey = 'opus';
  const tasks = [];
  const h = harness({
    tasks, runs: [safeFailure()], notify,
    // 未消費の契約が居るので /retry と同じ入口が送信前に断る (宛先を変えると断りの文言が変わる)
    contracts: { list: () => (toBotKey ? [{ kind: 'delegation', toBotKey }] : []) },
  });
  await boot(h);
  tasks.push(task());
  await h.service.sweep();
  assert.equal(notices.length, 1);
  await h.service.autoTick();
  assert.equal(h.posts.length, 0);
  assert.match(h.service.rows()[0].status.reason, /^自動復旧: 起こせなかった — #77 には未消費の契約が .* → opus\)/);
  await h.service.sweep();
  assert.equal(notices.length, 2);
  assert.match(notices[1].text, /理由: 自動復旧: 起こせなかった — #77 には未消費の契約/);

  for (const key of ['fable', 'opus2']) {
    toBotKey = key;
    await h.service.autoTick();
    assert.match(h.service.rows()[0].status.reason, new RegExp(`→ ${key}\\)`), '最新の断りに更新されていない');
    await h.service.sweep();
  }
  assert.equal(notices.length, 2, '断りの文言が変わるたびに撒いている');

  toBotKey = null;
  await h.service.autoTick();
  assert.equal(h.posts.length, 1);
  for (const r of h.service.rows()) assert.doesNotMatch(r.status.reason, /自動復旧/, '起こせたのに前の断りが残っている');
});

test('世代を確保した後に投げ手が居ない・スレッドを取れないと断られたら、何も送らず行に「起こせなかった — 理由」を出し、予定を消して日次予算の予約を 1 本戻す', async () => {
  const cases = [
    {
      name: 'reviewer: 担当以外の bot が居ない', state: 'review', available: ['opus2'],
      threadAs: async () => ({ bot: { key: 'fable' }, thread: { id: 'T77' } }),
      reason: 'レビュー担当 opus2 を呼べる bot が居ません (担当自身からは起こせません)', result: 'failed(投げ手なし)',
    },
    {
      name: 'reviewer: 投げ手のスレッドを取れない', state: 'review',
      threadAs: async () => { throw new Error('Missing Access'); },
      reason: 'opus からスレッドを取得できません: Missing Access', result: 'failed(Missing Access)',
    },
    {
      name: 'worker: 担当以外の bot が居ない', state: 'in-progress', available: ['opus'],
      reason: '担当 opus を呼べる bot が居ません (担当自身からは起こせません)', result: 'failed(投げ手なし)',
    },
  ];
  for (const c of cases) {
    const reissued = [];
    const reserved = [];
    const refunded = [];
    const h = harness({
      tasks: [task({ state: c.state })], runs: [safeFailure()], available: c.available, threadAs: c.threadAs ?? null,
      reissue: async (p) => { reissued.push(p); return { ok: true, reason: '出し直しました' }; },
      reserveDayJob: (channel, opts) => { reserved.push([channel, opts]); return true; },
      refundDayJob: (channel, opts) => { refunded.push([channel, opts]); },
    });
    // 時刻の来た予定が残っている (起こせなかったのに残すと「再開予定」のまま止まる)
    h.recoveryStore.scheduleAuto('77', { nextAt: T0 - 1 });
    const out = await h.service.autoTick();
    assert.deepEqual(out.decisions.map((d) => [d.taskId, d.action]), [['77', 'retry']], c.name);
    assert.equal(h.posts.length, 0, c.name);
    assert.equal(reissued.length, 0, c.name);
    // 送信の前に断られたので、予約した 1 本をそのまま戻す
    assert.deepEqual(reserved, [['kt', { at: T0 }]], c.name);
    assert.deepEqual(refunded, [['kt', { at: T0 }]], c.name);
    assert.equal(h.recoveryStore.recoveryOf('77').nextAutoAt, null, c.name);
    // 世代は確保した後に断るので、台帳には failed(理由) と自動の回数が残る (次の試行は間隔を空けて予定する)
    const entry = h.recoveryStore.get('77');
    assert.equal(entry.attempts.length, 1, c.name);
    assert.equal(entry.attempts[0].kind, 'auto', c.name);
    assert.equal(entry.attempts[0].result, c.result, c.name);
    assert.equal(entry.auto.count, 1, c.name);
    // 人に見えるもの: 復旧待ちの行の理由の先頭とログ
    const [row] = h.service.rows();
    assert.ok(row, `復旧待ちの行に出ていない (${c.name})`);
    assert.ok(row.status.reason.startsWith(`自動復旧: 起こせなかった — ${c.reason} / `), `${c.name}: ${row.status.reason}`);
    assert.ok(h.logs.some((l) => l.startsWith('[recovery] #77: 自動再試行 1 回目') && l.endsWith(`— 起こせませんでした (${c.reason})`)), `${c.name}: ${h.logs.join(' | ')}`);
  }
});

test('止まり直した (別の job で止まった) 行には前の判断を付けず、新しい問題として通知する', async () => {
  const { notices, notify } = collect();
  const h = cappedHarness({ notify });
  await h.service.sweep();
  await h.service.autoTick();
  await h.service.sweep();
  assert.equal(notices.length, 1);
  assert.match(h.service.rows()[0].status.reason, /^自動復旧: /);
  // 人間の /retry の後の job も失敗した (自動の判断はまだ下りていない)
  const r2 = safeFailure({ id: 'j2', acceptedAt: T0 - minutes(20), startedAt: T0 - minutes(19), endedAt: T0 - minutes(10) });
  h.jobRuns.open({ id: r2.id, taskId: '77', threadId: 'T77', botKey: 'opus' }, { now: r2.acceptedAt });
  h.jobRuns.start(r2.id, { now: r2.startedAt });
  h.jobRuns.finish(r2.id, { reason: r2.reason, now: r2.endedAt, evidence: r2.evidence });
  assert.doesNotMatch(h.service.rows()[0].status.reason, /自動復旧/);
  await h.service.sweep();
  assert.equal(notices.length, 2);
  assert.doesNotMatch(notices[1].text, /理由: 自動復旧|出し直しました/);
});

test('観測 mode と pause 中は理由を行に出すが、停滞の通知は出し直さない', async () => {
  for (const over of [{ mode: 'observe' }, { paused: true }]) {
    const { notices, notify } = collect();
    const tasks = [];
    const h = harness({ tasks, runs: [safeFailure()], notify, ...over });
    await boot(h);
    tasks.push(task());
    await h.service.sweep();
    assert.equal(notices.length, 1, JSON.stringify(over));
    await h.service.autoTick();
    assert.match(h.service.rows()[0].status.reason, over.paused ? /^自動復旧: 自律運転が停止中/ : /^自動復旧: \[観測\] 自動なら今起こす/);
    await h.service.sweep();
    assert.equal(notices.length, 1, JSON.stringify(over));
  }
});

// ---- 自動の経路を本物の `/review` の実体まで通す (bridge/recovery.js + bridge/board.js) ----
// 上の autoTick の試験は reissueReview を配線しないので、渡す引数の形 (スレッドと投げ手) は見ていない

test('autoTick: review で止まったタスクは、投げ手の client から取った本物のスレッドで `/review` の実体へ渡り reviewer を召喚する', async (t) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  const dir = mkdtempSync(join(tmpdir(), 'communitd-auto-review-'));
  const config = {
    channels: { kt: { cwd: dir, autonomy: { enabled: true, worker: { bots: ['opus'] }, reviewer: 'opus2', baseBranch: 'master' } } },
  };
  // bot ごとに別のスレッドの実体を持たせる (どの client から投稿したかを見分ける)。
  // cache には居ないので fetch で取る形 (再起動後に初めて触るスレッド)
  const threads = new Map();
  const botEntry = (key, userId) => {
    const thread = {
      id: 'T1', archived: false, isThread: () => true, parent: { name: 'kt' }, sent: [],
      send: async (payload) => { thread.sent.push(payload); return { id: `${key}-m${thread.sent.length}` }; },
    };
    threads.set(key, thread);
    const client = { channels: { cache: new Map(), fetch: async (id) => (id === 'T1' ? thread : null) } };
    return [key, { key, userId, cfg: { displayName: key }, client }];
  };
  const bots = new Map([botEntry('opus', 'O1'), botEntry('opus2', 'O2'), botEntry('fable', 'F1')]);

  // 着手 → review へ出したが、reviewer の job が 1 本も立たなかったタスク
  const board = new TaskBoardStore(join(dir, 'tasks.json'));
  const task = board.propose({ channel: 'kt', title: 'lint', rationale: '理由', touch: ['a.py'], jobBudget: 20 }, { by: 'opus' });
  board.approve(task.id, { by: 'fable' });
  board.start(task.id, { threadId: 'T1', by: 'scheduler' });
  board.submitForReview(task.id, { by: 'opus' });

  const contracts = new ContractStore(join(dir, 'contracts.json'));
  const hops = new HopTracker(12, 3);
  const pauseStore = { paused: false };
  const discord = createDiscordWiring({ config, bots });
  const boardWiring = createBoardWiring({
    root: dir, board, bots, contracts, hops, pauseStore, proposals: null, notifyDutyEvent: async () => {},
    setContractKindOverride: () => {}, claimContractKindOverride: () => null, contractCwd: (cc) => cc.cwd,
    channelConfigFor: discord.channelConfigFor, safeProposalContext: () => null, releaseApplyWorktree: async () => '',
  });
  // 直す前の自動の経路が渡していた形 (`{id}` だけ) は、親チャンネルが無いので本物の実体に断られる
  const bare = await boardWiring.reissueReview({ thread: { id: 'T1' }, id: null, bot: bots.get('fable') });
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /未登録/);

  const recoveryStore = new RecoveryStore(join(dir, 'recovery.json'));
  const tickStates = new Map();
  const recovery = createRecoveryWiring({
    config, board, jobRuns: new JobRunStore(join(dir, 'job-runs.json')), contracts, pauseStore,
    autonomyChannels: ['kt'], tickStates, saveTickState: (name, state) => tickStates.set(name, state),
    postToThread: async () => true, reissueReview: (args) => boardWiring.reissueReview(args),
    recoveryStore, jobs: new JobQueue(), hops, bots, proposals: null,
  });
  const out = await recovery.autoTick({ at: Date.now() + minutes(120) });
  assert.deepEqual(out.decisions.map((d) => [String(d.taskId), d.action]), [[String(task.id), 'retry']]);

  // 制御メンションは reviewer 以外の 1 体の client から、reviewer 宛に 1 通だけ
  const posted = [...threads.entries()].filter(([, th]) => th.sent.length > 0);
  assert.equal(posted.length, 1, `投稿した client: ${posted.map(([key]) => key).join(', ')}`);
  const [announcer, thread] = posted[0];
  assert.notEqual(announcer, 'opus2', 'reviewer 自身の client から呼んでいる');
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].content, /^<@O2>/);
  // 本物の実体が task-review 契約を投げ手で束縛して積んだ
  const pending = contracts.list('T1', 'opus2');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'task-review');
  assert.equal(pending[0].fromBotKey, announcer);
  // 台帳には自動の世代として送信済みで残る
  const attempt = recoveryStore.get(String(task.id)).attempts[0];
  assert.equal(attempt.kind, 'auto');
  assert.equal(attempt.target, 'reviewer');
  assert.equal(attempt.result, 'sent');
  assert.equal(attempt.by, 'auto');
});

// ---- 停滞の通知 (🛟) の出し先を本物の postToThread まで通す (bridge/recovery.js + bridge/discord.js) ----

test('sweep: タスクのスレッドが archive されていたら、🛟 を親チャンネルへ 1 回だけ落とす (毎 tick 送り直さない)', async (t) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  const dir = mkdtempSync(join(tmpdir(), 'communitd-archived-notice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    channels: { kt: { cwd: dir, autonomy: { enabled: true, worker: { bots: ['opus'] }, reviewer: 'opus2', baseBranch: 'master' } } },
  };
  const thread = {
    id: 'T1', archived: true, parentId: 'C-kt', isThread: () => true,
    send: async () => { throw new Error('archive されたスレッドへ送った'); },
  };
  const parent = {
    id: 'C-kt', sent: [], isThread: () => false,
    send: async (payload) => { parent.sent.push(payload); return { id: `p${parent.sent.length}` }; },
  };
  const client = { channels: { cache: new Map(), fetch: async (id) => ({ T1: thread, 'C-kt': parent })[id] ?? null } };
  const bots = new Map([['opus', { key: 'opus', userId: 'O1', cfg: { displayName: 'opus' }, client }]]);

  // review へ出したが reviewer の job が 1 本も立たなかったタスク (何日も動かずスレッドが archive された)
  const board = new TaskBoardStore(join(dir, 'tasks.json'));
  const task = board.propose({ channel: 'kt', title: 'lint', rationale: '理由', touch: ['a.py'], jobBudget: 20 }, { by: 'opus' });
  board.approve(task.id, { by: 'fable' });
  board.start(task.id, { threadId: 'T1', by: 'scheduler' });
  board.submitForReview(task.id, { by: 'opus' });

  const discord = createDiscordWiring({ config, bots });
  const tickStates = new Map();
  const recovery = createRecoveryWiring({
    config, board, jobRuns: new JobRunStore(join(dir, 'job-runs.json')), contracts: new ContractStore(join(dir, 'contracts.json')),
    pauseStore: { paused: false }, autonomyChannels: ['kt'], tickStates,
    saveTickState: (name, state) => tickStates.set(name, state), postToThread: discord.postToThread,
    reissueReview: async () => ({ ok: false, reason: '試験では呼ばない' }),
    recoveryStore: null, jobs: new JobQueue(), hops: new HopTracker(12, 3), bots, proposals: null,
  });
  const at = Date.now() + minutes(120);
  const first = await recovery.sweep({ at });
  assert.equal(first.notified.length, 1);
  assert.equal(parent.sent.length, 1);
  assert.match(
    parent.sent[0].content,
    new RegExp(`^🛟 タスク #${task.id} は[^\\n]*\\n#${task.id} のスレッド <#T1> は archive されているのでこちらへ`),
  );
  // 先頭が 🛟 = 運用メッセージ (INFRA_PREFIXES) として親チャンネルの文脈から外れる
  assert.ok(
    INFRA_PREFIXES.some((p) => parent.sent[0].content.startsWith(p)),
    '親へ落とした 🛟 が運用メッセージとして見分けられない',
  );
  // 届いたので次の tick では送り直さない (直す前は false が返り、毎 tick 同じ 🛟 をログに出して送り直していた)
  const second = await recovery.sweep({ at: at + minutes(1) });
  assert.deepEqual(second.notified, []);
  assert.equal(parent.sent.length, 1);
});
