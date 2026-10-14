import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import communitd, {
  MAX_REPORT_NUDGES, MAX_SAME_CALLS, createCommunitdExtension, createRepeatGuard, readPiJobConfig,
} from '../src/pi-extension.js';
import { PI_CONFIG_ENV, PI_REPORT_TOOL } from '../src/pi-policy.js';

// src/pi-extension.js — pi が読み込む拡張。偽の pi (on / registerTool を記録するだけ) に載せて、
// 権限で止める・最終報告を受け取る・verify NG を差し戻す、の 3 つを固定する。実物の pi は起動しない。

function fakePi() {
  const handlers = new Map();
  const tools = [];
  return {
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    registerTool: (tool) => { tools.push(tool); },
    async emit(event, payload) {
      let last;
      for (const fn of handlers.get(event) ?? []) last = await fn(payload, {});
      return last;
    },
    handlers,
    tools,
  };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'communitd-piext-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'a.js'), 'a');
  return { root, cwd };
}

const REPORT_SCHEMA = { type: 'object', required: ['body'], properties: { body: { type: 'string' } } };

test('readPiJobConfig: 環境変数・JSON・policy・作業ディレクトリのどれが欠けても理由つきで断る', (t) => {
  const { root, cwd } = workspace(t);
  assert.equal(readPiJobConfig({}).ok, false);
  assert.match(readPiJobConfig({ [PI_CONFIG_ENV]: join(root, 'none.json') }).reason, /読めません/);
  const bad = join(root, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(readPiJobConfig({ [PI_CONFIG_ENV]: bad }).ok, false);
  const noPolicy = join(root, 'np.json');
  writeFileSync(noPolicy, JSON.stringify({ report: null }));
  assert.match(readPiJobConfig({ [PI_CONFIG_ENV]: noPolicy }).reason, /policy/);
  const noCwd = join(root, 'nc.json');
  writeFileSync(noCwd, JSON.stringify({ policy: { allowedTools: [] } }));
  assert.match(readPiJobConfig({ [PI_CONFIG_ENV]: noCwd }).reason, /作業ディレクトリ/);
  const good = join(root, 'good.json');
  writeFileSync(good, JSON.stringify({ policy: { cwd } }));
  assert.equal(readPiJobConfig({ [PI_CONFIG_ENV]: good }).ok, true);
});

test('設定を読めない拡張はすべての道具を止める (fail-closed)', async (t) => {
  const prev = process.env[PI_CONFIG_ENV];
  delete process.env[PI_CONFIG_ENV];
  t.after(() => { if (prev !== undefined) process.env[PI_CONFIG_ENV] = prev; });
  const pi = fakePi();
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try { communitd(pi); } finally { process.stderr.write = stderr; }
  const verdict = await pi.emit('tool_call', { toolName: 'read', input: { path: 'a.js' } });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /設定を読めない/);
  assert.equal(pi.tools.length, 0, '報告の道具も登録しない');
});

