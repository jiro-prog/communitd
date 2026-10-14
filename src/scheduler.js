// スケジューラの判断 (docs/social-engineering.md §3.1・§7-4)。
//
// **ここに置くのは純粋関数だけ。** 時計を内部で読まず `now` を引数で受け、
// Discord にもファイルにもボードにも書かない — 「いま何を起こすべきか」を選ぶところまでが
// この層の仕事で、スレッド作成・起動メンション・ボードの更新は組み込み側 (M0-5) が行う。
//
// こう切っておくと、社会の挙動 (ペース・同時数・バックオフ) を実際に bot を動かさずに
// テストできる。無人運転で怖いのは判断の間違いであって、Discord API の使い方ではない。

import {
  DEFAULT_HARNESS_INTERVAL_MIN,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_JOBS_PER_DAY,
  DEFAULT_PLANNER_INTERVAL_MIN,
  DEFAULT_SCOUT_INTERVAL_MIN,
  DEFAULT_SCOUT_MAX_OPEN_TASKS,
  DEFAULT_TASK_JOB_BUDGET,
  MAX_CARRY_CHARS,
  MAX_CARRY_ITEMS,
  PLAN_EARLY_AFTER_IDLE_SCOUTS,
  SCOUT_IDLE_BACKOFF_STEPS,
} from './config.js';
import { jstDayKey } from './time.js';

/**
 * tick が選べる行動の種類。増やすときは設計 (§3.1) の裁定を経ること。
 * `harness` = ハーネスの改訂の巡回 (2026-10-12 作者裁定「自己改善させるには必要」、src/harness.js)
 * `plan` = 企画の巡回 (2026-10-12 作者裁定「種を考える部門を作って、考え抜いたものを自分で取り込める
 * ように」、src/themes.js)
 */
export const ACTION_KINDS = Object.freeze(['start-task', 'scout', 'harness', 'plan', 'initiative']);

/** ハーネスの改訂が終わっていない (測る前に次を重ねない) とみなす状態 = 終端 (merged / dropped) 以外 */
const UNFINISHED_STATES = Object.freeze(['proposed', 'approved', 'in-progress', 'review', 'blocked']);

/**
 * ハーネスの改訂 (役割文を触る) タスクか (src/harness.js)。改訂は 1 件ずつ測るので、
 * 終わっていない間は次の改訂を起こさない
 */
export function touchesHarness(task) {
  const touch = Array.isArray(task?.touch) ? task.touch : [];
  return touch.some((path) => /^roles[\\/]/.test(String(path ?? '').trim()));
}

/**
 * ハーネスの改訂の解き直しのタスクか (src/replay.js — replay 欄の of = 改訂のタスクの id)。
 * 判断の層が持つ物差し (src/replay.js・src/harness.js・src/taskstatus.js もここを使う)
 */
export function isReplayTask(task) {
  return typeof task?.replay?.of === 'string' && task.replay.of !== '';
}

/** 解き直しを待っている改訂か (着手の同時枠に数えない・見回りが固着と読まない — src/replay.js) */
export function awaitingReplays(task) {
  return task?.state === 'review' && task.replay?.status === 'running';
}

/**
 * 主題ファイルを触るタスクか (src/themes.js)。主題の取り込みは 1 件ずつ — 終わっていない間は
 * 次の企画の巡回を起こさない (承認待ちの主題に重ねて考えさせない)
 */
export function touchesThemes(task, themesFile) {
  const want = normalizeRelPath(themesFile);
  if (!want) return false;
  const touch = Array.isArray(task?.touch) ? task.touch : [];
  return touch.some((path) => normalizeRelPath(path) === want);
}

/** 相対パスの比較用 (区切りを / に、先頭の ./ を外す) */
function normalizeRelPath(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/** 「走っている」とみなす状態 (同時実行数はこの合計で数える) */
const RUNNING_STATES = Object.freeze(['in-progress', 'review']);

/** 「まだ着手されていない」とみなす状態 (スカウトの起票が溜まりすぎたかの判定) */
const OPEN_STATES = Object.freeze(['proposed', 'approved']);

/**
 * 起票 1 件に必ず積む job 予算の下限 (§9.2(b))。
 *
 * **worker 1 + review 1 + 予備 2。** スカウトの自己申告をそのまま通すと、3 ファイル新規の
 * タスクに 2 (= 予備 0) が付き、1 度でも詰まればその場で予算切れになる (#51 の実例)。
 * 差し戻しの追い予算 (`SEND_BACK_JOB_BUDGET`) は別枠なので、ここに数え込まない。
 *
 * **上限 (チャンネルの `taskJobBudget`) は超えない** — 下限は上限より弱い。
 */
export const MIN_TASK_JOB_BUDGET = 4;

/** 失敗 1 回目のバックオフ。以後 2 倍ずつ伸ばす */
export const BACKOFF_BASE_MS = 5 * 60 * 1000;

/** バックオフの上限 (§3.7「リミット検知で数時間停止」) */
export const BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * 呼び出し側が持つ勘定の初期値。
 * ブリッジ (M0-5) がチャンネルごとに 1 つ持ち、tick のたびに差し替える。
 */
export function initialState() {
  return {
    jobsToday: 0,
    dayKey: null,
    backoffUntil: 0,
    // 何回続けて失敗したか (指数バックオフの肩)。§3.7 の状態に足した勘定で、
    // これが無いと「伸ばす」ができない
    backoffLevel: 0,
    lastScoutAt: 0,
    // 提案 0 件で返った巡回が何回続いたか (スカウトの間隔を伸ばす肩 — recordScoutReport)。
    // そのチャンネルでタスクが merge されたら 0 へ戻す (planTick)
    scoutIdle: 0,
    // 最後の企画の巡回の後に、提案 0 件の巡回が何回あったか (企画の巡回を前倒しする勘定)
    scoutIdleSincePlan: 0,
    // 申し送り (src/config.js の MAX_CARRY_*)。巡回が書いた {at, from, text} を古い順に溜め、
    // 次の企画の巡回へ渡したら消す (addCarry / dropCarry)
    carry: [],
    // ハーネスの改訂の巡回 (src/harness.js) の最終実行時刻
    lastHarnessAt: 0,
    // 企画の巡回 (src/themes.js) の最終実行時刻
    lastPlanAt: 0,
    // 発議の巡回 (§3.9)。`lastRunAt` は `<botKey>/<dutyKey>` → 最終実行時刻 (間隔の時計)、
    // `spentToday` は botKey → 今日使った発議 job の数 (initiativeBudget の勘定)。
    // 日が変わったら消えるのは spentToday だけ — lastRunAt は暦日ではなく間隔で効く
    initiative: { lastRunAt: {}, spentToday: {} },
  };
}

/**
 * 再起動をまたいで持ち越す勘定 (§3.9「定期巡回の最終実行時刻と日次消費は永続化し、
 * 再起動直後の連発を防ぐ」)。
 *
 * **バックオフは持ち越さない。** あれは「いま失敗が続いている」という走っている
 * プロセスの観測で、暦や間隔の台帳ではない — 落ちて上がり直したなら数え直すのが正しい。
 */
export function persistedState(state) {
  const s = normalizeState(state);
  return {
    dayKey: s.dayKey,
    jobsToday: s.jobsToday,
    lastScoutAt: s.lastScoutAt,
    scoutIdle: s.scoutIdle,
    scoutIdleSincePlan: s.scoutIdleSincePlan,
    carry: s.carry,
    lastHarnessAt: s.lastHarnessAt,
    lastPlanAt: s.lastPlanAt,
    initiative: s.initiative,
  };
}

/** 永続化した勘定 → tick へ渡す state (壊れた値・欠けた値は初期値へ倒す) */
export function restoreState(saved) {
  return { ...normalizeState(saved), backoffUntil: 0, backoffLevel: 0 };
}

/**
 * 日次上限を数える単位。**JST の暦日**で切る (2026-08-28 裁定変更)。
 *
 * 元は UTC 暦日だった — ローカル時刻で切ると機械のタイムゾーン次第で「境目でだけ落ちる」
 * 壊れ方をするのを避けるため。JST を固定オフセットで刻む src/time.js を通せばその心配は
 * 無いまま、日付の変わり目が人間の「今日」と揃う (UTC のままだと区切りが JST 09:00 で、
 * 朝いちの巡回が前日の予算を食う)。
 */
export function dayKeyFor(now) {
  const key = jstDayKey(msOf(now));
  // msOf を通った後なのでここは通らない (Date が表せる範囲を外れた巨大な数だけ)
  if (key === null) {
    throw new Error(`now が暦日にできない値です (受け取った値: ${JSON.stringify(now)})`);
  }
  return key;
}

/** その失敗回数でのバックオフ長 (上限で頭打ち) */
export function backoffDelayMs(level) {
  const n = Number.isSafeInteger(level) && level > 0 ? level : 0;
  // 2 ** n を先に計算すると大きい level で Infinity になるので、指数の方を先に抑える
  if (n >= 32) return BACKOFF_MAX_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
}

/**
 * 失敗 (claude のリミットエラーなど) を記録し、バックオフを伸ばす。
 *
 * `until` (上限が明ける時刻 — `parseLimitReset` の戻り) が分かっていれば**そこまでは必ず待つ**。
 * 倍々の長さは上限の明けを知らないので、数時間の上限に 5 分・10 分・20 分で起こし直し、
 * 自動復旧の回数を明ける前に使い切った (#102、2026-10-07)。肩 (backoffLevel) の進め方は変えない。
 *
 * @param {object} state
 * @param {{now: number|Date, until?: number|null}} opts `until` は ms。数でなければ使わない
 * @returns {object} 新しい state (引数は変更しない)
 */
export function recordFailure(state, { now, until } = {}) {
  const at = msOf(now);
  const current = normalizeState(state);
  const doubled = at + backoffDelayMs(current.backoffLevel);
  return {
    ...current,
    backoffLevel: current.backoffLevel + 1,
    // 明ける時刻は BACKOFF_MAX_MS で切らない — 切ると明ける前に起こして、もう 1 回落ちる
    backoffUntil: Number.isFinite(until) ? Math.max(doubled, until) : doubled,
  };
}

/** `resets 1:30pm (Asia/Tokyo)` — 時刻の直前に日付が入る形 (`resets Oct 8, 1:30pm …`) は当たらない */
const LIMIT_RESET = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^()\s]+)\)/i;

