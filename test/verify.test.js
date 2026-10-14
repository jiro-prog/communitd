import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  formatVerifyFailureReason,
  formatVerifyResult,
  readVerifyState,
  runVerify,
  runVerifyHook,
  tailText,
  VERIFY_KILL_GRACE_MS,
} from '../src/verify.js';

function nodeCommand(source) {
  const bin = process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath;
  return `"${bin}" -e ${JSON.stringify(source)}`;
}

function fakeSpawn({ code = 0, stdout = '', stderr = '', error = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, null);
    });
    return child;
  };
}

function fakeVerify(ok, code) {
  return async ({ command }) => ({
    ran: true,
    ok,
    code,
    command,
    durationMs: 12,
    output: ok ? 'passed' : 'failed',
  });
}

test('spawn の detached はブリッジ本体からのときだけ付く (hook 経路では付けない)', async () => {
  // ブリッジ本体 (job / orgapply) から呼ぶ分はグループを分けて孫まで殺せるようにする。
  // Stop hook は claude の子の中で走るので、そこで分けるとブリッジが claude のグループを
  // 撃っても検証のツリーだけ生き残る (Opus2 指摘 2026-09-11)
  const optsFor = async (extra) => {
    let opts = null;
    await runVerify({
      command: 'echo x',
      cwd: process.cwd(),
      spawnImpl: (cmd, spawnOpts) => { opts = spawnOpts; throw new Error('spawn ENOENT'); },
      ...extra,
    });
    return opts;
  };

  const fromBridge = await optsFor({});
  assert.equal(fromBridge?.detached, process.platform === 'win32' ? undefined : true);
  assert.equal(fromBridge?.shell, true, '既存のオプションを落としている');

  const fromHook = await optsFor({ detachGroup: false });
  assert.equal(fromHook?.detached, undefined, 'hook 経路でグループを分けている');
  assert.equal(fromHook?.shell, true);
});

