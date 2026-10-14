import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { TaskBoardStore, approvalNote } from '../src/board.js';
import {
  MAX_REVIEW_EVIDENCE_CHARS, REVIEW_EVIDENCE_NOTE_PREFIX,
  approvalItem, createBoardWiring, joinNote, reviewTarget, usesNodeTest,
} from '../src/bridge/board.js';
import { resolveAutonomy } from '../src/config.js';
import { readContractNonce } from '../src/contract.js';
import { HopTracker } from '../src/hops.js';
import { EVIDENCE_MAX_CHARS, formatReviewEvidence } from '../src/review-evidence.js';
import { parseMergeNote } from '../src/review-evidence-backtest.js';
import { SEND_BACK_JOB_BUDGET } from '../src/scheduler.js';
import { ContractStore, MAX_PENDING_CONTRACTS } from '../src/store.js';

// src/bridge/board.js — ボードを動かす配線: 起票 → 承認 → レビュー → 判定の適用。
// ボード・契約・hops・git は本物 (一時ディレクトリ)、Discord のスレッドだけ偽物。

function captureConsole(t) {
  const logs = [];
  const errors = [];
  const { log, error } = console;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  return { logs, errors };
}

function harness(t, {
  paused = false, reviewer = 'opus2', workers = ['opus'], withBoard = true, proposals = null,
  // レビューの証拠: 作業ツリーで走る task か・チャンネルの verify・測定の実体の差し替え
  worktree = false, verify = undefined, evidence = {},
} = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('git', ['init', '-q', '--initial-branch=master', repo], { windowsHide: true });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.py'), 'print(1)\n');
  git('add', 'a.py');
  git('commit', '-q', '-m', 'init');

  const cc = {
    // 作業ツリーのパスは実在しなくてよい (測定の実体は差し替える)
    channelName: 'kt', cwd: worktree ? join(dir, 'wt') : repo, repoRoot: repo,
    ...(verify === undefined ? {} : { verify }),
    // baseBranch は fixture の初期ブランチと揃える (merge の照合はここを見る — §12.3 (2))
    autonomy: {
      enabled: true, worker: { bots: workers }, reviewer, baseBranch: 'master',
      taskJobBudget: 20, scout: { maxOpenTasks: 6 },
    },
  };
  const thread = {
    id: 'T1',
    sent: [],
    fail: null,
    send: async (payload) => {
      if (thread.fail) throw new Error(thread.fail);
      thread.sent.push(payload);
      return { id: `m${thread.sent.length}` };
    },
  };
  const client = { channels: { cache: new Map([['T1', thread]]) } };
  const bots = new Map([
    ['opus', { key: 'opus', userId: 'O', cfg: { displayName: 'Opus' }, client }],
    ['opus2', { key: 'opus2', userId: 'O2', cfg: { displayName: 'Opus2' }, client }],
    ['fable', { key: 'fable', userId: 'F', cfg: { displayName: 'Fable' }, client }],
  ]);
  const board = withBoard ? new TaskBoardStore(join(dir, 'tasks.json')) : null;
  const contracts = new ContractStore(join(dir, 'contracts.json'));
  const hops = new HopTracker(12, 3);
  const overrides = new Map();
  const events = [];
  const releases = [];
  const wiring = createBoardWiring({
    root: repo,
    board,
    bots,
    contracts,
    hops,
    pauseStore: { paused },
    proposals,
    notifyDutyEvent: async (options) => { events.push(options); },
    setContractKindOverride: (threadId, botKey, kind) => overrides.set(`${threadId}:${botKey}`, kind),
    claimContractKindOverride: (threadId, botKey) => {
      const key = `${threadId}:${botKey}`;
      const kind = overrides.get(key) ?? null;
      overrides.delete(key);
      return kind;
    },
    contractCwd: (c) => c.repoRoot ?? c.cwd,
    channelConfigFor: () => cc,
    safeProposalContext: () => null,
    releaseApplyWorktree: async (task) => { releases.push(task.id); return '🧹 (偽の解放)'; },
    ...evidence,
  });
  const propose = (title = 'lint を直す', touch = ['a.py']) => board.propose({ channel: 'kt', title, rationale: '理由', touch, jobBudget: 20 }, { by: 'opus' });
  const started = () => {
    const task = propose();
    board.approve(task.id, { by: 'fable' });
    return board.start(task.id, { threadId: 'T1', by: 'scheduler' });
  };
  const inReview = () => {
    const task = started();
    return board.submitForReview(task.id, { by: 'opus' });
  };
  const bot = (key) => bots.get(key);
  // task ブランチに成果を 1 つ積んで base へ戻る (merge の照合を実物の git で試すため)
  const workOnBranch = (branch, file = 'b.py') => {
    git('checkout', '-q', '-b', branch);
    writeFileSync(join(repo, file), 'print(2)\n');
    git('add', file);
    git('commit', '-q', '-m', `work on ${branch}`);
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'master');
    return tip;
  };
  /** base へ --no-ff で取り込む (= レビュー担当がやる作業)。戻りはマージコミットの OID */
  const mergeBranch = (branch) => {
    git('merge', '--no-ff', '-q', '-m', `merge ${branch}`, branch);
    return git('rev-parse', 'HEAD');
  };
  return { ...io, dir, repo, git, cc, thread, bots, board, contracts, hops, overrides, events, releases, propose, started, inReview, bot, workOnBranch, mergeBranch, ...wiring };
}

test('joinNote / reviewTarget / approvalItem は純粋な整形', () => {
  assert.equal(joinNote('head', ''), 'head');
  assert.equal(joinNote('head', 'extra'), 'head\nextra');
  assert.deepEqual(reviewTarget({ id: 1, title: 't', branch: '', jobBudget: 4 }), { id: '1', title: 't', branch: 'task/1', job_budget: 4 });
  assert.deepEqual(reviewTarget({ id: '2', title: 't', branch: 'feat/x', jobBudget: 0 }), { id: '2', title: 't', branch: 'feat/x' });
  assert.deepEqual(approvalItem({ id: 3, title: 't', rationale: '  ', touch: [], jobBudget: 20 }), { id: '3', title: 't', job_budget: 20 });
});

