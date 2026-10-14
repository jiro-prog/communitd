import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planFiling } from '../src/board.js';
import { approvalItem } from '../src/bridge/board.js';
import { DEFAULT_TASK_JOB_BUDGET, resolveAutonomy } from '../src/config.js';
import {
  ACTION_KINDS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  INITIATIVE_JOB_BUDGET,
  backoffDelayMs,
  chargeInitiative,
  dayKeyFor,
  dutiesForEvent,
  formatInitiativeTag,
  awaitingReplays,
  initialState,
  isInitiativeTrigger,
  isReplayTask,
  persistedState,
  restoreState,
  SCOUT_JOB_BUDGET,
  UNMENTIONED_REASON,
  backoffOutcome,
  backoffOutcomeFor,
  isTaskDone,
  MIN_TASK_JOB_BUDGET,
  parseLimitReset,
  pickAnnouncer,
  pickWorker,
  planApproval,
  planReissueReview,
  planReview,
  planTaskCwd,
  planTick,
  proposedTasks,
  addCarry,
  dropCarry,
  recordFailure,
  recordScoutReport,
  recordSuccess,
  resolveHarness,
  resolveInitiative,
  resolvePlan,
  resolveScout,
  resolveStartTask,
  scoutPace,
  shouldDeliverProposal,
  touchesHarness,
  touchesThemes,
} from '../src/scheduler.js';

const T0 = Date.parse('2026-08-27T00:00:00.000Z');
const at = (minutes) => T0 + minutes * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 全部そろった自律運転設定 (resolveAutonomy の戻りと同じ形) */
const AUTONOMY = Object.freeze({
  enabled: true,
  directionFile: 'docs/direction.md',
  scout: { bot: 'opus', intervalMin: 60, maxOpenTasks: 6 },
  worker: { bots: ['opus'] },
  reviewer: 'fable',
  maxConcurrentTasks: 2,
  maxJobsPerDay: 40,
  taskJobBudget: 20,
});
const autonomy = (over = {}) => ({ ...AUTONOMY, ...over });

const task = (id, state) => ({ id: String(id), state });

/** 直近でスカウト済み = この tick はスカウトが due でない state */
const scouted = (over = {}) => ({
  ...initialState(), dayKey: dayKeyFor(T0), lastScoutAt: T0, ...over,
});

/** 既定を埋めた planTick (over で上書きする) */
function plan(over = {}) {
  return planTick({ tasks: [], autonomy: AUTONOMY, now: T0, state: scouted(), ...over });
}

// ---- 止まっている条件 ----

test('enabled でなければ何もしない (日付の繰越だけは進む)', () => {
  for (const enabled of [false, undefined, 'true', 1, null]) {
    const out = planTick({
      tasks: [task(1, 'approved')],
      autonomy: autonomy({ enabled }),
      now: T0,
      state: initialState(),
    });
    assert.deepEqual(out.actions, [], `enabled=${JSON.stringify(enabled)} で動いている`);
    assert.equal(out.state.jobsToday, 0);
    assert.equal(out.state.dayKey, dayKeyFor(T0), '止まっていても日付は進める');
  }
});

test('担当が居なければ何もしない (着手もスカウトも)', () => {
  // reviewer が居ないと着手しても main まで運べない (§3.6) ので、始めない。
  // state は初期値 = スカウトが due の状態にして、スカウトまで止まることを見る
  for (const over of [{ worker: { bots: [] } }, { reviewer: null }, { worker: { bots: [] }, reviewer: null }]) {
    const out = planTick({
      tasks: [task(1, 'approved')],
      autonomy: autonomy(over),
      now: T0,
      state: initialState(),
    });
    assert.deepEqual(out.actions, [], JSON.stringify(over));
  }
});

test('pause 中の tick は行動を選ばず、日付の繰越だけ進める', () => {
  // index.js は pause 中のチャンネルを「無効」として planTick へ渡す (配線は下のテスト)
  const tasks = [task(1, 'approved'), task(2, 'approved')];
  const paused = { ...AUTONOMY, enabled: false };

  const out = planTick({ tasks, autonomy: paused, now: T0, state: initialState() });
  assert.deepEqual(out.actions, [], 'pause 中に自律起動している');
  assert.equal(out.state.jobsToday, 0, '起こしていないのに日次予算を食っている');
  assert.equal(out.state.lastScoutAt, 0, '起こしていない巡回で時計が進んでいる');

  // 止まっている間に日が変わっても数え直せる
  const rolled = planTick({
    tasks,
    autonomy: paused,
    now: T0 + DAY_MS,
    state: { ...initialState(), dayKey: dayKeyFor(T0), jobsToday: 40 },
  });
  assert.equal(rolled.state.jobsToday, 0, '日付の繰越まで止めている');
  assert.equal(rolled.state.dayKey, dayKeyFor(T0 + DAY_MS));

  // 解除すれば元どおり動く
  const running = planTick({ tasks, autonomy: AUTONOMY, now: T0, state: initialState() });
  assert.ok(running.actions.length > 0, '再開しても動かない');
});

// 配線の約束は source で固定する (起動しないと読めない層)。関数本体は src/bridge/*.js にある。
// **改行は LF へ正規化して読む** — チェックアウトの設定 (`core.autocrlf=true`) 次第で作業ツリーが
// CRLF になり、`\n` を書いた照合が環境依存で外れる (windows CI 2026-09-11)。
// リポジトリには `.gitattributes` で LF を固定してあるが、それより前に clone した
// 作業ツリーには効かないので、読む側でも畳んでおく
const bridgeSource = (name) => readFileSync(fileURLToPath(new URL(`../src/bridge/${name}.js`, import.meta.url)), 'utf8')
  .replaceAll('\r\n', '\n');

test('autonomyTick は pause の状態を読み、自動召喚も止める', () => {
  const source = bridgeSource('scheduler');
  const from = source.indexOf('async function autonomyTick');
  const to = source.indexOf('async function startTaskFromBoard');
  assert.ok(from > 0 && to > from, 'autonomyTick を切り出せない (関数名が変わった?)');
  const tick = source.slice(from, to);

  // **状態を読むのは呼び出し側** (判断の層は IO を持たない)
  assert.match(tick, /pauseStore\.paused/, 'tick が pause の状態を見ていない');
  assert.match(tick, /enabled: false/, 'pause 中のチャンネルを無効として渡していない');

  // 承認・レビューの自動召喚も止める (ボードはそのまま)
  const boardSource = bridgeSource('board');
  for (const fn of ['async function requestApproval', 'async function requestReview']) {
    const start = boardSource.indexOf(fn);
    assert.ok(start > 0, `${fn} が無い`);
    const body = boardSource.slice(start, start + 1200);
    assert.match(body, /pauseStore\.paused/, `${fn} が pause 中でも召喚している`);
  }

  // **人間のメンション・handoff・自己呼び出しは止めない** — 入口は pause を見ない
  const messages = bridgeSource('messages');
  const inbox = messages.indexOf('async function onMessage');
  const inboxEnd = messages.indexOf('function stopNoticeFor');
  assert.ok(inbox > 0 && inboxEnd > inbox, 'onMessage を切り出せない');
  assert.equal(
    /pauseStore/.test(messages.slice(inbox, inboxEnd)),
    false,
    'pause が人間のメンションまで止めている',
  );
});

// ---- 着手 ----

test('approved を id 昇順に、同時上限の空き分だけ着手する', () => {
  const out = plan({ tasks: [task(3, 'approved'), task(1, 'approved'), task(2, 'approved')] });
  assert.deepEqual(out.actions, [
    { kind: 'start-task', taskId: '1' },
    { kind: 'start-task', taskId: '2' },
  ]);
  assert.equal(out.state.jobsToday, 2, '選んだ行動を job として数えていない');
});

test('同時上限は in-progress と review の合計で数える', () => {
  const busy = plan({ tasks: [task(1, 'in-progress'), task(2, 'review'), task(3, 'approved')] });
  assert.deepEqual(busy.actions, [], '同時上限を超えて着手している');

  const oneFree = plan({ tasks: [task(1, 'in-progress'), task(2, 'merged'), task(3, 'approved')] });
  assert.deepEqual(oneFree.actions, [{ kind: 'start-task', taskId: '3' }]);

  // 走っていない状態は空きを塞がない
  const idle = plan({
    tasks: [task(1, 'blocked'), task(2, 'dropped'), task(3, 'proposed'), task(4, 'approved')],
  });
  assert.deepEqual(idle.actions, [{ kind: 'start-task', taskId: '4' }]);
});

// ---- スカウト ----

test('スカウトは bot・間隔がそろったときに 1 つだけ', () => {
  // 一度も起こしていなければ最初の tick で起こす
  const first = plan({ state: initialState() });
  assert.deepEqual(first.actions, [{ kind: 'scout' }]);
  assert.equal(first.state.lastScoutAt, T0);

  assert.deepEqual(plan({ now: at(59) }).actions, [], '間隔前に起こしている');
  const due = plan({ now: at(60) });
  assert.deepEqual(due.actions, [{ kind: 'scout' }], 'ちょうど経過で起こしていない');
  assert.equal(due.state.lastScoutAt, at(60));

  // 担当が未設定なら起こさない (起票する相手が居ない)
  const noBot = plan({
    autonomy: autonomy({ scout: { bot: null, intervalMin: 60, maxOpenTasks: 6 } }),
    state: initialState(),
  });
  assert.deepEqual(noBot.actions, []);
});

test('未着手が溜まっていたらスカウトしない (承認待ちの山を作らない)', () => {
  const proposed = (n) => Array.from({ length: n }, (_, i) => task(i + 1, 'proposed'));
  assert.deepEqual(plan({ tasks: proposed(5), state: initialState() }).actions, [{ kind: 'scout' }]);
  assert.deepEqual(plan({ tasks: proposed(6), state: initialState() }).actions, [], '上限に達しても起票している');

  // approved も「未着手」として数える (着手待ちの列)
  const mixed = [...proposed(5), task(6, 'approved')];
  const out = plan({
    tasks: mixed,
    state: initialState(),
    autonomy: autonomy({ maxConcurrentTasks: 1 }),
  });
  assert.deepEqual(out.actions, [{ kind: 'start-task', taskId: '6' }], '未着手 6 件でスカウトしている');
});

// ---- 日次上限 ----

test('日次上限に達したら選ばない / 日付が変われば 0 から', () => {
  const tasks = [task(1, 'approved'), task(2, 'approved')];
  const a = autonomy({ maxJobsPerDay: 3, maxConcurrentTasks: 5 });
  const today = (jobsToday) => ({ ...initialState(), dayKey: dayKeyFor(T0), jobsToday });

  // 残り 1 なら着手 1 つで打ち止め (スカウトまで回らない)
  const tight = planTick({ tasks, autonomy: a, now: T0, state: today(2) });
  assert.deepEqual(tight.actions, [{ kind: 'start-task', taskId: '1' }]);
  assert.equal(tight.state.jobsToday, 3);

  const spent = planTick({ tasks, autonomy: a, now: T0, state: today(3) });
  assert.deepEqual(spent.actions, []);
  assert.equal(spent.state.jobsToday, 3, '上限を超えて数えている');

  // 翌日は繰り越さない
  const nextDay = T0 + DAY_MS;
  const rolled = planTick({ tasks, autonomy: a, now: nextDay, state: today(3) });
  assert.equal(rolled.state.dayKey, dayKeyFor(nextDay));
  assert.deepEqual(rolled.actions.map((x) => x.kind), ['start-task', 'start-task', 'scout']);
  assert.equal(rolled.state.jobsToday, 3);
});

test('dayKey は JST の暦日 (機械のタイムゾーンに依存しない)', () => {
  // T0 = 2026-08-27T00:00:00Z は JST では同じ日の 09:00
  assert.equal(dayKeyFor(T0), '2026-08-27');
  assert.equal(dayKeyFor(new Date(T0)), '2026-08-27');
  assert.equal(dayKeyFor(T0 + DAY_MS), '2026-08-28');
  // 日が変わるのは UTC 15:00 = JST 翌 00:00 ちょうど (UTC 暦日で切っていた頃との差)
  assert.equal(dayKeyFor(Date.parse('2026-08-27T14:59:59.999Z')), '2026-08-27');
  assert.equal(dayKeyFor(Date.parse('2026-08-27T15:00:00.000Z')), '2026-08-28');
});

// ---- バックオフ ----

