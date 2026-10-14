import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPLY_BY, COMMON_ROLE_FILE, createOrgApplyWiring, policyErrorReason, verifyFailureDetail,
} from '../src/bridge/orgapply.js';
import { TaskBoardStore } from '../src/board.js';
import { POLICY_FILE } from '../src/config.js';
import { canonicalCwd } from '../src/grants.js';
import { HopTracker } from '../src/hops.js';
import { ProposalStore } from '../src/proposals.js';

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

function harness(t, {
  config = null, proposals = null, board = null,
  contractKindOf = null, runVerifyImpl = undefined,
} = {}) {
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
    contractKindOf,
    ...(runVerifyImpl ? { runVerifyImpl } : {}),
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

// ---- 書く前の検証 (起動できない設定を commit しない) ----

/** 宣言つきの役割文 (起動時検証はこのマーカーを読む) */
const DECLARED = ['<!-- communitd-protocol: 2 -->', '<!-- communitd-schema: report -->', '# 役割', ''].join('\n');
/** 宣言の無い役割文 */
const UNDECLARED = ['<!-- communitd-protocol: 2 -->', '# 役割', ''].join('\n');

/**
 * 起動時検証を通る policy。**manager に duty がある**ので、起動時検証は
 * manager の役割文のスキーマ宣言まで読む (`validateStructuredRoles`)。
 */
const VALID_POLICY = {
  bots: {
    manager: {
      tokenEnv: 'MANAGER_DISCORD_TOKEN',
      displayName: 'Manager',
      model: 'opus',
      rolePromptFile: 'roles/manager.md',
      duties: { board: { intervalMin: 60 } },
    },
    worker: {
      tokenEnv: 'WORKER_DISCORD_TOKEN',
      displayName: 'Worker',
      model: 'sonnet',
      rolePromptFile: 'roles/worker.md',
    },
  },
  channels: { dev: { cwd: 'C:/tmp', structuredOutput: true, verify: 'npm test', hooks: true, autonomy: { enabled: true } } },
  initiative: { enabled: true },
};
/** 合成後 (= 走っているブリッジが持っている形)。secrets 側のキーが乗っている */
const MERGED = { ...VALID_POLICY, guildId: 'G', allowedUserIds: ['U1'], ownerUserId: 'U1' };
const policyText = (policy) => `${JSON.stringify(policy, null, 2)}\n`;
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 基点 (枝の `git show <基点>:<パス>` が返すもの) */
const BASE_FILES = {
  [POLICY_FILE]: policyText(VALID_POLICY),
  [COMMON_ROLE_FILE]: DECLARED,
  'roles/manager.md': DECLARED,
  'roles/worker.md': DECLARED,
};

/** `validateApplied(applied)` — 基点は BASE_FILES から返す (実行層が渡す口) */
function validateFor(t, { base = BASE_FILES, config = MERGED } = {}) {
  const read = [];
  const validate = harness(t, { config }).orgApplyDeps({ channelName: 'dev' }).validateApplied;
  const run = (applied) => validate({
    applied,
    readBase: async (path) => { read.push(path); return base[path] ?? null; },
  });
  run.read = read;
  return run;
}

test('policy にも役割文にも当たらない適用は素通しする (検証するものが無い)', async (t) => {
  const validate = validateFor(t);
  assert.deepEqual(await validate({ 'docs/handbook.md': '手順\n' }), { ok: true });
  assert.deepEqual(await validate({ 'docs/handbook.md': null }), { ok: true });
  // 役割文かどうかは**基点の policy**を読んでから決める (走っている設定と違いうる)
  assert.deepEqual(validate.read, [POLICY_FILE, POLICY_FILE]);
});

test('適用後の policy は今の secrets と合成して起動時検証へ通す', async (t) => {
  const validate = validateFor(t);
  assert.deepEqual(await validate({ [POLICY_FILE]: policyText(VALID_POLICY) }), { ok: true });

  // JSON として壊れている (全体置換の diff は構文を見ない)
  const broken = await validate({ [POLICY_FILE]: '{ "bots": ' });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /^適用後の config\.policy\.json を JSON として読めません: /);

  // 必須キーの欠落 = 次の起動が exit 1 になる形
  const noModel = clone(VALID_POLICY);
  delete noModel.bots.worker.model;
  const missing = await validate({ [POLICY_FILE]: policyText(noModel) });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /^適用後の設定は起動時検証を通りません:\n- bots\.worker\.model が要る/);

  // displayName の重複も起動時検証で落ちる (この経路でも当てない)
  const dup = clone(VALID_POLICY);
  dup.bots.worker.displayName = 'Manager';
  const clash = await validate({ [POLICY_FILE]: policyText(dup) });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /displayName が重複/);

  // secrets 側のキーを policy へ書く提案も通さない (分離を提案で崩せない)
  const leaked = await validate({ [POLICY_FILE]: policyText({ ...VALID_POLICY, guildId: 'G' }) });
  assert.equal(leaked.ok, false);
  assert.match(leaked.reason, /config\.policy\.json に置けないキー: guildId/);

  // policy を消す提案は「検証を通る形にならない」ので当てない
  const removed = await validate({ [POLICY_FILE]: null });
  assert.equal(removed.ok, false);
  assert.match(removed.reason, /config\.policy\.json を消す提案は当てません/);

  // 綴りの照合は提案側と同じ緩さ (大小文字だけ違う綴りで検証を素通りさせない)
  const cased = await validate({ 'Config.Policy.JSON': '{ "bots": ' });
  assert.equal(cased.ok, false);
  assert.match(cased.reason, /JSON として読めません/);

  // policy が applied にあるなら基点は読まない (当てるのは applied の内容)
  assert.equal(validate.read.includes(POLICY_FILE), false, 'applied にあるのに基点も読んでいる');
});

