// 自律運転のスケジューラの実体 (docs/social-engineering.md §3.1。src/index.js から切り出し)。
//
// **新しい実行経路を作らない。** ここがするのは「スレッドを作って起動メッセージを
// 投稿する」ところまでで、以降は人間がメンションしたときと同じ MessageCreate →
// enqueue の回路がそのまま動く (authz・契約・hop・verify が全部効いたまま)。
// **enqueue / runJob をここから直接呼ばないこと** — 呼んだ時点で入口の認可を迂回する。
//
// 判断は src/scheduler.js の純粋関数が持ち、ここは選ばれた行動を Discord とボードへ落とすだけ。
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { approvalNote, canSpendJob, scoutBoardView } from '../board.js';
import { channelConfigForName, resolveAutonomy } from '../config.js';
import { formatSchemaTag } from '../contract.js';
import { harnessGate, ledgerStartLines, revisionLedger, summarizeHarness, verdictLine } from '../harness.js';
import {
  approvalNoteMessages,
  carryMessages,
  harnessStartMessage,
  harnessThreadName,
  initiativeStartMessage,
  initiativeThreadName,
  planStartMessage,
  planThreadName,
  scoutReportMessages,
  scoutStartMessage,
  scoutThreadName,
  sendSafe,
  taskStartMessage,
  taskThreadName,
} from '../mentions.js';
import {
  INITIATIVE_JOB_BUDGET,
  SCOUT_JOB_BUDGET,
  addCarry,
  backoffOutcomeFor,
  chargeInitiative,
  dropCarry,
  dutiesForEvent,
  formatInitiativeTag,
  initialState,
  parseLimitReset,
  persistedState,
  planTick,
  recordFailure,
  recordScoutReport,
  recordSuccess,
  resolveHarness,
  resolveInitiative,
  resolvePlan,
  resolveScout,
  resolveStartTask,
  restoreState,
  scoutPace,
} from '../scheduler.js';
import { brokenLedgers, formatBrokenLedgers } from '../store.js';
import { parseThemes, themeCost, themeCostText, themeProgress, themesGate } from '../themes.js';

/** tick の間隔。判断は純粋関数なので、何も起こさない tick は I/O もトークンも使わない */
export const AUTONOMY_TICK_MS = 60 * 1000;

/** 企画の起動文に行を出す主題の状態 (進行中と配備待ち — 完了 / 取り下げは数だけ) */
const LISTED_THEME_STATES = Object.freeze(['active', 'waiting']);

/**
 * 終了理由 `failed(…)` の中身から、上限が明ける時刻を読む (読めなければ null)。
 * **包みを剥いてから読む** — job.js が理由を 60 字で切るので、tz の閉じ括弧が落ちた形に
 * `failed(…)` の `)` を当てると、切れた tz を読んでしまう (`Etc/GMT+10` → `Etc/GMT+1`)
 */
function limitResetOf(reason, now) {
  const inner = /^failed\(([\s\S]*)\)$/.exec(reason ?? '')?.[1];
  return inner === undefined ? null : parseLimitReset(inner, now);
}

/**
 * チャンネル名 → スケジューラの勘定。
 *
 * **台帳の部分だけディスクへ落とす** (§3.9)。巡回の最終実行時刻と日次の消費を
 * in-memory のままにすると、再起動のたびに「間隔が明けた」と見なして巡回が連発する。
 * 何を持ち越すかは scheduler.js の `persistedState` / `restoreState` が決める
 * (バックオフは持ち越さない — 走っているプロセスの観測であって台帳ではない)。
 *
 * @param {{tickStateStore: import('../store.js').TickStateStore, autonomyChannels: string[]}} deps
 */
export function createTickLedger({ tickStateStore, autonomyChannels }) {
  const tickStates = new Map(
    autonomyChannels.map((name) => [name, restoreState(tickStateStore.get(name))]),
  );

  /** 勘定を進めてディスクへ落とす (書けなくても tick は止めない — 次の tick で書き直る) */
  function saveTickState(name, state) {
    tickStates.set(name, state);
    // 読めない台帳への保存は毎 tick 必ず失敗するので試さない (理由は autonomyTick が 1 回だけ出す)。
    // メモリ側は進めておく — 日付の繰越まで止めると、直した後に日次予算が古い日のまま残る
    if (tickStateStore.broken) return;
    try {
      tickStateStore.set(name, persistedState(state));
    } catch (err) {
      console.error(`[scheduler] ${name}: 勘定を保存できませんでした: ${err.message}`);
    }
  }

  return { tickStates, saveTickState };
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object|null} deps.board
 * @param {Map<string, object>} deps.bots
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {object|null} deps.proposals
 * @param {object[]} deps.dutyBots            duty を持つ bot (起動時に 1 回だけ解決したもの)
 * @param {import('../store.js').PauseStore} deps.pauseStore
 * @param {object} deps.lifecycle
 * @param {object|null} deps.recovery         復旧 service (src/bridge/recovery.js)
 * @param {string[]} deps.autonomyChannels
 * @param {Map<string, object>} deps.tickStates
 * @param {(name: string, state: object) => void} deps.saveTickState
 * @param {(client: object, name: string) => object|null} deps.findGuildChannel
 * @param {object|null} [deps.jobRuns]        実行記録の台帳 (健全性と、ハーネスの成績の材料)
 * @param {object|null} [deps.tickStateStore] 勘定の台帳 (同上)
 * @param {object|null} [deps.recoveryStore]  復旧世代の台帳 (同上)
 * @param {((p: {channelName: string, autonomy: object, now: number}) => Promise<void>)|null} [deps.settleReplays]
 *   改訂の解き直しが落ち着いたらレビューを呼ぶ (src/bridge/board.js — 後で作る配線なので関数で渡す)
 */
