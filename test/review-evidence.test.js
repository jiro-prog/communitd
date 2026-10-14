import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { installStopHandlers, main, parseArgs } from '../scripts/review-evidence.mjs';
import {
  EVIDENCE_MAX_CHARS,
  compareCoverage,
  countAddedTests,
  countNewTests,
  countNewlyCovered,
  countVanishedTests,
  findUntestedLines,
  formatReviewEvidence,
  measureReviewEvidence,
  nodeTestArgs,
  parseChangedLines,
  parseLcov,
  parseNameStatus,
  parseReviewEvidence,
  parseTapCases,
  parseTapSummary,
  readsTapSummary,
  runTestFile,
  selectEvidenceTargets,
  summarizeRuns,
  supportsLcovReporter,
  supportsTestIsolation,
  unionCoverage,
  verdictFor,
} from '../src/review-evidence.js';
import { VERIFY_KILL_GRACE_MS } from '../src/verify.js';
import { runGit } from '../src/worktree.js';

const SCRIPT = fileURLToPath(new URL('../scripts/review-evidence.mjs', import.meta.url));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * 基点 (main) の一時リポジトリと、その外に `git worktree add` で生やした task/1 の作業ツリー。
 * `changes` の値が null のパスは消す。package.json の type は Node 20 (構文の自動判定が無い) のため
 */
function makeRepo(t, baseFiles, changes) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-evidence-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const wt = join(dir, 'wt');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'package.json', '{ "type": "module" }\n');
  for (const [rel, text] of Object.entries(baseFiles)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/1', wt, 'main');
  for (const [rel, text] of Object.entries(changes)) {
    if (text === null) unlinkSync(join(wt, rel));
    else write(wt, rel, text);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'task');
  return { repo, wt };
}

const testFile = (body) => `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n${body}`;

const BASE_FILES = {
  'src/math.js': 'export const add = (a, b) => a - b;\n',
  'src/keep.js': "export const keep = () => 'keep';\n",
  'src/old.js': 'export const old = 1;\n',
  'test/math.test.js': testFile("import { add } from '../src/math.js';\ntest('add', () => assert.equal(typeof add, 'function'));\n"),
};
const HEAD_MATH = 'export const add = (a, b) => a + b;\n';
const HEAD_NEW = 'export const twice = (n) => n * 2;\n';
const TASK_CHANGES = {
  'src/math.js': HEAD_MATH, // M — 直したバグ
  'src/new.js': HEAD_NEW, // A — task が足した src
  'src/old.js': null, // D — 基点にだけある src
  'test/math.test.js': testFile("import { add } from '../src/math.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n"),
  'test/new.test.js': testFile("import { twice } from '../src/new.js';\ntest('twice', () => assert.equal(twice(2), 4));\n"),
  'test/keep.test.js': testFile("import { keep } from '../src/keep.js';\ntest('keep', () => assert.equal(keep(), 'keep'));\n"),
  'test/broken.test.js': testFile("test('broken', () => assert.equal(1, 2));\n"),
};

/** 本物の git を通しつつ、打ったコマンドを残す */
function recordingGit() {
  const calls = [];
  const fn = (root, args) => {
    calls.push(args.join(' '));
    return runGit(root, args);
  };
  return { fn, calls };
}

/** 書き換えをしない git のサブコマンド */
const READ_ONLY = /^(rev-parse|worktree list|status|merge-base|diff) /;

