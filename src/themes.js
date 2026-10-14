// 主題 (企画の巡回、docs/social-engineering.md §3.3c)。
//
// 自律ループが「次に何を伸ばすか」を自分で決めて持つ置き場 = 対象リポジトリの主題ファイル
// (既定 `docs/themes.md`)。企画の巡回 (`plan/…` スレッド) が考え抜いて起票し、承認 → 実装 →
// レビュー → merge で取り込む。スカウトは進行中の主題をタスクに割り、題の頭に `[slug]` を付ける。
//
// **ここは純粋関数だけ** (§3.11「検出は決定論・判断は agentic」)。ファイルを読むのは呼び出し側で、
// ここは本文から見出しを数え、巡回を起こすかとその種類 (足す / 振り返りだけ) を決めるところと、
// 主題のタスクの進み具合・使った重さを数えるところまで。
// 何を主題にするかは企画役が決める。

import { DEFAULT_PLANNER_MAX_THEMES } from './config.js';

/**
 * 見出しに書ける状態。`active` = 進行中、`waiting` = 残りがループの外 (配備・時間の経過) を待つ確認だけ、
 * `done` = 完了、`dropped` = 取り下げ。
 *
 * `waiting` は**進行中の枠に数えず、スカウトも割らない** (2026-10-14 作者裁定)。残りが配備待ちの主題が
 * 枠を塞ぐと、企画の巡回は振り返りしかできず、スカウトには割る手が無い — 配備までループの種が止まる。
 * 確かめられたら企画の巡回が `done` / `dropped` にする
 */
export const THEME_STATES = Object.freeze(['active', 'waiting', 'done', 'dropped']);

/** slug = 英小文字・数字・ハイフン (スカウトがタスクの題の頭に `[slug]` で付ける) */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 主題ファイルの本文 → 見出しの一覧。
 *
 * 見出しの形は `## [active|waiting|done|dropped] slug — 題`。区切りは — / – / - / -- のどれでもよい。
 * HTML コメントとコードフェンスの中は読まない (ファイル冒頭の様式の見本を主題に数えない)。
 * 形の崩れた `## [` 見出しと slug の重複は problems に積む — 数えないまま黙ると、
 * 企画役は主題が減ったと読んで重ねて足してしまう。
 *
 * @param {string|null|undefined} text
 * @returns {{themes: Array<{state: string, slug: string, title: string}>, problems: string[]}}
 */
export function parseThemes(text) {
  const themes = [];
  const problems = [];
  const seen = new Set();
  let inComment = false;
  let inFence = false;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      inComment = false;
      line = line.slice(end + 3);
    }
    // 1 行の中で閉じるコメントは消し、閉じないものはそこから先を読まない
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      inComment = true;
      line = line.slice(0, open);
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 先頭の空白は 3 つまで (Markdown の見出しと同じ)
    const heading = /^ {0,3}##\s+\[([^\]]*)\]\s*(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const state = heading[1].trim();
    const named = /^(\S+)(?:\s+(?:—|–|-{1,2})\s+(.+))?$/.exec(heading[2]);
    if (!THEME_STATES.includes(state) || !named || !SLUG.test(named[1])) {
      problems.push(`読めない見出し: ${line.trim().slice(0, 80)}`);
      continue;
    }
    if (seen.has(named[1])) {
      problems.push(`slug の重複: ${named[1]}`);
      continue;
    }
    seen.add(named[1]);
    themes.push({ state, slug: named[1], title: (named[2] ?? '').trim() });
  }
  return { themes, problems };
}

/**
 * 主題に属するタスク (題の頭が `[slug]`) の進み具合。企画役の振り返りの材料。
 *
 * @param {object[]} tasks ボードのタスク (そのチャンネルの分)
 * @param {string} slug
 * @returns {{merged: number, open: number, dropped: number}}
 */
export function themeProgress(tasks, slug) {
  const counts = { merged: 0, open: 0, dropped: 0 };
  for (const task of themeTasks(tasks, slug)) {
    if (task.state === 'merged') counts.merged += 1;
    else if (task.state === 'dropped') counts.dropped += 1;
    else counts.open += 1;
  }
  return counts;
}

/** 題の頭が `[slug]` のタスク */
function themeTasks(tasks, slug) {
  const mark = `[${slug}]`;
  return (Array.isArray(tasks) ? tasks : []).filter((task) => String(task?.title ?? '').trimStart().startsWith(mark));
}

const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

