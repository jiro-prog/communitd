// pi ランタイム (docs/reference/pi-runtime.md) の権限判定。**副作用なし。**
//
// pi 自身は権限の仕組みを持たない (道具は何でも実行する)。そこで job ごとの拡張
// (src/pi-extension.js) が道具の呼び出し 1 回ずつにここを問い合わせ、claude ランタイムと
// **同じ設定 (チャンネルの allowedTools と permissionMode、契約の touch 制限)** で止める。
// claude では CLI 自身が照合するのでこのリポジトリに照合器は無かった。ここが 1 本目になる。
//
// **迷ったら止める (fail-closed)。** claude の照合を完全には再現できない箇所
// (シェルの wrapper の扱い、gitignore 形式のパス指定子) は、claude より**狭く**倒す:
// - シェルは連結 (`&&` `||` `;` `|` `&`) をほどいて**全部の片**がルールに合うときだけ通す。
//   コマンド置換・プロセス置換・`/dev/null` 以外へのリダイレクトは通さない
// - パス限定の `Edit(./パス)` は、touch 集合を作ったのと同じ関数 (src/toolrules.js の
//   describePathRule) で対象を規則の形へ直し、**文字列の完全一致**だけを通す
// - 書込みは作業ディレクトリ (と参照ディレクトリ) の実体の中だけ。リンクで外へ出るものは止める

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describePathRule, windowsPathIssue } from './toolrules.js';
import { summarizeToolInput } from './trace.js';

/** 最終報告を受け取る道具の名前 (拡張が登録し、pi の `--tools` にも足す) */
export const PI_REPORT_TOOL = 'submit_report';

/** job ごとの拡張の設定ファイル (JSON) を指す環境変数 */
export const PI_CONFIG_ENV = 'COMMUNITD_PI_CONFIG';

/**
 * pi の組み込み道具 → 権限を照合するときの claude のツール名。
 * `find` と `ls` はどちらもファイルを探すだけなので Glob と同じ扱いにする
 */
export const PI_TOOL_NAMES = Object.freeze({
  read: 'Read',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
  edit: 'Edit',
  write: 'Write',
  bash: 'Bash',
});

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write']);
/** 書込みを許可ルールの照合なしで通すモード (claude と同じ — 範囲は作業ディレクトリの中) */
const EDIT_BYPASS_MODES = ['acceptEdits', 'bypassPermissions'];
/** 扱えるモード。**知らないモードは何も通さない** */
export const PI_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

/** ルール文字列からツール名を取る (`Bash(git *)` → `Bash`) */
function toolNameOf(rule) {
  return String(rule ?? '').split('(')[0].trim();
}

/** `Bash(git *)` → `git *`。括弧の形でなければ null */
function ruleBody(rule) {
  const m = /^[A-Za-z]+\((.*)\)$/s.exec(String(rule ?? '').trim());
  return m ? m[1] : null;
}

const allow = () => ({ allow: true });
const deny = (reason) => ({ allow: false, reason });

/**
 * 実体のパス。まだ無いファイル (write の新規作成) は、**在る一番近い祖先**の実体に
 * 残りの名前を足す — 祖先の途中に外向きのリンクがあれば、その時点で外へ出たと分かる。
 * @returns {string|null} 解決できなければ null
 */
function realpathLoose(abs) {
  const rest = [];
  let cur = abs;
  for (let i = 0; i < 256; i += 1) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...rest.reverse());
      } catch {
        return null;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    rest.push(basename(cur));
    cur = parent;
  }
  return null;
}

/** target が root の中 (root 自身を含む) か */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 作業ディレクトリと参照ディレクトリの実体 (解決できないものは落とす) */
function realRoots(policy) {
  const roots = [];
  for (const dir of [policy.cwd, ...(Array.isArray(policy.addDirs) ? policy.addDirs : [])]) {
    if (typeof dir !== 'string' || dir === '') continue;
    const real = realpathLoose(resolve(dir));
    if (real) roots.push(real);
  }
  return roots;
}

/** pi が普通の空白へ置き換える文字 (pi 1.1.0 の utils/paths.js の UNICODE_SPACES と同じ集合) */
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;
/** pi が Windows で `C:\…` へ読み替える Git Bash / MSYS / Cygwin / WSL の書き方 */
const SHELL_DRIVE_PATH = /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i;

