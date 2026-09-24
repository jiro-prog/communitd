import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abandonApplyTask,
  applyBranchFor,
  applyCandidates,
  findApplyProposal,
  mergeApplyTask,
  pickApplyCandidate,
  reclaimStaleApplies,
  resumeApplyTrials,
  startOrgApply,
  sweepApplyCandidates,
} from '../src/orgapply-wiring.js';
import { orgApplyLine } from '../src/bridge/orgapply.js';
import { TaskBoardStore } from '../src/board.js';
import { POLICY_FILE } from '../src/config.js';
import { ProposalStore, createRepoContext } from '../src/proposals.js';
import {
  parseBranchList, parseWorktreeList, releaseWorktree, runGit, worktreePathFor,
} from '../src/worktree.js';

// ---- 材料 ----
//
// この層のテストは**実リポジトリ**で走らせる。判断 (src/apply.js) と実行
// (src/orgapply.js) は偽 git で呼び順まで固定済みなので、ここで確かめたいのは
// 「本物の git を通したときに、当たっていない適用が本当にコミットされないか」
// 「当たったとき board と ProposalStore がどの順で動くか」の 2 つ。
//
// verify だけは注入した偽物にする — 中身は空のリポジトリなので、走らせるものが無い。

const CHANNEL = 'yobidashi-dev';
const T0 = Date.parse('2026-08-29T00:00:00.000Z');
const OWNER = { kind: 'owner', userId: 'so-user-id' };
const AUTHORITY = { ownerUserId: 'so-user-id', execBotKeys: ['fable'] };

const BASE_TEXT = 'sol の憲章\n';
const AFTER_TEXT = 'sol の憲章 (改)\n';

const POLICY = {
  claudeBin: 'claude',
  bots: { fable: { model: 'fable' }, opus: { model: 'opus' }, opus2: { model: 'opus' }, sol: { model: 'sol' } },
  channels: { [CHANNEL]: { cwd: '.' } },
  processEditAllowlist: ['docs/handbook.md'],
};

const policyText = (policy = POLICY) => `${JSON.stringify(policy, null, 2)}\n`;

/** 全体置換の diff (文法は src/diffs.js が検査する) */
function makeDiff(path, before, after) {
  const lines = (text) => (text === null ? [] : text.replace(/\n$/, '').split('\n'));
  const oldLines = lines(before);
  const newLines = lines(after);
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
    + `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)];
  return `${head}${body.join('\n')}\n`;
}

const roleEditFor = (botKey, before, after) => ({
  kind: 'role-edit',
  targets: [{ botKey }],
  duty: 'org-audit',
  summary: `${botKey} の憲章に検収の観点を足す`,
  evidence: ['直近 5 件の差し戻しが同じ観点で起きている'],
  remedy: 'role',
  change: { touch: [`roles/${botKey}.md`], diff: makeDiff(`roles/${botKey}.md`, before, after) },
  benefits: ['観点が揃う'],
  risks: ['文面が長くなる'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '差し戻し率が下がる', rollback: '前の文面へ戻す' },
});

const roleEdit = (before, after) => roleEditFor('sol', before, after);

const governanceEdit = (before, after) => ({
  kind: 'governance-edit',
  targets: [{ doc: 'docs/design.md' }],
  duty: 'org-audit',
  summary: '設計文書に適用回路の節を足す',
  evidence: ['配線の根拠が散らばっている'],
  remedy: 'policy',
  change: { touch: ['docs/design.md'], diff: makeDiff('docs/design.md', before, after) },
  benefits: ['正本が 1 つになる'],
  risks: ['文書が伸びる'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '参照先が揃う', rollback: '前の文面へ戻す' },
});

/** policy そのものを書き換える提案 (pointer は実在していないと raise で落ちる) */
const policyEdit = (before, after, { pointer = '/bots/fable/model', op = 'edit' } = {}) => ({
  kind: 'policy-edit',
  targets: [{ pointer, op }],
  duty: 'org-audit',
  summary: 'fable のモデル指定を変える',
  evidence: ['起動のたびに同じ指定を手で直している'],
  remedy: 'policy',
  change: { touch: [POLICY_FILE], diff: makeDiff(POLICY_FILE, before, after) },
  benefits: ['指定が 1 か所になる'],
  risks: ['書き損じると起動しない'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '起動が通る', rollback: '前の値へ戻す' },
});

/** 実リポジトリ + ボード + 提案台帳。**git は実物・verify だけ偽物** */
function newWorld({ policy = POLICY } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'communitd-orgapply-')).replaceAll('\\', '/');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'master');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'roles'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, POLICY_FILE), policyText(policy));
  writeFileSync(join(repo, 'roles/sol.md'), BASE_TEXT);
  writeFileSync(join(repo, 'roles/opus.md'), BASE_TEXT);
  writeFileSync(join(repo, 'docs/design.md'), '設計\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  const dir = mkdtempSync(join(tmpdir(), 'communitd-orgapply-store-'));
  const board = new TaskBoardStore(join(dir, 'tasks.json'));
  const store = new ProposalStore(join(dir, 'proposals.json'));
  const ctxOf = (p = policy) => createRepoContext({ cwd: repo, policy: p, board });
  // 作業ツリーは repo の中 (`.worktrees/`) に生えるので、この 2 つを消せば全部消える。
  // 消し損ねると 1 回の verify で %TEMP% に git リポジトリが 26 個積まれる
  const cleanup = () => {
    for (const path of [repo, dir]) {
      rmSync(path, { recursive: true, force: true, maxRetries: 5 });
    }
  };
  return { repo, git, base, board, store, ctxOf, cleanup };
}

/**
 * `newWorld` の後始末を必ず走らせる包み。**test 本体は world を引数で受ける** —
 * 落ちても finally で消えるので、失敗したテストが %TEMP% を残さない。
 */
function withWorld(fn, options) {
  return async () => {
    const world = newWorld(options);
    try {
      await fn(world);
    } finally {
      world.cleanup();
    }
  };
}

/** 保存 → 審議 → 採択まで一気に進める */
function accepted(world, input, { ctx = world.ctxOf(), baseCommit = world.base } = {}) {
  const p = world.store.raise(input, { raisedBy: 'opus', ctx, now: T0 });
  world.store.deliberate(p.id, { now: T0 });
  return world.store.adjudicate(p.id, {
    decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '妥当', baseCommit, ...AUTHORITY,
  });
}

/** 実物の git / fs を使う依存。verify と「書く前の検証」だけ差し替えられる */
function realDeps(world, {
  verify = async () => ({ ok: true }),
  validateApplied = async () => ({ ok: true }),
  calls = [],
} = {}) {
  return {
    git: (cwd, args) => runGit(cwd, args),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    deleteFile: (path) => rm(path, { force: true }),
    ensureDir: async (path) => { await mkdir(path, { recursive: true }); },
    validateApplied: async (input) => { calls.push('validate'); return validateApplied(input); },
    verify: async (cwd) => { calls.push('verify'); return verify(cwd); },
    listWorktrees: async () => parseWorktreeList(await runGit(world.repo, ['worktree', 'list', '--porcelain'])),
    listBranches: async () => parseBranchList(
      await runGit(world.repo, ['branch', '--list', '--format=%(refname:short)']),
    ),
  };
}

/**
 * board / ProposalStore の呼び順を記録する薄いラッパ。
 * **実物へそのまま委譲する** — 記録したいのは順番だけで、挙動は本物で見る。
 */
function recording(world, calls) {
  const { board, store } = world;
  const wrap = (target, names) => {
    const out = {};
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
      if (typeof target[name] !== 'function' || name === 'constructor') continue;
      out[name] = names.includes(name)
        ? (...args) => { calls.push(`${target === board ? 'board' : 'store'}.${name}`); return target[name](...args); }
        : (...args) => target[name](...args);
    }
    return out;
  };
  return {
    board: wrap(board, ['propose', 'approve', 'start', 'submitForReview', 'complete', 'drop']),
    store: wrap(store, ['linkTask', 'recordReceipt', 'failApply', 'startTrial']),
  };
}

/**
 * `startOrgApply` / `sweepApplyCandidates` へ渡す共通の材料。
 * 記録用の配列 (`calls` / `submitted` / `released`) は呼び出し側と共有する。
 */
function applyOptions(world, {
  ctx = world.ctxOf(), verify = async () => ({ ok: true }),
  validateApplied = async () => ({ ok: true }),
  calls = [], submitted = [], released = [], board = world.board,
} = {}) {
  return {
    board,
    ctx,
    channelName: CHANNEL,
    repoRoot: world.repo,
    by: 'bridge',
    now: T0,
    deps: realDeps(world, { verify, validateApplied, calls }),
    createThread: async ({ task }) => { calls.push('createThread'); return `thread-${task.id}`; },
    submitReview: async (arg) => {
      calls.push('submitReview');
      submitted.push(arg);
      return { ok: true, note: '→ Opus2 にレビューをお願いしました' };
    },
    release: async ({ task, stage }) => {
      calls.push('release');
      // 解放の前に枝の先端を控える (何がコミットされたかを後から確かめるため)
      let head = null;
      try {
        head = String(await runGit(world.repo, ['rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`])).trim();
      } catch { /* 枝がまだ無い = null のまま (当たっていないことの印) */ }
      released.push({ taskId: task.id, stage, head });
      await releaseWorktree({ repoRoot: world.repo, taskId: task.id, branch: task.branch, force: true });
      try {
        await runGit(world.repo, ['branch', '-d', task.branch]);
      } catch { /* 未マージの枝は git が拒む — 残すのが正 */ }
      return '🧹 作業ツリーを撤去しました';
    },
  };
}

