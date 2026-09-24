import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceptClaim, acceptVerification, addDependency, addFinding, adoptFinding, cancelAction,
  closeCase, createChildCase, createObservation, createRoleTrial, expireClaim, handOverClaim,
  linkCase, markAccepted, markReconcile, markRunning, markSending, markSent, nextId, offerClaim,
  planAction, reconcileActions, registerMandate, rejectVerification, releaseClaim, resumeCase,
  resumeFromWaiting, settleAction, stopCase, validateSnapshot,
} from '../src/cases.js';
import { emptySnapshot } from '../src/society-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-09-07T09:00:00.000Z');
const MIN = 60 * 1000;

/** 成功を期待する呼び出し。落ちたら理由を出す (どの遷移で止まったか分かるように) */
function ok(result, label = '') {
  assert.equal(result.ok, true, `${label}: ${result.code} ${result.reason ?? ''}`);
  assert.deepEqual(validateSnapshot(result.snapshot), [], `${label}: 保存できない形になった`);
  return result;
}

/** Mandate 1 件と `open` の Case 1 件を持つところまで */
function seed({ now = T0, mandateState = 'active', episodeId = 'ep-1', allocated = null } = {}) {
  let s = emptySnapshot(now);
  s = ok(registerMandate(s, { key: 'quality', version: 3, state: mandateState }, now), 'mandate').snapshot;
  const finding = ok(addFinding(s, {
    mandateId: 'M-1',
    expected: 'verify が緑のまま',
    actual: 'verify NG が続いている',
    source: { kind: 'duty' },
    subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId },
  }, now), 'finding');
  s = finding.snapshot;
  const adopted = adoptFinding(s, {
    findingId: finding.findingId,
    desiredOutcome: 'verify を緑に戻す',
    acceptance: { condition: 'npm test が全通過する', version: 1 },
    ...(allocated ? { budget: { allocated } } : {}),
  }, now);
  return { snapshot: adopted.snapshot, caseId: adopted.caseId, findingId: finding.findingId, adopted };
}

/** owner を立てて最初の Action を planned にする */
function withOwner(snapshot, caseId, { botKey = 'opus', now = T0, kind = 'investigate' } = {}) {
  const offered = ok(offerClaim(snapshot, { caseId, responsibility: 'owner', botKey }, now), 'offer');
  const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, {
    plan: { claimId: offered.claimId, kind, target: { channel: 'yobidashi-dev' } },
  }, now), 'accept');
  return { snapshot: accepted.snapshot, claimId: offered.claimId, actionId: accepted.actionId };
}

/** planned → settled まで走らせる (成果物あり = 検収へ) */
function runAction(snapshot, actionId, { now = T0, result = { artifact: 'commit-abc' } } = {}) {
  let s = ok(markSending(snapshot, actionId, {}, now), 'sending').snapshot;
  s = ok(markSent(s, actionId, { messageId: `m-${actionId}` }, now), 'sent').snapshot;
  s = ok(markAccepted(s, actionId, { runId: `run-${actionId}` }, now), 'accepted').snapshot;
  s = ok(markRunning(s, actionId, now), 'running').snapshot;
  return ok(settleAction(s, actionId, { result }, now), 'settle').snapshot;
}

function resolveWholeCase(snapshot, caseId, { worker = 'opus', assessor = 'opus2', now = T0 } = {}) {
  const owned = withOwner(snapshot, caseId, { botKey: worker, now, kind: 'implement' });
  const settled = runAction(owned.snapshot, owned.actionId, { now });
  return ok(acceptVerification(settled, {
    caseId,
    assessor: { botKey: assessor, runId: 'run-verify', modelId: 'claude-opus-5' },
    acceptanceVersion: 1,
    subjectRevision: 'abc1234',
    observed: { tests: '全通過' },
  }, now), 'verify').snapshot;
}

// ---- 純粋であること ----

test('cases: I/O も時計も持たない (now は引数)', () => {
  // コメントは落として、実際のコードだけを見る (JSDoc は「なぜ持たないか」を書いているので当たる)
  const source = readFileSync(resolve(ROOT, 'src/cases.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\n]*\/\/[^\n]*$/gm, '');
  assert.equal(/Date\.now\(/.test(source), false, 'cases.js に Date.now() がある');
  assert.equal(/from 'node:/.test(source), false, 'cases.js が node: の組み込みを読んでいる');
  assert.equal(/require\(/.test(source), false);
  // 入力のスナップショットは書き換えない (呼び出し側が古い版を持ったままでいられる)
  const { snapshot, caseId } = seed();
  const before = structuredClone(snapshot);
  withOwner(snapshot, caseId);
  assert.deepEqual(snapshot, before);
});

test('cases: ID は種別ごとに単調で再利用しない', () => {
  let s = emptySnapshot(T0);
  const first = nextId(s, 'C');
  assert.equal(first.id, 'C-1');
  const second = nextId(first.snapshot, 'C');
  assert.equal(second.id, 'C-2');
  // 別種別は別カウンタ (C-2 と CL-2 は衝突しない)
  assert.equal(nextId(second.snapshot, 'CL').id, 'CL-1');
  assert.throws(() => nextId(s, 'X'), /未知の ID 接頭辞/);
  // counters が採番済みより小さいスナップショットは保存できない
  s = second.snapshot;
  s.cases['C-2'] = { id: 'C-2', state: 'closed', closeReason: 'unnecessary', findingIds: [], dependencies: [], links: [] };
  s.counters.C = 1;
  assert.ok(validateSnapshot(s).some((e) => e.includes('再利用')));
});

// ---- C02: 原因・diff・touch 未確定の Finding から調査 Case が始まる ----

test('C02: 原因も diff も touch も無い Finding から open の Case が作れる', () => {
  const { snapshot, caseId, adopted } = seed();
  ok(adopted, 'adopt');
  const target = snapshot.cases[caseId];
  assert.equal(target.state, 'open');
  assert.equal(target.owner, null);
  assert.deepEqual(target.findingIds, ['F-1']);
  assert.equal(snapshot.findings['F-1'].disposition, 'adopted');
  assert.equal(snapshot.findings['F-1'].caseId, caseId);
  // **編集先を仮入力していない** — 原因が分かる前の値を既定として置かない
  for (const key of ['touch', 'files', 'diff', 'patch']) {
    assert.equal(Object.hasOwn(target, key), false, `Case に ${key} がある`);
  }
  assert.equal(/"(touch|diff|files)"/.test(JSON.stringify(target)), false);
  // 次の契機は「誰かが引き受ける」— 責任の空白のまま放置しない
  assert.equal(target.nextTrigger.kind, 'waiting');
  assert.equal(target.nextTrigger.reason, 'offer');
  assert.equal(target.nextTrigger.nextCheckAt, new Date(T0 + 5 * MIN).toISOString());
});

test('C02: 同じ事象キーの Finding は既存の未終結 Case へ追記する (新しい Case を作らない)', () => {
  const { snapshot, caseId } = seed();
  const again = ok(addFinding(snapshot, {
    mandateId: 'M-1',
    expected: 'verify が緑のまま',
    actual: 'まだ NG',
    source: { kind: 'duty' },
    subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId: 'ep-1' },
  }, T0 + MIN), 'finding2');
  const adopted = ok(adoptFinding(again.snapshot, {
    findingId: again.findingId,
    desiredOutcome: '別の書き方',
    acceptance: { condition: '別', version: 1 },
  }, T0 + MIN), 'adopt2');
  assert.equal(adopted.appended, true);
  assert.equal(adopted.caseId, caseId);
  assert.equal(Object.keys(adopted.snapshot.cases).length, 1);
  assert.deepEqual(adopted.snapshot.cases[caseId].findingIds, ['F-1', 'F-2']);

  // episode が変われば新しい Case (解消の後に同条件で再発したとき)
  const other = ok(addFinding(adopted.snapshot, {
    mandateId: 'M-1',
    expected: 'verify が緑のまま',
    actual: '再発した',
    source: { kind: 'duty' },
    subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId: 'ep-2' },
  }, T0 + 2 * MIN), 'finding3');
  const fresh = ok(adoptFinding(other.snapshot, {
    findingId: other.findingId,
    desiredOutcome: '再発を止める',
    acceptance: { condition: '再発しない', version: 1 },
  }, T0 + 2 * MIN), 'adopt3');
  assert.equal(fresh.appended, false);
  assert.equal(Object.keys(fresh.snapshot.cases).length, 2);
});

test('C02: Mandate が active でなければ Case を開かない', () => {
  for (const state of ['suspended', 'ended']) {
    let s = emptySnapshot(T0);
    s = registerMandate(s, { key: 'quality', version: 1, state }, T0).snapshot;
    const finding = addFinding(s, {
      mandateId: 'M-1', expected: 'a', actual: 'b',
      source: { kind: 'report' }, subject: { subjectId: 's', conditionId: 'c', episodeId: 'e' },
    }, T0);
    const out = adoptFinding(finding.snapshot, {
      findingId: finding.findingId, desiredOutcome: 'd', acceptance: { condition: 'c', version: 1 },
    }, T0);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'mandate-not-active');
    assert.deepEqual(out.snapshot.cases, {});
  }
});

// ---- C03: 引渡しは受諾で成立し、分割後も親の成果責任が残る ----

test('C03 (1) 未受諾: 申し出だけでは責任は移らず、次の契機は waiting(offer)', () => {
  const { snapshot, caseId } = seed();
  const offered = ok(offerClaim(snapshot, { caseId, responsibility: 'owner', botKey: 'opus' }, T0), 'offer');
  const target = offered.snapshot.cases[caseId];
  assert.equal(target.state, 'open');
  assert.equal(target.owner, null);
  assert.equal(offered.snapshot.claims[offered.claimId].state, 'offered');
  assert.equal(offered.snapshot.claims[offered.claimId].generation, 0);
  assert.deepEqual(target.nextTrigger.kind, 'waiting');
  assert.equal(target.nextTrigger.reason, 'offer');

  // 受諾で Case を動かすなら、最初の Action を同じ update で渡す
  const noPlan = acceptClaim(offered.snapshot, offered.claimId, {}, T0);
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.code, 'plan-required');
  // 期限切れの申し出は受諾できない
  const late = acceptClaim(offered.snapshot, offered.claimId, {
    plan: { claimId: offered.claimId, kind: 'investigate' },
  }, T0 + 6 * MIN);
  assert.equal(late.ok, false);
  assert.equal(late.code, 'expired');
  assert.equal(late.snapshot.cases[caseId].owner, null);
});

test('C03 (2) 二人同時受諾: 先に保存した方が勝ち、二人目は理由付きで declined', () => {
  const { snapshot, caseId } = seed();
  const a = ok(offerClaim(snapshot, { caseId, responsibility: 'owner', botKey: 'opus' }, T0), 'offer-a');
  const b = ok(offerClaim(a.snapshot, { caseId, responsibility: 'owner', botKey: 'fable' }, T0), 'offer-b');

  const first = ok(acceptClaim(b.snapshot, a.claimId, {
    plan: { claimId: a.claimId, kind: 'investigate' },
  }, T0), 'accept-a');
  const second = acceptClaim(first.snapshot, b.claimId, {
    plan: { claimId: b.claimId, kind: 'investigate' },
  }, T0);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'occupied');
  assert.match(second.reason, /accepted は同時 1 件/);
  assert.equal(second.snapshot.claims[b.claimId].state, 'declined');
  assert.ok(second.snapshot.claims[b.claimId].reason.includes(a.claimId));
  // 責任主体は一意 (accepted は 1 件・generation は 1)
  const target = second.snapshot.cases[caseId];
  assert.equal(target.owner, a.claimId);
  assert.equal(target.state, 'active');
  assert.equal(second.snapshot.claims[a.claimId].generation, 1);
  assert.deepEqual(target.nextTrigger, { kind: 'nextAction', actionId: 'A-1' });
  assert.deepEqual(validateSnapshot(second.snapshot), []);

  // 手で 2 件目を accepted にしたスナップショットは保存できない
  const forged = structuredClone(second.snapshot);
  forged.claims[b.claimId].state = 'accepted';
  assert.ok(validateSnapshot(forged).some((e) => e.includes('accepted が 2 件')));
});