test('tool_call: 権限の外は理由つきで止め、止めた呼び出しを claude の形で記録する', async (t) => {
  const { root, cwd } = workspace(t);
  const denialsFile = join(root, 'denials.jsonl');
  const pi = fakePi();
  createCommunitdExtension({
    config: { policy: { cwd, permissionMode: 'default', allowedTools: ['Read', 'Bash(git *)'] }, denialsFile },
  })(pi);
  assert.equal(await pi.emit('tool_call', { toolName: 'bash', input: { command: 'git status' } }), undefined);
  const blocked = await pi.emit('tool_call', { toolName: 'bash', input: { command: 'npm test' } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /npm test/);
  const write = await pi.emit('tool_call', { toolName: 'write', input: { path: 'a.js', content: 'x' } });
  assert.equal(write.block, true);
  const lines = readFileSync(denialsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // toolCallId は runPi が止めた呼び出しを軌跡から外すための印
  assert.deepEqual(lines, [
    { tool_name: 'Bash', tool_input: { command: 'npm test' }, toolCallId: null },
    { tool_name: 'Write', tool_input: { file_path: 'a.js' }, toolCallId: null },
  ]);
  await pi.emit('tool_call', { toolName: 'bash', toolCallId: 'call-9', input: { command: 'rm x' } });
  assert.equal(JSON.parse(readFileSync(denialsFile, 'utf8').trim().split('\n').at(-1)).toolCallId, 'call-9');
});

test('createRepeatGuard: 直前とまったく同じ呼び出しが続いた回数を数え、上限を超えた回を知らせる', () => {
  assert.equal(MAX_SAME_CALLS, 2);
  const guard = createRepeatGuard();
  const counts = (calls) => calls.map(([tool, input]) => {
    const r = guard.observe(tool, input);
    return r.repeated ? `${r.count}!` : r.count;
  });
  assert.deepEqual(counts([
    ['bash', { command: 'npm test' }],
    ['bash', { command: 'npm test' }],
    ['bash', { command: 'npm test' }],
    ['bash', { command: 'npm test' }],
  ]), [1, 2, '3!', '4!'], '止めた回も数え続け、引数を変えるまで止め続ける');
  // 引数のキーの順は問わない
  guard.reset();
  assert.deepEqual(counts([
    ['read', { path: 'a.js', offset: 1 }],
    ['read', { offset: 1, path: 'a.js' }],
    ['read', { offset: 1, path: 'a.js' }],
  ]), [1, 2, '3!']);
  // 違う呼び出しが 1 回でも挟まれば数え直す (編集してから読み直すのは普通の流れ)
  guard.reset();
  assert.deepEqual(counts([
    ['read', { path: 'a.js' }],
    ['edit', { path: 'a.js', edits: [] }],
    ['read', { path: 'a.js' }],
    ['read', { path: 'a.js' }],
    ['read', { path: 'a.js', offset: 10 }],
    ['grep', { pattern: 'x' }],
    ['grep', { pattern: 'y' }],
  ]), [1, 1, 1, 2, 1, 1, 1]);
});

test('tool_call: 権限で通る呼び出しでも、同じ形を続けて 3 回目からは止める (承認の候補にはしない)', async (t) => {
  const { root, cwd } = workspace(t);
  const denialsFile = join(root, 'denials.jsonl');
  const pi = fakePi();
  createCommunitdExtension({
    config: {
      policy: { cwd, permissionMode: 'default', allowedTools: ['Read', 'Bash'] },
      report: { schema: REPORT_SCHEMA, file: join(root, 'r.json') },
      denialsFile,
    },
  })(pi);
  const npmTest = (id) => pi.emit('tool_call', { toolName: 'bash', toolCallId: id, input: { command: 'npm test' } });
  assert.equal(await npmTest('c1'), undefined);
  assert.equal(await npmTest('c2'), undefined);
  const third = await npmTest('c3');
  assert.equal(third.block, true);
  assert.match(third.reason, /npm test/);
  assert.match(third.reason, /3 回目/);
  assert.equal((await npmTest('c4')).block, true, '引数を変えるまで止め続ける');
  const lines = readFileSync(denialsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { tool_name: 'Bash', tool_input: { command: 'npm test' }, toolCallId: 'c3', stall: true },
    { tool_name: 'Bash', tool_input: { command: 'npm test' }, toolCallId: 'c4', stall: true },
  ]);
  // 違う呼び出しを挟めば通る
  assert.equal(await pi.emit('tool_call', { toolName: 'read', input: { path: 'a.js' } }), undefined);
  assert.equal(await npmTest('c5'), undefined);

  // 最終報告と、拡張から呼んだ入れ子の呼び出しは数えない
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await pi.emit('tool_call', { toolName: PI_REPORT_TOOL, input: { body: 'x' } }), undefined);
    assert.equal(await pi.emit('tool_call', {
      toolName: 'read', toolCallId: `p/${i}`, parentToolCallId: 'p', input: { path: 'b.js' },
    }), undefined);
  }
  // 権限で止めた呼び出しは足踏みの印を付けない (従来どおり承認の候補)
  const denied = await pi.emit('tool_call', { toolName: 'write', input: { path: 'a.js', content: 'x' } });
  assert.equal(denied.block, true);
  assert.equal(JSON.parse(readFileSync(denialsFile, 'utf8').trim().split('\n').at(-1)).stall, undefined);
});

