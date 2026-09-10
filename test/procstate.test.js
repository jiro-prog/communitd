import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SPAWN_TIME_TOLERANCE_MS,
  inspectProcess,
  judgeLiveness,
  parseUnixProcess,
  parseWindowsProcess,
} from '../src/procstate.js';

const T0 = Date.parse('2026-09-05T07:00:00.000Z');
const spawn = (over = {}) => ({ pid: 4242, at: new Date(T0).toISOString(), runtime: 'claude', ...over });
const seen = (over = {}) => ({
  alive: true, createdAt: T0 + 500, name: 'claude.exe', command: 'claude -p --output-format json', error: null, ...over,
});

test('parseWindowsProcess: 空なら居ない / 1 件なら起動時刻と名前を読む / 配列でも先頭を読む', () => {
  assert.deepEqual(parseWindowsProcess(''), { alive: false, createdAt: null, name: null, command: null, error: null });
  const one = parseWindowsProcess(JSON.stringify({
    pid: 4242, created: '2026-09-05T07:00:00.0000000Z', name: 'claude.exe', cmd: 'claude -p',
  }));
  assert.equal(one.alive, true);
  assert.equal(one.createdAt, T0);
  assert.equal(one.name, 'claude.exe');
  assert.equal(one.command, 'claude -p');
  const arr = parseWindowsProcess(JSON.stringify([{ pid: 1, created: 'not a time', name: 'node.exe', cmd: null }]));
  assert.equal(arr.alive, true);
  assert.equal(arr.createdAt, null, '読めない時刻を数値にしている');
  assert.equal(arr.command, null);
  assert.match(parseWindowsProcess('{ not json').error, /読めません/);
});

test('parseUnixProcess: ps の 1 行から lstart / comm / args を読む', () => {
  const out = parseUnixProcess('Sat Sep  5 16:07:51 2026 claude claude -p --output-format json\n');
  assert.equal(out.alive, true);
  assert.equal(out.name, 'claude');
  assert.equal(out.command, 'claude -p --output-format json');
  assert.equal(out.createdAt, Date.parse('Sat Sep  5 16:07:51 2026'));
  assert.equal(parseUnixProcess('\n').alive, false);
});

test('judgeLiveness: 居なければ gone・時刻と名前が合えば alive・pid 再利用は gone・確かめられなければ unknown', () => {
  assert.equal(judgeLiveness(spawn(), seen({ alive: false })), 'gone');
  assert.equal(judgeLiveness(spawn(), seen()), 'alive');
  // 起動時刻が違う = 別のプロセスが同じ pid を貰った
  assert.equal(judgeLiveness(spawn(), seen({ createdAt: T0 + SPAWN_TIME_TOLERANCE_MS + 1 })), 'gone');
  assert.equal(judgeLiveness(spawn(), seen({ createdAt: T0 - SPAWN_TIME_TOLERANCE_MS - 1 })), 'gone');
  // 名前がランタイムと合わない = 別物
  assert.equal(judgeLiveness(spawn(), seen({ name: 'node.exe', command: 'node x.js' })), 'gone');
  // ランタイムが分からない記録は名前で弾かない
  assert.equal(judgeLiveness(spawn({ runtime: null }), seen({ name: 'node.exe', command: 'node x.js' })), 'alive');
  // **unknown は gone ではない** — 起こさない側へ倒すための値
  assert.equal(judgeLiveness(spawn(), seen({ createdAt: null })), 'unknown');
  assert.equal(judgeLiveness(spawn(), seen({ error: 'powershell が居ない' })), 'unknown');
  assert.equal(judgeLiveness(spawn({ at: 'いつか' }), seen()), 'unknown');
  assert.equal(judgeLiveness(spawn({ pid: null }), seen()), 'unknown');
  assert.equal(judgeLiveness(null, seen()), 'unknown');
  assert.equal(judgeLiveness(spawn(), null), 'unknown');
});

test('inspectProcess は OS のコマンドを注入で受け、pid が不正なら聞かない', async () => {
  const calls = [];
  const win = await inspectProcess(4242, {
    platform: 'win32',
    run: async (file, args) => {
      calls.push([file, args.join(' ')]);
      return JSON.stringify({ pid: 4242, created: new Date(T0).toISOString(), name: 'claude.exe', cmd: 'claude -p' });
    },
  });
  assert.equal(win.alive, true);
  assert.equal(calls[0][0], 'powershell');
  assert.match(calls[0][1], /ProcessId=4242/);

  const unix = await inspectProcess(7, {
    platform: 'linux',
    run: async () => 'Sat Sep  5 16:07:51 2026 claude claude -p\n',
  });
  assert.equal(unix.alive, true);
  assert.equal(unix.name, 'claude');

  // ps は居ないと exit 1 — それは「見つからない」で、聞けなかったのではない
  const gone = await inspectProcess(7, {
    platform: 'linux',
    run: async () => { throw new Error('ps exited with code 1: Command failed'); },
  });
  assert.equal(gone.alive, false);
  assert.equal(gone.error, null);

  // それ以外の失敗は error に残す (unknown 側へ倒せるように)
  const broken = await inspectProcess(7, {
    platform: 'win32',
    run: async () => { throw new Error('spawn powershell ENOENT'); },
  });
  assert.equal(broken.alive, false);
  assert.match(broken.error, /ENOENT/);

  const bad = await inspectProcess(0, { run: async () => { throw new Error('呼ばれてはいけない'); } });
  assert.equal(bad.alive, false);
  assert.match(bad.error, /pid/);
});
