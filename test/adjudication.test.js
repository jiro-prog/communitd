import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_RATIONALE_CHARS,
  RATIONALE_FIELD,
  applyBotAdjudication,
  buildProcessNotice,
  buildProposalCard,
  buildProposalCustomId,
  buildRationaleModal,
  cardTargets,
  checkProposalBinding,
  formatProposalQueue,
  parseProposalCustomId,
} from '../src/adjudication.js';
import { ProposalStore, digestOf } from '../src/proposals.js';
import { createInteractionHandler } from '../src/interactions.js';
import { POLICY_FILE } from '../src/config.js';

// ---- 材料 ----

const POLICY = {
  limits: { maxBotHops: 3 },
  bots: { fable: {}, opus: {}, sol: {} },
  channels: { observatory: { cwd: '.', toolsExtra: ['Write'] } },
  processEditAllowlist: ['docs/handbook.md'],
};
const policyText = `${JSON.stringify(POLICY, null, 2)}\n`;
const FILES = {
  [POLICY_FILE]: policyText,
  'roles/sol.md': 'sol の憲章\n',
  'docs/handbook.md': '手順\n',
};

function makeDiff(path, before, after) {
  const lines = (t) => (t === null ? [] : t.replace(/\n$/, '').split('\n'));
  const oldLines = lines(before);
  const newLines = lines(after);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`
    + `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
    + `${[...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n')}\n`;
}

function ctxWith({ files = FILES } = {}) {
  return {
    policy: POLICY,
    processEditAllowlist: POLICY.processEditAllowlist,
    checkPath: (p) => ({ ok: true, kind: Object.hasOwn(files, p) ? 'file' : 'missing' }),
    fileExists: (p) => Object.hasOwn(files, p),
    dirExists: (p) => ['roles', 'docs'].includes(p),
    readFile: (p) => files[p] ?? null,
    taskById: () => null,
    openTasks: [],
  };
}

const T0 = Date.parse('2026-08-29T00:00:00.000Z');
const OWNER_ID = 'so-user-id';

const orgInput = (over = {}) => ({
  kind: 'role-edit',
  targets: [{ botKey: 'sol' }],
  duty: 'org-audit',
  summary: 'sol の憲章に検収の観点を足す',
  evidence: ['直近 5 件の差し戻しが同じ観点'],
  remedy: 'role',
  change: { touch: ['roles/sol.md'], diff: makeDiff('roles/sol.md', FILES['roles/sol.md'], 'sol の憲章 (改)\n') },
  benefits: ['観点が揃う'],
  risks: ['文面が長くなる'],
  cost: '小',
  trial: { deadline: '2026-09-30T00:00:00.000Z', successCriteria: '差し戻しが減る', rollback: '前の文面へ戻す' },
  ...over,
});

const processInput = () => orgInput({
  kind: 'process-edit',
  targets: [{ doc: 'docs/handbook.md' }],
  change: { touch: ['docs/handbook.md'], diff: makeDiff('docs/handbook.md', FILES['docs/handbook.md'], '手順 (改)\n') },
});

const store = () => new ProposalStore(join(mkdtempSync(join(tmpdir(), 'communitd-adj-')), 'proposals.json'));

/** 裁定待ちまで進めた提案を 1 件作る */
/** 適用の基点 (org / process の採択には commit OID が要る) */
const BASE_OID = 'a'.repeat(40);

function deliberating(s, input = orgInput(), ctx = ctxWith(), origin = null) {
  const p = s.raise(input, { raisedBy: 'opus', ctx, origin, now: T0 });
  return s.deliberate(p.id, { now: T0 });
}

// ---- customId とカード ----

test('customId は proposal ID と digest に束縛される', () => {
  const id = buildProposalCustomId('accept', '12', 'abcdef0123456789');
  assert.equal(id, 'proposal:accept:12:abcdef0123456789');
  assert.deepEqual(parseProposalCustomId(id), {
    action: 'accept', id: '12', digest: 'abcdef0123456789', decision: 'accepted',
  });
  assert.equal(parseProposalCustomId('proposal:reject:3:d')?.decision, 'rejected');
  assert.ok(id.length <= 100); // Discord の customId 上限

  // 他人のボタン・壊れた形は横取りしない
  for (const bad of ['toolperm:allow:nonce', 'proposal:maybe:12:d', 'proposal:accept:12', '', null]) {
    assert.equal(parseProposalCustomId(bad), null, String(bad));
  }
});