test('終わる直前に会話へ材料を差し込んだら (促し・verify の差し戻し)、足踏みを数え直す', async (t) => {
  const { root, cwd } = workspace(t);
  const pi = fakePi();
  createCommunitdExtension({
    config: {
      policy: { cwd, permissionMode: 'default', allowedTools: ['Bash'] },
      verify: { command: 'npm test', cwd, stateFile: join(root, 's.json'), maxRetries: 1, timeoutMs: 1 },
      report: { schema: REPORT_SCHEMA, file: join(root, 'r.json') },
    },
    runVerifyHookImpl: async () => ({ decision: 'block', reason: 'テストが落ちました' }),
  })(pi);
  const npmTest = () => pi.emit('tool_call', { toolName: 'bash', input: { command: 'npm test' } });
  await npmTest();
  await npmTest();
  assert.equal((await pi.emit('agent_before_settle', { outcome: 'completed' })).entries[0].customType, 'communitd-report');
  assert.equal(await npmTest(), undefined, '促しの後の 1 回目');
  await npmTest();
  await pi.tools[0].execute('c', { body: 'x' });
  assert.equal((await pi.emit('agent_before_settle', { outcome: 'completed' })).entries[0].customType, 'communitd-verify');
  assert.equal(await npmTest(), undefined, '差し戻しの後の 1 回目');
});

test('最終報告: スキーマを渡した job だけ道具を登録し、引数を報告ファイルへ書いて終える', async (t) => {
  const { root, cwd } = workspace(t);
  const reportFile = join(root, 'report.json');
  const pi = fakePi();
  createCommunitdExtension({ config: { policy: { cwd }, report: { schema: REPORT_SCHEMA, file: reportFile } } })(pi);
  assert.equal(pi.tools.length, 1);
  const [tool] = pi.tools;
  assert.equal(tool.name, PI_REPORT_TOOL);
  assert.equal(tool.parameters, REPORT_SCHEMA, '契約のスキーマをそのまま渡す');
  // 報告の道具は権限で止めない
  assert.equal(await pi.emit('tool_call', { toolName: PI_REPORT_TOOL, input: { body: 'x' } }), undefined);
  const out = await tool.execute('call-1', { body: 'できました' });
  assert.equal(out.terminate, true);
  assert.deepEqual(JSON.parse(readFileSync(reportFile, 'utf8')), { body: 'できました' });

  const none = fakePi();
  createCommunitdExtension({ config: { policy: { cwd } } })(none);
  assert.equal(none.tools.length, 0);
  const denied = await none.emit('tool_call', { toolName: PI_REPORT_TOOL, input: {} });
  assert.equal(denied.block, true);
});

test('終わる直前: 報告が無ければ促す (上限つき)、出ていれば何もしない', async (t) => {
  const { root, cwd } = workspace(t);
  const pi = fakePi();
  createCommunitdExtension({
    config: { policy: { cwd }, report: { schema: REPORT_SCHEMA, file: join(root, 'r.json') } },
  })(pi);
  for (let i = 0; i < MAX_REPORT_NUDGES; i += 1) {
    const nudge = await pi.emit('agent_before_settle', { outcome: 'completed' });
    assert.equal(nudge.continue, true);
    assert.match(nudge.entries[0].content, new RegExp(PI_REPORT_TOOL));
  }
  assert.equal(await pi.emit('agent_before_settle', { outcome: 'completed' }), undefined, '上限を超えて続けない');

  const done = fakePi();
  createCommunitdExtension({
    config: { policy: { cwd }, report: { schema: REPORT_SCHEMA, file: join(root, 'r2.json') } },
  })(done);
  await done.tools[0].execute('c', { body: 'ok' });
  assert.equal(await done.emit('agent_before_settle', { outcome: 'completed' }), undefined);
  // 止められた・落ちた回は促さない
  const aborted = fakePi();
  createCommunitdExtension({ config: { policy: { cwd }, report: { schema: REPORT_SCHEMA, file: join(root, 'r3.json') } } })(aborted);
  assert.equal(await aborted.emit('agent_before_settle', { outcome: 'aborted' }), undefined);
  assert.equal(await aborted.emit('agent_before_settle', { outcome: 'error' }), undefined);
});

