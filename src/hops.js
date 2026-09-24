// @ts-check
// bot 間ループガード。「bot の発言が次の bot を呼ぶ」連鎖をスレッド単位で数え、
// 上限に達したら止める。人間が発言したらリセットする (会話の主導権は人間側)。
// 状態は in-memory (プロセス再起動で消えてよい — 再起動後は人間の発言から始まる)。

/**
 * 連続ホップ数の既定上限。
 * 6 では Fable → Opus → 検収 → 手直し → 再検収 の往復で足りず、
 * 人間が「続けて」と言い直す手間が常態化していたため 12 へ (2026-07-31)。
 */
export const DEFAULT_MAX_BOT_HOPS = 12;

export class HopTracker {
  /**
   * @param {number} max 連続ホップ上限 (0 = bot 起点の起動を一切許さない)
   * @param {number} [selfMax] 連続自己呼び出しの上限。**既定は max と同じ** =
   *   別枠では絞らず、bot ホップ全体の枠だけで止まる。絞る口は用意しておいて、
   *   暴走が見えたときに必要なぶんだけ絞る方針 (作者裁定 2026-08-21)。
   *   0 = 自己呼び出しを一切許さない
   */
  constructor(max = DEFAULT_MAX_BOT_HOPS, selfMax = max) {
    this.max = max;
    this.selfMax = selfMax;
    this.counts = new Map(); // threadId → 連続 bot ホップ数
    // 上限へ初めて到達したスレッド。**通知の回数を決める印ではない** (2026-09-08 以降、
    // 見送りの通知は take の warn を見ずに毎回出す — take の JSDoc を参照)
    this.warned = new Set();
    // threadId → {botKey, count, warned}。**担当ごとではなくスレッドに 1 本**持つ —
    // 自己呼び出しは「その担当が連続で自分を呼んだ回数」なので、別の担当が動いた
    // 時点で連鎖は切れる。連鎖ごと差し替わるので warned も一緒に戻る
    this.selfChains = new Map();
    // threadId → 残り job 数。**予算を払い出したスレッドにだけ効く門番**で、
    // 載っていないスレッド (= 人間が始めた普通のスレッド) は従来どおり動く。
    // スケジューラ (M0-4) が起こす無人のタスクスレッドには人間の発言が来ない =
    // hop リセットが永遠に起きないので、代わりにこの予算が「どこまで走ってよいか」
    // を決める
    this.budgets = new Map();
    this.budgetWarned = new Set(); // 予算切れ通知を出したスレッド (1 回だけ出す)
  }

  /** 人間の発言。カウンタと通知済みフラグを戻す */
  reset(threadId) {
    this.counts.delete(threadId);
    this.warned.delete(threadId);
    this.selfChains.delete(threadId);
    // **予算そのものは戻さない。** 人間の発言が戻すのは会話の主導権であって、
    // タスクへ払い出した job ではない (戻すと「詰まったら一言」で無限に湧く)。
    // 通知済みフラグだけは戻して、次に詰まったときもう一度だけ報せる (warned と同じ流儀)
    this.budgetWarned.delete(threadId);
  }

  /** そのスレッドの現在の連続ホップ数 */
  hops(threadId) {
    return this.counts.get(threadId) ?? 0;
  }

  /**
   * bot 発言 1 回分のホップを消費する。
   * @returns {{allowed: boolean, hops: number, warn: boolean}}
   *   allowed=false は上限到達。warn=true はそのスレッドで初めて到達した時だけ立つ。
   *
   *   **上限到達の通知はもう warn を見ていない** (2026-09-08)。見送りは同時にその起動の
   *   委譲契約を捨てる操作なので、2 回目以降を黙って止めると委譲元は投げたつもりのまま
   *   契約だけが消える — `src/bridge/messages.js` は見送るたびに知らせる。
   *   いま warn を見ているのは**予算切れ** (`spendBudget` が返す warn) の通知だけで、
   *   そちらは人間が発言しても戻らない待ちなので、繰り返しても状況が変わらない
   */
  take(threadId) {
    const hops = this.hops(threadId);
    if (hops >= this.max) {
      const warn = !this.warned.has(threadId);
      if (warn) this.warned.add(threadId);
      return { allowed: false, hops, warn };
    }
    // 予算の門番は hop 検査を**通った後**に見る (止まるターンで予算を減らさない)。
    // ここが唯一の消費点 — take は bot 起点の job が必ず通る道なので、
    // 「受理 1 回 = 1 job」がここだけで数え切れる
    const budget = spendBudget(this, threadId, { spend: true });
    if (!budget.ok) return { allowed: false, hops, warn: budget.warn };
    this.counts.set(threadId, hops + 1);
    return { allowed: true, hops: hops + 1, warn: false };
  }

  /** そのスレッドで**その担当が**続けている自己呼び出しの回数 (担当が違えば 0) */
  selfHops(threadId, botKey) {
    const chain = this.selfChains.get(threadId);
    return chain && chain.botKey === botKey ? chain.count : 0;
  }

