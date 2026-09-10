import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_GRACE_MS,
  RECOVERY_STATUSES,
  TASK_STATUS,
  deriveTaskStatus,
  nextOperationFor,
  recoveryRows,
  recoveryReason,
  stageLabel,
  statusLabel,
} from '../src/taskstatus.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();

const task = (over = {}) => ({
  id: '77',
  channel: 'kumamikan-tools',
  title: 'doc_path_lint に死活検査を足す',
  state: 'in-progress',
  threadId: 'T77',
  jobsSpent: 1,
  jobBudget: 20,
  createdAt: iso(T0 - minutes(600)),
  updatedAt: iso(T0 - minutes(60)),
  history: [
    { at: iso(T0 - minutes(600)), from: null, to: 'proposed', by: 'opus' },
    { at: iso(T0 - minutes(590)), from: 'proposed', to: 'approved', by: 'opus2' },
    { at: iso(T0 - minutes(60)), from: 'approved', to: 'in-progress', by: 'scheduler' },
  ],
  ...over,
});

/** 終わった job の記録 */
const ended = (over = {}) => ({
  id: 'j1',
  taskId: '77',
  threadId: 'T77',
  botKey: 'opus',
  stage: 'ended',
  acceptedAt: iso(T0 - minutes(58)),
  startedAt: iso(T0 - minutes(58)),
  endedAt: iso(T0 - minutes(30)),
  observedAt: iso(T0 - minutes(30)),
  outcome: 'ok',
  reason: 'ok',
  stopKind: null,
  next: 'human',
  handoff: null,
  stageDetail: '',
  spawn: { pid: 1, at: iso(T0 - minutes(58)), runtime: 'claude' },
  ...over,
});

const live = (over = {}) => ended({ id: 'j2', stage: 'model', endedAt: null, outcome: null, next: null, ...over });

test('語彙は閉じている', () => {
  for (const s of RECOVERY_STATUSES) assert.ok(TASK_STATUS.includes(s));
  for (const s of TASK_STATUS) assert.ok(statusLabel(s) !== '?' && statusLabel(s) !== '');
  assert.equal(stageLabel('model'), 'モデル実行中');
  assert.equal(stageLabel('nope'), 'nope');
});