/** 適用を 1 周させる (成功・失敗どちらも返す) */
async function runApply(world, { store = world.store, ...over } = {}) {
  const proposal = pickApplyCandidate(store);
  const submitted = [];
  const released = [];
  const out = await startOrgApply({
    proposalId: proposal.id,
    store,
    ...applyOptions(world, { submitted, released, ...over }),
  });
  return { out, submitted, released, proposalId: proposal.id };
}

// ---- (v) 当てる前に落ちるなら task を作らない ----

test('再検証で drift が見つかったら deliberating へ戻し、適用タスクは作らない', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));

  // 裁定の後で対象ファイルが動いた = 当てる根拠が消えている
  writeFileSync(join(world.repo, 'roles/sol.md'), '誰かが手で直した\n');

  const out = await startOrgApply({
    proposalId: '1',
    store: world.store,
    board: world.board,
    ctx: world.ctxOf(),
    channelName: CHANNEL,
    repoRoot: world.repo,
    now: T0,
    deps: realDeps(world),
    createThread: async () => { throw new Error('スレッドを作ってはいけない'); },
    submitReview: async () => { throw new Error('検収を頼んではいけない'); },
    release: async () => '',
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'prepare');
  assert.equal(out.action, 'deliberating');
  assert.equal(world.board.list().length, 0, '当てられない提案で task を起こしている');
  assert.equal(world.store.require('1').state, 'deliberating');
  assert.equal(world.store.require('1').decision, null, '差し戻したのに採択が残っている');
}));

test('allowlist に載って class が変わった提案は withdrawn へ倒す (task は作らない)', withWorld(async (world) => {
  accepted(world, governanceEdit('設計\n', '設計 (改)\n'));

  // 対象が processEditAllowlist へ移った = governance-edit のままでは続けられない
  const moved = { ...POLICY, processEditAllowlist: ['docs/design.md'] };
  const out = await startOrgApply({
    proposalId: '1',
    store: world.store,
    board: world.board,
    ctx: world.ctxOf(moved),
    channelName: CHANNEL,
    repoRoot: world.repo,
    now: T0,
    deps: realDeps(world),
    createThread: async () => { throw new Error('スレッドを作ってはいけない'); },
    submitReview: async () => { throw new Error('検収を頼んではいけない'); },
    release: async () => '',
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'prepare');
  assert.equal(out.action, 'withdrawn');
  assert.equal(world.board.list().length, 0);
  assert.equal(world.store.require('1').state, 'withdrawn');
}));

// ---- (i) index と作業ツリーが食い違う実リポジトリ ----

test('当てる元は基点の blob — index と作業ツリーが食い違っていればコミットせずに落ちる', withWorld(async (world) => {
  // **index も作業ツリーも基点から動かす。** 提案は作業ツリーの内容 (= ctx が読む値) を
  // 前提に裁定されるので、当てる先の基点とは食い違ったままになる
  writeFileSync(join(world.repo, 'roles/sol.md'), 'sol の憲章 (index)\n');
  world.git('add', 'roles/sol.md');
  const dirty = 'sol の憲章 (作業中)\n';
  writeFileSync(join(world.repo, 'roles/sol.md'), dirty);
  assert.notEqual(world.git('status', '--porcelain'), '', 'index と作業ツリーが食い違っていない');

  accepted(world, roleEdit(dirty, AFTER_TEXT));
  const calls = [];
  const { out, released } = await runApply(world, { calls });

  // 基点の内容へ当たらないので、書く前 (= コミットの前) に落ちる
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'base', out.reason);
  assert.match(out.reason, /基点/);
  assert.equal(calls.includes('verify'), false, '当たっていないのに verify を回している');
  assert.equal(released[0]?.head, world.base, '当たっていないのにコミットされている');

  // 提案は差し戻され、試行が 1 回記録される (錠も外れている)
  const proposal = world.store.require('1');
  assert.equal(proposal.state, 'deliberating');
  assert.equal(proposal.applyTaskId, null);
  assert.equal(proposal.receipt, null);
  assert.equal(proposal.applyAttempts.length, 1);
  assert.equal(proposal.applyAttempts[0].appliedCommit, null);
  assert.equal(world.board.get(out.taskId).state, 'dropped');

  // 枝も作業ツリーも残さない (当たっていない枝は捨てる)
  assert.deepEqual(parseBranchList(world.git('branch', '--list', '--format=%(refname:short)')), ['master']);
  assert.equal(
    parseWorktreeList(world.git('worktree', 'list', '--porcelain'))
      .some((w) => w.path?.includes('task-')),
    false,
  );
}));

