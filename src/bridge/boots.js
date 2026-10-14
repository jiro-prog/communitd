// 起動の記録 (data/boots.json)。ブリッジが起動するたびに、起動時刻と**その時点の git HEAD** を
// 古い順に 1 件ずつ足す。稼働中の版はどの台帳にも残っていない — data/.lock は pid と時刻だけで
// 終了時に消え、作業ツリーの HEAD は merge で進むので「今の HEAD」は稼働中の版ではない。
// 形: { "boots": [ { "at": ISO UTC, "head": 40 桁 hex | null, "branch": 名前 | null, "pid": 整数 } ] }
// **記録は起動を止めない** — git が読めなければ null で残し、台帳が読めなければ書かずにログだけ。
import { basename } from 'node:path';
import { JsonStore } from '../store.js';

/** 残す件数 (新しい方から)。1 日に数回の再起動で数か月分 */
export const BOOTS_KEEP = 200;

const HEAD_PATTERN = /^[0-9a-f]{40}$/;

/** git の出力 1 行。失敗・空は null */
function gitLine(git, args, root) {
  try {
    const out = String(git(args, root) ?? '').trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** ログに出す版の表記 (HEAD の 7 桁と branch) */
function describe(entry) {
  return `HEAD ${entry.head ? entry.head.slice(0, 7) : '不明'} (${entry.branch ?? 'branch なし'})`;
}

/**
 * 起動を 1 件記録する。**throw しない** (書けなかったときも recorded: false で返す)。
 *
 * @param {object} p
 * @param {string} p.file 台帳のパス (data/boots.json)
 * @param {string} p.root git を走らせる場所 (ブリッジのルート)
 * @param {string} p.at 起動時刻 (ISO UTC)
 * @param {number} p.pid
 * @param {(args: string[], cwd: string) => string} p.git git を 1 回走らせて stdout を返す (失敗は throw)
 * @param {{log: Function, error: Function}} [p.log]
 * @returns {{recorded: boolean, entry: {at: string, head: string|null, branch: string|null, pid: number}, reason: string|null}}
 */
export function recordBoot({ file, root, at, pid, git, log = console }) {
  const rawHead = gitLine(git, ['rev-parse', 'HEAD'], root);
  // detached のとき --abbrev-ref は文字列の HEAD を返す
  const rawBranch = gitLine(git, ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const entry = {
    at,
    head: rawHead !== null && HEAD_PATTERN.test(rawHead) ? rawHead : null,
    branch: rawBranch === 'HEAD' ? null : rawBranch,
    pid,
  };
  const name = basename(file);
  const skip = (reason) => {
    log.error(`[boots] ${name} に起動を記録しません (${reason}) — ${describe(entry)}`);
    return { recorded: false, entry, reason };
  };

  const store = new JsonStore(file);
  if (store.broken) return skip(`${store.broken.reason} — 台帳を直すか手で退避してください`);
  // キーが無い (初回の {} を含む) なら空から始める。**あって配列でない**ものは形の違う台帳なので上書きで潰さない
  const prev = Object.hasOwn(store.data, 'boots') ? store.data.boots : [];
  if (!Array.isArray(prev)) return skip('boots が配列ではありません — 台帳を直すか手で退避してください');

  const boots = [...prev, entry].slice(-BOOTS_KEEP);
  try {
    store.commit({ ...store.data, boots });
  } catch (err) {
    return skip(`書けません: ${err.message}`);
  }
  log.log(`[boots] 起動を記録: ${describe(entry)} / pid ${pid}`);
  return { recorded: true, entry, reason: null };
}
