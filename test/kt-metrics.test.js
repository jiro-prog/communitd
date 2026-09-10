import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatSummary, parseArgs, readBoard, summarizeBoard } from '../scripts/kt-metrics.mjs';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const BOTS = ['fable', 'opus', 'sol', 'opus2'];

/** 起票 → merged までを 1 本の履歴にする (所要 = minutes) */
const merged = (id, minutes, over = {}) => ({
  id,
  channel: 'kumamikan-tools',
  state: 'merged',
  createdAt: iso(0),
  updatedAt: iso(minutes),
  history: [
    { at: iso(0), from: null, to: 'proposed', by: 'opus' },
    { at: iso(1), from: 'proposed', to: 'approved', by: 'opus2' },
    { at: iso(2), from: 'approved', to: 'in-progress', by: 'scheduler' },
    { at: iso(minutes - 1), from: 'in-progress', to: 'review', by: 'opus' },
    { at: iso(minutes), from: 'review', to: 'merged', by: 'opus2' },
  ],
  ...over,
});

const open = (id, state, over = {}) => ({
  id,
  channel: 'kumamikan-tools',
  state,
  createdAt: iso(0),
  updatedAt: iso(5),
  history: [{ at: iso(0), from: null, to: 'proposed', by: 'opus' }],
  ...over,
});

const one = (tasks) => summarizeBoard(tasks, { botKeys: BOTS, now: T0 }).channels[0];

test('summarizeBoard: 起票・着地・open の内訳を数える (blocked は open 側)', () => {
  const sum = one([
    merged('41', 10),
    merged('42', 20),
    open('43', 'proposed'),
    open('44', 'approved'),
    open('45', 'in-progress'),
    open('46', 'review'),
    open('47', 'blocked'),
    open('48', 'dropped'),
    null, // 壊れた値が混ざっても落ちない
  ]);
  assert.equal(sum.channel, 'kumamikan-tools');
  assert.equal(sum.filed, 8);
  assert.equal(sum.merged, 2);
  assert.equal(sum.dropped, 1);
  assert.equal(sum.blocked, 1);
  // 終端 (merged / dropped) だけが閉じている。blocked は resume で戻せるので open
  assert.equal(sum.open, 5);
  assert.deepEqual(sum.openByState, {
    proposed: 1, approved: 1, 'in-progress': 1, review: 1, blocked: 1,
  });
});

test('summarizeBoard: 差し戻しは履歴 (review → in-progress) の回数で数える', () => {
  const sentBack = merged('45', 30, {
    history: [
      { at: iso(0), from: null, to: 'proposed', by: 'opus' },
      { at: iso(5), from: 'in-progress', to: 'review', by: 'opus' },
      { at: iso(6), from: 'review', to: 'in-progress', by: 'opus2' },
      { at: iso(29), from: 'in-progress', to: 'review', by: 'opus' },
      { at: iso(30), from: 'review', to: 'merged', by: 'opus2' },
    ],
  });
  assert.equal(one([sentBack, merged('41', 10)]).sendBacks, 1);
  assert.equal(one([sentBack, sentBack]).sendBacks, 2);
  assert.equal(one([merged('41', 10)]).sendBacks, 0);
});

test('summarizeBoard: bot でも scheduler でもない by は人間の介入として数える', () => {
  const sum = one([
    open('46', 'review', {
      history: [
        { at: iso(0), from: null, to: 'proposed', by: 'opus' },
        { at: iso(1), from: 'proposed', to: 'approved', by: 'opus2' },
        { at: iso(2), from: 'approved', to: 'in-progress', by: 'scheduler' },
        // config の bots にも scheduler にも無い = 人間が動かした (/review・手作業)
        { at: iso(3), from: 'in-progress', to: 'review', by: 'owner:So' },
        { at: iso(4), from: 'review', to: 'in-progress', by: '  ' }, // 空白は不明
        { at: iso(5), from: 'in-progress', to: 'review' }, // 移行前の古い行 = 不明
      ],
    }),
  ]);
  assert.deepEqual(sum.by, {
    bots: { opus: 1, opus2: 1 }, scheduler: 1, owner: 1, unknown: 2,
  });

  // botKeys を渡さなければ**全部が人間扱い**になる (呼び出し側が config を読む前提)
  const blind = summarizeBoard([open('1', 'review')], { now: T0 }).channels[0];
  assert.deepEqual(blind.by, { bots: {}, scheduler: 0, owner: 1, unknown: 0 });
});

test('summarizeBoard: proposed→merged の中央値と p90 (nearest-rank)', () => {
  const sum = one([
    merged('41', 10), merged('42', 100), merged('43', 30), merged('44', 20), merged('45', 40),
  ]);
  assert.equal(sum.lead.count, 5);
  assert.equal(sum.lead.medianMin, 30);
  // nearest-rank: ceil(0.9 * 5) = 5 番目 = 100 分
  assert.equal(sum.lead.p90Min, 100);

  // 偶数件は中央 2 つの平均 / 1 件なら両方その値
  assert.equal(one([merged('1', 10), merged('2', 21)]).lead.medianMin, 15.5);
  assert.equal(one([merged('1', 7)]).lead.medianMin, 7);
  assert.equal(one([merged('1', 7)]).lead.p90Min, 7);
});

