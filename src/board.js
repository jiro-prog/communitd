import { JsonStore } from './store.js';
import { isSafeRepoPath, samePathLoose } from './repopath.js';

/**
 * エージェント社会のタスクボード (docs/social-engineering.md §3.2)。
 *
 * スケジューラ (§7-4、未実装) が読む**状態の正本**で、1 タスク = 1 Discord スレッド。
 * ここが持つのは状態機械だけで、「次に何を起動するか」の判断は持たない —
 * tick の判断はスケジューラ側の純粋関数へ置く。
 *
 * 保存先は `data/tasks.json` (`.gitignore` 済み)。既存ストアと同じく `JsonStore` を継承し、
 * 保存は tmp 書き → rename、壊れたファイルは退避される。
 */

/** ボードが取りうる状態 (§3.2) */
export const TASK_STATES = Object.freeze([
  'proposed', 'approved', 'in-progress', 'review', 'merged', 'blocked', 'dropped',
]);

/**
 * これ以上進まない状態。ボードからは消さない (スレッドと 1:1 なので履歴が読めなくなる) が、
 * スケジューラの着手対象からは外れる。
 *
 * **`blocked` はここに入らない** (検収裁定 2026-08-27)。要人間で止まったタスクは
 * `resume()` で `approved` へ戻せる — 「人間の発言そのもの」ではなく再開操作が状態を
 * 動かし、追い予算を出すかはスケジューラの判断。
 */
export const TERMINAL_STATES = Object.freeze(['merged', 'dropped']);

/**
 * 「まだ着手されていない」状態。**起票の枠 (§9.2a) はこの数で数える** —
 * スケジューラがスカウトを起こすかどうかを見る定義 (`OPEN_STATES` — src/scheduler.js) と
 * 同じにそろえてある。2 か所が食い違うと「起こしたのに 1 件も載らない」巡回ができる。
 * ずれは test/scheduler.test.js が planTick と突き合わせて固定している。
 */
const OPEN_STATES = Object.freeze(['proposed', 'approved']);

/** スカウトへ見せる「直近に着地したもの」の窓 (§9.1a)。48 時間 */
export const MERGED_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * 起票の枠が読めないときの既定。**config.js の `DEFAULT_SCOUT_MAX_OPEN_TASKS` と同じ値** —
 * config.js がこのファイルを読んでいるので、こちらから config を読むと循環する。
 * 値のずれは test/board.test.js が config 側の定数と突き合わせて固定している。
 */
const FALLBACK_MAX_OPEN_TASKS = 6;

/**
 * job 予算を消費できない状態。**`blocked` を含む** — 終端ではなくなったが、
 * 止まっているタスクの予算を減らす道理は無い (走っていない間に予算だけ溶ける)。
 */
const NON_SPENDING_STATES = Object.freeze(['merged', 'blocked', 'dropped']);

/**
 * 許される遷移だけを列挙した表。**ここに無い辺は API が拒否する。**
 *
 * 幹は §3.2 の `proposed → approved → in-progress → review → merged`。
 * `blocked` / `dropped` はどの作業中の状態からも起こりうるので、幹の各段から出す:
 * - `blocked` = 要人間 (§6「差し戻し 2 回 / verify が原因不明で落ち続ける / job 予算切れ」)。
 *   予算切れは in-progress、差し戻しは review で起きるので終端だけに置くと表現できない。
 * - `dropped` = 破棄 (承認されなかった提案・不要になったタスク)。
 *
 * 復帰は `blocked → approved` の一辺だけ (検収裁定 2026-08-27)。承認済みまで戻して
 * 着手の列へ並べ直す形にすると、「どこまで進んでいたか」を推測して復元せずに済む。
 *
 * 差し戻しは `review → in-progress` (§3.2 裁定 2026-08-28)。スレッドも作業ブランチも
 * そのままなので、承認まで戻さず**同じスレッドの続き**として直させる。
 * 2 回目の差し戻しは要人間 (§6) — 判断はボードではなくスケジューラ側が持つ。
 */
