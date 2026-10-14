// 発言者の認可判定 (純粋関数)。入口の identity 境界はチャンネル「名」でなく ID で縛る。

const isNonEmptyId = (v) => typeof v === 'string' && v !== '';

/**
 * discord.js の member から**サーバーロールの ID 配列**を取り出す。
 *
 * 形が 2 つある — キャッシュのある GuildMember は `roles.cache` (Collection)、
 * 未キャッシュの interaction では `roles` が ID の配列 (APIInteractionGuildMember)。
 * どちらでもない (member そのものが取れなかった) ときは**空配列** = ロールでは通さない。
 * 取り直しに行かないのは、認可判定を非同期にしないため (fail-closed のまま
 * allowedUserIds の照合だけが残る)。
 */
export function roleIdsOf(member) {
  const roles = member?.roles;
  if (Array.isArray(roles)) return roles.filter(isNonEmptyId);
  const cache = roles?.cache;
  if (cache && typeof cache.keys === 'function') return [...cache.keys()].filter(isNonEmptyId);
  return [];
}

/**
 * この発言でブリッジを動かしてよいか。
 * guildId / allowedUserIds は validateConfig が非空を保証するため、
 * 「設定されていれば照合する」ではなく常に照合する (設定漏れ = 全開放にしない)。
 *
 * allowedRoleIds は**任意**で、書いてあるときだけ「そのロールを持つ人」を足す
 * (ID を 1 人ずつ集めなくてよくするための口)。**owner 判定は広げない** —
 * ownerUserId の照合は呼び出し側に残したままなので、ロールで裁定権者は増えない。
 *
 * @param {object} p
 * @param {object} p.config      config.json
 * @param {string} p.guildId     発言のあった Guild ID (DM なら null)
 * @param {string} p.authorId    発言者 ID
 * @param {boolean} p.isBot      発言者が bot か
 * @param {string[]} p.ourBotIds 自前 registry の bot ユーザー ID
 * @param {string[]} p.roleIds   発言者が持つロール ID (`roleIdsOf(member)` で取る)
 */
export function isAuthorizedSender({
  config, guildId, authorId, isBot, ourBotIds = [], roleIds = [],
}) {
  if (typeof config?.guildId !== 'string' || config.guildId === '') return false;
  if (guildId !== config.guildId) return false;
  // bot 発でトリガーしてよいのは自前 registry の bot と、作者がメンテ用に登録した bot だけ
  // (他所の bot は無視)。メンテ用の扱いは senderKindOf と src/bridge/messages.js を参照
  if (isBot) return ourBotIds.includes(authorId) || isMaintenanceBot(config, authorId);
  // 発言者が特定できないものは通さない。allowedRoleIds を足す前は
  // 「allowedUserIds に undefined は入っていない」で必ず false だった層なので、
  // ロールだけで通れるようになった今は明示的に閉じる (Opus2 レビュー 2026-09-13 M1)
  if (!isNonEmptyId(authorId)) return false;
  if (Array.isArray(config.allowedUserIds) && config.allowedUserIds.includes(authorId)) return true;
  const allowedRoles = Array.isArray(config.allowedRoleIds)
    // @everyone (= guildId) は validateConfig が起動時に拒むが、判定側でも落とす —
    // 検証を通らない config がここへ届いた日に「全員許可」が開くのを防ぐ (Opus2 レビュー 2026-09-13 M2)。
    // GuildMemberRoleManager は roles.cache に必ず guild.id を入れるので、素通しにできない
    ? config.allowedRoleIds.filter((id) => isNonEmptyId(id) && id !== config.guildId)
    : [];
  if (allowedRoles.length === 0) return false;
  return (Array.isArray(roleIds) ? roleIds : []).some(
    (id) => isNonEmptyId(id) && allowedRoles.includes(id),
  );
}

/**
 * 作者がメンテ用に登録した bot か (`maintenanceBotIds`、config.secrets.json)。
 * 作者の手元の Claude Code が Discord の MCP で書き込むための bot で、作者の代理として扱う。
 */
export function isMaintenanceBot(config, authorId) {
  if (!isNonEmptyId(authorId)) return false;
  const ids = Array.isArray(config?.maintenanceBotIds) ? config.maintenanceBotIds : [];
  return ids.filter(isNonEmptyId).includes(authorId);
}

/**
 * 発言者の種類。認可 (isAuthorizedSender) を通った発言にだけ使う。
 * - `human`       人間。往復の上限をリセットする (主導権が人間へ戻る)
 * - `bot`         自前 registry の bot。スレッド内でだけ起動でき、往復の上限を消費する
 * - `maintenance` メンテ用の bot。作者の代理としてチャンネル直下でも新しい仕事を起こせるが、
 *                 スレッド内では bot と同じく往復の上限を消費し、リセットはしない
 *                 (作者の手元の Claude Code と bot の間の無限往復を、bot 同士と同じ門で止める)。
 *                 自前 registry の bot と同じ ID なら bot として扱う (登録の重複で権限は広げない)
 * - `relay`       受付 bot (docs/notes/2026-10-11-intake.md)。チャンネル直下の人間の発言を
 *                 スレッドへ中継した投稿なので、**人間の発言と同じ枝へ通す** (往復の上限をリセットし、
 *                 受信箱を閉じ、タスクの job 予算を減らさない)。受付 bot は通常の job を走らせない
 *                 ので、受付 bot の投稿を作るのはブリッジだけ — 人間の重みで通してよい根拠はそこ。
 *                 `relayBotIds` は起動後に分かるユーザー ID なので呼び出し側が渡す
 * @returns {'human'|'bot'|'maintenance'|'relay'}
 */
export function senderKindOf({ config, authorId, isBot, ourBotIds = [], relayBotIds = [] }) {
  if (!isBot) return 'human';
  if (isNonEmptyId(authorId) && relayBotIds.includes(authorId)) return 'relay';
  if (ourBotIds.includes(authorId)) return 'bot';
  return isMaintenanceBot(config, authorId) ? 'maintenance' : 'bot';
}
