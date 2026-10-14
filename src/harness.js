// ハーネスの版と成績 — arXiv 2609.35738 (Harness Learning) の「ハーネスの改訂を測り、点が上がった
// ものだけを残す」を communitd に写したもの (docs/notes/2026-10-12-harness-learning.md)。
//
// エージェントはモデルとハーネス (モデルの呼び出し・道具・情報の流れを組むもの) の組で決まる。
// communitd で bot ごとのハーネスに当たるのは、job ごとに読み直す役割文 (roles/_common.md + 自分の
// 役割文) と runtime / model / effort。論文は実行のフィードバック (点 + 失敗の抜粋) を読んだ提案役が
// ハーネスを 1 か所ずつ書き換え、親より点が上がった改訂だけを残す。
//
// **ここは測る側だけ** — 版の指紋・版ごとの集計・前の版との判定・巡回を起こすかの門。改訂するか・
// 何を直すかは bot が決める (docs/social-engineering.md §3.11「検出は決定論、判断は agentic」)。
// 時計は読まず (`now` を受ける)、ファイルにも書かない。

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { REVIEW_EVIDENCE_NOTE_PREFIX } from './board.js';
import { DEFAULT_HARNESS_MIN_RUNS } from './config.js';
import { isReplayTask } from './scheduler.js';
import { parseReviewEvidence } from './review-evidence.js';
import { JST_LABEL, formatJst } from './time.js';

/** 版の指紋の長さ (sha256 の 16 進の先頭)。台帳と表示で読める長さ — 役割文の版の数では衝突しない */
const REV_LENGTH = 12;

/** 指紋を記録する前の job をまとめた基準の版 (改訂の効き目を測る最初の比較相手) */
export const BASELINE_REV = '記録前';

/**
 * 新しい版の計測を待つ上限。これを過ぎても job が足りない版は待たない — 使われない bot の版で
 * 巡回が止まり続けないように (仮置き)。
 */
export const HARNESS_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 悪化 / 改善と言う境目 (2 群の比率の差の z)。標準正規の片側 5% 点 1.645 を借りた目安で、
 * job は独立な試行ではないので検定の意味は持たせない — 「たまたまの揺れでは説明しにくい差」の線引き。
 */
export const HARNESS_Z = 1.645;

/** ハーネスの問題として数える終わり方 */
const PROBLEM_OUTCOMES = new Set(['verify-failed', 'failed', 'not-started']);

/**
 * 数えない終わり方 — 人間の停止・再起動・配送の失敗・ブリッジ自身の例外・不明は、
 * ハーネスの良し悪しと関係なく起きる。分母にも分子にも入れない。
 * ただし `aborted` のうちブリッジが時間切れで止めたもの (stopKind: timeout) は問題に数える。
 */
const IGNORED_OUTCOMES = new Set(['aborted', 'stopped', 'cancelled', 'deliver-failed', 'internal-error', 'unknown']);

const asText = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
};

const roleOf = (label) => {
  const file = typeof label === 'string' ? label.trim() : '';
  return file === '' ? null : basename(file).replace(/\.[^.]+$/, '');
};

const msOf = (iso) => {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * job を動かしたハーネスの指紋 (純粋)。
 *
 * **役割文は job が実際に読んだ本文を渡す** — ファイルを読み直すと、読んだ後に書き換わった版を
 * 指してしまう。改行は LF に揃えてから数える (作業ツリーの改行設定で版が割れないように)。
 * runtime / model / effort も版に含める — effort を上げるのもハーネスの改訂。
 *
 * @param {{sources?: Array<{label: string, text: string, own?: boolean}>, runtime?: string|null,
 *          model?: string|null, effort?: string|null}} p
 * @returns {{rev: string, role: string|null, files: string[], runtime: string|null,
 *            model: string|null, effort: string|null}}
 */
export function harnessFingerprint({ sources = [], runtime = null, model = null, effort = null } = {}) {
  const hash = createHash('sha256');
  const files = [];
  let role = null;
  for (const src of Array.isArray(sources) ? sources : []) {
    const label = String(src?.label ?? '');
    files.push(label);
    if (src?.own === true) role = roleOf(label);
    hash.update(`${label}\0${String(src?.text ?? '').replace(/\r\n/g, '\n')}\0`);
  }
  const knobs = { runtime: asText(runtime), model: asText(model), effort: asText(effort) };
  hash.update(JSON.stringify(knobs));
  return { rev: hash.digest('hex').slice(0, REV_LENGTH), role, files, ...knobs };
}

/** 提出 = そのタスクで `next: reviewer` で終わった job */
const isSubmission = (run) => run.next === 'reviewer' && run.taskId !== null && run.taskId !== undefined;

/**
 * レビューの遷移 (review → …) を、その提出をした job へ結びつける (純粋)。
 * `accepts(entry)` が真の履歴 entry ごとに、entry の時刻以前に終わったそのタスクの最後の提出 1 本へ結ぶ。
 * 1 本の job に 2 つ結んだら先の entry を使う
 *
 * @returns {Map<string, object>} job id → 結んだ履歴 entry
 */
function bindReviewEntries(runs, tasks, accepts) {
  const byTask = new Map();
  for (const run of runs) {
    if (!isSubmission(run)) continue;
    const key = String(run.taskId);
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(run);
  }
  const out = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const submitted = byTask.get(String(task?.id ?? ''));
    if (!submitted) continue;
    for (const entry of Array.isArray(task.history) ? task.history : []) {
      if (entry?.from !== 'review' || !accepts(entry)) continue;
      const at = msOf(entry.at);
      if (at === null) continue;
      let last = null;
      for (const run of submitted) {
        const ended = msOf(run.endedAt);
        if (ended !== null && ended <= at && (last === null || ended >= msOf(last.endedAt))) last = run;
      }
      if (last && !out.has(last.id)) out.set(last.id, entry);
    }
  }
  return out;
}

