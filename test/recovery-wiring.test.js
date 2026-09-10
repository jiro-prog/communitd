import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecoveryService, stallKey, stallNoticeText } from '../src/recovery-wiring.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();

const task = (over = {}) => ({
  id: '77', channel: 'kt', title: 'lint', state: 'in-progress', threadId: 'T77',
  createdAt: iso(T0 - minutes(600)), updatedAt: iso(T0 - minutes(60)),
  history: [{ at: iso(T0 - minutes(60)), from: 'approved', to: 'in-progress', by: 'scheduler' }],
  ...over,
});
const endedRun = (over = {}) => ({
  id: 'j1', taskId: '77', threadId: 'T77', botKey: 'opus', stage: 'ended',
  acceptedAt: iso(T0 - minutes(58)), startedAt: iso(T0 - minutes(58)), endedAt: iso(T0 - minutes(30)),
  observedAt: iso(T0 - minutes(30)), outcome: 'verify-failed', reason: 'verify-failed', next: 'recovery',
  handoff: null, stopKind: null, stageDetail: '', ...over,
});

function harness({ tasks, runsByThread = {}, contracts = {}, notify = null, paused = false } = {}) {
  const notices = [];
  const logs = [];
  const service = createRecoveryService({
    board: { list: ({ channel } = {}) => tasks.filter((t) => !channel || t.channel === channel) },
    jobRuns: { forThread: (id) => runsByThread[id] ?? [] },
    contracts: { list: (threadId, key) => contracts[`${threadId}:${key}`] ?? [] },
    pauseStore: { paused },
    channels: ['kt'],
    autonomyFor: () => ({ worker: { bots: ['opus'] }, reviewer: 'opus2' }),
    backoffUntilFor: () => 0,
    notify: notify ?? (async (p) => { notices.push(p); return true; }),
    log: (line) => logs.push(line),
    now: () => T0,
  });
  return { service, notices, logs };
}

test('board か jobRuns が無ければ組み立てない', () => {
  assert.throws(() => createRecoveryService({ board: null, jobRuns: {} }), /board と jobRuns/);
});

test('statusOf は実行記録・契約・pause を集めて判定する', () => {
  const { service } = harness({
    tasks: [task({ state: 'review' })],
    runsByThread: { T77: [endedRun({ next: 'reviewer', endedAt: iso(T0 - minutes(20)) })] },
    contracts: { 'T77:opus2': [{ kind: 'task-review' }] },
  });
  const status = service.statusOf(task({ state: 'review' }));
  assert.equal(status.status, 'recovery-wait');
  assert.match(status.reason, /契約は未消費/);
  const idle = harness({ tasks: [task({ state: 'approved' })], paused: true });
  assert.equal(idle.service.statusOf(task({ state: 'approved' })).status, 'paused');
});

test('sweep は復旧待ちを同じ問題につき 1 回だけ通知し、解消したら記録を捨てる', async () => {
  const runs = { T77: [endedRun()] };
  const h = harness({ tasks: [task(), task({ id: '78', threadId: 'T78', state: 'approved' })], runsByThread: runs });
  const first = await h.service.sweep();
  assert.equal(first.rows.length, 1);
  assert.deepEqual(first.notified, [stallKey(first.rows[0])]);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].task.id, '77');
  assert.match(h.notices[0].text, /🛟 タスク #77 は\*\*復旧待ち\*\*です \(経過 30m\)/);
  assert.match(h.notices[0].text, /理由: verify NG のまま止まっている \(opus\)/);
  assert.match(h.notices[0].text, /次の操作: スレッドで `\/retry`/);
  assert.match(h.notices[0].text, /1 回だけ/);

  // 2 回目の tick では撒かない
  const second = await h.service.sweep();
  assert.deepEqual(second.notified, []);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.service.notifiedKeys(), ['77:recovery-wait:j1']);

  // 仕事が動き出した (live な job が居る) → 一覧から消え、記録も捨てる
  runs.T77 = [endedRun(), { ...endedRun({ id: 'j2' }), stage: 'model', endedAt: null, outcome: null, next: null }];
  const third = await h.service.sweep();
  assert.equal(third.rows.length, 0);
  assert.deepEqual(h.service.notifiedKeys(), []);

  // 別の job で止まり直したら別の問題として 1 回出す
  runs.T77 = [endedRun(), endedRun({ id: 'j2', outcome: 'failed', endedAt: iso(T0 - minutes(1)) })];
  const fourth = await h.service.sweep({ at: T0 + minutes(10) });
  assert.deepEqual(fourth.notified, ['77:recovery-wait:j2']);
});

test('通知に失敗したら記録せず、次の tick でもう一度だけ試す', async () => {
  let fail = true;
  const h = harness({
    tasks: [task()],
    runsByThread: { T77: [endedRun()] },
    notify: async () => { if (fail) throw new Error('Unknown Channel'); return true; },
  });
  const first = await h.service.sweep();
  assert.deepEqual(first.notified, []);
  assert.ok(h.logs.some((l) => /通知に失敗/.test(l)));
  fail = false;
  const second = await h.service.sweep();
  assert.equal(second.notified.length, 1);
  // notify が false を返したときも同じ (送れていない)
  const h2 = harness({ tasks: [task()], runsByThread: { T77: [endedRun()] }, notify: async () => false });
  assert.deepEqual((await h2.service.sweep()).notified, []);
});

test('rows はチャンネルで絞れ、走っている・待っているタスクは載せない', () => {
  const h = harness({
    tasks: [
      task(),
      task({ id: '78', threadId: 'T78' }),
      task({ id: '79', threadId: 'T79', channel: 'other' }),
    ],
    runsByThread: {
      T77: [endedRun()],
      T78: [{ ...endedRun({ id: 'live' }), stage: 'model', endedAt: null, outcome: null, next: null }],
      T79: [endedRun({ threadId: 'T79', taskId: '79' })],
    },
  });
  assert.deepEqual(h.service.rows({ channel: 'kt' }).map((r) => r.task.id), ['77']);
  assert.deepEqual(h.service.rows().map((r) => r.task.id).sort(), ['77', '79']);
  assert.deepEqual(h.service.rows({ excludeThreadIds: ['T77'] }).map((r) => r.task.id), ['79']);
});

test('stallNoticeText は次の操作が無い状態でも落ちない', () => {
  const text = stallNoticeText({ task: { id: '1' }, status: { status: 'unknown', reason: 'x', since: null } }, { now: T0 });
  assert.match(text, /経過\?/);
  assert.ok(!/次の操作/.test(text));
});
