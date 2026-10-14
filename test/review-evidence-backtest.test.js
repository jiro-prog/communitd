import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { installStopHandlers, main, parseArgs } from '../scripts/review-evidence-backtest.mjs';
import {
  backtestReviewEvidence,
  formatBacktestRow,
  formatBacktestSummary,
  listSubmissions,
  parseMergeNote,
  summarizeBacktest,
} from '../src/review-evidence-backtest.js';
import { planReview } from '../src/scheduler.js';
import { parseWorktreeList, runGit, sameWorktreePath } from '../src/worktree.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

/** commit の日時を固定して打つ (提出の commit は日時で選ぶので) */
function gitAt(cwd, iso, ...args) {
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  return git(cwd, 'rev-parse', 'HEAD');
}

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function commit(repo, iso, message, files) {
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  return gitAt(repo, iso, 'commit', '-q', '-m', message);
}

const at = (hhmm) => `2026-10-01T${hhmm}:00.000Z`;

/** ブリッジが書く merge の note (src/scheduler.js の planReview) — 読む側と組み立て側を同じ字面で結ぶ */
function noteOf(mergeCommit, tip, branch) {
  return planReview({ verdict: 'merge', merge_commit: mergeCommit }, {
    git: {
      commit: mergeCommit, commitInBase: true, branchTip: tip, branchTipInCommit: true,
      baseBranch: 'main', baseHead: mergeCommit, branch,
    },
  }).note;
}

const step = (when, from, to, note) => ({ at: when, from, to, by: 'bot', ...(note ? { note } : {}) });

/**
 * 一時リポジトリ (main だけの checkout) と、その履歴に合わせたボード。
 *
 * - task 1: 提出 1 (A) → 差し戻し → main を取り込み (main 側の X は A より新しく提出 1 より古い) → 修正 B → 提出 2 → merge M1
 * - task 2: 提出の時刻がブランチの最初の commit より前 (遡ると M1 = 基点の祖先) → 飛ばす
 * - task 3: merge の note が読めない → 飛ばす
 * - task 5: package-lock.json を変える D → merge M3
 * - task 4 (in-progress) と別チャンネルの merge 済みタスクは並べない
 */
function makeFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-backtest-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const tempRoot = join(dir, 'scratch');
  mkdirSync(repo);
  mkdirSync(tempRoot);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  commit(repo, at('00:00'), 'base', {
    'package.json': '{ "type": "module" }\n',
    'package-lock.json': '{ "v": 1 }\n',
    'src/a.js': 'export const a = 1;\n',
    'test/a.test.js': '// a\n',
  });
  git(repo, 'checkout', '-q', '-b', 'task/1');
  const A = commit(repo, at('01:00'), 'A', { 'src/a.js': 'export const a = 2;\n' });
  git(repo, 'checkout', '-q', 'main');
  const X = commit(repo, at('01:05'), 'X', { 'src/x.js': 'export const x = 1;\n' });
  git(repo, 'checkout', '-q', 'task/1');
  gitAt(repo, at('01:25'), 'merge', '-q', '--no-ff', '-m', 'main を取り込む', 'main');
  const B = commit(repo, at('01:30'), 'B', { 'test/a.test.js': '// a fixed\n' });
  git(repo, 'checkout', '-q', 'main');
  const M1 = gitAt(repo, at('02:00'), 'merge', '-q', '--no-ff', '-m', 'merge task/1', 'task/1');
  git(repo, 'checkout', '-q', '-b', 'task/2');
  const C = commit(repo, at('03:00'), 'C', { 'src/c.js': 'export const c = 1;\n' });
  git(repo, 'checkout', '-q', 'main');
  const M2 = gitAt(repo, at('03:30'), 'merge', '-q', '--no-ff', '-m', 'merge task/2', 'task/2');
  git(repo, 'checkout', '-q', '-b', 'task/5');
  const D = commit(repo, at('04:00'), 'D', { 'package-lock.json': '{ "v": 2 }\n', 'src/d.js': 'export const d = 1;\n' });
  git(repo, 'checkout', '-q', 'main');
  const M3 = gitAt(repo, at('04:20'), 'merge', '-q', '--no-ff', '-m', 'merge task/5', 'task/5');

  const tasks = [
    {
      id: 5, channel: 'dev', state: 'merged', history: [
        step(at('03:40'), 'approved', 'in-progress'),
        step(at('04:10'), 'in-progress', 'review'),
        step(at('04:20'), 'review', 'merged', noteOf(M3, D, 'task/5')),
      ],
    },
    {
      id: 1, channel: 'dev', state: 'merged', history: [
        step(at('00:30'), 'approved', 'in-progress'),
        step(at('01:10'), 'in-progress', 'review'),
        step(at('01:20'), 'review', 'in-progress', '【差し戻しの理由】…'),
        step(at('01:40'), 'in-progress', 'review'),
        step(at('02:00'), 'review', 'merged', noteOf(M1, B, 'task/1')),
      ],
    },
    {
      id: 2, channel: 'dev', state: 'merged', history: [
        step(at('02:10'), 'approved', 'in-progress'),
        step(at('02:30'), 'in-progress', 'review'),
        step(at('03:30'), 'review', 'merged', noteOf(M2, C, 'task/2')),
      ],
    },
    {
      id: 3, channel: 'dev', state: 'merged', history: [
        step(at('05:00'), 'in-progress', 'review'),
        step(at('05:10'), 'review', 'merged', 'merge (適用の経路 が照合)'),
      ],
    },
    { id: 4, channel: 'dev', state: 'in-progress', history: [step(at('05:00'), 'in-progress', 'review')] },
    {
      id: 9, channel: 'other', state: 'merged', history: [
        step(at('05:00'), 'in-progress', 'review'),
        step(at('05:10'), 'review', 'merged', noteOf(M1, B, 'task/9')),
      ],
    },
  ];
  return { dir, repo, tempRoot, tasks, shas: { A, X, B, M1, C, M2, D, M3 } };
}

