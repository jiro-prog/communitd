import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_STATUS_CHARS, formatStatus, summarizeStatus } from '../src/status.js';
import { deriveTaskStatus } from '../src/taskstatus.js';
import { createInteractionHandler } from '../src/interactions.js';
import { SLASH_COMMANDS } from '../src/commands.js';

const T0 = Date.parse('2026-09-05T08:00:00.000Z'); // 17:00 JST
const minutes = (n) => n * 60000;
const hours = (n) => minutes(60 * n);
const iso = (ms) => new Date(ms).toISOString();

const task = (id, state, over = {}) => ({
  id, channel: 'kt', title: `task ${id}`, state, threadId: `T${id}`, jobsSpent: 1, jobBudget: 20,
  createdAt: iso(T0 - hours(30)), updatedAt: iso(T0 - hours(1)),
  history: [{ at: iso(T0 - hours(30)), from: null, to: 'proposed', by: 'opus' }],
  ...over,
});
const mergedTask = (id, at, note = 'merge abc123') => task(id, 'merged', {
  history: [
    { at: iso(T0 - hours(30)), from: null, to: 'proposed', by: 'opus' },
    { at: iso(at - minutes(60)), from: 'approved', to: 'in-progress', by: 'scheduler' },
    { at: iso(at - minutes(10)), from: 'in-progress', to: 'review', by: 'opus' },
    { at: iso(at), from: 'review', to: 'merged', by: 'opus2', note },
  ],
});
const run = (threadId, over = {}) => ({
  id: `j-${threadId}`, threadId, botKey: 'opus', stage: 'ended', acceptedAt: iso(T0 - hours(2)), startedAt: iso(T0 - hours(2)),
  endedAt: iso(T0 - hours(1)), outcome: 'ok', next: 'human', evidence: { verified: true }, ...over,
});

test('summarizeStatus: 完了 (24h) / 進行中 / 復旧待ち / 判断待ちを同じ判定で分け、検証の無い完了は不明', () => {
  const tasks = [
    mergedTask('1', T0 - hours(2)),
    mergedTask('2', T0 - hours(30)),                 // 窓の外
    task('3', 'in-progress'),                          // 走っている
    task('4', 'in-progress'),                          // verify NG で止まっている
    task('5', 'blocked', { history: [{ at: iso(T0 - hours(3)), from: 'review', to: 'blocked', note: '差し戻し 2 回目' }] }),
    task('6', 'approved'),
    task('7', 'dropped', { history: [{ at: iso(T0 - hours(1)), from: 'proposed', to: 'dropped', note: '重複' }] }),
  ];
  const runsByThread = {
    T1: [run('T1', { evidence: { verified: true } })],
    T3: [run('T3', { stage: 'model', endedAt: null, outcome: null, next: null })],
    T4: [run('T4', { outcome: 'verify-failed', next: 'recovery', endedAt: iso(T0 - minutes(40)) })],
  };
  const runs = Object.values(runsByThread).flat();
  const s = summarizeStatus({
    channelName: 'kt', tasks, runs, now: T0,
    statusOf: (t) => deriveTaskStatus({ task: t, runs: runsByThread[t.threadId] ?? [], now: T0 }),
    pause: null, backoffUntil: 0, dayJobsLeft: 38, maxJobsPerDay: 40,
  });
  assert.deepEqual(s.completed.map((c) => c.task.id), ['1']);
  assert.equal(s.completed[0].verified, true);
  assert.equal(s.completed[0].note, 'merge abc123');
  assert.deepEqual(s.active.map((a) => [a.task.id, a.status.status]), [['3', 'running']]);
  assert.deepEqual(s.recovering.map((r) => [r.task.id, r.status.status]), [['4', 'recovery-wait']]);
  assert.deepEqual(s.decisions.map((d) => [d.task.id, d.status.status]), [['5', 'blocked']]);
  assert.equal(s.open, 1);
  assert.deepEqual(s.dropped.map((d) => d.task.id), ['7']);
  assert.equal(s.runs.total, 3, '窓の中の job (走っているものも含む)');
  assert.deepEqual(s.runs.byOutcome, { ok: 1, 'verify-failed': 1, live: 1 });

  // 検証記録の無い完了は不明 (成功と数えない)
  const noRuns = summarizeStatus({ channelName: 'kt', tasks: [mergedTask('1', T0 - hours(2))], runs: [], now: T0, statusOf: () => ({ status: 'done' }) });
  assert.equal(noRuns.completed[0].verified, null);
  // 判定が投げても集計は出る
  const throwing = summarizeStatus({ channelName: 'kt', tasks: [task('9', 'in-progress')], now: T0, statusOf: () => { throw new Error('x'); } });
  assert.equal(throwing.recovering[0].status.status, 'reconcile');
});

