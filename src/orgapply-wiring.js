// 採択された org / process 提案を「当てて検収へ回す」までの配線。
//
// 判断は `src/apply.js` (当ててよいか・どの手を打つか)、実行は `src/orgapply.js`
// (注入された git と fs で順番に走らせる) が持つ。ここが持つのは **その 2 つと
// board / ProposalStore をつなぐ順序**だけ:
//
//   1. 採択された提案を 1 件選ぶ (適用は排他なので並べない)
//   2. 適用 task を起こして**錠を下ろす** (`linkTask(..., {apply:true})`)
//   3. `applyProposal` で当てる
//   4. `settle` (排他区間の中) — 成功なら receipt → review、失敗なら task を捨てて錠を外す
//   5. 検収の判定を受けて merge (receipt の commit OID だけ) か、提案への差し戻し
//
// **Discord も config も知らない。** 起動している bot・チャンネル・git の実体は
// すべて注入で受ける (組み立てるのは `src/bridge/orgapply.js`) ので、この層は偽の依存だけで
// 順番をテストできる。
//
// **入口は `prepareApply` の 1 つだけ。** `checkApplicable` を直に呼ばないのは、
// allowlist が動いて class が変わった提案を `withdrawn` へ倒せなくなるため
// (Sol 指摘 2026-08-30 — apply.js の `prepareApply` のコメント)。

import { applyAttemptCount, laneForClass, planMerge, prepareApply } from './apply.js';
import { TERMINAL_STATES } from './board.js';
import { applyProposal } from './orgapply.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** 通知や履歴へ載せる理由は 1 行に均して切る (板と台帳に長文を溜めない) */
const brief = (text, max = 200) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 適用 task のブランチ。**1 提案 = 1 マージコミット** (と同じ形) */
export function applyBranchFor(taskId) {
  return `task/${taskId}`;
}

/** 適用 task の題。板の一覧で「何を当てているか」が読めること */
export function applyTaskTitle(proposal) {
  const summary = String(proposal?.input?.summary ?? '').split('\n')[0].trim();
  const head = `適用 #${proposal?.id ?? '?'} (${proposal?.input?.kind ?? '不明'})`;
  return brief(summary ? `${head}: ${summary}` : head, 120);
}

/**
 * 適用 task の理由欄。**この task が担うのは検収だけ**だと明記する —
 * 当てたのはブリッジで、task に修正担当も書込み権限も無い。
 */
export function applyTaskRationale(proposal) {
  return `提案 #${proposal?.id} (${proposal?.class}) の適用。`
    + 'ブリッジが承認済み diff を当てたので、この task が担うのは diff の検収だけ。';
}

/**
 * 当てる番の提案。**`applyTaskId` が空のものだけ** — 錠が下りているものは
 * 走っているか検収待ちなので、二重適用を防ぐのは候補の側でも閉じる。
 */
export function applyCandidates(store) {
  if (!store) return [];
  return store.list({ state: 'adjudicated' }).filter(
    (p) => p.decision === 'accepted'
      && !isNonEmptyString(p.applyTaskId)
      && laneForClass(p.class) !== null,
  );
}

/** 1 tick で当てるのは 1 件だけ (適用は repo + task の鍵で排他なので並べても待つだけ) */
export function pickApplyCandidate(store) {
  return applyCandidates(store)[0] ?? null;
}

/**
 * 候補を順に当てる。**当て始めたら 1 件で打ち切るが、走査そのものは止めない。**
 *
 * 先頭 1 件だけを見ると、状態が動かない候補 (試行上限に達した提案・lane の起動条件を
 * 満たさない提案) が先頭を占め続け、**後続の提案が永久に当たらない**
 * (Sol 指摘 2026-09-03)。打ち切る条件は「候補が居たか」ではなく
 * **「排他資源を掴んだか」** — `prepare` 段で止まったものは task も枝も作っていない。
 *
 * @param {(proposal: object, out: object) => Promise<void>} p.report 1 件ぶんの通知
 * @returns {Promise<{proposal: object, out: object}[]>} 試した順の結果
 */
export async function sweepApplyCandidates(store, { report = null, ...rest } = {}) {
  const results = [];
  for (const proposal of applyCandidates(store)) {
    const out = await startOrgApply({ proposalId: proposal.id, store, ...rest });
    results.push({ proposal, out });
    if (report) await report(proposal, out);
    if (out.stage !== 'prepare') break;
  }
  return results;
}