test('parseNameStatus は -z の出力を分解し、R / C の 2 つのパスでずれない', () => {
  assert.deepEqual(parseNameStatus('M\0src/a.js\0A\0test/日本語.test.js\0D\0src/b.js\0'), [
    { status: 'M', path: 'src/a.js' },
    { status: 'A', path: 'test/日本語.test.js' },
    { status: 'D', path: 'src/b.js' },
  ]);
  assert.deepEqual(parseNameStatus('R100\0src/old.js\0src/new.js\0M\0src/c.js\0'), [
    { status: 'R', path: 'src/new.js' },
    { status: 'M', path: 'src/c.js' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('selectEvidenceTargets: src の A は消す・M / T / D は戻す、テストは test/ の *.test.js の A / M だけ', () => {
  const entries = [
    { status: 'A', path: 'src/new.js' },
    { status: 'M', path: 'src/a.js' },
    { status: 'T', path: 'src/link.js' },
    { status: 'D', path: 'src/gone.js' },
    { status: 'M', path: 'src/bridge/job.js' },
    { status: 'A', path: 'test/a.test.js' },
    { status: 'M', path: 'test/sub/b.test.js' },
    { status: 'D', path: 'test/gone.test.js' }, // HEAD に無いので走らせられない
    { status: 'M', path: 'test/helpers.js' }, // test/ の補助
    { status: 'A', path: 'scripts/tool.js' }, // test/ 以外の .js
    { status: 'A', path: 'scripts/tool.test.js' },
    { status: 'M', path: 'docs/a.md' },
    { status: 'M', path: 'CHANGELOG.md' },
  ];
  assert.deepEqual(selectEvidenceTargets(entries), {
    srcAdded: ['src/new.js'],
    srcRestore: ['src/a.js', 'src/link.js', 'src/gone.js', 'src/bridge/job.js'],
    tests: ['test/a.test.js', 'test/sub/b.test.js'],
    // カバレッジの前の回に基点の版へ戻す test/ — 補助ファイルと HEAD で消したテストも込み
    testAdded: ['test/a.test.js'],
    testRestore: ['test/sub/b.test.js', 'test/gone.test.js', 'test/helpers.js'],
    // 消したテストは名前だけ出す (補助の .js は数えない)
    deletedTests: ['test/gone.test.js'],
  });
  assert.deepEqual(
    selectEvidenceTargets([{ status: 'D', path: 'test/helpers.js' }, { status: 'D', path: 'scripts/x.test.js' }]).deletedTests,
    [],
  );
  assert.deepEqual(
    selectEvidenceTargets([]),
    { srcAdded: [], srcRestore: [], tests: [], testAdded: [], testRestore: [], deletedTests: [] },
  );
});

test('nodeTestArgs は --experimental-test-isolation と TAP の reporter を Node 22.8 から付ける (それより前は bad option で落ちる)', () => {
  assert.equal(supportsTestIsolation('20.19.0'), false);
  assert.equal(supportsTestIsolation('22.7.0'), false);
  assert.equal(supportsTestIsolation('22.8.0'), true);
  assert.equal(supportsTestIsolation('24.1.0'), true);
  // TAP の集計を読むのは isolation=none の形を確かめた版だけ
  for (const version of ['20.19.0', '22.7.0']) assert.equal(readsTapSummary(version), false, version);
  for (const version of ['22.8.0', '24.1.0']) assert.equal(readsTapSummary(version), true, version);
  assert.deepEqual(nodeTestArgs('test/a.test.js', { version: '20.19.0' }), ['--test', 'test/a.test.js']);
  assert.deepEqual(
    nodeTestArgs('test/a.test.js', { version: '22.17.0' }),
    ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', 'test/a.test.js'],
  );
});

test('supportsLcovReporter: lcov の reporter は 20.11 / 21.2 から (21.0・21.1 には無い)、22 系は最初から', () => {
  for (const version of ['20.6.0', '20.10.0', '21.0.0', '21.1.0']) assert.equal(supportsLcovReporter(version), false, version);
  for (const version of ['20.11.0', '20.19.0', '21.2.0', '22.0.0', '24.1.0']) assert.equal(supportsLcovReporter(version), true, version);
});

test('nodeTestArgs: lcovPath を渡すとカバレッジを取り、tap (22.8 より前は spec) は stdout・lcov はそのファイルへ (reporter と出力先は並び順で対)', () => {
  assert.deepEqual(nodeTestArgs('test/a.test.js', { version: '22.17.0', lcovPath: 'T/lcov.info' }), [
    '--test', '--experimental-test-isolation=none',
    '--experimental-test-coverage',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=T/lcov.info',
    'test/a.test.js',
  ]);
  assert.deepEqual(nodeTestArgs('test/a.test.js', { version: '20.19.0', lcovPath: 'T/lcov.info' }), [
    '--test',
    '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=T/lcov.info',
    'test/a.test.js',
  ]);
  assert.deepEqual(nodeTestArgs('test/a.test.js', { version: '20.19.0', lcovPath: null }), ['--test', 'test/a.test.js']);
});

/** Node 22.17 の --test-reporter=tap の出力 (YAML の中身は縮めた) */
const tapOutput = ({ body, tests, pass, fail }) => [
  'TAP version 13',
  ...body,
  `1..${tests}`,
  `# tests ${tests}`, '# suites 0', `# pass ${pass}`, `# fail ${fail}`,
  '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 22.2271', '',
].join('\n');
/** 基点に無い src を import して読み込みで落ちた回 (Windows では名前の \ が \\ に escape される) */
const loadFailure = (name) => tapOutput({
  body: [`# Subtest: ${name}`, `not ok 1 - ${name}`, '  ---', "  type: 'test'", "  code: 'ERR_MODULE_NOT_FOUND'", '  ...'],
  tests: 1, pass: 0, fail: 1,
});

test('parseTapSummary: 末尾の集計行を読み、最上位の not ok の名前がファイル自身なら読み込みで落ちた印を付ける', () => {
  const normal = tapOutput({
    body: [
      '# Subtest: one', 'ok 1 - one', '  ---', '  ...',
      '# Subtest: grp', '    # Subtest: test\\\\a.test.js', '    not ok 1 - test\\\\a.test.js', '    1..1', // 字下げのある not ok は見ない
      'not ok 2 - grp',
    ],
    tests: 3, pass: 1, fail: 2,
  });
  assert.deepEqual(parseTapSummary(normal, 'test/a.test.js'), { tests: 3, pass: 1, fail: 2 });
  assert.deepEqual(parseTapSummary(loadFailure('test\\\\b.test.js'), 'test/b.test.js'), { tests: 1, pass: 0, fail: 1, loadFailed: true });
  assert.deepEqual(parseTapSummary(loadFailure('test/b.test.js'), 'test/b.test.js'), { tests: 1, pass: 0, fail: 1, loadFailed: true });
  // 名前の # は \# に escape され、後ろの # SKIP は指示
  assert.equal(parseTapSummary(loadFailure('test/c\\#1.test.js # SKIP'), 'test/c#1.test.js').loadFailed, true);
  // テスト 1 本のファイルが素直に落ちた回 (名前がテスト) とは区別する
  assert.equal('loadFailed' in parseTapSummary(loadFailure('add'), 'test/b.test.js'), false);
  assert.equal('loadFailed' in parseTapSummary(loadFailure('test\\\\b.test.js'), 'test/other.test.js'), false);

  // テストが stdout に書いた同じ形の行より、最後に出た集計を使う。CRLF でも読む
  assert.deepEqual(parseTapSummary(`# tests 99\n# pass 99\n# fail 0\n${normal}`.replace(/\n/g, '\r\n'), 'test/a.test.js'), {
    tests: 3, pass: 1, fail: 2,
  });
  // 64 KB で頭を切っても集計は末尾に残る。集計行が 1 つでも無ければ null (撃った回・spec の出力)
  assert.deepEqual(parseTapSummary(normal.slice(normal.indexOf('1..3')), 'test/a.test.js'), { tests: 3, pass: 1, fail: 2 });
  assert.equal(parseTapSummary(normal.replace('# fail 2', ''), 'test/a.test.js'), null);
  assert.equal(parseTapSummary('ℹ tests 3\nℹ pass 1\nℹ fail 2\n', 'test/a.test.js'), null);
  assert.equal(parseTapSummary(undefined, 'test/a.test.js'), null);
});

/** Node 22.17 の tap のテスト 1 本ずつの行 (YAML は type: と error: だけに縮めた) */
const CASES_TAP = tapOutput({
  body: [
    // テストが stdout に書いた同じ形の行。後ろの type: は字下げが ok 行の +2 でないので YAML ではない
    'ok 99 - fake', "    type: 'test'",
    '# Subtest: suite \\#1 a\\\\b',
    '    # Subtest: child one', '    ok 1 - child one', '      ---', "      type: 'test'", '      ...',
    '    # Subtest: child two', '    not ok 2 - child two', '      ---', "      type: 'test'", "      error: 'boom'", '      ...',
    '    # Subtest: inner',
    '        # Subtest: deep', '        ok 1 - deep', '          ---', "          type: 'test'", '          ...', '        1..1',
    '    ok 3 - inner', '      ---', "      type: 'suite'", '      ...', '    1..3',
    'not ok 1 - suite \\#1 a\\\\b', '  ---', "  type: 'suite'", '  ...',
    '# Subtest: top',
    '    # Subtest: sub', '    ok 1 - sub', '      ---', "      type: 'test'", '      ...',
    '    # Subtest: sub', '    ok 2 - sub', '      ---', "      type: 'test'", '      ...', '    1..2',
    'ok 2 - top', '  ---', "  type: 'test'", '  ...',
    '# Subtest: skipped', 'ok 3 - skipped # SKIP why', '  ---', "  type: 'test'", '  ...',
    '# Subtest: todo', 'not ok 4 - todo # TODO', '  ---', "  type: 'test'", '  ...',
    '# Subtest: c\\# SKIP', 'ok 5 - c\\# SKIP', '  ---', "  type: 'test'", '  ...',
  ],
  tests: 9, pass: 6, fail: 1,
});

test('parseTapCases: 入れ子を親からつないだ名前と結果を、YAML の type: が出た行だけ読む (suite・SKIP / TODO・重複・escape)', () => {
  const cases = parseTapCases(CASES_TAP);
  assert.deepEqual(cases, [
    { name: 'suite #1 a\\b > child one', type: 'test', pass: true },
    { name: 'suite #1 a\\b > child two', type: 'test', pass: false },
    { name: 'suite #1 a\\b > inner > deep', type: 'test', pass: true },
    { name: 'suite #1 a\\b > inner', type: 'suite', pass: true },
    { name: 'suite #1 a\\b', type: 'suite', pass: false },
    { name: 'top > sub', type: 'test', pass: true },
    { name: 'top > sub', type: 'test', pass: true },
    { name: 'top', type: 'test', pass: true },
    { name: 'skipped', type: 'test', pass: false }, // SKIP / TODO は集計の # pass に入らない
    { name: 'todo', type: 'test', pass: false },
    { name: 'c# SKIP', type: 'test', pass: true }, // 名前の中の \# は指示ではない
  ]);
  // 通ったテストの本数は集計の # pass と同じ数え方 (suite は入らない)
  assert.equal(cases.filter((c) => c.type === 'test' && c.pass).length, parseTapSummary(CASES_TAP, 'test/a.test.js').pass);
  assert.deepEqual(parseTapCases(CASES_TAP.replace(/\n/g, '\r\n')), cases);
  // 読み込みで落ちたファイルは、ファイル名の not ok が 1 本
  assert.deepEqual(parseTapCases(loadFailure('test\\\\b.test.js')), [{ name: 'test\\b.test.js', type: 'test', pass: false }]);
  assert.deepEqual(parseTapCases('ℹ tests 3\nℹ pass 1\n'), []);
  assert.deepEqual(parseTapCases(undefined), []);
});

test('countAddedTests: HEAD にだけある名前 (足した・改名した) のうち HEAD で通ったテストが、変更前の src で落ちる / 通るを数える', () => {
  const c = (name, pass = true, type = 'test') => ({ name, type, pass });
  const before = [c('kept'), c('renamed old'), c('dup'), c('grp > old'), c('grp', true, 'suite')];
  const head = [
    c('kept'), // 名前が基点の版にもある (中身だけ変えても足したことにならない)
    c('renamed new'), // 改名は足した扱い
    c('dup'), c('dup'), // 同じ名前は何本目かで突き合わせる — 2 本目だけが足した
    c('grp > old'), c('grp > new'), c('grp', true, 'suite'),
    c('new suite', true, 'suite'), // suite は数えない
    c('skipped new', false), // HEAD で通らない (SKIP / TODO を含む) は数えない
  ];
  const base = [c('kept', false), c('renamed new'), c('dup'), c('dup', false), c('grp > old'), c('grp > new', false)];
  assert.deepEqual(countAddedTests({ head, base, before }), { tests: 3, fails: 2, passes: 1 });
  // 基点で読み込めなかった回は、足したテストの名前が無い = 全部落ちる
  assert.deepEqual(countAddedTests({ head, base: [c('test\\a.test.js', false)], before }), { tests: 3, fails: 3, passes: 0 });
  // 足したファイル (前の回の名前が []) は、HEAD で通ったテストが全部足した
  assert.deepEqual(countAddedTests({ head, base, before: [] }), { tests: 6, fails: 3, passes: 3 });
  assert.deepEqual(countAddedTests({ head: before, base: before, before }), { tests: 0, fails: 0, passes: 0 });
  // どれか 1 つでも無ければ数えない (前の回が無い・集計の無い回・stdout が上限を超えた回)
  assert.equal(countAddedTests({ head, base, before: null }), null);
  assert.equal(countAddedTests({ head, base: undefined, before }), null);
  assert.equal(countAddedTests({ head: null, base, before: [] }), null);
});

test('countVanishedTests: 前の回にあって HEAD に無い名前 (消した・改名した) を、前の回で通ったかを問わず数える', () => {
  const c = (name, pass = true, type = 'test') => ({ name, type, pass });
  const before = [
    c('kept'),
    c('removed'), // 消した
    c('failing', false), // 前の回で落ちていたテストを消した — いちばん見たいすり抜け
    c('renamed old'), // 改名は消えた扱い
    c('dup'), c('dup'), // 同じ名前は何本目かで突き合わせる — 2 本目だけが消えた
    c('grp > old'), c('grp', true, 'suite'),
    c('gone suite', true, 'suite'), // suite は数えない
  ];
  const head = [c('kept'), c('renamed new'), c('dup'), c('grp > old'), c('grp', true, 'suite'), c('added')];
  assert.equal(countVanishedTests({ head, before }), 4);
  // HEAD で通らない (SKIP / TODO・落ちた) テストは名前が残っているので消えていない
  assert.equal(countVanishedTests({ head: before.map((x) => ({ ...x, pass: false })), before }), 0);
  // 足したファイル (前の回の名前が []) は何も消えていない
  assert.equal(countVanishedTests({ head, before: [] }), 0);
  // どちらか無ければ数えない (前の回が無い・集計の無い回・stdout が上限を超えた回)
  assert.equal(countVanishedTests({ head, before: null }), null);
  assert.equal(countVanishedTests({ head: undefined, before }), null);
});

test('countNewTests: src の差分が無い回の足した本数 — HEAD にだけある名前のうち HEAD で通ったテスト (countAddedTests の tests と同じ数え方)', () => {
  const c = (name, pass = true, type = 'test') => ({ name, type, pass });
  const before = [c('kept'), c('dup'), c('renamed old')];
  const head = [
    c('kept'), // 前の回にもある
    c('dup'), c('dup'), // 同じ名前は何本目かで突き合わせる — 2 本目だけが足した
    c('renamed new'), // 改名は足した扱い
    c('added'),
    c('added failing', false), c('added skip', false), // HEAD で通らない (落ちた・SKIP / TODO) は数えない
    c('added suite', true, 'suite'), // suite は数えない
  ];
  assert.equal(countNewTests({ head, before }), 3);
  assert.equal(countNewTests({ head, before }), countAddedTests({ head, base: head, before }).tests);
  // 足したファイル (前の回の名前が []) は通ったテスト全部
  assert.equal(countNewTests({ head, before: [] }), 5);
  // どちらか無ければ数えない (前の回が読み込みで落ちた・集計の無い回・stdout が上限を超えた回)
  assert.equal(countNewTests({ head, before: null }), null);
  assert.equal(countNewTests({ head: undefined, before }), null);
});

test('parseLcov: SF の \\ をそろえ、root の下の絶対パスは相対に、src/ だけを残して DA > 0 を覆った行に数える', () => {
  const lcov = [
    'TN:', 'SF:src\\bridge\\a.js', 'DA:1,1', 'DA:2,0', 'DA:3,4', 'LH:2', 'LF:3', 'end_of_record',
    'SF:C:\\Work\\Repo\\src\\b.js', 'DA:1,0', 'DA:2,0', 'end_of_record', // 絶対パス (ドライブ名の大小は問わない)
    'SF:test\\a.test.js', 'DA:1,1', 'end_of_record', // テスト自身は数えない
    'SF:..\\outside\\src\\c.js', 'DA:1,1', 'end_of_record', // root の外
    'SF:scripts/x.mjs', 'DA:1,1', 'end_of_record',
    'SF:src/bridge/a.js', 'DA:2,1', 'DA:4,0', 'end_of_record', // 同じファイルの 2 つ目の記録は和集合
  ].join('\r\n');
  const files = parseLcov(lcov, { root: 'c:/work/repo' });
  assert.deepEqual([...files.keys()], ['src/bridge/a.js', 'src/b.js']);
  assert.deepEqual([...files.get('src/bridge/a.js').lines], [1, 2, 3, 4]);
  assert.deepEqual([...files.get('src/bridge/a.js').covered], [1, 3, 2]);
  assert.deepEqual([...files.get('src/b.js').covered], []);
  // root の外の絶対パス・root が分からない絶対パスは捨てる
  assert.deepEqual([...parseLcov('SF:/elsewhere/src/a.js\nDA:1,1\nend_of_record\n', { root: '/work/repo' }).keys()], []);
  assert.deepEqual([...parseLcov('SF:/work/repo/src/a.js\nDA:1,1\nend_of_record\n').keys()], []);
  assert.deepEqual([...parseLcov(undefined).keys()], []);
});

test('unionCoverage / compareCoverage: 触った src と覆った行数が変わった src を、差の大きい順に前後で並べる', () => {
  const lcov = (records) => parseLcov(Object.entries(records)
    .map(([path, counts]) => `SF:${path}\n${counts.map((count, i) => `DA:${i + 1},${count}`).join('\n')}\nend_of_record`)
    .join('\n'));
  const before = unionCoverage([lcov({ 'src/a.js': [1, 0, 0, 0], 'src/same.js': [1, 1], 'src/gone.js': [1, 0] })]);
  const after = unionCoverage([
    lcov({ 'src/a.js': [1, 1, 0, 0], 'src/same.js': [1, 1], 'src/new.js': [1, 1, 1] }),
    lcov({ 'src/a.js': [1, 0, 1, 0], 'src/side.js': [1] }), // 2 本目のテストが覆った行も足す
  ]);
  assert.deepEqual(compareCoverage(before, after, ['src/a.js', 'src/gone.js', 'src/never.js']), [
    { path: 'src/new.js', before: null, after: { covered: 3, total: 3 } },
    { path: 'src/a.js', before: { covered: 1, total: 4 }, after: { covered: 3, total: 4 } },
    { path: 'src/gone.js', before: { covered: 1, total: 2 }, after: null },
    { path: 'src/side.js', before: null, after: { covered: 1, total: 1 } },
    // 触ったのに前後とも読み込まれない src は差 0 でも残す (変更したテストが届いていない)
    { path: 'src/never.js', before: null, after: null },
  ]);
  // 触っていない・覆った行数も変わらない src (src/same.js) は出さない
  assert.deepEqual(compareCoverage(new Map(), new Map(), []), []);
});

test('countNewlyCovered: 後の回にだけ覆われた行をファイルごとの集合の差で数える (行数の差ではない)', () => {
  const lcov = (records) => parseLcov(Object.entries(records)
    .map(([path, counts]) => `SF:${path}\n${counts.map((count, i) => `DA:${i + 1},${count}`).join('\n')}\nend_of_record`)
    .join('\n'));
  // src/a.js は前 {1, 2}・後 {2, 3} — 覆った行数は 2 のまま変わらないが、3 行目は新たに覆った
  const before = lcov({ 'src/a.js': [1, 1, 0, 0], 'src/gone.js': [1, 1] });
  const after = lcov({ 'src/a.js': [0, 1, 1, 0], 'src/new.js': [1, 0, 1] });
  assert.equal(countNewlyCovered(before, after), 1 + 2); // src/new.js は前に無いので覆った行が全部新しい
  // 前に覆った行をなぞるだけなら 0 (前にだけあるファイル src/gone.js は数えない)
  assert.equal(countNewlyCovered(before, lcov({ 'src/a.js': [1, 1, 0, 0] })), 0);
  assert.equal(countNewlyCovered(new Map(), new Map()), 0);
});

test('parseChangedLines: `@@` の +c,d だけを読む — d の省略は 1・+c,0 は行なし・足したファイルは全行・消したファイルと本文の +++ 行は読まない', () => {
  const nihon = '"b/src/\\346\\227\\245\\346\\234\\254.js"'; // core.quotePath の 8 進 (src/日本.js)
  const diff = [
    'diff --git a/src/a b.js b/src/a b.js',
    'index de98044..a7bc997 100644',
    '--- a/src/a b.js\t', // 空白入りのパスは後ろにタブが付く
    '+++ b/src/a b.js\t',
    '@@ -2 +2 @@ a', // d の省略は 1
    '-b',
    '+++ b/src/evil.js', // 本文の `++ b/src/evil.js` を足した行 — ファイルの頭と取り違えると次の hunk がそちらへ行く
    '@@ -3,0 +4,2 @@ c',
    '+d',
    '+e',
    '@@ -7,2 +8,0 @@', // 消しただけ — 行なし
    '-f',
    '-g',
    'diff --git a/src/del.js b/src/del.js',
    'deleted file mode 100644',
    '--- a/src/del.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-1',
    '-2',
    'diff --git a/src/new.js b/src/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.js',
    '@@ -0,0 +1,3 @@',
    '+n1',
    '+n2',
    '+n3',
    'diff --git a/src/mode.js b/src/mode.js', // mode だけの変更は hunk が無い
    'old mode 100644',
    'new mode 100755',
    `diff --git ${nihon.replace('b/', 'a/')} ${nihon}`,
    `--- ${nihon.replace('b/', 'a/')}`,
    `+++ ${nihon}`,
    '@@ -1,0 +2 @@ x',
    '+y',
    'diff --git a/src/only-deleted.js b/src/only-deleted.js',
    '--- a/src/only-deleted.js',
    '+++ b/src/only-deleted.js',
    '@@ -3 +2,0 @@',
    '-z',
    'diff --git "a/src/q\\"t\\\\.js" "b/src/q\\"t\\\\.js"', // `"` と `\` の引用
    '--- "a/src/q\\"t\\\\.js"',
    '+++ "b/src/q\\"t\\\\.js"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\r\n');
  assert.deepEqual([...parseChangedLines(diff)], [
    ['src/a b.js', [2, 4, 5]],
    ['src/new.js', [1, 2, 3]],
    ['src/日本.js', [2]],
    ['src/q"t\\.js', [1]],
  ]);
  assert.deepEqual([...parseChangedLines(undefined)], []);
});

test('findUntestedLines: 変えた行のうち lcov の DA に出た行だけを数え、どのテストも覆わない行を範囲に畳む (lcov に無い src・実行行の無い src は出さない)', () => {
  const after = unionCoverage([
    // 5 行目と 8 行目は DA に無い (実行行でない)
    parseLcov('SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nDA:6,0\nDA:7,1\nDA:9,0\nDA:10,0\nend_of_record\n'
      + 'SF:src/b.js\nDA:1,1\nDA:2,1\nend_of_record\nSF:src/c.js\nDA:1,1\nDA:2,0\nend_of_record\n'
      + 'SF:src/e.js\nDA:1,0\nDA:2,0\nDA:3,0\nend_of_record\n'),
    parseLcov('SF:src/a.js\nDA:9,1\nend_of_record\n'), // 2 本目のテストが覆った行は通る
  ]);
  const changed = new Map([
    ['src/a.js', [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
    ['src/b.js', [1, 2]],
    ['src/c.js', [5]], // DA に無い行だけ
    ['src/d.js', [1, 2]], // 変更したテストが読み込まない
    ['src/e.js', [1, 2, 3]],
  ]);
  // 通らない行の多い順。a.js の 5 行目は数えないので、3-4 と 6 は続かない
  assert.deepEqual(findUntestedLines(changed, after), [
    { path: 'src/a.js', changed: 7, untested: 4, ranges: [[3, 4], [6, 6], [10, 10]] },
    { path: 'src/e.js', changed: 3, untested: 3, ranges: [[1, 3]] },
    { path: 'src/b.js', changed: 2, untested: 0, ranges: [] },
  ]);
  assert.deepEqual(findUntestedLines(new Map(), after), []);
});

test('verdictFor / summarizeRuns: HEAD で落ちたら基点は見ない', () => {
  assert.equal(verdictFor({ ok: true }, { ok: false }), 'fails');
  assert.equal(verdictFor({ ok: true }, { ok: true }), 'passes');
  assert.equal(verdictFor({ ok: false }, { ok: true }), 'head-fails');
  assert.equal(verdictFor({ ok: false }, { ok: false }), 'head-fails');
  assert.deepEqual(
    summarizeRuns([{ verdict: 'fails' }, { verdict: 'fails' }, { verdict: 'passes' }, { verdict: 'head-fails' }]),
    { fails: 2, passes: 1, headFails: 1 },
  );
});

test('formatReviewEvidence: 本数と落ちないファイル名、差分なし・テストなしは相手側の数を添えた 1 行', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const measured = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'],
    runs: [
      { file: 'test/a.test.js', verdict: 'fails' },
      { file: 'test/b.test.js', verdict: 'passes' },
      { file: 'test/c.test.js', verdict: 'passes' },
    ],
    counts: { fails: 1, passes: 2, headFails: 0 },
  });
  assert.equal(
    measured,
    '変更前の src で落ちる 1 / 落ちない 2 / HEAD でも落ちる 0 (変更したテスト 3 本・src の差分 2 ファイル・基点 0123456 (main))\n'
      + '落ちない: test/b.test.js, test/c.test.js',
  );
  const allFail = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/a.test.js'],
    runs: [{ file: 'test/a.test.js', verdict: 'fails' }],
    counts: { fails: 1, passes: 0, headFails: 0 },
  });
  assert.doesNotMatch(allFail, /\n/, '落ちないテストが無ければ 2 行目を出さない');

  const noSrc = formatReviewEvidence({ ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js'] });
  assert.equal(noSrc, 'src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト 1 本・基点 0123456 (main))');
  const noTests = formatReviewEvidence({ ...common, outcome: 'no-tests', tests: [] });
  assert.equal(noTests, '変更したテストなし — 変更前の src で走らせるものが無い (src の差分 2 ファイル・基点 0123456 (main))');
  assert.equal(formatReviewEvidence({ outcome: 'refused', reason: '理由' }), '断りました: 理由');
});

test('formatReviewEvidence: ファイルの中の本数を落ちない本数の多い順に 5 件 + ほか、読み込めずは HEAD の本数だけ、HEAD でも落ちる・集計の無い回は出さない', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const tap = (pass, fail = 0, extra = {}) => ({ tests: pass + fail, pass, fail, ...extra });
  const run = (file, verdict, head, base) => ({ file, verdict, head: { ok: verdict !== 'head-fails', tap: head }, base: { tap: base } });
  const runs = [
    run('test/a.test.js', 'fails', tap(12), tap(11, 1)),
    run('test/b.test.js', 'passes', tap(3), tap(3)),
    run('test/c.test.js', 'fails', tap(7), tap(0, 1, { loadFailed: true })),
    run('test/d.test.js', 'head-fails', tap(1, 1), tap(0, 2)),
    run('test/e.test.js', 'fails', tap(4), tap(3, 1)),
    run('test/f.test.js', 'passes', tap(3), tap(3)),
    run('test/g.test.js', 'fails', tap(2), tap(0, 2)),
    run('test/h.test.js', 'passes', tap(1), tap(1)),
    // 集計の無い回 (古い形・撃った回) は本数の行を出さず、落ちないなら名前の行に残る
    { file: 'test/i.test.js', verdict: 'passes', head: { ok: true }, base: { ok: true } },
  ];
  const text = formatReviewEvidence({
    ...common, outcome: 'measured', tests: runs.map((r) => r.file), runs, counts: summarizeRuns(runs),
  });
  assert.equal(text, [
    '変更前の src で落ちる 4 / 落ちない 4 / HEAD でも落ちる 1 (変更したテスト 9 本・src の差分 2 ファイル・基点 0123456 (main))',
    'test/a.test.js: HEAD で通る 12 本のうち 変更前の src で落ちる 1・通る 11',
    'test/b.test.js: HEAD で通る 3 本のうち 変更前の src で落ちる 0・通る 3', // 同じ 3 本なら名前順
    'test/e.test.js: HEAD で通る 4 本のうち 変更前の src で落ちる 1・通る 3',
    'test/f.test.js: HEAD で通る 3 本のうち 変更前の src で落ちる 0・通る 3',
    'test/h.test.js: HEAD で通る 1 本のうち 変更前の src で落ちる 0・通る 1',
    'ほか 2 ファイル (うち基点で読み込めず 1)', // c (読み込めず) と g は通る 0 本 — 畳んだ中の読み込めずは本数を添える
    // 本数の行に出た落ちないファイル (b・f・h) は名前を重ねない
    '落ちない: test/i.test.js',
  ].join('\n'));
  // 畳んだ中の読み込めずも読み戻せる (落ちる 4 のうち 1)
  assert.equal(parseReviewEvidence(text).loadFailedFiles, 1);

  // 読み込めずは通る 0 本の扱いで並び、HEAD の本数だけを出す。落ちる / 通るは HEAD で通った本数を分ける
  // (基点のほうが多く通っても HEAD の本数を超えない)
  const few = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/c.test.js', 'test/g.test.js', 'test/x.test.js'],
    runs: [runs[2], runs[6], run('test/x.test.js', 'fails', tap(2), tap(5, 1))],
    counts: { fails: 3, passes: 0, headFails: 0 },
  });
  assert.deepEqual(few.split('\n').slice(1), [
    'test/x.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 0・通る 2',
    'test/c.test.js: 基点で読み込めず (HEAD で通る 7 本)',
    'test/g.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 2・通る 0',
  ]);
  assert.deepEqual(parseReviewEvidence(few), { kind: 'measured', fails: 3, passes: 0, headFails: 0, tests: 3, srcFiles: 2, loadFailedFiles: 1 });
});

test('formatReviewEvidence: 「落ちる」のうち基点の回が時間切れ・起動失敗で終わったファイルは本数の行の後ろに「基点で走り切らず: 名前 (理由)」— 1 行目と読み戻しは変えない', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const tap = (pass, fail = 0) => ({ tests: pass + fail, pass, fail });
  const head = { ok: true, code: 0, timedOut: false, tap: tap(2) };
  // runTestFile が返す形: 時間切れ・起動失敗は終了コードも集計も無く、理由が error に残る
  const timedOut = { ok: false, code: null, timedOut: true, error: 'timeout after 600000ms', tail: 'ok 1 - first' };
  const spawnFailed = { ok: false, code: null, timedOut: false, error: 'spawn failed: ENOENT', tail: 'spawn failed: ENOENT' };
  const runs = [
    { file: 'test/slow.test.js', verdict: 'fails', head, base: timedOut },
    // テストで落ちた基点の回 (終了コードがある) は本数の行だけ
    { file: 'test/a.test.js', verdict: 'fails', head, base: { ok: false, code: 1, timedOut: false, tap: tap(1, 1), tail: 'not ok 2' } },
    { file: 'test/broken.test.js', verdict: 'fails', head, base: spawnFailed },
    { file: 'test/b.test.js', verdict: 'passes', head, base: { ok: true, code: 0, timedOut: false, tap: tap(2) } },
    // HEAD でも落ちるファイルは基点を数えていないので、基点が時間切れでも出さない
    { file: 'test/c.test.js', verdict: 'head-fails', head: { ...timedOut }, base: timedOut },
  ];
  const result = { ...common, outcome: 'measured', tests: runs.map((r) => r.file), runs, counts: summarizeRuns(runs) };
  const text = formatReviewEvidence(result);
  assert.equal(text, [
    '変更前の src で落ちる 3 / 落ちない 1 / HEAD でも落ちる 1 (変更したテスト 5 本・src の差分 2 ファイル・基点 0123456 (main))',
    'test/b.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 0・通る 2',
    'test/a.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 1・通る 1',
    '基点で走り切らず: test/broken.test.js (spawn failed: ENOENT), test/slow.test.js (timeout after 600000ms)',
  ].join('\n'));
  // 理由の無い同じ回 (これまでの形) と 1 行目・読み戻しが同じ — 数え方は変えず、行を足しただけ
  const bare = formatReviewEvidence({ ...result, runs: runs.map((run) => ({ ...run, base: { ...run.base, error: undefined } })) });
  assert.doesNotMatch(bare, /基点で走り切らず/);
  assert.equal(text.split('\n')[0], bare.split('\n')[0]);
  assert.deepEqual(parseReviewEvidence(text), parseReviewEvidence(bare));
  assert.deepEqual(parseReviewEvidence(text), { kind: 'measured', fails: 3, passes: 1, headFails: 1, tests: 5, srcFiles: 2, loadFailedFiles: 0 });

  // 上限 (1200 字) に収まるまで名前を「ほか n ファイル」に畳む。0 件まで畳んでも本数は残す
  const slow = (i, depth) => ({ file: `test/${'deep/'.repeat(depth)}slow-${i}.test.js`, verdict: 'fails', head, base: timedOut });
  const unfinishedLine = (depth) => {
    const many = Array.from({ length: 7 }, (_, i) => slow(i, depth));
    const folded = formatReviewEvidence({ ...common, outcome: 'measured', tests: many.map((r) => r.file), runs: many, counts: summarizeRuns(many) });
    assert.ok(folded.length <= EVIDENCE_MAX_CHARS, `上限を超えた: ${folded.length}`);
    assert.match(folded, /^変更前の src で落ちる 7 \/ 落ちない 0 \/ HEAD でも落ちる 0 /);
    return folded.split('\n')[1];
  };
  assert.equal(unfinishedLine(0), `基点で走り切らず: ${[0, 1, 2, 3, 4].map((i) => `test/slow-${i}.test.js (timeout after 600000ms)`).join(', ')} ほか 2 ファイル`);
  const some = unfinishedLine(40).match(/^基点で走り切らず: (.*) ほか (\d+) ファイル$/);
  assert.ok(some, '名前を畳んでいない');
  const named = some[1].split(', ').length;
  assert.ok(named >= 1 && named < 5, `名前の数: ${named}`);
  assert.equal(named + Number(some[2]), 7);
  assert.equal(unfinishedLine(250), '基点で走り切らず: 7 ファイル');

  // 畳むのは消したテストの名前が先 — それで収まれば走り切らずの名前は残る
  const deletedTests = [0, 1, 2].map((i) => `test/${'gone/'.repeat(60)}gone-${i}.test.js`);
  const both = formatReviewEvidence({ ...result, deletedTests }).split('\n');
  assert.equal(both[3], '基点で走り切らず: test/broken.test.js (spawn failed: ENOENT), test/slow.test.js (timeout after 600000ms)');
  assert.match(both[4], /^消したテスト: ファイル 3 \(.* ほか \d+\)$/);
});

