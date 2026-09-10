import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { JobQueue, formatJobMetrics, laneKeyFor } from '../src/queue.js';

let seq = 0;
/** テスト用 job — run は呼ばれない (キューは起動を呼び出し側に任せる設計) */
function job(cwd, threadId, extra = {}) {
  return {
    laneKey: laneKeyFor(cwd),
    threadId,
    botKey: 'fable',
    id: `job${++seq}`,
    handle: { stopRequested: false },
    ...extra,
  };
}

/** 開始した item の id 配列 */
const ids = (items) => items.map((i) => i.id);

test('laneKeyFor は cwd を正規化する (表記ゆれを同じレーンへ)', () => {
  assert.equal(laneKeyFor('C:/tmp/a'), resolve('C:/tmp/a'));
  assert.equal(laneKeyFor('C:/tmp/a/'), laneKeyFor('C:/tmp/a'));
  assert.equal(laneKeyFor('C:/tmp/a/b/..'), laneKeyFor('C:/tmp/a'));
  assert.notEqual(laneKeyFor('C:/tmp/a'), laneKeyFor('C:/tmp/b'));
});

test('同一レーンは FIFO で 1 本ずつ', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  const a2 = job('C:/a', 't2');
  q.push(a1);
  q.push(a2);

  assert.deepEqual(ids(q.takeStartable()), [a1.id]);
  assert.deepEqual(q.takeStartable(), []); // レーンが塞がっている間は取り出せない
  assert.equal(q.activeCount, 1);
  assert.equal(q.waitingCount, 1);

  q.finish(a1);
  assert.deepEqual(ids(q.takeStartable()), [a2.id]);
});

test('異なるレーンは並行して走る', () => {
  const q = new JobQueue();
  const a = job('C:/a', 't1');
  const b = job('C:/b', 't2');
  const c = job('C:/c', 't3');
  for (const i of [a, b, c]) q.push(i);

  assert.deepEqual(ids(q.takeStartable()), [a.id, b.id, c.id]);
  assert.equal(q.activeCount, 3);
  assert.equal(q.waitingCount, 0);
});

test('塞がったレーンは後続の別レーンを妨げない (順序は保つ)', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  const a2 = job('C:/a', 't2');
  const b1 = job('C:/b', 't3');
  for (const i of [a1, a2, b1]) q.push(i);

  assert.deepEqual(ids(q.takeStartable()), [a1.id, b1.id]);
  assert.deepEqual(ids(q.waiting), [a2.id]); // a2 は a1 の後ろのまま
});

test('maxConcurrentJobs で全レーン合計の同時実行を絞れる', () => {
  const q = new JobQueue({ maxConcurrent: 2 });
  const a = job('C:/a', 't1');
  const b = job('C:/b', 't2');
  const c = job('C:/c', 't3');
  for (const i of [a, b, c]) q.push(i);

  assert.deepEqual(ids(q.takeStartable()), [a.id, b.id]);
  assert.ok(q.atCapacity());
  assert.deepEqual(q.takeStartable(), []);

  q.finish(a);
  assert.deepEqual(ids(q.takeStartable()), [c.id]);
});

test('maxConcurrent 未設定 / 0 / 不正値は無制限', () => {
  for (const maxConcurrent of [undefined, 0, -1, 1.5, null, 'x']) {
    const q = new JobQueue(maxConcurrent === undefined ? {} : { maxConcurrent });
    assert.equal(q.maxConcurrent, 0, `maxConcurrent=${String(maxConcurrent)}`);
    assert.equal(q.atCapacity(), false);
  }
  assert.equal(new JobQueue().maxConcurrent, 0);
});

test('現行 config.json 相当の 3 チャンネルは並走できる', () => {
  const q = new JobQueue({ maxConcurrent: 0 });
  const items = [
    job('C:/Users/me/projects/kumamikan', 't1'),
    job('C:/Users/me/projects/advisor-workspace', 't2'),
    job('C:/Users/me/projects/communitd/sandbox', 't3'),
  ];
  for (const i of items) q.push(i);
  assert.equal(q.takeStartable().length, 3);
});

