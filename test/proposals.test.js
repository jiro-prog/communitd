import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROPOSAL_KINDS,
  ProposalStore,
  canAdjudicate,
  changedPointers,
  checkProposal,
  createRepoContext,
  deliberationCount,
  digestOf,
  classForKind,
  expandSubjectKey,
  formatPointer,
  isTerminal,
  parsePointer,
  proposalDigest,
  snapshotOf,
  subjectsConflict,
  taskConflicts,
  validateProposalInput,
} from '../src/proposals.js';
import { diffDigestOf, makeReceipt } from '../src/apply.js';
import { POLICY_FILE, SECRETS_FILE } from '../src/config.js';
import { isSafeRepoPath } from '../src/repopath.js';

// ---- 材料 ----

const POLICY = {
  claudeBin: 'claude',
  limits: { maxBotHops: 3 },
  bots: {
    fable: { model: 'fable' },
    opus: { model: 'opus' },
    sol: { model: 'sol', duties: { review: { intervalMin: 60 } } },
    solaris: { model: 'solaris' },
  },
  channels: {
    observatory: { cwd: '.', toolsExtra: ['Write', 'WebSearch'] },
    locked: { cwd: '.', allowedTools: ['Read'] },
  },
  processEditAllowlist: ['docs/handbook.md'],
};

const policyText = (policy = POLICY) => `${JSON.stringify(policy, null, 2)}\n`;

const FILES = {
  [POLICY_FILE]: policyText(),
  'roles/sol.md': 'sol の憲章\n',
  'roles/solaris.md': 'solaris の憲章\n',
  'roles/opus.md': 'opus の憲章\n',
  'docs/handbook.md': '手順\n',
  'docs/social-engineering.md': '設計\n',
};

/** 全体置換の diff (テストから読める最小の形。文法は src/diffs.js が検査する) */
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

/** policy を書き換える diff */
function policyDiff(mutate, files = FILES) {
  const after = structuredClone(JSON.parse(files[POLICY_FILE]));
  mutate(after);
  return makeDiff(POLICY_FILE, files[POLICY_FILE], policyText(after));
}

function ctxWith({ policy = POLICY, files = FILES, dirs = ['roles', 'docs', 'test'], tasks = [], allowlist = null } = {}) {
  return {
    policy,
    processEditAllowlist: allowlist ?? policy.processEditAllowlist ?? [],
    // 実体判定の中身は test/repopath.test.js が実ファイルで見る。ここは形だけの偽物
    checkPath: (p) => (isSafeRepoPath(p)
      ? { ok: true, kind: Object.hasOwn(files, p) ? 'file' : (dirs.includes(p) ? 'dir' : 'missing') }
      : { ok: false, reason: `パスとして受け付けられません: ${p}` }),
    fileExists: (p) => Object.hasOwn(files, p),
    dirExists: (p) => dirs.includes(p),
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
  change: {
    touch: ['roles/sol.md'],
    diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], 'sol の憲章 (改)\n'),
  },
  benefits: ['観点が揃う'],
  risks: ['文面が長くなる'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '差し戻し率が下がる', rollback: '前の文面へ戻す' },
  ...over,
});

const store = () => new ProposalStore(join(mkdtempSync(join(tmpdir(), 'communitd-prop-')), 'proposals.json'));

const T0 = Date.parse('2026-08-29T00:00:00.000Z');
const OWNER = { kind: 'owner', userId: 'so-user-id' };
const AUTHORITY = { ownerUserId: 'so-user-id', execBotKeys: ['fable'] };

/** 適用の基点 (org / process の採択には commit OID が要る) */
const BASE_OID = 'a'.repeat(40);

/** 保存 → 審議 → 裁定まで一気に進める (裁定の前提を作るためのヘルパ) */
function accepted(s, input, ctx, { actor = OWNER, authority = AUTHORITY, baseCommit = BASE_OID } = {}) {
  const p = s.raise(input, { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });
  return s.adjudicate(p.id, { decision: 'accepted', actor, ctx, now: T0, rationale: '妥当', baseCommit, ...authority });
}

// ---- kind と class ----

test('kind は閉集合で、class はブリッジが写像する', () => {
  assert.deepEqual(
    PROPOSAL_KINDS.filter((k) => classForKind(k) === 'org').sort(),
    ['duty-edit', 'governance-edit', 'policy-edit', 'role-create', 'role-edit', 'role-retire', 'staffing', 'tool-grant'],
  );
  assert.equal(classForKind('process-edit'), 'process');
  assert.deepEqual(PROPOSAL_KINDS.filter((k) => classForKind(k) === 'work').sort(), ['check-add', 'tooling-add', 'work-item']);
  assert.equal(classForKind('org-takeover'), null);
});

test('bot は class も subjectKeys も自己申告できない', () => {
  assert.match(validateProposalInput(roleEdit({ class: 'work' })).reason, /class は bot が申告しません/);
  assert.match(validateProposalInput(roleEdit({ subjectKeys: ['role:sol'] })).reason, /未知のキー/);
  assert.match(validateProposalInput(roleEdit({ kind: 'org-takeover' })).reason, /未知の kind/);
});

test('org と process には trial (期限・成功条件・ロールバック) が要る', () => {
  const { trial, ...noTrial } = roleEdit();
  assert.match(validateProposalInput(noTrial).reason, /trial/);
  assert.match(validateProposalInput(roleEdit({ trial: { deadline: 'いつか', successCriteria: 'a', rollback: 'b' } })).reason, /deadline/);
  // work class は必須にしない
  const workItem = { ...noTrial, kind: 'check-add', targets: [{ path: 'test/x.test.js' }] };
  assert.equal(validateProposalInput(workItem).ok, true);
});

// ---- subjectKeys の生成 ----

test('subjectKeys は targets[] から kind ごとの規則で生成する', () => {
  const ctx = ctxWith();
  const keysOf = (input) => {
    const checked = checkProposal(input, ctx);
    assert.equal(checked.ok, true, checked.reason);
    return checked.subjectKeys;
  };

  assert.deepEqual(keysOf(roleEdit()), ['role:sol']);
  assert.deepEqual(keysOf(roleEdit({
    kind: 'duty-edit',
    targets: [{ botKey: 'sol', dutyKey: 'review', op: 'edit' }],
    change: {
      touch: [POLICY_FILE],
      diff: policyDiff((p) => { p.bots.sol.duties.review.intervalMin = 30; }),
    },
  })), ['duty:sol/review']);
  assert.deepEqual(keysOf(roleEdit({
    kind: 'role-create',
    targets: [{ slug: 'jyoshi' }],
    change: {
      touch: [POLICY_FILE, 'roles/jyoshi.md'],
      diff: policyDiff((p) => { p.bots.jyoshi = { model: 'opus' }; })
        + makeDiff('roles/jyoshi.md', null, '情シスの憲章\n'),
    },
  })), ['role:new/jyoshi']);
  assert.deepEqual(keysOf(roleEdit({
    kind: 'process-edit',
    targets: [{ doc: 'docs/handbook.md' }],
    change: { touch: ['docs/handbook.md'], diff: makeDiff('docs/handbook.md', FILES['docs/handbook.md'], '手順 (改)\n') },
  })), ['doc:docs/handbook.md']);
  assert.deepEqual(keysOf(roleEdit({
    kind: 'tool-grant',
    targets: [{ channel: 'observatory', tool: 'Edit', op: 'add' }],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.channels.observatory.toolsExtra.push('Edit'); }) },
  })), ['tool:observatory/Edit']);
});