test('C03 (3) 辞退: Case は waiting(offer) に戻り、予約した action は取り消して枠を返す', () => {
  const { snapshot, caseId } = seed({ allocated: 4 });
  const owned = withOwner(snapshot, caseId);
  assert.equal(owned.snapshot.cases[caseId].budget.reserved, 1);

  const released = ok(releaseClaim(owned.snapshot, owned.claimId, '手が離せない', T0 + MIN), 'release');
  const target = released.snapshot.cases[caseId];
  assert.equal(released.snapshot.claims[owned.claimId].state, 'released');
  assert.equal(target.owner, null);
  assert.equal(target.state, 'waiting');
  assert.equal(target.nextTrigger.reason, 'offer');
  assert.equal(released.snapshot.actions[owned.actionId].state, 'cancelled');
  assert.deepEqual(target.budget, { allocated: 4, reserved: 0, charged: 0 });

  // 次の担当が accepted になれば active へ戻る (世代は +1)
  const next = withOwner(released.snapshot, caseId, { botKey: 'fable', now: T0 + 2 * MIN });
  assert.equal(next.snapshot.cases[caseId].state, 'active');
  assert.equal(next.snapshot.claims[next.claimId].generation, 2);
});

test('C03 (4) 担当消失: 外に出た action は取り消さず reconcile へ倒し、責任は空けない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;

  const gone = ok(expireClaim(s, owned.claimId, 'bot が居なくなった', T0 + 3 * MIN), 'expire');
  assert.equal(gone.snapshot.claims[owned.claimId].state, 'expired');
  // **生きた job を再実行しない** — 送ってしまったものは照合へ回す
  assert.equal(gone.snapshot.actions[owned.actionId].state, 'reconcile');
  const target = gone.snapshot.cases[caseId];
  assert.equal(target.owner, null);
  assert.equal(target.state, 'waiting');
  assert.equal(target.nextTrigger.reason, 'offer');
});

test('C03 (5) 親子分割: 親の owner は残り、子が resolved でも親は自動で resolved にならない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId, { botKey: 'fable' });
  const child = ok(createChildCase(owned.snapshot, caseId, {
    desiredOutcome: '先に lint を直す',
    acceptance: { condition: 'lint が 0 件', version: 1 },
  }, T0), 'child');

  const parent = child.snapshot.cases[caseId];
  assert.equal(parent.owner, owned.claimId);
  assert.deepEqual(parent.childIds, [child.caseId]);
  assert.equal(child.snapshot.cases[child.caseId].parentId, caseId);
  // 子は自分の事象キーを持たない (次の Finding の追記先が割れないように)
  assert.equal(child.snapshot.cases[child.caseId].eventKey, null);

  const done = resolveWholeCase(child.snapshot, child.caseId, { worker: 'opus', assessor: 'opus2' });
  assert.equal(done.cases[child.caseId].state, 'resolved');
  // 親は動かない (親の検収は親の acceptance で別に行う)
  assert.equal(done.cases[caseId].state, 'active');
  assert.equal(done.cases[caseId].owner, owned.claimId);
  assert.equal(done.cases[caseId].resolution, null);
  // **次の契機も子の完了では動かない** — 親は自分の action を追ったままでいる
  assert.deepEqual(done.cases[caseId].nextTrigger, { kind: 'nextAction', actionId: owned.actionId });
  assert.deepEqual(done.cases[caseId].nextTrigger, child.snapshot.cases[caseId].nextTrigger);
  assert.deepEqual(validateSnapshot(done), []);
});

test('C03 (6) 循環依存: A→B→A も A→B→C→A も登録できず、保存もできない', () => {
  const { snapshot, caseId } = seed();
  let s = snapshot;
  const ids = [caseId];
  for (const outcome of ['二番目', '三番目']) {
    const child = ok(createChildCase(s, caseId, {
      desiredOutcome: outcome, acceptance: { condition: 'c', version: 1 },
    }, T0), 'child');
    s = child.snapshot;
    ids.push(child.caseId);
  }
  const [a, b, c] = ids;

  s = ok(addDependency(s, a, { caseId: b, condition: 'resolved' }, T0), 'dep a→b').snapshot;
  const back = addDependency(s, b, { caseId: a, condition: 'resolved' }, T0);
  assert.equal(back.ok, false);
  assert.equal(back.code, 'cycle');
  assert.match(back.reason, /循環/);
  // 断ったときは何も足さない
  assert.deepEqual(back.snapshot.cases[b].dependencies, []);

  s = ok(addDependency(s, b, { caseId: c, condition: 'artifact-ready' }, T0), 'dep b→c').snapshot;
  const long = addDependency(s, c, { caseId: a, condition: 'service-ready' }, T0);
  assert.equal(long.ok, false);
  assert.equal(long.code, 'cycle');
  assert.equal(addDependency(s, a, { caseId: a, condition: 'resolved' }, T0).code, 'cycle');

  // 手で環を作ったスナップショットは保存できない
  const forged = structuredClone(s);
  forged.cases[c].dependencies.push({ caseId: a, condition: 'resolved', revision: null });
  assert.ok(validateSnapshot(forged).some((e) => e.includes('循環')));
});

// ---- C04: 二重実行・二重計上をしない / 旧世代は確定しない ----

test('C04: 旧世代の Claim による settle は Case を動かさず evidence にだけ残る', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  s = ok(markRunning(s, owned.actionId, T0), 'running').snapshot;

  // 交代 → 新世代が受諾 (旧世代の action は reconcile に倒れる)
  const handed = ok(handOverClaim(s, owned.claimId, { botKey: 'fable' }, T0 + MIN), 'handover');
  s = ok(acceptClaim(handed.snapshot, handed.nextClaimId, {
    plan: { claimId: handed.nextClaimId, kind: 'implement' },
  }, T0 + MIN), 'accept-next').snapshot;
  assert.equal(s.claims[handed.nextClaimId].generation, 2);

  // 遅れて返ってきた旧世代の結果
  s.actions[owned.actionId].state = 'running';
  const late = settleAction(s, owned.actionId, { result: { artifact: 'commit-old' } }, T0 + 2 * MIN);
  assert.equal(late.ok, true);
  assert.equal(late.applied, false);
  assert.equal(late.code, 'stale-generation');
  const target = late.snapshot.cases[caseId];
  assert.equal(target.state, 'active');
  assert.equal(target.nextTrigger.actionId, 'A-2');
  // 捨てずに証拠として残す
  const evidence = late.snapshot.evidence[late.evidenceId];
  assert.equal(evidence.conclusion, 'stale-generation');
  assert.equal(evidence.observed.note.includes('旧世代'), true);
  assert.deepEqual(validateSnapshot(late.snapshot), []);
});

test('C04: 交代の途中で旧世代の受付が判明しても、担当不在の Case を動かさない', () => {
  const { snapshot, caseId } = seed({ allocated: 4 });
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;

  // 交代した直後 = 新しい担当はまだ受諾していない (waiting(offer)・owner は空)
  const handed = ok(handOverClaim(s, owned.claimId, { botKey: 'fable' }, T0 + MIN), 'handover');
  assert.equal(handed.snapshot.cases[caseId].owner, null);
  assert.equal(handed.snapshot.cases[caseId].state, 'waiting');

  const found = reconcileActions(handed.snapshot, {
    messageFor: () => 'm-1', runFor: () => 'run-old',
  }, T0 + 2 * MIN);
  assert.deepEqual(found.stale, [owned.actionId]);
  // 受付と消費は事実として確定する (外で 1 件走った)
  assert.equal(found.snapshot.actions[owned.actionId].state, 'accepted');
  assert.deepEqual(found.snapshot.cases[caseId].budget, { allocated: 4, reserved: 0, charged: 1 });
  // **責任主体も次の契機も書き換えない** — 担当不在のまま active に戻さない
  const target = found.snapshot.cases[caseId];
  assert.equal(target.owner, null);
  assert.equal(target.state, 'waiting');
  assert.equal(target.nextTrigger.reason, 'offer');
  assert.deepEqual(validateSnapshot(found.snapshot), []);

  // 遅れて返ってきた旧世代の結果も保存できる形で残る
  const settled = settleAction(found.snapshot, owned.actionId, { result: { artifact: 'commit-old' } }, T0 + 3 * MIN);
  assert.equal(settled.applied, false);
  assert.equal(settled.code, 'stale-generation');
  assert.equal(settled.snapshot.cases[caseId].owner, null);
  assert.deepEqual(validateSnapshot(settled.snapshot), []);

  // 手で「owner の居ない active / verifying」を作ったスナップショットは保存できない
  for (const state of ['active', 'verifying']) {
    const forged = structuredClone(found.snapshot);
    forged.cases[caseId].state = state;
    assert.ok(
      validateSnapshot(forged).some((e) => e.includes('責任主体 (owner) が居ない')),
      `${state} で owner 不在が通ってしまう`,
    );
  }
});

