// スケジューラの判断。
//
// **ここに置くのは純粋関数だけ。** 時計を内部で読まず `now` を引数で受け、
// Discord にもファイルにもボードにも書かない — 「いま何を起こすべきか」を選ぶところまでが
// この層の仕事で、スレッド作成・起動メンション・ボードの更新は組み込み側 (M0-5) が行う。
//
// こう切っておくと、社会の挙動 (ペース・同時数・バックオフ) を実際に bot を動かさずに
// テストできる。無人運転で怖いのは判断の間違いであって、Discord API の使い方ではない。

import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_JOBS_PER_DAY,
  DEFAULT_SCOUT_INTERVAL_MIN,
  DEFAULT_SCOUT_MAX_OPEN_TASKS,
  DEFAULT_TASK_JOB_BUDGET,
} from './config.js';
import { jstDayKey } from './time.js';

/** tick が選べる行動の種類。増やすときは設計の裁定を経ること */
export const ACTION_KINDS = Object.freeze(['start-task', 'scout', 'initiative']);

/** 「走っている」とみなす状態 (同時実行数はこの合計で数える) */
const RUNNING_STATES = Object.freeze(['in-progress', 'review']);

/** 「まだ着手されていない」とみなす状態 (スカウトの起票が溜まりすぎたかの判定) */
const OPEN_STATES = Object.freeze(['proposed', 'approved']);

/**
 * 起票 1 件に必ず積む job 予算の下限。
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

/** バックオフの上限 (「リミット検知で数時間停止」) */
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
    // 何回続けて失敗したか (指数バックオフの肩)。自律運転の状態に足した勘定で、
    // これが無いと「伸ばす」ができない
    backoffLevel: 0,
    lastScoutAt: 0,
    // 発議の巡回。`lastRunAt` は `<botKey>/<dutyKey>` → 最終実行時刻 (間隔の時計)、
    // `spentToday` は botKey → 今日使った発議 job の数 (initiativeBudget の勘定)。
    // 日が変わったら消えるのは spentToday だけ — lastRunAt は暦日ではなく間隔で効く
    initiative: { lastRunAt: {}, spentToday: {} },
  };
}

/**
 * 再起動をまたいで持ち越す勘定 (「定期巡回の最終実行時刻と日次消費は永続化し、
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
 * @returns {object} 新しい state (引数は変更しない)
 */
