// 止まった仕事の検知と再開の実体 (docs/social-engineering.md §11.2〜11.4。src/index.js から切り出し)。
// 判定は純粋関数 (src/taskstatus.js / src/recovery.js)、順序は src/recovery-wiring.js。
// ここは実体を結ぶだけ。通知はタスクのスレッドへ 1 通 (同じ問題につき 1 回)。
import { channelConfigForName, resolveAutonomy } from '../config.js';
import { gitStatusSnapshot } from '../gitstatus.js';
import { sendSafe } from '../mentions.js';
import { findApplyProposal } from '../orgapply-wiring.js';
import { inspectProcess } from '../procstate.js';
import { createRecoveryService } from '../recovery-wiring.js';
import {
  chargeJobs,
  initialState,
  jobsLeftToday,
  planTaskCwd,
  refundJobs,
} from '../scheduler.js';
import { canonicalCwd } from '../toolstore.js';
import { worktreePathFor } from '../worktree.js';
import { snowflakeAt } from './discord.js';

/**
 * 復旧 service を組み立てる。ボードの無い配備では null (自律運転の機能が無い)。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object|null} deps.board
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {import('../store.js').ContractStore} deps.contracts
 * @param {import('../store.js').PauseStore} deps.pauseStore
 * @param {string[]} deps.autonomyChannels
 * @param {Map<string, object>} deps.tickStates       スケジューラの勘定 (src/bridge/scheduler.js)
 * @param {(name: string, state: object) => void} deps.saveTickState
 * @param {(threadId: string, text: string) => Promise<boolean>} deps.postToThread
 * @param {(args: object) => Promise<{ok: boolean, reason: string}>} deps.reissueReview `/review` の実体
 * @param {object|null} deps.recoveryStore  RecoveryStore (data/recovery.json)
 * @param {import('../queue.js').JobQueue} deps.jobs
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {Map<string, object>} deps.bots
 * @param {object|null} deps.proposals
 */