/**
 * 道具の入力から対象のパス (cwd 基準)。検索系は省略時に作業ディレクトリ。
 *
 * **pi が道具の中で書き換えるパスは通さない。** pi は先頭の `@` を外し、`~` をホームへ展開し、
 * `file://` をパスに直し、`/c/…` を `C:\…` に読み替え、特殊な空白を普通の空白にしてから触る
 * (pi 1.1.0 の tools/path-utils.js の resolveToCwd)。照合は `resolve(cwd, 生の値)` なので、
 * そのまま通すと照合したパスと触るパスがずれる — `~/x` は「作業ディレクトリの中の `~` という
 * フォルダ」と照合されてホームへ書ける (2026-10-12 のレビューで再現)。
 * pi の書き換えを真似ると版ごとに追随が要るので、**書き換えの対象になる形ごと断る**
 *
 * @returns {{ok: true, raw: string} | {ok: false, reason: string}}
 */
function targetPathOf(toolName, input) {
  const raw = input?.path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return ['grep', 'find', 'ls'].includes(toolName)
      ? { ok: true, raw: '.' }
      : { ok: false, reason: '対象のパスがありません' };
  }
  if (/^[@~]/.test(raw) || /^file:/i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || PI_UNICODE_SPACES.test(raw) || (!raw.includes('\\') && SHELL_DRIVE_PATH.test(raw))) {
    return {
      ok: false,
      reason: `${raw.slice(0, 80)} は書き換えられるパスの形 (先頭の @ / ~ / file: / /c/… / 特殊な空白) なので通しません。`
        + '作業ディレクトリからの相対パスか、ドライブから書いた絶対パスで指定してください',
    };
  }
  const issue = windowsNameIssue(raw);
  if (issue) return { ok: false, reason: `${raw.slice(0, 80)}: ${issue}` };
  return { ok: true, raw };
}

/**
 * Windows が特別扱いする名前 (代替データストリームの `:`・予約デバイス名・末尾の空白やドット)。
 * touch 集合の変換 (src/toolrules.js) と同じ基準を、**モードに関係なく全部の読み書き**に当てる —
 * `a.js:hidden` への書込みは git 差分にも検収にも出ない。`.` と `..` の段は名前ではないので見ない
 */
function windowsNameIssue(pathString) {
  const kept = String(pathString).split(/[\\/]/).filter((s) => s !== '.' && s !== '..');
  return kept.length === 0 ? null : windowsPathIssue(kept.join('/'));
}

