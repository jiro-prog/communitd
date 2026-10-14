// 承認済み diff を実際に当てる実行層 (docs/social-engineering.md §3.9「org-apply」)。
//
// 判断は `src/apply.js` が持つ (当ててよいか・どの手を打つか)。ここはその手順を
// **実際に走らせる**層で、git と fs は**すべて注入**する — 副作用の順番こそが
// この層の中身なので、実物を叩かずに順番だけをテストできるようにしておく
// (src/scheduler.js や src/worktree.js と同じ切り方)。
//
// 当てるのはブリッジで、bot ではない。適用 task が担うのは diff の中身のレビューだけ
// なので、この層は task にも Discord にも触らない — 呼び出し側 (src/bridge/orgapply.js) が
// board と ProposalStore を動かす。
//
// 手順は 1 本道で、**どこで落ちても「当たっていない」に倒れる**:
//
//   1. 現況を読み、基点から枝を作り直す (残骸は再利用しない)
//   2. HEAD が基点と一致し、index も作業ツリーも clean であることを確かめる
//   3. **基点の内容へ**承認済み diff を当てて、適用後の内容を算出する
//   4. **書く前に**適用後の内容そのものを検証する (起動できない設定を commit しない)
//   5. 書いて stage し、**すぐ `write-tree` で固定してから**その tree を検査する
//   6. commit し、**固定した tree がそのまま入ったこと**と親が基点だけであることを確かめる
//   7. 作業ツリーが適用コミットそのものであることを確かめてから verify を回し、
//      通れば receipt を作る
//
// 5 までで落ちたらコミットしない。7 で落ちたらコミットは残るが receipt は作らない —
// どちらも呼び出し側が枝ごと捨てる。
//
// **検査するのは可変なものではなく immutable な object。** 作業ツリーも index も HEAD も、
// 読んだ後に動きうるので「検査した対象」と「コミットされる対象」が同じ保証にならない。
// 固定した tree と、確定した commit OID だけを根拠にする。
//
// 1 から 6 と**呼び出し側の後始末** (`settle`) までは **repo + task の鍵で排他**にする。
// 走っている最中の作業ツリーを次の実行が「残骸」と判断して `remove --force` できたり、
// 失敗した実行の後始末が次の実行の枝を撤去したりするため。

import { dirname, join } from 'node:path';

import {
  checkApplyBase,
  checkApplyResult,
  makeReceipt,
  objectShowArgs,
  planApplyWorktree,
  rawDiffArgs,
} from './apply.js';
import { applyDiffFile } from './diffs.js';

const OID = /^[0-9a-f]{40}$/i;

/** どの段で落ちたか。呼び出し側が「当たっていない」と「verify で落ちた」を区別する */
export const APPLY_STAGES = Object.freeze([
  'worktree', 'base', 'validate', 'write', 'inspect', 'commit', 'verify',
]);

const fail = (stage, reason, path = null) => ({ ok: false, stage, reason, path });

// ---- 排他区間 ----

/** 走っている適用。鍵は `<repoRoot>::<taskId>` */
const locks = new Map();

/**
 * 同じ鍵の適用を**直列化**する。
 *
 * `prepareWorktreeOnce` (src/worktree.js) は同じ呼び出しを 1 本に畳む作りだが、ここは
 * 「畳む」のではなく「順番に走らせる」— 前の適用の結果を後の呼び出しへ配ると、
 * 2 件目が「自分が当てた」と誤解する。前が失敗しても次は走らせる。
 */
export function withApplyLock(key, run) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.then(() => {}, () => {});
  locks.set(key, tail);
  // 誰も待っていない鍵は捨てる (長寿命プロセスで Map が伸び続けないように)
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

