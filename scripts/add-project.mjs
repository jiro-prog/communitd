// プロジェクト (チャンネル) を config.policy.json に足す対話 CLI。
//   npm run add-project
// 「作業ディレクトリの確認 → 起動時検証と同じ検証 → Discord チャンネルの用意 →
// config.policy.json への追記」まで行う。チャンネルを用意できなければ config は書かず、
// config を書けなければこの実行で作ったチャンネルを消す (src/discord-setup.js)。
// 反映のための再起動だけは手動。
//
// **読むのは policy + secrets、書くのは policy だけ** — 検証と Discord 接続には
// 起動時と同じ合成後の config が要るが、秘密と合成結果は保存しない
// (docs/social-engineering.md §3.9)。
import * as nodeFs from 'node:fs';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_FILE, SECRETS_FILE, mergeConfigSources, validateConfig } from '../src/config.js';
import { createChannelAndSave, matchTextChannels, redact } from '../src/discord-setup.js';
import {
  TOOLS_CHOICES,
  addChannel,
  buildChannelEntry,
  checkCwdSafety,
  normalizeCwd,
  saveConfigAtomically,
  validateChannelName,
} from '../src/project.js';
import { createSetupIo } from '../src/setup-cli.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 比較の基準になるブリッジのルート。ここが解決できないなら安全判定ができない
let REAL_ROOT;
try {
  REAL_ROOT = realpathSync(ROOT).replaceAll('\\', '/');
} catch (err) {
  console.error(`ブリッジのルートを解決できません (${ROOT}): ${err.message}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 行の取り出しは async iterator で行う。rl.question は入力が閉じても
// resolve/reject せず待ち続けてしまい、Ctrl+D やパイプ入力で固まる
const lines = rl[Symbol.asyncIterator]();

/** Ctrl+C / Ctrl+D / 入力終端は「中止」として扱う (書きかけを残さない) */
async function ask(question, fallback = '') {
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) abort('中止しました (入力が閉じられました)');
  const answer = String(value).trim();
  return answer === '' ? fallback : answer;
}

function abort(message) {
  console.error(`\n${message}`);
  rl.close();
  process.exit(1);
}

async function askChannelName(config) {
  for (;;) {
    const name = await ask('Discord のチャンネル名 (例: my-project): ');
    const errors = validateChannelName(name, config);
    if (errors.length === 0) return name.trim();
    for (const line of errors) console.log(`  ⚠️ ${line}`);
  }
}

async function askCwd() {
  for (;;) {
    const cwd = normalizeCwd(await ask('作業ディレクトリのパス (例: C:/Users/you/projects/foo): '));
    if (!cwd) {
      console.log('  ⚠️ パスを入力してください');
      continue;
    }
    if (!existsSync(cwd)) {
      console.log(`  ⚠️ 見つかりません: ${cwd}`);
      continue;
    }
    if (!statSync(cwd).isDirectory()) {
      console.log(`  ⚠️ ディレクトリではありません: ${cwd}`);
      continue;
    }
    // ブリッジ本体やその親を作業ディレクトリにすると、最小権限の readonly でも
    // Read で .env の Discord トークンに手が届いてしまう
    const safety = checkCwdSafety(cwd, REAL_ROOT, { realpath: realpathSync });
    if (!safety.ok) {
      if (safety.reason === 'unresolvable') {
        console.log(`  ⚠️ 実体パスを解決できません: ${cwd}`);
        console.log('     安全確認ができないので指定できません (リンク先が壊れていないか確認してください)');
      } else {
        console.log(`  ⚠️ ブリッジ本体 (${REAL_ROOT}) 自身とその親は指定できません`);
        console.log('     .env の Discord トークンが読める配置になります。別のディレクトリにしてください');
      }
      continue;
    }
    // config には安全確認を通した実体パスを書く。入力のまま (junction 等) を
    // 書くと、リンク先を張り替えるだけで確認済みでない場所を指せてしまう
    if (safety.real !== cwd) console.log(`  ℹ️ 実体パスに解決しました: ${cwd} → ${safety.real}`);
    console.log(
      `  ✅ ${safety.real}${existsSync(resolve(safety.real, '.git')) ? ' (git リポジトリのルート)' : ' (.git なし — 上位が git ツリーの場合もあります)'}`,
    );
    return safety.real;
  }
}

async function askTools() {
  console.log(`ツール許可プリセット: ${TOOLS_CHOICES.join(' / ')}`);
  console.log('  readonly = 読取と検索のみ / standard = 編集 + git・node・npm / full = シェル全許可');
  for (;;) {
    const tools = await ask('どれにしますか [readonly]: ', 'readonly');
    if (TOOLS_CHOICES.includes(tools)) return tools;
    console.log(`  ⚠️ ${TOOLS_CHOICES.join(' / ')} のどれかを入力してください`);
  }
}

async function confirm(question) {
  const answer = await ask(`${question} [y/N]: `, 'n');
  return /^(y|yes)$/i.test(answer);
}

// 設定の読み込み・既存設定の検査・Discord 接続は new-project と共有 (src/setup-cli.js)
const io = createSetupIo({ root: ROOT, abort });
const POLICY_PATH = io.policyPath;
const SECRETS_PATH = io.secretsPath;

const { config, policy, policyRaw, secrets, secretsRaw } = io.loadConfig();
io.checkExisting(config);

console.log(`${POLICY_FILE} にプロジェクト (チャンネル) を追加します。Ctrl+C でいつでも中止できます。\n`);

const name = await askChannelName(config);
const cwd = await askCwd();
const tools = await askTools();

const entry = buildChannelEntry({ cwd, tools });
// 追記するのは policy。検証は起動時とまったく同じ「合成後の config」でかける
const nextPolicy = addChannel(policy, name, entry);
const { config: next, errors: mergeErrors } = mergeConfigSources(nextPolicy, secrets);
if (mergeErrors.length > 0) {
  console.error('⚠️ 追記後の設定を合成できません:');
  for (const line of mergeErrors) console.error(`  - ${line}`);
  abort('中止しました (書き込んでいません)');
}

console.log(`\n--- ${POLICY_FILE} の channels に追記する内容 ---`);
console.log(`"${name}": ${JSON.stringify(entry, null, 2)}`);
console.log('---------------------------------------------\n');

// 追記後の状態を、起動時とまったく同じ検証にかけてから書く
const errors = validateConfig(next);
if (errors.length > 0) {
  console.error('⚠️ この内容では起動時検証に通りません:');
  for (const line of errors) console.error(`  - ${line}`);
  abort('中止しました (書き込んでいません)');
}
console.log('✅ 起動時検証を通りました');

// Discord 側の状態を先に見て、「作る」のか「既存を使う」のかを確認に載せる
const { creator, tokens, discord } = io.connectDiscord(config);
console.log(`\nDiscord を確認しています (${creator.cfg.displayName ?? creator.key} として)…`);
let existing;
try {
  existing = matchTextChannels(await discord.listChannels(config.guildId), name);
} catch (err) {
  abort(
    `チャンネル一覧を取得できません: ${redact(err, tokens)}\n` +
      `  → ${POLICY_FILE} は元のままです (書き込んでいません)`,
  );
}
if (existing.length > 1) {
  abort(
    `#${name} と同じ名前のテキストチャンネルが ${existing.length} 個あります ` +
      `(ID: ${existing.map((c) => c.id).join(', ')})\n` +
      '  → ブリッジはチャンネル名で config を引くので、どれも同じプロジェクト設定で動きます。' +
      'Discord 側で重複を解消してからやり直してください\n' +
      `  → ${POLICY_FILE} は元のままです (書き込んでいません)`,
  );
}
console.log(
  existing.length === 1
    ? `  ℹ️ #${existing[0].name} は既にあります。作らずにそのまま使います`
    : `  ℹ️ #${name} を新しく作ります`,
);
console.log(
  `注意: 書き込みでは ${POLICY_FILE} 全体が 2 スペース整形で書き直されます ` +
    `(値は変わりませんが、既存の改行・字下げは揃えられます。${SECRETS_FILE} は触りません)`,
);