/**
 * pi の道具の呼び出し 1 回を、この job の権限で通すか。
 *
 * @param {object} p
 * @param {string} p.toolName pi の道具名 (`read` / `bash` …)
 * @param {object} [p.input] 道具の引数
 * @param {object} p.policy
 * @param {string} p.policy.cwd 作業ディレクトリ (受付時に実体へ固定済み)
 * @param {string[]} [p.policy.addDirs] 参照ディレクトリ (絶対パス)
 * @param {string} [p.policy.permissionMode]
 * @param {string[]} [p.policy.allowedTools] claude 形式のルール
 * @param {string[]|null} [p.policy.tools] 契約の touch 制限で絞った組み込みツール (claude の名前)。null は絞らない
 * @param {string[]} [p.policy.disallowedTools] 明示的に落とすツール (claude の名前)
 * @param {boolean} [p.policy.report] 最終報告の道具を登録しているか
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decidePiToolCall({ toolName, input = {}, policy = {} } = {}) {
  const name = String(toolName ?? '');
  if (name === PI_REPORT_TOOL) {
    return policy.report === true ? allow() : deny('最終報告を受け取らない job です');
  }
  const tool = Object.hasOwn(PI_TOOL_NAMES, name) ? PI_TOOL_NAMES[name] : null;
  if (!tool) return deny(`${name} はこの job では使えません`);
  if (typeof policy.cwd !== 'string' || policy.cwd === '') {
    return deny('作業ディレクトリが分からないため、どの道具も通しません');
  }
  // 省略 (undefined) だけを既定へ倒す。null や配列でない絞り込みは「壊れた設定」として全部止める —
  // 黙って既定や「絞り込みなし」へ倒すと、touch 制限が外れたまま走る
  const mode = policy.permissionMode === undefined ? 'default' : policy.permissionMode;
  if (!PI_PERMISSION_MODES.includes(mode)) return deny(`permissionMode "${mode}" は扱えません`);
  if (policy.tools !== undefined && policy.tools !== null && !Array.isArray(policy.tools)) {
    return deny('設定の tools が配列ではないため、どの道具も通しません');
  }
  if (policy.disallowedTools !== undefined && !Array.isArray(policy.disallowedTools)) {
    return deny('設定の disallowedTools が配列ではないため、どの道具も通しません');
  }
  const allowedTools = Array.isArray(policy.allowedTools) ? policy.allowedTools.map(String) : [];
  const disallowed = Array.isArray(policy.disallowedTools) ? policy.disallowedTools.map(toolNameOf) : [];
  if (disallowed.includes(tool)) return deny(`${tool} はこの job で明示的に止められています`);
  if (Array.isArray(policy.tools) && !policy.tools.includes(tool)) {
    return deny(`${tool} はこの job では使えません (委譲の touch 制限)`);
  }

  if (READ_TOOLS.has(tool)) return decideRead(name, tool, input, policy, mode, allowedTools);
  if (WRITE_TOOLS.has(tool)) return decideWrite(name, tool, input, policy, mode, allowedTools);
  return decideShell(input, mode, allowedTools);
}

function decideRead(name, tool, input, policy, mode, allowedTools) {
  // claude と同じく、裸のルール (`Read` など) は場所を問わず読める
  const path = targetPathOf(name, input);
  if (!path.ok) return deny(path.reason);
  const { raw } = path;
  if (mode === 'bypassPermissions' || allowedTools.includes(tool)) return allow();
  const target = realpathLoose(resolve(policy.cwd, raw));
  if (!target) return deny(`${raw} を解決できません`);
  return realRoots(policy).some((root) => isInside(root, target))
    ? allow()
    : deny(`${raw} は作業ディレクトリの外です`);
}

function decideWrite(name, tool, input, policy, mode, allowedTools) {
  if (mode === 'plan') return deny('permissionMode: plan (読取専用) なので書けません');
  const path = targetPathOf(name, input);
  if (!path.ok) return deny(path.reason);
  const { raw } = path;
  const target = realpathLoose(resolve(policy.cwd, raw));
  if (!target) return deny(`${raw} を解決できません`);
  // **どのモードでも作業ディレクトリ (と参照ディレクトリ) の実体の外へは書かせない**
  if (!realRoots(policy).some((root) => isInside(root, target))) {
    return deny(`${raw} は作業ディレクトリの外です`);
  }
  if (EDIT_BYPASS_MODES.includes(mode)) return allow();
  // claude のファイル権限は Edit のルールで照合される (Write(パス) は受理されても照合されない —
  // src/toolrules.js の PATH_TOOLS)。裸の Edit / Write はどちらでも書ける
  if (allowedTools.includes('Edit') || allowedTools.includes('Write')) return allow();
  // パス限定 (`Edit(./src/a.js)`): touch 集合を作ったのと同じ関数で規則の形へ直し、完全一致だけ通す。
  // 書き込みの直前に見るので、リンクの差し替え・hardlink・予約名もここで止まる。
  // **既存ファイルの edit だけ。** claude でもパス限定の下では新規作成 (Write) が通らない
  // (src/rolecontext.js の案内「新規作成と、この一覧の外のファイルはツール側で拒否される」と揃える)。
  // gitignore 形のパターン (`Edit(./src/**)`) は完全一致しないので止まる — claude より狭い側
  const pinned = allowedTools.filter((r) => toolNameOf(r) === 'Edit' && ruleBody(r) !== null);
  if (pinned.length > 0 && tool === 'Write') {
    return deny('パス限定の書込み許可では新しいファイルを作れません (既存ファイルの edit だけ)');
  }
  if (pinned.length > 0) {
    // 先頭の `./` だけ落とす。describePathRule は区切りごとに Windows の名前の問題を見るので、
    // `.` の 1 段を「末尾がドットの名前」と読んで断る (モデルは `./src/a.js` と書きがち)
    const cleaned = raw.replace(/^(?:\.[\\/])+/, '');
    const described = describePathRule('Edit', cleaned, policy.cwd, { mustExist: tool === 'Edit' });
    if (described.ok && pinned.includes(described.rule)) return allow();
    return deny(
      described.ok
        ? `${raw} は書込みを許されたファイルに入っていません`
        : `${raw} は書込みを許されたファイルとして扱えません (${described.reason})`,
    );
  }
  return deny('この job では書込みが許可されていません');
}

function decideShell(input, mode, allowedTools) {
  if (mode === 'plan') return deny('permissionMode: plan (読取専用) なのでシェルは使えません');
  if (mode === 'bypassPermissions' || allowedTools.includes('Bash')) return allow();
  const rules = allowedTools
    .filter((r) => toolNameOf(r) === 'Bash')
    .map(ruleBody)
    .filter((b) => b !== null && b.trim() !== '');
  if (rules.length === 0) return deny('この job ではシェルが許可されていません');
  const split = splitShellCommand(input?.command);
  if (!split.ok) return deny(split.reason);
  for (const segment of split.segments) {
    if (!rules.some((body) => shellRuleMatches(body, segment))) {
      return deny(
        `\`${segment.slice(0, 80)}\` は許可されたコマンドに入っていません `
          + `(許可: ${rules.map((b) => `Bash(${b})`).join(' / ').slice(0, 300)})`,
      );
    }
  }
  return allow();
}

/**
 * 通してよいリダイレクト (出力を捨てる・標準エラーを合流させるだけ)。
 * 前後が空白か連結の記号であることを要求する — 語の途中の `>` を拾わない
 */
