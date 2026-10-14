// 1 つの job の中で、モデルが最終回答 (構造化出力) を何回出したかを数える (純粋関数)。
//
// claude CLI の `--json-schema` では、モデルは StructuredOutput というツールで最終回答を出す。
// 結果 JSON の `structured_output` に入るのは**最後の 1 回だけ**で、途中で出した回は
// Discord に届かずに消える (2026-10-03: 作者への質問と [[notify:owner]] が入った回が、
// 後の 2 回に上書きされて消えた)。消えたことに気づけるよう、回数を数えて本文に断りを添える。
//
// **読むのは Claude Code の内部ファイル** (`<設定フォルダ>/projects/<cwd を変換>/<sessionId>.jsonl`)。
// 形式は公開の約束ではないので、読めない・形が変わったときは「数えられない」(null) に倒し、
// job も配送も止めない。I/O は呼び出し側 (src/bridge/job.js) が持ち、ここは中身の解釈だけ。

import { join } from 'node:path';

export const FINAL_ANSWER_TOOL = 'StructuredOutput';

/**
 * セッション記録の置き場。Claude Code は作業ディレクトリの英数字以外を `-` に置き換えた
 * フォルダ名を使う (例: `C:/Users/me/projects/foo` → `C--Users-me-projects-foo`)。
 * @param {{configDir: string, cwd: string, sessionId: string}} p
 */
export function sessionLogPath({ configDir, cwd, sessionId }) {
  return join(configDir, 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * 記録の行から、`sinceMs` 以降にモデルが最終回答を出した回数を数える。
 * 壊れた行・形の違う行は飛ばす。1 行も読めなければ null (数えられない)。
 * @param {string[]} lines JSONL の各行
 * @param {number} sinceMs この job の開始時刻 (ms)。resume したセッションでは前の job の回を含めない
 * @returns {number|null}
 */
export function countFinalAnswers(lines, sinceMs) {
  let parsed = 0;
  let count = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    parsed += 1;
    if (entry?.type !== 'assistant') continue;
    const at = Date.parse(entry.timestamp ?? '');
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    count += content.filter((c) => c?.type === 'tool_use' && c.name === FINAL_ANSWER_TOOL).length;
  }
  return parsed === 0 ? null : count;
}

/**
 * 本文に添える断り。2 回以上のときだけ返す (1 回以下・数えられないときは null)。
 * @param {number|null} count
 */
export function finalAnswerWarning(count) {
  if (!Number.isInteger(count) || count < 2) return null;
  return (
    `⚠️ この job は最終回答を ${count} 回出しました。届いているのは最後の 1 回だけで、`
    + `前の ${count - 1} 回 (質問や呼び出しを含みうる) は届いていません — 内容はセッション記録に残っています`
  );
}