test('Stop hook は detachGroup: false で検証を走らせる', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-verify-detach-'));
  try {
    let passed = null;
    await runVerifyHook(
      {
        command: 'echo x',
        cwd: process.cwd(),
        stateFile: join(dir, 'state.json'),
        maxRetries: 0,
        timeoutMs: 10_000,
      },
      { hook_event_name: 'Stop' },
      {
        runVerifyImpl: async (args) => {
          passed = args;
          return { ran: true, ok: true, code: 0, command: args.command, durationMs: 1, output: '' };
        },
      },
    );
    assert.equal(passed?.detachGroup, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify コマンドの成功・失敗・コマンド不在を結果へ整形する', async () => {
  const success = await runVerify({
    spawnImpl: fakeSpawn({ stdout: 'ok' }),
    command: nodeCommand("process.stdout.write('ok')"),
    cwd: process.cwd(),
  });
  assert.equal(success.ok, true);
  assert.equal(success.code, 0);
  assert.equal(success.output, 'ok');
  assert.match(formatVerifyResult(success), /✅ verify 成功/);

  const failure = await runVerify({
    command: nodeCommand("process.stderr.write('bad\\n'); process.exit(3)"),
    spawnImpl: fakeSpawn({ code: 3, stderr: 'bad\n' }),
    cwd: process.cwd(),
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 3);
  assert.match(failure.output, /bad/);
  assert.match(formatVerifyResult(failure), /❌ verify 失敗 \(exit 3/);
  assert.match(formatVerifyResult(failure), /次の担当は呼び出していません/);

  const missing = await runVerify({
    command: 'communitd-command-that-does-not-exist-42',
    cwd: process.cwd(),
    spawnImpl: fakeSpawn({ error: new Error('ENOENT') }),
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.error || missing.output || missing.code !== 0);
  assert.match(formatVerifyResult(missing), /verify 失敗/);
});

test('停止済み handle では verify を spawn しない', async () => {
  const result = await runVerify({
    command: 'this-must-not-run',
    cwd: process.cwd(),
    handle: { stopRequested: true },
  });
  assert.equal(result.ran, false);
  assert.equal(result.aborted, true);
});

// ---- 走っている検証の止め方 (停止の指示・タイムアウト・close が来ないときの保険) ----
// verify はループの門で、ここが返らないと job が終わらず、同時枠を塞いだまま止まる。
// 保険の待ち (8 秒) を実時間で待たないよう、偽タイマー (setTimeout / Date) で進める。
// **偽タイマーの下で setTimeout の sleep を使わない** (進めない限り返らない)。待つのは setImmediate

const KILL_GRACE_MS = VERIFY_KILL_GRACE_MS;

/**
 * 自分からは閉じない偽の子プロセス (test/runtime-stop.test.js の hangingChild と同じ形)。
 * kill() は signal を控えるだけで close は出さない — 殺された子の close はテストが
 * `closeAsKilled()` で手で出す。**pid を持たせない**: pid があると killTree が本物の
 * taskkill (win32) や process.kill(-pid) を撃つ (src/proc.js)。
 */
function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  child.closeAsKilled = () => child.emit('close', null, 'SIGKILL');
  return child;
}

/** 閉じない子で runVerify を起こす。起こした子は `child` に残る */
function startHanging(t, opts) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctl = { child: null };
  ctl.pending = runVerify({
    command: 'npm test',
    cwd: process.cwd(),
    spawnImpl: () => { ctl.child = hangingChild(); return ctl.child; },
    ...opts,
  });
  ctl.state = { settled: false };
  ctl.pending.then(() => { ctl.state.settled = true; });
  return ctl;
}

const flush = () => new Promise((r) => { setImmediate(r); });

test('走っている検証は停止の指示で子を kill し、close を待って aborted で終わる', async (t) => {
  const handle = {};
  const ctl = startHanging(t, { handle, timeoutMs: 1500 });
  ctl.child.stdout.emit('data', '途中まで');
  t.mock.timers.tick(200);
  handle.abort();
  // **await の前に見る。** kill しない回帰でも、タイムアウトが代わりに kill して結果自体は返る
  assert.equal(handle.stopRequested, true);
  assert.deepEqual(ctl.child.kills, ['SIGKILL'], '停止の指示で kill していない');
  await flush();
  assert.equal(ctl.state.settled, false, 'close を待たずに終わっている');
  ctl.child.closeAsKilled();
  const res = await ctl.pending;
  assert.equal(res.ran, true);
  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, undefined, '停止をタイムアウトと取り違えている');
  assert.equal(res.error, '停止指示により検証を中断');
  assert.equal(res.output, '途中まで');
  assert.equal(res.durationMs, 200);
  assert.match(formatVerifyResult(res), /^❌ verify 失敗 \(aborted \/ 0\.2s\)/);
  // 終わった後はタイムアウトも保険も撃たない (finish がタイマーを消す)。本物なら終わった子
  // (再利用された pid) への taskkill になる
  t.mock.timers.tick(1500 + KILL_GRACE_MS);
  assert.deepEqual(ctl.child.kills, ['SIGKILL'], '終わった後に kill を撃った');
  // 終わった後の停止の指示 (/stop の二度押し) も撃たない
  handle.abort();
  assert.deepEqual(ctl.child.kills, ['SIGKILL']);
});

test('停止の指示の後に close が来なくても、保険の待ちで aborted として終わる', async (t) => {
  // 孫が stdout を握ったまま生き残ると close は来ない。タイムアウト (job からは 10 分) まで
  // 待たせず、停止として返す — 呼び手 (job / 適用回路) は aborted を見て「止めた」と言い分ける
  const handle = {};
  const ctl = startHanging(t, { handle, timeoutMs: 60_000 });
  handle.abort();
  assert.deepEqual(ctl.child.kills, ['SIGKILL']);
  t.mock.timers.tick(KILL_GRACE_MS - 1);
  await flush();
  assert.equal(ctl.state.settled, false, '保険の待ちより早く終わっている');
  t.mock.timers.tick(1);
  // await の前に見る (返らない回帰で、後続のテストまで巻き込んで止まらないように)
  await flush();
  assert.equal(ctl.state.settled, true, '停止の後、保険の待ちを過ぎても終わらない');
  const res = await ctl.pending;
  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, undefined, '停止をタイムアウトと取り違えている');
  assert.equal(res.error, '停止指示により検証を中断');
  assert.equal(res.durationMs, KILL_GRACE_MS);
  // 遅れて来た close も、その後のタイムアウトも何も変えない
  ctl.child.closeAsKilled();
  t.mock.timers.tick(60_000);
  assert.deepEqual(ctl.child.kills, ['SIGKILL'], '終わった後にタイムアウトが kill を撃った');
});

test('停止の指示の後にタイムアウトが来ても、停止として終わる', async (t) => {
  // 止めた後に close を待っている間にタイムアウトを迎えても、呼び手には「止めた」と返す
  const handle = {};
  const ctl = startHanging(t, { handle, timeoutMs: 1500 });
  handle.abort();
  t.mock.timers.tick(1500); // close を待っている間にタイムアウトを迎える
  t.mock.timers.tick(KILL_GRACE_MS - 1500); // 停止の保険の待ちが明ける
  await flush();
  assert.equal(ctl.state.settled, true, '停止の後、保険の待ちを過ぎても終わらない');
  const res = await ctl.pending;
  assert.equal(res.aborted, true);
  assert.equal(res.error, '停止指示により検証を中断');
});

test('タイムアウトは子を kill し、close を待って timedOut で終わる', async (t) => {
  const ctl = startHanging(t, { timeoutMs: 1500 });
  ctl.child.stderr.emit('data', '応答待ち');
  t.mock.timers.tick(1499);
  assert.deepEqual(ctl.child.kills, [], 'タイムアウトより早く kill した');
  t.mock.timers.tick(1);
  assert.deepEqual(ctl.child.kills, ['SIGKILL'], 'タイムアウトで kill していない');
  await flush();
  assert.equal(ctl.state.settled, false, 'close を待たずに終わっている');
  ctl.child.closeAsKilled();
  const res = await ctl.pending;
  assert.equal(res.ran, true);
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.aborted, undefined, 'タイムアウトを停止の指示と取り違えている');
  assert.equal(res.error, 'timeout after 1.5s');
  assert.equal(res.output, '応答待ち');
  assert.equal(res.durationMs, 1500);
  assert.match(formatVerifyResult(res), /^❌ verify 失敗 \(timeout \/ 1\.5s\)/);
  assert.match(formatVerifyFailureReason(res), /\(timeout \/ 1\.5s\)/);
  t.mock.timers.tick(KILL_GRACE_MS);
  assert.deepEqual(ctl.child.kills, ['SIGKILL'], '終わった後に kill を撃った');
});