test('wouldQueue は自レーンが塞がっている時と上限到達時だけ true', () => {
  const q = new JobQueue({ maxConcurrent: 2 });
  const a = job('C:/a', 't1');
  q.push(a);
  assert.equal(q.wouldQueue(laneKeyFor('C:/a')), true); // 受付済みの待機がある
  q.takeStartable();
  assert.equal(q.wouldQueue(laneKeyFor('C:/a')), true); // 実行中
  assert.equal(q.wouldQueue(laneKeyFor('C:/b')), false); // 別レーンは待たない

  const b = job('C:/b', 't2');
  q.push(b);
  q.takeStartable();
  assert.equal(q.wouldQueue(laneKeyFor('C:/c')), true); // 上限到達
  q.finish(a);
  assert.equal(q.wouldQueue(laneKeyFor('C:/c')), false);
});

test('計測ログは待ち時間と実行時間を分けて出す', () => {
  assert.equal(
    formatJobMetrics({
      jobId: '3f2a1b7c',
      botKey: 'opus',
      threadId: '123',
      queueWaitMs: 1234,
      runMs: 62149,
      reason: 'ok',
    }),
    '[job 3f2a1b7c opus thread:123] queueWait 1.2s / run 62.1s / ok',
  );
});

test('計測ログの時間は 0 未満・非数を 0 秒として出す (時計のずれで壊れない)', () => {
  const line = (queueWaitMs, runMs) =>
    formatJobMetrics({ jobId: 'x', botKey: 'fable', threadId: '1', queueWaitMs, runMs, reason: 'aborted' });
  assert.equal(line(-5, 0), '[job x fable thread:1] queueWait 0.0s / run 0.0s / aborted');
  assert.equal(line(undefined, NaN), '[job x fable thread:1] queueWait 0.0s / run 0.0s / aborted');
});

test('計測ログは渡した prompt の内訳も出す (role 込みの実投入量)', () => {
  assert.equal(
    formatJobMetrics({
      jobId: 'x',
      botKey: 'opus',
      threadId: '1',
      queueWaitMs: 0,
      runMs: 1000,
      reason: 'ok',
      promptChars: 12345,
      rolePromptChars: 4000,
      contextMessages: 18,
      omittedMessages: 4,
    }),
    '[job x opus thread:1] queueWait 0.0s / run 1.0s / prompt 12345 chars (role 4000) / ctx 18 件 (省略 4) / ok',
  );
});

test('計測ログはトークンの実消費を読み書きに分けて出す', () => {
  const base = {
    jobId: 'x', botKey: 'opus', threadId: '1', queueWaitMs: 0, runMs: 1000, reason: 'ok',
  };
  // 消費のほぼ全部は cacheRead なので、in / out だけでは膨張が見えない
  assert.equal(
    formatJobMetrics({
      ...base, inputTokens: 3200, cacheReadTokens: 470000, cacheWriteTokens: 6100, outputTokens: 2000,
    }),
    '[job x opus thread:1] queueWait 0.0s / run 1.0s / tok in 3.2k, out 2.0k (cacheR 470k, cacheW 6.1k) / ok',
  );
  // 1000 未満は生の数字 (k に畳むと小さい job の差が潰れる)
  assert.equal(
    formatJobMetrics({ ...base, inputTokens: 20, outputTokens: 940 }),
    '[job x opus thread:1] queueWait 0.0s / run 1.0s / tok in 20, out 940 / ok',
  );
  // cacheRead 0 = キャッシュが 1 つも効かなかった job。読み取りたい値なので落とさない
  assert.equal(
    formatJobMetrics({ ...base, inputTokens: 20, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 29319 }),
    '[job x opus thread:1] queueWait 0.0s / run 1.0s / tok in 20, out 100 (cacheR 0, cacheW 29k) / ok',
  );
});