test('書く前の検証で落ちた適用は、枝を基点のままにして commit を残さない', withWorld(async (world) => {
  // 壊れた `config.policy.json` を当てる提案。**diff としては当たる**ので、
  // 止められるのは「書く前に内容そのものを見る」段だけ (実物の判定は src/bridge/orgapply.js)
  const broken = { ...POLICY, bots: { ...POLICY.bots, fable: { model: '' } } };
  accepted(world, policyEdit(policyText(), policyText(broken)));
  const calls = [];
  const { out, released } = await runApply(world, {
    calls,
    validateApplied: async () => ({
      ok: false,
      reason: `適用後の ${POLICY_FILE} は起動時検証を通りません:\n- bots.fable.model が要る`,
    }),
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'validate', out.reason);
  assert.match(out.reason, /bots\.fable\.model が要る/);
  assert.equal(calls.includes('verify'), false, '書く前に落ちたのに verify まで進んでいる');
  assert.equal(released[0]?.head, world.base, '通らない policy がコミットされている');

  // 当たっていない扱い: 錠は外れ、receipt は無く、verify まで届いていない
  const proposal = world.store.require('1');
  assert.equal(proposal.state, 'deliberating');
  assert.equal(proposal.applyTaskId, null);
  assert.equal(proposal.receipt, null);
  assert.equal(proposal.applyAttempts[0].appliedCommit, null);
  assert.equal(proposal.applyAttempts[0].verify, null);
  assert.equal(world.board.get(out.taskId).state, 'dropped');

  // 枝も作業ツリーも残さない。**本体の policy も動いていない**
  assert.deepEqual(parseBranchList(world.git('branch', '--list', '--format=%(refname:short)')), ['master']);
  assert.equal(readFileSync(join(world.repo, POLICY_FILE), 'utf8'), policyText());
}));

// ---- (ii) 成功経路 ----

test('当たったら receipt → in-progress→review → 検収の依頼、の順で進む', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const calls = [];
  const spies = recording(world, calls);
  const { out, submitted } = await runApply(world, { calls, ...spies });

  assert.equal(out.ok, true, out.reason);
  assert.equal(out.receipt.baseCommit, world.base);
  assert.equal(out.receipt.verify.ok, true);

  // **順序がこの層の中身。** 起票 → スレッド → 承認 → 着手 → 錠 → 当てる
  // (書く前の検証 → verify) → receipt → review → 検収の依頼。
  // **承認と着手の間に await は挟まない**
  // (挟むと Discord 待ちの窓で approved が残り、planTick が worker で起こす)
  assert.deepEqual(calls, [
    'board.propose',
    'createThread',
    'board.approve',
    'board.start',
    'store.linkTask',
    'validate',
    'verify',
    'store.recordReceipt',
    'board.submitForReview',
    'submitReview',
  ]);

  const task = world.board.get(out.taskId);
  assert.equal(task.state, 'review');
  assert.equal(task.branch, `task/${task.id}`);
  assert.deepEqual(task.touch, ['roles/sol.md']);
  // 検収を頼む相手へ渡すのは review へ進んだ後の task (契約の提示欄がここから作られる)
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].task.state, 'review');
  assert.equal(submitted[0].threadId, `thread-${task.id}`);
  assert.equal(submitted[0].receipt.appliedCommit, out.receipt.appliedCommit);

  // 錠は receipt ごと残る (merge まで済んでも消さない = 二重適用の防止)
  const proposal = world.store.require('1');
  assert.equal(proposal.applyTaskId, task.id);
  assert.equal(proposal.receipt.appliedCommit, out.receipt.appliedCommit);
  // 当たったのは基点から生やした枝の上だけ。master は動いていない
  assert.equal(world.git('rev-parse', 'master'), world.base);
  assert.equal(world.git('rev-parse', `refs/heads/task/${task.id}^{commit}`), out.receipt.appliedCommit);
  assert.equal(
    world.git('show', `${out.receipt.appliedCommit}:roles/sol.md`),
    AFTER_TEXT.trimEnd(),
  );
  // 親は基点 1 つだけ (承認していない履歴の上に乗っていない)
  assert.deepEqual(
    world.git('rev-list', '--parents', '-n', '1', out.receipt.appliedCommit).split(/\s+/).slice(1),
    [world.base],
  );

  // 適用タスクは提案から引ける (通常のタスクとは検収の経路を分けるため)
  assert.equal(findApplyProposal(world.store, task.id)?.id, '1');
  assert.equal(findApplyProposal(world.store, '999'), null);
  // 錠が下りている提案は次の候補に上がらない (二重適用の防止は候補の側でも閉じる)
  assert.deepEqual(applyCandidates(world.store), []);
}));

// ---- Discord 待ちの窓で approved を残さない ----

