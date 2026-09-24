// Discord のメッセージが job になるまでの入口 (src/index.js から切り出し)。
// 自分の発言の除外 → 受付停止 → 認可 → hop のリセット → トリガー判定 → チャンネル設定 →
// 作業ディレクトリの固定 → 再開要求の照合 → bot 起点のループガード → スレッド確保 → 受付 (admitJob)。
// 判断は src/trigger.js / src/authz.js / src/hops.js / src/interactions.js が持ち、ここは順序と結線だけ。
import { randomUUID } from 'node:crypto';
import { isAuthorizedSender } from '../authz.js';
import { channelNameOf, resolveAutonomy, unregisteredChannelNotice } from '../config.js';
import { readContractNonce, requiresContract } from '../contract.js';
import { admitJob } from '../interactions.js';
import { editSafe, replySafe, sendSafe } from '../mentions.js';
import { laneKeyFor } from '../queue.js';
import { isInitiativeTrigger, planTaskCwd } from '../scheduler.js';
import { canonicalCwd } from '../toolstore.js';
import { replyAuthorId, resolveTrigger, shouldIgnoreOwnMessage } from '../trigger.js';
import { prepareWorktree, prepareWorktreeOnce } from '../worktree.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Map<string, object>} deps.bots
 * @param {import('../hops.js').HopTracker} deps.hops
 * @param {import('../queue.js').JobQueue} deps.jobs
 * @param {object|null} deps.board
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {object|null} deps.recovery
 * @param {object|null} deps.society 社会の配線 (印の照合・受付の記録)。無い配備では null
 * @param {object} deps.lifecycle
 * @param {{maxHops: number, maxSelfHops: number}} deps.limits
 * @param {(id: string|null) => object} deps.runRecorder
 * @param {(item: object) => void} deps.enqueue
 * @param {Function} deps.runJob
 * @param {Function} deps.claimContract
 * @param {Function} deps.discardContractFor
 * @param {(threadId: string) => void} deps.noteJobSpent
 * @param {(threadId: string) => void} deps.closeInboxForThread
 * @param {(channel: object) => object|null} deps.channelConfigFor
 * @param {(userId: string|null|undefined) => string|null} deps.botKeyOf
 * @param {(guild: object, userId: string) => string|null} deps.botRoleFor
 * @param {(fromBot: object, guild: object) => object[]} deps.otherBotMentionIds
 * @param {{userId: string, displayName: string}[]} [deps.ownerTargets]
 *   作者の宛先 (`resolveOwnerTargets`)。上限で見送ったことを知らせる相手で、
 *   **空の配備ではメンションを載せずに同じ本文を出す**
 * @param {((p: {threadId: string, channelName: string|null, botKey: string, reason: string,
 *   messageId: string|null}) => void)|null} [deps.noteHopLimit]
 *   見送りを `/inbox` へ残す口 (無い配備では何もしない)
 */
