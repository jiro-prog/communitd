// @ts-check
// Discord で承認したツール権限を「構造化 grant」として持つ層。
//
// ルール文字列 (`WebFetch(domain:x)`) をそのまま保存すると、記法が変わった日に移行できず、
// 保存値と表示値の区別も付かない。種類・ツール・値を分けて持ち、ルール文字列は読むたびに
// 組み立てる。**値は無加工** — trim も無害化もしない (別の値を承認したことになる)。
//
// **自動承認できるのは web-domain だけ** (sol 裁定 2026-08-01)。
//   shell は不可: claude は照合前に timeout や裸の xargs のような wrapper を除去するため、
//                 「コマンド文字列の完全一致」が実行されるコマンドの同一性を保証しない。
//                 生文字列一致を保証するには PreToolUse hook が要る。
//   パスは不可: パス指定子は gitignore パターンで、実行中に対象がディレクトリへ差し替わると
//               「1 ファイルだけ」を保証できない。
// どちらも「人間が config.json へ貼れる候補」の表示までは行う (src/toolrules.js)。
//
// 生成・登録・保存・読込・job 開始のすべてがこのモジュールの validateGrant() を通る。

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

/** data/tools-extra.json のスキーマ版。未知の版は読まずに落とす */
export const GRANT_SCHEMA_VERSION = 2;

/** 自動承認できる grant の種類 */
export const GRANT_KINDS = ['web-domain'];

/** 種類ごとに許すツール */
const TOOLS_FOR_KIND = {
  'web-domain': ['WebFetch'],
};

/** grant が持ってよいキー (余分なキーがあれば壊れた入力として捨てる) */
/**
 * 承認済みのツール許可 1 件 (data/tools-extra.json の要素)。
 * @typedef {{kind: string, tool: string, value: string, cwd: string, approvedBy?: string,
 *   approvedAt?: string, botKey?: string, threadId?: string}} Grant
 */

const GRANT_KEYS = ['kind', 'tool', 'value', 'cwd', 'approvedBy', 'approvedAt', 'botKey', 'threadId'];
const REQUIRED_KEYS = ['kind', 'tool', 'value', 'cwd'];

/**
 * ドメイン名。末尾に英字だけの TLD を要求するので、localhost のような単一ラベルも
 * 127.0.0.1 のような IP も通らない (内部宛の恒久許可を作らない)。
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** 秘密らしい語・秘密らしいトークン列 (ホスト名にも効かせる) */
const SECRET_WORD =
  /(\.env\b|\btokens?\b|\bsecrets?\b|\bpass(word|wd)?\b|\bcredentials?\b|api[_-]?key|private[_-]?key|\bkeys?\b|id_[rd]sa)/i;
const SECRET_BLOB = /([A-Za-z0-9+/]{32,}={0,2}|[0-9a-f]{32,})/;

/** 組み立てたルール文字列の上限 (Discord 表示と config の可読性のため) */
const MAX_RULE_LENGTH = 200;

/**
 * 作業ディレクトリを比較用の正規形へ直す。
 *
 * 承認時・保存時・job 開始時の**すべて**をこれに通すので、junction 越しや区切り違い・
 * 末尾スラッシュ・Windows のケーシング差で取りこぼさない。
 * 解決できなければ null (呼び出し側は fail-closed)。
 */
export function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  try {
    // native は Windows で実際のケーシングまで正規化する (同じ場所が別文字列にならない)
    const resolver = realpathSync.native ?? realpathSync;
    return resolver(cwd).replaceAll('\\', '/').replace(/\/+$/, '');
  } catch {
    return null; // 消えた・権限が無い作業ディレクトリの承認は使わない
  }
}

/**
 * grant として妥当か。**生成・登録・保存・読込・job 開始のすべてがここを通る。**
 * 「保存したときは正しかったが今は不正」なものを黙って使わないため。
 *
 * @returns {{ok: true, grant: Grant} | {ok: false, reason: string}}
 */
export function validateGrant(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'grant がオブジェクトではありません' };

  for (const key of Object.keys(raw)) {
    if (!GRANT_KEYS.includes(key)) return { ok: false, reason: `未知のキー ${key} を含みます` };
  }
  for (const key of REQUIRED_KEYS) {
    if (!isNonEmptyString(raw[key])) return { ok: false, reason: `${key} がありません` };
  }

  const { kind, tool, value, cwd } = raw;
  if (!GRANT_KINDS.includes(kind)) return { ok: false, reason: `未知の kind: ${kind}` };
  if (!TOOLS_FOR_KIND[kind].includes(tool)) {
    return { ok: false, reason: `${kind} に ${tool} は使えません` };
  }
  // 値は無加工が原則。前後に空白がある時点で「別の何か」として扱う
  if (value !== value.trim()) return { ok: false, reason: 'value の前後に空白があります' };

  // cwd は正規形そのものでなければならない。表記違い (C:\ と C:/) を許すと
  // 「承認も保存も成功したのに次の job で一致しない」が起きる
  if (canonicalCwd(cwd) !== cwd) {
    return { ok: false, reason: 'cwd が正規形ではありません (解決できないか表記が違います)' };
  }

  const detail = checkDomain(value);
  if (detail) return { ok: false, reason: detail };

  if (renderRule(raw).length > MAX_RULE_LENGTH) {
    return { ok: false, reason: `ルールが長すぎます (> ${MAX_RULE_LENGTH} 字)` };
  }
  return { ok: true, grant: /** @type {Grant} */ (raw) };
}

/** ドメイン限定として承認してよいか */
function checkDomain(host) {
  if (host !== host.toLowerCase()) return 'ドメインは小文字で持ちます';
  if (!HOSTNAME.test(host)) return `取得先のホスト名を特定できないため恒久承認できません (${host})`;
  // ホスト名にも秘密が混じりうる (api-key-<32hex>.example.com のような発行済みエンドポイント)。
  // 承認ログにも Discord にも残るので、疑わしければ恒久承認しない
  if (SECRET_WORD.test(host) || SECRET_BLOB.test(host)) {
    return '秘密らしい文字列を含むホスト名は恒久承認できません';
  }
  return null;
}

/**
 * claude の --allowedTools へ渡す形。
 * **保存するのは grant であってこの文字列ではない** — 記法が変わっても再生成できる。
 */
export function renderRule(grant) {
  if (grant?.kind === 'web-domain') return `${grant.tool}(domain:${grant.value})`;
  return `${grant?.tool}(${grant?.value})`;
}

/**
 * grant の同一性を表す短い指紋。
 * 承認カードの nonce をこれに束縛して、押した瞬間に別の grant へすり替わっていない
 * ことを確かめる。値そのものはログへ出さない (秘密が混じる余地を残さない)。
 */
export function grantDigest(grant) {
  const canonical = JSON.stringify([grant?.kind, grant?.tool, grant?.value, grant?.cwd]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** 監査ログに出してよい形 (値そのものは出さない) */
export function grantFingerprint(grant) {
  return `${grant?.kind}/${grant?.tool}#${grantDigest(grant)}`;
}

/**
 * grant 候補を作る入り口。**値には一切手を加えない** —
 * trim して通すと「要求された値とは別の値」を承認したことになる。
 */
export function makeGrant({ kind, tool, value, cwd }) {
  return validateGrant({ kind, tool, value, cwd });
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}