export const TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['approved', 'blocked', 'dropped']),
  approved: Object.freeze(['in-progress', 'blocked', 'dropped']),
  'in-progress': Object.freeze(['review', 'blocked', 'dropped']),
  review: Object.freeze(['merged', 'in-progress', 'blocked', 'dropped']),
  merged: Object.freeze([]),
  blocked: Object.freeze(['approved']),
  dropped: Object.freeze([]),
});

/** その遷移が §3.2 の表にあるか (スケジューラが着手可否を判断するためにも使う純粋関数) */
export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 1 タスクに払い出す job 予算の既定値 (§3.5 の例)。
 * 実際の値はチャンネルの autonomy config (§7-2、未実装) から渡す想定で、
 * ここは「渡されなかったときに無制限にしない」ための床。
 */
export const DEFAULT_JOB_BUDGET = 20;

/**
 * そのタスクが今まで何回差し戻されたか (§6 の「差し戻し 2 回で要人間」を数える純関数)。
 * 履歴が台帳なので、回数を別フィールドで持たずここから数える — 二重管理にしない。
 */
export function sendBackCount(task) {
  const history = Array.isArray(task?.history) ? task.history : [];
  return history.filter((entry) => entry?.from === 'review' && entry?.to === 'in-progress').length;
}

/**
 * touch を宣言していない終端でないタスク (§3.9)。
 *
 * **1 件でもあると、そのボードでは組織提案が全件拒否される** — 発議側の競合判定
 * (`taskConflicts` — src/proposals.js) は touch 不明のタスクを「どこを触っているか
 * 分からない = 何とでも競合する」と見なすため (fail-closed)。起動時の警告と移行 CLI
 * (`scripts/migrate-task-touch.mjs`) が同じ判定を見るように、純関数としてここに置く。
 */
export function tasksMissingTouch(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && typeof task.state === 'string' && !TERMINAL_STATES.includes(task.state))
    .filter((task) => !Array.isArray(task.touch) || task.touch.length === 0);
}

/**
 * touch 移行の計画を**書き始める前に全件検証する** (sol 指摘 2026-08-30)。
 *
 * 逐次 `setTouch()` しながら検証すると、2 件目のパスが不正だったときに 1 件目だけが
 * 保存された「途中まで移行されたボード」が残る。移行は「全部通るか、何も書かないか」
 * でなければ、残りを手で調べ直すことになる。
 *
 * @param {object[]} tasks board.list() の結果
 * @param {Iterable<[string, string[]]>} entries id → touch
 * @returns {{ok: true, plan: Array<{id: string, title: string, touch: string[]}>}
 *          | {ok: false, reason: string}}
 */
export function planTouchMigration(tasks = [], entries = []) {
  const pending = tasksMissingTouch(tasks);
  const plan = [];
  const seen = new Set();
  for (const [rawId, touch] of entries) {
    const id = String(rawId);
    if (seen.has(id)) return { ok: false, reason: `タスク ${id} が二度指定されています` };
    seen.add(id);
    const task = pending.find((t) => String(t.id) === id);
    if (!task) {
      const known = (Array.isArray(tasks) ? tasks : []).find((t) => String(t?.id) === id);
      return {
        ok: false,
        reason: known
          ? `タスク ${id} は移行の対象ではありません (${known.state} / touch ${JSON.stringify(known.touch ?? null)})`
          : `タスク ${id} がボードにありません`,
      };
    }
    try {
      plan.push({ id: String(task.id), title: String(task.title ?? ''), touch: normalizeTouch(touch) });
    } catch (err) {
      return { ok: false, reason: `タスク ${id}: ${err.message}` };
    }
  }
  return { ok: true, plan };
}

/** その状態で job 予算を消費してよいか (走っていないタスクの予算は減らさない) */
export function canSpendJob(task) {
  return Boolean(task) && !NON_SPENDING_STATES.includes(task?.state);
}

/** 残り job (§3.5「使い切ったら blocked」の判定を 1 箇所に置く) */
export function remainingJobs(task) {
  const spent = Number(task?.jobsSpent) || 0;
  const budget = Number(task?.jobBudget) || 0;
  return Math.max(0, budget - spent);
}

