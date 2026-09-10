// cwd レーン単位のキューと job の起動 (src/index.js から切り出し)。
// 同じ作業ツリーを 2 job が同時に触らないよう cwd ごとに直列化し、cwd が違うチャンネルは並走させる。
// 起動の可否は src/interactions.js (pumpJobs) と src/queue.js (JobQueue) が持ち、ここは
// 計測ログと実行記録の始点・終点を結ぶ。
import { pumpJobs } from '../interactions.js';
import { formatJobMetrics } from '../queue.js';

/**
 * @param {object} deps
 * @param {import('../queue.js').JobQueue} deps.jobs
 * @param {object} deps.lifecycle             createLifecycle の戻り値
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {(id: string|null) => object} deps.runRecorder
 * @param {(item: object, reason: string) => void} deps.noteAutonomyOutcome 自律 job の成否をバックオフの勘定へ
 * @param {object|null} [deps.society] 社会の配線 (Action の running / settled を記録する)。無い配備では null
 */
export function createJobQueueWiring({
  jobs, lifecycle, jobRuns, runRecorder, noteAutonomyOutcome, society = null,
}) {
  /**
   * その job が社会の Action に結ばれているか (受付の記録に残した操作 ID)。
   * **読めなくても job は止めない** — 台帳が読めないことと job の実行は別の話で、
   * 取りこぼしは次の tick の照合が拾う。
   */
  function societyActionOf(jobId) {
    if (!society) return null;
    try {
      return jobRuns.get(jobId)?.society?.actionId ?? null;
    } catch (err) {
      console.error(`[society] ${jobId}: 実行記録から案件を引けませんでした: ${err.message}`);
      return null;
    }
  }

  /** 社会台帳への記録は job の結果報告を壊さない (失敗はログ 1 行で、照合に任せる) */
  function noteSociety(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[society] ${label} を記録できませんでした (job は続けます): ${err.message}`);
    }
  }

  function enqueue(item) {
    jobs.push(item);
    pump();
  }

  /** 開始できる job をすべて起動する (レーンが空いていれば並行に走る) */
  function pump() {
    pumpJobs(jobs, lifecycle, (item) => void runItem(item));
  }

  /**
   * job 1 本を走らせ、終わりに計測ログを 1 行出す。
   * 待ち時間 (レーンが空くまで) と実行時間を分けて測るのが目的なので、
   * 計時の起点はここ — enqueue から実際に走り出すまでが queueWait になる。
   * run() が返す文字列が終了理由 (runJob の return を参照)。
   */
  async function runItem(item) {
    const startedAt = Date.now();
    let reason = 'internal-error';
    // job 側が「何を渡したか」を書き込む器。throw されても書かれた分は残る
    const metrics = {};
    // 実行記録: 走り出した時刻 (queueWait と run の境目と同じ)
    const recorder = runRecorder(item.jobId);
    try {
      jobRuns.start(item.jobId);
    } catch (err) {
      console.error(`[jobruns] ${item.jobId}: 開始を記録できませんでした (実行は続けます): ${err.message}`);
    }
    // 社会の Action に結ぶ job なら「走り出した」を台帳へ (§5 の running)
    const actionId = societyActionOf(item.jobId);
    if (actionId) noteSociety(`${actionId} の running`, () => society.noteRunning(actionId));
    // job 側が終わり方の文脈 (handoff 先・task の遷移・成果の証拠) をここへ書く
    const outcome = {};
    try {
      reason = (await item.run(metrics, recorder, outcome)) ?? 'ok';
    } catch (err) {
      console.error(`[job ${item.jobId} ${item.botKey} thread:${item.threadId}] job error`, err);
    } finally {
      const finished = recorder.finish({
        reason,
        handoff: outcome.handoff ?? null,
        taskState: outcome.taskState ?? null,
        taskSubmitted: outcome.taskSubmitted === true,
        evidence: {
          toolCalls: Number.isSafeInteger(metrics.toolCalls) ? metrics.toolCalls : null,
          traceReadable: outcome.traceReadable ?? null,
          gitChanged: outcome.gitChanged ?? null,
          hooks: outcome.hooks ?? null,
          // verify の結果 (無ければ null = 検証記録なし。/status は成功と数えない)
          verified: metrics.verifyPassed === 1 ? true : metrics.verifyPassed === 0 ? false : null,
        },
      });
      // job の結果を Action へ (§5 の settled)。**配送の後**なので、外へ出したものは出し終えている。
      // outcome / reason は実行記録と同じ値を使う (台帳と記録で食い違わせない)。
      //
      // **構造化された戻り (`case-turn`) が既に写していれば、ここは何もしない** (S2-3a) —
      // ここは「様式に合わなかった / モデルが落ちた」ときに Action を終端まで書くための
      // fallback で、二重に settle すると bot が書いた next も result も上書きされる
      if (actionId && outcome.societySettled !== true) {
        noteSociety(`${actionId} の settled`, () => society.noteSettled(actionId, {
          runId: item.jobId,
          outcome: finished?.outcome ?? null,
          reason: finished?.reason ?? reason,
        }));
      }
      noteAutonomyOutcome(item, reason);
      console.log(
        formatJobMetrics({
          jobId: item.jobId,
          botKey: item.botKey,
          threadId: item.threadId,
          queueWaitMs: startedAt - item.enqueuedAt,
          runMs: Date.now() - startedAt,
          reason,
          ...metrics,
        }),
      );
      jobs.finish(item);
      pump();
    }
  }

  /**
   * 実行中 job の中断完了 (レーン解放) を待つ。上限を過ぎたら待たずに進む。
   * 待っている間に届いたメンションは受け付けない — 呼ばれた時点で
   * このプロセスは終わりに向かっており、いま spawn しても殺すだけになる。
   */
  async function waitForJobsDrained(timeoutMs, label = 'restart') {
    lifecycle.stopAccepting();
    const deadline = Date.now() + timeoutMs;
    while (jobs.activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (jobs.activeCount > 0) {
      console.error(
        `[${label}] 実行中 ${jobs.activeCount} 件が ${Math.round(timeoutMs / 1000)} 秒で終わらなかったため待たずに終了します`,
      );
    }
  }

  return { enqueue, pump, runItem, waitForJobsDrained };
}
