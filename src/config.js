// 設定 (config.policy.json + config.secrets.json) の読み込み・合成・解釈・起動時検証。
// ファイル読み込みは注入した fs で行うので副作用なし (Discord ログインへ走る index.js と
// 分離し、テストから直接 import できるようにしてある)。
//
// このファイルは**窓口**で、中身は項目ごとの `src/config-*.js` に分けてある (読み込む側は
// これまでどおり `./config.js` だけを見ればよい)。ここに残すのは、起動を許す相手
// (guildId / allowedUserIds / owner) の解釈と、全体を順に見る validateConfig。
//
// - config-sources.js    設定ファイル (policy / secrets) の読み込みと合成
// - config-channel.js    チャンネル設定・ツール権限
// - config-autonomy.js   自律運転・自動復旧
// - config-limits.js     ブリッジ全体の上限
// - config-bots.js       bot の定義と CLI の起動コマンド
// - config-initiative.js 発議と組織裁定・duty
// - config-util.js       値の形の判定 (再公開しない)

import { validateBots, validateCliCommands } from './config-bots.js';
import { validateChannel } from './config-channel.js';
import { validateInitiative } from './config-initiative.js';
import { validateLimits } from './config-limits.js';
import { isNonEmptyString, isPlainObject } from './config-util.js';
import { validateSociety } from './society-policy.js';

export * from './config-autonomy.js';
export * from './config-bots.js';
export * from './config-channel.js';
export * from './config-initiative.js';
export * from './config-limits.js';
export * from './config-sources.js';

/**
 * 人間 (作者) の呼び名。config.ownerNames で上書きできる。
 * 通知そのものは制御フッター [[notify:owner]] が決めるので、この名前は
 * 「平文で呼んでも起動しない」ことを知らせる旧記法検出にだけ使う (src/mentions.js)。
 */
export const DEFAULT_OWNER_NAMES = ['owner'];

/**
 * 人間への通知先。ownerUserId 未設定なら空配列 = [[notify:owner]] は実行されない。
 *
 * allowedUserIds[0] からの推測はしない — 許可ユーザーが複数になった日に
 * 「先頭の人」へ黙って通知が飛ぶ事故になる。呼ぶ相手は明示的に書かせる。
 */
export function resolveOwnerTargets(config = {}) {
  const userId = config?.ownerUserId;
  if (!isNonEmptyString(userId)) return [];
  const names = Array.isArray(config.ownerNames) && config.ownerNames.length > 0
    ? config.ownerNames
    : DEFAULT_OWNER_NAMES;
  return names
    .filter(isNonEmptyString)
    .map((displayName) => ({ displayName: displayName.trim(), userId: userId.trim() }));
}

/**
 * owner の呼び名が bot の displayName と衝突していないか。
 * 衝突していると「誰を呼んだつもりなのか」がスレッド上で判別できなくなり、
 * 旧記法の警告 (src/mentions.js) も宛先を言い当てられない。起動時に落とす。
 * 照合は大文字小文字を無視する (検出側の正規表現が i フラグのため)。
 */
export function validateOwnerNameClash(config = {}) {
  const ownerNames = resolveOwnerTargets(config).map((t) => t.displayName);
  if (ownerNames.length === 0 || !isPlainObject(config.bots)) return [];
  const errors = [];
  for (const [key, bot] of Object.entries(config.bots)) {
    const displayName = bot?.displayName;
    if (!isNonEmptyString(displayName)) continue;
    const hit = ownerNames.find((n) => n.toLowerCase() === displayName.trim().toLowerCase());
    if (hit) {
      errors.push(
        `owner の呼び名 "${hit}" が bots.${key}.displayName と同じ — ` +
          '人間宛のメンションが bot 起動に化けるので ownerNames を別の呼び名にする',
      );
    }
  }
  return errors;
}

/**
 * 起動時 config 検証 (fail-closed)。設定漏れが「全開放」や「暗黙の権限昇格」に
 * ならないよう、identity 境界 (guildId / allowedUserIds) と各チャンネルの
 * 必須項目・型を起動前に確かめる。
 *
 * 見るのは**合成後**の config — policy 単体は guildId も allowedUserIds も持たないので、
 * 分離した後もここの必須条件は変えない (境界は解決済み config で担保する)。
 * @returns {string[]} 人間向けエラー行 (空配列 = 起動してよい)
 */
export function validateConfig(config, { contractKindOf = null, repoRoot = null } = {}) {
  const errors = [];
  if (!isPlainObject(config)) return ['設定がオブジェクトとして読めない'];

  if (!isNonEmptyString(config.guildId)) {
    errors.push(
      'guildId が未設定 — 起動を許可する Discord サーバー ID を書く (未設定を「制限なし」と解釈しない)',
    );
  }

  const ids = config.allowedUserIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(
      'allowedUserIds が空 — 起動を許可するユーザー ID を 1 件以上書く ' +
        '(許可ユーザーはローカル OS 上でコマンドを実行できるのと同等の権限を持つ)',
    );
  } else if (!ids.every(isNonEmptyString)) {
    errors.push('allowedUserIds には非空の文字列 ID だけを書く');
  }

  // owner は「人間を呼ぶ先」であって認可とは別軸なので任意。ただし書いたなら効くこと
  // を保証する — 綴り違いを黙って無視すると「メンションしたのに通知が来ない」になる
  if (config.ownerUserId !== undefined && !isNonEmptyString(config.ownerUserId)) {
    errors.push(
      'ownerUserId は非空の文字列 ID で書く (人間へのメンションを使わないなら丸ごと省く)',
    );
  }
  if (config.ownerNames !== undefined) {
    if (
      !Array.isArray(config.ownerNames) ||
      config.ownerNames.length === 0 ||
      !config.ownerNames.every(isNonEmptyString)
    ) {
      errors.push(
        `ownerNames には非空の文字列を 1 件以上書く (省略時は ${DEFAULT_OWNER_NAMES.join(' / ')})`,
      );
    } else if (!isNonEmptyString(config.ownerUserId)) {
      errors.push('ownerNames を書くなら ownerUserId も書く (ID が無いと実メンションに変換できない)');
    }
  }
  errors.push(...validateOwnerNameClash(config));
  errors.push(...validateInitiative(config, { contractKindOf, repoRoot }));
  // 自律社会。**書いていなければ何も言わない** — 既定は off で、
  // 社会を使わない配備がこの検証で落ちることはない
  errors.push(...validateSociety(config));
  errors.push(...validateBots(config));
  errors.push(...validateCliCommands(config));
  errors.push(...validateLimits(config));

  const channels = config.channels;
  if (channels !== undefined && !isPlainObject(channels)) {
    errors.push('channels はオブジェクトで書く');
    return errors;
  }
  const botKeys = Object.keys(isPlainObject(config.bots) ? config.bots : {});
  for (const [name, cc] of Object.entries(channels ?? {})) {
    errors.push(...validateChannel(name, cc, { botKeys }));
  }
  return errors;
}