test('存在条件は kind と op で決まる', () => {
  const ctx = ctxWith();
  const reason = (input) => {
    const checked = checkProposal(input, ctx);
    assert.equal(checked.ok, false, '通してはいけない');
    return checked.reason;
  };
  // role-edit は botKey 実在
  assert.match(reason(roleEdit({ targets: [{ botKey: 'nobody' }] })), /policy にありません/);
  // role-create は実在キーとの衝突を拒否
  assert.match(reason(roleEdit({ kind: 'role-create', targets: [{ slug: 'sol' }] })), /既にあります/);
  assert.match(reason(roleEdit({ kind: 'role-create', targets: [{ slug: 'Jyoshi' }] })), /英小文字/);
  // duty は add なら不在・edit なら実在
  assert.match(reason(roleEdit({ kind: 'duty-edit', targets: [{ botKey: 'sol', dutyKey: 'review', op: 'add' }] })), /既にあります/);
  assert.match(reason(roleEdit({ kind: 'duty-edit', targets: [{ botKey: 'sol', dutyKey: 'nothing', op: 'edit' }] })), /がありません/);
  // policy pointer は add なら親が実在・当該 key は不在
  assert.match(reason(roleEdit({ kind: 'policy-edit', targets: [{ pointer: '/nowhere/deep', op: 'add' }] })), /親 pointer/);
  assert.match(reason(roleEdit({ kind: 'policy-edit', targets: [{ pointer: '/limits/maxBotHops', op: 'add' }] })), /既にあります/);
  // governance の対象は allowlist 外・process の対象は allowlist 内
  assert.match(reason(roleEdit({ kind: 'governance-edit', targets: [{ doc: 'docs/handbook.md' }] })), /processEditAllowlist に載っている/);
  assert.match(reason(roleEdit({ kind: 'process-edit', targets: [{ doc: 'docs/social-engineering.md' }] })), /governance-edit として出し直す/);
});

// ---- 役割文の在り処は policy の rolePromptFile が正本 ----
//
// `roles/<botKey>.md` の決め打ちは、同じ役割文を共有する 2 体目で既に破れていた
// (実在しないパスを指し、その bot の憲章を掴めていなかった)。

const SHARED_POLICY = {
  ...POLICY,
  bots: {
    ...POLICY.bots,
    opus: { model: 'opus', rolePromptFile: 'roles/worker.md', duties: { audit: { intervalMin: 60 } } },
    opus2: { model: 'opus', rolePromptFile: 'roles/worker.md' },
  },
};
const SHARED_FILES = {
  ...FILES,
  [POLICY_FILE]: policyText(SHARED_POLICY),
  'roles/worker.md': 'worker の憲章\n',
};
const sharedCtx = (over = {}) => ctxWith({ policy: SHARED_POLICY, files: SHARED_FILES, ...over });

test('role-edit / subjectKey は rolePromptFile の指すファイルを対象にする', () => {
  const ctx = sharedCtx();
  // 決め打ちの roles/opus.md ではなく、policy が指す roles/worker.md が必須になる
  const wrongFile = checkProposal(roleEdit({
    targets: [{ botKey: 'opus' }],
    change: { touch: ['roles/opus.md'], diff: makeDiff('roles/opus.md', FILES['roles/opus.md'], 'x\n') },
  }), ctx);
  assert.equal(wrongFile.ok, false);
  assert.match(wrongFile.reason, /必須のファイルがありません/);

  const right = checkProposal(roleEdit({
    targets: [{ botKey: 'opus' }],
    change: {
      touch: ['roles/worker.md'],
      diff: makeDiff('roles/worker.md', SHARED_FILES['roles/worker.md'], 'worker の憲章 (改)\n'),
    },
  }), ctx);
  assert.equal(right.ok, true, right.reason);
  assert.deepEqual(expandSubjectKey('role:opus', ctx), ['policy:/bots/opus', 'file:roles/worker.md']);
  // rolePromptFile を書いていない bot は従来どおり roles/<botKey>.md
  assert.deepEqual(expandSubjectKey('role:sol', ctx), ['policy:/bots/sol', 'file:roles/sol.md']);
});

test('duty-edit が触れる憲章も rolePromptFile で決まる', () => {
  const ctx = sharedCtx();
  const dutyEdit = (touch, path) => checkProposal(roleEdit({
    kind: 'duty-edit',
    targets: [{ botKey: 'opus', dutyKey: 'audit', op: 'edit' }],
    change: {
      touch: [POLICY_FILE, touch],
      diff: makeDiff(POLICY_FILE, policyText(SHARED_POLICY), policyText({
        ...SHARED_POLICY,
        bots: { ...SHARED_POLICY.bots, opus: { ...SHARED_POLICY.bots.opus, duties: { audit: { intervalMin: 30 } } } },
      })) + makeDiff(path, SHARED_FILES[path], 'x\n'),
    },
  }), ctx);
  assert.equal(dutyEdit('roles/worker.md', 'roles/worker.md').ok, true);
  // 他人の役割文は掴めない (許された範囲が roles/worker.md に決まっているので範囲外で落ちる)
  const other = dutyEdit('roles/sol.md', 'roles/sol.md');
  assert.equal(other.ok, false);
  assert.match(other.reason, /roles\/sol\.md/);
});

test('共有されている役割文は廃止で消させない (巻き添えを止める)', () => {
  // `role-retire` は役割文を delete する。決め打ちの頃は 2 体目のパスが実在せず
  // 「文書が無い」で偶然止まっていたが、rolePromptFile を正本にすると届いてしまう
  const retire = (botKey, ctx) => checkProposal(roleEdit({
    kind: 'role-retire',
    targets: [{ botKey }],
    change: {
      touch: [POLICY_FILE, 'roles/worker.md'],
      diff: makeDiff('roles/worker.md', SHARED_FILES['roles/worker.md'], null),
    },
  }), ctx);
  const shared = retire('opus', sharedCtx());
  assert.equal(shared.ok, false);
  assert.match(shared.reason, /opus2 も使っています/);

  // 共有していない配備では従来どおり (ここでは必須ファイルの検査まで進む)
  const soloPolicy = { ...SHARED_POLICY, bots: { ...SHARED_POLICY.bots, opus2: { model: 'opus' } } };
  const solo = retire('opus', ctxWith({
    policy: soloPolicy,
    files: { ...SHARED_FILES, [POLICY_FILE]: policyText(soloPolicy) },
  }));
  assert.equal(/も使っています/.test(solo.reason ?? ''), false, solo.reason);
});

// ---- 展開と競合判定 ----