test('失敗でバックオフが指数的に伸び、上限で頭打ちになる', () => {
  assert.equal(backoffDelayMs(0), BACKOFF_BASE_MS);
  assert.equal(backoffDelayMs(1), BACKOFF_BASE_MS * 2);
  assert.equal(backoffDelayMs(2), BACKOFF_BASE_MS * 4);
  assert.equal(backoffDelayMs(99), BACKOFF_MAX_MS, '上限を超えて伸びている');
  assert.equal(backoffDelayMs(-1), BACKOFF_BASE_MS);

  let state = recordFailure(initialState(), { now: T0 });
  assert.equal(state.backoffLevel, 1);
  assert.equal(state.backoffUntil, T0 + BACKOFF_BASE_MS);

  state = recordFailure(state, { now: T0 });
  assert.equal(state.backoffUntil, T0 + BACKOFF_BASE_MS * 2);

  for (let i = 0; i < 20; i += 1) state = recordFailure(state, { now: T0 });
  assert.equal(state.backoffUntil, T0 + BACKOFF_MAX_MS);
});

test('parseLimitReset: resets <時刻> (<tz>) を now から前後 12h で最も近いその時刻と読み、過ぎていれば null', () => {
  // T0 = 2026-08-27 09:00 (Asia/Tokyo)
  const iso = (text, now = T0) => {
    const ms = parseLimitReset(text, now);
    return ms === null ? null : new Date(ms).toISOString();
  };
  assert.equal(iso("You've hit your session limit · resets 1:30pm (Asia/Tokyo)"), '2026-08-27T04:30:00.000Z');
  assert.equal(iso('resets 2pm (Asia/Tokyo)'), '2026-08-27T05:00:00.000Z', '分の無い形');
  assert.equal(iso('Resets 2:05 PM (asia/tokyo)'), '2026-08-27T05:05:00.000Z', '大文字・空白入り');
  assert.equal(iso('resets 12pm (Asia/Tokyo)'), '2026-08-27T03:00:00.000Z', '12pm は正午');
  // 22:00 JST から読む (T0 の 09:00 からだと 9h 前の方が近い)
  assert.equal(iso('resets 12am (Asia/Tokyo)', Date.parse('2026-08-27T13:00:00Z')), '2026-08-27T15:00:00.000Z', '12am は深夜 0 時');
  assert.equal(iso('failed(limit · resets 1:30pm (Asia/Tokyo))'), '2026-08-27T04:30:00.000Z', '後ろに括弧が続いても tz だけを読む');

  // 日またぎ: 23:00 JST に resets 1am は翌日の 1:00
  assert.equal(iso('resets 1am (Asia/Tokyo)', Date.parse('2026-08-27T14:00:00Z')), '2026-08-27T16:00:00.000Z');
  assert.equal(iso('resets 1:30pm (Asia/Tokyo)', Date.parse('2026-08-27T04:29:59Z')), '2026-08-27T04:30:00.000Z');
  // 明けた直後にもう一度落ちた (ちょうど・数秒過ぎ・分の途中) は null — 翌日と読むと約 24h 止まる
  for (const now of ['2026-08-27T04:30:00Z', '2026-08-27T04:30:15Z', '2026-08-27T04:30:59Z']) {
    assert.equal(iso('resets 1:30pm (Asia/Tokyo)', Date.parse(now)), null, now);
  }
  // 前後 12h の境: 11h59m 先は読み、12h01m 先は (12h 前の方が近いので) null。ちょうど 12h なら後の方
  assert.equal(iso('resets 1:30pm (Asia/Tokyo)', Date.parse('2026-08-27T16:31:00Z')), '2026-08-28T04:30:00.000Z');
  assert.equal(iso('resets 1:30pm (Asia/Tokyo)', Date.parse('2026-08-27T16:29:00Z')), null);
  assert.equal(iso('resets 1:30pm (Asia/Tokyo)', Date.parse('2026-08-27T16:30:00Z')), '2026-08-28T04:30:00.000Z');

  // tz 違い: 06:00Z は東京では 15:00 で 1:30pm を過ぎているが、New York (02:00)・London (07:00)・UTC ではこれから
  const morning = Date.parse('2026-08-27T06:00:00Z');
  assert.equal(iso('resets 1:30pm (Asia/Tokyo)', morning), null);
  assert.equal(iso('resets 1:30pm (America/New_York)', morning), '2026-08-27T17:30:00.000Z');
  assert.equal(iso('resets 1:30pm (Europe/London)', morning), '2026-08-27T12:30:00.000Z');
  assert.equal(iso('resets 1:30pm (UTC)', morning), '2026-08-27T13:30:00.000Z');
  // 翌日は暦日で組む — 夏時間が明ける夜 (2026-10-31 23:00 EDT) に、翌朝の 3am を +24h で組むと 1 時間早い 2am になる
  assert.equal(
    iso('resets 3am (America/New_York)', Date.parse('2026-11-01T03:00:00Z')),
    '2026-11-01T08:00:00.000Z',
  );

  // 読めない形は null (従来の倍々に任せる)
  for (const text of [
    'resets Oct 8, 1:30pm (Asia/Tokyo)', // 日付付き
    'resets 1:30pm', // tz 無し
    'resets 1:30pm (Mars/Olympus_Mons)', // 解決できない tz
    'resets 1:30pm (Asia/Tok', // 切り詰めで閉じ括弧が落ちた
    'resets 13pm (Asia/Tokyo)',
    'resets 0am (Asia/Tokyo)',
    'resets 1:75pm (Asia/Tokyo)',
    'resets 13:30 (Asia/Tokyo)', // 24 時間表記
    'rate limit',
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseLimitReset(text, T0), null, String(text));
  }
  assert.throws(() => parseLimitReset('resets 1pm (Asia/Tokyo)', undefined), /now/);
});

test('recordFailure: 上限の明け時刻 (until) があれば倍々との遅い方まで待ち、上限で切らない', () => {
  const HOUR = 60 * 60 * 1000;
  let state = recordFailure(initialState(), { now: T0, until: T0 + HOUR });
  assert.equal(state.backoffUntil, T0 + HOUR);
  assert.equal(state.backoffLevel, 1, '肩の進め方が変わっている');

  // 倍々の方が遅ければそちら
  state = recordFailure(state, { now: T0, until: T0 + 60_000 });
  assert.equal(state.backoffUntil, T0 + BACKOFF_BASE_MS * 2);
  assert.equal(state.backoffLevel, 2);

  // BACKOFF_MAX_MS より先でも切らない (切ると明ける前に起こして、もう 1 回落ちる)
  const far = T0 + BACKOFF_MAX_MS + 3 * HOUR;
  assert.equal(recordFailure(initialState(), { now: T0, until: far }).backoffUntil, far);

  // 数でない until は無いのと同じ
  for (const until of [null, undefined, Number.NaN, Infinity, '1800000', new Date(T0 + HOUR)]) {
    assert.equal(
      recordFailure(initialState(), { now: T0, until }).backoffUntil,
      T0 + BACKOFF_BASE_MS,
      String(until),
    );
  }
});

test('バックオフ中は何もせず、明ける時刻ちょうどで再開する', () => {
  const tasks = [task(1, 'approved')];
  const state = recordFailure({ ...initialState(), dayKey: dayKeyFor(T0) }, { now: T0 });

  assert.deepEqual(plan({ tasks, now: T0 + 1, state }).actions, [], 'バックオフ中に動いている');
  assert.deepEqual(
    plan({ tasks, now: state.backoffUntil, state }).actions.map((x) => x.kind),
    ['start-task', 'scout'],
    '明ける時刻ちょうどで再開していない',
  );
});

test('成功でバックオフは肩ごと戻る (復旧後も止まり続けない)', () => {
  const failed = recordFailure(recordFailure(initialState(), { now: T0 }), { now: T0 });
  const cleared = recordSuccess(failed);
  assert.equal(cleared.backoffUntil, 0);
  assert.equal(cleared.backoffLevel, 0);
  assert.equal(
    recordFailure(cleared, { now: T0 }).backoffUntil,
    T0 + BACKOFF_BASE_MS,
    '成功後の失敗が前回の長さを引きずっている',
  );
});

// ---- state の扱い ----

test('渡した state を書き換えず、壊れた state は初期値へ倒す', () => {
  const state = Object.freeze({ ...initialState(), dayKey: dayKeyFor(T0) });
  const out = plan({ tasks: [task(1, 'approved')], state });
  assert.equal(state.jobsToday, 0, '渡した state を書き換えている');
  assert.equal(out.state.jobsToday, 2);

  const broken = planTick({
    tasks: [],
    autonomy: AUTONOMY,
    now: T0,
    state: { jobsToday: -3, dayKey: 42, backoffUntil: 'soon', lastScoutAt: NaN },
  });
  assert.deepEqual(broken.actions, [{ kind: 'scout' }]);
  assert.equal(broken.state.jobsToday, 1);
  assert.equal(broken.state.dayKey, dayKeyFor(T0));
  assert.equal(broken.state.backoffUntil, 0);
});

test('now は必ず注入する (時計を内部で読まない設計を破らない)', () => {
  assert.throws(() => planTick({ autonomy: AUTONOMY, state: initialState() }), /now/);
  assert.throws(() => planTick({ autonomy: AUTONOMY, now: 'いま', state: initialState() }), /now/);
  assert.throws(() => recordFailure(initialState(), {}), /now/);
});

// ---- 組み込み側との噛み合わせ ----

test('resolveAutonomy の戻りをそのまま食える', () => {
  const resolved = resolveAutonomy({
    autonomy: {
      enabled: true,
      scout: { bot: 'opus' },
      worker: { bots: ['opus'] },
      reviewer: 'fable',
    },
  });
  const out = planTick({
    tasks: [task(1, 'approved'), task(2, 'approved'), task(3, 'approved')],
    autonomy: resolved,
    now: T0,
    state: initialState(),
  });
  // 同時上限の既定は 2
  assert.deepEqual(out.actions, [
    { kind: 'start-task', taskId: '1' },
    { kind: 'start-task', taskId: '2' },
    { kind: 'scout' },
  ]);
  assert.ok(out.actions.every((x) => ACTION_KINDS.includes(x.kind)), '知らない種類の行動を出している');
});

// ---- 行動の適用判断 (M0-5) ----

const START = { kind: 'start-task', taskId: '1' };
const APPROVED = [{ id: '1', state: 'approved', title: 'A' }];

test('resolveStartTask: 起動する担当と、起動メッセージを投げる担当を決める', () => {
  const out = resolveStartTask(START, {
    tasks: APPROVED,
    autonomy: AUTONOMY,
    availableBotKeys: ['fable', 'opus', 'sol'],
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.workerKey, 'opus', 'worker.bots の先頭を採っていない');
  assert.equal(out.announcerKey, 'fable', '投稿は既定で reviewer');
  assert.equal(out.task.id, '1');
});

test('resolveStartTask: 起動している担当だけを採る', () => {
  // 先頭が落ちていれば次の worker へ (落ちた bot 1 体で社会を止めない)
  const fallback = resolveStartTask(START, {
    tasks: APPROVED,
    autonomy: autonomy({ worker: { bots: ['opus', 'sol'] } }),
    availableBotKeys: ['fable', 'sol'],
  });
  assert.equal(fallback.workerKey, 'sol');

  // worker が誰も居ない
  const noWorker = resolveStartTask(START, {
    tasks: APPROVED,
    autonomy: AUTONOMY,
    availableBotKeys: ['fable'],
  });
  assert.equal(noWorker.ok, false);
  assert.match(noWorker.reason, /worker が起動していません/);
});

test('resolveStartTask: 投げ手は必ず worker 以外 (自分の発言では job が立たない)', () => {
  // reviewer が worker と同じなら別の bot が投げる
  const other = resolveStartTask(START, {
    tasks: APPROVED,
    autonomy: autonomy({ reviewer: 'opus' }),
    availableBotKeys: ['opus', 'sol'],
  });
  assert.equal(other.workerKey, 'opus');
  assert.equal(other.announcerKey, 'sol');

  // 起動しているのが worker だけなら着手できない
  const alone = resolveStartTask(START, {
    tasks: APPROVED,
    autonomy: AUTONOMY,
    availableBotKeys: ['opus'],
  });
  assert.equal(alone.ok, false);
  assert.match(alone.reason, /別の bot が居ません/);
});

test('resolveStartTask: ボードと食い違う行動は Discord を触る前に落とす', () => {
  const cases = [
    [{ kind: 'scout' }, APPROVED, /適用できない行動/],
    [START, [], /タスク 1 がボードにありません/],
    [START, [{ id: '1', state: 'in-progress' }], /in-progress なので着手できません/],
    [START, [{ id: '1', state: 'blocked' }], /blocked なので着手できません/],
  ];
  for (const [action, tasks, pattern] of cases) {
    const out = resolveStartTask(action, {
      tasks, autonomy: AUTONOMY, availableBotKeys: ['fable', 'opus'],
    });
    assert.equal(out.ok, false, JSON.stringify(action));
    assert.match(out.reason, pattern);
  }
  assert.equal(resolveStartTask().ok, false, '行動なしで落ちている');
});

// ---- スカウトの適用 (M0-5b) ----

const SCOUT = { kind: 'scout' };

test('resolveScout: スカウト担当と、起動メッセージを投げる担当を決める', () => {
  const out = resolveScout(SCOUT, { autonomy: AUTONOMY, availableBotKeys: ['fable', 'opus', 'sol'] });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.scoutKey, 'opus');
  assert.equal(out.announcerKey, 'fable', '投稿は既定で reviewer');
});

