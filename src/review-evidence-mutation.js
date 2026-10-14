// レビューの証拠 (変異): task が変えた src の行に決まった変異を入れ、変更したテストが殺すかを数える
// (docs/themes.md の review-evidence)。
//
// src/review-evidence.js の「変更前の src で落ちるか」は、変更の前後の 1 点でしか比べない — 遡り
// (docs/notes/2026-10-13-review-evidence-backtest.md) では測った提出のほとんどが「落ちない 0」で飽和し、回帰を入れても
// 全部通るテストを見つけたのは reviewer の手の変異だった。ここではその手の変異を決まった形で入れる:
// 変えた行の比較・論理演算子と真偽値を 1 箇所ずつ入れ替え、変更したテストを 1 ファイルずつ走らせて
//   殺された = どれかのファイルが落ちた / 生き残り = 全部通った / 時間切れ = 落ちる前に時間切れ
// を数える。**証拠であって判定ではない** — 生き残りには、振る舞いの変わらない変異 (等価な変異) も混ざる。
//
// 変異の選び方は純粋関数 (listMutants / pickEvenly / applyMutant)、手順は git とテスト実行を差し替えられる関数
// (measureMutations)。字句は**行ごとに**追う — 正規表現リテラルは見分けないので、ファイル全体で引用符を追うと
// 正規表現の中の ` 1 つで以降の全行の内外が入れ替わる。行で切れば崩れるのはその行の残りだけ。
//
// 門は measureReviewEvidence と同じ判定 (あちらは export していないので写す。どちらも何も触らずに断る):
// - 本体の作業ツリー (`git worktree list` の先頭) — 変異を入れている間、そこで動くものが変異の入った src を読む
// - src/ か test/ が dirty — 戻す先は HEAD なので、未コミットの変更は戻す途中で消える
//
// **このモジュールの import は静的なものだけにする** (src/review-evidence.js と同じ理由 — 測る作業ツリーの中の
// スクリプトから呼ばれると、実行の途中で src/ に変異が入る。入った後の動的 import は変異の入った版を読む)。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseChangedLines, parseNameStatus, runTestFile, selectEvidenceTargets } from './review-evidence.js';
import { DEFAULT_VERIFY_TIMEOUT_MS } from './verify.js';
import { parseWorktreeList, runGit, sameWorktreePath } from './worktree.js';

/** 1 回に入れる変異の上限 (ファイルをまたいだ合計)。1 通りごとに変更したテストを全部走らせうる */
export const DEFAULT_MAX_MUTANTS = 20;
/** 生き残りの行を出す数 (残りは件数) */
const SURVIVORS_SHOWN = 10;

/** 行頭 (字下げの後) がコメントの行は変異させない — `//`・`/*`・JSDoc の続きの `*` */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/**
 * 演算子と入れ替え先。**長い字面から照合する** — `>>=` の中の `>=`・`!==` の中を別に取らない。入れ替え先が
 * null の字面 (`=>` とシフト) は変異させずに読み飛ばす (`>` と `<` をそこから切り出さないための字面)
 */
const PUNCTUATORS = [
  ['>>>=', null], ['>>>', null], ['>>=', null], ['<<=', null],
  ['===', '!=='], ['!==', '==='],
  ['>>', null], ['<<', null], ['=>', null],
  ['>=', '<'], ['<=', '>'], ['&&', '||'], ['||', '&&'],
  ['>', '<='], ['<', '>='],
];
/** 語の入れ替え。語の切れ目は識別子の文字 (`istrue`・`true_` は語ごと読み飛ばす) */
const WORD_SWAPS = new Map([['true', 'false'], ['false', 'true']]);
/** テンプレートリテラルの中 (`${…}` は数値 = 中の `{` の深さ) の印 */
const TEMPLATE = 'template';

const isWordChar = (ch) => /[\w$]/.test(ch) || ch > '\x7f';

/** 引用符で始まる文字列の終わりの次の位置。閉じなければ行末 */
function skipQuoted(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length;) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === quote) return i + 1;
    else i += 1;
  }
  return text.length;
}

/**
 * 1 行の中の変異を入れられる箇所 `{index, from, to}`。'…' "…" `…` の中 (`${…}` の中も)・`//` の後・`/* … *\/` の中は
 * 対象外。テンプレートの中を追うのは閉じを見つけるためだけ。正規表現リテラルは見分けない
 */
