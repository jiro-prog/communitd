import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESTART_EXIT_CODE,
  evaluateRestart,
  formatLogChunk,
  formatLogLine,
  parseRunArgs,
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

test('引数なしは控えを取らない / --log は 2 つの書き方を受ける', () => {
  assert.deepEqual(parseRunArgs(), { logPath: null, error: null });
  assert.deepEqual(parseRunArgs([]), { logPath: null, error: null });
  assert.deepEqual(parseRunArgs(['--log', 'logs/bridge.log']), {
    logPath: 'logs/bridge.log',
    error: null,
  });
  assert.deepEqual(parseRunArgs(['--log=C:/tmp/bridge.log']), {
    logPath: 'C:/tmp/bridge.log',
    error: null,
  });
});

test('解釈できない引数は無視せずエラー (控えが黙って落ちないため)', () => {
  for (const argv of [['--logs', 'a.log'], ['--log', 'a.log', 'b.log'], ['-l', 'a.log']]) {
    const v = parseRunArgs(argv);
    assert.equal(v.logPath, null);
    assert.match(v.error, /解釈できない引数/);
  }
  assert.match(parseRunArgs(['--log']).error, /書き出し先/);
  assert.match(parseRunArgs(['--log=']).error, /書き出し先/);
  assert.match(parseRunArgs(['--log', '--log=a.log']).error, /書き出し先/);
  assert.match(parseRunArgs(['--log', 'a.log', '--log', 'b.log']).error, /1 つだけ/);
});

test('控えの行には ISO 8601 (UTC) の時刻が前置される', () => {
  const now = new Date('2026-09-13T01:02:03.456Z');
  assert.equal(formatLogLine('[manager] logged in', now), '2026-09-13T01:02:03.456Z [manager] logged in\n');
  const { text } = formatLogChunk('', 'a\nb\n', now);
  assert.equal(text, '2026-09-13T01:02:03.456Z a\n2026-09-13T01:02:03.456Z b\n');
});

test('改行で終わらない chunk は次の chunk と連結してから 1 行にする', () => {
  const now = new Date('2026-09-13T01:02:03.456Z');
  const first = formatLogChunk('', 'tok in=1', now);
  assert.equal(first.text, '');
  assert.equal(first.pending, 'tok in=1');

  const second = formatLogChunk(first.pending, '23 out=45\n次の途中', now);
  assert.equal(second.text, '2026-09-13T01:02:03.456Z tok in=123 out=45\n');
  assert.equal(second.pending, '次の途中');

  // 空 chunk では何も出さず、持ち越しも壊さない
  assert.deepEqual(formatLogChunk(second.pending, '', now), { text: '', pending: '次の途中' });
  // 空行も 1 行として時刻が付く (CRLF の \r は行末に残したまま)
  assert.equal(formatLogChunk('', '\r\n\n', now).text,
    '2026-09-13T01:02:03.456Z \r\n2026-09-13T01:02:03.456Z \n');
});
