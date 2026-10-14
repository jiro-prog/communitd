import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TEXT_CHARS, validateContract } from '../src/contract.js';
import { reviewApprovalSection } from '../src/mentions.js';
import {
  MAX_REPLAY_SUMMARY_CHARS,
  REPLAY_TITLE_PREFIX,
  awaitingReplays,
  formatReplaySummary,
  isReplayTask,
  pickReplayCases,
  planReplaySettle,
  replayTaskSpec,
  resolveReplayBase,
} from '../src/replay.js';

// src/replay.js — ハーネスの改訂の下書きの検証 (解き直し) の判断の側

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const SHA = (n) => String(n).repeat(40).slice(0, 40);
const mergeNote = (id) => `merge ${SHA(1)} (base dev@${SHA(2)}, branch task/${id}@${SHA(3)})`;

/** merge 済みのタスク (差し戻しの履歴は sentBack で足す) */
function merged(id, { at = 100, sentBack = null, touch = ['src/a.js', 'test/a.test.js'], channel = 'dev', title = `題 ${id}`, ...over } = {}) {
  return {
    id: String(id), channel, title, rationale: `理由 ${id}`, touch, state: 'merged', branch: `task/${id}`,
    history: [
      { at: iso(at - 30), from: 'approved', to: 'in-progress' },
      { at: iso(at - 20), from: 'in-progress', to: 'review' },
      ...(sentBack ? [
        { at: iso(at - 15), from: 'review', to: 'in-progress', note: sentBack },
        { at: iso(at - 10), from: 'in-progress', to: 'review' },
      ] : []),
      { at: iso(at), from: 'review', to: 'merged', note: mergeNote(id) },
    ],
    ...over,
  };
}

const revision = (rationale, over = {}) => ({
  id: '200', channel: 'dev', title: 'roles/worker.md に 1 項', rationale, touch: ['roles/worker.md'], state: 'review', ...over,
});

test('pickReplayCases: 理由に名指しされた差し戻しのタスクを名指しの順に、カナリアは差し戻しの無い src のタスクを新しい順に', () => {
  const tasks = [
    merged(108, { at: 10, sentBack: '【差し戻し】close を待たない' }),
    merged(131, { at: 20, sentBack: '【差し戻し】コメントが落ち方と食い違う' }),
    merged(140, { at: 30 }),                                   // 名指しされたが差し戻しが無い
    merged(150, { at: 40 }),                                   // カナリアの候補 (古い)
    merged(151, { at: 50, touch: ['test/b.test.js'] }),        // src を触らない
    merged(152, { at: 60 }),                                   // カナリアの候補 (新しい)
    merged(153, { at: 70, touch: ['roles/reviewer.md'] }),     // 役割文を触る
    merged(154, { at: 80, channel: 'other' }),                 // 別チャンネル
    merged(155, { at: 90, replay: { of: '199', caseId: '150' } }), // 解き直し
    merged(156, { at: 95, sentBack: 'x', history: [{ at: iso(95), from: 'review', to: 'merged', note: '読めない note' }] }),
  ];
  const picked = pickReplayCases(revision('差し戻し #131 と #108、#140 は同じ原因。#999 も'), tasks, { cases: 2, canary: 1 });
  assert.deepEqual(picked.map((p) => [p.task.id, p.kind]), [['131', 'sent-back'], ['108', 'sent-back'], ['152', 'canary']]);
  assert.equal(picked[0].reason, '【差し戻し】コメントが落ち方と食い違う');
  assert.deepEqual(picked[0].merge, { commit: SHA(1), baseBranch: 'dev', baseHead: SHA(2), branch: 'task/131', tip: SHA(3) });

  // 件数の上限と 0 件
  assert.deepEqual(pickReplayCases(revision('#131 #108'), tasks, { cases: 1, canary: 0 }).map((p) => p.task.id), ['131']);
  assert.deepEqual(pickReplayCases(revision('名指し無し'), tasks, { cases: 2, canary: 0 }), []);
  // 名指しされたタスクはカナリアに選ばない (差し戻しが無くても)
  assert.deepEqual(pickReplayCases(revision('#152'), tasks, { cases: 2, canary: 1 }).map((p) => p.task.id), ['150']);
});

