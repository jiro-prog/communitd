// 止まった仕事の検知と再開。
//
// ここは**順序と排他だけ**を持つ層。判断は src/taskstatus.js (状態) と src/recovery.js (再開の
// 可否) の純粋関数、記録は src/jobruns.js、Discord・Git・子プロセスは注入で受ける。
// 呼び出し側 (src/index.js と src/bridge/*.js) からは「状態を聞く」「一覧を作る」「tick で見回る」
// 「/retry を受ける」の 4 つだけ。組み立ては src/bridge/recovery.js。

import { DEFAULT_GRACE_MS, deriveTaskStatus, nextOperationFor, recoveryRows, statusLabel } from './taskstatus.js';
import { elapsed } from './inbox.js';
import {
  classifySendError, parseRequestMarker, planRecovery, planRetry, requestMarker, retryMessage,
} from './recovery.js';
import { remainingJobs } from './board.js';
import { brokenLedgers } from './store.js';
import { pickAnnouncer } from './scheduler.js';
import { judgeLiveness } from './procstate.js';
import { msOfTime } from './time.js';

const WORKING_STATES = Object.freeze(['in-progress', 'review']);

/**
 * 「同じ問題につき 1 回」の鍵。task と状態と、根拠になった job で決める —
 * 別の job で止まり直したら別の問題として知らせる
 */
export function stallKey({ task, status }) {
  return `${task?.id}:${status?.status}:${status?.run?.id ?? '-'}`;
}