test('resolveScout: 担当か投げ手が居なければ適用しない', () => {
  const noBot = resolveScout(SCOUT, {
    autonomy: autonomy({ scout: { bot: null, intervalMin: 60, maxOpenTasks: 6 } }),
    availableBotKeys: ['fable', 'opus'],
  });
  assert.equal(noBot.ok, false);
  assert.match(noBot.reason, /スカウト担当が起動していません/);

  const down = resolveScout(SCOUT, { autonomy: AUTONOMY, availableBotKeys: ['fable', 'sol'] });
  assert.equal(down.ok, false, '起動していない担当で巡回しようとしている');

  const alone = resolveScout(SCOUT, { autonomy: AUTONOMY, availableBotKeys: ['opus'] });
  assert.equal(alone.ok, false);
  assert.match(alone.reason, /別の bot が居ません/);

  assert.equal(resolveScout({ kind: 'start-task' }, { autonomy: AUTONOMY, availableBotKeys: ['fable', 'opus'] }).ok, false);
  assert.equal(resolveScout().ok, false);
});

test('スカウトの job 予算は小さい固定値 (無人スレッドを門番なしにしない)', () => {
  assert.equal(Number.isSafeInteger(SCOUT_JOB_BUDGET), true);
  assert.ok(SCOUT_JOB_BUDGET > 0, '0 だと予算切れで起動直後に止まる');
  assert.ok(SCOUT_JOB_BUDGET < AUTONOMY.taskJobBudget, '実装タスクと同じだけ配っている');
});

test('proposedTasks: 起票をボードへ渡す形にし、job 予算を頭打ちにする', () => {
  const contract = {
    body: 'x',
    tasks: [
      { title: 'A', rationale: 'ra', touch: ['src/a.ts'] },
      { title: 'B', rationale: 'rb', touch: ['src/b.ts', 'src/style.css'], job_budget: 5 },
      { title: 'C', rationale: 'rc', touch: ['src/c.ts'], job_budget: 999 },
    ],
  };
  assert.deepEqual(proposedTasks(contract, { channel: 'observatory', taskJobBudget: 20 }), [
    { channel: 'observatory', title: 'A', rationale: 'ra', jobBudget: 20, touch: ['src/a.ts'] },
    {
      channel: 'observatory', title: 'B', rationale: 'rb', jobBudget: 5,
      touch: ['src/b.ts', 'src/style.css'],
    },
    { channel: 'observatory', title: 'C', rationale: 'rc', jobBudget: 20, touch: ['src/c.ts'] },
  ]);

  // touch の正規形はボード側 (requiredTouch) の担当。ここは渡すだけで、
  // 書いていない起票は空配列のまま board.propose が断る (fail-closed)
  assert.deepEqual(
    proposedTasks({ tasks: [{ title: 'A', rationale: 'ra' }] }, { channel: 'c' })[0].touch,
    [],
  );

  // 0 件・壊れた入力でも落ちない
  assert.deepEqual(proposedTasks({ body: 'x', tasks: [] }, { channel: 'c' }), []);
  assert.deepEqual(proposedTasks(null, { channel: 'c' }), []);
  assert.deepEqual(proposedTasks({ tasks: 'なし' }, { channel: 'c' }), []);
  // taskJobBudget が壊れていれば設定の既定へ倒す (無制限にしない)
  assert.equal(
    proposedTasks(contract, { channel: 'c', taskJobBudget: 0 })[0].jobBudget,
    DEFAULT_TASK_JOB_BUDGET,
  );
});

test('proposedTasks: job 予算に下限を敷く (worker 1 + review 1 + 予備 2 — §9.2b)', () => {
  const one = (over) => ({
    body: 'x', tasks: [{ title: 'A', rationale: 'ra', touch: ['src/a.ts'], ...over }],
  });
  const budget = (contract, taskJobBudget) => proposedTasks(
    contract, { channel: 'kumamikan-tools', taskJobBudget },
  )[0].jobBudget;

  assert.equal(MIN_TASK_JOB_BUDGET, 4);
  // #51 の実例 — 3 ファイル新規で自己申告 2 (worker 1 + review 1 = 予備 0)
  assert.equal(budget(one({ job_budget: 2 }), 20), 4);
  assert.equal(budget(one({}), 20), 20, '申告が無ければ cap のまま');
  assert.equal(budget(one({ job_budget: 30 }), 20), 20, 'cap を超えさせない');
  // 下限は上限より弱い — cap を小さくしたチャンネルで、下限が黙って上限を押し上げない
  assert.equal(budget(one({ job_budget: 2 }), 3), 3);
});

test('planFiling の枠は planTick がスカウトを起こす条件と同じ定義 (§9.2a)', () => {
  // 枠の定義が 2 か所でずれると「起こしたのに 1 件も載らない」巡回ができる。
  // 実体は src/board.js 側にあるので、ここで planTick と突き合わせて固定する
  const maxOpenTasks = 3;
  for (const open of [0, 1, 2, 3, 4]) {
    const tasks = [
      ...Array.from({ length: open }, (_, i) => task(100 + i, 'proposed')),
      // 着手済み (と blocked) はどちらの数え方でも open ではない
      task(1, 'in-progress'), task(2, 'review'), task(3, 'blocked'),
    ];
    const woke = planTick({
      tasks,
      autonomy: autonomy({ scout: { ...AUTONOMY.scout, maxOpenTasks } }),
      now: T0,
      state: initialState(),
    }).actions.some((action) => action.kind === 'scout');
    const filed = planFiling({
      wanted: [{ title: 'A', touch: ['tools/a.py'] }],
      openTasks: tasks.map((t) => ({ ...t, touch: [`tools/${t.id}.py`] })),
      maxOpenTasks,
    }).file.length;
    assert.equal(woke, filed > 0, `open=${open} でスカウトの判定と起票の枠がずれている`);
  }
});

// ---- 発議の巡回 (§3.9 の第 3 action) ----

/** duty を持つ bot (resolveDutyBots の戻りと同じ形) */
const dutyBot = (botKey, over = {}) => ({
  botKey,
  initiativeBudget: 1,
  duties: [{ key: 'audit', intervalMin: 60, maxOpenProposals: 2, eventKinds: [] }],
  ...over,
});

/** スカウト担当を外した設定 (発議だけを見たいとき — 時計を進めると巡回も due になる) */
const noScout = autonomy({ scout: { ...AUTONOMY.scout, bot: null } });

test('planTick: duty が期限を迎えていれば initiative を 1 つだけ選ぶ', () => {
  const out = plan({ dutyBots: [dutyBot('sol'), dutyBot('fable')] });
  assert.deepEqual(out.actions, [{ kind: 'initiative', botKey: 'fable', duty: 'audit' }]);
  // 勘定は「最終実行」と「今日の消費」の両方が動く
  assert.equal(out.state.initiative.lastRunAt['fable/audit'], T0);
  assert.equal(out.state.initiative.spentToday.fable, 1);
  assert.equal(out.state.initiative.lastRunAt['sol/audit'], undefined);
  assert.equal(out.state.jobsToday, 1);
});

test('planTick: 発議機構が無効なら dutyBots は空で渡る = 何も選ばない', () => {
  assert.deepEqual(plan({ dutyBots: [] }).actions, []);
  assert.deepEqual(plan().actions, []); // 省略時も同じ
});

test('planTick: 間隔が明けていない duty は回さない (境目ちょうどは通す)', () => {
  const state = { ...scouted(), initiative: { lastRunAt: { 'sol/audit': T0 }, spentToday: {} } };
  const bots = [dutyBot('sol')];
  assert.deepEqual(plan({ autonomy: noScout, dutyBots: bots, state, now: at(59) }).actions, []);
  assert.deepEqual(
    plan({ autonomy: noScout, dutyBots: bots, state, now: at(60) }).actions,
    [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }],
  );
});

test('planTick: 最終実行がいちばん古い duty から回す (先頭の bot が予算を独占しない)', () => {
  const state = {
    ...scouted(),
    initiative: { lastRunAt: { 'fable/audit': at(-10), 'sol/audit': at(-120) }, spentToday: {} },
  };
  const out = plan({ dutyBots: [dutyBot('fable'), dutyBot('sol')], state, now: at(0) });
  assert.deepEqual(out.actions, [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }]);
});

test('planTick: bot ごとの initiativeBudget を超えない', () => {
  const state = { ...scouted(), initiative: { lastRunAt: {}, spentToday: { sol: 2 } } };
  assert.deepEqual(plan({ dutyBots: [dutyBot('sol', { initiativeBudget: 2 })], state }).actions, []);
  assert.deepEqual(
    plan({ dutyBots: [dutyBot('sol', { initiativeBudget: 3 })], state }).actions,
    [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }],
  );
});

test('planTick: 裁定待ちが maxOpenProposals に達している duty は回さない', () => {
  const open = (id) => ({ id, ownerBotKey: 'sol', input: { duty: 'audit' } });
  const bots = [dutyBot('sol', { duties: [{ key: 'audit', intervalMin: 60, maxOpenProposals: 2 }] })];
  assert.deepEqual(plan({ dutyBots: bots, proposals: [open('1'), open('2')] }).actions, []);
  assert.deepEqual(
    plan({ dutyBots: bots, proposals: [open('1')] }).actions,
    [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }],
  );
  // 数えるのは追跡責任者 (ownerBotKey) と duty が一致するものだけ
  const others = [{ id: '1', ownerBotKey: 'fable', input: { duty: 'audit' } },
    { id: '2', ownerBotKey: 'sol', input: { duty: 'review' } }];
  assert.equal(plan({ dutyBots: bots, proposals: others }).actions.length, 1);
});

test('planTick: 優先順位は start-task > scout > initiative (日次上限を分け合う)', () => {
  const state = { ...initialState(), dayKey: dayKeyFor(T0), jobsToday: 39 };
  // 残り 1 job。着手できるタスクがあるなら発議は選ばれない
  const out = plan({
    tasks: [task(1, 'approved')], dutyBots: [dutyBot('sol')], state,
  });
  assert.deepEqual(out.actions, [{ kind: 'start-task', taskId: '1' }]);
  assert.equal(out.state.initiative.spentToday.sol, undefined);

  // 残り 1 job で着手も巡回も無ければ、そこで初めて発議が入る
  assert.deepEqual(
    plan({ dutyBots: [dutyBot('sol')], state: { ...state, lastScoutAt: T0 } }).actions,
    [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }],
  );
  // 使い切っていれば何も選ばない
  assert.deepEqual(
    plan({ dutyBots: [dutyBot('sol')], state: { ...state, jobsToday: 40, lastScoutAt: T0 } }).actions,
    [],
  );
});

test('planTick: 日が変わると spentToday だけ消え、lastRunAt は残る', () => {
  const state = {
    ...scouted(),
    initiative: { lastRunAt: { 'sol/audit': T0 }, spentToday: { sol: 1 } },
  };
  // 翌日・間隔も明けている
  const out = plan({ autonomy: noScout, dutyBots: [dutyBot('sol')], state, now: T0 + DAY_MS });
  assert.deepEqual(out.actions, [{ kind: 'initiative', botKey: 'sol', duty: 'audit' }]);
  assert.equal(out.state.initiative.spentToday.sol, 1); // 今日の 1 本目
  assert.equal(out.state.initiative.lastRunAt['sol/audit'], T0 + DAY_MS);
});

// ---- ハーネスの改訂の巡回 (src/harness.js) ----

const withHarness = autonomy({ harness: { bot: 'fable', intervalMin: 24 * 60, minRuns: 20 } });
const OPEN_GATE = Object.freeze({ due: true });

