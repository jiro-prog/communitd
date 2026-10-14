// 採択された提案を実際に当てる回路 (docs/social-engineering.md §3.9「org-apply」)。
//
// 適用エンジンは **1 本**で、中に **2 本の lane** を持つ。共通なのは touch 制限・
// digest 照合・二重適用防止・検収を適用主体と別の bot に限る点で、lane ごとに違うのは
// **起動条件と書き込める範囲だけ**:
//
//   org     … 作者の accepted。`roles/**` と `config.policy.json`、
//             `governance-edit` として承認された文書
//   process … Fable の accepted。`processEditAllowlist` に載った文書だけ
//
// 「同じ回路」とだけ決めて範囲を分けないと、`process` の採択が `roles/` まで触れるか、
// allowlist 文書へ書けずに適用不能になるかのどちらかで詰まる。逆に経路を 2 本持つと
// touch 制限も digest 照合も二重に実装することになるので、**エンジンは 1 本に寄せて
// 範囲を lane で閉じる**。
//
// **適用そのものはブリッジが行い、task は検収 (diff のレビュー) だけを担う。**
// 承認済み diff を bot に書かせると、touch 制限が `Edit` の既存ファイル専用ルールしか
// 作れないため (src/contract.js の `narrowForTouchSet` — 新規作成に要る `Write` は
// 落としてある)、`role-create` のように新規ファイルを含む提案は原理的に適用できない。
// 適用したのが bot でない以上、検収は起草 bot と別の 1 体で足りる。
//
// このモジュールは**副作用を持たない** — git も fs も触らず、「当ててよいか」の判定と
// 打つべき手順だけを返す (src/worktree.js の `plan*` と同じ作り)。実行と
// board / ProposalStore への配線は呼び出し側 (src/bridge/orgapply.js / src/bridge/proposals.js)。

import { POLICY_FILE } from './config.js';
import { checkProposal, diffDigestOf, digestOf, isSecretPath, isTerminal } from './proposals.js';
import { samePathLoose, underPathLoose } from './repopath.js';
import { sameWorktreePath, worktreePathFor } from './worktree.js';

// 承認された diff の指紋は提案側 (入力の一部) が正本。適用回路の利用者が
// proposals.js を直接触らなくて済むよう、ここからも出す
export { diffDigestOf };

/** 適用回路の lane。名前は class と同じだが、意味は「起動条件と書ける範囲」 */
export const APPLY_LANES = Object.freeze(['org', 'process']);

/**
 * 同じ提案を当て直してよい回数。**board の差し戻し回数とは別に数える** —
 * board 側は `review → in-progress` の遷移を数えるが、適用の差し戻しは
 * task を終端化して新しい task を作るので、その勘定には乗らない。
 * 超えたら自動で当て直さず人間の判断へ倒す (§6「要人間」)。
 */
export const APPLY_ATTEMPT_LIMIT = 3;

/** commit / tree の OID。**ref は動くので基点にしない** */
const OID = /^[0-9a-f]{40}$/i;

/**
 * 受け付ける唯一のファイルモード。diff の文法も `100644` しか通さない
 * (src/diffs.js の `REGULAR_FILE_MODE`) ので、実行属性・symlink (120000)・
 * submodule (160000) は当てた結果としても現れてはいけない。
 */
const REGULAR_FILE_MODE = '100644';
const ABSENT_MODE = '000000';

const fail = (reason) => ({ ok: false, reason });
const low = (v) => String(v).toLowerCase();
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** その class を適用回路のどの lane が扱うか (`work` は通常の task なので lane を持たない) */
export function laneForClass(klass) {
  return APPLY_LANES.includes(klass) ? klass : null;
}

