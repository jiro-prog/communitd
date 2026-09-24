// 裁定の受信箱。
//
// 社会が作者に求めるのは裁定だけのはずなのに、その入口が 3 系統に散っている
// (停止通知の実メンション・稟議カード・blocked タスクの ⛔ 1 行)。ここは
// **作者が見る場所を 1 つにする**ための台帳 1 つとビュー 1 つ。
//
// **正本は動かさない。** 稟議 (ProposalStore) と要人間 (TaskBoardStore) は既に
// 永続しているので描画のときに読むだけで、台帳を新設するのは記録の無かった
// 停止通知だけ。二重管理を作ると、どちらが本当か分からない状態が残る。
//
// **永続する** — 承認台帳 (src/approvals.js) とは逆だが理由は同じ。あちらは
// TTL 30 分で再起動に失効するのが正しい短命な承認で、こちらは数時間〜数日待つ
// ものなので、消えると「呼んだのに誰も来ない」が残る (proposals と同じ側)。

import { JsonStore } from './store.js';
import { remainingJobs } from './board.js';
import { msOfTime } from './time.js';
import { nextOperationFor, statusLabel } from './taskstatus.js';

/** 台帳へ保存する要旨の上限 */
export const MAX_SUMMARY_CHARS = 140;

/**
 * **一覧の 1 行に出す要旨の上限**。台帳の 140 字とは別物。
 *
 * 140 字のまま出すと 10 行で 1900 字に達し、後ろの節が丸ごと消える
 * (notify 10 件 + 稟議 2 件で「要人間」が落ちるのを実測 — レビュー指摘 2026-09-02)。
 * 一覧は「どれを見に行くか」を決めるためのもので、中身はスレッドで読む。
 */
export const MAX_ROW_SUMMARY_CHARS = 60;

/** `/inbox` 1 通の上限 (formatProposalQueue と同じ値) */
export const MAX_INBOX_CHARS = 1900;

/** 1 節に並べる上限 (溢れた分は件数だけ出す) */
export const MAX_SECTION_ROWS = 10;

/** この 1 行が出る状態が社会の正常 */
export const EMPTY_INBOX = '作者を待っているものはありません';

/** 節ごとに取り置く `… ほか N 件` の 1 行ぶん */
const OVERFLOW_RESERVE = 20;

/** 閉じ方。人間の発言で閉じたのか、作者が手で閉じたのかを区別して残す */
export const CLOSED_BY = Object.freeze(['human-reply', 'manual']);

/** 制御フッター行 (`[[notify:owner]]` など) だけの行 */
const MARKER_ONLY_LINE = /^[ \t]*\[\[[^\]\n]*\]\][ \t]*$/;

/** コードフェンスの開始 / 終了行 */
const FENCE_LINE = /^[ \t]*`{3,}/;

/**
 * 停止通知の要旨。**本文の最後の非空段落**を切り出す。
 *
 * bot は停止契約に当たると末尾に状況と質問を書く (共通規定) ので、末尾の段落が
 * 「何を聞かれているか」である確率がいちばん高い。契約スキーマに「質問」欄を足す
 * のは protocol を上げる変更なので、まずここで足りるかを見る。
 *
 * 制御フッター行は落とす — 呼び出し側 (resolveOutgoingText) が除いた本文が来る
 * 想定だが、生の応答を渡されても要旨が `[[notify:owner]]` にならないようにする。
 *
 * **コードブロックは段落に割る前に、行単位で落とす。** 質問の後ろにコマンド例や
 * エラー全文を貼る書き方は普通にあり、そのまま拾うと要旨が「```text ok 1119 …」に
 * なって何を聞かれているか分からなくなる (レビュー指摘 2026-09-02)。
 *
 * **段落単位で落とすと質問ごと消える。** bot は質問の直後の行からフェンスを開くことが
 * 多く (間に空行を置かない)、そのときフェンスと質問文は同じ段落なので、段落を捨てると
 * 要旨が空になる — いちばん要る 1 行が、いちばん要る場面で消える
 * (差し戻し 2 回目で再現 2026-09-02)。だから落とすのは**フェンスの中の行だけ**。
 *
 * @param {string} text 本文 (構造化応答なら `本文` フィールド)
 * @returns {string} 1 行に均した要旨 (空なら空文字)
 */