const noSrcResult = (base) => ({
  outcome: 'no-src', base, mergeBase: '0123456789abc', src: { added: [], restored: [] },
  tests: ['test/a.test.js'], deletedTests: [],
});
const measuredResult = (base, passes) => ({
  outcome: 'measured', base, mergeBase: '0123456789abc', src: { added: [], restored: ['src/a.js'] },
  tests: ['test/a.test.js'], deletedTests: [],
  runs: [{ file: 'test/a.test.js', verdict: passes ? 'passes' : 'fails' }],
  counts: { fails: passes ? 0 : 1, passes: passes ? 1 : 0, headFails: 0 },
});

/** 呼ばれた時点の作業ツリー (HEAD と dirty か) を記録する偽の測定 */
function fakeMeasure(calls, respond = ({ base }) => noSrcResult(base)) {
  return async (args) => {
    calls.push({
      cwd: args.cwd,
      base: args.base,
      head: git(args.cwd, 'rev-parse', 'HEAD'),
      dirty: git(args.cwd, 'status', '--porcelain'),
    });
    return respond(args, calls.length);
  };
}

/** 本体の `git worktree list` に、本体以外が残っていない */
function assertNoExtraWorktree(repo) {
  const listed = parseWorktreeList(git(repo, 'worktree', 'list', '--porcelain'));
  assert.equal(listed.length, 1, `worktree が残っている: ${listed.map((w) => w.path).join(', ')}`);
  assert.ok(sameWorktreePath(listed[0].path, repo));
}

test('parseMergeNote: planReview が書く merge の note から merge commit と枝の先端を読む', () => {
  const note = noteOf('a'.repeat(40), 'b'.repeat(40), 'task/7');
  assert.deepEqual(parseMergeNote(note), {
    commit: 'a'.repeat(40), baseBranch: 'main', baseHead: 'a'.repeat(40), branch: 'task/7', tip: 'b'.repeat(40),
  });
  // base の先端が「不明」の形も読む
  assert.equal(parseMergeNote(`merge ${'c'.repeat(40)} (base dev@不明, branch task/8@${'d'.repeat(40)})`).tip, 'd'.repeat(40));
  for (const bad of [undefined, '', 'merge (適用の経路 が照合)', `merge ${'a'.repeat(40)} (base dev@x)`]) {
    assert.equal(parseMergeNote(bad), null, String(bad));
  }
});

