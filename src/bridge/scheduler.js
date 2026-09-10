// 自律運転のスケジューラの実体 (docs/social-engineering.md §3.1。src/index.js から切り出し)。
//
// **新しい実行経路を作らない。** ここがするのは「スレッドを作って起動メッセージを
// 投稿する」ところまでで、以降は人間がメンションしたときと同じ MessageCreate →
// enqueue の回路がそのまま動く (authz・契約・hop・verify が全部効いたまま)。
// **enqueue / runJob をここから直接呼ばないこと** — 呼んだ時点で入口の認可を迂回する。
//
// 判断は src/scheduler.js の純粋関数が持ち、ここは選ばれた行動を Discord とボードへ落とすだけ。
import { canSpendJob, scoutBoardView } from '../board.js';
import { channelConfigForName, resolveAutonomy } from '../config.js';
import { formatSchemaTag } from '../contract.js';
import {
  initiativeStartMessage,
  initiativeThreadName,
  scoutStartMessage,
  scoutThreadName,
  sendSafe,
  taskStartMessage,
  taskThreadName,
} from '../mentions.js';
import {
  INITIATIVE_JOB_BUDGET,
  SCOUT_JOB_BUDGET,
  backoffOutcomeFor,
  chargeInitiative,
  dutiesForEvent,
  formatInitiativeTag,
  initialState,
  persistedState,
  planTick,
  recordFailure,
  recordSuccess,
  resolveInitiative,
  resolveScout,
  resolveStartTask,
  restoreState,
} from '../scheduler.js';
import { brokenLedgers, formatBrokenLedgers } from '../store.js';

/** tick の間隔。判断は純粋関数なので、何も起こさない tick は I/O もトークンも使わない */
export const AUTONOMY_TICK_MS = 60 * 1000;

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
 * @param {object|null} [deps.jobRuns]        実行記録の台帳 (健全性だけ見る)
 * @param {object|null} [deps.tickStateStore] 勘定の台帳 (同上)
 * @param {object|null} [deps.recoveryStore]  復旧世代の台帳 (同上)
 */
export function createSchedulerWiring({
  config, board, bots, hops, proposals, dutyBots: DUTY_BOTS, pauseStore, lifecycle, recovery,
  autonomyChannels, tickStates, saveTickState, findGuildChannel,
  jobRuns = null, tickStateStore = null, recoveryStore = null,
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
        now,
        state: tickStates.get(name) ?? initialState(),
      });
      saveTickState(name, planned.state);
      for (const action of planned.actions) {
        if (action.kind === 'start-task') {
          await startTaskFromBoard({ channelName: name, autonomy, action });
        } else if (action.kind === 'scout') {
          await startScout({ channelName: name, autonomy, action, now });
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
   * スレッド作成 → ボードの着手記録 → 予算の払い出し → 起動メッセージ。
   *
   * - スレッド作成に失敗したらボードは触らない (approved のまま次の tick で再挑戦)
   * - 予算を投稿より先に配るのは、受け手の job が門番を通らないまま走らないため
   *   (予算未付与のスレッドは hops の門番ごと不在 = 実質無制限)
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
  async function startScout({ channelName, autonomy, action, now }) {
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
        }),
        { mentionUserIds: [scout.userId] },
      );
    } catch (err) {
      claimContractKindOverride(thread.id, scoutKey);
      console.error(`[scheduler] ${channelName}: 巡回の起動に失敗: ${err.message}`);
      return;
    }
    console.log(
      `[scheduler] ${channelName}: 巡回を ${scoutKey} で起動`
      + ` (thread ${thread.id} / 予算 ${SCOUT_JOB_BUDGET} job / 投稿は ${announcerKey})`,
    );
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
    // バックオフは持ち越さない勘定なので、ここではディスクへ落とさない
    // (saveTickState を通すと、走っているプロセスの観測が台帳に混ざる)
    tickStates.set(
      item.channelName,
      outcome === 'failure' ? recordFailure(state, { now: Date.now() }) : recordSuccess(state),
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
    startInitiative,
    notifyDutyEvent,
    noteJobSpent,
    noteAutonomyOutcome,
    setContractKindOverride,
    claimContractKindOverride,
  };
}
