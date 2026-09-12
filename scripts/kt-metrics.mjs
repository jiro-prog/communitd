// ボードの数字を出す読み取り専用 CLI (docs/social-engineering.md §9.6)。
//
//   node scripts/kt-metrics.mjs                             # 全チャンネル
//   node scripts/kt-metrics.mjs --channel my-project        # 1 チャンネルだけ
//   node scripts/kt-metrics.mjs --file data/tasks.json      # 別のボードを読む
//   node scripts/kt-metrics.mjs --since 2026-09-01 --until 2026-09-07   # 期間 (JST の暦日。§11.5)
//   node scripts/kt-metrics.mjs --runs data/job-runs.json --recovery data/recovery.json  # 実行記録と再開も
//
// 自律運転の出口は「作者の介入・残った merge 数・drop 率」で判定するのに、
// 目で数えている限り 2 週間後に言えるのは「たぶん減った」だけになる。ボードの履歴は
// 誰がいつ何を動かしたかを持っているので、そこから機械的に出す。
//
// **読むだけ。** ここからボードは書き換えない (集計が状態を動かすと、数えるたびに
// 数える対象が変わる)。集計は純関数 `summarizeBoard` に切ってテストしてある。
// **だから `TaskBoardStore` は使わない** — 基底の `JsonStore` は壊れた入力を
// `.corrupt-<時刻>` へ退避リネームし、無いファイルを空ボードとして開く (src/store.js)。
// 数えるためにボードを書き換える道理は無いし、「無い」を「0 件」と同じ数字にすると、
// 間違ったパスを渡したことに気付けない。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TERMINAL_STATES } from '../src/board.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = resolve(ROOT, 'data', 'tasks.json');
const DEFAULT_POLICY = resolve(ROOT, 'config.policy.json');

/** 非終端の並び順 (出力の内訳をいつも同じ順で出す) */
const OPEN_STATES = ['proposed', 'approved', 'in-progress', 'review', 'blocked'];

/**
 * ボードのタスク → チャンネルごとの数字 (純粋)。
 *
 * **`by` の分類がこの集計の肝。** 履歴の各行は誰が動かしたかを持っている:
 * config の `bots` に居るキーなら bot、`scheduler` なら機械の自律起動、
 * **どちらでもないものは人間の介入** (`/review` や手作業)、`by` 無しは移行前の古い行。
 * 「作者の介入 分/日」を測る代わりに、まず「人間が board を動かした回数」を数える。
 *
 * `blocked` は**終端ではない**ので open に数える (要人間で止まっているだけで、
 * `resume` で戻せる)。同じ理由で merged / dropped だけを閉じた扱いにする。
 *
 * @param {object[]} tasks ボードのタスク (`readBoard` の結果)
 * @param {{botKeys?: string[], now?: number}} options `now` は出力の見出しに載せる時刻
 * @returns {{at: string, channels: Array<object>}} channels はチャンネル名の昇順
 */