test('listSubmissions: チャンネルの merge 済みタスクの review 遷移を id 順に並べ、差し戻し / 通過を付ける', () => {
  const { tasks, submissions } = listSubmissions([
    {
      id: 12, channel: 'dev', state: 'merged', history: [
        step(at('01:00'), 'in-progress', 'review'),
        step(at('01:10'), 'review', 'in-progress', '差し戻し'),
        step(at('01:20'), 'in-progress', 'review'),
        step(at('01:30'), 'review', 'blocked'),
        step(at('01:40'), 'blocked', 'in-progress'),
        step(at('01:50'), 'in-progress', 'review'),
        step(at('02:00'), 'review', 'merged', `merge ${'a'.repeat(40)} (base dev@x, branch task/12@${'b'.repeat(40)})`),
      ],
    },
    {
      id: 3, channel: 'dev', state: 'merged', history: [
        step('読めない時刻', 'in-progress', 'review'),
        step(at('00:30'), 'review', 'merged', `merge ${'c'.repeat(40)} (base dev@x, branch task/3@${'d'.repeat(40)})`),
      ],
    },
    { id: 4, channel: 'dev', state: 'merged', history: [step(at('00:10'), 'in-progress', 'review'), step(at('00:20'), 'review', 'merged', 'merge ?')] },
    { id: 5, channel: 'dev', state: 'review', history: [step(at('00:10'), 'in-progress', 'review')] },
    { id: 6, channel: 'elsewhere', state: 'merged', history: [step(at('00:10'), 'in-progress', 'review')] },
  ], { channel: 'dev' });
  assert.equal(tasks, 3);
  assert.deepEqual(submissions.map(({ id, k, n, outcome, skip }) => ({ id, k, n, outcome, skip })), [
    { id: 3, k: 1, n: 1, outcome: 'passed', skip: 'review の遷移の時刻が読めない (読めない時刻)' },
    { id: 4, k: 1, n: 1, outcome: 'passed', skip: 'merge の note が読めない' },
    { id: 12, k: 1, n: 3, outcome: 'rejected', skip: undefined },
    { id: 12, k: 2, n: 3, outcome: 'other', skip: undefined },
    { id: 12, k: 3, n: 3, outcome: 'passed', skip: undefined },
  ]);
  assert.equal(submissions[2].at, at('01:00'));
  assert.equal(submissions[2].merge.branch, 'task/12');
});