test('requestApproval: 契約を保存 → 予算を 1 積む → 種別を被せる → 制御メンション の順で reviewer を召喚する', async (t) => {
  const h = harness(t);
  const filed = [h.propose('A'), h.propose('B', ['b.py'])];
  const note = await h.requestApproval({ filed, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  assert.equal(note, '📋 Opus2 に承認を依頼しました (承認されたものだけが着手されます)');

  const saved = h.contracts.list('T1', 'opus2');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'task-approval');
  assert.equal(saved[0].fromBotKey, 'opus', '投げ手で束縛していない');
  assert.equal(saved[0].cwd, h.repo);
  assert.deepEqual(saved[0].contract.pending.map((p) => p.id), ['1', '2']);
  assert.ok(Array.isArray(saved[0].contract.board), '重複を見つける参考欄が無い');
  assert.equal(saved[0].contract.board.some((row) => ['1', '2'].includes(String(row.id))), false, '今回の起票が参考欄に並んでいる');
  assert.equal(h.hops.taskBudget('T1'), 1);
  assert.equal(h.overrides.get('T1:opus2'), 'task-approval');
  assert.equal(h.thread.sent.length, 1);
  const [line, tag] = h.thread.sent[0].content.split('\n');
  assert.equal(line, '<@O2>');
  assert.equal(readContractNonce(tag), saved[0].nonce);
  assert.deepEqual(h.thread.sent[0].allowedMentions.users, ['O2']);
  assert.ok(h.logs.some((l) => l === '[scheduler] kt: 承認を opus2 へ依頼 (thread T1 / 2 件 / 投稿は opus)'), h.logs.join('\n'));
});

test('requestApproval: 停止中・reviewer 不在は召喚せず、投稿に失敗したら契約と種別を戻す', async (t) => {
  const paused = harness(t, { paused: true });
  const filed = [paused.propose()];
  assert.equal(
    await paused.requestApproval({ filed, cc: paused.cc, autonomy: paused.cc.autonomy, bot: paused.bot('opus'), thread: paused.thread }),
    '⏸ 自律運転が停止中のため承認を召喚していません — proposed のまま残ります (次の巡回の一覧には出ます)',
  );

  const down = harness(t);
  down.bot('opus2').userId = null;
  const filed2 = [down.propose()];
  assert.match(
    await down.requestApproval({ filed: filed2, cc: down.cc, autonomy: down.cc.autonomy, bot: down.bot('opus'), thread: down.thread }),
    /^⚠️ 承認担当 \(opus2\) が起動していないため承認を頼めません/,
  );
  assert.equal(down.contracts.list('T1', 'opus2').length, 0);

  const failing = harness(t);
  failing.thread.fail = 'Missing Permissions';
  const filed3 = [failing.propose()];
  assert.match(
    await failing.requestApproval({ filed: filed3, cc: failing.cc, autonomy: failing.cc.autonomy, bot: failing.bot('opus'), thread: failing.thread }),
    /^⚠️ 承認メンションの投稿に失敗しました \(Missing Permissions\)/,
  );
  assert.equal(failing.contracts.list('T1', 'opus2').length, 0, '起動しなかった契約が残っている');
  assert.equal(failing.overrides.has('T1:opus2'), false, '起動しなかった種別の上書きが残っている');
});

test('requestApproval: 宛先自身が呼ぶときは別の bot の client から投げ、その bot で束縛する', async (t) => {
  const h = harness(t);
  const filed = [h.propose()];
  const note = await h.requestApproval({ filed, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus2'), thread: h.thread });
  assert.match(note, /^📋 Opus2 に承認を依頼しました/);
  const [entry] = h.contracts.list('T1', 'opus2');
  assert.notEqual(entry.fromBotKey, 'opus2', '宛先自身で束縛している (永久に結ばれない)');
  assert.ok(['opus', 'fable'].includes(entry.fromBotKey));
});

const PROPOSED_STAYS = ' — proposed のまま残ります (次の巡回の一覧には出ます)';

test('requestApproval: 承認メンションを投げられる bot が居ないときは何も積まず proposed のまま返す', async (t) => {
  // 投げ手が要るのは**宛先自身が呼ぶとき**だけ (announcerFor) — 承認担当が起票した回
  const alone = harness(t);
  alone.bot('opus').userId = null;
  alone.bot('fable').userId = null;
  const filed = [alone.propose()];
  assert.equal(
    await alone.requestApproval({ filed, cc: alone.cc, autonomy: alone.cc.autonomy, bot: alone.bot('opus2'), thread: alone.thread }),
    `⚠️ 承認メンションを投げられる bot が居ません${PROPOSED_STAYS}`,
  );
  assertNothingQueued(alone, '他の bot が起動していない');
  assert.equal(alone.board.get('1').state, 'proposed');
  assert.ok(alone.errors.includes('[scheduler] kt: 承認メンションを投げられる bot が居ません'), alone.errors.join('\n'));

  // 投げ手は起動していても、その client からスレッドが見えなければ投げられない
  const unseen = harness(t);
  unseen.bot('opus').client.channels.cache.delete('T1');
  const filed2 = [unseen.propose()];
  assert.equal(
    await unseen.requestApproval({ filed: filed2, cc: unseen.cc, autonomy: unseen.cc.autonomy, bot: unseen.bot('opus2'), thread: unseen.thread }),
    `⚠️ 承認メンションを投げられる bot が居ません${PROPOSED_STAYS}`,
  );
  assertNothingQueued(unseen, 'スレッドが見えない');
});

test('requestApproval: 承認の契約を保存できない (未消費の上限で push が throw) ときは種別も予算も積まず proposed のまま返す', async (t) => {
  const h = harness(t);
  const filed = [h.propose()];
  const at = new Date().toISOString();
  for (let i = 0; i < MAX_PENDING_CONTRACTS; i += 1) {
    h.contracts.push('T1', 'opus2', { id: `queued-${i}`, nonce: `n${i}`, kind: 'delegation', at });
  }

  const note = await h.requestApproval({ filed, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  assert.match(note, /^⚠️ 承認の契約を保存できませんでした \(opus2 宛の未消費契約が上限 \(5 件\) に達しています/);
  assert.ok(note.endsWith(PROPOSED_STAYS), note);

  const queue = h.contracts.list('T1', 'opus2');
  assert.deepEqual(queue.map((e) => e.id), ['queued-0', 'queued-1', 'queued-2', 'queued-3', 'queued-4'], '先に積まれていた契約が動いた');
  assert.equal(queue.some((e) => e.kind === 'task-approval'), false, '承認の契約が残っている');
  assert.equal(h.overrides.has('T1:opus2'), false, '種別の上書きが残っている');
  assert.equal(h.hops.taskBudget('T1'), null, '保存できなかったのに予算を払い出している');
  assert.equal(h.thread.sent.length, 0, '保存できなかったのにメンションを投げている');
  assert.equal(h.board.get('1').state, 'proposed');
});

test('requestReview: worker の完了報告から reviewer を召喚し、自己レビューは断る', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  const sent = await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  assert.deepEqual(sent, { ok: true, note: '→ Opus2 にレビューをお願いしました' });
  const [entry] = h.contracts.list('T1', 'opus2');
  assert.equal(entry.kind, 'task-review');
  assert.deepEqual(entry.contract.target, [{ id: '1', title: 'lint を直す', branch: 'task/1', job_budget: 20 }]);
  assert.equal(h.hops.taskBudget('T1'), 1);
  assert.equal(h.overrides.get('T1:opus2'), 'task-review');

  const self = await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus2'), thread: h.thread });
  assert.equal(self.ok, false);
  assert.match(self.note, /実装した担当と reviewer が同じです \(自己レビューは禁止\)/);
  // 人間の出し直し (/review) は実装者ではないので門番を通さない
  const human = await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus2'), thread: h.thread, byWorker: false });
  assert.equal(human.ok, true);
});

const REVIEW_STAYS = ' — review のまま残ります (`/review` で出し直せます)';

/** 召喚しなかった回は何も積んでいない (契約・種別の上書き・予算・投稿) */
function assertNothingQueued(h, label) {
  assert.equal(h.contracts.list('T1', 'opus2').length, 0, `${label}: 契約が残っている`);
  assert.equal(h.overrides.has('T1:opus2'), false, `${label}: 種別の上書きが残っている`);
  assert.equal(h.hops.taskBudget('T1'), null, `${label}: 予算を払い出している`);
  assert.equal(h.thread.sent.length, 0, `${label}: メンションを投げている`);
}

test('requestReview: 停止中・reviewer 不在・呼べる bot が居ない・契約を束縛できないときは何も積まず review のまま返す', async (t) => {
  const paused = harness(t, { paused: true });
  assert.deepEqual(
    await paused.requestReview({ task: paused.inReview(), cc: paused.cc, autonomy: paused.cc.autonomy, bot: paused.bot('opus'), thread: paused.thread }),
    { ok: false, note: `⏸ 自律運転が停止中のためレビューを召喚していません${REVIEW_STAYS}` },
  );
  assertNothingQueued(paused, '停止中');

  const down = harness(t);
  down.bot('opus2').userId = null;
  assert.deepEqual(
    await down.requestReview({ task: down.inReview(), cc: down.cc, autonomy: down.cc.autonomy, bot: down.bot('opus'), thread: down.thread }),
    { ok: false, note: `⚠️ レビュー担当 (opus2) が起動していません${REVIEW_STAYS}` },
  );
  assertNothingQueued(down, 'reviewer が起動していない');
  assert.ok(down.errors.includes('[scheduler] kt: レビュー担当が起動していません (opus2)'), down.errors.join('\n'));

  const unset = harness(t, { reviewer: null });
  assert.deepEqual(
    await unset.requestReview({ task: unset.inReview(), cc: unset.cc, autonomy: unset.cc.autonomy, bot: unset.bot('opus'), thread: unset.thread }),
    { ok: false, note: `⚠️ レビュー担当 (未設定) が起動していません${REVIEW_STAYS}` },
  );
  assertNothingQueued(unset, 'reviewer が未設定');

  // 呼べる bot が居ないのは**宛先自身が呼ぶとき**だけ — worker の経路では自己レビュー禁止が
  // 先に断るので、ここへ来るのは /review (byWorker: false) を reviewer の bot で打った回
  const alone = harness(t);
  alone.bot('opus').userId = null;
  alone.bot('fable').userId = null;
  assert.deepEqual(
    await alone.requestReview({ task: alone.inReview(), cc: alone.cc, autonomy: alone.cc.autonomy, bot: alone.bot('opus2'), thread: alone.thread, byWorker: false }),
    { ok: false, note: `⚠️ レビューを呼べる bot が居ません${REVIEW_STAYS}` },
  );
  assertNothingQueued(alone, '他の bot が起動していない');

  // 投げ手は起動していても、その client からスレッドが見えなければ投げられない
  const unseen = harness(t);
  unseen.bot('opus').client.channels.cache.delete('T1');
  assert.deepEqual(
    await unseen.requestReview({ task: unseen.inReview(), cc: unseen.cc, autonomy: unseen.cc.autonomy, bot: unseen.bot('opus2'), thread: unseen.thread, byWorker: false }),
    { ok: false, note: `⚠️ レビューを呼べる bot が居ません${REVIEW_STAYS}` },
  );
  assertNothingQueued(unseen, 'スレッドが見えない');

  // 作業ディレクトリが空だと契約に結べない (bindContract が null)
  const unbound = harness(t);
  assert.deepEqual(
    await unbound.requestReview({ task: unbound.inReview(), cc: { ...unbound.cc, repoRoot: '' }, autonomy: unbound.cc.autonomy, bot: unbound.bot('opus'), thread: unbound.thread }),
    { ok: false, note: `⚠️ レビュー契約を束縛できませんでした${REVIEW_STAYS}` },
  );
  assertNothingQueued(unbound, '束縛できない');
});

test('requestReview: 契約を保存できない (未消費の上限で push が throw) ときは種別も予算も積まず review のまま返す', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  const at = new Date().toISOString();
  for (let i = 0; i < MAX_PENDING_CONTRACTS; i += 1) {
    h.contracts.push('T1', 'opus2', { id: `queued-${i}`, nonce: `n${i}`, kind: 'delegation', at });
  }

  const sent = await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  assert.equal(sent.ok, false);
  assert.match(sent.note, /^⚠️ レビュー契約を保存できませんでした \(opus2 宛の未消費契約が上限 \(5 件\) に達しています/);
  assert.ok(sent.note.endsWith(REVIEW_STAYS), sent.note);

  const queue = h.contracts.list('T1', 'opus2');
  assert.deepEqual(queue.map((e) => e.id), ['queued-0', 'queued-1', 'queued-2', 'queued-3', 'queued-4'], '先に積まれていた契約が動いた');
  assert.equal(queue.some((e) => e.kind === 'task-review'), false, 'レビュー契約が残っている');
  assert.equal(h.overrides.has('T1:opus2'), false, '種別の上書きが残っている');
  assert.equal(h.hops.taskBudget('T1'), null, '保存できなかったのに予算を払い出している');
  assert.equal(h.thread.sent.length, 0, '保存できなかったのにメンションを投げている');
});

test('requestReview: メンションの投稿に失敗したら、投稿前に積んだ契約と種別の上書きを巻き戻す', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  // 巻き戻すのは**今回積んだ 1 件だけ** — 同じ相手宛の他の未消費契約は巻き添えにしない
  h.contracts.push('T1', 'opus2', { id: 'other', nonce: 'n0', kind: 'delegation', at: new Date().toISOString() });
  h.thread.fail = 'Missing Permissions';

  assert.deepEqual(
    await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread }),
    { ok: false, note: `⚠️ レビューメンションの投稿に失敗しました (Missing Permissions)${REVIEW_STAYS}` },
  );
  assert.deepEqual(h.contracts.list('T1', 'opus2').map((e) => e.id), ['other'], '起動しなかったレビュー契約が残っている (か、他の契約まで消した)');
  assert.equal(h.overrides.has('T1:opus2'), false, '起動しなかった種別の上書きが残っている');
  assert.ok(h.errors.includes('[scheduler] kt: レビューメンションの投稿に失敗: Missing Permissions'), h.errors.join('\n'));
  assert.equal(h.board.get(task.id).state, 'review');
  // 予算 (hops.grantTaskBudget) は投稿失敗でも戻らない — 門の勘定なのでここでは断定しない
});

test('noteTaskCompletion: 担当のフッタ無し report だけがレビューへ進み、それ以外は理由つきで見送る', async (t) => {
  const h = harness(t);
  h.started();
  const base = { thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null, verifyResult: null };

  assert.deepEqual(
    await h.noteTaskCompletion({ ...base, bot: h.bot('opus'), mention: { kind: 'handoff', userId: 'F' } }),
    { submitted: false, summoned: false },
  );
  assert.equal(h.board.get('1').state, 'in-progress');

  assert.deepEqual(await h.noteTaskCompletion({ ...base, bot: h.bot('fable') }), { submitted: false, summoned: false });
  assert.equal(h.thread.sent.at(-1).content, '⚠️ 担当 (opus) 以外の報告なので完了とは数えません — 続きは担当をメンションしてください');
  assert.equal(h.board.get('1').state, 'in-progress');

  // **verify NG の担当外報告にも同じ 1 行を出す** (物差しを routed と揃える)。
  // 出さないと「なぜ完了に数えなかったのか」がスレッドに残らない (#46 の教訓)
  h.thread.sent.length = 0;
  assert.deepEqual(
    await h.noteTaskCompletion({ ...base, bot: h.bot('fable'), verifyResult: { ok: false, code: 1 } }),
    { submitted: false, summoned: false },
  );
  assert.match(h.thread.sent.at(-1).content, /以外の報告なので完了とは数えません/);

  assert.deepEqual(await h.noteTaskCompletion({ ...base, bot: h.bot('opus') }), { submitted: true, summoned: true });
  assert.equal(h.board.get('1').state, 'review');
  assert.equal(h.thread.sent.at(-1).content, '🔎 タスク #1 をレビューへ進めました\n→ Opus2 にレビューをお願いしました');
  assert.equal(h.contracts.list('T1', 'opus2').length, 1);

  const noBoard = harness(t, { withBoard: false });
  assert.deepEqual(
    await noBoard.noteTaskCompletion({ ...base, thread: noBoard.thread, cc: noBoard.cc, bot: noBoard.bot('opus') }),
    { submitted: false, summoned: false },
  );
});

test('noteTaskCompletion: board.submitForReview が throw したらレビューを呼ばず、何も積まない', async (t) => {
  const h = harness(t);
  h.started();
  h.board.submitForReview = () => { throw new Error('台帳を書けません'); };
  const base = { thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null, bot: h.bot('opus') };

  assert.deepEqual(await h.noteTaskCompletion({ ...base, verifyResult: null }), { submitted: false, summoned: false });
  // verify NG をレビューへ回す経路も同じ門を通る
  assert.deepEqual(
    await h.noteTaskCompletion({ ...base, verifyResult: { ok: false, code: 1, command: 'npm test', output: 'FAIL' }, route: 'review' }),
    { submitted: false, summoned: false },
  );

  assert.equal(h.board.get('1').state, 'in-progress');
  assertNothingQueued(h, 'レビューへ進められない');
  assert.equal(h.errors.filter((e) => e === '[scheduler] kt: タスク 1 をレビューへ進められません: 台帳を書けません').length, 2, h.errors.join('\n'));
});

// **P-2 (2026-09-18) で反転した。** verify NG の完了報告は「投げ手へ戻す」から
// 「レビューへ回す」へ (§12.3 (3) の (ii)、So 裁定)。壊れたものを次の実装へ流さない門は
// そのままで、直す番を決められる相手 (指摘を書ける役) へ渡す
test('noteTaskCompletion: verify NG でも通っていれば完了だった報告はレビューへ回す', async (t) => {
  const h = harness(t);
  h.started();
  const base = { thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null };
  const ng = { ok: false, code: 1, command: 'npm test', output: 'FAIL a.test.js' };

  assert.equal(h.taskVerifyRoute({ ...base, bot: h.bot('opus'), verifyResult: ng }), 'review');
  // **行き先を渡さなければ従来どおり** (配送前に「戻しを出さない」と決めた側が渡す。
  // 両方が別々に判断すると、片方だけ倒れたときに戻しと召喚の両方が起きる)
  assert.deepEqual(
    await h.noteTaskCompletion({ ...base, bot: h.bot('opus'), verifyResult: ng }),
    { submitted: false, summoned: false },
  );
  assert.equal(h.board.get('1').state, 'in-progress');

  assert.deepEqual(
    await h.noteTaskCompletion({ ...base, bot: h.bot('opus'), verifyResult: ng, route: 'review' }),
    { submitted: true, summoned: true },
  );
  assert.equal(h.board.get('1').state, 'review');
  assert.equal(
    h.thread.sent.at(-1).content,
    '🔎 タスク #1 を verify NG のままレビューへ回しました\n→ Opus2 にレビューをお願いしました',
  );
  // 落ちた検証はレビュー契約に載る (何が落ちたか分からないと指摘が書けない)
  const entry = h.contracts.list('T1', 'opus2').at(-1);
  assert.match(entry.contract.body, /verify が NG のままレビューへ回っています/);
  assert.match(entry.contract.body, /exit 1/);
  assert.match(entry.contract.body, /FAIL a\.test\.js/);
});

test('taskVerifyRoute: レビューへ回すのは「verify さえ通っていれば完了だった」報告だけ', async (t) => {
  const h = harness(t);
  h.started();
  const base = { thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null };

  // 途中報告・エスカレーション (フッタあり) と担当外の報告は従来どおり投げ手へ戻す
  assert.equal(h.taskVerifyRoute({ ...base, bot: h.bot('opus'), mention: { kind: 'handoff', userId: 'F' } }), null);
  assert.equal(h.taskVerifyRoute({ ...base, bot: h.bot('fable') }), null);
  assert.equal(h.taskVerifyRoute({ ...base, bot: h.bot('opus'), contractOut: { kind: 'delegation' } }), null);
  // 板の無いチャンネルでは判断しない
  const noBoard = harness(t, { withBoard: false });
  assert.equal(noBoard.taskVerifyRoute({ ...base, thread: noBoard.thread, cc: noBoard.cc, bot: noBoard.bot('opus') }), null);
});

// レビューの証拠 (src/review-evidence.js) をレビューへ進む回に測る。測定の実体は差し替える
const NODE_TEST_VERIFY = 'node --test --experimental-test-isolation=none test/*.test.js';
const EVIDENCE_HEAD = '\n\nレビューの証拠 (変更したテストを変更前の src でも走らせた結果 — 判定ではなく材料。'
  + '落ちないテストは src の変更を検査していない疑い):\n';
const SUBMITTED = '🔎 タスク #1 をレビューへ進めました\n→ Opus2 にレビューをお願いしました';

/** 測定の実体の偽物。呼ばれた引数を残して result を返す */
function fakeMeasure(result) {
  const calls = [];
  return { calls, measure: async (options) => { calls.push(options); return result; } };
}

/** 承認時の備考つきで着手まで進める */
function startedWithNote(h, note) {
  const task = h.propose();
  h.board.approve(task.id, { by: 'fable', note });
  return h.board.start(task.id, { threadId: 'T1', by: 'scheduler' });
}

const reviewNote = (h) => h.board.get('1').history.filter((entry) => entry.to === 'review').at(-1)?.note;
const reviewBody = (h) => h.contracts.list('T1', 'opus2').at(-1).contract.body;
const completion = (h, extra = {}) => h.noteTaskCompletion({
  thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null, bot: h.bot('opus'), verifyResult: null, ...extra,
});

test('usesNodeTest: 書かれた verify が node --test を走らせるときだけ測る (npm test の中身は追わない)', () => {
  for (const command of [NODE_TEST_VERIFY, 'node --test', 'node --enable-source-maps --test test/', 'npm ci && node --test']) {
    assert.equal(usesNodeTest(command), true, command);
  }
  for (const command of [null, '', 'npm test', 'npx vitest run', 'pytest -q', 'node --test-reporter=spec a.js', 'node scripts/x.js --test']) {
    assert.equal(usesNodeTest(command), false, String(command));
  }
});

test('noteTaskCompletion: 作業ツリーの task で verify が node --test なら、証拠を測って review の note とレビュー契約の本文に載せる', async (t) => {
  const fake = fakeMeasure({
    outcome: 'measured', base: 'master', mergeBase: 'abcdef0123456789',
    src: { added: [], restored: ['src/a.js'] }, tests: ['test/a.test.js', 'test/b.test.js'],
    runs: [{ file: 'test/a.test.js', verdict: 'fails' }, { file: 'test/b.test.js', verdict: 'passes' }],
    counts: { fails: 1, passes: 1, headFails: 0 },
  });
  const h = harness(t, { worktree: true, verify: NODE_TEST_VERIFY, evidence: { measureEvidence: fake.measure } });
  startedWithNote(h, '着手する人への備考: c.py は触らない');
  const ng = { ok: false, code: 1, command: NODE_TEST_VERIFY, output: 'FAIL a.test.js' };

  // verify NG のままレビューへ回す回も、レビューへ進む回なので測る
  assert.deepEqual(await completion(h, { verifyResult: ng, route: 'review' }), { submitted: true, summoned: true });
  // 測るのは task の作業ツリーで、基点はチャンネルの baseBranch
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].cwd, h.cc.cwd);
  assert.equal(fake.calls[0].base, 'master');

  const line = '変更前の src で落ちる 1 / 落ちない 1 / HEAD でも落ちる 0'
    + ' (変更したテスト 2 本・src の差分 1 ファイル・基点 abcdef0 (master))\n落ちない: test/b.test.js';
  assert.equal(reviewNote(h), `${REVIEW_EVIDENCE_NOTE_PREFIX}${line}`);
  // 並びは 落ちた検証 → 証拠 → 承認時の備考
  const body = reviewBody(h);
  const at = [body.indexOf('verify が NG のまま'), body.indexOf(`${EVIDENCE_HEAD}${line}`), body.indexOf('\n\n承認時の備考')];
  assert.ok(at.every((i) => i > 0) && at[0] < at[1] && at[1] < at[2], body);
  // スレッドに出る行は従来どおり (証拠は契約の本文と note だけ)
  assert.equal(h.thread.sent.at(-1).content, '🔎 タスク #1 を verify NG のままレビューへ回しました\n→ Opus2 にレビューをお願いしました');

  // `/review` の出し直し (自動復旧の呼び直しも同じ口) は測り直さず、review へ進めた回の note を読み直して載せる
  assert.equal((await h.reissueReview({ thread: h.thread, id: '1', bot: h.bot('fable') })).ok, true);
  assert.equal(fake.calls.length, 1);
  const measuredAt = h.board.get('1').history.findLast((entry) => entry.to === 'review').at;
  assert.ok(measuredAt, '測った回の時刻');
  assert.ok(
    reviewBody(h).includes(
      `${EVIDENCE_HEAD}${line}\n(${measuredAt} に review へ進めた回に測ったもの — その後の commit は反映していない)`,
    ),
    reviewBody(h),
  );
});

