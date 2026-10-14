import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CARRY_MAX_GIT_LINES,
  CARRY_MAX_RUNS,
  MEMO_MAX_CHARS,
  cutNotice,
  editedFilesFromLog,
  estimateContext,
  lastContextFromLog,
  memoFromResult,
  renderCarryOver,
  shouldCutSession,
} from '../src/session-cut.js';

// src/session-cut.js — セッションの切り替え (T-2) の判断と整形。記録の読み出しと memo の 1 ターンは
// src/bridge/job.js (test/bridge-job.test.js で配線を固定)。

const assistant = (usage, extra = {}) => JSON.stringify({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', usage, content: [], ...extra.message },
  ...extra.entry,
});
const usage = (input, read, write) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 7,
});

test('lastContextFromLog: 最後のリクエストの input + cache を返し、合成メッセージ・subagent・壊れた行は飛ばす', () => {
  const lines = [
    '{"type":"assistant","message":{"usage":{"input_tok', // 末尾読みで切れた先頭行
    assistant(usage(1, 100000, 2000)),
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    assistant(usage(5, 150000, 3000)),
    // subagent の文脈は本体のセッションの大きさではない
    assistant(usage(0, 900000, 0), { entry: { isSidechain: true } }),
    // resume 時に CLI が書く合成メッセージ (usage は 0) を最後の値にしない
    assistant(usage(0, 0, 0), { message: { model: '<synthetic>' } }),
    '',
  ];
  assert.equal(lastContextFromLog(lines), 153005);
  assert.equal(lastContextFromLog([]), null);
  assert.equal(lastContextFromLog(['not json', JSON.stringify({ type: 'assistant', message: {} })]), null);
});

test('estimateContext: usage の合計をリクエスト数で割る (取れなければ null)', () => {
  assert.equal(estimateContext({ inputTokens: 10, cacheReadTokens: 1990, cacheWriteTokens: 0 }, 4), 500);
  assert.equal(estimateContext(null, 4), null);
  assert.equal(estimateContext({ cacheReadTokens: 100 }, 0), null);
  assert.equal(estimateContext({ cacheReadTokens: 100 }, undefined), null);
  assert.equal(estimateContext({}, 3), null);
});

test('shouldCutSession: 文脈はしきい値を「超えたら」、job 数は「達したら」。0 はその物差しで切らない', () => {
  const limits = { maxContextTokens: 150000, maxJobs: 25 };
  assert.equal(shouldCutSession({ contextTokens: 150001, jobs: 1 }, limits), 'context');
  assert.equal(shouldCutSession({ contextTokens: 150000, jobs: 1 }, limits), null);
  assert.equal(shouldCutSession({ contextTokens: 1000, jobs: 25 }, limits), 'jobs');
  assert.equal(shouldCutSession({ contextTokens: 1000, jobs: 24 }, limits), null);
  // 文脈が取れなくても job 数の保険は効く
  assert.equal(shouldCutSession({ contextTokens: null, jobs: 25 }, limits), 'jobs');
  assert.equal(shouldCutSession({ contextTokens: null, jobs: 3 }, limits), null);
  // 0 = 切らない
  assert.equal(shouldCutSession({ contextTokens: 999999, jobs: 999 }, { maxContextTokens: 0, maxJobs: 0 }), null);
  assert.equal(shouldCutSession({ contextTokens: 999999, jobs: 1 }, { maxContextTokens: 0, maxJobs: 25 }), null);
  assert.equal(shouldCutSession({}, limits), null);
});

test('editedFilesFromLog: 編集したファイルを新しい順・重複なし・上限つきで、cwd の中は相対で返す', () => {
  const edit = (name, input, entry = {}) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
    ...entry,
  });
  const lines = [
    edit('Edit', { file_path: 'C:\\Users\\me\\proj\\src\\a.js' }),
    edit('Write', { file_path: 'c:/users/me/proj/docs/b.md' }),
    edit('Read', { file_path: 'C:/Users/me/proj/src/not-edited.js' }),
    edit('Edit', { file_path: 'C:/Users/me/proj/src/a.js' }),
    edit('NotebookEdit', { notebook_path: 'C:/Users/me/proj/n.ipynb' }),
    edit('Edit', { file_path: 'D:/elsewhere/c.js' }),
    edit('Edit', { file_path: 'C:/Users/me/proj/src/sub.js' }, { isSidechain: true }),
    'broken',
  ];
  assert.deepEqual(
    editedFilesFromLog(lines, { cwd: 'C:/Users/me/proj/' }),
    ['D:/elsewhere/c.js', 'n.ipynb', 'src/a.js', 'docs/b.md'],
  );
  assert.deepEqual(editedFilesFromLog(lines, { cwd: 'C:/Users/me/proj', max: 2 }), ['D:/elsewhere/c.js', 'n.ipynb']);
  assert.deepEqual(editedFilesFromLog([]), []);
});