test('subjectKey は名前空間をまたいで展開される', () => {
  const ctx = ctxWith({ tasks: [{ id: '7', touch: ['src/index.js', POLICY_FILE] }] });
  assert.deepEqual(expandSubjectKey('role:sol', ctx), ['policy:/bots/sol', 'file:roles/sol.md']);
  // `new/` は「まだ実在しない」印であって展開先には残さない
  assert.deepEqual(expandSubjectKey('role:new/jyoshi', ctx), ['policy:/bots/jyoshi', 'file:roles/jyoshi.md']);
  assert.deepEqual(expandSubjectKey('duty:sol/review', ctx), ['policy:/bots/sol/duties/review']);
  assert.deepEqual(expandSubjectKey('tool:observatory/Edit', ctx), ['policy:/channels/observatory/toolsExtra']);
  assert.deepEqual(expandSubjectKey('doc:docs/handbook.md', ctx), ['file:docs/handbook.md']);
  assert.deepEqual(expandSubjectKey('path:test/x.test.js', ctx), ['file:test/x.test.js']);
  // task は touch の各ファイルへ。policy を含むならルート pointer へも展開する
  assert.deepEqual(expandSubjectKey('task:7', ctx), ['task:7', 'file:src/index.js', `file:${POLICY_FILE}`, 'policy:/']);
});

test('展開後の包含判定は pointer のセグメント列で行う', () => {
  const ctx = ctxWith();
  // role の廃止提案と同じ bot の duty 編集は競合する
  assert.equal(subjectsConflict(['role:sol'], ['duty:sol/review'], ctx), true);
  assert.equal(subjectsConflict(['role:sol'], ['policy:/bots/sol/duties/review'], ctx), true);
  // 文字列 prefix なら誤って包含してしまう組み合わせ
  assert.equal(subjectsConflict(['role:sol'], ['role:solaris'], ctx), false);
  assert.equal(subjectsConflict(['policy:/bots/sol'], ['policy:/bots/solaris'], ctx), false);
  // 文書は名前空間を分けない (process-edit と work-item が同じファイルを指せば競合)
  assert.equal(subjectsConflict(['doc:docs/handbook.md'], ['path:docs/handbook.md'], ctx), true);
  assert.equal(subjectsConflict(['path:a.md'], ['path:b.md'], ctx), false);
  // まだ作られていないファイル同士でも、大小文字だけの違いは同じ実体 (Windows)
  assert.equal(subjectsConflict(['path:test/new.txt'], ['path:test/NEW.TXT'], ctx), true);
  assert.equal(subjectsConflict(['role:sol'], ['path:ROLES/SOL.MD'], ctx), true);
  const withCaseTask = ctxWith({ tasks: [{ id: '7', touch: ['test/NEW.TXT'] }] });
  assert.equal(taskConflicts(['path:test/new.txt'], withCaseTask.openTasks[0], withCaseTask), true);
  // policy を触る task と policy pointer を狙う提案は競合する
  const withTask = ctxWith({ tasks: [{ id: '7', touch: [POLICY_FILE] }] });
  assert.equal(subjectsConflict(['task:7'], ['policy:/bots/sol'], withTask), true);
});

test('open な提案は 1 subject につき高々 1 件', () => {
  const ctx = ctxWith();
  const s = store();
  s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });

  assert.throws(() => s.raise(roleEdit({
    kind: 'duty-edit',
    targets: [{ botKey: 'sol', dutyKey: 'review', op: 'edit' }],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.bots.sol.duties.review.intervalMin = 30; }) },
  }), { raisedBy: 'fable', ctx, now: T0 }), /競合します/);

  // 別 bot の憲章なら競合しない
  const other = s.raise(roleEdit({
    targets: [{ botKey: 'solaris' }],
    change: { touch: ['roles/solaris.md'], diff: makeDiff('roles/solaris.md', FILES['roles/solaris.md'], 'solaris の憲章 (改)\n') },
  }), { raisedBy: 'opus', ctx, now: T0 });
  assert.deepEqual(other.subjectKeys, ['role:solaris']);
});

test('touch を持たないタスクは何とでも競合する (fail-closed)', () => {
  const ctx = ctxWith({ tasks: [{ id: '9', touch: null }] });
  assert.throws(() => store().raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 }), /タスク 9 と対象が競合/);
});

// ---- touch と diff の照合 ----

test('touch は必須を下限・許可を上限として効く', () => {
  const ctx = ctxWith();
  const dutyBase = roleEdit({
    kind: 'duty-edit',
    targets: [{ botKey: 'sol', dutyKey: 'review', op: 'edit' }],
  });

  // 必須 (config.policy.json) が無い
  assert.match(checkProposal({ ...dutyBase, change: { touch: ['roles/sol.md'], diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], 'x\n') } }, ctx).reason, /必須のファイルがありません/);
  // 許可の外 (roles/opus.md は対象 bot の憲章ではない)
  assert.match(checkProposal({
    ...dutyBase,
    change: {
      touch: [POLICY_FILE, 'roles/opus.md'],
      diff: policyDiff((p) => { p.bots.sol.duties.review.intervalMin = 30; }) + makeDiff('roles/opus.md', FILES['roles/opus.md'], 'x\n'),
    },
  }, ctx).reason, /許された範囲を超えています/);
  // 必須だけ = 通る (憲章まで直さない選択も正しい)
  assert.equal(checkProposal({
    ...dutyBase,
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.bots.sol.duties.review.intervalMin = 30; }) },
  }, ctx).ok, true);
});

test('diff と touch がずれた提案は保存前に落ちる', () => {
  const ctx = ctxWith();
  const checked = checkProposal(roleEdit({
    kind: 'duty-edit',
    targets: [{ botKey: 'sol', dutyKey: 'review', op: 'edit' }],
    change: {
      touch: [POLICY_FILE, 'roles/sol.md'], // diff は policy しか触っていない
      diff: policyDiff((p) => { p.bots.sol.duties.review.intervalMin = 30; }),
    },
  }), ctx);
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /diff と touch が一致しません/);
});

test('kind ごとに許す操作と適用前の存在条件を閉じる', () => {
  const ctx = ctxWith();
  // role-edit で role 文書を削除できない
  assert.match(checkProposal(roleEdit({
    change: { touch: ['roles/sol.md'], diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], null) },
  }), ctx).reason, /delete できません/);
  // role-create は create しか許さない (既存の孤児ファイルを編集する経路を塞ぐ)
  const create = roleEdit({
    kind: 'role-create',
    targets: [{ slug: 'jyoshi' }],
    change: {
      touch: [POLICY_FILE, 'roles/jyoshi.md'],
      diff: policyDiff((p) => { p.bots.jyoshi = { model: 'opus' }; }) + makeDiff('roles/jyoshi.md', '既にある\n', '情シス\n'),
    },
  });
  assert.match(checkProposal(create, ctx).reason, /edit できません \(許すのは create\)/);
  // 対象が実在していれば create の diff でも通さない
  const exists = ctxWith({ files: { ...FILES, 'roles/jyoshi.md': '既にある\n' } });
  assert.match(checkProposal({
    ...create,
    change: {
      touch: [POLICY_FILE, 'roles/jyoshi.md'],
      diff: policyDiff((p) => { p.bots.jyoshi = { model: 'opus' }; }) + makeDiff('roles/jyoshi.md', null, '情シス\n'),
    },
  }, exists).reason, /既にあります/);
});

