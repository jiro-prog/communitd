// タスクごとの git worktree 払い出し (docs/social-engineering.md §4 M1)。
//
// M0 の運用で出た実害から逆算した層。ボード #9 が「マージ順序の裁定が要る」で
// blocked になったのは、task/9 が**未マージの** task/8 の上に積まれていたため。
// 原因は並行実行ではなく「1 つの作業ツリーを全タスクが順番に使い回す」構造そのもので、
// 直列に走らせても前のタスクのブランチがそのまま次のタスクの base になってしまう。
// タスクごとに base から生やした独立のツリーを渡せば、この積み重なりは構造的に消える。
//
// **ここに置くのは判断 (どの git コマンドを打つか) と、その薄い実行だけ。**
// いつ払い出していつ撤去するか・どの base から生やすかはブリッジ側 (M1-2) の仕事で、
// この層はボードもスケジューラも Discord も知らない。判断を純粋関数に切っておくと、
// 実際に git を叩かずに「どんな状況で何を打つか」をテストできる — 無人運転で怖いのは
// 打つ手の間違いであって、execFile の使い方ではない (scheduler.js と同じ切り方)。
//
// 前提: 対象リポジトリで `.worktrees/` が Git に無視されていること。無いと作業ツリーが
// untracked として現れ、gitStatusSnapshot と verify を汚す。prepareWorktree は
// これを満たさないリポジトリでは**何も作らずに落ちる** (fail-closed)。
// 無視の出所は問わない (`.gitignore` / `.git/info/exclude` / global excludes のどれでもよい) —
// 見たいのは「作業ツリーが status に出ないこと」であって、どのファイルに書いてあるかではない。

import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';

/** 作業ツリーの置き場所 (リポジトリ内)。リポジトリ外へ出すと cwd 固定の禁則 (§6) と揉める */
export const WORKTREE_DIR = '.worktrees';

/** git の呼び出し上限。add / remove はローカル操作なので数秒で終わる */
const GIT_TIMEOUT_MS = 60 * 1000;

export function worktreeRootFor(repoRoot) {
  return join(resolve(repoRoot), WORKTREE_DIR);
}

/**
 * タスク ID → 作業ツリーのパス。
 *
 * ID はそのままパス片になるので文字種を絞る。ボードの ID は連番だが、外から来た値が
 * 混ざったときに `../` でリポジトリの外を掘らせないための門。
 */
export function worktreePathFor(repoRoot, taskId) {
  return join(worktreeRootFor(repoRoot), `task-${assertTaskId(taskId)}`);
}

function assertTaskId(taskId) {
  const id = String(taskId ?? '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`worktree: パス片に使えないタスク ID: ${JSON.stringify(taskId)}`);
  }
  return id;
}

/**
 * `git worktree list --porcelain` の出力を分解する。
 *
 * 1 エントリ = 空行区切りのブロック。`worktree <path>` で始まり、`HEAD` / `branch` /
 * 単独キーの `bare` `detached` `locked` `prunable` が続く。`locked` と `prunable` は
 * 理由が後ろに付くことがあるので、キーだけ見て真偽にする。
 */
export function parseWorktreeList(stdout) {
  const entries = [];
  let cur = null;
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, ''); // Windows の git は CRLF で返す
    if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) entries.push(cur);
      cur = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue; // ブロックの外に出た行は捨てる (未知の形式で崩れない)
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = shortBranch(value);
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

/** `git branch --format=%(refname:short)` の出力を配列へ */
export function parseBranchList(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter(Boolean);
}

