import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, parseArgs } from '../scripts/review-evidence-mutation.mjs';
import {
  applyMutant,
  formatMutationEvidence,
  listMutants,
  measureMutations,
  pickEvenly,
} from '../src/review-evidence-mutation.js';
import { runGit } from '../src/worktree.js';

const SCRIPT = fileURLToPath(new URL('../scripts/review-evidence-mutation.mjs', import.meta.url));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * 基点 (main) の一時リポジトリと、その外に `git worktree add` で生やした task/1 の作業ツリー
 * (test/review-evidence.test.js の makeRepo と同じ形)。`changes` の値が null のパスは消す
 */
function makeRepo(t, baseFiles, changes) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'communitd-mutation-')));
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

const pairs = (mutants) => mutants.map(({ from, to }) => `${from} → ${to}`);

test('listMutants: 演算子は固定 10 種を 1 箇所ずつ — 長い字面を先に取り (!== の中の == や >= の中の > を別に取らない)、桁は 1 始まり', () => {
  const line = 'if (a === b || c !== d && e >= f || g <= h) return x > y ? true : x < z || false;';
  const mutants = listMutants(line, [1], { max: Infinity });
  assert.deepEqual(pairs(mutants), [
    '=== → !==', '|| → &&', '!== → ===', '&& → ||', '>= → <', '|| → &&', '<= → >', '> → <=', 'true → false', '< → >=',
    '|| → &&', 'false → true',
  ]);
  for (const { line: lineNo, column, from } of mutants) {
    assert.equal(lineNo, 1);
    assert.equal(line.slice(column - 1, column - 1 + from.length), from, `桁 ${column} に ${from} が無い`);
  }
  // 矢印・シフト・シフトの代入・緩い比較は変異させない (`>>=` の中の `>=` も取らない)
  assert.deepEqual(listMutants('const f = (x) => x >> 1 >>> 2 << 3; x >>= 1; y <<= 2; z >>>= 3; w == v; u != t;', [1]), []);
});

test('listMutants: 文字列・テンプレート (${…} の中も)・// の後・/* */ の中・行頭がコメントの行は変異させない、語は識別子の切れ目で取る', () => {
  const source = [
    // 文字列 (escape した引用符の後も中)・テンプレート (入れ子と ${…} の中も)・行末のコメントの中は取らず、(p > q) だけ
    'const s = \'a > b\' + "c < d" + `e && ${x > 1 ? `n` : \'q\'} f` + \'it\\\'s > \' + (p > q); // a > b',
    // 行の途中の /* */ の後ろは取る。閉じない /* の後ろは取らない
    'a /* x < y */ !== b || c; /* open > d',
    '  // a > b',
    '   * a > b',
    '/* a > b */ c > d',
    'istrue || false_x || $true || true1 || obj.trueish || true',
    // ${…} の中の { } を数えて、閉じた後のテンプレートの外を取る
    '`${ {a: x > 1}.a }` + (y > 2)',
  ].join('\n');
  const mutants = listMutants(source, [1, 2, 3, 4, 5, 6, 7], { max: Infinity });
  assert.deepEqual(mutants.map(({ line, from }) => `${line}:${from}`), [
    '1:>',
    '2:!==', '2:||',
    '6:||', '6:||', '6:||', '6:||', '6:||', '6:true',
    '7:>',
  ]);
  const lines = source.split('\n');
  assert.equal(lines[0].slice(mutants[0].column - 1), '> q); // a > b');
  assert.equal(lines[6].slice(mutants.at(-1).column - 1), '> 2)');
});

test('listMutants: 変えた行だけを (行, 桁) の順に — 行番号の重複と順不同はそろえ、無い行は読み飛ばす。CRLF の行も読める', () => {
  const source = 'a > b;\r\nc < d;\r\ne === f;\r\n';
  assert.deepEqual(listMutants(source, [3, 1, 3, 99]), [
    { line: 1, column: 3, from: '>', to: '<=' },
    { line: 3, column: 3, from: '===', to: '!==' },
  ]);
  assert.deepEqual(listMutants(source, []), []);
});

