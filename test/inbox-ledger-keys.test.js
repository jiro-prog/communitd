// 受信箱の台帳でキーと entry.id がずれていても、見つけたキーへ書く (src/inbox.js の InboxStore.get)。
// 手で編集した台帳を想定して、JSON を直接書いてから読ませる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InboxStore, formatInbox } from '../src/inbox.js';

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const minutes = (n) => n * 60000;

const row = (over = {}) => ({
  channel: 'dev',
  threadId: 'T1',
  botKey: 'worker',
  summary: '仕様に無い配置の裁定をお願いします',
  messageId: 'M1',
  openedAt: new Date(T0).toISOString(),
  closedAt: null,
  closedBy: null,
  ...over,
});

/** 手編集された台帳を書いて読む。一時ディレクトリはテストの後で消す */
function ledger(t, data) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-inbox-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'inbox.json');
  writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, store: new InboxStore(file) };
}

const onDisk = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** 一覧の「停止・質問」の行から `#id` を拾う (作者が写して打つもの) */
const shownIds = (store) => [...formatInbox({ notifies: store.openList(), now: T0 }).matchAll(/^・#(\S+) /gm)]
  .map((m) => m[1]);

test('キー "5" に id "7" の entry: closeByThread はキー "5" を閉じ、キー "7" を作らない', (t) => {
  const { file, store } = ledger(t, { 5: row({ id: '7' }) });

  const closed = store.closeByThread('T1', { now: T0 + minutes(5) });

  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, '5', '返した entry の id が台帳のキーと違う');
  assert.deepEqual(Object.keys(onDisk(file)), ['5'], '別のキーへ書いている');
  assert.equal(onDisk(file)['5'].closedBy, 'human-reply');
  assert.equal(onDisk(file)['5'].closedAt, new Date(T0 + minutes(5)).toISOString());
  assert.equal(onDisk(file)['5'].id, '5', '書き戻した entry の id がキーへ直っていない');
  assert.deepEqual(store.openList(), [], '閉じたのに一覧に残っている');
});

test('キー "5" に id "7" の entry: close はキー "5" で閉じ、キー "7" を作らない', (t) => {
  const { file, store } = ledger(t, { 5: row({ id: '7' }) });

  const closed = store.close('5', { now: T0 + minutes(5) });

  assert.equal(closed?.closedBy, 'manual');
  assert.deepEqual(Object.keys(onDisk(file)), ['5'], '別のキーへ書いている');
  assert.equal(onDisk(file)['5'].closedBy, 'manual');
  assert.deepEqual(store.openList(), []);
  assert.equal(store.close('5'), null, '閉じ済みをもう一度閉じている');
});

test('ずれた id では閉じない — 一意なのはキーだけで、同じ id の別 entry と取り違えない', (t) => {
  const { file, store } = ledger(t, {
    5: row({ id: '7', threadId: 'T1' }),
    7: row({ id: '7', threadId: 'T2' }),
  });

  assert.deepEqual(shownIds(store).sort(), ['5', '7'], '一覧の #id が重複している');
  const closed = store.close('7', { now: T0 + minutes(5) });

  assert.equal(closed?.threadId, 'T2', 'キー "7" の entry ではないものを閉じている');
  assert.equal(onDisk(file)['5'].closedAt, null, 'id がずれた entry を巻き添えで閉じている');
  assert.deepEqual(store.openList().map((e) => e.id), ['5']);
});

test('id の無い entry を閉じても "undefined" キーを作らない (closeByThread / close)', (t) => {
  const { file, store } = ledger(t, {
    3: row({ threadId: 'T1' }),
    4: row({ threadId: 'T2' }),
  });

  assert.equal(store.closeByThread('T1', { now: T0 + minutes(5) })[0]?.id, '3');
  assert.equal(store.close('4', { now: T0 + minutes(6) })?.id, '4');

  const data = onDisk(file);
  assert.deepEqual(Object.keys(data).sort(), ['3', '4'], '"undefined" などのゴミキーが増えている');
  assert.equal(data['3'].closedBy, 'human-reply');
  assert.equal(data['4'].closedBy, 'manual');
  assert.deepEqual(store.openList(), []);
});

test('一覧に出る #id をそのまま close:<id> に写すと閉じられる (ずれた id・id 無し・揃った id)', (t) => {
  const { file, store } = ledger(t, {
    5: row({ id: '7', threadId: 'T1' }),
    6: row({ threadId: 'T2' }),
    8: row({ id: '8', threadId: 'T3' }),
  });

  const ids = shownIds(store);
  assert.deepEqual(ids.sort(), ['5', '6', '8'], '一覧の #id が台帳のキーと違う');
  for (const id of ids) {
    assert.ok(store.close(id, { now: T0 + minutes(5) }), `一覧の #${id} を写しても閉じられない`);
  }

  assert.deepEqual(store.openList(), [], '閉じたのに一覧に残っている');
  assert.deepEqual(Object.keys(onDisk(file)).sort(), ['5', '6', '8'], '別のキーへ書いている');
});

test('1 スレッド 1 open の上書きも見つけたキーへ書く (ずれた id・id 無し)', (t) => {
  const { file, store } = ledger(t, {
    5: row({ id: '7', threadId: 'T1' }),
    6: row({ threadId: 'T2' }),
  });

  const first = store.open({ channel: 'dev', threadId: 'T1', botKey: 'other', summary: '催促です' }, { now: T0 + minutes(5) });
  const second = store.open({ channel: 'dev', threadId: 'T2', botKey: 'other', summary: '催促です' }, { now: T0 + minutes(6) });

  assert.equal(first.id, '5');
  assert.equal(second.id, '6');
  const data = onDisk(file);
  assert.deepEqual(Object.keys(data).sort(), ['5', '6'], '上書きのはずが別のキーを足している');
  assert.equal(data['5'].summary, '催促です');
  assert.equal(data['5'].botKey, 'other');
  assert.equal(data['6'].summary, '催促です');
  assert.equal(store.openList().length, 2, '催促で件数が増えている');

  // 上書きは採番しない — 次に来た別スレッドの通知はキーの最大 + 1
  assert.equal(store.open({ threadId: 'T9' }, { now: T0 + minutes(7) }).id, '7');
});

test('閉じた後に読み直しても、キーと id が揃ったまま閉じている', (t) => {
  const { file, store } = ledger(t, { 5: row({ id: '7' }) });
  store.close('5', { now: T0 + minutes(5) });

  const reloaded = new InboxStore(file);
  assert.equal(reloaded.get('5')?.closedBy, 'manual');
  assert.equal(reloaded.get('7'), null);
  assert.deepEqual(reloaded.openList(), []);
});
