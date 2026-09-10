import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JobRunStore,
  LIVE_STAGES,
  RUN_OUTCOMES,
  RUN_RETENTION_MS,
  RUN_STAGES,
  classifyReason,
  isLive,
  nextActorFor,
} from '../src/jobruns.js';

const T0 = Date.parse('2026-09-05T00:00:00.000Z');
const minutes = (n) => n * 60000;
const days = (n) => n * 24 * 60 * minutes(1);

const storePath = () => join(mkdtempSync(join(tmpdir(), 'communitd-jobruns-')), 'job-runs.json');
const store = () => new JobRunStore(storePath());

const accepted = (s, over = {}, now = T0) => s.open({
  id: 'j1',
  taskId: '77',
  threadId: 'T77',
  botKey: 'opus',
  channelName: 'kumamikan-tools',
  cwd: 'C:/w/task-77',
  trigger: { messageId: 'M1', byBotKey: 'opus2' },
  intent: { contractExpected: false, nonce: null },
  placeholderId: 'P1',
  ...over,
}, { now });

// ---- 分類 (runJob の全終了経路がここへ写る) ----

test('classifyReason は runJob の全 return を outcome へ写す', () => {
  assert.deepEqual(classifyReason('ok'), { outcome: 'ok', detail: '', stopKind: null });
  assert.deepEqual(classifyReason('verify-failed'), { outcome: 'verify-failed', detail: '', stopKind: null });
  assert.deepEqual(classifyReason('aborted'), { outcome: 'aborted', detail: '', stopKind: null });
  assert.deepEqual(classifyReason('deliver-failed'), { outcome: 'deliver-failed', detail: '', stopKind: null });
  assert.deepEqual(classifyReason('stopped-before-start'), { outcome: 'stopped', detail: '', stopKind: 'human' });
  assert.deepEqual(classifyReason('internal-error'), { outcome: 'internal-error', detail: '', stopKind: null });
  for (const reason of ['protocol-mismatch', 'role-unreadable', 'contract-unenforceable']) {
    assert.deepEqual(classifyReason(reason), { outcome: 'not-started', detail: reason, stopKind: null });
  }
  // 失敗の中身は detail に残す (ログの識別子と同じ文字列)
  assert.deepEqual(
    classifyReason('failed(API Error: 529 Overloaded)'),
    { outcome: 'failed', detail: 'API Error: 529 Overloaded', stopKind: null },
  );
  // タイムアウトはブリッジが子を殺した停止として区別する
  assert.deepEqual(
    classifyReason('failed(timeout after 60 min)'),
    { outcome: 'failed', detail: 'timeout after 60 min', stopKind: 'timeout' },
  );
  // 知らない理由・空は unknown (成功にも失敗にも寄せない)
  assert.equal(classifyReason('something-new').outcome, 'unknown');
  assert.equal(classifyReason('').outcome, 'unknown');
  assert.equal(classifyReason(null).outcome, 'unknown');
  assert.equal(classifyReason(undefined).outcome, 'unknown');
  for (const c of [classifyReason('ok'), classifyReason('failed(x)'), classifyReason('zzz')]) {
    assert.ok(RUN_OUTCOMES.includes(c.outcome));
  }
});

test('nextActorFor: 成功なら次の担当、止まったなら復旧、中断なら人間', () => {
  assert.equal(nextActorFor({ outcome: 'ok', handoff: { toBotKey: 'opus', kind: 'handoff' } }), 'bot');
  assert.equal(nextActorFor({ outcome: 'ok', handoff: { kind: 'notify' } }), 'human');
  assert.equal(nextActorFor({ outcome: 'ok', taskSubmitted: true }), 'reviewer');
  assert.equal(nextActorFor({ outcome: 'ok', taskState: 'review' }), 'reviewer');
  assert.equal(nextActorFor({ outcome: 'ok' }), 'human');
  for (const outcome of ['verify-failed', 'failed', 'deliver-failed', 'internal-error', 'not-started']) {
    assert.equal(nextActorFor({ outcome }), 'recovery', outcome);
  }
  for (const outcome of ['aborted', 'stopped', 'cancelled']) {
    assert.equal(nextActorFor({ outcome }), 'human', outcome);
  }
  assert.equal(nextActorFor({ outcome: 'unknown' }), 'unknown');
  assert.equal(nextActorFor({}), 'unknown');
});

