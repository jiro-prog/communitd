import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { resolveAutonomy } from '../src/config.js';
import { jobKindOf } from '../src/harness.js';
import {
  LOOP_REPORT_MAX_CHARS, NO_BOOT_RECORD, defaultSince, deployStatus, fitReport, formatLoopReport,
  loopReportJson, parseBoots, patrolGroups, summarizeLoop,
} from '../src/loop-report.js';

/** JST の壁時計 → ISO (UTC) */
const jst = (wall) => new Date(Date.parse(`${wall}+09:00`)).toISOString();
const ms = (wall) => Date.parse(`${wall}+09:00`);
const MIN = 60_000;

const ROOT = '/repo/bridge';
const CH = 'proj';

function autonomyOf({ scout = 'sc', planner = 'pl', harness = 'pl', cap = 3, baseBranch = 'dev' } = {}) {
  return resolveAutonomy({
    autonomy: {
      enabled: true, baseBranch, scout: { bot: scout }, planner: { bot: planner }, harness: { bot: harness },
      worker: { bots: ['wk'] }, reviewer: 'rv', maxJobsPerDay: cap,
    },
  });
}

/** 巡回の形の job (受付 = 起動。終端は 10 分後) */
function patrolRun(id, botKey, wall, { endMin = 10, toolCalls = 5, ...extra } = {}) {
  return {
    id, botKey, channelName: CH, taskId: null, contract: null,
    trigger: { kind: 'bot', byBotKey: 'rv' },
    acceptedAt: jst(wall), startedAt: jst(wall),
    endedAt: endMin === null ? null : new Date(ms(wall) + endMin * MIN).toISOString(),
    evidence: toolCalls === null ? null : { toolCalls },
    ...extra,
  };
}

/** 起票の 1 行だけを持つタスク */
const filed = (id, by, at, extra = {}) => ({ id, channel: CH, state: 'proposed', history: [{ at, from: null, to: 'proposed', by }], ...extra });

/** git を使わない (呼ばれたら落とす) */
const noGit = () => { throw new Error('git を呼ばないはず'); };

function summarize(over = {}) {
  return summarizeLoop({
    runs: [], tasks: [], recovery: [], inbox: [], boots: { entries: null, reason: 'boots.json が無い' },
    autonomy: autonomyOf(), channel: CH, cwd: ROOT, root: ROOT, git: noGit,
    since: ms('2026-10-12T00:00:00'), until: ms('2026-10-15T00:00:00'), now: ms('2026-10-14T21:00:00'),
    ...over,
  });
}

const dayOf = (summary, day) => summary.daily.find((d) => d.day === day);
const patrolOf = (summary, day, bot) => summary.patrol.days.find((d) => d.day === day).groups.find((g) => g.botKey === bot);

test('src/loop-report.js は時刻・ハーネス・node 組み込み以外を import しない (配線の層・scripts/ へ依存しない)', () => {
  const source = readFileSync(new URL('../src/loop-report.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:path', './harness.js', './time.js']);
});

test('jobKindOf は export され、契約の種類を taskId より先に見る', () => {
  assert.equal(jobKindOf({ taskId: null }), 'other');
  assert.equal(jobKindOf({ taskId: '9' }), 'task-work');
  assert.equal(jobKindOf({ taskId: null, contract: { kind: 'task-approval' } }), 'approval');
  assert.equal(jobKindOf({ taskId: '9', contract: { kind: 'task-review' } }), 'review');
});

test('patrolGroups: 同じ bot の役は 1 群にまとめ、役の順 (スカウト → 企画 → 改訂) で並べる', () => {
  assert.deepEqual(patrolGroups(autonomyOf()).map((g) => [g.botKey, g.label]), [['sc', 'スカウト'], ['pl', '企画・改訂']]);
  assert.deepEqual(patrolGroups(autonomyOf({ harness: 'hv' })).map((g) => g.label), ['スカウト', '企画', '改訂']);
  assert.deepEqual(patrolGroups(autonomyOf({ planner: 'sc', harness: 'hv' })).map((g) => g.label), ['スカウト・企画', '改訂']);
  assert.deepEqual(patrolGroups(resolveAutonomy({})), []);
});

