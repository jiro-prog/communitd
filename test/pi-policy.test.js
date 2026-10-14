import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PI_REPORT_TOOL, decidePiToolCall, piDenialOf, piToolsFor, piTraceEntry, shellRuleMatches, splitShellCommand,
} from '../src/pi-policy.js';

// src/pi-policy.js — pi ランタイムの権限判定。claude と同じ設定 (allowedTools / permissionMode /
// 契約の絞り込み) で止め、照合しきれないところは claude より狭く倒す。

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'communitd-pipolicy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.js'), 'a');
  writeFileSync(join(cwd, 'src', 'b.js'), 'b');
  writeFileSync(join(root, 'outside.txt'), 'x');
  return { root, cwd };
}

const call = (toolName, input, policy) => decidePiToolCall({ toolName, input, policy });

test('知らない道具・作業ディレクトリの無い設定・知らないモードは何も通さない', (t) => {
  const { cwd } = workspace(t);
  assert.equal(call('powershell', { command: 'ls' }, { cwd, allowedTools: ['PowerShell'] }).allow, false);
  assert.equal(call('webfetch', {}, { cwd, allowedTools: ['WebFetch'] }).allow, false);
  assert.equal(call('read', { path: 'src/a.js' }, { allowedTools: ['Read'] }).allow, false);
  const odd = call('read', { path: 'src/a.js' }, { cwd, permissionMode: 'dontAsk', allowedTools: ['Read'] });
  assert.equal(odd.allow, false);
  assert.match(odd.reason, /dontAsk/);
});

test('読む: 作業ディレクトリと参照ディレクトリの中は通し、外は裸の Read があるときだけ', (t) => {
  const { root, cwd } = workspace(t);
  const base = { cwd, permissionMode: 'default', allowedTools: [] };
  assert.equal(call('read', { path: 'src/a.js' }, base).allow, true);
  assert.equal(call('grep', { pattern: 'a' }, base).allow, true, '省略時は作業ディレクトリ');
  assert.equal(call('ls', {}, base).allow, true);
  assert.equal(call('read', { path: '../outside.txt' }, base).allow, false);
  assert.equal(call('find', { path: root }, base).allow, false);
  // 参照ディレクトリ (claudeAddDirs) は読める
  assert.equal(call('read', { path: join(root, 'outside.txt') }, { ...base, addDirs: [root] }).allow, true);
  // 裸の Read は場所を問わない (claude と同じ)
  assert.equal(call('read', { path: '../outside.txt' }, { ...base, allowedTools: ['Read'] }).allow, true);
  // 裸の Glob は find / ls を、裸の Grep は grep だけを広げる
  assert.equal(call('find', { path: root }, { ...base, allowedTools: ['Glob'] }).allow, true);
  assert.equal(call('grep', { path: root }, { ...base, allowedTools: ['Glob'] }).allow, false);
});

test('書く: acceptEdits は作業ディレクトリの中だけ・plan は書けない', (t) => {
  const { cwd } = workspace(t);
  const accept = { cwd, permissionMode: 'acceptEdits', allowedTools: ['Read'] };
  assert.equal(call('edit', { path: 'src/a.js' }, accept).allow, true);
  assert.equal(call('write', { path: 'src/new/deep.js' }, accept).allow, true, '新規 (親が無い) も中なら通す');
  assert.equal(call('write', { path: '../outside.txt' }, accept).allow, false);
  assert.equal(call('write', { path: join(cwd, '..', 'x.txt') }, accept).allow, false);
  const plan = call('edit', { path: 'src/a.js' }, { cwd, permissionMode: 'plan', allowedTools: ['Edit', 'Write'] });
  assert.equal(plan.allow, false);
  assert.match(plan.reason, /plan/);
});

test('書く: default は Edit / Write のルールが要り、裸なら作業ディレクトリの中は全部', (t) => {
  const { cwd } = workspace(t);
  const none = call('edit', { path: 'src/a.js' }, { cwd, permissionMode: 'default', allowedTools: ['Read', 'Bash'] });
  assert.equal(none.allow, false);
  assert.equal(call('edit', { path: 'src/a.js' }, { cwd, allowedTools: ['Edit'] }).allow, true);
  // claude の Write は Edit のルールで照合される — 裸の Edit で新規作成も通る
  assert.equal(call('write', { path: 'src/c.js' }, { cwd, allowedTools: ['Edit'] }).allow, true);
  assert.equal(call('write', { path: 'src/c.js' }, { cwd, allowedTools: ['Write'] }).allow, true);
  // 裸でも作業ディレクトリの外は書かせない
  assert.equal(call('write', { path: '../outside.txt' }, { cwd, allowedTools: ['Edit', 'Write'] }).allow, false);
});

