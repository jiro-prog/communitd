// レビューの証拠: task ブランチが変更したテストが、変更前の src で落ちるか (docs/themes.md の review-evidence)。
//
// reviewer がテストの価値を確かめる手段は、これまで手で src に変異を入れることだけだった
// (「回帰を入れても全部通る」は手の変異 5 通りで初めて見つかった)。ここでは task ブランチの src を
// 基点 (`git merge-base <base> HEAD`) の版へ一時的に戻し、変更したテストを 1 ファイルずつ HEAD と基点の
// 両方で走らせて
//   落ちる = テストが src の変更を検査している / 落ちない = 変更前の src でも通る / HEAD でも落ちる
// を数える。**証拠であって判定ではない** — 落ちないテストが悪いとは限らない (振る舞いを変えない整理の
// 回帰テストなど)。だから落ちないテストがあっても失敗にはしない。
//
// 判定はファイル単位 (exit code) のまま、ファイルの中の本数も添える — `--test-reporter=tap` の末尾の集計行
// (`# tests` / `# pass` / `# fail`) を読み、「HEAD で通る 12 本のうち 変更前の src で落ちる 1・通る 11」と出す。
// 1 本落ちれば「落ちる」に入るファイルの、残りの本数が変更を検査しているかを見えるようにするため。
// その行に、**task が足したテスト** (HEAD にだけある名前) だけの落ちる / 通るも添える — 昔からあるテストは変更前の
// src で通って当然なので、通る本数に混ざると「足したのに変更を検査していない」が読み分けられない。名前は
// TAP の各行から読み、カバレッジの前の回 (基点の版のテスト) の名前と突き合わせる (実行回数は増えない)。
// 逆向きに、前の回にあって HEAD に無い名前 (消した・改名した) と、差分で消したテストファイルも出す — 落ちるテストを
// 消して verify を通すすり抜けは、走らせるテストを見ているだけでは何も残らない。
//
// 加えて、**変更したテストだけ**で覆った src の行を前後で比べる (`--experimental-test-coverage`。全スイートは測らない)。
// 後 = HEAD の回にカバレッジを足したもの、前 = src と test/ を両方とも基点の版へ戻して基点の版のテストを走らせたもの
// (task が足したテストは基点に無いので 0 扱い)。test/ だけのタスクにも落ちる / 落ちないの代わりの材料が出る。
// test/ だけのタスクはさらに、変更したテストファイルごとに足した本数と**新たに覆った** src の行 (同じファイルの前後の
// lcov の行の集合の差) を出す — 既に覆われた行をなぞるだけのテストは「足した 3 本・新たに覆った src 行 0」と見える。
// src を変えたタスクは、ファイル単位の % に埋もれないように、task が変えた行 (基点と HEAD の `git diff -U0` の `@@`) の
// うち HEAD の回の lcov で通らない行を src ごとに出す — 書いた行に届かないテストは、回帰を入れても全部通る。
//
// 切り方は worktree.js と同じ: 差分の選別と整形は純粋関数、手順は git とテスト実行を差し替えられる関数。
// **作業ツリーを書き換えるのは git だけ** (基点の版の checkout・追加ファイルの git rm・HEAD への復元) —
// 差し替えた git を見れば「何も変えていない」を確かめられる。
//
// 門 2 つ (どちらも何も触らずに断る):
// - 本体の作業ツリー (`git worktree list` の先頭) — 稼働中のプロセスやレビューの job はそこで走る。
//   src を戻している間にそれらが読むと、変更前のコードで動く。task の作業ツリーで呼ぶこと
// - src/ か test/ が dirty — 復元先は HEAD なので、未コミットの変更は戻す途中で消える
//
// 停止の口は verify と同じ形の handle (`{stopRequested, abort}`、省略可 = 止まらない)。始めから立っていれば
// 書き換える git を打たずに、測っている途中なら走っているテストを撃って残りを走らせず、src と test/ を
// HEAD へ戻してから `stopped` を返す — 戻さずに抜けると基点の版が staged の変更として作業ツリーに残る。
//
// **このモジュールの import は静的なものだけにする。** 測る作業ツリーの中のスクリプトから呼ばれると、
// 実行の途中で src/ が基点の版へ入れ替わる。入れ替わった後の動的 import は基点の版を読む。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detachOption, killTree, scrubEnv } from './proc.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, VERIFY_KILL_GRACE_MS, tailText } from './verify.js';
import { parseWorktreeList, runGit, sameWorktreePath } from './worktree.js';

/**
 * 子の `node --test` から外す env。テストランナーの中 (`npm test` は既定の process 隔離) で呼ばれると
 * これが立っていて、孫が親のランナーの子として振る舞う
 */
const TEST_RUNNER_ENV_KEYS = ['NODE_TEST_CONTEXT'];
/** テスト 1 回の出力をためる上限 (末尾を残す) */
const OUTPUT_MAX_CHARS = 64 * 1024;
/** 落ちた回に残す出力の末尾 */
const FAILURE_TAIL_LINES = 20;
const FAILURE_TAIL_CHARS = 1900;
/** カバレッジの前後を出すファイルの数 (残りは件数だけ)。レビューの依頼の上限 (1200 字) に収める */
const COVERAGE_SHOWN = 5;
/** ファイルの中の本数を出すファイルの数 (残りは件数だけ)。同じくレビューの依頼の上限に収める */
const TEST_COUNTS_SHOWN = 5;
/** 消したテストの行に名前を出す、消したファイルと名前が消えたファイルの数 (残りは件数) */
const DELETED_SHOWN = 5;
const VANISHED_SHOWN = 5;
/** 基点で走り切らなかったファイルの行に名前を出す数 (残りは件数) */
const UNFINISHED_SHOWN = 5;
/** 変えた行の段に出す src の数と、ファイルごとに出す通らない行の範囲の数 (残りは件数) */
const UNTESTED_SHOWN = 5;
const RANGES_SHOWN = 5;
/**
 * 整形の上限。src/bridge/board.js の MAX_REVIEW_EVIDENCE_CHARS (レビューの依頼に載せる上限) と同じ値
 * (test/bridge-board.test.js が一致を確かめる)。board.js はこのモジュールを import する側なので、ここからは読まない
 */
export const EVIDENCE_MAX_CHARS = 1200;
/** reporter (spec / tap) がカバレッジ付きの回の末尾に足す表。落ちた回の末尾が表で埋まらないように外す */
const COVERAGE_REPORT = /^.*start of coverage report[\s\S]*?end of coverage report.*$/m;
/** 停止で走らせなかった・撃った回の出力 (runVerify の「停止指示により検証を中断」と同じ言い方) */
const STOPPED_ERROR = '停止指示によりテストを中断';

/** 変更したテストとして数えるパス: test/ の下の *.test.js (補助の .js は数えない) */
const TEST_FILE = /^test\/(?:[^/]+\/)*[^/]+\.test\.js$/;

/**
 * `git diff -z --name-status` の出力を分解する。`-z` なのは、無いと非 ASCII のパスが
 * 8 進のエスケープで引用されて (core.quotePath) 実在のパスと一致しなくなるから。
 *
 * @returns {{status: string, path: string}[]}
 */
export function parseNameStatus(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i];
    if (!status) {
      i += 1;
      continue;
    }
    // R / C (R100 など) は旧パスと新パスが続く。--no-renames では出ないが、出ても後ろがずれないように読む
    if (/^[RC]/.test(status)) {
      entries.push({ status: status[0], path: tokens[i + 2] ?? '' });
      i += 3;
      continue;
    }
    entries.push({ status: status[0], path: tokens[i + 1] ?? '' });
    i += 2;
  }
  return entries;
}

/**
 * 差分から「戻す src」と「走らせるテスト」を選ぶ。**純粋**。
 *
 * - src/ の A は基点に無いので一時的に消す (`srcAdded`)。M / T / D は基点の版へ戻す (`srcRestore`)
 * - テストは test/ の下の *.test.js の A / M だけ。D は HEAD に無いので走らせられない
 * - カバレッジの前の回は test/ も基点の版にする — 補助ファイルも込みで、A は消す (`testAdded`)・M / T / D は戻す
 *   (`testRestore`)。基点の版のテストが基点の版の補助を読むので、テストだけ戻すと前が測れない
 * - 消したテスト (test/ の下の *.test.js の D) は走らせずに名前だけ出す (`deletedTests`)
 * - それ以外 (scripts/・docs/) は対象外
 */
