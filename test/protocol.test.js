import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, checkRoleProtocol, readProtocolVersion } from '../src/protocol.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('版マーカーを先頭から読む', () => {
  assert.equal(readProtocolVersion('<!-- communitd-protocol: 2 -->\n# role'), 2);
  assert.equal(readProtocolVersion('<!--communitd-protocol:11-->'), 11);
  assert.equal(readProtocolVersion('# role\n<!-- communitd-protocol: 2 -->'), 2);
});

test('改名前の yobidashi-protocol はもう受け付けない', () => {
  // 移行 (コードが両受け → /restart → 役割文の切替) は済んだ。ここを緩めて戻すと
  // 「旧マーカーのまま置き去りの役割文」が黙って通り、改名が中途半端なまま固まる
  assert.equal(readProtocolVersion('<!-- yobidashi-protocol: 2 -->\n# role'), null);
  const ng = checkRoleProtocol(`<!-- yobidashi-protocol: ${PROTOCOL_VERSION} -->\n# role`);
  assert.equal(ng.ok, false, '旧マーカーの役割文が起動できてしまう');
  // 案内は新しい名前で出す (どう直せばいいかが分かる形で落とす)
  assert.match(ng.reason, /communitd-protocol/);
  assert.match(checkRoleProtocol('# role only').reason, /communitd-protocol/);
});

test('宣言が無い / 読めない role は版なし扱い', () => {
  assert.equal(readProtocolVersion('# role only'), null);
  assert.equal(readProtocolVersion(''), null);
  assert.equal(readProtocolVersion(null), null);
  assert.equal(readProtocolVersion('<!-- communitd-protocol: two -->'), null);
  // 本文の後ろに書かれた宣言は拾わない (説明文中の言及を版と誤読しない)
  assert.equal(readProtocolVersion(`${'x'.repeat(500)}\n<!-- communitd-protocol: 2 -->`), null);
});

test('版が一致していれば通す', () => {
  const r = checkRoleProtocol(`<!-- communitd-protocol: ${PROTOCOL_VERSION} -->\n# role`);
  assert.deepEqual(r, { ok: true, version: PROTOCOL_VERSION });
});

test('宣言欠落は起動させない (旧プロトコルのまま書かれている可能性がある)', () => {
  const r = checkRoleProtocol('# role');
  assert.equal(r.ok, false);
  assert.equal(r.version, null);
  assert.match(r.reason, /宣言がありません/);
  assert.match(r.reason, new RegExp(`${PROTOCOL_VERSION}`));
});

test('role が新しい / 古いで直し方の案内を変える', () => {
  const newer = checkRoleProtocol('<!-- communitd-protocol: 9 -->', 2);
  assert.equal(newer.ok, false);
  assert.match(newer.reason, /restart/, 'ブリッジが古い場合の案内になっていない');

  const older = checkRoleProtocol('<!-- communitd-protocol: 1 -->', 2);
  assert.equal(older.ok, false);
  assert.match(older.reason, /role prompt が古い/);
});

test('同梱の roles はすべて現行版を宣言している', () => {
  const dir = join(ROOT, 'roles');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'roles が見つからない (テストの前提が崩れている)');
  for (const file of files) {
    const res = checkRoleProtocol(readFileSync(join(dir, file), 'utf8'));
    assert.equal(res.ok, true, `${file}: ${res.reason ?? ''}`);
  }
});

// 共通規定を _common.md へ切り出した理由そのものを固定する。
// 以前は制御フッターと Discord 運用が 3 ファイルへ同じ文面でコピーされていて、
// 記法を変えるたびに直し漏れが出た (どれが正しいかは読み手に分からない)。
test('共通規定は _common.md にしかない', () => {
  const dir = join(ROOT, 'roles');
  const shared = [
    /\[\[notify:owner\]\] — /, // フッター一覧の定義
    /\[\[attach: /, // 添付マーカーの文法
    /2000 字/, // Discord の長さ制限
  ];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_common.md')) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const re of shared) {
      assert.doesNotMatch(text, re, `${file} が共通規定を再掲している (${re})`);
    }
  }
});
