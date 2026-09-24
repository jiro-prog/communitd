// @ts-check
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_CLI, cliCmdHint, cliCmdReason, resolveCliCommand, resolveConfiguredCommand } from './clicmd.js';
import { detachOption, killTree, scrubEnv } from './proc.js';

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

/**
 * codex CLI が `model_reasoning_effort` に受け付ける値。**src 内でここだけが正本**で、
 * `bots.<key>.effort` の検証 (src/config.js) もこの配列を見る。
 *
 * 値域の正本は codex CLI 自身なので二重管理ではある。**未知の値は行ごと省く**ので、
 * ここが古いとユーザーが書いた effort が黙って落ち、codex 既定の `none` で走る —
 * 実際 2026-09-10 に `model_reasoning_effort = "max"` が読み落とされ、Sol が推論なしで
 * レビューしていた。`max` と `minimal` は codex 0.144.5 が受け付けることを実機で確認済み。
 *
 * **モデルによっては受け付けない値がある** (`gpt-5.5` は `max` を 400 で拒む) ので、
 * 「codex が知っている値」と「そのモデルで通る値」は別物。後者は起動して初めて分かる。
 */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
      return CODEX_EFFORTS.includes(value) ? value : null;
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
export function renderCodexConfig({ sandbox, effort, instructionsFile = /** @type {string|null} */ (null) }) {
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

/** 一時ディレクトリを消せなかったときにやり直す間隔 (ms)。伸ばしながら 3 回試す */
const TEMP_REMOVE_RETRY_MS = [250, 1000, 4000];

/**
 * job が使った一時ディレクトリを消す。
 *
 * **Windows では 1 回目が失敗することがある** — タイムアウトで kill された codex が
 * sqlite を掴んだままだと `EBUSY` で消せない (実測 2026-09-11)。掴みが外れるのを待って
 * 数回やり直し、それでも消せなければ**黙らない**: 認証と sandbox ユーザーの写しが temp に
 * 残ったことは、人間が知る必要がある。
 *
 * **最初の失敗は、やり直す前にその場で告知する。** やり直しのタイマーは `unref` してあり
 * プロセスの終了を止めないので、`/restart` や停止がここに挟まると、やり直しごと消えて
 * 「消せませんでした」を**言う機会が来ない** (sol 指摘 2026-09-11)。残ったパスが分かるのが
 * この 1 行だけになる場合があるので、やり直す予定も一緒に書く。
 *
 * やり直しは背後で待つ。呼び出し側は待たない (削除の都合で job の応答を遅らせない)。
 * export と `delays` / `rm` の差し替え口は、テストから「やり直す」「告知する」を固定する
 * ため — 掴まれたファイルは実機の OS ごとに作り方が違い、事例にできない。
 */
export function removeTempDir(
  dir,
  what,
  { delays = TEMP_REMOVE_RETRY_MS, attempt = 0, rm = /** @type {((dir: string) => void)|null} */ (null) } = {},
) {
  if (!dir) return;
  try {
    if (rm) rm(dir);
    else rmSync(dir, { recursive: true, force: true });
    // 1 回目で消えたときは黙る (常態なので)。やり直して消えたときだけ、
    // 先に出した「消せません」の結末として 1 行を残す
    if (attempt > 0) {
      console.log(`[codex] ${what} を削除しました: ${dir} (${attempt + 1} 回目)`);
    }
  } catch (err) {
    const remaining = delays.length - attempt;
    if (remaining > 0) {
      if (attempt === 0) {
        console.error(
          `[codex] ${what} を削除できません: ${dir} (${err.message})`
          + ` — ${remaining} 回やり直します。ブリッジがそれまでに終了したらこのパスは残るので、`
          + '手動で削除してください',
        );
      }
      setTimeout(
        () => removeTempDir(dir, what, { delays, attempt: attempt + 1, rm }),
        delays[attempt],
      ).unref?.();
      return;
    }
    console.error(`[codex] ${what} の削除に失敗: ${dir} (${err.message}) — 手動で削除してください`);
  }
}

/**
 * 隔離 CODEX_HOME と出力先をまとめて消す。**途中で return する経路も必ずここへ流す** —
 * 経路ごとに個別に消していると、後から増えた資源が片方だけ漏れる
 * (sol 指摘 2026-09-11: `spawn` の同期例外で認証コピーごと残っていた)。
 */
function cleanupTempDirs({
  outDir = /** @type {string|null} */ (null),
  isolatedHome = /** @type {string|null} */ (null),
} = {}) {
  removeTempDir(outDir, '一時出力ディレクトリ');
  removeTempDir(isolatedHome, '認証コピーを含む一時 CODEX_HOME');
}

/**
 * spawn の失敗を結果へ。同期例外と 'error' イベントで同じ文にする。
 * 実行ファイルが見つからない / 直接起動できない (Windows の .cmd シム) の 2 つは
 * 生の errno だけでは原因が分からないので、設定の直し方を添える。
 */
function spawnFailure(err) {
  return {
    ok: false,
    error: `spawn failed: ${err.message}`
      + (['ENOENT', 'EINVAL'].includes(err.code) ? ` — ${CODEX_CMD_HINT}` : ''),
  };
}

/**
 * Windows の codex sandbox が要求する状態ファイル (CODEX_HOME からの相対パス)。
 *
 * **これが無いと workspace-write の job が無反応のまま固まる。** codex は
 * `.sandbox/sandbox.<日付>.log` に `sandbox setup required: sandbox setup marker missing or
 * incompatible` と書いて sandbox の setup をやり直そうとし、最初のコマンドが返らないまま
 * job のタイムアウトまで沈黙する (実測 2026-09-11、codex 0.144.5 / 0.154.0 の両方)。
 * `.sandbox-secrets/sandbox_users.json` を欠くと今度は
 * `sandbox users missing or incompatible with marker version` で同じ症状になる。
 *
 * `.sandbox-bin` (command-runner 群・数百 MB) は写さなくてよい — codex が実体の
 * パスから使う。
 */
const SANDBOX_STATE_FILES = [
  'cap_sid',
  '.sandbox-secrets/sandbox_users.json',
  '.sandbox/setup_marker.json',
];

/**
 * sandbox の状態ファイルを実 home から隔離 home へ写す。
 *
 * **実 home に無ければ写さない** — 非 Windows や、まだ sandbox を setup していない環境には
 * 存在しない。写す途中の失敗 (在るのに読めない等) は呼び出し側の catch へ投げる:
 * 中途半端な隔離 home で走らせると、また「無反応のまま固まる」に戻る。
 */
function copySandboxState(source, dir) {
  for (const rel of SANDBOX_STATE_FILES) {
    const from = join(source, ...rel.split('/'));
    if (!existsSync(from)) continue;
    const to = join(dir, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * 隔離 CODEX_HOME を作る。実 home から引き継ぐのは認証と、書込みを許す時だけ
 * sandbox の状態ファイル (SANDBOX_STATE_FILES) の 2 つ。
 * 作れなければ null を返し、呼び出し側は --ignore-user-config へ退避する
 * (= sandbox は read-only に固定される。fail-closed)。
 *
 * instructionsText を渡すと、その**内容を隔離 home へ書き出して**指す。元のパスを
 * config.toml へ書かないのは、読んでから codex が開くまでの間に指示が書き換わる窓を
 * 塞ぐため (role prompt を一時ファイルへ写す src/bridge/job.js と同じ理由)。
 *
 * effort (bot ごとの `bots.<key>.effort`) を渡すとユーザー `~/.codex/config.toml` の
 * `model_reasoning_effort` より優先する。**bot ごとに変える口が要るのはモデル側の制約**で、
 * 例えば `gpt-5.5` は `max` を 400 (`reasoning.effort`) で拒むため、ユーザー設定が `max` の
 * 環境ではその bot だけ下げないと毎回落ちる (実測 2026-09-11)。省略すれば従来どおり
 * ユーザー設定を写すので、既存 bot の挙動は変わらない。
 */
export function createIsolatedHome(
  sandbox,
  instructionsText = /** @type {string|null} */ (null),
  botEffort = /** @type {string|null} */ (null),
) {
  const source = realCodexHome();
  const auth = join(source, 'auth.json');
  if (!existsSync(auth)) return null;

  // 呼び出し側の検証 (src/config.js) を素通りした値は書き込まない — 未知の値を
  // config.toml へ書くと codex が 400 で落ち、原因が「隔離 config の中身」になって遠い
  /** @type {string|null} */
  let effort = typeof botEffort === 'string' && CODEX_EFFORTS.includes(botEffort) ? botEffort : null;
  if (!effort) {
    try {
      effort = readUserReasoningEffort(readFileSync(join(source, 'config.toml'), 'utf8'));
    } catch { /* config が無くても既定の推論設定で動く */ }
  }

  /** @type {string|null} */
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'communitd-codexhome-'));
    /** @type {string|null} */
    let instructionsFile = null;
    if (instructionsText !== null) {
      instructionsFile = join(dir, 'instructions.md');
      writeFileSync(instructionsFile, instructionsText);
    }
    writeFileSync(join(dir, 'config.toml'), renderCodexConfig({ sandbox, effort, instructionsFile }));
    copyFileSync(auth, join(dir, 'auth.json'));
    // **書込みを許す時だけ** sandbox の状態を引き継ぐ。read-only は sandbox setup を
    // 要さないので写さずに通り (実測)、`sandbox_users.json` は sandbox 用ローカルユーザーの
    // 資格情報なので、要らない job の temp にまで置かない (auth.json と同じ扱い)
    if (sandbox === 'workspace-write') copySandboxState(source, dir);
    return dir;
  } catch {
    // 作りかけを残さない。認証だけ写った段階で失敗することもあるので、消せなければ告知する
    removeTempDir(dir, '認証コピーを含む一時 CODEX_HOME');
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
 *
 * effort を渡すと隔離 config.toml の model_reasoning_effort をその値で書く
 * (ユーザー設定より優先。モデルが拒む値を避けるための bot ごとの口 — createIsolatedHome)。
 */
export function runCodex({
  // 未設定・1 語なら spawn の直前に PATH から解決する (src/clicmd.js)
  codexCmd = null,
  // 解決をテストから固定するための差し替え口 (実機の PATH に判定を委ねない)
  resolveCmdImpl = /** @type {((cmd: string|string[]|null) => string[]|null)|null} */ (null),
  cwd,
  model,
  // bot ごとの推論量 (`bots.<key>.effort`)。省略すればユーザー ~/.codex/config.toml の値
  effort = null,
  prompt,
  imagePaths = [],
  sandbox = DEFAULT_CODEX_SANDBOX,
  instructionsFile = null,
  timeoutMs = 3600000,
  scrubEnvKeys = [],
  handle,
  // 子プロセスが立った直後に pid と時刻を知らせる (実行記録 — src/jobruns.js)。runClaude と同じ口
  onSpawn = /** @type {((info: {pid: number|null, at: number, runtime: string}) => void)|null} */ (null),
  // spawn の差し替え口 (runClaude と同じ流儀)。同期例外のような「起動そのものが失敗する」
  // 経路は実機で作れないので、後始末をテストで固定するにはここが要る
  spawnImpl = spawn,
  // 出力先の作成の差し替え口。**隔離 home は作れたのに出力先だけ作れない**という分岐は、
  // 同じ tmpdir を使う以上 TEMP を壊しても作れない (隔離 home の方が先に落ちる) —
  // 「その時に隔離 home が消えるか」を試験で押さえるにはここが要る (sol 指摘 2026-09-11)
  mkdtempImpl = mkdtempSync,
}) {
  // spawn 前に stop が来ていたら起動せず中断 (空振り窓の封鎖)
  if (handle?.stopRequested) {
    return Promise.resolve({ ok: false, aborted: true, error: '停止指示により中断' });
  }

  // 呼び出し側の検証を素通りした値でも全開放にしない (config 検証との二重の歯止め)
  const mode = CODEX_SANDBOXES.includes(sandbox) ? sandbox : DEFAULT_CODEX_SANDBOX;

  // 指示の差し替えは spawn 前に読む。読めないまま走らせると組み込み指示のまま起動し、
  // 相談役として立てた bot が Codex のコーディングエージェントとして応答してしまう
  /** @type {string|null} */
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

  const isolatedHome = createIsolatedHome(mode, instructionsText, effort);
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
    // 認証コピーを置いた隔離 home はこの経路でも必ず消す (finish() と同じ不変条件)
    cleanupTempDirs({ isolatedHome });
    return Promise.resolve({
      ok: false,
      error: `codex を起動できません (${cliCmdReason(codexCmd, CODEX_CLI)}) — ${CODEX_CMD_HINT}`,
    });
  }

  // 出力先を作れないこと自体はありうる (TEMP に書けない等)。**素の throw にしない** —
  // 呼び出し側は Promise を待っているので、同期例外だと隔離 home を抱えたまま job が
  // internal-error で落ちる
  /** @type {string|null} */
  let outDir = null;
  try {
    outDir = mkdtempImpl(join(tmpdir(), 'communitd-codex-'));
  } catch (err) {
    cleanupTempDirs({ isolatedHome });
    return Promise.resolve({
      ok: false,
      error: `一時出力ディレクトリを作れないため起動できません (${err.message})`,
    });
  }
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

  // **spawn は同期例外も投げる** (Sol の sandbox では EPERM、Windows の実行ポリシー等)。
  // これを Promise の executor の中でやると、例外は Promise の reject になって finish() を
  // 素通りし、認証と sandbox ユーザーの写しを置いた隔離 home が temp に残る (sol 指摘 2026-09-11)
  let child;
  try {
    child = spawnImpl(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // win32 以外はプロセスグループを分ける (killTree が孫まで届くために要る。src/proc.js)
      ...detachOption(),
    });
  } catch (err) {
    cleanupTempDirs({ outDir, isolatedHome });
    return Promise.resolve(spawnFailure(err));
  }

  return new Promise((resolvePromise) => {
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
      // 認証コピーを置いた隔離 home は成功・失敗・停止・タイムアウトのどの経路でも消す
      // (消せなければ背後でやり直し、最後まで駄目なら告知する — cleanupTempDirs)
      cleanupTempDirs({ outDir, isolatedHome });
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
    child.on('error', (err) => finish(spawnFailure(err)));
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
