// Discord の実体 (src/index.js から切り出し): bot の client 群の起動、チャンネルとユーザーの解決、
// 起動しない運用メッセージの投稿。job を起こす経路はここに無い (それは src/bridge/messages.js)。
import { Client as DiscordClient, Events, GatewayIntentBits } from 'discord.js';
import { SLASH_COMMANDS } from '../commands.js';
import { channelConfigForName } from '../config.js';
import { sendSafe } from '../mentions.js';

/** その時刻の Discord snowflake (メッセージ ID の下限として使う。epoch は 2015-01-01) */
export function snowflakeAt(ms) {
  const DISCORD_EPOCH = 1420070400000n;
  const at = BigInt(Math.max(Math.floor(Number(ms) || 0), 1420070400000));
  return ((at - DISCORD_EPOCH) << 22n).toString();
}

/** bot ユーザーに紐づく管理ロール ID (無ければ null) */
export function botRoleFor(guild, userId) {
  return guild?.roles?.botRoleFor(userId)?.id ?? null;
}

/**
 * @param {object} deps
 * @param {object} deps.config                合成済み config (guildId・bots)
 * @param {Map<string, {key: string, cfg: object, client: object, userId: string|null}>} deps.bots
 *        bot registry。**空の Map を受け取り、loginBots が埋める** — 他の配線は起動前からこの Map を握る
 */
