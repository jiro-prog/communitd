// 拒否されたツール要求を、承認カードに出せる grant 候補へ畳む層。
//
// Phase 1 で**自動承認できるのはドメイン限定だけ** (src/grants.js)。
//   shell は不可: claude は照合前に timeout や裸の xargs のような wrapper を除去するので、
//                 「コマンド文字列の完全一致」が実行されるコマンドの同一性を保証しない
//                 (sol 指摘 2026-08-01)。生文字列一致には PreToolUse hook が要る。
//   パスは不可: パス指定子は gitignore パターンで、実行中に対象がディレクトリへ差し替わると
//               「1 ファイルだけ」を保証できない。
//
// ただし黙って落とすと「何を足せばいいのか」が誰にも分からなくなるので、
// shell とパスの拒否については**人間が config.json へ貼れる候補**を警告つきで文字列として出す。
// これはカードにもならず保存もされない — 貼るかどうかは人間が精査する。

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GRANT_KINDS, makeGrant, renderRule } from './grants.js';

/** 候補表示だけを行うシェル系ツール (自動承認はしない) */
export const SHELL_TOOLS = ['Bash', 'PowerShell'];

/**
 * 候補に書いてよいコマンドの文字。ホワイトリストなのが要点で、
 * `*` (wildcard)・`;` `&&` `|` (連結)・`$(` `` ` `` (置換)・クォートはここで落ちる。
 */
const SAFE_COMMAND = /^[A-Za-z0-9 _\-./:=@+,]+$/;

/** 絶対パス・親ディレクトリ参照 (cwd の外を指しうる書き方) */
const ABSOLUTE_PATH = /(^|[\s=:])(\/|~\/|[A-Za-z]:[\\/])/;
const PARENT_REF = /(^|[\s=:/\\])\.\.([\\/]|$)/;

/** ドメイン限定で承認できるツール → 入力のどのキーが URL か */
export const DOMAIN_TOOLS = { WebFetch: 'url' };

/**
 * 自動承認の対象外だが、人間向けの候補なら出せるツール → パスのキーと、
 * claude が実際に照合するツール名。
 *
 * Write / NotebookEdit を Edit として書くのは、claude のファイル権限判定が見るのが
 * Read(パス) と Edit(パス) だけで、Write(パス) は受理されても照合されないため
 * (実測 CLI 2.1.220)。人間が貼る候補でも、そのまま貼って効かないものは出さない。
 */
export const PATH_TOOLS = {
  Read: { key: 'file_path', ruleTool: 'Read' },
  Edit: { key: 'file_path', ruleTool: 'Edit' },
  Write: { key: 'file_path', ruleTool: 'Edit' },
  NotebookEdit: { key: 'notebook_path', ruleTool: 'Edit' },
};

/**
 * パスに含まれていたら候補にしない文字。
 * claude のパス指定子は gitignore パターンで、しかも手書きルールはエスケープされない。
 * `file[1].js` をそのまま書くと自分自身に一致せず兄弟ファイルに誤一致する。
 */
const GLOB_META = /[*?[\]{}!#\\]/;
/** 入力を見るとき用 (`\` は Windows のパス区切りとして来るので除く) */
const GLOB_META_INPUT = /[*?[\]{}!#]/;

/**
 * Windows が特別扱いするパス。**全プラットフォームで拒否する** (安全側)。
 *
 * どれも「通常のリポジトリファイルではないのに書き込めてしまう」経路で、
 * git 差分にも出ないため検収から消える (sol 指摘 2026-08-03: 実測で通っていた):
 * - `:` — NTFS の代替データストリーム (`src/index.js:shadow` は index.js に隠れて書ける)
 * - `CON` / `NUL` / `COM1` 等 — 予約デバイス名。拡張子を付けても予約のまま
 * - 末尾の空白・ドット — Windows が黙って落とすので、指定した名前と実体がずれる
 */
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|]/;
// CONIN$ / CONOUT$ もコンソールデバイス。COM¹ / LPT² のような上付き数字も
// Win32 がデバイス名として解釈する (sol 指摘 2026-08-03: 実測で通っていた)
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;
const WINDOWS_TRAILING = /[ .]$/;

/** 秘密らしい語・秘密らしいトークン列 (パス候補の抑止に使う) */
const SECRET_WORD =
  /(\.env\b|\btokens?\b|\bsecrets?\b|\bpass(word|wd)?\b|\bcredentials?\b|api[_-]?key|private[_-]?key|\bkeys?\b|id_[rd]sa)/i;
const SECRET_BLOB = /([A-Za-z0-9+/]{32,}={0,2}|[0-9a-f]{32,})/;

/** 表示から落とす制御文字 (承認カードの体裁を壊させない) */
const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, 'g');

