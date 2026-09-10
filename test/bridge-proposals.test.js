import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_PROPOSAL_DELIVERY_ATTEMPTS,
  PROPOSAL_ADJUDICATION_TIMEOUT_MS,
  PROPOSAL_REDELIVER_MS,
  createProposalWiring,
} from '../src/bridge/proposals.js';
import { formatSchemaTag } from '../src/contract.js';
import { HopTracker } from '../src/hops.js';
import { InboxStore } from '../src/inbox.js';
import { createLifecycle } from '../src/interactions.js';
import { adjudicationThreadName } from '../src/mentions.js';
import { formatInitiativeTag } from '../src/scheduler.js';

// src/bridge/proposals.js — 提案の配送 (deliverAdjudication / sweepProposals) の配線。
// HANDOFF の積み残し「deliverAdjudication / sweepProposals 本体は配線層なのでユニットテストが無い」を埋める。
// ProposalStore と Discord は偽物、hops・受信箱・lifecycle は本物。

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

const T0 = Date.parse('2026-09-06T00:00:00.000Z');
const MIN = 60 * 1000;

function proposal(id, over = {}) {
  return {
    id: String(id),
    class: 'work',
    state: 'deliberating',
    raisedBy: 'opus',
    ownerBotKey: 'opus',
    origin: { channelId: 'C1', threadId: `T${id}` },
    subjectKeys: ['task:1'],
    input: {
      kind: 'work-item', duty: 'health', summary: `提案 ${id} の要旨`, evidence: ['観測 1'],
      remedy: 'check', benefits: ['利点'], risks: ['リスク'], cost: '1 job',
    },
    history: [{ to: 'raised' }, { to: 'deliberating' }],
    ...over,
  };
}

/** ProposalStore のうち配線が触る面だけ */
function fakeProposalStore(list) {
  const find = (id) => list.find((p) => p.id === String(id)) ?? null;
  return {
    list: ({ state = null } = {}) => list.filter((p) => state === null || [].concat(state).includes(p.state)),
    awaitingAdjudication: () => list.filter((p) => p.state === 'deliberating'),
    openList: () => list.filter((p) => !['rejected', 'withdrawn'].includes(p.state)),
    get: find,
    deliberate: (id, { by = null, note = '' } = {}) => {
      const p = find(id);
      if (!p) throw new Error(`提案 ${id} は見つかりません`);
      if (p.state !== 'raised') throw new Error(`提案 ${id} は ${p.state} から deliberating へ進めません`);
      p.state = 'deliberating';
      p.history.push({ to: 'deliberating', by, note });
      return p;
    },
  };
}

/** Discord の偽物: スレッド・チャンネル・client (fetch は ID 表を引くだけ) */
function world() {
  const sent = []; // [channelId, payload]
  const channels = new Map();
  let seq = 0;
  const thread = (id, { archived = false, fail = null } = {}) => {
    const ch = {
      id,
      archived,
      fail,
      isThread: () => true,
      send: async (payload) => {
        if (ch.fail) throw new Error(ch.fail);
        sent.push([id, payload]);
        return { id: `${id}-m${++seq}` };
      },
    };
    channels.set(id, ch);
    return ch;
  };
  const channel = (id) => {
    const ch = {
      id,
      created: [],
      isThread: () => false,
      threads: {
        create: async ({ name }) => {
          ch.created.push(name);
          return thread(`${id}-thread-${++seq}`);
        },
      },
    };
    channels.set(id, ch);
    return ch;
  };
  const client = () => ({ channels: { cache: new Map(), fetch: async (id) => channels.get(id) ?? null } });
  return { sent, channels, thread, channel, client };
}