test('基点を読めなくても落ちない (読めないファイルは「無い」扱い)', async (t) => {
  const validate = harness(t, { config: MERGED }).orgApplyDeps({ channelName: 'dev' }).validateApplied;
  const out = await validate({
    applied: { [POLICY_FILE]: policyText(VALID_POLICY) },
    readBase: async () => { throw new Error('git show が落ちた'); },
  });
  // 役割文を読めない = 宣言が無い扱い。duty を持つ bot で落ちる (fail-closed)
  assert.equal(out.ok, false);
  assert.match(out.reason, /bots\.manager の役割文にスキーマ宣言/);
});

// ---- 役割文の宣言は「適用後の内容」で読む (Opus2 レビュー M1 / M2) ----

test('同じ diff で役割文を新設する提案は通る (ROOT にも基点にも無くてよい)', async (t) => {
  // role-create = policy の EDIT + `roles/<slug>.md` の CREATE。宣言は**その diff の中**に
  // しか無いので、ROOT の現ファイルを読んでいると「宣言が無い」と偽に落ちる
  const validate = validateFor(t);
  const after = clone(VALID_POLICY);
  after.bots.scout = {
    tokenEnv: 'SCOUT_DISCORD_TOKEN',
    displayName: 'Scout',
    model: 'sonnet',
    rolePromptFile: 'roles/scout.md',
    duties: { watch: { intervalMin: 120 } },
  };

  assert.deepEqual(
    await validate({ [POLICY_FILE]: policyText(after), 'roles/scout.md': DECLARED }),
    { ok: true },
  );

  // 宣言を書き忘れた同じ提案は落ちる (検証そのものは効いている)
  const undeclared = await validate({ [POLICY_FILE]: policyText(after), 'roles/scout.md': UNDECLARED });
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.reason, /bots\.scout の役割文にスキーマ宣言/);
});

test('宣言の無い役割文へ、同じ diff で宣言を足しつつ duty を付ける提案も通る', async (t) => {
  // 基点の役割文には宣言が無い。適用後の内容で読めば通り、基点で読むと落ちる
  const validate = validateFor(t, { base: { ...BASE_FILES, 'roles/worker.md': UNDECLARED } });
  const after = clone(VALID_POLICY);
  after.bots.worker.duties = { audit: { intervalMin: 240 } };

  assert.deepEqual(
    await validate({ [POLICY_FILE]: policyText(after), 'roles/worker.md': DECLARED }),
    { ok: true },
  );
  // 役割文を直さずに duty だけ付ける提案は落ちる (基点のまま = 宣言が無い)
  const only = await validate({ [POLICY_FILE]: policyText(after) });
  assert.equal(only.ok, false);
  assert.match(only.reason, /bots\.worker の役割文にスキーマ宣言/);
});