test('usage を返さない job (codex / 失敗) はトークン部分だけが落ちる', () => {
  const base = {
    jobId: 'x', botKey: 'sol', threadId: '1', queueWaitMs: 0, runMs: 1000, reason: 'ok',
    promptChars: 100,
  };
  const withoutTok = '[job x sol thread:1] queueWait 0.0s / run 1.0s / prompt 100 chars / ok';
  assert.equal(formatJobMetrics(base), withoutTok);
  assert.equal(
    formatJobMetrics({ ...base, inputTokens: undefined, outputTokens: null }),
    withoutTok,
  );
  // キャッシュの値だけ取れても単独では読めないので、パートごと出さない
  assert.equal(formatJobMetrics({ ...base, cacheReadTokens: 470000 }), withoutTok);
  // 逆に in か out のどちらかが取れたら、取れた分だけ出す
  assert.equal(
    formatJobMetrics({ ...base, outputTokens: 2000 }),
    '[job x sol thread:1] queueWait 0.0s / run 1.0s / prompt 100 chars / tok out 2.0k / ok',
  );
});

test('内訳が取れなかった job (spawn 前の失敗) は従来どおりの 1 行に戻る', () => {
  const line = (extra) =>
    formatJobMetrics({
      jobId: 'x',
      botKey: 'opus',
      threadId: '1',
      queueWaitMs: 0,
      runMs: 0,
      reason: 'role-unreadable',
      ...extra,
    });
  const bare = '[job x opus thread:1] queueWait 0.0s / run 0.0s / role-unreadable';
  assert.equal(line({}), bare);
  assert.equal(line({ promptChars: undefined, contextMessages: undefined }), bare);
  // role 分だけ取れない場合も総量は出す (内訳が欠けるだけ)
  assert.equal(
    line({ promptChars: 100 }),
    '[job x opus thread:1] queueWait 0.0s / run 0.0s / prompt 100 chars / role-unreadable',
  );
  // 省略件数だけ欠けているのは 0 とみなす (文脈件数が取れていれば行には出す)
  assert.equal(
    line({ contextMessages: 0 }),
    '[job x opus thread:1] queueWait 0.0s / run 0.0s / ctx 0 件 (省略 0) / role-unreadable',
  );
});

test('スレッド指定 stop はそのスレッドの実行中 + 待機のみを選ぶ', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1'); // 実行中 (対象)
  const b1 = job('C:/b', 't2'); // 実行中 (対象外)
  const a2 = job('C:/a', 't1'); // 待機 (対象)
  const a3 = job('C:/a', 't9'); // 待機 (対象外)
  for (const i of [a1, b1, a2, a3]) q.push(i);
  q.takeStartable();

  const { active, dequeued } = q.selectForStop({ threadId: 't1' });
  assert.deepEqual(ids(active), [a1.id]);
  assert.deepEqual(ids(dequeued), [a2.id]);
  assert.deepEqual(ids(q.waiting), [a3.id]); // 対象外の待機は残る
  assert.equal(q.activeCount, 2); // レーン解放は job の finish 待ち (abort は呼び出し側)
});

test('stop all は全レーンの実行中・待機をすべて選ぶ', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  const b1 = job('C:/b', 't2');
  const a2 = job('C:/a', 't1');
  for (const i of [a1, b1, a2]) q.push(i);
  q.takeStartable();

  const { active, dequeued } = q.selectForStop({ all: true });
  assert.deepEqual(ids(active).sort(), ids([a1, b1]).sort());
  assert.deepEqual(ids(dequeued), [a2.id]);
  assert.equal(q.waitingCount, 0);
});

test('threadId が null で all でなければ何も選ばない', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  q.push(a1);
  q.takeStartable();
  const { active, dequeued } = q.selectForStop({ threadId: null });
  assert.deepEqual(active, []);
  assert.deepEqual(dequeued, []);
});

test('finish でレーンが解放され、後続が同レーンで走れる', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  q.push(a1);
  q.takeStartable();
  assert.equal(q.laneBusy(laneKeyFor('C:/a')), true);

  q.finish(a1);
  assert.equal(q.laneBusy(laneKeyFor('C:/a')), false);
  assert.equal(q.activeCount, 0);

  q.finish(a1); // 二重 finish は無害
  assert.equal(q.activeCount, 0);

  const a2 = job('C:/a', 't2');
  q.push(a2);
  assert.deepEqual(ids(q.takeStartable()), [a2.id]);
});