test('スレッドを作っている間、適用タスクは proposed のまま (承認は着手の直前)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));

  // **ここが不変条件** (Fable 検収 2026-09-03)。`createThread` は Discord を待つので、
  // その間に task が `approved` だと、同じ tick で並走する planTick が
  // `approved` を全部 `start-task` にする — 適用 task が**書込み権限つきの worker**で
  // 起きてしまい、「適用 task に修正担当も書込み権限も無い」が破れる
  const calls = [];
  const seen = [];
  const out = await startOrgApply({
    proposalId: '1',
    store: world.store,
    ...applyOptions(world, { calls }),
    createThread: async ({ task }) => {
      calls.push('createThread');
      seen.push(world.board.get(task.id).state);
      return `thread-${task.id}`;
    },
  });

  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(seen, ['proposed'], 'Discord を待っている間に task が approved になっている');
  // 承認そのものは打たれている (着手の直前) — 板の履歴で確かめる
  const states = world.board.get(out.taskId).history.map((h) => h.to);
  assert.deepEqual(states, ['proposed', 'approved', 'in-progress', 'review']);
}));

// ---- (iii) 失敗経路の順序 ----

test('verify に落ちたら settle の中で dropped → 解放 → failApply の順に片付ける', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const calls = [];
  const spies = recording(world, calls);
  const { out, released } = await runApply(world, {
    calls,
    ...spies,
    verify: async () => ({ ok: false, detail: 'test が 1 件落ちました' }),
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'verify', out.reason);

  // **順序が不変条件** — 検収の宛先を閉じてから枝を解放し、最後に錠を外す。
  // 逆にすると、錠の外れた提案を次の tick が拾い、古い後始末が新しい枝を撤去する
  assert.deepEqual(calls.slice(calls.indexOf('verify')), [
    'verify',
    'board.drop',
    'release',
    'store.failApply',
  ]);

  // verify で落ちた = コミットは残るが receipt は作らない
  assert.notEqual(released[0].head, null);
  assert.notEqual(released[0].head, world.base, 'verify 段なのにコミットされていない');
  assert.equal(released[0].stage, 'verify');

  const proposal = world.store.require('1');
  assert.equal(proposal.state, 'deliberating');
  assert.equal(proposal.applyTaskId, null);
  assert.equal(proposal.receipt, null);
  assert.equal(proposal.applyAttempts[0].verify.ok, false);
  assert.match(proposal.applyAttempts[0].reason, /verify/);
  assert.equal(world.board.get(out.taskId).state, 'dropped');
  // 当てたコミットが載った枝は `-d` が拒む (押し切らない)。master は動いていない
  assert.equal(world.git('rev-parse', 'master'), world.base);
}));

test('錠を外せないまま終わった適用は、枝を解放してから錠を外し直す', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);

  // 検収待ち (review) は正常な状態なので拾わない
  assert.deepEqual(await reclaimStaleApplies(world.store, world.board, { now: T0 }), []);

  // 「task を捨てたのに failApply が走らなかった」= 後始末が途中で落ちた状態を作る。
  // **この形では作業ツリーも枝も残っている** — drop の後で落ちたので解放まで進んでいない
  world.board.drop(out.taskId, { by: 'test', reason: 'superseded: 途中で落ちた' });
  assert.equal(
    parseWorktreeList(world.git('worktree', 'list', '--porcelain'))
      .some((w) => w.path?.includes(`task-${out.taskId}`)),
    true,
    '作業ツリーが残っていない (前提)',
  );

  const released = [];
  const reclaimed = await reclaimStaleApplies(world.store, world.board, {
    release: async ({ task }) => {
      released.push(task.id);
      await releaseWorktree({ repoRoot: world.repo, taskId: task.id, branch: task.branch, force: true });
      return '🧹 作業ツリーを撤去しました';
    },
    now: T0,
    by: 'bridge',
  });
  assert.deepEqual(reclaimed, ['1']);
  // **錠を外す前に枝を解放する** — 外してしまうと次の tick が拾い、古い残骸だけが残る
  assert.deepEqual(released, [out.taskId], 'dropped の分岐で枝を解放していない');
  assert.equal(
    parseWorktreeList(world.git('worktree', 'list', '--porcelain'))
      .some((w) => w.path?.includes(`task-${out.taskId}`)),
    false,
  );
  const proposal = world.store.require('1');
  assert.equal(proposal.applyTaskId, null);
  assert.equal(proposal.state, 'deliberating');
  // 片付いたものは二度と拾わない
  assert.deepEqual(await reclaimStaleApplies(world.store, world.board, { now: T0 }), []);
}));

test('適用タスクがボードから消えていても、枝を解放してから錠を外す', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  const branch = applyBranchFor(out.taskId);

  // 台帳から task ごと消えた形 (板を作り直した・書き込みが落ちた)。
  // task が引けないので、解放には**タスク ID から組み立てた枝**を渡すしかない
  const board = {
    ...recording(world, []).board,
    get: (id) => (String(id) === String(out.taskId) ? null : world.board.get(id)),
  };
  const released = [];
  const reclaimed = await reclaimStaleApplies(world.store, board, {
    release: async ({ task }) => { released.push({ id: task.id, branch: task.branch }); return ''; },
    now: T0,
    by: 'bridge',
  });

  assert.deepEqual(reclaimed, ['1']);
  assert.deepEqual(released, [{ id: out.taskId, branch }], '不在の分岐で枝を解放していない');
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(world.store.require('1').state, 'deliberating');
}));

test('解放に失敗しても錠は外す (残骸は次の適用が作り直すが、錠は誰も外さない)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  world.board.drop(out.taskId, { by: 'test', reason: 'superseded: 途中で落ちた' });

  const logged = [];
  const reclaimed = await reclaimStaleApplies(world.store, world.board, {
    release: async () => { throw new Error('作業ツリーを掴めません'); },
    log: (m) => logged.push(m),
    now: T0,
    by: 'bridge',
  });
  assert.deepEqual(reclaimed, ['1']);
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /解放できませんでした/);
}));