test('C04: 受付が判明したときの Case の動きは markAccepted と照合で一致する', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let base = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  base = ok(markSent(base, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  // 送信結果が不明になり、Case は waiting(reconcile) へ
  base = ok(markReconcile(base, owned.actionId, '送信 API が落ちた', T0 + MIN), 'reconcile').snapshot;
  assert.equal(base.cases[caseId].state, 'waiting');

  const viaMark = ok(markAccepted(base, owned.actionId, { runId: 'run-1' }, T0 + 2 * MIN), 'mark').snapshot;
  const viaSweep = reconcileActions(base, { messageFor: () => 'm-1', runFor: () => 'run-1' }, T0 + 2 * MIN).snapshot;

  for (const [label, s] of [['markAccepted', viaMark], ['reconcileActions', viaSweep]]) {
    assert.equal(s.cases[caseId].state, 'active', label);
    assert.deepEqual(s.cases[caseId].nextTrigger, { kind: 'runningAction', actionId: owned.actionId }, label);
    // 待ちから戻したのなら、何を見て戻したのかが証拠に残っている
    const evidence = Object.values(s.evidence).find((e) => e.actionId === owned.actionId);
    assert.equal(evidence.observed.runId, 'run-1', label);
    assert.deepEqual(validateSnapshot(s), [], label);
  }
});

test('C04: ①意図 ②送信 ③受付 のどこで止めても、照合は同じ Action ID 1 件へ収束する', () => {
  const { snapshot, caseId } = seed({ allocated: 4 });
  const owned = withOwner(snapshot, caseId);
  const actionId = owned.actionId;
  const nothing = { messageFor: () => null, runFor: () => null };
  const sentOnly = { messageFor: () => 'm-99', runFor: () => null };
  const acceptedProbe = { messageFor: () => 'm-99', runFor: () => 'run-99' };

  // 境界① 意図だけ保存して落ちた: planned は照合の対象外 (まだ外に何も無い)
  const atPlan = reconcileActions(owned.snapshot, acceptedProbe, T0 + MIN);
  assert.deepEqual(atPlan.accepted, []);
  assert.equal(atPlan.snapshot.actions[actionId].state, 'planned');
  assert.equal(Object.keys(atPlan.snapshot.actions).length, 1);

  // 境界② 送信の途中で落ちた: 外に投稿があれば sent へ (再送しない)
  const sending = ok(markSending(owned.snapshot, actionId, {}, T0), 'sending').snapshot;
  const atSend = reconcileActions(sending, sentOnly, T0 + MIN);
  assert.deepEqual(atSend.sent, [actionId]);
  assert.equal(atSend.snapshot.actions[actionId].delivery.messageId, 'm-99');
  assert.equal(Object.keys(atSend.snapshot.actions).length, 1);

  // 境界③ 送信済みだが受付記録の保存前に落ちた: run が見つかれば accepted + 消費確定
  const atAccept = reconcileActions(atSend.snapshot, acceptedProbe, T0 + 2 * MIN);
  assert.deepEqual(atAccept.accepted, [actionId]);
  assert.equal(atAccept.snapshot.actions[actionId].delivery.runId, 'run-99');
  assert.deepEqual(atAccept.snapshot.cases[caseId].budget, { allocated: 4, reserved: 0, charged: 1 });

  // **何度呼んでも同じ** — Action は 1 件のまま、消費も 1 回だけ
  let again = atAccept.snapshot;
  for (let i = 0; i < 3; i += 1) {
    again = reconcileActions(again, acceptedProbe, T0 + (3 + i) * MIN).snapshot;
  }
  assert.equal(Object.keys(again.actions).length, 1);
  assert.equal(again.actions[actionId].state, 'accepted');
  assert.deepEqual(again.cases[caseId].budget, { allocated: 4, reserved: 0, charged: 1 });
  assert.deepEqual(validateSnapshot(again), []);

  // 送信結果が不明のうちは reconcile のまま (無条件に再送しない)
  const unknown = reconcileActions(sending, nothing, T0 + MIN);
  assert.deepEqual(unknown.pending, [actionId]);
  assert.equal(unknown.snapshot.actions[actionId].state, 'reconcile');
  assert.equal(unknown.snapshot.cases[caseId].nextTrigger.reason, 'reconcile');
  assert.deepEqual(validateSnapshot(unknown.snapshot), []);
});

test('C04: 送信から 2 分見つからなければ cancelled にして予約を返す', () => {
  const { snapshot, caseId } = seed({ allocated: 2 });
  const owned = withOwner(snapshot, caseId);
  const sending = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  assert.equal(sending.cases[caseId].budget.reserved, 1);
  const nothing = { messageFor: () => null, runFor: () => null };

  // 2 分未満は確定しない
  const early = reconcileActions(sending, nothing, T0 + 119 * 1000);
  assert.deepEqual(early.cancelled, []);
  assert.equal(early.snapshot.cases[caseId].budget.reserved, 1);

  const late = reconcileActions(early.snapshot, nothing, T0 + 3 * MIN);
  assert.deepEqual(late.cancelled, [owned.actionId]);
  assert.equal(late.snapshot.actions[owned.actionId].state, 'cancelled');
  assert.deepEqual(late.snapshot.cases[caseId].budget, { allocated: 2, reserved: 0, charged: 0 });
  assert.equal(late.snapshot.cases[caseId].nextTrigger.reason, 'reconcile');
  assert.deepEqual(validateSnapshot(late.snapshot), []);

  // もう一度呼んでも二重に返さない (cancelled は照合の対象外)
  const again = reconcileActions(late.snapshot, nothing, T0 + 9 * MIN);
  assert.deepEqual(again.cancelled, []);
  assert.deepEqual(again.snapshot.cases[caseId].budget, { allocated: 2, reserved: 0, charged: 0 });
});

test('C04: 送信済みかもしれない Action は未受付を確かめないと取り消せない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const sending = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  const blind = cancelAction(sending, owned.actionId, { reason: 'やめる' }, T0);
  assert.equal(blind.ok, false);
  assert.equal(blind.code, 'unconfirmed');
  assert.equal(blind.snapshot.cases[caseId].budget.reserved, 1);
});

test('C04: 受付は同じ Action ID につき 1 件だけ (別の run は断る)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accept').snapshot;

  const duplicate = markAccepted(s, owned.actionId, { runId: 'run-1' }, T0);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.cases[caseId].budget.charged, 1);

  const other = markAccepted(s, owned.actionId, { runId: 'run-2' }, T0);
  assert.equal(other.ok, false);
  assert.equal(other.code, 'already-accepted');
});

// ---- 停止マーカー (C07 の保存部分) ----

test('停止マーカー: tick も新しい担当も復活させず、人間の発言では解除しない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const stopped = ok(stopCase(owned.snapshot, caseId, {
    by: 'human', reason: '様子を見る', sourceId: 'msg-1',
  }, T0 + MIN), 'stop');
  assert.equal(stopped.snapshot.cases[caseId].stop.by, 'human');

  // 通常の遷移は全部断る
  assert.equal(markSending(stopped.snapshot, owned.actionId, {}, T0 + 2 * MIN).code, 'stopped');
  assert.equal(offerClaim(stopped.snapshot, { caseId, responsibility: 'investigator', botKey: 'sol' }, T0).code, 'stopped');
  assert.equal(planAction(stopped.snapshot, { caseId, claimId: owned.claimId, kind: 'consult' }, T0).code, 'stopped');

  // 人間の発言では解除しない
  const byMessage = resumeCase(stopped.snapshot, caseId, { by: 'human-message' }, T0 + 3 * MIN);
  assert.equal(byMessage.ok, false);
  assert.equal(byMessage.code, 'not-allowed');
  assert.equal(byMessage.snapshot.cases[caseId].stop.by, 'human');

  // 交代先を募るのも止める (`offerClaim` と同じ門) — 止めたのに次の担当を探し始めない
  assert.equal(handOverClaim(stopped.snapshot, owned.claimId, { botKey: 'fable' }, T0 + 2 * MIN).code, 'stopped');

  const resumed = ok(resumeCase(stopped.snapshot, caseId, { by: 'owner-command' }, T0 + 4 * MIN), 'resume');
  assert.equal(resumed.snapshot.cases[caseId].stop, null);
  assert.equal(ok(markSending(resumed.snapshot, owned.actionId, {}, T0 + 5 * MIN), 'sending').ok, true);
});

test('停止マーカー: 止めた後に返ってきた結果も台帳に残せる (契機を停止解除待ちへ倒す)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId, { kind: 'implement' });
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  s = ok(markRunning(s, owned.actionId, T0), 'running').snapshot;
  s = ok(stopCase(s, caseId, { by: 'human', reason: '様子を見る' }, T0 + MIN), 'stop').snapshot;
  assert.equal(s.cases[caseId].nextTrigger.kind, 'runningAction');

  const settled = settleAction(s, owned.actionId, {
    result: { artifact: 'commit-abc' },
    evidence: { source: { kind: 'bot', botKey: 'opus', runId: 'run-1' }, observed: { exitCode: 0 } },
  }, T0 + 2 * MIN);
  assert.equal(settled.ok, true);
  assert.equal(settled.applied, false);
  assert.equal(settled.code, 'stopped');
  // 結果は残る / Case は動かない / **保存できる形になっている**
  assert.equal(settled.snapshot.actions[owned.actionId].state, 'settled');
  assert.equal(settled.snapshot.cases[caseId].state, 'active');
  assert.equal(settled.snapshot.cases[caseId].stop.by, 'human');
  assert.equal(settled.snapshot.cases[caseId].nextTrigger.reason, 'paused');
  assert.equal(settled.snapshot.evidence[settled.evidenceId].observed.exitCode, 0);
  assert.deepEqual(validateSnapshot(settled.snapshot), []);
});

test('停止マーカー: /pause 中は新しい送信を作らないが、照合は先へ進める', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);

  // (1) pause 中は planned → sending にしない (Case も Action も動かない)
  const blocked = markSending(owned.snapshot, owned.actionId, { paused: true }, T0);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'paused');
  assert.deepEqual(blocked.snapshot, owned.snapshot);

  // (2) pause の前に送りに出ていた Action は、pause 中でも照合で先へ進む
  const inFlight = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  assert.equal(inFlight.actions[owned.actionId].state, 'sending');
  assert.equal(inFlight.actions[owned.actionId].delivery.messageId, null);

  const swept = reconcileActions(inFlight, { messageFor: () => 'm-42', runFor: () => null }, T0 + MIN);
  assert.deepEqual(swept.sent, [owned.actionId]);
  // **前後で実際に状態が動いている** (照合が素通りしていないことを差分で見る)
  assert.equal(swept.snapshot.actions[owned.actionId].state, 'sent');
  assert.equal(swept.snapshot.actions[owned.actionId].delivery.messageId, 'm-42');
  assert.notDeepEqual(swept.snapshot.actions[owned.actionId], inFlight.actions[owned.actionId]);
  assert.deepEqual(validateSnapshot(swept.snapshot), []);

  // 受付まで判明すれば pause 中でも消費が確定する (後始末は止めない)
  const accepted = reconcileActions(swept.snapshot, { messageFor: () => 'm-42', runFor: () => 'run-42' }, T0 + 2 * MIN);
  assert.deepEqual(accepted.accepted, [owned.actionId]);
  assert.equal(accepted.snapshot.cases[caseId].budget.charged, 1);
  assert.deepEqual(validateSnapshot(accepted.snapshot), []);
});

