import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PI_EXTENSION_FILE, buildPiArgs, createPiEventReader, runPi,
} from '../src/pi.js';
import { PI_CONFIG_ENV, PI_REPORT_TOOL } from '../src/pi-policy.js';
import { readTraceEntries } from '../src/trace.js';

// src/pi.js — pi ランタイムの起動と JSON イベントの読み取り。実物の pi もモデルも起動しない
// (偽の子プロセスが JSONL を吐き、拡張の役 = 報告ファイルの書き込みも偽物がやる)。

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-pitest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const role = join(dir, 'role.md');
  writeFileSync(role, '# 役割');
  return { dir, role };
}

const line = (e) => `${JSON.stringify(e)}\n`;
const assistant = (content, usage, extra = {}) => ({
  type: 'message_end',
  message: { role: 'assistant', content, usage, stopReason: 'stop', ...extra },
});
const usageOf = (input, output, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total: 0.01 } });

/**
 * 偽の pi。起動引数・環境・stdin を seen へ残し、events を stdout へ流して終わる。
 * report を渡すと、拡張の代わりに設定ファイルが指す報告ファイルへ書く
 */
function fakePiSpawn(seen, {
  events = [], exitCode = 0, report = null, chunked = false, stderr = '', hang = false, pid = 4242,
} = {}) {
  return (bin, args, opts) => {
    seen.bin = bin;
    seen.args = args;
    seen.opts = opts;
    seen.stdin = '';
    seen.config = JSON.parse(readFileSync(opts.env[PI_CONFIG_ENV], 'utf8'));
    const child = new EventEmitter();
    // 停止の試験では pid を持たせない — killTree は Windows で taskkill を本物の pid へ撃つ
    child.pid = pid ?? undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write: (s) => { seen.stdin += s; }, end: () => {}, on: () => {} };
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal ?? 'SIGTERM'); };
    seen.child = child;
    if (hang) return child;
    setImmediate(() => {
      if (report) writeFileSync(seen.config.report.file, JSON.stringify(report));
      const text = events.map(line).join('');
      if (chunked) for (const ch of text.match(/[\s\S]{1,7}/g) ?? []) child.stdout.emit('data', ch);
      else child.stdout.emit('data', text);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}

const runPiT = (t, seen, opts = {}, fake = {}) => {
  const { role } = scratch(t);
  return runPi({
    cwd: process.cwd(),
    model: 'openai/gpt-6.1-sol',
    prompt: 'プロンプト本文',
    rolePromptFile: role,
    resolveCmdImpl: () => ['node', 'C:/pi/cli.js'],
    spawnImpl: fakePiSpawn(seen, fake),
    ...opts,
  });
};

test('buildPiArgs: JSON モード・セッションなし・この job の拡張だけ・役割文はファイル', () => {
  const args = buildPiArgs({
    model: 'openai/gpt-6.1-sol', effort: 'xhigh', tools: ['read', 'bash'], rolePromptFile: 'C:/t/role.md', imagePaths: ['C:/t/a.png'],
  });
  assert.deepEqual(args, [
    '--mode', 'json', '--no-session',
    '--no-extensions', '-e', PI_EXTENSION_FILE,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve',
    '--model', 'openai/gpt-6.1-sol', '--thinking', 'xhigh',
    '--tools', 'read,bash',
    '--append-system-prompt', 'C:/t/role.md',
    '@C:/t/a.png',
  ]);
  assert.ok(existsSync(PI_EXTENSION_FILE), '拡張のファイルが実在する');
  // 道具 0 件は --no-tools (空の --tools は解釈が CLI 次第)
  const none = buildPiArgs({ model: 'm', tools: [], rolePromptFile: 'r' });
  assert.ok(none.includes('--no-tools') && !none.includes('--tools') && !none.includes('--thinking'));
});

test('createPiEventReader: usage を合算し、最後の本文・エラー・道具の終わりを拾う', () => {
  const ends = [];
  const reader = createPiEventReader({ onToolEnd: (e) => ends.push(e) });
  reader.onEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.js' } });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false });
  reader.onEvent({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'x' } });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', isError: true });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 'n', toolName: 'read', parentToolCallId: 't9' });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 'r', toolName: PI_REPORT_TOOL, isError: false });
  reader.onEvent(assistant([{ type: 'toolCall' }], usageOf(100, 10, 500)));
  reader.onEvent(assistant([{ type: 'text', text: '  終わりました  ' }], usageOf(50, 5, 600)));
  reader.onEvent({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '人' }] } });
  reader.onEvent(null);
  const s = reader.state;
  assert.equal(s.numTurns, 2);
  assert.equal(s.lastText, '終わりました');
  assert.deepEqual(s.usage, { input: 150, output: 15, cacheRead: 1100, cacheWrite: 0 });
  assert.equal(Math.round(s.cost * 100), 2);
  assert.equal(s.toolCalls, 2, '入れ子と報告の道具は数えない');
  assert.deepEqual(ends.map((e) => [e.toolName, e.args, e.isError]), [
    ['read', { path: 'a.js' }, false], ['bash', { command: 'x' }, true], ['submit_report', null, false],
  ]);
  // エラーで終わった応答は失敗として残り、後の成功で消える
  reader.onEvent(assistant([], usageOf(1, 1), { stopReason: 'error', errorMessage: '429 rate limited' }));
  assert.equal(s.lastError, '429 rate limited');
  reader.onEvent(assistant([{ type: 'text', text: 'やり直した' }], usageOf(1, 1)));
  assert.equal(s.lastError, null);
  // 最終回答は最後の応答の本文だけ — 本文の無い応答で終わったら空 (途中の独り言を持ち越さない)
  reader.onEvent(assistant([{ type: 'toolCall' }], usageOf(1, 1)));
  assert.equal(s.lastText, '');
});