test('formatReviewEvidence: 足したテストを数えられたファイルはそのうち通る本数を添え、足したテストのうち通る本数の多い順に並べる', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const tap = (pass, fail = 0, extra = {}) => ({ tests: pass + fail, pass, fail, ...extra });
  const run = (file, verdict, head, base, added) => ({
    file, verdict, head: { ok: true, tap: head }, base: { tap: base }, ...(added ? { added } : {}),
  });
  const runs = [
    // 昔からのテストが多く通っても、足したテストのうち通るのは 1 本
    run('test/a.test.js', 'fails', tap(12), tap(11, 1), { tests: 2, fails: 1, passes: 1 }),
    run('test/b.test.js', 'passes', tap(3), tap(3), { tests: 3, fails: 0, passes: 3 }),
    run('test/c.test.js', 'fails', tap(7), tap(0, 1, { loadFailed: true }), { tests: 7, fails: 7, passes: 0 }),
    // 名前を変えずに中身だけ変えたファイル (足した 0 本)。足したテストの通る本数が同じなら、通る本数の多い順
    run('test/d.test.js', 'passes', tap(5), tap(5), { tests: 0, fails: 0, passes: 0 }),
    // 数えられなかったファイル (前の回が無い・撃たれた) は従来の行で、通る本数で並ぶ
    run('test/e.test.js', 'passes', tap(2), tap(2)),
  ];
  const text = formatReviewEvidence({
    ...common, outcome: 'measured', tests: runs.map((r) => r.file), runs, counts: summarizeRuns(runs),
  });
  assert.equal(text, [
    '変更前の src で落ちる 2 / 落ちない 3 / HEAD でも落ちる 0 (変更したテスト 5 本・src の差分 2 ファイル・基点 0123456 (main))',
    'test/b.test.js: HEAD で通る 3 本のうち 変更前の src で落ちる 0・通る 3 (足した 3/3 通る)',
    'test/e.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 0・通る 2',
    'test/a.test.js: HEAD で通る 12 本のうち 変更前の src で落ちる 1・通る 11 (足した 1/2 通る)',
    'test/d.test.js: HEAD で通る 5 本のうち 変更前の src で落ちる 0・通る 5 (足した 0 本)',
    'test/c.test.js: 基点で読み込めず (HEAD で通る 7 本のうち 足した 7 本)',
  ].join('\n'));
  // 1 行目の形は変わらない (読み込めずの行は足したテストを添えた形でも数える)
  assert.deepEqual(parseReviewEvidence(text), { kind: 'measured', fails: 2, passes: 3, headFails: 0, tests: 5, srcFiles: 2, loadFailedFiles: 1 });
});

const COVERAGE_HEAD = (n) =>`カバレッジ (変更したテスト ${n} 本だけで測った src の覆った行 / 全行 — 全スイートではない。`
  + '前 = 基点の src と基点の版のテスト、後 = HEAD、なし = 読み込まれない)';

test('formatReviewEvidence: カバレッジは前後を「覆った行/全行 (%)」で並べ、5 件を超えた分は件数だけ・測れない Node は 1 行', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: [], restored: ['src/m.js'] } };
  const stat = (covered, total) => ({ covered, total });
  const files = [
    { path: 'src/m.js', before: stat(1, 3), after: stat(3, 3) },
    { path: 'src/n.js', before: null, after: stat(2, 3) },
    { path: 'src/d.js', before: stat(2, 4), after: null },
    { path: 'src/z.js', before: stat(0, 0), after: stat(0, 0) },
    { path: 'src/q.js', before: null, after: null },
    { path: 'src/r.js', before: stat(1, 2), after: stat(1, 2) },
    { path: 'src/s.js', before: stat(1, 2), after: stat(1, 2) },
  ];
  const measured = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/a.test.js'],
    runs: [{ file: 'test/a.test.js', verdict: 'fails' }],
    counts: { fails: 1, passes: 0, headFails: 0 },
    coverage: { supported: true, files },
  });
  assert.equal(measured, [
    '変更前の src で落ちる 1 / 落ちない 0 / HEAD でも落ちる 0 (変更したテスト 1 本・src の差分 1 ファイル・基点 0123456 (main))',
    `${COVERAGE_HEAD(1)}:`,
    'src/m.js 1/3 (33%) → 3/3 (100%)', // % は切り捨て
    'src/n.js なし → 2/3 (66%)',
    'src/d.js 2/4 (50%) → なし',
    'src/z.js 0/0 (0%) → 0/0 (0%)',
    'src/q.js なし → なし',
    'ほか 2 ファイル',
  ].join('\n'));

  // test/ だけのタスクにも前後が出る (落ちる / 落ちないの行は出さない)
  const noSrc = formatReviewEvidence({
    ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js', 'test/b.test.js'],
    coverage: { supported: true, files: [] },
  });
  assert.equal(noSrc, 'src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト 2 本・基点 0123456 (main))\n'
    + `${COVERAGE_HEAD(2)}: 触った src も覆った行数が変わった src も無い`);

  const unsupported = formatReviewEvidence({
    ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js'],
    coverage: { supported: false, node: '20.10.0' },
  });
  assert.equal(unsupported.split('\n')[1], 'カバレッジは測れない (Node v20.10.0)');
});

