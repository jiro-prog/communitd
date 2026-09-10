import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPLY_ATTEMPT_LIMIT,
  applyAttemptCount,
  applyBaseRef,
  baseCommitArgs,
  checkApplicable,
  checkApplyBase,
  checkApplyResult,
  checkLaneScope,
  diffDigestOf,
  objectShowArgs,
  laneForClass,
  makeReceipt,
  parseRawDiff,
  rawDiffArgs,
  planApplyWorktree,
  planMerge,
  prepareApply,
  shouldEscalateApply,
} from '../src/apply.js';
import { ProposalStore } from '../src/proposals.js';
import { POLICY_FILE } from '../src/config.js';
import { isSafeRepoPath } from '../src/repopath.js';
import { worktreePathFor } from '../src/worktree.js';

// ---- 材料 (test/proposals.test.js と同じ形の偽物の文脈) ----

const POLICY = {
  bots: { fable: { model: 'fable' }, opus: { model: 'opus' }, sol: { model: 'sol' } },
  channels: { observatory: { cwd: '.', toolsExtra: ['Write'] } },
  processEditAllowlist: ['docs/handbook.md'],
};

const FILES = {
  [POLICY_FILE]: `${JSON.stringify(POLICY, null, 2)}\n`,
  'roles/sol.md': 'sol の憲章\n',
  'docs/handbook.md': '手順\n',
  'docs/social-engineering.md': '設計\n',
};