test('終端・blocked・着手待ちはそれぞれの語で返す (pause / backoff は着手待ちの理由)', () => {
  assert.equal(deriveTaskStatus({ task: task({ state: 'merged' }), now: T0 }).status, 'done');
  assert.equal(deriveTaskStatus({ task: task({ state: 'dropped' }), now: T0 }).status, 'done');
  const blocked = deriveTaskStatus({
    task: task({ state: 'blocked', history: [{ at: iso(T0 - minutes(5)), from: 'review', to: 'blocked', note: '差し戻し 2 回目 — 理由\n詳細' }] }),
    now: T0,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, '差し戻し 2 回目 — 理由');
  assert.equal(blocked.waitedMs, minutes(5));
  assert.equal(blocked.next, 'human');

  const approved = task({ state: 'approved' });
  assert.equal(deriveTaskStatus({ task: approved, now: T0 }).status, 'open');
  assert.equal(deriveTaskStatus({ task: approved, now: T0, paused: true }).status, 'paused');
  const backoff = deriveTaskStatus({ task: approved, now: T0, backoffUntil: T0 + minutes(10) });
  assert.equal(backoff.status, 'backoff');
  assert.match(backoff.reason, /10 分後/);
  assert.equal(deriveTaskStatus({ task: approved, now: T0, backoffUntil: T0 - 1 }).status, 'open');
  assert.equal(deriveTaskStatus({ task: null, now: T0 }).status, 'unknown');
});

test('走っている・レーン待ち・承認待ちを停滞と誤判定しない', () => {
  const running = deriveTaskStatus({ task: task(), runs: [ended(), live()], now: T0 });
  assert.equal(running.status, 'running');
  assert.match(running.reason, /opus の job が走っている \(モデル実行中\)/);
  assert.equal(running.run.id, 'j2');
  assert.equal(running.next, 'bot');

  const queued = deriveTaskStatus({ task: task(), runs: [live({ stage: 'queued', startedAt: null })], now: T0 });
  assert.equal(queued.status, 'queued');

  const approval = deriveTaskStatus({ task: task(), runs: [live({ stage: 'approval', stageDetail: 'WebFetch' })], now: T0 });
  assert.equal(approval.status, 'approval-wait');
  assert.match(approval.reason, /WebFetch/);
  assert.equal(approval.next, 'human');

  // 長いモデル思考 (観測が古いだけ) でも live なら実行中 — trace が増えないことで失敗にしない
  const quiet = deriveTaskStatus({
    task: task(), runs: [live({ startedAt: iso(T0 - minutes(120)), observedAt: iso(T0 - minutes(119)) })], now: T0,
  });
  assert.equal(quiet.status, 'running');
  assert.equal(quiet.waitedMs, minutes(120));
});

test('#77 型: verify NG で止まった in-progress は復旧待ち', () => {
  const s = deriveTaskStatus({
    task: task(),
    runs: [ended({ outcome: 'verify-failed', reason: 'verify-failed', next: 'recovery' })],
    now: T0,
  });
  assert.equal(s.status, 'recovery-wait');
  assert.match(s.reason, /verify NG のまま止まっている \(opus\)/);
  assert.equal(s.waitedMs, minutes(30));
  assert.equal(s.next, 'recovery');
  assert.equal(nextOperationFor(s), 'スレッドで `/retry`');
  // 実行失敗・配送失敗・内部エラー・起動失敗も同じ側
  for (const [outcome, detail, pattern] of [
    ['failed', 'API Error: 529 Overloaded', /実行失敗: API Error: 529 Overloaded/],
    ['deliver-failed', '', /配送に失敗/],
    ['internal-error', '', /内部エラー/],
    ['not-started', 'role-unreadable', /起動できなかった: role-unreadable/],
  ]) {
    const st = deriveTaskStatus({ task: task(), runs: [ended({ outcome, next: 'recovery', stageDetail: detail })], now: T0 });
    assert.equal(st.status, 'recovery-wait', outcome);
    assert.match(st.reason, pattern);
  }
  assert.match(recoveryReason({ outcome: 'zzz', botKey: 'x' }), /zzz/);
});

test('人間の返信待ち・質問待ちは停滞ではない', () => {
  const report = deriveTaskStatus({ task: task(), runs: [ended({ next: 'human' })], now: T0 });
  assert.equal(report.status, 'reply-wait');
  assert.match(report.reason, /報告に人間の返信待ち/);
  const asked = deriveTaskStatus({
    task: task(), runs: [ended({ next: 'human', handoff: { toBotKey: null, kind: 'notify' } })], now: T0,
  });
  assert.equal(asked.status, 'reply-wait');
  assert.match(asked.reason, /質問に人間の返信待ち/);
  assert.equal(nextOperationFor(asked), 'スレッドに返信');
});

test('人間の /stop と再起動の中断は「停止」で、自動では起こさない側', () => {
  const human = deriveTaskStatus({
    task: task(), runs: [ended({ outcome: 'aborted', reason: 'aborted', stopKind: 'human', next: 'human' })], now: T0,
  });
  assert.equal(human.status, 'stopped');
  assert.equal(human.stopKind, 'human');
  assert.match(human.reason, /人間の \/stop/);
  const shutdown = deriveTaskStatus({
    task: task(), runs: [ended({ outcome: 'cancelled', reason: 'cancelled', stopKind: 'shutdown', next: 'human' })], now: T0,
  });
  assert.equal(shutdown.status, 'stopped');
  assert.equal(shutdown.stopKind, 'shutdown');
  assert.match(shutdown.reason, /再起動/);
  assert.ok(RECOVERY_STATUSES.includes('stopped'), '停止した仕事が一覧から消える');
});

test('handoff の直後は起動待ち、猶予を過ぎたら復旧待ち', () => {
  const runs = [ended({ next: 'bot', handoff: { toBotKey: 'opus2', kind: 'handoff' }, endedAt: iso(T0 - minutes(2)) })];
  const fresh = deriveTaskStatus({ task: task(), runs, now: T0 });
  assert.equal(fresh.status, 'handoff-wait');
  assert.match(fresh.reason, /opus2 を呼んだ直後/);
  const stale = deriveTaskStatus({ task: task(), runs, now: T0 + DEFAULT_GRACE_MS });
  assert.equal(stale.status, 'recovery-wait');
  assert.match(stale.reason, /opus2 を呼んだが job が起動していない/);
  // 猶予は調整できる
  assert.equal(deriveTaskStatus({ task: task(), runs, now: T0, graceMs: minutes(1) }).status, 'recovery-wait');
});

test('review: レビュー担当の起動待ちは猶予内なら待ち、過ぎたら契約の有無で理由を分ける', () => {
  const review = task({ state: 'review' });
  const runs = [ended({ next: 'reviewer', endedAt: iso(T0 - minutes(1)) })];
  assert.equal(deriveTaskStatus({ task: review, runs, now: T0 }).status, 'review-wait');
  const late = T0 + minutes(10);
  const withContract = deriveTaskStatus({
    task: review, runs, now: late, pendingContracts: [{ kind: 'task-review' }],
  });
  assert.equal(withContract.status, 'recovery-wait');
  assert.match(withContract.reason, /契約は未消費/);
  const without = deriveTaskStatus({ task: review, runs, now: late });
  assert.equal(without.status, 'recovery-wait');
  assert.match(without.reason, /`\/review` で出し直す/);
});

test('#46 型: review のまま reviewer の job が判定を適用せずに終わっていたら復旧待ち', () => {
  const review = task({ state: 'review' });
  const runs = [ended({ id: 'w' , next: 'reviewer' }), ended({ id: 'r', botKey: 'opus2', next: 'human', acceptedAt: iso(T0 - minutes(20)), endedAt: iso(T0 - minutes(10)) })];
  const s = deriveTaskStatus({ task: review, runs, now: T0, reviewerKey: 'opus2' });
  assert.equal(s.status, 'recovery-wait');
  assert.match(s.reason, /判定が適用されていない/);
  // reviewer を知らない呼び出しでは返信待ちのまま (誤判定より見逃しを選ぶ)
  assert.equal(deriveTaskStatus({ task: review, runs, now: T0 }).status, 'reply-wait');
});

test('実行記録が無い in-progress は、直後なら起動待ち・過ぎたら要照合 (走っていないと決めない)', () => {
  const justStarted = task({ history: [{ at: iso(T0 - minutes(1)), from: 'approved', to: 'in-progress', by: 'scheduler' }] });
  assert.equal(deriveTaskStatus({ task: justStarted, runs: [], now: T0 }).status, 'handoff-wait');
  const old = deriveTaskStatus({ task: task(), runs: [], now: T0 });
  assert.equal(old.status, 'reconcile');
  assert.match(old.reason, /実行記録が無い/);
  assert.equal(old.waitedMs, minutes(60));
  assert.equal(old.next, 'human');
  assert.match(nextOperationFor(old), /子プロセス/);
});

test('前プロセスの要照合記録があるタスクは reconcile (段階を添える)', () => {
  const s = deriveTaskStatus({
    task: task(),
    runs: [ended(), { ...live({ id: 'j9' }), stage: 'reconcile', reconcile: { at: iso(T0 - minutes(3)), fromStage: 'model' } }],
    now: T0,
  });
  assert.equal(s.status, 'reconcile');
  assert.match(s.reason, /段階 モデル実行中/);
  assert.equal(s.waitedMs, minutes(3));
  assert.equal(s.run.id, 'j9');
});

test('自動再試行の予定があれば再開予定 (復旧待ちには出さない)', () => {
  const s = deriveTaskStatus({
    task: task(),
    runs: [ended({ outcome: 'failed', next: 'recovery' })],
    recovery: { nextAutoAt: T0 + minutes(4), autoCount: 1, lastAt: iso(T0 - minutes(1)) },
    now: T0,
  });
  assert.equal(s.status, 'retry-scheduled');
  assert.match(s.reason, /自動再試行 2 回目を予定 \(4 分後\)/);
  // 予定時刻を過ぎていたら復旧の判断へ戻る
  const due = deriveTaskStatus({
    task: task(), runs: [ended({ outcome: 'failed', next: 'recovery' })],
    recovery: { nextAutoAt: T0 - 1, autoCount: 1 }, now: T0,
  });
  assert.equal(due.status, 'recovery-wait');
});

test('直前の job の結果が unknown なら要照合', () => {
  const s = deriveTaskStatus({ task: task(), runs: [ended({ outcome: 'unknown', next: 'unknown' })], now: T0 });
  assert.equal(s.status, 'reconcile');
});

test('recoveryRows は in-progress / review の復旧待ちだけを長く待たせている順に並べ、停止・質問と重ねない', () => {
  const tasks = [
    task({ id: '1', threadId: 'A' }),                           // 記録なし・60 分 → reconcile
    task({ id: '2', threadId: 'B' }),                           // verify NG 30 分 → recovery-wait
    task({ id: '3', threadId: 'C' }),                           // 走っている → 載せない
    task({ id: '4', threadId: 'D' }),                           // 停止・質問に載っている → 重ねない
    task({ id: '5', threadId: 'E', state: 'approved' }),        // 着手待ち → 対象外
    task({ id: '6', threadId: 'F', state: 'blocked' }),         // 要人間の節 → 対象外
  ];
  const runsByThread = {
    B: [ended({ threadId: 'B', outcome: 'verify-failed', next: 'recovery' })],
    C: [live({ threadId: 'C' })],
    D: [ended({ threadId: 'D', outcome: 'failed', next: 'recovery' })],
  };
  const rows = recoveryRows(tasks, (t) => deriveTaskStatus({ task: t, runs: runsByThread[t.threadId] ?? [], now: T0 }), {
    excludeThreadIds: ['D'],
  });
  assert.deepEqual(rows.map((r) => [r.task.id, r.status.status]), [['1', 'reconcile'], ['2', 'recovery-wait']]);
  // 判定が投げても一覧は出る (その行は要照合として)
  const broken = recoveryRows([task({ id: '9' })], () => { throw new Error('boom'); });
  assert.equal(broken[0].status.status, 'reconcile');
  assert.match(broken[0].status.reason, /boom/);
});