/**
 * 承認済み diff を当てて commit し、verify まで通す。
 *
 * **後始末まで同じ排他区間で行う。** `settle` を渡すと、結果を受け取ってから鍵を離す —
 * 適用が失敗して返った直後に、後始末 (worktree / branch の解放・task の終端化) より先に
 * 次の適用が現況を読み始めると、**後始末が次の枝を撤去する** (Sol 指摘 2026-09-01)。
 * receipt の記録も task の遷移もここへ入れる。
 *
 * @param {{proposal: object, plan: object, taskId: string, branch: string,
 *          repoRoot: string, deps: object, settle?: function}} p
 *   plan は `checkApplicable` / `prepareApply` が返したもの (基点・適用後の内容・files)。
 *   deps は `{git, writeFile, deleteFile, ensureDir, validateApplied, verify,
 *   listWorktrees, listBranches}`:
 *     - `git(cwd, args)` … `runGit` と同じ形 (cwd を `-C` で渡して stdout を返す)
 *     - `validateApplied({applied, readBase})` … 書く前の検証。`{ok, reason}` を返す。
 *       **省略できない** (省略できる口にすると、配線を 1 本忘れるだけで壊れた設定が
 *       commit される)。`readBase(相対パス)` は基点の内容 (無ければ null) — 適用が触って
 *       いないファイルも「適用後の姿」を組むのに要る
 *     - `verify(cwd)` … `{ok, detail, aborted?}` を返す。**省略できない**
 *       (receipt は verify 成功が前提)。`aborted` は「落ちた」ではなく「確かめていない」
 *     - `listWorktrees()` / `listBranches()` … 現況。**排他区間の中で読む**ので注入で受ける
 *   settle は `(result) => Promise<void>`。**排他区間の中で**呼ばれる。投げたらそのまま伝える
 *   (後始末に失敗したことを呼び出し側が握りつぶさないように)
 * @returns {Promise<{ok: true, path: string, receipt: object}
 *   | {ok: false, stage: string, reason: string, path: string|null}>}
 */
export async function applyProposal({
  proposal, plan, taskId, branch, repoRoot, deps = {}, settle = null,
} = {}) {
  const required = [
    'git', 'writeFile', 'deleteFile', 'ensureDir', 'validateApplied', 'verify',
    'listWorktrees', 'listBranches',
  ];
  for (const name of required) {
    if (typeof deps[name] !== 'function') throw new Error(`org-apply: ${name} は注入する`);
  }
  if (!plan?.ok) throw new Error('org-apply: 当ててよいと判定された plan を渡す');
  if (settle !== null && typeof settle !== 'function') throw new Error('org-apply: settle は関数で渡す');

  return withApplyLock(`${repoRoot}::${taskId}`, async () => {
    const result = await runApply({ proposal, plan, taskId, branch, repoRoot, deps });
    if (settle) await settle(result);
    return result;
  });
}

