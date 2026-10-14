// 受信箱の閉じ済み entry の掃除 (src/inbox.js の InboxStore.pruneClosed)。
// 起動時に呼ぶのは src/index.js だが、判断はすべて pruneClosed にあるので store を直接呼ぶ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InboxStore } from '../src/inbox.js';
import { RUN_RETENTION_MS } from '../src/jobruns.js';

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** 保持期間 (30 日) を 1 日過ぎた時刻 */
const LATER = T0 + RUN_RETENTION_MS + DAY;

const row = (id, over = {}) => ({
  id,
  channel: 'dev',
  threadId: `T${id}`,
  botKey: 'worker',
  summary: '仕様に無い配置の裁定をお願いします',
  messageId: `M${id}`,
  openedAt: iso(T0 - DAY),
  closedAt: iso(T0),
  closedBy: 'human-reply',
  ...over,
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-inbox-prune-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 台帳を書いて読む。**インデント無しで書く** — 保存 (2 字下げ) が走ったかを中身の差で見分けるため */
function ledger(t, data) {
  const file = join(tempDir(t), 'inbox.json');
  writeFileSync(file, JSON.stringify(data));
  return { file, store: new InboxStore(file) };
}

const onDisk = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('閉じてから 30 日を過ぎた entry を消し、件数を返す (保存し直しても戻らない)', (t) => {
  const { file, store } = ledger(t, { 1: row('1'), 2: row('2'), 3: row('3', { closedAt: null, closedBy: null }) });

  assert.equal(store.pruneClosed({ now: LATER }), 2);

  assert.deepEqual(Object.keys(onDisk(file)), ['3']);
  assert.deepEqual(Object.keys(new InboxStore(file).data), ['3'], '読み直すと消した entry が戻っている');
});

test('保持期間の既定は実行記録と同じ 30 日 (ちょうど 30 日は残し、それを過ぎたら消す)', (t) => {
  const { store } = ledger(t, {
    1: row('1', { closedAt: iso(T0) }),
    2: row('2', { closedAt: iso(T0 + 1) }),
    9: row('9', { closedAt: null, closedBy: null }),
  });

  assert.equal(store.pruneClosed({ now: T0 + RUN_RETENTION_MS }), 0, 'ちょうど 30 日で消している');
  assert.equal(store.pruneClosed({ now: T0 + RUN_RETENTION_MS + 1 }), 1);
  assert.deepEqual(Object.keys(store.data).sort(), ['2', '9'], '閉じて 30 日に届かない entry まで消している');
});

test('開いている entry は、開いてから何日経っていても消さない', (t) => {
  const { file, store } = ledger(t, {
    1: row('1', { openedAt: iso(T0 - 90 * DAY), closedAt: null, closedBy: null }),
    2: row('2', { openedAt: iso(T0 - 90 * DAY), closedAt: undefined, closedBy: null }),
    3: row('3', { closedAt: null, closedBy: null }),
  });

  assert.equal(store.pruneClosed({ now: LATER }), 0);
  assert.deepEqual(store.openList().map((entry) => entry.id), ['1', '2', '3']);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(onDisk(file)), '消すものが無いのに書いている');
});

test('キーが最大の entry は、閉じて 30 日を過ぎていても消さない', (t) => {
  const { file, store } = ledger(t, { 1: row('1'), 2: row('2'), 10: row('10') });

  assert.equal(store.pruneClosed({ now: LATER }), 2);

  assert.deepEqual(Object.keys(onDisk(file)), ['10'], '最大キーの entry を消している');
});

test('掃除の後の nextId は番号を使い回さない (古い一覧の close:<id> が新しい通知を閉じない)', (t) => {
  const { store } = ledger(t, { 1: row('1'), 2: row('2'), 3: row('3') });
  assert.equal(store.nextId(), '4');

  assert.equal(store.pruneClosed({ now: LATER }), 2);

  assert.equal(store.nextId(), '4', '掃除で採番が巻き戻った');
  const fresh = store.open({ threadId: 'T-new', summary: '新しい質問' }, { now: LATER });
  assert.equal(fresh.id, '4');
  assert.equal(store.close('1', { now: LATER }), null, '消した番号で新しい通知が閉じられる');
  assert.equal(store.close('3', { now: LATER }), null, '閉じ済みの番号で新しい通知が閉じられる');
  assert.deepEqual(store.openList().map((entry) => entry.id), ['4']);
});

test('closedAt を日時として読めない entry は残す (いつ閉じたか分からないものを古いと決めない)', (t) => {
  const { file, store } = ledger(t, {
    1: row('1', { closedAt: 'いつか' }),
    2: row('2', { closedAt: '' }),
    3: row('3', { closedAt: true }),
    4: row('4', { closedAt: {} }),
    5: row('5'),
    9: row('9', { closedAt: null, closedBy: null }),
  });

  assert.equal(store.pruneClosed({ now: LATER }), 1);

  assert.deepEqual(Object.keys(onDisk(file)), ['1', '2', '3', '4', '9']);
});

test('閉じてから未来の時刻 (時計のずれ) の entry は消さない', (t) => {
  const { store } = ledger(t, { 1: row('1', { closedAt: iso(LATER + DAY) }), 9: row('9', { closedAt: null }) });

  assert.equal(store.pruneClosed({ now: LATER }), 0);
});

test('消すものが無ければ書かない (台帳の書式もそのまま)', (t) => {
  const { file, store } = ledger(t, { 1: row('1'), 2: row('2', { closedAt: null, closedBy: null }) });
  const before = readFileSync(file, 'utf8');

  assert.equal(store.pruneClosed({ now: T0 + DAY }), 0);

  assert.equal(readFileSync(file, 'utf8'), before);
});

test('台帳が無い配備では data/inbox.json を新しく作らない', (t) => {
  const file = join(tempDir(t), 'data', 'inbox.json');
  const store = new InboxStore(file);

  assert.equal(store.pruneClosed({ now: LATER }), 0);

  assert.equal(existsSync(file), false, '掃除が台帳を作っている');
});

test('台帳が読めないときは書かず、投げもしない (起動を止めない)', (t) => {
  const file = join(tempDir(t), 'inbox.json');
  const broken = '{"1": {"closedAt": "2026-01-01T00:00:00.000Z"'; // 途中で切れた JSON
  writeFileSync(file, broken);
  const store = new InboxStore(file);
  assert.ok(store.broken, '壊れた台帳が broken になっていない (前提)');

  assert.equal(store.pruneClosed({ now: LATER }), 0);

  assert.equal(readFileSync(file, 'utf8'), broken, '壊れた台帳の上から書いている');
});

test('object でない entry には触らない (掃除するのは閉じた記録だけ)', (t) => {
  const { file, store } = ledger(t, { 1: 'ゴミ', 2: [1, 2], 3: row('3'), 9: row('9', { closedAt: null }) });

  assert.equal(store.pruneClosed({ now: LATER }), 1);

  assert.deepEqual(onDisk(file), { 1: 'ゴミ', 2: [1, 2], 9: row('9', { closedAt: null }) });
});
