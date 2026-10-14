import { appendFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeForDisplay } from './toolrules.js';

export const TRACE_DISPLAY_MAX_CHARS = 1900;
export const TRACE_MAX_KINDS = 12;
export const TRACE_MAX_ARGS = 4;
export const TRACE_HOOK_TIMEOUT_MS = 10000;

const SEP = ' / ';
// 引数の要約に秘密を出さないための足切り。**src/toolrules.js:59-60 と同じ基準**だが、
// あちらは「承認候補にしない」判定、こちらは「表示に出さない」判定で用途が違うため
// 独立させている。片方を緩めたらもう片方も見直すこと。
const SECRET_WORD =
  /(\.env\b|\btokens?\b|\bsecrets?\b|\bpass(word|wd)?\b|\bcredentials?\b|api[_-]?key|private[_-]?key|\bkeys?\b|id_[rd]sa)/i;
const SECRET_BLOB = /([A-Za-z0-9+/]{32,}={0,2}|[0-9a-f]{32,})/;

// 「最初の編集までに何ファイル読んだか」の分子と分母。文脈注入が足りているかの代理指標で、
// 毎回大量に読み直しているなら、ハーネスが渡すべきものをモデルが探し直している。
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// 実行後のイベントだけを記録する。成功と失敗でイベントが分かれている (実測 CLI 2.1.220)。
const DONE_EVENTS = new Map([['PostToolUse', false], ['PostToolUseFailure', true]]);

/**
 * ツール実行後 hook の payload 1 件 → 保存する最小の記録。
 * `tool_input` は丸ごと持たない (プロンプト本文・ファイル全文が載るため)。
 *
 * **実行後のイベントだけを受ける。** PreToolUse は実行**前**に発火するので、拒否された
 * 呼び出しまで「やった」ことになり、軌跡が実行の証拠でなくなる
 * (実測: hook が deny を返した Read は PreToolUse だけ発火し、実行後の両イベントは発火しない)。
 * 逆に `PostToolUse` だけに絞ると**失敗した実行が消えて総数が過少になる**ので、
 * `PostToolUseFailure` も受けて `failed` を立てる。
 */
export function traceEntryFrom(hookInput) {
  const event = String(hookInput?.hook_event_name ?? '');
  if (!DONE_EVENTS.has(event)) return null;
  const tool = String(hookInput?.tool_name ?? '').trim();
  if (tool === '') return null;
  const entry = { tool: tool.slice(0, 40), arg: summarizeToolInput(tool, hookInput?.tool_input) };
  // 成功時はキーごと省く (1 job で数百行になるファイルなので既定を短く保つ)
  return DONE_EVENTS.get(event) ? { ...entry, failed: true } : entry;
}

/**
 * ツール引数を「何をしたか」が分かる最小限へ畳む。
 * 秘密らしい語・長いトークン列が混じる引数は要約そのものを落とす (件数だけ残る)。
 */
