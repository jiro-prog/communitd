// ハーネスの版ごとの成績を出す読み取り専用 CLI (src/harness.js、docs/notes/2026-10-12-harness-learning.md)。
//
//   node scripts/harness-report.mjs                        # 全チャンネル・全 bot
//   node scripts/harness-report.mjs --channel my-project   # 1 チャンネルだけ
//   node scripts/harness-report.mjs --bot <bot キー> --excerpts 20
//   node scripts/harness-report.mjs --min-runs 30          # 判定に要る 1 版あたりの job 数
//   node scripts/harness-report.mjs --json                 # 集計をそのまま JSON で
//   node scripts/harness-report.mjs --trace <job id>       # 1 job の手順を 1 手 1 行で
//
// 役割文 (roles/) や bot の model / effort を変えたとき、その前後で job の問題率が変わったかを
// 実行記録 (data/job-runs.json) とボード (data/tasks.json の差し戻しの履歴) から出す。
// ハーネスの改訂の巡回 (autonomy.harness) が提案役に見せる数字と同じもの。
// 役割文を触った merge 済みのタスク (改訂) ごとに、その merge で始まった版の成績を「改訂の台帳」に並べ、
// 問題の抜粋には、その job の手順の要約 (data/traces/ の軌跡、src/trace-store.js) を添える。
//
// **読むだけ。** 台帳は kt-metrics と同じ読み方で開く (無い・壊れているを 0 件にしない・何も書かない)。
// ボードは隣の archive/ (終わってから 30 日を過ぎて移したタスク) も一緒に読む。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_HARNESS_MIN_RUNS } from '../src/config.js';
import { day, formatHarnessReport, revisionLedger, summarizeHarness } from '../src/harness.js';
import { JST_LABEL } from '../src/time.js';
import { readRunTrace } from '../src/trace-store.js';
import { digestTrace, formatTraceSteps } from '../src/trace.js';
import { readBoard, readRecords } from './kt-metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_OPTIONS = ['--runs', '--tasks', '--traces', '--trace', '--channel', '--bot', '--min-runs', '--excerpts'];
const FLAG_OPTIONS = ['--json'];

/** **知らないオプションは断る** — 絞ったつもりの数字を全体の数字として読まないように */
export function parseArgs(argv) {
  const out = {
    runs: resolve(ROOT, 'data', 'job-runs.json'),
    tasks: resolve(ROOT, 'data', 'tasks.json'),
    traces: resolve(ROOT, 'data', 'traces'),
    trace: null,
    channel: null,
    bot: null,
    minRuns: DEFAULT_HARNESS_MIN_RUNS,
    excerpts: 8,
    json: false,
  };
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
    if (arg === '--runs') out.runs = value;
    else if (arg === '--tasks') out.tasks = value;
    else if (arg === '--traces') out.traces = value;
    else if (arg === '--trace') out.trace = value;
    else if (arg === '--channel') out.channel = value;
    else if (arg === '--bot') out.bot = value;
    else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${arg} は 1 以上の整数で渡してください (受け取った値: ${value})`);
      if (arg === '--min-runs') out.minRuns = n;
      else out.excerpts = n;
    }
    i += 1;
  }
  return out;
}

/** `--trace`: 1 job の手順の全部。軌跡が無ければ理由を添えて断る (0 手と区別する) */
function printTrace(opts) {
  const run = readRecords(opts.runs, '実行記録').find((r) => String(r.id) === opts.trace) ?? null;
  const entries = readRunTrace(opts.traces, opts.trace);
  if (entries.length === 0) {
    throw new Error(`job ${opts.trace} の手順がありません (軌跡を残す前の job・実行記録から消えた job・ツールを使わなかった job)`);
  }
  const failed = entries.filter((e) => e.failed === true).length;
  const where = run
    ? ` — ${run.botKey}${run.taskId ? ` task #${run.taskId}` : ''} ${run.outcome ?? '?'} (${day(run.startedAt)} ${JST_LABEL})`
    : '';
  console.log([`# job ${opts.trace} の手順 (${entries.length} 手${failed > 0 ? `・うち失敗 ${failed}` : ''})${where}`, '', ...formatTraceSteps(entries)].join('\n'));
  return 0;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.trace !== null) return printTrace(opts);
  const runs = readRecords(opts.runs, '実行記録').filter((run) => opts.bot === null || run.botKey === opts.bot);
  const tasks = readBoard(opts.tasks);
  const summary = summarizeHarness(runs, { tasks, minRuns: opts.minRuns, channel: opts.channel });
  for (const item of summary.excerpts) {
    const digest = digestTrace(readRunTrace(opts.traces, item.runId));
    if (digest) item.trace = digest;
  }
  const ledger = revisionLedger(summary, tasks);
  console.log(opts.json
    ? JSON.stringify({ ...summary, ledger }, null, 2)
    : formatHarnessReport(summary, { minRuns: opts.minRuns, maxExcerpts: opts.excerpts, ledger }));
  return 0;
}

// import しても走らせない (parseArgs をテストから直接叩けるように)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`数字を出せません: ${err.message}`);
    process.exitCode = 1;
  }
}
