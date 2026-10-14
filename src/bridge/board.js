// ボード (タスク台帳) を動かす配線 (src/index.js から切り出し): 起票 → 承認 → 着手 → 完了報告 →
// レビュー → 判定の適用、と差し戻し・作業ツリーの後始末。判断は src/scheduler.js / src/board.js の
// 純粋関数が持ち、ここは契約の保存・制御メンション・git を結ぶ。
import { randomUUID } from 'node:crypto';
import {
  REVIEW_EVIDENCE_NOTE_PREFIX, approvalNote, planFiling, reviewEvidenceNote, scoutBoardView, sendBackCount,
} from '../board.js';
import { resolveAutonomy, resolveVerifyCommand } from '../config.js';
import { approvalBoard, bindContract, formatContractTag, reviewRemarks, validateContract } from '../contract.js';
import {
  reviewApprovalSection, sendBackMessage, sendControlMention, sendSafe, stripFooterControls,
} from '../mentions.js';
import { abandonApplyTask, findApplyProposal, mergeApplyTask } from '../orgapply-wiring.js';
import { scrubEnv } from '../proc.js';
import {
  awaitingReplays, formatReplaySummary, isReplayTask, pickReplayCases, planReplaySettle, replayTaskSpec, resolveReplayBase,
} from '../replay.js';
import { formatReviewEvidence, measureReviewEvidence, runTestFile } from '../review-evidence.js';
import {
  SEND_BACK_JOB_BUDGET,
  isTaskDone,
  pickAnnouncer,
  pickWorker,
  planApproval,
  planReissueReview,
  planReview,
  proposedTasks,
  touchesHarness,
  touchesThemes,
} from '../scheduler.js';
import { sanitizeForDisplay } from '../toolrules.js';
import { formatVerifyFailureReason } from '../verify.js';
import { planTaskCleanup, releaseWorktree, runGit, sameWorktreePath } from '../worktree.js';

/**
 * レビューの証拠の行の上限。落ちた検証の段 (1200)・承認時の備考 (2500) と合わせて、
 * レビュー契約の本文 (6000) に収まる長さにする
 */
export const MAX_REVIEW_EVIDENCE_CHARS = 1200;

/** レビューの証拠を history note に残すときの頭 (正本は src/board.js — 読み直す側と同じ文字列を使う) */
export { REVIEW_EVIDENCE_NOTE_PREFIX };

/**
 * チャンネルの verify が `node --test` を使うか。**純粋**。証拠は変更したテストを `node --test` で
 * 1 ファイルずつ走らせて取るので、vitest / pytest のチャンネルで測ると全部が「HEAD でも落ちる」の
 * 誤った証拠になる。`npm test` の中身 (package.json) までは追わない — 書かれたコマンドだけを見る
 */
