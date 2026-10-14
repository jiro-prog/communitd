import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJobRunner } from '../src/bridge/job.js';

// src/bridge/job.js — 人間起点の job がスレッドの静止を待つ waitForThreadQuiet と、その中の
// sleepInterruptible。メンションの直後に人間が書いた続きを今回の応答に載せるための待ちで、
// 待っている間の停止は handle.abort を包んで拾い、元へ戻す (runClaude / runCodex が後から自分の
// abort を差す前提)。時計は mock timers で進める。構築に要るのは limits と isInfraMessage だけ。

const NOW = 1_000_000;

const flush = () => new Promise((r) => { setImmediate(r); });

function quietRunner(t, { quietWindowMs = 3000, quietWaitMaxMs = 15000 } = {}) {
  // setImmediate は flush に使うので本物のまま
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const infraSeen = [];
  const { waitForThreadQuiet } = createJobRunner({
    limits: { quietWindowMs, quietWaitMaxMs },
    isInfraMessage: (m) => { infraSeen.push(m.id); return m.infra === true; },
  });
  return { waitForThreadQuiet, infraSeen };
}

/** 偽のスレッド。`messages(callIndex)` が返した配列を Collection の代わりの Map にして返す */
function fakeThread(messages) {
  const fetches = [];
  return {
    fetches,
    messages: {
      fetch: async (opts) => {
        fetches.push(opts);
        return new Map(messages(fetches.length - 1).map((m) => [m.id, m]));
      },
    },
  };
}

/** 本物の受付と同じ形の handle (src/bridge/messages.js) — 元の abort が stopRequested を立てる */
function stopHandle() {
  const handle = { stopRequested: false, aborts: 0 };
  handle.abort = () => {
    handle.aborts += 1;
    handle.stopRequested = true;
  };
  return handle;
}

function start(waitForThreadQuiet, thread, handle) {
  const ctl = { settled: false, value: undefined };
  ctl.pending = waitForThreadQuiet(thread, handle).then((v) => {
    ctl.settled = true;
    ctl.value = v;
    return v;
  });
  return ctl;
}

async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await flush();
}

test('直近の実投稿から quietWindowMs 黙っていれば待たずに進み、handle.abort には触らない', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t);
  const thread = fakeThread(() => [{ id: 'h1', createdTimestamp: NOW - 3000 }]);
  const handle = stopHandle();
  const original = handle.abort;
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  assert.equal(ctl.settled, true, '黙っているのに待っている');
  assert.equal(ctl.value, true);
  assert.deepEqual(thread.fetches, [{ limit: 10 }]);
  assert.equal(handle.abort, original);
});

test('直近の実投稿がまだ新しければ、quietWindowMs 黙るまで待ってから進み、包んだ abort を元へ戻す', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000 });
  const thread = fakeThread(() => [
    { id: 'h0', createdTimestamp: NOW - 10_000 },
    { id: 'h1', createdTimestamp: NOW }, // 最新の実投稿 (メンションの直後に書いた続き)
  ]);
  const handle = stopHandle();
  const original = handle.abort;
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  assert.equal(ctl.settled, false, '投稿の直後なのに待っていない');
  assert.notEqual(handle.abort, original, '待っている間は abort を包んで停止を拾う');
  await advance(t, 1000);
  await advance(t, 1000);
  assert.equal(ctl.settled, false, 'quietWindowMs が過ぎる前に進んだ');
  await advance(t, 1000);
  assert.equal(ctl.settled, true, 'quietWindowMs 黙ったのに待ち続けている');
  assert.equal(ctl.value, true);
  assert.equal(handle.abort, original, '待ち終えても包んだ abort が残っている');
  assert.equal(handle.aborts, 0);
});

test('運用メッセージ (isInfraMessage) は待ちを延ばさない — 新しい運用メッセージがあっても実投稿で測る', async (t) => {
  const { waitForThreadQuiet, infraSeen } = quietRunner(t, { quietWindowMs: 3000 });
  const thread = fakeThread(() => [
    { id: 'h1', createdTimestamp: NOW - 3000 },
    { id: 'p1', createdTimestamp: NOW, infra: true }, // ⏳ placeholder など
  ]);
  const ctl = start(waitForThreadQuiet, thread, stopHandle());
  await flush();
  assert.equal(ctl.settled, true, '運用メッセージで待ちが延びた');
  assert.equal(ctl.value, true);
  assert.deepEqual(infraSeen.sort(), ['h1', 'p1']);
});

test('対照: 同じ新しいメッセージが実投稿なら待つ (運用メッセージだから進んだことの確認)', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000 });
  const thread = fakeThread(() => [
    { id: 'h1', createdTimestamp: NOW - 3000 },
    { id: 'h2', createdTimestamp: NOW },
  ]);
  const ctl = start(waitForThreadQuiet, thread, stopHandle());
  await flush();
  assert.equal(ctl.settled, false);
  await advance(t, 3000);
  assert.equal(ctl.value, true);
});

test('実投稿が 1 件も無ければ (空・運用メッセージだけ) 待たずに進む', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t);
  for (const batch of [[], [{ id: 'p1', createdTimestamp: NOW, infra: true }]]) {
    const ctl = start(waitForThreadQuiet, fakeThread(() => batch), stopHandle());
    await flush();
    assert.equal(ctl.settled, true, `待っている: ${JSON.stringify(batch)}`);
    assert.equal(ctl.value, true);
  }
});