export function createSchedulerWiring({
  config, board, bots, hops, proposals, dutyBots: DUTY_BOTS, pauseStore, lifecycle, recovery,
  autonomyChannels, tickStates, saveTickState, findGuildChannel,
  jobRuns = null, tickStateStore = null, recoveryStore = null, settleReplays = null,
}) {
  /** pause 中のログを 60 秒ごとに撒かないための直近の状態 */
  let pauseNoticed = false;
  /** 台帳が読めない間のログも 1 回だけ (pause と同じ流儀) */
  let brokenNoticed = false;

  /**
   * 自律起動が根拠にする台帳 (§12.3 (1))。**どれか 1 つでも読めなければ止める** —
   * 「停止していない」「記録が無い」「仕事が無い」は、読めなかっただけかもしれない。
   * 人間のメンション・handoff は従来どおり通る (止めているのは自律起動だけ)。
   */
  function brokenControlLedgers() {
    return brokenLedgers([pauseStore, board, recoveryStore, jobRuns, tickStateStore, proposals]);
  }

  /**
   * `thread:bot` → その**次の 1 job だけ**に使うスキーマ種別 (§3.3 のスカウト job)。
   *
   * スカウトは「同じ bot が通常の役割のまま、その job だけ task-proposal で返す」必要が
   * あるので、役割文の宣言は据え置いて種別だけをかぶせる。**in-memory・1 回きり**で、
   * 再起動すると消える — 消えたスカウト job は通常の報告様式で返り、起票されないだけ
   * (壊れはしない)。永続化は必要になってから (ContractStore を増やす話になるので、
   * そこは裁定を経ること)。
   */
  const contractKindOverrides = new Map();

  function setContractKindOverride(threadId, botKey, kind) {
    contractKindOverrides.set(`${threadId}:${botKey}`, kind);
  }

  /** 取り出したら消す (次の 1 job にだけ効かせる) */
  function claimContractKindOverride(threadId, botKey) {
    const key = `${threadId}:${botKey}`;
    const kind = contractKindOverrides.get(key) ?? null;
    contractKindOverrides.delete(key);
    return kind;
  }

  /**
   * チャンネル名 → いちばん新しい巡回 (スカウト) のスレッドと担当。巡回の報告を勘定へ入れるのに使う
   * (noteScoutReport)。**in-memory・チャンネルごとに 1 件** — 新しい巡回で上書きするので増え続けず、
   * 再起動の前に始まった巡回の報告は数えない (間隔を伸ばす材料が 1 回欠けるだけ)
   */
  const scoutThreadOf = new Map();

  /**
   * チャンネル名 → いちばん新しい巡回の報告 (`{ at, proposed, body }`)。次の巡回の起動文の前に出す
   * (startScout)。**in-memory・チャンネルごとに 1 件** — 台帳 (tick-states.json) の形を変えずに済ませる
   * 代わりに、再起動後の最初の巡回には出ない。出したあとも消さない (次の報告で上書きする)
   */
  const lastScoutReportOf = new Map();

  /**
   * 巡回 (スカウト) の job が返した task-proposal を勘定へ入れる (src/index.js が fileProposal を包んで呼ぶ)。
   * 提案 0 件が続けばスカウトの間隔が伸び、企画の巡回が前倒しになる (src/scheduler.js の planTick)。
   * 本文と件数は次の巡回へ「前回の巡回の報告」として渡す。
   *
   * 数えるのは**自分が起こした巡回のスレッドで、巡回の担当が出した最初の報告だけ** — タスク・ハーネス・
   * 企画のスレッドの task-proposal や、巡回のスレッドで人が呼び直した 2 回目は巡回の結果ではない。
   *
   * @param {{threadId: string, botKey: string, proposed: number, body?: string, now?: number}} p
   *   proposed = 契約の tasks の数 (ボードが載せた数ではない — recordScoutReport)。now = 終えた時刻
   * @returns {boolean} 数えたか
   */
  function noteScoutReport({ threadId, botKey, proposed, body = '', now = Date.now() } = {}) {
    for (const [channelName, scout] of scoutThreadOf) {
      if (scout.threadId !== threadId || scout.botKey !== botKey) continue;
      scoutThreadOf.delete(channelName);
      lastScoutReportOf.set(channelName, { at: now, proposed, body: String(body ?? '') });
      const state = recordScoutReport(tickStates.get(channelName) ?? initialState(), { proposed });
      saveTickState(channelName, state);
      if (state.scoutIdle > 0) {
        const autonomy = resolveAutonomy(channelConfigForName(config, channelName));
        const pace = scoutPace({ autonomy, idle: state.scoutIdle });
        console.log(
          `[scheduler] ${channelName}: 巡回の提案 0 件 (続けて ${state.scoutIdle} 回) — 次の巡回は`
          + ` ${pace.intervalMin} 分後 (merge があれば ${pace.baseMin} 分に戻す)`
          + `${state.scoutIdleSincePlan > 0 ? ` / 前の企画の巡回の後 ${state.scoutIdleSincePlan} 回` : ''}`,
        );
      }
      return true;
    }
    return false;
  }

  /**
   * 巡回の返答 (task-proposal) の申し送り (`carry`) を溜める (src/index.js が fileProposal を包んで呼ぶ)。
   * 次の企画の巡回の起動文の前に出し、作者へ上げるかは企画の巡回がまとめて決める (startPlan)。
   * 巡回のスレッドかは問わない — ハーネスの改訂や企画自身の申し送りも同じ置き場へ。
   *
   * @param {{channelName: string, botKey: string, items?: string[], now?: number}} p
   * @returns {string} 巡回のスレッドへ添える 1 行 (申し送りが無ければ空文字)
   */
  function noteCarry({ channelName, botKey, items, now = Date.now() } = {}) {
    if (!Array.isArray(items) || items.length === 0) return '';
    if (!autonomyChannels.includes(channelName)) return '';
    const autonomy = resolveAutonomy(channelConfigForName(config, channelName));
    // 企画の巡回を置いていなければ回収する者が居ない — 溜めずに、届かないことをその場で言う
    if (!autonomy.planner?.bot) {
      return '⚠️ 申し送りを受け取りましたが、このチャンネルには企画の巡回が無いので届きません (必要なら本文で作者に)';
    }
    const { state, added, dropped } = addCarry(tickStates.get(channelName) ?? initialState(), { items, from: botKey, at: now });
    if (added === 0) return '';
    saveTickState(channelName, state);
    return `📮 次の企画の巡回へ申し送り ${added} 件 (溜まっている ${state.carry.length} 件`
      + `${dropped > 0 ? `、上限で古い ${dropped} 件を落とした` : ''})`;
  }

  /**
   * 1 tick 分の判断と適用。
   * **判断は src/scheduler.js の純粋関数**が持ち、ここは選ばれた行動を
   * Discord とボードへ落とすだけ。行動がゼロなら外へ 1 回も出ない。
   */
  async function autonomyTick(now = Date.now()) {
    if (!board || !lifecycle.accepting) return; // 停止・再起動中は新しいタスクを起こさない
    // **状態を読むのはここ (呼び出し側)。** 判断の層 (src/scheduler.js) は IO を持たない
    const paused = pauseStore.paused;
    if (paused && !pauseNoticed) {
      console.log('[pause] 自律運転は停止中 — tick は日付の繰越だけ進めます (/resume で再開)');
    }
    pauseNoticed = paused; // 止めている間ログを撒かない / 再開したらまた 1 回だけ出す
    // 制御台帳が読めないときも停止と同じ扱い (§12.3 (1))。**pause より重い** — 人が押した
    // 停止は /resume で解けるが、こちらは台帳を直すか手で退避するまで解けない
    const brokenList = brokenControlLedgers();
    if (brokenList.length > 0 && !brokenNoticed) {
      console.error(
        `[store] 制御台帳が読めません (${formatBrokenLedgers(brokenList)}) — `
        + '自律起動は止まります。直すか手で退避してください',
      );
    }
    brokenNoticed = brokenList.length > 0;
    // 止まった仕事の見回り (§11.2)。**pause 中も回す** — 止めているのは自律起動で、観測ではない。
    // ここが落ちても tick は続ける (見回りは起動の前提ではない)
    if (recovery) {
      try {
        await recovery.sweep({ at: now });
      } catch (err) {
        console.error(`[recovery] 見回りに失敗 (tick は続けます): ${err.message}`);
      }
      // 自動復旧 (§11.4)。既定は観測 mode (判断をログに残すだけ)。`auto` のチャンネルでも
      // 起こすのは副作用が始まっていないと実行記録で確認できる停止だけ。
      // **受付停止中・pause 中は planRecovery 側が止める** (pause は判定の材料として渡っている)
      if (lifecycle.accepting) {
        try {
          await recovery.autoTick({ at: now });
        } catch (err) {
          console.error(`[recovery] 自動復旧の判定に失敗 (tick は続けます): ${err.message}`);
        }
      }
    }
    for (const name of autonomyChannels) {
      const autonomy = resolveAutonomy(channelConfigForName(config, name));
      // 改訂の解き直し (src/replay.js) が落ち着いたらレビューを呼ぶ。着手の判断より先 — 落ち着いた改訂が
      // 同時枠に戻るので。落ちても tick は続ける (見回りと同じく、起動の前提ではない)
      if (settleReplays && brokenList.length === 0) {
        try {
          await settleReplays({ channelName: name, autonomy, now });
        } catch (err) {
          console.error(`[replay] ${name}: 解き直しの見回りに失敗 (tick は続けます): ${err.message}`);
        }
      }
      const harness = autonomy.harness.bot ? measureHarness(autonomy, now) : null;
      const themes = autonomy.planner.bot ? readThemes(name, autonomy) : null;
      const planned = planTick({
        tasks: board.list({ channel: name }),
        // **pause 中は「無効なチャンネル」として渡す。** 判断の層 (src/scheduler.js) に
        // kill switch を持ち込まずに、行動の選択だけを止められる —
        // planTick は無効なら日付の繰越だけ進めて何も選ばないので、
        // 起こしていない巡回で lastScoutAt や日次予算が動くこともない
        // (台帳が読めないときも同じ扱い — 判断の材料が信用できない)
        autonomy: paused || brokenList.length > 0 ? { ...autonomy, enabled: false } : autonomy,
        // 発議の巡回は機構が有効なときだけ。**空配列を渡すことで止める** —
        // 判断の層に config の読み方を持ち込まずに、巡回だけを落とせる
        dutyBots: proposals ? DUTY_BOTS : [],
        proposals: proposals ? proposals.openList() : [],
        harness: harness?.gate ?? null,
        plan: themes?.gate ?? null,
        now,
        state: tickStates.get(name) ?? initialState(),
      });
      saveTickState(name, planned.state);
      for (const action of planned.actions) {
        if (action.kind === 'start-task') {
          await startTaskFromBoard({ channelName: name, autonomy, action });
        } else if (action.kind === 'scout') {
          await startScout({ channelName: name, autonomy, action, now, themes });
        } else if (action.kind === 'harness') {
          await startHarness({ channelName: name, autonomy, action, now, measured: harness });
        } else if (action.kind === 'plan') {
          await startPlan({ channelName: name, autonomy, action, now, themes });
        } else if (action.kind === 'initiative') {
          await startInitiative({ channelName: name, autonomy, action, now });
        } else {
          console.log(`[scheduler] ${name}: 知らない行動 ${action.kind} — 何もしません`);
        }
      }
    }
  }

  /**
   * `start-task` の適用。**順序が不変条件**:
   * スレッド作成 → ボードの着手記録 → 予算の払い出し → 承認時の備考 → 起動メッセージ。
   *
   * - スレッド作成に失敗したらボードは触らない (approved のまま次の tick で再挑戦)
   * - 予算を投稿より先に配るのは、受け手の job が門番を通らないまま走らないため
   *   (予算未付与のスレッドは hops の門番ごと不在 = 実質無制限)
   * - 承認時の備考は**メンションより前**に出す (後だと最初の job の文脈に入る保証が無い)。
   *   出せなくても着手は止めない — 同じ備考はレビューの依頼にも載る
   * - 投稿に失敗したら blocked (要人間) へ落とす。in-progress のまま残すと、
   *   誰も居ないスレッドが同時実行の枠を占め続ける
   */
  async function startTaskFromBoard({ channelName, autonomy, action }) {
    const decided = resolveStartTask(action, {
      tasks: board.list({ channel: channelName }),
      autonomy,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    });
    if (!decided.ok) {
      console.error(`[scheduler] ${channelName}: 着手を見送り — ${decided.reason}`);
      return;
    }
    const { task, workerKey, announcerKey } = decided;
    const worker = bots.get(workerKey);
    const announcer = bots.get(announcerKey);
    const channel = findGuildChannel(announcer.client, channelName);
    if (!channel?.threads) {
      console.error(
        `[scheduler] ${channelName}: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)`,
      );
      return;
    }

    let thread;
    try {
      thread = await channel.threads.create({ name: taskThreadName(task) });
    } catch (err) {
      console.error(`[scheduler] ${channelName}: タスク ${task.id} のスレッド作成に失敗: ${err.message}`);
      return;
    }

    let started;
    try {
      started = board.start(task.id, { threadId: thread.id, by: 'scheduler' });
    } catch (err) {
      console.error(
        `[scheduler] ${channelName}: タスク ${task.id} の着手を記録できません`
        + ` (空のスレッド ${thread.id} が残ります): ${err.message}`,
      );
      return;
    }
    const budget = Number.isSafeInteger(started.jobBudget) && started.jobBudget > 0
      ? started.jobBudget
      : autonomy.taskJobBudget;
    hops.grantTaskBudget(thread.id, budget);

    const approval = approvalNote(started);
    const noteTexts = approvalNoteMessages({
      note: approval.note,
      approver: bots.get(approval.by)?.cfg?.displayName ?? approval.by,
    });
    for (const text of noteTexts) {
      try {
        await sendSafe(thread, text);
      } catch (err) {
        console.error(
          `[scheduler] ${channelName}: タスク ${task.id} の承認時の備考を出せません (着手は続けます): ${err.message}`,
        );
        break;
      }
    }

    try {
      await sendSafe(
        thread,
        taskStartMessage({
          task: started,
          botUserId: worker.userId,
          directionFile: autonomy.directionFile,
        }),
        { mentionUserIds: [worker.userId] },
      );
    } catch (err) {
      board.block(task.id, { by: 'scheduler', reason: `起動メッセージの投稿に失敗: ${err.message}` });
      console.error(`[scheduler] ${channelName}: タスク ${task.id} の起動に失敗: ${err.message}`);
      await notifyDutyEvent({
        eventKind: 'block',
        channelName,
        detail: `タスク #${task.id} の起動に失敗して blocked`,
      });
      return;
    }
    console.log(
      `[scheduler] ${channelName}: タスク ${task.id} を ${workerKey} で起動`
      + ` (thread ${thread.id} / 予算 ${budget} job / 投稿は ${announcerKey})`,
    );
  }

  /**
   * `scout` の適用 (§3.3)。start-task と同じ順序の約束:
   * スレッド作成 → 予算の払い出し → 起動メッセージ。
   *
   * ボードは触らない (スカウトが起票するのは job が返ってきてから — fileProposal)。
   * 種別の上書きは投稿の直前に置き、投稿に失敗したら取り消す —
   * 起動しなかった job のために種別を残すと、そのスレッドで次に走った
   * 別の job が task-proposal で検査されてしまう。
   */
  async function startScout({ channelName, autonomy, action, now, themes = null }) {
    const decided = resolveScout(action, {
      autonomy,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    });
    if (!decided.ok) {
      console.error(`[scheduler] ${channelName}: 巡回を見送り — ${decided.reason}`);
      return;
    }
    const { scoutKey, announcerKey } = decided;
    const scout = bots.get(scoutKey);
    const channel = findGuildChannel(bots.get(announcerKey).client, channelName);
    if (!channel?.threads) {
      console.error(
        `[scheduler] ${channelName}: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)`,
      );
      return;
    }

    let thread;
    try {
      thread = await channel.threads.create({ name: scoutThreadName(now) });
    } catch (err) {
      console.error(`[scheduler] ${channelName}: 巡回スレッドの作成に失敗: ${err.message}`);
      return;
    }

    hops.grantTaskBudget(thread.id, SCOUT_JOB_BUDGET);
    setContractKindOverride(thread.id, scoutKey, 'task-proposal');
    const weights = themes ? themeWeights(channelName, themes.gate.active) : null;
    // 前回の巡回の報告は起動文より前に出す (承認時の備考と同じ — 前に置けば最初の job の文脈に入る)。
    // 出せなくても巡回は続ける
    let reportShown = false;
    for (const text of scoutReportMessages({ report: lastScoutReportOf.get(channelName) ?? null })) {
      try {
        await sendSafe(thread, text);
        reportShown = true;
      } catch (err) {
        console.error(`[scheduler] ${channelName}: 前回の巡回の報告を出せません (巡回は続けます): ${err.message}`);
        break;
      }
    }
    try {
      await sendSafe(
        thread,
        scoutStartMessage({
          botUserId: scout.userId,
          directionFile: autonomy.directionFile,
          // 重複起票を避ける材料 (§9.1) = 非終端すべてと、直近に着地したもの。
          // 「着手前だけ」に絞ると、review 中の仕事が見えず同じものが再起票される。
          // **`now` は渡さない** — tick の now はスレッド作成を待つ前の時刻なので、
          // その間に着地した merge が「未来」扱いで隠れる (既定の Date.now() は
          // 引数の board.list を評価した後に読まれる)
          openTasks: scoutBoardView(board.list({ channel: channelName })),
          // 企画の巡回を置いたチャンネルだけ、進行中の主題を優先させる (読めなければ渡さない)。
          // 重さは添えるだけ (出せなければ今の文面のまま)
          themes: themes
            ? {
              file: autonomy.planner.themesFile,
              active: themes.gate.active.map((theme) => (weights ? { ...theme, weight: weights.get(theme.slug) } : theme)),
            }
            : null,
        }),
        { mentionUserIds: [scout.userId] },
      );
    } catch (err) {
      claimContractKindOverride(thread.id, scoutKey);
      console.error(`[scheduler] ${channelName}: 巡回の起動に失敗: ${err.message}`);
      return;
    }
    scoutThreadOf.set(channelName, { threadId: thread.id, botKey: scoutKey });
    console.log(
      `[scheduler] ${channelName}: 巡回を ${scoutKey} で起動`
      + ` (thread ${thread.id} / 予算 ${SCOUT_JOB_BUDGET} job${reportShown ? ' / 前回の報告つき' : ''} / 投稿は ${announcerKey})`,
    );
  }

  /**
   * ハーネスの成績と門 (src/harness.js)。**役割文は全チャンネル共通**なので、実行記録とボードは
   * チャンネルで絞らずに読む。読めなければ門を閉じる (記録が無いことを「測り終えた」と読まない)。
   *
   * 改訂の台帳 (役割文を触った merge 済みのタスク → その merge で始まった版) も一緒に出す。
   *
   * @returns {{summary: object, gate: object, ledger: object[]}|null}
   */
  function measureHarness(autonomy, now) {
    if (!jobRuns) return null;
    try {
      const tasks = board.list();
      const summary = summarizeHarness(jobRuns.list(), { tasks, minRuns: autonomy.harness.minRuns });
      return {
        summary,
        gate: harnessGate(summary, { now, minRuns: autonomy.harness.minRuns }),
        ledger: revisionLedger(summary, tasks),
      };
    } catch (err) {
      console.error(`[scheduler] ハーネスの成績を出せません (改訂の巡回は見送り): ${err.message}`);
      return null;
    }
  }

  /**
   * 主題ごとの重さの文面 (src/themes.js の themeCost → themeCostText)。企画とスカウトの起動文に
   * 添えるだけなので、実行記録が無い・読めないときは null を返し、起動文は今の文面のまま巡回を続ける
   * (measureHarness と同じ型)。task id はボード全体で一意なので、実行記録はチャンネルで絞らない
   *
   * @returns {Map<string, string>|null} slug → 文面
   */
  function themeWeights(channelName, themes) {
    if (!jobRuns || themes.length === 0) return null;
    try {
      const runs = jobRuns.list();
      const tasks = board.list({ channel: channelName });
      return new Map(themes.map((theme) => [theme.slug, themeCostText(themeCost(tasks, runs, theme.slug))]));
    } catch (err) {
      console.error(`[scheduler] ${channelName}: 主題の重さを出せません (起動文は重さなしで続けます): ${err.message}`);
      return null;
    }
  }

  /**
   * `harness` の適用 (ハーネスの改訂の巡回)。手順は startScout と同じ約束:
   * スレッド作成 → 予算の払い出し → 種別の上書き → 起動メッセージ (失敗したら上書きを取り消す)。
   * 起票は job が返ってきてから fileProposal が載せる — ここはボードを触らない。
   */
  async function startHarness({ channelName, autonomy, action, now, measured }) {
    const decided = resolveHarness(action, {
      autonomy,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    });
    if (!decided.ok) {
      console.error(`[scheduler] ${channelName}: ハーネスの改訂を見送り — ${decided.reason}`);
      return;
    }
    if (!measured) {
      console.error(`[scheduler] ${channelName}: ハーネスの改訂を見送り — 成績が出ていません`);
      return;
    }
    const { botKey, announcerKey } = decided;
    const bot = bots.get(botKey);
    const channel = findGuildChannel(bots.get(announcerKey).client, channelName);
    if (!channel?.threads) {
      console.error(
        `[scheduler] ${channelName}: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)`,
      );
      return;
    }

    let thread;
    try {
      thread = await channel.threads.create({ name: harnessThreadName(now) });
    } catch (err) {
      console.error(`[scheduler] ${channelName}: ハーネスの改訂のスレッドの作成に失敗: ${err.message}`);
      return;
    }

    hops.grantTaskBudget(thread.id, SCOUT_JOB_BUDGET);
    setContractKindOverride(thread.id, botKey, 'task-proposal');
    try {
      await sendSafe(
        thread,
        harnessStartMessage({
          botUserId: bot.userId,
          verdictLines: measured.summary.bots.map(verdictLine),
          gateReason: measured.gate.reason,
          editable: harnessEditableFiles(measured.summary, botKey),
          ledgerLines: ledgerStartLines(measured.ledger),
          carry: Boolean(autonomy.planner?.bot),
        }),
        { mentionUserIds: [bot.userId] },
      );
    } catch (err) {
      claimContractKindOverride(thread.id, botKey);
      console.error(`[scheduler] ${channelName}: ハーネスの改訂の起動に失敗: ${err.message}`);
      return;
    }
    console.log(
      `[scheduler] ${channelName}: ハーネスの改訂を ${botKey} で起動`
      + ` (thread ${thread.id} / ${measured.gate.reason} / 投稿は ${announcerKey})`,
    );
  }

  /**
   * 改訂してよい役割文 = 共通規定 + 成績に出ている bot の役割文。**提案役自身の役割文は外す** —
   * 論文も提案役と解く側を分けている (自分の判断基準を自分で書き換えさせない)。
   */
  function harnessEditableFiles(summary, proposerKey) {
    const own = config.bots?.[proposerKey]?.rolePromptFile ?? null;
    const files = new Set(['roles/_common.md']);
    for (const bot of summary.bots) {
      const file = config.bots?.[bot.botKey]?.rolePromptFile;
      if (typeof file === 'string' && file.trim() !== '' && file !== own) files.add(file.trim());
    }
    return [...files];
  }

  /**
   * 主題ファイル (src/themes.js) を読んで門を出す。主題はチャンネルのリポジトリにあるので cwd 基準。
   * **まだ無いのは「主題が 0 件」** (最初の巡回がファイルごと作る)。それ以外で読めなければ
   * 門を閉じる — 読めないことを「主題が無い」と読むと、在る主題に重ねて足してしまう。
   *
   * @returns {{parsed: object, gate: object}|null}
   */
  function readThemes(channelName, autonomy) {
    const file = autonomy.planner.themesFile;
    const cwd = channelConfigForName(config, channelName)?.cwd;
    const path = isAbsolute(file) || !cwd ? file : join(cwd, file);
    let text = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error(`[scheduler] ${channelName}: 主題ファイルを読めません (企画の巡回は見送り): ${err.message}`);
        return null;
      }
    }
    const parsed = parseThemes(text);
    return { parsed, gate: themesGate(parsed, { maxThemes: autonomy.planner.maxThemes, missing: text === null }) };
  }

  /**
   * `plan` の適用 (企画の巡回)。手順は startHarness と同じ約束:
   * スレッド作成 → 予算の払い出し → 種別の上書き → 起動メッセージ (失敗したら上書きを取り消す)。
   * 起票は job が返ってきてから fileProposal が載せる — ここはボードを触らない。
   */
  async function startPlan({ channelName, autonomy, action, now, themes }) {
    const decided = resolvePlan(action, {
      autonomy,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    });
    if (!decided.ok) {
      console.error(`[scheduler] ${channelName}: 企画の巡回を見送り — ${decided.reason}`);
      return;
    }
    if (!themes) {
      console.error(`[scheduler] ${channelName}: 企画の巡回を見送り — 主題ファイルを読めていません`);
      return;
    }
    const { botKey, announcerKey } = decided;
    const bot = bots.get(botKey);
    const channel = findGuildChannel(bots.get(announcerKey).client, channelName);
    if (!channel?.threads) {
      console.error(
        `[scheduler] ${channelName}: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)`,
      );
      return;
    }

    let thread;
    try {
      thread = await channel.threads.create({ name: planThreadName(now) });
    } catch (err) {
      console.error(`[scheduler] ${channelName}: 企画の巡回のスレッドの作成に失敗: ${err.message}`);
      return;
    }

    hops.grantTaskBudget(thread.id, SCOUT_JOB_BUDGET);
    setContractKindOverride(thread.id, botKey, 'task-proposal');
    const weights = themeWeights(channelName, themes.parsed.themes.filter((t) => LISTED_THEME_STATES.includes(t.state)));
    const early = action.early === true
      ? ` / 前倒し (前の企画の巡回の後、スカウトの提案 0 件が続けて ${action.idleScouts ?? '?'} 回)`
      : '';
    // 申し送りは起動文より前に出す (承認時の備考と同じ — 前に置けば企画役の最初の job の文脈に入る)。
    // 出せなくても巡回は続け、申し送りは消さずに次の企画の巡回へ回す
    const carried = (tickStates.get(channelName) ?? initialState()).carry ?? [];
    let carryShown = carried.length > 0;
    for (const text of carryMessages({ items: carried })) {
      try {
        await sendSafe(thread, text);
      } catch (err) {
        console.error(`[scheduler] ${channelName}: 申し送りを出せません (巡回は続け、申し送りは次へ回します): ${err.message}`);
        carryShown = false;
        break;
      }
    }
    try {
      await sendSafe(
        thread,
        planStartMessage({
          botUserId: bot.userId,
          themesFile: autonomy.planner.themesFile,
          directionFile: autonomy.directionFile,
          mode: themes.gate.mode,
          reason: `${themes.gate.reason}${early}`,
          themeLines: themeLines(themes.parsed, board.list({ channel: channelName }), weights),
          loopLines: loopLines(channelName, autonomy),
          carryCount: carryShown ? carried.length : 0,
        }),
        { mentionUserIds: [bot.userId] },
      );
    } catch (err) {
      claimContractKindOverride(thread.id, botKey);
      console.error(`[scheduler] ${channelName}: 企画の巡回の起動に失敗: ${err.message}`);
      return;
    }
    // 渡し終えた分だけ消す (投稿を待つ間に増えた申し送りは残る)
    if (carryShown) saveTickState(channelName, dropCarry(tickStates.get(channelName) ?? initialState(), carried));
    console.log(
      `[scheduler] ${channelName}: 企画の巡回を ${botKey} で起動`
      + ` (thread ${thread.id} / ${themes.gate.reason}${early}`
      + `${carryShown ? ` / 申し送り ${carried.length} 件` : ''} / 投稿は ${announcerKey})`,
    );
  }

  /**
   * 回し方の数字 (企画の巡回の材料 — 変えた方がよい設定を、申し送りと合わせて 1 通で作者に上げさせる)。
   * ブリッジの勘定だけを出す。日次上限で止まった時間などは企画役が実行記録から数える
   */
  function loopLines(channelName, autonomy) {
    const state = tickStates.get(channelName) ?? initialState();
    const lines = [];
    if (autonomy.scout?.bot) {
      const pace = scoutPace({ autonomy, idle: state.scoutIdle });
      lines.push(
        `スカウト: 続けて提案 0 件 ${state.scoutIdle} 回 — 間隔 ${pace.intervalMin} 分 (設定 ${pace.baseMin} 分。`
        + '0 件が続くと伸び、merge で戻る)',
      );
    }
    lines.push(`自律起動: 今日 ${state.jobsToday} / ${autonomy.maxJobsPerDay} job (着手・巡回・自動復旧の数。レビュー・承認は数えない)`);
    return lines;
  }

  /**
   * 主題の行 = 進行中と配備待ちの主題と進み具合 (と重さ) → 完了 / 取り下げの数 → 読めない見出し。
   * 配備待ち (`waiting`) も出す — 配備の後に確かめて `done` / `dropped` にするのは企画役。
   * weights (themeWeights) が null なら重さを付けない
   */
  function themeLines(parsed, tasks, weights = null) {
    const lines = [];
    for (const state of LISTED_THEME_STATES) {
      for (const theme of parsed.themes.filter((t) => t.state === state)) {
        const p = themeProgress(tasks, theme.slug);
        lines.push(
          `[${state}] ${theme.slug} — ${theme.title || '(題なし)'} (タスク merged ${p.merged} / 進行中 ${p.open} / 捨てた ${p.dropped})`
          + (weights?.get(theme.slug) ?? ''),
        );
      }
    }
    const done = parsed.themes.filter((t) => t.state === 'done').length;
    const dropped = parsed.themes.filter((t) => t.state === 'dropped').length;
    if (done + dropped > 0) lines.push(`これまで: 完了 ${done} / 取り下げ ${dropped} (結果はファイルに)`);
    for (const problem of parsed.problems) lines.push(`⚠️ ${problem}`);
    return lines;
  }

  /**
   * `initiative` の適用 (§3.9 の発議 3 経路のうち (3) 定期巡回)。
   * 手順は startScout と同じ約束: スレッド作成 → 予算の払い出し → 起動メッセージ。
   *
   * **種別は `report` を被せる。** 発議は report の任意フィールドなので、
   * 役割文が `delegation` を宣言している bot でもこの job だけは報告様式で返させる。
   * 上書きは宣言のある bot にしか乗らない (src/contract.js の resolveContractKind) —
   * 宣言の無い bot は構造化されないので、発議は拾えないまま通常の応答になる。
   *
   * @returns {Promise<boolean>} 起動できたか (イベント経由の呼び出しが結果を見る)
   */
  async function startInitiative({ channelName, autonomy, action, now, trigger = '' }) {
    if (!proposals) return false;
    const decided = resolveInitiative(action, {
      autonomy,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    });
    if (!decided.ok) {
      console.error(`[scheduler] ${channelName}: 発議の巡回を見送り — ${decided.reason}`);
      return false;
    }
    const { botKey, duty, announcerKey } = decided;
    const bot = bots.get(botKey);
    const channel = findGuildChannel(bots.get(announcerKey).client, channelName);
    if (!channel?.threads) {
      console.error(
        `[scheduler] ${channelName}: チャンネルを取得できません (キャッシュ未取得・権限不足・改名)`,
      );
      return false;
    }

    let thread;
    try {
      thread = await channel.threads.create({ name: initiativeThreadName(duty, now) });
    } catch (err) {
      console.error(`[scheduler] ${channelName}: 発議スレッドの作成に失敗: ${err.message}`);
      return false;
    }

    hops.grantTaskBudget(thread.id, INITIATIVE_JOB_BUDGET);
    try {
      await sendSafe(
        thread,
        initiativeStartMessage({
          botUserId: bot.userId,
          duty,
          trigger,
          directionFile: autonomy.directionFile,
          // 様式もバックオフの扱いも**この 1 通**で決める。スレッドに紐付けた枠だと、
          // 同じ宛先で待っている別の依頼から枠を奪ってしまう (sol 指摘 2026-08-30)
          schemaTag: formatSchemaTag('report'),
          initiativeTag: formatInitiativeTag('巡回'),
          // 重ねて発議させない材料 = その duty で今 open な提案
          openProposals: proposals.openList()
            .filter((p) => p.ownerBotKey === botKey && p.input?.duty === duty)
            .map((p) => ({ id: p.id, class: p.class, state: p.state, summary: p.input?.summary })),
        }),
        { mentionUserIds: [bot.userId] },
      );
    } catch (err) {
      console.error(`[scheduler] ${channelName}: 発議の起動に失敗: ${err.message}`);
      return false;
    }
    console.log(
      `[scheduler] ${channelName}: duty ${duty} の発議を ${botKey} で起動`
      + ` (thread ${thread.id} / 予算 ${INITIATIVE_JOB_BUDGET} job / 投稿は ${announcerKey}`
      + `${trigger ? ` / 契機 ${trigger}` : ''})`,
    );
    return true;
  }

  /**
   * イベントを duty へ配る (§3.9 の発議 3 経路のうち (2))。
   *
   * `block` / `send-back` / `backoff` は「社会がうまく回っていない」の観測点で、
   * report と定期巡回だけだと**次の巡回まで誰も見ない**。宣言した duty
   * (`bots.<key>.duties.<duty>.eventKinds`) にだけ配るので、社会が大きくなっても
   * 1 イベントで全 bot が起きることはない。
   *
   * **予算は巡回と同じ財布** (`chargeInitiative`)。イベントだけ無制限にすると、
   * 差し戻しが続いた日に発議 job がチャンネルの日次上限を食い潰す。
   *
   * @param {{eventKind: string, channelName: string, detail?: string,
   *          excludeBotKeys?: string[], now?: number}} p
   */
  async function notifyDutyEvent(options) {
    // **ここから外へ例外を出さない。** 呼び出し元はボードを動かした直後や job の
    // 後始末の途中で、発議の配信に失敗したことでそちらの結果を書き換えてはいけない
    try {
      await deliverDutyEvent(options);
    } catch (err) {
      console.error(`[scheduler] ${options?.eventKind} の配信に失敗: ${err.message}`);
    }
  }

  async function deliverDutyEvent({
    eventKind, channelName, detail = '', excludeBotKeys = [], now = Date.now(),
  }) {
    if (!proposals || DUTY_BOTS.length === 0) return;
    // kill switch (§3.7)。止めている間に発議 job だけが立ち上がらないように。
    // 制御台帳が読めないときも同じ (§12.3 (1) — イベント経由だけが自律起動の抜け道にならないように)
    if (pauseStore.paused || !lifecycle.accepting || brokenControlLedgers().length > 0) return;
    const autonomy = resolveAutonomy(channelConfigForName(config, channelName));
    if (autonomy.enabled !== true) return;

    const targets = dutiesForEvent(eventKind, {
      dutyBots: DUTY_BOTS,
      availableBotKeys: [...bots.values()].filter((b) => b.userId).map((b) => b.key),
      excludeBotKeys,
    });
    for (const { botKey, duty } of targets) {
      const budget = DUTY_BOTS.find((b) => b.botKey === botKey)?.initiativeBudget;
      const charged = chargeInitiative(tickStates.get(channelName) ?? initialState(), {
        botKey,
        duty,
        budget,
        maxJobsPerDay: autonomy.maxJobsPerDay,
        now,
      });
      if (!charged.ok) {
        console.log(`[scheduler] ${channelName}: ${eventKind} を ${botKey}/${duty} へ配れません — ${charged.reason}`);
        continue;
      }
      // **予算は起動の前に引く。** 起動できなかったぶんを戻さないのは、失敗した
      // 起動を無料にすると、投稿に失敗し続けるチャンネルで無限に試せてしまうため
      saveTickState(channelName, charged.state);
      await startInitiative({
        channelName,
        autonomy,
        action: { kind: 'initiative', botKey, duty },
        now,
        trigger: detail ? `${eventKind} — ${detail}` : eventKind,
      });
    }
  }

  /**
   * bot 起点 job を 1 本通した = そのタスクの job 予算を 1 使った (§3.5 の記帳)。
   * 実行時の門番は hops が持ち、**台帳はボード**が持つ — 人間が覗いたときに
   * 「あと何本走れるか」がボードだけで読める。
   */
  function noteJobSpent(threadId) {
    if (!board) return;
    const task = board.findByThread(threadId);
    // タスクの無いスレッド (スカウト・雑談) と、走っていないタスクは記帳しない
    if (!canSpendJob(task)) return;
    try {
      board.spendJob(task.id);
    } catch (err) {
      console.error(`[scheduler] タスク ${task.id} の job 記帳に失敗: ${err.message}`);
    }
  }

  /**
   * 自律スレッドの job の成否をチャンネルの勘定へ記録する (§3.7 のバックオフ)。
   * **予算を配ったスレッドだけが対象** — 人間が回している job の失敗で社会を止めない。
   *
   * **発議 job も対象外** (sol 指摘 2026-08-30)。バックオフはチャンネル単位の勘定なので
   * `recordSuccess` は誰の成功でも解いてしまうが、発議 job は**失敗した bot とは別の bot**が
   * 観測や裁定のために走らせるもので、それが通っても「リミットが明けた」の証拠にならない
   * (「Opus がリミット → Fable の裁定 job が成功 → 次の tick で Opus を再起動」で保護が消える)。
   * 失敗も数えない — 本当に全体が落ちているなら着手や巡回の job が同じ理由で落ちて記帳される。
   *
   * **判定は job 単位**。裁定の依頼は通常のタスクスレッドへも出る (タスクの report が
   * 発議したとき) ので、スレッドで見ると同じスレッドの通常 job と区別できない。
   */
  function noteAutonomyOutcome(item, reason) {
    const outcome = backoffOutcomeFor(reason, {
      hasTaskBudget: hops.taskBudget(item?.threadId) !== null,
      isInitiative: item?.initiativeJob === true,
    });
    if (!outcome || !item?.channelName) return;
    const state = tickStates.get(item.channelName) ?? initialState();
    const now = Date.now();
    // バックオフは持ち越さない勘定なので、ここではディスクへ落とさない
    // (saveTickState を通すと、走っているプロセスの観測が台帳に混ざる)。
    // 上限が明ける時刻が読めれば、着手・巡回・起こし直しはそこまで待つ (読めなければ従来の倍々)
    tickStates.set(
      item.channelName,
      outcome === 'failure'
        ? recordFailure(state, { now, until: limitResetOf(reason, now) })
        : recordSuccess(state),
    );
    if (outcome === 'failure') {
      console.error(
        `[scheduler] ${item.channelName}: 自律 job が失敗 (${reason}) — 自律起動をバックオフします`,
      );
      // ランタイムが動かなかったことも組織の観測点 (§3.9)。**待たない** —
      // job の後始末の途中なので、発議の起動で終了理由の記録を遅らせない
      void notifyDutyEvent({
        eventKind: 'backoff',
        channelName: item.channelName,
        detail: `自律 job が失敗 (${reason})`,
        excludeBotKeys: [item.botKey].filter(Boolean),
      });
    }
  }

  return {
    autonomyTick,
    startTaskFromBoard,
    startScout,
    startHarness,
    startPlan,
    startInitiative,
    notifyDutyEvent,
    noteJobSpent,
    noteAutonomyOutcome,
    noteScoutReport,
    noteCarry,
    setContractKindOverride,
    claimContractKindOverride,
  };
}