/**
 * lane が書いてよい範囲か。**touch の 1 つでも外れたら適用しない。**
 *
 * proposals.js の `reservedPathGate` (保存前の横断ゲート) と重なるが、
 * あちらは「その kind がそのパスを対象にできるか」、ここは「その lane が
 * そこへ書けるか」を見る。提案が保存された後に allowlist が動いた場合も、
 * 当てる側の範囲は当てる直前の値で閉じる。
 *
 * @param {{lane: string, kind: string, touch: string[], processEditAllowlist?: string[]}} p
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkLaneScope({ lane, kind, touch = [], processEditAllowlist = [] } = {}) {
  if (!APPLY_LANES.includes(lane)) return fail(`未知の lane: ${lane}`);
  if (!Array.isArray(touch) || touch.length === 0) return fail('touch が空です');
  for (const path of touch) {
    // 秘密側は lane を問わず対象外 (§6 機械層)。保存前にも落ちるが、当てる側でも閉じる
    if (isSecretPath(path)) return fail(`${path} はどの lane からも書けません`);
    const reason = lane === 'org'
      ? orgLaneReason(kind, path, processEditAllowlist)
      : processLaneReason(kind, path, processEditAllowlist);
    if (reason) return fail(reason);
  }
  return { ok: true };
}

function orgLaneReason(kind, path, allowlist) {
  if (samePathLoose(path, POLICY_FILE) || underPathLoose(path, 'roles/')) return null;
  if (kind !== 'governance-edit') {
    return `org lane が書けるのは roles/** と ${POLICY_FILE}、`
      + `governance-edit で承認された文書だけです: ${path}`;
  }
  // **allowlist と governance の対象は排他。** 禁じる側は大小文字を無視して見る
  // (安全側へ倒す向きの非対称。proposals.js の reservedPathGate と揃える)
  if (allowlist.some((doc) => samePathLoose(doc, path))) {
    return `${path} は processEditAllowlist に載っているので governance-edit として書けません`;
  }
  return null;
}

function processLaneReason(kind, path, allowlist) {
  if (kind !== 'process-edit') return `process lane が扱えるのは process-edit だけです (${kind})`;
  // 許す側は完全一致 (大小文字だけ違う名前で allowlist 外の文書へ書かせない)
  if (!allowlist.includes(path)) return `${path} は processEditAllowlist に載っていません`;
  return null;
}

/**
 * いまこの提案を当ててよいか。**適用直前の関門** (§3.9)。
 *
 * 状態・採否・lane の起動条件・二重適用・裁定 digest・保存前ゲート・lane の範囲を
 * **すべて**見る。どれか 1 つでも省くと、`deliberating` へ戻した提案や、
 * 裁定後に差し替えられた diff を根拠に書き込みが起きる。
 *
 * **純粋な判定なので提案の状態は動かさない。** task を作る前に呼ぶときは
 * `prepareApply` を使う (再検証を先に走らせて行き先を確定させるため)。
 *
 * @param {object} proposal ProposalStore の値 (`require()` を通したもの)
 * @param {import('./proposals.js').ProposalContext} ctx **適用先の現在**の状態を見る文脈
 * @returns {{ok: true, lane, revision, digest, baseCommit, kind, touch, files, applied, diffDigest}
 *           | {ok: false, reason: string, escalate?: boolean}}
 */
