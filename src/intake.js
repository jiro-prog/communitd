// 受付 (チャンネル直下の振り分け) の判断 — 純粋関数。設計は docs/notes/2026-10-11-intake.md。
//
// Claude Code の Projects の「入口 1 本 → 調整役が振り分け」に倣う: チャンネル直下に貼られた
// 人間の発言を受付 bot が読み、その場で答えるか、新しいスレッドを立てるか、作業中のスレッドへ
// 回すかを決める。**決めるのはモデル、実行するのはブリッジ** — 受付は構造化出力で行動を返し、
// ブリッジがここで検査してから実行する (表に無いスレッドや呼べない担当へ「回したつもり」を作らない)。
//
// I/O は持たない。Discord の取得・runClaude・投稿は src/bridge/intake.js。

import { MAX_ITEM_CHARS, MAX_PROPOSED_TASKS, MAX_TEXT_CHARS } from './contract.js';
import { isLive } from './jobruns.js';
import { neutralizeRawMentions } from './mentions.js';
import { msOfTime } from './time.js';

/** 受付が使える組み込みツール。**読むだけ** (書けない・shell なし)。MCP は配線側で遮断する */
export const INTAKE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

/** bot に effort を書いていないときの既定。Projects の調整役の既定 (low) を借用 */
export const DEFAULT_INTAKE_EFFORT = 'low';

/** 受付 1 回の時間上限。**仮置き** (根拠なし — 実測で詰める) */
export const DEFAULT_INTAKE_TIMEOUT_MS = 10 * 60 * 1000;

/** 文脈に入れるチャンネル直下の直近の発言数。**仮置き** */
export const RECENT_CHANNEL_MESSAGES = 20;

/** 直近の発言 1 件あたりの文字数。**仮置き** — 長い貼り付けで表と投稿が押し出されないように */
export const RECENT_MESSAGE_CHARS = 500;

/**
 * スレッド表に載せる窓。Projects はスレッドを **1 週間動きがなければ自動で Resolved** にする —
 * その線を借用して、1 週間動いていないスレッドは振り分け先の候補から外す (作業中・板の未完了は窓に関係なく載せる)
 */
export const THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** スレッド表の行数の上限。**仮置き** */
export const MAX_THREAD_ROWS = 30;

/** 1 回の受付で起こせる行動の数。起票の上限 (`MAX_PROPOSED_TASKS`) にそろえる */
export const MAX_INTAKE_ACTIONS = MAX_PROPOSED_TASKS;

/** 新しいスレッドの名前の長さ。今の直メンションで立つスレッドと同じ (src/bridge/messages.js) */
export const MAX_THREAD_TITLE_CHARS = 80;

/** 中継に添える元の投稿の引用の長さ。**仮置き** — 全文は元投稿へのリンクで読める */
export const MAX_QUOTE_CHARS = 1000;

export const INTAKE_ACTION_KINDS = Object.freeze(['new_thread', 'route']);

/**
 * 受付の出力の様式。**キーは ASCII** (日本語のプロパティ名は API が 400 を返す — src/contract.js の FIELD_LABELS)。
 * 行動の 2 種は 1 つの形にまとめ、種類ごとの必須 (`title` / `thread_id`) は `planIntake` が見る —
 * 形を分けると、片方の書き損じで出力全体が落ちて「その場で答える」まで失われる。
 */
