import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLimits } from '../src/attachments.js';
import { createTurnWiring } from '../src/bridge/turn.js';
import { readContractNonce } from '../src/contract.js';
import { InboxStore } from '../src/inbox.js';
import { ContractStore } from '../src/store.js';

// src/bridge/turn.js — 1 ターンの成果物を Discord へ届ける配線 (postTurn)。
// 投稿順・完了境界・契約の保存と取り消し・受信箱の記録を、偽のスレッドで固定する。
// 順序の判断 (src/delivery.js) と本文の解決 (src/mentions.js) は本物。

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

const BOTS = [
  { key: 'fable', displayName: 'Fable', userId: 'F' },
  { key: 'opus', displayName: 'Opus', userId: 'O' },
  { key: 'sol', displayName: 'Sol', userId: 'S' },
];
const BOT_KEY = { F: 'fable', O: 'opus', S: 'sol' };

function harness(t, { submitted = false, ownerTargets = [{ userId: 'U1', displayName: 'So' }] } = {}) {
  const io = captureConsole(t);
  const dir = mkdtempSync(join(tmpdir(), 'communitd-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contracts = new ContractStore(join(dir, 'contracts.json'));
  const inbox = new InboxStore(join(dir, 'inbox.json'));
  const completions = [];
  const approvals = [];
  const wiring = createTurnWiring({
    config: { bots: { fable: { runtime: 'claude' }, opus: { runtime: 'claude' }, sol: { runtime: 'codex' } } },
    inbox,
    contracts,
    ownerTargets,
    limits: { attachments: resolveLimits() },
    botKeyOf: (id) => BOT_KEY[id] ?? null,
    botEntries: () => BOTS,
    contractCwd: (cc) => cc.repoRoot ?? cc.cwd,
    noteTaskCompletion: async (p) => { completions.push(p); return submitted; },
    postApprovalRequests: async (...args) => { approvals.push(args); },
  });
  const thread = {
    id: 'T1',
    sent: [],
    failOn: null,
    send: async (payload) => {
      if (thread.failOn && String(payload.content ?? '').includes(thread.failOn)) throw new Error('send failed');
      thread.sent.push(payload);
      return { id: `m${thread.sent.length}` };
    },
  };
  const placeholder = { edits: [], deleted: false, edit: async (p) => { placeholder.edits.push(p); }, delete: async () => { placeholder.deleted = true; } };
  const bot = { key: 'fable', cfg: { displayName: 'Fable' }, userId: 'F' };
  const cc = { channelName: 'kt', cwd: dir, repoRoot: dir };
  const deliveries = [];
  const run = { delivery: (label, status) => deliveries.push([label, status]) };
  return { ...io, dir, contracts, inbox, completions, approvals, thread, placeholder, bot, cc, deliveries, run, ...wiring };
}

const contents = (thread) => thread.sent.map((p) => p.content ?? '(files)');

test('本文 → 制御メンション の順に届け、handoff の宛先を実行記録へ返す', async (t) => {
  const h = harness(t);
  const res = { result: 'やりました\n\n[[handoff:opus]]' };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, null, h.placeholder, null, { run: h.run });

  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, true);
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.handoff, { toBotKey: 'opus', kind: 'handoff' });
  assert.equal(out.taskSubmitted, false);
  assert.deepEqual(contents(h.thread), ['やりました', '<@O>']);
  assert.deepEqual(h.thread.sent[0].allowedMentions.users, [], '本文に実メンションを載せている');
  assert.deepEqual(h.thread.sent[1].allowedMentions.users, ['O']);
  assert.deepEqual(h.deliveries, [['本文', 'pending'], ['本文', 'sent'], ['制御メンション', 'pending'], ['制御メンション', 'sent']]);
  assert.equal(h.completions.length, 1, '配信できたら完了の検知を 1 回だけ回す');
  assert.equal(h.completions[0].mention.kind, 'handoff');
  assert.equal(h.contracts.list('T1', 'opus').length, 0, '契約の無い handoff で何かを保存している');
});

const VERIFY_NG = { ok: false, code: 1, command: 'npm test', output: 'FAIL a.test.js', durationMs: 1200 };

