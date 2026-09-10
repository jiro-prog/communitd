import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RETRY_TARGETS, RecoveryStore, planRetry, retryMessage } from '../src/recovery.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;
const iso = (ms) => new Date(ms).toISOString();

const task = (over = {}) => ({
  id: '77', channel: 'kt', title: 'lint', state: 'in-progress', threadId: 'T77', branch: 'task/77',
  jobsSpent: 3, jobBudget: 20, ...over,
});
const stalled = (over = {}) => ({
  status: 'recovery-wait', reason: 'verify NG のまま止まっている (opus)', since: T0 - minutes(30), waitedMs: minutes(30),
  next: 'recovery', run: { id: 'j1', botKey: 'opus', outcome: 'verify-failed', endedAt: iso(T0 - minutes(30)), spawn: { pid: 4242 } },
  ...over,
});
const base = (over = {}) => ({
  task: task(), status: stalled(), workerKeys: ['opus'], reviewerKey: 'opus2', availableBotKeys: ['opus', 'opus2', 'fable'],
  ...over,
});

test('planRetry: in-progress の復旧待ちは worker を呼び直す (残り予算を添える)', () => {
  const plan = planRetry(base());
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'worker');
  assert.equal(plan.workerKey, 'opus');
  assert.match(plan.reason, /#77 は in-progress — 担当 opus を同じスレッド・同じブランチの続きとして呼び直します \(残り job 予算 17\)/);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.previous.id, 'j1');
  assert.equal(plan.previous.outcome, 'verify-failed');
  assert.ok(RETRY_TARGETS.includes(plan.target));
});

test('planRetry: review はレビュー担当へ (共通の /review 判定へつなぐ)', () => {
  const plan = planRetry(base({ task: task({ state: 'review' }), status: stalled({ reason: 'レビュー契約が無い' }) }));
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'reviewer');
  assert.match(plan.reason, /opus2/);
  assert.equal(planRetry(base({ task: task({ state: 'review' }), reviewerKey: null })).ok, false);
});

test('planRetry: 対象が決まらない・終わっている・blocked・着手前は断る (理由に次の操作)', () => {
  assert.match(planRetry(base({ task: null })).reason, /対応するタスクがありません/);
  assert.match(planRetry(base({ id: '78' })).reason, /このスレッドのタスクは #77 です/);
  assert.equal(planRetry(base({ id: ' 77 ' })).ok, true, 'id の空白を落としていない');
  assert.match(planRetry(base({ task: task({ state: 'merged' }) })).reason, /終わった仕事は起こしません/);
  const blocked = planRetry(base({ task: task({ state: 'blocked' }) }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /`\/retry` では解消しません/);
  assert.match(planRetry(base({ task: task({ state: 'approved' }) })).reason, /着手はスケジューラが起こします/);
  assert.match(planRetry(base({ task: task({ state: 'approved' }), paused: true })).reason, /`\/resume`/);
});

test('planRetry: pause 中・進行中の再開・走っている job・猶予内の起動待ちは断る', () => {
  assert.match(planRetry(base({ paused: true })).reason, /自律運転が停止中/);
  assert.match(planRetry(base({ inFlight: true })).reason, /連打しても 1 回だけ/);
  assert.match(planRetry(base({ liveJob: true })).reason, /起こし直しません/);
  for (const status of ['running', 'queued', 'approval-wait']) {
    const plan = planRetry(base({ status: stalled({ status, reason: '走っている' }) }));
    assert.equal(plan.ok, false, status);
  }
  const waiting = planRetry(base({ status: stalled({ status: 'handoff-wait', reason: 'opus を呼んだ直後' }) }));
  assert.equal(waiting.ok, false);
  assert.match(waiting.reason, /猶予 \(5 分\) を過ぎても動かなければ/);
});

test('planRetry: 未消費の契約があるときは起こし直さない (受け手の起動待ち)', () => {
  const plan = planRetry(base({ pendingContracts: [{ kind: 'task-review', toBotKey: 'opus2' }] }));
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /未消費の契約が 1 件あります \(task-review → opus2\)/);
});

test('planRetry: 要照合は子プロセスの生存を否定できるまで起こさない (unknown は gone ではない)', () => {
  const reconcile = stalled({ status: 'reconcile', reason: '前プロセスの job の結末が記録されていない' });
  assert.match(planRetry(base({ status: reconcile, liveness: 'alive' })).reason, /pid 4242\) が\*\*まだ生きています\*\*/);
  assert.match(planRetry(base({ status: reconcile, liveness: 'unknown' })).reason, /生存を確かめられません/);
  const gone = planRetry(base({ status: reconcile, liveness: 'gone' }));
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.warnings, []);
  // 記録に pid が無い (導入前の job) → 通すが警告を付ける
  const noPid = planRetry(base({ status: { ...reconcile, run: null }, liveness: null }));
  assert.equal(noPid.ok, true);
  assert.equal(noPid.warnings.length, 1);
  assert.match(noPid.warnings[0], /残っていないことは確認できていません/);
  assert.equal(noPid.previous, null);
});