test('formatStatus: 4 節が必ず出て (0 件は「なし」)、運転の行に pause / 予算 / job の数字が並ぶ', () => {
  const tasks = [mergedTask('1', T0 - hours(2)), task('4', 'in-progress'), task('5', 'blocked', { history: [{ at: iso(T0 - hours(3)), from: 'review', to: 'blocked', note: '差し戻し 2 回目' }] })];
  const runsByThread = { T1: [run('T1')], T4: [run('T4', { outcome: 'failed', stageDetail: 'API Error: 529', next: 'recovery', endedAt: iso(T0 - minutes(40)) })] };
  const s = summarizeStatus({
    channelName: 'kt', tasks, runs: Object.values(runsByThread).flat(), now: T0,
    statusOf: (t) => deriveTaskStatus({ task: t, runs: runsByThread[t.threadId] ?? [], now: T0 }),
    pause: null, backoffUntil: T0 + minutes(10), dayJobsLeft: 38, maxJobsPerDay: 40,
  });
  const text = formatStatus(s);
  assert.match(text, /^📊 kt の状況 \(過去 24h \/ 2026-09-05 17:00 JST\)/);
  assert.match(text, /\*\*完了 \(1 件\)\*\*\n・#1 15:00 「task 1」 verify OK \(merge abc123\) <#T1>/);
  assert.match(text, /\*\*進行中 \(0 件\)\*\*\n・なし/);
  assert.match(text, /\*\*復旧待ち \(1 件\)\*\*\n・#4 40m 「task 4」 \(復旧待ち: 実行失敗: API Error: 529 \(opus\) → スレッドで `\/retry`\) <#T4>/);
  assert.match(text, /\*\*判断待ち \(1 件\)\*\*\n・#5 3h0m 「task 5」 \(要人間: 差し戻し 2 回目 → 原因を直して復帰 \(resume\)\) <#T5>/);
  assert.match(text, /\*\*運転\*\*: ▶️ 自律運転は動いています \/ ⏳ バックオフ中 \(10 分後に明ける\) \/ 日次予算 残 38 \/ 40 \/ 着手待ち 0 件 \/ job 2 本 \(failed 1 \/ ok 1\)/);
  assert.ok(text.length <= MAX_STATUS_CHARS);
});

test('formatStatus: 検証記録なしは不明と書き、実行記録が読めなければ job の数字を出さず、pause は誰がいつ止めたか', () => {
  const s = summarizeStatus({
    channelName: 'kt', tasks: [mergedTask('1', T0 - hours(2))], runs: [], runsError: 'JSON として読めません', now: T0,
    statusOf: () => ({ status: 'done' }),
    pause: { paused: true, at: iso(T0 - hours(5)), by: 'U1', reason: '調査' },
  });
  const text = formatStatus(s);
  assert.match(text, /検証記録なし \(不明\)/);
  assert.match(text, /⚠️ 実行記録が読めない \(JSON として読めません\) — job の数字は出せません/);
  assert.match(text, /⏸ 自律運転は停止中 \(2026-09-05 12:00 JST に <@U1> が停止 \/ 理由: 調査\)/);
  assert.ok(!/job \d+ 本/.test(text));
});

test('formatStatus: 読めない台帳は件数とファイル名を出し、自律起動が止まっていることを書く', () => {
  const s = summarizeStatus({
    channelName: 'kt', tasks: [], runs: [], now: T0, statusOf: () => ({ status: 'done' }),
    ledgerErrors: [
      { file: 'pause.json', reason: 'JSON として読めません (Unexpected end of JSON input)', gate: true },
      { file: 'tasks.json', reason: '読み込めません (EACCES: permission denied)', gate: true },
    ],
    // 読めない pause.json は「停止扱い」の合成記録で来る (src/store.js の PauseStore)
    pause: { paused: true, by: 'system', reason: 'pause.json が読めない: …', broken: true, at: iso(T0 - hours(1)) },
  });
  assert.deepEqual(s.ledgers.map((l) => l.file), ['pause.json', 'tasks.json']);
  const text = formatStatus(s);
  assert.match(text, /❌ 読めない台帳 2 件 \(pause\.json \/ tasks\.json\) — 自律起動は止まっています。直すか手で退避して再起動/);
  assert.match(text, /⏸ 自律運転は停止中/);
  // 実行記録が読めるなら job の数字はそのまま出す (runsError の意味は変えない)
  assert.match(text, /job 0 本/);
  assert.equal(/読めない台帳/.test(formatStatus(summarizeStatus({
    channelName: 'kt', tasks: [], runs: [], now: T0, statusOf: () => ({ status: 'done' }),
  }))), false, '健全なのに台帳の行を出している');
});

test('formatStatus: 門でない台帳の破損は「自律起動には影響なし」と分けて書く (Opus2 Major1)', () => {
  const text = formatStatus(summarizeStatus({
    channelName: 'kt', tasks: [], runs: [], now: T0, statusOf: () => ({ status: 'done' }),
    // sessions.json だけが壊れた日: 書き込みは断られるが、着手も巡回も動く
    ledgerErrors: [{ file: 'sessions.json', reason: 'JSON として読めません', gate: false }],
  }));
  assert.match(text, /⚠️ 読めない台帳 1 件 \(sessions\.json\) — 自律起動には影響なし \(書き込みは断られます\)/);
  assert.equal(/自律起動は止まっています/.test(text), false, '門でない台帳で「止まっています」と言っている');

  // 門と門でないものが混ざったら両方出す (直す順を人が決められるように)
  const both = formatStatus(summarizeStatus({
    channelName: 'kt', tasks: [], runs: [], now: T0, statusOf: () => ({ status: 'done' }),
    ledgerErrors: [
      { file: 'pause.json', reason: 'x', gate: true },
      { file: 'sessions.json', reason: 'y', gate: false },
    ],
  }));
  assert.match(both, /❌ 読めない台帳 1 件 \(pause\.json\) — 自律起動は止まっています/);
  assert.match(both, /⚠️ 読めない台帳 1 件 \(sessions\.json\)/);
});

test('formatStatus: 完了が大量でも判断待ちの見出しと先頭 1 行は消えない (1900 字以内)', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => mergedTask(String(i + 1), T0 - minutes(i + 1), 'merge ' + 'x'.repeat(40)));
  tasks.push(task('99', 'blocked', { title: 'う'.repeat(100), history: [{ at: iso(T0 - hours(3)), from: 'review', to: 'blocked', note: 'あ'.repeat(100) }] }));
  const s = summarizeStatus({ channelName: 'kt', tasks, runs: [], now: T0, statusOf: (t) => deriveTaskStatus({ task: t, runs: [], now: T0 }) });
  const text = formatStatus(s);
  assert.ok(text.length <= MAX_STATUS_CHARS, `${text.length}`);
  assert.match(text, /\*\*完了 \(30 件\)\*\*/);
  assert.match(text, /… ほか \d+ 件/);
  assert.match(text, /\*\*判断待ち \(1 件\)\*\*\n・#99 /);
  assert.match(text, /\*\*運転\*\*/);
});

test('formatStatus は集計が無ければ ⚠️', () => {
  assert.match(formatStatus(null), /⚠️/);
});

// ---- /status (interaction 側は門番と表示だけ) ----

test('/status はスラッシュコマンドとして登録され、実体へチャンネル名を渡す', async () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.name === 'status'));
  const log = [];
  const calls = [];
  const onInteraction = createInteractionHandler({
    config: { guildId: 'G1', allowedUserIds: ['U1'] },
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'kt' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    statusReport: async (args) => { calls.push(args); return '📊 kt の状況'; },
  });
  const interaction = {
    commandName: 'status', guildId: 'G1', channelId: 'C1', user: { id: 'U1' },
    channel: { id: 'T1', isThread: () => true, parent: { name: 'kt' } },
    options: { getString: () => null, getBoolean: () => null },
    isChatInputCommand: () => true, inGuild: () => true,
    deferReply: async () => { log.push('defer'); },
    editReply: async (p) => { log.push(`edit:${typeof p === 'string' ? p : p?.content}`); },
    reply: async (p) => { log.push(`reply:${typeof p === 'string' ? p : p?.content}`); },
  };
  await onInteraction({ key: 'fable' }, interaction);
  assert.equal(calls[0].channelName, 'kt');
  assert.ok(log.includes('edit:📊 kt の状況'));

  const none = createInteractionHandler({
    config: { guildId: 'G1', allowedUserIds: ['U1'] },
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'kt' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {}, writeRestartNotice: () => {}, shutdown: async () => {},
  });
  log.length = 0;
  await none({ key: 'fable' }, interaction);
  assert.ok(log.some((l) => /^edit:⚠️ 状況表示の機能が無効です/.test(l)), log.join(' | '));
});