/** その task が「どの提案の適用 task か」。通常の task なら null */
export function findApplyProposal(store, taskId) {
  if (!store || taskId === null || taskId === undefined || taskId === '') return null;
  const key = String(taskId);
  return store.list().find((p) => p.applyTaskId === key) ?? null;
}

/**
 * 途中で止まった適用を片付け直す。**後始末が落ちたときの回復点。**
 *
 * 後始末は「task を捨てる → 枝を解放する → 錠を外す」の順で走る。**どこで落ちても
 * 次の tick で同じ手を打ち直せること**が、この順序を選んでよい条件そのもの。
 * 落ち方で残る形が違うので、錠の掛かった提案を task の状態で振り分ける:
 *
 * - `in-progress` … 当てている最中に落ちた (drop が通らなかった場合を含む)。
 *   **後始末を丸ごとやり直す** — task を捨て、枝を解放し、錠を外す
 * - `dropped` / 不在 … task は片付いたが錠だけ残った。**枝を解放してから錠を外す**
 *   (drop の後で落ちていれば作業ツリーも枝も残っている — 解放は冪等)
 * - `review` … 検収待ち。正常なので触らない (差し戻しは検収の判定から)
 * - `merged` … `resumeApplyTrials` の領分
 *
 * **`in-progress` を「落ちた適用」と断じてよい根拠は、呼ぶ場所にある。** 適用が走るのは
 * 適用回路の中だけで、その全体が in-flight ガードで直列化されている (src/bridge/orgapply.js の
 * `sweepOrgApply`)。**走っていない瞬間にしか呼ばれない**ので、`in-progress` のまま
 * 残っている適用 task は必ず残骸になる — 走っている最中に呼ぶと、生きている作業ツリーを
 * 撤去する。呼ぶ側を変えるならこの前提から見直すこと。
 *
 * @param {{release?: function, now?: number, by?: string, log?: function}} p
 *   `release` は枝と作業ツリーの解放 (省略すると枝は残す)
 * @returns {Promise<string[]>} 片付けた提案 ID
 */
export async function reclaimStaleApplies(store, board, {
  release = null, now = Date.now(), by = 'bridge', log = () => {},
} = {}) {
  if (!store || !board) return [];
  const reclaimed = [];
  for (const proposal of store.list({ open: true })) {
    const taskId = proposal.applyTaskId;
    if (!isNonEmptyString(taskId)) continue;
    const task = board.get(taskId);
    if (task && task.state !== 'dropped' && task.state !== 'in-progress') continue;

    if (task?.state === 'in-progress') {
      // **後始末をもう一度、同じ道で。** 前回どこまで進んだかは覚えていないが、
      // drop も解放も冪等に書いてあるので、頭から打ち直せば同じ場所へ着く
      const out = await abandonApplyTask({
        store,
        board,
        proposal,
        task,
        reason: `適用が最後まで進まないまま残っていました (タスク #${taskId} は in-progress)`,
        release,
        by,
        now,
      });
      if (out.ok) reclaimed.push(proposal.id);
      else log(`#${proposal.id} の後始末をやり直せませんでした: ${out.reason}`);
      continue;
    }
    // **錠を外す前に枝も解放し直す。** task は閉じているが、後始末が落ちた場所によっては
    // 作業ツリーと枝が残っている。解放は冪等なので打ち直して構わない —
    // 失敗しても note に残して `failApply` へ進む (`abandonApplyTask` と同じ流儀:
    // 残骸は次の適用が作り直すときに撤去されるが、錠は誰も外してくれない)
    try {
      if (typeof release === 'function') {
        await release({ task: task ?? { id: taskId, branch: applyBranchFor(taskId) } });
      }
    } catch (err) {
      log(`#${proposal.id} の作業ツリーを解放できませんでした: ${err.message} — 次の適用が作り直します`);
    }
    try {
      store.failApply(proposal.id, {
        reason: task
          ? `適用タスク #${taskId} が dropped のまま錠が残っていました`
          : `適用タスク #${taskId} がボードにありません`,
        taskId,
        now,
        by,
      });
      reclaimed.push(proposal.id);
    } catch (err) {
      log(`#${proposal.id} の錠を外せませんでした: ${err.message}`);
    }
  }
  return reclaimed;
}

