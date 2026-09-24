// 自律運転 (`channels.<name>.autonomy`) と自動復旧 (`autonomy.recovery`) の解釈と検証。

import { DEFAULT_JOB_BUDGET } from './board.js';
import { isNonEmptyString, isPlainObject, isPositiveInt } from './config-util.js';

/**
 * 自律運転のチャンネル設定。
 *
 * スケジューラ (未実装) が tick ごとに読む値。**既定は「何も起きない」側**で、
 * `enabled: true` と明示的に書いたチャンネルだけが自律起動の対象になる。
 * 綴り違い・型不正・範囲外は起動時検証 (validateAutonomy) が落とすので、
 * ここは黙って既定へ倒して fail-closed にする。
 */
export const DEFAULT_AUTONOMY_ENABLED = false;

/** 方向性ドキュメント = 社会の憲法。チャンネルの cwd 基準 */
export const DEFAULT_DIRECTION_FILE = 'docs/direction.md';

/**
 * タスクの作業ツリーを生やす基点。**既定ブランチの自動検出はしない** —
 * 検出に頼ると、たまたま別のブランチが出ていた日に「前のタスクの上に積まれた」
 * (#9 と同じ壊れ方) が静かに再発する。書いてある方が事故らない (Sol 推奨 2026-08-28)。
 */
export const DEFAULT_BASE_BRANCH = 'main';

/** 同時に走らせるタスク数 (ペース制御・裁定 2026-08-27「同時タスク 2 くらいから」) */
export const DEFAULT_MAX_CONCURRENT_TASKS = 2;

/** そのチャンネルの自律 job の 1 日あたり上限 (人間メンション起点の job は数えない) */
export const DEFAULT_MAX_JOBS_PER_DAY = 40;

/**
 * 1 タスクへ払い出す job 予算。
 * 値の正本はボード側 (board.js) — 「設定を書かなかったチャンネル」と
 * 「予算を渡さずに起票したタスク」で違う数字が効くと追いかけられなくなる。
 */
export const DEFAULT_TASK_JOB_BUDGET = DEFAULT_JOB_BUDGET;

/** スカウトを起こす間隔 (分) */
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

// ---- 自動復旧 ----

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
 * `autonomy.recovery` → 実効値。書いていない配備は observe (起こさない・観測だけ)。
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

/**
 * 自律運転設定の不変条件。
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

  // 自動復旧。未知キー・型違いは起動時に落とす — 「observe のつもりが auto」や
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
    // 自律運転は人が見ていない間に main へ昇格する。機械検証が無いチャンネルで
    // 有効にすると、壊れたまま merge される経路だけが残る
    if (!hasVerify) {
      errors.push(
        `${at}.enabled: true には channels.${channel}.verify (と hooks: true) が要る ` +
          '— 人が見ていない間に main へ昇格するので、機械検証の無いチャンネルでは有効にしない',
      );
    }
    // 規約「自己レビュー禁止 (執筆と検収は別 bot)」を、設定だけで破れる形を潰す。
    // worker が reviewer 1 人しか居ないと、必ず自分の書いたものを自分で通すことになる
    const resolved = resolveAutonomy({ autonomy });
    const workers = resolved.worker.bots;
    if (resolved.reviewer && workers.length > 0 && workers.every((k) => k === resolved.reviewer)) {
      errors.push(
        `${at}: worker.bots が reviewer (${resolved.reviewer}) だけになっている ` +
          '— 執筆と検収は別 bot にする (自己レビュー禁止)',
      );
    }
  }

  return errors;
}