// ---- 受付 → 束縛 → 段階 → 終端 ----

test('open は受付の記録を queued で作り、契約の意図を残す', () => {
  const s = store();
  const r = accepted(s);
  assert.equal(r.id, 'j1');
  assert.equal(r.taskId, '77');
  assert.equal(r.stage, 'queued');
  assert.equal(r.attempt, 1);
  assert.equal(r.acceptedAt, new Date(T0).toISOString());
  assert.equal(r.startedAt, null);
  assert.equal(r.outcome, null);
  assert.deepEqual(r.trigger, { messageId: 'M1', byBotKey: 'opus2', kind: 'bot' });
  assert.equal(r.contractState, 'none');
  assert.ok(isLive(r));
  assert.ok(RUN_STAGES.includes(r.stage) && LIVE_STAGES.includes(r.stage));
  // 人間起点は kind human
  const h = s.open({ id: 'j2', threadId: 'T1', botKey: 'fable', trigger: { messageId: 'M2' } }, { now: T0 });
  assert.equal(h.trigger.kind, 'human');
  assert.equal(h.taskId, null);
});

test('open は id / threadId / botKey が無いと断り、同じ id を二度作らない', () => {
  const s = store();
  assert.throws(() => s.open({ id: '', threadId: 'T', botKey: 'b' }), /id/);
  assert.throws(() => s.open({ id: 'x', threadId: '', botKey: 'b' }), /threadId/);
  assert.throws(() => s.open({ id: 'x', threadId: 'T', botKey: '' }), /botKey/);
  accepted(s);
  assert.throws(() => accepted(s), /既にあります/);
});

test('試行番号は同じスレッド・同じ担当の記録数 + 1 (レビュー担当の job は数えない)', () => {
  const s = store();
  accepted(s, { id: 'j1' });
  accepted(s, { id: 'j2', botKey: 'opus2' }, T0 + minutes(1)); // reviewer
  const third = accepted(s, { id: 'j3' }, T0 + minutes(2));
  assert.equal(third.attempt, 2);
  assert.equal(s.get('j2').attempt, 1);
});

test('契約つきの受付は pending で始まり、claim の結果で bound / missing / error へ確定する', () => {
  const s = store();
  const tagged = accepted(s, { intent: { contractExpected: true, nonce: 'abc' } });
  assert.equal(tagged.contractState, 'pending');

  const bound = s.bindContract('j1', {
    entry: { id: 'c1', kind: 'delegation', nonce: 'abc', fromBotKey: 'fable', contract: { touch: ['x'] } },
  }, { now: T0 + 1 });
  assert.equal(bound.contractState, 'bound');
  // 本文は保存しない (参照だけ)
  assert.deepEqual(bound.contract, { id: 'c1', kind: 'delegation', nonce: 'abc', fromBotKey: 'fable' });

  accepted(s, { id: 'j2', intent: { contractExpected: true, nonce: 'def' } });
  assert.equal(s.bindContract('j2', { entry: null, expected: true }).contractState, 'missing');
  accepted(s, { id: 'j3', intent: { contractExpected: true, nonce: 'ghi' } });
  assert.equal(s.bindContract('j3', { entry: null, error: 'EACCES' }).contractState, 'error');
  accepted(s, { id: 'j4' });
  assert.equal(s.bindContract('j4', { entry: null }).contractState, 'none');
});