function harness(t, {
  list = [], execBotKeys = ['fable'], paused = false, config = {}, root = null, withoutFable = false,
} = {}) {
  const io = captureConsole(t);
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'communitd-proposals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bots = new Map([
    ['fable', { key: 'fable', userId: withoutFable ? null : 'F', client: w.client(), cfg: { displayName: 'Fable' } }],
    ['opus', { key: 'opus', userId: 'O', client: w.client(), cfg: { displayName: 'Opus' } }],
  ]);
  const hops = new HopTracker(12, 3);
  const pauseStore = { paused };
  const lifecycle = createLifecycle();
  const inbox = new InboxStore(join(dir, 'inbox.json'));
  const sweeps = [];
  const proposals = list === null ? null : fakeProposalStore(list);
  const wiring = createProposalWiring({
    config: { guildId: 'G', channels: {}, ...config },
    root: root ?? dir,
    proposals,
    board: null,
    bots,
    hops,
    pauseStore,
    lifecycle,
    inbox,
    ownerTargets: [{ userId: 'U1', displayName: 'So' }],
    execBotKeys,
    findGuildChannel: () => null,
    sweepOrgApply: async (now) => { sweeps.push(now); },
  });
  return { ...io, ...w, dir, bots, hops, pauseStore, lifecycle, inbox, sweeps, proposals, ...wiring };
}

test('配り直しの間隔・猶予・上限の定数', () => {
  assert.equal(PROPOSAL_REDELIVER_MS, 10 * MIN);
  assert.equal(PROPOSAL_ADJUDICATION_TIMEOUT_MS, 30 * MIN);
  assert.equal(MAX_PROPOSAL_DELIVERY_ATTEMPTS, 6);
});

