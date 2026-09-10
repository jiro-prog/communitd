import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diffSnapshots, gitStatusSnapshot } from '../src/gitstatus.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

test('diffSnapshots は増えた行と消えた行だけを返し、どちらかが読めなければ空', () => {
  assert.deepEqual(diffSnapshots(null, ['?? a']), []);
  assert.deepEqual(diffSnapshots(['?? a'], null), []);
  assert.deepEqual(diffSnapshots(['?? a'], ['?? a']), []);
  assert.deepEqual(diffSnapshots(['?? a'], ['?? a', ' M b']), ['+  M b']);
  assert.deepEqual(diffSnapshots(['?? a', ' M b'], [' M b']), ['- ?? a']);
  assert.deepEqual(diffSnapshots([' M b'], ['M  b']), ['+ M  b', '-  M b']);
});

test('gitStatusSnapshot は porcelain を行配列で返し、git repo でなければ null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-gitstatus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(gitStatusSnapshot(dir), null, 'git repo でないのに読めている');
  assert.equal(gitStatusSnapshot(join(dir, 'missing')), null);

  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  assert.deepEqual(gitStatusSnapshot(dir), [], 'clean な repo は空配列 (null と区別する)');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  assert.deepEqual(gitStatusSnapshot(dir), ['?? a.txt']);
});
