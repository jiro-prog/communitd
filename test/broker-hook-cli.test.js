import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANS_SUFFIX, ASK_SUFFIX } from '../src/broker.js';

// Claude Code が PreToolUse hook として叩く `node src/broker.js --hook <config>` の実体を、
// 子プロセスで起動して固める。runApprovalHook の判定そのものは broker.test.js が関数で見ている —
// ここで見るのは入口 (main / readStdin / 直接起動の判定) と、その失敗を deny に畳む catch。
// **畳み損ねて異常終了になると deny が読まれず、承認を経ずにツールが動く** (src/broker.js の注記)。
// 起動は shell を通さず argv で渡す (script の解決は src/hooks.js の hookCommand と同じ)。

const BROKER_SCRIPT = fileURLToPath(new URL('../src/broker.js', import.meta.url));
/** hook の子が戻らないときにテストを永久に掴まない上限 */
const HOOK_SPAWN_TIMEOUT_MS = 30_000;
const FETCH_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'WebFetch',
  tool_input: { url: 'https://example.com/' },
};
const INTERNAL_ERROR_REASON = '承認ブローカの内部エラーのため実行しません: ';
const INTERNAL_ERROR_LOG = 'approval hook internal error: ';

/**
 * 一時ディレクトリに hook の config を置く。ask の置き場は config と別のディレクトリにして、
 * 「ask を書いていない」を中身が空であることで見る
 */
function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'communitd-broker-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const askDir = join(root, 'asks');
  mkdirSync(askDir);
  const configFile = join(root, 'approval-hook.json');
  writeFileSync(configFile, JSON.stringify({ dir: askDir, waitMs: 1000, pollMs: 10, ...overrides }), 'utf8');
  return { root, askDir, configFile };
}