test('noteTaskCompletion: 証拠は上限で切り、落ちた検証・承認時の備考と全部載ってもレビュー契約の様式に収まる', async (t) => {
  const files = Array.from({ length: 200 }, (_, i) => `test/long-name-${i}.test.js`);
  const fake = fakeMeasure({
    outcome: 'measured', base: 'master', mergeBase: 'abcdef0',
    src: { added: ['src/x.js'], restored: [] }, tests: files,
    runs: files.map((file) => ({ file, verdict: 'passes' })),
  });
  const h = harness(t, { worktree: true, verify: NODE_TEST_VERIFY, evidence: { measureEvidence: fake.measure } });
  startedWithNote(h, '備考'.repeat(3000));
  const ng = { ok: false, code: 1, command: NODE_TEST_VERIFY, output: 'x'.repeat(10000) };

  assert.deepEqual(await completion(h, { verifyResult: ng, route: 'review' }), { submitted: true, summoned: true });
  const evidence = reviewNote(h).slice(REVIEW_EVIDENCE_NOTE_PREFIX.length);
  assert.equal(evidence.length, MAX_REVIEW_EVIDENCE_CHARS + 1);
  assert.ok(evidence.startsWith('変更前の src で落ちる 0 / 落ちない 200 /') && evidence.endsWith('…'), evidence);
  assert.ok(reviewBody(h).includes(`${EVIDENCE_HEAD}${evidence}`));
});

