// Discord からの再起動 (/restart) とラッパー (scripts/run.mjs) まわりの純粋関数
// (副作用なし — ラッパーとテストの両方から import する)。

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

// ---- 再起動の依頼 (data/restart-request.json) ----
// Discord の /restart を人が打つ代わりに、別プロセス (npm run new-project など) が
// 「設定を書き換えたので読み直してほしい」と置いていく依頼。ブリッジは job が
// 1 件も無いときにだけ拾って /restart と同じ手順で落ちる (force はしない)。

/** 依頼の置き場 (ブリッジのルートからの相対) */
export const RESTART_REQUEST_FILE = 'data/restart-request.json';

/** 依頼を見に行く間隔。読むのは小さなファイル 1 つで、無ければ何もしない */
export const RESTART_REQUEST_POLL_MS = 30 * 1000;

/**
 * 依頼の中身を組み立てる (書く側と読む側で形を揃えるため、ここに置く)。
 * @param {{reason: string, by: string, now?: number, notice?: {channelId: string, botKey: string}|null}} p
 *        notice があれば、再起動後に「✅ 再起動完了」をそのチャンネルへ出す
 */
export function buildRestartRequest({ reason, by, now = Date.now(), notice = null }) {
  const request = { requestedAt: now, by: String(by ?? ''), reason: String(reason ?? '') };
  if (notice?.channelId && notice?.botKey) {
    request.notice = { channelId: String(notice.channelId), botKey: String(notice.botKey) };
  }
  return request;
}

/**
 * 依頼をどう扱うか (純粋関数)。
 *
 * - `none`    依頼が無い / 停止処理中 (何もしない)
 * - `discard` 読めない依頼・この起動より前の依頼 (消すだけ)。起動時に読んだ設定に
 *             もう入っているので、再起動しても何も変わらない。**読めない依頼も消す** —
 *             残すと毎回同じ判定を繰り返し、直すまで誰にも気づかれない
 * - `wait`    job か受付中の処理がある (次の確認で拾い直す。中断はしない)
 * - `restart` 今落ちてよい
 *
 * @param {object} p
 * @param {object|null|undefined} p.request 読んだ依頼 (無ければ null、読めなければ { invalid: true })
 * @param {number} p.startedAt このプロセスの起動時刻 (ms)
 * @param {boolean} [p.accepting]  受付中か (false = 停止・再起動の処理が始まっている)
 * @param {number} [p.activeCount]
 * @param {number} [p.waitingCount]
 * @param {number} [p.pendingAdmissions] 受付の途中 (キューに載る前) の数
 * @returns {{action: 'none'|'discard'|'wait'|'restart', reason: string}}
 */
export function planRestartRequest({
  request, startedAt, accepting = true, activeCount = 0, waitingCount = 0, pendingAdmissions = 0,
}) {
  if (request === null || request === undefined) return { action: 'none', reason: '依頼なし' };
  if (!accepting) return { action: 'none', reason: '停止処理中' };
  const at = request?.requestedAt;
  if (request?.invalid || typeof at !== 'number' || !Number.isFinite(at)) {
    return { action: 'discard', reason: '依頼を読めません (requestedAt が無い)' };
  }
  if (at <= startedAt) {
    return { action: 'discard', reason: 'この起動より前の依頼 (設定は起動時に読み込み済み)' };
  }
  if (activeCount > 0 || waitingCount > 0 || pendingAdmissions > 0) {
    return {
      action: 'wait',
      reason: `実行中 ${activeCount} 件・待機 ${waitingCount} 件・受付中 ${pendingAdmissions} 件が終わるのを待ちます`,
    };
  }
  return { action: 'restart', reason: String(request.reason ?? '').trim() || '再起動の依頼' };
}

/** 拒否時に Discord へ返す文面 */
export function restartRejectionMessage({ activeCount = 0, waitingCount = 0 } = {}) {
  return (
    `⚠️ 実行中 ${activeCount} 件・待機 ${waitingCount} 件の job があるため再起動しません。` +
    '終わるのを待つか、`/restart force:true` で中断してから再起動してください'
  );
}

/**
 * ラッパーの引数解釈。受け付けるのは `--log <path>` (= `--log=<path>`) だけ。
 * **解釈できない引数は黙って無視せずエラーにする** — 綴り違いで控えが取られないまま
 * 起動してしまうと、後から「残っていない」ことにしか気づけないため。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{logPath: string|null, error: string|null}} logPath は未指定なら null
 */
export function parseRunArgs(argv = []) {
  const fail = (error) => ({ logPath: null, error });
  let logPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = arg.startsWith('--log=');
    if (arg !== '--log' && !inline) return fail(`解釈できない引数です: ${arg} (使えるのは --log <path> だけ)`);
    if (logPath !== null) return fail('--log は 1 つだけ渡してください');
    const value = inline ? arg.slice('--log='.length) : argv[++i];
    if (!value || value.startsWith('-')) {
      return fail('--log には控えの書き出し先が要ります (例: --log logs/bridge.log)');
    }
    logPath = value;
  }
  return { logPath, error: null };
}

/** 控えの 1 行。画面には付けず、ファイル側にだけ ISO 8601 (UTC) の時刻を前置する */
export function formatLogLine(line, now = new Date()) {
  return `${now.toISOString()} ${line}\n`;
}

/**
 * 子プロセスから届いた chunk を控え用の行に整える。
 * **chunk は行の途中で切れる**ので、改行で終わらなかった末尾は pending として持ち越し、
 * 次の chunk の頭と連結する (そうしないと 1 行が時刻付きで分断される)。
 * @param {string} pending 前回の持ち越し
 * @param {string} chunk 届いた文字列
 * @returns {{text: string, pending: string}} text は書き出す分 (0 行のこともある)
 */
export function formatLogChunk(pending, chunk, now = new Date()) {
  const buf = `${pending ?? ''}${chunk ?? ''}`;
  const cut = buf.lastIndexOf('\n');
  if (cut < 0) return { text: '', pending: buf };
  const text = buf
    .slice(0, cut)
    .split('\n')
    .map((line) => formatLogLine(line, now))
    .join('');
  return { text, pending: buf.slice(cut + 1) };
}