test('終わる直前: verify NG は同じ会話へ差し戻し、古い報告を消して取り直す', async (t) => {
  const { root, cwd } = workspace(t);
  const reportFile = join(root, 'r.json');
  const verify = { command: 'npm test', cwd, stateFile: join(root, 'state.json'), maxRetries: 1, timeoutMs: 1000 };
  const calls = [];
  const verdicts = [{ decision: 'block', reason: 'テストが 2 件落ちました' }, null];
  const pi = fakePi();
  createCommunitdExtension({
    config: { policy: { cwd }, verify, report: { schema: REPORT_SCHEMA, file: reportFile } },
    runVerifyHookImpl: async (config, input) => { calls.push({ config, input }); return verdicts.shift(); },
  })(pi);
  await pi.tools[0].execute('c1', { body: '直す前' });
  const first = await pi.emit('agent_before_settle', { outcome: 'completed' });
  assert.equal(first.continue, true);
  assert.equal(first.entries[0].customType, 'communitd-verify');
  assert.match(first.entries[0].content, /テストが 2 件落ちました/);
  assert.deepEqual(calls[0].config, verify, 'verify の設定をそのまま runVerifyHook へ');
  assert.deepEqual(calls[0].input, { hook_event_name: 'Stop', stop_hook_active: false });
  // 差し戻し前の報告は消す (直した後に出し直さずに終えても、古い本文が合格として配送されない)
  assert.equal(existsSync(reportFile), false, '差し戻し前の報告が残っている');
  // 報告が無い回は、検証より先に促す (verify を丸ごともう 1 回走らせない)
  const nudge = await pi.emit('agent_before_settle', { outcome: 'completed' });
  assert.equal(nudge.entries[0].customType, 'communitd-report');
  assert.equal(calls.length, 1, '報告が無いのに verify を走らせている');
  await pi.tools[0].execute('c2', { body: '直した後' });
  assert.equal(await pi.emit('agent_before_settle', { outcome: 'completed' }), undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.stop_hook_active, true);
  assert.deepEqual(JSON.parse(readFileSync(reportFile, 'utf8')), { body: '直した後' });
});

test('終わる直前: 報告を出さないまま促しを使い切ったら、そこで 1 回だけ検証する', async (t) => {
  const { root, cwd } = workspace(t);
  const calls = [];
  const pi = fakePi();
  createCommunitdExtension({
    config: {
      policy: { cwd },
      verify: { command: 'x', cwd, stateFile: join(root, 's.json'), maxRetries: 1, timeoutMs: 1 },
      report: { schema: REPORT_SCHEMA, file: join(root, 'r.json') },
    },
    runVerifyHookImpl: async (config, input) => { calls.push(input); return null; },
  })(pi);
  for (let i = 0; i < MAX_REPORT_NUDGES; i += 1) {
    assert.equal((await pi.emit('agent_before_settle', { outcome: 'completed' })).entries[0].customType, 'communitd-report');
  }
  assert.equal(calls.length, 0);
  assert.equal(await pi.emit('agent_before_settle', { outcome: 'completed' }), undefined);
  assert.equal(calls.length, 1, '最後に検証していない (ブリッジの判定材料が残らない)');
});

test('終わる直前: verify を実行できなくても止まらない (ブリッジが最後に検証する)', async (t) => {
  const { root, cwd } = workspace(t);
  const pi = fakePi();
  const stderr = process.stderr.write;
  const logged = [];
  process.stderr.write = (s) => { logged.push(String(s)); return true; };
  try {
    createCommunitdExtension({
      config: { policy: { cwd }, verify: { command: 'x', cwd, stateFile: join(root, 's.json'), maxRetries: 1, timeoutMs: 1 } },
      runVerifyHookImpl: async () => { throw new Error('spawn EPERM'); },
    })(pi);
    assert.equal(await pi.emit('agent_before_settle', { outcome: 'completed' }), undefined);
  } finally {
    process.stderr.write = stderr;
  }
  assert.ok(logged.some((l) => l.includes('spawn EPERM')), logged.join(''));
});