test('formatReviewEvidence: 変えた行はカバレッジの段の前に src ごとの「変えた実行行 N のうち通らない k (範囲)」— 範囲は 5 つ・src は 5 件まで (1 行目は変えない)', () => {
  const row = (path, changed, ranges) => ({
    path, changed, untested: ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0), ranges,
  });
  const result = {
    outcome: 'measured', base: 'main', mergeBase: '0123456789abcdef',
    src: { added: [], restored: ['src/a.js'] },
    tests: ['test/a.test.js'],
    runs: [{ file: 'test/a.test.js', verdict: 'fails' }],
    counts: { fails: 1, passes: 0, headFails: 0 },
    coverage: {
      supported: true,
      files: [{ path: 'src/a.js', before: { covered: 1, total: 3 }, after: { covered: 3, total: 3 } }],
      changed: [
        row('src/a.js', 20, [[3, 4], [6, 6], [9, 10], [12, 12], [14, 14], [20, 20]]),
        row('src/b.js', 10, [[120, 125], [140, 140]]),
        row('src/c.js', 1, [[7, 7]]),
        row('src/d.js', 1, [[7, 7]]),
        row('src/e.js', 1, [[7, 7]]),
        row('src/f.js', 2, []),
      ],
    },
  };
  const text = formatReviewEvidence(result);
  assert.equal(text, [
    '変更前の src で落ちる 1 / 落ちない 0 / HEAD でも落ちる 0 (変更したテスト 1 本・src の差分 1 ファイル・基点 0123456 (main))',
    'src/a.js: 変えた実行行 20 のうち通らない 8 (L3-4, L6, L9-10, L12, L14 ほか 1 範囲)',
    'src/b.js: 変えた実行行 10 のうち通らない 7 (L120-125, L140)',
    'src/c.js: 変えた実行行 1 のうち通らない 1 (L7)',
    'src/d.js: 変えた実行行 1 のうち通らない 1 (L7)',
    'src/e.js: 変えた実行行 1 のうち通らない 1 (L7)',
    'ほか 1 ファイル',
    `${COVERAGE_HEAD(1)}:`,
    'src/a.js 1/3 (33%) → 3/3 (100%)',
  ].join('\n'));
  // 1 行目は parseReviewEvidence がそのまま読める。変えた行の段の「ほか n ファイル」は読み込めずに数えない
  assert.deepEqual(parseReviewEvidence(text), { kind: 'measured', fails: 1, passes: 0, headFails: 0, tests: 1, srcFiles: 1, loadFailedFiles: 0 });
  // 通らない行の無い src は本数だけ・変えた行が無ければ段ごと出さない
  const allCovered = { ...result, coverage: { ...result.coverage, changed: [row('src/f.js', 2, [])] } };
  assert.equal(formatReviewEvidence(allCovered).split('\n')[1], 'src/f.js: 変えた実行行 2 のうち通らない 0');
  // 上限 (1200 字) を超えるときは src より先に範囲を畳む — 5 件の src は残り、範囲が「ほか n 範囲」へ減る
  const long = (i) => row(`src/${'deep/'.repeat(22)}module-${i}.js`, 900, Array.from({ length: 8 }, (_, j) => [1000 + j * 10, 1005 + j * 10]));
  const folded = formatReviewEvidence({ ...result, coverage: { ...result.coverage, changed: Array.from({ length: 5 }, (_, i) => long(i)) } });
  assert.ok(folded.length <= EVIDENCE_MAX_CHARS, `${folded.length} 字`);
  const foldedRows = folded.split('\n').filter((line) => line.includes(': 変えた実行行 900 のうち通らない 48'));
  assert.equal(foldedRows.length, 5, folded);
  assert.ok(foldedRows.every((line) => / ほか [4-8] 範囲\)$/.test(line) || line.endsWith('通らない 48')), folded);
  const none = { ...result, coverage: { ...result.coverage, changed: [] } };
  assert.equal(formatReviewEvidence(none), formatReviewEvidence({ ...result, coverage: { ...result.coverage, changed: undefined } }));
  assert.equal(formatReviewEvidence(none).split('\n')[1], `${COVERAGE_HEAD(1)}:`);
});

test('formatReviewEvidence: src の差分なしで測った回は、ファイルごとに足した本数と新たに覆った src の行を行の少ない順に 5 件 + ほか (1 行目は変えない)', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: [], restored: [] }, outcome: 'no-src' };
  const coverage = { supported: true, files: [{ path: 'src/m.js', before: { covered: 1, total: 2 }, after: { covered: 2, total: 2 } }] };
  const noSrc = (testFiles, extra = {}) => formatReviewEvidence({
    ...common, tests: testFiles.map(({ file }) => file), testFiles, coverage, ...extra,
  });
  const testFiles = [
    { file: 'test/b.test.js', addedTests: 2, newLines: 4 },
    { file: 'test/added.test.js', addedTests: 3, newFile: true }, // 足したファイルは行数を出さない (読み込みだけで膨らむ)
    { file: 'test/a.test.js', addedTests: 0, newLines: 0 }, // 名前を変えずに中身だけ変えた
    { file: 'test/c.test.js', addedTests: 3, newLines: 0 }, // 既に覆われた行をなぞるだけ — いちばん先
    { file: 'test/tap.test.js', addedTests: null, newLines: 1 }, // TAP が読めない回は本数を書かない
    { file: 'test/lcov.test.js', addedTests: 1, newLines: null }, // lcov の無い回は行を書かない (行数の無いファイルは後ろ)
    { file: 'test/none.test.js', addedTests: null, newLines: null }, // どちらも数えられなければ行を出さない (ほかにも数えない)
  ];
  const text = noSrc(testFiles);
  assert.equal(text, [
    'src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト 7 本・基点 0123456 (main))',
    'test/c.test.js: 足した 3 本・新たに覆った src 行 0',
    'test/a.test.js: 足した 0 本・新たに覆った src 行 0',
    'test/tap.test.js: 新たに覆った src 行 1',
    'test/b.test.js: 足した 2 本・新たに覆った src 行 4',
    'test/added.test.js: 足した 3 本・新しいファイル',
    'ほか 1 ファイル',
    `${COVERAGE_HEAD(7)}:`,
    'src/m.js 1/2 (50%) → 2/2 (100%)',
  ].join('\n'));
  assert.deepEqual(parseReviewEvidence(text), { kind: 'no-src', tests: 7 });
  assert.equal(noSrc(testFiles.slice(5)).split('\n')[1], 'test/lcov.test.js: 足した 1 本');
  assert.equal(noSrc([{ file: 'test/x.test.js', addedTests: null, newFile: true }]).split('\n')[1], 'test/x.test.js: 新しいファイル');

  // 消したテストの行はファイルの行の後ろ・カバレッジの前 (読み戻しは変わらない)
  const withDeleted = noSrc(testFiles.slice(0, 1), { deletedTests: ['test/gone.test.js'] });
  assert.deepEqual(withDeleted.split('\n').slice(1, 4), [
    'test/b.test.js: 足した 2 本・新たに覆った src 行 4',
    '消したテスト: ファイル 1 (test/gone.test.js)',
    `${COVERAGE_HEAD(1)}:`,
  ]);
  assert.deepEqual(parseReviewEvidence(withDeleted), { kind: 'no-src', tests: 1, deletedFiles: 1, vanishedNames: 0 });

  // 消したテストが無くても、上限に収まるまでファイルの行を 1 件ずつ畳む (名前は 313 字 — 2 件なら収まり、3 件では超える)
  const long = Array.from({ length: 5 }, (_, i) => ({ file: `test/${String(i).repeat(300)}.test.js`, addedTests: 1, newLines: i }));
  const tight = noSrc(long);
  assert.ok(tight.length <= EVIDENCE_MAX_CHARS, `${tight.length} 字`);
  assert.deepEqual(tight.split('\n').slice(1, 4), [
    `${long[0].file}: 足した 1 本・新たに覆った src 行 0`,
    `${long[1].file}: 足した 1 本・新たに覆った src 行 1`,
    'ほか 3 ファイル',
  ]);
});

test('formatReviewEvidence: 消したテストはカバレッジの前に 1 行 — 消したファイルの本数と名前・名前が消えたファイルごとの本数 (差分なし・テストなしでも、無ければ出さない)', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const measured = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'],
    runs: [
      { file: 'test/a.test.js', verdict: 'fails' },
      { file: 'test/b.test.js', verdict: 'passes' },
      { file: 'test/c.test.js', verdict: 'fails' },
    ],
    counts: { fails: 2, passes: 1, headFails: 0 },
    coverage: { supported: true, files: [{ path: 'src/m.js', before: { covered: 1, total: 2 }, after: { covered: 2, total: 2 } }] },
    deletedTests: ['test/gone.test.js', 'test/old.test.js'],
    // 0 本のファイル (名前を変えずに中身だけ変えた) は出さない。多い順・同じなら名前順
    vanishedTests: [{ file: 'test/a.test.js', tests: 1 }, { file: 'test/b.test.js', tests: 0 }, { file: 'test/c.test.js', tests: 3 }],
  });
  assert.equal(measured, [
    '変更前の src で落ちる 2 / 落ちない 1 / HEAD でも落ちる 0 (変更したテスト 3 本・src の差分 2 ファイル・基点 0123456 (main))',
    '落ちない: test/b.test.js',
    '消したテスト: ファイル 2 (test/gone.test.js, test/old.test.js)・消えた名前 4 本 (test/c.test.js 3, test/a.test.js 1)',
    `${COVERAGE_HEAD(3)}:`,
    'src/m.js 1/2 (50%) → 2/2 (100%)',
  ].join('\n'));
  assert.deepEqual(
    parseReviewEvidence(measured),
    { kind: 'measured', fails: 2, passes: 1, headFails: 0, tests: 3, srcFiles: 2, loadFailedFiles: 0, deletedFiles: 2, vanishedNames: 4 },
  );

  // test/ だけのタスクでもテストは消せる: 消したファイルだけ・名前が消えただけ
  const noSrc = (extra) => formatReviewEvidence({
    ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js'],
    coverage: { supported: true, files: [] }, ...extra,
  });
  assert.deepEqual(noSrc({ deletedTests: ['test/gone.test.js'] }).split('\n'), [
    'src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト 1 本・基点 0123456 (main))',
    '消したテスト: ファイル 1 (test/gone.test.js)',
    `${COVERAGE_HEAD(1)}: 触った src も覆った行数が変わった src も無い`,
  ]);
  assert.equal(noSrc({ vanishedTests: [{ file: 'test/a.test.js', tests: 2 }] }).split('\n')[1], '消したテスト: 消えた名前 2 本 (test/a.test.js 2)');
  // 何も消していない (数えて 0 本・数えられなかった) なら行を出さない
  assert.equal(noSrc({ deletedTests: [], vanishedTests: [{ file: 'test/a.test.js', tests: 0 }] }), noSrc({}));
  // テストファイルを消して src だけ変えた (走らせるテストが無い) — 消したファイルは差分から出る
  const noTests = formatReviewEvidence({ ...common, outcome: 'no-tests', tests: [], deletedTests: ['test/gone.test.js'] });
  assert.equal(noTests, '変更したテストなし — 変更前の src で走らせるものが無い (src の差分 2 ファイル・基点 0123456 (main))\n'
    + '消したテスト: ファイル 1 (test/gone.test.js)');
  assert.deepEqual(parseReviewEvidence(noTests), { kind: 'no-tests', srcFiles: 2, deletedFiles: 1, vanishedNames: 0 });

  // 名前はそれぞれ 5 つまで、残りは「ほか n」
  const many = Array.from({ length: 7 }, (_, i) => `test/d${i}.test.js`);
  assert.equal(noSrc({ deletedTests: many, vanishedTests: many.map((file, i) => ({ file, tests: 7 - i })) }).split('\n')[1],
    '消したテスト: ファイル 7 (test/d0.test.js, test/d1.test.js, test/d2.test.js, test/d3.test.js, test/d4.test.js ほか 2)'
      + '・消えた名前 28 本 (test/d0.test.js 7, test/d1.test.js 6, test/d2.test.js 5, test/d3.test.js 4, test/d4.test.js 3 ほか 2 ファイル)');

  // 上限に収まらなければ消したファイルの名前から畳み、尽きたら名前が消えたファイルを畳む
  // (名前は 413 字 — 2 つなら収まり、3 つでは 1 行目とカバレッジの行を足して上限を超える)
  const long = Array.from({ length: 5 }, (_, i) => `test/${String(i).repeat(400)}.test.js`);
  const tight = noSrc({ deletedTests: long });
  assert.ok(tight.length <= EVIDENCE_MAX_CHARS, `${tight.length} 字`);
  assert.equal(tight.split('\n')[1], `消したテスト: ファイル 5 (${long.slice(0, 2).join(', ')} ほか 3)`);
  const tighter = noSrc({ deletedTests: long, vanishedTests: long.map((file) => ({ file, tests: 1 })) }).split('\n')[1];
  assert.equal(tighter, `消したテスト: ファイル 5・消えた名前 5 本 (${long.slice(0, 2).map((file) => `${file} 1`).join(', ')} ほか 3 ファイル)`);
});

test('parseReviewEvidence: formatReviewEvidence の 1 行目を種類と本数へ読み戻す (測れなかった行も)、知らない形は unknown', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const coverage = { supported: true, files: [{ path: 'src/m.js', before: null, after: { covered: 1, total: 2 } }] };
  // 本数はすべて違う値にしておく — 読む位置がずれたら別の数が入る
  const measured = formatReviewEvidence({
    ...common,
    outcome: 'measured',
    tests: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'],
    runs: [{ file: 'test/b.test.js', verdict: 'passes' }],
    counts: { fails: 1, passes: 2, headFails: 3 },
    coverage,
  });
  assert.deepEqual(parseReviewEvidence(measured), { kind: 'measured', fails: 1, passes: 2, headFails: 3, tests: 6, srcFiles: 2, loadFailedFiles: 0 });
  const noSrc = formatReviewEvidence({
    ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js', 'test/b.test.js'], coverage,
  });
  assert.deepEqual(parseReviewEvidence(noSrc), { kind: 'no-src', tests: 2 });
  const noTests = formatReviewEvidence({ ...common, outcome: 'no-tests', tests: [] });
  assert.deepEqual(parseReviewEvidence(noTests), { kind: 'no-tests', srcFiles: 2 });
  assert.deepEqual(parseReviewEvidence(formatReviewEvidence({ outcome: 'refused', reason: '理由' })), { kind: 'unmeasured' });
  // 停止で中断した回 (予定・基点のある形と、測り始める前に止まって括弧ごと無い形) も測れずに数える
  const stopped = formatReviewEvidence({ ...common, outcome: 'stopped', planned: 4, ran: 1 });
  assert.match(stopped, /^停止で中断 — .*\(走らせたテスト 1 \/ 予定 4 回・基点 0123456 \(main\)\)$/);
  assert.deepEqual(parseReviewEvidence(stopped), { kind: 'unmeasured' });
  assert.deepEqual(parseReviewEvidence(formatReviewEvidence({ outcome: 'stopped' })), { kind: 'unmeasured' });
  // ブリッジが測れなかった回に書く行 (src/bridge/board.js の collectReviewEvidence)
  assert.deepEqual(parseReviewEvidence('測れませんでした — 本体の作業ツリー\n続き'), { kind: 'unmeasured' });

  for (const text of [undefined, null, '', '別の形の証拠', `\n${noSrc}`, noSrc.replace('変更したテスト', '変更テスト')]) {
    assert.deepEqual(parseReviewEvidence(text), { kind: 'unknown' }, JSON.stringify(text));
  }
});

