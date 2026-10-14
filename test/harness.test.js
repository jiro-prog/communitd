import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REVIEW_EVIDENCE_NOTE_PREFIX } from '../src/board.js';
import {
  BASELINE_REV,
  compareRevs,
  day,
  formatHarnessReport,
  harnessFingerprint,
  harnessGate,
  ledgerEffectLine,
  ledgerStartLines,
  revisionLedger,
  summarizeHarness,
  verdictLine,
} from '../src/harness.js';
import { formatReviewEvidence, summarizeRuns } from '../src/review-evidence.js';
import { touchesHarness } from '../src/scheduler.js';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const DAY_MIN = 24 * 60;

/** 時刻が単調に進む実行記録を作る (テストごとに clock() で作り直す) */
function clock(start = 0) {
  let t = start;
  let seq = 0;
  const run = (over = {}) => {
    t += 10;
    seq += 1;
    return {
      id: `r${seq}`,
      botKey: 'opus',
      channelName: 'dev',
      taskId: null,
      stage: 'ended',
      outcome: 'ok',
      reason: 'ok',
      stopKind: null,
      next: 'human',
      acceptedAt: iso(t),
      startedAt: iso(t),
      endedAt: iso(t + 5),
      stageDetail: '',
      harness: null,
      ...over,
    };
  };
  const many = (count, over = {}) => Array.from({ length: count }, (_, i) => run(typeof over === 'function' ? over(i) : over));
  return { run, many, now: () => T0 + t * 60_000 };
}

const stamp = (rev, extra = {}) => ({ harness: { rev, role: 'worker', runtime: 'claude', model: 'opus', effort: null, files: [], ...extra } });

/** review 遷移の note に残るレビューの証拠 (ブリッジが書く形) */
const EVIDENCE_BASE = { base: 'dev', mergeBase: '0123456789abcdef', src: { added: [], restored: ['src/a.js'] } };
const evidenceNote = (text) => `${REVIEW_EVIDENCE_NOTE_PREFIX}${text}`;
const measuredNote = (passes) => evidenceNote(formatReviewEvidence({
  ...EVIDENCE_BASE, outcome: 'measured', tests: ['test/a.test.js'], counts: { fails: 1, passes, headFails: 0 },
}));
const noSrcNote = evidenceNote(formatReviewEvidence({
  ...EVIDENCE_BASE, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js'],
}));
const noTestsNote = evidenceNote(formatReviewEvidence({ ...EVIDENCE_BASE, outcome: 'no-tests', tests: [] }));
const unmeasuredNote = evidenceNote('測れませんでした — 本体の作業ツリー');
const stoppedNote = evidenceNote(formatReviewEvidence({ ...EVIDENCE_BASE, outcome: 'stopped', planned: 3, ran: 1 }));
/** 提出した job の終わりに板が書く review 遷移 */
const toReview = (run, note, by = 'opus') => ({
  at: run.endedAt, from: 'in-progress', to: 'review', by, ...(note === undefined ? {} : { note }),
});
const noTally = {
  submissions: 0, measured: 0, withPasses: 0, allLoadFailed: 0, noSrc: 0, noTests: 0, unmeasured: 0, unknown: 0, withDeleted: 0,
};
const noEvidence = { ...noTally, sentBack: noTally };

test('harnessFingerprint: 同じ本文と設定なら同じ版、本文・effort・役割文の違いで版が変わる', () => {
  const base = {
    sources: [
      { label: 'roles/_common.md', text: '共通\n規定\n' },
      { label: 'roles/worker.md', text: '実装\n', own: true },
    ],
    runtime: 'claude',
    model: 'opus',
    effort: 'high',
  };
  const a = harnessFingerprint(base);
  assert.match(a.rev, /^[0-9a-f]{12}$/);
  assert.equal(a.role, 'worker');
  assert.deepEqual(a.files, ['roles/_common.md', 'roles/worker.md']);
  assert.equal(a.model, 'opus');
  assert.equal(harnessFingerprint(base).rev, a.rev);

  const crlf = { ...base, sources: base.sources.map((s) => ({ ...s, text: s.text.replace(/\n/g, '\r\n') })) };
  assert.equal(harnessFingerprint(crlf).rev, a.rev, '改行の違いで版が割れている');

  const edited = { ...base, sources: [base.sources[0], { ...base.sources[1], text: '実装 (改訂)\n' }] };
  assert.notEqual(harnessFingerprint(edited).rev, a.rev);
  assert.notEqual(harnessFingerprint({ ...base, effort: 'xhigh' }).rev, a.rev, 'effort の改訂が版に出ない');
  assert.notEqual(harnessFingerprint({ ...base, model: 'fable' }).rev, a.rev);
});

test('touchesHarness: roles/ を触るタスクだけが改訂', () => {
  assert.equal(touchesHarness({ touch: ['roles/worker.md'] }), true);
  assert.equal(touchesHarness({ touch: ['src/a.js', 'roles\\_common.md'] }), true);
  assert.equal(touchesHarness({ touch: ['src/roles.js', 'docs/roles/x.md'] }), false);
  assert.equal(touchesHarness({}), false);
});

test('compareRevs: 本数が足りなければ未確定、率の差が大きければ悪化 / 改善', () => {
  const rev = (runs, problems) => ({ runs, problems });
  assert.equal(compareRevs(rev(10, 1), rev(40, 4), { minRuns: 20 }).verdict, 'undetermined');
  assert.equal(compareRevs(rev(40, 14), rev(40, 2), { minRuns: 20 }).verdict, 'worse');
  assert.equal(compareRevs(rev(40, 2), rev(40, 14), { minRuns: 20 }).verdict, 'improved');
  assert.equal(compareRevs(rev(40, 4), rev(40, 5), { minRuns: 20 }).verdict, 'flat');
  assert.deepEqual(compareRevs(rev(30, 0), rev(30, 0), { minRuns: 20 }), { verdict: 'flat', z: 0 });
});

test('summarizeHarness: 指紋の前は基準の版、後の無印は版不明、今の版と前の版を比べる', () => {
  const c = clock();
  const runs = [
    ...c.many(30, (i) => ({ outcome: i < 2 ? 'verify-failed' : 'ok' })), // 記録前: 30 本・問題 2
    ...c.many(25, (i) => ({ ...stamp('aaaaaaaaaaaa'), outcome: i < 12 ? 'failed' : 'ok', stageDetail: `落ち ${i}` })),
    c.run({ outcome: 'not-started', reason: 'role-unreadable' }), // 指紋の後の無印
  ];
  const s = summarizeHarness(runs, { minRuns: 20 });
  assert.equal(s.bots.length, 1);
  const bot = s.bots[0];
  assert.equal(bot.current.rev, 'aaaaaaaaaaaa');
  assert.equal(bot.current.runs, 25);
  assert.equal(bot.current.problems, 12);
  assert.equal(bot.previous.rev, BASELINE_REV);
  assert.equal(bot.previous.runs, 30);
  assert.equal(bot.previous.problems, 2);
  assert.equal(bot.unattributed, 1);
  assert.equal(bot.verdict, 'worse');
  assert.equal(bot.role, 'worker');
  // 抜粋は新しい順で、版不明の job も入る
  assert.equal(s.excerpts[0].rev, null);
  assert.equal(s.excerpts[0].outcome, 'not-started');
  assert.equal(s.excerpts[1].detail, '落ち 11');
});

test('summarizeHarness: 人間の停止・再起動・配送の失敗は数えず、時間切れは問題に数える', () => {
  const c = clock();
  const runs = [
    c.run({ outcome: 'stopped', stopKind: 'human' }),
    c.run({ outcome: 'aborted', stopKind: 'shutdown' }),
    c.run({ outcome: 'deliver-failed' }),
    c.run({ outcome: 'aborted', stopKind: 'timeout' }),
    c.run({ stage: 'model', outcome: null }), // 走っている途中
    c.run(),
  ];
  const bot = summarizeHarness(runs).bots[0];
  assert.equal(bot.current.runs, 2);
  assert.equal(bot.current.problems, 1);
});

