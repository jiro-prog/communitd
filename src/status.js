// `/status` — 朝開いて 30 秒で「何が終わり・何が動き・何を決めるか」を掴むための 1 通
// (docs/implementation-plan.md P5 / docs/social-engineering.md §11.5)。**純粋関数だけ**。
//
// 状態の判定は src/taskstatus.js (受信箱と同じ判定)、組版は src/inbox.js と同じ流儀
// (どの節も見出しと先頭 1 行は必ず出す — 判断待ちの節が大量の行で消えないように)。
// データなし・読取失敗・未確認を 0 件と同一視しない: 検証記録が無ければ「不明」、
// 実行記録が読めなければその旨を書く。

import { EMPTY_INBOX, elapsed, layoutBlocks, sectionBlock } from './inbox.js';
import { RECOVERY_STATUSES, nextOperationFor, statusLabel } from './taskstatus.js';
import { formatJst, msOfTime } from './time.js';
import { formatPauseState } from './commands.js';

export const MAX_STATUS_CHARS = 1900;
export const DEFAULT_STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 8;

/** 「判断待ち」に数える状態 (人間の手が要る) */
const DECISION_STATUSES = Object.freeze(['approval-wait', 'reply-wait', 'blocked']);
/** 「進行中」に数える状態 */
const ACTIVE_STATUSES = Object.freeze(['running', 'queued', 'handoff-wait', 'review-wait', 'retry-scheduled']);

/**
 * 材料を集計する (純粋)。
 * @param {object} p
 * @param {string} p.channelName
 * @param {object[]} p.tasks そのチャンネルのタスク
 * @param {(task: object) => object} p.statusOf deriveTaskStatus 相当
 * @param {object[]} [p.runs] そのチャンネルの実行記録
 * @param {string|null} [p.runsError] 実行記録が読めない理由 (読めれば null)
 * @param {Array<{file: string, reason: string, gate?: boolean}>} [p.ledgerErrors] 読めない台帳
 *   (§12.3 (1))。`gate !== false` = **自律起動が止まる台帳** (pause / tasks / recovery /
 *   job-runs / tick-states / proposals)。それ以外は読めないことだけを出す —
 *   sessions.json の破損で「自律起動は止まっています」と書くと、表示と実態がずれる
 * @param {number} p.now
 * @param {number} [p.windowMs]
 * @param {object|null} [p.pause] PauseStore.current()
 * @param {number} [p.backoffUntil]
 * @param {number|null} [p.dayJobsLeft]
 * @param {number|null} [p.maxJobsPerDay]
 */
export function summarizeStatus({
  channelName, tasks = [], statusOf, runs = [], runsError = null, ledgerErrors = [], now = Date.now(),
  windowMs = DEFAULT_STATUS_WINDOW_MS, pause = null, backoffUntil = 0, dayJobsLeft = null, maxJobsPerDay = null,
  autonomy = false, society = null,
} = {}) {
  const from = now - windowMs;
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object');
  const runList = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === 'object');

  const completed = [];
  const dropped = [];
  for (const task of list) {
    const merged = transitionAt(task, 'merged');
    if (merged !== null && merged >= from && merged <= now) {
      completed.push({ task, at: merged, note: transitionNote(task, 'merged'), verified: verificationOf(task, runList) });
    }
    const gone = transitionAt(task, 'dropped');
    if (gone !== null && gone >= from && gone <= now) dropped.push({ task, at: gone, note: transitionNote(task, 'dropped') });
  }
  completed.sort((a, b) => b.at - a.at);

  const active = [];
  const recovering = [];
  const decisions = [];
  for (const task of list) {
    if (['merged', 'dropped'].includes(task.state)) continue;
    let status;
    try {
      status = statusOf(task);
    } catch (err) {
      status = { status: 'reconcile', reason: `判定できない (${err?.message ?? err})`, since: null, waitedMs: null, next: 'human', run: null };
    }
    if (RECOVERY_STATUSES.includes(status.status)) recovering.push({ task, status });
    else if (DECISION_STATUSES.includes(status.status)) decisions.push({ task, status });
    else if (ACTIVE_STATUSES.includes(status.status)) active.push({ task, status });
  }
  const byWaited = (a, b) => (b.status.waitedMs ?? Number.POSITIVE_INFINITY) - (a.status.waitedMs ?? Number.POSITIVE_INFINITY);
  recovering.sort(byWaited);
  decisions.sort(byWaited);

  const windowRuns = runList.filter((r) => {
    const at = msOfTime(r.endedAt ?? r.acceptedAt);
    return Number.isFinite(at) && at >= from && at <= now;
  });
  const byOutcome = {};
  for (const r of windowRuns) {
    const key = r.outcome ?? (r.stage === 'reconcile' ? 'reconcile' : 'live');
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  const open = list.filter((t) => ['proposed', 'approved'].includes(t.state)).length;

  return {
    channelName,
    now,
    windowMs,
    completed,
    dropped,
    active,
    recovering,
    decisions,
    open,
    runs: { total: windowRuns.length, byOutcome, error: runsError },
    ledgers: (Array.isArray(ledgerErrors) ? ledgerErrors : []).filter((l) => l && l.file),
    // `autonomy` は**このチャンネルで自律運転が有効か**。止まっているかどうか (pause) とは
    // 別で、未設定のチャンネルに「▶️ 動いています」と出さないために要る
    operation: {
      pause, backoffUntil: Number(backoffUntil) || 0, dayJobsLeft, maxJobsPerDay, autonomy: autonomy === true,
    },
    // 自律社会 (docs/society-ledger.md)。**渡されなければ null = 行を出さない** —
    // 社会を持たない配備の /status を 1 行増やさない
    society: society && typeof society === 'object' ? society : null,
  };
}

