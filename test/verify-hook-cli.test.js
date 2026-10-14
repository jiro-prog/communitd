import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readVerifyState } from '../src/verify.js';

// Claude Code が Stop hook として叩く `node src/verify.js --hook <config>` の実体を、
// 子プロセスで起動して固める。runVerifyHook の判定そのものは verify.test.js が関数で見ている —
// ここで見るのは入口 (main / readStdin / 直接起動の判定) と、その結果が stdout・終了コード・
// 状態ファイルにどう出るか。起動は shell を通さず argv で渡す (script の解決は src/hooks.js の
// hookCommand と同じ)。shell へ渡す起動行のクォートは hooks.test.js の担当。

const VERIFY_SCRIPT = fileURLToPath(new URL('../src/verify.js', import.meta.url));
/** hook の子が戻らないときにテストを永久に掴まない上限 (検証コマンドは node -e だけ) */
const HOOK_SPAWN_TIMEOUT_MS = 30_000;
const STOP_INPUT = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false });
const INTERNAL_ERROR = 'verify hook internal error: ';

/** config の command に置く検証コマンド。shell 経由で ubuntu / windows の両方を通る形 */
function exitCommand(code) {
  return `"${process.execPath}" -e "process.exit(${code})"`;
}

/** 一時ディレクトリに hook の config を置く。値が undefined のキーは JSON から落ちる (= 未設定) */
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-verify-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'verify-state.json');
  const configFile = join(dir, 'verify-config.json');
  const config = {
    command: exitCommand(7),
    cwd: dir,
    stateFile,
    maxRetries: 1,
    timeoutMs: HOOK_SPAWN_TIMEOUT_MS,
    ...overrides,
  };
  writeFileSync(configFile, JSON.stringify(config), 'utf8');
  return { configFile, stateFile, config };
}

/** verify.js を直接起動し、stdin を渡して閉じる。終了コードと stdout / stderr を返す */
function runHook(args, stdin = '') {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [VERIFY_SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: HOOK_SPAWN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // 使い方の誤りでは stdin を読まずに終わる。先に閉じられた pipe への書き込みは結果に関係しない
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** 内部エラーで止まったこと: exit 1・stdout は空・stderr の先頭に理由 */
function assertInternalError(res, prefix, label) {
  assert.equal(res.code, 1, `${label}: exit code (stderr: ${res.stderr})`);
  assert.equal(res.stdout, '', `${label}: stdout は空`);
  assert.ok(
    res.stderr.startsWith(`${INTERNAL_ERROR}${prefix}`),
    `${label}: stderr の先頭が「${INTERNAL_ERROR}${prefix}」でない: ${res.stderr}`,
  );
}

test('NG なら block の JSON を stdout に出し、状態ファイルに試行を残して exit 0', async (t) => {
  const { configFile, stateFile, config } = setup(t, { command: exitCommand(7), maxRetries: 1 });
  const res = await runHook(['--hook', configFile], STOP_INPUT);

  assert.equal(res.code, 0, res.stderr);
  const response = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(response).sort(), ['decision', 'reason']);
  assert.equal(response.decision, 'block');
  assert.ok(response.reason.startsWith('verify が失敗しました (exit 7)。'), response.reason);

  const state = readVerifyState(stateFile);
  assert.ok(state, '親が読める形の状態ファイルが残る');
  assert.equal(state.attempts, 1);
  assert.equal(state.blocksUsed, 1);
  assert.equal(state.stopHookActive, false);
  assert.equal(state.lastResult.ok, false);
  assert.equal(state.lastResult.code, 7);
  assert.equal(state.lastResult.command, config.command);
});

test('maxRetries を使い切った NG は stdout に何も出さず、状態だけ進める', async (t) => {
  // 1 回目で block を使い切り、2 回目 (Claude Code が stop_hook_active: true で再び叩く) は通す。
  // 回数は hook の別プロセスをまたいで状態ファイルで数える
  const { configFile, stateFile } = setup(t, { command: exitCommand(7), maxRetries: 1 });
  const first = await runHook(['--hook', configFile], STOP_INPUT);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).decision, 'block');

  const second = await runHook(
    ['--hook', configFile],
    JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, '');
  const state = readVerifyState(stateFile);
  assert.equal(state.attempts, 2);
  assert.equal(state.blocksUsed, 1);
  assert.equal(state.stopHookActive, true);
  assert.equal(state.lastResult.ok, false);
  assert.equal(state.lastResult.code, 7);

  // maxRetries 0 は最初の NG から block しない
  const noRetry = setup(t, { command: exitCommand(3), maxRetries: 0 });
  const res = await runHook(['--hook', noRetry.configFile], STOP_INPUT);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '');
  const noRetryState = readVerifyState(noRetry.stateFile);
  assert.equal(noRetryState.attempts, 1);
  assert.equal(noRetryState.blocksUsed, 0);
  assert.equal(noRetryState.lastResult.code, 3);
});

