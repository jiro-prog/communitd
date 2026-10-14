import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAUDE_EFFORTS } from '../src/claude.js';
import { CODEX_EFFORTS } from '../src/codex.js';
import { PI_EFFORTS } from '../src/pi.js';
import { BOT_RUNTIMES as CONFIG_BOT_RUNTIMES, CODEX_OPTIONAL_BOT_KEYS } from '../src/config.js';
import {
  BOT_RUNTIMES, DEFAULT_RUNTIME, RUNTIMES, canRuntime, capabilitiesOf, runtimeOf,
} from '../src/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 表そのものを固定する。**能力を 1 つ増やすときにここが落ちる**のが狙いで、
// 「claude だけに足して codex を書き忘れる」を通さない (書き忘れた列は undefined = falsy
// になるので、実行時には「できない」側へ黙って倒れる)
test('能力表は claude / codex / pi の 3 エントリで、値は表のとおり', () => {
  assert.deepEqual(Object.keys(RUNTIMES), ['claude', 'codex', 'pi']);
  assert.deepEqual(RUNTIMES.claude, {
    name: 'claude',
    resume: true,
    schema: true,
    pathScopedPermissions: true,
    hooks: true,
    subagent: true,
    efforts: CLAUDE_EFFORTS,
    optionalBotKeys: [],
    instructionsFile: false,
    intake: true,
  });
  assert.deepEqual(RUNTIMES.codex, {
    name: 'codex',
    resume: false,
    // P-3 (2026-09-18): `--output-schema` を配線したので true へ反転 (src/strict-schema.js)
    schema: true,
    pathScopedPermissions: false,
    hooks: false,
    subagent: false,
    efforts: CODEX_EFFORTS,
    optionalBotKeys: ['model'],
    instructionsFile: true,
    // 受付は runClaude を直接呼ぶ (src/bridge/intake.js)。codex の配線は無い
    intake: false,
  });
  assert.deepEqual(RUNTIMES.pi, {
    name: 'pi',
    // この版はセッションを残さない (docs/reference/pi-runtime.md)
    resume: false,
    // 道具 submit_report の引数のスキーマとして渡す (src/pi-extension.js)
    schema: true,
    // 拡張が道具の呼び出しごとに allowedTools / permissionMode / 契約の絞り込みを照合する
    pathScopedPermissions: true,
    // verify の差し戻しは拡張の agent_before_settle (承認カードは無い)
    hooks: true,
    subagent: false,
    efforts: PI_EFFORTS,
    // pi は --model を必ず渡す (既定モデルに頼らない)
    optionalBotKeys: [],
    instructionsFile: false,
    intake: false,
  });
  // 能力の顔ぶれは全部で同じ (片方にだけ生えた列は、もう片方で undefined になる)
  assert.deepEqual(Object.keys(RUNTIMES.claude).sort(), Object.keys(RUNTIMES.codex).sort());
  assert.deepEqual(Object.keys(RUNTIMES.claude).sort(), Object.keys(RUNTIMES.pi).sort());
  assert.equal(DEFAULT_RUNTIME, 'claude');
});

// **effort の値域の正本は claude.js / codex.js の 1 箇所ずつ。** 表が値をコピーして持つと、
// CLI 側の値域が変わったときに直す先が 2 つになり、片方だけ古いまま無症状で残る
test('efforts は claude.js / codex.js / pi.js の配列そのもの', () => {
  assert.equal(RUNTIMES.claude.efforts, CLAUDE_EFFORTS);
  assert.equal(RUNTIMES.codex.efforts, CODEX_EFFORTS);
  assert.equal(RUNTIMES.pi.efforts, PI_EFFORTS);
  assert.equal(Object.isFrozen(PI_EFFORTS), true);
});

// 実行中に書き換わると、同じ job の中で「できる / できない」が入れ替わり、
// 実行文脈に書いた権限の案内と実際の権限がずれる
test('表と各エントリは凍結されている', () => {
  assert.equal(Object.isFrozen(RUNTIMES), true);
  for (const [name, caps] of Object.entries(RUNTIMES)) {
    assert.equal(Object.isFrozen(caps), true, `${name} が凍結されていない`);
    assert.equal(Object.isFrozen(caps.optionalBotKeys), true, `${name}.optionalBotKeys が凍結されていない`);
    // `Object.freeze` は 1 段だけ。中身の配列が素のままだと `efforts.push('ultra')` が
    // 通り、**実行中に effort の値域が広がる** (Opus2 指摘 2026-09-18)。
    // 凍らせるのは正本の側 (src/claude.js / src/codex.js) で、ここは同一参照を見ている
    assert.equal(Object.isFrozen(caps.efforts), true, `${name}.efforts が凍結されていない`);
  }
  assert.equal(Object.isFrozen(BOT_RUNTIMES), true);
});

