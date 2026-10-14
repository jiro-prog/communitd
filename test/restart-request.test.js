import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRestartRequestWiring } from '../src/bridge/restart-request.js';
import { createLifecycle, restartBridge } from '../src/interactions.js';
import { RESTART_EXIT_CODE, RESTART_REQUEST_FILE, buildRestartRequest, planRestartRequest } from '../src/restart.js';

const STARTED = 1_000_000;

// ---- planRestartRequest (純粋) ----

test('依頼が無ければ何もしない', () => {
  assert.equal(planRestartRequest({ request: null, startedAt: STARTED }).action, 'none');
  assert.equal(planRestartRequest({ request: undefined, startedAt: STARTED }).action, 'none');
});

test('起動後の依頼で job が無ければ再起動する', () => {
  const plan = planRestartRequest({
    request: buildRestartRequest({ reason: 'channels.foo を追加', by: 'new-project', now: STARTED + 1 }),
    startedAt: STARTED,
  });
  assert.equal(plan.action, 'restart');
  assert.match(plan.reason, /channels\.foo/);
});

test('この起動より前の依頼は捨てる (設定は起動時に読み込み済み)', () => {
  for (const at of [STARTED - 1, STARTED]) {
    const plan = planRestartRequest({ request: { requestedAt: at }, startedAt: STARTED });
    assert.equal(plan.action, 'discard', `requestedAt=${at}`);
  }
});

test('読めない依頼は捨てる (残すと毎回同じ判定を繰り返す)', () => {
  for (const request of [{ invalid: true }, {}, { requestedAt: 'yesterday' }, { requestedAt: Number.NaN }]) {
    assert.equal(planRestartRequest({ request, startedAt: STARTED }).action, 'discard', JSON.stringify(request));
  }
});

test('job か受付中の処理があれば待つ (中断はしない)', () => {
  const request = { requestedAt: STARTED + 1 };
  for (const busy of [{ activeCount: 1 }, { waitingCount: 2 }, { pendingAdmissions: 1 }]) {
    const plan = planRestartRequest({ request, startedAt: STARTED, ...busy });
    assert.equal(plan.action, 'wait', JSON.stringify(busy));
  }
});

test('停止処理中は触らない (依頼も消さない)', () => {
  const plan = planRestartRequest({ request: { requestedAt: STARTED + 1 }, startedAt: STARTED, accepting: false });
  assert.equal(plan.action, 'none');
});

test('buildRestartRequest: notice は channelId と botKey がそろったときだけ載る', () => {
  const full = buildRestartRequest({ reason: 'r', by: 'b', now: 5, notice: { channelId: '123', botKey: 'opus' } });
  assert.deepEqual(full, { requestedAt: 5, by: 'b', reason: 'r', notice: { channelId: '123', botKey: 'opus' } });
  const half = buildRestartRequest({ reason: 'r', by: 'b', now: 5, notice: { channelId: '123' } });
  assert.equal('notice' in half, false);
});

// ---- createRestartRequestWiring (配線) ----

/** ファイル 1 つ分の偽 fs。rmSync が失敗する場合も作れる */
function fakeFs({ content = null, rmFails = false } = {}) {
  const state = { content, removed: 0 };
  return {
    state,
    readFileSync(path) {
      assert.ok(String(path).replaceAll('\\', '/').endsWith(RESTART_REQUEST_FILE));
      if (state.content === null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return state.content;
    },
    rmSync() {
      if (rmFails) throw new Error('EPERM');
      state.content = null;
      state.removed += 1;
    },
  };
}

function wiring({ fs, jobs = { activeCount: 0, waitingCount: 0 }, accepting = true, pendingAdmissions = 0 }) {
  const calls = [];
  const w = createRestartRequestWiring({
    root: 'C:/bridge',
    startedAt: STARTED,
    jobs,
    lifecycle: { accepting, pendingAdmissions },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    restartDrainMs: 30000,
    fs,
    restart: async (p) => {
      calls.push(p);
    },
  });
  return { w, calls };
}

test('配線: 依頼が無ければ何もしない', async () => {
  const fs = fakeFs();
  const { w, calls } = wiring({ fs });
  assert.equal(await w.check(), 'none');
  assert.equal(calls.length, 0);
});

test('配線: 拾ったら依頼を消してから再起動し、notice を渡す', async () => {
  const request = buildRestartRequest({
    reason: 'channels.foo を追加', by: 'new-project', now: STARTED + 10,
    notice: { channelId: '42', botKey: 'opus' },
  });
  const fs = fakeFs({ content: JSON.stringify(request) });
  const { w, calls } = wiring({ fs });
  assert.equal(await w.check(), 'restart');
  assert.equal(fs.state.removed, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].notice, { channelId: '42', botKey: 'opus' });
});

test('配線: 依頼を消せなければ再起動しない (次の起動でまた落ちるのを防ぐ)', async () => {
  const fs = fakeFs({ content: JSON.stringify({ requestedAt: STARTED + 1 }), rmFails: true });
  const { w, calls } = wiring({ fs });
  assert.equal(await w.check(), 'kept');
  assert.equal(calls.length, 0);
});

test('配線: job があれば待ち、依頼は残す', async () => {
  const fs = fakeFs({ content: JSON.stringify({ requestedAt: STARTED + 1 }) });
  const { w, calls } = wiring({ fs, jobs: { activeCount: 1, waitingCount: 0 } });
  assert.equal(await w.check(), 'wait');
  assert.equal(fs.state.removed, 0);
  assert.equal(calls.length, 0);
});

test('配線: 壊れた依頼と古い依頼は消すだけ', async () => {
  for (const content of ['{not json', JSON.stringify({ requestedAt: STARTED - 5 })]) {
    const fs = fakeFs({ content });
    const { w, calls } = wiring({ fs });
    assert.equal(await w.check(), 'discard', content);
    assert.equal(fs.state.removed, 1);
    assert.equal(calls.length, 0);
  }
});

test('配線: notice が欠けた依頼でも再起動はする (完了通知を出さないだけ)', async () => {
  const fs = fakeFs({ content: JSON.stringify({ requestedAt: STARTED + 1, notice: { channelId: '1' } }) });
  const { w, calls } = wiring({ fs });
  assert.equal(await w.check(), 'restart');
  assert.equal(calls[0].notice, null);
});

// ---- restartBridge (/restart と共有の手順) ----

function idleBridge() {
  const log = [];
  const lifecycle = createLifecycle();
  return {
    log,
    lifecycle,
    deps: {
      jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
      lifecycle,
      waitForJobsDrained: async () => log.push('drain'),
      writeRestartNotice: (notice) => log.push(`notice:${JSON.stringify(notice)}`),
      shutdown: async (code) => log.push(`shutdown:${code}`),
      restartDrainMs: 30000,
    },
  };
}

test('restartBridge: 受付を閉じ、notice が無ければ完了通知を予約せずに 42 で落ちる', async () => {
  const b = idleBridge();
  await restartBridge({ ...b.deps });
  assert.equal(b.lifecycle.accepting, false);
  assert.deepEqual(b.log, [`shutdown:${RESTART_EXIT_CODE}`]);
});

test('restartBridge: 告知が同期で投げても落ちる (締め切り待ちごと倒さない)', async () => {
  const b = idleBridge();
  await restartBridge({
    ...b.deps,
    notice: { channelId: 'C1', botKey: 'opus' },
    announce: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(b.log, ['notice:{"channelId":"C1","botKey":"opus"}', `shutdown:${RESTART_EXIT_CODE}`]);
});