test('planTick: ハーネスの改訂は門が開き、間隔が明け、役割文の改訂が残っていないときだけ選ぶ', () => {
  const first = plan({ autonomy: withHarness, harness: OPEN_GATE });
  assert.deepEqual(first.actions, [{ kind: 'harness' }]);
  assert.equal(first.state.lastHarnessAt, T0);
  assert.equal(first.state.jobsToday, 1);

  // 門が閉じている (測り終えていない) / 門の材料が無い
  assert.deepEqual(plan({ autonomy: withHarness, harness: { due: false } }).actions, []);
  assert.deepEqual(plan({ autonomy: withHarness, harness: null }).actions, []);
  // 提案役が居ない
  assert.deepEqual(plan({ harness: OPEN_GATE }).actions, []);
  // 間隔が明けていない → 明けたら選ぶ
  const recent = scouted({ lastHarnessAt: T0 - 60 * 60_000 });
  assert.deepEqual(plan({ autonomy: withHarness, harness: OPEN_GATE, state: recent }).actions, []);
  assert.deepEqual(
    plan({ autonomy: withHarness, harness: OPEN_GATE, state: recent, now: T0 + DAY_MS }).actions.map((a) => a.kind),
    ['scout', 'harness'],
  );
  // 役割文を触るタスクが終わっていない (blocked も) → 重ねない。終端なら起こす
  for (const state of ['proposed', 'approved', 'in-progress', 'review', 'blocked']) {
    const tasks = [{ id: '9', state, touch: ['roles/worker.md'] }];
    const out = plan({ autonomy: { ...withHarness, maxConcurrentTasks: 0 }, harness: OPEN_GATE, tasks });
    assert.equal(out.actions.some((a) => a.kind === 'harness'), false, `${state} の改訂に重ねている`);
  }
  for (const state of ['merged', 'dropped']) {
    const tasks = [{ id: '9', state, touch: ['roles/worker.md'] }];
    assert.deepEqual(plan({ autonomy: withHarness, harness: OPEN_GATE, tasks }).actions, [{ kind: 'harness' }], state);
  }
});

test('planTick: 優先順位は start-task > scout > harness > initiative', () => {
  const out = plan({
    autonomy: withHarness, harness: OPEN_GATE, tasks: [task(1, 'approved')], dutyBots: [dutyBot('sol')],
    state: { ...initialState(), dayKey: dayKeyFor(T0) },
  });
  assert.deepEqual(out.actions.map((a) => a.kind), ['start-task', 'scout', 'harness', 'initiative']);
  // 残り 1 job なら着手が先
  const tight = plan({
    autonomy: withHarness, harness: OPEN_GATE, tasks: [task(1, 'approved')],
    state: { ...initialState(), dayKey: dayKeyFor(T0), jobsToday: 39 },
  });
  assert.deepEqual(tight.actions, [{ kind: 'start-task', taskId: '1' }]);
  assert.equal(tight.state.lastHarnessAt, 0, '起こしていない改訂で時計が進んでいる');
});

test('touchesHarness / resolveHarness', () => {
  assert.equal(touchesHarness({ touch: ['roles/_common.md'] }), true);
  assert.equal(touchesHarness({ touch: ['src/roles.js'] }), false);
  assert.deepEqual(resolveHarness({ kind: 'harness' }, { autonomy: withHarness, availableBotKeys: ['fable', 'opus'] }), {
    ok: true, botKey: 'fable', announcerKey: 'opus',
  });
  assert.match(resolveHarness({ kind: 'harness' }, { autonomy: withHarness, availableBotKeys: ['opus'] }).reason, /提案役が起動していません/);
  assert.match(resolveHarness({ kind: 'harness' }, { autonomy: withHarness, availableBotKeys: ['fable'] }).reason, /別の bot が居ません/);
  assert.equal(resolveHarness({ kind: 'scout' }, { autonomy: withHarness, availableBotKeys: ['fable', 'opus'] }).ok, false);
});

// ---- 企画の巡回 (src/themes.js) ----

const withPlanner = autonomy({ planner: { bot: 'fable', intervalMin: 24 * 60, maxThemes: 2, themesFile: 'docs/themes.md' } });

test('planTick: 企画の巡回は門が開き、間隔が明け、主題ファイルを触るタスクが終わっているときだけ選ぶ', () => {
  const first = plan({ autonomy: withPlanner, plan: OPEN_GATE });
  assert.deepEqual(first.actions, [{ kind: 'plan' }]);
  assert.equal(first.state.lastPlanAt, T0);
  assert.equal(first.state.jobsToday, 1);

  // 門が閉じている (主題ファイルを読めない) / 門の材料が無い / 企画役が居ない
  assert.deepEqual(plan({ autonomy: withPlanner, plan: { due: false } }).actions, []);
  assert.deepEqual(plan({ autonomy: withPlanner, plan: null }).actions, []);
  assert.deepEqual(plan({ plan: OPEN_GATE }).actions, []);
  // 間隔が明けていない → 明けたら選ぶ
  const recent = scouted({ lastPlanAt: T0 - 60 * 60_000 });
  assert.deepEqual(plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent }).actions, []);
  assert.deepEqual(
    plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent, now: T0 + DAY_MS }).actions.map((a) => a.kind),
    ['scout', 'plan'],
  );
  // 主題ファイルを触るタスクが終わっていない → 重ねない (区切りが \ でも同じファイル)。終端なら起こす
  for (const state of ['proposed', 'approved', 'in-progress', 'review', 'blocked']) {
    for (const path of ['docs/themes.md', 'docs\\themes.md', './docs/themes.md']) {
      const tasks = [{ id: '9', state, touch: [path] }];
      const out = plan({ autonomy: { ...withPlanner, maxConcurrentTasks: 0 }, plan: OPEN_GATE, tasks });
      assert.equal(out.actions.some((a) => a.kind === 'plan'), false, `${state} / ${path} の主題に重ねている`);
    }
  }
  for (const state of ['merged', 'dropped']) {
    const tasks = [{ id: '9', state, touch: ['docs/themes.md'] }];
    assert.deepEqual(plan({ autonomy: withPlanner, plan: OPEN_GATE, tasks }).actions, [{ kind: 'plan' }], state);
  }
  // 別のファイルを触るタスクは関係ない (主題を進めるタスクが走っていても次を考えてよい)
  const working = [{ id: '9', state: 'in-progress', touch: ['src/a.js', 'docs/themes-old.md'] }];
  assert.deepEqual(plan({ autonomy: withPlanner, plan: OPEN_GATE, tasks: working }).actions, [{ kind: 'plan' }]);
});

test('planTick: 優先順位は start-task > scout > harness > plan > initiative', () => {
  const both = autonomy({ harness: withHarness.harness, planner: withPlanner.planner });
  const out = plan({
    autonomy: both, harness: OPEN_GATE, plan: OPEN_GATE, tasks: [task(1, 'approved')], dutyBots: [dutyBot('sol')],
    state: { ...initialState(), dayKey: dayKeyFor(T0) },
  });
  assert.deepEqual(out.actions.map((a) => a.kind), ['start-task', 'scout', 'harness', 'plan', 'initiative']);
  // 残り 2 job なら着手とスカウトが先で、企画の時計は進めない
  const tight = plan({
    autonomy: both, harness: OPEN_GATE, plan: OPEN_GATE, tasks: [task(1, 'approved')],
    state: { ...initialState(), dayKey: dayKeyFor(T0), jobsToday: 38 },
  });
  assert.deepEqual(tight.actions.map((a) => a.kind), ['start-task', 'scout']);
  assert.equal(tight.state.lastPlanAt, 0, '起こしていない巡回で時計が進んでいる');
});

test('touchesThemes / resolvePlan', () => {
  assert.equal(touchesThemes({ touch: ['docs/themes.md'] }, 'docs/themes.md'), true);
  assert.equal(touchesThemes({ touch: ['docs/direction.md'] }, 'docs/themes.md'), false);
  assert.equal(touchesThemes({ touch: ['docs/themes.md'] }, ''), false, '主題ファイルが無ければ何も触らない');
  assert.equal(touchesThemes({}, 'docs/themes.md'), false);
  assert.deepEqual(resolvePlan({ kind: 'plan' }, { autonomy: withPlanner, availableBotKeys: ['fable', 'opus'] }), {
    ok: true, botKey: 'fable', announcerKey: 'opus',
  });
  assert.match(resolvePlan({ kind: 'plan' }, { autonomy: withPlanner, availableBotKeys: ['opus'] }).reason, /企画役が起動していません/);
  assert.match(resolvePlan({ kind: 'plan' }, { autonomy: withPlanner, availableBotKeys: ['fable'] }).reason, /別の bot が居ません/);
  assert.equal(resolvePlan({ kind: 'harness' }, { autonomy: withPlanner, availableBotKeys: ['fable', 'opus'] }).ok, false);
});

test('chargeInitiative: イベント経由も同じ財布から出す', () => {
  const base = { ...scouted(), initiative: { lastRunAt: {}, spentToday: {} } };
  const ok = chargeInitiative(base, { botKey: 'sol', duty: 'audit', budget: 1, now: T0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.state.jobsToday, 1);
  assert.equal(ok.state.initiative.spentToday.sol, 1);
  // イベントで回ったぶん、定期巡回の時計も進む (すぐ重ならない)
  assert.equal(ok.state.initiative.lastRunAt['sol/audit'], T0);

  const again = chargeInitiative(ok.state, { botKey: 'sol', duty: 'audit', budget: 1, now: T0 });
  assert.equal(again.ok, false);
  assert.match(again.reason, /日次発議上限/);
  assert.equal(again.state.jobsToday, 1, '断ったのに勘定が動いている');

  const capped = chargeInitiative({ ...base, jobsToday: 40 }, {
    botKey: 'sol', duty: 'audit', maxJobsPerDay: 40, now: T0,
  });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /日次上限/);

  assert.equal(chargeInitiative(base, { botKey: '', duty: 'audit', now: T0 }).ok, false);
  assert.equal(chargeInitiative(base, { botKey: 'sol', duty: '', now: T0 }).ok, false);
});

test('dutiesForEvent: 宣言した duty にだけ配り、当事者と不在の bot は外す', () => {
  const bots = [
    dutyBot('sol', { duties: [{ key: 'audit', eventKinds: ['block', 'send-back'] }] }),
    dutyBot('fable', { duties: [{ key: 'ops', eventKinds: ['backoff'] }] }),
    dutyBot('opus', { duties: [{ key: 'impl', eventKinds: [] }] }),
  ];
  const available = ['sol', 'fable', 'opus'];
  assert.deepEqual(dutiesForEvent('block', { dutyBots: bots, availableBotKeys: available }),
    [{ botKey: 'sol', duty: 'audit' }]);
  assert.deepEqual(dutiesForEvent('backoff', { dutyBots: bots, availableBotKeys: available }),
    [{ botKey: 'fable', duty: 'ops' }]);
  // 当事者は外す / 起動していない bot も外す
  assert.deepEqual(
    dutiesForEvent('block', { dutyBots: bots, availableBotKeys: available, excludeBotKeys: ['sol'] }),
    [],
  );
  assert.deepEqual(dutiesForEvent('block', { dutyBots: bots, availableBotKeys: ['fable'] }), []);
  // 知らないイベントには誰も反応しない
  assert.deepEqual(dutiesForEvent('知らない', { dutyBots: bots, availableBotKeys: available }), []);
  assert.deepEqual(dutiesForEvent('block'), []);

  // 同じ bot が同じイベントを拾う duty を 2 つ持っていても job は 1 本
  const twice = [dutyBot('sol', {
    duties: [{ key: 'a', eventKinds: ['block'] }, { key: 'b', eventKinds: ['block'] }],
  })];
  assert.deepEqual(dutiesForEvent('block', { dutyBots: twice, availableBotKeys: ['sol'] }),
    [{ botKey: 'sol', duty: 'a' }]);
});

test('resolveInitiative: 担当が起動していて、別の bot が投げ手になれるときだけ通る', () => {
  const action = { kind: 'initiative', botKey: 'sol', duty: 'audit' };
  const out = resolveInitiative(action, { autonomy: AUTONOMY, availableBotKeys: ['sol', 'fable'] });
  assert.deepEqual(out, { ok: true, botKey: 'sol', duty: 'audit', announcerKey: 'fable' });

  assert.match(resolveInitiative(action, { availableBotKeys: ['fable'] }).reason, /起動していません/);
  // 自分しか居なければ投げ手が居ない (自分の多行発言は捨てられる)
  assert.match(
    resolveInitiative(action, { autonomy: AUTONOMY, availableBotKeys: ['sol'] }).reason,
    /投げられる別の bot/,
  );
  assert.match(resolveInitiative({ kind: 'scout' }, {}).reason, /適用できない行動/);
  assert.match(
    resolveInitiative({ kind: 'initiative', botKey: 'sol' }, { availableBotKeys: ['sol'] }).reason,
    /botKey \/ duty がありません/,
  );
  assert.ok(INITIATIVE_JOB_BUDGET > 0);
});

test('発議の目印は job 単位で付く (通常のタスクスレッドへ出た裁定依頼も見分ける)', () => {
  assert.equal(formatInitiativeTag('巡回'), '`発議:巡回`');
  assert.equal(formatInitiativeTag('裁定'), '`発議:裁定`');
  assert.equal(formatInitiativeTag('てきとう'), '');
  assert.equal(formatInitiativeTag(undefined), '');

  assert.equal(isInitiativeTrigger(`<@1>\n## 裁定の依頼 ${formatInitiativeTag('裁定')}`), true);
  assert.equal(isInitiativeTrigger(`## 発議の巡回 ${formatInitiativeTag('巡回')}`), true);
  // 通常のタスク起動文には付かない = 従来どおりバックオフの証拠に数える
  assert.equal(isInitiativeTrigger('<@1>\n## タスク 31: 滞在時間を出す'), false);
  assert.equal(isInitiativeTrigger('`発議:てきとう`'), false);
  assert.equal(isInitiativeTrigger('発議:裁定'), false, 'コードスパンでない文字列を拾っている');
  assert.equal(isInitiativeTrigger(''), false);
  assert.equal(isInitiativeTrigger(null), false);
});