test('settle の途中で task を閉じられなかった適用は、次の tick が丸ごと片付け直す', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));

  // 後始末の 1 歩目 (board.drop) だけが落ちる。**この形は自動では拾えない**と
  // 誤って結論していた: task は in-progress・提案は錠付きで、候補走査も
  // `/review` も届かない (Sol 指摘 2026-09-03)
  let dropWorks = false;
  const board = {
    ...recording(world, []).board,
    drop: (...args) => {
      if (!dropWorks) throw new Error('台帳を書けません');
      return world.board.drop(...args);
    },
  };
  const { out } = await runApply(world, { board, verify: async () => ({ ok: false, detail: 'NG' }) });

  // settle が落ちたので、task も錠も残っている
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'settle', out.reason);
  assert.match(out.reason, /後始末/);
  assert.equal(world.board.get(out.taskId).state, 'in-progress');
  // 残った形を戻り値に載せる (案内を「次の tick で片付け直します」に振るのはこの値)
  assert.equal(out.taskState, 'in-progress');
  assert.equal(world.store.require('1').applyTaskId, out.taskId);
  const branch = `task/${out.taskId}`;
  assert.equal(
    parseBranchList(world.git('branch', '--list', '--format=%(refname:short)')).includes(branch),
    true,
    '当てた枝が残っていない (前提)',
  );

  // 次の tick — board が書けるようになれば、後始末を頭から打ち直す
  dropWorks = true;
  const released = [];
  const reclaimed = await reclaimStaleApplies(world.store, world.board, {
    release: async ({ task }) => {
      released.push(task.id);
      await releaseWorktree({ repoRoot: world.repo, taskId: task.id, branch: task.branch, force: true });
      try {
        // **実物 (releaseApplyWorktree) と同じ `-d`。** 当てたコミットが載った枝は
        // git が拒むのが正しく、押し切る判断はこの層に無い (src/index.js の注記)
        await runGit(world.repo, ['branch', '-d', task.branch]);
      } catch { /* 未マージの枝は git が拒む — 残すのが正 */ }
      return '🧹 作業ツリーを撤去しました';
    },
    now: T0,
    by: 'bridge',
  });

  assert.deepEqual(reclaimed, ['1']);
  assert.deepEqual(released, [out.taskId], '枝の解放まで進んでいない');
  assert.equal(world.board.get(out.taskId).state, 'dropped');
  const proposal = world.store.require('1');
  assert.equal(proposal.applyTaskId, null);
  assert.equal(proposal.state, 'deliberating');
  assert.equal(proposal.applyAttempts.length, 1);
  // 作業ツリーは撤去する。**枝は残る** — verify 段で落ちたので当てたコミットが載っており、
  // `-d` が拒む。次の適用は別のタスク ID で生えるので、この枝が邪魔をすることは無い
  assert.equal(
    parseWorktreeList(world.git('worktree', 'list', '--porcelain'))
      .some((w) => w.path?.includes(`task-${out.taskId}`)),
    false,
    '作業ツリーが残っている',
  );
  assert.equal(
    parseBranchList(world.git('branch', '--list', '--format=%(refname:short)')).includes(branch),
    true,
    '当てたコミットが載った枝を押し切って消している',
  );
  assert.deepEqual(await reclaimStaleApplies(world.store, world.board, { now: T0 }), []);
  // 戻し先は「当て直しの列」ではなく再裁定 — 直す対象は diff なので
  assert.deepEqual(applyCandidates(world.store).map((p) => p.id), []);
}));

test('検収を頼めずに落ちた適用は review のまま残り、その状態を戻り値に載せる', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));

  // 当たって review まで進んだ後で検収の依頼だけが落ちる形。**task は review のまま** —
  // reclaimStaleApplies は in-progress / dropped しか拾わないので、次の tick では
  // 片付かない。案内を分けられるように、残った状態を返り値へ載せる
  const out = await startOrgApply({
    proposalId: '1',
    store: world.store,
    ...applyOptions(world),
    submitReview: async () => { throw new Error('スレッドへ投稿できません'); },
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'settle', out.reason);
  assert.equal(out.taskState, 'review');
  assert.equal(world.board.get(out.taskId).state, 'review');
  assert.deepEqual(await reclaimStaleApplies(world.store, world.board, { now: T0 }), []);
}));

// ---- (iv) 検収 verdict の merge ----

test('merge するのは receipt の commit OID だけで、その後 startTrial まで進む', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const calls = [];
  const spies = recording(world, calls);
  const { out } = await runApply(world, { calls, ...spies });
  assert.equal(out.ok, true, out.reason);

  const merged = await mergeApplyTask({
    store: spies.store,
    board: spies.board,
    ctx: world.ctxOf(),
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    into: 'master',
    git: (args) => runGit(world.repo, args),
    by: 'opus2',
    now: T0,
  });

  assert.equal(merged.ok, true, merged.reason);
  assert.equal(merged.commit, out.receipt.appliedCommit);
  assert.equal(merged.trial, true);
  // **遷移が先・試用は後** (startTrial は適用タスクが merged であることを見る)
  assert.deepEqual(calls.slice(-2), ['board.complete', 'store.startTrial']);
  assert.equal(world.board.get(out.taskId).state, 'merged');
  assert.equal(world.store.require('1').state, 'trial');
  assert.equal(world.store.require('1').trial.deadline, '2026-09-30T00:00:00.000Z');

  // master に入ったのは承認済みの commit OID だけ (親は旧 master と適用コミット)
  const parents = world.git('rev-list', '--parents', '-n', '1', 'master').split(/\s+/).slice(1);
  assert.deepEqual(parents, [world.base, out.receipt.appliedCommit]);
  assert.equal(world.git('show', 'master:roles/sol.md'), AFTER_TEXT.trimEnd());
}));

test('枝に未承認のコミットが足されていたら merge しない (board も提案も動かさない)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  assert.equal(out.ok, true, out.reason);

  // 当てた後にその枝へ足されたコミット。ブランチ名で merge すると一緒に入る
  const wt = worktreePathFor(world.repo, out.taskId);
  writeFileSync(join(wt, 'roles/sol.md'), '承認されていない追記\n');
  execFileSync('git', ['-C', wt, 'commit', '-aqm', 'unapproved'], { encoding: 'utf8' });

  const merged = await mergeApplyTask({
    store: world.store,
    board: world.board,
    ctx: world.ctxOf(),
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    into: 'master',
    git: (args) => runGit(world.repo, args),
    by: 'opus2',
    now: T0,
  });

  assert.equal(merged.ok, false);
  assert.match(merged.reason, /承認外のコミット/);
  assert.equal(world.git('rev-parse', 'master'), world.base, '未承認のコミットが master へ入った');
  assert.equal(world.board.get(out.taskId).state, 'review');
  assert.equal(world.store.require('1').state, 'adjudicated');

  // merge 先 (autonomy.baseBranch) を渡し忘れたら、どこへも入れずに断る
  const nowhere = await mergeApplyTask({
    store: world.store,
    board: world.board,
    ctx: world.ctxOf(),
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    into: '',
    git: (args) => runGit(world.repo, args),
  });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.reason, /merge 先/);
  assert.equal(world.board.get(out.taskId).state, 'review');
}));

// ---- 走査 (当てるのは 1 件・止まる候補で列を塞がない) ----

