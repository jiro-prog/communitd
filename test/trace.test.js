import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendTraceEntry,
  digestTrace,
  formatTraceLine,
  formatTraceSteps,
  postTraceQuietly,
  readTraceEntries,
  summarizeToolInput,
  summarizeTrace,
  traceEntryFrom,
} from '../src/trace.js';

const entries = (...pairs) => pairs.map(([tool, arg = null]) => ({ tool, arg }));
const done = (tool, input) => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input });
const failed = (tool, input) => ({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input: input });

test('ツールを呼んでいない job では行を作らない', () => {
  assert.equal(formatTraceLine(summarizeTrace([])), null);
  assert.equal(formatTraceLine(null), null);
  assert.equal(summarizeTrace([]).total, 0);
});

test('1 種類だけの job も件数と引数が出る', () => {
  const line = formatTraceLine(summarizeTrace(entries(['Read', 'index.js'], ['Read', 'queue.js'])));
  assert.equal(line, '🔧 ツール 2 件: Read×2 (index.js, queue.js)');
});

test('多い順に並べ、同数はツール名で安定させる', () => {
  const summary = summarizeTrace(
    entries(['Grep'], ['Read', 'a.js'], ['Read', 'b.js'], ['Read', 'a.js'], ['Bash', 'npm']),
  );
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.kinds.map((k) => k.tool), ['Read', 'Bash', 'Grep']);
  // 同じ引数は 1 度だけ載せる (11 回読んだファイルが 11 個並ばない)
  assert.deepEqual(summary.kinds[0].args, ['a.js', 'b.js']);
});

test('最初の編集までの Read 数を数える (編集が無ければ null)', () => {
  const edited = summarizeTrace(entries(['Read'], ['Grep'], ['Read'], ['Edit', 'x.js'], ['Read']));
  assert.equal(edited.readsBeforeFirstEdit, 2);
  const readonly = summarizeTrace(entries(['Read'], ['Read']));
  assert.equal(readonly.readsBeforeFirstEdit, null);
});

test('引数は短く畳む — Bash は先頭語と続く語・ファイルは basename・WebFetch はドメイン', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test -- --watch' }), 'npm test');
  // Windows の job は Bash ではなく PowerShell ツールを使う (実測)
  assert.equal(summarizeToolInput('PowerShell', { command: 'Get-ChildItem -Recurse' }), 'Get-ChildItem -Recurse');
  assert.equal(summarizeToolInput('Read', { file_path: 'C:/proj/src/index.js' }), 'index.js');
  assert.equal(summarizeToolInput('Edit', { file_path: '/home/x/src/a.js' }), 'a.js');
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://example.com/a/b?q=1' }), 'example.com');
  // 検索語そのものが機微になりうるものは種類と回数だけ残す
  assert.equal(summarizeToolInput('Grep', { pattern: 'internal-code-name' }), null);
  assert.equal(summarizeToolInput('WebFetch', { url: 'not a url' }), null);
  assert.equal(summarizeToolInput('Bash', {}), null);
});

test('秘密らしい引数は要約ごと落とす (件数だけ残る)', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'cat .env' }), null);
  assert.equal(summarizeToolInput('Bash', { command: 'export API_KEY=x' }), null);
  assert.equal(summarizeToolInput('Read', { file_path: '/home/x/.ssh/id_rsa' }), null);
  assert.equal(summarizeToolInput('Read', { file_path: '/x/credentials.json' }), null);
  assert.equal(
    summarizeToolInput('Bash', { command: 'curl h/0123456789abcdef0123456789abcdef' }),
    null,
  );
  // 落ちるのは引数だけで、呼び出しの事実は残る
  const entry = traceEntryFrom({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' },
  });
  assert.equal(formatTraceLine(summarizeTrace([entry])), '🔧 ツール 1 件: Bash×1');
});

test('シェルの先頭語がフルパスでも、ホストのディレクトリ構造を出さない', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'C:\\Users\\me\\bin\\build.exe --release' }), 'build.exe --release');
  assert.equal(summarizeToolInput('Bash', { command: '/home/me/tools/run.sh -v' }), 'run.sh -v');
  assert.equal(summarizeToolInput('Bash', { command: './scripts/deploy.sh' }), 'deploy.sh');
  // 引用符・変数展開が混じった語は、名前だけ切り出しても実体を表さないので落とす
  assert.equal(summarizeToolInput('Bash', { command: '"C:\\Program Files\\x\\a.exe" -q' }), null);
  assert.equal(summarizeToolInput('PowerShell', { command: '$env:FOO=1; Get-Item x' }), null);
  assert.equal(summarizeToolInput('Bash', { command: 'cd /home/me/private && ls' }), 'cd');
});