export const INTAKE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['body', 'actions'],
  properties: {
    body: {
      type: 'string',
      maxLength: MAX_TEXT_CHARS,
      description:
        '本文 — チャンネルへそのまま投稿される。その場で答えるならその答え、振り分けたなら'
        + '「何をどこへ回したか」。制御フッター ([[handoff:...]] など) は書かない (起動の経路は actions だけ)',
    },
    actions: {
      type: 'array',
      maxItems: MAX_INTAKE_ACTIONS,
      description: '振り分けの行動。その場で答えたときは空配列',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'assignee', 'brief'],
        properties: {
          kind: {
            type: 'string',
            enum: [...INTAKE_ACTION_KINDS],
            description: 'new_thread = 新しいスレッドを立てる / route = 表にある既存のスレッドへ回す',
          },
          title: {
            type: 'string',
            maxLength: MAX_THREAD_TITLE_CHARS,
            description: 'new_thread のときのスレッド名 (何の仕事か一目で分かる短い題)',
          },
          thread_id: {
            type: 'string',
            description: 'route のときの回し先。スレッド表の ID をそのまま書く (表に無い ID は実行されない)',
          },
          assignee: {
            type: 'string',
            description: '起こす担当の bot キー (「回せる担当」の一覧から選ぶ)',
          },
          brief: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description:
              '担当への依頼文。スレッドに投稿され、担当はこれと元の投稿を読んで動く。'
              + '投稿のどの部分をなぜこの担当へ回すのかを自己完結で書く',
          },
        },
      },
    },
  },
});

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * この発言を受付が受けるか (受付 bot の入口で使う)。
 *
 * - 受付が有効なチャンネルの**直下**だけ (スレッドの中は人が直接書ける — 受付の出番ではない)
 * - **人間の発言だけ**。bot・メンテ用 bot・受付自身の中継は受けない (受付が受付を起こす輪を作らない)
 * - 自分以外の自前 bot へのメンションがあれば受けない — その bot へ直行する逃げ道 (作者の裁定 2026-10-11)。
 *   受付 bot への明示メンションは受ける
 *
 * @param {object} p
 * @param {boolean} p.intakeEnabled チャンネルの `intake: true`
 * @param {boolean} p.isThread
 * @param {string} p.senderKind src/authz.js の senderKindOf
 * @param {string[]} [p.mentionedBotUserIds] 本文でメンションされた自前 bot のユーザー ID
 * @param {string} p.intakeBotUserId
 */
export function isIntakePost({
  intakeEnabled = false, isThread = false, senderKind = null, mentionedBotUserIds = [], intakeBotUserId = null,
} = {}) {
  if (intakeEnabled !== true || isThread) return false;
  if (senderKind !== 'human') return false;
  if (!isText(intakeBotUserId)) return false;
  return mentionedBotUserIds.every((id) => id === intakeBotUserId);
}

/**
 * 受付 bot 以外の bot が、この発言で起動してよいか。
 *
 * - **受付の中継 (`relay`) はチャンネル直下では何も起こさない。** 中継は人間の重みで通す
 *   (src/authz.js) ので、受付のチャンネルへの返信に `<@id>` が紛れると、頼まれていない仕事が
 *   人間の起動として立つ。中継が起動してよいのはスレッドの中の専用の 1 通だけ
 * - 受付が有効なチャンネルの直下では**明示メンションだけ**を通し、返信での起動は通さない。
 *   返信は受付が受ける発言でもあるので、両方が動くと 1 通で 2 本走る。スレッドの中は今までどおり
 *
 * @param {{intakeEnabled: boolean, isThread: boolean, via: string|null, senderKind?: string|null}} p
 *   via は resolveTrigger の戻り、senderKind は src/authz.js の senderKindOf
 */
export function allowsDirectTrigger({ intakeEnabled = false, isThread = false, via = null, senderKind = null } = {}) {
  if (isThread) return true;
  if (senderKind === 'relay') return false;
  if (intakeEnabled !== true) return true;
  return via === 'mention';
}

/**
 * 受付が書いた文字列 (と中継で引用する元の投稿) を、通知にも起動にもならない形へ潰す。
 * **役割文の「メンションを書かない」は願いで、これが機構** — 中継は人間の重みで通るので、
 * 本文の `<@id>` がそのまま残ると、専用の起動の 1 通より先に別の bot が人間の起動として立つ。
 */
const inert = (text) => neutralizeRawMentions(text).text;

/** スレッドの状態の語彙 (受付が振り分けに使う。/status の語彙とは別 — 粒度は「回してよいか」が分かる程度) */
export const THREAD_STATES = Object.freeze([
  'working',   // job が走っている・レーン待ち
  'human',     // 人の番 (報告済み・質問中・止められた)
  'handoff',   // 次の担当を呼んだ
  'review',    // レビュー待ち
  'recovery',  // 止まっている (起こし直し待ち)
  'reconcile', // 前のプロセスの結末が分からない
  'done',      // 板のタスクが終わった (merged / dropped)
  'unknown',
]);

const STATE_LABELS = Object.freeze({
  working: '作業中',
  human: '人の番 (報告済み・質問中)',
  handoff: '次の担当へ渡した',
  review: 'レビュー待ち',
  recovery: '止まっている (起こし直し待ち)',
  reconcile: '要照合',
  done: '完了',
  unknown: '不明',
});

export function threadStateLabel(state) {
  return STATE_LABELS[state] ?? STATE_LABELS.unknown;
}

/**
 * スレッドの最後の実行記録 (と板のタスク) から状態を出す。
 * @param {object|null} run src/jobruns.js の記録 (そのスレッドで最後に受け付けた 1 本)
 * @param {{task?: object|null}} [opts]
 */
