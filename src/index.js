// ブリッジの起動点 = 組み立てだけを持つ (composition root)。
// 設定を読んで検証し、台帳 (data/*.json) と Discord client を作り、src/bridge/*.js の配線を
// 依存注入で組み合わせて、タイマーとシグナルを張る。**判断はここに書かない** —
// 判断は src/*.js の純粋関数、順序と結線は src/bridge/*.js (どちらもテストから偽の依存で呼べる)。
//
// 組み立ての順序は起動時のログの順序でもある: 設定 → 記録 → 承認台帳 → 上限 → 発議 → キュー →
// pause → hops → bot の起動 → スケジューラ → 復旧 → tick → 配線 → コマンド。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalRegistry } from './approvals.js';
import { resolveLimits } from './attachments.js';
import { TaskBoardStore, tasksMissingTouch } from './board.js';
import { createBoardWiring } from './bridge/board.js';
import { createContractWiring } from './bridge/contracts.js';
import { createDiscordWiring, snowflakeAt } from './bridge/discord.js';
import { createJobRunner } from './bridge/job.js';
import { createMessageWiring } from './bridge/messages.js';
import { createOrgApplyWiring } from './bridge/orgapply.js';
import { createPromptBuilder } from './bridge/prompt.js';
import { createProposalWiring } from './bridge/proposals.js';
import { createJobQueueWiring } from './bridge/queue.js';
import { createRecoveryWiring } from './bridge/recovery.js';
import { createRunRecorder, reconcileJobRunsOnStartup } from './bridge/recorder.js';
import { AUTONOMY_TICK_MS, createSchedulerWiring, createTickLedger } from './bridge/scheduler.js';
import { RESTART_DRAIN_MS, createShutdownWiring } from './bridge/shutdown.js';
import { collectThreadPosts, createSocietyWiring, societyStartupLine } from './bridge/society.js';
import { createToolApprovalWiring } from './bridge/tools.js';
import { createTurnWiring } from './bridge/turn.js';
import {
  POLICY_FILE,
  SECRETS_FILE,
  channelConfigForName,
  isInitiativeEnabled,
  loadConfigSources,
  resolveAutonomy,
  resolveDutyBots,
  resolveExecBotKeys,
  resolveMaxBotHops,
  resolveMaxSelfHops,
  resolveMaxToolApprovalCards,
  resolveOwnerTargets,
  resolveStructuredOutputEnabled,
  resolveToolApprovalTtlMs,
  resolveToolApprovalWaitMs,
  resolveTranscriptCharBudget,
  validateConfig,
} from './config.js';
import { readContractKind } from './contract.js';
import { HopTracker } from './hops.js';
import { InboxStore } from './inbox.js';
import { createInteractionHandler, createLifecycle } from './interactions.js';
import { JobRunStore } from './jobruns.js';
import { sendSafe } from './mentions.js';
import { ProposalStore } from './proposals.js';
import { JobQueue } from './queue.js';
import { RecoveryStore } from './recovery.js';
import { RosterStore, resolveEffectiveRoster } from './roster.js';
import { isSocietyEnabled, resolveSociety } from './society-policy.js';
import { SocietyStore } from './society-store.js';
import { formatStatus, summarizeStatus } from './status.js';
import {
  ContractStore, PauseStore, SessionStore, TickStateStore, brokenLedgers, formatBrokenLedgers,
} from './store.js';
import { formatJst } from './time.js';
import { DOMAIN_TOOLS, sanitizeForDisplay } from './toolrules.js';
import { ToolExtraStore } from './toolstore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 全 bot の前段に付く共通規定 (制御フッター・停止契約・Discord 運用)。
// bots.*.rolePromptFile は「その bot 固有の職務」だけを持つ
const COMMON_ROLE_PATH = resolve(ROOT, 'roles', '_common.md');
// 設定は git 管理の policy と gitignore の secrets に分かれている (src/config.js)。
// ここで 1 つの内部 config へ合成する — 以降のコードは分離前と同じ 1 枚の config を見る
const { config: loadedConfig, errors: loadErrors } = loadConfigSources({
  policyPath: resolve(ROOT, POLICY_FILE),
  secretsPath: resolve(ROOT, SECRETS_FILE),
  readFile: (p) => readFileSync(p, 'utf8'),
});

// 起動時 config 検証 (fail-closed)。Discord へ繋ぐ前に落とす —
// 設定漏れが「全 Guild・全ユーザー許可」や暗黙の権限昇格にならないようにする。
// 読み込み・合成で落ちたときは検証まで進めない (config が無い状態の二次エラーで
// 「ファイルが 1 つ無いだけ」という本当の原因が埋もれる)
// 発議に関わる bot が構造化出力を返せるかは**役割文を読まないと分からない**ので、
// 読み手を注入する (src/config.js はファイルを触らない)。読めない役割文は
// 「宣言なし」として扱う — job の起動時に role-unreadable で落ちる方が原因が分かる
// **これは起動時の検証専用。** org-apply は同じ判定を「適用後の内容」に対して行う必要が
// あり (基点の役割文・同じ diff で新設される役割文)、読む場所ごと違うので
// src/bridge/orgapply.js が自前で持つ — ここを渡し回さない
const contractKindOf = (botKey) => {
  const file = loadedConfig?.bots?.[botKey]?.rolePromptFile;
  if (typeof file !== 'string' || file === '') return null;
  try {
    return readContractKind(readFileSync(resolve(ROOT, file), 'utf8'));
  } catch {
    return null;
  }
};
const configErrors = loadErrors.length > 0
  ? loadErrors
  : validateConfig(loadedConfig, { contractKindOf, repoRoot: ROOT });