test('停止マーカー: 止めた Case は照合で受付が判明しても復活しない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(stopCase(s, caseId, { by: 'human', reason: '様子を見る' }, T0), 'stop').snapshot;
  const before = structuredClone(s.cases[caseId]);

  const swept = reconcileActions(s, { messageFor: () => 'm-1', runFor: () => 'run-1' }, T0 + MIN);
  // Action の受付記録と消費は残るが、Case は 1 ミリも動かない
  assert.equal(swept.snapshot.actions[owned.actionId].state, 'accepted');
  assert.equal(swept.snapshot.actions[owned.actionId].delivery.runId, 'run-1');
  assert.equal(swept.snapshot.cases[caseId].state, before.state);
  assert.deepEqual(swept.snapshot.cases[caseId].nextTrigger, before.nextTrigger);
  assert.deepEqual(swept.snapshot.cases[caseId].stop, before.stop);
  assert.deepEqual(validateSnapshot(swept.snapshot), []);
});

test('停止マーカー: 止めた Case の取り消しは state を動かさず「解除待ち」にする', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(stopCase(s, caseId, { by: 'human', actionId: owned.actionId, reason: '/stop' }, T0 + MIN), 'stop').snapshot;
  assert.equal(s.cases[caseId].state, 'active', '前提: 止めた時点では active');

  // 未受付が確認できたので取り消す (screenAction が停止中の起動を断ったときと同じ形)
  const cancelled = ok(cancelAction(s, owned.actionId, {
    confirmedUnaccepted: true, reason: '案件は停止中',
  }, T0 + 2 * MIN), 'cancel');
  const target = cancelled.snapshot.cases[caseId];
  assert.equal(target.state, 'active', '止めた Case の state を動かしている');
  assert.equal(target.nextTrigger.reason, 'paused');
  assert.match(target.nextTrigger.condition, /停止の解除を待つ/);
  // 予約は返る (外に出ていないことが確認できている)
  assert.equal(cancelled.snapshot.actions[owned.actionId].state, 'cancelled');
  assert.equal(cancelled.snapshot.actions[owned.actionId].budget.reserved, false);
  assert.equal(target.budget.reserved, 0);
});

// ---- 停止の解除 ----

/** 止めた Case を作る (走っていた一手が停止中に終わり、契機は waiting(paused)) */
function stoppedMidFlight(over = {}) {
  const { snapshot, caseId } = seed(over.seed ?? {});
  const owned = withOwner(snapshot, caseId, { kind: over.kind ?? 'implement' });
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  s = ok(markRunning(s, owned.actionId, T0), 'running').snapshot;
  s = ok(stopCase(s, caseId, {
    by: 'human', actionId: over.stopActionId ?? owned.actionId, sourceId: 'U-so', reason: '/stop',
  }, T0 + MIN), 'stop').snapshot;
  const settled = settleAction(s, owned.actionId, { result: { runId: 'run-1', outcome: 'cancelled' } }, T0 + 2 * MIN);
  assert.equal(settled.code, 'stopped', '前提: 停止中の settle');
  assert.equal(settled.snapshot.cases[caseId].nextTrigger.reason, 'paused', '前提: 契機は解除待ち');
  return { ...owned, snapshot: settled.snapshot, caseId };
}

test('再開: 止めた一手を同じ Claim・kind・宛先で立て直す', () => {
  const { snapshot, caseId, claimId, actionId } = stoppedMidFlight();
  const resumed = ok(resumeCase(snapshot, caseId, { by: 'owner-command' }, T0 + 3 * MIN), 'resume');

  assert.equal(resumed.code, 'replanned');
  assert.ok(resumed.replanned, '立て直した Action が返っていない');
  const next = resumed.snapshot.actions[resumed.replanned];
  assert.equal(next.state, 'planned');
  assert.equal(next.kind, 'implement');
  assert.equal(next.claimId, claimId, '同じ担当の下に立てる');
  assert.deepEqual(next.target, snapshot.actions[actionId].target, '宛先を変えている');
  assert.match(next.note, new RegExp(`再開: ${actionId} の続き`));
  // 停止は解け、契機は立て直した一手を指す (次の tick で送られる形)
  const target = resumed.snapshot.cases[caseId];
  assert.equal(target.stop, null);
  assert.equal(target.resumedBy, 'owner-command');
  assert.deepEqual(target.nextTrigger, { kind: 'nextAction', actionId: resumed.replanned });
  assert.equal(target.state, 'active', '止める前の state から続ける');
});

test('再開: 立て直せないときは理由を待ちに残す (相談 / 台帳に無い / 予算切れ)', () => {
  // (1) 相談 (consult) は立て直さない — もう一度声を掛けるかは人が決める
  const consult = stoppedMidFlight({ kind: 'consult' });
  const noConsult = ok(resumeCase(consult.snapshot, consult.caseId, { by: 'owner-command' }, T0 + 3 * MIN), 'resume');
  assert.equal(noConsult.code, 'needs-plan');
  assert.equal(noConsult.replanned, null);
  const afterConsult = noConsult.snapshot.cases[consult.caseId];
  assert.equal(afterConsult.stop, null, '解除そのものは通る');
  assert.equal(afterConsult.nextTrigger.reason, 'evidence');
  assert.match(afterConsult.nextTrigger.condition, /相談 \(consult\)/);
  assert.match(afterConsult.nextTrigger.condition, /next\.plan/);

  // (2) 止めた Action が台帳から読めない
  const unknown = stoppedMidFlight({ stopActionId: 'A-99' });
  const noAction = ok(resumeCase(unknown.snapshot, unknown.caseId, { by: 'owner-command' }, T0 + 3 * MIN), 'resume');
  assert.equal(noAction.code, 'needs-plan');
  assert.match(noAction.snapshot.cases[unknown.caseId].nextTrigger.condition, /台帳に無い/);

  // (3) 配分を使い切っている — 台帳の断り (budget) をそのまま条件に残す
  const broke = stoppedMidFlight({ seed: { allocated: 1 } });
  const noBudget = ok(resumeCase(broke.snapshot, broke.caseId, { by: 'owner-command' }, T0 + 3 * MIN), 'resume');
  assert.equal(noBudget.code, 'needs-plan');
  assert.match(noBudget.snapshot.cases[broke.caseId].nextTrigger.condition, /budget/);
});

test('再開: 契機が次の一手を指したままなら解除だけで、二重に立てない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const stopped = ok(stopCase(owned.snapshot, caseId, {
    by: 'human', actionId: owned.actionId, reason: '/stop',
  }, T0 + MIN), 'stop');
  assert.deepEqual(stopped.snapshot.cases[caseId].nextTrigger, { kind: 'nextAction', actionId: owned.actionId });

  const resumed = ok(resumeCase(stopped.snapshot, caseId, { by: 'owner-command' }, T0 + 2 * MIN), 'resume');
  assert.equal(resumed.code, 'resumed');
  assert.equal(resumed.replanned, null);
  assert.equal(Object.keys(resumed.snapshot.actions).length, 1, '同じ一手を 2 本立てている');
  assert.deepEqual(resumed.snapshot.cases[caseId].nextTrigger, { kind: 'nextAction', actionId: owned.actionId });
  // 止めていない Case は断る (何も起きていないことが呼び出し側に読める)
  assert.equal(resumeCase(resumed.snapshot, caseId, { by: 'owner-command' }, T0 + 3 * MIN).code, 'not-stopped');
});

test('受諾: plan の代わりに waiting を渡すと担当だけ決まって人間待ちになる', () => {
  const { snapshot, caseId } = seed();
  const offered = ok(offerClaim(snapshot, { caseId, responsibility: 'owner', botKey: 'opus' }, T0), 'offer');
  const waiting = { reason: 'authority', condition: 'observe では implement の Action を起こせない' };
  const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, { waiting }, T0 + MIN), 'accept');

  const target = accepted.snapshot.cases[caseId];
  assert.equal(target.owner, offered.claimId, '引受けそのものは通る');
  assert.equal(target.state, 'waiting', '最初の一手が無いのに active にしている');
  assert.equal(target.nextTrigger.reason, 'authority');
  assert.equal(accepted.actionId, null, 'Action を立てている');
  assert.equal(Object.keys(accepted.snapshot.actions).length, 0);

  // plan と waiting は排他 (どちらが次の契機か決まらない)
  const both = acceptClaim(offered.snapshot, offered.claimId, {
    waiting, plan: { kind: 'investigate' },
  }, T0 + MIN);
  assert.equal(both.ok, false);
  assert.equal(both.code, 'invalid');
  // 引受け待ちへは倒せない — owner が決まるのに「誰かが引き受けるのを待つ」は誰も満たせない
  const asOffer = acceptClaim(offered.snapshot, offered.claimId, {
    waiting: { reason: 'offer', condition: '別の担当を探す' },
  }, T0 + MIN);
  assert.equal(asOffer.ok, false);
  assert.equal(asOffer.code, 'invalid');
});

// ---- 検収と終端 ----

test('検収: 実装者は自分の成果を合格にできず、身元と版が無ければ合格にならない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId, { botKey: 'opus', kind: 'implement' });
  const settled = runAction(owned.snapshot, owned.actionId);
  assert.equal(settled.cases[caseId].state, 'verifying');
  assert.equal(settled.cases[caseId].nextTrigger.reason, 'evidence');

  const base = {
    caseId,
    assessor: { botKey: 'opus2', runId: 'run-v', modelId: 'claude-opus-5' },
    acceptanceVersion: 1,
    subjectRevision: 'abc1234',
    observed: { tests: '全通過' },
  };
  // 自己検収
  assert.equal(acceptVerification(settled, {
    ...base, assessor: { ...base.assessor, botKey: 'opus' },
  }, T0).code, 'self-review');
  // bot 名だけでは足りない (run ID と model ID が要る)
  assert.equal(acceptVerification(settled, {
    ...base, assessor: { botKey: 'opus2', runId: '', modelId: 'claude-opus-5' },
  }, T0).code, 'assessor-identity');
  // 古い版への評価を新しい版の合格に流用しない
  assert.equal(acceptVerification(settled, { ...base, acceptanceVersion: 2 }, T0).code, 'acceptance-version');
  assert.equal(acceptVerification(settled, { ...base, subjectRevision: '' }, T0).code, 'subject-revision');

  const done = ok(acceptVerification(settled, base, T0), 'verify').snapshot;
  const evidence = done.evidence[done.cases[caseId].resolution.evidenceId];
  assert.equal(evidence.source.modelId, 'claude-opus-5');
  assert.deepEqual(evidence.observed, { tests: '全通過' });
  assert.equal(evidence.subjectRevision, 'abc1234');
});