test('合格は stdout に何も出さず、状態だけ残して exit 0', async (t) => {
  const { configFile, stateFile } = setup(t, { command: exitCommand(0), maxRetries: 3 });
  const res = await runHook(['--hook', configFile], STOP_INPUT);

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '');
  const state = readVerifyState(stateFile);
  assert.equal(state.attempts, 1);
  assert.equal(state.blocksUsed, 0);
  assert.equal(state.lastResult.ok, true);
  assert.equal(state.lastResult.code, 0);
});

test('空の stdin は {} として扱い、Stop と同じに検証して block する', async (t) => {
  for (const [label, stdin] of [['空', ''], ['空白と改行だけ', ' \n\t\r\n ']]) {
    const { configFile, stateFile } = setup(t, { command: exitCommand(5), maxRetries: 1 });
    const res = await runHook(['--hook', configFile], stdin);

    assert.equal(res.code, 0, `${label}: ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).decision, 'block', label);
    const state = readVerifyState(stateFile);
    assert.equal(state?.attempts, 1, label);
    assert.equal(state.blocksUsed, 1, label);
    assert.equal(state.stopHookActive, false, label);
    assert.equal(state.lastResult.code, 5, label);
  }
});

test('設定の不備は stderr に理由を出して exit 1 で止まり、状態ファイルを書かない', async (t) => {
  const command = 'TypeError: verify hook command が未設定です';
  const cwd = 'TypeError: verify hook cwd が未設定です';
  const stateFile = 'TypeError: verify hook stateFile が未設定です';
  const maxRetries = 'TypeError: verify hook maxRetries は 0〜3 で指定します';
  const timeoutMs = 'TypeError: verify hook timeoutMs は正の整数で指定します';
  const cases = [
    ['command が無い', { command: undefined }, command],
    ['command が空文字', { command: '' }, command],
    ['command が空白だけ', { command: '   ' }, command],
    ['command が文字列でない', { command: 1 }, command],
    ['cwd が無い', { cwd: undefined }, cwd],
    ['cwd が空文字', { cwd: '' }, cwd],
    ['stateFile が無い', { stateFile: undefined }, stateFile],
    ['stateFile が空文字', { stateFile: '' }, stateFile],
    ['maxRetries が無い', { maxRetries: undefined }, maxRetries],
    ['maxRetries が負', { maxRetries: -1 }, maxRetries],
    ['maxRetries が 3 を超える', { maxRetries: 4 }, maxRetries],
    ['maxRetries が整数でない', { maxRetries: 1.5 }, maxRetries],
    ['maxRetries が文字列', { maxRetries: '1' }, maxRetries],
    ['timeoutMs が無い', { timeoutMs: undefined }, timeoutMs],
    ['timeoutMs が 0', { timeoutMs: 0 }, timeoutMs],
    ['timeoutMs が負', { timeoutMs: -1 }, timeoutMs],
    ['timeoutMs が整数でない', { timeoutMs: 1.5 }, timeoutMs],
    ['timeoutMs が文字列', { timeoutMs: '1000' }, timeoutMs],
  ];
  for (const [label, overrides, prefix] of cases) {
    const fixture = setup(t, overrides);
    const res = await runHook(['--hook', fixture.configFile], STOP_INPUT);
    assertInternalError(res, prefix, label);
    assert.equal(existsSync(fixture.stateFile), false, `${label}: 状態ファイルは作らない`);
  }

  // config がオブジェクトでない
  const fixture = setup(t);
  writeFileSync(fixture.configFile, 'null', 'utf8');
  const res = await runHook(['--hook', fixture.configFile], STOP_INPUT);
  assertInternalError(res, 'TypeError: verify hook config が不正です', 'config が null');
  assert.equal(existsSync(fixture.stateFile), false);
});

test('Stop 以外の hook_event_name は stderr に理由を出して exit 1 で止まり、状態ファイルを書かない', async (t) => {
  for (const event of ['SubagentStop', 'PreToolUse']) {
    const { configFile, stateFile } = setup(t, { command: exitCommand(0) });
    const res = await runHook(['--hook', configFile], JSON.stringify({ hook_event_name: event }));
    assertInternalError(res, `Error: verify hook は Stop 専用です: ${event}`, event);
    assert.equal(existsSync(stateFile), false, `${event}: 状態ファイルは作らない`);
  }
});

test('JSON でない stdin は stderr に理由を出して exit 1 で止まり、状態ファイルを書かない', async (t) => {
  for (const stdin of ['not json', '{"hook_event_name": "Stop"']) {
    const { configFile, stateFile } = setup(t, { command: exitCommand(0) });
    const res = await runHook(['--hook', configFile], stdin);
    assertInternalError(res, 'SyntaxError: ', JSON.stringify(stdin));
    assert.equal(existsSync(stateFile), false, `${JSON.stringify(stdin)}: 状態ファイルは作らない`);
  }
});

test('--hook の引数が無ければ使い方を stderr に出して exit 1 で止まる', async () => {
  const usage = 'Error: 使い方: node verify.js --hook <config.json>';
  for (const [label, args] of [['--hook だけ', ['--hook']], ['--hook の値が空文字', ['--hook', '']], ['引数なし', []]]) {
    const res = await runHook(args, STOP_INPUT);
    assertInternalError(res, usage, label);
  }
});
