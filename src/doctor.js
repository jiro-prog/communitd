// 導入診断。**読むだけ・純粋。**
//
// 初めての利用者が「設定は通っているか・CLI は居るか・作業ディレクトリと Git は要件を満たすか・
// data/ に書けるか」を、モデルも Discord も動かさずに確かめるための判定。
// ファイル・Git・CLI の実体は注入で受け、ここは結果を並べるだけ。
// **秘密は出さない** — トークンは「設定されているか」だけを見て、値も長さも書かない。

import { basename } from 'node:path';
import { WORKTREE_DIR } from './worktree.js';
import { checkRoleProtocol } from './protocol.js';
// CLI の在り処は clicmd.js が正本。**ランタイム側 (claude.js / codex.js) からは取らない** —
// doctor は「読むだけ」の純粋モジュールなので、子プロセスを起こすモジュールに依存させない
import { CLAUDE_CLI, CODEX_CLI, cliCmdFailure, cliCmdHint, resolveConfiguredCommand } from './clicmd.js';
import {
  isExampleCwd, isExampleId, resolveAutonomy, resolveHooksEnabled, resolveVerifyCommand,
} from './config.js';
import { isUnsafeCwd } from './project.js';
import { resolveSociety } from './society-policy.js';
// 台帳の分類はランタイムと同じ関数を使う (判定を 2 か所に書かない)。
// **純粋関数だけを取る** — doctor 自身はファイルを読まず、読取りは注入された fs が行う
import { classifySocietySnapshot } from './society-store.js';

export const LEVELS = Object.freeze(['ok', 'warn', 'fail']);

/**
 * @param {object} p
 * @param {string} p.root ブリッジのルート (realpath 済み)
 * @param {object|null} p.config 合成済みの config (読めなければ null)
 * @param {string[]} [p.configErrors] loadConfigSources / validateConfig のエラー
 * @param {Record<string, string|undefined>} [p.env] 環境変数 (値は見るが出さない)
 * @param {object} p.fs `{ exists(path), realpath(path), readFile(path), canWrite(path), list?(dir) }` — 投げてよい
 *   (`list` は society 台帳の隣の `.tmp.*` を数えるためだけに使う。無ければ見ない)
 * @param {object} p.git `{ isRepo(cwd), isIgnored(cwd, path), branchExists(cwd, name) }` — 分からなければ null
 * @param {object} p.cli `{ version(bin, args?) }` — 取れなければ null
 *   (`args` は codexCmd のような多語コマンドの残りの語。`--version` の前に置く)
 * @param {string} [p.platform] CLI の解決に使う platform (`process.platform`)。
 *   Windows だけ `.cmd` シムの読み替えが要るので注入する — 判定を実機任せにすると
 *   テストが走る OS で結果が変わる
 * @param {string[]} [p.dataFiles] data/ の JSON (壊れていないかだけ見る)
 * @returns {{ok: boolean, findings: Array<{level: string, scope: string, message: string}>}}
 */