if (configErrors.length > 0) {
  for (const line of configErrors) console.error(`[config] ${line}`);
  console.error(
    `${POLICY_FILE} / ${SECRETS_FILE} を直してから起動してください ` +
      '(詳細は SETUP.md / docs/reference/security-model.md)',
  );
  process.exit(1);
}
const config = loadedConfig;

const store = new SessionStore(resolve(ROOT, 'data', 'sessions.json'));

// スレッド別の編成 (/roster)。未設定のスレッドは制限なし。
// 実行文脈の生成側と handoff の宛先解決側の**両方**へ同じ allowlist を通す —
// 片方だけだと「文脈に出ないのに呼べる」「呼べないのに文脈には出る」になる
const roster = new RosterStore(resolve(ROOT, 'data', 'roster.json'));

// 裁定の受信箱 (docs/social-engineering.md §10)。台帳を持つのは記録の無かった
// 停止通知だけで、稟議 (proposals) と要人間 (board) は /inbox の描画時に読む。
// **ファイルは最初の [[notify:owner]] が届いたときに初めて書かれる** (JsonStore は
// 構築では書かない) ので、通知を使わない配備に data/inbox.json は生えない
const inbox = new InboxStore(resolve(ROOT, 'data', 'inbox.json'));

// ---- 委譲契約 (T6) ----
// role が `<!-- communitd-schema: ... -->` を宣言している bot だけが構造化出力を返し、
// 委譲契約はここに積まれて**呼ばれた相手の次の 1 job** にだけ効く。
// 宣言の無い bot・チャンネルは完全に従来どおり動く (構造化を有効にしない限り不変)。
const contracts = new ContractStore(resolve(ROOT, 'data', 'contracts.json'));

// ---- 実行記録 (docs/implementation-plan.md P1) ----
// job 1 本がどこまで進んだか (受付 → 起動 → モデル → 承認待ち → 検証 → 配送 → 終端) と、
// どう終わったかの台帳。task の状態 (board) とは別の正本で、同じ値を両方で編集しない。
// **受付の記録に失敗した job は起動しない** (記録の無い job は復旧の判断から漏れる)。
// 実行後の記録に失敗したら「結果不明」として残し、自動復旧は止まる (P4)。
const jobRuns = new JobRunStore(resolve(ROOT, 'data', 'job-runs.json'));
reconcileJobRunsOnStartup(jobRuns);
// runJob / runItem から実行記録へ書く口 (src/bridge/recorder.js)
const runRecorder = createRunRecorder({ jobRuns });

// ---- ツール権限の申請と承認 ----
// エージェントは申請しかできない。承認は allowedUserIds の人間が Discord のボタンで行い、
// 承認ぶんは config.json ではなく data/tools-extra.json へ積む (手書きの正本を機械が
// 書き換えない)。
//
// 経路は 2 つある:
//   1. job 終了後 — 結果 JSON の permission_denials を 2 段階カードにする。効くのは**次の job から**
//   2. job 実行中 (hooks: true のチャンネルだけ) — PreToolUse hook がブリッジへ問い合わせ、
//      **カードが押されるまで job を止めて待つ**。押されたら同じ job がそのまま続行する
//
// 2 は 2026-07-31 に「実行中の job を止めて待つ MCP ブローカは Phase 2 送り」と裁定された
// ものの実装 (T5)。**MCP ブローカではなく PreToolUse hook で成立した** —
// hook は 60 秒以上ブロックでき、allow が実際に権限を付与する (T0 §1.4 実測 2026-08-02)。
// これに伴い「承認済みルールは job 開始時点のスナップショット」という不変条件は、
// hook 経路にかぎり意図的に更新される (下の runJob の allowedTools と src/broker.js)。
const toolExtra = new ToolExtraStore(resolve(ROOT, 'data', 'tools-extra.json'));
// 1 job で出す承認カードの上限 (拒否が連発したときにスレッドを埋めない)
const MAX_APPROVAL_CARDS = resolveMaxToolApprovalCards(config);
// hook 経路で job を止めて待てる上限。**待っている間は同じ cwd のレーンを占有し続ける**
const APPROVAL_WAIT_MS = resolveToolApprovalWaitMs(config);
// 承認待ちにできるツール = grant を作れるもの (ドメイン限定) だけ。
// 全ツールを対象にすると、hook が無くても通る呼び出しにまでカードが出る
const APPROVAL_HOOK_TOOLS = Object.keys(DOMAIN_TOOLS);
const approvals = new ApprovalRegistry({ ttlMs: resolveToolApprovalTtlMs(config) });
setInterval(() => approvals.sweep(), 5 * 60 * 1000).unref?.();