function scanLine(text) {
  const sites = [];
  const stack = [];
  for (let i = 0; i < text.length;) {
    const top = stack.at(-1);
    const ch = text[i];
    if (top === TEMPLATE) {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i += 1;
      } else if (text.startsWith('${', i)) {
        stack.push(0);
        i += 2;
      } else i += 1;
      continue;
    }
    if (text.startsWith('//', i)) break;
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '`') {
      stack.push(TEMPLATE);
      i += 1;
      continue;
    }
    if (typeof top === 'number' && (ch === '{' || ch === '}')) {
      if (ch === '{') stack[stack.length - 1] += 1;
      else if (top === 0) stack.pop();
      else stack[stack.length - 1] -= 1;
      i += 1;
      continue;
    }
    const inCode = stack.length === 0;
    if (isWordChar(ch)) {
      let end = i + 1;
      while (end < text.length && isWordChar(text[end])) end += 1;
      const word = text.slice(i, end);
      if (inCode && WORD_SWAPS.has(word)) sites.push({ index: i, from: word, to: WORD_SWAPS.get(word) });
      i = end;
      continue;
    }
    const op = PUNCTUATORS.find(([from]) => text.startsWith(from, i));
    if (op) {
      if (inCode && op[1]) sites.push({ index: i, from: op[0], to: op[1] });
      i += op[0].length;
      continue;
    }
    i += 1;
  }
  return sites;
}

/**
 * 並びから `max` 個を等間隔に選ぶ。**純粋**。上限以下ならそのまま、超えたら i = 0..max-1 の
 * `floor(i * total / max)` 番目 — 同じ入力なら同じものを選ぶ (乱数を使わない)
 */
export function pickEvenly(items, max) {
  const list = [...(items ?? [])];
  if (!(list.length > max)) return list;
  const count = Math.max(0, Math.floor(max));
  return Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]);
}

/**
 * 変えた行に入れる変異 `{line, column, from, to}` を (行, 桁) の順に並べる。**純粋**。`lines` は parseChangedLines の
 * HEAD の側の行番号 (1 始まり)、`column` も 1 始まり (JS の文字列の位置)。1 変異 = 1 行の 1 箇所。
 * 行頭がコメントの行は除き、上限を超えたら pickEvenly で間引く (`max: Infinity` で間引かない)
 */
export function listMutants(source, lines, { max = DEFAULT_MAX_MUTANTS } = {}) {
  const all = String(source ?? '').split('\n');
  const mutants = [];
  for (const line of [...new Set(lines ?? [])].sort((a, b) => a - b)) {
    const text = all[line - 1];
    if (text === undefined || COMMENT_LINE.test(text)) continue;
    for (const { index, from, to } of scanLine(text)) mutants.push({ line, column: index + 1, from, to });
  }
  return pickEvenly(mutants, max);
}

/** 変異を 1 つ入れた全文。**純粋**。その位置に `from` が無ければ投げる (listMutants と別の版を渡した) */
export function applyMutant(source, { line, column, from, to }) {
  const lines = String(source ?? '').split('\n');
  const text = lines[line - 1];
  const index = column - 1;
  if (text === undefined || text.slice(index, index + from.length) !== from) {
    throw new Error(`変異の位置 ${line}:${column} に ${from} がありません`);
  }
  lines[line - 1] = text.slice(0, index) + to + text.slice(index + from.length);
  return lines.join('\n');
}