export function createRecoveryWiring({
  config, board, jobRuns, contracts, pauseStore, autonomyChannels, tickStates, saveTickState,
  postToThread, reissueReview, recoveryStore, jobs, hops, bots, proposals,
}) {
  const recovery = board
    ? createRecoveryService({
      board,
      jobRuns,
      contracts,
      pauseStore,
      channels: autonomyChannels,
      autonomyFor: (name) => resolveAutonomy(channelConfigForName(config, name)),
      backoffUntilFor: (name) => tickStates.get(name)?.backoffUntil ?? 0,
      notify: ({ task, text }) => postToThread(task.threadId, text),
      log: (line) => console.log(line),
      recoveryStore,
      jobs,
      hops,
      inspectProcess: (pid) => inspectProcess(pid),
      availableBotKeys: () => [...bots.values()].filter((b) => b.userId).map((b) => b.key),
      botUserId: (key) => bots.get(key)?.userId ?? null,
      // 再開メッセージは**担当以外の bot の client** から投げる (自分の多行発言は捨てられる)
      postAs: async ({ botKey, threadId, text, mentionUserIds }) => {
        const bot = bots.get(botKey);
        if (!bot?.userId) throw new Error(`${botKey} は起動していません`);
        const channel = bot.client.channels.cache.get(String(threadId))
          ?? await bot.client.channels.fetch(String(threadId));
        if (!channel) throw new Error(`スレッド ${threadId} を取得できません`);
        if (channel.isThread?.() && channel.archived) throw new Error(`スレッド ${threadId} は archive されています`);
        return sendSafe(channel, text, { mentionUserIds });
      },
      reissueReview: (args) => reissueReview(args),
      // 作業ツリーに前回の変更が残っているか (再開メッセージに書く材料。読めなければ断定しない)
      gitDirty: ({ task, autonomy }) => {
        const configured = channelConfigForName(config, task.channel);
        const canonical = configured ? canonicalCwd(configured.cwd) : null;
        if (!canonical) return null;
        const decided = planTaskCwd({ task, autonomy, botKey: null });
        const cwd = decided.useWorktree ? worktreePathFor(canonical, task.id) : canonical;
        const snapshot = gitStatusSnapshot(cwd); // 読めなければ null (断定しない)
        return snapshot === null ? null : snapshot.length > 0;
      },
      // 自動復旧 (§11.4) の門: チャンネルの日次予算の残と、適用 task (org-apply が担う — 二つの機構から動かさない)。
      // 日次予算は **planTick と同じ勘定 `jobsToday`** を使う (日付の繰越も同じ関数で)
      dayJobsLeftFor: (name) => jobsLeftToday(tickStates.get(name) ?? initialState(), {
        maxJobsPerDay: resolveAutonomy(channelConfigForName(config, name)).maxJobsPerDay,
        now: Date.now(),
      }).left,
      // 予約 = 送信前に jobsToday を 1 進めて保存する。払い戻しは確実に送れなかったときだけ
      reserveDayJob: (name, { at = Date.now() } = {}) => {
        const autonomy = resolveAutonomy(channelConfigForName(config, name));
        const current = tickStates.get(name) ?? initialState();
        const { left, state } = jobsLeftToday(current, { maxJobsPerDay: autonomy.maxJobsPerDay, now: at });
        if (left <= 0) return false;
        saveTickState(name, chargeJobs(state, { now: at }));
        return true;
      },
      refundDayJob: (name, { at = Date.now() } = {}) => {
        saveTickState(name, refundJobs(tickStates.get(name) ?? initialState(), { now: at }));
      },
      // 送達不明の再開要求をスレッドで探す (印 `再開要求 <task>-<世代>` を持つ、自前 bot の投稿)
      // 要求の作成時刻の少し前から**全件**走査する (最新 N 件だけでは範囲外に落ちる — レビュー指摘 B)。
      // `complete` は走査が末尾まで届いたか。since が無ければ最新 100 件しか見ないので complete: false
      findRequestMessage: async ({ threadId, marker, since = null }) => {
        const bot = [...bots.values()].find((b) => b.userId);
        if (!bot) throw new Error('起動している bot がありません');
        const channel = bot.client.channels.cache.get(String(threadId))
          ?? await bot.client.channels.fetch(String(threadId));
        if (!channel?.messages?.fetch) throw new Error(`スレッド ${threadId} を取得できません`);
        const ours = new Set([...bots.values()].map((b) => b.userId).filter(Boolean));
        let after = Number.isFinite(since) ? snowflakeAt(since - 5 * 60 * 1000) : null;
        let scanned = 0;
        for (let page = 0; page < 30; page += 1) {
          const batch = await channel.messages.fetch(after ? { after, limit: 100 } : { limit: 100 });
          const messages = [...batch.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          scanned += messages.length;
          const found = messages.find((m) => ours.has(m.author?.id) && String(m.content ?? '').includes(marker));
          if (found) return { messageId: found.id, complete: true, scanned };
          if (messages.length < 100) return { messageId: null, complete: after !== null, scanned };
          if (after === null) return { messageId: null, complete: false, scanned }; // 最新 100 件だけ
          after = messages[messages.length - 1].id;
        }
        return { messageId: null, complete: false, scanned }; // 30 ページで打ち切り = 不完全
      },
      isApplyTask: (task) => Boolean(proposals && findApplyProposal(proposals, task.id)),
    })
    : null;

  if (recovery) {
    // 再起動を挟んだ再開要求を実行記録と照合して閉じる (同じ要求を再送しない)
    try {
      const closed = recovery.reconcileRequests();
      if (closed.length > 0) {
        console.log(`[recovery] 送信済みの再開要求 ${closed.length} 件を受付済みとして閉じました: ${closed.map((c) => `#${c.taskId}-${c.generation}`).join(' / ')}`);
      }
    } catch (err) {
      console.error(`[recovery] 再開要求の照合に失敗 (起動は続けます): ${err.message}`);
    }
  }

  return recovery;
}
