// レビューの証拠を過去の提出へ遡って測る (docs/themes.md の review-evidence)。
//
// ブリッジが完了の回に測る証拠 (src/review-evidence.js) は、入った後の提出にしか付かない。ここではボード
// (data/tasks.json) の merge 済みタスクの review 遷移 (in-progress → review) を 1 回ずつ「提出」として並べ、
// 提出した時点の commit で同じ測定を走らせて、証拠の種類と差し戻しの関係を数える。
//
// 提出の commit = merge の note (`merge <sha> (base <branch>@<sha>, branch task/N@<tip>)`、組み立ては
// src/scheduler.js の planReview) の tip から first-parent で辿った、遷移の時刻より前の最後の commit。
// 差し戻しの後に足した修正の commit は選ばない。基点は merge commit の第 1 親 (note の base の sha は merge の
// 後の先端なので使わない)。提出の commit が基点の祖先 (ブランチ上に無い) なら測らずに理由付きで飛ばす。
//
// 測るのは本体の .worktrees の外 (os.tmpdir) に作った detached な worktree 1 つ。npm ci は最初の 1 回と
// package-lock.json が変わったときだけ (node_modules をジャンクション・シンボリックリンクで張らない)。
// worktree は成否に関わらず finally で消す。**ボードには何も書かない。**
//
// 切り方は review-evidence.js と同じ: 並べ方と集計と整形は純粋関数、手順は git・測定・npm ci を差し替えられる関数。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatReviewEvidence, measureReviewEvidence, parseReviewEvidence } from './review-evidence.js';
import { runVerify, tailText } from './verify.js';
import { parseWorktreeList, runGit, sameWorktreePath } from './worktree.js';

/** merge の note (src/scheduler.js の planReview が書く形)。base の sha は「不明」もある */
const MERGE_NOTE = /^merge ([0-9a-f]{7,40}) \(base (.+?)@(\S+), branch (.+?)@([0-9a-f]{7,40})\)$/;

/** 測れなかった回の 1 行目 (src/bridge/board.js の collectReviewEvidence と同じ書き出し — parseReviewEvidence が unmeasured に読む) */
const UNMEASURED_HEAD = '測れませんでした — ';

const OUTCOME_LABELS = { rejected: '差し戻し', passed: '通過', other: 'その他' };

/** 集計の行 (src/harness.js の証拠の内訳と同じ語)。`always` でない行は 0 件なら出さない */
const SUMMARY_ROWS = [
  { key: 'measured', label: '測った (落ちる / 落ちない)', always: true },
  { key: 'withPasses', label: 'うち落ちないあり', always: true },
  { key: 'noSrc', label: 'src の差分なし', always: true },
  { key: 'noTests', label: 'テストの変更なし' },
  { key: 'unmeasured', label: '測れず', always: true },
  { key: 'unknown', label: '読めない' },
  { key: 'withDeleted', label: '消したテストあり (種類をまたぐ)' },
  { key: 'skipped', label: '飛ばした', always: true },
];

const KIND_KEYS = { measured: 'measured', 'no-src': 'noSrc', 'no-tests': 'noTests', unmeasured: 'unmeasured' };

const short = (sha) => String(sha ?? '').slice(0, 7);

/**
 * merge の note を読む。**純粋**。読めなければ null
 *
 * @returns {{commit: string, baseBranch: string, baseHead: string, branch: string, tip: string}|null}
 */
export function parseMergeNote(note) {
  const match = MERGE_NOTE.exec(String(note ?? '').trim());
  if (!match) return null;
  const [, commit, baseBranch, baseHead, branch, tip] = match;
  return { commit, baseBranch, baseHead, branch, tip };
}

/**
 * ボードのタスクから提出を並べる。**純粋**。対象はチャンネルの merge 済みタスク (id の昇順)、提出は
 * history の in-progress → review を 1 回ずつ。直後の遷移が review → in-progress なら差し戻し (`rejected`)、
 * review → merged なら通過 (`passed`)、それ以外は `other`。merge の note は最後の merged の遷移のものを読み、
 * 読めなければそのタスクの提出すべてに `skip` を付ける。
 * `ids` に merge 済みタスクに無い id があれば投げる — 測ったつもりの相手を取り違えないように
 *
 * @param {object[]} tasks ボードのタスク (readBoard の戻り)
 * @param {{channel: string, ids?: number[]|null}} options
 * @returns {{tasks: number, submissions: object[]}}
 */
