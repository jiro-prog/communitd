// 回し方の成績 (loop-report)。自律ループの回り方 — ① 巡回の空回り ② 段の待ち ③ 日次の上限で止まった時間
// ④ 配備の遅れと作者待ち — を 1 つの定義で数える (scripts/loop-report.mjs が読む)。
//
// 企画の巡回は毎回 node -e で記録を数え直し、数え方が回ごとに違っていた。ここに定義を 1 本置いて、
// 企画が引用できる長さ (LOOP_REPORT_MAX_CHARS) の文にする。**判定にも門にもしない** — 数えて見せるだけ。
//
// **IO を持たない。** 台帳は呼び出し側が読んで渡し、git は `(args, cwd) => stdout` を注入する
// (src/bridge/boots.js と同じ流儀)。時刻は表示も暦日も JST (src/time.js)。
import { resolve } from 'node:path';

import { jobKindOf } from './harness.js';
import { JST_OFFSET_MS, formatJst, jstDayKey, msOfTime } from './time.js';

/** 文の上限 (字)。企画が申し送りや Discord の 1 通 (2000 字) へそのまま引用できる長さ */
export const LOOP_REPORT_MAX_CHARS = 1900;

/** 既定の期間 (日)。今日を含む直近の暦日 */
export const LOOP_REPORT_DEFAULT_DAYS = 7;

/** ④ が読めないときの言い方。0 本と区別する (配備前は台帳が無いので、これが出るのが正しい) */
export const NO_BOOT_RECORD = '起動の記録なし — ④ は読めない';

const DAY_MS = 24 * 60 * 60 * 1000;
const HEAD_PATTERN = /^[0-9a-f]{40}$/;

/** 巡回の役 (表示の順)。同じ bot が複数の役を持つなら 1 つの群にまとめる — 記録からは分けられない */
const PATROL_ROLES = [['scout', 'スカウト'], ['planner', '企画'], ['harness', '改訂']];

/** ② の段: 表示名と、その段に居る間の状態 */
const STAGES = [['approval', '承認', 'proposed'], ['start', '着手', 'approved'], ['work', '作業', 'in-progress'], ['review', 'レビュー', 'review']];

const finite = (value) => {
  const ms = msOfTime(value);
  return Number.isFinite(ms) ? ms : null;
};

/** JST の暦日の 0:00 (ms) */
const dayStart = (day) => Date.parse(`${day}T00:00:00+09:00`);

/** 絶対時刻として正しく、JST で読める ISO (`2026-10-14T21:30:00.000+09:00`)。JSON の出力用 */
function isoJst(ms) {
  return ms === null ? null : new Date(ms + JST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);
const minutesOf = (ms) => (ms === null ? null : round1(ms / 60_000));

/**
 * 既定の期間の始まり: `until` の属する JST の暦日を含む直近 LOOP_REPORT_DEFAULT_DAYS 日の 0:00。
 * `until` は排他 (その日の翌 0:00 を渡されたらその日まで)
 */
export function defaultSince(until) {
  return dayStart(jstDayKey(until - 1)) - (LOOP_REPORT_DEFAULT_DAYS - 1) * DAY_MS;
}

/** [since, end) にかかる JST の暦日 (古い順) */
function daysBetween(since, end) {
  const days = [];
  if (!(end > since)) return days;
  for (let day = jstDayKey(since); dayStart(day) < end; day = jstDayKey(dayStart(day) + DAY_MS)) days.push(day);
  return days;
}

/**
 * 巡回の群 (純粋)。scout / planner / harness の bot ごとに 1 群、同じ bot の役はまとめて「企画・改訂」のように並べる。
 * @param {object} autonomy resolveAutonomy の結果
 * @returns {{botKey: string, roles: string[], label: string}[]}
 */
export function patrolGroups(autonomy) {
  const groups = [];
  for (const [role, label] of PATROL_ROLES) {
    const bot = autonomy?.[role]?.bot;
    if (typeof bot !== 'string' || bot === '') continue;
    const found = groups.find((g) => g.botKey === bot);
    if (found) {
      found.roles.push(role);
      found.label += `・${label}`;
    } else {
      groups.push({ botKey: bot, roles: [role], label });
    }
  }
  return groups;
}

/**
 * data/boots.json の中身 → 起動の列 (純粋)。形は src/bridge/boots.js が書くもの
 * (`{ boots: [ { at, head, branch, pid } ] }`、古い順)。読めなければ reason に理由を入れて entries は null
 * @param {string} raw ファイルの中身
 * @returns {{entries: object[]|null, reason: string|null}}
 */
export function parseBoots(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { entries: null, reason: 'boots.json が JSON として読めない' };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.boots)) {
    return { entries: null, reason: 'boots.json に起動の配列 (boots) が無い' };
  }
  return { entries: data.boots, reason: null };
}

