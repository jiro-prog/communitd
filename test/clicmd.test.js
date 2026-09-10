import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  CLAUDE_CLI,
  CODEX_CLI,
  cliCmdFailure,
  cliCmdHint,
  cliCmdReason,
  normalizeCommand,
  resolveCliCommand,
  resolveConfiguredCommand,
  resolveShim,
} from '../src/clicmd.js';

// 設定に書かれた CLI コマンドの解決 (src/clicmd.js)。
// **doctor と実行系がここを共有する**のが要件 — 別々に解決すると「doctor は緑なのに
// 全 job が起動できない」配置ができる (Opus2 指摘 2026-09-10)。
// platform / env / exists / readFile / nodeBin は全部注入するので、判定は実機に依らない。

/** キーを / に揃えた仮想 FS (path.join は実機の区切りで来る) */
function fakeFs(files) {
  const norm = (p) => String(p).replaceAll('\\', '/');
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    exists: (p) => map.has(norm(p)),
    readFile: (p) => {
      if (!map.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return map.get(norm(p));
    },
  };
}
const slash = (cmd) => (cmd === null ? null : cmd.map((s) => s.replaceAll('\\', '/')));

// 実物のシム (この機体の Roaming/npm/codex.cmd をそのまま写した)
const NPM_JS_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
  'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');
// npm が実行ファイル (.exe) の bin に対して置くシム — node を噛ませない
const NPM_EXE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
  'SETLOCAL', 'CALL :find_dp0',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');
