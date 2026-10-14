import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTS_KEEP, recordBoot } from '../src/bridge/boots.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

/** 一時ディレクトリの台帳パス (テストの終わりに消す) */
function ledgerPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-boots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'boots.json');
}

/** 引数ごとの答えを持つ偽の git。呼ばれた (args, cwd) を残す */
function fakeGit({ head = `${HEAD}\n`, branch = 'main\n' } = {}) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    const out = args.includes('--abbrev-ref') ? branch : head;
    if (out instanceof Error) throw out;
    return out;
  };
  return { git, calls };
}

function fakeLog() {
  const lines = { log: [], error: [] };
  return { lines, log: { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) } };
}

const readBoots = (file) => JSON.parse(readFileSync(file, 'utf8')).boots;

test('起動ごとに古い順で追記し、HEAD は ROOT で読む', (t) => {
  const file = ledgerPath(t);
  const { git, calls } = fakeGit();
  const { log, lines } = fakeLog();
  const first = recordBoot({ file, root: '/bridge', at: '2026-10-14T01:00:00.000Z', pid: 11, git, log });
  const second = recordBoot({ file, root: '/bridge', at: '2026-10-14T02:00:00.000Z', pid: 22, git, log });
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.deepEqual(readBoots(file), [
    { at: '2026-10-14T01:00:00.000Z', head: HEAD, branch: 'main', pid: 11 },
    { at: '2026-10-14T02:00:00.000Z', head: HEAD, branch: 'main', pid: 22 },
  ]);
  assert.deepEqual(calls.map((c) => c.cwd), ['/bridge', '/bridge', '/bridge', '/bridge']);
  assert.deepEqual(calls.slice(0, 2).map((c) => c.args), [['rev-parse', 'HEAD'], ['rev-parse', '--abbrev-ref', 'HEAD']]);
  // 起動ログの 1 行は HEAD の 7 桁と branch
  assert.equal(lines.log.length, 2);
  assert.match(lines.log[1], /HEAD 0123456 \(main\)/);
  assert.deepEqual(lines.error, []);
});

test(`残すのは新しい ${BOOTS_KEEP} 件 — ちょうど ${BOOTS_KEEP} 件目までは落とさず、${BOOTS_KEEP + 1} 件目で最古が落ちる`, (t) => {
  const seed = (n) => Array.from({ length: n }, (_, i) => ({ at: `seed-${i}`, head: null, branch: null, pid: i }));
  const { git } = fakeGit();
  const { log } = fakeLog();

  const atLimit = ledgerPath(t);
  writeFileSync(atLimit, JSON.stringify({ boots: seed(BOOTS_KEEP - 1) }));
  recordBoot({ file: atLimit, root: '/bridge', at: 'new', pid: 1, git, log });
  const kept = readBoots(atLimit);
  assert.equal(kept.length, BOOTS_KEEP);
  assert.equal(kept[0].at, 'seed-0');
  assert.equal(kept.at(-1).at, 'new');

  const over = ledgerPath(t);
  writeFileSync(over, JSON.stringify({ boots: seed(BOOTS_KEEP) }));
  recordBoot({ file: over, root: '/bridge', at: 'new', pid: 1, git, log });
  const dropped = readBoots(over);
  assert.equal(dropped.length, BOOTS_KEEP);
  assert.equal(dropped[0].at, 'seed-1', '最古 (seed-0) だけが落ちる');
  assert.equal(dropped.at(-2).at, `seed-${BOOTS_KEEP - 1}`);
  assert.equal(dropped.at(-1).at, 'new');
});