/** 比べられる形のパス (Windows は大文字小文字を区別しない) */
function samePath(a, b) {
  const norm = (p) => {
    const full = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

/** git の出力 (前後の空白を落とす)。失敗は throw のまま */
const gitOut = (git, args, cwd) => String(git(args, cwd) ?? '').trim();

/** git の失敗の 1 行目 (理由に添える) */
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 120);

/**
 * チャンネルの作業場所がブリッジ本体と同じリポジトリか。パスが同じなら git を呼ばない。
 * 違えば git の共通ディレクトリで比べる (ブリッジの作業ツリー `.worktrees/…` から走らせても同じと読む)。
 * チャンネル側が git で読めなければ別物
 */
function sameRepository({ git, root, cwd }) {
  if (samePath(cwd, root)) return true;
  let theirs;
  try {
    theirs = resolve(cwd, gitOut(git, ['rev-parse', '--git-common-dir'], cwd));
  } catch {
    return false;
  }
  return samePath(resolve(root, gitOut(git, ['rev-parse', '--git-common-dir'], root)), theirs);
}

/**
 * ④ 配備の遅れ (git は注入)。
 *
 * boots.json の**最新の 1 件** (古い順の末尾) の head から baseBranch までの、first-parent の merge の本数と
 * そのうち最古の commit 時刻。古い起動へ遡らない (動いているのは最新の起動の版)。
 * 数えられるのはチャンネルの作業場所がブリッジ本体と同じリポジトリのときだけ —
 * boots.json に残るのはブリッジ本体の HEAD なので、他のリポジトリの baseBranch と比べても意味が無い。
 * head が baseBranch の祖先でない (別のブランチで起動した) と `head..base` は「未配備」より広く数える。
 *
 * @param {{boots: {entries: object[]|null, reason: string|null}, git: Function, root: string, cwd: string|null, baseBranch: string}} p
 * @returns {{status: 'ok', boot: object, baseBranch: string, pending: number, oldestAt: number|null}
 *   | {status: 'unreadable', reason: string} | {status: 'not-applicable'}}
 */
export function deployStatus({ boots, git, root, cwd, baseBranch }) {
  if (typeof cwd !== 'string' || cwd === '') return { status: 'not-applicable' };
  try {
    if (!sameRepository({ git, root, cwd })) return { status: 'not-applicable' };
  } catch (err) {
    return { status: 'unreadable', reason: `ブリッジのリポジトリを git で読めない (${firstLine(err)})` };
  }
  if (!boots || boots.reason) return { status: 'unreadable', reason: `${NO_BOOT_RECORD} (${boots?.reason ?? 'boots.json が無い'})` };
  const last = Array.isArray(boots.entries) ? boots.entries.at(-1) : null;
  if (!last || typeof last !== 'object') return { status: 'unreadable', reason: `${NO_BOOT_RECORD} (起動が 1 件も無い)` };
  if (typeof last.head !== 'string' || !HEAD_PATTERN.test(last.head)) {
    return { status: 'unreadable', reason: `${NO_BOOT_RECORD} (最新の起動の head が null)` };
  }
  const head = last.head;
  const short = head.slice(0, 7);
  try {
    git(['cat-file', '-e', `${head}^{commit}`], root);
  } catch {
    return { status: 'unreadable', reason: `④ は読めない (起動の head ${short} がこのリポジトリに無い)` };
  }
  const range = `${head}..${baseBranch}`;
  let pending;
  let oldestAt = null;
  try {
    pending = Number.parseInt(gitOut(git, ['rev-list', '--count', '--first-parent', '--merges', range], root), 10);
    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('rev-list --count の出力が数でない');
    if (pending > 0) {
      // git log の -1 は --reverse より先に効くので、全部取って末尾 (最古) を読む
      const times = gitOut(git, ['log', '--first-parent', '--merges', '--format=%ct', range], root).split('\n');
      const sec = Number.parseInt(times.at(-1), 10);
      oldestAt = Number.isSafeInteger(sec) ? sec * 1000 : null;
    }
  } catch (err) {
    return { status: 'unreadable', reason: `④ は読めない (${baseBranch} との差を git で数えられない: ${firstLine(err)})` };
  }
  return {
    status: 'ok',
    boot: { at: finite(last.at), head, branch: typeof last.branch === 'string' ? last.branch : null },
    baseBranch,
    pending,
    oldestAt,
  };
}

/** 履歴の entry のうち時刻の読めるもの (ms を添える)。並びは台帳のまま */
const historyOf = (task) => (Array.isArray(task?.history) ? task.history : []).filter((e) => e && typeof e === 'object');

/** 最後に merged になった時刻 */
function mergedAt(task) {
  const history = historyOf(task);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].to === 'merged') return finite(history[i].at);
  }
  return null;
}