/**
 * 提案 1 件を当てる。**task を起こすより先に `prepareApply` を通す。**
 *
 * @param {object} p
 * @param {string} p.proposalId
 * @param {object} p.store ProposalStore
 * @param {object} p.board TaskBoardStore
 * @param {object} p.ctx `createRepoContext` の結果 (適用先の**現在**)
 * @param {string} p.channelName 適用 task を起こすチャンネル (`initiative.applyChannel`)
 * @param {string} p.repoRoot リポジトリ本体
 * @param {object} p.deps `applyProposal` の依存 (git / fs / verify / 現況)
 * @param {(p: {task, proposal, plan}) => Promise<string>} p.createThread
 *   適用 task のスレッドを作って ID を返す (投稿・予算の払い出しは呼び出し側)
 * @param {(p: {task, proposal, receipt, threadId}) => Promise<{ok, note}>} p.submitReview
 *   検収を頼む。**排他区間の中で呼ばれる**
 * @param {(p: {task, stage}) => Promise<string>} p.release 枝と作業ツリーの解放 (1 行を返す)
 * @returns {Promise<object>} `{ok:true, taskId, threadId, receipt, note}` または
 *   `{ok:false, stage, reason, ...}`。stage は
 *   `prepare` / `task` / `thread` / `lock` / `settle` と `applyProposal` の段
 */
export async function startOrgApply({
  proposalId, store, board, ctx, channelName, repoRoot,
  by = 'bridge', now = Date.now(), deps,
  createThread, submitReview, release, log = () => {},
}) {
  // **適用回路の唯一の入口。** 再検証を先に走らせるので、allowlist から外れた提案は
  // ここで `withdrawn` へ、drift した提案は `deliberating` へ倒れてから返る
  const plan = prepareApply(store, proposalId, ctx, { now });
  if (!plan.ok) {
    return {
      ok: false,
      stage: 'prepare',
      reason: plan.reason,
      action: plan.action ?? null,
      escalate: plan.escalate === true,
      attempts: applyAttemptCount(store.get(proposalId)),
    };
  }
  const proposal = store.require(proposalId);

  // ---- 適用 task を起こす ----
  let task;
  try {
    task = board.propose(
      {
        channel: channelName,
        title: applyTaskTitle(proposal),
        rationale: applyTaskRationale(proposal),
        // **task の touch は提案の touch そのもの。** ずれていると linkTask が断る
        touch: plan.touch,
      },
      { now, by },
    );
  } catch (err) {
    return { ok: false, stage: 'task', reason: `適用タスクを起こせませんでした: ${err.message}` };
  }

  let threadId;
  try {
    threadId = await createThread({ task, proposal, plan });
    if (!isNonEmptyString(threadId)) throw new Error('スレッド ID を受け取れませんでした');
  } catch (err) {
    const left = dropQuietly(board, task.id, { by, reason: `スレッドを作れませんでした: ${err.message}`, log });
    return {
      ok: false, stage: 'thread', taskId: task.id,
      reason: `適用タスクのスレッドを作れませんでした: ${err.message}${left.note}`,
    };
  }

  // **承認と着手の間に await を置かない** (Fable 検収 2026-09-03)。`approve` を先に打つと
  // Discord 待ちの窓で task が `approved` のまま残り、同じ tick で並走する `autonomyTick` の
  // `planTick` が `approved` を全部 `start-task` にする — **書込み権限つきの worker job** が
  // 適用 task で起きてしまい、「適用 task に修正担当も書込み権限も無い」が破れる。
  // `proposed` は planTick が触らず、`requestApproval` はスカウトの起票からしか呼ばれない
  try {
    board.approve(task.id, { by, note: `提案 #${proposal.id} の適用 (ブリッジが起こしました)` });
    task = board.start(task.id, {
      threadId, branch: applyBranchFor(task.id), by, note: `提案 #${proposal.id} を当てます`,
    });
  } catch (err) {
    const left = dropQuietly(board, task.id, { by, reason: `着手を記録できませんでした: ${err.message}`, log });
    return {
      ok: false, stage: 'task', taskId: task.id, threadId,
      reason: `適用タスクの着手を記録できませんでした: ${err.message}${left.note}`,
    };
  }

  // **錠は task を起こした直後に下ろす。** 二重適用を止めるのはこの 1 回の書き込みで、
  // 落ちたら提案は触らない (錠が無いので `failApply` を通す対象そのものが無い)
  try {
    store.linkTask(proposalId, task.id, { ctx, by, now, apply: true });
  } catch (err) {
    const left = dropQuietly(board, task.id, { by, reason: `適用の錠を取れませんでした: ${err.message}`, log });
    return {
      ok: false, stage: 'lock', taskId: task.id, threadId,
      reason: `適用の錠を取れませんでした: ${err.message}${left.note}`,
    };
  }

  // ---- 当てる ----
  // `settle` は**排他区間の中**で呼ばれる (後始末より先に次の適用が現況を読むと、
  // 後始末が次の枝を撤去する — orgapply.js のコメント)
  let outcome = null;
  let settled = null;
  try {
    await applyProposal({
      proposal,
      plan,
      taskId: task.id,
      branch: task.branch ?? applyBranchFor(task.id),
      repoRoot,
      deps,
      settle: async (out) => {
        outcome = out;
        settled = out.ok
          ? await settleSuccess({ store, board, proposal, task, threadId, receipt: out.receipt, submitReview, by, now })
          : await settleFailure({ store, board, proposal, task, result: out, release, by, now });
      },
    });
  } catch (err) {
    // 後始末の失敗は握りつぶさない (握ると「当たっていないのに錠が残る」が黙って残る)
    return {
      ok: false,
      stage: 'settle',
      taskId: task.id,
      threadId,
      // 落ちた場所で残る形が違う (review = 検収の宛先が生きている・in-progress = 残骸)。
      // 案内の分岐に使うので、推測ではなく板の**現在**を読んで返す
      taskState: board.get(task.id)?.state ?? null,
      applyStage: outcome?.stage ?? null,
      reason: outcome && !outcome.ok
        ? `適用に失敗し (${outcome.stage}: ${outcome.reason})、後始末も落ちました: ${err.message}`
        : `適用の後始末に失敗しました: ${err.message}`,
    };
  }

  if (!outcome?.ok) {
    return {
      ok: false,
      stage: outcome?.stage ?? 'apply',
      reason: outcome?.reason ?? '適用の結果を受け取れませんでした',
      taskId: task.id,
      threadId,
      path: outcome?.path ?? null,
      note: settled?.note ?? '',
    };
  }
  return {
    ok: true,
    taskId: task.id,
    threadId,
    path: outcome.path,
    receipt: outcome.receipt,
    review: settled?.review ?? null,
    note: settled?.note ?? '',
  };
}