test('listSubmissions: --ids で絞り、merge 済みタスクに無い id は断る', () => {
  const board = [
    { id: 1, channel: 'dev', state: 'merged', history: [step(at('00:10'), 'in-progress', 'review')] },
    { id: 2, channel: 'dev', state: 'merged', history: [step(at('00:10'), 'in-progress', 'review')] },
    { id: 3, channel: 'dev', state: 'review', history: [] },
  ];
  assert.deepEqual(listSubmissions(board, { channel: 'dev', ids: [2] }).submissions.map((s) => s.id), [2]);
  assert.throws(() => listSubmissions(board, { channel: 'dev', ids: [2, 3, 7] }), /dev の merge 済みタスクに無い id: #3 #7/);
});

test('backtest: 差し戻し前の提出は修正前の commit で測り、ブランチ上に無い提出と note の読めない提出は理由付きで飛ばす', async (t) => {
  const { repo, tempRoot, tasks, shas } = makeFixture(t);
  const { submissions } = listSubmissions(tasks, { channel: 'dev' });
  const calls = [];
  const installs = [];
  const printed = [];
  const result = await backtestReviewEvidence({
    root: repo,
    submissions,
    git: runGit,
    measure: fakeMeasure(calls, ({ base }, n) => (n === 1 ? measuredResult(base, true) : noSrcResult(base))),
    install: async ({ cwd }) => installs.push(readFileSync(join(cwd, 'package-lock.json'), 'utf8')),
    tempRoot,
    onRow: (row) => printed.push(formatBacktestRow(row)),
  });

  assert.deepEqual(result.rows.map(({ id, k, sha, base, skip }) => ({ id, k, sha, base, skip })), [
    // 提出 1 は差し戻しの前 — 修正の B でも、提出 1 より前に main で入った X でもない (first-parent で辿る)
    { id: 1, k: 1, sha: shas.A, base: shas.X, skip: undefined },
    { id: 1, k: 2, sha: shas.B, base: shas.X, skip: undefined },
    { id: 2, k: 1, sha: undefined, base: undefined, skip: `ブランチ上に commit が無い — 提出時の ${shas.M1.slice(0, 7)} は基点 ${shas.M1.slice(0, 7)} の祖先` },
    { id: 3, k: 1, sha: undefined, base: undefined, skip: 'merge の note が読めない' },
    { id: 5, k: 1, sha: shas.D, base: shas.M2, skip: undefined },
  ]);
  // 測定は提出の commit を checkout した、本体の外の worktree で走る。基点は第 1 親の短い名前
  assert.deepEqual(calls.map((c) => c.head), [shas.A, shas.B, shas.D]);
  for (const call of calls) {
    assert.ok(call.cwd.startsWith(tempRoot), call.cwd);
    assert.ok(shas.X.startsWith(call.base) || shas.M2.startsWith(call.base), call.base);
  }
  // npm ci は最初と package-lock.json が変わったときだけ (B は A と同じ lock)
  assert.deepEqual(installs, ['{ "v": 1 }\n', '{ "v": 2 }\n']);
  assert.equal(result.rows[0].evidenceKind.kind, 'measured');
  assert.equal(result.rows[1].evidenceKind.kind, 'no-src');
  assert.match(printed[0], new RegExp(`^#1 提出 1/2・差し戻し・${shas.A.slice(0, 7)}・変更前の src で落ちる 0 / 落ちない 1 .*・\\d+(\\.\\d)? 秒 \\(npm ci \\d+(\\.\\d)? 秒\\)$`));
  assert.match(printed[2], /^#2 提出 1\/1・通過・飛ばした: ブランチ上に commit が無い/);
  assert.deepEqual({ stopped: result.stopped, remaining: result.remaining, leftover: result.leftover }, { stopped: false, remaining: 0, leftover: null });
  // worktree は消え、一時ディレクトリも残らない
  assertNoExtraWorktree(repo);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('backtest: 前の測定が作業ツリーを汚したまま返っても、次の提出は提出の commit そのもので測る', async (t) => {
  const { repo, tempRoot, tasks, shas } = makeFixture(t);
  const { submissions } = listSubmissions(tasks, { channel: 'dev', ids: [1] });
  const calls = [];
  await backtestReviewEvidence({
    root: repo,
    submissions,
    measure: fakeMeasure(calls, ({ cwd, base }) => {
      writeFileSync(join(cwd, 'src', 'a.js'), 'export const a = "戻し損ねた";\n');
      return noSrcResult(base);
    }),
    install: async () => {},
    tempRoot,
  });
  assert.deepEqual(calls.map((c) => [c.head, c.dirty]), [[shas.A, ''], [shas.B, '']]);
  assertNoExtraWorktree(repo);
});

test('backtest: 測定が投げた提出は「測れませんでした」の行にして続け、worktree は消す', async (t) => {
  const { repo, tempRoot, tasks } = makeFixture(t);
  const { submissions } = listSubmissions(tasks, { channel: 'dev', ids: [1] });
  const calls = [];
  const result = await backtestReviewEvidence({
    root: repo,
    submissions,
    measure: fakeMeasure(calls, ({ base }, n) => {
      if (n === 1) throw new Error('作業ツリーが HEAD に戻りませんでした: src/a.js');
      return noSrcResult(base);
    }),
    install: async () => {},
    tempRoot,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.rows[0].evidence, '測れませんでした — 作業ツリーが HEAD に戻りませんでした: src/a.js');
  assert.equal(result.rows[0].evidenceKind.kind, 'unmeasured');
  assert.equal(result.rows[1].evidenceKind.kind, 'no-src');
  assertNoExtraWorktree(repo);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('backtest: 途中で git が失敗して投げても、worktree は消してから投げる', async (t) => {
  const { repo, tempRoot, tasks } = makeFixture(t);
  const { submissions } = listSubmissions(tasks, { channel: 'dev' });
  let checkouts = 0;
  const failingGit = async (cwd, args) => {
    if (args[0] === 'checkout' && ++checkouts === 2) throw new Error('git checkout が失敗: 偽の失敗');
    return runGit(cwd, args);
  };
  await assert.rejects(
    backtestReviewEvidence({ root: repo, submissions, git: failingGit, measure: fakeMeasure([]), install: async () => {}, tempRoot }),
    /偽の失敗/,
  );
  assertNoExtraWorktree(repo);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('backtest: 停止が来たら次の提出へ進まず、途中の提出は数えずに worktree を消す', async (t) => {
  const { repo, tempRoot, tasks } = makeFixture(t);
  const { submissions } = listSubmissions(tasks, { channel: 'dev' });
  const handle = { stopRequested: false };
  const calls = [];
  const result = await backtestReviewEvidence({
    root: repo,
    submissions,
    handle,
    measure: fakeMeasure(calls, ({ base }) => {
      handle.stopRequested = true;
      return { outcome: 'stopped', base, ran: 1, planned: 3 };
    }),
    install: async () => {},
    tempRoot,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].stopped, true);
  assert.equal(result.remaining, submissions.length);
  assert.equal(summarizeBacktest(result.rows).submissions, 0);
  assert.match(formatBacktestSummary(result), /停止で中断 — 残り 5 提出は数えずに worktree を消した/);
  assertNoExtraWorktree(repo);

  // 始めから止まっていれば worktree も作らない
  const idle = await backtestReviewEvidence({
    root: repo, submissions, handle: { stopRequested: true }, measure: fakeMeasure([]), install: async () => {}, tempRoot,
  });
  assert.deepEqual({ rows: idle.rows, stopped: idle.stopped, remaining: idle.remaining }, { rows: [], stopped: true, remaining: 5 });
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('backtest: 本物の測定を一時 worktree で走らせ、変更前の src で落ちるテストを数える', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-backtest-real-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  commit(repo, at('00:00'), 'base', {
    'package.json': '{ "type": "module" }\n',
    'src/math.js': 'export const add = (a, b) => a - b;\n',
  });
  git(repo, 'checkout', '-q', '-b', 'task/1');
  const tip = commit(repo, at('01:00'), 'fix', {
    'src/math.js': 'export const add = (a, b) => a + b;\n',
    'test/math.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
      + "import { add } from '../src/math.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
  });
  git(repo, 'checkout', '-q', 'main');
  const merge = gitAt(repo, at('02:00'), 'merge', '-q', '--no-ff', '-m', 'merge task/1', 'task/1');
  const { submissions } = listSubmissions([{
    id: 1, channel: 'dev', state: 'merged', history: [
      step(at('01:10'), 'in-progress', 'review'),
      step(at('02:00'), 'review', 'merged', noteOf(merge, tip, 'task/1')),
    ],
  }], { channel: 'dev' });
  const result = await backtestReviewEvidence({
    root: repo,
    submissions,
    install: async () => assert.fail('package-lock.json が無いので npm ci は走らない'),
    tempRoot: dir,
  });
  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0].evidence, /^変更前の src で落ちる 1 \/ 落ちない 0 \/ HEAD でも落ちる 0 /);
  assertNoExtraWorktree(repo);
});

test('summarizeBacktest / formatBacktestSummary: 種類ごとに差し戻し / 通過を数え、その他は 1 件でもあるときだけ出す', () => {
  const kind = (k, extra = {}) => ({ kind: k, ...extra });
  const rows = [
    { id: 1, k: 1, n: 2, outcome: 'rejected', evidenceKind: kind('measured', { passes: 2, deletedFiles: 1, vanishedNames: 0 }) },
    { id: 1, k: 2, n: 2, outcome: 'passed', evidenceKind: kind('measured', { passes: 0 }) },
    { id: 2, k: 1, n: 1, outcome: 'passed', evidenceKind: kind('no-src') },
    { id: 3, k: 1, n: 1, outcome: 'rejected', evidenceKind: kind('no-src') },
    { id: 4, k: 1, n: 1, outcome: 'passed', evidenceKind: kind('unmeasured') },
    { id: 5, k: 1, n: 1, outcome: 'passed', skip: 'merge の note が読めない' },
    { id: 6, k: 1, n: 1, outcome: 'passed', stopped: true, evidenceKind: kind('unmeasured') },
  ];
  const summary = summarizeBacktest(rows);
  assert.deepEqual({ submissions: summary.submissions, rejected: summary.rejected, passed: summary.passed }, { submissions: 6, rejected: 2, passed: 4 });
  assert.deepEqual(summary.kinds.measured, { rejected: 1, passed: 1, other: 0 });
  assert.deepEqual(summary.kinds.withPasses, { rejected: 1, passed: 0, other: 0 });
  assert.deepEqual(summary.kinds.withDeleted, { rejected: 1, passed: 0, other: 0 });
  assert.deepEqual(summary.kinds.skipped, { rejected: 0, passed: 1, other: 0 });
  assert.equal(formatBacktestSummary({ rows, tasks: 6 }), [
    '集計 — 提出 6 件 (merge 済み 6 件)・差し戻し 2 / 通過 4・飛ばした 1',
    '  測った (落ちる / 落ちない): 2 (差し戻し 1 / 通過 1)',
    '  うち落ちないあり: 1 (差し戻し 1 / 通過 0)',
    '  src の差分なし: 2 (差し戻し 1 / 通過 1)',
    '  測れず: 1 (差し戻し 0 / 通過 1)',
    '  消したテストあり (種類をまたぐ): 1 (差し戻し 1 / 通過 0)',
    '  飛ばした: 1 (差し戻し 0 / 通過 1)',
  ].join('\n'));
  const withOther = formatBacktestSummary({ rows: [{ id: 7, k: 1, n: 1, outcome: 'other', evidenceKind: kind('no-tests') }], leftover: '/tmp/x/wt' });
  assert.match(withOther, /・差し戻し 0 \/ 通過 0 \/ その他 1・/);
  assert.match(withOther, /\n {2}テストの変更なし: 1 \(差し戻し 0 \/ 通過 0 \/ その他 1\)/);
  assert.match(withOther, /\nworktree が消えずに残った: \/tmp\/x\/wt/);
});

test('parseArgs: --channel は必須、--ids はカンマ区切りの正の整数、知らないオプションは断る', () => {
  const opts = parseArgs(['--channel', 'dev', '--ids', '#108, 148,108', '--json'], { root: '/r' });
  assert.deepEqual({ channel: opts.channel, ids: opts.ids, json: opts.json }, { channel: 'dev', ids: [108, 148], json: true });
  assert.match(opts.tasks, /data[\\/]tasks\.json$/);
  assert.equal(parseArgs(['--channel', 'dev']).ids, null);
  assert.throws(() => parseArgs([]), /--channel .* は必須/);
  assert.throws(() => parseArgs(['--channel', 'dev', '--base', 'main']), /知らないオプション: --base/);
  assert.throws(() => parseArgs(['--channel', 'dev', '--ids', '1,x']), /読めない値: x/);
  assert.throws(() => parseArgs(['--channel', '--json']), /--channel に値が渡されていません/);
});

test('main: 提出ごとの行と集計を出し、ボードのファイルには何も書かない', async (t) => {
  const { dir, repo, tempRoot, tasks } = makeFixture(t);
  const file = join(dir, 'tasks.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(tasks.map((task) => [task.id, task]))));
  const before = { text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs };
  const printed = [];
  const code = await main(['--channel', 'dev', '--ids', '1,2', '--tasks', file], {
    root: repo,
    backtest: (p) => backtestReviewEvidence({ ...p, measure: fakeMeasure([]), install: async () => {}, tempRoot }),
    proc: new EventEmitter(),
    print: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  assert.equal(printed.length, 4);
  assert.match(printed[0], /^#1 提出 1\/2・差し戻し・/);
  assert.match(printed[3], /^集計 — 提出 3 件 \(merge 済み 2 件\)・差し戻し 1 \/ 通過 2・飛ばした 1/);
  assert.deepEqual({ text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs }, before);
  assertNoExtraWorktree(repo);

  // --json は全体を 1 つの JSON で。停止・消し残しは exit 1
  const json = [];
  const stopped = await main(['--channel', 'dev', '--tasks', file, '--json'], {
    root: repo,
    backtest: async () => ({ rows: [], stopped: true, remaining: 4, leftover: null }),
    proc: new EventEmitter(),
    print: (line) => json.push(line),
  });
  assert.equal(stopped, 1);
  assert.deepEqual(JSON.parse(json[0]).summary.submissions, 0);
  assert.equal(JSON.parse(json[0]).tasks, 4);
});

test('installStopHandlers: 1 回目は abort だけ、2 回目は worktree を消すのを待たずに exit 1', () => {
  const proc = new EventEmitter();
  const stderr = [];
  let exited = null;
  proc.stderr = { write: (text, done) => { stderr.push(text); done(); } };
  proc.exit = (code) => { exited = code; };
  let aborts = 0;
  const uninstall = installStopHandlers({ handle: { abort: () => { aborts += 1; } }, proc });
  proc.emit('SIGINT');
  assert.deepEqual({ aborts, exited }, { aborts: 1, exited: null });
  proc.emit('SIGTERM');
  assert.deepEqual({ aborts, exited }, { aborts: 1, exited: 1 });
  assert.match(stderr[0], /worktree を消さずに終了/);
  uninstall();
  assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0);
});