test('書く: パス限定の Edit(./パス) は touch 集合と同じ形の完全一致だけ', (t) => {
  const { cwd } = workspace(t);
  const policy = { cwd, permissionMode: 'default', allowedTools: ['Read', 'Edit(./src/a.js)'] };
  assert.equal(call('edit', { path: 'src/a.js' }, policy).allow, true);
  assert.equal(call('edit', { path: './src/a.js' }, policy).allow, true);
  assert.equal(call('edit', { path: join(cwd, 'src', 'a.js') }, policy).allow, true, '絶対パスでも同じファイル');
  const other = call('edit', { path: 'src/b.js' }, policy);
  assert.equal(other.allow, false);
  assert.match(other.reason, /許されたファイル/);
  // Edit は既存ファイル専用 (touch 集合と同じ)。無いファイルは理由つきで止める
  const missing = call('edit', { path: 'src/zzz.js' }, policy);
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /存在しない/);
});

test('書く: リンクで作業ディレクトリの外へ出るものは止める', (t) => {
  const { root, cwd } = workspace(t);
  try {
    symlinkSync(root, join(cwd, 'escape'), 'junction');
  } catch {
    t.skip('リンクを作れない環境');
    return;
  }
  const accept = { cwd, permissionMode: 'acceptEdits' };
  assert.equal(call('write', { path: 'escape/outside.txt' }, accept).allow, false);
  assert.equal(call('read', { path: 'escape/outside.txt' }, { cwd, allowedTools: [] }).allow, false);
});

