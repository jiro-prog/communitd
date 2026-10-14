import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { FINAL_ANSWER_TOOL, countFinalAnswers, finalAnswerWarning, sessionLogPath } from '../src/final-answers.js';

const START = Date.parse('2026-10-03T01:07:33.000Z');

function assistant(at, ...tools) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { content: tools.map((name) => ({ type: 'tool_use', name, input: {} })) },
  });
}

test('セッション記録の置き場: 作業ディレクトリの英数字以外を - に置き換える', () => {
  assert.equal(
    sessionLogPath({ configDir: 'C:/home/.claude', cwd: 'C:/Users/me/projects/foo', sessionId: 'abc' }),
    join('C:/home/.claude', 'projects', 'C--Users-me-projects-foo', 'abc.jsonl'),
  );
  // 作業ツリー (.worktrees) も同じ規則 (実在するフォルダ名の形: C--Users-<名前>-projects-<repo>--worktrees-task-87)
  assert.match(
    sessionLogPath({ configDir: 'X', cwd: 'C:/p/kumamikan/.worktrees/task-87', sessionId: 's' }),
    /C--p-kumamikan--worktrees-task-87[\\/]s\.jsonl$/,
  );
});

test('この job の中で最終回答を出した回数を数える (前の job の回は数えない)', () => {
  const lines = [
    assistant('2026-10-03T00:50:00.000Z', FINAL_ANSWER_TOOL), // 前の job
    JSON.stringify({ type: 'user', timestamp: '2026-10-03T01:07:34.000Z', message: { content: [] } }),
    assistant('2026-10-03T01:11:06.000Z', 'Read', FINAL_ANSWER_TOOL),
    assistant('2026-10-03T01:13:11.000Z', FINAL_ANSWER_TOOL),
    '{壊れた行',
    '',
    assistant('2026-10-03T01:19:56.000Z', FINAL_ANSWER_TOOL),
  ];
  assert.equal(countFinalAnswers(lines, START), 3);
});

test('最終回答が無い・1 行も読めないときの区別 (0 と null)', () => {
  assert.equal(countFinalAnswers([assistant('2026-10-03T01:10:00.000Z', 'Read')], START), 0);
  assert.equal(countFinalAnswers(['', '{x', 'not json'], START), null);
  assert.equal(countFinalAnswers([], START), null);
});

test('形の違う行は飛ばす (タイムスタンプ無し・content が配列でない)', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: FINAL_ANSWER_TOOL }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T01:10:00.000Z', message: { content: 'text' } }),
    assistant('2026-10-03T01:10:00.000Z', FINAL_ANSWER_TOOL),
  ];
  assert.equal(countFinalAnswers(lines, START), 1);
});

test('断り書きは 2 回以上のときだけ出す', () => {
  assert.equal(finalAnswerWarning(null), null);
  assert.equal(finalAnswerWarning(0), null);
  assert.equal(finalAnswerWarning(1), null);
  const w = finalAnswerWarning(3);
  assert.match(w, /最終回答を 3 回/);
  assert.match(w, /前の 2 回/);
});