/**
 * レビューでの差し戻し / 封鎖を、その提出をした job へ結びつける (純粋)。
 * 差し戻し (review → in-progress) と封鎖 (review → blocked) の直前の提出を探す。
 *
 * @returns {Map<string, string>} job id → 差し戻しの理由 (履歴の note。無ければ空文字)
 */
function sentBackRuns(runs, tasks) {
  const bound = bindReviewEntries(runs, tasks, (entry) => entry.to === 'in-progress' || entry.to === 'blocked');
  return new Map([...bound].map(([id, entry]) => [id, String(entry.note ?? '').trim()]));
}

/**
 * merge (review → merged) を、その提出をした job へ結びつける (純粋)。結び方は sentBackRuns と同じなので、
 * 差し戻しの前に提出が 2 本あったときの古い方はどちらにも結ばれない (レビュー中と同じに扱う)。
 * merge の note は読まない — 指摘の件数は entry の `remarks` (src/bridge/board.js が historyExtra で置く)
 *
 * @returns {Map<string, unknown>} job id → entry の remarks (そのまま。鍵の無い entry は undefined)
 */
function mergedRuns(runs, tasks) {
  const bound = bindReviewEntries(runs, tasks, (entry) => entry.to === 'merged');
  return new Map([...bound].map(([id, entry]) => [id, entry.remarks]));
}

/**
 * 提出 1 本を「1 回で通った」の内訳へ数える (純粋)。通った = verify 1 回・差し戻し / 封鎖なし・merge 時の指摘 0。
 * 分からないものは 0 と読まず分母 (measured) から外す — verify の回数が 1 以上の整数でない・レビュー中
 * (差し戻しも merge も無い)・merge の entry の remarks が 0 以上の整数でない (鍵の無い古い merge)。
 * 差し戻し / 封鎖は指摘を見ずに通らなかった側。重なり (再試行 + 指摘など) は各々に数える。
 * 差し戻しの定義は版の sentBack と同じ (封鎖を含む) だが、verify の回数の無い提出を外すぶん本数は版の sentBack 以下
 */
function countFirstPass(tally, run, sentBack, merged) {
  const attempts = run.evidence?.verifyAttempts;
  if (!Number.isSafeInteger(attempts) || attempts < 1) return;
  const back = sentBack.has(run.id);
  // merge に結ばれていない提出 (レビュー中) も、remarks の鍵の無い merge も undefined
  const remarks = back ? null : merged.get(run.id);
  if (!back && !(Number.isSafeInteger(remarks) && remarks >= 0)) return;
  tally.measured += 1;
  if (attempts > 1) tally.retried += 1;
  if (back) {
    tally.sentBack += 1;
    return;
  }
  if (remarks > 0) tally.remarked += 1;
  if (attempts === 1 && remarks === 0) tally.passed += 1;
}

/** 1 本の job の数え方: 'problem' / 'fine' / null (数えない) */
function judgeRun(run, sentBack) {
  if (run.stage !== 'ended') return null;
  if (sentBack.has(run.id)) return 'problem';
  if (run.outcome === 'aborted' && run.stopKind === 'timeout') return 'problem';
  if (IGNORED_OUTCOMES.has(run.outcome)) return null;
  if (PROBLEM_OUTCOMES.has(run.outcome)) return 'problem';
  return run.outcome === 'ok' ? 'fine' : null;
}

const startedMs = (run) => msOf(run.startedAt) ?? msOf(run.acceptedAt);

/**
 * 重さを分ける job 種別 (表示の順)。版の前後で仕事の混ざり方が変わっても比べられるように分ける。
 * 実行記録に duty の印は無いので、契約の種類と taskId だけで分ける (無い印は発明しない)
 */
export const JOB_KINDS = Object.freeze(['task-work', 'review', 'approval', 'other']);

/** job 種別 (純粋)。レビュー / 承認の job も taskId を持つので、契約の種類を先に見る */
export function jobKindOf(run) {
  const kind = run.contract?.kind;
  if (kind === 'task-review') return 'review';
  if (kind === 'task-approval') return 'approval';
  return run.taskId === null || run.taskId === undefined ? 'other' : 'task-work';
}

/**
 * job 1 本の重さ (純粋): tool 呼び出し (記録の無い job は null) と所要分 (起動 → 終端)。
 * 所要は起動と終端の両方があるときだけ — 起動できなかった job を受付の時刻で補うと 0 分が混ざる。
 * 終端が起動より前の記録 (時計の狂い) も外す
 */
function weightOf(run) {
  const calls = run.evidence?.toolCalls;
  const started = msOf(run.startedAt);
  const ended = msOf(run.endedAt);
  return {
    toolCalls: Number.isSafeInteger(calls) && calls >= 0 ? calls : null,
    minutes: started !== null && ended !== null && ended >= started ? (ended - started) / 60_000 : null,
  };
}

const emptyWeights = () => Object.fromEntries(JOB_KINDS.map((kind) => [kind, { jobs: 0, toolCalls: [], minutes: [] }]));

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 版の重さ: 種別ごとの job 数と、tool 呼び出し・所要分の中央値 (n = 中央値を取った本数)。種別は 0 本でも欄を置く */
function costOf(weights) {
  return Object.fromEntries(JOB_KINDS.map((kind) => {
    const w = weights[kind];
    return [kind, {
      jobs: w.jobs,
      toolCalls: { n: w.toolCalls.length, median: median(w.toolCalls) },
      minutes: { n: w.minutes.length, median: median(w.minutes) },
    }];
  }));
}

const ratioOf = (now, before) => (typeof now === 'number' && typeof before === 'number' && before > 0 ? now / before : null);

/**
 * 今の版 ← 前の版 (判定と同じ前の版) の重さの中央値と比 (純粋)。どちらかの版に job のある種別だけ。
 * **判定・門・問題の数え方には使わない** — 重さを点にすると軽く済ませる方へ寄る
 */
