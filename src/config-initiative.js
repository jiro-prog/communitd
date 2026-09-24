// 発議と組織裁定 (`initiative`) と、bot ごとの duty の解釈と検証。

import { resolve } from 'node:path';
import { resolveAutonomy } from './config-autonomy.js';
import { resolveStructuredOutputEnabled } from './config-channel.js';
import { SECRETS_FILE } from './config-sources.js';
import { isNonEmptyString, isPlainObject, isPositiveInt } from './config-util.js';

// ---- 発議と組織裁定 ----

/** `initiative` が持てるキー (増やすときは validateInitiative も直す) */
export const INITIATIVE_KEYS = ['enabled', 'execBotKeys', 'applyChannel'];

/**
 * 発議機構が有効か。**既定は無効** — 設定に書いていない配備で組織提案が動き出さない。
 */
export function isInitiativeEnabled(config = {}) {
  return config?.initiative?.enabled === true;
}

/**
 * `work | process` を経営裁量で裁定できる bot (CEO 代理)。
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
 * 採択された `org | process` を当てる専用回路のチャンネル (`org-apply`)。
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

// ---- duty ----
//
// 職務憲章の散文は `roles/<key>.md` にあり、config が持つのは**機械が扱う分だけ**。
// `duties` を配列でなく key オブジェクトにしてあるのは、`/bots/<bot>/duties/<dutyKey>`
// という RFC 6901 pointer で安定して指すため (配列添字は並べ替えで壊れ、`duty-edit`
// 提案の target が別の duty を指してしまう)。

/** 1 つの duty が持てるキー (増やすときは validateBotDuties も直す) */
export const DUTY_KEYS = ['intervalMin', 'maxOpenProposals', 'eventKinds'];

/**
 * duty を起こすイベント (発議 3 経路のうち (2))。
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
 * bot ごとの日次発議 job 上限。**ノルマではなく上限**で、
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
 * **有効にするなら `ownerUserId` を必須にする** — org 提案を裁定できるのは
 * 作者だけで、ID が無いと `canAdjudicate` が誰も通さない。裁定できない提案が
 * 黙って溜まるより、起動時に落ちた方がよい。
 *
 * @param {object} config 合成後の config
 * @param {{contractKindOf?: (botKey: string) => string|null}} [deps]
 *   その bot の役割文が宣言しているスキーマ種別を返す関数 (省略すると役割文は見ない)。
 *   注入にしてあるのは、このモジュールがファイルを読まないため (判定はテストから直接叩ける)
 */
/**
 * 適用回路のチャンネルが条件を満たすか。
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
