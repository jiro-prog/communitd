import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RECOVERY_ACTIONS, RecoveryStore, classifySideEffects, planRecovery } from '../src/recovery.js';
import { createRecoveryService } from '../src/recovery-wiring.js';
import { JobRunStore } from '../src/jobruns.js';
import { PauseStore } from '../src/store.js';
import {
  AUTONOMY_RECOVERY_KEYS,
  DEFAULT_RECOVERY_MODE,
  RECOVERY_MODES,
  resolveAutonomy,
  validateAutonomy,
} from '../src/config.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();

// ---- 設定 (§11.4) ----

test('autonomy.recovery は既定 observe / 5 分 / 2 回 / [5, 15] で、書けば上書きできる', () => {
  const def = resolveAutonomy({ autonomy: { enabled: true } }).recovery;
  assert.deepEqual(def, { mode: 'observe', graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] });
  assert.equal(DEFAULT_RECOVERY_MODE, 'observe');
  const custom = resolveAutonomy({
    autonomy: { recovery: { mode: 'auto', graceMin: 10, maxAutoRetries: 0, retryDelaysMin: [1, 2, 3] } },
  }).recovery;
  assert.deepEqual(custom, { mode: 'auto', graceMin: 10, maxAutoRetries: 0, retryDelaysMin: [1, 2, 3] });
  // 読めない値は既定へ (検証は別に落とす)
  assert.equal(resolveAutonomy({ autonomy: { recovery: { mode: 'yes' } } }).recovery.mode, 'observe');
  assert.deepEqual(resolveAutonomy({ autonomy: { recovery: { retryDelaysMin: [] } } }).recovery.retryDelaysMin, [5, 15]);
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
  assert.match(now.reason, /自動再試行 1 回目 \(副作用なし: none-observed\)/);
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

test('planRecovery: 副作用が否定できない・設定の不備・配送失敗・意図的停止は自動で起こさない', () => {
  const unknown = plan({ status: stalled(run({ evidence: { hooks: true, traceReadable: true, toolCalls: 4, gitChanged: true } })) });
  assert.equal(unknown.action, 'observe');
  assert.match(unknown.reason, /副作用が始まっている可能性/);
  assert.equal(plan({ status: stalled(run({ outcome: 'verify-failed', modelResult: 'ok' })) }).safety, 'delivered-model');
  const delivered = plan({ status: stalled(run({ outcome: 'deliver-failed', modelResult: 'ok' })) });
  assert.equal(delivered.action, 'observe');
  assert.match(delivered.reason, /成功したモデル実行を繰り返さない/);
  const config = plan({ status: stalled(run({ outcome: 'not-started', stageDetail: 'role-unreadable', spawn: null })) });
  assert.equal(config.action, 'observe');
  assert.match(config.reason, /設定・契約の不備/);
  assert.equal(plan({ status: stalled(run({ stopKind: 'timeout' })) }).action, 'none');
  assert.equal(plan({ status: stalled(run({ stopKind: 'shutdown' })) }).action, 'none');
  // 起動前の内部エラー (Discord の transcript 取得失敗など) は none = 安全
  const before = plan({ status: stalled(run({ spawn: null, modelResult: null, outcome: 'internal-error', evidence: null })) });
  assert.equal(before.action, 'retry');
  assert.equal(before.safety, 'none');
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
  assert.equal(plan({ status: { ...stalled(), status: 'reconcile' } }).action, 'none');
  assert.equal(plan({ status: { ...stalled(), status: 'stopped' } }).action, 'none');
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
  breakPause = false, isApply = () => false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-auto-'));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  for (const r of runs) {
    jobRuns.open({ id: r.id, taskId: r.taskId ?? '77', threadId: r.threadId ?? 'T77', botKey: r.botKey ?? 'opus' }, { now: r.acceptedAt });
    jobRuns.start(r.id, { now: r.startedAt });
    if (r.spawn) jobRuns.noteSpawn(r.id, { pid: r.spawn, at: r.startedAt + 1000, runtime: 'claude' });
    if (r.model) jobRuns.noteModelResult(r.id, r.model, { now: r.endedAt });
    jobRuns.finish(r.id, { reason: r.reason, now: r.endedAt, evidence: r.evidence ?? null });
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
    // 読めない pause.json は「停止していない」ではない (§12.3 (1))
    pauseStore: breakPause ? brokenPauseStore(dir) : { paused },
    channels: ['kt'],
    autonomyFor: () => ({
      worker: { bots: ['opus'] }, reviewer: 'opus2', directionFile: '',
      recovery: { mode, graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] },
    }),
    now: () => T0,
    log: (l) => logs.push(l),
    recoveryStore,
    availableBotKeys: () => ['opus', 'opus2', 'fable'],
    botUserId: (key) => ({ opus: 'O1', opus2: 'O2', fable: 'F1' })[key] ?? null,
    postAs: async (p) => { posts.push(p); },
    dayJobsLeftFor: () => dayJobsLeft,
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

test('autoTick: 上限に達したら復旧待ちに残す / 副作用のある失敗は手動へ / 適用 task は対象外 / pause 中は起こさない', async () => {
  const capped = harness({ tasks: [task()], runs: [safeFailure()] });
  capped.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(50) });
  capped.recoveryStore.begin('77', { kind: 'auto', now: T0 - minutes(40) });
  const out = await capped.service.autoTick();
  assert.equal(out.decisions[0].action, 'observe');
  assert.match(out.decisions[0].reason, /上限/);
  assert.equal(capped.posts.length, 0);
  assert.equal(capped.service.rows().length, 1, '上限超過が復旧待ちから消えている');

  const dirty = harness({ tasks: [task()], runs: [safeFailure({ evidence: { hooks: true, traceReadable: true, toolCalls: 7, gitChanged: true } })] });
  assert.equal((await dirty.service.autoTick()).decisions[0].action, 'observe');
  assert.equal(dirty.posts.length, 0);

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