function costCompare(current, previous) {
  const side = (rev, kind, key) => (rev ? rev.cost[kind][key].median : null);
  return JOB_KINDS.map((kind) => ({
    kind,
    jobs: { current: current ? current.cost[kind].jobs : 0, previous: previous ? previous.cost[kind].jobs : null },
    ...Object.fromEntries(['toolCalls', 'minutes'].map((key) => {
      const now = side(current, kind, key);
      const before = side(previous, kind, key);
      return [key, { current: now, previous: before, ratio: ratioOf(now, before) }];
    })),
  })).filter((c) => c.jobs.current > 0 || (c.jobs.previous ?? 0) > 0);
}

/**
 * review 遷移の note に残ったレビューの証拠を、その提出をした job へ結びつける (純粋)。
 * 拾うのは to が review で note がレビューの証拠の頭で始まる entry。結ぶ先は entry.by の bot が
 * entry.at より前に**始めた**、そのタスクの最後の job (証拠は提出した job が終わってから測るので、
 * 遷移より前に始まっている)。差し戻しの後の周回は、その周回の遷移より前の最後の job へ結ぶ。
 * `runs` は開始時刻の順。1 本の job に 2 つ結んだら先の entry を使う (sentBackRuns と同じ)
 *
 * @returns {Map<string, object>} job id → parseReviewEvidence の戻り
 */
function evidenceRuns(runs, tasks) {
  const byTask = new Map();
  for (const run of runs) {
    if (run.taskId === null || run.taskId === undefined) continue;
    const key = String(run.taskId);
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(run);
  }
  const out = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskRuns = byTask.get(String(task?.id ?? ''));
    if (!taskRuns) continue;
    for (const entry of Array.isArray(task.history) ? task.history : []) {
      if (entry?.to !== 'review' || typeof entry.note !== 'string') continue;
      if (!entry.note.startsWith(REVIEW_EVIDENCE_NOTE_PREFIX)) continue;
      const at = msOf(entry.at);
      if (at === null) continue;
      let last = null;
      for (const run of taskRuns) {
        if (run.botKey === entry.by && startedMs(run) < at) last = run;
      }
      if (last && !out.has(last.id)) {
        out.set(last.id, parseReviewEvidence(entry.note.slice(REVIEW_EVIDENCE_NOTE_PREFIX.length)));
      }
    }
  }
  return out;
}

/** 証拠の種類 → 版の集計のキー (読めない種類は unknown) */
const EVIDENCE_KEYS = Object.freeze({
  measured: 'measured', 'no-src': 'noSrc', 'no-tests': 'noTests', unmeasured: 'unmeasured',
});

/** 差し戻された提出は tally.sentBack の同じキーにも数える */
function countEvidence(tally, parsed, sentBack) {
  const keys = [
    'submissions',
    EVIDENCE_KEYS[parsed.kind] ?? 'unknown',
    ...(parsed.kind === 'measured' && parsed.passes > 0 ? ['withPasses'] : []),
    ...(parsed.kind === 'measured' && parsed.fails > 0 && parsed.loadFailedFiles === parsed.fails ? ['allLoadFailed'] : []),
    ...(parsed.deletedFiles > 0 || parsed.vanishedNames > 0 ? ['withDeleted'] : []),
  ];
  for (const key of keys) {
    tally[key] += 1;
    if (sentBack) tally.sentBack[key] += 1;
  }
}

const emptyEvidence = () => ({
  submissions: 0, measured: 0, withPasses: 0, allLoadFailed: 0, noSrc: 0, noTests: 0, unmeasured: 0, unknown: 0, withDeleted: 0,
});

function emptyRev(rev, harness = null) {
  return {
    rev,
    role: harness?.role ?? null,
    files: Array.isArray(harness?.files) ? harness.files.map(String) : [],
    runtime: harness?.runtime ?? null,
    model: harness?.model ?? null,
    effort: harness?.effort ?? null,
    firstAt: null,
    lastAt: null,
    runs: 0,
    problems: 0,
    submissions: 0,
    sentBack: 0,
    // 問題の出た job のタスク (改訂の台帳が「狙った失敗が再発したか」を読む材料)。同じタスクは 1 回、終わり方は最初のもの
    problemTasks: [],
    // この版の最初の job の直前に、同じ bot で動いていた job の版と開始時刻 (改訂の台帳が merge と結ぶ)
    parentRev: null,
    parentStartAt: null,
    // 証拠の付いた提出の内訳。withPasses = measured のうち変更前の src でも落ちないテストがあったもの。
    // allLoadFailed = measured のうち「落ちる」が 1 以上で、それが全部基点で読み込めず (アサーションを走らせずに落ちた) のもの。
    // withDeleted = 種類を問わず、テストを消した (消したファイル・消えた名前が 1 以上の) もの。
    // sentBack = そのうちレビューで差し戻された / 封鎖された提出 (キーは同じ)
    evidence: { ...emptyEvidence(), sentBack: emptyEvidence() },
    // 重さ (種別ごとの tool 呼び出し・所要分の中央値)。数えるのは runs に数えた job と同じもの。判定には使わない
    cost: costOf(emptyWeights()),
    // 提出が 1 回で通ったか (countFirstPass)。measured = 分母、passed 以外の 3 つは重なりを各々に数える。判定には使わない
    firstPass: { measured: 0, passed: 0, retried: 0, remarked: 0, sentBack: 0 },
  };
}

/**
 * 2 つの版の比較 (純粋)。z は「新しい版の問題率 − 前の版の問題率」を合算した率の標準誤差で割ったもの。
 * @returns {{verdict: 'improved'|'worse'|'flat'|'undetermined', z: number|null}}
 */