test('summarizeBoard: merged が 0 件でも落ちない / 時刻の読めない merged は数えない', () => {
  const none = one([open('43', 'proposed'), open('44', 'approved')]);
  assert.deepEqual(none.lead, { count: 0, medianMin: null, p90Min: null });

  // 履歴に to:'merged' が無い・時刻が壊れている・逆順は所要に混ぜない
  const broken = one([
    merged('41', 10, { history: [{ at: iso(0), from: null, to: 'proposed', by: 'opus' }] }),
    merged('42', 10, { history: [{ at: 'いつか', from: 'review', to: 'merged', by: 'opus2' }] }),
    merged('43', 10, {
      history: [
        { at: iso(50), from: null, to: 'proposed', by: 'opus' },
        { at: iso(10), from: 'review', to: 'merged', by: 'opus2' },
      ],
    }),
  ]);
  assert.equal(broken.merged, 3, '着地の件数は数える');
  assert.equal(broken.lead.count, 0, '読めない時刻を所要に混ぜている');
});

test('summarizeBoard: チャンネルごとに分け、名前の昇順で返す', () => {
  const out = summarizeBoard(
    [
      merged('41', 10),
      { ...open('1', 'approved'), channel: 'observatory' },
      { ...open('2', 'approved'), channel: undefined },
    ],
    { botKeys: BOTS, now: T0 },
  );
  assert.deepEqual(out.channels.map((c) => c.channel), [
    '(チャンネル不明)', 'kumamikan-tools', 'observatory',
  ]);
  assert.equal(out.at, new Date(T0).toISOString(), '集計時刻は渡された now');
  assert.deepEqual(summarizeBoard(null, { now: T0 }).channels, []);
});

test('formatSummary: 数字が読める形で並ぶ (0 件でも黙らない)', () => {
  const summary = summarizeBoard(
    [merged('41', 10), merged('42', 30), open('43', 'approved'), open('44', 'dropped')],
    { botKeys: BOTS, now: T0 },
  );
  const text = formatSummary(summary, { file: 'data/tasks.json' });
  assert.match(text, /ボード: data\/tasks\.json/);
  assert.match(text, /## kumamikan-tools/);
  assert.match(text, /起票 4 \/ merged 2 \/ dropped 1 \/ blocked 0/);
  assert.match(text, /open 1 \(proposed 0 \/ approved 1 \/ in-progress 0 \/ review 0 \/ blocked 0\)/);
  assert.match(text, /差し戻し 0 回/);
  assert.match(text, /遷移主体: opus \d+ \/ opus2 \d+ \/ scheduler \d+ \/ owner 0 \/ 不明 0/);
  assert.match(text, /proposed→merged: 2 件 中央値 20 分 \/ p90 30 分/);

  const empty = formatSummary(summarizeBoard([], { now: T0 }));
  assert.match(empty, /タスクがありません/);
  assert.match(
    formatSummary(summarizeBoard([open('1', 'approved')], { botKeys: BOTS, now: T0 })),
    /proposed→merged: 0 件 \(まだ着地していない\)/,
  );
});

/** 空の一時ディレクトリ (中身を数えて「何も作っていない」を確かめる) */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'communitd-metrics-'));
}

test('readBoard: 無いファイルは空ボードにせず落ちる (何も作らない)', () => {
  const dir = tempDir();
  const file = join(dir, 'tasks.json');
  assert.throws(() => readBoard(file), (err) => {
    assert.match(err.message, /読めません/);
    assert.ok(err.message.includes(file), `理由にパスが無い: ${err.message}`);
    return true;
  });
  // 「無い」を「0 件」と同じ数字にしないのが要点。ついでに作ってもいない
  assert.deepEqual(readdirSync(dir), [], '読むだけの CLI がファイルを作っている');
});

test('readBoard: 壊れた JSON は退避リネームせずに落ちる', () => {
  const dir = tempDir();
  const file = join(dir, 'tasks.json');
  writeFileSync(file, '{', 'utf8');

  assert.throws(() => readBoard(file), /JSON として読めません/);
  // JsonStore は壊れた入力を `.corrupt-<時刻>` へ退避する。集計でそれをやらない
  assert.deepEqual(readdirSync(dir), ['tasks.json'], '元ファイル以外のものが増えている');
  assert.equal(readFileSync(file, 'utf8'), '{', '元ファイルを書き換えている');
});

test('readBoard: task らしい値だけを読む (トップレベルが object でなければ落ちる)', () => {
  const dir = tempDir();
  const file = join(dir, 'tasks.json');
  writeFileSync(file, JSON.stringify({
    1: { id: '1', channel: 'kumamikan-tools', state: 'merged', title: 'A' },
    x: 'junk', // 手で編集された値が混ざっても落とさない
    2: { id: '2' }, // state が読めないものは task ではない
    3: ['a'],
    4: null,
  }), 'utf8');
  assert.deepEqual(
    readBoard(file).map((task) => task.id),
    ['1'],
  );

  for (const raw of ['[]', '"x"', 'null', '3']) {
    writeFileSync(file, raw, 'utf8');
    assert.throws(() => readBoard(file), /トップレベルが id → タスクの object ではありません/, raw);
  }
  writeFileSync(file, '{}', 'utf8');
  assert.deepEqual(readBoard(file), [], '空のボードは 0 件 (これは正しい 0)');
});

test('parseArgs: --file と --channel だけを受け、知らないものは断る', () => {
  const out = parseArgs(['--channel', 'kumamikan-tools', '--file', 'data/other.json']);
  assert.equal(out.channel, 'kumamikan-tools');
  assert.equal(out.file, 'data/other.json');
  // 省略時は既定のボード (絶対パス) を見る
  assert.equal(parseArgs([]).channel, null);
  assert.match(parseArgs([]).file, /tasks\.json$/);

  for (const argv of [['--bogus'], ['kumamikan-tools'], ['--file'], ['--channel', '--file']]) {
    assert.throws(() => parseArgs(argv), /知らないオプション|値が渡されていません/, JSON.stringify(argv));
  }
});
