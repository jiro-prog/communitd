// @ts-check
// 設定ファイル (policy / secrets) の読み込みと合成。

import { isPlainObject } from './config-util.js';

// ---- 設定ファイルの分離 (policy / secrets) ----
//
// 設定は 2 ファイルに分かれている。**git 管理する** `config.policy.json` (bot・channel・
// autonomy・予算などの非秘密設定) と、**gitignore する** `config.secrets.json`
// (サーバー ID・ユーザー ID といった秘密・個人情報)。
//
// 分ける理由は M2 の `org-apply` — 採択された組織提案の
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