export function selectEvidenceTargets(entries) {
  const srcAdded = [];
  const srcRestore = [];
  const tests = [];
  const testAdded = [];
  const testRestore = [];
  const deletedTests = [];
  const restorable = (status) => status === 'M' || status === 'T' || status === 'D';
  for (const { status, path } of entries ?? []) {
    if (path.startsWith('src/')) {
      if (status === 'A') srcAdded.push(path);
      else if (restorable(status)) srcRestore.push(path);
    } else if (path.startsWith('test/')) {
      if (status === 'A') testAdded.push(path);
      else if (restorable(status)) testRestore.push(path);
      if (TEST_FILE.test(path) && (status === 'A' || status === 'M')) tests.push(path);
      else if (TEST_FILE.test(path) && status === 'D') deletedTests.push(path);
    }
  }
  return { srcAdded, srcRestore, tests, testAdded, testRestore, deletedTests };
}

/**
 * `--experimental-test-isolation` は Node 22.8 から。それより前 (engines は >=20.6) に渡すと
 * 「bad option」で落ち、全部が「HEAD でも落ちる」になる。1 ファイルずつ渡すので、無くても意味は変わらない
 */
export function supportsTestIsolation(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 8);
}

/**
 * lcov の reporter は Node 20.11.0 / 21.2.0 から (22 系は最初から)。v20.10.0・v21.1.0 には組み込みの
 * reporter の対応表に `lcov` が無く、外部モジュールとして探しに行って走りごと失敗する —
 * 落ちる / 落ちないの数えまで壊れるので、無い版ではカバレッジを付けずに走らせる
 */
export function supportsLcovReporter(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major === 20) return minor >= 11;
  if (major === 21) return minor >= 2;
  return major > 21;
}

/**
 * TAP の集計を読むか。読むのは `--experimental-test-isolation=none` の版 (22.8 から) だけ —
 * 確かめたのはその形 (最上位の項目がファイルの中のテスト・読み込みで落ちるとファイル名の `not ok` が 1 本)。
 * process 隔離の TAP の形は確かめていないので、それより前は従来どおり reporter を指定せず、集計も読まない
 */
export function readsTapSummary(version = process.versions.node) {
  return supportsTestIsolation(version);
}

/**
 * 子の node へ渡す引数。ファイル名は shell を通さず配列で渡す (ブランチ側が決めた名前なので)。
 * TAP の集計を読む版では reporter を tap にする (stdout。落ちた回の末尾にも使う)。
 * `lcovPath` を渡すとカバレッジを取り、reporter を 2 つにする — tap (読まない版では spec) は stdout、
 * lcov はそのファイルへ (`--test-reporter` と `--test-reporter-destination` は並べた順に対になる)
 */
export function nodeTestArgs(file, { version = process.versions.node, lcovPath = null } = {}) {
  const tap = readsTapSummary(version);
  let reporters = tap ? ['--test-reporter=tap'] : [];
  if (lcovPath) {
    reporters = [
      '--experimental-test-coverage',
      `--test-reporter=${tap ? 'tap' : 'spec'}`, '--test-reporter-destination=stdout',
      '--test-reporter=lcov', `--test-reporter-destination=${lcovPath}`,
    ];
  }
  return [
    '--test',
    ...(supportsTestIsolation(version) ? ['--experimental-test-isolation=none'] : []),
    ...reporters,
    file,
  ];
}

/** TAP の名前の escape (`\\` `\#` など) を外す */
function tapUnescape(name) {
  return name.replace(/\\(.)/g, '$1');
}

/** TAP の名前の escape を外し、区切りを `/` にそろえる */
function tapPath(name) {
  return tapUnescape(name).replace(/\\/g, '/');
}

/** 名前の後ろの ` # SKIP` / ` # TODO` は指示 (名前の中の # は \# に escape される) */
const TAP_DIRECTIVE = / # (?:SKIP|TODO)\b.*$/i;
const TAP_SUBTEST = /^( *)# Subtest: (.*?)\r?$/;
const TAP_RESULT = /^( *)(not ok|ok) \d+ - (.*?)\r?$/;
const TAP_TYPE = /^( *)type: '(\w+)'\r?$/;
/** TAP の入れ子は 4 字ずつの字下げ */
const TAP_INDENT = 4;

/**
 * `--test-reporter=tap` の出力から末尾の集計行を読む。**純粋**。
 *
 * 集計行 (`# tests` / `# pass` / `# fail`) はそれぞれ最後に出たものを使う (テストが stdout に書いた
 * 同じ形の行より後ろに出る)。1 つでも無ければ null — 撃った回・起動できなかった回・spec の出力。
 * `loadFailed` は、最上位 (字下げ無し) の `not ok` の名前がそのテストファイル自身のとき — 読み込みで
 * 落ちた (基点に無い src や export を import する)。Node はファイル名を cwd からの相対で、OS の区切りで書く
 *
 * @returns {{tests: number, pass: number, fail: number, loadFailed?: true}|null}
 */
export function parseTapSummary(output, file) {
  const text = String(output ?? '');
  const last = (key) => {
    let value = null;
    for (const match of text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))) value = Number(match[1]);
    return value;
  };
  const [tests, pass, fail] = ['tests', 'pass', 'fail'].map(last);
  if (tests === null || pass === null || fail === null) return null;
  const self = tapPath(String(file ?? ''));
  const loadFailed = [...text.matchAll(/^not ok \d+ - (.*?)\r?$/gm)]
    .some((match) => tapPath(match[1].replace(TAP_DIRECTIVE, '')) === self);
  return { tests, pass, fail, ...(loadFailed ? { loadFailed: true } : {}) };
}

/**
 * `--test-reporter=tap` の出力から、テスト 1 本ずつの名前と結果を読む。**純粋**。
 *
 * 名前は入れ子 (`# Subtest:` と字下げ) を親から ` > ` でつなぎ、escape を外す。数えるのは `ok` / `not ok` の行の
 * 後ろの YAML に `type:` が出たものだけ — テストが stdout に書いた同じ形の行を拾わないため。`type` は
 * `test` / `suite` (describe。集計の `# tests` には入らない)、`pass` は `ok` で指示 (SKIP / TODO) の無いもの
 * (集計の `# pass` と同じ数え方)。読み込みで落ちたファイルは、ファイル名の `not ok` が 1 本 (type は test)
 *
 * @returns {{name: string, type: string, pass: boolean}[]}
 */
export function parseTapCases(output) {
  const cases = [];
  const parents = [];
  // ok / not ok の行を読んで、YAML の type: を待っているもの
  let pending = null;
  for (const line of String(output ?? '').split('\n')) {
    const subtest = TAP_SUBTEST.exec(line);
    const result = subtest ? null : TAP_RESULT.exec(line);
    const match = subtest ?? result;
    if (match) {
      pending = null;
      if (match[1].length % TAP_INDENT !== 0) continue;
      const depth = match[1].length / TAP_INDENT;
      if (subtest) {
        parents.length = depth;
        parents[depth] = tapUnescape(subtest[2]);
      } else {
        pending = {
          indent: result[1].length,
          name: [...parents.slice(0, depth), tapUnescape(result[3].replace(TAP_DIRECTIVE, ''))].join(' > '),
          pass: result[2] === 'ok' && !TAP_DIRECTIVE.test(result[3]),
        };
      }
      continue;
    }
    const type = pending ? TAP_TYPE.exec(line) : null;
    if (type && type[1].length === pending.indent + 2) {
      cases.push({ name: pending.name, type: type[2], pass: pending.pass });
      pending = null;
    }
  }
  return cases;
}

/** 同じ名前が何本もあっても突き合わせられるように、出た順の何本目かまで含めた鍵にする */
function caseKeys(cases) {
  const seen = new Map();
  return cases.map(({ name }) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return `${name}\n${n}`;
  });
}

/**
 * task が足したテスト (HEAD にだけある名前 — 足した・改名した) のうち HEAD で通ったものが、変更前の src で
 * 落ちる / 通るを数える。**純粋**。引数はどれも parseTapCases の結果で、`head` = HEAD の回、`base` = HEAD のテストを
 * 基点の src で走らせた回、`before` = 基点の版のテストを基点の src で走らせた回 (足したファイルは `[]`)。
 * `base` に通った記録の無い名前は落ちる (読み込みで落ちた回を含む)。数えるのはテスト (suite は数えない) で、
 * 名前を変えずに中身だけ変えたテストは足したことにならない。どれか 1 つでも無ければ null (数えられない)
 *
 * @returns {{tests: number, fails: number, passes: number}|null}
 */