/**
 * 拒否 1 件を grant 候補へ変える。
 *
 * @param {{tool_name?: string, toolName?: string, tool_input?: object, toolInput?: object}} denial
 * @param {{cwd?: string}} ctx canonical cwd (grant に焼き込む)
 * @returns {{ok: true, grant: object, rule: string}
 *          |{ok: false, tool: string, reason: string, suggestion?: string}}
 *          suggestion = 自動承認はできないが人間が config.json へ貼れる候補
 */
export function proposeGrant(denial = {}, { cwd = null } = {}) {
  const tool = String(denial.tool_name ?? denial.toolName ?? '').trim();
  const input = denial.tool_input ?? denial.toolInput ?? {};
  if (!tool) return { ok: false, tool: '(不明)', reason: 'ツール名が取れませんでした' };
  if (!cwd) return { ok: false, tool, reason: '作業ディレクトリを解決できないため承認できません' };

  if (SHELL_TOOLS.includes(tool)) {
    // 自動承認はしない。貼れる形にできたときだけ候補を添える
    const suggestion = suggestShellRule(tool, input?.command);
    return {
      ok: false,
      tool,
      reason:
        'シェルコマンドの許可は自動承認できません ' +
        '(claude は照合前に timeout や xargs のような wrapper を外すので、' +
        '文字列の完全一致では実行されるコマンドを固定できない)',
      ...(suggestion ? { suggestion } : {}),
    };
  }

  if (Object.hasOwn(DOMAIN_TOOLS, tool)) {
    const host = hostFromUrl(input?.[DOMAIN_TOOLS[tool]]);
    if (!host.ok) return { ok: false, tool, reason: host.reason };
    const made = makeGrant({ kind: 'web-domain', tool, value: host.host, cwd });
    if (!made.ok) return { ok: false, tool, reason: made.reason };
    return { ok: true, grant: made.grant, rule: renderRule(made.grant) };
  }

  if (Object.hasOwn(PATH_TOOLS, tool)) {
    // 自動承認はしない。貼れる形にできたときだけ候補を添える
    const suggestion = suggestPathRule(tool, input, cwd);
    return {
      ok: false,
      tool,
      reason:
        'ファイルパスの許可は自動承認できません ' +
        '(claude のパス指定子はパターンなので、実行中に対象がディレクトリへ変わると範囲を保証できない)',
      ...(suggestion ? { suggestion } : {}),
    };
  }

  return {
    ok: false,
    tool,
    reason:
      'このツールは入力を絞った形で許可できないため、恒久承認の候補にできません ' +
      '(必要なら config.policy.json に人間が直接書いてください)',
  };
}

/**
 * 人間が config.json の allowedTools へ貼れるシェルルールの候補。
 * 安全に書けないもの (wildcard・連結・cwd 外・秘密・前後の空白) では何も出さない。
 *
 * これは「貼れば手がかりになる」ものであって、貼れば安全という意味ではない —
 * claude は照合前に wrapper を外すので、範囲の見極めは人間の仕事。
 * @returns {string|null}
 */
export function suggestShellRule(tool, rawCommand) {
  if (!SHELL_TOOLS.includes(tool)) return null;
  const command = typeof rawCommand === 'string' ? rawCommand : '';
  if (command.trim() === '' || command !== command.trim()) return null;
  if (command.includes('*') || command.includes('?')) return null;
  if (!SAFE_COMMAND.test(command)) return null;
  if (PARENT_REF.test(command) || ABSOLUTE_PATH.test(command)) return null;
  if (SECRET_WORD.test(command) || SECRET_BLOB.test(command)) return null;
  const rule = `${tool}(${command})`;
  return rule.length > 200 ? null : displayableOrNull(rule);
}

/**
 * 表示しても変わらない候補だけを通す。
 *
 * 候補は「そのまま config.json へ貼るもの」なので、Discord 表示のために
 * バッククォートや制御文字を潰した時点で**別のパスやコマンドになる**
 * (``a`b.js`` → `a'b.js`)。貼ると効かないものを見せない (sol 指摘 2026-08-01)。
 */
function displayableOrNull(rule) {
  return sanitizeForDisplay(rule, rule.length) === rule ? rule : null;
}

