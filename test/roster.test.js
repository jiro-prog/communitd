import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RosterStore,
  applyRoster,
  formatRoster,
  parseRosterMembers,
  resolveEffectiveRoster,
} from '../src/roster.js';

const KEYS = ['fable', 'opus', 'sol'];
const ENTRIES = [
  { key: 'fable', displayName: 'Fable', userId: 'B1' },
  { key: 'opus', displayName: 'Opus', userId: 'B2' },
  { key: 'sol', displayName: 'Sol', userId: null },
];

function tempFile(name = 'roster.json') {
  return join(mkdtempSync(join(tmpdir(), 'communitd-roster-')), name);
}

// ---- parseRosterMembers ----

test('parseRosterMembers は区切りを問わず bot キーを拾う', () => {
  for (const input of ['opus sol', 'opus,sol', 'opus, sol', 'opus、sol', '@opus /sol', 'OPUS Sol']) {
    assert.deepEqual(parseRosterMembers(input, KEYS), { ok: true, keys: ['opus', 'sol'] }, input);
  }
});

test('parseRosterMembers は重複を畳み、指定順を保つ', () => {
  assert.deepEqual(parseRosterMembers('sol opus sol', KEYS), { ok: true, keys: ['sol', 'opus'] });
});

test('parseRosterMembers: 空と all は解除 (keys = null)', () => {
  for (const input of ['', '   ', 'all', 'ALL', 'clear', 'reset', '解除', '全員', null, undefined]) {
    assert.deepEqual(parseRosterMembers(input, KEYS), { ok: true, keys: null }, String(input));
  }
});

test('parseRosterMembers: none は「誰も呼べない」(keys = [])', () => {
  for (const input of ['none', 'solo', 'なし', '単独']) {
    assert.deepEqual(parseRosterMembers(input, KEYS), { ok: true, keys: [] }, input);
  }
});

test('parseRosterMembers は未知キーが 1 つでもあれば部分適用しない', () => {
  const r = parseRosterMembers('opus haiku', KEYS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /haiku/);
  assert.match(r.reason, /fable \/ opus \/ sol/);
  assert.equal(r.keys, undefined, '拒否なのに keys を返している');
});

// ---- applyRoster ----

test('applyRoster: 未設定なら全員 inRoster', () => {
  for (const allowed of [null, undefined, 'opus']) {
    assert.deepEqual(applyRoster(ENTRIES, allowed).map((e) => e.inRoster), [true, true, true]);
  }
});

test('applyRoster: 編成外は inRoster: false で残す (消さない)', () => {
  const marked = applyRoster(ENTRIES, ['opus']);
  assert.deepEqual(marked.map((e) => e.key), ['fable', 'opus', 'sol'], '配列から消してはいけない');
  assert.deepEqual(marked.map((e) => e.inRoster), [false, true, false]);
  // 元の配列は書き換えない
  assert.equal(ENTRIES[0].inRoster, undefined);
});

test('applyRoster: 空の編成は全員 false', () => {
  assert.deepEqual(applyRoster(ENTRIES, []).map((e) => e.inRoster), [false, false, false]);
});

// ---- formatRoster ----

test('formatRoster は未設定・空・面子ありを言い分ける', () => {
  assert.match(formatRoster(null, ENTRIES), /未設定/);
  assert.match(formatRoster([], ENTRIES), /誰も呼べません/);
  assert.equal(formatRoster(['opus', 'sol'], ENTRIES), 'Opus (`opus`) / Sol (`sol`)');
  assert.equal(formatRoster(['ghost'], ENTRIES), 'ghost (`ghost`)', '表示名が無ければキーで出す');
});

// ---- RosterStore ----

test('RosterStore は未設定スレッドに null を返す', () => {
  const store = new RosterStore(tempFile());
  assert.equal(store.get('T1'), null);
  assert.equal(store.clear('T1'), false, '消すものが無いのに true');
});

test('RosterStore は set/get/clear が永続する', () => {
  const path = tempFile();
  const store = new RosterStore(path);
  store.set('T1', ['opus', 'sol'], { setBy: 'U1' });
  store.set('T2', []);

  const reloaded = new RosterStore(path);
  assert.deepEqual(reloaded.get('T1'), ['opus', 'sol']);
  assert.deepEqual(reloaded.get('T2'), [], '空の編成 (誰も呼べない) が未設定に化けている');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).T1.setBy, 'U1');

  assert.equal(reloaded.clear('T1'), true);
  assert.equal(new RosterStore(path).get('T1'), null);
});

