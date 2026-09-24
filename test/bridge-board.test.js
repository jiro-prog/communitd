import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskBoardStore } from '../src/board.js';
import { approvalItem, createBoardWiring, joinNote, reviewTarget } from '../src/bridge/board.js';
import { readContractNonce } from '../src/contract.js';
import { HopTracker } from '../src/hops.js';
import { SEND_BACK_JOB_BUDGET } from '../src/scheduler.js';
import { ContractStore } from '../src/store.js';

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
    channelName: 'kt', cwd: repo, repoRoot: repo,
    // baseBranch は fixture の初期ブランチと揃える (merge の照合はここを見る)
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

test('noteTaskCompletion: 担当のフッタ無し report だけがレビューへ進み、それ以外は理由つきで見送る', async (t) => {
  const h = harness(t);
  h.started();
  const base = { thread: h.thread, cc: h.cc, contractOut: { kind: 'report' }, mention: null, verifyResult: null };

  assert.equal(await h.noteTaskCompletion({ ...base, bot: h.bot('opus'), mention: { kind: 'handoff', userId: 'F' } }), false);
  assert.equal(await h.noteTaskCompletion({ ...base, bot: h.bot('opus'), verifyResult: { ok: false } }), false);
  assert.equal(h.board.get('1').state, 'in-progress');

  assert.equal(await h.noteTaskCompletion({ ...base, bot: h.bot('fable') }), false);
  assert.equal(h.thread.sent.at(-1).content, '⚠️ 担当 (opus) 以外の報告なので完了とは数えません — 続きは担当をメンションしてください');
  assert.equal(h.board.get('1').state, 'in-progress');

  assert.equal(await h.noteTaskCompletion({ ...base, bot: h.bot('opus') }), true);
  assert.equal(h.board.get('1').state, 'review');
  assert.equal(h.thread.sent.at(-1).content, '🔎 タスク #1 をレビューへ進めました\n→ Opus2 にレビューをお願いしました');
  assert.equal(h.contracts.list('T1', 'opus2').length, 1);

  const noBoard = harness(t, { withBoard: false });
  assert.equal(await noBoard.noteTaskCompletion({ ...base, thread: noBoard.thread, cc: noBoard.cc, bot: noBoard.bot('opus') }), false);
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
    `🎉 タスク #1 を merged にしました (merge ${mergeSha} (base master@${mergeSha}, branch task/1@${tip}))`
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

test('applyReview: 取り込みを照合できない merge は review のまま (ボードも枝も動かさない)', async (t) => {
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

test('applyReview: 検収担当でない bot と実装した本人の判定は適用しない', async (t) => {
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

test('applyReview: 適用 task の merge は receipt の commit と一致しないと適用しない', async (t) => {
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
  // 既にあるタスクと同じファイルを掴む起票は載せない
  const dup = await h.fileProposal({ contract: { body: 'x', tasks: [{ title: 'A2', rationale: 'r', touch: ['a.py'] }] }, cc: h.cc, bot: h.bot('opus'), thread: h.thread });
  assert.match(dup, /^🌱 起票できたものはありません\n⚠️ 載せられなかったもの: A2: /);

  const noBoard = harness(t, { withBoard: false });
  assert.match(await noBoard.fileProposal({ contract, cc: noBoard.cc, bot: noBoard.bot('opus'), thread: noBoard.thread }), /^⚠️ 起票を受け取りましたが、このプロセスはボードを持っていません/);
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