test('start → setStage → noteSpawn → noteModelResult → finish の順で段階が進む', () => {
  const s = store();
  accepted(s);
  const started = s.start('j1', { now: T0 + minutes(1) });
  assert.equal(started.stage, 'starting');
  assert.equal(started.startedAt, new Date(T0 + minutes(1)).toISOString());

  const spawned = s.noteSpawn('j1', { pid: 4242, at: T0 + minutes(2), runtime: 'claude' });
  assert.equal(spawned.stage, 'model');
  assert.deepEqual(spawned.spawn, { pid: 4242, at: new Date(T0 + minutes(2)).toISOString(), runtime: 'claude' });

  const waiting = s.setStage('j1', 'approval', { now: T0 + minutes(3), detail: 'Bash(rm)' });
  assert.equal(waiting.stage, 'approval');
  assert.equal(waiting.stageDetail, 'Bash(rm)');
  assert.deepEqual(waiting.lastActivity, { at: new Date(T0 + minutes(3)).toISOString(), kind: 'stage', detail: 'approval' });

  s.setStage('j1', 'model', { now: T0 + minutes(4) });
  const modeled = s.noteModelResult('j1', { ok: true }, { now: T0 + minutes(10) });
  assert.equal(modeled.modelResult, 'ok');
  s.setStage('j1', 'verify', { now: T0 + minutes(11) });
  s.noteDelivery('j1', '本文', 'sent', { now: T0 + minutes(12) });
  assert.equal(s.get('j1').stage, 'deliver');

  const done = s.finish('j1', {
    reason: 'ok', handoff: { toBotKey: 'opus2', kind: 'handoff' }, now: T0 + minutes(13),
    evidence: { toolCalls: 5, gitChanged: true },
  });
  assert.equal(done.stage, 'ended');
  assert.equal(done.outcome, 'ok');
  assert.equal(done.next, 'bot');
  assert.equal(done.endedAt, new Date(T0 + minutes(13)).toISOString());
  assert.deepEqual(done.handoff, { toBotKey: 'opus2', kind: 'handoff' });
  assert.deepEqual(done.evidence, { toolCalls: 5, gitChanged: true });
  assert.deepEqual(done.delivery, { '本文': 'sent' });
  assert.equal(isLive(done), false);
  assert.equal(s.liveList().length, 0);
});

test('setStage は終端・要照合を受け付けない / noteDelivery は知らない状態を断る', () => {
  const s = store();
  accepted(s);
  assert.throws(() => s.setStage('j1', 'ended'), /setStage/);
  assert.throws(() => s.setStage('j1', 'reconcile'), /setStage/);
  assert.throws(() => s.noteDelivery('j1', '本文', 'done'), /知りません/);
  assert.throws(() => s.noteDelivery('j1', '', 'sent'), /step/);
  assert.throws(() => s.markStopRequested('j1', 'ghost'), /知りません/);
});

// ---- P0 の 4 ケース: 実行失敗 / 配送失敗 / 再起動 / 意図的停止 ----

test('実行失敗: モデルが失敗を返した job は failed・復旧待ちになり、副作用の有無は spawn で読める', () => {
  const s = store();
  accepted(s);
  s.start('j1', { now: T0 + 1 });
  s.noteSpawn('j1', { pid: 100, at: T0 + 2, runtime: 'claude' });
  s.noteModelResult('j1', { ok: false, error: 'API Error: 529 Overloaded' }, { now: T0 + minutes(5) });
  const done = s.finish('j1', { reason: 'failed(API Error: 529 Overloaded)', now: T0 + minutes(5) });
  assert.equal(done.outcome, 'failed');
  assert.equal(done.stageDetail, 'API Error: 529 Overloaded');
  assert.equal(done.next, 'recovery');
  assert.equal(done.modelResult, 'failed');
  assert.ok(done.spawn, 'モデルが起動した事実 (副作用がありうる) が残っていない');
  assert.equal(done.stopKind, null);
});

test('起動前の失敗 (role を読めない等) は not-started で、spawn は無い', () => {
  const s = store();
  accepted(s);
  s.start('j1', { now: T0 + 1 });
  const done = s.finish('j1', { reason: 'role-unreadable', now: T0 + 2 });
  assert.equal(done.outcome, 'not-started');
  assert.equal(done.spawn, null);
  assert.equal(done.modelResult, null);
  assert.equal(done.next, 'recovery');
});

