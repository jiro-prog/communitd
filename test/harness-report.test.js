import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_HARNESS_MIN_RUNS } from '../src/config.js';
import { parseArgs } from '../scripts/harness-report.mjs';
import { saveRunTrace } from '../src/trace-store.js';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'harness-report.mjs');

test('parseArgs: 既定は data/ の台帳・全チャンネル・全 bot', () => {
  const opts = parseArgs([]);
  assert.match(opts.runs, /data[\\/]job-runs\.json$/);
  assert.match(opts.tasks, /data[\\/]tasks\.json$/);
  assert.equal(opts.channel, null);
  assert.equal(opts.bot, null);
  assert.equal(opts.minRuns, DEFAULT_HARNESS_MIN_RUNS);
  assert.equal(opts.excerpts, 8);
  assert.equal(opts.json, false);
});

test('parseArgs: 絞り込みと数の指定を受け、知らないオプション・不正な数は断る', () => {
  const opts = parseArgs(['--channel', 'dev', '--bot', 'opus', '--min-runs', '30', '--excerpts', '20', '--json']);
  assert.deepEqual(
    { channel: opts.channel, bot: opts.bot, minRuns: opts.minRuns, excerpts: opts.excerpts, json: opts.json },
    { channel: 'dev', bot: 'opus', minRuns: 30, excerpts: 20, json: true },
  );
  assert.throws(() => parseArgs(['--since', '2026-10-01']), /知らないオプション/);
  assert.throws(() => parseArgs(['--bot']), /値が渡されていません/);
  assert.throws(() => parseArgs(['--min-runs', '0']), /1 以上の整数/);
});

test('parseArgs: 軌跡の置き場と --trace を受ける', () => {
  assert.match(parseArgs([]).traces, /data[\\/]traces$/);
  assert.equal(parseArgs([]).trace, null);
  const opts = parseArgs(['--traces', 'x/traces', '--trace', 'ab12cd34']);
  assert.equal(opts.traces, 'x/traces');
  assert.equal(opts.trace, 'ab12cd34');
});

describe('CLI (一時ディレクトリの台帳で走らせる)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-report-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const at = '2026-10-13T10:09:13.000Z';
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({
    j1: {
      id: 'j1', botKey: 'opus', channelName: 'dev', taskId: '9', stage: 'ended', outcome: 'verify-failed',
      reason: 'verify-failed', next: 'bot', acceptedAt: at, startedAt: at, endedAt: at, stageDetail: '', harness: null,
    },
  }));
  writeFileSync(join(dir, 'tasks.json'), '{}');
  saveRunTrace(join(dir, 'traces'), 'j1', [
    { tool: 'Read', arg: 'a.js' }, { tool: 'Edit', arg: 'a.js' }, { tool: 'Bash', arg: 'npm test', failed: true, at: Date.parse(at) },
  ]);
  const cli = (...args) => spawnSync(process.execPath, [
    SCRIPT, '--runs', join(dir, 'runs.json'), '--tasks', join(dir, 'tasks.json'), '--traces', join(dir, 'traces'), ...args,
  ], { encoding: 'utf8' });

  test('問題の抜粋に手順の要約を添える', () => {
    const out = cli();
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /- 手順 \(job j1\): 読む → 編集 a\.js → \$ npm test ✗/);
  });

  test('--json の summary に版 × job 種別の重さと今 ← 前の比・1 回で通った提出の内訳が載る', () => {
    const out = cli('--json');
    assert.equal(out.status, 0, out.stderr);
    const bot = JSON.parse(out.stdout).bots[0];
    // tool 呼び出しの記録が無い job は tool だけ外す (起動と終端は同じ時刻なので 0 分)
    assert.deepEqual(bot.current.cost['task-work'], { jobs: 1, toolCalls: { n: 0, median: null }, minutes: { n: 1, median: 0 } });
    assert.deepEqual(bot.cost.map((c) => [c.kind, c.jobs, c.minutes]), [
      ['task-work', { current: 1, previous: null }, { current: 0, previous: null, ratio: null }],
    ]);
    // j1 は提出ではない (next: bot) ので分母 0
    assert.deepEqual(bot.current.firstPass, { measured: 0, passed: 0, retried: 0, remarked: 0, sentBack: 0 });
  });

  test('--trace は 1 job の手順を 1 手 1 行で出し、無い job は理由を添えて断る', () => {
    const out = cli('--trace', 'j1');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), [
      '# job j1 の手順 (3 手・うち失敗 1) — opus task #9 verify-failed (10-13 19:09 JST)',
      '',
      '1. Read a.js',
      '2. Edit a.js',
      // 手順の行の時刻は src/trace.js の formatTraceSteps が UTC で出す (このテストの範囲外 — 見出しだけ JST)
      '3. 10:09:13 Bash npm test ✗',
    ].join('\n'));
    const missing = cli('--trace', 'nope');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /job nope の手順がありません/);
  });
});
