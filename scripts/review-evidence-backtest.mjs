// 過去の提出へ遡ってレビューの証拠を測る CLI (src/review-evidence-backtest.js、docs/themes.md の review-evidence)。
//
//   node scripts/review-evidence-backtest.mjs --channel my-project                    # merge 済みの全タスクの提出
//   node scripts/review-evidence-backtest.mjs --channel my-project --ids 108,148      # 選んだタスクだけ
//   node scripts/review-evidence-backtest.mjs --channel my-project --tasks <tasks.json> --json
//
// ボード (既定は data/tasks.json。隣の archive/ に移したタスクも読む) の merge 済みタスクの review 遷移を 1 回ずつ「提出」として並べ、提出した時点の
// commit で scripts/review-evidence.mjs と同じ測定を走らせる。提出ごとに 1 行 (#id 提出 k/n・差し戻し/通過・
// 短い sha・証拠の 1 行目・測った秒数) を出しながら進み、最後に証拠の種類 × 差し戻し / 通過の集計を出す。
// 測るのは os.tmpdir() に作る worktree 1 つで、終わったら (失敗・停止でも) 消す。**ボードには書かない。**
// git を打つのはこのスクリプトのあるリポジトリ — merge commit がそこに無いチャンネルは測れない。
//
// 測れたら exit 0 (飛ばした・測れなかった提出があっても 0 — 証拠であって判定ではない)。停止したとき・
// worktree が消えずに残ったときは exit 1。
//
// Ctrl-C (SIGINT / SIGTERM) の 1 回目は走っているテスト (か npm ci) を撃ち、測っている提出の src と test/ を
// 戻して worktree を消してから、そこまでの行と集計を出して exit 1。2 回目は消すのを待たずに抜ける
// (stderr に「worktree を消さずに終了」と出るので git worktree list で確かめる)。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backtestReviewEvidence, formatBacktestRow, formatBacktestSummary, listSubmissions, summarizeBacktest,
} from '../src/review-evidence-backtest.js';
import { readBoard } from './kt-metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_OPTIONS = ['--channel', '--ids', '--tasks'];
const FLAG_OPTIONS = ['--json'];
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

/**
 * **知らないオプションは断る** — 測ったつもりの相手を取り違えないように。`--channel` は必須
 * (既定のチャンネル名は配備ごとに違う)。`--ids` はカンマ区切りの正の整数 (`#` は付けても付けなくてもよい)
 */
export function parseArgs(argv, { root = ROOT } = {}) {
  const out = { channel: null, ids: null, tasks: resolve(root, 'data', 'tasks.json'), json: false };
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
    if (arg === '--channel') out.channel = value;
    else if (arg === '--tasks') out.tasks = resolve(value);
    else out.ids = parseIds(value);
    i += 1;
  }
  if (!out.channel) throw new Error('--channel (測るタスクのチャンネル) は必須です');
  return out;
}

function parseIds(value) {
  const ids = value.split(',').map((item) => item.trim().replace(/^#/, ''));
  const bad = ids.filter((item) => !/^[1-9]\d*$/.test(item));
  if (bad.length > 0) throw new Error(`--ids は正の整数をカンマ区切りで渡してください (読めない値: ${bad.join(', ') || '(空)'})`);
  return [...new Set(ids.map(Number))];
}

/**
 * 停止の配線 (scripts/review-evidence.mjs と同じ型)。1 回目の SIGINT / SIGTERM は `handle.abort()` だけ —
 * 測定が撃って戻し、worktree を消してから `stopped` で返る。2 回目 (種類は問わない) は消すのを待たずに exit 1
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
    proc.stderr.write('worktree を消さずに終了 — git worktree list で確かめる\n', () => proc.exit(1));
  };
  for (const signal of STOP_SIGNALS) proc.on(signal, onSignal);
  return () => {
    for (const signal of STOP_SIGNALS) proc.off(signal, onSignal);
  };
}

export async function main(argv, {
  backtest = backtestReviewEvidence,
  readTasks = readBoard,
  root = ROOT,
  proc = process,
  print = console.log,
} = {}) {
  const opts = parseArgs(argv, { root });
  const { tasks, submissions } = listSubmissions(readTasks(opts.tasks), { channel: opts.channel, ids: opts.ids });
  // 既定の abort も要る — テストや npm ci の子が走っていない間 (git の段) に来た停止は、これが立てる印を見て止まる
  const handle = { stopRequested: false };
  handle.abort = () => {
    handle.stopRequested = true;
  };
  const uninstall = installStopHandlers({ handle, proc });
  try {
    const result = await backtest({
      root,
      submissions,
      handle,
      ...(opts.json ? {} : { onRow: (row) => print(formatBacktestRow(row)) }),
    });
    print(opts.json
      ? JSON.stringify({ channel: opts.channel, tasks, ...result, summary: summarizeBacktest(result.rows) }, null, 2)
      : formatBacktestSummary({ ...result, tasks }));
    return result.stopped || result.leftover ? 1 : 0;
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