test('① 巡回の job は other かつ bot 起動・巡回の bot・終端あり・このチャンネルのものだけ', () => {
  const runs = [
    patrolRun('a', 'sc', '2026-10-13T01:00:00'),
    patrolRun('b', 'pl', '2026-10-13T02:00:00'),
    patrolRun('human', 'sc', '2026-10-13T03:00:00', { trigger: { kind: 'human' } }),
    patrolRun('self', 'sc', '2026-10-13T03:10:00', { trigger: { kind: 'self', byBotKey: 'sc' } }),
    patrolRun('work', 'sc', '2026-10-13T03:20:00', { taskId: '7' }),
    patrolRun('approve', 'pl', '2026-10-13T03:30:00', { contract: { kind: 'task-approval' } }),
    patrolRun('worker', 'wk', '2026-10-13T03:40:00'),
    patrolRun('running', 'sc', '2026-10-13T03:50:00', { endMin: null }),
    patrolRun('elsewhere', 'sc', '2026-10-13T04:00:00', { channelName: 'other' }),
  ];
  const s = summarize({ runs });
  assert.equal(patrolOf(s, '2026-10-13', 'sc').jobs, 1);
  assert.equal(patrolOf(s, '2026-10-13', 'pl').jobs, 1);
  // ③ の job 数は種類を問わずこのチャンネルの全部 (走行中も)、自律起動の巡回は ① と同じ 2 本
  assert.equal(dayOf(s, '2026-10-13').jobs, 8);
  assert.equal(dayOf(s, '2026-10-13').patrol, 2);
});

test('① 提案はその bot が job の起動〜終端 (両端込み) に起票したタスク。0 件の job が空回り', () => {
  const runs = [
    patrolRun('a', 'sc', '2026-10-13T01:00:00'), // 01:00〜01:10
    patrolRun('b', 'sc', '2026-10-13T02:00:00'), // 02:00〜02:10
    patrolRun('c', 'sc', '2026-10-13T03:00:00'), // 03:00〜03:10
  ];
  const tasks = [
    filed('1', 'sc', jst('2026-10-13T01:09:57')), // a の終端の 3 秒前
    filed('2', 'sc', jst('2026-10-13T01:10:00')), // a の終端ちょうど
    filed('3', 'pl', jst('2026-10-13T02:05:00')), // b の間だが別の bot
    filed('4', 'sc', jst('2026-10-13T02:10:01')), // b の終端の 1 秒後
    filed('5', 'sc', jst('2026-10-13T02:59:59')), // c の起動の 1 秒前
  ];
  const g = patrolOf(summarize({ runs, tasks }), '2026-10-13', 'sc');
  assert.deepEqual({ jobs: g.jobs, proposals: g.proposals, idle: g.idle }, { jobs: 3, proposals: 2, idle: 2 });
});

test('① ③ 日は受付の時刻で切る — 23:58 に受け付けて 0:06 に起動した job は前の日。提案の窓は起動から', () => {
  const late = patrolRun('late', 'pl', '2026-10-12T23:58:00', { startedAt: jst('2026-10-13T00:06:00'), endedAt: jst('2026-10-13T00:25:00') });
  const tasks = [
    filed('1', 'pl', jst('2026-10-13T00:01:00')), // 受付と起動の間 (窓の外)
    filed('2', 'pl', jst('2026-10-13T00:24:00')),
  ];
  const s = summarize({ runs: [late], tasks });
  assert.equal(patrolOf(s, '2026-10-12', 'pl').jobs, 1);
  assert.equal(patrolOf(s, '2026-10-12', 'pl').proposals, 1);
  assert.equal(patrolOf(s, '2026-10-13', 'pl').jobs, 0);
  assert.equal(dayOf(s, '2026-10-12').patrol, 1);
  assert.equal(dayOf(s, '2026-10-12').jobs, 1);
  assert.equal(dayOf(s, '2026-10-13').jobs, 0);
});

