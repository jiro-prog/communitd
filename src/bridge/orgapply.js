// ---- org-apply の配線 (docs/social-engineering.md §3.9) ----
//
// 判断は src/apply.js、実行は src/orgapply.js、順序は src/orgapply-wiring.js が持つ。
// ここが持つのは**実体の解決だけ** — git・fs・verify・Discord・起動中の bot。
//
// **起動点は sweepProposals の 1 経路だけ。** 採択ボタンの直後にフックを足すと、
// 「押した瞬間」と「tick」の 2 つの入口ができて、排他の外で二重に始まりうる。

/** 適用回路が動くときの記録者。人ではないので bot キーではなくブリッジを名乗る */
export const APPLY_BY = 'bridge';

/**
 * 全 bot に前置される共通規定 (リポジトリ相対)。
 * 絶対パスの正本は `src/index.js` の `COMMON_ROLE_PATH` — ここは適用後の内容を
 * 検証するための**リポジトリ相対**の綴りが要るだけなので、同じ場所を指す定数を持つ。
 */
export const COMMON_ROLE_FILE = 'roles/_common.md';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  POLICY_FILE,
  SECRET_KEYS,
  channelConfigForName,
  mergeConfigSources,
  resolveApplyChannel,
  resolveAutonomy,
  resolveVerifyCommand,
  validateConfig,
} from '../config.js';
import { readContractKind } from '../contract.js';
import { sendSafe, taskThreadName } from '../mentions.js';
import {
  applyBranchFor,
  applyCandidates,
  reclaimStaleApplies,
  resumeApplyTrials,
  sweepApplyCandidates,
} from '../orgapply-wiring.js';
import { checkRoleProtocol } from '../protocol.js';
import { samePathLoose } from '../repopath.js';
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

/**
 * 起動時検証が返した行を 1 つの理由にまとめる。
 *
 * **ここを抜けた先で切られる。** 台帳の試行記録は `brief(reason, 300)`
 * (src/orgapply-wiring.js)、Discord は `sanitizeForDisplay(reason, 400)` で、どちらも
 * 改行を空白へ畳む — 行数が多いと最初の数行しか読めない。**全文はブリッジのログに出す**
 * (呼び出し側が console.error する)。
 */