test('予約対象は class と無関係にパスで縛る', () => {
  const ctx = ctxWith();
  const reason = (input) => checkProposal(input, ctx).reason;
  // work class から roles/** を触れない (CEO ゲートの迂回)
  assert.match(reason(roleEdit({
    kind: 'check-add',
    targets: [{ path: 'roles/sol.md' }],
    change: { touch: ['roles/sol.md'], diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], 'x\n') },
  })), /roles\/\*\* は check-add からは触れません/);
  // allowlist 外の文書は governance-edit だけ
  assert.match(reason(roleEdit({
    kind: 'work-item',
    targets: [{ path: 'docs/social-engineering.md' }],
    change: { touch: ['docs/social-engineering.md'], diff: makeDiff('docs/social-engineering.md', FILES['docs/social-engineering.md'], 'x\n') },
  })), /governance-edit だけが対象にできます/);
  // secrets はどの kind からも対象にできない
  assert.match(reason(roleEdit({
    kind: 'work-item',
    targets: [{ path: SECRETS_FILE }],
    change: { touch: [SECRETS_FILE], diff: makeDiff(SECRETS_FILE, null, '{}\n') },
  })), /どの提案の対象にもできません/);
});

test('diff の実変更を targets[] と突き合わせる', () => {
  const ctx = ctxWith();
  const policyEdit = (targets, mutate) => checkProposal(roleEdit({
    kind: 'policy-edit',
    targets,
    change: { touch: [POLICY_FILE], diff: policyDiff(mutate) },
  }), ctx);

  // edit は target の子孫または同一
  assert.equal(policyEdit([{ pointer: '/limits', op: 'edit' }], (p) => { p.limits.maxBotHops = 5; }).ok, true);
  // target に無い pointer まで変えている
  assert.match(policyEdit([{ pointer: '/limits', op: 'edit' }], (p) => {
    p.limits.maxBotHops = 5;
    p.claudeBin = 'evil';
  }).reason, /targets\[\] と食い違う変更です/);
  // add は追加された key そのものが target と完全一致
  assert.equal(policyEdit([{ pointer: '/limits/maxSelfHops', op: 'add' }], (p) => { p.limits.maxSelfHops = 12; }).ok, true);
  assert.match(policyEdit([{ pointer: '/limits/maxSelfHops', op: 'add' }], (p) => { p.limits.maxBotHops = 5; }).reason, /食い違う変更|対応する変更が diff にありません/);
  // edit と申告して対象そのものを消すことはできない
  assert.match(policyEdit([{ pointer: '/limits', op: 'edit' }], (p) => { delete p.limits; }).reason, /食い違う変更/);
  // 余分な target を宣言して subject だけ占有することはできない
  assert.match(policyEdit(
    [{ pointer: '/limits', op: 'edit' }, { pointer: '/claudeBin', op: 'edit' }],
    (p) => { p.limits.maxBotHops = 5; },
  ).reason, /対応する変更が diff にありません/);
  // pointer を持たない target でも同じ (task を並べて競合枠だけ取れない)
  const withTask = ctxWith({ tasks: [{ id: '7', touch: ['test/y.test.js'] }] });
  assert.match(checkProposal(roleEdit({
    kind: 'work-item',
    targets: [{ taskId: '7' }, { path: 'test/x.test.js' }],
    change: { touch: ['test/x.test.js'], diff: makeDiff('test/x.test.js', null, 'assert.ok(true);\n') },
  }), withTask).reason, /target \(task:7\) に対応する変更が diff にありません/);
  // 触っているのに中身が変わらない diff は通さない
  assert.match(checkProposal(roleEdit({
    kind: 'policy-edit',
    targets: [{ pointer: '/limits', op: 'edit' }],
    change: { touch: [POLICY_FILE], diff: makeDiff(POLICY_FILE, FILES[POLICY_FILE], FILES[POLICY_FILE].replace('"claudeBin"', '"claudeBin" ')) },
  }), ctx).reason, /JSON として読めません|変更がありません/);
});

test('tool-grant は membership 差分と解決済み権限の変化まで見る', () => {
  const ctx = ctxWith();
  const grant = (target, mutate) => checkProposal(roleEdit({
    kind: 'tool-grant',
    targets: [target],
    change: { touch: [POLICY_FILE], diff: policyDiff(mutate) },
  }), ctx);

  assert.equal(grant({ channel: 'observatory', tool: 'Edit', op: 'add' }, (p) => {
    p.channels.observatory.toolsExtra.push('Edit');
  }).ok, true);
  // preset に含まれるツールは toolsExtra から消しても残る = 採択しても権限が変わらない
  assert.match(grant({ channel: 'observatory', tool: 'WebSearch', op: 'remove' }, (p) => {
    p.channels.observatory.toolsExtra = ['Write'];
  }).reason, /preset に含まれるツールです/);
  // 申告と違うツールを足す diff は通さない
  assert.match(grant({ channel: 'observatory', tool: 'Edit', op: 'add' }, (p) => {
    p.channels.observatory.toolsExtra.push('Bash');
  }).reason, /差分が target/);
  // allowedTools 直書きのチャンネルは policy-edit へ回す
  assert.match(grant({ channel: 'locked', tool: 'Edit', op: 'add' }, (p) => {
    p.channels.locked.toolsExtra = ['Edit'];
  }).reason, /allowedTools を直書き/);

  // 同じチャンネルへ 2 ツールを一括で足すのは正当 (channel ごとに集合で照合する)
  const twoTools = checkProposal(roleEdit({
    kind: 'tool-grant',
    targets: [
      { channel: 'observatory', tool: 'Edit', op: 'add' },
      { channel: 'observatory', tool: 'Bash', op: 'add' },
    ],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.channels.observatory.toolsExtra.push('Edit', 'Bash'); }) },
  }), ctx);
  assert.equal(twoTools.ok, true, twoTools.reason);
  assert.deepEqual(twoTools.subjectKeys, ['tool:observatory/Bash', 'tool:observatory/Edit']);

  // 申告した 2 件のうち 1 件しか足さない diff は通さない
  assert.match(checkProposal(roleEdit({
    kind: 'tool-grant',
    targets: [
      { channel: 'observatory', tool: 'Edit', op: 'add' },
      { channel: 'observatory', tool: 'Bash', op: 'add' },
    ],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.channels.observatory.toolsExtra.push('Edit'); }) },
  }), ctx).reason, /targets\[\] と一致しません/);
});

test('op は申告であると同時に制約になる', () => {
  const ctx = ctxWith();
  const reason = (input) => {
    const checked = checkProposal(input, ctx);
    assert.equal(checked.ok, false, '通してはいけない');
    return checked.reason;
  };
  // role-retire は policy 上の bot が実際に消えるまで通さない
  assert.match(reason(roleEdit({
    kind: 'role-retire',
    targets: [{ botKey: 'sol' }],
    change: {
      touch: [POLICY_FILE, 'roles/sol.md'],
      diff: policyDiff((p) => { p.bots.sol.model = 'opus'; }) + makeDiff('roles/sol.md', FILES['roles/sol.md'], null),
    },
  })), /食い違う変更|対応する変更が diff にありません/);
  // staffing op:edit で bot を消すことはできない (消すなら op:remove の提案として出す)
  assert.match(reason(roleEdit({
    kind: 'staffing',
    targets: [{ botKey: 'sol', op: 'edit' }],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { delete p.bots.sol; }) },
  })), /食い違う変更/);
  // tool-grant に edit は無い (配列の要素は出し入れだけ)
  assert.match(reason(roleEdit({
    kind: 'tool-grant',
    targets: [{ channel: 'observatory', tool: 'Write', op: 'edit' }],
    change: { touch: [POLICY_FILE], diff: policyDiff((p) => { p.channels.observatory.toolsExtra = ['WebSearch']; }) },
  })), /op は add か remove だけ/);

  // 正しい向きの role-retire は通る
  assert.equal(checkProposal(roleEdit({
    kind: 'role-retire',
    targets: [{ botKey: 'solaris' }],
    change: {
      touch: [POLICY_FILE, 'roles/solaris.md'],
      diff: policyDiff((p) => { delete p.bots.solaris; }) + makeDiff('roles/solaris.md', FILES['roles/solaris.md'], null),
    },
  }), ctx).ok, true);
});