export function compareRevs(current, previous, { minRuns = DEFAULT_HARNESS_MIN_RUNS } = {}) {
  if (!current || !previous) return { verdict: 'undetermined', z: null };
  if (current.runs < minRuns || previous.runs < minRuns) return { verdict: 'undetermined', z: null };
  const p1 = previous.problems / previous.runs;
  const p2 = current.problems / current.runs;
  const pooled = (previous.problems + current.problems) / (previous.runs + current.runs);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / previous.runs + 1 / current.runs));
  if (se === 0) return { verdict: 'flat', z: 0 };
  const z = (p2 - p1) / se;
  if (z >= HARNESS_Z) return { verdict: 'worse', z };
  if (z <= -HARNESS_Z) return { verdict: 'improved', z };
  return { verdict: 'flat', z };
}

/**
 * 実行記録 + ボード → bot ごとの版の成績と判定 (純粋)。
 *
 * - **bot ごとに見る** — 同じ役割文でも bot ごとに仕事の混ざり方が違うので、版の前後は同じ bot の
 *   中で比べる。版は「その bot の今の版」と「今の版が最後に始まる直前に動いていた版」を比べる
 *   (改訂を戻して前の版に帰ったら、その版の過去の分も同じハーネスの成績として足す)
 * - 指紋の無い job は、その bot で最初に指紋が付いた job より前なら基準の版 (`記録前`) へ、
 *   後なら版の分からない job (役割文を読む前に断られた等) として件数だけ数える
 * - 問題 = verify NG・実行エラー・起動できず・時間切れ、または提出がレビューで差し戻された / 封鎖された
 * - 版ごとに、提出に付いたレビューの証拠 (review 遷移の note) の内訳も数える (`evidence`)。
 *   種類ごとに、その提出が差し戻された / 封鎖された本数も数える (`evidence.sentBack`)。
 *   「落ちる」が全部基点で読み込めずの measured は `evidence.allLoadFailed` にも、
 *   テストを消した提出は種類と別に `evidence.withDeleted` にも数える。
 *   問題の数え方には使わない — 証拠の付いた提出がレビューでどう判定されたかを読むための材料
 * - 版ごとに、job 種別 (`JOB_KINDS`) の tool 呼び出しと所要分の中央値も数え (`cost`)、bot ごとに今の版 ← 前の版の
 *   中央値と比を出す (`bot.cost`)。**判定・門・問題の数え方には使わない** — 問題率が天井に張り付いて「同等」しか
 *   出ないときに、重さの変化を読むために添えるだけ
 * - 版ごとに、提出が 1 回で通った (verify 1 回・差し戻しなし・merge 時の指摘 0) 本数と内訳も数える (`firstPass`)。
 *   分からない提出は分母から外す (countFirstPass)。**判定・門・問題の数え方には使わない** — 重さと同じく添えるだけ
 * - **解き直し (src/replay.js) の job は数えない** — 下書きの役割文で走るので指紋は merge 後の版と同じになり、
 *   数えると merge より前に始まった版に見えて台帳の結び付けが崩れ、本番の成績に解き直しの失敗が混ざる
 *
 * @param {object[]} runs 実行記録 (data/job-runs.json の値)
 * @param {{tasks?: object[], minRuns?: number, channel?: string|null}} [opts]
 * @returns {{bots: object[], excerpts: object[], from: string|null, to: string|null, total: number}}
 */
