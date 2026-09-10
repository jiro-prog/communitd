import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_CLI, cliCmdHint, cliCmdReason, resolveCliCommand, resolveConfiguredCommand } from './clicmd.js';
import { killTree, scrubEnv } from './proc.js';

// codex CLI の在り処 (`CODEX_CLI`) は src/clicmd.js が正本。**配備ごとの絶対パスは
// 持たない** — 既定は PATH 解決で、明示したいときは config.policy.json の `codexCmd` に書く
export { CODEX_CLI };

/** codex が見つからないときの案内 (doctor と同じ文言を使う) */
export const CODEX_CMD_HINT = cliCmdHint(CODEX_CLI);

/**
 * spawn できる形の codex コマンドへ解決する (実体は src/clicmd.js)。
 * @param {{platform?: string, env?: object, exists?: (p: string) => boolean, nodeBin?: string}} deps
 * @returns {string[]|null}
 */
export function resolveCodexCommand(deps = {}) {
  return resolveCliCommand({ ...CODEX_CLI, ...deps });
}

/**
 * ブリッジから渡してよい codex sandbox。
 * danger-full-access は意図的に載せない — 設定ミスが全開放にならないようにする。
 */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write'];
export const DEFAULT_CODEX_SANDBOX = 'read-only';

// 値域の正本は codex CLI (二重管理)。**未知の値は行ごと省く**ので、ここが古いと
// ユーザーが書いた effort が黙って落ち、codex 既定の `none` で走る — 実際 2026-09-10 に
// `model_reasoning_effort = "max"` が読み落とされ、Sol が推論なしでレビューしていた。
// `max` と `minimal` は codex 0.144.5 が受け付けることを実機で確認済み
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * ユーザー config.toml のトップレベルから model_reasoning_effort を読む。
 * 最初のセクション見出しで打ち切る (プロファイル配下の同名キーを拾わない)。
 * @returns {string|null} 既知の値でなければ null
 */
export function readUserReasoningEffort(toml) {
  for (const raw of String(toml ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = /^model_reasoning_effort\s*=\s*["']([A-Za-z]+)["']/.exec(line);
    if (m) {
      const value = m[1].toLowerCase();
      return REASONING_EFFORTS.includes(value) ? value : null;
    }
  }
  return null;
}

/**
 * TOML の basic string としてパスを書く。
 *
 * Windows の `\` は `/` へ正規化する — TOML では `\` がエスケープ開始文字なので、
 * `C:\Users\...` をそのまま書くと不正なエスケープとして解釈が壊れる。
 */
function tomlPath(value) {
  return `"${String(value)
    .replaceAll('\\', '/')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')}"`;
}

/**
 * 隔離 CODEX_HOME に置く config.toml を組み立てる。
 *
 * 「ユーザー設定を削って使う」ではなく「必要なキーだけ書き起こす」方式。
 * [mcp_servers.*] が入らないので UnityMCP / node_repl は最初から存在しない。
 * plugins / marketplaces も持ち込まない (隔離環境で読み込ませるとモデル一覧の
 * 取得が固まる — 実測 2026-07-31)。
 *
 * [windows] sandbox = "unelevated" は Windows で必須。これが無いと
 * sandbox_mode に関わらず read-only へ落ち、"elevated" にすると書込み時に
 * 昇格待ちで無応答になる (どちらも実測)。
 *
 * instructionsFile を渡すと model_instructions_file を書く。Codex 組み込みの
 * 「コーディングエージェント」指示がそのファイルの内容で**置き換わる** (追加ではない)
 * ので、同じ codex ランタイムのまま相談役の bot を立てられる。省略時は組み込み指示の
 * ままなので、既存の bot の振る舞いは変わらない。
 */
export function renderCodexConfig({ sandbox, effort, instructionsFile = null }) {
  const lines = [];
  if (effort) lines.push(`model_reasoning_effort = "${effort}"`);
  if (instructionsFile) lines.push(`model_instructions_file = ${tomlPath(instructionsFile)}`);
  lines.push('approval_policy = "never"', `sandbox_mode = "${sandbox}"`);
  lines.push('', '[windows]', 'sandbox = "unelevated"', '');
  return lines.join('\n');
}

/** 実際の CODEX_HOME (env 優先) */
function realCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * 隔離 CODEX_HOME を作る。認証だけ実 home から引き継ぐ。
 * 作れなければ null を返し、呼び出し側は --ignore-user-config へ退避する
 * (= sandbox は read-only に固定される。fail-closed)。
 *
 * instructionsText を渡すと、その**内容を隔離 home へ書き出して**指す。元のパスを
 * config.toml へ書かないのは、読んでから codex が開くまでの間に指示が書き換わる窓を
 * 塞ぐため (role prompt を一時ファイルへ写す src/bridge/job.js と同じ理由)。
 */
export function createIsolatedHome(sandbox, instructionsText = null) {
  const source = realCodexHome();
  const auth = join(source, 'auth.json');
  if (!existsSync(auth)) return null;

  let effort = null;
  try {
    effort = readUserReasoningEffort(readFileSync(join(source, 'config.toml'), 'utf8'));
  } catch { /* config が無くても既定の推論設定で動く */ }

  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'communitd-codexhome-'));
    let instructionsFile = null;
    if (instructionsText !== null) {
      instructionsFile = join(dir, 'instructions.md');
      writeFileSync(instructionsFile, instructionsText);
    }
    writeFileSync(join(dir, 'config.toml'), renderCodexConfig({ sandbox, effort, instructionsFile }));
    copyFileSync(auth, join(dir, 'auth.json'));
    return dir;
  } catch {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 無視 */ } }
    return null;
  }
}

