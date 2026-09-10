// 設定に書かれた CLI コマンド (`claudeBin` / `codexCmd`) を **spawn できる形**へ解決する。
//
// **Windows だけ特別扱いが要る。** npm グローバルの実行ファイルは `.cmd` シムで、
// Node 20.12 以降の `spawn` は `.bat` / `.cmd` を直接起動できない (EINVAL)。
// `shell: true` へ逃がすと引数の引用をシェルに委ねることになり、空白を含むパスで壊れる
// (codex の `-o` に渡す mkdtemp のパスは、ユーザー名に空白があれば空白を含む)。
//
// **実体は「シムの中身を読んで」引く。** シムの最終行には起動されるファイルが
// `"%dp0%\…"` の形でそのまま書いてあるので、それを読めば npm / pnpm / yarn global /
// volta のどれで入れても同じ 1 つの方法で辿れる。パッケージごとの決め打ち
// (`node_modules/<pkg>/cli.js` 等) は版で変わる — 実際 `@anthropic-ai/claude-code` は
// 2.0 まで `cli.js`、2.1 以降は `bin/claude.exe` (Opus2 指摘 2026-09-10)。決め打ちは
// シムを読めなかったときの当てとしてだけ残す。
//
// **doctor と実行系は必ずこの同じ関数で解決する。** 別々に解決すると
// 「doctor は緑なのに全 job が起動できない」配置ができる (Opus2 指摘 2026-09-10)。
//
// 依存 (platform / env / exists / readFile / nodeBin) はすべて注入できる。doctor は自分の
// 注入した fs で読む必要があり、テストは実機の PATH に左右されずに判定を固定する必要がある。
//
// **パス操作は実行 OS ではなく `path.win32` で行う。** このモジュールが扱うのは
// Windows のパス文字列 (`;` 区切りの PATH・ドライブレター・`.cmd` シムの中の `%dp0%\…`)
// だけで、実際に探索するのも `platform === 'win32'` のときだけ。実行 OS の規則で読むと、
// Linux では `C:/npm` が相対パス扱いになって `join` が cwd を頭に付ける — 本番では通らない
// 経路なのにテストだけが落ちる (公開後の最初の CI で 9 件 fail 2026-09-11)。
// win32 の規則は先頭 `/` も絶対と見るので、Linux のパスを渡しても判定は変わらない。

import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

const { basename, dirname, extname, isAbsolute, join } = win32;

/** 直接 spawn できる拡張子 */
const NATIVE_EXT = ['.exe', '.com'];
/** node に食わせれば動く拡張子 */
const NODE_EXT = ['.js', '.mjs', '.cjs'];
/** spawn できないシム (中身を読んで実体を引く) */
const SHIM_EXT = ['.cmd', '.bat'];

/**
 * claude CLI の在り処。
 * `npmEntries` はシムを読めなかったときの当て — **版ごとに違う**ので候補を並べる。
 */
export const CLAUDE_CLI = {
  name: 'claude',
  configKey: 'claudeBin',
  npmEntries: [
    ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], // 2.1 以降
    ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'], // 2.0 まで
  ],
  example: '"C:/Users/<you>/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"',
};

/** codex CLI の在り処 (現行版も `bin/codex.js` — node で起動する) */
export const CODEX_CLI = {
  name: 'codex',
  configKey: 'codexCmd',
  npmEntries: [['node_modules', '@openai', 'codex', 'bin', 'codex.js']],
  example: '["node", "C:/Users/<you>/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js"]',
};

/** 注入された exists / readFile は投げてよい (doctor の fs は throw する) */
function safeExists(exists, path) {
  try {
    return exists(path) === true;
  } catch {
    return false;
  }
}

/**
 * `string | string[]` を語の配列へ揃える (非文字列・空白だけの語は落とす)。
 * @returns {string[]}
 */
export function normalizeCommand(value) {
  return (Array.isArray(value) ? value : [value])
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim());
}

/** 実体のパス → spawn できるコマンド (拡張子で node を噛ませるか決める) */
function commandFor(target, nodeBin) {
  const ext = extname(target).toLowerCase();
  if (NATIVE_EXT.includes(ext)) return [target];
  if (NODE_EXT.includes(ext)) return [nodeBin, target];
  return null;
}

/**
 * `.cmd` / `.bat` シムの中身から、実際に起動される実体を引く。
 *
 * 見るのは**引数を渡す行 (`%*` を含む行) だけ**。npm の JS 用シムは前段の IF ブロックに
 * `"%dp0%\node.exe"` (インタプリタ) を書くので、全文から拾うとそちらを実体と誤認する。
 *
 * @returns {string[]|null} spawn できるコマンド (辿れなければ null)
 */
export function resolveShim(shimPath, { exists = existsSync, readFile = readFileSync, nodeBin = process.execPath } = {}) {
  let text;
  try {
    text = String(readFile(shimPath));
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).reverse().find((l) => l.includes('%*'));
  if (!line) return null;
  const dir = dirname(shimPath);
  for (const m of line.matchAll(/"%~?dp0%?[\\/]*([^"]+)"/g)) {
    const target = join(dir, m[1].trim());
    // インタプリタ自身 (npm が同梱を優先するための `%dp0%\node.exe`) は実体ではない
    if (/^node(\.exe)?$/i.test(basename(target))) continue;
    if (!safeExists(exists, target)) continue;
    const cmd = commandFor(target, nodeBin);
    if (cmd) return cmd;
  }
  return null;
}

