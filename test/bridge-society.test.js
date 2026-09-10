import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectThreadPosts, createSocietyWiring, formatActionTag, readActionId, societyStartupLine,
} from '../src/bridge/society.js';
import { SocietyStore, initSocietyLedger } from '../src/society-store.js';
import {
  acceptClaim, addFinding, adoptFinding, closeCase, linkCase, offerClaim, planAction,
  registerMandate, validateSnapshot,
} from '../src/cases.js';

const T0 = Date.parse('2026-09-07T09:00:00.000Z');
const MIN = 60 * 1000;
const THREAD = 'T-100';

/** ログを配列で受け取る (出た回数まで見る) */
function recorder() {
  const lines = { log: [], error: [] };
  return { lines, log: { log: (m) => lines.log.push(m), error: (m) => lines.error.push(m) } };
}

/** Mandate → Finding → Case(open) → owner の Claim → planned な Action A-1 まで */
function seed(store, { allocated = null, targetBotKey = 'opus' } = {}) {
  const out = store.update(0, (s) => {
    let next = registerMandate(s, { key: 'quality', version: 1, state: 'active' }, T0).snapshot;
    const finding = addFinding(next, {
      mandateId: 'M-1',
      expected: 'verify が緑のまま',
      actual: 'NG が 3 日続いている',
      source: { kind: 'duty' },
      subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId: 'ep-1' },
    }, T0);
    next = adoptFinding(finding.snapshot, {
      findingId: finding.findingId,
      desiredOutcome: 'verify を緑に戻す',
      acceptance: { condition: 'npm test が全通過する', version: 1 },
      ...(allocated ? { budget: { allocated } } : {}),
    }, T0).snapshot;
    const offered = offerClaim(next, { caseId: 'C-1', responsibility: 'owner', botKey: 'fable' }, T0);
    return acceptClaim(offered.snapshot, offered.claimId, {
      plan: {
        claimId: offered.claimId,
        kind: 'investigate',
        target: { channel: 'society-trial', threadId: THREAD, botKey: targetBotKey },
      },
    }, T0).snapshot;
  });
  assert.equal(out.ok, true, `台帳を作れなかった: ${out.code} ${JSON.stringify(out.errors ?? out.reason)}`);
  return store;
}

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-society-wiring-'));
  const file = join(dir, 'society.json');
  let store = null;
  if (over.ledger !== 'absent') {
    if (over.ledger === 'broken') writeFileSync(file, '{ 壊れている');
    else initSocietyLedger(file, { now: T0 });
    store = new SocietyStore(file, { mode: 'observe', now: () => T0 });
    if (over.ledger !== 'broken' && over.seed !== false) seed(store, over.seed ?? {});
  } else {
    store = new SocietyStore(file, { mode: over.mode ?? 'observe' });
  }
  const posts = [];
  // actionId -> 実行記録 (id だけの略記も許す) / runId -> 実行記録
  const runs = new Map();
  const records = new Map();
  const rec = recorder();
  const state = {
    paused: false, accepting: true, ready: true, scanComplete: true, scanFailFor: null,
    sendError: null, nextMessageId: 100, onPost: null,
    // 権限の材料は**受諾の時点で読み直す**ので、テストから途中で変えられるようにする
    botFacts: over.botFacts ?? {
      fable: { runtime: 'claude', online: true },
      opus: { runtime: 'claude', online: true },
      opus2: { runtime: 'claude', online: true },
    },
    structuredOutput: over.structuredOutput ?? true,
    roster: over.roster ?? null,
  };
  // 設定は**テストから差し替えられる**ようにしておく (版上げの同期を見るため)
  const society = {
    mode: over.mode ?? 'observe', offerRecheckMin: over.offerRecheckMin ?? 5, authority: 'fable',
    mandates: over.mandates ?? {},
  };
  const wiring = createSocietyWiring({
    society,
    store: over.store === null ? null : store,
    pauseStore: { get paused() { return state.paused; } },
    lifecycle: { get accepting() { return state.accepting; } },
    jobRuns: {
      forAction: (id) => {
        if (!runs.has(id)) return [];
        const value = runs.get(id);
        return [typeof value === 'string' ? { id: value, startedAt: new Date(T0).toISOString(), outcome: null } : value];
      },
      get: (runId) => records.get(runId) ?? null,
    },
    postAs: async ({ botKey, threadId, text, mentionUserIds }) => {
      if (state.sendError) throw state.sendError;
      state.nextMessageId += 1;
      const post = { id: String(state.nextMessageId), content: text, botKey, threadId, mentionUserIds };
      posts.push(post);
      if (state.onPost) state.onPost(post);
      return post;
    },
    scanThread: async ({ threadId }) => ({
      complete: state.scanFailFor === threadId ? false : state.scanComplete,
      messages: state.scanFailFor === threadId
        ? []
        : posts.filter((p) => p.threadId === threadId).map((p) => ({ id: p.id, content: p.content })),
    }),
    botUserId: (key) => (over.missingUserId === key ? null : `U-${key}`),
    // 実効権限と配送の門が見る事実 (既定は全員 claude で起動済み)
    botFacts: () => state.botFacts,
    channelStructuredOutput: () => state.structuredOutput,
    threadRoster: () => state.roster,
    availableBotKeys: () => over.botKeys ?? ['fable', 'opus', 'opus2'],
    ready: () => state.ready,
    log: rec.log,
    now: () => T0,
  });
  return {
    dir, file, store, wiring, society, posts, runs, records, rec, state,
    action: () => store.snapshot.actions['A-1'],
    kase: () => store.snapshot.cases['C-1'],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withHarness(over, fn) {
  const h = harness(over);
  try {
    return await fn(h);
  } finally {
    h.cleanup();
  }
}

// ---- 印 ----

test('society 印: バッククォートの `案件:A-n` だけを読む', () => {
  assert.equal(formatActionTag('A-12'), '`案件:A-12`');
  assert.equal(formatActionTag('C-1'), '');
  assert.equal(readActionId('<@U1>\n案件 C-3 / investigate\n`案件:A-12`'), 'A-12');
  assert.equal(readActionId('案件:A-12'), null, 'バッククォート無しは印ではない');
  assert.equal(readActionId('[[handoff:opus]]'), null);
  assert.equal(readActionId(null), null);
});

// ---- (a) 正常一巡 ----

test('society 一巡: planned → 投稿 → sent → 受付 → running → settled', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    const before = h.store.revision;
    const tick = await h.wiring.societyTick(T0);
    assert.equal(tick.ran, true);
    assert.equal(tick.dispatched, 1);
    // ①意図 と ③結果 は**別の update** (境界の間で落ちても片方だけが残る)
    assert.equal(h.store.revision, before + 2);

    // ② 投稿は 1 件だけ・宛先以外の bot から・最終行が印
    assert.equal(h.posts.length, 1);
    const post = h.posts[0];
    assert.notEqual(post.botKey, 'opus', '宛先自身の client からは投げない');
    assert.deepEqual(post.mentionUserIds, ['U-opus']);
    assert.equal(post.threadId, THREAD);
    assert.equal(post.content.split('\n').pop(), '`案件:A-1`');
    assert.match(post.content, /案件 C-1 \/ investigate — verify を緑に戻す/);

    // ③ sent (messageId 付き)
    assert.equal(h.action().state, 'sent');
    assert.equal(h.action().delivery.messageId, post.id);

    // 受付側の照合 → 受付の保存
    const screened = h.wiring.screenAction({
      content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD,
    });
    assert.equal(screened.ok, true);
    assert.deepEqual(screened.action, { actionId: 'A-1', caseId: 'C-1', claimGeneration: 1 });

    assert.equal(h.wiring.noteAccepted('A-1', { runId: 'job-1' }).ok, true);
    assert.equal(h.action().state, 'accepted');
    assert.equal(h.action().delivery.runId, 'job-1');
    assert.deepEqual(h.kase().budget, { allocated: 4, reserved: 0, charged: 1 });

    assert.equal(h.wiring.noteRunning('A-1').ok, true);
    assert.equal(h.action().state, 'running');

    assert.equal(h.wiring.noteSettled('A-1', { runId: 'job-1', outcome: 'ok', reason: 'ok' }).ok, true);
    assert.equal(h.action().state, 'settled');
    assert.deepEqual(h.action().result, { outcome: 'ok', runId: 'job-1', reason: 'ok' });
    assert.equal(h.kase().state, 'waiting');
    assert.equal(h.kase().nextTrigger.reason, 'evidence');
    // Action は 1 件・消費は 1 回だけ
    assert.equal(Object.keys(h.store.snapshot.actions).length, 1);
    assert.equal(h.kase().budget.charged, 1);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

// ---- (b) 境界の注入 ----

test('society 境界①: 意図だけ保存して落ちても、送信は 1 回だけ', async () => {
  await withHarness({}, async (h) => {
    // ①の直後 = planned のまま。ここで落ちても外には何も出ていない
    assert.equal(h.action().state, 'planned');
    assert.equal(h.posts.length, 0);

    await h.wiring.societyTick(T0);
    assert.equal(h.posts.length, 1);
    // 再起動しても (tick を回し直しても) 二重に送らない
    await h.wiring.societyTick(T0 + MIN);
    await h.wiring.societyTick(T0 + 2 * MIN);
    assert.equal(h.posts.length, 1);
    assert.equal(Object.keys(h.store.snapshot.actions).length, 1);
  });
});

test('society 境界②: 投稿の前に落ちたら 2 分未満は pending、2 分以上で取り消して予約を返す', async () => {
  await withHarness({ seed: { allocated: 3 } }, async (h) => {
    // 投稿だけ落ちた形を作る (sending のまま外に何も無い)
    h.state.sendError = Object.assign(new Error('socket closed'), { name: 'Error' });
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'reconcile', '送達不明は照合へ回す');
    assert.equal(h.posts.length, 0);
    assert.equal(h.kase().budget.reserved, 1, 'まだ予約は返さない');

    // 2 分未満は pending のまま
    const early = await h.wiring.societyTick(T0 + 60 * 1000);
    assert.deepEqual(early.reconciled.cancelled, []);
    assert.equal(h.action().state, 'reconcile');
    assert.equal(h.kase().budget.reserved, 1);

    // 2 分以上で未受付が確定 → cancelled + 予約返却
    const late = await h.wiring.societyTick(T0 + 3 * MIN);
    assert.deepEqual(late.reconciled.cancelled, ['A-1']);
    assert.equal(h.action().state, 'cancelled');
    assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 0, charged: 0 });
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 境界③: 投稿後 sent の保存前に落ちても、照合が印を見つけて再送しない', async () => {
  await withHarness({}, async (h) => {
    // 投稿は出たが sent を書く前に落ちた形を手で作る
    const first = await h.wiring.societyTick(T0);
    assert.equal(first.dispatched, 1);
    const messageId = h.posts[0].id;
    h.store.update(h.store.revision, (s) => {
      s.actions['A-1'].state = 'sending';
      s.actions['A-1'].delivery.messageId = null;
      s.actions['A-1'].delivery.sentAt = null;
      return s;
    });
    assert.equal(h.action().state, 'sending');

    const tick = await h.wiring.societyTick(T0 + MIN);
    assert.deepEqual(tick.reconciled.sent, ['A-1']);
    assert.equal(h.action().state, 'sent');
    assert.equal(h.action().delivery.messageId, messageId);
    // **再送しない** (投稿は 1 件のまま)
    assert.equal(h.posts.length, 1);
    assert.equal(tick.dispatched, 0);
  });
});

test('society 境界③: 受付の保存前に落ちても、実行記録から accepted へ収束する', async () => {
  await withHarness({ seed: { allocated: 3 } }, async (h) => {
    await h.wiring.societyTick(T0);
    // 外では job が立っていたが markAccepted の前に落ちた
    h.runs.set('A-1', 'job-9');

    const tick = await h.wiring.societyTick(T0 + MIN);
    assert.deepEqual(tick.reconciled.accepted, ['A-1']);
    assert.equal(h.action().state, 'accepted');
    assert.equal(h.action().delivery.runId, 'job-9');
    assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 0, charged: 1 });

    // 何度回しても同じ (二重計上しない・Action は 1 件)
    for (let i = 0; i < 3; i += 1) await h.wiring.societyTick(T0 + (2 + i) * MIN);
    assert.equal(h.kase().budget.charged, 1);
    assert.equal(Object.keys(h.store.snapshot.actions).length, 1);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

// ---- (c) 送信の失敗 ----

test('society 送信: 4xx は取り消して予約を返し、5xx と例外は照合へ回す', async () => {
  await withHarness({ seed: { allocated: 2 } }, async (h) => {
    h.state.sendError = Object.assign(new Error('Missing Access'), { status: 403 });
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'cancelled', '送れていないことが確定 = 予約を返す');
    assert.deepEqual(h.kase().budget, { allocated: 2, reserved: 0, charged: 0 });
    assert.ok(h.rec.lines.error.some((l) => /送れませんでした/.test(l)), h.rec.lines.error.join(' | '));
  });

  await withHarness({ seed: { allocated: 2 } }, async (h) => {
    h.state.sendError = Object.assign(new Error('Service Unavailable'), { status: 503 });
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'reconcile', '送れたか分からない = 予約は返さない');
    assert.equal(h.kase().budget.reserved, 1);
  });

  await withHarness({ missingUserId: 'opus' }, async (h) => {
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'cancelled', '宛先の userId が無いのは送信が始まらない = failed');
    assert.equal(h.posts.length, 0);
  });

  await withHarness({ botKeys: ['opus'] }, async (h) => {
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'cancelled', '宛先以外の投げ手が居ない');
  });
});