test('replayTaskSpec: 題の頭の [slug] を外して印を付け、理由と touch は元のまま、予算は解き直しの分', () => {
  const [picked] = pickReplayCases(revision('#131'), [merged(131, { sentBack: 'x', title: '[review-evidence] 証拠を足す' })], { cases: 1 });
  const spec = replayTaskSpec(picked, { revisionId: '200', base: SHA(4), jobBudget: 2 });
  assert.deepEqual(spec.proposal, {
    channel: 'dev', title: `${REPLAY_TITLE_PREFIX} 証拠を足す`, rationale: '理由 131', touch: ['src/a.js', 'test/a.test.js'], jobBudget: 2,
  });
  assert.deepEqual(spec.replay, { of: '200', caseId: '131', kind: 'sent-back', base: SHA(4) });
  assert.equal(isReplayTask({ replay: spec.replay }), true);
  assert.equal(isReplayTask({ replay: null }), false);
  assert.equal(isReplayTask({}), false);
});

test('resolveReplayBase: merge の第 1 親と元のブランチの先端の分岐点 / 決まらなければ null', async () => {
  const calls = [];
  const git = async (root, args) => { calls.push([root, ...args]); return `${SHA('a')}\n`; };
  const merge = { commit: SHA(1), tip: SHA(3) };
  assert.equal(await resolveReplayBase({ repoRoot: 'R', merge, git }), SHA('a'));
  assert.deepEqual(calls, [['R', 'merge-base', SHA(3), `${SHA(1)}^1`]]);
  assert.equal(await resolveReplayBase({ repoRoot: 'R', merge, git: async () => { throw new Error('x'); } }), null);
  assert.equal(await resolveReplayBase({ repoRoot: 'R', merge, git: async () => 'fatal: not a sha' }), null);
  assert.equal(await resolveReplayBase({ repoRoot: 'R', merge: null, git }), null);
});

test('planReplaySettle: 解き直しが全部落ち着いたら settled、期限を過ぎたら残りを添えて timeout、それ以外は待つ', () => {
  const rev = (id, startedMin) => ({ id, state: 'review', replay: { status: 'running', startedAt: iso(startedMin) } });
  const replay = (id, of, state) => ({ id, state, replay: { of, caseId: '1', kind: 'canary' } });
  const tasks = [
    rev('10', 0), replay('11', '10', 'dropped'), replay('12', '10', 'blocked'),
    rev('20', 0), replay('21', '20', 'dropped'), replay('22', '20', 'in-progress'),
    rev('30', 0), replay('31', '30', 'approved'),
    { id: '40', state: 'review', replay: { status: 'done' } },
    { id: '50', state: 'review' },
  ];
  const at10h = T0 + 10 * 60 * 60_000;
  const plans = planReplaySettle(tasks, { now: at10h, timeoutMs: 12 * 60 * 60_000 });
  assert.deepEqual(plans.map((p) => [p.revision.id, p.how, p.unsettled.map((t) => t.id)]), [['10', 'settled', []]]);
  const later = planReplaySettle(tasks, { now: T0 + 12 * 60 * 60_000, timeoutMs: 12 * 60 * 60_000 });
  assert.deepEqual(later.map((p) => [p.revision.id, p.how, p.unsettled.map((t) => t.id)]), [
    ['10', 'settled', []], ['20', 'timeout', ['22']], ['30', 'timeout', ['31']],
  ]);
  assert.equal(awaitingReplays(tasks[0]), true);
  assert.equal(awaitingReplays(tasks[8]), false);
  assert.equal(awaitingReplays({ state: 'in-progress', replay: { status: 'running' } }), false);
});