/** URL からドメインを取り出す (https のみ) */
function hostFromUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'URL 指定なしでは許可できません' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'URL として読めないため恒久承認できません' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https 以外の取得先は恒久承認できません' };
  return { ok: true, host: url.hostname.toLowerCase() };
}

/**
 * 人間が config.json の allowedTools へ貼れるパスルールの候補。
 * 安全に書けないもの (cwd 外・ディレクトリ・パターン文字・秘密) では何も出さない —
 * 「貼れば動く」ものだけを出し、精査は人間に委ねる。
 * @returns {string|null}
 */
export function suggestPathRule(tool, input, cwd) {
  const spec = PATH_TOOLS[tool];
  if (!spec) return null;
  const described = describePathRule(tool, input?.[spec.key], cwd);
  return described.ok ? described.rule : null;
}

/**
 * パス 1 件を絞り込みルールへ変えられるか、**理由つきで**答える。
 *
 * `suggestPathRule` (承認候補の表示) と T6 の touch 集合の変換が同じ判定を使うための
 * 共通部。片方だけ緩めると「候補には出ないのに touch 集合では通る」がすぐ起きるので、
 * **規則はここ 1 か所**に置く。理由を返すのは、touch 集合が落ちたときに
 * 「なぜ絞れなかったのか」を委譲元へ返す必要があるため (黙って落とすと事故になる)。
 *
 * @param {string} tool PATH_TOOLS のキー
 * @param {unknown} rawPath cwd 基準の相対パス
 * @param {string|null} cwd canonical cwd
 * @returns {{ok: true, rule: string, relative: string} | {ok: false, reason: string}}
 */
export function describePathRule(tool, rawPath, cwd, { mustExist = false } = {}) {
  const spec = PATH_TOOLS[tool];
  if (!spec) return { ok: false, reason: `${tool} はパスで絞り込めないツールです` };
  if (!cwd) return { ok: false, reason: '作業ディレクトリを解決できません' };
  const raw = typeof rawPath === 'string' ? rawPath : '';
  if (raw.trim() === '') return { ok: false, reason: 'パスが空です' };
  if (raw !== raw.trim()) return { ok: false, reason: 'パスの前後に空白があります' };
  if (GLOB_META_INPUT.test(raw)) {
    return { ok: false, reason: 'パターン文字 (* ? [ ] { } ! #) を含むパスは 1 ファイルに絞れません' };
  }
  if (SECRET_WORD.test(raw) || SECRET_BLOB.test(raw)) {
    return { ok: false, reason: '秘密らしい語を含むパスは対象にしません' };
  }

  const abs = resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (rel === '') return { ok: false, reason: '作業ディレクトリ自身は指定できません' };
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: '作業ディレクトリの外を指しています' };
  }
  // **実体を見る前に**弾く。予約デバイス名は existsSync / realpathSync が通ってしまう。
  // 生の入力も見るのは、`resolve()` が末尾の空白・ドットを黙って落とすため —
  // 落ちた後だけを見ると「指定した名前と実体がずれる」入力を素通しする
  const issue = windowsPathIssue(raw) ?? windowsPathIssue(rel);
  if (issue) return { ok: false, reason: issue };
  try {
    const realRoot = realpathSync(cwd);
    const exists = existsSync(abs);
    // **touch 集合の変換では既存ファイルしか受けない。** `Edit` は既存ファイル専用で、
    // 新規作成には `Write` が要るが、touch 制限中の `Write` は落としてある。
    // 通すと「編集できる」と案内しておいて実際には何もできない (sol 指摘 2026-08-03)
    if (mustExist && !exists) {
      return {
        ok: false,
        reason: 'まだ存在しないファイルです — touch 制限中は既存ファイルの編集だけができます '
          + '(新規作成が要る依頼は touch 制限を解除してください)',
      };
    }
    if (exists) {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        return { ok: false, reason: 'ディレクトリは指定できません (配下すべてが対象になる)' };
      }
      // **hardlink は realpath では見抜けない** (別名ではなく同じ実体そのもの)。
      // 1 つの実体に複数の名前があると、touch 集合の中の名前を編集しただけで
      // 集合の外の名前からも変更が見える (sol 指摘 2026-08-03)
      if (stat.nlink > 1) {
        return {
          ok: false,
          reason: `同じ実体に別名があります (hardlink ${stat.nlink} 本) — `
            + 'touch 集合の外からも同じ変更が見えます',
        };
      }
    }
    const target = exists
      ? realpathSync(abs)
      : join(realpathSync(dirname(abs)), basename(abs));
    const realRel = relative(realRoot, target);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      return { ok: false, reason: 'リンクの実体が作業ディレクトリの外にあります' };
    }
    // **実体が字句上のパスと違うなら、リンクを経由している。**
    // 外向きリンクだけを見ていると、cwd の中で完結するリンク
    // (`alias/target.js` → `real/target.js`) が素通りし、
    // touch 集合に無いファイルへ編集が届く (sol 指摘 2026-08-03)。
    // ルールが指すのは字句上のパスなので、ずれている時点で保証できない
    if (target !== resolve(realRoot, rel)) {
      return {
        ok: false,
        reason: 'リンクを経由しており、指定したパスと実体が違います '
          + `(実体: ${realRel.split(sep).join('/')})`,
      };
    }
  } catch {
    return { ok: false, reason: '実体を解決できません (親ディレクトリが無い可能性)' };
  }
  const posix = rel.split(sep).join('/');
  if (GLOB_META.test(posix) || posix !== posix.trimEnd()) {
    return { ok: false, reason: 'パスにパターン文字として解釈される文字が含まれます' };
  }
  // ./ を付けてその位置にアンカーする (付けないと任意の深さの同名ファイルに一致する)
  const rule = displayableOrNull(`${spec.ruleTool}(./${posix})`);
  if (!rule) return { ok: false, reason: '表示すると別のパスになる文字を含みます' };
  return { ok: true, rule, relative: posix };
}