async function runApply({ proposal, plan, taskId, branch, repoRoot, deps }) {
  const {
    git, writeFile, deleteFile, ensureDir, validateApplied, verify, listWorktrees, listBranches,
  } = deps;

  // ---- 1. 現況を読んで、基点から枝を作り直す ----
  let path;
  try {
    const prepared = planApplyWorktree({
      repoRoot,
      taskId,
      branch,
      baseCommit: plan.baseCommit,
      worktrees: await listWorktrees(),
      branches: await listBranches(),
    });
    path = prepared.path;
    for (const step of prepared.steps) await git(repoRoot, step.args);
  } catch (err) {
    return fail('worktree', `作業ツリーを作れませんでした: ${err.message}`, path ?? null);
  }

  // ---- 2. 基点の確認 ----
  try {
    const headOid = (await git(path, ['rev-parse', 'HEAD'])).trim();
    const status = await git(path, ['status', '--porcelain']);
    const based = checkApplyBase({ headOid, baseCommit: plan.baseCommit, status });
    if (!based.ok) return fail('base', based.reason, path);
  } catch (err) {
    return fail('base', `適用先を読めませんでした: ${err.message}`, path);
  }

  // ---- 3. 基点の内容へ当てて、書く内容を算出する ----
  const computed = await computeFromBase({ plan, path, git });
  if (!computed.ok) return fail(computed.stage, computed.reason, path);

  // ---- 4. 書く前に、適用後の内容そのものを検証する ----
  // **「当たるか」と「通る内容か」は別。** diff が基点へきれいに当たっても、
  // 出来上がった `config.policy.json` が起動時検証を通らなければ、それを merge した
  // 次の起動が exit 1 で止まる (ラッパーは 42 以外で再起動しないので、そこで社会ごと止まる)。
  // **何を検証するかは呼び出し側が決める** — この層が持つのは「書く前に通す」という順序だけ
  let validated;
  try {
    validated = await validateApplied({
      applied: computed.applied,
      // **読む先も基点。** 当てる元が基点なら、突き合わせる相手も基点でなければならない
      // (呼び出し側が「適用後の設定」を組むのに、この適用が触っていないファイルを要る)
      readBase: async (rel) => {
        try {
          return await git(path, objectShowArgs(plan.baseCommit, rel));
        } catch {
          return null; // 基点に無い (computeFromBase の create と同じ扱い)
        }
      },
    });
  } catch (err) {
    return fail('validate', `適用後の内容を検証できませんでした: ${err.message}`, path);
  }
  if (validated?.ok !== true) {
    return fail('validate', validated?.reason ?? '適用後の内容が検証を通りませんでした', path);
  }

  // ---- 5. 書いて stage して、index を検査する ----
  try {
    for (const [rel, after] of Object.entries(computed.applied)) {
      const target = join(path, rel);
      if (after === null) await deleteFile(target);
      else {
        await ensureDir(dirname(target));
        await writeFile(target, after);
      }
    }
  } catch (err) {
    return fail('write', `適用結果を書けませんでした: ${err.message}`, path);
  }

  // **stage したら、検査より先に tree として固定する。** index は可変なので、
  // 検査してから固定するまでの間に並行操作が足せてしまう — 「検査した対象」と
  // 「コミットされる対象」を同じ immutable な object に束縛する (Sol 指摘 2026-09-01)
  let stagedTree;
  try {
    await git(path, ['add', '-A']);
    stagedTree = (await git(path, ['write-tree'])).trim().toLowerCase();
  } catch (err) {
    return fail('inspect', `index を tree に固められませんでした: ${err.message}`, path);
  }
  if (!OID.test(stagedTree)) return fail('inspect', `index の tree を読めませんでした (${stagedTree})`, path);

  let inspected;
  try {
    const rawTree = await git(path, rawDiffArgs(plan.baseCommit, stagedTree));
    const treeContents = {};
    for (const [rel, after] of Object.entries(computed.applied)) {
      try {
        treeContents[rel] = await git(path, objectShowArgs(stagedTree, rel));
      } catch {
        // tree に無い = 削除された。**残っているはずのものは入れない** —
        // 読めなかったことを「内容が違う」ではなく「読めない」として報告させる
        if (after === null) treeContents[rel] = null;
      }
    }
    inspected = checkApplyResult({
      rawTree, treeContents, applied: computed.applied, files: plan.files,
    });
  } catch (err) {
    return fail('inspect', `適用結果を検査できませんでした: ${err.message}`, path);
  }
  if (!inspected.ok) return fail('inspect', inspected.reason, path);

  // ---- 6. commit し、検査した tree がそのまま入ったことを確かめる ----
  let appliedCommit;
  let appliedTree;
  try {
    // `-a` を付けない。検査したのは index の中身なので、そこへ後から何も足さずに固める
    await git(path, ['commit', '-m', applyCommitMessage(proposal, plan, taskId)]);
    appliedCommit = (await git(path, ['rev-parse', 'HEAD'])).trim().toLowerCase();
    if (!OID.test(appliedCommit)) return fail('commit', `コミットの OID を読めませんでした (${appliedCommit})`, path);
    // **以後は HEAD を引かない。** HEAD は可変なので、receipt に載せる commit と
    // 検査する tree / 親が別の commit のものになりうる (Sol 指摘 2026-09-01)
    appliedTree = (await git(path, ['rev-parse', `${appliedCommit}^{tree}`])).trim().toLowerCase();
    const lineage = (await git(path, ['rev-list', '--parents', '-n', '1', appliedCommit])).trim().split(/\s+/);
    if (lineage[0]?.toLowerCase() !== appliedCommit) {
      return fail('commit', `系譜の先頭 (${lineage[0] ?? 'なし'}) が適用コミットと違います`, path);
    }
    const parents = lineage.slice(1).map((p) => p.toLowerCase());
    if (appliedTree !== stagedTree) {
      return fail(
        'commit',
        `コミットされた tree (${appliedTree}) が検査した tree (${stagedTree}) と違います`
        + ' — 検査の後に index が動いています',
        path,
      );
    }
    // 親は基点 1 つだけ。ここが違うと、承認していない履歴の上に乗ったコミットになる
    if (parents.length !== 1 || parents[0] !== plan.baseCommit.toLowerCase()) {
      return fail('commit', `コミットの親が基点だけではありません (${parents.join(' / ') || 'なし'})`, path);
    }
  } catch (err) {
    return fail('commit', `コミットできませんでした: ${err.message}`, path);
  }

  // ---- 7. verify ----
  // **回す前に、作業ツリーが適用コミットそのものであることを確かめる。**
  // verify が見るのは作業ツリー = 可変なもの。post-commit hook が index を触らずに
  // 作業ツリーだけ直すと、tree も系譜も通ったまま「コミットに入っていない内容」で
  // verify が成功して receipt ができる (Sol 指摘 2026-09-01)
  try {
    const headOid = (await git(path, ['rev-parse', 'HEAD'])).trim().toLowerCase();
    const status = String(await git(path, ['status', '--porcelain'])).trim();
    if (headOid !== appliedCommit) {
      return fail('verify', `verify の前に HEAD (${headOid}) が適用コミットから動いています`, path);
    }
    if (status !== '') {
      return fail('verify', `verify の前に作業ツリーが汚れています (コミットに入っていない内容を検証しない):\n${status}`, path);
    }
  } catch (err) {
    return fail('verify', `verify の前に適用先を読めませんでした: ${err.message}`, path);
  }

  let verified;
  try {
    verified = await verify(path);
  } catch (err) {
    return fail('verify', `verify を回せませんでした: ${err.message}`, path);
  }
  if (verified?.ok !== true) {
    // 中断は**落ちたのではなく確かめていない**。「verify に通りませんでした: 停止指示により
    // 中断」という二重否定にせず、理由をそのまま出す (Opus2 指摘 2026-09-12 m2)。
    // 倒れる先は同じ (receipt を作らない)
    if (verified?.aborted === true) {
      return fail('verify', verified.detail || '停止指示により中断しました', path);
    }
    return fail('verify', `verify に通りませんでした: ${verified?.detail ?? '(詳細なし)'}`, path);
  }

  return {
    ok: true,
    path,
    receipt: makeReceipt({
      proposalId: String(proposal.id),
      revision: plan.revision,
      digest: plan.digest,
      baseCommit: plan.baseCommit,
      appliedCommit,
      appliedTree,
      diffDigest: plan.diffDigest,
      verify: { ok: true, ...(verified.detail ? { detail: verified.detail } : {}) },
    }),
  };
}