export function recordFailure(state, { now } = {}) {
  const at = msOf(now);
  const current = normalizeState(state);
  return {
    ...current,
    backoffLevel: current.backoffLevel + 1,
    backoffUntil: at + backoffDelayMs(current.backoffLevel),
  };
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
 * @param {number|Date} input.now 現在時刻 (呼び出し側から注入する)
 * @param {object} input.state 呼び出し側が持つ勘定 (initialState() 参照)
 * @returns {{actions: object[], state: object}}
 *   actions は起こす順。`{kind:'start-task', taskId}` / `{kind:'scout'}` /
 *   `{kind:'initiative', botKey, duty}` の 3 種類だけ。
 *   state は次の tick へ渡す新しい勘定 (引数の state は変更しない)。
 */
export function planTick({
  tasks = [], autonomy = {}, dutyBots = [], proposals = [], now, state,
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
  // 着手しても main まで運べない — 走らせても review に溜まるだけなので、
  // 中途半端に始めずに止める
  const workers = Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : [];
  if (workers.length === 0 || !autonomy.reviewer) return stop();

  const maxJobs = positive(autonomy.maxJobsPerDay, DEFAULT_MAX_JOBS_PER_DAY);
  let jobsLeft = Math.max(0, maxJobs - base.jobsToday);
  if (jobsLeft === 0) return stop();

  const list = Array.isArray(tasks) ? tasks.filter(isTask) : [];

  // 1. 着手 — 進行中の仕事を進める方が、種を増やすより先。
  //    空き = 同時上限 - (in-progress + review)
  const running = list.filter((task) => RUNNING_STATES.includes(task.state)).length;
  const maxConcurrent = positive(autonomy.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  let free = Math.max(0, maxConcurrent - running);
  // board.list() は既に id 昇順だが、ここでも並べる (呼び出し側の順序に依存しない)
  const approved = list.filter((task) => task.state === 'approved').sort(byTaskId);
  for (const task of approved) {
    if (free <= 0 || jobsLeft <= 0) break;
    actions.push({ kind: 'start-task', taskId: task.id });
    free -= 1;
    jobsLeft -= 1;
  }

  // 2. スカウト — 1 tick に 1 つだけ。未着手が溜まっているなら起票しない
  //    (承認待ちの山を作らせない。この数は**この tick で着手する分を引く前**の値で見る)
  let { lastScoutAt } = base;
  const scoutBot = autonomy.scout?.bot;
  const intervalMs = positive(autonomy.scout?.intervalMin, DEFAULT_SCOUT_INTERVAL_MIN) * 60 * 1000;
  const open = list.filter((task) => OPEN_STATES.includes(task.state)).length;
  const maxOpen = positive(autonomy.scout?.maxOpenTasks, DEFAULT_SCOUT_MAX_OPEN_TASKS);
  const due = !lastScoutAt || at - lastScoutAt >= intervalMs;
  if (jobsLeft > 0 && scoutBot && due && open < maxOpen) {
    actions.push({ kind: 'scout' });
    jobsLeft -= 1;
    lastScoutAt = at;
  }

  // 3. 発議の定期巡回 — 優先順位は start-task > scout > initiative。
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
  return stop({ ...base, jobsToday: base.jobsToday + actions.length, lastScoutAt, initiative });
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
 * イベント経由 (発議 3 経路のうち (2)) で発議 job を 1 本使う。
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
 * (で必ず居る) で、居なければ worker 以外の誰か。
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
 * スカウト job へ払い出す固定の job 予算。
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
 * 発議の巡回へ払い出す固定の job 予算。
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
 * イベント (発議 3 経路のうち (2)) を受け取るべき duty を選ぶ (純粋)。
 *
 * **起こす相手は「そのイベントを拾うと宣言した duty」だけ。** 全 bot へ配ると、
 * 差し戻し 1 回で社会中の bot が発議 job を立てる。宣言は
 * `bots.<key>.duties.<duty>.eventKinds`。
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
 * **下限は `MIN_TASK_JOB_BUDGET`**。ただし cap を超えない — 上限を
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
 * worker のターンが「完了申告」かどうか。
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
 * **差し戻しは 2 回まで**。2 回目は直させずに要人間へ落とす — 同じところで
 * 往復し続けるのが、無人運転でいちばん静かに job を溶かす壊れ方だから。
 * 何回目かはボードの履歴が持っているので、数えた結果だけを受け取る
 * (ここから board を触らない = 判断の層に IO を持ち込まない)。
 *
 * **`drop` は差し戻し回数と関係なく通す**。「対象が不要」は仕事の質の話ではなく
 * 重複や着地済みの後始末なので、往復の勘定に混ぜない。
 *
 * **`merge` は git の事実で裏を取ってから通す**。ここは判断の層なので
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
 *           見てからブリッジ自身が merge を打つので、ここで二重に git を要求しない
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
 * job の終了理由 → バックオフの記録。
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
 * その job の終了理由を**チャンネルのバックオフへ反映してよいか**。
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
 * 裁定待ちの提案を**いま配ってよいか** (生存性 — sol 指摘 2026-08-30)。
 *
 * 判断は 3 つ:
 * - 上限まで試したら止める (以後は人間の出番 —「要人間」)
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
 * 既定は reviewer (で必ず居る)、居なければ担当以外の誰か。
 */
export function pickAnnouncer(targetKey, autonomy, availableBotKeys) {
  return [autonomy.reviewer, ...availableBotKeys]
    .find((key) => key && key !== targetKey && availableBotKeys.includes(key)) ?? null;
}

/**
 * タスクのスレッドで走る job が、どの作業ディレクトリを使うか。
 *
 * 既定は**タスクごとの作業ツリー**。#9 が blocked になった「未マージのブランチの上に
 * 積まれる」は並行実行ではなく 1 つの作業ツリーを使い回す構造から出ていたので、
 * 直列のままでもここで断つ。
 *
 * **レビュー担当だけは本体で走る** (裁定 2026-08-28)。昇格先の main は本体の
 * チェックアウトにあり、worktree から見れば cwd の外 — 禁則「書込みは対象
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
  return { useWorktree: true, taskId: task.id, branch, base: autonomy.baseBranch };
}

/**
 * 今日の自律 job の残り (自動復旧の門)。**日付を繰り越してから**数える。
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