const HARMLESS_REDIRECT = /(^|\s)(?:[12]?>&[12]|(?:[12]|&)?>>?\s*\/dev\/null)(?=$|\s|[;&|])/g;

/**
 * シェルのコマンドを連結の記号でほどく。**クォートの中の記号は区切りにしない。**
 *
 * 通さないもの: コマンド置換 (`$(` / バッククォート)・プロセス置換 (`<(` / `>(`)・
 * `/dev/null` 以外へのリダイレクト・閉じていないクォート。置換はクォートの中でも実行されうるので、
 * 位置を問わず止める (コミットメッセージにバッククォートを書いた場合も止まる — 狭く倒す側)。
 *
 * @returns {{ok: true, segments: string[]} | {ok: false, reason: string}}
 */
export function splitShellCommand(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.trim() === '') return { ok: false, reason: 'コマンドが空です' };
  if (/`|\$\(|<\(|>\(/.test(text)) {
    return { ok: false, reason: 'コマンド置換 ($( ) / バッククォート) とプロセス置換は通しません' };
  }
  const stripped = text.replace(HARMLESS_REDIRECT, '$1 ');
  const segments = [];
  let cur = '';
  let quote = null;
  const push = () => {
    const s = cur.trim().replace(/\s+/g, ' ');
    if (s !== '') segments.push(s);
    cur = '';
  };
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < stripped.length) {
        cur += stripped[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c;
      if (i + 1 < stripped.length) {
        cur += stripped[i + 1];
        i += 1;
      }
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';') {
      push();
      continue;
    }
    if (c === '|' || c === '&') {
      push();
      // `&&` `||` `|&` は 2 文字で 1 つの区切り
      if (stripped[i + 1] === '|' || stripped[i + 1] === '&') i += 1;
      continue;
    }
    if (c === '>' || c === '<') {
      return { ok: false, reason: 'リダイレクト (> / <) は通しません (/dev/null と 2>&1 を除く)' };
    }
    cur += c;
  }
  if (quote) return { ok: false, reason: 'クォートが閉じていません' };
  push();
  if (segments.length === 0) return { ok: false, reason: 'コマンドが空です' };
  return { ok: true, segments };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * シェルのルール本体 (`Bash(…)` の中身) が、連結をほどいた 1 片に合うか。
 *
 * - `npm run test:*` … 前置き (旧い書き方。`npm run test` とその後ろに引数が続くもの)
 * - `git *` … `*` は任意の文字列。末尾が ` *` なら引数なしの `git` も通す
 * - `*` を含まない … 完全一致
 */
export function shellRuleMatches(body, segment) {
  const b = String(body ?? '').trim().replace(/\s+/g, ' ');
  const s = String(segment ?? '').trim();
  if (b === '' || s === '') return false;
  if (b.endsWith(':*')) {
    const prefix = b.slice(0, -2).trim();
    return prefix !== '' && (s === prefix || s.startsWith(`${prefix} `));
  }
  if (!b.includes('*')) return s === b;
  if (b.endsWith(' *') && s === b.slice(0, -2)) return true;
  return new RegExp(`^${b.split('*').map(escapeRegExp).join('.*')}$`, 's').test(s);
}

/**
 * 権限 → pi の `--tools` に並べる道具。**使えない道具はそもそも見せない** —
 * 見せて毎回止めると、モデルが止められた理由を読んで回り道を探すぶん遅くなる。
 * 判定の正本は decidePiToolCall で、ここは見せる範囲を絞るだけ。
 */
export function piToolsFor({
  allowedTools = [], permissionMode = 'default', tools = null, disallowedTools = [], report = false,
} = {}) {
  const rules = Array.isArray(allowedTools) ? allowedTools.map(String) : [];
  const dropped = new Set((Array.isArray(disallowedTools) ? disallowedTools : []).map(toolNameOf));
  const usable = (tool) => !dropped.has(tool) && (!Array.isArray(tools) || tools.includes(tool));
  const out = [];
  if (!PI_PERMISSION_MODES.includes(permissionMode)) return report ? [PI_REPORT_TOOL] : [];
  if (usable('Read')) out.push('read');
  if (usable('Grep')) out.push('grep');
  if (usable('Glob')) out.push('find', 'ls');
  if (permissionMode !== 'plan') {
    const bareWrite = EDIT_BYPASS_MODES.includes(permissionMode)
      || rules.includes('Edit') || rules.includes('Write');
    // パス限定の Edit だけなら edit は見せるが write (新規作成) は見せない (decideWrite と同じ線)
    const canEdit = bareWrite || rules.some((r) => toolNameOf(r) === 'Edit' && ruleBody(r) !== null);
    if (canEdit && usable('Edit')) out.push('edit');
    if (bareWrite && usable('Write')) out.push('write');
    const canShell = permissionMode === 'bypassPermissions' || rules.some((r) => toolNameOf(r) === 'Bash');
    if (canShell && usable('Bash')) out.push('bash');
  }
  if (report) out.push(PI_REPORT_TOOL);
  return out;
}

/**
 * pi の道具の実行 1 回 → ツール軌跡の 1 行 (src/trace.js と同じ形)。
 * 名前は claude のものへ寄せる — 集計 (最初の編集までに読んだ数など) と表示が同じ物差しで並ぶ。
 * 最終報告の道具は作業ではないので数えない
 * @returns {{tool: string, arg: string|null, failed?: true}|null}
 */
export function piTraceEntry(toolName, args, isError = false) {
  const name = String(toolName ?? '');
  if (name === '' || name === PI_REPORT_TOOL) return null;
  const tool = (Object.hasOwn(PI_TOOL_NAMES, name) ? PI_TOOL_NAMES[name] : name).slice(0, 40);
  const entry = { tool, arg: summarizeToolInput(tool, { file_path: args?.path, command: args?.command }) };
  return isError ? { ...entry, failed: true } : entry;
}

/**
 * 止めた呼び出し → 承認の候補を作る形 (claude の `permission_denials` と同じキー)。
 * src/bridge/turn.js が「何を足せば通るか」の候補として出す
 */
export function piDenialOf(toolName, input) {
  const name = String(toolName ?? '');
  const tool = Object.hasOwn(PI_TOOL_NAMES, name) ? PI_TOOL_NAMES[name] : name;
  const toolInput = {};
  if (typeof input?.path === 'string') toolInput.file_path = input.path;
  if (typeof input?.command === 'string') toolInput.command = input.command;
  return { tool_name: tool, tool_input: toolInput };
}