/**
 * 当たった。**receipt が先、task の遷移は後。**
 *
 * 適用 task には修正担当も書込み権限も無いので、`noteTaskCompletion` の
 * 「worker の完了 report を見て review へ進める」経路は使えない。
 * `recordReceipt` が通ったことをもってブリッジが `in-progress → review` を進める。
 */
async function settleSuccess({ store, board, proposal, task, threadId, receipt, submitReview, by, now }) {
  store.recordReceipt(proposal.id, receipt, { now, by });
  const submitted = board.submitForReview(task.id, { by, note: `適用 ${receipt.appliedCommit}` });
  const review = typeof submitReview === 'function'
    ? await submitReview({ task: submitted, proposal, receipt, threadId })
    : null;
  return { note: review?.note ?? '', review };
}

/** 当たらなかった。順序は `abandonApplyTask` に寄せる (検収の差し戻しと同じ道) */
async function settleFailure({ store, board, proposal, task, result, release, by, now }) {
  const abandoned = await abandonApplyTask({
    store,
    board,
    proposal,
    task,
    reason: `適用に失敗しました (${result.stage}): ${brief(result.reason, 300)}`,
    // verify で落ちたときだけコミットは残っている。それ以外は当たっていない
    verify: result.stage === 'verify' ? { ok: false } : null,
    release: (arg) => release({ ...arg, stage: result.stage }),
    by,
    now,
  });
  // **錠を外せなかったことは伝播させる** — ここで飲むと、当たっていないのに
  // 適用中のままの提案が黙って残る (回復は reclaimStaleApplies)
  if (!abandoned.ok) throw new Error(abandoned.reason);
  return { note: abandoned.note };
}

/**
 * この適用は通らなかった、の後始末。**順序が不変条件**:
 *
 *   1. 適用 task を `dropped`(superseded) — 検収の宛先を先に閉じる
 *   2. 作業ツリーとブランチを解放 — まだ錠が掛かっているので、次の適用は始まらない
 *   3. `failApply` で錠を外し `deliberating` へ戻す
 *
 * 逆順にすると、錠の外れた提案を次の tick が拾い、走り始めた新しい適用の枝を
 * 古い後始末が撤去する (Sol 指摘 2026-09-01)。
 *
 * **枝の解放が失敗しても 3 は必ず走らせる** — 残骸は次の適用が
 * `planApplyWorktree` で作り直すときに撤去されるが、錠は誰も外してくれない。
 *
 * **1 が通らなければ 3 へ進まない** (Sol 指摘 2026-09-03)。task を閉じられないまま
 * 錠を外すと、同じ提案に生きた task (review / in-progress) と再裁定待ちの提案が
 * 並び、次の適用が始まっても古い task の検収がボードに残る。錠を掛けたまま返せば、
 * 次に drop が通ったとき (検収の再判定・次の tick) に同じ道でやり直せる。
 * **既に終端なら drop を打たずに進む** — 後始末の再実行を冪等にするため。
 */
