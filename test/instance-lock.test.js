import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as realFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INSTANCE_LOCK_FILE,
  acquireInstanceLock,
  formatLockRefusal,
  releaseInstanceLock,
} from '../src/instance-lock.js';
import { SPAWN_TIME_TOLERANCE_MS } from '../src/procstate.js';

// 本体の data/ は触らない — 毎回一時ディレクトリの下に data/ を作って回す
const T0 = Date.parse('2026-10-07T03:00:00.000Z');
const ME = 5151;
const OTHER = 4242;

function tempData(t) {
  const root = mkdtempSync(join(tmpdir(), 'instance-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'data');
}

function placeLock(dataDir, content) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, INSTANCE_LOCK_FILE);
  writeFileSync(path, content);
  return path;
}

const holderContent = (pid = OTHER, at = T0) => `${JSON.stringify({ pid, at: new Date(at).toISOString() })}\n`;
const seen = (over = {}) => ({ alive: true, createdAt: T0 + 500, name: 'node.exe', command: 'node src/index.js', error: null, ...over });

/** 呼ばれた pid を数える inspect */
function fakeInspect(answer) {
  const calls = [];
  const inspect = async (pid) => {
    calls.push(pid);
    return typeof answer === 'function' ? answer(pid, calls.length) : answer;
  };
  return { inspect, calls };
}

const acquire = (dataDir, over = {}) => acquireInstanceLock({ dataDir, pid: ME, startedAt: T0 + 3_600_000, ...over });

test('新規取得: data/ が無い初回は作ってから取り、pid と起動時刻を書く', async (t) => {
  const dataDir = tempData(t);
  assert.equal(existsSync(dataDir), false);
  const { inspect, calls } = fakeInspect(seen());
  const res = await acquire(dataDir, { inspect });
  assert.equal(res.ok, true);
  assert.equal(res.stolen, null);
  assert.equal(res.path, join(dataDir, INSTANCE_LOCK_FILE));
  assert.deepEqual(JSON.parse(readFileSync(res.path, 'utf8')), { pid: ME, at: new Date(T0 + 3_600_000).toISOString() });
  assert.deepEqual(calls, [], '持ち主がいないのに OS へ聞いている');
});

test('alive で断る: 持ち主が居て起動時刻も合うなら、lock に触らず在処と pid と手順を返す', async (t) => {
  const dataDir = tempData(t);
  const path = placeLock(dataDir, holderContent());
  const { inspect, calls } = fakeInspect(seen());
  const res = await acquire(dataDir, { inspect });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'alive');
  assert.deepEqual(res.holder, { pid: OTHER, at: new Date(T0).toISOString() });
  assert.deepEqual(calls, [OTHER]);
  assert.equal(readFileSync(path, 'utf8'), holderContent(), '生きている持ち主の lock を書き換えている');

  const text = formatLockRefusal(res).join('\n');
  assert.match(text, /別のブリッジが動いています/);
  assert.ok(text.includes(path), 'lock の在処が出ていない');
  assert.match(text, new RegExp(`pid ${OTHER}`));
  assert.match(text, /別のブリッジが居ないと確かめてから.*消して起動し直して/);
});

test('alive の幅は SPAWN_TIME_TOLERANCE_MS — 幅の内側は alive、外側は pid の再利用 (gone)', async (t) => {
  const dirIn = tempData(t);
  placeLock(dirIn, holderContent());
  const at = await acquire(dirIn, { inspect: fakeInspect(seen({ createdAt: T0 + SPAWN_TIME_TOLERANCE_MS })).inspect });
  assert.equal(at.reason, 'alive');

  const dirOut = tempData(t);
  placeLock(dirOut, holderContent());
  const out = await acquire(dirOut, { inspect: fakeInspect(seen({ createdAt: T0 + SPAWN_TIME_TOLERANCE_MS + 1 })).inspect });
  assert.equal(out.ok, true, '起動時刻が幅の外なのに奪っていない');
});

test('unknown で断る: 聞けなかった・投げた・起動時刻を読めないは gone ではない', async (t) => {
  const cases = [
    ['聞けなかった', fakeInspect(seen({ alive: false, createdAt: null, error: 'powershell exited with code 1' })).inspect, /powershell exited/],
    ['inspect が投げた', async () => { throw new Error('spawn EPERM'); }, /spawn EPERM/],
    ['起動時刻を読めない', fakeInspect(seen({ createdAt: null })).inspect, /起動時刻を読めません/],
  ];
  for (const [label, inspect, why] of cases) {
    const dataDir = tempData(t);
    const path = placeLock(dataDir, holderContent());
    const res = await acquire(dataDir, { inspect });
    assert.equal(res.ok, false, label);
    assert.equal(res.reason, 'unknown', label);
    assert.equal(res.holder.pid, OTHER, label);
    assert.match(res.detail, why, label);
    assert.equal(readFileSync(path, 'utf8'), holderContent(), `${label}: 確かめられないのに lock を書き換えている`);
    const text = formatLockRefusal(res).join('\n');
    assert.match(text, /確かめられません/, label);
    assert.ok(text.includes(path), label);
    assert.match(text, new RegExp(`ps -p ${OTHER}`), label);
  }
});

