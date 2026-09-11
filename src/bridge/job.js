// job 1 本の実行 (src/index.js から切り出し)。role の組み立て → 契約の適用 → ランタイムの起動 →
// 構造化出力の受け取り → verify → 配送、を 1 本の runJob が順に通す。
// 判断はそれぞれの純粋モジュール (src/contract.js / src/rolecontext.js / src/verify.js …) が持ち、
// ここは一時ファイル・子プロセス・Discord の placeholder を結ぶ。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeImageFiles } from '../attachments.js';
import { APPROVAL_POLL_MS, ApprovalBroker, createAskLedger } from '../broker.js';
import { runClaude as runClaudeReal } from '../claude.js';
import { runCodex as runCodexReal } from '../codex.js';
import {
  resolveAddDirs,
  resolveAllowedTools,
  resolveChannelRoster,
  resolveCodexSandbox,
  resolveHooksEnabled,
  resolvePermissionMode,
  resolveStructuredOutputEnabled,
  resolveVerifyCommand,
  resolveVerifyMaxRetries,
} from '../config.js';
import {
  SCHEMAS,
  bodyOf,
  renderForKind,
  resolveJobContractKind,
  validateContract,
} from '../contract.js';
import { diffSnapshots, gitStatusSnapshot } from '../gitstatus.js';
import {
  buildApprovalPreToolHooks,
  buildHookSettings,
  buildTraceToolHooks,
  buildVerifyStopHooks,
} from '../hooks.js';
import { editSafe } from '../mentions.js';
import { createProgressReporter } from '../progress.js';
import { checkRoleProtocol } from '../protocol.js';
import { buildRuntimeContext } from '../rolecontext.js';
import { applyRoster, resolveEffectiveRoster } from '../roster.js';
import { msOfTime } from '../time.js';
import { sanitizeForDisplay } from '../toolrules.js';
import { TRACE_HOOK_TIMEOUT_MS, readTraceEntries, summarizeTrace } from '../trace.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, readVerifyState, runVerify } from '../verify.js';

/**
 * 引き継ぎ文書の在り処 (実行文脈へ出す — src/rolecontext.js)。
 *
 * **置いてあるプロジェクトでだけ効く。** 設定を増やさず「ファイルがあれば有効」に
 * してあるのは、これが機構というより約束事だから — 使いたいプロジェクトは
 * `docs/HANDOFF.md` を作れば次の job から実行文脈に出る。
 *
 * スレッドは毎回切れるがプロジェクトの現在地は続くので、そこを文書側に置いて
 * 「次に進めて」の一言で始められるようにする。
 */
export const HANDOFF_FILE = 'docs/HANDOFF.md';

export function handoffFileFor(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  try {
    return existsSync(resolve(cwd, HANDOFF_FILE)) ? HANDOFF_FILE : null;
  } catch {
    return null; // 読めない cwd で job を落とさない (案内が出ないだけ)
  }
}

/**
 * 本文の末尾に 1 行足す。ただし**制御フッターより前**へ挟む。
 *
 * 起動を決めるのは「末尾の独立行」だけ (`src/mentions.js` の `footerStartLine`) なので、
 * `[[handoff:...]]` の後ろに 1 行足すとフッターが本文扱いになり、**委譲が黙って不発**になる。
 * 判定は取りこぼさない側へ倒す — 括弧行らしきものは全部フッター候補として飛ばす
 * (足す位置が 1 行ずれるだけで、失うものが無い)。
 */
