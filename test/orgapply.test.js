import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';

import {
  APPLY_STAGES, applyCommitMessage, applyProposal, withApplyLock,
} from '../src/orgapply.js';
import { diffDigestOf } from '../src/apply.js';
import { worktreePathFor } from '../src/worktree.js';

// ---- 材料 ----

const ROOT = 'C:/repo';
const BASE = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const TASK = '42';
const BRANCH = 'task/42';
const WT = worktreePathFor(ROOT, TASK);

const BEFORE = 'sol の憲章\n';
const AFTER = 'sol の憲章 (改)\n';

/** 全体置換の diff (文法は src/diffs.js が検査する) */
function makeDiff(path, before, after) {
  const lines = (text) => (text === null ? [] : text.replace(/\n$/, '').split('\n'));
  const oldLines = lines(before);
  const newLines = lines(after);
  const head = before === null
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${newLines.length} @@\n`
    : after === null
      ? `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${oldLines.length} +0,0 @@\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)];
  return `${head}${body.join('\n')}\n`;
}

/** parseUnifiedDiff の代わりに、テストが読める形で file を組む */
const editFile = (path, before, after) => ({
  path,
  op: 'edit',
  oldPath: path,
  newPath: path,
  hunks: [{
    oldStart: 1,
    oldCount: before.replace(/\n$/, '').split('\n').length,
    newStart: 1,
    newCount: after.replace(/\n$/, '').split('\n').length,
    body: [
      ...before.replace(/\n$/, '').split('\n').map((text) => ({ sign: '-', text, noNewline: false })),
      ...after.replace(/\n$/, '').split('\n').map((text) => ({ sign: '+', text, noNewline: false })),
    ],
  }],
});

const deleteFileEntry = (path, before) => ({
  path,
  op: 'delete',
  oldPath: path,
  newPath: null,
  hunks: [{
    oldStart: 1,
    oldCount: before.replace(/\n$/, '').split('\n').length,
    newStart: 0,
    newCount: 0,
    body: before.replace(/\n$/, '').split('\n').map((text) => ({ sign: '-', text, noNewline: false })),
  }],
});

const PROPOSAL = {
  id: '7',
  class: 'org',
  input: { summary: 'sol の憲章に検収の観点を足す\n(2 行目は落とす)', change: { diff: makeDiff('roles/sol.md', BEFORE, AFTER) } },
  adjudication: { by: 'owner:so', at: '2026-08-31T00:00:00.000Z', revision: 1, digest: 'digest7' },
};

const PLAN = {
  ok: true,
  lane: 'org',
  kind: 'role-edit',
  revision: 1,
  digest: 'digest7',
  baseCommit: BASE,
  touch: ['roles/sol.md'],
  files: [editFile('roles/sol.md', BEFORE, AFTER)],
  applied: { 'roles/sol.md': AFTER },
  diffDigest: diffDigestOf(makeDiff('roles/sol.md', BEFORE, AFTER)),
};

/** `git diff --raw -z` の 1 レコード */
const rawEntry = (srcMode, dstMode, status, path) => `:${srcMode} ${dstMode} ${'1'.repeat(40)} ${'2'.repeat(40)} ${status}\0${path}\0`;

/**
 * 偽の git。**呼ばれた順番をそのまま記録する** — この層の中身は副作用の順序なので、
 * 何がどの順で走ったかが読めることをテストの主眼にする。
 */