test('① tool は記録のある job だけで合計と中央値 (n を持つ)', () => {
  const runs = [
    patrolRun('a', 'sc', '2026-10-13T01:00:00', { toolCalls: 10 }),
    patrolRun('b', 'sc', '2026-10-13T02:00:00', { toolCalls: 30 }),
    patrolRun('c', 'sc', '2026-10-13T03:00:00', { toolCalls: null }),
  ];
  const g = patrolOf(summarize({ runs }), '2026-10-13', 'sc');
  assert.deepEqual(g.toolCalls, { n: 2, sum: 40, median: 20 });
  assert.match(formatLoopReport(summarize({ runs })), /^10-13 スカウト 3・空 3・40\/20 \(n2\) \| 企画・改訂 0$/m);
});

/** proposed→approved→in-progress→review→merged を分刻みで (steps = [状態, その状態に居た分] の列) */
function walked(id, startWall, steps, { channel = CH, by = 'sc' } = {}) {
  let at = ms(startWall);
  let from = null;
  const history = [];
  for (const [to, minutes] of steps) {
    history.push({ at: new Date(at).toISOString(), from, to, by: history.length === 0 ? by : 'x' });
    from = to;
    at += minutes * MIN;
  }
  return { id, channel, state: from, history };
}

test('② 段は居た時間の合計 (差し戻しで戻ったら足す)・blocked はどこにも入れない・対象は期間内に merged', () => {
  const tasks = [
    walked('1', '2026-10-13T01:00:00', [
      ['proposed', 10], ['approved', 2], ['in-progress', 20], ['review', 5], ['in-progress', 10], ['review', 3], ['merged', 0],
    ]),
    walked('2', '2026-10-13T05:00:00', [
      ['proposed', 30], ['approved', 4], ['in-progress', 6], ['blocked', 600], ['in-progress', 4], ['review', 7], ['merged', 0],
    ]),
    // 期間の前に merged (数えない)
    walked('3', '2026-10-01T05:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['merged', 0]]),
    // 期間内だが別チャンネル (数えない)
    walked('4', '2026-10-13T05:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['merged', 0]], { channel: 'other' }),
  ];
  const { stages } = summarize({ tasks });
  assert.equal(stages.merged, 2);
  assert.deepEqual(stages.approval, { n: 2, medianMin: 20 }); // 10 と 30
  assert.deepEqual(stages.start, { n: 2, medianMin: 3 }); // 2 と 4
  assert.deepEqual(stages.work, { n: 2, medianMin: 20 }); // 30 と 10 (blocked の 600 は入らない)
  assert.deepEqual(stages.review, { n: 2, medianMin: 7.5 }); // 8 と 7
  assert.equal(stages.sendBacks, 1);
});

test('② merge→次の起票は同じチャンネルで merge より後の最初の起票まで。後に起票の無い merge は外す', () => {
  const tasks = [
    walked('1', '2026-10-13T01:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['merged', 0]]), // merge 01:04
    walked('2', '2026-10-13T02:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['merged', 0]]), // 起票 02:00・merge 02:04
    filed('3', 'sc', jst('2026-10-13T02:34:00')),
    filed('4', 'sc', jst('2026-10-13T01:30:00'), { channel: 'other' }),
    walked('5', '2026-10-13T03:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['merged', 0]]), // 起票 03:00・merge 03:04 (後が無い)
  ];
  const { stages } = summarize({ tasks });
  assert.equal(stages.merged, 3);
  // 01:04 → 02:00 (56 分)、02:04 → 02:34 (30 分)。03:04 の後は無い
  assert.deepEqual(stages.nextFiling, { n: 2, medianMin: 43 });
});

/** 着手 (approved→in-progress) 1 回だけを持つタスク */
const started = (id, wall, channel = CH) => ({
  id, channel, state: 'in-progress',
  history: [{ at: jst('2026-10-01T00:00:00'), from: null, to: 'proposed', by: 'sc' }, { at: jst(wall), from: 'approved', to: 'in-progress', by: 'scheduler' }],
});

test('③ 自律起動は着手 + 巡回 + 自動復旧 (送ったもの) — レビュー・承認・手動の再開・別チャンネルは数えない', () => {
  const tasks = [
    started('1', '2026-10-13T01:00:00'), started('2', '2026-10-13T02:00:00', 'other'),
    // 差し戻し (review→in-progress) は着手ではない。approved→in-progress の 1 回だけを数える
    walked('3', '2026-10-13T09:00:00', [['proposed', 1], ['approved', 1], ['in-progress', 1], ['review', 1], ['in-progress', 1]]),
  ];
  const runs = [
    patrolRun('p', 'sc', '2026-10-13T03:00:00'),
    patrolRun('rv', 'rv', '2026-10-13T04:00:00', { taskId: '1', contract: { kind: 'task-review' } }),
    patrolRun('ap', 'pl', '2026-10-13T04:10:00', { contract: { kind: 'task-approval' } }),
  ];
  const recovery = [
    { taskId: '1', attempts: [
      { kind: 'auto', at: jst('2026-10-13T05:00:00'), sentAt: jst('2026-10-13T05:00:01') },
      { kind: 'auto', at: jst('2026-10-13T06:00:00'), sentAt: null },
      { kind: 'manual', at: jst('2026-10-13T07:00:00'), sentAt: jst('2026-10-13T07:00:01') },
    ] },
    { taskId: '2', attempts: [{ kind: 'auto', at: jst('2026-10-13T08:00:00'), sentAt: jst('2026-10-13T08:00:01') }] },
  ];
  const d = dayOf(summarize({ tasks, runs, recovery, autonomy: autonomyOf({ cap: 40 }) }), '2026-10-13');
  assert.deepEqual(
    { autonomous: d.autonomous, starts: d.starts, patrol: d.patrol, recoveries: d.recoveries, jobs: d.jobs, cappedAt: d.cappedAt },
    { autonomous: 4, starts: 2, patrol: 1, recoveries: 1, jobs: 3, cappedAt: null },
  );
});

test('③ 上限の境界: 上限−1 は止まらない・上限ちょうどは上限本目から翌 0:00・上限+1 も上限本目から・今日は今まで', () => {
  // 上限 3。10-12 は 2 本 / 10-13 は 3 本 / 10-14 (今日、now 21:00) は 4 本
  const tasks = [
    started('1', '2026-10-12T09:00:00'), started('2', '2026-10-12T10:00:00'),
    started('3', '2026-10-13T09:00:00'), started('4', '2026-10-13T10:00:00'),
    started('6', '2026-10-14T09:00:00'), started('7', '2026-10-14T18:00:00'),
  ];
  const runs = [
    patrolRun('a', 'sc', '2026-10-13T20:00:00'),
    patrolRun('b', 'sc', '2026-10-14T11:00:00'),
    patrolRun('c', 'pl', '2026-10-14T12:00:00'),
  ];
  const s = summarize({ tasks, runs });
  const d12 = dayOf(s, '2026-10-12');
  assert.deepEqual([d12.autonomous, d12.cappedAt, d12.stoppedMin], [2, null, null]);
  const d13 = dayOf(s, '2026-10-13');
  assert.deepEqual([d13.autonomous, d13.cappedAt, d13.stoppedMin], [3, ms('2026-10-13T20:00:00'), 240]);
  const d14 = dayOf(s, '2026-10-14');
  // 3 本目は 12:00 (4 本目の 18:00 ではない)。今日なので今 (21:00) まで
  assert.deepEqual([d14.autonomous, d14.cappedAt, d14.stoppedMin], [4, ms('2026-10-14T12:00:00'), 540]);
  const text = formatLoopReport(s);
  assert.match(text, /^10-12 job 0 \/ 自律 2\/3 \(着手 2・巡回 0・復旧 0\)$/m);
  assert.match(text, /^10-13 job 1 \/ 自律 3\/3 \(着手 2・巡回 1・復旧 0\) 20:00 から 4\.0 h 止まった$/m);
  assert.match(text, /^10-14 job 2 \/ 自律 4\/3 \(着手 2・巡回 2・復旧 0\) 12:00 から 9\.0 h 止まった$/m);
  assert.match(text, /発議は含まない/);
});

test('期間: 既定は今日を含む 7 暦日 (JST)。期間外の起動は数えない', () => {
  assert.equal(defaultSince(ms('2026-10-14T21:00:00')), ms('2026-10-08T00:00:00'));
  // until が翌 0:00 ちょうど (--until 2026-10-14) ならその日まで
  assert.equal(defaultSince(ms('2026-10-15T00:00:00')), ms('2026-10-08T00:00:00'));
  assert.equal(defaultSince(ms('2026-10-15T00:00:01')), ms('2026-10-09T00:00:00'));
  const s = summarize({
    since: defaultSince(ms('2026-10-14T21:00:00')),
    tasks: [started('1', '2026-10-07T23:59:59'), started('2', '2026-10-08T00:00:00'), started('3', '2026-10-14T21:00:01')],
  });
  assert.deepEqual(s.days, ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(s.daily.reduce((n, d) => n + d.starts, 0), 1);
});

/** 偽の git: [args の先頭 2 語 → 出力 or Error]。呼ばれた args を残す */
function fakeGit(table) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push([args.join(' '), cwd]);
    for (const [prefix, out] of table) {
      if (!args.join(' ').startsWith(prefix)) continue;
      if (out instanceof Error) throw out;
      return typeof out === 'function' ? out(cwd) : out;
    }
    throw new Error(`想定外の git ${args.join(' ')}`);
  };
  return { git, calls };
}

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const boots = (...entries) => ({ entries, reason: null });

test('④ ブリッジ本体のリポジトリなら、最新の起動の head から baseBranch への first-parent の merge と最古の時刻', () => {
  const { git, calls } = fakeGit([
    ['cat-file -e', ''],
    ['rev-list --count --first-parent --merges', '3\n'],
    ['log --first-parent --merges --format=%ct', '1760430000\n1760420000\n1760410000\n'],
  ]);
  const at = jst('2026-10-14T12:44:00');
  const dep = deployStatus({ boots: boots({ at: jst('2026-10-13T00:00:00'), head: OLD }, { at, head: HEAD, branch: 'dev' }), git, root: ROOT, cwd: ROOT, baseBranch: 'dev' });
  assert.deepEqual(dep, { status: 'ok', boot: { at: Date.parse(at), head: HEAD, branch: 'dev' }, baseBranch: 'dev', pending: 3, oldestAt: 1760410000_000 });
  // パスが同じなので共通ディレクトリは聞かない。数えるのは最新の head (古い起動へ遡らない)
  assert.deepEqual(calls.map(([args]) => args), [
    `cat-file -e ${HEAD}^{commit}`,
    `rev-list --count --first-parent --merges ${HEAD}..dev`,
    `log --first-parent --merges --format=%ct ${HEAD}..dev`,
  ]);
  assert.ok(calls.every(([, cwd]) => cwd === ROOT));
});

test('④ 差が 0 本なら最古を聞かず「追いついている」', () => {
  const { git, calls } = fakeGit([['cat-file -e', ''], ['rev-list --count', '0']]);
  const dep = deployStatus({ boots: boots({ at: jst('2026-10-14T12:44:00'), head: HEAD, branch: 'dev' }), git, root: ROOT, cwd: ROOT, baseBranch: 'dev' });
  assert.equal(dep.pending, 0);
  assert.equal(dep.oldestAt, null);
  assert.equal(calls.length, 2);
  const text = formatLoopReport(summarize({ boots: boots({ at: jst('2026-10-14T12:44:00'), head: HEAD }), git }));
  assert.match(text, /^④ 配備: 起動 2026-10-14 12:44 JST の aaaaaaa は dev の merge に追いついている$/m);
});

test('④ 作業ツリーから走らせても、git の共通ディレクトリが同じなら本体と読む', () => {
  const { git } = fakeGit([
    ['rev-parse --git-common-dir', (cwd) => (cwd === ROOT ? '.git' : `${ROOT}/.git`)],
    ['cat-file -e', ''],
    ['rev-list --count', '1'],
    ['log --first-parent', '1760410000'],
  ]);
  const dep = deployStatus({ boots: boots({ at: null, head: HEAD }), git, root: ROOT, cwd: `${ROOT}/.worktrees/task-1`, baseBranch: 'dev' });
  assert.equal(dep.status, 'ok');
  assert.equal(dep.pending, 1);
});

test('④ ブリッジ本体でないリポジトリ・git の無い場所・作業場所の無いチャンネルは対象外 (boots を見ない)', () => {
  const other = fakeGit([['rev-parse --git-common-dir', (cwd) => (cwd === ROOT ? '.git' : '.git')]]);
  assert.deepEqual(deployStatus({ boots: null, git: other.git, root: ROOT, cwd: '/elsewhere', baseBranch: 'dev' }), { status: 'not-applicable' });
  const none = fakeGit([['rev-parse', new Error('not a git repository')]]);
  assert.deepEqual(deployStatus({ boots: null, git: none.git, root: ROOT, cwd: '/tmp/x', baseBranch: 'dev' }), { status: 'not-applicable' });
  assert.deepEqual(deployStatus({ boots: null, git: noGit, root: ROOT, cwd: null, baseBranch: 'dev' }), { status: 'not-applicable' });
  const text = formatLoopReport(summarize({ cwd: '/elsewhere', git: other.git }));
  assert.match(text, /^④ 配備: このチャンネルのリポジトリはブリッジ本体ではない — 対象外$/m);
});

test('④ boots が無い・読めない・空・最新の head が null は「起動の記録なし」で、git を呼ばず 0 にもしない', () => {
  const cases = [
    [{ entries: null, reason: 'boots.json が無い' }, 'boots.json が無い'],
    [parseBoots('{ broken'), 'JSON として読めない'],
    [parseBoots('{"boots": {}}'), '起動の配列 (boots) が無い'],
    [parseBoots('{"boots": []}'), '起動が 1 件も無い'],
    // 古い起動に head があっても、動いているのは最新の起動なので遡らない
    [boots({ at: null, head: HEAD }, { at: null, head: null }), 'head が null'],
    [null, 'boots.json が無い'],
  ];
  for (const [b, reason] of cases) {
    const dep = deployStatus({ boots: b, git: noGit, root: ROOT, cwd: ROOT, baseBranch: 'dev' });
    assert.equal(dep.status, 'unreadable');
    assert.ok(dep.reason.startsWith(NO_BOOT_RECORD), dep.reason);
    assert.ok(dep.reason.includes(reason), dep.reason);
  }
  const text = formatLoopReport(summarize());
  assert.match(text, /^④ 配備: 起動の記録なし — ④ は読めない \(boots\.json が無い\)$/m);
  assert.doesNotMatch(text, /merge 0 本/);
});

test('④ head がこのリポジトリに無い・baseBranch との差を数えられないは「読めない (理由)」', () => {
  const missing = fakeGit([['cat-file -e', new Error('fatal: Not a valid object name')]]);
  const dep = deployStatus({ boots: boots({ at: null, head: HEAD }), git: missing.git, root: ROOT, cwd: ROOT, baseBranch: 'dev' });
  assert.deepEqual(dep, { status: 'unreadable', reason: '④ は読めない (起動の head aaaaaaa がこのリポジトリに無い)' });
  const noBase = fakeGit([['cat-file -e', ''], ['rev-list', new Error("fatal: ambiguous argument 'x..dev'\nmore")]]);
  const dep2 = deployStatus({ boots: boots({ at: null, head: HEAD }), git: noBase.git, root: ROOT, cwd: ROOT, baseBranch: 'dev' });
  assert.equal(dep2.status, 'unreadable');
  assert.equal(dep2.reason, "④ は読めない (dev との差を git で数えられない: fatal: ambiguous argument 'x..dev')");
});

test('④ 受信箱はこのチャンネルの開いた用件 (closedAt が null) の件数と最古の経過', () => {
  const inbox = [
    { id: '1', channel: CH, openedAt: jst('2026-10-14T11:00:00'), closedAt: null },
    { id: '2', channel: CH, openedAt: jst('2026-10-12T21:00:00') },
    { id: '3', channel: CH, openedAt: jst('2026-10-01T00:00:00'), closedAt: jst('2026-10-02T00:00:00') },
    { id: '4', channel: 'other', openedAt: jst('2026-09-01T00:00:00'), closedAt: null },
  ];
  const s = summarize({ inbox });
  assert.deepEqual(s.inbox, { open: 2, oldestAt: ms('2026-10-12T21:00:00'), oldestMin: 48 * 60 });
  assert.match(formatLoopReport(s), /^受信箱: 開いた用件 2 件・最古 2\.0 日 \(2026-10-12 21:00 JST から\)$/m);
  assert.match(formatLoopReport(summarize()), /^受信箱: 開いた用件 0 件$/m);
});

test('--json の形: 時刻は +09:00 の ISO・暦日は JST', () => {
  const tasks = [started('1', '2026-10-13T09:00:00'), started('2', '2026-10-13T10:00:00'), started('3', '2026-10-13T11:00:00')];
  const json = loopReportJson(summarize({ tasks }));
  assert.equal(json.at, '2026-10-14T21:00:00.000+09:00');
  assert.equal(json.since, '2026-10-12T00:00:00.000+09:00');
  assert.equal(json.until, '2026-10-14T21:00:00.000+09:00');
  assert.equal(json.daily.find((d) => d.day === '2026-10-13').cappedAt, '2026-10-13T11:00:00.000+09:00');
  assert.equal(json.deploy.status, 'unreadable');
  assert.equal(Date.parse(json.at), ms('2026-10-14T21:00:00'));
});

test('fitReport: 上限ちょうどは切らない・1 字越えたら行の単位で切って印を残す', () => {
  const line = 'x'.repeat(99);
  const exact = Array.from({ length: 19 }, () => line).join('\n'); // 19 × 99 + 18 = 1899
  const atCap = `${exact}y`;
  assert.equal(atCap.length, LOOP_REPORT_MAX_CHARS);
  assert.equal(fitReport(atCap), atCap);
  const over = `${atCap}z`;
  const fitted = fitReport(over);
  assert.ok(fitted.length <= LOOP_REPORT_MAX_CHARS, String(fitted.length));
  assert.match(fitted, /1900 字で切った/);
  assert.ok(fitted.startsWith(`${line}\n`));
});

/**
 * 最悪の入力: 巡回 3 群 (スカウト・企画・改訂が別の bot)・7 日分・件数はどれも 3 桁・tool は一部欠け (n 付き)・
 * ② は全段に n 付き・③ は全日が上限で止まる・④ は git の失敗の理由 (いちばん長い言い方)・受信箱 3 桁
 */
function worstCase() {
  const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  const runs = [];
  const tasks = [];
  const recovery = [];
  let n = 0;
  for (const day of days) {
    for (const bot of ['sc', 'pl', 'hv']) {
      for (let i = 0; i < 123; i += 1) {
        n += 1;
        runs.push(patrolRun(`r${n}`, bot, `${day}T01:${String(i % 60).padStart(2, '0')}:00`, { toolCalls: i === 0 ? null : 998 + (i % 2) }));
      }
    }
    for (let i = 0; i < 123; i += 1) {
      n += 1;
      tasks.push({ ...started(`t${n}`, `${day}T02:${String(i % 60).padStart(2, '0')}:00`) });
      recovery.push({ taskId: `t${n}`, attempts: [{ kind: 'auto', sentAt: jst(`${day}T03:${String(i % 60).padStart(2, '0')}:00`) }] });
    }
  }
  // ② merged 999 件 (承認を飛ばしたものを混ぜて全段 n 付き)・差し戻し 3 桁・待ちは日の単位 (期間内に merge し終える長さ)
  for (let i = 0; i < 999; i += 1) {
    const steps = i % 2 === 0
      ? [['proposed', 2900], ['approved', 2900], ['in-progress', 1000], ['review', 500], ['in-progress', 500], ['review', 500], ['merged', 0]]
      : [['proposed', 2900], ['in-progress', 2900], ['blocked', 10], ['merged', 0]];
    tasks.push(walked(`m${i}`, '2026-10-08T00:00:00', steps));
  }
  tasks.push(filed('later', 'sc', jst('2026-10-30T00:00:00')));
  const inbox = Array.from({ length: 999 }, (_, i) => ({ id: String(i), channel: 'my-project-channel', openedAt: jst('2026-09-01T00:00:00'), closedAt: null }));
  const git = fakeGit([['cat-file -e', ''], ['rev-list', new Error(`fatal: ${'x'.repeat(200)}`)]]).git;
  const longName = 'my-project-channel';
  for (const r of runs) r.channelName = longName;
  for (const t of tasks) t.channel = longName;
  return summarizeLoop({
    runs, tasks, recovery, inbox, boots: boots({ at: null, head: HEAD }),
    autonomy: autonomyOf({ harness: 'hv', cap: 100, baseBranch: 'release-candidate' }),
    channel: longName, cwd: ROOT, root: ROOT, git,
    since: ms('2026-10-08T00:00:00'), until: ms('2026-10-14T23:59:00'), now: ms('2026-10-14T23:59:00'),
  });
}

test('最悪の入力 (①〜④ の全行・3 桁・7 日分) でも 1900 字に切らずに収まる', () => {
  const summary = worstCase();
  // 最悪になっていることの確かめ: 3 群・7 日・全日が上限で止まる・全段 n 付き
  assert.equal(summary.patrol.groups.length, 3);
  assert.equal(summary.daily.length, 7);
  assert.ok(summary.daily.every((d) => d.cappedAt !== null && d.jobs >= 100 && d.autonomous >= 100));
  assert.ok(summary.stages.merged >= 100 && summary.stages.sendBacks >= 100);
  const text = formatLoopReport(summary);
  assert.equal(text.split('\n').length, 1 + 1 + 7 + 2 + 1 + 7 + 1 + 1, text);
  assert.doesNotMatch(text, /字で切った/);
  assert.match(text, /121817\/998\.5 \(n122\)/);
  assert.match(text, /^④ 配備: ④ は読めない \(release-candidate との差を git で数えられない: fatal: x+\)$/m);
  assert.ok(text.length <= LOOP_REPORT_MAX_CHARS, `${text.length} 字`);
  // 同じ最悪の文をチャンネル名で伸ばして、上限ちょうどは切らない・1 字越えたら末尾の行を落として印を残す
  const pad = LOOP_REPORT_MAX_CHARS - text.length;
  const exact = formatLoopReport({ ...summary, channel: `${summary.channel}${'x'.repeat(pad)}` });
  assert.equal(exact.length, LOOP_REPORT_MAX_CHARS);
  assert.doesNotMatch(exact, /字で切った/);
  assert.match(exact, /^受信箱: /m);
  const over = formatLoopReport({ ...summary, channel: `${summary.channel}${'x'.repeat(pad + 1)}` });
  assert.ok(over.length <= LOOP_REPORT_MAX_CHARS, `${over.length} 字`);
  assert.match(over, /\n…\(1900 字で切った — 期間を縮めるか --json で全部\)$/);
  assert.doesNotMatch(over, /^受信箱: /m);
  assert.match(over, /^③ 日次 /m);
  // ④ の他の言い方 (未配備 3 桁) でも収まる
  const ok = { ...summary, deploy: { status: 'ok', boot: { at: ms('2026-10-14T12:44:00'), head: HEAD, branch: 'dev' }, baseBranch: 'release-candidate', pending: 999, oldestAt: ms('2026-10-01T00:00:00') } };
  assert.ok(formatLoopReport(ok).length <= LOOP_REPORT_MAX_CHARS);
});
