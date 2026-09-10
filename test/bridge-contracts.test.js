import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  contractCwd,
  createContractWiring,
  managedPolicyPath,
  readExternalSettings,
} from '../src/bridge/contracts.js';
import { bindContract, formatContractTag } from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { ContractStore } from '../src/store.js';

// src/bridge/contracts.js — 委譲契約 (T6) の取り出し・破棄・実権限への変換の配線。
// ContractStore は本物 (一時ファイル)、Discord のメッセージだけ偽物。

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

function tmp(t, prefix = 'communitd-contracts-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BOT_IDS = { F: 'fable', O: 'opus', S: 'sol' };
const botKeyOf = (id) => BOT_IDS[id] ?? null;
const NONCE = 'abcdef0123456789';

const REPORT = {
  body: '報告です', changed_files: ['a.js'], did: ['直した'], verification: 'npm test 通過', remaining: [],
};
const DELEGATION = {
  body: 'お願いします', background: '背景', purpose: '目的', touch_set: ['a.js'],
  acceptance: ['テストが通る'], stop_conditions: ['分からなければ止める'],
};

function entryFor(kind, contract, { from = 'fable', to = 'opus', cwd, nonce = NONCE, threadId = 'T1' }) {
  const entry = bindContract({
    id: `id-${nonce}`, nonce, kind, contract, threadId, fromBotKey: from, toBotKey: to,
    cwd, channelName: 'kt', at: new Date().toISOString(),
  });
  assert.ok(entry, '契約を束縛できない');
  return entry;
}

function msgFrom(authorId, { thread = true, content = `<@O>\n${formatContractTag(NONCE)}` } = {}) {
  return { id: 'M1', author: { id: authorId, bot: authorId !== 'U1' }, content, channel: { id: 'T1', isThread: () => thread } };
}

function harness(t) {
  const io = captureConsole(t);
  const dir = tmp(t);
  const contracts = new ContractStore(join(dir, 'contracts.json'));
  const wiring = createContractWiring({ contracts, botKeyOf });
  const bot = { key: 'opus', cfg: { displayName: 'Opus', runtime: 'claude' } };
  const thread = { id: 'T1' };
  return { ...io, dir, contracts, bot, thread, ...wiring };
}

test('contractCwd は本体 (repoRoot) へ寄せ、無ければ cwd', () => {
  assert.equal(contractCwd({ repoRoot: 'C:/repo', cwd: 'C:/repo/.worktrees/task-1' }), 'C:/repo');
  assert.equal(contractCwd({ cwd: 'C:/repo' }), 'C:/repo');
});

test('managedPolicyPath は OS ごとに固定の置き場', () => {
  assert.ok(managedPolicyPath().endsWith('managed-settings.json'));
  if (process.platform === 'win32') assert.match(managedPolicyPath(), /ClaudeCode[\\/]managed-settings\.json$/);
});

test('readExternalSettings は読めた settings だけを申告し、管理者ポリシーは存在だけで申告する', (t) => {
  const userDir = tmp(t, 'communitd-claude-home-');
  const cwd = tmp(t, 'communitd-project-');
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), '{ broken');
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {} }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = userDir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });

  const sources = readExternalSettings(cwd);
  const labels = sources.filter((s) => !s.managed).map((s) => s.label);
  assert.deepEqual(labels, ['user settings', 'project settings (local)'], '壊れた project settings を落としていない');
  assert.deepEqual(sources[0].settings, { permissions: { allow: ['Bash'] } });
  const managed = sources.find((s) => s.managed);
  assert.equal(Boolean(managed), existsSync(managedPolicyPath()), '管理者ポリシーの申告が実在と食い違う');
  if (managed) assert.equal(managed.settings, null);
});