test('createPiEventReader: 拡張が止めた呼び出しは軌跡にも数にも入れない', () => {
  const ends = [];
  const blocked = new Set(['t2']);
  const reader = createPiEventReader({ onToolEnd: (e) => ends.push(e.toolName), isBlocked: (id) => blocked.has(id) });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', isError: true });
  reader.onEvent({ type: 'tool_execution_end', toolCallId: 't3', toolName: 'bash', isError: true });
  assert.deepEqual(ends, ['read', 'bash']);
  assert.equal(reader.state.toolCalls, 2);
});

test('runPi: プロンプトは stdin、拡張の設定は環境変数が指すファイル、秘密は渡さない', async (t) => {
  const seen = {};
  process.env.COMMUNITD_TEST_SECRET = 'zzz';
  t.after(() => { delete process.env.COMMUNITD_TEST_SECRET; });
  const spawned = [];
  const res = await runPiT(t, seen, {
    effort: 'high',
    allowedTools: ['Read', 'Bash(git *)'],
    permissionMode: 'default',
    addDirs: ['C:/ref'],
    scrubEnvKeys: ['COMMUNITD_TEST_SECRET'],
    verify: { command: 'npm test', cwd: 'C:/w', stateFile: 'C:/s.json', maxRetries: 2, timeoutMs: 1000 },
    onSpawn: (info) => spawned.push(info),
  }, { events: [assistant([{ type: 'text', text: '読みました' }], usageOf(10, 2))] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.result, '読みました');
  assert.equal(seen.stdin, 'プロンプト本文');
  assert.equal(seen.bin, 'node');
  assert.equal(seen.args[0], 'C:/pi/cli.js');
  assert.ok(seen.args.includes('--tools'));
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], 'read,grep,find,ls,bash', 'Edit も報告もない');
  assert.equal(seen.opts.env.COMMUNITD_TEST_SECRET, undefined);
  assert.equal(seen.opts.env.PI_TELEMETRY, '0');
  assert.equal(seen.opts.env.PI_OFFLINE, '1');
  assert.deepEqual(seen.config.policy, {
    cwd: process.cwd(), addDirs: ['C:/ref'], permissionMode: 'default', allowedTools: ['Read', 'Bash(git *)'], tools: null, disallowedTools: [],
  });
  assert.equal(seen.config.report, null);
  assert.deepEqual(seen.config.verify, { command: 'npm test', cwd: 'C:/w', stateFile: 'C:/s.json', maxRetries: 2, timeoutMs: 1000 });
  assert.deepEqual(res.usage, { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 });
  assert.equal(res.numTurns, 1);
  assert.deepEqual(spawned.map((s) => [s.pid, s.runtime]), [[4242, 'pi']]);
  // 一時ディレクトリ (設定・報告・止めた記録) は終わったら消す
  assert.equal(existsSync(seen.opts.env[PI_CONFIG_ENV]), false);
});

