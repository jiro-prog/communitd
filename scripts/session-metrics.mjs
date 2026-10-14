// bot のセッションの大きさと、「文脈がしきい値を超えたら切る」の効き方を実データで測る読み取り専用 CLI
// (セッションの切り替え — src/session-cut.js、docs/notes/2026-09-18-t2-session-cut.md)。
//
//   node scripts/session-metrics.mjs                          # data/sessions.json の bot セッション全部
//   node scripts/session-metrics.mjs --since 2026-09-06       # この日以降のリクエストだけ
//   node scripts/session-metrics.mjs --rebuilt 60000          # 切った直後の大きさの仮定 (既定 75000)
//
// 読むのは Claude Code のセッション記録 (`<CLAUDE_CONFIG_DIR か ~/.claude>/projects/<cwd>/<id>.jsonl`)。
// 形式は公開の約束ではないので、変わったら数字が出なくなるだけで何も書き換えない。
//
// **しきい値 (limits.session.maxContextTokens) を決め直すための道具。** セッションごとに job を順に
// 再生し、「job の終わりに文脈 > T なら切る → 次の job は R から始まり、job 内の伸びは実データのまま」
// を連鎖で再現する。切らない行が実測の合計と一致すること (= 再生が正しいこと) を先に確かめてから読む。
// 費用は Sonnet 5.5 の API 単価 (2026-10) で重み付けした簡易モデル (キャッシュは常に効いていると置く)。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 100 万トークンあたりの単価 (Sonnet 5.5、2026-10)。cache write は 5 分キャッシュの 1.25 倍 */
export const PRICE = Object.freeze({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 });
/** 切った直後に下回らない土台 (新規セッションの最初の文脈の中央値、2026-10-09 実測) */
export const BASE_CONTEXT = 44000;
/** 切るたびに書かせる引き継ぎメモの出力 */
const MEMO_OUTPUT = 1500;

/**
 * 1 セッションの記録 → job ごとの各リクエストの文脈と出力 (純粋)。
 * job の区切りは「ツール結果でも合成でもない、本体の user 発言」。合成メッセージ (`<synthetic>`)・
 * subagent の行・同じ message id の重複行は数えない。
 * @param {string[]} lines
 * @param {{since?: string|null}} [opts] ISO 日付の文字列。これより前のリクエストは捨てる
 * @returns {Array<{ctx: number[], out: number}>}
 */