test('シェルの先頭語に続く語は、何を走らせたかが分かるものを 3 語まで — 拡張子の無いパス・引用符・演算子で止める', () => {
  // どのテストを走らせたかを手順の要約で読めるように (帰属の材料)
  assert.equal(summarizeToolInput('PowerShell', { command: 'node --test test/harness.test.js' }), 'node --test harness.test.js');
  assert.equal(
    summarizeToolInput('Bash', { command: 'node --test --experimental-test-isolation=none test/*.test.js' }),
    'node --test --experimental-test-isolation=none *.test.js',
  );
  assert.equal(summarizeToolInput('Bash', { command: 'node scripts/harness-report.mjs --bot opus' }), 'node harness-report.mjs --bot opus');
  assert.equal(summarizeToolInput('Bash', { command: 'npx eslint .' }), 'npx eslint');
  assert.equal(summarizeToolInput('Bash', { command: 'git commit -m "feat: x"' }), 'git commit -m');
  assert.equal(summarizeToolInput('Bash', { command: 'git -C C:/Users/me/repo status' }), 'git -C');
  assert.equal(summarizeToolInput('Bash', { command: 'npm test | tail -5' }), 'npm test');
  assert.equal(summarizeToolInput('Bash', { command: 'ls $HOME' }), 'ls');
  assert.equal(summarizeToolInput('Bash', { command: 'a b c d e' }), 'a b c d');
});

test('引数が多いツールは打ち切りを … で示す', () => {
  const many = entries(...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ['Read', `${n}.js`]));
  const line = formatTraceLine(summarizeTrace(many), { maxArgs: 3 });
  assert.equal(line, '🔧 ツール 6 件: Read×6 (a.js, b.js, c.js…)');
});

test('種類が多い job は黙って切らず、落とした種類数を明示する', () => {
  const many = summarizeTrace(entries(...Array.from({ length: 20 }, (_, i) => [`Tool${i}`])));
  const byKinds = formatTraceLine(many, { maxKinds: 5 });
  assert.match(byKinds, /他 15 種省略$/);
  assert.equal(byKinds.split(' / ').length, 6);

  const byChars = formatTraceLine(many, { maxChars: 60 });
  assert.ok(byChars.length <= 60, byChars);
  assert.match(byChars, /他 \d+ 種省略$/);
});

test('表示は 1900 字を超えない', () => {
  const long = summarizeTrace(
    entries(...Array.from({ length: 300 }, (_, i) => [`Tool${i}`, `argument-${i}`])),
  );
  const line = formatTraceLine(long);
  assert.ok(line.length <= 1900, `${line.length}`);
  assert.match(line, /他 \d+ 種省略$/);
});

test('表示はバッククォートと制御文字を落とす (コードブロックを割らない)', () => {
  const line = formatTraceLine(summarizeTrace([{ tool: 'Bash', arg: 'a`b' }]));
  assert.ok(!line.includes('`'), line);
});

