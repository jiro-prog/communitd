// @ts-check
// `npm test` の入口。
//
// **シェルにも Node の版にも依存させない。** `node --test test/*.test.js` は
// 「展開してくれる誰か」が要る書き方で、その誰かがシェルなのか node なのかは環境で変わる
// (bash は展開する。cmd.exe は展開しないが、手元の Node 22.17 は node 自身が展開した —
// `--test` の glob 対応は途中の版で入ったものなので、CI の matrix に並べる古い Node でも
// 同じとは限らない)。**まずいのは、展開できなかったときの挙動が「0 件のまま exit 0」**
// だという点で (実測)、走っていないのに緑になる。
// ここでファイルを自分で並べて渡し、1 件も無ければ落とす。
//
// 追加の node オプションはそのまま前に置いて渡せる:
//   npm test -- --experimental-test-isolation=none
//   npm test -- --test-name-pattern=マーカー

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

let files;
try {
  files = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.js')).sort();
} catch (err) {
  console.error(`${TEST_DIR} を読めません: ${err?.message ?? err}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`${TEST_DIR} に *.test.js がありません — 0 件を成功にしないためここで落とします`);
  process.exit(1);
}

const args = [...process.argv.slice(2), '--test', ...files.map((n) => join(TEST_DIR, n))];
const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
if (res.error) {
  console.error(`node を起動できません: ${res.error.message}`);
  process.exit(1);
}
// signal で落ちたとき status は null。0 を返さない (緑と読ませない)
process.exit(res.status ?? 1);
