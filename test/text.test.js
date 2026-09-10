import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from '../src/text.js';

test('chunkText は上限以下ならそのまま 1 個', () => {
  assert.deepEqual(chunkText('hello', 10), ['hello']);
  assert.deepEqual(chunkText('', 10), ['']);
});

test('chunkText は全チャンクが上限以下で結合すると元に戻る', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 100, `chunk が上限超過: ${c.length}`);
  assert.equal(chunks.join(''), text);
});

test('chunkText は改行のない長文も上限で切る', () => {
  const chunks = chunkText('x'.repeat(250), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.equal(chunks.join(''), 'x'.repeat(250));
});

test('chunkText は改行位置を優先して切る', () => {
  const chunks = chunkText(`${'a'.repeat(80)}\n${'b'.repeat(80)}`, 100);
  assert.deepEqual(chunks, ['a'.repeat(80), `\n${'b'.repeat(80)}`]);
});

/** 行頭フェンスの数 (奇数なら閉じ忘れ = そのチャンク単体で表示が崩れる) */
function fenceCount(chunk) {
  return (chunk.match(/^[ \t]*`{3,}/gm) ?? []).length;
}

test('chunkText はコードブロックをまたぐとき閉じて開き直す', () => {
  const body = ['```js', ...Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`), '```'].join('\n');
  const chunks = chunkText(body, 100);

  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 100, `chunk が上限超過: ${c.length}`);
    assert.equal(fenceCount(c) % 2, 0, `フェンスが閉じていない: ${JSON.stringify(c)}`);
  }
  // 補った開き直しは言語指定まで引き継ぐ。境界の改行と二重にならない
  for (const c of chunks.slice(1)) assert.match(c, /^```js\nconst x\d+ = \d+;/);
  // 中身は 1 行も落ちていない・増えていない
  const code = chunks.join('\n').split('\n').filter((l) => /^const x\d+ = \d+;$/.test(l));
  assert.equal(code.length, 30);
});

test('chunkText はコードブロックの外では何も足さない', () => {
  const body = ['```', 'short', '```', ...Array.from({ length: 20 }, (_, i) => `plain line ${i}`)].join('\n');
  const chunks = chunkText(body, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), body); // 補完が無ければ結合して元どおり
});

test('chunkText はフェンス行そのものを割らない', () => {
  // 直前の改行が上限の半分より手前 = 素朴に切ると ``` の途中で切れる配置
  const body = `${'a'.repeat(30)}\n\`\`\`javascript\n${'b'.repeat(200)}\n\`\`\``;
  const chunks = chunkText(body, 45);
  for (const c of chunks) {
    assert.ok(c.length <= 45, `chunk が上限超過: ${c.length}`);
    assert.equal(fenceCount(c) % 2, 0, `フェンスが閉じていない: ${JSON.stringify(c)}`);
  }
  assert.ok(!chunks.some((c) => /(^|[^`])`{1,2}$/.test(c)), `フェンスが割れている: ${JSON.stringify(chunks)}`);
});

test('chunkText は入れ子に見える短い列で閉じたことにしない', () => {
  const body = ['````', '```', ...Array.from({ length: 20 }, (_, i) => `line ${i}`), '```', '````'].join('\n');
  const chunks = chunkText(body, 60);
  assert.ok(chunks.length > 1);
  for (const c of chunks.slice(1)) {
    assert.match(c, /^````\n/); // 外側の 4 個で開き直す
    assert.doesNotMatch(c, /^`{3,}[a-z]*\n\n/, '開き直しの直後に空行が増えている');
  }
});

/** 決定的な擬似乱数 (テストがフレーキーにならないよう seed から回す) */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** フェンス・長短の行・空行を混ぜた本文 (閉じ忘れたブロックも混ざる) */
function randomBody(rand, { withInfo = false } = {}) {
  const lines = [];
  const count = 3 + Math.floor(rand() * 30);
  for (let i = 0; i < count; i++) {
    const r = rand();
    const info = withInfo && rand() < 0.5 ? 'js' : '';
    if (r < 0.2) lines.push('`'.repeat(3 + Math.floor(rand() * 2)) + info);
    else if (r < 0.3) lines.push('');
    else if (r < 0.4) lines.push('x'.repeat(1 + Math.floor(rand() * 120)));
    else lines.push(`line ${i} ${'y'.repeat(Math.floor(rand() * 20))}`);
  }
  return lines.join('\n');
}

/** 上限と、ブロックの開閉状態が分割前後で変わっていないこと */
function assertSplitSafe(body, size, label) {
  const chunks = chunkText(body, size);
  for (const c of chunks) assert.ok(c.length <= size, `上限超過 (${c.length} > ${size}) — ${label}`);
  // 途中のメッセージは必ず閉じて終わる (閉じ忘れると以降が丸ごとコード表示になる)
  for (const c of chunks.slice(0, -1)) {
    assert.equal(endsOpen(c), false, `途中のチャンクが開いたまま — ${label}`);
  }
  // 最後だけは元の状態を引き継ぐ。元が閉じ忘れているのに閉じると本文を書き換えたことになる
  assert.equal(endsOpen(chunks.at(-1)), endsOpen(body), `末尾の開閉が元と違う — ${label}`);
  return chunks;
}

/**
 * 末尾でコードブロックが開いたままか (Discord の描画に合わせた素朴なモデル)。
 * 実装と同じ規則を書き下しているので文法の正しさは見ていない。
 * ここで確かめたいのは「分割してもブロックの開閉状態が保存される」こと。
 */
function endsOpen(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = /^[ \t]*(`{3,})[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) continue;
    if (!open) open = m[1];
    else if (m[2] === '' && m[1].length >= open.length) open = null;
  }
  return open !== null;
}

test('chunkText はどんな本文でも上限・開閉状態・文字の保存を守る', () => {
  const rand = lcg(20260801);
  for (let i = 0; i < 2000; i++) {
    // 言語指定を混ぜないのは保存則を厳密に書けるようにするため。補うのがバッククォートと
    // 改行だけになるので、それを落とせば元の本文と一文字も変わらないはず。
    // 言語指定つきは次のテストで見る (境界計算には prefix の長さとしてしか効かない)
    const body = randomBody(rand);
    const size = 20 + Math.floor(rand() * 180);
    const label = `${i} 回目 / size ${size}: ${JSON.stringify(body.slice(0, 80))}`;
    const chunks = assertSplitSafe(body, size, label);

    const strip = (s) => s.replaceAll('`', '').replaceAll('\n', '');
    assert.equal(chunks.map(strip).join(''), strip(body), `本文が変わっている — ${label}`);
  }
});

test('chunkText は言語指定つきのフェンスでも上限と開閉を守る', () => {
  const rand = lcg(776);
  for (let i = 0; i < 1000; i++) {
    const body = randomBody(rand, { withInfo: true });
    const size = 20 + Math.floor(rand() * 180);
    assertSplitSafe(body, size, `${i} 回目 / size ${size}: ${JSON.stringify(body.slice(0, 80))}`);
  }
});
