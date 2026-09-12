// スラッシュコマンド (/stop・/restart) とツール権限の承認ボタンの実行、および
// 停止・再起動まわりの純粋ロジック (stopJobs / createLifecycle / pumpJobs /
// admitJob / runShutdown)。
// Discord の interaction と job キュー / 承認台帳の間だけを担い、
// 依存はすべて引数で受け取る (テストから fake を差せる)。
//
// 停止系がここに同居しているのは、配線先 (src/bridge/queue.js / shutdown.js) から判断を
// 分けておくため (T1)。まとめて src/lifecycle.js へ移せる形で書いてある。

import { buildApprovalCard, parseCustomId } from './approvals.js';
import {
  RATIONALE_FIELD,
  buildProposalCard,
  buildRationaleModal,
  checkProposalBinding,
  formatProposalQueue,
  parseProposalCustomId,
} from './adjudication.js';
import { digestOf, isTerminal } from './proposals.js';
import { formatInbox } from './inbox.js';
import { isAuthorizedSender } from './authz.js';
import { grantFingerprint } from './grants.js';
import { formatPauseState, resolveCaseRequest, resolveStopScope } from './commands.js';
import { formatJst } from './time.js';
import { editSafe, safePayload } from './mentions.js';
import { channelNameOf, resolveChannelRoster, unregisteredChannelNotice } from './config.js';
import { formatRoster, parseRosterMembers, resolveEffectiveRoster } from './roster.js';
import { RESTART_EXIT_CODE, evaluateRestart, restartRejectionMessage } from './restart.js';

// MessageFlags.Ephemeral。純粋側に discord.js を持ち込まないため数値で書く
const EPHEMERAL = 1 << 6;

/**
 * 決着済みの申請をどのカードで描くか。
 * timeout (承認待ちの上限切れ) を「却下」と描くと、誰も押していないのに
 * 「誰かが却下した」ように読める。
 */
function stageForResolved(action) {
  if (action === 'confirm') return 'approved';
  if (action === 'timeout') return 'expired';
  return 'denied';
}

const CANCEL_ON_RESTART = '⏹ 再起動により取り消し — 再メンションしてください';
const NOT_ADMITTED = '⏹ ブリッジ停止により受け付けませんでした — 再メンションしてください';

/**
 * interaction ハンドラを組み立てる。
 *
 * @param {object} deps
 * @param {object} deps.config             config.json (認可判定に使う)
 * @param {(channel: object) => object|null} deps.channelConfigFor 管轄チャンネル判定
 * @param {object} deps.jobs               JobQueue (activeCount / waitingCount / selectForStop)
 * @param {(ms: number, label?: string) => Promise<void>} deps.waitForJobsDrained 中断完了待ち
 * @param {object} [deps.lifecycle]        停止・再起動の進行状態 (createLifecycle)。
 *        index.js と同じものを渡す — 渡さないと drain 待ちの間に新規 job が走る
 * @param {(notice: object) => void} deps.writeRestartNotice 再起動完了通知の予約
 * @param {(code: number, cancelMessage?: string, opts?: {drained?: boolean}) => Promise<void>}
 *        deps.shutdown 後始末して終了 (drained は「呼び出し元が drain 済み」)
 * @param {number} [deps.restartDrainMs]   force 再起動時の drain 上限
 * @param {object} [deps.approvals]        ツール権限の承認台帳 (ApprovalRegistry)
 * @param {(request: object) => boolean} [deps.saveApprovedRule] 承認ルールの永続 (追加できたら true)
 * @param {(p: {thread: object, id: string|null, bot: object}) => Promise<{ok: boolean, reason: string}>}
 *        [deps.reissueReview] `/review` の実体 (board と契約を持つ index 側)。省略すると機能が無効
 * @param {object} [deps.inbox]            裁定の受信箱の台帳 (InboxStore)。省略すると /inbox は無効
 * @param {() => object|null} [deps.boardOf] ボード (TaskBoardStore) を返す関数。
 *        **値ではなく関数で受ける** — 呼び出し側の組み立て順に依存しないため (ボードの無い配備では null を返す)
 * @param {object} [deps.roster]           スレッド別編成の台帳 (RosterStore)
 * @param {() => Array<{key: string, displayName?: string, userId?: string|null}>} [deps.botEntries]
 *        設定できる bot の一覧 (/roster の検証と表示に使う)
 */
