// プロジェクトを足す CLI (scripts/add-project.mjs・scripts/new-project.mjs) の共通の読み書き。
// 中止はすべて呼び出し側の abort に任せる (対話 CLI は readline を閉じてから落ちる必要がある)。
//
// **読むのは policy + secrets、書くのは policy だけ** — 検証と Discord 接続には
// 起動時と同じ合成後の config が要るが、秘密と合成結果は保存しない
// (docs/social-engineering.md §3.9)。
import { REST, Routes } from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POLICY_FILE, SECRETS_FILE, mergeConfigSources, validateConfig } from './config.js';
import { pickChannelCreator } from './discord-setup.js';

/**
 * @param {object} p
 * @param {string} p.root ブリッジのルート
 * @param {(message: string) => never} p.abort 中止 (戻らない)
 * @param {Record<string, string|undefined>} [p.env] トークンを引く環境 (既定 process.env)
 * @param {string} [p.launchHint] トークンが無いときに案内する起動方法
 */
export function createSetupIo({ root, abort, env = process.env, launchHint = 'npm run add-project' }) {
  const policyPath = resolve(root, POLICY_FILE);
  const secretsPath = resolve(root, SECRETS_FILE);

  /** 設定ファイルを 1 つ読む。生の中身も返す — 書き込み直前に「途中で誰かが触っていないか」を見るため */
  function readJson(path, file) {
    if (!existsSync(path)) {
      abort(`${file} がありません: ${path}\n  → まず SETUP.md §0 の手順で作ってください`);
    }
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      abort(`${file} を読めません: ${err.message}`);
    }
    try {
      return { value: JSON.parse(raw), raw };
    } catch (err) {
      abort(`${file} を JSON として読めません: ${err.message}`);
    }
  }

  /** policy と secrets を読み、起動時と同じ検証にかけるための合成後 config も返す */
  function loadConfig() {
    const policy = readJson(policyPath, POLICY_FILE);
    const secrets = readJson(secretsPath, SECRETS_FILE);
    const { config, errors } = mergeConfigSources(policy.value, secrets.value);
    if (errors.length > 0) {
      abort(
        '⚠️ 設定ファイルを合成できません (先に直してください):\n' +
          errors.map((line) => `  - ${line}`).join('\n') +
          '\n中止しました (追記していません)',
      );
    }
    return {
      config,
      policy: policy.value,
      policyRaw: policy.raw,
      secrets: secrets.value,
      // secrets は書き換えないが、途中で変わったら保存を中止するために生の中身を持つ
      secretsRaw: secrets.raw,
    };
  }

  /** 既存の設定が壊れている状態で追記すると原因が混ざるので先に見る */
  function checkExisting(config) {
    const errors = validateConfig(config);
    if (errors.length === 0) return;
    abort(
      `⚠️ 既存の設定 (${POLICY_FILE} + ${SECRETS_FILE}) に問題があります (先に直してください):\n` +
        errors.map((line) => `  - ${line}`).join('\n') +
        '\n中止しました (追記していません)',
    );
  }

  /** Discord へのアクセス手段を組み立てる (トークンはここから外へ出さない) */
  function connectDiscord(config) {
    const creator = pickChannelCreator(config);
    if (!creator) abort(`${POLICY_FILE} に bots がありません (チャンネルを作る bot を決められません)`);
    const token = env[creator.cfg?.tokenEnv];
    if (!token) {
      abort(
        `${creator.cfg?.tokenEnv ?? 'トークン'} が環境にありません\n` +
          `  → ${launchHint} から起動してください (.env を読み込みます)`,
      );
    }
    const rest = new REST({ version: '10' }).setToken(token);
    return {
      creator,
      // 全 bot のトークンを伏字対象にする (どれが混ざっても外へ出さない)。
      // config.secrets.json とは別物なので名前を分ける — こちらは .env のトークン文字列
      tokens: Object.values(config.bots ?? {})
        .map((b) => env[b?.tokenEnv])
        .filter(Boolean),
      discord: {
        listChannels: (guildId) => rest.get(Routes.guildChannels(guildId)),
        createChannel: (guildId, body) => rest.post(Routes.guildChannels(guildId), { body }),
        deleteChannel: (channelId) => rest.delete(Routes.channel(channelId)),
      },
    };
  }

  return { policyPath, secretsPath, loadConfig, checkExisting, connectDiscord };
}
