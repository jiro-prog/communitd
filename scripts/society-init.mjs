// @ts-check
// 社会台帳 `data/society.json` の明示初期化。
//
//   node scripts/society-init.mjs [--file <path>]
//
// **既にファイルがあれば上書きせず exit 1** — 通常起動が「不在 = 初回」と推測しない代わりに、
// 作るのはこの操作だけにしてある。壊れた台帳の上から空を書くと、人が直すための中身が消える。
// 終了コード: 作れたら 0 / 既にある・書けないなら 1。

import { resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initSocietyLedger } from '../src/society-store.js';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..')).replaceAll('\\', '/');
const DEFAULT_FILE = 'data/society.json';

/** @returns {{file?: string, help?: boolean, error?: string}} */
function parseArgs(argv) {
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('-')) {
        return { error: '--file にはパスを渡してください' };
      }
      file = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
      if (file === '') return { error: '--file にはパスを渡してください' };
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    return { error: `知らない引数: ${arg} (使えるのは --file <path>)` };
  }
  return { file };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`使い方: node scripts/society-init.mjs [--file <path>]  (既定 ${DEFAULT_FILE})`);
    return 0;
  }
  if (args.error) {
    console.error(`❌ ${args.error}`);
    return 1;
  }
  const target = resolve(ROOT, args.file ?? DEFAULT_FILE);
  let result;
  try {
    result = initSocietyLedger(target);
  } catch (err) {
    console.error(`❌ 社会台帳を書けませんでした: ${err?.message ?? err}`);
    return 1;
  }
  if (!result.ok) {
    console.error(`❌ ${result.reason}`);
    return 1;
  }
  console.log(`✅ 社会台帳を作りました: ${target} (schema ${result.snapshot.schema} / revision ${result.snapshot.revision})`);
  console.log('   society.mode を observe / active にするのは設定 (config.policy.json の society) 側です。');
  return 0;
}

process.exitCode = main();
