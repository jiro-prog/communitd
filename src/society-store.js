/**
 * 社会台帳 `data/society.json` の入出力。
 *
 * 相互依存する記録 (Mandate / Finding / Case / Claim / Action / Evidence) を
 * **1 つの版付きスナップショット**として持つ。ドメイン判断は `src/cases.js` の純粋関数にあり、
 * ここは「読めたか・書けたか・どの版か」だけを見る。
 *
 * 既存 `JsonStore` (`src/store.js`) との違いは 3 つ。**継承していない**のは、
 * 「不在なら空で開く」というコンストラクタの前提がここでは逆 (不在は停止) だから:
 * - **不在を初回と推測しない** — `observe` / `active` でファイルが無ければ起動を止める。
 *   初期化は `node scripts/society-init.mjs` の明示操作だけ。
 * - **schema と revision を見る** — 未知の版・整数でない revision は broken。
 * - **`update(expectedRevision, mutate)`** — 版が食い違えば何も書かずに conflict を返す。
 *   保存は `<file>.tmp.<pid>.<乱数>` → fsync → rename で、失敗はメモリを巻き戻して throw する。
 *
 * `mode: 'off'` の SocietyStore は**ファイルシステムに一切触れない** (既存経路の回帰基準・受入 C15)。
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { LEDGER_BROKEN_KINDS } from './store.js';
import { COLLECTION_PREFIXES, validateSnapshot } from './cases.js';

/** 台帳の版。読めない版は `broken` にする (知らない形の上に書かない) */
export const SOCIETY_SCHEMA = 'society/1';

/** スナップショットが持つコレクション (すべて ID をキーにした object) */
export const SOCIETY_COLLECTIONS = Object.freeze([...Object.keys(COLLECTION_PREFIXES), 'episodes']);

/**
 * 読めなかった理由の分類。既存 `JsonStore` の 3 種に、この台帳だけが持つ 2 種を足したもの。
 * **不在はここに入らない** — 不在は「壊れている」ではなく「まだ作っていない」で、扱いも違う。
 */
export const SOCIETY_BROKEN_KINDS = Object.freeze([...LEDGER_BROKEN_KINDS, 'unknown-schema', 'bad-revision']);

/** 開いた結果 (`state`)。`ok` 以外では update を断る */
export const SOCIETY_STORE_STATES = Object.freeze(['off', 'absent', 'broken', 'ok']);

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 空のスナップショット (revision 0)。**書くのは明示初期化だけ** */
export function emptySnapshot(now) {
  const at = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString();
  const snapshot = { schema: SOCIETY_SCHEMA, revision: 0, updatedAt: at };
  for (const name of SOCIETY_COLLECTIONS) snapshot[name] = {};
  snapshot.counters = {};
  return snapshot;
}

/**
 * 読んだ本文を分類する (構文エラー / 未知 schema / revision 不正 / 構造不正)。
 * **ファイルには触らない純粋関数**で、読取りは呼び出し側の責務。
 *
 * export してあるのは **doctor が同じ判定を使うため** (Opus2 S2-1 レビュー ①)。
 * 分類を 2 か所に書くと「診断は通ったのに起動したら社会が止まっている」が生まれる —
 * 実際、未知 schema・revision 不正・コレクション欠落は `JSON.parse` だけ見る診断を素通りする。
 *
 * @param {string} text 台帳の中身
 * @returns {{data: object|null, broken: {kind, reason, at, code}|null}}
 */
export function classifySocietySnapshot(text, { at = () => new Date().toISOString() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { data: null, broken: { kind: 'syntax-error', code: null, reason: `JSON として読めません (${err.message})`, at: at() } };
  }
  if (!isPlainObject(parsed)) {
    return { data: null, broken: { kind: 'shape-error', code: null, reason: 'トップレベルが object ではありません', at: at() } };
  }
  if (parsed.schema !== SOCIETY_SCHEMA) {
    return {
      data: null,
      broken: {
        kind: 'unknown-schema',
        code: null,
        reason: `知らない schema です (${JSON.stringify(parsed.schema)} / このコードが読めるのは ${SOCIETY_SCHEMA})`,
        at: at(),
      },
    };
  }
  if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
    return {
      data: null,
      broken: {
        kind: 'bad-revision',
        code: null,
        reason: `revision が 0 以上の整数ではありません (${JSON.stringify(parsed.revision)})`,
        at: at(),
      },
    };
  }
  for (const name of [...SOCIETY_COLLECTIONS, 'counters']) {
    if (!isPlainObject(parsed[name])) {
      return {
        data: null,
        broken: { kind: 'shape-error', code: null, reason: `${name} が object ではありません`, at: at() },
      };
    }
  }
  return { data: parsed, broken: null };
}

