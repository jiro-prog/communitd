// task が変えた src の行に決まった変異を入れ、変更したテストが殺すかを数える CLI
// (src/review-evidence-mutation.js、docs/themes.md の review-evidence)。
//
//   node scripts/review-evidence-mutation.mjs --base main                          # いまの作業ツリーで
//   node scripts/review-evidence-mutation.mjs --base main --cwd .worktrees/task-12 # task の作業ツリーを指して
//   node scripts/review-evidence-mutation.mjs --base main --max 40 --json          # 上限を変えて、結果を JSON で
//
// 基点は `git merge-base <--base> HEAD`。変えた行の比較・論理演算子・真偽値を 1 箇所ずつ入れ替え (既定は合計 20 通り、
// 超えたら等間隔に間引く)、変更したテストを 1 ファイルずつ走らせて「生き残り / 殺された / 時間切れ」を数え、
// 生き残りを `src/x.js:120 === → !==` の形で出す。1 通りごとに変更したテストを全部走らせうるので、テストの重さ × 変異の
// 数だけかかる (変異が無限ループを作ると、そのファイルの時間切れ 10 分を待つ)。終わったら src を HEAD へ戻し、
// src/ と test/ が clean に戻らなければ exit 1。**ブリッジへは配線していない** (手で回す道具)。
//
// **本体の作業ツリーと、src/ か test/ が dirty な作業ツリーでは何も触らずに断る** (exit 1)。
// 測れたら exit 0 — 生き残りがあっても 0 (証拠であって判定ではない)。
//
// Ctrl-C (SIGINT / SIGTERM) の 1 回目は走っているテストを撃ち、src を HEAD へ戻してから停止の 1 行を出して exit 1。
// 2 回目は戻すのを待たずに抜ける (戻っていないかもしれないので stderr にそう出す)。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MAX_MUTANTS, formatMutationEvidence, measureMutations } from '../src/review-evidence-mutation.js';
import { installStopHandlers } from './review-evidence.mjs';

const VALUE_OPTIONS = ['--base', '--cwd', '--max'];
const FLAG_OPTIONS = ['--json'];

/** **知らないオプションは断る** — 測ったつもりの相手を取り違えないように。`--max` は正の整数 */
export function parseArgs(argv) {
  const out = { base: null, cwd: process.cwd(), max: DEFAULT_MAX_MUTANTS, json: false };
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
    else if (arg === '--cwd') out.cwd = resolve(value);
    else if (/^[1-9]\d*$/.test(value)) out.max = Number(value);
    else throw new Error(`--max は正の整数で渡してください (読めない値: ${value})`);
    i += 1;
  }
  if (!out.base) throw new Error('--base (比べる相手のブランチ) は必須です');
  return out;
}

export async function main(argv, { measure = measureMutations, proc = process, print = console.log } = {}) {
  const opts = parseArgs(argv);
  // 既定の abort も要る — テストの子が走る前 (git の段) に来た停止は、これが立てる印を測定が次の段の前に見る
  const handle = { stopRequested: false };
  handle.abort = () => {
    handle.stopRequested = true;
  };
  const uninstall = installStopHandlers({ handle, proc });
  try {
    const result = await measure({ cwd: opts.cwd, base: opts.base, max: opts.max, handle });
    print(opts.json ? JSON.stringify(result, null, 2) : formatMutationEvidence(result));
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