// ---- (d) 受付側の照合 ----

test('society 受付: 印付きの起動は 6 種の食い違いを断る', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const post = h.posts[0];
    const base = { content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD };

    // 印なしは通す (通常のメンション)
    assert.deepEqual(h.wiring.screenAction({ content: '@Opus お願い' }), { ok: true, action: null });
    // (1) 台帳に無い
    assert.match(h.wiring.screenAction({ ...base, content: '`案件:A-99`' }).reason, /台帳に無い/);
    // (2) 宛先違い
    assert.match(h.wiring.screenAction({ ...base, botKey: 'fable' }).reason, /宛先は opus/);
    // (3) 別のスレッド
    assert.match(h.wiring.screenAction({ ...base, threadId: 'T-999' }).reason, /別のスレッド/);
    // (4) messageId 違い
    assert.match(h.wiring.screenAction({ ...base, messageId: '999' }).reason, /違う投稿/);
    // 正しい組み合わせは通る
    assert.equal(h.wiring.screenAction(base).ok, true);

    // (5) 終端の Case (受け付ける前に閉じられた)
    const closed = h.store.update(h.store.revision, (s) => closeCase(s, 'C-1', { closeReason: 'unnecessary' }, T0).snapshot);
    assert.equal(closed.ok, true);
    assert.match(h.wiring.screenAction(base).reason, /終端/);
  });

  // (6) 再配送 — 受け付けた後に同じ投稿がもう一度届いても起動しない
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const post = h.posts[0];
    const base = { content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD };
    assert.equal(h.wiring.screenAction(base).ok, true);
    h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    assert.match(h.wiring.screenAction(base).reason, /既に受け付け済み/);
  });

  // まだ送っていない Action の印で起動しない (本文の印だけでは実行できない)
  await withHarness({}, async (h) => {
    const refused = h.wiring.screenAction({ content: '`案件:A-1`', botKey: 'opus', threadId: THREAD });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /まだ送っていない/);
  });

  // 台帳を開けていない配備では印を信じない
  await withHarness({ ledger: 'broken' }, async (h) => {
    const refused = h.wiring.screenAction({ content: '`案件:A-1`', botKey: 'opus' });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /社会台帳を開けていません/);
  });
});

test('society 受付: off なら印を見ずに素通しする (通常の handoff を止めない)', async () => {
  await withHarness({ mode: 'off', store: null }, async (h) => {
    // 印の書き方を説明した文がそのまま次の bot へ渡る場面がある (受入 C15)
    const note = 'S2-2 では `案件:A-12` の印で送ります';
    assert.deepEqual(h.wiring.screenAction({ content: note, botKey: 'opus' }), { ok: true, action: null });
    assert.deepEqual(
      h.wiring.screenAction({ content: '`案件:A-1`', messageId: 'M9', botKey: 'opus', threadId: THREAD }),
      { ok: true, action: null },
    );
  });
});

test('society 受付: 投稿後 sent の保存前に落ちた起動も受け付け、投稿 ID を補完する', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const post = h.posts[0];
    // 境界② の形へ戻す (投稿は出ているが台帳は sending)
    h.store.update(h.store.revision, (s) => {
      s.actions['A-1'].state = 'sending';
      s.actions['A-1'].delivery.messageId = null;
      s.actions['A-1'].delivery.sentAt = null;
      return s;
    });

    const screened = h.wiring.screenAction({
      content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD,
    });
    assert.equal(screened.ok, true, '投稿は 1 回しか配信されないので、ここで断ると永久に走らない');
    assert.equal(screened.action.actionId, 'A-1');

    const noted = h.wiring.noteAccepted('A-1', { runId: 'job-1', messageId: post.id });
    assert.equal(noted.ok, true);
    assert.equal(h.action().state, 'accepted');
    assert.equal(h.action().delivery.messageId, post.id, '受付と同じ流れで投稿 ID も残す');
    assert.equal(h.action().delivery.runId, 'job-1');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 二重起動は runId の門が止める (印だけでは通らない)
    assert.match(h.wiring.screenAction({
      content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD,
    }).reason, /既に受け付け済み/);
  });
});

test('society 受付: 受付を保存できなければ ok にしない (キューへ渡さない材料)', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const first = h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    assert.equal(first.ok, true);
    // 別の run で二重に受け付けようとしたら断る
    const second = h.wiring.noteAccepted('A-1', { runId: 'job-2' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'already-accepted');
    assert.equal(h.action().delivery.runId, 'job-1');
  });
});

// ---- (e) 止める仕事の種類 ----

test('society 停止: pause / 受付停止は配送だけ止め、照合は回る', async () => {
  for (const [label, apply] of [
    ['paused', (s) => { s.paused = true; }],
    ['not-accepting', (s) => { s.accepting = false; }],
  ]) {
    await withHarness({}, async (h) => {
      apply(h.state);
      assert.deepEqual(h.wiring.stopReason(), { dispatch: label, reconcile: null });

      const tick = await h.wiring.societyTick(T0);
      assert.equal(tick.ran, true, label);
      assert.equal(tick.skipped, label);
      assert.equal(tick.dispatched, 0, label);
      assert.equal(h.posts.length, 0, `${label}: 新しい sending を作らない`);
      assert.equal(h.action().state, 'planned', label);
      assert.ok(tick.reconciled, `${label}: 照合は回る`);

      // 解ければ送る
      h.state.paused = false;
      h.state.accepting = true;
      const resumed = await h.wiring.societyTick(T0 + MIN);
      assert.equal(resumed.dispatched, 1, label);
      assert.equal(h.posts.length, 1, label);
    });
  }
});

test('society 停止: off / halted / ready 前は何もしない', async () => {
  await withHarness({ mode: 'off', store: null }, async (h) => {
    assert.deepEqual(h.wiring.stopReason(), { dispatch: 'off', reconcile: 'off' });
    const tick = await h.wiring.societyTick(T0);
    assert.deepEqual(tick, { ran: false, reason: 'off', skipped: 'off', at: T0 });
    assert.deepEqual(h.rec.lines, { log: [], error: [] }, 'off は 1 行も出さない');
  });

  await withHarness({ ledger: 'absent' }, async (h) => {
    assert.deepEqual(h.wiring.stopReason(), { dispatch: 'halted', reconcile: 'halted' });
    for (let i = 0; i < 3; i += 1) {
      const tick = await h.wiring.societyTick(T0 + i * 1000);
      assert.equal(tick.ran, false);
      assert.equal(tick.reason, 'halted');
    }
    assert.equal(h.rec.lines.error.length, 1, '同じ理由を tick のたびに撒かない');
    assert.match(h.rec.lines.error[0], /初回とは推測しません/);
  });

  // Discord が ready になるまでスレッド走査も投稿もしない
  await withHarness({}, async (h) => {
    h.state.ready = false;
    const tick = await h.wiring.societyTick(T0);
    assert.deepEqual(tick, { ran: false, reason: 'not-ready', skipped: 'not-ready', at: T0 });
    assert.equal(h.posts.length, 0);
    assert.deepEqual(h.rec.lines, { log: [], error: [] }, 'ready 待ちは異常ではない');

    h.state.ready = true;
    assert.equal((await h.wiring.societyTick(T0 + MIN)).dispatched, 1, 'ready 後の最初の tick から動く');
  });
});

// ---- (f) 未受付の期限と走査の完全性 ----

test('society 照合: 10 分受け付けられず、走査 complete・実行記録なしなら取り消す', async () => {
  await withHarness({ seed: { allocated: 3 } }, async (h) => {
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'sent');

    // 9 分では触らない
    const early = await h.wiring.societyTick(T0 + 9 * MIN);
    assert.deepEqual(early.reconciled.cancelled, []);
    assert.equal(h.action().state, 'sent');

    // 10 分 (offerRecheckMin 5 × 2) で未受付を確認 → 取り消して予約を返す
    const late = await h.wiring.societyTick(T0 + 10 * MIN);
    assert.deepEqual(late.reconciled.cancelled, ['A-1']);
    assert.equal(h.action().state, 'cancelled');
    assert.match(h.action().reason, /受付が無いことを確認/);
    assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 0, charged: 0 });
  });
});

test('society 照合: 実行記録があれば 10 分たっても取り消さない', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    h.runs.set('A-1', 'job-5');
    const tick = await h.wiring.societyTick(T0 + 20 * MIN);
    assert.deepEqual(tick.reconciled.cancelled, []);
    assert.equal(h.action().state, 'accepted');
  });
});

test('society 照合: 走査が不完全なら「見つからない」と決めず、判断を保留する', async () => {
  await withHarness({ seed: { allocated: 2 } }, async (h) => {
    await h.wiring.societyTick(T0);
    // 投稿は消えたことにし、走査も末尾まで届かない
    h.posts.length = 0;
    h.state.scanComplete = false;

    const tick = await h.wiring.societyTick(T0 + 30 * MIN);
    assert.deepEqual(tick.reconciled.held, ['A-1']);
    assert.deepEqual(tick.reconciled.cancelled, []);
    // **取り消さない** (届いている起動を落とさない)
    assert.equal(h.action().state, 'sent');
    assert.equal(h.kase().budget.reserved, 1);
    assert.ok(h.rec.lines.error.some((l) => /判断を保留します/.test(l)));

    // 走査が届くようになれば、そこで初めて確定する
    h.state.scanComplete = true;
    const done = await h.wiring.societyTick(T0 + 31 * MIN);
    assert.deepEqual(done.reconciled.cancelled, ['A-1']);
    assert.equal(h.action().state, 'cancelled');
    assert.equal(h.kase().budget.reserved, 0);
  });
});

test('society 照合: 走査できないスレッドがあっても、走査できたスレッドの後始末は止まらない', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    // 別スレッド (あとで走査できなくなる) の案件を 1 件足す
    h.store.update(h.store.revision, (s) => {
      const finding = addFinding(s, {
        mandateId: 'M-1',
        expected: 'x',
        actual: 'y',
        source: { kind: 'duty' },
        subject: { subjectId: 'task-88', conditionId: 'gone', episodeId: 'ep-2' },
      }, T0);
      let next = adoptFinding(finding.snapshot, {
        findingId: finding.findingId,
        desiredOutcome: '消えたスレッドの案件',
        acceptance: { condition: 'c', version: 1 },
      }, T0).snapshot;
      const offered = offerClaim(next, { caseId: 'C-2', responsibility: 'owner', botKey: 'fable' }, T0);
      next = acceptClaim(offered.snapshot, offered.claimId, {
        plan: {
          claimId: offered.claimId,
          kind: 'consult',
          target: { channel: 'society-trial', threadId: 'T-gone', botKey: 'opus' },
        },
      }, T0).snapshot;
      return next;
    });
    // 両方とも送る (A-1 は THREAD、A-2 は T-gone)
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'sent');
    assert.equal(h.store.snapshot.actions['A-2'].state, 'sent');
    // ここで T-gone が消える (走査できない = 投稿を確かめられない)
    h.state.scanFailFor = 'T-gone';

    const tick = await h.wiring.societyTick(T0 + 20 * MIN);
    assert.deepEqual(tick.reconciled.held, ['A-2'], '消えたスレッドの Action は保留する');
    assert.deepEqual(tick.reconciled.pending, ['A-2']);
    // **走査できたスレッドの A-1 は片付く** (予約も返る)
    assert.deepEqual(tick.reconciled.cancelled, ['A-1']);
    assert.equal(h.action().state, 'cancelled');
    assert.equal(h.kase().budget.reserved, 0);
    // 保留した方は触らない (届いている起動を落とさない)
    assert.equal(h.store.snapshot.actions['A-2'].state, 'sent');
    assert.equal(h.store.snapshot.cases['C-2'].budget.reserved, 1);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

