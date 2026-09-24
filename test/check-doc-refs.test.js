import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findBrokenDocRefs } from '../scripts/check-doc-refs.mjs';

const TRACKED = ['README.md', 'SETUP.md', 'docs/reference/operations.md', 'src/a.js', 'LICENSE'];

test('Markdown の相対リンクは、リンク元のディレクトリから解決して在るかを見る', () => {
  const files = [
    { path: 'README.md', text: '[運用](docs/reference/operations.md) と [無い](docs/design.md)' },
    { path: 'docs/reference/operations.md', text: '[戻る](../../README.md)\n[setup](../../SETUP.md#4-動作確認)' },
  ];
  assert.deepEqual(findBrokenDocRefs(files, TRACKED), [
    { path: 'README.md', line: 1, target: 'docs/design.md' },
  ]);
});

test('外部 URL・ページ内アンカー・ディレクトリへのリンクは切れた扱いにしない', () => {
  const files = [{
    path: 'README.md',
    text: '[x](https://example.com/a.md) [y](#setup) [z](mailto:a@example.com) [d](docs/reference/) [l](LICENSE)',
  }];
  assert.deepEqual(findBrokenDocRefs(files, TRACKED), []);
});

test('リポジトリの外へ出るリンクは切れた扱いにする', () => {
  const files = [{ path: 'README.md', text: '[外](../other/README.md)' }];
  assert.equal(findBrokenDocRefs(files, TRACKED).length, 1);
});

test('src と scripts に書いた docs/*.md はコメントでも文字列でも見る', () => {
  const files = [
    { path: 'src/a.js', text: '// 仕様は docs/society-ledger.md\nconst ok = "docs/reference/operations.md";' },
    { path: 'scripts/b.mjs', text: "throw new Error('docs/x.md を見よ');" },
  ];
  assert.deepEqual(findBrokenDocRefs(files, TRACKED), [
    { path: 'src/a.js', line: 1, target: 'docs/society-ledger.md' },
    { path: 'scripts/b.mjs', line: 1, target: 'docs/x.md' },
  ]);
});

test('プロジェクト側に置かれるファイルと test/ の架空のパスは見ない', () => {
  const files = [
    { path: 'src/a.js', text: "export const HANDOFF_FILE = 'docs/HANDOFF.md';\nconst d = 'docs/direction.md';" },
    { path: 'test/a.test.js', text: "const FILES = { 'docs/handbook.md': '手順' };" },
  ];
  assert.deepEqual(findBrokenDocRefs(files, TRACKED), []);
});
