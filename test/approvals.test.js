import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalRegistry,
  buildApprovalCard,
  buildCustomId,
  parseCustomId,
} from '../src/approvals.js';
import { canonicalCwd } from '../src/grants.js';

/** grant の cwd は正規形でなければ検証を通らない */
const CWD = canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-cwd-')));
const GRANT = { kind: 'web-domain', tool: 'WebFetch', value: 'docs.example.com', cwd: CWD };
const REQ = {
  guildId: 'G1',
  channelId: 'T1',
  threadId: 'T1',
  botKey: 'opus',
  channelName: 'sandbox',
  grant: GRANT,
  rule: 'WebFetch(domain:docs.example.com)',
};

/** 時刻を進められる台帳 */
function registry(ttlMs = 1000) {
  let clock = 1_000_000;
  const reg = new ApprovalRegistry({ ttlMs, now: () => clock });
  return { reg, advance: (ms) => { clock += ms; } };
}

/** 正規の押下 (差分だけ上書きする) */
const press = (nonce, action, over = {}) => ({
  nonce, action, userId: 'U1', isBot: false, guildId: 'G1', channelId: 'T1',
  messageId: 'M1', botKey: 'opus', isAuthorized: true, ...over,
});

/** 登録してカードのメッセージ ID まで束縛した申請 */
function registered(reg, over = {}) {
  const req = reg.register({ ...REQ, ...over });
  assert.equal(reg.bindMessage(req.nonce, 'M1'), true);
  return req;
}

// ---- customId ----

test('customId は往復し、他機能のボタンは拾わない', () => {
  const id = buildCustomId('allow', 'abc-123');
  assert.deepEqual(parseCustomId(id), { action: 'allow', nonce: 'abc-123' });
  assert.ok(id.length <= 100, 'Discord の customId 上限 (100 字) を超えている');
  for (const bad of ['', null, 'other:allow:x', 'toolperm:evil:x', 'toolperm:allow', 'toolperm:allow:']) {
    assert.equal(parseCustomId(bad), null, `拾ってはいけない: ${bad}`);
  }
});

// ---- 登録 ----

test('妥当でない grant は申請にならない', () => {
  const { reg } = registry();
  for (const bad of [
    undefined, {},
    { kind: 'path-exact', tool: 'Edit', value: 'x', cwd: CWD },
    { kind: 'shell-exact', tool: 'Bash', value: 'npm ci', cwd: CWD }, // shell はもう grant にしない
    { ...GRANT, value: 'localhost' },
    { ...GRANT, cwd: CWD.replaceAll('/', '\\') }, // 非正規形の cwd
  ]) {
    assert.equal(reg.register({ ...REQ, grant: bad }), null, `登録してはいけない: ${JSON.stringify(bad)}`);
  }
  assert.equal(reg.size, 0);
});

test('カードを投稿できなかった申請は撤回できる', () => {
  const { reg } = registry();
  const req = reg.register(REQ);
  assert.equal(reg.size, 1);
  assert.equal(reg.revoke(req.nonce), true);
  assert.equal(reg.size, 0);
  assert.equal(reg.resolve(press(req.nonce, 'allow')).ok, false);
});

// ---- 2 段階承認 ----

test('恒久化は 2 段階、確定は保存後の commit で初めて成立する', () => {
  const { reg } = registry();
  const req = registered(reg);
  assert.equal(reg.resolve(press(req.nonce, 'allow')).stage, 'confirm');
  assert.equal(req.resolved, null, 'allow だけで確定してしまっている');

  assert.equal(reg.resolve(press(req.nonce, 'confirm')).stage, 'pending-save');
  assert.equal(req.resolved, null, 'confirm だけで確定してしまっている (保存前)');

  assert.equal(reg.commit(req.nonce, 'U1'), req);
  assert.equal(req.resolved.action, 'confirm');
});

test('保存が通らず commit しなければ未確定のまま — もう一度確定を押せる', () => {
  const { reg } = registry();
  const req = registered(reg);
  reg.resolve(press(req.nonce, 'allow'));
  reg.resolve(press(req.nonce, 'confirm')); // 保存に失敗した想定
  assert.equal(req.resolved, null);
  assert.equal(reg.resolve(press(req.nonce, 'confirm')).stage, 'pending-save');
});

test('承認を始めた人以外は確定できない', () => {
  const { reg } = registry();
  const req = registered(reg);
  reg.resolve(press(req.nonce, 'allow'));
  assert.equal(reg.resolve(press(req.nonce, 'confirm', { userId: 'U2' })).ok, false);
  assert.equal(req.resolved, null);
});