export async function abandonApplyTask({
  store, board, proposal, task, reason, verdict = null,
  appliedCommit = null, verify = null, release, by = 'bridge', now = Date.now(),
}) {
  const notes = [];
  const current = board.get(task.id);
  if (!current || !TERMINAL_STATES.includes(current.state)) {
    try {
      board.drop(task.id, { by, reason: `superseded: ${brief(reason)}` });
    } catch (err) {
      return {
        ok: false,
        note: `⚠️ 適用タスク #${task.id} を dropped にできませんでした (${err.message})`
          + ' — 錠は外していません (提案は適用中のまま)',
        reason: `適用タスクを閉じられませんでした: ${err.message}`,
      };
    }
  }
  try {
    const note = typeof release === 'function' ? await release({ task }) : '';
    if (isNonEmptyString(note)) notes.push(note);
  } catch (err) {
    notes.push(`⚠️ 作業ツリーを解放できませんでした (${err.message}) — 次の適用が作り直します`);
  }
  try {
    store.failApply(proposal.id, {
      reason, verdict, appliedCommit, verify, taskId: task.id, now, by,
    });
  } catch (err) {
    notes.push(`⚠️ 提案 #${proposal.id} の錠を外せませんでした (${err.message})`);
    return { ok: false, note: notes.join('\n'), reason: `錠を外せませんでした: ${err.message}` };
  }
  return { ok: true, note: notes.join('\n') };
}

/**
 * 検収を通った適用を統合先へ入れる。
 *
 * **merge するのは receipt の commit OID だけ** — ブランチ名で merge すると、
 * コミットの後にその枝へ足された未承認の commit まで入る (`planMerge`)。
 * 統合先は渡された `into` (チャンネルの `autonomy.baseBranch`)。
 *
 * **打つのはブリッジ本体の作業ツリー**なので、始める前に clean を確かめ、落ちたら
 * 必ず元へ戻す (Sol 指摘 2026-09-03)。競合したまま `MERGE_HEAD` と競合 index を
 * 残すと、以後のブリッジの git 操作 (次の適用・検収の diff・verify) がすべて
 * その上で走り、しかも誰も気付かない。
 *
 * @param {(args: string[]) => Promise<string>} p.git 本体で走らせる git
 * @returns {Promise<{ok: true, commit: string, trial: boolean, reason?: string}
 *   | {ok: false, reason: string}>}
 */