const MAX_HOPS = resolveMaxBotHops(config);
// 自己呼び出しは相手の検収を挟まないので、bot 間の往復とは別枠でもっと短く数える
const MAX_SELF_HOPS = resolveMaxSelfHops(config);
const FETCH_LIMIT = Math.min(config.limits?.transcriptFetchLimit ?? 80, 100);
// 文脈に載せる遡り分の文字数上限。**日常的に効かせるための値ではなく暴発防止の安全弁**
// (2000 字の発言が FETCH_LIMIT 件並ぶと prompt が十数万字になる)。既読差分とトリガー
// 以降は対象外 — 落とすと恒久欠落するため (src/transcript.js)
const TRANSCRIPT_CHAR_BUDGET = resolveTranscriptCharBudget(config);
// スレッド静止待ち: 人間の投稿がこの窓の間途切れるまで job 開始を遅らせる / 総待機上限
const QUIET_WINDOW_MS = config.limits?.quietWindowMs ?? 3000;
const QUIET_WAIT_MAX_MS = config.limits?.quietWaitMaxMs ?? 15000;
// 添付の上限 (画像・テキストそれぞれの件数/サイズ、文字数、取得タイムアウト)。
// 既定は attachments.js 側の DEFAULT_LIMITS
const ATTACHMENT_LIMITS = resolveLimits(config.limits?.attachments);
const MAX_STDOUT_BYTES = config.limits?.maxStdoutBytes ?? 64 * 1024 * 1024;

// 人間 (作者) への通知先。未設定なら [[notify:owner]] は実行されない
const OWNER_TARGETS = resolveOwnerTargets(config);
console.log(
  OWNER_TARGETS.length > 0
    ? `[owner] [[notify:owner]] → <@${OWNER_TARGETS[0].userId}> (呼び名: ${OWNER_TARGETS.map((t) => t.displayName).join(' / ')})`
    : '[owner] ownerUserId 未設定 — [[notify:owner]] は実行されません (SETUP.md §0)',
);

// 上限と既定値の束。配線 (src/bridge/*.js) には config そのものではなくこれを渡す —
// どの上限がどこで効くかを 1 か所で読めるようにするため
const limits = Object.freeze({
  maxApprovalCards: MAX_APPROVAL_CARDS,
  approvalWaitMs: APPROVAL_WAIT_MS,
  approvalHookTools: APPROVAL_HOOK_TOOLS,
  maxHops: MAX_HOPS,
  maxSelfHops: MAX_SELF_HOPS,
  fetchLimit: FETCH_LIMIT,
  transcriptCharBudget: TRANSCRIPT_CHAR_BUDGET,
  quietWindowMs: QUIET_WINDOW_MS,
  quietWaitMaxMs: QUIET_WAIT_MAX_MS,
  attachments: ATTACHMENT_LIMITS,
  maxStdoutBytes: MAX_STDOUT_BYTES,
});

// ---- 組織提案 (docs/social-engineering.md §3.9) ----
// initiative が有効なチャンネル設定でだけ台帳を持つ (使わない配備で data/proposals.json を作らない)。
const INITIATIVE_ENABLED = isInitiativeEnabled(config);
const EXEC_BOT_KEYS = resolveExecBotKeys(config);
const proposals = INITIATIVE_ENABLED
  ? new ProposalStore(resolve(ROOT, 'data', 'proposals.json'))
  : null;
console.log(
  INITIATIVE_ENABLED
    ? `[proposals] 発議機構: 有効 (org は作者が裁定 / work・process は ${EXEC_BOT_KEYS.join(' / ') || '(未設定 = 誰も裁定できません)'})`
    : '[proposals] 発議機構: 無効 (initiative.enabled が true ではありません)',
);

/**
 * duty を持つ bot (§3.8)。**起動時に 1 回だけ解決する** — 巡回の宛先は
 * policy の静的な記述で、job の途中で動くものではない (動かすには `duty-edit`
 * 提案が採択され、適用されて、プロセスが上がり直す)。
 */
const DUTY_BOTS = resolveDutyBots(config);
if (INITIATIVE_ENABLED) {
  console.log(
    DUTY_BOTS.length > 0
      ? `[proposals] duty: ${DUTY_BOTS.map((b) => `${b.botKey} (${b.duties.map((d) => d.key).join(' / ')} / 日次 ${b.initiativeBudget} job)`).join(' | ')}`
      : '[proposals] duty を持つ bot がありません — 定期巡回とイベント経由の発議は起きません '
        + '(report の initiative だけが動きます)',
  );
}

// ---- cwd レーン単位のキュー ----
// 同じ作業ツリー (Unity editor のようなロック付き資源・git ワーキングツリー) を
// 2 job が同時に触らないよう cwd ごとに直列化し、cwd が違うチャンネルは並走させる。
// 全レーン合計の同時実行は limits.maxConcurrentJobs で絞れる (未設定 = 無制限)。
const jobs = new JobQueue({ maxConcurrent: config.limits?.maxConcurrentJobs ?? 0 });
console.log(
  `[queue] cwd レーンごとに直列 / 同時実行上限: ${jobs.maxConcurrent || '無制限'}`,
);

