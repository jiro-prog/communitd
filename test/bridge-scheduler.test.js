import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskBoardStore } from '../src/board.js';
import { AUTONOMY_TICK_MS, createSchedulerWiring, createTickLedger } from '../src/bridge/scheduler.js';
import { formatSchemaTag } from '../src/contract.js';
import { HopTracker } from '../src/hops.js';
import { createLifecycle } from '../src/interactions.js';
import { JobRunStore } from '../src/jobruns.js';
import { RecoveryStore } from '../src/recovery.js';
import { initiativeThreadName, scoutThreadName } from '../src/mentions.js';
import {
  INITIATIVE_JOB_BUDGET,
  SCOUT_JOB_BUDGET,
  dayKeyFor,
  formatInitiativeTag,
  initialState,
} from '../src/scheduler.js';
import { PauseStore, TickStateStore } from '../src/store.js';

// src/bridge/scheduler.js — tick の判断 (src/scheduler.js) を Discord とボードへ落とす配線。
// ボード・hops・勘定の永続化は本物、Discord (スレッド作成と投稿) だけ偽物。

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

const T0 = Date.parse('2026-09-06T01:00:00.000Z');

function configWith(autonomy = {}) {
  return {
    guildId: 'G',
    channels: {
      kt: {
        cwd: 'C:/kt',
        verify: 'npm test',
        hooks: true,
        autonomy: {
          enabled: true,
          worker: { bots: ['opus'] },
          reviewer: 'fable',
          directionFile: 'docs/direction.md',
          ...autonomy,
        },
      },
    },
  };
}

function harness(t, {
  autonomy = {}, tasks = [], proposals = null, dutyBots = [], paused = false, recovery = null,
  createFail = false, sendFail = false, channelLookupFail = false, brokenLedger = null,
} = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-scheduler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = configWith(autonomy);
  const board = new TaskBoardStore(join(dir, 'tasks.json'));
  for (const task of tasks) {
    const made = board.propose({ channel: 'kt', title: task.title, rationale: task.rationale ?? 'r', touch: task.touch ?? ['a.py'], jobBudget: task.jobBudget ?? 20 }, { by: 'opus' });
    if (task.state !== 'proposed') board.approve(made.id, { by: 'fable' });
  }
  const threads = [];
  const order = [];
  const ktChannel = {
    threads: {
      create: async ({ name }) => {
        if (createFail) throw new Error('Missing Access');
        const thread = {
          id: `T${threads.length + 1}`,
          name,
          sent: [],
          send: async (payload) => {
            if (sendFail) throw new Error('archived');
            thread.sent.push(payload);
            return { id: `${thread.id}-m` };
          },
        };
        threads.push(thread);
        order.push('start');
        return thread;
      },
    },
  };
  const bots = new Map([
    ['opus', { key: 'opus', userId: 'O', client: {}, cfg: { displayName: 'Opus' } }],
    ['fable', { key: 'fable', userId: 'F', client: {}, cfg: { displayName: 'Fable' } }],
  ]);
  const hops = new HopTracker(12, 3);
  const lifecycle = createLifecycle();
  // 制御台帳のどれか 1 つが読めない状況 (§12.3 (1))。本物の store を壊れたファイルで開く
  const LEDGER_CLASSES = {
    pauseStore: [PauseStore, 'pause.json'],
    jobRuns: [JobRunStore, 'job-runs.json'],
    recoveryStore: [RecoveryStore, 'recovery.json'],
    tickStateStore: [TickStateStore, 'tick-states.json'],
  };
  const stores = { jobRuns: null, recoveryStore: null, pauseStore: { paused }, tickStateStore: null };
  if (brokenLedger) {
    const [Store, name] = LEDGER_CLASSES[brokenLedger];
    const file = join(dir, name);
    writeFileSync(file, '{ 壊れた', 'utf8');
    stores[brokenLedger] = new Store(file);
  }
  stores.tickStateStore ??= new TickStateStore(join(dir, 'tick-states.json'));
  const ledger = createTickLedger({ tickStateStore: stores.tickStateStore, autonomyChannels: ['kt'] });
  const scheduler = createSchedulerWiring({
    config,
    board,
    bots,
    hops,
    proposals,
    dutyBots,
    pauseStore: stores.pauseStore,
    lifecycle,
    recovery,
    autonomyChannels: ['kt'],
    tickStates: ledger.tickStates,
    saveTickState: ledger.saveTickState,
    jobRuns: stores.jobRuns,
    tickStateStore: stores.tickStateStore,
    recoveryStore: stores.recoveryStore,
    findGuildChannel: (client, name) => {
      if (channelLookupFail) throw new Error('lookup failed');
      return name === 'kt' ? ktChannel : null;
    },
  });
  return {
    ...io, dir, config, board, bots, hops, lifecycle, threads, order,
    tickStateStore: stores.tickStateStore, stores, ...ledger, ...scheduler,
  };
}

