// job の実行記録 (src/jobruns.js) への書き口と、起動時の照合。
// src/index.js から切り出した配線層 — 判断は持たない。**記録の失敗で job を落とさない**
// (受付と終端だけは呼び出し側が失敗を見る) という約束をここで守る。

/**
 * 起動時の照合と掃除。前プロセスが終端まで記録できなかった job は「要照合」にし、
 * 保持期間を過ぎた終端記録を消す。読めない台帳は**在処に残したまま**空のメモリで開く
 * (store 側。退避すると次の起動が「初回」に見える)。
 * 結果はログに出すだけ — 起動は止めない (止まるのは自律起動と自動復旧)。
 */
export function reconcileJobRunsOnStartup(jobRuns) {
  if (jobRuns.broken) {
    console.error(
      `[jobruns] data/job-runs.json が読めませんでした (${jobRuns.broken}) — 退避していません。`
      + '**記録が無いことを「仕事が無い」と読まないこと** '
      + '(自律起動と自動復旧は止まります。直すか手で退避してください)',
    );
  }
  // 前プロセスが終端まで記録できなかった job は「要照合」— 走っているとも失敗したとも決めない。
  // 子プロセスが残っていないことを確かめられるまで、同じタスクを起こさない (src/procstate.js)
  {
    const reconciled = jobRuns.reconcileOnStartup();
    if (reconciled.length > 0) {
      console.log(
        `[jobruns] 前回の未終端 ${reconciled.length} 件を要照合にしました: `
        + reconciled.map((r) => `${r.id} (${r.botKey} thread:${r.threadId}${r.taskId ? ` task #${r.taskId}` : ''} ${r.reconcile?.fromStage ?? '?'})`).join(' / '),
      );
    }
    try {
      const pruned = jobRuns.pruneEnded();
      if (pruned > 0) console.log(`[jobruns] 保持期間を過ぎた終端記録 ${pruned} 件を消しました`);
    } catch (err) {
      console.error(`[jobruns] 古い記録の掃除に失敗 (起動は続けます): ${err.message}`);
    }
  }
}

/**
 * runJob / runItem が実行記録へ書くための口を作る (`runRecorder(id)`)。
 * @param {{jobRuns: import('../jobruns.js').JobRunStore}} deps
 */
export function createRunRecorder({ jobRuns }) {
  /**
   * runJob / runItem から実行記録へ書く口。**記録の失敗で job を落とさない** —
   * ここを通る書き込みは job の途中経過で、書けなくても実行そのものは続ける
   * (失敗は store が writeFailures に覚えるので、台帳の信用が落ちたことは別に分かる)。
   * 受付 (`open`) と終端 (`finish`) だけは呼び出し側が失敗を見る。
   */
  function runRecorder(id) {
    const guard = (label, fn) => {
      if (id === null || id === undefined) return null; // 記録の無い呼び出し (テスト・旧経路) は黙って通す
      try {
        return fn();
      } catch (err) {
        console.error(`[jobruns] ${id}: ${label} を記録できませんでした: ${err.message}`);
        return null;
      }
    };
    return {
      id,
      stage: (stage, detail = '') => guard(`段階 ${stage}`, () => jobRuns.setStage(id, stage, { detail })),
      spawn: (info) => guard('spawn', () => jobRuns.noteSpawn(id, info)),
      model: (res) => guard('モデルの結果', () => jobRuns.noteModelResult(id, res)),
      activity: (info) => guard('活動', () => jobRuns.noteActivity(id, info)),
      delivery: (step, status) => guard(`配送 ${step}`, () => jobRuns.noteDelivery(id, step, status)),
      stopRequested: (kind) => guard('停止指示', () => jobRuns.markStopRequested(id, kind)),
      // 終端の記録に失敗した = 結果不明。job は既に終わっているので投げずに残す
      finish: (fields) => {
        try {
          return jobRuns.finish(id, fields);
        } catch (err) {
          console.error(
            `[jobruns] ${id}: 終了を記録できませんでした — この job の結果は**不明**として扱います `
            + `(自動復旧は止まります): ${err.message}`,
          );
          return null;
        }
      },
    };
  }

  return runRecorder;
}
