import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HANDOFF_FILE, createJobRunner, handoffFileFor } from '../src/bridge/job.js';
import { createRunRecorder } from '../src/bridge/recorder.js';
import { FINAL_ANSWER_TOOL, sessionLogPath } from '../src/final-answers.js';
import { harnessFingerprint } from '../src/harness.js';
import { runCodex as runCodexReal } from '../src/codex.js';
import { resolveAllowedTools, resolveCodexSandbox, resolvePermissionMode } from '../src/config.js';
import { SCHEMAS } from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { JobRunStore } from '../src/jobruns.js';
import { resolveOutgoingText } from '../src/mentions.js';
import { RosterStore } from '../src/roster.js';
import { MEMO_PROMPT } from '../src/session-cut.js';
import { SessionStore } from '../src/store.js';
import { toStrictSchema } from '../src/strict-schema.js';
import { readRunTrace } from '../src/trace-store.js';
import { DEFAULT_VERIFY_TIMEOUT_MS } from '../src/verify.js';

// src/bridge/job.js — job 1 本の実行 (runJob)。ランタイム (claude / codex) と配送 (postTurn) を偽物にし、
// role の組み立て・契約の適用・claudeOpts (effort を含む) の中身・セッションの保存を固定する。
// 「effort の配線はテストで固定していない」(2026-08-05 の保留裁定) をここで解消する。
// codex の構造化出力の一本道だけは本物の runCodex を通す (偽物にするのは spawn と codex の解決)。

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
  // 渡せば偽の runClaude が返る前に呼ぶ (claude の実行中に起きる副作用 = Stop hook の代役用)
  onClaude = null,
  // 渡せば偽の runCodex の代わりに使う (本物の runCodex を通す統合テスト用)
  runCodex = null,
  // 渡せば偽の runPi が返る前に呼ぶ (拡張の代役 = verify の状態ファイル・軌跡を書く)
  onPi = null,
  // true なら軌跡を root/data/traces に残す (src/trace-store.js)
  keepTraces = false,
  // スレッドのタスク (findByThread が返すもの)。解き直しの役割文の読み先を試す
  threadTask = null,
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
    piCmd: 'pi-test',
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
  const calls = { claude: [], codex: [], pi: [], prompts: [], promptOpts: [], turns: [], flows: [] };
  const queue = [...responses];
  const runner = createJobRunner({
    config,
    root,
    commonRolePath: join(root, 'roles', '_common.md'),
    store,
    roster,
    jobRuns,
    board: threadTask ? { findByThread: (id) => (id === 'T1' ? threadTask : null) } : null,
    limits: {
      maxApprovalCards: 3, approvalWaitMs: 1000, approvalHookTools: ['WebFetch'], maxSelfHops: 3,
      maxStdoutBytes: 1024, quietWindowMs: 3000, quietWaitMaxMs: 15000,
    },
    ownerTargets: [{ userId: 'U1', displayName: 'So' }],
    runRecorder: createRunRecorder({ jobRuns }),
    approvedRulesFor: () => [],
    applyIncomingContract,
    claimContractKindOverride,
    buildPrompt: buildPrompt ?? (async (bot, triggerMsg, thread, entry, includeSelf, opts) => {
      calls.prompts.push({ entry, includeSelf });
      calls.promptOpts.push(opts ?? null);
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
    traceDir: keepTraces ? join(root, 'data', 'traces') : null,
    runClaude: async (opts) => {
      // role は一時ファイル経由で渡る (finally で消えるので、ここで読んで残す)
      const roleTextSent = existsSync(opts.rolePromptFile) ? readFileSync(opts.rolePromptFile, 'utf8') : null;
      const settings = opts.settingsFile ? JSON.parse(readFileSync(opts.settingsFile, 'utf8')) : null;
      calls.claude.push({ ...opts, roleTextSent, settings });
      opts.onSpawn?.({ pid: 1234, runtime: 'claude' });
      onClaude?.(opts);
      return queue.shift() ?? OK_RESULT();
    },
    runCodex: async (opts) => {
      calls.codex.push(opts);
      return runCodex ? runCodex(opts) : (queue.shift() ?? { ok: true, result: 'codex done' });
    },
    runPi: async (opts) => {
      // role は一時ファイル経由で渡る (finally で消えるので、ここで読んで残す)
      const roleTextSent = existsSync(opts.rolePromptFile) ? readFileSync(opts.rolePromptFile, 'utf8') : null;
      calls.pi.push({ ...opts, roleTextSent });
      opts.onSpawn?.({ pid: 5678, runtime: 'pi' });
      onPi?.(opts);
      return queue.shift() ?? { ok: true, result: 'pi done', usage: OK_RESULT().usage, permissionDenials: [] };
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

  // 文脈は記録も numTurns も無いので測れない (null)。測れなくても job 数は数える (切り替えの保険)
  assert.deepEqual(h.store.get('T1', 'fable'), {
    sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1', jobs: 1, contextTokens: null, cuts: 0,
  });
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
  assert.deepEqual(h.calls.prompts[1], {
    entry: { sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1', jobs: 1, contextTokens: null, cuts: 0 },
    includeSelf: false,
  });
  assert.equal(h.store.get('T1', 'fable').jobs, 2, '同じセッションを続けた job を数え足していない');
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

// ---- セッションの切り替え (T-2 — src/session-cut.js) ----
// セッション記録 (Claude Code の内部ファイル) は CLAUDE_CONFIG_DIR を一時ディレクトリへ向けて置く。
// 文脈は記録の最後のリクエスト (input + cache) で測るので、記録の中身でしきい値の上下を作る

function useClaudeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-job-claude-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** @param {{context: number, edited?: string[], finalAnswersAt?: Date[]}} p finalAnswersAt = 最終回答 (StructuredOutput) を出した時刻 */
function writeSessionLog(configDir, cwd, sessionId, { context, edited = [], finalAnswersAt = [] }) {
  const path = sessionLogPath({ configDir, cwd, sessionId });
  mkdirSync(dirname(path), { recursive: true });
  const editLines = edited.map((f) => ({
    type: 'assistant',
    message: { model: 'm', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(cwd, f) } }], usage: { input_tokens: 1, cache_read_input_tokens: 1000 } },
  }));
  const answerLines = finalAnswersAt.map((at) => ({
    type: 'assistant',
    timestamp: at.toISOString(),
    message: { model: 'm', content: [{ type: 'tool_use', name: FINAL_ANSWER_TOOL, input: {} }], usage: { input_tokens: 1, cache_read_input_tokens: 1000 } },
  }));
  const last = { type: 'assistant', message: { model: 'm', content: [], usage: { input_tokens: 0, cache_read_input_tokens: context, cache_creation_input_tokens: 0 } } };
  writeFileSync(path, `${[...editLines, ...answerLines, last].map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const CUT_ENTRY = (cwd, over = {}) => ({
  sessionId: 'S1', cwd, lastMessageId: 'M0', jobs: 9, contextTokens: 160000, cuts: 2,
  cut: { reason: 'context', contextTokens: 160000, jobs: 9, memo: '進行中: A まで済み', editedFiles: ['src/a.js'], at: '2026-10-09T00:00:00.000Z' },
  ...over,
});

test('セッション切り替え: 文脈がしきい値を超えた job は切る印を残し、フッターの前に 1 行出し、配送の後で同じ起動引数のまま引き継ぎメモを書かせる', async (t) => {
  const configDir = useClaudeConfigDir(t);
  const turnsAtClaude = [];
  let h = null;
  h = harness(t, {
    cc: { hooks: true },
    responses: [
      { ...OK_RESULT(), result: '直しました\n\n[[handoff:fable]]' },
      { ...OK_RESULT(), result: ' 進行中: A まで済み ' },
    ],
    onClaude: () => turnsAtClaude.push(h.calls.turns.length),
  });
  writeSessionLog(configDir, h.cwd, 'S1', { context: 160000, edited: ['src/a.js'] });
  const out = await h.run();

  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 2, '引き継ぎメモの 1 ターンが走っていない');
  assert.deepEqual(turnsAtClaude, [0, 1], 'メモは配送の後 (人を待たせない)');
  const [main, memo] = h.calls.claude;
  assert.equal(memo.prompt, MEMO_PROMPT);
  assert.equal(memo.resume, true);
  assert.equal(memo.sessionId, 'S1');
  assert.equal(memo.timeoutMs, 180000);
  assert.ok(main.settingsFile, 'hooks: true の本 job に settings が無い (前提の確認)');
  assert.equal(memo.settingsFile, undefined, 'メモのターンで Stop hook (verify) を走らせている');
  // tools・スキーマ・effort・role のどれかが変わると、セッション全体のキャッシュを書き直すことになる
  for (const key of ['model', 'effort', 'tools', 'jsonSchema', 'allowedTools', 'disallowedTools', 'permissionMode', 'strictMcp', 'settingSources', 'addDirs', 'rolePromptFile', 'cwd']) {
    assert.deepEqual(memo[key], main[key], `メモのターンで ${key} が本 job と違う`);
  }
  assert.equal(memo.roleTextSent, main.roleTextSent, 'メモのターンの時点で role のスナップショットが消えている');

  assert.equal(
    h.calls.turns[0].extra.outgoingText,
    '直しました\n🧵 セッションの文脈が 160k tok に達したので、次の job から新しいセッションで再開します (引き継ぎつき)\n\n[[handoff:fable]]',
    '🧵 を制御フッターより後ろに置いている (フッターが本文扱いになり handoff が不発になる)',
  );
  const entry = h.store.get('T1', 'fable');
  assert.equal(typeof entry.cut.at, 'string');
  assert.deepEqual({ ...entry, cut: { ...entry.cut, at: null } }, {
    sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1', jobs: 1, contextTokens: 160000, cuts: 0,
    cut: { reason: 'context', contextTokens: 160000, jobs: 1, memo: '進行中: A まで済み', editedFiles: ['src/a.js'], at: null },
  });
  assert.equal(out.metrics.contextTokens, 160000);
});

test('セッション切り替え: しきい値以下なら切らず、メモのターンも走らない', async (t) => {
  const configDir = useClaudeConfigDir(t);
  const h = harness(t);
  writeSessionLog(configDir, h.cwd, 'S1', { context: 150000 });
  await h.run();
  assert.equal(h.calls.claude.length, 1);
  assert.equal(h.store.get('T1', 'fable').cut, undefined);
  assert.equal(h.store.get('T1', 'fable').contextTokens, 150000);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'done');
});

test('セッション切り替え: 印のある次の job は resume せず、遡りを絞って作り直した文脈の先頭に引き継ぎを足し、新しいセッションで印を消す', async (t) => {
  const configDir = useClaudeConfigDir(t);
  const h = harness(t, { responses: [{ ...OK_RESULT(), sessionId: 'S2', result: 'つづき' }] });
  h.store.set('T1', 'fable', CUT_ENTRY(h.cwd));
  writeSessionLog(configDir, h.cwd, 'S2', { context: 50000 });
  const out = await h.run();

  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 1, '切った直後の job でメモのターンを走らせている');
  const opts = h.calls.claude[0];
  assert.equal(opts.resume, false, '切る印のあるセッションを resume している');
  assert.equal(opts.sessionId, undefined);
  // 作り直しは新規・幻セッションと同じ経路 (自分の過去発言も含める)。遡りの予算だけ絞る
  assert.deepEqual(h.calls.prompts, [{ entry: null, includeSelf: true }]);
  assert.deepEqual(h.calls.promptOpts, [{ charBudget: 30000 }]);
  assert.match(opts.prompt, /^# 前のセッションからの引き継ぎ \(ブリッジが生成\)\n/);
  assert.match(opts.prompt, /文脈 160k tok \/ 9 job で畳み/);
  assert.match(opts.prompt, /- `src\/a\.js`/);
  assert.match(opts.prompt, /## 前のセッションのあなたが残したメモ\n進行中: A まで済み\n\nPROMPT$/);
  assert.equal(out.metrics.promptChars, opts.roleTextSent.length + opts.prompt.length, '引き継ぎの分が計測から漏れている');
  assert.deepEqual(h.store.get('T1', 'fable'), {
    sessionId: 'S2', cwd: h.cwd, lastMessageId: 'M1', jobs: 1, contextTokens: 50000, cuts: 3,
  });
  assert.equal(h.calls.turns[0].extra.outgoingText, 'つづき');
  assert.ok(h.logs.some((l) => l.startsWith('[session] T1:fable 新しいセッションで再開 (前: 文脈 160000 tok / 9 job / メモあり)')), h.logs.join('\n'));
});

test('セッション切り替え: メモが取れなくても切る (次の job は「取れませんでした」と断って再開する)', async (t) => {
  const configDir = useClaudeConfigDir(t);
  const h = harness(t, {
    responses: [
      OK_RESULT(),
      { ok: false, error: 'タイムアウト' },
      { ...OK_RESULT(), sessionId: 'S2' },
    ],
  });
  writeSessionLog(configDir, h.cwd, 'S1', { context: 400000 });
  const out = await h.run();
  assert.equal(out.reason, 'ok', 'メモの失敗で job を失敗にしている');
  assert.equal(h.store.get('T1', 'fable').cut.memo, null);
  assert.ok(h.errors.some((e) => e.includes('引き継ぎメモを取れませんでした (タイムアウト) — メモ無しで切ります')), h.errors.join('\n'));

  await h.run();
  assert.equal(h.calls.claude[2].resume, false);
  assert.match(h.calls.claude[2].prompt, /## 前のセッションのあなたが残したメモ\n\(取れませんでした — /);
});

test('セッション切り替え: 配送できなかった job ではメモのターンを走らせない (印は残り、次の job は作り直す)', async (t) => {
  const configDir = useClaudeConfigDir(t);
  const h = harness(t, { turnResult: { delivered: false, handedOff: false, failures: ['送れない'], handoff: null, taskSubmitted: false } });
  writeSessionLog(configDir, h.cwd, 'S1', { context: 200000 });
  const out = await h.run();
  assert.equal(out.reason, 'deliver-failed');
  assert.equal(h.calls.claude.length, 1);
  assert.equal(h.store.get('T1', 'fable').cut.reason, 'context');
});

test('セッション切り替え: 文脈が測れなくても job 数で切れる。チャンネルの session で上書きでき、0 はその物差しを止める', async (t) => {
  useClaudeConfigDir(t); // 記録を置かない = 文脈は測れない (usage にも numTurns が無い)
  const h = harness(t, { cc: { session: { maxContextTokens: 0, maxJobs: 2 } } });
  await h.run();
  assert.equal(h.store.get('T1', 'fable').cut, undefined);
  assert.equal(h.calls.claude.length, 1);
  await h.run();
  const entry = h.store.get('T1', 'fable');
  assert.equal(entry.jobs, 2);
  assert.equal(entry.contextTokens, null);
  assert.equal(entry.cut.reason, 'jobs');
  assert.equal(h.calls.claude.length, 3, '2 job 目の後にメモのターンが走っていない');
  assert.match(h.calls.turns[1].extra.outgoingText, /🧵 同じセッションで 2 job に達したので/);
});

test('セッション切り替え: 印のある job でモデルが失敗したら印を消さない (次の試行も作り直す)', async (t) => {
  useClaudeConfigDir(t);
  const h = harness(t, { responses: [{ ok: false, error: 'API Error' }] });
  h.store.set('T1', 'fable', CUT_ENTRY(h.cwd));
  const out = await h.run();
  assert.equal(out.reason, 'failed(API Error)');
  assert.deepEqual(h.store.get('T1', 'fable'), CUT_ENTRY(h.cwd));
});

test('セッション切り替え: 項目の無い旧形式の entry はそのまま resume し、job 数を 0 から数える', async (t) => {
  useClaudeConfigDir(t);
  const h = harness(t);
  h.store.set('T1', 'fable', { sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M0' });
  await h.run();
  assert.equal(h.calls.claude[0].resume, true);
  assert.equal(h.calls.claude[0].sessionId, 'S1');
  assert.deepEqual(h.store.get('T1', 'fable'), { sessionId: 'S1', cwd: h.cwd, lastMessageId: 'M1', jobs: 1, contextTokens: null, cuts: 0 });
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

test('pi: role はファイルで、権限は claude と同じ設定で runPi へ渡し、セッションは保存しない', async (t) => {
  const h = harness(t, { runtime: 'pi', cc: { permissionMode: 'acceptEdits', claudeAddDirs: ['../shared'] } });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 0);
  assert.equal(h.calls.codex.length, 0);
  assert.equal(h.calls.pi.length, 1);
  const opts = h.calls.pi[0];
  assert.equal(opts.piCmd, 'pi-test');
  assert.equal(opts.cwd, h.cwd);
  assert.equal(opts.model, 'claude-opus-4');
  assert.equal(opts.effort, 'low');
  assert.equal(opts.prompt, 'PROMPT');
  assert.deepEqual(opts.imagePaths, []);
  // 権限は claude の claudeOpts と同じ値 (チャンネルの allowedTools と permissionMode)
  assert.deepEqual(opts.allowedTools, resolveAllowedTools(h.cc, []));
  assert.equal(opts.permissionMode, resolvePermissionMode(h.cc));
  assert.equal(opts.tools, null);
  assert.deepEqual(opts.disallowedTools, []);
  assert.equal(opts.addDirs.length, 1, '参照ディレクトリを渡していない');
  assert.equal(opts.jsonSchema, null, '様式を宣言していない bot にスキーマを渡している');
  assert.equal(opts.verify, null, 'hooks: false のチャンネルで差し戻しを入れている');
  assert.ok(opts.traceFile, '軌跡は常に取る (pi は JSON 出力から取れる)');
  assert.deepEqual(opts.scrubEnvKeys, ['FABLE_TOKEN']);
  // role は 3 段 (共通規定 + 役割文 + 実行文脈)。報告の道具の案内は出ない
  const parts = opts.roleTextSent.split(ROLE_SEP);
  assert.equal(parts.length, 3);
  assert.match(parts[2], /ランタイム: pi/);
  assert.doesNotMatch(parts[2], /submit_report/);
  assert.equal(out.metrics.promptChars, opts.roleTextSent.length + 'PROMPT'.length);
  assert.equal(out.metrics.inputTokens, 10);
  assert.equal(out.outcome.hooks, true);
  assert.equal(existsSync(opts.rolePromptFile), false, 'role のスナップショットを消していない');
  assert.equal(h.store.get('T1', 'fable'), undefined, 'セッションを残さない版でセッションを保存している');
  assert.deepEqual(h.calls.prompts, [{ entry: null, includeSelf: true }]);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'pi done');
});

test('pi: 様式を宣言した bot はスキーマを渡し、実行文脈で最終報告の道具を案内する', async (t) => {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const contract = { body: 'pi の本文', changed_files: [], did: ['読んだ'], verification: '-', remaining: [] };
  const h = harness(t, {
    runtime: 'pi', roleText, responses: [{ ok: true, result: JSON.stringify(contract), structuredOutput: contract }],
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const opts = h.calls.pi[0];
  assert.equal(opts.jsonSchema, SCHEMAS.report, '原スキーマをそのまま渡す');
  assert.match(opts.roleTextSent, /最終報告: 道具 `submit_report`/);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'pi の本文');
  assert.deepEqual(h.calls.turns[0].extra.contractOut, { kind: 'report', contract });
});

test('pi: touch 制限の契約は絞り込んだ権限をそのまま runPi へ渡す (参照ディレクトリも開かない)', async (t) => {
  const narrowed = {
    ok: true, permissionMode: 'default', tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit(./a.js)'],
    disallowedTools: ['Bash', 'Write'], strictMcp: true, settingSources: '', rules: ['Edit(./a.js)'], rejected: [], warnings: [],
    addDirs: [],
  };
  const contract = { body: 'b', background: 'bg', purpose: 'p', touch_set: ['a.js'], acceptance: ['x'], stop_conditions: ['y'] };
  const h = harness(t, {
    runtime: 'pi',
    cc: { permissionMode: 'acceptEdits', claudeAddDirs: ['../shared'] },
    applyIncomingContract: () => ({ kind: 'delegation', contract, narrowed, stop: null }),
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const opts = h.calls.pi[0];
  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.tools, ['Read', 'Edit']);
  assert.deepEqual(opts.allowedTools, ['Read', 'Edit(./a.js)']);
  assert.deepEqual(opts.disallowedTools, ['Bash', 'Write']);
  assert.deepEqual(opts.addDirs, []);
});

test('pi: hooks: true のチャンネルでは verify を拡張へ渡し、拡張が残した最終 NG を採る', async (t) => {
  const lastResult = { ran: true, ok: false, command: 'from-pi', durationMs: 700, output: 'NG のまま', exitCode: 1 };
  const h = harness(t, {
    runtime: 'pi',
    cc: { hooks: true, verify: markingVerify(0), verifyMaxRetries: 2 },
    onPi: (opts) => {
      writeFileSync(opts.verify.stateFile, `${JSON.stringify({ attempts: 3, blocksUsed: 2, totalDurationMs: 2100, lastResult })}\n`);
      writeFileSync(opts.traceFile, `${JSON.stringify({ tool: 'Read', arg: 'a.js' })}\n${JSON.stringify({ tool: 'Edit', arg: 'a.js' })}\n`);
    },
  });
  const out = await h.run();
  const opts = h.calls.pi[0];
  assert.deepEqual(opts.verify, {
    command: h.cc.verify,
    cwd: h.cwd,
    stateFile: join(dirname(opts.traceFile), 'verify-state.json'),
    maxRetries: 2,
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  });
  assert.equal(out.reason, 'verify-failed');
  assert.equal(existsSync(join(h.cwd, BRIDGE_VERIFY_MARK)), false, 'ブリッジ側で検証し直している');
  assert.equal(out.metrics.verifyAttempts, 3);
  assert.equal(out.metrics.verifyMs, 2100);
  assert.deepEqual(h.calls.turns[0].extra.verifyResult, lastResult);
  // 軌跡は pi の JSON 出力から書かれたものを読む
  assert.equal(out.metrics.toolCalls, 2);
  assert.equal(out.metrics.readsBeforeFirstEdit, 1);
  assert.equal(existsSync(opts.traceFile), false, '一時ディレクトリを消していない');
});

test('軌跡は一時ディレクトリを消す前に置き場へ残す (差し戻しの手順を後から読むため)', async (t) => {
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  const h = harness(t, {
    runtime: 'pi',
    keepTraces: true,
    onPi: (opts) => {
      writeFileSync(opts.traceFile, line({ tool: 'Read', arg: 'a.js' }) + line({ tool: 'Edit', arg: 'a.js', failed: true }));
    },
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(existsSync(h.calls.pi[0].traceFile), false, '一時ディレクトリを消していない');
  assert.deepEqual(readRunTrace(join(h.root, 'data', 'traces'), out.record.id), [
    { tool: 'Read', arg: 'a.js', failed: false },
    { tool: 'Edit', arg: 'a.js', failed: true },
  ]);
});

test('軌跡の置き場が書けなくても job の結果は変えない', async (t) => {
  const h = harness(t, {
    runtime: 'pi',
    keepTraces: true,
    onPi: (opts) => {
      // 置き場の場所にファイルを置いて mkdir を失敗させる
      mkdirSync(join(h.root, 'data'), { recursive: true });
      writeFileSync(join(h.root, 'data', 'traces'), 'not a dir');
      writeFileSync(opts.traceFile, `${JSON.stringify({ tool: 'Read', arg: 'a.js' })}\n`);
    },
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.ok(h.errors.some((e) => e.includes('軌跡を残せませんでした')), h.errors.join('\n'));
});

test('pi: hooks: false のチャンネルでは拡張に検証させず、ブリッジが 1 回だけ検証する', async (t) => {
  const h = harness(t, { runtime: 'pi', cc: { hooks: false, verify: markingVerify(1) } });
  const out = await h.run();
  assert.equal(h.calls.pi[0].verify, null);
  assert.equal(existsSync(join(h.cwd, BRIDGE_VERIFY_MARK)), true, 'ブリッジ側で検証していない');
  assert.equal(out.reason, 'verify-failed');
  assert.equal(out.metrics.verifyAttempts, 1);
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

  // チャンネルが構造化を切っていればスキーマを渡さない
  const off = harness(t, { roleText, cc: { structuredOutput: false } });
  await off.run();
  assert.equal(off.calls.claude[0].jsonSchema, null);
});

// 最終回答を 2 回以上出した job の断り書き (2026-10-03 の質問消失への手当て)。数えるのはセッション記録の
// StructuredOutput の行で、記録はモデルが job の中で書くので偽の runClaude の中で書く。
// `before` 回は job の開始より前の時刻 (resume したセッションの前の job の回) で、数えないのが正しい
function finalAnswerRun(t, { before, during }) {
  const configDir = useClaudeConfigDir(t);
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const contract = { body: '報告です\n\n[[handoff:fable]]', changed_files: ['a.js'], did: ['直した'], verification: 'npm test', remaining: [] };
  let h = null;
  h = harness(t, {
    roleText,
    responses: [{ ...OK_RESULT(), result: JSON.stringify(contract), structuredOutput: contract }],
    onClaude: () => {
      const finalAnswersAt = [
        ...Array.from({ length: before }, () => new Date('2026-01-01T00:00:00.000Z')),
        ...Array.from({ length: during }, () => new Date()),
      ];
      writeSessionLog(configDir, h.cwd, 'S1', { context: 1000, finalAnswersAt });
    },
  });
  return h;
}

test('最終回答: 構造化契約の job が最終回答を 2 回出したら、本文のフッターの前に断り書きを足し、console へ 1 行出す', async (t) => {
  const h = finalAnswerRun(t, { before: 1, during: 2 });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const extra = h.calls.turns[0].extra;
  assert.equal(extra.contractOut?.kind, 'report', '契約としては扱う (断るのは届かなかった回があることだけ)');
  assert.equal(
    extra.outgoingText,
    '報告です\n'
      + '⚠️ この job は最終回答を 2 回出しました。届いているのは最後の 1 回だけで、'
      + '前の 1 回 (質問や呼び出しを含みうる) は届いていません — 内容はセッション記録に残っています\n'
      + '\n[[handoff:fable]]',
    'フッターより前に 1 行足していない (後ろに足すと委譲が不発になる)',
  );
  assert.deepEqual(
    h.errors.filter((e) => e.startsWith('[final-answer]')),
    ['[final-answer] fable: 最終回答を 2 回出した job (thread:T1)'],
  );
});

test('最終回答: 1 回なら断り書きを足さず、console にも出さない (job の開始より前の回は数えない)', async (t) => {
  const h = finalAnswerRun(t, { before: 1, during: 1 });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.turns[0].extra.outgoingText, '報告です\n\n[[handoff:fable]]');
  assert.deepEqual(h.errors.filter((e) => e.startsWith('[final-answer]')), []);
});

// 様式不履行: 契約としては使わない (contractOut は null・注記を出す) が、Discord へ生 JSON は出さない
function malformedRun(t, structuredOutput) {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const h = harness(t, {
    roleText, responses: [{ ...OK_RESULT(), result: JSON.stringify(structuredOutput), structuredOutput }],
  });
  return h.run().then(() => {
    const extra = h.calls.turns[0].extra;
    assert.equal(extra.contractOut, null);
    assert.match(extra.contractNotes[0], /^⚠️ 構造化出力が様式に合いませんでした/);
    assert.ok(h.errors.some((e) => e.startsWith('[contract] fable: 様式不履行')), h.errors.join('\n'));
    return extra;
  });
}

test('様式不履行: 本文フィールドが文字列なら、他が不正でも生 JSON ではなく本文を出す', async (t) => {
  const extra = await malformedRun(t, { body: '本文です', changed_files: 'a.js' });
  assert.equal(extra.outgoingText, '本文です');
  assert.match(extra.contractNotes[0], /本文フィールドだけを出しています/);
});

test('様式不履行: 本文フィールドが文字列でなければ素の result へ縮退する', async (t) => {
  const extra = await malformedRun(t, { body: 1 });
  assert.equal(extra.outgoingText, '{"body":1}');
  assert.match(extra.contractNotes[0], /本文はそのまま出しています/);

  // JSON として読めなかった (structuredOutput が null) ときも素の result のまま
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const h = harness(t, { roleText, responses: [{ ...OK_RESULT(), result: '素の応答', structuredOutput: null }] });
  await h.run();
  assert.equal(h.calls.turns[0].extra.outgoingText, '素の応答');
  assert.equal(h.calls.turns[0].extra.contractOut, null);
});

test('様式不履行: 本文末尾の呼び出しは実行せず、1 行で断る (契約の無い委譲を開かない)', async (t) => {
  const body = '直しました。\n\n[[handoff:peer]]';
  const extra = await malformedRun(t, { body, changed_files: 'a.js' });
  assert.equal(
    extra.outgoingText,
    '直しました。\n⚠️ `[[handoff:peer]]` は、契約として扱っていないので呼び出しは実行していません',
  );
  // postTurn が同じ判定で読んでも、呼び出しは 1 つも残っていない (外す前なら呼べている)
  const ctx = { bots: [{ key: 'peer', userId: '2' }] };
  assert.ok(resolveOutgoingText(body, ctx).mention);
  assert.equal(resolveOutgoingText(extra.outgoingText, ctx).mention, null);
});

test('構造化出力: codex も宣言があればスキーマを渡す (P-3 の --output-schema)', async (t) => {
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const contract = {
    body: 'codex の本文', changed_files: [], did: ['読んだ'], verification: '-', remaining: [],
  };
  const h = harness(t, {
    runtime: 'codex',
    roleText,
    responses: [{ ok: true, result: JSON.stringify(contract), structuredOutput: contract }],
  });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  assert.equal(h.calls.claude.length, 0);
  // **原スキーマをそのまま渡す** — strict 変換と null の後始末は runCodex の中
  // (src/strict-schema.js)。ここで変換すると claude 側と渡す値が分かれる
  assert.deepEqual(h.calls.codex[0].jsonSchema, SCHEMAS.report);
  assert.equal(h.calls.turns[0].extra.outgoingText, 'codex の本文');
  assert.deepEqual(h.calls.turns[0].extra.contractOut, { kind: 'report', contract });

  // 宣言の無い codex bot は従来どおり (スキーマを渡さない = 挙動不変)
  const bare = harness(t, { runtime: 'codex' });
  await bare.run();
  assert.equal(bare.calls.codex[0].jsonSchema, null);

  // チャンネルが構造化を切っていれば宣言があっても渡さない
  const off = harness(t, { runtime: 'codex', roleText, cc: { structuredOutput: false } });
  await off.run();
  assert.equal(off.calls.codex[0].jsonSchema, null);
});

/**
 * spawn の代わりに、`-o` へ最終メッセージを書いて終わる子プロセスを装う
 * (test/codex.test.js の fakeCodexSpawn の写し。export していないのでここへ写す)。
 * `--output-schema` に渡されたファイルの中身も覗く — finish() が出力先ごと消すので、
 * spawn の時点で読まないと後からは見られない。子へ渡した env も残す
 */
function fakeCodexSpawn(seen, { message = null, exitCode = 0 } = {}) {
  return (bin, args, opts) => {
    seen.bin = bin;
    seen.args = args;
    seen.env = opts?.env ?? null;
    const outFile = args[args.indexOf('-o') + 1];
    const at = args.indexOf('--output-schema');
    seen.schemaFile = at >= 0 ? args[at + 1] : null;
    seen.schema = seen.schemaFile ? JSON.parse(readFileSync(seen.schemaFile, 'utf8')) : null;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    setImmediate(() => {
      if (message !== null) writeFileSync(outFile, message, 'utf8');
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('構造化出力: job → 本物の runCodex → strict 変換 → null 削除を一本道で通す', async (t) => {
  // 単体テストは 2 段に分かれている (runCodex 単体 = test/codex.test.js / runCodex を偽物にした job)。
  // 継ぎ目 — job が渡した原スキーマが strict 変換されて codex に届き、strict が生やした null が
  // 削られてから validateContract に掛かる — はここでしか押さえられない

  // 本物の auth.json をコピーさせない: auth.json の無い CODEX_HOME なら隔離 home を作らず
  // --ignore-user-config で起動する (read-only の既定ならそれで走る — src/codex.js の createIsolatedHome)
  const prev = process.env.CODEX_HOME;
  const emptyHome = mkdtempSync(join(tmpdir(), 'communitd-noauth-'));
  process.env.CODEX_HOME = emptyHome;
  t.after(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(emptyHome, { recursive: true, force: true });
  });

  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  const body = 'codex で直しました';
  // strict では任意キーも必ず生えてきて、値が無ければ null で返る
  const message = JSON.stringify({
    body,
    changed_files: ['src/a.js'],
    did: ['直した'],
    verification: 'npm test 緑',
    remaining: [],
    adjudication: null,
    initiative: null,
  });
  const seen = {};
  const h = harness(t, {
    runtime: 'codex',
    roleText,
    runCodex: (opts) => runCodexReal({
      ...opts,
      resolveCmdImpl: () => ['codex'],
      spawnImpl: fakeCodexSpawn(seen, { message }),
    }),
  });
  const out = await h.run();

  assert.equal(out.reason, 'ok');
  // (1) job は原スキーマを渡し、codex に届くのは strict 変換後
  assert.deepEqual(h.calls.codex[0].jsonSchema, SCHEMAS.report);
  assert.ok(seen.schemaFile, '--output-schema が付いていない');
  assert.deepEqual(seen.schema, toStrictSchema(SCHEMAS.report));
  // (2) null の任意キーは契約に残らず、投稿されるのは body
  const { contractOut, outgoingText, contractNotes } = h.calls.turns[0].extra;
  assert.ok(contractOut, '様式に合わない応答として捨てられた (null が残って validateContract に落ちた?)');
  assert.equal(contractOut.kind, 'report');
  assert.equal(Object.hasOwn(contractOut.contract, 'adjudication'), false, 'null の任意キーが残っている');
  assert.equal(Object.hasOwn(contractOut.contract, 'initiative'), false);
  assert.equal(outgoingText, body);
  assert.deepEqual(contractNotes, []);
  // null の adjudication が残っていれば裁定の配線が呼ばれる
  assert.deepEqual(h.calls.flows, []);
  // (3) 隔離 home (認証の写し) を作らずに起動している
  assert.ok(seen.args.includes('--ignore-user-config'), '隔離 CODEX_HOME を作った (auth.json を写した)');
  assert.equal(seen.env.CODEX_HOME, emptyHome);
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

// ループ (scout → 承認 → worker → reviewer) で承認とレビュー判定がボードへ適用されるのは、
// runJob の種別ごとの分岐だけ。壊れると承認しても着手されない・レビューしても merge されないのに
// job は ok で終わり、ループが黙って止まる
describe('承認・レビュー判定の振り分け (applyApproval / applyReview)', () => {
  // 本番の reviewer は report を宣言し、承認・レビューの 1 job だけ共有枠で種別が差し替わる
  const roleText = `${PROTOCOL}\n<!-- communitd-schema: report -->\n# Fable\n`;
  // 起動した契約 (受付で取り出し済み) をそのまま返す
  const incoming = (kind, contract) => () => ({ kind, contract, narrowed: null, stop: null });
  // ブリッジが pending を埋めて保存した承認依頼
  const approvalRequest = {
    body: '承認してください', approve: [], drop: [],
    pending: [{ id: '7', title: 'lint を直す', rationale: '理由', touch: ['a.js'], job_budget: 4 }],
  };
  // 承認する側は pending を書かない約束だが、スキーマ上は書けてしまう
  const answer = {
    body: '7 を承認します', approve: ['7'], drop: [],
    pending: [{ id: '99', title: '応答側で足した' }],
  };

  test('task-approval: 起動した承認依頼の pending だけを渡し、応答側の pending は使わない', async (t) => {
    const h = harness(t, {
      roleText,
      claimContractKindOverride: () => 'task-approval',
      applyIncomingContract: incoming('task-approval', approvalRequest),
      responses: [{ ...OK_RESULT(), structuredOutput: answer }],
    });
    const out = await h.run();

    assert.equal(out.reason, 'ok');
    assert.deepEqual(h.calls.claude[0].jsonSchema, SCHEMAS['task-approval']);
    assert.deepEqual(h.calls.flows.map(([name]) => name), ['applyApproval']);
    const [, p] = h.calls.flows[0];
    assert.deepEqual(p.pending, approvalRequest.pending, '起動した承認依頼の pending が渡っていない');
    assert.deepEqual(p.contract, answer);
    assert.equal(p.cc, h.cc);
    assert.equal(p.botKey, 'fable');
    const extra = h.calls.turns[0].extra;
    assert.equal(extra.outgoingText, '7 を承認します');
    assert.deepEqual(extra.contractOut, { kind: 'task-approval', contract: answer });
    assert.deepEqual(extra.contractNotes, ['✅ 承認']);
  });

  test('task-approval: 起動した契約が承認依頼でなければ pending は空', async (t) => {
    const cases = [
      ['契約なしの起動', undefined],
      ['報告の契約での起動', incoming('report', {
        body: '終わりました', changed_files: [], did: ['見た'], verification: '-', remaining: [],
      })],
    ];
    for (const [label, applyIncomingContract] of cases) {
      const h = harness(t, {
        roleText,
        claimContractKindOverride: () => 'task-approval',
        applyIncomingContract,
        responses: [{ ...OK_RESULT(), structuredOutput: answer }],
      });
      await h.run();
      assert.deepEqual(h.calls.flows.map(([name]) => name), ['applyApproval'], label);
      assert.deepEqual(h.calls.flows[0][1].pending, [], `${label}: 応答側の pending を拾っている`);
      assert.deepEqual(h.calls.turns[0].extra.contractNotes, ['✅ 承認'], label);
    }
  });

  test('task-review: 判定を契約・cc・bot・thread つきで 1 回渡し、戻りの 1 行を投稿に載せる', async (t) => {
    const verdict = { body: '差し戻します', verdict: 'send-back', reason: 'a.js:1 — 空配列で落ちる。先頭で弾く' };
    const h = harness(t, {
      roleText,
      claimContractKindOverride: () => 'task-review',
      responses: [{ ...OK_RESULT(), structuredOutput: verdict }],
    });
    const out = await h.run();

    assert.equal(out.reason, 'ok');
    assert.deepEqual(h.calls.claude[0].jsonSchema, SCHEMAS['task-review']);
    assert.deepEqual(h.calls.flows.map(([name]) => name), ['applyReview']);
    const [, p] = h.calls.flows[0];
    assert.deepEqual(p.contract, verdict);
    assert.equal(p.cc, h.cc);
    assert.equal(p.bot, h.bot);
    assert.equal(p.thread.id, 'T1');
    const extra = h.calls.turns[0].extra;
    assert.equal(extra.outgoingText, '差し戻します');
    assert.deepEqual(extra.contractOut, { kind: 'task-review', contract: verdict });
    // await を落とすと Promise が載る
    assert.deepEqual(extra.contractNotes, ['🎉 判定']);
  });

  test('様式に落ちた承認・判定では、どちらの配線も呼ばない', async (t) => {
    const cases = [
      // 必須の approve が無い
      ['task-approval', { body: '承認します', drop: [] }],
      // スキーマは通るが種別の不変条件で落ちる (差し戻しに理由が無い / merge に SHA が無い)
      ['task-review', { body: '差し戻します', verdict: 'send-back' }],
      ['task-review', { body: 'マージしました', verdict: 'merge' }],
    ];
    for (const [kind, structuredOutput] of cases) {
      const h = harness(t, {
        roleText,
        claimContractKindOverride: () => kind,
        applyIncomingContract: kind === 'task-approval' ? incoming('task-approval', approvalRequest) : undefined,
        responses: [{ ...OK_RESULT(), structuredOutput }],
      });
      const out = await h.run();
      const label = `${kind} ${JSON.stringify(structuredOutput)}`;
      assert.equal(out.reason, 'ok', label);
      assert.deepEqual(h.calls.flows, [], `${label}: 様式に落ちた契約で配線を呼んでいる`);
      const extra = h.calls.turns[0].extra;
      assert.equal(extra.contractOut, null, label);
      assert.equal(extra.contractNotes.length, 1, label);
      assert.match(extra.contractNotes[0], /^⚠️ 構造化出力が様式に合いませんでした/, label);
      assert.ok(h.errors.some((e) => e.startsWith('[contract] fable: 様式不履行')), h.errors.join('\n'));
    }
  });
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

test('verify: codex の job もブリッジ側の最終検証を通る (hook が無いので 1 回目が最終 NG)', async (t) => {
  // **P-2 (2026-09-18)。** verify の解決を claude 分岐の中でやっていたので、codex の job は
  // Stop hook もブリッジ側の最終検証も素通りしていた — 契約を返せるようになった codex bot が
  // verify NG のまま報告と handoff で先へ進める穴 (Opus2 指摘)
  const pass = harness(t, { runtime: 'codex', cc: { verify: 'node -e "process.exit(0)"' } });
  const ok = await pass.run();
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.metrics.verifyPassed, 1);
  assert.equal(ok.metrics.verifyAttempts, 1);
  assert.equal(pass.calls.turns[0].extra.verifyResult.ok, true);
  // hook を渡す口は claude だけ (codex に settings は無い — 差し戻しは効かない)
  assert.equal(pass.calls.codex[0].settingsFile, undefined);

  const fail = harness(t, { runtime: 'codex', cc: { verify: 'node -e "process.exit(1)"' } });
  const ng = await fail.run();
  assert.equal(ng.reason, 'verify-failed');
  assert.equal(ng.metrics.verifyPassed, 0);
  assert.equal(ng.metrics.verifyAttempts, 1, '1 回目の NG が最終 NG');
  assert.equal(fail.calls.turns[0].extra.verifyResult.ok, false);
});

// --- Stop hook 経路 (job.js の「verify の設定を書いて hook に載せる」と「hook の結果を採る」) ---
// 偽の runClaude が Stop hook の代役をする: job が settings と同じ一時ディレクトリへ書いた
// verify の設定を読み、hook が残すはずの状態ファイルを書いてから返る。
// 再検証の有無は 2 つの印で見る — ブリッジ側で走れば cwd に印のファイルが残ることと、
// verify コマンドの終了コードを hook の結果と**逆**にしておくこと (走れば reason が反転する)

const BRIDGE_VERIFY_MARK = 'bridge-verify-ran';
const markingVerify = (exitCode) => (
  `node -e "require('fs').writeFileSync('${BRIDGE_VERIFY_MARK}','');process.exit(${exitCode})"`
);

/** @param {object|null} state hook が残す状態 (null = 何も残さない) */
function stopHookStand(state) {
  const seen = [];
  return {
    seen,
    onClaude: (opts) => {
      const configFile = join(dirname(opts.settingsFile), 'verify-config.json');
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      seen.push({ configFile, config });
      if (state) writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    },
  };
}

/** 設定を書いて hook に載せた側 (job.js の verify の配線) を確かめる */
function assertVerifyHookWired(h, stand, { maxRetries }) {
  assert.equal(stand.seen.length, 1, 'claude が 1 回だけ起動していない');
  const { configFile, config } = stand.seen[0];
  const { settingsFile, settings } = h.calls.claude[0];
  assert.deepEqual(config, {
    command: h.cc.verify,
    cwd: h.cwd,
    stateFile: join(dirname(settingsFile), 'verify-state.json'),
    maxRetries,
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  });
  const stop = settings.hooks?.Stop?.[0]?.hooks?.[0];
  assert.equal(stop?.type, 'command', 'Stop hook が settings に載っていない');
  const command = stop.command.replaceAll('\\', '/');
  assert.match(command, /verify\.js["'] ["']?--hook["']? /, 'Stop hook が verify.js を起動していない');
  assert.ok(command.includes(configFile.replaceAll('\\', '/')), `Stop hook が job の verify 設定を指していない: ${stop.command}`);
  // settings の一時ディレクトリは終わったら消える (状態ファイルも一緒に)
  assert.equal(existsSync(config.stateFile), false, '状態ファイルを残している');
}

test('verify: Stop hook が合格を残したらその結果を採り、ブリッジ側で検証し直さない (差し戻し 1 回の後の合格)', async (t) => {
  const lastResult = { ran: true, ok: true, command: 'from-hook', durationMs: 1200, output: 'hook: 2 回目で合格', exitCode: 0 };
  const stand = stopHookStand({ attempts: 2, blocksUsed: 1, totalDurationMs: 4321, stopHookActive: true, lastResult });
  const h = harness(t, {
    cc: { hooks: true, verify: markingVerify(1), verifyMaxRetries: 2 },
    onClaude: stand.onClaude,
  });
  const out = await h.run();

  assertVerifyHookWired(h, stand, { maxRetries: 2 });
  assert.equal(out.reason, 'ok', 'hook の合格を採らずに検証し直している (再検証は NG になるコマンド)');
  assert.equal(existsSync(join(h.cwd, BRIDGE_VERIFY_MARK)), false, 'ブリッジ側で検証し直している');
  assert.equal(out.metrics.verifyPassed, 1);
  assert.equal(out.metrics.verifyAttempts, 2, '差し戻しを含む hook の試行回数を採っていない');
  assert.equal(out.metrics.verifyMs, 4321, 'hook の所要時間の合計を採っていない');
  assert.deepEqual(h.calls.turns[0].extra.verifyResult, lastResult);
  assert.equal(out.outcome.hooks, true);
  assert.equal(out.placeholder.deleted, true);
});

test('verify: Stop hook が最終 NG を残したら verify-failed で終え、ブリッジ側で検証し直さない (差し戻しを使い切った後)', async (t) => {
  const lastResult = { ran: true, ok: false, command: 'from-hook', durationMs: 900, output: 'hook: 差し戻し後も NG', exitCode: 1 };
  const stand = stopHookStand({ attempts: 2, blocksUsed: 1, totalDurationMs: 2468, stopHookActive: true, lastResult });
  const h = harness(t, {
    cc: { hooks: true, verify: markingVerify(0) },
    onClaude: stand.onClaude,
  });
  const out = await h.run();

  // verifyMaxRetries を書かないチャンネルは既定の 1 回
  assertVerifyHookWired(h, stand, { maxRetries: 1 });
  assert.equal(out.reason, 'verify-failed', 'hook の NG を採らずに検証し直している (再検証は合格するコマンド)');
  assert.equal(existsSync(join(h.cwd, BRIDGE_VERIFY_MARK)), false, 'ブリッジ側で検証し直している');
  assert.equal(out.metrics.verifyPassed, 0);
  assert.equal(out.metrics.verifyAttempts, 2);
  assert.equal(out.metrics.verifyMs, 2468);
  // 配送側は hook の最終結果 (失敗出力ごと) で NG を表示し、handoff を投げ手へ戻す
  assert.deepEqual(h.calls.turns[0].extra.verifyResult, lastResult);
  assert.equal(out.placeholder.deleted, true);
});

test('verify: Stop hook が結果を残さなかった・壊れた結果を残したら、ブリッジ側で 1 回だけ検証する (未検証で通さない)', async (t) => {
  // 残さなかった: hook が起動しなかった (CLI の契約差・hook 内部エラー) のと同じ
  const none = stopHookStand(null);
  const h1 = harness(t, { cc: { hooks: true, verify: markingVerify(1) }, onClaude: none.onClaude });
  const ng = await h1.run();
  assertVerifyHookWired(h1, none, { maxRetries: 1 });
  assert.equal(existsSync(join(h1.cwd, BRIDGE_VERIFY_MARK)), true, 'ブリッジ側で検証していない');
  assert.equal(ng.reason, 'verify-failed');
  assert.equal(ng.metrics.verifyPassed, 0);
  assert.equal(ng.metrics.verifyAttempts, 1);
  assert.ok(Number.isFinite(ng.metrics.verifyMs));
  assert.equal(h1.calls.turns[0].extra.verifyResult.ok, false);
  assert.equal(h1.calls.turns[0].extra.verifyResult.command, markingVerify(1));

  // 壊れた結果 (ok が真偽値でない) は採らない — 「合格らしきもの」で検証を飛ばさない
  const broken = stopHookStand({ attempts: 1, blocksUsed: 0, totalDurationMs: 10, lastResult: { ok: 'yes' } });
  const h2 = harness(t, { cc: { hooks: true, verify: markingVerify(0) }, onClaude: broken.onClaude });
  const ok = await h2.run();
  assertVerifyHookWired(h2, broken, { maxRetries: 1 });
  assert.equal(existsSync(join(h2.cwd, BRIDGE_VERIFY_MARK)), true, 'ブリッジ側で検証していない');
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.metrics.verifyPassed, 1);
  assert.equal(ok.metrics.verifyAttempts, 1);
  assert.equal(h2.calls.turns[0].extra.verifyResult.ok, true);
});

test('verify: ブリッジ側の最終検証の途中で止められたら ⏹ で伝えて aborted で終え、配送も handoff もしない', async (t) => {
  // モデルは成功し、Stop hook の結果が無い (hooks: false) のでブリッジ側の runVerify へ入ったところで
  // /stop が届いた。実機の /stop と同じく、実行記録へ止めた主体を打ってから handle を倒す
  // (src/bridge/messages.js の stop)。本物の verify を通し、走れば合格するコマンドにしておく —
  // 走り切っていれば 'ok' で配送まで進むので、'aborted' と印の不在で「検証は完了しなかった」が分かる
  const handle = { stopRequested: false };
  let h = null;
  h = harness(t, {
    cc: { verify: markingVerify(0) },
    responses: [{ ...OK_RESULT(), result: '直しました\n\n[[handoff:fable]]' }],
    onClaude: () => {
      h.jobRuns.markStopRequested(h.jobRuns.liveList()[0].id, 'human');
      handle.stopRequested = true;
    },
  });
  const out = await h.run({ handle });

  assert.equal(out.reason, 'aborted');
  assert.equal(existsSync(join(h.cwd, BRIDGE_VERIFY_MARK)), false, '止めたのに検証を走らせている');
  assert.equal(
    out.placeholder.edits.at(-1).content,
    '⏹ 停止しました (検証は完了せず、途中変更の有無は git status で確認してください)',
  );
  assert.equal(out.placeholder.deleted, false, '停止を伝える placeholder を消している');
  // モデル実行中の中断 (modelResult 'aborted') とは別 — モデルは成功し、検証の段階で止まった
  assert.equal(out.record.modelResult, 'ok');
  assert.equal(out.record.stage, 'verify');
  // 配送しない = 本文の handoff は実行されない。検証の成否も記録しない (NG と数えない)
  assert.equal(h.calls.turns.length, 0, '止めた job を配送している');
  assert.equal(out.outcome.handoff, undefined);
  assert.equal(out.outcome.verifyDetail, undefined);
  assert.equal(out.metrics.verifyPassed, undefined);
  assert.equal(out.metrics.verifyAttempts, undefined);
  // セッションは検証の前に保存済み (モデルの作業はそのセッションに残り、次の job が resume する)
  assert.equal(h.store.get('T1', 'fable').sessionId, 'S1');

  // 実行記録を閉じるのは src/bridge/queue.js の runItem — 同じ引数の形で終端を書く
  const record = createRunRecorder({ jobRuns: h.jobRuns })(out.record.id).finish({
    reason: out.reason,
    detail: out.outcome.verifyDetail ?? '',
    handoff: out.outcome.handoff ?? null,
    taskState: out.outcome.taskState ?? null,
    taskSubmitted: out.outcome.taskSubmitted === true,
  });
  assert.equal(record.stage, 'ended');
  assert.equal(record.outcome, 'aborted');
  assert.equal(record.reason, 'aborted');
  assert.equal(record.stopKind, 'human');
  assert.equal(record.next, 'human', '止めた job の次は人間 (投げ手の bot へ回さない)');
  assert.equal(record.handoff, null);
  assert.equal(record.stageDetail, '');
});

// --- verify NG の理由 (outcome.verifyDetail → 実行記録の stageDetail、src/bridge/queue.js が渡す) ---

test('verify NG の理由: ブリッジ側の最終検証が NG なら、出口と出力の末尾数行を 1 行に畳んで outcome に渡す', async (t) => {
  const tap = ['ok 1 - a', 'not ok 2 - b', '1..2', '# tests 2', '# pass 1', '# fail 1', '# duration_ms 5'];
  const h = harness(t, { cc: { verify: `node -e "console.log(['${tap.join("','")}'].join('\\n'));process.exit(3)"` } });
  const out = await h.run();
  assert.equal(out.reason, 'verify-failed', '終了理由は一語のまま (完全一致で比べる側がある)');
  assert.equal(out.outcome.verifyDetail, 'exit 3: 1..2 / # tests 2 / # pass 1 / # fail 1 / # duration_ms 5');
});

test('verify NG の理由: Stop hook の最終 NG も畳む — 空行を落とし、長ければ末尾を残して 200 字に切る', async (t) => {
  const short = stopHookStand({
    attempts: 2, blocksUsed: 1, totalDurationMs: 900,
    lastResult: { ran: true, ok: false, command: 'from-hook', durationMs: 900, output: 'a\r\nb\r\n\r\n  c  \r\n\r\n', code: 1 },
  });
  const h1 = harness(t, { cc: { hooks: true, verify: markingVerify(0) }, onClaude: short.onClaude });
  const out1 = await h1.run();
  assert.equal(out1.reason, 'verify-failed');
  assert.equal(out1.outcome.verifyDetail, 'exit 1: a / b / c');

  const tail = 'E'.repeat(250);
  const long = stopHookStand({
    attempts: 2, blocksUsed: 1, totalDurationMs: 900,
    lastResult: {
      ran: true, ok: false, command: 'from-hook', durationMs: 900, code: 1,
      output: `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n${tail}\n`,
    },
  });
  const h2 = harness(t, { cc: { hooks: true, verify: markingVerify(0) }, onClaude: long.onClaude });
  const out2 = await h2.run();
  const detail = out2.outcome.verifyDetail;
  assert.equal(detail.length, 200);
  assert.ok(detail.startsWith('exit 1: …'), detail);
  assert.ok(detail.endsWith(tail.slice(-150)), '末尾 (失敗が書かれる側) を落としている');
});

test('verify NG の理由: 時間切れと起動エラーは出口の名前と error を載せる', async (t) => {
  const cases = [
    [{ ran: true, ok: false, timedOut: true, error: 'timeout after 600.0s', output: '' }, 'timeout: timeout after 600.0s'],
    [{ ran: true, ok: false, error: 'spawn failed: ENOENT', output: '' }, '起動エラー: spawn failed: ENOENT'],
  ];
  for (const [lastResult, expected] of cases) {
    const stand = stopHookStand({ attempts: 1, blocksUsed: 0, totalDurationMs: 10, lastResult: { command: 'from-hook', durationMs: 10, ...lastResult } });
    const h = harness(t, { cc: { hooks: true, verify: markingVerify(0) }, onClaude: stand.onClaude });
    const out = await h.run();
    assert.equal(out.reason, 'verify-failed');
    assert.equal(out.outcome.verifyDetail, expected);
  }
});

test('verify NG の理由: 合格・verify 無し・配送に落ちた job には載せない', async (t) => {
  const none = await harness(t).run();
  assert.equal(none.reason, 'ok');
  assert.equal(none.outcome.verifyDetail, undefined);

  const pass = await harness(t, { cc: { verify: 'node -e "process.exit(0)"' } }).run();
  assert.equal(pass.reason, 'ok');
  assert.equal(pass.outcome.verifyDetail, undefined);

  // verify は NG だが配送に落ちた — 終わり方は deliver-failed で、verify の理由は持ち込まない
  const lost = await harness(t, {
    cc: { verify: 'node -e "process.exit(1)"' },
    turnResult: { delivered: false, handedOff: false, failures: ['本文: archived'] },
  }).run();
  assert.equal(lost.reason, 'deliver-failed');
  assert.equal(lost.outcome.verifyDetail, undefined);
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

test('実行記録に、この job が実際に読んだ役割文と runtime / model / effort からハーネスの版を残す', async (t) => {
  const roleText = `${PROTOCOL}
# Fable の職務 (版 1)
`;
  const commonText = `${PROTOCOL}
# 共通規定
`;
  const h = harness(t, { roleText, commonText, effort: 'high' });
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const expected = harnessFingerprint({
    sources: [
      { label: 'roles/_common.md', text: commonText },
      { label: 'roles/fable.md', text: roleText, own: true },
    ],
    runtime: 'claude',
    model: 'claude-opus-4',
    effort: 'high',
  });
  assert.deepEqual(out.record.harness, expected);
  assert.equal(out.record.harness.role, 'fable');

  // 役割文を書き換えた次の job は別の版になる
  writeFileSync(join(h.root, 'roles', 'fable.md'), `${PROTOCOL}
# Fable の職務 (版 2)
`);
  const next = await h.run();
  assert.notEqual(next.record.harness.rev, expected.rev);
});

test('解き直し (src/replay.js) のスレッドの job は、改訂のタスクの作業ツリーにある下書きの役割文で走る', async (t) => {
  const h = harness(t, { threadTask: { id: '5', state: 'in-progress', replay: { of: '3', caseId: '1', kind: 'sent-back', base: 'abc1234' } } });
  const draft = join(h.root, '.worktrees', 'task-3', 'roles');
  mkdirSync(draft, { recursive: true });
  writeFileSync(join(draft, '_common.md'), `${PROTOCOL}\n# 共通規定 (下書き)\n`);
  writeFileSync(join(draft, 'fable.md'), `${PROTOCOL}\n# Fable の職務 (下書き)\n`);
  const out = await h.run();
  assert.equal(out.reason, 'ok');
  const parts = h.calls.claude[0].roleTextSent.split(ROLE_SEP);
  assert.match(parts[0], /# 共通規定 \(下書き\)$/);
  assert.match(parts[1], /# Fable の職務 \(下書き\)$/);
  // 版の指紋も下書きのもの (本番の版と別の版として記録される — 成績からは解き直しごと外す)
  const prod = harness(t);
  await prod.run();
  assert.notEqual(out.record.harness.rev, (await prod.jobRuns.get('j1')).harness.rev);
});

test('解き直しの下書きの役割文が読めなければ本番の役割文へ倒さず role-unreadable で止める', async (t) => {
  const h = harness(t, { threadTask: { id: '5', state: 'in-progress', replay: { of: '3', caseId: '1', kind: 'canary', base: 'abc1234' } } });
  const out = await h.run();
  assert.equal(out.reason, 'role-unreadable');
  assert.equal(h.calls.claude.length, 0);
  const shown = out.placeholder.edits.at(-1).content;
  assert.match(shown, /role prompt を読めません \(roles\/_common\.md\)/);
  assert.ok(shown.includes(join('.worktrees', 'task-3', 'roles', '_common.md')), shown);
});