export function countAddedTests({ head, base, before } = {}) {
  if (!head || !base || !before) return null;
  const known = new Set(caseKeys(before));
  const baseKeys = caseKeys(base);
  const passedOnBase = new Set(baseKeys.filter((_, i) => base[i].type === 'test' && base[i].pass));
  const counts = { tests: 0, fails: 0, passes: 0 };
  caseKeys(head).forEach((key, i) => {
    if (head[i].type !== 'test' || !head[i].pass || known.has(key)) return;
    counts.tests += 1;
    if (passedOnBase.has(key)) counts.passes += 1;
    else counts.fails += 1;
  });
  return counts;
}

/**
 * task が変更したファイルから消えたテスト (前の回にあって HEAD に無い名前 — 消した・改名した) の本数。
 * countAddedTests の逆向きで **純粋**。`head` = HEAD の回、`before` = 基点の版のテストを基点の src で走らせた回
 * (足したファイルは `[]`)。数えるのは前の回のテスト (suite は数えない) で、前の回で通ったかは問わない
 * (落ちるテストを消して verify を通すのが、いちばん見たいすり抜け)。どちらか無ければ null (数えられない)
 *
 * @returns {number|null}
 */
export function countVanishedTests({ head, before } = {}) {
  if (!head || !before) return null;
  const present = new Set(caseKeys(head));
  return caseKeys(before).filter((key, i) => before[i].type === 'test' && !present.has(key)).length;
}

/**
 * task が足したテスト (HEAD にだけある名前) のうち HEAD で通った本数。src の差分が無い回 (基点の src で走らせる回が無い) の
 * countAddedTests で **純粋**。数え方は countAddedTests の `tests` と同じ。どちらか無ければ null (数えられない)
 *
 * @returns {number|null}
 */
export function countNewTests({ head, before } = {}) {
  if (!head || !before) return null;
  const known = new Set(caseKeys(before));
  return caseKeys(head).filter((key, i) => head[i].type === 'test' && head[i].pass && !known.has(key)).length;
}

/** 1 ファイル分の判定。HEAD で落ちたら基点の結果は見ない */
export function verdictFor(head, base) {
  if (!head?.ok) return 'head-fails';
  return base?.ok ? 'passes' : 'fails';
}

/** 判定ごとの本数。**純粋** */
export function summarizeRuns(runs) {
  const counts = { fails: 0, passes: 0, headFails: 0 };
  for (const run of runs ?? []) {
    if (run.verdict === 'fails') counts.fails += 1;
    else if (run.verdict === 'passes') counts.passes += 1;
    else counts.headFails += 1;
  }
  return counts;
}

/**
 * lcov の SF を作業ツリーからの相対パスにし、src/ の下だけを返す (それ以外は null)。
 * Node の lcov reporter は cwd からの相対を OS の区切りで書く (`src\a.js`) — `\` を `/` にそろえ、
 * 絶対パスで来たら root を外す (Windows のドライブ名は大小を問わない)。root の外 (`../`) は捨てる
 */