test('カードは押した時点の内容と食い違えば裁定させない', () => {
  const proposal = { id: '1', class: 'org', state: 'deliberating' };
  assert.deepEqual(checkProposalBinding(proposal, { digest: 'd1', currentDigest: 'd1' }), { ok: true });

  const stale = checkProposalBinding(proposal, { digest: 'd1', currentDigest: 'd2' });
  assert.equal(stale.ok, false);
  assert.equal(stale.stage, 'stale');
  // digest を取れなかったときも束縛が成立しない = 押しても通さない
  assert.equal(checkProposalBinding(proposal, { digest: 'd1', currentDigest: null }).stage, 'stale');

  assert.equal(checkProposalBinding(null, { digest: 'd1', currentDigest: 'd1' }).stage, 'gone');
  assert.equal(
    checkProposalBinding({ ...proposal, class: 'work' }, { digest: 'd1', currentDigest: 'd1' }).stage,
    'gone',
  );
  assert.equal(
    checkProposalBinding({ ...proposal, state: 'adjudicated' }, { digest: 'd1', currentDigest: 'd1' }).stage,
    'gone',
  );
});

test('裁定カードは要旨と対象を出し、決着したらボタンを外す', () => {
  const s = store();
  const p = deliberating(s);
  const card = buildProposalCard(p, { digest: 'd1', stage: 'request', ownerMention: `<@${OWNER_ID}>` });

  assert.match(card.content, /組織提案の裁定/);
  assert.match(card.content, new RegExp(`<@${OWNER_ID}>`));
  assert.match(card.content, /role-edit/);
  assert.match(card.content, /role:sol/);
  assert.match(card.content, /roles\/sol\.md/);
  // カードは「採択は即確定・却下は理由が要る」を告げる (So 裁定 2026-08-30)
  assert.match(card.content, /採択は押した時点で確定/);
  assert.match(card.content, /却下は理由の入力欄/);
  assert.equal(card.components.length, 1);
  assert.deepEqual(
    card.components[0].components.map((b) => b.custom_id),
    ['proposal:accept:1:d1', 'proposal:reject:1:d1'],
  );

  for (const stage of ['accepted', 'rejected', 'stale']) {
    assert.deepEqual(buildProposalCard(p, { digest: 'd1', stage }).components, []);
  }
  const gone = buildProposalCard(null, { stage: 'gone', note: 'もう裁定待ちではありません' });
  assert.deepEqual(gone.components, []);
  assert.match(gone.content, /もう裁定待ちではありません/);
});

test('理由モーダルは同じ束縛を持ち、入力を必須にする', () => {
  const modal = buildRationaleModal('reject', '7', 'digest7');
  assert.equal(modal.custom_id, 'proposal:reject:7:digest7');
  assert.ok(modal.title.length <= 45);
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, RATIONALE_FIELD);
  assert.equal(input.required, true);
  assert.equal(input.min_length, 1);
  assert.equal(input.max_length, MAX_RATIONALE_CHARS);
});

