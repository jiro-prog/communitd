import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESTART_EXIT_CODE,
  evaluateRestart,
  restartRejectionMessage,
  shouldRestart,
} from '../src/restart.js';

test('job が無ければ素の restart を許可', () => {
  const v = evaluateRestart({ activeCount: 0, waitingCount: 0, force: false });
  assert.equal(v.allowed, true);
  assert.equal(v.busy, false);
  assert.equal(evaluateRestart().allowed, true);
});

test('実行中 / 待機中の job があれば素の restart は拒否', () => {
  assert.equal(evaluateRestart({ activeCount: 1, waitingCount: 0 }).allowed, false);
  assert.equal(evaluateRestart({ activeCount: 0, waitingCount: 1 }).allowed, false);
  assert.equal(evaluateRestart({ activeCount: 2, waitingCount: 3 }).allowed, false);
});

test('force なら job があっても許可 (busy は立てたまま)', () => {
  const v = evaluateRestart({ activeCount: 2, waitingCount: 3, force: true });
  assert.equal(v.allowed, true);
  assert.equal(v.busy, true);
  assert.equal(v.force, true);
});

test('拒否メッセージに実行中・待機の件数が入る', () => {
  const msg = restartRejectionMessage(evaluateRestart({ activeCount: 2, waitingCount: 3 }));
  assert.match(msg, /実行中 2 件/);
  assert.match(msg, /待機 3 件/);
  assert.match(msg, /\/restart force:true/);
});

test('ラッパーが再起動するのは終了コード 42 だけ', () => {
  assert.equal(RESTART_EXIT_CODE, 42);
  assert.equal(shouldRestart(42), true);
  for (const code of [0, 1, 2, 130, 143, 41, 43, null, undefined, '42']) {
    assert.equal(shouldRestart(code), false, `再起動してしまう: ${String(code)}`);
  }
});