// ---- 自律運転の kill switch (/pause・/resume) ----
// **再起動をまたいで残す。** プロセスを立て直したら勝手に動き出す作りだと、
// 止めた理由が残っているのに社会が動き出す (docs/social-engineering.md §3.7)
const pauseStore = new PauseStore(resolve(ROOT, 'data', 'pause.json'));
if (pauseStore.broken) {
  // 読めない = 「止めていない」ではない (§12.3 (1))。退避もしないので、次の起動でも同じ判断になる
  console.error(
    `[pause] pause.json が読めません (${pauseStore.broken.reason}) — **停止扱いで起動します**。`
    + '/resume では解けません (台帳を直すか手で退避してください)',
  );
} else if (pauseStore.paused) {
  const state = pauseStore.current();
  console.log(
    `[pause] 自律運転は停止中のまま起動しました (${formatJst(state.at) ?? '時刻不明'} / by ${state.by ?? '不明'}`
    + `${state.reason ? ` / ${state.reason}` : ''}) — 再開は /resume`,
  );
}

// ---- bot 間ループガード (人間の発言でリセット) ----
const hops = new HopTracker(MAX_HOPS, MAX_SELF_HOPS);
console.log(
  `[hops] bot 間の連続ホップ上限: ${MAX_HOPS} / 連続自己呼び出し上限: ${MAX_SELF_HOPS}`
  + ' (どちらも人間の発言でリセット)',
);

// ---- 再起動・停止 ----
// 実体は src/bridge/shutdown.js (終了コード 42 → scripts/run.mjs が再起動する)。
// 停止・再起動の進行状態 (受付停止と shutdown の再入防止)
const lifecycle = createLifecycle();

// ---- bot registry ----
const bots = new Map(); // botKey → { key, cfg, client, userId }
// Discord の実体 (client 群の起動・チャンネルとユーザーの解決・運用メッセージの投稿)
const discord = createDiscordWiring({ config, bots });

discord.loginBots({
  // ハンドラは関数で渡す — この時点では残りの配線を組み終えていない (イベントが届くのは全部組み終えた後)
  onMessage: (bot, msg) => messages.onMessage(bot, msg),
  onInteraction: (bot, interaction) => onInteraction(bot, interaction),
  announceRestartComplete: () => shutdownWiring.announceRestartComplete(),
});


if (bots.size === 0) {
  console.error('起動できる bot がありません (.env を確認)');
  process.exit(1);
}

// ready が揃わない bot がいても完了通知が出ないままにならないための保険
setTimeout(() => void shutdownWiring.announceRestartComplete(), 60000).unref?.();

// ---- 自律運転のスケジューラ (docs/social-engineering.md §3.1) ----
//
// **新しい実行経路を作らない。** ここがするのは「スレッドを作って起動メッセージを
// 投稿する」ところまでで、以降は人間がメンションしたときと同じ MessageCreate →
// enqueue の回路がそのまま動く (authz・契約・hop・verify が全部効いたまま)。
// **enqueue / runJob をここから直接呼ばないこと** — 呼んだ時点で入口の認可を迂回する。


/** autonomy.enabled を明示的に書いたチャンネルだけが対象 (既定は「何も起きない」側) */
const autonomyChannels = Object.keys(config.channels ?? {}).filter(
  (name) => resolveAutonomy(channelConfigForName(config, name)).enabled,
);

/**
 * チャンネル名 → スケジューラの勘定。
 *
 * **台帳の部分だけディスクへ落とす** (§3.9)。巡回の最終実行時刻と日次の消費を
 * in-memory のままにすると、再起動のたびに「間隔が明けた」と見なして巡回が連発する。
 * 何を持ち越すかは scheduler.js の `persistedState` / `restoreState` が決める
 * (バックオフは持ち越さない — 走っているプロセスの観測であって台帳ではない)。
 */
const tickStateStore = new TickStateStore(resolve(ROOT, 'data', 'tick-states.json'));
const { tickStates, saveTickState } = createTickLedger({ tickStateStore, autonomyChannels });

// ボードは enabled のチャンネルが 1 つでもあるときだけ持つ
// (自律運転を使わない配備で data/tasks.json を作らない)
const board = autonomyChannels.length > 0
  ? new TaskBoardStore(resolve(ROOT, 'data', 'tasks.json'))
  : null;

if (board) {
  console.log(
    `[scheduler] 自律運転: ${autonomyChannels.join(' / ')} (ボード ${board.list().length} 件)`,
  );
  // touch 不明のタスクは「何とでも競合する」ので (§3.9)、1 件でも open だと
  // そのボードでは組織提案が全件拒否される。黙って発議が通らない状態にしない
  const missingTouch = tasksMissingTouch(board.list());
  if (missingTouch.length > 0) {
    console.error(
      `[board] touch を宣言していない終端でないタスクが ${missingTouch.length} 件あります `
      + `(${missingTouch.map((t) => `#${t.id}`).join(' / ')}) — `
      + 'このままでは発議が全件「タスクと競合します」で拒否されます。'
      + '`node scripts/migrate-task-touch.mjs` で移行してください',
    );
  }
} else {
  console.log('[scheduler] 自律運転が有効なチャンネルはありません (ボードは持ちません)');
}

// ---- 止まった仕事の検知と再開 (docs/social-engineering.md §11.2〜11.4) ----
// 判定は純粋関数 (src/taskstatus.js / src/recovery.js)、順序は src/recovery-wiring.js。
// ここは実体を結ぶだけ。通知はタスクのスレッドへ 1 通 (同じ問題につき 1 回)。
// 再開世代と自動復旧の勘定は data/recovery.json (再起動・手動再開で自動枠をリセットしない)
const recoveryStore = board ? new RecoveryStore(resolve(ROOT, 'data', 'recovery.json')) : null;