function fakeWorld({
  over = {}, plan = PLAN, worktrees = [], branches = [],
  validateApplied = async () => ({ ok: true }),
} = {}) {
  const calls = [];
  const answers = {
    'rev-parse HEAD': `${BASE}\n`,
    'status --porcelain': '',
    [`show ${BASE}:roles/sol.md`]: BEFORE,
    'add -A': '',
    [`diff --raw -z --no-renames ${BASE} ${TREE}`]: rawEntry('100644', '100644', 'M', 'roles/sol.md'),
    [`show ${TREE}:roles/sol.md`]: plan.applied['roles/sol.md'],
    'write-tree': `${TREE}\n`,
    commit: '',
    [`rev-parse ${HEAD2}^{tree}`]: `${TREE}\n`,
    [`rev-list --parents -n 1 ${HEAD2}`]: `${HEAD2} ${BASE}\n`,
    ...over,
  };
  let committed = false;
  const git = async (cwd, args) => {
    calls.push(`${cwd === ROOT ? 'root' : 'wt'}: ${args.join(' ')}`);
    if (args[0] === 'worktree' || args[0] === 'branch') {
      const forced = over[args.join(' ')];
      if (forced instanceof Error) throw forced;
      return '';
    }
    const key = args[0] === 'commit' ? 'commit' : args.join(' ');
    if (args[0] === 'commit') committed = true;
    if (key === 'rev-parse HEAD' && committed) return `${HEAD2}\n`;
    const value = answers[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`未定義の git 呼び出し: ${args.join(' ')}`);
    return value;
  };
  const files = new Map();
  const deps = {
    git,
    writeFile: async (p, text) => { calls.push(`write: ${p}`); files.set(p, text); },
    deleteFile: async (p) => { calls.push(`delete: ${p}`); files.delete(p); },
    ensureDir: async (p) => { calls.push(`mkdir: ${p}`); },
    validateApplied: async ({ applied, readBase }) => {
      calls.push(`validate: ${Object.keys(applied).join(' ')}`);
      return validateApplied({ applied, readBase });
    },
    verify: async (cwd) => { calls.push(`verify: ${cwd}`); return { ok: true }; },
    listWorktrees: async () => { calls.push('list: worktrees'); return worktrees; },
    listBranches: async () => { calls.push('list: branches'); return branches; },
  };
  return { calls, deps, files };
}

const run = (world, over = {}) => applyProposal({
  proposal: PROPOSAL, plan: PLAN, taskId: TASK, branch: BRANCH, repoRoot: ROOT, deps: world.deps, ...over,
});

// ---- 通し ----

test('基点から枝を作り、基点の内容へ当てて、index を検査して commit し、verify まで通す', async () => {
  const world = fakeWorld();
  const out = await run(world);

  assert.equal(out.ok, true, out.reason);
  assert.equal(out.path, WT);
  assert.equal(out.receipt.appliedCommit, HEAD2);
  assert.equal(out.receipt.appliedTree, TREE);
  assert.equal(out.receipt.baseCommit, BASE);
  assert.equal(out.receipt.proposalId, '7');
  assert.equal(out.receipt.verify.ok, true);

  // **順番がこの層の中身。** 現況 → 枝 → 基点確認 → 基点から算出 → 書く → stage →
  // **tree を固定 → その tree を検査** → commit → tree と親を確かめる → verify
  assert.deepEqual(world.calls, [
    'list: worktrees',
    'list: branches',
    `root: worktree add -b ${BRANCH} ${WT} ${BASE}`,
    'wt: rev-parse HEAD',
    'wt: status --porcelain',
    `wt: show ${BASE}:roles/sol.md`,
    // 書く前に、適用後の内容そのものを検証する (起動できない設定を commit しない)
    'validate: roles/sol.md',
    `mkdir: ${join(WT, 'roles')}`,
    `write: ${join(WT, 'roles/sol.md')}`,
    'wt: add -A',
    'wt: write-tree',
    `wt: diff --raw -z --no-renames ${BASE} ${TREE}`,
    `wt: show ${TREE}:roles/sol.md`,
    'wt: commit -m ' + applyCommitMessage(PROPOSAL, PLAN, TASK),
    'wt: rev-parse HEAD',
    `wt: rev-parse ${HEAD2}^{tree}`,
    `wt: rev-list --parents -n 1 ${HEAD2}`,
    // verify が見るのは作業ツリー = 可変なもの。回す前に適用コミットそのものだと確かめる
    'wt: rev-parse HEAD',
    'wt: status --porcelain',
    `verify: ${WT}`,
  ]);
});