export function listSubmissions(tasks, { channel, ids = null } = {}) {
  const merged = (tasks ?? [])
    .filter((task) => task?.channel === channel && task.state === 'merged')
    .filter((task) => ids === null || ids.includes(Number(task.id)))
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (ids !== null) {
    const missing = ids.filter((id) => !merged.some((task) => Number(task.id) === id));
    if (missing.length > 0) {
      throw new Error(`${channel} の merge 済みタスクに無い id: ${missing.map((id) => `#${id}`).join(' ')}`);
    }
  }
  const submissions = merged.flatMap((task) => {
    const history = Array.isArray(task.history) ? task.history : [];
    const note = history.filter((entry) => entry?.to === 'merged').at(-1)?.note;
    const merge = parseMergeNote(note);
    const reviews = history.flatMap((entry, i) => (entry?.from === 'in-progress' && entry.to === 'review' ? [i] : []));
    return reviews.map((i, k) => {
      const next = history[i + 1];
      const outcome = next?.from !== 'review' ? 'other'
        : next.to === 'in-progress' ? 'rejected'
          : next.to === 'merged' ? 'passed' : 'other';
      const at = history[i].at;
      const row = { id: task.id, k: k + 1, n: reviews.length, at, outcome, merge };
      if (!merge) return { ...row, skip: 'merge の note が読めない' };
      if (!Number.isFinite(Date.parse(at))) return { ...row, skip: `review の遷移の時刻が読めない (${at})` };
      return row;
    });
  });
  return { tasks: merged.length, submissions };
}

/**
 * 提出 1 回の commit と基点を git で決める (読むだけ)。決まらなければ `skip` に理由
 *
 * @returns {Promise<{sha: string, base: string, baseRef: string}|{skip: string}>}
 */
export async function locateSubmission({ root, submission, git = runGit }) {
  const { commit, branch, tip } = submission.merge;
  let base;
  try {
    base = (await git(root, ['rev-parse', '--verify', `${commit}^1^{commit}`])).trim();
  } catch {
    return { skip: `merge commit ${short(commit)} の第 1 親が見つからない` };
  }
  let sha;
  try {
    // 時刻は秒で切り捨てる。git の --before は同じ秒の commit を含む
    const seconds = Math.floor(Date.parse(submission.at) / 1000);
    sha = (await git(root, ['rev-list', '-1', '--first-parent', `--before=@${seconds} +0000`, tip])).trim();
  } catch {
    return { skip: `${branch} の先端 ${short(tip)} が見つからない` };
  }
  if (!sha) return { skip: `${submission.at} より前の commit が ${branch} に無い` };
  try {
    await git(root, ['merge-base', '--is-ancestor', sha, base]);
    return { skip: `ブランチ上に commit が無い — 提出時の ${short(sha)} は基点 ${short(base)} の祖先` };
  } catch (err) {
    // 1 = 祖先ではない (答えが no)。それ以外は git が動かなかった
    if (err?.exitCode !== 1) throw err;
  }
  // 測定に渡す基点は短い名前 (証拠の 1 行目に出る)。--short は一意になるまで伸ばす
  const baseRef = (await git(root, ['rev-parse', '--short', base])).trim();
  return { sha, base, baseRef };
}

/** npm ci (shell 文字列は定数。runVerify のタイムアウト・停止・ツリーごとの kill をそのまま使う) */
export async function installDeps({ cwd, handle }) {
  const result = await runVerify({ command: 'npm ci', cwd, handle });
  if (result.ok) return;
  throw new Error(`npm ci が失敗: ${result.error ?? `exit ${result.code}`} ${tailText(result.output, { maxLines: 5, maxChars: 400 })}`.trim());
}

/**
 * 提出を順に測る。worktree は最初に測る提出で `os.tmpdir()` の下に detached で作り、提出ごとに
 * `checkout --force --detach` する (前の測定が戻し損ねていても次へ進める)。npm ci は package-lock.json の
 * blob が前に入れたものと違うときだけ。測定が投げたら「測れませんでした — …」の行にして続ける。
 *
 * `handle` (`{stopRequested, abort}`) が立ったら次の提出へ進まない。測っている途中の提出は測定の側で止まり、
 * `stopped` の行になる (集計には数えない)。worktree は成否・停止に関わらず finally で消し、それでも
 * `git worktree list` に残ったら `leftover` にパスを返す
 *
 * @param {{root: string, submissions: object[], git?: Function, measure?: Function, install?: Function, tempRoot?: string, handle?: object, now?: () => number, onRow?: (row: object) => void}} p
 * @returns {Promise<{rows: object[], stopped: boolean, remaining: number, leftover: string|null}>}
 */
export async function backtestReviewEvidence({
  root,
  submissions,
  git = runGit,
  measure = measureReviewEvidence,
  install = installDeps,
  tempRoot = tmpdir(),
  handle,
  now = Date.now,
  onRow = () => {},
}) {
  const rows = [];
  let dir = null;
  let wt = null;
  // 入れた package-lock.json の blob (undefined = まだ入れていない)
  let installed;
  let stopped = false;
  let leftover = null;
  try {
    for (const submission of submissions) {
      if (handle?.stopRequested) {
        stopped = true;
        break;
      }
      const meta = { id: submission.id, k: submission.k, n: submission.n, at: submission.at, outcome: submission.outcome };
      const located = submission.skip ? { skip: submission.skip } : await locateSubmission({ root, submission, git });
      if (located.skip) {
        const row = { ...meta, skip: located.skip };
        rows.push(row);
        onRow(row);
        continue;
      }
      if (!wt) {
        dir = mkdtempSync(join(tempRoot, 'communitd-backtest-'));
        wt = join(dir, 'wt');
        await git(root, ['worktree', 'add', '--detach', wt, located.sha]);
      }
      await git(wt, ['checkout', '--force', '--detach', located.sha]);
      let evidence;
      let result = null;
      let installSeconds = null;
      let startedAt = now();
      try {
        const lock = await blobOf(wt, located.sha, 'package-lock.json', git);
        if (lock !== null && lock !== installed) {
          installed = undefined;
          await install({ cwd: wt, handle });
          installed = lock;
          installSeconds = secondsSince(startedAt, now);
          startedAt = now();
        }
        result = await measure({ cwd: wt, base: located.baseRef, handle });
        evidence = formatReviewEvidence(result);
      } catch (err) {
        evidence = `${UNMEASURED_HEAD}${err.message}`;
      }
      const row = {
        ...meta,
        sha: located.sha,
        base: located.base,
        evidence,
        evidenceKind: parseReviewEvidence(evidence),
        seconds: secondsSince(startedAt, now),
        ...(installSeconds === null ? {} : { installSeconds }),
        // 測定が停止で返った回と、測る前 (npm ci の途中) に止めて結果が無い回は数えない
        ...(result?.outcome === 'stopped' || (result === null && handle?.stopRequested) ? { stopped: true } : {}),
      };
      rows.push(row);
      onRow(row);
      if (row.stopped) {
        stopped = true;
        break;
      }
    }
  } finally {
    if (dir) leftover = await removeWorktree({ root, dir, wt, git });
  }
  // 数えなかった提出 (停止で途中まで測った回を含む)
  const remaining = submissions.length - rows.filter((row) => !row.stopped).length;
  return { rows, stopped, remaining, leftover };
}

const secondsSince = (startedAt, now) => Math.round((now() - startedAt) / 100) / 10;

/** `<sha>:<path>` の blob の id (無ければ null) */
async function blobOf(cwd, sha, path, git) {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}:${path}`])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * worktree を消す。remove が失敗してもディレクトリを消して prune する。それでも一覧に残ればパスを返す
 * (投げない — finally の中で元の失敗を上書きしないように)
 */
async function removeWorktree({ root, dir, wt, git }) {
  let removed = true;
  try {
    await git(root, ['worktree', 'remove', '--force', wt]);
  } catch {
    removed = false;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 消せなかったディレクトリは一覧の確かめで拾う
  }
  try {
    if (!removed) await git(root, ['worktree', 'prune']);
    const listed = parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']));
    return listed.some((entry) => sameWorktreePath(entry.path, wt)) ? wt : null;
  } catch {
    return wt;
  }
}

/**
 * 提出ごと・証拠の種類ごとに、差し戻し / 通過 / その他の数を出す。**純粋**。種類の分け方は src/harness.js の
 * 証拠の内訳と同じ (measured のうち落ちないテストがあったもの = withPasses、テストを消したもの = withDeleted は
 * 種類をまたぐ)。飛ばした提出は skipped、停止で途中まで測った提出は数えない
 *
 * @returns {{submissions: number, rejected: number, passed: number, other: number, kinds: Record<string, {rejected: number, passed: number, other: number}>}}
 */
export function summarizeBacktest(rows) {
  const blank = () => ({ rejected: 0, passed: 0, other: 0 });
  const out = { submissions: 0, ...blank(), kinds: Object.fromEntries(SUMMARY_ROWS.map(({ key }) => [key, blank()])) };
  for (const row of rows ?? []) {
    if (row.stopped) continue;
    const outcome = OUTCOME_LABELS[row.outcome] ? row.outcome : 'other';
    out.submissions += 1;
    out[outcome] += 1;
    const parsed = row.evidenceKind ?? {};
    const keys = row.skip ? ['skipped'] : [
      KIND_KEYS[parsed.kind] ?? 'unknown',
      ...(parsed.kind === 'measured' && parsed.passes > 0 ? ['withPasses'] : []),
      ...(parsed.deletedFiles > 0 || parsed.vanishedNames > 0 ? ['withDeleted'] : []),
    ];
    for (const key of keys) out.kinds[key][outcome] += 1;
  }
  return out;
}

/**
 * 提出 1 回の行: `#108 提出 1/2・差し戻し・b80015f・<証拠の 1 行目>・12.3 秒`。秒は測定だけで、npm ci を
 * 走らせた回はその秒を括弧で足す
 */
export function formatBacktestRow(row) {
  const head = `#${row.id} 提出 ${row.k}/${row.n}・${OUTCOME_LABELS[row.outcome] ?? OUTCOME_LABELS.other}`;
  if (row.skip) return `${head}・飛ばした: ${row.skip}`;
  const first = String(row.evidence ?? '').split('\n')[0];
  const install = row.installSeconds == null ? '' : ` (npm ci ${row.installSeconds} 秒)`;
  return `${head}・${short(row.sha)}・${first}・${row.seconds} 秒${install}`;
}

/** 集計の段。差し戻し / 通過 (その他は 1 件でもあるときだけ) を種類ごとに 1 行。停止・消し残しがあれば末尾に足す */
export function formatBacktestSummary({ rows, stopped = false, remaining = 0, leftover = null, tasks = null }) {
  const summary = summarizeBacktest(rows);
  const withOther = summary.other > 0;
  const counts = (c) => `差し戻し ${c.rejected} / 通過 ${c.passed}${withOther ? ` / その他 ${c.other}` : ''}`;
  const skipped = summary.kinds.skipped;
  const lines = [
    `集計 — 提出 ${summary.submissions} 件${tasks === null ? '' : ` (merge 済み ${tasks} 件)`}・`
      + `${counts(summary)}・飛ばした ${skipped.rejected + skipped.passed + skipped.other}`,
  ];
  for (const { key, label, always } of SUMMARY_ROWS) {
    const c = summary.kinds[key];
    const total = c.rejected + c.passed + c.other;
    if (always || total > 0) lines.push(`  ${label}: ${total} (${counts(c)})`);
  }
  if (stopped) lines.push(`停止で中断 — 残り ${remaining} 提出は数えずに worktree を消した`);
  if (leftover) lines.push(`worktree が消えずに残った: ${leftover} — git worktree list で確かめて git worktree remove --force で消す`);
  return lines.join('\n');
}