/**
 * **基点の内容へ**承認済み diff を当てて、書くべき内容を算出する。
 *
 * `plan.applied` は提案を検証したときの**作業ツリー**の内容に diff を当てたもので、
 * 基点の内容と一致する保証が無い。ブリッジの作業ツリーに diff 外の未コミット変更が
 * あると、それもきれいな枝へ書かれて承認済み diff と一緒にコミットされる
 * (Sol 指摘 2026-09-01)。当てる先が基点なら、当てる元も基点でなければならない。
 *
 * 算出した結果は `plan.applied` とも突き合わせる。食い違ったら「裁定時に見た内容と
 * 基点の内容が違う」ので当てない — 直す先は作業ツリーではなく提案 (再裁定) になる。
 */
async function computeFromBase({ plan, path, git }) {
  const applied = {};
  for (const file of plan.files) {
    let before = null;
    try {
      before = await git(path, objectShowArgs(plan.baseCommit, file.path));
    } catch {
      // 基点に無い = create の前提。**null のまま**進める
      // (edit / delete なら次の applyDiffFile が落とす)
    }
    const result = applyDiffFile(file, before);
    if (!result.ok) {
      return {
        ok: false,
        stage: 'base',
        reason: `${file.path}: 承認済み diff が基点 (${plan.baseCommit}) の内容へ当たりません — ${result.reason}`,
      };
    }
    if (result.after !== plan.applied[file.path]) {
      return {
        ok: false,
        stage: 'base',
        reason: `${file.path}: 裁定時に見た内容と基点の内容が違います (再裁定が要ります)`,
      };
    }
    applied[file.path] = result.after;
  }
  return { ok: true, applied };
}

/**
 * 適用コミットの本文。**誰が何を根拠に当てたか**を、後から git log だけで辿れるようにする。
 * 当てたのはブリッジなので Co-Authored-By は付けない (モデルが書いた変更ではない)。
 */
export function applyCommitMessage(proposal, plan, taskId) {
  const summary = String(proposal?.input?.summary ?? '').split('\n')[0].trim();
  const lines = [
    `apply: 提案 #${proposal.id} を当てる (${plan.kind})`,
    '',
    ...(summary ? [summary, ''] : []),
    `proposal: #${proposal.id} / revision: ${plan.revision} / digest: ${plan.digest}`,
    `base: ${plan.baseCommit}`,
    `lane: ${plan.lane} / 裁定: ${proposal?.adjudication?.by ?? '不明'} (${proposal?.adjudication?.at ?? '不明'})`,
    '',
    'ブリッジが承認済み diff から決定論的に当てたコミット。',
    `diff の検収は task #${taskId} で行う (適用者と検収者を分ける)。`,
  ];
  return lines.join('\n');
}