/**
 * 社会の 1 行 (`/status` の footer)。**渡されていなければ null** (行ごと出さない)。
 *
 * 案件の件数は「開けていれば内訳・開けていなければ書かない」— 読めなかった台帳を
 * 0 件と書くと、止まっている日と静かな日が同じに見える (受入 C14)。
 */
function formatSocietyLine(society, escape) {
  if (!society || typeof society.mode !== 'string') return null;
  // **off は行ごと出さない** — 起動ログ (societyStartupLine) と同じ方針にそろえる。
  // 使っていない機構の 1 行を、society を書いていない全チャンネルの /status に足さない
  if (society.mode === 'off') return null;
  if (society.haltReason) {
    // 停止理由は長い (直し方まで書いてある) ので、先頭の 1 文だけ出す
    const first = String(society.haltReason).split(/[。\n]/)[0];
    return `**社会**: ⛔ ${escape(society.mode)} — ${escape(oneLine(first, 80))}`;
  }
  const counts = society.cases;
  const revision = Number.isSafeInteger(society.revision) ? `revision ${society.revision}` : 'revision 不明';
  if (!counts) return `**社会**: ${escape(society.mode)} · ${revision} · 案件の件数は不明`;
  const live = ['open', 'active', 'waiting', 'verifying'].map((s) => `${s} ${counts[s] ?? 0}`).join(' / ');
  const done = (counts.resolved ?? 0) + (counts.closed ?? 0);
  return `**社会**: ${escape(society.mode)} · ${revision} · 案件 ${live} (終結 ${done})`
    + formatSocietyStalls(society, escape);
}

/**
 * 止まっている側の 1 節 (保留と待ちの内訳)。**無ければ空文字**で、静かなときは行を伸ばさない。
 *
 * 案件の件数だけでは「進んでいるのか詰まっているのか」が読めない。hold は照合で外を
 * 見きれなかった Action (予約を握ったまま) で、待ちは理由ごとに次の一手が違う。
 */
function formatSocietyStalls(society, escape) {
  const parts = [];
  // 停止は「待ち」とは別に出す — 時計では解けず、人が `/case resume` を打つまで動かない
  if (Number.isSafeInteger(society.stopped) && society.stopped > 0) parts.push(`停止 ${society.stopped}`);
  if (Number.isSafeInteger(society.held) && society.held > 0) parts.push(`保留 ${society.held}`);
  const reasons = society.waiting;
  if (reasons && typeof reasons === 'object') {
    const listed = Object.entries(reasons)
      .filter(([, n]) => Number.isSafeInteger(n) && n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, n]) => `${escape(reason)} ${n}`);
    if (listed.length > 0) {
      const overdue = Number.isSafeInteger(society.overdue) && society.overdue > 0
        ? ` (期限切れ ${society.overdue})`
        : '';
      parts.push(`待ち ${listed.join(' ')}${overdue}`);
    }
  }
  return parts.length > 0 ? ` · ${parts.join(' / ')}` : '';
}

