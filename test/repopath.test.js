import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPathResolver, isSafeRepoPath, samePathLoose, underPathLoose } from '../src/repopath.js';

/** 実ファイルを置いた作業ディレクトリを 1 つ作る */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'communitd-path-'));
  mkdirSync(join(root, 'roles'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'config.policy.json'), '{}\n');
  writeFileSync(join(root, 'config.secrets.json'), '{}\n');
  writeFileSync(join(root, 'roles', 'sol.md'), 'sol\n');
  return root;
}

// ---- 文字列だけで落とせる分 ----

test('isSafeRepoPath は Windows の別名になる書き方を落とす', () => {
  assert.equal(isSafeRepoPath('roles/sol.md'), true);

  for (const bad of [
    'config.secrets.json:hidden', // 代替データストリーム (ADS)
    'C:/tmp/x', // ドライブレター (: で落ちる)
    'config.secrets.json.', // 末尾のドットは Windows が落とす
    'config.secrets.json ', // 末尾の空白も同じ
    'roles/nul', // 予約デバイス名
    'roles/CON.md',
    'roles/lpt1.txt',
    '../outside.md',
    './roles/sol.md',
    'roles\\sol.md',
    '/etc/passwd',
    '',
  ]) {
    assert.equal(isSafeRepoPath(bad), false, `通してはいけない: ${JSON.stringify(bad)}`);
  }
});

test('安全境界の比較は大小文字を無視する', () => {
  assert.equal(samePathLoose('config.secrets.json', 'CONFIG.SECRETS.JSON'), true);
  assert.equal(samePathLoose('config.policy.json', 'config.secrets.json'), false);
  assert.equal(underPathLoose('ROLES/sol.md', 'roles/'), true);
  assert.equal(underPathLoose('docs/x.md', 'roles/'), false);
});

// ---- 実体を見る分 ----

test('実体は file / dir / missing で返る', () => {
  const resolver = createPathResolver({ cwd: repo() });
  assert.deepEqual(pick(resolver.check('roles/sol.md')), { ok: true, kind: 'file' });
  assert.deepEqual(pick(resolver.check('roles')), { ok: true, kind: 'dir' });
  assert.deepEqual(pick(resolver.check('roles/new.md')), { ok: true, kind: 'missing' });
  assert.deepEqual(pick(resolver.check('nowhere/deep/x.md')), { ok: true, kind: 'missing' });
  assert.equal(resolver.read('roles/sol.md'), 'sol\n');
  assert.equal(resolver.read('roles'), null); // ディレクトリは読まない
  assert.equal(resolver.read('roles/new.md'), null);
});

test('大小文字だけが違う名前は別名として拒否する (Windows では同じ実体)', () => {
  const resolver = createPathResolver({ cwd: repo() });
  const upper = resolver.check('CONFIG.SECRETS.JSON');
  assert.equal(upper.ok, false);
  assert.match(upper.reason, /大小文字だけが違う名前/);

  assert.equal(resolver.check('Roles/sol.md').ok, false); // 途中の成分も同じ
  assert.equal(resolver.check('roles/SOL.md').ok, false);
  assert.equal(resolver.check('roles/sol.md').ok, true); // 完全一致だけが通る
});

test('途中がディレクトリでないパスは通さない', () => {
  const resolver = createPathResolver({ cwd: repo() });
  const nested = resolver.check('roles/sol.md/x.md');
  assert.equal(nested.ok, false);
  assert.match(nested.reason, /ディレクトリではありません/);
});

test('symlink / junction は対象にできない', (t) => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), 'communitd-outside-'));
  writeFileSync(join(outside, 'secret.md'), 'そと\n');
  try {
    symlinkSync(outside, join(root, 'linked'), 'junction');
  } catch {
    t.skip('この環境では junction を作れない');
    return;
  }
  const resolver = createPathResolver({ cwd: root });
  const linked = resolver.check('linked/secret.md');
  assert.equal(linked.ok, false);
  assert.match(linked.reason, /symlink \/ junction/);
  assert.equal(resolver.check('linked').ok, false);
  assert.equal(resolver.read('linked/secret.md'), null);
});

test('作業ディレクトリを解決できなければ何も通さない (fail-closed)', () => {
  const resolver = createPathResolver({ cwd: join(tmpdir(), 'communitd-nonexistent-cwd') });
  assert.equal(resolver.root, null);
  const checked = resolver.check('roles/sol.md');
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /作業ディレクトリを解決できません/);
});

const pick = ({ ok, kind }) => ({ ok, kind });
