import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createBoardWiring } from '../src/bridge/board.js';
import { createContractWiring } from '../src/bridge/contracts.js';
import { createDiscordWiring } from '../src/bridge/discord.js';
import { createJobRunner } from '../src/bridge/job.js';
import { createMessageWiring } from '../src/bridge/messages.js';
import { createOrgApplyWiring } from '../src/bridge/orgapply.js';
import { createPromptBuilder } from '../src/bridge/prompt.js';
import { createProposalWiring } from '../src/bridge/proposals.js';
import { createJobQueueWiring } from '../src/bridge/queue.js';
import { createRecoveryWiring } from '../src/bridge/recovery.js';
import { createRunRecorder } from '../src/bridge/recorder.js';
import { createSchedulerWiring, createTickLedger } from '../src/bridge/scheduler.js';
import { createShutdownWiring } from '../src/bridge/shutdown.js';
import { createSocietyWiring } from '../src/bridge/society.js';
import { createToolApprovalWiring } from '../src/bridge/tools.js';
import { createTurnWiring } from '../src/bridge/turn.js';
import { HopTracker } from '../src/hops.js';
import { createLifecycle } from '../src/interactions.js';
import { JobQueue } from '../src/queue.js';

// src/index.js (組み立て) と src/bridge/*.js (配線) の契約。
// index.js は起動しないと読めないので、**index.js が参照する `x.y` が factory の戻りに実在する**ことを
// source と実物の突き合わせで固定する。配線の返し忘れ (undefined を deps に渡す) は起動時に
// 何も言わず、最初のメッセージや tick で TypeError になる — 分割のときに実際に起きた。

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const bridgeFiles = () => readdirSync(fileURLToPath(new URL('../src/bridge', import.meta.url))).filter((f) => f.endsWith('.js')).sort();
const importsOf = (source) => [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);

function captureConsole(t) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
}

/** index.js と同じ形で全配線を組む (依存は中身の無い偽物 — factory は組み立て時に触らない) */
function assemble() {
  const config = { guildId: 'G', bots: {}, channels: {} };
  const bots = new Map();
  const hops = new HopTracker(12, 3);
  const jobs = new JobQueue();
  const lifecycle = createLifecycle();
  const pauseStore = { paused: false, current: () => ({}) };
  const jobRuns = { forThread: () => [], list: () => [], get: () => null };
  const contracts = { list: () => [], push() {}, claim: () => null, removeById: () => false };
  const runRecorder = createRunRecorder({ jobRuns });
  const limits = {
    maxApprovalCards: 3, approvalWaitMs: 1000, approvalHookTools: [], maxHops: 12, maxSelfHops: 3,
    fetchLimit: 80, transcriptCharBudget: 0, quietWindowMs: 3000, quietWaitMaxMs: 15000, attachments: {},
    maxStdoutBytes: 1024,
  };
  const noop = () => {};
  const discord = createDiscordWiring({ config, bots });
  const ledger = createTickLedger({ tickStateStore: { get: () => null, set: noop }, autonomyChannels: [] });
  const board = { list: () => [], findByThread: () => null };
  // 社会は mode off で組む (偽の store は渡さない — off の配線は台帳に触れない)
  const societyWiring = createSocietyWiring({
    society: { mode: 'off' }, store: null, pauseStore, lifecycle, jobRuns,
    postAs: noop, scanThread: noop, log: { log: noop, error: noop },
  });
  const recovery = createRecoveryWiring({
    config, board, jobRuns, contracts, pauseStore, autonomyChannels: [], tickStates: ledger.tickStates,
    saveTickState: ledger.saveTickState, postToThread: discord.postToThread, reissueReview: noop,
    recoveryStore: null, jobs, hops, bots, proposals: null,
  });
  const scheduler = createSchedulerWiring({
    config, board, bots, hops, proposals: null, dutyBots: [], pauseStore, lifecycle, recovery,
    autonomyChannels: [], tickStates: ledger.tickStates, saveTickState: ledger.saveTickState,
    findGuildChannel: discord.findGuildChannel,
    // 自律起動の門 (§12.3 (1)) が見る台帳。偽物は broken を持たない = 健全扱い
    jobRuns, tickStateStore: { get: () => null, set: noop }, recoveryStore: null,
  });
  const proposalWiring = createProposalWiring({
    config, root: '.', proposals: null, board, bots, hops, pauseStore, lifecycle, inbox: {},
    ownerTargets: [], execBotKeys: [], findGuildChannel: discord.findGuildChannel, sweepOrgApply: noop,
  });
  const boardWiring = createBoardWiring({
    root: '.', board, bots, contracts, hops, pauseStore, proposals: null, notifyDutyEvent: noop,
    setContractKindOverride: noop, claimContractKindOverride: () => null, contractCwd: (cc) => cc.cwd,
    channelConfigFor: discord.channelConfigFor, safeProposalContext: () => null, releaseApplyWorktree: noop,
  });
  const orgApply = createOrgApplyWiring({
    config, root: '.', proposals: null, board, bots, hops, findGuildChannel: discord.findGuildChannel,
    safeProposalContext: () => null, resolveApplyBaseCommit: async () => null, postToProposal: noop,
    requestReview: noop,
  });
  const contractWiring = createContractWiring({ contracts, botKeyOf: discord.botKeyOf });
  const toolApprovals = createToolApprovalWiring({ toolExtra: {}, approvals: {}, limits });
  const prompt = createPromptBuilder({ bots, limits });
  const turn = createTurnWiring({
    config, inbox: {}, contracts, ownerTargets: [], limits, botKeyOf: discord.botKeyOf,
    botEntries: discord.botEntries, contractCwd: contractWiring.contractCwd, noteTaskCompletion: noop,
    postApprovalRequests: noop,
  });
  const jobRunner = createJobRunner({
    config, root: '.', commonRolePath: 'roles/_common.md', store: {}, roster: {}, jobRuns, board, limits,
    ownerTargets: [], runRecorder, approvedRulesFor: () => [], applyIncomingContract: noop,
    claimContractKindOverride: () => null, buildPrompt: noop, isInfraMessage: () => false, postTurn: noop,
    fileProposal: noop, applyApproval: noop, applyReview: noop, applyProposalAdjudication: noop,
    raiseProposal: noop, decideApproval: noop, botEntries: discord.botEntries,
  });
  const jobQueue = createJobQueueWiring({ jobs, lifecycle, jobRuns, runRecorder, noteAutonomyOutcome: noop, society: societyWiring });
  const shutdownWiring = createShutdownWiring({ root: '.', bots, jobs, lifecycle, jobRuns, waitForJobsDrained: noop, exit: noop });
  const messages = createMessageWiring({
    config, bots, hops, jobs, board, jobRuns, recovery, society: societyWiring, lifecycle, limits, runRecorder, enqueue: noop,
    runJob: noop, claimContract: noop, discardContractFor: noop, noteJobSpent: noop, closeInboxForThread: noop,
    channelConfigFor: discord.channelConfigFor, botKeyOf: discord.botKeyOf, botRoleFor: discord.botRoleFor,
    otherBotMentionIds: discord.otherBotMentionIds,
    // 上限で見送ったときの宛先と記録先 (index.js が渡すのと同じ形)
    ownerTargets: [], noteHopLimit: noop,
  });
  return {
    discord, recovery, scheduler, proposalWiring, boardWiring, orgApply, contractWiring, toolApprovals,
    prompt, turn, jobRunner, jobQueue, shutdownWiring, messages, societyWiring,
  };
}

