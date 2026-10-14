import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskBoardStore } from '../src/board.js';
import { AUTONOMY_TICK_MS, createSchedulerWiring, createTickLedger } from '../src/bridge/scheduler.js';
import { channelConfigForName, resolveAutonomy } from '../src/config.js';
import { formatSchemaTag } from '../src/contract.js';
import { HopTracker } from '../src/hops.js';
import { createLifecycle } from '../src/interactions.js';
import { JobRunStore } from '../src/jobruns.js';
import { RecoveryStore } from '../src/recovery.js';
import {
  MAX_TASK_START_CHARS,
  harnessThreadName,
  initiativeThreadName,
  planStartMessage,
  planThreadName,
  scoutStartMessage,
  scoutThreadName,
} from '../src/mentions.js';
import {
  BACKOFF_BASE_MS,
  INITIATIVE_JOB_BUDGET,
  SCOUT_JOB_BUDGET,
  dayKeyFor,
  formatInitiativeTag,
  initialState,
} from '../src/scheduler.js';
import { PauseStore, TickStateStore } from '../src/store.js';
import { themeCostText } from '../src/themes.js';

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
  createFail = false, sendFail = false, channelLookupFail = false, channelMissing = false, onCreate = null,
  brokenLedger = null, runs = null, themes, settleReplays = null,
} = {}) {
  const io = captureConsole(t);
  // 偽の Discord の故障。後から倒せるように閉包はここを読む (失敗した tick の次で再挑戦できるかを見る)
  // sendFailIf: 投稿の中身で選んで落とす (承認時の備考だけ落とす、など)
  const knobs = { createFail, sendFail, sendFailIf: null, channelMissing, onCreate };
  const dir = mkdtempSync(join(tmpdir(), 'communitd-scheduler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = configWith(autonomy);
  // 主題ファイル (企画の巡回の材料)。渡したらチャンネルの cwd を一時ディレクトリにする —
  // null = まだ無い、文字列 = その本文で置く、{ dir: true } = 読めない (同名のディレクトリ)
  if (themes !== undefined) {
    config.channels.kt.cwd = dir;
    if (themes !== null) {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      if (themes?.dir) mkdirSync(join(dir, 'docs', 'themes.md'));
      else writeFileSync(join(dir, 'docs', 'themes.md'), themes, 'utf8');
    }
  }
  const board = new TaskBoardStore(join(dir, 'tasks.json'));
  for (const task of tasks) {
    const made = board.propose({ channel: 'kt', title: task.title, rationale: task.rationale ?? 'r', touch: task.touch ?? ['a.py'], jobBudget: task.jobBudget ?? 20 }, { by: 'opus' });
    if (task.state !== 'proposed') board.approve(made.id, { by: 'fable', note: task.approvalNote ?? '' });
  }
  const threads = [];
  const order = [];
  const ktChannel = {
    threads: {
      create: async ({ name }) => {
        knobs.onCreate?.();
        if (knobs.createFail) throw new Error('Missing Access');
        const thread = {
          id: `T${threads.length + 1}`,
          name,
          sent: [],
          send: async (payload) => {
            if (knobs.sendFail || knobs.sendFailIf?.(payload)) throw new Error('archived');
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
  // 実行記録を入れて始める (ハーネスの成績の材料)
  if (runs) {
    stores.jobRuns = new JobRunStore(join(dir, 'job-runs.json'));
    for (const run of runs) stores.jobRuns.write(run.id, run);
  }
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
    settleReplays,
    findGuildChannel: (client, name) => {
      if (channelLookupFail) throw new Error('lookup failed');
      return name === 'kt' && !knobs.channelMissing ? ktChannel : null;
    },
  });
  return {
    ...io, dir, config, board, bots, hops, lifecycle, threads, order, knobs,
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

test('start-task: 承認時の備考があれば起動メッセージより前に出し (メンションなし・長ければ分ける)、出せなくても着手は続ける', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint を直す', approvalNote: '承認します。\n- touch の外は触らない' }] });
  await h.autonomyTick(T0);
  const [thread] = h.threads;
  assert.equal(thread.sent.length, 2);
  // 前に置く = 担当の最初の job の文脈 (遡り分) に入る。メンションは起動メッセージの 1 通だけ
  assert.ok(thread.sent[0].content.startsWith('### 承認時の備考 (Fable)\n'), thread.sent[0].content);
  assert.ok(thread.sent[0].content.endsWith('\n\n承認します。\n- touch の外は触らない'), thread.sent[0].content);
  assert.deepEqual(thread.sent[0].allowedMentions.users, []);
  assert.ok(thread.sent[1].content.startsWith('<@O>\n'), '起動メッセージが後に来ていない');
  assert.equal(h.board.get('1').state, 'in-progress');

  // 長い備考は分けて、全部を起動メッセージより前に出す (末尾の注意まで最初の job の文脈に入る)
  const long = harness(t, { tasks: [{ title: 'lint', approvalNote: `${'①重複: なし。\n'.repeat(500)}末尾の注意` }] });
  await long.autonomyTick(T0);
  const sent = long.threads[0].sent.map((p) => p.content);
  assert.ok(sent.length >= 4, `分けていない (${sent.length} 通)`);
  assert.ok(sent.slice(0, -1).every((c) => c.startsWith('### 承認時の備考')), '備考の間に別の投稿が混ざる');
  assert.ok(sent.at(-2).endsWith('末尾の注意'), '末尾の注意が消えている');
  assert.ok(sent.at(-1).startsWith('<@O>\n'), '起動メッセージが最後に来ていない');

  // 出せなくても着手は続ける (残りの備考は諦める — ログは 1 行)
  const failing = harness(t, { tasks: [{ title: 'lint', approvalNote: `${'①重複: なし。\n'.repeat(500)}x` }] });
  failing.knobs.sendFailIf = (payload) => payload.content.startsWith('### 承認時の備考');
  await failing.autonomyTick(T0);
  assert.equal(failing.threads[0].sent.length, 1);
  assert.ok(failing.threads[0].sent[0].content.startsWith('<@O>\n'), '備考を出せないと着手が止まる');
  assert.equal(failing.board.get('1').state, 'in-progress');
  assert.deepEqual(
    failing.errors.filter((e) => e.includes('承認時の備考')),
    ['[scheduler] kt: タスク 1 の承認時の備考を出せません (着手は続けます): archived'],
  );
});

/**
 * 自律起動をスレッドが立つより手前で落とす故障。`on` で壊し、`false` で直す。
 * - resolve: 担当の bot がログインし終えていない (userId 未取得) — 判断の層が担当を選べない
 * - channel: チャンネルを引けない (キャッシュ未取得・権限不足・改名)
 * - create: スレッドを作れない
 */
const EARLY_FAULTS = {
  resolve: (h, botKey, on) => { h.bots.get(botKey).userId = on ? null : { opus: 'O', fable: 'F' }[botKey]; },
  channel: (h, _botKey, on) => { h.knobs.channelMissing = on; },
  create: (h, _botKey, on) => { h.knobs.createFail = on; },
};

const CHANNEL_MISSING = '[scheduler] kt: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)';

test('start-task: 見送り・チャンネルが取れない・スレッド作成の失敗ではボードも予算も動かさず、次の tick で再挑戦する', async (t) => {
  const cases = [
    ['resolve', '[scheduler] kt: 着手を見送り — worker が起動していません (worker.bots: opus)'],
    ['channel', CHANNEL_MISSING],
    ['create', '[scheduler] kt: タスク 1 のスレッド作成に失敗: Missing Access'],
  ];
  for (const [fault, error] of cases) {
    const h = harness(t, { tasks: [{ title: 'lint' }] });
    EARLY_FAULTS[fault](h, 'opus', true);
    await h.autonomyTick(T0);

    assert.equal(h.threads.length, 0, fault);
    const task = h.board.get('1');
    assert.equal(task.state, 'approved', `${fault}: ボードを動かしている`);
    assert.equal(task.threadId ?? null, null, fault);
    assert.equal(h.hops.budgets.size, 0, `${fault}: 起動していないのに予算を配っている`);
    assert.ok(h.errors.includes(error), `${fault}: ${h.errors.join('\n')}`);
    assert.equal(h.logs.some((l) => l.includes('を opus で起動')), false, fault);
    // 選んだ行動は job として数え切る (起動できたかは組み込み側の話)
    assert.equal(h.tickStates.get('kt').jobsToday, 1, fault);

    // 直れば次の tick で同じタスクを起こす
    EARLY_FAULTS[fault](h, 'opus', false);
    await h.autonomyTick(T0 + AUTONOMY_TICK_MS);
    assert.equal(h.threads.length, 1, `${fault}: 再挑戦していない`);
    assert.equal(h.board.get('1').state, 'in-progress', fault);
    assert.equal(h.board.get('1').threadId, 'T1', fault);
    assert.equal(h.hops.taskBudget('T1'), 20, fault);
  }
});

test('start-task: 着手を記録できなければ予算を配らず、起動メッセージも出さない', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }] });
  // スレッドを作っている間にタスクが破棄された — dropped からは着手へ遷移できず board.start が投げる
  h.knobs.onCreate = () => h.board.drop('1', { by: 'fable', reason: '不要になった' });
  await h.autonomyTick(T0);

  assert.equal(h.threads.length, 1, 'スレッドは作った後');
  assert.equal(h.threads[0].sent.length, 0, '着手を記録できないのに起動メッセージを出している');
  assert.equal(h.hops.taskBudget('T1'), null, '着手を記録できないのに予算を配っている');
  assert.equal(h.board.get('1').state, 'dropped');
  assert.equal(h.board.get('1').threadId ?? null, null);
  const notice = h.errors.find((e) => e.startsWith('[scheduler] kt: タスク 1 の着手を記録できません'));
  assert.ok(notice, h.errors.join('\n'));
  assert.match(notice, / \(空のスレッド T1 が残ります\): \S/);
  assert.equal(h.logs.some((l) => l.includes('を opus で起動')), false);
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

test('自動復旧の判定が落ちても、同じ tick の着手と巡回は従来どおり起きる', async (t) => {
  const calls = [];
  const h = harness(t, {
    tasks: [{ title: 'lint' }],
    autonomy: { scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
    recovery: {
      sweep: async () => { calls.push('sweep'); },
      autoTick: async () => { calls.push('auto'); throw new Error('recovery.json unreadable'); },
    },
  });
  await h.autonomyTick(T0);

  assert.deepEqual(calls, ['sweep', 'auto'], '自動復旧の判定まで回っていない');
  assert.ok(h.errors.includes('[recovery] 自動復旧の判定に失敗 (tick は続けます): recovery.json unreadable'), h.errors.join('\n'));
  assert.deepEqual(h.threads.map((th) => th.name), ['task/1 lint', scoutThreadName(T0)], '自動復旧の失敗で着手か巡回が止まっている');
  assert.equal(h.board.get('1').state, 'in-progress');
  assert.equal(h.hops.taskBudget('T1'), 20);
  assert.equal(h.hops.taskBudget('T2'), SCOUT_JOB_BUDGET);
  assert.equal(h.tickStates.get('kt').lastScoutAt, T0);
});

/**
 * 同じ tick で planTick が返した行動のうち、kind が `from` のものを `to` に書き換える。
 * 判断の層 (src/scheduler.js の planTick) は 4 種類しか返さないので、知らない kind は判断と配線の
 * 版がずれたときにしか起きない。配線は planTick を import で直接持っていて差し替える口が無く、
 * node:test の module mock は CI の Node 20 で使えないので、**planTick の同期実行の間だけ**
 * `Array.prototype.push` を差し替える — 配線は勘定を `tickStates.get` で読んだ直後に planTick を呼び、
 * 戻りを `saveTickState` (先頭で `tickStates.set`) で落とすので、その 2 点で挟む。
 * 順序が変わって書き換えが効かなくなったら、知らない行動のログが出ずに試験が落ちる (黙って通らない)
 */
function renameActionsDuringPlan(t, h, from, to) {
  const { push } = Array.prototype;
  const rename = function (...items) {
    return push.apply(this, items.map((item) => (item?.kind === from ? { ...item, kind: to } : item)));
  };
  const restore = () => { Array.prototype.push = push; };
  const { get, set } = h.tickStates;
  h.tickStates.get = (name) => {
    Array.prototype.push = rename;
    return get.call(h.tickStates, name);
  };
  h.tickStates.set = (name, state) => {
    restore();
    return set.call(h.tickStates, name, state);
  };
  t.after(restore);
  return () => {
    restore();
    delete h.tickStates.get;
    delete h.tickStates.set;
  };
}

test('知らない kind の行動では起動もボードの変更もせず、後ろの行動は続ける', async (t) => {
  const h = harness(t, { tasks: [{ title: 'lint' }], autonomy: { scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } } });
  const stop = renameActionsDuringPlan(t, h, 'start-task', 'merge-task');
  await h.autonomyTick(T0);
  stop();

  assert.ok(h.logs.includes('[scheduler] kt: 知らない行動 merge-task — 何もしません'), h.logs.join('\n'));
  assert.equal(h.board.get('1').state, 'approved', '知らない行動でボードを動かしている');
  assert.equal(h.board.get('1').threadId ?? null, null);
  assert.equal(h.logs.some((l) => l.startsWith('[scheduler] kt: タスク 1 を opus で起動')), false, '知らない行動で着手している');
  // 後ろの巡回は止まらない (スレッドは巡回の 1 本だけ)
  assert.deepEqual(h.threads.map((th) => th.name), [scoutThreadName(T0)]);
  assert.equal(h.hops.taskBudget('T1'), SCOUT_JOB_BUDGET);
  assert.equal(h.hops.budgets.size, 1, '知らない行動に予算を配っている');

  // 判断と配線がそろえば、残っていた approved を次の tick で起こす
  await h.autonomyTick(T0 + AUTONOMY_TICK_MS);
  assert.equal(h.board.get('1').state, 'in-progress');
  assert.equal(h.board.get('1').threadId, 'T2');
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

test('scout: 見送り・チャンネルが取れない・スレッド作成の失敗では予算も種別の上書きも動かさない', async (t) => {
  const cases = [
    ['resolve', '[scheduler] kt: 巡回を見送り — スカウト担当が起動していません (scout.bot: opus)'],
    ['channel', CHANNEL_MISSING],
    ['create', '[scheduler] kt: 巡回スレッドの作成に失敗: Missing Access'],
  ];
  for (const [fault, error] of cases) {
    const h = harness(t, { autonomy: { scout: { bot: 'opus', intervalMin: 60 } } });
    EARLY_FAULTS[fault](h, 'opus', true);
    await h.autonomyTick(T0);

    assert.equal(h.threads.length, 0, fault);
    assert.equal(h.hops.budgets.size, 0, `${fault}: 起動していないのに予算を配っている`);
    // T1 = 偽の Discord が最初に払い出すスレッドの ID
    assert.equal(h.claimContractKindOverride('T1', 'opus'), null, `${fault}: 種別を被せている`);
    assert.deepEqual(h.board.list(), [], `${fault}: ボードを触っている`);
    assert.ok(h.errors.includes(error), `${fault}: ${h.errors.join('\n')}`);
    assert.equal(h.logs.some((l) => l.startsWith('[scheduler] kt: 巡回を opus で起動')), false, fault);
  }
});

/** 終わった job の実行記録 (ハーネスの成績の材料)。分刻みで並べる */
function endedRuns(count, { botKey = 'opus', rev = null, outcome = 'ok', from = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(T0 - (10_000 - from - i) * 60_000).toISOString();
    return {
      id: `${botKey}-${rev ?? 'base'}-${from + i}`, botKey, channelName: 'kt', taskId: null, threadId: 'X',
      stage: 'ended', outcome, reason: outcome, stopKind: null, next: 'human',
      acceptedAt: at, startedAt: at, endedAt: at, stageDetail: '',
      harness: rev ? { rev, role: 'worker', files: [], runtime: 'claude', model: 'opus', effort: null } : null,
    };
  });
}

test('harness: 計測済みなら提案役のスレッドを立て、成績と直してよい役割文を渡し、task-proposal を被せる', async (t) => {
  const h = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 } },
    runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
  });
  h.config.bots = { opus: { rolePromptFile: 'roles/worker.md' }, fable: { rolePromptFile: 'roles/manager.md' } };
  await h.autonomyTick(T0);
  assert.equal(h.threads.length, 1);
  const [thread] = h.threads;
  assert.equal(thread.name, harnessThreadName(T0));
  assert.equal(h.hops.taskBudget('T1'), SCOUT_JOB_BUDGET);
  assert.equal(h.claimContractKindOverride('T1', 'fable'), 'task-proposal');
  const text = thread.sent[0].content;
  assert.ok(text.startsWith('<@F>\n'), text);
  assert.match(text, /## ハーネスの改訂 \(巡回\)/);
  assert.match(text, /- opus \(worker\): 今 `aaaaaaaaaaaa` 25 本・問題 0% ← 前 記録前 25 本・0% → 同等/);
  assert.match(text, /直してよいのは `roles\/_common\.md` \/ `roles\/worker\.md` だけ/);
  assert.doesNotMatch(text, /roles\/manager\.md/, '提案役自身の役割文を改訂の対象に入れている');
  // 企画の巡回が無いチャンネルでは申し送りが届かないので、model / effort の変更は従来どおり作者へ
  assert.match(text, /model \/ effort の変更は起票せず `\[\[notify:owner\]\]` で上げる/);
  assert.equal(h.tickStates.get('kt').lastHarnessAt, T0);
  assert.ok(h.logs.some((l) => l === '[scheduler] kt: ハーネスの改訂を fable で起動 (thread T1 / 計測済み / 投稿は opus)'), h.logs.join('\n'));

  // 間隔 (既定 1 日) が明けるまで次は起きない
  await h.autonomyTick(T0 + 60 * 60 * 1000);
  assert.equal(h.threads.length, 1);
});

test('harness: 前の改訂 (役割文を触った merge 済みのタスク) があれば、その merge で始まった版を台帳として起動文に載せる', async (t) => {
  const withFiles = (runs) => runs.map((r) => ({ ...r, harness: { ...r.harness, files: ['roles/_common.md', 'roles/worker.md'] } }));
  const h = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 } },
    tasks: [{ title: 'worker.md に 1 項', rationale: '差し戻しの再発を減らす', touch: ['roles/worker.md'] }],
    runs: withFiles([...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 }), ...endedRuns(25, { rev: 'bbbbbbbbbbbb', from: 200 })]),
  });
  h.config.bots = { opus: { rolePromptFile: 'roles/worker.md' }, fable: { rolePromptFile: 'roles/manager.md' } };
  // 版 aaaa の最後の job (T0 - 9876 分) と版 bbbb の最初の job (T0 - 9800 分) の間に merge
  const mergedAt = T0 - 9850 * 60_000;
  h.board.start('1', { threadId: 'W1', by: 'scheduler', now: mergedAt - 120_000 });
  h.board.submitForReview('1', { by: 'opus', now: mergedAt - 60_000 });
  h.board.complete('1', { by: 'opus2', now: mergedAt });
  await h.autonomyTick(T0);
  assert.equal(h.threads.length, 1);
  const text = h.threads[0].sent[0].content;
  assert.match(text, /### 前の改訂 \(台帳\)\n- #1 \S+ \S+ merge \(roles\/worker\.md\): worker\.md に 1 項 — 狙い: 差し戻しの再発を減らす\n/);
  assert.match(text, /- opus: `aaaaaaaaaaaa` 25 本・0% → `bbbbbbbbbbbb` 25 本・問題 0 \(0%\) \[今の版: 同等 \(z 0\.00\)\]/);
  assert.match(text, /前の改訂の狙いが当たったか/);
});