test('役割文だけを触る提案も検証する (宣言を消す提案は当てない)', async (t) => {
  // policy を触らないので素通りしていた。**同じ exit 1 を別経路で作れる**穴
  const validate = validateFor(t);
  const stripped = await validate({ 'roles/manager.md': UNDECLARED });
  assert.equal(stripped.ok, false, '宣言を消す提案が素通りしている');
  assert.match(stripped.reason, /bots\.manager の役割文にスキーマ宣言/);
  // 基点から読むのは policy・共通規定と、**適用に含まれていない**役割文だけ
  // (manager の役割文は applied にあるので基点へ落とし直さない)
  assert.deepEqual(validate.read, [POLICY_FILE, COMMON_ROLE_FILE, 'roles/worker.md']);

  // duty を持たない bot の役割文なら、宣言が無くても起動はできる (落とさない)
  assert.deepEqual(await validate({ 'roles/worker.md': UNDECLARED }), { ok: true });
  // 役割文の削除も「適用後の姿」で見る (基点へ落とし直さない)
  const deleted = await validate({ 'roles/manager.md': null });
  assert.equal(deleted.ok, false);
  assert.match(deleted.reason, /bots\.manager の役割文にスキーマ宣言/);
});

test('policy を追跡していない配備では、走っている設定で役割文だけを検証する', async (t) => {
  // 公開スナップショットを写した形 (config.policy.json は git に無い)。基点から policy を
  // 読めないからといって検証ごと落とすと、役割文の穴が開いたままになる
  const validate = validateFor(t, { base: { 'roles/manager.md': DECLARED } });
  const stripped = await validate({ 'roles/manager.md': UNDECLARED });
  assert.equal(stripped.ok, false);
  assert.match(stripped.reason, /bots\.manager の役割文にスキーマ宣言/);
  assert.deepEqual(await validate({ 'docs/handbook.md': '手順\n' }), { ok: true });
});

test('基点の policy が壊れていたら、役割文だけの提案でも当てない (読めないのとは別)', async (t) => {
  // **「読めない」と「壊れている」を混ぜない。** 混ぜて走っている config へ倒すと、
  // 「基点が壊れていれば落とす」という裁定が policy を触る提案でしか効かない
  // (Opus2 指摘 2026-09-12 Major)
  const broken = { ...BASE_FILES, [POLICY_FILE]: '{ "bots": ' };
  const brokenJson = await validateFor(t, { base: broken })({ 'roles/manager.md': DECLARED });
  assert.equal(brokenJson.ok, false, '壊れた基点の上に当ててしまう');
  assert.match(brokenJson.reason, /^基点の config\.policy\.json が壊れています — .*JSON として読めません/);

  // secrets 側のキーが基点の policy に混ざっている形も同じ (次の起動が落ちる)
  const leaked = { ...BASE_FILES, [POLICY_FILE]: policyText({ ...VALID_POLICY, guildId: 'G' }) };
  const out = await validateFor(t, { base: leaked })({ 'roles/manager.md': DECLARED });
  assert.equal(out.ok, false);
  assert.match(out.reason, /^基点の config\.policy\.json が壊れています — /);
  assert.match(out.reason, /置けないキー: guildId/);
});

