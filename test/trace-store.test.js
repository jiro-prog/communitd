import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pruneRunTraces, readRunTrace, runTracePath, saveRunTrace } from '../src/trace-store.js';

// src/trace-store.js — job の軌跡を実行記録と同じ寿命で残す置き場

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trace-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('書いて読み戻せる — 置き場が無ければ作り、既定の値 (成功・引数なし) は省く', (t) => {
  const dir = join(tmp(t), 'traces');
  const at = Date.UTC(2026, 9, 13);
  assert.equal(saveRunTrace(dir, 'ab12cd34', [
    { tool: 'Read', arg: 'a.js', failed: false, at },
    { tool: 'Bash', arg: null, failed: true },
  ]), true);
  assert.deepEqual(
    readFileSync(join(dir, 'ab12cd34.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    [{ tool: 'Read', arg: 'a.js', at }, { tool: 'Bash', failed: true }],
  );
  assert.deepEqual(readRunTrace(dir, 'ab12cd34'), [
    { tool: 'Read', arg: 'a.js', failed: false, at },
    { tool: 'Bash', arg: null, failed: true },
  ]);
});

test('0 件と、ファイル名にできない id は書かない / 無い軌跡は空で読む', (t) => {
  const dir = tmp(t);
  assert.equal(saveRunTrace(dir, 'ab12', []), false);
  assert.equal(saveRunTrace(dir, '../escape', [{ tool: 'Read' }]), false);
  assert.equal(runTracePath(dir, '../escape'), null);
  assert.equal(runTracePath(dir, ''), null);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readRunTrace(dir, 'missing'), []);
  assert.deepEqual(readRunTrace(dir, '../escape'), []);
});

test('掃除は残す id に無い軌跡だけを消す / 置き場が無ければ 0', (t) => {
  const dir = tmp(t);
  for (const id of ['keep1', 'gone1', 'gone2']) saveRunTrace(dir, id, [{ tool: 'Read' }]);
  writeFileSync(join(dir, 'note.txt'), 'x');
  assert.equal(pruneRunTraces(dir, new Set(['keep1'])), 2);
  assert.deepEqual(readdirSync(dir).sort(), ['keep1.jsonl', 'note.txt']);
  assert.equal(pruneRunTraces(join(dir, 'none'), new Set()), 0);
  assert.ok(existsSync(join(dir, 'keep1.jsonl')));
});