export function threadStateOf(run, { task = null } = {}) {
  if (task && ['merged', 'dropped'].includes(task.state)) return 'done';
  if (run && isLive(run)) return run.stage === 'reconcile' ? 'reconcile' : 'working';
  if (task?.state === 'blocked') return 'human';
  if (!run) return task?.state === 'review' ? 'review' : 'unknown';
  switch (run.next) {
    case 'bot': return 'handoff';
    case 'reviewer': return 'review';
    case 'human': return 'human';
    case 'recovery': return 'recovery';
    case 'none': return 'human';
    default: return 'unknown';
  }
}

const timeOf = (value) => {
  const ms = msOfTime(value);
  return Number.isFinite(ms) ? ms : null;
};

/** 記録の最後の動きの時刻 (終わっていれば終端、走っていれば最後の観測、どちらも無ければ受付) */
function lastMoveOf(run) {
  return [run.endedAt, run.observedAt, run.startedAt, run.acceptedAt]
    .map(timeOf)
    .filter((t) => t !== null)
    .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
}

/**
 * 受付に見せる「このチャンネルのスレッド表」。**スレッドの全文は渡さない** — Projects の調整役と同じく、
 * 振り分けに要るのは何の仕事か・誰が持っているか・いまどうなっているか。
 *
 * 載せるのはブリッジが知っている仕事 (実行記録か板のタスクがあるスレッド) だけ。人だけで話している
 * スレッドは載らない。窓 (`windowMs`) より古いものは外すが、作業中と板の未完了は窓に関係なく載せる。
 *
 * @param {object} p
 * @param {Array<{id: string, name?: string, archived?: boolean}>} [p.threads] Discord から取れたスレッド
 * @param {object[]} [p.runs] このチャンネルの実行記録
 * @param {object[]} [p.tasks] このチャンネルの板のタスク
 * @param {number} [p.now]
 * @param {number} [p.windowMs]
 * @param {number} [p.maxRows]
 * @returns {{rows: object[], omitted: number}}
 */
export function buildThreadTable({
  threads = [], runs = [], tasks = [], now = Date.now(), windowMs = THREAD_WINDOW_MS, maxRows = MAX_THREAD_ROWS,
} = {}) {
  const info = new Map();
  for (const t of threads) if (t && isText(t.id)) info.set(t.id, t);
  const taskOf = new Map();
  for (const task of tasks) if (task && isText(task.threadId)) taskOf.set(task.threadId, task);

  const latest = new Map();
  const lastMove = new Map();
  for (const run of runs) {
    if (!run || !isText(run.threadId)) continue;
    const prev = latest.get(run.threadId);
    const accepted = timeOf(run.acceptedAt) ?? Number.NEGATIVE_INFINITY;
    if (!prev || accepted >= (timeOf(prev.acceptedAt) ?? Number.NEGATIVE_INFINITY)) latest.set(run.threadId, run);
    lastMove.set(run.threadId, Math.max(lastMove.get(run.threadId) ?? Number.NEGATIVE_INFINITY, lastMoveOf(run)));
  }

  const ids = new Set([...latest.keys(), ...taskOf.keys()]);
  const rows = [];
  for (const threadId of ids) {
    const run = latest.get(threadId) ?? null;
    const task = taskOf.get(threadId) ?? null;
    const state = threadStateOf(run, { task });
    const moved = lastMove.get(threadId);
    const lastActiveAt = Number.isFinite(moved) ? moved : null;
    const openTask = task && !['merged', 'dropped'].includes(task.state);
    const recent = lastActiveAt !== null && now - lastActiveAt <= windowMs;
    if (!(recent || state === 'working' || openTask)) continue;
    const t = info.get(threadId);
    rows.push({
      threadId,
      name: isText(t?.name) ? t.name : null,
      archived: typeof t?.archived === 'boolean' ? t.archived : null,
      botKey: run?.botKey ?? null,
      state,
      taskId: task?.id ?? null,
      taskState: task?.state ?? null,
      lastActiveAt,
    });
  }
  rows.sort((a, b) => (b.lastActiveAt ?? Number.NEGATIVE_INFINITY) - (a.lastActiveAt ?? Number.NEGATIVE_INFINITY));
  return { rows: rows.slice(0, maxRows), omitted: Math.max(0, rows.length - maxRows) };
}