test('pickEvenly / listMutants の間引き: 上限を超えたら i = 0..max-1 の floor(i * total / max) 番目 — 同じ入力なら同じものを選ぶ', () => {
  assert.deepEqual(pickEvenly([0, 1, 2, 3, 4, 5, 6], 3), [0, 2, 4]);
  assert.deepEqual(pickEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4), [0, 2, 5, 7]);
  assert.deepEqual(pickEvenly([0, 1], 5), [0, 1]);
  assert.deepEqual(pickEvenly([0, 1], Infinity), [0, 1]);

  const source = Array.from({ length: 7 }, (_, i) => `x${i} > 0;`).join('\n');
  const lines = [1, 2, 3, 4, 5, 6, 7];
  const picked = listMutants(source, lines, { max: 3 });
  assert.deepEqual(picked.map((mutant) => mutant.line), [1, 3, 5]);
  assert.deepEqual(listMutants(source, lines, { max: 3 }), picked);
  assert.equal(listMutants(source, lines).length, 7, '既定の上限 (20) 以下は間引かない');
});

test('applyMutant: 指した 1 箇所だけを入れ替え (他の行と改行はそのまま)、位置に from が無ければ投げる', () => {
  const source = 'a > b > c;\r\nd && e;\n';
  const [first, second, third] = listMutants(source, [1, 2]);
  assert.equal(applyMutant(source, first), 'a <= b > c;\r\nd && e;\n');
  assert.equal(applyMutant(source, second), 'a > b <= c;\r\nd && e;\n');
  assert.equal(applyMutant(source, third), 'a > b > c;\r\nd || e;\n');
  assert.throws(() => applyMutant(source, { line: 2, column: 1, from: '&&', to: '||' }), /変異の位置 2:1 に && がありません/);
  assert.throws(() => applyMutant(source, { line: 9, column: 1, from: '>', to: '<=' }), /9:1/);
});

const LIMIT_HEAD = 'export const over = (n) => n > 10;\n';
const FLAG_HEAD = "export const on = (x) => x === 'on';\n";

test('本物の node: 境界を見るテストは変異を殺し、見ないテストしか無い src の変異は生き残りに出る — 変異なしでも落ちるテストは外し、終わると HEAD に戻る', async (t) => {
  const { wt } = makeRepo(t, {
    'src/limit.js': 'export const over = () => false;\n',
    'src/flag.js': 'export const on = () => false;\n',
    'src/data.json': '{}\n',
  }, {
    'src/limit.js': LIMIT_HEAD,
    'src/flag.js': FLAG_HEAD,
    'src/data.json': '{ "a": 1 }\n', // .js でない src は対象にしない
    'test/limit.test.js': testFile("import { over } from '../src/limit.js';\n"
      + "test('境界', () => {\n  assert.equal(over(10), false);\n  assert.equal(over(11), true);\n});\n"),
    'test/flag.test.js': testFile("import { on } from '../src/flag.js';\ntest('ある', () => assert.equal(typeof on, 'function'));\n"),
    'test/broken.test.js': testFile("test('broken', () => assert.equal(1, 2));\n"),
  });
  const headSha = git(wt, 'rev-parse', 'HEAD').trim();

  const result = await measureMutations({ cwd: wt, base: 'main' });

  assert.equal(result.outcome, 'measured');
  assert.deepEqual(result.targets, ['src/flag.js', 'src/limit.js']);
  assert.deepEqual(result.headFails, ['test/broken.test.js']);
  assert.equal(result.candidates, 2);
  assert.deepEqual(result.mutants, [
    { file: 'src/flag.js', line: 1, column: 28, from: '===', to: '!==', status: 'survived' },
    { file: 'src/limit.js', line: 1, column: 30, from: '>', to: '<=', status: 'killed', by: 'test/limit.test.js' },
  ]);
  assert.deepEqual(result.counts, { survived: 1, killed: 1, timedOut: 0 });
  const short = result.mergeBase.slice(0, 7);
  assert.equal(formatMutationEvidence(result), [
    `変異 2 通りのうち 生き残り 1 / 殺された 1 / 時間切れ 0 (対象 src 2 ファイル・変更したテスト 2 本・変異なしでも落ちて外した 1 本・基点 ${short} (main))`,
    'src/flag.js:1 === → !==',
  ].join('\n'));

  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), headSha);
  assert.equal(readFileSync(join(wt, 'src/limit.js'), 'utf8'), LIMIT_HEAD);
  assert.equal(readFileSync(join(wt, 'src/flag.js'), 'utf8'), FLAG_HEAD);
});