test('harness: 今の版を測り終えていない間と、役割文を触るタスクが残っている間は起こさない', async (t) => {
  const measuring = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 } },
    runs: [...endedRuns(25), ...endedRuns(5, { rev: 'aaaaaaaaaaaa', from: 100 })],
  });
  await measuring.autonomyTick(T0);
  assert.equal(measuring.threads.length, 0, '計測中の版に改訂を重ねている');
  assert.equal(measuring.tickStates.get('kt').lastHarnessAt, 0);

  const revising = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 }, maxConcurrentTasks: 1 },
    tasks: [{ title: '役割文を直す', touch: ['roles/worker.md'], state: 'proposed' }],
    runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
  });
  await revising.autonomyTick(T0);
  assert.equal(revising.threads.length, 0, '改訂が終わる前に次の改訂を起こしている');

  // 記録前だけ (再起動の直後) は起こさない — 再起動後の最初の版が 20 本に届くのを待つ
  const fresh = harness(t, { autonomy: { harness: { bot: 'fable', minRuns: 20 } }, runs: endedRuns(73) });
  await fresh.autonomyTick(T0);
  assert.equal(fresh.threads.length, 0, '記録前だけで改訂を起こしている');

  // 提案役の bot が設定されていなければ成績も読まない
  const off = harness(t, { runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })] });
  await off.autonomyTick(T0);
  assert.equal(off.threads.length, 0);
});