/** スレッドへ出す停滞の通知 (1 回だけ) */
export function stallNoticeText({ task, status }, { now = Date.now() } = {}) {
  const op = nextOperationFor(status);
  return [
    `🛟 タスク #${task.id} は**${statusLabel(status.status)}**です (経過 ${elapsed(status.since, now)})`,
    `理由: ${String(status.reason ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
    op ? `次の操作: ${op}` : null,
    '— この通知は同じ問題につき 1 回だけ出ます。`/inbox` の「復旧待ち」にも載ります',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.board TaskBoardStore
 * @param {object} deps.jobRuns JobRunStore
 * @param {object|null} [deps.contracts] ContractStore (未消費契約の照会)
 * @param {object|null} [deps.pauseStore] PauseStore
 * @param {string[]} [deps.channels] 自律運転のチャンネル名
 * @param {(channelName: string) => object} [deps.autonomyFor] チャンネル → resolveAutonomy の戻り
 * @param {(channelName: string) => number} [deps.backoffUntilFor] チャンネル → バックオフ明け (ms)
 * @param {(p: {task: object, status: object, text: string}) => Promise<boolean>} [deps.notify]
 *        停滞の通知 (スレッドへ 1 通)。true = 送れた
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.graceMs]
 * @param {() => number} [deps.now]
 * @param {object|null} [deps.recoveryStore] RecoveryStore (再開世代・自動の勘定)。無ければ /retry は無効
 * @param {object|null} [deps.jobs] JobQueue (active / waiting — そのスレッドの job が居るか)
 * @param {object|null} [deps.hops] HopTracker (門番の残り予算・台帳からの組み直し)
 * @param {(pid: number) => Promise<object>} [deps.inspectProcess] 子プロセスの照会 (src/procstate.js)
 * @param {() => string[]} [deps.availableBotKeys] 起動している bot
 * @param {(botKey: string) => string|null} [deps.botUserId] bot キー → Discord ユーザー ID
 * @param {(p: {botKey: string, threadId: string, text: string, mentionUserIds: string[]}) => Promise<unknown>}
 *        [deps.postAs] その bot の client からスレッドへ投稿する (担当自身の client からは投げない)
 * @param {(p: {thread: object, id: string|null, bot: object}) => Promise<{ok: boolean, reason: string}>}
 *        [deps.reissueReview] review の出し直し (`/review` と同じ実体)
 * @param {(cwd: string) => boolean|null} [deps.gitDirty] 作業ツリーに未コミットの変更があるか (読めなければ null)
 */
export function createRecoveryService({
  board,
  jobRuns,
  contracts = null,
  pauseStore = null,
  channels = [],
  autonomyFor = () => ({}),
  backoffUntilFor = () => 0,
  notify = null,
  log = () => {},
  graceMs = DEFAULT_GRACE_MS,
  now = () => Date.now(),
  recoveryStore = null,
  jobs = null,
  hops = null,
  inspectProcess = null,
  availableBotKeys = () => [],
  botUserId = () => null,
  postAs = null,
  reissueReview = null,
  gitDirty = () => null,
  // 自動復旧の材料: チャンネルの日次予算の残 / 適用 task か (自動復旧の対象外)
  dayJobsLeftFor = () => null,
  isApplyTask = () => false,
  // 日次予算の予約と払い戻し (通常の着手と同じ勘定 `jobsToday` — レビュー指摘 2026-09-05)。
  // reserve は残があれば 1 本予約して true。refund は**確実に送れなかったとき**だけ呼ぶ
  reserveDayJob = null,
  refundDayJob = null,
  // 送達不明の再開要求をスレッドで探す (`再開要求 77-3` の印を持つ投稿の ID)。無ければ null、聞けなければ throw
  findRequestMessage = null,
  // 送信済みの再開要求が受け付けられるまで待つ猶予。過ぎたら期限切れとして閉じ、次を打てるようにする
  // (遅れて届いた期限切れの投稿は受付側 `screenTrigger` が断る)
  requestGraceMs = DEFAULT_GRACE_MS,
  // 送達不明の要求を「送れていない」と判定するまでに置く時間。走査が完全で、これを過ぎても
  // 投稿が見えないときだけ failed にする (照会時にまだ見えていない投稿を除外しない — レビュー指摘 B)
  verifyDelayMs = 2 * 60 * 1000,
} = {}) {
  if (!board || !jobRuns) throw new Error('createRecoveryService には board と jobRuns が要ります');
  // 通知済みの鍵 → 時刻。in-memory (再起動で 1 回だけ出し直すのは提案の配り直しと同じ流儀)
  const notified = new Map();
  // 自動復旧の判断のログを毎 tick 撒かない (task × 行動 × 理由 で 1 回)
  const observed = new Map();
  // 再開の進行中 (task id)。**await の前に入れる** — 連打・別 bot 経由・自動復旧が同じ入口を使う
  const inFlight = new Set();
  const recoveryOf = (taskId) => (recoveryStore ? recoveryStore.recoveryOf(taskId) : null);

  /**
   * 自動復旧が根拠にする台帳のうち読めないもの。
   * 「止まっているか (pause)」「何が仕事か (tasks)」「何回起こしたか (recovery)」
   * 「何が走ったか (job-runs)」のどれが欠けても、起こしてよいかは決められない
   */
  const brokenControlLedgers = () => brokenLedgers([pauseStore, board, recoveryStore, jobRuns]);

  /** そのスレッド宛の未消費契約 (担当と reviewer の分) */
  function pendingContractsFor(task, autonomy) {
    if (!contracts || !task?.threadId) return [];
    const keys = new Set([...(autonomy?.worker?.bots ?? []), autonomy?.reviewer].filter(Boolean));
    const out = [];
    for (const key of keys) {
      try {
        out.push(...contracts.list(task.threadId, key));
      } catch { /* 読めない契約は無いものとして (判定は fail-closed 側に倒れる) */ }
    }
    return out;
  }

  /** タスク 1 件の状態 */
  function statusOf(task, { at = now() } = {}) {
    const autonomy = autonomyFor(task?.channel);
    return deriveTaskStatus({
      task,
      runs: jobRuns.forThread(task?.threadId),
      pendingContracts: pendingContractsFor(task, autonomy),
      paused: pauseStore?.paused === true,
      backoffUntil: backoffUntilFor(task?.channel),
      recovery: recoveryOf(task?.id),
      reviewerKey: autonomy?.reviewer ?? null,
      now: at,
      graceMs,
    });
  }

  /** 復旧待ちの一覧 (/inbox・/status 用) */
  function rows({ channel = null, at = now(), excludeThreadIds = [] } = {}) {
    const tasks = board.list(channel ? { channel } : {}).filter((t) => WORKING_STATES.includes(t.state));
    return recoveryRows(tasks, (task) => statusOf(task, { at }), { excludeThreadIds });
  }

  /**
   * tick ごとの見回り。**新しい判断待ちの通知は問題ごとに 1 回**で、毎 tick 撒かない。
   * 通知の失敗 (スレッド削除・Discord 障害) は記録して次の tick で 1 回だけやり直す。
   * @returns {Promise<{rows: object[], notified: string[]}>}
   */
  async function sweep({ at = now() } = {}) {
    const all = [];
    for (const channel of channels) all.push(...rows({ channel, at }));
    const liveKeys = new Set(all.map(stallKey));
    for (const key of notified.keys()) {
      if (!liveKeys.has(key)) notified.delete(key); // 解消した問題の記録は捨てる (同じ鍵で止まり直せば出し直す)
    }
    const sent = [];
    for (const row of all) {
      const key = stallKey(row);
      if (notified.has(key)) continue;
      const text = stallNoticeText(row, { now: at });
      log(`[recovery] ${text.split('\n').slice(0, 2).join(' / ')}`);
      let ok = true;
      if (typeof notify === 'function') {
        try {
          ok = (await notify({ task: row.task, status: row.status, text })) !== false;
        } catch (err) {
          ok = false;
          log(`[recovery] #${row.task.id} の通知に失敗 (次の tick でやり直す): ${err?.message ?? err}`);
        }
      }
      if (ok) {
        notified.set(key, at);
        sent.push(key);
      }
    }
    return { rows: all, notified: sent };
  }

  /** キューにそのスレッドの job が居るか (実行中・待機中) */
  function hasLiveJob(threadId) {
    if (!jobs || !threadId) return false;
    const id = String(threadId);
    const active = jobs.active instanceof Map ? [...jobs.active.values()] : [];
    const waiting = Array.isArray(jobs.waiting) ? jobs.waiting : [];
    return active.some((i) => String(i?.threadId) === id) || waiting.some((i) => String(i?.threadId) === id);
  }

  /**
   * そのスレッドの**全**未照合記録の子プロセスを OS に聞く (最新 1 件ではない — レビュー指摘 2026-09-05)。
   * 1 件でも alive なら alive、無ければ unknown が 1 件でも unknown、全件 gone なら gone。
   * pid を持たない記録 (導入前の job) は照合対象にならず `unverified` へ (判定は null のまま)。
   *
   * @returns {Promise<{liveness: 'alive'|'gone'|'unknown'|null, livePids: number[], unknownPids: number[],
   *                    gone: object[], unverified: object[]}>}
   */
  async function livenessOf(threadId) {
    const records = jobRuns.forThread(threadId).filter((r) => r.stage === 'reconcile');
    const out = { liveness: null, livePids: [], unknownPids: [], gone: [], unverified: [] };
    for (const run of records) {
      const spawn = run.spawn ?? null;
      if (!spawn || !Number.isSafeInteger(spawn.pid) || spawn.pid <= 0) {
        out.unverified.push(run);
        continue;
      }
      let verdict = 'unknown';
      if (typeof inspectProcess === 'function') {
        try {
          verdict = judgeLiveness(spawn, await inspectProcess(spawn.pid));
        } catch {
          verdict = 'unknown';
        }
      }
      if (verdict === 'alive') out.livePids.push(spawn.pid);
      else if (verdict === 'unknown') out.unknownPids.push(spawn.pid);
      else out.gone.push(run);
    }
    if (out.livePids.length > 0) out.liveness = 'alive';
    else if (out.unknownPids.length > 0) out.liveness = 'unknown';
    else if (out.gone.length > 0) out.liveness = 'gone';
    return out;
  }

  /**
   * 未完了の再開要求を現状に照らして閉じられるなら閉じる:
   * - 送達不明 → スレッドに印のある投稿があれば `sent` に (ID を覚える)、無ければ `failed` に。聞けなければそのまま
   * - 送信済みで受付前 → 実行記録に受け付けた job があれば `accepted`、猶予を過ぎていれば `expired`
   * @returns {object|null} まだ残っている要求
   */
  async function settleOpenRequest(task, { at }) {
    const open = recoveryStore.openRequest(task.id);
    if (!open) return null;
    if (open.result === 'send-unknown' && typeof findRequestMessage === 'function') {
      const marker = requestMarker(task.id, open.generation);
      try {
        const found = normalizeLookup(await findRequestMessage({
          threadId: task.threadId, marker, since: msOfTime(open.at),
        }));
        const attemptedAt = msOfTime(open.sentAt ?? open.at);
        if (found.messageId) {
          recoveryStore.settle(task.id, open.generation, 'sent', { messageId: found.messageId, now: at });
        } else if (found.complete && Number.isFinite(attemptedAt) && at - attemptedAt >= verifyDelayMs) {
          // 「見つからなかった」と「未送信が確定した」は別 — 要求以降の投稿を**全件**走査し、
          // 送信から十分に時間が経っていて、それでも無いときだけ確定させる
          recoveryStore.settle(task.id, open.generation, 'failed(送達なしを確認 — 要求以降の投稿を全件走査)', { now: at });
        } else {
          log(`[recovery] #${task.id} の ${marker} は送達を確かめられなかった (${found.complete ? '送信から時間が経っていない' : '走査が不完全'}) — 不明のまま塞ぎます`);
        }
      } catch (err) {
        log(`[recovery] #${task.id} の ${marker} をスレッドで探せなかった (${err?.message ?? err}) — 不明のまま塞ぎます`);
      }
    }
    // 受付は src/bridge/messages.js の受付点が `noteAccepted` で閉じるが、再起動を挟んだものはここでも実行記録と照合する
    reconcileRequestsFor(task);
    const current = recoveryStore.openRequest(task.id);
    if (current?.result === 'sent') {
      const sentAt = msOfTime(current.sentAt ?? current.at);
      if (Number.isFinite(sentAt) && at - sentAt >= requestGraceMs) {
        recoveryStore.expire(task.id, current.generation, { now: at });
        log(`[recovery] #${task.id} の再開要求 ${requestMarker(task.id, current.generation)} は猶予内に受け付けられなかったので期限切れにしました`);
        return recoveryStore.openRequest(task.id);
      }
    }
    return current;
  }

  /** 送信済みの要求を実行記録 (受付済みの job) と突き合わせて閉じる */
  function reconcileRequestsFor(task) {
    const open = recoveryStore.openRequest(task.id);
    if (!open || open.result === 'pending') return null;
    const runs = jobRuns.forThread(task.threadId);
    const sentAt = msOfTime(open.sentAt ?? open.at);
    const match = runs.find((r) => (open.messageId && r.trigger?.messageId === open.messageId)
      || (!open.messageId && open.targetBotKey && r.botKey === open.targetBotKey
        && Number.isFinite(msOfTime(r.acceptedAt)) && (!Number.isFinite(sentAt) || msOfTime(r.acceptedAt) >= sentAt)));
    if (!match) return null;
    return recoveryStore.markAccepted(task.id, { triggerMessageId: open.messageId, botKey: match.botKey, runId: match.id, now: msOfTime(match.acceptedAt) || now() });
  }

  /**
   * 受付点 (src/bridge/messages.js の accept) から呼ぶ: この job を起こした投稿が再開要求なら要求を閉じる。
   * @returns {object|null} 閉じた要求
   */
  function noteAccepted({ taskId, triggerMessageId = null, botKey = null, runId = null, at = now() } = {}) {
    if (!recoveryStore || !taskId) return null;
    try {
      return recoveryStore.markAccepted(taskId, { triggerMessageId, botKey, runId, now: at });
    } catch (err) {
      log(`[recovery] #${taskId} の再開要求を閉じられませんでした: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 受付側の照合 (レビュー指摘 2026-09-05 A)。bot が投げた起動メッセージが再開要求の印を
   * 持っていたら、その要求が**いま有効か**を台帳で確かめる。期限切れ・受付済み (再配送)・送れなかったと
   * 記録済み・宛先違い・別の投稿なら起動しない。印の無い投稿は判定しない (通常の handoff を断らない)。
   * **hop と予算を消費する前**に呼ぶこと (見送る job で減らさない)。
   *
   * @returns {{ok: boolean, reason?: string, request: {taskId: string, generation: number}|null}}
   */
  function screenTrigger({ threadId, content, botKey = null, messageId = null } = {}) {
    const parsed = parseRequestMarker(content);
    if (!parsed) return { ok: true, request: null };
    if (!recoveryStore) return { ok: true, request: parsed }; // 台帳の無い配備では要求は作られない (印だけでは断らない)
    const label = requestMarker(parsed.taskId, parsed.generation);
    const refuse = (why) => ({ ok: false, reason: `${label} は起動しません — ${why}`, request: parsed });
    const task = board.findByThread(threadId);
    if (!task || String(task.id) !== String(parsed.taskId)) {
      return refuse(`このスレッドのタスク (${task ? `#${task.id}` : '無し'}) の要求ではありません`);
    }
    const attempt = recoveryStore.attemptOf(task.id, parsed.generation);
    if (!attempt) return refuse('台帳に無い要求です (作り直された台帳か、別のプロセスの要求)');
    const result = String(attempt.result ?? '');
    if (result === 'accepted') return refuse(`既に受け付け済みです (job ${attempt.runId ?? '?'}) — 同じ投稿の再配送`);
    if (result === 'expired') return refuse('猶予内に受け付けられず期限切れになり、新しい要求が出ています');
    if (result.startsWith('failed')) return refuse('送れなかったと記録された要求の投稿が遅れて届きました');
    if (attempt.targetBotKey && botKey && attempt.targetBotKey !== botKey) {
      return refuse(`宛先は ${attempt.targetBotKey} で、${botKey} 宛ではありません`);
    }
    if (attempt.messageId && messageId && String(attempt.messageId) !== String(messageId)) {
      return refuse(`記録された投稿 (${attempt.messageId}) と違う投稿です`);
    }
    return { ok: true, request: { taskId: task.id, generation: parsed.generation } };
  }

  /** 起動時: 全 task の送信済み要求を実行記録と照合する (再起動を挟んだ同一要求を再送しない) */
  function reconcileRequests() {
    if (!recoveryStore) return [];
    const closed = [];
    for (const entry of recoveryStore.list()) {
      const task = board.list().find((t) => String(t.id) === String(entry.taskId)) ?? null;
      if (!task) continue;
      const done = reconcileRequestsFor(task);
      if (done) closed.push({ taskId: task.id, generation: done.generation, runId: done.runId });
    }
    return closed;
  }

  /**
   * `/retry` の実体。**手動も自動も同じ入口**。
   * 順序: 状態の判定 → 子プロセスの照合 → 純粋な可否 → 世代の確保 (排他) → 起こす → 結果を記録。
   *
   * @param {{thread: {id: string}, id?: string|null, bot?: object|null, userId?: string|null,
   *          kind?: 'manual'|'auto', at?: number}} p
   * @returns {Promise<{ok: boolean, reason: string, warnings?: string[], target?: string|null}>}
   */
  async function retry({ thread, id = null, bot = null, userId = null, kind = 'manual', at = now() } = {}) {
    if (!recoveryStore) return { ok: false, reason: '復旧の台帳 (data/recovery.json) が配線されていません', warnings: [] };
    const task = board.findByThread(thread?.id);
    if (!task) {
      return { ok: false, reason: 'このスレッドに対応するタスクがありません (タスクのスレッドで打ってください)', warnings: [] };
    }
    if (inFlight.has(String(task.id))) {
      return { ok: false, reason: `#${task.id} の再開は進行中です (連打しても 1 回だけ起こします)`, warnings: [] };
    }
    inFlight.add(String(task.id));
    try {
      const autonomy = autonomyFor(task.channel) ?? {};
      const status = statusOf(task, { at });
      // 送信済み・送達不明の再開要求が残っていれば、現状に照らして閉じられるものだけ閉じる。
      // 残ったものは planRetry が「受付待ち」「送達不明」として断る
      const openRequest = await settleOpenRequest(task, { at });
      const checked = await livenessOf(task.threadId);
      const plan = planRetry({
        task,
        id,
        status,
        paused: pauseStore?.paused === true,
        inFlight: false,
        liveJob: hasLiveJob(task.threadId),
        pendingContracts: pendingContractsFor(task, autonomy),
        liveness: checked.liveness,
        livePids: checked.livePids,
        unknownPids: checked.unknownPids,
        workerKeys: autonomy.worker?.bots ?? [],
        reviewerKey: autonomy.reviewer ?? null,
        availableBotKeys: availableBotKeys(),
        hopBudget: hops ? hops.taskBudget(task.threadId) : null,
        openRequest,
        now: at,
      });
      if (!plan.ok) return { ok: false, reason: plan.reason, warnings: plan.warnings, target: null, sent: false };
      if (checked.unverified.length > 0) {
        // pid の無い記録 (導入前の job) は照合できない。消滅を確認した記録と混在していても件数を出す
        // (planRetry の警告は照合対象がまったく無いときの一般文なので、件数はここで足す)
        plan.warnings.push(`pid の無い未照合記録 ${checked.unverified.length} 件を、人間の明示操作として閉じます`);
      }

      // **世代を確保してから起こす** (ここから先の await の間に別の入口が来ても inFlight と世代で弾く)
      const targetBotKey = plan.target === 'reviewer' ? autonomy.reviewer ?? null : plan.workerKey;
      const { generation } = recoveryStore.begin(task.id, {
        by: userId ?? bot?.key ?? null, kind, target: plan.target, targetBotKey,
        previousRunId: plan.previous?.id ?? null, now: at,
      });
      const settle = (result, extra = {}) => {
        try { recoveryStore.settle(task.id, generation, result, { now: now(), ...extra }); }
        catch (err) { log(`[recovery] #${task.id} の結果を記録できませんでした: ${err?.message ?? err}`); }
      };

      // 要照合の記録は**消滅を確認できたものだけ**閉じる (pid の無い記録は人間の明示操作として閉じる)。
      // alive / unknown が 1 件でもあれば planRetry が既に断っているので、ここに来た時点で残りは gone か未照合
      for (const run of [...checked.gone, ...checked.unverified]) {
        const how = checked.gone.includes(run)
          ? (kind === 'auto' ? 'auto-retry:process-gone' : 'retry:process-gone')
          : 'retry:unverified';
        try {
          jobRuns.resolveReconcile(run.id, { how, by: userId ?? bot?.key ?? null, now: at });
        } catch (err) {
          log(`[recovery] 要照合 ${run.id} を閉じられませんでした: ${err?.message ?? err}`);
        }
      }

      if (plan.target === 'reviewer') {
        if (typeof reissueReview !== 'function') {
          settle('failed(reissueReview 未配線)');
          return { ok: false, reason: 'レビューの出し直しが配線されていません', warnings: plan.warnings, sent: false };
        }
        const sent = await reissueReview({ thread, id: null, bot });
        // 召喚の制御メンションの ID は取れないので、受付は宛先 bot と時刻で照合する (markAccepted)
        settle(sent?.ok ? 'sent' : `failed(${String(sent?.reason ?? '').slice(0, 120)})`);
        return {
          ok: sent?.ok === true,
          reason: sent?.ok ? `🔁 ${plan.reason}\n${sent.reason}` : String(sent?.reason ?? 'レビューを出し直せませんでした'),
          warnings: plan.warnings,
          target: 'reviewer',
          sent: sent?.ok === true,
        };
      }

      // worker: 担当以外の client から起動メッセージを投げる (自分の多行発言は捨てられる)
      const workerKey = plan.workerKey;
      const workerUserId = botUserId(workerKey);
      if (!workerUserId) {
        settle('failed(worker の userId 不明)');
        return { ok: false, reason: `担当 ${workerKey} の Discord ID が取れません (起動していない?)`, warnings: plan.warnings, sent: false };
      }
      const announcerKey = bot?.key && bot.key !== workerKey
        ? bot.key
        : pickAnnouncer(workerKey, autonomy, availableBotKeys());
      if (!announcerKey || typeof postAs !== 'function') {
        settle('failed(投げ手なし)');
        return { ok: false, reason: `担当 ${workerKey} を呼べる bot が居ません (担当自身からは起こせません)`, warnings: plan.warnings, sent: false };
      }
      // 門番が無いスレッド (再起動後) は台帳の残高で組み直す。**増やさない** — 台帳の値をそのまま写す
      if (hops && hops.taskBudget(task.threadId) === null) {
        try { hops.grantTaskBudget(task.threadId, remainingJobs(task)); }
        catch (err) { log(`[recovery] #${task.id} の予算の門番を組み直せませんでした: ${err?.message ?? err}`); }
      }
      const priorRuns = jobRuns.forThread(task.threadId).filter((r) => r.botKey === workerKey);
      const requestId = requestMarker(task.id, generation);
      const text = retryMessage({
        task,
        botUserId: workerUserId,
        attempt: priorRuns.length + 1,
        previous: plan.previous,
        remaining: remainingJobs(task),
        directionFile: autonomy.directionFile ?? '',
        gitChanged: safeGitDirty(gitDirty, task, autonomy),
        lastActivity: describeActivity(plan.previous ? jobRuns.get(plan.previous.id) : null),
        kind,
        requestId,
      });
      let posted;
      try {
        posted = await postAs({ botKey: announcerKey, threadId: task.threadId, text, mentionUserIds: [workerUserId] });
      } catch (err) {
        // **送れたか分からない失敗は未送信へ戻さない** — 要求は送達不明として残り、次の /retry で
        // スレッドの印を確かめてから決める。確実に送れていないときだけ failed
        const kindOfError = classifySendError(err);
        settle(kindOfError === 'unknown' ? 'send-unknown' : `failed(${String(err?.message ?? err).slice(0, 120)})`);
        return {
          ok: false,
          reason: kindOfError === 'unknown'
            ? `起動メッセージの送達が不明です (${err?.message ?? err}) — 要求 ${requestId} を残しました。スレッドに投稿があれば受付を待ち、無ければ次の \`/retry\` で照合してやり直します`
            : `起動メッセージを投稿できませんでした: ${err?.message ?? err}`,
          warnings: plan.warnings,
          sent: kindOfError === 'unknown' ? 'unknown' : false,
        };
      }
      settle('sent', { messageId: posted?.id ?? null });
      log(`[recovery] #${task.id} を ${workerKey} で起こし直し (${kind} / ${requestId} / 投稿は ${announcerKey})`);
      return { ok: true, reason: `🔁 ${plan.reason}`, warnings: plan.warnings, target: 'worker', sent: true, requestId };
    } finally {
      inFlight.delete(String(task.id));
    }
  }

  /**
   * 自動復旧の tick。**観測 mode が既定** — 判断だけして起こさない。
   * `auto` のチャンネルでも、起こすのは `planRecovery` が `retry` と言ったものだけで、
   * 実際の起こし方は `/retry` と同じ入口 (`retry({kind:'auto'})`) を通る (連打・二重投入の排他も同じ)。
   *
   * @returns {Promise<{decisions: Array<{taskId: string, action: string, reason: string}>}>}
   */
  async function autoTick({ at = now() } = {}) {
    const decisions = [];
    if (!recoveryStore) return { decisions };
    for (const channel of channels) {
      const autonomy = autonomyFor(channel) ?? {};
      const config = autonomy.recovery ?? { mode: 'observe' };
      if (config.mode === 'off') continue;
      const tasks = board.list({ channel }).filter((t) => WORKING_STATES.includes(t.state));
      for (const task of tasks) {
        let status;
        try {
          status = statusOf(task, { at });
        } catch (err) {
          log(`[recovery] #${task.id} の状態を判定できません (自動復旧は見送り): ${err?.message ?? err}`);
          continue;
        }
        if (status.status !== 'recovery-wait') continue;
        const decision = planRecovery({
          task,
          status,
          config,
          recovery: recoveryStore.recoveryOf(task.id),
          paused: pauseStore?.paused === true,
          backoffUntil: backoffUntilFor(channel),
          dayJobsLeft: dayJobsLeftFor(channel),
          jobRunsHealthy: jobRuns.healthy !== false,
          brokenLedgers: brokenControlLedgers(),
          taskKind: isApplyTask(task) ? 'apply' : 'board',
          now: at,
        });
        decisions.push({ taskId: task.id, action: decision.action, reason: decision.reason });
        const key = `${task.id}:${decision.action}:${decision.reason}`;
        const first = !observed.has(key);
        observed.set(key, at);
        if (decision.action === 'halt') {
          if (first) log(`[recovery] ⛔ ${decision.reason}`);
          return { decisions, halted: true };
        }
        if (decision.action === 'none') continue;
        if (decision.action === 'observe') {
          if (first) log(`[recovery] #${task.id} (${config.mode}): ${decision.reason}`);
          continue;
        }
        if (decision.action === 'schedule') {
          const current = recoveryStore.recoveryOf(task.id)?.nextAutoAt ?? null;
          if (msOfTime(current) !== decision.nextAt) {
            try {
              recoveryStore.scheduleAuto(task.id, { nextAt: decision.nextAt, reason: decision.reason, now: at });
              log(`[recovery] #${task.id}: ${decision.reason}${config.mode === 'observe' ? ' (観測 mode — 時刻が来ても起こさない)' : ''}`);
            } catch (err) {
              log(`[recovery] #${task.id} の予定を記録できませんでした: ${err?.message ?? err}`);
            }
          }
          continue;
        }
        // retry (mode auto のときだけ planRecovery が返す)。
        // **送信前に日次予算を 1 本予約する** (通常の着手と同じ勘定 — レビュー指摘 2026-09-05)。
        // 同じ tick の 2 件目は予約後の残高を見るので、残高 1 で 2 件起こすことはない
        if (typeof reserveDayJob === 'function' && !reserveDayJob(channel, { at })) {
          if (first) log(`[recovery] #${task.id}: 日次予算を予約できないので起こしません`);
          continue;
        }
        log(`[recovery] #${task.id}: ${decision.reason} — 起こします`);
        const out = await retry({ thread: { id: task.threadId }, kind: 'auto', userId: 'auto', at });
        log(`[recovery] #${task.id}: ${out.ok ? '起こしました' : `起こせませんでした — ${out.reason}`}`);
        if (!out.ok) {
          // 起こせなかったのに予定だけ残ると「再開予定」のまま止まる。予定を消して復旧待ちへ戻す
          try { recoveryStore.cancelAuto(task.id); } catch { /* 表示の問題だけ */ }
          // 予約は**確実に送れなかったとき**だけ戻す (送達不明で戻すと、届いていた場合に上限を超える)
          if (out.sent === false && typeof refundDayJob === 'function') refundDayJob(channel, { at });
        }
      }
    }
    // 消えた鍵は捨てる (同じ判断が戻ってきたら 1 回だけ出し直す)
    const live = new Set(decisions.map((d) => `${d.taskId}:${d.action}:${d.reason}`));
    for (const key of observed.keys()) if (!live.has(key)) observed.delete(key);
    return { decisions };
  }

  return {
    statusOf,
    rows,
    sweep,
    retry,
    autoTick,
    noteAccepted,
    reconcileRequests,
    screenTrigger,
    /** 診断用 */
    notifiedKeys: () => [...notified.keys()],
    inFlightIds: () => [...inFlight],
  };
}

/**
 * `findRequestMessage` の戻りを `{messageId, complete}` に揃える。文字列は「見つかった」、
 * `null` / `undefined` は**走査の完全性を主張していない**ので不完全 (= 不明のまま) と読む
 */
function normalizeLookup(value) {
  if (typeof value === 'string' && value !== '') return { messageId: value, complete: true };
  if (value && typeof value === 'object') {
    return { messageId: value.messageId ? String(value.messageId) : null, complete: value.complete === true };
  }
  return { messageId: null, complete: false };
}

/** 直前の job の記録から「最後に観測できた活動」を 1 行にする */
function describeActivity(run) {
  const activity = run?.lastActivity;
  if (!activity?.detail) return null;
  const at = msOfTime(activity.at);
  return `${activity.detail}${Number.isFinite(at) ? ` (${new Date(at).toISOString()})` : ''}`;
}

/** 作業ツリーの状態を読む (読めなければ null — 断定しない) */
function safeGitDirty(gitDirty, task, autonomy) {
  if (typeof gitDirty !== 'function') return null;
  try {
    return gitDirty({ task, autonomy });
  } catch {
    return null;
  }
}