// ---- 自律社会の 1 行 (docs/society-ledger.md・S2-1) ----

const societyStatus = (society) => formatStatus(summarizeStatus({
  channelName: 'kt', tasks: [], runs: [], now: T0, statusOf: () => ({ status: 'done' }), society,
}));

test('/status: society を渡さなければ行を出さない (既存の配備を 1 行も増やさない)', () => {
  const out = societyStatus(undefined);
  assert.equal(/社会/.test(out), false, out);
  // 渡っていない = null で保つ (0 件や off と混ぜない)
  assert.equal(summarizeStatus({ channelName: 'kt', statusOf: () => ({ status: 'done' }) }).society, null);
});

test('/status: off の配備では行を増やさない (起動ログと同じ方針)', () => {
  const out = societyStatus({ mode: 'off' });
  assert.equal(/社会/.test(out), false, out);
  // 材料としては残す (S2-2 以降が使う) — 出さないのは表示の判断
  assert.deepEqual(summarizeStatus({
    channelName: 'kt', statusOf: () => ({ status: 'done' }), society: { mode: 'off' },
  }).society, { mode: 'off' });
});

test('/status: 社会の行は正常 / 停止で書き分ける', () => {
  const healthy = societyStatus({
    mode: 'observe', state: 'ok', healthy: true, revision: 12, haltReason: null, leftovers: 0,
    cases: { open: 1, active: 2, waiting: 1, verifying: 0, resolved: 2, closed: 1 },
  });
  assert.match(healthy, /\*\*社会\*\*: observe · revision 12 · 案件 open 1 \/ active 2 \/ waiting 1 \/ verifying 0 \(終結 3\)/);

  const halted = societyStatus({
    mode: 'observe', state: 'absent', healthy: false, revision: null, leftovers: 0, cases: null,
    haltReason: 'society.json がありません — society.mode が observe なら台帳が要ります。**初回とは推測しません** (…)',
  });
  assert.match(halted, /\*\*社会\*\*: ⛔ observe — society\.json がありません/);
  // 停止理由は長いので先頭 1 文だけ (直し方の全文は起動ログと doctor が出す)
  assert.equal(/初回とは推測しません/.test(halted), false, halted);
  // 運転の直後に置く
  assert.ok(halted.indexOf('**運転**') < halted.indexOf('**社会**'));
});