export function summarizeToolInput(tool, input) {
  if (!input || typeof input !== 'object') return null;
  const keep = (value) => {
    const text = String(value ?? '').trim();
    if (text === '' || SECRET_WORD.test(text) || SECRET_BLOB.test(text)) return null;
    return text.slice(0, 40);
  };

  switch (tool) {
    // Windows の job では Bash ではなく PowerShell ツールが使われる (実測)。
    // どちらも同じ形の command を持つので同じ扱いにする。
    case 'Bash':
    case 'PowerShell': {
      // コマンド全体は出さない (パス・URL・引数が載る)。先頭語と、それに続く素性の分かる語だけ。
      const command = String(input.command ?? '');
      if (SECRET_WORD.test(command) || SECRET_BLOB.test(command)) return null;
      const [head = '', ...rest] = command.trim().split(/\s+/);
      // 先頭語が絶対パスのこともある (`C:\Users\...\bin\build.exe`)。ホスト側の
      // ディレクトリ構造を Discord へ出さないよう名前だけにし、素性の怪しいものは落とす。
      // 引用符・変数展開・リダイレクトが混じった語は、名前だけ切り出しても実体を表さない。
      if (/["'`]/.test(head)) return null;
      const name = basename(head.replaceAll('\\', '/'));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
      return [name, ...shellWords(rest)].join(' ').slice(0, 60);
    }
    case 'Read':
    case 'NotebookRead':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      // ファイル名だけ。フルパスは cwd の外側の構造まで晒すので出さない。
      return keep(basename(String(input.file_path ?? input.notebook_path ?? '')));
    case 'WebFetch':
      try {
        return keep(new URL(String(input.url ?? '')).host);
      } catch {
        return null;
      }
    default:
      // Grep / Glob の pattern、Task の prompt などは検索語そのものが機微になりうる。
      // 種類と回数だけ残す。
      return null;
  }
}

/** 先頭語に続けて残す語の上限 (`node --test x.test.js` の 3 語まで) */
const SHELL_MAX_WORDS = 3;

/**
 * 先頭語に続く語のうち、何を走らせたかが分かるものだけを前から拾う — サブコマンド (`commit`)・
 * フラグ (`--test`)・拡張子のあるパスの名前 (`test/a.test.js` → `a.test.js`)。
 * 拡張子の無いパス (ディレクトリ名に利用者名が載りうる)・引用符・変数・演算子が来たらそこで止める。
 * 手順の要約 (digestTrace) で「どのテストを走らせたか」を読めるようにするため (帰属の材料)。
 */
function shellWords(words) {
  const out = [];
  for (const word of words) {
    if (out.length >= SHELL_MAX_WORDS) break;
    if (/^--?[A-Za-z][\w-]*(=[\w.-]+)?$/.test(word) || /^[a-z][a-z0-9-]*$/.test(word)) {
      out.push(word.slice(0, 40));
      continue;
    }
    const file = basename(word.replaceAll('\\', '/'));
    if (/^[\w.*/\\:-]+$/.test(word) && /^[\w*-][\w.*-]*\.[A-Za-z0-9]+$/.test(file)) {
      out.push(file.slice(0, 40));
      continue;
    }
    break;
  }
  return out;
}

/** 記録の配列 → 表示と計測に使う集計 (純粋関数)。 */
export function summarizeTrace(entries = []) {
  const kinds = new Map();
  let total = 0;
  let failed = 0;
  let reads = 0;
  let readsBeforeFirstEdit = null;

  for (const entry of entries) {
    const tool = typeof entry?.tool === 'string' ? entry.tool : '';
    if (tool === '') continue;
    total += 1;
    if (entry.failed === true) failed += 1;
    // 「読んだ」「編集した」は成功した実行だけで数える。失敗した編集で打ち切ると
    // 実際には始まっていない作業を始まったことにしてしまう
    if (readsBeforeFirstEdit === null && entry.failed !== true) {
      if (READ_TOOLS.has(tool)) reads += 1;
      else if (EDIT_TOOLS.has(tool)) readsBeforeFirstEdit = reads;
    }
    const kind = kinds.get(tool) ?? { tool, count: 0, args: [] };
    kind.count += 1;
    if (typeof entry.arg === 'string' && entry.arg !== '' && !kind.args.includes(entry.arg)) {
      kind.args.push(entry.arg);
    }
    kinds.set(tool, kind);
  }

  return {
    total,
    failed,
    readsBeforeFirstEdit,
    kinds: [...kinds.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
  };
}

/**
 * Discord へ出す 1 行。0 件なら null (投稿そのものを積まない)。
 * 種類が多い job では上位から入るだけ出し、**落とした数を必ず明示する**。
 */
export function formatTraceLine(
  summary,
  { maxChars = TRACE_DISPLAY_MAX_CHARS, maxKinds = TRACE_MAX_KINDS, maxArgs = TRACE_MAX_ARGS } = {},
) {
  if (!summary || !(summary.total > 0) || !Array.isArray(summary.kinds)) return null;
  const kinds = summary.kinds;
  // 失敗の件数は「テストを実行しました」の主張を確かめる側の材料なので、0 でなければ必ず出す
  const failed = summary.failed > 0 ? ` (うち失敗 ${summary.failed})` : '';
  const head = `🔧 ツール ${summary.total} 件${failed}: `;
  const parts = kinds.slice(0, Math.max(0, maxKinds)).map((kind) => renderKind(kind, maxArgs));

  const chosen = [];
  let used = head.length;
  for (const part of parts) {
    const sep = chosen.length > 0 ? SEP.length : 0;
    // この 1 件を入れたときに残る省略数。注記の分まで見て入るかを決める (黙って切らない)
    const rest = kinds.length - chosen.length - 1;
    const notice = rest > 0 ? `${SEP}他 ${rest} 種省略`.length : 0;
    if (used + sep + part.length + notice > maxChars) break;
    chosen.push(part);
    used += sep + part.length;
  }

  const dropped = kinds.length - chosen.length;
  const body = [...chosen, ...(dropped > 0 ? [`他 ${dropped} 種省略`] : [])].join(SEP);
  return `${head}${body}`.slice(0, maxChars);
}

/** 手順の要約の既定の長さ (ハーネスの成績の問題の抜粋 1 件に添える) */
export const TRACE_DIGEST_MAX_CHARS = 400;

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const LOOK_TOOLS = new Set([...READ_TOOLS, 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const DIGEST_SEP = ' → ';

/**
 * 1 job の手順 → 「どの段で外れたか」を読むための 1 行 (純粋関数)。arXiv 2610.02616 (VERSE) の
 * 帰属 (失敗の軌跡を原因の手まで縮める) の代わり — 再実行で縮める代わりに、読むだけの手を畳み、
 * 編集したファイル・走らせたコマンド・失敗 (✗) を順に残す。続く同じ手は「×n」にまとめる。
 * 長いときは頭と尻を残して真ん中を「… n 手 …」で畳む (最後の検証まで見えるように)。
 *
 * 例: `読む×14 → 編集 harness.js×3 → $ node --test a.test.js ✗ → 編集 harness.js → $ node --test a.test.js`
 * @returns {string|null} 手が 0 件なら null
 */
export function digestTrace(entries = [], { maxChars = TRACE_DIGEST_MAX_CHARS } = {}) {
  const steps = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const tool = typeof entry?.tool === 'string' ? entry.tool : '';
    if (tool === '') continue;
    const arg = typeof entry.arg === 'string' && entry.arg !== '' ? sanitizeForDisplay(entry.arg, 60) : null;
    let label;
    if (LOOK_TOOLS.has(tool)) label = '読む';
    else if (EDIT_TOOLS.has(tool)) label = `編集 ${arg ?? '?'}`;
    else if (SHELL_TOOLS.has(tool)) label = `$ ${arg ?? '?'}`;
    else label = sanitizeForDisplay(tool, 40);
    if (entry.failed === true) label += ' ✗';
    const last = steps[steps.length - 1];
    if (last && last.label === label) last.count += 1;
    else steps.push({ label, count: 1 });
  }
  if (steps.length === 0) return null;
  const parts = steps.map((s) => (s.count > 1 ? `${s.label}×${s.count}` : s.label));
  const full = parts.join(DIGEST_SEP);
  if (full.length <= maxChars) return full;

  // 頭 parts[0, lo) と尻 parts[hi, n) を交互に 1 つずつ広げ、真ん中の注記の分まで見て入らなく
  // なったら止める (黙って切らない)。真ん中には必ず 1 手以上残る
  const render = (lo, hi) => [...parts.slice(0, lo), `… ${hi - lo} 手 …`, ...parts.slice(hi)].join(DIGEST_SEP);
  let lo = 0;
  let hi = parts.length;
  for (let fromHead = true; hi - lo > 1; fromHead = !fromHead) {
    const [a, b] = fromHead ? [lo + 1, hi] : [lo, hi - 1];
    if (render(a, b).length > maxChars) break;
    [lo, hi] = [a, b];
  }
  return render(lo, hi).slice(0, maxChars);
}

/**
 * 1 job の手順の全部を 1 手 1 行で (scripts/harness-report.mjs の `--trace`)。時刻は UTC の時:分:秒
 * (ハーネスの成績の他の時刻と同じ)。digestTrace で畳んだ所を手ごとに読み直すためのもの。
 */
export function formatTraceSteps(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => typeof e?.tool === 'string' && e.tool !== '');
  const width = String(list.length).length;
  return list.map((e, i) => {
    const at = Number.isSafeInteger(e.at) && e.at > 0 ? `${new Date(e.at).toISOString().slice(11, 19)} ` : '';
    const arg = typeof e.arg === 'string' && e.arg !== '' ? ` ${sanitizeForDisplay(e.arg, 60)}` : '';
    return `${String(i + 1).padStart(width)}. ${at}${sanitizeForDisplay(e.tool, 40)}${arg}${e.failed === true ? ' ✗' : ''}`;
  });
}

function renderKind(kind, maxArgs) {
  const name = sanitizeForDisplay(kind.tool, 40);
  const args = kind.args.slice(0, Math.max(0, maxArgs)).map((arg) => sanitizeForDisplay(arg, 40));
  const more = kind.args.length > args.length ? '…' : '';
  const tail = args.length > 0 ? ` (${args.join(', ')}${more})` : '';
  return `${name}×${kind.count}${tail}`;
}

/**
 * 軌跡の投稿は補助情報なので、失敗しても handoff を止めない。
 * `src/delivery.js:33-51` は **required を付けなくても failures が 1 件入れば止める**ため、
 * step の run 内で握るのはここが唯一の場所になる。
 */
export async function postTraceQuietly(send, text, onError) {
  try {
    await send(text);
  } catch (err) {
    onError?.(err);
  }
}

/** hook 側: 1 呼び出し = JSONL 1 行。job 終了後に親がまとめて読む。 */
export function appendTraceEntry(path, entry) {
  if (!path || !entry) return false;
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return true;
}

/** 親側: 壊れた行は黙って落とす (軌跡は補助情報。1 行のために job を失敗させない)。 */
export function readTraceEntries(path) {
  if (!path) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value.tool === 'string' && value.tool !== '') {
        const entry = {
          tool: value.tool,
          arg: typeof value.arg === 'string' ? value.arg : null,
          failed: value.failed === true,
        };
        // 記録時刻 (hook 側が付ける)。進捗表示の「N 分前」にだけ使い、集計には関与しない
        if (Number.isSafeInteger(value.at) && value.at > 0) entry.at = value.at;
        entries.push(entry);
      }
    } catch { /* 追記の競合で行が割れることはありうる。その 1 行だけ捨てる */ }
  }
  return entries;
}

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function main() {
  const index = process.argv.indexOf('--hook');
  if (index < 0 || !process.argv[index + 1]) throw new Error('使い方: node trace.js --hook <trace.jsonl>');
  const entry = traceEntryFrom(await readStdin());
  // 記録時刻を添える (進捗表示の「最後に完了したツール (N 分前)」の材料。集計は読まない)
  if (entry) appendTraceEntry(process.argv[index + 1], { ...entry, at: Date.now() });
  // 何も stdout へ出さない = 判定に関与しない。T4 は記録だけで、許可の挙動を一切変えない。
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    // **exit code は 0 のまま**にする。hook の異常終了はモデル側の扱いを変えうるので、
    // 軌跡が取れないことで作業を止めない (記録だけ諦める)。
    process.stderr.write(`tool trace hook error: ${err?.message ?? err}\n`);
  });
}