export function usesNodeTest(command) {
  return /(?:^|[\s;&|(])node(?:\.exe)?(?:\s+-\S+)*\s+--test(?=\s|$)/.test(String(command ?? ''));
}

/** 2 行目が空なら 1 行のまま返す (何もしなかった掃除で空行を作らない) */
export function joinNote(head, extra) {
  return extra ? `${head}\n${extra}` : head;
}

/** ボードのタスク → レビュー契約の提示欄 */
export function reviewTarget(task) {
  const item = {
    id: String(task.id),
    title: String(task.title),
    branch: String(task.branch || `task/${task.id}`),
  };
  if (Number.isSafeInteger(task.jobBudget) && task.jobBudget > 0) item.job_budget = task.jobBudget;
  return item;
}

/** ボードのタスク → 承認契約の提示欄 1 件 (空文字は載せない — 様式が空文字を拒む) */
export function approvalItem(task) {
  const item = { id: String(task.id), title: String(task.title) };
  const rationale = String(task.rationale ?? '').trim();
  if (rationale) item.rationale = rationale;
  // 重複を見つける材料 (§9.3)。宣言が無ければ載せない (空配列は様式が拒む)
  if (Array.isArray(task.touch) && task.touch.length > 0) item.touch = [...task.touch];
  if (Number.isSafeInteger(task.jobBudget) && task.jobBudget > 0) item.job_budget = task.jobBudget;
  return item;
}

/** rev を完全 OID に解決する (無ければ null — 「無い」と「git が動かない」は区別しない) */
async function revParseOid(repoRoot, rev) {
  try {
    return String(await runGit(repoRoot, ['rev-parse', '--verify', rev])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * `a` が `b` の祖先か。**答えが no (終了コード 1) と、git が動かなかった (128 など) を分ける** —
 * 混ぜると「枝が無い」を「取り込まれていない」と読んでしまい、診断が 1 段ずれる。
 * @returns {Promise<boolean|null>} null = 確かめられなかった
 */
async function isAncestor(repoRoot, a, b) {
  try {
    await runGit(repoRoot, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    return err?.exitCode === 1 ? false : null;
  }
}

/**
 * merge の申告 (`merge_commit`) を照合するための git の事実 (§12.3 (2))。
 *
 * ここは**集めるだけ**で判断はしない (判断は planReview)。確かめられなかったものは
 * null / false のまま返す — 「読めなかった」を「真」に倒すと、検収の申告だけで
 * merged が書ける状態に戻る (docs/reviews/2026-09-06-product-health.md D1)。
 */
async function collectMergeFacts({ repoRoot, sha, baseBranch, branch }) {
  const facts = {
    commit: null, commitInBase: null, branchTip: null, branchTipInCommit: null,
    baseBranch, baseHead: null, branch,
  };
  if (!sha) return facts;
  facts.commit = await revParseOid(repoRoot, `${sha}^{commit}`);
  facts.baseHead = await revParseOid(repoRoot, `refs/heads/${baseBranch}`);
  if (facts.commit) facts.commitInBase = await isAncestor(repoRoot, facts.commit, `refs/heads/${baseBranch}`);
  if (branch) facts.branchTip = await revParseOid(repoRoot, `refs/heads/${branch}^{commit}`);
  if (facts.commit && facts.branchTip) {
    facts.branchTipInCommit = await isAncestor(repoRoot, facts.branchTip, facts.commit);
  }
  return facts;
}

/**
 * 適用 task (org-apply) の検収で `merge_commit` が指しているものを照合する (§12.3 (2))。
 *
 * **この経路では merge を打つのはブリッジ自身** (`mergeApplyTask`) なので、検収の時点で
 * マージコミットはまだ存在しない。reviewer が書けるのは**検収した commit** =
 * receipt の `appliedCommit` (作業ツリーの HEAD。案内に短縮 12 桁が載る) だけ、と
 * Fable が裁定した (2026-09-07)。**受け取り側で一致を確かめる** — 確かめないと、
 * 様式が SHA を要求するようになったぶん「何か 16 進を書けば通る」になる。
 *
 * 前方一致で見るのは、案内が短縮 OID を出すため (`abc123def456` ⊂ 完全 OID)。
 *
 * @returns {string|null} 適用してはいけない理由 (通ってよければ null)
 */
function checkAppliedCommit({ contract, proposal, task }) {
  const applied = String(proposal?.receipt?.appliedCommit ?? '').trim().toLowerCase();
  const declared = String(contract?.merge_commit ?? '').trim().toLowerCase();
  // receipt が無い (旧レコード・適用の記録が落ちた) ときは照合できない = 適用しない。
  // 「確かめられない」を「確かめた」へ倒さないのは §12.3 (2) の全体方針と同じ
  if (applied !== '' && declared !== '' && applied.startsWith(declared)) return null;
  return `⚠️ 適用タスク #${task.id} の検収 commit が receipt (${applied ? applied.slice(0, 12) : '未記録'}) と一致しません`
    + ' — 判定を適用していません'
    + '\n(適用 task では `merge_commit` に**検収した commit** を書いてください — 依頼の案内に出ている OID)';
}

/**
 * そのタスクを**実装した bot** (§12.3 (2) の「worker 本人には通させない」用)。
 *
 * 着手 (`in-progress`) の `by` はスケジューラ自身なので、bot キーとして残るのは
 * 完了報告でレビューへ進めた `review` の `by` — 実装した本人の唯一の記録がここにある。
 * 起動していない bot キーまで拾わないよう、呼び出し側の判定 (`known`) で絞る。
 */
function taskWorkerKeys(task, known) {
  const keys = new Set();
  for (const entry of Array.isArray(task?.history) ? task.history : []) {
    // `in-progress` への遷移は見ない — 着手はスケジューラ、差し戻しは**検収担当**が打つので、
    // そこを拾うと差し戻した reviewer が「実装した本人」になり 2 回目の判定が通らない
    // (Fable 修正 2026-09-07: test/bridge-board.test.js の send-back 2 回目で顕在化)
    if (entry?.to !== 'review') continue;
    const by = String(entry.by ?? '').trim();
    if (by && known(by)) keys.add(by);
  }
  return keys;
}

/**
 * @param {object} deps
 * @param {string} deps.root                  このリポジトリの根 (org-apply の merge は本体で打つ)
 * @param {object|null} deps.board
 * @param {Map<string, object>} deps.bots
 * @param {import('../store.js').ContractStore} deps.contracts
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {import('../store.js').PauseStore} deps.pauseStore
 * @param {object|null} deps.proposals
 * @param {(options: object) => Promise<void>} deps.notifyDutyEvent 組織の観測点を duty へ配る (src/bridge/scheduler.js)
 * @param {(threadId: string, botKey: string, kind: string) => void} deps.setContractKindOverride
 * @param {(threadId: string, botKey: string) => string|null} deps.claimContractKindOverride
 * @param {(cc: object) => string} deps.contractCwd
 * @param {(channel: object) => object|null} deps.channelConfigFor
 * @param {() => object|null} deps.safeProposalContext 提案のゲートが見る外部状態 (読めなければ null)
 * @param {(task: object) => Promise<string>} deps.releaseApplyWorktree 失敗した適用の枝を解放する (src/bridge/orgapply.js)
 * @param {string[]} [deps.scrubEnvKeys] レビューの証拠を測る子のテストから外す env (bot の token。runVerify と同じ)
 * @param {Function} [deps.measureEvidence] レビューの証拠を測る実体 (テストで差し替える)
 */
export function createBoardWiring({
  root: ROOT, board, bots, contracts, hops, pauseStore, proposals, notifyDutyEvent,
  setContractKindOverride, claimContractKindOverride, contractCwd, channelConfigFor,
  safeProposalContext, releaseApplyWorktree, scrubEnvKeys = [],
  measureEvidence = measureReviewEvidence,
  git = runGit,
}) {
  /**
   * 検査を通った起票をボードへ載せる (§3.3)。
   *
   * **承認はしない。** proposed のまま積むところまでで、着手できるようになるのは
   * 承認を経てから (承認回路は M0-7)。
   *
   * **載せる前に制動をかける** (§9.1(b) / §9.2(a) — 判断は `planFiling`)。
   * 既にあるタスクと同じファイルを掴む起票は載せず、枠 (maxOpenTasks) を超えた分は
   * 次の巡回へ回す。どちらもボードには触らないので、次の巡回でまた起票できる。
   *
   * @returns {string} スレッドへ出す 1 行
   */
  async function fileProposal({ contract, cc, bot, thread }) {
    const autonomy = resolveAutonomy(cc);
    const wanted = proposedTasks(contract, {
      channel: cc.channelName,
      taskJobBudget: autonomy.taskJobBudget,
    });
    if (!board) {
      return '⚠️ 起票を受け取りましたが、このプロセスはボードを持っていません '
        + '(このチャンネルで autonomy.enabled が有効になっていない)';
    }
    if (wanted.length === 0) return '🌱 起票なし (0 件も正しい報告です)';

    // ハーネスの改訂 (提案役が出した、役割文を触る起票) はスカウトの枠を使わない —
    // 枠が埋まっていると、測り終えた改訂を出す番が来ないまま提案役の job だけが空振りする。
    // 企画の巡回の起票 (主題ファイルだけを触る) も同じ理由で枠の外
    const harnessFiling = autonomy.harness?.bot === bot.key && wanted.every(touchesHarness);
    const themeFiling = autonomy.planner?.bot === bot.key
      && wanted.every((task) => touchesThemes(task, autonomy.planner.themesFile));
    const plan = planFiling({
      wanted,
      openTasks: board.list({ channel: cc.channelName }),
      maxOpenTasks: harnessFiling || themeFiling ? Number.MAX_SAFE_INTEGER : autonomy.scout?.maxOpenTasks,
    });

    const filed = [];
    const failed = plan.rejected.map(({ task, reason }) => `${task.title}: ${reason}`);
    for (const task of plan.file) {
      try {
        filed.push(board.propose(task, { by: bot.key }));
      } catch (err) {
        failed.push(`${task.title}: ${err.message}`);
        console.error(`[scheduler] ${cc.channelName}: 起票に失敗 — ${err.message}`);
      }
    }
    const notes = [
      filed.length > 0
        ? `🌱 ボードへ ${filed.length} 件起票しました (承認待ち): `
          + filed.map((task) => `#${task.id} ${task.title}`).join(' / ')
        : '🌱 起票できたものはありません',
    ];
    if (failed.length > 0) notes.push(`⚠️ 載せられなかったもの: ${failed.join(' / ')}`);
    if (plan.deferred.length > 0) {
      notes.push(
        '⏭ 枠不足で見送り — 次の巡回で再起票可: '
        + plan.deferred.map((task) => task.title).join(' / '),
      );
    }
    // 1 件も載らなかったら承認するものが無い (承認 job を空振りさせない)
    if (filed.length > 0) notes.push(await requestApproval({ filed, cc, autonomy, bot, thread }));
    return notes.join('\n');
  }

  /**
   * verify が最終 NG だった job を、板タスクとしてどこへ回すか (§12.3 (3) の (ii))。
   *
   * **見るのは「verify が通っていれば完了報告だったか」だけ。** 通っていれば完了だった
   * ものは、直す番を決める相手が投げ手ではなく**レビュー担当**になる (壊れたものを次の
   * 実装へ流さない門はそのままに、指摘を返せる相手へ渡す)。途中報告・エスカレーション・
   * 担当外の報告は従来どおり投げ手へ戻すので、ここでは `null` を返す。
   *
   * 判断だけを返して board は動かさない — 実際に進めるのは配送後の
   * `noteTaskCompletion` で、配信できなかった job でタスクを進めないため。
   *
   * @returns {'review'|null} 'review' = 配送後にレビューへ回す経路
   */
  function taskVerifyRoute({ thread, bot, cc, contractOut, mention }) {
    if (!board) return null;
    const task = board.findByThread(thread.id);
    const autonomy = resolveAutonomy(cc);
    return isTaskDone({
      kind: contractOut?.kind,
      hasHandoff: Boolean(mention),
      // **ここだけ verify を通ったことにして評価する** (それ以外の条件は完了判定と同じ)
      verifyOk: true,
      taskState: task?.state ?? null,
      botKey: bot.key,
      workerBotKeys: Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : [],
    }) ? 'review' : null;
  }

  /**
   * 起票が載ったら承認 job を起こす (§3.2 裁定: 起票 Opus・承認 Fable)。
   *
   * **enqueue は呼ばない。** 契約を保存して制御メンションを投げるだけで、あとは
   * 人間が handoff したときと同じ MessageCreate 経路が動く。job はチャンネルの
   * レーンで直列化されるので、この投稿の時点ではまだスカウトの本文が出ていなくても、
   * 承認 job が読むころにはスレッドに並んでいる。
   *
   * 予算を 1 積むのは、無人スレッドの門番を通らせるため (承認 job も bot 起点)。
   *
   * @returns {Promise<string>} スレッドへ出す 1 行
   */
  async function requestApproval({ filed, cc, autonomy, bot, thread }) {
    const stay = ' — proposed のまま残ります (次の巡回の一覧には出ます)';
    // kill switch (§3.7)。**ボードはそのまま**にして召喚だけ止める —
    // 起票を取り消すと、再開したときに巡回からやり直すことになる
    if (pauseStore.paused) {
      console.log(`[pause] ${cc.channelName}: 停止中のため承認を召喚しませんでした`);
      return `⏸ 自律運転が停止中のため承認を召喚していません${stay}`;
    }
    const reviewerKey = autonomy.reviewer;
    const reviewer = reviewerKey ? bots.get(reviewerKey) : null;
    if (!reviewer?.userId) {
      console.error(
        `[scheduler] ${cc.channelName}: 承認担当が起動していません (reviewer: ${reviewerKey ?? '未設定'})`,
      );
      return `⚠️ 承認担当 (${reviewerKey ?? '未設定'}) が起動していないため承認を頼めません${stay}`;
    }
    const via = announcerFor({ targetKey: reviewerKey, autonomy, bot, thread });
    if (!via) {
      console.error(`[scheduler] ${cc.channelName}: 承認メンションを投げられる bot が居ません`);
      return `⚠️ 承認メンションを投げられる bot が居ません${stay}`;
    }

    const checked = validateContract('task-approval', {
      body: `起票 ${filed.length} 件の承認をお願いします`,
      approve: [],
      drop: [],
      pending: filed.map(approvalItem),
      // 重複を見つける材料 (§9.3)。**今回の起票は除く** — 既に proposed でボードに
      // 載っているので、そのまま渡すと参考欄に自分自身が並ぶ
      board: approvalBoard(scoutBoardView(board.list({ channel: cc.channelName })), {
        excludeIds: filed.map((task) => task.id),
      }),
    });
    if (!checked.ok) {
      console.error(`[scheduler] ${cc.channelName}: 承認の契約が様式に合いません — ${checked.reason}`);
      return `⚠️ 承認の契約を組み立てられませんでした (${checked.reason})${stay}`;
    }
    // nonce は**投稿より前に**決めて契約と制御メッセージの両方へ載せる (T6 の流儀)
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    const entry = bindContract({
      id: randomUUID(),
      nonce,
      kind: 'task-approval',
      contract: checked.contract,
      threadId: thread.id,
      // **投げ手で束縛する。** claim は「制御メンションを投稿した bot == fromBotKey」で
      // 契約を結ぶ (ContractStore.claim) ので、自分宛のときに別 bot から投げる
      // (announcerFor) 経路では bot.key だと永久に結ばれない。ふつうは via.key === bot.key
      fromBotKey: via.key,
      toBotKey: reviewerKey,
      cwd: contractCwd(cc),
      channelName: cc.channelName,
      at: new Date().toISOString(),
    });
    if (!entry) return `⚠️ 承認の契約を束縛できませんでした${stay}`;
    try {
      contracts.push(thread.id, reviewerKey, entry);
    } catch (err) {
      return `⚠️ 承認の契約を保存できませんでした (${err.message})${stay}`;
    }
    hops.grantTaskBudget(thread.id, 1);
    // **種別も被せる。** reviewer の役割文が宣言しているのは delegation なので、
    // 上書きが無いと承認 job の応答は delegation として検査され、applyApproval の枝に
    // 一度も入らない = 起票が永遠に proposed のまま残る (Fable 指摘 2026-08-28)
    setContractKindOverride(thread.id, reviewerKey, 'task-approval');
    try {
      await sendControlMention(via.channel, { userId: reviewer.userId }, {
        suffix: formatContractTag(nonce),
      });
    } catch (err) {
      // 起動しなかった契約を残すと、宛先の未消費キューを埋めて次の委譲が保存できなくなる。
      // 種別の上書きも同じ理由で戻す — 残すとそのスレッドで次に走った
      // 無関係な job が task-approval で検査される
      contracts.removeById(thread.id, reviewerKey, entry.id);
      claimContractKindOverride(thread.id, reviewerKey);
      console.error(`[scheduler] ${cc.channelName}: 承認メンションの投稿に失敗: ${err.message}`);
      return `⚠️ 承認メンションの投稿に失敗しました (${err.message})${stay}`;
    }
    console.log(
      `[scheduler] ${cc.channelName}: 承認を ${reviewerKey} へ依頼`
      + ` (thread ${thread.id} / ${filed.length} 件 / 投稿は ${via.key})`,
    );
    return `📋 ${reviewer.cfg.displayName} に承認を依頼しました (承認されたものだけが着手されます)`;
  }

  /**
   * worker の完了報告を見てタスクをレビューへ進め、レビューを召喚する (§3.5 → §3.6)。
   *
   * **完了の定義は「制御フッタの無い report」。** 自己呼び出しで区切った途中報告や
   * 上位へのエスカレーション (どちらもフッタがある) は仕事が続いているので進めない。
   * verify が落ちている報告も完了ではない — handoff が止まっているだけで、直す番。
   *
   * **数えるのは担当 (worker) の報告だけ** (2026-09-01 裁定)。誰の報告でも完了にすると、
   * レビュー担当や元請けが同じスレッドで報告しただけでタスクが review へ進み、
   * そこで自己レビュー禁止に当たって契約が作られない = 誰も動かせない状態になる (#46)。
   */
  /**
   * @returns {Promise<{submitted: boolean, summoned: boolean}>}
   *   `submitted` = レビューへ進めたか (実行記録の「次に動く主体」に使う)、
   *   `summoned` = レビュー担当を実際に呼べたか (false なら呼び出し側が人間へ倒す)
   */
  async function noteTaskCompletion({
    thread, bot, cc, contractOut, mention, verifyResult, route = null, handle,
  }) {
    const nothing = { submitted: false, summoned: false };
    if (!board) return nothing;
    const task = board.findByThread(thread.id);
    const autonomy = resolveAutonomy(cc);
    const workerBotKeys = Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : [];
    const signals = {
      kind: contractOut?.kind,
      hasHandoff: Boolean(mention),
      verifyOk: !verifyResult || verifyResult.ok === true,
      taskState: task?.state ?? null,
    };
    // **verify NG でも「通っていれば完了報告だった」ものはレビューへ回す** (§12.3 (3) の (ii))。
    // 壊れたものを次の実装へ流さない門はそのままに、直す番を決められる相手へ渡す —
    // 投げ手 (元請け) へ戻すと、指摘を書く役が居ないまま人間の再起動を待つことになる。
    //
    // **決めるのは呼び出し側** (`route`)。配送の前に「戻しを出さない」と決めた側と
    // ここが別々に判断すると、片方だけが倒れたときに**戻しとレビュー召喚の両方**が
    // 起きる (Opus2 指摘 2026-09-18)。`route` を渡さなければ従来どおり投げ手へ戻る。
    // ここで同じ条件をもう一度見るのは、配送の間に板が動いていた場合の歯止め
    const verifyFailed = Boolean(verifyResult && verifyResult.ok === false);
    const routed = route === 'review' && verifyFailed
      && isTaskDone({ ...signals, verifyOk: true, botKey: bot.key, workerBotKeys });
    if (!routed && !isTaskDone({ ...signals, botKey: bot.key, workerBotKeys })) {
      // **担当外の報告は完了に数えないが、黙って落とさない。** #46 は reviewer の
      // フッタ無し報告が完了扱いになり、自己レビュー禁止で契約が作られないまま
      // review に固着した — 何が起きなかったのかがスレッドに残っていなかった。
      // **物差しは `routed` と揃える** (`verifyOk: true`) — verify NG の担当外報告でも
      // 「なぜ完了に数えなかったのか」が要る (Opus2 指摘 2026-09-18)
      if (isTaskDone({ ...signals, verifyOk: true })) {
        await sendSafe(
          thread,
          `⚠️ 担当 (${workerBotKeys.join(' / ') || '未設定'}) 以外の報告なので完了とは数えません`
          + ' — 続きは担当をメンションしてください',
        ).catch(() => {});
      }
      return nothing;
    }

    // レビュー担当は本体で走るので、作業ツリーの src を戻して測るのは**召喚より先**に済ませる
    const evidence = await collectReviewEvidence({ task, cc, autonomy, handle });
    // 解き直し (src/replay.js) は merge しない — 結果を残して取り下げる。改訂のレビューは tick が呼ぶ
    if (isReplayTask(task)) return finishReplay({ task, bot, thread, evidence, verifyFailed: routed });
    // 役割文を触ったタスク (ハーネスの改訂) は、下書きの役割文で過去のタスクを解き直してからレビューを呼ぶ。
    // verify NG のままの提出は解き直さない (壊れた下書きを試しても材料にならない)
    const replayPlan = routed ? null : await planRevisionReplays({ task, cc, autonomy });
    const replayRecord = !replayPlan ? null
      : replayPlan.none
        ? { status: 'none', reason: replayPlan.none }
        : { status: 'running', startedAt: new Date().toISOString() };
    let submitted;
    try {
      submitted = board.submitForReview(task.id, {
        by: bot.key,
        ...(evidence ? { note: `${REVIEW_EVIDENCE_NOTE_PREFIX}${evidence}` } : {}),
        ...(replayRecord ? { patch: { replay: replayRecord } } : {}),
      });
    } catch (err) {
      console.error(
        `[scheduler] ${cc.channelName}: タスク ${task.id} をレビューへ進められません: ${err.message}`,
      );
      return nothing;
    }
    if (replayRecord?.status === 'running') {
      const started = startReplays({ revision: submitted, ready: replayPlan.ready, jobBudget: replayPlan.jobBudget, cc });
      if (started.length > 0) {
        const hours = Math.round(autonomy.harness.replay.timeoutMin / 60);
        const skipped = replayPlan.skipped.length > 0 ? `\n解き直せなかった: ${replayPlan.skipped.join(' / ')}` : '';
        await sendSafe(
          thread,
          (`🔎 タスク #${submitted.id} をレビューへ進めました — 役割文の改訂なので、下書きの役割文で過去のタスクを`
            + `解き直してからレビューを呼びます: ${started.join(' / ')} (待つ上限 ${hours} 時間)${skipped}`).slice(0, 1900),
        ).catch(() => {});
        // 召喚は先送り (解き直しが落ち着いたら tick が呼ぶ)。人間へ倒さない
        return { submitted: true, summoned: true };
      }
      // 1 件も立てられなかった — 待つ物が無いので、そのままレビューを呼ぶ
      submitted = board.setReplay(submitted.id, { status: 'none', reason: '解き直しのタスクを立てられなかった' });
    }
    // 差し戻しの材料は**呼ぶ側が渡す** — レビュー担当は「何が落ちたか」を知らないと
    // 指摘を書けない (契約の本文にコマンドと末尾数行が載る)
    const sent = await requestReview({
      task: submitted, cc, autonomy, bot, thread, verifyResult: routed ? verifyResult : null, evidence,
      replaySummary: formatReplaySummary(submitted, board.list({ channel: cc.channelName })),
    });
    const head = routed
      ? `🔎 タスク #${submitted.id} を verify NG のままレビューへ回しました`
      : `🔎 タスク #${submitted.id} をレビューへ進めました`;
    await sendSafe(thread, `${head}\n${sent.note}`.slice(0, 1900)).catch(() => {});
    return { submitted: true, summoned: sent.ok === true };
  }

  /**
   * レビューへ進む回に、task の作業ツリーでレビューの証拠を測る (src/review-evidence.js)。
   * 測るのは作業ツリーで走る task で、チャンネルの verify が `node --test` のときだけ —
   * 本体では測らない (レビュー担当や稼働中のプロセスが変更前の src を読む) し、
   * 別のテストランナーのチャンネルでは誤った証拠になる。条件外は null。
   *
   * **fail-open**: 投げても断られても「測れませんでした — 理由」の行を返すだけで、
   * レビューへ進めること・召喚・job の終わり方は変えない。子のテストには bot の token を
   * 渡さない (ブランチ側のテストは task が書いたコード — runVerify と同じ外し方)
   *
   * `handle` は job の停止の口 (省略可)。/stop・/restart で止まった測定は src と test/ を HEAD へ戻して
   * `stopped` を返し、「停止で中断」の行になる — それでもレビューへ進めて召喚する (fail-open のまま)
   *
   * @returns {Promise<string|null>} 契約の本文と history note に載せる行 (上限で切る)
   */
  async function collectReviewEvidence({ task, cc, autonomy, handle }) {
    if (!cc.repoRoot || sameWorktreePath(cc.cwd, cc.repoRoot)) return null;
    if (!usesNodeTest(resolveVerifyCommand(cc))) return null;
    const env = scrubEnv(process.env, scrubEnvKeys);
    let text;
    try {
      const result = await measureEvidence({
        cwd: cc.cwd,
        base: autonomy.baseBranch,
        handle,
        runTest: (options) => runTestFile({ ...options, env }),
      });
      text = result?.outcome === 'refused'
        ? `測れませんでした — ${result.reason}`
        : formatReviewEvidence(result);
    } catch (err) {
      text = `測れませんでした — ${err.message}`;
    }
    console.log(`[review-evidence] ${cc.channelName}: タスク ${task.id} — ${text.split('\n')[0]}`);
    return text.length > MAX_REVIEW_EVIDENCE_CHARS ? `${text.slice(0, MAX_REVIEW_EVIDENCE_CHARS)}…` : text;
  }

  /**
   * 役割文を触ったタスク (ハーネスの改訂) を下書きで解き直すかと、何を解き直すか (src/replay.js)。
   * 対象外 (役割文を触らない・既に記録がある・ハーネスの巡回が無い・件数が 0) は null、
   * 解き直せないときは `{none: 理由}`。基点は git で決める (決まらないものは skipped)
   */
  async function planRevisionReplays({ task, cc, autonomy }) {
    if (!touchesHarness(task) || task.replay || !autonomy.harness?.bot) return null;
    const { cases, canary, jobBudget } = autonomy.harness.replay;
    if (cases + canary === 0) return null;
    // 解き直すのは worker なので、worker が読む役割文 (共通規定 + worker の役割文) を触る改訂だけ。
    // レビュー担当の役割文だけの改訂を worker で解き直しても、読まない文面を試すことになる
    const workerRoles = new Set(['roles/_common.md']);
    for (const key of Array.isArray(autonomy.worker?.bots) ? autonomy.worker.bots : []) {
      const file = bots.get(key)?.cfg?.rolePromptFile;
      if (typeof file === 'string' && file.trim() !== '') workerRoles.add(file.trim().replaceAll('\\', '/'));
    }
    if (!(task.touch ?? []).some((f) => workerRoles.has(String(f).trim().replaceAll('\\', '/')))) {
      return { none: '解き直しの worker が読む役割文 (共通規定・worker の役割文) を触っていない改訂' };
    }
    const repoRoot = cc.repoRoot ?? cc.cwd;
    // 解き直しの job は改訂の作業ツリーの役割文を読む (src/bridge/job.js)。役割文はブリッジのリポジトリに
    // あるので、改訂のタスクがブリッジ自身のリポジトリで走っているときだけ解き直せる
    if (!sameWorktreePath(repoRoot, ROOT)) {
      return { none: '改訂のタスクがブリッジのリポジトリの外で走っている (下書きの役割文を読めない)' };
    }
    const picked = pickReplayCases(task, board.list({ channel: cc.channelName }), { cases, canary });
    const ready = [];
    const skipped = [];
    for (const item of picked) {
      const base = await resolveReplayBase({ repoRoot, merge: item.merge, git });
      if (base) ready.push({ ...item, base });
      else skipped.push(`#${item.task.id} (元のタスクが始まった版を決められない)`);
    }
    if (ready.length === 0) {
      return {
        none: picked.length === 0
          ? '理由に名指しされた差し戻しのタスクが無く、カナリアの候補も無い'
          : `元のタスクが始まった版を決められない — ${skipped.join(' / ')}`,
      };
    }
    return { ready, skipped, jobBudget };
  }

  /**
   * 解き直しのタスクを立てて承認まで済ませる (着手は次の tick の start-task)。承認の備考は元のタスクのものを
   * 写す — worker には元のタスクと同じ依頼が届く。立てたものを「#201 (差し戻しの再現 #148)」の形で返す。
   * 1 件の失敗で残りを止めない (立った分だけで解き直す)
   */
  function startReplays({ revision, ready, jobBudget, cc }) {
    const started = [];
    for (const item of ready) {
      const spec = replayTaskSpec(item, { revisionId: revision.id, base: item.base, jobBudget });
      try {
        const made = board.propose(spec.proposal, { by: 'scheduler' });
        board.approve(made.id, { by: 'scheduler', note: approvalNote(item.task).note ?? '', patch: { replay: spec.replay } });
        started.push(`#${made.id} (${item.kind === 'canary' ? 'カナリア' : '差し戻しの再現'} #${item.task.id})`);
      } catch (err) {
        console.error(`[replay] ${cc.channelName}: #${revision.id} の解き直し (#${item.task.id}) を立てられません: ${err.message}`);
      }
    }
    if (started.length > 0) console.log(`[replay] ${cc.channelName}: #${revision.id} の下書きを解き直す — ${started.join(' / ')}`);
    return started;
  }

  /**
   * 解き直しの worker の完了 (src/replay.js)。merge せずに、結果 (証拠と verify) を replay 欄に残して
   * 取り下げる。作業ツリーとブランチはここでは片付けない — 改訂のレビューを呼ぶときに作業ツリーだけ
   * 撤去し、ブランチはレビュー担当が差分を読むので残す (settleReplays)
   */
  async function finishReplay({ task, bot, thread, evidence, verifyFailed }) {
    const outcome = { result: verifyFailed ? 'verify-ng' : 'submitted', evidence: evidence ?? null, at: new Date().toISOString() };
    try {
      board.transition(task.id, 'dropped', {
        by: bot.key,
        note: `解き直しの結果を残して取り下げ (改訂 #${task.replay.of} の下書きの検証)`,
        patch: { replay: { ...task.replay, outcome } },
      });
    } catch (err) {
      console.error(`[replay] タスク ${task.id} の解き直しの結果を残せません: ${err.message}`);
      return { submitted: false, summoned: false };
    }
    await sendSafe(
      thread,
      `🔁 解き直しの結果を残しました — 改訂 #${task.replay.of} のレビューの依頼に載ります (merge はしません。`
        + `ブランチ ${task.branch || `task/${task.id}`} は差分を読むために残します)`,
    ).catch(() => {});
    // 次に動くのは改訂のレビュー (tick が呼ぶ)。人間へ倒さない
    return { submitted: false, summoned: true };
  }

  /**
   * 解き直しを待っている改訂のうち、落ち着いた (か期限が来た) ものについてレビューを呼ぶ (tick から)。
   * 期限で打ち切る解き直しは結果「期限切れ」で取り下げる。解き直しの作業ツリーは撤去する
   * (ブランチは残る — planTaskCleanup の drop)。**印を付けてから呼ぶ** — 呼べなくても次の tick で
   * 二重に呼ばない。呼べなかった改訂は見回りが「レビュー契約が無い」で拾い、`/review` で出し直せる
   *
   * @param {{channelName: string, autonomy: object, now?: number}} p
   */
  async function settleReplays({ channelName, autonomy, now = Date.now() }) {
    if (!board || pauseStore.paused) return;
    const plans = planReplaySettle(board.list({ channel: channelName }), {
      now, timeoutMs: autonomy.harness.replay.timeoutMin * 60 * 1000,
    });
    for (const plan of plans) {
      const at = new Date(now).toISOString();
      for (const left of plan.unsettled) {
        try {
          board.transition(left.id, 'dropped', {
            by: 'scheduler',
            note: `解き直しの期限切れ (改訂 #${plan.revision.id} のレビューを先に呼ぶ)`,
            patch: { replay: { ...left.replay, outcome: { result: 'timeout', evidence: null, at } } },
          });
        } catch (err) {
          console.error(`[replay] ${channelName}: 解き直し #${left.id} を打ち切れません: ${err.message}`);
        }
      }
      // 止まった (blocked) 解き直しも閉じる — 残すと /inbox の「要人間」に載り続ける。blocked から出る辺は
      // approved だけなので、取り下げの前段として通す (同じ同期区間なので、間に着手は挟まらない)
      for (const stuck of plan.replays.filter((t) => t.state === 'blocked')) {
        try {
          board.transition(stuck.id, 'approved', { by: 'scheduler', note: '止まった解き直しを閉じる (取り下げの前段)' });
          board.transition(stuck.id, 'dropped', {
            by: 'scheduler',
            note: `止まった解き直しを閉じる (改訂 #${plan.revision.id} のレビューを呼ぶ)`,
            patch: { replay: { ...stuck.replay, outcome: { result: 'blocked', evidence: null, at } } },
          });
        } catch (err) {
          console.error(`[replay] ${channelName}: 止まった解き直し #${stuck.id} を閉じられません: ${err.message}`);
        }
      }
      let revision;
      try {
        revision = board.setReplay(plan.revision.id, { ...plan.revision.replay, status: 'done', how: plan.how, doneAt: at });
      } catch (err) {
        console.error(`[replay] ${channelName}: 改訂 #${plan.revision.id} の解き直しを閉じられません: ${err.message}`);
        continue;
      }
      const available = [...bots.values()].filter((b) => b.userId).map((b) => b.key);
      const bot = bots.get(pickAnnouncer(autonomy.reviewer, autonomy, available) ?? '') ?? null;
      const thread = bot && revision.threadId
        ? bot.client?.channels?.cache?.get(revision.threadId)
          ?? await bot.client?.channels?.fetch?.(revision.threadId)?.catch?.(() => null) ?? null
        : null;
      const cc = thread ? channelConfigFor(thread) : null;
      if (!bot || !thread || !cc) {
        console.error(`[replay] ${channelName}: 改訂 #${revision.id} のスレッドを取れずレビューを呼べません — /review ${revision.id} で出し直してください`);
        continue;
      }
      const tasks = board.list({ channel: channelName });
      for (const replay of tasks.filter((t) => isReplayTask(t) && t.replay.of === String(revision.id))) {
        const line = await cleanupTaskWorktree({ cc, task: replay, action: 'drop' });
        if (line) console.log(`[replay] ${channelName}: #${replay.id} ${line}`);
      }
      const sent = await requestReview({
        task: revision, cc, autonomy, bot, thread, byWorker: false,
        evidence: reviewEvidenceNote(revision).evidence || null,
        replaySummary: formatReplaySummary(revision, tasks),
      });
      const head = plan.how === 'timeout'
        ? `🔎 下書きの解き直しの期限が来たので、タスク #${revision.id} のレビューを呼びます`
        : `🔎 下書きの解き直しが終わったので、タスク #${revision.id} のレビューを呼びます`;
      await sendSafe(thread, `${head}\n${sent.note}`.slice(0, 1900)).catch(() => {});
    }
  }

  /**
   * レビュー担当を召喚する (§3.6)。手順は requestApproval と同じ型 —
   * 契約を保存し、予算を 1 積み、種別を被せてから制御メンションを投げる。
   * **merge を実行するのはレビュー担当の shell 仕事**で、ブリッジは git を持たない。
   *
   * **成否はここでしか分からない。** 受け手は受付時に契約を claim して消すので、
   * 呼び出し側が「契約が残っているか」で見ると、送信の完了より先にレビュー job が
   * 起動した回だけ失敗と誤判定する (sol 指摘 2026-09-01)。
   *
   * @returns {Promise<{ok: boolean, note: string}>} `ok` は召喚できたか、
   *   `note` はスレッドへ出す 1 行 (失敗の理由もここに入る)
   */
  async function requestReview({
    task, cc, autonomy, bot, thread, byWorker = true, verifyResult = null, evidence = null, replaySummary = null,
  }) {
    const stay = ' — review のまま残ります (`/review` で出し直せます)';
    if (pauseStore.paused) {
      console.log(`[pause] ${cc.channelName}: 停止中のためレビューを召喚しませんでした`);
      return { ok: false, note: `⏸ 自律運転が停止中のためレビューを召喚していません${stay}` };
    }
    const reviewerKey = autonomy.reviewer;
    const reviewer = reviewerKey ? bots.get(reviewerKey) : null;
    if (!reviewer?.userId) {
      console.error(`[scheduler] ${cc.channelName}: レビュー担当が起動していません (${reviewerKey ?? '未設定'})`);
      return { ok: false, note: `⚠️ レビュー担当 (${reviewerKey ?? '未設定'}) が起動していません${stay}` };
    }
    if (byWorker && reviewerKey === bot.key) {
      // §6 の自己レビュー禁止。設定の不備なので、黙って通さず人間へ返す。
      // **見ているのは「実装した担当 == reviewer」**なので、worker の完了報告から
      // 来た経路だけが対象。`/review` (人間の出し直し) で打った bot は実装した担当では
      // ないので、ここで断ると reviewer 自身のコマンドから永久に出し直せなくなる
      return { ok: false, note: `⚠️ 実装した担当と reviewer が同じです (自己レビューは禁止)${stay}` };
    }
    const via = announcerFor({ targetKey: reviewerKey, autonomy, bot, thread });
    if (!via) return { ok: false, note: `⚠️ レビューを呼べる bot が居ません${stay}` };

    // **落ちた検証はレビュー担当へ渡す** (§12.3 (3) の (ii))。何が落ちたのかを知らないと
    // 指摘が書けず、「verify NG」とだけ言われたレビュー job が自分で走らせ直すことになる。
    // 整形は verify.js の 1 か所を使う (Discord 記法を含まない、モデルが読む面の形)
    const failed = verifyResult && verifyResult.ok === false
      ? `\n\n⛔ ブリッジの verify が NG のままレビューへ回っています —`
        + ' 直す番を決めてください (差し戻す / 自分で直す / 受け入れる)。\n'
        + formatVerifyFailureReason(verifyResult, { maxChars: 1200 })
      : '';
    // 完了の回に作業ツリーで測った証拠 (noteTaskCompletion)。`/review` の出し直しは測らず、
    // review へ進めた回の note から読み直したものが来る (reissueReview)
    const measured = evidence
      ? '\n\nレビューの証拠 (変更したテストを変更前の src でも走らせた結果 — 判定ではなく材料。'
        + '落ちないテストは src の変更を検査していない疑い):\n' + evidence
      : '';
    // ハーネスの改訂の下書きの検証 (src/replay.js)。再発したかを読むのはレビュー担当
    const replayed = replaySummary ? `\n\n${replaySummary}` : '';
    // 承認した側が着手する人へ残した注意 (§3.2)。着手者が従ったかを見られるのはレビューだけ
    const approval = reviewApprovalSection(approvalNote(task).note);
    const checked = validateContract('task-review', {
      body: `タスク ${task.id} のレビューをお願いします${failed}${measured}${replayed}${approval}`,
      // **判定は埋め草。** 様式 (verdict 必須) を満たすためだけの値で、これが
      // 適用されることはない — 効くのはレビュー担当が返した判定だけ
      verdict: 'send-back',
      reason: '(未判定 — ブリッジが様式を満たすために埋めた欄。判定はレビュー担当が返す)',
      target: [reviewTarget(task)],
    });
    if (!checked.ok) {
      console.error(`[scheduler] ${cc.channelName}: レビュー契約が様式に合いません — ${checked.reason}`);
      return { ok: false, note: `⚠️ レビュー契約を組み立てられませんでした (${checked.reason})${stay}` };
    }
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    const entry = bindContract({
      id: randomUUID(),
      nonce,
      kind: 'task-review',
      contract: checked.contract,
      threadId: thread.id,
      // requestApproval と同じ理由で**投げ手**で束縛する (claim は投稿者と突き合わせる)。
      // `/review` を reviewer 自身の bot エントリで打つと投げ手が別 bot になる
      fromBotKey: via.key,
      toBotKey: reviewerKey,
      cwd: contractCwd(cc),
      channelName: cc.channelName,
      at: new Date().toISOString(),
    });
    if (!entry) return { ok: false, note: `⚠️ レビュー契約を束縛できませんでした${stay}` };
    try {
      contracts.push(thread.id, reviewerKey, entry);
    } catch (err) {
      return { ok: false, note: `⚠️ レビュー契約を保存できませんでした (${err.message})${stay}` };
    }
    hops.grantTaskBudget(thread.id, 1);
    setContractKindOverride(thread.id, reviewerKey, 'task-review');
    try {
      await sendControlMention(via.channel, { userId: reviewer.userId }, {
        suffix: formatContractTag(nonce),
      });
    } catch (err) {
      contracts.removeById(thread.id, reviewerKey, entry.id);
      claimContractKindOverride(thread.id, reviewerKey);
      console.error(`[scheduler] ${cc.channelName}: レビューメンションの投稿に失敗: ${err.message}`);
      return { ok: false, note: `⚠️ レビューメンションの投稿に失敗しました (${err.message})${stay}` };
    }
    console.log(
      `[scheduler] ${cc.channelName}: タスク ${task.id} のレビューを ${reviewerKey} へ依頼`
      + ` (thread ${thread.id} / 投稿は ${via.key})`,
    );
    // ここまで来たら送信は完了している。**この後に store を読んで確かめない** —
    // 受け手は受付時に契約を claim して消すので、REST の応答より先にレビュー job が
    // 起動した回だけ「契約が無い = 失敗」に見える
    return { ok: true, note: `→ ${reviewer.cfg.displayName} にレビューをお願いしました` };
  }

  /**
   * レビューの判定をボードへ適用する (§3.6)。
   * 判断は src/scheduler.js の planReview (純粋) が持ち、ここは実行と報告だけ。
   *
   * @returns {Promise<string>} スレッドへ出す 1 行
   */
  async function applyReview({ contract, cc, bot, thread }) {
    if (!board) return '⚠️ 判定を受け取りましたが、このプロセスはボードを持っていません';
    const task = board.findByThread(thread.id);
    if (!task) return '⚠️ このスレッドに対応するタスクがありません — 判定を適用していません';
    if (task.state !== 'review') {
      return `⚠️ タスク #${task.id} は ${task.state} なので判定を適用していません`;
    }
    const autonomy = resolveAutonomy(cc);
    const counted = { sendBackCount: sendBackCount(task) };

    // **検収の同一性は経路より前** (§12.3 (2)。Opus 指摘 2026-09-07 で前へ移した)。
    // 召喚時の自己レビュー禁止 (requestReview) は `様式:task-review` タグで迂回できるので、
    // 適用側にも門を置く。適用 task も同じ門を通す — org 提案を当てた本人が
    // 「検収なしで role / policy を main へ入れる」道を残さないため
    // (適用 task の review 遷移の `by` は定数 APPLY_BY で bot キーではないので、
    //  reviewer が「実装した本人」で弾かれることはない)
    if (autonomy.reviewer !== bot.key) {
      return `⚠️ タスク #${task.id} の検収担当は ${autonomy.reviewer ?? '未設定'} です`
        + ` — ${bot.key} の判定を適用していません (検収担当ではない)`;
    }
    if (taskWorkerKeys(task, (key) => bots.has(key)).has(bot.key)) {
      return `⚠️ タスク #${task.id} を実装したのは ${bot.key} です`
        + ' — 判定を適用していません (実装した本人)';
    }

    // **適用 task は経路が違う** (§3.9)。merge するのは receipt の commit OID だけで、
    // 通らなかったときの戻り先は作業ツリーではなく提案 (直す対象は diff なので、
    // 同じ枝へ差し戻しても直す担当が居ない)。取り込みの照合は planMerge が持つので、
    // ここで git の事実を要求しない (§12.3 (2) — この経路は変えない)
    const applying = proposals ? findApplyProposal(proposals, task.id) : null;
    if (applying) {
      const applyPlan = planReview(contract, { ...counted, mergeCheckedBy: 'planMerge' });
      if (applyPlan.action === 'none') return `⚠️ ${applyPlan.error} — 判定を適用していません`;
      const mismatch = contract?.verdict === 'merge'
        ? checkAppliedCommit({ contract, proposal: applying, task })
        : null;
      if (mismatch) return mismatch;
      return applyReviewForApplyTask({ plan: applyPlan, proposal: applying, task, cc, bot });
    }

    // merge の申告だけ git で裏を取る (他の判定は git に関係がない)
    const plan = planReview(contract, {
      ...counted,
      git: contract?.verdict === 'merge'
        ? await collectMergeFacts({
          repoRoot: cc.repoRoot ?? cc.cwd,
          // git の OID は小文字。様式は大文字も受ける (コピー元次第で `ABC1234` になる) ので、
          // **git へ渡す前にここで揃える** — rev-parse は大文字の 16 進を解決しない
          sha: String(contract.merge_commit ?? '').trim().toLowerCase(),
          baseBranch: autonomy.baseBranch,
          branch: String(task.branch || `task/${task.id}`),
        })
        : null,
    });
    if (plan.action === 'none') return `⚠️ ${plan.error} — 判定を適用していません`;
    // **照合できなかった merge は遷移させない。** ボードも枝も触らないので、取り込み直して
    // `/review` で出し直せば同じ道をもう一度通れる (§12.3 (2))
    if (plan.action === 'hold') {
      return `⚠️ タスク #${task.id} は review のままです — ${plan.reason}。`
        + `取り込みを確かめてから \`/review ${task.id}\` で出し直してください`;
    }

    try {
      if (plan.action === 'complete') {
        // **遷移が先・掃除は後** (§9.5)。撤去に失敗しても merged は取り消さない —
        // 成果は base へ入っているので、戻すとボードだけが現実とずれる。
        // 指摘の件数は履歴の数値の欄 (remarks) に残し、**note は 1 文字も変えない** — note は
        // 解き直しの候補選びとレビューの証拠の遡りが前後を固定した正規表現 (parseMergeNote) で
        // 読むので、末尾に足すとそのタスクが黙って対象外になる。人が読む件数は返信に添える
        const remarks = reviewRemarks(contract).length;
        board.complete(task.id, { by: bot.key, note: plan.note, historyExtra: { remarks } });
        return joinNote(
          `🎉 タスク #${task.id} を merged にしました (${plan.note}) / 指摘 ${remarks} 件`,
          await cleanupTaskWorktree({ cc, task, action: 'complete' }),
        );
      }
      if (plan.action === 'drop') {
        // 対象が不要と分かったときの後始末 (§9.4)。**duty イベントは配らない** —
        // DUTY_EVENT_KINDS に drop は無く、語彙を増やすのは config の裁定
        board.drop(task.id, { by: bot.key, reason: plan.reason });
        return joinNote(
          `🗑 タスク #${task.id} を dropped にしました: ${plan.reason}`,
          await cleanupTaskWorktree({ cc, task, action: 'drop' }),
        );
      }
      if (plan.action === 'block') {
        board.block(task.id, { by: bot.key, reason: plan.reason });
        // 要人間で止まったことは組織の観測点 (§3.9) — 宣言した duty へ配る。
        // 判定を出した本人は外す (見えるのは自分の判断であって組織の乖離ではない)
        await notifyDutyEvent({
          eventKind: 'block',
          channelName: cc.channelName,
          detail: `タスク #${task.id} が blocked`,
          excludeBotKeys: [bot.key],
        });
        return `⛔ タスク #${task.id} を要人間 (blocked) にしました: ${plan.reason}`;
      }
      board.sendBack(task.id, { by: bot.key, reason: plan.reason });
    } catch (err) {
      return `⚠️ 判定をボードへ適用できません (#${task.id}): ${err.message}`;
    }
    // 差し戻しは「直して出し直す」ぶんの予算を足してから呼ぶ (使い切ったまま呼ぶと即止まる)
    hops.grantTaskBudget(thread.id, SEND_BACK_JOB_BUDGET);
    const note = await notifySendBack({ task, cc, bot, thread, reason: plan.reason });
    // 判定を出した側と直す側は外す — 当人たちの番はこのスレッドで続いている
    await notifyDutyEvent({
      eventKind: 'send-back',
      channelName: cc.channelName,
      detail: `タスク #${task.id} が差し戻し`,
      excludeBotKeys: [bot.key, pickWorker(
        resolveAutonomy(cc),
        [...bots.values()].filter((b) => b.userId).map((b) => b.key),
      )].filter(Boolean),
    });
    return `↩️ タスク #${task.id} を差し戻しました\n${note}`;
  }

  /**
   * 適用 task の検収判定 (§3.9)。通常の task と違うのは 2 つ:
   *
   * - **merge するのは receipt の commit OID だけ** (`planMerge`)。ブランチ名で merge すると、
   *   コミットの後にその枝へ足された未承認の commit まで入る
   * - **差し戻しは提案へ戻る。** 直す対象は diff なので、新しい revision を作って
   *   再裁定を受け、承認後にきれいな枝へ当て直す (task を差し戻しても直す担当が居ない)
   */
  async function applyReviewForApplyTask({ plan, proposal, task, cc, bot }) {
    const autonomy = resolveAutonomy(cc);
    const now = Date.now();
    if (plan.action === 'complete') {
      const merged = await mergeApplyTask({
        store: proposals,
        board,
        ctx: safeProposalContext(),
        proposal,
        task,
        into: autonomy.baseBranch,
        git: (args) => runGit(ROOT, args),
        by: bot.key,
        now,
      });
      if (!merged.ok) {
        return `⚠️ 提案 #${proposal.id} を merge できませんでした: ${sanitizeForDisplay(merged.reason, 400)}`
          + ' — review のまま残ります';
      }
      const head = `🎉 提案 #${proposal.id} を ${autonomy.baseBranch} へ merge しました`
        + ` (${merged.commit.slice(0, 12)} / タスク #${task.id} は merged)`
        + (merged.trial ? '\n🧪 試用を開始しました' : `\n⚠️ ${sanitizeForDisplay(merged.reason ?? '', 200)}`);
      return joinNote(head, await cleanupTaskWorktree({ cc, task, action: 'complete' }));
    }
    if (plan.action === 'block') {
      // **要人間はそのまま止める。** 錠も当てた枝も残す — 止めたのに勝手に再裁定へ
      // 回ると、人間が見に来たときには判断の材料が消えている
      try {
        board.block(task.id, { by: bot.key, reason: plan.reason });
      } catch (err) {
        return `⚠️ 判定をボードへ適用できません (#${task.id}): ${err.message}`;
      }
      await notifyDutyEvent({
        eventKind: 'block',
        channelName: cc.channelName,
        detail: `適用タスク #${task.id} (提案 #${proposal.id}) が blocked`,
        excludeBotKeys: [bot.key],
      });
      return `⛔ 適用タスク #${task.id} を要人間 (blocked) にしました: ${plan.reason}`
        + `\n(提案 #${proposal.id} は適用中のまま — 進めるか取り下げるかは人が決めます)`;
    }
    // send-back / drop — どちらも「この適用は通らなかった」。戻し先は提案
    const reason = `検収 (${plan.action}): ${plan.reason ?? '理由の記載なし'}`;
    const abandoned = await abandonApplyTask({
      store: proposals,
      board,
      proposal,
      task,
      reason,
      verdict: plan.action,
      appliedCommit: proposal.receipt?.appliedCommit ?? null,
      verify: proposal.receipt?.verify ?? null,
      release: ({ task: dropped }) => releaseApplyWorktree(dropped),
      by: bot.key,
      now,
    });
    const head = abandoned.ok
      ? `↩️ 提案 #${proposal.id} を再裁定へ戻しました (タスク #${task.id} は dropped): ${sanitizeForDisplay(reason, 300)}`
      // **review のまま止まったものは自動では拾わない** (検収待ちと区別が付かないため)。
      // 打ち直せる操作を案内する — 同じ判定をもう一度出せば同じ道を通る
      : `⚠️ 提案 #${proposal.id} の差し戻しが途中で止まりました: ${sanitizeForDisplay(abandoned.reason, 300)}`
        + `\nタスク #${task.id} は review のまま残ります (\`/review ${task.id}\` で判定を出し直してください)`;
    return joinNote(head, abandoned.note);
  }

  /**
   * 判定のついたタスクの作業ツリーを片付ける (§9.5)。
   *
   * **ボードの遷移が済んでから呼ぶ。** 撤去は掃除であって判定の一部ではない — git が
   * 失敗したからといって merged を取り消すと、成果は base に入っているのにボードだけ戻る。
   * だからここは**例外を投げない**: 起きたことを 1 行にして返し、判定はそのまま通す。
   *
   * `repoRoot` は**リポジトリ本体**。worktree の台帳を持っているのは本体で、作業ツリー側から
   * 撤去を打つと「使用中のツリーを消す」ことになる (reviewer は本体 cwd で走るが、
   * 呼び出し元が変わっても本体を指すように `cc.repoRoot` を先に見る)。
   *
   * ブランチは `-d` で消す。**`-D` にはしない** — 未マージの commit が載っていれば git が
   * 拒否するのが正しく、押し切る判断はここに無い (拒否は note にして人へ返す)。
   *
   * @returns {Promise<string>} スレッドへ足す 1 行 (何もしなければ空文字)
   */
  async function cleanupTaskWorktree({ cc, task, action }) {
    const plan = planTaskCleanup({ action, branch: task.branch });
    if (!plan.release) return '';
    const repoRoot = cc.repoRoot ?? cc.cwd;
    let released;
    try {
      released = await releaseWorktree({
        repoRoot, taskId: task.id, branch: task.branch, force: plan.force,
      });
    } catch (err) {
      return `⚠️ 作業ツリーの撤去に失敗: ${err.message} — 残しました`;
    }
    const head = released.missing ? '🧹 作業ツリーは既にありません' : '🧹 作業ツリーを撤去しました';
    if (!plan.deleteBranch) return head;
    try {
      await runGit(repoRoot, ['branch', '-d', task.branch]);
    } catch (err) {
      return `${head} (ブランチ ${task.branch} は残しました: ${err.message})`;
    }
    return `${head} (ブランチ ${task.branch} も削除)`;
  }

  /** 差し戻したタスクの担当を呼び直す (理由つき) */
  async function notifySendBack({ task, cc, bot, thread, reason }) {
    const autonomy = resolveAutonomy(cc);
    const workerKey = pickWorker(
      autonomy,
      [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    );
    const worker = workerKey ? bots.get(workerKey) : null;
    // 自分の多行発言は捨てられる (src/trigger.js) ので、自分宛には投げない
    if (!worker?.userId || workerKey === bot.key) {
      return `⚠️ 直す担当を呼べませんでした (worker: ${workerKey ?? '未設定'}) — 人間が起こしてください`;
    }
    try {
      await sendSafe(
        thread,
        sendBackMessage({
          task, botUserId: worker.userId, reason, budget: SEND_BACK_JOB_BUDGET,
        }),
        { mentionUserIds: [worker.userId] },
      );
    } catch (err) {
      return `⚠️ 差し戻しメッセージの投稿に失敗しました (${err.message}) — 人間が起こしてください`;
    }
    return `→ ${worker.cfg.displayName} に直しをお願いしました (追い予算 ${SEND_BACK_JOB_BUDGET} job)`;
  }

  /**
   * 制御メンションを投げる client と、その client から見たスレッド。
   * **宛先自身の client からは投げない** (pickAnnouncer の流儀)。
   * ふつうは走っている job の bot がそのまま投げ手になる (handoff と同じ形)。
   */
  function announcerFor({ targetKey, autonomy, bot, thread }) {
    if (bot.key !== targetKey) return { key: bot.key, channel: thread };
    const key = pickAnnouncer(
      targetKey,
      autonomy,
      [...bots.values()].filter((b) => b.userId).map((b) => b.key),
    );
    const channel = key ? bots.get(key)?.client?.channels?.cache?.get(thread.id) ?? null : null;
    return channel ? { key, channel } : null;
  }

  /**
   * `/review [id]` からのレビューの出し直し (2026-09-01 裁定 A — 人間が board を動かす口)。
   *
   * review で止まったタスクは、**契約が無い限り誰も判定を返せない** (判定を書けるのは
   * task-review 契約を持つ job だけ)。#46 は「reviewer 自身のフッタ無し報告が worker の
   * 完了と数えられ、自己レビュー禁止で契約が作られない」で review に固着した。
   *
   * **出し直し = 置き換え。** 未消費の task-review 契約が残っていたら先に消す — 残したまま
   * 積むと、reviewer 宛の未消費キュー (上限あり) が埋まって次の委譲が保存できなくなる。
   * 消すのは **task-review だけ**で、同じ相手宛の承認や委譲は巻き添えにしない。
   *
   * @param {{thread: object, id?: string|null, bot: object}} p
   * @returns {Promise<{ok: boolean, reason: string}>} reason はそのまま Discord へ出る
   */
  async function reissueReview({ thread, id = null, bot }) {
    if (!board) return { ok: false, reason: 'このプロセスはボードを持っていません' };
    const cc = channelConfigFor(thread);
    if (!cc) return { ok: false, reason: 'このチャンネルは config.policy.json の channels に未登録です' };

    const task = board.findByThread(thread.id);
    const plan = planReissueReview({ task, id });
    if (!plan.ok) return plan;
    // kill switch (§3.7) は素通りさせない。止めている理由 (暴走・調査中) は
    // レビューの召喚にも効いている — 出したいなら先に /resume する
    if (pauseStore.paused) {
      return { ok: false, reason: '自律運転が停止中です — `/resume` してから打ってください' };
    }

    const autonomy = resolveAutonomy(cc);
    const reviewerKey = autonomy.reviewer;
    for (const entry of reviewerKey ? contracts.list(thread.id, reviewerKey) : []) {
      if (entry?.kind === 'task-review') contracts.removeById(thread.id, reviewerKey, entry.id);
    }
    // 証拠は測り直さず、review へ進めた回に測ったものを note から読み直す (前の周回の分は読まない)。
    // 出し直すまでに積まれた commit は入っていないので、そう書き添える
    const kept = reviewEvidenceNote(task);
    const evidence = kept.evidence
      ? `${kept.evidence}\n(${kept.at || '時刻不明'} に review へ進めた回に測ったもの — その後の commit は反映していない)`
      : null;
    // 解き直しを待っている改訂は、人間の出し直しで待つのをやめる (tick が後でもう一度呼ばないように先に印を付ける)。
    // まだ着手していない解き直しは取りやめる — 残すと誰も結果を読まないのに着手が先に起こして job を使う。
    // 走っている解き直しは自分の完了で取り下げられる
    let current = task;
    if (awaitingReplays(task)) {
      const at = new Date().toISOString();
      for (const left of board.list({ channel: cc.channelName })) {
        if (!isReplayTask(left) || left.replay.of !== String(task.id) || left.state !== 'approved') continue;
        try {
          board.transition(left.id, 'dropped', {
            by: bot.key,
            note: `解き直しを取りやめ (改訂 #${task.id} を /review で先にレビューへ回した)`,
            patch: { replay: { ...left.replay, outcome: { result: 'manual', evidence: null, at } } },
          });
        } catch (err) {
          console.error(`[replay] ${cc.channelName}: 解き直し #${left.id} を取りやめられません: ${err.message}`);
        }
      }
      current = board.setReplay(task.id, { ...task.replay, status: 'done', how: 'manual', doneAt: at });
    }
    const replaySummary = formatReplaySummary(current, board.list({ channel: cc.channelName }));
    // 実装した担当ではなく**人間**が出しているので、自己レビュー禁止の門番は通さない
    const sent = await requestReview({ task: current, cc, autonomy, bot, thread, byWorker: false, evidence, replaySummary });
    // 成否は召喚した側の戻りで決める。**受け手は受付時に claim するので、送信後の
    // store は成否の根拠にならない** (契約が消えていても起動している — sol 指摘)
    return sent.ok
      ? { ok: true, reason: `${plan.reason}\n${sent.note}` }
      : { ok: false, reason: sent.note };
  }

  /**
   * 承認の応答をボードへ適用する (§3.2)。
   * 判断は src/scheduler.js の planApproval (純粋) が持ち、ここは実行と報告だけ。
   *
   * @returns {string} スレッドへ出す 1 行
   */
  function applyApproval({ contract, pending, cc, botKey }) {
    if (!board) return '⚠️ 承認を受け取りましたが、このプロセスはボードを持っていません';
    const plan = planApproval(contract, { pending });
    const errors = [...plan.errors];
    // 承認の本文を承認の記録に残す — 着手の起動とレビューの依頼がここから読む (approvalNote)。
    // 同じ承認で複数件を通したときは全件に同じ本文が付く。制御フッターは外しておく
    // (後で別のスレッドへ出すときに呼び出しとして生き返らせない)
    const note = stripFooterControls(String(contract?.body ?? '')).text.trim();
    let approved = 0;
    let dropped = 0;
    for (const id of plan.approve) {
      try {
        board.approve(id, { by: botKey, note });
        approved += 1;
      } catch (err) {
        errors.push(`#${id} を承認できません: ${err.message}`);
      }
    }
    for (const { id, reason } of plan.drop) {
      try {
        board.drop(id, { by: botKey, reason });
        dropped += 1;
      } catch (err) {
        errors.push(`#${id} を破棄できません: ${err.message}`);
      }
    }
    if (errors.length > 0) {
      console.error(`[scheduler] ${cc.channelName}: 承認の適用に問題 — ${errors.join(' / ')}`);
    }
    const head = `✅ 承認 ${approved} 件 / 破棄 ${dropped} 件`;
    return errors.length > 0 ? `${head}\n⚠️ ${errors.join('\n⚠️ ')}` : head;
  }

  return {
    fileProposal,
    taskVerifyRoute,
    requestApproval,
    noteTaskCompletion,
    requestReview,
    applyReview,
    applyApproval,
    reissueReview,
    cleanupTaskWorktree,
    settleReplays,
  };
}
