import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDiffFile, diffTouchPaths, isSafeRepoPath, parseUnifiedDiff } from '../src/diffs.js';

const edit = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

// ---- パスの正規形 ----

test('isSafeRepoPath はリポジトリ相対・POSIX 区切りだけを通す', () => {
  assert.equal(isSafeRepoPath('roles/sol.md'), true);
  assert.equal(isSafeRepoPath('docs/social-engineering.md'), true);
  for (const bad of ['/etc/passwd', 'C:/tmp/x', '../outside.md', './roles/sol.md', 'roles\\sol.md', 'roles//sol.md', 'roles/', '', null]) {
    assert.equal(isSafeRepoPath(bad), false, `通してはいけない: ${bad}`);
  }
});

// ---- 文法ゲート ----

test('edit / create / delete を解析できる', () => {
  const parsed = parseUnifiedDiff(
    edit('roles/sol.md', '@@ -1,2 +1,2 @@\n-old\n+new\n line2\n')
    + 'diff --git a/roles/new.md b/roles/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/roles/new.md\n@@ -0,0 +1,1 @@\n+hello\n'
    + 'diff --git a/roles/old.md b/roles/old.md\ndeleted file mode 100644\n--- a/roles/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n',
  );
  assert.equal(parsed.ok, true, parsed.reason);
  assert.deepEqual(parsed.files.map((f) => [f.path, f.op]), [
    ['roles/sol.md', 'edit'],
    ['roles/new.md', 'create'],
    ['roles/old.md', 'delete'],
  ]);
});

test('rename / copy / binary / mode 変更 / symlink / submodule は受け付けない', () => {
  const cases = [
    ['similarity index 95%\nrename from a.md\nrename to b.md\n--- a/a.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n', 'rename'],
    ['copy from a.md\ncopy to b.md\n--- a/a.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n', 'copy'],
    ['diff --git a/x.png b/x.png\nGIT binary patch\nliteral 0\n', 'binary'],
    ['diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n', 'binary'],
    ['diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n--- a/x.sh\n+++ b/x.sh\n@@ -1 +1 @@\n-x\n+y\n', 'mode'],
    ['diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target\n', 'symlink'],
    ['diff --git a/m b/m\nnew file mode 160000\n--- /dev/null\n+++ b/m\n@@ -0,0 +1 @@\n+commit\n', 'submodule'],
  ];
  for (const [diff, label] of cases) {
    assert.equal(parseUnifiedDiff(diff).ok, false, `${label} を通してはいけない`);
  }
});

test('rename は ---/+++ のパス違いとしても落ちる', () => {
  const parsed = parseUnifiedDiff('--- a/a.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /rename/);
});

test('リポジトリ外を指す diff は落ちる', () => {
  for (const path of ['../outside.md', '/etc/passwd']) {
    const parsed = parseUnifiedDiff(`--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`);
    assert.equal(parsed.ok, false, path);
  }
});

test('CR を含む diff・空の diff・ハンクの無い diff は落ちる', () => {
  assert.equal(parseUnifiedDiff('--- a/x.md\r\n+++ b/x.md\r\n').ok, false);
  assert.equal(parseUnifiedDiff('').ok, false);
  assert.equal(parseUnifiedDiff('--- a/x.md\n+++ b/x.md\n').ok, false);
});

test('ハンクの行数がヘッダと合わない diff は落ちる', () => {
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1,3 +1,3 @@\n-a\n+b\n'));
  assert.equal(parsed.ok, false);
});

test('同じファイルが 2 回現れる diff は落ちる', () => {
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1 +1 @@\n-a\n+b\n') + edit('x.md', '@@ -2 +2 @@\n-c\n+d\n'));
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /2 回/);
});

test('diffTouchPaths は旧側と新側の両方を返す', () => {
  const parsed = parseUnifiedDiff(
    'diff --git a/b.md b/b.md\nnew file mode 100644\n--- /dev/null\n+++ b/b.md\n@@ -0,0 +1 @@\n+x\n'
    + 'diff --git a/a.md b/a.md\ndeleted file mode 100644\n--- a/a.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
  );
  assert.equal(parsed.ok, true, parsed.reason);
  // /dev/null は含めない (touch に無いことを理由に正しい create / delete が落ちないように)
  assert.deepEqual(diffTouchPaths(parsed.files), ['a.md', 'b.md']);
});