function porcelainLines(stdout) {
  return String(stdout ?? '').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 測らない理由 (門 2 つ。measureReviewEvidence と同じ判定)。測れるなら null */
async function refusalFor(root, git) {
  const [main] = parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']));
  if (main && !main.bare && sameWorktreePath(main.path, root)) {
    return `本体の作業ツリー (${root}) では測らない — src に変異を入れている間、ここで動くものが`
      + 'それを読む。task の作業ツリー (git worktree) を --cwd で渡すこと';
  }
  const dirty = porcelainLines(await git(root, ['status', '--porcelain', '--', 'src', 'test']));
  if (dirty.length > 0) {
    return `src/ か test/ に未コミットの変更がある (${dirty.length} 件: ${dirty.slice(0, 5).join(' / ')})`
      + ' — 終わったら HEAD へ戻すので消えてしまう。commit してから測る';
  }
  return null;
}

/**
 * task が変えた src の行を読む `git diff` (src/review-evidence.js の changedLinesArgs と同じ形 — 設定で hunk の
 * つながり方・接頭辞が変わらないように打ち消す)
 */
function changedLinesArgs(mergeBase) {
  return [
    'diff', '-U0', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, 'HEAD', '--', 'src',
  ];
}

/** src を HEAD へ戻し、src/ と test/ が clean かを確かめる。残っていればその様子を返す */
async function restoreSrc(root, git) {
  let checkoutError = null;
  try {
    await git(root, ['checkout', '--no-overlay', 'HEAD', '--', 'src']);
  } catch (err) {
    checkoutError = err;
  }
  const failed = checkoutError ? ` (checkout の失敗: ${checkoutError.message})` : '';
  try {
    const left = porcelainLines(await git(root, ['status', '--porcelain', '--', 'src', 'test']));
    if (left.length === 0) return null;
    return `src/ と test/ に ${left.length} 件残っています: ${left.slice(0, 10).join(' / ')}${failed}`;
  } catch (err) {
    return `git status を読めません: ${err.message}${failed}`;
  }
}

/**
 * task の作業ツリーで、変えた src の行に変異を入れて変更したテストが殺すかを測る。
 *
 * 対象は HEAD にある src/ の .js のうち、基点 (`git merge-base <base> HEAD`) から変えた行のあるもの。テストは
 * selectEvidenceTargets の tests (test/ の *.test.js の追加・変更)。変異は対象をパス順に並べて listMutants で
 * 全部挙げ、(ファイル, 行, 桁) の順で `max` 個 (ファイルをまたいだ合計) へ pickEvenly で間引く。
 *
 * 返すのは `outcome` 付きの結果: `measured` / `no-src` (変えた行のある .js が無い) / `no-tests` / `no-mutants`
 * (変えた行に入れ替える箇所が無い) / `head-fails` (変更したテストが変異なしでも全部落ちる) / `refused` (門で断った・
 * 何も触っていない) / `stopped` (handle の停止で中断した。`ran` = 測り終えた変異の数、`planned` = 予定の数)。
 * 変異を入れる前に結果の決まるもの (no-src / no-tests / no-mutants) はテストを走らせない。
 *
 * 手順: 先に変異なしで 1 ファイルずつ走らせ、落ちたファイル (時間切れも) は外す (`headFails` — 変異を殺したのか元から
 * 落ちるのかを読み分けられない)。変異ごとに src のファイルを書き換え → 残ったテストを 1 ファイルずつ走らせ、最初に
 * ok でなかった回で決める (時間切れなら `timeout`、それ以外は `killed` と落としたファイル `by`。全部通れば `survived`)
 * → そのファイルを HEAD へ戻す。終わったら (投げても・止まっても) src を HEAD へ戻し、src/ と test/ が clean に
 * 戻らなければ**投げる** (測っている途中の失敗も文に含める)
 *
 * @param {{cwd?: string, base: string, git?: Function, runTest?: Function, max?: number, timeoutMs?: number, handle?: {stopRequested: boolean, abort?: Function}}} p
 */
export async function measureMutations({
  cwd = process.cwd(),
  base,
  git = runGit,
  runTest = runTestFile,
  max = DEFAULT_MAX_MUTANTS,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  handle,
} = {}) {
  if (!base) throw new Error('base (比べる相手のブランチ) は省略できない');
  if (handle?.stopRequested) return { outcome: 'stopped', base, ran: 0 };
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const reason = await refusalFor(root, git);
  if (reason) return { outcome: 'refused', reason };

  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const { tests } = selectEvidenceTargets(parseNameStatus(
    await git(root, ['diff', '-z', '--name-status', '--no-renames', mergeBase, 'HEAD']),
  ));
  // 消したファイルは parseChangedLines に出ない (HEAD にある src だけが残る)
  const changed = parseChangedLines(await git(root, changedLinesArgs(mergeBase)));
  const targets = [...changed.keys()].filter((path) => path.endsWith('.js')).sort(byText);
  const common = { base, mergeBase, targets, tests };
  if (targets.length === 0) return { outcome: 'no-src', ...common };
  if (tests.length === 0) return { outcome: 'no-tests', ...common };
  // 作業ツリーは clean (門で確かめた) なので、ディスクの中身が HEAD の版
  const sources = new Map(targets.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const candidates = targets.flatMap((path) => listMutants(sources.get(path), changed.get(path), { max: Infinity })
    .map((mutant) => ({ file: path, ...mutant })));
  const mutants = pickEvenly(candidates, max);
  if (mutants.length === 0) return { outcome: 'no-mutants', ...common, candidates: candidates.length };
  // ここまでは読むだけ。止まっていれば戻すものも無い
  if (handle?.stopRequested) return { outcome: 'stopped', ...common, ran: 0, planned: mutants.length };

  const run = (file) => runTest({ cwd: root, file, timeoutMs, coverage: false, handle });
  const live = [];
  const headFails = [];
  const results = [];
  let stopped = false;
  let failure = null;
  // 1 通り分。止まったら null
  const runMutant = async () => {
    for (const file of live) {
      if (handle?.stopRequested) return null;
      const result = await run(file);
      if (result?.aborted) return null;
      if (result?.ok) continue;
      return result?.timedOut ? { status: 'timeout', by: file } : { status: 'killed', by: file };
    }
    return { status: 'survived' };
  };
  try {
    for (const file of tests) {
      if (handle?.stopRequested) {
        stopped = true;
        break;
      }
      const result = await run(file);
      if (result?.aborted) {
        stopped = true;
        break;
      }
      (result?.ok ? live : headFails).push(file);
    }
    for (const mutant of stopped ? [] : mutants) {
      // 変異なしで通るテストが 1 本も無ければ変異を入れない (head-fails)
      if (live.length === 0) break;
      if (handle?.stopRequested) {
        stopped = true;
        break;
      }
      writeFileSync(join(root, mutant.file), applyMutant(sources.get(mutant.file), mutant));
      const outcome = await runMutant();
      await git(root, ['checkout', 'HEAD', '--', mutant.file]);
      if (!outcome) {
        stopped = true;
        break;
      }
      results.push({ ...mutant, ...outcome });
    }
  } catch (err) {
    failure = err;
  }
  const leftover = await restoreSrc(root, git);
  if (leftover) {
    throw new Error(`作業ツリーが HEAD に戻りませんでした: ${leftover}`
      + (failure ? ` / 測っている途中の失敗: ${failure.message}` : ''));
  }
  if (failure) throw failure;
  if (stopped) return { outcome: 'stopped', ...common, ran: results.length, planned: mutants.length };
  if (live.length === 0) return { outcome: 'head-fails', ...common, headFails, candidates: candidates.length };
  const count = (status) => results.filter((mutant) => mutant.status === status).length;
  return {
    outcome: 'measured',
    ...common,
    headFails,
    candidates: candidates.length,
    mutants: results,
    counts: { survived: count('survived'), killed: count('killed'), timedOut: count('timeout') },
  };
}

/**
 * measureMutations の結果を人が読む形にする。1 行目が数 (測れなかったものは理由の 1 行)、続けて生き残りを
 * `src/x.js:120 === → !==` で 10 件まで (残りは件数)
 */
export function formatMutationEvidence(result) {
  if (result?.outcome === 'refused') return `断りました: ${result.reason}`;
  const where = `基点 ${String(result?.mergeBase ?? '').slice(0, 7)} (${result?.base})`;
  if (result?.outcome === 'stopped') {
    // 測り始める前に止まった回は予定も基点も無い — 無いものは省く
    const facts = [
      ...(Number.isInteger(result.planned) ? [`測った変異 ${result.ran ?? 0} / 予定 ${result.planned} 通り`] : []),
      ...(result.mergeBase ? [where] : []),
    ];
    return `停止で中断 — src は HEAD へ戻した${facts.length > 0 ? ` (${facts.join('・')})` : ''}`;
  }
  const srcCount = result?.targets?.length ?? 0;
  const testCount = result?.tests?.length ?? 0;
  if (result?.outcome === 'no-src') {
    return `src の差分なし — 変異を入れる行が無い (HEAD にある src の .js に変えた行 0・変更したテスト ${testCount} 本・${where})`;
  }
  if (result?.outcome === 'no-tests') {
    return `変更したテストなし — 変異を入れても走らせるものが無い (対象 src ${srcCount} ファイル・${where})`;
  }
  if (result?.outcome === 'no-mutants') {
    return `変異 0 通り — 変えた行に入れ替える演算子が無い (対象 src ${srcCount} ファイル・変更したテスト ${testCount} 本・${where})`;
  }
  if (result?.outcome === 'head-fails') {
    return `変更したテストが変異なしでも全部落ちる — 殺したかを読み分けられない (対象 src ${srcCount} ファイル・変更したテスト ${testCount} 本・${where})`;
  }
  const mutants = result?.mutants ?? [];
  const c = result?.counts ?? {};
  const excluded = result?.headFails?.length ?? 0;
  const facts = [
    `対象 src ${srcCount} ファイル`,
    `変更したテスト ${testCount - excluded} 本`,
    ...(excluded > 0 ? [`変異なしでも落ちて外した ${excluded} 本`] : []),
    where,
  ];
  const survivors = mutants.filter((mutant) => mutant.status === 'survived');
  return [
    `変異 ${mutants.length} 通りのうち 生き残り ${c.survived ?? 0} / 殺された ${c.killed ?? 0} / 時間切れ ${c.timedOut ?? 0}`
      + ` (${facts.join('・')})`,
    ...survivors.slice(0, SURVIVORS_SHOWN).map((mutant) => `${mutant.file}:${mutant.line} ${mutant.from} → ${mutant.to}`),
    ...(survivors.length > SURVIVORS_SHOWN ? [`ほか ${survivors.length - SURVIVORS_SHOWN} 通り`] : []),
  ].join('\n');
}