// ---- 自律社会の台帳 (docs/society-ledger.md §1) ----
// **`society` を書いていない配備では mode: off で、ここは fs に一切触れない** (受入 C15)。
// observe / active で不在・破損なら「起動停止」の理由を持つが、**プロセスは止めない** —
// 止まるのは社会由来の処理だけで、既存の受付・自律起動はそのまま動く。
// 自律起動の門 (AUTONOMY_GATE_LEDGERS) には**入れない**: 社会が読めないことと、
// 通常の自律運転が止まることは別の話 (混ぜると表示と実態がずれる)。
const society = resolveSociety(config);
const societyStore = new SocietyStore(resolve(ROOT, 'data', 'society.json'), { mode: society.mode });

// 社会の起動メッセージは**宛先以外の bot の client** から投げる (自分の多行発言は捨てられる)。
// 復旧の `postAs` (src/bridge/recovery.js) と同じ形だが、bridge 同士は import しないので
// 実体はここで組む
const postAsBot = async ({ botKey, threadId, text, mentionUserIds }) => {
  const bot = bots.get(botKey);
  if (!bot?.userId) throw new Error(`${botKey} は起動していません`);
  const channel = bot.client.channels.cache.get(String(threadId))
    ?? await bot.client.channels.fetch(String(threadId));
  if (!channel) throw new Error(`スレッド ${threadId} を取得できません`);
  if (channel.isThread?.() && channel.archived) throw new Error(`スレッド ${threadId} は archive されています`);
  return sendSafe(channel, text, { mentionUserIds });
};

// 送達不明の起動をスレッドで探すための走査 (自前 bot の投稿だけを返す)。
// `since` の少し前から**全件**辿り、末尾まで届いたかを `complete` で返す —
// 届かなかったときに「投稿が無い」と決めると、届いている起動を取り消してしまう
const scanSocietyThread = async ({ threadId, since = null }) => {
  const reader = [...bots.values()].find((b) => b.userId);
  if (!reader) throw new Error('起動している bot がありません');
  const channel = reader.client.channels.cache.get(String(threadId))
    ?? await reader.client.channels.fetch(String(threadId));
  if (!channel?.messages?.fetch) throw new Error(`スレッド ${threadId} を取得できません`);
  const ours = new Set([...bots.values()].map((b) => b.userId).filter(Boolean));
  // ページングと complete の判断は `collectThreadPosts` (src/bridge/society.js) が持つ。
  // ここは 1 ページ取って**古い順に並べ、自前 bot の投稿だけ**に絞る係
  const collected = await collectThreadPosts({
    after: Number.isFinite(since) ? snowflakeAt(since - 5 * 60 * 1000) : null,
    fetchPage: async ({ after, limit }) => {
      const batch = await channel.messages.fetch(after ? { after, limit } : { limit });
      return [...batch.values()]
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .map((m) => ({ id: m.id, content: String(m.content ?? ''), authorId: m.author?.id ?? null }));
    },
  });
  return {
    complete: collected.complete,
    // 変数名を `messages` にしない — 組み立ての検査が `messages.<member>` を配線の参照と読む
    messages: collected.posts.filter((p) => ours.has(p.authorId)),
  };
};

// 配線はここで作る (依存の pauseStore と lifecycle は上で揃っている) — 下の起動ログが
// `summary()` を使うので、[store] のブロックより前に実体が要る
const societyWiring = createSocietyWiring({
  society,
  store: societyStore,
  pauseStore,
  lifecycle,
  jobRuns,
  postAs: postAsBot,
  scanThread: scanSocietyThread,
  botUserId: (key) => bots.get(key)?.userId ?? null,
  availableBotKeys: () => [...bots.values()].filter((b) => b.userId).map((b) => b.key),
  // 走査も投稿も Discord が要る。**モジュール読込時には走らせない** (ready 後の最初の tick から)
  ready: () => [...bots.values()].some((b) => b.userId),
  // 実効権限の材料 (§3 の `既存能力 ∩ Mandate ∩ Claim.scope`)。**判断は society-policy.js**
  // の純粋関数が持ち、ここは設定と実行状態という事実を渡すだけ
  botFacts: () => Object.fromEntries(
    Object.entries(config.bots ?? {}).map(([key, cfg]) => [key, {
      runtime: cfg?.runtime ?? 'claude',
      online: Boolean(bots.get(key)?.userId),
    }]),
  ),
  channelStructuredOutput: (name) => {
    const configured = name ? channelConfigForName(config, name) : null;
    return configured ? resolveStructuredOutputEnabled(configured) : true;
  },
  // スレッドの編成 (未設定ならチャンネル既定 → それも無ければ制限なし)
  threadRoster: (threadId) => {
    const configured = threadId ? roster.get(threadId) : null;
    return resolveEffectiveRoster(configured, null).keys;
  },
});