test('harness: 起動に失敗したら種別の上書きを取り消す', async (t) => {
  const h = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 } },
    runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
    sendFail: true,
  });
  await h.autonomyTick(T0);
  assert.equal(h.claimContractKindOverride('T1', 'fable'), null);
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: ハーネスの改訂の起動に失敗: archived'), h.errors.join('\n'));
});

test('harness: 見送り・チャンネルが取れない・スレッド作成の失敗では予算も種別の上書きも動かさない', async (t) => {
  const cases = [
    ['resolve', '[scheduler] kt: ハーネスの改訂を見送り — 提案役が起動していません (harness.bot: fable)'],
    ['channel', CHANNEL_MISSING],
    ['create', '[scheduler] kt: ハーネスの改訂のスレッドの作成に失敗: Missing Access'],
  ];
  for (const [fault, error] of cases) {
    const h = harness(t, {
      autonomy: { harness: { bot: 'fable', minRuns: 20 } },
      runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
    });
    EARLY_FAULTS[fault](h, 'fable', true);
    await h.autonomyTick(T0);

    assert.equal(h.threads.length, 0, fault);
    assert.equal(h.hops.budgets.size, 0, `${fault}: 起動していないのに予算を配っている`);
    assert.equal(h.claimContractKindOverride('T1', 'fable'), null, `${fault}: 種別を被せている`);
    assert.deepEqual(h.board.list(), [], `${fault}: ボードを触っている`);
    assert.ok(h.errors.includes(error), `${fault}: ${h.errors.join('\n')}`);
    assert.equal(h.logs.some((l) => l.startsWith('[scheduler] kt: ハーネスの改訂を fable で起動')), false, fault);
  }
});