/** 時刻は呼び出し側から注入する (ms / Date / ISO 文字列のどれでも受ける) */
const isoAt = (now) => new Date(now).toISOString();

/**
 * タスクが触るファイル (§3.9 の末尾)。**起票の時点で必須**にしてある。
 *
 * 発議の競合判定 (`taskConflicts` — src/proposals.js) は、touch を持たないタスクを
 * 「どこを触っているか分からない」として**何とでも競合する**と見なす (fail-closed)。
 * つまり touch 不明のタスクが 1 件でも open だと、そのボードでは発議が全件拒否される。
 * 後から足せる任意フィールドにすると、その状態が誰にも気付かれないまま常態化する。
 *
 * 正規形は `isSafeRepoPath` (src/repopath.js) と揃える — 提案側の `change.touch` と
 * 突き合わせる (`linkTask`) 以上、表記ゆれで同じファイルが別のキーになると照合が抜ける。
 * 前後の空白だけは落としてから見る (書き損じで恒久的に一致しないキーを作らない)。
 *
 * @returns {string[]} 正規化済みの touch
 * @throws {Error} 空・非文字列・危険なパス・重複を含むとき
 */
export function normalizeTouch(value, name = 'touch') {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `タスクの ${name} は必須です (触るファイルの相対パスを 1 つ以上書く) — `
      + 'touch 不明のタスクがあると、そのチャンネルでは発議が全件拒否されます',
    );
  }
  const out = [];
  for (const raw of value) {
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!isSafeRepoPath(path)) {
      throw new Error(
        `タスクの ${name} に使えないパスがあります: ${JSON.stringify(raw)} `
        + '(リポジトリ相対・POSIX 区切り・`./` なしで書く)',
      );
    }
    // 大小文字だけが違うパスは Windows では同じ実体 — 重複として落とす
    if (out.some((p) => p.toLowerCase() === path.toLowerCase())) {
      throw new Error(`タスクの ${name} に重複があります: ${path}`);
    }
    out.push(path);
  }
  return out;
}

/**
 * 2 つの touch 集合が同じファイルを掴んでいるか (§9.1(b) の重複ゲート)。
 *
 * 比較は `samePathLoose` (src/repopath.js) — 大小文字だけが違うパスは同じ実体として
 * 扱う。発議側の競合判定 (`entriesConflict` — src/proposals.js) と同じ規則で、
 * 起票側にも同じ物差しを置く。
 *
 * **真偽ではなく重なったパスを返す。** 拒否の理由に「どのファイルで重なったか」を
 * 書けないと、起票した側が次の巡回で何を避ければよいか分からない。
 *
 * @returns {string|null} 最初に見つかった重なり (`a` 側の表記)。無ければ null
 */
export function touchOverlaps(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  for (const path of left) {
    if (right.some((other) => samePathLoose(path, other))) return path;
  }
  return null;
}

/**
 * スカウトへ見せるボードの現状 (§9.1a)。
 *
 * **非終端すべて + 直近に merged になったもの。** proposed / approved しか見せないと、
 * 誰かが review まで進めた仕事が一覧から消え、同じものがもう一度起票される
 * (#46 が #45 の重複になったのはこれ)。着地した直後のものを窓付きで足すのは、
 * merge の翌日に「まだ無い」と誤認させないため。
 *
 * **merged の時刻は履歴の `to:'merged'` 行だけ**で見る。`updatedAt` は「最後に触られた
 * 時刻」であって着地の時刻ではないので、そこへ落とすと手で編集された古い merged が
 * 直近扱いになる。読めないものは「直近」と言い切れないので載せない。
 * **未来の時刻も載せない** (`now` の取り方しだいで、窓を過ぎても消えなくなる)。
 *
 * 並びは**非終端が先・merged が後**。長すぎる一覧は末尾から削られる
 * (`scoutStartMessage` — src/mentions.js) ので、削ってよい方を後ろに置く。
 *
 * @param {object[]} tasks 同じチャンネルのタスク (`list()` の戻り)
 * @param {{now?: number, mergedWindowMs?: number}} options
 * @returns {object[]} そのまま `scoutStartMessage` の `openTasks` へ渡せる並び
 */