test('一覧は裁定待ちを先に出す', () => {
  const s = store();
  const waiting = deliberating(s);
  const text = formatProposalQueue([waiting, { id: '9', class: 'work', state: 'adjudicated', input: { kind: 'check-add', summary: 'テストを足す' }, raisedBy: 'opus' }]);
  assert.match(text, /裁定待ち \(1 件\)/);
  assert.match(text, /#1 \[org\]/);
  assert.match(text, /進行中 \(1 件\)/);
  assert.equal(formatProposalQueue([]), '提案はありません。');
});

test('カードの投稿先はスレッド → 親チャンネル → 代替の順', () => {
  const withThread = { origin: { threadId: 'T1', channelId: 'C1' } };
  assert.deepEqual(cardTargets(withThread, { fallbackChannelId: 'C9' }), ['T1', 'C1', 'C9']);
  assert.deepEqual(cardTargets({ origin: { channelId: 'C1', threadId: null } }), ['C1']);
  // 発議元が分からなければ代替だけ (重複は畳む)
  assert.deepEqual(cardTargets({}, { fallbackChannelId: 'C9' }), ['C9']);
  assert.deepEqual(cardTargets({ origin: { threadId: 'C9', channelId: null } }, { fallbackChannelId: 'C9' }), ['C9']);
});

// ---- bot の構造化裁定 ----

test('work / process は bot の構造化出力から裁定できる', () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, processInput(), ctx);

  const applied = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'accepted', rationale: '手順の明確化に賛成' } },
    { botKey: 'fable', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], baseCommit: BASE_OID, now: T0 },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.proposal.state, 'adjudicated');
  assert.equal(applied.proposal.decision, 'accepted');
  // process の裁定は So へ事後通知する
  assert.equal(applied.notifyOwner, true);
  assert.match(applied.note, /採択しました/);

  const notice = buildProcessNotice(applied.proposal);
  assert.match(notice, /process 提案 #1 を採択しました/);
  assert.match(notice, /手順の明確化に賛成/);
});

test('bot は org を裁定できない (ゲートは canAdjudicate の 1 本)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);

  const applied = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'accepted', rationale: '通したい' } },
    { botKey: 'fable', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], now: T0 },
  );
  assert.equal(applied.ok, false);
  assert.match(applied.note, /裁定権がありません/);
  assert.equal(s.get(p.id).state, 'deliberating');
});

test('裁定を任されていない bot は work も通せない', () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, processInput(), ctx);
  const applied = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'accepted', rationale: '通したい' } },
    { botKey: 'opus', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], now: T0 },
  );
  assert.equal(applied.ok, false);
  assert.equal(s.get(p.id).state, 'deliberating');
});

test('裁定は適用の基点を snapshot へ焼く (bot 経路)', () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, processInput(), ctx);

  const applied = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'accepted', rationale: 'ok' } },
    { botKey: 'fable', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], baseCommit: BASE_OID, now: T0 },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.proposal.revisions.at(-1).snapshot.external.baseCommit, BASE_OID);
});

test('基点が無ければ採択できない (却下はできる)', () => {
  const ctx = ctxWith();
  // **基点の無い accepted は誰も動かせなくなる** — 適用は「基点が無い」で止まり、
  // 再裁定は deliberating からしか通らないので、取り下げるしか出口が無い
  const s = store();
  const p = deliberating(s, processInput(), ctx);
  const noBase = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'accepted', rationale: 'ok' } },
    { botKey: 'fable', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], now: T0 },
  );
  assert.equal(noBase.ok, false);
  assert.match(noBase.note, /適用の基点が無いので採択できません/);
  assert.equal(s.get(p.id).state, 'deliberating');

  // 却下は当てないので基点は要らない
  const rejected = applyBotAdjudication(
    { adjudication: { proposal_id: p.id, decision: 'rejected', rationale: '見送り' } },
    { botKey: 'fable', store: s, ctx, ownerUserId: OWNER_ID, execBotKeys: ['fable'], now: T0 },
  );
  assert.equal(rejected.ok, true);
  assert.equal(s.get(p.id).decision, 'rejected');
});

test('裁定機構が無ければ何もしない', () => {
  assert.deepEqual(applyBotAdjudication({}, {}), { ok: false, note: '' });
  const off = applyBotAdjudication({ adjudication: { proposal_id: '1', decision: 'accepted', rationale: 'x' } }, {});
  assert.equal(off.ok, false);
  assert.match(off.note, /配線されていません/);
});

// ---- interaction の配線 ----

const CONFIG = { guildId: 'G1', allowedUserIds: [OWNER_ID, 'U2'] };

