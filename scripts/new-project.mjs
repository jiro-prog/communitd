// 新しいプロジェクトを 1 コマンドで自律運転まで立ち上げる CLI (問い合わせなし)。
//   npm run new-project -- --name <名前> --direction <direction.md> --verify "<検証コマンド>"
//
// 1. 引数・既存設定・方向性ドキュメントを検査し、追記後の設定を起動時と同じ検証にかける
// 2. Discord のチャンネル一覧を読み、作るのか既存を使うのかを決める (--dry-run はここで止まる)
// 3. プロジェクトのフォルダを作り、README と .gitignore (.worktrees/ を無視) と docs/direction.md を初回 commit する
// 4. Discord のチャンネルを用意し、config.policy.json に autonomy 付きで追記する
// 5. 再起動の依頼 (data/restart-request.json) を置く — ブリッジは job が無いときに拾って落ち、
//    新しいチャンネルに「✅ 再起動完了」を出す。以降はスカウトが direction.md を読んで起票する
//
// 途中で失敗したら、この実行で作ったもの (フォルダ・チャンネル) を消して元に戻す。
// 既定値 (同時タスク数・tools など) は src/newproject.js の NEW_PROJECT_DEFAULTS。
// bot は既存の自律運転チャンネルに揃える (--scout / --worker / --reviewer で上書き、src/newproject.js の resolveProjectBots)。
import * as nodeFs from 'node:fs';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_FILE, mergeConfigSources, validateConfig } from '../src/config.js';
import { createChannelAndSave, matchTextChannels, redact } from '../src/discord-setup.js';
import {
  INIT_COMMIT_MESSAGE,
  NEW_PROJECT_DEFAULTS,
  NEW_PROJECT_USAGE,
  buildAutonomousEntry,
  buildGitignore,
  buildReadme,
  checkDirectionText,
  parseNewProjectArgs,
  resolveProjectBots,
} from '../src/newproject.js';
import {
  addChannel, checkCwdSafety, isUnsafeCwd, normalizeCwd, saveConfigAtomically, validateChannelName,
} from '../src/project.js';
import { RESTART_REQUEST_FILE, buildRestartRequest } from '../src/restart.js';
import { createSetupIo } from '../src/setup-cli.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function abort(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

// 比較の基準になるブリッジのルート。ここが解決できないなら安全判定ができない
let REAL_ROOT;
try {
  REAL_ROOT = realpathSync(ROOT).replaceAll('\\', '/');
} catch (err) {
  abort(`ブリッジのルートを解決できません (${ROOT}): ${err.message}`);
}

// ---- 1. 検査 ----
const { options, errors: argErrors } = parseNewProjectArgs(process.argv.slice(2));
if (argErrors.length > 0) {
  abort(`${argErrors.map((e) => `⚠️ ${e}`).join('\n')}\n\n${NEW_PROJECT_USAGE}`);
}
const { name, verify, tools, baseBranch, dryRun } = options;

const io = createSetupIo({ root: ROOT, abort, launchHint: 'npm run new-project' });
const { config, policy, policyRaw, secrets, secretsRaw } = io.loadConfig();
io.checkExisting(config);

const nameErrors = validateChannelName(name, config);
if (nameErrors.length > 0) abort(nameErrors.map((e) => `⚠️ --name: ${e}`).join('\n'));

let directionText;
try {
  directionText = readFileSync(resolve(options.direction), 'utf8');
} catch (err) {
  abort(`方向性ドキュメントを読めません (${options.direction}): ${err.message}`);
}
const directionErrors = checkDirectionText(directionText);
if (directionErrors.length > 0) abort(directionErrors.map((e) => `⚠️ ${e}`).join('\n'));

const parent = normalizeCwd(options.parent ?? dirname(REAL_ROOT));
if (!existsSync(parent)) abort(`親フォルダがありません: ${parent}`);
const cwd = `${parent}/${name}`;
if (existsSync(cwd)) abort(`${cwd} は既にあります (別の名前にするか、既存のフォルダには npm run add-project を使ってください)`);
// 作る前の文字列判定。作った後に実体パスでもう一度見る
if (isUnsafeCwd(cwd, REAL_ROOT)) abort(`ブリッジ本体 (${REAL_ROOT}) 自身とその親は作業ディレクトリにできません`);

const { bots, from: botsFrom, errors: botErrors } = resolveProjectBots(config, options);
if (botErrors.length > 0) abort(botErrors.map((e) => `⚠️ ${e}`).join('\n'));

const entry = buildAutonomousEntry({ cwd, tools, verify, baseBranch, bots });
const nextPolicy = addChannel(policy, name, entry);
const { config: next, errors: mergeErrors } = mergeConfigSources(nextPolicy, secrets);
if (mergeErrors.length > 0) abort(`⚠️ 追記後の設定を合成できません:\n${mergeErrors.map((e) => `  - ${e}`).join('\n')}`);
const validationErrors = validateConfig(next);
if (validationErrors.length > 0) {
  abort(`⚠️ この内容では起動時検証に通りません:\n${validationErrors.map((e) => `  - ${e}`).join('\n')}`);
}

// ---- 2. Discord の確認 (読むだけ) ----
const { creator, tokens, discord } = io.connectDiscord(config);
let existing;
try {
  existing = matchTextChannels(await discord.listChannels(config.guildId), name);
} catch (err) {
  abort(`Discord のチャンネル一覧を取得できません: ${redact(err, tokens)}`);
}
if (existing.length > 1) {
  abort(`#${name} と同じ名前のテキストチャンネルが ${existing.length} 個あります。Discord 側で重複を解消してください`);
}