// ---- S2-1 から続く表示 ----

test('society 表示: summary と起動ログは mode と台帳の状態で書き分ける', async () => {
  await withHarness({ mode: 'off', store: null }, async (h) => {
    assert.deepEqual(h.wiring.summary(), { mode: 'off' });
    assert.equal(societyStartupLine(h.wiring.summary()), null);
    assert.equal(existsSync(join(h.dir, 'never')), false);
  });

  await withHarness({}, async (h) => {
    const summary = h.wiring.summary();
    assert.equal(summary.state, 'ok');
    assert.equal(summary.healthy, true);
    assert.equal(summary.revision, 1);
    assert.deepEqual(summary.cases, { open: 0, active: 1, waiting: 0, verifying: 0, resolved: 0, closed: 0 });
    assert.match(societyStartupLine(summary), /mode=observe/);
    assert.match(societyStartupLine(summary), /案件 open 0 \/ active 1/);
  });

  await withHarness({ ledger: 'absent' }, async (h) => {
    const summary = h.wiring.summary();
    assert.equal(summary.cases, null, '開けていない台帳の件数を 0 と書かない');
    assert.match(societyStartupLine(summary), /^\[society\] ⛔/);
  });
});

test('society 配線: tick の例外は Promise 側へ落ちる (setInterval から漏らさない)', async () => {
  const exploding = {
    get healthy() { throw new Error('store が壊れた'); },
    get haltReason() { return null; },
  };
  const wiring = createSocietyWiring({
    society: { mode: 'observe' }, store: exploding, pauseStore: { paused: false },
    lifecycle: { accepting: true }, log: { log() {}, error() {} },
  });
  let caught = null;
  await wiring.societyTick(T0).catch((err) => { caught = err; });
  assert.match(caught?.message ?? '', /store が壊れた/);
});

// ---- Fable 検収 2026-09-07 の差し戻し分 ----

test('society 印: 最終行の印だけを読む (本文中の引用は通常の job)', () => {
  assert.equal(readActionId('<@U1>\n案件 C-3 / investigate\n`案件:A-12`'), 'A-12');
  assert.equal(readActionId('`案件:A-12`\n'), 'A-12', '後ろの空行は無視する');
  assert.equal(readActionId('  `案件:A-12`  '), 'A-12', '前後の空白は許す');
  // **引用は起動ではない** — observe で印を説明した報告が「受付済み」で拒否されない
  assert.equal(readActionId('対象: `案件:A-5` を見てください\n以上です'), null);
  assert.equal(readActionId('`案件:A-5` の話\n[[handoff:opus]]'), null);
  assert.equal(readActionId('報告です\n`案件:A-5` が対象でした。以上'), null, '印だけの行でなければ読まない');
  assert.equal(readActionId(''), null);
});

test('society 受付: 印を引用しただけの報告は通常の job として通る', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const screened = h.wiring.screenAction({
      content: '対象: `案件:A-1` を見て直しました\n以上です',
      messageId: 'M9', botKey: 'opus', threadId: THREAD,
    });
    assert.deepEqual(screened, { ok: true, action: null }, '契約を捨てずに通常の job として通す');
  });
});

test('society 照合: 走ったことのある記録だけを受付とみなす (幻の受付)', async () => {
  await withHarness({ seed: { allocated: 3 } }, async (h) => {
    await h.wiring.societyTick(T0);
    // 受付を開いたが台帳へ書けず cancel した記録 (startedAt 無し・outcome cancelled)
    h.runs.set('A-1', { id: 'job-ghost', startedAt: null, outcome: 'cancelled', reason: 'cancelled' });

    for (let i = 0; i < 2; i += 1) await h.wiring.societyTick(T0 + (1 + i) * MIN);
    assert.equal(h.action().state, 'sent', '走っていない記録で accepted にしない');
    assert.equal(h.action().budget.charged, false);
    assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 1, charged: 0 }, '予算を焼かない');

    // 走った記録 (startedAt あり) なら従来どおり受付とみなす
    h.runs.set('A-1', { id: 'job-real', startedAt: new Date(T0).toISOString(), outcome: 'ok' });
    const tick = await h.wiring.societyTick(T0 + 3 * MIN);
    assert.deepEqual(tick.reconciled.accepted, ['A-1']);
    assert.equal(h.action().delivery.runId, 'job-real');
  });
});

test('society 照合: 記録だけ終わっている accepted / running を settled にする', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted('A-1', { runId: 'job-dead' });
    assert.equal(h.action().state, 'accepted');

    // 記録がまだ生きているうちは触らない
    h.records.set('job-dead', { id: 'job-dead', outcome: null, reason: '' });
    const live = await h.wiring.societyTick(T0 + MIN);
    assert.deepEqual(live.reconciled.settled, []);
    assert.equal(h.action().state, 'accepted');

    // プロセスが死んで記録だけ終端になっていたら回収する
    h.records.set('job-dead', { id: 'job-dead', outcome: 'not-started', reason: 'process-gone' });
    const tick = await h.wiring.societyTick(T0 + 2 * MIN);
    assert.deepEqual(tick.reconciled.settled, ['A-1']);
    assert.equal(h.action().state, 'settled');
    assert.equal(h.action().result.outcome, 'not-started');
    assert.equal(h.kase().state, 'waiting');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 照合: 走査できないスレッドの Action は hold に入れ、他は毎 tick 判断する', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    // 別スレッドの案件を足して両方送る
    h.store.update(h.store.revision, (s) => {
      const finding = addFinding(s, {
        mandateId: 'M-1', expected: 'x', actual: 'y', source: { kind: 'duty' },
        subject: { subjectId: 'task-88', conditionId: 'gone', episodeId: 'ep-2' },
      }, T0);
      const next = adoptFinding(finding.snapshot, {
        findingId: finding.findingId,
        desiredOutcome: '消えたスレッドの案件',
        acceptance: { condition: 'c', version: 1 },
      }, T0).snapshot;
      const offered = offerClaim(next, { caseId: 'C-2', responsibility: 'owner', botKey: 'fable' }, T0);
      return acceptClaim(offered.snapshot, offered.claimId, {
        plan: {
          claimId: offered.claimId,
          kind: 'consult',
          target: { channel: 'society-trial', threadId: 'T-gone', botKey: 'opus' },
        },
      }, T0).snapshot;
    });
    await h.wiring.societyTick(T0);
    // A-1 を sending へ戻し (2 分ルールで取り消される側)、A-2 のスレッドは消える
    h.store.update(h.store.revision, (s) => {
      s.actions['A-1'].state = 'sending';
      s.actions['A-1'].delivery.messageId = null;
      s.actions['A-1'].delivery.sentAt = null;
      return s;
    });
    h.posts.length = 0;
    h.state.scanFailFor = 'T-gone';

    const tick = await h.wiring.societyTick(T0 + 5 * MIN);
    // **照合は毎 tick 回る** — 走査できた A-1 は 2 分ルールで取り消され、予約も返る
    assert.deepEqual(tick.reconciled.held, ['A-2']);
    assert.deepEqual(tick.reconciled.cancelled, ['A-1']);
    assert.equal(h.action().state, 'cancelled');
    assert.equal(h.kase().budget.reserved, 0);
    // 走査できなかった方は 1 ミリも動かない
    assert.equal(h.store.snapshot.actions['A-2'].state, 'sent');
    assert.equal(h.store.snapshot.cases['C-2'].budget.reserved, 1);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society: 台帳へ書けない (throw) は write-error で返し、例外を漏らさない', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const real = h.store.update.bind(h.store);
    h.store.update = () => { throw new Error('EACCES: data/society.json'); };
    const out = h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'write-error');
    assert.match(out.reason, /EACCES/);
    assert.ok(h.rec.lines.error.some((l) => /台帳へ書けませんでした/.test(l)));
    h.store.update = real;
  });
});

test('society 配送: 投稿中に受付が先に済んでも成功として数える', async () => {
  await withHarness({}, async (h) => {
    // postAs の最中に宛先 bot が受け取って受付まで済ませる
    h.state.onPost = (post) => {
      const screened = h.wiring.screenAction({
        content: post.content, messageId: post.id, botKey: 'opus', threadId: THREAD,
      });
      assert.equal(screened.ok, true);
      assert.equal(h.wiring.noteAccepted('A-1', { runId: 'job-fast', messageId: post.id }).ok, true);
    };
    const tick = await h.wiring.societyTick(T0);

    assert.equal(tick.dispatched, 1, '受付が先に済んだ配送も成功として数える');
    assert.equal(h.action().state, 'accepted');
    assert.equal(h.action().delivery.messageId, h.posts[0].id);
    assert.equal(h.action().delivery.runId, 'job-fast');
    assert.deepEqual(h.rec.lines.error, [], '誤ったエラーログを出さない');
    assert.ok(h.rec.lines.log.some((l) => /受付が先に済んでいます/.test(l)));
  });
});

// ---- 案件の 1 ターン (S2-3a) ----

/** A-1 を受け付けて running まで進めた状態 */
async function upToRunning(h) {
  await h.wiring.societyTick(T0);
  assert.equal(h.wiring.noteAccepted('A-1', { runId: 'job-1' }).ok, true);
  assert.equal(h.wiring.noteRunning('A-1').ok, true);
  return h.posts[0];
}

test('society 起動文: 戻りの様式と印を載せる', async () => {
  await withHarness({}, async (h) => {
    const post = await upToRunning(h);
    const lines = post.content.split('\n');
    assert.equal(lines.pop(), '`案件:A-1`', '印は最終行');
    assert.match(lines.pop(), /^`様式:case-turn`/);
    assert.match(post.content, /next\.plan/);
  });
});

test('society 文脈: 案件・決定権者・自分の Claim と世代・この起動を出す', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    const context = h.wiring.caseContext('A-1');
    assert.deepEqual(context, {
      caseId: 'C-1',
      desiredOutcome: 'verify を緑に戻す',
      authority: 'fable',
      claimId: 'CL-1',
      claimGeneration: 1,
      responsibility: 'owner',
      actionId: 'A-1',
      actionKind: 'investigate',
      mode: 'observe',
    });
    assert.equal(h.wiring.caseContext('A-99'), null, '知らない Action では文脈を作らない');
  });
});