test('index.js が参照する配線のメンバーは、その factory の戻りに実在する関数', (t) => {
  captureConsole(t);
  const source = src('index.js');
  const wiring = assemble();
  const names = Object.keys(wiring).join('|');
  // `./bridge/discord.js` や `data/recovery.json` のようなパスは参照ではない (直前が / や . なら除く)
  const refs = [...source.matchAll(new RegExp(`(?<![/.\\w])(${names})\\.([A-Za-z_]\\w*)`, 'g'))]
    .map((m) => [m[1], m[2]])
    .filter(([, name]) => !['js', 'mjs', 'json'].includes(name));
  assert.ok(refs.length >= 40, `index.js の参照が少なすぎる (${refs.length} 件) — 組み立ての形が変わった?`);
  const missing = refs
    .filter(([obj, name]) => typeof wiring[obj]?.[name] !== 'function')
    .map(([obj, name]) => `${obj}.${name}`);
  assert.deepEqual([...new Set(missing)], [], 'factory が返していないメンバーを index.js が渡している');
});

test('index.js は bridge/ の全モジュールを組み込み、bridge/ 同士は互いを import しない (recovery → discord の純関数だけ例外)', () => {
  const index = src('index.js');
  const indexImports = importsOf(index);
  for (const file of bridgeFiles()) {
    assert.ok(indexImports.includes(`./bridge/${file}`), `index.js が bridge/${file} を組み込んでいない`);
  }
  for (const file of bridgeFiles()) {
    const sibling = importsOf(src(`bridge/${file}`)).filter((p) => p.startsWith('./'));
    const allowed = file === 'recovery.js' ? ['./discord.js'] : [];
    assert.deepEqual(sibling, allowed, `bridge/${file} が同じ層の別モジュールへ依存している (index.js で注入すること)`);
  }
});

test('判断の層 (src/*.js) は配線の層 (src/bridge/) へ依存しない', () => {
  const pure = readdirSync(fileURLToPath(new URL('../src', import.meta.url)))
    .filter((f) => f.endsWith('.js') && f !== 'index.js');
  for (const file of pure) {
    const imports = importsOf(src(file));
    assert.equal(imports.some((p) => p.includes('/bridge/')), false, `src/${file} が src/bridge/ を import している`);
  }
});

test('index.js は判断を持たない — 組み立て以外の関数は /status の材料集めだけ', () => {
  const index = src('index.js');
  const functions = [...index.matchAll(/^(?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(functions, ['statusReport']);
  // discord.js を直接触るのは bridge/ 側 (index.js は client を作らない)
  assert.equal(/from 'discord\.js'/.test(index), false, 'index.js が discord.js を直接 import している');
});
