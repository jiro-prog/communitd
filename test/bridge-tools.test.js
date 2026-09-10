import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalRegistry } from '../src/approvals.js';
import { createToolApprovalWiring } from '../src/bridge/tools.js';
import { createAskLedger } from '../src/broker.js';
import { canonicalCwd } from '../src/grants.js';
import { proposeGrant } from '../src/toolrules.js';
import { ToolExtraStore } from '../src/toolstore.js';

// src/bridge/tools.js — ツール権限の申請カード (job 終了後) と、実行中の承認要求 (hook 経路) の配線。
// 台帳 (ApprovalRegistry / ToolExtraStore) は本物、Discord のスレッドだけ偽物。

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

const fetchOf = (url) => ({ tool_name: 'WebFetch', tool_input: { url } });

function harness(t, { maxApprovalCards = 2 } = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const toolExtra = new ToolExtraStore(join(dir, 'tools-extra.json'));
  const approvals = new ApprovalRegistry({ ttlMs: 60 * 1000 });
  const wiring = createToolApprovalWiring({ toolExtra, approvals, limits: { maxApprovalCards, approvalWaitMs: 5000 } });
  const thread = {
    id: 'T1',
    guildId: 'G',
    sent: [],
    fail: null,
    noId: false,
    send: async (payload) => {
      if (thread.fail) throw new Error(thread.fail);
      const message = { id: thread.noId ? undefined : `m${thread.sent.length + 1}`, edits: [], edit: async (p) => { message.edits.push(p); } };
      thread.sent.push({ ...payload, message });
      return message;
    },
  };
  const cwd = canonicalCwd(dir);
  const cc = { channelName: 'kt', cwd };
  const bot = { key: 'fable', cfg: { displayName: 'Fable' } };
  return { ...io, dir, cwd, toolExtra, approvals, thread, cc, bot, ...wiring };
}

test('approvedRulesFor / saveApprovedRule は data/tools-extra.json を channel × cwd で読み書きする', (t) => {
  const h = harness(t);
  assert.deepEqual(h.approvedRulesFor(h.cc), []);
  const proposed = proposeGrant(fetchOf('https://example.com/docs'), { cwd: h.cwd });
  assert.equal(proposed.ok, true);
  const request = h.approvals.register({
    guildId: 'G', channelId: 'T1', threadId: 'T1', botKey: 'fable', channelName: 'kt', grant: proposed.grant, rule: proposed.rule,
  });
  request.pendingConfirm = { userId: 'U1', at: Date.now() };
  assert.deepEqual(h.saveApprovedRule(request), { ok: true, added: true });
  assert.deepEqual(h.saveApprovedRule(request), { ok: true, added: false }, '同じ承認を二重に積んでいる');
  assert.deepEqual(h.approvedRulesFor(h.cc), [proposed.rule]);
  assert.deepEqual(h.approvedRulesFor({ channelName: 'other', cwd: h.cwd }), [], '別チャンネルへ漏れている');
  assert.equal(h.toolExtra.has('kt', proposed.grant), true);
  // 押した人・申請した bot・スレッドを grant に焼き込んで永続化する (監査の材料)
  const persisted = JSON.stringify(JSON.parse(readFileSync(join(h.dir, 'tools-extra.json'), 'utf8')));
  assert.match(persisted, /"approvedBy":"U1"/);
  assert.match(persisted, /"botKey":"fable"/);
  assert.match(persisted, /"threadId":"T1"/);
});