function srcRelative(sf, root) {
  let path = String(sf).trim().replace(/\\/g, '/');
  if (/^(?:[A-Za-z]:)?\//.test(path)) {
    const prefix = `${String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    const head = path.slice(0, prefix.length);
    const same = /^[A-Za-z]:\//.test(prefix) ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
    if (prefix === '/' || !same) return null;
    path = path.slice(prefix.length);
  }
  path = path.replace(/^\.\//, '');
  return path.startsWith('src/') ? path : null;
}

function coverageEntry(files, path) {
  if (!files.has(path)) files.set(path, { lines: new Set(), covered: new Set() });
  return files.get(path);
}

/**
 * lcov を src/ のファイルごとの行に読む。**純粋**。`lines` は DA に出た行 (Node は空行やコメントも含めて
 * 全行を出す = 全行)、`covered` は回数 > 0 の行。同じファイルの記録が何度出ても和集合を取る
 *
 * @returns {Map<string, {lines: Set<number>, covered: Set<number>}>}
 */
export function parseLcov(text, { root = '' } = {}) {
  const files = new Map();
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('SF:')) {
      const path = srcRelative(line.slice(3), root);
      current = path ? coverageEntry(files, path) : null;
    } else if (line === 'end_of_record') {
      current = null;
    } else if (current && line.startsWith('DA:')) {
      const [lineNo, count] = line.slice(3).split(',').map(Number);
      if (!Number.isInteger(lineNo)) continue;
      current.lines.add(lineNo);
      if (count > 0) current.covered.add(lineNo);
    }
  }
  return files;
}

/** テストごとの parseLcov の和集合 (覆った行は、どれか 1 本でも覆えば覆った)。**純粋** */
export function unionCoverage(maps) {
  const union = new Map();
  for (const files of maps ?? []) {
    for (const [path, { lines, covered }] of files) {
      const entry = coverageEntry(union, path);
      for (const lineNo of lines) entry.lines.add(lineNo);
      for (const lineNo of covered) entry.covered.add(lineNo);
    }
  }
  return union;
}

/**
 * 後の回にだけ覆われた src の行の数 (ファイルごとの覆った行の**集合の差**を足したもの)。**純粋**。
 * 行数の差ではないので、前に覆った行を外して別の行を覆った回も 0 にならない。引数はどちらも parseLcov の結果
 */
export function countNewlyCovered(before, after) {
  let count = 0;
  for (const [path, { covered }] of after) {
    const known = before.get(path)?.covered;
    for (const lineNo of covered) if (!known?.has(lineNo)) count += 1;
  }
  return count;
}

const coverageStat = (entry) => (entry ? { covered: entry.covered.size, total: entry.lines.size } : null);
const coveredDelta = (file) => Math.abs((file.after?.covered ?? 0) - (file.before?.covered ?? 0));

/**
 * 前後を突き合わせて出すファイルを選ぶ。**純粋**。
 * 出すのは「task が触った src」∪「覆った行数が変わった src」で、覆った行数の差が大きい順 (同じなら名前順)。
 * `before` / `after` が null = その回のテストが読み込まなかった — 触ったのに前後とも null の src は
 * 変更したテストが届いていない印なので、差が 0 でも残す
 *
 * @returns {{path: string, before: {covered: number, total: number}|null, after: {covered: number, total: number}|null}[]}
 */
export function compareCoverage(before, after, touched = []) {
  const paths = new Set(touched);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(path)?.covered.size ?? 0) !== (after.get(path)?.covered.size ?? 0)) paths.add(path);
  }
  return [...paths]
    .map((path) => ({ path, before: coverageStat(before.get(path)), after: coverageStat(after.get(path)) }))
    .sort((a, b) => coveredDelta(b) - coveredDelta(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `@@ -a,b +c,d @@` の `+c,d` (d の省略は 1) */
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const GIT_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * git が `"…"` で引用したパス (core.quotePath: 非 ASCII は 8 進のバイト、`"` `\` と制御文字は `\` 付き) を
 * 元に戻す。引用されていなければそのまま
 */
function unquoteGitPath(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes = [];
  for (let i = 0; i < inner.length;) {
    if (inner[i] === '\\') {
      const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
      const next = inner[i + 1] ?? '';
      if (octal) bytes.push(parseInt(octal[0], 8));
      else bytes.push(GIT_ESCAPES[next] ?? next.charCodeAt(0));
      i += octal ? 4 : 2;
      continue;
    }
    const ch = String.fromCodePoint(inner.codePointAt(i));
    bytes.push(...encoder.encode(ch));
    i += ch.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * `git diff -U0` の出力から、HEAD の側で足した・変えた行の番号をファイルごとに読む。**純粋**。
 * 読むのは `@@` の `+c,d` だけ (c から d 行。d の省略は 1、`+c,0` は消しただけで行なし)。足したファイル (A) は
 * `+1,N` で全行になり、消したファイル (`+++ /dev/null`) と行の無いファイルは出さない。パスは `+++ b/…` から取る
 * (`diff --git` の行は空白入りのパスで切れ目が曖昧) — 本文の `+` 行 (`++x` を足した行は `+++x` になる) と取り違えない
 * よう、`diff --git` の後・最初の `@@` より前だけで読む。src/diffs.js の parseUnifiedDiff は使わない (CR や mode の
 * 変更を含む diff を丸ごと断る関門用)
 *
 * @returns {Map<string, number[]>}
 */
export function parseChangedLines(text) {
  const files = new Map();
  let inHeader = false;
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith('+++ ')) {
      // 空白入りのパスは後ろにタブが付く
      const name = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      current = name.startsWith('b/') ? name.slice(2) : null;
    } else {
      const hunk = DIFF_HUNK.exec(line);
      if (!hunk) continue;
      inHeader = false;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (!current || count === 0) continue;
      if (!files.has(current)) files.set(current, []);
      for (let lineNo = start; lineNo < start + count; lineNo += 1) files.get(current).push(lineNo);
    }
  }
  return files;
}

/** 行番号を続いた範囲 `[from, to]` に畳む */
function lineRanges(numbers) {
  const ranges = [];
  for (const lineNo of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && lineNo === last[1] + 1) last[1] = lineNo;
    else ranges.push([lineNo, lineNo]);
  }
  return ranges;
}

/**
 * task が変えた src の行のうち、変更したテストが通らない行。**純粋**。`changed` は parseChangedLines の結果、
 * `after` は HEAD の回の parseLcov (テストごとの和集合)。数えるのは lcov の DA に出た行 (実行行) だけ — HEAD の lcov に
 * 無いファイル (変更したテストが読み込まない。カバレッジの段の `なし` が印) と、変えた実行行の無いファイルは出さない。
 * 通らない行の多い順 (同じなら名前順)
 *
 * @returns {{path: string, changed: number, untested: number, ranges: [number, number][]}[]}
 */
export function findUntestedLines(changed, after) {
  const rows = [];
  for (const [path, numbers] of changed) {
    const entry = after.get(path);
    if (!entry) continue;
    const executable = numbers.filter((lineNo) => entry.lines.has(lineNo));
    if (executable.length === 0) continue;
    const untested = executable.filter((lineNo) => !entry.covered.has(lineNo));
    rows.push({ path, changed: executable.length, untested: untested.length, ranges: lineRanges(untested) });
  }
  return rows.sort((a, b) => b.untested - a.untested || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 覆った行 / 全行 (%)。% は切り捨て (100% は全部覆ったときだけ) */
function formatCoverageStat(stat) {
  if (!stat) return 'なし';
  const percent = stat.total > 0 ? Math.floor((stat.covered / stat.total) * 100) : 0;
  return `${stat.covered}/${stat.total} (${percent}%)`;
}

/** カバレッジの行。結果に coverage が無ければ何も足さない */
function formatCoverage(coverage, testCount) {
  if (!coverage) return [];
  if (!coverage.supported) return [`カバレッジは測れない (Node v${coverage.node})`];
  const files = coverage.files ?? [];
  const head = `カバレッジ (変更したテスト ${testCount} 本だけで測った src の覆った行 / 全行 — 全スイートではない。`
    + '前 = 基点の src と基点の版のテスト、後 = HEAD、なし = 読み込まれない)';
  if (files.length === 0) return [`${head}: 触った src も覆った行数が変わった src も無い`];
  const lines = [
    `${head}:`,
    ...files.slice(0, COVERAGE_SHOWN)
      .map((file) => `${file.path} ${formatCoverageStat(file.before)} → ${formatCoverageStat(file.after)}`),
  ];
  if (files.length > COVERAGE_SHOWN) lines.push(`ほか ${files.length - COVERAGE_SHOWN} ファイル`);
  return lines;
}

/**
 * ファイルの中の本数の行 (HEAD と基点の両方に TAP の集計がある回だけ。HEAD でも落ちるファイルは出さない)。
 * 落ちる / 通るは HEAD で通った本数を分けたもの — 通る = 基点で通った本数、落ちる = 残り (集計の fail は
 * 親と子を両方数え・取り消し (cancelled) を数えないので、足しても HEAD の本数にならない)。
 * 足したテストを数えられたファイル (run の `added`) は、そのうち通る本数を括弧で添える。
 * 落ちない本数 (足したテストを数えられたファイルは、足したテストのうち通る本数) の多い順 (同じなら落ちない本数の
 * 多い順・名前順) に `limit` 件 (既定 5)、残りは件数 (畳んだ中に読み込めずがあれば「(うち基点で読み込めず k)」を添える)。
 * `shown` は行を出したファイル
 *
 * @returns {{lines: string[], shown: Set<string>}}
 */
function formatTestCounts(runs, limit = TEST_COUNTS_SHOWN) {
  const suspect = (row) => row.added?.passes ?? row.passes;
  const counted = (runs ?? [])
    .filter((run) => run.verdict !== 'head-fails' && run.head?.tap && run.base?.tap)
    .map((run) => {
      const headPass = run.head.tap.pass;
      const loadFailed = run.base.tap.loadFailed === true;
      const passes = loadFailed ? 0 : Math.min(run.base.tap.pass, headPass);
      return { file: run.file, headPass, loadFailed, passes, added: run.added ?? null };
    })
    .sort((a, b) => suspect(b) - suspect(a) || b.passes - a.passes || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shownRuns = counted.slice(0, limit);
  // 足したテストの落ちる本数は書かない (足した本数 − 通る で分かる)。3 桁の本数でも 5 行が上限 1200 字に収まるように
  const addedText = ({ tests, passes }) => (tests === 0 ? ' (足した 0 本)' : ` (足した ${passes}/${tests} 通る)`);
  const lines = shownRuns.map(({ file, headPass, loadFailed, passes, added }) => (loadFailed
    ? `${file}: 基点で読み込めず (HEAD で通る ${headPass} 本${added ? `のうち 足した ${added.tests} 本` : ''})`
    : `${file}: HEAD で通る ${headPass} 本のうち 変更前の src で落ちる ${headPass - passes}・通る ${passes}`
      + (added ? addedText(added) : '')));
  // 読み込めずは並びの最後に回るので、畳んだ中にあれば本数を添える (畳み切った形でも読み戻せるように)
  const folded = counted.slice(limit);
  const foldedLoadFailed = folded.filter((row) => row.loadFailed).length;
  if (folded.length > 0) {
    lines.push(`ほか ${folded.length} ファイル${foldedLoadFailed > 0 ? ` (うち基点で読み込めず ${foldedLoadFailed})` : ''}`);
  }
  return { lines, shown: new Set(shownRuns.map(({ file }) => file)) };
}

/**
 * src の差分が無い回の、変更したテストファイルごとの行 (`testFiles` は measureReviewEvidence の no-src の結果)。
 * 足した本数と新たに覆った src の行を出し、足したテストファイルは行数の代わりに「新しいファイル」と書く
 * (前の回が無いので、読み込むだけで覆う行まで新たに覆った行に入って膨らむ)。数えられなかった側は書かず、
 * 両方とも無いファイルは行を出さない。既に覆われた行をなぞるだけのテストを先に見せるため、新たに覆った行の少ない順
 * (同じなら足した本数の多い順・名前順)、行数の無いファイルはその後ろに名前順で `limit` 件 (既定 5)、残りは件数
 */
function formatTestFiles(testFiles, limit = TEST_COUNTS_SHOWN) {
  const byName = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const measured = (row) => Number.isInteger(row.newLines);
  const rows = (testFiles ?? [])
    .filter((row) => row.newFile || measured(row) || Number.isInteger(row.addedTests))
    .sort((a, b) => Number(measured(b)) - Number(measured(a))
      || (measured(a) && measured(b) ? a.newLines - b.newLines || (b.addedTests ?? -1) - (a.addedTests ?? -1) : 0)
      || byName(a, b));
  const lines = rows.slice(0, limit).map((row) => {
    const parts = [
      ...(Number.isInteger(row.addedTests) ? [`足した ${row.addedTests} 本`] : []),
      ...(row.newFile ? ['新しいファイル'] : measured(row) ? [`新たに覆った src 行 ${row.newLines}`] : []),
    ];
    return `${row.file}: ${parts.join('・')}`;
  });
  if (rows.length > limit) lines.push(`ほか ${rows.length - limit} ファイル`);
  return lines;
}

/**
 * 消したテストの行 (どちらも無ければ null)。消したファイル (D) の本数と名前、名前が消えたファイル (`vanished` は
 * 0 本を除いて並べたもの) の合計と、ファイルごとの本数。`shown` はそれぞれ名前を出す数で、残りは「ほか n」で畳む
 */
function formatDeletedTests(deleted, vanished, shown) {
  const parts = [];
  if (deleted.length > 0) {
    const names = deleted.slice(0, shown.deleted);
    const rest = deleted.length - names.length;
    const list = names.length > 0 ? ` (${names.join(', ')}${rest > 0 ? ` ほか ${rest}` : ''})` : '';
    parts.push(`ファイル ${deleted.length}${list}`);
  }
  if (vanished.length > 0) {
    const total = vanished.reduce((sum, { tests }) => sum + tests, 0);
    const named = vanished.slice(0, shown.vanished).map(({ file, tests }) => `${file} ${tests}`);
    const rest = vanished.length - named.length;
    const list = named.length > 0 ? `${named.join(', ')}${rest > 0 ? ` ほか ${rest} ファイル` : ''}` : `${rest} ファイル`;
    parts.push(`消えた名前 ${total} 本 (${list})`);
  }
  return parts.length > 0 ? `消したテスト: ${parts.join('・')}` : null;
}

/**
 * 基点で走り切らなかったファイルの行 (無ければ null)。`unfinished` は「落ちる」に数えた回のうち、基点の回が
 * 時間切れ・起動失敗で終わったもの (テストの結果ではない)。`shown` 件に理由 (基点の回の error) を添え、残りは
 * 「ほか n ファイル」、0 件に畳んだら本数だけ
 */
function formatUnfinished(unfinished, shown) {
  if (unfinished.length === 0) return null;
  const named = unfinished.slice(0, shown).map(({ file, reason }) => `${file} (${reason})`);
  const rest = unfinished.length - named.length;
  const list = named.length > 0 ? `${named.join(', ')}${rest > 0 ? ` ほか ${rest} ファイル` : ''}` : `${rest} ファイル`;
  return `基点で走り切らず: ${list}`;
}

const formatRange = ([from, to]) => (from === to ? `L${from}` : `L${from}-${to}`);

/**
 * 変えた行の段 (coverage.changed の行)。`shown.files` 件の src に、通らない行の範囲を `shown.ranges` 個まで添え、
 * 残りは「ほか n 範囲」「ほか n ファイル」。範囲を 0 個に畳んだ src は本数だけ
 */
function formatUntestedLines(changed, shown) {
  const lines = changed.slice(0, shown.files).map(({ path, changed: total, untested, ranges }) => {
    const listed = ranges.slice(0, shown.ranges).map(formatRange);
    const rest = ranges.length - listed.length;
    const list = listed.length > 0 ? ` (${listed.join(', ')}${rest > 0 ? ` ほか ${rest} 範囲` : ''})` : '';
    return `${path}: 変えた実行行 ${total} のうち通らない ${untested}${list}`;
  });
  if (changed.length > shown.files) lines.push(`ほか ${changed.length - shown.files} ファイル`);
  return lines;
}

/** 変えた行の段の畳み方を細かい順に: 範囲を 1 つずつ減らし、尽きたら src を 1 件ずつ減らす (1 件は残す) */
function* untestedFoldSteps(changed) {
  const ranges = Math.min(RANGES_SHOWN, Math.max(0, ...changed.map((row) => row.ranges.length)));
  for (let files = Math.min(changed.length, UNTESTED_SHOWN); files >= Math.min(changed.length, 1); files -= 1) {
    for (let r = ranges; r >= 0; r -= 1) yield { files, ranges: r };
  }
}

/** 基点で走り切らなかったファイルの行の畳み方を細かい順に: 名前を 1 つずつ減らす */
function* unfinishedFoldSteps(count) {
  for (let shown = Math.min(count, UNFINISHED_SHOWN); shown >= 0; shown -= 1) yield shown;
}

/** 消したテストの行の畳み方を細かい順に: 消したファイルの名前を 1 つずつ減らし、尽きたら名前が消えたファイルを減らす */
function* deletedFoldSteps(deleted, vanished) {
  let d = Math.min(deleted, DELETED_SHOWN);
  let v = Math.min(vanished, VANISHED_SHOWN);
  for (;;) {
    yield { deleted: d, vanished: v };
    if (d > 0) d -= 1;
    else if (v > 0) v -= 1;
    else return;
  }
}

/**
 * 人が読む形 (レビューの召喚文や note に貼れる短さ)。**純粋**。
 * src 差分なし・テスト変更なし・停止は 1 行で、相手側の数を添える。測った回は 2 行目からファイルの中の本数、
 * 本数の行に出なかった落ちないファイルの名前を足す (本数の行がある落ちないファイルは「落ちる 0」で分かるので
 * 名前を重ねない — 上限 1200 字に収めるため)。「落ちる」に数えたファイルのうち基点の回が時間切れ・起動失敗で
 * 終わったもの (集計が無いので本数の行に出ない) は、その後ろに「基点で走り切らず: 名前 (理由)」を 1 行足す
 * (1 行目の数え方は変えない)。src 差分なしでテストを走らせた回は、2 行目から変更したテストファイル
 * ごとの足した本数と新たに覆った src の行を足す (1 行目は変えない)。カバレッジを測った回はその後ろに前後を足す。
 * task が消したテスト (消したファイル・変更したファイルから消えた名前) があれば、カバレッジの前に 1 行足す
 * (差分なし・テストなしでも)。その行は上限に収まるまで名前を「ほか n」で畳み、畳み切っても収まらなければ
 * 本数の行を 1 件ずつ畳む — カバレッジの段 (末尾) は削らない。差分なしのファイルの行は、消したテストが無くても上限に
 * 収まるまで 1 件ずつ畳む。カバレッジに変えた行 (`coverage.changed`) があれば、カバレッジの段の前に src ごとの
 * 「変えた実行行 N のうち通らない k (L120-125, L140)」を足し、消したテストの名前 → 基点で走り切らなかったファイルの
 * 名前の次に範囲 → src (1 件は残す) の順で畳む。
 */
export function formatReviewEvidence(result) {
  if (result?.outcome === 'refused') return `断りました: ${result.reason}`;
  const where = `基点 ${String(result?.mergeBase ?? '').slice(0, 7)} (${result?.base})`;
  if (result?.outcome === 'stopped') {
    // 測り始める前に止まった回は予定も基点も無い — 無いものは省く
    const facts = [
      ...(Number.isInteger(result.planned) ? [`走らせたテスト ${result.ran ?? 0} / 予定 ${result.planned} 回`] : []),
      ...(result.mergeBase ? [where] : []),
    ];
    return `停止で中断 — src と test/ は HEAD へ戻した${facts.length > 0 ? ` (${facts.join('・')})` : ''}`;
  }
  const srcCount = (result?.src?.added?.length ?? 0) + (result?.src?.restored?.length ?? 0);
  const testCount = result?.tests?.length ?? 0;
  let first;
  // 1 行目の後ろの本数の行 (測った回だけ)。引数は本数の行を出す件数
  let middle = null;
  // 「落ちる」に数えたが、基点の回が時間切れ・起動失敗で終わったファイル (停止で撃った回は runs に入らない)
  let unfinished = [];
  if (result?.outcome === 'no-src') {
    first = `src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト ${testCount} 本・${where})`;
    if (result.testFiles) middle = (limit) => formatTestFiles(result.testFiles, limit);
  } else if (result?.outcome === 'no-tests') {
    first = `変更したテストなし — 変更前の src で走らせるものが無い (src の差分 ${srcCount} ファイル・${where})`;
  } else {
    const c = result?.counts ?? summarizeRuns(result?.runs);
    first = `変更前の src で落ちる ${c.fails} / 落ちない ${c.passes} / HEAD でも落ちる ${c.headFails}`
      + ` (変更したテスト ${testCount} 本・src の差分 ${srcCount} ファイル・${where})`;
    middle = (limit) => {
      const counts = formatTestCounts(result?.runs, limit);
      const passes = (result?.runs ?? [])
        .filter((run) => run.verdict === 'passes' && !counts.shown.has(run.file))
        .map((run) => run.file);
      return [...counts.lines, ...(passes.length > 0 ? [`落ちない: ${passes.join(', ')}`] : [])];
    };
    unfinished = (result?.runs ?? [])
      .filter((run) => run.verdict === 'fails' && typeof run.base?.error === 'string')
      .map((run) => ({ file: run.file, reason: run.base.error }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
  const coverage = formatCoverage(result?.coverage, testCount);
  const changed = result?.coverage?.supported ? result.coverage.changed ?? [] : [];
  const build = (rows, unfinishedLine, deletedLine, untestedLines) => [
    first, ...rows, ...(unfinishedLine ? [unfinishedLine] : []), ...(deletedLine ? [deletedLine] : []),
    ...untestedLines, ...coverage,
  ].join('\n');
  const deleted = result?.deletedTests ?? [];
  const vanished = (result?.vanishedTests ?? [])
    .filter(({ tests }) => tests > 0)
    .sort((a, b) => b.tests - a.tests || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // 差分なしのファイルの行はパスの長さしだいで 5 件でも上限を超えるので、消したテストが無くても畳む
  const foldRows = result?.outcome === 'no-src' && middle !== null;
  if (deleted.length === 0 && vanished.length === 0 && changed.length === 0 && unfinished.length === 0 && !foldRows) {
    return build(middle?.(TEST_COUNTS_SHOWN) ?? [], null, null, []);
  }
  const lowest = middle ? 0 : TEST_COUNTS_SHOWN;
  let text = '';
  // 畳む順は内側から: 消したテストの名前 → 基点で走り切らなかったファイルの名前 → 変えた行の段の範囲 → その段の src
  // → 本数の行
  for (let limit = TEST_COUNTS_SHOWN; limit >= lowest; limit -= 1) {
    const rows = middle?.(limit) ?? [];
    for (const untested of untestedFoldSteps(changed)) {
      const untestedLines = formatUntestedLines(changed, untested);
      for (const named of unfinishedFoldSteps(unfinished.length)) {
        const unfinishedLine = formatUnfinished(unfinished, named);
        for (const shown of deletedFoldSteps(deleted.length, vanished.length)) {
          text = build(rows, unfinishedLine, formatDeletedTests(deleted, vanished, shown), untestedLines);
          if (text.length <= EVIDENCE_MAX_CHARS) return text;
        }
      }
    }
  }
  // 畳み切っても収まらない (1 行目やカバレッジだけで上限に近い) — いちばん畳んだ形を返し、切るのは呼び手に任せる
  return text;
}

/**
 * 1 行目の形 (formatReviewEvidence の対)。`測れませんでした — ` はここではなくブリッジが書く
 * (src/bridge/board.js の collectReviewEvidence。字面は test/bridge-board.test.js が固定している)
 */
const EVIDENCE_FIRST_LINES = [
  {
    kind: 'measured',
    pattern: /^変更前の src で落ちる (\d+) \/ 落ちない (\d+) \/ HEAD でも落ちる (\d+) \(変更したテスト (\d+) 本・src の差分 (\d+) ファイル・/,
    read: ([fails, passes, headFails, tests, srcFiles]) => ({ fails, passes, headFails, tests, srcFiles }),
  },
  { kind: 'no-src', pattern: /^src の差分なし — .*\(変更したテスト (\d+) 本・/, read: ([tests]) => ({ tests }) },
  { kind: 'no-tests', pattern: /^変更したテストなし — .*\(src の差分 (\d+) ファイル・/, read: ([srcFiles]) => ({ srcFiles }) },
  { kind: 'unmeasured', pattern: /^(?:測れませんでした — |断りました: |停止で中断 — )/, read: () => ({}) },
];

/**
 * 消したテストの行の本数 (formatDeletedTests の対)。本数は名前の前に出るので、名前を「ほか n」で畳んだ形でも読める。
 * 後ろの区切りまで見るのは、上限で切られた行 (`ファイル 1…`) を別の本数に読まないため
 */
const DELETED_LINE_HEAD = '消したテスト: ';
const DELETED_FILES = /^消したテスト: ファイル (\d+)(?= \(|・|$)/;
const VANISHED_NAMES = /(?:^消したテスト: |・)消えた名前 (\d+) 本 \(/;

/**
 * 本数の行のうち基点で読み込めずの行と、その段の畳んだ行 (formatTestCounts の対)。畳んだ行は閉じ括弧まで見る —
 * 他の段の「ほか n ファイル」には添え書きが無く、上限で切られた行 (`読み込めず 1…`) を別の本数に読まないため
 */
const LOAD_FAILED_ROW = /^.+?: 基点で読み込めず \(/;
const LOAD_FAILED_FOLDED = /^ほか \d+ ファイル \(うち基点で読み込めず (\d+)\)$/;

/**
 * レビューの証拠 (formatReviewEvidence の出力、または測れなかった回の行) の 1 行目を、種類と本数へ
 * 読み戻す。**純粋**。種類は measured / no-src / no-tests / unmeasured (測れず・断り・停止で中断) / unknown (読めない)。
 * 本数は種類ごとに 1 行目に出ているものだけ (measured は fails / passes / headFails / tests / srcFiles)。
 * measured には、基点で読み込めずのファイル数 `loadFailedFiles` (本数の行の読み込めずの行 + 畳んだ行の k。
 * 無ければ 0) も付ける。
 * 2 行目以降に消したテストの行があれば、消したファイルの本数 `deletedFiles` と消えた名前の本数 `vanishedNames`
 * (行に無い側は 0) も返す。行が無い証拠と unknown には付けない
 *
 * @returns {{kind: string, fails?: number, passes?: number, headFails?: number, tests?: number, srcFiles?: number, loadFailedFiles?: number, deletedFiles?: number, vanishedNames?: number}}
 */
export function parseReviewEvidence(text) {
  const [head, ...rest] = String(text ?? '').split('\n');
  const first = head.trim();
  for (const { kind, pattern, read } of EVIDENCE_FIRST_LINES) {
    const match = pattern.exec(first);
    if (!match) continue;
    const loadFailed = kind === 'measured' ? { loadFailedFiles: countLoadFailed(rest) } : {};
    return { kind, ...read(match.slice(1).map(Number)), ...loadFailed, ...readDeletedLine(rest) };
  }
  return { kind: 'unknown' };
}

/** 基点で読み込めずのファイル数 (読み込めずの行の数 + 畳んだ行の k。旧い形の畳んだ行には k が無いので行だけ) */
function countLoadFailed(lines) {
  let count = 0;
  for (const line of lines.map((item) => item.trim())) {
    if (LOAD_FAILED_ROW.test(line)) count += 1;
    const folded = LOAD_FAILED_FOLDED.exec(line);
    if (folded) count += Number(folded[1]);
  }
  return count;
}

/** 消したテストの行の本数 (行が無い・どちらの本数も読めなければ空) */
function readDeletedLine(lines) {
  const line = lines.map((item) => item.trim()).find((item) => item.startsWith(DELETED_LINE_HEAD));
  if (!line) return {};
  const files = DELETED_FILES.exec(line);
  const names = VANISHED_NAMES.exec(line);
  if (!files && !names) return {};
  return { deletedFiles: files ? Number(files[1]) : 0, vanishedNames: names ? Number(names[1]) : 0 };
}

/**
 * テスト 1 ファイルを `node --test` で走らせる。タイムアウトは verify と同じ既定値で、撃つときはツリーごと。
 *
 * `coverage` なら lcov を mkdtemp の一時ファイルへ出させて中身を `lcov` に返す (撃った回などで
 * ファイルが無ければ null)。一時ディレクトリは finally で消す
 *
 * `handle` は runVerify と同じ形で省略できる。始めから stopRequested なら起動せず、走っている間に
 * `handle.abort()` が来たら子をツリーごと撃って `aborted: true` で返す
 *
 * TAP の集計を読む版 (`nodeVersion` は走らせる node = 自分の版) では、最後まで走った回に `tap`
 * (parseTapSummary の結果) を付ける。集計行が無い回 (撃った・起動できなかった) には付けない。
 * `tap` を付けた回には、テスト 1 本ずつの `tapCases` (parseTapCases の結果) も付ける — ただし stdout が
 * 上限を超えた回は頭が欠けて名前を取りこぼすので付けない
 *
 * 時間切れ・起動失敗・走っている間の停止で終わった回には、その理由 (`timeout after …ms` / `spawn failed: …` /
 * 停止) を `error` に付ける (終了コードで終わった回には付けない)
 *
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean, aborted?: true, durationMs: number, error?: string, tail?: string, lcov?: string|null, tap?: {tests: number, pass: number, fail: number, loadFailed?: true}, tapCases?: {name: string, type: string, pass: boolean}[]}>}
 */
export async function runTestFile({
  cwd,
  file,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  env = process.env,
  spawnImpl = spawn,
  coverage = false,
  handle,
  nodeVersion = process.versions.node,
}) {
  // 一時ディレクトリも作らない (runVerify の入口と同じ)
  if (handle?.stopRequested) {
    return { ok: false, code: null, timedOut: false, aborted: true, durationMs: 0, tail: STOPPED_ERROR };
  }
  const spawnOptions = { cwd, timeoutMs, env, spawnImpl, handle, tapFile: readsTapSummary(nodeVersion) ? file : null };
  if (!coverage) return spawnTest({ ...spawnOptions, args: nodeTestArgs(file, { version: nodeVersion }) });
  const dir = mkdtempSync(join(tmpdir(), 'communitd-lcov-'));
  const lcovPath = join(dir, 'lcov.info');
  try {
    const result = await spawnTest({ ...spawnOptions, args: nodeTestArgs(file, { version: nodeVersion, lcovPath }) });
    let lcov = null;
    try {
      lcov = readFileSync(lcovPath, 'utf8');
    } catch {
      // 撃った・起動できなかった回は書かれない — その回のカバレッジが無いだけ
    }
    return { ...result, lcov };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 撃った子が掴んだままだと Windows では消せない。一時ファイルが残るだけなので測定は止めない
    }
  }
}

/** `tapFile` = TAP の集計を読むテストファイル (読まない版では null) */
function spawnTest({ cwd, args, timeoutMs, env, spawnImpl, handle, tapFile }) {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let output = '';
    // テスト 1 本ずつの名前は stdout だけから読む (stderr が行の途中に挟まらない)。上限を超えたら読まない
    let stdout = '';
    let stdoutOverflow = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    const finish = ({ code = null, error = '' } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ok = !timedOut && !aborted && !error && code === 0;
      // 撃った回は集計行が出ていても途中の数なので読まない
      const tap = tapFile && !timedOut && !aborted && !error ? parseTapSummary(output, tapFile) : null;
      const tapCases = tap && !stdoutOverflow ? parseTapCases(stdout) : null;
      resolvePromise({
        ok,
        code,
        // 停止が立っていれば、後からタイムアウトが来ても停止として返す (runVerify と同じ)
        timedOut: timedOut && !aborted,
        ...(aborted ? { aborted: true } : {}),
        durationMs: Date.now() - startedAt,
        ...(tap ? { tap } : {}),
        ...(tapCases ? { tapCases } : {}),
        // 走り切らなかった理由 (時間切れ・起動失敗・停止)。tail の頭にも入るが、tail は末尾の行だけなので落ちうる
        ...(error ? { error } : {}),
        ...(ok ? {} : {
          tail: tailText([error, output.replace(COVERAGE_REPORT, '')].filter(Boolean).join('\n') || '(出力なし)', {
            maxLines: FAILURE_TAIL_LINES,
            maxChars: FAILURE_TAIL_CHARS,
          }),
        }),
      });
    };

    let child;
    try {
      child = spawnImpl(process.execPath, args, {
        cwd,
        env: scrubEnv(env, TEST_RUNNER_ENV_KEYS),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...detachOption(),
      });
    } catch (err) {
      finish({ error: `spawn failed: ${err.message}` });
      return;
    }
    const append = (chunk) => {
      output += chunk;
      if (output.length > OUTPUT_MAX_CHARS) output = output.slice(-OUTPUT_MAX_CHARS);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      append(chunk);
      if (!tapFile || stdoutOverflow) return;
      stdout += chunk;
      if (stdout.length > OUTPUT_MAX_CHARS) {
        stdoutOverflow = true;
        stdout = '';
      }
    });
    child.stderr.on('data', append);
    const killed = () => ({ error: aborted ? STOPPED_ERROR : `timeout after ${timeoutMs}ms` });
    // 孫が stdout を握ったまま close が来なくても返る (runVerify と同じ保険)。停止でもタイムアウトでも張る
    const finishWithoutClose = () => {
      setTimeout(() => finish(killed()), VERIFY_KILL_GRACE_MS).unref?.();
    };
    // 子が走っている間の停止 (src/verify.js の runVerify と同じ)。終わった後に呼ばれても
    // stopRequested を立てるだけ — 次のファイルの前に runAll がそれを見る
    if (handle) {
      handle.abort = () => {
        handle.stopRequested = true;
        if (!settled) {
          aborted = true;
          killTree(child);
          finishWithoutClose();
        }
      };
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finishWithoutClose();
    }, timeoutMs);
    child.on('error', (err) => finish({ error: `spawn failed: ${err.message}` }));
    child.on('close', (code) => finish(aborted || timedOut ? killed() : { code }));
  });
}

function porcelainLines(stdout) {
  return String(stdout ?? '').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
}

/**
 * 1 ファイルずつ走らせる。各ファイルの前に停止を見て、立っていれば残りを走らせない。撃たれた回 (aborted) も
 * そこで止める。`runs` は最後まで走った回だけ (撃たれた回は入れない)、`stopped` は残りを走らせなかったか
 */
async function runAll(tests, { root, runTest, timeoutMs, coverage, handle }) {
  const runs = [];
  for (const file of tests) {
    if (handle?.stopRequested) return { runs, stopped: true };
    const run = await runTest({ cwd: root, file, timeoutMs, coverage, handle });
    if (run?.aborted) return { runs, stopped: true };
    runs.push(run);
  }
  return { runs, stopped: false };
}

/** テストごとの lcov の和集合 */
function coverageOf(runs, root) {
  return unionCoverage((runs ?? []).map((run) => parseLcov(run?.lcov, { root })));
}

/**
 * 結果に lcov の生テキストとテスト 1 本ずつの記録を持ち回らない (`--json` とレビューの依頼に載るのは
 * 整えた前後と、足したテストの本数だけ)
 */
function withoutRaw(run) {
  const copy = { ...run };
  delete copy.lcov;
  delete copy.tapCases;
  return copy;
}

/**
 * src と test を HEAD へ戻し、src/ と test/ が clean に戻ったかを確かめる。戻らなければその様子を返す。
 *
 * `--no-overlay` が要る: 既定 (overlay) の checkout は HEAD に無いパスを消さないので、基点から
 * 戻した D のファイルが staged の追加として残る。A のファイル (git rm したもの) は HEAD の木に
 * あるので、同じ 1 回で戻る — 「`git checkout HEAD -- src` と追加ファイルの復元」をこれで兼ねる。
 * ディレクトリごとに打つのは、HEAD に無いほう (src/ の無いリポジトリなど) の pathspec の失敗で
 * もう片方まで戻らなくならないように
 */
async function restoreSrc(root, git) {
  let checkoutError = null;
  for (const dir of ['src', 'test']) {
    try {
      await git(root, ['checkout', '--no-overlay', 'HEAD', '--', dir]);
    } catch (err) {
      checkoutError ??= err;
    }
  }
  try {
    const left = porcelainLines(await git(root, ['status', '--porcelain', '--', 'src', 'test']));
    if (left.length === 0) return null;
    return `src/ と test/ に ${left.length} 件残っています: ${left.slice(0, 10).join(' / ')}`
      + (checkoutError ? ` (checkout の失敗: ${checkoutError.message})` : '');
  } catch (err) {
    return `git status を読めません: ${err.message}`
      + (checkoutError ? ` (checkout の失敗: ${checkoutError.message})` : '');
  }
}

/**
 * task が変えた src の行を読む `git diff` (parseChangedLines へ渡す)。基点と HEAD の commit どうしの差なので、
 * src を戻し終えた後に打っても作業ツリーの状態に依らない。設定で形が変わらないように打ち消す:
 * diff.interHunkContext (間の文脈行で hunk がつながり、変えていない行が `+c,d` に入る)・diff.noprefix /
 * diff.mnemonicPrefix (`b/` 以外の接頭辞)・色・外部 diff・textconv・rename
 */
function changedLinesArgs(mergeBase) {
  return [
    'diff', '-U0', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, 'HEAD', '--', 'src',
  ];
}

/**
 * task の作業ツリーで、変更したテストが変更前の src で落ちるかを測る。
 *
 * 返すのは `outcome` 付きの結果: `measured` / `no-src` / `no-tests` / `refused` (門で断った・何も触っていない) /
 * `stopped` (handle の停止で中断した。`ran` = 最後まで走ったテストの回数 (撃った回は数えない)、
 * `planned` = 予定の回数。測り始める前に止まった回は基点も予定も持たない)。
 * `measured` と、変更したテストがある `no-src` には `coverage` が付く (lcov の reporter の無い Node では
 * `{supported: false, node}`)。`measured` の `coverage` には、HEAD の回に lcov があれば `changed` (findUntestedLines の
 * 結果 — 変えた src の行のうち変更したテストが通らない行。git diff を 1 回足すだけで走らせる回は増えない) も付く。
 * `measured` の `runs` の head / base は runTestFile の結果で、TAP の集計を読む版なら
 * `tap` (ファイルの中の本数) が付き、足したテストを数えられたファイルの run には `added` (countAddedTests の結果) が
 * 付く。どの結果にも `deletedTests` (差分で消した *.test.js。走らせない) が付き、`measured` と測った `no-src` には
 * `vanishedTests` (名前を突き合わせられた変更したファイルごとの、消えたテストの本数 `{file, tests}`) が付く。
 * 測った `no-src` には `testFiles` (変更したテストファイルごとの `{file, addedTests, newLines}` — 足した本数と新たに
 * 覆った src の行。数えられなければ null、足したファイルは newLines の代わりに `newFile: true`) も付く。
 * git が失敗したとき・終わった後に src/ と test/ が HEAD に戻らなかったときは**投げる**
 * (後者は測っている途中の失敗も文に含める — 握り潰さない)。停止でも戻しは同じ経路を通る。
 *
 * 走らせるのは最大 3 回: HEAD (カバレッジの後も兼ねる) → src だけ基点 (落ちる / 落ちない。src の差分が
 * あるときだけ) → src と test/ を基点 (カバレッジの前。基点にもあるテストだけ)。前を「基点の src + HEAD の
 * テスト」の回で代えないのは、それだと HEAD のテストが基点の src のどこに届くかになって、前後の比較にならないから
 *
 * @param {{cwd?: string, base: string, git?: Function, runTest?: Function, timeoutMs?: number, nodeVersion?: string, handle?: {stopRequested: boolean, abort?: Function}}} p
 */
export async function measureReviewEvidence({
  cwd = process.cwd(),
  base,
  git = runGit,
  runTest = runTestFile,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  nodeVersion = process.versions.node,
  handle,
} = {}) {
  if (!base) throw new Error('base (比べる相手のブランチ) は省略できない');
  if (handle?.stopRequested) return { outcome: 'stopped', base, ran: 0 };
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();

  const [main] = parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']));
  if (main && !main.bare && sameWorktreePath(main.path, root)) {
    return {
      outcome: 'refused',
      reason: `本体の作業ツリー (${root}) では測らない — src を変更前の版へ戻している間、ここで動くものが`
        + 'それを読む。task の作業ツリー (git worktree) を --cwd で渡すこと',
    };
  }
  const dirty = porcelainLines(await git(root, ['status', '--porcelain', '--', 'src', 'test']));
  if (dirty.length > 0) {
    return {
      outcome: 'refused',
      reason: `src/ か test/ に未コミットの変更がある (${dirty.length} 件: ${dirty.slice(0, 5).join(' / ')})`
        + ' — 終わったら HEAD へ戻すので消えてしまう。commit してから測る',
    };
  }

  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const diff = await git(root, ['diff', '-z', '--name-status', '--no-renames', mergeBase, 'HEAD']);
  const { srcAdded, srcRestore, tests, testAdded, testRestore, deletedTests } = selectEvidenceTargets(parseNameStatus(diff));
  const common = { base, mergeBase, src: { added: srcAdded, restored: srcRestore }, tests, deletedTests };
  const hasSrc = srcAdded.length + srcRestore.length > 0;
  // 両方とも空なら src の側で言う (変更したテスト 0 本)
  if (!hasSrc && tests.length === 0) return { outcome: 'no-src', ...common };
  if (tests.length === 0) return { outcome: 'no-tests', ...common };
  const withCoverage = supportsLcovReporter(nodeVersion);
  // src の差分が無くてもカバレッジは測る (test/ だけのタスクの材料)。測れない Node なら走らせる意味が無い
  if (!hasSrc && !withCoverage) return { outcome: 'no-src', ...common, coverage: { supported: false, node: nodeVersion } };

  // 前は基点の版にもあるテストだけ — task が足したテストは基点に無いので 0 扱い (走らせない)
  const beforeTests = tests.filter((file) => !testAdded.includes(file));
  const withBefore = withCoverage && beforeTests.length > 0;
  const planned = tests.length + (hasSrc ? tests.length : 0) + (withBefore ? beforeTests.length : 0);
  // ここまでは読むだけ。止まっていれば戻すものも無いので、書き換える git を打たずに返す
  if (handle?.stopRequested) return { outcome: 'stopped', ...common, ran: 0, planned };
  let ran = 0;
  let stopped = false;
  // 1 回分。止まった後は書き換え (prepare) も走らせもしない
  const runPhase = async (files, coverage, prepare = async () => {}) => {
    if (stopped || handle?.stopRequested) {
      stopped = true;
      return [];
    }
    await prepare();
    const phase = await runAll(files, { root, runTest, timeoutMs, coverage, handle });
    ran += phase.runs.length;
    stopped = phase.stopped;
    return phase.runs;
  };

  const headRuns = await runPhase(tests, withCoverage);
  let baseRuns = null;
  let beforeRuns = [];
  let failure = null;
  try {
    if (hasSrc) {
      baseRuns = await runPhase(tests, false, async () => {
        if (srcRestore.length > 0) await git(root, ['checkout', mergeBase, '--', ...srcRestore]);
        if (srcAdded.length > 0) await git(root, ['rm', '-q', '--', ...srcAdded]);
      });
    }
    if (withBefore) {
      beforeRuns = await runPhase(beforeTests, true, async () => {
        if (testRestore.length > 0) await git(root, ['checkout', mergeBase, '--', ...testRestore]);
        if (testAdded.length > 0) await git(root, ['rm', '-q', '--', ...testAdded]);
      });
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
  if (stopped) return { outcome: 'stopped', ...common, ran, planned };

  const after = coverageOf(headRuns, root);
  const coverage = withCoverage
    ? {
      supported: true,
      files: compareCoverage(coverageOf(beforeRuns, root), after, [...srcAdded, ...srcRestore]),
      // task が変えた src の行のうち HEAD の回が通らない行。HEAD の回に lcov が 1 つも無ければ突き合わせる相手が無い
      ...(hasSrc && headRuns.some((run) => run?.lcov != null)
        ? { changed: findUntestedLines(parseChangedLines(await git(root, changedLinesArgs(mergeBase))), after) }
        : {}),
    }
    : { supported: false, node: nodeVersion };
  // 足した・消えたテストの名前の突き合わせ相手: 足したファイルは基点に名前が無い。それ以外は前の回 (読み込めた回だけ。
  // 前の回が無い・集計の無い回・stdout が上限を超えた回は数えない)
  const beforeCasesOf = (file) => {
    if (testAdded.includes(file)) return [];
    const run = withBefore ? beforeRuns[beforeTests.indexOf(file)] : null;
    return run?.tap?.loadFailed ? null : run?.tapCases ?? null;
  };
  // 消えた名前は HEAD の回も読み込めた回だけ (読み込みで落ちた回の名前はファイル名 1 本で、前の回の名前が全部消えて見える)
  const vanishedTests = tests.flatMap((file, i) => {
    const head = headRuns[i]?.tap?.loadFailed ? null : headRuns[i]?.tapCases;
    const count = countVanishedTests({ head, before: beforeCasesOf(file) });
    return count === null ? [] : [{ file, tests: count }];
  });
  // src の差分が無い回のファイルごとの材料: 足した本数 (HEAD の回の名前 − 前の回の名前) と、新たに覆った src の行
  // (HEAD の回の lcov − 前の回の lcov の、行の集合の差)。lcov の無い回 (撃った・時間切れ) と前の回が読み込みで落ちた
  // ファイル (読み込むだけで覆う行まで差に入る) は行を数えない。足したファイルは前の回が無いので newFile を立てる
  const newCoverageByFile = () => tests.map((file, i) => {
    const head = headRuns[i];
    const addedTests = countNewTests({ head: head?.tap?.loadFailed ? null : head?.tapCases, before: beforeCasesOf(file) });
    if (testAdded.includes(file)) return { file, addedTests, newFile: true };
    const before = beforeRuns[beforeTests.indexOf(file)];
    const newLines = head?.lcov == null || before?.lcov == null || before.tap?.loadFailed
      ? null
      : countNewlyCovered(parseLcov(before.lcov, { root }), parseLcov(head.lcov, { root }));
    return { file, addedTests, newLines };
  });
  if (!hasSrc) return { outcome: 'no-src', ...common, coverage, vanishedTests, testFiles: newCoverageByFile() };
  const runs = tests.map((file, i) => {
    const added = countAddedTests({ head: headRuns[i]?.tapCases, base: baseRuns[i]?.tapCases, before: beforeCasesOf(file) });
    return {
      file,
      head: withoutRaw(headRuns[i]),
      base: withoutRaw(baseRuns[i]),
      verdict: verdictFor(headRuns[i], baseRuns[i]),
      ...(added ? { added } : {}),
    };
  });
  return { outcome: 'measured', ...common, runs, counts: summarizeRuns(runs), coverage, vanishedTests };
}