test('検収: 誘われて断っただけの bot は検収できる (実装側に数えない)', () => {
  const { snapshot, caseId } = seed();
  // opus2 も誘ったが、二人同時受諾で declined に落ちた
  const invited = ok(offerClaim(snapshot, { caseId, responsibility: 'owner', botKey: 'opus2' }, T0), 'invite');
  const owned = withOwner(invited.snapshot, caseId, { botKey: 'opus', kind: 'implement' });
  const declined = acceptClaim(owned.snapshot, invited.claimId, {
    plan: { claimId: invited.claimId, kind: 'implement' },
  }, T0);
  assert.equal(declined.code, 'occupied');
  assert.equal(declined.snapshot.claims[invited.claimId].state, 'declined');

  const settled = runAction(declined.snapshot, owned.actionId);
  const done = ok(acceptVerification(settled, {
    caseId,
    assessor: { botKey: 'opus2', runId: 'run-v', modelId: 'claude-opus-5' },
    acceptanceVersion: 1,
    subjectRevision: 'abc1234',
    observed: { tests: '全通過' },
  }, T0), 'verify');
  assert.equal(done.snapshot.cases[caseId].state, 'resolved');

});

test('検収: 決定権者 (authority) は差配しただけなので検収できる', () => {
  const { snapshot, caseId } = seed();
  // ブリッジ (`ensureAuthorityClaimOn`) は**すべての案件に** authority の Claim を accepted で作る。
  // これを実装側に数えると、既定の決定権者がどの案件も検収できなくなる (Opus2 指摘 ① 2026-09-08)
  const offered = ok(offerClaim(snapshot, {
    caseId, responsibility: 'authority', botKey: 'fable', scope: '案件の裁定と相談の差配',
  }, T0), 'offer-authority');
  const authority = ok(acceptClaim(offered.snapshot, offered.claimId, { permissionOk: true }, T0), 'accept-authority');
  assert.equal(authority.snapshot.claims[offered.claimId].state, 'accepted');

  const owned = withOwner(authority.snapshot, caseId, { botKey: 'opus', kind: 'implement' });
  const settled = runAction(owned.snapshot, owned.actionId);
  const verify = (botKey) => acceptVerification(settled, {
    caseId,
    assessor: { botKey, runId: 'run-v', modelId: 'claude-opus-5' },
    acceptanceVersion: 1, subjectRevision: 'abc1234', observed: { tests: '全通過' },
  }, T0 + MIN);

  assert.equal(verify('fable').ok, true, '差配は成果ではない — 決定権者は検収できる');
  // 実装した owner は変わらず自己検収
  assert.equal(verify('opus').code, 'self-review');
});

test('検収: 一度でも引き受けた bot は、辞退・交代・担当消失の後でも検収できない', () => {
  // **state を偽装せず遷移関数だけで作る** — owner は fable のまま、実装は opus が
  // 別責務 (implementer) で引き受けるので、opus の Claim が終わっても Case は verifying に残る
  const build = () => {
    const { snapshot, caseId } = seed();
    const owner = withOwner(snapshot, caseId, { botKey: 'fable' });
    const offered = ok(offerClaim(owner.snapshot, {
      caseId, responsibility: 'implementer', botKey: 'opus',
    }, T0), 'offer-impl');
    const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, {}, T0), 'accept-impl');
    const planned = ok(planAction(accepted.snapshot, {
      caseId, claimId: offered.claimId, kind: 'implement',
    }, T0), 'plan-impl');
    const settled = runAction(planned.snapshot, planned.actionId);
    assert.equal(settled.cases[caseId].state, 'verifying');
    return { snapshot: settled, caseId, claimId: offered.claimId };
  };
  const verify = (snapshot, caseId, botKey) => acceptVerification(snapshot, {
    caseId,
    assessor: { botKey, runId: 'run-v', modelId: 'claude-opus-5' },
    acceptanceVersion: 1, subjectRevision: 'abc1234', observed: { tests: '全通過' },
  }, T0 + MIN);

  for (const [label, end] of [
    ['released', (s, id) => ok(releaseClaim(s, id, '手が離せない', T0), 'release').snapshot],
    ['handed-over', (s, id) => ok(handOverClaim(s, id, { botKey: 'opus2' }, T0), 'handover').snapshot],
    // 担当消失 (expired) も accepted を経ているので実装側 — 状態リストだけ見ると漏れる
    ['expired', (s, id) => ok(expireClaim(s, id, 'bot が居なくなった', T0), 'expire').snapshot],
  ]) {
    const built = build();
    const ended = end(built.snapshot, built.claimId);
    assert.equal(ended.claims[built.claimId].state, label);
    assert.equal(ended.cases[built.caseId].state, 'verifying', label);
    assert.equal(verify(ended, built.caseId, 'opus').code, 'self-review', label);
    // まだ引き受けていない bot は検収できる (handed-over の交代先も offered のうちは実装側ではない)
    assert.equal(verify(ended, built.caseId, 'opus2').ok, true, label);
  }
});

test('取り消しは自分を指している契機だけを立て直す (別の Action の待ちを上書きしない)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  // A-1 を照合待ちにしてから、別 Case の Action を取り消しても条件文が変わらないこと
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markReconcile(s, owned.actionId, '送信結果が不明', T0), 'reconcile').snapshot;
  const waitingFor = structuredClone(s.cases[caseId].nextTrigger);
  assert.equal(waitingFor.actionId, owned.actionId);

  // 同じ Case に別の Action を立てて取り消す (owner の claim は生きている)
  s.cases[caseId].state = 'active';
  const second = ok(planAction(s, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan2');
  let t = second.snapshot;
  t.cases[caseId].nextTrigger = waitingFor;
  t = ok(cancelAction(t, second.actionId, { reason: 'やめた' }, T0 + MIN), 'cancel').snapshot;
  assert.deepEqual(t.cases[caseId].nextTrigger, waitingFor);
});

test('検収: 不合格は次の action か待ち条件を必ず伴う', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId, { kind: 'implement' });
  const settled = runAction(owned.snapshot, owned.actionId);

  const bare = rejectVerification(settled, { caseId }, T0);
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'next-required');

  const back = ok(rejectVerification(settled, {
    caseId,
    evidence: { source: { kind: 'bot', botKey: 'opus2' }, observed: { note: 'テストが 1 件落ちている' } },
    next: { plan: { claimId: owned.claimId, kind: 'implement' } },
  }, T0 + MIN), 'reject');
  assert.equal(back.snapshot.cases[caseId].state, 'active');
  assert.equal(back.snapshot.cases[caseId].nextTrigger.kind, 'nextAction');

  const held = ok(rejectVerification(settled, {
    caseId,
    next: { waiting: { reason: 'evidence', condition: '再現手順を待つ' } },
  }, T0 + MIN), 'reject-wait');
  assert.equal(held.snapshot.cases[caseId].state, 'waiting');
  assert.equal(held.snapshot.cases[caseId].nextTrigger.nextCheckAt, new Date(T0 + 6 * MIN).toISOString());
});

test('終端: resolved / closed の Case は動かず、検収結果は上書きされない', () => {
  const { snapshot, caseId } = seed();
  const done = resolveWholeCase(snapshot, caseId);
  const resolution = structuredClone(done.cases[caseId].resolution);

  assert.equal(offerClaim(done, { caseId, responsibility: 'owner', botKey: 'fable' }, T0).code, 'terminal');
  assert.equal(closeCase(done, caseId, { closeReason: 'duplicate' }, T0).code, 'terminal');
  assert.equal(stopCase(done, caseId, { by: 'human' }, T0).code, 'terminal');
  assert.equal(acceptVerification(done, {
    caseId,
    assessor: { botKey: 'fable', runId: 'r', modelId: 'm' },
    acceptanceVersion: 1, subjectRevision: 'x', observed: {},
  }, T0).code, 'terminal');
  assert.deepEqual(done.cases[caseId].resolution, resolution);
  assert.equal(done.cases[caseId].nextTrigger, null);
});

test('終端: closed の Case に属する Action を動かしても Case は 1 ミリも動かない', () => {
  const { snapshot, caseId } = seed({ allocated: 5 });
  const owned = withOwner(snapshot, caseId, { kind: 'implement' });
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  s = ok(markRunning(s, owned.actionId, T0), 'running').snapshot;

  const closed = ok(closeCase(s, caseId, { closeReason: 'unnecessary', note: '上流で直った' }, T0 + MIN), 'close');
  // 生きていた Action は照合へ回る (未受付とは決めない)
  assert.deepEqual(closed.reconciledActionIds, [owned.actionId]);
  assert.equal(closed.snapshot.actions[owned.actionId].state, 'reconcile');
  const frozen = structuredClone(closed.snapshot.cases[caseId]);
  assert.equal(frozen.state, 'closed');
  assert.equal(frozen.nextTrigger, null);

  // 後から返ってきた結果は Action 側に残るが、Case は動かない
  let after = ok(markSent(closed.snapshot, owned.actionId, { messageId: 'm-1' }, T0 + 2 * MIN), 'late-sent').snapshot;
  const reaccept = markAccepted(after, owned.actionId, { runId: 'run-1' }, T0 + 2 * MIN);
  assert.equal(reaccept.code, 'terminal');
  after = reaccept.snapshot;
  after = ok(markRunning(after, owned.actionId, T0 + 3 * MIN), 'late-running').snapshot;
  const settled = settleAction(after, owned.actionId, {
    result: { artifact: 'commit-late' },
    evidence: { source: { kind: 'bot', botKey: 'opus', runId: 'run-1' }, observed: { exitCode: 0 } },
  }, T0 + 4 * MIN);
  assert.equal(settled.ok, true);
  assert.equal(settled.applied, false);
  assert.equal(settled.code, 'terminal');
  assert.equal(settled.snapshot.actions[owned.actionId].state, 'settled');
  assert.equal(settled.snapshot.evidence[settled.evidenceId].observed.exitCode, 0);
  // state / closeReason / resolution / nextTrigger のどれも変わっていない
  assert.deepEqual(settled.snapshot.cases[caseId], frozen);
  assert.deepEqual(validateSnapshot(settled.snapshot), []);
});

test('終端: 走っている最中に閉じても、返ってきた結果と証拠は残る', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId, { kind: 'implement' });
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  s = ok(markRunning(s, owned.actionId, T0), 'running').snapshot;

  // job が走っている最中に「もう要らない」で閉じる (掃除で reconcile へ倒れる)
  const closed = ok(closeCase(s, caseId, { closeReason: 'unnecessary' }, T0 + MIN), 'close');
  assert.equal(closed.snapshot.actions[owned.actionId].state, 'reconcile');
  const frozen = structuredClone(closed.snapshot.cases[caseId]);

  // その直後に job が完了して結果を返す — **結果と証拠は残る** (照合では復元できない中身)
  const settled = settleAction(closed.snapshot, owned.actionId, {
    result: { artifact: 'commit-late', note: '実装は終わっていた' },
    evidence: { source: { kind: 'bot', botKey: 'opus', runId: 'run-1' }, observed: { exitCode: 0 } },
  }, T0 + 2 * MIN);
  assert.equal(settled.ok, true);
  assert.equal(settled.applied, false);
  assert.equal(settled.code, 'terminal');
  assert.equal(settled.snapshot.actions[owned.actionId].state, 'settled');
  assert.equal(settled.snapshot.actions[owned.actionId].result.artifact, 'commit-late');
  assert.equal(settled.snapshot.evidence[settled.evidenceId].observed.exitCode, 0);
  assert.equal(Object.keys(settled.snapshot.evidence).length, 1);
  // Case は 1 ミリも動かない
  assert.deepEqual(settled.snapshot.cases[caseId], frozen);
  assert.deepEqual(validateSnapshot(settled.snapshot), []);

  // 受付記録の無い Action (送っただけで reconcile) は、どの job の結果か照合できないので断る
  const neverAccepted = withOwner(snapshot, caseId).snapshot;
  let u = ok(markSending(neverAccepted, 'A-1', {}, T0), 'sending2').snapshot;
  u = ok(markReconcile(u, 'A-1', '送信結果が不明', T0), 'reconcile2').snapshot;
  const refused = settleAction(u, 'A-1', { result: { note: 'x' }, next: { waiting: { reason: 'evidence', condition: 'y' } } }, T0 + MIN);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'bad-state');
  assert.match(refused.reason, /受付記録/);
});