test('残骸のある枝は撤去して作り直す (再利用しない)', async () => {
  const world = fakeWorld({
    worktrees: [{ path: WT, branch: BRANCH, prunable: false }],
    branches: [BRANCH, 'master'],
  });
  await run(world);

  assert.deepEqual(world.calls.slice(0, 5), [
    'list: worktrees',
    'list: branches',
    `root: worktree remove --force ${WT}`,
    `root: branch -D ${BRANCH}`,
    `root: worktree add -b ${BRANCH} ${WT} ${BASE}`,
  ]);
});

// ---- 基点との照合 (Sol 指摘 2026-09-01) ----

test('基点の内容が裁定時と違えば当てない (作業ツリーの汚れを持ち込まない)', async () => {
  // 提案を検証したときの作業ツリーには未コミットの変更があり、基点の中身は別だった状況
  const world = fakeWorld({ over: { [`show ${BASE}:roles/sol.md`]: 'よそで直された憲章\n' } });
  const out = await run(world);

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'base');
  assert.match(out.reason, /承認済み diff が基点 .* の内容へ当たりません/);
  assert.equal(world.calls.some((c) => c.startsWith('write:')), false, '当たらないのに書いている');
});

test('基点へ当たっても結果が裁定時と違えば当てない', async () => {
  // diff は当たるが、算出結果が plan.applied と食い違う (裁定時の前提が別だった)
  const plan = { ...PLAN, applied: { 'roles/sol.md': '裁定時はこうだった\n' } };
  const world = fakeWorld({ plan });
  const out = await applyProposal({
    proposal: PROPOSAL, plan, taskId: TASK, branch: BRANCH, repoRoot: ROOT, deps: world.deps,
  });

  assert.equal(out.stage, 'base');
  assert.match(out.reason, /裁定時に見た内容と基点の内容が違います/);
  assert.equal(world.calls.some((c) => c.startsWith('write:')), false);
});

// ---- 書く前の検証 (起動できない設定を commit しない) ----

test('APPLY_STAGES の validate は write より前 (書いてから検証する段は無い)', () => {
  assert.ok(APPLY_STAGES.includes('validate'));
  assert.ok(
    APPLY_STAGES.indexOf('validate') < APPLY_STAGES.indexOf('write'),
    '検証が書込みより後ろに居る',
  );
});

test('validateApplied が通らなければ書かない (stage は validate)', async () => {
  const world = fakeWorld({
    validateApplied: async () => ({ ok: false, reason: 'bots.opus.model が要る' }),
  });
  const out = await run(world);

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'validate');
  assert.equal(out.reason, 'bots.opus.model が要る');
  assert.equal(out.path, WT, '落ちた場所 (枝) を返していない — 呼び出し側が後始末できない');
  assert.equal(world.calls.some((c) => c.startsWith('write:')), false, '通らない内容を書いている');
  assert.equal(world.calls.includes('wt: add -A'), false, '通らない内容を stage している');
  // 検証にかけるのは**当てた結果**。基点でも作業ツリーでもない
  assert.equal(world.calls.at(-1), 'validate: roles/sol.md');
});

test('検証には適用後の内容と「基点を読む口」を渡す (読む先は作業ツリーではなく基点)', async () => {
  // 呼び出し側 (src/bridge/orgapply.js) は、この適用が触っていないファイル
  // (policy・他の bot の役割文) も「適用後の姿」を組むのに要る
  const seen = [];
  const world = fakeWorld({
    validateApplied: async ({ applied, readBase }) => {
      seen.push(applied);
      seen.push(await readBase('roles/sol.md'));
      seen.push(await readBase('roles/no-such.md'));
      return { ok: true };
    },
  });
  const out = await run(world);

  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(seen[0], { 'roles/sol.md': AFTER }, '適用後の内容を渡していない');
  assert.equal(seen[1], BEFORE, '基点の内容を読めていない');
  assert.equal(seen[2], null, '基点に無いファイルは null で返す (create の前提)');
  // 読んだのは**基点の blob** (作業ツリーの現物ではない)
  assert.ok(world.calls.includes(`wt: show ${BASE}:roles/sol.md`));
});