test('runPi: スキーマを渡すと報告の道具を見せ、拡張が書いた引数を structuredOutput で返す', async (t) => {
  const seen = {};
  const schema = { type: 'object', required: ['body'], properties: { body: { type: 'string' } } };
  const res = await runPiT(t, seen, { jsonSchema: schema, allowedTools: ['Read'] }, {
    report: { body: '報告の本文' },
    events: [assistant([{ type: 'toolCall' }], usageOf(10, 2))],
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.structuredOutput, { body: '報告の本文' });
  assert.equal(res.result, JSON.stringify({ body: '報告の本文' }), 'claude と同じく result は JSON 文字列');
  assert.deepEqual(seen.config.report.schema, schema);
  assert.ok(seen.args[seen.args.indexOf('--tools') + 1].endsWith(PI_REPORT_TOOL));
});

test('runPi: 報告を出さずに終えたら structuredOutput は null で、本文へ縮退する (様式不履行はブリッジが扱う)', async (t) => {
  const res = await runPiT(t, {}, { jsonSchema: { type: 'object' } }, {
    events: [assistant([{ type: 'text', text: '文章で終えました' }], usageOf(1, 1))],
  });
  assert.equal(res.ok, true);
  assert.equal(res.structuredOutput, null);
  assert.equal(res.result, '文章で終えました');
});

test('runPi: 道具の終わりごとにツール軌跡へ 1 行 (行が chunk で割れても読める)', async (t) => {
  const { dir } = scratch(t);
  const traceFile = join(dir, 'trace.jsonl');
  const res = await runPiT(t, {}, { traceFile, allowedTools: ['Read', 'Bash'] }, {
    chunked: true,
    events: [
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'src/x.js' } },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', isError: false },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'npm test' } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', isError: true },
      assistant([{ type: 'text', text: 'done' }], usageOf(1, 1)),
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.toolCalls, 2);
  assert.deepEqual(readTraceEntries(traceFile).map(({ tool, arg, failed }) => [tool, arg, failed]), [
    ['Read', 'x.js', false], ['Bash', 'npm test', true],
  ]);
});

test('runPi: 止めた呼び出しは permissionDenials で返し (承認の候補になる)、軌跡には載せない', async (t) => {
  const { dir } = scratch(t);
  const traceFile = join(dir, 'trace.jsonl');
  const seen = {};
  const spawnImpl = fakePiSpawn(seen, {
    events: [
      { type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'npm test' } },
      { type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', isError: true },
      { type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'a.js' } },
      { type: 'tool_execution_end', toolCallId: 'r1', toolName: 'read', isError: false },
      assistant([{ type: 'text', text: 'x' }], usageOf(1, 1)),
    ],
  });
  const wrapped = (bin, args, opts) => {
    const child = spawnImpl(bin, args, opts);
    // 拡張の代わりに「止めた」記録を書く (pi が実行の終わりを出すより先に書かれる)
    writeFileSync(
      seen.config.denialsFile,
      `${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, toolCallId: 'b1' })}\nbroken\n`,
    );
    return child;
  };
  const res = await runPiT(t, seen, { spawnImpl: wrapped, traceFile });
  assert.deepEqual(res.permissionDenials, [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }], 'toolCallId は返す形に含めない');
  assert.equal(res.stallBlocks, 0);
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(readTraceEntries(traceFile).map((e) => e.tool), ['Read']);
});

