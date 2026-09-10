// Discord のチャンネル作成まわり (add-project 第 2 段階)。
// Discord への実アクセスは discord オブジェクトの注入で受ける — ここは
// 手順と失敗時の始末だけを持ち、テストから fake を差せるようにする。
//
// discord に要るメソッド:
//   listChannels(guildId)          → チャンネル配列
//   createChannel(guildId, body)   → 作成されたチャンネル
//   deleteChannel(channelId)       → 削除

/** ChannelType.GuildText */
export const TEXT_CHANNEL_TYPE = 0;

/**
 * チャンネル作成を担当する bot。
 *
 * **コードは bot キーを決め打ちしない** (顔ぶれは配備ごとに違う) — 既定は `config.bots` の
 * 先頭で、呼び出し側が指名したいときだけ `preferred` を渡す。
 */
export function pickChannelCreator(config, preferred = null) {
  const bots = config?.bots;
  if (!bots || typeof bots !== 'object') return null;
  if (preferred && bots[preferred]) return { key: preferred, cfg: bots[preferred] };
  const [key, cfg] = Object.entries(bots)[0] ?? [];
  return key ? { key, cfg } : null;
}

/**
 * 同名のテキストチャンネルを**すべて**返す。
 * Discord はチャンネル名を小文字化するので、照合も小文字で行う。
 *
 * 1 件だけ返す API にしないのは、ブリッジがチャンネル「名」で config を引くため —
 * 同名が複数あるとどれも同じプロジェクト設定で動いてしまう。呼び出し側が
 * 重複に気づけるようにする。
 */
export function matchTextChannels(channels, name) {
  if (!Array.isArray(channels) || typeof name !== 'string') return [];
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return [];
  return channels
    .filter((c) => c?.type === TEXT_CHANNEL_TYPE && String(c?.name ?? '').toLowerCase() === wanted)
    .map((c) => ({ id: c.id, name: c.name }));
}

/** 同名が複数あるときの中止理由 */
function ambiguous(name, hits, extra = '') {
  return {
    ok: false,
    reason: 'ambiguous',
    message:
      `#${name} と同じ名前のテキストチャンネルが ${hits.length} 個あります ` +
      `(ID: ${hits.map((h) => h.id).join(', ')})\n` +
      '  → ブリッジはチャンネル名で config を引くので、どれも同じプロジェクト設定で動きます。' +
      `Discord 側で重複を解消してからやり直してください${extra}`,
  };
}

/** エラー文からトークンを伏せる (ログにも Discord にも出さない) */
export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : (value?.message ?? String(value));
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.replaceAll(secret, '***');
  }
  return text;
}

function failure(err, secrets, prefix) {
  const status = err?.status ?? err?.httpStatus ?? null;
  const reason = status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : 'api-failed';
  const hint =
    reason === 'forbidden'
      ? '\n  → この bot のロールに「チャンネルの管理」を付けてください (サーバー設定 → ロール)'
      : reason === 'unauthorized'
        ? '\n  → .env のトークンを確認してください'
        : '';
  return { ok: false, reason, message: `${prefix}: ${redact(err, secrets)}${hint}` };
}

/**
 * チャンネルを用意する。同名のテキストチャンネルがあれば作らずそれを使う。
 * @returns {Promise<{ok: true, channel: {id: string, name: string}, created: boolean}
 *   | {ok: false, reason: string, message: string}>}
 */
export async function ensureChannel({ discord, guildId, name, secrets = [] }) {
  let existing;
  try {
    existing = matchTextChannels(await discord.listChannels(guildId), name);
  } catch (err) {
    return failure(err, secrets, 'チャンネル一覧を取得できません');
  }
  if (existing.length > 1) return ambiguous(name, existing);
  if (existing.length === 1) return { ok: true, channel: existing[0], created: false };

  let channel;
  try {
    const created = await discord.createChannel(guildId, { name, type: TEXT_CHANNEL_TYPE });
    if (!created?.id) throw new Error('作成 API が id を返しませんでした');
    channel = { id: created.id, name: created.name ?? name };
  } catch (err) {
    return failure(err, secrets, 'チャンネルを作成できません');
  }

  // 作成 API に名前の一意性は保証されていないので、作った直後に確かめる。
  // 確認できないまま config を書くと、重複に気づかないまま運用に入ってしまう
  let after;
  try {
    after = matchTextChannels(await discord.listChannels(guildId), name);
  } catch (err) {
    const rolled = await rollbackChannel({ discord, channel, created: true, secrets });
    return failure(
      err,
      secrets,
      `作成後の確認ができません (${rolled.ok ? `作成した #${channel.name} は削除しました` : rolled.message})`,
    );
  }
  // 成功と言えるのは「同名が 1 件だけ、しかもそれが今作ったもの」のときだけ。
  // 0 件 (反映されていない) や別 ID 1 件 (他所が作った同名) を通すと、
  // config が指す先と実際のチャンネルがずれる
  if (after.length !== 1 || after[0].id !== channel.id) {
    const rolled = await rollbackChannel({ discord, channel, created: true, secrets });
    const note = rolled.ok
      ? `\n  (この実行で作った #${channel.name} は削除しました)`
      : `\n  ${rolled.message}`;
    if (after.length > 1) return ambiguous(name, after, note);
    return {
      ok: false,
      reason: 'unverified',
      message:
        (after.length === 0
          ? `作成した #${channel.name} (ID: ${channel.id}) が一覧に見つかりません`
          : `#${name} として別のチャンネル (ID: ${after[0].id}) が見つかりました`) +
        '\n  → 作成結果を確かめられないので中止します' +
        note,
    };
  }

  return { ok: true, channel, created: true };
}

/**
 * この実行で作ったチャンネルだけ消す。
 * 既存を再利用しただけの場合は触らない (人の作ったチャンネルを消さない)。
 */
export async function rollbackChannel({ discord, channel, created, secrets = [] }) {
  if (!created || !channel?.id) return { ok: true, skipped: true };
  try {
    await discord.deleteChannel(channel.id);
    return { ok: true, deleted: true };
  } catch (err) {
    return {
      ok: false,
      message:
        `作成した #${channel.name} を消せませんでした: ${redact(err, secrets)}` +
        '\n  → Discord 側で手動で削除してください',
    };
  }
}

/**
 * 「チャンネルを用意して config を保存する」ひとまとまり。
 * - チャンネルを用意できなければ config は書かない
 * - config を書けなければ、この実行で作ったチャンネルを消して元の状態へ戻す
 *
 * @param {object} p
 * @param {() => Promise<object>|object} p.save config 保存 ({ok} を返す)
 */
export async function createChannelAndSave({ discord, guildId, name, save, secrets = [] }) {
  const ensured = await ensureChannel({ discord, guildId, name, secrets });
  if (!ensured.ok) return { ok: false, stage: 'channel', ...ensured };

  // save が throw / reject しても、作ったチャンネルを置き去りにしない
  let saved;
  try {
    saved = await save();
  } catch (err) {
    saved = { ok: false, reason: 'save-failed', message: `config を保存できません: ${redact(err, secrets)}` };
  }
  if (!saved || typeof saved !== 'object') {
    saved = { ok: false, reason: 'save-failed', message: 'config の保存結果を受け取れませんでした' };
  }
  if (saved.ok) {
    return { ok: true, channel: ensured.channel, created: ensured.created, saved };
  }

  const rolledBack = await rollbackChannel({
    discord,
    channel: ensured.channel,
    created: ensured.created,
    secrets,
  });
  return {
    ok: false,
    stage: 'save',
    saved,
    channel: ensured.channel,
    created: ensured.created,
    rolledBack,
  };
}