const msOf = (iso) => {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/** トークンの 4 種 (src/bridge/queue.js の tokensOf と同じ鍵) */
const TOKEN_KINDS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output']);

/**
 * 主題のタスクが使った job の重さの合計 (企画とスカウトの起動文に添えるだけ — 判定・門には使わない)。
 *
 * 題の頭が `[slug]` のタスクの実行記録を、種別 (作業・レビュー・承認) を問わず全部数える。
 * 欄ごとに値のある job だけで足し、n = 足した本数 (jobs より少なければ欠けがある):
 *
 * - toolCalls = evidence.toolCalls の和
 * - minutes = 起動 → 終端の分の和 (src/harness.js の weightOf と同じ規則 — 両方あり、終端 ≥ 起動のときだけ)
 * - verifyMinutes = evidence.verifyMs の和 (分に直す)
 * - tokens = evidence.tokens の 4 種の和。器は 1 種でも取れれば置かれるので、ある種だけを足し、
 *   1 種でもあればその job を n に数える
 *
 * @param {object[]} tasks ボードのタスク (そのチャンネルの分)
 * @param {object[]} runs 実行記録 (src/jobruns.js)
 * @param {string} slug
 * @returns {{jobs: number, toolCalls: {n: number, sum: number}, minutes: {n: number, sum: number},
 *   verifyMinutes: {n: number, sum: number}, tokens: {n: number, sum: number}}}
 */
export function themeCost(tasks, runs, slug) {
  const ids = new Set(themeTasks(tasks, slug).map((task) => String(task.id)));
  const cost = {
    jobs: 0,
    toolCalls: { n: 0, sum: 0 },
    minutes: { n: 0, sum: 0 },
    verifyMinutes: { n: 0, sum: 0 },
    tokens: { n: 0, sum: 0 },
  };
  const add = (field, value) => {
    if (value === null) return;
    field.n += 1;
    field.sum += value;
  };
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.taskId === null || run?.taskId === undefined || !ids.has(String(run.taskId))) continue;
    cost.jobs += 1;
    add(cost.toolCalls, countOf(run.evidence?.toolCalls));
    const started = msOf(run.startedAt);
    const ended = msOf(run.endedAt);
    add(cost.minutes, started !== null && ended !== null && ended >= started ? (ended - started) / 60_000 : null);
    const verifyMs = countOf(run.evidence?.verifyMs);
    add(cost.verifyMinutes, verifyMs === null ? null : verifyMs / 60_000);
    const tokens = TOKEN_KINDS.map((kind) => countOf(run.evidence?.tokens?.[kind])).filter((v) => v !== null);
    add(cost.tokens, tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0));
  }
  return cost;
}

/**
 * 重さの文面: `・job N 本 (tool 計 X・分 計 Y・verify 分 計 V・トークン 計 Tk)`。
 * 分は小数 1 桁、トークンは千単位で四捨五入。欠けのある欄は `(n/N 本)` を添え、
 * 値のある job が 1 本も無い欄は出さない (全欄なければ括弧ごと出さない)。
 *
 * @param {ReturnType<typeof themeCost>|null|undefined} cost
 * @returns {string} cost が無ければ空文字
 */
export function themeCostText(cost) {
  if (!cost) return '';
  const parts = [];
  const field = (label, { n, sum }, format) => {
    if (n === 0) return;
    parts.push(`${label} 計 ${format(sum)}${n < cost.jobs ? ` (${n}/${cost.jobs} 本)` : ''}`);
  };
  field('tool', cost.toolCalls, String);
  field('分', cost.minutes, (m) => m.toFixed(1));
  field('verify 分', cost.verifyMinutes, (m) => m.toFixed(1));
  field('トークン', cost.tokens, (t) => `${Math.round(t / 1000)}k`);
  return `・job ${cost.jobs} 本${parts.length > 0 ? ` (${parts.join('・')})` : ''}`;
}

/**
 * 企画の巡回を起こすか (決定論の門)。
 *
 * - 進行中の主題が上限未満 → `add` (振り返り + 新しい主題を 0〜1 件)
 * - 上限に届いている → `review` (振り返りが先。印を付けて枠を空けたら、同じ 1 件で足してよい)
 *
 * 枠に数えるのは `active` だけ — `waiting` (配備待ちの確認だけが残る主題) は数えない。
 *
 * **上限でも閉じない。** 閉じると、進まない主題が枠を塞いだまま誰も印を付けに来ない
 * (主題ファイルを触れるのは企画の巡回の起票だけ)。間隔と「主題ファイルを触るタスクが
 * 終わるまで重ねない」は src/scheduler.js の planTick が見る。
 *
 * @param {{themes: object[], problems?: string[]}|null} parsed parseThemes の戻り (読めなければ null)
 * @param {{maxThemes?: number, missing?: boolean}} [opts] missing = ファイルがまだ無い
 * @returns {{due: boolean, mode: 'add'|'review'|null, active: object[], waiting: object[], reason: string}}
 */
export function themesGate(parsed, { maxThemes = DEFAULT_PLANNER_MAX_THEMES, missing = false } = {}) {
  if (!parsed || !Array.isArray(parsed.themes)) {
    return { due: false, mode: null, active: [], waiting: [], reason: '主題のファイルを読めない' };
  }
  const max = Number.isInteger(maxThemes) && maxThemes > 0 ? maxThemes : DEFAULT_PLANNER_MAX_THEMES;
  const active = parsed.themes.filter((theme) => theme.state === 'active');
  const waiting = parsed.themes.filter((theme) => theme.state === 'waiting');
  const held = waiting.length > 0 ? ` (配備待ち ${waiting.length} は数えない)` : '';
  if (missing) return { due: true, mode: 'add', active, waiting, reason: '主題のファイルがまだ無い' };
  if (active.length < max) {
    return { due: true, mode: 'add', active, waiting, reason: `進行中の主題 ${active.length} / 上限 ${max}${held}` };
  }
  return {
    due: true, mode: 'review', active, waiting,
    reason: `進行中の主題が上限 (${active.length} / ${max})${held} — 振り返りが先`,
  };
}