test('runPi: 足踏みで止めた呼び出しは承認の候補にせず件数だけ返し、軌跡にも載せない', async (t) => {
  const { dir } = scratch(t);
  const traceFile = join(dir, 'trace.jsonl');
  const seen = {};
  const spawnImpl = fakePiSpawn(seen, {
    events: [
      { type: 'tool_execution_start', toolCallId: 'g1', toolName: 'bash', args: { command: 'git status' } },
      { type: 'tool_execution_end', toolCallId: 'g1', toolName: 'bash', isError: false },
      { type: 'tool_execution_start', toolCallId: 'g3', toolName: 'bash', args: { command: 'git status' } },
      { type: 'tool_execution_end', toolCallId: 'g3', toolName: 'bash', isError: true },
      assistant([{ type: 'text', text: 'x' }], usageOf(1, 1)),
    ],
  });
  const wrapped = (bin, args, opts) => {
    const child = spawnImpl(bin, args, opts);
    writeFileSync(
      seen.config.denialsFile,
      `${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, toolCallId: 'g3', stall: true })}\n`,
    );
    return child;
  };
  const res = await runPiT(t, seen, { spawnImpl: wrapped, traceFile });
  assert.equal(res.ok, true, res.error);
  // 権限で止めたのではない — 候補にすると「Bash(git status) を足しますか」という的外れな承認カードが出る
  assert.deepEqual(res.permissionDenials, []);
  assert.equal(res.stallBlocks, 1);
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(readTraceEntries(traceFile).map((e) => [e.tool, e.failed]), [['Bash', false]]);
});

test('runPi: 失敗の経路 — 非 0 終了・モデルのエラー・本文なし', async (t) => {
  const exit = await runPiT(t, {}, {}, { exitCode: 1, stderr: 'Error: No models available' });
  assert.equal(exit.ok, false);
  assert.match(exit.error, /pi exit 1/);
  assert.match(exit.detail, /No models available/);
  const modelError = await runPiT(t, {}, {}, {
    events: [assistant([], usageOf(1, 0), { stopReason: 'error', errorMessage: 'usage limit reached' })],
  });
  assert.equal(modelError.ok, false);
  assert.match(modelError.error, /usage limit reached/);
  const empty = await runPiT(t, {}, {}, { events: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no output/);
});

test('runPi: 起動前の断り — 停止済み・知らないモード・役割文が無い・pi が見つからない', async (t) => {
  const stopped = await runPiT(t, {}, { handle: { stopRequested: true } });
  assert.equal(stopped.aborted, true);
  const mode = await runPiT(t, {}, { permissionMode: 'dontAsk' });
  assert.match(mode.error, /dontAsk/);
  // --append-system-prompt は無いファイルを「文字列そのもの」として読むので、起動しない
  const noRole = await runPiT(t, {}, { rolePromptFile: join(tmpdir(), 'communitd-no-such-role.md') });
  assert.match(noRole.error, /役割文/);
  const noCmd = await runPiT(t, {}, { resolveCmdImpl: () => null });
  assert.match(noCmd.error, /pi を起動できません/);
});

test('runPi: spawn の同期例外でも一時ディレクトリを残さない', async (t) => {
  let configPath = null;
  const res = await runPiT(t, {}, {
    spawnImpl: (bin, args, opts) => { configPath = opts.env[PI_CONFIG_ENV]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /spawn failed: nope/);
  assert.equal(existsSync(configPath), false);
});

test('runPi: 停止は子プロセスを止め、閉じたら aborted を返して一時ディレクトリを消す', async (t) => {
  const handle = {};
  const seen = {};
  const promise = runPiT(t, seen, { handle }, { hang: true, pid: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof handle.abort, 'function');
  handle.abort();
  assert.equal(handle.stopRequested, true);
  assert.deepEqual(seen.child.killed, ['SIGKILL']);
  const pending = await Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), 30))]);
  assert.equal(pending, 'pending', 'close が来るまでは返らない (次の job と並走させない)');
  seen.child.emit('close', null);
  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
  assert.equal(existsSync(seen.opts.env[PI_CONFIG_ENV]), false);
});