export function policyErrorReason(errors) {
  return '適用後の設定は起動時検証を通りません:\n'
    + errors.map((e) => `- ${e}`).join('\n');
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
 * @param {typeof runVerify} [deps.runVerifyImpl] verify の実体 (テストから差し替える)
 */
export function createOrgApplyWiring({
  config, root: ROOT, proposals, board, bots, hops, findGuildChannel,
  safeProposalContext, resolveApplyBaseCommit, postToProposal, requestReview,
  runVerifyImpl = runVerify,
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
   * 走っている適用の verify。**同時 1 件しか無い** (`sweepOrgApply` の in-flight ガードと
   * `withApplyLock` が保証する) ので 1 つで足りる。走っていなければ null。
   */
  let verifyHandle = null;
  /** 停止が始まったか。**以後は適用そのものを始めない** (下の abortVerify を見ること) */
  let stopRequested = false;

  /**
   * 走っている適用の verify を撃ち、**適用回路の門を閉じる** (ブリッジの停止経路から呼ぶ)。
   *
   * **適用回路は job ではない** — tick から走るので `/stop` の `selectForStop` にも
   * `waitForJobsDrained` にも見えない。ここを配線しないと、停止しても `npm test` の
   * 子ツリーが自前の 10 分タイムアウトまでブリッジより長生きする
   * (docs/reference/security-model.md の「ツリーごと止める」がこの経路だけ嘘になる)。
   *
   * 撃った後は**次の tick で適用を始めない**。tick は `lifecycle.beginShutdown()` を見て
   * いない (あれが止めるのは job の受付だけ) ので、門を閉じないと停止の合図から exit までの
   * 数秒で task・スレッド・作業ツリー・コミットまで作ってから verify で即失敗し、
   * 提案の試行を 1 回食う (Opus2 指摘 2026-09-12 M3)。
   *
   * @returns {boolean} 走っている verify を撃ったなら true
   */
  function abortVerify() {
    stopRequested = true;
    const handle = verifyHandle;
    if (!handle) return false;
    handle.abort?.();
    return true;
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
      validateApplied: (input) => validateAfterApply(input),
      verify: async (cwd) => {
        if (!command) return { ok: false, detail: 'verify 未設定 (検証できない適用は記録しません)' };
        // **handle は runVerify を呼ぶ前に登録する。** runVerify は Promise の executor の
        // 中で同期的に `handle.abort` を生やすので、この代入から先は停止を撃てる
        const handle = { stopRequested };
        verifyHandle = handle;
        let out;
        try {
          out = await runVerifyImpl({
            command,
            cwd,
            timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
            scrubEnvKeys: Object.values(config.bots).map((b) => b.tokenEnv),
            handle,
          });
        } finally {
          if (verifyHandle === handle) verifyHandle = null;
        }
        // 中断は「落ちた」ではなく「確かめていない」。**どちらも receipt は作らない**が、
        // 読んだ人が再適用してよいか判断できるように理由は言い分ける。
        // `aborted` を立てるのは、実行層が「verify に通りませんでした: 停止指示により中断」
        // という二重否定にしないため (Opus2 指摘 2026-09-12 m2)
        if (out?.aborted === true) {
          return {
            ok: false,
            aborted: true,
            detail: '停止指示により中断しました (ブリッジの停止 — 当てた結果は記録しません)',
          };
        }
        // 成功した検証の出力は receipt に載せない (台帳が肥る)。落ちた理由だけ残す
        return { ok: out.ok === true, detail: out.ok === true ? '' : verifyFailureDetail(out) };
      },
      listWorktrees: async () => parseWorktreeList(await runGit(ROOT, ['worktree', 'list', '--porcelain'])),
      listBranches: async () => parseBranchList(
        await runGit(ROOT, ['branch', '--list', '--format=%(refname:short)']),
      ),
    };
  }

  /**
   * `applied` の中から、そのパスに当たるキーを探す。
   *
   * **綴りは提案側と同じ緩さで照合する** (`src/proposals.js` の checkTouchPath と同じ
   * `samePathLoose`) — 大小文字だけ違う綴りで書かれた diff は、Windows では同じファイルへ
   * 当たるのにこの検証だけ素通りする、という抜け道を残さない。
   */
  const appliedKeyFor = (applied, path) =>
    Object.keys(applied ?? {}).find((p) => samePathLoose(p, path));

  /**
   * **書く前に、適用後の設定を起動時と同じ手順へ通す。**
   *
   * 当たること (diff が基点へきれいに当たる) と、通ること (合成して検証を抜ける) は別物。
   * 通らない設定が枝に載って merge されると、**次の起動が exit 1 で止まる** —
   * ラッパー (scripts/run.mjs) は 42 以外で再起動しないので、そこで社会ごと動かなくなる。
   * verify (`npm test`) はブリッジの設定を読まないので、この穴は verify では塞がらない。
   *
   * **見るのは policy だけではない。** 起動時検証は役割文のスキーマ宣言も読む
   * (`validateStructuredRoles`) ので、`roles/*.md` から宣言を消す提案も同じ exit 1 を作れる
   * (Opus2 指摘 2026-09-12 M2)。policy か、いずれかの bot の `rolePromptFile` に当たる
   * ファイルを含む適用を対象にする。
   *
   * **読む先は「適用後の内容」。** `applied` にあればその内容、無ければ**基点**
   * (`readBase` = 枝の `git show <基点>:<パス>`)。ROOT の作業ツリーは読まない —
   * 適用は基点の内容へ当てるので、突き合わせる相手も基点でなければ、同じ diff で
   * 役割文を新設する提案 (role-create) が「宣言が無い」と偽に落ちる
   * (Fable の疑い → Opus2 が再現、M1)。
   *
   * **基点の policy が「読めない」と「壊れている」は別。** 読めないのは policy を追跡して
   * いない配備 (公開スナップショットを写した形) なので走っている config で代用するが、
   * 読めたのに組めないなら**その場で落とす** — 基点が壊れていれば次の起動はどのみち
   * 落ちるので、その上に当て続けない (Fable 裁定 / Opus2 指摘 2026-09-12 Major)。
   */
  async function validateAfterApply({ applied = {}, readBase = async () => null } = {}) {
    const readBaseSafe = async (path) => {
      try {
        const text = await readBase(path);
        return typeof text === 'string' ? text : null;
      } catch {
        return null; // 基点に無い (create の前提) / 読めない
      }
    };
    /** 落とす。**全文はログにしか残らない** (台帳 300 字 / 表示 400 字で畳まれる) */
    const reject = (reason) => {
      for (const line of String(reason).split('\n')) {
        console.error(`[org-apply] 適用後の設定が検証を通りません: ${line}`);
      }
      return { ok: false, reason };
    };

    // ---- 1. 適用後の設定を組む ----
    const policyPath = appliedKeyFor(applied, POLICY_FILE);
    const touchesPolicy = policyPath !== undefined;
    // 既定は**走っている合成済み config** (基点から policy を読めない配備のため)
    let merged = config;
    if (touchesPolicy) {
      const after = applied[policyPath];
      if (after === null) {
        return reject(`${POLICY_FILE} を消す提案は当てません (設定が無いと次の起動が落ちます)`);
      }
      const composed = composePolicy(after);
      if (!composed.ok) return reject(composed.reason);
      merged = composed.config;
    } else {
      const baseText = await readBaseSafe(POLICY_FILE);
      if (baseText !== null) {
        const composed = composePolicy(baseText);
        if (!composed.ok) return reject(`基点の ${POLICY_FILE} が壊れています — ${composed.reason}`);
        merged = composed.config;
      }
    }

    // ---- 2. 検証が要る適用か ----
    // 役割文は bot ごとの `rolePromptFile` と、**全員に前置される共通規定**。
    // 共通規定は誰の rolePromptFile でもないので、名指しで対象へ入れないと素通りする
    // (壊れると全 bot の job が止まる — Opus2 指摘 2026-09-12 Minor)
    const roleFiles = [
      COMMON_ROLE_FILE,
      ...Object.values(merged?.bots ?? {}).map((b) => b?.rolePromptFile),
    ].filter((f) => typeof f === 'string' && f.trim() !== '');
    const touchesRole = roleFiles.some((f) => appliedKeyFor(applied, f) !== undefined);
    if (!touchesPolicy && !touchesRole) return { ok: true };

    // ---- 3. 役割文を「適用後の内容」で読む ----
    // `validateConfig` の contractKindOf は同期なので、**先に全部読んでおく**。
    // 同じ本文でプロトコル版と**適用後に在るか**も見る — どちらも起動時検証は通るのに、
    // merge 後はその bot の job が protocol-mismatch / role-unreadable で起動しなくなる
    // (src/bridge/job.js)
    const kinds = new Map();
    const roleErrors = [];
    /**
     * 適用後のその役割文。**「この適用が消す」と「基点に無い」を分ける** —
     * 前者は提案が壊しているので落とし、後者は寛容にする (policy も roles も追跡して
     * いない配備を止めない)。
     */
    const roleTextOf = async (file) => {
      const hit = appliedKeyFor(applied, file);
      // 消す提案は基点へ落とし直さない — 消えているのが適用後の姿
      if (hit !== undefined) return { text: applied[hit], deleted: applied[hit] === null };
      return { text: await readBaseSafe(file), deleted: false };
    };
    const checkRoleFile = ({ text, deleted }, where, lost) => {
      // 消えた役割文は job.js が読めずに role-unreadable で止まる。起動時検証は
      // 「ファイルがあるか」を見ないので (config.js は fs を持たない)、ここで落とす
      if (deleted) {
        roleErrors.push(`${where} が適用後に存在しません (${lost})`);
        return;
      }
      if (typeof text !== 'string') return; // 基点にも無い = 寛容 (追跡していない配備)
      const proto = checkRoleProtocol(text);
      if (!proto.ok) roleErrors.push(`${where}: ${proto.reason}`);
    };

    checkRoleFile(
      await roleTextOf(COMMON_ROLE_FILE),
      COMMON_ROLE_FILE,
      '全 bot の job が起動できなくなります',
    );
    for (const [key, bot] of Object.entries(merged?.bots ?? {})) {
      const file = bot?.rolePromptFile;
      if (typeof file !== 'string' || file.trim() === '') {
        kinds.set(key, null);
        continue;
      }
      const role = await roleTextOf(file);
      kinds.set(key, typeof role.text === 'string' ? readContractKind(role.text) : null);
      checkRoleFile(
        role,
        `bots.${key} の役割文 ${file}`,
        `この bot の job が起動できなくなります — bot ごと退けるなら同じ提案で bots.${key} も消してください`,
      );
    }

    const errors = [
      ...validateConfig(merged, {
        contractKindOf: (botKey) => kinds.get(botKey) ?? null,
        repoRoot: ROOT,
      }),
      ...roleErrors,
    ];
    if (errors.length === 0) return { ok: true };
    return reject(policyErrorReason(errors));
  }

  /**
   * policy の本文を、**今の secrets と合成した検証用の config** にする。
   *
   * secrets は今動いている config から取り直す — 合成済み config から `SECRET_KEYS` を
   * 抜けば元の secrets と同じ形になるので、ファイルを読み直さない (src/config.js は fs を
   * 持たない方針で、秘密を二度メモリへ載せる理由も無い)。
   */
  function composePolicy(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'policy を読めません' };
    let policy;
    try {
      policy = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `適用後の ${POLICY_FILE} を JSON として読めません: ${err.message}` };
    }
    const secrets = {};
    for (const key of SECRET_KEYS) {
      if (config[key] !== undefined) secrets[key] = config[key];
    }
    const merged = mergeConfigSources(policy, secrets);
    if (merged.errors.length > 0) return { ok: false, reason: policyErrorReason(merged.errors) };
    return { ok: true, config: merged.config };
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
    // **停止が始まったら、もう始めない。** 撃てるのは走っている verify だけで、
    // 新しく始めた適用は exit までに終わらない (abortVerify を見ること)
    if (stopRequested) return;
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

  return {
    sweepOrgApply,
    releaseApplyWorktree,
    applyChannelConfig,
    createApplyThread,
    reportOrgApply,
    // 停止経路 (src/bridge/shutdown.js) と、実体の解決を見るテストが呼ぶ
    abortVerify,
    orgApplyDeps,
  };
}
