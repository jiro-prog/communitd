// 回し方の成績を出す読み取り専用 CLI (src/loop-report.js)。
//
//   node scripts/loop-report.mjs --channel my-project                          # 直近 7 日 (JST の暦日、今日を含む)
//   node scripts/loop-report.mjs --channel my-project --since 2026-10-08 --until 2026-10-14
//   node scripts/loop-report.mjs --channel my-project --json                   # 集計をそのまま JSON で
//   node scripts/loop-report.mjs --channel my-project --data <dir> --policy <file>   # 別の台帳・設定を読む
//
// ① 巡回の空回り ② 段の待ち ③ 日次の上限で止まった時間 ④ 配備の遅れと作者待ち を 1 つの定義で出す
// (定義は src/loop-report.js の summarizeLoop)。企画の巡回が手で数え直さずに引用できるように、文は 1900 字以内。
//
// **読むだけ。** 台帳は kt-metrics と同じ読み方で開く (無い・壊れているを 0 件にしない・何も書かない)。
// 例外は data/boots.json — 起動の記録が無いのは配備前の正しい状態なので、落とさずに「④ は読めない」と出す。
// bot・日次上限・基点ブランチは config.policy.json を読むだけ (resolveAutonomy)。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAutonomy } from '../src/config.js';
import { defaultSince, formatLoopReport, loopReportJson, parseBoots, summarizeLoop } from '../src/loop-report.js';
import { parseDateArg, readBoard, readRecords } from './kt-metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_OPTIONS = ['--channel', '--since', '--until', '--data', '--policy'];
const FLAG_OPTIONS = ['--json'];

/** **知らないオプションは断る** — 絞ったつもりの数字を別の数字として読まないように。`--channel` は必須 */
export function parseArgs(argv) {
  const out = {
    channel: null,
    since: null,
    until: null,
    data: resolve(ROOT, 'data'),
    policy: resolve(ROOT, 'config.policy.json'),
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
    if (arg === '--channel') out.channel = value;
    else if (arg === '--since') out.since = parseDateArg(value);
    else if (arg === '--until') out.until = parseDateArg(value, { end: true });
    else if (arg === '--data') out.data = value;
    else out.policy = value;
    i += 1;
  }
  if (out.channel === null) throw new Error('--channel <チャンネル名> を渡してください (回し方はチャンネルごとに違う)');
  if (out.since !== null && out.until !== null && out.since >= out.until) {
    throw new Error('--since は --until より前にしてください');
  }
  return out;
}

/** 設定からチャンネルの作業場所と自律運転の実効値を読む。無いチャンネルは断る (巡回の群が 0 の報告を出さない) */
function readChannel(policyPath, channel) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch (err) {
    throw new Error(`${policyPath} を読めません (${err.message})`, { cause: err });
  }
  const cc = policy?.channels?.[channel];
  if (!cc || typeof cc !== 'object') throw new Error(`${policyPath} の channels に ${channel} がありません`);
  return { cwd: typeof cc.cwd === 'string' ? cc.cwd : null, autonomy: resolveAutonomy(cc) };
}

/** data/boots.json。無い・読めないは throw せず理由を返す (④ だけが読めない) */
function readBoots(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { entries: null, reason: err.code === 'ENOENT' ? 'boots.json が無い' : `boots.json を読めない (${err.message})` };
  }
  return parseBoots(raw);
}

/** git を 1 回走らせて stdout を返す (失敗は throw。stderr は捨てる) */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function main(argv) {
  const opts = parseArgs(argv);
  const { cwd, autonomy } = readChannel(opts.policy, opts.channel);
  const now = Date.now();
  const until = opts.until ?? now;
  const summary = summarizeLoop({
    runs: readRecords(join(opts.data, 'job-runs.json'), '実行記録'),
    tasks: readBoard(join(opts.data, 'tasks.json')),
    recovery: readRecords(join(opts.data, 'recovery.json'), '再開の台帳'),
    inbox: readRecords(join(opts.data, 'inbox.json'), '受信箱'),
    boots: readBoots(join(opts.data, 'boots.json')),
    autonomy,
    channel: opts.channel,
    cwd,
    root: ROOT,
    git,
    since: opts.since ?? defaultSince(until),
    until,
    now,
  });
  console.log(opts.json ? JSON.stringify(loopReportJson(summary), null, 2) : formatLoopReport(summary));
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
