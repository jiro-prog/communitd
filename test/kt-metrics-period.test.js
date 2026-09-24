import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatSummary,
  parseArgs,
  parseDateArg,
  readRecords,
  stateAt,
  summarizeBoard,
  summarizeRecovery,
  summarizeRuns,
} from '../scripts/kt-metrics.mjs';

// ---- 期間指定: 期間内のイベントと期間末の状態を分ける ----

const D = (day, hour = 0) => Date.parse(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+09:00`);
const iso = (ms) => new Date(ms).toISOString();
const BOTS = ['opus', 'opus2'];

const lifecycle = (id, { proposed, merged = null, dropped = null, sendBackAt = null } = {}) => {
  const history = [
    { at: iso(proposed), from: null, to: 'proposed', by: 'opus' },
    { at: iso(proposed + 60000), from: 'proposed', to: 'approved', by: 'opus2' },
    { at: iso(proposed + 120000), from: 'approved', to: 'in-progress', by: 'scheduler' },
  ];
  if (sendBackAt) {
    history.push({ at: iso(sendBackAt - 60000), from: 'in-progress', to: 'review', by: 'opus' });
    history.push({ at: iso(sendBackAt), from: 'review', to: 'in-progress', by: 'opus2', note: '直して' });
  }
  if (merged) {
    history.push({ at: iso(merged - 60000), from: 'in-progress', to: 'review', by: 'opus' });
    history.push({ at: iso(merged), from: 'review', to: 'merged', by: 'opus2' });
  }
  if (dropped) history.push({ at: iso(dropped), from: 'in-progress', to: 'dropped', by: 'U1' });
  const state = merged ? 'merged' : dropped ? 'dropped' : 'in-progress';
  return { id, channel: 'kt', state, createdAt: iso(proposed), updatedAt: iso(merged ?? dropped ?? proposed), history };
};

test('stateAt は履歴からその時刻の状態を復元する (まだ無ければ null・履歴が無ければ現在の状態)', () => {
  const t = lifecycle('1', { proposed: D(1, 10), merged: D(3, 10) });
  assert.equal(stateAt(t, D(1, 9)), null);
  assert.equal(stateAt(t, D(1, 10) + 1), 'proposed');
  assert.equal(stateAt(t, D(2)), 'in-progress');
  assert.equal(stateAt(t, D(3, 10)), 'review', '境目ちょうどは直前の状態');
  assert.equal(stateAt(t, D(4)), 'merged');
  assert.equal(stateAt({ state: 'blocked', history: [] }, D(4)), 'blocked');
});

test('summarizeBoard (期間): 起票した集団と期間内に merged した集団を混ぜず、状態は期間末で読む', () => {
  const tasks = [
    lifecycle('1', { proposed: D(1, 10), merged: D(2, 10) }),   // 期間前に起票・期間内に merged
    lifecycle('2', { proposed: D(2, 12), merged: D(2, 15) }),   // 期間内に起票・期間内に merged
    lifecycle('3', { proposed: D(2, 13) }),                     // 期間内に起票・期間末も in-progress
    lifecycle('4', { proposed: D(2, 14), merged: D(5, 10) }),   // 期間内に起票・期間後に merged
    lifecycle('5', { proposed: D(2, 16), dropped: D(2, 17) }),  // 期間内に起票・期間内に dropped
    lifecycle('6', { proposed: D(4, 10), merged: D(4, 12) }),   // 期間後
    lifecycle('7', { proposed: D(1, 8), sendBackAt: D(2, 11) }),// 期間前に起票・期間内に差し戻し
  ];
  const sum = summarizeBoard(tasks, { botKeys: BOTS, now: D(6), since: D(2), until: D(3) }).channels[0];
  assert.equal(sum.filed, 4, '期間内に起票 (#2 #3 #4 #5)');
  assert.equal(sum.filedMerged, 1, '起票した集団のうち期間末までに merged (#2 だけ。#4 は期間後)');
  assert.equal(sum.merged, 2, '期間内に merged (#1 #2 — 起票時期は問わない)');
  assert.equal(sum.dropped, 1);
  // 期間末 (9/3 0:00) の状態: #3 in-progress / #4 in-progress / #7 in-progress。#6 はまだ無い
  assert.equal(sum.open, 3);
  assert.deepEqual(sum.openByState, { 'in-progress': 3 });
  assert.equal(sum.sendBacks, 1);
  // 遷移主体は期間内の履歴だけ (#6 の遷移や #4 の merge は数えない)
  assert.equal(sum.by.owner, 1, '#5 の drop (U1)');
  assert.equal(sum.by.scheduler, 4, '#2 #3 #4 #5 の着手');
  assert.equal(sum.lead.count, 2, '期間内に merged した 2 件の所要');
  assert.deepEqual(summarizeBoard(tasks, { now: D(6), since: D(2), until: D(3) }).period, { since: D(2), until: D(3) });
  // 期間を切らなければ従来の意味 (全期間・現在の状態)
  const all = summarizeBoard(tasks, { botKeys: BOTS, now: D(6) }).channels[0];
  assert.equal(all.filed, 7);
  assert.equal(all.merged, 4);
  assert.equal(all.period, null);
  assert.equal(all.filedMerged, 4);
});

test('formatSummary (期間) は集団を別の行に出し、owner が介入の分ではないと注記する', () => {
  const tasks = [lifecycle('1', { proposed: D(1, 10), merged: D(2, 10) }), lifecycle('2', { proposed: D(2, 12) })];
  const text = formatSummary(summarizeBoard(tasks, { botKeys: BOTS, now: D(6), since: D(2), until: D(3) }));
  assert.match(text, /期間: 2026-09-01T15:00:00\.000Z 〜 2026-09-02T15:00:00\.000Z \(状態は期間末の時点\)/);
  assert.match(text, /期間内に起票 1 \(うち期間末までに merged 0\)/);
  assert.match(text, /期間内に merged 1 \/ dropped 0 \(起票時期は問わない\)/);
  assert.match(text, /期間末の open 1 \(proposed 0 \/ approved 0 \/ in-progress 1 \/ review 0 \/ blocked 0\) \/ blocked 0/);
  assert.match(text, /owner は板を動かした回数で、介入した分ではない/);
  // 期間なしの従来の行はそのまま
  assert.match(formatSummary(summarizeBoard(tasks, { botKeys: BOTS, now: D(6) })), /起票 2 \/ merged 1 \/ dropped 0 \/ blocked 0/);
});

// ---- 実行記録と再開の集計 ----

const run = (id, threadId, over = {}) => ({
  id, threadId, channelName: 'kt', botKey: 'opus', stage: 'ended', acceptedAt: iso(D(2, 10)), endedAt: iso(D(2, 11)),
  outcome: 'ok', next: 'human', stopKind: null, ...over,
});

test('summarizeRuns: 終わり方・止めた主体・復旧待ちに入った件数と復旧待ちの時間 (未解消は別)', () => {
  const runs = [
    run('a', 'T1'),
    run('b', 'T2', { outcome: 'failed', next: 'recovery', endedAt: iso(D(2, 12)) }),
    run('c', 'T2', { acceptedAt: iso(D(2, 12) + 30 * 60000), endedAt: iso(D(2, 13)), outcome: 'ok' }), // 30 分後に起こし直された
    run('d', 'T3', { outcome: 'verify-failed', next: 'recovery', endedAt: iso(D(2, 14)) }),           // 未解消
    run('e', 'T4', { outcome: 'aborted', stopKind: 'human', endedAt: iso(D(2, 15)) }),
    run('f', 'T5', { channelName: 'other' }),
    run('g', 'T6', { endedAt: iso(D(5, 10)) }),                                                        // 期間外
    { id: 'live', threadId: 'T7', channelName: 'kt', stage: 'model', acceptedAt: iso(D(2, 16)), endedAt: null, outcome: null },
    'broken',
  ];
  const sum = summarizeRuns(runs, { since: D(2), until: D(3), now: D(6), channel: 'kt' });
  assert.equal(sum.total, 6);
  assert.deepEqual(sum.byOutcome, { ok: 2, failed: 1, 'verify-failed': 1, aborted: 1, live: 1 });
  assert.deepEqual(sum.byStopKind, { human: 1 });
  assert.equal(sum.stalled, 2);
  assert.deepEqual(sum.recoveryWait, { count: 1, medianMin: 30, p90Min: 30, unresolved: 1 });
  const all = summarizeRuns(runs, { now: D(6) });
  assert.equal(all.total, 8, 'チャンネルを切らなければ全部');
});

test('summarizeRecovery: 手動 / 自動と結果を期間で数える', () => {
  const entries = [
    { taskId: '77', attempts: [
      { at: iso(D(2, 10)), kind: 'manual', result: 'accepted' },
      { at: iso(D(2, 11)), kind: 'auto', result: 'failed(契約が居る)' },
      { at: iso(D(2, 13)), kind: 'auto', result: 'sent' },
      { at: iso(D(2, 14)), kind: 'manual', result: 'send-unknown' },
      { at: iso(D(2, 15)), kind: 'manual', result: 'expired' },
      { at: iso(D(5, 10)), kind: 'auto', result: 'accepted' }, // 期間外
    ] },
    { taskId: '78', attempts: [{ at: iso(D(2, 12)), kind: 'auto', result: 'pending' }] },
    { taskId: '79', attempts: [] },
    null,
  ];
  assert.deepEqual(summarizeRecovery(entries, { since: D(2), until: D(3), now: D(6) }), {
    manual: 3, auto: 3, accepted: 1, sent: 1, unknown: 1, expired: 1, failed: 1, pending: 1, tasks: 2,
  });
  const text = formatSummary(
    summarizeBoard([], { now: D(6) }),
    { runs: summarizeRuns([], { now: D(6) }), recovery: summarizeRecovery(entries, { now: D(6) }) },
  );
  assert.match(text, /## 実行記録 \(job\)\njob 0 本\n止めた主体: \(なし\)\n復旧待ちに入った job 0 本 — 解消 0 本 \/ 未解消 0 本/);
  assert.match(text, /## 再開 \(recovery\)\n対象 task 2 件 \/ 手動 3 回 \/ 自動 4 回 \(受付済み 2 \/ 送信済み受付待ち 1 \/ 送達不明 1 \/ 期限切れ 1 \/ 起こせなかった 1 \/ 送信前 1\)/);
});

// ---- 引数とファイル ----

test('parseDateArg: 日付だけは JST の暦日 (until はその日を含む)、ISO はそのまま、読めなければ落ちる', () => {
  assert.equal(parseDateArg('2026-09-02'), D(2));
  assert.equal(parseDateArg('2026-09-02', { end: true }), D(3));
  assert.equal(parseDateArg('2026-09-02T03:00:00Z'), Date.parse('2026-09-02T03:00:00Z'));
  assert.throws(() => parseDateArg('いつか'), /読めません/);
  assert.throws(() => parseDateArg('2026-13-40'), /読めません/);
});

test('parseArgs: --since / --until / --runs / --recovery を受け、順序の逆転と知らないものは断る', () => {
  const out = parseArgs(['--since', '2026-09-01', '--until', '2026-09-07', '--runs', 'r.json', '--recovery', 'c.json', '--channel', 'kt']);
  assert.equal(out.since, D(1));
  assert.equal(out.until, D(8));
  assert.equal(out.runs, 'r.json');
  assert.equal(out.recovery, 'c.json');
  assert.equal(out.channel, 'kt');
  assert.equal(parseArgs([]).since, null);
  assert.throws(() => parseArgs(['--since', '2026-09-07', '--until', '2026-09-01']), /前に/);
  assert.throws(() => parseArgs(['--bogus']), /知らないオプション/);
  assert.throws(() => parseArgs(['--since']), /値が渡されていません/);
});

test('readRecords: 無い・壊れた・形の違うファイルは 0 件にせず落ちる (何も書かない)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-metrics-'));
  assert.throws(() => readRecords(join(dir, 'nope.json'), '実行記録'), /読めません/);
  writeFileSync(join(dir, 'broken.json'), '{ nope', 'utf8');
  assert.throws(() => readRecords(join(dir, 'broken.json'), '実行記録'), /JSON として/);
  writeFileSync(join(dir, 'array.json'), '[]', 'utf8');
  assert.throws(() => readRecords(join(dir, 'array.json'), '実行記録'), /object ではありません/);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ a: { id: 'a' }, b: 'x', c: null }), 'utf8');
  assert.deepEqual(readRecords(join(dir, 'ok.json'), '実行記録'), [{ id: 'a' }]);
});