test('harness: 成績を出せないときは改訂の巡回を起こさず、同じ tick の着手は止めない', async (t) => {
  const h = harness(t, {
    autonomy: { harness: { bot: 'fable', minRuns: 20 } },
    tasks: [{ title: 'lint' }],
    runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
  });
  // 台帳としては読めている (broken ではない) のに、成績の集計で落ちる
  h.stores.jobRuns.list = () => { throw new Error('記録の形が崩れている'); };
  await h.autonomyTick(T0);

  assert.ok(
    h.errors.includes('[scheduler] ハーネスの成績を出せません (改訂の巡回は見送り): 記録の形が崩れている'),
    h.errors.join('\n'),
  );
  assert.equal(h.tickStates.get('kt').lastHarnessAt, 0, '起こしていない改訂で時計が進んでいる');
  assert.equal(h.claimContractKindOverride('T1', 'fable'), null);
  assert.deepEqual(h.threads.map((th) => th.name), ['task/1 lint'], '成績が出ないことで着手まで止めている');
  assert.equal(h.board.get('1').state, 'in-progress');

  // tick は成績が無ければ改訂を選ばない。選ばれた後で成績が無い場合も起こさない (直接呼ぶ)
  const direct = harness(t, { autonomy: { harness: { bot: 'fable', minRuns: 20 } } });
  await direct.startHarness({
    channelName: 'kt',
    autonomy: resolveAutonomy(channelConfigForName(direct.config, 'kt')),
    action: { kind: 'harness' },
    now: T0,
    measured: null,
  });
  assert.equal(direct.threads.length, 0);
  assert.equal(direct.hops.budgets.size, 0);
  assert.ok(direct.errors.includes('[scheduler] kt: ハーネスの改訂を見送り — 成績が出ていません'), direct.errors.join('\n'));
});

// ---- 企画の巡回 (src/themes.js) ----

const PLANNER = Object.freeze({ bot: 'fable', themesFile: 'docs/themes.md', maxThemes: 2 });
const ONE_THEME = [
  '# 主題',
  '<!-- ## [active] sample — 見本 -->',
  '## [active] pi-worker — Sol を worker にする',
  '## [done] owner-view — 見るべきものを束ねる',
].join('\n');

test('plan: 主題ファイルがまだ無ければ企画役のスレッドを立て、考える手順を渡し、task-proposal を被せる', async (t) => {
  const h = harness(t, { autonomy: { planner: PLANNER }, themes: null });
  await h.autonomyTick(T0);
  assert.equal(h.threads.length, 1);
  const [thread] = h.threads;
  assert.equal(thread.name, planThreadName(T0));
  assert.equal(h.hops.taskBudget('T1'), SCOUT_JOB_BUDGET);
  assert.equal(h.claimContractKindOverride('T1', 'fable'), 'task-proposal');
  const text = thread.sent[0].content;
  assert.ok(text.startsWith('<@F>\n'), text);
  assert.match(text, /## 企画の巡回 — 自律ループの次の主題/);
  assert.match(text, /### 主題 \(`docs\/themes\.md` \/ 主題のファイルがまだ無い\)\n- \(まだ無い — 最初の主題を考える\)/);
  assert.match(text, /`docs\/direction\.md` \(範囲と柵の正本\)/);
  assert.match(text, /候補を 3 つ以上/);
  assert.equal(h.tickStates.get('kt').lastPlanAt, T0);
  assert.ok(h.logs.some((l) => l === '[scheduler] kt: 企画の巡回を fable で起動 (thread T1 / 主題のファイルがまだ無い / 投稿は opus)'), h.logs.join('\n'));

  // 間隔 (既定 1 日) が明けるまで次は起きない
  await h.autonomyTick(T0 + 60 * 60 * 1000);
  assert.equal(h.threads.length, 1);
});

/** 主題のタスク (id 1) の実行記録: 承認 (verify なし) とレビュー、主題外のスカウト job */
function themeRuns() {
  const at = (min) => new Date(T0 - (120 - min) * 60_000).toISOString();
  const run = (id, taskId, kind, from, to, evidence) => ({
    id, botKey: 'opus', channelName: 'kt', taskId, threadId: 'X', stage: 'ended', outcome: 'ok', reason: 'ok',
    stopKind: null, next: null, acceptedAt: at(from), startedAt: at(from), endedAt: at(to), stageDetail: '',
    contract: kind ? { kind } : null, evidence,
  });
  return [
    run('approval', '1', 'task-approval', 0, 1.5, {
      toolCalls: 4, verifyMs: null, tokens: { input: 1000, cacheRead: 9000, cacheWrite: 0, output: 500 },
    }),
    run('review', '1', 'task-review', 10, 13, {
      toolCalls: 9, verifyMs: 45_000, tokens: { input: 2000, cacheRead: 30_000, cacheWrite: 1000, output: 1500 },
    }),
    run('scout', null, null, 20, 50, {
      toolCalls: 100, verifyMs: 600_000, tokens: { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 },
    }),
  ];
}

test('plan: 進行中の主題と進み具合 (と重さ) を企画役へ渡し、スカウトには主題を重さ付きで優先させる', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER, scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
    tasks: [{ title: '[pi-worker] resume を入れる', state: 'proposed' }],
    themes: ONE_THEME,
    runs: themeRuns(),
  });
  await h.autonomyTick(T0);
  assert.deepEqual(h.threads.map((th) => th.name), [scoutThreadName(T0), planThreadName(T0)]);
  const [scout, plan] = h.threads;
  // 主題外 (スカウト) の job は数えない。承認もレビューも数え、verify の無い承認の分は (1/2 本)
  const weight = '・job 2 本 (tool 計 13・分 計 4.5・verify 分 計 0.8 (1/2 本)・トークン 計 45k)';
  assert.ok(
    scout.sent[0].content.includes(`進行中の主題 (\`docs/themes.md\`) の次の 1 歩を優先する:** \`pi-worker\` Sol を worker にする${weight}\n`),
    scout.sent[0].content,
  );
  assert.doesNotMatch(scout.sent[0].content, /owner-view/, '完了した主題をスカウトに優先させている');
  const text = plan.sent[0].content;
  assert.match(text, /### 主題 \(`docs\/themes\.md` \/ 進行中の主題 1 \/ 上限 2\)/);
  assert.ok(
    text.includes(`\n- [active] pi-worker — Sol を worker にする (タスク merged 0 / 進行中 1 / 捨てた 0)${weight}\n`),
    text,
  );
  assert.match(text, /- これまで: 完了 1 \/ 取り下げ 0/);
  assert.doesNotMatch(text, /sample/, 'コメントの中の見本を主題に数えている');
  assert.deepEqual(h.errors, []);
});