test('壊れた中身で断る: 空・JSON でない・pid が無い/不正・起動時刻が無い/読めない は OS に聞かずに断る', async (t) => {
  const broken = [
    '',
    '{ not json',
    'null',
    JSON.stringify({ at: new Date(T0).toISOString() }),
    JSON.stringify({ pid: '4242', at: new Date(T0).toISOString() }),
    JSON.stringify({ pid: -1, at: new Date(T0).toISOString() }),
    JSON.stringify({ pid: OTHER }),
    JSON.stringify({ pid: OTHER, at: 'きのう' }),
  ];
  for (const content of broken) {
    const dataDir = tempData(t);
    const path = placeLock(dataDir, content);
    const { inspect, calls } = fakeInspect(seen({ alive: false, createdAt: null }));
    const res = await acquire(dataDir, { inspect });
    assert.equal(res.ok, false, content);
    assert.equal(res.reason, 'unreadable', content);
    assert.equal(res.holder, null, content);
    assert.deepEqual(calls, [], `${content}: 読めない中身の pid を OS に聞いている`);
    assert.equal(readFileSync(path, 'utf8'), content, `${content}: 読めない lock を消している`);
    const text = formatLockRefusal(res).join('\n');
    assert.match(text, /中身を読めません/, content);
    assert.ok(text.includes(path), content);
    assert.match(text, /消して起動し直して/, content);
  }
});

test('gone で奪う: 居ない・pid の再利用なら lock を自分のものに書き換え、前の持ち主を返す', async (t) => {
  const cases = [
    ['居ない', seen({ alive: false, createdAt: null, name: null, command: null })],
    ['pid の再利用', seen({ createdAt: T0 + 60_000 })],
  ];
  for (const [label, answer] of cases) {
    const dataDir = tempData(t);
    const path = placeLock(dataDir, holderContent());
    const res = await acquire(dataDir, { inspect: fakeInspect(answer).inspect });
    assert.equal(res.ok, true, label);
    assert.deepEqual(res.stolen, { pid: OTHER, at: new Date(T0).toISOString() }, label);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, ME, label);
  }
});

test('gone で奪う: 自分の pid が書いてあれば、書いた側はもう居ない (OS に聞かない)', async (t) => {
  const dataDir = tempData(t);
  const path = placeLock(dataDir, holderContent(ME, T0));
  const { inspect, calls } = fakeInspect(seen());
  const res = await acquire(dataDir, { inspect });
  assert.equal(res.ok, true);
  assert.equal(res.stolen.pid, ME);
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).at, new Date(T0 + 3_600_000).toISOString());
});

test('解放は中身が自分の pid のときだけ — 奪われた後・壊れた中身・消えた後は触らず投げない', async (t) => {
  const dataDir = tempData(t);
  const res = await acquire(dataDir, { inspect: fakeInspect(seen()).inspect });
  assert.equal(releaseInstanceLock({ path: res.path, pid: OTHER }), false);
  assert.equal(existsSync(res.path), true, '他人の pid で消している');
  assert.equal(releaseInstanceLock({ path: res.path, pid: ME }), true);
  assert.equal(existsSync(res.path), false);
  assert.equal(releaseInstanceLock({ path: res.path, pid: ME }), false, '消えた後に投げている');

  // 奪われた後 (中身が別の pid) と、壊れた中身は残す
  for (const content of [holderContent(OTHER), '{ not json', '']) {
    writeFileSync(res.path, content);
    assert.equal(releaseInstanceLock({ path: res.path, pid: ME }), false, content);
    assert.equal(readFileSync(res.path, 'utf8'), content, content);
  }
});