test('対象の判定は基点の policy で行う (/restart 前に merge 済みの bot も拾う)', async (t) => {
  // 先の適用で bot が増えたが、走っているブリッジはまだ旧 config — このプロジェクトの常態。
  // 走っている config の bots で対象を決めると、その bot の役割文は素通りする
  const scoutPolicy = clone(VALID_POLICY);
  scoutPolicy.bots.scout = {
    tokenEnv: 'SCOUT_DISCORD_TOKEN',
    displayName: 'Scout',
    model: 'sonnet',
    rolePromptFile: 'roles/scout.md',
    duties: { watch: { intervalMin: 120 } },
  };
  const validate = validateFor(t, {
    base: { ...BASE_FILES, [POLICY_FILE]: policyText(scoutPolicy), 'roles/scout.md': DECLARED },
    config: MERGED, // 走っているブリッジは scout を知らない
  });

  const stripped = await validate({ 'roles/scout.md': UNDECLARED });
  assert.equal(stripped.ok, false, '走っている config の bots で対象を決めている');
  assert.match(stripped.reason, /bots\.scout の役割文にスキーマ宣言/);
});

test('役割文のプロトコル版を壊す提案も当てない (共通規定も対象)', async (t) => {
  // 起動時検証は通るのに、merge 後はその bot の job が全部 protocol-mismatch で起動しなく
  // なる (src/bridge/job.js)。本文はもう手元にあるので同じループで見る
  const validate = validateFor(t, { base: { ...BASE_FILES, [COMMON_ROLE_FILE]: DECLARED } });

  const old = await validate({ 'roles/manager.md': DECLARED.replace('protocol: 2', 'protocol: 1') });
  assert.equal(old.ok, false, 'プロトコル版を落とす提案が通ってしまう');
  assert.match(old.reason, /bots\.manager の役割文 roles\/manager\.md: .*プロトコル版 1 /);

  // マーカーごと消す提案も同じ (宣言が無い役割文は旧記法かもしれない)
  const gone = await validate({ 'roles/worker.md': '# 役割\n' });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /bots\.worker の役割文 roles\/worker\.md: .*プロトコル版の宣言がありません/);

  // **共通規定は誰の rolePromptFile でもない** — 名指しで対象に入れないと素通りする
  // (壊れると全 bot の job が止まる)
  const common = await validate({ [COMMON_ROLE_FILE]: '# 共通規定\n' });
  assert.equal(common.ok, false, '共通規定が対象判定に入っていない');
  assert.match(common.reason, /^適用後の設定は起動時検証を通りません:\n- roles\/_common\.md: /);
});

test('参照中の役割文を消す提案は当てない (基点に無いだけなら寛容)', async (t) => {
  // 消えた役割文は起動時検証では見えない (config.js は fs を持たない) が、merge 後は
  // job.js の readFileSync が落ちて role-unreadable になる。duty の無い bot でも同じ
  const validate = validateFor(t);

  const gone = await validate({ 'roles/worker.md': null });
  assert.equal(gone.ok, false, '参照中の役割文を消す提案が通ってしまう');
  assert.match(gone.reason, /bots\.worker の役割文 roles\/worker\.md が適用後に存在しません/);
  assert.match(gone.reason, /bots\.worker も消してください/, '直し方が出ていない');

  // 共通規定なら全 bot が止まる
  const common = await validate({ [COMMON_ROLE_FILE]: null });
  assert.equal(common.ok, false);
  assert.match(common.reason, /roles\/_common\.md が適用後に存在しません \(全 bot の job が起動できなくなります\)/);

  // **bot ごと退ける提案は通る** (適用後の policy が参照していないファイルは見ない)
  const retired = clone(VALID_POLICY);
  delete retired.bots.worker;
  assert.deepEqual(
    await validate({ [POLICY_FILE]: policyText(retired), 'roles/worker.md': null }),
    { ok: true },
  );

  // 基点に無いだけ (この適用は触っていない) なら従来どおり寛容
  // — policy も roles も追跡していない配備を止めない
  const untracked = validateFor(t, { base: { [POLICY_FILE]: policyText(VALID_POLICY), 'roles/manager.md': DECLARED } });
  assert.deepEqual(await untracked({ 'roles/manager.md': DECLARED }), { ok: true });
});

test('policyErrorReason は全行を並べる (切るのは台帳と表示側)', () => {
  assert.equal(
    policyErrorReason(['A が要る', 'B が要る']),
    '適用後の設定は起動時検証を通りません:\n- A が要る\n- B が要る',
  );
});

// ---- 停止 (適用の verify は job ではない) ----

