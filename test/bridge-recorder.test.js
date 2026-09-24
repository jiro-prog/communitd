import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createRunRecorder, reconcileJobRunsOnStartup } from '../src/bridge/recorder.js';
import { JobRunStore } from '../src/jobruns.js';

// src/bridge/recorder.js — 実行記録への書き口。**記録の失敗で job を落とさない**約束をここで見る。

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

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-recorder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('runRecorder(id) は各段階を実行記録へ写す', (t) => {
  captureConsole(t);
  const jobRuns = new JobRunStore(join(tmp(t), 'job-runs.json'));
  jobRuns.open({ id: 'j1', threadId: 'T1', botKey: 'opus' });
  const recorder = createRunRecorder({ jobRuns })('j1');
  assert.equal(recorder.id, 'j1');

  recorder.stage('model', 'claude を起動');
  assert.equal(jobRuns.get('j1').stage, 'model');
  assert.equal(jobRuns.get('j1').stageDetail, 'claude を起動');
  recorder.spawn({ pid: 4242, runtime: 'claude' });
  assert.equal(jobRuns.get('j1').spawn.pid, 4242);
  recorder.model({ ok: true });
  assert.equal(jobRuns.get('j1').modelResult, 'ok');
  recorder.activity({ kind: 'tool', detail: 'Read a.js' });
  assert.equal(jobRuns.get('j1').lastActivity.detail, 'Read a.js');
  recorder.delivery('本文', 'sent');
  assert.equal(jobRuns.get('j1').delivery['本文'], 'sent');
  recorder.stopRequested('human');
  assert.equal(jobRuns.get('j1').stopKind, 'human');
  const finished = recorder.finish({ reason: 'ok', evidence: { toolCalls: 1 } });
  assert.equal(finished.stage, 'ended');
  assert.equal(jobRuns.get('j1').outcome, 'ok');
});

test('id の無い呼び出し (テスト・旧経路) は黙って通す', (t) => {
  const { errors } = captureConsole(t);
  const jobRuns = new JobRunStore(join(tmp(t), 'job-runs.json'));
  const recorder = createRunRecorder({ jobRuns })(null);
  assert.equal(recorder.stage('model'), null);
  assert.equal(recorder.spawn({ pid: 1 }), null);
  assert.equal(recorder.delivery('本文', 'sent'), null);
  assert.deepEqual(errors, []);
});

test('途中経過の記録に失敗しても投げず、終端の失敗は「結果不明」として残す', (t) => {
  const { errors } = captureConsole(t);
  const jobRuns = new JobRunStore(join(tmp(t), 'job-runs.json'));
  // open していない id — store が require で落とす経路
  const recorder = createRunRecorder({ jobRuns })('ghost');
  assert.equal(recorder.stage('model'), null);
  assert.ok(errors.some((e) => e.startsWith('[jobruns] ghost: 段階 model を記録できませんでした:')), errors.join('\n'));
  assert.equal(recorder.delivery('本文', 'pending'), null);
  assert.ok(errors.some((e) => e.startsWith('[jobruns] ghost: 配送 本文 を記録できませんでした:')), errors.join('\n'));
  assert.equal(recorder.finish({ reason: 'ok' }), null);
  const last = errors.at(-1);
  assert.match(last, /\[jobruns\] ghost: 終了を記録できませんでした — この job の結果は\*\*不明\*\*として扱います/);
  assert.match(last, /自動復旧は止まります/);
});

test('起動時の照合: 未終端は要照合にし、保持期間を過ぎた終端は消し、どちらもログに出す', (t) => {
  const { logs, errors } = captureConsole(t);
  const file = join(tmp(t), 'job-runs.json');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(file, JSON.stringify({
    stale: {
      id: 'stale', taskId: null, threadId: 'T0', botKey: 'opus', stage: 'ended', outcome: 'ok', reason: 'ok',
      acceptedAt: old, startedAt: old, observedAt: old, endedAt: old, evidence: null, handoff: null,
    },
  }));
  const jobRuns = new JobRunStore(file);
  jobRuns.open({ id: 'live', taskId: '7', threadId: 'T1', botKey: 'opus' });
  jobRuns.start('live');
  jobRuns.setStage('live', 'model');

  reconcileJobRunsOnStartup(jobRuns);
  assert.equal(jobRuns.get('live').stage, 'reconcile');
  assert.equal(jobRuns.get('live').reconcile.fromStage, 'model');
  assert.equal(jobRuns.get('stale'), null, '保持期間を過ぎた終端記録が残っている');
  assert.ok(logs.some((l) => l === '[jobruns] 前回の未終端 1 件を要照合にしました: live (opus thread:T1 task #7 model)'), logs.join('\n'));
  assert.ok(logs.some((l) => l === '[jobruns] 保持期間を過ぎた終端記録 1 件を消しました'), logs.join('\n'));
  assert.deepEqual(errors, []);

  // 2 回目の起動では既に要照合のものを二重に数えない (件数には入るが印は付け直さない)
  reconcileJobRunsOnStartup(jobRuns);
  assert.equal(jobRuns.get('live').reconcile.fromStage, 'model');
});

test('台帳が読めなければ退避せず在処に残し、記録が無いことを「仕事が無い」と読まないよう警告する', (t) => {
  const { errors } = captureConsole(t);
  const file = join(tmp(t), 'job-runs.json');
  writeFileSync(file, '{ not json');
  const jobRuns = new JobRunStore(file);
  reconcileJobRunsOnStartup(jobRuns);
  assert.ok(typeof jobRuns.broken === 'string' && jobRuns.broken !== '', '壊れた台帳を broken として覚えていない');
  const warning = errors.find((e) => e.startsWith('[jobruns] data/job-runs.json が読めませんでした'));
  assert.ok(warning, errors.join('\n'));
  assert.match(warning, /記録が無いことを「仕事が無い」と読まないこと/);
  assert.match(warning, /退避していません/);
  // 退避すると次の起動が「初回」に見える。照合も掃除も壊れたファイルに触らない
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.deepEqual(readdirSync(dirname(file)), ['job-runs.json']);
});