test('diff は全ファイルへ実際に当ててみる', () => {
  const ctx = ctxWith();
  // 旧内容が現物と違う diff (policy 以外も当てて確かめる)
  const wrongBase = checkProposal(roleEdit({
    kind: 'governance-edit',
    targets: [{ doc: 'docs/social-engineering.md' }],
    change: {
      touch: ['docs/social-engineering.md'],
      diff: makeDiff('docs/social-engineering.md', '別の内容\n', '設計 (改)\n'),
    },
  }), ctx);
  assert.equal(wrongBase.ok, false);
  assert.match(wrongBase.reason, /前提と違います/);

  // 文脈だけで実変更が無い diff は「対象を触った」ことにしない
  const noop = checkProposal(roleEdit({
    kind: 'governance-edit',
    targets: [{ doc: 'docs/social-engineering.md' }],
    change: {
      touch: ['docs/social-engineering.md'],
      diff: 'diff --git a/docs/social-engineering.md b/docs/social-engineering.md\n'
        + '--- a/docs/social-engineering.md\n+++ b/docs/social-engineering.md\n@@ -1,1 +1,1 @@\n 設計\n',
    },
  }), ctx);
  assert.equal(noop.ok, false);
  assert.match(noop.reason, /実際の変更がありません/);
});

test('createRepoContext は大小文字別名を実体で捕まえる', () => {
  const root = mkdtempSync(join(tmpdir(), 'communitd-repo-'));
  mkdirSync(join(root, 'roles'));
  writeFileSync(join(root, POLICY_FILE), policyText());
  writeFileSync(join(root, 'roles', 'sol.md'), FILES['roles/sol.md']);
  const withSecrets = createRepoContext({ cwd: root, policy: POLICY, openTasks: [] });

  const alias = (path) => checkProposal(roleEdit({
    kind: 'work-item',
    targets: [{ path }],
    change: { touch: [path], diff: makeDiff(path, null, '{}\n') },
  }), withSecrets);

  // 秘密ファイルがまだ無い環境でも、文字列側のゲートで落ちる
  assert.match(alias('CONFIG.SECRETS.JSON').reason, /どの提案の対象にもできません/);

  // 実ファイルがあれば、resolver が別名として捕まえる (work-item の create を装えない)
  writeFileSync(join(root, SECRETS_FILE), '{}\n');
  assert.match(alias('CONFIG.SECRETS.JSON').reason, /どの提案の対象にもできません/);
  const policyAlias = checkProposal(roleEdit({
    kind: 'policy-edit',
    targets: [{ pointer: '/limits/maxBotHops', op: 'edit' }],
    change: { touch: ['CONFIG.POLICY.JSON'], diff: policyDiff((p) => { p.limits.maxBotHops = 5; }).replaceAll(POLICY_FILE, 'CONFIG.POLICY.JSON') },
  }), withSecrets);
  assert.equal(policyAlias.ok, false);
  assert.match(policyAlias.reason, /大小文字だけが違う名前/);

  // 正規形なら実リポジトリ相手でも通る
  assert.equal(checkProposal(roleEdit(), withSecrets).ok, true);
});

test('changedPointers は配列を丸ごと 1 件として出す', () => {
  assert.deepEqual(changedPointers({ a: [1, 2], b: 1 }, { a: [1, 3], b: 1 }), [{ op: 'replace', path: '/a' }]);
  assert.deepEqual(changedPointers({ a: 1 }, { a: 1, b: 2 }), [{ op: 'add', path: '/b' }]);
  assert.deepEqual(changedPointers({ a: 1, b: 2 }, { a: 1 }), [{ op: 'remove', path: '/b' }]);
  assert.deepEqual(parsePointer('/a~1b/c~0d'), { ok: true, segments: ['a/b', 'c~d'] });
  assert.equal(formatPointer(['a/b', 'c~d']), '/a~1b/c~0d');
  assert.deepEqual(parsePointer('/'), { ok: true, segments: [] });
});

// ---- 裁定 ----

test('org は So の owner interaction だけが裁定できる', () => {
  const org = { class: 'org' };
  const process = { class: 'process' };
  assert.equal(canAdjudicate(org, OWNER, AUTHORITY), true);
  assert.equal(canAdjudicate(org, { kind: 'owner', userId: 'someone-else' }, AUTHORITY), false);
  assert.equal(canAdjudicate(org, { kind: 'bot', botKey: 'fable' }, AUTHORITY), false);
  // ownerUserId が渡らなければ誰も裁定できない (fail-closed)
  assert.equal(canAdjudicate(org, OWNER, { execBotKeys: ['fable'] }), false);
  // work / process は経営裁量 (Fable)
  assert.equal(canAdjudicate(process, { kind: 'bot', botKey: 'fable' }, AUTHORITY), true);
  assert.equal(canAdjudicate(process, { kind: 'bot', botKey: 'opus' }, AUTHORITY), false);
  assert.equal(canAdjudicate(process, OWNER, AUTHORITY), true);
});

test('裁定は状態機械と権限の両方を通る', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });

  // raised からは直接裁定できない (raised → deliberating → adjudicated)
  assert.throws(() => s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, ...AUTHORITY }), /進めません/);
  s.deliberate(p.id, { now: T0 });
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'accepted', actor: { kind: 'bot', botKey: 'fable' }, ctx, now: T0, ...AUTHORITY,
  }), /裁定権がありません/);

  const done = s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '妥当', baseCommit: BASE_OID, ...AUTHORITY });
  assert.equal(done.state, 'adjudicated');
  assert.equal(done.decision, 'accepted');
  assert.equal(done.adjudication.revision, 1);
  assert.equal(done.revisions.length, 1);
  assert.equal(done.adjudication.digest, done.revisions[0].digest);
});

test('裁定は ID でなく「裁定した内容」に束縛する', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  // 承認後に入力側を書き換える (列挙から漏れやすい evidence を狙う)
  const tampered = s.get(p.id);
  tampered.input = { ...tampered.input, evidence: ['ねつ造した根拠'] };
  s.write(p.id, tampered);

  const revalidated = s.revalidate(p.id, ctx, { now: T0 });
  assert.equal(revalidated.ok, false);
  assert.equal(revalidated.action, 'deliberating');
  assert.equal(s.get(p.id).state, 'deliberating');
});

test('裁定の前提とした対象ファイルが動いたら再裁定へ戻す', () => {
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  const drifted = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (誰かが直した)\n' } });
  const revalidated = s.revalidate(p.id, drifted, { now: T0 });
  assert.equal(revalidated.ok, false);
  assert.equal(revalidated.action, 'deliberating');
});