test('prepare で止まる候補は列を塞がない — 後続を当てて、そこで 1 tick 分を打ち切る', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT)); // #1: 試行上限で止まる
  accepted(world, governanceEdit('設計\n', '設計 (改)\n')); // #2: 当たる
  accepted(world, roleEditFor('opus', BASE_TEXT, AFTER_TEXT)); // #3: 当たるが今回は順番待ち

  // **状態が動かない候補**を作る。試行上限に達した提案は adjudicated:accepted の
  // ままなので、先頭 1 件しか見ないと毎 tick ここで止まる (Sol 指摘 2026-09-03)
  const stuck = world.store.require('1');
  world.store.write('1', {
    ...stuck,
    applyAttempts: [1, 2, 3].map((n) => ({
      at: '2026-09-02T00:00:00.000Z',
      revision: 1,
      taskId: `x${n}`,
      appliedCommit: null,
      verify: null,
      verdict: 'send-back',
      reason: `${n} 回目`,
    })),
  });

  const reported = [];
  const results = await sweepApplyCandidates(world.store, {
    ...applyOptions(world),
    report: async (proposal, out) => { reported.push([proposal.id, out.ok]); },
  });

  assert.deepEqual(reported, [['1', false], ['2', true]]);
  assert.deepEqual(results.map((r) => r.proposal.id), ['1', '2'], '#1 で止まったか #3 まで走った');
  assert.equal(results[0].out.stage, 'prepare');
  assert.equal(results[0].out.escalate, true, '試行上限が「要人間」として返っていない');
  assert.equal(results[1].out.ok, true, results[1].out.reason);

  // 当てたのは #2 だけ。#1 は据え置き (状態を動かさない)、#3 は次の tick へ
  assert.equal(world.board.list().length, 1);
  assert.equal(world.store.require('1').state, 'adjudicated');
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(world.store.require('2').applyTaskId, results[1].out.taskId);
  assert.equal(world.store.require('3').applyTaskId, null);
  // 次の tick では #1 を飛ばして #3 が当たる (列が進む)
  assert.deepEqual(applyCandidates(world.store).map((p) => p.id), ['1', '3']);
}));

// ---- merge は本体の作業ツリーを動かす (始める前と落ちた後の約束) ----

test('本体が汚れていたら merge を始めず、競合したら元へ戻す (MERGE_HEAD を残さない)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  assert.equal(out.ok, true, out.reason);
  const merge = (over = {}) => mergeApplyTask({
    store: world.store,
    board: world.board,
    ctx: world.ctxOf(),
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    into: 'master',
    git: (args) => runGit(world.repo, args),
    by: 'opus2',
    now: T0,
    ...over,
  });

  // (1) 未コミットの変更がある本体では始めない (checkout も merge もその上に乗る)
  writeFileSync(join(world.repo, 'roles/sol.md'), '書きかけ\n');
  const dirty = await merge();
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /未コミットの変更/);
  assert.equal(world.git('rev-parse', 'master'), world.base, '汚れているのに master を動かした');
  assert.equal(world.board.get(out.taskId).state, 'review');

  // (2) 競合したら本体を元の状態へ戻す
  world.git('commit', '-aqm', 'master 側で同じ行を直した');
  const masterBefore = world.git('rev-parse', 'master');
  const conflicted = await merge();
  assert.equal(conflicted.ok, false);
  assert.match(conflicted.reason, /merge できませんでした/);
  assert.match(conflicted.reason, /元の状態へ戻しました/);
  // **競合を残さない** — 残すと以後のブリッジの git 操作がすべてその上で走る
  assert.equal(world.git('status', '--porcelain'), '', '本体に競合 index が残っている');
  assert.equal(existsSync(join(world.repo, '.git', 'MERGE_HEAD')), false, 'MERGE_HEAD が残っている');
  assert.equal(world.git('rev-parse', 'master'), masterBefore);
  assert.equal(world.board.get(out.taskId).state, 'review');
  assert.equal(world.store.require('1').state, 'adjudicated');
}));

// ---- merge の後に止まった提案の回復 ----

test('merge は済んだのに試用が始まらなかったら、次の tick で始め直す', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  assert.equal(out.ok, true, out.reason);

  // 台帳が一時的に書けず startTrial だけ落ちた状態を作る
  const spies = recording(world, []);
  const merged = await mergeApplyTask({
    store: { ...spies.store, startTrial: () => { throw new Error('書けませんでした'); } },
    board: world.board,
    ctx: world.ctxOf(),
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    into: 'master',
    git: (args) => runGit(world.repo, args),
    by: 'opus2',
    now: T0,
  });
  assert.equal(merged.ok, true, 'merge は済んでいるので取り消さない');
  assert.equal(merged.trial, false);
  assert.match(merged.reason, /試用を開始できません/);
  assert.equal(world.board.get(out.taskId).state, 'merged');
  assert.equal(world.store.require('1').state, 'adjudicated');

  // **この形はどの回復経路にも引っかからない** — /review は merged を受け付けず、
  // reclaimStaleApplies は in-progress / dropped しか拾わない。だから専用の回復点が要る
  assert.deepEqual(await reclaimStaleApplies(world.store, world.board, { now: T0 }), []);
  const ctx = world.ctxOf();
  assert.deepEqual(resumeApplyTrials(world.store, world.board, { ctxOf: () => ctx, now: T0 }), ['1']);
  assert.equal(world.store.require('1').state, 'trial');

  // 片付いたら二度と走らない。**該当が無ければ前提も読まない** (毎 tick 走るので)
  let read = 0;
  assert.deepEqual(
    resumeApplyTrials(world.store, world.board, { ctxOf: () => { read += 1; return ctx; }, now: T0 }),
    [],
  );
  assert.equal(read, 0, '該当が無いのに policy を読み直している');
}));

// ---- 後始末は task を閉じられたときだけ錠を外す ----