test('allow を飛ばした confirm は通らない', () => {
  const { reg } = registry();
  const req = registered(reg);
  const r = reg.resolve(press(req.nonce, 'confirm'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /先に/);
});

test('却下は 1 手で確定し、何も許可しない', () => {
  const { reg } = registry();
  const req = registered(reg);
  assert.equal(reg.resolve(press(req.nonce, 'deny')).stage, 'denied');
  assert.equal(req.resolved.action, 'deny');
});

// ---- fail-closed ----

test('未知の nonce は無効 (再起動後の古いボタン)', () => {
  const { reg } = registry();
  assert.match(reg.resolve(press('no-such-nonce', 'confirm')).reason, /無効/);
});

test('期限切れは何も許可しない', () => {
  const { reg, advance } = registry(1000);
  const req = registered(reg);
  reg.resolve(press(req.nonce, 'allow'));
  advance(1001);
  const r = reg.resolve(press(req.nonce, 'confirm'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /期限切れ/);
  assert.equal(req.resolved, null);
});

test('決着済みの再押下は冪等 (二重には効かない)', () => {
  const { reg } = registry();
  const req = registered(reg);
  reg.resolve(press(req.nonce, 'allow'));
  reg.resolve(press(req.nonce, 'confirm'));
  reg.commit(req.nonce, 'U1');
  assert.match(reg.resolve(press(req.nonce, 'confirm')).reason, /すでに承認済み/);
  assert.equal(reg.resolve(press(req.nonce, 'deny')).ok, false, '承認済みを却下で上書きできる');
  assert.equal(req.resolved.action, 'confirm');
});

test('bot・未認可ユーザーは承認できない', () => {
  for (const over of [{ isBot: true }, { isAuthorized: false }]) {
    const { reg } = registry();
    const req = registered(reg);
    assert.equal(reg.resolve(press(req.nonce, 'allow', over)).ok, false);
    assert.equal(req.pendingConfirm, null);
  }
});

test('別の guild / channel / カード / bot からは承認できない (取り違え防止)', () => {
  for (const over of [
    { guildId: 'G2' }, { channelId: 'T9' }, { messageId: 'M9' }, { botKey: 'fable' },
  ]) {
    const { reg } = registry();
    const req = registered(reg);
    const r = reg.resolve(press(req.nonce, 'allow', over));
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(over)}`);
    assert.equal(req.pendingConfirm, null);
  }
});

test('カード ID・bot key が欠けていたら承認しない (fail-open にしない)', () => {
  // 押下側が持っていない
  for (const over of [{ messageId: null }, { messageId: '' }, { botKey: null }]) {
    const { reg } = registry();
    const req = registered(reg);
    assert.equal(reg.resolve(press(req.nonce, 'allow', over)).ok, false,
      `通してはいけない: ${JSON.stringify(over)}`);
  }
  // 申請側に束縛されていない (カード投稿に失敗した申請が残っている場合)
  const { reg } = registry();
  const unbound = reg.register(REQ);
  const r = reg.resolve(press(unbound.nonce, 'allow'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /特定できない/);
});

test('bindMessage は ID を取れなければ束縛しない (呼び出し側が撤回する)', () => {
  const { reg } = registry();
  const req = reg.register(REQ);
  for (const bad of [null, undefined, '', 42]) {
    assert.equal(reg.bindMessage(req.nonce, bad), false, `束縛してはいけない: ${JSON.stringify(bad)}`);
    assert.equal(req.messageId, null);
  }
  assert.equal(reg.bindMessage('no-such-nonce', 'M1'), false);
  assert.equal(reg.bindMessage(req.nonce, 'M1'), true);
});

test('登録後に grant がすり替わっていれば承認しない', () => {
  const { reg } = registry();
  const req = registered(reg);
  req.grant = { ...GRANT, value: 'rm -rf x' }; // 何らかの理由で書き換わった
  const r = reg.resolve(press(req.nonce, 'allow'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /内容が変わっている/);
});

test('別の申請の nonce では別の申請が承認されない', () => {
  const { reg } = registry();
  const a = registered(reg);
  const b = registered(reg, { grant: { ...GRANT, value: 'other.example.com' } });
  reg.resolve(press(a.nonce, 'allow'));
  reg.resolve(press(a.nonce, 'confirm'));
  reg.commit(a.nonce, 'U1');
  assert.equal(b.resolved, null, '別の申請まで確定している');
});

// ---- 掃除 ----

test('sweep は期限切れだけ落とし、決着済みは期限まで残す', () => {
  const { reg, advance } = registry(1000);
  const done = registered(reg);
  reg.resolve(press(done.nonce, 'deny'));
  assert.equal(reg.sweep(), 0);
  advance(1001);
  assert.equal(reg.sweep(), 1);
  assert.equal(reg.get(done.nonce), null);
});

// ---- カード ----

test('申請カードは承認 / 却下のボタンを持ち、customId が nonce に紐づく', () => {
  const { reg } = registry();
  const req = registered(reg);
  const card = buildApprovalCard(req, { stage: 'request' });
  assert.deepEqual(card.components[0].components.map((c) => c.custom_id),
    [buildCustomId('allow', req.nonce), buildCustomId('deny', req.nonce)]);
  assert.match(card.content, /WebFetch\(domain:docs\.example\.com\)/);
  assert.match(card.content, /次の job から/, '反映タイミングを書いていない');
  assert.ok(card.content.length <= 1900);
});

test('カードは許可される範囲を言い切る (押した人が取り違えないため)', () => {
  const { reg } = registry();
  assert.match(buildApprovalCard(registered(reg)).content, /このドメインだけ/);
  // 想定外の kind は「押さないでください」と出す (黙って広い許可に見せない)
  assert.match(buildApprovalCard({ grant: { kind: 'tool' } }).content, /押さないでください/);
  assert.match(buildApprovalCard({ grant: { kind: 'shell-exact' } }).content, /押さないでください/);
});

test('表示の無害化は描画時だけ (保存値には触らない)', () => {
  const { reg } = registry();
  const req = registered(reg, { rule: 'WebFetch(domain:```evil)' });
  const escaped = buildApprovalCard(req, { escape: (s) => s.replaceAll('`', "'") });
  assert.equal(escaped.content.includes('```evil'), false, 'カードの体裁を偽装できる');
  // grant は無加工のまま
  assert.equal(req.grant.value, GRANT.value);
});

test('確認段階では確定ボタンに変わり、決着後はボタンを外す', () => {
  const { reg } = registry();
  const req = registered(reg);
  assert.deepEqual(
    buildApprovalCard(req, { stage: 'confirm' }).components[0].components.map((c) => c.custom_id),
    [buildCustomId('confirm', req.nonce), buildCustomId('deny', req.nonce)],
  );
  for (const stage of ['approved', 'denied', 'invalid']) {
    assert.deepEqual(buildApprovalCard(req, { stage }).components, [], `${stage} にボタンが残っている`);
  }
});

test('失効したカードは中身が無くても描ける', () => {
  const card = buildApprovalCard({ nonce: 'x' }, { stage: 'invalid' });
  assert.match(card.content, /無効/);
  assert.match(card.content, /何も許可していません/);
});

// ---- hook 経路 (job を止めて待つ申請) ----

/** 待機している申請 (register → bindMessage → awaitDecision) */
function waiting(reg, over = {}) {
  const req = registered(reg, { hook: true, waitMs: 180_000, ...over });
  return { req, decided: reg.awaitDecision(req.nonce) };
}

test('hook 経路のカードは 1 タップで確定し、文面も書き分ける', () => {
  const { reg } = registry();
  const req = registered(reg, { hook: true, waitMs: 180_000 });
  const card = buildApprovalCard(req, { stage: 'request' });
  // ボタンは 1 段階目のまま allow だが、ラベルと文面が「押したら続行」を言い切る
  assert.deepEqual(card.components[0].components.map((c) => c.label), ['承認して続行', '却下']);
  assert.match(card.content, /job を止めて待っています/);
  assert.match(card.content, /この job がそのまま続きます/);
  assert.match(card.content, /約 3 分/, '待ち時間を書いていない');
  assert.equal(card.content.includes('次の job から'), false, '既存カードの文面が混ざっている');
  // 待機上限が渡っていない申請では時間を書かない (嘘を書かない)
  assert.equal(buildApprovalCard({ ...req, waitMs: undefined }).content.includes('待つのは'), false);
});

test('hook 経路は allow 1 手で pending-save まで進む (confirm は受けない)', () => {
  const { reg } = registry();
  const req = registered(reg, { hook: true });
  const allow = reg.resolve(press(req.nonce, 'allow'));
  assert.equal(allow.stage, 'pending-save', '2 タップ目を要求している');
  assert.equal(req.pendingConfirm.userId, 'U1', '承認者が保存へ渡らない');
  // 組み立てた customId で confirm を叩かれても経路を増やさない
  const confirm = reg.resolve(press(req.nonce, 'confirm'));
  assert.equal(confirm.ok, false);
  assert.match(confirm.reason, /承認して続行/);
});

test('承認は保存が通ってから (commit) だけが hook へ allow を返す', async () => {
  const { reg } = registry();
  const { req, decided } = waiting(reg);
  assert.equal(reg.resolve(press(req.nonce, 'allow')).stage, 'pending-save');
  // ここではまだ待機は解けない — 保存に失敗したらやり直せる
  assert.equal(reg.waitingCount, 1, '保存前に hook を再開させている');
  reg.commit(req.nonce, 'U1');
  assert.deepEqual(await decided, { decision: 'allow', reason: '承認されました' });
});

test('却下は待っている hook へ deny を返す', async () => {
  const { reg } = registry();
  const { req, decided } = waiting(reg);
  reg.resolve(press(req.nonce, 'deny'));
  assert.equal((await decided).decision, 'deny');
});

test('待機を残したまま申請を消す口を作らない (静かな待機漏れ)', async () => {
  // どれも「Map から消すだけ」だと hook が永久に待ち、その job は二度と進まない
  const cases = {
    revoke: (reg, req) => reg.revoke(req.nonce),
    sweep: (reg, _req, advance) => { advance(1001); reg.sweep(); },
    expire: (reg, req) => reg.expire(req.nonce),
    denyAll: (reg) => reg.denyAll('中断されました'),
  };
  for (const [name, act] of Object.entries(cases)) {
    const { reg, advance } = registry(1000);
    const { req, decided } = waiting(reg);
    act(reg, req, advance);
    const answer = await decided;
    assert.equal(answer.decision, 'deny', `${name} が待機者を残している`);
    assert.ok(answer.reason, `${name} の理由が空`);
    assert.equal(reg.waitingCount, 0, `${name} の後に待機者が残っている`);
  }
});

test('待機上限を過ぎた申請は押しても通らない (job はもう進んでいる)', async () => {
  const { reg } = registry();
  const { req, decided } = waiting(reg);
  reg.expire(req.nonce);
  assert.equal((await decided).decision, 'deny');
  assert.equal(req.resolved.action, 'timeout');
  const pressed = reg.resolve(press(req.nonce, 'allow'));
  assert.equal(pressed.ok, false);
  assert.match(pressed.reason, /上限に達しました/);
  // 却下と取り違えない見出しで描く (誰も押していないのに「却下しました」にしない)
  assert.match(buildApprovalCard(req, { stage: 'expired' }).content, /承認待ちの上限/);
  assert.deepEqual(buildApprovalCard(req, { stage: 'expired' }).components, []);
});

test('期限切れのカードを押したら、待っている hook もそこで畳む', async () => {
  // 待機上限 > カードの寿命 という設定は起動時に落とすが、落とし切れなかったときに
  // 「押した人には期限切れと返しつつ job は待ち続ける」を残さない (sol 指摘)
  const { reg, advance } = registry(1000);
  const { req, decided } = waiting(reg);
  advance(1001);
  const pressed = reg.resolve(press(req.nonce, 'allow'));
  assert.equal(pressed.ok, false);
  assert.match(pressed.reason, /期限切れ/);
  assert.equal((await decided).decision, 'deny');
  assert.equal(reg.waitingCount, 0, '期限切れの押下で待機が残っている');
  // カードには原因を書く (待機上限とは別物)
  assert.match(buildApprovalCard(req, { stage: 'expired' }).content, /期限が切れました/);
});

test('決着済み・不在の申請を待とうとしても hook は止まらない', async () => {
  const { reg } = registry();
  assert.equal((await reg.awaitDecision('no-such-nonce')).decision, 'deny');
  const req = registered(reg, { hook: true });
  reg.resolve(press(req.nonce, 'allow'));
  reg.commit(req.nonce, 'U1');
  assert.equal((await reg.awaitDecision(req.nonce)).decision, 'allow');
  const denied = registered(reg, { hook: true, grant: { ...GRANT, value: 'b.example.com' } });
  reg.resolve(press(denied.nonce, 'deny'));
  assert.equal((await reg.awaitDecision(denied.nonce)).decision, 'deny');
});

test('同じ申請を二重に待たない (どちらが解決されるか不定にしない)', async () => {
  const { reg } = registry();
  const { req, decided } = waiting(reg);
  assert.equal((await reg.awaitDecision(req.nonce)).decision, 'deny', '2 本目が待ちに入っている');
  assert.equal(reg.waitingCount, 1);
  reg.denyAll();
  await decided;
});

test('settle は多重解決しない', async () => {
  const { reg } = registry();
  const { req, decided } = waiting(reg);
  assert.equal(reg.settle(req.nonce, 'deny', '1 回目'), true);
  assert.equal(reg.settle(req.nonce, 'allow', '2 回目'), false);
  assert.equal((await decided).reason, '1 回目');
});
