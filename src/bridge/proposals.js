// 組織提案 (docs/social-engineering.md §3.9) の配線 (src/index.js から切り出し):
// 発議の保存、裁定カード / 裁定依頼の配送と配り直し、bot の裁定の適用、適用の基点の解決。
// 判断は src/proposals.js / src/adjudication.js が持ち、ここは ProposalStore と Discord を結ぶ。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyBotAdjudication,
  buildProcessNotice,
  buildProposalCard,
  cardTargets,
} from '../adjudication.js';
import { baseCommitArgs } from '../apply.js';
import {
  POLICY_FILE,
  channelConfigForName,
  resolveApplyChannel,
  resolveAutonomy,
} from '../config.js';
import { formatSchemaTag } from '../contract.js';
import { summarizeForInbox } from '../inbox.js';
import { adjudicationRequestMessage, adjudicationThreadName, sendSafe } from '../mentions.js';
import { createRepoContext, deliberationCount, digestOf } from '../proposals.js';
import { formatInitiativeTag, shouldDeliverProposal } from '../scheduler.js';
import { sanitizeForDisplay } from '../toolrules.js';
import { runGit } from '../worktree.js';

/** 配れなかったときの再試行間隔 (相手が落ちている・投稿に失敗した) */
export const PROPOSAL_REDELIVER_MS = 10 * 60 * 1000;
/**
 * **配れた後の再試行までの猶予** (sol 指摘 2026-08-30)。
 * 投稿できたことは「裁定された」ではない — 起こした job が rate limit や中断や
 * 様式不履行で終わると、提案は `deliberating` のまま誰も触らなくなる。
 * 裁定待ちが続いているなら、この時間を過ぎたらもう一度起こす。
 */
export const PROPOSAL_ADJUDICATION_TIMEOUT_MS = 30 * 60 * 1000;
/** 配り直しの上限。これを超えたら人間の出番 (§6 の「要人間」) */
export const MAX_PROPOSAL_DELIVERY_ATTEMPTS = 6;

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.root                  policy の置き場 (提案の前提は毎回読み直す)
 * @param {object|null} deps.proposals        ProposalStore (発議機構が無効なら null)
 * @param {object|null} deps.board
 * @param {Map<string, object>} deps.bots
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {import('../store.js').PauseStore} deps.pauseStore
 * @param {object} deps.lifecycle
 * @param {import('../inbox.js').InboxStore} deps.inbox
 * @param {Array<{userId: string, displayName: string}>} deps.ownerTargets
 * @param {string[]} deps.execBotKeys         work / process を裁定できる bot
 * @param {(client: object, name: string) => object|null} deps.findGuildChannel
 * @param {(now: number) => Promise<void>} deps.sweepOrgApply 採択された org / process を当てる (src/bridge/orgapply.js)
 */
