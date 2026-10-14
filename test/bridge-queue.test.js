import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobQueueWiring } from '../src/bridge/queue.js';
import { createRunRecorder } from '../src/bridge/recorder.js';
import { createLifecycle } from '../src/interactions.js';
import { JobRunStore } from '../src/jobruns.js';
import { JobQueue } from '../src/queue.js';

// src/bridge/queue.js — cwd レーン単位のキューと job の起動の配線。
// 実行記録 (JobRunStore) とキュー (JobQueue) は本物、job の中身 (item.run) だけを偽物にする。

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

function harness(t, { maxConcurrent = 0, society = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
  const jobs = new JobQueue({ maxConcurrent });
  const lifecycle = createLifecycle();
  const outcomes = [];
  const wiring = createJobQueueWiring({
    jobs,
    lifecycle,
    jobRuns,
    runRecorder: createRunRecorder({ jobRuns }),
    noteAutonomyOutcome: (item, reason) => outcomes.push([item.jobId, reason]),
    society,
  });
  return { jobRuns, jobs, lifecycle, outcomes, ...wiring };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** 受付済みの item (実行記録は open 済み — 受付点と同じ手順) */
function item(jobRuns, id, run, over = {}) {
  jobRuns.open({ id, threadId: 'T1', botKey: 'opus', channelName: 'kt' });
  return {
    jobId: id, enqueuedAt: Date.now(), laneKey: 'lane-a', threadId: 'T1', botKey: 'opus',
    channelName: 'kt', run, ...over,
  };
}

test('runItem は開始と終端を実行記録へ書き、成否を勘定へ返し、計測ログを 1 行出す', async (t) => {
  const { logs } = captureConsole(t);
  const h = harness(t);
  const seen = {};
  h.enqueue(item(h.jobRuns, 'j1', async (metrics, recorder, outcome) => {
    // 走り出した時点で start が記録されている (queueWait と run の境目)
    seen.stageAtRun = h.jobRuns.get('j1').stage;
    recorder.stage('model');
    metrics.toolCalls = 3;
    metrics.verifyPassed = 1;
    outcome.handoff = { toBotKey: 'fable', kind: 'handoff' };
    outcome.taskState = 'review';
    outcome.taskSubmitted = true;
    outcome.gitChanged = false;
    outcome.traceReadable = true;
    outcome.hooks = true;
    metrics.verifyMs = 1234;
    metrics.verifyAttempts = 1;
    metrics.inputTokens = 12;
    metrics.cacheReadTokens = 45000;
    metrics.cacheWriteTokens = 0;
    metrics.outputTokens = 800;
    // ここから先は Date.now を呼ぶたびに 1 秒進める — runMs を記録とログで別々に測ると秒がずれる
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + (ticks += 1000);
    t.after(() => { Date.now = realNow; });
    return 'ok';
  }));
  await settle();

  assert.equal(seen.stageAtRun, 'starting');
  const record = h.jobRuns.get('j1');
  assert.equal(record.stage, 'ended');
  assert.equal(record.reason, 'ok');
  assert.ok(record.startedAt && record.endedAt, '開始と終端の時刻が無い');
  assert.deepEqual(record.handoff, { toBotKey: 'fable', kind: 'handoff' });
  assert.equal(record.evidence.toolCalls, 3);
  assert.equal(record.evidence.verified, true);
  assert.equal(record.evidence.gitChanged, false);
  assert.equal(record.evidence.traceReadable, true);
  assert.equal(record.evidence.hooks, true);
  // job の重さ: 所要・verify の合計と試行回数・トークン 4 種 (0 は取れた値として残す)
  assert.ok(Number.isSafeInteger(record.evidence.runMs) && record.evidence.runMs >= 1000, `runMs: ${record.evidence.runMs}`);
  assert.equal(record.evidence.verifyMs, 1234);
  assert.equal(record.evidence.verifyAttempts, 1, '1 回で通った verify');
  assert.deepEqual(record.evidence.tokens, { input: 12, cacheRead: 45000, cacheWrite: 0, output: 800 });
  // ファイルへ書いて読み直しても残る
  assert.deepEqual(new JobRunStore(h.jobRuns.filePath).get('j1').evidence, record.evidence);
  assert.deepEqual(h.outcomes, [['j1', 'ok']]);
  assert.equal(h.jobs.activeCount, 0, 'レーンが解放されていない');
  const metricsLine = logs.find((l) => l.startsWith('[job j1 opus thread:T1]'));
  assert.ok(metricsLine, '計測ログが出ていない');
  assert.match(metricsLine, /queueWait \d+(\.\d+)?s \/ run \d+(\.\d+)?s/);
  assert.match(metricsLine, /tools 3 件/);
  // 計測ログの run は記録の runMs と同じ値
  assert.ok(metricsLine.includes(` / run ${(record.evidence.runMs / 1000).toFixed(1)}s / `), metricsLine);
  assert.match(metricsLine, / \/ ok$/);
});

test('run が返さなければ ok、throw すれば internal-error として終端し、レーンは解放される', async (t) => {
  const { errors } = captureConsole(t);
  const h = harness(t);
  h.enqueue(item(h.jobRuns, 'j2', async () => undefined));
  h.enqueue(item(h.jobRuns, 'j3', async () => { throw new Error('boom'); }, { laneKey: 'lane-b' }));
  await settle();

  assert.equal(h.jobRuns.get('j2').reason, 'ok');
  assert.equal(h.jobRuns.get('j3').reason, 'internal-error');
  assert.equal(h.jobRuns.get('j3').stage, 'ended');
  assert.ok(errors.some((e) => e.includes('[job j3 opus thread:T1] job error')), errors.join('\n'));
  assert.deepEqual(h.outcomes.sort(), [['j2', 'ok'], ['j3', 'internal-error']]);
  assert.equal(h.jobs.activeCount, 0);
});

test('verify の結果は evidence.verified へ 3 値 (true / false / null) で写し、取れない verifyMs・verifyAttempts・tokens は null', async (t) => {
  captureConsole(t);
  const h = harness(t);
  // usage を返さないランタイムの verify NG (Stop hook の差し戻しを 1 回挟んで最終 NG)
  h.enqueue(item(h.jobRuns, 'v1', async (metrics) => {
    metrics.verifyPassed = 0;
    metrics.verifyMs = 500;
    metrics.verifyAttempts = 2;
    return 'verify-failed';
  }));
  h.enqueue(item(h.jobRuns, 'v2', async () => 'ok', { laneKey: 'lane-b' }));
  // 一部だけ取れた usage は器を残し、数えられない値 (負・小数) だけ null
  h.enqueue(item(h.jobRuns, 'v3', async (metrics) => {
    metrics.inputTokens = 7;
    metrics.cacheReadTokens = -1;
    metrics.outputTokens = 1.5;
    return 'ok';
  }, { laneKey: 'lane-c' }));
  // 数えられない試行回数 (0・小数・文字列) は null — 1 以上の整数だけを回数として残す
  const badAttempts = { v4: 0, v5: 1.5, v6: '2' };
  for (const [id, value] of Object.entries(badAttempts)) {
    h.enqueue(item(h.jobRuns, id, async (metrics) => {
      metrics.verifyPassed = 1;
      metrics.verifyAttempts = value;
      return 'ok';
    }, { laneKey: `lane-${id}` }));
  }
  await settle();
  const v1 = h.jobRuns.get('v1').evidence;
  assert.equal(v1.verified, false);
  assert.equal(v1.verifyMs, 500);
  assert.equal(v1.verifyAttempts, 2, '差し戻しを含む試行回数');
  assert.equal(v1.tokens, null, 'usage の無い job は tokens ごと null');
  assert.ok(Number.isSafeInteger(v1.runMs) && v1.runMs >= 0, `runMs: ${v1.runMs}`);
  const v2 = h.jobRuns.get('v2').evidence;
  assert.equal(v2.verified, null, '検証記録なしは成功と数えない');
  assert.equal(v2.verifyMs, null, 'verify の無い job は null');
  assert.equal(v2.verifyAttempts, null, 'verify の無い job (metrics に鍵が無い) は null');
  assert.equal(v2.tokens, null);
  // 数えられない toolCalls は null (0 と混ぜない)
  assert.equal(v2.toolCalls, null);
  assert.deepEqual(h.jobRuns.get('v3').evidence.tokens, { input: 7, cacheRead: null, cacheWrite: null, output: null });
  for (const [id, value] of Object.entries(badAttempts)) {
    assert.equal(h.jobRuns.get(id).evidence.verifyAttempts, null, `${id}: ${JSON.stringify(value)} を回数として残した`);
  }
});

test('job が渡した verify NG の理由は stageDetail に残り、reason は verify-failed の一語のまま', async (t) => {
  captureConsole(t);
  const h = harness(t);
  const detail = 'exit 1: # fail 1 / # cancelled 0 / # skipped 0 / # todo 0 / # duration_ms 812.5';
  h.enqueue(item(h.jobRuns, 'd1', async (metrics, recorder, outcome) => {
    metrics.verifyPassed = 0;
    outcome.verifyDetail = detail;
    return 'verify-failed';
  }));
  // 渡さなければ今までどおり空 (ok で終わった job も)
  h.enqueue(item(h.jobRuns, 'd2', async () => 'verify-failed', { laneKey: 'lane-b' }));
  h.enqueue(item(h.jobRuns, 'd3', async () => 'ok', { laneKey: 'lane-c' }));
  // reason から読めた理由 (failed(...) の中身) があればそちらを採る
  h.enqueue(item(h.jobRuns, 'd4', async (metrics, recorder, outcome) => {
    outcome.verifyDetail = detail;
    return 'failed(spawn ENOENT)';
  }, { laneKey: 'lane-d' }));
  // 長すぎる理由は 200 字で切る
  h.enqueue(item(h.jobRuns, 'd5', async (metrics, recorder, outcome) => {
    outcome.verifyDetail = `exit 1: ${'x'.repeat(300)}`;
    return 'verify-failed';
  }, { laneKey: 'lane-e' }));
  await settle();

  const ng = h.jobRuns.get('d1');
  assert.equal(ng.reason, 'verify-failed');
  assert.equal(ng.outcome, 'verify-failed');
  assert.equal(ng.stageDetail, detail);
  assert.equal(h.jobRuns.get('d2').stageDetail, '');
  assert.equal(h.jobRuns.get('d3').stageDetail, '');
  assert.equal(h.jobRuns.get('d4').stageDetail, 'spawn ENOENT');
  assert.equal(h.jobRuns.get('d5').stageDetail.length, 200);
  assert.deepEqual(h.outcomes.find(([id]) => id === 'd1'), ['d1', 'verify-failed']);
});

test('受付停止中は pump が 1 本も起こさない (待機分は shutdown が取り消す)', async (t) => {
  captureConsole(t);
  const h = harness(t);
  h.lifecycle.stopAccepting();
  let ran = false;
  h.enqueue(item(h.jobRuns, 'q1', async () => { ran = true; return 'ok'; }));
  await settle();
  assert.equal(ran, false);
  assert.equal(h.jobs.waitingCount, 1);
  assert.equal(h.jobRuns.get('q1').stage, 'queued');
});

test('同じレーンは直列、違うレーンは並行に走る', async (t) => {
  captureConsole(t);
  const h = harness(t);
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  h.enqueue(item(h.jobRuns, 'a1', async () => { order.push('a1:start'); await gate; order.push('a1:end'); return 'ok'; }));
  h.enqueue(item(h.jobRuns, 'a2', async () => { order.push('a2:start'); return 'ok'; }));
  h.enqueue(item(h.jobRuns, 'b1', async () => { order.push('b1:start'); return 'ok'; }, { laneKey: 'lane-b' }));
  await settle();
  // a2 は a1 が終わるまで走らない。b1 は別レーンなので追い越して走る
  assert.deepEqual(order, ['a1:start', 'b1:start']);
  assert.equal(h.jobs.activeCount, 1);
  releaseFirst();
  await settle();
  assert.deepEqual(order, ['a1:start', 'b1:start', 'a1:end', 'a2:start']);
  assert.equal(h.jobs.activeCount, 0);
});

test('waitForJobsDrained は受付を止め、実行中が無ければすぐ返り、上限を過ぎたら待たずに進む', async (t) => {
  const { errors } = captureConsole(t);
  const h = harness(t);
  await h.waitForJobsDrained(1000, 'restart');
  assert.equal(h.lifecycle.accepting, false);

  const h2 = harness(t);
  h2.enqueue(item(h2.jobRuns, 'w1', () => new Promise(() => {}))); // 終わらない job
  await settle();
  assert.equal(h2.jobs.activeCount, 1);
  const started = Date.now();
  await h2.waitForJobsDrained(300, 'restart');
  assert.ok(Date.now() - started >= 250, '上限まで待っていない');
  assert.equal(h2.jobs.activeCount, 1, '待ち切れなかった job は解放されない (job 自身の finish を待つ)');
  assert.ok(errors.some((e) => e.includes('[restart] 実行中 1 件が 0 秒で終わらなかったため待たずに終了します')), errors.join('\n'));
});

test('開始の記録に失敗しても job は走る (記録の失敗で job を落とさない)', async (t) => {
  const { errors } = captureConsole(t);
  const h = harness(t);
  // open していない id — start / finish の記録が失敗する経路
  let ran = false;
  h.enqueue({
    jobId: 'ghost', enqueuedAt: Date.now(), laneKey: 'lane-a', threadId: 'T1', botKey: 'opus',
    channelName: 'kt', run: async () => { ran = true; return 'ok'; },
  });
  await settle();
  assert.equal(ran, true);
  assert.ok(errors.some((e) => e.includes('[jobruns] ghost: 開始を記録できませんでした (実行は続けます)')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('[jobruns] ghost: 終了を記録できませんでした')), errors.join('\n'));
  assert.deepEqual(h.outcomes, [['ghost', 'ok']]);
});

// ---- 社会の Action に結ぶ job (docs/society-ledger.md §5・S2-2) ----

/** noteRunning / noteSettled の呼ばれ方を記録する偽の society 配線 */
function fakeSociety({ throws = false } = {}) {
  const calls = { running: [], settled: [] };
  return {
    calls,
    noteRunning: (actionId) => {
      calls.running.push(actionId);
      if (throws) throw new Error('台帳が読めない');
      return { ok: true };
    },
    noteSettled: (actionId, fields) => {
      calls.settled.push({ actionId, ...fields });
      if (throws) throw new Error('台帳が読めない');
      return { ok: true };
    },
  };
}

/** 案件に結んだ受付 (messages.js の受付点と同じ形で open する) */
function societyItem(jobRuns, id, run) {
  jobRuns.open({
    id, threadId: 'T1', botKey: 'opus', channelName: 'kt',
    society: { caseId: 'C-1', actionId: 'A-1', claimGeneration: 1 },
  });
  return { jobId: id, enqueuedAt: Date.now(), laneKey: 'lane-a', threadId: 'T1', botKey: 'opus', channelName: 'kt', run };
}

test('runItem は案件に結ぶ job の running と settled を台帳へ書く (配送の後)', async (t) => {
  captureConsole(t);
  const society = fakeSociety();
  const h = harness(t, { society });
  const seen = {};
  h.enqueue(societyItem(h.jobRuns, 'j-soc', async () => {
    // 走り出した時点で running は書かれている
    seen.runningAtRun = [...society.calls.running];
    seen.settledAtRun = [...society.calls.settled];
    return 'ok';
  }));
  await settle();

  assert.deepEqual(seen.runningAtRun, ['A-1']);
  assert.deepEqual(seen.settledAtRun, [], 'settled は job が終わってから');
  // outcome / reason は実行記録と同じ値
  const record = h.jobRuns.get('j-soc');
  assert.deepEqual(society.calls.settled, [{
    actionId: 'A-1', runId: 'j-soc', outcome: record.outcome, reason: record.reason,
  }]);
  assert.equal(record.outcome, 'ok');
});

test('runItem: 案件に結ばない job では society を呼ばない (回帰)', async (t) => {
  captureConsole(t);
  const society = fakeSociety();
  const h = harness(t, { society });
  h.enqueue(item(h.jobRuns, 'j-plain', async () => 'ok'));
  await settle();
  assert.deepEqual(society.calls, { running: [], settled: [] });
  assert.equal(h.jobRuns.get('j-plain').outcome, 'ok');
});

test('runItem: society 側が投げても job の結果報告は壊れない', async (t) => {
  const { errors, logs } = captureConsole(t);
  const society = fakeSociety({ throws: true });
  const h = harness(t, { society });
  h.enqueue(societyItem(h.jobRuns, 'j-boom', async () => 'ok'));
  await settle();

  // 実行記録・勘定・計測ログは従来どおり
  assert.equal(h.jobRuns.get('j-boom').outcome, 'ok');
  assert.deepEqual(h.outcomes, [['j-boom', 'ok']]);
  assert.ok(logs.some((l) => l.includes('j-boom')), '計測ログが出ていない');
  // 失敗はログ 1 行で、照合に任せる
  assert.equal(errors.filter((e) => /台帳が読めない/.test(e)).length, 2);
});

test('runItem: 失敗した job も outcome と reason をそのまま Action へ渡す', async (t) => {
  captureConsole(t);
  const society = fakeSociety();
  const h = harness(t, { society });
  h.enqueue(societyItem(h.jobRuns, 'j-ng', async () => 'verify-failed'));
  await settle();
  const record = h.jobRuns.get('j-ng');
  assert.equal(record.outcome, 'verify-failed');
  assert.deepEqual(society.calls.settled, [{
    actionId: 'A-1', runId: 'j-ng', outcome: 'verify-failed', reason: record.reason,
  }]);
});

test('runItem: 構造化された戻りが台帳へ写した後は fallback の settled を呼ばない', async (t) => {
  captureConsole(t);
  const society = fakeSociety();
  const h = harness(t, { society });
  // case-turn を写した job は outcome.societySettled を立てて返る (src/bridge/job.js)
  h.enqueue(societyItem(h.jobRuns, 'j-turn', async (metrics, recorder, outcome) => {
    outcome.societySettled = true;
    return 'ok';
  }));
  await settle();

  assert.deepEqual(society.calls.running, ['A-1'], 'running は従来どおり');
  assert.deepEqual(society.calls.settled, [], '二重に settle すると bot が書いた next が上書きされる');
  assert.equal(h.jobRuns.get('j-turn').outcome, 'ok');
});

test('runItem: 様式に合わなかった job は fallback が Action を終端まで書く', async (t) => {
  captureConsole(t);
  const society = fakeSociety();
  const h = harness(t, { society });
  h.enqueue(societyItem(h.jobRuns, 'j-raw', async () => 'ok'));
  await settle();
  assert.equal(society.calls.settled.length, 1, '写せなかった Action を running のまま残さない');
  assert.equal(society.calls.settled[0].actionId, 'A-1');
});