function appendBeforeFooter(text, line) {
  const lines = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let at = lines.length;
  while (at > 0) {
    const prev = lines[at - 1];
    if (prev.trim() === '' || /^[ \t]*\[\[.*\]\][ \t]*$/.test(prev)) {
      at -= 1;
      continue;
    }
    break;
  }
  lines.splice(at, 0, line);
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.root                  リポジトリの根 (役割文の解決に使う)
 * @param {string} deps.commonRolePath        roles/_common.md の絶対パス
 * @param {import('../store.js').SessionStore} deps.store   スレッド × bot のセッション記録
 * @param {import('../roster.js').RosterStore} deps.roster
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {object|null} deps.board            TaskBoardStore (自律運転の無い配備では null)
 * @param {object} deps.limits                index.js が config から解いた上限の束
 * @param {Array<{userId: string, displayName: string}>} deps.ownerTargets
 * @param {(id: string|null) => object} deps.runRecorder 実行記録への書き口 (src/bridge/recorder.js)
 * @param {(cc: object) => string[]} deps.approvedRulesFor 承認済みルール (src/bridge/tools.js)
 * @param {(p: object) => object} deps.applyIncomingContract 契約の適用 (src/bridge/contracts.js)
 * @param {(threadId: string, botKey: string) => string|null} deps.claimContractKindOverride スカウト等の種別上書き
 * @param {(bot: object, triggerMsg: object, thread: object, entry: object|null, includeSelf?: boolean) => Promise<object>} deps.buildPrompt
 * @param {(msg: object) => boolean} deps.isInfraMessage
 * @param {Function} deps.postTurn            配送 (src/bridge/turn.js)
 * @param {Function} deps.fileProposal        起票 (src/bridge/board.js)
 * @param {Function} deps.applyApproval       承認の適用 (src/bridge/board.js)
 * @param {Function} deps.applyReview         レビュー判定の適用 (src/bridge/board.js)
 * @param {Function} deps.applyProposalAdjudication bot の裁定 (src/bridge/proposals.js)
 * @param {Function} deps.raiseProposal       発議 (src/bridge/proposals.js)
 * @param {object|null} [deps.society]        社会の配線 (案件の文脈と、構造化された戻りの写し)
 * @param {Function} deps.decideApproval      実行中の承認要求 (src/bridge/tools.js)
 * @param {() => object[]} deps.botEntries
 * @param {Function} [deps.runClaude]         テストから差し替えるためのランタイム (既定は src/claude.js)
 * @param {Function} [deps.runCodex]          同上 (既定は src/codex.js)
 */
export function createJobRunner({
  config, root: ROOT, commonRolePath: COMMON_ROLE_PATH, store, roster, jobRuns, board, limits,
  ownerTargets: OWNER_TARGETS, runRecorder, approvedRulesFor, applyIncomingContract,
  claimContractKindOverride, buildPrompt, isInfraMessage, postTurn, fileProposal, applyApproval,
  applyReview, applyProposalAdjudication, raiseProposal, decideApproval, botEntries, society = null,
  runClaude = runClaudeReal, runCodex = runCodexReal,
}) {
  const MAX_APPROVAL_CARDS = limits.maxApprovalCards;
  const APPROVAL_WAIT_MS = limits.approvalWaitMs;
  const APPROVAL_HOOK_TOOLS = limits.approvalHookTools;
  const MAX_SELF_HOPS = limits.maxSelfHops;
  const MAX_STDOUT_BYTES = limits.maxStdoutBytes;
  const QUIET_WINDOW_MS = limits.quietWindowMs;
  const QUIET_WAIT_MAX_MS = limits.quietWaitMaxMs;

  /**
   * 待機中の stop を 1 秒刻みの再確認より早く拾うための sleep。
   * handle.abort を一時的に包み、解決時に必ず元へ戻す
   * (runClaude/runCodex が後から自分の abort を差す前提を壊さない)。
   */
  function sleepInterruptible(ms, handle) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const prevAbort = handle.abort;
      function done() {
        clearTimeout(timer);
        handle.abort = prevAbort;
        resolve();
      }
      handle.abort = () => {
        prevAbort?.(); // stopRequested を立てるのは元の abort の責務
        done();
      };
    });
  }

  /**
   * スレッド静止待ち。人間が「メンションして送信 → 続きを数秒後に投稿」した場合、
   * キューが空いていると job が即走り、続きが buildPrompt の fetch に間に合わない
   * (恒久欠落はしないが今回の応答に載らない)。直近の実投稿から QUIET_WINDOW_MS
   * 沈黙するまで最大 QUIET_WAIT_MAX_MS 待ってから続行する。
   * ブリッジ自身の運用メッセージ (⏳ placeholder 等) はタイマーを延長しない。
   * bot 起点は直列キューが投稿完了を保証しているので呼び出し側で待たない。
   * @returns {Promise<boolean>} false = 停止指示により中断
   */
  async function waitForThreadQuiet(thread, handle) {
    const deadline = Date.now() + QUIET_WAIT_MAX_MS;
    for (;;) {
      if (handle.stopRequested) return false;
      let newest = null;
      try {
        const batch = await thread.messages.fetch({ limit: 10 });
        for (const m of batch.values()) {
          if (isInfraMessage(m)) continue;
          if (!newest || m.createdTimestamp > newest.createdTimestamp) newest = m;
        }
      } catch {
        return true; // 履歴が読めないなら待つ意味がない (buildPrompt 側で再度扱う)
      }
      if (!newest || Date.now() - newest.createdTimestamp >= QUIET_WINDOW_MS) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true; // チャット継続で job が停滞しないための上限
      await sleepInterruptible(Math.min(1000, remaining), handle);
    }
  }

  /**
   * この job を頼んだ相手 (§12.3 (3) の「verify NG で戻す先」)。
   *
   * **契約があればその `fromBotKey` が正本。** 起動メッセージは別の bot の client から
   * 投げられることがある (レビュー召喚・再開要求は担当以外の client が投稿する) ので、
   * 委譲された job では投稿者よりも契約の側を信じる。
   *
   * @returns {string|null} 投げ手の bot キー (人間が直接呼んだ job なら null)
   */
  function issuerBotKeyOf(triggerMsg, claimed) {
    const fromContract = claimed?.entry?.fromBotKey;
    if (typeof fromContract === 'string' && fromContract !== '') return fromContract;
    const author = triggerMsg?.author;
    if (!author?.bot || !author.id) return null;
    return botEntries().find((b) => b.userId && b.userId === author.id)?.key ?? null;
  }

  /**
   * 1 ターンを走らせる。
   * @param {object} [metrics] 計測ログ用の出力先 (呼び出し側が用意し、ここで書き込む)
   * @returns {Promise<string>} 終了理由 (計測ログの最後に出る短い識別子)。
   *   ok / verify-failed / aborted / failed(...) / deliver-failed / protocol-mismatch / role-unreadable /
   *   stopped-before-start / contract-unenforceable。
   *   throw した場合は呼び出し側が internal-error として記録する
   */
  async function runJob(
    bot, triggerMsg, thread, cc, placeholder, handle, metrics = {},
    claimed = { entry: null, error: null },
    run = runRecorder(null), outcome = {},
    // 社会の起動なら `{caseId, actionId, claimGeneration}` (S2-2 の受付点が渡す)。
    // 実行文脈と、戻りを台帳へ写す分岐がこれを見る
    societyAction = null,
  ) {
    const workingText = `⚙️ ${bot.cfg.displayName} 作業中… (${cc.channelName} / model: ${bot.cfg.model})`;
    await editSafe(placeholder, workingText).catch(() => {});
    const typing = setInterval(() => thread.sendTyping().catch(() => {}), 8000);
    // codex へ渡す一時画像と、claude へ渡す role / settings のスナップショットの置き場。
    // 成功・失敗・停止・タイムアウトのどの経路を通っても finally で必ず消す
    let imageDir = null;
    let roleDir = null;
    let settingsDir = null;
    let verifyCommand = null;
    let verifyStateFile = null;
    let traceFile = null;
    let broker = null;
    // hook 経路で承認カードを出したルールの台帳 (重複と上限を並行 ask でも守り、
    // 出したものは job 終了後にもう一度カードにしない)
    const askLedger = createAskLedger({ max: MAX_APPROVAL_CARDS });
    // 承認待ちの間は ⏳ と同じく「レーンを掴んだまま止まっている」状態になる。
    // 何を待っているのか分からないと ⚙️ のまま固まったようにしか見えないので出す
    let waitingApprovals = 0;
    const onWaitingChange = (delta) => {
      waitingApprovals += delta;
      const text = waitingApprovals > 0
        ? `🔐 ${bot.cfg.displayName} 承認待ち… (${cc.channelName} / ボタンを押すと同じ job が続行します)`
        : workingText;
      // 実行記録にも段階として残す (「⚙️ のまま固まっている」と「人間のボタンを待っている」を後から区別する)
      run.stage(waitingApprovals > 0 ? 'approval' : 'model');
      // 表示が更新できなくても承認そのものは進む (placeholder が消えていることもある)
      try { void editSafe(placeholder, text).catch(() => {}); } catch { /* 表示だけの失敗 */ }
    };
    // 「⚙️ 作業中…」に段階・経過・最後に完了したツールを出す (§11.2)。情報源は実行記録と
    // trace ファイルだけ。承認待ち (🔐) の表示は上書きしない。モデルが返ったら止める —
    // 以降の placeholder は終端の表示 (❌ / ⏹ / 削除) になるので、tick に上書きさせない
    const jobStartedAt = Date.now();
    const progress = createProgressReporter({
      snapshot: () => {
        if (waitingApprovals > 0) return { suspended: true };
        const record = run.id ? jobRuns.get(run.id) : null;
        const stage = record?.stage ?? 'model';
        if (!['starting', 'model', 'verify', 'deliver'].includes(stage)) return null;
        const entries = traceFile ? readTraceEntries(traceFile) : [];
        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        const started = msOfTime(record?.startedAt);
        return {
          displayName: bot.cfg.displayName,
          channelName: cc.channelName,
          model: bot.cfg.model,
          stage,
          startedAt: Number.isFinite(started) ? started : jobStartedAt,
          now: Date.now(),
          hooks: traceFile !== null,
          toolCalls: traceFile !== null ? entries.length : null,
          lastTool: last ? { tool: last.tool, arg: last.arg ?? null, at: last.at ?? null } : null,
        };
      },
      edit: (text) => editSafe(placeholder, text),
      // 軌跡が増えた = 観測できた活動。実行記録の observedAt を進める (停滞判定の材料)
      onChange: (snap) => run.activity({
        at: snap.lastTool?.at ?? Date.now(),
        kind: 'tool',
        detail: `${snap.lastTool?.tool ?? ''} ${snap.lastTool?.arg ?? ''}`.trim() || `ツール ${snap.toolCalls} 件`,
      }),
    });
    progress.start();
    try {
      // 人間の分割投稿を同一ターンに取り込む静止待ち (bot 起点は待たない)。
      // job は分単位で走るので数秒の待ちは実質ノーコスト
      if (!triggerMsg.author.bot && !(await waitForThreadQuiet(thread, handle))) {
        await editSafe(placeholder, '⏹ 停止しました (実行開始前に中断・変更なし)').catch(() => {});
        return 'stopped-before-start';
      }

      // role は「共通規定 (roles/_common.md) + 役割文 + 実行文脈」の 3 段で組む。
      // 共通規定を切り出したのは、制御フッターと Discord 運用が 3 ファイルへ同じ文面で
      // コピーされていて、記法を変えるたびに直し漏れが出たため。
      //
      // プロトコル版は**ファイルごとに**照合する。role は job ごとに読み直されるのに
      // 送信パーサはプロセス起動時のままなので、「role だけ先に新しい」状態では委譲が
      // 黙って落ちる。連結してから 1 回だけ見ると先頭 (共通規定) の宣言しか読めず、
      // 古い版のまま残った役割文を見逃す
      const sources = [
        { label: 'roles/_common.md', path: COMMON_ROLE_PATH },
        { label: bot.cfg.rolePromptFile, path: resolve(ROOT, bot.cfg.rolePromptFile), own: true },
      ];
      const parts = [];
      // この bot 自身の役割文 (スキーマ宣言を読む対象。共通規定側には置かせない —
      // 種別は「その役の仕事」であって全員共通の規定ではない)
      let ownRoleText = '';
      for (const src of sources) {
        let text;
        try {
          text = readFileSync(src.path, 'utf8');
        } catch (err) {
          await editSafe(placeholder, `❌ role prompt を読めません (${src.label}): ${err.message}`)
            .catch(() => {});
          return 'role-unreadable';
        }
        const proto = checkRoleProtocol(text);
        if (!proto.ok) {
          console.error(`[${bot.key}] プロトコル版不一致 (${src.label}): ${proto.reason}`);
          await editSafe(
            placeholder,
            `❌ ${bot.cfg.displayName} を起動しませんでした\n${src.label}: ${proto.reason}`,
          ).catch(() => {});
          return 'protocol-mismatch';
        }
        if (src.own) ownRoleText = text;
        parts.push(text.trim());
      }
      // 権限と編成は config.json (+ スレッド編成は data/roster.json) が正本。役割文へ書くと
      // 設定を変えた瞬間に嘘になるので、job ごとに起こして**最後に**置く
      // (直前の記述が食い違ったらこちらを信じる、と共通規定にある)。
      //
      // 編成は job の頭で 1 回だけ読み、この job の終わり (postTurn の宛先解決) まで同じ値を使う。
      // 走っている途中の /roster で「文脈に出ていた相手を呼んだら弾かれた」を起こさないため。
      // スレッド編成が無いチャンネルでは config の既定へ落ちる (src/roster.js)
      const { keys: effectiveRoster, source: rosterSource } = resolveEffectiveRoster(
        roster.get(thread.id),
        resolveChannelRoster(cc),
      );

      // ---- 委譲契約 (T6) ----
      // role がスキーマ種別を宣言していない bot は、ここから下がすべて素通りする
      // (構造化を有効にしていない job の挙動は完全に不変)。codex は --json-schema を
      // 持たないランタイムなので対象外
      // チャンネルが構造化を切っていれば、役割文が宣言していても contractKind は null。
      // 様式が振る舞いを決めるので、成果物へ向かわない場 (雑談) では様式ごと外す。
      // **CLI の --json-schema を落とすだけでは足りない** — 役割文に残る「スキーマで検査する」
      // の指示を実行文脈で打ち消さないと、モデルは報告調のまま返す (sol 指摘 2026-08-14)
      const structuredOutput = resolveStructuredOutputEnabled(cc);
      // スケジューラが起こしたスカウト job だけは、その 1 job のあいだ種別が
      // task-proposal に差し替わる (§3.3)。取り出した時点で消えるので次の job には残らない
      // 目印つきの投稿は**共有枠に触らない** (sol 指摘 2026-08-30) — 順序は
      // resolveJobContractKind が持つ。ここは枠の取り出し方を渡すだけ
      const declaredKind = resolveJobContractKind({
        roleText: ownRoleText,
        runtime: bot.cfg.runtime,
        structuredOutput,
        triggerContent: triggerMsg.content,
        claimSlot: () => claimContractKindOverride(thread.id, bot.key),
      });
      // 案件に結ばれた job は**その 1 job だけ `case-turn`** で返す (S2-3a)。
      // **構造化する job にしか乗せない** — 宣言の無い bot やチャンネルで構造化が始まると
      // 「宣言が無ければ完全に従来どおり」が破れる (スカウトの上書きと同じ約束)
      const contractKind = societyAction && declaredKind ? 'case-turn' : declaredKind;
      // 案件の文脈 (決定権者・自分の Claim と世代・この起動)。台帳を読むだけ
      const societyCase = societyAction && society ? society.caseContext(societyAction.actionId) : null;
      // 承認済みルールを含むチャンネルの実効権限。契約はここから**絞る**ことしかしない
      const baseAllowedTools = resolveAllowedTools(cc, approvedRulesFor(cc));
      // 契約の取り出しは**ランタイムを問わず**行う。codex に絞り込みは効かないが、
      // 取り出して消さないと契約が stale のまま残り、後の job に効いてしまう (sol 指摘)
      const applied = applyIncomingContract({ bot, thread, cc, triggerMsg, baseAllowedTools, claimed });
      if (applied.stop) {
        // **fail-open にしない。** 契約が「触ってよいのはここだけ」と言っているのに
        // 絞り込めないなら、元の権限のまま走らせるのは契約を無視して走るのと同じ
        await editSafe(placeholder, applied.stop.slice(0, 1900)).catch(() => {});
        return 'contract-unenforceable';
      }
      const effectiveAllowedTools = applied.narrowed?.allowedTools ?? baseAllowedTools;
      // **実行文脈と CLI へ渡す値を同じ 1 か所から取る。** 別々に解決すると、実行文脈が
      // 「パス限定」と案内している job が acceptEdits で起動する (照合を迂回するので
      // 一覧の外も書ける) といった食い違いが黙って起きる (sol 指摘 2026-08-03)
      const effectivePermissionMode = applied.narrowed?.permissionMode ?? resolvePermissionMode(cc);

      parts.push(
        buildRuntimeContext({
          selfKey: bot.key,
          displayName: bot.cfg.displayName,
          runtime: bot.cfg.runtime ?? 'claude',
          channelName: cc.channelName,
          cwd: cc.cwd,
          sandbox: resolveCodexSandbox(cc),
          allowedTools: effectiveAllowedTools,
          permissionMode: effectivePermissionMode,
          peers: applyRoster(botEntries(), effectiveRoster),
          rosterSource,
          structuredOutput,
          maxSelfHops: MAX_SELF_HOPS,
          owner: OWNER_TARGETS.length > 0
            ? { userId: OWNER_TARGETS[0].userId, names: OWNER_TARGETS.map((t) => t.displayName) }
            : null,
          handoffFile: handoffFileFor(cc.cwd),
          societyCase,
        }),
      );
      // 契約は実行文脈の**後ろ**に置く。ファイル権限の実範囲は実行文脈にも出る
      // (describeWriteAccess がパス限定の Edit を読む) が、契約ブロックは全件を並べたうえで
      // 「集合の外が要るなら止めて返す」までを言う。
      // 委譲なら依頼ブロック、報告なら検収の照合材料として載る
      if (applied.contract) {
        parts.push(renderForKind(applied.kind, applied.contract, applied.narrowed));
      }
      const roleText = parts.join('\n\n---\n\n');

      const gitBefore = gitStatusSnapshot(cc.cwd);

      let built;
      let res;
      // 実際にランタイムへ渡したテキストの総文字数。role の渡し方がランタイムで違う
      // (claude は system prompt のファイル / codex は本文へ連結) ので、本文だけ数えると
      // role を厚くした分が計測から消え、bot 間の比較も噛み合わない
      let sentChars = 0;
      if (bot.cfg.runtime === 'codex') {
        // codex ランタイム (Sol): セッション永続なし (書込み可否は codexSandbox 次第)。
        // 文脈は毎回スレッド transcript の再構成で渡す (entry=null = 遡り + トリガー以降、
        // 自分の過去発言も含める — resume セッションを持たないため)
        built = await buildPrompt(bot, triggerMsg, thread, null, true);
        // codex exec -i はファイルパスしか受けないので、この経路だけ書き出す
        // (claude は base64 を直接渡せるため一時ファイルを作らない)
        let imagePaths = [];
        if (built.images.length > 0) {
          imageDir = mkdtempSync(join(tmpdir(), 'communitd-img-'));
          imagePaths = writeImageFiles(built.images, imageDir);
        }
        const codexPrompt = `${roleText}\n\n---\n\n${built.prompt}`;
        sentChars = codexPrompt.length;
        res = await runCodex({
          codexCmd: config.codexCmd,
          cwd: cc.cwd,
          model: bot.cfg.model,
          // 隔離 CODEX_HOME の model_reasoning_effort になる (ユーザー ~/.codex/config.toml より優先)。
          // 未指定なら従来どおりユーザー設定を写す — モデルが拒む値を避けるための bot ごとの口
          effort: bot.cfg.effort,
          prompt: codexPrompt,
          imagePaths,
          sandbox: resolveCodexSandbox(cc),
          // 指定した bot だけ Codex 組み込みの指示を差し替える (相談役として使う口)。
          // 未指定の bot は組み込み指示のまま = 従来の振る舞い
          instructionsFile: bot.cfg.codexInstructionsFile
            ? resolve(ROOT, bot.cfg.codexInstructionsFile)
            : null,
          timeoutMs: config.limits?.claudeTimeoutMs ?? 3600000,
          scrubEnvKeys: Object.values(config.bots).map((b) => b.tokenEnv),
          handle,
          onSpawn: (info) => run.spawn(info),
        });
      } else {
        const entry = store.get(thread.id, bot.key);
        const sameCwd = Boolean(entry && entry.cwd === cc.cwd);

        // **検査した内容そのもの**を CLI へ読ませる。元のパスを渡すと、版を確かめてから
        // spawn するまでの間 (transcript の取得・画像の取得を挟む) に role が書き換わり、
        // 新しい role を古いブリッジが読む — 版照合を素通りする窓ができる
        roleDir = mkdtempSync(join(tmpdir(), 'communitd-role-'));
        const rolePromptFile = join(roleDir, 'role.md');
        writeFileSync(rolePromptFile, roleText);

        // hooks: true なら verify 未設定で hook 0 件でも空 settings を実際に渡す。
        // 省略時は null = 一時ファイルも --settings も無し。hooks 以外のキーは
        // buildHookSettings が拒否し、permissions による `--allowedTools` 迂回を封じる。
        const hooksEnabled = resolveHooksEnabled(cc);
        verifyCommand = resolveVerifyCommand(cc);
        // **承認済みルールは job 開始時点のスナップショット** (承認は「次の job から」効く)。
        // hook 経路はこの不変条件の意図的な更新なので、同じ配列を承認ブローカへも渡し、
        // 「既に許可されているものは聞かない」の判定を実際に渡した値で行う。
        // 契約の touch 制限がかかっている job では、絞った後の値がそのまま実効権限になる
        const allowedTools = effectiveAllowedTools;
        let settingsFile;
        if (hooksEnabled) {
          settingsDir = mkdtempSync(join(tmpdir(), 'communitd-settings-'));
          settingsFile = join(settingsDir, 'settings.json');
          // ツール軌跡は hooks を有効にしたチャンネルで常に取る (許可判定は変えない)。
          // 記録先を job 専用ファイルにしておくと、幻セッション復旧のリトライで res が
          // 差し替わっても軌跡は同じファイルへ積み上がる — res に載せると 1 回目が消える。
          traceFile = join(settingsDir, 'tool-trace.jsonl');
          let hooks = buildTraceToolHooks({
            traceFile,
            timeoutMs: TRACE_HOOK_TIMEOUT_MS,
          });

          // 承認のリアルタイム化 (T5): 拒否されうるツールの実行前に hook がブリッジへ
          // 問い合わせ、カードが押されるまで待つ。ブリッジ側の見張りは spawn 前に始める —
          // 後から始めると、その隙に届いた ask を拾えず hook が待ち上限まで空回りする
          const approvalDir = join(settingsDir, 'approvals');
          mkdirSync(approvalDir, { recursive: true });
          const approvalConfigFile = join(settingsDir, 'approval-config.json');
          writeFileSync(
            approvalConfigFile,
            `${JSON.stringify({
              dir: approvalDir,
              waitMs: APPROVAL_WAIT_MS,
              pollMs: APPROVAL_POLL_MS,
            }, null, 2)}\n`,
            'utf8',
          );
          hooks = {
            ...hooks,
            ...buildApprovalPreToolHooks({
              configFile: approvalConfigFile,
              waitMs: APPROVAL_WAIT_MS,
              tools: APPROVAL_HOOK_TOOLS,
            }),
          };
          broker = new ApprovalBroker({
            dir: approvalDir,
            waitMs: APPROVAL_WAIT_MS,
            decide: (ask, { signal }) => decideApproval({
              ask, signal, thread, bot, cc, allowedTools, askLedger, onWaitingChange,
            }),
            onError: (err) => console.error(
              `[tools] 承認ブローカのエラー (thread:${thread.id}): ${err?.message ?? err}`,
            ),
          }).start();

          if (verifyCommand) {
            verifyStateFile = join(settingsDir, 'verify-state.json');
            const verifyConfigFile = join(settingsDir, 'verify-config.json');
            writeFileSync(
              verifyConfigFile,
              `${JSON.stringify({
                command: verifyCommand,
                cwd: cc.cwd,
                stateFile: verifyStateFile,
                maxRetries: resolveVerifyMaxRetries(cc),
                timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
              }, null, 2)}\n`,
              'utf8',
            );
            hooks = {
              ...hooks,
              ...buildVerifyStopHooks({
                configFile: verifyConfigFile,
                timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
              }),
            };
          }

          const hookSettings = buildHookSettings({ enabled: true, hooks });
          // 失敗時は catch へ落として job 自体を失敗させる。hook 無しでの続行はしない。
          writeFileSync(settingsFile, `${JSON.stringify(hookSettings, null, 2)}\n`, 'utf8');
        }

        const claudeOpts = {
          claudeBin: config.claudeBin,
          cwd: cc.cwd,
          model: bot.cfg.model,
          effort: bot.cfg.effort,
          rolePromptFile,
          settingsFile,
          // 契約の touch 制限がある job だけ default へ**狭める**。
          // acceptEdits は Edit(パス) の照合を丸ごと迂回するので、これが無いと
          // 絞り込みが素通りする (実測 2026-08-02 / CLI 2.1.220)
          permissionMode: effectivePermissionMode,
          // 組み込みツールそのものの限定・明示的な拒否・MCP の遮断。
          // 契約が無い job では null / 空 / false なので引数自体が付かない
          tools: applied.narrowed?.tools ?? null,
          disallowedTools: applied.narrowed?.disallowedTools ?? [],
          strictMcp: applied.narrowed?.strictMcp === true,
          // 外部 settings を読ませない (permissions.allow で絞り込みが破れる)。
          // 契約が無い job では null なので従来どおり全 source が効く
          settingSources: applied.narrowed?.settingSources ?? null,
          // role が種別を宣言している bot だけ最終出力をスキーマへ拘束する
          jsonSchema: contractKind ? SCHEMAS[contractKind] : null,
          // 承認済みルールは job 開始時点のスナップショットで渡す
          // (承認は「次の job から」効く — 実行中の job には後出しで足さない。
          // 実行中に効かせる唯一の口が hook 経路で、そちらは --allowedTools を
          // 書き換えるのではなく PreToolUse hook が 1 回ずつ allow を返す)。
          // 承認時と同じ canonical cwd を鍵にするので、cwd を別ツリーへ向け替えた
          // チャンネルでは過去の承認が効かない (fail-closed)
          allowedTools,
          // cwd の外に置いた参照先 (別リポジトリ・共有メモ等) を開く。
          // **--add-dir は読取専用にできない** ので、開けるのは「書かれても git 差分に
          // 出るツリー」だけにする (docs/reference/add-dir.md)。相対パスは cwd 基準で、
          // その cwd は受付時に実体へ固定済み — junction の差し替えに追従させない
          // touch 制限中は 1 つも開かない (--add-dir は読取専用にできない)
          addDirs: applied.narrowed?.addDirs ?? resolveAddDirs(cc),
          timeoutMs: config.limits?.claudeTimeoutMs ?? 3600000,
          maxStdoutBytes: MAX_STDOUT_BYTES,
          scrubEnvKeys: Object.values(config.bots).map((b) => b.tokenEnv),
        };

        // resume できるときだけ自分の過去発言を落とす (セッションが持っているため)。
        // 新規・cwd 不一致の履歴再構築では includeSelf=true — 落とすと自分の過去報告だけが
        // 欠けた文脈で走り、直前に何を返したか分からなくなる
        built = await buildPrompt(bot, triggerMsg, thread, sameCwd ? entry : null, !sameCwd);
        // 実行記録: hooks の有無 (trace が無いことを「何もしなかった」と読まないための印)
        outcome.hooks = hooksEnabled;
        res = await runClaude({
          ...claudeOpts,
          prompt: built.prompt,
          images: built.images,
          sessionId: sameCwd ? entry.sessionId : undefined,
          resume: sameCwd,
          handle,
          onSpawn: (info) => run.spawn(info),
        });

        // 幻セッションからの自己回復: 保存済み sessionId が CLI 側に存在しない場合は
        // entry を破棄し、履歴を遡り直した新規セッションで 1 回だけやり直す
        if (!res.ok && !res.aborted && sameCwd && /No conversation found/i.test(`${res.error ?? ''} ${res.detail ?? ''}`)) {
          // 消せなくても新しいセッションでやり直す (§12.3 (1) / Opus2 レビュー Minor2)。
          // sessions.json が読めないときは entry も読めていないのでここへは来ないが、
          // 書き込み側の失敗 (ディスク・権限) でモデルの再実行ごと落とさない
          try {
            store.delete(thread.id, bot.key);
          } catch (err) {
            console.error(`[session] ${thread.id}:${bot.key} 幻セッションの記録を消せません: ${err?.message ?? err}`);
          }
          // 復旧経路も履歴の再構築なので自分の過去発言を含める
          built = await buildPrompt(bot, triggerMsg, thread, null, true);
          res = await runClaude({
            ...claudeOpts,
            prompt: built.prompt,
            images: built.images,
            resume: false,
            handle,
            onSpawn: (info) => run.spawn(info),
          });
        }
        // role は rolePromptFile 経由で毎ターン渡るので本文と合算する
        sentChars = roleText.length + built.prompt.length;
      }

      // 実際にランタイムへ渡した分を計測ログへ回す (失敗した job でも「何を渡して
      // 失敗したか」が要るので、成否の判定より前に置く)
      metrics.promptChars = sentChars;
      metrics.rolePromptChars = roleText.length;
      metrics.contextMessages = built.contextMessages;
      metrics.omittedMessages = built.omittedMessages;
      // トークンの実消費。渡した文字数と違って**セッションが抱えている履歴**まで含むので、
      // resume の効き方 (cacheRead が伸び続けていないか) はこちらでしか見えない。
      // usage を持たないランタイム (codex) と失敗 job では undefined のまま = 行から落ちる
      if (res.usage) {
        metrics.inputTokens = res.usage.inputTokens;
        metrics.cacheReadTokens = res.usage.cacheReadTokens;
        metrics.cacheWriteTokens = res.usage.cacheWriteTokens;
        metrics.outputTokens = res.usage.outputTokens;
      }
      // ランタイムが返した (成否・中断)。成果の有無は git と trace の側で見る。
      // 進捗表示はここで止める (以降の placeholder は終端の表示なので、tick に上書きさせない)
      await progress.stop();
      run.model({ ok: res.ok === true, aborted: res.aborted === true, error: res.error ?? null });
      // 実行前後の git 差分は「副作用があったか」の最小の証拠 (配送の前に取る — 配送で落ちても残す)。
      // **どちらかが読めなければ null** — 「差分なし」と「読めなかった」を混ぜると、副作用なしの
      // 判定 (自動復旧の門) が読めないだけで通ってしまう
      try {
        const gitAfter = gitStatusSnapshot(cc.cwd);
        outcome.gitChanged = gitBefore === null || gitAfter === null
          ? null
          : diffSnapshots(gitBefore, gitAfter).length > 0;
      } catch { outcome.gitChanged = null; }

      if (res.aborted) {
        await editSafe(placeholder, '⏹ 停止しました (途中変更の有無は git status で確認してください)')
          .catch(() => {});
        return 'aborted';
      }

      if (!res.ok) {
        const detail = res.detail ? `\n\`\`\`\n${res.detail.slice(-800)}\n\`\`\`` : '';
        await editSafe(
          placeholder,
          `❌ ${bot.cfg.displayName} 失敗: ${res.error ?? '実行エラー'}${detail}`.slice(0, 1990),
        ).catch(() => {});
        // 失敗理由はログ側にも残す (タイムアウトと認証エラーを後から区別できるように)
        return `failed(${(res.error ?? '実行エラー').slice(0, 60)})`;
      }

      // モデルが成功した時点でセッションと既読位置を確定する。以降の verify が NG / 停止でも
      // モデルは既に副作用を出しているため、戻すと次ターンで同じ発言が二重に流れるか、
      // 実在する session が分岐する。codex はステートレスなので対象外。
      // **保存できなくても配送は止めない** (§12.3 (1) の後始末)。sessions.json は制御台帳では
      // なく「次も同じセッションを続けるための控え」なので、読めない台帳のせいでモデルの
      // 成果ごと internal-error にすると、失うものの方が大きい。失ったのは継続だけなので
      // 本文の末尾で断る (次の job は新しいセッションで始まる)
      let sessionSaveError = null;
      if (bot.cfg.runtime !== 'codex') {
        try {
          store.set(thread.id, bot.key, {
            sessionId: res.sessionId,
            cwd: cc.cwd,
            lastMessageId: built.lastSeenId,
          });
        } catch (err) {
          sessionSaveError = err?.message ?? String(err);
          console.error(`[session] ${thread.id}:${bot.key} セッションを保存できません: ${sessionSaveError}`);
        }
      }

      // ---- 構造化出力の受け取り (T6) ----
      // **スキーマを渡した job では result がスキーマの JSON 文字列になる** (T0 §4.1) ので、
      // 人間へ出すのは `本文` フィールド。様式に合わなければ素の result へ縮退して
      // 情報は落とさないが、**契約としては使わない** (保存も touch 制限の適用もしない)
      let outgoingText = res.result || '(空応答)';
      let contractOut = null;
      // 案件の 1 ターン。**verify の後**で台帳へ写すので、ここでは受け取るだけ
      let caseTurn = null;
      const contractNotes = [];
      if (contractKind) {
        const checked = validateContract(contractKind, res.structuredOutput);
        if (checked.ok) {
          outgoingText = bodyOf(checked.contract);
          contractOut = { kind: contractKind, contract: checked.contract };
          // 起票はここでボードへ載せ、載ったぶんの承認を reviewer へ頼む。
          // 承認の応答は逆向き — 今回の契約に載っていた id だけをボードへ適用する
          if (contractKind === 'task-proposal') {
            contractNotes.push(await fileProposal({ contract: checked.contract, cc, bot, thread }));
          } else if (contractKind === 'task-approval') {
            contractNotes.push(applyApproval({
              contract: checked.contract,
              // 「今回の契約」= この job を起こした承認依頼。応答側の pending は見ない
              pending: applied.kind === 'task-approval' ? applied.contract?.pending : [],
              cc,
              botKey: bot.key,
            }));
          } else if (contractKind === 'task-review') {
            contractNotes.push(await applyReview({ contract: checked.contract, cc, bot, thread }));
          } else if (contractKind === 'case-turn') {
            // **台帳へ写すのは verify の後** (下の applyTurn)。ここで写すと、verify が
            // 最終 NG でも `outcome: 'ok'` で settle され、次の Action まで積まれる
            // (Opus2 S2-3a レビュー ①)。ここでは契約を持ち回るだけ
            caseTurn = checked.contract;
          } else if (contractKind === 'report') {
            // 裁定と発議は独立 (別の提案について同じ report で両方することがある) —
            // else-if で片方を落とさない
            if (checked.contract.adjudication) {
              contractNotes.push(await applyProposalAdjudication({ contract: checked.contract, bot, thread }));
            }
            if (checked.contract.initiative) {
              contractNotes.push(await raiseProposal({ contract: checked.contract, bot, thread }));
            }
          }
        } else {
          // 計測ログ (src/queue.js) は既知のキーだけを出すので、ここは console へ残す
          console.error(`[contract] ${bot.key}: 様式不履行 — ${checked.reason}`);
          contractNotes.push(
            `⚠️ 構造化出力が様式に合いませんでした (${sanitizeForDisplay(checked.reason, 200)})\n`
            + '  → 本文はそのまま出しています。契約としては扱っていないので、'
            + '委譲の touch 制限や検収の照合には使われません',
          );
        }
      }

      if (sessionSaveError) {
        outgoingText = appendBeforeFooter(
          outgoingText,
          '⚠️ セッションを保存できませんでした (sessions.json が読めない) — 次回は新しいセッションで始まります',
        );
      }

      // 実行後 hook が 1 行ずつ追記したもの (= 実際に実行されたツールだけ。成功も失敗も含む)。
      // verify より前に読むのは、verify を停止した job でも「モデルが何をしたか」は
      // 計測に残す価値があるため。
      const traceSummary = traceFile ? summarizeTrace(readTraceEntries(traceFile)) : null;
      // trace ファイルが読めたか (0 件でも「読めて 0 件」と「そもそも無い」は別)
      outcome.traceReadable = traceFile ? existsSync(traceFile) : null;
      if (traceSummary && traceSummary.total > 0) {
        metrics.toolCalls = traceSummary.total;
        metrics.toolFailures = traceSummary.failed;
        if (traceSummary.readsBeforeFirstEdit !== null) {
          metrics.readsBeforeFirstEdit = traceSummary.readsBeforeFirstEdit;
        }
      } else if (traceSummary) {
        metrics.toolCalls = 0;
      }

      let verifyResult = null;
      if (verifyCommand) {
        const verifyState = readVerifyState(verifyStateFile);
        verifyResult = verifyState?.lastResult ?? null;
        let verifyMs = verifyState?.totalDurationMs;
        let verifyAttempts = verifyState?.attempts;

        // Stop hook が起動しなかった場合も「未検証のまま handoff」にはしない。
        // CLI 契約差や hook 内部エラーを fail-open にせず、ブリッジ側で最終検証を 1 回行う。
        if (!verifyResult || typeof verifyResult.ok !== 'boolean') {
          run.stage('verify');
          verifyResult = await runVerify({
            command: verifyCommand,
            cwd: cc.cwd,
            timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
            scrubEnvKeys: Object.values(config.bots).map((b) => b.tokenEnv),
            handle,
          });
          if (verifyResult.aborted) {
            await editSafe(
              placeholder,
              '⏹ 停止しました (検証は完了せず、途中変更の有無は git status で確認してください)',
            ).catch(() => {});
            return 'aborted';
          }
          verifyMs = verifyResult.durationMs;
          verifyAttempts = 1;
        }

        metrics.verifyMs = verifyMs;
        metrics.verifyPassed = verifyResult.ok ? 1 : 0;
        metrics.verifyAttempts = verifyAttempts;
      }

      // 案件の 1 ターンを台帳へ写す (S2-3a)。**verify の後**でなければならない —
      // 検証が通っていない成果を `outcome: 'ok'` で確定し、次の Action まで積んでしまう。
      // NG のときは bot が書いた `next` を使わず「verify が通るまで待ち」へ倒す
      if (caseTurn && society && societyAction) {
        const written = society.applyTurn(societyAction.actionId, caseTurn, { verifyResult });
        contractNotes.push(...written.notes);
        outcome.societySettled = written.settled;
      }

      // 注意: メッセージ「編集」は messageCreate を発火しないため、結果は必ず新規
      // メッセージとして送る (bot 間メンション委譲のトリガー経路を保つ)。
      // placeholder は配信が確定してから消す。先に消すと、送信に失敗したときに
      // 「⚙️ 作業中…」すら残らず、失敗を伝える手段が無くなる
      run.stage('deliver');
      const posted = await postTurn(
        thread, bot, cc, res, gitBefore, placeholder, effectiveRoster,
        {
          verifyResult, traceSummary, askLedger, outgoingText, contractOut, contractNotes, run,
          // verify が最終 NG のとき、元の handoff の代わりに戻す先 (§12.3 (3))
          issuerBotKey: issuerBotKeyOf(triggerMsg, claimed),
          // 案件付きの job では自由文の handoff を実行しない (次の起動は next.plan から)
          societyAction,
        },
      );
      // 終わり方の文脈を実行記録へ (次に誰が動くかは finish が決める)
      outcome.handoff = posted.handoff ?? null;
      outcome.taskSubmitted = posted.taskSubmitted === true;
      outcome.taskState = board?.findByThread(thread.id)?.state ?? null;
      if (posted.delivered) {
        await placeholder.delete().catch(() => {});
        return verifyResult && !verifyResult.ok ? 'verify-failed' : 'ok';
      }
      await editSafe(
        placeholder,
        `❌ ${bot.cfg.displayName}: 投稿に失敗したため次の担当を呼んでいません\n` +
          `${posted.failures.join('\n')}`.slice(0, 1500),
      ).catch(() => {});
      return 'deliver-failed';
    } catch (err) {
      // 予期しない throw を Discord に可視化する (無通知の ⚙️ 放置を防ぐ)
      // 並走時にどの job のログか追えるよう bot キーとスレッド ID を必ず添える
      console.error(`[${bot.key} thread:${thread.id}] job 内部エラー`, err);
      await editSafe(placeholder, `❌ ${bot.cfg.displayName} 内部エラー: ${String(err).slice(0, 500)}`)
        .catch(() => {});
      // ここで throw を握るので、終了理由も自分で返す (返さないと ok として記録される)
      return 'internal-error';
    } finally {
      clearInterval(typing);
      // 進捗表示のタイマーも必ず解く (モデルが返る前に抜ける経路 = 起動前の失敗・停止)
      await progress.stop();
      // **一時ディレクトリを消す前に**待っている hook を畳む。成功・失敗・中断の
      // どの経路もここを通るので、待機の後始末はこの 1 か所で足りる
      broker?.stop();
      for (const [label, dir] of [
        ['一時画像', imageDir],
        ['role スナップショット', roleDir],
        ['settings スナップショット', settingsDir],
      ]) {
        if (!dir) continue;
        try { rmSync(dir, { recursive: true, force: true }); }
        catch (err) { console.error(`[${bot.key}] ${label}の削除に失敗: ${err.message}`); }
      }
    }
  }

  return { runJob, waitForThreadQuiet };
}