/**
 * PATH から実行できる形を引く。
 *
 * 非 Windows は `spawn` 自身が PATH を引くので名前をそのまま返す。Windows は
 * `.exe` → シムの中身 → 決め打ちの候補、の順で探し、**どれも辿れなければ null**。
 * 黙って名前のまま spawn すると ENOENT / EINVAL の生メッセージだけが出て原因が分からない。
 *
 * @param {{name: string, npmEntries?: string[][], platform?: string, env?: object,
 *          exists?: (p: string) => boolean, readFile?: (p: string) => string, nodeBin?: string}} p
 * @returns {string[]|null}
 */
export function resolveCliCommand({
  name,
  npmEntries = [],
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readFile = readFileSync,
  nodeBin = process.execPath,
} = {}) {
  const bin = typeof name === 'string' ? name.trim() : '';
  if (bin === '') return null;
  if (platform !== 'win32') return [bin];

  const has = (p) => safeExists(exists, p);
  const path = env?.PATH ?? env?.Path ?? env?.path ?? '';
  for (const raw of String(path).split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '') continue;
    // ネイティブ配布はそのまま spawn できる
    for (const ext of NATIVE_EXT) {
      const exe = join(dir, `${bin}${ext}`);
      if (has(exe)) return [exe];
    }
    const shim = SHIM_EXT.map((ext) => join(dir, `${bin}${ext}`)).find(has);
    if (!shim) continue;
    const fromShim = resolveShim(shim, { exists, readFile, nodeBin });
    if (fromShim) return fromShim;
    // シムを読めない / 書式が違う配置の当て。**決め打ちは最後**
    for (const entry of npmEntries) {
      const target = join(dir, ...entry);
      if (!has(target)) continue;
      const cmd = commandFor(target, nodeBin);
      if (cmd) return cmd;
    }
    // ここまで辿れないシム。他の PATH 要素に実体があるかもしれないので探索は続ける
  }
  return null;
}

/**
 * 設定値 → spawn できるコマンド。**明示の指定は尊重し、辿れない形だけ引き直す。**
 *
 * - 2 語以上 (`["node", "…/cli.js"]`) … そのまま。書いた人が実体を指している
 * - 1 語の絶対パスで `.cmd` / `.bat` … シムの中身から実体を引く。
 *   **そのまま spawn すると EINVAL** で、SETUP が勧める「フルパスを書く」が npm 版で効かない
 * - 1 語のその他の絶対パス … そのまま
 * - 1 語の名前 (既定の `"codex"` / `"claude"` を含む) … PATH から引く。
 *   ここを素通しにすると `codexCmd: ["codex"]` と書いただけで spawn が ENOENT になる
 * - 未設定・空 … 既定の名前 (`spec.name`) を PATH から引く
 *
 * @param {string|string[]|undefined} configured 設定値
 * @param {object} spec CLI の在り処 (CLAUDE_CLI / CODEX_CLI)
 * @param {object} [deps] 注入 (platform / env / exists / readFile / nodeBin)
 * @returns {string[]|null}
 */
export function resolveConfiguredCommand(configured, spec, deps = {}) {
  const cmd = normalizeCommand(configured);
  if (cmd.length > 1) return cmd;
  if (cmd.length === 1 && isAbsolute(cmd[0])) {
    if (!SHIM_EXT.includes(extname(cmd[0]).toLowerCase())) return cmd;
    return resolveShim(cmd[0], deps);
  }
  return resolveCliCommand({ ...spec, ...deps, name: cmd[0] ?? spec?.name });
}

/**
 * 見つからないときの案内。**エラー文と doctor で同じ文言を使う** — 直し方が
 * 1 か所にしか書いていないと、片方だけ古くなる。
 */
export function cliCmdHint({ configKey, example } = {}) {
  return `config.policy.json の ${configKey} に実体のパスを書いてください (例: ${example})`;
}

/**
 * 解決できなかった理由。**PATH のせいにしない** — 設定に絶対パスを書いた人には PATH は
 * 無関係で、「PATH に見つかりません」と言われると直す場所を探せない (Opus2 指摘 2026-09-10)。
 *
 * @param {string|string[]|undefined} configured 設定値 (どこを直せばよいかはこれで決まる)
 * @param {object} spec CLI の在り処 (CLAUDE_CLI / CODEX_CLI)
 */
export function cliCmdReason(configured, spec) {
  const cmd = normalizeCommand(configured);
  return cmd.length === 1 && isAbsolute(cmd[0])
    ? `${cmd[0]} から実体を辿れません`
    : `PATH に ${spec?.name} が見つかりません`;
}

/**
 * 理由 + 直し方。doctor はこの形をそのまま出す (実行系は「起動できません」を頭に付けるので
 * 理由だけを `cliCmdReason` で取る — 区切りの — が 2 つ並ばないように分けてある)。
 *
 * @param {string} [note] なぜその CLI を見に行ったのか (doctor 用)
 */
export function cliCmdFailure(configured, spec, note = '') {
  return `${cliCmdReason(configured, spec)}${note} — ${cliCmdHint(spec)}`;
}