test('allowlist から対象が外れた process-edit は withdrawn (class が変わる)', () => {
  const ctx = ctxWith();
  const s = store();
  const input = roleEdit({
    kind: 'process-edit',
    targets: [{ doc: 'docs/handbook.md' }],
    change: { touch: ['docs/handbook.md'], diff: makeDiff('docs/handbook.md', FILES['docs/handbook.md'], '手順 (改)\n') },
  });
  const p = accepted(s, input, ctx, { actor: { kind: 'bot', botKey: 'fable' } });
  assert.equal(p.class, 'process');

  const narrowed = ctxWith({ allowlist: [] });
  const revalidated = s.revalidate(p.id, narrowed, { now: T0 });
  assert.equal(revalidated.action, 'withdrawn');
  assert.equal(s.get(p.id).state, 'withdrawn');
  // 終端なので、そこからは動かない
  assert.throws(() => s.deliberate(p.id, { now: T0 }), /終端/);
});

test('deliberating へ戻した提案は再裁定できる (旧 adjudication は履歴として扱う)', () => {
  // `#divert` は監査のため裁定記録を残す。戻した後もその digest を照合すると、
  // 「裁定時と食い違っているから戻した」提案が二度と裁定できない — §3.9 の
  // 「deliberating へ戻して再裁定」が実機で 1 件も通らなかった原因 (So 裁定 2026-09-04)
  const ctx = ctxWith();
  const s = store();
  const p = accepted(s, roleEdit(), ctx);

  // 対象ファイルが動いて再裁定へ戻る (ここまでは従来どおり)
  const drifted = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (誰かが直した)\n' } });
  assert.equal(s.revalidate(p.id, drifted, { now: T0 }).action, 'deliberating');
  assert.equal(s.get(p.id).state, 'deliberating');
  assert.equal(s.get(p.id).decision, null);
  assert.ok(s.get(p.id).adjudication, '裁定記録は監査のために残る (前提)');

  // 手で戻して審議し直す。**意見が付くので digest は裁定時と必ず違う** — これが前提
  s.addPosition(p.id, { by: 'sol', stance: 'second', rationale: '戻したので通してよい', now: T0 });
  assert.notEqual(
    digestOf(s.get(p.id), ctx, { baseCommit: BASE_OID }),
    s.get(p.id).adjudication.digest,
    '旧裁定と同じ digest では、この test が守りたいものを見ていない',
  );

  const again = s.adjudicate(p.id, {
    decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '再裁定', baseCommit: BASE_OID, ...AUTHORITY,
  });
  assert.equal(again.state, 'adjudicated');
  assert.equal(again.decision, 'accepted');
  // 再裁定は新しい revision として残る (前の裁定を上書きしない)
  assert.equal(again.revisions.length, 2);
  assert.equal(again.adjudication.revision, 2);

  // **生きている裁定では従来どおり照合する** — 戻す判断そのものはここから出る
  const listed = ctxWith({ allowlist: ['docs/handbook.md', 'docs/後から載せた.md'] });
  assert.equal(s.revalidate(p.id, listed, { now: T0 }).action, 'deliberating');
});

test('却下は再検証を通さない (当たらなくなった diff でも閉じられる)', () => {
  // 再検証が見るのは「この diff がいまも当たるか」。却下は終端で何も当てないので、
  // ここで止めると**採択も却下もできない提案**が deliberating に残る (実機 2026-09-04)
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });

  // 中身を手で転記した後の世界 — 同じ diff は二度当たらない
  const applied = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (改)\n' } });
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'accepted', actor: OWNER, ctx: applied, now: T0, baseCommit: BASE_OID, ...AUTHORITY,
  }), /裁定できません/);
  assert.equal(s.get(p.id).state, 'deliberating', '採択に失敗したのに状態が動いている');

  const rejected = s.adjudicate(p.id, {
    decision: 'rejected', actor: OWNER, ctx: applied, now: T0, rationale: '手で転記済み', ...AUTHORITY,
  });
  assert.equal(rejected.state, 'adjudicated');
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.adjudication.rationale, '手で転記済み');
  // 却下は終端なので、そこからは動かない (理由の必須も従来どおり効く)
  assert.equal(isTerminal(rejected), true);
});

test('再検証は基点の検査より先 (行き先が決まる提案を足止めしない)', () => {
  // 基点の検査を先に置くと、allowlist から外れて本来 withdrawn にすべき提案が
  // 「基点が無い」で止まり、行き先が決まらないまま deliberating に残る (Sol 指摘 2026-08-31)
  const ctx = ctxWith();
  const s = store();
  const input = roleEdit({
    kind: 'process-edit',
    targets: [{ doc: 'docs/handbook.md' }],
    change: { touch: ['docs/handbook.md'], diff: makeDiff('docs/handbook.md', FILES['docs/handbook.md'], '手順 (改)\n') },
  });
  const p = s.raise(input, { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });

  const narrowed = ctxWith({ allowlist: [] });
  assert.throws(() => s.adjudicate(p.id, {
    // 基点は渡さない (適用回路が未設定の配備と同じ状況)
    decision: 'accepted', actor: { kind: 'bot', botKey: 'fable' }, ctx: narrowed, now: T0, rationale: 'ok', ...AUTHORITY,
  }), /processEditAllowlist から対象が外れました/);
  assert.equal(s.get(p.id).state, 'withdrawn');
});

// ---- 意見・試用・タスク ----

test('賛同と反論は同時に残り、意見が付いた提案は審議中になる', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s.addPosition(p.id, { by: 'fable', stance: 'second', rationale: '賛成', now: T0 });
  const after = s.addPosition(p.id, { by: 'sol', stance: 'contest', rationale: '反対', now: T0 });

  assert.equal(after.state, 'deliberating');
  assert.deepEqual(after.positions.map((x) => [x.by, x.stance]), [['fable', 'second'], ['sol', 'contest']]);
  assert.throws(() => s.addPosition(p.id, { by: 'sol', stance: 'maybe' }), /stance/);
  assert.throws(() => s.addPosition(p.id, { stance: 'second' }), /by は必須/);
});

test('試用の期限切れは scheduler が拾えるように列挙できる', () => {
  const s = store();
  const p = accepted(s, roleEdit(), ctxWith());
  // **試用は適用の後** (§3.9)。適用回路そのものは test/apply.test.js が見るので、
  // ここは「当てて merge した」前提だけを作る
  const applying = ctxWith({ tasks: [{ id: '7', state: 'approved', touch: ['roles/sol.md'] }] });
  s.linkTask(p.id, '7', { ctx: applying, now: T0, apply: true });
  s.recordReceipt(p.id, makeReceipt({
    proposalId: p.id,
    revision: 1,
    digest: p.adjudication.digest,
    baseCommit: BASE_OID,
    appliedCommit: 'b'.repeat(40),
    appliedTree: 'c'.repeat(40),
    diffDigest: diffDigestOf(roleEdit().change.diff),
    verify: { ok: true },
  }), { now: T0 });

  const ctx = ctxWith({ tasks: [{ id: '7', state: 'merged', touch: ['roles/sol.md'] }] });
  const inTrial = s.startTrial(p.id, { ctx, now: T0 });
  assert.equal(inTrial.state, 'trial');
  assert.equal(inTrial.trial.deadline, '2026-09-30T00:00:00.000Z');

  assert.deepEqual(s.dueTrials(Date.parse('2026-09-01T00:00:00.000Z')), []);
  assert.deepEqual(s.dueTrials(Date.parse('2026-10-01T00:00:00.000Z')).map((x) => x.id), [p.id]);

  const measured = s.measure(p.id, { outcome: 'effective', ctx, now: T0 });
  assert.equal(measured.state, 'measured');
  assert.equal(measured.outcome, 'effective');
  assert.throws(() => s.measure(p.id, { outcome: 'reverted', ctx }), /measured なので/);
});