test('/status: 保留と待ちの内訳を社会の行に足す (静かなときは伸ばさない)', () => {
  const base = {
    mode: 'observe', state: 'ok', healthy: true, revision: 12, haltReason: null, leftovers: 0,
    cases: { open: 1, active: 2, waiting: 3, verifying: 0, resolved: 0, closed: 0 },
  };
  // 何も詰まっていなければ従来どおりの 1 行 (0 件を並べない)
  const quiet = societyStatus({ ...base, held: 0, waiting: {}, overdue: 0 });
  assert.equal(/保留 |· 待ち /.test(quiet), false, quiet);

  const stalled = societyStatus({
    ...base, held: 2, waiting: { offer: 1, evidence: 2, dependency: 1 }, overdue: 1,
  });
  assert.match(stalled, /· 保留 2 \/ 待ち dependency 1 evidence 2 offer 1 \(期限切れ 1\)/);

  // 期限切れが 0 なら括弧ごと出さない・保留 0 なら書かない
  const onTime = societyStatus({ ...base, held: 0, waiting: { offer: 1 }, overdue: 0 });
  assert.match(onTime, /· 待ち offer 1/);
  assert.equal(/期限切れ|保留 /.test(onTime), false, onTime);

  // off は行ごと出さないまま
  assert.equal(/社会/.test(societyStatus({ mode: 'off', held: 3, waiting: { offer: 2 }, overdue: 1 })), false);
});

test('/status: 停止した案件は待ちと別に数える (人が再開するまで動かない)', () => {
  const base = {
    mode: 'observe', state: 'ok', healthy: true, revision: 12, haltReason: null, leftovers: 0,
    cases: { open: 1, active: 2, waiting: 3, verifying: 0, resolved: 0, closed: 0 },
  };
  const stopped = societyStatus({
    ...base, stopped: 2, held: 1, waiting: { paused: 2, offer: 1 }, overdue: 0,
  });
  assert.match(stopped, /· 停止 2 \/ 保留 1 \/ 待ち offer 1 paused 2/);
  // 0 件なら書かない (静かなときに行を伸ばさない)
  assert.equal(/停止 /.test(societyStatus({ ...base, stopped: 0, held: 0, waiting: {}, overdue: 0 })), false);
  // 渡されない配備 (S2-4b より前の材料) でも落ちない
  assert.equal(/停止 /.test(societyStatus({ ...base, held: 0, waiting: {}, overdue: 0 })), false);
});

test('/status: 台帳を開けていない社会の件数は書かない (0 件と混ぜない)', () => {
  const unknown = societyStatus({
    mode: 'active', state: 'broken', healthy: false, revision: null, haltReason: null, leftovers: 0, cases: null,
  });
  assert.match(unknown, /\*\*社会\*\*: active · revision 不明 · 案件の件数は不明/);
  assert.equal(/案件 open/.test(unknown), false, unknown);
});