test('parseReviewEvidence: 2 行目以降の消したテストの行から消したファイルと消えた名前の本数を読む (名前を畳んだ形でも)、行が無い証拠の形は変えない', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const coverage = { supported: true, files: [{ path: 'src/m.js', before: null, after: { covered: 1, total: 2 } }] };
  // 3 種類の形それぞれに消したテストの行を付ける。本数は 1 行目の本数とも違う値にしておく
  const kinds = {
    measured: {
      format: (extra) => formatReviewEvidence({
        ...common, outcome: 'measured', tests: ['test/a.test.js', 'test/b.test.js'],
        runs: [{ file: 'test/b.test.js', verdict: 'passes' }], counts: { fails: 1, passes: 1, headFails: 0 }, coverage, ...extra,
      }),
      first: { fails: 1, passes: 1, headFails: 0, tests: 2, srcFiles: 2, loadFailedFiles: 0 },
    },
    'no-src': {
      format: (extra) => formatReviewEvidence({
        ...common, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js', 'test/b.test.js'], coverage, ...extra,
      }),
      first: { tests: 2 },
    },
    'no-tests': {
      format: (extra) => formatReviewEvidence({ ...common, outcome: 'no-tests', tests: [], ...extra }),
      first: { srcFiles: 2 },
    },
  };
  const deletedTests = ['test/gone.test.js', 'test/old.test.js', 'test/x.test.js'];
  const vanishedTests = [{ file: 'test/a.test.js', tests: 4 }, { file: 'test/b.test.js', tests: 3 }];
  for (const [kind, { format, first }] of Object.entries(kinds)) {
    const both = format({ deletedTests, vanishedTests });
    assert.match(both, /\n消したテスト: ファイル 3 \(.+\)・消えた名前 7 本 \(.+\)(\n|$)/, kind);
    assert.deepEqual(parseReviewEvidence(both), { kind, ...first, deletedFiles: 3, vanishedNames: 7 }, kind);
    assert.deepEqual(parseReviewEvidence(format({ deletedTests })), { kind, ...first, deletedFiles: 3, vanishedNames: 0 }, kind);
    assert.deepEqual(parseReviewEvidence(format({ vanishedTests })), { kind, ...first, deletedFiles: 0, vanishedNames: 7 }, kind);
    // 何も消していない (数えて 0 本) — 行が無いので戻りの形は今までどおり
    const none = format({ deletedTests: [], vanishedTests: [{ file: 'test/a.test.js', tests: 0 }] });
    assert.doesNotMatch(none, /消したテスト/, kind);
    assert.deepEqual(parseReviewEvidence(none), { kind, ...first }, kind);
  }

  // 上限に収めるために名前を畳んだ形: 消したファイルの名前が「ほか n」・括弧ごと無い、名前が消えたファイルが件数だけ
  const { format, first } = kinds['no-src'];
  const long = Array.from({ length: 5 }, (_, i) => `test/${String(i).repeat(400)}.test.js`);
  const huge = Array.from({ length: 5 }, (_, i) => `test/${String(i).repeat(1100)}.test.js`);
  const folded = [
    [{ deletedTests: long }, /^消したテスト: ファイル 5 \(.+ ほか 3\)$/, 5, 0],
    [{ deletedTests: long, vanishedTests: long.map((file) => ({ file, tests: 1 })) }, /^消したテスト: ファイル 5・消えた名前 5 本 \(.+ ほか 3 ファイル\)$/, 5, 5],
    [{ deletedTests: huge, vanishedTests: huge.map((file) => ({ file, tests: 2 })) }, /^消したテスト: ファイル 5・消えた名前 10 本 \(5 ファイル\)$/, 5, 10],
    [{ vanishedTests: huge.map((file) => ({ file, tests: 2 })) }, /^消したテスト: 消えた名前 10 本 \(5 ファイル\)$/, 0, 10],
  ];
  for (const [extra, shape, deletedFiles, vanishedNames] of folded) {
    const text = format(extra);
    assert.match(text.split('\n')[1], shape);
    assert.deepEqual(parseReviewEvidence(text), { kind: 'no-src', ...first, deletedFiles, vanishedNames }, String(shape));
  }

  // 上限で末尾を切られた行 (ブリッジが「…」を付ける) は読めた本数だけ — 本数の途中で切れたら別の本数に読まない
  const head = format({}).split('\n')[0];
  assert.deepEqual(parseReviewEvidence(`${head}\n消したテスト: ファイル 12 (test/a.test.js, test/b…`), { kind: 'no-src', ...first, deletedFiles: 12, vanishedNames: 0 });
  assert.deepEqual(parseReviewEvidence(`${head}\n消したテスト: ファイル 1…`), { kind: 'no-src', ...first });
  assert.deepEqual(parseReviewEvidence(`${head}\n消したテスト: ファイル 2・消えた名前 3…`), { kind: 'no-src', ...first, deletedFiles: 2, vanishedNames: 0 });
  // 1 行目が読めない証拠は、消したテストの行があっても unknown のまま
  assert.deepEqual(parseReviewEvidence('別の形の証拠\n消したテスト: ファイル 1 (test/gone.test.js)'), { kind: 'unknown' });
});

test('parseReviewEvidence: measured の基点で読み込めずのファイル数を、読み込めずの行と畳んだ行「ほか n ファイル (うち基点で読み込めず k)」の k から読む (上限で畳んだ形でも)', () => {
  const common = { base: 'main', mergeBase: '0123456789abcdef', src: { added: ['src/n.js'], restored: ['src/m.js'] } };
  const tap = (pass, fail = 0, extra = {}) => ({ tests: pass + fail, pass, fail, ...extra });
  const loadFailed = (file) => ({ file, verdict: 'fails', head: { ok: true, tap: tap(3) }, base: { ok: false, tap: tap(0, 1, { loadFailed: true }) } });
  const fails = (file) => ({ file, verdict: 'fails', head: { ok: true, tap: tap(3) }, base: { ok: false, tap: tap(2, 1) } });
  const format = (runs, extra = {}) => formatReviewEvidence({
    ...common, outcome: 'measured', tests: runs.map((r) => r.file), runs, counts: summarizeRuns(runs), ...extra,
  });

  // 畳んだ中に読み込めずが無ければ畳んだ行は今の字面のまま
  const plain = format(Array.from({ length: 7 }, (_, i) => fails(`test/f${i}.test.js`)));
  assert.equal(plain.split('\n')[6], 'ほか 2 ファイル');
  assert.equal(parseReviewEvidence(plain).loadFailedFiles, 0);

  // 「落ちる」が全部読み込めず — 行の 5 本と畳んだ行の 2 本を足すと落ちる本数になる
  const all = format(Array.from({ length: 7 }, (_, i) => loadFailed(`test/l${i}.test.js`)));
  assert.equal(all.split('\n')[6], 'ほか 2 ファイル (うち基点で読み込めず 2)');
  assert.deepEqual(parseReviewEvidence(all), { kind: 'measured', fails: 7, passes: 0, headFails: 0, tests: 7, srcFiles: 2, loadFailedFiles: 7 });

  // 上限 (1200 字) に収めるために本数の行を畳んだ形 — 一部だけ残した形も、全部畳んだ形も読み込めずの本数が読める
  const folded = (depth) => {
    const runs = Array.from({ length: 7 }, (_, i) => loadFailed(`test/${'deep/'.repeat(depth)}l${i}.test.js`));
    const text = format(runs, { deletedTests: ['test/gone.test.js'] });
    assert.ok(text.length <= EVIDENCE_MAX_CHARS, `上限を超えた: ${text.length}`);
    assert.match(text, /^変更前の src で落ちる 7 \/ 落ちない 0 \/ HEAD でも落ちる 0 /);
    assert.equal(parseReviewEvidence(text).loadFailedFiles, 7, `depth ${depth}`);
    return text.split('\n').slice(1, -1);
  };
  // 1 行 230 字ほど — 5 行では上限を超え、4 行なら収まる
  const some = folded(40);
  assert.equal(some.length, 5);
  assert.ok(some.slice(0, 4).every((line) => / 基点で読み込めず \(HEAD で通る 3 本\)$/.test(line)), some.join('\n'));
  assert.equal(some[4], 'ほか 3 ファイル (うち基点で読み込めず 3)');
  assert.deepEqual(folded(250), ['ほか 7 ファイル (うち基点で読み込めず 7)']);

  // 旧い形 (畳んだ行に k が無い) は行だけ数え、上限で切られた畳んだ行は別の本数に読まない
  const [head, ...rows] = all.split('\n');
  assert.equal(parseReviewEvidence([head, ...rows.slice(0, 5), 'ほか 2 ファイル'].join('\n')).loadFailedFiles, 5);
  assert.equal(parseReviewEvidence([head, ...rows.slice(0, 5), 'ほか 2 ファイル (うち基点で読み込めず 2…'].join('\n')).loadFailedFiles, 5);
});

test('src の変更に依存するテスト・足した src を import するテストは落ち、依存しないテストは落ちない — 終わると HEAD に戻る', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, {
    ...TASK_CHANGES,
    // 名前を変えずに中身を変えた 'add' (足したことにならない) と、足したのに変更前の src でも通る 'add zero'
    'test/math.test.js': testFile("import { add } from '../src/math.js';\n"
      + "test('add', () => assert.equal(add(1, 2), 3));\ntest('add zero', () => assert.equal(add(5, 0), 5));\n"),
  });
  const headSha = git(wt, 'rev-parse', 'HEAD').trim();

  const result = await measureReviewEvidence({ cwd: wt, base: 'main' });

  assert.equal(result.outcome, 'measured');
  assert.equal(result.mergeBase, git(wt, 'merge-base', 'main', 'HEAD').trim());
  assert.deepEqual(result.src, { added: ['src/new.js'], restored: ['src/math.js', 'src/old.js'] });
  const verdicts = Object.fromEntries(result.runs.map((run) => [run.file, run.verdict]));
  assert.deepEqual(verdicts, {
    'test/broken.test.js': 'head-fails',
    'test/keep.test.js': 'passes',
    'test/math.test.js': 'fails', // 基点の add は a - b
    'test/new.test.js': 'fails', // 基点には src/new.js が無い
  });
  assert.deepEqual(result.counts, { fails: 2, passes: 1, headFails: 1 });
  if (readsTapSummary()) {
    // 本物の TAP: 基点に無い src/new.js を import する test/new.test.js は読み込みで落ちる (名前は OS の区切り)
    const taps = Object.fromEntries(result.runs.map((run) => [run.file, [run.head.tap, run.base.tap]]));
    assert.deepEqual(taps['test/new.test.js'], [{ tests: 1, pass: 1, fail: 0 }, { tests: 1, pass: 0, fail: 1, loadFailed: true }]);
    assert.deepEqual(taps['test/math.test.js'], [{ tests: 2, pass: 2, fail: 0 }, { tests: 2, pass: 1, fail: 1 }]);
    // 足したテスト: math は前の回 (基点の版のテスト) に無い 'add zero' だけ、足したファイルは全部
    assert.deepEqual(Object.fromEntries(result.runs.map((run) => [run.file, run.added])), {
      'test/broken.test.js': { tests: 0, fails: 0, passes: 0 }, // HEAD で通らないテストは数えない
      'test/keep.test.js': { tests: 1, fails: 0, passes: 1 },
      'test/math.test.js': { tests: 1, fails: 0, passes: 1 },
      'test/new.test.js': { tests: 1, fails: 1, passes: 0 },
    });
    assert.match(formatReviewEvidence(result), new RegExp([
      '^変更前の src で落ちる 2 \\/ 落ちない 1 \\/ HEAD でも落ちる 1 .*',
      'test\\/keep\\.test\\.js: HEAD で通る 1 本のうち 変更前の src で落ちる 0・通る 1 \\(足した 1\\/1 通る\\)',
      'test\\/math\\.test\\.js: HEAD で通る 2 本のうち 変更前の src で落ちる 1・通る 1 \\(足した 1\\/1 通る\\)',
      'test\\/new\\.test\\.js: 基点で読み込めず \\(HEAD で通る 1 本のうち 足した 1 本\\)',
      // 変えた行の段 (消した src/old.js は出ない)
      'src\\/math\\.js: 変えた実行行 1 のうち通らない 0',
      'src\\/new\\.js: 変えた実行行 1 のうち通らない 0',
      'カバレッジ ',
    ].join('\n')));
  } else {
    assert.match(formatReviewEvidence(result), new RegExp('^変更前の src で落ちる 2 \\/ 落ちない 1 \\/ HEAD でも落ちる 1 .*\\n落ちない: test\\/keep\\.test\\.js\\n'
      + `${supportsLcovReporter() ? 'src\\/math\\.js: 変えた実行行 1 のうち通らない 0\\nsrc\\/new\\.js: 変えた実行行 1 のうち通らない 0\\n' : ''}カバレッジ`));
  }
  // 前に走るのは基点にもある test/math.test.js だけ。足したテストが読む src は前が「なし」、
  // 消した src/old.js はどちらのテストも読まない
  const loaded = Object.fromEntries(result.coverage.files.map((f) => [f.path, [f.before !== null, f.after !== null]]));
  assert.deepEqual(loaded, {
    'src/keep.js': [false, true],
    'src/math.js': [true, true],
    'src/new.js': [false, true],
    'src/old.js': [false, false],
  });
  assert.ok(result.runs.every((run) => !('lcov' in run.head)), 'lcov の生テキストを結果に持ち回っている');
  assert.ok(result.runs.every((run) => !('tapCases' in run.head) && !('tapCases' in run.base)), 'テスト 1 本ずつの記録を持ち回っている');

  // 基点で落ちた回があっても、作業ツリーは HEAD のまま (D は消え、A と M は HEAD の中身)
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), headSha);
  assert.equal(existsSync(join(wt, 'src/old.js')), false, '基点から戻した D のファイルが残っている');
  assert.equal(readFileSync(join(wt, 'src/new.js'), 'utf8'), HEAD_NEW);
  assert.equal(readFileSync(join(wt, 'src/math.js'), 'utf8'), HEAD_MATH);
});

test('足したテストの突き合わせ: 前の回は基点にもあるテストの順で対応させ、前の回が読み込みで落ちた・集計の無いファイルは数えない', async (t) => {
  const { wt } = makeRepo(t, {
    ...BASE_FILES,
    'test/other.test.js': testFile("test('o', () => {});\n"),
    'test/third.test.js': testFile("test('t', () => {});\n"),
  }, {
    ...TASK_CHANGES,
    'test/other.test.js': testFile("test('o', () => {});\ntest('o2', () => {});\n"),
    'test/third.test.js': testFile("test('t', () => {});\ntest('t2', () => {});\n"),
  });
  const c = (name, pass = true) => ({ name, type: 'test', pass });
  // ファイルごとに 1 回目 = HEAD、2 回目 = src だけ基点、3 回目 = 前 (基点の版のテスト)。無い回は集計の無い回
  const CASES = {
    'test/keep.test.js': [[c('keep')], [c('keep')]],
    // 前の回が読み込みで落ちた (基点の版のテストの名前が分からない)
    'test/math.test.js': [[c('add'), c('add zero')], [c('add', false), c('add zero')], [c('test\\math.test.js', false)]],
    'test/other.test.js': [[c('o'), c('o2')], [c('o'), c('o2')], [c('o')]],
    // 前の回が時間切れ (集計が無い)
    'test/third.test.js': [[c('t'), c('t2')], [c('t'), c('t2', false)]],
  };
  const calls = new Map();
  const runTest = async ({ file }) => {
    const n = calls.get(file) ?? 0;
    calls.set(file, n + 1);
    const cases = CASES[file]?.[n];
    if (!cases) return { ok: true };
    const pass = cases.filter((x) => x.pass).length;
    const loadFailed = cases[0].name === file.replace('/', '\\');
    return {
      ok: pass === cases.length,
      tap: { tests: cases.length, pass, fail: cases.length - pass, ...(loadFailed ? { loadFailed: true } : {}) },
      tapCases: cases,
    };
  };

  const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest });

  assert.deepEqual([...calls].filter(([, n]) => n === 3).map(([file]) => file), ['test/math.test.js', 'test/other.test.js', 'test/third.test.js']);
  assert.deepEqual(Object.fromEntries(result.runs.filter((run) => run.added).map((run) => [run.file, run.added])), {
    'test/keep.test.js': { tests: 1, fails: 0, passes: 1 }, // 足したファイルは前の回が無くても全部足した
    'test/other.test.js': { tests: 1, fails: 0, passes: 1 },
  });
  assert.deepEqual(formatReviewEvidence(result).split('\n').slice(1, 5), [
    'test/other.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 0・通る 2 (足した 1/1 通る)',
    'test/keep.test.js: HEAD で通る 1 本のうち 変更前の src で落ちる 0・通る 1 (足した 1/1 通る)',
    'test/math.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 1・通る 1', // 数えられないファイルは従来の行
    'test/third.test.js: HEAD で通る 2 本のうち 変更前の src で落ちる 1・通る 1',
  ]);
});