test('公開 API から class を書き換えられない (CEO ゲートを迂回させない)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  assert.equal(p.class, 'org');

  // 遷移に相乗りして class を偽れない
  s.deliberate(p.id, { now: T0, by: 'opus', patch: { class: 'work' } });
  assert.equal(s.get(p.id).class, 'org');
  assert.equal(s.get(p.id).state, 'deliberating');

  // なので Fable は org を裁定できないまま
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'accepted', actor: { kind: 'bot', botKey: 'fable' }, ctx, now: T0, ...AUTHORITY,
  }), /裁定権がありません/);

  // 同一性を決める他のフィールドも動かない
  const s2 = store();
  const q = s2.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s2.deliberate(q.id, { now: T0, patch: { subjectKeys: ['role:opus'], input: null, raisedBy: 'fable' } });
  assert.deepEqual(s2.get(q.id).subjectKeys, q.subjectKeys);
  assert.deepEqual(s2.get(q.id).input, q.input);
  assert.equal(s2.get(q.id).raisedBy, 'opus');
});

test('返り値を書き換えても内部の提案は動かない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });

  // raise / get / list のどれから受け取った値も、内部値と同じ参照ではない
  assert.notEqual(p, s.get(p.id));
  p.class = 'work';
  p.subjectKeys.push('role:opus');
  const got = s.get(p.id);
  got.class = 'work';
  got.input.kind = 'check-add';
  const listed = s.list()[0];
  listed.class = 'work';

  const stored = s.get(p.id);
  assert.equal(stored.class, 'org');
  assert.equal(stored.input.kind, 'role-edit');
  assert.deepEqual(stored.subjectKeys, ['role:sol']);

  // 書き換えた気になっていても、Fable は org を裁定できない
  s.deliberate(p.id, { now: T0 });
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'accepted', actor: { kind: 'bot', botKey: 'fable' }, ctx, now: T0, ...AUTHORITY,
  }), /裁定権がありません/);
});

test('保存済みの class が kind と食い違う提案は動かせない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  // 手編集やファイル差し替えで class だけ軽くされた状態を作る
  s.write(p.id, { ...s.get(p.id), class: 'work' });

  assert.throws(() => s.deliberate(p.id, { now: T0 }), /導かれる値と違います/);
  assert.throws(() => s.addPosition(p.id, { by: 'fable', stance: 'second' }), /導かれる値と違います/);
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'accepted', actor: { kind: 'bot', botKey: 'fable' }, ctx, now: T0, ...AUTHORITY,
  }), /導かれる値と違います/);
});

test('汎用の遷移 API は外へ出さない (class 別の道筋を素通りさせない)', () => {
  const s = store();
  assert.equal(s.transition, undefined);
  assert.deepEqual(
    ['deliberate', 'adjudicate', 'startTrial', 'measure', 'withdraw', 'linkTask', 'addPosition',
      'recordReceipt', 'failApply']
      .filter((name) => typeof s[name] !== 'function'),
    [],
  );
});

test('class ごとに完了までの道筋が違う', () => {
  const ctx = ctxWith();
  const s = store();
  // org は試用を挟まないと measured へ行けない
  const org = accepted(s, roleEdit(), ctx);
  assert.throws(() => s.measure(org.id, { outcome: 'effective', ctx, now: T0 }), /adjudicated なので/);

  // work は試用を挟まず、task 化してからでないと measured へ行けない
  const s2 = store();
  const work = accepted(s2, roleEdit({
    kind: 'check-add',
    targets: [{ path: 'test/x.test.js' }],
    change: { touch: ['test/x.test.js'], diff: makeDiff('test/x.test.js', null, 'assert.ok(true);\n') },
  }), ctx, { actor: { kind: 'bot', botKey: 'fable' } });
  assert.equal(work.class, 'work');
  assert.throws(() => s2.startTrial(work.id, { now: T0 }), /work なので試用を挟みません/);
  assert.throws(() => s2.measure(work.id, { outcome: 'effective', ctx, now: T0 }), /task 化されていません/);

  // 走っている task を結び、**それが merged になるまで** measured へ行けない
  const running = ctxWith({ tasks: [{ id: '12', state: 'in-progress', touch: ['test/x.test.js'] }] });
  s2.linkTask(work.id, '12', { ctx: running, now: T0 });
  assert.throws(() => s2.measure(work.id, { outcome: 'effective', ctx: running, now: T0 }), /in-progress なのでまだ/);
  const dropped = ctxWith({ tasks: [{ id: '12', state: 'dropped', touch: ['test/x.test.js'] }] });
  assert.throws(() => s2.measure(work.id, { outcome: 'effective', ctx: dropped, now: T0 }), /1 件も merged/);
  const merged = ctxWith({ tasks: [{ id: '12', state: 'merged', touch: ['test/x.test.js'] }] });
  assert.equal(s2.measure(work.id, { outcome: 'effective', ctx: merged, now: T0 }).state, 'measured');
});

test('結ぶ task は実在し、提案の範囲を触るものに限る', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  assert.throws(() => s.linkTask(p.id, '12', { ctx, now: T0 }), /raised なので/);
  s.deliberate(p.id, { now: T0 });
  s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '妥当', baseCommit: BASE_OID, ...AUTHORITY });

  // 実在しない id・終端の task・touch 不明の task・範囲外の touch はどれも結べない
  assert.throws(() => s.linkTask(p.id, 'not-a-real-task', { ctx, now: T0 }), /ボードにありません/);
  const done = ctxWith({ tasks: [{ id: '12', state: 'merged', touch: ['roles/sol.md'] }] });
  assert.throws(() => s.linkTask(p.id, '12', { ctx: done, now: T0 }), /merged なので結べません/);
  const noTouch = ctxWith({ tasks: [{ id: '12', state: 'approved', touch: null }] });
  assert.throws(() => s.linkTask(p.id, '12', { ctx: noTouch, now: T0 }), /touch がありません/);
  const outside = ctxWith({ tasks: [{ id: '12', state: 'approved', touch: ['roles/sol.md', 'src/index.js'] }] });
  assert.throws(() => s.linkTask(p.id, '12', { ctx: outside, now: T0 }), /範囲外です: src\/index\.js/);

  const inScope = ctxWith({ tasks: [{ id: '12', state: 'approved', touch: ['roles/sol.md'] }] });
  assert.deepEqual(s.linkTask(p.id, '12', { ctx: inScope, now: T0 }).taskIds, ['12']);

  // 裁定の前提が動いた提案は task 化できない (古い accepted を根拠にさせない)
  const drifted = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (誰かが直した)\n' } });
  assert.throws(() => s.linkTask(p.id, '13', { ctx: drifted, now: T0 }), /task 化できません/);
  assert.equal(s.get(p.id).state, 'deliberating');
  assert.equal(s.get(p.id).decision, null); // 戻したら採択も落ちる
});

test('rejected は終端で、open な集合からも外れる', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });
  s.adjudicate(p.id, { decision: 'rejected', actor: OWNER, ctx, now: T0, rationale: '見送り', ...AUTHORITY });
  assert.deepEqual(s.openList(), []);
  // 同じ subject へ出し直せる
  assert.equal(s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 }).id, '2');
});