test('タイムアウトで kill した子が close を返さなくても、保険の待ちで timedOut として終わる', async (t) => {
  const ctl = startHanging(t, { timeoutMs: 1500 });
  t.mock.timers.tick(1500);
  assert.deepEqual(ctl.child.kills, ['SIGKILL']);
  t.mock.timers.tick(KILL_GRACE_MS - 1);
  await flush();
  assert.equal(ctl.state.settled, false, '保険の待ちより早く終わっている');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(ctl.state.settled, true, 'タイムアウトの後、保険の待ちを過ぎても終わらない');
  const res = await ctl.pending;
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.aborted, undefined);
  assert.equal(res.error, 'timeout after 1.5s');
  assert.equal(res.durationMs, 1500 + KILL_GRACE_MS);
  // 遅れて来た close は結果を変えない (多重 resolve は settled で防ぐ)
  ctl.child.closeAsKilled();
  assert.deepEqual(ctl.child.kills, ['SIGKILL']);
});

test('出力は末尾 N 行・最大文字数に切り詰め、コードフェンスを無害化する', () => {
  const text = ['drop-1', 'drop-2', 'keep-1', '```keep-2'].join('\n');
  assert.equal(tailText(text, { maxLines: 2, maxChars: 100 }), "keep-1\n'''keep-2");
  assert.equal(tailText('abcdefghij', { maxLines: 2, maxChars: 5 }), '…ghij');

  const formatted = formatVerifyResult({
    ok: false,
    code: 1,
    durationMs: 1234,
    command: 'npm test',
    output: Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n'),
  }, { maxChars: 240, maxLines: 5 });
  assert.ok(formatted.length <= 240);
  assert.match(formatted, /^❌ verify 失敗/);
  assert.match(formatted, /line-99/);
  assert.doesNotMatch(formatted, /line-0\n/);
});

test('空出力と hook 用失敗理由も判定を失わない', () => {
  const result = { ok: false, code: 2, durationMs: 0, command: 'npm test', output: '' };
  assert.match(formatVerifyResult(result), /\(出力なし\)/);
  assert.match(formatVerifyFailureReason(result), /verify が失敗しました/);
  assert.match(formatVerifyFailureReason(result), /exit 2/);
});

test('Stop hook は NG を上限回だけ block し、最終結果を状態へ残す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-verify-'));
  try {
    const stateFile = join(dir, 'state.json');
    const config = {
      command: nodeCommand('process.exit(7)'),
      cwd: process.cwd(),
      stateFile,
      maxRetries: 1,
      timeoutMs: 10_000,
    };
    const first = await runVerifyHook(
      config, { hook_event_name: 'Stop', stop_hook_active: false }, { runVerifyImpl: fakeVerify(false, 7) },
    );
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /exit 7/);

    const second = await runVerifyHook(
      config, { hook_event_name: 'Stop', stop_hook_active: true }, { runVerifyImpl: fakeVerify(false, 7) },
    );
    assert.equal(second, null);
    const state = readVerifyState(stateFile);
    assert.equal(state.attempts, 2);
    assert.equal(state.blocksUsed, 1);
    assert.equal(state.lastResult.ok, false);
    assert.equal(state.lastResult.code, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop hook は成功時に block せず、verifyMaxRetries 0 も差し戻さない', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-verify-'));
  try {
    const passConfig = {
      command: nodeCommand('process.exit(0)'),
      cwd: process.cwd(),
      stateFile: join(dir, 'pass.json'),
      maxRetries: 3,
      timeoutMs: 10_000,
    };
    assert.equal(
      await runVerifyHook(passConfig, { hook_event_name: 'Stop' }, { runVerifyImpl: fakeVerify(true, 0) }), null,
    );
    assert.equal(readVerifyState(passConfig.stateFile).lastResult.ok, true);

    const noRetryConfig = {
      ...passConfig,
      command: nodeCommand('process.exit(1)'),
      stateFile: join(dir, 'no-retry.json'),
      maxRetries: 0,
    };
    assert.equal(
      await runVerifyHook(noRetryConfig, { hook_event_name: 'Stop' }, { runVerifyImpl: fakeVerify(false, 1) }), null,
    );
    assert.equal(readVerifyState(noRetryConfig.stateFile).blocksUsed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify state が無い・壊れている場合は null', () => {
  assert.equal(readVerifyState(''), null);
  assert.equal(readVerifyState(join(tmpdir(), 'communitd-no-such-verify-state.json')), null);
});