// ---- 読めない台帳の一覧 (docs/social-engineering.md §12.3 (1)) ----
// **退避せず在処に残す**ので、起動のたびに同じ列挙が出る。
//
// **門になる台帳とそれ以外を分ける** (Opus2 レビュー 2026-09-07 Major1)。自律起動と自動復旧を
// 止めるのは下の 6 つだけ (src/bridge/scheduler.js と src/recovery-wiring.js の門と同じ顔ぶれ) で、
// sessions.json が壊れた日に「自律起動は止まっています」と出すと、表示と実態がずれる。
const AUTONOMY_GATE_LEDGERS = [pauseStore, board, recoveryStore, jobRuns, tickStateStore, proposals];
// 読めないと**その台帳を使う操作**は失敗する (書き込みは断られる) が、自律起動は止まらない
const OTHER_LEDGERS = [store, roster, inbox, contracts];
/** 読めない台帳 (`gate: true` = 自律起動が止まるもの)。/status と起動ログで同じ材料を使う */
const ledgerErrors = () => [
  ...brokenLedgers(AUTONOMY_GATE_LEDGERS).map((l) => ({ ...l, gate: true })),
  ...brokenLedgers(OTHER_LEDGERS).map((l) => ({ ...l, gate: false })),
];
{
  const broken = ledgerErrors();
  const gated = broken.filter((l) => l.gate);
  const others = broken.filter((l) => !l.gate);
  if (gated.length > 0) {
    console.error(
      `[store] 自律起動の門になる台帳が読めません (${formatBrokenLedgers(gated)}) — `
      + '着手・巡回・発議・自動復旧は止まります。**退避していません** (中身が証拠なので): '
      + 'data/ の当該ファイルを直すか、手で退避してから再起動してください',
    );
  }
  if (others.length > 0) {
    console.error(
      `[store] 読めない台帳があります (${formatBrokenLedgers(others)}) — `
      + '自律起動は止まりませんが、この台帳への書き込みは断られます (退避していません)',
    );
  }
}
{
  // 社会の 1 行。**off では何も出さない** (使っていない機構の話をログに置かない)
  const line = societyStartupLine(societyWiring.summary());
  if (line) console[societyWiring.haltReason() ? 'error' : 'log'](line);
}

const recovery = createRecoveryWiring({
  config,
  board,
  jobRuns,
  contracts,
  pauseStore,
  autonomyChannels,
  tickStates,
  saveTickState,
  postToThread: discord.postToThread,
  // `/review` の実体はボードの配線が持つ (この下で作る) ので関数で渡す
  reissueReview: (args) => boardWiring.reissueReview(args),
  recoveryStore,
  jobs,
  hops,
  bots,
  proposals,
});

// tick は**ボードと提案のどちらかがあれば張る**。提案の配り直し (sweepProposals) は
// 自律運転のチャンネルが 1 つも無い配備でも要る — 発議は report 経由で
// どのチャンネルからも起きるので、ボードの有無とは独立している
// 社会が有効なら、ボードも発議も無い配備でも tick は要る (照合と後始末は S2-2 で足す)
const SOCIETY_ENABLED = isSocietyEnabled(config);
if (board || proposals || SOCIETY_ENABLED) {
  setInterval(() => {
    // それぞれの門は各配線が持つ。ここは**従来の条件のまま**呼び分ける
    if (board) scheduler.autonomyTick().catch((err) => console.error('[scheduler] tick に失敗', err));
    if (proposals) proposalWiring.sweepProposals().catch((err) => console.error('[proposals] 配り直しに失敗', err));
    societyWiring.societyTick().catch((err) => console.error('[society] tick に失敗', err));
  }, AUTONOMY_TICK_MS).unref?.();
  console.log(`[scheduler] tick ${AUTONOMY_TICK_MS / 1000} 秒`);
} else {
  console.log('[scheduler] タイマーを張りません (ボードも発議機構も社会もありません)');
}

// ---- 配線の組み立て (src/bridge/*.js) ----
// 互いに呼び合うものは**後で作る側を関数で渡す** (呼ばれるのはイベントや tick の中なので、
// 組み立てが終わるまでに実体は揃う)。順序: スケジューラ → 提案 → ボード → org-apply →
// 契約 → 承認 → prompt → 配送 → job → キュー → 停止 → メッセージ入口。

const scheduler = createSchedulerWiring({
  config,
  board,
  bots,
  hops,
  proposals,
  dutyBots: DUTY_BOTS,
  pauseStore,
  lifecycle,
  recovery,
  autonomyChannels,
  tickStates,
  saveTickState,
  findGuildChannel: discord.findGuildChannel,
  // 自律起動の門 (§12.3 (1)): これらの台帳がどれか 1 つでも読めなければ tick は何も選ばない
  jobRuns,
  tickStateStore,
  recoveryStore,
});

const proposalWiring = createProposalWiring({
  config,
  root: ROOT,
  proposals,
  board,
  bots,
  hops,
  pauseStore,
  lifecycle,
  inbox,
  ownerTargets: OWNER_TARGETS,
  execBotKeys: EXEC_BOT_KEYS,
  findGuildChannel: discord.findGuildChannel,
  // 適用回路の起動点は sweepProposals の 1 経路だけ (org-apply の配線はこの下で作る)
  sweepOrgApply: (now) => orgApply.sweepOrgApply(now),
});