/** 裁定 UI に要る分だけの最小 harness (停止・再起動系は使わない) */
function uiHarness({
  proposals, ctx = ctxWith(), redeliverProposal = null,
  // 既定で基点は読める (読めない配備の挙動は専用のテストで見る)
  resolveBaseCommit = async () => BASE_OID,
} = {}) {
  const log = [];
  const handler = createInteractionHandler({
    config: CONFIG,
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'observatory' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    proposals,
    proposalContext: () => ctx,
    ownerUserId: OWNER_ID,
    execBotKeys: ['fable'],
    redeliverProposal,
    resolveBaseCommit,
  });

  const message = { edit: async (p) => log.push(`edit:${text(p)}`) };
  function text(payload) {
    return typeof payload === 'string' ? payload : (payload?.content ?? '');
  }
  const button = ({ customId, userId = OWNER_ID, rationale = null, failAck = false }) => ({
    customId,
    guildId: 'G1',
    channelId: 'T1',
    user: { id: userId },
    message,
    isButton: () => rationale === null,
    isModalSubmit: () => rationale !== null,
    isChatInputCommand: () => false,
    inGuild: () => true,
    fields: { getTextInputValue: () => rationale },
    showModal: async (m) => log.push(`modal:${m.custom_id}`),
    deferUpdate: async () => {
      log.push('deferUpdate');
      if (failAck) throw new Error('Unknown interaction');
    },
    update: async (p) => log.push(`update:${text(p)}`),
    followUp: async (p) => log.push(`followUp:${text(p)}`),
    reply: async (p) => log.push(`reply:${text(p)}`),
  });
  const command = ({ id = null, withdraw = null, userId = OWNER_ID } = {}) => ({
    commandName: 'proposals',
    guildId: 'G1',
    channelId: 'T1',
    user: { id: userId },
    channel: { id: 'T1', isThread: () => true },
    // option 名で引き分ける (id と withdraw を同時に受ける)
    options: { getString: (name) => (name === 'withdraw' ? withdraw : id), getBoolean: () => null },
    isButton: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    inGuild: () => true,
    deferReply: async () => log.push('defer'),
    editReply: async (p) => log.push(`edit:${text(p)}`),
    reply: async (p) => log.push(`reply:${text(p)}`),
  });
  return { handler, log, button, command };
}

test('カード経路も適用の基点を snapshot へ焼く (ACK の後で解決する)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const base = 'b'.repeat(40);
  const { handler, log, button } = uiHarness({
    proposals: s,
    ctx,
    resolveBaseCommit: async () => {
      log.push('resolveBaseCommit');
      return base;
    },
  });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}` }));

  assert.equal(s.get(p.id).revisions.at(-1).snapshot.external.baseCommit, base);
  // git を読むのは 3 秒の期限から降りた後 (ACK が先)
  assert.equal(log[0], 'deferUpdate');
  assert.equal(log[1], 'resolveBaseCommit');
});

test('基点を読めなければ採択させない (カード経路)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({
    proposals: s,
    ctx,
    resolveBaseCommit: async () => { throw new Error('master が無い'); },
  });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}` }));

  // 裁定待ちのまま。設定を直せば同じカードから押し直せる
  assert.equal(s.get(p.id).state, 'deliberating');
  assert.match(log.at(-1), /適用の基点が無いので採択できません/);
});

test('採択は押した時点で確定する (理由を聞かない)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}` }));

  const after = s.get(p.id);
  assert.equal(after.state, 'adjudicated');
  assert.equal(after.decision, 'accepted');
  assert.equal(after.adjudication.rationale, '');
  assert.equal(after.adjudication.by, `owner:${OWNER_ID}`);
  assert.equal(log.some((l) => l.startsWith('modal:')), false, 'モーダルを出している');
  // **ACK が先。** 永続化とカードの描き直しを待ってから ACK すると、3 秒を超えたときに
  // 裁定は確定しているのに Discord は「操作に失敗」と出す
  assert.equal(log[0], 'deferUpdate');
  assert.match(log[1], /^edit:.*採択しました/);
  assert.match(log[2], /^followUp:.*✅ 採択しました/);
});

test('ACK が通らなければ裁定しない (応答できないまま確定させない)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}`, failAck: true }));

  // 裁定していない = カードはボタンごと残るので、押し直せばやり直せる
  assert.equal(s.get(p.id).state, 'deliberating');
  assert.equal(s.get(p.id).decision, null);
  assert.deepEqual(log, ['deferUpdate'], 'カードの描き直しや通知まで進んでいる');
});