export function scoutBoardView(tasks, { now = Date.now(), mergedWindowMs } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(isTaskLike);
  const window = countOr(mergedWindowMs, MERGED_WINDOW_MS);
  const landed = list.filter((task) => {
    if (task.state !== 'merged') return false;
    const at = mergedAtOf(task);
    // 未来の時刻は窓に入れない。`now` が list を読む前に取られていると、その隙に
    // 着地した merge が「ずっと直近」になり、窓が過ぎても一覧から消えなくなる
    return at !== null && now - at >= 0 && now - at <= window;
  });
  return [...list.filter((task) => !TERMINAL_STATES.includes(task.state)), ...landed];
}

/**
 * merged になった時刻 (ms)。**履歴の `to:'merged'` 行だけを見る** — 読めなければ null。
 *
 * `updatedAt` へ落とさないのは、それが「最後に触られた時刻」であって着地の時刻ではない
 * ため。手で編集された古い merged が直近扱いで一覧に居座る。
 */
function mergedAtOf(task) {
  const history = Array.isArray(task.history) ? task.history : [];
  // merged は終端なので 1 本しか無いはずだが、最後の 1 本を採るのが素直
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to !== 'merged') continue;
    const at = Date.parse(history[i]?.at);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * 起票をボードへ載せる前の制動 (§9.1b 重なり + §9.2a 枠)。**ボードには触らない** —
 * ここで落ちたものは proposed にすらならないので、次の巡回でまた起票できる。
 *
 * 順序は **重なり → 枠**。重なりで落ちたものに枠を消費させると、重複を 1 件書いただけで
 * その巡回の正当な起票が押し出される。
 *
 * 重なりの比較対象は**同チャンネルの非終端タスクと、この巡回で先に載せたもの**。
 * 同じバッチの中で 2 件が同じファイルを掴むと、承認を通った後に作業ツリーが衝突するので、
 * 後から来た方を断る (fail-closed)。続き物を積みたいなら前が merged になってから起票する。
 *
 * **比較できない相手が居たら全件断る。** touch 不明の非終端タスクは「どこを触っているか
 * 分からない = 何とでも競合する」— 発議側の競合判定 (`taskConflicts` — src/proposals.js)
 * と同じ扱いにそろえる。重なりが無いことを確かめられないまま載せると、ボードの不変条件
 * (`normalizeTouch` の注記) が起票の側から破れる。
 *
 * 枠は `maxOpenTasks − open(proposed + approved)`。in-progress / review / blocked は
 * もう着手されているので open に数えない (`OPEN_STATES` の注記)。
 *
 * @param {{wanted?: object[], openTasks?: object[], maxOpenTasks?: number}} p
 *   `wanted` は `proposedTasks` (src/scheduler.js) の戻り、
 *   `openTasks` は同チャンネルのタスク (終端はここで落とす)
 * @returns {{file: object[], rejected: Array<{task: object, reason: string}>,
 *            deferred: object[]}} `file` だけが `propose` へ進む
 */
export function planFiling({ wanted = [], openTasks = [], maxOpenTasks } = {}) {
  const live = (Array.isArray(openTasks) ? openTasks : [])
    .filter(isTaskLike)
    .filter((task) => !TERMINAL_STATES.includes(task.state));
  const open = live.filter((task) => OPEN_STATES.includes(task.state)).length;
  let slots = Math.max(0, countOr(maxOpenTasks, FALLBACK_MAX_OPEN_TASKS) - open);
  const list = (Array.isArray(wanted) ? wanted : [])
    .filter((task) => task && typeof task === 'object');

  // 何とでも競合する相手が居る間は 1 件も載せない (移行するまで起票が止まるのは意図どおり)
  const unknown = tasksMissingTouch(live);
  if (unknown.length > 0) {
    const reason = `${unknown.map((task) => `#${task.id}`).join(' / ')} の touch が不明 — `
      + '移行 (scripts/migrate-task-touch.mjs) が要る';
    return { file: [], rejected: list.map((task) => ({ task, reason })), deferred: [] };
  }

  // 比較対象は「名乗り + touch」に均しておく (ボードのタスクと、まだ id の無い起票)
  const held = live.map((task) => ({ label: `#${task.id}`, touch: task.touch }));
  const file = [];
  const rejected = [];
  const deferred = [];
  for (const task of list) {
    const clash = firstClash(task.touch, held);
    if (clash) {
      rejected.push({ task, reason: `${clash.label} と touch が重なる (${clash.path})` });
      continue;
    }
    if (slots <= 0) {
      deferred.push(task);
      continue;
    }
    file.push(task);
    slots -= 1;
    held.push({ label: `同じ巡回の「${task.title}」`, touch: task.touch });
  }
  return { file, rejected, deferred };
}