test('保存はディスクへ落ち、読み直しても同じ提案が読める', () => {
  const ctx = ctxWith();
  const path = join(mkdtempSync(join(tmpdir(), 'communitd-prop-')), 'proposals.json');
  const s = new ProposalStore(path);
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  const reopened = new ProposalStore(path).get(p.id);
  assert.equal(reopened.raisedBy, 'opus');
  assert.equal(reopened.ownerBotKey, 'opus'); // 追跡責任者の既定は起票者
  assert.deepEqual(reopened.subjectKeys, ['role:sol']);
  assert.equal(reopened.state, 'raised');
});

test('snapshot は入力側を丸ごと持ち、外部状態の digest も含む', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  const snapshot = snapshotOf(s.get(p.id), ctx, { baseCommit: 'abc1234' });
  assert.deepEqual(Object.keys(snapshot).sort(), ['external', 'input', 'positions', 'subjectKeys']);
  assert.deepEqual(Object.keys(snapshot.input).sort(), Object.keys(roleEdit()).sort());
  assert.deepEqual(snapshot.external.processEditAllowlist, ['docs/handbook.md']);
  assert.equal(snapshot.external.baseCommit, 'abc1234');
  assert.equal(typeof snapshot.external.files['roles/sol.md'], 'string');

  // 同じ内容なら digest も同じ (キー順に依存しない)
  assert.equal(proposalDigest(snapshot), proposalDigest(snapshotOf(s.get(p.id), ctx, { baseCommit: 'abc1234' })));
  assert.notEqual(proposalDigest(snapshot), proposalDigest(snapshotOf(s.get(p.id), ctx)));
});

test('org の却下には理由が要る (UI ではなく store 側で強制)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });

  // 却下は終端なので、理由が残らないと同じ提案が再発議されて同じ議論を繰り返す
  for (const rationale of [undefined, '', '   ']) {
    assert.throws(
      () => s.adjudicate(p.id, { decision: 'rejected', actor: OWNER, ctx, now: T0, rationale, ...AUTHORITY }),
      /却下には理由が要ります/,
    );
  }
  assert.equal(s.get(p.id).state, 'deliberating');

  // 裁定権が無い相手には「理由さえ書けば通る」と読める応答を返さない
  assert.throws(() => s.adjudicate(p.id, {
    decision: 'rejected', actor: { kind: 'bot', botKey: 'fable' }, ctx, now: T0, ...AUTHORITY,
  }), /裁定権がありません/);

  const done = s.adjudicate(p.id, { decision: 'rejected', actor: OWNER, ctx, now: T0, rationale: '見送り', ...AUTHORITY });
  assert.equal(done.adjudication.rationale, '見送り');
});

test('採択は理由が無くても通る (So 裁定 2026-08-30 — 押した時点で確定させる)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(p.id, { now: T0 });

  // 採択は提案本文と diff が「何を承認したか」を既に残しているので、理由が無くても記録は欠けない
  const done = s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, baseCommit: BASE_OID, ...AUTHORITY });
  assert.equal(done.decision, 'accepted');
  assert.equal(done.adjudication.rationale, '');
  assert.equal(done.adjudication.by, `owner:${OWNER.userId}`);
});

test('発議元の位置を記録する (稟議カードの投稿先)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), {
    raisedBy: 'opus', ctx, now: T0, origin: { threadId: 'T1', channelId: 'C1' },
  });
  assert.deepEqual(p.origin, { channelId: 'C1', threadId: 'T1' });
  // 読めない値は持たない (推測してよそのスレッドへ出さない)
  assert.equal(s.raise(roleEdit({
    targets: [{ botKey: 'solaris' }],
    change: { touch: ['roles/solaris.md'], diff: makeDiff('roles/solaris.md', FILES['roles/solaris.md'], 'x\n') },
  }), { raisedBy: 'opus', ctx, now: T0, origin: { threadId: 42 } }).origin, null);
});

test('digestOf はいまの内容の指紋を返す (カードの束縛に使う)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  const before = digestOf(p, ctx);
  assert.equal(before, digestOf(s.get(p.id), ctx));
  // 対象ファイルが動けば指紋も変わる
  const drifted = ctxWith({ files: { ...FILES, 'roles/sol.md': 'sol の憲章 (誰かが直した)\n' } });
  assert.notEqual(before, digestOf(p, drifted));
});

test('裁定待ちだけを取り出せる (稟議通知とカード再掲の対象)', () => {
  const ctx = ctxWith();
  const s = store();
  const a = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  const b = s.raise(roleEdit({
    targets: [{ botKey: 'solaris' }],
    change: { touch: ['roles/solaris.md'], diff: makeDiff('roles/solaris.md', FILES['roles/solaris.md'], 'x\n') },
  }), { raisedBy: 'opus', ctx, now: T0 });
  s.deliberate(b.id, { now: T0 });

  assert.deepEqual(s.awaitingAdjudication().map((p) => p.id), [b.id]);
  assert.deepEqual(s.openList().map((p) => p.id), [a.id, b.id]);
});

test('deliberationCount は再審議の世代を数える (配送の勘定はこの単位で持つ)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  assert.equal(deliberationCount(p), 0, 'まだ裁定待ちへ入っていない');

  const waiting = s.deliberate(p.id, { now: T0 });
  assert.equal(deliberationCount(waiting), 1);

  // 裁定 → 前提が変わって差し戻し = 別の依頼なので世代が上がる
  s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '通す', baseCommit: BASE_OID, ...AUTHORITY });
  assert.equal(deliberationCount(s.get(p.id)), 1, '裁定しただけで世代が上がっている');
  s.deliberate(p.id, { now: T0, note: '前提が変わったので再裁定' });
  assert.equal(deliberationCount(s.get(p.id)), 2);

  // 壊れた値でも落ちない
  assert.equal(deliberationCount(null), 0);
  assert.equal(deliberationCount({ history: 'いろいろ' }), 0);
});

test('意見は digest に効き、裁定の後には足せない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = s.raise(roleEdit(), { raisedBy: 'opus', ctx, now: T0 });
  const before = digestOf(p, ctx);

  // 反論が付いたら digest が変わる = 反論前に出したカードは無効になる
  const contested = s.addPosition(p.id, { by: 'sol', stance: 'contest', rationale: '兼務で足りる', now: T0 });
  const after = digestOf(contested, ctx);
  assert.notEqual(before, after, '反論を足しても digest が変わっていない');
  assert.deepEqual(snapshotOf(contested, ctx).positions.map((x) => x.stance), ['contest']);

  // 裁定の後は意見を足せない (足せると採択が再裁定へ差し戻せてしまう)
  s.adjudicate(p.id, { decision: 'accepted', actor: OWNER, ctx, now: T0, rationale: '押し切る', baseCommit: BASE_OID, ...AUTHORITY });
  assert.throws(
    () => s.addPosition(p.id, { by: 'sol', stance: 'contest', rationale: '後出し', now: T0 }),
    /意見は裁定の前まで/,
  );
  // 裁定時の digest は据え置き (後から動かされない)。
  // 照合には**裁定時の基点**を渡す — snapshot は基点まで含めて固めている
  assert.equal(s.get(p.id).adjudication.digest, digestOf(s.get(p.id), ctx, { baseCommit: BASE_OID }));
});