export function checkApplicable(proposal, ctx) {
  if (!proposal || typeof proposal !== 'object') return fail('提案がありません');
  if (typeof ctx?.checkPath !== 'function') return fail('ctx がありません (適用直前のゲートを通せません)');
  if (isTerminal(proposal)) return fail(`提案 ${proposal.id} は終端 (${proposal.state}) なので適用できません`);
  if (proposal.state !== 'adjudicated') {
    return fail(`提案 ${proposal.id} は ${proposal.state} なので適用できません (要 adjudicated)`);
  }
  if (proposal.decision !== 'accepted') return fail(`提案 ${proposal.id} は採択されていません`);

  const lane = laneForClass(proposal.class);
  if (!lane) return fail(`${proposal.class} は org-apply の対象外です (work は通常の task で扱います)`);

  const adjudication = proposal.adjudication;
  if (!adjudication) return fail(`提案 ${proposal.id} に裁定の記録がありません`);
  // **lane の起動条件は裁定記録そのものを見る。** class ゲート (canAdjudicate) と
  // 二重にする — org lane が書ける範囲は roles/ と policy なので、
  // 「誰が採択したか」を当てる側でもう一度確かめる価値がある
  if (lane === 'org' && !String(adjudication.by ?? '').startsWith('owner:')) {
    return fail(`org lane は作者の裁定だけが起動します (裁定者: ${adjudication.by ?? '不明'})`);
  }
  // 二重適用防止。**merge まで済んでも消さない** — 一度当てた提案を当て直すのは
  // 差し戻し経由の新しい revision だけで、そこでは failApply が解放する
  if (isNonEmptyString(proposal.applyTaskId)) {
    return fail(`提案 ${proposal.id} は既にタスク ${proposal.applyTaskId} で適用中です`);
  }

  const revision = proposal.revisions?.at(-1) ?? null;
  if (!revision || revision.revision !== adjudication.revision || revision.digest !== adjudication.digest) {
    return fail(`提案 ${proposal.id} の裁定 revision と最新 revision が食い違っています`);
  }
  const baseCommit = revision.snapshot?.external?.baseCommit ?? null;
  if (!OID.test(String(baseCommit ?? ''))) {
    return fail('裁定 snapshot に適用の基点 (baseCommit) がありません — 基点の無い裁定は当てられません');
  }

  // **裁定した内容と同じものを当てるのか。** 対象ファイルが裁定後に動いていれば
  // ここで落ちる (§3.9「diff の差し替えも対象ファイルの drift も再裁定へ戻す」)
  if (digestOf(proposal, ctx, { baseCommit }) !== adjudication.digest) {
    return fail('裁定時の内容と食い違っています (再裁定が要ります)');
  }
  // 保存時と同じゲートをもう一度。当たること・実際に変わること・存在条件まで見る
  const checked = checkProposal(proposal.input, ctx);
  if (!checked.ok) return fail(`適用できません: ${checked.reason}`);

  const scope = checkLaneScope({
    lane,
    kind: checked.kind,
    touch: checked.touch,
    processEditAllowlist: ctx.processEditAllowlist ?? [],
  });
  if (!scope.ok) return scope;

  // **試行上限は最後に見る。** 先に見ると、本当は再裁定 (あるいは class が変わって
  // withdrawn) へ回すべき提案まで「上限に達した」で止まり、`adjudicated:accepted` の
  // まま置き去りになる (Sol 指摘 2026-08-30)。ここまで通った = 他はすべて当てられる
  // 状態なので、止める理由が試行回数だけだと確定してから倒す
  if (shouldEscalateApply(proposal)) {
    return {
      ...fail(`適用の試行が上限 (${APPLY_ATTEMPT_LIMIT} 回) に達しました — 人間の判断が要ります`),
      escalate: true,
    };
  }

  return {
    ok: true,
    lane,
    revision: revision.revision,
    digest: adjudication.digest,
    baseCommit: low(baseCommit),
    kind: checked.kind,
    touch: checked.touch,
    files: checked.files,
    // checkProposal が算出した**適用後の内容** (delete は null)。
    // 当てた結果をこれと突き合わせる — 書き戻しをもう一度計算し直さない
    applied: checked.applied,
    diffDigest: diffDigestOf(proposal.input?.change?.diff),
  };
}

/**
 * **適用回路の唯一の入口。** task を作る前に必ずこれを通す。
 *
 * `checkApplicable` は純粋な判定なので、前提が動いていても「当てられません」と
 * 返すだけで提案の状態は動かない。それだけを見て task 化すると、allowlist から
 * 対象が外れて **class が変わった (= `withdrawn` にすべき)** 提案が
 * `adjudicated:accepted` のまま残り続ける (Sol 指摘 2026-08-30)。
 * `ProposalStore.revalidate` を先に走らせ、行き先 (`withdrawn` / `deliberating`) が
 * 決まるものはそちらへ倒してから判定する。
 *
 * @param {import('./proposals.js').ProposalStore} store
 * @param {string} id
 * @param {import('./proposals.js').ProposalContext} ctx
 * @returns {{ok: true, ...}} `checkApplicable` の結果、または
 *   `{ok: false, reason, action?: 'withdrawn'|'deliberating', escalate?: boolean}`
 */
export function prepareApply(store, id, ctx, { now = Date.now() } = {}) {
  const revalidated = store.revalidate(id, ctx, { now });
  if (!revalidated.ok) return { ok: false, reason: revalidated.reason, action: revalidated.action };
  return checkApplicable(store.require(id), ctx);
}

