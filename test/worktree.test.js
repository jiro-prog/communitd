import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WORKTREE_DIR,
  isWorktreeDirIgnored,
  parseBranchList,
  parseWorktreeList,
  planPrepare,
  planRelease,
  planTaskCleanup,
  prepareWorktree,
  prepareWorktreeOnce,
  releaseWorktree,
  sameWorktreePath,
  worktreePathFor,
  worktreeRootFor,
} from '../src/worktree.js';

// 実パスは OS で形が変わるので、期待値は worktreePathFor から作って比べる
// (テストが Windows / POSIX のどちらでも同じ意味になるように)。
const REPO = join(tmpdir(), 'communitd-worktree-repo');
const LIST = 'worktree list --porcelain';
const BRANCHES = 'branch --list';

/** 終了コード付きの git 失敗 (実物の runGit が載せる形に合わせる) */
function gitFailure(exitCode, message = 'git failed') {
  return Object.assign(new Error(message), { exitCode });
}

/**
 * git の代わり。`args.join(' ')` の前方一致で返す値を選び、呼ばれた順に記録する。
 * Error を値に置くとその呼び出しが失敗する (check-ignore の exit 1 を作る用)。
 */
function fakeGit(responses = {}) {
  const calls = [];
  const git = async (repoRoot, args) => {
    calls.push(args.join(' '));
    for (const [prefix, value] of Object.entries(responses)) {
      if (args.join(' ').startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return '';
  };
  git.calls = calls;
  return git;
}

/** porcelain のブロックを 1 つ作る */
function block({ path, branch = null, head = 'abc123', extra = [] }) {
  return [
    `worktree ${path}`,
    `HEAD ${head}`,
    ...(branch ? [`branch refs/heads/${branch}`] : ['detached']),
    ...extra,
  ].join('\n');
}

test('worktreeRootFor / worktreePathFor はリポジトリ内の .worktrees へ畳む', () => {
  assert.equal(worktreeRootFor(REPO), join(resolve(REPO), WORKTREE_DIR));
  assert.equal(worktreePathFor(REPO, 9), join(resolve(REPO), WORKTREE_DIR, 'task-9'));
  assert.equal(worktreePathFor(REPO, '12'), join(resolve(REPO), WORKTREE_DIR, 'task-12'));
});

test('worktreePathFor はパス片に使えないタスク ID を拒否する', () => {
  // `../` でリポジトリの外を掘らせない。スラッシュ入り (ブランチ名の取り違え) も落とす
  for (const bad of ['../evil', 'task/9', '9;rm', '', null, undefined, 'a b']) {
    assert.throws(() => worktreePathFor(REPO, bad), /使えないタスク ID/);
  }
});

test('parseWorktreeList は porcelain をエントリへ分解する', () => {
  const out = [
    block({ path: '/repo', branch: 'main' }),
    '',
    block({ path: '/repo/.worktrees/task-9', branch: 'task/9' }),
    '',
    block({ path: '/repo/.worktrees/task-8', head: 'def456' }),
    '',
  ].join('\n');
  const list = parseWorktreeList(out);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((w) => [w.path, w.branch, w.detached]),
    [
      ['/repo', 'main', false],
      ['/repo/.worktrees/task-9', 'task/9', false],
      ['/repo/.worktrees/task-8', null, true],
    ],
  );
});

test('parseWorktreeList は locked / prunable / bare と CRLF を読む', () => {
  const out = [
    'worktree /repo\r',
    'bare\r',
    '\r',
    'worktree /repo/.worktrees/task-3\r',
    'HEAD abc\r',
    'branch refs/heads/task/3\r',
    'locked reason goes here\r',
    'prunable gitdir file points to non-existent location\r',
  ].join('\n');
  const list = parseWorktreeList(out);
  assert.equal(list.length, 2);
  assert.equal(list[0].bare, true);
  assert.equal(list[1].path, '/repo/.worktrees/task-3');
  assert.equal(list[1].branch, 'task/3');
  assert.equal(list[1].locked, true);
  assert.equal(list[1].prunable, true);
});

test('parseWorktreeList は空の出力を空配列にする', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList(null), []);
});

test('parseBranchList は空行を落として並べる', () => {
  assert.deepEqual(parseBranchList('main\r\ntask/8\r\ntask/9\r\n'), ['main', 'task/8', 'task/9']);
  assert.deepEqual(parseBranchList(''), []);
});

test('planPrepare は新しいブランチを base から生やす', () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planPrepare({ path, branch: 'task/9', base: 'main', worktrees: [], branches: ['main'] });
  assert.equal(plan.reused, false);
  assert.deepEqual(
    plan.steps.map((s) => s.args),
    [['worktree', 'add', '-b', 'task/9', path, 'main']],
  );
});

