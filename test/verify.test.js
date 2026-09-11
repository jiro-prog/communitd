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