// ---- 適用 ----

test('文脈が一致すれば当たり、一致しなければ当たらない', () => {
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'));
  assert.equal(parsed.ok, true, parsed.reason);
  const applied = applyDiffFile(parsed.files[0], 'one\ntwo\nthree\n');
  assert.equal(applied.ok, true, applied.reason);
  assert.equal(applied.after, 'one\nTWO\nthree\n');

  const drifted = applyDiffFile(parsed.files[0], 'one\nTWO\nthree\n');
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason, /前提と違います/);
});

test('create は既存ファイルへ当たらず、delete は全体を覆っていないと当たらない', () => {
  const created = parseUnifiedDiff('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  assert.equal(applyDiffFile(created.files[0], 'すでにある').ok, false);
  assert.deepEqual(applyDiffFile(created.files[0], null), { ok: true, after: 'a\nb\n' });

  const deleted = parseUnifiedDiff('--- a/n.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n');
  assert.equal(applyDiffFile(deleted.files[0], 'a\nb\n').ok, false); // 覆えていない
  assert.deepEqual(applyDiffFile(deleted.files[0], 'a\n'), { ok: true, after: null });

  // 途中の 1 行だけを削る diff で「ファイルごと消す」ことはできない
  const partial = parseUnifiedDiff('--- a/n.md\n+++ /dev/null\n@@ -2,1 +1,0 @@\n-b\n');
  assert.equal(partial.ok, true, partial.reason);
  const applied = applyDiffFile(partial.files[0], 'a\nb\n');
  assert.equal(applied.ok, false);
  assert.match(applied.reason, /ファイル全体を覆っていません/);
});

test('末尾に改行が無いファイルは印まで含めて一致を見る', () => {
  const withMark = parseUnifiedDiff(
    edit('x.md', '@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n'),
  );
  assert.equal(withMark.ok, true, withMark.reason);
  assert.deepEqual(applyDiffFile(withMark.files[0], 'one'), { ok: true, after: 'two' });
  // 印はあるのに実ファイルは改行で終わっている = 前提が違う
  assert.equal(applyDiffFile(withMark.files[0], 'one\n').ok, false);
});

test('新側の座標が旧側と整合しない diff は落ちる', () => {
  // 新側だけ嘘の行番号を書いた diff。承認した内容と実際に入る変更の対応が崩れる
  const lying = parseUnifiedDiff(edit('x.md', '@@ -1 +99 @@\n-a\n+b\n'));
  assert.equal(lying.ok, false);
  assert.match(lying.reason, /新側開始位置/);

  // 2 つ目のハンクは「それまでの増減」を織り込んだ位置でなければならない
  const shifted = parseUnifiedDiff(edit('x.md', '@@ -1,1 +1,2 @@\n-a\n+A\n+extra\n@@ -3,1 +3,1 @@\n-c\n+C\n'));
  assert.equal(shifted.ok, false);
  const consistent = parseUnifiedDiff(edit('x.md', '@@ -1,1 +1,2 @@\n-a\n+A\n+extra\n@@ -3,1 +4,1 @@\n-c\n+C\n'));
  assert.equal(consistent.ok, true, consistent.reason);
  assert.deepEqual(applyDiffFile(consistent.files[0], 'a\nb\nc\n'), { ok: true, after: 'A\nextra\nb\nC\n' });
});

test('行数 0 のハンクは「その行の後ろへ挿入」として扱う', () => {
  // 空ファイルへの追記 (git が実際に出す形)
  const appended = parseUnifiedDiff(edit('x.md', '@@ -0,0 +1,2 @@\n+a\n+b\n'));
  assert.equal(appended.ok, true, appended.reason);
  assert.deepEqual(applyDiffFile(appended.files[0], ''), { ok: true, after: 'a\nb\n' });

  // 途中への純粋な挿入
  const inserted = parseUnifiedDiff(edit('x.md', '@@ -1,0 +2,1 @@\n+new\n'));
  assert.equal(inserted.ok, true, inserted.reason);
  assert.deepEqual(applyDiffFile(inserted.files[0], 'a\nb\n'), { ok: true, after: 'a\nnew\nb\n' });

  // 何も変えないハンクは受けない
  assert.equal(parseUnifiedDiff(edit('x.md', '@@ -0,0 +0,0 @@\n')).ok, false);
});

test('ハンクの行は必ず prefix を持つ (空行を文脈行として補完しない)', () => {
  const stripped = parseUnifiedDiff(edit('x.md', '@@ -1,2 +1,2 @@\n\n-a\n+b\n'));
  assert.equal(stripped.ok, false);
  const proper = parseUnifiedDiff(edit('x.md', '@@ -1,2 +1,2 @@\n \n-a\n+b\n'));
  assert.equal(proper.ok, true, proper.reason);
  assert.deepEqual(applyDiffFile(proper.files[0], '\na\n'), { ok: true, after: '\nb\n' });
});

test('旧側は a/・新側は b/ に固定する', () => {
  assert.equal(parseUnifiedDiff('--- b/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n').ok, false);
  assert.equal(parseUnifiedDiff('--- a/x.md\n+++ a/x.md\n@@ -1 +1 @@\n-a\n+b\n').ok, false);
});

test('末尾改行は「最後に出力した行」の状態で決まる', () => {
  // 改行なしの最終行だけを消しても、手前の行が持っていた改行は残る
  const dropLast = parseUnifiedDiff(edit('x.md', '@@ -2,1 +1,0 @@\n-b\n\\ No newline at end of file\n'));
  assert.equal(dropLast.ok, true, dropLast.reason);
  assert.deepEqual(applyDiffFile(dropLast.files[0], 'a\nb'), { ok: true, after: 'a\n' });

  // 途中の行を消したときは、原本の「末尾に改行なし」がそのまま残る
  const dropMiddle = parseUnifiedDiff(edit('x.md', '@@ -2,1 +1,0 @@\n-b\n'));
  assert.deepEqual(applyDiffFile(dropMiddle.files[0], 'a\nb\nc'), { ok: true, after: 'a\nc' });
  assert.deepEqual(applyDiffFile(dropMiddle.files[0], 'a\nb\nc\n'), { ok: true, after: 'a\nc\n' });

  // 先頭だけを直しても末尾の状態は変わらない
  const head = parseUnifiedDiff(edit('x.md', '@@ -1,1 +1,1 @@\n-a\n+A\n'));
  assert.deepEqual(applyDiffFile(head.files[0], 'a\nb\nc'), { ok: true, after: 'A\nb\nc' });
  assert.deepEqual(applyDiffFile(head.files[0], 'a\nb\nc\n'), { ok: true, after: 'A\nb\nc\n' });
});

test('存在しないファイルへの edit は当たらない', () => {
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1 +1 @@\n-a\n+b\n'));
  assert.equal(applyDiffFile(parsed.files[0], null).ok, false);
});

test('CRLF のファイルにも当たり、書き戻しは元の改行様式を保つ', () => {
  // diff 側は LF 正規化を要求している。行末の CR を内容として比べると、
  // CRLF のリポジトリではどんな diff も当たらない
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'));
  assert.equal(parsed.ok, true, parsed.reason);
  assert.deepEqual(
    applyDiffFile(parsed.files[0], 'one\r\ntwo\r\nthree\r\n'),
    { ok: true, after: 'one\r\nTWO\r\nthree\r\n' },
  );
  // LF のファイルは LF のまま (様式は原本から決まる)
  assert.deepEqual(
    applyDiffFile(parsed.files[0], 'one\ntwo\nthree\n'),
    { ok: true, after: 'one\nTWO\nthree\n' },
  );
  // 末尾に改行が無い CRLF ファイルも同じ (印まで含めて一致を見るのは従来どおり)
  const tail = parseUnifiedDiff(edit(
    'x.md',
    '@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n',
  ));
  assert.equal(tail.ok, true, tail.reason);
  assert.deepEqual(applyDiffFile(tail.files[0], 'a\r\nb'), { ok: true, after: 'a\r\nB' });
});

test('改行が混在したファイルは扱わない', () => {
  const parsed = parseUnifiedDiff(edit('x.md', '@@ -1,1 +1,1 @@\n-a\n+A\n'));
  const mixed = applyDiffFile(parsed.files[0], 'a\r\nb\nc\r\n');
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /混在/);
});

test('新規作成は LF で書く', () => {
  const created = parseUnifiedDiff('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  assert.deepEqual(applyDiffFile(created.files[0], null), { ok: true, after: 'a\nb\n' });
});
