// 再起動の依頼 (data/restart-request.json) を拾う配線。
// 人が Discord で /restart を打つ代わりに、別プロセス (npm run new-project など) が
// 置いていった依頼を、job が 1 件も無いときにだけ拾って /restart と同じ手順で落ちる。
// 判断は src/restart.js の planRestartRequest (純粋)、手順は src/interactions.js の
// restartBridge (/restart と共有)。ここは読み書きとつなぎだけ。
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { restartBridge } from '../interactions.js';
import { RESTART_REQUEST_FILE, planRestartRequest } from '../restart.js';

/**
 * @param {object} deps
 * @param {string} deps.root ブリッジのルート (依頼の置き場の根)
 * @param {number} deps.startedAt このプロセスの起動時刻 (ms)。これより前の依頼は読み込み済みとして捨てる
 * @param {object} deps.jobs
 * @param {object} deps.lifecycle
 * @param {(ms: number, label?: string) => Promise<void>} deps.waitForJobsDrained
 * @param {(notice: object) => void} deps.writeRestartNotice
 * @param {(code: number, cancelMessage?: string, opts?: object) => Promise<void>} deps.shutdown
 * @param {number} deps.restartDrainMs
 * @param {object} [deps.fs] テストから差し替える (readFileSync / rmSync)
 * @param {(p: object) => Promise<void>} [deps.restart] 再起動の手順 (既定は restartBridge。テストから差し替える)
 */
export function createRestartRequestWiring({
  root, startedAt, jobs, lifecycle, waitForJobsDrained, writeRestartNotice, shutdown, restartDrainMs,
  fs = { readFileSync, rmSync }, restart = restartBridge,
}) {
  const file = resolve(root, RESTART_REQUEST_FILE);
  let checking = false;
  let lastNoted = ''; // 同じ待ち理由を 30 秒ごとに撒かない

  function note(line) {
    if (line === lastNoted) return;
    lastNoted = line;
    console.log(`[restart-request] ${line}`);
  }

  /** 無ければ null、壊れていれば { invalid: true } */
  function readRequest() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      return { invalid: true };
    }
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : { invalid: true };
    } catch {
      return { invalid: true };
    }
  }

  /** 消せたら true。**消せないまま落ちると、次の起動でもまた落ちる** ので、消せなければ落ちない */
  function removeRequest() {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch (err) {
      console.error(`[restart-request] 依頼を消せません (再起動は見送ります): ${err.message}`);
      return false;
    }
  }

  /**
   * 1 回分の確認。依頼が無ければファイルを 1 つ見に行くだけで何もしない。
   * @returns {Promise<'none'|'discard'|'wait'|'restart'|'kept'>} 何をしたか (テスト用)
   */
  async function check() {
    if (checking) return 'none';
    checking = true;
    try {
      const request = readRequest();
      const plan = planRestartRequest({
        request,
        startedAt,
        accepting: lifecycle.accepting,
        activeCount: jobs.activeCount,
        waitingCount: jobs.waitingCount,
        pendingAdmissions: lifecycle.pendingAdmissions ?? 0,
      });
      if (plan.action === 'none') return 'none';
      if (plan.action === 'discard') {
        removeRequest();
        note(`依頼を捨てました: ${plan.reason}`);
        return 'discard';
      }
      if (plan.action === 'wait') {
        note(plan.reason);
        return 'wait';
      }
      // restart: **依頼を消してから**落ちる
      if (!removeRequest()) return 'kept';
      console.log(`[restart-request] 再起動します (${plan.reason}${request?.by ? ` / 依頼元: ${request.by}` : ''})`);
      await restart({
        jobs,
        lifecycle,
        waitForJobsDrained,
        writeRestartNotice,
        shutdown,
        restartDrainMs,
        notice: request?.notice?.channelId && request?.notice?.botKey ? request.notice : null,
      });
      return 'restart';
    } finally {
      checking = false;
    }
  }

  return { check };
}