// 知らない綴りは既定 (claude) へ倒す — 従来の `runtime === 'codex' ? 'codex' : 'claude'` と
// 同じ結果。**綴り違いそのものは起動時の検証 (config.js の BOT_RUNTIMES) が落とす**ので、
// ここまで届く不明値で例外を投げるより、既定で走らせるほうが安全側になる
test('runtimeOf は bot も runtime 名も受け、知らない値は claude へ倒す', () => {
  assert.equal(runtimeOf({ runtime: 'codex' }), 'codex');
  assert.equal(runtimeOf('codex'), 'codex');
  assert.equal(runtimeOf({ runtime: 'claude' }), 'claude');
  assert.equal(runtimeOf('claude'), 'claude');
  for (const value of [
    undefined, null, {}, { runtime: undefined }, { runtime: 'Codex' }, { runtime: 'CLAUDE' },
    { runtime: ' codex ' }, { runtime: '' }, { runtime: 42 }, { runtime: null },
    'Codex', 'gemini', '', 42, [], true,
  ]) {
    assert.equal(runtimeOf(value), 'claude', `runtimeOf(${JSON.stringify(value)}) が claude でない`);
  }
  // 表のキーだけを見る (Object の継承プロパティを掴まない)
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(runtimeOf(name), 'claude', `${name} が runtime として通ってしまう`);
  }
});

test('capabilitiesOf は bot オブジェクトと文字列の両方を受ける', () => {
  assert.equal(capabilitiesOf({ runtime: 'codex' }), RUNTIMES.codex);
  assert.equal(capabilitiesOf('codex'), RUNTIMES.codex);
  assert.equal(capabilitiesOf({ runtime: 'claude' }), RUNTIMES.claude);
  assert.equal(capabilitiesOf('claude'), RUNTIMES.claude);
  // 設定に無い bot (`bots[key]` が undefined) もそのまま渡ってくる — 既定の能力で答える
  assert.equal(capabilitiesOf(undefined), RUNTIMES.claude);
  assert.equal(capabilitiesOf(null), RUNTIMES.claude);
  assert.equal(capabilitiesOf({ runtime: 'gemini' }), RUNTIMES.claude);
});

// **権限の判定は fail-closed。** runtimeOf / capabilitiesOf は不明値を既定 (claude) へ
// 倒すので、そのまま権限に使うと「知らない runtime = 能力を持っている」になる。
// canRuntime は表に true と書いてあるときだけ true を返す (src/contract.js の canDelegateTo)
test('canRuntime は表に true と書いてあるときだけ true (知らない綴りは false)', () => {
  assert.equal(canRuntime('claude', 'pathScopedPermissions'), true);
  assert.equal(canRuntime(undefined, 'pathScopedPermissions'), true, '未指定は既定のランタイム');
  assert.equal(canRuntime(null, 'pathScopedPermissions'), true);
  assert.equal(canRuntime('codex', 'pathScopedPermissions'), false);
  assert.equal(canRuntime('codex', 'resume'), false);
  // schema は P-3 で codex も true (能力ごとに列が独立していることの確認)
  assert.equal(canRuntime('codex', 'schema'), true);
  assert.equal(canRuntime('claude', 'schema'), true);
  // 知らない綴りは拒否側 (runtimeOf と規則が違う — ここを揃えると許可側へ倒れる)
  for (const name of ['gemini', 'Codex', '', ' codex ', 'constructor', '__proto__', 'toString']) {
    assert.equal(canRuntime(name, 'pathScopedPermissions'), false,
      `${JSON.stringify(name)} が許可側へ倒れている`);
    assert.equal(runtimeOf(name), 'claude', 'runtimeOf の既定は変わっていないこと');
  }
  // 知らない能力名も false (`undefined === true` にならないことの確認)
  for (const cap of ['nope', 'constructor', '__proto__', 'efforts', 'name']) {
    assert.equal(canRuntime('claude', cap), false, `能力 ${cap} が true になっている`);
  }
});