export function summarizeHarness(runs, { tasks = [], minRuns = DEFAULT_HARNESS_MIN_RUNS, channel = null } = {}) {
  const replays = new Set((Array.isArray(tasks) ? tasks : []).filter(isReplayTask).map((task) => String(task.id)));
  const readable = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && typeof run === 'object' && typeof run.botKey === 'string' && run.id)
    .filter((run) => run.taskId === null || run.taskId === undefined || !replays.has(String(run.taskId)))
    .filter((run) => startedMs(run) !== null)
    .sort((a, b) => startedMs(a) - startedMs(b) || String(a.id).localeCompare(String(b.id)));
  const list = channel === null ? readable : readable.filter((run) => run.channelName === channel);
  const sentBack = sentBackRuns(list, tasks);
  const merged = mergedRuns(list, tasks);
  // 証拠は channel で絞る前の記録で結ぶ (数えるのは絞った側の job だけ)。絞った後で結ぶと、別 channel の
  // job で書かれた証拠が、絞った側に残る同じタスクの前の job へ寄る
  const evidences = evidenceRuns(readable, tasks);

  const byBot = new Map();
  for (const run of list) {
    if (!byBot.has(run.botKey)) byBot.set(run.botKey, []);
    byBot.get(run.botKey).push(run);
  }

  const excerpts = [];
  const bots = [];
  let total = 0;
  for (const [botKey, botRuns] of [...byBot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const firstStamped = botRuns.find((run) => asText(run.harness?.rev));
    const firstStampedAt = firstStamped ? startedMs(firstStamped) : Infinity;
    const revs = new Map();
    const timeline = []; // 版の分かる job の版を時刻順に (前の版を探すのに使う)
    const runStarts = []; // 数えた job の開始時刻 (ms)。門が「いま動いている bot か」を見るのに使う
    const weights = new Map(); // 版 → 種別ごとの重さの標本 (版の runs に数えた job だけ)
    let unattributed = 0;
    for (const run of botRuns) {
      const judged = judgeRun(run, sentBack);
      if (judged === null) continue;
      const stamped = asText(run.harness?.rev);
      let rev = stamped;
      if (!rev) {
        if (startedMs(run) >= firstStampedAt) {
          unattributed += 1;
          if (judged === 'problem') excerpts.push(excerptOf(run, null, sentBack));
          continue;
        }
        rev = BASELINE_REV;
      }
      if (!revs.has(rev)) {
        const created = emptyRev(rev, stamped ? run.harness : null);
        if (timeline.length > 0) {
          created.parentRev = timeline[timeline.length - 1];
          created.parentStartAt = new Date(runStarts[runStarts.length - 1]).toISOString();
        }
        revs.set(rev, created);
      }
      const entry = revs.get(rev);
      const at = run.startedAt ?? run.acceptedAt;
      entry.firstAt ??= at;
      entry.lastAt = at;
      entry.runs += 1;
      if (!weights.has(rev)) weights.set(rev, emptyWeights());
      const weight = weightOf(run);
      const kindWeights = weights.get(rev)[jobKindOf(run)];
      kindWeights.jobs += 1;
      if (weight.toolCalls !== null) kindWeights.toolCalls.push(weight.toolCalls);
      if (weight.minutes !== null) kindWeights.minutes.push(weight.minutes);
      if (judged === 'problem') {
        entry.problems += 1;
        const taskId = run.taskId === null || run.taskId === undefined ? null : String(run.taskId);
        if (taskId !== null && !entry.problemTasks.some((p) => p.taskId === taskId)) {
          entry.problemTasks.push({ taskId, outcome: sentBack.has(run.id) ? 'sent-back' : run.outcome });
        }
      }
      if (isSubmission(run)) {
        entry.submissions += 1;
        countFirstPass(entry.firstPass, run, sentBack, merged);
      }
      if (sentBack.has(run.id)) entry.sentBack += 1;
      if (evidences.has(run.id)) countEvidence(entry.evidence, evidences.get(run.id), sentBack.has(run.id));
      timeline.push(rev);
      runStarts.push(startedMs(run));
      total += 1;
      if (judged === 'problem') excerpts.push(excerptOf(run, rev, sentBack));
    }
    if (timeline.length === 0 && unattributed === 0) continue;
    for (const [rev, entry] of revs) entry.cost = costOf(weights.get(rev));

    // 前の版 = 今の版の前に動いていた版のうち、いちばん近い**測り終えた** (minRuns 本以上の) 版。
    // すぐ戻した改訂や手で入れた小さな版を親にすると、比較が未確定のまま動かなくなる。
    // 測り終えた版が無ければ、すぐ前の版 (判定は未確定になる)
    const currentRev = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    let previousRev = null;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const rev = timeline[i];
      if (rev === currentRev || rev === previousRev) continue;
      previousRev ??= rev;
      if (revs.get(rev).runs >= minRuns) {
        previousRev = rev;
        break;
      }
    }
    const current = currentRev ? revs.get(currentRev) : null;
    const previous = previousRev ? revs.get(previousRev) : null;
    const compared = previous
      ? compareRevs(current, previous, { minRuns })
      : { verdict: 'baseline', z: null };
    bots.push({
      botKey,
      role: current?.role ?? null,
      current,
      previous,
      verdict: compared.verdict,
      z: compared.z,
      cost: costCompare(current, previous),
      unattributed,
      runStarts,
      revs: [...revs.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
    });
  }

  excerpts.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const stamps = list.map((run) => run.startedAt ?? run.acceptedAt);
  return {
    bots,
    excerpts,
    total,
    from: stamps.length > 0 ? stamps[0] : null,
    to: stamps.length > 0 ? stamps[stamps.length - 1] : null,
  };
}

function excerptOf(run, rev, sentBack) {
  const note = sentBack.get(run.id);
  return {
    at: run.startedAt ?? run.acceptedAt,
    runId: String(run.id),
    botKey: run.botKey,
    rev,
    taskId: run.taskId ?? null,
    channel: run.channelName ?? null,
    outcome: note !== undefined ? 'sent-back' : run.outcome,
    detail: String(note !== undefined ? note : (run.stageDetail || run.reason || '')).replace(/\s+/g, ' ').trim(),
    next: run.next ?? null,
  };
}

/**
 * 改訂の巡回を起こしてよいか (純粋)。**測り終えていない改訂があるうちは起こさない** —
 * 論文の改訂は「1 つ直す → 測る → 残すか戻す」の順で、測る前に重ねると何が効いたか分からなくなる。
 *
 * - 待つ (pending) = 今の版の job が `minRuns` に届いていない bot。ただし (a) 前の版が無い
 *   (初めての計測) と (b) 直近 `maxWaitMs` に `minRuns` 本も動いていない bot (たまにしか呼ばれない
 *   提案役など — 待つと巡回が丸ごと止まる) と (c) 版が始まって `maxWaitMs` 過ぎた bot は待たない
 * - 起こす = 待つ bot が居らず、記録した (記録前ではない) 今の版が `minRuns` 本以上の bot が 1 体以上いる
 *
 * @returns {{due: boolean, pending: string[], worse: string[], reason: string}}
 */
export function harnessGate(summary, {
  now, minRuns = DEFAULT_HARNESS_MIN_RUNS, maxWaitMs = HARNESS_MAX_WAIT_MS,
} = {}) {
  const at = typeof now === 'number' ? now : Date.parse(String(now ?? ''));
  const bots = Array.isArray(summary?.bots) ? summary.bots : [];
  const pending = [];
  const worse = [];
  let measured = 0;
  for (const bot of bots) {
    if (bot.verdict === 'worse') worse.push(bot.botKey);
    const current = bot.current;
    // **記録前は測り終えた版に数えない。** 数えると再起動の直後に巡回が立ち、改訂が merge される頃には
    // 再起動後の最初の版 (中身は記録前と同じ) がまだ数本しかなく、以後の比較の親が測れないまま残る
    if (current && current.rev !== BASELINE_REV && current.runs >= minRuns) measured += 1;
    if (!current || current.runs >= minRuns || !bot.previous) continue;
    const recent = (Array.isArray(bot.runStarts) ? bot.runStarts : [])
      .filter((ms) => Number.isFinite(at) && at - ms < maxWaitMs).length;
    if (recent < minRuns) continue;
    const started = msOf(current.firstAt);
    if (started !== null && Number.isFinite(at) && at - started >= maxWaitMs) continue;
    pending.push(bot.botKey);
  }
  if (pending.length > 0) {
    return { due: false, pending, worse, reason: `改訂の計測中 (${pending.join(' / ')} の今の版が ${minRuns} 本に届いていない)` };
  }
  if (measured === 0) {
    return { due: false, pending, worse, reason: `判定できる版が無い (記録した今の版が ${minRuns} 本に届いた bot が居ない)` };
  }
  return { due: true, pending, worse, reason: worse.length > 0 ? `悪化: ${worse.join(' / ')}` : '計測済み' };
}