const boardWiring = createBoardWiring({
  root: ROOT,
  board,
  bots,
  contracts,
  hops,
  pauseStore,
  proposals,
  notifyDutyEvent: scheduler.notifyDutyEvent,
  setContractKindOverride: scheduler.setContractKindOverride,
  claimContractKindOverride: scheduler.claimContractKindOverride,
  contractCwd: (cc) => contractWiring.contractCwd(cc),
  channelConfigFor: discord.channelConfigFor,
  safeProposalContext: proposalWiring.safeProposalContext,
  releaseApplyWorktree: (task) => orgApply.releaseApplyWorktree(task),
});

const orgApply = createOrgApplyWiring({
  config,
  root: ROOT,
  proposals,
  board,
  bots,
  hops,
  findGuildChannel: discord.findGuildChannel,
  safeProposalContext: proposalWiring.safeProposalContext,
  resolveApplyBaseCommit: proposalWiring.resolveApplyBaseCommit,
  postToProposal: proposalWiring.postToProposal,
  requestReview: boardWiring.requestReview,
});

const contractWiring = createContractWiring({ contracts, botKeyOf: discord.botKeyOf });

const toolApprovals = createToolApprovalWiring({ toolExtra, approvals, limits });

const prompt = createPromptBuilder({ bots, limits });

const turn = createTurnWiring({
  config,
  inbox,
  contracts,
  ownerTargets: OWNER_TARGETS,
  limits,
  botKeyOf: discord.botKeyOf,
  botEntries: discord.botEntries,
  contractCwd: contractWiring.contractCwd,
  noteTaskCompletion: boardWiring.noteTaskCompletion,
  postApprovalRequests: toolApprovals.postApprovalRequests,
});

const jobRunner = createJobRunner({
  config,
  root: ROOT,
  commonRolePath: COMMON_ROLE_PATH,
  store,
  roster,
  jobRuns,
  board,
  limits,
  ownerTargets: OWNER_TARGETS,
  runRecorder,
  approvedRulesFor: toolApprovals.approvedRulesFor,
  applyIncomingContract: contractWiring.applyIncomingContract,
  claimContractKindOverride: scheduler.claimContractKindOverride,
  buildPrompt: prompt.buildPrompt,
  isInfraMessage: prompt.isInfraMessage,
  postTurn: turn.postTurn,
  fileProposal: boardWiring.fileProposal,
  applyApproval: boardWiring.applyApproval,
  applyReview: boardWiring.applyReview,
  applyProposalAdjudication: proposalWiring.applyProposalAdjudication,
  raiseProposal: proposalWiring.raiseProposal,
  // 案件の文脈と、構造化された戻り (case-turn) を台帳へ写す口
  society: societyWiring,
  decideApproval: toolApprovals.decideApproval,
  botEntries: discord.botEntries,
});

const jobQueue = createJobQueueWiring({
  jobs,
  lifecycle,
  jobRuns,
  runRecorder,
  noteAutonomyOutcome: scheduler.noteAutonomyOutcome,
  // 社会の Action に結ぶ job の running / settled をここで記録する (配送の後)
  society: societyWiring,
});

const shutdownWiring = createShutdownWiring({
  root: ROOT,
  bots,
  jobs,
  lifecycle,
  jobRuns,
  waitForJobsDrained: jobQueue.waitForJobsDrained,
  // 適用回路の verify は job ではない (tick から走る) ので、停止はここから別に伝える
  abortOrgApply: () => orgApply.abortVerify(),
});

// 上限で起動を見送ったことを受信箱へ (§10.3)。**bridge 同士は import しない**ので、
// 実体はここで組んで messages へ渡す (turn.js の noteOwnerCall と同じ形)。
// 閉じるのは人間の発言 = closeInboxForThread なので、通知の条件と閉じる条件がそろう
const noteHopLimit = ({ threadId, channelName, botKey, reason, messageId }) => {
  try {
    const entry = inbox.open({
      channel: channelName,
      threadId,
      botKey,
      summary: `${reason} に達したため起動を見送りました`,
      messageId,
    });
    console.log(`[inbox] 見送り #${entry.id} を記録: thread:${threadId} (${reason})`);
  } catch (err) {
    console.error(`[inbox] 記録に失敗 (/inbox に出ません): ${err.message}`);
  }
};

const messages = createMessageWiring({
  config,
  bots,
  hops,
  jobs,
  board,
  jobRuns,
  recovery,
  // 印付きの起動を保存済みの Action と照合し、受付を台帳へ書く (§5)
  society: societyWiring,
  lifecycle,
  limits,
  runRecorder,
  enqueue: jobQueue.enqueue,
  runJob: jobRunner.runJob,
  claimContract: contractWiring.claimContract,
  discardContractFor: contractWiring.discardContractFor,
  noteJobSpent: scheduler.noteJobSpent,
  closeInboxForThread: turn.closeInboxForThread,
  channelConfigFor: discord.channelConfigFor,
  botKeyOf: discord.botKeyOf,
  botRoleFor: discord.botRoleFor,
  otherBotMentionIds: discord.otherBotMentionIds,
  // 上限で見送ったときに知らせる相手 (空なら本文だけ出す) と、その記録先
  ownerTargets: OWNER_TARGETS,
  noteHopLimit,
});