/**
 * タスク 1 件の段ごとの滞在 (ms、純粋)。entry の `to` の状態に、次の entry までの間居たと読む。
 * 同じ状態に戻った (差し戻し) ら足す。**blocked に居た時間はどの段にも入れない**。
 * 最後の merged より後は読まない。時刻の読めない entry の前後と、逆行する区間は捨てる
 */
function stageTimes(task) {
  const history = historyOf(task);
  let last = history.length - 1;
  while (last >= 0 && history[last].to !== 'merged') last -= 1;
  const totals = {};
  let sendBacks = 0;
  for (let i = 0; i < last; i += 1) {
    const cur = history[i];
    const next = history[i + 1];
    if (next.from === 'review' && next.to === 'in-progress') sendBacks += 1;
    const from = finite(cur.at);
    const to = finite(next.at);
    if (from === null || to === null || to < from) continue;
    totals[cur.to] = (totals[cur.to] ?? 0) + (to - from);
  }
  return { totals, sendBacks };
}

/**
 * 回し方の成績 (純粋、git だけ注入)。
 *
 * ① 巡回: 実行記録のうち `jobKindOf` が 'other'・`trigger.kind` が 'bot'・bot がそのチャンネルの scout / planner /
 *   harness のもの。**近似** — worker と scout が同じ bot の配備では、ボードの外のスレッドでその bot へ渡した job も混ざる。
 *   終端の無い job (走行中) は数えない。日は**受付**の時刻 (無ければ起動) の JST 暦日 — スケジューラが日次上限に
 *   数えるのは起こした時点で、23:58 に受け付けて 0:06 に起動した job は前の日の勘定に入っている (③ と揃える)。
 *   提案 = その job の起動 (無ければ受付)〜終端 (両端込み) に起票され (`history[0].at`)、`history[0].by` がその bot のタスク
 *   (提案は終端の数秒前に proposed になる)。tool は `evidence.toolCalls` のある job だけの合計と中央値。
 * ② 段の待ち: **期間内に merged になったタスク**の、承認 (proposed)・着手 (approved)・作業 (in-progress)・
 *   レビュー (review) に居た時間の合計 (stageTimes) の中央値と、同じ集合の差し戻し (review→in-progress) の回数。
 *   merge→次の起票 = 同じチャンネルで merge より後に最初に起票されたタスクの `history[0].at` まで。後に起票が無い merge は外す。
 * ③ 日次: その日の job 数と、自律起動 = 着手 (ボード履歴の approved→in-progress) + ① の巡回 + 自動復旧
 *   (data/recovery.json の attempts のうち kind 'auto' で sentAt のあるもの。日は sentAt)。レビュー・承認は数えない。
 *   **記録から数え直した値で、発議 (initiative) は含まない** — 上限を実際に見ている tick-states.json の jobsToday は
 *   発議も足すが、日が変わると 0 に戻るので過去の分は残っていない。自律起動が上限に届いた日は、上限本目の起動から
 *   翌 0:00 JST (今日なら今) までを止まった時間とする。
 * ④ 配備と作者待ち: deployStatus と、受信箱 (data/inbox.json) のこのチャンネルの開いた用件 (closedAt が null)。
 *   どちらも期間ではなく今の状態。
 *
 * @param {object} p
 * @param {object[]} p.runs 実行記録 (全チャンネル)
 * @param {object[]} p.tasks ボード (アーカイブ込み・全チャンネル)
 * @param {object[]} p.recovery 再開の台帳の entry
 * @param {object[]} p.inbox 受信箱の entry
 * @param {{entries: object[]|null, reason: string|null}} p.boots parseBoots の結果 (無ければ reason だけ)
 * @param {object} p.autonomy resolveAutonomy の結果
 * @param {string} p.channel
 * @param {string|null} p.cwd チャンネルの作業場所
 * @param {string} p.root ブリッジ本体のルート
 * @param {(args: string[], cwd: string) => string} p.git
 * @param {number} p.since 期間の始まり (ms、含む)
 * @param {number} p.until 期間の終わり (ms、含まない)
 * @param {number} p.now
 */