function makeDiff(path, before, after) {
  const lines = (text) => (text === null ? [] : text.replace(/\n$/, '').split('\n'));
  const oldLines = lines(before);
  const newLines = lines(after);
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
    + `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)];
  return `${head}${body.join('\n')}\n`;
}

function ctxWith({ files = FILES, allowlist = null, tasks = [] } = {}) {
  return {
    policy: POLICY,
    processEditAllowlist: allowlist ?? POLICY.processEditAllowlist,
    checkPath: (p) => (isSafeRepoPath(p)
      ? { ok: true, kind: Object.hasOwn(files, p) ? 'file' : (['roles', 'docs'].includes(p) ? 'dir' : 'missing') }
      : { ok: false, reason: `パスとして受け付けられません: ${p}` }),
    fileExists: (p) => Object.hasOwn(files, p),
    dirExists: (p) => ['roles', 'docs'].includes(p),
    readFile: (p) => files[p] ?? null,
    taskById: (id) => tasks.find((t) => String(t.id) === String(id)) ?? null,
    openTasks: tasks,
  };
}

const roleEdit = (over = {}) => ({
  kind: 'role-edit',
  targets: [{ botKey: 'sol' }],
  duty: 'org-audit',
  summary: 'sol の憲章に検収の観点を足す',
  evidence: ['直近 5 件の差し戻しが同じ観点で起きている'],
  remedy: 'role',
  change: { touch: ['roles/sol.md'], diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], 'sol の憲章 (改)\n') },
  benefits: ['観点が揃う'],
  risks: ['文面が長くなる'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '差し戻し率が下がる', rollback: '前の文面へ戻す' },
  ...over,
});

const processEdit = () => ({
  kind: 'process-edit',
  targets: [{ doc: 'docs/handbook.md' }],
  duty: 'org-audit',
  summary: '手順を直す',
  evidence: ['手順が古い'],
  remedy: 'check',
  change: { touch: ['docs/handbook.md'], diff: makeDiff('docs/handbook.md', FILES['docs/handbook.md'], '手順 (改)\n') },
  benefits: ['迷わない'],
  risks: ['無い'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '質問が減る', rollback: '戻す' },
});

const T0 = Date.parse('2026-08-29T00:00:00.000Z');
const OWNER = { kind: 'owner', userId: 'so-user-id' };
const AUTHORITY = { ownerUserId: 'so-user-id', execBotKeys: ['fable'] };
const BASE = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

const store = () => new ProposalStore(join(mkdtempSync(join(tmpdir(), 'communitd-apply-')), 'proposals.json'));

/** 保存 → 審議 → 裁定 (基点付き) まで進める */
function accepted(s, input, ctx, { actor = OWNER, baseCommit = BASE } = {}) {
  const p = s.raise(input, { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });
  return s.adjudicate(p.id, {
    decision: 'accepted', actor, ctx, now: T0, rationale: '妥当', baseCommit, ...AUTHORITY,
  });
}

// ---- lane ----

test('lane は class から決まり、work は適用回路を持たない', () => {
  assert.equal(laneForClass('org'), 'org');
  assert.equal(laneForClass('process'), 'process');
  assert.equal(laneForClass('work'), null);
  assert.equal(laneForClass('org-takeover'), null);
});

test('org lane が書けるのは roles/** と policy、governance で承認された文書だけ', () => {
  const allowlist = ['docs/handbook.md'];
  const scope = (kind, touch) => checkLaneScope({ lane: 'org', kind, touch, processEditAllowlist: allowlist });

  assert.equal(scope('role-edit', ['roles/sol.md']).ok, true);
  assert.equal(scope('policy-edit', [POLICY_FILE]).ok, true);
  assert.equal(scope('governance-edit', ['docs/social-engineering.md']).ok, true);

  // allowlist に載った文書は「非規範文書」なので governance では書けない (排他)
  assert.match(scope('governance-edit', ['docs/handbook.md']).reason, /processEditAllowlist に載っている/);
  // 大小文字だけ違う名前でも同じ (禁じる側は緩く見る)
  assert.match(scope('governance-edit', ['docs/HANDBOOK.md']).reason, /processEditAllowlist に載っている/);
  // roles / policy 以外は governance-edit 以外から書けない
  assert.match(scope('role-edit', ['docs/social-engineering.md']).reason, /org lane が書けるのは/);
  assert.match(scope('policy-edit', ['config.json']).reason, /org lane が書けるのは/);
  assert.match(scope('policy-edit', ['config.secrets.json']).reason, /どの lane からも書けません/);
});

test('process lane は allowlist に載った文書だけを完全一致で書ける', () => {
  const allowlist = ['docs/handbook.md'];
  const scope = (kind, touch) => checkLaneScope({ lane: 'process', kind, touch, processEditAllowlist: allowlist });

  assert.equal(scope('process-edit', ['docs/handbook.md']).ok, true);
  assert.match(scope('process-edit', ['docs/HANDBOOK.md']).reason, /載っていません/);
  assert.match(scope('process-edit', ['roles/sol.md']).reason, /載っていません/);
  // lane と kind の対応も見る (process lane から org の kind は起動しない)
  assert.match(scope('role-edit', ['roles/sol.md']).reason, /process lane が扱えるのは process-edit だけ/);
  assert.match(checkLaneScope({ lane: 'work', kind: 'work-item', touch: ['a.md'] }).reason, /未知の lane/);
  assert.match(checkLaneScope({ lane: 'org', kind: 'role-edit', touch: [] }).reason, /touch が空/);
});

// ---- 適用直前の関門 ----

test('採択された org 提案は lane と基点と適用後の内容を添えて当てられる', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  const plan = checkApplicable(s.get(p.id), ctx);
  assert.equal(plan.ok, true);
  assert.equal(plan.lane, 'org');
  assert.equal(plan.revision, 1);
  assert.equal(plan.digest, p.adjudication.digest);
  assert.equal(plan.baseCommit, BASE);
  assert.deepEqual(plan.touch, ['roles/sol.md']);
  assert.equal(plan.applied['roles/sol.md'], 'sol の憲章 (改)\n');
  assert.equal(plan.diffDigest, diffDigestOf(roleEdit().change.diff));
});

test('裁定されていない提案・却下・work は当てられない', () => {
  const ctx = ctxWith();
  const s = store();

  const raised = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  assert.match(checkApplicable(s.get(raised.id), ctx).reason, /raised なので適用できません/);

  s.deliberate(raised.id, { now: T0 });
  s.adjudicate(raised.id, {
    decision: 'rejected', actor: OWNER, ctx, now: T0, rationale: '見送り', baseCommit: BASE, ...AUTHORITY,
  });
  assert.match(checkApplicable(s.get(raised.id), ctx).reason, /終端/);

  assert.match(checkApplicable({ id: '9', state: 'adjudicated', decision: 'accepted', class: 'work' }, ctx).reason,
    /work は通常の task/);
  assert.match(checkApplicable(null, ctx).reason, /提案がありません/);
  assert.match(checkApplicable({ id: '9', state: 'adjudicated', decision: 'accepted', class: 'org' }, {}).reason,
    /ctx がありません/);
});

test('org lane は作者の裁定だけが起動する (裁定記録そのものを見る)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  // 保存値を直接 bot 裁定へ書き換えても、当てる側でもう一度落ちる
  const forged = s.get(p.id);
  forged.adjudication = { ...forged.adjudication, by: 'bot:fable' };
  assert.match(checkApplicable(forged, ctx).reason, /org lane は作者の裁定だけが起動します/);
});

test('基点の無い裁定は当てられない', () => {
  const ctx = ctxWith();

  // まず入口で止まる — 基点が無いまま org / process は採択できない
  assert.throws(() => accepted(store(), roleEdit(), ctx, { baseCommit: null }), /適用の基点が無いので採択できません/);

  // 記録が壊れて基点だけ落ちた場合も、当てる直前でもう一度落とす (二重の門)
  const s = store();
  const p = accepted(s, roleEdit(), ctx);
  const broken = s.get(p.id);
  broken.revisions.at(-1).snapshot.external.baseCommit = null;
  assert.match(checkApplicable(broken, ctx).reason, /基点 \(baseCommit\) がありません/);
});

test('裁定後に対象ファイルが動いていたら当てずに再裁定へ回す', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  const drifted = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (誰かが直した)\n' } });
  assert.match(checkApplicable(s.get(p.id), drifted).reason, /裁定時の内容と食い違っています/);
});

test('適用中の提案は二重に当てられない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);
  // 適用 task は裁定の後に作る (発議の時点で居ると、そのタスクとの競合で保存できない)
  const withTask = ctxWith({ tasks: [{ id: '7', state: 'approved', touch: ['roles/sol.md'] }] });
  s.linkTask(p.id, '7', { ctx: withTask, now: T0, apply: true });

  assert.match(checkApplicable(s.get(p.id), withTask).reason, /既にタスク 7 で適用中/);
});

test('試行が上限に達した提案は自動で当て直さない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);
  const many = { ...s.get(p.id), applyAttempts: Array.from({ length: APPLY_ATTEMPT_LIMIT }, () => ({ reason: 'NG' })) };

  assert.equal(applyAttemptCount(many), APPLY_ATTEMPT_LIMIT);
  assert.equal(shouldEscalateApply(many), true);
  assert.equal(shouldEscalateApply({ applyAttempts: [] }), false);
  assert.equal(applyAttemptCount(null), 0);
  const blocked = checkApplicable(many, ctx);
  assert.equal(blocked.escalate, true);
  assert.match(blocked.reason, /人間の判断が要ります/);
});

test('process の採択は process lane で当てられる', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, processEdit(), ctx, { actor: { kind: 'bot', botKey: 'fable' } });

  const plan = checkApplicable(s.get(p.id), ctx);
  assert.equal(plan.ok, true);
  assert.equal(plan.lane, 'process');
  assert.deepEqual(plan.touch, ['docs/handbook.md']);
});

test('裁定後に allowlist が動いて lane の範囲から外れたら当てない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, processEdit(), ctx, { actor: { kind: 'bot', botKey: 'fable' } });

  // allowlist から外れると revalidate 側が先に落とす (withdrawn 相当の理由)
  const narrowed = ctxWith({ allowlist: [] });
  assert.equal(checkApplicable(s.get(p.id), narrowed).ok, false);
});

test('prepareApply は再検証を通してから適用計画を返す', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  const prepared = prepareApply(s, p.id, ctx, { now: T0 });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.lane, 'org');
  assert.equal(s.get(p.id).state, 'adjudicated');
});

test('class が変わる提案は試行上限より先に withdrawn へ倒れる', () => {
  const s = store();
  const p = accepted(s, processEdit(), ctxWith(), { actor: { kind: 'bot', botKey: 'fable' } });
  // 試行上限に達していても、行き先が決まるものはそちらが先 (escalate で足止めしない)
  s.write(p.id, {
    ...s.get(p.id),
    applyAttempts: Array.from({ length: APPLY_ATTEMPT_LIMIT }, () => ({ reason: 'NG' })),
  });

  const narrowed = ctxWith({ allowlist: [] });
  const prepared = prepareApply(s, p.id, narrowed, { now: T0 });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.action, 'withdrawn');
  assert.equal(prepared.escalate, undefined);
  assert.equal(s.get(p.id).state, 'withdrawn');
});

// ---- worktree ----

test('適用の作業ツリーは再利用せず基点から作り直す', () => {
  const root = 'C:/repo';
  const path = worktreePathFor(root, '12');

  const fresh = planApplyWorktree({ repoRoot: root, taskId: '12', branch: 'task/12', baseCommit: BASE });
  assert.deepEqual(fresh.steps.map((s) => s.args), [['worktree', 'add', '-b', 'task/12', path, BASE]]);

  // 残骸があれば撤去してから、ブランチも消して作り直す (再利用しない)
  const dirty = planApplyWorktree({
    repoRoot: root,
    taskId: '12',
    branch: 'task/12',
    baseCommit: BASE,
    worktrees: [{ path, branch: 'task/12', prunable: false }],
    branches: ['task/12', 'main'],
  });
  assert.deepEqual(dirty.steps.map((s) => s.args), [
    ['worktree', 'remove', '--force', path],
    ['branch', '-D', 'task/12'],
    ['worktree', 'add', '-b', 'task/12', path, BASE],
  ]);

  // 消えた登録は prune してから
  const pruned = planApplyWorktree({
    repoRoot: root,
    taskId: '12',
    branch: 'task/12',
    baseCommit: BASE,
    worktrees: [{ path, branch: 'task/12', prunable: true }],
  });
  assert.deepEqual(pruned.steps[0].args, ['worktree', 'prune']);
});

test('別ブランチの残骸や他所が掴んでいるブランチには当てない', () => {
  const root = 'C:/repo';
  const path = worktreePathFor(root, '12');

  assert.throws(() => planApplyWorktree({
    repoRoot: root, taskId: '12', branch: 'task/12', baseCommit: BASE,
    worktrees: [{ path, branch: 'task/8', prunable: false }],
  }), /別のブランチ/);

  assert.throws(() => planApplyWorktree({
    repoRoot: root, taskId: '12', branch: 'task/12', baseCommit: BASE,
    worktrees: [{ path: 'C:/repo/.worktrees/task-9', branch: 'task/12', prunable: false }],
  }), /別の作業ツリー/);

  // 基点は必ず commit OID (ref は動く)
  assert.throws(() => planApplyWorktree({ repoRoot: root, taskId: '12', branch: 'task/12', baseCommit: 'main' }),
    /40 桁の commit OID/);
  assert.throws(() => planApplyWorktree({ repoRoot: root, taskId: '12', branch: '', baseCommit: BASE }),
    /branch は省略できない/);
});

// ---- 当てる前後の確認 ----

test('当てるのは HEAD が基点と一致し clean なツリーだけ', () => {
  assert.equal(checkApplyBase({ headOid: BASE, baseCommit: BASE, status: '' }).ok, true);
  assert.equal(checkApplyBase({ headOid: BASE.toUpperCase(), baseCommit: BASE }).ok, true);
  assert.match(checkApplyBase({ headOid: HEAD2, baseCommit: BASE }).reason, /裁定の基点/);
  assert.match(checkApplyBase({ headOid: BASE, baseCommit: BASE, status: ' M roles/sol.md' }).reason,
    /未コミットの変更/);
  assert.match(checkApplyBase({ headOid: 'HEAD', baseCommit: BASE }).reason, /HEAD の commit OID を読めません/);
  assert.match(checkApplyBase({ headOid: BASE, baseCommit: 'main' }).reason, /commit OID ではありません/);
});

/** `git diff --cached --raw -z` の 1 レコード */
const rawEntry = (srcMode, dstMode, status, path) => `:${srcMode} ${dstMode} ${'1'.repeat(40)} ${'2'.repeat(40)} ${status}\0${path}\0`;

test('基点はローカルブランチを完全一致で引く (同名 tag に負けない)', () => {
  // `git rev-parse master` は refs/tags を refs/heads より**先に**見る。同名の tag が
  // あると基点がそちらになり、承認された diff が別の履歴の上に乗る
  assert.deepEqual(baseCommitArgs('master'), ['rev-parse', '--verify', 'refs/heads/master^{commit}']);
  assert.equal(applyBaseRef('master'), 'refs/heads/master');
  assert.equal(applyBaseRef('  main  '), 'refs/heads/main');
  // 完全形で書かれていても二重に付けない
  assert.equal(applyBaseRef('refs/heads/release/1.0'), 'refs/heads/release/1.0');
  // ブランチ以外は基点にしない
  assert.equal(applyBaseRef('refs/tags/v1'), null);
  assert.equal(applyBaseRef('refs/remotes/origin/main'), null);
  assert.equal(applyBaseRef(''), null);
  assert.equal(applyBaseRef(null), null);
  assert.equal(baseCommitArgs('refs/tags/v1'), null);
});

test('同名の branch と tag があるとき、短い名前では tag が勝つ (だから refs/heads で引く)', () => {
  // git の解決順そのものを実物で確かめる。ここが変われば基点の引き方も見直す必要がある
  const repo = mkdtempSync(join(tmpdir(), 'communitd-ref-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'master');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'branch');
  const onBranch = git('rev-parse', 'HEAD');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'tagged');
  const onTag = git('rev-parse', 'HEAD');
  git('tag', 'master', onTag);
  git('update-ref', 'refs/heads/master', onBranch);

  assert.notEqual(onBranch, onTag);
  assert.equal(git('rev-parse', 'master^{commit}'), onTag, '短い名前では tag が勝つ');
  assert.equal(git(...baseCommitArgs('master')), onBranch, 'refs/heads で引けばブランチの先端');
});

test('適用結果を検査するのは可変なものではなく固定した tree', () => {
  // **--cached が無いと base と作業ツリーの比較になる。** commit されるのは index なので、
  // 検査対象がずれると「作業ツリーは承認内容・index は別内容」で通ってしまう
  assert.deepEqual(rawDiffArgs(BASE, TREE), ['diff', '--raw', '-z', '--no-renames', BASE, TREE]);
  // --no-renames は diff.renames の設定でレコードの形が変わらないようにするため
  assert.equal(rawDiffArgs(BASE, TREE).includes('--no-renames'), true);
  assert.deepEqual(objectShowArgs(TREE, 'roles/sol.md'), ['show', `${TREE}:roles/sol.md`]);
  assert.deepEqual(objectShowArgs(BASE, 'roles/sol.md'), ['show', `${BASE}:roles/sol.md`]);
  // **ref は読ませない。** 不変条件をコメントではなく引数で強制する — `HEAD` も
  // `:<path>` (index) も、読んだ後に動きうるので検査の根拠にできない
  assert.throws(() => objectShowArgs('HEAD', 'roles/sol.md'), /40 桁の OID で渡す/);
  assert.throws(() => objectShowArgs('master', 'roles/sol.md'), /40 桁の OID で渡す/);
  assert.throws(() => objectShowArgs('', 'roles/sol.md'), /40 桁の OID で渡す/);
});

test('git diff --cached --raw -z を読み、rename / copy と壊れた形は受け付けない', () => {
  const parsed = parseRawDiff(
    rawEntry('100644', '100644', 'M', 'roles/sol.md') + rawEntry('000000', '100644', 'A', 'roles/new.md'),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries.map((e) => [e.path, e.status, e.dstMode]), [
    ['roles/sol.md', 'M', '100644'],
    ['roles/new.md', 'A', '100644'],
  ]);
  assert.deepEqual(parseRawDiff('').entries, []);

  assert.match(parseRawDiff(`:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} R100\0old.md\0new.md\0`).reason,
    /rename \/ copy は適用結果として受け付けません/);
  assert.match(parseRawDiff('M\troles/sol.md\n').reason, /読めません/);
  assert.match(parseRawDiff(`:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0`).reason, /パスがありません/);
});

test('コミットしてよいのは承認された変更しか入っていないときだけ', () => {
  const applied = { 'roles/sol.md': 'sol の憲章 (改)\n', 'roles/old.md': null };
  const treeContents = { 'roles/sol.md': 'sol の憲章 (改)\n', 'roles/old.md': null };
  const files = [{ path: 'roles/sol.md', op: 'edit' }, { path: 'roles/old.md', op: 'delete' }];
  const rawTree = rawEntry('100644', '100644', 'M', 'roles/sol.md')
    + rawEntry('100644', '000000', 'D', 'roles/old.md');
  const check = (over = {}) => checkApplyResult({ rawTree, treeContents, applied, files, ...over });

  assert.equal(check().ok, true);
  assert.match(check({ rawTree: rawTree + rawEntry('100644', '100644', 'M', 'README.md') }).reason,
    /承認されていない変更が混ざっています: README.md/);
  assert.match(check({ rawTree: rawEntry('100644', '100644', 'M', 'roles/sol.md') }).reason,
    /承認された変更が入っていません: roles\/old.md/);
  // index に載っている内容が承認された適用結果と違えば落ちる (作業ツリーが正しくても)
  assert.match(check({ treeContents: { ...treeContents, 'roles/sol.md': 'tree にだけ入った内容\n' } }).reason,
    /内容が承認された適用結果と違います/);
  assert.match(check({ treeContents: { ...treeContents, 'roles/old.md': '残っている\n' } }).reason,
    /削除されていません/);
  assert.match(check({ treeContents: { 'roles/sol.md': 'sol の憲章 (改)\n' } }).reason,
    /tree 上の内容を読めません/);
  assert.match(check({ rawTree: rawTree + rawEntry('100644', '100644', 'M', 'roles/sol.md') }).reason,
    /2 回現れます/);
});

test('内容が合っていても mode 変更・type 変更・操作の取り違えは通さない', () => {
  const applied = { 'roles/sol.md': 'sol の憲章 (改)\n' };
  const treeContents = { 'roles/sol.md': 'sol の憲章 (改)\n' };
  const files = [{ path: 'roles/sol.md', op: 'edit' }];
  const check = (rawTree) => checkApplyResult({ rawTree, treeContents, applied, files });

  // 実行属性が付いた / symlink になった / submodule になった
  assert.match(check(rawEntry('100644', '100755', 'M', 'roles/sol.md')).reason, /ファイルモードが変わっています/);
  assert.match(check(rawEntry('100644', '120000', 'T', 'roles/sol.md')).reason, /編集として入っていません \(T\)/);
  assert.match(check(rawEntry('100755', '100755', 'M', 'roles/sol.md')).reason, /通常ファイルではありません/);
  // 編集のはずが追加・削除として入っている
  assert.match(check(rawEntry('000000', '100644', 'A', 'roles/sol.md')).reason, /編集として入っていません \(A\)/);

  // create / delete も同じ厳しさで見る
  assert.match(checkApplyResult({
    rawTree: rawEntry('000000', '120000', 'A', 'roles/new.md'),
    treeContents: { 'roles/new.md': 'x\n' },
    applied: { 'roles/new.md': 'x\n' },
    files: [{ path: 'roles/new.md', op: 'create' }],
  }).reason, /通常ファイルではありません \(mode 120000\)/);
  assert.match(checkApplyResult({
    rawTree: rawEntry('120000', '000000', 'D', 'roles/link.md'),
    treeContents: { 'roles/link.md': null },
    applied: { 'roles/link.md': null },
    files: [{ path: 'roles/link.md', op: 'delete' }],
  }).reason, /通常ファイルではありませんでした/);
});

// ---- receipt と merge ----

test('receipt は材料が揃っていなければ作らせない', () => {
  const base = {
    proposalId: '1', revision: 1, digest: 'deadbeefdeadbeef', baseCommit: BASE,
    appliedCommit: HEAD2, appliedTree: TREE, diffDigest: 'cafebabecafebabe', verify: { ok: true },
  };
  const receipt = makeReceipt(base);
  assert.equal(receipt.appliedCommit, HEAD2);
  assert.equal(receipt.verify.ok, true);
  assert.equal(makeReceipt({ ...base, verify: { ok: false, detail: 'テストが 2 件失敗' } }).verify.detail, 'テストが 2 件失敗');

  assert.throws(() => makeReceipt({ ...base, proposalId: '' }), /proposalId は必須/);
  assert.throws(() => makeReceipt({ ...base, revision: 0 }), /revision は 1 以上/);
  assert.throws(() => makeReceipt({ ...base, appliedCommit: 'HEAD' }), /appliedCommit は 40 桁/);
  assert.throws(() => makeReceipt({ ...base, appliedTree: null }), /appliedTree は 40 桁/);
  assert.throws(() => makeReceipt({ ...base, verify: null }), /verify は \{ok: boolean\}/);
});

test('merge の根拠は receipt だけで、ブランチ名ではなく commit OID を merge する', () => {
  const receipt = makeReceipt({
    proposalId: '1', revision: 1, digest: 'deadbeefdeadbeef', baseCommit: BASE,
    appliedCommit: HEAD2, appliedTree: TREE, diffDigest: 'cafebabecafebabe', verify: { ok: true },
  });

  const plan = planMerge({ receipt, branchHeadOid: HEAD2, into: 'master' });
  assert.equal(plan.ok, true);
  assert.equal(plan.commit, HEAD2);
  assert.deepEqual(plan.steps.map((s) => s.args), [
    ['checkout', 'master'],
    ['merge', '--no-ff', '--no-edit', HEAD2],
  ]);

  // **統合先に既定は置かない** — リポジトリによって main だったり master だったりする
  assert.throws(() => planMerge({ receipt, branchHeadOid: HEAD2 }), /into\) は省略できない/);

  // コミット後に枝へ足された未承認のコミットは入れない
  const into = 'master';
  assert.match(planMerge({ receipt, branchHeadOid: 'd'.repeat(40), into }).reason, /承認外のコミットが足されています/);
  assert.match(planMerge({ receipt: { ...receipt, verify: { ok: false } }, branchHeadOid: HEAD2, into }).reason,
    /verify に通っていない/);
  assert.match(planMerge({ branchHeadOid: HEAD2, into }).reason, /receipt がありません/);
  assert.match(planMerge({ receipt, branchHeadOid: 'task/12', into }).reason, /枝の HEAD を読めません/);
});

// ---- 提案側の記録 ----

test('適用 task は 1 件だけ結べ、receipt は裁定 digest に対応していないと残せない', () => {
  const s = store();
  const p = accepted(s, roleEdit(), ctxWith());
  const ctx = ctxWith({
    tasks: [
      { id: '7', state: 'approved', touch: ['roles/sol.md'] },
      { id: '8', state: 'approved', touch: ['roles/sol.md'] },
    ],
  });

  const linked = s.linkTask(p.id, '7', { ctx, now: T0, apply: true });
  assert.equal(linked.applyTaskId, '7');
  // **錠は task ID だけでなく revision と digest にも束縛する**
  assert.equal(linked.applyRevision, 1);
  assert.equal(linked.applyDigest, p.adjudication.digest);
  assert.throws(() => s.linkTask(p.id, '8', { ctx, now: T0, apply: true }), /二重適用はできません/);
  assert.throws(() => s.linkTask(p.id, '7', { ctx, now: T0, apply: true }), /二重適用はできません/);

  const receipt = makeReceipt({
    proposalId: p.id, revision: 1, digest: p.adjudication.digest, baseCommit: BASE,
    appliedCommit: HEAD2, appliedTree: TREE, diffDigest: diffDigestOf(roleEdit().change.diff), verify: { ok: true },
  });
  const reject = (over, pattern) => assert.throws(() => s.recordReceipt(p.id, { ...receipt, ...over }, { now: T0 }), pattern);
  reject({ digest: '0000000000000000' }, /digest が裁定/);
  reject({ proposalId: '99' }, /proposalId/);
  // 同じ digest でも別 revision の receipt は受け取らない
  reject({ revision: 2 }, /錠を取った revision/);
  reject({ baseCommit: 'd'.repeat(40) }, /基点/);
  // 承認された diff 以外を当てた記録は受け取らない
  reject({ diffDigest: 'cafebabecafebabe' }, /承認された diff と違います/);
  // verify NG は receipt ではなく failApply へ
  reject({ verify: { ok: false } }, /verify に通っていない/);

  const withReceipt = s.recordReceipt(p.id, receipt, { now: T0, by: 'bridge' });
  assert.equal(withReceipt.receipt.appliedCommit, HEAD2);
  assert.equal(withReceipt.state, 'adjudicated');
  // 上書きもさせない (当て直しは failApply を通す)
  reject({}, /既に receipt があります/);
});

test('適用中でない提案には receipt を残せない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);
  const receipt = makeReceipt({
    proposalId: p.id, revision: 1, digest: p.adjudication.digest, baseCommit: BASE,
    appliedCommit: HEAD2, appliedTree: TREE, diffDigest: 'cafebabecafebabe', verify: { ok: true },
  });
  assert.throws(() => s.recordReceipt(p.id, receipt, { now: T0 }), /適用中ではありません/);
});

test('差し戻しは試行を記録し、錠を外して再裁定へ戻す (1 回の書き込み)', () => {
  const s = store();
  const p = accepted(s, roleEdit(), ctxWith());
  const ctx = ctxWith({ tasks: [{ id: '7', state: 'approved', touch: ['roles/sol.md'] }] });
  s.linkTask(p.id, '7', { ctx, now: T0, apply: true });

  // **どの適用の失敗かを名乗らせる。** 古い task の失敗で新しい適用を落とさせない
  assert.throws(() => s.failApply(p.id, { reason: '古い失敗', taskId: '6', now: T0 }), /適用タスク \(7\) ではありません/);
  assert.throws(() => s.failApply(p.id, { reason: '名乗りなし', now: T0 }), /taskId は必須です/);

  const back = s.failApply(p.id, {
    reason: '検収が差し戻した (文面の一貫性)', verdict: 'send-back', appliedCommit: HEAD2,
    verify: { ok: true }, taskId: '7', now: T0, by: 'bot:sol',
  });
  assert.equal(back.state, 'deliberating');
  assert.equal(back.decision, null);
  assert.equal(back.applyTaskId, null);
  assert.equal(back.applyRevision, null);
  assert.equal(back.applyDigest, null);
  assert.equal(back.receipt, null);
  assert.deepEqual(back.applyAttempts.map((a) => [a.taskId, a.verdict, a.revision]), [['7', 'send-back', 1]]);
  assert.equal(shouldEscalateApply(back), false);

  // 戻した後は採択が生きていないので当てられない
  assert.match(checkApplicable(s.get(p.id), ctx).reason, /deliberating なので適用できません/);
  // 錠が無いので二度は戻せない (試行回数を水増しさせない)
  assert.throws(() => s.failApply(p.id, { reason: '二度は戻せない', taskId: '7', now: T0 }), /適用中ではありません/);
});

test('再検証が先に deliberating へ落としても、錠だけは解放できる', () => {
  const s = store();
  const p = accepted(s, processEdit(), ctxWith(), { actor: { kind: 'bot', botKey: 'fable' } });
  const ctx = ctxWith({ tasks: [{ id: '7', state: 'approved', touch: ['docs/handbook.md'] }] });
  s.linkTask(p.id, '7', { ctx, now: T0, apply: true });

  // 対象ファイルが動いて revalidate が差し戻す (錠は掛かったまま宙に浮く)
  const drifted = ctxWith({
    files: { ...FILES, 'docs/handbook.md': '誰かが直した\n' },
    tasks: [{ id: '7', state: 'approved', touch: ['docs/handbook.md'] }],
  });
  assert.equal(s.revalidate(p.id, drifted, { now: T0 }).action, 'deliberating');
  assert.equal(s.get(p.id).applyTaskId, '7');

  const released = s.failApply(p.id, { reason: '前提が変わったので当て直す', taskId: '7', now: T0 });
  assert.equal(released.state, 'deliberating');
  assert.equal(released.applyTaskId, null);
  assert.equal(released.applyAttempts.length, 1);
});

test('試用は適用の後 (receipt と merge 済みの適用タスクが要る)', () => {
  const s = store();
  const p = accepted(s, roleEdit(), ctxWith());
  const ctx = ctxWith({ tasks: [{ id: '7', state: 'approved', touch: ['roles/sol.md'] }] });

  assert.throws(() => s.startTrial(p.id, { now: T0 }), /まだ適用されていません/);

  s.linkTask(p.id, '7', { ctx, now: T0, apply: true });
  s.recordReceipt(p.id, makeReceipt({
    proposalId: p.id, revision: 1, digest: p.adjudication.digest, baseCommit: BASE,
    appliedCommit: HEAD2, appliedTree: TREE, diffDigest: diffDigestOf(roleEdit().change.diff), verify: { ok: true },
  }), { now: T0 });

  // merge されるまでは進めない
  assert.throws(() => s.startTrial(p.id, { ctx, now: T0 }), /approved なのでまだ試用へ進めません/);
  assert.throws(() => s.startTrial(p.id, { now: T0 }), /ctx は必須です/);

  const merged = ctxWith({ tasks: [{ id: '7', state: 'merged', touch: ['roles/sol.md'] }] });
  const inTrial = s.startTrial(p.id, { ctx: merged, now: T0 });
  assert.equal(inTrial.state, 'trial');
});