/** 集計 → Discord の 1 通 (1900 字) */
export function formatStatus(summary, { escape = (s) => s } = {}) {
  if (!summary) return '⚠️ 状況を集計できませんでした';
  const { now } = summary;
  const hours = Math.round(summary.windowMs / 3600000);
  const head = `📊 ${escape(String(summary.channelName))} の状況 (過去 ${hours}h / ${formatJst(now) ?? '時刻不明'})`;
  const blocks = [
    sectionBlock('完了', summary.completed, MAX_ROWS, ({ task, at, note, verified }) => (
      `#${escape(String(task.id))} ${formatJst(at, { label: false })?.slice(11) ?? '?'} ${quote(task.title, escape)}`
      + ` ${verifiedLabel(verified)}${note ? ` (${escape(oneLine(note, 40))})` : ''}${link(task.threadId)}`
    )),
    sectionBlock('進行中', summary.active, MAX_ROWS, ({ task, status }) => (
      `#${escape(String(task.id))} ${escape(statusLabel(status.status))} ${elapsed(status.since, now)}`
      + ` ${quote(task.title, escape)} (${escape(oneLine(status.reason, 60))})${link(task.threadId)}`
    )),
    sectionBlock('復旧待ち', summary.recovering, MAX_ROWS, ({ task, status }) => (
      `#${escape(String(task.id))} ${elapsed(status.since, now)} ${quote(task.title, escape)}`
      + ` (${escape(statusLabel(status.status))}: ${escape(oneLine(status.reason, 60))}`
      + `${nextOperationFor(status) ? ` → ${nextOperationFor(status)}` : ''})${link(task.threadId)}`
    )),
    sectionBlock('判断待ち', summary.decisions, MAX_ROWS, ({ task, status }) => (
      `#${escape(String(task.id))} ${elapsed(status.since, now)} ${quote(task.title, escape)}`
      + ` (${escape(statusLabel(status.status))}: ${escape(oneLine(status.reason, 60))}`
      + `${nextOperationFor(status) ? ` → ${nextOperationFor(status)}` : ''})${link(task.threadId)}`
    )),
  ];
  // 0 件の節は見出しだけ出す (「無い」と「読めなかった」を分けるため、節ごと消さない)
  for (const b of blocks) if (b.rows.length === 0) b.rows.push('・なし');
  const ledgers = Array.isArray(summary.ledgers) ? summary.ledgers : [];
  // 門になる台帳かどうかで文言を分ける (gate の指定が無いものは止まる側へ倒す)
  const gated = ledgers.filter((l) => l.gate !== false);
  const others = ledgers.filter((l) => l.gate === false);
  const files = (list) => escape(oneLine(list.map((l) => l.file).join(' / '), 60));
  const footer = [
    // **自律運転を設定していないチャンネルに「動いています」と書かない。** そこで動くのは
    // メンションで起こす job だけで、この行は kill switch の状態を出すためのもの
    // (実地の導入で「自律運転は動いています」が誤解を招いた: 2026-09-12)。
    // 止められているときは、未設定でも状態を隠さない
    summary.operation.autonomy || summary.operation.pause
      ? `**運転**: ${formatPauseState(summary.operation.pause)}`
      : '**運転**: 自律運転は未設定 (このチャンネルはメンションで動きます)',
    formatSocietyLine(summary.society, escape),
    // 台帳が読めない間は自律起動そのものが止まっている — 予算やバックオフより先に出す
    gated.length > 0
      ? `❌ 読めない台帳 ${gated.length} 件 (${files(gated)})`
        + ' — 自律起動は止まっています。直すか手で退避して再起動'
      : null,
    others.length > 0
      ? `⚠️ 読めない台帳 ${others.length} 件 (${files(others)}) — 自律起動には影響なし (書き込みは断られます)`
      : null,
    summary.operation.backoffUntil > now
      ? `⏳ バックオフ中 (${Math.ceil((summary.operation.backoffUntil - now) / 60000)} 分後に明ける)`
      : null,
    summary.operation.dayJobsLeft === null
      ? null
      : `日次予算 残 ${summary.operation.dayJobsLeft}${summary.operation.maxJobsPerDay ? ` / ${summary.operation.maxJobsPerDay}` : ''}`,
    `着手待ち ${summary.open} 件`,
    summary.dropped.length > 0 ? `破棄 ${summary.dropped.length} 件` : null,
    summary.runs.error
      ? `⚠️ 実行記録が読めない (${escape(oneLine(summary.runs.error, 60))}) — job の数字は出せません`
      : `job ${summary.runs.total} 本${summary.runs.total > 0 ? ` (${Object.entries(summary.runs.byOutcome).sort().map(([k, v]) => `${k} ${v}`).join(' / ')})` : ''}`,
  ].filter(Boolean).join(' / ');
  const body = layoutBlocks(blocks, footer, MAX_STATUS_CHARS - head.length - 1);
  return `${head}\n${body === EMPTY_INBOX ? footer : body}`.slice(0, MAX_STATUS_CHARS);
}

/** verify の記録 → 表示。**無ければ不明** (成功と数えない) */
function verifiedLabel(verified) {
  if (verified === true) return 'verify OK';
  if (verified === false) return 'verify NG';
  return '検証記録なし (不明)';
}

/** そのタスクの最後の job の検証記録 (実行記録の evidence.verified) */
function verificationOf(task, runs) {
  const mine = runs.filter((r) => r.threadId === task.threadId && r.evidence && typeof r.evidence === 'object');
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const v = mine[i].evidence.verified;
    if (v === true || v === false) return v;
  }
  return null;
}

function transitionAt(task, to) {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to !== to) continue;
    const at = msOfTime(history[i].at);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

function transitionNote(task, to) {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to === to) return typeof history[i].note === 'string' ? history[i].note : '';
  }
  return '';
}

function quote(value, escape) {
  const flat = oneLine(value, 40);
  return flat === '' ? '(題なし)' : `「${escape(flat)}」`;
}

function oneLine(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function link(threadId) {
  return threadId ? ` <#${String(threadId)}>` : '';
}
