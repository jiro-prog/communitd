// task ブランチが変更したテストが、変更前の src で落ちるかを数える CLI (src/review-evidence.js、
// docs/themes.md の review-evidence)。
//
//   node scripts/review-evidence.mjs --base main                          # いまの作業ツリーで
//   node scripts/review-evidence.mjs --base main --cwd .worktrees/task-12 # task の作業ツリーを指して
//   node scripts/review-evidence.mjs --base main --json                   # 結果をそのまま JSON で
//
// 基点は `git merge-base <--base> HEAD`。src を基点の版へ一時的に戻して、変更したテストを 1 ファイルずつ
// HEAD と基点の両方で走らせ、「落ちる / 落ちない / HEAD でも落ちる」の本数と落ちないファイル名を出す。
// 続けて、変更したテストだけが覆った src の行の前後 (前 = src と test/ を基点の版に戻した回) を出す。
// 終わったら src と test/ を HEAD へ戻し、src/ と test/ が clean に戻らなければ exit 1。
//
// **本体の作業ツリーと、src/ か test/ が dirty な作業ツリーでは何も触らずに断る** (exit 1)。
// 測れたら exit 0 — 落ちないテストがあっても 0 (証拠であって判定ではない)。
//
// Ctrl-C (SIGINT / SIGTERM) の 1 回目は走っているテストを撃ち、src と test/ を HEAD へ戻してから停止の 1 行を
// 出して exit 1。2 回目は戻すのを待たずに抜ける (戻っていないかもしれないので stderr にそう出す)。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatReviewEvidence, measureReviewEvidence } from '../src/review-evidence.js';

const VALUE_OPTIONS = ['--base', '--cwd'];
const FLAG_OPTIONS = ['--json'];
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

/** **知らないオプションは断る** — 測ったつもりの相手を取り違えないように */
export function parseArgs(argv) {
  const out = { base: null, cwd: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAG_OPTIONS.includes(arg)) {
      out.json = true;
      continue;
    }
    if (!VALUE_OPTIONS.includes(arg)) {
      throw new Error(`知らないオプション: ${arg} (使えるのは ${[...VALUE_OPTIONS, ...FLAG_OPTIONS].join(' / ')} だけ)`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} に値が渡されていません`);
    if (arg === '--base') out.base = value;
    else out.cwd = resolve(value);
    i += 1;
  }
  if (!out.base) throw new Error('--base (比べる相手のブランチ) は必須です');
  return out;
}

/**
 * 停止の配線。1 回目の SIGINT / SIGTERM は `handle.abort()` だけ — 測定が撃って戻してから `stopped` で返る。
 * 2 回目 (種類は問わない) は戻すのを待たずに exit 1
 *
 * @returns {() => void} 外す関数
 */
export function installStopHandlers({ handle, proc = process }) {
  let count = 0;
  const onSignal = () => {
    count += 1;
    if (count === 1) {
      handle.abort();
      return;
    }
    proc.stderr.write('戻さずに終了 — git status -- src test で確かめる\n', () => proc.exit(1));
  };
  for (const signal of STOP_SIGNALS) proc.on(signal, onSignal);
  return () => {
    for (const signal of STOP_SIGNALS) proc.off(signal, onSignal);
  };
}

export async function main(argv, { measure = measureReviewEvidence, proc = process, print = console.log } = {}) {
  const opts = parseArgs(argv);
  // 既定の abort も要る — テストの子が走る前 (git の段) に来た停止は、これが立てる印を測定が次の段の前に見る
  const handle = { stopRequested: false };
  handle.abort = () => {
    handle.stopRequested = true;
  };
  const uninstall = installStopHandlers({ handle, proc });
  try {
    const result = await measure({ cwd: opts.cwd, base: opts.base, handle });
    print(opts.json ? JSON.stringify(result, null, 2) : formatReviewEvidence(result));
    return result.outcome === 'refused' || result.outcome === 'stopped' ? 1 : 0;
  } finally {
    uninstall();
  }
}

// import しても走らせない (parseArgs / main をテストから直接叩けるように)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`測れません: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