test('tick の間隔は 60 秒', () => {
  assert.equal(AUTONOMY_TICK_MS, 60 * 1000);
});

test('createTickLedger は台帳の部分だけを復元・永続化し、バックオフは持ち越さない', (t) => {
  const { errors } = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'tick-states.json');
  const store = new TickStateStore(file);
  store.set('kt', { dayKey: dayKeyFor(T0), jobsToday: 3, lastScoutAt: T0 - 1000, initiative: { lastRunAt: {}, spentToday: {} } });

  const ledger = createTickLedger({ tickStateStore: store, autonomyChannels: ['kt', 'dev'] });
  assert.equal(ledger.tickStates.get('kt').jobsToday, 3);
  assert.equal(ledger.tickStates.get('kt').lastScoutAt, T0 - 1000);
  assert.equal(ledger.tickStates.get('kt').backoffUntil, 0);
  assert.deepEqual(ledger.tickStates.get('dev'), initialState(), '記録の無いチャンネルは初期値');

  ledger.saveTickState('kt', { ...ledger.tickStates.get('kt'), jobsToday: 4, backoffUntil: T0 + 60000, backoffLevel: 2 });
  const reread = new TickStateStore(file).get('kt');
  assert.equal(reread.jobsToday, 4);
  assert.equal(reread.backoffUntil, undefined, 'バックオフを台帳へ落としている');
  assert.equal(ledger.tickStates.get('kt').backoffUntil, T0 + 60000, 'メモリ側はバックオフを持つ');

  // 書けなくても tick は止めない (メモリだけ進める)
  const broken = createTickLedger({
    tickStateStore: { get: () => null, set: () => { throw new Error('disk full'); } },
    autonomyChannels: ['kt'],
  });
  broken.saveTickState('kt', { ...initialState(), jobsToday: 9 });
  assert.equal(broken.tickStates.get('kt').jobsToday, 9);
  assert.ok(errors.some((e) => e === '[scheduler] kt: 勘定を保存できませんでした: disk full'), errors.join('\n'));
});

test('start-task: スレッド作成 → 着手の記録 → 予算の払い出し → 起動メッセージ の順で適用し、勘定を落とす', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint を直す' }] });
  await h.autonomyTick(T0);

  assert.equal(h.threads.length, 1);
  const [thread] = h.threads;
  assert.equal(thread.name, 'task/1 lint を直す');
  const task = h.board.get('1');
  assert.equal(task.state, 'in-progress');
  assert.equal(task.threadId, 'T1');
  assert.equal(task.branch, 'task/1');
  assert.equal(h.hops.taskBudget('T1'), 20, '予算を払い出していない');
  assert.equal(thread.sent.length, 1);
  assert.ok(thread.sent[0].content.startsWith('<@O>\n'), '担当へのメンションで始まっていない');
  assert.match(thread.sent[0].content, /## タスク 1: lint を直す/);
  assert.match(thread.sent[0].content, /docs\/direction\.md/);
  assert.deepEqual(thread.sent[0].allowedMentions.users, ['O']);
  assert.ok(h.logs.some((l) => l === '[scheduler] kt: タスク 1 を opus で起動 (thread T1 / 予算 20 job / 投稿は fable)'), h.logs.join('\n'));
  assert.equal(h.tickStates.get('kt').jobsToday, 1);
  assert.equal(new TickStateStore(join(h.dir, 'tick-states.json')).get('kt').jobsToday, 1, '勘定を永続化していない');

  // 次の tick では in-progress が枠を使っているので新しい着手は無い
  await h.autonomyTick(T0 + AUTONOMY_TICK_MS);
  assert.equal(h.threads.length, 1);
});

