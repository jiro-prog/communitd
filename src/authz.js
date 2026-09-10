// 発言者の認可判定 (純粋関数)。入口の identity 境界はチャンネル「名」でなく ID で縛る。

/**
 * この発言でブリッジを動かしてよいか。
 * guildId / allowedUserIds は validateConfig が非空を保証するため、
 * 「設定されていれば照合する」ではなく常に照合する (設定漏れ = 全開放にしない)。
 *
 * @param {object} p
 * @param {object} p.config      config.json
 * @param {string} p.guildId     発言のあった Guild ID (DM なら null)
 * @param {string} p.authorId    発言者 ID
 * @param {boolean} p.isBot      発言者が bot か
 * @param {string[]} p.ourBotIds 自前 registry の bot ユーザー ID
 */
export function isAuthorizedSender({ config, guildId, authorId, isBot, ourBotIds = [] }) {
  if (typeof config?.guildId !== 'string' || config.guildId === '') return false;
  if (guildId !== config.guildId) return false;
  // bot 発でトリガーしてよいのは自前 registry の bot だけ (他所の bot は無視)
  if (isBot) return ourBotIds.includes(authorId);
  return Array.isArray(config.allowedUserIds) && config.allowedUserIds.includes(authorId);
}
