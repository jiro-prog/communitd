import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESTART_DRAIN_MS,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_HARD_EXIT_MS,
  createShutdownWiring,
} from '../src/bridge/shutdown.js';
import { createLifecycle } from '../src/interactions.js';
import { JobQueue } from '../src/queue.js';

// src/bridge/shutdown.js — 再起動の完了通知と停止の配線。Discord client と process.exit は偽物。

function captureConsole(t) {
  const logs = [];
  const errors = [];
  const { log, error } = console;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  return { logs, errors };
}

function fakeBot(key, { userId = `${key}-id`, channels = new Map() } = {}) {
  const sent = [];
  const client = {
    destroyed: false,
    channels: {
      cache: new Map(),
      fetch: async (id) => channels.get(id) ?? null,
    },
    destroy: async () => { client.destroyed = true; },
  };
  return { key, cfg: { displayName: key }, userId, client, sent };
}

function fakeChannel(id) {
  const channel = { id, sent: [], send: async (payload) => { channel.sent.push(payload); return { id: `${id}-m` }; } };
  return channel;
}

function harness(t, {
  bots = new Map(), jobRuns = null, jobs = new JobQueue(), drained = [], abortOrgApply = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'communitd-shutdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exits = [];
  const lifecycle = createLifecycle();
  const wiring = createShutdownWiring({
    root,
    bots,
    jobs,
    lifecycle,
    jobRuns: jobRuns ?? { markShutdown: () => null },
    waitForJobsDrained: async (ms, label) => { drained.push([ms, label]); },
    abortOrgApply,
    exit: (code) => exits.push(code),
  });
  return { root, lifecycle, exits, drained, ...wiring };
}

test('待ち時間の定数は作者裁定の値のまま (drain < hardExit)', () => {
  assert.equal(RESTART_DRAIN_MS, 30000);
  assert.equal(SHUTDOWN_DRAIN_MS, 8000);
  assert.equal(SHUTDOWN_HARD_EXIT_MS, 15000);
  assert.ok(SHUTDOWN_DRAIN_MS < SHUTDOWN_HARD_EXIT_MS, 'hardExit は drain より長くないと finally が走らない');
});

test('writeRestartNotice は data/restart-notice.json へ再起動元を残す (data/ が無ければ作る)', (t) => {
  const h = harness(t);
  h.writeRestartNotice({ botKey: 'fable', channelId: 'C1' });
  const file = join(h.root, 'data', 'restart-notice.json');
  assert.ok(existsSync(file));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { botKey: 'fable', channelId: 'C1' });
});