export function summarizeBoard(tasks, { botKeys = [], now = Date.now(), since = null, until = null } = {}) {
  const known = new Set(Array.isArray(botKeys) ? botKeys : []);
  const byChannel = new Map();
  // 期間 (§11.5)。**期間内に起きたイベント**と**期間末の状態**を分けて数える。
  // 期間を切らなければ従来どおり (全期間 = 現在の状態)
  const period = since !== null || until !== null;
  const from = Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY;
  const to = Number.isFinite(until) ? until : now;
  const within = (at) => Number.isFinite(at) && at >= from && at < to;

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== 'object') continue;
    const channel = String(task.channel ?? '(チャンネル不明)');
    if (!byChannel.has(channel)) byChannel.set(channel, blankSummary(channel, period ? { since, until: to } : null));
    const sum = byChannel.get(channel);
    // 状態は**期間末の時点**で読む (期間を切らなければ現在の状態)
    const state = period ? stateAt(task, to) : String(task.state ?? '');
    if (state === null) continue; // 期間末にはまだ存在しなかったタスク

    const filedAt = transitionAt(task, 'proposed') ?? Date.parse(task.createdAt ?? '');
    const filedInPeriod = !period || within(filedAt);
    if (filedInPeriod) {
      sum.filed += 1;
      if (state === 'merged') sum.filedMerged += 1;
    }
    // 期間内に起きた着地・破棄 (起票の時期は問わない)
    if (period ? within(transitionAt(task, 'merged')) : state === 'merged') sum.merged += 1;
    if (period ? within(transitionAt(task, 'dropped')) : state === 'dropped') sum.dropped += 1;
    if (state === 'blocked') sum.blocked += 1;
    if (!TERMINAL_STATES.includes(state)) {
      sum.open += 1;
      sum.openByState[state] = (sum.openByState[state] ?? 0) + 1;
    }

    for (const entry of Array.isArray(task.history) ? task.history : []) {
      if (period && !within(Date.parse(entry?.at ?? ''))) continue;
      if (entry?.from === 'review' && entry?.to === 'in-progress') sum.sendBacks += 1;
      const by = typeof entry?.by === 'string' ? entry.by.trim() : '';
      if (by === '') sum.by.unknown += 1;
      else if (known.has(by)) sum.by.bots[by] = (sum.by.bots[by] ?? 0) + 1;
      else if (by === 'scheduler') sum.by.scheduler += 1;
      else sum.by.owner += 1;
    }

    const lead = leadMinutes(task);
    if (lead !== null && (!period || within(transitionAt(task, 'merged')))) sum.lead.samples.push(lead);
  }

  const channels = [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel));
  for (const sum of channels) {
    const sorted = [...sum.lead.samples].sort((a, b) => a - b);
    sum.lead = {
      count: sorted.length,
      medianMin: round1(median(sorted)),
      p90Min: round1(percentile(sorted, 0.9)),
    };
  }
  return { at: new Date(now).toISOString(), period: period ? { since, until: to } : null, channels };
}