test('終端: closeCase は planned を取り消して予約を返す / resolved も生きた Action を掃く', () => {
  const { snapshot, caseId } = seed({ allocated: 5 });
  const owned = withOwner(snapshot, caseId);
  assert.equal(owned.snapshot.cases[caseId].budget.reserved, 1);
  const closed = ok(closeCase(owned.snapshot, caseId, { closeReason: 'duplicate' }, T0), 'close');
  assert.deepEqual(closed.cancelledActionIds, [owned.actionId]);
  assert.equal(closed.snapshot.actions[owned.actionId].state, 'cancelled');
  assert.deepEqual(closed.snapshot.cases[caseId].budget, { allocated: 5, reserved: 0, charged: 0 });
  assert.deepEqual(validateSnapshot(closed.snapshot), []);

  // 検収合格で終端にするときも同じ (成果を出した Action の他に生きた Action があれば掃く)
  const owner = withOwner(snapshot, caseId, { botKey: 'fable' });
  const impl = ok(offerClaim(owner.snapshot, { caseId, responsibility: 'implementer', botKey: 'opus' }, T0), 'offer');
  const acc = ok(acceptClaim(impl.snapshot, impl.claimId, {}, T0), 'accept');
  const planned = ok(planAction(acc.snapshot, { caseId, claimId: impl.claimId, kind: 'implement' }, T0), 'plan');
  const settled = runAction(planned.snapshot, planned.actionId);
  const done = ok(acceptVerification(settled, {
    caseId,
    assessor: { botKey: 'opus2', runId: 'run-v', modelId: 'claude-opus-5' },
    acceptanceVersion: 1, subjectRevision: 'abc', observed: { tests: '全通過' },
  }, T0 + MIN), 'verify');
  // owner の最初の action (planned のまま) が残っていたので取り消されている
  assert.deepEqual(done.cancelledActionIds, [owner.actionId]);
  assert.equal(done.snapshot.actions[owner.actionId].state, 'cancelled');
  assert.equal(done.snapshot.cases[caseId].nextTrigger, null);
  assert.deepEqual(validateSnapshot(done.snapshot), []);

  // 終端 Case を指す planned Action が残った形は保存できない
  const forged = structuredClone(done.snapshot);
  forged.actions[owner.actionId].state = 'planned';
  assert.ok(validateSnapshot(forged).some((e) => e.includes('planned なのに Case')));
});

test('終端: 終端 Case が次の契機を持つ形と、引き継ぎ先の無い superseded は保存できない', () => {
  const { snapshot, caseId } = seed();
  const done = resolveWholeCase(snapshot, caseId);
  const withTrigger = structuredClone(done);
  withTrigger.cases[caseId].nextTrigger = { kind: 'waiting', reason: 'evidence', condition: 'x', nextCheckAt: new Date(T0).toISOString(), actionId: null };
  assert.ok(validateSnapshot(withTrigger).some((e) => e.includes('終端) なのに次の契機')));

  const child = ok(createChildCase(snapshot, caseId, {
    desiredOutcome: '引き継ぎ先', acceptance: { condition: 'c', version: 1 },
  }, T0), 'child');
  const closed = ok(closeCase(child.snapshot, caseId, {
    closeReason: 'superseded', supersededBy: child.caseId,
  }, T0), 'close').snapshot;
  const orphan = structuredClone(closed);
  delete orphan.cases[child.caseId];
  // 子を消すと親子参照も切れるが、引き継ぎ先が無いことも別に報告する
  assert.ok(validateSnapshot(orphan).some((e) => e.includes('引き継ぎ先')));
  const nulled = structuredClone(closed);
  nulled.cases[caseId].supersededBy = null;
  assert.ok(validateSnapshot(nulled).some((e) => e.includes('引き継ぎ先')));
});

test('owner の門: 担当の居ない Case は settle でも照合でも active にならない', () => {
  // investigator だけが引き受けた open の Case (owner は空のまま)
  const { snapshot, caseId } = seed();
  const offered = ok(offerClaim(snapshot, {
    caseId, responsibility: 'investigator', botKey: 'opus',
  }, T0), 'offer');
  const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, {}, T0), 'accept');
  assert.equal(accepted.snapshot.cases[caseId].owner, null);
  assert.equal(accepted.snapshot.cases[caseId].state, 'open');

  // **担当が居ない Case の契機は「引受け待ち」のまま** (S2-4a の規則 (d)) —
  // owner 以外の Claim の Action は、何本積んでも待ちを奪わない
  const planned = ok(planAction(accepted.snapshot, {
    caseId, claimId: offered.claimId, kind: 'investigate',
  }, T0), 'plan');
  assert.equal(planned.repointed, false);
  assert.equal(planned.snapshot.cases[caseId].nextTrigger.reason, 'offer');
  let s = ok(markSending(planned.snapshot, planned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, planned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, planned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  assert.equal(s.cases[caseId].state, 'open', '受付だけで active にしない');

  // **次の一手は作ってよい。契機と state は動かさない** (Fable 裁定 2026-09-08) —
  // planned の Action は契機と無関係に dispatchPlanned が送るので孤児にならない
  const beforeBudget = structuredClone(s.cases[caseId].budget);
  const next = ok(settleAction(s, planned.actionId, {
    result: { note: '原因はここ' },
    next: { plan: { claimId: offered.claimId, kind: 'consult' } },
  }, T0 + MIN), 'settle-plan');
  assert.equal(next.keptTrigger, true);
  assert.equal(Object.keys(next.snapshot.actions).length, 2, '次の一手を作っていない');
  assert.equal(next.snapshot.cases[caseId].state, 'open', '担当が居ないのに active にした');
  assert.equal(next.snapshot.cases[caseId].nextTrigger.reason, 'offer', '引受け待ちを奪っている');
  assert.equal(next.snapshot.cases[caseId].budget.reserved, (beforeBudget.reserved ?? 0) + 1);
  assert.deepEqual(validateSnapshot(next.snapshot), []);

  // 待ち条件で settle し直せば結果は残り、契機は引受け待ちのまま (state も動かない)
  const held = ok(settleAction(s, planned.actionId, {
    result: { note: '依存が先' },
    evidence: { source: { kind: 'bot', botKey: 'opus' }, observed: { cause: 'ここ' } },
    next: { waiting: { reason: 'dependency', condition: 'C-2 が resolved になる' } },
  }, T0 + MIN), 'settle-wait');
  assert.equal(held.keptTrigger, true);
  assert.equal(held.snapshot.actions[planned.actionId].result.note, '依存が先');
  assert.equal(held.snapshot.cases[caseId].state, 'open');
  assert.equal(held.snapshot.cases[caseId].nextTrigger.reason, 'offer');
  assert.deepEqual(held.snapshot.cases[caseId].budget, beforeBudget);
  assert.deepEqual(validateSnapshot(held.snapshot), []);

  // owner の居ない waiting は resumeFromWaiting でも戻せない
  const orphanWaiting = structuredClone(held.snapshot);
  orphanWaiting.cases[caseId].state = 'waiting';
  assert.equal(resumeFromWaiting(orphanWaiting, caseId, {
    evidence: { source: { kind: 'bot', botKey: 'opus' }, observed: { ok: true } },
    plan: { claimId: offered.claimId, kind: 'implement' },
  }, T0 + 2 * MIN).code, 'no-owner');
});

test('受諾: owner 以外でも最初の一手を同じ update で植え、契機は奪わない', () => {
  // owner のときだけ植てていた頃は、investigator / assessor で受けた bot に最初の Action が
  // 立たず二度と起動されなかった (様式は accept に next.plan を必須にしている / Fable 検収 2026-09-08)
  const { snapshot, caseId } = seed();
  const offered = ok(offerClaim(snapshot, {
    caseId, responsibility: 'investigator', botKey: 'opus',
  }, T0), 'offer');
  const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, {
    // **外から渡した claimId は受諾した Claim で上書きする** (責任の所在と持ち主をずらさない)
    plan: { claimId: 'CL-999', kind: 'investigate', target: { botKey: 'opus', threadId: 'T-1' } },
  }, T0), 'accept');

  const action = accepted.snapshot.actions[accepted.actionId];
  assert.equal(action.claimId, offered.claimId, '渡された claimId をそのまま使っている');
  assert.equal(action.kind, 'investigate');
  assert.equal(action.state, 'planned');
  assert.equal(action.target.botKey, 'opus');
  const target = accepted.snapshot.cases[caseId];
  assert.equal(target.state, 'open', '担当が居ないのに active にした');
  assert.equal(target.owner, null);
  assert.equal(target.nextTrigger.reason, 'offer', '引受け待ちを奪っている');
  assert.deepEqual(validateSnapshot(accepted.snapshot), []);
});

test('受諾: owner 付き Case への assessor の受諾は owner も契機も動かさない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const before = structuredClone(owned.snapshot.cases[caseId]);
  const offered = ok(offerClaim(owned.snapshot, {
    caseId, responsibility: 'assessor', botKey: 'opus2',
  }, T0), 'offer');
  const accepted = ok(acceptClaim(offered.snapshot, offered.claimId, {
    plan: { kind: 'assess' },
  }, T0), 'accept');

  assert.equal(accepted.snapshot.actions[accepted.actionId].claimId, offered.claimId);
  const target = accepted.snapshot.cases[caseId];
  assert.equal(target.owner, before.owner, 'owner が動いた');
  assert.equal(target.state, before.state);
  assert.deepEqual(target.nextTrigger, before.nextTrigger, '契機を奪っている');
  assert.deepEqual(validateSnapshot(accepted.snapshot), []);
});