/**
 * 適用先の作業ツリーを**毎回きれいな枝から**作る計画。**副作用なし。**
 *
 * `src/worktree.js` の `planPrepare` は「同じパスに同じブランチが居れば再利用」
 * 「ブランチがあれば作り直さない」— 差し戻し 2 周目で作業を捨てないための既定で、
 * 通常タスクには正しい。**適用回路ではそれを使わない**: 古いコミットや未コミットの
 * 変更が承認 diff と一緒に入ってしまう。ここでは残骸を撤去し、ブランチを消し、
 * `baseCommit` から生やし直す。
 *
 * @param {{repoRoot: string, taskId: string, branch: string, baseCommit: string,
 *          worktrees?: object[], branches?: string[]}} p
 * @returns {{path: string, steps: {args: string[], why: string}[]}}
 */
export function planApplyWorktree({ repoRoot, taskId, branch, baseCommit, worktrees = [], branches = [] }) {
  if (!isNonEmptyString(branch)) throw new Error('org-apply: branch は省略できない');
  if (!OID.test(String(baseCommit ?? ''))) {
    throw new Error('org-apply: baseCommit は 40 桁の commit OID で渡す (ref は動くので基点にしない)');
  }
  const path = worktreePathFor(repoRoot, taskId);
  const steps = [];

  const existing = worktrees.find((w) => sameWorktreePath(w.path, path));
  if (existing?.prunable) {
    steps.push({ args: ['worktree', 'prune'], why: '消えた作業ツリーの登録を掃除する' });
  } else if (existing) {
    if (existing.branch !== branch) {
      throw new Error(
        `org-apply: ${path} には別のブランチ (${existing.branch ?? 'detached'}) の作業ツリーが居る`
        + ` — ${branch} を割り当てる前に撤去が要る`,
      );
    }
    // 前回の適用が途中で落ちた残骸。**再利用しない** — この枝には人間の作業は無く
    // (適用するのはブリッジで、検収 task に書込み権限は無い)、残っているのは
    // 中断した適用の途中結果だけなので捨ててよい
    steps.push({ args: ['worktree', 'remove', '--force', path], why: `${path} の残骸を撤去する (再利用しない)` });
  }

  const holder = worktrees.find((w) => w.branch === branch && !sameWorktreePath(w.path, path) && !w.prunable);
  if (holder) {
    throw new Error(`org-apply: ブランチ ${branch} は別の作業ツリー (${holder.path}) が掴んでいる`);
  }
  if (branches.includes(branch)) {
    steps.push({ args: ['branch', '-D', branch], why: `${branch} を作り直す (古いコミットを承認 diff と混ぜない)` });
  }
  steps.push({
    args: ['worktree', 'add', '-b', branch, path, baseCommit],
    why: `${baseCommit} から ${branch} を生やす`,
  });
  return { path, steps };
}

/**
 * 当てる前の基点の確認。**HEAD が裁定の基点と一致し、index と作業ツリーが clean。**
 *
 * @param {{headOid: string, baseCommit: string, status?: string}} p
 *   status は `git status --porcelain` の出力そのまま (空なら clean)
 */
export function checkApplyBase({ headOid, baseCommit, status = '' } = {}) {
  if (!OID.test(String(headOid ?? ''))) return fail(`HEAD の commit OID を読めません: ${headOid}`);
  if (!OID.test(String(baseCommit ?? ''))) return fail(`baseCommit が commit OID ではありません: ${baseCommit}`);
  if (low(headOid) !== low(baseCommit)) {
    return fail(`適用先の HEAD (${headOid}) が裁定の基点 (${baseCommit}) と違います`);
  }
  const dirty = String(status ?? '').trim();
  if (dirty !== '') return fail(`適用先に未コミットの変更があります:\n${dirty}`);
  return { ok: true };
}

/**
 * 適用の基点を引く ref。**短い名前では引かない。**
 *
 * `git rev-parse master` は `refs/tags/master` を `refs/heads/master` より**先に**見る
 * (gitrevisions の解決順)。同名の tag があると基点がそちらの commit になり、
 * 承認された diff が別の履歴の上に乗ったまま merge されて未承認の履歴まで入る
 * (Sol 指摘 2026-08-31)。ローカルブランチだけを完全一致で指す。
 *
 * @returns {string|null} `refs/heads/<name>`。ブランチとして読めない値なら null
 */
