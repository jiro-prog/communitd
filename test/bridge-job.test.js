import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANDOFF_FILE, createJobRunner, handoffFileFor } from '../src/bridge/job.js';
import { createRunRecorder } from '../src/bridge/recorder.js';
import { resolveAllowedTools, resolveCodexSandbox, resolvePermissionMode } from '../src/config.js';
import { SCHEMAS } from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { JobRunStore } from '../src/jobruns.js';
import { RosterStore } from '../src/roster.js';
import { SessionStore } from '../src/store.js';

// src/bridge/job.js — job 1 本の実行 (runJob)。ランタイム (claude / codex) と配送 (postTurn) を偽物にし、
// role の組み立て・契約の適用・claudeOpts (effort を含む) の中身・セッションの保存を固定する。
// 「effort の配線はテストで固定していない」(2026-08-05 の保留裁定) をここで解消する。

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

const PROTOCOL = '<!-- communitd-protocol: 2 -->';
const OK_RESULT = () => ({
  ok: true, result: 'done', sessionId: 'S1',
  usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1, outputTokens: 3 },
  permissionDenials: [],
});
const ROLE_SEP = '\n\n---\n\n';

function harness(t, {
  runtime = 'claude',
  effort = 'low',
  roleText = `${PROTOCOL}\n# Fable の職務\n`,
  commonText = `${PROTOCOL}\n# 共通規定\n`,
  rolePromptFile = 'roles/fable.md',
  responses = [],
  cc: ccOver = {},
  applyIncomingContract = () => ({ kind: null, contract: null, narrowed: null, stop: null }),
  claimContractKindOverride = () => null,
  turnResult = { delivered: true, handedOff: false, failures: [], handoff: null, taskSubmitted: false },
  buildPrompt = null,
  brokenSessions = false,
} = {}) {
  const io = captureConsole(t);
  const root = mkdtempSync(join(tmpdir(), 'communitd-job-root-'));
  const work = mkdtempSync(join(tmpdir(), 'communitd-job-cwd-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'roles'));
  writeFileSync(join(root, 'roles', '_common.md'), commonText);
  writeFileSync(join(root, 'roles', 'fable.md'), roleText);
  const cwd = canonicalCwd(work);
  const config = {
    claudeBin: 'claude-test',
    codexCmd: 'codex-test',
    bots: {
      fable: { tokenEnv: 'FABLE_TOKEN', displayName: 'Fable', model: 'claude-opus-4', effort, rolePromptFile, runtime },
    },
    limits: {},
  };
  // 読めない sessions.json は退避せずその場に残る (§12.3 (1))。**読むのは構築時**なので、
  // store を作る前に壊しておく
  if (brokenSessions) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'sessions.json'), '{ broken');
  }
  const store = new SessionStore(join(root, 'data', 'sessions.json'));
  const roster = new RosterStore(join(root, 'data', 'roster.json'));
  const jobRuns = new JobRunStore(join(root, 'data', 'job-runs.json'));
  const calls = { claude: [], codex: [], prompts: [], turns: [], flows: [] };
  const queue = [...responses];
  const runner = createJobRunner({
    config,
    root,
    commonRolePath: join(root, 'roles', '_common.md'),
    store,
    roster,
    jobRuns,
    board: null,
    limits: {
      maxApprovalCards: 3, approvalWaitMs: 1000, approvalHookTools: ['WebFetch'], maxSelfHops: 3,
      maxStdoutBytes: 1024, quietWindowMs: 3000, quietWaitMaxMs: 15000,
    },
    ownerTargets: [{ userId: 'U1', displayName: 'So' }],
    runRecorder: createRunRecorder({ jobRuns }),
    approvedRulesFor: () => [],
    applyIncomingContract,
    claimContractKindOverride,
    buildPrompt: buildPrompt ?? (async (bot, triggerMsg, thread, entry, includeSelf) => {
      calls.prompts.push({ entry, includeSelf });
      return { prompt: 'PROMPT', lastSeenId: 'M1', images: [], contextMessages: 2, omittedMessages: 0 };
    }),
    isInfraMessage: () => false,
    postTurn: async (thread, bot, cc, res, gitBefore, placeholder, effectiveRoster, extra) => {
      calls.turns.push({ res, extra, effectiveRoster });
      return turnResult;
    },
    fileProposal: async (p) => { calls.flows.push(['fileProposal', p]); return '🌱 起票'; },
    applyApproval: (p) => { calls.flows.push(['applyApproval', p]); return '✅ 承認'; },
    applyReview: async (p) => { calls.flows.push(['applyReview', p]); return '🎉 判定'; },
    applyProposalAdjudication: async (p) => { calls.flows.push(['applyProposalAdjudication', p]); return '🏛 裁定'; },
    raiseProposal: async (p) => { calls.flows.push(['raiseProposal', p]); return '🏛 発議'; },
    decideApproval: async () => ({ decision: 'deny', reason: 'test' }),
    botEntries: () => [{ key: 'fable', displayName: 'Fable', userId: 'F' }],
    runClaude: async (opts) => {
      // role は一時ファイル経由で渡る (finally で消えるので、ここで読んで残す)
      const roleTextSent = existsSync(opts.rolePromptFile) ? readFileSync(opts.rolePromptFile, 'utf8') : null;
      const settings = opts.settingsFile ? JSON.parse(readFileSync(opts.settingsFile, 'utf8')) : null;
      calls.claude.push({ ...opts, roleTextSent, settings });
      opts.onSpawn?.({ pid: 1234, runtime: 'claude' });
      return queue.shift() ?? OK_RESULT();
    },
    runCodex: async (opts) => {
      calls.codex.push(opts);
      return queue.shift() ?? { ok: true, result: 'codex done' };
    },
  });
  const bot = { key: 'fable', cfg: config.bots.fable, userId: 'F' };
  const cc = { channelName: 'kt', cwd, repoRoot: cwd, hooks: false, structuredOutput: true, ...ccOver };
  let seq = 0;
  const run = async ({ triggerMsg = { author: { bot: true }, content: '<@F>' }, handle = { stopRequested: false }, claimed = { entry: null, error: null } } = {}) => {
    const id = `j${++seq}`;
    jobRuns.open({ id, threadId: 'T1', botKey: 'fable', channelName: 'kt', cwd });
    jobRuns.start(id);
    const thread = { id: 'T1', sendTyping: async () => {}, messages: { fetch: async () => new Map() } };
    const placeholder = { edits: [], deleted: false, edit: async (p) => { placeholder.edits.push(p); }, delete: async () => { placeholder.deleted = true; } };
    const metrics = {};
    const outcome = {};
    const reason = await runner.runJob(bot, triggerMsg, thread, cc, placeholder, handle, metrics, claimed, createRunRecorder({ jobRuns })(id), outcome);
    return { reason, metrics, outcome, placeholder, record: jobRuns.get(id) };
  };
  return { ...io, root, cwd, config, store, jobRuns, calls, cc, bot, run, runner };
}