process.on('SIGINT', () => void shutdownWiring.shutdown(130));
process.on('SIGTERM', () => void shutdownWiring.shutdown(143));
// SIGHUP (端末を閉じた) も後始末へ回す。**既定動作のまま死なせない** — 子は
// detached で別プロセスグループに居る (src/proc.js) ので端末の SIGHUP が届かず、
// ブリッジだけ消えて claude/codex のツリーが残る。runShutdown は二重呼び出しを
// lifecycle.beginShutdown() で弾くので、他のシグナルと重なっても安全
process.on('SIGHUP', () => void shutdownWiring.shutdown(129));

// ---- スラッシュコマンド (/stop・/restart) ----
// 実処理は src/interactions.js。ここでは「何を触れるか」だけを渡す
const onInteraction = createInteractionHandler({
  config,
  channelConfigFor: discord.channelConfigFor,
  jobs,
  waitForJobsDrained: (ms, label) => jobQueue.waitForJobsDrained(ms, label),
  writeRestartNotice: (notice) => shutdownWiring.writeRestartNotice(notice),
  shutdown: (...args) => shutdownWiring.shutdown(...args),
  lifecycle,
  restartDrainMs: RESTART_DRAIN_MS,
  approvals,
  saveApprovedRule: (request) => toolApprovals.saveApprovedRule(request),
  roster,
  inbox,
  // ボードは**関数で渡す** (ハンドラの契約 — 無い配備では null)。
  // /inbox は「要人間」節と「その通知が止めている task」を board から読む
  boardOf: () => board,
  pauseStore,
  botEntries: discord.botEntries,
  escapeForDisplay: sanitizeForDisplay,
  proposals,
  proposalContext: () => proposalWiring.proposalContext(),
  ownerUserId: config.ownerUserId ?? null,
  execBotKeys: EXEC_BOT_KEYS,
  // 適用の基点は git を読まないと決まらないので、判定側ではなくここから渡す
  resolveBaseCommit: () => proposalWiring.resolveApplyBaseCommit(),
  // work / process の裁定は押せるカードではなく「bot を起こし直す」ことなので、
  // 出し直しの実体は提案の配線 (src/bridge/proposals.js — bots も hops も持っている側) にある
  redeliverProposal: (id) => proposalWiring.redeliverProposal(id),
  // `/review` も同じ理由でボードの配線 (src/bridge/board.js) に実体がある
  reissueReview: (args) => boardWiring.reissueReview(args),
  // 復旧待ち (`/inbox` の 4 節目)。判定は実行記録・契約・pause を読むので復旧の service が持つ
  // (ボードの無い配備では null なので関数で渡す)
  recoveryRows: () => (recovery ? recovery.rows() : []),
  // `/retry` (§11.3) — 手動再開の実体。自動復旧 (§11.4) も同じ入口を使う
  retryTask: (args) => (recovery
    ? recovery.retry(args)
    : { ok: false, reason: '自律運転の機能が無効です (ボードを持つチャンネルがありません)', warnings: [] }),
  // `/status` (§11.5) — 集計と描画は純粋関数 (src/status.js)。材料をここで集める
  statusReport: ({ channelName }) => statusReport(channelName),
  // `/case` — 台帳の読み書きと描画は society の配線が持つ。表示のエスケープだけここで挿す
  caseCommand: (request) => societyWiring.caseCommand({ ...request, escape: sanitizeForDisplay }),
  // `/stop` の案件停止 (§12.2 (g))。job を止める前に呼ばれる — off / halted の判断は配線側
  societyStop: (request) => societyWiring.stopCases(request),
});

/**
 * `/status` の本文。board・実行記録・pause・勘定を集めて `formatStatus` へ渡すだけ。
 * ボードの無い配備・自律運転の無いチャンネルでも、実行記録があれば job の数字は出す。
 */
function statusReport(channelName) {
  if (!channelName) return '⚠️ このチャンネルは config.policy.json の channels に未登録です';
  const configured = channelConfigForName(config, channelName);
  const autonomy = configured ? resolveAutonomy(configured) : null;
  const state = tickStates.get(channelName) ?? null;
  const summary = summarizeStatus({
    channelName,
    tasks: board ? board.list({ channel: channelName }) : [],
    statusOf: (task) => (recovery ? recovery.statusOf(task) : { status: 'unknown', reason: 'ボードなし', since: null, waitedMs: null, next: 'unknown', run: null }),
    runs: jobRuns.list({ channel: channelName }),
    runsError: jobRuns.broken ?? (jobRuns.writeFailures.length > 0 ? `書き込みに失敗した記録がある (${jobRuns.writeFailures.length} 件)` : null),
    // 実行記録以外の台帳の異常も同じ 1 通で見せる (門かどうかは gate で区別する)
    ledgerErrors: ledgerErrors(),
    // 社会の状態 (off なら mode だけ)。起動ログと同じ材料を使う
    society: societyWiring.summary(),
    now: Date.now(),
    pause: pauseStore.current(),
    backoffUntil: state?.backoffUntil ?? 0,
    dayJobsLeft: autonomy?.enabled ? Math.max(0, autonomy.maxJobsPerDay - (Number(state?.jobsToday) || 0)) : null,
    maxJobsPerDay: autonomy?.enabled ? autonomy.maxJobsPerDay : null,
  });
  return formatStatus(summary, { escape: sanitizeForDisplay });
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