test('postApprovalRequests: 拒否を申請カードにし、恒久承認にできないものと溢れた分は注記で返す', async (t) => {
  const h = harness(t, { maxApprovalCards: 2 });
  const denials = [
    fetchOf('https://example.com/a'),
    fetchOf('https://example.com/b'), // 同じドメイン = 同じルール (重複しない)
    { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    fetchOf('https://other.org/'),
    fetchOf('https://third.net/'), // 上限 (2 件) を超える
  ];
  await h.postApprovalRequests(h.thread, h.bot, h.cc, denials, createAskLedger({ max: 3 }));
  const cards = h.thread.sent.filter((p) => p.components);
  assert.equal(cards.length, 2);
  assert.match(cards[0].content, /^\*\*🔐 ツール権限の申請\*\*\n申請元: fable \/ #kt\nルール: `WebFetch\(domain:example\.com\)`/);
  assert.equal(h.approvals.size, 2);
  for (const request of h.approvals.requests.values()) {
    assert.ok(request.messageId, 'カードのメッセージ ID を申請へ束縛していない');
    assert.equal(request.hook, false);
  }
  const notes = h.thread.sent.at(-1).content;
  assert.match(notes, /^⚠️ 恒久承認にできない拒否がありました/);
  assert.match(notes, /・Bash — シェルコマンドの許可は自動承認できません/);
  assert.match(notes, /⚠️ 承認カードは 1 回 2 件までのため、他 1 件は出していません/);
});

test('postApprovalRequests: 承認済み・実行中に確認済みのルールはカードにせず注記する', async (t) => {
  const h = harness(t);
  const proposed = proposeGrant(fetchOf('https://example.com/'), { cwd: h.cwd });
  h.toolExtra.add('kt', { ...proposed.grant, approvedBy: 'U1', approvedAt: new Date().toISOString(), botKey: 'fable', threadId: 'T1' });
  const ledger = createAskLedger({ max: 3 });
  ledger.reserve('WebFetch(domain:other.org)');
  await h.postApprovalRequests(h.thread, h.bot, h.cc, [fetchOf('https://example.com/'), fetchOf('https://other.org/')], ledger);
  assert.equal(h.thread.sent.filter((p) => p.components).length, 0, 'カードを出している');
  assert.equal(h.approvals.size, 0);
  const notes = h.thread.sent[0].content;
  assert.match(notes, /⚠️ 承認済みなのに拒否されたルールがあります: `WebFetch\(domain:example\.com\)`/);
  assert.match(notes, /ℹ️ 実行中に承認カードで確認したルールは出し直していません: `WebFetch\(domain:other\.org\)`/);
});

test('postApprovalRequests: カードを出せなければ申請を取り消して上へ投げる (handoff を止める)', async (t) => {
  const h = harness(t);
  h.thread.fail = 'archived';
  await assert.rejects(
    () => h.postApprovalRequests(h.thread, h.bot, h.cc, [fetchOf('https://example.com/')]),
    /archived/,
  );
  assert.equal(h.approvals.size, 0, '押せないカードの申請が台帳に残っている');

  const h2 = harness(t);
  h2.thread.noId = true;
  await assert.rejects(
    () => h2.postApprovalRequests(h2.thread, h2.bot, h2.cc, [fetchOf('https://example.com/')]),
    /申請カードのメッセージ ID を取得できませんでした/,
  );
  assert.equal(h2.approvals.size, 0);
});

/** hook 経路の ask を 1 件裁く (押す側の操作は呼び出し側で起こす) */
function askFor(h, { rule = 'https://example.com/x', allowedTools = ['Read'], ledger = createAskLedger({ max: 2 }), controller = new AbortController() } = {}) {
  const waiting = [];
  const promise = h.decideApproval({
    ask: fetchOf(rule), signal: controller.signal, thread: h.thread, bot: h.bot, cc: h.cc, allowedTools,
    askLedger: ledger, onWaitingChange: (delta) => waiting.push(delta),
  });
  return { promise, waiting, ledger, controller };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('decideApproval: 既に許可されている呼び出しは聞かずに通す', async (t) => {
  const h = harness(t);
  const { promise } = askFor(h, { allowedTools: ['WebFetch'] });
  assert.deepEqual(await promise, { decision: 'pass' });
  const proposed = proposeGrant(fetchOf('https://example.com/'), { cwd: h.cwd });
  h.toolExtra.add('kt', { ...proposed.grant, approvedBy: 'U1', approvedAt: new Date().toISOString(), botKey: 'fable', threadId: 'T1' });
  const approved = await askFor(h).promise;
  assert.equal(approved.decision, 'allow');
  assert.equal(h.thread.sent.length, 0, '聞かなくてよい呼び出しでカードを出している');
});

test('decideApproval: カードを出して job を止め、押されて保存が通ったら allow を返す', async (t) => {
  const h = harness(t);
  const { promise, waiting } = askFor(h);
  await settle();
  assert.deepEqual(waiting, [1], '待ち始めを placeholder へ伝えていない');
  const card = h.thread.sent[0];
  assert.match(card.content, /^\*\*🔐 ツール権限の申請 \(job を止めて待っています\)\*\*/);
  assert.match(card.content, /待つのは約 5 秒で/);
  const [request] = h.approvals.requests.values();
  assert.equal(request.hook, true);
  assert.equal(request.messageId, 'm1');
  assert.equal(h.approvals.waitingCount, 1);

  const pressed = h.approvals.resolve({
    nonce: request.nonce, action: 'allow', userId: 'U1', guildId: 'G', channelId: 'T1', messageId: 'm1', botKey: 'fable', isAuthorized: true,
  });
  assert.equal(pressed.stage, 'pending-save');
  h.approvals.commit(request.nonce, 'U1');
  const decided = await promise;
  assert.equal(decided.decision, 'allow');
  assert.deepEqual(waiting, [1, -1]);
  assert.ok(h.logs.some((l) => l.startsWith('[tools] 実行中の申請 allow: ')), h.logs.join('\n'));
});

test('decideApproval: 却下・中断 (待ち上限) は deny で、待機者を残さない', async (t) => {
  const h = harness(t);
  const denied = askFor(h);
  await settle();
  const [request] = h.approvals.requests.values();
  h.approvals.resolve({
    nonce: request.nonce, action: 'deny', userId: 'U1', guildId: 'G', channelId: 'T1', messageId: 'm1', botKey: 'fable', isAuthorized: true,
  });
  assert.equal((await denied.promise).decision, 'deny');
  assert.equal(h.approvals.waitingCount, 0);

  const aborted = askFor(h, { rule: 'https://other.org/' });
  await settle();
  aborted.controller.abort();
  const out = await aborted.promise;
  assert.equal(out.decision, 'deny');
  assert.equal(h.approvals.waitingCount, 0, '中断した待機者が残っている');
  const card = h.thread.sent.at(-1).message;
  assert.equal(card.edits.length, 1, '押されないまま終わったカードを畳んでいない');
  assert.match(card.edits[0].content, /^\*\*⌛ この申請は無効になりました/);

  // 既に中断済みの signal でも待たない
  const early = new AbortController();
  early.abort();
  const late = askFor(h, { rule: 'https://third.net/', controller: early });
  assert.deepEqual(await late.promise, { decision: 'deny', reason: 'job が終了したため承認を待てません' });
});

test('decideApproval: 同じルールは 1 job で 1 回だけ聞き、上限を超えたら聞かない', async (t) => {
  const h = harness(t, { maxApprovalCards: 1 });
  const ledger = createAskLedger({ max: 1 });
  const first = askFor(h, { ledger });
  await settle();
  const again = await askFor(h, { ledger }).promise;
  assert.deepEqual(again, { decision: 'deny', reason: 'この job では既に確認済みです (承認されませんでした)' });
  const over = await askFor(h, { rule: 'https://other.org/', ledger }).promise;
  assert.deepEqual(over, { decision: 'deny', reason: 'この job の承認カードは 1 件までのため、これ以上は聞きません' });
  assert.equal(h.thread.sent.length, 1, '同じルールや上限超えでカードを出している');
  first.controller.abort();
  await first.promise;
});

test('decideApproval: カードを出せなければ枠を返し、申請も取り消して deny', async (t) => {
  const h = harness(t);
  h.thread.fail = 'archived';
  const ledger = createAskLedger({ max: 2 });
  const out = await askFor(h, { ledger }).promise;
  assert.deepEqual(out, { decision: 'deny', reason: '承認カードを投稿できなかったため実行しません' });
  assert.equal(ledger.size, 0, '出せなかったカードを「聞いた」に数えている');
  assert.equal(h.approvals.size, 0);

  const h2 = harness(t);
  h2.thread.noId = true;
  const out2 = await askFor(h2).promise;
  assert.deepEqual(out2, { decision: 'deny', reason: '承認カードを特定できなかったため実行しません' });
  assert.equal(h2.approvals.size, 0);
  assert.match(h2.thread.sent[0].message.edits[0].content, /この申請は無効です/);
});