test('society ターン: result の artifact で検収待ちへ、観測と主張を分けて残す', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '直しました',
      result: {
        artifact: 'commit-abc1234',
        observed: ['npm test 1589 件全通過'],
        claimed: ['たぶん根本原因も消えた'],
      },
      next: { waiting: { why: 'evidence', condition: '検収を待つ' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    assert.equal(out.settled, true);
    assert.equal(h.action().state, 'settled');
    assert.equal(h.action().result.artifact, 'commit-abc1234');
    // **成果物があれば検収待ち** (next.waiting より artifact が優先される)
    assert.equal(h.kase().state, 'verifying');
    const evidence = Object.values(h.store.snapshot.evidence).find((e) => e.actionId === 'A-1');
    assert.deepEqual(evidence.observed.facts, ['npm test 1589 件全通過']);
    assert.deepEqual(evidence.claimed.statements, ['たぶん根本原因も消えた']);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

// mode: active — `implement` は observe の門で断られる kind なので、
// 「plan が Action になる」ことを見るテストは active で回す (門そのものは別のテストで見る)
test('society ターン: next.plan は同じ担当・同じスレッドへ次の Action を積む', async () => {
  await withHarness({ mode: 'active', seed: { allocated: 4 } }, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '調べました',
      result: { observed: ['原因は verify の DRIFT'] },
      next: { plan: { kind: 'implement', summary: '索引の入力を絞る' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    const next = h.store.snapshot.actions['A-2'];
    assert.equal(next.state, 'planned');
    assert.equal(next.kind, 'implement');
    assert.equal(next.claimId, 'CL-1', '自分の Claim に結ぶ');
    assert.deepEqual(next.target, { channel: 'society-trial', threadId: THREAD, botKey: 'opus' });
    assert.equal(h.kase().state, 'active');
    assert.deepEqual(h.kase().nextTrigger, { kind: 'nextAction', actionId: 'A-2' });
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 次の tick でその Action が送られる (台帳を通った起動だけが出る)
    const tick = await h.wiring.societyTick(T0 + 2 * MIN);
    assert.equal(tick.dispatched, 1);
    assert.equal(h.posts.length, 2);
  });
});

test('society ターン: next.waiting は待ちの理由と条件を台帳へ写す', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '依存が先です',
      next: { waiting: { why: 'dependency', condition: 'C-2 が resolved になる' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    assert.equal(h.kase().state, 'waiting');
    assert.equal(h.kase().nextTrigger.reason, 'dependency');
    assert.equal(h.kase().nextTrigger.condition, 'C-2 が resolved になる');
    assert.ok(out.notes.some((n) => /dependency 待ち/.test(n)));
  });
});

test('society ターン: finding は Case とは独立に残る (原因が分からなくても保存できる)', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '別の食い違いに気づきました',
      finding: {
        expected: 'INDEX.md は commit 済のファイルだけを載せる',
        actual: '未追跡の draft が焼き込まれている',
        subject_id: 'doc/INDEX.md',
        condition_id: 'doc-index-drift',
      },
      next: { waiting: { why: 'evidence', condition: '決定権者の採否を待つ' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    const finding = h.store.snapshot.findings['F-2'];
    assert.equal(finding.disposition, 'pending', '採用は決定権者の判断 (勝手に Case を開かない)');
    assert.equal(finding.subject.subjectId, 'doc/INDEX.md');
    assert.equal(finding.subject.episodeId, 'C-1:doc-index-drift', 'episode はブリッジが決める');
    assert.equal(finding.source.kind, 'report');
    assert.ok(out.notes.some((n) => /F-2/.test(n)));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society ターン: 台帳が断ったら結果だけ残し、次の一手は作らない', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    // 停止マーカーが付いた案件 (人が止めた後に戻ってきた形)
    h.store.update(h.store.revision, (s) => {
      s.cases['C-1'].stop = { by: 'human', at: new Date(T0).toISOString(), actionId: null, sourceId: null, reason: null };
      return s;
    });
    const out = h.wiring.applyTurn('A-1', {
      body: '終わりました',
      result: { observed: ['直した'] },
      next: { plan: { kind: 'implement', summary: '続き' } },
    }, { at: T0 + MIN });

    assert.equal(out.settled, true);
    assert.equal(h.action().state, 'settled', '結果は残る');
    assert.equal(h.store.snapshot.actions['A-2'], undefined, '止めた案件に次の Action を積まない');
    assert.ok(out.notes.some((n) => /stopped/.test(n)));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society ターン: verify NG は成果を確定させず、次の一手も積まない', async () => {
  await withHarness({ seed: { allocated: 5 } }, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '直しました',
      result: { artifact: 'commit-abc', observed: ['直した'] },
      next: { plan: { kind: 'implement', summary: '続き' } },
    }, { verifyResult: { ok: false, command: 'npm test', code: 1 }, at: T0 + MIN });

    assert.equal(out.settled, true, '結果そのものは残す');
    assert.equal(h.action().state, 'settled');
    assert.equal(h.action().result.outcome, 'verify-failed');
    assert.equal(h.action().result.artifact, null, '検証が通っていない成果物は持たせない');
    // **検収待ちへ進めず、次の Action も積まない**
    assert.equal(h.kase().state, 'waiting');
    assert.equal(h.kase().nextTrigger.reason, 'evidence');
    assert.match(h.kase().nextTrigger.condition, /verify が通っていない/);
    assert.equal(h.store.snapshot.actions['A-2'], undefined);
    assert.ok(out.notes.some((n) => /verify NG のため/.test(n)), out.notes.join(' | '));
    // 証拠には verify の結果も残る
    const evidence = Object.values(h.store.snapshot.evidence).find((e) => e.actionId === 'A-1');
    assert.equal(evidence.observed.verify, 'failed');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society ターン: verify OK なら従来どおり進む', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '直しました',
      result: { artifact: 'commit-abc', observed: ['1611 件全通過'] },
      next: { waiting: { why: 'evidence', condition: '検収を待つ' } },
    }, { verifyResult: { ok: true, command: 'npm test' }, at: T0 + MIN });

    assert.equal(out.settled, true);
    assert.equal(h.action().result.outcome, 'ok');
    assert.equal(h.kase().state, 'verifying');
    const evidence = Object.values(h.store.snapshot.evidence).find((e) => e.actionId === 'A-1');
    assert.equal(evidence.observed.verify, 'ok');
    assert.equal(evidence.source.botKey, 'opus', '誰の観測かが残る');
  });
});

test('society ターン: 返す文言は実際に起きたことに合わせる', async () => {
  // artifact と next.plan を両方書かれたら、台帳は検収待ちへ進めて plan を作らない
  // (mode: active — `implement` は observe では門で断られるので、ここでは門の外で見る)
  await withHarness({ mode: 'active' }, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: 'できました',
      result: { artifact: 'commit-abc', observed: ['直した'] },
      next: { plan: { kind: 'implement', summary: '続き' } },
    }, { at: T0 + MIN });

    assert.equal(Object.keys(h.store.snapshot.actions).length, 1, 'Action は増えていない');
    assert.equal(h.kase().state, 'verifying');
    assert.equal(out.notes.some((n) => /次の一手/.test(n) && !/積んでいません/.test(n)), false,
      '立てていない次の一手を「立てました」と返している');
    assert.ok(out.notes.some((n) => /検収待ち/.test(n) && /next\.plan は積んでいません/.test(n)));
  });
});

test('society ターン: 気づきの出所に観測した bot が残る', async () => {
  await withHarness({}, async (h) => {
    await upToRunning(h);
    h.wiring.applyTurn('A-1', {
      body: 'x',
      finding: { expected: 'a', actual: 'b', subject_id: 's', condition_id: 'c' },
      next: { waiting: { why: 'evidence', condition: 'y' } },
    }, { at: T0 + MIN });
    assert.equal(h.store.snapshot.findings['F-2'].source.botKey, 'opus');
    assert.equal(h.store.snapshot.findings['F-2'].source.runId, 'job-1');
  });
});

test('society ターン: 知らない Action には何も書かない', async () => {
  await withHarness({}, async (h) => {
    const before = h.store.revision;
    const out = h.wiring.applyTurn('A-99', { body: 'x', next: { waiting: { why: 'evidence', condition: 'y' } } }, { at: T0 });
    assert.equal(out.ok, false);
    assert.equal(out.settled, false);
    assert.equal(h.store.revision, before);
  });
});

test('society: 変わらない照合では台帳を書かない (版を毎 tick 進めない)', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    const after = h.store.revision;
    // live な Action があるので照合は毎 tick 走るが、外側が変わっていなければ書かない
    await h.wiring.societyTick(T0 + MIN);
    await h.wiring.societyTick(T0 + 2 * MIN);
    assert.equal(h.store.revision, after, '内容が変わらないのに revision が進んでいる');
  });
});

// ---- 相談と受諾 (S2-3b) ----

/** owner の居ない open な Case を 1 件だけ持つ台帳 (相談の出発点) */
function openCase(store, { thread = true } = {}) {
  const out = store.update(0, (s) => {
    let next = registerMandate(s, {
      key: 'quality', version: 1, state: 'active', authority: 'fable', channels: ['society-trial'],
    }, T0).snapshot;
    const finding = addFinding(next, {
      mandateId: 'M-1', expected: 'verify が緑', actual: 'NG が続く', source: { kind: 'duty' },
      subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId: 'ep-1' },
    }, T0);
    next = adoptFinding(finding.snapshot, {
      findingId: finding.findingId,
      desiredOutcome: 'verify を緑に戻す',
      acceptance: { condition: 'npm test 全通過', version: 1 },
      budget: { allocated: 6 },
    }, T0).snapshot;
    if (!thread) return next;
    return linkCase(next, 'C-1', { kind: 'thread', id: THREAD, role: '案件のスレッド' }, T0).snapshot;
  });
  assert.equal(out.ok, true, `台帳を作れなかった: ${out.code}`);
  return store;
}

const CONSULT = {
  caseId: 'C-1', responsibility: 'owner', botKey: 'opus',
  channel: 'society-trial', summary: 'verify の原因を調べる',
};

test('society 相談: 1 つの update で authority の Claim・申し出・consult を作る', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const before = h.store.revision;
    const out = h.wiring.offer(CONSULT, T0);

    assert.equal(out.ok, true);
    assert.equal(h.store.revision, before + 1, '3 つを別々の版にしない');
    const s = h.store.snapshot;
    // authority の Claim は相談なしで accepted (相談を立てる根拠)
    const authority = Object.values(s.claims).find((c) => c.responsibility === 'authority');
    assert.equal(authority.botKey, 'fable');
    assert.equal(authority.state, 'accepted');
    // 引受けの申し出は offered のまま (責任はまだ移らない)
    assert.equal(s.claims[out.claimId].state, 'offered');
    assert.equal(s.claims[out.claimId].botKey, 'opus');
    assert.equal(s.cases['C-1'].owner, null);
    // 相談の Action は authority の Claim の下に立ち、申し出を指す
    const action = s.actions[out.actionId];
    assert.equal(action.kind, 'consult');
    assert.equal(action.claimId, authority.id);
    assert.equal(action.offerClaimId, out.claimId);
    assert.equal(action.note, 'verify の原因を調べる');
    assert.equal(action.target.threadId, THREAD, 'links の thread を宛先にする');
    assert.deepEqual(validateSnapshot(s), []);

    // 2 回目は authority の Claim を作り直さない
    const again = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0);
    assert.equal(again.ok, true);
    assert.equal(Object.values(h.store.snapshot.claims).filter((c) => c.responsibility === 'authority').length, 1);
  });
});