test('announceRestartComplete は通知ファイルを 1 回だけ読み、元のチャンネルへ ✅ を投稿して消す', async (t) => {
  const { errors } = captureConsole(t);
  const c1 = fakeChannel('C1');
  const fable = fakeBot('fable', { channels: new Map([['C1', c1]]) });
  const bots = new Map([['fable', fable]]);
  const h = harness(t, { bots });
  h.writeRestartNotice({ botKey: 'fable', channelId: 'C1' });

  await h.announceRestartComplete();
  assert.equal(c1.sent.length, 1);
  assert.equal(c1.sent[0].content, '✅ 再起動完了');
  assert.deepEqual(c1.sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(existsSync(join(h.root, 'data', 'restart-notice.json')), false, '通知ファイルが残っている');

  // 2 回目は何もしない (ready の保険タイマーと ready の両方から呼ばれる)
  h.writeRestartNotice({ botKey: 'fable', channelId: 'C1' });
  await h.announceRestartComplete();
  assert.equal(c1.sent.length, 1);
  assert.deepEqual(errors, []);
});

test('通知ファイルが無ければ通常起動 — 何も投稿しない', async (t) => {
  captureConsole(t);
  const c1 = fakeChannel('C1');
  const bots = new Map([['fable', fakeBot('fable', { channels: new Map([['C1', c1]]) })]]);
  const h = harness(t, { bots });
  await h.announceRestartComplete();
  assert.equal(c1.sent.length, 0);
});

test('再起動元の bot が居なければ最初の bot から投稿し、投稿に失敗しても起動は続く', async (t) => {
  const { errors } = captureConsole(t);
  const c1 = fakeChannel('C1');
  const opus = fakeBot('opus', { channels: new Map([['C1', c1]]) });
  const h = harness(t, { bots: new Map([['opus', opus]]) });
  h.writeRestartNotice({ botKey: 'gone', channelId: 'C1' });
  await h.announceRestartComplete();
  assert.equal(c1.sent.length, 1, '最初の bot へ落ちていない');

  const broken = fakeBot('opus', { channels: new Map([['C1', { send: async () => { throw new Error('archived'); } }]]) });
  const h2 = harness(t, { bots: new Map([['opus', broken]]) });
  h2.writeRestartNotice({ botKey: 'opus', channelId: 'C1' });
  await h2.announceRestartComplete();
  assert.ok(errors.some((e) => e.includes('[restart] 完了通知の投稿に失敗: archived')), errors.join('\n'));
  assert.equal(existsSync(join(h2.root, 'data', 'restart-notice.json')), false, '失敗しても先に消す (二重投稿しない)');
});

test('shutdown は停止の印を先に残し、実行中を中断し、client を切って exit する (二重呼び出しは 1 回)', async (t) => {
  captureConsole(t);
  const marks = [];
  const jobRuns = { markShutdown: (fields) => marks.push(fields) };
  const fable = fakeBot('fable');
  const bots = new Map([['fable', fable]]);
  const jobs = new JobQueue();
  const aborted = [];
  const running = {
    jobId: 'r1', laneKey: 'L', threadId: 'T1', botKey: 'opus',
    handle: { abort: () => aborted.push('r1') },
    onStop: (info) => aborted.push(`onStop:${info.kind}:${info.waiting}`),
  };
  jobs.push(running);
  jobs.takeStartable();
  const h = harness(t, { bots, jobRuns, jobs });

  await h.shutdown(42);
  assert.deepEqual(marks, [{ reason: 'shutdown(42)' }]);
  assert.deepEqual(aborted, ['onStop:shutdown:false', 'r1'], '実行記録 → abort の順');
  assert.deepEqual(h.drained, [[SHUTDOWN_DRAIN_MS, 'shutdown']]);
  assert.equal(fable.client.destroyed, true);
  assert.deepEqual(h.exits, [42]);
  assert.equal(h.lifecycle.accepting, false);

  await h.shutdown(0);
  assert.deepEqual(h.exits, [42], '二重に終了処理を走らせている');
});

test('shutdown は適用回路の verify も撃つ (job ではないのでキューからは撃てない)', async (t) => {
  const { errors } = captureConsole(t);
  const aborted = [];
  const jobs = new JobQueue();
  const running = { jobId: 'r1', laneKey: 'L', threadId: 'T1', botKey: 'opus', handle: { abort: () => aborted.push('job') } };
  jobs.push(running);
  jobs.takeStartable();
  const h = harness(t, { jobs, abortOrgApply: () => aborted.push('org-apply') });

  await h.shutdown(130);
  assert.deepEqual(aborted, ['job', 'org-apply'], '適用回路の verify を撃っていない');
  assert.deepEqual(h.exits, [130]);

  // 撃てなくても停止は続ける (撃てなかったことでプロセスが居座る方が悪い)
  const broken = harness(t, { abortOrgApply: () => { throw new Error('もう居ません'); } });
  await broken.shutdown(143);
  assert.deepEqual(broken.exits, [143]);
  assert.ok(errors.some((e) => e.includes('[org-apply] 停止を伝えられませんでした: もう居ません')), errors.join('\n'));
});

test('drained (呼び出し元が待ち切った) なら drain を待ち直さず、印の失敗でも止まらない', async (t) => {
  const { errors } = captureConsole(t);
  const jobRuns = { markShutdown: () => { throw new Error('disk full'); } };
  const h = harness(t, { jobRuns });
  await h.shutdown(130, '⏹ 停止', { drained: true });
  assert.deepEqual(h.drained, []);
  assert.deepEqual(h.exits, [130]);
  assert.ok(errors.some((e) => e.includes('[jobruns] 停止の印を残せませんでした: disk full')), errors.join('\n'));
});

test('通知ファイルの置き場は root/data 配下 (壊れた JSON は通常起動として扱う)', async (t) => {
  const { errors } = captureConsole(t);
  const c1 = fakeChannel('C1');
  const bots = new Map([['fable', fakeBot('fable', { channels: new Map([['C1', c1]]) })]]);
  const h = harness(t, { bots });
  mkdirSync(join(h.root, 'data'), { recursive: true });
  writeFileSync(join(h.root, 'data', 'restart-notice.json'), '{not json');
  await h.announceRestartComplete();
  assert.equal(c1.sent.length, 0);
  assert.deepEqual(errors, []);
});
