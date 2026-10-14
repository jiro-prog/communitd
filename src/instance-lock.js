// ブリッジの二重起動の検出 (data/.lock)。
//
// `npm start` を 2 回打つと、同じ bot が 2 回ログインし、data/ の台帳を 2 つのプロセスが
// 互いを知らずに書き合う。起動時に lock を排他作成 (flag: 'wx') し、取れなければ
// 中身の持ち主が生きているかを src/procstate.js で確かめる。
//
// - 取れた → そのまま起動。終了時は**中身が自分の pid のときだけ**消す
// - 持ち主が alive・unknown・中身が読めない → 断る (**unknown は gone ではない** — procstate と同じ側へ倒す)
// - 持ち主が gone (居ない・pid の再利用) → 警告して奪う
//
// 再起動 (終了コード 42) は阻まれない: 終了時に同期で消し、scripts/run.mjs は子の close を
// 待ってから spawn し直す。fs と inspect は注入で受ける (テストは一時ディレクトリで回す)。

import * as nodeFs from 'node:fs';
import { resolve } from 'node:path';
import { inspectProcess, judgeLiveness } from './procstate.js';

export const INSTANCE_LOCK_FILE = '.lock';

// 取り直しの上限。素直に取れれば 1 回目、残骸を奪う経路でも 2 回目で決まる。
// 同時に起動した 2 つが奪い合って回り続けないための歯止め
const MAX_ATTEMPTS = 3;

/**
 * lock を取る。
 *
 * @param {object} p
 * @param {string} p.dataDir lock を置くディレクトリ (無ければ作る)
 * @param {number} [p.pid]
 * @param {number} [p.startedAt] このプロセスの起動時刻 (ms)。**書く時点の Date.now() にしない** —
 *        OS の起動時刻より遅い側へずれると、生きている持ち主を pid の再利用 (gone) と取り違えて奪う
 * @param {object} [p.fs] node:fs の同期 API (mkdirSync / writeFileSync / readFileSync / unlinkSync)
 * @param {(pid: number) => Promise<object>} [p.inspect] src/procstate.js の inspectProcess と同じ形
 * @returns {Promise<
 *   {ok: true, path: string, stolen: {pid: number, at: string}|null}
 *   | {ok: false, path: string, reason: 'alive'|'unknown'|'unreadable'|'error'|'contended',
 *      holder: {pid: number, at: string}|null, detail: string|null}
 * >}
 */
export async function acquireInstanceLock({
  dataDir,
  pid = process.pid,
  startedAt = performance.timeOrigin,
  fs = nodeFs,
  inspect = inspectProcess,
}) {
  const path = resolve(dataDir, INSTANCE_LOCK_FILE);
  const refuse = (reason, holder, detail) => ({ ok: false, path, reason, holder, detail });
  const content = `${JSON.stringify({ pid, at: new Date(startedAt).toISOString() })}\n`;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    return refuse('error', null, `${dataDir} を作れません: ${err?.message ?? err}`);
  }

  let stolen = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.writeFileSync(path, content, { flag: 'wx' });
      return { ok: true, path, stolen };
    } catch (err) {
      if (err?.code !== 'EEXIST') return refuse('error', null, `lock を作れません: ${err?.message ?? err}`);
    }

    const seen = readLock(fs, path);
    if (seen.missing) continue; // 持ち主がちょうど手放した — 取り直す
    if (seen.error) return refuse('unreadable', null, seen.error);
    const { holder, problem } = parseHolder(seen.raw);
    if (!holder) return refuse('unreadable', null, problem);

    // 生きているプロセスの pid は重ならない。自分の pid が書いてあるなら書いた側はもう居ない
    if (holder.pid !== pid) {
      const inspected = await inspectSafely(inspect, holder.pid);
      const verdict = judgeLiveness({ pid: holder.pid, at: holder.at }, inspected);
      if (verdict === 'alive') return refuse('alive', holder, null);
      if (verdict !== 'gone') return refuse('unknown', holder, unknownReason(inspected));
    }

    // 確かめている間に持ち主が入れ替わっていたら、新しい持ち主の lock を消さない
    const again = readLock(fs, path);
    if (again.raw !== seen.raw) continue;
    try {
      fs.unlinkSync(path);
    } catch (err) {
      if (err?.code !== 'ENOENT') return refuse('error', holder, `残っていた lock を消せません: ${err?.message ?? err}`);
    }
    stolen = holder;
  }
  return refuse('contended', null, `${MAX_ATTEMPTS} 回取り直しても取れません (別のブリッジが同時に起動しています)`);
}

/** inspect が投げても unknown 側へ倒す (聞けなかった = 居ないではない) */
async function inspectSafely(inspect, pid) {
  try {
    return await inspect(pid);
  } catch (err) {
    return { alive: false, createdAt: null, name: null, command: null, error: String(err?.message ?? err) };
  }
}

/** judgeLiveness は unknown の理由を返さないので、人に見せる理由だけここで拾う */
function unknownReason(inspected) {
  if (inspected?.error) return `聞けません: ${inspected.error}`;
  if (inspected?.alive && inspected.createdAt === null) return 'その pid の起動時刻を読めません';
  return null;
}

/**
 * 終了時の後始末。**中身が自分の pid のときだけ**同期で消す。
 * process の 'exit' から呼ぶので同期で、投げない。奪われた後・手で消された後・
 * 中身が壊れているときは触らない
 * @returns {boolean} 消したか
 */
export function releaseInstanceLock({ path, pid = process.pid, fs = nodeFs }) {
  try {
    const { holder } = parseHolder(fs.readFileSync(path, 'utf8'));
    if (!holder || holder.pid !== pid) return false;
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 断ったときに出す行 (lock の在処・持ち主の pid・消してよいかの確かめ方)。
 * @param {{reason: string, path: string, holder: {pid: number, at: string}|null, detail: string|null}} result
 * @returns {string[]}
 */
export function formatLockRefusal({ reason, path, holder, detail }) {
  const who = holder ? `pid ${holder.pid} (${holder.at} 起動)` : null;
  const why = detail ? ` (${detail})` : '';
  const head = {
    alive: `別のブリッジが動いています — ${who}。二重ログインと data/ の台帳の書き合いを避けるため起動しません`,
    unknown: `lock の持ち主 ${who} が居るか確かめられません${why} — 動いているものとして起動しません`,
    unreadable: `lock の中身を読めません${why} — 持ち主を確かめられないので起動しません`,
  }[reason] ?? `lock を取れません${why} — 起動しません`;
  const lines = [head, `lock: ${path}`];
  if (reason === 'error') return lines;
  const check = holder
    ? ` (Windows は \`Get-Process -Id ${holder.pid}\`、それ以外は \`ps -p ${holder.pid}\` で見る)`
    : '';
  lines.push(`別のブリッジが居ないと確かめてから${check}、このファイルを消して起動し直してください`);
  return lines;
}

/** @returns {{raw: string} | {missing: true} | {error: string}} */
function readLock(fs, path) {
  try {
    return { raw: fs.readFileSync(path, 'utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return { error: `読めません: ${err?.message ?? err}` };
  }
}

/** lock の中身 → 持ち主。pid と起動時刻が揃っていなければ読めない扱い */
function parseHolder(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { holder: null, problem: raw.trim() === '' ? '空です' : 'JSON ではありません' };
  }
  const pid = parsed?.pid;
  const at = parsed?.at;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { holder: null, problem: 'pid がありません' };
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    return { holder: null, problem: '起動時刻がありません' };
  }
  return { holder: { pid, at }, problem: null };
}