/**
 * Windows が特別扱いするパスの理由 (無ければ null)。
 * セグメントごとに見る — 途中のディレクトリ名でも同じ問題が起きる。
 */
function windowsPathIssue(pathString) {
  const segments = String(pathString ?? '').split(/[\\/]/);
  // 先頭のドライブレター (`C:`) は正当な絶対パスの一部。cwd の外なら手前で落ちている
  if (/^[A-Za-z]:$/.test(segments[0])) segments.shift();
  for (const segment of segments) {
    if (segment === '') continue;
    if (WINDOWS_FORBIDDEN_CHARS.test(segment)) {
      return 'Windows が使えない文字 (: < > " |) を含みます — `:` は代替データストリーム';
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return `予約デバイス名です (${segment}) — 通常のファイルになりません`;
    }
    if (WINDOWS_TRAILING.test(segment)) {
      return '末尾に空白かドットがあります (Windows が黙って落とします)';
    }
  }
  return null;
}

/**
 * Discord へ出す前の無害化。**表示のときだけ使う。**
 * 保存する値には決して通さない — バッククォートを潰すので、通すと別の値になる。
 */
export function sanitizeForDisplay(text, max = 300) {
  const flat = String(text ?? '').replace(CONTROL_CHARS, ' ').replaceAll('`', "'").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * permission_denials を承認候補へ畳む。
 * 同じ grant が 1 job に何度出ても 1 件にまとめる (カードを連投しない)。
 *
 * @param {Array<object>} denials
 * @param {{cwd?: string, max?: number}} opts max = 1 job で出すカードの上限
 * @returns {{proposals: Array<{grant: object, rule: string}>,
 *            rejected: Array<{tool: string, reason: string, suggestion?: string}>,
 *            dropped: number}}
 */
export function collectProposals(denials, { cwd = null, max = 3 } = {}) {
  const proposals = [];
  const rejected = [];
  const seenRules = new Set();
  const seenRejections = new Set();
  let dropped = 0;

  for (const denial of denials ?? []) {
    const proposed = proposeGrant(denial, { cwd });
    if (!proposed.ok) {
      const key = `${proposed.tool}:${proposed.reason}:${proposed.suggestion ?? ''}`;
      if (!seenRejections.has(key)) {
        seenRejections.add(key);
        rejected.push({
          tool: proposed.tool,
          reason: proposed.reason,
          ...(proposed.suggestion ? { suggestion: proposed.suggestion } : {}),
        });
      }
      continue;
    }
    if (seenRules.has(proposed.rule)) continue;
    seenRules.add(proposed.rule);
    if (proposals.length >= max) {
      dropped++; // 黙って切らない — 呼び出し側が件数を出す
      continue;
    }
    proposals.push(proposed);
  }
  return { proposals, rejected, dropped };
}

/** 承認できる種類の一覧 (ドキュメント・テストから参照する) */
export { GRANT_KINDS };