/** 変異をファイルをまたいで間引く相手: a.js に 4 通り・b.js に 4 通り */
const THIN_HEAD = {
  'src/a.js': 'export const a1 = (x) => x > 1 && x < 9;\nexport const a2 = (x) => x === 2;\n',
  'src/b.js': 'export const b1 = (x) => x >= 1;\nexport const b2 = (x) => x <= 2 || false;\n',
};
const THIN_CHANGES = { ...THIN_HEAD, 'test/a.test.js': testFile("test('a', () => {});\n") };

/** 走るたびに src の中身を読み、HEAD から変わったファイルを `path: 中身` で残す偽の runTest */
function observingRunTest(wt, reply = () => ({ ok: true })) {
  const seen = [];
  const runTest = async (options) => {
    const changed = Object.entries(THIN_HEAD)
      .filter(([path, text]) => readFileSync(join(wt, path), 'utf8') !== text)
      .map(([path]) => `${path}: ${readFileSync(join(wt, path), 'utf8')}`);
    seen.push(changed);
    return reply(seen.length, options);
  };
  return { runTest, seen };
}

test('間引き: (ファイル, 行, 桁) の順に全部挙げてから floor(i * total / max) 番目を取り、変異は 1 通りずつ入れては戻す (同じ入力なら同じ選び方)', async (t) => {
  const { wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n', 'src/b.js': 'export const b1 = 1;\n' }, THIN_CHANGES);
  const { runTest, seen } = observingRunTest(wt);
  const result = await measureMutations({ cwd: wt, base: 'main', runTest, max: 3 });

  assert.equal(result.candidates, 8);
  // 8 通りの 0・2・5 番目 — a.js の 1 行目の > と <、b.js の 2 行目の <=
  const picked = result.mutants.map(({ file, line, from, to }) => `${file}:${line} ${from} → ${to}`);
  assert.deepEqual(picked, ['src/a.js:1 > → <=', 'src/a.js:1 < → >=', 'src/b.js:2 <= → >']);
  // 変異なしの 1 回 + 変異 3 通り × 1 本。走っている間は変異 1 つだけが入っている
  assert.deepEqual(seen, [
    [],
    [`src/a.js: ${applyMutant(THIN_HEAD['src/a.js'], result.mutants[0])}`],
    [`src/a.js: ${applyMutant(THIN_HEAD['src/a.js'], result.mutants[1])}`],
    [`src/b.js: ${applyMutant(THIN_HEAD['src/b.js'], result.mutants[2])}`],
  ]);
  assert.equal(git(wt, 'status', '--porcelain'), '');

  const again = await measureMutations({ cwd: wt, base: 'main', runTest: observingRunTest(wt).runTest, max: 3 });
  assert.deepEqual(again.mutants, result.mutants);
});

test('変異ごとの判定: 最初に ok でなかった回で決め (時間切れは時間切れ・それ以外は殺された)、残りのファイルは走らせない — 変異なしで時間切れのファイルも外す', async (t) => {
  const { wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n' }, {
    'src/a.js': 'export const a1 = (x) => x > 1 && x < 9;\n',
    'test/a.test.js': testFile("test('a', () => {});\n"),
    'test/b.test.js': testFile("test('b', () => {});\n"),
    'test/c.test.js': testFile("test('c', () => {});\n"),
  });
  const calls = [];
  // 変異なし: a・b は通り c は時間切れ (外す)。1 通り目は a が時間切れ、2 通り目は b で落ち、3 通り目は全部通る
  const replies = [
    { ok: true }, { ok: true }, { ok: false, timedOut: true },
    { ok: false, timedOut: true },
    { ok: true }, { ok: false, code: 1 },
    { ok: true }, { ok: true },
  ];
  const runTest = async ({ file, coverage, timeoutMs }) => {
    assert.equal(coverage, false);
    assert.equal(timeoutMs, 1234);
    calls.push(file);
    return replies[calls.length - 1];
  };
  const result = await measureMutations({ cwd: wt, base: 'main', runTest, timeoutMs: 1234 });

  assert.deepEqual(result.headFails, ['test/c.test.js']);
  assert.deepEqual(result.mutants.map(({ from, status, by }) => [from, status, by]), [
    ['>', 'timeout', 'test/a.test.js'],
    ['&&', 'killed', 'test/b.test.js'],
    ['<', 'survived', undefined],
  ]);
  assert.deepEqual(result.counts, { survived: 1, killed: 1, timedOut: 1 });
  assert.deepEqual(calls, [
    'test/a.test.js', 'test/b.test.js', 'test/c.test.js',
    'test/a.test.js',
    'test/a.test.js', 'test/b.test.js',
    'test/a.test.js', 'test/b.test.js',
  ]);
  assert.match(formatMutationEvidence(result), /^変異 3 通りのうち 生き残り 1 \/ 殺された 1 \/ 時間切れ 1 \(対象 src 1 ファイル・変更したテスト 2 本・変異なしでも落ちて外した 1 本・基点 /);
});

test('途中でテストの実行が投げても src を HEAD へ戻してから投げ直し、終わった後に src/ か test/ が残っていれば投げる', async (t) => {
  const { wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n', 'src/b.js': 'export const b1 = 1;\n' }, THIN_CHANGES);
  // 変異なしの 1 回の後、2 通り目 (3 回目) で投げる — 変異が入ったまま
  const throwing = observingRunTest(wt, (n) => {
    if (n === 3) throw new Error('boom');
    return { ok: true };
  });
  await assert.rejects(measureMutations({ cwd: wt, base: 'main', runTest: throwing.runTest }), /^Error: boom$/);
  assert.equal(throwing.seen[2].length, 1, '投げた回に変異が入っていない');
  assert.equal(git(wt, 'status', '--porcelain'), '');
  for (const [path, text] of Object.entries(THIN_HEAD)) assert.equal(readFileSync(join(wt, path), 'utf8'), text);

  // テストが test/ に置いたファイルは戻せない — 握り潰さずに投げる (途中の失敗も文に含める)
  const littering = async ({ cwd }) => {
    writeFileSync(join(cwd, 'test', 'junk.txt'), 'x\n');
    throw new Error('boom');
  };
  await assert.rejects(
    measureMutations({ cwd: wt, base: 'main', runTest: littering }),
    /作業ツリーが HEAD に戻りませんでした: src\/ と test\/ に 1 件残っています: \?\? test\/junk\.txt \/ 測っている途中の失敗: boom/,
  );
});

test('本体の作業ツリーと、src/ か test/ が dirty な作業ツリーでは何も触らずに断る (git は読むだけ・テストも走らせない)', async (t) => {
  const { repo, wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n', 'src/b.js': 'export const b1 = 1;\n' }, THIN_CHANGES);
  const never = async () => assert.fail('走らせた');
  git(repo, 'checkout', '-q', '--detach', 'task/1'); // 本体が task の中身を指していても断る
  const main1 = recordingGit();
  const onMain = await measureMutations({ cwd: repo, base: 'main', git: main1.fn, runTest: never });
  assert.equal(onMain.outcome, 'refused');
  assert.match(formatMutationEvidence(onMain), /^断りました: 本体の作業ツリー \(.+\) では測らない/);
  assert.deepEqual(main1.calls.filter((c) => !READ_ONLY.test(c)), [], `書き換える git を打った: ${main1.calls.join(' | ')}`);

  const edited = 'export const a1 = () => 42;\n';
  writeFileSync(join(wt, 'src/a.js'), edited);
  const dirty = recordingGit();
  const onDirty = await measureMutations({ cwd: wt, base: 'main', git: dirty.fn, runTest: never });
  assert.equal(onDirty.outcome, 'refused');
  assert.match(onDirty.reason, /未コミットの変更がある \(1 件: {2}M src\/a\.js\)/);
  assert.deepEqual(dirty.calls.filter((c) => !READ_ONLY.test(c)), []);
  assert.equal(readFileSync(join(wt, 'src/a.js'), 'utf8'), edited);

  git(wt, 'checkout', '--', 'src');
  write(wt, 'test/draft.test.js', 'x\n'); // 未追跡も dirty
  const untracked = await measureMutations({ cwd: wt, base: 'main', runTest: never });
  assert.match(untracked.reason, /\?\? test\/draft\.test\.js/);
});

test('停止: 始めから立っていれば git を打たずに、読むだけの段なら書き換えずに、変異の途中なら撃たれた通りを数えずに戻してから stopped', async (t) => {
  const { wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n', 'src/b.js': 'export const b1 = 1;\n' }, THIN_CHANGES);
  const never = async () => assert.fail('走らせた');
  const early = recordingGit();
  const first = await measureMutations({ cwd: wt, base: 'main', git: early.fn, runTest: never, handle: { stopRequested: true } });
  assert.deepEqual(first, { outcome: 'stopped', base: 'main', ran: 0 });
  assert.deepEqual(early.calls, []);
  assert.equal(formatMutationEvidence(first), '停止で中断 — src は HEAD へ戻した');

  // 変えた行の diff を読んだところで停止が来た
  const handle = { stopRequested: false };
  const late = recordingGit();
  const stopOnDiff = async (root, args) => {
    const out = await late.fn(root, args);
    if (args[0] === 'diff' && args[1] === '-U0') handle.stopRequested = true;
    return out;
  };
  const read = await measureMutations({ cwd: wt, base: 'main', git: stopOnDiff, runTest: never, handle });
  assert.deepEqual([read.outcome, read.ran, read.planned], ['stopped', 0, 8]);
  assert.deepEqual(late.calls.filter((c) => !READ_ONLY.test(c)), [], `書き換える git を打った: ${late.calls.join(' | ')}`);

  // 2 通り目を走らせている間に handle.abort が来た (spawnTest が印を立て、撃った回を aborted で返す)
  const running = { stopRequested: false };
  const { runTest, seen } = observingRunTest(wt, (n, options) => {
    assert.equal(options.handle, running, 'runTest へ handle を渡していない');
    if (n < 3) return { ok: true };
    running.stopRequested = true;
    return { ok: false, aborted: true };
  });
  const stopped = await measureMutations({ cwd: wt, base: 'main', runTest, handle: running });
  assert.deepEqual([stopped.outcome, stopped.ran, stopped.planned, seen.length], ['stopped', 1, 8, 3]);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  for (const [path, text] of Object.entries(THIN_HEAD)) assert.equal(readFileSync(join(wt, path), 'utf8'), text);
  assert.equal(
    formatMutationEvidence(stopped),
    `停止で中断 — src は HEAD へ戻した (測った変異 1 / 予定 8 通り・基点 ${stopped.mergeBase.slice(0, 7)} (main))`,
  );

  // 1 通り目が走り終わった後に停止が来た — 次の変異は書き込まない (戻す checkout は 1 通り目の分だけ)
  const between = { stopRequested: false };
  const betweenGit = recordingGit();
  const afterFirst = observingRunTest(wt, (n) => {
    if (n === 2) between.stopRequested = true;
    return { ok: true };
  });
  const r = await measureMutations({ cwd: wt, base: 'main', git: betweenGit.fn, runTest: afterFirst.runTest, handle: between });
  assert.deepEqual([r.outcome, r.ran, afterFirst.seen.length], ['stopped', 1, 2]);
  assert.deepEqual(betweenGit.calls.filter((c) => c.startsWith('checkout HEAD ')), ['checkout HEAD -- src/a.js'], '停止の後に次の変異を書き込んだ');

  // 変異なしの回が撃たれた — 印が立っていなくても止まり、HEAD でも落ちるファイルには数えない
  const baseline = observingRunTest(wt, () => ({ ok: false, aborted: true }));
  const r0 = await measureMutations({ cwd: wt, base: 'main', runTest: baseline.runTest });
  assert.deepEqual([r0.outcome, r0.ran, r0.planned, baseline.seen.length], ['stopped', 0, 8, 1]);
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('src の差分なし・テストなし・変異 0 はテストを走らせずに理由の 1 行、変異なしでも全部落ちるなら変異を入れずに 1 行', async (t) => {
  const never = async () => assert.fail('走らせた');
  const base = { 'src/a.js': 'export const a1 = 1;\n', 'src/gone.js': 'export const g = 1 > 0;\n' };
  const added = testFile("test('a', () => {});\n");

  // src は消しただけ・.js でない src だけ — 変異を入れる行が無い
  const noSrc = makeRepo(t, base, { 'src/gone.js': null, 'src/data.json': '{}\n', 'test/a.test.js': added });
  const r1 = await measureMutations({ cwd: noSrc.wt, base: 'main', runTest: never });
  assert.equal(r1.outcome, 'no-src');
  assert.match(formatMutationEvidence(r1), /^src の差分なし — 変異を入れる行が無い \(HEAD にある src の \.js に変えた行 0・変更したテスト 1 本・基点 [0-9a-f]{7} \(main\)\)$/);

  const noTests = makeRepo(t, base, { 'src/a.js': 'export const a1 = (x) => x > 1;\n' });
  const r2 = await measureMutations({ cwd: noTests.wt, base: 'main', runTest: never });
  assert.equal(r2.outcome, 'no-tests');
  assert.match(formatMutationEvidence(r2), /^変更したテストなし — 変異を入れても走らせるものが無い \(対象 src 1 ファイル・基点 [0-9a-f]{7} \(main\)\)$/);

  // 変えた行が比較を含まない (変えていない行の > は数えない)
  const noMutants = makeRepo(t, base, { 'src/gone.js': 'export const g = 1 > 0;\nexport const h = 2;\n', 'test/a.test.js': added });
  const r3 = await measureMutations({ cwd: noMutants.wt, base: 'main', runTest: never });
  assert.equal(r3.outcome, 'no-mutants');
  assert.match(formatMutationEvidence(r3), /^変異 0 通り — 変えた行に入れ替える演算子が無い \(対象 src 1 ファイル・変更したテスト 1 本・基点 [0-9a-f]{7} \(main\)\)$/);

  const headFails = makeRepo(t, base, { 'src/a.js': 'export const a1 = (x) => x > 1;\n', 'test/a.test.js': added });
  let ran = 0;
  const failing = async () => {
    ran += 1;
    return { ok: false, code: 1 };
  };
  const r4 = await measureMutations({ cwd: headFails.wt, base: 'main', runTest: failing });
  assert.equal(r4.outcome, 'head-fails');
  assert.equal(ran, 1, '変異なしで全部落ちたのに変異を入れて走らせた');
  assert.match(formatMutationEvidence(r4), /^変更したテストが変異なしでも全部落ちる — 殺したかを読み分けられない \(対象 src 1 ファイル・変更したテスト 1 本・基点 /);
  assert.equal(git(headFails.wt, 'status', '--porcelain'), '');
});

test('formatMutationEvidence: 生き残りは (ファイル, 行, 桁) の順に 10 件まで、残りは「ほか n 通り」', () => {
  const mutants = Array.from({ length: 13 }, (_, i) => ({
    file: 'src/x.js', line: i + 1, column: 1, from: '>', to: '<=', status: i === 0 ? 'killed' : 'survived',
  }));
  const text = formatMutationEvidence({
    outcome: 'measured', base: 'dev', mergeBase: 'abcdef0123', targets: ['src/x.js'], tests: ['test/x.test.js'], headFails: [],
    mutants, counts: { survived: 12, killed: 1, timedOut: 0 },
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '変異 13 通りのうち 生き残り 12 / 殺された 1 / 時間切れ 0 (対象 src 1 ファイル・変更したテスト 1 本・基点 abcdef0 (dev))');
  assert.deepEqual(lines.slice(1, 3), ['src/x.js:2 > → <=', 'src/x.js:3 > → <=']);
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), 'ほか 2 通り');
});

test('parseArgs: --base は必須・--cwd / --max (正の整数) / --json を受け、知らないオプションは断る', () => {
  const opts = parseArgs(['--base', 'main', '--cwd', '.', '--max', '5', '--json']);
  assert.deepEqual([opts.base, opts.cwd, opts.max, opts.json], ['main', process.cwd(), 5, true]);
  assert.deepEqual([parseArgs(['--base', 'main']).max, parseArgs(['--base', 'main']).json], [20, false]);
  assert.throws(() => parseArgs([]), /--base .* は必須/);
  assert.throws(() => parseArgs(['--base']), /値が渡されていません/);
  for (const bad of ['0', '-1', '1.5', 'x']) {
    assert.throws(() => parseArgs(['--base', 'main', '--max', bad]), /--max は正の整数|値が渡されていません/, bad);
  }
  assert.throws(() => parseArgs(['--base', 'main', '--timeout', '1']), /知らないオプション/);
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

test('スクリプト: 測定へ --max と handle を渡し、SIGINT で止まって返った回は停止の 1 行で exit 1、測れたら exit 0 (終わったら signal を外す)', async () => {
  const proc = fakeProc();
  const printed = [];
  const measure = async ({ base, max, handle }) => {
    assert.equal(max, 7);
    proc.emit('SIGINT');
    assert.equal(handle.stopRequested, true, 'SIGINT が測定の handle に届いていない');
    return { outcome: 'stopped', base, mergeBase: '0123456789abcdef', ran: 2, planned: 7 };
  };
  const code = await main(['--base', 'main', '--max', '7'], { measure, proc, print: (text) => printed.push(text) });
  assert.equal(code, 1);
  assert.deepEqual(printed, ['停止で中断 — src は HEAD へ戻した (測った変異 2 / 予定 7 通り・基点 0123456 (main))']);
  assert.deepEqual(proc.exits, [], '1 回目の停止で戻すのを待たずに抜けた');
  assert.equal(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0);

  const measured = await main(['--base', 'main', '--json'], {
    measure: async ({ base, max }) => ({ outcome: 'no-tests', base, max, mergeBase: 'x', targets: ['src/a.js'], tests: [] }),
    proc,
    print: (text) => printed.push(text),
  });
  assert.equal(measured, 0);
  assert.equal(JSON.parse(printed.at(-1)).max, 20);
});

test('スクリプト: 測れたら exit 0、本体で呼ぶと exit 1', (t) => {
  const { repo, wt } = makeRepo(t, { 'src/a.js': 'export const a1 = 1;\n' }, {
    'src/a.js': LIMIT_HEAD,
    'test/a.test.js': testFile("import { over } from '../src/a.js';\ntest('a', () => assert.equal(over(11), true));\n"),
  });
  const run = (cwd) => spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--cwd', cwd], { encoding: 'utf8', windowsHide: true });
  const ok = run(wt);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^変異 1 通りのうち 生き残り 0 \/ 殺された 1 \/ 時間切れ 0 \(対象 src 1 ファイル・変更したテスト 1 本・基点 [0-9a-f]{7} \(main\)\)\n$/);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  const refused = run(repo);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^断りました: 本体の作業ツリー/);
});