test('claimContract: 人間が呼んだ job はストアに触れず、bot の handoff は nonce で 1 件だけ取り出す', (t) => {
  const h = harness(t);
  const cwd = canonicalCwd(h.dir);
  const cc = { channelName: 'kt', cwd, repoRoot: cwd };
  h.contracts.push('T1', 'opus', entryFor('report', REPORT, { cwd }));
  h.contracts.push('T1', 'opus', entryFor('report', REPORT, { cwd, nonce: 'ffffffff00000000' }));

  assert.deepEqual(h.claimContract({ bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('U1') }), { entry: null, error: null });
  assert.equal(h.contracts.list('T1', 'opus').length, 2, '人間の起動で契約を消費している');

  const untagged = h.claimContract({ bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F', { content: '<@O>' }) });
  assert.deepEqual(untagged, { entry: null, error: null, expected: false });

  const claimed = h.claimContract({ bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F') });
  assert.equal(claimed.error, null);
  assert.equal(claimed.expected, true);
  assert.equal(claimed.entry.nonce, NONCE);
  assert.deepEqual(h.contracts.list('T1', 'opus').map((e) => e.nonce), ['ffffffff00000000'], '完全一致以外まで消している');

  // 別の送信元 (nonce は同じ) では結ばれない
  const other = h.claimContract({ bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('S') });
  assert.equal(other.entry, null);
  assert.equal(other.error, null);
});

test('claimContract: ストアが読めなければ契約なしとして走らせず、理由を返す', (t) => {
  const h = harness(t);
  const broken = createContractWiring({
    contracts: { claim: () => { throw new Error('EACCES'); } },
    botKeyOf,
  });
  const cc = { channelName: 'kt', cwd: h.dir, repoRoot: h.dir };
  const out = broken.claimContract({ bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F') });
  assert.deepEqual(out, { entry: null, error: 'EACCES', expected: true });
  assert.ok(h.errors.some((e) => e === '[contract] 取り出しに失敗 (thread:T1 → opus): EACCES'), h.errors.join('\n'));
});

test('discardContractFor: 起動しない handoff の契約はスレッド内・bot 発・タグ付きのときだけ捨てる', (t) => {
  const h = harness(t);
  const cwd = canonicalCwd(h.dir);
  h.contracts.push('T1', 'opus', entryFor('report', REPORT, { cwd }));

  h.discardContractFor(h.bot, msgFrom('F', { thread: false }), 'チャンネル未登録');
  assert.equal(h.contracts.list('T1', 'opus').length, 1, 'スレッド外で捨てている');
  h.discardContractFor(h.bot, msgFrom('U1'), '受付停止中');
  assert.equal(h.contracts.list('T1', 'opus').length, 1, '人間の投稿で捨てている');
  h.discardContractFor(h.bot, msgFrom('F', { content: '<@O>' }), '受付停止中');
  assert.equal(h.contracts.list('T1', 'opus').length, 1, 'タグ無しで捨てている');

  h.discardContractFor(h.bot, msgFrom('F'), '受付停止中');
  assert.equal(h.contracts.list('T1', 'opus').length, 0);
  assert.ok(h.logs.some((l) => l === '[contract] 起動しない handoff の契約を捨てました (受付停止中) thread:T1 fable → opus'), h.logs.join('\n'));

  // 捨てられなくても投げない (24 時間で期限切れになる)
  const broken = createContractWiring({ contracts: { claim: () => { throw new Error('EACCES'); } }, botKeyOf });
  broken.discardContractFor(h.bot, msgFrom('F'), 'ホップ上限');
  assert.ok(h.errors.some((e) => e === '[contract] 起動しない handoff の契約を捨てられませんでした: EACCES'), h.errors.join('\n'));
});

test('applyIncomingContract: 取り出せなかった・失われた契約では起動しない (fail-open にしない)', (t) => {
  const h = harness(t);
  const cc = { channelName: 'kt', cwd: h.dir, repoRoot: h.dir };
  const base = { bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F'), baseAllowedTools: ['Read', 'Edit'] };

  const unreadable = h.applyIncomingContract({ ...base, claimed: { entry: null, error: 'EACCES', expected: true } });
  assert.equal(unreadable.stop, '❌ 引き継ぎ構造を取り出せなかったため起動しません: EACCES');
  assert.equal(unreadable.contract, null);

  const lost = h.applyIncomingContract({ ...base, claimed: { entry: null, error: null, expected: true } });
  assert.match(lost.stop, /委譲契約が見つかりません/);
  assert.match(lost.stop, /委譲し直してください/);

  const none = h.applyIncomingContract({ ...base, claimed: { entry: null, error: null } });
  assert.deepEqual(none, { kind: null, contract: null, narrowed: null, stop: null });
});

test('applyIncomingContract: 宛先・スレッド・cwd・送信元のどれかが違う契約は適用せずに止める', (t) => {
  const h = harness(t);
  const cwd = canonicalCwd(h.dir);
  const cc = { channelName: 'kt', cwd, repoRoot: cwd };
  const base = { bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F'), baseAllowedTools: ['Read', 'Edit'] };

  const forOther = h.applyIncomingContract({ ...base, claimed: { entry: entryFor('report', REPORT, { cwd, to: 'fable' }), error: null, expected: true } });
  assert.match(forOther.stop, /引き継いだ契約を適用できません\n別の担当宛の契約です/);
  const otherCwd = h.applyIncomingContract({ ...base, claimed: { entry: entryFor('report', REPORT, { cwd: `${cwd}/x` }), error: null, expected: true } });
  assert.match(otherCwd.stop, /別の作業ディレクトリ向けの契約です/);
  const human = h.applyIncomingContract({ ...base, triggerMsg: msgFrom('U1'), claimed: { entry: entryFor('report', REPORT, { cwd }), error: null } });
  assert.match(human.stop, /委譲元からの起動ではありません/);
});

test('applyIncomingContract: 報告と制限なしの委譲は権限を触らずに載せるだけ', (t) => {
  const h = harness(t);
  const cwd = canonicalCwd(h.dir);
  const cc = { channelName: 'kt', cwd, repoRoot: cwd };
  const base = { bot: h.bot, thread: h.thread, cc, triggerMsg: msgFrom('F'), baseAllowedTools: ['Read', 'Edit'] };

  const report = h.applyIncomingContract({ ...base, claimed: { entry: entryFor('report', REPORT, { cwd }), error: null, expected: true } });
  assert.equal(report.kind, 'report');
  assert.deepEqual(report.contract, REPORT);
  assert.equal(report.narrowed, null);
  assert.equal(report.stop, null);
  assert.ok(h.logs.some((l) => l === '[contract] 適用 (report) thread:T1 → opus'), h.logs.join('\n'));

  const open = h.applyIncomingContract({
    ...base,
    claimed: { entry: entryFor('delegation', { ...DELEGATION, touch_restricted: false }, { cwd }), error: null, expected: true },
  });
  assert.equal(open.kind, 'delegation');
  assert.equal(open.narrowed, null);
  assert.ok(h.logs.some((l) => l === '[contract] 適用 (delegation / touch 制限なし) thread:T1 → opus'), h.logs.join('\n'));
});

test('applyIncomingContract: touch 制限つきの委譲は codex では止め、claude では実権限へ絞る', (t) => {
  const h = harness(t);
  const cwd = canonicalCwd(h.dir);
  writeFileSync(join(h.dir, 'a.js'), '// a\n');
  const cc = { channelName: 'kt', cwd, repoRoot: cwd, permissionMode: 'acceptEdits' };
  const claimed = { entry: entryFor('delegation', DELEGATION, { cwd }), error: null, expected: true };
  const base = { thread: h.thread, cc, triggerMsg: msgFrom('F'), baseAllowedTools: ['Read', 'Grep', 'Edit', 'Bash(git *)'] };

  const codex = h.applyIncomingContract({ ...base, bot: { key: 'opus', cfg: { displayName: 'Sol', runtime: 'codex' } }, claimed });
  assert.match(codex.stop, /touch 制限つきの委譲は codex ランタイムの担当へ渡せません/);
  assert.equal(codex.kind, 'delegation', '止めるときも種別と契約は返す (理由の表示に使う)');

  // 外部 settings を読ませない (user settings の permissions.allow で絞り込みが破れる)
  const userDir = tmp(t, 'communitd-claude-home-');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = userDir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });
  const out = h.applyIncomingContract({ ...base, bot: h.bot, claimed });
  if (existsSync(managedPolicyPath())) {
    // この機械に管理者ポリシーがあるなら、存在するだけで touch 制限 job は止まる (Fable 裁定 2026-08-03)
    assert.match(out.stop, /管理者ポリシー/);
    return;
  }
  assert.equal(out.stop, null, out.stop);
  assert.equal(out.kind, 'delegation');
  assert.equal(out.narrowed.permissionMode, 'default', 'acceptEdits を default へ落としていない');
  assert.deepEqual(out.narrowed.rules, ['Edit(./a.js)']);
  assert.ok(out.narrowed.disallowedTools.includes('Bash'), 'Bash を明示的に落としていない');
  assert.equal(out.narrowed.strictMcp, true);
  assert.ok(h.logs.some((l) => l === '[contract] 適用 (touch 制限 1 件) thread:T1 → opus'), h.logs.join('\n'));

  // touch 集合が変換できなければ止める (存在しないファイル)
  const missing = h.applyIncomingContract({
    ...base,
    bot: h.bot,
    claimed: { entry: entryFor('delegation', { ...DELEGATION, touch_set: ['nope.js'] }, { cwd, nonce: 'eeeeeeee00000000' }), error: null, expected: true },
  });
  assert.match(missing.stop, /touch 制限を強制できません/);
  assert.match(missing.stop, /nope\.js/);
});
