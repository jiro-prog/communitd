// 「この発言はこの bot 宛か」の判定 (純粋関数)。
// メンション経路と返信経路をここに一本化し、配線側 (src/bridge/messages.js) は
// Discord からの取得 (返信先メッセージ) だけを担う。

import { formatContractTag, readContractNonce } from './contract.js';

/**
 * content に「この bot 宛」の明示メンションがあるか。
 * @ボット名の入力補完でユーザー <@id> でなく同名の管理ロール <@&id> が
 * 選ばれることがあり、見た目のピルは区別できないため両方を宛先として扱う
 * (2026-07-29 実測)。
 */
export function mentionsBot(content, { userId, roleId } = {}) {
  if (typeof content !== 'string') return false;
  if (userId && new RegExp(`<@!?${userId}>`).test(content)) return true;
  return Boolean(roleId && content.includes(`<@&${roleId}>`));
}

/**
 * 自分自身の発言を入口で捨てるか。
 *
 * 原則は「捨てる」— 自分の投稿で自分が起動したら、報告 1 通ごとに job が湧く。
 * **例外は自己呼び出しの制御メッセージだけ**: 制御フッター `[[handoff:自分]]` が
 * 解決されると、完了境界の専用 1 通が送られる (src/mentions.js の sendControlMention)。
 *
 * **「本文のどこかに自分宛メンションがある」では絶対に判定しない。** ブリッジは
 * 無害化を通らない投稿もスレッドへ出す — verify の失敗出力・ツール軌跡・git 差分は
 * どれも外部由来の文字列で、そこに bot ID が紛れれば自己 job が湧く
 * (実際 test/mentions.test.js には実 ID 形式のリテラルがあり、テストが落ちれば
 * verify 出力に載る — sol 指摘 2026-08-21)。allowedMentions は通知を止めるだけで
 * `msg.content` は変えないので、そちらでは防げない。
 *
 * そこで**制御メッセージの形と完全に一致する場合だけ**通す:
 *   1 行目 = `<@自分の ID>` ちょうど (`<@!id>` は生成しないので拒否)
 *   2 行目 = あれば契約タグ 1 個ちょうど (src/contract.js が決める形)
 * 前後に本文が付いていれば別物として捨てる。
 */
export function shouldIgnoreOwnMessage({ authorId, botUserId, content } = {}) {
  if (!botUserId || authorId !== botUserId) return false; // そもそも自分の発言ではない
  const lines = String(content ?? '').trim().split('\n');
  if (lines.length > 2 || lines[0] !== `<@${botUserId}>`) return true;
  // 2 行目は契約タグ**だけ**。往復 (読む → 同じ形に書き戻す) で照合するので、
  // タグの文法を持つのは contract.js 側の 1 か所だけで済む
  if (lines.length === 2 && formatContractTag(readContractNonce(lines[1])) !== lines[1]) return true;
  return false;
}

/**
 * 返信先メッセージを取りに行くべきか (無駄な API 呼び出しと誤判定を減らす)。
 * 返信起動は人間の発言だけに認める — bot 同士はメンションで明示的に委譲する
 * 決まりで、返信でも動くと「相手の報告に一言返した」だけで往復が始まる。
 *
 * @param {object} p
 * @param {boolean} p.authorIsBot 発言者が bot か
 * @param {object|null} p.reference message.reference (返信でなければ null)
 * @param {string|null} p.channelId 発言のあったチャンネル ID
 */
export function shouldLookupReply({ authorIsBot = false, reference = null, channelId = null } = {}) {
  if (authorIsBot) return false;
  if (!reference?.messageId) return false;
  // MessageReferenceType.Default(0) 以外 = 転送 (Forward) 等。返信ではない
  if (reference.type != null && reference.type !== 0) return false;
  // 別チャンネルの発言を参照する reference は返信ではない
  if (reference.channelId && channelId && reference.channelId !== channelId) return false;
  return true;
}

/**
 * 返信先メッセージの投稿者 ID。返信でなければ取得そのものを行わず null。
 * 取得できない場合 (削除済み・権限不足・API 失敗) も null を返して
 * メンション経路の判定だけで続行する — ここで throw して発言を取りこぼさない。
 *
 * @param {{author?: object, reference?: object, channelId?: string,
 *          fetchReference?: () => Promise<object>}} msg discord.js の Message
 */
export async function replyAuthorId(msg) {
  if (
    !shouldLookupReply({
      authorIsBot: Boolean(msg?.author?.bot),
      reference: msg?.reference ?? null,
      channelId: msg?.channelId ?? null,
    })
  ) return null;
  try {
    const ref = await msg.fetchReference();
    return ref?.author?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * この発言でこの bot を起動するか。
 *
 * - メンションがあれば起動 (人間・自前 bot 双方。従来どおり)
 * - 人間が**この bot の発言**へ返信したときもメンションなしで起動
 * - 他人・他 bot への返信、bot からの返信は対象外
 * - 返信 + 本文に他 bot への明示メンション = そちらへの依頼とみなし起動しない
 *   (「Opus の報告に返信しつつ @Sol に聞く」で Opus まで動くのを防ぐ)
 *
 * 起動理由は via で 1 つに畳まれるので、同じ発言で二重に job は積まれない。
 *
 * 返信先は lookupReply の**遅延呼び出し**で受ける。本文だけで宛先が決まる限り
 * 呼ばないので、メンション起動が Discord API の往復で待たされない。
 * lookupReply が throw / reject した場合は「返信先不明」として扱う。
 *
 * @param {object} p
 * @param {string} p.content            生の発言本文 (cleanContent ではない)
 * @param {string} p.botUserId          この bot のユーザー ID (ready 前は空)
 * @param {string|null} p.botRoleId     この bot の管理ロール ID
 * @param {boolean} p.authorIsBot       発言者が bot か
 * @param {Array<{userId: string, roleId?: string|null}>} p.otherBots 自分以外の自前 bot
 * @param {() => (string|null|Promise<string|null>)} [p.lookupReply] 返信先投稿者 ID の取得
 * @returns {Promise<{triggered: boolean, via: 'mention'|'reply'|null}>}
 */
export async function resolveTrigger({
  content = '',
  botUserId = null,
  botRoleId = null,
  authorIsBot = false,
  otherBots = [],
  lookupReply = null,
} = {}) {
  const none = { triggered: false, via: null };
  if (!botUserId) return none;
  if (mentionsBot(content, { userId: botUserId, roleId: botRoleId })) {
    return { triggered: true, via: 'mention' };
  }
  // ここから先は返信経路だけ。本文で結論が出るものは参照を取りに行かない
  if (authorIsBot) return none;
  if (otherBots.some((b) => mentionsBot(content, b))) return none;
  if (!lookupReply) return none;

  let repliedToAuthorId = null;
  try {
    repliedToAuthorId = await lookupReply();
  } catch {
    return none; // 返信先が分からなければ起動しない (メンションは上で判定済み)
  }
  if (!repliedToAuthorId || repliedToAuthorId !== botUserId) return none;
  return { triggered: true, via: 'reply' };
}
