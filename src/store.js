import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * 読込の分類。**不在は broken ではない** —
 * 既存の台帳では「初回」で、空から始めてよい唯一の場合。
 */
export const LEDGER_BROKEN_KINDS = Object.freeze(['read-error', 'syntax-error', 'shape-error']);

/**
 * JSON 1 ファイルを丸ごと持つ薄い KV の共通部。
 *
 * **読めなかったファイルは動かさない。** 2026-09-07 より前は
 * `.corrupt-<時刻>` へ退避して空で続行していたが、それだと**次の起動が「初回」に見える** —
 * pause.json が壊れた日に kill switch が黙って解ける。いまは在処に残して `broken` に理由を持ち、
 * メモリだけ空で開く (読む側を落とさないため)。**書き込みは broken の間ずっと断る**
 * (壊れたファイルの上から書くと、人が直すための証拠が消える)。
 *
 * 保存は tmp 書き込み → rename のアトミック更新 (途中クラッシュで JSON を壊さない)。
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    // **公開するのは getter の `broken`** (JobRunStore は文字列で返す互換 API を持つので、
    // 素の値はここに置いて派生側から読み替えられるようにする)
    this.brokenInfo = null;
    if (existsSync(filePath)) {
      const read = readLedgerFile(filePath);
      this.brokenInfo = read.broken;
      if (read.broken === null) this.data = read.data;
    }
  }

  /** @returns {{kind: string, reason: string, at: string, code?: string|null}|null} 読めなかった理由 */
  get broken() {
    return this.brokenInfo;
  }

  /** 台帳として信用できるか (読めている) */
  get healthy() {
    return this.broken === null;
  }

  /**
   * ディスクへ書く。**`commit` 以外から呼ばない** — メモリを差し替えずに保存すると
   * 「呼び出し側が失敗を知らないまま値が効いている」経路ができる。
   * broken の門をここにも置くのは、将来の呼び出しが commit を迂回しても
   * 壊れた台帳を上書きしないため (Opus2 レビュー 2026-09-07 Minor1)。
   */
  save() {
    if (this.brokenInfo) throw new Error(brokenWriteMessage(this.filePath, this.brokenInfo));
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.filePath);
  }

  /**
   * 差し替えた内容を保存し、**保存できなかったら元へ戻して throw する。**
   *
   * 先にメモリを書き換えてから save すると、書けなかったときに
   * 「呼び出し側は失敗を報告したのに、動いているプロセスには新しい値が効いている」
   * という食い違いが残る (sol 指摘 2026-08-01)。ディスクとメモリを揃えて落とす。
   */
  commit(next) {
    // **読めなかった台帳の上には書かない。** 空のメモリを保存すると、人が直すための
    // 中身が消えて「最初からそうだった」になる
    if (this.brokenInfo) throw new Error(brokenWriteMessage(this.filePath, this.brokenInfo));
    const prev = this.data;
    this.data = next;
    try {
      this.save();
    } catch (err) {
      this.data = prev;
      throw err;
    }
  }
}

/**
 * 台帳 1 ファイルの読込 (4 分類のうち 3 つを broken として返す)。
 * **不在はここへ来ない** (呼び出し側の existsSync が「初回」として弾く)。
 *
 * @returns {{data: object, broken: {kind: string, reason: string, at: string, code: string|null}|null}}
 */