test('work 提案は裁定 bot 以外の client から発議元スレッドへ report 様式の依頼を投げる', async (t) => {
  const p3 = proposal(3);
  const h = harness(t, { list: [p3] });
  h.thread('T3');
  h.hops.grantTaskBudget('T3', 0); // 予算で回っているスレッド (門番あり)

  const out = await h.deliverProposal(p3);
  assert.deepEqual(out, { delivered: true, attempted: true, channelId: 'T3' });
  assert.equal(h.sent.length, 1);
  const [channelId, payload] = h.sent[0];
  assert.equal(channelId, 'T3');
  assert.ok(payload.content.startsWith('<@F>\n'), '裁定 bot へのメンションで始まっていない');
  assert.match(payload.content, /## 裁定の依頼 — 提案 #3 \(work \/ work-item\)/);
  assert.ok(payload.content.includes(formatSchemaTag('report')), '様式の目印が無い');
  assert.ok(payload.content.includes(formatInitiativeTag('裁定')), '発議機構の目印が無い');
  assert.deepEqual(payload.allowedMentions.users, ['F']);
  assert.equal(h.hops.taskBudget('T3'), 1, '裁定 job のぶんの予算を積んでいない');
  assert.ok(h.logs.some((l) => l === '[proposals] #3 (work) の裁定を fable へ依頼 (T3 / 投稿は opus)'), h.logs.join('\n'));
});

test('予算を配っていないスレッドには予算を付けない (門番ごと不在 = 従来どおり)', async (t) => {
  const p = proposal(4);
  const h = harness(t, { list: [p] });
  h.thread('T4');
  await h.deliverProposal(p);
  assert.equal(h.hops.taskBudget('T4'), null);
});

test('archive されたスレッドには投げず、親チャンネルへ proposal/<id> スレッドを立ててその中へ入れる', async (t) => {
  const p = proposal(5);
  const h = harness(t, { list: [p] });
  h.thread('T5', { archived: true });
  const c1 = h.channel('C1');
  const out = await h.deliverProposal(p);
  assert.equal(out.delivered, true);
  assert.equal(out.channelId, 'C1-thread-1');
  assert.deepEqual(c1.created, [adjudicationThreadName(p)]);
  assert.equal(h.sent[0][0], 'C1-thread-1');
});

test('投稿に失敗したら積んだ予算を戻して次の候補へ落ち、どこにも出せなければ null', async (t) => {
  const p = proposal(6);
  const h = harness(t, { list: [p] });
  h.thread('T6', { fail: 'Missing Permissions' });
  h.hops.grantTaskBudget('T6', 0);
  const c1 = h.channel('C1');
  const out = await h.deliverProposal(p);
  assert.equal(out.delivered, true);
  assert.equal(out.channelId, 'C1-thread-1');
  assert.equal(h.hops.taskBudget('T6'), 0, '失敗した投稿の予算が残っている');
  assert.equal(c1.created.length, 1);
  assert.ok(h.errors.some((e) => e.includes('#6 の裁定依頼を T6 へ出せませんでした: Missing Permissions')), h.errors.join('\n'));

  const p7 = proposal(7, { origin: { channelId: 'C-missing', threadId: 'T-missing' } });
  const none = await h.deliverProposal(p7);
  assert.deepEqual(none, { delivered: false, attempted: true, channelId: null });
});

test('裁定できる bot が起動していない・投げ手が居ないときは配れない', async (t) => {
  const p = proposal(8);
  const h = harness(t, { list: [p], withoutFable: true });
  h.thread('T8');
  assert.equal((await h.deliverProposal(p)).delivered, false);
  assert.ok(h.errors.some((e) => e.includes('#8: 裁定できる bot が起動していません (execBotKeys: fable)')), h.errors.join('\n'));

  const alone = harness(t, { list: [p], execBotKeys: ['opus'] });
  alone.bots.get('fable').userId = null;
  alone.thread('T8');
  assert.equal((await alone.deliverProposal(p)).delivered, false);
  assert.ok(alone.errors.some((e) => e.includes('#8: opus 以外に投げ手が居ません')), alone.errors.join('\n'));
});

test('pause 中・受付停止中の自動配送は試さない (manual = /proposals だけが例外)', async (t) => {
  const p = proposal(9);
  const h = harness(t, { list: [p], paused: true });
  h.thread('T9');
  assert.deepEqual(await h.deliverProposal(p), {
    delivered: false, attempted: false, reason: '自律運転が停止中 (/resume で配ります)',
  });
  assert.equal(h.sent.length, 0);
  const manual = await h.deliverProposal(p, { manual: true });
  assert.equal(manual.delivered, true);

  const stopping = harness(t, { list: [p] });
  stopping.thread('T9');
  stopping.lifecycle.stopAccepting();
  assert.equal((await stopping.deliverProposal(p)).attempted, false);
});

test('sweepProposals: raised は裁定待ちへ送り直し、裁定待ちは配り、配れた後は猶予を過ぎたら起こし直す', async (t) => {
  const p1 = proposal(1, { state: 'raised', history: [{ to: 'raised' }] });
  const p2 = proposal(2);
  const h = harness(t, { list: [p1, p2] });
  h.thread('T1');
  h.thread('T2');

  await h.sweepProposals(T0);
  assert.equal(p1.state, 'deliberating');
  assert.deepEqual(p1.history.at(-1), { to: 'deliberating', by: 'bridge', note: '裁定待ちへ送り直し' });
  assert.ok(h.logs.some((l) => l === '[proposals] #1 を裁定待ちへ送り直しました'), h.logs.join('\n'));
  // 送り直した #1 も同じ tick で配られる (deliberating へ入った瞬間から裁定待ち)
  assert.deepEqual(h.sent.map(([id]) => id).sort(), ['T1', 'T2']);
  assert.deepEqual(h.sweeps, [T0], 'org-apply の sweep を tick の最後に呼んでいない');

  // 配れた直後 (猶予内) は起こし直さない
  await h.sweepProposals(T0 + MIN);
  assert.equal(h.sent.length, 2);
  // 裁定が返らないまま猶予 (30 分) を過ぎたら起こし直す
  await h.sweepProposals(T0 + PROPOSAL_ADJUDICATION_TIMEOUT_MS);
  assert.equal(h.sent.length, 4);
  assert.deepEqual(h.sweeps, [T0, T0 + MIN, T0 + PROPOSAL_ADJUDICATION_TIMEOUT_MS]);
});

test('sweepProposals: 配れなかった提案は短い間隔で試し直し、上限に達したら人間の出番として止まる', async (t) => {
  const p = proposal(2);
  const h = harness(t, { list: [p] });
  h.thread('T2', { fail: 'archived' }); // どこにも出せない (親チャンネルは fetch できない)

  await h.sweepProposals(T0);
  assert.equal(h.sent.length, 0);
  await h.sweepProposals(T0 + 5 * MIN);
  assert.equal(h.errors.filter((e) => e.includes('#2 の裁定依頼を T2 へ出せませんでした')).length, 1, '10 分未満で試し直している');
  await h.sweepProposals(T0 + PROPOSAL_REDELIVER_MS);
  assert.equal(h.errors.filter((e) => e.includes('#2 の裁定依頼を T2 へ出せませんでした')).length, 2);

  // 上限 (6 回) まで試したら止まり、`/proposals` へ案内する
  let now = T0 + PROPOSAL_REDELIVER_MS;
  for (let i = 2; i < MAX_PROPOSAL_DELIVERY_ATTEMPTS; i += 1) {
    now += PROPOSAL_REDELIVER_MS;
    await h.sweepProposals(now);
  }
  const attempts = h.errors.filter((e) => e.includes('#2 の裁定依頼を T2 へ出せませんでした')).length;
  assert.equal(attempts, MAX_PROPOSAL_DELIVERY_ATTEMPTS);
  const gaveUp = h.errors.find((e) => e.includes(`#2 (work) は ${MAX_PROPOSAL_DELIVERY_ATTEMPTS} 回起こしても`));
  assert.ok(gaveUp, h.errors.join('\n'));
  assert.match(gaveUp, /`\/proposals` で出し直してください/);
  await h.sweepProposals(now + PROPOSAL_REDELIVER_MS);
  assert.equal(h.errors.filter((e) => e.includes('#2 の裁定依頼を T2 へ出せませんでした')).length, MAX_PROPOSAL_DELIVERY_ATTEMPTS, '上限の後も試している');
});

test('sweepProposals: pause 中・受付停止中・発議機構なしは何もしない (org-apply の sweep も呼ばない)', async (t) => {
  const p = proposal(2);
  const paused = harness(t, { list: [p], paused: true });
  paused.thread('T2');
  await paused.sweepProposals(T0);
  assert.equal(paused.sent.length, 0);
  assert.deepEqual(paused.sweeps, []);

  const stopping = harness(t, { list: [p] });
  stopping.lifecycle.stopAccepting();
  await stopping.sweepProposals(T0);
  assert.deepEqual(stopping.sweeps, []);

  const disabled = harness(t, { list: null });
  await disabled.sweepProposals(T0);
  assert.deepEqual(disabled.sweeps, []);
});

test('sweepProposals: 裁定待ちを抜けた提案の配送記録は捨て、再審議は別の世代として配る', async (t) => {
  const p = proposal(2);
  const h = harness(t, { list: [p] });
  h.thread('T2');
  await h.sweepProposals(T0);
  assert.equal(h.sent.length, 1);
  // 裁定された → 記録が消える
  p.state = 'adjudicated';
  await h.sweepProposals(T0 + MIN);
  // drift で deliberating へ差し戻された = 世代が進む → 猶予を待たずに配る
  p.state = 'deliberating';
  p.history.push({ to: 'deliberating' });
  await h.sweepProposals(T0 + 2 * MIN);
  assert.equal(h.sent.length, 2);
});

test('redeliverProposal は裁定待ちだけを対象に、pause 中でも配る (人間が今出せと言っている)', async (t) => {
  const p2 = proposal(2);
  const p3 = proposal(3, { state: 'adjudicated' });
  const h = harness(t, { list: [p2, p3], paused: true });
  h.thread('T2');
  assert.deepEqual(await h.redeliverProposal('99'), { ok: false, reason: '提案 #99 は見つかりません' });
  assert.deepEqual(await h.redeliverProposal('3'), {
    ok: false, reason: '提案 #3 は adjudicated なので配り直せません (裁定待ちだけが対象)',
  });
  assert.deepEqual(await h.redeliverProposal('2'), {
    ok: true, reason: '提案 #2 (work) の裁定依頼を出し直しました',
  });
  assert.equal(h.sent.length, 1);

  const disabled = harness(t, { list: null });
  assert.deepEqual(await disabled.redeliverProposal('2'), { ok: false, reason: '発議機構が無効です' });
});

test('発議と裁定は発議機構が無ければ断り、前提 (policy) が読めなければ保存しない', async (t) => {
  const disabled = harness(t, { list: null });
  assert.equal(
    await disabled.raiseProposal({ contract: { initiative: {} }, bot: { key: 'opus' }, thread: null }),
    '⚠️ 発議を受け取りましたが、発議機構が無効です (initiative.enabled)',
  );
  assert.equal(
    await disabled.applyProposalAdjudication({ contract: {}, bot: { key: 'fable' }, thread: null }),
    '⚠️ 裁定を受け取りましたが、発議機構が無効です (initiative.enabled)',
  );

  const h = harness(t, { list: [] }); // root に config.policy.json が無い
  assert.equal(
    await h.raiseProposal({ contract: { initiative: {} }, bot: { key: 'opus' }, thread: null }),
    '⚠️ 発議の前提 (policy) を読めませんでした — 保存していません',
  );
  assert.ok(h.errors.some((e) => e.startsWith('[proposals] 前提を読めませんでした:')), h.errors.join('\n'));
  assert.equal(h.safeProposalContext(), null);
  assert.throws(() => h.proposalContext(), /ENOENT|no such file/i);
});

test('announceProposal (org の稟議カード) は org 以外・前提が読めないときは何も出さない', async (t) => {
  const h = harness(t, { list: [] });
  assert.equal(await h.announceProposal(proposal(1)), null);
  assert.equal(await h.announceProposal(proposal(2, { class: 'org' })), null);
  assert.equal(h.sent.length, 0);
});

test('postToProposal は発議元スレッドへ投稿し、要人間なら owner をメンションして受信箱にも残す', async (t) => {
  const p = proposal(9);
  const h = harness(t, { list: [p] });
  h.thread('T9');
  const id = await h.postToProposal(p, '🏛 提案 #9 は当てられません: lane 不備', { mentionOwner: true, cc: { channelName: 'kt' } });
  assert.equal(id, 'T9');
  const [, payload] = h.sent[0];
  assert.equal(payload.content, '🏛 提案 #9 は当てられません: lane 不備\n<@U1>');
  assert.deepEqual(payload.allowedMentions.users, ['U1']);
  const entries = h.inbox.openList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].threadId, 'T9');
  assert.equal(entries[0].channel, 'kt');
  assert.match(entries[0].summary, /提案 #9 は当てられません/);
  assert.ok(h.logs.some((l) => l === '[inbox] 適用の要人間 #1 を記録: thread:T9'), h.logs.join('\n'));

  // 要人間でなければメンションも受信箱の記録も無い
  await h.postToProposal(p, 'ただの結果');
  assert.equal(h.sent[1][1].content, 'ただの結果');
  assert.deepEqual(h.sent[1][1].allowedMentions.users, []);
  assert.equal(h.inbox.openList().length, 1);

  // archive されたスレッドは飛ばして発議元チャンネルへ (チャンネルはスレッドを作らず直接)
  const p10 = proposal(10);
  h.thread('T10', { archived: true });
  h.channels.set('C1', { id: 'C1', isThread: () => false, send: async (payload) => { h.sent.push(['C1', payload]); return { id: 'c1-m' }; } });
  assert.equal(await h.postToProposal(p10, 'x'), 'C1');
  assert.equal(h.sent.at(-1)[0], 'C1');
});

test('resolveApplyBaseCommit は適用チャンネルの基点ブランチを commit OID に固める', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'communitd-basecommit-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '--initial-branch=master');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  const head = git('rev-parse', 'master');

  const config = {
    initiative: { enabled: true, applyChannel: 'dev' },
    channels: { dev: { cwd: repo, autonomy: { enabled: true, baseBranch: 'master' } } },
  };
  const h = harness(t, { list: [], config, root: repo });
  assert.equal(await h.resolveApplyBaseCommit(), head);

  // 適用チャンネルが無い配備では基点も無い / 存在しないブランチは null + ログ
  const none = harness(t, { list: [], config: { channels: {} }, root: repo });
  assert.equal(await none.resolveApplyBaseCommit(), null);
  const missing = harness(t, {
    list: [],
    config: { initiative: { applyChannel: 'dev' }, channels: { dev: { cwd: repo, autonomy: { baseBranch: 'nope' } } } },
    root: repo,
  });
  assert.equal(await missing.resolveApplyBaseCommit(), null);
  assert.ok(missing.errors.some((e) => e.startsWith('[proposals] 適用の基点 (nope) を読めませんでした:')), missing.errors.join('\n'));
});