test('society 相談: tick で 1 件だけ投稿し、起動文に返し方を書く', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    h.wiring.offer(CONSULT, T0);
    const tick = await h.wiring.societyTick(T0);

    assert.equal(tick.dispatched, 1);
    assert.equal(h.posts.length, 1);
    const lines = h.posts[0].content.split('\n');
    assert.equal(lines.pop(), '`案件:A-1`');
    assert.match(lines.pop(), /^`様式:case-turn`/);
    assert.match(h.posts[0].content, /案件 C-1 \/ consult — owner の引受けの相談/);
    assert.match(h.posts[0].content, /claim\.decision: accept/);
    assert.match(h.posts[0].content, /next\.plan/);
    assert.match(h.posts[0].content, /decline` と理由/);
  });
});

/** 相談を送って受付・running まで進める */
async function consulted(h, over = {}) {
  openCase(h.store);
  const out = h.wiring.offer({ ...CONSULT, ...over }, T0);
  await h.wiring.societyTick(T0);
  h.wiring.noteAccepted(out.actionId, { runId: 'job-1' });
  h.wiring.noteRunning(out.actionId);
  return out;
}

test('society 受諾: accept + next.plan で active・世代 1・最初の一手が立つ', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '引き受けます',
      claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'verify のログを読む' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.actions[offered.actionId].state, 'settled', '相談は settle 済み');
    assert.equal(s.claims[offered.claimId].state, 'accepted');
    assert.equal(s.claims[offered.claimId].generation, 1);
    assert.equal(s.cases['C-1'].owner, offered.claimId);
    assert.equal(s.cases['C-1'].state, 'active');
    // 最初の一手は受諾と同じ update で立つ
    const next = Object.values(s.actions).find((a) => a.state === 'planned');
    assert.equal(next.kind, 'investigate');
    assert.equal(next.claimId, offered.claimId);
    assert.equal(next.target.botKey, 'opus');
    assert.equal(next.target.threadId, THREAD);
    assert.equal(next.note, 'verify のログを読む');
    assert.deepEqual(s.cases['C-1'].nextTrigger, { kind: 'nextAction', actionId: next.id });
    assert.ok(applied.notes.some((n) => /受諾しました \(世代 1\)/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);

    // 次の tick でその Action が送られる
    const tick = await h.wiring.societyTick(T0 + 2 * MIN);
    assert.equal(tick.dispatched, 1);
    assert.equal(h.posts.length, 2);
  });
});

test('society 受諾: investigator の受諾でも最初の一手が立ち、案件は引受け待ちのまま', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const out = h.wiring.offer({ ...CONSULT, responsibility: 'investigator' }, T0);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(out.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(out.actionId);
    const applied = h.wiring.applyTurn(out.actionId, {
      body: '調べます',
      claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'verify のログを読む' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.claims[out.claimId].state, 'accepted');
    assert.equal(s.claims[out.claimId].generation, 1);
    // **受けた Claim の下に、同じ update で最初の一手が立つ**
    const planned = Object.values(s.actions).find((a) => a.state === 'planned');
    assert.ok(planned, '最初の一手が立っていない');
    assert.equal(planned.claimId, out.claimId);
    assert.equal(planned.kind, 'investigate');
    assert.equal(planned.target.botKey, 'opus');
    assert.equal(planned.target.threadId, THREAD);
    // 担当 (owner) は決まっていないので、案件は open のまま引受けを待つ
    assert.equal(s.cases['C-1'].state, 'open');
    assert.equal(s.cases['C-1'].owner, null);
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'offer');
    assert.ok(applied.notes.some((n) => /最初の一手 A-\d+ を立てました/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 受諾: owner 付き案件への assessor の受諾は owner も契機も動かさない', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const first = h.wiring.offer(CONSULT, T0);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(first.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(first.actionId);
    h.wiring.applyTurn(first.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'a' } },
    }, { at: T0 + MIN });
    const before = structuredClone(h.store.snapshot.cases['C-1']);

    const second = h.wiring.offer({ ...CONSULT, responsibility: 'assessor', botKey: 'opus2' }, T0 + 2 * MIN);
    await h.wiring.societyTick(T0 + 2 * MIN);
    h.wiring.noteAccepted(second.actionId, { runId: 'job-2' });
    h.wiring.noteRunning(second.actionId);
    const applied = h.wiring.applyTurn(second.actionId, {
      body: '検収します', claim: { decision: 'accept' },
      next: { plan: { kind: 'assess', summary: '成果を見る' } },
    }, { at: T0 + 3 * MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.claims[second.claimId].state, 'accepted');
    const assess = Object.values(s.actions).find((a) => a.kind === 'assess');
    assert.ok(assess, 'assessor の最初の一手が立っていない');
    assert.equal(assess.claimId, second.claimId);
    assert.equal(s.cases['C-1'].owner, before.owner, 'owner が動いた');
    // 契機は owner の Action を指したまま (送信で nextAction → runningAction にはなる)
    assert.equal(s.cases['C-1'].nextTrigger.actionId, before.nextTrigger.actionId, '契機を奪っている');
    assert.equal(s.cases['C-1'].state, before.state);
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society ターン: 契機を保ったまま次の一手を立てたら、両方を注記に書く', async () => {
  // mode: active — 見たいのは注記の形で、observe の門 (`implement` を断る) はここでは要らない
  await withHarness({ mode: 'active', seed: { allocated: 6 } }, async (h) => {
    // 2 本目を立てる (契機は 1 本目のまま = S2-4a の規則 (c))
    let secondId = null;
    h.store.update(h.store.revision, (s) => {
      const out = planAction(s, {
        caseId: 'C-1',
        claimId: s.cases['C-1'].owner,
        kind: 'measure',
        target: { botKey: 'opus', threadId: THREAD, channel: 'society-trial' },
      }, T0);
      assert.equal(out.ok, true, `2 本目を立てられなかった: ${out.code}`);
      secondId = out.actionId;
      return out.snapshot;
    });
    assert.equal(h.store.snapshot.cases['C-1'].nextTrigger.actionId, 'A-1', '前提: 契機は 1 本目');

    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(secondId, { runId: 'job-2' });
    h.wiring.noteRunning(secondId);
    const applied = h.wiring.applyTurn(secondId, {
      body: '測りました',
      next: { plan: { kind: 'implement', summary: '直す' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    // **「立てました」と「契機はそのまま」の両方が 1 行で読める**
    const line = applied.notes.find((n) => /立てました/.test(n));
    assert.ok(line, applied.notes.join(' | '));
    assert.match(line, /次の一手 A-\d+ を立てました/);
    assert.match(line, /契機はそのまま \(owner は既に CL-1\)/);
    assert.equal(h.store.snapshot.cases['C-1'].nextTrigger.actionId, 'A-1', '契機を奪っている');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 受諾: owner の受諾に next.plan が無ければ受諾しない', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '引き受けます',
      claim: { decision: 'accept' },
      next: { waiting: { why: 'evidence', condition: '材料を待つ' } },
    }, { at: T0 + MIN });

    assert.equal(h.store.snapshot.claims[offered.claimId].state, 'offered', '受諾していない');
    assert.equal(h.store.snapshot.cases['C-1'].owner, null);
    assert.ok(applied.notes.some((n) => /最初の一手 \(`next\.plan`\) が要ります/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 相談: 返事を書かない job は next.plan で先へ進めない', async () => {
  // `claim` を書かずに次の一手だけ返されると、申し出は offered のまま (誰も引き受けていない)
  // なのに authority の Claim を借りて相談先が動き続ける (Opus2 指摘 2026-09-08)
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const before = Object.keys(h.store.snapshot.actions).length;
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: 'とりあえず調べます',
      next: { plan: { kind: 'investigate', summary: 'verify のログを読む' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.actions[offered.actionId].state, 'settled', '相談は settle 済み');
    assert.equal(Object.keys(s.actions).length, before, '返事が無いのに次の一手が立っている');
    assert.equal(s.claims[offered.claimId].state, 'offered');
    // 担当が居ない案件は open のまま (辞退のときと同じ) — 契機だけが「引受け待ち」になる
    assert.equal(s.cases['C-1'].owner, null);
    assert.equal(s.cases['C-1'].state, 'open');
    // 相談は契機を奪っていないので (S2-4a の規則 (d))、案件は引受け待ちのまま
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'offer');
    assert.ok(applied.notes.some((n) => /`claim\.decision` \(accept \/ decline\) が無い/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);

    // 待ちなので次の tick でも何も送らない
    const tick = await h.wiring.societyTick(T0 + 2 * MIN);
    assert.equal(tick.dispatched, 0);
    assert.equal(h.posts.length, 1);
  });
});

test('society 辞退: decline は理由付きで残り、案件は waiting(offer) のまま', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '手が離せません',
      claim: { decision: 'decline', reason: '別の案件で手一杯です' },
      next: { waiting: { why: 'offer', condition: '別の担当を探す' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.claims[offered.claimId].state, 'declined');
    assert.equal(s.claims[offered.claimId].reason, '別の案件で手一杯です');
    assert.equal(s.cases['C-1'].owner, null);
    // 次の契機は「引受けを待つ」— 誰へ声を掛けるかが読める
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'offer');
    assert.ok(applied.notes.some((n) => /↩️ 辞退を記録しました/.test(n)));
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 受諾: 二人同時なら先に保存した方が owner、二人目は declined で理由が残る', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const first = h.wiring.offer(CONSULT, T0);
    const second = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0);
    await h.wiring.societyTick(T0);
    for (const o of [first, second]) {
      h.wiring.noteAccepted(o.actionId, { runId: `job-${o.actionId}` });
      h.wiring.noteRunning(o.actionId);
    }
    const before = Object.keys(h.store.snapshot.actions).length;

    h.wiring.applyTurn(first.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'a' } },
    }, { at: T0 + MIN });
    const late = h.wiring.applyTurn(second.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'b' } },
    }, { at: T0 + 2 * MIN });

    const s = h.store.snapshot;
    assert.equal(s.cases['C-1'].owner, first.claimId);
    assert.equal(s.claims[first.claimId].state, 'accepted');
    // **二人目は declined で理由が台帳に残る** (C03)
    assert.equal(s.claims[second.claimId].state, 'declined');
    assert.match(s.claims[second.claimId].reason, /同一責務 \(owner\) の accepted は同時 1 件/);
    assert.ok(late.notes.some((n) => /既に別の担当が受諾済みです \(occupied\)/.test(n)), late.notes.join(' | '));
    // Action は 1 件だけ増える (二人目の plan は積まれない)
    assert.equal(Object.keys(s.actions).length, before + 1);
    // **二人目の返事が owner の契機を潰さない** (Fable 検収 2026-09-08)
    const owners = Object.values(s.actions).find((a) => a.state === 'planned');
    assert.equal(s.cases['C-1'].state, 'active');
    assert.deepEqual(s.cases['C-1'].nextTrigger, { kind: 'nextAction', actionId: owners.id });
    assert.ok(late.notes.some((n) => /次の契機はそのままです/.test(n)), late.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 受諾: owner が決まった後の 2 通目の返事は owner の契機を潰さない', async () => {
  // 辞退・返事なしでも同じ — owner の Action が生きている限り契機は動かない
  const replies = {
    occupied: {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'b' } },
    },
    decline: {
      body: '手が離せません', claim: { decision: 'decline', reason: '別の案件で手一杯' },
      next: { waiting: { why: 'offer', condition: '別の担当を探す' } },
    },
    '返事なし': { body: '調べておきます', next: { plan: { kind: 'investigate', summary: 'b' } } },
  };
  for (const [label, reply] of Object.entries(replies)) {
    await withHarness({ seed: false }, async (h) => {
      openCase(h.store);
      const first = h.wiring.offer(CONSULT, T0);
      const second = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0);
      await h.wiring.societyTick(T0);
      for (const o of [first, second]) {
        h.wiring.noteAccepted(o.actionId, { runId: `job-${o.actionId}` });
        h.wiring.noteRunning(o.actionId);
      }
      h.wiring.applyTurn(first.actionId, {
        body: 'やります', claim: { decision: 'accept' },
        next: { plan: { kind: 'investigate', summary: 'a' } },
      }, { at: T0 + MIN });
      const owners = Object.values(h.store.snapshot.actions).find((a) => a.state === 'planned');
      const before = Object.keys(h.store.snapshot.actions).length;

      const late = h.wiring.applyTurn(second.actionId, reply, { at: T0 + 2 * MIN });
      assert.equal(late.ok, true, label);
      const s = h.store.snapshot;
      const kase = s.cases['C-1'];
      assert.equal(kase.owner, first.claimId, label);
      assert.equal(kase.state, 'active', label);
      assert.deepEqual(kase.nextTrigger, { kind: 'nextAction', actionId: owners.id }, label);
      assert.equal(s.actions[owners.id].state, 'planned', label);
      assert.equal(Object.keys(s.actions).length, before, `${label}: 余計な Action が増えている`);
      // 返事の記録は残る
      if (label === '返事なし') {
        assert.equal(s.claims[second.claimId].state, 'offered', label);
        assert.ok(late.notes.some((n) => /`claim\.decision` \(accept \/ decline\) が無い/.test(n)), label);
      } else {
        assert.equal(s.claims[second.claimId].state, 'declined', label);
        assert.ok(String(s.claims[second.claimId].reason ?? '').length > 0, `${label}: 理由が無い`);
      }
      assert.ok(late.notes.some((n) => /次の契機はそのままです/.test(n)), `${label}: ${late.notes.join(' | ')}`);
      assert.deepEqual(validateSnapshot(s), [], label);
    });
  }
});

test('society 取り消し: owner の Action が送信前に取り消されても waiting(offer) にはならない', async () => {
  // owner は居るのに「引受け待ち」= 誰も満たせない条件で止まる形を作らない
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const first = h.wiring.offer(CONSULT, T0);
    const second = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0);
    await h.wiring.societyTick(T0);
    for (const o of [first, second]) {
      h.wiring.noteAccepted(o.actionId, { runId: `job-${o.actionId}` });
      h.wiring.noteRunning(o.actionId);
    }
    h.wiring.applyTurn(first.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'a' } },
    }, { at: T0 + MIN });
    h.wiring.applyTurn(second.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'b' } },
    }, { at: T0 + 2 * MIN });
    const owners = Object.values(h.store.snapshot.actions).find((a) => a.state === 'planned');

    // 宛先 bot が落ちた → 送る前に取り消される
    h.state.botFacts.opus = { runtime: 'claude', online: false };
    await h.wiring.societyTick(T0 + 3 * MIN);

    const s = h.store.snapshot;
    assert.equal(s.actions[owners.id].state, 'cancelled');
    assert.equal(s.cases['C-1'].owner, first.claimId, 'owner が消えている');
    assert.equal(s.cases['C-1'].nextTrigger.kind, 'waiting');
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'reconcile', 'A-3 の取り消しによる待ちになっていない');
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 相談: owner が決まった後に出した相談は owner の契機を奪わない', async () => {
  // S2-4a の規則 (c) で相談は契機を取らないので、S2-3b の `waiting(authority)` の借用は不要になった
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const first = h.wiring.offer(CONSULT, T0);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(first.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(first.actionId);
    h.wiring.applyTurn(first.actionId, {
      body: 'やります', claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'a' } },
    }, { at: T0 + MIN });

    // owner が決まった後に別責務の相談を出す (契機はその相談へ移る)
    const third = h.wiring.offer({
      ...CONSULT, responsibility: 'implementer', botKey: 'opus2',
    }, T0 + 2 * MIN);
    assert.equal(third.ok, true, `相談を作れなかった: ${third.code}`);
    const owners = Object.values(h.store.snapshot.actions).find((a) => a.kind === 'investigate');
    assert.equal(
      h.store.snapshot.cases['C-1'].nextTrigger.actionId, owners.id,
      '相談が owner の契機を奪っている',
    );
    await h.wiring.societyTick(T0 + 2 * MIN);
    h.wiring.noteAccepted(third.actionId, { runId: 'job-3' });
    h.wiring.noteRunning(third.actionId);

    const late = h.wiring.applyTurn(third.actionId, {
      body: '手が離せません',
      claim: { decision: 'decline', reason: '別の案件で手一杯' },
      next: { waiting: { why: 'offer', condition: '別の担当を探す' } },
    }, { at: T0 + 3 * MIN });

    assert.equal(late.ok, true, late.notes.join(' | '));
    const s = h.store.snapshot;
    assert.equal(s.cases['C-1'].owner, first.claimId, 'owner が消えている');
    // 契機は owner の Action を指したまま (`waiting(offer)` を書いても採用されない)
    assert.equal(s.cases['C-1'].nextTrigger.actionId, owners.id);
    assert.equal(s.cases['C-1'].state, 'active');
    assert.equal(s.claims[third.claimId].state, 'declined');
    assert.ok(late.notes.some((n) => /次の契機はそのままです/.test(n)), late.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 配送: 取り消した相談の申し出は同じ update で declined になる', async () => {
  // `offered` のまま残すと、誰も返事をしない申し出が S2-4 の期限 tick まで宙に浮く
  await withHarness({ seed: false, botFacts: { fable: { runtime: 'claude', online: true }, opus: { runtime: 'claude', online: false } } }, async (h) => {
    openCase(h.store);
    const out = h.wiring.offer(CONSULT, T0);
    assert.equal(h.store.snapshot.claims[out.claimId].state, 'offered');

    const tick = await h.wiring.societyTick(T0);
    assert.equal(tick.dispatched, 0);
    const s = h.store.snapshot;
    assert.equal(s.actions[out.actionId].state, 'cancelled');
    assert.equal(s.claims[out.claimId].state, 'declined');
    assert.match(s.claims[out.claimId].reason, /相談を送れませんでした/);
    // 相談は契機を取っていないので、取り消しても案件は引受け待ちのまま
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'offer');
    assert.deepEqual(validateSnapshot(s), []);
  });
});

test('society 受諾: 実効権限の再検証に落ちたら declined + 理由', async () => {
  // **相談を出したときは通っていて、受諾の時点で落ちる**形にする —
  // 「申し出たときに通ったこと」は受諾の根拠にならない、が要点 (§3・C05)
  const breaks = {
    codex: (h) => { h.state.botFacts.opus = { runtime: 'codex', online: true }; },
    '未起動': (h) => { h.state.botFacts.opus = { runtime: 'claude', online: false }; },
    'channels 外': (h) => h.store.update(h.store.revision, (s) => {
      s.mandates['M-1'].channels = ['ほかのチャンネル'];
      return s;
    }),
    'roster 外': (h) => { h.state.roster = ['fable']; },
  };
  for (const [label, breakIt] of Object.entries(breaks)) {
    await withHarness({ seed: false }, async (h) => {
      const offered = await consulted(h);
      breakIt(h);
      const applied = h.wiring.applyTurn(offered.actionId, {
        body: 'やります', claim: { decision: 'accept' },
        next: { plan: { kind: 'investigate', summary: 'a' } },
      }, { at: T0 + MIN });

      const claim = h.store.snapshot.claims[offered.claimId];
      assert.equal(claim.state, 'declined', label);
      assert.match(claim.reason, /実効権限の再検証/, label);
      assert.ok(applied.notes.some((n) => /実効権限の再検証で落ちました/.test(n)), `${label}: ${applied.notes.join(' | ')}`);
      assert.equal(h.store.snapshot.cases['C-1'].owner, null, label);
      assert.deepEqual(validateSnapshot(h.store.snapshot), [], label);
    });
  }
});

test('society 相談: claim を書かない戻りは Claim を offered のまま残す', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '見ました',
      next: { waiting: { why: 'evidence', condition: '材料を待つ' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    assert.equal(h.store.snapshot.claims[offered.claimId].state, 'offered', '期限は S2-4 の tick が見る');
    assert.equal(h.store.snapshot.actions[offered.actionId].state, 'settled');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 相談: 相談でない job の claim は無視して警告する', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    h.wiring.noteRunning('A-1');
    const applied = h.wiring.applyTurn('A-1', {
      body: 'やります',
      claim: { decision: 'accept' },
      next: { waiting: { why: 'evidence', condition: 'x' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    assert.ok(applied.notes.some((n) => /この job は相談ではありません/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 配送: 構造化の戻りを返せない宛先へは送らず、予約を返す', async () => {
  const cases = [
    ['codex', { botFacts: { fable: { runtime: 'claude', online: true }, sol: { runtime: 'codex', online: true } }, botKeys: ['fable', 'sol'] }, 'sol'],
    ['未起動', { botFacts: { fable: { runtime: 'claude', online: true }, opus: { runtime: 'claude', online: false } } }, 'opus'],
    ['structuredOutput false', { structuredOutput: false }, 'opus'],
  ];
  for (const [label, over, botKey] of cases) {
    await withHarness({ seed: { allocated: 3, targetBotKey: botKey }, ...over }, async (h) => {
      const tick = await h.wiring.societyTick(T0);
      assert.equal(tick.dispatched, 0, label);
      assert.equal(h.posts.length, 0, `${label}: 投稿している`);
      assert.equal(h.action().state, 'cancelled', label);
      assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 0, charged: 0 }, `${label}: 予約が返っていない`);
      assert.ok(h.rec.lines.error.some((l) => /送りません/.test(l)), label);
      assert.deepEqual(validateSnapshot(h.store.snapshot), [], label);
    });
  }
});

test('society 配送: 宛先スレッドが決まっていない相談は送らず、予約を返す', async () => {
  // スレッドが無いまま送ると postAs が落ちて照合へ回り、走査できないので hold に入って
  // 予約を握ったまま戻ってこない (Opus2 指摘 ② 2026-09-08) — 送る前に断る
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store, { thread: false });
    const out = h.wiring.offer(CONSULT, T0);
    assert.equal(out.ok, true, `相談を作れなかった: ${out.code}`);
    assert.equal(h.action().target.threadId, null, '前提: スレッドが決まっていない');
    assert.equal(h.kase().budget.reserved, 1);

    const tick = await h.wiring.societyTick(T0);
    assert.equal(tick.dispatched, 0);
    assert.equal(h.posts.length, 0, '投稿している');
    assert.equal(h.action().state, 'cancelled');
    assert.equal(h.kase().budget.reserved, 0, '予約を握ったまま');
    assert.ok(h.rec.lines.error.some((l) => /スレッドが決まっていません/.test(l)), h.rec.lines.error.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

// ---- Mandate の写しの同期 (§2) ----

const MANDATES = {
  quality: { key: 'quality', version: 1, goal: 'verify を緑に保つ', channels: ['society-trial'], state: 'active', authority: 'fable' },
};

test('society 写し: 設定の Mandate を key + version で台帳へ写す', async () => {
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    const first = h.wiring.syncMandates(T0);
    assert.equal(first.ok, true);
    assert.deepEqual(first.added.map((a) => [a.key, a.version]), [['quality', 1]]);
    const copied = Object.values(h.store.snapshot.mandates);
    assert.equal(copied.length, 1);
    assert.equal(copied[0].key, 'quality');
    assert.equal(copied[0].version, 1);
    assert.equal(copied[0].authority, 'fable');
    assert.deepEqual(copied[0].channels, ['society-trial']);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 既存の版は触らない (revision も動かない)
    const revision = h.store.revision;
    const again = h.wiring.syncMandates(T0 + MIN);
    assert.deepEqual(again.added, []);
    assert.equal(h.store.revision, revision, '同じ版で書き込んでいる');
  });
});

test('society 写し: 版を上げたら新しい記録が増え、古い版は残る', async () => {
  const mandates = { quality: { ...MANDATES.quality, version: 2, goal: '新しい目的' } };
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    h.wiring.syncMandates(T0);
    // 設定を差し替える (同じ wiring が読む society.mandates を書き換える)
    h.society.mandates = mandates;
    const bumped = h.wiring.syncMandates(T0 + MIN);
    assert.deepEqual(bumped.added.map((a) => [a.key, a.version]), [['quality', 2]]);
    const copied = Object.values(h.store.snapshot.mandates).sort((a, b) => a.version - b.version);
    assert.deepEqual(copied.map((m) => m.version), [1, 2], '古い版が消えている');
    assert.equal(copied[0].goal, 'verify を緑に保つ', '走っている Case が見る版が動いた');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 写し: 複数の Mandate も 1 つの update にまとめる', async () => {
  const mandates = {
    quality: MANDATES.quality,
    speed: { key: 'speed', version: 1, goal: '待ち時間を短くする', channels: [], state: 'active', authority: 'fable' },
  };
  await withHarness({ seed: false, mandates }, async (h) => {
    const before = h.store.revision;
    const out = h.wiring.syncMandates(T0);
    assert.equal(out.added.length, 2);
    assert.equal(h.store.revision, before + 1, '1 件ずつ書いている');
  });
});

test('society 写し: ready 後の最初の tick で 1 回だけ走る', async () => {
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    assert.deepEqual(Object.keys(h.store.snapshot.mandates), []);
    await h.wiring.societyTick(T0);
    assert.equal(Object.keys(h.store.snapshot.mandates).length, 1);
    const revision = h.store.revision;
    await h.wiring.societyTick(T0 + MIN);
    assert.equal(h.store.revision, revision, '毎 tick 書いている');
  });
});

// ---- 相談の期限 (§4) ----

test('society 期限: 相談が終わって 5 分たった申し出は expired になる', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const out = h.wiring.offer(CONSULT, T0);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(out.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(out.actionId);
    // 返事なしで相談だけ終わる
    h.wiring.applyTurn(out.actionId, {
      body: '見ました', next: { waiting: { why: 'evidence', condition: '材料を待つ' } },
    }, { at: T0 + MIN });
    assert.equal(h.store.snapshot.claims[out.claimId].state, 'offered');

    // まだ 5 分たっていない
    assert.deepEqual(h.wiring.expireOffers(T0 + 2 * MIN).expired, []);
    assert.equal(h.store.snapshot.claims[out.claimId].state, 'offered');

    const expired = h.wiring.expireOffers(T0 + 6 * MIN);
    assert.deepEqual(expired.expired, [out.claimId]);
    const claim = h.store.snapshot.claims[out.claimId];
    assert.equal(claim.state, 'expired');
    assert.match(claim.reason, /返事がないまま 6 分/);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 期限: 相談がまだ生きている申し出は触らない', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const out = h.wiring.offer(CONSULT, T0);
    // planned のまま (まだ送ってもいない)
    assert.deepEqual(h.wiring.expireOffers(T0 + 60 * MIN).expired, []);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(out.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(out.actionId);
    // 走っている最中も触らない (返ってきた受諾を not-offered で弾かないため)
    assert.deepEqual(h.wiring.expireOffers(T0 + 60 * MIN).expired, []);
    assert.equal(h.store.snapshot.claims[out.claimId].state, 'offered');
  });
});

test('society 期限: 何件あっても 1 つの update にまとめる', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const first = h.wiring.offer(CONSULT, T0);
    const second = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0);
    await h.wiring.societyTick(T0);
    for (const o of [first, second]) {
      h.wiring.noteAccepted(o.actionId, { runId: `job-${o.actionId}` });
      h.wiring.noteRunning(o.actionId);
      h.wiring.applyTurn(o.actionId, {
        body: '見ました', next: { waiting: { why: 'evidence', condition: 'x' } },
      }, { at: T0 + MIN });
    }
    const before = h.store.revision;
    const out = h.wiring.expireOffers(T0 + 6 * MIN);
    assert.deepEqual(out.expired.sort(), [first.claimId, second.claimId].sort());
    assert.equal(h.store.revision, before + 1, '1 件ずつ書いている');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 期限: tick は照合の後に期限を見て、結果に載せる', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const out = h.wiring.offer(CONSULT, T0);
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(out.actionId, { runId: 'job-1' });
    h.wiring.noteRunning(out.actionId);
    h.wiring.applyTurn(out.actionId, {
      body: '見ました', next: { waiting: { why: 'evidence', condition: 'x' } },
    }, { at: T0 + MIN });
    const tick = await h.wiring.societyTick(T0 + 6 * MIN);
    assert.deepEqual(tick.expired, [out.claimId]);
  });
});

// ---- /status の材料 ----

test('society 集計: 保留・待ちの内訳・期限切れを summary に出す', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const bare = h.wiring.summary(T0);
    assert.equal(bare.held, 0);
    // open の Case は既定で引受け待ち。nextCheckAt はまだ先
    assert.deepEqual(bare.waiting, { offer: 1 });
    assert.equal(bare.overdue, 0);
    // 再確認時刻を過ぎたら期限切れとして数える
    const late = h.wiring.summary(T0 + 24 * 60 * MIN);
    assert.equal(late.overdue, 1);
  });
});

test('society 集計: 照合で hold に入った件数を持ち越す', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    await h.wiring.societyTick(T0);
    // 走査できない = 投稿を見つけられない → hold (取り消して良いと決められない)
    h.state.scanFailFor = THREAD;
    await h.wiring.societyTick(T0 + 11 * MIN);
    assert.equal(h.wiring.summary(T0 + 11 * MIN).held, 1);
    assert.equal(h.action().state, 'sent', 'hold なのに動かしている');
  });
});

// ---- /case の口 ----

test('/case 一覧: 進行中だけを担当と契機つきで出す', async () => {
  await withHarness({ seed: false }, async (h) => {
    assert.match(h.wiring.caseCommand({ action: 'list' }), /進行中の案件はありません/);
    openCase(h.store);
    const listed = h.wiring.caseCommand({ action: 'list' });
    assert.match(listed, /進行中の案件 1 件/);
    assert.match(listed, /\*\*C-1\*\* `open` \/ 担当なし \/ verify を緑に戻す/);
    assert.match(listed, /待ち \(offer\)/);

    // 終結した案件は出さない (いま見るものが埋もれる)
    const closed = h.store.update(h.store.revision, (s) => {
      const out = closeCase(s, 'C-1', { closeReason: 'unnecessary', note: 'やめた' }, T0);
      assert.equal(out.ok, true, `閉じられなかった: ${out.code} ${out.reason ?? ''}`);
      return out.snapshot;
    });
    assert.equal(closed.ok, true, `保存できなかった: ${closed.code}`);
    assert.match(h.wiring.caseCommand({ action: 'list' }), /進行中の案件はありません/);
  });
});

test('/case 詳細: 目的・受入・担当・契機・予算と、返事待ちの申し出を出す', async () => {
  await withHarness({ seed: false }, async (h) => {
    assert.match(h.wiring.caseCommand({ action: 'detail', id: 'C-9' }), /C-9 は台帳にありません/);
    openCase(h.store);
    const out = h.wiring.offer(CONSULT, T0);
    const detail = h.wiring.caseCommand({ action: 'detail', id: 'C-1' });
    assert.match(detail, /\*\*C-1\*\* `open`/);
    assert.match(detail, /目的: verify を緑に戻す/);
    assert.match(detail, /受入: npm test 全通過 \(v1\)/);
    assert.match(detail, /Mandate: quality v1 \(M-1\)/);
    assert.match(detail, /担当: 担当なし/);
    assert.match(detail, /予算: 配分 6 \/ 予約 1 \/ 確定 0/);
    assert.match(detail, new RegExp(`返事待ちの申し出: ${out.claimId} owner→opus`));
    assert.match(detail, new RegExp(`外に出ている起動: ${out.actionId} consult \\(planned\\)`));
  });
});

test('/case new: Mandate の写しを合わせてから案件を開き、スレッドを結ぶ', async () => {
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    // 台帳はまだ空 — syncMandates を内側で呼ぶので写しから作られる
    assert.deepEqual(Object.keys(h.store.snapshot.mandates), []);
    const text = h.wiring.caseCommand({
      action: 'new', mandateKey: 'quality', goal: '待ち時間を測る', acceptance: '中央値が出る',
      threadId: THREAD, userId: 'U-so',
    });
    assert.match(text, /案件 \*\*C-1\*\* を開きました \(引受け待ち\)/);
    const record = h.store.snapshot.cases['C-1'];
    assert.equal(record.state, 'open');
    assert.equal(record.desiredOutcome, '待ち時間を測る');
    assert.equal(record.acceptance.condition, '中央値が出る');
    assert.equal(record.links.length, 1);
    assert.equal(record.links[0].kind, 'thread');
    assert.equal(record.links[0].id, THREAD, '相談の宛先になるスレッドを結んでいない');
    assert.equal(h.store.snapshot.findings['F-1'].source.kind, 'sample');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // **同じ目的でも別の案件になる** (人が「新しく開く」と言ったので既存へ追記しない)
    h.wiring.caseCommand({
      action: 'new', mandateKey: 'quality', goal: '待ち時間を測る', acceptance: '中央値が出る',
      threadId: THREAD,
    }, T0);
    assert.equal(Object.keys(h.store.snapshot.cases).length, 2);
  });
});

test('/case new: 写しに無い Mandate は、いま使えるキーを添えて断る', async () => {
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    const text = h.wiring.caseCommand({
      action: 'new', mandateKey: 'speed', goal: 'x', acceptance: 'y',
    });
    assert.match(text, /案件を開けませんでした/);
    assert.match(text, /active な Mandate "speed" が台帳にありません/);
    assert.match(text, /写してあるのは quality/);
    assert.deepEqual(Object.keys(h.store.snapshot.cases), []);
  });
});

test('/case offer: 相談を作り、次の tick で送る', async () => {
  await withHarness({ seed: false, mandates: MANDATES }, async (h) => {
    h.wiring.caseCommand({
      action: 'new', mandateKey: 'quality', goal: 'verify を緑に', acceptance: '全通過',
      threadId: THREAD,
    });
    const text = h.wiring.caseCommand({
      action: 'offer', id: 'C-1', botKey: 'opus', responsibility: 'owner',
      channelName: 'society-trial', threadId: THREAD, summary: 'ログを読む',
    });
    assert.match(text, /案件 \*\*C-1\*\* の owner を opus へ相談します/);
    const tick = await h.wiring.societyTick(T0);
    assert.equal(tick.dispatched, 1);
    assert.match(h.posts[0].content, /consult — owner の引受けの相談/);

    // 断られた理由は台帳の語のまま返す (何が足りないかが読める)
    const bad = h.wiring.caseCommand({
      action: 'offer', id: 'C-404', botKey: 'opus', responsibility: 'owner', channelName: 'society-trial',
    });
    assert.match(bad, /相談を出せませんでした \(no-case\)/);
  });
});

test('/case: off と台帳が開けていない配備では、案件の話をしない', async () => {
  await withHarness({ seed: false, mode: 'off' }, async (h) => {
    assert.match(h.wiring.caseCommand({ action: 'list' }), /社会の機構は off です/);
  });
  await withHarness({ ledger: 'broken' }, async (h) => {
    assert.match(h.wiring.caseCommand({ action: 'list' }), /⛔ 台帳を開けていません/);
  });
});

test('society ターン: 二重に当てても気づきは増えない', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    h.wiring.noteRunning('A-1');
    const turn = {
      body: 'x',
      finding: { expected: 'a', actual: 'b', subject_id: 's', condition_id: 'c' },
      next: { waiting: { why: 'evidence', condition: 'y' } },
    };
    h.wiring.applyTurn('A-1', turn, { at: T0 + MIN });
    const first = Object.keys(h.store.snapshot.findings).length;

    const again = h.wiring.applyTurn('A-1', turn, { at: T0 + 2 * MIN });
    assert.equal(again.ok, false);
    assert.equal(Object.keys(h.store.snapshot.findings).length, first, '気づきだけ増えている');
    assert.ok(again.notes.some((n) => /settled なので、この戻りは記録しません/.test(n)));
  });
});

test('society: 既に settled の Action への noteSettled はエラーにしない', async () => {
  await withHarness({}, async (h) => {
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted('A-1', { runId: 'job-1' });
    h.wiring.noteRunning('A-1');
    h.wiring.applyTurn('A-1', {
      body: 'x', next: { waiting: { why: 'evidence', condition: 'y' } },
    }, { at: T0 + MIN });
    h.rec.lines.error.length = 0;

    const out = h.wiring.noteSettled('A-1', { runId: 'job-1', outcome: 'ok', reason: 'ok' }, T0 + 2 * MIN);
    assert.equal(out.ok, true);
    assert.equal(out.skipped, true);
    assert.deepEqual(h.rec.lines.error, [], 'fallback の二重呼びをエラーとして残さない');
  });
});

// ---- 停止と再開 (S2-4b・§12.2 (g)) ----

test('society 停止: 止めた job の案件は、スレッドの外でも 1 回の update で止まる', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    // 実行記録から job → 案件 → 起動を引く (seed の Case にはスレッド link が無い)
    h.records.set('job-1', { id: 'job-1', society: { caseId: 'C-1', actionId: 'A-1' } });
    const before = h.store.revision;
    const out = h.wiring.stopCases({
      threadId: 'T-999', all: false, userId: 'U-so', jobIds: ['job-1'],
    }, T0 + MIN);

    assert.equal(out.ok, true);
    assert.deepEqual(out.stopped, ['C-1']);
    assert.equal(h.store.revision, before + 1, '案件ごとに版を進めている');
    assert.deepEqual(h.kase().stop, {
      by: 'human',
      at: new Date(T0 + MIN).toISOString(),
      actionId: 'A-1',
      sourceId: 'U-so',
      reason: '/stop',
    });
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 2 回目は上書きしない (誰がいつ止めたかが消える) — 失敗にもしない
    const again = h.wiring.stopCases({ all: true, userId: 'U-other' }, T0 + 2 * MIN);
    assert.equal(again.ok, true);
    assert.deepEqual(again.stopped, []);
    assert.equal(h.kase().stop.sourceId, 'U-so');
    assert.equal(h.kase().stop.at, new Date(T0 + MIN).toISOString());
    assert.equal(h.store.revision, before + 1, '何も変わっていないのに書いている');
  });
});

test('society 停止: scope:this はスレッドに結ばれた案件・scope:all は全未終結案件', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store); // C-1 は THREAD に link 済み
    const other = h.wiring.stopCases({ threadId: 'T-999', all: false }, T0);
    assert.deepEqual(other.stopped, [], '別スレッドの /stop で止めている');

    const here = h.wiring.stopCases({ threadId: THREAD, all: false, userId: 'U-so' }, T0);
    assert.deepEqual(here.stopped, ['C-1']);
    assert.equal(h.kase().stop.actionId, null, '起動を止めていない案件は actionId なし');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });

  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    // 終端の案件は触らない (閉じたものを止め直さない)
    h.store.update(h.store.revision, (s) => closeCase(s, 'C-1', { closeReason: 'unnecessary', note: 'やめた' }, T0).snapshot);
    const all = h.wiring.stopCases({ threadId: null, all: true, userId: 'U-so' }, T0);
    assert.deepEqual(all.stopped, []);
    assert.equal(h.store.snapshot.cases['C-1'].stop, null);
  });
});

test('society 停止: off は何もせず、台帳が読めなければ理由を返す', async () => {
  await withHarness({ mode: 'off' }, async (h) => {
    const out = h.wiring.stopCases({ all: true, userId: 'U-so' }, T0);
    assert.deepEqual(out, { ok: true, stopped: [], skipped: [], code: 'off' });
  });
  await withHarness({ ledger: 'broken' }, async (h) => {
    const out = h.wiring.stopCases({ all: true, userId: 'U-so' }, T0);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'halted');
    assert.deepEqual(out.stopped, []);
  });
});

test('society 停止: 止めた案件は送らないが、照合と申し出の期限は進む', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    const consult = h.wiring.offer(CONSULT, T0);
    await h.wiring.societyTick(T0); // A-1 (consult) を送る
    assert.equal(h.posts.length, 1);
    // 止める前にもう 1 本 planned を積んでおく (止めた後は planAction が断られる)
    let plannedId = null;
    h.store.update(h.store.revision, (s) => {
      const out = planAction(s, {
        caseId: 'C-1',
        claimId: Object.values(s.claims).find((c) => c.responsibility === 'authority').id,
        kind: 'measure',
        target: { botKey: 'opus', threadId: THREAD, channel: 'society-trial' },
      }, T0);
      assert.equal(out.ok, true, `2 本目を立てられなかった: ${out.code}`);
      plannedId = out.actionId;
      return out.snapshot;
    });
    assert.deepEqual(h.wiring.stopCases({ threadId: THREAD, userId: 'U-so' }, T0).stopped, ['C-1']);
    const frozen = structuredClone(h.kase());

    // 未受付の期限 (10 分) と申し出の期限 (5 分) を越えた tick
    const tick = await h.wiring.societyTick(T0 + 11 * MIN);
    assert.equal(tick.dispatched, 0, '止めた案件へ送っている');
    assert.equal(h.posts.length, 1);
    assert.equal(h.store.snapshot.actions[plannedId].state, 'planned', '送っていない起動は planned のまま');
    // Action と申し出の事実は進む (予約が返り、返事の来ない申し出は閉じる)
    assert.equal(h.store.snapshot.actions[consult.actionId].state, 'cancelled');
    assert.deepEqual(tick.expired, [consult.claimId]);
    // Case は 1 ミリも動かない (停止マーカーと state と契機)
    assert.deepEqual(h.kase().stop, frozen.stop);
    assert.equal(h.kase().state, frozen.state);
    assert.deepEqual(h.kase().nextTrigger, frozen.nextTrigger);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 停止: 止めた案件の起動は受け付けず、取り消して予約を返す', async () => {
  await withHarness({ seed: { allocated: 3 } }, async (h) => {
    await h.wiring.societyTick(T0);
    assert.equal(h.action().state, 'sent');
    assert.deepEqual(h.wiring.stopCases({ all: true, userId: 'U-so' }, T0 + MIN).stopped, ['C-1']);

    const screened = h.wiring.screenAction({
      content: h.posts[0].content, messageId: h.posts[0].id, botKey: 'opus', threadId: THREAD,
    });
    assert.equal(screened.ok, false);
    assert.match(screened.reason, /案件 C-1 は停止中なので起動しません/);
    assert.match(screened.reason, /\/case resume:C-1/);
    // 起動は取り消され、予約は返る (誰も受けない Action が枠を握らない)
    assert.equal(h.action().state, 'cancelled');
    assert.deepEqual(h.kase().budget, { allocated: 3, reserved: 0, charged: 0 });
    // 契機は解除待ち・**state は止めた時のまま**
    assert.equal(h.kase().state, 'active');
    assert.equal(h.kase().nextTrigger.reason, 'paused');
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 停止: 止めた案件は相談も受諾も断り、結果だけ残す (回帰)', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    assert.deepEqual(h.wiring.stopCases({ threadId: THREAD, userId: 'U-so' }, T0 + MIN).stopped, ['C-1']);

    // 相談を出し直せない
    const again = h.wiring.offer({ ...CONSULT, botKey: 'opus2' }, T0 + MIN);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'stopped');
    // 走っていた相談の返事は結果だけ残り、受諾は成立しない
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '引き受けます',
      claim: { decision: 'accept' },
      next: { plan: { kind: 'investigate', summary: 'a' } },
    }, { at: T0 + 2 * MIN });
    assert.equal(h.store.snapshot.actions[offered.actionId].state, 'settled', '結果は残る');
    assert.equal(h.store.snapshot.claims[offered.claimId].state, 'offered', '止めた案件で担当が決まっている');
    assert.equal(h.kase().owner, null);
    assert.ok(applied.notes.some((n) => /stopped/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society 再開: /case resume で止めた一手が立ち直し、次の tick で送られる', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    await upToRunning(h);
    h.records.set('job-1', { id: 'job-1', society: { caseId: 'C-1', actionId: 'A-1' } });
    assert.deepEqual(h.wiring.stopCases({ threadId: THREAD, jobIds: ['job-1'], userId: 'U-so' }, T0 + MIN).stopped, ['C-1']);

    // 走っていた job が停止で終わる (queue の finally が呼ぶ経路)
    const settled = h.wiring.noteSettled('A-1', { runId: 'job-1', outcome: 'cancelled', reason: '停止' }, T0 + 2 * MIN);
    assert.equal(settled.result.code, 'stopped');
    assert.equal(h.kase().state, 'active', '止めた案件の state を動かしている');
    assert.equal(h.kase().nextTrigger.reason, 'paused');
    assert.equal((await h.wiring.societyTick(T0 + 3 * MIN)).dispatched, 0);

    const text = h.wiring.caseCommand({ action: 'resume', id: 'C-1' });
    assert.match(text, /▶️ 案件 \*\*C-1\*\* を再開しました — A-2 を立て直しました/);
    assert.equal(h.store.snapshot.actions['A-2'].kind, 'investigate');
    assert.equal(h.store.snapshot.actions['A-2'].claimId, 'CL-1');
    assert.deepEqual(h.kase().nextTrigger, { kind: 'nextAction', actionId: 'A-2' });
    assert.equal(h.kase().stop, null);

    const tick = await h.wiring.societyTick(T0 + 4 * MIN);
    assert.equal(tick.dispatched, 1, '再開したのに送っていない');
    assert.equal(h.posts.length, 2);
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 止まっていない案件の再開は断る (何も起きていないことが読める)
    assert.match(h.wiring.caseCommand({ action: 'resume', id: 'C-1' }), /再開できませんでした \(not-stopped\)/);
    assert.match(h.wiring.caseCommand({ action: 'resume', id: 'C-9' }), /再開できませんでした \(no-case\)/);
  });
});

test('society 表示: 停止した案件は一覧で ⏹・詳細に誰がいつ止めたかと再開の口を出す', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    h.wiring.stopCases({ threadId: THREAD, userId: 'U-so' }, T0);
    assert.match(h.wiring.caseCommand({ action: 'list' }), /⏹ \*\*C-1\*\* `open`/);
    const detail = h.wiring.caseCommand({ action: 'detail', id: 'C-1' });
    assert.match(detail, /⏹ 停止: human \/ 2026-09-07T09:00:00\.000Z \/ 起動なし \/ \/stop/);
    assert.match(detail, /再開は `\/case resume:C-1`/);
  });
});

test('society 集計: 停止した案件は stopped に数え、期限切れには数えない', async () => {
  await withHarness({ seed: false }, async (h) => {
    openCase(h.store);
    assert.equal(h.wiring.summary(T0).stopped, 0);
    h.wiring.stopCases({ threadId: THREAD, userId: 'U-so' }, T0);

    const late = h.wiring.summary(T0 + 24 * 60 * MIN);
    assert.equal(late.stopped, 1);
    assert.deepEqual(late.waiting, { offer: 1 }, '待ちの内訳からは消さない');
    assert.equal(late.overdue, 0, '人が再開するまで動かないものを期限切れに数えている');
  });
});

// ---- observe の門 (受入 C15) ----

test('society observe: 4 種以外の Action は起こさず、owner の契機は人間待ちにする', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '直します',
      next: { plan: { kind: 'implement', summary: '索引を直す' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    assert.equal(h.store.snapshot.actions['A-2'], undefined, 'observe で implement を起こしている');
    assert.equal(h.kase().state, 'waiting');
    assert.equal(h.kase().nextTrigger.reason, 'authority');
    assert.match(h.kase().nextTrigger.condition, /observe では implement/);
    assert.match(h.kase().nextTrigger.condition, /mode を active にするか/);
    assert.ok(out.notes.some((n) => /observe では implement は起こしません/.test(n)), out.notes.join(' | '));
    assert.ok(out.notes.some((n) => /waiting\(authority\)/.test(n)), out.notes.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);

    // 次の tick でも何も送らない (人が mode を上げるか自分でやる)
    assert.equal((await h.wiring.societyTick(T0 + 2 * MIN)).dispatched, 0);
  });
});

test('society observe: 4 種は従来どおり立ち、active では門が無い', async () => {
  await withHarness({ seed: { allocated: 4 } }, async (h) => {
    await upToRunning(h);
    const out = h.wiring.applyTurn('A-1', {
      body: '測ります',
      next: { plan: { kind: 'measure', summary: '件数を数える' } },
    }, { at: T0 + MIN });
    assert.equal(h.store.snapshot.actions['A-2'].kind, 'measure');
    assert.equal(out.notes.some((n) => /observe では/.test(n)), false, '通した kind に断りを出している');
  });
  await withHarness({ mode: 'active', seed: { allocated: 4 } }, async (h) => {
    await upToRunning(h);
    h.wiring.applyTurn('A-1', {
      body: '直します',
      next: { plan: { kind: 'implement', summary: '索引を直す' } },
    }, { at: T0 + MIN });
    assert.equal(h.store.snapshot.actions['A-2'].kind, 'implement', 'active で門が効いている');
    assert.equal(h.kase().state, 'active');
  });
});

test('society observe: 契機が別の生きた起動を指しているときは、その仕事を止めない', async () => {
  await withHarness({ seed: { allocated: 6 } }, async (h) => {
    // 2 本目を立てる (契機は 1 本目のまま = S2-4a の規則 (c))
    let secondId = null;
    h.store.update(h.store.revision, (s) => {
      const out = planAction(s, {
        caseId: 'C-1',
        claimId: s.cases['C-1'].owner,
        kind: 'measure',
        target: { botKey: 'opus', threadId: THREAD, channel: 'society-trial' },
      }, T0);
      secondId = out.actionId;
      return out.snapshot;
    });
    await h.wiring.societyTick(T0);
    h.wiring.noteAccepted(secondId, { runId: 'job-2' });
    h.wiring.noteRunning(secondId);
    const before = structuredClone(h.kase().nextTrigger);

    const out = h.wiring.applyTurn(secondId, {
      body: '測りました',
      next: { plan: { kind: 'implement', summary: '直す' } },
    }, { at: T0 + MIN });

    assert.equal(out.ok, true);
    assert.equal(Object.keys(h.store.snapshot.actions).length, 2, 'observe で implement を起こしている');
    assert.deepEqual(h.kase().nextTrigger, before, '進んでいる仕事の契機を奪っている');
    assert.ok(out.notes.some((n) => /observe では implement は起こしません/.test(n) && /契機は動かしていません/.test(n)),
      out.notes.join(' | '));
    assert.deepEqual(validateSnapshot(h.store.snapshot), []);
  });
});

test('society observe: 受諾は通すが最初の一手が 4 種以外なら人間待ちにする', async () => {
  await withHarness({ seed: false }, async (h) => {
    const offered = await consulted(h);
    const applied = h.wiring.applyTurn(offered.actionId, {
      body: '引き受けます',
      claim: { decision: 'accept' },
      next: { plan: { kind: 'implement', summary: '直す' } },
    }, { at: T0 + MIN });

    assert.equal(applied.ok, true);
    const s = h.store.snapshot;
    assert.equal(s.claims[offered.claimId].state, 'accepted', '引受けの記録まで止めている');
    assert.equal(s.cases['C-1'].owner, offered.claimId);
    assert.equal(Object.values(s.actions).some((a) => a.state === 'planned'), false, 'implement を起こしている');
    assert.equal(s.cases['C-1'].state, 'waiting');
    assert.equal(s.cases['C-1'].nextTrigger.reason, 'authority');
    assert.ok(applied.notes.some((n) => /受諾しました \(世代 1\)/.test(n)), applied.notes.join(' | '));
    assert.ok(applied.notes.some((n) => /observe では implement は起こしません/.test(n)), applied.notes.join(' | '));
    assert.deepEqual(validateSnapshot(s), []);
  });
});

// ---- 走査のページング (complete の判定は 1 か所) ----

test('society 走査: complete は「末尾まで届いたか」だけで決まる', async () => {
  const page = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i + 1) }));
  const calls = [];
  const fetcher = (pages) => async ({ after, limit }) => {
    calls.push({ after, limit });
    return pages.shift() ?? [];
  };

  // since 無しで 1 ページ未満 = 全件読めた (以前は complete: false にしていた)
  assert.deepEqual(
    await collectThreadPosts({ fetchPage: fetcher([page(7)]), pageSize: 10 }),
    { complete: true, posts: page(7), pages: 1 },
  );
  // since 無しでページが満杯 = 最新 N 件しか見ていない
  const full = await collectThreadPosts({ fetchPage: fetcher([page(10)]), pageSize: 10 });
  assert.equal(full.complete, false);
  assert.equal(full.pages, 1);
  // since ありなら満杯でも次を辿り、短いページで終わる
  calls.length = 0;
  const paged = await collectThreadPosts({
    fetchPage: fetcher([page(10), page(3, 10)]), after: '0', pageSize: 10,
  });
  assert.equal(paged.complete, true);
  assert.equal(paged.posts.length, 13);
  assert.deepEqual(calls.map((c) => c.after), ['0', '10'], '最後の ID から続きを辿る');
  // 上限まで辿っても終わらなければ incomplete
  const many = await collectThreadPosts({
    fetchPage: async () => page(10), after: '0', pageSize: 10, maxPages: 3,
  });
  assert.equal(many.complete, false);
  assert.equal(many.pages, 3);
  assert.equal(many.posts.length, 30);
});