/** 改訂の台帳に載せる改訂の数の既定 (新しい順) */
export const LEDGER_MAX = 5;

const isRoleFile = (file) => String(file).replaceAll('\\', '/').startsWith('roles/');

/**
 * 役割文を触った merge 済みのタスク = ハーネスの改訂 (純粋)。merge の時刻はボードの履歴の
 * merged への遷移 (戻して入れ直したタスクは最後の merge)。新しい順。
 */
function roleRevisions(tasks) {
  const out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const files = (Array.isArray(task?.touch) ? task.touch : []).map((f) => String(f).replaceAll('\\', '/')).filter(isRoleFile);
    if (files.length === 0) continue;
    const merges = (Array.isArray(task.history) ? task.history : [])
      .filter((h) => h?.to === 'merged')
      .map((h) => msOf(h.at))
      .filter((ms) => ms !== null);
    if (merges.length === 0) continue;
    const mergedMs = Math.max(...merges);
    out.push({
      taskId: String(task.id),
      title: String(task.title ?? '').trim(),
      rationale: String(task.rationale ?? '').trim(),
      files,
      mergedAt: new Date(mergedMs).toISOString(),
      mergedMs,
    });
  }
  return out.sort((a, b) => b.mergedMs - a.mergedMs);
}

/**
 * 改訂の台帳 (純粋)。arXiv 2610.02616 (VERSE) の訓練の監査 — どの改訂で何が直り、何が後で戻ったかを
 * ラウンドをまたいで追う — を写したもの (docs/notes/2026-10-13-verse.md)。
 *
 * 改訂タスクごとに、その merge で始まった版を bot ごとに並べる。版 V を改訂 R が始めたと言うのは、
 * 同じ bot で V の直前の job が R の merge より前に始まり、V の最初の job が merge の後に始まり、
 * V が読んだ役割文に R の触った役割文が入っているとき。**事実だけを並べる** — 狙いが当たったか
 * (狙った失敗が再発したか・別の失敗が出たか) は提案役が抜粋と手順を読んで判断する (§3.11)。
 *
 * @param {object} summary summarizeHarness の戻り
 * @param {object[]} tasks ボードのタスク
 * @returns {Array<{taskId: string, title: string, rationale: string, files: string[], mergedAt: string,
 *   effects: Array<{botKey: string, rev: object, parent: object|null, current: boolean, verdict: string|null, z: number|null}>}>}
 */
export function revisionLedger(summary, tasks, { limit = LEDGER_MAX } = {}) {
  const bots = Array.isArray(summary?.bots) ? summary.bots : [];
  return roleRevisions(tasks).slice(0, Math.max(0, limit)).map(({ mergedMs, ...revision }) => {
    const effects = [];
    for (const bot of bots) {
      for (const rev of bot.revs) {
        if (rev.rev === BASELINE_REV || rev.parentRev === null) continue;
        const first = msOf(rev.firstAt);
        const parentStart = msOf(rev.parentStartAt);
        if (first === null || parentStart === null || !(parentStart < mergedMs && mergedMs <= first)) continue;
        if (!rev.files.some((f) => revision.files.includes(f.replaceAll('\\', '/')))) continue;
        const current = bot.current?.rev === rev.rev;
        effects.push({
          botKey: bot.botKey,
          rev,
          parent: bot.revs.find((x) => x.rev === rev.parentRev) ?? null,
          current,
          verdict: current ? bot.verdict : null,
          z: current ? bot.z : null,
        });
      }
    }
    return { ...revision, effects };
  });
}

const VERDICT_LABELS = Object.freeze({
  baseline: '比較相手なし',
  undetermined: '未確定',
  improved: '改善',
  worse: '悪化',
  flat: '同等',
});

const pct = (rev) => (rev && rev.runs > 0 ? `${Math.round((rev.problems / rev.runs) * 100)}%` : '—');
/**
 * レポートの時刻 `MM-DD HH:MM` (JST)。札は付けない — 見出しで 1 回だけ添える (台帳の行は起動文に載るので幅を変えない)。
 * 読めない値は `?`。scripts/harness-report.mjs の手順の見出しもこれで出す
 */
export const day = (value) => formatJst(value, { label: false })?.slice(5) ?? '?';
const revLabel = (rev) => (rev ? (rev.rev === BASELINE_REV ? BASELINE_REV : `\`${rev.rev}\``) : '—');

/**
 * 版の証拠の内訳 1 行。テストの変更なし・読めない・落ちるが全部読み込めず・消したテストありは 0 なら出さない。
 * 種類ごとに差し戻された本数を「(差し戻し n)」で添える (0 なら添えない)。
 * 落ちるが全部読み込めずはその前、消したテストありは種類をまたぐ数なので末尾に置く (無い版の行は今までと同じ字面)
 */
function evidenceLine(evidence) {
  const part = (label, key) => {
    const back = evidence.sentBack?.[key] ?? 0;
    return `${label} ${evidence[key]}${back > 0 ? ` (差し戻し ${back})` : ''}`;
  };
  const parts = [
    part('落ちないあり', 'withPasses'),
    part('src の差分なし', 'noSrc'),
    part('測れず', 'unmeasured'),
    ...(evidence.noTests > 0 ? [part('テストの変更なし', 'noTests')] : []),
    ...(evidence.unknown > 0 ? [part('読めない', 'unknown')] : []),
    ...(evidence.allLoadFailed > 0 ? [part('落ちるが全部読み込めず', 'allLoadFailed')] : []),
    ...(evidence.withDeleted > 0 ? [part('消したテストあり', 'withDeleted')] : []),
  ];
  return `証拠 提出 ${evidence.submissions} 件 — ${parts.join(' / ')}`;
}