test('適用タスクを閉じられなければ錠も外さない (生きた task と再裁定待ちを並べない)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  assert.equal(out.ok, true, out.reason);

  const calls = [];
  const abandon = (board) => abandonApplyTask({
    store: world.store,
    board,
    proposal: world.store.require('1'),
    task: world.board.get(out.taskId),
    reason: '検収 (drop): #45 の重複',
    verdict: 'drop',
    release: async () => { calls.push('release'); return '🧹 作業ツリーを撤去しました'; },
    by: 'opus2',
    now: T0,
  });

  // board が書けない = 検収の宛先を閉じられない
  const broken = { ...recording(world, []).board, drop: () => { throw new Error('台帳を書けません'); } };
  const first = await abandon(broken);
  assert.equal(first.ok, false);
  assert.match(first.reason, /適用タスクを閉じられませんでした/);
  assert.deepEqual(calls, [], 'task を閉じられていないのに枝を解放している');
  assert.equal(world.board.get(out.taskId).state, 'review', 'task が閉じていない (前提)');
  assert.equal(world.store.require('1').applyTaskId, out.taskId, '閉じられていないのに錠が外れている');
  assert.equal(world.store.require('1').state, 'adjudicated');
  assert.equal(world.store.require('1').receipt.appliedCommit, out.receipt.appliedCommit);

  // 次に drop が通れば同じ道でやり直せる (回復は「もう一度同じ手を打つ」だけ)
  const second = await abandon(world.board);
  assert.equal(second.ok, true, second.reason);
  assert.deepEqual(calls, ['release']);
  assert.equal(world.board.get(out.taskId).state, 'dropped');
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(world.store.require('1').state, 'deliberating');
  assert.equal(world.store.require('1').applyAttempts[0].verdict, 'drop');
}));

test('既に終端の適用タスクへは drop を打ち直さない (後始末の再実行は冪等)', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));
  const { out } = await runApply(world);
  assert.equal(out.ok, true, out.reason);
  const task = world.board.get(out.taskId);

  // 「task は既に閉じたが failApply の前で落ちた」形。もう一度同じ手を打ち直したとき、
  // **終端へ drop を打つと board の遷移表 (dropped からの辺は無い) が拒む**ので、
  // ガードが無いと後始末が二度と終わらない
  world.board.drop(out.taskId, { by: 'test', reason: 'superseded: 途中で落ちた' });
  const calls = [];
  const board = {
    ...recording(world, []).board,
    drop: () => { calls.push('drop'); throw new Error('dropped からは動かせません'); },
  };

  const again = await abandonApplyTask({
    store: world.store,
    board,
    proposal: world.store.require('1'),
    task,
    reason: '検収 (send-back): 当て直し',
    verdict: 'send-back',
    release: async () => { calls.push('release'); return '🧹 作業ツリーを撤去しました'; },
    by: 'opus2',
    now: T0,
  });

  assert.equal(again.ok, true, again.reason);
  assert.deepEqual(calls, ['release'], '終端の task へ drop を打ち直している');
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(world.store.require('1').state, 'deliberating');
}));

// ---- 錠を取る前に落ちたときの後始末 ----

test('スレッドを作れず drop も通らなかったら、残った task を理由に書いて人へ渡す', withWorld(async (world) => {
  accepted(world, roleEdit(BASE_TEXT, AFTER_TEXT));

  // 起票はできたがスレッドが作れず、後始末の drop も落ちる。**錠はまだ無い**ので
  // reclaimStaleApplies は辿り着けない — 飲むと宛先の無い task が黙って残る
  const logged = [];
  const board = { ...recording(world, []).board, drop: () => { throw new Error('台帳を書けません'); } };
  const out = await startOrgApply({
    proposalId: '1',
    store: world.store,
    ...applyOptions(world, { board }),
    createThread: async () => { throw new Error('Discord が応答しません'); },
    log: (m) => logged.push(m),
  });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'thread');
  assert.match(out.reason, /Discord が応答しません/);
  assert.match(out.reason, /要人間/);
  assert.match(out.reason, new RegExp(`タスク #${out.taskId} が proposed のまま残っています`));
  assert.equal(logged.length, 1, 'log にも残していない');
  // 錠は取っていないので提案は候補のまま (次の tick でやり直せる)
  assert.equal(world.store.require('1').applyTaskId, null);
  assert.equal(world.board.get(out.taskId).state, 'proposed');
}));

// ---- 配線そのもの (起動しないと読めない層なので source で固定する) ----
// 関数本体は src/bridge/*.js にある (src/index.js は組み立てだけ)。呼び順の約束はそちらで見る

const readSrc = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const indexSource = () => readSrc('index.js');
const bridgeSource = (name) => readSrc(`bridge/${name}.js`);
/** 起動点と bridge/ の配線をまとめて読む (名前つき) */
const wiringSources = () => [
  ['index.js', indexSource()],
  ...readdirSync(fileURLToPath(new URL('../src/bridge', import.meta.url)))
    .filter((f) => f.endsWith('.js')).sort()
    .map((f) => [`bridge/${f}`, readSrc(`bridge/${f}`)]),
];

