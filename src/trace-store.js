// job ごとのツール軌跡の置き場 (`data/traces/<job id>.jsonl`)。
//
// 軌跡は job の一時ディレクトリにあり、job の終わりに消える (src/bridge/job.js)。差し戻しはその後の
// レビューで決まるので、ハーネスの改訂の提案役が「どの段で外れたか」を読む (帰属) には残しておく
// 必要がある — arXiv 2610.02616 (VERSE) で抜いたときにいちばん効きが落ちたのが帰属だった
// (docs/notes/2026-10-13-verse.md)。中身は hook が書いた要約 (ツール名・引数の頭・失敗・時刻) のまま。
//
// 寿命は実行記録と同じ: 実行記録から消えた job の軌跡は起動時に消す (src/bridge/recorder.js)。

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTraceEntries } from './trace.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUFFIX = '.jsonl';

/** job id → 軌跡のパス。id がファイル名にできない形なら null */
export function runTracePath(dir, runId) {
  if (!dir || !RUN_ID.test(String(runId ?? ''))) return null;
  return join(dir, `${runId}${SUFFIX}`);
}

/**
 * 1 job の軌跡を書く。0 件・id が使えないなら書かない (false)。**書けなければ throw** —
 * 握るのは呼び出し側 (軌跡は補助情報なので job の結果は変えない)。
 */
export function saveRunTrace(dir, runId, entries) {
  const path = runTracePath(dir, runId);
  const list = Array.isArray(entries) ? entries : [];
  if (!path || list.length === 0) return false;
  mkdirSync(dir, { recursive: true });
  const lines = list.map((e) => JSON.stringify({
    tool: e.tool,
    ...(typeof e.arg === 'string' && e.arg !== '' ? { arg: e.arg } : {}),
    ...(e.failed === true ? { failed: true } : {}),
    ...(Number.isSafeInteger(e.at) ? { at: e.at } : {}),
  }));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

/** 1 job の軌跡を読む。無い・読めないは空配列 */
export function readRunTrace(dir, runId) {
  const path = runTracePath(dir, runId);
  return path ? readTraceEntries(path) : [];
}

/**
 * `keepIds` に無い job の軌跡を消す。置き場が無ければ 0。
 * **実行記録が読めないときに呼ばないこと** — 空の id の集合で全部消える。
 * @returns {number} 消した件数
 */
export function pruneRunTraces(dir, keepIds) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds ?? []);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue;
    if (keep.has(name.slice(0, -SUFFIX.length))) continue;
    rmSync(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}