test('summarizeHarness: 起動できなかった記録は受付の時刻で並べて問題に数え、時刻の読めない記録は数えない', () => {
  const c = clock();
  // jobruns の refuse() と同じ形: 起動の時刻は null・終わりは受付と同じ・指紋は付かない
  const refused = (detail) => {
    const run = c.run({ outcome: 'not-started', reason: 'role-unreadable', stageDetail: detail });
    return { ...run, startedAt: null, endedAt: run.acceptedAt };
  };
  const firstRefused = refused('断り 1');
  const ok = c.many(3, {});
  const lastRefused = refused('断り 2');
  const stamped = c.many(3, stamp('aaaaaaaaaaaa'));
  const lateRefused = refused('断り 3'); // 最初の指紋の後 → 版不明
  const unreadable = [
    { ...c.run({ outcome: 'failed' }), startedAt: null, acceptedAt: null },
    { ...c.run({ outcome: 'failed' }), startedAt: '時刻なし', acceptedAt: '' },
  ];
  // 入力の並びを崩しておく — 受付の時刻で並べ直していなければ、版の並び (timeline) の末尾が記録前になり、
  // 今の版と前の版が入れ替わる (版不明の判定は並び順でなく時刻で比べるので、最初の断りは並びに関係なく記録前に入る)
  const s = summarizeHarness([lateRefused, ...stamped, ...unreadable, ...ok, lastRefused, firstRefused]);
  const bot = s.bots[0];
  assert.equal(bot.previous.rev, BASELINE_REV);
  assert.equal(bot.previous.runs, 5);
  assert.equal(bot.previous.problems, 2);
  assert.equal(bot.previous.firstAt, firstRefused.acceptedAt);
  assert.equal(bot.previous.lastAt, lastRefused.acceptedAt);
  assert.equal(bot.current.runs, 3);
  assert.equal(bot.unattributed, 1);
  assert.equal(s.total, 8, '時刻の読めない記録を数えている');
  assert.equal(s.from, firstRefused.acceptedAt);
  assert.equal(s.to, lateRefused.acceptedAt);
  assert.deepEqual(s.excerpts.map((e) => [e.at, e.rev, e.outcome, e.detail]), [
    [lateRefused.acceptedAt, null, 'not-started', '断り 3'],
    [lastRefused.acceptedAt, BASELINE_REV, 'not-started', '断り 2'],
    [firstRefused.acceptedAt, BASELINE_REV, 'not-started', '断り 1'],
  ]);
});

test('summarizeHarness: レビューの差し戻しは、その直前の提出をした job の問題に数える', () => {
  const c = clock();
  const submit1 = c.run({ taskId: '7', next: 'reviewer' });
  const review = c.run({ botKey: 'opus2', taskId: '7' });
  const submit2 = c.run({ taskId: '7', next: 'reviewer' });
  const tasks = [{
    id: '7',
    history: [
      { at: iso(-5), from: null, to: 'proposed', by: 'opus' },
      { at: review.endedAt, from: 'review', to: 'in-progress', by: 'opus2', note: '【差し戻しの理由】テストが無い' },
      { at: iso(10_000), from: 'review', to: 'merged', by: 'opus2' },
    ],
  }];
  const s = summarizeHarness([submit1, review, submit2], { tasks });
  const opus = s.bots.find((b) => b.botKey === 'opus');
  assert.equal(opus.current.submissions, 2);
  assert.equal(opus.current.sentBack, 1);
  assert.equal(opus.current.problems, 1);
  assert.equal(s.bots.find((b) => b.botKey === 'opus2').current.problems, 0, 'レビュー担当に差し戻しを数えている');
  assert.equal(s.excerpts[0].outcome, 'sent-back');
  assert.match(s.excerpts[0].detail, /テストが無い/);
});

test('summarizeHarness: 差し戻し / 封鎖の前に提出が 2 本あれば新しい方だけを数え、時刻の読めない差し戻しは無視する', () => {
  const c = clock();
  const older = c.run({ taskId: '7', next: 'reviewer' });
  const newer = c.run({ taskId: '7', next: 'reviewer' });
  const review = c.run({ botKey: 'opus2', taskId: '7' });
  const resubmit = c.run({ taskId: '7', next: 'reviewer' });
  const blockedOlder = c.run({ taskId: '8', next: 'reviewer' });
  const blockedNewer = c.run({ taskId: '8', next: 'reviewer' });
  const block = c.run({ botKey: 'opus2', taskId: '8' });
  const lone = c.run({ taskId: '9', next: 'reviewer' });
  const tasks = [
    { id: '7', history: [{ at: review.endedAt, from: 'review', to: 'in-progress', by: 'opus2', note: '差し戻し: テストが無い' }] },
    { id: '8', history: [{ at: block.endedAt, from: 'review', to: 'blocked', by: 'opus2', note: '封鎖: 範囲外' }] },
    {
      id: '9',
      history: [
        { at: '不明', from: 'review', to: 'in-progress', by: 'opus2', note: '時刻の読めない差し戻し' },
        { from: 'review', to: 'blocked', by: 'opus2', note: '時刻の無い封鎖' },
      ],
    },
  ];
  const s = summarizeHarness([older, newer, review, resubmit, blockedOlder, blockedNewer, block, lone], { tasks });
  const opus = s.bots.find((b) => b.botKey === 'opus');
  assert.equal(opus.current.submissions, 6);
  assert.equal(opus.current.sentBack, 2);
  assert.equal(opus.current.problems, 2);
  assert.deepEqual(s.excerpts.map((e) => [e.at, e.taskId, e.outcome, e.detail]), [
    [blockedNewer.startedAt, '8', 'sent-back', '封鎖: 範囲外'],
    [newer.startedAt, '7', 'sent-back', '差し戻し: テストが無い'],
  ]);
});

test('summarizeHarness: 改訂を戻して前の版に帰ったら、その版の過去の分も足して今の版にする', () => {
  const c = clock();
  const runs = [
    ...c.many(10, stamp('aaaaaaaaaaaa')),
    ...c.many(10, { ...stamp('bbbbbbbbbbbb'), outcome: 'failed' }),
    ...c.many(10, stamp('aaaaaaaaaaaa')),
  ];
  const bot = summarizeHarness(runs, { minRuns: 20 }).bots[0];
  assert.equal(bot.current.rev, 'aaaaaaaaaaaa');
  assert.equal(bot.current.runs, 20);
  assert.equal(bot.previous.rev, 'bbbbbbbbbbbb');
  assert.equal(bot.verdict, 'undetermined', '前の版が 10 本しかないのに判定している');
});

test('summarizeHarness: すぐ前の版が短ければ、その前の測り終えた版を親にする', () => {
  const c = clock();
  const runs = [
    ...c.many(25, {}),
    ...c.many(25, stamp('aaaaaaaaaaaa')),
    ...c.many(3, stamp('bbbbbbbbbbbb')), // すぐ戻した・手で入れた小さな版
    ...c.many(25, stamp('cccccccccccc')),
  ];
  const bot = summarizeHarness(runs, { minRuns: 20 }).bots[0];
  assert.equal(bot.current.rev, 'cccccccccccc');
  assert.equal(bot.previous.rev, 'aaaaaaaaaaaa', '数本しかない版を親にしている');
  assert.equal(bot.verdict, 'flat');

  // 測り終えた版がどこにも無ければ、すぐ前の版 (未確定)
  const d = clock();
  const short = summarizeHarness([...d.many(3, stamp('aaaaaaaaaaaa')), ...d.many(25, stamp('cccccccccccc'))], { minRuns: 20 }).bots[0];
  assert.equal(short.previous.rev, 'aaaaaaaaaaaa');
  assert.equal(short.verdict, 'undetermined');
});

test('summarizeHarness: channel で絞れる・前の版が無ければ比較相手なし', () => {
  const c = clock();
  const runs = [...c.many(3, stamp('aaaaaaaaaaaa')), c.run({ ...stamp('aaaaaaaaaaaa'), channelName: 'other' })];
  const s = summarizeHarness(runs, { channel: 'dev' });
  assert.equal(s.total, 3);
  assert.equal(s.bots[0].verdict, 'baseline');
  assert.equal(s.bots[0].previous, null);
});