test('配送失敗: モデルは成功したのに配送で落ちた job は deliver-failed で、どの step が落ちたか残る', () => {
  const s = store();
  accepted(s);
  s.start('j1', { now: T0 + 1 });
  s.noteSpawn('j1', { pid: 100, at: T0 + 2, runtime: 'claude' });
  s.noteModelResult('j1', { ok: true }, { now: T0 + minutes(5) });
  s.noteDelivery('j1', '本文', 'sent');
  s.noteDelivery('j1', '添付', 'failed');
  s.noteDelivery('j1', '制御メンション', 'pending');
  const done = s.finish('j1', { reason: 'deliver-failed', now: T0 + minutes(6) });
  assert.equal(done.outcome, 'deliver-failed');
  assert.equal(done.modelResult, 'ok', '成功したモデル実行を繰り返さないための根拠が消えている');
  assert.deepEqual(done.delivery, { '本文': 'sent', '添付': 'failed', '制御メンション': 'pending' });
  assert.equal(done.next, 'recovery');
});

test('再起動: 終端まで記録できなかった job は要照合になり、失敗にも成功にも倒れない', () => {
  const path = storePath();
  const before = new JobRunStore(path);
  accepted(before, { id: 'running' });
  before.start('running', { now: T0 + 1 });
  before.noteSpawn('running', { pid: 4242, at: T0 + 2, runtime: 'claude' });
  accepted(before, { id: 'waiting', threadId: 'T78' });
  accepted(before, { id: 'done', threadId: 'T79' });
  before.start('done', { now: T0 + 3 });
  before.finish('done', { reason: 'ok', now: T0 + 4 });

  // 別プロセスが同じファイルを読み直した
  const after = new JobRunStore(path);
  const reconciled = after.reconcileOnStartup({ now: T0 + minutes(10) });
  assert.deepEqual(reconciled.map((r) => r.id).sort(), ['running', 'waiting']);
  const running = after.get('running');
  assert.equal(running.stage, 'reconcile');
  assert.deepEqual(running.reconcile, {
    at: new Date(T0 + minutes(10)).toISOString(), fromStage: 'model', resolvedAt: null, resolvedBy: null, how: null,
  });
  assert.equal(running.outcome, null, '結果が分からないものを失敗にしている');
  assert.deepEqual(running.spawn, { pid: 4242, at: new Date(T0 + 2).toISOString(), runtime: 'claude' });
  assert.equal(after.get('waiting').reconcile.fromStage, 'queued');
  assert.equal(after.get('done').stage, 'ended', '終わっている記録に触っている');
  assert.ok(isLive(running), '要照合は未終端として数える');
  assert.equal(after.liveList().length, 2);

  // もう一度起動しても二重に印を付けない
  const again = new JobRunStore(path).reconcileOnStartup({ now: T0 + minutes(20) });
  assert.equal(again.length, 2);
  assert.equal(new JobRunStore(path).get('running').reconcile.at, new Date(T0 + minutes(10)).toISOString());

  // 閉じるときは outcome を unknown にする (分からなかった、と残す)
  const resolved = after.resolveReconcile('running', { how: 'process-gone', by: 'U1', now: T0 + minutes(30) });
  assert.equal(resolved.stage, 'ended');
  assert.equal(resolved.outcome, 'unknown');
  assert.equal(resolved.next, 'unknown');
  assert.equal(resolved.reconcile.how, 'process-gone');
  assert.equal(resolved.reconcile.resolvedBy, 'U1');
  assert.throws(() => after.resolveReconcile('done'), /要照合ではありません/);
});