test('verify NG は結果まで配送したうえで元の handoff を止め、投げ手へ戻す (§12.3 (3))', async (t) => {
  const h = harness(t);
  const contract = {
    body: '直しました\n\n[[handoff:sol]]', background: '背景', purpose: '目的', touch_set: ['a.js'],
    acceptance: ['x'], stop_conditions: ['y'], touch_restricted: false,
  };
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '(raw)' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, outgoingText: contract.body, contractOut: { kind: 'delegation', contract },
    issuerBotKey: 'opus', run: h.run,
  });

  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, true, '戻し先を呼んでいない');
  assert.deepEqual(out.handoff, { toBotKey: 'opus', kind: 'handoff' });
  const sent = contents(h.thread);
  assert.match(sent[1], /^❌ verify 失敗 \(exit 1/);
  assert.equal(
    sent.at(-1),
    '<@O>\n↩️ verify NG のため Opus へ戻します (元の handoff は実行していません / 元の宛先: Sol)',
  );
  assert.deepEqual(h.thread.sent.at(-1).allowedMentions.users, ['O']);
  assert.equal(sent.some((c) => c.startsWith('<@S>')), false, '元の handoff 先を呼んでいる');
  // 契約は保存しない (戻し先は「頼んだ相手」で、この報告が委譲した相手ではない)
  assert.equal(h.contracts.list('T1', 'sol').length, 0, 'verify NG なのに委譲契約を保存している');
  assert.equal(h.contracts.list('T1', 'opus').length, 0, '戻し先に身に覚えのない契約を積んでいる');
  assert.equal(readContractNonce(sent.at(-1)), null, '契約タグを載せている');
  assert.equal(h.completions[0].verifyResult, VERIFY_NG, '完了の検知に verify の結果を渡していない');
  assert.equal(h.inbox.openList().length, 0, '戻し先が bot なのに受信箱へ載せている');
});

// Opus2 レビュー 2026-09-07 Major1: 人間への質問は verify NG でも投げ手への戻しに化けない
test('verify NG でも元の宛先が [[notify:owner]] ならそのまま So を呼び、受信箱に残す', async (t) => {
  const h = harness(t);
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '(raw)' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, outgoingText: '仕様の空白があります\n\n[[notify:owner]]',
    issuerBotKey: 'opus', run: h.run,
  });
  assert.equal(out.handedOff, true);
  assert.deepEqual(out.handoff, { toBotKey: null, kind: 'notify' });
  const sent = contents(h.thread);
  assert.match(sent.at(-1), /^<@U1>/, 'So を呼んでいない');
  assert.doesNotMatch(sent.at(-1), /verify NG のため/, '質問が投げ手への戻しに化けている');
  assert.equal(sent.some((c) => c.startsWith('<@O>')), false, '投げ手を呼んでいる');
  assert.equal(h.inbox.openList().length, 1, '人間への質問が受信箱に残っていない');
});

test('verify NG で戻す相手が居なければ owner を呼ぶ (自分自身・未起動・人間起点)', async (t) => {
  // 人間が直接呼んだ job (投げ手なし)
  const h = harness(t);
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '直しました\n\n[[handoff:opus]]' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, run: h.run,
  });
  assert.equal(out.delivered, true);
  assert.deepEqual(out.handoff, { toBotKey: null, kind: 'notify' });
  assert.equal(
    contents(h.thread).at(-1),
    '<@U1>\n⛔ verify NG で止まりました — 戻す相手が居ません (元の handoff は実行していません / 元の宛先: Opus)',
  );
  // 人間を待たせる通知なので受信箱へ残す ([[notify:owner]] と同じ経路)
  const entries = h.inbox.openList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].threadId, 'T1');

  // 自己呼び出し (投げ手が自分) — 戻しても同じ結果になるだけなので owner へ
  const self = harness(t);
  await self.postTurn(self.thread, self.bot, self.cc, { result: 'x' }, null, self.placeholder, null, {
    verifyResult: VERIFY_NG, issuerBotKey: 'fable', run: self.run,
  });
  assert.match(contents(self.thread).at(-1), /^<@U1>\n⛔ verify NG で止まりました/);

  // 起動していない bot が投げ手 (userId なし)
  const gone = harness(t);
  await gone.postTurn(gone.thread, gone.bot, gone.cc, { result: 'x' }, null, gone.placeholder, null, {
    verifyResult: VERIFY_NG, issuerBotKey: 'ghost', run: gone.run,
  });
  assert.match(contents(gone.thread).at(-1), /^<@U1>\n⛔ verify NG で止まりました/);

  // 編成 (/roster) から外れた投げ手も呼ばない — 宛先の allowlist を戻しだけ迂回しない
  const outside = harness(t);
  await outside.postTurn(outside.thread, outside.bot, outside.cc, { result: 'x' }, null, outside.placeholder, ['fable'], {
    verifyResult: VERIFY_NG, issuerBotKey: 'opus', run: outside.run,
  });
  assert.match(contents(outside.thread).at(-1), /^<@U1>\n⛔ verify NG で止まりました/);
});

