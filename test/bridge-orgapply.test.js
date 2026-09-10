import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APPLY_BY, createOrgApplyWiring, verifyFailureDetail } from '../src/bridge/orgapply.js';
import { canonicalCwd } from '../src/grants.js';
import { HopTracker } from '../src/hops.js';

// src/bridge/orgapply.js — org-apply (§3.9) の実体の解決: 適用チャンネル・git・Discord のスレッド。
// 順序の層 (src/orgapply-wiring.js) は本物だが、ここでは配線が結ぶ実体だけを見る。

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

function harness(t, { config = null, proposals = null, board = null } = {}) {
  const io = captureConsole(t);
  const repo = mkdtempSync(join(tmpdir(), 'communitd-orgapply-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '--initial-branch=master');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');

  const threads = [];
  const channel = {
    id: 'C-dev',
    threads: {
      create: async ({ name }) => {
        const thread = { id: `T${threads.length + 1}`, name, sent: [], send: async (payload) => { thread.sent.push(payload); return { id: 'm' }; } };
        threads.push(thread);
        return thread;
      },
    },
  };
  const bots = new Map([
    ['fable', { key: 'fable', userId: 'F', cfg: { displayName: 'Fable' }, client: {} }],
    ['opus2', { key: 'opus2', userId: 'O2', cfg: { displayName: 'Opus2' }, client: {} }],
  ]);
  const hops = new HopTracker(12, 3);
  const posted = [];
  const wiring = createOrgApplyWiring({
    config: config ?? { guildId: 'G', channels: {} },
    root: repo,
    proposals,
    board,
    bots,
    hops,
    findGuildChannel: (client, name) => (name === 'dev' ? channel : null),
    safeProposalContext: () => null,
    resolveApplyBaseCommit: async () => null,
    postToProposal: async (proposal, text, opts) => { posted.push([proposal.id, text, opts]); return 'T-proposal'; },
    requestReview: async () => ({ ok: true, note: '→ 検収' }),
  });
  return { ...io, repo, git, channel, threads, bots, hops, posted, ...wiring };
}

test('APPLY_BY はブリッジ (人でも bot でもない記録者)', () => {
  assert.equal(APPLY_BY, 'bridge');
});

test('verifyFailureDetail は末尾 400 字だけ (無ければ「詳細なし」)', () => {
  assert.equal(verifyFailureDetail({}), '(詳細なし)');
  assert.equal(verifyFailureDetail({ output: '  失敗した  ' }), '失敗した');
  assert.equal(verifyFailureDetail({ error: 'E', output: 'O' }), 'E', 'error を output より優先していない');
  assert.equal(verifyFailureDetail({ error: 'x'.repeat(500) }).length, 400);
});

test('applyChannelConfig は適用チャンネルの cwd を本体の正規形へ寄せる (設定が無ければ null)', (t) => {
  const none = harness(t);
  assert.equal(none.applyChannelConfig(), null);

  const missing = harness(t, {
    config: { initiative: { applyChannel: 'dev' }, channels: { dev: { cwd: join(tmpdir(), 'communitd-no-such-dir') } } },
  });
  assert.equal(missing.applyChannelConfig(), null);
  assert.ok(missing.errors.some((e) => e.startsWith('[org-apply] dev: 作業ディレクトリを解決できません')), missing.errors.join('\n'));

  const ok = harness(t);
  const configured = harness(t, { config: { initiative: { applyChannel: 'dev' }, channels: { dev: { cwd: ok.repo, verify: 'npm test' } } } });
  const cc = configured.applyChannelConfig();
  assert.equal(cc.channelName, 'dev');
  assert.equal(cc.cwd, canonicalCwd(ok.repo));
  assert.equal(cc.repoRoot, cc.cwd, '契約の cwd (本体) と実行の cwd が食い違う');
  assert.equal(cc.verify, 'npm test');
});

test('releaseApplyWorktree は撤去と枝の削除を別々に試し、失敗しても投げずに 1 行にする', async (t) => {
  const h = harness(t);
  h.git('branch', 'apply/5');
  assert.equal(await h.releaseApplyWorktree({ id: '5', branch: 'apply/5' }), '🧹 作業ツリーは既にありません (ブランチ apply/5 も削除)');
  assert.equal(h.git('branch', '--list', 'apply/5'), '');
  const kept = await h.releaseApplyWorktree({ id: '6', branch: 'apply/6' });
  assert.match(kept, /^🧹 作業ツリーは既にありません \(ブランチ apply\/6 は残しました: /);
});

test('createApplyThread は applyChannel にスレッドを立て、予算を先に配り、検収だけを担う旨を案内する', async (t) => {
  const h = harness(t);
  const cc = { channelName: 'dev' };
  const task = { id: '7', jobBudget: 4, title: 'apply' };
  const proposal = { id: '3', class: 'process', input: { kind: 'process-edit', change: { touch: ['docs/a.md', 'docs/b.md'] } } };
  const threadId = await h.createApplyThread({ cc, announcer: h.bots.get('fable'), task, proposal });
  assert.equal(threadId, 'T1');
  assert.equal(h.hops.taskBudget('T1'), 4, '予算を配っていない (門番ごと不在のスレッドになる)');
  const [notice] = h.threads[0].sent;
  assert.match(notice.content, /^🏛 提案 #3 \(process \/ process-edit\) を当てます。\n対象: docs\/a\.md \/ docs\/b\.md\n/);
  assert.match(notice.content, /diff の検収だけ/);
  assert.deepEqual(notice.allowedMentions.users, []);

  await assert.rejects(
    () => h.createApplyThread({ cc: { channelName: 'nope' }, announcer: h.bots.get('fable'), task, proposal }),
    /チャンネル nope を取得できません/,
  );
});

test('reportOrgApply は同じ理由を毎 tick 撒かず、要人間なら owner をメンションする', async (t) => {
  const h = harness(t);
  const proposal = { id: '3', class: 'process' };
  const stuck = { ok: false, stage: 'prepare', reason: 'lane 不備', attempts: 1 };
  await h.reportOrgApply(proposal, stuck, { channelName: 'dev' });
  await h.reportOrgApply(proposal, stuck, { channelName: 'dev' });
  assert.equal(h.posted.length, 1, '同じ理由を繰り返している');
  assert.match(h.posted[0][1], /^🏛 提案 #3 \(process\) は当てられません: lane 不備$/);
  assert.equal(h.posted[0][2].mentionOwner, false);

  await h.reportOrgApply(proposal, { ...stuck, attempts: 2 }, { channelName: 'dev' });
  assert.equal(h.posted.length, 2, '試行回数が進んだのに出していない');

  await h.reportOrgApply(proposal, { ok: false, stage: 'prepare', reason: '要判断', attempts: 3, escalate: true }, { channelName: 'dev' });
  assert.equal(h.posted.at(-1)[2].mentionOwner, true);

  // prepare 以外の結果は毎回出す (記録を捨てるので、次に同じ prepare の理由が来ればまた出る)
  await h.reportOrgApply(proposal, { ok: false, stage: 'apply', reason: 'verify NG', taskId: '1' }, { channelName: 'dev' });
  await h.reportOrgApply(proposal, { ok: false, stage: 'apply', reason: 'verify NG', taskId: '1' }, { channelName: 'dev' });
  assert.equal(h.posted.length, 5);
  assert.ok(h.logs.some((l) => l.startsWith('[org-apply] 🏛 提案 #3 (process) の適用に失敗しました (apply): verify NG')), h.logs.join('\n'));
});

test('sweepOrgApply は発議機構かボードが無ければ何もしない', async (t) => {
  const h = harness(t);
  await h.sweepOrgApply(Date.now());
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.errors, []);
});