test('適用回路の入口は prepareApply だけ (checkApplicable を直に呼ばない)', () => {
  // 直に呼ぶと、allowlist が動いて class が変わった提案を withdrawn へ倒せない
  // (Sol 指摘 2026-08-30)。配線側にも実装側にも直呼びを残さない
  const wiring = readFileSync(fileURLToPath(new URL('../src/orgapply-wiring.js', import.meta.url)), 'utf8');
  for (const [name, source] of [...wiringSources(), ['orgapply-wiring.js', wiring]]) {
    assert.equal(/checkApplicable\s*\(/.test(source), false, `${name} に checkApplicable の直呼びがある`);
  }
  assert.match(wiring, /prepareApply\(store, proposalId, ctx/);
});

test('適用の起動点は sweepProposals の 1 経路だけ (採択ボタン直後のフックは無い)', () => {
  const combined = wiringSources().map(([, s]) => s).join('\n');
  const starts = [...combined.matchAll(/await sweepApplyCandidates\(|sweepOrgApply\(/g)].map((m) => m[0]);
  // 定義 1 (bridge/orgapply.js) + sweepProposals からの呼び出し 1 (bridge/proposals.js)
  // + 候補走査の呼び出し 1 (bridge/orgapply.js) + index.js が proposals の配線へ注入する 1
  assert.deepEqual(
    starts.sort(),
    ['await sweepApplyCandidates(', 'sweepOrgApply(', 'sweepOrgApply(', 'sweepOrgApply('],
  );
  // 打ち切りの条件は配線層に置く (bridge からは startOrgApply を直に呼ばない)
  assert.equal(/startOrgApply\s*\(/.test(combined), false, '配線が候補走査を迂回している');
  const source = bridgeSource('proposals');
  const from = source.indexOf('async function sweepProposals');
  const to = source.indexOf('async function redeliverProposal');
  assert.ok(from > 0 && to > from, 'sweepProposals を切り出せない (関数名が変わった?)');
  assert.match(source.slice(from, to), /await sweepOrgApply\(now\)/);
  // index.js は proposals の配線へ org-apply の sweep を注入するだけで、自分では呼ばない
  assert.match(indexSource(), /sweepOrgApply: \(now\) => orgApply\.sweepOrgApply\(now\)/);
  // 採択の確定 (src/interactions.js の finalizeAdjudication) からは起こさない
  const interactions = readFileSync(fileURLToPath(new URL('../src/interactions.js', import.meta.url)), 'utf8');
  assert.equal(/startOrgApply|sweepOrgApply/.test(interactions), false);
});

test('適用の verify はブリッジの停止で撃つ (/stop の対象ではない)', () => {
  // 適用回路は tick から走るので job キューに居ない。**停止経路は shutdown だけ** —
  // `/stop` はスレッド単位の job 停止なので、そこから適用回路を撃つと
  // 「誰かが自分のスレッドを止めたら、無関係な適用の verify まで死ぬ」になる
  const orgapply = bridgeSource('orgapply');
  assert.match(orgapply, /runVerifyImpl\(\{[^}]*handle,/s, 'runVerify に handle を渡していない');
  assert.match(indexSource(), /abortOrgApply: \(\) => orgApply\.abortVerify\(\)/);
  assert.match(bridgeSource('shutdown'), /\n {6}abortOrgApply,/);

  const interactions = readSrc('interactions.js');
  const from = interactions.indexOf('export function stopJobs');
  const to = interactions.indexOf('function notifyStop');
  assert.ok(from > 0 && to > from, 'stopJobs を切り出せない (関数名が変わった?)');
  assert.equal(
    /abortOrgApply/.test(interactions.slice(from, to)),
    false,
    '/stop (stopJobs) が適用回路まで撃っている',
  );
});

test('片付け直しは in-flight ガードの中・候補走査より前でだけ走る', () => {
  // `reclaimStaleApplies` が in-progress の適用 task を残骸と断じてよいのは、
  // **走っている適用が無い瞬間にしか呼ばれない**から。この前提は呼ぶ場所にしかない
  const source = bridgeSource('orgapply');
  const from = source.indexOf('async function runOrgApplySweep');
  const to = source.indexOf('async function reportOrgApply');
  assert.ok(from > 0 && to > from, 'runOrgApplySweep を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);
  assert.ok(
    body.indexOf('reclaimStaleApplies(') < body.indexOf('sweepApplyCandidates('),
    '片付け直しが候補走査より後にある (走っている適用の枝を撤去しうる)',
  );
  assert.match(
    source,
    /async function sweepOrgApply[\s\S]*?if \(orgApplyRunning\) return;[\s\S]*?await runOrgApplySweep\(now\)/,
  );
  // ガードを迂回した呼び出しを作らない (定義 1 + ガード内の 1 回だけ)
  assert.equal((source.match(/runOrgApplySweep\(/g) ?? []).length, 2);
});

test('settle 失敗の案内は残った task の状態で分かれる (review は /review へ案内する)', () => {
  // review のまま止まったものは自動では拾えない (reclaimStaleApplies は
  // in-progress / dropped しか見ない)。「次の tick で片付け直します」と出すと
  // 待てば直ると読めてしまうので、打ち直せる操作を案内する。
  // 文面は純関数 (src/bridge/orgapply.js の orgApplyLine) なので直接呼んで固定する
  const proposal = { id: 9, class: 'process' };
  const review = orgApplyLine(proposal, {
    ok: false, stage: 'settle', reason: 'drop に失敗', taskId: '12', taskState: 'review',
  });
  assert.match(review, /^🏛 提案 #9 \(process\) の適用に失敗しました \(settle\): drop に失敗/);
  assert.match(review, /タスク #12 は review のまま残ります \(`\/review 12` で判定を出し直してください\)$/);
  assert.equal(review.includes('次の tick で片付け直します'), false);
  const dropped = orgApplyLine(proposal, {
    ok: false, stage: 'settle', reason: '解放に失敗', taskId: '12', taskState: 'dropped', note: '🧹 残しました',
  });
  assert.match(dropped, /解放に失敗\n🧹 残しました\n→ 次の tick で片付け直します$/);
  // settle 以外の失敗 (apply など) には片付けの案内を付けない (次の tick が拾うのは後始末だけ)
  const applied = orgApplyLine(proposal, { ok: false, stage: 'apply', reason: 'verify NG', taskId: '12' });
  assert.equal(/review|次の tick/.test(applied), false, applied);
  // prepare で止まったものは理由と行き先 (取り下げ / 再裁定 / 要人間) を分ける
  assert.match(
    orgApplyLine(proposal, { ok: false, stage: 'prepare', reason: 'lane 不備', action: 'withdrawn' }),
    /は当てられません: lane 不備 — 取り下げました \(出し直してください\)$/,
  );
  assert.match(
    orgApplyLine(proposal, { ok: false, stage: 'prepare', reason: 'drift', action: 'deliberating' }),
    /drift — 再裁定へ戻しました$/,
  );
  assert.match(
    orgApplyLine(proposal, { ok: false, stage: 'prepare', reason: '要判断', escalate: true }),
    /要判断 — \*\*人間の判断が要ります\*\*$/,
  );
  // 成功は receipt の commit (12 桁) と task を 1 行に。note が無ければ検収を頼んだ旨
  assert.equal(
    orgApplyLine(proposal, { ok: true, receipt: { appliedCommit: 'abcdef0123456789abcdef' }, taskId: '12' }),
    '🏛 提案 #9 (process) を当てました (abcdef012345 / タスク #12)\n→ 検収を頼んでいます',
  );
});

test('検収の依頼はブリッジ発なので自己レビュー禁止の判定を通さない (byWorker: false)', () => {
  // #46 は reviewer のフッタ無し報告が worker の完了と数えられ、自己レビュー禁止で
  // 契約が作られないまま review に固着した。適用 task で実装したのはブリッジなので、
  // 「実装した担当 == reviewer」の判定に引っかかってはいけない
  const source = bridgeSource('orgapply');
  const from = source.indexOf('async function requestApplyReview');
  const to = source.indexOf('const applyNotices');
  assert.ok(from > 0 && to > from, 'requestApplyReview を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);
  assert.match(body, /requestReview\(\{[^}]*byWorker: false/s);
  // 投げ手は検収担当以外から選ぶ (宛先自身の client から投げると捨てられる)
  assert.match(source, /function applyAnnouncer[\s\S]*pickAnnouncer\(autonomy\.reviewer/);
});