test('検証そのものが投げたときも当てない (fail-closed)', async () => {
  const world = fakeWorld({ validateApplied: async () => { throw new Error('読めません'); } });
  const out = await run(world);

  assert.equal(out.stage, 'validate');
  assert.match(out.reason, /適用後の内容を検証できませんでした: 読めません/);
  assert.equal(world.calls.some((c) => c.startsWith('write:')), false);
});

test('validateApplied を渡さない呼び出しは受け付けない (省略で検証が消えない)', async () => {
  const { validateApplied, ...withoutValidate } = fakeWorld().deps;
  assert.equal(typeof validateApplied, 'function');
  await assert.rejects(
    () => applyProposal({
      proposal: PROPOSAL, plan: PLAN, taskId: TASK, branch: BRANCH, repoRoot: ROOT,
      deps: withoutValidate,
    }),
    /org-apply: validateApplied は注入する/,
  );
});

// ---- 途中で落ちる ----

test('基点がずれていたら書きもしない', async () => {
  const world = fakeWorld({ over: { 'rev-parse HEAD': `${HEAD2}\n` } });
  const out = await run(world);

  assert.equal(out.stage, 'base');
  assert.match(out.reason, /裁定の基点/);
  assert.equal(world.calls.some((c) => c.startsWith('write:')), false);
});

test('作業ツリーが汚れていたら当てない', async () => {
  const world = fakeWorld({ over: { 'status --porcelain': ' M roles/sol.md\n' } });
  const out = await run(world);

  assert.equal(out.stage, 'base');
  assert.match(out.reason, /未コミットの変更/);
});

test('承認されていない変更が混ざっていたらコミットしない', async () => {
  const world = fakeWorld({
    over: {
      [`diff --raw -z --no-renames ${BASE} ${TREE}`]: rawEntry('100644', '100644', 'M', 'roles/sol.md')
        + rawEntry('100644', '100644', 'M', 'README.md'),
    },
  });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /承認されていない変更が混ざっています: README.md/);
  assert.equal(world.calls.some((c) => c.includes('commit')), false, '検査に落ちたのにコミットしている');
});

test('mode が変わっていてもコミットしない (内容が合っていても)', async () => {
  const world = fakeWorld({
    over: { [`diff --raw -z --no-renames ${BASE} ${TREE}`]: rawEntry('100644', '100755', 'M', 'roles/sol.md') },
  });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /ファイルモードが変わっています/);
});

test('tree の内容が算出結果と違えばコミットしない', async () => {
  const world = fakeWorld({ over: { [`show ${TREE}:roles/sol.md`]: 'よそから入った内容\n' } });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /内容が承認された適用結果と違います/);
});

test('残っているはずのファイルが tree から読めなければ落とす', async () => {
  const world = fakeWorld({ over: { [`show ${TREE}:roles/sol.md`]: new Error('読めない') } });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /tree 上の内容を読めません/);
});

test('git が落ちたらその段で止まる', async () => {
  const world = fakeWorld({ over: { 'add -A': new Error('index.lock がある') } });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /index.lock がある/);
});

// ---- 検査した index とコミットの束縛 (Sol 指摘 2026-09-01) ----