const KIND_LABELS = Object.freeze({ 'task-work': 'task-work', review: 'review', approval: 'approval', other: 'その他' });
const calls = (value) => (typeof value === 'number' ? String(Number(value.toFixed(1))) : '—');
const mins = (value) => (typeof value === 'number' ? value.toFixed(1) : '—');

/**
 * 版の重さ 1 行 (job のある種別だけ)。中央値を取った本数が job 数より少なければ「(n 本)」を添える。
 * 例: `重さ (中央値) task-work 20 本・tool 51・分 16.1 / review 3 本・tool 12 (2 本)・分 2.0`
 */
function costLine(cost) {
  const parts = JOB_KINDS.filter((kind) => cost[kind].jobs > 0).map((kind) => {
    const { jobs, toolCalls, minutes } = cost[kind];
    const n = (side) => (side.n < jobs ? ` (${side.n} 本)` : '');
    return `${KIND_LABELS[kind]} ${jobs} 本・tool ${calls(toolCalls.median)}${n(toolCalls)}・分 ${mins(minutes.median)}${n(minutes)}`;
  });
  return parts.length > 0 ? `重さ (中央値) ${parts.join(' / ')}` : null;
}

/**
 * 版の行に添える「1 回で通った」(測れた提出のある版だけ。無い版の行は今までと同じ字面)。
 * 例: ` / 1 回で通った 12/15 (80%、再試行 2・指摘 1・差し戻し 0)`
 */
function firstPassPart(firstPass) {
  if (!(firstPass?.measured > 0)) return '';
  const { measured, passed, retried, remarked, sentBack } = firstPass;
  return ` / 1 回で通った ${passed}/${measured} (${Math.round((passed / measured) * 100)}%、`
    + `再試行 ${retried}・指摘 ${remarked}・差し戻し ${sentBack})`;
}

/**
 * bot の重さの「今 ← 前」1 行 (前の版がある bot だけ)。
 * 例: `重さ 今 ← 前 (中央値) task-work 20 ← 25 本・tool 51 ← 29 (×1.76)・分 16.1 ← 8.5 (×1.89)`
 */
function costCompareLine(bot) {
  if (!bot.previous || !Array.isArray(bot.cost) || bot.cost.length === 0) return null;
  const pair = (side, format) => `${format(side.current)} ← ${format(side.previous)}${side.ratio !== null ? ` (×${side.ratio.toFixed(2)})` : ''}`;
  const parts = bot.cost.map((c) => `${KIND_LABELS[c.kind]} ${c.jobs.current} ← ${c.jobs.previous} 本・tool ${pair(c.toolCalls, calls)}・分 ${pair(c.minutes, mins)}`);
  return `重さ 今 ← 前 (中央値) ${parts.join(' / ')}`;
}

/**
 * bot ごとの判定 1 行 (巡回の起動メッセージに載せる短い形)。
 * 例: `alpha (worker): 今 \`ab12cd34ef56\` 34 本・問題 9% ← 前 記録前 70 本・13% → 同等 (z -0.62)`
 */
export function verdictLine(bot) {
  const head = `${bot.botKey}${bot.role ? ` (${bot.role})` : ''}`;
  const now = bot.current ? `今 ${revLabel(bot.current)} ${bot.current.runs} 本・問題 ${pct(bot.current)}` : '今の版なし';
  const before = bot.previous ? ` ← 前 ${revLabel(bot.previous)} ${bot.previous.runs} 本・${pct(bot.previous)}` : '';
  const z = typeof bot.z === 'number' ? ` (z ${bot.z.toFixed(2)})` : '';
  return `${head}: ${now}${before} → ${VERDICT_LABELS[bot.verdict] ?? bot.verdict}${z}`;
}

/** 台帳の行で問題の出たタスクを並べる上限 (残りは「ほか n」) */
const LEDGER_MAX_TASKS = 5;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * 台帳の 1 改訂の効き目のうち bot 1 体分 (純粋)。
 * 例: `alpha: \`aaaa\` 26 本・8% → \`bbbb\` 45 本・問題 1 (2%) — #148 sent-back [今の版: 同等 (z -1.10)]`
 */
export function ledgerEffectLine(effect) {
  const { rev, parent } = effect;
  const before = parent ? `${revLabel(parent)} ${parent.runs} 本・${pct(parent)} → ` : '';
  const tasks = rev.problemTasks ?? [];
  const shown = tasks.slice(0, LEDGER_MAX_TASKS).map((p) => `#${p.taskId} ${p.outcome}`);
  const more = tasks.length > shown.length ? ` ほか ${tasks.length - shown.length}` : '';
  const problems = shown.length > 0 ? ` — ${shown.join(', ')}${more}` : '';
  const z = typeof effect.z === 'number' ? ` (z ${effect.z.toFixed(2)})` : '';
  const now = effect.current ? ` [今の版: ${VERDICT_LABELS[effect.verdict] ?? effect.verdict}${z}]` : '';
  return `${effect.botKey}: ${before}${revLabel(rev)} ${rev.runs} 本・問題 ${rev.problems} (${pct(rev)})${problems}${now}`;
}

/**
 * 台帳の 1 改訂の見出し (純粋)。例: `#135 10-12 13:27 merge (roles/worker.md): 題`
 */
export function ledgerHeadLine(revision, { maxTitle = 120 } = {}) {
  return `#${revision.taskId} ${day(revision.mergedAt)} merge (${revision.files.join(', ')}): ${clip(revision.title, maxTitle)}`;
}

/**
 * 巡回の起動メッセージに載せる台帳の行 (純粋) — いちばん新しい改訂 1 件だけ、短い形で。
 * 1 通 (1900 字) に成績の行と規律を残すため、見出しと狙いは詰め、bot の行は 4 体まで。
 * 全部は提案役が `scripts/harness-report.mjs` で読む。
 */