test('planRetry: 予算は増やさない — 台帳の残 0 と門番の 0 を区別して断る', () => {
  const spent = planRetry(base({ task: task({ jobsSpent: 20, jobBudget: 20 }) }));
  assert.equal(spent.ok, false);
  assert.match(spent.reason, /job 予算が残っていません \(消費 20 \/ 20\)/);
  assert.match(spent.reason, /勝手に増やしません/);
  const gate = planRetry(base({ hopBudget: 0 }));
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /門番では 0 です \(台帳 残 17\)/);
  // 門番が無い (null) なら台帳だけで見る
  assert.equal(planRetry(base({ hopBudget: null })).ok, true);
});

test('planRetry: 担当が起動していなければ断る / 人間の停止・返信待ちは明示の再開として通す', () => {
  assert.match(planRetry(base({ availableBotKeys: ['fable'] })).reason, /担当 \(opus\) が起動していません/);
  assert.equal(planRetry(base({ status: stalled({ status: 'stopped', reason: '人間の /stop で中断 (opus)' }) })).ok, true);
  assert.equal(planRetry(base({ status: stalled({ status: 'reply-wait', reason: '報告に人間の返信待ち' }) })).ok, true);
});

test('retryMessage は 1 行目が <@id> で、前回の状態と約束を載せる (1900 字以内)', () => {
  const text = retryMessage({
    task: task(), botUserId: 'O1', attempt: 2,
    previous: { outcome: 'verify-failed', reason: 'verify NG のまま止まっている (opus)', endedAt: iso(T0 - minutes(30)) },
    remaining: 17, directionFile: '.communitd/direction.md', gitChanged: true, lastActivity: 'Edit lint.py',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '<@O1>');
  assert.match(text, /## 再開 — タスク 77: lint \(試行 2\)/);
  assert.match(text, /- 終わり方: verify-failed — verify NG のまま止まっている \(opus\)/);
  assert.match(text, /- 最後に観測できた活動: Edit lint\.py/);
  assert.match(text, /前回の変更が残っている/);
  assert.match(text, /ブランチ `task\/77` のまま続ける/);
  assert.match(text, /残り job 予算: 17 job/);
  assert.match(text, /\.communitd\/direction\.md/);
  assert.match(text, /制御フッタを書かない/);
  assert.ok(text.length <= 1900);
  // 記録なし・自動
  const bare = retryMessage({ task: task({ branch: null }), botUserId: 'O1', kind: 'auto', gitChanged: false });
  assert.match(bare, /自動復旧/);
  assert.match(bare, /実行記録が無い/);
  assert.match(bare, /`task\/77`/);
  assert.match(bare, /残り job 予算: 不明/);
  assert.match(bare, /前回の変更は見えない/);
  // 長すぎる題は切る
  const long = retryMessage({ task: task({ title: 'あ'.repeat(3000) }), botUserId: 'O1' });
  assert.ok(long.length <= 1900);
});

// ---- RecoveryStore ----

const storePath = () => join(mkdtempSync(join(tmpdir(), 'communitd-recovery-')), 'recovery.json');

test('RecoveryStore: begin は世代を進めて記録し、settle が結果を書く。再読込で残る', () => {
  const path = storePath();
  const s = new RecoveryStore(path);
  assert.equal(s.get('77'), null);
  assert.equal(s.recoveryOf('77'), null);
  const first = s.begin('77', { by: 'U1', target: 'worker', previousRunId: 'j1', now: T0 });
  assert.equal(first.generation, 1);
  assert.equal(first.entry.attempts[0].result, 'pending');
  assert.equal(first.entry.attempts[0].kind, 'manual');
  s.settle('77', 1, 'started', { now: T0 + 1 });
  const second = s.begin('77', { by: 'U1', target: 'worker', now: T0 + minutes(10) });
  assert.equal(second.generation, 2);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw['77'].attempts[0].result, 'started');
  assert.equal(raw['77'].attempts[1].result, 'pending');
  assert.equal(new RecoveryStore(path).get('77').generation, 2);
  assert.throws(() => s.begin(''), /taskId/);
  assert.equal(s.settle('999', 1, 'x'), null);
});

test('RecoveryStore: 自動の回数と次回時刻は begin(auto) と scheduleAuto で動き、手動では増えない', () => {
  const s = new RecoveryStore(storePath());
  s.scheduleAuto('77', { nextAt: T0 + minutes(5), reason: 'failed', now: T0 });
  assert.deepEqual(s.recoveryOf('77'), { nextAutoAt: iso(T0 + minutes(5)), autoCount: 0, lastAt: null, generation: 0 });
  const auto = s.begin('77', { kind: 'auto', target: 'worker', now: T0 + minutes(5) });
  assert.equal(auto.entry.auto.count, 1);
  assert.equal(auto.entry.auto.nextAt, null, '始めたら予定は消える');
  assert.equal(s.recoveryOf('77').lastAt, iso(T0 + minutes(5)));
  s.scheduleAuto('77', { nextAt: T0 + minutes(20), now: T0 + minutes(6) });
  s.begin('77', { kind: 'manual', by: 'U1', now: T0 + minutes(7) });
  assert.equal(s.get('77').auto.count, 1, '手動の再開で自動の回数が動いている');
  assert.equal(s.get('77').auto.nextAt, null, '手動で起こしたのに自動の予定が残っている');
  s.scheduleAuto('77', { nextAt: T0 + minutes(30) });
  s.cancelAuto('77');
  assert.equal(s.get('77').auto.nextAt, null);
  assert.equal(s.cancelAuto('999'), null);
  assert.throws(() => s.scheduleAuto('77', { nextAt: 'いつか' }), /時刻/);
});