console.log(`プロジェクト ${name} を立ち上げます${dryRun ? ' (--dry-run: 何も作りません)' : ''}`);
console.log(`  フォルダ   : ${cwd} (git init -b ${baseBranch}、README.md と .gitignore と ${NEW_PROJECT_DEFAULTS.directionFile} を初回 commit)`);
console.log(`  チャンネル : #${name} ${existing.length === 1 ? '(既存を使う)' : `(新しく作る — ${creator.cfg.displayName ?? creator.key} として)`}`);
console.log(`  担当 bot   : scout ${bots.scout} / worker ${bots.workers.join(', ')} / reviewer ${bots.reviewer}${botsFrom ? ` (#${botsFrom} に揃えた)` : ''}`);
console.log(`  ${POLICY_FILE} に追記する内容:`);
console.log(`"${name}": ${JSON.stringify(entry, null, 2)}`);
console.log('  ✅ 起動時検証を通りました');

if (dryRun) {
  console.log('\n--dry-run なのでここで止めます (フォルダ・チャンネル・設定・再起動の依頼は作っていません)');
  process.exit(0);
}

// ---- 3. フォルダと初回 commit ----
function git(args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args[0]} を起動できません: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} が失敗しました: ${(r.stderr || r.stdout || '').trim()}`);
}

/** この実行で作ったフォルダを消す (作る前に存在しないことを確かめているので、人の物は消さない) */
function removeProjectDir() {
  try {
    rmSync(cwd, { recursive: true, force: true });
    return `作成した ${cwd} は削除しました`;
  } catch (err) {
    return `作成した ${cwd} を消せませんでした (手で消してください): ${err.message}`;
  }
}

try {
  mkdirSync(cwd); // recursive にしない — 親が無い・既にある、はここで落ちる
} catch (err) {
  abort(`フォルダを作れません (${cwd}): ${err.message}`);
}
try {
  const safety = checkCwdSafety(cwd, REAL_ROOT, { realpath: realpathSync });
  if (!safety.ok) throw new Error(`作業ディレクトリとして安全か確かめられません (${safety.reason})`);
  if (safety.real !== cwd) throw new Error(`実体パスが違います (${cwd} → ${safety.real})。--parent に実体パスを渡してください`);
  mkdirSync(resolve(cwd, dirname(NEW_PROJECT_DEFAULTS.directionFile)), { recursive: true });
  writeFileSync(resolve(cwd, 'README.md'), buildReadme({ name }));
  // .worktrees/ を無視しないとタスク job が作業ツリーを作れない (src/newproject.js の buildGitignore)
  writeFileSync(resolve(cwd, '.gitignore'), buildGitignore());
  writeFileSync(resolve(cwd, NEW_PROJECT_DEFAULTS.directionFile), directionText);
  git(['init', '-b', baseBranch]);
  // 明示パスで add する (worker の git add は明示パスで — 関係のない変更を混ぜない)
  git(['add', '--', 'README.md', '.gitignore', NEW_PROJECT_DEFAULTS.directionFile]);
  git(['commit', '-m', INIT_COMMIT_MESSAGE]);
} catch (err) {
  abort(`${err.message}\n  → ${removeProjectDir()}。${POLICY_FILE} とチャンネルは触っていません`);
}
console.log(`\n✅ ${cwd} を作って初回 commit しました`);

// ---- 4. チャンネルと設定 ----
const result = await createChannelAndSave({
  discord,
  guildId: config.guildId,
  name,
  secrets: tokens,
  // 保存するのは policy だけ。secrets が途中で変わっていたら中止する (add-project と同じ)
  save: () =>
    saveConfigAtomically({
      configPath: io.policyPath,
      originalRaw: policyRaw,
      nextConfig: nextPolicy,
      fs: nodeFs,
      uniqueSuffix: String(process.pid),
      companions: [{ path: io.secretsPath, originalRaw: secretsRaw }],
    }),
});
if (!result.ok) {
  const detail = result.stage === 'channel'
    ? result.message
    : `${result.saved?.message}\n  → ${result.rolledBack?.ok ? (result.created ? `作成した #${result.channel?.name} は削除しました` : '既存のチャンネルはそのままです') : result.rolledBack?.message}`;
  abort(`${detail}\n  → ${removeProjectDir()}。${POLICY_FILE} は元のままです`);
}
console.log(
  result.created
    ? `✅ Discord に #${result.channel.name} を作成しました`
    : `ℹ️ Discord の既存 #${result.channel.name} を使います`,
);
console.log(`✅ channels.${name} を追加しました (バックアップ: ${result.saved.backupPath})`);

// ---- 5. 再起動の依頼 ----
const requestPath = resolve(ROOT, RESTART_REQUEST_FILE);
const request = buildRestartRequest({
  reason: `channels.${name} を追加 (npm run new-project)`,
  by: 'new-project',
  notice: { channelId: result.channel.id, botKey: creator.key },
});
try {
  mkdirSync(dirname(requestPath), { recursive: true });
  // ブリッジが書きかけを読まないよう、一時ファイルに書いてから置き換える
  const tmp = `${requestPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(request));
  renameSync(tmp, requestPath);
  console.log('✅ 再起動の依頼を置きました');
  console.log('\n次に起きること:');
  console.log('  - ブリッジが動いていれば、job が無くなった時点で自動で再起動します (30 秒ごとに確認)');
  console.log(`  - 再起動すると #${name} に「✅ 再起動完了」が出て、スカウトが direction.md を読んで起票を始めます`);
  console.log('  - ブリッジが止まっているなら npm start で起動してください (起動時に新しい設定を読みます)');
} catch (err) {
  console.error(`⚠️ 再起動の依頼を置けませんでした: ${err.message}`);
  console.error('  → Discord で /restart してください (設定は書き込み済みです)');
}