export function createDiscordWiring({ config, bots }) {
  /**
   * チャンネル名 → guild のテキストチャンネル。
   * **キャッシュだけを見る** (tick が空振りでも Discord API を叩かないため)。
   */
  function findGuildChannel(client, name) {
    return client.channels.cache.find(
      (ch) => ch?.guildId === config.guildId && ch?.name === name && !ch.isThread?.(),
    ) ?? null;
  }

  /**
   * スラッシュコマンドを guild スコープで登録する (即時反映)。
   * 全 bot に同じコマンドを登録する — 停止は緊急操作なので、1 体が落ちていても
   * 別の bot 経由で打てる方を採る (state は同一プロセス共有なので結果は同じ)。
   * 失敗しても常駐は続ける (メンション経路は生きている) が、原因は名前付きで出す。
   */
  async function registerSlashCommands(bot) {
    try {
      await bot.client.application.commands.set(SLASH_COMMANDS, config.guildId);
      console.log(
        `[${bot.key}] スラッシュコマンド登録: ${SLASH_COMMANDS.map((c) => `/${c.name}`).join(' ')}`,
      );
    } catch (err) {
      console.error(
        `[${bot.key}] スラッシュコマンドの登録に失敗: ${err.message}\n` +
          '  → メンション経路は生きています。原因はメッセージの通り ' +
          '(guildId の指定違い・権限・レート制限など) — 直したら再起動 (SETUP.md トラブルシューティング)',
      );
    }
  }

  function channelConfigFor(channel) {
    const base = channel.isThread() ? channel.parent : channel;
    if (!base) return null;
    return channelConfigForName(config, base.name);
  }

  /** 自分以外の起動済み bot の、メンション判定に使う ID 群 */
  function otherBotMentionIds(fromBot, guild) {
    return [...bots.values()]
      .filter((b) => b.key !== fromBot.key && b.userId)
      .map((b) => ({ userId: b.userId, roleId: botRoleFor(guild, b.userId) }));
  }

  /**
   * スレッドへ 1 通 (どの bot からでもよい — 起動しない運用メッセージ)。
   * @returns {Promise<boolean>} 送れたか
   */
  async function postToThread(threadId, text) {
    if (!threadId) return false;
    for (const bot of bots.values()) {
      if (!bot.userId) continue;
      const channel = bot.client.channels.cache.get(String(threadId))
        ?? await bot.client.channels.fetch(String(threadId)).catch(() => null);
      if (!channel || (channel.isThread?.() && channel.archived)) continue;
      await sendSafe(channel, String(text).slice(0, 1900));
      return true;
    }
    return false;
  }

  /** Discord のユーザー ID → bot キー (起動元の判定と handoff 先の解決に使う) */
  function botKeyOf(userId) {
    if (!userId) return null;
    return [...bots.values()].find((b) => b.userId === userId)?.key ?? null;
  }

  /**
   * bot 一覧の素の形 (実行文脈・宛先解決・/roster の検証で同じものを使う)。
   *
   * `rolePromptFile` と `runtime` も載せるのは、実行文脈で**誰が何の役か**を示すため —
   * 役割文から固有名詞を外すと、「Sol に実装を頼む」のような名指しの代わりに
   * 「reviewer 役を呼ぶ」と書くことになり、その対応表がここにしか無い。
   * 表示用の言い換えは src/rolecontext.js が行う (ここは config の素の値を渡すだけ)。
   */
  function botEntries() {
    return [...bots.values()].map((b) => ({
      key: b.key,
      displayName: b.cfg.displayName,
      userId: b.userId,
      rolePromptFile: b.cfg.rolePromptFile ?? null,
      runtime: b.cfg.runtime ?? 'claude',
    }));
  }

  /**
   * config.bots の全 bot を起動する (トークンの無い bot はスキップ)。
   * ハンドラは**関数で受ける** — 呼び出し側 (index.js) はこの時点で残りの配線を組み終えていない。
   * 起動の成否は非同期 (login の失敗は registry から外して名前付きで出す)。
   *
   * @param {object} p
   * @param {(bot: object, msg: object) => Promise<void>} p.onMessage
   * @param {(bot: object, interaction: object) => Promise<void>} p.onInteraction
   * @param {() => Promise<void>} p.announceRestartComplete 全 bot が ready になったら 1 回
   * @param {object} [p.env]                  トークンの読み出し元 (既定 process.env)
   * @param {Function} [p.Client]             discord.js の Client (テストから差し替える)
   * @param {(code: number) => void} [p.exit] 全 bot が失敗したときの終了 (テストから差し替える)
   */
  function loginBots({
    onMessage, onInteraction, announceRestartComplete, env = process.env, Client = DiscordClient,
    exit = (code) => process.exit(code),
  }) {
    let readyCount = 0;
    // login は非同期なので「全滅」はここでしか分からない。**ログイン試行の数**を数えておき、
    // その全部が失敗して 1 体も ready にならなかったときだけ落とす
    // (トークン未設定で 1 体も起動しなかった場合は src/index.js の bots.size === 0 が拾う)
    let attempted = 0;
    let failed = 0;
    for (const [key, cfg] of Object.entries(config.bots)) {
      const token = env[cfg.tokenEnv];
      if (!token) {
        console.error(`[${key}] env ${cfg.tokenEnv} が未設定 — このボットはスキップ`);
        continue;
      }
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        // client 既定も閉じておく (実際の送信は必ず src/mentions.js のラッパを通り、
        // そこで許可 ID を明示する。既定が parse: ['users'] だと、ラッパを通し忘れた
        // 経路や本文に残った生 <@id> がそのまま通知になる)
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      });
      const bot = { key, cfg, client, userId: null };
      client.once(Events.ClientReady, () => {
        bot.userId = client.user.id;
        console.log(`[${key}] logged in as ${client.user.tag} (${client.user.id})`);
        void registerSlashCommands(bot);
        readyCount++;
        // 起動が揃ってから再起動完了を知らせる (bot が揃う前に投稿しない)
        if (readyCount >= bots.size) void announceRestartComplete();
      });
      client.on(Events.MessageCreate, (msg) => {
        onMessage(bot, msg).catch((e) => console.error(`[${key} thread:${msg.channelId}]`, e));
      });
      client.on(Events.InteractionCreate, (interaction) => {
        onInteraction(bot, interaction).catch((e) =>
          console.error(`[${key} channel:${interaction.channelId}] interaction error`, e),
        );
      });
      // どの bot がなぜ繋がらないのかを名前付きで出す (原因の特定を推測に頼らせない)
      client.on(Events.Error, (err) => console.error(`[${key}] gateway error: ${err.message}`));
      attempted++;
      client.login(token).catch((err) => {
        const hint = /disallowed intents/i.test(err.message)
          ? 'Developer Portal → Bot → MESSAGE CONTENT INTENT を ON にして保存 (このボットのみ未設定)'
          : /token/i.test(err.message)
            ? `.env の ${cfg.tokenEnv} を確認 (トークン失効・貼り間違い)`
            : '';
        console.error(`[${key}] ログイン失敗: ${err.message}${hint ? `\n  → ${hint}` : ''}`);
        bots.delete(key);
        client.destroy().catch(() => {});
        // **全滅なら締めの 1 行を出して非 0 で落とす。** 個々の失敗理由は上に出ているが、
        // 「結局 1 体も起動していない」を言う行が無いと、窓を閉じた人にも監視にも失敗が伝わらない
        // (終了コード 42 は /restart の合図なので使わない — scripts/run.mjs が再起動してしまう)
        failed++;
        if (failed >= attempted && readyCount === 0) {
          console.error('起動できた bot がありません — 上のエラーを直して `npm start` をやり直してください');
          exit(1);
        }
      });
      bots.set(key, bot);
    }
  }

  return {
    findGuildChannel,
    registerSlashCommands,
    channelConfigFor,
    botRoleFor,
    otherBotMentionIds,
    postToThread,
    botKeyOf,
    botEntries,
    loginBots,
  };
}