/**
 * codex exec をヘッドレス実行する。
 *
 * sandbox は既定 read-only。書込みを許すチャンネルだけ config.json の
 * channels.<name>.codexSandbox で workspace-write へ上げる。
 *
 * MCP 遮断の方法に注意: --ignore-user-config を使うと MCP は消えるが
 * sandbox が read-only へ固定され、model_reasoning_effort も none に落ちる
 * (v0.144.5 実測)。そのため通常は「必要なキーだけを書いた隔離 CODEX_HOME」を
 * 使い、それを用意できないときだけ --ignore-user-config へ退避する。
 *
 * プロンプトは stdin 渡し。セッション永続なし (--ephemeral) — 文脈は
 * ブリッジ側のスレッド transcript 注入で毎回再構成する。
 *
 * instructionsFile (絶対パス) を渡すと Codex 組み込みの指示をそのファイルで置き換える
 * — コーディングエージェントではなく相談役として使うための口。
 */
export function runCodex({
  // 未設定・1 語なら spawn の直前に PATH から解決する (src/clicmd.js)
  codexCmd = null,
  // 解決をテストから固定するための差し替え口 (実機の PATH に判定を委ねない)
  resolveCmdImpl = null,
  cwd,
  model,
  prompt,
  imagePaths = [],
  sandbox = DEFAULT_CODEX_SANDBOX,
  instructionsFile = null,
  timeoutMs = 3600000,
  scrubEnvKeys = [],
  handle,
  // 子プロセスが立った直後に pid と時刻を知らせる (実行記録 — src/jobruns.js)。runClaude と同じ口
  onSpawn = null,
}) {
  // spawn 前に stop が来ていたら起動せず中断 (空振り窓の封鎖)
  if (handle?.stopRequested) {
    return Promise.resolve({ ok: false, aborted: true, error: '停止指示により中断' });
  }

  // 呼び出し側の検証を素通りした値でも全開放にしない (config 検証との二重の歯止め)
  const mode = CODEX_SANDBOXES.includes(sandbox) ? sandbox : DEFAULT_CODEX_SANDBOX;

  // 指示の差し替えは spawn 前に読む。読めないまま走らせると組み込み指示のまま起動し、
  // 相談役として立てた bot が Codex のコーディングエージェントとして応答してしまう
  let instructionsText = null;
  if (instructionsFile) {
    try {
      instructionsText = readFileSync(instructionsFile, 'utf8');
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: `指示ファイルを読めないため起動できません: ${instructionsFile} (${err.message})`,
      });
    }
  }

  const isolatedHome = createIsolatedHome(mode, instructionsText);
  if (!isolatedHome) {
    // 退避すると --ignore-user-config で read-only へ固定され、隔離 config.toml ごと
    // 読まれなくなる (= 指示の差し替えも消える)。**降格させずに落とす** —
    // ブリッジは実行文脈へ「書込み可」と書いてモデルへ渡している。黙って読取専用で走らせると、
    // モデルは書けるつもりで書き、失敗の理由が分からないまま報告が嘘になる (sol 指摘 2026-08-01)。
    // 指示の差し替えも同じで、黙って別の人格として応答する方が高くつく
    const unmet = [];
    if (mode !== DEFAULT_CODEX_SANDBOX) unmet.push(mode);
    if (instructionsText !== null) unmet.push('指示の差し替え');
    if (unmet.length > 0) {
      return Promise.resolve({
        ok: false,
        error:
          `隔離 CODEX_HOME を用意できないため ${unmet.join(' と ')} で起動できません` +
          ' (~/.codex/auth.json を読めるか、TEMP に書けるかを確認してください)',
      });
    }
  }

  // **隔離 home を作った後に解決する** — 先に解決すると、codex が入っていない環境で
  // sandbox / 指示の差し替えの失敗理由が「見つかりません」に置き換わってしまう。
  // 1 語は絶対パスでない限り引き直す (`codexCmd: ["codex"]` は Windows でそのままだと落ちる)
  const resolvedCmd = resolveCmdImpl
    ? resolveCmdImpl(codexCmd)
    : resolveConfiguredCommand(codexCmd, CODEX_CLI);
  if (!resolvedCmd) {
    // 認証コピーを置いた隔離 home はこの経路でも必ず消す。消せなかったら黙らない —
    // finish() と同じ不変条件 (認証情報が temp に残ったことを人間が知る必要がある)
    if (isolatedHome) {
      try {
        rmSync(isolatedHome, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `[codex] 認証コピーを含む一時 CODEX_HOME の削除に失敗: ${isolatedHome} (${err.message}) — 手動で削除してください`,
        );
      }
    }
    return Promise.resolve({
      ok: false,
      error: `codex を起動できません (${cliCmdReason(codexCmd, CODEX_CLI)}) — ${CODEX_CMD_HINT}`,
    });
  }

  const outDir = mkdtempSync(join(tmpdir(), 'communitd-codex-'));
  const outFile = join(outDir, 'last-message.txt');
  const [bin, ...binArgs] = resolvedCmd;
  const args = [
    ...binArgs,
    'exec',
    '--sandbox', mode,
    // 隔離 home がある時はそちらが MCP を持たない。用意できなかった時だけ
    // --ignore-user-config で MCP を遮断する (代償として read-only 固定になる)
    ...(isolatedHome ? [] : ['--ignore-user-config']),
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '-o', outFile,
  ];
  if (model) args.push('-m', model);
  // -i は可変長引数なので 1 ファイルずつ渡す (まとめて渡すと後続の引数を飲み込む)。
  // read-only sandbox でも cwd 外の一時画像を読めることは実測で確認済み
  for (const p of imagePaths) args.push('-i', p);

  // Discord トークン等の秘密を渡さない (claude 側と同じ scrub)
  const env = scrubEnv(process.env, scrubEnvKeys);
  if (isolatedHome) env.CODEX_HOME = isolatedHome;

  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    if (typeof onSpawn === 'function') {
      try { onSpawn({ pid: child.pid ?? null, at: Date.now(), runtime: 'codex' }); } catch { /* 記録の失敗で起動は止めない */ }
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    if (handle) {
      handle.abort = () => {
        handle.stopRequested = true;
        if (!settled) {
          aborted = true;
          killTree(child);
        }
      };
    }

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 認証コピーを置いた隔離 home は成功・失敗・停止・タイムアウトのどの経路でも消す。
      // 消せなかった時は黙らない — 認証情報が temp に残ったことを人間が知る必要がある
      for (const dir of [outDir, isolatedHome]) {
        if (!dir) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          const what = dir === isolatedHome ? '認証コピーを含む一時 CODEX_HOME' : '一時出力ディレクトリ';
          console.error(`[codex] ${what} の削除に失敗: ${dir} (${err.message}) — 手動で削除してください`);
        }
      }
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(
        () => finish({ ok: false, error: `timeout after ${Math.round(timeoutMs / 60000)} min` }),
        8000,
      ).unref?.();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({
      ok: false,
      // 実行ファイルが見つからない / 直接起動できない (Windows の .cmd シム) の 2 つは
      // 生の errno だけでは原因が分からないので、設定の直し方を添える
      error: `spawn failed: ${err.message}`
        + (['ENOENT', 'EINVAL'].includes(err.code) ? ` — ${CODEX_CMD_HINT}` : ''),
    }));
    child.on('close', (code) => {
      if (aborted) {
        finish({ ok: false, aborted: true, error: '停止指示により中断' });
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          error: `timeout after ${Math.round(timeoutMs / 60000)} min`,
          detail: (stderr || stdout).slice(-1500),
        });
        return;
      }
      let result = '';
      try {
        result = readFileSync(outFile, 'utf8').trim();
      } catch { /* 出力なし */ }
      if (code !== 0 || !result) {
        finish({
          ok: false,
          code,
          error: `codex exit ${code}${result ? '' : ' (no output)'}`,
          detail: (stderr || stdout).slice(-1500),
        });
        return;
      }
      finish({ ok: true, result });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