/**
 * 1 ファイルを読んで 4 分類する (不在 / 読取エラー / 構文エラー / 構造不正)。
 * 構造不正には**未知 schema と revision 不正**も含む — 知らない版を「空の台帳」として
 * 扱うと、次の保存でその中身が消える。
 *
 * @returns {{data: object|null, broken: {kind, reason, at, code}|null, missing?: boolean}}
 */
function readSocietyFile(filePath) {
  const at = () => new Date().toISOString();
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { data: null, broken: null, missing: true };
    return {
      data: null,
      broken: {
        kind: 'read-error',
        code: err?.code ?? null,
        reason: `読み込めません (${err?.code ?? 'unknown'}: ${err?.message ?? err})`,
        at: at(),
      },
    };
  }
  return classifySocietySnapshot(text, { at });
}

/**
 * 隣に残った `<file>.tmp.*` を数える。**台帳として読まないし消さない** —
 * 部分更新の痕跡は「途中で落ちた」証拠なので、人が見るまで在処に残す。
 */
function findLeftovers(filePath) {
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.tmp.`;
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().map((name) => join(dir, name));
  } catch {
    // ディレクトリが無い = 台帳も無い (不在の判定は呼び出し側が済ませている)
    return [];
  }
}

/**
 * スナップショットを原子的に書く: `<file>.tmp.<pid>.<乱数>` → fsync → rename。
 *
 * 乱数を足すのは、同じ PID の連続実行や複数プロセスが同じ tmp 名を掴まないため。
 * 失敗したら tmp を消す — 消さないと次の起動が「部分更新が残っている」として止まる。
 */
function writeSnapshotAtomic(filePath, snapshot) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(snapshot, null, 2));
      // rename の前に fsync する — メタデータだけ先に飛ぶと、中身が空のファイルが台帳になる
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 消せなくても元の失敗を優先して伝える */ }
    throw err;
  }
}

/**
 * 台帳を新規に作る (明示初期化)。**既にあれば上書きしない。**
 * @returns {{ok: true, path: string, snapshot: object}|{ok: false, reason: string}}
 */
export function initSocietyLedger(filePath, { now = Date.now() } = {}) {
  if (existsSync(filePath)) {
    return {
      ok: false,
      reason: `${filePath} は既にあります — 上書きしません (作り直すなら手で退避してから実行してください)`,
    };
  }
  // **本体が無いのに痕跡だけ残っている = rename の前に落ちた形。** ここで空台帳を作ると、
  // 書きかけの中身を隣に残したまま「空から始まった台帳」ができる (しかも直後の起動は
  // leftovers で止まるので、init は成功したのに動かない)。作らずに人へ返す (Opus2 指摘 ⑥)
  const leftovers = findLeftovers(filePath);
  if (leftovers.length > 0) {
    return {
      ok: false,
      reason: `${filePath} は無いのに部分更新の痕跡が残っています `
        + `(${leftovers.map((p) => basename(p)).join(' / ')}) — `
        + '書き込みの途中で落ちた可能性があります。中身を確かめて片付けてから作り直してください',
    };
  }
  const snapshot = emptySnapshot(now);
  writeSnapshotAtomic(filePath, snapshot);
  return { ok: true, path: filePath, snapshot };
}

export class SocietyStore {
  /**
   * @param {string} filePath `data/society.json`
   * @param {{mode?: string, now?: () => number}} [options]
   *   `mode` は `resolveSociety(config).mode`。`off` ならファイルに触れない
   */
  constructor(filePath, { mode = 'off', now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.mode = mode;
    this.now = now;
    this.data = null;
    this.brokenInfo = null;
    this.leftoverFiles = [];

    if (mode === 'off') {
      // **ここで fs に触らない。** off は「機構ごと止めている」なので、
      // 存在確認すらしないのが既存経路の回帰基準 (C15)
      this.storeState = 'off';
      return;
    }

    const read = readSocietyFile(filePath);
    if (read.missing) {
      this.storeState = 'absent';
      return;
    }
    this.leftoverFiles = findLeftovers(filePath);
    if (read.broken) {
      this.brokenInfo = read.broken;
      this.storeState = 'broken';
      return;
    }
    this.data = read.data;
    this.storeState = 'ok';
  }

  /** `off` / `absent` / `broken` / `ok` */
  get state() {
    return this.storeState;
  }

  /** 読めなかった理由 (`{kind, reason, at, code}`)。読めていれば null */
  get broken() {
    return this.brokenInfo;
  }

  /** 隣に残っていた `<file>.tmp.*` (消していない) */
  get leftovers() {
    return [...this.leftoverFiles];
  }

  /** いまメモリにある版 (開けていなければ null) */
  get revision() {
    return this.data ? this.data.revision : null;
  }

  /** いまメモリにあるスナップショット (開けていなければ null) */
  get snapshot() {
    return this.data;
  }

  /** 台帳として信用して書けるか */
  get healthy() {
    return this.storeState === 'ok' && this.leftoverFiles.length === 0;
  }

  /**
   * 社会由来の起動を止める理由 (無ければ null)。
   *
   * `off` は「止まっている」ではなく「使っていない」ので null を返す —
   * 呼び出し側は `mode` で分岐し、ここは**動かすつもりなのに動かせない**場合だけを報告する。
   */
  get haltReason() {
    if (this.storeState === 'off' || this.healthy) return null;
    if (this.storeState === 'absent') {
      return `${basename(this.filePath)} がありません — society.mode が ${this.mode} なら台帳が要ります。`
        + '**初回とは推測しません** (壊れて消えたのか、まだ作っていないのかを区別できないため)。'
        + 'node scripts/society-init.mjs で明示的に作ってください';
    }
    if (this.brokenInfo) {
      return `${basename(this.filePath)} が読めません (${this.brokenInfo.reason}) — `
        + '読まない・書かない・社会由来の自律起動は止めます。台帳を直すか手で退避してください';
    }
    return `${basename(this.filePath)} の隣に部分更新の痕跡が残っています `
      + `(${this.leftoverFiles.map((p) => basename(p)).join(' / ')}) — `
      + '途中で落ちた保存を成功として続けません。中身を確かめて手で片付けてください';
  }

  /**
   * 版を確かめてから丸ごと差し替える。
   *
   * 1. メモリの `revision` と `expectedRevision` が違えば **conflict** (何も書かない・メモリも動かさない)。
   * 2. `mutate(snapshot)` の戻りを `validateSnapshot` に通す。1 件でも落ちれば書かない。
   * 3. `revision + 1` と `updatedAt` を付けて tmp → fsync → rename。
   *    **書けなかったらメモリを巻き戻して throw する** (`JsonStore.commit` と同じ流儀) —
   *    「呼び出し側は失敗を報告したのに、動いているプロセスには新しい値が効いている」を作らない。
   *
   * `mutate` は純粋関数として扱う (渡すのは複製なので、中で書き換えても保存前の状態は壊れない)。
   * 例外は**握らずに投げる** — 遷移関数のバグを「保存できなかった」に化けさせない。
   *
   * @returns {{ok: true, revision: number, snapshot: object}
   *          |{ok: false, code: 'off'|'absent'|'broken'|'leftovers'|'conflict'|'invalid',
   *            reason?: string, errors?: string[], revision?: number|null}}
   */
  update(expectedRevision, mutate) {
    if (this.storeState === 'off') {
      return { ok: false, code: 'off', reason: 'society.mode が off なので台帳に触れません' };
    }
    if (this.storeState === 'absent' || this.storeState === 'broken' || this.leftoverFiles.length > 0) {
      return {
        ok: false,
        code: this.storeState === 'ok' ? 'leftovers' : this.storeState,
        reason: this.haltReason,
      };
    }
    if (expectedRevision !== this.data.revision) {
      return {
        ok: false,
        code: 'conflict',
        revision: this.data.revision,
        reason: `版が違います (手元 ${expectedRevision} / 台帳 ${this.data.revision}) — 読み直してからやり直してください`,
      };
    }

    const next = mutate(structuredClone(this.data));
    if (!isPlainObject(next)) {
      return { ok: false, code: 'invalid', errors: ['mutate がスナップショット (object) を返しませんでした'] };
    }
    const errors = validateSnapshot(next);
    if (errors.length > 0) return { ok: false, code: 'invalid', errors };

    const committed = {
      ...next,
      schema: SOCIETY_SCHEMA,
      revision: this.data.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const prev = this.data;
    this.data = committed;
    try {
      writeSnapshotAtomic(this.filePath, committed);
    } catch (err) {
      this.data = prev;
      throw err;
    }
    return { ok: true, revision: committed.revision, snapshot: committed };
  }
}