test('backoffOutcomeFor: 発議 job と予算なしスレッドはバックオフの証拠にしない', () => {
  // 通常の自律 job は従来どおり (理由の読み方は backoffOutcome と同じ)
  assert.equal(backoffOutcomeFor('ok'), 'success');
  assert.equal(backoffOutcomeFor('internal-error'), 'failure');
  assert.equal(backoffOutcomeFor('failed(rate limit)'), 'failure');
  assert.equal(backoffOutcomeFor('verify-failed'), 'success');
  assert.equal(backoffOutcomeFor('aborted'), null);

  // **発議 job は成功も失敗も数えない** (sol 指摘 2026-08-30)。
  // 数えると「Opus がリミット → Fable の観測 job が成功 → バックオフ解除」で保護が消える
  assert.equal(backoffOutcomeFor('ok', { isInitiative: true }), null);
  assert.equal(backoffOutcomeFor('internal-error', { isInitiative: true }), null);

  // 予算を配っていないスレッド (人間が回している job) も従来どおり対象外
  assert.equal(backoffOutcomeFor('ok', { hasTaskBudget: false }), null);
  assert.equal(backoffOutcomeFor('internal-error', { hasTaskBudget: false }), null);
});

test('shouldDeliverProposal: 配れた後も裁定が返らなければ猶予後に起こし直す', () => {
  const opts = { now: T0, redeliverMs: 10 * 60_000, timeoutMs: 30 * 60_000, maxAttempts: 3 };
  const plan = (record, now = T0) => shouldDeliverProposal(record, { ...opts, now });

  // 一度も試していなければ配る
  assert.deepEqual(plan({}), { deliver: true });
  assert.deepEqual(plan({ attempts: 0, lastAt: 0 }), { deliver: true });

  // **配れた後**は猶予 (30 分) を待つ。投稿できたことは裁定されたことではないので、
  // 裁定待ちが続いているなら過ぎたら起こし直す (sol 指摘 2026-08-30)
  const sent = { delivered: true, attempts: 1, lastAt: T0 };
  assert.equal(plan(sent, T0 + 29 * 60_000).deliver, false);
  assert.equal(plan(sent, T0 + 29 * 60_000).reason, 'wait');
  assert.equal(plan(sent, T0 + 30 * 60_000).deliver, true, '境目ちょうどで止まっている');

  // **配れなかった**ときは相手が落ちているだけなので短い間隔で試し直す
  const failed = { delivered: false, attempts: 1, lastAt: T0 };
  assert.equal(plan(failed, T0 + 9 * 60_000).deliver, false);
  assert.equal(plan(failed, T0 + 10 * 60_000).deliver, true);

  // 上限まで試したら止める (以後は人間の出番)
  assert.deepEqual(plan({ attempts: 3, lastAt: T0 }, T0 + DAY_MS), { deliver: false, reason: 'attempts' });
  assert.deepEqual(plan({ delivered: true, attempts: 3, lastAt: 0 }), { deliver: false, reason: 'attempts' });

  // 壊れた記録は「まだ試していない」へ倒す (配らないまま黙って止まらない)
  assert.deepEqual(plan({ attempts: 'たくさん', lastAt: 'さっき' }), { deliver: true });
});

test('persistedState / restoreState: 台帳は持ち越し、バックオフは持ち越さない', () => {
  const state = {
    ...initialState(),
    dayKey: dayKeyFor(T0),
    jobsToday: 7,
    lastScoutAt: T0,
    backoffUntil: T0 + 60_000,
    backoffLevel: 3,
    initiative: { lastRunAt: { 'sol/audit': T0 }, spentToday: { sol: 1 } },
  };
  const saved = persistedState(state);
  assert.deepEqual(
    Object.keys(saved).sort(),
    ['carry', 'dayKey', 'initiative', 'jobsToday', 'lastHarnessAt', 'lastPlanAt', 'lastScoutAt', 'scoutIdle', 'scoutIdleSincePlan'],
  );
  // 申し送りは持ち越す (次の企画の巡回は翌日のことが多い)。形の崩れたものは落とす
  const carried = restoreState(persistedState({ ...state, carry: [{ at: T0, from: 'opus', text: '上限で止まった' }] }));
  assert.deepEqual(carried.carry, [{ at: T0, from: 'opus', text: '上限で止まった' }]);
  assert.deepEqual(
    restoreState({ carry: [{ at: 'いつか', from: 'a', text: 'x' }, { at: T0, text: '  ' }, null, { at: T0, from: 3, text: 'y' }] }).carry,
    [{ at: T0, from: '', text: 'y' }],
  );
  assert.deepEqual(restoreState({ carry: 'x' }).carry, []);
  // 提案 0 件の続きは持ち越す (再起動で 60 分に戻って空回りを繰り返さない)。壊れた値は 0 へ倒す
  const idle = restoreState(persistedState({ ...state, scoutIdle: 2, scoutIdleSincePlan: 1 }));
  assert.equal(idle.scoutIdle, 2);
  assert.equal(idle.scoutIdleSincePlan, 1);
  assert.equal(restoreState({ scoutIdle: -1, scoutIdleSincePlan: 1.5 }).scoutIdle, 0);
  assert.equal(restoreState({ scoutIdle: 'x', scoutIdleSincePlan: 1.5 }).scoutIdleSincePlan, 0);

  const back = restoreState(saved);
  assert.equal(back.jobsToday, 7);
  assert.equal(back.lastScoutAt, T0);
  assert.deepEqual(back.initiative, state.initiative);
  assert.equal(back.backoffUntil, 0, 'バックオフを持ち越している');
  assert.equal(back.backoffLevel, 0);

  // 壊れた値・古い形を持ち越しても落ちない (初期値へ倒す)
  assert.deepEqual(restoreState(null), initialState());
  assert.deepEqual(restoreState({ initiative: 'x' }).initiative, { lastRunAt: {}, spentToday: {} });
  // 壊れた時刻は 0 へ丸めず落とす (0 は「一度も回っていない」= すぐ回してよいの意味)
  assert.deepEqual(
    restoreState({ initiative: { lastRunAt: { 'a/b': 'いつか', 'c/d': 5 } } }).initiative.lastRunAt,
    { 'c/d': 5 },
  );
});

// ---- 承認の適用 (M0-7a) ----

const PENDING = [{ id: '3', title: 'A' }, { id: '4', title: 'B' }, { id: '5', title: 'C' }];

test('planApproval: 承認と破棄を振り分け、言及されなかった id は自動で破棄する', () => {
  const out = planApproval(
    { body: 'x', approve: ['3'], drop: [{ id: '4', reason: '既存と重複' }] },
    { pending: PENDING },
  );
  assert.deepEqual(out.approve, ['3']);
  assert.deepEqual(out.drop, [
    { id: '4', reason: '既存と重複' },
    { id: '5', reason: UNMENTIONED_REASON },
  ]);
  assert.deepEqual(out.errors, []);
});

test('planApproval: 今回の契約に無い id は動かさない (ボード全体を触る口にしない)', () => {
  const out = planApproval(
    { body: 'x', approve: ['99'], drop: [{ id: '  ', reason: 'r' }] },
    { pending: PENDING },
  );
  assert.deepEqual(out.approve, []);
  assert.equal(out.errors.length, 2, '知らない id を黙って呑んでいる');
  assert.match(out.errors.join('\n'), /知らない id 99/);
  assert.match(out.errors.join('\n'), /id が空です/);
  // どれも言及されなかった扱いになる
  assert.deepEqual(out.drop.map((d) => d.id), ['3', '4', '5']);
  assert.ok(out.drop.every((d) => d.reason === UNMENTIONED_REASON));
});

test('planApproval: 承認と破棄の両方に書かれた id は落とす側へ倒す', () => {
  const out = planApproval(
    { body: 'x', approve: ['3', '3'], drop: [{ id: '3', reason: 'やはり要らない' }] },
    { pending: [{ id: '3', title: 'A' }] },
  );
  assert.deepEqual(out.approve, [], '着手が始まる側へ倒している');
  assert.deepEqual(out.drop, [{ id: '3', reason: 'やはり要らない' }]);
  assert.equal(out.errors.length, 2, '二度書かれたことを黙って呑んでいる');
  assert.match(out.errors.join('\n'), /二度出てきます/);
});

test('planApproval: 空の応答・壊れた入力でも落ちない', () => {
  const empty = { approve: [], drop: [], errors: [] };
  assert.deepEqual(planApproval({ body: 'x', approve: [], drop: [] }, { pending: [] }), empty);
  assert.deepEqual(planApproval(null, {}), empty);
  assert.deepEqual(planApproval(), empty);
  assert.deepEqual(planApproval({ approve: 'a', drop: 'b' }, { pending: 'c' }), empty);

  // 数値で書かれた id も拾い、理由なしは既定の言葉にする
  const numeric = planApproval(
    { approve: [], drop: [{ id: 7, reason: '   ' }] },
    { pending: [{ id: '7', title: 'X' }] },
  );
  assert.deepEqual(numeric.drop, [{ id: '7', reason: '理由の記載なし' }]);
});

test('pickAnnouncer: 宛先自身は選ばず、既定は reviewer', () => {
  assert.equal(pickAnnouncer('opus', AUTONOMY, ['fable', 'opus', 'sol']), 'fable');
  assert.equal(pickAnnouncer('fable', AUTONOMY, ['fable', 'opus', 'sol']), 'opus');
  assert.equal(pickAnnouncer('opus', autonomy({ reviewer: null }), ['opus', 'sol']), 'sol');
  assert.equal(pickAnnouncer('opus', AUTONOMY, ['opus']), null);
  assert.equal(pickAnnouncer('opus', AUTONOMY, []), null);
});

// ---- レビュー回路 (M0-7b) ----

test('完了は「制御フッタの無い report」だけ (途中報告・エスカレーションでは進めない)', () => {
  const done = (over = {}) => isTaskDone({ kind: 'report', taskState: 'in-progress', ...over });
  assert.equal(done(), true);

  assert.equal(done({ hasHandoff: true }), false, '自己呼び出しの途中報告で進めている');
  assert.equal(done({ kind: 'delegation' }), false, 'エスカレーション (委譲) で進めている');
  assert.equal(done({ kind: 'task-proposal' }), false);
  assert.equal(done({ kind: null }), false, '様式不履行で進めている');
  assert.equal(done({ verifyOk: false }), false, '検証 NG の報告で進めている');
  // 走っていないタスク・タスクの無いスレッドでは進めない
  for (const taskState of ['approved', 'review', 'merged', 'blocked', null]) {
    assert.equal(done({ taskState }), false, String(taskState));
  }
  assert.equal(isTaskDone(), false);
});

test('完了に数えるのは担当 (worker) の報告だけ — 担当が分からなければ数えない', () => {
  const done = (over = {}) => isTaskDone({ kind: 'report', taskState: 'in-progress', ...over });

  assert.equal(done({ botKey: 'opus', workerBotKeys: ['opus'] }), true);
  assert.equal(done({ botKey: 'opus', workerBotKeys: ['opus', 'opus2'] }), true);
  // #46 の壊れ方: reviewer のフッタ無し報告が worker の完了と数えられ、
  // 自己レビュー禁止で契約が作られないまま review に固着した
  assert.equal(done({ botKey: 'opus2', workerBotKeys: ['opus'] }), false, 'reviewer の報告で進めている');

  // 担当が分からない報告は完了にしない (fail-closed)
  for (const workerBotKeys of [[], null, undefined, 'opus', {}]) {
    assert.equal(done({ botKey: 'opus', workerBotKeys }), false, JSON.stringify(workerBotKeys) ?? 'undefined');
  }
  // **botKey を渡さなければ従来どおり** (担当を知らない呼び出し側の挙動は変えない)
  assert.equal(done({ workerBotKeys: [] }), true);
  assert.equal(done({ botKey: null, workerBotKeys: ['opus'] }), true);
  // 他の条件は担当が合っていても効く
  assert.equal(done({ botKey: 'opus', workerBotKeys: ['opus'], hasHandoff: true }), false);
  assert.equal(done({ botKey: 'opus', workerBotKeys: ['opus'], taskState: 'review' }), false);
});