test('検査した tree と違う tree がコミットされたら receipt を作らない', async () => {
  // pre-commit hook や並行操作が index を動かした状況
  const world = fakeWorld({ over: { [`rev-parse ${HEAD2}^{tree}`]: `${'d'.repeat(40)}\n` } });
  const out = await run(world);

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'commit');
  assert.match(out.reason, /検査した tree .* と違います/);
  assert.equal(world.calls.some((c) => c.startsWith('verify:')), false, 'tree が違うのに verify している');
});

test('検査の後に index へ足されても、固定した tree で検査しているので通らない', async () => {
  // stage の直後に tree を固定しているので、以後 index が動いても検査対象は動かない。
  // 固定した tree と違う tree がコミットされた時点で落ちる (Sol 指摘 2026-09-01)
  const world = fakeWorld({ over: { [`rev-parse ${HEAD2}^{tree}`]: `${'f'.repeat(40)}\n` } });
  const out = await run(world);

  assert.equal(out.stage, 'commit');
  assert.match(out.reason, /検査した tree .* と違います/);
  // 検査は固定した tree に対して行われている (可変な index を読んでいない)
  assert.equal(world.calls.some((c) => c === 'wt: show :roles/sol.md'), false, 'index を読んでいる');
  assert.equal(world.calls.indexOf('wt: write-tree') < world.calls.findIndex((c) => c.startsWith('wt: diff --raw')), true,
    'tree を固定する前に検査している');
});

test('系譜の先頭が適用コミットでなければ receipt を作らない', async () => {
  // HEAD は可変なので、receipt に載せる commit と検査する系譜が別の commit になりうる
  const world = fakeWorld({
    over: { [`rev-list --parents -n 1 ${HEAD2}`]: `${'9'.repeat(40)} ${BASE}\n` },
  });
  const out = await run(world);

  assert.equal(out.stage, 'commit');
  assert.match(out.reason, /系譜の先頭 .* が適用コミットと違います/);
});

test('コミットの親が基点だけでなければ receipt を作らない', async () => {
  const world = fakeWorld({
    over: { [`rev-list --parents -n 1 ${HEAD2}`]: `${HEAD2} ${BASE} ${'e'.repeat(40)}\n` },
  });
  const out = await run(world);

  assert.equal(out.stage, 'commit');
  assert.match(out.reason, /親が基点だけではありません/);
});

test('index の tree を読めなければコミットしない', async () => {
  const world = fakeWorld({ over: { 'write-tree': 'not-an-oid\n' } });
  const out = await run(world);

  assert.equal(out.stage, 'inspect');
  assert.match(out.reason, /index の tree を読めませんでした/);
  assert.equal(world.calls.some((c) => c.includes('commit')), false);
});

// ---- verify ----

test('verify に落ちたら receipt を作らない (コミットは残る)', async () => {
  const world = fakeWorld();
  world.deps.verify = async () => ({ ok: false, detail: 'テストが 2 件失敗' });
  const out = await run(world);

  assert.equal(out.stage, 'verify');
  assert.equal(out.reason, 'verify に通りませんでした: テストが 2 件失敗');
  assert.equal(out.path, WT, '枝を捨てる先が分からない');
});

test('中断は「通りませんでした」で包まない (落ちたのではなく確かめていない)', async () => {
  const world = fakeWorld();
  world.deps.verify = async () => ({
    ok: false, aborted: true, detail: '停止指示により中断しました (ブリッジの停止)',
  });
  const out = await run(world);

  assert.equal(out.stage, 'verify');
  assert.equal(out.reason, '停止指示により中断しました (ブリッジの停止)', '二重否定になっている');
  assert.equal(out.receipt, undefined, '確かめていないのに receipt を作っている');
});