test('formatReviewEvidence: 変更したテスト 6 本 (touch の上限) に 3 桁の本数が並び・カバレッジの変わった src が多く・テストを消し・変えた行が通らない範囲だらけでも、上限に切られず収まる', () => {
  // 測定の結果は素通しで整形されて上の上限で切られる — ファイルの中の本数の段もカバレッジの段も件数で畳むので、末尾まで届く。
  // 消したテストの行は整形の側が同じ上限に収まるまで畳む (上限の値はここで突き合わせる)
  assert.equal(EVIDENCE_MAX_CHARS, MAX_REVIEW_EVIDENCE_CHARS);
  const tests = Array.from({ length: 6 }, (_, i) => `test/bridge-review-evidence-coverage-${i}.test.js`);
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `src/bridge/some-quite-long-module-name-${i}.js`,
    before: { covered: 1234, total: 56789 },
    after: { covered: 23456, total: 56789 },
  }));
  // 変えた行の段も長い形: 触った 6 つの src の全部に 5 桁の行番号の範囲が 30 個ずつ
  const changed = Array.from({ length: 6 }, (_, i) => ({
    path: `src/bridge/some-quite-long-module-name-${i}.js`,
    changed: 12345,
    untested: 1530,
    ranges: Array.from({ length: 30 }, (_, j) => [10000 + j * 100, 10050 + j * 100]),
  }));
  const tap = { tests: 123, pass: 123, fail: 0 };
  for (const [label, runs] of [
    ['集計あり', tests.map((file) => ({ file, verdict: 'passes', head: { ok: true, tap }, base: { ok: true, tap } }))],
    ['集計なし (古い形)', tests.map((file) => ({ file, verdict: 'passes' }))],
    // 足したテストの括弧も数字がいちばん長い形: 5 本は全部が足したテストで変更前の src で 23 本落ちる (落ちる / 通るが
    // 2 桁と 3 桁)・6 本目は落ちない (本数の行から溢れて「落ちない:」の行に名前が出る)
    ['集計あり・足したテストあり', tests.map((file, i) => (i < 5
      ? {
        file, verdict: 'fails', head: { ok: true, tap }, base: { ok: true, tap: { tests: 123, pass: 100, fail: 23 } },
        added: { tests: 123, fails: 23, passes: 100 },
      }
      : { file, verdict: 'passes', head: { ok: true, tap }, base: { ok: true, tap }, added: { tests: 0, fails: 0, passes: 0 } }))],
  ]) {
    const fails = runs.filter((run) => run.verdict === 'fails').length;
    const result = {
      outcome: 'measured', base: 'master', mergeBase: '0123456789abcdef',
      src: { added: ['src/a.js', 'src/b.js', 'src/c.js'], restored: ['src/d.js', 'src/e.js', 'src/f.js'] },
      tests,
      runs,
      counts: { fails, passes: runs.length - fails, headFails: 0 },
      coverage: { supported: true, files, changed },
    };
    // 消したテストの行も長い形: 長い名前のファイルを 6 つ消し、変更した 6 本の全部から 3 桁の本数の名前が消えた
    for (const deleted of [{}, {
      deletedTests: Array.from({ length: 6 }, (_, i) => `test/bridge-review-evidence-deleted-${i}.test.js`),
      vanishedTests: tests.map((file) => ({ file, tests: 123 })),
    }]) {
      const text = formatReviewEvidence({ ...result, ...deleted });
      const name = `${label}${deleted.deletedTests ? '・消したテストあり' : ''}`;
      assert.ok(text.length <= MAX_REVIEW_EVIDENCE_CHARS, `${name}: ${text.length} 字: ${text}`);
      assert.ok(text.endsWith('\nほか 25 ファイル'), `${name}: ${text}`);
      // 変えた行の段は畳んでも 1 件は残り、カバレッジの段の前に出る
      assert.match(text, /\nsrc\/bridge\/some-quite-long-module-name-0\.js: 変えた実行行 12345 のうち通らない 1530\b.*\n(?:.*\n)*カバレッジ /, name);
      if (deleted.deletedTests) assert.match(text, /\n消したテスト: ファイル 6.*・消えた名前 738 本 \(.*\)\nsrc\/bridge\/.*: 変えた実行行 /, name);
    }
  }
});

test('noteTaskCompletion: 本体で走る task・verify が node --test でない・verify 無しのチャンネルでは測らず、note も本文も従来どおり', async (t) => {
  for (const [label, options] of [
    ['本体', { worktree: false, verify: NODE_TEST_VERIFY }],
    ['vitest', { worktree: true, verify: 'npx vitest run' }],
    ['pytest', { worktree: true, verify: 'pytest -q' }],
    ['verify 無し', { worktree: true }],
  ]) {
    const fake = fakeMeasure({ outcome: 'no-src', base: 'master', mergeBase: 'abcdef0', src: { added: [], restored: [] }, tests: [] });
    const h = harness(t, { ...options, evidence: { measureEvidence: fake.measure } });
    h.started();
    assert.deepEqual(await completion(h), { submitted: true, summoned: true }, label);
    assert.equal(fake.calls.length, 0, label);
    assert.equal(reviewNote(h), undefined, label);
    assert.equal(reviewBody(h), 'タスク 1 のレビューをお願いします', label);
    assert.equal(h.thread.sent.at(-1).content, SUBMITTED, label);
  }
});

test('noteTaskCompletion: 測定が投げても断られても「測れませんでした」の行になるだけで、レビューへ進めて召喚する', async (t) => {
  for (const [label, measure, reason] of [
    ['throw', async () => { throw new Error('作業ツリーが HEAD に戻りませんでした: src/a.js'); }, '作業ツリーが HEAD に戻りませんでした: src/a.js'],
    ['refused', async () => ({ outcome: 'refused', reason: 'src/ か test/ に未コミットの変更がある' }), 'src/ か test/ に未コミットの変更がある'],
  ]) {
    const h = harness(t, { worktree: true, verify: NODE_TEST_VERIFY, evidence: { measureEvidence: measure } });
    h.started();
    assert.deepEqual(await completion(h), { submitted: true, summoned: true }, label);
    assert.equal(h.board.get('1').state, 'review', label);
    assert.equal(reviewNote(h), `${REVIEW_EVIDENCE_NOTE_PREFIX}測れませんでした — ${reason}`, label);
    assert.equal(reviewBody(h), `タスク 1 のレビューをお願いします${EVIDENCE_HEAD}測れませんでした — ${reason}`, label);
    assert.equal(h.thread.sent.at(-1).content, SUBMITTED, label);
  }
});

test('noteTaskCompletion: job の停止の口 (handle) を測定へ同じ参照で渡し、止まった回も「停止で中断」の行を載せてレビューへ進めて召喚する', async (t) => {
  // /stop・/restart で測定が止まると、src と test/ を HEAD へ戻して stopped が返る (src/review-evidence.js)
  const fake = fakeMeasure({ outcome: 'stopped', base: 'master', mergeBase: 'abcdef0123456789', ran: 1, planned: 3 });
  const h = harness(t, { worktree: true, verify: NODE_TEST_VERIFY, evidence: { measureEvidence: fake.measure } });
  h.started();
  const handle = { stopRequested: false, abort() { this.stopRequested = true; } };

  // 止まった回も召喚は変えない (fail-open のまま、「止まったら召喚しない」は足さない)
  assert.deepEqual(await completion(h, { handle }), { submitted: true, summoned: true });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].handle, handle, '停止の口が測定まで届いていない');
  assert.equal(h.board.get('1').state, 'review');
  const line = '停止で中断 — src と test/ は HEAD へ戻した (走らせたテスト 1 / 予定 3 回・基点 abcdef0 (master))';
  assert.equal(reviewNote(h), `${REVIEW_EVIDENCE_NOTE_PREFIX}${line}`);
  assert.equal(reviewBody(h), `タスク 1 のレビューをお願いします${EVIDENCE_HEAD}${line}`);
  assert.equal(h.thread.sent.at(-1).content, SUBMITTED);

  // 渡さなければ従来どおり (停止の口なし)
  const without = fakeMeasure({ outcome: 'no-src', base: 'master', mergeBase: 'abcdef0', src: { added: [], restored: [] }, tests: [] });
  const h2 = harness(t, { worktree: true, verify: NODE_TEST_VERIFY, evidence: { measureEvidence: without.measure } });
  h2.started();
  assert.deepEqual(await completion(h2), { submitted: true, summoned: true });
  assert.equal(without.calls.length, 1);
  assert.equal(without.calls[0].handle, undefined);
});