test('消えた名前は HEAD の回と前の回の両方で名前を読めたファイルだけ数える (HEAD が読み込みで落ちた・前の回が無いファイルは数えない)', async (t) => {
  const { wt } = makeRepo(t, {
    ...BASE_FILES,
    'test/other.test.js': testFile("test('o', () => {});\n"),
    'test/third.test.js': testFile("test('t', () => {});\n"),
  }, {
    ...TASK_CHANGES,
    'test/other.test.js': testFile("test('o2', () => {});\n"),
    'test/third.test.js': testFile("test('t2', () => {});\n"),
  });
  const c = (name, pass = true) => ({ name, type: 'test', pass });
  // ファイルごとに 1 回目 = HEAD、2 回目 = src だけ基点、3 回目 = 前 (基点の版のテスト)。無い回は集計の無い回
  const CASES = {
    'test/keep.test.js': [[c('keep')], [c('keep')]], // 足したファイル: 何も消えていない
    'test/math.test.js': [[c('add')], [c('add', false)], [c('add'), c('sub')]], // 'sub' を消した
    // HEAD の回が読み込みで落ちた (名前はファイル名 1 本 — 前の回の 'o' が消えて見えるが、数えない)
    'test/other.test.js': [[c('test\\other.test.js', false)], [c('test\\other.test.js', false)], [c('o')]],
    // 前の回が時間切れ (集計が無い)
    'test/third.test.js': [[c('t2')], [c('t2')]],
  };
  const calls = new Map();
  const runTest = async ({ file }) => {
    const n = calls.get(file) ?? 0;
    calls.set(file, n + 1);
    const cases = CASES[file]?.[n];
    if (!cases) return { ok: true };
    const pass = cases.filter((x) => x.pass).length;
    const loadFailed = cases[0].name === file.replace('/', '\\');
    return {
      ok: pass === cases.length,
      tap: { tests: cases.length, pass, fail: cases.length - pass, ...(loadFailed ? { loadFailed: true } : {}) },
      tapCases: cases,
    };
  };

  const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest });

  // broken / new は HEAD の回に名前が無い (集計の無い回) ので数えない
  assert.deepEqual(result.vanishedTests, [{ file: 'test/keep.test.js', tests: 0 }, { file: 'test/math.test.js', tests: 1 }]);
  assert.deepEqual(result.deletedTests, []);
  const lines = formatReviewEvidence(result).split('\n');
  assert.equal(lines[lines.findIndex((line) => line.startsWith('カバレッジ ')) - 1], '消したテスト: 消えた名前 1 本 (test/math.test.js 1)');
});

test('本物の node: 差分で消したテストファイルは走らせずに名前を出し、変更したファイルから消えた名前を数える (src の差分あり・なし・テストを走らせない回)', async (t) => {
  const base = {
    ...BASE_FILES,
    'test/math.test.js': testFile("import { add } from '../src/math.js';\n"
      + "test('add', () => assert.equal(typeof add, 'function'));\ntest('sub', () => {});\ntest('old name', () => {});\n"),
    // 基点の add (a - b) を固定していたテスト — HEAD の add では落ちるので、task が消す
    'test/gone.test.js': testFile("import { add } from '../src/math.js';\ntest('subtracts', () => assert.equal(add(3, 1), 2));\n"),
  };
  // 'sub' を消し、'old name' を 'new name' に改名した (どちらも消えた名前)
  const math = testFile("import { add } from '../src/math.js';\n"
    + "test('add', () => assert.equal(typeof add, 'function'));\ntest('new name', () => {});\n");
  const counted = readsTapSummary() && supportsLcovReporter();
  const line = counted
    ? '消したテスト: ファイル 1 (test/gone.test.js)・消えた名前 2 本 (test/math.test.js 2)'
    : '消したテスト: ファイル 1 (test/gone.test.js)';

  for (const [label, changes, outcome] of [
    ['src の差分あり', { 'src/math.js': HEAD_MATH, 'test/math.test.js': math, 'test/gone.test.js': null }, 'measured'],
    ['test/ だけ', { 'test/math.test.js': math, 'test/gone.test.js': null }, 'no-src'],
  ]) {
    const { wt } = makeRepo(t, base, changes);
    const seen = [];
    const result = await measureReviewEvidence({
      cwd: wt,
      base: 'main',
      runTest: (options) => {
        seen.push(options.file);
        return runTestFile(options);
      },
    });
    assert.equal(result.outcome, outcome, label);
    assert.ok(seen.every((file) => file === 'test/math.test.js'), `${label}: 消したファイルを走らせた: ${seen}`);
    assert.deepEqual(result.deletedTests, ['test/gone.test.js'], label);
    assert.deepEqual(result.vanishedTests, counted ? [{ file: 'test/math.test.js', tests: 2 }] : [], label);
    const lines = formatReviewEvidence(result).split('\n');
    // 消したテストの行はカバレッジの段の前 (変えた行の段があればその前)
    const beforeCoverage = lines.slice(0, lines.findIndex((l) => l.startsWith('カバレッジ ')))
      .filter((l) => !/^src\/.*: 変えた実行行 /.test(l));
    assert.equal(beforeCoverage.at(-1), line, `${label}: ${lines.join('\n')}`);
    assert.equal(git(wt, 'status', '--porcelain'), '', label);
    assert.equal(existsSync(join(wt, 'test/gone.test.js')), false, `${label}: 前の回に戻した消したテストが残っている`);
  }

  // テストを走らせない回 (消しただけ・テストを消して src だけ変えた) でも、消したファイルは差分から出る
  const never = async () => assert.fail('走らせた');
  for (const [changes, outcome] of [
    [{ 'test/gone.test.js': null }, 'no-src'],
    [{ 'src/math.js': HEAD_MATH, 'test/gone.test.js': null }, 'no-tests'],
  ]) {
    const { wt } = makeRepo(t, base, changes);
    const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest: never });
    assert.equal(result.outcome, outcome);
    assert.equal(formatReviewEvidence(result).split('\n')[1], '消したテスト: ファイル 1 (test/gone.test.js)', outcome);
  }
});

test('基点の回は src が基点の版になっている・途中でテストの実行が投げても HEAD に戻してから投げ直す', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const seen = [];
  const runTest = async ({ cwd, file }) => {
    seen.push({
      file,
      math: readFileSync(join(cwd, 'src/math.js'), 'utf8'),
      hasNew: existsSync(join(cwd, 'src/new.js')),
      hasOld: existsSync(join(cwd, 'src/old.js')),
    });
    if (seen.length === 6) throw new Error('テストの実行が壊れた');
    return { ok: true };
  };

  await assert.rejects(measureReviewEvidence({ cwd: wt, base: 'main', runTest }), /テストの実行が壊れた/);

  assert.equal(seen.length, 6);
  for (const s of seen.slice(0, 4)) assert.deepEqual([s.math, s.hasNew, s.hasOld], [HEAD_MATH, true, false], `HEAD の回: ${s.file}`);
  for (const s of seen.slice(4)) {
    assert.deepEqual([s.math, s.hasNew, s.hasOld], [BASE_FILES['src/math.js'], false, true], `基点の回: ${s.file}`);
  }
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(wt, 'src/old.js')), false);
  assert.equal(readFileSync(join(wt, 'src/new.js'), 'utf8'), HEAD_NEW);
});

test('カバレッジの前の回は src と test/ が基点の版 (補助も戻し、足したテストは消す)・走るのは基点にもあるテストだけ', async (t) => {
  const { wt } = makeRepo(t, { ...BASE_FILES, 'test/helpers.js': 'export const v = "base";\n' }, {
    ...TASK_CHANGES,
    'test/helpers.js': 'export const v = "head";\n',
    'test/fixture.txt': 'added\n',
  });
  const read = (cwd, rel) => (existsSync(join(cwd, rel)) ? readFileSync(join(cwd, rel), 'utf8') : null);
  const seen = [];
  const runTest = async ({ cwd, file, coverage }) => {
    seen.push({
      file,
      coverage,
      math: read(cwd, 'src/math.js'),
      mathTest: read(cwd, 'test/math.test.js'),
      helpers: read(cwd, 'test/helpers.js'),
      added: [read(cwd, 'test/new.test.js'), read(cwd, 'test/fixture.txt')],
    });
    // HEAD の回は 2 行とも覆い、前の回は 1 行だけ (Windows の区切りの SF)
    return { ok: true, lcov: `SF:src\\math.js\nDA:1,1\nDA:2,${coverage && seen.length > 8 ? 0 : 1}\nend_of_record\n` };
  };

  const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest });

  assert.deepEqual(seen.map((s) => [s.file, s.coverage]), [
    ...result.tests.map((file) => [file, true]), // HEAD (後を兼ねる)
    ...result.tests.map((file) => [file, false]), // src だけ基点 (落ちる / 落ちない)
    ['test/math.test.js', true], // 前: 足したテスト (new / keep / broken) は基点に無いので走らせない
  ]);
  const before = seen.at(-1);
  assert.deepEqual(
    [before.math, before.mathTest, before.helpers, before.added],
    [BASE_FILES['src/math.js'], BASE_FILES['test/math.test.js'], 'export const v = "base";\n', [null, null]],
  );
  for (const s of seen.slice(4, 8)) assert.equal(s.mathTest, TASK_CHANGES['test/math.test.js'], `落ちる / 落ちないの回は HEAD のテスト: ${s.file}`);
  assert.deepEqual(result.coverage.files.find((f) => f.path === 'src/math.js'), {
    path: 'src/math.js', before: { covered: 1, total: 2 }, after: { covered: 2, total: 2 },
  });
  // test/ も HEAD へ戻る (足したテストと補助は HEAD の中身)
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(read(wt, 'test/helpers.js'), 'export const v = "head";\n');
  assert.equal(read(wt, 'test/fixture.txt'), 'added\n');
  assert.equal(read(wt, 'test/math.test.js'), TASK_CHANGES['test/math.test.js']);
});

test('本物の node: 変更したテストが覆った行は前後で比べられ、触ったのに読まれない src・覆い方の変わらない src の扱いも決まっている', async (t) => {
  const calc = (op) => `export function add(a, b) {\n  return a ${op} b;\n}\n\nexport function mul(a, b) {\n  const product = a * b;\n  return product;\n}\n`;
  const { wt } = makeRepo(t, {
    'src/calc.js': calc('-'),
    'src/util.js': 'export const id = (x) => x;\n',
    'src/other.js': 'export const other = 1;\n',
    // 基点の版のテストは calc.js を基点の版の補助から読む。HEAD の補助には plus が無いので、
    // 補助を戻さないと読み込みで落ちて calc.js が前の回に現れない
    'test/helper.js': "export { add as plus } from '../src/calc.js';\n",
    'test/calc.test.js': testFile("import { plus } from './helper.js';\nimport { id } from '../src/util.js';\n"
      + "test('add', () => assert.equal(typeof plus(id(1), 2), 'number'));\n"),
  }, {
    'src/calc.js': calc('+'),
    'src/other.js': 'export const other = 2;\n', // 触ったが、どのテストも読まない
    'test/helper.js': 'export const numbers = [1, 2];\n',
    'test/calc.test.js': testFile("import { add, mul } from '../src/calc.js';\nimport { id } from '../src/util.js';\n"
      + "import { numbers } from './helper.js';\ntest('add', () => assert.equal(add(id(numbers[0]), numbers[1]), 3));\n"
      + "test('mul', () => assert.equal(mul(2, 3), 6));\n"),
  });

  const result = await measureReviewEvidence({ cwd: wt, base: 'main' });

  assert.equal(result.outcome, 'measured');
  assert.equal(result.runs[0].verdict, 'fails');
  // src/util.js は前後とも同じだけ覆うので出ない。差の大きい calc.js が先、触っただけの other.js が後
  assert.deepEqual(result.coverage.files.map((f) => f.path), ['src/calc.js', 'src/other.js']);
  const [calcFile, other] = result.coverage.files;
  assert.ok(calcFile.before && calcFile.after, `前の回で calc.js が読まれていない: ${JSON.stringify(calcFile)}`);
  assert.equal(calcFile.before.total, calcFile.after.total);
  assert.ok(calcFile.before.covered < calcFile.after.covered, `mul を呼ぶ HEAD のテストのほうが多く覆う: ${JSON.stringify(calcFile)}`);
  assert.deepEqual([other.before, other.after], [null, null]);
  assert.match(formatReviewEvidence(result), /\nsrc\/calc\.js \d+\/\d+ \(\d+%\) → \d+\/\d+ \(\d+%\)\nsrc\/other\.js なし → なし$/);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('本物の node: src に足した分岐のうち、変更したテストが呼ばない分岐の行は「通らない」に出て、呼ぶ分岐の行は出ない', async (t) => {
  const sign = (extra) => "export function sign(n) {\n  if (n > 0) {\n    return 'plus';\n  }\n"
    + `${extra}  return 'zero';\n}\n`;
  const { wt } = makeRepo(t, {
    'src/sign.js': sign(''),
    'test/sign.test.js': testFile("import { sign } from '../src/sign.js';\ntest('plus', () => assert.equal(sign(1), 'plus'));\n"),
  }, {
    // 5-7 行目の負の分岐はテストが呼び、8-10 行目の NaN の分岐はどのテストも呼ばない
    'src/sign.js': sign("  if (n < 0) {\n    return 'minus';\n  }\n  if (Number.isNaN(n)) {\n    return 'nan';\n  }\n"),
    'test/sign.test.js': testFile("import { sign } from '../src/sign.js';\ntest('plus', () => assert.equal(sign(1), 'plus'));\n"
      + "test('minus', () => assert.equal(sign(-1), 'minus'));\ntest('zero', () => assert.equal(sign(0), 'zero'));\n"),
  });

  const result = await measureReviewEvidence({ cwd: wt, base: 'main' });

  assert.equal(result.outcome, 'measured');
  const [row] = result.coverage.changed;
  assert.equal(row.path, 'src/sign.js');
  assert.equal(result.coverage.changed.length, 1);
  const untested = row.ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
  assert.ok(untested.includes(9), `呼ばない分岐 (return 'nan') が出ない: ${JSON.stringify(row)}`);
  assert.ok(untested.every((lineNo) => lineNo >= 8 && lineNo <= 10), `呼ぶ分岐の行が出た: ${JSON.stringify(row)}`);
  assert.equal(row.untested, untested.length);
  assert.ok(row.changed >= 4 && row.changed <= 6, `変えた実行行は 5-10 行目のうち DA に出た行: ${JSON.stringify(row)}`);
  assert.match(formatReviewEvidence(result), new RegExp(`\\nsrc/sign\\.js: 変えた実行行 ${row.changed} のうち通らない ${row.untested} \\(L`));
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('lcov の reporter の無い Node ではカバレッジを付けずに走らせ、前の回も走らせない (src の差分が無ければ何も走らせない)', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const calls = [];
  const runTest = async ({ file, coverage }) => {
    calls.push([file, coverage]);
    return { ok: true };
  };
  const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest, nodeVersion: '20.10.0' });
  assert.equal(result.outcome, 'measured');
  assert.equal(calls.length, 8);
  assert.ok(calls.every(([, coverage]) => coverage === false), JSON.stringify(calls));
  assert.deepEqual(result.coverage, { supported: false, node: '20.10.0' });
  assert.match(formatReviewEvidence(result), /\nカバレッジは測れない \(Node v20\.10\.0\)$/);

  const onlyTests = makeRepo(t, BASE_FILES, { 'test/keep.test.js': TASK_CHANGES['test/keep.test.js'] });
  const noSrc = await measureReviewEvidence({
    cwd: onlyTests.wt, base: 'main', runTest: async () => assert.fail('走らせた'), nodeVersion: '21.1.0',
  });
  assert.equal(noSrc.outcome, 'no-src');
  assert.deepEqual(noSrc.coverage, { supported: false, node: '21.1.0' });
});

test('終わった後に src/ が HEAD に戻らなければ投げる (テストが src/ に置いた未追跡のファイル)', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  let calls = 0;
  const runTest = async ({ cwd }) => {
    calls += 1;
    if (calls === 5) writeFileSync(join(cwd, 'src/junk.js'), 'x\n');
    return { ok: true };
  };
  await assert.rejects(
    measureReviewEvidence({ cwd: wt, base: 'main', runTest }),
    /作業ツリーが HEAD に戻りませんでした: .*src\/junk\.js/,
  );
});

