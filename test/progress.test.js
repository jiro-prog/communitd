import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROGRESS_INTERVAL_MS,
  createProgressReporter,
  elapsedLabel,
  formatProgressLine,
} from '../src/progress.js';

const T0 = Date.parse('2026-09-05T09:00:00.000Z');
const minutes = (n) => n * 60000;

test('elapsedLabel は分より細かく出さない', () => {
  assert.equal(elapsedLabel(T0, T0 + 30000), '1m 未満');
  assert.equal(elapsedLabel(T0, T0 + minutes(12)), '12m');
  assert.equal(elapsedLabel(T0, T0 + minutes(65)), '1h05m');
  assert.equal(elapsedLabel(null, T0), '');
  assert.equal(elapsedLabel('x', T0), '');
});

test('進捗行: 段階・経過・最後に完了したツール (実行中のツールとは言わない)', () => {
  const line = formatProgressLine({
    displayName: 'Opus', channelName: 'kumamikan-tools', model: 'opus', stage: 'model',
    startedAt: T0, now: T0 + minutes(12), hooks: true, toolCalls: 14,
    lastTool: { tool: 'Edit', arg: 'lint.py', at: T0 + minutes(9) },
  });
  assert.equal(
    line,
    '⚙️ Opus 作業中… (kumamikan-tools / model: opus) — 段階: モデル実行中 / 経過 12m / ツール 14 件 / 最後に完了したツール: Edit lint.py (3m 前)',
  );
  assert.ok(!/実行中のツール/.test(line));
});

test('進捗行: hooks 無効なら詳細が取れないと書き、ツール 0 件なら思考中の可能性を書く', () => {
  const noHooks = formatProgressLine({
    displayName: 'Sol', channelName: 'advisor', stage: 'model', startedAt: T0, now: T0 + minutes(3), hooks: false,
  });
  assert.match(noHooks, /段階: モデル実行中 \/ 経過 3m \/ ツールの詳細は取れない \(hooks 無効\)/);
  assert.ok(!/model:/.test(noHooks), 'model 未指定なのに model: が出る');
  const zero = formatProgressLine({
    displayName: 'Opus', channelName: 'c', stage: 'starting', startedAt: T0, now: T0, hooks: true, toolCalls: 0,
  });
  assert.match(zero, /段階: 起動準備 \/ 経過 1m 未満 \/ 完了したツールはまだ無い/);
  assert.match(formatProgressLine({ displayName: 'O', channelName: 'c', stage: 'verify', now: T0, hooks: true, toolCalls: 3 }), /最終検証 \/ ツール 3 件$/);
});

test('reporter は変わったときだけ編集し、承認待ち (suspended) は上書きしない', async () => {
  const edits = [];
  const changes = [];
  let snap = {
    displayName: 'Opus', channelName: 'c', stage: 'model', startedAt: T0, now: T0 + minutes(1), hooks: true, toolCalls: 1,
    lastTool: { tool: 'Read', arg: 'a.js', at: T0 },
  };
  const timers = [];
  const reporter = createProgressReporter({
    snapshot: () => snap,
    edit: async (text) => { edits.push(text); },
    onChange: (s) => changes.push(s.toolCalls),
    intervalMs: 1000, // 下限より短い指定は 30 秒へ丸める
    setIntervalImpl: (fn, ms) => { timers.push(ms); return { unref() {} }; },
    clearIntervalImpl: () => { timers.push('cleared'); },
  });
  assert.equal(reporter.intervalMs, PROGRESS_INTERVAL_MS);
  reporter.start();
  reporter.start(); // 二重に張らない
  assert.deepEqual(timers, [PROGRESS_INTERVAL_MS]);

  assert.equal(await reporter.tick(), true);
  assert.equal(edits.length, 1);
  assert.deepEqual(changes, [1]);
  // 何も変わっていなければ編集しない
  assert.equal(await reporter.tick(), false);
  assert.equal(edits.length, 1);
  // 経過だけ進んでも本文が変われば編集する
  snap = { ...snap, now: T0 + minutes(2) };
  assert.equal(await reporter.tick(), true);
  // 承認待ちの間は触らない
  snap = { ...snap, suspended: true, toolCalls: 2 };
  assert.equal(await reporter.tick(), false);
  assert.equal(edits.length, 2);
  // 戻ってきたらツール数の変化を知らせて描き直す
  snap = { ...snap, suspended: false };
  assert.equal(await reporter.tick(), true);
  assert.deepEqual(changes, [1, 2]);
  // 編集の失敗で落ちない
  const failing = createProgressReporter({
    snapshot: () => snap, edit: async () => { throw new Error('Unknown Message'); },
    setIntervalImpl: () => ({}), clearIntervalImpl: () => {},
  });
  assert.equal(await failing.tick(), true);
  // 止めたら以後は何もしない
  reporter.stop();
  assert.ok(timers.includes('cleared'));
  snap = { ...snap, now: T0 + minutes(9) };
  assert.equal(await reporter.tick(), false);
  // snapshot が投げる tick は飛ばす
  const throwing = createProgressReporter({
    snapshot: () => { throw new Error('x'); }, edit: async () => {}, setIntervalImpl: () => ({}), clearIntervalImpl: () => {},
  });
  assert.equal(await throwing.tick(), false);
});
