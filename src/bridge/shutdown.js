// 再起動と停止の配線 (src/index.js から切り出し)。
// 自分自身を起動し直すことはできないので、終了コード 42 で終わり
// scripts/run.mjs (npm start のラッパー) に再起動させる。中身は src/interactions.js の
// runShutdown (テストのある側) — ここは何を渡すかと、再起動完了の通知だけ。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runShutdown } from '../interactions.js';
import { sendSafe } from '../mentions.js';

export const RESTART_DRAIN_MS = 30000; // force 時に実行中 job の中断完了を待つ上限
// Ctrl-C は日常操作なので、再起動よりずっと短く待つ。abort は killTree
// (taskkill /T /F) を撃つだけなので通常 1 秒未満で抜ける — この値は「効かなかった
// ときに諦めるまで」の上限。hardExit は必ず drain より長くする (drain 中に
// 発火すると runJob の finally が走らず一時ディレクトリが残る)。
// 8 秒 / 15 秒は Ctrl-C の応答性を優先した作者裁定 (2026-08-01)。
// 後始末を最優先するなら 30 秒 / 40 秒が代案だった
export const SHUTDOWN_DRAIN_MS = 8000;
export const SHUTDOWN_HARD_EXIT_MS = 15000;

/**
 * @param {object} deps
 * @param {string} deps.root                  data/restart-notice.json の置き場の根
 * @param {Map<string, object>} deps.bots
 * @param {import('../queue.js').JobQueue} deps.jobs
 * @param {object} deps.lifecycle
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {(ms: number, label?: string) => Promise<void>} deps.waitForJobsDrained
 * @param {() => unknown} [deps.abortOrgApply] 適用回路の verify を撃つ口
 *        (src/bridge/orgapply.js の `abortVerify`)。**job ではないので stopJobs では撃てない**
 * @param {(code: number) => void} [deps.exit] プロセス終了 (テストから差し替える)
 */
export function createShutdownWiring({
  root, bots, jobs, lifecycle, jobRuns, waitForJobsDrained,
  abortOrgApply = null, exit = (code) => process.exit(code),
}) {
  const RESTART_NOTICE_FILE = resolve(root, 'data', 'restart-notice.json');
  let noticeHandled = false;

  /** 再起動元のチャンネルを次プロセスへ引き継ぐ */
  function writeRestartNotice(notice) {
    try {
      mkdirSync(dirname(RESTART_NOTICE_FILE), { recursive: true });
      writeFileSync(RESTART_NOTICE_FILE, JSON.stringify(notice));
    } catch (err) {
      console.error(`[restart] 完了通知の予約に失敗 (再起動は続行): ${err.message}`);
    }
  }

  /** 起動完了時に「✅ 再起動完了」を元のチャンネルへ投稿する (失敗しても起動は継続) */
  async function announceRestartComplete() {
    if (noticeHandled) return;
    noticeHandled = true;
    let notice;
    try {
      notice = JSON.parse(readFileSync(RESTART_NOTICE_FILE, 'utf8'));
    } catch {
      return; // 通常起動 (通知ファイルなし)
    }
    // 投稿の成否によらず先に消す (次の通常起動で二重投稿しない)
    try { rmSync(RESTART_NOTICE_FILE, { force: true }); } catch { /* 残っても実害なし */ }
    const bot = bots.get(notice.botKey) ?? [...bots.values()][0];
    if (!bot || !notice.channelId) return;
    try {
      const channel = await bot.client.channels.fetch(notice.channelId);
      if (channel) await sendSafe(channel, '✅ 再起動完了');
    } catch (err) {
      console.error(`[restart] 完了通知の投稿に失敗: ${err.message}`);
    }
  }

  /**
   * 終了前の後始末 (restart / SIGINT / SIGTERM 共通)。
   * 待機 job は次プロセスへ引き継がれないので、⏳ のまま放置せず取り消しを見せる。
   * 中身は runShutdown (テストのある側) — ここは何を渡すかだけ。
   */
  async function shutdown(
    code,
    cancelMessage = '⏹ ブリッジ停止により取り消し — 再メンションしてください',
    { drained = false } = {},
  ) {
    // 生きている実行記録に「ブリッジの停止で切れた」と残す。**中断より先に書く** —
    // 再起動後の照合で、途中で切れた job が意図的な停止だったと分かる (自動復活させない根拠)
    try {
      jobRuns.markShutdown({ reason: `shutdown(${code})` });
    } catch (err) {
      console.error(`[jobruns] 停止の印を残せませんでした: ${err.message}`);
    }
    await runShutdown({
      jobs,
      lifecycle,
      cancelMessage,
      // /restart force は自前の枠で drain も進行中の受付も待ち切っている。
      // ここで待ち直すと実効待機がその合計になり、裁定した上限を超える
      drainMs: SHUTDOWN_DRAIN_MS,
      drained,
      hardExitMs: SHUTDOWN_HARD_EXIT_MS,
      drain: (ms) => waitForJobsDrained(ms, 'shutdown'),
      // 適用回路 (org-apply) の verify はキューに載らないので、ここから別に撃つ
      abortOrgApply,
      destroyClients: () => Promise.allSettled([...bots.values()].map((b) => b.client.destroy())),
      exit: () => exit(code),
    });
  }

  return { writeRestartNotice, announceRestartComplete, shutdown };
}
