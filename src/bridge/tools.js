// ツール権限の申請と承認の配線 (src/index.js から切り出し)。
// 経路は 2 つ: job 終了後の permission_denials を 2 段階カードにする (postApprovalRequests) と、
// hooks: true のチャンネルで job 実行中に PreToolUse hook から届く ask を裁く (decideApproval)。
// 判断は src/broker.js (decideAsk) と src/toolrules.js (collectProposals) が持ち、ここは
// 台帳 (ApprovalRegistry / ToolExtraStore) と Discord のカードを結ぶだけ。
import { buildApprovalCard } from '../approvals.js';
import { decideAsk } from '../broker.js';
import { grantFingerprint } from '../grants.js';
import { editSafe, sendSafe } from '../mentions.js';
import { collectProposals, sanitizeForDisplay } from '../toolrules.js';

/**
 * @param {object} deps
 * @param {import('../toolstore.js').ToolExtraStore} deps.toolExtra 承認済みルールの永続
 * @param {import('../approvals.js').ApprovalRegistry} deps.approvals 申請の台帳
 * @param {{maxApprovalCards: number, approvalWaitMs: number}} deps.limits
 */
export function createToolApprovalWiring({ toolExtra, approvals, limits }) {
  const MAX_APPROVAL_CARDS = limits.maxApprovalCards;
  const APPROVAL_WAIT_MS = limits.approvalWaitMs;

  /**
   * このチャンネルで実際に渡してよい承認済みルール。
   * 鍵は「チャンネル設定 × cwd」。cc.cwd は job 受付時に実体へ固定済みなので、
   * ここで再度 realpath は引かない (引くと job 中の差し替えに追従してしまう)。
   * 読むたびに grant の検証を通す (壊れた・古い・widen されたエントリは使われない)。
   */
  function approvedRulesFor(cc) {
    return toolExtra.rulesFor(cc.channelName, cc.cwd);
  }

  /**
   * 承認された grant を永続へ積む (interactions.js から呼ばれる)。
   * **失敗は握り潰さず throw する** — 呼び出し側が「承認済み」の確定を止められるように。
   * 承認者はまだ request.resolved に入っていない (確定は保存成功後) ので押した人を受け取る。
   *
   * cwd は grant に焼き込んである canonical 値をそのまま使う。あとで config.json の
   * cwd を別リポジトリへ向け替えても、この承認がそちらへ移らないようにするため。
   */
  function saveApprovedRule(request) {
    return toolExtra.add(request.channelName, {
      ...request.grant,
      approvedBy: request.pendingConfirm?.userId ?? null,
      approvedAt: new Date().toISOString(),
      botKey: request.botKey,
      threadId: request.threadId,
    });
  }

  /**
   * 拒否されたツール要求を「人間が押せる申請カード」に変えてスレッドへ出す。
   *
   * エージェント側は何も承認できない — ここが作るのは申請だけで、許可が増えるのは
   * allowedUserIds の人間がボタンを押したときだけ。恒久承認に向かない要求
   * (シェル全許可・wildcard・cwd 外・秘密混じり) はカードにせず、理由を並べて返す。
   */
  async function postApprovalRequests(thread, bot, cc, denials, askLedger = null) {
    // cwd を渡すのが要点: パスを取るツールは「cwd 内のこのファイル」まで絞ってから
    // 申請にする (裸の Edit 許可を作らない)
    // cc.cwd は job 受付時に実体へ固定済み。ここで realpath を引き直すと、
    // 「job 実行中に junction を差し替えたら、A で起きた拒否が B 向けの承認になる」
    // という取り違えが起きる (sol 指摘 2026-08-01)
    const { proposals, rejected, dropped } = collectProposals(denials, {
      cwd: cc.cwd,
      max: MAX_APPROVAL_CARDS,
    });
    const alreadyAllowed = [];
    const alreadyAsked = [];

    for (const proposal of proposals) {
      // 承認済みなのに拒否された = ルールが噛み合っていない。カードを出し直しても直らない
      if (toolExtra.has(cc.channelName, proposal.grant)) {
        alreadyAllowed.push(proposal.rule);
        continue;
      }
      // この job の実行中に hook 経由で聞いたものを、終了後にもう一度カードにしない
      // (人間はもう答えている。同じ申請が 2 枚並ぶと、どちらが効くのか分からなくなる)
      if (askLedger?.has(proposal.rule)) {
        alreadyAsked.push(proposal.rule);
        continue;
      }
      // 保存するのは grant そのもの (無加工)。表示用の文字列は rule として別に持たせ、
      // カードを描くときにだけ無害化する — 保存値と表示値を混ぜない
      const request = approvals.register({
        guildId: thread.guildId ?? thread.guild?.id ?? null,
        channelId: thread.id,
        threadId: thread.id,
        botKey: bot.key,
        channelName: cc.channelName,
        grant: proposal.grant,
        rule: proposal.rule,
      });
      if (!request) {
        console.error(`[tools] 申請を登録できませんでした (grant が検証に通らない)`);
        continue;
      }
      let card;
      try {
        card = await sendSafe(
          thread,
          buildApprovalCard(request, { stage: 'request', escape: sanitizeForDisplay }),
        );
      } catch (err) {
        // 押せないカードに対応する申請を台帳へ残さない
        approvals.revoke(request.nonce);
        console.error(`[tools] 申請カードの投稿に失敗したため申請を取り消しました: ${err.message}`);
        throw err; // 呼び出し側 (deliverTurn) が handoff を止める
      }
      // 押されたカードそのものかを後で照合できるようにする。
      // ID を取れなければ特定できない申請になるので、その場で取り消す
      if (!approvals.bindMessage(request.nonce, card?.id)) {
        approvals.revoke(request.nonce);
        console.error('[tools] 申請カードのメッセージ ID を取れなかったため申請を取り消しました');
        throw new Error('申請カードのメッセージ ID を取得できませんでした');
      }
    }

    const notes = [];
    if (rejected.length > 0) {
      notes.push('⚠️ 恒久承認にできない拒否がありました (config.policy.json で人間が直接書いてください):');
      for (const r of rejected) {
        notes.push(`・${sanitizeForDisplay(r.tool, 60)} — ${r.reason}`);
        // 貼れる形にできたものだけ候補を添える (保存もカードもしない — 精査は人間)
        if (r.suggestion) notes.push(`  候補: \`${sanitizeForDisplay(r.suggestion, 200)}\``);
      }
    }
    if (alreadyAllowed.length > 0) {
      notes.push(
        `⚠️ 承認済みなのに拒否されたルールがあります: ` +
          `${alreadyAllowed.map((r) => `\`${sanitizeForDisplay(r, 200)}\``).join(' ')}`,
        '  → ルールの書き方が実際の呼び出しと噛み合っていません (config.policy.json 側の確認が要ります)',
      );
    }
    if (alreadyAsked.length > 0) {
      notes.push(
        `ℹ️ 実行中に承認カードで確認したルールは出し直していません: ` +
          `${alreadyAsked.map((r) => `\`${sanitizeForDisplay(r, 200)}\``).join(' ')}`,
      );
    }
    if (dropped > 0) {
      notes.push(`⚠️ 承認カードは 1 回 ${MAX_APPROVAL_CARDS} 件までのため、他 ${dropped} 件は出していません`);
    }
    // 「何が足りないのか」の唯一の手がかりなので、送信失敗は握り潰さず上へ伝える
    if (notes.length > 0) {
      await sendSafe(thread, notes.join('\n').slice(0, 1900));
    }
  }

  /**
   * 実行中の job から届いた承認要求 1 件を裁く (承認ブローカの decide)。
   *
   * **返した瞬間に hook が動き出す。** allow を返してよいのは
   * 「既に保存されている」か「押されて保存が通った」ときだけで、後者の allow を出すのは
   * `approvals.commit()` (= interactions.js が保存成功を確かめた後) だけになっている。
   *
   * 判定が付かない経路 — 投稿失敗・メッセージ ID を束縛できない・待機上限・中断 — は
   * すべて deny。**待機者を残したまま申請を消す口を作らない**のがこの関数の要点で、
   * 残すと hook が永久に待ち、その job は二度と進まない。
   */
  async function decideApproval({ ask, signal, thread, bot, cc, allowedTools, askLedger, onWaitingChange }) {
    const verdict = decideAsk(ask, {
      cwd: cc.cwd,
      allowedRules: allowedTools,
      // job 開始後に承認されたぶんもここで効く (hook 経路だけの意図的な更新)
      isApproved: (grant) => toolExtra.has(cc.channelName, grant),
    });
    if (verdict.decision !== 'ask') return verdict;
    // 裁定を待つ前に job が終わっていた (ブローカが stop 済み)。カードを出さない
    if (signal.aborted) {
      return { decision: 'deny', reason: 'job が終了したため承認を待てません' };
    }
    // **最初の await より前に枠を取る。** ask は並行して届くので、投稿の往復を挟んでから
    // 記録すると全件が「まだ聞いていない」と判定され、同じカードが並ぶ (sol 指摘)
    const reserved = askLedger.reserve(verdict.rule);
    if (!reserved.ok) {
      return {
        decision: 'deny',
        reason: reserved.reason === 'asked'
          // 承認されていれば上の isApproved で allow になっている = ここに来たら未承認
          ? 'この job では既に確認済みです (承認されませんでした)'
          : `この job の承認カードは ${MAX_APPROVAL_CARDS} 件までのため、これ以上は聞きません`,
      };
    }

    const request = approvals.register({
      guildId: thread.guildId ?? thread.guild?.id ?? null,
      channelId: thread.id,
      threadId: thread.id,
      botKey: bot.key,
      channelName: cc.channelName,
      grant: verdict.grant,
      rule: verdict.rule,
      hook: true, // job を止めて待つ申請 (カードの文面・ボタン・段数が変わる)
      waitMs: APPROVAL_WAIT_MS,
    });
    if (!request) {
      askLedger.release(verdict.rule);
      console.error('[tools] 実行中の申請を登録できませんでした (grant が検証に通らない)');
      return { decision: 'deny', reason: '申請を登録できなかったため実行しません' };
    }

    // 以降の失敗では**枠を返す**。カードを出せなかったものを「聞いた」に数えると、
    // job 終了後のカードまで「確認済み」として抑止してしまう
    let card;
    try {
      card = await sendSafe(
        thread,
        buildApprovalCard(request, { stage: 'request', escape: sanitizeForDisplay }),
      );
    } catch (err) {
      askLedger.release(verdict.rule);
      approvals.revoke(request.nonce);
      console.error(`[tools] 実行中の申請カードを投稿できませんでした: ${err.message}`);
      return { decision: 'deny', reason: '承認カードを投稿できなかったため実行しません' };
    }
    // ID を束縛できないカードは押しても通らない (resolve が messageId を必須にしている)。
    // 押せないカードを見せたまま待たせない
    if (!approvals.bindMessage(request.nonce, card?.id)) {
      askLedger.release(verdict.rule);
      approvals.revoke(request.nonce);
      console.error('[tools] 実行中の申請カードのメッセージ ID を取れませんでした');
      await closeApprovalCard(card, request, 'invalid');
      return { decision: 'deny', reason: '承認カードを特定できなかったため実行しません' };
    }

    // 待ち上限はブローカが持つ。切れたら申請ごと無効にして待機を畳む。
    // **既に切れている場合も同じ扱いにする** — 中断済みの signal に listener を足しても
    // 発火しないので、そこだけ待機が残って job が終わらなくなる
    const onAbort = () => approvals.expire(request.nonce);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    onWaitingChange(1);
    let decided;
    try {
      decided = await approvals.awaitDecision(request.nonce);
    } finally {
      signal.removeEventListener('abort', onAbort);
      onWaitingChange(-1);
    }

    // 押されないまま終わったカードは、押した人が居ない旨まで書いて畳む
    // (押下で決着したカードは interactions.js が既に描き直している)
    if (request.resolved?.action === 'timeout') await closeApprovalCard(card, request, 'expired');
    console.log(
      `[tools] 実行中の申請 ${decided.decision}: ${grantFingerprint(request.grant)} (#${cc.channelName})`,
    );
    return decided;
  }

  /** 決着したカードのボタンを外す (畳めなくても許可の可否は確定している) */
  async function closeApprovalCard(card, request, stage) {
    if (!card) return;
    try {
      await editSafe(card, buildApprovalCard(request, { stage, escape: sanitizeForDisplay }));
    } catch { /* スレッドごと消えていることもある */ }
  }

  return { approvedRulesFor, saveApprovedRule, postApprovalRequests, decideApproval };
}