function shortBranch(ref) {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * パスの同一判定。**Windows でだけ大文字小文字を無視する** — `C:/Users/...` と
 * `c:/users/...` が別の作業ツリーに見えると、同じ場所へ二度 add して git のエラーで
 * 初めて気づくことになる。POSIX では大小が違えば本当に別のパスなので、畳むと逆に壊れる。
 */
export function sameWorktreePath(a, b) {
  const left = resolve(String(a ?? ''));
  const right = resolve(String(b ?? ''));
  if (process.platform !== 'win32') return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 払い出しの計画。**副作用なし** — 打つべき git コマンドの列を返すだけ。
 *
 * 既に同じパスに同じブランチの作業ツリーがあれば再利用する (`reused: true`)。
 * job は 1 タスクにつき何度も走るので、2 回目以降は作り直さないのが既定。
 *
 * 落とす側に倒すのは 2 つ: **同じパスに別ブランチ**が居るとき (前のタスクの残骸を
 * 黙って使い回すと、また #9 が起きる) と、**同じブランチを別のツリー**が掴んでいるとき
 * (git も拒否するが、先に落として理由を人間の言葉で残す)。
 *
 * @param {{path: string, branch: string, base: string,
 *          worktrees?: object[], branches?: string[]}} p
 * @returns {{path: string, steps: {args: string[], why: string}[], reused: boolean}}
 */
export function planPrepare({ path, branch, base, worktrees = [], branches = [] }) {
  if (!branch) throw new Error('worktree: branch は省略できない');
  if (!base) throw new Error('worktree: base は省略できない (どこから生やすかは呼び出し側が決める)');

  const steps = [];
  const existing = worktrees.find((w) => sameWorktreePath(w.path, path));

  // 消えたディレクトリの登録が残っているだけなら、掃除してから作り直す
  if (existing?.prunable) {
    steps.push({ args: ['worktree', 'prune'], why: '消えた作業ツリーの登録を掃除する' });
  } else if (existing) {
    if (existing.branch === branch) return { path, steps: [], reused: true };
    throw new Error(
      `worktree: ${path} には別のブランチ (${existing.branch ?? 'detached'}) の作業ツリーが居る` +
        ` — ${branch} を割り当てる前に撤去が要る`,
    );
  }

  const holder = worktrees.find(
    (w) => w.branch === branch && !sameWorktreePath(w.path, path) && !w.prunable,
  );
  if (holder) {
    throw new Error(`worktree: ブランチ ${branch} は別の作業ツリー (${holder.path}) が掴んでいる`);
  }

  // ブランチが既にあれば作り直さない (差し戻し 2 周目で作業を捨てないため)
  steps.push(
    branches.includes(branch)
      ? { args: ['worktree', 'add', path, branch], why: `既存ブランチ ${branch} を割り当てる` }
      : {
          args: ['worktree', 'add', '-b', branch, path, base],
          why: `${base} から ${branch} を生やす`,
        },
  );
  return { path, steps, reused: false };
}

/**
 * 撤去の計画。**副作用なし**。
 *
 * 未コミットの変更が残っていれば `git worktree remove` 自身が拒否するので、そこは
 * 判定しない — 作業を消さない門番を git に任せる。`force` は呼び出し側が
 * 「捨ててよい」と判断したときだけ立てる (dropped タスクの後始末など)。
 *
 * **ただしパスだけで撤去先を決めない。** `expectedBranch` と食い違うツリーが同じ場所に
 * 居るのは、前のタスクの残骸が残っている状況そのもの (§8-1 の #9)。そこへ `force` を
 * 掛けると**別タスクの未コミット作業を消す**ので、一致しなければ 1 手も打たずに落ちる
 * (Sol 指摘 2026-08-28)。
 *
 * @returns {{path: string, steps: {args: string[], why: string}[], missing: boolean}}
 */
export function planRelease({ path, expectedBranch, worktrees = [], force = false }) {
  if (!expectedBranch) {
    throw new Error('worktree: expectedBranch は省略できない (撤去先の取り違えを防ぐ門)');
  }
  const existing = worktrees.find((w) => sameWorktreePath(w.path, path));
  if (!existing) return { path, steps: [], missing: true };
  if (existing.branch !== expectedBranch) {
    throw new Error(
      `worktree: ${path} が掴んでいるのは ${existing.branch ?? 'detached'} で、` +
        `${expectedBranch} ではない — 別タスクの作業を消しうるので撤去しない`,
    );
  }
  return {
    path,
    steps: [
      {
        args: ['worktree', 'remove', ...(force ? ['--force'] : []), path],
        why: force ? `${path} を強制的に撤去する` : `${path} を撤去する`,
      },
    ],
    missing: false,
  };
}

/**
 * 判定がついたタスクの後始末の計画 (§9.5)。**副作用なし**。
 *
 * - `complete` (merged) — 作業ツリーもブランチも要らない。成果は base へ入っている
 * - `drop` (dropped) — **ブランチは残す。** 「対象が不要」と決めたのは判定であって、
 *   枝を消すかは別の判断 (未マージの commit が載っていることがある)
 * - それ以外 (send-back / block / none) — 仕事が続いているので触らない
 *
 * `branch` が空なら何もしない: 撤去先は `planRelease` が `expectedBranch` で確かめるので、
 * 分からないまま撤去すると別タスクの残骸を消しうる。
 *
 * **`force` は常に false。** 未コミットの変更が残っていれば git 自身が拒否して残す —
 * 掃除に、書きかけを捨てる権限は無い。
 *
 * @param {{action?: string, branch?: string|null}} p `action` は planReview の戻り
 * @returns {{release: boolean, force: boolean, deleteBranch: boolean}}
 */
export function planTaskCleanup({ action = '', branch = '' } = {}) {
  const none = { release: false, force: false, deleteBranch: false };
  if (typeof branch !== 'string' || branch.trim() === '') return none;
  if (action === 'complete') return { release: true, force: false, deleteBranch: true };
  if (action === 'drop') return { release: true, force: false, deleteBranch: false };
  return none;
}

/** git を 1 回実行して stdout を返す。失敗は stderr を載せて reject */
export function runGit(repoRoot, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          const wrapped = new Error(`git ${args.join(' ')} が失敗: ${detail}`);
          // 終了コードを残す — 呼び出し側が「答えが no」(1) と「git が動かなかった」
          // (128 など) を区別できないと、診断を取り違える (実際に取り違えた 2026-08-28)
          wrapped.exitCode = typeof err.code === 'number' ? err.code : null;
          rej(wrapped);
          return;
        }
        res(stdout);
      },
    );
  });
}