/** @returns {{label: string, path: string}|null} 最初に重なった相手 */
function firstClash(touch, held) {
  for (const other of held) {
    const path = touchOverlaps(touch, other.touch);
    if (path) return { label: other.label, path };
  }
  return null;
}

/** 手で編集された値・古い形が混ざっても落とさない (状態の読めないものは数えない) */
function isTaskLike(task) {
  return Boolean(task) && typeof task === 'object' && typeof task.state === 'string';
}

function countOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export class TaskBoardStore extends JsonStore {
  /** @returns {object|null} 壊れた値 (手で編集された等) は無いものとして扱う */
  get(id) {
    const task = this.data[String(id)];
    return task && typeof task === 'object' && !Array.isArray(task) ? task : null;
  }

  /**
   * 条件に合うタスクを id 昇順で返す。
   * @param {{channel?: string, state?: string|string[]}} filter
   */
  list({ channel = null, state = null } = {}) {
    const states = state === null || state === undefined ? null : [].concat(state);
    return Object.keys(this.data)
      .map((key) => this.get(key))
      .filter((task) => task !== null)
      .filter((task) => channel === null || task.channel === channel)
      .filter((task) => states === null || states.includes(task.state))
      .sort((a, b) => {
        const diff = (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0);
        return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
      });
  }

  /** スレッドからタスクを引く (§3.2 スレッドと 1:1 — job 側は自分のスレッドしか知らない) */
  findByThread(threadId) {
    if (threadId === null || threadId === undefined || threadId === '') return null;
    const key = String(threadId);
    return this.list().find((task) => task.threadId === key) ?? null;
  }

  /**
   * 次の id (ボード内で一意な連番)。
   *
   * カウンタを別に持たず**既存キーの最大値から導く**: メタキーをタスクと同じ JSON に
   * 混ぜずに済み、ファイルが退避されて空に戻っても採番が壊れない。
   */
  nextId() {
    let max = 0;
    for (const key of Object.keys(this.data)) {
      const n = Number.parseInt(key, 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  /**
   * 起票 (スカウトの出力がここへ入る — §3.3)。
   *
   * `touch` は必須 (§3.9)。起票の時点で「どこを触る仕事か」を宣言させないと、
   * 発議側がそのタスクとの競合を判定できない (normalizeTouch のコメント参照)。
   *
   * @returns {object} 作られたタスク
   */
  propose(
    { channel, title, rationale = '', jobBudget = DEFAULT_JOB_BUDGET, touch },
    { now = Date.now(), by = null } = {},
  ) {
    const cleanChannel = required(channel, 'channel');
    const cleanTitle = required(title, 'title');
    if (!Number.isInteger(jobBudget) || jobBudget <= 0) {
      throw new Error(`jobBudget は 1 以上の整数で指定してください (受け取った値: ${jobBudget})`);
    }
    const cleanTouch = normalizeTouch(touch);
    const id = this.nextId();
    const at = isoAt(now);
    const task = {
      id,
      channel: cleanChannel,
      title: cleanTitle,
      rationale: typeof rationale === 'string' ? rationale : '',
      touch: cleanTouch,
      state: 'proposed',
      threadId: null,
      branch: null,
      jobsSpent: 0,
      jobBudget,
      createdAt: at,
      updatedAt: at,
      history: [{ at, from: null, to: 'proposed', ...(by ? { by } : {}) }],
    };
    this.write(id, task);
    return task;
  }

  /** 承認 (§3.2 裁定: 起票 Opus・承認 Fable)。着手はここを通った後だけ */
  approve(id, options = {}) {
    return this.transition(id, 'approved', options);
  }

  /**
   * 着手。スレッドとブランチをここで結び付ける。
   *
   * `branch` 省略時は §3.6 の `task/<id>` (1 タスク = 1 マージコミット = revert 一発)。
   *
   * `touch` を渡すと起票時の宣言を差し替える (§3.9 — touch を持つのは `propose` / `start`)。
   * 着手の時点で対象が絞れた・広がったことは実際にあるので、**履歴に残したうえで**
   * 更新できるようにしてある。省略時は据え置き。
   */
  start(id, {
    threadId = null, branch = null, touch = null, now = Date.now(), by = null, note = '',
  } = {}) {
    const task = this.require(id);
    const thread = threadId === null || threadId === undefined ? task.threadId : String(threadId);
    if (thread) {
      const owner = this.findByThread(thread);
      if (owner && owner.id !== task.id) {
        throw new Error(`スレッド ${thread} は既にタスク ${owner.id} のものです (スレッドとタスクは 1:1)`);
      }
    }
    const nextTouch = touch === null || touch === undefined ? task.touch : normalizeTouch(touch);
    return this.transition(id, 'in-progress', {
      now,
      by,
      note,
      patch: { threadId: thread, branch: branch ?? task.branch ?? `task/${task.id}`, touch: nextTouch },
      historyExtra: touch === null || touch === undefined ? {} : { touch: nextTouch },
    });
  }

  /** レビュー提出 (worker の完了 report をブリッジが見て進める — §3.5) */
  submitForReview(id, options = {}) {
    return this.transition(id, 'review', options);
  }

  /** 完了 = main へ昇格済み (§3.6)。merge コミットなどは note に残す */
  complete(id, options = {}) {
    return this.transition(id, 'merged', options);
  }

  /**
   * 差し戻し (§3.2 裁定 2026-08-28)。レビューが通らなかったので実装中へ戻す。
   *
   * 承認まで戻さないのは、スレッドも作業ブランチもそのまま使えるから —
   * 同じスレッドの続きとして直させる方が、文脈を捨てずに済む。
   * **何回目かはここでは見ない** (2 回目を要人間にするかはスケジューラの判断)。
   */
  sendBack(id, { reason = '', now = Date.now(), by = null } = {}) {
    return this.transition(id, 'in-progress', { now, by, note: reason });
  }

  /** 封鎖 = 要人間 (§6)。理由は履歴に残す — 人間が覗いたとき何で止まったか分かるように */
  block(id, { reason = '', now = Date.now(), by = null } = {}) {
    return this.transition(id, 'blocked', { now, by, note: reason });
  }

  /** 破棄 (承認されなかった提案・不要になったタスク) */
  drop(id, { reason = '', now = Date.now(), by = null } = {}) {
    return this.transition(id, 'dropped', { now, by, note: reason });
  }

  /**
   * 封鎖からの復帰 (検収裁定 2026-08-27)。`approved` へ戻して着手の列へ並べ直す。
   *
   * `addBudget` は jobBudget への**積み増し**。予算切れで止まったタスクを予算 0 のまま
   * 戻すと、着手した途端にまた止まる — かといって使った分を無かったことにはしない
   * (jobsSpent は履歴なので減らさない) ので、上限の方を足す。
   *
   * どれだけ足したかは履歴の `addBudget` に残す。ボードだけ見て「誰がいつ、いくら
   * 追い予算を出したか」が読めないと、無人運転の暴走を後から追えない。
   *
   * @param {string} id
   * @param {{addBudget?: number, now?: number, by?: string|null, note?: string}} options
   * @throws {Error} addBudget が 0 以上の整数でないとき (書き損じで無制限にしない)
   */
  resume(id, { addBudget = 0, now = Date.now(), by = null, note = '' } = {}) {
    if (!Number.isSafeInteger(addBudget) || addBudget < 0) {
      throw new Error(
        `addBudget は 0 以上の整数で指定してください (受け取った値: ${JSON.stringify(addBudget)})`,
      );
    }
    const task = this.require(id);
    return this.transition(id, 'approved', {
      now,
      by,
      note,
      patch: addBudget > 0 ? { jobBudget: (Number(task.jobBudget) || 0) + addBudget } : {},
      historyExtra: addBudget > 0 ? { addBudget } : {},
    });
  }

  /**
   * job 予算を消費する (§3.5 のタスク単位予算)。状態は動かさず履歴も汚さない —
   * 履歴は「誰が何を決めたか」の台帳で、job の消費は計数だから。
   *
   * 使い切ったときに `blocked` にするかはスケジューラの判断なので、ここではしない。
   */
  spendJob(id, { count = 1, now = Date.now() } = {}) {
    const task = this.require(id);
    if (!canSpendJob(task)) {
      throw new Error(`タスク ${task.id} は ${task.state} なので job 予算を消費できません`);
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`count は 1 以上の整数で指定してください (受け取った値: ${count})`);
    }
    const next = { ...task, jobsSpent: (Number(task.jobsSpent) || 0) + count, updatedAt: isoAt(now) };
    this.write(task.id, next);
    return next;
  }

  /**
   * touch を持っていないタスクへ後から宣言を入れる (**移行専用** — §3.9)。
   *
   * `propose` が touch を必須にする前に起票されたタスクだけが対象。
   * **既に持っているタスクは断る** — 上書きを許すと、発議の競合判定と `linkTask` の
   * 範囲照合の根拠を、走っている最中に広げられる口になる (着手時の差し替えは `start`)。
   * 終端のタスクも断る (競合判定の材料ではないので、閉じた記録を書き換える理由が無い)。
   *
   * **履歴は積まない。** 履歴は §3.2 の状態遷移の台帳で、後から埋めた宣言は遷移ではない。
   *
   * @throws {Error} 既に touch があるとき / 終端のとき / touch が正規形でないとき
   */
  setTouch(id, touch, { now = Date.now() } = {}) {
    const task = this.require(id);
    if (Array.isArray(task.touch) && task.touch.length > 0) {
      throw new Error(`タスク ${task.id} には既に touch があります (移行の対象ではありません)`);
    }
    if (TERMINAL_STATES.includes(task.state)) {
      throw new Error(`タスク ${task.id} は ${task.state} なので移行の対象ではありません`);
    }
    const next = { ...task, touch: normalizeTouch(touch), updatedAt: isoAt(now) };
    this.write(task.id, next);
    return next;
  }

  /**
   * 遷移の実体。**表に無い辺は書き込む前に拒否する** (拒否した時はディスクもメモリも動かない)。
   *
   * @param {string} id
   * @param {string} to 次の状態
   * @param {{now?: number, by?: string|null, note?: string, patch?: object, historyExtra?: object}} options
   *   historyExtra は履歴 1 行に足す情報 (resume の addBudget など)
   * @returns {object} 更新後のタスク
   */
  transition(id, to, { now = Date.now(), by = null, note = '', patch = {}, historyExtra = {} } = {}) {
    const task = this.require(id);
    if (!canTransition(task.state, to)) {
      throw new Error(
        `タスク ${task.id} は ${task.state} から ${to} へ進めません `
        + `(docs/social-engineering.md §3.2 の遷移表に無い)`,
      );
    }
    const at = isoAt(now);
    const entry = { at, from: task.state, to };
    if (by) entry.by = by;
    if (note) entry.note = note;
    Object.assign(entry, historyExtra);
    const next = {
      ...task,
      ...patch,
      state: to,
      updatedAt: at,
      history: [...(Array.isArray(task.history) ? task.history : []), entry],
    };
    this.write(task.id, next);
    return next;
  }

  /** 無いタスクを黙って作らない — 呼び出し側の id 取り違えをその場で落とす */
  require(id) {
    const task = this.get(id);
    if (!task) throw new Error(`タスク ${id} がボードにありません`);
    return task;
  }

  write(id, task) {
    this.commit({ ...this.data, [String(id)]: task });
  }
}

function required(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`タスクの ${name} は必須です`);
  return text;
}