export function applyBaseRef(baseBranch) {
  const name = String(baseBranch ?? '').trim().replace(/^refs\/heads\//, '');
  // `refs/tags/...` のような明示的な非ブランチは受けない (基点はブランチの先端だけ)
  if (name === '' || name.startsWith('refs/')) return null;
  return `refs/heads/${name}`;
}

/** 基点の commit OID を引く git 引数。ブランチとして読めない値なら null */
export function baseCommitArgs(baseBranch) {
  const ref = applyBaseRef(baseBranch);
  return ref === null ? null : ['rev-parse', '--verify', `${ref}^{commit}`];
}

/**
 * 適用結果を検査するための git 引数。**コマンドをここから出すのは、検査対象が
 * 可変なものへずれるのを防ぐため** (Sol 指摘 2026-08-30 / 2026-09-01)。
 *
 * 検査対象は作業ツリーでも index でもなく、**`git write-tree` で固定した tree**。
 * - 作業ツリーを見ると、stage の後に作業ツリーだけ承認内容へ戻すすり替えが通る
 * - index を見ても、検査から commit までの間に並行操作が index へ足せる。
 *   index は可変なので「検査した対象」と「コミットされる対象」が同じ保証にならない
 *
 * tree は immutable なので、一度 OID を取れば以後は動かない。手順は
 * `git add -A` → `git write-tree` → **その tree を**検査 → commit → 入った tree が
 * 同じ OID であることを確かめる。
 *
 * `--no-renames` は安全のためではなく (rename は parse 段で落とす)、`diff.renames` の
 * 設定でレコードの形が変わらないようにするため。
 */
export function rawDiffArgs(baseCommit, tree) {
  return ['diff', '--raw', '-z', '--no-renames', String(baseCommit), String(tree)];
}

/**
 * commit / tree に入っている内容を読む引数 (`<rev>:<path>`)。
 *
 * **可変なものを読まない。** 作業ツリーのファイルも index (`:<path>`) も `HEAD` のような
 * ref も、読んだ後に動きうるので検査の根拠にできない。読むのは基点の commit OID か、
 * `write-tree` で固定した tree OID だけ — **不変条件はコメントではなく引数で強制する**
 * (Sol 指摘 2026-09-01)。
 *
 * **このコマンドが失敗する = その object にその実体が無い** — 基点なら `create` の前提、
 * 固定した tree なら削除されたことの証拠として扱う。
 *
 * @throws {Error} rev が 40 桁の OID でないとき (ref を渡した = 可変なものを読もうとした)
 */
export function objectShowArgs(rev, path) {
  if (!OID.test(String(rev ?? ''))) {
    throw new Error(`org-apply: 読めるのは固定した object だけ (40 桁の OID で渡す): ${rev}`);
  }
  return ['show', `${String(rev)}:${String(path)}`];
}

/**
 * `git diff --raw -z --no-renames <base> <tree>` の出力を分解する。
 *
 * 1 レコード = `:<旧mode> <新mode> <旧sha> <新sha> <状態>` + NUL + パス + NUL。
 * **`-z` を使うのは引用を避けるため** — 既定の raw 形式は非 ASCII を含むパスを
 * C エスケープして `"` で囲むので、パスの照合が引用の解除に依存してしまう。
 *
 * rename / copy は**ここで落とす** (レコードがパス 2 つを持つ形なので、
 * 読み飛ばすと以降のレコードが 1 つずれる)。
 */
export function parseRawDiff(text) {
  const parts = String(text ?? '').split('\0').filter((s) => s !== '');
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const head = parts[i];
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(head);
    if (!m) return fail(`git diff --raw -z の形として読めません: ${JSON.stringify(head)}`);
    const status = m[5];
    if (status === 'R' || status === 'C') {
      return fail(`rename / copy は適用結果として受け付けません: ${JSON.stringify(head)}`);
    }
    const path = parts[i + 1];
    if (path === undefined) return fail(`${head} に対応するパスがありません`);
    entries.push({ srcMode: m[1], dstMode: m[2], status, path });
  }
  return { ok: true, entries };
}