// 保存できなかったのにメモリだけ新しくなっていると、/roster が「変えていません」と
// 返した直後の job がその編成で走る。書けない状況を実ファイルで作って確かめる
// (保存先と同名のディレクトリを置くと rename が EPERM / EISDIR で落ちる)
test('RosterStore: set が保存に失敗したら元の状態へ戻す', () => {
  const path = tempFile();
  const store = new RosterStore(path);
  store.set('T1', ['opus']);

  rmSync(path);
  mkdirSync(path); // ここから先は保存できない
  assert.throws(() => store.set('T1', ['fable']), /EPERM|EISDIR|EACCES/);
  assert.deepEqual(store.get('T1'), ['opus'], '保存に失敗したのにメモリだけ変わっている');
  assert.throws(() => store.set('T2', ['sol']));
  assert.equal(store.get('T2'), null, '保存に失敗した新規スレッドが残っている');
});

test('RosterStore: clear が保存に失敗したら編成を消さない', () => {
  const path = tempFile();
  const store = new RosterStore(path);
  store.set('T1', ['opus']);

  rmSync(path);
  mkdirSync(path);
  assert.throws(() => store.clear('T1'), /EPERM|EISDIR|EACCES/);
  assert.deepEqual(store.get('T1'), ['opus'], '保存に失敗したのに編成が消えている');
});

// 2026-09-07 §12.3 (1): 壊れた台帳は退避せず在処に残し、直すまで書き込みを断る
// (退避して空から始めると、次の起動が「初回」に見えて証拠も停止状態も消える)
test('RosterStore は壊れたファイルを退避せず、直すまで書き込みを断る', () => {
  const path = tempFile();
  writeFileSync(path, '{ broken');
  const store = new RosterStore(path);
  assert.equal(store.get('T1'), null);
  assert.throws(() => store.set('T1', ['opus']), /台帳を直すか手で退避してから/);
  assert.equal(readFileSync(path, 'utf8'), '{ broken', '壊れたファイルが動かされている');
});

// ---- resolveEffectiveRoster (スレッド編成 > チャンネル既定) ----

test('resolveEffectiveRoster: どちらも無ければ制限なし', () => {
  assert.deepEqual(resolveEffectiveRoster(null, null), { keys: null, source: null });
  assert.deepEqual(resolveEffectiveRoster(), { keys: null, source: null });
});

test('resolveEffectiveRoster: スレッド編成が無ければチャンネル既定が効く', () => {
  assert.deepEqual(resolveEffectiveRoster(null, ['opus']), { keys: ['opus'], source: 'channel' });
});

test('resolveEffectiveRoster: スレッド編成はチャンネル既定を上書きする', () => {
  assert.deepEqual(
    resolveEffectiveRoster(['sol'], ['opus']),
    { keys: ['sol'], source: 'thread' },
    'スレッドで明示した編成が既定に負けている',
  );
});

test('resolveEffectiveRoster: 空配列は「誰も呼べない」という有効な編成', () => {
  // ?? で書くと [] が falsy でないので通るが、[] を「未設定」と誤ると
  // /roster none を打ったスレッドでチャンネル既定へ落ちてしまう
  assert.deepEqual(resolveEffectiveRoster([], ['opus']), { keys: [], source: 'thread' });
  assert.deepEqual(resolveEffectiveRoster(null, []), { keys: [], source: 'channel' });
});

test('formatRoster: チャンネル既定は出所を併記する', () => {
  assert.match(formatRoster(['opus'], ENTRIES, 'channel'), /Opus \(`opus`\) \(チャンネル既定\)/);
  assert.match(formatRoster([], ENTRIES, 'channel'), /誰も呼べません.*\(チャンネル既定\)/);
  // スレッド編成と未設定には付けない (出所が自明・従来の文言のまま)
  assert.equal(formatRoster(['opus'], ENTRIES, 'thread'), formatRoster(['opus'], ENTRIES));
  assert.match(formatRoster(null, ENTRIES, 'channel'), /未設定/);
});