  /**
   * 自己呼び出し 1 回分を消費する。**take とは別枠**で数える (両方消費する)。
   * @returns {{allowed: boolean, hops: number, warn: boolean}} take と同じ意味
   */
  takeSelf(threadId, botKey) {
    const chain = this.selfChains.get(threadId);
    const current = chain && chain.botKey === botKey ? chain : null;
    const hops = current?.count ?? 0;
    if (hops >= this.selfMax) {
      const warn = !current?.warned;
      // 上限に張り付いた連鎖で警告を撒かない (take と同じ流儀)
      if (warn) this.selfChains.set(threadId, { botKey, count: hops, warned: true });
      return { allowed: false, hops, warn };
    }
    // 予算切れならここでも止める。ただし**減らさない** — 自己呼び出しでも
    // 受信側は takeSelf → take と両方を通す (src/bridge/messages.js) ので、ここでも消費すると
    // 1 job で 2 減る。門番は二重に置き、消費点は take に一本化する
    const budget = spendBudget(this, threadId, { spend: false });
    if (!budget.ok) return { allowed: false, hops, warn: budget.warn };
    this.selfChains.set(threadId, { botKey, count: hops + 1, warned: false });
    return { allowed: true, hops: hops + 1, warn: false };
  }

  /**
   * 自己呼び出しの連鎖を切る (別の担当が動いた)。
   * bot ホップ全体のカウンタは触らない — そちらは「人間が発言するまで」の連鎖で、
   * 担当が代わっても続いている
   */
  breakSelfChain(threadId) {
    this.selfChains.delete(threadId);
  }

  /**
   * スレッドへ job 予算を払い出す。
   *
   * **再付与は積み増し。** 詰まったタスクへ人間が追い予算を出す操作なので、
   * 上書きだと「20 出したつもりが残 3 に戻っていた」が起きる。
   *
   * 予算を一度でも付けたスレッドは、以後 bot 起点の受理が予算に縛られる —
   * 付けていないスレッドは Map に載らず、従来どおり hop 上限だけで動く。
   * 台帳側の正本はボード (src/board.js の jobsSpent / jobBudget) で、こちらは
   * 実行時の門番。記帳はスケジューラの仕事なので、ここでは持たない。
   *
   * @param {string} threadId
   * @param {number} jobs 足す job 数 (0 以上の整数。0 = 予算ゼロで門番だけ効かせる)
   * @returns {number} 積み増し後の残り
   * @throws {Error} jobs が 0 以上の整数でないとき (書き損じを黙って無制限にしない)
   */
  grantTaskBudget(threadId, jobs) {
    if (!Number.isSafeInteger(jobs) || jobs < 0) {
      throw new Error(
        `job 予算は 0 以上の整数で指定してください (受け取った値: ${JSON.stringify(jobs)})`,
      );
    }
    const next = (this.budgets.get(threadId) ?? 0) + jobs;
    this.budgets.set(threadId, next);
    return next;
  }

  /**
   * 払い出した予算を戻す (sol 指摘 2026-08-30)。
   *
   * **使い道は「積んだのに起動しなかった」を取り消すことだけ。** 起動メッセージの
   * 投稿より前に積む必要がある (受け手が門番を通れるように) 一方、投稿に失敗した
   * ぶんを残すと未消費の予算が溜まり、後で通ったときに余剰ぶんの別 job が動かせる。
   *
   * **予算を払い出していないスレッドには何もしない** — そこは門番ごと不在
   * (従来どおり) なので、0 を書き込むと「無制限」から「予算切れ」へ意味が変わる。
   * 0 で止めるのも同じ理由: 他の job が先に使っていても、負の残高にはしない。
   *
   * @returns {number|null} 戻した後の残り (対象外なら null)
   */
  releaseTaskBudget(threadId, jobs) {
    if (!Number.isSafeInteger(jobs) || jobs < 0) {
      throw new Error(
        `戻す job 予算は 0 以上の整数で指定してください (受け取った値: ${JSON.stringify(jobs)})`,
      );
    }
    const left = this.budgets.get(threadId);
    if (left === undefined) return null;
    const next = Math.max(0, left - jobs);
    this.budgets.set(threadId, next);
    return next;
  }

  /**
   * そのスレッドの残り job 予算。
   * @returns {number|null} null = 予算を払い出していない (門番なし = 従来どおり)
   */
  taskBudget(threadId) {
    return this.budgets.get(threadId) ?? null;
  }
}

/**
 * 予算の門番。**予算を払い出していないスレッドは常に通す** (現行と完全に同じ挙動)。
 * クラスの外に置いて、公開 API を増やさずに take / takeSelf から共有する。
 *
 * 拒否の形は hop 上限到達と同じ `{ok:false, warn}` — 呼び出し側 (src/bridge/messages.js) は
 * 理由を区別せず「止まった」として扱えばよく、区別が要るときは taskBudget() を見る。
 *
 * @param {HopTracker} tracker
 * @param {string} threadId
 * @param {{spend: boolean}} options spend=false なら残量を見るだけ (減らさない)
 * @returns {{ok: boolean, warn: boolean}}
 */
function spendBudget(tracker, threadId, { spend }) {
  const left = tracker.budgets.get(threadId);
  if (left === undefined) return { ok: true, warn: false };
  if (left <= 0) {
    const warn = !tracker.budgetWarned.has(threadId);
    if (warn) tracker.budgetWarned.add(threadId);
    return { ok: false, warn };
  }
  if (spend) tracker.budgets.set(threadId, left - 1);
  return { ok: true, warn: false };
}
