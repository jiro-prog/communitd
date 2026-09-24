// リポジトリ内の文書への参照が、実在するファイルを指しているかを見る (CI の lint job で回す)。
//
//   node scripts/check-doc-refs.mjs      # npm run check:docs
//
// 見るのは 2 種類:
// - **Markdown の相対リンク** (`*.md` の `[..](path)`)。http(s) / mailto / `#` だけのものは見ない
// - **`src/` と `scripts/` に書いた `docs/*.md`** (コメントも文字列も)。コメントの出典も、
//   エラーメッセージに出す案内も、指した先が無ければ読む人にとっては行き止まりになる
//
// `test/` は見ない — テストは架空の `docs/` 配下のパスを提案の対象として使う。
// 追跡しているファイル (`git ls-files`) だけを「在る」とみなす。手元にだけある文書を指していても、
// clone した人の手元には無いので。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * このリポジトリではなく、**ブリッジが作業するプロジェクト側**に置かれるファイル。
 * コードがそのパスを読みに行くだけで、ここに在るべきものではない。
 */
export const PROJECT_SIDE_PATHS = Object.freeze([
  'docs/direction.md', // 自律運転の方向性ドキュメントの既定値 (src/config-autonomy.js DEFAULT_DIRECTION_FILE)
  'docs/HANDOFF.md', // 引継ぎ文書 (src/bridge/job.js HANDOFF_FILE)
]);

const MD_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_DOC_PATH = /docs\/[\w./-]+\.md/g;

/**
 * 切れた参照を集める。**純関数** — ファイルの一覧と中身を受け取るだけ。
 *
 * @param {{path: string, text: string}[]} files リポジトリ相対 (`/` 区切り) のパスと中身
 * @param {Iterable<string>} tracked 在るとみなすファイル (リポジトリ相対)
 * @returns {{path: string, line: number, target: string}[]} 見つからなかった参照
 */
export function findBrokenDocRefs(files, tracked) {
  const fileSet = new Set(tracked);
  const dirSet = new Set();
  for (const f of fileSet) {
    for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirSet.add(d);
  }
  const exists = (p) => fileSet.has(p) || dirSet.has(p) || p === '';

  const broken = [];
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/);
    if (path.endsWith('.md')) {
      lines.forEach((line, i) => {
        for (const m of line.matchAll(MD_LINK)) {
          const raw = m[1];
          if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
          const target = decodeURI(raw.split('#')[0]).replace(/\/$/, '');
          const resolved = posix.normalize(posix.join(posix.dirname(path), target));
          if (resolved.startsWith('..') || !exists(resolved === '.' ? '' : resolved)) {
            broken.push({ path, line: i + 1, target: raw });
          }
        }
      });
    } else if (/^(src|scripts)\//.test(path) && /\.m?js$/.test(path)) {
      lines.forEach((line, i) => {
        for (const m of line.matchAll(CODE_DOC_PATH)) {
          if (PROJECT_SIDE_PATHS.includes(m[0])) continue;
          if (!exists(m[0])) broken.push({ path, line: i + 1, target: m[0] });
        }
      });
    }
  }
  return broken;
}

function main() {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`git ls-files が失敗しました: ${res.stderr || res.error?.message}`);
    process.exit(1);
  }
  const tracked = res.stdout.split('\0').filter(Boolean);
  const files = tracked
    .filter((p) => p.endsWith('.md') || (/^(src|scripts)\//.test(p) && /\.m?js$/.test(p)))
    .map((p) => ({ path: p, text: readFileSync(resolve(ROOT, p), 'utf8') }));
  const broken = findBrokenDocRefs(files, tracked);
  for (const b of broken) console.error(`${b.path}:${b.line}: ${b.target} が見つかりません`);
  if (broken.length > 0) {
    console.error(`切れた参照が ${broken.length} 件あります`);
    process.exit(1);
  }
  console.log(`文書への参照: ${files.length} ファイルを見て、切れた参照なし`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