test('hook が作業ツリーだけ直していたら verify へ進まない', async () => {
  // post-commit hook が index を触らずに作業ツリーだけ直すと、tree も系譜も通る。
  // そのまま verify すると**コミットに入っていない内容**で receipt ができる
  const world = fakeWorld({ over: { 'status --porcelain': '' } });
  let afterCommit = false;
  const inner = world.deps.git;
  world.deps.git = async (cwd, args) => {
    if (args[0] === 'commit') afterCommit = true;
    // コミットの後だけ作業ツリーが汚れている
    if (afterCommit && args.join(' ') === 'status --porcelain') {
      world.calls.push(`${cwd === ROOT ? 'root' : 'wt'}: status --porcelain`);
      return ' M roles/sol.md\n';
    }
    return inner(cwd, args);
  };
  const out = await run(world);

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'verify');
  assert.match(out.reason, /作業ツリーが汚れています/);
  assert.equal(world.calls.some((c) => c.startsWith('verify:')), false, '汚れたまま verify している');
});

test('コミットの後に HEAD が動いていたら verify へ進まない', async () => {
  const world = fakeWorld();
  let afterCommit = false;
  const inner = world.deps.git;
  world.deps.git = async (cwd, args) => {
    if (args[0] === 'commit') { afterCommit = true; return inner(cwd, args); }
    if (afterCommit && args.join(' ') === 'rev-parse HEAD') {
      // 1 回目 (appliedCommit の取得) は通し、2 回目 (verify 直前) で動かす
      const seen = world.calls.filter((c) => c === 'wt: rev-parse HEAD').length;
      world.calls.push('wt: rev-parse HEAD');
      return seen >= 2 ? `${'7'.repeat(40)}\n` : `${HEAD2}\n`;
    }
    return inner(cwd, args);
  };
  const out = await run(world);

  assert.equal(out.stage, 'verify');
  assert.match(out.reason, /HEAD .* が適用コミットから動いています/);
  assert.equal(world.calls.some((c) => c.startsWith('verify:')), false);
});

test('verify が例外を投げても receipt を作らず、段とパスを返す', async () => {
  const world = fakeWorld();
  world.deps.verify = async () => { throw new Error('verify コマンドが見つからない'); };
  const out = await run(world);

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'verify');
  assert.match(out.reason, /verify を回せませんでした: verify コマンドが見つからない/);
  assert.equal(out.path, WT);
});

// ---- 削除を含む適用 ----

