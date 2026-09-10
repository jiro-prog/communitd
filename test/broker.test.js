import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANS_SUFFIX,
  ASK_SUFFIX,
  ApprovalBroker,
  DEFAULT_APPROVAL_WAIT_MS,
  HOOK_GRACE_MS,
  askFrom,
  createAskLedger,
  decideAsk,
  decisionOutput,
  normalizeAnswer,
  runApprovalHook,
} from '../src/broker.js';
import { canonicalCwd } from '../src/grants.js';

const CWD = canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-cwd-')));
const FETCH = { tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/a' } };
const RULE = 'WebFetch(domain:docs.example.com)';

function dir() {
  return mkdtempSync(join(tmpdir(), 'communitd-broker-'));
}

/** 条件が立つまで待つ (ポーリング層のテストなので実時間で回す) */
async function until(fn, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('条件が成立しないまま打ち切りました');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** ask を 1 件置いて、書かれた応答を待つ */
async function askAndWait(d, ask = FETCH, id = 'a1') {
  writeFileSync(join(d, `${id}${ASK_SUFFIX}`), JSON.stringify(ask), 'utf8');
  const path = join(d, `${id}${ANS_SUFFIX}`);
  await until(() => existsSync(path));
  return JSON.parse(readFileSync(path, 'utf8'));
}

function broker(d, decide, over = {}) {
  return new ApprovalBroker({ dir: d, decide, waitMs: 60_000, pollMs: 10, ...over });
}

// ---- 裁定 (純粋関数) ----

test('素のツール名で許可済みなら聞かない (hook が無くても通る呼び出し)', () => {
  assert.deepEqual(
    decideAsk(FETCH, { cwd: CWD, allowedRules: ['Read', 'WebFetch'] }),
    { decision: 'pass' },
  );
});

test('grant にできない要求は裁かず通常判定へ戻す (hook が無いときより厳しくしない)', () => {
  for (const ask of [
    { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    { tool_name: 'Edit', tool_input: { file_path: 'a.js' } },
    { tool_name: 'WebFetch', tool_input: { url: 'http://insecure.example.com' } }, // https 以外
    { tool_name: 'WebFetch', tool_input: {} },
    { tool_name: '' },
    {},
  ]) {
    assert.deepEqual(
      decideAsk(ask, { cwd: CWD, allowedRules: [] }),
      { decision: 'pass' },
      `裁いてはいけない: ${JSON.stringify(ask)}`,
    );
  }
});

test('全許可モードのチャンネルでは聞かない (どうせ通る呼び出し)', () => {
  assert.deepEqual(
    decideAsk({ ...FETCH, permission_mode: 'bypassPermissions' }, { cwd: CWD, allowedRules: [] }),
    { decision: 'pass' },
  );
  // acceptEdits はファイル編集だけの緩和なので、ここは従来どおり聞く
  assert.equal(
    decideAsk({ ...FETCH, permission_mode: 'acceptEdits' }, { cwd: CWD, allowedRules: [] }).decision,
    'ask',
  );
});

test('ドメイン限定ルールで許可済みでも聞かない', () => {
  assert.deepEqual(decideAsk(FETCH, { cwd: CWD, allowedRules: [RULE] }), { decision: 'pass' });
});

test('承認済み台帳にあれば待たずに allow (job 開始後の承認もその job で効く)', () => {
  const verdict = decideAsk(FETCH, {
    cwd: CWD,
    allowedRules: ['Read'],
    isApproved: (grant) => grant.value === 'docs.example.com',
  });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.rule, RULE);
});

test('許可も承認もされていなければ人間に聞く', () => {
  const verdict = decideAsk(FETCH, { cwd: CWD, allowedRules: ['Read'] });
  assert.equal(verdict.decision, 'ask');
  assert.equal(verdict.rule, RULE);
  assert.equal(verdict.grant.cwd, CWD, 'grant に job の作業ディレクトリが焼き込まれていない');
});

test('作業ディレクトリを解決できないときは聞かない (照合できない承認を作らない)', () => {
  assert.deepEqual(decideAsk(FETCH, { cwd: null, allowedRules: [] }), { decision: 'pass' });
});

// ---- 応答の正規化 ----

test('知らない応答・壊れた応答はすべて deny (fail-closed)', () => {
  for (const value of [null, undefined, {}, { decision: 'ALLOW' }, { decision: 'yes' }, 'allow']) {
    assert.equal(normalizeAnswer(value).decision, 'deny', `deny にならない: ${JSON.stringify(value)}`);
  }
  assert.ok(normalizeAnswer(null).reason, '理由が空だとモデルに何も伝わらない');
});

test('pass は何も出力しない (claude の通常判定へ戻す)', () => {
  assert.equal(decisionOutput({ decision: 'pass' }), null);
  const allow = decisionOutput({ decision: 'allow', reason: 'ok' });
  assert.deepEqual(allow.hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'ok',
  });
  assert.equal(decisionOutput({ decision: 'deny' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('ask には tool_input を丸ごと持たせない (大きすぎる入力は落とす)', () => {
  const big = askFrom('id1', { tool_name: 'WebFetch', tool_input: { url: 'x'.repeat(20_000) } });
  assert.equal(big.tool_input, null);
  const small = askFrom('id1', { ...FETCH, tool_use_id: 'toolu_1', session_id: 's1' });
  assert.equal(small.tool_input.url, 'https://docs.example.com/a');
  assert.equal(small.tool_use_id, 'toolu_1');
});

// ---- ask 台帳 (並行して届く ask の重複と上限) ----

test('ask 台帳: 同じルールは 1 枠だけ・上限を超えたら取れない', () => {
  const ledger = createAskLedger({ max: 2 });
  assert.deepEqual(ledger.reserve('A'), { ok: true });
  assert.deepEqual(ledger.reserve('A'), { ok: false, reason: 'asked' });
  assert.deepEqual(ledger.reserve('B'), { ok: true });
  assert.deepEqual(ledger.reserve('C'), { ok: false, reason: 'limit' });
  // 出せなかったカードの枠は返る (返さないと job 終了後のカードまで抑止される)
  assert.equal(ledger.release('B'), true);
  assert.deepEqual(ledger.reserve('C'), { ok: true });
  assert.equal(ledger.has('C'), true);
  assert.equal(ledger.has('B'), false);
  assert.equal(ledger.size, 2);
});

test('ask 台帳: 並行して届いた ask でもカードは重複せず上限も超えない', async () => {
  // ask は同時に届く。投稿の往復 (await) を挟んでから記録すると、全件が
  // 「まだ聞いていない」と判定されてカードが並ぶ (sol 指摘 2026-08-02)
  const ledger = createAskLedger({ max: 2 });
  const posted = [];
  const flow = async (rule) => {
    const reserved = ledger.reserve(rule);
    if (!reserved.ok) return reserved.reason;
    await new Promise((r) => setTimeout(r, 5)); // カード投稿の往復
    posted.push(rule);
    return 'card';
  };
  const results = await Promise.all([flow('A'), flow('A'), flow('A'), flow('B'), flow('C')]);
  assert.deepEqual(results, ['card', 'asked', 'asked', 'card', 'limit']);
  assert.deepEqual(posted, ['A', 'B'], `カードが重複または上限超過している: ${posted}`);
});

// ---- ブローカ (待機の 4 経路) ----

test('ブローカ: ask を拾って応答を書く', async () => {
  const d = dir();
  const b = broker(d, async () => ({ decision: 'allow', reason: '承認されました' })).start();
  try {
    assert.deepEqual(await askAndWait(d), { decision: 'allow', reason: '承認されました' });
  } finally {
    b.stop();
  }
});

test('ブローカ: 読めない ask は deny (ファイル欠損・破損は fail-closed)', async () => {
  const d = dir();
  let called = 0;
  const b = broker(d, async () => { called++; return { decision: 'allow' }; }).start();
  try {
    writeFileSync(join(d, `bad${ASK_SUFFIX}`), '{壊れた', 'utf8');
    const ans = JSON.parse(await until(() => {
      const p = join(d, `bad${ANS_SUFFIX}`);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    }));
    assert.equal(ans.decision, 'deny');
    assert.equal(called, 0, '読めない要求を裁定へ回している');
  } finally {
    b.stop();
  }
});

test('ブローカ: 待ち上限で deny になり、裁定側へ abort が伝わる', async () => {
  const d = dir();
  let aborted = false;
  const b = broker(d, (_ask, { signal }) => new Promise((resolve) => {
    // 押されないまま上限に達した場合。決着しない Promise を返しても止まらないこと
    signal.addEventListener('abort', () => { aborted = true; });
  }), { waitMs: 60 }).start();
  try {
    const ans = await askAndWait(d);
    assert.equal(ans.decision, 'deny');
    assert.match(ans.reason, /上限/);
    assert.equal(aborted, true, '裁定側に上限を伝えていない (カードが承認待ちのまま残る)');
  } finally {
    b.stop();
  }
});

test('ブローカ: stop で待機中の hook を deny で畳む (job の中断・ブリッジ停止)', async () => {
  const d = dir();
  const b = broker(d, () => new Promise(() => {})).start();
  writeFileSync(join(d, `s1${ASK_SUFFIX}`), JSON.stringify(FETCH), 'utf8');
  await until(() => b.waitingCount === 1);
  b.stop('中断しました');
  const ans = JSON.parse(readFileSync(join(d, `s1${ANS_SUFFIX}`), 'utf8'));
  assert.deepEqual(ans, { decision: 'deny', reason: '中断しました' });
  assert.equal(b.waitingCount, 0);
});

test('ブローカ: 裁定が throw しても deny を返す (hook を待たせ続けない)', async () => {
  const d = dir();
  const b = broker(d, async () => { throw new Error('Discord API error'); }).start();
  try {
    const ans = await askAndWait(d);
    assert.equal(ans.decision, 'deny');
  } finally {
    b.stop();
  }
});

test('ブローカ: 決着した ask を stop が上書きしない (多重解決しない)', async () => {
  const d = dir();
  const b = broker(d, async () => ({ decision: 'allow', reason: '承認されました' })).start();
  await askAndWait(d);
  b.stop('中断しました');
  const ans = JSON.parse(readFileSync(join(d, `a1${ANS_SUFFIX}`), 'utf8'));
  assert.equal(ans.decision, 'allow', '決着済みの応答を上書きしている');
});

test('ブローカ: 同じ ask を二度裁かない', async () => {
  const d = dir();
  let called = 0;
  const b = broker(d, async () => { called++; return { decision: 'deny' }; }).start();
  try {
    await askAndWait(d);
    await new Promise((r) => setTimeout(r, 60)); // tick を数回まわす
    assert.equal(called, 1);
  } finally {
    b.stop();
  }
});

test('ブローカ: stop 後に届いた ask も deny で畳む', async () => {
  const d = dir();
  const b = broker(d, async () => ({ decision: 'allow' })).start();
  b.stop();
  await b.handle(`late${ASK_SUFFIX}`);
  assert.equal(JSON.parse(readFileSync(join(d, `late${ANS_SUFFIX}`), 'utf8')).decision, 'deny');
});

test('ブローカ: 配線漏れは組み立て時に落とす', () => {
  assert.throws(() => new ApprovalBroker({ decide: () => {} }), /dir/);
  assert.throws(() => new ApprovalBroker({ dir: 'x' }), /decide/);
  assert.throws(() => new ApprovalBroker({ dir: 'x', decide: () => {}, waitMs: 0 }), /waitMs/);
});

// ---- hook 側 ----

test('hook: ask を書き、応答が来たら judgement を返す', async () => {
  const d = dir();
  const config = { dir: d, waitMs: 5000, pollMs: 5 };
  const running = runApprovalHook(config, { hook_event_name: 'PreToolUse', ...FETCH });
  // ask が置かれたら、ブリッジ役として応答を書く
  const name = await until(() => readdirSync(d).find((n) => n.endsWith(ASK_SUFFIX)));
  const id = name.slice(0, -ASK_SUFFIX.length);
  writeFileSync(join(d, `${id}${ANS_SUFFIX}`), JSON.stringify({ decision: 'allow', reason: 'ok' }), 'utf8');
  const out = await running;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
});

test('hook: 応答が来なければ deny (ブリッジが落ちても実行させない)', async () => {
  const d = dir();
  let clock = 0;
  const out = await runApprovalHook(
    { dir: d, waitMs: 1000, pollMs: 1 },
    { hook_event_name: 'PreToolUse', ...FETCH },
    { now: () => clock, sleep: async () => { clock += 100; } },
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  // ブリッジ側の上限 (waitMs) を過ぎてから諦める — 先に諦めるとカードが承認待ちのまま残る
  assert.ok(clock >= 1000 + HOOK_GRACE_MS, `早く諦めすぎている: ${clock}ms`);
});

test('hook: 壊れた応答は deny、pass は何も返さない', async () => {
  for (const [ans, expected] of [[{ decision: 'pass' }, null], [{ decision: 'x' }, 'deny']]) {
    const d = dir(); // 前の回の ask を拾わないよう毎回別ディレクトリで測る
    const running = runApprovalHook({ dir: d, waitMs: 5000, pollMs: 5 }, { ...FETCH });
    const name = await until(() => readdirSync(d).find((n) => n.endsWith(ASK_SUFFIX)));
    const id = name.slice(0, -ASK_SUFFIX.length);
    writeFileSync(join(d, `${id}${ANS_SUFFIX}`), JSON.stringify(ans), 'utf8');
    const out = await running;
    assert.equal(out?.hookSpecificOutput?.permissionDecision ?? null, expected);
  }
});

test('hook: 別 event・ツール名なしでは問い合わせない', async () => {
  const d = dir();
  const config = { dir: d, waitMs: 1000, pollMs: 1 };
  assert.equal(await runApprovalHook(config, { hook_event_name: 'PostToolUse', ...FETCH }), null);
  assert.equal(await runApprovalHook(config, { hook_event_name: 'PreToolUse' }), null);
  assert.equal(readdirSync(d).length, 0, '問い合わせないはずが ask を書いている');
});

test('hook: config の書き損じは実行前に落とす', async () => {
  for (const config of [null, {}, { dir: '' }, { dir: 'x' }, { dir: 'x', waitMs: 0 }]) {
    await assert.rejects(() => runApprovalHook(config, FETCH), /承認 hook/);
  }
});

test('既定の待機上限は hook の猶予より十分に長い', () => {
  assert.ok(DEFAULT_APPROVAL_WAIT_MS > HOOK_GRACE_MS * 2);
});