/**
 * コミットしてよいか。**承認された変更しか入っていないことを「結果」で確かめる。**
 *
 * §3.9 は「コミット直前に `git diff <baseCommit>` が承認済み diff と完全一致すること」と
 * 書くが、diff の**テキスト**を突き合わせると文脈行の幅や hunk の切り方が違うだけで
 * 落ちる (承認 diff の `-U` と `git diff` の既定が同じである保証は無い)。ここでは
 * 同じことを 2 つの面で見る:
 *
 *   1. **中身** — 変わったファイルの集合が touch と一致し、各内容が
 *      `checkProposal` の算出した適用後の内容と一致すること
 *   2. **入れ物** — 変更の種類とファイルモードが承認された操作と一致すること。
 *      内容だけを見ると、mode 変更や symlink 化が混ざっても気づけない
 *      (Sol 指摘 2026-08-30)。承認 diff 側で mode を拒否していても、
 *      **適用中に混入するのは別の話**なので、当てた結果でもう一度見る
 *
 * **見るのは固定した tree。** 作業ツリーも index も検査の後に動きうるので、
 * 「検査した対象」と「コミットされる対象」が同じである保証にならない
 * (Sol 指摘 2026-08-30 / 2026-09-01)。引数名に `tree` を入れてあるのは、
 * 呼び出し側が取り違えたときに**その場で読んで気づける**ようにするため。
 *
 * @param {{rawTree: string, treeContents: object, applied: object, files: object[]}} p
 *   rawTree は `rawDiffArgs(baseCommit, tree)` の出力、
 *   treeContents は `objectShowArgs(tree, path)` で読んだ内容 (tree に無い = 削除は null)、
 *   applied と files は `checkApplicable` が返したもの
 */
export function checkApplyResult({ rawTree = '', treeContents = {}, applied = {}, files = [] } = {}) {
  const contents = treeContents;
  const parsed = parseRawDiff(rawTree);
  if (!parsed.ok) return parsed;

  const ops = new Map(files.map((f) => [f.path, f.op]));
  const expected = [...new Set(Object.keys(applied))].sort();
  const seen = new Map();
  for (const entry of parsed.entries) {
    if (seen.has(entry.path)) return fail(`${entry.path} の変更が 2 回現れます`);
    seen.set(entry.path, entry);
  }
  const extra = [...seen.keys()].filter((p) => !expected.includes(p)).sort();
  if (extra.length > 0) return fail(`承認されていない変更が混ざっています: ${extra.join(' / ')}`);
  const missing = expected.filter((p) => !seen.has(p));
  if (missing.length > 0) return fail(`承認された変更が入っていません: ${missing.join(' / ')}`);

  for (const path of expected) {
    const want = applied[path];
    const op = ops.get(path) ?? (want === null ? 'delete' : 'edit');
    const entry = seen.get(path);
    const shape = checkEntryShape(path, op, entry);
    if (shape) return fail(shape);

    if (!Object.hasOwn(contents, path)) return fail(`${path} の tree 上の内容を読めません`);
    const got = contents[path];
    if (want === null) {
      if (got !== null) return fail(`${path} が削除されていません`);
    } else if (got !== want) {
      return fail(`${path} の内容が承認された適用結果と違います`);
    }
  }
  return { ok: true };
}

/** 変更の種類とモードが承認された操作と一致するか (通常ファイルの create / edit / delete だけ) */
function checkEntryShape(path, op, { srcMode, dstMode, status }) {
  if (op === 'create') {
    if (status !== 'A' || srcMode !== ABSENT_MODE) return `${path} は新規作成として入っていません (${status})`;
    if (dstMode !== REGULAR_FILE_MODE) return `${path} が通常ファイルではありません (mode ${dstMode})`;
    return null;
  }
  if (op === 'delete') {
    if (status !== 'D' || dstMode !== ABSENT_MODE) return `${path} は削除として入っていません (${status})`;
    if (srcMode !== REGULAR_FILE_MODE) return `${path} は通常ファイルではありませんでした (mode ${srcMode})`;
    return null;
  }
  // edit — 種類もモードも base のまま変わっていないこと (type change は 'T')
  if (status !== 'M') return `${path} は編集として入っていません (${status})`;
  if (srcMode !== dstMode) return `${path} のファイルモードが変わっています (${srcMode} → ${dstMode})`;
  if (dstMode !== REGULAR_FILE_MODE) return `${path} が通常ファイルではありません (mode ${dstMode})`;
  return null;
}