test('summarizeHarness: review 遷移の証拠は、遷移を書いた bot がその前に始めたタスクの最後の job の版へ数える', () => {
  const c = clock();
  const before = c.many(3, {}); // 記録前 (証拠なし)
  // 1 回目の提出 (版 A) は差し戻され、2 回目 (版 B) で出し直す — 前の周回の遷移は前の周回の job へ結ぶ
  const first = c.run({ ...stamp('aaaaaaaaaaaa'), taskId: '7', next: 'reviewer' });
  const review = c.run({ botKey: 'opus2', taskId: '7' });
  const second = c.run({ ...stamp('bbbbbbbbbbbb'), taskId: '7', next: 'reviewer' });
  const other = c.run({ ...stamp('bbbbbbbbbbbb'), taskId: '8', next: 'reviewer' });
  const plain = c.run({ ...stamp('bbbbbbbbbbbb'), taskId: '9', next: 'reviewer' });
  const tasks = [
    {
      id: '7',
      history: [
        toReview(first, measuredNote(2)),
        { at: review.endedAt, from: 'review', to: 'in-progress', by: 'opus2', note: '差し戻し: テストが弱い' },
        toReview(second, noSrcNote),
      ],
    },
    // 別 bot の entry — opus2 はタスク 8 で job を始めていないので、opus の job へ寄せない
    { id: '8', history: [toReview(other, unmeasuredNote, 'opus2')] },
    // 頭の無い note・note の無い遷移は証拠ではない
    { id: '9', history: [toReview(plain, noSrcNote.slice(REVIEW_EVIDENCE_NOTE_PREFIX.length)), toReview(plain)] },
  ];
  const s = summarizeHarness([...before, first, review, second, other, plain], { tasks });
  const opus = s.bots.find((b) => b.botKey === 'opus');
  const byRev = Object.fromEntries(opus.revs.map((rev) => [rev.rev, rev]));
  assert.deepEqual(
    byRev.aaaaaaaaaaaa.evidence,
    { ...noEvidence, submissions: 1, measured: 1, withPasses: 1, sentBack: { ...noTally, submissions: 1, measured: 1, withPasses: 1 } },
    '前の周回の証拠 (差し戻された提出)',
  );
  assert.deepEqual(byRev.bbbbbbbbbbbb.evidence, { ...noEvidence, submissions: 1, noSrc: 1 }, '別 bot・頭の無い note を数えている');
  assert.deepEqual(byRev[BASELINE_REV].evidence, noEvidence);
  assert.deepEqual(s.bots.find((b) => b.botKey === 'opus2').current.evidence, noEvidence);
  // 問題の数え方は変わらない (差し戻しは前の周回の提出だけ)
  assert.deepEqual([byRev.aaaaaaaaaaaa.problems, byRev.aaaaaaaaaaaa.sentBack], [1, 1]);
  assert.deepEqual([byRev.bbbbbbbbbbbb.problems, byRev.bbbbbbbbbbbb.submissions], [0, 3]);
});

test('summarizeHarness: channel で絞ると、別 channel の job で書かれた証拠は数えず、同じタスクの前の job へも寄せない', () => {
  const c = clock();
  const earlier = c.run({ ...stamp('aaaaaaaaaaaa'), taskId: '7', next: 'reviewer' });
  const elsewhere = c.run({ ...stamp('aaaaaaaaaaaa'), taskId: '7', next: 'reviewer', channelName: 'other' });
  const tasks = [{ id: '7', history: [toReview(elsewhere, unmeasuredNote)] }];
  assert.deepEqual(summarizeHarness([earlier, elsewhere], { tasks, channel: 'dev' }).bots[0].current.evidence, noEvidence);
  assert.deepEqual(
    summarizeHarness([earlier, elsewhere], { tasks }).bots[0].current.evidence,
    { ...noEvidence, submissions: 1, unmeasured: 1 },
  );
});

test('harnessGate: 測り終えていない改訂があれば待ち、測り終えたら起こす', () => {
  const c = clock();
  const before = c.many(30, {});
  const fresh = c.many(5, stamp('aaaaaaaaaaaa'));
  // 今の版が 5 本 (前の版あり・よく動く bot) → 待つ
  let gate = harnessGate(summarizeHarness([...before, ...fresh]), { now: c.now(), minRuns: 20 });
  assert.equal(gate.due, false);
  assert.deepEqual(gate.pending, ['opus']);

  // 8 日後: 直近 7 日に 1 本も動いていない (20 本に届かない) ので待たない — 門の条件 (b)。
  // 版が始まって 7 日過ぎた (c) はここでは通らない (別のテスト)。判定できる版も無いので起こしはしない
  gate = harnessGate(summarizeHarness([...before, ...fresh]), { now: c.now() + 8 * DAY_MIN * 60_000, minRuns: 20 });
  assert.equal(gate.due, false);
  assert.deepEqual(gate.pending, []);
  assert.match(gate.reason, /判定できる版が無い/);

  // 20 本に届いたら起こす
  const measured = [...before, ...fresh, ...c.many(15, stamp('aaaaaaaaaaaa'))];
  gate = harnessGate(summarizeHarness(measured), { now: c.now(), minRuns: 20 });
  assert.equal(gate.due, true);
  assert.equal(gate.reason, '計測済み');
});

test('harnessGate: どの bot も判定できる本数が無ければ起こさない・悪化は名前を挙げる', () => {
  const c = clock();
  let gate = harnessGate(summarizeHarness(c.many(5, {})), { now: c.now(), minRuns: 20 });
  assert.equal(gate.due, false);
  assert.match(gate.reason, /判定できる版が無い/);

  // 記録前がいくら多くても測り終えた版には数えない — 再起動後の最初の版が 20 本に届いてから起こす
  // (先に改訂すると、その版を親にした比較が未確定のまま動かなくなる)
  const b = clock();
  gate = harnessGate(summarizeHarness(b.many(73, {})), { now: b.now(), minRuns: 20 });
  assert.equal(gate.due, false, '記録前だけで巡回を起こしている');
  assert.deepEqual(gate.pending, []);

  // 使われない bot (窓の中で 20 本未満) の計測は待たない
  const d = clock();
  const runs = [
    ...d.many(25, {}),
    ...d.many(25, (i) => ({ ...stamp('aaaaaaaaaaaa'), outcome: i < 12 ? 'failed' : 'ok' })),
    ...d.many(4, { botKey: 'sol' }),
    ...d.many(2, { botKey: 'sol', ...stamp('cccccccccccc') }),
  ];
  gate = harnessGate(summarizeHarness(runs), { now: d.now(), minRuns: 20 });
  assert.equal(gate.due, true);
  assert.deepEqual(gate.worse, ['opus']);
  assert.match(gate.reason, /悪化: opus/);
});

test('harnessGate: 前は動いていたが今はたまにしか呼ばれない bot (提案役など) の計測は待たない', () => {
  const old = clock();
  const before = old.many(30, { botKey: 'fable' }); // 2026-10-01 ごろに 30 本
  const now = clock(15 * DAY_MIN); // 15 日後
  const runs = [
    ...before,
    ...now.many(2, (i) => ({ id: `f${i}`, botKey: 'fable', ...stamp('ffffffffffff') })),
    ...now.many(25, (i) => ({ id: `o${i}`, ...stamp('aaaaaaaaaaaa') })),
  ];
  const gate = harnessGate(summarizeHarness(runs), { now: now.now(), minRuns: 20 });
  assert.deepEqual(gate.pending, [], 'たまにしか呼ばれない bot の 20 本を待っている');
  assert.equal(gate.due, true);
});

