import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  JST_LABEL,
  JST_OFFSET_MS,
  formatJst,
  jstDayKey,
  msOfTime,
} from '../src/time.js';

test('msOfTime は ms / Date / ISO 文字列だけを受ける (壊れた値は NaN)', () => {
  const ms = Date.parse('2026-08-28T09:00:00.000Z');
  assert.equal(msOfTime(ms), ms);
  assert.equal(msOfTime(new Date(ms)), ms);
  assert.equal(msOfTime('2026-08-28T09:00:00.000Z'), ms);
  // Number() に通すと 0 や 1970 年に化けるものを、読めなかったものとして返す
  for (const bad of [null, undefined, '', '   ', 'いま', {}, [], NaN]) {
    assert.ok(Number.isNaN(msOfTime(bad)), `${JSON.stringify(bad)} を時刻として読んでいる`);
  }
});

test('jstDayKey は UTC 15:00 で日を変える (= JST 0 時)', () => {
  assert.equal(jstDayKey('2026-08-27T14:59:59.999Z'), '2026-08-27');
  assert.equal(jstDayKey('2026-08-27T15:00:00.000Z'), '2026-08-28');
  // UTC 暦日で切っていた頃の境目 (09:00) では日が変わらないことも固定しておく
  assert.equal(jstDayKey('2026-08-26T23:59:59.999Z'), '2026-08-27');
  assert.equal(jstDayKey('2026-08-27T00:00:00.000Z'), '2026-08-27');
});

test('formatJst は札つきの JST で書く (読めない値は null)', () => {
  assert.equal(formatJst('2026-08-28T09:00:00.000Z'), `2026-08-28 18:00 ${JST_LABEL}`);
  assert.equal(formatJst('2026-08-28T09:00:00.000Z', { label: false }), '2026-08-28 18:00');
  assert.equal(formatJst(Date.parse('2026-08-28T15:00:00.000Z')), '2026-08-29 00:00 JST');
  // 言い換えは呼び出し側の文脈で決めるので、ここでは黙って null
  for (const bad of [null, undefined, '', 'いま', NaN, Infinity]) {
    assert.equal(formatJst(bad), null, JSON.stringify(bad));
    assert.equal(jstDayKey(bad), null, JSON.stringify(bad));
  }
});

test('JST は夏時間が無いので通年 +09:00 (固定オフセットで刻んでよい根拠)', () => {
  assert.equal(JST_OFFSET_MS, 9 * 60 * 60 * 1000);
  assert.equal(formatJst('2026-01-15T00:00:00.000Z'), '2026-01-15 09:00 JST');
  assert.equal(formatJst('2026-07-15T00:00:00.000Z'), '2026-07-15 09:00 JST');
});

test('Date が表せない範囲でも投げずに null (表示のために落ちない)', () => {
  // 8.64e15 が Date の両端。+9 時間ずらすと範囲を外れる
  assert.equal(formatJst(8.64e15), null);
  assert.equal(jstDayKey(8.64e15), null);
});

test('time.js は時計を読まない (渡された値を刻むだけ)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/time.js', import.meta.url)), 'utf8');
  for (const forbidden of ['Date.now(', 'setTimeout', 'setInterval', 'node:fs', 'process.env']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} を使っている`);
  }
  // 判断だけの層 (scheduler.js) がここへ依存できるのは、この性質があるからこそ。
  // ここが何かを import し始めたら、向こうの純粋性ガードが黙って抜ける
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, [], '暦の層が何かへ依存している');
});