// pnpm / yarn global が置く形 (%~dp0 と .. を含む)
const PNPM_SHIM = [
  '@SETLOCAL', '@SET PATHEXT=%PATHEXT:;.JS;=;%',
  '@node  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

test('語の正規化: 文字列も配列も受け、空白だけの語と非文字列は落とす', () => {
  assert.deepEqual(normalizeCommand('claude'), ['claude']);
  assert.deepEqual(normalizeCommand(['node', ' C:/cli.js ']), ['node', 'C:/cli.js']);
  assert.deepEqual(normalizeCommand([]), []);
  assert.deepEqual(normalizeCommand(['', '  ']), []);
  assert.deepEqual(normalizeCommand(42), []);
  assert.deepEqual(normalizeCommand(undefined), []);
});

// ---- シムの解析 (実体の在り処はここから引くのが正) ----

test('シムの中身から実体を引く。.js は node 経由・.exe は直接', () => {
  const js = fakeFs({
    'C:/npm/codex.cmd': NPM_JS_SHIM,
    'C:/npm/node_modules/@openai/codex/bin/codex.js': '',
  });
  assert.deepEqual(
    slash(resolveShim('C:/npm/codex.cmd', { ...js, nodeBin: 'C:/node.exe' })),
    ['C:/node.exe', 'C:/npm/node_modules/@openai/codex/bin/codex.js'],
  );
  const exe = fakeFs({
    'C:/npm/claude.cmd': NPM_EXE_SHIM,
    'C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe': '',
  });
  assert.deepEqual(
    slash(resolveShim('C:/npm/claude.cmd', { ...exe, nodeBin: 'C:/node.exe' })),
    ['C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
  );
});

test('pnpm / yarn global の形 (%~dp0 と ..) も同じ 1 つの方法で辿れる', () => {
  const fs = fakeFs({
    'C:/pnpm/bin/codex.cmd': PNPM_SHIM,
    'C:/pnpm/@openai/codex/bin/codex.js': '',
  });
  assert.deepEqual(
    slash(resolveShim('C:/pnpm/bin/codex.cmd', { ...fs, nodeBin: 'node' })),
    ['node', 'C:/pnpm/@openai/codex/bin/codex.js'],
  );
});

test('シムの中の node.exe はインタプリタであって実体ではない', () => {
  // npm の実物では IF ブロックにしか出ないが、実行行に並ぶ書き方でも取り違えない
  const fs = fakeFs({
    'C:/npm/tool.cmd': '@"%dp0%\\node.exe" "%dp0%\\tool.js" %*',
    'C:/npm/node.exe': '',
    'C:/npm/tool.js': '',
  });
  assert.deepEqual(
    slash(resolveShim('C:/npm/tool.cmd', { ...fs, nodeBin: 'N' })),
    ['N', 'C:/npm/tool.js'],
  );
});

test('読めない / 書式が違う / 実体が無いシムは null', () => {
  assert.equal(resolveShim('C:/nope.cmd', fakeFs({})), null);
  assert.equal(resolveShim('C:/x.cmd', fakeFs({ 'C:/x.cmd': '@echo hi' })), null);
  assert.equal(
    resolveShim('C:/npm/codex.cmd', fakeFs({ 'C:/npm/codex.cmd': NPM_JS_SHIM })),
    null,
    '実体が無いのに在ることにしている',
  );
});

// ---- PATH からの解決 ----

test('非 Windows は PATH 解決に任せる (spawn 自身が PATH を引く)', () => {
  assert.deepEqual(
    resolveCliCommand({ ...CODEX_CLI, platform: 'linux', env: {}, ...fakeFs({}) }),
    ['codex'],
  );
});

test('Windows は .exe を優先し、無ければシムを読んで実体へ辿る', () => {
  assert.deepEqual(
    slash(resolveCliCommand({
      ...CLAUDE_CLI, platform: 'win32', env: { PATH: 'C:/bin' },
      ...fakeFs({ 'C:/bin/claude.exe': '' }),
    })),
    ['C:/bin/claude.exe'],
  );
  assert.deepEqual(
    slash(resolveCliCommand({
      ...CLAUDE_CLI,
      platform: 'win32',
      env: { PATH: 'C:/npm' },
      ...fakeFs({
        'C:/npm/claude.cmd': NPM_EXE_SHIM,
        'C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe': '',
      }),
      nodeBin: 'C:/node.exe',
    })),
    ['C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
    'claude 2.1 以降の bin/claude.exe を辿れていない',
  );
});

test('シムを読めなくても決め打ちの候補で当てる (版ごとに違うので複数持つ)', () => {
  // claude は 2.0 まで cli.js・2.1 以降 bin/claude.exe。どちらも拾えること
  for (const [entry, expected] of [
    ['C:/npm/node_modules/@anthropic-ai/claude-code/cli.js', ['C:/node.exe', 'C:/npm/node_modules/@anthropic-ai/claude-code/cli.js']],
    ['C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe', ['C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe']],
  ]) {
    assert.deepEqual(
      slash(resolveCliCommand({
        ...CLAUDE_CLI,
        platform: 'win32',
        env: { PATH: 'C:/npm' },
        // シムはあるが中身が読めない配置
        ...fakeFs({ 'C:/npm/claude.cmd': '@echo 読めない形', [entry]: '' }),
        nodeBin: 'C:/node.exe',
      })),
      expected,
    );
  }
});

test('PATH の引用符と空要素を落とし、辿れないシムは飛ばして探索を続ける', () => {
  assert.deepEqual(
    slash(resolveCliCommand({
      ...CODEX_CLI,
      platform: 'win32',
      env: { PATH: '"C:/shim-only" ;;C:/bin' },
      ...fakeFs({ 'C:/shim-only/codex.cmd': '@echo 実体なし', 'C:/bin/codex.exe': '' }),
    })),
    ['C:/bin/codex.exe'],
  );
});

test('見つからなければ null。名前が空でも null (黙って spawn しない)', () => {
  assert.equal(
    resolveCliCommand({ ...CODEX_CLI, platform: 'win32', env: { PATH: 'C:/bin' }, ...fakeFs({}) }),
    null,
  );
  assert.equal(resolveCliCommand({ ...CODEX_CLI, name: '  ', platform: 'linux' }), null);
});

test('exists が投げても解決は落ちない (doctor は throw する fs を注入する)', () => {
  const fs = fakeFs({ 'C:/bin/codex.exe': '' });
  const exists = (p) => {
    if (String(p).endsWith('.cmd')) throw new Error('EACCES');
    return fs.exists(p);
  };
  assert.deepEqual(
    slash(resolveCliCommand({
      ...CODEX_CLI, platform: 'win32', env: { PATH: 'C:/bin' }, exists, readFile: fs.readFile,
    })),
    ['C:/bin/codex.exe'],
  );
});

// ---- 設定値 → コマンド ----

test('2 語以上とシム以外の絶対パスは明示の指定として尊重する', () => {
  const deps = { platform: 'win32', env: { PATH: 'C:/bin' }, ...fakeFs({}) };
  assert.deepEqual(resolveConfiguredCommand(['node', 'C:/x/tool.js'], CODEX_CLI, deps), ['node', 'C:/x/tool.js']);
  assert.deepEqual(resolveConfiguredCommand('C:/bin/claude.exe', CLAUDE_CLI, deps), ['C:/bin/claude.exe']);
});

test('絶対パスでもシム (.cmd) なら実体へ辿る (SETUP が勧める「フルパス」が npm 版だと .cmd)', () => {
  // そのまま spawn すると EINVAL。doctor と実行系で同じ結果になるだけでは不十分
  const deps = {
    platform: 'win32',
    ...fakeFs({
      'C:/npm/claude.cmd': NPM_EXE_SHIM,
      'C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe': '',
    }),
  };
  assert.deepEqual(
    slash(resolveConfiguredCommand('C:/npm/claude.cmd', CLAUDE_CLI, deps)),
    ['C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
  );
  // 辿れなければ null (黙って .cmd を spawn しない)
  assert.equal(
    resolveConfiguredCommand('C:/npm/x.cmd', CLAUDE_CLI, { platform: 'win32', ...fakeFs({}) }),
    null,
  );
});

test('1 語の名前は Windows で必ず引き直す (["tool"] のまま spawn すると ENOENT)', () => {
  // 「明示したのだから素通し」にしていたので `codexCmd: ["codex"]` が落ちていた
  // (Opus2 実測 2026-09-10 — doctor は shell 経由なので ✅ のままだった)
  const deps = { platform: 'win32', env: { PATH: 'C:/bin' }, ...fakeFs({ 'C:/bin/codex.exe': '' }) };
  for (const configured of [['codex'], 'codex', undefined, []]) {
    assert.deepEqual(slash(resolveConfiguredCommand(configured, CODEX_CLI, deps)), ['C:/bin/codex.exe'],
      JSON.stringify(configured));
  }
});

test('別名を書いたらその名前で引く (設定した名前を勝手に既定へ戻さない)', () => {
  const deps = { platform: 'win32', env: { PATH: 'C:/bin' }, ...fakeFs({ 'C:/bin/mycodex.exe': '' }) };
  assert.deepEqual(slash(resolveConfiguredCommand(['mycodex'], CODEX_CLI, deps)), ['C:/bin/mycodex.exe']);
});

test('辿れなかった理由を PATH のせいにしない (絶対パスを書いた人には PATH は無関係)', () => {
  // 「PATH に見つかりません」と言われると、設定に絶対パスを書いた人は直す場所を探せない
  assert.equal(cliCmdReason(undefined, CODEX_CLI), 'PATH に codex が見つかりません');
  assert.equal(cliCmdReason(['codex'], CODEX_CLI), 'PATH に codex が見つかりません');
  const abs = resolve('/nope/broken.cmd');
  assert.equal(cliCmdReason(abs, CLAUDE_CLI), `${abs} から実体を辿れません`);
  assert.equal(cliCmdReason(abs, CLAUDE_CLI).includes('PATH'), false, 'PATH のせいにしている');
  // どちらの経路でも直し先 (設定キー) は必ず出る
  for (const configured of [undefined, abs]) {
    assert.match(cliCmdFailure(configured, CLAUDE_CLI), /config\.policy\.json の claudeBin/);
  }
  // doctor は「なぜ見に行ったか」を差し込める。区切りの — は 1 つだけ
  const withNote = cliCmdFailure(undefined, CODEX_CLI, ' (bot が居ます)');
  assert.match(withNote, /見つかりません \(bot が居ます\) —/);
  assert.equal(withNote.split('—').length - 1, 1, '区切りが 2 つ並んでいる');
});

test('案内文は設定キーと、実在する実体の例を指す', () => {
  // 案内どおりに書いたら動くこと。cli.js は claude 2.0 までのパスなので例にはしない
  assert.match(cliCmdHint(CODEX_CLI), /codexCmd/);
  assert.match(cliCmdHint(CODEX_CLI), /@openai\/codex\/bin\/codex\.js/);
  assert.match(cliCmdHint(CLAUDE_CLI), /claudeBin/);
  assert.match(cliCmdHint(CLAUDE_CLI), /claude-code\/bin\/claude\.exe/);
  assert.equal(cliCmdHint(CLAUDE_CLI).includes('cli.js'), false);
});