export function summarizeForInbox(text, { max = MAX_SUMMARY_CHARS } = {}) {
  const kept = [];
  let inFence = false;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    // 開きも閉じも落とす。**閉じ忘れたブロックは末尾まで落ちる** — 閉じ忘れは事故なので、
    // そこから下を本文として拾うより、拾わない側へ倒す
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || MARKER_ONLY_LINE.test(line)) continue;
    kept.push(line);
  }
  const paragraphs = kept.join('\n').split(/\n[ \t]*\n/).filter((p) => p.trim() !== '');
  const picked = (paragraphs.at(-1) ?? '').replace(/\s+/g, ' ').trim();
  return picked.length > max ? `${picked.slice(0, max)}…` : picked;
}

/**
 * 停止通知の台帳 (`data/inbox.json`)。
 *
 * entry: `{ id, channel, threadId, botKey, summary, messageId, openedAt, closedAt, closedBy }`
 *
 * **task との結び付けは保存しない。** 描画のときに `board.findByThread` で引く —
 * 保存すると task の state が変わったときに台帳だけが古びる。
 */
export class InboxStore extends JsonStore {
  /**
   * @returns {object|null} 手で編集された値・古い形は無いものとして扱う
   *
   * **自分が持っているキーだけを見る。** 素の添字だと `/inbox close:__proto__` が
   * `Object.prototype` を掴んで「閉じました」と答え、`entry.id` が undefined のまま
   * 保存されて台帳に `"undefined"` キーのゴミが残る (レビューで再現 2026-09-02)。
   */
  get(id) {
    const key = String(id);
    if (!Object.hasOwn(this.data, key)) return null;
    const entry = this.data[key];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  /** id 昇順 (ボードと同じ並び) */
  list({ open = null } = {}) {
    return Object.keys(this.data)
      .map((key) => this.get(key))
      .filter((entry) => entry !== null)
      .filter((entry) => open === null || isOpen(entry) === open)
      .sort((a, b) => {
        const diff = (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0);
        return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
      });
  }

  /** まだ作者を待っているもの */
  openList() {
    return this.list({ open: true });
  }

  /** そのスレッドで開いている 1 件 (1 スレッド 1 open) */
  findOpenByThread(threadId) {
    if (threadId === null || threadId === undefined || threadId === '') return null;
    const key = String(threadId);
    return this.openList().find((entry) => entry.threadId === key) ?? null;
  }

  nextId() {
    let max = 0;
    for (const key of Object.keys(this.data)) {
      const n = Number.parseInt(key, 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  /**
   * 通知を記録する。**呼ぶのは実メンションを送れたときだけ** —
   * 届いていない通知を「待ち」に数えると、作者は誰も呼んでいない行を追うことになる。
   *
   * **1 スレッド 1 open。** 同じスレッドに開いている記録があれば追加せず、
   * 要旨・時刻・メッセージ ID・**呼んだ bot** を新しい方で上書きする
   * (催促で件数を増やさない)。botKey を据え置くと、要旨は催促した bot のものなのに
   * 「誰から」が最初に呼んだ bot のまま、という行になる (レビュー指摘 2026-09-02)。
   * 渡されなかった値だけは元のまま残す (消しに来たのではなく、書かれなかっただけ)。
   *
   * @returns {object} 作った / 更新した entry
   */
  open({ channel = null, threadId, botKey = null, summary = '', messageId = null } = {}, { now = Date.now() } = {}) {
    const thread = String(threadId ?? '');
    if (thread === '') throw new Error('受信箱の記録には threadId が必要です');
    const at = new Date(now).toISOString();
    const existing = this.findOpenByThread(thread);
    if (existing) {
      const next = {
        ...existing,
        channel: asText(channel) ?? existing.channel,
        botKey: asText(botKey) ?? existing.botKey,
        summary: String(summary ?? ''),
        messageId: messageId ?? null,
        openedAt: at,
      };
      this.write(next.id, next);
      return next;
    }
    const id = this.nextId();
    const entry = {
      id,
      channel: asText(channel),
      threadId: thread,
      botKey: asText(botKey),
      summary: String(summary ?? ''),
      messageId: messageId ?? null,
      openedAt: at,
      closedAt: null,
      closedBy: null,
    };
    this.write(id, entry);
    return entry;
  }

  /**
   * スレッドに人間が発言したので閉じる。
   *
   * 判定は `hops.reset` と**同じ条件**に乗せる — 会話の主導権が人間へ戻った瞬間 =
   * 質問に何か返した瞬間、とみなす。既読ボタンを押させると、押し忘れで受信箱が腐る。
   *
   * @returns {object[]} 閉じた entry (無ければ空配列)
   */
  closeByThread(threadId, { now = Date.now() } = {}) {
    const thread = String(threadId ?? '');
    if (thread === '') return [];
    const targets = this.openList().filter((entry) => entry.threadId === thread);
    return targets.map((entry) => this.markClosed(entry, 'human-reply', now));
  }

  /**
   * `/inbox close:<id>` — 別スレッドで答えたときの手動の閉じ方。
   * @returns {object|null} 閉じた entry (見つからない / 既に閉じているときは null)
   */
  close(id, { now = Date.now() } = {}) {
    const entry = this.get(id);
    if (!entry || !isOpen(entry)) return null;
    return this.markClosed(entry, 'manual', now);
  }

  markClosed(entry, closedBy, now) {
    const next = { ...entry, closedAt: new Date(now).toISOString(), closedBy };
    this.write(next.id, next);
    return next;
  }

  write(id, entry) {
    this.commit({ ...this.data, [String(id)]: entry });
  }
}

/** まだ閉じていないか (壊れた値は「閉じている」側へ倒す — 数えないほうが害が小さい) */
function isOpen(entry) {
  return Boolean(entry) && (entry.closedAt === null || entry.closedAt === undefined);
}

/** 省略された値は null のまま (空文字を「そういう名前」として保存しない) */
function asText(value) {
  return value === null || value === undefined ? null : String(value);
}

/**
 * `/inbox` の本文。**作者が「これを返すと何本動くか」を 1 行で分かる**のが目的。
 *
 * 3 節とも**待たせている時間が長い順**。手本は `formatProposalQueue`
 * (src/adjudication.js) で、1900 字で切るのも同じ。
 *
 * @param {object} p
 * @param {object[]} p.notifies InboxStore.openList()
 * @param {object[]} p.proposals ProposalStore.openList() (class org / deliberating をここで絞る)
 * @param {object[]} p.tasks     TaskBoardStore.list() (state blocked をここで絞る)
 * @param {(threadId: string) => object|null} [p.findTask] 停止通知が止めている task
 */
export function formatInbox({
  notifies = [],
  proposals = [],
  tasks = [],
  recoveries = [],
  now = Date.now(),
  escape = (s) => s,
  findTask = () => null,
  limit = MAX_SECTION_ROWS,
} = {}) {
  const stopped = [...asArray(notifies)]
    .filter((entry) => entry && isOpen(entry))
    .sort(byWaitedLongest((entry) => entry.openedAt));
  const org = [...asArray(proposals)]
    .filter((p) => p?.class === 'org' && p?.state === 'deliberating')
    .sort(byWaitedLongest(deliberatingSince));
  const blocked = [...asArray(tasks)]
    .filter((task) => task?.state === 'blocked')
    .sort(byWaitedLongest((task) => task.updatedAt ?? task.createdAt));
  // 復旧待ち: in-progress / review のまま止まっている仕事。**同じ問題を二重に見せない** —
  // 停止・質問に載っているスレッドと、要人間 (blocked) の task はここには出さない
  const stoppedThreads = new Set(stopped.map((entry) => String(entry.threadId)));
  const recovering = [...asArray(recoveries)]
    .filter((row) => row?.task && row?.status && !stoppedThreads.has(String(row.task.threadId)))
    .filter((row) => row.task.state !== 'blocked')
    .sort(byWaitedLongest((row) => row.status.since));

  if (stopped.length === 0 && org.length === 0 && blocked.length === 0 && recovering.length === 0) return EMPTY_INBOX;

  const blocks = [
    block('停止・質問', stopped, limit, (entry) => {
      const task = safeFindTask(findTask, entry.threadId);
      return `#${escape(String(entry.id))} ${escape(String(entry.botKey ?? '?'))}`
        + ` ${elapsed(entry.openedAt, now)} ${quote(entry.summary, escape)}`
        + ` ${holding(task ? `task #${task.id} ${task.state}` : 'task 無し')}${link(entry.threadId)}`;
    }),
    block('稟議', org, limit, (p) => {
      const taskIds = Array.isArray(p.taskIds) ? p.taskIds : [];
      return `#${escape(String(p.id))} ${escape(String(p.raisedBy ?? '?'))}`
        + ` ${elapsed(deliberatingSince(p), now)}`
        + ` \`${escape(String(p.input?.kind ?? '?'))}\` ${quote(p.input?.summary, escape)}`
        + ` ${holding(taskIds.length > 0 ? `task ${taskIds.map((id) => `#${escape(String(id))}`).join(' ')}` : 'task 無し')}`
        + `${link(p.origin?.threadId)}`;
    }),
    block('要人間', blocked, limit, (task) => (
      `#${escape(String(task.id))} ${elapsed(task.updatedAt ?? task.createdAt, now)}`
      + ` ${quote(task.title, escape)} ${holding(`残 job ${remainingJobs(task)}`)}${link(task.threadId)}`
    )),
    // 1 行 = `#id 経過 「題」 (状態: 理由 → 次の操作) → スレッド`。理由は 1 行で切る
    block('復旧待ち', recovering, limit, ({ task, status }) => (
      `#${escape(String(task.id))} ${elapsed(status.since, now)} ${quote(task.title, escape)}`
      + ` ${holding(`${escape(statusLabel(status.status))}: ${escape(oneLine(status.reason, 80))}`
        + `${nextOperationFor(status) ? ` → ${nextOperationFor(status)}` : ''}`)}${link(task.threadId)}`
    )),
  ];
  // 閉じるのは機械 — ただし別スレッドで答えた分だけは機械に分からない。
  // 復旧待ちも機械が閉じる (状態が解消したら消える) — 雑談を一言返しただけでは閉じない
  const footers = [];
  if (stopped.length > 0) footers.push('— 停止・質問はそのスレッドに返信すれば閉じます (別で答えたときは `/inbox close:<id>`)');
  if (recovering.length > 0) footers.push('— 復旧待ちは仕事が動き出せば消えます (起こし直すのはそのスレッドで `/retry`)');
  return layout(blocks, footers.join('\n'), MAX_INBOX_CHARS);
}

/** 改行と連続空白を潰して n 字で切る */
function oneLine(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** `/status` (src/status.js) も同じ組版を使う — 節の見出しと先頭 1 行を必ず残す流儀を揃える */
export { block as sectionBlock, layout as layoutBlocks };

/** 1 節ぶんの材料。**行は上限まで作るだけ**で、何行出すかは layout が決める */
function block(title, items, limit, describe) {
  return {
    head: `**${title} (${items.length} 件)**`,
    rows: items.slice(0, limit).map((item) => `・${describe(item)}`),
    total: items.length,
  };
}

/**
 * 節を上限へ詰める。**どの節も見出しと先頭 1 行は必ず出す。**
 *
 * 素直に連結して末尾を切ると、上の節が長いだけで下の節が丸ごと消える
 * (notify 10 件 + 稟議 2 件で「要人間」が落ちるのを実測 — レビュー指摘 2026-09-02)。
 * **「作者を待っているものが 3 系統ある」ことは、各行が全部読めることより先に伝わるべき** —
 * 消えた節は「無い」と読まれるが、削られた行は見出しの件数と `… ほか N 件` に残る。
 */
function layout(blocks, footer, max) {
  const live = blocks.filter((b) => b.rows.length > 0);
  if (live.length === 0) return EMPTY_INBOX;
  const cost = (line) => line.length + 1; // 改行ぶん
  const shown = new Map();
  let used = footer === '' ? 0 : cost(footer);
  for (const b of live) {
    used += cost(b.head) + cost(b.rows[0]);
    // `… ほか N 件` を後から足して上限を割らないよう、その 1 行ぶんを先に取り置く
    if (b.total > 1) used += OVERFLOW_RESERVE;
    shown.set(b, 1);
  }
  // 残りの枠は上の節 (= もっと長く待たせている系統) から順に使う
  for (const b of live) {
    for (const row of b.rows.slice(1)) {
      if (used + cost(row) > max) break;
      used += cost(row);
      shown.set(b, shown.get(b) + 1);
    }
  }
  const out = [];
  for (const b of live) {
    out.push(b.head, ...b.rows.slice(0, shown.get(b)));
    const rest = b.total - shown.get(b);
    if (rest > 0) out.push(`  … ほか ${rest} 件`);
  }
  if (footer !== '') out.push(footer);
  return out.join('\n').slice(0, max);
}

/**
 * その提案が**いまの**裁定待ちへ入った時刻。
 *
 * `updatedAt` で測ると、bot が意見 (`position`) を足すたびに経過が 0 へ戻り、
 * 議論が活発な提案ほど「待たせていない」ように見える。差し戻しで審議へ戻ることが
 * あるので (`deliberationCount` = 再審議の世代) 見るのは**最後に入った時刻**。
 *
 * **自己遷移は「入った」に数えない。** `failApply` は既に `deliberating` の提案へ
 * `deliberating → deliberating` の履歴を積む (`src/proposals.js:1635`) ので、
 * `to` だけで拾うと適用が失敗するたびに待ち時間が 0 へ戻る (レビュー指摘 2026-09-02)。
 *
 * @returns {string|number|null} 履歴から読めなければ updatedAt → createdAt へ落とす
 */
export function deliberatingSince(proposal) {
  const history = Array.isArray(proposal?.history) ? proposal.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.to === 'deliberating' && entry?.from !== 'deliberating' && entry?.at) return entry.at;
  }
  return proposal?.updatedAt ?? proposal?.createdAt ?? null;
}

/**
 * 待たせている時間が長い順 = 時刻の古い順。読めない時刻は**先頭**へ (放置を隠さない)。
 * 引き算で比べない — 読めない時刻どうしが `-Infinity - -Infinity` = NaN になる。
 */
function byWaitedLongest(pick) {
  return (a, b) => {
    const left = at(pick(a));
    const right = at(pick(b));
    if (left === right) return 0;
    return left < right ? -1 : 1;
  };
}

function at(value) {
  const ms = msOfTime(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * 経過時間 (`2h40m`)。**分より細かくは出さない** — 数日待つものの一覧で秒は情報にならない。
 * 読めない時刻は「?」(0 分と書くと「たった今来た」に見える)。
 */
export function elapsed(from, now = Date.now()) {
  const ms = msOfTime(from);
  if (!Number.isFinite(ms)) return '経過?';
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  if (days > 0) return `${days}d${hours}h`;
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

/** スレッドへの導線。`<#id>` は Discord がスレッド名のリンクに描いてくれる */
function link(threadId) {
  return threadId ? ` <#${String(threadId)}>` : '';
}

function holding(what) {
  return `(${what})`;
}

/** 一覧の 1 行に置く要旨。**台帳の 140 字ではなく表示の 60 字で切る** */
function quote(value, escape) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '(要旨なし)';
  const cut = flat.length > MAX_ROW_SUMMARY_CHARS ? `${flat.slice(0, MAX_ROW_SUMMARY_CHARS)}…` : flat;
  return `「${escape(cut)}」`;
}

/** 描画のために board を引くだけなので、引けなくても一覧は出す */
function safeFindTask(findTask, threadId) {
  if (typeof findTask !== 'function' || !threadId) return null;
  try {
    return findTask(String(threadId)) ?? null;
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