// 設定側 (config.js) の入口は表から導く。値を二重に書くと
// 「表には載っているのに設定には書けない」ランタイムが生まれる
test('config.js の BOT_RUNTIMES / CODEX_OPTIONAL_BOT_KEYS は表から導かれている', () => {
  assert.deepEqual(BOT_RUNTIMES, ['claude', 'codex', 'pi']);
  assert.equal(CONFIG_BOT_RUNTIMES, BOT_RUNTIMES);
  assert.equal(CODEX_OPTIONAL_BOT_KEYS, RUNTIMES.codex.optionalBotKeys);
});

/**
 * ランタイム名の厳密一致が src へ戻ってこないように固定する。
 *
 * P-1 の主眼は「能力を名前で聞かない」こと。名前で聞くと、能力が 1 つ変わっただけで
 * (codex が `--output-schema` を持つ / verify がブリッジ側の段へ移る) 全箇所を読んで
 * 判別し直すことになる。**許可するのは「どの CLI を起動するか」の dispatch だけ。**
 *
 * 数え方: コード行だけ (行頭が `//` `*` `/*` の行と、行末の `//` 以降は数えない)。
 * 表の JSDoc は従来の書き方を引用しているので、prose まで数えるとコメントを直すたびに
 * このテストが落ちる。
 *
 * 網は**厳密一致の綴り違いまで拾う** (Opus2 指摘 2026-09-18) — `==` / 二重引用 /
 * バッククォート / `case 'codex':` / 左右逆の `'codex' === x` はどれも同じ間違いで、
 * eslint は `eqeqeq` も `quotes` も入れていない (eslint.config.js は recommended だけ) ので
 * lint でも止まらない。誤爆しても**落ちる**方向なので、広い側へ倒す。
 * 行またぎ (`runtime ===` で改行して次行が `'codex'`) は対象外。
 */
const NAME_COMPARISON =
  /(?:[=!]==?\s*|case\s+)['"`](?:codex|claude|pi)['"`]|['"`](?:codex|claude|pi)['"`]\s*[=!]==?/;

// ファイル → 許可する件数。**完全一致で照合する** (増えても減っても落ちる)
const ALLOWED_NAME_COMPARISONS = Object.freeze({
  // 起動する CLI そのものを選ぶ分岐 (codex / pi の 2 つ) と、pi だけが最終報告を道具で
  // 受け取ることを実行文脈へ書く 1 つ。どれも能力ではなく起動の仕方なので表には載らない
  'src/bridge/job.js': 3,
});

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 照合するコード部分。ブロックコメントの行 (`*` `/*` で始まる) は丸ごと落とし、
 * 行末コメント (`//` 以降) も落とす — `foo(); // 旧: runtime === 'codex'` のような
 * 説明で落ちないように (Opus2 指摘 2026-09-18)。
 */
function codePart(line) {
  const t = line.trim();
  if (t.startsWith('*') || t.startsWith('/*')) return '';
  return t.split('//')[0];
}

test('ランタイム名の厳密一致は dispatch 1 箇所だけ (能力は表から引く)', () => {
  const files = jsFilesUnder(join(ROOT, 'src'));
  // 0 件を緑にしない (走査そのものが壊れていたら落とす)
  assert.ok(files.length > 20, `src/ の .js が ${files.length} 件しか見つからない`);

  const found = {};
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const hits = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => NAME_COMPARISON.test(codePart(line)));
    if (hits.length > 0) found[rel] = hits.length;
  }
  assert.deepEqual(found, { ...ALLOWED_NAME_COMPARISONS },
    '能力はランタイム名ではなく src/runtime.js の表から引く (許可は起動 CLI の dispatch だけ)');

  // 残した 1 箇所が「能力の分岐が紛れ込んだもの」でないことも見る — 解決は表を通す
  const job = readFileSync(join(ROOT, 'src/bridge/job.js'), 'utf8');
  assert.match(job, /runtimeOf\(bot\.cfg\) === 'codex'/);
});

// doctor は「codex CLI を見に行くか」を runtime 名で決める (能力ではなく CLI の有無)。
// 上の走査は `=== 'codex'` の形だけを見るので、こちらは形が違って網に掛からない —
// **名前で分けている 2 箇所目**として明示的に固定しておく
test('doctor の CLI 確認は runtime 名で引き分ける', () => {
  const doctor = readFileSync(join(ROOT, 'src/doctor.js'), 'utf8');
  assert.match(doctor, /runtimes\.has\('codex'\)/);
  assert.match(doctor, /runtimes\.add\(runtimeOf\(bot\)\)/);
});