/** 履歴の `to` が state になった最後の時刻 (ms)。無ければ null */
function transitionAt(task, state) {
  const history = Array.isArray(task?.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to !== state) continue;
    const at = Date.parse(history[i]?.at ?? '');
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

/**
 * その時刻での状態 (履歴から復元)。**期間末の状態**を数えるために要る — 現在の状態で数えると
 * 「先週の open」に今週 merged になったものが混ざる。履歴が読めなければ現在の状態へ落とす。
 * @returns {string|null} その時刻にまだ存在しなかったタスクは null
 */
export function stateAt(task, at) {
  const history = (Array.isArray(task?.history) ? task.history : [])
    .filter((e) => e && typeof e.to === 'string' && Number.isFinite(Date.parse(e.at ?? '')));
  if (history.length === 0) return String(task?.state ?? '');
  let state = null;
  for (const entry of history) {
    if (Date.parse(entry.at) >= at) break;
    state = entry.to;
  }
  return state;
}

/**
 * 実行記録 (data/job-runs.json) の集計 (純粋)。**終わり方・止めた主体・復旧待ちに入った件数・
 * 復旧待ちの時間** (次の job が受け付けられるまで。まだ無ければ「未解消」として別に数える)。
 * @param {object[]} runs
 * @param {{since?: number|null, until?: number|null, now?: number, channel?: string|null}} options
 */
export function summarizeRuns(runs, { since = null, until = null, now = Date.now(), channel = null } = {}) {
  const from = Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY;
  const to = Number.isFinite(until) ? until : now;
  const list = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
    .filter((r) => channel === null || r.channelName === channel)
    .sort((a, b) => Date.parse(a.acceptedAt ?? '') - Date.parse(b.acceptedAt ?? ''));
  const inPeriod = list.filter((r) => {
    const at = Date.parse(r.endedAt ?? r.acceptedAt ?? '');
    return Number.isFinite(at) && at >= from && at < to;
  });
  const byOutcome = {};
  const byStopKind = {};
  let stalled = 0;
  const waits = [];
  let unresolved = 0;
  for (const run of inPeriod) {
    const outcome = run.outcome ?? (run.stage === 'reconcile' ? 'reconcile' : 'live');
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    if (run.stopKind) byStopKind[run.stopKind] = (byStopKind[run.stopKind] ?? 0) + 1;
    if (run.next !== 'recovery') continue;
    stalled += 1;
    const endedAt = Date.parse(run.endedAt ?? '');
    const next = list.find((r) => r.threadId === run.threadId && Date.parse(r.acceptedAt ?? '') > endedAt);
    if (next) waits.push((Date.parse(next.acceptedAt) - endedAt) / 60000);
    else unresolved += 1;
  }
  const sorted = [...waits].sort((a, b) => a - b);
  return {
    total: inPeriod.length,
    byOutcome,
    byStopKind,
    stalled,
    recoveryWait: { count: sorted.length, medianMin: round1(median(sorted)), p90Min: round1(percentile(sorted, 0.9)), unresolved },
  };
}

/**
 * 再開の台帳 (data/recovery.json) の集計 — 手動 / 自動の件数と結果。
 * 結果の語彙は `RecoveryStore` (§11.3): accepted (受け付けられた) / sent (送信済み・受付待ち) /
 * send-unknown (送達不明) / expired (猶予内に受付なし) / failed(理由) / pending (送信前)
 */
export function summarizeRecovery(entries, { since = null, until = null, now = Date.now() } = {}) {
  const from = Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY;
  const to = Number.isFinite(until) ? until : now;
  const out = { manual: 0, auto: 0, accepted: 0, sent: 0, unknown: 0, expired: 0, failed: 0, pending: 0, tasks: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const attempts = (Array.isArray(entry?.attempts) ? entry.attempts : [])
      .filter((a) => { const at = Date.parse(a?.at ?? ''); return Number.isFinite(at) && at >= from && at < to; });
    if (attempts.length === 0) continue;
    out.tasks += 1;
    for (const a of attempts) {
      if (a.kind === 'auto') out.auto += 1; else out.manual += 1;
      const result = String(a.result ?? '');
      if (result === 'accepted' || result === 'started') out.accepted += 1;
      else if (result === 'sent') out.sent += 1;
      else if (result === 'send-unknown') out.unknown += 1;
      else if (result === 'expired') out.expired += 1;
      else if (result.startsWith('failed')) out.failed += 1;
      else out.pending += 1;
    }
  }
  return out;
}

function blankSummary(channel, period = null) {
  return {
    channel,
    period,
    filed: 0,
    filedMerged: 0, // 期間内に起票した集団のうち、期間末までに merged になった数
    merged: 0,
    dropped: 0,
    blocked: 0,
    open: 0,
    openByState: {},
    sendBacks: 0,
    by: { bots: {}, scheduler: 0, owner: 0, unknown: 0 },
    lead: { samples: [] },
  };
}

/**
 * 起票から merged までの分。**時刻源は履歴**で、`updatedAt` へは落とさない
 * (終端に入った後で触られた行を所要時間に混ぜない)。読めなければ null。
 */
function leadMinutes(task) {
  if (task.state !== 'merged') return null;
  const history = Array.isArray(task.history) ? task.history : [];
  const merged = [...history].reverse().find((entry) => entry?.to === 'merged');
  const proposed = history.find((entry) => entry?.to === 'proposed');
  const end = Date.parse(merged?.at);
  const start = Date.parse(proposed?.at ?? task.createdAt);
  if (!Number.isFinite(end) || !Number.isFinite(start) || end < start) return null;
  return (end - start) / 60000;
}

/** 中央値 (昇順の配列を受け取る)。空なら null */
function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** nearest-rank の分位点 (補間しない — 件数が 1 桁のうちは補間しても精度は増えない) */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** 集計 → 人が読む形。数字の並びは毎回同じにする (差分で読めるように) */
export function formatSummary(summary, { file = '', runs = null, recovery = null } = {}) {
  const lines = [];
  if (file) lines.push(`ボード: ${file}`);
  lines.push(`集計時刻: ${summary.at}`);
  if (summary.period) {
    const since = Number.isFinite(summary.period.since) ? new Date(summary.period.since).toISOString() : '(最初から)';
    lines.push(`期間: ${since} 〜 ${new Date(summary.period.until).toISOString()} (状態は期間末の時点)`);
  }
  lines.push('');
  if (summary.channels.length === 0) {
    lines.push('タスクがありません');
  }
  for (const sum of summary.channels) {
    const open = OPEN_STATES.map((state) => `${state} ${sum.openByState[state] ?? 0}`).join(' / ');
    const bots = Object.keys(sum.by.bots).sort()
      .map((key) => `${key} ${sum.by.bots[key]}`).join(' / ');
    lines.push(`## ${sum.channel}`);
    if (sum.period) {
      // 起票した集団と、期間内に着地した集団は**別の行** (混ぜて完了率を出さない)
      lines.push(
        `期間内に起票 ${sum.filed} (うち期間末までに merged ${sum.filedMerged})`,
        `期間内に merged ${sum.merged} / dropped ${sum.dropped} (起票時期は問わない)`,
        `期間末の open ${sum.open} (${open}) / blocked ${sum.blocked}`,
      );
    } else {
      lines.push(
        `起票 ${sum.filed} / merged ${sum.merged} / dropped ${sum.dropped} / blocked ${sum.blocked}`,
        `open ${sum.open} (${open})`,
      );
    }
    lines.push(
      `差し戻し ${sum.sendBacks} 回`,
      `遷移主体: ${bots || '(bot なし)'} / scheduler ${sum.by.scheduler}`
      + ` / owner ${sum.by.owner} / 不明 ${sum.by.unknown}`
      + ' (owner は板を動かした回数で、介入した分ではない — 分は docs/trial-log.md)',
      `proposed→merged: ${sum.lead.count} 件`
      + (sum.lead.count === 0
        ? ' (まだ着地していない)'
        : ` 中央値 ${sum.lead.medianMin} 分 / p90 ${sum.lead.p90Min} 分`),
      '',
    );
  }
  if (runs) {
    const outcomes = Object.keys(runs.byOutcome).sort().map((k) => `${k} ${runs.byOutcome[k]}`).join(' / ');
    const stops = Object.keys(runs.byStopKind).sort().map((k) => `${k} ${runs.byStopKind[k]}`).join(' / ');
    lines.push(
      '## 実行記録 (job)',
      `job ${runs.total} 本${outcomes ? ` (${outcomes})` : ''}`,
      `止めた主体: ${stops || '(なし)'}`,
      `復旧待ちに入った job ${runs.stalled} 本 — 解消 ${runs.recoveryWait.count} 本`
      + (runs.recoveryWait.count > 0
        ? ` (次の job まで 中央値 ${runs.recoveryWait.medianMin} 分 / p90 ${runs.recoveryWait.p90Min} 分)`
        : '')
      + ` / 未解消 ${runs.recoveryWait.unresolved} 本`,
      '',
    );
  }
  if (recovery) {
    lines.push(
      '## 再開 (recovery)',
      `対象 task ${recovery.tasks} 件 / 手動 ${recovery.manual} 回 / 自動 ${recovery.auto} 回`
      + ` (受付済み ${recovery.accepted} / 送信済み受付待ち ${recovery.sent} / 送達不明 ${recovery.unknown}`
      + ` / 期限切れ ${recovery.expired} / 起こせなかった ${recovery.failed} / 送信前 ${recovery.pending})`,
      '',
    );
  }
  return lines.join('\n');
}

/**
 * `--since` / `--until` の値。ISO 8601 か `YYYY-MM-DD` (日付だけなら **JST の暦日**で、
 * since はその日の 0:00、until はその日の翌 0:00 = その日を含む)。
 * @returns {number} ms
 */
export function parseDateArg(value, { end = false } = {}) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const start = Date.parse(`${text}T00:00:00+09:00`);
    if (!Number.isFinite(start)) throw new Error(`日付として読めません: ${text}`);
    return end ? start + 24 * 60 * 60 * 1000 : start;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`日時として読めません: ${text} (YYYY-MM-DD か ISO 8601)`);
  return ms;
}