export function collectJobs(lines, { since = null } = {}) {
  const jobs = [];
  const seen = new Set();
  let cur = null;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (since && String(e?.timestamp ?? '') < since) continue;
    if (e?.type === 'user' && !e.isMeta && !e.toolUseResult && !e.isSidechain) {
      const c = e.message?.content;
      const isPrompt = typeof c === 'string'
        || (Array.isArray(c) && c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result'));
      if (isPrompt) {
        cur = { ctx: [], out: 0 };
        jobs.push(cur);
      }
    }
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    const u = e.message?.usage;
    if (!u || e.message.model === '<synthetic>') continue;
    const id = e.message.id ?? e.requestId ?? null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (!cur) continue;
    cur.ctx.push((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    cur.out += u.output_tokens ?? 0;
  }
  return jobs.filter((j) => j.ctx.length > 0);
}

/**
 * セッションの連鎖を再生して、しきい値ごとの入力量・費用・切った回数を出す (純粋)。
 *
 * 切らない側 (`threshold: Infinity`) は実データそのものになる: 次の job の頭 = 前の job の終わり +
 * (間に足された分)。差が負なのは CLI 自身の compaction で縮んだ分で、そのまま当てる。
 * 切った次の job は `rebuilt` から始まり、job 内の伸びは実データのまま。
 * @param {Array<Array<{ctx: number[], out: number}>>} chains セッションごとの job 列
 * @param {{threshold: number, rebuilt: number}} p
 * @returns {{input: number, cost: number, cuts: number}}
 */
export function simulateCuts(chains, { threshold, rebuilt }) {
  let input = 0;
  let cost = 0;
  let cuts = 0;
  const usd = (tokens, perMillion) => (tokens * perMillion) / 1e6;
  for (const jobs of chains) {
    let prevEndActual = null;
    let simEnd = null;
    let cutNext = false;
    for (const job of jobs) {
      const first = job.ctx[0];
      const start = prevEndActual === null
        ? first
        : cutNext ? rebuilt : Math.max(BASE_CONTEXT, simEnd + (first - prevEndActual));
      // 前のリクエストまでを cache read、増分を cache write と置く (切った直後の最初は全部 write)
      let prev = prevEndActual === null || cutNext ? 0 : simEnd;
      for (const c0 of job.ctx) {
        const c = start + (c0 - first);
        input += c;
        cost += usd(Math.min(prev, c), PRICE.cacheRead) + usd(Math.max(0, c - prev), PRICE.cacheWrite);
        prev = c;
      }
      cost += usd(job.out, PRICE.output);
      simEnd = prev;
      prevEndActual = job.ctx[job.ctx.length - 1];
      cutNext = simEnd > threshold;
      if (cutNext) {
        cuts += 1;
        cost += usd(simEnd, PRICE.cacheRead) + usd(MEMO_OUTPUT, PRICE.output);
      }
    }
  }
  return { input, cost, cuts };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
}

function parseArgs(argv) {
  const out = { since: null, rebuilt: 75000, sessions: resolve(ROOT, 'data', 'sessions.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--since') { out.since = value; i += 1; }
    else if (key === '--rebuilt') { out.rebuilt = Number(value); i += 1; }
    else if (key === '--sessions') { out.sessions = resolve(value); i += 1; }
    else throw new Error(`知らない引数: ${key}`);
  }
  if (!Number.isSafeInteger(out.rebuilt) || out.rebuilt <= 0) throw new Error('--rebuilt は正の整数で書く');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.sessions)) throw new Error(`${args.sessions} がありません`);
  const want = new Set(Object.values(JSON.parse(readFileSync(args.sessions, 'utf8'))).map((v) => v.sessionId));
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const chains = [];
  for (const dir of readdirSync(projects)) {
    let files;
    try { files = readdirSync(join(projects, dir)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || !want.has(f.slice(0, -6))) continue;
      const jobs = collectJobs(readFileSync(join(projects, dir, f), 'utf8').split('\n'), { since: args.since });
      if (jobs.length > 0) chains.push(jobs);
    }
  }
  const jobs = chains.flat();
  const k = (n) => `${Math.round(n / 1000)}k`;
  console.log(`セッション ${chains.length} 本 / job ${jobs.length} 本${args.since ? ` (${args.since} 以降)` : ''}`);
  console.log(`job の最初の文脈 (中央値): 新規 ${k(median(chains.map((c) => c[0].ctx[0])) ?? 0)}`
    + ` / resume ${k(median(chains.flatMap((c) => c.slice(1).map((j) => j.ctx[0]))) ?? 0)}`);
  const base = simulateCuts(chains, { threshold: Infinity, rebuilt: args.rebuilt });
  console.log(`\n切った直後の大きさ R = ${k(args.rebuilt)} (Sonnet 5.5 単価換算の簡易モデル)`);
  console.log('しきい値      入力              費用            切った回数');
  for (const threshold of [Infinity, 400000, 300000, 200000, 150000, 120000, 100000]) {
    const r = simulateCuts(chains, { threshold, rebuilt: args.rebuilt });
    const pct = (a, b) => `${Math.round((100 * a) / b)}%`;
    console.log([
      (threshold === Infinity ? '切らない' : k(threshold)).padEnd(10),
      `${Math.round(r.input / 1e6)}M (${pct(r.input, base.input)})`.padEnd(16),
      `$${Math.round(r.cost)} (${pct(r.cost, base.cost)})`.padEnd(14),
      String(r.cuts),
    ].join('  '));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
