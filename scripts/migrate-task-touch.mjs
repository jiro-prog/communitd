// touch を持たない既存タスクへ宣言を後付けする移行 CLI (docs/social-engineering.md §3.9)。
//
//   node scripts/migrate-task-touch.mjs                        # 現状を出すだけ (何も書かない)
//   node scripts/migrate-task-touch.mjs --apply 9=src/a.ts,src/b.ts 31=src/c.ts
//
// `propose` が touch を必須にしたのは M2 の導入順 (1) 以降で、それ以前に起票された
// タスクは touch を持たない。発議の競合判定 (`taskConflicts` — src/proposals.js) は
// touch 不明のタスクを**何とでも競合する**と見なすので (fail-closed)、1 件でも残って
// いるとそのボードでは組織提案が全件拒否される。移行はそれを解くための一度きりの操作。
//
// **触るのは終端でないタスクだけ**で、既に touch を持つタスクは断る (src/board.js の
// `setTouch`)。走っている最中に範囲を広げる口にしないため、上書きはここからはできない。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskBoardStore, planTouchMigration, tasksMissingTouch } from '../src/board.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = resolve(ROOT, 'data', 'tasks.json');

/**
 * 引数を読む。`--file <path>` / `--apply` / `<id>=<p1>,<p2>` の 3 つだけ。
 * @returns {{file: string, apply: boolean, sets: Map<string, string[]>}}
 */
function parseArgs(argv) {
  const sets = new Map();
  let file = DEFAULT_FILE;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--file') {
      file = argv[i + 1];
      if (!file) throw new Error('--file にパスが渡されていません');
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`知らないオプション: ${arg}`);
    } else {
      const at = arg.indexOf('=');
      if (at <= 0) throw new Error(`<id>=<パス,パス> の形で書いてください: ${arg}`);
      const id = arg.slice(0, at).trim();
      // 正規形の検査 (相対パス・重複) はボード側 (normalizeTouch) に任せる —
      // ここで二重に持つと、片方だけ緩めたときに宣言の無いタスクが載る
      const paths = arg.slice(at + 1).split(',').map((p) => p.trim()).filter((p) => p !== '');
      if (sets.has(id)) throw new Error(`タスク ${id} が二度指定されています`);
      sets.set(id, paths);
    }
  }
  return { file, apply, sets };
}

function main(argv) {
  const { file, apply, sets } = parseArgs(argv);
  const board = new TaskBoardStore(file);
  const pending = tasksMissingTouch(board.list());

  console.log(`ボード: ${file}`);
  if (pending.length === 0) {
    console.log('touch を持たない終端でないタスクはありません (移行は不要)');
  } else {
    console.log(`touch を持たない終端でないタスク: ${pending.length} 件`);
    for (const task of pending) {
      console.log(`  #${task.id} [${task.state}] ${task.title}`);
    }
  }
  if (sets.size === 0) {
    console.log('');
    console.log('宣言を入れるには `<id>=<パス,パス>` を渡してください (書き込むには --apply も)');
    return 0;
  }

  // **1 件でも通らなければ何も書かない。** 途中まで移行された状態を作ると、
  // 「まだ拒否されるのに移行済みに見える」ボードが残る。**パスの正規形まで
  // ここで全件見る** — 書きながら検証すると 2 件目で落ちたときに 1 件目が残る
  const planned = planTouchMigration(board.list(), sets);
  if (!planned.ok) throw new Error(planned.reason);

  console.log('');
  for (const { id, title, touch } of planned.plan) {
    console.log(`#${id} ${title}`);
    console.log(`  touch: ${touch.join(' / ')}`);
  }
  if (!apply) {
    console.log('');
    console.log('(--apply が無いので書いていません)');
    return 0;
  }
  for (const { id, touch } of planned.plan) board.setTouch(id, touch);
  console.log('');
  console.log(`${planned.plan.length} 件へ touch を入れました`);
  const rest = tasksMissingTouch(board.list());
  console.log(
    rest.length === 0
      ? 'touch を持たない終端でないタスクは無くなりました (発議を止めるものはありません)'
      : `⚠️ まだ ${rest.length} 件残っています: ${rest.map((t) => `#${t.id}`).join(' / ')}`,
  );
  return 0;
}

// import しても走らせない (parseArgs / pendingTasks をテストから直接叩けるように)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`移行できません: ${err.message}`);
    process.exitCode = 1;
  }
}
