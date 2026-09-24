import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chargeJobs, initialState, jobsLeftToday, persistedState, planTick, refundJobs, restoreState } from '../src/scheduler.js';

// 自動復旧の日次予算は通常の着手と同じ勘定 `jobsToday` (レビュー指摘 2026-09-05)

const T0 = Date.parse('2026-09-05T03:00:00.000Z'); // 12:00 JST
const NEXT_DAY = Date.parse('2026-09-05T15:30:00.000Z'); // 翌 0:30 JST

test('jobsLeftToday は日付を繰り越してから残を数える', () => {
  const state = { ...initialState(), dayKey: '2026-09-05', jobsToday: 38 };
  assert.deepEqual(jobsLeftToday(state, { maxJobsPerDay: 40, now: T0 }).left, 2);
  assert.equal(jobsLeftToday({ ...state, jobsToday: 40 }, { maxJobsPerDay: 40, now: T0 }).left, 0);
  assert.equal(jobsLeftToday({ ...state, jobsToday: 45 }, { maxJobsPerDay: 40, now: T0 }).left, 0, '負にしない');
  // 日が変わっていれば 0 から
  const rolled = jobsLeftToday(state, { maxJobsPerDay: 40, now: NEXT_DAY });
  assert.equal(rolled.left, 40);
  assert.equal(rolled.state.dayKey, '2026-09-06');
  assert.equal(rolled.state.jobsToday, 0);
  // 壊れた state・上限未指定でも落ちない (既定 40)
  assert.equal(jobsLeftToday(null, { now: T0 }).left, 40);
  assert.equal(jobsLeftToday({}, { maxJobsPerDay: 'x', now: T0 }).left, 40);
});

test('chargeJobs / refundJobs は jobsToday だけを動かし、引数を変えず、日付を繰り越す', () => {
  const state = { ...initialState(), dayKey: '2026-09-05', jobsToday: 3, lastScoutAt: 123, backoffUntil: 999 };
  const charged = chargeJobs(state, { now: T0 });
  assert.equal(charged.jobsToday, 4);
  assert.equal(state.jobsToday, 3, '引数を変えている');
  assert.equal(charged.lastScoutAt, 123);
  assert.equal(charged.backoffUntil, 999, 'バックオフに触っている');
  assert.equal(chargeJobs(state, { now: T0, count: 3 }).jobsToday, 6);
  assert.equal(chargeJobs(state, { now: T0, count: 0 }).jobsToday, 4, '0 以下は 1 として扱う');
  const refunded = refundJobs(charged, { now: T0 });
  assert.equal(refunded.jobsToday, 3);
  assert.equal(refundJobs({ ...state, jobsToday: 0 }, { now: T0 }).jobsToday, 0, '負にしない');
  // 日付が変わった予約は新しい日の 1 本目
  const tomorrow = chargeJobs(state, { now: NEXT_DAY });
  assert.equal(tomorrow.dayKey, '2026-09-06');
  assert.equal(tomorrow.jobsToday, 1);
});

test('予約した分は planTick の日次上限に効き、永続化にも載る (再起動で消えない)', () => {
  const autonomy = {
    enabled: true, maxJobsPerDay: 2, maxConcurrentTasks: 2, worker: { bots: ['opus'] }, reviewer: 'opus2',
    scout: { bot: null }, taskJobBudget: 20,
  };
  const tasks = [
    { id: '1', state: 'approved' }, { id: '2', state: 'approved' }, { id: '3', state: 'approved' },
  ];
  const fresh = planTick({ tasks, autonomy, now: T0, state: initialState() });
  assert.equal(fresh.actions.length, 2, '上限 2 で 2 件');
  // 自動復旧が 1 本予約した後は 1 件しか起こせない
  const reserved = chargeJobs(initialState(), { now: T0 });
  const after = planTick({ tasks, autonomy, now: T0, state: reserved });
  assert.equal(after.actions.length, 1);
  assert.equal(after.state.jobsToday, 2);
  // persistedState → restoreState を通しても jobsToday は残る
  assert.equal(restoreState(persistedState(reserved)).jobsToday, 1);
});