/** 基点の版へ書き換える git (戻しの `checkout --no-overlay HEAD` は含めない) */
const REWRITES = /^(?:checkout (?!--no-overlay HEAD )|rm )/;
/** カバレッジの前の回まで予定に入る版 (テストを差し替える回で予定の回数を固定する) */
const NODE_WITH_LCOV = '22.17.0';

test('停止: 始めから立っていれば git を何も打たずに stopped、読むだけの段で立てば書き換える git を打たずに基点と予定を添えて返す', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const never = async () => assert.fail('走らせた');
  const early = recordingGit();
  const first = await measureReviewEvidence({ cwd: wt, base: 'main', git: early.fn, runTest: never, handle: { stopRequested: true } });
  assert.deepEqual(first, { outcome: 'stopped', base: 'main', ran: 0 });
  assert.deepEqual(early.calls, []);
  assert.equal(formatReviewEvidence(first), '停止で中断 — src と test/ は HEAD へ戻した'); // 予定も基点も無いので括弧ごと省く

  // diff を読んだところで停止が来た
  const handle = { stopRequested: false };
  const late = recordingGit();
  const stopOnDiff = async (root, args) => {
    const out = await late.fn(root, args);
    if (args[0] === 'diff') handle.stopRequested = true;
    return out;
  };
  const result = await measureReviewEvidence({ cwd: wt, base: 'main', git: stopOnDiff, runTest: never, handle, nodeVersion: NODE_WITH_LCOV });
  assert.equal(result.outcome, 'stopped');
  // 予定 = HEAD 4 本 + src だけ基点 4 本 + カバレッジの前 (基点にもある test/math.test.js) 1 本
  assert.deepEqual([result.ran, result.planned], [0, 9]);
  assert.deepEqual(late.calls.filter((c) => !READ_ONLY.test(c)), [], `書き換える git を打った: ${late.calls.join(' | ')}`);
  const short = git(wt, 'merge-base', 'main', 'HEAD').trim().slice(0, 7);
  assert.equal(formatReviewEvidence(result), `停止で中断 — src と test/ は HEAD へ戻した (走らせたテスト 0 / 予定 9 回・基点 ${short} (main))`);
});

test('停止: HEAD の回の途中で立てば残りを走らせず、基点の版へ書き換えずに stopped (runTest へ handle を渡す)', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const handle = { stopRequested: false };
  const files = [];
  const runTest = async (options) => {
    assert.equal(options.handle, handle, 'runTest へ handle を渡していない');
    files.push(options.file);
    if (files.length === 2) handle.stopRequested = true; // 2 本目が走り終わった後に停止が来た
    return { ok: true };
  };
  const { fn, calls } = recordingGit();
  const result = await measureReviewEvidence({ cwd: wt, base: 'main', git: fn, runTest, handle, nodeVersion: NODE_WITH_LCOV });
  assert.deepEqual([result.outcome, result.ran, result.planned], ['stopped', 2, 9]);
  assert.equal(files.length, 2, `停止の後も走らせた: ${files.join(', ')}`);
  assert.deepEqual(calls.filter((c) => REWRITES.test(c)), [], `基点の版へ書き換えた: ${calls.join(' | ')}`);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('停止: 基点の回で撃たれたらカバレッジの前の回へ進まず、src と test/ を HEAD へ戻してから stopped (撃たれた回は数えない)', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const handle = { stopRequested: false };
  let ran = 0;
  const runTest = async () => {
    ran += 1;
    if (ran < 6) return { ok: true };
    // 基点の回の 2 本目の途中で handle.abort が来た (spawnTest が印を立て、撃った回を aborted で返す)
    handle.stopRequested = true;
    return { ok: false, aborted: true };
  };
  const { fn, calls } = recordingGit();
  const result = await measureReviewEvidence({ cwd: wt, base: 'main', git: fn, runTest, handle, nodeVersion: NODE_WITH_LCOV });
  assert.deepEqual([result.outcome, result.ran, result.planned, ran], ['stopped', 5, 9, 6]);
  const mergeBase = git(wt, 'merge-base', 'main', 'HEAD').trim();
  // 書き換えたのは基点の回の src だけ — test/ を基点へ戻す段 (カバレッジの前) には進まない
  assert.deepEqual(
    calls.filter((c) => REWRITES.test(c)).map((c) => c.replace(mergeBase, 'BASE')),
    ['checkout BASE -- src/math.js src/old.js', 'rm -q -- src/new.js'],
  );
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(wt, 'src/old.js')), false);
  assert.equal(readFileSync(join(wt, 'src/new.js'), 'utf8'), HEAD_NEW);
  assert.equal(readFileSync(join(wt, 'src/math.js'), 'utf8'), HEAD_MATH);
  assert.equal(
    formatReviewEvidence(result),
    `停止で中断 — src と test/ は HEAD へ戻した (走らせたテスト 5 / 予定 9 回・基点 ${mergeBase.slice(0, 7)} (main))`,
  );
});

test('本体の作業ツリーでは何も触らずに断る (git は読むだけ・テストも走らせない)', async (t) => {
  const { repo } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  git(repo, 'checkout', '-q', '--detach', 'task/1'); // 本体が task の中身を指していても (差分があっても) 断る
  const { fn, calls } = recordingGit();
  let ran = 0;
  const result = await measureReviewEvidence({ cwd: repo, base: 'main', git: fn, runTest: async () => { ran += 1; return { ok: true }; } });

  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, /本体の作業ツリー/);
  assert.equal(ran, 0);
  assert.deepEqual(calls.filter((c) => !READ_ONLY.test(c)), [], `書き換える git を打った: ${calls.join(' | ')}`);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('src/ か test/ が dirty なら何も触らずに断る (未コミットの変更を消さない)', async (t) => {
  const { wt } = makeRepo(t, BASE_FILES, TASK_CHANGES);
  const edited = 'export const add = () => 42;\n';
  writeFileSync(join(wt, 'src/math.js'), edited);
  const { fn, calls } = recordingGit();
  const result = await measureReviewEvidence({ cwd: wt, base: 'main', git: fn, runTest: async () => assert.fail('走らせた') });
  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, /未コミットの変更がある \(1 件: {2}M src\/math\.js\)/);
  assert.deepEqual(calls.filter((c) => !READ_ONLY.test(c)), []);
  assert.equal(readFileSync(join(wt, 'src/math.js'), 'utf8'), edited);

  git(wt, 'checkout', '--', 'src');
  write(wt, 'test/draft.test.js', 'x\n'); // 未追跡も dirty
  const again = await measureReviewEvidence({ cwd: wt, base: 'main', runTest: async () => assert.fail('走らせた') });
  assert.equal(again.outcome, 'refused');
  assert.match(again.reason, /\?\? test\/draft\.test\.js/);
  assert.equal(existsSync(join(wt, 'test/draft.test.js')), true);
});

test('src の差分なしは落ちる / 落ちないの代わりにカバレッジだけ測り、テスト変更なしはエラーにせず 1 行で返してテストを走らせない', async (t) => {
  const never = async () => assert.fail('走らせた');
  const onlyTests = makeRepo(t, BASE_FILES, { 'test/keep.test.js': TASK_CHANGES['test/keep.test.js'], 'docs/a.md': 'x\n' });
  const noSrc = await measureReviewEvidence({ cwd: onlyTests.wt, base: 'main' });
  assert.equal(noSrc.outcome, 'no-src');
  assert.equal(noSrc.runs, undefined);
  // 足したテストは基点に無いので前は「なし」
  assert.deepEqual(noSrc.coverage.files.map((f) => [f.path, f.before, f.after !== null]), [['src/keep.js', null, true]]);
  // 足したテストファイルは行数の代わりに「新しいファイル」(本数は TAP の名前を読む版だけ)
  const keepRow = `test/keep.test.js: ${readsTapSummary() ? '足した 1 本・' : ''}新しいファイル`;
  assert.match(formatReviewEvidence(noSrc), new RegExp(`^src の差分なし — .*変更したテスト 1 本.*\\n${keepRow.replace(/\./g, '\\.')}\\n`
    + 'カバレッジ .*\\nsrc/keep\\.js なし → \\d+/\\d+ \\(\\d+%\\)$'));
  assert.equal(git(onlyTests.wt, 'status', '--porcelain'), '');

  // src/ の無いリポジトリ: HEAD に無い src の pathspec で、前の回に戻した test/ の復元まで止まらない
  const noSrcDir = makeRepo(t, { 'lib/a.js': 'export const a = 1;\n', 'test/a.test.js': testFile("test('a', () => {});\n") }, {
    'test/a.test.js': testFile("import { a } from '../lib/a.js';\ntest('a', () => assert.equal(a, 1));\n"),
  });
  const libOnly = await measureReviewEvidence({ cwd: noSrcDir.wt, base: 'main' });
  assert.deepEqual([libOnly.outcome, libOnly.coverage.files], ['no-src', []]);
  assert.equal(git(noSrcDir.wt, 'status', '--porcelain'), '');

  const onlySrc = makeRepo(t, BASE_FILES, { 'src/math.js': HEAD_MATH, 'test/helpers.js': 'x\n' });
  const noTests = await measureReviewEvidence({ cwd: onlySrc.wt, base: 'main', runTest: never });
  assert.equal(noTests.outcome, 'no-tests');
  assert.match(formatReviewEvidence(noTests), /^変更したテストなし — .*src の差分 1 ファイル/);
});