test('harnessGate: 版を戻して (A → B → A) 今の版の最初の job が 7 日より前なら、本数が足りなくても待たない', () => {
  const summarize = (startA) => {
    const old = clock(startA);
    const first = old.many(5, stamp('aaaaaaaaaaaa'));
    const recent = clock(10 * DAY_MIN);
    const runs = [
      ...first,
      ...recent.many(25, (i) => ({ id: `b${i}`, ...stamp('bbbbbbbbbbbb') })), // よく動く bot
      ...recent.many(3, (i) => ({ id: `a${i}`, ...stamp('aaaaaaaaaaaa') })), // A に戻して 3 本
    ];
    return { s: summarizeHarness(runs, { minRuns: 20 }), first, now: recent.now() };
  };

  // A の最初の job は 10 日前。直近 7 日には 28 本動いているので (b) では抜けない
  const { s, first, now } = summarize(0);
  const bot = s.bots[0];
  assert.equal(bot.current.rev, 'aaaaaaaaaaaa');
  assert.equal(bot.current.runs, 8);
  assert.equal(bot.current.firstAt, first[0].startedAt, '今の版の始まりを戻した後の job から数えている');
  assert.equal(bot.previous.rev, 'bbbbbbbbbbbb');
  assert.equal(bot.runStarts.filter((ms) => now - ms < 7 * DAY_MIN * 60_000).length, 28);
  let gate = harnessGate(s, { now, minRuns: 20 });
  assert.deepEqual(gate.pending, [], '7 日より前に始まった版の 20 本を待っている');
  assert.match(gate.reason, /判定できる版が無い/);

  // 対照: A の最初の job が 2 日前なら待つ
  const near = summarize(8 * DAY_MIN);
  gate = harnessGate(near.s, { now: near.now, minRuns: 20 });
  assert.deepEqual(gate.pending, ['opus']);
  assert.match(gate.reason, /改訂の計測中/);
});