/**
 * claude の利用上限の文面から、上限が明ける時刻を読む
 * (例: `You've hit your session limit · resets 1:30pm (Asia/Tokyo)`)。
 *
 * 時刻だけの表示は 24h ごとに同じ表示になって一意に決まらないので、**now から前後 12h (周期の半分) で
 * 最も近い出現**を指すと読む (等距離なら後の方)。それが now 以前 — 明けた直後にもう一度落ちた
 * (本当の明けは分の途中・時計のずれ・job の所要時間) — なら null で従来の倍々に任せる。
 * 依頼の字面「now より後で最初に来る」だと、ここを翌日と読んで約 24h 止まる (変更前は 10 分)。
 * 12h より先の明けも null になるが、倍々に戻るだけで変更前より悪くはない。
 * 日付付き・tz 無し・解決できない tz も null — 推し量って読むより、従来の倍々に任せる。
 * 前日・翌日はその tz の暦日をずらして組み直す (±24h だと夏時間の切り替わりの日にずれる)。
 *
 * @param {string} text
 * @param {number|Date} now
 * @returns {number|null} ms
 */
export function parseLimitReset(text, now) {
  const at = msOf(now);
  const match = typeof text === 'string' ? LIMIT_RESET.exec(text) : null;
  if (!match) return null;
  const [, h, mm, half, timeZone] = match;
  const hour12 = Number(h);
  const minute = mm === undefined ? 0 : Number(mm);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  let zone;
  try {
    // hourCycle: 'h23' — hour12: false だと深夜 0 時を "24" で返す版がある
    zone = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  } catch {
    return null; // 解決できない tz (RangeError)
  }
  const today = wallClock(zone, at);
  // 前日・当日・翌日のどれかが前後 12h に入る。後の候補を `<=` で採るので、等距離なら後の方
  let nearest = null;
  for (const days of [-1, 0, 1]) {
    const candidate = wallClockToMs(zone, today.year, today.month, today.day + days, hour, minute);
    if (nearest === null || Math.abs(candidate - at) <= Math.abs(nearest - at)) nearest = candidate;
  }
  return nearest > at ? nearest : null;
}

/** その瞬間の tz での壁時計 (月は 1 始まり) */
function wallClock(zone, ms) {
  const parts = {};
  for (const { type, value } of zone.formatToParts(ms)) parts[type] = Number(value);
  return parts;
}

