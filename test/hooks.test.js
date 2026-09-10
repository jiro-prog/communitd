import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildApprovalPreToolHooks,
  buildHookSettings,
  buildTraceToolHooks,
  buildVerifyStopHooks,
} from '../src/hooks.js';
import { HOOK_GRACE_MS } from '../src/broker.js';

test('hook 基盤が無効なら settings を作らない', () => {
  assert.equal(buildHookSettings(), null);
  assert.equal(buildHookSettings({ enabled: false, hooks: {} }), null);
});

test('hook 基盤が有効なら hook 0 件でも空 settings を作る', () => {
  const settings = buildHookSettings({ enabled: true, hooks: {} });
  assert.deepEqual(settings, { hooks: {} });
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
  assert.equal(Object.getPrototypeOf(settings.hooks), Object.prototype);
  assert.equal(JSON.stringify(settings), '{"hooks":{}}');
});

test('hook 定義は JSON.stringify 可能なプレーンオブジェクトになる', () => {
  const settings = buildHookSettings({
    enabled: true,
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 60 }] }],
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
});

test('permissions を含む settings キーは enabled にかかわらず拒否する', () => {
  for (const key of ['permissions', 'allowedTools', 'disallowedTools', 'permissionMode']) {
    assert.throws(
      () => buildHookSettings({ enabled: false, [key]: {} }),
      (err) => err instanceof TypeError && err.message.includes(key),
      `${key} が拒否されていない`,
    );
  }
});

test('hooks の型不正や JSON にできない値は spawn 前に拒否する', () => {
  for (const hooks of [[], null, 'Stop']) {
    assert.throws(() => buildHookSettings({ enabled: true, hooks }), /hooks はオブジェクト/);
  }
  const circular = {};
  circular.Stop = circular;
  assert.throws(() => buildHookSettings({ enabled: true, hooks: circular }), /circular/i);
  assert.throws(
    () => buildHookSettings({ enabled: true, hooks: { Stop: 1n } }),
    /BigInt|serialize/i,
  );
});

test('verify Stop hook は固定 wrapper と job config だけを command に載せる', () => {
  const hooks = buildVerifyStopHooks({ configFile: 'C:/tmp/job config.json', timeoutMs: 10_000 });
  assert.equal(hooks.Stop.length, 1);
  const hook = hooks.Stop[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /verify\.js/);
  assert.match(hook.command, /--hook/);
  assert.match(hook.command, /job config\.json/);
  assert.equal(hook.timeout, 20);

  const settings = buildHookSettings({ enabled: true, hooks });
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.deepEqual(Object.keys(settings.hooks), ['Stop']);
});

test('verify Stop hook の不正な config path / timeout は spawn 前に拒否する', () => {
  for (const configFile of ['', null, 1]) {
    assert.throws(
      () => buildVerifyStopHooks({ configFile, timeoutMs: 1000 }),
      /configFile/,
    );
  }
  for (const timeoutMs of [0, -1, 1.5, null]) {
    assert.throws(() => buildVerifyStopHooks({ configFile: 'x.json', timeoutMs }), /timeoutMs/);
  }
});

test('ツール軌跡は実行後の 2 イベントに載せる (成功だけだと落ちた実行が消える)', () => {
  const hooks = buildTraceToolHooks({ traceFile: 'C:/tmp/job dir/trace.jsonl', timeoutMs: 10_000 });
  // PreToolUse は使わない (実行前なので拒否された呼び出しまで記録される)。
  // PostToolUse だけでも足りない (成功時しか発火せず、失敗した実行が軌跡から消える)。
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure']);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    assert.equal(hooks[event].length, 1, event);
    // matcher を書かない = 全ツールに一致 (実測)
    assert.equal(hooks[event][0].matcher, undefined, event);
    const hook = hooks[event][0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.match(hook.command, /trace\.js/);
    assert.match(hook.command, /--hook/);
    assert.match(hook.command, /job dir\/trace\.jsonl/);
    assert.equal(hook.timeout, 10);
  }
});

test('承認 hook は対象ツールを matcher で絞る (通る呼び出しにまで往復を挟まない)', () => {
  const waitMs = 180_000;
  const hooks = buildApprovalPreToolHooks({
    configFile: 'C:/tmp/job dir/approval.json',
    waitMs,
    tools: ['WebFetch'],
  });
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, 'WebFetch');
  const hook = hooks.PreToolUse[0].hooks[0];
  assert.match(hook.command, /broker\.js/);
  assert.match(hook.command, /job dir\/approval\.json/);
  // ブリッジの待機上限 < hook 自身の打ち切り < CLI の timeout。
  // CLI に kill されるとカードが「承認待ち」の見た目のまま残る
  assert.ok(
    hook.timeout * 1000 > waitMs + HOOK_GRACE_MS,
    `CLI の timeout が hook 自身の打ち切りより短い: ${hook.timeout}s`,
  );
});

test('承認 hook の不正な config path / waitMs / tools は spawn 前に拒否する', () => {
  const ok = { configFile: 'a.json', waitMs: 1000, tools: ['WebFetch'] };
  for (const configFile of ['', null, 1]) {
    assert.throws(() => buildApprovalPreToolHooks({ ...ok, configFile }), /configFile/);
  }
  for (const waitMs of [0, -1, 1.5, null]) {
    assert.throws(() => buildApprovalPreToolHooks({ ...ok, waitMs }), /waitMs/);
  }
  // matcher は正規表現として解釈されるので、ツール名以外を入れさせない
  for (const tools of [[], null, 'WebFetch', ['.*'], ['WebFetch|.*'], ['']]) {
    assert.throws(() => buildApprovalPreToolHooks({ ...ok, tools }), /tools/);
  }
});

test('軌跡 hook・verify hook・承認 hook は同じ settings に同居できる', () => {
  const hooks = {
    ...buildTraceToolHooks({ traceFile: 'C:/tmp/t.jsonl', timeoutMs: 10_000 }),
    ...buildVerifyStopHooks({ configFile: 'C:/tmp/v.json', timeoutMs: 10_000 }),
    ...buildApprovalPreToolHooks({ configFile: 'C:/tmp/a.json', waitMs: 10_000, tools: ['WebFetch'] }),
  };
  const settings = buildHookSettings({ enabled: true, hooks });
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.deepEqual(
    Object.keys(settings.hooks).sort(),
    ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop'],
  );
});

test('軌跡 hook の不正な記録先 / timeout は spawn 前に拒否する', () => {
  for (const traceFile of ['', null, 1]) {
    assert.throws(() => buildTraceToolHooks({ traceFile, timeoutMs: 1000 }), /traceFile/);
  }
  for (const timeoutMs of [0, -1, 1.5, null]) {
    assert.throws(
      () => buildTraceToolHooks({ traceFile: 'x.jsonl', timeoutMs }),
      /timeoutMs/,
    );
  }
});