export function summarizeLoop({
  runs = [], tasks = [], recovery = [], inbox = [], boots = null, autonomy, channel,
  cwd = null, root, git, since, until, now,
}) {
  const end = Math.min(until, now);
  const within = (at) => at !== null && at >= since && at < end;
  const days = daysBetween(since, end);
  const cap = autonomy.maxJobsPerDay;
  const groups = patrolGroups(autonomy);
  const patrolBots = new Set(groups.map((g) => g.botKey));

  const channelTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.channel === channel);
  const channelRuns = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === 'object' && r.channelName === channel);
  // 受付の時刻 (= スケジューラが勘定した時刻)。③ の job 数もこれで日を切る
  const runAt = (run) => finite(run.acceptedAt) ?? finite(run.startedAt);
  const filings = channelTasks
    .map((t) => ({ task: t, first: historyOf(t)[0] ?? null }))
    .map(({ task, first }) => ({ task, by: first?.by, to: first?.to, at: finite(first?.at) }))
    .filter((f) => f.at !== null);

  // ① 巡回
  const patrolRuns = channelRuns
    .filter((r) => jobKindOf(r) === 'other' && r.trigger?.kind === 'bot' && patrolBots.has(r.botKey))
    .map((r) => ({ run: r, at: runAt(r), startedAt: finite(r.startedAt) ?? runAt(r), endedAt: finite(r.endedAt) }))
    .filter((p) => p.endedAt !== null && within(p.at));
  const patrolDays = days.map((day) => ({
    day,
    groups: groups.map((g) => {
      const mine = patrolRuns.filter((p) => p.run.botKey === g.botKey && jstDayKey(p.at) === day);
      const proposals = mine.map((p) => filings.filter((f) => f.to === 'proposed' && f.by === g.botKey
        && f.at >= p.startedAt && f.at <= p.endedAt).length);
      const calls = mine.map((p) => p.run.evidence?.toolCalls).filter((n) => Number.isSafeInteger(n) && n >= 0);
      return {
        botKey: g.botKey,
        jobs: mine.length,
        proposals: proposals.reduce((a, b) => a + b, 0),
        idle: proposals.filter((n) => n === 0).length,
        toolCalls: { n: calls.length, sum: calls.reduce((a, b) => a + b, 0), median: median(calls) },
      };
    }),
  }));

  // ② 段の待ち
  const merged = channelTasks.map((t) => ({ task: t, at: mergedAt(t) })).filter((m) => within(m.at));
  const stageSamples = Object.fromEntries(STAGES.map(([key]) => [key, []]));
  let sendBacks = 0;
  for (const { task } of merged) {
    const { totals, sendBacks: n } = stageTimes(task);
    sendBacks += n;
    for (const [key, , state] of STAGES) if (Object.hasOwn(totals, state)) stageSamples[key].push(totals[state]);
  }
  const nextFiling = [];
  for (const { at } of merged) {
    const next = filings.filter((f) => f.at > at).reduce((min, f) => (min === null || f.at < min ? f.at : min), null);
    if (next !== null) nextFiling.push(next - at);
  }
  const stages = {
    merged: merged.length,
    ...Object.fromEntries(STAGES.map(([key]) => [key, { n: stageSamples[key].length, medianMin: minutesOf(median(stageSamples[key])) }])),
    sendBacks,
    nextFiling: { n: nextFiling.length, medianMin: minutesOf(median(nextFiling)) },
  };

  // ③ 日次
  const taskChannel = new Map((Array.isArray(tasks) ? tasks : []).filter(Boolean).map((t) => [String(t.id), t.channel]));
  const launches = [
    ...channelTasks.flatMap((t) => historyOf(t)
      .filter((e) => e.from === 'approved' && e.to === 'in-progress')
      .map((e) => ({ kind: 'starts', at: finite(e.at) }))),
    ...patrolRuns.map((p) => ({ kind: 'patrol', at: p.at })),
    ...(Array.isArray(recovery) ? recovery : [])
      .filter((entry) => entry && taskChannel.get(String(entry.taskId)) === channel)
      .flatMap((entry) => (Array.isArray(entry.attempts) ? entry.attempts : [])
        .filter((a) => a && a.kind === 'auto')
        .map((a) => ({ kind: 'recoveries', at: finite(a.sentAt) }))),
  ].filter((l) => within(l.at)).sort((a, b) => a.at - b.at);
  const daily = days.map((day) => {
    const mine = launches.filter((l) => jstDayKey(l.at) === day);
    const count = (kind) => mine.filter((l) => l.kind === kind).length;
    const capped = mine.length >= cap ? mine[cap - 1].at : null;
    const stopEnd = Math.min(dayStart(day) + DAY_MS, end);
    return {
      day,
      jobs: channelRuns.filter((r) => within(runAt(r)) && jstDayKey(runAt(r)) === day).length,
      autonomous: mine.length,
      starts: count('starts'),
      patrol: count('patrol'),
      recoveries: count('recoveries'),
      cap,
      cappedAt: capped,
      stoppedMin: capped === null ? null : minutesOf(Math.max(0, stopEnd - capped)),
    };
  });

  // ④ 配備と作者待ち (今の状態)
  const deploy = deployStatus({ boots, git, root, cwd, baseBranch: autonomy.baseBranch });
  const open = (Array.isArray(inbox) ? inbox : [])
    .filter((e) => e && e.channel === channel && (e.closedAt === null || e.closedAt === undefined));
  const oldest = open.map((e) => finite(e.openedAt)).filter((at) => at !== null)
    .reduce((min, at) => (min === null || at < min ? at : min), null);

  return {
    channel,
    at: now,
    since,
    until: end,
    days,
    cap,
    patrol: { groups: groups.map(({ botKey, label }) => ({ botKey, label })), days: patrolDays },
    stages,
    daily,
    deploy,
    inbox: { open: open.length, oldestAt: oldest, oldestMin: oldest === null ? null : minutesOf(Math.max(0, now - oldest)) },
  };
}