const action = existing.length === 1 ? '' : `#${name} を作成し、`;
if (!(await confirm(`${action}${POLICY_FILE} を書き換えますか?`))) {
  abort('中止しました (書き込んでいません)');
}

const result = await createChannelAndSave({
  discord,
  guildId: config.guildId,
  name,
  secrets: tokens,
  // 保存するのは policy だけ。合成後の config (next) は検証にしか使わない —
  // 書き戻すと秘密が git 管理側へ混ざる。
  // secrets は書き換えないが、変わっていたら中止する — 起動時検証もチャンネル確認も
  // 合成後の config で行っているので、対話中に guildId が変わっていれば
  // 「別の Guild で確かめた結果」を根拠に policy を書くことになる
  save: () =>
    saveConfigAtomically({
      configPath: POLICY_PATH,
      originalRaw: policyRaw,
      nextConfig: nextPolicy,
      fs: nodeFs,
      uniqueSuffix: String(process.pid),
      companions: [{ path: SECRETS_PATH, originalRaw: secretsRaw }],
    }),
});

if (!result.ok && result.stage === 'channel') {
  abort(`${result.message}\n  → ${POLICY_FILE} は元のままです (書き込んでいません)`);
}
if (!result.ok) {
  const rollback = result.rolledBack?.ok
    ? result.created
      ? `作成した #${result.channel.name} は削除しました`
      : '既存のチャンネルはそのままです'
    : result.rolledBack?.message;
  abort(`${result.saved.message}\n  → ${POLICY_FILE} は元のままです。${rollback}`);
}

console.log(`\n✅ channels.${name} を追加しました (バックアップ: ${result.saved.backupPath})`);
console.log(
  result.created
    ? `✅ Discord に #${result.channel.name} を作成しました`
    : `ℹ️ Discord の既存 #${result.channel.name} を使います`,
);
console.log('残りの手順:');
console.log(`  ブリッジを再起動してください (/restart) — ${POLICY_FILE} は起動時にだけ読まれます`);
rl.close();