test('契機の規則: plan が契機を奪うのは null / 終わった Action / owner の待ちのときだけ', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId); // (d) 待ち → owner の Claim なので向いた
  assert.equal(owned.snapshot.cases[caseId].nextTrigger.actionId, owned.actionId);

  // (c) 生きた Action (planned) を指しているので奪わない
  const live = ok(planAction(owned.snapshot, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan-live');
  assert.equal(live.repointed, false);
  assert.equal(live.snapshot.cases[caseId].nextTrigger.actionId, owned.actionId);
  assert.deepEqual(validateSnapshot(live.snapshot), []);

  // (b) 終わった Action を指していれば向け直す
  const dead = structuredClone(owned.snapshot);
  dead.actions[owned.actionId].state = 'cancelled';
  const moved = ok(planAction(dead, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan-dead');
  assert.equal(moved.repointed, true);
  assert.equal(moved.snapshot.cases[caseId].nextTrigger.actionId, moved.actionId);

  // (a) 契機が無ければ向ける
  const bare = structuredClone(owned.snapshot);
  bare.cases[caseId].nextTrigger = null;
  const first = ok(planAction(bare, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan-null');
  assert.equal(first.repointed, true);
  assert.equal(first.snapshot.cases[caseId].nextTrigger.actionId, first.actionId);

  // (d) 待ち × owner 以外の Claim は奪わない
  const other = ok(offerClaim(snapshot, { caseId, responsibility: 'investigator', botKey: 'opus2' }, T0), 'offer2');
  const joined = ok(acceptClaim(other.snapshot, other.claimId, {}, T0), 'accept2');
  assert.equal(joined.snapshot.cases[caseId].nextTrigger.kind, 'waiting');
  const outsider = ok(planAction(joined.snapshot, { caseId, claimId: other.claimId, kind: 'investigate' }, T0), 'plan-other');
  assert.equal(outsider.repointed, false);
  assert.equal(outsider.snapshot.cases[caseId].nextTrigger.reason, 'offer');
});

test('契機の門: 別の生きた Action を指している契機は owner が居ても上書きしない', () => {
  // owner が決まった後に届く 2 通目の相談の返事が、owner の nextAction を
  // `waiting(offer)` で潰していた (Fable 検収 2026-09-08)
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId); // 契機 → A-1 (planned)
  // 2 本目は契機を奪わない (S2-4a の規則 (c))。走らせて settle するのはこちら
  const second = ok(planAction(owned.snapshot, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan2');
  let s = ok(markSending(second.snapshot, second.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, second.actionId, { messageId: 'm-2' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, second.actionId, { runId: 'run-2' }, T0), 'accepted').snapshot;
  assert.equal(s.cases[caseId].nextTrigger.actionId, owned.actionId, '前提: 契機は 1 本目のまま');
  const before = structuredClone(s.cases[caseId]);

  const kept = ok(settleAction(s, second.actionId, {
    result: { note: '調べた' },
    next: { waiting: { reason: 'evidence', condition: '材料を待つ' } },
  }, T0 + MIN), 'settle-kept');
  assert.equal(kept.keptTrigger, true);
  assert.deepEqual(kept.snapshot.cases[caseId].nextTrigger, before.nextTrigger, '契機を奪っている');
  assert.equal(kept.snapshot.cases[caseId].state, before.state);
  assert.equal(kept.snapshot.cases[caseId].owner, before.owner);
  assert.equal(kept.snapshot.actions[second.actionId].result.note, '調べた', '結果は残る');

  // **plan でも同じ — Action は作るが契機は奪わない** (Fable 裁定 2026-09-08)。
  // 断って settle ごと失敗させると job の成果まで捨てることになる
  const planned = ok(settleAction(s, second.actionId, {
    result: { note: '調べた' },
    next: { plan: { claimId: owned.claimId, kind: 'implement' } },
  }, T0 + MIN), 'settle-plan-kept');
  assert.equal(planned.keptTrigger, true);
  assert.equal(Object.keys(planned.snapshot.actions).length, 3, '次の一手を作っていない');
  assert.deepEqual(planned.snapshot.cases[caseId].nextTrigger, before.nextTrigger, '契機を奪っている');
  assert.equal(planned.snapshot.cases[caseId].state, before.state, 'state を動かしている');
  assert.deepEqual(validateSnapshot(planned.snapshot), []);

  // 契機が終わった Action を指していれば (= 生きていない) 従来どおり差し替わる
  const dead = structuredClone(s);
  dead.actions[owned.actionId].state = 'cancelled';
  dead.cases[caseId].nextTrigger = { ...before.nextTrigger, kind: 'runningAction' };
  const moved = settleAction(dead, second.actionId, {
    result: { note: '調べた' },
    next: { waiting: { reason: 'evidence', condition: '材料を待つ' } },
  }, T0 + MIN);
  assert.equal(moved.ok, true);
  assert.equal(moved.keptTrigger, false);
  assert.equal(moved.snapshot.cases[caseId].nextTrigger.reason, 'evidence');
});

test('契機の門: 契機が自分を指している settle は従来どおり差し替わる', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accepted').snapshot;
  assert.equal(s.cases[caseId].nextTrigger.actionId, owned.actionId);

  const settled = ok(settleAction(s, owned.actionId, {
    result: { note: '調べた' },
    next: { waiting: { reason: 'evidence', condition: '材料を待つ' } },
  }, T0 + MIN), 'settle-self');
  assert.equal(settled.keptTrigger, false);
  assert.equal(settled.snapshot.cases[caseId].state, 'waiting');
  assert.equal(settled.snapshot.cases[caseId].nextTrigger.reason, 'evidence');

  // 次の一手でも同じ (自分を指しているので差し替わる)
  const planned = ok(settleAction(s, owned.actionId, {
    result: { note: '調べた' },
    next: { plan: { claimId: owned.claimId, kind: 'implement' } },
  }, T0 + MIN), 'settle-self-plan');
  assert.equal(planned.snapshot.cases[caseId].state, 'active');
  assert.equal(planned.snapshot.cases[caseId].nextTrigger.kind, 'nextAction');
  assert.notEqual(planned.snapshot.cases[caseId].nextTrigger.actionId, owned.actionId);
});

test('不変条件: owner が居るのに waiting(offer) の Case は保存できない', () => {
  const { snapshot, caseId } = seed();
  // 担当が居ない open の既定の形は waiting(offer) — これは通る
  assert.equal(snapshot.cases[caseId].nextTrigger.reason, 'offer');
  assert.deepEqual(validateSnapshot(snapshot), []);

  const owned = withOwner(snapshot, caseId);
  const forged = structuredClone(owned.snapshot);
  forged.cases[caseId].state = 'waiting';
  forged.cases[caseId].nextTrigger = structuredClone(snapshot.cases[caseId].nextTrigger);
  const errors = validateSnapshot(forged);
  assert.ok(
    errors.some((e) => /owner が居るのに引受け待ちは読めない/.test(e)),
    errors.join(' | '),
  );
  // 引受け以外の待ちなら owner が居ても読める
  forged.cases[caseId].nextTrigger.reason = 'evidence';
  assert.deepEqual(validateSnapshot(forged), []);
});

test('待ちの復帰: 自分の照合待ちのときだけ active に戻る (他の待ちは保つ)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  // 別の理由で待っている Case (依存待ち — 受付が判明しても依存は満たされていない)
  const blocked = structuredClone(s);
  blocked.cases[caseId].state = 'waiting';
  blocked.cases[caseId].nextTrigger = {
    kind: 'waiting', reason: 'dependency', condition: 'C-9 が resolved になる',
    nextCheckAt: new Date(T0 + 30 * MIN).toISOString(), actionId: null,
  };
  const before = structuredClone(blocked.cases[caseId]);

  const out = ok(markAccepted(blocked, owned.actionId, { runId: 'run-1' }, T0 + MIN), 'accept');
  assert.equal(out.snapshot.actions[owned.actionId].state, 'accepted');
  assert.equal(out.snapshot.actions[owned.actionId].budget.charged, true);
  assert.equal(out.snapshot.cases[caseId].budget.charged, 1, '消費は確定する');
  // **依存待ちは保たれる** (受付記録は待ち条件の成立ではない)
  assert.equal(out.snapshot.cases[caseId].state, 'waiting');
  assert.deepEqual(out.snapshot.cases[caseId].nextTrigger, before.nextTrigger);
  assert.deepEqual(validateSnapshot(out.snapshot), []);
});

test('照合待ちの上書き: owner 不在の waiting(offer) は別 Action の照合で潰れない', () => {
  const { snapshot, caseId } = seed();
  // owner が実装中に辞退 → Case は waiting(offer)・investigator の Action だけ生きている
  const owner = withOwner(snapshot, caseId, { botKey: 'fable' });
  const impl = ok(offerClaim(owner.snapshot, { caseId, responsibility: 'investigator', botKey: 'opus' }, T0), 'offer');
  const acc = ok(acceptClaim(impl.snapshot, impl.claimId, {}, T0), 'accept');
  const planned = ok(planAction(acc.snapshot, { caseId, claimId: impl.claimId, kind: 'investigate' }, T0), 'plan');
  let s = ok(markSending(planned.snapshot, planned.actionId, {}, T0), 'sending').snapshot;
  s = ok(releaseClaim(s, owner.claimId, '手が離せない', T0 + MIN), 'release').snapshot;
  const offerWait = structuredClone(s.cases[caseId].nextTrigger);
  assert.equal(offerWait.reason, 'offer');
  assert.equal(s.cases[caseId].owner, null);

  // 別 Action の照合 / reconcile 化で「誰も引き受けていない」が消えないこと
  assert.deepEqual(markReconcile(s, planned.actionId, '不明', T0 + 2 * MIN).snapshot.cases[caseId].nextTrigger, offerWait);
  const swept = reconcileActions(s, { messageFor: () => null, runFor: () => null }, T0 + 2 * MIN);
  assert.deepEqual(swept.snapshot.cases[caseId].nextTrigger, offerWait);
  const timedOut = reconcileActions(s, { messageFor: () => null, runFor: () => null }, T0 + 10 * MIN);
  assert.deepEqual(timedOut.cancelled, [planned.actionId]);
  assert.deepEqual(timedOut.snapshot.cases[caseId].nextTrigger, offerWait);
  assert.deepEqual(validateSnapshot(timedOut.snapshot), []);
});

test('受付記録: reconcile へ倒れた Action に別の run を当てられない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm-1' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0), 'accept').snapshot;
  s = ok(markReconcile(s, owned.actionId, 'プロセスが消えた', T0 + MIN), 'reconcile').snapshot;

  const other = markAccepted(s, owned.actionId, { runId: 'run-2' }, T0 + 2 * MIN);
  assert.equal(other.ok, false);
  assert.equal(other.code, 'already-accepted');
  assert.equal(other.snapshot.actions[owned.actionId].delivery.runId, 'run-1', '記録済みの run を上書きしない');
  // 同じ run の再送は従来どおり通る (照合で見つかった場合)
  const same = ok(markAccepted(s, owned.actionId, { runId: 'run-1' }, T0 + 2 * MIN), 'same-run');
  assert.equal(same.snapshot.actions[owned.actionId].state, 'accepted');
  assert.equal(same.snapshot.cases[caseId].budget.charged, 1, '二重に計上しない');
});

test('cases.js に生の U+0000 が無い (rg がテキストとして扱える)', () => {
  const raw = readFileSync(resolve(ROOT, 'src/cases.js'));
  assert.equal(raw.includes(0), false, 'src/cases.js に生の NUL バイトがある — rg が binary 扱いして検索が切れる');
});

test('終結: closed は理由が要り、superseded は引き継ぐ Case を指す', () => {
  const { snapshot, caseId } = seed();
  assert.equal(closeCase(snapshot, caseId, { closeReason: 'なんとなく' }, T0).code, 'invalid');
  assert.equal(closeCase(snapshot, caseId, { closeReason: 'superseded' }, T0).code, 'invalid');

  const child = ok(createChildCase(snapshot, caseId, {
    desiredOutcome: '引き継ぎ先', acceptance: { condition: 'c', version: 1 },
  }, T0), 'child');
  const closed = ok(closeCase(child.snapshot, caseId, {
    closeReason: 'superseded', supersededBy: child.caseId,
  }, T0), 'close');
  assert.equal(closed.snapshot.cases[caseId].state, 'closed');
  assert.equal(closed.snapshot.cases[caseId].supersededBy, child.caseId);
  assert.equal(closed.snapshot.cases[child.caseId].supersedes, caseId);
});

// ---- 待ち・参照・観測 ----

test('waiting → active は条件成立の証拠と次の action を要る', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const settled = (() => {
    let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
    s = ok(markSent(s, owned.actionId, { messageId: 'm' }, T0), 'sent').snapshot;
    s = ok(markAccepted(s, owned.actionId, { runId: 'r' }, T0), 'accepted').snapshot;
    return ok(settleAction(s, owned.actionId, {
      result: { note: '依存が先' },
      next: { waiting: { reason: 'dependency', condition: 'C-2 が resolved になる' } },
    }, T0), 'settle').snapshot;
  })();
  assert.equal(settled.cases[caseId].state, 'waiting');
  // waiting のまま新しい action を積まない (何を待っているのかが消える)
  assert.equal(planAction(settled, { caseId, claimId: owned.claimId, kind: 'consult' }, T0).code, 'waiting');
  assert.equal(resumeFromWaiting(settled, caseId, {
    plan: { claimId: owned.claimId, kind: 'implement' },
  }, T0).code, 'evidence-required');

  const back = ok(resumeFromWaiting(settled, caseId, {
    evidence: { source: { kind: 'bot', botKey: 'opus' }, observed: { dependency: 'C-2 は resolved' } },
    plan: { claimId: owned.claimId, kind: 'implement' },
  }, T0 + MIN), 'resume');
  assert.equal(back.snapshot.cases[caseId].state, 'active');
  assert.equal(back.snapshot.cases[caseId].nextTrigger.kind, 'nextAction');
});