function readLedgerFile(filePath) {
  const at = () => new Date().toISOString();
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    // 読んでいる間に消えたなら初回と同じ (壊れてはいない)
    if (err?.code === 'ENOENT') return { data: {}, broken: null };
    return {
      data: {},
      broken: {
        kind: 'read-error',
        code: err?.code ?? null,
        reason: `読み込めません (${err?.code ?? 'unknown'}: ${err?.message ?? err})`,
        at: at(),
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { data: {}, broken: { kind: 'syntax-error', code: null, reason: `JSON として読めません (${err.message})`, at: at() } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      data: {},
      broken: { kind: 'shape-error', code: null, reason: 'トップレベルが object ではありません', at: at() },
    };
  }
  return { data: parsed, broken: null };
}

/** broken な台帳へ書こうとしたときの文言 (人が次に何をすればいいかまで書く) */
function brokenWriteMessage(filePath, broken) {
  return `${basename(filePath)} が読めないので保存しません (${broken.reason}) — `
    + '台帳を直すか手で退避してから操作してください';
}

/**
 * 読めない台帳の一覧 (fail-closed の材料)。`broken` は基底が object・JobRunStore が
 * 文字列を返すので、どちらも `{file, reason}` へそろえる。**store を持たない配線
 * (テストの偽物) も混ざる**ので、`broken` を持たないものは健全として扱う。
 *
 * @param {Array<{filePath?: string, broken?: object|string|null}|null|undefined>} stores
 * @returns {Array<{file: string, reason: string}>}
 */
export function brokenLedgers(stores = []) {
  const out = [];
  for (const store of stores) {
    const broken = store?.broken;
    if (!broken) continue;
    out.push({
      file: basename(String(store.filePath ?? '')) || '(ファイル不明)',
      reason: typeof broken === 'string' ? broken : String(broken.reason ?? broken.kind ?? '読めません'),
    });
  }
  return out;
}

/** `brokenLedgers` の戻りを 1 行に (ログ・/status・停止理由で同じ形にする) */
export function formatBrokenLedgers(list = []) {
  return list.map(({ file, reason }) => `${file}: ${reason}`).join(' / ');
}

/**
 * thread+宛先 bot → 委譲契約 (T6) を JSON で永続化する薄い KV。
 *
 * **承認台帳 (src/approvals.js) とは性格が違う。** あちらは「再起動をまたいだ承認は
 * 無効になるべき」なので意図的に永続しないが、契約は作業の前提であって権限そのものでは
 * なく、再起動をまたいでも同じ依頼が続いている方が自然なので永続する
 * (効かせるときは contractFor が thread・送信元・宛先・cwd を毎回照合する)。
 *
 * 保存先の `data/` は .gitignore 済み — 契約が作業ツリーの git 差分を汚さない。
 */
/** 1 つの宛先が抱えられる未消費契約の数 (溢れたら新しい保存の方を断る) */
export const MAX_PENDING_CONTRACTS = 5;

/**
 * 契約の賞味期限。これを過ぎた未消費契約は捨てる。
 *
 * 契約は「呼んだ相手の次の 1 job」に効くものなので、丸 1 日消費されないなら
 * その handoff は起動しなかった (hop 上限・停止中・投稿だけ失敗、など)。
 * 掃除しないと、消費されない契約がキューを埋めて新しい委譲が保存できなくなる。
 */
export const CONTRACT_TTL_MS = 24 * 60 * 60 * 1000;

export class ContractStore extends JsonStore {
  key(threadId, botKey) {
    return `${threadId}:${botKey}`;
  }

  /**
   * その宛先の未消費契約 (古い順)。
   *
   * **単一値ではなくキューで持つ。** 同じ相手へ続けて委譲すると、単一値では
   * 後の契約が前の契約を上書きし、**1 本目の job に 2 本目の契約が効く**
   * (job はキューで待つので、保存と消費は 1 対 1 に並ばない — sol 指摘 2026-08-03)。
   */
  list(threadId, botKey) {
    const value = this.data[this.key(threadId, botKey)];
    return Array.isArray(value) ? value : [];
  }

  /**
   * 末尾へ積む (handoff 1 回につき 1 件)。
   *
   * **溢れたら古い方を捨てずに断る。** 捨てられる契約に対応する handoff は既に
   * 配送済みなので、捨てると 1 本目の job が 2 本目の契約を受け取り、以降ずっと
   * 対応がずれ続ける (sol 指摘 2026-08-03)。保存を失敗させて**新しい handoff の方を
   * 止める**のが正しい向き。
   *
   * @throws {Error} 上限に達しているとき (呼び出し側が handoff を止める)
   */
  push(threadId, botKey, entry, { max = MAX_PENDING_CONTRACTS, now = Date.now(), ttlMs = CONTRACT_TTL_MS } = {}) {
    // **上限を見る前に期限切れを掃除する。** 掃除を claim 側だけに置くと、起動しなかった
    // handoff の契約が 5 件溜まった時点で新しい委譲が保存できなくなり、
    // 「新しい handoff を送れない → claim も起きない → 掃除されない」で閉塞する
    // (sol 指摘 2026-08-03)
    const queue = this.list(threadId, botKey).filter((e) => !isExpired(e, now, ttlMs));
    if (queue.length >= max) {
      throw new Error(
        `${botKey} 宛の未消費契約が上限 (${max} 件) に達しています — `
        + '先に消化されるまで新しい委譲は保存できません',
      );
    }
    this.write(threadId, botKey, [...queue, entry]);
  }

  /**
   * この job を起動した制御メッセージに載っていた nonce で契約を取り出す (1 件だけ)。
   *
   * **完全一致だけを取り出し、合わないものは残す。** 照合より先に取り出すと、
   * 無関係な job (同じ相手を人間が直接呼んだ job など) が他人宛の契約を消費して
   * 捨ててしまい、本来の handoff job が契約なしで走る = touch 制限が黙って外れる。
   *
   * nonce は**投稿より前に**契約と制御メッセージの両方へ載る。投稿後に書き戻す形だと、
   * 受け手の MessageCreate が書き戻しより先に届いたときに取りこぼす。
   *
   * 期限切れはここでも掃除する (起動しなかった handoff の契約を溜めない)。
   *
   * @param {{fromBotKey: string, nonce: string, now?: number, ttlMs?: number}} key
   * @returns {object|null}
   */
  claim(threadId, botKey, { fromBotKey, nonce, now = Date.now(), ttlMs = CONTRACT_TTL_MS }) {
    if (!fromBotKey || !nonce) return null;
    const before = this.list(threadId, botKey);
    const rest = before.filter((entry) => !isExpired(entry, now, ttlMs));
    const index = rest.findIndex(
      (entry) => entry?.fromBotKey === fromBotKey && entry?.nonce === nonce,
    );
    const entry = index < 0 ? null : rest.splice(index, 1)[0];
    // 期限切れを捨てた分があるので、見つからなくても書き戻す
    if (rest.length !== before.length) this.write(threadId, botKey, rest);
    return entry ?? null;
  }

  /**
   * id を指定して 1 件だけ取り消す (配送に失敗した契約だけを消す)。
   * 宛先ごと消すと、同じ相手宛の**他の未消費契約まで巻き添えになる**。
   * @returns {boolean} 消すものがあったか
   */
  removeById(threadId, botKey, id) {
    const queue = this.list(threadId, botKey);
    const next = queue.filter((entry) => entry?.id !== id);
    if (next.length === queue.length) return false;
    this.write(threadId, botKey, next);
    return true;
  }

  /** 期限切れ・未束縛の古い契約を捨てる (診断・保守用) */
  sweep(threadId, botKey, { now = Date.now(), ttlMs = CONTRACT_TTL_MS } = {}) {
    const queue = this.list(threadId, botKey);
    const kept = queue.filter((entry) => !isExpired(entry, now, ttlMs));
    if (kept.length === queue.length) return 0;
    this.write(threadId, botKey, kept);
    return queue.length - kept.length;
  }

  /** 空になったキーは残さない (data/contracts.json を膨らませない) */
  write(threadId, botKey, queue) {
    const next = { ...this.data };
    if (queue.length === 0) delete next[this.key(threadId, botKey)];
    else next[this.key(threadId, botKey)] = queue;
    this.commit(next);
  }
}

/** 保存時刻を読めない契約も期限切れ扱い (壊れた入力を溜めない) */
function isExpired(entry, now, ttlMs) {
  const at = Date.parse(entry?.at ?? '');
  return !Number.isFinite(at) || now - at > ttlMs;
}

/**
 * 自律運転の kill switch を JSON で永続化する。
 *
 * **再起動をまたいで残す。** 契約や編成と違って、これは「人が止めた」という事実で、
 * プロセスの再起動で勝手に解けると**止めた理由が残っているのに社会が動き出す**。
 * 承認台帳 (再起動で失効させるのが正しい) とは逆向きの性格。
 *
 * 止めるのは**自律起動だけ**。人間のメンション・handoff・自己呼び出し・実行中の job は
 * 何も変わらない (効かせる場所は src/bridge/scheduler.js の autonomyTick と
 * src/bridge/board.js の自動召喚の 2 か所)。
 */
export class PauseStore extends JsonStore {
  /**
   * いま止まっているならその記録、動いていれば null。
   *
   * **`paused: false` と明示されているときだけ「動いている」と読む。** 手で壊された
   * ファイルを「動いてよい」側へ倒すと、kill switch が黙って無効になる。
   *
   * **ファイルごと読めないときも停止扱い**。値の検証は「有効な JSON の中の
   * 壊れた値」しか見ないので、ファイル単位の破損だと `current()` が null =
   * 「動いている」になり、再起動のたびに停止が解ける。
   */
  current() {
    if (this.brokenInfo) return this.brokenEntry();
    const entry = this.data?.pause;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return entry.paused === false ? null : entry;
  }

  /** いま自律起動を止めているか */
  get paused() {
    return this.current() !== null;
  }

  /** 直近の記録 (再開済みでも返す — 「いつ誰が再開したか」の表示に使う) */
  last() {
    if (this.brokenInfo) return this.brokenEntry();
    const entry = this.data?.pause;
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  /**
   * 台帳が読めないときの合成記録。**人が押した停止と同じ形**で返す —
   * 表示 (`formatPauseState`)・判定 (`paused`)・`/status` が分岐を持たずに済む。
   * `broken: true` で「これは機械が倒した停止」だと分かる。
   */
  brokenEntry() {
    return {
      paused: true,
      by: 'system',
      reason: `${basename(this.filePath)} が読めない: ${this.brokenInfo.reason}`,
      broken: true,
      at: this.brokenInfo.at,
    };
  }

  /**
   * @returns {object} 書き込んだ記録 (保存に失敗したら throw する — 呼び出し側は「止めた」と言わない)
   * @throws {Error} 台帳が読めないとき (基底の `commit`。人が直すまで書き換えさせない)
   */
  pause({ by = null, reason = '', now = Date.now() } = {}) {
    const entry = {
      paused: true,
      at: new Date(now).toISOString(),
      by: by ?? null,
      reason: String(reason ?? '').trim(),
    };
    this.commit({ ...this.data, pause: entry });
    return entry;
  }

  /**
   * @returns {object|null} 再開する前に止まっていた記録 (元から動いていれば null)
   * @throws {Error} 台帳が読めないとき — **`/resume` では解けない**。
   *   壊れた pause.json を再開で上書きできると、kill switch を「壊して消す」道ができる
   */
  resume({ by = null, now = Date.now() } = {}) {
    const before = this.current();
    this.commit({
      ...this.data,
      pause: { paused: false, at: new Date(now).toISOString(), by: by ?? null, reason: '' },
    });
    return before;
  }
}

/**
 * チャンネル → スケジューラの勘定を永続化する薄い KV
 * (定期巡回の最終実行時刻と日次消費を永続化し、再起動直後の連発を防ぐ)。
 *
 * **中身の形はこの層の関心ではない。** 何を持ち越して何を捨てるかは
 * `persistedState` / `restoreState` (src/scheduler.js) が決める — 判断の層と
 * 保存の層を分けておくと、勘定が増えてもここは触らずに済む。
 */
export class TickStateStore extends JsonStore {
  /** @returns {object|null} 壊れた値は無いものとして扱う (restoreState が初期値へ倒す) */
  get(channel) {
    const entry = this.data[String(channel)];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  set(channel, state) {
    this.commit({ ...this.data, [String(channel)]: state });
  }
}

/** thread+bot → claude session の対応を JSON で永続化する薄い KV。 */
export class SessionStore extends JsonStore {
  key(threadId, botKey) {
    return `${threadId}:${botKey}`;
  }

  get(threadId, botKey) {
    return this.data[this.key(threadId, botKey)];
  }

  set(threadId, botKey, entry) {
    this.commit({ ...this.data, [this.key(threadId, botKey)]: entry });
  }

  delete(threadId, botKey) {
    const next = { ...this.data };
    delete next[this.key(threadId, botKey)];
    this.commit(next);
  }
}