/**
 * 3 秒眠るだけの検証コマンド。**撃てなくても 3 秒で自然に終わる**ので、killTree が
 * 効かない環境でもテストが固まらない (中断の印は runVerify 側に残る)。
 */
const SLEEP_COMMAND = `"${process.execPath}" -e "setTimeout(() => {}, 3000)"`;

test('適用の verify には handle を渡す (渡さないと停止で撃てない)', async (t) => {
  const seen = [];
  const h = harness(t, {
    config: MERGED,
    runVerifyImpl: async (opts) => { seen.push(opts); return { ok: true }; },
  });
  const deps = h.orgApplyDeps({ channelName: 'dev', verify: 'npm test' });

  assert.deepEqual(await deps.verify('C:/wt'), { ok: true, detail: '' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'npm test');
  assert.equal(seen[0].cwd, 'C:/wt');
  assert.deepEqual(seen[0].scrubEnvKeys, ['MANAGER_DISCORD_TOKEN', 'WORKER_DISCORD_TOKEN']);
  assert.equal(typeof seen[0].handle, 'object', 'handle を渡していない (停止で撃てない)');

  // verify を持たないチャンネルでは走らせない (検証できない適用は記録しない)
  assert.deepEqual(await h.orgApplyDeps({ channelName: 'dev' }).verify('C:/wt'), {
    ok: false, detail: 'verify 未設定 (検証できない適用は記録しません)',
  });
  assert.equal(seen.length, 1);
});

test('走っている verify は abortVerify で撃てて、以後の verify も走らせない', async (t) => {
  const h = harness(t, { config: MERGED });
  const deps = h.orgApplyDeps({ channelName: 'dev', verify: SLEEP_COMMAND });

  assert.equal(h.abortVerify(), false, '走っていないのに撃ったことにしている');

  const running = deps.verify(h.repo);
  assert.equal(h.abortVerify(), true, '走っている verify を掴んでいない');
  const out = await running;
  assert.equal(out.ok, false, '中断を成功として返している (receipt ができてしまう)');
  assert.match(out.detail, /停止指示により中断/);

  // 停止が始まった後は次の verify も走らせない (exit までの数秒で子ツリーを増やさない)
  const started = Date.now();
  const next = await deps.verify(h.repo);
  assert.equal(next.ok, false);
  assert.match(next.detail, /停止指示により中断/);
  assert.ok(Date.now() - started < 2000, '停止後に検証を走らせている');
});

test('停止が始まったら新しい適用を始めない (tick は job の受付の門を見ていない)', async (t) => {
  // 撃てるのは走っている verify だけ。停止の合図から exit までの数秒で新しい適用を
  // 始めると、task・スレッド・作業ツリー・コミットまで作ってから verify で即失敗し、
  // 提案の試行を 1 回食う (Opus2 指摘 2026-09-12 M3)
  const host = harness(t); // 実在する cwd を借りる
  const dir = mkdtempSync(join(tmpdir(), 'communitd-orgapply-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  const touched = [];
  const spy = (target) => new Proxy(target, {
    get: (obj, prop) => {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return (...args) => { touched.push(String(prop)); return value.apply(obj, args); };
    },
  });
  const h = harness(t, {
    config: {
      ...MERGED,
      initiative: { ...MERGED.initiative, applyChannel: 'dev' },
      channels: { dev: { ...MERGED.channels.dev, cwd: host.repo } },
    },
    proposals: spy(new ProposalStore(join(dir, 'proposals.json'))),
    board: spy(new TaskBoardStore(join(dir, 'tasks.json'))),
  });

  await h.sweepOrgApply(Date.now());
  assert.ok(touched.length > 0, '前提: 通常の tick は提案台帳を読む');

  touched.length = 0;
  h.abortVerify();
  await h.sweepOrgApply(Date.now());
  assert.deepEqual(touched, [], '停止後の tick が適用回路へ入っている');
});

test('sweepOrgApply は発議機構かボードが無ければ何もしない', async (t) => {
  const h = harness(t);
  await h.sweepOrgApply(Date.now());
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.errors, []);
});