export function diagnose({
  root, config, configErrors = [], env = {}, fs, git, cli, dataFiles = [],
  platform = process.platform,
} = {}) {
  const findings = [];
  const add = (level, scope, message) => findings.push({ level, scope, message });
  const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

  // ---- 設定 ----
  if (configErrors.length > 0 || !config) {
    for (const line of configErrors) add('fail', 'config', line);
    if (configErrors.length === 0) add('fail', 'config', '設定を読めませんでした');
    return { ok: false, findings };
  }
  const bots = Object.entries(config.bots ?? {});
  const channels = Object.entries(config.channels ?? {});
  add('ok', 'config', `config.policy.json + config.secrets.json は検証を通った (bot ${bots.length} 体 / channel ${channels.length} 件)`);
  // **設定例のままの ID は「書いてある」ので検証は通る。** 通ったまま起動すると、
  // スラッシュコマンドは Missing Access で落ち、メンションは全部拒否されるのに
  // ログからは理由が読めない (実地の導入で両方起きた: 2026-09-12)
  if (isExampleId(config.guildId)) {
    add('fail', 'config', `guildId が設定例のまま (${config.guildId}) — 起動を許可する Discord サーバーの ID に置き換える (SETUP.md §1。開発者モードでサーバー名を右クリック → ID をコピー)`);
  }
  const exampleUsers = (Array.isArray(config.allowedUserIds) ? config.allowedUserIds : []).filter(isExampleId);
  if (exampleUsers.length > 0) {
    add('fail', 'config', `allowedUserIds が設定例のまま (${exampleUsers[0]}) — 自分の Discord ユーザー ID に置き換える。例の値のままだと全メンションが拒否されます`);
  }
  if (isExampleId(config.ownerUserId)) {
    add('fail', 'config', `ownerUserId が設定例のまま (${config.ownerUserId}) — 自分のユーザー ID に置き換えるか、人間への通知を使わないならキーごと消す`);
  } else if (!config.ownerUserId) {
    add('warn', 'config', 'ownerUserId が未設定 — bot からの [[notify:owner]] (裁定待ちの呼び出し) は実メンションになりません');
  }

  // ---- 共通規定 ----
  const common = `${root}/roles/_common.md`;
  const commonText = attempt(() => fs.readFile(common));
  if (commonText === null) add('fail', 'roles', 'roles/_common.md を読めません');
  else {
    const proto = checkRoleProtocol(commonText);
    add(proto.ok ? 'ok' : 'fail', 'roles', proto.ok ? 'roles/_common.md のプロトコル版は一致' : `roles/_common.md: ${proto.reason}`);
  }

  // ---- bot ----
  const runtimes = new Set();
  for (const [key, bot] of bots) {
    const tokenEnv = bot?.tokenEnv;
    if (typeof tokenEnv !== 'string' || tokenEnv === '') add('fail', `bots.${key}`, 'tokenEnv が未設定');
    else if (typeof env[tokenEnv] !== 'string' || env[tokenEnv].trim() === '') {
      add('fail', `bots.${key}`, `環境変数 ${tokenEnv} が未設定 — この bot は起動時にスキップされます (.env を確認)`);
    } else add('ok', `bots.${key}`, `環境変数 ${tokenEnv} は設定されている (値は表示しない)`);
    const roleFile = bot?.rolePromptFile;
    const roleText = typeof roleFile === 'string' ? attempt(() => fs.readFile(`${root}/${roleFile}`)) : null;
    if (roleText === null) add('fail', `bots.${key}`, `役割文 ${roleFile ?? '(未設定)'} を読めません`);
    else {
      const proto = checkRoleProtocol(roleText);
      add(proto.ok ? 'ok' : 'fail', `bots.${key}`, proto.ok ? `役割文 ${roleFile} のプロトコル版は一致` : `役割文 ${roleFile}: ${proto.reason}`);
    }
    // 相談役として立てた bot は Codex 組み込みの指示をこのファイルで置き換える。
    // 読めないと runCodex が spawn 前に落ちるので、起動して初めて気付くより先に出す
    const instructionsFile = bot?.codexInstructionsFile;
    if (typeof instructionsFile === 'string' && instructionsFile !== '') {
      const text = attempt(() => fs.readFile(`${root}/${instructionsFile}`));
      if (text === null) {
        add('fail', `bots.${key}`, `Codex 指示ファイル ${instructionsFile} を読めません`);
      } else {
        add('ok', `bots.${key}`, `Codex 指示ファイル ${instructionsFile} を読める (組み込み指示を置き換える)`);
      }
    }
    runtimes.add(bot?.runtime === 'codex' ? 'codex' : 'claude');
  }

  // ---- CLI ----
  //
  // **解決は実行系とまったく同じ関数を通す** (src/clicmd.js)。doctor だけ shell 経由で
  // PATH のシムを引いていたので、シムしか辿れない配置で「doctor は緑なのに全 job が
  // 起動できない」が起きていた (Opus2 指摘 2026-09-10)。
  // 版も**全語を渡して**引く — 先頭だけ見ると `node --version` を codex の版として報告する。
  const cliDeps = {
    platform,
    env,
    exists: (p) => attempt(() => fs.exists(p), false),
    // シムの中身から実体を引くのに要る (src/clicmd.js)。読めなければ解決側が握る
    readFile: (p) => fs.readFile(p),
  };
  const checkCli = (configured, spec, note = '', extra = '') => {
    const cmd = resolveConfiguredCommand(configured, spec, cliDeps);
    // note (なぜこの CLI を見に行ったのか) は**どちらの経路にも付ける** —
    // 「見つかりません」だけだと、なぜ codex を探したのかが分からない。
    // 辿れなかった理由の言い分け (PATH か、設定に書かれた絶対パスか) は実行系と共有する
    if (!cmd) {
      add('fail', 'cli', cliCmdFailure(configured, spec, note));
      return;
    }
    const label = cmd.join(' ');
    const version = attempt(() => cli.version(cmd[0], cmd.slice(1)));
    if (version) add('ok', 'cli', `${label} --version → ${String(version).trim().slice(0, 60)}`);
    else add('fail', 'cli', `${label} を起動できません${note} — ${cliCmdHint(spec)}${extra}`);
  };
  if (runtimes.has('claude') || runtimes.size === 0) {
    checkCli(config.claudeBin, CLAUDE_CLI, '', '。認証は `claude -p "test"` で別に確かめる');
  }
  if (runtimes.has('codex')) {
    checkCli(config.codexCmd, CODEX_CLI, ' (runtime: "codex" の bot が居ます)');
  }

  // ---- channel ----
  for (const [name, cc] of channels) {
    const scope = `channels.${name}`;
    const cwd = cc?.cwd;
    if (typeof cwd !== 'string' || cwd === '') { add('fail', scope, 'cwd が未設定'); continue; }
    // 「解決できません」より先に言う — 例のままなのか、書いたパスが無いのかで直し方が違う
    if (isExampleCwd(cwd)) {
      add('fail', scope, `cwd が設定例のまま (${cwd}) — このチャンネルで作業するディレクトリの絶対パスに置き換える (SETUP.md §0)`);
      continue;
    }
    const real = attempt(() => fs.realpath(cwd));
    if (!real) { add('fail', scope, `cwd ${cwd} を解決できません (存在しないか読めない)`); continue; }
    if (isUnsafeCwd(String(real).replaceAll('\\', '/'), root)) {
      // add-project は断る組み合わせ。既存の配備では「ブリッジ自身を開発するチャンネル」として
      // 意図的に置かれていることがあるので、診断は止めずに警告で残す (docs/reference/security-model.md)
      add('warn', scope, `cwd ${cwd} はブリッジ自身か、その祖先 — .env や config.secrets.json をモデルが読める。ブリッジ自身を開発するチャンネル以外では避ける`);
    } else {
      add('ok', scope, `cwd ${cwd} は実在する`);
    }
    const autonomy = resolveAutonomy({ ...cc, channelName: name });
    const isRepo = attempt(() => git.isRepo(real), null);
    if (isRepo === false) add(autonomy.enabled ? 'fail' : 'warn', scope, `${cwd} は Git リポジトリではない${autonomy.enabled ? ' — 自律運転 (worktree / merge) には Git が要る' : ' (git 差分の検収材料が出ない)'}`);
    else if (isRepo === null) add('warn', scope, 'Git の状態を確かめられなかった (git が PATH に無い?)');
    if (autonomy.enabled) {
      const ignored = attempt(() => git.isIgnored(real, `${WORKTREE_DIR}/`), null);
      if (ignored === false) add('fail', scope, `${WORKTREE_DIR}/ が .gitignore に無い — タスク job は作業ツリーを作らずに落ちる`);
      else if (ignored === true) add('ok', scope, `${WORKTREE_DIR}/ は Git の無視対象`);
      const base = attempt(() => git.branchExists(real, autonomy.baseBranch), null);
      if (base === false) add('fail', scope, `基点ブランチ ${autonomy.baseBranch} が無い (autonomy.baseBranch を実在するブランチに)`);
      else if (base === true) add('ok', scope, `基点ブランチ ${autonomy.baseBranch} は実在する`);
      const direction = attempt(() => fs.exists(`${real}/${autonomy.directionFile}`), null);
      if (direction === false) add('warn', scope, `方向性ドキュメント ${autonomy.directionFile} が無い — scout / worker は迷ったら人間に聞く`);
      else if (direction === true) add('ok', scope, `方向性ドキュメント ${autonomy.directionFile} がある`);
      if (!resolveVerifyCommand({ ...cc, channelName: name }) || !resolveHooksEnabled({ ...cc, channelName: name })) {
        add('fail', scope, 'autonomy には verify と hooks: true が要る (config の検証で落ちるはず — 設定の読み直しを疑う)');
      } else add('ok', scope, `verify: ${String(cc.verify).slice(0, 60)}`);
      const recovery = autonomy.recovery ?? {};
      add('ok', scope, `自動復旧は ${recovery.mode} (猶予 ${recovery.graceMin} 分 / 上限 ${recovery.maxAutoRetries} 回)`);
    } else if (resolveVerifyCommand({ ...cc, channelName: name }) && !resolveHooksEnabled({ ...cc, channelName: name })) {
      add('warn', scope, 'verify があるのに hooks: true でない — Stop hook の検証は走らずブリッジ側の最終検証だけになる');
    }
  }

  // ---- data/ ----
  const dataDir = `${root}/data`;
  const writable = attempt(() => fs.canWrite(dataDir), null);
  if (writable === false) add('fail', 'data', 'data/ に書けない — 実行記録を保存できない job は起動しないので、全 job が止まる');
  else if (writable === true) add('ok', 'data', 'data/ に書ける');
  else add('warn', 'data', 'data/ の書き込み可否を確かめられなかった (無ければ起動時に作られる)');
  // 自律起動の門になる台帳 (src/index.js の GATE 側と同じ顔ぶれ)
  const GATE_LEDGERS = new Set(['pause.json', 'tasks.json', 'recovery.json', 'job-runs.json', 'tick-states.json', 'proposals.json']);
  for (const file of dataFiles) {
    const rel = file.slice(root.length + 1);
    // 社会台帳だけは「不在」の意味が mode で変わるので下でまとめて見る
    if (basename(file) === 'society.json') continue;
    // 壊れたときの影響は台帳で違う (src/index.js の門と同じ分け方 — Opus2 レビュー 2026-09-07 Minor1)。
    // 門になる 6 台帳は自律起動ごと止まり、それ以外は書き込みだけ断られる
    const effect = GATE_LEDGERS.has(basename(file))
      ? '自律起動が止まる (fail-closed)'
      : '自律起動は止まらないが、その台帳への書き込みは断られる';
    // **「無い」と「読めない」を分ける** (Opus2 レビュー 2026-09-07 Major2)。
    // ENOENT だけが初回で、EACCES / EPERM / EISDIR はランタイムでは broken =
    // 自律起動が止まる状態なので、診断でも ✅ にしない
    let text;
    try {
      text = fs.readFile(file);
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // 無いのは普通 (最初の書き込みで生える)
      add('fail', 'data', `${rel} を読めない (${err?.code ?? err?.message ?? '理由不明'}) — ${effect}。権限とファイルの種別を直す`);
      continue;
    }
    if (text === null || text === undefined) continue;
    const parsed = attempt(() => JSON.parse(text), undefined);
    if (parsed === undefined || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 2026-09-07 から退避しない = このまま起動すると壊れたまま残る
      add('fail', 'data', `${rel} が JSON として読めない — ${effect}。直すか手で退避する`);
    }
  }

  // ---- 社会台帳 ----
  // **他の台帳と唯一違うのは「不在」の扱い。** 既存の台帳は不在 = 初回だが、society は
  // observe / active で不在なら起動停止 (初回と推測しない)。off なら触れないので何も言わない。
  const societyFile = dataFiles.find((f) => basename(f) === 'society.json') ?? null;
  if (societyFile) {
    const rel = societyFile.slice(root.length + 1);
    const mode = resolveSociety(config).mode;
    const bad = mode === 'off' ? 'warn' : 'fail';
    let text;
    try {
      text = fs.readFile(societyFile);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        if (mode === 'off') add('ok', 'data', `${rel} は無いが society.mode は off — 台帳は要らない`);
        else {
          add('fail', 'data', `${rel} が無い — society.mode が ${mode} なら台帳が要る。`
            + '**不在を初回と推測しない**ので、`node scripts/society-init.mjs` で明示的に作る');
        }
        text = null;
      } else {
        add(bad, 'data', `${rel} を読めない (${err?.code ?? err?.message ?? '理由不明'}) — `
          + `${mode === 'off' ? 'いまは off なので実害は無いが、observe にする前に直す' : '社会由来の処理は止まる'}`);
        text = null;
      }
    }
    if (typeof text === 'string') {
      // **判定はランタイムと同じ関数**を使う (src/society-store.js)。ここで JSON.parse だけ
      // 見ると、未知 schema・revision 不正・コレクション欠落を通してしまい、
      // 「診断は ✅ なのに起動したら社会が止まっている」になる (Opus2 S2-1 レビュー ①)
      const { broken } = attempt(() => classifySocietySnapshot(text), { broken: null });
      if (broken) {
        add(bad, 'data', `${rel} は台帳として読めない (${broken.kind}: ${broken.reason}) — 直すか手で退避する`);
      }
    }
    // 隣に残った `<file>.tmp.*` は部分更新の痕跡 (rename の前に落ちた形)。
    // ランタイムは片付くまで書き込みを断るので、診断でも同じ重さで出す
    const leftovers = attempt(() => (typeof fs.list === 'function'
      ? fs.list(dataDir).filter((n) => n.startsWith('society.json.tmp.'))
      : []), []);
    if (leftovers.length > 0) {
      add(bad, 'data', `${rel} の隣に部分更新の痕跡が残っている (${leftovers.join(' / ')}) — `
        + `${mode === 'off' ? 'いまは off なので止まらないが、' : '社会由来の処理は止まる。'}`
        + '中身を確かめて手で片付ける (消していない)');
    }
  }

  add('ok', 'discord', 'Discord への接続とモデルの起動は診断では行わない — `npm start` のログと SETUP.md §4 の動作確認で確かめる');
  return { ok: !findings.some((f) => f.level === 'fail'), findings };
}

/** 人が読む形 (✅ / ⚠️ / ❌ と最後に要約) */
export function formatDiagnosis({ ok, findings }) {
  const mark = { ok: '✅', warn: '⚠️', fail: '❌' };
  const lines = findings.map((f) => `${mark[f.level] ?? '•'} [${f.scope}] ${f.message}`);
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  lines.push('', ok
    ? `診断: 起動できる見込み (⚠️ ${warns} 件)。次は npm start → SETUP.md §4 の動作確認`
    : `診断: ❌ ${fails} 件 / ⚠️ ${warns} 件 — ❌ を直してから npm start`);
  return lines.join('\n');
}