test('git が読めなければ head / branch を null にして記録は残す', (t) => {
  const cases = [
    { name: 'git が失敗', head: new Error('not a git repository'), branch: new Error('not a git repository'), want: { head: null, branch: null } },
    { name: 'detached', head: `${HEAD}\n`, branch: 'HEAD\n', want: { head: HEAD, branch: null } },
    { name: '40 桁の hex でない', head: '0123456\n', branch: 'main\n', want: { head: null, branch: 'main' } },
    { name: '空の出力', head: '', branch: '', want: { head: null, branch: null } },
  ];
  for (const c of cases) {
    const file = ledgerPath(t);
    const { git } = fakeGit({ head: c.head, branch: c.branch });
    const { log, lines } = fakeLog();
    const result = recordBoot({ file, root: '/bridge', at: 'now', pid: 7, git, log });
    assert.equal(result.recorded, true, c.name);
    assert.deepEqual(readBoots(file), [{ at: 'now', ...c.want, pid: 7 }], c.name);
    assert.equal(lines.log.length, 1, c.name);
  }
});

test('読めない台帳・形の違う台帳は書き換えずにログだけ残す', (t) => {
  const cases = [
    { name: 'JSON として読めない', text: '{"boots": [' },
    { name: 'トップレベルが配列', text: '[]' },
    { name: 'boots が配列でない', text: '{"boots": {"at": "x"}}' },
    { name: 'boots が null', text: '{"boots": null}' },
    // 文字列は spread できてしまう (配列の判定が無いと 1 文字ずつの entry で上書きする)
    { name: 'boots が文字列', text: '{"boots": "abc"}' },
  ];
  for (const c of cases) {
    const file = ledgerPath(t);
    writeFileSync(file, c.text);
    const { git } = fakeGit();
    const { log, lines } = fakeLog();
    const result = recordBoot({ file, root: '/bridge', at: 'now', pid: 7, git, log });
    assert.equal(result.recorded, false, c.name);
    // 「台帳を直す」と「書込み先を直す」は打つ手が違うので、読めない台帳を書込みの失敗として報告しない
    assert.doesNotMatch(result.reason, /書けません/, c.name);
    assert.equal(readFileSync(file, 'utf8'), c.text, `${c.name}: 台帳が書き換わった`);
    assert.equal(existsSync(`${file}.tmp`), false, c.name);
    assert.equal(lines.error.length, 1, c.name);
    assert.match(lines.error[0], /HEAD 0123456 \(main\)/, `${c.name}: 書かなくても版はログに出す`);
    assert.deepEqual(lines.log, [], c.name);
  }
});

test('boots の無い台帳は空から始め、他のキーは残す', (t) => {
  const file = ledgerPath(t);
  writeFileSync(file, JSON.stringify({ note: 'keep' }));
  const { git } = fakeGit();
  const result = recordBoot({ file, root: '/bridge', at: 'now', pid: 7, git, log: fakeLog().log });
  assert.equal(result.recorded, true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { note: 'keep', boots: [{ at: 'now', head: HEAD, branch: 'main', pid: 7 }] });
});

test('書けなくても throw しない (起動を止めない)', (t) => {
  // 親が通常ファイルなので mkdir / write が通らない
  const parent = ledgerPath(t);
  writeFileSync(parent, 'not a directory');
  const { git } = fakeGit();
  const { log, lines } = fakeLog();
  const result = recordBoot({ file: join(parent, 'boots.json'), root: '/bridge', at: 'now', pid: 7, git, log });
  assert.equal(result.recorded, false);
  assert.match(result.reason, /書けません/);
  assert.equal(lines.error.length, 1);
  assert.equal(readFileSync(parent, 'utf8'), 'not a directory');
});

test('index.js は二重起動の lock を取った後・最初の台帳と Discord より前に 1 回だけ記録する', () => {
  const index = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  const calls = [...index.matchAll(/recordBoot\(/g)];
  assert.equal(calls.length, 1, 'recordBoot の呼び出しは 1 か所');
  const at = calls[0].index;
  assert.ok(index.indexOf('acquireInstanceLock({') < at, 'lock より前に記録している');
  assert.ok(at < index.indexOf('new SessionStore('), '最初の台帳より後に記録している');
  const login = index.indexOf('.loginBots(');
  assert.ok(login > 0 && at < login, 'Discord へのログインより後に記録している');
  // 起動時刻は STARTED_AT (lock の timeOrigin ではない)
  assert.match(index.slice(at, at + 400), /at: new Date\(STARTED_AT\)\.toISOString\(\)/);
});