test('src の差分なしの足した本数と新たに覆った行: HEAD の回と前の回だけで数え (走らせる回数は増えない)、数えられない側は null', async (t) => {
  const tests = ['fifth', 'fourth', 'other', 'third'];
  const { wt } = makeRepo(t, {
    ...BASE_FILES,
    ...Object.fromEntries(tests.map((name) => [`test/${name}.test.js`, testFile(`test('${name}', () => {});\n`)])),
  }, {
    'test/math.test.js': testFile("test('add', () => {});\ntest('add zero', () => {});\n"),
    'test/keep.test.js': TASK_CHANGES['test/keep.test.js'],
    ...Object.fromEntries(tests.map((name) => [`test/${name}.test.js`, testFile(`test('${name}', () => {});\ntest('more', () => {});\n`)])),
  });
  const c = (name, pass = true) => ({ name, type: 'test', pass });
  const lcov = (path, lines) => `SF:${path}\n${lines.map((n) => `DA:${n},1`).join('\n')}\nend_of_record\n`;
  const run = (cases, lcovText, extra = {}) => ({ ok: true, tap: { tests: cases.length, pass: cases.length, fail: 0 }, tapCases: cases, lcov: lcovText, ...extra });
  // ファイルごとに 1 回目 = HEAD、2 回目 = 前 (基点の版のテスト)。足したファイル (keep) は 1 回だけ
  const RUNS = {
    // 前に覆った行 {1, 2}・HEAD は {2, 3} — 覆った行数は同じでも 3 行目は新たに覆った
    'test/math.test.js': [run([c('add'), c('add zero')], lcov('src/math.js', [2, 3])), run([c('add')], lcov('src/math.js', [1, 2]))],
    'test/keep.test.js': [run([c('keep')], lcov('src/keep.js', [1]))],
    // HEAD の stdout が上限を超えた (集計はあるが名前が無い) — 本数は出さず、行は数える
    'test/fourth.test.js': [{ ...run([], lcov('src/keep.js', [1])), tapCases: undefined }, run([c('fourth')], '')],
    // 前の回が読み込みで落ちた — 名前も分からず、読み込みで覆う行まで差に入るので行も数えない
    'test/other.test.js': [run([c('other'), c('more')], lcov('src/keep.js', [1])),
      run([c('test\\other.test.js', false)], '', { ok: false, tap: { tests: 1, pass: 0, fail: 1, loadFailed: true } })],
    // 前の回が時間切れ (集計も lcov も無い)
    'test/third.test.js': [run([c('third'), c('more')], lcov('src/keep.js', [1])), { ok: false, timedOut: true, lcov: null }],
    // HEAD の回が時間切れ
    'test/fifth.test.js': [{ ok: false, timedOut: true, lcov: null }, run([c('fifth')], '')],
  };
  const calls = new Map();
  const runTest = async ({ file }) => {
    const n = calls.get(file) ?? 0;
    calls.set(file, n + 1);
    return RUNS[file][n];
  };

  const result = await measureReviewEvidence({ cwd: wt, base: 'main', runTest, nodeVersion: NODE_WITH_LCOV });

  assert.equal(result.outcome, 'no-src');
  assert.deepEqual(Object.fromEntries(calls), Object.fromEntries(Object.entries(RUNS).map(([file, runs]) => [file, runs.length])));
  assert.deepEqual(result.testFiles, [
    { file: 'test/fifth.test.js', addedTests: null, newLines: null },
    { file: 'test/fourth.test.js', addedTests: null, newLines: 1 },
    { file: 'test/keep.test.js', addedTests: 1, newFile: true },
    { file: 'test/math.test.js', addedTests: 1, newLines: 1 },
    { file: 'test/other.test.js', addedTests: null, newLines: null },
    { file: 'test/third.test.js', addedTests: null, newLines: null },
  ]);
  assert.deepEqual(formatReviewEvidence(result).split('\n').slice(0, 5), [
    `src の差分なし — 変更前の src に戻して測れるものが無い (変更したテスト 6 本・基点 ${result.mergeBase.slice(0, 7)} (main))`,
    'test/math.test.js: 足した 1 本・新たに覆った src 行 1',
    'test/fourth.test.js: 新たに覆った src 行 1',
    'test/keep.test.js: 足した 1 本・新しいファイル',
    `${COVERAGE_HEAD(6)}:`,
  ]);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('本物の node: src の差分なしで、既に覆われた行をなぞるだけのテストは新たに覆った行 0・新しい行を覆うテストは 1 以上', async (t) => {
  const SIGN = 'export function sign(n) {\n  if (n > 0) return 1;\n  if (n < 0) return -1;\n  return 0;\n}\n';
  const signTest = (body) => testFile(`import { sign } from '../src/sign.js';\n${body}`);
  const { wt } = makeRepo(t, {
    'src/sign.js': SIGN,
    'test/again.test.js': signTest("test('positive', () => assert.equal(sign(2), 1));\n"),
    'test/neg.test.js': signTest("test('positive', () => assert.equal(sign(2), 1));\n"),
  }, {
    'test/again.test.js': signTest("test('positive', () => assert.equal(sign(2), 1));\n"
      + "test('positive again', () => assert.equal(sign(5), 1));\n"),
    'test/neg.test.js': signTest("test('positive', () => assert.equal(sign(2), 1));\n"
      + "test('negative', () => assert.equal(sign(-1), -1));\n"),
  });

  const result = await measureReviewEvidence({ cwd: wt, base: 'main' });

  assert.equal(result.outcome, 'no-src');
  const [again, neg] = result.testFiles;
  assert.deepEqual([again.file, again.newLines], ['test/again.test.js', 0]);
  assert.equal(neg.file, 'test/neg.test.js');
  assert.ok(neg.newLines >= 1, `新たに覆った行 ${neg.newLines}`);
  if (readsTapSummary()) assert.deepEqual([again.addedTests, neg.addedTests], [1, 1]);
  assert.equal(formatReviewEvidence(result).split('\n')[1], `test/again.test.js: ${readsTapSummary() ? '足した 1 本・' : ''}新たに覆った src 行 0`);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('runTestFile は子の env から NODE_TEST_CONTEXT を外し、node へファイル名を配列で渡す', async () => {
  let captured = null;
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const result = await runTestFile({
    cwd: 'somewhere',
    file: 'test/a.test.js',
    env: { PATH: 'p', NODE_TEST_CONTEXT: 'child-v8' },
    spawnImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, nodeTestArgs('test/a.test.js'));
  assert.equal(captured.opts.cwd, 'somewhere');
  assert.equal(captured.opts.shell, undefined);
  assert.deepEqual(captured.opts.env, { PATH: 'p' });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

const lcovDestination = (args) => args.find((arg) => /^--test-reporter-destination=(?!stdout$)/.test(arg))
  ?.slice('--test-reporter-destination='.length);

test('runTestFile: coverage なら lcov を mkdtemp の一時ファイルへ出させて中身を返し、一時ディレクトリは消す', async () => {
  let captured = null;
  const result = await runTestFile({
    cwd: 'somewhere',
    file: 'test/a.test.js',
    env: {},
    coverage: true,
    spawnImpl: (cmd, args) => {
      captured = args;
      const child = fakeChild();
      setImmediate(() => {
        writeFileSync(lcovDestination(args), 'SF:src/a.js\nDA:1,1\nend_of_record\n');
        child.emit('close', 0);
      });
      return child;
    },
  });
  const lcovPath = lcovDestination(captured);
  assert.deepEqual(captured, nodeTestArgs('test/a.test.js', { lcovPath }));
  assert.equal(result.ok, true);
  assert.equal(result.lcov, 'SF:src/a.js\nDA:1,1\nend_of_record\n');
  assert.equal(existsSync(dirname(lcovPath)), false, '一時ディレクトリが残っている');

  // 起動できなかった回は lcov が書かれない — null で返し、やはり消す
  let failedPath = null;
  const failed = await runTestFile({
    cwd: 'somewhere',
    file: 'test/a.test.js',
    env: {},
    coverage: true,
    spawnImpl: (cmd, args) => {
      failedPath = lcovDestination(args);
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual([failed.ok, failed.lcov, failed.error], [false, null, 'spawn failed: ENOENT']);
  assert.match(failed.tail, /spawn failed: ENOENT/);
  assert.equal(existsSync(dirname(failedPath)), false);
});

/** 出力を書いてから、読み終わったところで閉じる子 */
const writingSpawn = (text, code) => () => {
  const child = fakeChild();
  setImmediate(() => {
    child.stdout.write(text);
    child.stdout.on('end', () => child.emit('close', code)); // 出力が読み終わってから閉じる
    child.stdout.end();
  });
  return child;
};

test('runTestFile: 落ちた回の末尾からカバレッジの表を外す (表で埋まって何が落ちたかが見えなくならない) — spec でも tap でも', async () => {
  for (const [label, lead, failure] of [
    ['spec', 'ℹ', '✖ add (1ms)\n  AssertionError: 1 !== 3\n'],
    ['tap', '#', 'not ok 1 - add\n  ---\n  error: |-\n    AssertionError: 1 !== 3\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n'],
  ]) {
    const coverage = [`${lead} start of coverage report`, ...Array.from({ length: 40 }, (_, i) => `${lead} src/f${i}.js | 50.00 |`),
      `${lead} end of coverage report`, ''].join('\n');
    const result = await runTestFile({
      cwd: 'somewhere', file: 'test/a.test.js', env: {}, nodeVersion: '22.17.0', spawnImpl: writingSpawn(`${failure}${coverage}`, 1),
    });
    assert.equal(result.ok, false, label);
    assert.match(result.tail, /AssertionError: 1 !== 3/, label);
    assert.doesNotMatch(result.tail, /coverage report|src\/f\d+\.js/, label);
  }
});

test('runTestFile: TAP の集計を読む版では最後まで走った回に tap を付け、読まない版・撃った回には付けない', async () => {
  const passed = tapOutput({ body: ['# Subtest: one', 'ok 1 - one'], tests: 1, pass: 1, fail: 0 });
  const run = (options) => runTestFile({ cwd: 'somewhere', file: 'test/b.test.js', env: {}, ...options });

  const ok = await run({ nodeVersion: '22.17.0', spawnImpl: writingSpawn(passed, 0) });
  assert.deepEqual([ok.ok, ok.tap], [true, { tests: 1, pass: 1, fail: 0 }]);
  // 落ちた回 (読み込みで落ちた) も最後まで走ったので付ける
  const failed = await run({ nodeVersion: '22.17.0', spawnImpl: writingSpawn(loadFailure('test\\\\b.test.js'), 1) });
  assert.deepEqual([failed.ok, failed.tap], [false, { tests: 1, pass: 0, fail: 1, loadFailed: true }]);
  // 終了コードで終わった回は走り切ったので、理由 (error) を付けない (基点で走り切らずの行に出さない)
  assert.equal('error' in failed, false);
  // 22.8 より前は reporter を指定しない (process 隔離の TAP の形は確かめていない) ので、集計の形の出力でも読まない
  const old = await run({ nodeVersion: '20.19.0', spawnImpl: writingSpawn(passed, 0) });
  assert.deepEqual([old.ok, 'tap' in old], [true, false]);

  // 撃った回は集計行が出ていても途中の数なので読まない (pid の無い子は killTree が child.kill だけを呼ぶ)
  const handle = { stopRequested: false };
  const aborting = run({
    nodeVersion: '22.17.0',
    handle,
    spawnImpl: () => {
      const child = fakeChild();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.write(passed);
        // 集計行まで読ませてから撃つ
        child.stdout.on('end', () => {
          handle.abort();
          child.emit('close', null);
        });
        child.stdout.end();
      });
      return child;
    },
  });
  const aborted = await aborting;
  assert.deepEqual([aborted.aborted, 'tap' in aborted], [true, false]);
});

test('runTestFile: tap を付けた回にはテスト 1 本ずつの tapCases も stdout だけから読んで付け、stdout が上限を超えた回には付けない', async () => {
  const passed = tapOutput({ body: ['# Subtest: one', 'ok 1 - one', '  ---', "  type: 'test'", '  ...'], tests: 1, pass: 1, fail: 0 });
  const run = (options) => runTestFile({ cwd: 'somewhere', file: 'test/b.test.js', env: {}, nodeVersion: '22.17.0', ...options });

  // 行の途中に stderr が来ても、名前は stdout だけから読む
  const interleaved = await run({
    spawnImpl: () => {
      const child = fakeChild();
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      (async () => {
        await tick();
        const cut = passed.indexOf('ok 1 - o') + 'ok 1 - o'.length;
        child.stdout.write(passed.slice(0, cut));
        await tick();
        child.stderr.write('warning\n');
        await tick();
        child.stdout.write(passed.slice(cut));
        child.stdout.on('end', () => child.emit('close', 0));
        child.stderr.end();
        child.stdout.end();
      })();
      return child;
    },
  });
  assert.deepEqual([interleaved.tap, interleaved.tapCases], [{ tests: 1, pass: 1, fail: 0 }, [{ name: 'one', type: 'test', pass: true }]]);
  // 上限 (64 KB) を超えた stdout は頭が欠けて名前を取りこぼすので付けない (集計は末尾から読めるので tap は付く)
  const big = await run({ spawnImpl: writingSpawn(`${'x'.repeat(65 * 1024)}\n${passed}`, 0) });
  assert.deepEqual([big.tap, 'tapCases' in big], [{ tests: 1, pass: 1, fail: 0 }, false]);
  // 集計を読まない版には付けない
  const old = await run({ nodeVersion: '20.19.0', spawnImpl: writingSpawn(passed, 0) });
  assert.equal('tapCases' in old, false);
});

test('runTestFile は時間切れのテストを撃って落ちた扱いにする', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-evidence-timeout-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'test/hang.test.js', testFile("test('hang', () => new Promise((r) => setTimeout(r, 60000)));\n"));
  const result = await runTestFile({ cwd: dir, file: 'test/hang.test.js', timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error, 'timeout after 1500ms');
  assert.match(result.tail, /timeout after 1500ms/);
  // 撃てていなければ close が来ず、保険の待ち (VERIFY_KILL_GRACE_MS) が切れるまで返らない
  assert.ok(result.durationMs < 1500 + VERIFY_KILL_GRACE_MS, `撃てていない: ${result.durationMs}ms`);
});

test('runTestFile: 走っている間の handle.abort は子をツリーごと撃って aborted で返し、始めから立っていれば起動しない', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-evidence-abort-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'test/hang.test.js', testFile("test('hang', () => new Promise((r) => setTimeout(r, 60000)));\n"));
  const handle = { stopRequested: false };
  const startedAt = Date.now();
  const pending = runTestFile({ cwd: dir, file: 'test/hang.test.js', timeoutMs: 60_000, handle });
  let abortedAt = null;
  setTimeout(() => {
    abortedAt = Date.now() - startedAt;
    handle.abort();
  }, 500);
  const result = await pending;
  assert.deepEqual([result.ok, result.aborted, result.timedOut, handle.stopRequested], [false, true, false, true]);
  assert.match(result.tail, /停止指示によりテストを中断/);
  // 撃てていなければ close が来ず、保険の待ち (VERIFY_KILL_GRACE_MS) が切れるまで返らない
  assert.ok(result.durationMs < abortedAt + VERIFY_KILL_GRACE_MS, `撃てていない: ${result.durationMs}ms (停止 ${abortedAt}ms)`);
  handle.abort(); // 終わった後は印を立てるだけ

  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    const child = fakeChild();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const never = await runTestFile({ cwd: dir, file: 'test/hang.test.js', coverage: true, handle, spawnImpl });
  assert.deepEqual([never.ok, never.aborted, spawned], [false, true, false], '止まっているのに起動した');
});

test('スクリプト: 測れたら exit 0、本体で呼ぶと exit 1', (t) => {
  const { repo, wt } = makeRepo(t, BASE_FILES, { 'test/keep.test.js': TASK_CHANGES['test/keep.test.js'] });
  const run = (cwd) => spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--cwd', cwd], { encoding: 'utf8', windowsHide: true });
  const ok = run(wt);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^src の差分なし/);
  const refused = run(repo);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^断りました: 本体の作業ツリー/);
});

/** signal を受ける偽の process (stderr と exit を記録する) */
function fakeProc() {
  const proc = new EventEmitter();
  proc.written = [];
  proc.exits = [];
  proc.stderr = {
    write: (text, done) => {
      proc.written.push(text);
      done?.();
      return true;
    },
  };
  proc.exit = (code) => proc.exits.push(code);
  return proc;
}

test('スクリプト: 1 回目の SIGINT / SIGTERM は handle.abort だけ、2 回目 (種類は問わない) は戻すのを待たずに stderr に言って exit 1', () => {
  for (const [first, second] of [['SIGINT', 'SIGTERM'], ['SIGTERM', 'SIGINT']]) {
    const proc = fakeProc();
    let aborts = 0;
    const uninstall = installStopHandlers({ handle: { abort: () => { aborts += 1; } }, proc });
    proc.emit(first);
    assert.deepEqual([aborts, proc.written, proc.exits], [1, [], []], `${first} の 1 回目で抜けた`);
    proc.emit(second);
    assert.equal(aborts, 1);
    assert.deepEqual(proc.written, ['戻さずに終了 — git status -- src test で確かめる\n']);
    assert.deepEqual(proc.exits, [1]);
    uninstall();
    assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0);
  }
});

test('スクリプト: 測定へ handle を渡し、SIGINT で止まって返った回は停止の 1 行を出して exit 1 (終わったら signal を外す)', async () => {
  const proc = fakeProc();
  const printed = [];
  const measure = async ({ base, handle }) => {
    proc.emit('SIGINT');
    assert.equal(handle.stopRequested, true, 'SIGINT が測定の handle に届いていない');
    return { outcome: 'stopped', base, mergeBase: '0123456789abcdef', ran: 1, planned: 4 };
  };
  const code = await main(['--base', 'main'], { measure, proc, print: (text) => printed.push(text) });
  assert.equal(code, 1);
  assert.deepEqual(printed, ['停止で中断 — src と test/ は HEAD へ戻した (走らせたテスト 1 / 予定 4 回・基点 0123456 (main))']);
  assert.deepEqual(proc.exits, [], '1 回目の停止で戻すのを待たずに抜けた');
  assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0);

  const measured = await main(['--base', 'main'], { measure: async ({ base }) => ({ outcome: 'no-tests', base, mergeBase: 'x', src: { added: [], restored: [] } }), proc, print: () => {} });
  assert.equal(measured, 0);
});

test('parseArgs: --base は必須・--cwd と --json を受け、知らないオプションは断る', () => {
  const opts = parseArgs(['--base', 'main', '--cwd', '.', '--json']);
  assert.equal(opts.base, 'main');
  assert.equal(opts.json, true);
  assert.equal(opts.cwd, process.cwd());
  assert.equal(parseArgs(['--base', 'main']).json, false);
  assert.throws(() => parseArgs([]), /--base .* は必須/);
  assert.throws(() => parseArgs(['--base']), /値が渡されていません/);
  assert.throws(() => parseArgs(['--base', 'main', '--since', 'x']), /知らないオプション/);
});