/** 「12 分前」のような相対時刻 (受付が新しさを比べられれば足りる粒度) */
export function agoLabel(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '不明';
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 60) return `${min} 分前`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} 時間前`;
  return `${Math.round(hours / 24)} 日前`;
}

/** スレッド表 1 行 */
export function formatThreadRow(row, { now = Date.now() } = {}) {
  const parts = [
    `担当: ${row.botKey ?? '不明'}`,
    `状態: ${threadStateLabel(row.state)}`,
    `最後の動き: ${agoLabel(row.lastActiveAt ?? Number.NaN, now)}`,
  ];
  if (row.taskId != null) parts.push(`板のタスク #${row.taskId} (${row.taskState ?? '不明'})`);
  if (row.archived) parts.push('アーカイブ済み');
  return `- ${row.threadId} 「${row.name ?? '(名前不明)'}」 ${parts.join(' / ')}`;
}

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…(以下略)` : s;
};

/**
 * 受付へ渡すプロンプト (データ部分)。振り分けの基準と出し方は役割文 (roles/intake.md) にある。
 *
 * @param {object} p
 * @param {{authorName: string, content: string, attachments?: string[]}} p.post 受けた投稿
 * @param {Array<{authorName: string, content: string, isBot?: boolean}>} [p.recent] 直下の直近の発言 (古い順・この投稿の前まで)
 * @param {object[]} [p.rows] buildThreadTable の rows
 * @param {number} [p.omitted]
 * @param {Array<{key: string, displayName?: string, role?: string|null}>} [p.assignees] 回せる担当
 * @param {number} [p.now]
 */
export function buildIntakePrompt({
  post, recent = [], rows = [], omitted = 0, assignees = [], now = Date.now(),
} = {}) {
  const lines = ['# 受付する投稿', `[${post?.authorName ?? '不明'}]`, String(post?.content ?? '')];
  const files = (post?.attachments ?? []).filter(isText);
  if (files.length > 0) lines.push(`(添付: ${files.join(' / ')} — 中身はここには無い。担当はスレッドから元の投稿を開いて読める)`);

  lines.push('', '# チャンネル直下の直近の発言 (古い順・この投稿の前まで)');
  if (recent.length === 0) lines.push('(なし)');
  for (const m of recent) {
    lines.push(`[${m.authorName ?? '不明'}${m.isBot ? ' (bot)' : ''}]: ${clip(m.content, RECENT_MESSAGE_CHARS)}`);
  }

  lines.push('', '# このチャンネルのスレッド (最後の動きが新しい順)');
  if (rows.length === 0) lines.push('(なし — 回せる既存のスレッドは無い)');
  for (const row of rows) lines.push(formatThreadRow(row, { now }));
  if (omitted > 0) lines.push(`(ほかに ${omitted} 本 — 古いので載せていない)`);

  lines.push('', '# 回せる担当 (assignee にはキーを書く)');
  if (assignees.length === 0) lines.push('(なし — スレッドへは回せない。その場で答える)');
  for (const a of assignees) {
    const role = isText(a.role) ? ` — ${a.role}` : '';
    lines.push(`- ${a.key}${isText(a.displayName) ? ` (${a.displayName})` : ''}${role}`);
  }
  return lines.join('\n');
}

/**
 * 受付の出力の外形だけを見る。行動 1 件ずつの検査は `planIntake` — 1 件の書き損じで
 * 本文 (その場の答え・何をどこへ回したか) まで捨てない。
 * @returns {{ok: true, value: {body: string, actions: unknown[]}} | {ok: false, error: string}}
 */
export function validateIntakeOutput(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '出力がオブジェクトではない' };
  }
  if (!isText(value.body)) return { ok: false, error: '本文 (body) が空' };
  if (value.actions !== undefined && !Array.isArray(value.actions)) {
    return { ok: false, error: 'actions が配列ではない' };
  }
  return { ok: true, value: { body: value.body.trim(), actions: value.actions ?? [] } };
}

/**
 * 受付の出力 → ブリッジが実行する計画。**実行してよいものだけを残し、落としたものは理由つきで返す。**
 *
 * - 呼べない担当 (`assignees` に無いキー) は落とす
 * - route は**表にあるスレッドだけ** (幻の ID・別チャンネルのスレッドへ投げない)。アーカイブ済みは unarchive を付ける
 * - 同じスレッドへの 2 通目の route は落とす (1 回の受付で同じ担当を 2 回起こさない)
 * - 上限 (`maxActions`) を超えた分は落とす
 *
 * @param {object} p
 * @param {{body: string, actions: unknown[]}} p.output validateIntakeOutput の value
 * @param {object[]} [p.rows] buildThreadTable の rows
 * @param {string[]} [p.assigneeKeys] 回せる担当の bot キー
 * @param {number} [p.maxActions]
 * @returns {{body: string, actions: object[], rejected: Array<{index: number, reason: string}>}}
 */
export function planIntake({ output, rows = [], assigneeKeys = [], maxActions = MAX_INTAKE_ACTIONS } = {}) {
  const known = new Map(rows.map((r) => [r.threadId, r]));
  const actions = [];
  const rejected = [];
  const routed = new Set();
  (output?.actions ?? []).forEach((raw, index) => {
    const reject = (reason) => rejected.push({ index, reason });
    if (actions.length >= maxActions) return reject(`1 回に起こせるのは ${maxActions} 件まで`);
    if (typeof raw !== 'object' || raw === null) return reject('行動の形が読めない');
    if (!INTAKE_ACTION_KINDS.includes(raw.kind)) return reject(`知らない行動: ${JSON.stringify(raw.kind ?? null)}`);
    const assignee = isText(raw.assignee) ? raw.assignee.trim() : '';
    if (!assigneeKeys.includes(assignee)) return reject(`呼べない担当: ${JSON.stringify(raw.assignee ?? null)}`);
    if (!isText(raw.brief)) return reject('依頼文 (brief) が空');
    const brief = raw.brief.trim();
    if (raw.kind === 'new_thread') {
      const title = oneLine(raw.title).slice(0, MAX_THREAD_TITLE_CHARS);
      if (!title) return reject('新しいスレッドの題 (title) が空');
      actions.push({ kind: 'new_thread', title, assignee, brief });
      return undefined;
    }
    const threadId = isText(raw.thread_id) ? raw.thread_id.trim() : '';
    const row = known.get(threadId);
    if (!row) return reject(`表に無いスレッド: ${JSON.stringify(raw.thread_id ?? null)}`);
    if (routed.has(threadId)) return reject(`同じスレッド (${threadId}) へ 2 回回そうとした`);
    routed.add(threadId);
    actions.push({ kind: 'route', threadId, assignee, brief, unarchive: row.archived === true });
    return undefined;
  });
  return { body: output?.body ?? '', actions, rejected };
}

/**
 * 担当を起こす前にスレッドへ置く本文 (メンションは載せない — 起動は後に送る専用の 1 通、
 * src/mentions.js の sendControlMention の流儀)。依頼文と引用の生メンションは潰す (`inert`)。
 *
 * `original` は**元の投稿がスレッドの起点ではないとき**に添える (既存スレッドへの中継・1 投稿から
 * 複数立てたとき)。起点から立てた 1 本は、起点の発言を src/bridge/prompt.js の fetchStarter が拾う。
 *
 * @param {object} p
 * @param {string} p.brief
 * @param {{authorName: string, content: string, url?: string}|null} [p.original]
 */
export function handoffBody({ brief, original = null } = {}) {
  const lines = ['📥 受付からの依頼', inert(String(brief ?? '').trim())];
  if (original) {
    lines.push('', `元の投稿 — ${inert(original.authorName ?? '不明')}${isText(original.url) ? ` (${original.url})` : ''}:`);
    for (const line of inert(clip(original.content, MAX_QUOTE_CHARS)).split('\n')) lines.push(`> ${line}`);
  }
  return lines.join('\n');
}

/**
 * チャンネルへの返信。受付の本文 + 実行した行動のリンク + 実行しなかったものの理由。
 * **どこへ回したかは機械の側でも必ず出す** — 本文に書き忘れても、人が行き先を辿れるように。
 * 本文と理由の生メンションは潰す (`inert`) — チャンネル直下の中継が何かを起こさないように。
 *
 * @param {object} p
 * @param {string} p.body
 * @param {Array<{kind: string, threadId: string|null, assignee: string, error?: string|null}>} [p.done]
 * @param {Array<{index: number, reason: string}>} [p.rejected]
 */
export function intakeReply({ body, done = [], rejected = [] } = {}) {
  const lines = [inert(String(body ?? '').trim())];
  const links = [];
  for (const d of done) {
    const where = d.threadId ? `<#${d.threadId}>` : '(スレッドを立てられなかった)';
    const what = d.kind === 'route' ? '中継' : '新規';
    links.push(d.error ? `⚠️ ${what} ${where} → ${d.assignee}: ${inert(d.error)}` : `→ ${what} ${where} (${d.assignee})`);
  }
  for (const r of rejected) links.push(`⚠️ 実行しなかった (${r.index + 1} 件目): ${inert(r.reason)}`);
  if (links.length > 0) lines.push('', ...links);
  return lines.join('\n');
}