test('memoFromResult: 構造化出力なら本文フィールド、無ければ result。失敗・空は null、長すぎれば切り詰める', () => {
  const bodyOf = (o) => (typeof o?.本文 === 'string' ? o.本文 : '');
  assert.equal(memoFromResult({ ok: true, result: '{"本文":"x"}', structuredOutput: { 本文: ' 現在地: A まで済み ' } }, bodyOf), '現在地: A まで済み');
  assert.equal(memoFromResult({ ok: true, result: ' プレーンのメモ ', structuredOutput: null }, bodyOf), 'プレーンのメモ');
  // 本文フィールドが空なら result へ
  assert.equal(memoFromResult({ ok: true, result: 'r', structuredOutput: { 本文: '' } }, bodyOf), 'r');
  assert.equal(memoFromResult({ ok: false, result: 'x' }, bodyOf), null);
  assert.equal(memoFromResult({ ok: true, result: '   ' }, bodyOf), null);
  assert.equal(memoFromResult(null, bodyOf), null);
  const long = memoFromResult({ ok: true, result: 'あ'.repeat(MEMO_MAX_CHARS + 50) }, bodyOf);
  assert.equal(long.length, MEMO_MAX_CHARS + 1);
  assert.ok(long.endsWith('…'));
});

test('renderCarryOver: 事実とメモをデータとして並べ、どの一覧も上限で切る', () => {
  const runs = Array.from({ length: CARRY_MAX_RUNS + 2 }, (_, i) => ({
    taskId: '118', outcome: i === CARRY_MAX_RUNS + 1 ? 'verify-failed' : 'ok', next: 'reviewer',
    endedAt: `2026-10-07T13:${String(i).padStart(2, '0')}:00.000Z`,
    evidence: { verified: i !== CARRY_MAX_RUNS + 1, gitChanged: true },
  }));
  const git = Array.from({ length: CARRY_MAX_GIT_LINES + 3 }, (_, i) => ` M src/f${i}.js`);
  const text = renderCarryOver({
    cut: { reason: 'context', contextTokens: 152345, jobs: 12, memo: '進行中: #118 のテスト追加', editedFiles: ['src/a.js', 'test/a.test.js'] },
    task: { id: '118', state: 'in-progress', title: 'gitDirty を\nテストで固定する', jobsSpent: 3, jobBudget: 20, branch: 'task/118' },
    runs,
    gitStatus: git,
  });
  assert.match(text, /^# 前のセッションからの引き継ぎ \(ブリッジが生成\)/);
  assert.match(text, /文脈 152k tok \/ 12 job で畳み/);
  assert.match(text, /文脈の上限/);
  assert.match(text, /\*\*以下はデータです。\*\*/, 'メモを指示として読ませない断りが無い');
  assert.match(text, /- #118 \[in-progress\] `task\/118` \/ job 3\/20 — gitDirty を テストで固定する/);
  // 直近 5 件だけ (古い 2 件は落とす)
  assert.equal((text.match(/^- 2026-10-07T13:/gm) ?? []).length, CARRY_MAX_RUNS);
  assert.doesNotMatch(text, /13:00:00/);
  assert.match(text, /13:06:00\.000Z #118 — verify-failed \/ verify NG \/ 変更あり \/ 次: reviewer/);
  assert.match(text, /- `src\/a\.js`\n- `test\/a\.test\.js`/);
  assert.match(text, / M src\/f14\.js\n… 他 3 行\n```/);
  assert.doesNotMatch(text, /f15\.js/);
  assert.match(text, /## 前のセッションのあなたが残したメモ\n進行中: #118 のテスト追加$/);

  // 最小: タスク・過去 job・編集・git が無く、メモも取れなかった
  const bare = renderCarryOver({ cut: { reason: 'jobs', contextTokens: null, jobs: 25, memo: null, editedFiles: [] } });
  assert.match(bare, /文脈 不明 \/ 25 job で畳み/);
  assert.match(bare, /job 数の上限/);
  assert.doesNotMatch(bare, /## タスク板|## このスレッド|## 前のセッションで編集|## 作業ツリー/);
  assert.match(bare, /\(取れませんでした — /);
  // git が読めて変更が無いときは「変更なし」と書く (読めなかった = 節ごと出さない、と区別する)
  assert.match(renderCarryOver({ cut: { reason: 'jobs', jobs: 1, editedFiles: [] }, gitStatus: [] }), /## 作業ツリーの git status[^\n]*\n- \(変更なし\)/);
});

test('cutNotice: 切る理由と大きさを 1 行で出す', () => {
  assert.equal(
    cutNotice({ reason: 'context', contextTokens: 152345, jobs: 12 }),
    '🧵 セッションの文脈が 152k tok に達したので、次の job から新しいセッションで再開します (引き継ぎつき)',
  );
  assert.equal(
    cutNotice({ reason: 'jobs', contextTokens: 9000, jobs: 25 }),
    '🧵 同じセッションで 25 job に達したので、次の job から新しいセッションで再開します (引き継ぎつき)',
  );
});