/**
 * `.worktrees/` が Git に無視されているか。**出所は問わない** — `check-ignore` は
 * `.gitignore` だけでなく `.git/info/exclude` や global excludes でも成功する。
 * ここで確かめたいのは「作業ツリーが status に出ないこと」なので、それで足りる。
 *
 * `git check-ignore` は無視されていれば exit 0、されていなければ exit 1。
 * ディレクトリが実在しなくてもパス名だけで判定できるので、作る前に確かめられる。
 *
 * **exit 1 以外は false にせず投げ直す。** リポジトリが読めない (128) を「無視設定が無い」と
 * 同じ答えに畳むと、パスを間違えているだけなのに `.gitignore` を疑うことになる。
 */
export async function isWorktreeDirIgnored({ repoRoot, git = runGit }) {
  try {
    await git(repoRoot, ['check-ignore', '-q', `${WORKTREE_DIR}/`]);
    return true;
  } catch (err) {
    if (err?.exitCode === 1) return false;
    throw err;
  }
}

/**
 * タスク用の作業ツリーを用意する。既にあれば再利用し、無ければ base から生やす。
 * @returns {Promise<{path, steps, reused}>} 実際に打った手順つきの計画
 */
export async function prepareWorktree({ repoRoot, taskId, branch, base, git = runGit }) {
  const path = worktreePathFor(repoRoot, taskId);
  if (!(await isWorktreeDirIgnored({ repoRoot, git }))) {
    throw new Error(
      `worktree: ${repoRoot} で ${WORKTREE_DIR}/ が Git に無視されていない` +
        ' — .gitignore に足さないと作業ツリーが untracked として verify を汚す',
    );
  }
  const worktrees = parseWorktreeList(await git(repoRoot, ['worktree', 'list', '--porcelain']));
  const branches = parseBranchList(
    await git(repoRoot, ['branch', '--list', '--format=%(refname:short)']),
  );
  const plan = planPrepare({ path, branch, base, worktrees, branches });
  for (const step of plan.steps) await git(repoRoot, step.args);
  return plan;
}

/**
 * 同じ作業ツリーの用意を 1 本にまとめる (§8-2)。
 *
 * ブリッジ側では作成が job のレーン直列化より**前**に走るので、同じ新規タスクへ 2 つの
 * トリガーが重なると両方が「まだ無い」と判断し、片方の `worktree add -b` が git のエラーで
 * 落ちる (Sol 指摘 2026-08-28)。同じ鍵の要求には先行の結果をそのまま待たせる。
 *
 * 鍵は呼び出し側が決める (リポジトリとタスクの組)。**同一プロセス内の重なりだけを畳む** —
 * 別プロセスと競うなら git のロックに任せる話になる。
 */
const preparing = new Map();

export function prepareWorktreeOnce(key, run) {
  const running = preparing.get(key);
  if (running) return running;
  const started = run();
  preparing.set(key, started);
  return started.finally(() => {
    // 後から入れ替わっていたら触らない (自分が入れた分だけ片付ける)
    if (preparing.get(key) === started) preparing.delete(key);
  });
}

/**
 * タスク用の作業ツリーを撤去する。**ブランチは消さない** — 昇格済みかどうかを
 * 知っているのは呼び出し側で、この層が消すと差し戻し中の作業まで消えうる。
 * @returns {Promise<{path, steps, missing}>}
 */
export async function releaseWorktree({ repoRoot, taskId, branch, force = false, git = runGit }) {
  const path = worktreePathFor(repoRoot, taskId);
  const worktrees = parseWorktreeList(await git(repoRoot, ['worktree', 'list', '--porcelain']));
  const plan = planRelease({ path, expectedBranch: branch, worktrees, force });
  for (const step of plan.steps) await git(repoRoot, step.args);
  return plan;
}