export function createInteractionHandler({
  config,
  channelConfigFor,
  jobs,
  waitForJobsDrained,
  writeRestartNotice,
  shutdown,
  lifecycle = createLifecycle(),
  restartDrainMs = 30000,
  approvals = null,
  saveApprovedRule = null,
  roster = null,
  inbox = null,
  boardOf = null,
  pauseStore = null,
  botEntries = () => [],
  escapeForDisplay = (s) => s,
  proposals = null,
  proposalContext = null,
  ownerUserId = null,
  execBotKeys = [],
  redeliverProposal = null,
  reissueReview = null,
  // 適用の基点を返す非同期関数 (git を読むのでここでは持たない)。省略すると基点なしで裁定する
  resolveBaseCommit = null,
  // 復旧待ちの一覧 (`/inbox` の 4 節目 — §11.2)。省略すると節が出ない
  recoveryRows = null,
  // `/retry` の実体 (§11.3 — board・実行記録・キュー・契約・bots を持つ index 側)。省略すると無効
  retryTask = null,
  // `/status` の実体 (§11.5)。チャンネル名を受けて 1 通の本文を返す。省略すると無効
  statusReport = null,
  // `/case` の実体 (docs/society-ledger.md)。台帳の読み書きは society の配線が持つ。省略すると無効
  caseCommand = null,
  // `/stop` で案件へ停止マーカーを付ける実体 (§12.2 (g))。省略すると案件は止まらない
  // (社会を持たない配備・mode off はここが no-op になる)
  societyStop = null,
}) {
  // 配線漏れを実行時まで持ち越さない。承認台帳があるのに保存先が無い状態で
  // 起動すると、押せるカードが出て「承認したのに何も保存されない」ことになる
  if (approvals && typeof saveApprovedRule !== 'function') {
    throw new Error('approvals を渡すなら saveApprovedRule も必要です (承認が保存されません)');
  }
  /**
   * スラッシュコマンドの入口。interaction は「呼ばれた 1 体」にしか届かないので、
   * テキスト時代のような message.id による client 間の排他は要らない
   * (state は同一プロセス共有なので、どの bot 経由でも同じ job を止められる)。
   * 認可・管轄チャンネルの条件はメッセージ経路と同じ規則。
   */
  return async function onInteraction(bot, interaction) {
    if (interaction?.isButton?.()) {
      // 裁定カードとツール権限カードは**別系統**。custom ID の接頭辞で振り分け、
      // 認可も台帳も共有しない (§3.9 — 数日待つ裁定を 30 分の承認と混ぜない)
      const proposalButton = parseProposalCustomId(interaction.customId);
      if (proposalButton) await handleProposalButton(interaction, proposalButton);
      else await handleApprovalButton(bot, interaction);
      return;
    }
    if (interaction?.isModalSubmit?.()) {
      const parsed = parseProposalCustomId(interaction.customId);
      if (parsed) await handleRationaleModal(interaction, parsed);
      return;
    }
    if (!interaction?.isChatInputCommand?.()) return;
    if (!interaction.inGuild?.()) return; // DM は対象外

    if (
      !isAuthorizedSender({
        config,
        guildId: interaction.guildId,
        authorId: interaction.user?.id,
        isBot: false,
        ourBotIds: [],
      })
    ) {
      await replyQuietly(interaction, '⚠️ このサーバー / ユーザーからの操作は許可されていません');
      return;
    }

    // 発火はブリッジ管轄チャンネル内に限定する (テキスト時代と同じ)
    if (!interaction.channel || !channelConfigFor(interaction.channel)) {
      await replyQuietly(interaction, unregisteredChannelNotice(config, channelNameOf(interaction.channel)));
      return;
    }

    // ここで先に ACK する。以降の停止処理は Windows では同期 taskkill /T /F を挟み、
    // job 数やプロセスツリー次第で interaction の 3 秒期限を超える —
    // 実際には止まっているのに「アプリケーションが応答しません」になるのを防ぐ。
    // ACK に失敗しても停止・再起動そのものは続ける (応答は best-effort)
    const acked = await ack(interaction);

    if (interaction.commandName === 'stop') {
      await handleStop(interaction, acked);
    } else if (interaction.commandName === 'roster') {
      await handleRoster(interaction, acked);
    } else if (interaction.commandName === 'pause' || interaction.commandName === 'resume') {
      await handlePause(interaction, acked, interaction.commandName === 'pause');
    } else if (interaction.commandName === 'proposals') {
      await handleProposals(interaction, acked);
    } else if (interaction.commandName === 'inbox') {
      await handleInbox(interaction, acked);
    } else if (interaction.commandName === 'review') {
      await handleReview(bot, interaction, acked);
    } else if (interaction.commandName === 'retry') {
      await handleRetry(bot, interaction, acked);
    } else if (interaction.commandName === 'status') {
      await handleStatus(interaction, acked);
    } else if (interaction.commandName === 'case') {
      await handleCase(interaction, acked);
    } else if (interaction.commandName === 'restart') {
      await handleRestart(bot, interaction, interaction.options.getBoolean('force') ?? false, acked);
    } else {
      // 登録済みだがこのプロセスが知らないコマンド (登録の取り残し) を黙殺しない
      await respond(interaction, `⚠️ 未対応のコマンドです: /${interaction.commandName}`, acked);
    }
  };

  /**
   * ツール権限の承認ボタン。
   *
   * 判定はすべて ApprovalRegistry (期限・冪等・文脈の一致) と isAuthorizedSender
   * (guild・ユーザー) に委ね、ここは「押された結果を保存してカードを描き直す」だけを担う。
   * 何かひとつでも噛み合わなければ**何も許可しない** — 判定が付かない側に倒す。
   */
  async function handleApprovalButton(bot, interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return; // 自分のボタンでなければ黙って無視する
    if (!approvals) {
      await replyQuietly(interaction, '⚠️ 承認機能が無効です');
      return;
    }
    if (!interaction.inGuild?.()) {
      await replyQuietly(interaction, '⚠️ DM からは承認できません');
      return;
    }

    const verdict = approvals.resolve({
      nonce: parsed.nonce,
      action: parsed.action,
      userId: interaction.user?.id,
      isBot: Boolean(interaction.user?.bot),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: interaction.message?.id ?? null,
      botKey: bot?.key ?? null,
      isAuthorized: isAuthorizedSender({
        config,
        guildId: interaction.guildId,
        authorId: interaction.user?.id,
        isBot: false,
        ourBotIds: [],
      }),
    });

    if (!verdict.ok) {
      // 押せない理由は本人にだけ返す。カードは決着済みなら描き直してボタンを外す
      await replyQuietly(interaction, `⚠️ ${verdict.reason}`);
      if (verdict.request?.resolved) {
        await updateCard(interaction, verdict.request, stageForResolved(verdict.request.resolved.action));
      } else if (!verdict.request) {
        await updateCard(interaction, { nonce: parsed.nonce }, 'invalid');
      }
      return;
    }

    if (verdict.stage === 'confirm') {
      await updateCard(interaction, verdict.request, 'confirm');
      return;
    }
    if (verdict.stage === 'denied') {
      // 監査ログには値そのものを出さない (指紋と文脈だけ)
      console.log(
        `[tools] 却下: ${grantFingerprint(verdict.request.grant)} ` +
          `(#${verdict.request.channelName}) by ${interaction.user?.id}`,
      );
      await updateCard(interaction, verdict.request, 'denied');
      return;
    }

    // pending-save — **保存が通ってから**確定させる。
    // 先に確定させると、ディスクに書けていない許可が「承認済み」として残り、
    // 次の job では効くのに再起動すると消える、という食い違いになる。
    // hook 経路 (job が止まって待っている) でも順序は同じ — commit がそのまま
    // 待っている hook への allow になるので、保存より先に返してはいけない
    let saved;
    try {
      saved = saveApprovedRule?.(verdict.request);
    } catch (err) {
      await failToSave(interaction, verdict.request, err.message);
      return;
    }
    // 「既にある (ok:true, added:false)」以外の偽値・タグ無しは保存できていない扱い。
    // 「保存できない」を「既に保存済み」と読み替えると、何も許可していないのに
    // 「承認しました」と出てしまう
    if (!saved?.ok) {
      await failToSave(interaction, verdict.request, saved?.reason ?? '保存されませんでした');
      return;
    }

    approvals.commit(parsed.nonce, interaction.user?.id);
    console.log(
      `[tools] 承認: ${grantFingerprint(verdict.request.grant)} (#${verdict.request.channelName}) ` +
        `by ${interaction.user?.id}${saved.added ? '' : ' (既に保存済み)'}`,
    );
    await updateCard(interaction, verdict.request, 'approved', {
      note: saved.added ? '' : '(このルールは既に保存済みでした)',
    });
  }

  /** 保存できなかったときの共通処理 (確定させず、やり直せる形へ戻す) */
  async function failToSave(interaction, request, reason) {
    console.error(`[tools] 承認ルールの保存に失敗: ${reason}`);
    await replyQuietly(interaction, `⚠️ 保存できなかったため承認していません: ${reason}`);
    // 申請は未確定のまま (待っている hook もそのまま待つ — 待機上限まではやり直せる)。
    // 戻す先は経路で違う: hook 経路には確定ボタンが無いので申請段階へ戻す
    await updateCard(interaction, request, request.hook ? 'request' : 'confirm', {
      note: `⚠️ 保存できなかったため、まだ何も許可していません (${reason})`,
    });
  }

  /** カードを描き直す (ボタンの付け外しを含む)。失敗しても判定は済んでいる */
  async function updateCard(interaction, request, stage, { note = '' } = {}) {
    try {
      // 無害化は描画のときだけ。保存されている grant には触らない
      const card = buildApprovalCard(request, { stage, note, escape: escapeForDisplay });
      await interaction.update(safePayload(card));
    } catch { /* カードを描き直せなくても許可の可否は確定している */ }
  }

  // ---- 組織提案の裁定 (§3.9) ----

  /**
   * 裁定の入口で毎回通す関門。**押した人・提案・現在の digest を一度に揃える。**
   *
   * ツール権限の承認とは判定を共有しない。org を裁定できるのは
   * 「interaction で検証した owner」だけで、bot キーでも「bot でない任意ユーザー」でも通さない。
   */
  async function openProposalGate(interaction, id, { reply = null } = {}) {
    // 応答の出し方は経路で違う (ボタンは ephemeral・コマンドは ACK 済みの編集)。
    // ここで固定すると、ACK 済みの interaction へ reply して**無言で落ちる**
    const say = reply ?? ((content) => replyQuietly(interaction, content));
    if (!proposals || typeof proposalContext !== 'function') {
      await say('⚠️ 組織提案の機能が無効です');
      return { ok: false };
    }
    if (!interaction.inGuild?.()) {
      await say('⚠️ DM からは裁定できません');
      return { ok: false };
    }
    if (!isAuthorizedSender({
      config, guildId: interaction.guildId, authorId: interaction.user?.id, isBot: false, ourBotIds: [],
    })) {
      await say('⚠️ このサーバー / ユーザーからの操作は許可されていません');
      return { ok: false };
    }
    // ownerUserId が未設定なら誰も通さない (fail-closed — 設定漏れを「全員可」にしない)
    if (!ownerUserId || interaction.user?.id !== ownerUserId) {
      await say('⚠️ org 提案を裁定できるのは作者 (ownerUserId) だけです');
      return { ok: false };
    }
    let ctx;
    try {
      ctx = proposalContext();
    } catch (err) {
      await say(`⚠️ 提案の前提を読めませんでした: ${err.message}`);
      return { ok: false };
    }
    const proposal = proposals.get(id);
    let currentDigest = null;
    if (proposal) {
      try {
        currentDigest = digestOf(proposal, ctx);
      } catch { currentDigest = null; } // 読めなければ束縛が成立しない = 押しても通さない
    }
    return { ok: true, ctx, proposal, currentDigest };
  }

  /**
   * 裁定ボタン。**採択はここで確定し、却下は理由の入力欄を出す** (作者裁定 2026-08-30)。
   *
   * 却下は終端なので理由が残らないと同じ議論を繰り返す。採択は提案本文と diff が
   * 「何を承認したか」を既に残しているので、押した時点で決まってよい。カードは
   * digest に束縛されているので、押した内容と承認する内容は必ず一致する。
   */
  async function handleProposalButton(interaction, parsed) {
    const gate = await openProposalGate(interaction, parsed.id);
    if (!gate.ok) return;
    const bound = checkProposalBinding(gate.proposal, {
      digest: parsed.digest, currentDigest: gate.currentDigest,
    });
    if (!bound.ok) {
      await handleBindingFailure(interaction, gate, bound);
      return;
    }
    if (parsed.decision === 'accepted') {
      await finalizeAdjudication(interaction, gate, parsed, '');
      return;
    }
    try {
      await interaction.showModal(buildRationaleModal(parsed.action, gate.proposal.id, parsed.digest));
    } catch (err) {
      await replyQuietly(interaction, `⚠️ 理由の入力欄を出せませんでした: ${err.message}`);
    }
  }

  /**
   * 理由の送信 = 裁定の確定。**押下時と同じ照合をもう一度通す** —
   * カードを押してから理由を書くまでの間にも前提は動く。
   */
  async function handleRationaleModal(interaction, parsed) {
    const gate = await openProposalGate(interaction, parsed.id);
    if (!gate.ok) return;
    const bound = checkProposalBinding(gate.proposal, {
      digest: parsed.digest, currentDigest: gate.currentDigest,
    });
    if (!bound.ok) {
      // **ボタン経路と同じ後始末をする。** 押してから理由を書くまでの間に前提が動くのも
      // 同じ「読んでいない内容を承認させない」場面で、古いカードを残す理由が無い
      await handleBindingFailure(interaction, gate, bound);
      return;
    }
    let rationale = '';
    try {
      rationale = interaction.fields?.getTextInputValue?.(RATIONALE_FIELD) ?? '';
    } catch { /* 取り出せなければ空のまま (理由なしとして裁定を通す) */ }
    await finalizeAdjudication(interaction, gate, parsed, rationale);
  }

  /**
   * 裁定の確定とカードの描き直し (ボタンの採択とモーダルの却下で共通)。
   * **束縛の照合は呼び出し側で済ませてある** — ここは確定だけを担う。
   *
   * **何よりも先に ACK し、通らなければ裁定しない。** 永続化とカードの描き直しが 3 秒に
   * 収まる保証は無く、超えると裁定は確定しているのに Discord は「操作に失敗」と出し、
   * 続く返信も通らない (Sol 指摘 2026-08-30)。モーダル経路は `showModal` が ACK を
   * 兼ねていたが、採択をボタンで確定させるようになってこの経路が新しく要る。
   *
   * ACK に失敗したときに**確定させずに降りる**のは、応答できないまま裁定を書くと
   * 同じ不整合が残るため。何もしなければカードはボタンごと残るので、押し直せばやり直せる
   * (digest に束縛されているので、押し直しても承認する内容は変わらない)。
   * `deferUpdate` なので画面には何も出ず、カードは後からこちらで書き換える。
   */
  async function finalizeAdjudication(interaction, gate, parsed, rationale) {
    const acked = await ackSilently(interaction);
    if (!acked) {
      console.error(`[proposals] 提案 ${gate.proposal.id} は応答を返せなかったので裁定しませんでした`);
      return;
    }
    // 基点は git を読むので ACK の後で解決する (3 秒の期限に載せない)。
    // **読めなければ org / process の採択は store 側が断る** — 理由はそのまま
    // 「⚠️ 裁定できませんでした」として本人へ返るので、設定を直して押し直せる
    let baseCommit = null;
    if (typeof resolveBaseCommit === 'function') {
      try {
        baseCommit = await resolveBaseCommit();
      } catch { baseCommit = null; }
    }
    let decided;
    try {
      decided = proposals.adjudicate(gate.proposal.id, {
        decision: parsed.decision,
        rationale,
        actor: { kind: 'owner', userId: interaction.user?.id },
        ctx: gate.ctx,
        ownerUserId,
        execBotKeys,
        baseCommit,
      });
    } catch (err) {
      await replyQuietly(interaction, `⚠️ 裁定できませんでした: ${err.message}`, acked);
      return;
    }

    const stage = decided.decision === 'accepted' ? 'accepted' : 'rejected';
    const card = buildProposalCard(decided, { digest: parsed.digest, stage, escape: escapeForDisplay });
    let edited = false;
    try {
      if (interaction.message) {
        await editSafe(interaction.message, card);
        edited = true;
      }
    } catch { /* 描き直せなくても裁定は確定している */ }
    // カードを描き直せたなら結果はそこに出ている。出せなかったときだけ本文で残す
    if (edited) await replyQuietly(interaction, `${stage === 'accepted' ? '✅ 採択' : '🚫 却下'}しました`, acked);
    else await replyPublic(interaction, card, acked);
  }

  /**
   * 束縛が成立しなかったときの後始末 (ボタン経路とモーダル経路で共通)。
   * 古いカードを無効化し、内容が変わっただけなら最新版を出し直す。
   */
  async function handleBindingFailure(interaction, gate, bound) {
    const answered = await updateProposalCard(
      interaction, gate.proposal, bound.stage, bound.reason, gate.currentDigest,
    );
    // カードを描き直せない経路 (message を持たないモーダル等) では本人に理由だけ返す
    if (!answered) await replyQuietly(interaction, `⚠️ ${bound.reason}`);
    if (bound.stage === 'stale') await followUpProposalCard(interaction, gate.proposal, gate.currentDigest);
  }

  /**
   * 押されたカードを描き直す (ボタンを外す)。
   * @returns {boolean} この interaction へ応答したか (false なら呼び出し側が応答する)
   */
  async function updateProposalCard(interaction, proposal, stage, note, digest) {
    const card = buildProposalCard(proposal ?? {}, {
      digest: digest ?? '', stage, note, escape: escapeForDisplay,
    });
    try {
      await interaction.update(safePayload(card));
      return true;
    } catch { /* update できない経路 (メッセージから来ていないモーダル) は下で拾う */ }
    try {
      if (interaction.message) {
        await editSafe(interaction.message, card);
        return false; // カードは直せたが、interaction にはまだ応答していない
      }
    } catch { /* 描き直せなくても、裁定していないことは変わらない */ }
    return false;
  }

  /** 最新の内容でカードを出し直す (押せるのは owner だけなのでメンションを付ける) */
  async function followUpProposalCard(interaction, proposal, digest) {
    if (!proposal || !digest) return;
    try {
      await interaction.followUp(safePayload(
        buildProposalCard(proposal, {
          digest,
          stage: 'request',
          ownerMention: ownerUserId ? `<@${ownerUserId}>` : null,
          escape: escapeForDisplay,
        }),
        { mentionUserIds: ownerUserId ? [ownerUserId] : [] },
      ));
    } catch { /* 出し直せなければ /proposals から辿れる */ }
  }

  async function replyPublic(interaction, card, acked = false) {
    try {
      const payload = safePayload(card);
      if (acked) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch { /* 応答できなくても裁定は確定している */ }
  }

  /**
   * /review — review のまま止まったタスクのレビューを出し直す。
   *
   * **判断も実行も index 側 (`reissueReview`)** — board も契約も bots もあちらが持つ。
   * ここが持つのは「タスクのスレッドで打たれたか」の門番と、結果の 1 行だけ。
   * スレッド外で id だけ渡されても対象は決めない (スレッドを引くとチャンネル違いの
   * タスクまで動かせる口になる)。
   */
  async function handleReview(bot, interaction, acked) {
    if (!interaction.channel?.isThread?.()) {
      await respond(interaction, '⚠️ タスクのスレッドで打ってください', acked);
      return;
    }
    if (typeof reissueReview !== 'function') {
      await respond(interaction, '⚠️ 自律運転の機能が無効です', acked);
      return;
    }
    const id = (interaction.options?.getString?.('id') ?? '').trim();
    const out = await reissueReview({ thread: interaction.channel, id: id || null, bot });
    const reason = escapeForDisplay(String(out?.reason ?? ''));
    // 理由が既に印を持っていれば重ねない。召喚側の 1 行はそのまま人へ出すものなので
    // ⚠️ / ⏸ で始まることがあり、被せると実機で出た `⚠️ ⚠️ レビュー担当…` になる
    const marked = ['⚠️', '⏸'].some((mark) => reason.startsWith(mark));
    await respond(interaction, marked ? reason : `${out?.ok ? '✅' : '⚠️'} ${reason}`, acked);
  }

  /**
   * /status — このチャンネルの状況 (§11.5)。集計と描画は index 側 (`statusReport`) が
   * board・実行記録・pause・勘定を持って行い、ここはチャンネル名を渡して本文を出すだけ。
   * スレッドで打てば親チャンネルの状況になる (channelConfigFor と同じ解決)。
   */
  async function handleStatus(interaction, acked) {
    if (typeof statusReport !== 'function') {
      await respond(interaction, '⚠️ 状況表示の機能が無効です', acked);
      return;
    }
    const configured = channelConfigFor(interaction.channel);
    const channelName = configured?.channelName ?? null;
    let text;
    try {
      text = await statusReport({ channelName, channel: interaction.channel });
    } catch (err) {
      await respond(interaction, `⚠️ 状況を集計できませんでした: ${escapeForDisplay(String(err?.message ?? err))}`, acked);
      return;
    }
    await respond(interaction, String(text ?? '⚠️ 状況を集計できませんでした').slice(0, 1900), acked);
  }

  /**
   * /case — 自律社会の案件を見る / 開く / 相談を出す。
   *
   * `/status` と同じ型: **引数の組み合わせの検査だけここで済ませ** (`resolveCaseRequest`)、
   * 台帳の読み書きは index 側 (`caseCommand` → `src/bridge/society.js`) に任せる。
   * スレッドで打てばその ID を渡す — 手で開いた案件をそのスレッドに結び、相談もそこへ送る。
   */
  async function handleCase(interaction, acked) {
    if (typeof caseCommand !== 'function') {
      await respond(interaction, '⚠️ 案件 (自律社会) の機能が無効です', acked);
      return;
    }
    const resolved = resolveCaseRequest({
      id: interaction.options.getString('id'),
      resume: interaction.options.getString('resume'),
      new: interaction.options.getString('new'),
      goal: interaction.options.getString('goal'),
      acceptance: interaction.options.getString('acceptance'),
      bot: interaction.options.getString('bot'),
      responsibility: interaction.options.getString('responsibility'),
      summary: interaction.options.getString('summary'),
    });
    if (!resolved.ok) {
      await respond(interaction, `⚠️ ${escapeForDisplay(resolved.reason)}`, acked);
      return;
    }
    // **案件を開く / 相談を出す / 停止を解除するのは owner だけ** (Fable 裁定 2026-09-08)。
    // 予算と責任を動かす操作なので org 提案の裁定と同じ扱いにする。一覧と詳細は許可ユーザー
    // 全員が読める。ownerUserId が未設定なら誰も通さない (fail-closed — 設定漏れを「全員可」にしない)。
    // 再開が owner 限定なのは §12.2 (g) —「解除は owner の操作か同じ認可の操作だけ」
    if (['new', 'offer', 'resume'].includes(resolved.request.action)
      && (!ownerUserId || interaction.user?.id !== ownerUserId)) {
      await respond(interaction, '⚠️ 案件を開く / 相談を出す / 停止を解除できるのは作者 (ownerUserId) だけです', acked);
      return;
    }
    const configured = channelConfigFor(interaction.channel);
    let text;
    try {
      text = await caseCommand({
        ...resolved.request,
        channelName: configured?.channelName ?? null,
        threadId: interaction.channel?.isThread?.() ? interaction.channel.id : null,
        userId: interaction.user?.id ?? null,
      });
    } catch (err) {
      await respond(interaction, `⚠️ 案件を読めませんでした: ${escapeForDisplay(String(err?.message ?? err))}`, acked);
      return;
    }
    await respond(interaction, String(text ?? '⚠️ 案件を読めませんでした').slice(0, 1900), acked);
  }

  /**
   * /retry — 止まったタスクを同じ仕事の続きとして起こし直す (§11.3)。
   *
   * `/review` と同じ型: 判断も実行も index 側 (`retryTask`)、ここは「タスクのスレッドで
   * 打たれたか」の門番と結果の表示だけ。認可は既存の許可ユーザー (入口で済んでいる)。
   * 実体が付ける警告 (`warnings`) は理由の下に ⚠️ で並べる。
   */
  async function handleRetry(bot, interaction, acked) {
    if (!interaction.channel?.isThread?.()) {
      await respond(interaction, '⚠️ タスクのスレッドで打ってください', acked);
      return;
    }
    if (typeof retryTask !== 'function') {
      await respond(interaction, '⚠️ 復旧の機能が無効です', acked);
      return;
    }
    const id = (interaction.options?.getString?.('id') ?? '').trim();
    let out;
    try {
      out = await retryTask({ thread: interaction.channel, id: id || null, bot, userId: interaction.user?.id ?? null });
    } catch (err) {
      await respond(interaction, `⚠️ 起こし直せませんでした: ${escapeForDisplay(String(err?.message ?? err))}`, acked);
      return;
    }
    const reason = escapeForDisplay(String(out?.reason ?? ''));
    const marked = ['⚠️', '⏸', '🔁', '✅'].some((mark) => reason.startsWith(mark));
    const head = marked ? reason : `${out?.ok ? '🔁' : '⚠️'} ${reason}`;
    const warnings = (Array.isArray(out?.warnings) ? out.warnings : [])
      .map((w) => `⚠️ ${escapeForDisplay(String(w))}`);
    await respond(interaction, [head, ...warnings].join('\n').slice(0, 1900), acked);
  }

  /**
   * /proposals — 裁定待ちの一覧と、カードの出し直しと、取り下げ。
   * カードがスクロールで流れると裁定待ちのまま止まるので、常設の入口を持つ。
   */
  async function handleProposals(interaction, acked) {
    if (!proposals || typeof proposalContext !== 'function') {
      await respond(interaction, '⚠️ 組織提案の機能が無効です', acked);
      return;
    }
    const id = (interaction.options?.getString?.('id') ?? '').trim();
    const withdrawReason = (interaction.options?.getString?.('withdraw') ?? '').trim();
    if (!id) {
      // **理由だけでは対象が決まらない。** 一覧を返して黙って流すと、取り下げたつもりの
      // 提案が残る — 何もしなかったことをその場で言う
      if (withdrawReason) {
        await respond(interaction, '⚠️ 取り下げる提案の id も指定してください', acked);
        return;
      }
      await respond(interaction, formatProposalQueue(proposals.openList(), { escape: escapeForDisplay }), acked);
      return;
    }
    const gate = await openProposalGate(interaction, id, {
      reply: (content) => respond(interaction, content, acked),
    });
    if (!gate.ok) return;
    if (!gate.proposal) {
      await respond(interaction, `⚠️ 提案 #${escapeForDisplay(id)} は見つかりません`, acked);
      return;
    }
    if (withdrawReason) {
      await withdrawProposal(interaction, gate.proposal, withdrawReason, acked);
      return;
    }
    // **work / process は押せるカードを持たない** (bot はボタンを押せない) ので、
    // 「裁定できる bot を起こし直す」がここでの出し直しにあたる (sol 指摘 2026-08-30)。
    // これが無いと、配れなかった提案を人間が動かす手段がない
    if (gate.proposal.class !== 'org' && gate.proposal.state === 'deliberating') {
      const out = typeof redeliverProposal === 'function'
        ? await redeliverProposal(gate.proposal.id)
        : { ok: false, reason: '配り直しの口が配線されていません' };
      await respond(
        interaction,
        `${out.ok ? '📮' : '⚠️'} ${escapeForDisplay(out.reason)}\n`
        + formatProposalQueue([gate.proposal], { escape: escapeForDisplay }),
        acked,
      );
      return;
    }
    // org の裁定待ちだけが押せるカードになる。それ以外は状態を 1 行で返す
    const bound = checkProposalBinding(gate.proposal, {
      digest: gate.currentDigest, currentDigest: gate.currentDigest,
    });
    if (!bound.ok) {
      await respond(interaction, `${bound.reason}\n${formatProposalQueue([gate.proposal], { escape: escapeForDisplay })}`, acked);
      return;
    }
    await respond(
      interaction,
      buildProposalCard(gate.proposal, {
        digest: gate.currentDigest,
        stage: 'request',
        ownerMention: ownerUserId ? `<@${ownerUserId}>` : null,
        escape: escapeForDisplay,
      }),
      acked,
      { mentionUserIds: ownerUserId ? [ownerUserId] : [] },
    );
  }

  /**
   * /proposals id:<n> withdraw:<理由> — 提案を取り下げて閉じる (作者裁定 2026-09-04)。
   *
   * 再裁定 (`deliberating` へ戻す) では閉じられない提案がある — 手で転記済み・作り直した・
   * 前提ごと消えた。裁定と同じく**押せるのは作者だけ** (門番は `openProposalGate`)。
   *
   * 断るのは 2 つだけ:
   * - **終端の提案** … `withdrawn` / `measured` / `adjudicated:rejected`。store 側も遷移表で
   *   断るが、理由が「終端からは動かせません」になるので、ここで状態を添えて返す
   * - **適用中の提案** … 錠 (`applyTaskId`) が掛かっている = 適用 task と作業ツリーが
   *   生きている。先に閉じると検収の宛先が消えて後始末の道が無くなる (§3.9)
   */
  async function withdrawProposal(interaction, proposal, reason, acked) {
    const shown = escapeForDisplay(String(proposal.id));
    if (isTerminal(proposal)) {
      await respond(
        interaction,
        `⚠️ 提案 #${shown} は既に閉じています (${escapeForDisplay(proposal.state)})`,
        acked,
      );
      return;
    }
    if (typeof proposal.applyTaskId === 'string' && proposal.applyTaskId.trim() !== '') {
      await respond(
        interaction,
        `⚠️ 提案 #${shown} は適用中です (タスク #${escapeForDisplay(proposal.applyTaskId)})`
        + ' — 先に検収で片付けてください',
        acked,
      );
      return;
    }
    try {
      proposals.withdraw(proposal.id, { reason, by: `owner:${interaction.user?.id}` });
    } catch (err) {
      await respond(interaction, `⚠️ 取り下げられませんでした: ${escapeForDisplay(err.message)}`, acked);
      return;
    }
    await respond(interaction, `🗑 提案 #${shown} を取り下げました: ${escapeForDisplay(reason)}`, acked);
  }

  /**
   * /inbox — 作者を待っているもの (停止・質問 / 稟議 / 要人間) の一覧 (§10.4)。
   *
   * **正本は動かさない。** 台帳を持つのは停止通知だけで、稟議と blocked は
   * ここで読むだけ。だから稟議 / blocked は `close` の対象にしない — あちらは
   * 裁定カードと `resume` という正本側の操作で消える。
   */
  async function handleInbox(interaction, acked) {
    if (!inbox) {
      await respond(interaction, '⚠️ 受信箱の機能が無効です', acked);
      return;
    }
    const board = typeof boardOf === 'function' ? boardOf() : null;
    // 一覧は `#3` と出すので、作者はそれをそのまま写して打つ。先頭の `#` を 1 つ剥がさないと
    // 「未知の id」になり、しかも応答が `##3` と二重になる (レビュー指摘 2026-09-02)
    const closeId = (interaction.options?.getString?.('close') ?? '').trim().replace(/^#/, '');
    if (closeId) {
      let closed;
      try {
        closed = inbox.close(closeId);
      } catch (err) {
        await respond(interaction, `⚠️ 閉じられませんでした: ${escapeForDisplay(err.message)}`, acked);
        return;
      }
      // 「見つからない」と「既に閉じている」を区別する — 後者は誰かが答えた印なので、
      // 同じ ⚠️ にまとめると「打ち間違えた」と読めてしまう
      const known = inbox.get(closeId);
      if (closed) {
        await respond(interaction, `📪 #${escapeForDisplay(closeId)} を閉じました (手動)`, acked);
      } else if (known) {
        await respond(interaction, `📪 #${escapeForDisplay(closeId)} は既に閉じています`, acked);
      } else {
        await respond(interaction, `⚠️ 停止通知 #${escapeForDisplay(closeId)} は見つかりません`, acked);
      }
      return;
    }
    // 復旧待ちは実行記録・キュー・契約を読む判定なので index 側から関数で受ける。
    // 判定が落ちても他の 3 節は出す (受信箱は「見えなくなる」のがいちばん悪い)
    let recoveries = [];
    if (typeof recoveryRows === 'function') {
      try {
        recoveries = recoveryRows() ?? [];
      } catch (err) {
        console.error(`[inbox] 復旧待ちの判定に失敗 (節を出さずに続けます): ${err?.message ?? err}`);
      }
    }
    await respond(
      interaction,
      formatInbox({
        notifies: inbox.openList(),
        proposals: proposals ? proposals.openList() : [],
        tasks: board ? board.list() : [],
        recoveries,
        escape: escapeForDisplay,
        findTask: (threadId) => board?.findByThread(threadId) ?? null,
      }),
      acked,
    );
  }

  /**
   * /stop 処理。scope 未指定 = このスレッドの job だけ、
   * scope:all とチャンネル直 (止める対象のスレッドが無い) = 全 job を対象にする。
   */
  async function handleStop(interaction, acked) {
    const inThread = Boolean(interaction.channel.isThread?.());
    const { all, fellBackToAll } = resolveStopScope({
      scope: interaction.options.getString('scope'),
      inThread,
    });
    const threadId = inThread ? interaction.channel.id : null;

    // 案件 (自律社会) の停止マーカーは **job を止めるより先に**付ける (§12.2 (g)) —
    // 先に印があれば、実行中 job の settle も待機中 job の取り消しも台帳の停止分岐に入り、
    // 結果は残しつつ案件は動かない。後から付けると、その間に届いた戻りが案件を進めてしまう
    let stopped = null;
    const { active, dequeued } = stopJobs(jobs, {
      threadId,
      all,
      message: '⏹ キャンセルされました',
      onSelected: typeof societyStop !== 'function' ? null : ({ active: running, dequeued: waiting }) => {
        try {
          stopped = societyStop({
            threadId,
            all,
            userId: interaction.user?.id ?? null,
            jobIds: [...running, ...waiting].map((item) => item.jobId).filter(Boolean),
          });
        } catch (err) {
          // 印を付けられなかったことは**必ず返す** — job だけ止まって案件は動けるので、
          // 黙って落とすと「止めたはずのものが次の tick で動く」を人が知る手段が無くなる
          stopped = { ok: false, code: 'error', reason: String(err?.message ?? err), stopped: [] };
        }
      },
    });

    // 「中断した」と断言しない — 完了報告は job 側の ⏹ placeholder 編集が正
    const lines = [
      `⏹ 停止指示 (${all ? '全体' : 'このスレッド'}${fellBackToAll ? ' — スレッド外なので全体扱い' : ''}): `
        + `実行中 ${active.length} 件へ中断を送信・待機 ${dequeued.length} 件を取り消しました`
        + `${active.length ? '。中断完了は ⏹ 表示で確認できます' : ''}`,
    ];
    if (stopped && stopped.ok === false) {
      lines.push(`⚠️ 案件の台帳が読めないので停止マーカーは付けられませんでした (${escapeForDisplay(String(stopped.code ?? '理由不明'))})`);
    }
    // **案件ごとに 1 行**。止めた本人がそのまま再開の口を打てるように、id 付きで書く
    for (const caseId of stopped?.stopped ?? []) {
      lines.push(`⏹ 案件 ${escapeForDisplay(String(caseId))} も停止しました (再開は \`/case resume:${caseId}\`)`);
    }
    await respond(interaction, lines.join('\n').slice(0, 1900), acked);
  }

  /**
   * /roster 処理。このスレッドで呼んでよい bot を絞る (省略時は現況の表示だけ)。
   *
   * 編成はスレッド単位。チャンネル直で受けると「どのスレッドの話か」が決まらないので
   * 保存せず断る。効くのは**次の job から** — 実行中の job が既に組み立てた
   * 実行文脈は書き換わらない (ツール権限の承認と同じ性質)。
   *
   * チャンネル既定 (`channels.<name>.roster`) があるスレッドでは、ここでの指定が
   * それを**上書き**する。だから解除 (`all`) で戻る先は「全員」ではなく既定。
   */
  async function handleRoster(interaction, acked) {
    if (!roster) {
      await respond(interaction, '⚠️ 編成機能が無効です', acked);
      return;
    }
    if (!interaction.channel.isThread?.()) {
      await respond(interaction, '⚠️ 編成はスレッド単位です — スレッドの中で実行してください', acked);
      return;
    }

    const threadId = interaction.channel.id;
    const entries = botEntries();
    // チャンネル既定 (config.json) は /roster を打っていないスレッドで効いている。
    // 素の roster.get だけを見て「未設定」と返すと、実際には絞られているのに
    // 「全員呼べます」と言うことになる
    const channelRoster = resolveChannelRoster(channelConfigFor(interaction.channel) ?? {});
    const input = interaction.options.getString('members');
    if (input === null || input === undefined) {
      const { keys, source } = resolveEffectiveRoster(roster.get(threadId), channelRoster);
      await respond(interaction, `👥 このスレッドの編成: ${formatRoster(keys, entries, source)}`, acked);
      return;
    }

    const parsed = parseRosterMembers(input, entries.map((e) => e.key));
    if (!parsed.ok) {
      await respond(interaction, `⚠️ ${parsed.reason}`, acked);
      return;
    }

    // 保存できたことを確認してから「変えました」と言う (承認ルールと同じ理由)
    try {
      if (parsed.keys === null) {
        const had = roster.clear(threadId);
        // 解除で戻る先は「全員」ではなくチャンネル既定。既定があるチャンネルで
        // 「すべて呼べます」と言うと、次の handoff が弾かれた理由が分からなくなる
        const { keys, source } = resolveEffectiveRoster(null, channelRoster);
        const after = formatRoster(keys, entries, source);
        await respond(
          interaction,
          had
            ? `👥 スレッドの編成を解除しました → ${after} (次の job から)`
            : `👥 スレッドの編成は元から未設定です → ${after}`,
          acked,
        );
        return;
      }
      roster.set(threadId, parsed.keys, {
        setBy: interaction.user?.id ?? null,
        setAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[roster] 保存に失敗: ${err.message}`);
      await respond(interaction, `⚠️ 保存できなかったため編成は変えていません: ${err.message}`, acked);
      return;
    }

    // 起動していない bot を編成に入れるのは許す (あとで起動する) が、黙って呑まない
    const offline = parsed.keys.filter((k) => !entries.find((e) => e.key === k)?.userId);
    console.log(`[roster] thread:${threadId} → ${parsed.keys.join(' / ') || '(なし)'} by ${interaction.user?.id}`);
    await respond(
      interaction,
      `👥 このスレッドの編成: ${formatRoster(parsed.keys, entries, 'thread')} (次の job から)`
        + `${offline.length ? `\n⚠️ ${offline.join(' / ')} はいま起動していません` : ''}`,
      acked,
    );
  }

  /**
   * /pause・/resume 処理 (docs/social-engineering.md §3.7 の kill switch)。
   *
   * **止めるのは自律起動だけ。** 実行中の job は殺さず、人間のメンション・handoff・
   * 自己呼び出しは従来どおり通る — 「社会が勝手に動き出すのを止める」ためのもので、
   * 「いま動いているものを殺す」のは /stop の仕事。
   *
   * 保存できたことを確かめてから「止めました」と言う (/roster と同じ理由 —
   * 書けていないのに止めたと言うと、動き続けているのに人が安心する)。
   */
  async function handlePause(interaction, acked, wantPause) {
    if (!pauseStore) {
      await respond(interaction, '⚠️ 自律運転の停止機能が無効です', acked);
      return;
    }
    // 台帳が読めないときは停止扱いで固定 (§12.3 (1))。**どちらの操作も効かない** —
    // 書けば壊れた中身 (人が直すための証拠) が消えるし、解けてしまえば
    // 「pause.json を壊せば kill switch が外れる」経路になる
    const broken = pauseStore.broken ?? null;
    if (broken) {
      await respond(
        interaction,
        `${formatPauseState(pauseStore.current())}\n`
        + `— data/pause.json が読めないので**停止扱い**です (${String(broken?.reason ?? broken)})。`
        + '`/pause` も `/resume` も効きません — 台帳を直すか手で退避してから再起動してください',
        acked,
      );
      return;
    }
    const before = pauseStore.current();
    const userId = interaction.user?.id ?? null;

    if (wantPause) {
      if (before) {
        await respond(interaction, `${formatPauseState(before)}\n— 既に止まっています`, acked);
        return;
      }
      let entry;
      try {
        entry = pauseStore.pause({ by: userId, reason: interaction.options.getString('reason') ?? '' });
      } catch (err) {
        console.error(`[pause] 保存に失敗: ${err.message}`);
        await respond(interaction, `⚠️ 保存できなかったため止めていません: ${err.message}`, acked);
        return;
      }
      console.log(`[pause] 自律運転を停止 by ${userId}${entry.reason ? ` — ${entry.reason}` : ''}`);
      await respond(
        interaction,
        `${formatPauseState(entry)}\n`
        + '— 新しい自律起動 (着手・巡回・承認/レビューの召喚) を止めました。'
        + '実行中の job はそのまま動き、人間のメンション・handoff・自己呼び出しも通ります。'
        + '再開は `/resume`',
        acked,
      );
      return;
    }

    if (!before) {
      await respond(interaction, `${formatPauseState(null)}\n— 元から止まっていません`, acked);
      return;
    }
    try {
      pauseStore.resume({ by: userId });
    } catch (err) {
      console.error(`[pause] 保存に失敗: ${err.message}`);
      await respond(interaction, `⚠️ 保存できなかったため再開していません: ${err.message}`, acked);
      return;
    }
    console.log(`[pause] 自律運転を再開 by ${userId}`);
    await respond(
      interaction,
      `${formatPauseState(null)}\n— 再開しました (${formatJst(before.at) ?? '時刻不明'} からの停止を解除`
      + `${String(before.reason ?? '').trim() ? ` / 理由: ${before.reason}` : ''})`,
      acked,
    );
  }

  /**
   * /restart 処理。job が動いている間の素の restart は拒否して現況を返し、
   * force:true のときだけ stop all 相当で中断してから終了コード 42 で落ちる。
   */
  async function handleRestart(bot, interaction, force, acked) {
    const verdict = evaluateRestart({
      activeCount: jobs.activeCount,
      waitingCount: jobs.waitingCount,
      force,
    });
    if (!verdict.allowed) {
      await respond(interaction, restartRejectionMessage(verdict), acked);
      return;
    }

    // 再起動が確定した — **最初の await より前に**受付を閉じる。応答を待っている
    // 数百 ms の間に届いたメンションを spawn すると、直後の shutdown で中断される
    // だけの job が生まれる (sol 指摘)。job の有無によらず閉じる
    lifecycle.stopAccepting();

    // stop all 相当 — 実行中は abort、待機は取り消してから落とす。
    // **job が 0 件でも通す。** キューに載っていない受付 (⏳ の送信中) が
    // 残っていることがあり、busy 判定だけで分岐すると取りこぼす (sol 指摘)
    const { active, dequeued, cancelled } = stopJobs(jobs, {
      all: true, message: CANCEL_ON_RESTART, stopKind: STOP_BY.SHUTDOWN,
    });
    // 取消編集・応答・drain・進行中の受付を**同じ起点から並行に**走らせ、全体を
    // 1 つの締め切り (restartDrainMs = 作者裁定 30 秒) に収める。直列にすると
    // 待ち時間が足し算になって裁定した上限を超える (sol 指摘)。
    // 応答を待たずに drain を始めるのも要点 — 応答が返らないだけで中断完了の
    // 確認が始まらないのは本末転倒。ここはまだ shutdown の hardExit の管理外
    // なので、返らない I/O は自前の上限で打ち切る (でないと受付を閉じたまま居座る)。
    // allSettled なのは 1 本の失敗で締め切り待ちごと倒さないため
    await withDeadline(
      Promise.allSettled([
        cancelled,
        // 応答は drain の完了を待たずに返す (待つと再起動の間に interaction が失効する)
        respond(
          interaction,
          verdict.busy
            ? `🔄 再起動します (実行中 ${active.length} 件へ中断を送信・待機 ${dequeued.length} 件を取り消し)`
            : '🔄 再起動します',
          acked,
        ),
        active.length > 0 ? waitForJobsDrained(restartDrainMs) : Promise.resolve(),
        lifecycle.waitForAdmissions(),
      ]),
      restartDrainMs,
    );

    writeRestartNotice({ channelId: interaction.channelId, botKey: bot.key });
    // 上の 1 枠 (restartDrainMs = 作者裁定 30 秒) で drain も進行中の受付も
    // 待ち切っている。drained を伝えないと shutdown 側が待ち直し、実効待機が
    // 30 秒 + shutdown 側の枠になって裁定とずれる (sol 指摘)
    await shutdown(RESTART_EXIT_CODE, CANCEL_ON_RESTART, { drained: true });
  }
}

/**
 * 待機 job の取り消し (⏳ を放置しない)。
 * 編集の完了を Promise で返す — 終了直前に呼ぶ側 (shutdown) は、Discord client を
 * destroy する前に「取り消しました」を出し切る必要がある。急がない呼び出し側は
 * 待たなくてよい (allSettled なので放置しても unhandled rejection にならない)。
 */
function cancelWaiting(dequeued, message) {
  return Promise.allSettled(
    dequeued.map(async (item) => {
      if (item.handle) item.handle.stopRequested = true;
      if (item.placeholder) await editSafe(item.placeholder, message);
    }),
  );
}

/** 停止の指示を出した主体 (実行記録に残す — src/jobruns.js の STOP_KINDS と同じ語) */
export const STOP_BY = Object.freeze({ HUMAN: 'human', SHUTDOWN: 'shutdown' });

/**
 * stop 対象を選び、実行中には中断を送り、待機は取り消す。
 * `/stop`・`/restart force`・shutdown (SIGINT/SIGTERM) の共通処理。
 *
 * **実行中 job の `handle.abort()` を呼ぶのは呼び出し側の責務** という
 * `selectForStop` の契約 (`src/queue.js:137-150`) を守る唯一の場所にする。
 * 分割代入で `active` を落とすと子プロセスツリーが孤児として残るため
 * (T1 のバグ)、選択と abort を切り離せない形にまとめてある。
 *
 * `stopKind` は「誰が止めたか」(human = /stop、shutdown = 再起動・プロセス終了)。
 * item が `onStop` を持っていれば **abort より先に**知らせる — 実行記録に
 * 「意図的な停止」と残すためで、中断そのものには関与しない (throw しても止める)。
 *
 * `onSelected` は**選択の直後・停止の前**に 1 回だけ呼ぶ (`/stop` の案件停止マーカー)。
 * ここに置くのは `selectForStop` が待機 job をキューから外す破壊的操作で、
 * **呼び出し側がもう一度呼んで対象を数え直せない**ため — 2 回呼ぶと 2 回目の `dequeued` が
 * 空になり、⏳ の取り消し編集も実行記録の cancel も走らなくなる。
 * 例外は握る (記録できなくても止める判断は変わらない — `onStop` と同じ流儀)。
 *
 * @returns {{active: object[], dequeued: object[], cancelled: Promise}}
 *   cancelled は待機 job の placeholder 編集の完了 (await は任意)
 */
export function stopJobs(jobs, {
  threadId = null, all = false, message, stopKind = STOP_BY.HUMAN, onSelected = null,
}) {
  const { active, dequeued } = jobs.selectForStop({ threadId, all });
  if (typeof onSelected === 'function') {
    try { onSelected({ active, dequeued }); }
    catch { /* 印を付けられなくても job は止める */ }
  }
  for (const item of dequeued) notifyStop(item, { kind: stopKind, waiting: true });
  for (const item of active) notifyStop(item, { kind: stopKind, waiting: false });
  const cancelled = cancelWaiting(dequeued, message);
  for (const item of active) item.handle?.abort?.();
  return { active, dequeued, cancelled };
}

function notifyStop(item, info) {
  if (typeof item?.onStop !== 'function') return;
  try {
    item.onStop(info);
  } catch { /* 記録できなくても止める判断は変わらない */ }
}

/**
 * 開始できる job を起こす (src/bridge/queue.js の pump の中身)。
 * 停止が始まっていたら 1 本も起こさない — 待機分は shutdown 側が dequeue して
 * ⏹ に編集するので、ここで起動しても殺す対象が増えるだけになる。
 * @returns {object[]} 起動した item
 */
export function pumpJobs(jobs, lifecycle, start) {
  if (!lifecycle.accepting) return [];
  const started = jobs.takeStartable();
  for (const item of started) start(item);
  return started;
}

/**
 * job の受付 (⏳ の送信 → キュー投入) — src/bridge/messages.js の onMessage 末尾の中身。
 *
 * onMessage は入口の判定からここへ来るまでに trigger 解決・スレッド作成・⏳ の送信で
 * 何度も await する。**その間に Ctrl-C が入ると shutdown の `selectForStop` は既に
 * 済んでいて、あとから積んだ job は誰にも止められないまま ⏳ だけが残る** (sol 指摘)。
 * だから Discord を叩く直前と、往復から戻った直後にもう一度見る。
 *
 * @param {object} p
 * @param {object} p.lifecycle        createLifecycle の戻り値
 * @param {() => Promise<object|null>} p.sendPlaceholder ⏳ を送る
 * @param {(placeholder: object|null) => void} p.accept   キューへ積む (受け付けたときだけ)
 * @returns {Promise<{admitted: boolean, placeholder: object|null}>}
 */
export async function admitJob({
  lifecycle,
  sendPlaceholder,
  accept,
  cancelMessage = NOT_ADMITTED,
  editPlaceholder = editSafe,
}) {
  if (!lifecycle.accepting) return { admitted: false, placeholder: null };
  // **最初の await より前に**進行中として登録する。⏳ の送信待ちの間に
  // shutdown が始まると、キューがまだ空なので selectForStop では拾えず、
  // 待たずに exit すると送信済みの ⏳ が取り消せないまま残る (sol 指摘)
  const finishAdmission = lifecycle.beginAdmission();
  try {
    const placeholder = await sendPlaceholder();
    if (!lifecycle.accepting) {
      // ⏳ を出してしまった後に停止が始まった — 放置せず取り消しを見せる
      try {
        if (placeholder) await editPlaceholder(placeholder, cancelMessage);
      } catch { /* スレッドごと消えていることもある。受け付けない判断は済んでいる */ }
      return { admitted: false, placeholder };
    }
    accept(placeholder);
    return { admitted: true, placeholder };
  } finally {
    finishAdmission();
  }
}

/**
 * 終了前の後始末の本体 (SIGINT / SIGTERM / restart 共通)。
 *
 * **実行中 job には必ず abort を送る。** Windows の child.kill は直下しか terminate
 * しないので、ここを抜かすと claude ツリーがブリッジより長生きしてファイルを書き
 * 続ける (`src/proc.js:13-15`)。abort は killTree を撃つだけでレーンの解放は job
 * 自身の finish なので、一時ディレクトリの掃除 (runJob の finally) を走らせるには
 * drain を待つ必要がある。
 *
 * 取消編集・drain・進行中の受付 (admitJob) は**並行に**待つ。直列にすると編集が
 * 遅れた分だけ drain の持ち時間が削られ、「drainMs 秒待つ」がその通りにならない
 * (sol 指摘)。全体の上限は hardExitMs。
 *
 * @param {object} p
 * @param {number} p.drainMs      中断完了を待つ上限。**hardExitMs より短いこと**。
 *        0 なら drain しない
 * @param {number} p.hardExitMs   Discord API が固まっても必ず終わる保険
 * @param {boolean} [p.drained]   呼び出し元が**自前の枠で** drain と進行中の受付を
 *        待ち切っている (/restart force)。ここで待ち直すと待ち時間が足し算になる
 * @param {(ms: number) => Promise<void>} p.drain  中断完了待ち
 * @param {() => Promise<unknown>} p.destroyClients Discord client の切断
 * @param {() => void} p.exit     プロセス終了 (process.exit)
 * @param {() => unknown} [p.abortOrgApply] **job ではない子プロセス**の中断。
 *        org-apply の verify は tick から走るのでキューに居らず、`stopJobs` では撃てない
 *        (`/stop` の対象外なのも同じ理由 — あれはスレッド単位の job 停止)
 * @returns {Promise<boolean>} 自分が終了処理を走らせたなら true (二重呼び出しは false)
 */
export async function runShutdown({
  jobs,
  lifecycle,
  cancelMessage,
  drainMs,
  hardExitMs,
  drained = false,
  drain,
  destroyClients,
  exit,
  abortOrgApply = null,
}) {
  if (!lifecycle.beginShutdown()) return false;
  const hardExit = setTimeout(exit, hardExitMs);
  const { active, cancelled } = stopJobs(jobs, {
    all: true, message: cancelMessage, stopKind: STOP_BY.SHUTDOWN,
  });
  // job の abort と**同じ瞬間に**適用回路も撃つ。落ちても停止は続ける
  // (撃てなかったことでプロセスが居座る方が悪い — notifyStop と同じ流儀)
  if (typeof abortOrgApply === 'function') {
    try { abortOrgApply(); }
    catch (err) { console.error(`[org-apply] 停止を伝えられませんでした: ${err.message}`); }
  }
  await Promise.all([
    cancelled,
    // まだキューに載っていない受付 (⏳ の送信中) の決着も待つ。全体の上限は hardExit。
    // drained のときは呼び出し元が自前の枠で待ち切っているので待ち直さない
    drained ? Promise.resolve() : lifecycle.waitForAdmissions(),
    drainMs > 0 && !drained && active.length > 0 ? drain(drainMs) : Promise.resolve(),
  ]);
  await destroyClients();
  clearTimeout(hardExit);
  exit();
  return true;
}

/**
 * 上限つきで待つ (待ち切れなければ諦めて進む)。
 * 終了処理の途中で 1 本の Discord I/O が返らないだけでプロセスが居座らないための保険。
 * 呼び出し側が hardExit の管理下に入る前に使う。
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * 停止・再起動の進行状態。「停止が始まったら新規 job を受け付けない」を 1 か所に持つ。
 *
 * drain 待ちの数秒〜数十秒の間に届いたメンションを spawn すると、せっかく
 * 中断した子プロセスツリーが増えるだけで終わる (しかも次プロセスへは
 * 引き継がれない)。配線先は src/bridge/ の queue (pump) / messages (onMessage) / shutdown だが、
 * 判定は配線から分けてここに置く。
 *
 * 「受付の進行中 (⏳ を送っている最中)」も数える。キューにはまだ載っていないので
 * `selectForStop` では拾えず、待たずに exit すると ⏳ が Discord に残る (sol 指摘)。
 */
export function createLifecycle() {
  let accepting = true;
  let shuttingDown = false;
  let inFlight = 0; // 進行中の受付 (admitJob) の数
  const idleWaiters = [];

  return {
    /** 新規 job を受け付けてよいか */
    get accepting() {
      return accepting;
    },
    /** 進行中の受付の数 (診断用) */
    get pendingAdmissions() {
      return inFlight;
    },
    /** 受付だけ止める (まだ終了しない場面 — /restart force の drain 待ちなど) */
    stopAccepting() {
      accepting = false;
    },
    /**
     * 受付処理の開始を登録する。**返った関数を finally で必ず呼ぶ。**
     * 呼ばないと shutdown が hardExit まで待つことになる。
     * @returns {() => void} 解除 (二重呼び出しは無視される)
     */
    beginAdmission() {
      inFlight++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight--;
        if (inFlight === 0) while (idleWaiters.length) idleWaiters.pop()();
      };
    },
    /** 進行中の受付が片付くのを待つ (無ければ即座に返る) */
    waitForAdmissions() {
      if (inFlight === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    /**
     * 終了処理の開始を宣言する (受付も止まる)。
     * @returns {boolean} 自分が最初の呼び出しなら true — 二重 shutdown はここで弾く
     */
    beginShutdown() {
      accepting = false;
      if (shuttingDown) return false;
      shuttingDown = true;
      return true;
    },
  };
}

/**
 * 本人にだけ見える返信 (拒否理由をチャンネルに撒かない)。
 * **ACK 済みなら followUp** — `reply` は 1 つの interaction に一度しか通らない。
 */
async function replyQuietly(interaction, content, acked = false) {
  try {
    const payload = safePayload(content, { flags: EPHEMERAL });
    if (acked) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch { /* 応答できなくても入口を通さない判断は済んでいる */ }
}

/**
 * カードを自分で書き換える経路の ACK。**何も表示せずに 3 秒の期限から降りる。**
 * `deferReply` と違って「考え中」のプレースホルダを残さないので、この後で
 * 元のメッセージを差し替えても表示が二重にならない。
 */
async function ackSilently(interaction) {
  try {
    await interaction.deferUpdate();
    return true;
  } catch {
    return false;
  }
}

/** 先に ACK して 3 秒の期限から降りる。成否を返す (失敗しても処理は続ける) */
async function ack(interaction) {
  try {
    await interaction.deferReply();
    return true;
  } catch {
    return false;
  }
}

/** ACK 済みなら editReply、失敗していたら reply を試す */
async function respond(interaction, content, acked, opts = {}) {
  const payload = safePayload(content, opts);
  try {
    if (acked) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch { /* 応答できなくても停止・再起動は続ける */ }
}
