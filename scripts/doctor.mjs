// 導入診断 CLI。**読むだけ** — config も Discord も data/ も変えない。
//
//   node --env-file=.env scripts/doctor.mjs
//
// 見るもの: 設定の検証 / 各 bot のトークン環境変数の有無 (値は出さない) と役割文のプロトコル版 /
// claude・codex CLI の起動 / 各チャンネルの cwd・Git・.worktrees・基点ブランチ・方向性ドキュメント /
// data/ の書き込み可否と JSON の健全性。Discord への接続とモデルの起動は別ステップ (npm start)。
// 終了コード: ❌ があれば 1。

import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POLICY_FILE, SECRETS_FILE, loadConfigSources, validateConfig } from '../src/config.js';
import { readContractKind } from '../src/contract.js';
import { diagnose, formatDiagnosis } from '../src/doctor.js';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..')).replaceAll('\\', '/');

function main() {
  const { config, errors: loadErrors } = loadConfigSources({
    policyPath: resolve(ROOT, POLICY_FILE),
    secretsPath: resolve(ROOT, SECRETS_FILE),
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  const contractKindOf = (botKey) => {
    const file = config?.bots?.[botKey]?.rolePromptFile;
    if (typeof file !== 'string' || file === '') return null;
    try { return readContractKind(readFileSync(resolve(ROOT, file), 'utf8')); } catch { return null; }
  };
  const configErrors = loadErrors.length > 0 ? loadErrors : validateConfig(config, { contractKindOf, repoRoot: ROOT });

  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  const result = diagnose({
    root: ROOT,
    config: configErrors.length > 0 ? null : config,
    configErrors,
    env: process.env,
    fs: {
      exists: (p) => existsSync(p),
      realpath: (p) => realpathSync(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      canWrite: (p) => {
        if (!existsSync(p)) return null; // 無ければ起動時に作られる
        accessSync(p, constants.W_OK);
        return true;
      },
      // 社会台帳の隣に残った `.tmp.*` (部分更新の痕跡) を数えるためだけに使う
      list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    },
    git: {
      isRepo: (cwd) => {
        try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch (err) {
          if (err?.status === 128) return false;
          return null;
        }
      },
      isIgnored: (cwd, path) => {
        try { git(cwd, ['check-ignore', '-q', path]); return true; } catch (err) {
          if (err?.status === 1) return false;
          return null;
        }
      },
      branchExists: (cwd, name) => {
        try { git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; } catch (err) {
          if (err?.status === 1) return false;
          return null;
        }
      },
    },
    platform: process.platform,
    cli: {
      // **shell は通さない。** doctor へ渡る前に diagnose が実行系と同じ解決を済ませており
      // (src/clicmd.js)、Windows でも `.exe` の絶対パスか `node <実体>` になっている。
      // shell を通すと引用が効かず、空白を含むパス (`C:\Program Files\…`) で壊れるうえ、
      // 実行系が spawn できないシムを doctor だけが起動できてしまう
      version: (bin, args = []) => execFileSync(bin, [...args, '--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    },
    dataFiles: ['tasks.json', 'job-runs.json', 'recovery.json', 'contracts.json', 'sessions.json', 'proposals.json', 'inbox.json', 'pause.json', 'tick-states.json', 'roster.json', 'society.json']
      .map((f) => `${ROOT}/data/${f}`),
  });
  console.log(formatDiagnosis(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`診断できません: ${err.message}`);
    process.exitCode = 1;
  }
}