test('verify NG で投げ手も owner も居なければ従来どおり黙って止まる', async (t) => {
  const h = harness(t, { ownerTargets: [] });
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '直しました\n\n[[handoff:opus]]' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, run: h.run,
  });
  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, false);
  assert.equal(out.handoff, null);
  const sent = contents(h.thread);
  assert.equal(sent.length, 2, '呼ぶ相手が居ないのに 1 通増えている');
  assert.match(sent[1], /次の担当は呼び出していません/);
});

test('委譲契約は handoff の直前に保存し、同じ nonce のタグを制御メンションへ載せる', async (t) => {
  const h = harness(t);
  const contract = {
    body: 'お願いします\n\n[[handoff:opus]]', background: '背景', purpose: '目的', touch_set: ['a.js'],
    acceptance: ['テストが通る'], stop_conditions: ['止まる'], touch_restricted: false,
  };
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '(raw)' }, null, h.placeholder, null, {
    outgoingText: contract.body, contractOut: { kind: 'delegation', contract }, run: h.run,
  });
  assert.equal(out.handedOff, true);
  const saved = h.contracts.list('T1', 'opus');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'delegation');
  assert.equal(saved[0].fromBotKey, 'fable');
  assert.equal(saved[0].cwd, h.dir, '契約を本体の cwd で束縛していない');
  const mention = h.thread.sent.at(-1).content;
  assert.equal(mention.split('\n')[0], '<@O>');
  assert.equal(readContractNonce(mention), saved[0].nonce, '制御メンションのタグと保存した契約の nonce が違う');
  assert.ok(h.logs.some((l) => l === '[contract] 保存 (delegation): thread:T1 fable → opus (touch 1 件 / 制限なし)'), h.logs.join('\n'));
  // 配送の記録は Discord へ送る段 (本文・添付・制御メンション) だけ — 契約の保存は記録しない
  assert.deepEqual(h.deliveries.map(([label]) => label), ['本文', '本文', '制御メンション', '制御メンション']);
});

test('touch 制限つきの委譲は codex の担当へ渡せない — 保存で止め、handoff しない', async (t) => {
  const h = harness(t);
  const contract = {
    body: 'お願いします\n\n[[handoff:sol]]', background: '背景', purpose: '目的', touch_set: ['a.js'],
    acceptance: ['x'], stop_conditions: ['y'],
  };
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '(raw)' }, null, h.placeholder, null, {
    outgoingText: contract.body, contractOut: { kind: 'delegation', contract }, run: h.run,
  });
  assert.equal(out.delivered, false);
  assert.equal(out.handedOff, false);
  assert.match(out.failures[0], /^委譲契約の保存: touch 制限つきの委譲は codex ランタイムの担当へ渡せません/);
  assert.equal(h.contracts.list('T1', 'sol').length, 0);
  assert.equal(contents(h.thread).some((c) => c.startsWith('<@S>')), false, '契約を保存できないのに相手を呼んでいる');
  assert.match(contents(h.thread).at(-1), /^⚠️ 投稿の一部に失敗したため、次の担当は呼び出していません/);
  assert.match(h.placeholder.edits[0].content, /^⚠️ 投稿の一部に失敗したため/);
  assert.equal(h.completions.length, 0, '配信に失敗したのに完了を検知している');
  assert.ok(h.errors.some((e) => e.startsWith('[fable thread:T1] 配信に失敗したため handoff しません:')), h.errors.join('\n'));
});