test('plan / scout: 実行記録が無い・読めないときは重さを付けず、今の文面のまま起動する', async (t) => {
  for (const broken of [false, true]) {
    const h = harness(t, {
      autonomy: { planner: PLANNER, scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
      tasks: [{ title: '[pi-worker] resume を入れる', state: 'proposed' }],
      themes: ONE_THEME,
      runs: broken ? themeRuns() : null,
    });
    // 台帳としては読めている (broken ではない) のに、読み出しで落ちる
    if (broken) h.stores.jobRuns.list = () => { throw new Error('記録の形が崩れている'); };
    else assert.equal(h.stores.jobRuns, null);
    await h.autonomyTick(T0);
    assert.deepEqual(h.threads.map((th) => th.name), [scoutThreadName(T0), planThreadName(T0)], '重さが出ないことで巡回まで止めている');
    const [scout, plan] = h.threads;
    assert.ok(scout.sent[0].content.includes('の次の 1 歩を優先する:** `pi-worker` Sol を worker にする\n'), scout.sent[0].content);
    assert.ok(
      plan.sent[0].content.includes('\n- [active] pi-worker — Sol を worker にする (タスク merged 0 / 進行中 1 / 捨てた 0)\n'),
      plan.sent[0].content,
    );
    assert.doesNotMatch(`${scout.sent[0].content}\n${plan.sent[0].content}`, /job \d+ 本/);
    assert.deepEqual(
      h.errors,
      broken ? Array(2).fill('[scheduler] kt: 主題の重さを出せません (起動文は重さなしで続けます): 記録の形が崩れている') : [],
    );
  }
});

test('plan: 上限なら振り返りが先、読めない見出しは企画役へ知らせる', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER },
    themes: ['## [active] a — 1 つ目', '## [active] b — 2 つ目', '## [進行中] c — 形が崩れた'].join('\n'),
  });
  await h.autonomyTick(T0);
  const text = h.threads[0].sent[0].content;
  assert.match(text, /進行中の主題が上限 \(2 \/ 2\) — 振り返りが先/);
  assert.match(text, /2\. \*\*主題は上限\*\* — 振り返りで枠を空けない限り新しい主題は足さない/);
  assert.match(text, /- ⚠️ 読めない見出し: ## \[進行中\] c — 形が崩れた/);
  // 回し方の数字: スカウトを置いていなければ自律起動の数だけ (この巡回で 1 本使った後の値)
  assert.match(text, /### 回し方 \(ブリッジの勘定\)\n- 自律起動: 今日 1 \/ 40 job \(着手・巡回・自動復旧の数。レビュー・承認は数えない\)\n\n### 進め方/);
  assert.doesNotMatch(text, /- スカウト: /);
});