test('noteTaskCompletion: 証拠を測る子のテストには bot の token を渡さない (親の env はそのまま)', async (t) => {
  const keys = ['COMMUNITD_TEST_BOT_TOKEN', 'COMMUNITD_TEST_OTHER'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.COMMUNITD_TEST_BOT_TOKEN = 'secret';
  process.env.COMMUNITD_TEST_OTHER = 'kept';

  // 測定の実体だけを差し替え、渡された runTest (本物の runTestFile) を spawn の手前まで通す
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const results = [];
  const measureEvidence = async ({ cwd, runTest }) => {
    results.push(await runTest({ cwd, file: 'test/a.test.js', timeoutMs: 60_000, spawnImpl }));
    return { outcome: 'no-src', base: 'master', mergeBase: 'abcdef0', src: { added: [], restored: [] }, tests: ['test/a.test.js'] };
  };
  const h = harness(t, {
    worktree: true, verify: NODE_TEST_VERIFY,
    evidence: { measureEvidence, scrubEnvKeys: ['COMMUNITD_TEST_BOT_TOKEN'] },
  });
  h.started();
  assert.deepEqual(await completion(h), { submitted: true, summoned: true });

  assert.equal(spawned.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(spawned[0].options.cwd, h.cc.cwd);
  assert.equal(spawned[0].args.at(-1), 'test/a.test.js');
  assert.equal(spawned[0].options.env.COMMUNITD_TEST_BOT_TOKEN, undefined);
  assert.equal(spawned[0].options.env.COMMUNITD_TEST_OTHER, 'kept');
  assert.equal(process.env.COMMUNITD_TEST_BOT_TOKEN, 'secret');
});

test('applyReview: base へ取り込まれた merge だけが遷移が先・掃除が後 (ブランチも消す)、drop は枝を残す', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  const tip = h.workOnBranch(task.branch);
  const mergeSha = h.mergeBranch(task.branch);
  const merged = await h.applyReview({
    // 申告は短縮 SHA でよく、**大文字でもよい** (git へ渡す前に小文字へ揃える)。
    // 記録に残るのはブリッジが解決した小文字の完全 OID
    contract: { verdict: 'merge', reason: 'ok', merge_commit: mergeSha.slice(0, 12).toUpperCase(), target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.equal(
    merged,
    `🎉 タスク #1 を merged にしました (merge ${mergeSha} (base master@${mergeSha}, branch task/1@${tip})) / 指摘 0 件`
    + '\n🧹 作業ツリーは既にありません (ブランチ task/1 も削除)',
  );
  assert.equal(h.board.get('1').state, 'merged');
  assert.equal(h.board.get('1').history.at(-1).note, `merge ${mergeSha} (base master@${mergeSha}, branch task/1@${tip})`);
  assert.equal(h.git('branch', '--list', 'task/1'), '', 'merged の枝が残っている');
  assert.deepEqual(h.events, [], 'merge で duty イベントを配っている');

  const h2 = harness(t);
  const task2 = h2.inReview();
  h2.git('branch', task2.branch);
  const dropped = await h2.applyReview({
    contract: { verdict: 'drop', reason: '既に着地済み', target: [] }, cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.equal(dropped, '🗑 タスク #1 を dropped にしました: 既に着地済み\n🧹 作業ツリーは既にありません');
  assert.equal(h2.board.get('1').state, 'dropped');
  assert.equal(h2.git('branch', '--list', 'task/1'), 'task/1', 'dropped の枝を消している');
});

/** merge 済みにしたタスク 1 の判定を返す (remarks は呼び手が渡す) */
async function mergeWith(t, extra) {
  const h = harness(t);
  const task = h.inReview();
  h.workOnBranch(task.branch);
  const mergeSha = h.mergeBranch(task.branch);
  const out = await h.applyReview({
    contract: { verdict: 'merge', merge_commit: mergeSha, target: [], ...extra },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  return { h, out, entry: h.board.get('1').history.at(-1) };
}

test('applyReview: merge の指摘 (remarks) は件数を履歴の数値の欄に残し、note は 1 文字も変えない', async (t) => {
  const { h, out, entry } = await mergeWith(t, { remarks: ['命名を揃えられる', '  ', 'コメントが古い'] });
  assert.equal(h.board.get('1').state, 'merged');
  assert.equal(entry.to, 'merged');
  // 空白の要素は数えない (reviewRemarks)
  assert.equal(entry.remarks, 2);
  assert.match(out, /^🎉 タスク #1 を merged にしました \(merge [0-9a-f]{40} \(.+\)\) \/ 指摘 2 件\n/);
  // **note は機械が読む** — 解き直しの候補選びとレビューの証拠の遡りが前後固定の正規表現で読むので、
  // 末尾に何か足すとこのタスクが黙って対象外になる
  assert.doesNotMatch(entry.note, /指摘/);
  assert.notEqual(parseMergeNote(entry.note), null, `note が parseMergeNote で読めない: ${entry.note}`);
});

test('applyReview: merge で指摘の鍵が無い・null なら 0 件を記録する (鍵の無い古い履歴と区別する)', async (t) => {
  for (const extra of [{}, { remarks: null }, { remarks: [] }]) {
    const { out, entry } = await mergeWith(t, extra);
    assert.equal(entry.remarks, 0, JSON.stringify(extra));
    assert.match(out, / \/ 指摘 0 件\n/, JSON.stringify(extra));
  }
});

test('applyReview: send-back に付いた指摘は弾かず、数えもしない (履歴に欄を付けない)', async (t) => {
  const h = harness(t);
  h.inReview();
  const out = await h.applyReview({
    contract: { verdict: 'send-back', reason: 'テストが足りない', remarks: ['命名', 'コメント'], target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.match(out, /^↩️ タスク #1 を差し戻しました/);
  const entry = h.board.get('1').history.at(-1);
  assert.equal(entry.to, 'in-progress');
  assert.equal(Object.hasOwn(entry, 'remarks'), false, '差し戻しの履歴に指摘の件数を付けている');
  assert.doesNotMatch(out, /指摘/);
});

test('applyReview: 取り込みを照合できない merge は review のまま (ボードも枝も動かさない — §12.3 (2))', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  const tip = h.workOnBranch(task.branch); // 枝はまだ base に入っていない
  const initial = h.git('rev-parse', 'master');

  // base にはあるが、この枝の成果を含まない OID (初期 commit を書いた申告 = D1 の再現)
  const stale = await h.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: initial, target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.match(stale, /^⚠️ タスク #1 は review のままです — /);
  assert.match(stale, /ブランチ task\/1 の先端 /);
  assert.match(stale, /`\/review 1` で出し直してください$/);
  assert.equal(h.board.get('1').state, 'review');
  assert.equal(h.git('branch', '--list', 'task/1'), 'task/1', '照合できていないのに枝を消している');

  // 枝の先端そのものの申告 (まだ base へ取り込んでいない)
  const notMerged = await h.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: tip, target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.match(notMerged, /master に入っていません/);
  assert.equal(h.board.get('1').state, 'review');

  // 枝が消えている = 成果を照合できない (base にある OID でも通さない)
  const h2 = harness(t);
  h2.inReview();
  const gone = await h2.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: h2.git('rev-parse', 'master'), target: [] },
    cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.match(gone, /ブランチ task\/1 が見つかりません/);
  assert.equal(h2.board.get('1').state, 'review');

  // git に無い OID (様式は通る形) も同じ
  const ghost = await h2.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: 'f'.repeat(40), target: [] },
    cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.match(ghost, /git に見つかりません/);
  assert.equal(h2.board.get('1').state, 'review');
});

test('applyReview: 検収担当でない bot と実装した本人の判定は適用しない (§12.3 (2))', async (t) => {
  const h = harness(t);
  const task = h.inReview();
  h.workOnBranch(task.branch);
  const mergeSha = h.mergeBranch(task.branch);
  const contract = { verdict: 'merge', reason: 'ok', merge_commit: mergeSha, target: [] };

  // 照合そのものは通る申告でも、検収担当 (opus2) 以外は適用しない
  for (const key of ['opus', 'fable']) {
    const out = await h.applyReview({ contract, cc: h.cc, bot: h.bot(key), thread: h.thread });
    assert.equal(out, `⚠️ タスク #1 の検収担当は opus2 です — ${key} の判定を適用していません (検収担当ではない)`);
  }
  assert.equal(h.board.get('1').state, 'review');
  assert.equal(h.git('branch', '--list', 'task/1'), 'task/1', '適用していないのに枝を消している');

  // reviewer と実装担当が同じ設定でも、実装した本人には通させない
  // (requestReview の自己レビュー禁止は `様式:task-review` タグで迂回できる)
  const self = harness(t, { reviewer: 'opus' });
  const own = self.inReview();
  self.workOnBranch(own.branch);
  const out = await self.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: self.mergeBranch(own.branch), target: [] },
    cc: self.cc, bot: self.bot('opus'), thread: self.thread,
  });
  assert.equal(out, '⚠️ タスク #1 を実装したのは opus です — 判定を適用していません (実装した本人)');
  assert.equal(self.board.get('1').state, 'review');
  assert.equal(self.git('branch', '--list', 'task/1'), 'task/1');
});

test('applyReview: 適用 task の merge は receipt の commit と一致しないと適用しない (§12.3 (2))', async (t) => {
  // 適用 task の merge を打つのはブリッジ自身なので、検収の時点でマージコミットは無い。
  // reviewer が書けるのは receipt の appliedCommit (案内に短縮 12 桁が載る) だけ
  const applied = 'a1b2c3d4e5f6'.repeat(3) + 'abcd'; // 40 桁
  const proposal = { id: '7', class: 'org', applyTaskId: '1', receipt: { appliedCommit: applied } };
  const h = harness(t, { proposals: { list: () => [proposal] } });
  h.inReview();

  const mismatch = await h.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: 'b'.repeat(40), target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.match(
    mismatch,
    new RegExp(`^⚠️ 適用タスク #1 の検収 commit が receipt \\(${applied.slice(0, 12)}\\) と一致しません — 判定を適用していません`),
  );
  assert.equal(h.board.get('1').state, 'review', '一致しないのに遷移している');
  assert.deepEqual(h.releases, [], '一致しないのに枝を解放している');

  // receipt が無い形 (旧レコード・適用の記録が落ちた) も「確かめられない」= 適用しない
  const h2 = harness(t, { proposals: { list: () => [{ id: '7', applyTaskId: '1' }] } });
  h2.inReview();
  const noReceipt = await h2.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: applied, target: [] },
    cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.match(noReceipt, /receipt \(未記録\) と一致しません/);
  assert.equal(h2.board.get('1').state, 'review');

  // 短縮 12 桁で一致すれば従来どおり mergeApplyTask へ進む (この fixture では枝が無いのでそこで止まる)
  const ok = await h.applyReview({
    contract: { verdict: 'merge', reason: 'ok', merge_commit: applied.slice(0, 12).toUpperCase(), target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.match(ok, /^⚠️ 提案 #7 を merge できませんでした: /, ok);
  assert.equal(h.board.get('1').state, 'review');

  // merge 以外の判定は従来どおり (照合は merge の申告にしか関係しない)
  const back = await h.applyReview({
    contract: { verdict: 'send-back', reason: '直して', target: [] },
    cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.equal(/一致しません/.test(back), false, back);
});

test('applyReview: 適用 task にも検収の同一性の門が効く (経路より前 — Opus 指摘 2026-09-07)', async (t) => {
  // 当てたのはブリッジでも、通してよいと決めるのは検収担当だけ。ここが適用 task の分岐より
  // 後ろにあると、`様式:task-review` タグで誰でも org 提案を main へ入れられる
  const applied = 'a1b2c3d4e5f6'.repeat(3) + 'abcd'; // 40 桁
  const proposal = { id: '7', class: 'org', applyTaskId: '1', receipt: { appliedCommit: applied } };
  const h = harness(t, { proposals: { list: () => [proposal] } });
  h.inReview();

  for (const key of ['opus', 'fable']) {
    // 一致する OID (案内に出ている値) を書いても、検収担当でなければ何も起きない
    const out = await h.applyReview({
      contract: { verdict: 'merge', reason: 'ok', merge_commit: applied, target: [] },
      cc: h.cc, bot: h.bot(key), thread: h.thread,
    });
    assert.equal(out, `⚠️ タスク #1 の検収担当は opus2 です — ${key} の判定を適用していません (検収担当ではない)`);
  }
  // 提案を再裁定へ戻す経路 (send-back / drop) も同じ門を通る
  const back = await h.applyReview({
    contract: { verdict: 'send-back', reason: '通したくない', target: [] },
    cc: h.cc, bot: h.bot('opus'), thread: h.thread,
  });
  assert.match(back, /検収担当ではない/);
  assert.equal(h.board.get('1').state, 'review', '検収担当以外の判定でボードが動いている');
  assert.deepEqual(h.releases, [], '検収担当以外の判定で枝を解放している');
});

test('applyReview: block は要人間へ落として duty へ配り、send-back は追い予算つきで担当を呼び直す (2 回目は block)', async (t) => {
  const h = harness(t);
  h.inReview();
  const blocked = await h.applyReview({
    contract: { verdict: 'block', reason: '人の判断が要る', target: [] }, cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  assert.equal(blocked, '⛔ タスク #1 を要人間 (blocked) にしました: 人の判断が要る');
  assert.equal(h.board.get('1').state, 'blocked');
  assert.deepEqual(h.events, [{ eventKind: 'block', channelName: 'kt', detail: 'タスク #1 が blocked', excludeBotKeys: ['opus2'] }]);

  const h2 = harness(t);
  h2.inReview();
  const sentBack = await h2.applyReview({
    contract: { verdict: 'send-back', reason: 'テストが足りない', target: [] }, cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.equal(sentBack, `↩️ タスク #1 を差し戻しました\n→ Opus に直しをお願いしました (追い予算 ${SEND_BACK_JOB_BUDGET} job)`);
  assert.equal(h2.board.get('1').state, 'in-progress');
  assert.equal(h2.hops.taskBudget('T1'), SEND_BACK_JOB_BUDGET);
  const resume = h2.thread.sent.at(-1);
  assert.ok(resume.content.startsWith('<@O>\n'), '担当へのメンションで始まっていない');
  assert.match(resume.content, /テストが足りない/);
  assert.deepEqual(resume.allowedMentions.users, ['O']);
  assert.deepEqual(h2.events, [{ eventKind: 'send-back', channelName: 'kt', detail: 'タスク #1 が差し戻し', excludeBotKeys: ['opus2', 'opus'] }]);

  // 2 回目の差し戻しは直させずに要人間へ
  h2.board.submitForReview('1', { by: 'opus' });
  const second = await h2.applyReview({
    contract: { verdict: 'send-back', reason: 'まだ足りない', target: [] }, cc: h2.cc, bot: h2.bot('opus2'), thread: h2.thread,
  });
  assert.match(second, /^⛔ タスク #1 を要人間 \(blocked\) にしました: 差し戻し 2 回目 — まだ足りない/);
});

test('applyReview: send-back で直す担当を呼べない・投稿に失敗したときは「人間が起こしてください」を返す (差し戻し自体は済む)', async (t) => {
  // notifySendBack は配線の外へ出ていないので send-back の判定から踏む。ボードの差し戻し・
  // 追い予算・duty への配布は呼び直しより前か無関係に走るので、呼べなくても残る (既存の挙動どおり)
  const sendBack = (h) => h.applyReview({
    contract: { verdict: 'send-back', reason: 'テストが足りない', target: [] }, cc: h.cc, bot: h.bot('opus2'), thread: h.thread,
  });
  const assertSentBackOnly = (h, label) => {
    assert.equal(h.board.get('1').state, 'in-progress', `${label}: ボードが差し戻されていない`);
    assert.equal(h.hops.taskBudget('T1'), SEND_BACK_JOB_BUDGET, `${label}: 追い予算`);
    assert.equal(h.thread.sent.length, 0, `${label}: 担当へのメンションを投げている`);
    assert.deepEqual(h.events.map((e) => e.eventKind), ['send-back'], `${label}: duty へ配っていない`);
  };

  // 担当が起動していない — pickWorker は起動中の bot からしか選ばないので、設定はあっても「未設定」と出る
  const down = harness(t);
  down.inReview();
  down.bot('opus').userId = null;
  assert.equal(await sendBack(down), '↩️ タスク #1 を差し戻しました\n⚠️ 直す担当を呼べませんでした (worker: 未設定) — 人間が起こしてください');
  assertSentBackOnly(down, '担当が居ない');

  // 担当が判定を出した本人 — 自分の多行発言は捨てられる (src/trigger.js) ので自分宛には投げない
  const self = harness(t, { workers: ['opus2'] });
  self.inReview();
  assert.equal(await sendBack(self), '↩️ タスク #1 を差し戻しました\n⚠️ 直す担当を呼べませんでした (worker: opus2) — 人間が起こしてください');
  assertSentBackOnly(self, '担当が自分');

  const failing = harness(t);
  failing.inReview();
  failing.thread.fail = 'Missing Permissions';
  assert.equal(await sendBack(failing), '↩️ タスク #1 を差し戻しました\n⚠️ 差し戻しメッセージの投稿に失敗しました (Missing Permissions) — 人間が起こしてください');
  assertSentBackOnly(failing, '投稿に失敗');
});

test('applyReview: review 以外・タスク無し・知らない判定 は適用しない', async (t) => {
  const h = harness(t);
  const base = { cc: h.cc, bot: h.bot('opus2'), thread: h.thread };
  assert.equal(await h.applyReview({ ...base, contract: { verdict: 'merge' } }), '⚠️ このスレッドに対応するタスクがありません — 判定を適用していません');
  h.started();
  assert.equal(await h.applyReview({ ...base, contract: { verdict: 'merge' } }), '⚠️ タスク #1 は in-progress なので判定を適用していません');
  h.board.submitForReview('1', { by: 'opus' });
  assert.match(await h.applyReview({ ...base, contract: { verdict: 'approve' } }), /^⚠️ 知らない判定です: "approve" — 判定を適用していません/);
  assert.equal(h.board.get('1').state, 'review');
});

test('applyApproval: 今回の契約に載っている id だけを動かし、言及されなかったものは破棄する', (t) => {
  const h = harness(t);
  const a = h.propose('A');
  const b = h.propose('B', ['b.py']);
  const pending = [approvalItem(a), approvalItem(b)];
  const note = h.applyApproval({
    contract: { body: 'ok', approve: ['1'], drop: [{ id: '9', reason: '知らない' }] }, pending, cc: h.cc, botKey: 'opus2',
  });
  assert.equal(note, '✅ 承認 1 件 / 破棄 1 件\n⚠️ 破棄: 知らない id 9 — 今回の承認対象に含まれていないので何もしません');
  assert.equal(h.board.get('1').state, 'approved');
  assert.equal(h.board.get('2').state, 'dropped');
  assert.ok(h.errors.some((e) => e.startsWith('[scheduler] kt: 承認の適用に問題 —')), h.errors.join('\n'));
});

test('applyApproval: 承認の本文を承認の記録に残し (制御フッターは外す)、レビューの依頼に承認時の備考として載せる', async (t) => {
  const h = harness(t);
  const a = h.propose('A');
  const b = h.propose('B', ['b.py']);
  const body = '#1 と #2 を承認します。\n\n着手する人への備考:\n- touch の外 (c.py) は触らない\n\n[[notify:owner]]';
  h.applyApproval({
    contract: { body, approve: ['1', '2'], drop: [] }, pending: [approvalItem(a), approvalItem(b)], cc: h.cc, botKey: 'opus2',
  });
  const kept = '#1 と #2 を承認します。\n\n着手する人への備考:\n- touch の外 (c.py) は触らない';
  // 同じ承認で通したものには同じ本文が付く
  for (const id of ['1', '2']) assert.deepEqual(approvalNote(h.board.get(id)), { note: kept, by: 'opus2' }, `#${id}`);

  h.board.start('1', { threadId: 'T1', by: 'scheduler' });
  const task = h.board.submitForReview('1', { by: 'opus' });
  const sent = await h.requestReview({ task, cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  assert.equal(sent.ok, true);
  const [entry] = h.contracts.list('T1', 'opus2');
  assert.equal(
    entry.contract.body,
    'タスク 1 のレビューをお願いします\n\n'
      + '承認時の備考 (承認した側が着手する人へ残した注意を含む — 守られているかも見る):\n' + kept,
  );
});

test('reissueReview: review のタスクだけを対象に、古い task-review 契約を置き換えて召喚する', async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.reissueReview({ thread: h.thread, id: null, bot: h.bot('fable') }), {
    ok: false, reason: 'このスレッドに対応するタスクがありません (タスクのスレッドで打ってください)',
  });
  h.inReview();
  // 古い契約を残しておく → 置き換えで消える (承認や委譲は巻き添えにしない)
  await h.requestReview({ task: h.board.get('1'), cc: h.cc, autonomy: h.cc.autonomy, bot: h.bot('opus'), thread: h.thread });
  const stale = h.contracts.list('T1', 'opus2')[0];
  const out = await h.reissueReview({ thread: h.thread, id: '1', bot: h.bot('fable') });
  assert.deepEqual(out, { ok: true, reason: '#1 のレビューを出し直しました\n→ Opus2 にレビューをお願いしました' });
  const now = h.contracts.list('T1', 'opus2');
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, stale.id, '古い契約が残っている');
  assert.deepEqual(await h.reissueReview({ thread: h.thread, id: '2', bot: h.bot('fable') }), {
    ok: false, reason: 'このスレッドのタスクは #1 です (#2 のスレッドで打ってください)',
  });

  const paused = harness(t, { paused: true });
  paused.inReview();
  assert.deepEqual(await paused.reissueReview({ thread: paused.thread, id: null, bot: paused.bot('fable') }), {
    ok: false, reason: '自律運転が停止中です — `/resume` してから打ってください',
  });
});

test('fileProposal: 検査を通った起票をボードへ載せて承認を頼む (0 件も正しい報告)', async (t) => {
  const h = harness(t);
  const contract = { body: '起票します', tasks: [{ title: 'A', rationale: 'r', touch: ['a.py'] }, { title: 'B', rationale: 'r', touch: ['b.py'], job_budget: 4 }] };
  const note = await h.fileProposal({ contract, cc: h.cc, bot: h.bot('opus'), thread: h.thread });
  assert.equal(note, '🌱 ボードへ 2 件起票しました (承認待ち): #1 A / #2 B\n📋 Opus2 に承認を依頼しました (承認されたものだけが着手されます)');
  assert.equal(h.board.get('2').jobBudget, 4);
  assert.equal(h.board.get('1').state, 'proposed');

  assert.equal(await h.fileProposal({ contract: { body: 'なし', tasks: [] }, cc: h.cc, bot: h.bot('opus'), thread: h.thread }), '🌱 起票なし (0 件も正しい報告です)');
  // 既にあるタスクと同じファイルを掴む起票は載せない (§9.1)
  const dup = await h.fileProposal({ contract: { body: 'x', tasks: [{ title: 'A2', rationale: 'r', touch: ['a.py'] }] }, cc: h.cc, bot: h.bot('opus'), thread: h.thread });
  assert.match(dup, /^🌱 起票できたものはありません\n⚠️ 載せられなかったもの: A2: /);

  const noBoard = harness(t, { withBoard: false });
  assert.match(await noBoard.fileProposal({ contract, cc: noBoard.cc, bot: noBoard.bot('opus'), thread: noBoard.thread }), /^⚠️ 起票を受け取りましたが、このプロセスはボードを持っていません/);
});

test('fileProposal: ハーネスの改訂 (提案役の、役割文だけの起票) はスカウトの枠が埋まっていても載る', async (t) => {
  const h = harness(t);
  h.cc.autonomy.scout = { maxOpenTasks: 1 };
  h.cc.autonomy.harness = { bot: 'fable' };
  await h.fileProposal({ contract: { body: 'x', tasks: [{ title: 'A', rationale: 'r', touch: ['a.py'] }] }, cc: h.cc, bot: h.bot('opus'), thread: h.thread });
  const role = { body: '改訂', tasks: [{ title: '役割文の改訂', rationale: 'r', touch: ['roles/worker.md'] }] };

  // 提案役以外が役割文を起票しても枠は効く
  assert.match(await h.fileProposal({ contract: role, cc: h.cc, bot: h.bot('opus'), thread: h.thread }), /枠不足で見送り/);
  // 提案役の改訂は枠の外
  assert.match(await h.fileProposal({ contract: role, cc: h.cc, bot: h.bot('fable'), thread: h.thread }), /^🌱 ボードへ 1 件起票しました \(承認待ち\): #2 役割文の改訂/);
  // 提案役でも役割文を触らない起票は枠どおり
  const other = { body: 'x', tasks: [{ title: 'C', rationale: 'r', touch: ['c.py'] }] };
  assert.match(await h.fileProposal({ contract: other, cc: h.cc, bot: h.bot('fable'), thread: h.thread }), /枠不足で見送り/);
});

test('fileProposal: 企画の巡回 (企画役の、主題ファイルだけの起票) はスカウトの枠が埋まっていても載る', async (t) => {
  const h = harness(t);
  h.cc.autonomy.scout = { maxOpenTasks: 1 };
  h.cc.autonomy.planner = { bot: 'fable' }; // 主題ファイルは既定の docs/themes.md
  await h.fileProposal({ contract: { body: 'x', tasks: [{ title: 'A', rationale: 'r', touch: ['a.py'] }] }, cc: h.cc, bot: h.bot('opus'), thread: h.thread });
  const theme = { body: '主題', tasks: [{ title: '主題を足す', rationale: 'r', touch: ['docs/themes.md'] }] };

  // 企画役以外が主題ファイルを起票しても枠は効く
  assert.match(await h.fileProposal({ contract: theme, cc: h.cc, bot: h.bot('opus'), thread: h.thread }), /枠不足で見送り/);
  // 企画役の主題は枠の外
  assert.match(await h.fileProposal({ contract: theme, cc: h.cc, bot: h.bot('fable'), thread: h.thread }), /^🌱 ボードへ 1 件起票しました \(承認待ち\): #2 主題を足す/);
  // 企画役でも主題ファイルを触らない起票は枠どおり
  const other = { body: 'x', tasks: [{ title: 'C', rationale: 'r', touch: ['c.py'] }] };
  assert.match(await h.fileProposal({ contract: other, cc: h.cc, bot: h.bot('fable'), thread: h.thread }), /枠不足で見送り/);
});

test('fileProposal: board.propose が throw した起票は「題: 理由」で失敗欄に積み、残りの起票は続けて承認を頼む', async (t) => {
  const h = harness(t);
  // touch の中身は planFiling ではなく board.propose (normalizeTouch) が見る — 先頭の 1 件で落とす
  const contract = {
    body: '起票します',
    tasks: [
      { title: 'X', rationale: 'r', touch: ['../outside.py'] },
      { title: 'A', rationale: 'r', touch: ['a.py'] },
      { title: 'B', rationale: 'r', touch: ['b.py'] },
    ],
  };
  const lines = (await h.fileProposal({ contract, cc: h.cc, bot: h.bot('opus'), thread: h.thread })).split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.equal(lines[0], '🌱 ボードへ 2 件起票しました (承認待ち): #1 A / #2 B');
  assert.match(lines[1], /^⚠️ 載せられなかったもの: X: タスクの touch に使えないパスがあります: "\.\.\/outside\.py"/);
  assert.equal(lines[2], '📋 Opus2 に承認を依頼しました (承認されたものだけが着手されます)');
  assert.deepEqual(h.board.list({ channel: 'kt' }).map((task) => task.title), ['A', 'B'], '落ちた起票がボードに載っている');
  const [approval] = h.contracts.list('T1', 'opus2');
  assert.deepEqual(approval.contract.pending.map((p) => p.title), ['A', 'B'], '承認の対象に落ちた起票が混ざっている');
  assert.ok(h.errors.some((e) => e.startsWith('[scheduler] kt: 起票に失敗 — タスクの touch に使えないパスがあります')), h.errors.join('\n'));

  // 全件落ちたら承認するものが無い (承認 job を空振りさせない)
  const none = harness(t);
  const allBad = { body: 'x', tasks: [{ title: 'X', rationale: 'r', touch: ['../outside.py'] }] };
  assert.match(
    await none.fileProposal({ contract: allBad, cc: none.cc, bot: none.bot('opus'), thread: none.thread }),
    /^🌱 起票できたものはありません\n⚠️ 載せられなかったもの: X: タスクの touch に使えないパスがあります/,
  );
  assertNothingQueued(none, '起票が 1 件も載らなかった');
});

test('cleanupTaskWorktree は判定の一部ではない — 失敗しても投げず、撤去先はリポジトリ本体', async (t) => {
  const h = harness(t);
  assert.equal(await h.cleanupTaskWorktree({ cc: h.cc, task: { id: '1', branch: 'task/1' }, action: 'send-back' }), '');
  assert.equal(await h.cleanupTaskWorktree({ cc: h.cc, task: { id: '1', branch: '' }, action: 'complete' }), '');
  const kept = await h.cleanupTaskWorktree({ cc: h.cc, task: { id: '1', branch: 'task/1' }, action: 'complete' });
  assert.match(kept, /^🧹 作業ツリーは既にありません \(ブランチ task\/1 は残しました: /);
  const broken = await h.cleanupTaskWorktree({ cc: { channelName: 'kt', cwd: join(h.dir, 'nowhere') }, task: { id: '1', branch: 'task/1' }, action: 'drop' });
  assert.match(broken, /^⚠️ 作業ツリーの撤去に失敗: .* — 残しました$/);
});

// ---- ハーネスの改訂の下書きの検証 (解き直し — src/replay.js) ----

/** 過去のタスクを merge まで進める (差し戻しを 1 回挟むかを選べる)。git の merge も実物 */
function mergedPast(h, { title, file, threadId, sentBack = null, touch = ['src/a.js'] }) {
  const task = h.board.propose({ channel: 'kt', title, rationale: `${title} の理由`, touch, jobBudget: 20 }, { by: 'opus' });
  h.board.approve(task.id, { by: 'fable', note: `${title} の承認の備考` });
  h.board.start(task.id, { threadId, by: 'scheduler', branch: `task/${task.id}` });
  h.board.submitForReview(task.id, { by: 'opus' });
  if (sentBack) {
    h.board.sendBack(task.id, { by: 'opus2', reason: sentBack });
    h.board.submitForReview(task.id, { by: 'opus' });
  }
  const tip = h.workOnBranch(`task/${task.id}`, file);
  const commit = h.mergeBranch(`task/${task.id}`);
  h.board.complete(task.id, { by: 'opus2', note: `merge ${commit} (base master@${commit}, branch task/${task.id}@${tip})` });
  return task.id;
}

function replayHarness(t, { touch = ['roles/worker.md'], rationale = '差し戻し #1 と同じ原因 — 足したテストを一度も壊していない', paused = false } = {}) {
  const h = harness(t, { paused });
  h.cc.autonomy.harness = { bot: 'fable', replayCases: 1, replayCanary: 1 };
  h.bots.get('opus').cfg.rolePromptFile = 'roles/worker.md';
  h.bots.get('opus2').cfg.rolePromptFile = 'roles/reviewer.md';
  const initial = h.git('rev-parse', 'HEAD');
  const sentBackId = mergedPast(h, { title: '[review-evidence] 停止のテスト', file: 'b.py', threadId: 'P1', sentBack: '【差し戻し】close を待たない回帰でも全部通る' });
  const canaryId = mergedPast(h, { title: '証拠の行を足す', file: 'c.py', threadId: 'P2' });
  const revision = h.board.propose({ channel: 'kt', title: 'worker.md に 1 項', rationale, touch, jobBudget: 4 }, { by: 'fable' });
  h.board.approve(revision.id, { by: 'opus2' });
  h.board.start(revision.id, { threadId: 'T1', by: 'scheduler', branch: `task/${revision.id}` });
  const complete = (thread, bot = 'opus', extra = {}) => h.noteTaskCompletion({
    thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null, verifyResult: null, bot: h.bot(bot), ...extra,
  });
  const sentTo = [];
  const fakeThread = (id) => ({ id, send: async (payload) => { sentTo.push(payload); return { id: 'x' }; } });
  return { ...h, initial, sentBackId, canaryId, revisionId: revision.id, complete, fakeThread, sentTo };
}

const replaysOf = (h) => h.board.list({ channel: 'kt' }).filter((task) => task.replay?.of === h.revisionId);

test('解き直し: 役割文の改訂の完了でレビューを呼ばずに解き直しを立て、解き直しの完了は結果を残して取り下げ、期限で残りを打ち切って依頼に結果を載せる', async (t) => {
  const h = replayHarness(t);
  // 1. 改訂の完了 → review へ進むが、レビュー担当は呼ばない。解き直し 2 件 (差し戻しの再現 + カナリア) を承認まで
  assert.deepEqual(await h.complete(h.thread), { submitted: true, summoned: true });
  const revision = h.board.get(h.revisionId);
  assert.equal(revision.state, 'review');
  assert.equal(revision.replay.status, 'running');
  assert.equal(h.contracts.list('T1', 'opus2').length, 0, '解き直しの前にレビューを呼んでいる');
  const replays = replaysOf(h);
  assert.deepEqual(replays.map((task) => [task.state, task.replay.kind, task.replay.caseId]), [
    ['approved', 'sent-back', h.sentBackId], ['approved', 'canary', h.canaryId],
  ]);
  const [again, canary] = replays;
  assert.equal(again.title, '[replay] 停止のテスト');
  assert.equal(again.replay.base, h.initial, '元のタスクが始まった版から生やしていない');
  assert.equal(again.jobBudget, 2);
  assert.equal(approvalNote(again).note, '[review-evidence] 停止のテスト の承認の備考');
  assert.equal(
    h.thread.sent.at(-1).content,
    `🔎 タスク #${h.revisionId} をレビューへ進めました — 役割文の改訂なので、下書きの役割文で過去のタスクを解き直してからレビューを呼びます: `
      + `#${again.id} (差し戻しの再現 #${h.sentBackId}) / #${canary.id} (カナリア #${h.canaryId}) (待つ上限 12 時間)`,
  );

  // 2. 解き直しの完了 → merge せずに結果を残して取り下げ (レビューは呼ばない)
  h.board.start(again.id, { threadId: 'R1', by: 'scheduler', branch: `task/${again.id}` });
  assert.deepEqual(await h.complete(h.fakeThread('R1')), { submitted: false, summoned: true });
  const finished = h.board.get(again.id);
  assert.equal(finished.state, 'dropped');
  assert.equal(finished.replay.outcome.result, 'submitted');
  assert.equal(h.contracts.list('R1', 'opus2').length, 0);
  assert.ok(h.sentTo.at(-1).content.startsWith(`🔁 解き直しの結果を残しました — 改訂 #${h.revisionId} のレビューの依頼に載ります`));

  // 3. カナリアが残っている間は呼ばない。期限 (12 時間) が来たら残りを期限切れで取り下げてレビューを呼ぶ
  const autonomy = resolveAutonomy(h.cc);
  const startedAt = Date.parse(revision.replay.startedAt);
  await h.settleReplays({ channelName: 'kt', autonomy, now: startedAt + 60_000 });
  assert.equal(h.contracts.list('T1', 'opus2').length, 0);
  await h.settleReplays({ channelName: 'kt', autonomy, now: startedAt + 12 * 60 * 60_000 });
  assert.equal(h.board.get(canary.id).state, 'dropped');
  assert.equal(h.board.get(canary.id).replay.outcome.result, 'timeout');
  assert.equal(h.board.get(h.revisionId).replay.status, 'done');
  assert.equal(h.board.get(h.revisionId).replay.how, 'timeout');
  const entries = h.contracts.list('T1', 'opus2');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'task-review');
  const body = entries[0].contract.body;
  const base = h.initial.slice(0, 7);
  assert.ok(body.includes('下書きの検証 (この改訂の作業ツリーの役割文で過去のタスクを解き直した結果'), body);
  assert.ok(body.includes(`- #${again.id} ← 差し戻しの再現 #${h.sentBackId} (基点 ${base}・\`git diff ${base}..task/${again.id}\`): 完了を報告`), body);
  assert.ok(body.includes('元の差し戻しの理由: 【差し戻し】close を待たない回帰でも全部通る'), body);
  // カナリアは #1 の merge の後に始まったタスクなので、基点はその merge の後の版
  assert.notEqual(canary.replay.base, h.initial);
  assert.ok(body.includes(`- #${canary.id} ← カナリア #${h.canaryId} (基点 ${canary.replay.base.slice(0, 7)}): 期限切れ (終わらなかった)`), body);
  assert.ok(body.includes('期限が来たので、終わっていない解き直しを取り下げてレビューを呼んだ'), body);
  assert.equal(
    h.thread.sent.at(-1).content,
    `🔎 下書きの解き直しの期限が来たので、タスク #${h.revisionId} のレビューを呼びます\n→ Opus2 にレビューをお願いしました`,
  );

  // 4. 次の tick では二重に呼ばない
  await h.settleReplays({ channelName: 'kt', autonomy, now: startedAt + 13 * 60 * 60_000 });
  assert.equal(h.contracts.list('T1', 'opus2').length, 1);
});

test('解き直し: 全部落ち着いたら期限を待たずに呼び、止まった解き直しも閉じる / 停止中は呼ばない', async (t) => {
  for (const paused of [true, false]) {
    const h = replayHarness(t, { paused });
    await h.complete(h.thread);
    const [again, canary] = replaysOf(h);
    h.board.start(again.id, { threadId: 'R1', by: 'scheduler', branch: `task/${again.id}` });
    await h.complete(h.fakeThread('R1'), 'opus', { verifyResult: { ok: false, code: 1 }, route: 'review' });
    assert.equal(h.board.get(again.id).replay.outcome.result, 'verify-ng');
    h.board.block(canary.id, { by: 'scheduler', reason: '起動メッセージの投稿に失敗' });
    const now = Date.parse(h.board.get(h.revisionId).replay.startedAt) + 60_000;
    await h.settleReplays({ channelName: 'kt', autonomy: resolveAutonomy(h.cc), now });
    if (paused) {
      assert.equal(h.board.get(h.revisionId).replay.status, 'running', '停止中に解き直しを閉じている');
      assert.equal(h.board.get(canary.id).state, 'blocked');
      continue;
    }
    assert.equal(h.board.get(h.revisionId).replay.how, 'settled');
    assert.equal(h.board.get(canary.id).state, 'dropped');
    assert.equal(h.board.get(canary.id).replay.outcome.result, 'blocked');
    const body = h.contracts.list('T1', 'opus2')[0].contract.body;
    assert.ok(body.includes(': verify NG のまま報告'), body);
    assert.ok(body.includes(': 止まった (要人間)'), body);
    assert.ok(h.thread.sent.at(-1).content.startsWith('🔎 下書きの解き直しが終わったので'));
  }
});

test('解き直し: worker の読まない役割文だけの改訂・名指しもカナリアも無い改訂は解き直さず、理由を依頼に添えてすぐレビューを呼ぶ', async (t) => {
  const reviewerOnly = replayHarness(t, { touch: ['roles/reviewer.md'] });
  assert.deepEqual(await reviewerOnly.complete(reviewerOnly.thread), { submitted: true, summoned: true });
  assert.deepEqual(reviewerOnly.board.get(reviewerOnly.revisionId).replay, {
    status: 'none', reason: '解き直しの worker が読む役割文 (共通規定・worker の役割文) を触っていない改訂',
  });
  assert.equal(replaysOf(reviewerOnly).length, 0);
  assert.ok(
    reviewerOnly.contracts.list('T1', 'opus2')[0].contract.body
      .includes('下書きの検証: 解き直していません — 解き直しの worker が読む役割文'),
  );

  const plain = harness(t);
  plain.cc.autonomy.harness = { bot: 'fable' };
  plain.bots.get('opus').cfg.rolePromptFile = 'roles/worker.md';
  const task = plain.board.propose({ channel: 'kt', title: '共通規定に 1 項', rationale: '名指し無し', touch: ['roles/_common.md'], jobBudget: 4 }, { by: 'fable' });
  plain.board.approve(task.id, { by: 'opus2' });
  plain.board.start(task.id, { threadId: 'T1', by: 'scheduler' });
  await plain.noteTaskCompletion({ thread: plain.thread, cc: plain.cc, contractOut: { kind: 'report' }, mention: null, verifyResult: null, bot: plain.bot('opus') });
  assert.equal(plain.board.get(task.id).replay.reason, '理由に名指しされた差し戻しのタスクが無く、カナリアの候補も無い');
  assert.equal(plain.contracts.list('T1', 'opus2').length, 1);

  // ハーネスの巡回が無いチャンネル・役割文を触らないタスクには replay 欄を付けない (今までどおり)
  const off = harness(t);
  off.started();
  await off.noteTaskCompletion({ thread: off.thread, cc: off.cc, contractOut: { kind: 'report' }, mention: null, verifyResult: null, bot: off.bot('opus') });
  assert.equal(off.board.get('1').state, 'review');
  assert.equal(off.board.get('1').replay, undefined);
});

test('解き直し: /review の出し直しは待つのをやめて今ある結果で呼び、後の tick は二重に呼ばない', async (t) => {
  const h = replayHarness(t);
  await h.complete(h.thread);
  const [again, canary] = replaysOf(h);
  // 片方は走っている (自分の完了で取り下げられる)、もう片方は未着手 (取りやめる — 残すと着手が先に起こして job を使う)
  h.board.start(again.id, { threadId: 'R1', by: 'scheduler' });
  const res = await h.reissueReview({ thread: h.thread, bot: h.bot('fable') });
  assert.equal(res.ok, true, res.reason);
  assert.equal(h.board.get(h.revisionId).replay.status, 'done');
  assert.equal(h.board.get(h.revisionId).replay.how, 'manual');
  assert.equal(h.board.get(again.id).state, 'in-progress');
  assert.equal(h.board.get(canary.id).state, 'dropped');
  assert.equal(h.board.get(canary.id).replay.outcome.result, 'manual');
  const body = h.contracts.list('T1', 'opus2')[0].contract.body;
  assert.ok(body.includes(`- #${again.id} ← 差し戻しの再現 #${h.sentBackId} `) && body.includes(': 結果不明'), body);
  assert.ok(body.includes(`- #${canary.id} ← カナリア #${h.canaryId} (基点 `) && body.includes(': 取りやめ (/review で待つのをやめた)'), body);
  await h.settleReplays({ channelName: 'kt', autonomy: resolveAutonomy(h.cc), now: Date.now() + 24 * 60 * 60_000 });
  assert.equal(h.contracts.list('T1', 'opus2').length, 1);
});