test('別 item が同レーンを掴んでいる間の finish は取り違えない', () => {
  const q = new JobQueue();
  const a1 = job('C:/a', 't1');
  q.push(a1);
  q.takeStartable();
  const stale = job('C:/a', 't1'); // 実行中ではない同レーンの item

  q.finish(stale);
  assert.equal(q.laneBusy(laneKeyFor('C:/a')), true);
});

test('計測ログへ verify の所要時間・成否・試行回数を出す', () => {
  const base = {
    jobId: 'v',
    botKey: 'opus',
    threadId: '1',
    queueWaitMs: 0,
    runMs: 5000,
  };
  assert.equal(
    formatJobMetrics({
      ...base,
      reason: 'ok',
      verifyMs: 1234,
      verifyPassed: 1,
      verifyAttempts: 2,
    }),
    '[job v opus thread:1] queueWait 0.0s / run 5.0s / verify 1.2s (pass, 2 runs) / ok',
  );
  assert.equal(
    formatJobMetrics({
      ...base,
      reason: 'verify-failed',
      verifyMs: 99,
      verifyPassed: 0,
      verifyAttempts: 1,
    }),
    '[job v opus thread:1] queueWait 0.0s / run 5.0s / verify 0.1s (fail, 1 runs) / verify-failed',
  );
});

test('計測ログへツール呼び出し数と「編集前 Read」を出す', () => {
  const base = {
    jobId: 't',
    botKey: 'opus',
    threadId: '1',
    queueWaitMs: 0,
    runMs: 5000,
    reason: 'ok',
  };
  assert.equal(
    formatJobMetrics({ ...base, toolCalls: 21, readsBeforeFirstEdit: 5 }),
    '[job t opus thread:1] queueWait 0.0s / run 5.0s / tools 21 件 (編集前 Read 5) / ok',
  );
  // 編集の無い job では括弧ごと落ちる (0 と「取れなかった」を混同しない)
  assert.equal(
    formatJobMetrics({ ...base, toolCalls: 3 }),
    '[job t opus thread:1] queueWait 0.0s / run 5.0s / tools 3 件 / ok',
  );
  // 1 件も読まずに編集した job は 0 として出す
  assert.match(
    formatJobMetrics({ ...base, toolCalls: 1, readsBeforeFirstEdit: 0 }),
    /tools 1 件 \(編集前 Read 0\)/,
  );
  // 失敗した実行 (PostToolUseFailure) は件数を出す。0 件なら書かない
  assert.match(
    formatJobMetrics({ ...base, toolCalls: 9, toolFailures: 2, readsBeforeFirstEdit: 3 }),
    /tools 9 件 \(失敗 2, 編集前 Read 3\)/,
  );
  assert.match(formatJobMetrics({ ...base, toolCalls: 9, toolFailures: 0 }), /tools 9 件 \//);
  assert.match(formatJobMetrics({ ...base, toolCalls: 9, toolFailures: 1 }), /tools 9 件 \(失敗 1\)/);
  // 軌跡は verify より前に出す (証拠 → 判定の順)
  assert.equal(
    formatJobMetrics({ ...base, toolCalls: 2, verifyMs: 100, verifyPassed: 1, verifyAttempts: 1 }),
    '[job t opus thread:1] queueWait 0.0s / run 5.0s / tools 2 件 / verify 0.1s (pass, 1 runs) / ok',
  );
});

test('hook を有効にしていない job は計測ログへツール項目を出さない', () => {
  const line = formatJobMetrics({
    jobId: 't', botKey: 'opus', threadId: '1', queueWaitMs: 0, runMs: 0, reason: 'ok',
  });
  assert.doesNotMatch(line, /tools/);
  // 取れなかった項目だけが落ち、他は従来どおり
  assert.equal(line, '[job t opus thread:1] queueWait 0.0s / run 0.0s / ok');
});

test('verify を回さなかった job は計測ログへ verify 項目を出さない', () => {
  const line = formatJobMetrics({
    jobId: 'v', botKey: 'opus', threadId: '1', queueWaitMs: 0, runMs: 0, reason: 'aborted',
  });
  assert.equal(line, '[job v opus thread:1] queueWait 0.0s / run 0.0s / aborted');
  assert.doesNotMatch(line, /verify/);
});