test('wx の EEXIST 競合: 残骸を消した直後に別のブリッジが取ったら、その lock を消さずに断る', async (t) => {
  const dataDir = tempData(t);
  const path = placeLock(dataDir, holderContent(OTHER, T0));
  const RIVAL = 6262;
  const rival = holderContent(RIVAL, T0 + 3_600_000);
  // 残骸 (OTHER) を消した瞬間に、同時に起動した別のブリッジ (RIVAL) が wx で取る
  const fs = {
    ...realFs,
    unlinkSync: (p) => {
      realFs.unlinkSync(p);
      writeFileSync(p, rival, { flag: 'wx' });
    },
  };
  const { inspect, calls } = fakeInspect((pid) => (pid === OTHER
    ? seen({ alive: false, createdAt: null })
    : seen({ createdAt: T0 + 3_600_000 + 200 })));
  const res = await acquire(dataDir, { fs, inspect });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'alive');
  assert.equal(res.holder.pid, RIVAL);
  assert.deepEqual(calls, [OTHER, RIVAL]);
  assert.equal(readFileSync(path, 'utf8'), rival, '先に取った側の lock を上書きしている');
});

test('wx の EEXIST 競合: 確かめている間に持ち主が入れ替わったら、新しい持ち主を消さない', async (t) => {
  const dataDir = tempData(t);
  const path = placeLock(dataDir, holderContent(OTHER, T0));
  const RIVAL = 6262;
  const rival = holderContent(RIVAL, T0 + 3_600_000);
  // OTHER を確かめている間に、別のブリッジが残骸を奪って自分の lock を置いた
  const { inspect, calls } = fakeInspect((pid) => {
    if (pid === OTHER) {
      writeFileSync(path, rival);
      return seen({ alive: false, createdAt: null });
    }
    return seen({ createdAt: T0 + 3_600_000 + 200 });
  });
  const res = await acquire(dataDir, { inspect });
  assert.equal(res.reason, 'alive');
  assert.equal(res.holder.pid, RIVAL);
  assert.deepEqual(calls, [OTHER, RIVAL]);
  assert.equal(readFileSync(path, 'utf8'), rival, '入れ替わった持ち主の lock を消している');
});

test('wx の EEXIST 競合: EEXIST の直後に持ち主が手放していたら取り直して取る', async (t) => {
  const dataDir = tempData(t);
  let first = true;
  const fs = {
    ...realFs,
    writeFileSync: (p, data, opts) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      return realFs.writeFileSync(p, data, opts);
    },
  };
  const { inspect, calls } = fakeInspect(seen());
  const res = await acquire(dataDir, { fs, inspect });
  assert.equal(res.ok, true);
  assert.equal(res.stolen, null);
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(readFileSync(res.path, 'utf8')).pid, ME);
});

test('取り直しは上限で止まる: 奪っても奪っても取れないなら contended で断る', async (t) => {
  const stale = holderContent(OTHER, T0);
  let writes = 0;
  const fs = {
    mkdirSync: () => {},
    writeFileSync: () => {
      writes += 1;
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    },
    readFileSync: () => stale,
    unlinkSync: () => {},
  };
  const res = await acquire(tempData(t), { fs, inspect: fakeInspect(seen({ alive: false, createdAt: null })).inspect });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'contended');
  assert.equal(writes, 3);
  assert.match(formatLockRefusal(res).join('\n'), /起動しません/);
});

test('lock を作れない (EEXIST 以外) は断り、消す手順は出さない', async (t) => {
  const fs = {
    ...realFs,
    writeFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
  };
  const res = await acquire(tempData(t), { fs, inspect: fakeInspect(seen()).inspect });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'error');
  assert.match(res.detail, /EACCES/);
  const lines = formatLockRefusal(res);
  assert.match(lines.join('\n'), /EACCES/);
  assert.equal(lines.some((l) => /消して/.test(l)), false, '作れなかった lock を消せと言っている');
});

test('lock を取るのはブリッジ本体だけ — 最初の台帳より前に取り、exit で消す。doctor・new-project・scripts は取らない', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  const index = read('src/index.js');
  const acquireAt = index.indexOf('await acquireInstanceLock(');
  assert.ok(acquireAt > index.indexOf('validateConfig(loadedConfig'), '設定の検証より前に lock を取っている');
  const firstStore = index.search(/new \w+Store\(/);
  assert.ok(acquireAt >= 0 && acquireAt < firstStore, '最初の台帳を開いた後に lock を取っている');
  assert.match(index, /process\.on\('exit', \(\) => releaseInstanceLock\(/);

  const takers = [
    ...readdirSync(fileURLToPath(new URL('../src', import.meta.url)))
      .filter((f) => f.endsWith('.js') && f !== 'index.js' && f !== 'instance-lock.js')
      .map((f) => `src/${f}`),
    ...readdirSync(fileURLToPath(new URL('../scripts', import.meta.url)))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `scripts/${f}`),
  ].filter((rel) => read(rel).includes('instance-lock'));
  assert.deepEqual(takers, []);
});