test('planReissueReview: 出し直せるのは review で止まっているものだけ', () => {
  const task = (state, id = '46') => ({ id, state });

  assert.deepEqual(
    planReissueReview({ task: task('review') }),
    { ok: true, reason: '#46 のレビューを出し直しました' },
  );
  assert.equal(planReissueReview({ task: task('review'), id: '46' }).ok, true, 'id 一致で断っている');
  assert.equal(planReissueReview({ task: task('review'), id: ' 46 ' }).ok, true, '前後の空白で断っている');
  assert.equal(planReissueReview({ task: task('review', 46) }).ok, true, '数値 id を落としている');

  // タスクの無いスレッド (打ち場所を間違えている)
  for (const task_ of [undefined, null, {}, 'x', { state: 'review' }]) {
    const out = planReissueReview(task_ === undefined ? undefined : { task: task_ });
    assert.equal(out.ok, false, JSON.stringify(task_) ?? 'undefined');
    assert.match(out.reason, /タスクがありません/);
  }

  // id 違いは黙って別のタスクを動かさない (どちらの id も理由に出す)
  const wrong = planReissueReview({ task: task('review'), id: '45' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /#46/);
  assert.match(wrong.reason, /#45/);

  // review 以外は出し直さない (書いている途中も、終わったものも対象外)
  for (const state of ['proposed', 'approved', 'in-progress', 'blocked', 'merged', 'dropped']) {
    const out = planReissueReview({ task: task(state) });
    assert.equal(out.ok, false, state);
    assert.match(out.reason, new RegExp(state), '何の状態で断ったのか分からない');
    assert.match(out.reason, /review だけ/);
  }
  assert.match(planReissueReview({ task: task('in-progress') }).reason, /担当をメンション/);
});

const MERGE_OID = 'a'.repeat(40);
const TIP_OID = 'b'.repeat(40);
const BASE_HEAD = 'c'.repeat(40);
/** applyReview が git から集めてくる事実 (照合が全部通った状態) */
const MERGE_FACTS = {
  commit: MERGE_OID,
  commitInBase: true,
  branchTip: TIP_OID,
  branchTipInCommit: true,
  baseBranch: 'main',
  baseHead: BASE_HEAD,
  branch: 'task/1',
};

test('planReview: merge は git の事実が 4 つ揃ったときだけ完了へ (§12.3 (2))', () => {
  const out = planReview({ body: 'x', verdict: 'merge', merge_commit: 'abc1234' }, { git: MERGE_FACTS });
  assert.deepEqual(out, {
    action: 'complete',
    // 申告の短縮 SHA ではなく**解決した完全 OID**を残す (後から突き合わせられる形)
    note: `merge ${MERGE_OID} (base main@${BASE_HEAD}, branch task/1@${TIP_OID})`,
  });
  // base の HEAD が読めなかったときも完了そのものは通す (照合の 4 点は揃っている)
  assert.match(
    planReview({ verdict: 'merge', merge_commit: 'abc1234' }, { git: { ...MERGE_FACTS, baseHead: null } }).note,
    /base main@不明/,
  );
});

test('planReview: 照合できない merge は hold — 遷移させない (§12.3 (2))', () => {
  // **事実を渡さない呼び出しは hold。** 「照合していない」を「照合できた」へ倒さない
  const bare = planReview({ body: 'x', verdict: 'merge', merge_commit: 'abc1234' });
  assert.equal(bare.action, 'hold');
  assert.match(bare.reason, /abc1234/, '何が確かめられなかったのか分からない');
  assert.equal(bare.note, undefined);
  // SHA の記載が無い (様式では落ちるが、判断の層でも完了へ倒さない)
  assert.match(planReview({ verdict: 'merge' }, { git: {} }).reason, /記載がない/);

  const cases = [
    [{ commit: null }, /git に見つかりません/],
    [{ commitInBase: false }, /main に入っていません/],
    [{ commitInBase: null }, /main に入っていません/],
    [{ branchTip: null }, /ブランチ task\/1 が見つかりません/],
    [{ branchTipInCommit: false }, /先端 bbbbbbbbbbbb が aaaaaaaaaaaa に入っていません/],
    [{ branchTipInCommit: null }, /に入っていません/],
  ];
  for (const [patch, pattern] of cases) {
    const out = planReview({ verdict: 'merge', merge_commit: 'abc1234' }, { git: { ...MERGE_FACTS, ...patch } });
    assert.equal(out.action, 'hold', JSON.stringify(patch));
    assert.match(out.reason, pattern);
  }
  // 確かめられなかったものは全部並べる (1 つ直したらまた止まる、を避ける)
  const many = planReview(
    { verdict: 'merge', merge_commit: 'abc1234' },
    { git: { ...MERGE_FACTS, commitInBase: false, branchTipInCommit: false } },
  );
  assert.match(many.reason, /main に入っていません \/ /);
});

test('planReview: 適用 task の merge は planMerge が照合するので git の事実を要求しない', () => {
  // §12.3 (2) — org-apply は receipt の OID と verify を planMerge が見てから
  // ブリッジ自身が merge を打つ。ここで二重に git を要求すると、その経路が止まる
  const out = planReview({ verdict: 'merge', merge_commit: 'abc1234' }, { mergeCheckedBy: 'planMerge' });
  assert.deepEqual(out, { action: 'complete', note: 'merge abc1234 (planMerge が照合)' });
});

test('planReview: 差し戻しは 2 回目で要人間へ倒れる', () => {
  const first = planReview({ verdict: 'send-back', reason: 'テストが足りない' }, { sendBackCount: 0 });
  assert.deepEqual(first, { action: 'send-back', reason: 'テストが足りない' });

  const second = planReview({ verdict: 'send-back', reason: 'まだ足りない' }, { sendBackCount: 1 });
  assert.equal(second.action, 'block', '同じところで往復し続けている');
  assert.match(second.reason, /差し戻し 2 回目/);
  assert.match(second.reason, /まだ足りない/, 'レビューの理由を捨てている');

  // 理由が空でも落ちない (様式は非空を要求するが、判断側でも受け止める)
  assert.match(planReview({ verdict: 'send-back' }).reason, /記載なし/);
});

test('planReview: block はそのまま要人間 / 知らない判定は何もしない', () => {
  assert.deepEqual(
    planReview({ verdict: 'block', reason: '仕様の裁定が要る' }),
    { action: 'block', reason: '仕様の裁定が要る' },
  );
  for (const verdict of ['merged', 'ok', '', null, undefined]) {
    const out = planReview({ verdict });
    assert.equal(out.action, 'none', JSON.stringify(verdict));
    assert.match(out.error, /知らない判定/);
  }
  assert.equal(planReview().action, 'none');
});

test('planReview: drop は対象を破棄へ (差し戻し回数に影響されない — §9.4)', () => {
  assert.deepEqual(
    planReview({ verdict: 'drop', reason: '#45 の重複' }),
    { action: 'drop', reason: '#45 の重複' },
  );
  // 「不要」は仕事の質の話ではないので、往復の勘定に混ぜない
  assert.deepEqual(
    planReview({ verdict: 'drop', reason: '既に着地済み' }, { sendBackCount: 1 }),
    { action: 'drop', reason: '既に着地済み' },
  );
  // 理由の受け止め方は send-back / block と同じ (様式は空の理由を先に落とす)
  assert.match(planReview({ verdict: 'drop' }).reason, /記載なし/);
});

test('applyReview の drop はボードを閉じてから掃除する (duty イベントは配らない)', () => {
  const source = bridgeSource('board');
  const from = source.indexOf('async function applyReview');
  const to = source.indexOf('async function notifySendBack');
  assert.ok(from > 0 && to > from, 'applyReview を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  // 状態の門番は判定より前に 1 つだけ (review 以外では drop の枝にも入らない)
  assert.match(body, /task\.state !== 'review'/);
  assert.ok(
    body.indexOf("task.state !== 'review'") < body.indexOf("plan.action === 'drop'"),
    '門番より先に判定を適用している',
  );

  const dropAt = body.indexOf("plan.action === 'drop'");
  const drop = body.slice(dropAt, body.indexOf("plan.action === 'block'"));
  assert.ok(dropAt > 0 && drop.length > 0, 'drop の枝が無い');
  assert.match(drop, /board\.drop\(task\.id, \{ by: bot\.key, reason: plan\.reason \}\)/);
  // **遷移が先・掃除は後** (§9.5)。撤去に失敗しても dropped は取り消さない
  assert.match(drop, /cleanupTaskWorktree\(\{ cc, task, action: 'drop' \}\)/, '掃除を呼んでいない');
  assert.ok(
    drop.indexOf('board.drop(') < drop.indexOf('cleanupTaskWorktree('),
    '掃除がボードの遷移より前に来ている',
  );
  // duty イベントの語彙 (DUTY_EVENT_KINDS) に drop は無い — 配るなら config の裁定が要る。
  // git を直接打つのは掃除の中だけ (ブランチは dropped では消さない)
  for (const forbidden of [
    'notifyDutyEvent(', 'taskWorktreeFor(', 'runGit(', 'grantTaskBudget(',
  ]) {
    assert.equal(drop.includes(forbidden), false, `drop の枝が ${forbidden} を呼んでいる`);
  }

  // merged 側も同じ順 (遷移 → 掃除)。こちらは枝ごと消す
  const complete = body.slice(body.indexOf("plan.action === 'complete'"), dropAt);
  assert.match(complete, /cleanupTaskWorktree\(\{ cc, task, action: 'complete' \}\)/);
  assert.ok(
    complete.indexOf('board.complete(') < complete.indexOf('cleanupTaskWorktree('),
    '掃除がボードの遷移より前に来ている',
  );
});

test('cleanupTaskWorktree は掃除の失敗で判定を巻き戻さない (投げずに 1 行で返す)', () => {
  const source = bridgeSource('board');
  const from = source.indexOf('async function cleanupTaskWorktree');
  const to = source.indexOf('async function notifySendBack');
  assert.ok(from > 0 && to > from, 'cleanupTaskWorktree を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  // 判断は純関数 (src/worktree.js) に置き、ここは実行と 1 行の報告だけ
  assert.match(body, /planTaskCleanup\(\{ action, branch: task\.branch \}\)/);
  assert.match(body, /if \(!plan\.release\) return '';/, '撤去しない判定で git を打っている');
  // 撤去先は**リポジトリ本体** (作業ツリー側から打つと使用中のツリーを消しに行く)
  assert.match(body, /cc\.repoRoot \?\? cc\.cwd/);
  assert.match(body, /releaseWorktree\(\{/);
  // ブランチは -d だけ (-D で押し切らない = 未マージなら git が拒否して残す)
  assert.match(body, /\['branch', '-d', task\.branch\]/);
  assert.equal(/'-D'/.test(body), false, '未マージのブランチを押し切って消している');
  // 例外は握って note にする (投げるとボードの遷移まで巻き戻る)
  assert.equal((body.match(/catch \(err\)/g) ?? []).length, 2, '撤去と枝削除の両方を握っていない');
  assert.match(body, /残しました/);
  assert.match(body, /既にありません/, 'missing を区別していない');
  // ここで board を触らない (掃除は判定の一部ではない)
  assert.equal(/board\./.test(body), false, '掃除がボードを触っている');
});

test('backoffOutcome: バックオフを動かすのはランタイムが動かなかったときだけ', () => {
  assert.equal(backoffOutcome('failed(rate limit)'), 'failure');
  assert.equal(backoffOutcome('internal-error'), 'failure');
  assert.equal(backoffOutcome('ok'), 'success');
  // verify NG は CLI が正しく動いた結果 — テストが落ちるたびに社会を止めない
  assert.equal(backoffOutcome('verify-failed'), 'success');
  // 中断・配信失敗はリミットの証拠にならない
  for (const reason of ['aborted', 'deliver-failed', '', null, undefined, 42]) {
    assert.equal(backoffOutcome(reason), null, JSON.stringify(reason));
  }
});

test('pickWorker: 先頭から、いま起動している担当を採る', () => {
  assert.equal(pickWorker(AUTONOMY, ['fable', 'opus', 'sol']), 'opus');
  assert.equal(pickWorker(autonomy({ worker: { bots: ['sol', 'opus'] } }), ['fable', 'opus']), 'opus');
  assert.equal(pickWorker(AUTONOMY, ['fable']), null);
  assert.equal(pickWorker({}, ['opus']), null);
  assert.equal(pickWorker(), null);
});

test('承認依頼は reviewer へ種別の上書きを対で付ける', () => {
  // 上書きの保管は index.js の in-memory Map なので、テストから呼べる形になっていない。
  // ここで固定するのは**配線の有無**: 上書きが無いと承認 job の応答は reviewer の
  // 役割文が宣言した種別 (Observatory では delegation) で検査され、
  // applyApproval の枝に一度も入らない = 起票が永遠に proposed のまま残る
  // (Fable 指摘 2026-08-28)
  const source = bridgeSource('board');
  const from = source.indexOf('async function requestApproval');
  const to = source.indexOf('async function noteTaskCompletion');
  assert.ok(from > 0 && to > from, 'requestApproval を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  assert.match(
    body,
    /setContractKindOverride\(thread\.id, reviewerKey, 'task-approval'\)/,
    '承認依頼が種別の上書きを設定していない (承認の応答が検査されず、起票が proposed のまま残る)',
  );
  assert.match(
    body,
    /claimContractKindOverride\(thread\.id, reviewerKey\)/,
    '投稿に失敗したときに上書きを取り消していない (そのスレッドの次の job が巻き添えになる)',
  );
  assert.ok(
    body.indexOf('setContractKindOverride') < body.indexOf('await sendControlMention'),
    '上書きは投稿より前に置く (投げてから被せると、先に届いた job が上書き無しで走る)',
  );
  // スカウト側 (M0-5b) の対も一緒に固定しておく (スカウトの起動は scheduler の配線)
  assert.match(bridgeSource('scheduler'), /setContractKindOverride\(thread\.id, scoutKey, 'task-proposal'\)/);
});

test('契約は制御メンションを投げる bot で束縛する (claim は投稿者と突き合わせる)', () => {
  // ContractStore.claim は「制御メンションの投稿者 == fromBotKey」で契約を結ぶ。
  // 宛先が自分自身のときは announcerFor が**別の bot から**投げるので、bot.key で
  // 束縛すると契約が永久に結ばれない (/review を reviewer 自身で打つ経路)
  const source = bridgeSource('board');
  const regions = [
    ['async function requestApproval', 'async function noteTaskCompletion'],
    ['async function requestReview', 'async function applyReview'],
  ];
  for (const [start, end] of regions) {
    const from = source.indexOf(start);
    const to = source.indexOf(end);
    assert.ok(from > 0 && to > from, `${start} を切り出せない (関数名が変わった?)`);
    const body = source.slice(from, to);
    assert.match(body, /fromBotKey: via\.key/, `${start} が投げ手で束縛していない`);
    assert.equal(/fromBotKey: bot\.key/.test(body), false, `${start} に bot.key の束縛が残っている`);
    // 投げ手は契約を組み立てる前に決まっている (決まらなければ契約を作らずに返す)
    assert.ok(
      body.indexOf('announcerFor(') < body.indexOf('bindContract('),
      `${start} が投げ手を決める前に契約を作っている`,
    );
  }
});

test('/review の出し直しは 判定 → pause → 契約の置き換え → 召喚 の順', () => {
  const source = bridgeSource('board');
  const from = source.indexOf('async function reissueReview');
  const to = source.indexOf('function applyApproval');
  assert.ok(from > 0 && to > from, 'reissueReview を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  let last = -1;
  for (const needle of [
    'planReissueReview(', 'pauseStore.paused', 'contracts.removeById(', 'await requestReview(',
  ]) {
    const at = body.indexOf(needle);
    assert.ok(at > last, `${needle} が無いか順序が違う`);
    last = at;
  }
  // 断ったら契約を作らない (判定と pause は召喚より前に return する)
  assert.ok(body.indexOf('return plan;') < body.indexOf('await requestReview('));
  assert.ok(body.indexOf('/resume') < body.indexOf('await requestReview('));

  // 置き換えで消すのは**その宛先の task-review だけ** (承認や委譲を巻き添えにしない)
  assert.match(body, /contracts\.list\(thread\.id, reviewerKey\)/);
  assert.match(body, /entry\?\.kind === 'task-review'/);
  assert.match(body, /contracts\.removeById\(thread\.id, reviewerKey, entry\.id\)/);
  // 人間が出す経路なので自己レビュー禁止の門番は通さない (打った bot は実装者ではない)
  assert.match(body, /byWorker: false/);

  // 成否は召喚した側の戻りで決める。**送信後の store は根拠にならない** —
  // 受け手は受付時に契約を claim して消すので、REST の応答より先にレビュー job が
  // 起動した回だけ「契約が無い = 失敗」に見え、打ち直しで 2 本目が立つ (sol 指摘)
  const sent = body.indexOf('await requestReview(');
  assert.equal(
    body.slice(sent).includes('contracts.list('),
    false,
    '召喚した後に store を読んで成否を決めている',
  );
  assert.match(body.slice(sent), /sent\.ok/, '召喚の戻りで分岐していない');
});

test('担当以外のフッタ無し報告は完了に数えず、そのことをスレッドへ 1 行出す', () => {
  const source = bridgeSource('board');
  const from = source.indexOf('async function noteTaskCompletion');
  const to = source.indexOf('async function requestReview');
  assert.ok(from > 0 && to > from, 'noteTaskCompletion を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  assert.match(body, /botKey: bot\.key/, '報告した bot を渡していない');
  assert.match(body, /workerBotKeys/, '担当の一覧を渡していない');
  assert.match(body, /autonomy\.worker\?\.bots/, '担当をチャンネル設定から取っていない');
  assert.match(body, /以外の報告なので完了とは数えません/, '担当外の報告を黙って捨てている');
  assert.match(body, /sendSafe\(/);
  // 投稿に失敗しても job の後始末を落とさない
  assert.ok(body.includes('.catch(() => {})'), '投稿の失敗を握っていない');
});

test('承認には重複を見つける材料を渡す (§9.3 — 今回の起票は参考欄から除く)', () => {
  const source = bridgeSource('board');
  const cut = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end);
    assert.ok(from > 0 && to > from, `${start} を切り出せない (関数名が変わった?)`);
    return source.slice(from, to);
  };

  // 参考欄はボードの現状から作る。**スカウトと同じ材料** (scoutBoardView) を使う —
  // 承認とスカウトが違うボードを見ていると、片方だけ重複を見逃す
  const request = cut('async function requestApproval', 'async function noteTaskCompletion');
  assert.match(request, /board: approvalBoard\(scoutBoardView\(board\.list\(/, '参考欄を渡していない');
  assert.match(request, /excludeIds: filed\.map\(/, '今回の起票を参考欄から除いていない');

  // 承認待ちの touch (宣言があるときだけ — 空配列は様式が拒む)。純関数なので直接呼ぶ
  assert.deepEqual(
    approvalItem({ id: 7, title: 'lint', rationale: ' 理由 ', touch: ['a.py'], jobBudget: 4 }),
    { id: '7', title: 'lint', rationale: '理由', touch: ['a.py'], job_budget: 4 },
  );
  assert.deepEqual(approvalItem({ id: 8, title: 'doc', touch: [], jobBudget: 0 }), { id: '8', title: 'doc' });
});

test('レビュー召喚は契約保存と control mention だけ (job を直接立てない)', () => {
  const source = bridgeSource('board');
  const from = source.indexOf('async function requestReview');
  const to = source.indexOf('async function applyReview');
  assert.ok(from > 0 && to > from, 'requestReview を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);

  assert.match(body, /contracts\.push\(thread\.id, reviewerKey, entry\)/, '契約を保存していない');
  assert.match(body, /setContractKindOverride\(thread\.id, reviewerKey, 'task-review'\)/);
  assert.match(body, /await sendControlMention\(/, '制御メンションを投げていない');
  // 投稿に失敗したら保存も上書きも戻す
  assert.match(body, /contracts\.removeById\(thread\.id, reviewerKey, entry\.id\)/);
  assert.match(body, /claimContractKindOverride\(thread\.id, reviewerKey\)/);
  assert.ok(
    body.indexOf('setContractKindOverride') < body.indexOf('await sendControlMention'),
    '上書きは投稿より前に置く',
  );
  // **入口の認可を迂回しない** — job は既存の MessageCreate 経路で立てる
  assert.equal(/\benqueue\(/.test(body), false, 'job を直接積んでいる');
  assert.equal(/\brunJob\(/.test(body), false, 'job を直接走らせている');

  // 成否を返すのはここだけ。**成功は送信が resolve した後の 1 箇所**で、
  // 呼び出し側が store を見て確かめ直す余地を残さない (sol 指摘 2026-09-01)
  const oks = [...body.matchAll(/ok: true/g)];
  assert.equal(oks.length, 1, `成功の return が ${oks.length} 箇所ある`);
  assert.ok(
    oks[0].index > body.indexOf('await sendControlMention'),
    '投稿を待つ前に成功を返している (投稿に失敗しても ok になる)',
  );
  const firstNg = body.indexOf('ok: false');
  assert.ok(firstNg > 0, '失敗の return が {ok:false} になっていない');
  assert.ok(firstNg < body.indexOf('await sendControlMention'), '投稿までの失敗経路が ok を返している');
});

test('契約はリポジトリ本体で束縛する (worktree の worker と本体の reviewer を跨ぐため)', () => {
  // 契約を組む場所 (board / turn)・取り出す場所 (contracts)・cc を組む場所 (messages) をまとめて見る
  const source = ['board', 'turn', 'contracts', 'messages'].map(bridgeSource).join('\n');
  // cc.cwd のままだと、worker (作業ツリー) が保存した契約を reviewer (本体) が
  // 取り出せず、レビュー job が起動しないままタスクが review に残る (Sol 指摘 2026-08-28)
  const binds = [...source.matchAll(/bindContract\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
  assert.ok(binds.length >= 3, `bindContract の呼び出しを切り出せない (${binds.length} 件)`);
  for (const call of binds) {
    assert.match(call, /cwd: contractCwd\(cc\)/, `契約を cc.cwd で束縛している:\n${call.slice(0, 160)}`);
  }
  const lookup = source.slice(source.indexOf('const usable = contractFor(entry, {'), -1).slice(0, 240);
  assert.match(lookup, /cwd: contractCwd\(cc\)/, '取り出し側が cc.cwd のまま');
  // 差し替え前の本体を持ち回っていること・寄せ先がそれであること
  assert.match(source, /repoRoot: canonical/, 'cc が repoRoot を持っていない');
  assert.match(source, /function contractCwd\(cc\) \{\n\s*return cc\.repoRoot \?\? cc\.cwd;/);
});

test('作業ツリーの用意は同じタスクで 1 本にまとめる (レーン直列化より前に走るため)', () => {
  const source = bridgeSource('messages');
  const from = source.indexOf('async function taskWorktreeFor');
  const to = source.indexOf('async function onMessage');
  assert.ok(from > 0 && to > from, 'taskWorktreeFor を切り出せない (関数名が変わった?)');
  const body = source.slice(from, to);
  assert.match(body, /await prepareWorktreeOnce\(/, '同時に来た要求を畳んでいない');
  assert.match(body, /\$\{canonical\}::\$\{decided\.taskId\}/, '鍵がリポジトリとタスクの組でない');
});

test('scheduler.js は時計もタイマーも IO も持たない (判断だけの層)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/scheduler.js', import.meta.url)), 'utf8');
  for (const forbidden of [
    'Date.now(', 'setInterval', 'setTimeout', 'node:fs', 'node:child_process',
    'discord', 'readFileSync', 'writeFileSync', 'process.env', './board.js',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} を使っている`);
  }
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  // time.js を許すのは、そこも時計を読まない純粋関数 (渡された値を JST で刻むだけ) だから。
  // その性質は test/time.test.js 側で固定してある — 増やすときは同じ条件で
  assert.deepEqual(imports, ['./config.js', './time.js'], '判断の層が設定と暦以外へ依存している');
});

test('planTaskCwd: タスクのスレッドではそのタスク専用の作業ツリーを使う', () => {
  const decided = planTaskCwd({
    task: { id: 9, branch: 'task/9' },
    autonomy: { enabled: true, reviewer: 'opus2', baseBranch: 'main' },
    botKey: 'opus',
  });
  assert.deepEqual(decided, { useWorktree: true, taskId: 9, branch: 'task/9', base: 'main' });
});

test('planTaskCwd: branch が空なら task/<id> へ倒し、前後の空白は落とす', () => {
  for (const branch of [null, undefined, '', '   ']) {
    const decided = planTaskCwd({
      task: { id: 12, branch },
      autonomy: { enabled: true, baseBranch: 'main' },
      botKey: 'opus',
    });
    assert.equal(decided.branch, 'task/12', `branch=${JSON.stringify(branch)}`);
  }
  const trimmed = planTaskCwd({
    task: { id: 12, branch: ' task/custom ' },
    autonomy: { enabled: true, baseBranch: 'main' },
    botKey: 'opus',
  });
  assert.equal(trimmed.branch, 'task/custom');
});

test('planTaskCwd: レビュー担当は本体で走る (昇格の merge 先が cwd の外に出ないように)', () => {
  const decided = planTaskCwd({
    task: { id: 9, branch: 'task/9' },
    autonomy: { enabled: true, reviewer: 'opus2', baseBranch: 'main' },
    botKey: 'opus2',
  });
  assert.equal(decided.useWorktree, false);
  assert.match(decided.reason, /レビュー担当/);
});

test('planTaskCwd: タスクが無い・自律運転が無効なら本体のまま', () => {
  assert.equal(planTaskCwd({ task: null, autonomy: { enabled: true } }).useWorktree, false);
  assert.equal(planTaskCwd().useWorktree, false);
  assert.equal(planTaskCwd({ task: { id: 9 }, autonomy: { enabled: false } }).useWorktree, false);
  // enabled は true と書いたときだけ (resolveAutonomy と同じ fail-closed)
  assert.equal(planTaskCwd({ task: { id: 9 }, autonomy: { enabled: 'true' } }).useWorktree, false);
});

test('planTaskCwd: botKey が分からないときは作業ツリー側へ倒す', () => {
  // reviewer 判定を落としたときに本体で走らせると #9 (未マージの上に積まれる) が
  // 静かに再発する。merge できない方はエラーで気づけるので、こちらへ倒すのが安全
  const decided = planTaskCwd({
    task: { id: 9 },
    autonomy: { enabled: true, reviewer: 'opus2', baseBranch: 'main' },
  });
  assert.equal(decided.useWorktree, true);
});

// ---- ハーネスの改訂の下書きの検証 (解き直し — src/replay.js) ----

test('planTick: 解き直しを待つ改訂は同時枠に数えず、解き直しを先に起こす (同時上限 1・worker 1 体の配備)', () => {
  const live = autonomy({ maxConcurrentTasks: 1, scout: { ...AUTONOMY.scout, maxOpenTasks: 99 } });
  const waiting = { id: '3', state: 'review', replay: { status: 'running', startedAt: new Date(T0).toISOString() } };
  const replay = { id: '5', state: 'approved', replay: { of: '3', caseId: '1', kind: 'sent-back', base: 'abc1234' } };
  const older = task(4, 'approved');
  const starts = (tasks) => plan({ tasks, autonomy: live }).actions.filter((a) => a.kind === 'start-task');
  // 改訂が枠を塞ぐと、自分の解き直しを起こせないまま待ち続ける
  assert.deepEqual(starts([waiting, older, replay]), [{ kind: 'start-task', taskId: '5' }]);
  // 解き直しを待っていない review は今までどおり枠に数える
  assert.deepEqual(starts([{ ...waiting, replay: { status: 'done' } }, older, replay]), []);
  assert.deepEqual(starts([task(3, 'review'), older]), []);
  // 解き直しが走っている間は、それが枠を使う
  assert.deepEqual(starts([waiting, older, { ...replay, state: 'in-progress' }]), []);
});

test('planTaskCwd: 解き直しは元のタスクが始まった版から生やす (base が無ければ今までどおり)', () => {
  const cwdOf = (task) => planTaskCwd({ task, autonomy: { enabled: true, reviewer: 'opus2', baseBranch: 'dev' }, botKey: 'opus' });
  assert.equal(cwdOf({ id: 5, replay: { of: '3', caseId: '1', kind: 'canary', base: 'abc1234' } }).base, 'abc1234');
  assert.equal(cwdOf({ id: 5, replay: { of: '3', caseId: '1', kind: 'canary', base: '' } }).base, 'dev');
  assert.equal(cwdOf({ id: 5 }).base, 'dev');
});

test('isReplayTask / awaitingReplays: 解き直しの物差し', () => {
  assert.equal(isReplayTask({ replay: { of: '3' } }), true);
  assert.equal(isReplayTask({ replay: { of: '' } }), false);
  assert.equal(isReplayTask({ replay: { status: 'running' } }), false);
  assert.equal(awaitingReplays({ state: 'review', replay: { status: 'running' } }), true);
  assert.equal(awaitingReplays({ state: 'review', replay: { status: 'none' } }), false);
  assert.equal(awaitingReplays({ state: 'in-progress', replay: { status: 'running' } }), false);
  assert.equal(awaitingReplays(null), false);
});

// ---- スカウトの空回り (提案 0 件が続いたら間隔を伸ばし、企画の巡回を前倒しする — 2026-10-14) ----

test('recordScoutReport: 提案 0 件で続けての勘定を進め、1 件でもあれば両方 0 へ戻す', () => {
  const once = recordScoutReport(initialState(), { proposed: 0 });
  assert.equal(once.scoutIdle, 1);
  assert.equal(once.scoutIdleSincePlan, 1);
  const twice = recordScoutReport(once, { proposed: 0 });
  assert.deepEqual([twice.scoutIdle, twice.scoutIdleSincePlan], [2, 2]);
  // 提案があれば戻す (ボードが断ったかは見ない — 呼び出し側は提案した数を渡す)
  const back = recordScoutReport(twice, { proposed: 2 });
  assert.deepEqual([back.scoutIdle, back.scoutIdleSincePlan], [0, 0]);
  // 数でない・負の数は 0 件として数える。引数の state は変えない
  assert.equal(recordScoutReport(initialState(), {}).scoutIdle, 1);
  assert.equal(recordScoutReport(initialState(), { proposed: -1 }).scoutIdle, 1);
  assert.equal(once.scoutIdle, 1, '引数の state を変えている');
});

test('scoutPace: 0 件が続いた回数で間隔を 2 倍ずつ伸ばし、4 倍で頭打ち', () => {
  assert.deepEqual(scoutPace({ autonomy: AUTONOMY, idle: 0 }), { baseMin: 60, intervalMin: 60 });
  assert.deepEqual(scoutPace({ autonomy: AUTONOMY, idle: 1 }), { baseMin: 60, intervalMin: 120 });
  assert.deepEqual(scoutPace({ autonomy: AUTONOMY, idle: 2 }), { baseMin: 60, intervalMin: 240 });
  assert.deepEqual(scoutPace({ autonomy: AUTONOMY, idle: 9 }), { baseMin: 60, intervalMin: 240 });
  assert.deepEqual(scoutPace({ autonomy: autonomy({ scout: { bot: 'opus', intervalMin: 30 } }), idle: 1 }), { baseMin: 30, intervalMin: 60 });
  // 設定が無い・壊れた回数は既定の間隔のまま
  assert.deepEqual(scoutPace({ idle: 'x' }), { baseMin: 60, intervalMin: 60 });
});

test('planTick: 提案 0 件が続いたらスカウトの間隔を伸ばし、前の巡回の後の merge で元に戻す', () => {
  const idle = (n, over = {}) => scouted({ scoutIdle: n, ...over });
  // 1 回 → 120 分、2 回以上 → 240 分 (ちょうど経過で起こす)
  assert.deepEqual(plan({ state: idle(1), now: at(60) }).actions, [], '0 件の後も 60 分で起こしている');
  assert.deepEqual(plan({ state: idle(1), now: at(120) }).actions, [{ kind: 'scout' }]);
  assert.deepEqual(plan({ state: idle(3), now: at(239) }).actions, []);
  assert.deepEqual(plan({ state: idle(3), now: at(240) }).actions, [{ kind: 'scout' }]);
  // 起こしても続けての回数は報告が来るまで変えない (数えるのは recordScoutReport)
  assert.equal(plan({ state: idle(3), now: at(240) }).state.scoutIdle, 3);

  // 前の巡回の後に merge があれば 60 分に戻し、回数も 0 へ
  const mergedTask = (iso) => ({ id: '7', state: 'merged', history: [{ at: iso, from: 'review', to: 'merged' }] });
  const after = plan({ state: idle(2), now: at(60), tasks: [mergedTask(new Date(at(30)).toISOString())] });
  assert.deepEqual(after.actions, [{ kind: 'scout' }]);
  assert.equal(after.state.scoutIdle, 0);
  // 巡回より前の merge・merged でないタスク・時刻の読めない履歴では戻さない
  const before = plan({ state: idle(2), now: at(60), tasks: [mergedTask(new Date(at(-30)).toISOString())] });
  assert.deepEqual(before.actions, []);
  assert.equal(before.state.scoutIdle, 2);
  const review = { id: '8', state: 'review', history: [{ at: new Date(at(30)).toISOString(), to: 'merged' }] };
  assert.deepEqual(plan({ state: idle(2), now: at(60), tasks: [review] }).actions, []);
  assert.deepEqual(plan({ state: idle(2), now: at(60), tasks: [mergedTask('いつか')] }).actions, []);
  // 前の企画の巡回の後の回数は merge でも消さない (種が尽きた合図は残す)
  assert.equal(plan({ state: idle(2, { scoutIdleSincePlan: 1 }), now: at(60), tasks: [mergedTask(new Date(at(30)).toISOString())] }).state.scoutIdleSincePlan, 1);
});

test('planTick: 最後の企画の巡回の後に提案 0 件が 2 回続いたら、企画の巡回を間隔を待たずに起こす', () => {
  // 企画は 1 時間前に回ったばかり (間隔 24 時間)・スカウトは間隔前
  const recent = (n) => scouted({ lastPlanAt: T0 - 60 * 60_000, scoutIdle: n, scoutIdleSincePlan: n });
  assert.deepEqual(plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent(1) }).actions, [], '1 回で前倒ししている');
  const early = plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent(2) });
  assert.deepEqual(early.actions, [{ kind: 'plan', early: true, idleScouts: 2 }]);
  assert.equal(early.state.lastPlanAt, T0);
  // 前倒しの後は数え直す (0 件の巡回のたびに企画を起こさない)。続けての回数 (間隔の肩) は残す
  assert.equal(early.state.scoutIdleSincePlan, 0);
  assert.equal(early.state.scoutIdle, 2);
  const next = recordScoutReport(early.state, { proposed: 0 });
  assert.deepEqual(plan({ autonomy: withPlanner, plan: OPEN_GATE, state: { ...next, lastScoutAt: T0 }, now: at(1) }).actions, []);

  // 門が閉じている・主題ファイルを触るタスクが終わっていない・企画役が居ない → 前倒しもしない
  assert.deepEqual(plan({ autonomy: withPlanner, plan: { due: false }, state: recent(2) }).actions, []);
  const planning = [{ id: '9', state: 'approved', touch: ['docs/themes.md'] }];
  assert.equal(
    plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent(2), tasks: planning }).actions.some((a) => a.kind === 'plan'),
    false,
    '主題の取り込みに重ねて前倒ししている',
  );
  assert.deepEqual(plan({ plan: OPEN_GATE, state: recent(2) }).actions, []);
  // 間隔が明けていれば通常の巡回 (early は付けない) で、数え直しも同じ
  const regular = plan({ autonomy: withPlanner, plan: OPEN_GATE, state: recent(2), now: T0 + DAY_MS });
  assert.deepEqual(regular.actions.filter((a) => a.kind === 'plan'), [{ kind: 'plan' }]);
  assert.equal(regular.state.scoutIdleSincePlan, 0);
});

// ---- 申し送り (task-proposal の carry → 次の企画の巡回 — 2026-10-14) ----

test('addCarry: 1 行に畳み、字数で切り、空は落とし、上限を超えたら古いものから落とす', () => {
  const first = addCarry(initialState(), { items: ['日次上限で\n4 時間止まった', '  ', 'y'.repeat(400)], from: 'opus', at: T0 });
  assert.equal(first.added, 2);
  assert.equal(first.dropped, 0);
  assert.deepEqual(first.state.carry[0], { at: T0, from: 'opus', text: '日次上限で 4 時間止まった' });
  assert.equal(first.state.carry[1].text.length, 300);
  assert.ok(first.state.carry[1].text.endsWith('…'));
  // 引数の state は変えない
  assert.deepEqual(initialState().carry, []);

  // 上限 12 件。超えたら古いものから落とし、落とした数を返す
  let state = first.state;
  for (let i = 0; i < 4; i += 1) {
    state = addCarry(state, { items: [`a${i}`, `b${i}`, `c${i}`], from: 'opus', at: T0 + i + 1 }).state;
  }
  assert.equal(state.carry.length, 12);
  const over = addCarry(state, { items: ['最新'], from: 'fable', at: T0 + 9 });
  assert.equal(over.dropped, 1);
  assert.equal(over.state.carry.length, 12);
  assert.equal(over.state.carry.at(-1).text, '最新');
  assert.equal(over.state.carry[0].text, 'b0', '新しいものを落としている');
  // 時刻が数でなければ溜めない (呼び出し側の誤り)
  assert.equal(addCarry(initialState(), { items: ['x'], from: 'opus' }).added, 0);
});

test('dropCarry: 渡し終えたものだけを消し、渡している間に増えたものは残す', () => {
  const shown = addCarry(initialState(), { items: ['a', 'b'], from: 'opus', at: T0 }).state;
  const grown = addCarry(shown, { items: ['c'], from: 'opus', at: T0 + 1 }).state;
  assert.deepEqual(dropCarry(grown, shown.carry).carry, [{ at: T0 + 1, from: 'opus', text: 'c' }]);
  // 同じ本文でも時刻か書き手が違えば別のもの
  const twice = addCarry(shown, { items: ['a'], from: 'fable', at: T0 }).state;
  assert.deepEqual(dropCarry(twice, shown.carry).carry.map((c) => c.from), ['fable']);
  assert.deepEqual(dropCarry(grown, null).carry.length, 3);
});