/** broker.js を直接起動し、stdin を渡して閉じる。終了コードと stdout / stderr を返す */
function runHook(args, stdin = '') {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BROKER_SCRIPT, ...args], {
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
    // 使い方の誤り・config の読み損じでは stdin を読まずに終わる。先に閉じられた pipe への書き込みは結果に関係しない
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** 子と同じ node で投げさせた例外の message (deny の理由に載る文面を、子の実装に頼らず作る) */
function thrownMessage(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  throw new Error('例外が出なかった');
}

/** 内部エラーを deny に畳んだこと: exit 0・stdout は deny の JSON 1 個・stderr の先頭に理由 */
function assertInternalDeny(res, message, label) {
  assert.equal(res.code, 0, `${label}: exit code (stderr: ${res.stderr})`);
  assert.deepEqual(JSON.parse(res.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${INTERNAL_ERROR_REASON}${message}`,
    },
  }, label);
  assert.ok(res.stderr.startsWith(INTERNAL_ERROR_LOG), `${label}: stderr の先頭が「${INTERNAL_ERROR_LOG}」でない: ${res.stderr}`);
}

async function until(fn, timeoutMs = HOOK_SPAWN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('待ち切れなかった');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('--hook の引数が無ければ、使い方を理由にした deny を出して exit 0', async () => {
  const usage = '使い方: node broker.js --hook <config.json>';
  for (const [label, args] of [['--hook だけ', ['--hook']], ['--hook の値が空文字', ['--hook', '']], ['引数なし', []]]) {
    const res = await runHook(args, JSON.stringify(FETCH_INPUT));
    assertInternalDeny(res, usage, label);
    assert.ok(res.stderr.startsWith(`${INTERNAL_ERROR_LOG}Error: ${usage}`), `${label}: ${res.stderr}`);
  }
});

test('config が読めなければ deny を出して exit 0 で、ask は書かない', async (t) => {
  // 置かれていない
  const missing = setup(t);
  const missingPath = join(missing.root, 'missing.json');
  const res = await runHook(['--hook', missingPath], JSON.stringify(FETCH_INPUT));
  assertInternalDeny(res, thrownMessage(() => readFileSync(missingPath, 'utf8')), 'config が無い');
  assert.deepEqual(readdirSync(missing.askDir), [], 'config が無い: ask は書かない');

  // JSON でない
  const broken = setup(t);
  const brokenText = '{"dir": ';
  writeFileSync(broken.configFile, brokenText, 'utf8');
  const brokenRes = await runHook(['--hook', broken.configFile], JSON.stringify(FETCH_INPUT));
  assertInternalDeny(brokenRes, thrownMessage(() => JSON.parse(brokenText)), 'config が JSON でない');
  assert.ok(brokenRes.stderr.startsWith(`${INTERNAL_ERROR_LOG}SyntaxError: `), brokenRes.stderr);
  assert.deepEqual(readdirSync(broken.askDir), [], 'config が JSON でない: ask は書かない');

  // JSON だが config として不正 (検査は stdin を読んだ後の runApprovalHook で落ちる)
  const invalid = setup(t);
  writeFileSync(invalid.configFile, 'null', 'utf8');
  const invalidRes = await runHook(['--hook', invalid.configFile], JSON.stringify(FETCH_INPUT));
  assertInternalDeny(invalidRes, '承認 hook config が不正です', 'config が null');
  assert.ok(invalidRes.stderr.startsWith(`${INTERNAL_ERROR_LOG}TypeError: `), invalidRes.stderr);
});

test('stdin が JSON として読めなければ deny を出して exit 0 で、ask は書かない', async (t) => {
  // config は正しいもの (同じ setup で PreToolUse 以外は null まで進む — 下のテスト)。
  // 理由の文面を stdin を JSON.parse した例外と突き合わせて、config 側の失敗と取り違えない
  for (const stdin of ['not json', '{"hook_event_name": "PreToolUse"']) {
    const { askDir, configFile } = setup(t);
    const res = await runHook(['--hook', configFile], stdin);
    const label = JSON.stringify(stdin);
    assertInternalDeny(res, thrownMessage(() => JSON.parse(stdin)), label);
    assert.ok(res.stderr.startsWith(`${INTERNAL_ERROR_LOG}SyntaxError: `), `${label}: ${res.stderr}`);
    assert.deepEqual(readdirSync(askDir), [], `${label}: ask は書かない`);
  }
});

test('ask の置き場に書けなければ deny を出して exit 0', async (t) => {
  // 「書けないは deny」を runApprovalHook の外 (main の catch) で畳んでいる経路
  const { root, configFile } = setup(t);
  const goneDir = join(root, 'gone');
  writeFileSync(configFile, JSON.stringify({ dir: goneDir, waitMs: 1000, pollMs: 10 }), 'utf8');
  const res = await runHook(['--hook', configFile], JSON.stringify(FETCH_INPUT));
  assert.equal(res.code, 0, res.stderr);
  const output = JSON.parse(res.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.startsWith(`${INTERNAL_ERROR_REASON}ENOENT`),
    output.hookSpecificOutput.permissionDecisionReason);
  assert.ok(res.stderr.startsWith(INTERNAL_ERROR_LOG), res.stderr);
});

test('PreToolUse 以外の hook_event_name は stdout に何も出さず exit 0 で、ask は書かない', async (t) => {
  for (const event of ['PostToolUse', 'Stop']) {
    const { askDir, configFile } = setup(t);
    const res = await runHook(['--hook', configFile], JSON.stringify({ ...FETCH_INPUT, hook_event_name: event }));
    assert.equal(res.code, 0, `${event}: exit code (stderr: ${res.stderr})`);
    assert.equal(res.stdout, '', `${event}: stdout は空`);
    assert.equal(res.stderr, '', `${event}: stderr は空`);
    assert.deepEqual(readdirSync(askDir), [], `${event}: ask は書かない`);
  }
});

test('PreToolUse は ask を書いて応答を待ち、届いた判定を stdout に出して exit 0', async (t) => {
  // ブリッジの待機上限まで待たずに、テストがブリッジ役として ans を書く
  const { askDir, configFile } = setup(t, { waitMs: 20_000 });
  const running = runHook(['--hook', configFile], JSON.stringify(FETCH_INPUT));
  let exited = null;
  running.then((res) => { exited = res; }, () => {});
  const name = await until(() => {
    if (exited) throw new Error(`ask を書く前に hook が終わった (exit ${exited.code}): ${exited.stdout}${exited.stderr}`);
    return readdirSync(askDir).find((n) => n.endsWith(ASK_SUFFIX));
  });
  const id = name.slice(0, -ASK_SUFFIX.length);
  writeFileSync(join(askDir, `${id}${ANS_SUFFIX}`), JSON.stringify({ decision: 'allow', reason: 'ok' }), 'utf8');

  const res = await running;
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' },
  });
  assert.equal(res.stderr, '');
});
