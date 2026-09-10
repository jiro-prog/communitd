// ---- org-apply の配線 (docs/social-engineering.md §3.9) ----
//
// 判断は src/apply.js、実行は src/orgapply.js、順序は src/orgapply-wiring.js が持つ。
// ここが持つのは**実体の解決だけ** — git・fs・verify・Discord・起動中の bot。
//
// **起動点は sweepProposals の 1 経路だけ。** 採択ボタンの直後にフックを足すと、
// 「押した瞬間」と「tick」の 2 つの入口ができて、排他の外で二重に始まりうる。

/** 適用回路が動くときの記録者。人ではないので bot キーではなくブリッジを名乗る */
export const APPLY_BY = 'bridge';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  channelConfigForName,
  resolveApplyChannel,
  resolveAutonomy,
  resolveVerifyCommand,
} from '../config.js';
import { sendSafe, taskThreadName } from '../mentions.js';
import {
  applyBranchFor,
  applyCandidates,
  reclaimStaleApplies,
  resumeApplyTrials,
  sweepApplyCandidates,
} from '../orgapply-wiring.js';
import { pickAnnouncer } from '../scheduler.js';
import { sanitizeForDisplay } from '../toolrules.js';
import { canonicalCwd } from '../toolstore.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, runVerify } from '../verify.js';
import { parseBranchList, parseWorktreeList, releaseWorktree, runGit } from '../worktree.js';

/** receipt / 通知へ載せる verify の失敗理由 (末尾だけ — 全文はログに残る) */
export function verifyFailureDetail(out) {
  const tail = String(out?.error || out?.output || '').trim();
  return tail === '' ? '(詳細なし)' : tail.slice(-400);
}