test('却下は理由モーダルが出る (押した時点では確定しない)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({ customId: `proposal:reject:${p.id}:${digest}` }));
  assert.deepEqual(log, [`modal:proposal:reject:${p.id}:${digest}`]);
  assert.equal(s.get(p.id).state, 'deliberating');
});

test('owner でなければモーダルも出ない', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}`, userId: 'U2' }));
  assert.equal(log.length, 1);
  assert.match(log[0], /^reply:.*作者 \(ownerUserId\) だけ/);
});

test('内容が変わったカードは裁定せず、最新版を出し直す', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:古いdigest` }));
  assert.equal(log.length, 2);
  assert.match(log[0], /^update:.*出し直しました/);
  assert.match(log[1], /^followUp:.*組織提案の裁定/);
  assert.equal(s.get(p.id).state, 'deliberating'); // 何も裁定していない
});

test('理由を送ると裁定が確定し、カードが決着済みに変わる', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({
    customId: `proposal:reject:${p.id}:${digest}`,
    rationale: '今期は人を増やさない',
  }));

  const after = s.get(p.id);
  assert.equal(after.state, 'adjudicated');
  assert.equal(after.decision, 'rejected');
  assert.equal(after.adjudication.rationale, '今期は人を増やさない');
  assert.equal(after.adjudication.by, `owner:${OWNER_ID}`);
  // 却下経路も同じ順序 (ACK → カードの描き直し → 本人への通知)
  assert.equal(log[0], 'deferUpdate');
  assert.match(log[1], /^edit:.*却下しました/);
  assert.match(log[2], /^followUp:.*🚫 却下しました/);
});

test('却下の理由が空なら裁定は通らない (store 側で必須)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, button({
    customId: `proposal:reject:${p.id}:${digest}`,
    rationale: '   ',
  }));
  assert.equal(s.get(p.id).state, 'deliberating');
  // 落ちる場合も ACK は済ませてから理由を返す (期限切れで無言にならない)
  assert.equal(log[0], 'deferUpdate');
  assert.match(log[1], /^followUp:.*却下には理由が要ります/);
});

test('/proposals は一覧を出し、id 指定でカードを出し直す', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const { handler, log, command } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, command());
  assert.match(log.at(-1), /裁定待ち \(1 件\)/);

  await handler({ key: 'fable' }, command({ id: p.id }));
  assert.match(log.at(-1), /組織提案の裁定/);

  await handler({ key: 'fable' }, command({ id: '404' }));
  assert.match(log.at(-1), /見つかりません/);

  // ACK 済みの経路でも応答が消えない (reply ではなく editReply で返す)
  await handler({ key: 'fable' }, command({ id: p.id, userId: 'U2' }));
  assert.match(log.at(-1), /^edit:.*作者 \(ownerUserId\) だけ/);
});

test('/proposals <id> は work / process の裁定を配り直す (押せるカードが無いので)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, processInput(), ctx);
  const asked = [];
  const { handler, log, command } = uiHarness({
    proposals: s,
    ctx,
    redeliverProposal: async (id) => {
      asked.push(id);
      return { ok: true, reason: `提案 #${id} (process) の裁定依頼を出し直しました` };
    },
  });

  await handler({ key: 'fable' }, command({ id: p.id }));
  assert.deepEqual(asked, [p.id], '配り直しを呼んでいない');
  assert.match(log.at(-1), /裁定依頼を出し直しました/);

  // 配れなかったときは理由を返す (黙って「出した」ことにしない)
  const failing = uiHarness({
    proposals: s,
    ctx,
    redeliverProposal: async () => ({ ok: false, reason: '裁定できる bot が起動していません' }),
  });
  await failing.handler({ key: 'fable' }, failing.command({ id: p.id }));
  assert.match(failing.log.at(-1), /⚠️.*起動していません/);

  // 配線されていなければそう言う (黙って何もしない状態を作らない)
  const unwired = uiHarness({ proposals: s, ctx });
  await unwired.handler({ key: 'fable' }, unwired.command({ id: p.id }));
  assert.match(unwired.log.at(-1), /配線されていません/);
});