export function ledgerStartLines(ledger, { maxBots = 4 } = {}) {
  const latest = Array.isArray(ledger) ? ledger[0] : null;
  if (!latest) return [];
  const why = latest.rationale ? ` — 狙い: ${clip(latest.rationale.replace(/\s+/g, ' '), 120)}` : '';
  const effects = latest.effects.slice(0, maxBots).map((e) => clip(ledgerEffectLine(e), 160));
  const more = latest.effects.length > effects.length ? [`…ほか ${latest.effects.length - effects.length} 体`] : [];
  return [
    `${ledgerHeadLine(latest, { maxTitle: 60 })}${why}`,
    ...(effects.length > 0 ? [...effects, ...more] : ['(その merge で始まった版が実行記録に無い)']),
  ];
}

/**
 * 人が読むレポート (scripts/harness-report.mjs と、提案役が詳細を見るときの出力)。
 * @param {object} summary summarizeHarness の戻り
 * @param {object} [opts]
 * @param {object[]|null} [opts.ledger] revisionLedger の戻り (渡せば「改訂の台帳」の節を出す)
 */
export function formatHarnessReport(summary, { minRuns = DEFAULT_HARNESS_MIN_RUNS, maxExcerpts = 8, ledger = null } = {}) {
  const lines = [
    `# ハーネスの成績 (job ${summary.total} 本 / ${day(summary.from)} 〜 ${day(summary.to)} ${JST_LABEL} / 実行記録は 30 日で消える)`,
    '',
    '問題 = verify NG・実行エラー・起動できず・時間切れ、または提出がレビューで差し戻された / 封鎖された job。',
    '人間の停止・再起動・配送の失敗・ブリッジの例外は数えない。',
    `判定は bot ごとに「今の版」と「その前の版」の問題率の差 (各版 ${minRuns} 本以上、z ≥ ${HARNESS_Z} で悪化 / ≤ -${HARNESS_Z} で改善)。`,
    '重さ = 版 × job 種別 (task-work / review / approval / その他) の tool 呼び出しと所要分 (起動 → 終端) の中央値、'
      + '「今 ← 前」は判定と同じ前の版との比。判定には入れない (添えるだけ)。',
    '1 回で通った = 提出のうち verify 1 回・差し戻し / 封鎖なし・merge 時の指摘 0 のもの (再試行・指摘・差し戻しは重なりを各々に数える)。'
      + 'verify の回数か merge 時の指摘の件数が分からない提出とレビュー中の提出は分母から外す。判定には入れない (添えるだけ)。',
    '',
  ];
  if (summary.bots.length === 0) lines.push('(記録なし)', '');
  for (const bot of summary.bots) {
    lines.push(`## ${verdictLine(bot)}`);
    const compared = costCompareLine(bot);
    if (compared) lines.push(`- ${compared}`);
    for (const rev of bot.revs) {
      const knobs = [rev.runtime, rev.model, rev.effort].filter(Boolean).join(' / ');
      lines.push(
        `- ${revLabel(rev)}${knobs ? ` (${knobs})` : ''}: ${day(rev.firstAt)} 〜 ${day(rev.lastAt)} / `
        + `job ${rev.runs} 本・問題 ${rev.problems} (${pct(rev)})${firstPassPart(rev.firstPass)}`
        + ` / 差し戻し ${rev.sentBack} / 提出 ${rev.submissions}`,
      );
      if (rev.evidence?.submissions > 0) lines.push(`  - ${evidenceLine(rev.evidence)}`);
      const cost = rev.cost ? costLine(rev.cost) : null;
      if (cost) lines.push(`  - ${cost}`);
    }
    if (bot.unattributed > 0) lines.push(`- 版の分からない job ${bot.unattributed} 本 (役割文を読む前に断られた等)`);
    lines.push('');
  }
  if (Array.isArray(ledger)) {
    lines.push(
      `## 改訂の台帳 (役割文を触った merge 済みのタスク → その merge で始まった版。新しい順に ${ledger.length} 件)`,
      '狙いが当たったか (狙った失敗が再発したか・別の失敗が出たか) は、下の抜粋と手順 (`--trace <job id>`) で読む。',
    );
    if (ledger.length === 0) lines.push('(なし)');
    for (const revision of ledger) {
      lines.push(`- ${ledgerHeadLine(revision)}`);
      if (revision.rationale) lines.push(`  - 狙い: ${clip(revision.rationale.replace(/\s+/g, ' '), 300)}`);
      for (const effect of revision.effects) lines.push(`  - ${ledgerEffectLine(effect)}`);
      if (revision.effects.length === 0) lines.push('  - (その merge で始まった版が実行記録に無い)');
    }
    lines.push('');
  }
  const shown = summary.excerpts.slice(0, maxExcerpts);
  lines.push(`## 問題の抜粋 (新しい順に ${shown.length} / ${summary.excerpts.length} 件)`);
  if (shown.length === 0) lines.push('(なし)');
  for (const item of shown) {
    const where = [item.channel, item.taskId !== null ? `task #${item.taskId}` : null].filter(Boolean).join(' ');
    const detail = item.detail.length > 240 ? `${item.detail.slice(0, 240)}…` : item.detail;
    lines.push(
      `- ${day(item.at)} ${item.botKey} ${item.rev ? revLabel({ rev: item.rev }) : '(版不明)'} ${where} `
      + `${item.outcome}${detail ? ` — ${detail}` : ''}${item.next ? ` → 次: ${item.next}` : ''}`,
    );
    // 手順の要約 (呼び出し側が軌跡を読んで付ける — ここはファイルを読まない)
    if (typeof item.trace === 'string' && item.trace !== '') lines.push(`  - 手順 (job ${item.runId}): ${item.trace}`);
  }
  return lines.join('\n');
}