test('制御メンションの送信に失敗したら保存した契約を取り消す (配送に失敗した 1 件だけ)', async (t) => {
  const h = harness(t);
  h.thread.failOn = '<@O>';
  const contract = {
    body: 'お願いします\n\n[[handoff:opus]]', background: '背景', purpose: '目的', touch_set: ['a.js'],
    acceptance: ['x'], stop_conditions: ['y'], touch_restricted: false,
  };
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '(raw)' }, null, h.placeholder, null, {
    outgoingText: contract.body, contractOut: { kind: 'delegation', contract }, run: h.run,
  });
  assert.equal(out.delivered, false);
  assert.deepEqual(out.failures, ['制御メンション: send failed']);
  assert.equal(h.contracts.list('T1', 'opus').length, 0, '配送に失敗した契約が残っている');
  assert.ok(h.logs.some((l) => l === '[contract] 配送に失敗したため取り消し: thread:T1 → opus'), h.logs.join('\n'));
  assert.deepEqual(h.deliveries.at(-1), ['制御メンション', 'failed']);
  assert.equal(out.handoff, null);
});

test('送達不明 (timeout 系) の失敗は failed ではなく unknown として記録する', async (t) => {
  const h = harness(t);
  h.thread.send = async () => { throw new Error('ETIMEDOUT'); };
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: 'x' }, null, h.placeholder, null, { run: h.run });
  assert.equal(out.delivered, false);
  assert.deepEqual(h.deliveries, [['本文', 'pending'], ['本文', 'unknown']]);
  assert.match(h.placeholder.edits[0].content, /本文: ETIMEDOUT/);
});

test('[[notify:owner]] は So を呼び、送れたときだけ受信箱に残す', async (t) => {
  const h = harness(t);
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: 'So に相談したい\n\n[[notify:owner]]' }, null, h.placeholder, null, { run: h.run });
  assert.equal(out.handedOff, true);
  assert.deepEqual(out.handoff, { toBotKey: null, kind: 'notify' });
  assert.equal(h.thread.sent.at(-1).content, '<@U1>');
  const entries = h.inbox.openList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].threadId, 'T1');
  assert.equal(entries[0].botKey, 'fable');
  assert.equal(entries[0].summary, 'So に相談したい');
  assert.equal(entries[0].messageId, 'm2');
  assert.ok(h.logs.some((l) => l === '[inbox] 停止通知 #1 を記録: thread:T1 (fable)'), h.logs.join('\n'));

  // 人間が発言したら閉じる
  h.closeInboxForThread('T1');
  assert.equal(h.inbox.openList().length, 0);
  assert.ok(h.logs.some((l) => l === '[inbox] 停止通知 #1 を閉じました (人間の発言)'), h.logs.join('\n'));
});

test('本文の後に git 差分・権限通知・契約の警告・メンション警告 の順で足す', async (t) => {
  const h = harness(t);
  const git = (...args) => execFileSync('git', ['-C', h.dir, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  writeFileSync(join(h.dir, 'new.txt'), 'x\n');
  const res = {
    result: '本文\n[[handoff:opus]]\n途中の行 (フッタではない)',
    permissionDenials: [{ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/' } }],
  };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, [], h.placeholder, null, {
    contractNotes: ['⚠️ 様式に合いませんでした'], run: h.run,
  });
  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, false, '本文中のマーカーで起動している');
  const sent = contents(h.thread);
  assert.equal(sent[0], '本文\n途中の行 (フッタではない)');
  assert.equal(sent[1], '📋 実行前後の git status 差分:\n```\n+ ?? new.txt\n```');
  assert.equal(h.approvals.length, 1, '権限通知を出していない');
  assert.equal(h.approvals[0][3], res.permissionDenials);
  assert.equal(sent[2], '⚠️ 様式に合いませんでした');
  assert.match(sent[3], /^⚠️ メンション制御の警告:\n本文中の `\[\[handoff:opus\]\]` は実行していません/);
  assert.equal(sent.length, 4);
});

test('添付マーカーは cwd 配下の実在画像だけを送り、送れなかったものは警告にする', async (t) => {
  const h = harness(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(h.dir, 'shot.png'), png);
  const res = { result: '図です\n[[attach:shot.png]]\n[[attach:missing.png]]' };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, null, h.placeholder, null, { run: h.run });
  assert.equal(out.delivered, true);
  assert.equal(h.thread.sent[0].content, '図です');
  assert.equal(h.thread.sent[1].files.length, 1);
  assert.equal(h.thread.sent[1].files[0].name, 'shot.png');
  assert.match(h.thread.sent[2].content, /^⚠️ 添付できなかった画像:\n/);
  assert.match(h.thread.sent[2].content, /missing\.png/);
  assert.deepEqual(h.deliveries.filter(([label]) => label === '添付'), [['添付', 'pending'], ['添付', 'sent']]);
});

test('完了の検知は配信できたときだけ、レビューへ進めたら taskSubmitted に写す', async (t) => {
  const h = harness(t, { submitted: true });
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: '完了しました' }, null, h.placeholder, null, { run: h.run });
  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, false);
  assert.equal(out.taskSubmitted, true);
  assert.equal(out.handoff, null);
});