test('/proposals id:<n> withdraw:<理由> で提案を閉じられる (再裁定で閉じられない提案の出口)', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const { handler, log, command } = uiHarness({ proposals: s, ctx });

  await handler({ key: 'fable' }, command({ id: p.id, withdraw: '手で転記済み (暫定運用)' }));

  const closed = s.get(p.id);
  assert.equal(closed.state, 'withdrawn');
  assert.equal(closed.history.at(-1).note, '手で転記済み (暫定運用)', '理由が履歴に残っていない');
  assert.equal(closed.history.at(-1).by, `owner:${OWNER_ID}`);
  assert.match(log.at(-1), /🗑 提案 #.*を取り下げました: 手で転記済み/);

  // 二度目は断る (終端からは動かせないことを、状態を添えて返す)
  await handler({ key: 'fable' }, command({ id: p.id, withdraw: 'もう一度' }));
  assert.match(log.at(-1), /既に閉じています \(withdrawn\)/);
});

test('取り下げは owner だけ・id が要る・適用中は断る', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const { handler, log, command } = uiHarness({ proposals: s, ctx });

  // owner 以外は裁定と同じ門で止まる (取り下げも終端を作る操作なので同じ扱い)
  await handler({ key: 'fable' }, command({ id: p.id, withdraw: '閉じたい', userId: 'U2' }));
  assert.match(log.at(-1), /作者 \(ownerUserId\) だけ/);
  assert.equal(s.get(p.id).state, 'deliberating');

  // 理由だけでは対象が決まらない。一覧を返して黙って流さない
  await handler({ key: 'fable' }, command({ withdraw: '閉じたい' }));
  assert.match(log.at(-1), /取り下げる提案の id も指定してください/);
  assert.equal(s.get(p.id).state, 'deliberating');

  // 適用中 (錠が掛かっている) は断る — 閉じると適用タスクと作業ツリーが宛先を失う。
  // 錠は applyTaskId で表される (linkTask を通したのと同じ形を直に置く)
  s.write(p.id, { ...s.get(p.id), applyTaskId: '7' });
  await handler({ key: 'fable' }, command({ id: p.id, withdraw: '閉じたい' }));
  assert.match(log.at(-1), /適用中です \(タスク #7\)/);
  assert.equal(s.get(p.id).state, 'deliberating');
});

test('発議機構が無効なら裁定 UI は何も受けない', async () => {
  const { handler, log, button, command } = uiHarness({ proposals: null });
  await handler({ key: 'fable' }, button({ customId: 'proposal:accept:1:d' }));
  await handler({ key: 'fable' }, command());
  assert.equal(log.filter((l) => /無効です/.test(l)).length, 2);
});

test('モーダル送信の時点で内容が変わっていても、そこで出し直す', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const { handler, log, button } = uiHarness({ proposals: s, ctx });

  // 押した後・理由を書いている間に前提が動いた状況 (custom ID の digest が古い)
  await handler({ key: 'fable' }, button({
    customId: `proposal:accept:${p.id}:古いdigest`,
    rationale: '通したい',
  }));

  assert.equal(s.get(p.id).state, 'deliberating', 'モーダル経路で裁定してしまっている');
  assert.match(log[0], /^update:.*出し直しました/);
  assert.match(log[1], /^followUp:.*組織提案の裁定/);
});

test('カードを出した後に反論が付いたら、そのカードでは裁定できない', async () => {
  const ctx = ctxWith();
  const s = store();
  const p = deliberating(s, orgInput(), ctx);
  const digest = digestOf(p, ctx); // カードを出した時点の指紋
  s.addPosition(p.id, { by: 'sol', stance: 'contest', rationale: '兼務で足りる', now: T0 });

  const { handler, log, button } = uiHarness({ proposals: s, ctx });
  await handler({ key: 'fable' }, button({ customId: `proposal:accept:${p.id}:${digest}` }));

  assert.equal(s.get(p.id).state, 'deliberating', '反論を読まないまま採択できてしまっている');
  assert.match(log[0], /^update:.*出し直しました/);
  assert.match(log[1], /反論 1/); // 出し直したカードには反論が出ている
});