/** summarizeLoop の結果 → --json の形 (時刻は +09:00 の ISO、暦日は JST) */
export function loopReportJson(summary) {
  const deploy = summary.deploy.status === 'ok'
    ? { ...summary.deploy, boot: { ...summary.deploy.boot, at: isoJst(summary.deploy.boot.at) }, oldestAt: isoJst(summary.deploy.oldestAt) }
    : summary.deploy;
  return {
    ...summary,
    at: isoJst(summary.at),
    since: isoJst(summary.since),
    until: isoJst(summary.until),
    daily: summary.daily.map((d) => ({ ...d, cappedAt: isoJst(d.cappedAt) })),
    deploy,
    inbox: { ...summary.inbox, oldestAt: isoJst(summary.inbox.oldestAt) },
  };
}

/** 所要の表示: 60 分未満は分、48 時間未満は時間、それより長ければ日 (小数 1 桁)。無ければ — */
function duration(min) {
  if (min === null) return '—';
  if (min < 60) return `${min.toFixed(1)} 分`;
  return min < 48 * 60 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} 日`;
}

const mmdd = (day) => day.slice(5);
const hhmm = (ms) => formatJst(ms, { label: false }).slice(11);

/**
 * 文の上限に収める。超えたら行の単位で後ろから落とし、切ったことを最後の行に書く
 * (黙って切ると、企画は無い行を 0 と読む)。上限ちょうどは切らない
 */
export function fitReport(text, max = LOOP_REPORT_MAX_CHARS) {
  if (text.length <= max) return text;
  const marker = `…(${max} 字で切った — 期間を縮めるか --json で全部)`;
  const lines = text.split('\n');
  while (lines.length > 0 && lines.join('\n').length + 1 + marker.length > max) lines.pop();
  return lines.length === 0 ? marker.slice(0, max) : [...lines, marker].join('\n');
}

/** summarizeLoop の結果 → 人が読む文 (LOOP_REPORT_MAX_CHARS 以内)。並びは毎回同じ */
export function formatLoopReport(summary) {
  const { days } = summary;
  const span = days.length === 0 ? '(期間なし)' : `${mmdd(days[0])}〜${mmdd(days.at(-1))}`;
  const lines = [`回し方の成績 #${summary.channel} ${span} JST (集計 ${formatJst(summary.at)})`];

  const label = new Map(summary.patrol.groups.map((g) => [g.botKey, g.label]));
  lines.push('① 巡回 (本数・空 = 提案 0 件の本数・tool 合計/中央値。n = tool の記録のある本数)');
  if (summary.patrol.groups.length === 0) lines.push('巡回の bot が設定されていない');
  for (const { day, groups } of summary.patrol.days) {
    if (summary.patrol.groups.length === 0) break;
    const cells = groups.map((g) => {
      if (g.jobs === 0) return `${label.get(g.botKey)} 0`;
      // 1900 字に収めるため tool の語は凡例だけに書く。記録の無い job があれば n (記録のある本数) を添える
      const tool = g.toolCalls.n === 0 ? '—'
        : `${g.toolCalls.sum}/${round1(g.toolCalls.median)}${g.toolCalls.n < g.jobs ? ` (n${g.toolCalls.n})` : ''}`;
      return `${label.get(g.botKey)} ${g.jobs}・空 ${g.idle}・${tool}`;
    });
    lines.push(`${mmdd(day)} ${cells.join(' | ')}`);
  }

  const s = summary.stages;
  if (s.merged === 0) {
    lines.push('② 段の待ち: 期間内に merged 0 件 — 出せない');
  } else {
    const stage = (key, name) => `${name} ${duration(s[key].medianMin)}${s[key].n < s.merged ? ` (n${s[key].n})` : ''}`;
    lines.push(
      `② 段の待ち (期間内に merged ${s.merged} 件の中央値)`,
      `${STAGES.map(([key, name]) => stage(key, name)).join(' / ')} / 差し戻し ${s.sendBacks} 回`
      + ` / merge→次の起票 ${duration(s.nextFiling.medianMin)} (${s.nextFiling.n} 件)`,
    );
  }

  lines.push(`③ 日次 (自律起動 = 着手+巡回+自動復旧 / 上限 ${summary.cap}。記録から数え直し・発議は含まない)`);
  for (const d of summary.daily) {
    const stop = d.cappedAt === null ? '' : ` ${hhmm(d.cappedAt)} から ${duration(d.stoppedMin)} 止まった`;
    lines.push(`${mmdd(d.day)} job ${d.jobs} / 自律 ${d.autonomous}/${d.cap} (着手 ${d.starts}・巡回 ${d.patrol}・復旧 ${d.recoveries})${stop}`);
  }

  const dep = summary.deploy;
  if (dep.status === 'not-applicable') {
    lines.push('④ 配備: このチャンネルのリポジトリはブリッジ本体ではない — 対象外');
  } else if (dep.status === 'unreadable') {
    lines.push(`④ 配備: ${dep.reason}`);
  } else {
    const boot = `起動 ${dep.boot.at === null ? '時刻不明' : formatJst(dep.boot.at)} の ${dep.boot.head.slice(0, 7)}`;
    lines.push(dep.pending === 0
      ? `④ 配備: ${boot} は ${dep.baseBranch} の merge に追いついている`
      : `④ 配備: ${boot} から ${dep.baseBranch} へ未配備の merge ${dep.pending} 本・最古 ${dep.oldestAt === null ? '時刻不明' : formatJst(dep.oldestAt)}`);
  }
  const box = summary.inbox;
  lines.push(box.open === 0
    ? '受信箱: 開いた用件 0 件'
    : `受信箱: 開いた用件 ${box.open} 件・最古 ${duration(box.oldestMin)}${box.oldestAt === null ? '' : ` (${formatJst(box.oldestAt)} から)`}`);
  return fitReport(lines.join('\n'));
}