test('formatReplaySummary: 解き直しごとに結果・証拠の 1 行目・差分の読み方、差し戻しの再現には元の理由を並べる', () => {
  const tasks = [
    merged(131, { sentBack: '【差し戻し】コメントが落ち方と食い違う' }),
    merged(152),
    {
      id: '201', state: 'dropped', branch: 'task/201',
      replay: { of: '200', caseId: '131', kind: 'sent-back', base: SHA(5), outcome: { result: 'submitted', evidence: '変更前の src で落ちる 2 / 落ちない 0\n2 行目' } },
    },
    { id: '202', state: 'blocked', branch: 'task/202', replay: { of: '200', caseId: '152', kind: 'canary', base: SHA(6) } },
    { id: '203', state: 'dropped', branch: 'task/203', replay: { of: '999', caseId: '152', kind: 'canary', base: SHA(6) } },
  ];
  const text = formatReplaySummary({ id: '200', replay: { status: 'done', how: 'timeout' } }, tasks);
  assert.equal(text, [
    '下書きの検証 (この改訂の作業ツリーの役割文で過去のタスクを解き直した結果 — 判定ではなく材料。'
      + '差し戻しの再現は元の理由と同じ失敗が出ていないか、カナリアは前に通ったものを壊していないかを差分で読む):',
    `- #201 ← 差し戻しの再現 #131 (基点 5555555・\`git diff 5555555..task/201\`): 完了を報告`,
    '  証拠: 変更前の src で落ちる 2 / 落ちない 0',
    '  元の差し戻しの理由: 【差し戻し】コメントが落ち方と食い違う',
    `- #202 ← カナリア #152 (基点 6666666・\`git diff 6666666..task/202\`): 止まった (要人間)`,
    '(期限が来たので、終わっていない解き直しを取り下げてレビューを呼んだ)',
  ].join('\n'));
  assert.equal(formatReplaySummary({ id: '200', replay: { status: 'none', reason: '名指しが無い' } }, tasks), '下書きの検証: 解き直していません — 名指しが無い');
  assert.equal(formatReplaySummary({ id: '200' }, tasks), null);
});

test('formatReplaySummary: 解き直しが多く長くても上限に収め (証拠と理由を詰め、残りは件数で畳む)、レビュー契約の様式に収まる', () => {
  const cases = Array.from({ length: 6 }, (_, i) => merged(300 + i, { sentBack: `【差し戻し】${'理由が長い。'.repeat(80)}` }));
  const replays = cases.map((c, i) => ({
    id: String(400 + i), state: 'dropped', branch: `task/${400 + i}`,
    replay: { of: '200', caseId: c.id, kind: 'sent-back', base: SHA(7), outcome: { result: 'submitted', evidence: `変更前の src で落ちる 1 / ${'証拠の行。'.repeat(80)}` } },
  }));
  const text = formatReplaySummary({ id: '200', replay: { status: 'done', how: 'settled' } }, [...cases, ...replays]);
  assert.ok(text.length <= MAX_REPLAY_SUMMARY_CHARS, `${text.length} 字`);
  assert.match(text, /\n…ほか \d+ 件 \(`git branch --list 'task\/\*'` の解き直しのブランチで読む\)$/);
  assert.match(text, /^- #400 ← 差し戻しの再現 #300 /m, '先頭の解き直しまで畳んでいる');
  // 落ちた検証・レビューの証拠・承認時の備考がどれも上限いっぱいでも、レビュー契約の本文 (6000) に収まる
  const body = `タスク 200 のレビューをお願いします\n\n${'v'.repeat(1250)}\n\n${'e'.repeat(1300)}\n\n${text}${reviewApprovalSection('a'.repeat(2500))}`;
  assert.ok(body.length <= MAX_TEXT_CHARS, `本文 ${body.length} 字`);
  const checked = validateContract('task-review', {
    body, verdict: 'send-back', reason: '(未判定)', target: [{ id: '200', title: 't', branch: 'task/200' }],
  });
  assert.equal(checked.ok, true, checked.reason);
});

test('formatReplaySummary: 解き直しを閉じた後に出し直された提出には、結果が前の下書きのものだと添える', () => {
  const revision = {
    id: '200',
    replay: { status: 'done', how: 'settled', doneAt: iso(50) },
    history: [
      { at: iso(10), from: 'in-progress', to: 'review' },
      { at: iso(60), from: 'review', to: 'in-progress', note: '直して' },
      { at: iso(70), from: 'in-progress', to: 'review' },
    ],
  };
  assert.match(formatReplaySummary(revision, []), /\(この結果は前の提出の下書きで解き直したもの — その後の変更は解き直していない\)$/);
  assert.doesNotMatch(formatReplaySummary({ ...revision, history: revision.history.slice(0, 1) }, []), /前の提出の下書き/);
});