test('claude: role を 3 段で組み、effort を含む claudeOpts を渡し、成功したらセッションと既読位置を保存する', async (t) => {
  const h = harness(t);
  const out = await h.run();

  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 1);
  const opts = h.calls.claude[0];
  assert.equal(opts.effort, 'low', 'bots.<key>.effort が claudeOpts へ渡っていない');
  assert.equal(opts.model, 'claude-opus-4');
  assert.equal(opts.claudeBin, 'claude-test');
  assert.equal(opts.cwd, h.cwd);
  assert.equal(opts.permissionMode, resolvePermissionMode(h.cc));
  assert.deepEqual(opts.allowedTools, resolveAllowedTools(h.cc, []));
  assert.equal(opts.tools, null);
  assert.deepEqual(opts.disallowedTools, []);
  assert.equal(opts.strictMcp, false);
  assert.equal(opts.settingSources, null);
  assert.equal(opts.jsonSchema, null, '様式を宣言していない role にスキーマを渡している');
  assert.deepEqual(opts.addDirs, []);
  assert.equal(opts.timeoutMs, 3600000);
  assert.equal(opts.maxStdoutBytes, 1024);
  assert.deepEqual(opts.scrubEnvKeys, ['FABLE_TOKEN']);
  assert.equal(opts.resume, false);
  assert.equal(opts.sessionId, undefined);
  assert.equal(opts.prompt, 'PROMPT');
  assert.deepEqual(opts.images, []);
  assert.equal(opts.settingsFile, undefined, 'hooks を切ったチャンネルで settings を渡している');
  // role = 共通規定 + 役割文 + 実行文脈
  const parts = opts.roleTextSent.split(ROLE_SEP);
  assert.equal(parts.length, 3, opts.roleTextSent);
  assert.match(parts[0], /^<!-- communitd-protocol: 2 -->\n# 共通規定$/);
  assert.match(parts[1], /^<!-- communitd-protocol: 2 -->\n# Fable の職務$/);
  assert.match(parts[2], /kt/, '実行文脈にチャンネル名が無い');
  assert.equal(existsSync(opts.rolePromptFile), false, 'role のスナップショットを消していない');

  assert.deepEqual(h.store.get('T1', 'fable'), { sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1' });
  assert.equal(out.metrics.promptChars, opts.roleTextSent.length + 'PROMPT'.length);
  assert.equal(out.metrics.rolePromptChars, opts.roleTextSent.length);
  assert.equal(out.metrics.contextMessages, 2);
  assert.equal(out.metrics.inputTokens, 10);
  assert.equal(out.metrics.cacheReadTokens, 5);
  assert.equal(out.metrics.cacheWriteTokens, 1);
  assert.equal(out.metrics.outputTokens, 3);
  assert.equal(out.placeholder.edits[0].content, '⚙️ Fable 作業中… (kt / model: claude-opus-4)');
  assert.equal(out.placeholder.deleted, true, '配信できたら placeholder を消す');
  assert.deepEqual(h.calls.prompts, [{ entry: null, includeSelf: true }]);
  assert.equal(h.calls.turns.length, 1);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'done');
  assert.equal(h.calls.turns[0].extra.contractOut, null);
  assert.deepEqual(h.calls.turns[0].extra.contractNotes, []);
  assert.equal(out.outcome.hooks, false);
  assert.equal(out.outcome.gitChanged, null, 'git repo でない cwd で差分を断定している');
  assert.equal(out.record.stage, 'deliver');
  assert.equal(out.record.modelResult, 'ok');
  assert.equal(out.record.spawn.pid, 1234);
});

test('sessions.json が読めなくてもモデルの応答は配送し、本文で断る (制御フッターは末尾のまま)', async (t) => {
  const h = harness(t, {
    brokenSessions: true,
    responses: [{ ...OK_RESULT(), result: '直しました\n\n[[handoff:fable]]' }],
  });
  const out = await h.run();

  // 台帳が壊れているのはセッションの控えだけ — モデルは既に副作用を出しているので、
  // 保存できないことで job ごと internal-error にしない
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.turns.length, 1, '配送していない');
  assert.equal(
    h.calls.turns[0].extra.outgoingText,
    '直しました\n⚠️ セッションを保存できませんでした (sessions.json が読めない) — 次回は新しいセッションで始まります\n\n[[handoff:fable]]',
    '⚠️ を制御フッターより後ろに置いている (フッターが本文扱いになり handoff が不発になる)',
  );
  assert.ok(
    h.errors.some((e) => e.startsWith('[session] T1:fable セッションを保存できません: ')),
    h.errors.join('\n'),
  );
  // 壊れたファイルは在処に残す (空で上書きすると、人が直すための中身が消える)
  assert.equal(readFileSync(join(h.root, 'data', 'sessions.json'), 'utf8'), '{ broken');

  // フッターの無い応答では素直に末尾へ足す
  const plain = harness(t, { brokenSessions: true });
  await plain.run();
  assert.equal(
    plain.calls.turns[0].extra.outgoingText,
    'done\n⚠️ セッションを保存できませんでした (sessions.json が読めない) — 次回は新しいセッションで始まります',
  );
});

test('verify NG の戻し先 (投げ手) を postTurn へ渡す — 契約の fromBotKey が正本 (§12.3 (3))', async (t) => {
  const h = harness(t);
  // 契約つきの job は**契約の投げ手**。起動メッセージは別の bot の client から投げられる
  // ことがある (レビュー召喚・再開要求) ので、投稿者では取り違える
  await h.run({
    triggerMsg: { author: { bot: true, id: 'F' }, content: '<@F>' },
    claimed: { entry: { fromBotKey: 'opus2' }, error: null },
  });
  assert.equal(h.calls.turns.at(-1).extra.issuerBotKey, 'opus2');

  // 契約の無い handoff は起動メッセージを投稿した bot
  await h.run({ triggerMsg: { author: { bot: true, id: 'F' }, content: '<@F>' } });
  assert.equal(h.calls.turns.at(-1).extra.issuerBotKey, 'fable');

  // 人間が直接呼んだ job と、起動していない bot の投稿は「戻す相手なし」(owner 通知へ倒れる)
  await h.run({ triggerMsg: { author: { bot: false, id: 'U1' }, content: '<@F>' } });
  assert.equal(h.calls.turns.at(-1).extra.issuerBotKey, null);
  await h.run({ triggerMsg: { author: { bot: true, id: 'ZZZ' }, content: '<@F>' } });
  assert.equal(h.calls.turns.at(-1).extra.issuerBotKey, null);
});

test('2 回目は同じ cwd なら resume し、自分の過去発言を文脈から落とす', async (t) => {
  const h = harness(t);
  await h.run();
  await h.run();
  assert.equal(h.calls.claude[1].resume, true);
  assert.equal(h.calls.claude[1].sessionId, 'S1');
  assert.deepEqual(h.calls.prompts[1], { entry: { sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1' }, includeSelf: false });
});

test('幻セッションは entry を捨てて履歴を遡り直した新規セッションで 1 回だけやり直す', async (t) => {
  const h = harness(t, {
    responses: [
      { ok: false, error: 'API Error', detail: 'No conversation found with session ID ghost' },
      { ...OK_RESULT(), sessionId: 'S2', result: 'again' },
    ],
  });
  h.store.set('T1', 'fable', { sessionId: 'ghost', cwd: h.cwd, lastMessageId: 'M0' });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 2);
  assert.equal(h.calls.claude[0].sessionId, 'ghost');
  assert.equal(h.calls.claude[0].resume, true);
  assert.equal(h.calls.claude[1].resume, false);
  assert.equal(h.calls.claude[1].sessionId, undefined);
  assert.deepEqual(h.calls.prompts.map((p) => p.includeSelf), [false, true]);
  assert.equal(h.store.get('T1', 'fable').sessionId, 'S2');
});

test('ランタイムの失敗は ❌ で伝え、セッションを保存しない', async (t) => {
  const h = harness(t, { responses: [{ ok: false, error: 'API Error: 529 Overloaded', detail: 'x'.repeat(1000) }] });
  const out = await h.run();
  assert.equal(out.reason, 'failed(API Error: 529 Overloaded)');
  const last = out.placeholder.edits.at(-1).content;
  assert.ok(last.startsWith('❌ Fable 失敗: API Error: 529 Overloaded\n```\n'), last);
  assert.ok(last.length <= 1990);
  assert.equal(h.store.get('T1', 'fable'), undefined);
  assert.equal(out.record.modelResult, 'failed');
  assert.equal(h.calls.turns.length, 0, '失敗した job を配送している');
  assert.equal(out.placeholder.deleted, false);
});

test('中断は ⏹ で伝えて aborted を返す', async (t) => {
  const h = harness(t, { responses: [{ ok: false, aborted: true, error: '停止指示により中断' }] });
  const out = await h.run();
  assert.equal(out.reason, 'aborted');
  assert.equal(out.placeholder.edits.at(-1).content, '⏹ 停止しました (途中変更の有無は git status で確認してください)');
  assert.equal(out.record.modelResult, 'aborted');
});

test('人間起点の job は静止待ちの間に止められると起動せずに stopped-before-start', async (t) => {
  const h = harness(t);
  const out = await h.run({ triggerMsg: { author: { bot: false }, content: '<@F> hi' }, handle: { stopRequested: true } });
  assert.equal(out.reason, 'stopped-before-start');
  assert.equal(out.placeholder.edits.at(-1).content, '⏹ 停止しました (実行開始前に中断・変更なし)');
  assert.equal(h.calls.claude.length, 0);
});

test('role のプロトコル版はファイルごとに照合し、合わなければ起動しない', async (t) => {
  const stale = harness(t, { roleText: '# 宣言の無い役割文\n' });
  const out = await stale.run();
  assert.equal(out.reason, 'protocol-mismatch');
  assert.match(out.placeholder.edits.at(-1).content, /^❌ Fable を起動しませんでした\nroles\/fable\.md: role prompt にプロトコル版の宣言がありません/);
  assert.equal(stale.calls.claude.length, 0);
  assert.ok(stale.errors.some((e) => e.startsWith('[fable] プロトコル版不一致 (roles/fable.md):')), stale.errors.join('\n'));

  const oldCommon = harness(t, { commonText: '<!-- communitd-protocol: 1 -->\n# 古い共通規定\n' });
  const out2 = await oldCommon.run();
  assert.equal(out2.reason, 'protocol-mismatch');
  assert.match(out2.placeholder.edits.at(-1).content, /roles\/_common\.md: role prompt のプロトコル版 1 が/);

  const missing = harness(t, { rolePromptFile: 'roles/missing.md' });
  const out3 = await missing.run();
  assert.equal(out3.reason, 'role-unreadable');
  assert.match(out3.placeholder.edits.at(-1).content, /^❌ role prompt を読めません \(roles\/missing\.md\)/);
});

test('契約を強制できないときは起動しない (fail-open にしない)', async (t) => {
  const h = harness(t, { applyIncomingContract: () => ({ kind: 'delegation', contract: {}, narrowed: null, stop: '❌ touch 制限を強制できません' }) });
  const out = await h.run();
  assert.equal(out.reason, 'contract-unenforceable');
  assert.equal(out.placeholder.edits.at(-1).content, '❌ touch 制限を強制できません');
  assert.equal(h.calls.claude.length, 0);
});

test('touch 制限つきの契約は絞り込んだ権限をそのまま claudeOpts へ渡す', async (t) => {
  const narrowed = {
    ok: true, permissionMode: 'default', tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit(./a.js)'],
    disallowedTools: ['Bash', 'Write'], strictMcp: true, settingSources: '', rules: ['Edit(./a.js)'], rejected: [], warnings: [],
    addDirs: [],
  };
  const contract = { body: 'b', background: 'bg', purpose: 'p', touch_set: ['a.js'], acceptance: ['x'], stop_conditions: ['y'] };
  const h = harness(t, {
    cc: { permissionMode: 'acceptEdits', claudeAddDirs: ['../shared'] },
    applyIncomingContract: () => ({ kind: 'delegation', contract, narrowed, stop: null }),
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const opts = h.calls.claude[0];
  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.tools, ['Read', 'Edit']);
  assert.deepEqual(opts.allowedTools, ['Read', 'Edit(./a.js)']);
  assert.deepEqual(opts.disallowedTools, ['Bash', 'Write']);
  assert.equal(opts.strictMcp, true);
  assert.equal(opts.settingSources, '');
  assert.deepEqual(opts.addDirs, [], 'touch 制限中に --add-dir を開いている');
  // 契約ブロックは role の末尾 (実行文脈の後ろ) に載る
  const parts = opts.roleTextSent.split(ROLE_SEP);
  assert.equal(parts.length, 4);
  assert.match(parts[3], /a\.js/);
});

test('codex: role を本文へ連結して渡し、セッションは保存しない', async (t) => {
  const h = harness(t, { runtime: 'codex' });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 0);
  assert.equal(h.calls.codex.length, 1);
  const opts = h.calls.codex[0];
  assert.equal(opts.codexCmd, 'codex-test');
  assert.equal(opts.cwd, h.cwd);
  assert.equal(opts.model, 'claude-opus-4');
  // 隔離 CODEX_HOME の model_reasoning_effort になる (モデルが拒む値を避ける bot ごとの口)
  assert.equal(opts.effort, 'low', 'bots.<key>.effort が runCodex へ渡っていない');
  assert.equal(opts.sandbox, resolveCodexSandbox(h.cc));
  assert.deepEqual(opts.imagePaths, []);
  assert.deepEqual(opts.scrubEnvKeys, ['FABLE_TOKEN']);
  assert.ok(opts.prompt.endsWith(`${ROLE_SEP}PROMPT`), 'role の後ろに本文を連結していない');
  assert.equal(out.metrics.promptChars, opts.prompt.length);
  assert.equal(h.store.get('T1', 'fable'), undefined, 'ステートレスな codex でセッションを保存している');
  assert.deepEqual(h.calls.prompts, [{ entry: null, includeSelf: true }]);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'codex done');
});

test('codex: effort 未指定の bot には渡さない (ユーザー ~/.codex/config.toml のまま)', async (t) => {
  const h = harness(t, { runtime: 'codex' });
  delete h.config.bots.fable.effort; // 書いていない bot = 従来の codex bot
  await h.run();
  assert.equal(h.calls.codex[0].effort, undefined, '未指定なのに effort を渡している');
});

test('構造化出力: role が様式を宣言していればスキーマを渡し、本文フィールドだけを投稿する', async (t) => {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const contract = { body: '本文です', changed_files: ['a.js'], did: ['直した'], verification: 'npm test', remaining: [] };
  const h = harness(t, { roleText, responses: [{ ...OK_RESULT(), result: JSON.stringify(contract), structuredOutput: contract }] });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.deepEqual(h.calls.claude[0].jsonSchema, SCHEMAS.report);
  assert.equal(h.calls.turns[0].extra.outgoingText, '本文です');
  assert.deepEqual(h.calls.turns[0].extra.contractOut, { kind: 'report', contract });
  assert.deepEqual(h.calls.turns[0].extra.contractNotes, []);
  assert.deepEqual(h.calls.flows, [], '裁定も発議も無い report で配線を呼んでいる');

  // 様式に合わなければ素の result へ縮退し、契約としては使わない
  const bad = harness(t, { roleText, responses: [{ ...OK_RESULT(), result: '{"body":1}', structuredOutput: { body: 1 } }] });
  await bad.run();
  assert.equal(bad.calls.turns[0].extra.outgoingText, '{"body":1}');
  assert.equal(bad.calls.turns[0].extra.contractOut, null);
  assert.match(bad.calls.turns[0].extra.contractNotes[0], /^⚠️ 構造化出力が様式に合いませんでした/);
  assert.ok(bad.errors.some((e) => e.startsWith('[contract] fable: 様式不履行')), bad.errors.join('\n'));

  // チャンネルが構造化を切っていればスキーマを渡さない
  const off = harness(t, { roleText, cc: { structuredOutput: false } });
  await off.run();
  assert.equal(off.calls.claude[0].jsonSchema, null);
});

test('report の裁定と発議は独立に配線を呼ぶ (片方だけを落とさない)', async (t) => {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const contract = {
    body: '裁定します', changed_files: [], did: ['見た'], verification: '-', remaining: [],
    adjudication: { proposal_id: '3', decision: 'accepted', rationale: '妥当' },
  };
  const h = harness(t, { roleText, responses: [{ ...OK_RESULT(), structuredOutput: contract }] });
  await h.run();
  assert.deepEqual(h.calls.flows.map(([name]) => name), ['applyProposalAdjudication']);
  assert.deepEqual(h.calls.turns[0].extra.contractNotes, ['🏛 裁定']);
});

test('スカウト job は種別の上書きで task-proposal のスキーマを渡し、起票の配線を呼ぶ', async (t) => {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Opus\n`;
  const contract = {
    body: '起票します',
    tasks: [{ title: 'lint を直す', rationale: '理由', touch: ['a.py'], job_budget: 4 }],
  };
  const h = harness(t, {
    roleText,
    claimContractKindOverride: () => 'task-proposal',
    responses: [{ ...OK_RESULT(), structuredOutput: contract }],
  });
  await h.run();
  assert.deepEqual(h.calls.claude[0].jsonSchema, SCHEMAS['task-proposal']);
  assert.deepEqual(h.calls.flows.map(([name]) => name), ['fileProposal']);
  assert.deepEqual(h.calls.turns[0].extra.contractNotes, ['🌱 起票']);
});

test('verify: Stop hook の結果が無ければブリッジ側で 1 回検証し、NG なら verify-failed で終える', async (t) => {
  const pass = harness(t, { cc: { verify: 'node -e "process.exit(0)"' } });
  const ok = await pass.run();
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.metrics.verifyPassed, 1);
  assert.equal(ok.metrics.verifyAttempts, 1);
  assert.ok(Number.isFinite(ok.metrics.verifyMs));
  assert.equal(pass.calls.turns[0].extra.verifyResult.ok, true);

  const fail = harness(t, { cc: { verify: 'node -e "process.exit(1)"' } });
  const ng = await fail.run();
  assert.equal(ng.reason, 'verify-failed');
  assert.equal(ng.metrics.verifyPassed, 0);
  assert.equal(fail.calls.turns[0].extra.verifyResult.ok, false);
  assert.equal(ng.placeholder.deleted, true, '結果まで配送できたら placeholder は消す');
});

test('hooks: true のチャンネルでは job 専用の settings を渡し、終わったら一時ディレクトリを消す', async (t) => {
  const h = harness(t, { cc: { hooks: true } });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const opts = h.calls.claude[0];
  assert.ok(opts.settingsFile, 'settings を渡していない');
  assert.ok(opts.settings?.hooks, 'settings に hooks が無い');
  assert.equal(existsSync(opts.settingsFile), false, 'settings スナップショットを消していない');
  assert.equal(out.outcome.hooks, true);
  assert.equal(out.outcome.traceReadable, false, 'trace が無いのに読めたことにしている');
});

test('配送できなかった job は deliver-failed で、placeholder に理由を残す', async (t) => {
  const h = harness(t, { turnResult: { delivered: false, handedOff: false, failures: ['本文: archived'] } });
  const out = await h.run();
  assert.equal(out.reason, 'deliver-failed');
  assert.match(out.placeholder.edits.at(-1).content, /^❌ Fable: 投稿に失敗したため次の担当を呼んでいません\n本文: archived/);
  assert.equal(out.placeholder.deleted, false);
});

test('予期しない throw は ❌ で可視化して internal-error を返す', async (t) => {
  const h = harness(t, { buildPrompt: async () => { throw new Error('boom'); } });
  const out = await h.run();
  assert.equal(out.reason, 'internal-error');
  assert.match(out.placeholder.edits.at(-1).content, /^❌ Fable 内部エラー: Error: boom/);
  assert.ok(h.errors.some((e) => e.includes('[fable thread:T1] job 内部エラー')), h.errors.join('\n'));
});

test('handoffFileFor は docs/HANDOFF.md を置いたプロジェクトでだけ効く', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(HANDOFF_FILE, 'docs/HANDOFF.md');
  assert.equal(handoffFileFor(dir), null);
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'HANDOFF.md'), '# 引き継ぎ\n');
  assert.equal(handoffFileFor(dir), 'docs/HANDOFF.md');
  assert.equal(handoffFileFor(''), null);
  assert.equal(handoffFileFor(null), null);
});