test('planPrepare は既にあるブランチを作り直さない (差し戻し 2 周目で作業を捨てない)', () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planPrepare({
    path,
    branch: 'task/9',
    base: 'main',
    worktrees: [],
    branches: ['main', 'task/9'],
  });
  assert.deepEqual(
    plan.steps.map((s) => s.args),
    [['worktree', 'add', path, 'task/9']],
  );
});

test('planPrepare は同じパスに同じブランチが居れば再利用する (job のたびに作り直さない)', () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planPrepare({
    path,
    branch: 'task/9',
    base: 'main',
    worktrees: [{ path, branch: 'task/9', prunable: false }],
    branches: ['task/9'],
  });
  assert.equal(plan.reused, true);
  assert.deepEqual(plan.steps, []);
});

test('planPrepare はパスの大文字小文字が違っても同じ作業ツリーとみなす (Windows のみ)', {
  // POSIX では大小が違えば本当に別のパスなので、畳む方が壊れる
  skip: process.platform !== 'win32',
}, () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planPrepare({
    path,
    branch: 'task/9',
    base: 'main',
    worktrees: [{ path: path.toUpperCase(), branch: 'task/9', prunable: false }],
    branches: ['task/9'],
  });
  assert.equal(plan.reused, true);
});

test('綴りの違う同じ場所は同じ作業ツリー (8.3 短縮名・junction・symlink)', () => {
  // git は必ず**実体の綴り**で報告するのに、こちらは設定値から組み立てた綴りを持っている。
  // 文字列比較だけだったころ、TEMP が 8.3 短縮名の環境 (GitHub Actions の windows runner)
  // で planRelease が撤去先を「登録されていない」と判断し、作業ツリーも枝も残った (2026-09-11)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-wtpath-')));
  const real = join(root, 'real');
  const link = join(root, 'link');
  mkdirSync(join(real, 'task-1'), { recursive: true });
  try {
    symlinkSync(real, link, 'junction'); // type は Windows だけで効く (他は普通の symlink)
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    assert.fail(`symlink を作れない環境: ${err.message}`);
  }
  try {
    assert.equal(
      sameWorktreePath(join(link, 'task-1'), join(real, 'task-1')),
      true,
      '同じ場所を別の作業ツリーと見ている (撤去も再利用も効かなくなる)',
    );
    // 別の場所は畳まない (実体で引いても違うものは違う)
    mkdirSync(join(root, 'other', 'task-1'), { recursive: true });
    assert.equal(sameWorktreePath(join(root, 'other', 'task-1'), join(real, 'task-1')), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('planPrepare は同じパスに別ブランチが残っていたら落ちる (#9 の再発防止)', () => {
  const path = worktreePathFor(REPO, 9);
  assert.throws(
    () =>
      planPrepare({
        path,
        branch: 'task/9',
        base: 'main',
        worktrees: [{ path, branch: 'task/8', prunable: false }],
        branches: ['task/8', 'task/9'],
      }),
    /別のブランチ \(task\/8\)/,
  );
});

test('planPrepare はブランチを別の作業ツリーが掴んでいたら落ちる', () => {
  const path = worktreePathFor(REPO, 9);
  assert.throws(
    () =>
      planPrepare({
        path,
        branch: 'task/9',
        base: 'main',
        worktrees: [{ path: '/elsewhere', branch: 'task/9', prunable: false }],
        branches: ['task/9'],
      }),
    /別の作業ツリー \(\/elsewhere\) が掴んでいる/,
  );
});

test('planPrepare は消えた作業ツリーの登録を掃除してから作り直す', () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planPrepare({
    path,
    branch: 'task/9',
    base: 'main',
    worktrees: [{ path, branch: 'task/9', prunable: true }],
    branches: ['task/9'],
  });
  assert.equal(plan.reused, false);
  assert.deepEqual(
    plan.steps.map((s) => s.args),
    [
      ['worktree', 'prune'],
      ['worktree', 'add', path, 'task/9'],
    ],
  );
});

test('planPrepare は branch / base の省略を拒否する', () => {
  const path = worktreePathFor(REPO, 9);
  assert.throws(() => planPrepare({ path, base: 'main' }), /branch は省略できない/);
  assert.throws(() => planPrepare({ path, branch: 'task/9' }), /base は省略できない/);
});

test('planRelease は作業ツリーがあれば remove、無ければ何もしない', () => {
  const path = worktreePathFor(REPO, 9);
  const gone = planRelease({ path, expectedBranch: 'task/9', worktrees: [] });
  assert.equal(gone.missing, true);
  assert.deepEqual(gone.steps, []);

  const plan = planRelease({
    path,
    expectedBranch: 'task/9',
    worktrees: [{ path, branch: 'task/9' }],
  });
  assert.equal(plan.missing, false);
  assert.deepEqual(
    plan.steps.map((s) => s.args),
    [['worktree', 'remove', path]],
  );
});

test('planRelease の force は --force を足すだけ (未コミットの門番は git 側)', () => {
  const path = worktreePathFor(REPO, 9);
  const plan = planRelease({
    path,
    expectedBranch: 'task/9',
    worktrees: [{ path, branch: 'task/9' }],
    force: true,
  });
  assert.deepEqual(
    plan.steps.map((s) => s.args),
    [['worktree', 'remove', '--force', path]],
  );
});

test('planRelease は掴んでいるブランチが違えば撤去しない (別タスクの作業を消さない)', () => {
  const path = worktreePathFor(REPO, 9);
  // 前のタスクの残骸が同じ場所に残っている状況。force でも 1 手も打たせない
  for (const force of [false, true]) {
    assert.throws(
      () =>
        planRelease({
          path,
          expectedBranch: 'task/9',
          worktrees: [{ path, branch: 'task/8' }],
          force,
        }),
      /掴んでいるのは task\/8 で、task\/9 ではない/,
    );
  }
  assert.throws(
    () =>
      planRelease({
        path,
        expectedBranch: 'task/9',
        worktrees: [{ path, branch: null }],
        force: true,
      }),
    /掴んでいるのは detached で/,
  );
});

test('planRelease は expectedBranch の省略を拒否する', () => {
  const path = worktreePathFor(REPO, 9);
  assert.throws(
    () => planRelease({ path, worktrees: [{ path, branch: 'task/9' }] }),
    /expectedBranch は省略できない/,
  );
});

test('planTaskCleanup: merged は枝ごと・dropped はツリーだけ・それ以外は触らない', () => {
  assert.deepEqual(
    planTaskCleanup({ action: 'complete', branch: 'task/41' }),
    { release: true, force: false, deleteBranch: true },
  );
  // dropped でブランチを消さないのは、未マージの commit が載っていることがあるため
  assert.deepEqual(
    planTaskCleanup({ action: 'drop', branch: 'task/46' }),
    { release: true, force: false, deleteBranch: false },
  );
  // 仕事が続いている判定では撤去しない (差し戻し先の作業ツリーを消さない)
  for (const action of ['send-back', 'block', 'none', '', undefined]) {
    assert.deepEqual(
      planTaskCleanup({ action, branch: 'task/41' }),
      { release: false, force: false, deleteBranch: false },
      String(action),
    );
  }
  // 撤去先が決められないなら 1 手も打たない (planRelease の expectedBranch が要る)
  for (const branch of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(
      planTaskCleanup({ action: 'complete', branch }),
      { release: false, force: false, deleteBranch: false },
      JSON.stringify(branch) ?? 'undefined',
    );
  }
  assert.deepEqual(planTaskCleanup(), { release: false, force: false, deleteBranch: false });
  // force は常に false — dirty な作業ツリーは git が拒否して残すのが正しい
  for (const action of ['complete', 'drop']) {
    assert.equal(planTaskCleanup({ action, branch: 'task/1' }).force, false, action);
  }
});

test('isWorktreeDirIgnored は exit 0 を true、exit 1 を false にする', async () => {
  assert.equal(await isWorktreeDirIgnored({ repoRoot: REPO, git: fakeGit() }), true);
  const notIgnored = fakeGit({ 'check-ignore': gitFailure(1) });
  assert.equal(await isWorktreeDirIgnored({ repoRoot: REPO, git: notIgnored }), false);
});

test('isWorktreeDirIgnored は git が動かなかった失敗を握り潰さない', async () => {
  // リポジトリが読めない (128) を「無視設定が無い」に畳むと、パスの間違いを
  // .gitignore の不備として報告してしまう (2026-08-28 に実際に取り違えた)
  const broken = fakeGit({ 'check-ignore': gitFailure(128, 'cannot change to ...') });
  await assert.rejects(isWorktreeDirIgnored({ repoRoot: REPO, git: broken }), /cannot change to/);

  const unknown = fakeGit({ 'check-ignore': gitFailure(null, 'spawn ENOENT') });
  await assert.rejects(isWorktreeDirIgnored({ repoRoot: REPO, git: unknown }), /ENOENT/);
});

test('prepareWorktree は .gitignore に .worktrees/ が無ければ何も作らずに落ちる', async () => {
  const git = fakeGit({ 'check-ignore': gitFailure(1) });
  await assert.rejects(
    prepareWorktree({ repoRoot: REPO, taskId: 9, branch: 'task/9', base: 'main', git }),
    /無視されていない/,
  );
  // 確認の 1 手だけで止まる — worktree list も add も打たない
  assert.deepEqual(git.calls, [`check-ignore -q ${WORKTREE_DIR}/`]);
});

test('prepareWorktree は現状を読んでから計画どおりに git を打つ', async () => {
  const path = worktreePathFor(REPO, 9);
  const git = fakeGit({
    [LIST]: block({ path: REPO, branch: 'main' }),
    [BRANCHES]: 'main\n',
  });
  const plan = await prepareWorktree({
    repoRoot: REPO,
    taskId: 9,
    branch: 'task/9',
    base: 'main',
    git,
  });
  assert.equal(plan.path, path);
  assert.equal(plan.reused, false);
  assert.deepEqual(git.calls, [
    `check-ignore -q ${WORKTREE_DIR}/`,
    LIST,
    'branch --list --format=%(refname:short)',
    `worktree add -b task/9 ${path} main`,
  ]);
});

test('prepareWorktree は再利用のとき add を打たない', async () => {
  const path = worktreePathFor(REPO, 9);
  const git = fakeGit({
    [LIST]: [block({ path: REPO, branch: 'main' }), '', block({ path, branch: 'task/9' })].join('\n'),
    [BRANCHES]: 'main\ntask/9\n',
  });
  const plan = await prepareWorktree({
    repoRoot: REPO,
    taskId: 9,
    branch: 'task/9',
    base: 'main',
    git,
  });
  assert.equal(plan.reused, true);
  assert.equal(
    git.calls.some((c) => c.startsWith('worktree add')),
    false,
  );
});

test('releaseWorktree は残っていれば remove を打ち、無ければ git を足さない', async () => {
  const path = worktreePathFor(REPO, 9);
  const present = fakeGit({ [LIST]: block({ path, branch: 'task/9' }) });
  const plan = await releaseWorktree({ repoRoot: REPO, taskId: 9, branch: 'task/9', git: present });
  assert.equal(plan.missing, false);
  assert.deepEqual(present.calls, [LIST, `worktree remove ${path}`]);

  const absent = fakeGit({ [LIST]: block({ path: REPO, branch: 'main' }) });
  const gone = await releaseWorktree({ repoRoot: REPO, taskId: 9, branch: 'task/9', git: absent });
  assert.equal(gone.missing, true);
  assert.deepEqual(absent.calls, [LIST]);
});

test('prepareWorktreeOnce は同じ鍵の要求を 1 本にまとめる', async () => {
  // 作成はレーンの直列化より前に走るので、同じ新規タスクへ 2 つのトリガーが重なると
  // 両方が「まだ無い」と判断して worktree add が二重に走る (Sol 指摘 2026-08-28)
  let calls = 0;
  let release;
  const run = () => {
    calls += 1;
    return new Promise((res) => { release = res; });
  };
  const first = prepareWorktreeOnce('repo::9', run);
  const second = prepareWorktreeOnce('repo::9', run);
  assert.equal(calls, 1, '2 回走っている');

  release('done');
  assert.equal(await first, 'done');
  assert.equal(await second, 'done', '後から来た方が結果を受け取れていない');

  // 終わった鍵は残さない (次のトリガーは作り直しの判断からやり直す)
  assert.equal(await prepareWorktreeOnce('repo::9', () => Promise.resolve('again')), 'again');
  assert.equal(calls, 1);
});

test('prepareWorktreeOnce は鍵が違えば別々に走り、失敗した鍵も残さない', async () => {
  const started = [];
  const slow = (name) => prepareWorktreeOnce(name, () => {
    started.push(name);
    return Promise.resolve(name);
  });
  assert.deepEqual(await Promise.all([slow('repo::1'), slow('repo::2')]), ['repo::1', 'repo::2']);
  assert.deepEqual(started, ['repo::1', 'repo::2']);

  await assert.rejects(
    prepareWorktreeOnce('repo::3', () => Promise.reject(new Error('add に失敗'))),
    /add に失敗/,
  );
  // 失敗を鍵に残すと、直したあとも同じ失敗を返し続けることになる
  assert.equal(await prepareWorktreeOnce('repo::3', () => Promise.resolve('ok')), 'ok');
});

test('releaseWorktree は別ブランチを掴んだツリーへ remove を打たない', async () => {
  const path = worktreePathFor(REPO, 9);
  const git = fakeGit({ [LIST]: block({ path, branch: 'task/8' }) });
  await assert.rejects(
    releaseWorktree({ repoRoot: REPO, taskId: 9, branch: 'task/9', force: true, git }),
    /別タスクの作業を消しうる/,
  );
  assert.deepEqual(git.calls, [LIST]); // 現状を読んだだけで止まる
});