test('start-task: スレッド作成に失敗したらボードは触らない (次の tick で再挑戦)', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }], createFail: true });
  await h.autonomyTick(T0);
  assert.equal(h.board.get('1').state, 'approved');
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: タスク 1 のスレッド作成に失敗: Missing Access'), h.errors.join('\n'));
  // 選んだ行動は job として数え切る (起動できたかは組み込み側の話)
  assert.equal(h.tickStates.get('kt').jobsToday, 1);
});

test('start-task: 起動メッセージの投稿に失敗したら blocked (要人間) へ落とす', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }], sendFail: true });
  await h.autonomyTick(T0);
  const task = h.board.get('1');
  assert.equal(task.state, 'blocked');
  assert.equal(task.threadId, 'T1', '着手の記録 (スレッド) は残る');
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: タスク 1 の起動に失敗: archived'), h.errors.join('\n'));
});

test('pause 中は行動を選ばず、ログは止めている間 1 回だけ出す', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }], paused: true });
  await h.autonomyTick(T0);
  await h.autonomyTick(T0 + AUTONOMY_TICK_MS);
  assert.equal(h.threads.length, 0);
  assert.equal(h.board.get('1').state, 'approved');
  assert.equal(h.logs.filter((l) => l.startsWith('[pause] 自律運転は停止中')).length, 1);
  assert.equal(h.tickStates.get('kt').jobsToday, 0);
});

