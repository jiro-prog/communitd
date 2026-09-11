// 設定 (config.policy.json + config.secrets.json) の読み込み・合成・解釈・起動時検証。
// ファイル読み込みは注入した fs で行うので副作用なし (Discord ログインへ走る index.js と
// 分離し、テストから直接 import できるようにしてある)。

import { resolve } from 'node:path';
import { DEFAULT_LIMITS } from './attachments.js';
import { DEFAULT_JOB_BUDGET } from './board.js';
import { CLAUDE_EFFORTS } from './claude.js';
import { CODEX_EFFORTS, CODEX_SANDBOXES, DEFAULT_CODEX_SANDBOX } from './codex.js';
import { DEFAULT_MAX_BOT_HOPS } from './hops.js';
import { validateSociety } from './society-policy.js';

/**
 * ツール許可プリセット (claude ランタイム用)。
 * config.channels.<name> は "tools": "readonly"|"standard"|"full" の一語 + "toolsExtra" で
 * 書ける。明示の "allowedTools" 配列があればそちらが優先 (後方互換)。
 */
export const TOOL_PRESETS = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'Bash(git *)', 'Bash(node *)', 'Bash(npm *)',
    'PowerShell(git *)', 'PowerShell(node *)', 'PowerShell(npm *)',
  ],
  full: [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'Bash', 'PowerShell',
  ],
};

// 既定は最小権限 (fail-closed)。書込み・シェルを伴う standard / full と
// acceptEdits は config.json に明示的に書いたチャンネルでのみ有効になる。
export const DEFAULT_TOOLS_PRESET = 'readonly';
export const DEFAULT_PERMISSION_MODE = 'default';
/**
 * 書ける permissionMode。**列挙で縛る** — 綴り違いを CLI へそのまま渡すと
 * 起動エラーになるうえ、契約の touch 制限が「安全に絞れないモード」として
 * job を止める側にも効く (src/contract.js の NARROWED_MODE)。
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const DEFAULT_HOOKS_ENABLED = false;
/**
 * 構造化出力 (委譲契約と報告様式) を使うか。
 *
 * **既定は有効** — ここだけは「書かなければ何も起きない」が現状維持の側になる。
 * 種別そのものは役割文の `<!-- communitd-schema: ... -->` が決めており
 * (src/contract.js)、この設定はそれを**チャンネル単位で黙らせる**ためだけにある。
 *
 * 切ると委譲の touch 制限も効かなくなる (契約が構造として届かないため)。
 * 書けないチャンネルなら実害は無いが、書込みを許した場所で切るのは作者の判断。
 */
export const DEFAULT_STRUCTURED_OUTPUT = true;
export const DEFAULT_VERIFY_MAX_RETRIES = 1;
export const VERIFY_MAX_RETRIES_RANGE = [0, 3];

/** プリセット名の照合 (Object.prototype 由来のキーを拾わない) */
function presetFor(name) {
  return Object.hasOwn(TOOL_PRESETS, name) ? TOOL_PRESETS[name] : null;
}

/**
 * チャンネル設定から claude へ渡す allowedTools を決める。
 *
 * @param {object} cc チャンネル設定
 * @param {string[]} approvedExtra Discord で人間が承認したルール (data/tools-extra.json)。
 *        config.json と同じ扱いで足すが、**config 側を書き換えはしない** — 手書きの正本と
 *        承認由来を混ぜないため、出所は保存先で区別する (src/toolstore.js)
 */
export function resolveAllowedTools(cc = {}, approvedExtra = []) {
  const base = Array.isArray(cc.allowedTools)
    ? cc.allowedTools
    : [
        ...(presetFor(cc.tools ?? DEFAULT_TOOLS_PRESET) ?? TOOL_PRESETS[DEFAULT_TOOLS_PRESET]),
        ...(cc.toolsExtra ?? []),
      ];
  return [...new Set([...base, ...(approvedExtra ?? [])])];
}

/** チャンネル設定から claude へ渡す permissionMode を決める */
export function resolvePermissionMode(cc = {}) {
  return cc.permissionMode ?? DEFAULT_PERMISSION_MODE;
}

/**
 * Claude ランタイム専用の hook 基盤を有効にするか。
 * 未知の値は起動時検証で弾き、ここでは false へ落として fail-closed にする。
 */
export function resolveHooksEnabled(cc = {}) {
  return typeof cc.hooks === 'boolean' ? cc.hooks : DEFAULT_HOOKS_ENABLED;
}

/**
 * そのチャンネルで構造化出力 (委譲契約・報告様式) を使うか。
 *
 * 雑談のように成果物へ向かわない job のための口。様式が振る舞いを決めるので、
 * 「やったこと / 検証結果 / 残課題」を埋めさせる限りエージェントは仕事の顔から抜けない。
 *
 * 未知の値は既定 (有効) へ落として fail-closed にする — 切る側が防御の薄い方なので、
 * 書き損じで黙って契約が消えるより「切ったつもりが効いていない」の方が安全。
 */
export function resolveStructuredOutputEnabled(cc = {}) {
  return typeof cc.structuredOutput === 'boolean' ? cc.structuredOutput : DEFAULT_STRUCTURED_OUTPUT;
}

/** 未設定・型不正なら検証コマンド無しへ倒す (型不正そのものは起動時検証で弾く) */
export function resolveVerifyCommand(cc = {}) {
  return isNonEmptyString(cc.verify) ? cc.verify.trim() : null;
}

/** Stop hook が verify NG を同一セッションへ差し戻す上限 (0 = 報告だけ) */
export function resolveVerifyMaxRetries(cc = {}) {
  return inRange(cc.verifyMaxRetries, VERIFY_MAX_RETRIES_RANGE)
    ? cc.verifyMaxRetries
    : DEFAULT_VERIFY_MAX_RETRIES;
}

/**
 * チャンネル設定の claudeAddDirs を claude の `--add-dir` へ渡す形へ正規化する。
 * 相対パスは cc.cwd 基準・重複と cwd 自身は落とす (cwd は常に渡っている)。
 *
 * **`--add-dir` は読み書きの両方を開ける。** 参照用のつもりで足したディレクトリでも
 * 書けてしまい、読取専用にはできない。だからここでの境界は「書けないこと」ではなく
 * 「書いたら git 差分に出ること」で担保する — 足すのは git 管理下のツリーに限る
 * (2026-08-01 方針: 止めるのは取り返しがつかないものだけ)。
 *
 * 実在確認はしない (cwd と同じ扱い)。綴り違いは claude 側の起動エラーとして
 * スレッドに出るので、黙って落として「足したつもり」にするより分かりやすい。
 */
