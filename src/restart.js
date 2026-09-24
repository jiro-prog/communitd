// @ts-check
// Discord からの再起動 (/restart) まわりの純粋関数 (副作用なし — ラッパーと
// テストの両方から import する)。

/**
 * ブリッジ本体がこのコードで終了したときだけ scripts/run.mjs が再起動する。
 * クラッシュ (それ以外のコード) では再起動しない — 暴走ループと二重ログインを防ぐ。
 */
export const RESTART_EXIT_CODE = 42;

/** ラッパーの再起動条件 */
export function shouldRestart(code) {
  return code === RESTART_EXIT_CODE;
}

/**
 * 再起動してよいか。作業中の job を黙って殺さないため、
 * 実行中・待機中が 1 件でもあれば force 以外は拒否する。
 * @param {{activeCount?: number, waitingCount?: number, force?: boolean}} p
 */
export function evaluateRestart({ activeCount = 0, waitingCount = 0, force = false } = {}) {
  const busy = activeCount > 0 || waitingCount > 0;
  return { allowed: force || !busy, busy, activeCount, waitingCount, force: Boolean(force) };
}

/** 拒否時に Discord へ返す文面 */
export function restartRejectionMessage({ activeCount = 0, waitingCount = 0 } = {}) {
  return (
    `⚠️ 実行中 ${activeCount} 件・待機 ${waitingCount} 件の job があるため再起動しません。` +
    '終わるのを待つか、`/restart force:true` で中断してから再起動してください'
  );
}