/** その瞬間の tz の UTC からのずれ (ms)。壁時計は秒までなので、比べる側も秒に落とす */
function zoneOffsetMs(zone, ms) {
  const w = wallClock(zone, ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** tz の壁時計 → ms。ずれを 2 回取って、切り替わりをまたいだ仮置きを補正する (日の繰り上がりは Date.UTC に任せる) */
function wallClockToMs(zone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(zone, guess);
  return guess - zoneOffsetMs(zone, first);
}

/**
 * 成功を記録し、バックオフを解く。
 * **肩ごと 0 へ戻す** — 1 回でも通ったならリミットは明けているので、次の失敗は
 * また 5 分から数え直すのが正しい (前回の長さを引きずると復旧後も止まり続ける)。
 */
export function recordSuccess(state) {
  return { ...normalizeState(state), backoffLevel: 0, backoffUntil: 0 };
}

/**
 * この tick で起こす行動を選ぶ。
 *
 * @param {object} input
 * @param {object[]} input.tasks そのチャンネルのタスク (src/board.js の list() の結果)
 * @param {object} input.autonomy チャンネルの自律運転設定 (src/config.js の resolveAutonomy() の戻り)
 * @param {object[]} [input.dutyBots] duty を持つ bot (src/config.js の resolveDutyBots() の戻り)。
 *   **発議機構が無効なら呼び出し側が空配列を渡す** — この層は config を知らない
 * @param {object[]} [input.proposals] 終端でない提案 (ProposalStore.openList() の結果)。
 *   duty ごとの `maxOpenProposals` を数えるのに要る。裁定待ちを積んでも採否は速くならない
 * @param {{due: boolean}|null} [input.harness] ハーネスの改訂を起こしてよいか (src/harness.js の
 *   harnessGate の戻り)。実行記録を読むのは呼び出し側 — この層は台帳を知らない
 * @param {{due: boolean}|null} [input.plan] 企画の巡回を起こしてよいか (src/themes.js の themesGate の
 *   戻り)。主題ファイルを読むのは呼び出し側
 * @param {number|Date} input.now 現在時刻 (呼び出し側から注入する)
 * @param {object} input.state 呼び出し側が持つ勘定 (initialState() 参照)
 * @returns {{actions: object[], state: object}}
 *   actions は起こす順。`{kind:'start-task', taskId}` / `{kind:'scout'}` / `{kind:'harness'}` /
 *   `{kind:'plan'}` / `{kind:'initiative', botKey, duty}` の 5 種類だけ。企画の巡回を提案 0 件の巡回の
 *   続きで間隔より前に起こすときだけ `{kind:'plan', early: true, idleScouts}` (idleScouts = その回数)。
 *   state は次の tick へ渡す新しい勘定 (引数の state は変更しない)。
 */
export function planTick({
  tasks = [], autonomy = {}, dutyBots = [], proposals = [], harness = null, plan = null, now, state,
} = {}) {
  const at = msOf(now);
  // 日付の繰越だけは何もしない tick でも進める (止まっている間に日が変わっても数え直せる)
  const base = rollDay(normalizeState(state), at);
  const actions = [];
  const stop = (next = base) => ({ actions, state: next });

  if (autonomy?.enabled !== true) return stop();
  // バックオフ中。**明ける時刻ちょうどは通す** (境目で 1 tick 空振りしない)
  if (at < base.backoffUntil) return stop();

  // 担当不在なら何もしない。worker が居なければ着手できず、reviewer が居なければ
  // 着手しても main まで運べない (§3.6) — 走らせても review に溜まるだけなので、
  // 中途半端に始めずに止める
  const workers = Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : [];
  if (workers.length === 0 || !autonomy.reviewer) return stop();

  const maxJobs = positive(autonomy.maxJobsPerDay, DEFAULT_MAX_JOBS_PER_DAY);
  let jobsLeft = Math.max(0, maxJobs - base.jobsToday);
  if (jobsLeft === 0) return stop();

  const list = Array.isArray(tasks) ? tasks.filter(isTask) : [];

  // 1. 着手 — 進行中の仕事を進める方が、種を増やすより先。
  //    空き = 同時上限 - (in-progress + review)。**解き直しを待つ改訂 (src/replay.js) は数えない** —
  //    数えると同時上限 1 の配備で、改訂が枠を塞いだまま自分の解き直しを起こせない
  const running = list.filter((task) => RUNNING_STATES.includes(task.state) && !awaitingReplays(task)).length;
  const maxConcurrent = positive(autonomy.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  let free = Math.max(0, maxConcurrent - running);
  // board.list() は既に id 昇順だが、ここでも並べる (呼び出し側の順序に依存しない)。
  // 解き直しは先に起こす (改訂のレビューがそれを待っている)
  const approved = list.filter((task) => task.state === 'approved')
    .sort((a, b) => Number(isReplayTask(b)) - Number(isReplayTask(a)) || byTaskId(a, b));
  for (const task of approved) {
    if (free <= 0 || jobsLeft <= 0) break;
    actions.push({ kind: 'start-task', taskId: task.id });
    free -= 1;
    jobsLeft -= 1;
  }

  // 2. スカウト — 1 tick に 1 つだけ。未着手が溜まっているなら起票しない
  //    (承認待ちの山を作らせない。この数は**この tick で着手する分を引く前**の値で見る)。
  //    提案 0 件の巡回が続いたら間隔を伸ばす (scoutPace)。前の巡回の後にタスクが merge されたら
  //    元の間隔へ戻す — ボードと主題が動いたので、次の 1 歩が見えている見込みがある
  let { lastScoutAt, scoutIdle, scoutIdleSincePlan } = base;
  if (scoutIdle > 0 && list.some((task) => (mergedAt(task) ?? 0) > lastScoutAt)) scoutIdle = 0;
  const scoutBot = autonomy.scout?.bot;
  const intervalMs = scoutPace({ autonomy, idle: scoutIdle }).intervalMin * 60 * 1000;
  const open = list.filter((task) => OPEN_STATES.includes(task.state)).length;
  const maxOpen = positive(autonomy.scout?.maxOpenTasks, DEFAULT_SCOUT_MAX_OPEN_TASKS);
  const due = !lastScoutAt || at - lastScoutAt >= intervalMs;
  if (jobsLeft > 0 && scoutBot && due && open < maxOpen) {
    actions.push({ kind: 'scout' });
    jobsLeft -= 1;
    lastScoutAt = at;
  }

  // 3. ハーネスの改訂の巡回 (src/harness.js) — 1 tick に 1 つだけ。**測り終えるまで次を重ねない**:
  //    門 (harness.due) が閉じている間と、役割文を触るタスクが終わっていない間は起こさない
  //    (論文の改訂は「1 つ直す → 測る → 残すか戻す」の順。重ねると何が効いたか分からなくなる)
  let { lastHarnessAt } = base;
  const harnessBot = autonomy.harness?.bot;
  const harnessIntervalMs = positive(autonomy.harness?.intervalMin, DEFAULT_HARNESS_INTERVAL_MIN) * 60 * 1000;
  const harnessDue = !lastHarnessAt || at - lastHarnessAt >= harnessIntervalMs;
  const revising = list.some((task) => UNFINISHED_STATES.includes(task.state) && touchesHarness(task));
  if (jobsLeft > 0 && harnessBot && harnessDue && harness?.due === true && !revising) {
    actions.push({ kind: 'harness' });
    jobsLeft -= 1;
    lastHarnessAt = at;
  }

  // 4. 企画の巡回 (src/themes.js) — 1 tick に 1 つだけ。主題ファイルを触るタスクが終わるまで
  //    次を重ねない (承認待ちの主題に重ねて考えさせると、同じ主題が 2 回入る)
  let { lastPlanAt } = base;
  const planBot = autonomy.planner?.bot;
  const planIntervalMs = positive(autonomy.planner?.intervalMin, DEFAULT_PLANNER_INTERVAL_MIN) * 60 * 1000;
  const planDue = !lastPlanAt || at - lastPlanAt >= planIntervalMs;
  // 最後の企画の巡回の後に提案 0 件の巡回が続いたら、間隔を待たない (種が尽きたら種を考える部門を
  // 先に動かす)。前倒しの後はまた続けて数え直すので、0 件の巡回のたびに企画を起こしはしない
  const planEarly = !planDue && scoutIdleSincePlan >= PLAN_EARLY_AFTER_IDLE_SCOUTS;
  const themesFile = autonomy.planner?.themesFile;
  const planning = list.some((task) => UNFINISHED_STATES.includes(task.state) && touchesThemes(task, themesFile));
  if (jobsLeft > 0 && planBot && (planDue || planEarly) && plan?.due === true && !planning) {
    actions.push(planEarly ? { kind: 'plan', early: true, idleScouts: scoutIdleSincePlan } : { kind: 'plan' });
    jobsLeft -= 1;
    lastPlanAt = at;
    scoutIdleSincePlan = 0;
  }

  // 5. 発議の定期巡回 (§3.9) — 優先順位は start-task > scout > harness > plan > initiative。
  //    **いちばん後ろに置く**のは、進行中の仕事と種の発見が先だから。ここまでで
  //    日次上限を使い切っていれば、その日はもう巡回しない (共有の上限を分け合う)
  let { initiative } = base;
  if (jobsLeft > 0) {
    const picked = pickInitiative({ dutyBots, proposals, state: base, at });
    if (picked) {
      actions.push({ kind: 'initiative', botKey: picked.botKey, duty: picked.duty });
      // **最後の行動でも残数を引く。** ここだけ引かないでおくと、後ろに 4 つ目の行動を
      // 足したときに上限を 1 つ超える (規則が言うとおり今は誰も読まない値)
      // eslint-disable-next-line no-useless-assignment
      jobsLeft -= 1;
      initiative = spendInitiativeOn(initiative, picked.botKey, picked.duty, at);
    }
  }

  // 選んだ行動 1 つ = 1 job (実際に起動できたかは組み込み側の話で、ここでは数え切る)
  return stop({
    ...base,
    jobsToday: base.jobsToday + actions.length,
    lastScoutAt,
    scoutIdle,
    scoutIdleSincePlan,
    lastHarnessAt,
    lastPlanAt,
    initiative,
  });
}

/**
 * スカウトの間隔。提案 0 件の巡回が `idle` 回続いていたら、設定の間隔を 2 倍ずつ伸ばす
 * (`SCOUT_IDLE_BACKOFF_STEPS` 段で頭打ち)。起動文・ログ・企画の巡回の材料もここで揃える。
 *
 * @param {{autonomy?: object, idle?: number}} p
 * @returns {{baseMin: number, intervalMin: number}}
 */
export function scoutPace({ autonomy = {}, idle = 0 } = {}) {
  const baseMin = positive(autonomy?.scout?.intervalMin, DEFAULT_SCOUT_INTERVAL_MIN);
  const steps = Math.min(Number.isSafeInteger(idle) && idle > 0 ? idle : 0, SCOUT_IDLE_BACKOFF_STEPS);
  return { baseMin, intervalMin: baseMin * 2 ** steps };
}

/**
 * スカウトの巡回が返した提案の数を勘定へ入れる (src/bridge/scheduler.js の noteScoutReport が呼ぶ)。
 *
 * **数えるのは提案した数** (契約の tasks) で、ボードが載せた数ではない — touch の衝突や枠で
 * 断られた提案は「割る手が残っている」なので、そこで間隔を伸ばすと載せられる番を遅らせるだけになる。
 * 1 件でも提案があれば、続けての 0 件の勘定を両方 0 へ戻す。
 *
 * @param {object} state
 * @param {{proposed?: number}} p
 * @returns {object} 新しい state (引数は変更しない)
 */
export function recordScoutReport(state, { proposed } = {}) {
  const s = normalizeState(state);
  if (Number.isSafeInteger(proposed) && proposed > 0) return { ...s, scoutIdle: 0, scoutIdleSincePlan: 0 };
  return { ...s, scoutIdle: s.scoutIdle + 1, scoutIdleSincePlan: s.scoutIdleSincePlan + 1 };
}

/**
 * 申し送りを溜める (src/bridge/scheduler.js の noteCarry が呼ぶ)。1 件は空白を畳んで 1 行にし、
 * `MAX_CARRY_CHARS` 字で切る。空のものは落とす。溜めるのは `MAX_CARRY_ITEMS` 件までで、
 * 超えたら**古いものから**落とす (新しい気づきの方が今のループを指している)。
 *
 * @param {object} state
 * @param {{items?: string[], from?: string, at: number}} p
 * @returns {{state: object, added: number, dropped: number}} dropped = 上限で落とした古いものの数
 */
export function addCarry(state, { items = [], from = '', at } = {}) {
  const s = normalizeState(state);
  const fresh = carryList((Array.isArray(items) ? items : []).map((text) => ({ at, from, text })));
  const all = [...s.carry, ...fresh];
  const dropped = Math.max(0, all.length - MAX_CARRY_ITEMS);
  return { state: { ...s, carry: all.slice(dropped) }, added: fresh.length, dropped };
}

/**
 * 企画の巡回へ渡し終えた申し送りを消す。渡している間に増えた分は残す (同じ時刻・書き手・本文のものだけ消す)
 * @returns {object} 新しい state (引数は変更しない)
 */
export function dropCarry(state, shown = []) {
  const s = normalizeState(state);
  const key = (item) => `${item.at}\u0000${item.from}\u0000${item.text}`;
  const gone = new Set(carryList(shown).map(key));
  return { ...s, carry: s.carry.filter((item) => !gone.has(key(item))) };
}

/** 申し送りの並びを均す (形の崩れたものは落とす — 手で編集された・古い形の台帳を持ち越しても落ちない) */
function carryList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || !Number.isFinite(item.at) || item.at < 0) continue;
    out.push({
      at: item.at,
      from: typeof item.from === 'string' ? item.from : '',
      text: text.length > MAX_CARRY_CHARS ? `${text.slice(0, MAX_CARRY_CHARS - 1)}…` : text,
    });
  }
  return out.slice(-MAX_CARRY_ITEMS);
}

