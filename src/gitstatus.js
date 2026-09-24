// @ts-check
// cwd の git status を実行前後で比べる。「副作用があったか」の最小の証拠
// (検収用 — ワーカーの自己申告に依存しない)。git repo でなければ null を返し、
// 呼び出し側は「差分なし」と「読めなかった」を混ぜない (自動復旧の門がこれを見る)。
import { execFileSync } from 'node:child_process';

/** cwd の git status --porcelain を行配列で返す。git repo でなければ null */
export function gitStatusSnapshot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/** 実行前後の porcelain 差分 (+ 増えた行 / - 消えた行) */
export function diffSnapshots(before, after) {
  if (!before || !after) return [];
  const b = new Set(before);
  const a = new Set(after);
  const delta = [];
  for (const line of after) if (!b.has(line)) delta.push(`+ ${line}`);
  for (const line of before) if (!a.has(line)) delta.push(`- ${line}`);
  return delta;
}
