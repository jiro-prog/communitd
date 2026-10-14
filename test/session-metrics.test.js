import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_CONTEXT, collectJobs, simulateCuts } from '../scripts/session-metrics.mjs';

// scripts/session-metrics.mjs — セッションの切り替えのしきい値を実データで測り直す道具。
// 集計と再生は純関数なので、記録の行を手で組んで固定する

const prompt = (ts, text = '依頼') => JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } });
const reply = (ts, id, ctx, out = 10, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, ...extra.entry,
  message: { id, model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: ctx - 1, cache_creation_input_tokens: 0, output_tokens: out }, ...extra.message },
});

test('collectJobs: 本体の user 発言で job を区切り、合成・subagent・重複・ツール結果は数えない', () => {
  const lines = [
    prompt('2026-09-01T00:00:00Z'),
    reply('2026-09-01T00:00:01Z', 'a', 50000),
    reply('2026-09-01T00:00:01Z', 'a', 50000), // 同じ message の 2 ブロック目 (重複)
    JSON.stringify({ type: 'user', timestamp: '2026-09-01T00:00:02Z', toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } }),
    reply('2026-09-01T00:00:03Z', 'b', 60000, 20),
    reply('2026-09-01T00:00:03Z', 's', 900000, 5, { entry: { isSidechain: true } }),
    JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-09-01T00:01:00Z', message: { content: 'Continue' } }),
    prompt('2026-09-10T00:00:00Z'),
    reply('2026-09-10T00:00:00Z', 'z', 0, 0, { message: { model: '<synthetic>' } }),
    reply('2026-09-10T00:00:01Z', 'c', 70000, 30),
    'broken',
  ];
  assert.deepEqual(collectJobs(lines), [{ ctx: [50000, 60000], out: 30 }, { ctx: [70000], out: 30 }]);
  assert.deepEqual(collectJobs(lines, { since: '2026-09-05' }), [{ ctx: [70000], out: 30 }]);
});

test('simulateCuts: 切らない再生は実データの合計に一致し、切ると次の job が rebuilt から始まる', () => {
  // job 1: 100k → 180k / job 2: 200k (間に 20k 足された) → 260k
  const chains = [[{ ctx: [100000, 180000], out: 0 }, { ctx: [200000, 260000], out: 0 }]];
  const none = simulateCuts(chains, { threshold: Infinity, rebuilt: 75000 });
  assert.equal(none.input, 100000 + 180000 + 200000 + 260000);
  assert.equal(none.cuts, 0);
  // 180k > 150k なので job 2 は 75k から始まり、job 内の伸び (+60k) はそのまま
  const cut = simulateCuts(chains, { threshold: 150000, rebuilt: 75000 });
  assert.equal(cut.input, 100000 + 180000 + 75000 + 135000);
  assert.equal(cut.cuts, 1, '2 本目の終わり (135k) はしきい値以下なので切らない');
  // 後に続く job が 1 本だけなら、メモと作り直しの書き込みの分だけ切るほうが高い (切って得するのは後が長いとき)
  assert.ok(cut.cost > none.cost);
});

test('simulateCuts: CLI 自身の compaction で縮んだ分はそのまま当て、土台より下には行かない', () => {
  // job 2 の頭が job 1 の終わりより小さい = CLI が compaction した
  const chains = [[{ ctx: [300000], out: 0 }, { ctx: [60000, 80000], out: 0 }]];
  assert.equal(simulateCuts(chains, { threshold: Infinity, rebuilt: 75000 }).input, 300000 + 60000 + 80000);
  // 切った後の再生でも、縮んだ分を引いて土台を割ることはない
  const shrink = [[{ ctx: [100000], out: 0 }, { ctx: [50000], out: 0 }, { ctx: [10000], out: 0 }]];
  assert.equal(simulateCuts(shrink, { threshold: Infinity, rebuilt: 75000 }).input, 100000 + 50000 + BASE_CONTEXT);
});