test('hook 入力から記録へ畳む / 名前が無ければ記録しない', () => {
  assert.deepEqual(
    traceEntryFrom({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.js' } }),
    { tool: 'Read', arg: 'b.js' },
  );
  assert.equal(traceEntryFrom({ hook_event_name: 'PostToolUse' }), null);
  assert.equal(traceEntryFrom({ hook_event_name: 'PostToolUse', tool_name: '   ' }), null);
});

test('実行されなかったツールは記録しない (実行後イベント以外を受けない)', () => {
  // PreToolUse は実行**前**に発火するので、拒否された呼び出しまで軌跡に載ってしまう。
  // 実測: hook が deny を返した Read は PreToolUse だけ発火し、実行後の 2 イベントは発火しない。
  // 配線を戻したら記録が空になり、「実行した証拠」でなくなったことに気付ける。
  const denied = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.js' } };
  assert.equal(traceEntryFrom(denied), null);
  assert.equal(traceEntryFrom({ hook_event_name: 'PermissionDenied', tool_name: 'Bash' }), null);
  assert.equal(traceEntryFrom({ hook_event_name: 'Stop' }), null);
  assert.equal(traceEntryFrom({ tool_name: 'Read' }), null);
  // 拒否ぶんが混じらないので、集計もその 1 件を数えない
  assert.equal(summarizeTrace([traceEntryFrom(denied)].filter(Boolean)).total, 0);
});

test('失敗した実行も記録する (PostToolUse は成功時しか発火しない)', () => {
  // 落ちた npm test が軌跡から消えると、総数が過少になり「実行した証拠」として使えない
  assert.deepEqual(failedEntry(), { tool: 'PowerShell', arg: 'npm test', failed: true });
  // 成功時は failed を持たせない (1 job で数百行になるファイルを短く保つ)
  assert.deepEqual(traceEntryFrom(done('Read', { file_path: '/a/b.js' })), { tool: 'Read', arg: 'b.js' });

  const summary = summarizeTrace([
    traceEntryFrom(done('Read', { file_path: '/a/b.js' })),
    failedEntry(),
    failedEntry(),
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 2);
  assert.equal(formatTraceLine(summary), '🔧 ツール 3 件 (うち失敗 2): PowerShell×2 (npm test) / Read×1 (b.js)');
  // 失敗が無ければ注記そのものを出さない
  assert.equal(
    formatTraceLine(summarizeTrace([traceEntryFrom(done('Read', { file_path: '/a/b.js' }))])),
    '🔧 ツール 1 件: Read×1 (b.js)',
  );

  function failedEntry() {
    return traceEntryFrom(failed('PowerShell', { command: 'npm test' }));
  }
});

test('「編集前 Read」は成功した実行だけで数える', () => {
  // 失敗した Edit で打ち切ると、始まっていない作業を始まったことにしてしまう
  const summary = summarizeTrace([
    traceEntryFrom(done('Read', { file_path: '/a.js' })),
    traceEntryFrom(failed('Edit', { file_path: '/b.js' })),
    traceEntryFrom(done('Read', { file_path: '/c.js' })),
    traceEntryFrom(done('Edit', { file_path: '/b.js' })),
  ]);
  assert.equal(summary.readsBeforeFirstEdit, 2);
  // 失敗した Read は「読めていない」ので数えない
  const withFailedRead = summarizeTrace([
    traceEntryFrom(failed('Read', { file_path: '/a.js' })),
    traceEntryFrom(done('Edit', { file_path: '/b.js' })),
  ]);
  assert.equal(withFailedRead.readsBeforeFirstEdit, 0);
});

test('JSONL の追記と読み出し / 壊れた行は落とす', () => {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-trace-test-'));
  try {
    const file = join(dir, 'trace.jsonl');
    appendTraceEntry(file, { tool: 'Read', arg: 'a.js' });
    appendTraceEntry(file, { tool: 'Bash', arg: 'npm', failed: true });
    assert.deepEqual(readTraceEntries(file), [
      { tool: 'Read', arg: 'a.js', failed: false },
      { tool: 'Bash', arg: 'npm', failed: true },
    ]);

    writeFileSync(file, '{"tool":"Read","arg":"a.js"}\n{壊れた\n\n{"arg":"名前なし"}\n', 'utf8');
    assert.deepEqual(readTraceEntries(file), [{ tool: 'Read', arg: 'a.js', failed: false }]);
    // ファイルが無い job (hook 未有効) では空配列 — 呼び出し側は 0 件として扱える
    assert.deepEqual(readTraceEntries(join(dir, 'ない.jsonl')), []);
    assert.deepEqual(readTraceEntries(null), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('軌跡の投稿が失敗しても呼び出し側へ throw しない (handoff を止めない)', async () => {
  const seen = [];
  await postTraceQuietly(() => { throw new Error('送信失敗'); }, 'x', (err) => seen.push(err.message));
  await postTraceQuietly(() => Promise.reject(new Error('非同期の失敗')), 'x', (err) => seen.push(err.message));
  assert.deepEqual(seen, ['送信失敗', '非同期の失敗']);
  // 成功時は通知を呼ばない
  await postTraceQuietly(async () => 'ok', 'x', () => seen.push('呼ばれてはいけない'));
  assert.equal(seen.length, 2);
});

test('手順の要約: 読むだけの手を畳み、編集・コマンド・失敗を順に残す', () => {
  const steps = [
    { tool: 'Read', arg: 'a.js' }, { tool: 'Grep' }, { tool: 'Read', arg: 'b.js' },
    { tool: 'Edit', arg: 'a.js' }, { tool: 'Edit', arg: 'a.js' },
    { tool: 'PowerShell', arg: 'node --test a.test.js', failed: true },
    { tool: 'Edit', arg: 'a.js' },
    { tool: 'PowerShell', arg: 'node --test a.test.js' },
    { tool: 'TodoWrite' },
    { tool: 'Bash' },
  ];
  assert.equal(
    digestTrace(steps),
    '読む×3 → 編集 a.js×2 → $ node --test a.test.js ✗ → 編集 a.js → $ node --test a.test.js → TodoWrite → $ ?',
  );
  assert.equal(digestTrace([]), null);
  assert.equal(digestTrace([{ tool: '' }]), null);
});

test('手順の要約が長いときは頭と尻を残し、真ん中を手の数で畳む', () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({ tool: 'Edit', arg: `f${i}.js` }));
  const digest = digestTrace(steps, { maxChars: 80 });
  assert.ok(digest.length <= 80, digest);
  assert.match(digest, /^編集 f0\.js → /);
  assert.match(digest, / → 編集 f39\.js$/);
  const [, elided] = digest.match(/… (\d+) 手 …/);
  const shown = digest.split(' → ').filter((p) => p.startsWith('編集')).length;
  assert.equal(Number(elided) + shown, 40, '畳んだ手と見せた手の合計が元の手の数と合わない');
});

test('手順の全部は 1 手 1 行・時刻は UTC・失敗に ✗', () => {
  const at = Date.UTC(2026, 9, 13, 10, 9, 20);
  assert.deepEqual(formatTraceSteps([
    { tool: 'Read', arg: 'a.js', at },
    { tool: 'Bash', arg: 'npm test', failed: true },
    { tool: '' },
  ]), [
    '1. 10:09:20 Read a.js',
    '2. Bash npm test ✗',
  ]);
});