test('formatHarnessReport / verdictLine: 判定・版・抜粋が読める形で出る', () => {
  const c = clock();
  const runs = [
    ...c.many(20, {}),
    ...c.many(20, (i) => ({ ...stamp('aaaaaaaaaaaa', { effort: 'high' }), outcome: i === 0 ? 'verify-failed' : 'ok', taskId: i === 0 ? '9' : null })),
  ];
  const s = summarizeHarness(runs);
  const line = verdictLine(s.bots[0]);
  assert.match(line, /^opus \(worker\): 今 `aaaaaaaaaaaa` 20 本・問題 5% ← 前 記録前 20 本・0% → 同等 \(z /);
  const text = formatHarnessReport(s);
  assert.match(text, /# ハーネスの成績 \(job 40 本/);
  assert.match(text, /`aaaaaaaaaaaa` \(claude \/ opus \/ high\)/);
  assert.match(text, /## 問題の抜粋 \(新しい順に 1 \/ 1 件\)/);
  assert.match(text, /dev task #9 verify-failed/);
  assert.match(formatHarnessReport({ bots: [], excerpts: [], total: 0, from: null, to: null }), /\(記録なし\)/);
  assert.doesNotMatch(text, /証拠/, '証拠の無い版に行を足している');
  // 抜粋には job id が付き、手順の要約は呼び出し側が付けたときだけ出る
  assert.equal(s.excerpts[0].runId, 'r21');
  assert.doesNotMatch(text, /手順/);
  s.excerpts[0].trace = '読む×3 → 編集 a.js → $ npm test ✗';
  assert.match(formatHarnessReport(s), /dev task #9 verify-failed.*\n {2}- 手順 \(job r21\): 読む×3 → 編集 a\.js → \$ npm test ✗/);
});

test('formatHarnessReport: 証拠のある版にだけ内訳の行を足し、テストの変更なし・読めないは 0 なら出さない', () => {
  const c = clock();
  const before = c.many(3, {}); // 記録前 (証拠なし)
  const submit = (rev, taskId) => c.run({ ...stamp(rev), taskId, next: 'reviewer' });
  const a = [submit('aaaaaaaaaaaa', '1'), submit('aaaaaaaaaaaa', '2'), submit('aaaaaaaaaaaa', '3')];
  const b = [submit('bbbbbbbbbbbb', '4'), submit('bbbbbbbbbbbb', '5')];
  const tasks = [
    { id: '1', history: [toReview(a[0], measuredNote(2))] },
    { id: '2', history: [toReview(a[1], measuredNote(0))] },
    { id: '3', history: [toReview(a[2], unmeasuredNote)] },
    { id: '4', history: [toReview(b[0], noTestsNote)] },
    { id: '5', history: [toReview(b[1], evidenceNote('知らない形'))] },
  ];
  const lines = formatHarnessReport(summarizeHarness([...before, ...a, ...b], { tasks })).split('\n');
  const after = (rev) => lines[lines.findIndex((line) => line.startsWith(`- ${rev}`)) + 1];
  assert.equal(after('`aaaaaaaaaaaa`'), '  - 証拠 提出 3 件 — 落ちないあり 1 / src の差分なし 0 / 測れず 1');
  assert.equal(after('`bbbbbbbbbbbb`'), '  - 証拠 提出 2 件 — 落ちないあり 0 / src の差分なし 0 / 測れず 0 / テストの変更なし 1 / 読めない 1');
  assert.doesNotMatch(after(BASELINE_REV), /証拠/, '証拠の無い版に行を足している');
});

test('formatHarnessReport: 差し戻された提出と通った提出が混ざった版は種類ごとに差し戻しの本数を添え、停止で中断は測れずに数える', () => {
  const c = clock();
  const submit = (taskId) => c.run({ ...stamp('aaaaaaaaaaaa'), taskId, next: 'reviewer' });
  const runs = ['1', '2', '3', '4', '5', '6', '7'].map(submit);
  const judged = (to, note) => ({ at: iso(10_000), from: 'review', to, by: 'opus2', note });
  const tasks = [
    { id: '1', history: [toReview(runs[0], measuredNote(2)), judged('in-progress', '差し戻し: 落ちないテストが変更を検査していない')] },
    { id: '2', history: [toReview(runs[1], measuredNote(1)), judged('merged')] },
    { id: '3', history: [toReview(runs[2], measuredNote(3)), judged('merged')] },
    { id: '4', history: [toReview(runs[3], noSrcNote), judged('merged')] },
    { id: '5', history: [toReview(runs[4], stoppedNote), judged('in-progress', '差し戻し: 測り直して')] },
    { id: '6', history: [toReview(runs[5], unmeasuredNote), judged('merged')] },
    { id: '7', history: [toReview(runs[6], noTestsNote), judged('blocked', '封鎖: テストが無い')] },
  ];
  const s = summarizeHarness(runs, { tasks });
  assert.deepEqual(s.bots[0].current.evidence.sentBack, { ...noTally, submissions: 3, measured: 1, withPasses: 1, noTests: 1, unmeasured: 1 });
  const lines = formatHarnessReport(s).split('\n');
  const at = lines.findIndex((line) => line.startsWith('- `aaaaaaaaaaaa`'));
  assert.match(lines[at], /差し戻し 3 \/ 提出 7$/);
  // 差し戻しが 0 の種類 (src の差分なし) には添えない。停止で中断 (5) は読めないではなく測れずに入る
  assert.equal(
    lines[at + 1],
    '  - 証拠 提出 7 件 — 落ちないあり 3 (差し戻し 1) / src の差分なし 1 / 測れず 2 (差し戻し 1) / テストの変更なし 1 (差し戻し 1)',
  );
});

test('formatHarnessReport: テストを消した提出は種類を問わず「消したテストあり」に数え、差し戻しの本数を添えて末尾に足す', () => {
  const c = clock();
  const submit = (taskId) => c.run({ ...stamp('aaaaaaaaaaaa'), taskId, next: 'reviewer' });
  const runs = ['1', '2', '3', '4', '5'].map(submit);
  const judged = (to, note) => ({ at: iso(10_000), from: 'review', to, by: 'opus2', note });
  const deleted = { deletedTests: ['test/gone.test.js'] };
  const tasks = [
    // テストファイルを消して src だけ直した提出 — 種類は「テストの変更なし」のまま、消したテストありにも入る
    {
      id: '1',
      history: [
        toReview(runs[0], evidenceNote(formatReviewEvidence({ ...EVIDENCE_BASE, outcome: 'no-tests', tests: [], ...deleted }))),
        judged('in-progress', '差し戻し: 落ちるテストを消して通している'),
      ],
    },
    // 変更したファイルからテストの名前だけが消えた提出 (落ちないテストもある)
    {
      id: '2',
      history: [
        toReview(runs[1], evidenceNote(formatReviewEvidence({
          ...EVIDENCE_BASE, outcome: 'measured', tests: ['test/a.test.js'], counts: { fails: 1, passes: 1, headFails: 0 },
          vanishedTests: [{ file: 'test/a.test.js', tests: 2 }],
        }))),
        judged('merged'),
      ],
    },
    // test/ だけの提出でもテストは消せる
    {
      id: '3',
      history: [
        toReview(runs[2], evidenceNote(formatReviewEvidence({
          ...EVIDENCE_BASE, src: { added: [], restored: [] }, outcome: 'no-src', tests: ['test/a.test.js'], ...deleted,
        }))),
        judged('merged'),
      ],
    },
    // 消していない提出は数えない
    { id: '4', history: [toReview(runs[3], measuredNote(0)), judged('merged')] },
    { id: '5', history: [toReview(runs[4], noTestsNote), judged('in-progress', '差し戻し: テストが無い')] },
  ];
  const s = summarizeHarness(runs, { tasks });
  const rev = s.bots[0].current;
  assert.deepEqual(rev.evidence, {
    ...noTally, submissions: 5, measured: 2, withPasses: 1, noSrc: 1, noTests: 2, withDeleted: 3,
    sentBack: { ...noTally, submissions: 2, noTests: 2, withDeleted: 1 },
  });
  const lines = formatHarnessReport(s).split('\n');
  const at = lines.findIndex((line) => line.startsWith('- `aaaaaaaaaaaa`'));
  assert.equal(
    lines[at + 1],
    '  - 証拠 提出 5 件 — 落ちないあり 1 / src の差分なし 1 / 測れず 0 / テストの変更なし 2 (差し戻し 2) / 消したテストあり 3 (差し戻し 1)',
  );
  // 問題の数え方は変わらない (差し戻した 2 本だけ)
  assert.deepEqual([rev.problems, rev.sentBack, rev.submissions], [2, 2, 5]);
});

test('formatHarnessReport: 「落ちる」が全部基点で読み込めずの measured を「落ちるが全部読み込めず」に数え、差し戻しの本数を添えて消したテストありの前に足す', () => {
  const c = clock();
  const submit = (taskId) => c.run({ ...stamp('aaaaaaaaaaaa'), taskId, next: 'reviewer' });
  const runs = ['1', '2', '3', '4', '5'].map(submit);
  const judged = (to, note) => ({ at: iso(10_000), from: 'review', to, by: 'opus2', note });
  const tap = (pass, fail = 0, extra = {}) => ({ tests: pass + fail, pass, fail, ...extra });
  const loadFailed = (file) => ({ file, verdict: 'fails', head: { ok: true, tap: tap(3) }, base: { ok: false, tap: tap(0, 1, { loadFailed: true }) } });
  const fails = (file) => ({ file, verdict: 'fails', head: { ok: true, tap: tap(3) }, base: { ok: false, tap: tap(2, 1) } });
  const passes = (file) => ({ file, verdict: 'passes', head: { ok: true, tap: tap(3) }, base: { ok: true, tap: tap(3) } });
  const note = (testRuns, extra = {}) => evidenceNote(formatReviewEvidence({
    ...EVIDENCE_BASE, outcome: 'measured', tests: testRuns.map((r) => r.file), runs: testRuns, counts: summarizeRuns(testRuns), ...extra,
  }));
  // 本数の行を 5 件まで出して残りを畳んだ形 (畳んだ行の k も足して 7 本)
  const seven = Array.from({ length: 7 }, (_, i) => loadFailed(`test/l${i}.test.js`));
  const tasks = [
    { id: '1', history: [toReview(runs[0], note([loadFailed('test/a.test.js')])), judged('in-progress', '差し戻し: export を足しただけ')] },
    { id: '2', history: [toReview(runs[1], note(seven, { deletedTests: ['test/gone.test.js'] })), judged('merged')] },
    // 読み込めずが「落ちる」の一部だけ・「落ちる」が無い (落ちない) 提出は数えない
    { id: '3', history: [toReview(runs[2], note([loadFailed('test/a.test.js'), fails('test/b.test.js')])), judged('merged')] },
    { id: '4', history: [toReview(runs[3], note([passes('test/a.test.js')])), judged('merged')] },
    // 本数の行の無い証拠 (落ちる 1) も数えない
    { id: '5', history: [toReview(runs[4], measuredNote(0)), judged('merged')] },
  ];
  const s = summarizeHarness(runs, { tasks });
  const rev = s.bots[0].current;
  assert.deepEqual(rev.evidence, {
    ...noTally, submissions: 5, measured: 5, withPasses: 1, allLoadFailed: 2, withDeleted: 1,
    sentBack: { ...noTally, submissions: 1, measured: 1, allLoadFailed: 1 },
  });
  const lines = formatHarnessReport(s).split('\n');
  const at = lines.findIndex((line) => line.startsWith('- `aaaaaaaaaaaa`'));
  assert.equal(
    lines[at + 1],
    '  - 証拠 提出 5 件 — 落ちないあり 1 / src の差分なし 0 / 測れず 0 / 落ちるが全部読み込めず 2 (差し戻し 1) / 消したテストあり 1',
  );
  // 問題の数え方は変わらない (差し戻した 1 本だけ)
  assert.deepEqual([rev.problems, rev.sentBack, rev.submissions], [1, 1, 5]);
});

// ---- 改訂の台帳 (arXiv 2610.02616 VERSE の訓練の監査) ----

const WORKER_FILES = ['roles/_common.md', 'roles/worker.md'];
const roleTask = (id, mergedMin, over = {}) => ({
  id, state: 'merged', title: `改訂 ${id}`, rationale: `狙い ${id}`, touch: ['roles/worker.md'],
  history: [
    { at: iso(mergedMin - 5), from: 'approved', to: 'in-progress', by: 'scheduler' },
    { at: iso(mergedMin), from: 'review', to: 'merged', by: 'reviewer' },
  ],
  ...over,
});

test('revisionLedger: 役割文を触った merge 済みのタスクを、その merge で始まった版と bot ごとに結ぶ', () => {
  const c = clock();
  const before = c.many(20, stamp('aaaaaaaaaaaa', { files: WORKER_FILES })); // 10〜200 分
  const after = c.many(20, (i) => ({
    ...stamp('bbbbbbbbbbbb', { files: WORKER_FILES }),
    outcome: i === 3 ? 'verify-failed' : 'ok',
    taskId: i === 3 ? '9' : null,
  })); // 210〜400 分
  const s = summarizeHarness([...before, ...after]);
  const tasks = [
    roleTask('1', 205),
    roleTask('2', 100, { title: 'aaaa の途中で入った改訂' }),                        // 版の切り替わりと合わない
    roleTask('3', 205, { touch: ['roles/reviewer.md'] }),                          // 版が読んでいない役割文
    roleTask('4', 205, { touch: ['src/a.js'] }),                                   // 役割文を触っていない
    roleTask('5', 205, { state: 'review', history: [{ at: iso(200), to: 'review' }] }), // まだ merge されていない
  ];
  const ledger = revisionLedger(s, tasks);
  assert.deepEqual(ledger.map((r) => [r.taskId, r.effects.length]), [['1', 1], ['3', 0], ['2', 0]]);
  const [first] = ledger;
  assert.equal(first.title, '改訂 1');
  assert.equal(first.rationale, '狙い 1');
  assert.deepEqual(first.files, ['roles/worker.md']);
  assert.equal(first.mergedAt, iso(205));
  const [effect] = first.effects;
  assert.equal(effect.botKey, 'opus');
  assert.equal(effect.rev.rev, 'bbbbbbbbbbbb');
  assert.equal(effect.parent.rev, 'aaaaaaaaaaaa');
  assert.equal(effect.current, true);
  assert.equal(effect.verdict, 'flat');
  assert.deepEqual(effect.rev.problemTasks, [{ taskId: '9', outcome: 'verify-failed' }]);
  assert.equal(
    ledgerEffectLine(effect),
    `opus: \`aaaaaaaaaaaa\` 20 本・0% → \`bbbbbbbbbbbb\` 20 本・問題 1 (5%) — #9 verify-failed [今の版: 同等 (z ${effect.z.toFixed(2)})]`,
  );
  assert.deepEqual(revisionLedger(s, tasks, { limit: 1 }).map((r) => r.taskId), ['1']);
  assert.deepEqual(revisionLedger(s, []), []);
});

test('revisionLedger: 今の版でない版は判定を付けず、問題のタスクは差し戻しを sent-back として 1 回だけ数える', () => {
  const c = clock();
  const a = c.many(20, stamp('aaaaaaaaaaaa', { files: WORKER_FILES }));
  const b = c.many(20, (i) => ({ ...stamp('bbbbbbbbbbbb', { files: WORKER_FILES }), taskId: i < 2 ? '7' : null, next: i < 2 ? 'reviewer' : 'human' }));
  const back = c.many(20, stamp('aaaaaaaaaaaa', { files: WORKER_FILES })); // 戻した
  const sentBackAt = Date.parse(b[1].endedAt) + 60_000;
  const tasks = [
    roleTask('1', 205),
    { id: '7', state: 'merged', title: 't', touch: ['src/a.js'], history: [{ at: new Date(sentBackAt).toISOString(), from: 'review', to: 'in-progress', note: '直して' }] },
  ];
  const s = summarizeHarness([...a, ...b, ...back], { tasks });
  const [effect] = revisionLedger(s, tasks)[0].effects;
  assert.equal(effect.rev.rev, 'bbbbbbbbbbbb');
  assert.equal(effect.current, false);
  assert.equal(effect.verdict, null);
  assert.deepEqual(effect.rev.problemTasks, [{ taskId: '7', outcome: 'sent-back' }]);
  assert.doesNotMatch(ledgerEffectLine(effect), /今の版/);
});

test('formatHarnessReport / ledgerStartLines: 台帳を渡したときだけ節を出し、起動文にはいちばん新しい改訂を短く載せる', () => {
  const c = clock();
  const s = summarizeHarness([
    ...c.many(20, stamp('aaaaaaaaaaaa', { files: WORKER_FILES })),
    ...c.many(20, stamp('bbbbbbbbbbbb', { files: WORKER_FILES })),
  ]);
  const ledger = revisionLedger(s, [roleTask('1', 205, { rationale: '長い狙い '.repeat(100) }), roleTask('0', 1)]);
  const text = formatHarnessReport(s, { ledger });
  assert.match(text, /## 改訂の台帳 \(役割文を触った merge 済みのタスク → その merge で始まった版。新しい順に 2 件\)/);
  // 時刻は JST (merge は iso(205) = 10-01T03:25Z)。版の期間も同じ時計で、札は成績の見出しにだけ付く
  assert.match(text, /^# ハーネスの成績 \(job 40 本 \/ 10-01 09:10 〜 10-01 15:40 JST \//);
  assert.match(text, /^- `aaaaaaaaaaaa` \(claude \/ opus\): 10-01 09:10 〜 10-01 12:20 \/ job 20 本/m);
  assert.match(text, /- #1 10-01 12:25 merge \(roles\/worker\.md\): 改訂 1\n {2}- 狙い: 長い狙い .*…\n {2}- opus: `aaaaaaaaaaaa` 20 本・0% → `bbbbbbbbbbbb` 20 本・問題 0 \(0%\) \[今の版: 同等 \(z 0\.00\)\]/);
  assert.match(text, /- #0 .*\n {2}- 狙い: 狙い 0\n {2}- \(その merge で始まった版が実行記録に無い\)/);
  assert.ok(text.indexOf('## 改訂の台帳') < text.indexOf('## 問題の抜粋'));
  assert.doesNotMatch(formatHarnessReport(s), /改訂の台帳/);
  assert.match(formatHarnessReport(s, { ledger: [] }), /## 改訂の台帳 .*\n.*\n\(なし\)/);

  const lines = ledgerStartLines(ledger);
  assert.equal(lines.length, 2);
  // 起動文に載る行も JST で、札なし (幅は UTC のときと同じ `MM-DD HH:MM`)
  assert.match(lines[0], /^#1 10-01 12:25 merge \(roles\/worker\.md\): 改訂 1 — 狙い: 長い狙い .*…$/);
  assert.ok(lines[0].length < 260, lines[0]);
  assert.match(lines[1], /^opus: /);
  assert.deepEqual(ledgerStartLines([]), []);
  assert.deepEqual(ledgerStartLines(null), []);
  assert.deepEqual(ledgerStartLines([{ ...ledger[1] }]).slice(1), ['(その merge で始まった版が実行記録に無い)']);
});

test('day / formatHarnessReport: 時刻は JST の `MM-DD HH:MM` — 日付の境目は UTC 15:00、読めない値は ?', () => {
  assert.equal(day('2026-10-13T14:59:00.000Z'), '10-13 23:59');
  assert.equal(day('2026-10-13T15:00:00.000Z'), '10-14 00:00');
  for (const unreadable of [null, undefined, '', 'abc']) assert.equal(day(unreadable), '?', String(unreadable));

  const c = clock();
  const at = (stampIso) => ({ acceptedAt: stampIso, startedAt: stampIso, endedAt: stampIso });
  const s = summarizeHarness([
    c.run({ ...at('2026-10-13T14:59:00.000Z'), ...stamp('aaaaaaaaaaaa'), outcome: 'verify-failed', reason: 'verify-failed', next: 'bot' }),
    c.run({ ...at('2026-10-13T15:00:00.000Z'), ...stamp('aaaaaaaaaaaa') }),
  ]);
  const text = formatHarnessReport(s);
  assert.match(text, /^# ハーネスの成績 \(job 2 本 \/ 10-13 23:59 〜 10-14 00:00 JST \/ 実行記録は 30 日で消える\)$/m);
  assert.match(text, /^- `aaaaaaaaaaaa` \(claude \/ opus\): 10-13 23:59 〜 10-14 00:00 \/ job 2 本/m);
  assert.match(text, /^- 10-13 23:59 opus `aaaaaaaaaaaa` dev verify-failed/m);
  // 札は見出しの 1 回だけ (版の行・抜粋の行には付けない)
  assert.equal(text.match(/JST/g).length, 1);
  assert.match(formatHarnessReport(summarizeHarness([])), /^# ハーネスの成績 \(job 0 本 \/ \? 〜 \? JST \//);
});

test('summarizeHarness: 解き直し (src/replay.js) の job は数えない — merge 前に下書きの版で走っても、台帳は merge で始まった版を改訂に結ぶ', () => {
  const c = clock();
  const before = c.many(20, stamp('aaaaaaaaaaaa', { files: WORKER_FILES }));              // 10〜200 分
  // 改訂 #1 の下書き (版 bbbb) で過去のタスクを解き直した job — merge (305 分) より前、1 本は verify NG
  const replays = c.many(3, (i) => ({ ...stamp('bbbbbbbbbbbb', { files: WORKER_FILES }), taskId: '50', outcome: i === 0 ? 'verify-failed' : 'ok' })); // 210〜230 分
  const gap = c.many(7, stamp('aaaaaaaaaaaa', { files: WORKER_FILES }));                 // 240〜300 分
  const after = c.many(20, stamp('bbbbbbbbbbbb', { files: WORKER_FILES }));              // 310〜500 分
  const tasks = [
    roleTask('1', 305),
    { id: '50', state: 'dropped', title: '[replay] x', touch: ['src/a.js'], replay: { of: '1', caseId: '9', kind: 'sent-back', base: 'abc1234' }, history: [] },
  ];
  const s = summarizeHarness([...before, ...replays, ...gap, ...after], { tasks });
  const bbbb = s.bots[0].revs.find((r) => r.rev === 'bbbbbbbbbbbb');
  assert.equal(bbbb.runs, 20, '解き直しの job を本番の版に数えている');
  assert.equal(bbbb.problems, 0);
  assert.equal(bbbb.firstAt, after[0].startedAt);
  assert.equal(s.total, 47);
  assert.deepEqual(s.excerpts, [], '解き直しの verify NG を問題の抜粋に出している');
  const [effect] = revisionLedger(s, tasks)[0].effects;
  assert.equal(effect.rev.rev, 'bbbbbbbbbbbb');
  assert.equal(effect.parent.rev, 'aaaaaaaaaaaa');

  // 板に解き直しの印が無い (旧い板・解き直し以外のタスク) なら今までどおり数える
  const plain = summarizeHarness([...before, ...replays, ...gap, ...after], { tasks: [roleTask('1', 305)] });
  assert.equal(plain.bots[0].revs.find((r) => r.rev === 'bbbbbbbbbbbb').runs, 23);
});

/** 重さを載せた実行記録 (tool 呼び出しは evidence に、終端は起動から minutes 分後に置く) */
const weigh = (run, toolCalls, minutes) => ({
  ...run,
  evidence: { toolCalls },
  endedAt: new Date(Date.parse(run.startedAt) + minutes * 60_000).toISOString(),
});
const reviewContract = { contract: { id: 'c1', kind: 'task-review', nonce: null, fromBotKey: 'lead' } };
const approvalContract = { contract: { id: 'c2', kind: 'task-approval', nonce: null, fromBotKey: 'lead' } };

/** 前の版 aaaa (25 本) → すぐ戻した重い版 bbbb (3 本) → 今の版 cccc (25 本 + 数えない 1 本) → 版不明 1 本 */
function weighedRuns() {
  const c = clock();
  const aaaa = [
    ...c.many(20, { ...stamp('aaaaaaaaaaaa'), taskId: '1' }).map((r, i) => weigh(r, 20 + i, 8)), // tool 20〜39 → 中央値 29.5
    ...c.many(5, { ...stamp('aaaaaaaaaaaa'), taskId: '1', ...reviewContract }).map((r) => weigh(r, 10, 2)), // taskId があってもレビュー
  ];
  const bbbb = c.many(3, { ...stamp('bbbbbbbbbbbb'), taskId: '1' }).map((r) => weigh(r, 1000, 100));
  const cccc = [
    ...c.many(20, { ...stamp('cccccccccccc'), taskId: '1' }).map((r) => weigh(r, 59, 16)),
    weigh(c.run({ ...stamp('cccccccccccc'), taskId: '1' }), null, 16), // tool 呼び出しの記録なし → tool だけ外す
    { ...weigh(c.run({ ...stamp('cccccccccccc'), taskId: '1', outcome: 'failed' }), 3, 16), startedAt: null }, // 起動の時刻なし → 分だけ外す
    ...c.many(2, { ...stamp('cccccccccccc'), taskId: '2', ...approvalContract }).map((r) => weigh(r, 5, 1)),
    weigh(c.run(stamp('cccccccccccc')), 7, 3), // taskId なし → その他
    weigh(c.run({ ...stamp('cccccccccccc'), taskId: '1', outcome: 'stopped', stopKind: 'human' }), 999, 99), // runs に数えない
  ];
  const unattributed = weigh(c.run({ taskId: '1' }), 999, 99); // 指紋の後の無印 → 版不明
  return [...aaaa, ...bbbb, ...cccc, unattributed];
}

test('summarizeHarness: 版 × job 種別の tool 呼び出しと所要分の中央値を数え、今の版 ← 判定と同じ前の版の比を出す', () => {
  const bot = summarizeHarness(weighedRuns(), { minRuns: 20 }).bots[0];
  assert.equal(bot.current.rev, 'cccccccccccc');
  assert.equal(bot.previous.rev, 'aaaaaaaaaaaa');
  // 種別の job 数の合計は版の runs と同じ (人間の停止・版不明の job は入らない)
  for (const rev of bot.revs) {
    assert.equal(Object.values(rev.cost).reduce((sum, k) => sum + k.jobs, 0), rev.runs, `${rev.rev} の種別の合計が runs と合わない`);
  }
  assert.equal(bot.current.runs, 25);
  const prev = bot.previous.cost;
  assert.deepEqual(prev['task-work'], { jobs: 20, toolCalls: { n: 20, median: 29.5 }, minutes: { n: 20, median: 8 } });
  assert.deepEqual(prev.review, { jobs: 5, toolCalls: { n: 5, median: 10 }, minutes: { n: 5, median: 2 } }, 'taskId のあるレビューを task-work に数えている');
  const now = bot.current.cost;
  assert.deepEqual(
    now['task-work'],
    { jobs: 22, toolCalls: { n: 21, median: 59 }, minutes: { n: 21, median: 16 } },
    'tool 呼び出しの記録が無い job を 0 回に・起動の時刻が無い job を受付の時刻から数えている',
  );
  assert.deepEqual(now.approval, { jobs: 2, toolCalls: { n: 2, median: 5 }, minutes: { n: 2, median: 1 } });
  assert.deepEqual(now.other, { jobs: 1, toolCalls: { n: 1, median: 7 }, minutes: { n: 1, median: 3 } });
  assert.deepEqual(now.review, { jobs: 0, toolCalls: { n: 0, median: null }, minutes: { n: 0, median: null } });
  // 比の分母は判定と同じ前の版 (aaaa) — すぐ戻した重い版 bbbb ではない。どちらかに job のある種別だけ
  const none = { current: null, previous: null, ratio: null };
  assert.deepEqual(bot.cost, [
    { kind: 'task-work', jobs: { current: 22, previous: 20 }, toolCalls: { current: 59, previous: 29.5, ratio: 2 }, minutes: { current: 16, previous: 8, ratio: 2 } },
    { kind: 'review', jobs: { current: 0, previous: 5 }, toolCalls: { ...none, previous: 10 }, minutes: { ...none, previous: 2 } },
    { kind: 'approval', jobs: { current: 2, previous: 0 }, toolCalls: { ...none, current: 5 }, minutes: { ...none, current: 1 } },
    { kind: 'other', jobs: { current: 1, previous: 0 }, toolCalls: { ...none, current: 7 }, minutes: { ...none, current: 3 } },
  ]);

  // 前の版が無ければ比は出さない (前の側は null)
  const c = clock();
  assert.deepEqual(summarizeHarness([weigh(c.run({ taskId: '1' }), 4, 2)]).bots[0].cost, [
    { kind: 'task-work', jobs: { current: 1, previous: null }, toolCalls: { ...none, current: 4 }, minutes: { ...none, current: 2 } },
  ]);
});

test('summarizeHarness: 重さは判定・門・判定の行に入れない — 重さを消しても成績は同じ', () => {
  const runs = weighedRuns();
  const light = runs.map((run) => ({ ...run, evidence: null, contract: null, endedAt: run.startedAt ?? run.acceptedAt }));
  const heavy = summarizeHarness(runs, { minRuns: 20 });
  const bare = summarizeHarness(light, { minRuns: 20 });
  assert.notDeepEqual(heavy.bots[0].cost, bare.bots[0].cost, '重さが変わっていない (比べた意味がない)');
  const pick = (s) => s.bots.map((b) => [b.verdict, b.z, verdictLine(b), b.current.problems, b.previous.problems, b.unattributed]);
  assert.deepEqual(pick(heavy), pick(bare));
  assert.deepEqual(heavy.excerpts, bare.excerpts);
  const now = Date.parse(runs.at(-1).startedAt) + 60_000;
  assert.deepEqual(harnessGate(heavy, { now, minRuns: 20 }), harnessGate(bare, { now, minRuns: 20 }));
});

test('formatHarnessReport: 版ごとに種別の重さの行を足し、前の版がある bot には今 ← 前の比の行を足す', () => {
  const text = formatHarnessReport(summarizeHarness(weighedRuns(), { minRuns: 20 }), { minRuns: 20 });
  assert.match(text, /^重さ = 版 × job 種別 .*判定には入れない/m);
  assert.match(
    text,
    /## opus \(worker\): .*\n- 重さ 今 ← 前 \(中央値\) task-work 22 ← 20 本・tool 59 ← 29\.5 \(×2\.00\)・分 16\.0 ← 8\.0 \(×2\.00\) \/ review 0 ← 5 本・tool — ← 10・分 — ← 2\.0 \/ approval 2 ← 0 本・tool 5 ← —・分 1\.0 ← — \/ その他 1 ← 0 本・tool 7 ← —・分 3\.0 ← —\n/,
  );
  // 中央値を取った本数が job 数より少なければ添える
  assert.match(text, /- `cccccccccccc` .*\n {2}- 重さ \(中央値\) task-work 22 本・tool 59 \(21 本\)・分 16\.0 \(21 本\) \/ approval 2 本・tool 5・分 1\.0 \/ その他 1 本・tool 7・分 3\.0\n/);
  assert.match(text, /- `bbbbbbbbbbbb` .*\n {2}- 重さ \(中央値\) task-work 3 本・tool 1000・分 100\.0\n/);

  // 前の版の無い bot には比の行を出さない (版の行に同じ中央値がある)
  const c = clock();
  const lone = formatHarnessReport(summarizeHarness([weigh(c.run({ taskId: '1' }), null, 2)]));
  assert.doesNotMatch(lone, /- 重さ 今 ← 前/);
  assert.match(lone, /\n {2}- 重さ \(中央値\) task-work 1 本・tool — \(0 本\)・分 2\.0\n/);
});

/** 提出 1 本 (verify の試行回数を evidence に載せる。undefined なら evidence ごと無い) */
const submitted = (c, rev, taskId, verifyAttempts) => c.run({
  ...stamp(rev), taskId, next: 'reviewer', ...(verifyAttempts === undefined ? {} : { evidence: { verifyAttempts } }),
});
/** レビューの遷移。merge の指摘の件数は historyExtra で entry の直下に載る (undefined なら鍵ごと無い) */
const reviewed = (run, to, remarks) => ({
  at: run.endedAt, from: 'review', to, by: 'opus2', ...(remarks === undefined ? {} : { remarks }),
});

/**
 * 前の版 aaaa (20 本・問題 1) → 今の版 bbbb の提出 18 本。bbbb の内訳:
 * 測れた 9 本 = 通った 3 (#1・#5 の出し直し・#11 の出し直し) / 再試行 3 (#2・#4・#6) / 指摘 2 (#3・#4) /
 *   差し戻し 3 (#5・#6 は封鎖・#11 の新しい方)
 * 外す 9 本 = verify の回数 null の差し戻し (#7)・remarks の鍵なし (#8)・remarks null (#9)・remarks 負 (#15)・
 *   レビュー中 (#10)・差し戻しの前の古い提出 (#11)・verify の回数 0 / 小数 / 文字列 (#12〜#14)
 */
function firstPassRuns() {
  const c = clock();
  const before = c.many(20, (i) => ({ ...stamp('aaaaaaaaaaaa'), outcome: i === 0 ? 'verify-failed' : 'ok' }));
  const submit = (taskId, attempts) => submitted(c, 'bbbbbbbbbbbb', taskId, attempts);
  const s1 = submit('1', 1);
  const s2 = submit('2', 2);
  const s3 = submit('3', 1);
  const s4 = submit('4', 3);
  const s5 = [submit('5', 1), submit('5', 1)];
  const s6 = submit('6', 2);
  const s7 = submit('7', null);
  const s8 = submit('8', 1);
  const s9 = submit('9', 1);
  const s15 = submit('15', 1);
  const s10 = submit('10', 1);
  const s11 = [submit('11', 1), submit('11', 1), submit('11', 1)];
  const odd = [['12', submit('12', 0)], ['13', submit('13', 1.5)], ['14', submit('14', '1')]];
  const tasks = [
    { id: '1', history: [reviewed(s1, 'merged', 0)] },
    { id: '2', history: [reviewed(s2, 'merged', 0)] },
    { id: '3', history: [reviewed(s3, 'merged', 1)] },
    { id: '4', history: [reviewed(s4, 'merged', 2)] },
    { id: '5', history: [reviewed(s5[0], 'in-progress'), reviewed(s5[1], 'merged', 0)] },
    { id: '6', history: [reviewed(s6, 'blocked')] },
    { id: '7', history: [reviewed(s7, 'in-progress')] },
    { id: '8', history: [reviewed(s8, 'merged')] },
    { id: '9', history: [reviewed(s9, 'merged', null)] },
    { id: '15', history: [reviewed(s15, 'merged', -1)] },
    { id: '10', history: [] },
    // 差し戻しの前に 2 本 → 差し戻しは新しい方へ、merge は出し直しへ結ぶ。古い方はどちらにも結ばれない
    { id: '11', history: [reviewed(s11[1], 'in-progress'), reviewed(s11[2], 'merged', 0)] },
    ...odd.map(([id, run]) => ({ id, history: [reviewed(run, 'merged', 0)] })),
  ];
  return { runs: [...before, s1, s2, s3, s4, ...s5, s6, s7, s8, s9, s15, s10, ...s11, ...odd.map(([, run]) => run)], tasks };
}

test('summarizeHarness: 提出が 1 回で通ったかを版ごとに数え、分からない提出 (verify の回数・merge 時の指摘の件数なし・レビュー中) は分母から外す', () => {
  const { runs, tasks } = firstPassRuns();
  const bot = summarizeHarness(runs, { tasks, minRuns: 15 }).bots[0];
  assert.equal(bot.current.rev, 'bbbbbbbbbbbb');
  assert.equal(bot.current.submissions, 18);
  assert.deepEqual(bot.current.firstPass, { measured: 9, passed: 3, retried: 3, remarked: 2, sentBack: 3 });
  // 差し戻しの定義は版の sentBack と同じ (封鎖を含む)。verify の回数の無い #7 のぶんだけ少ない
  assert.equal(bot.current.sentBack, 4);
  assert.deepEqual(bot.previous.firstPass, { measured: 0, passed: 0, retried: 0, remarked: 0, sentBack: 0 }, '提出の無い版に数えている');

  // 差し戻しの前の古い提出は差し戻しにも merge にも結ばれず、レビュー中と同じに分母から外れる
  const only11 = summarizeHarness(runs.filter((run) => run.taskId === '11'), { tasks }).bots[0].current;
  assert.equal(only11.submissions, 3);
  assert.deepEqual(only11.firstPass, { measured: 2, passed: 1, retried: 0, remarked: 0, sentBack: 1 }, '古い提出を merge に結んでいる');
});

test('summarizeHarness: 1 回で通ったかは判定・門・判定の行に入れない — verify の回数と指摘の件数を消しても成績は同じ', () => {
  const { runs, tasks } = firstPassRuns();
  const bareRuns = runs.map((run) => ({ ...run, evidence: null }));
  const bareTasks = tasks.map((task) => ({ ...task, history: task.history.map(({ remarks, ...entry }) => entry) }));
  const full = summarizeHarness(runs, { tasks, minRuns: 15 });
  const bare = summarizeHarness(bareRuns, { tasks: bareTasks, minRuns: 15 });
  assert.notDeepEqual(full.bots[0].current.firstPass, bare.bots[0].current.firstPass, '1 回で通ったかが変わっていない (比べた意味がない)');
  assert.equal(bare.bots[0].current.firstPass.measured, 0);
  const pick = (s) => s.bots.map((b) => [b.verdict, b.z, verdictLine(b), b.current.problems, b.previous.problems, b.current.sentBack, b.unattributed]);
  assert.equal(typeof full.bots[0].z, 'number', '判定が付いていない (比べた意味がない)');
  assert.deepEqual(pick(full), pick(bare));
  assert.deepEqual(full.excerpts, bare.excerpts);
  const now = Date.parse(runs.at(-1).startedAt) + 60_000;
  assert.deepEqual(harnessGate(full, { now, minRuns: 15 }), harnessGate(bare, { now, minRuns: 15 }));
});

test('formatHarnessReport: 測れた提出のある版にだけ、版の行の問題率の後に「1 回で通った」と内訳を添える', () => {
  const { runs, tasks } = firstPassRuns();
  const text = formatHarnessReport(summarizeHarness(runs, { tasks, minRuns: 15 }), { minRuns: 15 });
  assert.match(text, /^1 回で通った = 提出のうち verify 1 回・.*判定には入れない/m);
  const lines = text.split('\n');
  assert.match(
    lines.find((line) => line.startsWith('- `bbbbbbbbbbbb`')),
    / \/ job 18 本・問題 4 \(22%\) \/ 1 回で通った 3\/9 \(33%、再試行 3・指摘 2・差し戻し 3\) \/ 差し戻し 4 \/ 提出 18$/,
  );
  assert.match(lines.find((line) => line.startsWith('- `aaaaaaaaaaaa`')), / \/ job 20 本・問題 1 \(5%\) \/ 差し戻し 0 \/ 提出 0$/, '測れた提出の無い版に添えている');
});