test('settle は次の契機を必ず付ける (付けない結果は保存できない)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  s = ok(markSent(s, owned.actionId, { messageId: 'm' }, T0), 'sent').snapshot;
  s = ok(markAccepted(s, owned.actionId, { runId: 'r' }, T0), 'accepted').snapshot;
  const bare = settleAction(s, owned.actionId, { result: { note: '調べただけ' } }, T0);
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'next-required');
});

test('links は明示的に結んだものだけを持つ (既存台帳の状態は写さない)', () => {
  const { snapshot, caseId } = seed();
  assert.equal(linkCase(snapshot, caseId, { kind: 'ticket', id: '7', role: 'x' }, T0).code, 'invalid');
  assert.equal(linkCase(snapshot, caseId, { kind: 'task', id: '77' }, T0).code, 'invalid');

  let s = ok(linkCase(snapshot, caseId, { kind: 'task', id: '77', role: '実装', revision: 3 }, T0), 'link').snapshot;
  s = ok(linkCase(s, caseId, { kind: 'task', id: '77', role: '実装', revision: 4 }, T0 + MIN), 'link2').snapshot;
  assert.equal(s.cases[caseId].links.length, 1);
  assert.equal(s.cases[caseId].links[0].revision, 4);
  // task の状態そのものは持たない
  assert.equal(/status|state/.test(JSON.stringify(s.cases[caseId].links)), false);
});

test('Observation / RoleTrial は S1 では形だけ (作れて保存できる)', () => {
  const { snapshot } = seed();
  const base = {
    purpose: '見落としを減らす',
    hypothesis: 'verify の失敗を duty で拾えば早く気づける',
    owner: 'fable',
    comparison: '旧版と新版の両方を同じ事例に当てる',
    deadline: { durationMin: 24 * 60, at: new Date(T0 + 24 * 60 * MIN).toISOString() },
  };
  const observation = ok(createObservation(snapshot, base, T0), 'observation');
  assert.equal(observation.id, 'O-1');
  assert.equal(observation.snapshot.observations['O-1'].decision, 'pending');
  const trial = ok(createRoleTrial(observation.snapshot, base, T0), 'roleTrial');
  assert.equal(trial.id, 'RT-1');
  assert.equal(createObservation(snapshot, { ...base, owner: '' }, T0).code, 'invalid');
});

test('C04: hold で預けた Action は状態も予約も動かさない (走査できなかったぶん)', () => {
  const { snapshot, caseId } = seed({ allocated: 3 });
  const owned = withOwner(snapshot, caseId);
  const sending = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  const nothing = { messageFor: () => null, runFor: () => null };

  // hold 無し = 従来どおり 2 分で取り消す
  const plain = reconcileActions(sending, nothing, T0 + 3 * MIN);
  assert.deepEqual(plain.cancelled, [owned.actionId]);

  // hold あり = 2 分を過ぎても触らない (pending に入るだけ)
  const held = reconcileActions(sending, nothing, T0 + 3 * MIN, { hold: [owned.actionId] });
  assert.deepEqual(held.cancelled, []);
  assert.deepEqual(held.pending, [owned.actionId]);
  assert.equal(held.snapshot.actions[owned.actionId].state, 'sending', '状態を動かさない');
  assert.deepEqual(held.snapshot.cases[caseId].budget, { allocated: 3, reserved: 1, charged: 0 }, '予約を返さない');
  assert.deepEqual(held.snapshot.cases[caseId].nextTrigger, sending.cases[caseId].nextTrigger);
  assert.deepEqual(validateSnapshot(held.snapshot), []);

  // 外側が見つかっても、預けている間は動かさない (次の tick でやり直す)
  const found = reconcileActions(sending, { messageFor: () => 'm-9', runFor: () => 'run-9' }, T0 + MIN, {
    hold: [owned.actionId],
  });
  assert.deepEqual(found.accepted, []);
  assert.equal(found.snapshot.actions[owned.actionId].state, 'sending');

  // hold を外せば従来どおり
  const released = reconcileActions(held.snapshot, nothing, T0 + 4 * MIN);
  assert.deepEqual(released.cancelled, [owned.actionId]);
  assert.deepEqual(released.snapshot.cases[caseId].budget, { allocated: 3, reserved: 0, charged: 0 });
});

test('C04: hold は他の Action の判断を止めない (Action 単位で預ける)', () => {
  const { snapshot, caseId } = seed({ allocated: 4 });
  const owned = withOwner(snapshot, caseId);
  let s = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  // 同じ Case にもう 1 本立てて送りに出す
  s.cases[caseId].state = 'active';
  const second = ok(planAction(s, { caseId, claimId: owned.claimId, kind: 'consult' }, T0), 'plan2');
  s = ok(markSending(second.snapshot, second.actionId, {}, T0), 'sending2').snapshot;

  const out = reconcileActions(s, { messageFor: () => null, runFor: () => null }, T0 + 3 * MIN, {
    hold: [owned.actionId],
  });
  // 預けた方はそのまま、預けていない方は従来どおり取り消される
  assert.deepEqual(out.pending, [owned.actionId]);
  assert.deepEqual(out.cancelled, [second.actionId]);
  assert.equal(out.snapshot.actions[owned.actionId].state, 'sending');
  assert.equal(out.snapshot.actions[second.actionId].state, 'cancelled');
  assert.deepEqual(validateSnapshot(out.snapshot), []);
});

test('C04: hold の指定は既定 (省略) の挙動を変えない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const sending = ok(markSending(owned.snapshot, owned.actionId, {}, T0), 'sending').snapshot;
  const probe = { messageFor: () => 'm-1', runFor: () => null };
  const bare = reconcileActions(sending, probe, T0 + MIN);
  for (const hold of [undefined, [], null, 'A-9', ['A-9']]) {
    const out = reconcileActions(sending, probe, T0 + MIN, hold === undefined ? undefined : { hold });
    assert.deepEqual(out.sent, bare.sent, JSON.stringify(hold));
    assert.deepEqual(out.snapshot, bare.snapshot, JSON.stringify(hold));
  }
});

test('Action は相談が伴う申し出と要旨を持てる (遷移は変わらない)', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const offered = ok(offerClaim(owned.snapshot, {
    caseId, responsibility: 'investigator', botKey: 'opus2',
  }, T0), 'offer');
  const planned = ok(planAction(offered.snapshot, {
    caseId,
    claimId: owned.claimId,
    kind: 'consult',
    offerClaimId: offered.claimId,
    note: '調査を引き受けてもらえるか聞く',
  }, T0), 'plan');

  const action = planned.snapshot.actions[planned.actionId];
  assert.equal(action.offerClaimId, offered.claimId);
  assert.equal(action.note, '調査を引き受けてもらえるか聞く');
  // 既定は null (相談でない Action は持たない)
  assert.equal(planned.snapshot.actions[owned.actionId].offerClaimId, null);
  assert.equal(planned.snapshot.actions[owned.actionId].note, null);
});

test('保存時: offerClaimId は同じ Case の Claim でなければならない', () => {
  const { snapshot, caseId } = seed();
  const owned = withOwner(snapshot, caseId);
  const offered = ok(offerClaim(owned.snapshot, {
    caseId, responsibility: 'investigator', botKey: 'opus2',
  }, T0), 'offer');
  const planned = ok(planAction(offered.snapshot, {
    caseId, claimId: owned.claimId, kind: 'consult', offerClaimId: offered.claimId,
  }, T0), 'plan');

  // 台帳に無い Claim を指す
  const ghost = structuredClone(planned.snapshot);
  ghost.actions[planned.actionId].offerClaimId = 'CL-99';
  assert.ok(validateSnapshot(ghost).some((e) => e.includes('offerClaimId が台帳に無い')));

  // 別の Case の Claim を指す (受諾すると責任が別の案件へ付く)
  const child = ok(createChildCase(planned.snapshot, caseId, {
    desiredOutcome: '別件', acceptance: { condition: 'c', version: 1 },
  }, T0), 'child');
  const other = ok(offerClaim(child.snapshot, {
    caseId: child.caseId, responsibility: 'owner', botKey: 'fable',
  }, T0), 'offer2');
  const crossed = structuredClone(other.snapshot);
  crossed.actions[planned.actionId].offerClaimId = other.claimId;
  assert.ok(validateSnapshot(crossed).some((e) => e.includes('別の Case')));
});