test('削除は index から消えたことで確かめる', async () => {
  const plan = {
    ...PLAN,
    kind: 'role-retire',
    touch: ['roles/old.md'],
    files: [deleteFileEntry('roles/old.md', BEFORE)],
    applied: { 'roles/old.md': null },
  };
  const world = fakeWorld({
    plan,
    over: {
      [`show ${BASE}:roles/old.md`]: BEFORE,
      [`diff --raw -z --no-renames ${BASE} ${TREE}`]: rawEntry('100644', '000000', 'D', 'roles/old.md'),
      // 消えたファイルは `git show <tree>:path` が失敗する = tree に無い
      [`show ${TREE}:roles/old.md`]: new Error("path 'roles/old.md' does not exist"),
    },
  });

  const out = await applyProposal({
    proposal: PROPOSAL, plan, taskId: TASK, branch: BRANCH, repoRoot: ROOT, deps: world.deps,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(world.calls.some((c) => c === `delete: ${join(WT, 'roles/old.md')}`), true, '消していない');
});

// ---- 排他 ----

test('同じ task の適用は直列に走る (走っている枝を残骸と見なさない)', async () => {
  const order = [];
  const slow = (label, ms) => withApplyLock('repo::1', async () => {
    order.push(`${label}:start`);
    await new Promise((r) => { setTimeout(r, ms); });
    order.push(`${label}:end`);
    return label;
  });

  const [a, b] = await Promise.all([slow('A', 12), slow('B', 0)]);
  assert.equal(a, 'A');
  assert.equal(b, 'B');
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end'], '重なって走っている');

  // 前が失敗しても次は走る
  const failed = withApplyLock('repo::1', async () => { throw new Error('落ちた'); });
  await assert.rejects(() => failed, /落ちた/);
  assert.equal(await withApplyLock('repo::1', async () => 'next'), 'next');
});

test('後始末が終わるまで次の適用は現況を読み始めない', async () => {
  // A が失敗して返った直後に B が枝を作ると、A の後始末 (worktree の解放) が
  // B の枝を撤去してしまう。settle は排他区間の中で呼ぶ (Sol 指摘 2026-09-01)
  const order = [];
  const worldA = fakeWorld({ over: { 'status --porcelain': ' M roles/sol.md\n' } });
  const worldB = fakeWorld();
  worldB.deps.listWorktrees = async () => { order.push('B: 現況'); return []; };

  const a = applyProposal({
    proposal: PROPOSAL,
    plan: PLAN,
    taskId: TASK,
    branch: BRANCH,
    repoRoot: ROOT,
    deps: worldA.deps,
    settle: async (result) => {
      order.push(`A: 後始末 開始 (${result.stage})`);
      await new Promise((r) => { setTimeout(r, 12); });
      order.push('A: 後始末 終了');
    },
  });
  const b = applyProposal({
    proposal: PROPOSAL, plan: PLAN, taskId: TASK, branch: BRANCH, repoRoot: ROOT, deps: worldB.deps,
  });
  await Promise.all([a, b]);

  assert.deepEqual(order, ['A: 後始末 開始 (base)', 'A: 後始末 終了', 'B: 現況']);
});

test('後始末が落ちたら握りつぶさずに伝える', async () => {
  const world = fakeWorld();
  await assert.rejects(
    () => run(world, { settle: async () => { throw new Error('receipt を保存できない'); } }),
    /receipt を保存できない/,
  );
  // 鍵は解放されている (次が走る)
  assert.equal((await run(fakeWorld())).ok, true);
});

test('鍵が違えば並行に走る', async () => {
  const order = [];
  const slow = (key, label, ms) => withApplyLock(key, async () => {
    order.push(`${label}:start`);
    await new Promise((r) => { setTimeout(r, ms); });
    order.push(`${label}:end`);
  });

  await Promise.all([slow('repo::1', 'A', 12), slow('repo::2', 'B', 0)]);
  assert.deepEqual(order, ['A:start', 'B:start', 'B:end', 'A:end']);
});

// ---- 契約 ----

test('注入されていない依存と、当ててよくない plan は受け付けない', async () => {
  const world = fakeWorld();
  await assert.rejects(() => applyProposal({ proposal: PROPOSAL, plan: PLAN, deps: {} }), /git は注入する/);
  // **verify も必須。** 省略を許すと verify 無しで receipt が作れてしまう
  const { verify, ...noVerify } = world.deps;
  await assert.rejects(
    () => applyProposal({ proposal: PROPOSAL, plan: PLAN, deps: noVerify }),
    /verify は注入する/,
  );
  const { listWorktrees, ...noList } = world.deps;
  await assert.rejects(
    () => applyProposal({ proposal: PROPOSAL, plan: PLAN, deps: noList }),
    /listWorktrees は注入する/,
  );
  await assert.rejects(
    () => applyProposal({ proposal: PROPOSAL, plan: { ok: false, reason: 'x' }, deps: world.deps }),
    /当ててよいと判定された plan/,
  );
});

test('コミット本文は何を根拠に当てたかを残す', () => {
  const message = applyCommitMessage(PROPOSAL, PLAN, TASK);
  assert.match(message, /^apply: 提案 #7 を当てる \(role-edit\)/);
  // summary は 1 行目だけ (本文が長くなると git log が読めなくなる)
  assert.match(message, /sol の憲章に検収の観点を足す/);
  assert.equal(message.includes('2 行目は落とす'), false);
  assert.match(message, /revision: 1 \/ digest: digest7/);
  assert.match(message, new RegExp(`base: ${BASE}`));
  assert.match(message, /裁定: owner:so/);
  assert.match(message, /task #42 で行う/);
});