test('意図的停止: /stop の中断は human、再起動の中断は shutdown として残り、待機の取り消しは cancelled', () => {
  const s = store();
  accepted(s, { id: 'a' });
  s.start('a', { now: T0 + 1 });
  s.noteSpawn('a', { pid: 1, at: T0 + 2, runtime: 'claude' });
  s.markStopRequested('a', 'human', { now: T0 + 3 });
  const aborted = s.finish('a', { reason: 'aborted', now: T0 + 4 });
  assert.equal(aborted.outcome, 'aborted');
  assert.equal(aborted.stopKind, 'human');
  assert.equal(aborted.stopRequestedAt, new Date(T0 + 3).toISOString());
  assert.equal(aborted.next, 'human');

  accepted(s, { id: 'b', threadId: 'T2' });
  s.start('b', { now: T0 + 1 });
  accepted(s, { id: 'c', threadId: 'T3' });
  const marked = s.markShutdown({ now: T0 + 5 });
  assert.deepEqual(marked.map((r) => r.id).sort(), ['b', 'c']);
  assert.equal(s.get('b').stopKind, 'shutdown');
  // 先に人間が止めていた記録は上書きしない
  s.finish('b', { reason: 'aborted', now: T0 + 6 });
  assert.equal(s.get('b').stopKind, 'shutdown');
  const cancelled = s.cancel('c', { stopKind: 'shutdown', now: T0 + 6, reason: '再起動' });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.stopKind, 'shutdown');
  assert.equal(cancelled.next, 'human');
  // 終わったものは cancel しても動かない
  assert.equal(s.cancel('a').outcome, 'aborted');
  // 終わっているものに stop を記録しても変わらない
  assert.equal(s.markStopRequested('a', 'shutdown').stopKind, 'human');
});

test('タイムアウトで殺した job は failed だが stopKind timeout が付く (人間の停止と混ぜない)', () => {
  const s = store();
  accepted(s);
  s.start('j1');
  s.noteSpawn('j1', { pid: 9, at: T0 });
  const done = s.finish('j1', { reason: 'failed(timeout after 60 min)' });
  assert.equal(done.outcome, 'failed');
  assert.equal(done.stopKind, 'timeout');
});

// ---- 台帳の信用 ----

test('壊れたファイルは broken に理由が残り、「記録が無い」と同じにならない', () => {
  const path = storePath();
  writeFileSync(path, '{ broken json', 'utf8');
  const s = new JobRunStore(path);
  assert.match(s.broken, /JSON として読めません/);
  assert.equal(s.healthy, false);
  assert.equal(s.list().length, 0);
  // **退避しない** (§12.3 (1))。書き込みも断るので、証拠が上書きされない
  assert.equal(readFileSync(path, 'utf8'), '{ broken json');
  assert.throws(() => accepted(s), /台帳を直すか手で退避してから/);
  assert.equal(readFileSync(path, 'utf8'), '{ broken json');
  // 形が違う (配列) も壊れている扱い
  const path2 = storePath();
  writeFileSync(path2, '[]', 'utf8');
  assert.match(new JobRunStore(path2).broken, /object ではありません/);
  // 正常なら null
  const ok = store();
  assert.equal(ok.broken, null);
  assert.equal(ok.healthy, true);
  // 手で壊された値は無いものとして扱う (数えない)
  const path3 = storePath();
  writeFileSync(path3, JSON.stringify({ x: 'not a record', y: 3 }), 'utf8');
  const s3 = new JobRunStore(path3);
  assert.equal(s3.broken, null);
  assert.equal(s3.get('x'), null);
  assert.equal(s3.list().length, 0);
  assert.equal(s3.get('__proto__'), null);
});

test('保存に失敗したら writeFailures に残り healthy が落ちる (結果不明として扱う根拠)', () => {
  const blocker = storePath();
  writeFileSync(blocker, 'x', 'utf8');
  const s = new JobRunStore(join(blocker, 'job-runs.json'));
  assert.throws(() => accepted(s));
  assert.equal(s.writeFailures.length, 1);
  assert.equal(s.healthy, false);
  assert.equal(s.list().length, 0, '書けていないのにメモリに残っている');
});

test('保持期間を過ぎた終端記録だけ消え、未終端と要照合は残る', () => {
  const s = store();
  accepted(s, { id: 'old' });
  s.start('old', { now: T0 });
  s.finish('old', { reason: 'ok', now: T0 });
  accepted(s, { id: 'recent', threadId: 'T2' }, T0 + days(20));
  s.start('recent', { now: T0 + days(20) });
  s.finish('recent', { reason: 'ok', now: T0 + days(20) });
  accepted(s, { id: 'live', threadId: 'T3' });
  accepted(s, { id: 'stale-live', threadId: 'T4' });
  s.reconcileOnStartup({ now: T0 + 1 });

  const now = T0 + RUN_RETENTION_MS + days(1);
  assert.equal(s.pruneEnded({ now }), 1);
  assert.deepEqual(s.list().map((r) => r.id).sort(), ['live', 'recent', 'stale-live']);
  // 消すものが無ければ書かない
  assert.equal(s.pruneEnded({ now }), 0);
});