/** 適用の結果を 1 行にする (提案スレッドへ出す文面) */
export function orgApplyLine(proposal, out) {
  const head = `🏛 提案 #${proposal.id} (${proposal.class})`;
  if (out.ok) {
    return `${head} を当てました (${out.receipt.appliedCommit.slice(0, 12)} / タスク #${out.taskId})\n`
      + `${out.note || '→ 検収を頼んでいます'}`;
  }
  if (out.stage === 'prepare') {
    const where = out.action === 'withdrawn'
      ? ' — 取り下げました (出し直してください)'
      : out.action === 'deliberating'
        ? ' — 再裁定へ戻しました'
        : out.escalate
          ? ' — **人間の判断が要ります**'
          : '';
    return `${head} は当てられません: ${sanitizeForDisplay(out.reason, 400)}${where}`;
  }
  // 後始末が落ちた形は残った task の状態で案内が変わる。**review は自動では拾わない** —
  // reclaimStaleApplies は in-progress / dropped しか見ないので、検収の宛先が生きたまま
  // 止まったものは同じ判定を打ち直してもらう (差し戻しが途中で止まったときと同じ道)
  const retry = out.stage !== 'settle'
    ? ''
    : out.taskState === 'review'
      ? `\nタスク #${out.taskId} は review のまま残ります (\`/review ${out.taskId}\` で判定を出し直してください)`
      : '\n→ 次の tick で片付け直します';
  return `${head} の適用に失敗しました (${out.stage}): ${sanitizeForDisplay(out.reason, 400)}`
    + `${out.note ? `\n${out.note}` : ''}${retry}`;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.root                  このリポジトリの根 (適用の枝はここから生やす)
 * @param {object|null} deps.proposals
 * @param {object|null} deps.board
 * @param {Map<string, object>} deps.bots
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {(client: object, name: string) => object|null} deps.findGuildChannel
 * @param {() => object|null} deps.safeProposalContext
 * @param {() => Promise<string|null>} deps.resolveApplyBaseCommit
 * @param {(proposal: object, text: string, opts?: object) => Promise<string|null>} deps.postToProposal
 * @param {(p: object) => Promise<{ok: boolean, note: string}>} deps.requestReview 検収の依頼 (src/bridge/board.js)
 */
export function createOrgApplyWiring({
  config, root: ROOT, proposals, board, bots, hops, findGuildChannel,
  safeProposalContext, resolveApplyBaseCommit, postToProposal, requestReview,
}) {
  /**
   * 適用回路が使うチャンネル設定。**契約の cwd は本体の正規形へ寄せる**
   * (contractCwd と同じ形 — ずれると検収 job が契約を取り出せない)。
   */
  function applyChannelConfig() {
    const name = resolveApplyChannel(config);
    const configured = name ? channelConfigForName(config, name) : null;
    if (!configured) return null;
    const canonical = canonicalCwd(configured.cwd);
    if (!canonical) {
      console.error(`[org-apply] ${name}: 作業ディレクトリを解決できません (${configured.cwd})`);
      return null;
    }
    return { ...configured, cwd: canonical, repoRoot: canonical };
  }

  /**
   * 実行層 (src/orgapply.js) へ渡す依存。**git も fs も verify もここでだけ実物に結ぶ。**
   *
   * verify を持たないチャンネルでは `{ok:false}` を返す — receipt は verify 成功が前提
   * なので、検証できない配備で「当てたことにする」より当てない方へ倒す (fail-closed)。
   */
  function orgApplyDeps(cc) {
    const command = resolveVerifyCommand(cc);
    return {
      git: (cwd, args) => runGit(cwd, args),
      writeFile: (path, text) => writeFile(path, text, 'utf8'),
      deleteFile: (path) => rm(path, { force: true }),
      ensureDir: async (path) => { await mkdir(path, { recursive: true }); },
      verify: async (cwd) => {
        if (!command) return { ok: false, detail: 'verify 未設定 (検証できない適用は記録しません)' };
        const out = await runVerify({
          command,
          cwd,
          timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
          scrubEnvKeys: Object.values(config.bots).map((b) => b.tokenEnv),
        });
        // 成功した検証の出力は receipt に載せない (台帳が肥る)。落ちた理由だけ残す
        return { ok: out.ok === true, detail: out.ok === true ? '' : verifyFailureDetail(out) };
      },
      listWorktrees: async () => parseWorktreeList(await runGit(ROOT, ['worktree', 'list', '--porcelain'])),
      listBranches: async () => parseBranchList(
        await runGit(ROOT, ['branch', '--list', '--format=%(refname:short)']),
      ),
    };
  }

  /** 適用 task のスレッドを立てて投稿する bot (**検収担当以外**から選ぶ) */
  function applyAnnouncer(autonomy) {
    const available = [...bots.values()].filter((b) => b.userId).map((b) => b.key);
    const key = pickAnnouncer(autonomy.reviewer, autonomy, available);
    return key ? bots.get(key) ?? null : null;
  }

  /**
   * 失敗した適用の枝を解放する。**例外を投げない** — 解放できなかったことで
   * 錠が残る方が悪い (残骸は次の適用が `planApplyWorktree` で撤去し直す)。
   *
   * `force` を立てるのは、この枝に人間の作業が無いから (書いたのはブリッジで、
   * 検収 task に書込み権限は無い)。ブランチは `-d` — 当てたコミットが載っていれば
   * git が拒むのが正しく、押し切る判断はここに無い。
   */
  async function releaseApplyWorktree(task) {
    const branch = task?.branch || applyBranchFor(task.id);
    const notes = [];
    try {
      const released = await releaseWorktree({
        repoRoot: ROOT, taskId: task.id, branch, force: true,
      });
      notes.push(released.missing ? '🧹 作業ツリーは既にありません' : '🧹 作業ツリーを撤去しました');
    } catch (err) {
      notes.push(`⚠️ 作業ツリーの撤去に失敗: ${sanitizeForDisplay(err.message, 160)} — 残しました`);
    }
    try {
      await runGit(ROOT, ['branch', '-d', branch]);
      notes.push(`(ブランチ ${branch} も削除)`);
    } catch (err) {
      notes.push(`(ブランチ ${branch} は残しました: ${sanitizeForDisplay(err.message, 160)})`);
    }
    return notes.join(' ');
  }

  /** 適用 task のスレッドを applyChannel に立て、予算と案内を置く */
  async function createApplyThread({ cc, announcer, task, proposal }) {
    const channel = findGuildChannel(announcer.client, cc.channelName);
    if (!channel?.threads) {
      throw new Error(`チャンネル ${cc.channelName} を取得できません (キャッシュ未取得・権限不足・改名)`);
    }
    const thread = await channel.threads.create({ name: taskThreadName(task) });
    // 予算は start-task と同じ形で先に配る (門番ごと不在のスレッドを作らない)
    hops.grantTaskBudget(thread.id, task.jobBudget);
    await sendSafe(
      thread,
      `🏛 提案 #${proposal.id} (${proposal.class} / ${proposal.input?.kind}) を当てます。\n`
      + `対象: ${(proposal.input?.change?.touch ?? []).join(' / ') || '(不明)'}\n`
      + 'ブリッジが承認済み diff を基点から当てて verify まで回します。'
      + 'このタスクが担うのは **diff の検収だけ** です (適用者と検収者を分けるため)。',
    ).catch((err) => {
      console.error(`[org-apply] 案内を投稿できませんでした: ${err.message}`);
    });
    return thread.id;
  }

  /**
   * 適用 task の検収を頼む。**投げ手はブリッジ** (走っている job が無いので、
   * 起動中の bot から検収担当以外を選んで投げる)。
   *
   * `byWorker: false` を渡すのは、自己レビュー禁止の判定が見ているのが
   * 「実装した担当 == reviewer」だから — ここで実装 (適用) したのはブリッジなので、
   * 投げ手が誰であっても検収担当は別人になる。#46 の再演 (契約が作られないまま
   * review に固着) を避けるために、判定の意味は変えずに経路だけ分ける。
   */
  async function requestApplyReview({ cc, autonomy, announcer, task, threadId }) {
    const thread = announcer.client.channels.cache.get(threadId)
      ?? await announcer.client.channels.fetch(threadId).catch(() => null);
    if (!thread) return { ok: false, note: '⚠️ 検収を頼むスレッドを取得できませんでした' };
    return requestReview({ task, cc, autonomy, bot: announcer, thread, byWorker: false });
  }

  /**
   * 直近に出した通知 (提案 id → キー)。**同じ理由を毎 tick 撒かない** —
   * 試行上限や lane の不備は状態が動かないので、放っておくと 1 分ごとに同じ行が出る。
   * in-memory なので再起動で 1 回だけ出し直す (提案の配り直しと同じ流儀)。
   */
  const applyNotices = new Map();

  /**
   * 走っている適用があるか。**tick は前の tick を待たない** (`setInterval` の中で
   * `sweepProposals()` を投げっぱなしにしている) ので、verify を含む適用が 1 分を
   * 超えると次の tick が同じ提案を拾う。錠 (`linkTask`) は 2 件目を必ず落とすが、
   * 落ちる前に task と Discord スレッドだけが 1 組増えるので、入口で畳む。
   */
  let orgApplyRunning = false;

  /**
   * 採択された org / process を 1 件当てる (sweepProposals の (3))。
   *
   * **1 tick 1 件。** 適用は repo + task の鍵で排他なので、並べても待つだけになる。
   */
  async function sweepOrgApply(now) {
    if (orgApplyRunning) return;
    orgApplyRunning = true;
    try {
      await runOrgApplySweep(now);
    } finally {
      orgApplyRunning = false;
    }
  }

  async function runOrgApplySweep(now) {
    if (!proposals || !board) return;
    const cc = applyChannelConfig();
    if (!cc) return; // 適用回路が設定されていない配備では静かに何もしない

    // **途中で止まった適用をここで片付け直す。** 後始末はどこで落ちても次の tick で
    // 同じ手を打ち直せる、というのがあの順序の前提。
    // **走っている適用が無いことは呼ぶ場所が保証している** — この関数全体が
    // `sweepOrgApply` の in-flight ガードの中で、しかも候補走査より前に居る
    for (const id of await reclaimStaleApplies(proposals, board, {
      release: ({ task }) => releaseApplyWorktree(task),
      now,
      by: APPLY_BY,
      log: (m) => console.error(`[org-apply] ${m}`),
    })) {
      console.log(`[org-apply] #${id} の適用を片付け直しました (前回の後始末が途中で止まっていました)`);
    }

    // merge まで済んだのに試用が始まっていない提案を進め直す (もう 1 つの回復点)
    for (const id of resumeApplyTrials(proposals, board, {
      ctxOf: safeProposalContext, now, by: APPLY_BY, log: (m) => console.error(`[org-apply] ${m}`),
    })) {
      console.log(`[org-apply] #${id} の試用を始め直しました (merge 済みで止まっていました)`);
    }

    const candidates = applyCandidates(proposals);
    // 候補から外れた提案の通知記録は捨てる (open な提案の数だけを持つ)
    const live = new Set(candidates.map((p) => p.id));
    for (const id of applyNotices.keys()) {
      if (!live.has(id)) applyNotices.delete(id);
    }
    if (candidates.length === 0) return;
    // **前提を読むのは当てる番が来てからでよい** (policy の読み直しを毎 tick 起こさない)
    const ctx = safeProposalContext();
    if (!ctx) return;
    // 基点を引けない配備では当てない (採択そのものは adjudicate が断っている)
    if (await resolveApplyBaseCommit() === null) return;

    const autonomy = resolveAutonomy(cc);
    const announcer = applyAnnouncer(autonomy);
    if (!announcer) {
      console.error('[org-apply] 投稿できる bot が起動していません — 次の tick で試します');
      return;
    }

    // **当てるのは 1 tick 1 件だが、走査は止めない** (打ち切りの条件は
    // sweepApplyCandidates 側に置いてある — Sol 指摘 2026-09-03)
    await sweepApplyCandidates(proposals, {
      board,
      ctx,
      channelName: cc.channelName,
      repoRoot: ROOT,
      by: APPLY_BY,
      now,
      deps: orgApplyDeps(cc),
      createThread: ({ task, proposal }) => createApplyThread({ cc, announcer, task, proposal }),
      submitReview: ({ task, threadId }) => requestApplyReview({ cc, autonomy, announcer, task, threadId }),
      release: ({ task }) => releaseApplyWorktree(task),
      log: (m) => console.error(`[org-apply] ${m}`),
      report: (proposal, out) => reportOrgApply(proposal, out, cc),
    });
  }

  /** 結果を提案スレッド (無ければ applyChannel) へ 1 行。**同じ理由は繰り返さない** */
  async function reportOrgApply(proposal, out, cc) {
    const line = orgApplyLine(proposal, out);
    if (out.stage === 'prepare') {
      const key = `${out.attempts}:${out.reason}`;
      if (applyNotices.get(proposal.id) === key) return;
      applyNotices.set(proposal.id, key);
    } else {
      applyNotices.delete(proposal.id);
    }
    console.log(`[org-apply] ${line.replace(/\n/g, ' / ')}`);
    await postToProposal(proposal, line, { mentionOwner: out.escalate === true, cc });
  }

  return { sweepOrgApply, releaseApplyWorktree, applyChannelConfig, createApplyThread, reportOrgApply };
}