/**
 * 引数を読む。`--file <path>` / `--channel <name>` だけ。
 * **知らないオプションと位置引数は断る** — 打ち間違いを黙って無視すると、
 * 絞ったつもりの数字を全チャンネルの数字として読むことになる。
 */
const OPTIONS = ['--file', '--channel', '--since', '--until', '--runs', '--recovery'];

export function parseArgs(argv) {
  const out = { file: DEFAULT_FILE, channel: null, since: null, until: null, runs: null, recovery: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!OPTIONS.includes(arg)) {
      throw new Error(`知らないオプション: ${arg} (使えるのは ${OPTIONS.join(' / ')} だけ)`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} に値が渡されていません`);
    if (arg === '--file') out.file = value;
    else if (arg === '--channel') out.channel = value;
    else if (arg === '--since') out.since = parseDateArg(value);
    else if (arg === '--until') out.until = parseDateArg(value, { end: true });
    else if (arg === '--runs') out.runs = value;
    else out.recovery = value;
    i += 1;
  }
  if (out.since !== null && out.until !== null && out.since >= out.until) {
    throw new Error('--since は --until より前にしてください');
  }
  return out;
}

/**
 * id → 記録の JSON を**読むだけ**で開く (readBoard と同じ流儀 — 無い・壊れているを 0 件にしない)。
 * @returns {object[]} 値の配列
 */
export function readRecords(file, label) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${label} ${file} を読めません (${err.message})`, { cause: err });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} ${file} が JSON として読めません (${err.message})`, { cause: err });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} ${file} のトップレベルが id → 記録の object ではありません`);
  }
  return Object.values(data).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
}