test('plan / scout: 配備待ち (waiting) の主題は枠に数えず、企画役には進み具合つきで見せ、スカウトには割らせない', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER, scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
    tasks: [{ title: '[job-cost] 重さを残す', state: 'proposed' }],
    themes: ['## [active] a — 1 つ目', '## [waiting] job-cost — 配備待ち', '## [waiting] b — 2 つ目'].join('\n'),
  });
  await h.autonomyTick(T0);
  const [scout, plan] = h.threads;
  assert.match(scout.sent[0].content, /次の 1 歩を優先する:\*\* `a` 1 つ目\n/);
  assert.doesNotMatch(scout.sent[0].content, /job-cost`|`b`/, '配備待ちの主題をスカウトに割らせている');
  const text = plan.sent[0].content;
  assert.match(text, /### 主題 \(`docs\/themes\.md` \/ 進行中の主題 1 \/ 上限 2 \(配備待ち 2 は数えない\)\)/);
  assert.match(text, /2\. \*\*候補を 3 つ以上\*\*/, '配備待ちを枠に数えている');
  assert.match(text, /\n- \[active\] a — 1 つ目 \(タスク merged 0 \/ 進行中 0 \/ 捨てた 0\)\n- \[waiting\] job-cost — 配備待ち \(タスク merged 0 \/ 進行中 1 \/ 捨てた 0\)\n- \[waiting\] b — 2 つ目/);
  assert.match(text, /- スカウト: 続けて提案 0 件 0 回 — 間隔 60 分 \(設定 60 分。0 件が続くと伸び、merge で戻る\)/);
});

test('noteScoutReport: 自分が起こした巡回の最初の報告だけを数え、0 件が続くとスカウトの間隔を伸ばして企画の巡回を前倒しする', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER, scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
    themes: ONE_THEME,
  });
  const HOUR = 60 * 60_000;
  await h.autonomyTick(T0);
  assert.deepEqual(h.threads.map((th) => th.name), [scoutThreadName(T0), planThreadName(T0)]);

  // 巡回でないスレッド (企画の T2)・別の担当・知らないスレッドの報告は数えない
  assert.equal(h.noteScoutReport({ threadId: 'T2', botKey: 'fable', proposed: 0 }), false);
  assert.equal(h.noteScoutReport({ threadId: 'T1', botKey: 'fable', proposed: 0 }), false);
  assert.equal(h.noteScoutReport({ threadId: 'T9', botKey: 'opus', proposed: 0 }), false);
  assert.equal(h.tickStates.get('kt').scoutIdle, 0);

  // 最初の報告だけ数える (同じスレッドで人が呼び直した 2 回目は巡回の結果ではない)
  assert.equal(h.noteScoutReport({ threadId: 'T1', botKey: 'opus', proposed: 0 }), true);
  assert.equal(h.noteScoutReport({ threadId: 'T1', botKey: 'opus', proposed: 0 }), false);
  assert.equal(h.tickStates.get('kt').scoutIdle, 1);
  assert.equal(h.tickStateStore.get('kt').scoutIdle, 1, '続けての 0 件を台帳へ落としていない');
  assert.ok(
    h.logs.includes('[scheduler] kt: 巡回の提案 0 件 (続けて 1 回) — 次の巡回は 120 分後 (merge があれば 60 分に戻す) / 前の企画の巡回の後 1 回'),
    h.logs.join('\n'),
  );

  // 1 回の 0 件で間隔は 120 分 — 60 分では起こさない
  await h.autonomyTick(T0 + HOUR);
  assert.equal(h.threads.length, 2, '0 件の後も 60 分で巡回している');
  await h.autonomyTick(T0 + 2 * HOUR);
  assert.equal(h.threads.length, 3);
  assert.equal(h.threads[2].name, scoutThreadName(T0 + 2 * HOUR));

  // 2 回続いたら、企画の巡回を間隔 (1 日) を待たずに起こす。起動文に前倒しの理由と回し方の数字が載る
  assert.equal(h.noteScoutReport({ threadId: 'T3', botKey: 'opus', proposed: 0 }), true);
  await h.autonomyTick(T0 + 2 * HOUR + 60_000);
  assert.equal(h.threads.length, 4);
  const plan = h.threads[3].sent[0].content;
  assert.match(plan, /### 主題 \(`docs\/themes\.md` \/ 進行中の主題 1 \/ 上限 2 \/ 前倒し \(前の企画の巡回の後、スカウトの提案 0 件が続けて 2 回\)\)/);
  assert.match(plan, /- スカウト: 続けて提案 0 件 2 回 — 間隔 240 分 \(設定 60 分。/);
  assert.ok(
    h.logs.some((l) => l.startsWith('[scheduler] kt: 企画の巡回を fable で起動 (thread T4 / 進行中の主題 1 / 上限 2 / 前倒し (')),
    h.logs.join('\n'),
  );
  assert.equal(h.tickStates.get('kt').scoutIdleSincePlan, 0, '前倒しの後に数え直していない');

  // 提案が 1 件でもあれば元の間隔へ戻す (ボードが断ったかは見ない)
  await h.autonomyTick(T0 + 6 * HOUR);
  assert.equal(h.threads[4].name, scoutThreadName(T0 + 6 * HOUR));
  assert.equal(h.noteScoutReport({ threadId: 'T5', botKey: 'opus', proposed: 2 }), true);
  assert.equal(h.tickStates.get('kt').scoutIdle, 0);
  await h.autonomyTick(T0 + 7 * HOUR);
  assert.equal(h.threads[5]?.name, scoutThreadName(T0 + 7 * HOUR));
});

test('scout: 前回の巡回の報告を起動メッセージより前に出し (巡回でないスレッドの報告は無視)、出せなくても巡回は起動する', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER, scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } },
    themes: ONE_THEME,
  });
  const HOUR = 60 * 60_000;
  await h.autonomyTick(T0);
  assert.deepEqual(h.threads.map((th) => th.name), [scoutThreadName(T0), planThreadName(T0)]);
  // 前回が無ければ今の投稿のまま (起動メッセージ 1 通だけ — 再起動後の最初の巡回もこれ)
  assert.equal(h.threads[0].sent.length, 1);
  assert.ok(h.threads[0].sent[0].content.startsWith('<@O>\n'), h.threads[0].sent[0].content);

  assert.equal(
    h.noteScoutReport({
      threadId: 'T1', botKey: 'opus', proposed: 2, now: T0 + 12 * 60_000,
      body: '起票 2 件。\n次の巡回への申し送り: <@123456789012> の件は配備待ち\n\n[[handoff:fable]]',
    }),
    true,
  );
  // 後から来た 企画のスレッド (T2)・巡回のスレッドの担当でない bot・知らないスレッドの task-proposal は
  // 記録しない (巡回の報告を上書きしない)
  assert.equal(h.noteScoutReport({ threadId: 'T2', botKey: 'fable', proposed: 1, body: '企画の本文' }), false);
  assert.equal(h.noteScoutReport({ threadId: 'T1', botKey: 'fable', proposed: 1, body: '担当でない本文' }), false);
  assert.equal(h.noteScoutReport({ threadId: 'T9', botKey: 'opus', proposed: 1, body: '知らない本文' }), false);

  await h.autonomyTick(T0 + HOUR);
  const second = h.threads[2];
  assert.equal(second.name, scoutThreadName(T0 + HOUR));
  assert.equal(second.sent.length, 2);
  // 前に置く = 巡回の最初の job の文脈 (遡り分) に入る。メンションは起動メッセージの 1 通だけ
  assert.equal(
    second.sent[0].content,
    '### 前回の巡回 (09-06 10:12 JST) の報告 — 提案 2 件\n参考。判断は今回の巡回で\n\n'
      + '起票 2 件。\n次の巡回への申し送り: [mention:123456789012] の件は配備待ち',
  );
  assert.deepEqual(second.sent[0].allowedMentions.users, []);
  assert.ok(second.sent[1].content.startsWith('<@O>\n'), '起動メッセージが報告の後に来ていない');
  assert.deepEqual(second.sent[1].allowedMentions.users, ['O']);
  assert.ok(
    h.logs.includes(`[scheduler] kt: 巡回を opus で起動 (thread T3 / 予算 ${SCOUT_JOB_BUDGET} job / 前回の報告つき / 投稿は fable)`),
    h.logs.join('\n'),
  );

  // 報告を出せなくても巡回は起動し (ログは 1 行)、起動した巡回の報告は今までどおり数える
  h.knobs.sendFailIf = (payload) => payload.content.startsWith('### 前回の巡回');
  await h.autonomyTick(T0 + 2 * HOUR);
  const third = h.threads[3];
  assert.equal(third.name, scoutThreadName(T0 + 2 * HOUR));
  assert.equal(third.sent.length, 1);
  assert.ok(third.sent[0].content.startsWith('<@O>\n'), '報告を出せないと巡回が止まる');
  assert.deepEqual(
    h.errors.filter((e) => e.includes('前回の巡回の報告')),
    ['[scheduler] kt: 前回の巡回の報告を出せません (巡回は続けます): archived'],
  );
  assert.equal(h.noteScoutReport({ threadId: 'T4', botKey: 'opus', proposed: 1, body: 'x' }), true);
});

test('noteCarry → plan: 申し送りを溜め、次の企画の巡回の起動文の前に出してさばかせ、渡したら消す', async (t) => {
  const h = harness(t, {
    autonomy: { planner: PLANNER, harness: { bot: 'fable', minRuns: 20 } },
    themes: ONE_THEME,
    runs: [...endedRuns(25), ...endedRuns(25, { rev: 'aaaaaaaaaaaa', from: 100 })],
  });
  h.config.bots = { opus: { rolePromptFile: 'roles/worker.md' }, fable: { rolePromptFile: 'roles/manager.md' } };
  // 申し送りが無い・空・自律運転の外のチャンネルなら何もしない
  assert.equal(h.noteCarry({ channelName: 'kt', botKey: 'opus', items: [] }), '');
  assert.equal(h.noteCarry({ channelName: 'kt', botKey: 'opus' }), '');
  assert.equal(h.noteCarry({ channelName: 'kt', botKey: 'opus', items: ['  '] }), '');
  assert.equal(h.noteCarry({ channelName: 'other', botKey: 'opus', items: ['x'] }), '');
  assert.equal(
    h.noteCarry({ channelName: 'kt', botKey: 'opus', items: ['日次上限 40 に 19:58 で達して 4 時間止まった', '#89 は /retry 待ち'], now: T0 - 60_000 }),
    '📮 次の企画の巡回へ申し送り 2 件 (溜まっている 2 件)',
  );
  assert.equal(h.tickStateStore.get('kt').carry.length, 2, '申し送りを台帳へ落としていない');

  await h.autonomyTick(T0);
  const names = h.threads.map((th) => th.name);
  const harnessThread = h.threads[names.indexOf(harnessThreadName(T0))];
  const plan = h.threads[names.indexOf(planThreadName(T0))];
  // ハーネスの改訂も、企画の巡回があれば model / effort の変更を申し送りに書かせる
  assert.match(harnessThread.sent[0].content, /model \/ effort の変更は起票せず `carry` \(申し送り\) に書く/);
  // 申し送り → 起動文 の順。起動文は申し送りをさばかせる
  assert.equal(plan.sent.length, 2);
  assert.match(plan.sent[0].content, /^### 申し送り \(前の企画の巡回の後 2 件\)\n/);
  assert.match(plan.sent[0].content, /\n- \d\d-\d\d \d\d:\d\d opus: 日次上限 40 に 19:58 で達して 4 時間止まった\n- \d\d-\d\d \d\d:\d\d opus: #89 は \/retry 待ち$/);
  assert.ok(plan.sent[1].content.startsWith('<@F>\n'));
  assert.match(plan.sent[1].content, /\*\*申し送り\*\* \(この上の投稿、2 件\) を 1 件ずつさばき/);
  // 渡したら消す (台帳からも)
  assert.deepEqual(h.tickStates.get('kt').carry, []);
  assert.deepEqual(h.tickStateStore.get('kt').carry, []);
  assert.ok(h.logs.some((l) => l.includes('企画の巡回を fable で起動') && l.includes('/ 申し送り 2 件 /')), h.logs.join('\n'));
});

test('plan: 申し送りを出せなかった・起動文を出せなかったときは消さずに次の企画の巡回へ回す', async (t) => {
  // 申し送りの投稿だけ落ちる → 巡回は起動し (さばかせない)、申し送りは残る
  const noteFail = harness(t, { autonomy: { planner: PLANNER }, themes: ONE_THEME });
  noteFail.noteCarry({ channelName: 'kt', botKey: 'opus', items: ['a'], now: T0 - 60_000 });
  noteFail.knobs.sendFailIf = (payload) => String(payload?.content ?? payload).startsWith('### 申し送り');
  await noteFail.autonomyTick(T0);
  assert.equal(noteFail.threads.length, 1);
  assert.equal(noteFail.threads[0].sent.length, 1);
  assert.doesNotMatch(noteFail.threads[0].sent[0].content, /\*\*申し送り\*\*/, '出せなかった申し送りをさばかせている');
  assert.equal(noteFail.tickStates.get('kt').carry.length, 1, '出せなかった申し送りを消している');
  assert.ok(noteFail.errors.some((e) => e.startsWith('[scheduler] kt: 申し送りを出せません (巡回は続け、申し送りは次へ回します): ')), noteFail.errors.join('\n'));

  // 起動文が落ちる → 誰も読まないスレッドに出ただけなので消さない
  const startFail = harness(t, { autonomy: { planner: PLANNER }, themes: ONE_THEME });
  startFail.noteCarry({ channelName: 'kt', botKey: 'opus', items: ['a'], now: T0 - 60_000 });
  startFail.knobs.sendFailIf = (payload) => String(payload?.content ?? payload).startsWith('<@F>');
  await startFail.autonomyTick(T0);
  assert.equal(startFail.tickStates.get('kt').carry.length, 1, '起動できなかった巡回の申し送りを消している');
});

test('noteCarry: 企画の巡回を置いていないチャンネルでは溜めず、届かないことを言う', async (t) => {
  const h = harness(t, { autonomy: { scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 } } });
  assert.equal(
    h.noteCarry({ channelName: 'kt', botKey: 'opus', items: ['x'] }),
    '⚠️ 申し送りを受け取りましたが、このチャンネルには企画の巡回が無いので届きません (必要なら本文で作者に)',
  );
  assert.deepEqual(h.tickStates.get('kt').carry, []);
});

test('plan: 主題ファイルを触るタスクが終わっていない間と、企画役が設定されていないときは起こさない', async (t) => {
  const planning = harness(t, {
    autonomy: { planner: PLANNER, maxConcurrentTasks: 1 },
    tasks: [{ title: '主題を足す', touch: ['docs/themes.md'], state: 'proposed' }],
    themes: ONE_THEME,
  });
  await planning.autonomyTick(T0);
  assert.equal(planning.threads.length, 0, '承認待ちの主題に重ねて考えさせている');
  assert.equal(planning.tickStates.get('kt').lastPlanAt, 0);

  const off = harness(t, { themes: ONE_THEME });
  await off.autonomyTick(T0);
  assert.equal(off.threads.length, 0);
});

test('plan: 主題ファイルを読めなければ企画の巡回を起こさず、同じ tick の着手は止めない', async (t) => {
  const h = harness(t, { autonomy: { planner: PLANNER }, tasks: [{ title: 'lint' }], themes: { dir: true } });
  await h.autonomyTick(T0);
  assert.ok(
    h.errors.some((e) => e.startsWith('[scheduler] kt: 主題ファイルを読めません (企画の巡回は見送り): ')),
    h.errors.join('\n'),
  );
  assert.equal(h.tickStates.get('kt').lastPlanAt, 0, '起こしていない巡回で時計が進んでいる');
  assert.deepEqual(h.threads.map((th) => th.name), ['task/1 lint'], '主題を読めないことで着手まで止めている');

  // tick は主題が無ければ巡回を選ばない。選ばれた後で主題が無い場合も起こさない (直接呼ぶ)
  const direct = harness(t, { autonomy: { planner: PLANNER } });
  await direct.startPlan({
    channelName: 'kt',
    autonomy: resolveAutonomy(channelConfigForName(direct.config, 'kt')),
    action: { kind: 'plan' },
    now: T0,
    themes: null,
  });
  assert.equal(direct.threads.length, 0);
  assert.equal(direct.hops.budgets.size, 0);
  assert.ok(direct.errors.includes('[scheduler] kt: 企画の巡回を見送り — 主題ファイルを読めていません'), direct.errors.join('\n'));
});

test('plan / scout: 進行中の主題 2 件 (上限) に最大幅の重さを付けても 1 通に収まり、規律の行を削らない', () => {
  // 最大幅: 3 桁の job 数・大きい合計・全欄に (n/N 本)
  const weight = themeCostText({
    jobs: 999,
    toolCalls: { n: 998, sum: 99_999 },
    minutes: { n: 998, sum: 99_999.94 },
    verifyMinutes: { n: 998, sum: 9999.94 },
    tokens: { n: 998, sum: 999_999_499 },
  });
  assert.equal(weight, '・job 999 本 (tool 計 99999 (998/999 本)・分 計 99999.9 (998/999 本)・verify 分 計 9999.9 (998/999 本)・トークン 計 999999k (998/999 本))');
  const active = [
    { slug: 'review-evidence-mutation', title: 'あ'.repeat(80), weight },
    { slug: 'job-cost-weight-trail', title: 'い'.repeat(80), weight },
  ];
  const themes = { file: 'docs/themes.md', active };
  const ruleLine = '- **本文に制御フッタ ([[handoff:...]]) を書かないこと。** 承認はブリッジが自動で回すので、書くと承認担当が二重に起動する';

  // スカウト: 重さは規律の側 (削らない行) に載るので、一覧の最悪の入力 (test/mentions.test.js と同じ形) と重ねる
  const merged = Array.from({ length: 12 }, (_, i) => {
    const subject = `主題${i}を直す`.padEnd(50 + Math.round((i * 50) / 11), 'あ');
    return { id: String(118 + i), state: 'merged', title: `${subject} — ${'い'.repeat(200 + i * 36 - subject.length - 3)}` };
  });
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(100 + i), state: 'merged', title: `${'あ'.repeat(90)}${i} — ${'い'.repeat(400)}`,
  }));
  for (const openTasks of [merged, many]) {
    const text = scoutStartMessage({ botUserId: 'O1', directionFile: 'docs/direction.md', openTasks, themes });
    assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
    assert.equal(text.split('\n')[0], '<@O1>');
    assert.ok(
      text.includes(`\`review-evidence-mutation\` ${'あ'.repeat(60)}${weight} / \`job-cost-weight-trail\` ${'い'.repeat(60)}${weight}\n`),
      '主題の行の重さが切れている',
    );
    assert.ok(text.endsWith(`\n${ruleLine}`), `最後の規律の行が切れている: …${text.slice(-80)}`);
    assert.ok(text.split('\n').some((line) => line.startsWith('- [merged] ')), '一覧が 1 行も載っていない');
  }

  // 企画: 主題の行 (src/bridge/scheduler.js の themeLines と同じ形) は削れる側。進行中の 2 件 (重さ込み) は全部載る。
  // 固定部に余裕は無い (#173 で loop-report の 2 か所を足して 31 字を越えた) ので、完了の数・読めない見出しは末尾から
  // 削られうる — そのときは削った本数を `…ほか n 行` で残す
  const lines = [
    ...active.map((t) => `[active] ${t.slug} — ${t.title} (タスク merged 999 / 進行中 99 / 捨てた 99)${t.weight}`),
    'これまで: 完了 99 / 取り下げ 99 (結果はファイルに)',
    `⚠️ 読めない見出し: ${'う'.repeat(80)}`,
  ];
  const plan = planStartMessage({
    botUserId: 'F1', themesFile: 'docs/themes.md', directionFile: 'docs/direction.md', mode: 'add', reason: '進行中の主題 2 / 上限 2', themeLines: lines,
  });
  assert.ok(plan.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${plan.length} 字)`);
  for (const line of lines.slice(0, active.length)) {
    assert.ok(plan.includes(`\n- ${line}\n`), `進行中の主題の行が削られている: ${line.slice(0, 40)}`);
  }
  const kept = lines.filter((line) => plan.includes(`\n- ${line}\n`));
  assert.deepEqual(kept, lines.slice(0, kept.length), '主題の行を末尾以外から削っている');
  const rest = lines.length - kept.length;
  if (rest > 0) assert.ok(plan.includes(`\n- …ほか ${rest} 行\n`), `削った ${rest} 行が「…ほか ${rest} 行」で残っていない`);
  else assert.doesNotMatch(plan, /…ほか/);
  assert.ok(plan.endsWith('本文に制御フッタ ([[handoff:...]]) を書かない'), `最後の規律の行が切れている: …${plan.slice(-80)}`);
});

test('plan: 起動に失敗したら種別の上書きを取り消す', async (t) => {
  const h = harness(t, { autonomy: { planner: PLANNER }, themes: null, sendFail: true });
  await h.autonomyTick(T0);
  assert.equal(h.claimContractKindOverride('T1', 'fable'), null);
  assert.ok(h.errors.some((e) => e === '[scheduler] kt: 企画の巡回の起動に失敗: archived'), h.errors.join('\n'));
});

test('plan: 見送り・チャンネルが取れない・スレッド作成の失敗では予算も種別の上書きも動かさない', async (t) => {
  const cases = [
    ['resolve', '[scheduler] kt: 企画の巡回を見送り — 企画役が起動していません (planner.bot: fable)'],
    ['channel', CHANNEL_MISSING],
    ['create', '[scheduler] kt: 企画の巡回のスレッドの作成に失敗: Missing Access'],
  ];
  for (const [fault, error] of cases) {
    const h = harness(t, { autonomy: { planner: PLANNER }, themes: null });
    EARLY_FAULTS[fault](h, 'fable', true);
    await h.autonomyTick(T0);

    assert.equal(h.threads.length, 0, fault);
    assert.equal(h.hops.budgets.size, 0, `${fault}: 起動していないのに予算を配っている`);
    assert.equal(h.claimContractKindOverride('T1', 'fable'), null, `${fault}: 種別を被せている`);
    assert.deepEqual(h.board.list(), [], `${fault}: ボードを触っている`);
    assert.ok(h.errors.includes(error), `${fault}: ${h.errors.join('\n')}`);
    assert.equal(h.logs.some((l) => l.startsWith('[scheduler] kt: 企画の巡回を fable で起動')), false, fault);
  }
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

test('noteAutonomyOutcome: 上限が明ける時刻を failed(…) から読めれば、バックオフをそこまで伸ばす', (t) => {
  const h = harness(t);
  h.hops.grantTaskBudget('T9', 5);
  const item = { jobId: 'j1', threadId: 'T9', channelName: 'kt', botKey: 'opus' };
  // job.js と同じ組み立て (理由は 60 字で切られる)
  const failed = (error) => `failed(${error.slice(0, 60)})`;
  // 倍々の 5 分 (BACKOFF_BASE_MS) で起こしたか — 呼んだ前後の時計で挟む
  const assertDoubled = (reason, message) => {
    h.noteAutonomyOutcome(item, 'ok');
    const before = Date.now();
    h.noteAutonomyOutcome(item, reason);
    const until = h.tickStates.get('kt').backoffUntil;
    assert.ok(until >= before + BACKOFF_BASE_MS && until <= Date.now() + BACKOFF_BASE_MS, `${message}: ${until - before}ms`);
  };

  // その時刻の壁時計を Asia/Tokyo (夏時間の無い +9:00) で書く。秒は落ちる
  const limitError = (ms) => {
    const wall = new Date(ms + 9 * 60 * 60 * 1000);
    const hour = wall.getUTCHours();
    const clock = `${hour % 12 || 12}:${String(wall.getUTCMinutes()).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
    return `You've hit your session limit · resets ${clock} (Asia/Tokyo)`;
  };

  // 3 時間先に明ける。期待値は分の頭
  const target = Date.now() + 3 * 60 * 60 * 1000;
  const error = limitError(target);
  assert.ok(error.length <= 60, '実例の形が 60 字の切り詰めに収まっていない');
  h.noteAutonomyOutcome(item, failed(error));
  assert.equal(
    new Date(h.tickStates.get('kt').backoffUntil).toISOString(),
    new Date(Math.floor(target / 60_000) * 60_000).toISOString(),
  );
  assert.equal(h.tickStates.get('kt').backoffLevel, 1);
  assert.ok(h.errors.some((e) => e === `[scheduler] kt: 自律 job が失敗 (${failed(error)}) — 自律起動をバックオフします`), h.errors.join('\n'));

  // 明けた直後にもう一度落ちた (表示の時刻を 1 分過ぎている) は、翌日と読まず倍々の続き (肩 1 → 10 分)。
  // 翌日と読むと約 24 時間止まる
  const before = Date.now();
  h.noteAutonomyOutcome(item, failed(limitError(before - 60_000)));
  const again = h.tickStates.get('kt');
  assert.ok(
    again.backoffUntil >= before + BACKOFF_BASE_MS * 2 && again.backoffUntil <= Date.now() + BACKOFF_BASE_MS * 2,
    `明けた直後の再失敗: ${again.backoffUntil - before}ms`,
  );
  assert.equal(again.backoffLevel, 2);

  // reset の無い失敗は従来どおり
  assertDoubled('failed(rate limit)', 'reset の無い失敗');
  assertDoubled('failed(実行エラー)', '理由の無い失敗');
  // 60 字で tz の閉じ括弧が切られた形は読まない。包みの `)` を tz の閉じ括弧と取り違えると
  // `Etc/GMT+10` が別の有効な tz `Etc/GMT+1` として読めてしまう
  const cut = failed(`${'x'.repeat(35)} resets 1:30pm (Etc/GMT+10)`);
  assert.ok(cut.endsWith('(Etc/GMT+1)'), cut);
  assertDoubled(cut, '切り詰められた tz');
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

// ---- ハーネスの改訂の解き直し (src/replay.js) ----

test('tick: 解き直しの見回り (settleReplays) を着手の判断より先にチャンネルごとに呼び、落ちても tick を続ける / 台帳が読めなければ呼ばない', async (t) => {
  const seen = [];
  const h = harness(t, {
    tasks: [{ title: 'lint' }],
    settleReplays: async ({ channelName, autonomy, now }) => {
      seen.push([channelName, autonomy.harness.replay.timeoutMin, now, h.threads.length]);
      throw new Error('ボードを書けません');
    },
  });
  await h.autonomyTick(T0);
  assert.deepEqual(seen, [['kt', 12 * 60, T0, 0]], '着手より後に呼んでいる');
  assert.ok(h.errors.includes('[replay] kt: 解き直しの見回りに失敗 (tick は続けます): ボードを書けません'), h.errors.join('\n'));
  assert.deepEqual(h.threads.map((th) => th.name), ['task/1 lint'], '見回りの失敗で着手まで止めている');

  const calls = [];
  const broken = harness(t, { brokenLedger: 'recoveryStore', settleReplays: async () => { calls.push(1); } });
  await broken.autonomyTick(T0);
  assert.deepEqual(calls, []);
});