export function resolveAddDirs(cc = {}) {
  const cwd = isNonEmptyString(cc.cwd) ? resolve(cc.cwd) : '';
  const out = [];
  for (const dir of Array.isArray(cc.claudeAddDirs) ? cc.claudeAddDirs : []) {
    if (!isNonEmptyString(dir)) continue;
    const abs = resolve(cwd, dir.trim());
    if (abs === cwd || out.includes(abs)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * チャンネル設定から codex ランタイム (Sol) の sandbox を決める。
 * 既定は read-only — 書込みは「そのチャンネルに明示的に書いたときだけ」有効になる。
 * 未知の値は起動時検証で弾く (ここでは既定へ落として fail-closed にする)。
 */
export function resolveCodexSandbox(cc = {}) {
  return CODEX_SANDBOXES.includes(cc.codexSandbox) ? cc.codexSandbox : DEFAULT_CODEX_SANDBOX;
}

/**
 * チャンネル既定の編成 (そのチャンネルのスレッドで既定として効く allowlist)。
 *
 * `/roster` はスレッド単位なので、**打ち忘れたスレッドは全員呼べる**。通常の作業
 * チャンネルではそれが正しい (禁止は明示的に設定したときだけ効く — src/roster.js) が、
 * 「勝手に高いモデルを呼ばれると困る」チャンネルでは既定が逆に働く。ここはその初期値。
 *
 * 省略 = null = 従来どおり制限なし (新しい設定の既定は「何も起きない」側)。
 * 空配列は `/roster none` と同じ「このチャンネルでは handoff 禁止」として通す。
 *
 * 綴り違い・型不正は起動時検証で弾く。ここで [] へ倒すと 1 文字の書き損じで
 * 全 handoff が黙って止まり、逆に null へ倒すと「絞ったつもり」の穴になる。
 */
export function resolveChannelRoster(cc = {}) {
  if (!Array.isArray(cc.roster)) return null;
  const out = [];
  for (const key of cc.roster) {
    if (!isNonEmptyString(key)) continue;
    const trimmed = key.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 自律運転 (docs/social-engineering.md §3.7) のチャンネル設定。
 *
 * スケジューラ (§7-4、未実装) が tick ごとに読む値。**既定は「何も起きない」側**で、
 * `enabled: true` と明示的に書いたチャンネルだけが自律起動の対象になる。
 * 綴り違い・型不正・範囲外は起動時検証 (validateAutonomy) が落とすので、
 * ここは黙って既定へ倒して fail-closed にする。
 */
export const DEFAULT_AUTONOMY_ENABLED = false;

/** 方向性ドキュメント = 社会の憲法 (§3.4)。チャンネルの cwd 基準 */
export const DEFAULT_DIRECTION_FILE = 'docs/direction.md';

/**
 * タスクの作業ツリーを生やす基点 (§8-1)。**既定ブランチの自動検出はしない** —
 * 検出に頼ると、たまたま別のブランチが出ていた日に「前のタスクの上に積まれた」
 * (#9 と同じ壊れ方) が静かに再発する。書いてある方が事故らない (Sol 推奨 2026-08-28)。
 */
export const DEFAULT_BASE_BRANCH = 'main';

/** 同時に走らせるタスク数 (§3.7 ペース制御・裁定 2026-08-27「同時タスク 2 くらいから」) */
export const DEFAULT_MAX_CONCURRENT_TASKS = 2;

/** そのチャンネルの自律 job の 1 日あたり上限 (人間メンション起点の job は数えない) */
export const DEFAULT_MAX_JOBS_PER_DAY = 40;

/**
 * 1 タスクへ払い出す job 予算 (§3.5)。
 * 値の正本はボード側 (board.js) — 「設定を書かなかったチャンネル」と
 * 「予算を渡さずに起票したタスク」で違う数字が効くと追いかけられなくなる。
 */
export const DEFAULT_TASK_JOB_BUDGET = DEFAULT_JOB_BUDGET;

/** スカウト (§3.3) を起こす間隔 (分) */
export const DEFAULT_SCOUT_INTERVAL_MIN = 60;

/** 未着手 (proposed + approved) がこの数あればスカウトを起こさない (起票だけが溜まるのを防ぐ) */
export const DEFAULT_SCOUT_MAX_OPEN_TASKS = 6;

/**
 * autonomy に書けるキーの正本。
 * 綴り違いを黙って無視すると「ペースを絞ったつもりが効いていない」に化けるので、
 * limits.attachments と同じく**未知キーは起動時に落とす**。
 */
export const AUTONOMY_KEYS = [
  'enabled',
  'directionFile',
  'baseBranch',
  'scout',
  'worker',
  'reviewer',
  'maxConcurrentTasks',
  'maxJobsPerDay',
  'taskJobBudget',
  'recovery',
];
export const AUTONOMY_SCOUT_KEYS = ['bot', 'intervalMin', 'maxOpenTasks'];
export const AUTONOMY_WORKER_KEYS = ['bots'];

// ---- 自動復旧 (docs/social-engineering.md §11.4) ----

/** `autonomy.recovery` に書けるキー */
export const AUTONOMY_RECOVERY_KEYS = ['mode', 'graceMin', 'maxAutoRetries', 'retryDelaysMin'];

/**
 * 自動復旧の mode。**既定は observe** (何も起こさず、自動化していたら何をしたかをログに残す)。
 * `auto` は安全と確認できる停止 (モデル起動前の失敗など) だけを起こし直す。`off` は判定もしない
 */
export const RECOVERY_MODES = ['off', 'observe', 'auto'];
export const DEFAULT_RECOVERY_MODE = 'observe';

/** 無実行の検知猶予 (分)。これを過ぎるまで「起動待ち」として扱う */
export const DEFAULT_RECOVERY_GRACE_MIN = 5;

/** task ごとの自動再試行の上限 (超えたら復旧待ちに残す) */
export const DEFAULT_RECOVERY_MAX_AUTO_RETRIES = 2;

/** 再試行の間隔 (分)。n 回目は n 番目の値、足りなければ最後の値 */
export const DEFAULT_RECOVERY_RETRY_DELAYS_MIN = [5, 15];

/** 「1 以上の整数」で書く枠と既定値 (検証メッセージと resolve が同じ表を見る) */
const AUTONOMY_COUNT_DEFAULTS = {
  maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
  maxJobsPerDay: DEFAULT_MAX_JOBS_PER_DAY,
  taskJobBudget: DEFAULT_TASK_JOB_BUDGET,
};
const AUTONOMY_SCOUT_COUNT_DEFAULTS = {
  intervalMin: DEFAULT_SCOUT_INTERVAL_MIN,
  maxOpenTasks: DEFAULT_SCOUT_MAX_OPEN_TASKS,
};

/**
 * チャンネル設定 → 自律運転の実効値 (常に全フィールドの揃った形を返す)。
 *
 * bot キー (`scout.bot` / `worker.bots` / `reviewer`) の既定は無い —
 * 誰が担当かは配備ごとに違うので、書かなければ null / 空配列。
 * スケジューラ側は「担当が居なければその種の起動をしない」で受ける。
 */
export function resolveAutonomy(cc = {}) {
  const autonomy = isPlainObject(cc?.autonomy) ? cc.autonomy : {};
  const scout = isPlainObject(autonomy.scout) ? autonomy.scout : {};
  const worker = isPlainObject(autonomy.worker) ? autonomy.worker : {};
  const count = (value, fallback) => (isPositiveInt(value) ? value : fallback);
  return {
    // **true と書いてあるときだけ true。** 文字列 "true" や 1 で自律運転が始まると
    // 人が見ていない間に動き出すので、書き損じは「動かない」側へ倒す
    enabled: autonomy.enabled === true,
    directionFile: isNonEmptyString(autonomy.directionFile)
      ? autonomy.directionFile.trim()
      : DEFAULT_DIRECTION_FILE,
    baseBranch: isNonEmptyString(autonomy.baseBranch)
      ? autonomy.baseBranch.trim()
      : DEFAULT_BASE_BRANCH,
    scout: {
      bot: isNonEmptyString(scout.bot) ? scout.bot.trim() : null,
      intervalMin: count(scout.intervalMin, DEFAULT_SCOUT_INTERVAL_MIN),
      maxOpenTasks: count(scout.maxOpenTasks, DEFAULT_SCOUT_MAX_OPEN_TASKS),
    },
    worker: { bots: botKeyList(worker.bots) },
    reviewer: isNonEmptyString(autonomy.reviewer) ? autonomy.reviewer.trim() : null,
    maxConcurrentTasks: count(autonomy.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS),
    maxJobsPerDay: count(autonomy.maxJobsPerDay, DEFAULT_MAX_JOBS_PER_DAY),
    taskJobBudget: count(autonomy.taskJobBudget, DEFAULT_TASK_JOB_BUDGET),
    recovery: resolveRecovery(autonomy.recovery),
  };
}

/**
 * `autonomy.recovery` → 実効値 (§11.4)。書いていない配備は observe (起こさない・観測だけ)。
 * 読めない値は既定へ倒す — 検証は validateAutonomy が別に落とすので、ここは形を揃えるだけ
 */
export function resolveRecovery(value) {
  const recovery = isPlainObject(value) ? value : {};
  const delays = Array.isArray(recovery.retryDelaysMin)
    ? recovery.retryDelaysMin.filter(isPositiveInt)
    : [];
  return {
    mode: RECOVERY_MODES.includes(recovery.mode) ? recovery.mode : DEFAULT_RECOVERY_MODE,
    graceMin: isPositiveInt(recovery.graceMin) ? recovery.graceMin : DEFAULT_RECOVERY_GRACE_MIN,
    maxAutoRetries: Number.isSafeInteger(recovery.maxAutoRetries) && recovery.maxAutoRetries >= 0
      ? recovery.maxAutoRetries
      : DEFAULT_RECOVERY_MAX_AUTO_RETRIES,
    retryDelaysMin: delays.length > 0 ? delays : [...DEFAULT_RECOVERY_RETRY_DELAYS_MIN],
  };
}

/** bot キーの配列を正規化する (非文字列・空白・重複を落とす) */
function botKeyList(value) {
  const out = [];
  for (const key of Array.isArray(value) ? value : []) {
    if (!isNonEmptyString(key)) continue;
    const trimmed = key.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** チャンネル名 → チャンネル設定 (未登録なら null) */
export function channelConfigForName(config, channelName) {
  const channels = config?.channels;
  if (!channels || typeof channelName !== 'string') return null;
  if (!Object.hasOwn(channels, channelName)) return null;
  return { ...channels[channelName], channelName };
}

/**
 * 人間 (作者) の呼び名。config.ownerNames で上書きできる。
 * 通知そのものは制御フッター [[notify:owner]] が決めるので、この名前は
 * 「平文で呼んでも起動しない」ことを知らせる旧記法検出にだけ使う (src/mentions.js)。
 */
export const DEFAULT_OWNER_NAMES = ['owner'];

/**
 * 人間への通知先。ownerUserId 未設定なら空配列 = [[notify:owner]] は実行されない。
 *
 * allowedUserIds[0] からの推測はしない — 許可ユーザーが複数になった日に
 * 「先頭の人」へ黙って通知が飛ぶ事故になる。呼ぶ相手は明示的に書かせる。
 */
export function resolveOwnerTargets(config = {}) {
  const userId = config?.ownerUserId;
  if (!isNonEmptyString(userId)) return [];
  const names = Array.isArray(config.ownerNames) && config.ownerNames.length > 0
    ? config.ownerNames
    : DEFAULT_OWNER_NAMES;
  return names
    .filter(isNonEmptyString)
    .map((displayName) => ({ displayName: displayName.trim(), userId: userId.trim() }));
}

/**
 * bot 間の連続ホップ上限。未設定は既定 (hops.js)。
 * 0 は「bot 起点では一切起動しない」という有効な設定なので許す。
 */
export function resolveMaxBotHops(config = {}) {
  const v = config?.limits?.maxBotHops;
  return Number.isSafeInteger(v) && v >= 0 ? v : DEFAULT_MAX_BOT_HOPS;
}

/**
 * 連続**自己**呼び出しの上限。
 *
 * **未設定なら maxBotHops と同じ** = 別枠では絞らない。自己呼び出しも bot ホップを
 * 消費するので、書かなければ全体の枠 (既定 12) で止まる。先回りして小さい既定を
 * 置かないのは「最初から絞るより、暴走したら必要なところだけ絞る」方針のため
 * (作者裁定 2026-08-21)。0 は「自己呼び出しを一切許さない」= 機能ごと切る口。
 */
export function resolveMaxSelfHops(config = {}) {
  const v = config?.limits?.maxSelfHops;
  return Number.isSafeInteger(v) && v >= 0 ? v : resolveMaxBotHops(config);
}

/**
 * 文脈に載せる遡り分の文字数上限 (既定 80000)。
 *
 * これは日常的に効かせる値ではなく暴発防止の安全弁 — Discord の 1 発言は最大 2000 字で、
 * transcriptFetchLimit 件並べば十数万字になる。効くのは履歴を再構築する経路の遡り分だけで、
 * 既読カーソルの差分とトリガー以降は対象外 (落とすと恒久欠落する — src/transcript.js)。
 */
export const DEFAULT_TRANSCRIPT_CHAR_BUDGET = 80000;
/** 下限は Discord の 1 発言上限 (2000 字) — これを下回ると 1 件も載らない設定になる */
export const TRANSCRIPT_CHAR_BUDGET_RANGE = [2000, 10 * 1000 * 1000];

export function resolveTranscriptCharBudget(config = {}) {
  const v = config?.limits?.transcriptCharBudget;
  return inRange(v, TRANSCRIPT_CHAR_BUDGET_RANGE) ? v : DEFAULT_TRANSCRIPT_CHAR_BUDGET;
}

/** ツール権限の承認カードが有効な時間 (既定 30 分) */
export const DEFAULT_TOOL_APPROVAL_TTL_MS = 30 * 60 * 1000;
/**
 * hook 経路の承認で **job を止めて待てる上限** (既定 3 分)。カードの寿命
 * (toolApprovalTtlMs) とは別の値で、こちらは「作業ツリーのレーンが塞がる時間」。
 * 待っている間、同じ cwd の他チャンネルの job はすべて止まる。
 */
export const DEFAULT_TOOL_APPROVAL_WAIT_MS = 3 * 60 * 1000;
/** 1 job で出す承認カードの上限 (既定 3 件) */
export const DEFAULT_MAX_TOOL_APPROVAL_CARDS = 3;

/**
 * 承認まわりの上下限。「正の整数」だけでは受入条件 (短い期限・少ないカード) を満たせない
 * — MAX_SAFE_INTEGER を書けば実質無期限・無制限になる (sol 指摘 2026-07-31)。
 * 期限は 1 分〜24 時間、カードは 1〜10 件に収める。
 */
export const TOOL_APPROVAL_TTL_RANGE_MS = [60 * 1000, 24 * 60 * 60 * 1000];
export const MAX_TOOL_APPROVAL_CARDS_RANGE = [1, 10];
/**
 * 待機上限は 30 秒〜10 分。上を絞るのは、待っている間ずっと同じ作業ツリーの
 * 他チャンネルが止まるため — 「押し忘れて 1 時間レーンが死ぬ」を設定で作れないようにする。
 */
export const TOOL_APPROVAL_WAIT_RANGE_MS = [30 * 1000, 10 * 60 * 1000];

function inRange(v, [min, max]) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

/**
 * 承認カードの寿命。範囲外は既定へ落とす
 * (書き損じそのものは validateConfig が起動時に落とすので、ここは保険)。
 */
export function resolveToolApprovalTtlMs(config = {}) {
  const v = config?.limits?.toolApprovalTtlMs;
  return inRange(v, TOOL_APPROVAL_TTL_RANGE_MS) ? v : DEFAULT_TOOL_APPROVAL_TTL_MS;
}

/** hook 経路で job を止めて待てる上限 (範囲外は既定へ落とす) */
export function resolveToolApprovalWaitMs(config = {}) {
  const v = config?.limits?.toolApprovalWaitMs;
  return inRange(v, TOOL_APPROVAL_WAIT_RANGE_MS) ? v : DEFAULT_TOOL_APPROVAL_WAIT_MS;
}

/** 1 job あたりの承認カード上限 */
export function resolveMaxToolApprovalCards(config = {}) {
  const v = config?.limits?.maxToolApprovalCards;
  return inRange(v, MAX_TOOL_APPROVAL_CARDS_RANGE) ? v : DEFAULT_MAX_TOOL_APPROVAL_CARDS;
}

/**
 * owner の呼び名が bot の displayName と衝突していないか。
 * 衝突していると「誰を呼んだつもりなのか」がスレッド上で判別できなくなり、
 * 旧記法の警告 (src/mentions.js) も宛先を言い当てられない。起動時に落とす。
 * 照合は大文字小文字を無視する (検出側の正規表現が i フラグのため)。
 */
export function validateOwnerNameClash(config = {}) {
  const ownerNames = resolveOwnerTargets(config).map((t) => t.displayName);
  if (ownerNames.length === 0 || !isPlainObject(config.bots)) return [];
  const errors = [];
  for (const [key, bot] of Object.entries(config.bots)) {
    const displayName = bot?.displayName;
    if (!isNonEmptyString(displayName)) continue;
    const hit = ownerNames.find((n) => n.toLowerCase() === displayName.trim().toLowerCase());
    if (hit) {
      errors.push(
        `owner の呼び名 "${hit}" が bots.${key}.displayName と同じ — ` +
          '人間宛のメンションが bot 起動に化けるので ownerNames を別の呼び名にする',
      );
    }
  }
  return errors;
}

/**
 * limits.attachments で書けるキー。未知キーは黙って無視せずエラーにする —
 * タイプミスが「設定したつもりの上限が効いていない」に化けるのを防ぐ。
 */
export const ATTACHMENT_LIMIT_KEYS = [
  'maxImagesPerJob',
  'maxBytesPerImage',
  'maxBytesTotal',
  'fetchTimeoutMs',
  // テキスト添付は画像と別枠。バイト上限は取得の可否を、文字数上限はプロンプトへ
  // 載せる量を切る (超過分は truncate されるので、拒否とは意味が違う)
  'maxTextFilesPerJob',
  'maxBytesPerTextFile',
  'maxTextBytesTotal',
  'maxTextCharsPerFile',
  'maxTextCharsTotal',
];

/**
 * 「合計 < 単体」だとどの添付も通らない設定になる組み合わせ。
 * [合計側のキー, 単体側のキー] で並べる。
 */
const ATTACHMENT_TOTAL_PAIRS = [
  ['maxBytesTotal', 'maxBytesPerImage'],
  ['maxTextBytesTotal', 'maxBytesPerTextFile'],
  ['maxTextCharsTotal', 'maxTextCharsPerFile'],
];

/**
 * 添付上限の不変条件。
 * 0・負値・小数・非数を弾き、合計上限が単体上限を下回る (どの画像も通らない)
 * 組み合わせも拒否する。既定値は attachments.js 側の DEFAULT_LIMITS。
 */
export function validateAttachmentLimits(attachments) {
  if (attachments === undefined) return [];
  if (!isPlainObject(attachments)) return ['limits.attachments はオブジェクトで書く'];

  const errors = [];
  for (const key of Object.keys(attachments)) {
    if (!ATTACHMENT_LIMIT_KEYS.includes(key)) {
      errors.push(`limits.attachments.${key} は不明なキー (使えるのは ${ATTACHMENT_LIMIT_KEYS.join(' / ')})`);
    }
  }
  for (const key of ATTACHMENT_LIMIT_KEYS) {
    if (!Object.hasOwn(attachments, key)) continue;
    const value = attachments[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(
        `limits.attachments.${key} は正の整数で書く (受け取った値: ${JSON.stringify(value)})`,
      );
    }
  }
  // 不変条件は「既定値とマージした実効値」で見る。片側だけ書いた設定は
  // それ単体では妥当に見えても、省略した側に既定値が入った結果で破れる
  // (例: maxBytesTotal だけ 1KB にすると既定 10MB の単体上限を下回る)
  const effective = (key) =>
    (Number.isSafeInteger(attachments[key]) && attachments[key] > 0
      ? attachments[key]
      : DEFAULT_LIMITS[key]);
  for (const [totalKey, perKey] of ATTACHMENT_TOTAL_PAIRS) {
    const total = effective(totalKey);
    const per = effective(perKey);
    if (total < per) {
      errors.push(
        `limits.attachments の実効値が ${totalKey} (${total}) < ${perKey} (${per}) ` +
          '— 省略した側には既定値が入るので、両方の兼ね合いで書く',
      );
    }
  }
  return errors;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

/**
 * 自律運転設定の不変条件 (docs/social-engineering.md §3.7)。
 *
 * ここは**人が見ていない間に動く機構の設定**なので、他のキーより強く落とす:
 * 未知キー・型不正・範囲外に加えて、担当に書いた bot キーが `config.bots` に
 * 実在するかまで見る (綴り違いは「起票されない」「レビューされない」という
 * 無症状の停止になり、Discord を覗いても気付けない)。
 *
 * @param {unknown} autonomy channels.<name>.autonomy
 * @param {{channel?: string, botKeys?: string[], hasVerify?: boolean}} context
 * @returns {string[]} 人間向けエラー行
 */
export function validateAutonomy(autonomy, { channel = '<channel>', botKeys = [], hasVerify = false } = {}) {
  if (autonomy === undefined) return [];
  const at = `channels.${channel}.autonomy`;
  if (!isPlainObject(autonomy)) {
    return [`${at} はオブジェクトで書く (${AUTONOMY_KEYS.join(' / ')})`];
  }

  const errors = [];
  const known = (value, where) => {
    const key = value.trim();
    if (botKeys.includes(key)) return;
    errors.push(
      `${where} に知らない bot キー: ${key}` +
        `${botKeys.length ? ` (使えるのは ${botKeys.join(' / ')})` : ' (config.bots が空)'}`,
    );
  };

  for (const key of Object.keys(autonomy)) {
    if (!AUTONOMY_KEYS.includes(key)) {
      errors.push(`${at}.${key} は不明なキー (使えるのは ${AUTONOMY_KEYS.join(' / ')})`);
    }
  }

  if (autonomy.enabled !== undefined && typeof autonomy.enabled !== 'boolean') {
    errors.push(
      `${at}.enabled: boolean (true | false) で書く ` +
        `(省略 = ${DEFAULT_AUTONOMY_ENABLED} = そのチャンネルは自律起動しない)`,
    );
  }
  if (autonomy.directionFile !== undefined && !isNonEmptyString(autonomy.directionFile)) {
    errors.push(
      `${at}.directionFile は方向性ドキュメントのパスを非空の文字列で書く ` +
        `(cwd 基準・省略時は ${DEFAULT_DIRECTION_FILE})`,
    );
  }
  if (autonomy.baseBranch !== undefined && !isNonEmptyString(autonomy.baseBranch)) {
    errors.push(
      `${at}.baseBranch はタスクの作業ツリーを生やす基点ブランチを非空の文字列で書く ` +
        `(省略時は ${DEFAULT_BASE_BRANCH})`,
    );
  }
  if (autonomy.reviewer !== undefined) {
    if (!isNonEmptyString(autonomy.reviewer)) {
      errors.push(`${at}.reviewer は昇格を裁く bot のキーを非空の文字列で書く`);
    } else {
      known(autonomy.reviewer, `${at}.reviewer`);
    }
  }
  for (const [key, fallback] of Object.entries(AUTONOMY_COUNT_DEFAULTS)) {
    const value = autonomy[key];
    if (value !== undefined && !isPositiveInt(value)) {
      errors.push(
        `${at}.${key} は 1 以上の整数で書く ` +
          `(受け取った値: ${JSON.stringify(value)}／省略時は ${fallback})`,
      );
    }
  }

  if (autonomy.scout !== undefined) {
    if (!isPlainObject(autonomy.scout)) {
      errors.push(`${at}.scout はオブジェクトで書く (${AUTONOMY_SCOUT_KEYS.join(' / ')})`);
    } else {
      for (const key of Object.keys(autonomy.scout)) {
        if (!AUTONOMY_SCOUT_KEYS.includes(key)) {
          errors.push(`${at}.scout.${key} は不明なキー (使えるのは ${AUTONOMY_SCOUT_KEYS.join(' / ')})`);
        }
      }
      if (autonomy.scout.bot !== undefined) {
        if (!isNonEmptyString(autonomy.scout.bot)) {
          errors.push(`${at}.scout.bot は種を起票する bot のキーを非空の文字列で書く`);
        } else {
          known(autonomy.scout.bot, `${at}.scout.bot`);
        }
      }
      for (const [key, fallback] of Object.entries(AUTONOMY_SCOUT_COUNT_DEFAULTS)) {
        const value = autonomy.scout[key];
        if (value !== undefined && !isPositiveInt(value)) {
          errors.push(
            `${at}.scout.${key} は 1 以上の整数で書く ` +
              `(受け取った値: ${JSON.stringify(value)}／省略時は ${fallback})`,
          );
        }
      }
    }
  }

  if (autonomy.worker !== undefined) {
    if (!isPlainObject(autonomy.worker)) {
      errors.push(`${at}.worker はオブジェクトで書く ({ bots: [...] })`);
    } else {
      for (const key of Object.keys(autonomy.worker)) {
        if (!AUTONOMY_WORKER_KEYS.includes(key)) {
          errors.push(`${at}.worker.${key} は不明なキー (使えるのは ${AUTONOMY_WORKER_KEYS.join(' / ')})`);
        }
      }
      if (autonomy.worker.bots !== undefined) {
        if (!Array.isArray(autonomy.worker.bots) || !autonomy.worker.bots.every(isNonEmptyString)) {
          errors.push(`${at}.worker.bots は実装を担当する bot キーの配列で書く`);
        } else {
          for (const key of autonomy.worker.bots) known(key, `${at}.worker.bots`);
        }
      }
    }
  }

  // 自動復旧 (§11.4)。未知キー・型違いは起動時に落とす — 「observe のつもりが auto」や
  // 「上限 2 のつもりが無制限」が無症状で進む設定なので、他のキーと同じ強さで断る
  if (autonomy.recovery !== undefined) {
    const r = autonomy.recovery;
    const where = `${at}.recovery`;
    if (!isPlainObject(r)) {
      errors.push(`${where} はオブジェクトで書く (${AUTONOMY_RECOVERY_KEYS.join(' / ')})`);
    } else {
      for (const key of Object.keys(r)) {
        if (!AUTONOMY_RECOVERY_KEYS.includes(key)) {
          errors.push(`${where}.${key} は不明なキー (使えるのは ${AUTONOMY_RECOVERY_KEYS.join(' / ')})`);
        }
      }
      if (r.mode !== undefined && !RECOVERY_MODES.includes(r.mode)) {
        errors.push(
          `${where}.mode は ${RECOVERY_MODES.join(' | ')} のどれか (受け取った値: ${JSON.stringify(r.mode)}／省略時は ${DEFAULT_RECOVERY_MODE})`,
        );
      }
      if (r.graceMin !== undefined && !isPositiveInt(r.graceMin)) {
        errors.push(`${where}.graceMin は 1 以上の整数 (分) で書く (受け取った値: ${JSON.stringify(r.graceMin)}／省略時は ${DEFAULT_RECOVERY_GRACE_MIN})`);
      }
      if (r.maxAutoRetries !== undefined && !(Number.isSafeInteger(r.maxAutoRetries) && r.maxAutoRetries >= 0)) {
        errors.push(`${where}.maxAutoRetries は 0 以上の整数で書く (受け取った値: ${JSON.stringify(r.maxAutoRetries)}／省略時は ${DEFAULT_RECOVERY_MAX_AUTO_RETRIES})`);
      }
      if (r.retryDelaysMin !== undefined
        && !(Array.isArray(r.retryDelaysMin) && r.retryDelaysMin.length > 0 && r.retryDelaysMin.every(isPositiveInt))) {
        errors.push(`${where}.retryDelaysMin は 1 以上の整数 (分) を 1 つ以上並べた配列で書く (受け取った値: ${JSON.stringify(r.retryDelaysMin)}／省略時は [${DEFAULT_RECOVERY_RETRY_DELAYS_MIN.join(', ')}])`);
      }
    }
  }

  // enabled のチャンネルにだけかかる不変条件。書き損じではなく「危ない組み合わせ」を止める
  if (autonomy.enabled === true) {
    // 自律運転は人が見ていない間に main へ昇格する (§3.6)。機械検証が無いチャンネルで
    // 有効にすると、壊れたまま merge される経路だけが残る
    if (!hasVerify) {
      errors.push(
        `${at}.enabled: true には channels.${channel}.verify (と hooks: true) が要る ` +
          '— 人が見ていない間に main へ昇格するので、機械検証の無いチャンネルでは有効にしない',
      );
    }
    // §6 規約層「自己レビュー禁止 (執筆と検収は別 bot)」を、設定だけで破れる形を潰す。
    // worker が reviewer 1 人しか居ないと、必ず自分の書いたものを自分で通すことになる
    const resolved = resolveAutonomy({ autonomy });
    const workers = resolved.worker.bots;
    if (resolved.reviewer && workers.length > 0 && workers.every((k) => k === resolved.reviewer)) {
      errors.push(
        `${at}: worker.bots が reviewer (${resolved.reviewer}) だけになっている ` +
          '— 執筆と検収は別 bot にする (自己レビュー禁止・§6)',
      );
    }
  }

  return errors;
}

// ---- 発議と組織裁定 (docs/social-engineering.md §3.9) ----

/** `initiative` が持てるキー (増やすときは validateInitiative も直す) */
export const INITIATIVE_KEYS = ['enabled', 'execBotKeys', 'applyChannel'];

/**
 * 発議機構が有効か。**既定は無効** — 設定に書いていない配備で組織提案が動き出さない。
 */
export function isInitiativeEnabled(config = {}) {
  return config?.initiative?.enabled === true;
}

/**
 * `work | process` を経営裁量で裁定できる bot (§3.9 の CEO 代理)。
 *
 * **既定は空 = 誰も裁定できない** (fail-closed)。裁定権を config に書かせるのは、
 * ここを既定値やコードのハードコードで決めると「誰が決めてよいか」がリポジトリの
 * 設定を読んでも分からなくなるため。`org` はこれとは無関係に作者だけが裁定できる。
 */
export function resolveExecBotKeys(config = {}) {
  const keys = config?.initiative?.execBotKeys;
  return Array.isArray(keys) ? keys.filter(isNonEmptyString) : [];
}

/**
 * 採択された `org | process` を当てる専用回路のチャンネル (§3.9 の `org-apply`)。
 *
 * **既定は無し = 適用回路を持たない** (fail-closed)。ここが決まらないと、
 * どのチャンネルの設定で `roles/**` と `config.policy.json` へ書いてよいかが決まらない —
 * 適用の基点 (`baseCommit`) もこのチャンネルの `autonomy.baseBranch` から採る。
 *
 * 書いていない配備では基点が取れないので、**`org | process` の採択そのものができない**
 * (`ProposalStore.adjudicate` が断る)。却下と `work` は今までどおり通る。
 * 「採択したが誰も当てられない提案」を作らないための fail-closed。
 */
export function resolveApplyChannel(config = {}) {
  const name = config?.initiative?.applyChannel;
  return isNonEmptyString(name) ? name.trim() : null;
}

// ---- duty (docs/social-engineering.md §3.8「bot 組織 OS」) ----
//
// 職務憲章の散文は `roles/<key>.md` にあり、config が持つのは**機械が扱う分だけ**。
// `duties` を配列でなく key オブジェクトにしてあるのは、`/bots/<bot>/duties/<dutyKey>`
// という RFC 6901 pointer で安定して指すため (配列添字は並べ替えで壊れ、`duty-edit`
// 提案の target が別の duty を指してしまう)。

/** 1 つの duty が持てるキー (増やすときは validateBotDuties も直す) */
export const DUTY_KEYS = ['intervalMin', 'maxOpenProposals', 'eventKinds'];

/**
 * duty を起こすイベント (§3.9 の発議 3 経路のうち (2))。
 * **閉集合**にしてあるのは、綴り違いを黙って無視すると「拾うつもりのイベントが
 * 誰にも届いていない」に化けるため。
 */
export const DUTY_EVENT_KINDS = ['block', 'send-back', 'backoff'];

/** duty の定期巡回の既定間隔 (分)。既定は日次 — 巡回は「見落としを補う」ためのもの */
export const DEFAULT_DUTY_INTERVAL_MIN = 24 * 60;

/**
 * その duty が同時に持てる open な提案の数。
 * 越えていれば巡回を起こさない — 裁定待ちを積み上げても採否は速くならない。
 */
export const DEFAULT_DUTY_MAX_OPEN_PROPOSALS = 2;

/**
 * bot ごとの日次発議 job 上限 (§3.8)。**ノルマではなく上限**で、
 * 「提案なし」が正常な巡回も認める。既定を 1 にしてあるのは、
 * 書き忘れた bot が 1 日に何本も発議 job を立てないようにするため。
 */
export const DEFAULT_INITIATIVE_BUDGET = 1;

/**
 * bot 設定 → duty の実効値 (key 昇順の配列)。壊れた値は既定へ倒す
 * (綴り違い・型不正は validateBotDuties が起動時に落とす)。
 *
 * @returns {Array<{key: string, intervalMin: number, maxOpenProposals: number,
 *                  eventKinds: string[]}>}
 */
export function resolveDuties(botConfig = {}) {
  const duties = isPlainObject(botConfig?.duties) ? botConfig.duties : {};
  return Object.keys(duties).sort().map((key) => {
    const duty = isPlainObject(duties[key]) ? duties[key] : {};
    return {
      key,
      intervalMin: isPositiveInt(duty.intervalMin) ? duty.intervalMin : DEFAULT_DUTY_INTERVAL_MIN,
      maxOpenProposals: isPositiveInt(duty.maxOpenProposals)
        ? duty.maxOpenProposals
        : DEFAULT_DUTY_MAX_OPEN_PROPOSALS,
      // 知らない綴りは落とす (閉集合の外は「そのイベントでは起きない」)
      eventKinds: Array.isArray(duty.eventKinds)
        ? [...new Set(duty.eventKinds.filter((k) => DUTY_EVENT_KINDS.includes(k)))]
        : [],
    };
  });
}

/** その bot の日次発議 job 上限 (書いていなければ既定) */
export function resolveInitiativeBudget(botConfig = {}) {
  return isPositiveInt(botConfig?.initiativeBudget)
    ? botConfig.initiativeBudget
    : DEFAULT_INITIATIVE_BUDGET;
}

/**
 * duty を持つ bot の一覧 (巡回とイベント配信の対象)。
 * @returns {Array<{botKey: string, duties: object[], initiativeBudget: number}>}
 */
export function resolveDutyBots(config = {}) {
  const bots = isPlainObject(config?.bots) ? config.bots : {};
  return Object.keys(bots).sort()
    .map((botKey) => ({
      botKey,
      duties: resolveDuties(bots[botKey]),
      initiativeBudget: resolveInitiativeBudget(bots[botKey]),
    }))
    .filter((bot) => bot.duties.length > 0);
}

/**
 * `bots.<key>.duties` と `initiativeBudget` の検証。
 *
 * duty キーは **RFC 6901 pointer の 1 セグメントとして安定して書ける形**に限る —
 * `/` や `~` を含むキーはエスケープが要り、`duty-edit` 提案の target と
 * 突き合わせるときに表記が割れる。
 */
export function validateBotDuties(botConfig, { botKey = '<bot>' } = {}) {
  const at = `bots.${botKey}`;
  const errors = [];
  if (botConfig?.initiativeBudget !== undefined && !isPositiveInt(botConfig.initiativeBudget)) {
    errors.push(
      `${at}.initiativeBudget は 1 以上の整数で書く `
      + `(受け取った値: ${JSON.stringify(botConfig.initiativeBudget)}／省略時は ${DEFAULT_INITIATIVE_BUDGET})`,
    );
  }
  if (botConfig?.duties === undefined) return errors;
  if (!isPlainObject(botConfig.duties)) {
    return [...errors, `${at}.duties はオブジェクトで書く (キーが duty の名前 — 配列にしない)`];
  }
  for (const [key, duty] of Object.entries(botConfig.duties)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
      errors.push(`${at}.duties のキー "${key}" は英小文字・数字・- だけで書く (pointer の 1 セグメントになる)`);
    }
    if (!isPlainObject(duty)) {
      errors.push(`${at}.duties.${key} はオブジェクトで書く (${DUTY_KEYS.join(' / ')})`);
      continue;
    }
    for (const k of Object.keys(duty)) {
      if (!DUTY_KEYS.includes(k)) {
        errors.push(`${at}.duties.${key}.${k} は不明なキー (使えるのは ${DUTY_KEYS.join(' / ')})`);
      }
    }
    for (const k of ['intervalMin', 'maxOpenProposals']) {
      if (duty[k] !== undefined && !isPositiveInt(duty[k])) {
        errors.push(`${at}.duties.${key}.${k} は 1 以上の整数で書く (受け取った値: ${JSON.stringify(duty[k])})`);
      }
    }
    if (duty.eventKinds !== undefined) {
      if (!Array.isArray(duty.eventKinds)) {
        errors.push(`${at}.duties.${key}.eventKinds は配列で書く (${DUTY_EVENT_KINDS.join(' | ')})`);
      } else {
        const unknown = duty.eventKinds.filter((k) => !DUTY_EVENT_KINDS.includes(k));
        if (unknown.length > 0) {
          errors.push(
            `${at}.duties.${key}.eventKinds に不明なイベント: ${unknown.map((k) => JSON.stringify(k)).join(' / ')} `
            + `(使えるのは ${DUTY_EVENT_KINDS.join(' | ')})`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * 発議機構の設定検証。
 *
 * **有効にするなら `ownerUserId` を必須にする** (§3.9) — org 提案を裁定できるのは
 * 作者だけで、ID が無いと `canAdjudicate` が誰も通さない。裁定できない提案が
 * 黙って溜まるより、起動時に落ちた方がよい。
 *
 * @param {object} config 合成後の config
 * @param {{contractKindOf?: (botKey: string) => string|null}} [deps]
 *   その bot の役割文が宣言しているスキーマ種別を返す関数 (省略すると役割文は見ない)。
 *   注入にしてあるのは、このモジュールがファイルを読まないため (判定はテストから直接叩ける)
 */
/**
 * 適用回路のチャンネルが §3.9 の条件を満たすか。
 *
 * **構造 (名前・実在) は常に見るが、稼働条件は `initiative.enabled` のときだけ見る。**
 * `enabled: false` は機構ごと止める設定なので、止めたまま applyChannel を残した config が
 * 起動できないのは食い違う (Sol 指摘 2026-08-31)。
 *
 * 稼働条件:
 * - **cwd はブリッジ自身のリポジトリ** — 提案の対象はここ 1 つ (`proposalContext` の
 *   `cwd` も同じ) なので、別リポジトリのチャンネルを指すと「検証したのは A・当てるのは B」
 *   になる。`repoRoot` を渡さない呼び出し (add-project) では見ない
 * - **autonomy が有効で worker と reviewer が居る** — 適用 task を走らせる worker と、
 *   diff を検収する reviewer の両方が無いと、採択した提案の錠が掛かったまま滞留する
 * - **`scout.bot` は未設定** — 適用 task だけを処理し、通常の scout を副作用で起こさない
 */
function validateApplyChannel(config, value, repoRoot) {
  if (!isNonEmptyString(value)) return ['initiative.applyChannel には適用回路を置くチャンネル名を書く'];
  const name = value.trim();
  const channels = isPlainObject(config.channels) ? config.channels : {};
  if (!Object.hasOwn(channels, name)) {
    return [
      `initiative.applyChannel が channels に無い: ${name} — `
      + '適用回路は実在するチャンネルの設定 (cwd と autonomy) で動く',
    ];
  }
  // 機構ごと止めている config では、稼働条件までは求めない
  if (!isInitiativeEnabled(config)) return [];

  const errors = [];
  const cc = channels[name];
  const at = `initiative.applyChannel (${name})`;
  if (isNonEmptyString(repoRoot) && !samePathCanonical(cc?.cwd, repoRoot)) {
    errors.push(
      `${at} の cwd はブリッジ自身のリポジトリと同じにする `
      + `(いま: ${cc?.cwd ?? '未設定'} / 期待: ${repoRoot}) — `
      + '提案を検証するのも当てるのもこのリポジトリなので、別の場所を指すと検証と適用がずれる',
    );
  }
  const autonomy = resolveAutonomy(cc);
  if (!autonomy.enabled) {
    errors.push(`${at} は autonomy.enabled が true でないと適用 task が走らない`);
  }
  if (autonomy.worker.bots.length === 0) {
    errors.push(`${at} は autonomy.worker.bots が要る (適用 task を走らせる担当が居ない)`);
  }
  if (!autonomy.reviewer) {
    errors.push(`${at} は autonomy.reviewer が要る (当てた diff を検収する担当が居ない)`);
  }
  if (autonomy.scout.bot) {
    errors.push(
      `${at} の autonomy.scout.bot は未設定にする — `
      + '適用回路は採択された提案の task だけを処理し、通常の起票を副作用で起こさない',
    );
  }
  return errors;
}

/** パスの同一判定 (Windows でだけ大小文字を無視する) */
function samePathCanonical(a, b) {
  if (!isNonEmptyString(a) || !isNonEmptyString(b)) return false;
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function validateInitiative(config = {}, { contractKindOf = null, repoRoot = null } = {}) {
  const initiative = config?.initiative;
  if (initiative === undefined) return [];
  if (!isPlainObject(initiative)) return ['initiative はオブジェクトで書く'];

  const errors = [];
  const unknown = Object.keys(initiative).filter((k) => !INITIATIVE_KEYS.includes(k));
  if (unknown.length > 0) {
    errors.push(`initiative の未知のキー: ${unknown.join(' / ')} (書けるのは ${INITIATIVE_KEYS.join(' / ')})`);
  }
  if (initiative.enabled !== undefined && typeof initiative.enabled !== 'boolean') {
    errors.push('initiative.enabled は true / false で書く');
  }
  if (initiative.execBotKeys !== undefined) {
    if (!Array.isArray(initiative.execBotKeys) || !initiative.execBotKeys.every(isNonEmptyString)) {
      errors.push('initiative.execBotKeys には bot キーの文字列を並べる');
    } else {
      const bots = isPlainObject(config.bots) ? config.bots : {};
      const missing = initiative.execBotKeys.filter((key) => !Object.hasOwn(bots, key));
      if (missing.length > 0) {
        errors.push(`initiative.execBotKeys に居ない bot が入っている: ${missing.join(' / ')}`);
      }
    }
  }
  if (initiative.applyChannel !== undefined) {
    errors.push(...validateApplyChannel(config, initiative.applyChannel, repoRoot));
  }
  if (isInitiativeEnabled(config)) {
    if (!isNonEmptyString(config.ownerUserId)) {
      errors.push(
        `initiative.enabled が true なら ownerUserId が要る (${SECRETS_FILE} に書く) — `
        + 'org 提案を裁定できるのは作者だけなので、ID が無いと裁定待ちのまま滞留する',
      );
    } else if (!(Array.isArray(config.allowedUserIds) ? config.allowedUserIds : []).includes(config.ownerUserId)) {
      // 裁定 UI は identity 境界 (allowedUserIds) と owner 判定の**両方**を要求する。
      // 片方だけ通る設定は「カードは届くのに永久に押せない」— 起動時に落とす
      errors.push(
        `initiative.enabled が true なら ownerUserId は allowedUserIds にも入れる (${SECRETS_FILE}) — `
        + '入っていないと裁定カードは届くのに作者が押せない',
      );
    }
    errors.push(...validateStructuredRoles(config, contractKindOf));
  }
  return errors;
}

/**
 * 発議に関わる bot が**構造化出力を返せる**か (sol 指摘 2026-08-30)。
 *
 * 発議も裁定も report の任意フィールドで受け取るので、構造化出力を返せない bot に
 * duty や裁定権を持たせると**スレッドと job 予算だけ消えて何も回収できない**。
 * 落ちる経路は 2 つある:
 * - `runtime: "codex"` は `--json-schema` を持たない (src/contract.js の resolveContractKind)
 * - 役割文にスキーマ宣言が無い bot は種別の上書きが乗らない (宣言のある bot にしか乗らない)
 *
 * どちらも設定を読んだだけでは気付けないので、起動時に落とす。
 */
function validateStructuredRoles(config, contractKindOf) {
  const bots = isPlainObject(config.bots) ? config.bots : {};
  const involved = new Map();
  for (const bot of resolveDutyBots(config)) involved.set(bot.botKey, 'duty');
  for (const key of resolveExecBotKeys(config)) {
    if (Object.hasOwn(bots, key)) involved.set(key, involved.get(key) ?? '裁定 (execBotKeys)');
  }

  const errors = [];
  for (const [key, why] of involved) {
    if (bots[key]?.runtime === 'codex') {
      errors.push(
        `bots.${key} は runtime: "codex" なので ${why} を持てない — `
        + 'codex は --json-schema を持たず、発議も裁定も構造化出力で受け取るため',
      );
      continue;
    }
    if (contractKindOf && contractKindOf(key) === null) {
      errors.push(
        `bots.${key} の役割文にスキーマ宣言 (<!-- communitd-schema: ... -->) が無いので ${why} を持てない — `
        + '宣言の無い bot には種別の上書きが乗らず、発議 job がスレッドと予算だけ消費する',
      );
    }
  }

  // **チャンネル側で切られていても回収できない** (sol 指摘 2026-08-30)。
  // 定期巡回とイベントの発議 job は autonomy が有効なチャンネルにスレッドを立てるので、
  // そこで `structuredOutput: false` だと bot も役割文も正しいのに種別が null になる
  // (src/contract.js の resolveContractKind)。duty を持つ bot が 1 体でも居るなら落とす
  if (resolveDutyBots(config).length > 0) {
    for (const [name, cc] of Object.entries(isPlainObject(config.channels) ? config.channels : {})) {
      if (!isPlainObject(cc) || cc.autonomy?.enabled !== true) continue;
      if (resolveStructuredOutputEnabled(cc)) continue;
      errors.push(
        `channels.${name} は autonomy が有効なのに structuredOutput: false — `
        + 'duty を持つ bot が居るチャンネルでは発議 job が構造化出力を返せず、'
        + 'スレッドと job 予算だけ消費して発議を回収できない',
      );
    }
  }
  return errors;
}

// ---- 設定ファイルの分離 (policy / secrets) ----
//
// 設定は 2 ファイルに分かれている。**git 管理する** `config.policy.json` (bot・channel・
// autonomy・予算などの非秘密設定) と、**gitignore する** `config.secrets.json`
// (サーバー ID・ユーザー ID といった秘密・個人情報)。
//
// 分ける理由は M2 の `org-apply` (docs/social-engineering.md §3.9) — 採択された組織提案の
// diff をブリッジが policy へ当てるので、policy が追跡可能でないと差分も巻き戻しも作れない。
// 同時に、その適用回路から**裁定権者を書き換えられないようにする**必要がある。
// `ownerUserId` / `ownerNames` を secrets 側に固定してあるのはそのため
// (secrets はどの提案からも対象にできない)。

/** git 管理する非秘密設定 */
export const POLICY_FILE = 'config.policy.json';
/** gitignore する秘密設定 */
export const SECRETS_FILE = 'config.secrets.json';

/**
 * secrets 側に書いてよいトップレベルキー (allowlist)。
 *
 * **allowlist にしてあるのは fail-closed のため** — 「秘密っぽいキーを secrets へ」と
 * 曖昧に許すと、policy にあるはずの channels や autonomy を secrets 側へ移すだけで
 * git の追跡から外せてしまう。それは `org-apply` が前提にしている「policy の現在値は
 * リポジトリを見れば分かる」を静かに壊す。
 *
 * **この allowlist は両側に効く** — ここに挙げたキーは secrets にしか置けず、
 * policy 側に書いてあれば起動時に落とす (`mergeConfigSources`)。
 */
export const SECRET_KEYS = ['guildId', 'allowedUserIds', 'ownerUserId', 'ownerNames'];

/**
 * policy と secrets を 1 つの内部 config へ合成する。
 * 合成は**トップレベルの浅いマージ**だけ — 深くマージすると「どちらが効いているか」が
 * 設定を見ても分からなくなるので、キーの置き場は allowlist で両側から縛る
 * (`SECRET_KEYS` は secrets にしか置けず、それ以外は policy にしか置けない)。
 *
 * @returns {{config: object|null, errors: string[]}} errors が空でなければ config は null
 */
export function mergeConfigSources(policy, secrets) {
  const errors = [];
  if (!isPlainObject(policy)) errors.push(`${POLICY_FILE} がオブジェクトとして読めない`);
  if (!isPlainObject(secrets)) errors.push(`${SECRETS_FILE} がオブジェクトとして読めない`);
  if (errors.length > 0) return { config: null, errors };

  // **allowlist は両側に効かせる。**「secrets に置ける」だけでは分離目的を満たさない —
  // org-apply は policy にしか触れないので、裁定権者が policy 側に残っていれば
  // 採択された提案から書き換えられてしまう (sol 指摘 2026-08-29)
  const forbidden = Object.keys(policy).filter((k) => SECRET_KEYS.includes(k));
  if (forbidden.length > 0) {
    errors.push(
      `${POLICY_FILE} に置けないキー: ${forbidden.join(' / ')} ` +
        `(秘密・個人情報は ${SECRETS_FILE} にしか置けない — 両方に書いてあるなら policy 側を消す)`,
    );
  }
  const unknown = Object.keys(secrets).filter((k) => !SECRET_KEYS.includes(k));
  if (unknown.length > 0) {
    errors.push(
      `${SECRETS_FILE} に置けないキー: ${unknown.join(' / ')} ` +
        `(置けるのは ${SECRET_KEYS.join(' / ')} だけ — 他は ${POLICY_FILE} に書く)`,
    );
  }
  // 同じキーが両方にあるケースは上の 2 つで必ず落ちる (secrets 側は allowlist に
  // 縛られているので、重なるキーは SECRET_KEYS = policy 側で禁止されているものだけ)。
  // 「どちらが効くか分からない設定」は合成前に消えている
  if (errors.length > 0) return { config: null, errors };

  return { config: { ...policy, ...secrets }, errors };
}

/**
 * 2 ファイルを読んで合成する。fs は注入する (テストから実ファイルを触らないため)。
 * 読めない・JSON として壊れている段階で止め、合成も検証もしない。
 *
 * @param {{policyPath: string, secretsPath: string, readFile: (p: string) => string}} deps
 * @returns {{config: object|null, errors: string[]}}
 */
export function loadConfigSources({ policyPath, secretsPath, readFile }) {
  const errors = [];
  const parsed = [];
  for (const [path, file] of [[policyPath, POLICY_FILE], [secretsPath, SECRETS_FILE]]) {
    let raw;
    try {
      raw = readFile(path);
    } catch (err) {
      // 分離前の config.json から移ってきた人がここに来る。原因を推測させない
      errors.push(
        err?.code === 'ENOENT'
          ? `${file} がありません (${path}) — SETUP.md §0 の手順で作ってください`
          : `${file} を読めません (${path}): ${err.message}`,
      );
      continue;
    }
    try {
      parsed.push(JSON.parse(raw));
    } catch (err) {
      errors.push(`${file} を JSON として読めません: ${err.message}`);
    }
  }
  if (errors.length > 0) return { config: null, errors };

  return mergeConfigSources(parsed[0], parsed[1]);
}

/**
 * `bots.<key>` に必ず要るキーと、欠けたときに何を書けばよいか。
 *
 * **どれも「書き忘れても起動はする」状態だった** — 症状は起動時ではなく job の途中に出る
 * (`model` が無ければ `--model undefined` で spawn が落ち、`rolePromptFile` が無ければ
 * その bot だけ役割文なしで走る)。SETUP と README は必須と書いているので、
 * 文書のほうが正しく、検証を合わせる。
 */
export const BOT_REQUIRED_KEYS = [
  ['tokenEnv', '.env に置く Discord トークンの環境変数名。例: "MANAGER_DISCORD_TOKEN"'],
  ['displayName', 'Discord 上の表示名。例: "Manager"'],
  ['model', 'claude --model へそのまま渡るモデル名。例: "opus" / "sonnet"'],
  ['rolePromptFile', 'その bot の役割文のパス。例: "roles/worker.md" — ファイル名がそのまま役の名前になる'],
];

/**
 * `bots.<key>.runtime` に書ける値。**省略 = `claude`。**
 *
 * 綴り違いを黙って通すと、コード側は 10 箇所以上で `runtime === 'codex'` の厳密一致を見て
 * いるので**全部が claude 側へ倒れる** — `"Codex"` と書いただけで、起動する CLI も
 * `effort` / `codexInstructionsFile` の可否も `model` の要否も、まとめて黙って変わる。
 * 「どの CLI が動くか」は無症状で間違えていい設定ではないので、閉集合で縛る。
 */
export const BOT_RUNTIMES = ['claude', 'codex'];

/**
 * `runtime: "codex"` の bot では省略できるキー。
 *
 * codex の `-m` は**条件付き**で渡している (`src/codex.js`) ので、`model` を書かなければ
 * codex 側の既定モデル (`~/.codex/config.toml`) で走る。しかも `codex exec --help` は
 * 使えるモデル名を列挙しないので、**書かせると third party は当てずっぽうになる**。
 * claude は `--model` を無条件で渡すため省略できない (`src/claude.js`)。
 *
 * ただし**書いたなら効く値であること**は要る — 空文字は「設定したつもり」の典型。
 */
export const CODEX_OPTIONAL_BOT_KEYS = ['model'];

/**
 * `claudeBin` / `codexCmd` の型検証。
 *
 * **この 2 つは「起動できません」のエラー文が案内する唯一の直し先**なので、書き損じを
 * 黙って既定へ落とすと、直したつもりで同じエラーが出続ける (Opus2 指摘 2026-09-10 —
 * `"codex"` (文字列でなく) / `[]` / `42` のどれもエラー 0 で通っていた)。
 *
 * 書ける形は 2 つ: 実行ファイル名かパスの文字列 1 語 (`"claude"`)、または
 * 語の配列 (`["node", "…/cli.js"]`)。**空配列は「設定したつもり」の典型**なので落とす。
 */
export function validateCliCommands(config = {}) {
  const errors = [];
  for (const key of ['claudeBin', 'codexCmd']) {
    const value = config?.[key];
    if (value === undefined) continue;
    const ok = isNonEmptyString(value)
      || (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString));
    if (ok) continue;
    errors.push(
      `${key} は実行ファイルの名前かパスを文字列で、または語の配列で書く `
      + `(受け取った値: ${JSON.stringify(value)}／例: "claude" / `
      + '["node", "<npm prefix>/node_modules/@openai/codex/bin/codex.js"]・省略可)',
    );
  }
  return errors;
}

/**
 * 起動時 config 検証 (fail-closed)。設定漏れが「全開放」や「暗黙の権限昇格」に
 * ならないよう、identity 境界 (guildId / allowedUserIds) と各チャンネルの
 * 必須項目・型を起動前に確かめる。
 *
 * 見るのは**合成後**の config — policy 単体は guildId も allowedUserIds も持たないので、
 * 分離した後もここの必須条件は変えない (境界は解決済み config で担保する)。
 * @returns {string[]} 人間向けエラー行 (空配列 = 起動してよい)
 */
export function validateConfig(config, { contractKindOf = null, repoRoot = null } = {}) {
  const errors = [];
  if (!isPlainObject(config)) return ['設定がオブジェクトとして読めない'];

  if (!isNonEmptyString(config.guildId)) {
    errors.push(
      'guildId が未設定 — 起動を許可する Discord サーバー ID を書く (未設定を「制限なし」と解釈しない)',
    );
  }

  const ids = config.allowedUserIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(
      'allowedUserIds が空 — 起動を許可するユーザー ID を 1 件以上書く ' +
        '(許可ユーザーはローカル OS 上でコマンドを実行できるのと同等の権限を持つ)',
    );
  } else if (!ids.every(isNonEmptyString)) {
    errors.push('allowedUserIds には非空の文字列 ID だけを書く');
  }

  // owner は「人間を呼ぶ先」であって認可とは別軸なので任意。ただし書いたなら効くこと
  // を保証する — 綴り違いを黙って無視すると「メンションしたのに通知が来ない」になる
  if (config.ownerUserId !== undefined && !isNonEmptyString(config.ownerUserId)) {
    errors.push(
      'ownerUserId は非空の文字列 ID で書く (人間へのメンションを使わないなら丸ごと省く)',
    );
  }
  if (config.ownerNames !== undefined) {
    if (
      !Array.isArray(config.ownerNames) ||
      config.ownerNames.length === 0 ||
      !config.ownerNames.every(isNonEmptyString)
    ) {
      errors.push(
        `ownerNames には非空の文字列を 1 件以上書く (省略時は ${DEFAULT_OWNER_NAMES.join(' / ')})`,
      );
    } else if (!isNonEmptyString(config.ownerUserId)) {
      errors.push('ownerNames を書くなら ownerUserId も書く (ID が無いと実メンションに変換できない)');
    }
  }
  errors.push(...validateOwnerNameClash(config));
  errors.push(...validateInitiative(config, { contractKindOf, repoRoot }));
  // 自律社会 (docs/society-ledger.md)。**書いていなければ何も言わない** — 既定は off で、
  // 社会を使わない配備がこの検証で落ちることはない
  errors.push(...validateSociety(config));
  for (const [key, bot] of Object.entries(isPlainObject(config.bots) ? config.bots : {})) {
    if (!isPlainObject(bot)) {
      errors.push(`bots.${key} はオブジェクトで書く (${BOT_REQUIRED_KEYS.map(([k]) => k).join(' / ')})`);
      continue;
    }
    // どの CLI で走るか。**この 1 語が他の検証の分岐にもなる**ので、先に閉集合で縛る
    if (bot.runtime !== undefined && !BOT_RUNTIMES.includes(bot.runtime)) {
      errors.push(
        `bots.${key}.runtime: ${JSON.stringify(bot.runtime)} は不明 `
        + `(${BOT_RUNTIMES.join(' | ')} のどれか・省略時は ${BOT_RUNTIMES[0]}) `
        + '— 知らない値を黙って claude 扱いにすると、起動する CLI も model の要否も変わる',
      );
    }
    // **欠けたら起動しない。** どれも「書いてあるつもり」で落ちると、症状が起動時ではなく
    // job の途中に出る — `model` が無ければ `--model undefined` で spawn が落ち、
    // `rolePromptFile` が無ければその bot だけ役割文なしで走る
    const codexOptional = bot.runtime === 'codex' ? CODEX_OPTIONAL_BOT_KEYS : [];
    for (const [required, hint] of BOT_REQUIRED_KEYS) {
      const value = bot[required];
      if (isNonEmptyString(value)) continue;
      if (codexOptional.includes(required)) {
        // 省略は許すが、書いたなら効く値であること
        if (value === undefined) continue;
        errors.push(
          `bots.${key}.${required} は非空の文字列で書く `
          + `(runtime: "codex" では省略もできる — その場合は codex の既定モデルが使われる`
          + `／受け取った値: ${JSON.stringify(value)})`,
        );
        continue;
      }
      errors.push(
        `bots.${key}.${required} が要る (${hint}／受け取った値: ${JSON.stringify(value ?? null)})`,
      );
    }
    // 推論量はランタイムごとに値域が違う (claude の `--effort` / codex の
    // `model_reasoning_effort`)。**値域の正本は src/claude.js と src/codex.js の 1 箇所ずつ**で、
    // ここは runtime で引き分けるだけ。codex で書けるようにしたのはモデル側の制約のため —
    // `gpt-5.5` は `max` を拒むので、ユーザー ~/.codex/config.toml が `max` の環境では
    // bot ごとに下げられないと起動できない (実測 2026-09-11)
    const effort = bot.effort;
    const runtime = bot.runtime === 'codex' ? 'codex' : 'claude';
    const effortLevels = runtime === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
    if (effort !== undefined && !effortLevels.includes(effort)) {
      errors.push(
        `bots.${key}.effort: ${JSON.stringify(effort)} は runtime: "${runtime}" では使えない ` +
          `(claude: ${CLAUDE_EFFORTS.join(' | ')} ／ codex: ${CODEX_EFFORTS.join(' | ')}・省略可)`,
      );
    }
    // Codex 組み込み指示の差し替え (相談役として立てる bot の口 — src/codex.js)。
    // claude ランタイムには配線が無いので、書いたのに効かない状態を黙って通さない。
    // **ファイルの存在確認はしない** — config.js は fs を持たない (冒頭のとおり副作用なし)。
    // 読めるかどうかは doctor と、起動時の runCodex が見る
    const codexInstructions = bot.codexInstructionsFile;
    if (codexInstructions !== undefined) {
      if (bot.runtime !== 'codex') {
        errors.push(
          `bots.${key}.codexInstructionsFile は runtime: "codex" でしか使えない ` +
            '(claude ランタイムには配線されていない)',
        );
      } else if (!isNonEmptyString(codexInstructions)) {
        errors.push(
          `bots.${key}.codexInstructionsFile: ${JSON.stringify(codexInstructions)} は不正 ` +
            '(リポジトリ相対のパスを非空の文字列で書く・省略可)',
        );
      }
    }
    // duty (§3.8) は発議の巡回とイベント配信の宛先を決める。綴り違いを黙って無視すると
    // 「拾うつもりのイベントが誰にも届いていない」まま静かに動く
    errors.push(...validateBotDuties(bot, { botKey: key }));
  }

  errors.push(...validateCliCommands(config));

  // 上限の書き損じを黙って既定へ落とすと「12 のつもりが 12 でない」に化ける
  const hops = config.limits?.maxBotHops;
  if (hops !== undefined && !(Number.isSafeInteger(hops) && hops >= 0)) {
    errors.push(
      `limits.maxBotHops は 0 以上の整数で書く (受け取った値: ${JSON.stringify(hops)}／` +
        `省略時は ${DEFAULT_MAX_BOT_HOPS}・0 は bot 起点の起動を止める)`,
    );
  }

  const selfHops = config.limits?.maxSelfHops;
  if (selfHops !== undefined && !(Number.isSafeInteger(selfHops) && selfHops >= 0)) {
    errors.push(
      `limits.maxSelfHops は 0 以上の整数で書く (受け取った値: ${JSON.stringify(selfHops)}／` +
        '省略時は maxBotHops と同じ・0 は自己呼び出しを止める)',
    );
  }

  // 承認まわりの上下限。「正の整数」だけ見ると MAX_SAFE_INTEGER で実質無期限・無制限に
  // できてしまい、「短い期限・少ないカード」という前提が崩れる
  const ttl = config.limits?.toolApprovalTtlMs;
  if (ttl !== undefined && !inRange(ttl, TOOL_APPROVAL_TTL_RANGE_MS)) {
    errors.push(
      `limits.toolApprovalTtlMs は ${TOOL_APPROVAL_TTL_RANGE_MS[0]}〜${TOOL_APPROVAL_TTL_RANGE_MS[1]} ` +
        `(1 分〜24 時間) のミリ秒で書く (受け取った値: ${JSON.stringify(ttl)}／` +
        `省略時は ${DEFAULT_TOOL_APPROVAL_TTL_MS})`,
    );
  }
  // 待機上限も同じ理由で上下限を持つ。長くすると同じ作業ツリーの他チャンネルが
  // その間ずっと止まるので、上限は控えめに固定する
  const wait = config.limits?.toolApprovalWaitMs;
  if (wait !== undefined && !inRange(wait, TOOL_APPROVAL_WAIT_RANGE_MS)) {
    errors.push(
      `limits.toolApprovalWaitMs は ${TOOL_APPROVAL_WAIT_RANGE_MS[0]}〜${TOOL_APPROVAL_WAIT_RANGE_MS[1]} ` +
        `(30 秒〜10 分) のミリ秒で書く (受け取った値: ${JSON.stringify(wait)}／` +
        `省略時は ${DEFAULT_TOOL_APPROVAL_WAIT_MS}・承認待ちの間は同じ cwd の job が止まる)`,
    );
  }
  const cards = config.limits?.maxToolApprovalCards;
  if (cards !== undefined && !inRange(cards, MAX_TOOL_APPROVAL_CARDS_RANGE)) {
    errors.push(
      `limits.maxToolApprovalCards は ${MAX_TOOL_APPROVAL_CARDS_RANGE[0]}〜${MAX_TOOL_APPROVAL_CARDS_RANGE[1]} ` +
        `の整数で書く (受け取った値: ${JSON.stringify(cards)}／省略時は ${DEFAULT_MAX_TOOL_APPROVAL_CARDS})`,
    );
  }

  // 小さすぎる値を黙って既定へ落とすと「絞ったつもりが効いていない」に化ける。
  // 逆に極端に大きい値は安全弁として無意味なので、上下限で受け止める
  // **実効値同士**で見る。片方だけ書いた設定はそれ単体では妥当でも、省略側に既定値が
  // 入った結果で破れる。待機上限がカードの寿命以上だと、押せる時間より長く job が
  // 止まったままになる (期限切れのカードを押しても何も許可されない — sol 指摘 2026-08-02)
  const effectiveWait = resolveToolApprovalWaitMs(config);
  const effectiveTtl = resolveToolApprovalTtlMs(config);
  if (effectiveWait >= effectiveTtl) {
    errors.push(
      `limits.toolApprovalWaitMs (実効値 ${effectiveWait}) は ` +
        `limits.toolApprovalTtlMs (実効値 ${effectiveTtl}) より短く書く ` +
        '— カードの期限が待機上限より先に来ると、押せなくなった後も job が止まり続ける',
    );
  }

  const budget = config.limits?.transcriptCharBudget;
  if (budget !== undefined && !inRange(budget, TRANSCRIPT_CHAR_BUDGET_RANGE)) {
    errors.push(
      `limits.transcriptCharBudget は ${TRANSCRIPT_CHAR_BUDGET_RANGE[0]}〜${TRANSCRIPT_CHAR_BUDGET_RANGE[1]} ` +
        `の整数で書く (受け取った値: ${JSON.stringify(budget)}／省略時は ${DEFAULT_TRANSCRIPT_CHAR_BUDGET})`,
    );
  }

  errors.push(...validateAttachmentLimits(config.limits?.attachments));

  const channels = config.channels;
  if (channels !== undefined && !isPlainObject(channels)) {
    errors.push('channels はオブジェクトで書く');
    return errors;
  }

  for (const [name, cc] of Object.entries(channels ?? {})) {
    if (!isPlainObject(cc)) {
      errors.push(`channels.${name} はオブジェクトで書く`);
      continue;
    }
    if (!isNonEmptyString(cc.cwd)) {
      errors.push(`channels.${name}.cwd が未設定 — 作業ディレクトリのパスを書く`);
    }
    if (cc.tools !== undefined && !presetFor(cc.tools)) {
      errors.push(`channels.${name}.tools: "${cc.tools}" は不明 (readonly | standard | full)`);
    }
    if (cc.allowedTools !== undefined && !Array.isArray(cc.allowedTools)) {
      errors.push(`channels.${name}.allowedTools は配列で書く`);
    }
    if (cc.toolsExtra !== undefined && !Array.isArray(cc.toolsExtra)) {
      errors.push(`channels.${name}.toolsExtra は配列で書く`);
    }
    if (cc.permissionMode !== undefined && !PERMISSION_MODES.includes(cc.permissionMode)) {
      errors.push(
        `channels.${name}.permissionMode: ${JSON.stringify(cc.permissionMode)} は不明 `
          + `(${PERMISSION_MODES.join(' | ')})`,
      );
    }
    if (cc.hooks !== undefined && typeof cc.hooks !== 'boolean') {
      errors.push(`channels.${name}.hooks: boolean (true | false) で書く`);
    }
    if (cc.structuredOutput !== undefined && typeof cc.structuredOutput !== 'boolean') {
      errors.push(
        `channels.${name}.structuredOutput: boolean (true | false) で書く `
          + '(省略 = 有効・false でそのチャンネルだけ委譲契約と報告様式を切る)',
      );
    }
    if (cc.verify !== undefined && !isNonEmptyString(cc.verify)) {
      errors.push(`channels.${name}.verify は非空のコマンド文字列で書く`);
    }
    // verify は作者が config.json に直接書いた任意の shell コマンドを実行する。
    // allowedTools / tools プリセットの外にある作者専用の実行経路であり、承認カードや
    // エージェント出力から値を足すことはない。差し戻し機構を持たない中間モードも作らない。
    if (cc.verify !== undefined && cc.hooks !== true) {
      errors.push(`channels.${name}.verify を使うには hooks: true が必要`);
    }
    if (
      cc.verifyMaxRetries !== undefined &&
      !inRange(cc.verifyMaxRetries, VERIFY_MAX_RETRIES_RANGE)
    ) {
      errors.push(
        `channels.${name}.verifyMaxRetries は ${VERIFY_MAX_RETRIES_RANGE[0]}〜` +
          `${VERIFY_MAX_RETRIES_RANGE[1]} の整数で書く (省略時は ${DEFAULT_VERIFY_MAX_RETRIES})`,
      );
    }
    // 書き損じを黙って無視すると「参照できるつもりのディレクトリが渡っていない」に化ける
    if (
      cc.claudeAddDirs !== undefined &&
      (!Array.isArray(cc.claudeAddDirs) || !cc.claudeAddDirs.every(isNonEmptyString))
    ) {
      errors.push(
        `channels.${name}.claudeAddDirs は非空の文字列 (ディレクトリのパス) の配列で書く ` +
          '— 相対パスは cwd 基準',
      );
    }
    // 書込み解放は「設定に明示したチャンネルだけ」。綴り違いを黙って
    // read-only へ落とすと「解放したつもり」になるので起動時に落とす
    if (cc.codexSandbox !== undefined && !CODEX_SANDBOXES.includes(cc.codexSandbox)) {
      errors.push(
        `channels.${name}.codexSandbox: ${JSON.stringify(cc.codexSandbox)} は不明 ` +
          `(${CODEX_SANDBOXES.join(' | ')})`,
      );
    }
    // 編成の綴り違いは起動時に落とす。黙って無視すると「絞ったつもり」の穴になり、
    // 黙って落とすと空集合 = 全 handoff 停止になる。どちらも無症状で気付けない
    if (cc.roster !== undefined) {
      if (!Array.isArray(cc.roster) || !cc.roster.every(isNonEmptyString)) {
        errors.push(
          `channels.${name}.roster は bot キーの配列で書く ` +
            '(省略 = 制限なし / [] = このチャンネルでは handoff 禁止)',
        );
      } else {
        const known = Object.keys(isPlainObject(config.bots) ? config.bots : {});
        const unknown = cc.roster.map((k) => k.trim()).filter((k) => !known.includes(k));
        if (unknown.length > 0) {
          errors.push(
            `channels.${name}.roster に知らない bot キー: ${unknown.join(' / ')}` +
              `${known.length ? ` (使えるのは ${known.join(' / ')})` : ''}`,
          );
        }
      }
    }
    errors.push(...validateAutonomy(cc.autonomy, {
      channel: name,
      botKeys: Object.keys(isPlainObject(config.bots) ? config.bots : {}),
      hasVerify: isNonEmptyString(cc.verify),
    }));
  }
  return errors;
}