/**
 * ボードを**読むだけ**で開く (§9.6)。`TaskBoardStore` を通さない理由は冒頭のコメント。
 *
 * 落ちる条件は 3 つ — 読めない / JSON でない / トップレベルが `id → タスク` の object
 * でない。**どれも黙って空ボードにしない**: 集計は「0 件」と「読めなかった」を
 * 区別できないと、数字を誤読したまま出口判定に使うことになる。
 *
 * @param {string} file ボードの JSON (data/tasks.json と同じ形)
 * @returns {object[]} task らしい値だけ (`TaskBoardStore.get` と同じ緩さで拾う)
 * @throws {Error} 上の 3 条件。**何も書かない・何もリネームしない**
 */
export function readBoard(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${file} を読めません (${err.message})`, { cause: err });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} が JSON として読めません (${err.message})`, { cause: err });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} のトップレベルが id → タスクの object ではありません`);
  }
  // 手で編集された値・古い形が混ざっても落とさない (状態の読めないものは task ではない)
  return Object.values(data).filter(
    (task) => task && typeof task === 'object' && !Array.isArray(task)
      && typeof task.state === 'string',
  );
}

/** config の bots キー (誰が bot かはここが正本。無ければ人間の介入と区別できない) */
function readBotKeys(policyPath) {
  try {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    return Object.keys(policy?.bots ?? {});
  } catch (err) {
    throw new Error(`${policyPath} を読めません (${err.message}) — bot と人間を区別できません`, { cause: err });
  }
}

function main(argv) {
  const { file, channel, since, until, runs: runsFile, recovery: recoveryFile } = parseArgs(argv);
  const now = Date.now();
  const tasks = readBoard(file).filter((task) => channel === null || task.channel === channel);
  const summary = summarizeBoard(tasks, { botKeys: readBotKeys(DEFAULT_POLICY), now, since, until });
  const runs = runsFile ? summarizeRuns(readRecords(runsFile, '実行記録'), { since, until, now, channel }) : null;
  const recovery = recoveryFile ? summarizeRecovery(readRecords(recoveryFile, '再開の台帳'), { since, until, now }) : null;
  console.log(formatSummary(summary, { file, runs, recovery }));
  return 0;
}

// import しても走らせない (summarizeBoard をテストから直接叩けるように)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`数字を出せません: ${err.message}`);
    process.exitCode = 1;
  }
}
