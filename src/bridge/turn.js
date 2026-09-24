// 1 ターンの成果物を Discord へ届ける配線 (src/index.js から切り出し)。
// 投稿順と完了境界 (postTurn)、添付 (sendAttachments)、停止通知の受信箱への記録。
// 順序の判断は src/delivery.js (deliverTurn) が持つ。
import { AttachmentBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { DISCORD_MAX_FILES_PER_MESSAGE, selectOutgoingFiles } from '../attachments.js';
import {
  bindContract,
  canDelegateTo,
  contractSaveLabel,
  formatContractTag,
  isTouchRestricted,
  touchSetOf,
} from '../contract.js';
import { deliverTurn } from '../delivery.js';
import { diffSnapshots, gitStatusSnapshot } from '../gitstatus.js';
import { summarizeForInbox } from '../inbox.js';
import {
  editSafe,
  resolveOutgoingText,
  sendBody,
  sendControlMention,
  sendSafe,
} from '../mentions.js';
import { applyRoster } from '../roster.js';
import { formatTraceLine, postTraceQuietly } from '../trace.js';
import { formatVerifyResult } from '../verify.js';

/**
 * @param {object} deps
 * @param {object} deps.config                 合成済み config (bots のランタイム判定に使う)
 * @param {import('../inbox.js').InboxStore} deps.inbox
 * @param {import('../store.js').ContractStore} deps.contracts
 * @param {Array<{userId: string, displayName: string}>} deps.ownerTargets [[notify:owner]] の宛先
 * @param {{attachments: object}} deps.limits
 * @param {(userId: string|null|undefined) => string|null} deps.botKeyOf
 * @param {() => Array<{key: string, displayName: string, userId: string|null}>} deps.botEntries
 * @param {(cc: object) => string} deps.contractCwd 契約を束縛する cwd (リポジトリ本体)
 * @param {(p: object) => Promise<boolean>} deps.noteTaskCompletion worker の完了報告でタスクをレビューへ進める
 * @param {(thread: object, bot: object, cc: object, denials: object[], askLedger: object|null) => Promise<void>} deps.postApprovalRequests
 */
export function createTurnWiring({
  config, inbox, contracts, ownerTargets: OWNER_TARGETS, limits,
  botKeyOf, botEntries, contractCwd, noteTaskCompletion, postApprovalRequests,
}) {
  const ATTACHMENT_LIMITS = limits.attachments;

  /**
   * 停止通知を台帳へ記録する。**実メンションを送れたときだけ呼ぶ。**
   *
   * 届いていない通知を「待ち」に数えると、作者は誰も呼んでいない行を追うことになる
   * (`src/delivery.js` の「配信失敗は人間へ見せて止まる」と同じ側へ倒す)。
   *
   * 記録に失敗しても job は落とさない — 通知そのものは既に飛んでいるので、
   * ここで throw すると「呼べているのに配信失敗」と報告することになる。
   */
  function noteOwnerCall({ thread, bot, cc, body, sent }) {
    try {
      const entry = inbox.open({
        channel: cc.channelName,
        threadId: thread.id,
        botKey: bot.key,
        summary: summarizeForInbox(body),
        messageId: sent?.id ?? null,
      });
      console.log(`[inbox] 停止通知 #${entry.id} を記録: thread:${thread.id} (${bot.key})`);
    } catch (err) {
      console.error(`[inbox] 記録に失敗 (/inbox に出ません): ${err.message}`);
    }
  }

  /** 人間がスレッドで発言したので閉じる (hops.reset と同じ条件) */
  function closeInboxForThread(threadId) {
    try {
      for (const entry of inbox.closeByThread(threadId)) {
        console.log(`[inbox] 停止通知 #${entry.id} を閉じました (人間の発言)`);
      }
    } catch (err) {
      console.error(`[inbox] 記録を閉じられませんでした: ${err.message}`);
    }
  }

  /**
   * このターンの成果物を Discord へ届ける。**投稿順と完了境界がここの主題。**
   *
   * 順序は固定:
   *   本文 → 添付 → git 差分 → ツール軌跡 → verify → 権限通知 → メンション警告 → 制御メンション専用 1 通
   *
   * 最後の 1 通だけが次の agent を起動する。途中で 1 つでも送信に失敗したら
   * (thread の archive・削除・権限喪失を含む) **handoff しない** — 不完全な文脈で
   * 次を走らせるより、ここで止めて人間に見せる方がよい。claude セッションは
   * 副作用済みとして保持したまま「配信失敗」として終える (巻き戻さない)。
   */
  async function postTurn(
    thread, bot, cc, res, gitBefore, placeholder, effectiveRoster = null,
    {
      verifyResult = null, traceSummary = null, askLedger = null,
      outgoingText = null, contractOut = null, contractNotes = [], run = null,
      issuerBotKey = null, societyAction = null,
    } = {},
  ) {
    // マーカー行は本文から取り除いてから送る (Discord にマーカーを晒さない)。
    // 構造化した job では投稿するのは `本文` フィールド — **制御フッターもその中にある**ので、
    // 抽出も無害化も従来と同じ経路をそのまま通る
    const outgoing = resolveOutgoingText(
      outgoingText || res.result || '(空応答)',
      outgoingContext(bot, effectiveRoster),
    );
    // 配送の進みを実行記録へ (本文・添付・制御メンションのどこまで届いたか)。
    // **送信の完了を確認できたときだけ sent** — 送ったが応答を受け取れなかった (throw) は
    // failed ではなく unknown で、自動再送の対象にしない (P4)
    const recorded = (label, send) => async () => {
      run?.delivery?.(label, 'pending');
      try {
        const value = await send();
        run?.delivery?.(label, 'sent');
        return value;
      } catch (err) {
        run?.delivery?.(label, /timeout|ECONNRESET|socket hang up|ETIMEDOUT/i.test(String(err?.message ?? '')) ? 'unknown' : 'failed');
        throw err;
      }
    };
    const steps = [
      // 本文が届いていないなら、注記を足しても意味がないので以降を続けない
      { label: '本文', required: true, run: recorded('本文', () => sendBody(thread, outgoing)) },
    ];

    if (outgoing.attachMarkers.length > 0) {
      steps.push({ label: '添付', run: recorded('添付', () => sendAttachments(thread, outgoing.attachMarkers, cc.cwd)) });
    }

    // 実行前後の機械的 git 差分 (検収用 — ワーカーの自己申告に依存しない)
    const delta = diffSnapshots(gitBefore, gitStatusSnapshot(cc.cwd));
    if (delta.length > 0) {
      steps.push({
        label: 'git 差分',
        run: () => sendSafe(
          thread,
          `📋 実行前後の git status 差分:\n\`\`\`\n${delta.join('\n').slice(0, 1800)}\n\`\`\``,
        ),
      });
    }

    // ツール軌跡は「実際に実行したのは何か」の証拠 (拒否された呼び出しは載らない — そちらは
    // 下の権限通知が扱う)、verify は「結果が正しいか」の判定なので この順に置く。
    // **投稿の失敗をここで握る**のは、軌跡が補助情報だから — 握らないと failures に入り、
    // 送信の失敗だけで handoff が止まる (src/delivery.js:33-51)。
    const traceLine = formatTraceLine(traceSummary);
    if (traceLine) {
      steps.push({
        label: 'ツール軌跡',
        run: () => postTraceQuietly(
          (text) => sendSafe(thread, text),
          traceLine,
          (err) => console.error(`[${bot.key} thread:${thread.id}] ツール軌跡の投稿に失敗: ${err?.message ?? err}`),
        ),
      });
    }

    if (verifyResult) {
      steps.push({
        label: 'verify 結果',
        run: () => sendSafe(thread, formatVerifyResult(verifyResult)),
      });
    }

    if (res.permissionDenials?.length) {
      steps.push({
        label: '権限通知',
        run: () => postApprovalRequests(thread, bot, cc, res.permissionDenials, askLedger),
      });
    }

    // 様式不履行は黙って落とさない (契約として扱っていないことが分かる唯一の手がかり)
    if (contractNotes.length > 0) {
      steps.push({
        label: '契約の警告',
        run: () => sendSafe(thread, contractNotes.join('\n').slice(0, 1900)),
      });
    }

    // 呼べなかった委譲・無効化した表記は黙って落とさない (人間が気付ける唯一の手がかり)
    if (outgoing.warnings.length > 0) {
      steps.push({
        label: 'メンション警告',
        run: () => sendSafe(
          thread,
          `⚠️ メンション制御の警告:\n${outgoing.warnings.join('\n')}`.slice(0, 1900),
        ),
      });
    }

    // verify NG は結果まで配送したうえで**元の handoff を落とす**。配送失敗に偽装しないため、
    // 成功した verify step を throw させず、完了境界へ渡す mention を差し替える。
    //
    // **落としたままにはしない**。壊れたまま次へ回さないのが門の目的だが、
    // 「誰が受けるか」が無いと人間が次の担当を呼ぶまで仕事が止まる (作者指摘 2026-09-07、2 回)。
    // 代わりに**この job を頼んだ投げ手**へ戻す — 投げ手は touch 集合を広げるか、
    // 直させるか、受け入れるかを決められる唯一の相手 (居なければ owner を呼ぶ)。
    const verifyFailed = Boolean(verifyResult && !verifyResult.ok);
    // **元の宛先が人間への質問 (`[[notify:owner]]`) なら差し替えない** — verify NG は「人間に聞く」を
    // 無効にしない。戻しに化けると質問が投げ手への handoff になり、受信箱にも残らない
    // (Opus2 レビュー 2026-09-07 Major1)。owner 宛は bot キーが無いので契約も元から保存されない
    const keepNotify = verifyFailed && outgoing.mention?.kind === 'notify';
    // **案件付きの job に「投げ手」は居ない。** 起動を投げたのは配送係 (`pickAnnouncer` が
    // 機械的に選んだ bot) で、その bot はこの案件を知らないし、戻しても案件付きでない
    // 普通の job になるので台帳は動かない。「投げ手が居なければ owner」を
    // そのまま当てるのが正しい (Opus2 S2-3a 再レビュー)
    const sendBack = verifyFailed && !keepNotify
      ? sendBackTarget({
        bot,
        issuerBotKey: societyAction ? null : issuerBotKey,
        original: outgoing.mention,
        effectiveRoster,
        societyAction,
      })
      : null;
    let handoffMention = !verifyFailed || keepNotify ? outgoing.mention : sendBack?.mention ?? null;

    // **案件に結ばれた job の起動は台帳が決める**。
    // 自由文の `[[handoff:...]]` を通すと、台帳を経ない Action が生まれ、予算も世代も
    // 照合も効かないまま次の job が走る (「bot の自由文を権限の根拠にしない」)。
    //
    // 落とさないのは `[[notify:owner]]` だけ — 人間への質問は案件の外にある。
    // verify 最終 NG の戻しも上で owner の notify へ倒してあるので、ここは通る
    if (societyAction && handoffMention && handoffMention.kind !== 'notify') {
      handoffMention = null;
      // 黙って落とさない — 落としたことが分かる唯一の手がかり (メンション警告と同じ流儀)
      steps.push({
        label: '案件の handoff 警告',
        run: () => sendSafe(
          thread,
          `⚠️ 案件 ${societyAction.caseId} に結ばれた job なので、本文の handoff は実行していません`
          + ' — 次の起動は `next.plan` に書いてください (台帳を通らない起動は作りません)',
        ),
      });
    }

    // 委譲契約の保存は**最後の step** = handoff の直前に置く。
    // 保存できなければ handoff を止める (契約なしで相手が走ると touch 制限が効かず、
    // 「絞ったつもりの job が絞られていない」という最悪の食い違いになる)。
    // 宛先が決まっていない委譲は保存しない — 契約は「呼んだ相手」に束縛して初めて意味を持つ
    const targetBotKey = handoffMention ? botKeyOf(handoffMention.userId) : null;
    let savedFor = null;
    // **投稿より前に決める。** 契約と制御メッセージの両方へ同じ nonce を載せることで、
    // 受け手の MessageCreate が保存の書き戻しより先に届いても取りこぼさない
    const contractNonce = randomUUID().replaceAll('-', '').slice(0, 16);
    // **委譲も報告も持ち回る。** 報告を捨てると検収側がフィールド照合できず、
    // 「検収がフィールド照合になる」という目的が満たせない (sol 指摘 2026-08-03)
    // **verify NG のときは契約を保存しない。** 戻す先は「頼んだ相手」であって
    // 「この報告が委譲した相手」ではないので、元の委譲をそのまま生かすと
    // 投げ手が身に覚えのない touch 制限を背負って起動する
    if (contractOut && targetBotKey && !verifyFailed) {
      steps.push({
        label: contractSaveLabel(contractOut.kind),
        run: async () => {
          // **保存する前に**受け手のランタイムで強制できるかを見る。
          // codex は権限をパス単位に絞れないので、touch 制限つきの委譲は渡せない —
          // 渡すと「絞ったつもりで作業ツリー全体を書ける」になる (sol 指摘 2026-08-03)
          const allowed = canDelegateTo(
            contractOut.kind, contractOut.contract, config.bots?.[targetBotKey]?.runtime,
          );
          if (!allowed.ok) throw new Error(allowed.reason);
          const entry = bindContract({
            id: randomUUID(),
            nonce: contractNonce,
            kind: contractOut.kind,
            contract: contractOut.contract,
            threadId: thread.id,
            fromBotKey: bot.key,
            toBotKey: targetBotKey,
            cwd: contractCwd(cc),
            channelName: cc.channelName,
            at: new Date().toISOString(),
          });
          if (!entry) throw new Error('契約を束縛できませんでした');
          // handoff 1 回につき 1 件を積む (上書きしない — job はキューで待つので、
          // 保存と消費は 1 対 1 に並ばない)。上限に達していたら**ここで throw して
          // handoff を止める** — 古い方を捨てると、既に配送済みの handoff と契約の
          // 対応がずれ続ける
          contracts.push(thread.id, targetBotKey, entry);
          savedFor = { botKey: targetBotKey, id: entry.id, nonce: entry.nonce };
          console.log(
            `[contract] 保存 (${entry.kind}): thread:${thread.id} ${bot.key} → ${targetBotKey}`
            + (entry.kind === 'delegation'
              ? ` (touch ${touchSetOf(contractOut.contract).length} 件`
                + `${isTouchRestricted(contractOut.contract) ? '' : ' / 制限なし'})`
              : ''),
          );
        },
      });
    }

    const result = await deliverTurn({
      steps,
      mention: handoffMention,
      // 契約を保存できたときだけ、同じ nonce のタグを制御メッセージへ載せる。
      // **受け手はタグの有無で「契約つきの handoff か」を判定できる** ので、
      // 契約を失った handoff を「契約なしの handoff」と取り違えない
      sendMention: recorded('制御メンション', async () => {
        // 戻しの 1 行は**制御メッセージそのもの**に載せる (別の通にすると、そこで
        // 送信に失敗したときに戻しごと止まる)。契約タグと同時に載ることはない —
        // verify NG では契約を保存しないので savedFor は必ず null
        const sent = await sendControlMention(thread, handoffMention, {
          suffix: sendBack?.note ?? (savedFor ? formatContractTag(savedFor.nonce) : ''),
        });
        // **送れたときだけ**受信箱へ記録する。handoff は作者を待たせないので
        // 載せない — 依頼でないものを混ぜた瞬間に「全部読まないと分からない」に戻る
        if (handoffMention?.kind === 'notify') {
          noteOwnerCall({ thread, bot, cc, body: outgoing.body, sent });
        }
        return sent;
      }),
      // スレッドへ出せないケース (archive・削除・権限喪失) もあるので、
      // 告知はスレッド送信と placeholder 編集の両方を試す
      notifyFailure: async (failures) => {
        const text = `⚠️ 投稿の一部に失敗したため、次の担当は呼び出していません (${failures.join(' / ')})`;
        await sendSafe(thread, text.slice(0, 1900)).catch(() => {});
        if (placeholder) await editSafe(placeholder, text.slice(0, 1900)).catch(() => {});
      },
    });

    // 完了の検知は**配信できたときだけ**。届いていない報告でタスクを進めると、
    // スレッドには何も無いのにボードだけレビューへ進む
    let taskSubmitted = false;
    if (result.delivered) {
      taskSubmitted = await noteTaskCompletion({
        thread, bot, cc, contractOut, mention: outgoing.mention, verifyResult,
      }) === true;
    }
    // 実行記録へ返す文脈: 誰を呼んだか (呼べたときだけ) と、レビューへ進めたか
    result.handoff = result.handedOff && handoffMention
      ? { toBotKey: targetBotKey, kind: handoffMention.kind ?? 'handoff' }
      : null;
    result.taskSubmitted = taskSubmitted;

    if (!result.delivered) {
      console.error(
        `[${bot.key} thread:${thread.id}] 配信に失敗したため handoff しません: ${result.failures.join(' / ')}`,
      );
      // 相手を呼べていないのに契約だけ残すと、次に誰かが呼ばれたときに古い契約が効く。
      // **配送に失敗したこの 1 件だけ**を取り消す (宛先ごと消すと、同じ相手宛の
      // 他の未消費契約まで巻き添えになる)
      if (savedFor) {
        try {
          contracts.removeById(thread.id, savedFor.botKey, savedFor.id);
          console.log(`[contract] 配送に失敗したため取り消し: thread:${thread.id} → ${savedFor.botKey}`);
        } catch (err) {
          console.error(`[contract] 取り消しに失敗 (次の job で無視されます): ${err.message}`);
        }
      }
    }
    return result;
  }

  /**
   * verify が最終 NG だった job の戻し先。
   *
   * **戻すのは「頼んだ相手」** — 元の handoff 先ではない。壊れた成果を次の担当へ流さない
   * という門はそのままに、止まったことを**必ず誰かの受信箱へ落とす**ための経路。
   * 投げ手が居ない (人間が直接呼んだ)・自分自身・起動していない、のいずれでも
   * `[[notify:owner]]` と同じ形で人間を呼ぶ。
   *
   * **編成 (/roster) は迂回しない。** 宛先の allowlist は実行文脈の生成側と handoff の
   * 解決側の両方に効いている不変条件なので、ブリッジが起こす戻しだけ例外にしない —
   * 編成から外れた投げ手は「戻す相手が居ない」として人間を呼ぶ。
   *
   * @param {{bot: object, issuerBotKey: string|null, original: object|null,
   *          effectiveRoster: string[]|null}} p
   * @returns {{mention: {kind: string, userId: string, label: string}, note: string}|null}
   *   null = 戻す相手も owner も居ない (従来どおり黙って止まる)
   */
  function sendBackTarget({ bot, issuerBotKey, original, effectiveRoster = null, societyAction = null }) {
    // 元の宛先は「呼ばなかった相手」として添える (人が状況を追える唯一の手がかり)。
    // `[[notify:owner]]` も同じ — 呼ばれるはずだった人間の名前が消えない
    const dropped = original?.label ? ` / 元の宛先: ${original.label}` : '';
    // **自分自身へは戻さない。** 自己呼び出しで verify を回し直しても同じ結果になるだけで、
    // hop だけが減る (投げ手が自分 = 自己呼び出しの job)
    const issuer = issuerBotKey && issuerBotKey !== bot.key
      ? applyRoster(botEntries(), effectiveRoster)
        .find((b) => b.key === issuerBotKey && b.userId && b.inRoster !== false)
      : null;
    if (issuer) {
      const name = issuer.displayName || issuer.key;
      return {
        mention: { kind: 'handoff', userId: issuer.userId, label: name },
        note: `↩️ verify NG のため ${name} へ戻します (元の handoff は実行していません${dropped})`,
      };
    }
    if (OWNER_TARGETS.length === 0) return null;
    return {
      mention: { kind: 'notify', userId: OWNER_TARGETS[0].userId, label: OWNER_TARGETS[0].displayName },
      // 案件付きの job は台帳側が既に waiting(evidence) で止めている (society.js の applyTurn)。
      // 「誰も動いていない」ことと「何を待っているか」が噛み合う言い方にする
      note: societyAction
        ? `⛔ verify NG で止まりました — 案件 ${societyAction.caseId} は verify が通るまで待ちです`
          + ` (本文の handoff は実行していません${dropped})`
        : `⛔ verify NG で止まりました — 戻す相手が居ません (元の handoff は実行していません${dropped})`,
    };
  }

  /**
   * Bot が指定した画像を Discord へ添付する。
   * cwd 配下の実在画像だけを送る判定は resolveOutgoingFile の責務
   * (拡張子・実バイト・パス逸脱をそこで見る)。ここは送信と失敗報告に徹する。
   */
  async function sendAttachments(thread, markers, cwd) {
    const { files, rejected } = selectOutgoingFiles(markers, cwd, ATTACHMENT_LIMITS);

    // Discord は 1 通 10 添付まで。maxImagesPerJob を上げた設定でも
    // 「一通が拒否されて全部落ちる」ことがないよう複数通へ分ける。
    // **送信例外は握り潰さず投げる** — 添付が届いていないのに handoff すると、
    // 次の担当が「画像を見た前提」で走ってしまう
    for (let i = 0; i < files.length; i += DISCORD_MAX_FILES_PER_MESSAGE) {
      const batch = files.slice(i, i + DISCORD_MAX_FILES_PER_MESSAGE);
      await sendSafe(thread, {
        files: batch.map((f) => new AttachmentBuilder(f.bytes, { name: f.name })),
      });
    }

    // 「そもそも送る対象にできなかった」ものは配信失敗ではないので警告で伝える
    // (ただしこの警告の送信に失敗したら、それは配信失敗として上へ伝わる)
    if (rejected.length > 0) {
      await sendSafe(thread, `⚠️ 添付できなかった画像:\n${rejected.join('\n')}`.slice(0, 1900));
    }
  }

  /**
   * resolveOutgoingText へ渡す解決文脈。
   *
   * bots は**自分を含めて**渡す — 自分宛の [[handoff:...]] は「未知の宛先」ではなく
   * 「自分は呼び直せない」として理由付きで断りたいため (selfBotKey で判別する)。
   * owner を持たせるのは「人間にしか決められないことで止まった」ときの通知先。
   * 旧記法 (平文の @名前) の検出にも displayName / ownerNames を使う。
   */
  function outgoingContext(fromBot, effectiveRoster = null) {
    return {
      selfBotKey: fromBot.key,
      // 編成 (/roster・チャンネル既定) から外れた bot は inRoster: false で残す。配列から消すと
      // 「未知の宛先」として断ることになり、呼べなかった理由が食い違う。
      // 渡す編成は job の頭で固定したもの — 実行文脈に出した面子と必ず一致させる
      bots: applyRoster(botEntries(), effectiveRoster),
      owner: OWNER_TARGETS.length > 0
        ? { userId: OWNER_TARGETS[0].userId, names: OWNER_TARGETS.map((t) => t.displayName) }
        : null,
    };
  }

  return { postTurn, noteOwnerCall, closeInboxForThread, outgoingContext };
}