/** そのタスクが merged へ移った時刻 (history の最後の merged。無い・読めなければ null) */
function mergedAt(task) {
  if (task?.state !== 'merged') return null;
  const history = Array.isArray(task.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to !== 'merged') continue;
    const ms = Date.parse(String(history[i].at ?? ''));
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * この tick で巡回させる duty を 1 つ選ぶ (**1 tick に 1 つだけ** — scout と同じ流儀)。
 *
 * 選ぶ順は**最終実行が古い方から**。bot キーの固定順にすると、先頭の bot が毎回
 * 予算を先に取り、後ろの duty が一度も回らないまま日次上限に当たる。
 *
 * @returns {{botKey: string, duty: string}|null} 起こせるものが無ければ null
 */
function pickInitiative({ dutyBots, proposals, state, at }) {
  const due = [];
  for (const bot of Array.isArray(dutyBots) ? dutyBots : []) {
    if (!bot || typeof bot.botKey !== 'string' || bot.botKey === '') continue;
    // bot ごとの日次上限。**ノルマではなく上限**なので、越えたら黙って回さない
    if (!withinInitiativeBudget(state, bot.botKey, bot.initiativeBudget)) continue;
    for (const duty of Array.isArray(bot.duties) ? bot.duties : []) {
      if (!duty || typeof duty.key !== 'string' || duty.key === '') continue;
      const lastRunAt = state.initiative.lastRunAt[`${bot.botKey}/${duty.key}`] ?? 0;
      const intervalMs = positive(duty.intervalMin, 24 * 60) * 60 * 1000;
      // 一度も回っていない duty は「期限が来ている」扱い (初回を待たせない)
      if (lastRunAt && at - lastRunAt < intervalMs) continue;
      // 裁定待ちが溜まっている duty は回さない (積んでも採否は速くならない)
      if (openProposalsFor(proposals, bot.botKey, duty.key) >= positive(duty.maxOpenProposals, 2)) {
        continue;
      }
      due.push({ botKey: bot.botKey, duty: duty.key, lastRunAt });
    }
  }
  if (due.length === 0) return null;
  due.sort((a, b) => a.lastRunAt - b.lastRunAt
    || a.botKey.localeCompare(b.botKey)
    || a.duty.localeCompare(b.duty));
  return { botKey: due[0].botKey, duty: due[0].duty };
}

/**
 * 発議 job 1 本ぶんの勘定 (巡回もイベントも**同じ計算**を通す)。
 * `lastRunAt` を更新するのは、イベントで回ったばかりの duty へ定期巡回が
 * すぐ重ならないようにするため — どちらの経路で回っても「回った」ことに変わりはない。
 */
function spendInitiativeOn(initiative, botKey, duty, at) {
  return {
    lastRunAt: { ...initiative.lastRunAt, [`${botKey}/${duty}`]: at },
    spentToday: { ...initiative.spentToday, [botKey]: (initiative.spentToday[botKey] ?? 0) + 1 },
  };
}

/** その bot の今日の発議 job が上限に達していないか (巡回とイベントで共用する判定) */
function withinInitiativeBudget(state, botKey, budget) {
  return (state.initiative.spentToday[botKey] ?? 0) < positive(budget, 1);
}

/**
 * イベント経由 (§3.9 の発議 3 経路のうち (2)) で発議 job を 1 本使う。
 *
 * **巡回と同じ財布から出す。** イベントだけ無制限にすると、差し戻しが続いた日に
 * 発議 job が湧いてチャンネルの日次上限を食い潰す。間隔 (`intervalMin`) と
 * open 提案数は見ない — イベントは時計ではなく契機で、その duty が「今見るべき」
 * かどうかはイベントが起きたこと自体が示している。
 *
 * @returns {{ok: true, state: object} | {ok: false, reason: string, state: object}}
 */
export function chargeInitiative(state, {
  botKey, duty, budget = 1, maxJobsPerDay = null, now,
} = {}) {
  const at = msOf(now);
  const base = rollDay(normalizeState(state), at);
  if (typeof botKey !== 'string' || botKey === '' || typeof duty !== 'string' || duty === '') {
    return { ok: false, reason: '発議の勘定に botKey / duty がありません', state: base };
  }
  const cap = positive(maxJobsPerDay, DEFAULT_MAX_JOBS_PER_DAY);
  if (base.jobsToday >= cap) {
    return { ok: false, reason: `このチャンネルの日次上限 (${cap} job) に達しています`, state: base };
  }
  if (!withinInitiativeBudget(base, botKey, budget)) {
    return {
      ok: false,
      reason: `${botKey} の日次発議上限 (${positive(budget, 1)} job) に達しています`,
      state: base,
    };
  }
  return {
    ok: true,
    state: {
      ...base,
      jobsToday: base.jobsToday + 1,
      initiative: spendInitiativeOn(base.initiative, botKey, duty, at),
    },
  };
}

/**
 * その bot がその duty で持っている終端でない提案の数。
 * **追跡責任者 (`ownerBotKey`) で数える** — 起草者ではなく、いま面倒を見ている側の負荷が
 * 「これ以上抱えられるか」を決めるため (人事へ移管された提案は移管先の勘定になる)。
 */
function openProposalsFor(proposals, botKey, dutyKey) {
  return (Array.isArray(proposals) ? proposals : [])
    .filter((p) => p?.ownerBotKey === botKey && p?.input?.duty === dutyKey)
    .length;
}

/**
 * `start-task` を実際に適用できるかの判断 (純粋)。
 *
 * tick が行動を選んでから適用するまでの間に、ボードも起動中の bot も変わりうる。
 * **Discord を触る前にここで落とす**ので、判断の理由がテストで固定できる。
 *
 * 起動メッセージを投稿する担当 (announcer) を worker と別にするのは規律ではなく必然で、
 * 自分の多行発言は shouldIgnoreOwnMessage が捨てる (src/trigger.js) —
 * worker 自身の client から投げても job は立たない。既定は reviewer
 * (§3.6 で必ず居る) で、居なければ worker 以外の誰か。
 *
 * @param {object} action tick が返した行動
 * @param {{tasks?: object[], autonomy?: object, availableBotKeys?: string[]}} context
 * @returns {{ok: true, task: object, workerKey: string, announcerKey: string}
 *          | {ok: false, reason: string}}
 */
export function resolveStartTask(action, { tasks = [], autonomy = {}, availableBotKeys = [] } = {}) {
  if (action?.kind !== 'start-task') {
    return { ok: false, reason: `着手として適用できない行動です: ${JSON.stringify(action?.kind)}` };
  }
  const task = (Array.isArray(tasks) ? tasks : [])
    .find((t) => t && String(t.id) === String(action.taskId));
  if (!task) return { ok: false, reason: `タスク ${action.taskId} がボードにありません` };
  if (task.state !== 'approved') {
    return { ok: false, reason: `タスク ${task.id} は ${task.state} なので着手できません` };
  }

  const wanted = Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : [];
  const workerKey = pickWorker(autonomy, availableBotKeys);
  if (!workerKey) {
    return { ok: false, reason: `worker が起動していません (worker.bots: ${wanted.join(' / ') || '未設定'})` };
  }
  const announcerKey = pickAnnouncer(workerKey, autonomy, availableBotKeys);
  if (!announcerKey) {
    return {
      ok: false,
      reason: `起動メッセージを投げられる別の bot が居ません (${workerKey} 自身の発言では job が立たない)`,
    };
  }
  return { ok: true, task, workerKey, announcerKey };
}

/**
 * スカウト job へ払い出す固定の job 予算 (§3.3)。
 *
 * **小さくてよい**: 巡回して起票するだけで、実装のように往復しない。
 * それでも 0 ではなく予算を配るのは、無人スレッドを門番なしにしないため —
 * 予算を付けていないスレッドは hops の門番ごと不在 (実質無制限) になる。
 */
export const SCOUT_JOB_BUDGET = 3;

/**
 * `scout` を実際に適用できるかの判断 (純粋)。
 * 投げ手を担当と別にする理由は resolveStartTask と同じ。
 *
 * @returns {{ok: true, scoutKey: string, announcerKey: string} | {ok: false, reason: string}}
 */
export function resolveScout(action, { autonomy = {}, availableBotKeys = [] } = {}) {
  if (action?.kind !== 'scout') {
    return { ok: false, reason: `スカウトとして適用できない行動です: ${JSON.stringify(action?.kind)}` };
  }
  const scoutKey = autonomy.scout?.bot ?? null;
  if (!scoutKey || !availableBotKeys.includes(scoutKey)) {
    return { ok: false, reason: `スカウト担当が起動していません (scout.bot: ${scoutKey ?? '未設定'})` };
  }
  const announcerKey = pickAnnouncer(scoutKey, autonomy, availableBotKeys);
  if (!announcerKey) {
    return {
      ok: false,
      reason: `起動メッセージを投げられる別の bot が居ません (${scoutKey} 自身の発言では job が立たない)`,
    };
  }
  return { ok: true, scoutKey, announcerKey };
}

/**
 * `harness` を実際に適用できるかの判断 (純粋)。投げ手を担当と別にする理由は resolveScout と同じ。
 *
 * @returns {{ok: true, botKey: string, announcerKey: string} | {ok: false, reason: string}}
 */
export function resolveHarness(action, { autonomy = {}, availableBotKeys = [] } = {}) {
  if (action?.kind !== 'harness') {
    return { ok: false, reason: `ハーネスの改訂として適用できない行動です: ${JSON.stringify(action?.kind)}` };
  }
  const botKey = autonomy.harness?.bot ?? null;
  if (!botKey || !availableBotKeys.includes(botKey)) {
    return { ok: false, reason: `提案役が起動していません (harness.bot: ${botKey ?? '未設定'})` };
  }
  const announcerKey = pickAnnouncer(botKey, autonomy, availableBotKeys);
  if (!announcerKey) {
    return {
      ok: false,
      reason: `起動メッセージを投げられる別の bot が居ません (${botKey} 自身の発言では job が立たない)`,
    };
  }
  return { ok: true, botKey, announcerKey };
}

/**
 * `plan` を実際に適用できるかの判断 (純粋)。投げ手を担当と別にする理由は resolveScout と同じ。
 *
 * @returns {{ok: true, botKey: string, announcerKey: string} | {ok: false, reason: string}}
 */
export function resolvePlan(action, { autonomy = {}, availableBotKeys = [] } = {}) {
  if (action?.kind !== 'plan') {
    return { ok: false, reason: `企画の巡回として適用できない行動です: ${JSON.stringify(action?.kind)}` };
  }
  const botKey = autonomy.planner?.bot ?? null;
  if (!botKey || !availableBotKeys.includes(botKey)) {
    return { ok: false, reason: `企画役が起動していません (planner.bot: ${botKey ?? '未設定'})` };
  }
  const announcerKey = pickAnnouncer(botKey, autonomy, availableBotKeys);
  if (!announcerKey) {
    return {
      ok: false,
      reason: `起動メッセージを投げられる別の bot が居ません (${botKey} 自身の発言では job が立たない)`,
    };
  }
  return { ok: true, botKey, announcerKey };
}

/**
 * 発議の巡回へ払い出す固定の job 予算 (§3.9)。
 *
 * スカウトと同じ理由で小さい: 観測して発議するか「今回はなし」と言うだけで、
 * 実装のように往復しない。0 にしないのは無人スレッドを門番なしにしないため。
 */
export const INITIATIVE_JOB_BUDGET = 3;

/**
 * `initiative` を実際に適用できるかの判断 (純粋)。
 * 投げ手を担当と別にする理由は resolveStartTask / resolveScout と同じ。
 *
 * @returns {{ok: true, botKey: string, duty: string, announcerKey: string}
 *          | {ok: false, reason: string}}
 */
export function resolveInitiative(action, { autonomy = {}, availableBotKeys = [] } = {}) {
  if (action?.kind !== 'initiative') {
    return { ok: false, reason: `巡回として適用できない行動です: ${JSON.stringify(action?.kind)}` };
  }
  const botKey = typeof action.botKey === 'string' ? action.botKey : null;
  const duty = typeof action.duty === 'string' ? action.duty : null;
  if (!botKey || !duty) {
    return { ok: false, reason: `発議の巡回に botKey / duty がありません: ${JSON.stringify(action)}` };
  }
  if (!availableBotKeys.includes(botKey)) {
    return { ok: false, reason: `duty ${duty} の担当 ${botKey} が起動していません` };
  }
  const announcerKey = pickAnnouncer(botKey, autonomy, availableBotKeys);
  if (!announcerKey) {
    return {
      ok: false,
      reason: `起動メッセージを投げられる別の bot が居ません (${botKey} 自身の発言では job が立たない)`,
    };
  }
  return { ok: true, botKey, duty, announcerKey };
}

/**
 * イベント (§3.9 の発議 3 経路のうち (2)) を受け取るべき duty を選ぶ (純粋)。
 *
 * **起こす相手は「そのイベントを拾うと宣言した duty」だけ。** 全 bot へ配ると、
 * 差し戻し 1 回で社会中の bot が発議 job を立てる。宣言は
 * `bots.<key>.duties.<duty>.eventKinds` (§3.8)。
 *
 * **当事者は外す。** 差し戻された実装担当や、封鎖したレビュー担当を呼び戻しても、
 * 見えるのは自分の仕事の話であって組織の乖離ではない (当人の直しは board 側の経路が回す)。
 *
 * @param {string} eventKind `block` / `send-back` / `backoff`
 * @param {{dutyBots?: object[], availableBotKeys?: string[], excludeBotKeys?: string[]}} p
 * @returns {Array<{botKey: string, duty: string}>} bot キー昇順・1 bot につき 1 duty
 */
export function dutiesForEvent(eventKind, {
  dutyBots = [], availableBotKeys = [], excludeBotKeys = [],
} = {}) {
  const out = [];
  for (const bot of Array.isArray(dutyBots) ? dutyBots : []) {
    if (!bot || !availableBotKeys.includes(bot.botKey)) continue;
    if (excludeBotKeys.includes(bot.botKey)) continue;
    // 同じ bot が同じイベントを拾う duty を 2 つ持っていても、起こす job は 1 本
    // (2 本立てても観測する対象は同じで、予算だけが 2 倍に減る)
    const duty = (Array.isArray(bot.duties) ? bot.duties : [])
      .find((d) => Array.isArray(d?.eventKinds) && d.eventKinds.includes(eventKind));
    if (duty) out.push({ botKey: bot.botKey, duty: duty.key });
  }
  return out;
}

/**
 * 検査を通った task-proposal (src/contract.js) を、ボードの propose へ渡す形にする。
 *
 * **job 予算はチャンネルの `taskJobBudget` で頭打ちにする。** スカウトが書いた数字を
 * そのまま通すと、起票する側が自分の取り分を決められることになる — 提案は
 * 「これより少なくてよい」という申告としてだけ効かせる。
 *
 * **下限は `MIN_TASK_JOB_BUDGET`** (§9.2(b))。ただし cap を超えない — 上限を
 * 小さく設定したチャンネルで、下限が黙って上限を押し上げることはない。
 *
 * **`touch` はそのまま渡す。** 正規形の検査と拒否はボード側 (`requiredTouch` —
 * src/board.js) に一本化する — 「起票できる touch」と「保存される touch」が
 * 2 か所で決まると、片方だけ緩めたときに宣言の無いタスクが載る。
 *
 * @param {object} contract validateContract を通った task-proposal
 * @param {{channel: string, taskJobBudget?: number}} options
 * @returns {Array<{channel: string, title: string, rationale: string, jobBudget: number,
 *                  touch: string[]}>}
 */
export function proposedTasks(contract, { channel, taskJobBudget } = {}) {
  const cap = positive(taskJobBudget, DEFAULT_TASK_JOB_BUDGET);
  const list = Array.isArray(contract?.tasks) ? contract.tasks : [];
  return list.map((task) => ({
    channel,
    title: String(task?.title ?? ''),
    rationale: String(task?.rationale ?? ''),
    jobBudget: Math.min(Math.max(positive(task?.job_budget, cap), MIN_TASK_JOB_BUDGET), cap),
    touch: Array.isArray(task?.touch) ? [...task.touch] : [],
  }));
}

/** 承認で触れられなかったタスクを破棄するときの理由 */
export const UNMENTIONED_REASON = '承認で言及されず';

/**
 * 承認の応答 (task-approval) を、ボードへの操作に翻訳する (純粋)。
 *
 * **今回の契約に載っている id だけを動かす。** 承認する側が別のタスクの id を
 * 書いてきても効かせない — 承認 job が「ボード全体を触れる口」になると、
 * 誰がいつ何を落としたのかが追えなくなる。
 *
 * **言及されなかった id は破棄する** (裁定 2026-08-27)。承認待ちのまま残すと、
 * 誰も見ない proposed が積み上がってスカウトの起票枠 (maxOpenTasks) を塞ぐ。
 * 本当に要るものは dropped が一覧に出ないので、次の巡回でまた起票される。
 *
 * @param {object} contract validateContract を通った task-approval の応答
 * @param {{pending?: object[]}} options 今回の契約が載せていた承認待ち一覧
 * @returns {{approve: string[], drop: Array<{id: string, reason: string}>, errors: string[]}}
 */
export function planApproval(contract, { pending = [] } = {}) {
  const known = [];
  for (const task of Array.isArray(pending) ? pending : []) {
    const id = idOf(task?.id);
    if (id && !known.includes(id)) known.push(id);
  }

  const errors = [];
  const seen = new Set();
  const claim = (rawId, where) => {
    const id = idOf(rawId);
    if (!id) {
      errors.push(`${where}: id が空です (${JSON.stringify(rawId)})`);
      return null;
    }
    if (!known.includes(id)) {
      errors.push(`${where}: 知らない id ${id} — 今回の承認対象に含まれていないので何もしません`);
      return null;
    }
    if (seen.has(id)) {
      errors.push(`${where}: id ${id} が二度出てきます — 先に書かれた方だけを適用します`);
      return null;
    }
    seen.add(id);
    return id;
  };

  // **破棄を先に見る。** 承認と破棄の両方に書かれた id は落とす側へ倒す
  // (通してしまうと着手が始まり、取り消しが効かない)
  const drop = [];
  for (const item of Array.isArray(contract?.drop) ? contract.drop : []) {
    const id = claim(item?.id, '破棄');
    if (id) drop.push({ id, reason: String(item?.reason ?? '').trim() || '理由の記載なし' });
  }
  const approve = [];
  for (const raw of Array.isArray(contract?.approve) ? contract.approve : []) {
    const id = claim(raw, '承認');
    if (id) approve.push(id);
  }
  for (const id of known) {
    if (!seen.has(id)) drop.push({ id, reason: UNMENTIONED_REASON });
  }
  return { approve, drop, errors };
}

/**
 * worker のターンが「完了申告」かどうか (§3.5)。
 *
 * **完了は「制御フッタの無い report」だけ。** 自己呼び出しで区切った途中報告も、
 * 上位へのエスカレーションもフッタを持つので、そこでレビューへ進めてしまうと
 * 「まだ書いている途中のものを検収させる」ことになる。
 * verify が落ちている報告も完了ではない — handoff が止まっているだけで、直す番。
 *
 * **報告した bot が担当かどうかも見る** (2026-09-01 裁定)。#46 は reviewer の
 * フッタ無し報告が worker の完了と数えられ、`requestReview` が自己レビュー禁止で
 * 契約を作らないまま review に固着した。担当が分からない報告 (`workerBotKeys` が
 * 空・非配列) も完了にしない — **fail-closed**。
 *
 * `botKey` を渡さなければ従来どおり (担当を知らない呼び出し側の挙動を変えない)。
 *
 * @param {{kind?: string, hasHandoff?: boolean, verifyOk?: boolean, taskState?: string|null,
 *          botKey?: string|null, workerBotKeys?: string[]|null}} p
 */
export function isTaskDone({
  kind, hasHandoff = false, verifyOk = true, taskState = null,
  botKey = null, workerBotKeys = null,
} = {}) {
  if (kind !== 'report' || hasHandoff || verifyOk === false) return false;
  if (taskState !== 'in-progress') return false;
  if (botKey === null || botKey === undefined) return true;
  if (!Array.isArray(workerBotKeys) || workerBotKeys.length === 0) return false;
  return workerBotKeys.includes(botKey);
}

/**
 * `/review` でレビューを出し直してよいか (2026-09-01 裁定 A)。
 *
 * **人間が board を動かす唯一の口**なので、判断はここに置いてテストする。
 * 出し直せるのは **review で止まっているもの**だけ: in-progress を出し直すと
 * 書いている途中のものを検収させることになり、merged / dropped はもう終わっている。
 *
 * id を書いたときにスレッドのタスクと違えば断る — 打った人が別のタスクのつもりで
 * いるということなので、黙ってこのスレッドのタスクを出し直さない。
 *
 * @param {{task?: object|null, id?: string|null}} p `id` は打った人が書いた id (任意)
 * @returns {{ok: boolean, reason: string}} reason はそのまま Discord へ出る 1 行
 */
export function planReissueReview({ task = null, id = null } = {}) {
  const wanted = String(id ?? '').trim();
  if (!task || typeof task !== 'object' || !task.id) {
    return {
      ok: false,
      reason: 'このスレッドに対応するタスクがありません (タスクのスレッドで打ってください)',
    };
  }
  const taskId = String(task.id);
  if (wanted !== '' && wanted !== taskId) {
    return {
      ok: false,
      reason: `このスレッドのタスクは #${taskId} です (#${wanted} のスレッドで打ってください)`,
    };
  }
  if (task.state !== 'review') {
    const hint = task.state === 'in-progress' ? ' (実装が続いているなら担当をメンションしてください)' : '';
    return { ok: false, reason: `#${taskId} は ${task.state} です — 出し直せるのは review だけ${hint}` };
  }
  return { ok: true, reason: `#${taskId} のレビューを出し直しました` };
}

/** 追い予算を出して差し戻すときに積む job 数 (直して出し直すのに要る最小限) */
export const SEND_BACK_JOB_BUDGET = 2;

/**
 * レビューの判定 (task-review) を、ボードへの操作に翻訳する (純粋)。
 *
 * **差し戻しは 2 回まで** (§6)。2 回目は直させずに要人間へ落とす — 同じところで
 * 往復し続けるのが、無人運転でいちばん静かに job を溶かす壊れ方だから。
 * 何回目かはボードの履歴が持っているので、数えた結果だけを受け取る
 * (ここから board を触らない = 判断の層に IO を持ち込まない)。
 *
 * **`drop` は差し戻し回数と関係なく通す** (§9.4)。「対象が不要」は仕事の質の話ではなく
 * 重複や着地済みの後始末なので、往復の勘定に混ぜない。
 *
 * **`merge` は git の事実で裏を取ってから通す** (§12.3 (2))。ここは判断の層なので
 * git は呼ばない — 呼び出し側 (`src/bridge/board.js` の `applyReview`) が集めた事実を
 * 受け取り、4 つ (マージコミットが実在する / base に到達可能 / 枝の先端が読める /
 * 枝の成果がそのコミットに入っている) が揃ったときだけ `complete`。**事実を渡さない
 * 呼び出しは `hold`** — 「照合していない」を「照合できた」へ倒さない。
 *
 * @param {object} contract validateContract を通った task-review の応答
 * @param {object} options
 * @param {number} [options.sendBackCount] これまでの差し戻し回数
 * @param {?{commit: ?string, commitInBase: ?boolean, branchTip: ?string,
 *           branchTipInCommit: ?boolean, baseBranch?: string, baseHead?: ?string,
 *           branch?: string}} [options.git] merge の照合に使う git の事実
 *           (null / 不明 = 確かめられなかった)
 * @param {string} [options.mergeCheckedBy] merge の照合を**別経路が持つ**ときだけ、その名前。
 *           適用 task (org-apply) は `src/apply.js` の `planMerge` が OID・verify・枝の先端まで
 *           見てからブリッジ自身が merge を打つので、ここで二重に git を要求しない (§12.3 (2))
 * @returns {{action: 'complete'|'hold'|'send-back'|'block'|'drop'|'none', note?: string,
 *           reason?: string, error?: string}}
 */
export function planReview(contract, { sendBackCount = 0, git = null, mergeCheckedBy = '' } = {}) {
  const verdict = contract?.verdict;
  const reason = String(contract?.reason ?? '').trim() || '理由の記載なし';
  if (verdict === 'merge') return planMergeVerdict(contract, { git, mergeCheckedBy });
  if (verdict === 'block') return { action: 'block', reason };
  if (verdict === 'drop') return { action: 'drop', reason };
  if (verdict === 'send-back') {
    const done = Number.isSafeInteger(sendBackCount) && sendBackCount > 0 ? sendBackCount : 0;
    return done >= 1
      ? { action: 'block', reason: `差し戻し 2 回目 — ${reason}` }
      : { action: 'send-back', reason };
  }
  return { action: 'none', error: `知らない判定です: ${JSON.stringify(verdict)}` };
}

/** ログとスレッドに出す短縮 OID (12 桁 — 人が目で突き合わせるのに足りる長さ) */
const shortOid = (oid) => String(oid ?? '').slice(0, 12);

/**
 * `merge` の判定 (planReview の一部)。**照合できたときだけ完了へ倒す。**
 *
 * 揃わなかったものは `hold` = 遷移しない。差し戻し (`send-back`) にしないのは、
 * 「実装が足りない」ではなく「検収の申告を確かめられなかった」だから — 直す先は
 * 実装ではなく、取り込みの手順か申告の SHA になる。
 */
function planMergeVerdict(contract, { git = null, mergeCheckedBy = '' } = {}) {
  const sha = String(contract?.merge_commit ?? '').trim();
  // 別経路が照合してから merge を打つ (適用 task)。ここでの git の事実は要らない
  if (mergeCheckedBy) {
    return { action: 'complete', note: `merge${sha ? ` ${sha}` : ''} (${mergeCheckedBy} が照合)` };
  }
  const facts = git && typeof git === 'object' ? git : {};
  const baseBranch = String(facts.baseBranch ?? '').trim() || 'base';
  const branch = String(facts.branch ?? '').trim() || 'ブランチ';
  const commit = typeof facts.commit === 'string' ? facts.commit.trim() : '';
  const tip = typeof facts.branchTip === 'string' ? facts.branchTip.trim() : '';
  if (!commit) {
    return {
      action: 'hold',
      reason: sha
        ? `マージコミット ${sha} が git に見つかりません`
        : 'マージコミット (merge_commit) の記載がないので取り込みを確かめられません',
    };
  }
  const missing = [];
  if (facts.commitInBase !== true) missing.push(`${shortOid(commit)} が ${baseBranch} に入っていません`);
  if (!tip) missing.push(`ブランチ ${branch} が見つかりません (枝の成果を照合できません)`);
  else if (facts.branchTipInCommit !== true) {
    missing.push(`ブランチ ${branch} の先端 ${shortOid(tip)} が ${shortOid(commit)} に入っていません`);
  }
  if (missing.length > 0) return { action: 'hold', reason: missing.join(' / ') };
  const baseHead = typeof facts.baseHead === 'string' && facts.baseHead.trim() ? facts.baseHead.trim() : '不明';
  return {
    action: 'complete',
    note: `merge ${commit} (base ${baseBranch}@${baseHead}, branch ${branch}@${tip})`,
  };
}

/**
 * job の終了理由 → バックオフの記録 (§3.7)。
 *
 * 数えるのは**ランタイムが動かなかったこと**だけ。verify NG は CLI が正しく動いた
 * 結果なので成功側 — テストが落ちるたびに社会が数時間止まると、直す機会まで失う。
 * 中断や配信失敗はどちらでもない (リミットの証拠にならない)。
 *
 * @returns {'failure'|'success'|null}
 */
export function backoffOutcome(reason) {
  if (typeof reason !== 'string' || reason === '') return null;
  if (reason === 'internal-error' || reason.startsWith('failed(')) return 'failure';
  if (reason === 'ok' || reason === 'verify-failed') return 'success';
  return null;
}

/**
 * その job の終了理由を**チャンネルのバックオフへ反映してよいか** (§3.7)。
 *
 * `backoffOutcome` が「理由の読み方」だけを見るのに対し、こちらは
 * 「その job が証拠として使えるか」まで含めて決める。除くのは 2 つ:
 *
 * - **予算を配っていないスレッド** — 人間が回している job の失敗で社会を止めない。
 * - **発議 (initiative) の job** (sol 指摘 2026-08-30) — バックオフはチャンネル単位の
 *   勘定なので、`recordSuccess` は誰の成功でも解いてしまう。発議 job は失敗した bot
 *   とは**別の bot**が観測のために走らせるものなので、それが通っても「リミットが
 *   明けた」の証拠にならない (「Opus がリミット → Fable の観測 job が成功 →
 *   次の tick で Opus を再起動」で保護が消える)。失敗も同じ理由で数えない —
 *   本当に全体が落ちているなら、着手や巡回の job が同じ理由で落ちて記帳される。
 *
 * @returns {'failure'|'success'|null} null = このバックオフ勘定は動かさない
 */
export function backoffOutcomeFor(reason, { hasTaskBudget = true, isInitiative = false } = {}) {
  if (!hasTaskBudget || isInitiative) return null;
  return backoffOutcome(reason);
}

/**
 * 発議機構が起こした job の目印 (sol 指摘 2026-08-30)。
 *
 * **スレッド単位では足りない。** 裁定の依頼は通常のタスクスレッドへも出る
 * (タスクの report が発議したとき) ので、「発議スレッドの job か」で判定すると、
 * そのタスクスレッドで裁定 job が成功した時点でチャンネルのバックオフが解ける。
 * 目印を**起動メッセージ本文**へ載せて job 単位で見れば、同じスレッドに通常の job と
 * 発議 job が混ざっても取り違えない (様式タグと同じ流儀で、起動には関与しない)。
 */
const INITIATIVE_TAG = /`発議:(巡回|裁定)`/;

/** @param {'巡回'|'裁定'} kind */
export function formatInitiativeTag(kind) {
  return kind === '巡回' || kind === '裁定' ? `\`発議:${kind}\`` : '';
}

/** その投稿は発議機構が起こしたものか (バックオフの証拠に数えない印) */
export function isInitiativeTrigger(content) {
  return INITIATIVE_TAG.test(String(content ?? ''));
}

/**
 * 裁定待ちの提案を**いま配ってよいか** (§3.9 の生存性 — sol 指摘 2026-08-30)。
 *
 * 判断は 3 つ:
 * - 上限まで試したら止める (以後は人間の出番 — §6 の「要人間」)
 * - 一度も試していなければ配る
 * - **配れた後も、猶予を過ぎてまだ裁定待ちなら配り直す。** 投稿できたことは
 *   「裁定された」ではない — 起こした job が rate limit・中断・様式不履行で
 *   終わると、提案は `deliberating` のまま誰も触らなくなる。配れなかったときは
 *   相手が落ちているだけなので、短い間隔で試し直す
 *
 * @param {{delivered?: boolean, attempts?: number, lastAt?: number}} record 配送記録
 * @param {{now: number, redeliverMs: number, timeoutMs: number, maxAttempts: number}} p
 * @returns {{deliver: boolean, reason?: 'attempts'|'wait'}}
 */
export function shouldDeliverProposal(record = {}, {
  now, redeliverMs, timeoutMs, maxAttempts,
} = {}) {
  const attempts = counter(record?.attempts, 0);
  if (attempts >= positive(maxAttempts, 1)) return { deliver: false, reason: 'attempts' };
  const lastAt = counter(record?.lastAt, 0);
  if (lastAt === 0) return { deliver: true };
  const wait = record?.delivered === true
    ? positive(timeoutMs, 30 * 60 * 1000)
    : positive(redeliverMs, 10 * 60 * 1000);
  // 境目ちょうどは通す (1 tick 空振りしない — planTick のバックオフと同じ流儀)
  return msOf(now) - lastAt >= wait ? { deliver: true } : { deliver: false, reason: 'wait' };
}

/** ボードの id は文字列。数値で書かれても拾う (書き手が数え番号として書きがち) */
function idOf(value) {
  if (typeof value === 'string') return value.trim();
  return Number.isSafeInteger(value) ? String(value) : '';
}

/**
 * 実装を担当する bot。**worker.bots の先頭から、いま起動しているものを採る**
 * (落ちている bot が 1 体あるだけで社会が止まらないように)。
 * 着手のときも差し戻しのときも同じ順で選ぶので、同じスレッドには同じ担当が戻る。
 */
export function pickWorker(autonomy, availableBotKeys = []) {
  const wanted = Array.isArray(autonomy?.worker?.bots) ? autonomy.worker.bots : [];
  return wanted.find((key) => availableBotKeys.includes(key)) ?? null;
}

/**
 * 起動メッセージの投げ手。**担当自身は選ばない** — 自分の多行発言は
 * shouldIgnoreOwnMessage が捨てる (src/trigger.js) ので、投げても job が立たない。
 * 既定は reviewer (§3.6 で必ず居る)、居なければ担当以外の誰か。
 */
export function pickAnnouncer(targetKey, autonomy, availableBotKeys) {
  return [autonomy.reviewer, ...availableBotKeys]
    .find((key) => key && key !== targetKey && availableBotKeys.includes(key)) ?? null;
}

/**
 * タスクのスレッドで走る job が、どの作業ディレクトリを使うか (§8-2)。
 *
 * 既定は**タスクごとの作業ツリー**。#9 が blocked になった「未マージのブランチの上に
 * 積まれる」は並行実行ではなく 1 つの作業ツリーを使い回す構造から出ていたので、
 * 直列のままでもここで断つ。
 *
 * **レビュー担当だけは本体で走る** (裁定 2026-08-28)。昇格先の main は本体の
 * チェックアウトにあり、worktree から見れば cwd の外 — §6 の禁則「書込みは対象
 * リポジトリ内のみ・cwd 固定」と揉めずに merge できるのは本体側だけ。
 *
 * @returns {{useWorktree: boolean, reason?: string, taskId?: any, branch?: string, base?: string}}
 */
export function planTaskCwd({ task = null, autonomy = {}, botKey = null } = {}) {
  if (!task) return { useWorktree: false, reason: 'タスクのスレッドではない' };
  if (autonomy.enabled !== true) return { useWorktree: false, reason: '自律運転が無効' };
  if (botKey !== null && botKey === autonomy.reviewer) {
    return {
      useWorktree: false,
      reason: 'レビュー担当は本体で走る (昇格の merge 先が cwd の外に出ないように)',
    };
  }
  const branch = typeof task.branch === 'string' && task.branch.trim() !== ''
    ? task.branch.trim()
    : `task/${task.id}`;
  // 解き直し (src/replay.js) は元のタスクが始まった版から生やす
  const base = isReplayTask(task) && typeof task.replay.base === 'string' && task.replay.base !== ''
    ? task.replay.base
    : autonomy.baseBranch;
  return { useWorktree: true, taskId: task.id, branch, base };
}

/**
 * 今日の自律 job の残り (§11.4 — 自動復旧の門)。**日付を繰り越してから**数える。
 * @returns {{left: number, state: object}} state は繰越後の勘定 (呼び出し側が保存してよい)
 */
export function jobsLeftToday(state, { maxJobsPerDay = DEFAULT_MAX_JOBS_PER_DAY, now } = {}) {
  const base = rollDay(normalizeState(state), msOf(now));
  return { left: Math.max(0, positive(maxJobsPerDay, DEFAULT_MAX_JOBS_PER_DAY) - base.jobsToday), state: base };
}

/**
 * 自律 job を 1 本 (以上) 予約する — 通常の着手 (`planTick` の行動) と同じ勘定 `jobsToday` を使う。
 * 自動復旧の起動もここを通し、日次上限の判断を一つの正本に揃える (レビュー指摘 2026-09-05)。
 * @returns {object} 新しい勘定 (引数は変更しない)
 */
export function chargeJobs(state, { now, count = 1 } = {}) {
  const base = rollDay(normalizeState(state), msOf(now));
  const n = Number.isSafeInteger(count) && count > 0 ? count : 1;
  return { ...base, jobsToday: base.jobsToday + n };
}

/**
 * 予約を戻す。**確実に送れなかったときだけ**使う — 送達不明で戻すと、届いていた場合に
 * 日次上限を 1 本超える。0 未満にはしない
 */
export function refundJobs(state, { now, count = 1 } = {}) {
  const base = rollDay(normalizeState(state), msOf(now));
  const n = Number.isSafeInteger(count) && count > 0 ? count : 1;
  return { ...base, jobsToday: Math.max(0, base.jobsToday - n) };
}

/**
 * 日が変わっていれば今日の勘定を 0 へ戻す。
 *
 * **戻すのは日次の勘定だけ** — `initiative.lastRunAt` は暦日ではなく間隔で効く時計なので
 * 残す (日付が変わった瞬間に全 duty の巡回が一斉に来ないように)。
 */
function rollDay(state, at) {
  const dayKey = dayKeyFor(at);
  if (state.dayKey === dayKey) return state;
  return {
    ...state,
    dayKey,
    jobsToday: 0,
    initiative: { lastRunAt: state.initiative.lastRunAt, spentToday: {} },
  };
}

/** 欠けた値・壊れた値は初期値へ倒す (途中で形が変わった state を持ち越しても落ちない) */
function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const init = initialState();
  return {
    jobsToday: counter(s.jobsToday, init.jobsToday),
    dayKey: typeof s.dayKey === 'string' ? s.dayKey : init.dayKey,
    backoffUntil: counter(s.backoffUntil, init.backoffUntil),
    backoffLevel: counter(s.backoffLevel, init.backoffLevel),
    lastScoutAt: counter(s.lastScoutAt, init.lastScoutAt),
    scoutIdle: Number.isSafeInteger(s.scoutIdle) && s.scoutIdle >= 0 ? s.scoutIdle : init.scoutIdle,
    scoutIdleSincePlan: Number.isSafeInteger(s.scoutIdleSincePlan) && s.scoutIdleSincePlan >= 0
      ? s.scoutIdleSincePlan
      : init.scoutIdleSincePlan,
    carry: carryList(s.carry),
    lastHarnessAt: counter(s.lastHarnessAt, init.lastHarnessAt),
    lastPlanAt: counter(s.lastPlanAt, init.lastPlanAt),
    initiative: {
      lastRunAt: counterMap(s.initiative?.lastRunAt),
      spentToday: counterMap(s.initiative?.spentToday),
    },
  };
}

/**
 * `キー → 0 以上の数` だけを残す (手で編集された・古い形の勘定を持ち越しても落ちない)。
 * 壊れた値を 0 にせず**落とす**のは、`lastRunAt` では 0 が「一度も回っていない」=
 * 「すぐ回してよい」を意味するため — 壊れた時刻を 0 に丸めると巡回が 1 回余計に走る。
 */
function counterMap(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, n] of Object.entries(value)) {
    if (typeof key === 'string' && key !== '' && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function counter(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isTask(task) {
  return task && typeof task === 'object' && typeof task.state === 'string';
}

/** id 昇順 (連番は数として、そうでないものは文字列として) */
function byTaskId(a, b) {
  const diff = (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0);
  return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
}

/** now はミリ秒 (または Date)。壊れた値で黙って 1970 年として動かない */
function msOf(now) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) {
    throw new Error(`now はミリ秒か Date で渡してください (受け取った値: ${JSON.stringify(now)})`);
  }
  return at;
}