export function createMessageWiring({
  config, bots, hops, jobs, board, jobRuns, recovery, society = null, lifecycle, limits, runRecorder,
  enqueue, runJob, claimContract, discardContractFor, noteJobSpent, closeInboxForThread,
  channelConfigFor, botKeyOf, botRoleFor, otherBotMentionIds,
  ownerTargets = [], noteHopLimit = null,
}) {
  const MAX_HOPS = limits.maxHops;
  const MAX_SELF_HOPS = limits.maxSelfHops;

  /**
   * タスクのスレッドで走る job の作業ディレクトリ。
   * どこで走るかの判断は `planTaskCwd` (scheduler.js) が持ち、ここは git を叩く側。
   *
   * @returns {Promise<{cwd?: string, error?: string}>} cwd 無し = チャンネル本体のまま走る
   */
  async function taskWorktreeFor({ configured, canonical, bot, channel }) {
    if (!board || !channel.isThread()) return {};
    const decided = planTaskCwd({
      task: board.findByThread(channel.id),
      autonomy: resolveAutonomy(configured),
      botKey: bot.key,
    });
    if (!decided.useWorktree) return {};
    try {
      const plan = await prepareWorktreeOnce(
        `${canonical}::${decided.taskId}`,
        () => prepareWorktree({
          repoRoot: canonical,
          taskId: decided.taskId,
          branch: decided.branch,
          base: decided.base,
        }),
      );
      // 作業ツリーも実体へ固定する — 本体と同じ不変条件 (junction 越しでも
      // レーン鍵とセッションが同じ値を指すように)
      const canonicalWorktree = canonicalCwd(plan.path);
      if (!canonicalWorktree) {
        return { error: `タスク ${decided.taskId} の作業ツリー ${plan.path} を解決できません` };
      }
      if (!plan.reused) {
        console.log(
          `[worktree] ${configured.channelName}: タスク ${decided.taskId} の作業ツリーを用意`
          + ` (${decided.branch} ← ${decided.base} / ${canonicalWorktree})`,
        );
      }
      return { cwd: canonicalWorktree };
    } catch (err) {
      return { error: `タスク ${decided.taskId} の作業ツリーを用意できません: ${err.message}` };
    }
  }

  async function onMessage(bot, msg) {
    if (!bot.userId) return; // ready 前
    // 自分の発言は原則ここで捨てる。**通すのは自己呼び出しの制御メッセージだけ** —
    // 判定は src/trigger.js (通り道が狭いことの根拠もそちらに書いてある)。
    // 報告 1 通ごとに job が湧かないよう、契約の破棄や受付停止の処理より前に落とす
    if (shouldIgnoreOwnMessage({ authorId: msg.author.id, botUserId: bot.userId, content: msg.content })) {
      return;
    }
    // 停止・再起動が始まっている — このプロセスはもう終わるので何も受け付けない。
    // **契約タグ付きの handoff だけは、捨てる前に対応する契約も捨てる** —
    // 残すと未消費のまま溜まり、24 時間以内に上限へ達して新しい委譲が保存できなくなる
    // (sol 指摘 2026-08-03)
    if (!lifecycle.accepting) {
      discardContractFor(bot, msg, '受付停止中');
      return;
    }
    if (!msg.inGuild()) return; // DM は対象外

    // 入口の identity 境界: チャンネル「名」でなく ID で縛る (sol レビュー知見)。
    // guildId / allowedUserIds は起動時検証で非空が保証されている (fail-closed)
    if (
      !isAuthorizedSender({
        config,
        guildId: msg.guildId,
        authorId: msg.author.id,
        isBot: msg.author.bot,
        ourBotIds: [...bots.values()].map((b) => b.userId),
      })
    ) return;

    // 人間の発言はホップカウンタをリセット
    if (!msg.author.bot && msg.channel.isThread()) {
      hops.reset(msg.channel.id);
      // 受信箱もここで閉じる。**新しい検知は要らない** — 会話の主導権が
      // 人間へ戻った瞬間 = 質問に何か返した瞬間、とみなす。作者に既読ボタンを
      // 押させると、押し忘れで受信箱が腐り、腐った受信箱は見られなくなる
      closeInboxForThread(msg.channel.id);
    }

    // 停止・再起動はスラッシュコマンド (/stop・/restart) に移した。
    // メンションで頼むと job として走ってしまい自分を殺せないため、
    // job の外側で処理する必要がある — onInteraction を参照

    // 自分宛か (生 content を正とする)。メンションのほか、人間が
    // 自分の発言へ返信した場合もトリガーになる (判定は src/trigger.js)。
    // 返信先の取得は本文で宛先が決まらなかったときだけ走る (lookupReply は遅延評価)
    const trigger = await resolveTrigger({
      content: msg.content,
      botUserId: bot.userId,
      botRoleId: botRoleFor(msg.guild, bot.userId),
      authorIsBot: msg.author.bot,
      otherBots: otherBotMentionIds(bot, msg.guild),
      lookupReply: () => replyAuthorId(msg),
    });
    if (!trigger.triggered) return;

    const configured = channelConfigFor(msg.channel);
    if (!configured) {
      discardContractFor(bot, msg, 'チャンネル未登録');
      await replySafe(msg, unregisteredChannelNotice(config, channelNameOf(msg.channel))).catch(() => {});
      return;
    }

    // **作業ディレクトリはここで 1 回だけ実体へ固定する。**
    // 以降のレーン鍵・CLI の cwd・セッション記録・承認の照合・拒否の申請がすべて
    // 同じ値を使う。生のパスを持ち回ると、junction を job の途中で差し替えたときに
    // 「A で起きた拒否が B 向けの承認として保存される」「resume が別の実体へ続く」
    // といった食い違いが起きる (sol 指摘 2026-08-01)。解決できなければ受け付けない
    const canonical = canonicalCwd(configured.cwd);
    if (!canonical) {
      discardContractFor(bot, msg, '作業ディレクトリを解決できない');
      await replySafe(
        msg,
        `⚠️ 作業ディレクトリを解決できません (${configured.channelName}: ${configured.cwd})`,
      ).catch(() => {});
      return;
    }
    // タスクのスレッドなら、そのタスク専用の作業ツリーで走らせる。**cc を組む前に
    // 決める** — レーン鍵・セッション記録・承認の照合・verify はすべて cc.cwd を見るので、
    // 後から差し替えると上のコメントと同じ食い違いが起きる
    const worktree = await taskWorktreeFor({ configured, canonical, bot, channel: msg.channel });
    if (worktree.error) {
      discardContractFor(bot, msg, '作業ツリーを用意できない');
      await replySafe(msg, `⚠️ ${worktree.error}`).catch(() => {});
      return;
    }
    // repoRoot は差し替え**前**の本体。契約はこちらで束縛する (contractCwd) —
    // worktree で走る worker と本体で走る reviewer が同じ契約を見られるように
    const cc = { ...configured, cwd: worktree.cwd ?? canonical, repoRoot: canonical };

    // 再開要求の受付側の照合 (レビュー指摘 2026-09-05 A)。期限切れ・受付済み・送れなかったと
    // 記録された要求の投稿が遅れて届いても起動しない。**hop と予算を消費する前**に見る
    // (見送る job でタスクの予算を減らさない)。印の無い投稿はそのまま通る
    if (msg.author.bot && msg.channel.isThread() && recovery) {
      const screened = recovery.screenTrigger({
        threadId: msg.channel.id, content: msg.content, botKey: bot.key, messageId: msg.id,
      });
      if (!screened.ok) {
        console.log(`[recovery] ${screened.reason} (thread:${msg.channel.id} msg:${msg.id})`);
        discardContractFor(bot, msg, '失効した再開要求');
        await sendSafe(msg.channel, `⏹ ${screened.reason}`.slice(0, 1900)).catch(() => {});
        return;
      }
    }

    // 社会 (自律社会) の起動の照合。**本文の印だけでは実行しない** —
    // 保存済みの Action と突き合わせて、送っていない・宛先違い・再配送・終端の案件を断る。
    // `screenTrigger` と同じく **hop と予算を消費する前**に見る (見送る job で減らさない)
    let societyAction = null;
    if (msg.author.bot && msg.channel.isThread() && society) {
      const screened = society.screenAction({
        content: msg.content, messageId: msg.id, botKey: bot.key, threadId: msg.channel.id,
      });
      if (!screened.ok) {
        console.log(`[society] ${screened.reason} (thread:${msg.channel.id} msg:${msg.id})`);
        discardContractFor(bot, msg, '失効した案件の起動');
        await sendSafe(msg.channel, `⏹ ${screened.reason}`.slice(0, 1900)).catch(() => {});
        return;
      }
      societyAction = screened.action;
    }

    // bot 発言起点のループガード (bot 同士の無限往復を封じる)
    if (msg.author.bot) {
      if (!msg.channel.isThread()) return; // bot 起点はスレッド内のみ想定
      // **社会の印が付いた起動は bot 間ホップを消費しない** — 投げたのは bridge であって
      // bot ではない (再開要求と同じ立場)。ホップは「bot 同士の往復」を止めるための門なので、
      // 台帳が起こした 1 本をそこに数えると、往復していないのに上限へ当たる。
      //
      // 下の `noteJobSpent` は従来どおり通す。ただしそれが減らすのは **task スレッドの job 数**
      // (`board.spendJob`) だけで、`hops` 側のスレッド予算 (`grantTaskBudget`) は
      // `hops.take` を飛ばすぶん減らない。**同じ 1 本を 2 つの勘定が別々に数えている**状態で、
      // 統合と「社会の Action に対する門」は S3 の予算まわりでまとめて入れる (HANDOFF に記載)
      if (societyAction) {
        // bridge 起点の起動は新しい仕事の単位 — 宛先 bot の自己呼び出し連鎖はここで切れてよい
        hops.breakSelfChain(msg.channel.id);
      } else {
        if (msg.author.id === bot.userId) {
          // 自己呼び出しは別枠で先に見る。ここで止めるターンに bot 間ホップを
          // 消費させない (他の担当へ渡す余地は残す)
          const self = hops.takeSelf(msg.channel.id, bot.key);
          if (!self.allowed) {
            await refuseBotStart({
              msg,
              bot,
              cc,
              budgetWarn: self.warn,
              limitLabel: `連続自己呼び出しが上限 (${MAX_SELF_HOPS})`,
            });
            return;
          }
        } else {
          hops.breakSelfChain(msg.channel.id); // 別の担当が動いた = 自己の連鎖は切れた
        }
        const hop = hops.take(msg.channel.id);
        if (!hop.allowed) {
          await refuseBotStart({
            msg,
            bot,
            cc,
            budgetWarn: hop.warn,
            limitLabel: `bot 間ホップが上限 (${MAX_HOPS})`,
          });
          return;
        }
      }
      // ここを通った = bot 起点の job が 1 本走る。タスクスレッドなら台帳へ記帳する
      noteJobSpent(msg.channel.id);
    }

    // スレッド確保 (チャンネル直メンションなら起点メッセージからスレッドを生やす)
    let thread;
    if (msg.channel.isThread()) {
      thread = msg.channel;
    } else if (msg.hasThread) {
      thread = msg.thread;
    } else {
      const name = (msg.cleanContent || 'task').replaceAll('\n', ' ').slice(0, 80) || 'task';
      try {
        thread = await msg.startThread({ name });
      } catch {
        // 両 bot 同時メンション時の race: 相手 client が先にスレッド作成済み (160004)。
        // メッセージ起点スレッドの ID は元メッセージ ID と同一
        thread = await msg.channel.threads.fetch(msg.id).catch(() => null);
        if (!thread) {
          console.error(`[${bot.key}] スレッド作成/取得に失敗 (msg ${msg.id})`);
          return;
        }
      }
    }

    // 待たされるのは「同じ作業ディレクトリの job が走っている」か「同時実行上限」の時だけ
    const laneKey = laneKeyFor(cc.cwd);
    const queued = jobs.wouldQueue(laneKey);
    // handle は enqueue 時点で abort 可能にしておく (spawn 前の stop は flag として届き、
    // runClaude/runCodex が入口で拾って起動せず中断する)
    const handle = { stopRequested: false };
    handle.abort = () => {
      handle.stopRequested = true;
    };
    // ここまでの await (trigger 解決・スレッド作成) の間に停止が始まっていないか、
    // admitJob が ⏳ の前後でもう一度見る。積んでしまうと誰にも止められない
    // 記録できなかった受付 (起動しない) の理由。admitJob の accept は同期なので、外へ持ち出して報告する
    let notRecorded = null;
    // ❌ に添える直し方。既定は data/ の書き込みの話で、社会台帳の失敗はそちらの言い方に差し替える
    let notRecordedAdvice = '→ data/ の書き込み権限と空き容量を確認してから再メンションしてください';
    const { admitted, placeholder: admittedPlaceholder } = await admitJob({
      lifecycle,
      sendPlaceholder: () =>
        sendSafe(thread, `⏳ ${bot.cfg.displayName} が受け付けました${queued ? ' (キュー待ち)' : ''}`),
      accept: (placeholder) => {
        // 計測ログと実行記録で同じ ID を使う — 並走した job のログが混ざっても 1 本を追える
        const jobId = randomUUID().slice(0, 8);
        const fromBotKey = botKeyOf(msg.author?.id);
        // **(1) 受付の意図を先に記録する (契約を claim する前)。** ここで書けなければ起動しない —
        // 記録の無い job は復旧の判断から漏れ、「動いているのか止まったのか」が誰にも分からなくなる。
        // claim との間で落ちたときは、記録の contractState が pending のまま残るので
        // 「契約を消費したのに束縛の記録が無い」と照合できる (契約なしの通常 job へ縮退しない)
        const taskId = board?.findByThread(thread.id)?.id ?? null;
        try {
          jobRuns.open({
            id: jobId,
            taskId,
            threadId: thread.id,
            botKey: bot.key,
            channelName: cc.channelName,
            cwd: cc.cwd,
            trigger: { messageId: msg.id, byBotKey: fromBotKey, self: fromBotKey === bot.key },
            intent: { contractExpected: requiresContract(msg.content), nonce: readContractNonce(msg.content) },
            placeholderId: placeholder?.id ?? null,
            // 社会の起動なら操作 ID を受付の記録に残す — 照合はこれを鍵に外側を探す
            society: societyAction,
          });
        } catch (err) {
          notRecorded = err.message;
          console.error(`[jobruns] ${jobId}: 受付を記録できないため起動しません: ${err.message}`);
          return;
        }
        // この job を起こした投稿が再開要求なら、受付した時点で要求を閉じる —
        // 送信完了から受付までの窓で同じ task をもう一度起こさないための照合点
        if (taskId && recovery) {
          const accepted = recovery.noteAccepted({ taskId, triggerMessageId: msg.id, botKey: bot.key, runId: jobId });
          if (accepted) console.log(`[recovery] #${taskId} の再開要求 ${taskId}-${accepted.generation} を受付済みにしました (job ${jobId})`);
        }
        // 社会の受付: **受付記録と消費の確定が保存できるまで実行キューへ渡さない。**
        // ここで書けないまま走らせると、外では job が動いているのに台帳は「送っただけ」に
        // 見え、照合が同じ Action をもう一度起こしうる
        if (societyAction) {
          // messageId も渡す — 投稿は出たが `sent` の保存前に落ちた形は、受付と同じ流れで補完する
          const noted = society.noteAccepted(societyAction.actionId, { runId: jobId, messageId: msg.id });
          if (!noted.ok) {
            notRecorded = `案件 ${societyAction.actionId} の受付を社会台帳へ保存できません (${noted.code}: ${noted.reason ?? ''})`;
            notRecordedAdvice = '→ 社会台帳 (data/society.json) を直すか、この案件を止めてからやり直してください';
            // **開いた記録を終端まで書く。** `queued` のまま残すと、照合が「外で job が立った」と
            // 読んで Action を accepted + charged にしてしまう (走っていないのに予算が焼ける)
            try {
              jobRuns.cancel(jobId, { stopKind: 'runtime', reason: '社会台帳へ受付を保存できず起動しなかった' });
            } catch (err) {
              console.error(`[jobruns] ${jobId}: 取り消しを記録できませんでした: ${err.message}`);
            }
            console.error(`[society] ${jobId}: ${notRecorded} — 起動しません`);
            return;
          }
        }
        // **(2) 契約は受付の時点で claim する (ストアから取り出して job に束縛する)。**
        // job 開始時まで残しておくと、待機中に /stop・/restart で取り消された job の
        // 契約がストアに居座り、次の同じ送信元からの handoff がそれを消費してしまう
        // (対応がずれる — sol 指摘 2026-08-03)。取り消された job の契約は
        // その job と一緒に捨てられるのが正しい
        const claimed = claimContract({ bot, thread, triggerMsg: msg });
        // (3) 束縛した契約の参照を記録へ確定する。書けなければ起動しない — 契約は既に消費されて
        // いるので、走らせずに人へ返す (走らせて途中で落ちると、記録は pending・契約は無し、で
        // 何が効いていたのかを誰も読めない)
        try {
          jobRuns.bindContract(jobId, claimed);
        } catch (err) {
          notRecorded = `${err.message}${claimed?.entry ? ' (取り出した契約は消費済みなので委譲し直してください)' : ''}`;
          console.error(`[jobruns] ${jobId}: 契約の束縛を記録できないため起動しません: ${err.message}`);
          return;
        }
        const recorder = runRecorder(jobId);
        enqueue({
          jobId,
          enqueuedAt: Date.now(),
          laneKey,
          threadId: thread.id,
          botKey: bot.key,
          // 自律運転の勘定はチャンネル単位 (バックオフ) — job の成否をそこへ返す
          channelName: cc.channelName,
          // 発議機構が起こした job は**バックオフの証拠に数えない**。
          // 起こした 1 通で決めるので、通常のタスクスレッドへ出た裁定依頼も取り違えない
          initiativeJob: isInitiativeTrigger(msg.content),
          placeholder,
          handle,
          // 止められたとき「誰が」を実行記録へ (stopJobs が abort より先に呼ぶ)。
          // 待機中の取り消しは走らない job なので、ここで終端まで書く
          onStop: ({ kind, waiting }) => {
            if (waiting) {
              try { jobRuns.cancel(jobId, { stopKind: kind, reason: '待機中に取り消し' }); }
              catch (err) { console.error(`[jobruns] ${jobId}: 取り消しを記録できませんでした: ${err.message}`); }
              // **待機中の取り消しは runItem を通らない** = `noteSettled` が呼ばれない。
              // 照合が見るのは sending / sent / reconcile だけなので、ここで終端まで書かないと
              // Action が accepted のまま誰にも拾われない (Fable 検収 2026-09-07 (b))
              const actionId = society ? jobRuns.get(jobId)?.society?.actionId ?? null : null;
              if (actionId) {
                try {
                  society.noteSettled(actionId, { runId: jobId, outcome: 'cancelled', reason: '待機中に取り消し' });
                } catch (err) {
                  console.error(`[society] ${actionId}: 待機中の取り消しを記録できませんでした: ${err.message}`);
                }
              }
            } else {
              recorder.stopRequested(kind);
            }
          },
          run: (metrics, run, outcome) => runJob(
            bot, msg, thread, cc, placeholder, handle, metrics, claimed, run ?? recorder, outcome ?? {},
            // S2-3 が実行文脈 (案件・決定権者・Claim 世代) に使う。この PR では素通し
            societyAction,
          ),
        });
      },
    });
    // ⏳ の送信中に停止が始まって受け付けなかった — この handoff は job にならないので、
    // 対応する契約も残さない (claim は accept の中でしか走っていない)
    if (!admitted) discardContractFor(bot, msg, '受付できなかった');
    else if (notRecorded !== null) {
      // 受け付けたが記録できず起動しなかった。契約を取り出す前なら捨て、⏳ を ❌ に直す
      discardContractFor(bot, msg, '実行記録を保存できない');
      const text = `❌ ${bot.cfg.displayName} を起動しませんでした — 受付を保存できません\n`
        + `${notRecorded}\n${notRecordedAdvice}`;
      if (admittedPlaceholder) await editSafe(admittedPlaceholder, text.slice(0, 1900)).catch(() => {});
      else await sendSafe(thread, text.slice(0, 1900)).catch(() => {});
    }
  }

  /**
   * bot 起点を止めたときの言い方。
   *
   * **予算切れと hop 上限を混ぜない。** hop 上限は「続けるには人間が発言してください」で
   * 正しいが、タスクの job 予算は**人間が発言しても戻らない** (src/hops.js の reset は
   * 予算を触らない)。同じ文言を出すと、発言しても動かない状態で人間が待ち続ける。
   */
  function stopNoticeFor(threadId, fallback) {
    if (hops.taskBudget(threadId) !== 0) return fallback;
    return {
      kind: 'budget',
      reason: 'タスクの job 予算切れ',
      text: '⚠️ このタスクの job 予算を使い切ったため停止。**発言しても再開しません** — '
        + '追い予算を出す (タスクを resume する) か、タスクを閉じてください',
    };
  }

  /**
   * 上限に当たって起動を見送ったことを知らせ、`/inbox` に残す。
   *
   * **見送るたびに出す。** `src/hops.js` の `warn` は「上限に張り付いたスレッドで警告を
   * 撒かない」ためスレッドに 1 回しか立たないが、この門は見送りと同時に**その起動に
   * 付いていた委譲契約を捨てている**ので、2 回目以降を黙って止めると委譲元は投げた
   * つもりのまま契約だけが消える (2026-09-08 に作者が 2 回踏んだ)。bot 同士の往復は
   * ここで止まるので、出る数は同時に走っていた job の数で頭打ちになる。
   *
   * 予算切れ (`stopNoticeFor` が差し替える分) は従来どおり `warn` のときだけ 1 回 —
   * あちらは人間が発言しても戻らない待ちで、繰り返しても状況が変わらない。
   * **ただし契約を捨てたときは予算切れでも必ず出す** (下の分岐)。
   */
  async function refuseBotStart({ msg, bot, cc, budgetWarn, limitLabel }) {
    const threadId = msg.channel.id;
    const ownerId = ownerTargets[0]?.userId ?? null;
    const notice = stopNoticeFor(threadId, { kind: 'hop-limit', reason: limitLabel });
    // **捨ててから文面を組む。** 「捨てました」と言ってよいのは*実際に落ちたとき*だけで、
    // 本文の印だけでは分からない (失効した後・既に取り出された後はストアに無い)
    const dropped = discardContractFor(bot, msg, notice.reason) !== null;
    const contractLine = dropped
      ? '\nこの起動に付いていた委譲契約は捨てました — 続ける場合は委譲元に出し直させてください'
      : '';

    if (notice.kind !== 'hop-limit') {
      // 予算切れは繰り返しても状況が変わらないので 1 回だけ。**契約を捨てたときだけは別** —
      // 黙って消すと、委譲元は投げたつもりのまま待つ (この PR が塞いだ穴と同じ形)。
      //
      // `budgetWarn` は `take` の戻りで、**ホップ上限に先に当たっているスレッドでは
      // hop 側の `warned` 由来**になる (`src/hops.js` の take は上限を先に見て返す)。
      // 予算 > ホップ上限という逆転した配備では予算切れの 1 回が出ないことがあるが、
      // 既定 (予算 20 / 上限 36) では予算が先に尽きるので起きない
      if (!budgetWarn && !dropped) return;
      await sendSafe(msg.channel, `${notice.text}${contractLine}`, {
        // **契約を捨てたときは owner を呼ぶ。** 委譲元の bot はこの通知でメンションされない
        // ので気づけず、予算の追加も委譲の出し直しも人間の仕事 (Opus レビュー 2026-09-08)
        mentionUserIds: dropped && ownerId ? [ownerId] : [],
      }).catch(() => {});
      return;
    }
    // owner を**実際にメンションする** (allowedMentions に載せないと通知が飛ばない)
    const text = `⚠️ ${limitLabel} に達したため ${bot.cfg.displayName} の起動を見送りました。`
      + `${ownerId ? `<@${ownerId}> ` : ''}続けるには人間が発言してください。${contractLine}`;
    const sent = await sendSafe(msg.channel, text, {
      mentionUserIds: ownerId ? [ownerId] : [],
    }).catch(() => null);
    // 見送りは `/inbox` にも残す。閉じるのは人間の発言 (closeInboxForThread) —
    // 「続けるには人間が発言してください」と同じ条件なので、閉じ忘れが起きない
    noteHopLimit?.({
      threadId,
      channelName: cc?.channelName ?? null,
      botKey: bot.key,
      reason: notice.reason,
      messageId: sent?.id ?? null,
    });
  }

  return { onMessage, taskWorktreeFor, stopNoticeFor };
}