test('話し続けられても quietWaitMaxMs で打ち切って進む (最後の待ちは残り時間ぶんだけ)', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000, quietWaitMaxMs: 2500 });
  // 確認のたびに直前の実投稿がある = いつまでも黙らない
  const thread = fakeThread((i) => [{ id: `h${i}`, createdTimestamp: Date.now() }]);
  const handle = stopHandle();
  const original = handle.abort;
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  await advance(t, 1000);
  await advance(t, 1000);
  assert.equal(ctl.settled, false);
  await advance(t, 499);
  assert.equal(ctl.settled, false, '上限の前に打ち切った');
  await advance(t, 1);
  assert.equal(ctl.settled, true, '上限で打ち切っていない (残り 500ms を 1000ms 待った)');
  assert.equal(ctl.value, true);
  assert.equal(handle.abort, original);
});

test('履歴の取得に失敗したら待たずに進む (reject も同期の throw も)', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t);
  const failures = [
    async () => { throw new Error('Missing Access'); },
    () => { throw new Error('sync'); },
  ];
  for (const fetch of failures) {
    const handle = stopHandle();
    const original = handle.abort;
    const ctl = start(waitForThreadQuiet, { messages: { fetch } }, handle);
    await flush();
    assert.equal(ctl.settled, true, '履歴が読めないのに待っている');
    assert.equal(ctl.value, true);
    assert.equal(handle.abort, original);
  }
});

test('待ちの途中で取得に失敗したら、その時点で進む', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000 });
  let calls = 0;
  const thread = {
    messages: {
      fetch: async () => {
        calls += 1;
        if (calls > 1) throw new Error('Missing Access');
        return new Map([['h1', { id: 'h1', createdTimestamp: NOW }]]);
      },
    },
  };
  const ctl = start(waitForThreadQuiet, thread, stopHandle());
  await flush();
  assert.equal(ctl.settled, false);
  await advance(t, 1000);
  assert.equal(ctl.settled, true, '2 回目の取得に失敗したのに待ち続けている');
  assert.equal(ctl.value, true);
});

test('停止済みで入ったら履歴を読まずに false', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t);
  const thread = fakeThread(() => [{ id: 'h1', createdTimestamp: NOW }]);
  const handle = stopHandle();
  handle.stopRequested = true;
  assert.equal(await waitForThreadQuiet(thread, handle), false);
  assert.deepEqual(thread.fetches, []);
});

test('待っている間に停止されたら時計を待たずに false を返し、元の abort を 1 回呼んで handle.abort を元へ戻す', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000 });
  const thread = fakeThread(() => [{ id: 'h1', createdTimestamp: NOW }]);
  const handle = stopHandle();
  const original = handle.abort;
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  assert.equal(ctl.settled, false);
  assert.notEqual(handle.abort, original);

  handle.abort(); // /stop — 時計は進めない
  await flush();
  assert.equal(ctl.settled, true, '停止を 1 秒刻みの再確認まで拾っていない');
  assert.equal(ctl.value, false);
  assert.equal(handle.aborts, 1, '元の abort (stopRequested を立てる側) を呼んでいない');
  assert.equal(handle.stopRequested, true);
  assert.equal(handle.abort, original, '包んだ abort が残っている');
  assert.equal(thread.fetches.length, 1, '停止のあとで履歴を読み直した');

  // 眠りのタイマーは止めてある — 後から差した abort (runClaude の代役) を古い待ちが上書きしない
  const later = () => {};
  handle.abort = later;
  await advance(t, 1000);
  assert.equal(handle.abort, later, '止めたはずの眠りが後から abort を書き戻した');
});

test('履歴を読んでいる間に停止されても、次の確認で false (停止が取りこぼされない)', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 3000 });
  const handle = stopHandle();
  const original = handle.abort;
  let fetches = 0;
  const thread = {
    messages: {
      fetch: async () => {
        fetches += 1;
        handle.abort(); // 取得の最中に /stop (この時点では包まれていない元の abort)
        return new Map([['h1', { id: 'h1', createdTimestamp: NOW }]]);
      },
    },
  };
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  await advance(t, 1000);
  assert.equal(ctl.settled, true);
  assert.equal(ctl.value, false);
  assert.equal(fetches, 1, '停止のあとで履歴を読み直した');
  assert.equal(handle.aborts, 1);
  assert.equal(handle.abort, original);
});

test('元の abort が無い handle でも、待ち終えたら包みを残さない', async (t) => {
  const { waitForThreadQuiet } = quietRunner(t, { quietWindowMs: 1000 });
  const thread = fakeThread(() => [{ id: 'h1', createdTimestamp: NOW }]);
  const handle = { stopRequested: false };
  const ctl = start(waitForThreadQuiet, thread, handle);
  await flush();
  assert.equal(typeof handle.abort, 'function', '待っている間は停止を拾えるよう包む');
  await advance(t, 1000);
  assert.equal(ctl.value, true);
  assert.equal(handle.abort, undefined);
});