/**
 * ブリッジが当てて verify に通った事実。**後段の merge はこれだけを根拠にする。**
 *
 * worker の完了 report を待たずに適用 task を `review` へ進めるための領収書でもある
 * (適用 task には修正担当も書込み権限も無いので、report 経由の完了判定は使えない)。
 *
 * @throws {Error} 材料が欠けているとき (根拠にならない receipt は作らせない)
 */
export function makeReceipt({
  proposalId, revision, digest, baseCommit, appliedCommit, appliedTree, diffDigest, verify,
} = {}) {
  for (const [key, value] of Object.entries({ proposalId, digest, diffDigest })) {
    if (!isNonEmptyString(value)) throw new Error(`receipt: ${key} は必須です`);
  }
  if (!Number.isInteger(revision) || revision < 1) throw new Error('receipt: revision は 1 以上の整数です');
  for (const [key, value] of Object.entries({ baseCommit, appliedCommit, appliedTree })) {
    if (!OID.test(String(value ?? ''))) throw new Error(`receipt: ${key} は 40 桁の OID です`);
  }
  if (typeof verify?.ok !== 'boolean') throw new Error('receipt: verify は {ok: boolean} で渡します');
  return {
    proposalId: String(proposalId),
    revision,
    digest: String(digest),
    baseCommit: low(baseCommit),
    appliedCommit: low(appliedCommit),
    appliedTree: low(appliedTree),
    diffDigest: String(diffDigest),
    verify: { ok: verify.ok, ...(isNonEmptyString(verify.detail) ? { detail: String(verify.detail) } : {}) },
  };
}

/**
 * merge の計画。**ブランチ名ではなく receipt の commit OID を merge する** —
 * ブランチ名で merge すると、コミット後にその枝へ足された未承認の commit まで入る。
 *
 * `into` に既定値は置かない。統合先はチャンネルの `autonomy.baseBranch` が持っていて
 * (`src/config.js` の `DEFAULT_BASE_BRANCH`)、リポジトリによって `main` だったり
 * `master` だったりする。ここで既定を置くと、渡し忘れたときに**存在しない
 * ブランチ名で checkout する**か、悪くすると別のブランチへ入れてしまう。
 * `planPrepare` が `base` を省略させないのと同じ理由 (どこへ入れるかは呼び出し側が決める)。
 *
 * @param {{receipt: object, branchHeadOid: string, into: string}} p
 * @throws {Error} `into` が無いとき
 */
export function planMerge({ receipt, branchHeadOid, into } = {}) {
  if (!isNonEmptyString(into)) {
    throw new Error('org-apply: merge 先のブランチ (into) は省略できない — autonomy.baseBranch を渡す');
  }
  if (!receipt || typeof receipt !== 'object') return fail('receipt がありません (適用の記録だけが merge の根拠です)');
  if (receipt.verify?.ok !== true) return fail('verify に通っていない適用は merge できません');
  if (!OID.test(String(receipt.appliedCommit ?? ''))) return fail('receipt の appliedCommit が読めません');
  if (!OID.test(String(branchHeadOid ?? ''))) return fail(`枝の HEAD を読めません: ${branchHeadOid}`);
  if (low(branchHeadOid) !== low(receipt.appliedCommit)) {
    return fail(
      `枝の HEAD (${branchHeadOid}) が receipt の適用コミット (${receipt.appliedCommit}) と違います`
      + ' — 承認外のコミットが足されています',
    );
  }
  const commit = low(receipt.appliedCommit);
  return {
    ok: true,
    commit,
    steps: [
      { args: ['checkout', into], why: `${into} へ移る` },
      { args: ['merge', '--no-ff', '--no-edit', commit], why: '承認済みの commit OID だけを merge する' },
    ],
  };
}

/** その提案で適用を試した回数 (revision をまたいで数える) */
export function applyAttemptCount(proposal) {
  return Array.isArray(proposal?.applyAttempts) ? proposal.applyAttempts.length : 0;
}

/** 自動で当て直すのをやめる境目。**超えたら人間の判断へ倒す** (§6) */
export function shouldEscalateApply(proposal) {
  return applyAttemptCount(proposal) >= APPLY_ATTEMPT_LIMIT;
}