test('制御台帳が 1 つでも読めなければ何も選ばず、ログは 1 回だけ (§12.3 (1))', async (t) => {
  for (const dep of ['pauseStore', 'jobRuns', 'recoveryStore', 'tickStateStore']) {
    const h = harness(t, {
      tasks: [{ title: 'lint' }],
      autonomy: { scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
      brokenLedger: dep,
    });
    await h.autonomyTick(T0);
    await h.autonomyTick(T0 + AUTONOMY_TICK_MS);

    assert.equal(h.threads.length, 0, `${dep}: 台帳が読めないのに起動している`);
    assert.equal(h.board.get('1').state, 'approved', dep);
    assert.equal(h.tickStates.get('kt').jobsToday, 0, `${dep}: 予算を使っている`);
    assert.equal(h.tickStates.get('kt').lastScoutAt, 0, `${dep}: 起こしていない巡回で時計が進んでいる`);
    const notices = h.errors.filter((e) => e.startsWith('[store] 制御台帳が読めません'));
    assert.equal(notices.length, 1, `${dep}: ${h.errors.join('\n')}`);
    assert.match(notices[0], /自律起動は止まります。直すか手で退避してください/);
  }
});

test('制御台帳が読めなければ sweep は回り、duty イベントの発議も起きない', async (t) => {
  const calls = [];
  const dutyBots = [{
    botKey: 'fable',
    initiativeBudget: 1,
    duties: [{ key: 'health', eventKinds: ['block'], intervalMin: 60, maxOpenProposals: 2 }],
  }];
  const h = harness(t, {
    tasks: [{ title: 'lint' }],
    proposals: { openList: () => [] },
    dutyBots,
    brokenLedger: 'recoveryStore',
    recovery: { sweep: async () => { calls.push('sweep'); }, autoTick: async () => { calls.push('auto'); } },
  });
  await h.autonomyTick(T0);
  // 止めているのは自律起動であって観測ではない (pause と同じ扱い)
  assert.deepEqual(calls, ['sweep', 'auto']);
  assert.equal(h.threads.length, 0);

  await h.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', detail: 'タスク #1 が blocked', now: T0 });
  assert.equal(h.threads.length, 0, 'イベント経由の発議が抜け道になっている');
});

test('tick は 見回り → 自動復旧 → 行動 の順で、見回りが落ちても行動は続き、受付停止中は何もしない', async (t) => {
  const calls = [];
  const recovery = {
    sweep: async () => { calls.push('sweep'); },
    autoTick: async () => { calls.push('auto'); },
  };
  const h = harness(t, { tasks: [{ title: 'lint' }], recovery });
  // 配線側の order (スレッド作成) と復旧側の calls を 1 本の時系列に
  const timeline = [];
  recovery.sweep = async () => { timeline.push('sweep'); };
  recovery.autoTick = async () => { timeline.push('auto'); };
  const originalCreate = h.threads;
  await h.autonomyTick(T0);
  assert.deepEqual([...timeline, ...h.order], ['sweep', 'auto', 'start']);
  assert.equal(originalCreate.length, 1);

  const failing = harness(t, {
    tasks: [{ title: 'lint' }],
    recovery: { sweep: async () => { throw new Error('board unreadable'); }, autoTick: async () => {} },
  });
  await failing.autonomyTick(T0);
  assert.ok(failing.errors.some((e) => e === '[recovery] 見回りに失敗 (tick は続けます): board unreadable'), failing.errors.join('\n'));
  assert.equal(failing.threads.length, 1, '見回りの失敗で着手が止まっている');

  const stopping = harness(t, { tasks: [{ title: 'lint' }], recovery: { sweep: async () => { calls.push('late'); }, autoTick: async () => {} } });
  stopping.lifecycle.stopAccepting();
  await stopping.autonomyTick(T0);
  assert.equal(stopping.threads.length, 0);
  assert.equal(calls.includes('late'), false, '受付停止中に見回っている');
});

test('scout: スレッドを立て、固定予算を配り、その job だけ task-proposal で検査する種別を被せる', async (t) => {
  const h = harness(t, { autonomy: { scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } } });
  await h.autonomyTick(T0);
  assert.equal(h.threads.length, 1);
  const [thread] = h.threads;
  assert.equal(thread.name, scoutThreadName(T0));
  assert.equal(h.hops.taskBudget('T1'), SCOUT_JOB_BUDGET);
  assert.equal(h.claimContractKindOverride('T1', 'opus'), 'task-proposal');
  assert.equal(h.claimContractKindOverride('T1', 'opus'), null, '取り出したら消える (次の 1 job だけ)');
  assert.ok(thread.sent[0].content.startsWith('<@O>\n'));
  assert.match(thread.sent[0].content, /## 巡回 \(スカウト\)/);
  assert.match(thread.sent[0].content, /- \(なし\)/);
  assert.equal(h.tickStates.get('kt').lastScoutAt, T0);
  assert.ok(h.logs.some((l) => l === `[scheduler] kt: 巡回を opus で起動 (thread T1 / 予算 ${SCOUT_JOB_BUDGET} job / 投稿は fable)`), h.logs.join('\n'));

  // 間隔が明けるまで次の巡回は起きない
  await h.autonomyTick(T0 + 30 * 60 * 1000);
  assert.equal(h.threads.length, 1);
});

test('scout: 起動に失敗したら種別の上書きを取り消す (次の無関係な job を task-proposal で検査しない)', async (t) => {
  const h = harness(t, { autonomy: { scout: { bot: 'opus', intervalMin: 60 } }, sendFail: true });
  await h.autonomyTick(T0);
  assert.equal(h.claimContractKindOverride('T1', 'opus'), null);
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: 巡回の起動に失敗: archived'), h.errors.join('\n'));
});

test('duty イベントは宣言した duty へだけ配り、巡回と同じ財布から予算を引く', async (t) => {
  const dutyBots = [{
    botKey: 'fable',
    initiativeBudget: 1,
    duties: [{ key: 'health', eventKinds: ['block'], intervalMin: 60, maxOpenProposals: 2 }],
  }];
  const h = harness(t, { proposals: { openList: () => [] }, dutyBots });
  await h.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', detail: 'タスク #1 が blocked', now: T0 });

  assert.equal(h.threads.length, 1);
  const [thread] = h.threads;
  assert.equal(thread.name, initiativeThreadName('health', T0));
  assert.equal(h.hops.taskBudget('T1'), INITIATIVE_JOB_BUDGET);
  assert.ok(thread.sent[0].content.startsWith('<@F>\n'), '発議する bot へのメンションで始まっていない');
  assert.match(thread.sent[0].content, /## 発議の巡回 — duty: health/);
  assert.ok(thread.sent[0].content.includes(formatSchemaTag('report')));
  assert.ok(thread.sent[0].content.includes(formatInitiativeTag('巡回')));
  assert.match(thread.sent[0].content, /\*\*block — タスク #1 が blocked\*\* を受けて起こしました/);
  assert.deepEqual(thread.sent[0].allowedMentions.users, ['F']);
  const state = h.tickStates.get('kt');
  assert.equal(state.jobsToday, 1);
  assert.equal(state.initiative.spentToday.fable, 1);
  assert.equal(state.initiative.lastRunAt['fable/health'], T0);
  assert.ok(h.logs.some((l) => l.startsWith('[scheduler] kt: duty health の発議を fable で起動') && l.includes('契機 block — タスク #1 が blocked')), h.logs.join('\n'));

  // 日次発議上限 (1) に達したので 2 件目は配れない (起動しなかった分は無料にしない)
  await h.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', detail: 'タスク #2 が blocked', now: T0 + 1000 });
  assert.equal(h.threads.length, 1);
  assert.ok(h.logs.some((l) => l === '[scheduler] kt: block を fable/health へ配れません — fable の日次発議上限 (1 job) に達しています'), h.logs.join('\n'));
});

test('duty イベント: 拾わない種類・除外した bot・pause 中・発議機構なし では起こさない', async (t) => {
  const dutyBots = [{
    botKey: 'fable', initiativeBudget: 3,
    duties: [{ key: 'health', eventKinds: ['block'], intervalMin: 60 }],
  }];
  const h = harness(t, { proposals: { openList: () => [] }, dutyBots });
  await h.notifyDutyEvent({ eventKind: 'send-back', channelName: 'kt', now: T0 });
  await h.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', excludeBotKeys: ['fable'], now: T0 });
  assert.equal(h.threads.length, 0);
  assert.equal(h.tickStates.get('kt').jobsToday, 0);

  const paused = harness(t, { proposals: { openList: () => [] }, dutyBots, paused: true });
  await paused.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', now: T0 });
  assert.equal(paused.threads.length, 0);

  const disabled = harness(t, { proposals: null, dutyBots });
  await disabled.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', now: T0 });
  assert.equal(disabled.threads.length, 0);

  // 配信の失敗は呼び出し元へ投げない (ボードを動かした直後に呼ばれる)
  const broken = harness(t, { proposals: { openList: () => [] }, dutyBots, channelLookupFail: true });
  await broken.notifyDutyEvent({ eventKind: 'block', channelName: 'kt', now: T0 });
  assert.ok(broken.errors.some((e) => e === '[scheduler] block の配信に失敗: lookup failed'), broken.errors.join('\n'));
  // 起動できなかったぶんの予算は戻さない (失敗した起動を無料にすると、投稿に失敗し続けるチャンネルで無限に試せる)
  assert.equal(broken.tickStates.get('kt').jobsToday, 1);
});

test('noteAutonomyOutcome: 予算を配ったスレッドの失敗だけがバックオフを動かし、台帳には落とさない', (t) => {
  const h = harness(t);
  h.hops.grantTaskBudget('T9', 5);
  const item = { jobId: 'j1', threadId: 'T9', channelName: 'kt', botKey: 'opus' };

  h.noteAutonomyOutcome({ ...item, threadId: 'T-human' }, 'failed(rate limit)');
  assert.equal(h.tickStates.get('kt').backoffUntil, 0, '人間が回している job の失敗で社会を止めている');

  h.noteAutonomyOutcome(item, 'failed(rate limit)');
  assert.ok(h.tickStates.get('kt').backoffUntil > Date.now(), 'バックオフに入っていない');
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: 自律 job が失敗 (failed(rate limit)) — 自律起動をバックオフします'), h.errors.join('\n'));
  assert.equal(new TickStateStore(join(h.dir, 'tick-states.json')).get('kt'), null, 'バックオフを台帳へ落としている');

  h.noteAutonomyOutcome({ ...item, initiativeJob: true }, 'ok');
  assert.ok(h.tickStates.get('kt').backoffUntil > Date.now(), '発議 job の成功でバックオフを解いている');
  h.noteAutonomyOutcome(item, 'ok');
  assert.equal(h.tickStates.get('kt').backoffUntil, 0);
});

test('noteJobSpent: 走っているタスクのスレッドの bot 起点 job だけを記帳する', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }] });
  await h.autonomyTick(T0);
  h.noteJobSpent('T1');
  h.noteJobSpent('T1');
  assert.equal(h.board.get('1').jobsSpent, 2);
  h.noteJobSpent('T-none'); // タスクの無いスレッドは何もしない
  assert.equal(h.board.get('1').jobsSpent, 2);
});
