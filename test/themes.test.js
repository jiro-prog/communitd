import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DEFAULT_PLANNER_MAX_THEMES } from '../src/config.js';
import { THEME_STATES, parseThemes, themeCost, themeCostText, themeProgress, themesGate } from '../src/themes.js';

// src/themes.js — 主題ファイルの見出しを数え、企画の巡回を起こすかを決める純粋関数。

test('parseThemes: 見出しの状態・slug・題を読む (区切りは — / – / - / -- のどれでも)', () => {
  const { themes, problems } = parseThemes([
    '# 主題',
    '',
    '## [active] pi-worker — Sol を worker にする',
    '- 目的: 止まらない',
    '## [done] owner-view – 見るべきものを束ねる',
    '## [dropped] webhook - GitHub から起きる',
    '## [active] slug-only',
    '## [active] two-dash -- 区切りが 2 つ',
    '### [active] small — 小見出しは数えない',
    '## ふつうの見出し',
  ].join('\n'));
  assert.deepEqual(themes, [
    { state: 'active', slug: 'pi-worker', title: 'Sol を worker にする' },
    { state: 'done', slug: 'owner-view', title: '見るべきものを束ねる' },
    { state: 'dropped', slug: 'webhook', title: 'GitHub から起きる' },
    { state: 'active', slug: 'slug-only', title: '' },
    { state: 'active', slug: 'two-dash', title: '区切りが 2 つ' },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(THEME_STATES, ['active', 'waiting', 'done', 'dropped']);
  assert.deepEqual(parseThemes('## [waiting] job-cost — 配備待ち').themes, [{ state: 'waiting', slug: 'job-cost', title: '配備待ち' }]);
});

test('parseThemes: コメントとコードフェンスの中の見出しは数えない', () => {
  const { themes } = parseThemes([
    '<!-- 様式',
    '## [active] sample — 見本',
    '-->',
    '<!-- 1 行 --> ## [active] after-comment — 1 行のコメントの後ろは読む',
    '```md',
    '## [active] fenced — フェンスの中',
    '```',
    '~~~',
    '## [active] tilde — チルダのフェンス',
    '~~~',
    '## [active] real — 本物 <!-- 末尾のコメントは消す -->',
    '## [active] opens — 開いたまま <!--',
    '## [active] inside — 閉じていないコメントの中',
    '-->',
  ].join('\r\n'));
  assert.deepEqual(themes.map((t) => t.slug), ['after-comment', 'real', 'opens']);
  assert.equal(themes[1].title, '本物');
});

test('parseThemes: 形の崩れた見出しと slug の重複は数えずに problems へ積む', () => {
  const { themes, problems } = parseThemes([
    '## [進行中] jp-state — 状態が日本語',
    '## [active] Upper — slug に大文字',
    '## [active]',
    '## [active] dup — 1 つ目',
    '## [done] dup — 2 つ目',
  ].join('\n'));
  assert.deepEqual(themes, [{ state: 'active', slug: 'dup', title: '1 つ目' }]);
  assert.deepEqual(problems, [
    '読めない見出し: ## [進行中] jp-state — 状態が日本語',
    '読めない見出し: ## [active] Upper — slug に大文字',
    '読めない見出し: ## [active]',
    'slug の重複: dup',
  ]);
  assert.deepEqual(parseThemes(null), { themes: [], problems: [] });
  assert.deepEqual(parseThemes(''), { themes: [], problems: [] });
});

test('parseThemes: 置いてある主題ファイルの見出しはすべて読め、様式の見本は主題に数えない', (t) => {
  // 主題ファイルは開発側のリポジトリにだけある (公開スナップショットは docs/reference/ 以外の docs/ を出さない)
  const file = new URL('../docs/themes.md', import.meta.url);
  if (!existsSync(file)) return t.skip('主題ファイルなし (docs/themes.md は公開スナップショットに入らない)');
  const text = readFileSync(file, 'utf8');
  const { problems } = parseThemes(text);
  assert.deepEqual(problems, [], '見本か説明の行が読めない見出しに化けている');
  assert.ok(text.includes('## [active] slug — 題'), '見本の見出しが消えた (この試験の前提)');
});

test('themeProgress: 題の頭が [slug] のタスクを状態で数える', () => {
  const tasks = [
    { id: '1', state: 'merged', title: '[pi-worker] resume を入れる' },
    { id: '2', state: 'in-progress', title: '  [pi-worker] apply_patch' },
    { id: '3', state: 'blocked', title: '[pi-worker] Sol を worker に' },
    { id: '4', state: 'dropped', title: '[pi-worker] 捨てた案' },
    { id: '5', state: 'merged', title: '[pi-worker-x] 別の主題 (前方一致で拾わない)' },
    { id: '6', state: 'merged', title: 'pi-worker の話だが印が無い' },
    { id: '7', state: 'merged', title: 'x [pi-worker] 頭でない' },
  ];
  assert.deepEqual(themeProgress(tasks, 'pi-worker'), { merged: 1, open: 2, dropped: 1 });
  assert.deepEqual(themeProgress(null, 'pi-worker'), { merged: 0, open: 0, dropped: 0 });
});

// ---- themeCost / themeCostText (主題のタスクが使った job の重さ) ----

const COST_TASKS = [
  { id: '1', state: 'merged', title: '[job-cost] 実行記録に重さを残す' },
  { id: '2', state: 'in-progress', title: '[job-cost] 主題の行に添える' },
  { id: '3', state: 'merged', title: '[job-cost-x] 別の主題 (前方一致で拾わない)' },
  { id: '4', state: 'merged', title: 'job-cost の話だが印が無い' },
];
const AT = Date.parse('2026-10-14T00:00:00.000Z');
const iso = (min) => new Date(AT + min * 60_000).toISOString();
/** 実行記録 1 本。from / to は AT からの分 (null = 時刻なし)、kind は契約の種別 */
function costRun(id, taskId, { from = 0, to = 1, kind = null, evidence = {} } = {}) {
  return {
    id, taskId, botKey: 'opus', channelName: 'kt', threadId: 'X', stage: 'ended',
    startedAt: from === null ? null : iso(from), endedAt: to === null ? null : iso(to),
    contract: kind ? { kind } : null, evidence,
  };
}
const FULL = (toolCalls, verifyMs, tokens) => ({ toolCalls, verifyMs, tokens });

test('themeCost: 主題外の job は数えない (別の主題・印の無いタスク・taskId なし・ボードに無いタスク)', () => {
  const big = FULL(1000, 600_000, { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 });
  const runs = [
    costRun('in', '1', { to: 10, evidence: FULL(30, 90_000, { input: 1000, cacheRead: 20_000, cacheWrite: 3000, output: 500 }) }),
    costRun('other-theme', '3', { to: 60, evidence: big }),
    costRun('no-mark', '4', { to: 60, evidence: big }),
    costRun('scout', null, { to: 60, evidence: big }),
    costRun('unknown', '99', { to: 60, evidence: big }),
  ];
  assert.deepEqual(themeCost(COST_TASKS, runs, 'job-cost'), {
    jobs: 1,
    toolCalls: { n: 1, sum: 30 },
    minutes: { n: 1, sum: 10 },
    verifyMinutes: { n: 1, sum: 1.5 },
    tokens: { n: 1, sum: 24_500 },
  });
  // task.id と run.taskId の型が違っても String で突き合わせる
  assert.equal(themeCost(COST_TASKS, [costRun('num', 2)], 'job-cost').jobs, 1);
});

test('themeCost: レビュー・承認の job も数える (種別を問わない)', () => {
  const runs = [
    costRun('work', '1', { to: 10, evidence: FULL(30, 90_000, { input: 1000, cacheRead: 20_000, cacheWrite: 3000, output: 500 }) }),
    costRun('review', '2', { to: 4.5, kind: 'task-review', evidence: FULL(12, 30_000, { input: 500, cacheRead: 10_000, cacheWrite: 0, output: 1000 }) }),
    // 承認の job は verify が無い (verifyMs: null)
    costRun('approval', '1', { to: 0.5, kind: 'task-approval', evidence: FULL(3, null, { input: 200, cacheRead: 5000, cacheWrite: 0, output: 300 }) }),
  ];
  const cost = themeCost(COST_TASKS, runs, 'job-cost');
  assert.deepEqual(cost, {
    jobs: 3,
    toolCalls: { n: 3, sum: 45 },
    minutes: { n: 3, sum: 15 },
    verifyMinutes: { n: 2, sum: 2 },
    tokens: { n: 3, sum: 41_500 },
  });
  // 41,500 → 千単位で四捨五入して 42k
  assert.equal(themeCostText(cost), '・job 3 本 (tool 計 45・分 計 15.0・verify 分 計 2.0 (2/3 本)・トークン 計 42k)');
});

test('themeCost: 終端の無い job (走っている・起動できなかった・時計が逆) は分から外れ、(n/N 本) が付く', () => {
  const runs = [
    costRun('ended', '1', { from: 0, to: 12.25, evidence: { toolCalls: 5 } }),
    costRun('live', '1', { from: 20, to: null, evidence: { toolCalls: 2 } }),
    costRun('refused', '2', { from: null, to: 30, evidence: {} }),
    costRun('clock', '2', { from: 40, to: 39, evidence: { toolCalls: 1 } }),
  ];
  const cost = themeCost(COST_TASKS, runs, 'job-cost');
  assert.equal(cost.jobs, 4, '終端の無い job を job 数から落としている');
  assert.deepEqual(cost.minutes, { n: 1, sum: 12.25 });
  assert.deepEqual(cost.toolCalls, { n: 3, sum: 8 });
  // 分は小数 1 桁
  assert.equal(themeCostText(cost), '・job 4 本 (tool 計 8 (3/4 本)・分 計 12.3 (1/4 本))');
});

test('themeCost: 値の無い欄は出さない (この鍵の無い古い記録・壊れた値)', () => {
  // #163 より前の記録には verifyMs / tokens の鍵そのものが無い
  const old = [
    costRun('a', '1', { to: 2, evidence: { toolCalls: 4 } }),
    costRun('b', '2', { to: 1, evidence: { toolCalls: 3, verifyMs: -1, tokens: 'x' } }),
  ];
  const text = themeCostText(themeCost(COST_TASKS, old, 'job-cost'));
  assert.equal(text, '・job 2 本 (tool 計 7・分 計 3.0)');
  assert.doesNotMatch(text, /verify|トークン/);
  // 全欄に値が無ければ括弧ごと出さない (tool 呼び出しの壊れた値も数えない)
  const bare = [costRun('c', '1', { from: null, to: null, evidence: { toolCalls: 1.5 } }), costRun('d', '2', { from: null, to: null })];
  assert.equal(themeCostText(themeCost(COST_TASKS, bare, 'job-cost')), '・job 2 本');
});

test('themeCost: 0 本 (主題のタスクが無い・実行記録が無い) / 重さが無ければ文面も無い', () => {
  const zero = { jobs: 0, toolCalls: { n: 0, sum: 0 }, minutes: { n: 0, sum: 0 }, verifyMinutes: { n: 0, sum: 0 }, tokens: { n: 0, sum: 0 } };
  const runs = [costRun('in', '1', { evidence: { toolCalls: 3 } })];
  assert.deepEqual(themeCost(COST_TASKS, runs, 'no-such-theme'), zero);
  assert.deepEqual(themeCost(COST_TASKS, [], 'job-cost'), zero);
  assert.deepEqual(themeCost(null, null, 'job-cost'), zero);
  assert.equal(themeCostText(zero), '・job 0 本');
  assert.equal(themeCostText(null), '');
});

test('themeCost: tokens が一部だけある (取れた種類だけ足し、1 種でもあればその job を数える)', () => {
  const runs = [
    // usage の一部だけ取れた job (取れなかった種類は null — src/bridge/queue.js の tokensOf)
    costRun('part', '1', { evidence: { tokens: { input: 1200, cacheRead: null, cacheWrite: null, output: 300 } } }),
    // usage を返さないランタイム (器ごと null)
    costRun('none', '1', { evidence: { tokens: null } }),
    // 4 種とも壊れた値は無いのと同じ
    costRun('broken', '2', { evidence: { tokens: { input: -5, cacheRead: 'x', cacheWrite: 1.5, output: null } } }),
  ];
  const cost = themeCost(COST_TASKS, runs, 'job-cost');
  assert.deepEqual(cost.tokens, { n: 1, sum: 1500 });
  assert.match(themeCostText(cost), /・トークン 計 2k \(1\/3 本\)\)$/);
  // 千単位の四捨五入の境目: 499 → 0k、500 → 1k
  const only = (sum) => themeCostText({ ...themeCost([], [], 'x'), jobs: 1, tokens: { n: 1, sum } });
  assert.equal(only(499), '・job 1 本 (トークン 計 0k)');
  assert.equal(only(500), '・job 1 本 (トークン 計 1k)');
});

test('themesGate: 上限未満なら足す、上限なら振り返りだけ、読めなければ閉じる', () => {
  const active = (slug) => ({ state: 'active', slug, title: slug });
  const parsed = (themes) => ({ themes, problems: [] });

  const empty = themesGate(parsed([]), { maxThemes: 2 });
  assert.deepEqual(empty, { due: true, mode: 'add', active: [], waiting: [], reason: '進行中の主題 0 / 上限 2' });

  const one = themesGate(parsed([active('a'), { state: 'done', slug: 'b', title: '' }]), { maxThemes: 2 });
  assert.equal(one.mode, 'add');
  assert.deepEqual(one.active.map((t) => t.slug), ['a'], '完了した主題を進行中に数えている');

  const full = themesGate(parsed([active('a'), active('b')]), { maxThemes: 2 });
  assert.equal(full.due, true, '上限で閉じると、進まない主題が枠を塞いだまま印を付けに来ない');
  assert.equal(full.mode, 'review');
  assert.equal(full.reason, '進行中の主題が上限 (2 / 2) — 振り返りが先');

  // 配備待ち (waiting) は枠に数えない — 残りが配備を待つだけの主題が枠を塞ぐと、配備まで種が止まる
  const waiting = (slug) => ({ state: 'waiting', slug, title: slug });
  const held = themesGate(parsed([active('a'), waiting('b'), waiting('c')]), { maxThemes: 2 });
  assert.equal(held.mode, 'add');
  assert.deepEqual(held.active.map((t) => t.slug), ['a']);
  assert.deepEqual(held.waiting.map((t) => t.slug), ['b', 'c']);
  assert.equal(held.reason, '進行中の主題 1 / 上限 2 (配備待ち 2 は数えない)');
  assert.equal(themesGate(parsed([active('a'), active('b'), waiting('c')]), { maxThemes: 2 }).reason,
    '進行中の主題が上限 (2 / 2) (配備待ち 1 は数えない) — 振り返りが先');

  assert.deepEqual(themesGate(parsed([]), { missing: true }), {
    due: true, mode: 'add', active: [], waiting: [], reason: '主題のファイルがまだ無い',
  });
  assert.deepEqual(themesGate(null), { due: false, mode: null, active: [], waiting: [], reason: '主題のファイルを読めない' });
  // 上限の既定 (壊れた値も既定へ倒す)
  const many = parsed(Array.from({ length: DEFAULT_PLANNER_MAX_THEMES }, (_, i) => active(`t${i}`)));
  assert.equal(themesGate(many).mode, 'review');
  assert.equal(themesGate(many, { maxThemes: 0 }).mode, 'review');
});