export function createProposalWiring({
  config, root: ROOT, proposals, board, bots, hops, pauseStore, lifecycle, inbox,
  ownerTargets: OWNER_TARGETS, execBotKeys: EXEC_BOT_KEYS, findGuildChannel, sweepOrgApply,
}) {
  /**
   * ゲートが見る外部状態。**毎回読み直す** — policy も対象ファイルも job の途中で動くので、
   * 起動時の値を握ったままだと「裁定の前提が変わった」を検出できない。
   */
  function proposalContext() {
    const policy = JSON.parse(readFileSync(resolve(ROOT, POLICY_FILE), 'utf8'));
    return createRepoContext({ cwd: ROOT, policy, board });
  }

  /** 読めなければ null (呼び出し側は「裁定できません」で止める) */
  function safeProposalContext() {
    try {
      return proposalContext();
    } catch (err) {
      console.error(`[proposals] 前提を読めませんでした: ${err.message}`);
      return null;
    }
  }

  /**
   * 適用の基点。**裁定の瞬間に固める** (§3.9) — 承認された diff は、この commit から
   * 生やしたきれいな枝にだけ当たる。
   *
   * ブランチ名ではなく **commit OID を記録する**。ref は裁定と適用の間に動くので、
   * 名前で覚えると「承認したときの木」とは別の木へ当ててしまう。
   *
   * 読めなければ `null` を返す。**その場合 `org | process` は採択できない**
   * (`ProposalStore.adjudicate` が断る) — 基点の無い採択は誰も当てられないまま滞留するので、
   * 入口で止める。却下と `work` は基点を要らないので、ここが null でも今までどおり通る。
   */
  async function resolveApplyBaseCommit() {
    const channel = resolveApplyChannel(config);
    // 適用回路が設定されていない配備では基点も無い (採択は残るが適用は起きない)
    if (!channel) return null;
    const base = resolveAutonomy(channelConfigForName(config, channel)).baseBranch;
    const args = baseCommitArgs(base);
    if (!args) {
      console.error(`[proposals] 適用の基点にできないブランチ名です: ${JSON.stringify(base)}`);
      return null;
    }
    try {
      const out = await runGit(ROOT, args);
      const oid = String(out).trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(oid)) return oid;
      console.error(`[proposals] 適用の基点を commit OID として読めませんでした: ${JSON.stringify(oid)}`);
      return null;
    } catch (err) {
      console.error(`[proposals] 適用の基点 (${base}) を読めませんでした: ${err.message}`);
      return null;
    }
  }

  /**
   * 提案スレッド (無ければ発議元チャンネル → applyChannel) へ 1 行投稿する。
   *
   * **スレッドは作らない** — これは裁定の依頼ではなく結果の通知なので、job を
   * 起こす必要が無い。archive されたスレッドは次の候補へ落とす。
   *
   * 「要人間」で出したものは受信箱にも残す (§10) — 人間がスレッドで返せば閉じる。
   */
  async function postToProposal(proposal, text, { mentionOwner = false, cc = null } = {}) {
    const bot = [...bots.values()].find((b) => b.userId);
    if (!bot) return null;
    const fallbackChannelId = cc ? findGuildChannel(bot.client, cc.channelName)?.id ?? null : null;
    const ownerId = mentionOwner ? OWNER_TARGETS[0]?.userId ?? null : null;
    const body = ownerId ? `${text}\n<@${ownerId}>` : text;
    for (const id of cardTargets(proposal, { fallbackChannelId })) {
      try {
        const found = await bot.client.channels.fetch(id);
        if (!found || (found.isThread?.() && found.archived)) continue;
        const sent = await sendSafe(found, body, ownerId ? { mentionUserIds: [ownerId] } : {});
        if (ownerId && found.isThread?.()) {
          try {
            const entry = inbox.open({
              channel: cc?.channelName ?? null,
              threadId: found.id,
              summary: summarizeForInbox(text),
              messageId: sent?.id ?? null,
            });
            console.log(`[inbox] 適用の要人間 #${entry.id} を記録: thread:${found.id}`);
          } catch (err) {
            console.error(`[inbox] 記録に失敗 (/inbox に出ません): ${err.message}`);
          }
        }
        return found.id;
      } catch (err) {
        console.error(`[org-apply] #${proposal.id} の通知を ${id} へ出せませんでした: ${err.message}`);
      }
    }
    return null;
  }

  /**
   * org 提案の稟議カードを発議元へ出す (§3.9 — 通知の主体はブリッジで、bot ではない)。
   *
   * **archive されたスレッドには出さず親チャンネルへ落とす** — 投稿できずに
   * 「裁定待ちのまま誰も気付かない」提案を作らないため。
   *
   * **呼ぶのは「提案が裁定待ちへ入った瞬間」** で、その経路 (report の initiative /
   * イベント / scheduler の巡回) は次段で配線する。それまで手動の入口は `/proposals`。
   */
  async function announceProposal(proposal, { fallbackChannelId = null } = {}) {
    if (!proposals || proposal?.class !== 'org') return null;
    const bot = [...bots.values()][0];
    const ctx = safeProposalContext();
    if (!bot || !ctx) return null;
    let digest;
    try {
      digest = digestOf(proposal, ctx);
    } catch (err) {
      console.error(`[proposals] #${proposal.id} の digest を作れませんでした: ${err.message}`);
      return null;
    }
    const ownerId = OWNER_TARGETS[0]?.userId ?? null;
    const card = buildProposalCard(proposal, {
      digest,
      stage: 'request',
      ownerMention: ownerId ? `<@${ownerId}>` : null,
      escape: sanitizeForDisplay,
    });
    for (const id of cardTargets(proposal, { fallbackChannelId })) {
      try {
        const channel = await bot.client.channels.fetch(id);
        if (!channel) continue;
        if (channel.isThread?.() && channel.archived) continue; // 親チャンネルへ落とす
        return await sendSafe(channel, card, { mentionUserIds: ownerId ? [ownerId] : [] });
      } catch (err) {
        console.error(`[proposals] #${proposal.id} のカードを ${id} へ出せませんでした: ${err.message}`);
      }
    }
    console.error(`[proposals] #${proposal.id} の裁定カードをどこにも出せませんでした`);
    return null;
  }

  /**
   * bot の構造化裁定を提案へ適用する (§3.9)。
   *
   * **通せるのは work / process だけ** — org を書いてきても `canAdjudicate` が bot を
   * 弾くので、ここに class の分岐は置かない (ゲートを 2 か所に持たない)。
   * process の裁定は作者へ**事後通知**する (承認を求めるのではなく、決まったことを伝える)。
   *
   * @returns {string} スレッドへ出す 1 行
   */
  async function applyProposalAdjudication({ contract, bot, thread }) {
    if (!proposals) return '⚠️ 裁定を受け取りましたが、発議機構が無効です (initiative.enabled)';
    const applied = applyBotAdjudication(contract, {
      botKey: bot.key,
      store: proposals,
      ctx: safeProposalContext(),
      ownerUserId: config.ownerUserId ?? null,
      execBotKeys: EXEC_BOT_KEYS,
      baseCommit: await resolveApplyBaseCommit(),
    });
    const ownerId = OWNER_TARGETS[0]?.userId ?? null;
    if (applied.ok && applied.notifyOwner && ownerId && thread) {
      try {
        await sendSafe(
          thread,
          `${buildProcessNotice(applied.proposal, { escape: sanitizeForDisplay })}\n<@${ownerId}>`,
          { mentionUserIds: [ownerId] },
        );
      } catch (err) {
        console.error(`[proposals] process 裁定の通知に失敗: ${err.message}`);
      }
    }
    return applied.note;
  }

  /**
   * report の任意 `initiative` を提案として保存する (§3.9 の発議 3 経路のうち (1))。
   *
   * **保存できるかを決めるのは checkProposal** (src/proposals.js) で、ここは配線だけ。
   * `raisedBy` / `class` / `subjectKeys` / `origin` はブリッジが付ける — bot に
   * 自己申告させない。落ちた理由はスレッドへ返す (黙って消すと、発議したつもりの
   * bot が「通った」と思ったまま次へ行く)。
   *
   * 保存できたら **その場で `deliberating` へ送る。** 意見が付くのを待って
   * `raised` のまま置くと、誰も意見を書かなかった提案が永久に裁定できない
   * (`adjudicate` は `deliberating` からしか通らない)。意見は `deliberating` の間も
   * 足せるので、先に裁定待ちにしても議論の余地は狭まらない。
   *
   * @returns {Promise<string>} スレッドへ出す 1 行
   */
  async function raiseProposal({ contract, bot, thread }) {
    if (!proposals) return '⚠️ 発議を受け取りましたが、発議機構が無効です (initiative.enabled)';
    const ctx = safeProposalContext();
    if (!ctx) return '⚠️ 発議の前提 (policy) を読めませんでした — 保存していません';

    const isThread = Boolean(thread?.isThread?.());
    let proposal;
    try {
      proposal = proposals.raise(contract.initiative, {
        raisedBy: bot.key,
        ctx,
        // 稟議カードの投稿先は**発議の時点で**記録する (後から推測しない)
        origin: {
          channelId: (isThread ? thread.parentId : thread?.id) ?? null,
          threadId: isThread ? thread.id : null,
        },
      });
    } catch (err) {
      return `⚠️ 発議を保存できませんでした: ${sanitizeForDisplay(err.message, 400)}`;
    }

    const head = `🏛 提案 #${proposal.id} (${proposal.class}) を起こしました: `
      + sanitizeForDisplay(String(proposal.input?.summary ?? ''), 200);

    // **裁定待ちにできなければそこで止める** (sol 指摘 2026-08-30)。`raised` のまま
    // 裁定 bot を起こしても `adjudicate` は必ず落ちるので、起こすだけ無駄になる。
    // 送り直しは sweepProposals が拾う (次の tick で `deliberating` へ上げて配る)
    try {
      proposal = proposals.deliberate(proposal.id, { by: bot.key, note: '発議 (report)' });
    } catch (err) {
      console.error(`[proposals] #${proposal.id} を裁定待ちにできませんでした: ${err.message}`);
      return `${head}\n⚠️ 裁定待ちにできませんでした (${sanitizeForDisplay(err.message, 200)}) `
        + '— 次の tick で送り直します';
    }

    const out = await deliverProposal(proposal, {
      fallbackChannelId: (isThread ? thread.parentId : thread?.id) ?? null,
    });
    // 試していないもの (pause 中) は回数に数えない — 再開後に sweep が 1 回目を配る
    if (out.attempted) noteDelivery(proposal, out, Date.now());
    if (!out.delivered) {
      return `${head}\n⚠️ 裁定を頼む相手へ届けていません`
        + `${out.reason ? ` (${out.reason})` : ''} — 次の tick で配り直します `
        + `(\`/proposals ${proposal.id}\` でも出し直せます)`;
    }
    return proposal.class === 'org'
      ? `${head}\n→ 作者へ裁定カードを出しました`
      : `${head}\n→ ${EXEC_BOT_KEYS.map((k) => bots.get(k)?.cfg.displayName ?? k).join(' / ')} に裁定をお願いしました`;
  }

  /**
   * `work` / `process` 提案の裁定を経営裁量の bot (`initiative.execBotKeys`) へ頼む。
   *
   * **走っている job に依存しない** (sol 指摘 2026-08-30)。投稿先も投げ手も
   * `proposal.origin` と起動中の bot から自分で解決するので、発議した job の中からも、
   * 後から掃除する sweep からも、`/proposals` からも同じ経路で配れる。
   * これが無いと「pause 中に配れなかった提案」を誰も配り直せない。
   *
   * 委譲契約は保存しない — 裁定は report の任意フィールドで返るので、
   * 種別の上書きと制御メンションだけで足りる。
   *
   * job 予算は**もともと予算で回っているスレッドにだけ**積む。人間が回している
   * スレッドへ新しく予算を付けると、そこから先の bot 起点の起動が 1 本に絞られる
   * (予算を配っていないスレッドは門番ごと不在 = 従来どおり、が現行の約束)。
   *
   * @returns {Promise<string|null>} 依頼を出したチャンネル (スレッド) の ID。配れなければ null —
   *   **false を返さない**: 呼び出し側 (deliverProposal) は `!== null` で「配れた」を判定するので、
   *   false を返すと「裁定 bot が居ない」が「配れた」と数えられ、30 分の猶予で放置される
   *   (分割時のテストで見つけた取り違え 2026-09-06)
   */
  async function deliverAdjudication(proposal, { fallbackChannelId = null, preferChannelId = null } = {}) {
    const available = [...bots.values()].filter((b) => b.userId).map((b) => b.key);
    const execKey = EXEC_BOT_KEYS.find((key) => available.includes(key)) ?? null;
    const exec = execKey ? bots.get(execKey) : null;
    if (!exec?.userId) {
      console.error(
        `[proposals] #${proposal.id}: 裁定できる bot が起動していません `
        + `(execBotKeys: ${EXEC_BOT_KEYS.join(' / ') || '未設定'})`,
      );
      return null;
    }
    // 宛先自身の client から投げると多行の自分の発言として捨てられる (src/trigger.js)
    const announcer = available.find((key) => key !== execKey);
    if (!announcer) {
      console.error(`[proposals] #${proposal.id}: ${execKey} 以外に投げ手が居ません`);
      return null;
    }
    const client = bots.get(announcer)?.client;

    // 前に配れた場所を先に試す — 発議元が archive されていると毎回そこへ落ちるので、
    // 覚えていないと再試行のたびに `proposal/<id>` スレッドが増える
    const candidates = [...new Set([
      ...(preferChannelId ? [preferChannelId] : []),
      ...cardTargets(proposal, { fallbackChannelId }),
    ])];
    for (const id of candidates) {
      try {
        const found = await client.channels.fetch(id);
        if (!found) continue;
        // **bot 起点の投稿はスレッドの中だけが job になる** (src/index.js の
        // 「bot 起点はスレッド内のみ想定」— sol 指摘 2026-08-30)。archive された
        // スレッドを避けて親チャンネルへ落とすなら、**そこに専用スレッドを立てて**
        // その中へ入れる。チャンネルへ直接投げると、投稿は通るのに裁定 job が立たない
        const channel = found.isThread?.()
          ? (found.archived ? null : found)
          : await found.threads?.create({ name: adjudicationThreadName(proposal) });
        if (!channel) continue;

        // **予算は試行ごとに積み、投稿に失敗したときだけ戻す** (sol 指摘 2026-08-30)。
        // 世代ごとに 1 枠だと、初回の枠を裁定 job が使い切った後の配り直しで
        // 予算 0 のまま起動を拒否され、それでも「配れた」と数えて止まってしまう
        const granted = hops.taskBudget(channel.id) !== null;
        if (granted) hops.grantTaskBudget(channel.id, 1);
        try {
          // **様式は投稿そのものに載せる**。`threadId:botKey` の 1 枠だと、
          // 投稿先と job のスレッドが違ったときに上書きが外れ、
          // 同じ場所へ 2 件並べると先の job が枠を食う
          await sendSafe(
            channel,
            adjudicationRequestMessage({
              botUserId: exec.userId,
              proposal,
              schemaTag: formatSchemaTag('report'),
              initiativeTag: formatInitiativeTag('裁定'),
            }),
            { mentionUserIds: [exec.userId] },
          );
        } catch (err) {
          if (granted) hops.releaseTaskBudget(channel.id, 1);
          throw err;
        }
        console.log(
          `[proposals] #${proposal.id} (${proposal.class}) の裁定を ${execKey} へ依頼 `
          + `(${channel.id} / 投稿は ${announcer})`,
        );
        return channel.id;
      } catch (err) {
        console.error(`[proposals] #${proposal.id} の裁定依頼を ${id} へ出せませんでした: ${err.message}`);
      }
    }
    return null;
  }

  /**
   * 提案を裁定できる相手へ配る。**class で経路が違うだけで、呼び口は 1 つ**。
   * - `org` … 作者へ裁定カード (押せるボタン)
   * - `work` / `process` … 経営裁量の bot を report 様式で起こす
   *
   * **自動の配送は kill switch を通す** (sol 指摘 2026-08-30)。in-flight の job が
   * pause 中に完走して発議することは通常運用で起きるので、そこから裁定 bot が
   * 立ち上がると「止めたのに動く」になる。止まっている間は未配送のまま置き、
   * 再開後に sweep が配る。**手動 (`/proposals`) だけが例外** — 人間が今出せと言っている。
   *
   * @returns {Promise<{delivered: boolean, attempted: boolean, channelId?: string, reason?: string}>}
   *   `attempted:false` は「試してすらいない」= 配送の回数に数えない。
   *   `channelId` は次の配り直しで最初に試す場所 (毎回スレッドを作り直さないため)
   */
  async function deliverProposal(proposal, {
    fallbackChannelId = null, preferChannelId = null, manual = false,
  } = {}) {
    if (!manual && (pauseStore.paused || !lifecycle.accepting)) {
      return { delivered: false, attempted: false, reason: '自律運転が停止中 (/resume で配ります)' };
    }
    if (proposal.class === 'org') {
      return { delivered: Boolean(await announceProposal(proposal, { fallbackChannelId })), attempted: true };
    }
    const channelId = await deliverAdjudication(proposal, { fallbackChannelId, preferChannelId });
    return { delivered: channelId !== null, attempted: true, channelId };
  }

  /**
   * 配れていない提案を配り直す (§3.9 の生存性 — sol 指摘 2026-08-30)。
   *
   * 配れない状況は通常運用で起きる: pause 中に完了した in-flight job の発議、
   * 裁定 bot が落ちている、投稿に失敗した、`deliberate()` が書けなかった。
   * どれも黙って `deliberating` (あるいは `raised`) のまま残るので、**tick ごとに
   * 掃除する**。`/proposals` は人間が気付いたときの入口で、気付かないときの受け皿はここ。
   *
   * 台帳は in-memory。再起動すると「未配送」に戻って 1 回配り直すが、それは
   * 望ましい側 — 落ちて上がり直したなら、配れなかったものをもう一度試すのが正しい。
   */
  const proposalDelivery = new Map(); // key → {delivered: boolean, attempts: number, lastAt: number}

  /**
   * 配送記録のキー。**`deliberating` へ入った回数を世代として持つ** —
   * 再審議 (裁定 → drift で `deliberating` へ差し戻し) は別の依頼なので、
   * 前の世代で配り終えたことを理由にスキップしてはいけない。
   */
  function deliveryKey(proposal) {
    return `${proposal.id}#${deliberationCount(proposal)}`;
  }

  function deliveryRecord(key) {
    return proposalDelivery.get(key) ?? { delivered: false, attempts: 0, lastAt: 0, channelId: null };
  }

  function noteDelivery(proposal, out, now) {
    const key = deliveryKey(proposal);
    const prev = deliveryRecord(key);
    proposalDelivery.set(key, {
      delivered: out.delivered,
      attempts: prev.attempts + 1,
      lastAt: now,
      // 配れた場所は覚えておく (発議元が archive されていると毎回そこへ落ちるので、
      // 覚えないと再試行のたびに退避スレッドが増える)
      channelId: out.channelId ?? prev.channelId ?? null,
    });
  }

  async function sweepProposals(now = Date.now()) {
    if (!proposals || pauseStore.paused || !lifecycle.accepting) return;

    // (1) `raised` のまま取り残された提案を裁定待ちへ送り直す。
    //     raise は通ったのに deliberate が書けなかったもの — 放っておくと
    //     `adjudicate` が通らない状態で永久に残る
    for (const proposal of proposals.list({ state: 'raised' })) {
      try {
        proposals.deliberate(proposal.id, { by: 'bridge', note: '裁定待ちへ送り直し' });
        console.log(`[proposals] #${proposal.id} を裁定待ちへ送り直しました`);
      } catch (err) {
        console.error(`[proposals] #${proposal.id} を裁定待ちにできません: ${err.message}`);
      }
    }

    // (2) 裁定待ちを配る。**配れた後も、裁定が返らないまま猶予を過ぎたら起こし直す** —
    //     投稿できたことは裁定されたことではない
    const live = new Set();
    for (const proposal of proposals.awaitingAdjudication()) {
      const key = deliveryKey(proposal);
      live.add(key);
      const record = deliveryRecord(key);
      const plan = shouldDeliverProposal(record, {
        now,
        redeliverMs: PROPOSAL_REDELIVER_MS,
        timeoutMs: PROPOSAL_ADJUDICATION_TIMEOUT_MS,
        maxAttempts: MAX_PROPOSAL_DELIVERY_ATTEMPTS,
      });
      if (!plan.deliver) continue;

      const out = await deliverProposal(proposal, { preferChannelId: record.channelId });
      if (!out.attempted) continue; // 試してすらいないので回数に数えない
      noteDelivery(proposal, out, now);
      if (deliveryRecord(key).attempts >= MAX_PROPOSAL_DELIVERY_ATTEMPTS) {
        console.error(
          `[proposals] #${proposal.id} (${proposal.class}) は ${MAX_PROPOSAL_DELIVERY_ATTEMPTS} 回起こしても`
          + ' 裁定が返りません — 裁定待ちのまま止まります (`/proposals` で出し直してください)',
        );
      }
    }
    // 裁定待ちを抜けた提案の記録は捨てる (open な提案の数だけを持つ)
    for (const key of proposalDelivery.keys()) {
      if (!live.has(key)) proposalDelivery.delete(key);
    }

    // (3) 採択された org / process を当てる (§3.9 org-apply)。**適用回路の起動点はここだけ**
    await sweepOrgApply(now);
  }

  /** `/proposals <id>` からの手動の配り直し (人間が気付いたときの入口) */
  async function redeliverProposal(id) {
    if (!proposals) return { ok: false, reason: '発議機構が無効です' };
    const proposal = proposals.get(id);
    if (!proposal) return { ok: false, reason: `提案 #${id} は見つかりません` };
    if (proposal.state !== 'deliberating') {
      return { ok: false, reason: `提案 #${id} は ${proposal.state} なので配り直せません (裁定待ちだけが対象)` };
    }
    // 手動は kill switch の例外 (人間が「今出せ」と言っている)
    const out = await deliverProposal(proposal, {
      manual: true,
      preferChannelId: deliveryRecord(deliveryKey(proposal)).channelId,
    });
    noteDelivery(proposal, out, Date.now());
    return out.delivered
      ? { ok: true, reason: `提案 #${id} (${proposal.class}) の裁定依頼を出し直しました` }
      : { ok: false, reason: `提案 #${id} の裁定依頼を出せませんでした (ログを確認してください)` };
  }

  return {
    proposalContext,
    safeProposalContext,
    resolveApplyBaseCommit,
    postToProposal,
    announceProposal,
    applyProposalAdjudication,
    raiseProposal,
    deliverProposal,
    sweepProposals,
    redeliverProposal,
  };
}