test('outgoingContext は編成を反映した bot 一覧と owner を返す', (t) => {
  const h = harness(t);
  const ctx = h.outgoingContext(h.bot, ['fable', 'opus']);
  assert.equal(ctx.selfBotKey, 'fable');
  assert.deepEqual(ctx.owner, { userId: 'U1', names: ['So'] });
  assert.equal(ctx.bots.find((b) => b.key === 'sol').inRoster, false, '編成外の bot を落としている (断る理由が変わる)');
  assert.notEqual(ctx.bots.find((b) => b.key === 'opus').inRoster, false);
});

// ---- 案件に結ばれた job の配送 (docs/society-ledger.md §5・S2-3a) ----

const CASE_ACTION = { caseId: 'C-1', actionId: 'A-1', claimGeneration: 1 };

test('案件付きの job では本文の handoff を実行せず、警告を出す', async (t) => {
  const h = harness(t);
  const res = { result: 'できました\n\n[[handoff:opus]]' };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, null, h.placeholder, null, {
    run: h.run, societyAction: CASE_ACTION,
  });

  assert.equal(out.delivered, true);
  assert.equal(out.handedOff, false, '台帳を通らない起動を作らない');
  assert.equal(out.handoff, null);
  // 本文は届く。落としたことは黙らない
  const sent = contents(h.thread);
  assert.equal(sent[0], 'できました');
  assert.ok(sent.some((c) => /案件 C-1 に結ばれた job なので、本文の handoff は実行していません/.test(c)));
  assert.ok(sent.some((c) => /next\.plan/.test(c)));
  assert.equal(sent.includes('<@O>'), false, '宛先へメンションを送っている');
});

test('案件付きでも [[notify:owner]] は止めない (人間への質問は案件の外)', async (t) => {
  const h = harness(t);
  const res = { result: '判断をお願いします\n\n[[notify:owner]]' };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, null, h.placeholder, null, {
    run: h.run, societyAction: CASE_ACTION,
  });

  assert.equal(out.handedOff, true);
  assert.equal(out.handoff.kind, 'notify');
  assert.equal(contents(h.thread).some((c) => /handoff は実行していません/.test(c)), false);
});

test('案件付きの verify NG は配送係へ戻さず owner を呼ぶ (投げ手が居ないため)', async (t) => {
  const h = harness(t);
  // 案件の起動を投げたのは pickAnnouncer が機械的に選んだ配送係で、その bot は
  // この案件を知らない (戻しても案件付きでない普通の job になり台帳は動かない)
  const out = await h.postTurn(h.thread, h.bot, h.cc, { result: 'x' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, issuerBotKey: 'opus', run: h.run, societyAction: CASE_ACTION,
  });

  assert.equal(out.handedOff, true);
  assert.equal(out.handoff.kind, 'notify', 'bot ではなく人間を呼ぶ');
  const last = contents(h.thread).at(-1);
  assert.match(last, /^<@U1>\n⛔ verify NG で止まりました/);
  // 台帳側の待ち (waiting(evidence)) と噛み合う言い方になっている
  assert.match(last, /案件 C-1 は verify が通るまで待ちです/);
  assert.equal(/戻す相手が居ません/.test(last), false);
});

test('案件が無い job の verify NG は従来どおり投げ手へ戻す (回帰)', async (t) => {
  const h = harness(t);
  await h.postTurn(h.thread, h.bot, h.cc, { result: 'x' }, null, h.placeholder, null, {
    verifyResult: VERIFY_NG, issuerBotKey: 'opus', run: h.run,
  });
  assert.match(contents(h.thread).at(-1), /^<@O>\n↩️ verify NG のため Opus へ戻します/);
});

test('案件が無い job の handoff は従来どおり (回帰)', async (t) => {
  const h = harness(t);
  const res = { result: 'やりました\n\n[[handoff:opus]]' };
  const out = await h.postTurn(h.thread, h.bot, h.cc, res, null, h.placeholder, null, { run: h.run });
  assert.equal(out.handedOff, true);
  assert.deepEqual(out.handoff, { toBotKey: 'opus', kind: 'handoff' });
});