export async function mergeApplyTask({
  store, board, ctx, proposal, task, into, git, by = 'bridge', now = Date.now(),
}) {
  if (!isNonEmptyString(into)) {
    return { ok: false, reason: 'merge 先がありません (autonomy.baseBranch を設定してください)' };
  }
  const branch = isNonEmptyString(task?.branch) ? task.branch : applyBranchFor(task.id);
  let branchHeadOid;
  try {
    // **完全一致のローカルブランチで引く** — 短い名前は同名 tag に負ける (applyBaseRef)
    branchHeadOid = String(await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
  } catch (err) {
    return { ok: false, reason: `${branch} の先端を読めません: ${err.message}` };
  }
  const planned = planMerge({ receipt: proposal.receipt, branchHeadOid, into });
  if (!planned.ok) return { ok: false, reason: planned.reason };

  // **汚れた本体では始めない。** checkout も merge も未コミットの変更の上に乗るので、
  // 「入れる前に戻せる状態か」を先に確かめる
  let before;
  try {
    before = String(await git(['status', '--porcelain'])).trim();
  } catch (err) {
    return { ok: false, reason: `本体の状態を読めませんでした: ${err.message}` };
  }
  if (before !== '') {
    return {
      ok: false,
      reason: `本体に未コミットの変更があるので merge しません:\n${brief(before, 300)}`,
    };
  }

  try {
    for (const step of planned.steps) await git(step.args);
  } catch (err) {
    return { ok: false, reason: `merge できませんでした: ${err.message}${await abortMerge(git)}` };
  }
  // **遷移が先・試用は後。** `startTrial` は適用 task が merged であることを見る
  board.complete(task.id, { by, note: `提案 #${proposal.id} を ${into} へ merge (${planned.commit})` });
  try {
    store.startTrial(proposal.id, { ctx, by, now });
  } catch (err) {
    // merge は済んでいるので取り消さない (成果は base に入っている)。
    // 止まったままにもしない — 次の tick で resumeApplyTrials が試用を始め直す
    return { ok: true, commit: planned.commit, trial: false, reason: `試用を開始できませんでした: ${err.message}` };
  }
  return { ok: true, commit: planned.commit, trial: true };
}

/**
 * 落ちた merge の後始末。**競合を本体に残さない。**
 *
 * `merge --abort` は merge が始まっていなければ失敗するので、成否ではなく
 * **その後の `git status`** で判断する — 戻せたのか、人が要るのかは結果で見る。
 *
 * @returns {Promise<string>} 理由へ足す 1 行 (空文字にはしない)
 */
async function abortMerge(git) {
  try {
    await git(['merge', '--abort']);
  } catch {
    // 中断するものが無い (checkout の段で落ちた) — 状態は下で確かめる
  }
  try {
    const status = String(await git(['status', '--porcelain'])).trim();
    if (status === '') return ' (本体は元の状態へ戻しました)';
    return `\n⚠️ **本体に変更が残っています (要人間)**:\n${brief(status, 300)}`;
  } catch (err) {
    return ` — 本体の状態を確かめられませんでした (${err.message})`;
  }
}

/**
 * merge まで済んだのに試用が始まっていない提案を進め直す (Sol 指摘 2026-09-03)。
 *
 * `board.complete` が通った後に `startTrial` が落ちると、task は `merged`・提案は
 * `adjudicated:accepted` のまま止まる。この形は**どの回復経路にも引っかからない** —
 * `/review` は merged を受け付けず、`reclaimStaleApplies` は dropped しか拾わない。
 *
 * **`ctxOf` は遅延で受ける。** 該当が無ければ policy を読み直さない (毎 tick 走る)。
 *
 * @returns {string[]} 試用を始めた提案 ID
 */
export function resumeApplyTrials(store, board, {
  ctxOf = null, now = Date.now(), by = 'bridge', log = () => {},
} = {}) {
  if (!store || !board) return [];
  const stalled = store.list({ state: 'adjudicated' }).filter((p) => (
    p.decision === 'accepted'
    && isNonEmptyString(p.applyTaskId)
    && p.receipt
    && board.get(p.applyTaskId)?.state === 'merged'
  ));
  if (stalled.length === 0) return [];
  const ctx = typeof ctxOf === 'function' ? ctxOf() : null;
  if (!ctx) {
    log('merge 済みの適用があるのに前提を読めないので、試用を始められません');
    return [];
  }
  const resumed = [];
  for (const proposal of stalled) {
    try {
      store.startTrial(proposal.id, { ctx, by, now });
      resumed.push(proposal.id);
    } catch (err) {
      log(`#${proposal.id} の試用を始め直せません: ${err.message}`);
    }
  }
  return resumed;
}

/**
 * 起こしただけの task を捨てる (提案は触らない — まだ錠が掛かっていない)。
 *
 * **失敗は飲まない** (Fable 検収 2026-09-03)。drop が通らないと、検収の宛先も
 * 修正担当も居ない task がボードに残る — `reclaimStaleApplies` は錠の掛かった提案から
 * 辿るので、錠を取る前に残ったものはどの回復経路にも引っかからない。呼び出し側が
 * `note` を理由へ足して人へ渡す。
 *
 * @returns {{ok: boolean, note: string}} `note` は空文字か、理由へ足す 1 行
 */
function dropQuietly(board, taskId, { by, reason, log }) {
  try {
    board.drop(taskId, { by, reason });
    return { ok: true, note: '' };
  } catch (err) {
    log(`適用タスク #${taskId} を dropped にできませんでした: ${err.message}`);
    let state = '不明';
    try {
      state = board.get(taskId)?.state ?? '不明';
    } catch { /* 台帳が読めないなら状態も分からない — そのまま人へ渡す */ }
    return {
      ok: false,
      note: `\n⚠️ タスク #${taskId} が ${state} のまま残っています (要人間): ${err.message}`,
    };
  }
}