test('list は受付順で、thread / task / channel / live で絞れる', () => {
  const s = store();
  accepted(s, { id: 'b' }, T0 + minutes(2));
  accepted(s, { id: 'a' }, T0 + minutes(1));
  accepted(s, { id: 'c', threadId: 'T2', taskId: null, channelName: 'sandbox' }, T0 + minutes(3));
  s.start('a', { now: T0 + minutes(4) });
  s.finish('a', { reason: 'ok', now: T0 + minutes(5) });
  assert.deepEqual(s.list().map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(s.forTask('77').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(s.forThread('T2').map((r) => r.id), ['c']);
  assert.deepEqual(s.list({ channel: 'sandbox' }).map((r) => r.id), ['c']);
  assert.deepEqual(s.liveList().map((r) => r.id), ['b', 'c']);
  assert.deepEqual(s.list({ live: false }).map((r) => r.id), ['a']);
  assert.equal(s.latestForTask('77').id, 'b');
  assert.equal(s.latestForTask('999'), null);
  assert.deepEqual(s.forTask(null), []);
});

test('ディスクにも同じ形で落ち、読み直せる', () => {
  const path = storePath();
  const s = new JobRunStore(path);
  accepted(s);
  s.start('j1', { now: T0 + 1 });
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.j1.stage, 'starting');
  assert.equal(new JobRunStore(path).get('j1').stage, 'starting');
});

// ---- 社会台帳への参照 (docs/society-ledger.md §5・S2-2) ----

test('open: 案件の参照を保存し、操作 ID で引ける', () => {
  const runs = store();
  runs.open({
    id: 'j1', threadId: 'T1', botKey: 'opus', channelName: 'kt',
    society: { caseId: 'C-1', actionId: 'A-7', claimGeneration: 2 },
  });
  runs.open({ id: 'j2', threadId: 'T1', botKey: 'fable', channelName: 'kt' });
  runs.open({
    id: 'j3', threadId: 'T2', botKey: 'opus', channelName: 'kt',
    society: { caseId: 'C-1', actionId: 'A-8', claimGeneration: 2 },
  });

  assert.deepEqual(runs.get('j1').society, { caseId: 'C-1', actionId: 'A-7', claimGeneration: 2 });
  assert.equal(runs.get('j2').society, null, '印の無い受付は null (0 件と混ぜない)');
  assert.deepEqual(runs.forAction('A-7').map((r) => r.id), ['j1']);
  assert.deepEqual(runs.forAction('A-8').map((r) => r.id), ['j3']);
  assert.deepEqual(runs.forAction('A-9'), []);
  assert.deepEqual(runs.forAction(null), []);
  assert.deepEqual(runs.forAction(''), []);

  // 保存し直しても残る (再起動を跨いで照合できる)
  const reopened = new JobRunStore(runs.filePath);
  assert.deepEqual(reopened.forAction('A-7').map((r) => r.id), ['j1']);
});

test('open: Action ID の無い参照は持たない (照合の鍵にならない)', () => {
  const runs = store();
  runs.open({ id: 'j1', threadId: 'T1', botKey: 'opus', society: { caseId: 'C-1' } });
  runs.open({ id: 'j2', threadId: 'T1', botKey: 'opus', society: 'A-1' });
  runs.open({ id: 'j3', threadId: 'T1', botKey: 'opus', society: { actionId: 'A-3' } });
  assert.equal(runs.get('j1').society, null);
  assert.equal(runs.get('j2').society, null);
  // caseId と世代が欠けていても、操作 ID があれば引ける形で持つ
  assert.deepEqual(runs.get('j3').society, { caseId: null, actionId: 'A-3', claimGeneration: null });
  assert.deepEqual(runs.forAction('A-3').map((r) => r.id), ['j3']);
});