test('契約の絞り込み: tools にないツールと disallowedTools は先に止める', (t) => {
  const { cwd } = workspace(t);
  const narrowed = {
    cwd,
    permissionMode: 'default',
    tools: ['Read', 'Glob', 'Grep', 'Edit'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit(./src/a.js)'],
    disallowedTools: ['Bash', 'PowerShell', 'Write', 'NotebookEdit', 'Agent', 'Task'],
  };
  assert.equal(call('edit', { path: 'src/a.js' }, narrowed).allow, true);
  assert.equal(call('write', { path: 'src/a.js' }, narrowed).allow, false, 'Write は落としてある');
  assert.equal(call('bash', { command: 'git status' }, { ...narrowed, allowedTools: [...narrowed.allowedTools, 'Bash'] }).allow, false);
  assert.equal(call('read', { path: 'src/b.js' }, narrowed).allow, true);
  assert.equal(call('read', { path: 'src/b.js' }, { ...narrowed, tools: ['Edit'] }).allow, false);
});

test('シェル: 裸の Bash は全部・ルールは連結をほどいた全部の片が合うときだけ', (t) => {
  const { cwd } = workspace(t);
  const std = { cwd, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(git *)', 'Bash(npm *)', 'Bash(node *)'] };
  assert.equal(call('bash', { command: 'git status' }, std).allow, true);
  assert.equal(call('bash', { command: 'git diff && npm test' }, std).allow, true);
  assert.equal(call('bash', { command: 'git log | node x.js' }, std).allow, true);
  assert.equal(call('bash', { command: 'npm test 2>&1' }, std).allow, true, '2>&1 は通す');
  assert.equal(call('bash', { command: 'git diff > /dev/null' }, std).allow, true);
  const chained = call('bash', { command: 'git status; rm -rf src' }, std);
  assert.equal(chained.allow, false);
  assert.match(chained.reason, /rm -rf src/);
  assert.equal(call('bash', { command: 'git diff > out.txt' }, std).allow, false, 'ファイルへのリダイレクト');
  assert.equal(call('bash', { command: 'git log $(rm x)' }, std).allow, false);
  assert.equal(call('bash', { command: 'git log `rm x`' }, std).allow, false);
  assert.equal(call('bash', { command: 'FOO=1 git status' }, std).allow, false, '前置きの代入は合わない');
  assert.equal(call('bash', { command: 'gitk' }, std).allow, false);
  assert.equal(call('bash', { command: 'ls' }, { cwd, allowedTools: ['Read'] }).allow, false, 'ルールが無ければ止める');
  assert.equal(call('bash', { command: 'git status' }, { ...std, permissionMode: 'plan' }).allow, false);
  assert.equal(call('bash', { command: 'rm -rf /' }, { cwd, allowedTools: ['Bash'] }).allow, true);
});

test('splitShellCommand: クォートの中の記号は区切りにしない・閉じないクォートは止める', () => {
  assert.deepEqual(splitShellCommand('git commit -m "a && b; c | d"').segments, ['git commit -m "a && b; c | d"']);
  assert.deepEqual(splitShellCommand("git log --format='%h > %s'").segments, ["git log --format='%h > %s'"]);
  assert.deepEqual(splitShellCommand('a && b || c ; d | e & f |& g\nh').segments, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(splitShellCommand('git  status   -s').segments, ['git status -s']);
  assert.equal(splitShellCommand('git commit -m "oops').ok, false);
  assert.equal(splitShellCommand('').ok, false);
  assert.equal(splitShellCommand(' ; ; ').ok, false);
  assert.equal(splitShellCommand('cat <(ls)').ok, false);
  assert.equal(splitShellCommand('sort < x').ok, false);
  assert.equal(splitShellCommand('git diff &> out').ok, false);
  assert.equal(splitShellCommand('git diff &>/dev/null').ok, true);
  assert.equal(splitShellCommand(42).ok, false);
});

test('shellRuleMatches: * は任意・末尾 " *" は引数なしも・":*" は前置き・それ以外は完全一致', () => {
  assert.equal(shellRuleMatches('git *', 'git status'), true);
  assert.equal(shellRuleMatches('git *', 'git'), true);
  assert.equal(shellRuleMatches('git *', 'gitk'), false);
  assert.equal(shellRuleMatches('npm run test:*', 'npm run test'), true);
  assert.equal(shellRuleMatches('npm run test:*', 'npm run test -- --watch'), true);
  assert.equal(shellRuleMatches('npm run test:*', 'npm run testx'), false);
  assert.equal(shellRuleMatches('npm test', 'npm test'), true);
  assert.equal(shellRuleMatches('npm test', 'npm test --x'), false);
  assert.equal(shellRuleMatches('node *.js', 'node a.js'), true);
  assert.equal(shellRuleMatches('node *.js', 'node a.ts'), false);
  assert.equal(shellRuleMatches('a.b', 'aXb'), false, '正規表現の記号は文字どおり');
  assert.equal(shellRuleMatches('', 'x'), false);
});

test('piToolsFor: 使えない道具は見せない (判定の正本は decidePiToolCall)', () => {
  assert.deepEqual(piToolsFor({ allowedTools: ['Read', 'Glob', 'Grep'] }), ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(
    piToolsFor({ allowedTools: ['Read', 'Edit', 'Write', 'Bash(git *)'], report: true }),
    ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', PI_REPORT_TOOL],
  );
  assert.deepEqual(piToolsFor({ allowedTools: ['Read'], permissionMode: 'acceptEdits' }), ['read', 'grep', 'find', 'ls', 'edit', 'write']);
  assert.deepEqual(piToolsFor({ allowedTools: ['Edit', 'Bash'], permissionMode: 'plan' }), ['read', 'grep', 'find', 'ls']);
  // 契約の絞り込み: Edit と読み取りだけ
  assert.deepEqual(
    piToolsFor({
      allowedTools: ['Read', 'Edit(./a.js)'], tools: ['Read', 'Edit'], disallowedTools: ['Bash', 'Write'], report: true,
    }),
    ['read', 'edit', PI_REPORT_TOOL],
  );
  assert.deepEqual(piToolsFor({ permissionMode: 'weird', report: true }), [PI_REPORT_TOOL]);
});

test('piTraceEntry / piDenialOf: claude の名前とキーへ寄せる (報告の道具は数えない)', () => {
  assert.deepEqual(piTraceEntry('read', { path: 'src/very/deep/file.js' }), { tool: 'Read', arg: 'file.js' });
  assert.deepEqual(piTraceEntry('bash', { command: 'npm test -- --x' }, true), { tool: 'Bash', arg: 'npm test', failed: true });
  assert.deepEqual(piTraceEntry('find', { pattern: 'secret' }), { tool: 'Glob', arg: null });
  assert.equal(piTraceEntry(PI_REPORT_TOOL, {}), null);
  assert.equal(piTraceEntry('', {}), null);
  assert.deepEqual(piDenialOf('bash', { command: 'rm x' }), { tool_name: 'Bash', tool_input: { command: 'rm x' } });
  assert.deepEqual(piDenialOf('write', { path: 'a.js', content: 'zzz' }), { tool_name: 'Write', tool_input: { file_path: 'a.js' } });
});

test('pi が書き換えるパスの形は断る (~ / @ / file: / /c/… / 特殊な空白) — 照合と実際の行き先がずれる', (t) => {
  const { root, cwd } = workspace(t);
  const accept = { cwd, permissionMode: 'acceptEdits', allowedTools: [] };
  const bareWrite = { cwd, permissionMode: 'default', allowedTools: ['Write', 'Edit'] };
  // 2026-10-12 のレビューで再現したもの: どれも以前は ALLOW で、pi は作業ディレクトリの外を触っていた
  const forms = [
    '~/escape.txt', '~', '~\\escape.txt', '@../outside.txt', `@${join(root, 'outside.txt')}`,
    `file:///${join(root, 'outside.txt').replaceAll('\\', '/')}`, 'http://x/y', '/c/Users/x.txt', '/a/repo/x.txt',
    '/mnt/c/x', '/cygdrive/c/x', 'src /a.js', 'src/　a.js',
  ];
  for (const path of forms) {
    for (const [tool, policy] of [['write', accept], ['edit', bareWrite], ['read', { cwd, allowedTools: [] }]]) {
      const d = call(tool, { path }, policy);
      assert.equal(d.allow, false, `${tool} ${JSON.stringify(path)} が通ってしまう`);
    }
  }
  assert.equal(call('ls', { path: '@..' }, { cwd, allowedTools: [] }).allow, false);
  assert.equal(call('grep', { path: '~', pattern: 'x' }, { cwd, allowedTools: ['Grep'] }).allow, false, '裸の Grep でも書き換えの形は断る');
  assert.match(call('write', { path: '~/x' }, accept).reason, /相対パス/);
});

test('Windows が特別扱いする名前は、モードに関係なく読み書きとも断る (代替データストリーム・予約名・末尾のドット)', (t) => {
  const { cwd } = workspace(t);
  const accept = { cwd, permissionMode: 'acceptEdits', allowedTools: [] };
  for (const path of ['src/a.js:hidden', 'NUL', 'CON', 'src/con.txt', 'src/evil.js.', 'src/evil.js ', 'src/.. /.. /probe.txt']) {
    assert.equal(call('write', { path }, accept).allow, false, `write ${JSON.stringify(path)}`);
    assert.equal(call('edit', { path }, { cwd, allowedTools: ['Edit'] }).allow, false, `edit ${JSON.stringify(path)}`);
  }
  assert.equal(call('read', { path: 'src/a.js:hidden' }, { cwd, allowedTools: ['Read'] }).allow, false);
  // `.` と `..` の段は名前ではない (中に留まる限り通す)
  assert.equal(call('edit', { path: 'src/../src/a.js' }, { cwd, allowedTools: ['Edit'] }).allow, true);
  assert.equal(call('edit', { path: './src/a.js' }, { cwd, allowedTools: ['Edit'] }).allow, true);
  // ドライブから書いた絶対パスは通常どおり
  assert.equal(call('edit', { path: join(cwd, 'src', 'a.js') }, { cwd, allowedTools: ['Edit'] }).allow, true);
});

test('壊れた設定 (配列でない絞り込み・null のモード) は全部止める', (t) => {
  const { cwd } = workspace(t);
  assert.equal(call('bash', { command: 'ls' }, { cwd, allowedTools: ['Bash'], disallowedTools: 'Bash' }).allow, false);
  assert.equal(call('read', { path: 'src/a.js' }, { cwd, allowedTools: ['Read'], tools: 'Read' }).allow, false);
  assert.equal(call('edit', { path: 'src/a.js' }, { cwd, allowedTools: ['Edit'], tools: { Edit: 1 } }).allow, false);
  assert.equal(call('read', { path: 'src/a.js' }, { cwd, allowedTools: ['Read'], permissionMode: null }).allow, false);
  // 省略は既定 (default) — 絞り込みなし
  assert.equal(call('read', { path: 'src/a.js' }, { cwd, allowedTools: ['Read'] }).allow, true);
  assert.equal(call('read', { path: 'src/a.js' }, { cwd, allowedTools: ['Read'], tools: null }).allow, true);
});

test('パス限定の Edit(./パス) だけのチャンネルでは新規作成 (write) を通さず、見せもしない', (t) => {
  const { cwd } = workspace(t);
  const pinned = { cwd, permissionMode: 'default', allowedTools: ['Read', 'Edit(./src/a.js)', 'Edit(./src/new.js)'] };
  assert.equal(call('write', { path: 'src/new.js' }, pinned).allow, false);
  assert.equal(call('write', { path: 'src/a.js' }, pinned).allow, false, '既存ファイルの上書きも write では通さない');
  assert.equal(call('edit', { path: 'src/a.js' }, pinned).allow, true);
  assert.deepEqual(piToolsFor({ allowedTools: pinned.allowedTools }), ['read', 'grep', 'find', 'ls', 'edit']);
  // Write(パス) は claude でも照合されない — 書込みにならない
  assert.deepEqual(piToolsFor({ allowedTools: ['Read', 'Write(./src/a.js)'] }), ['read', 'grep', 'find', 'ls']);
  assert.equal(call('write', { path: 'src/a.js' }, { cwd, allowedTools: ['Write(./src/a.js)'] }).allow, false);
});

test('最終報告の道具は報告を受け取る job でだけ通す', (t) => {
  const { cwd } = workspace(t);
  assert.equal(call(PI_REPORT_TOOL, {}, { cwd, report: true }).allow, true);
  assert.equal(call(PI_REPORT_TOOL, {}, { cwd, report: false }).allow, false);
});
