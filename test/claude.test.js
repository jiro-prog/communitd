import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { resolveClaudeCommand, runClaude } from '../src/claude.js';
import { SCHEMAS } from '../src/contract.js';

/**
 * spawn の代わりに引数だけ受け取り、すぐ終わる子プロセスを装う。
 * extra を渡すと result JSON へ追加のキー (usage など) を混ぜられる。
 */
function fakeSpawn(seen, extra = {}) {
  return (bin, args, opts) => {
    seen.bin = bin;
    seen.args = args;
    seen.opts = opts;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    setImmediate(() => {
      child.stdout.emit('data', `${JSON.stringify({
        is_error: false, session_id: 's1', result: '{"本文":"ok"}',
        structured_output: { 本文: 'ok' },
        ...extra,
      })}\n`);
      child.emit('close', 0);
    });
    return child;
  };
}

/**
 * **CLI の解決を固定した runClaude。このファイルは必ずこちらを通す。**
 *
 * 素の runClaude は実機の PATH から claude の実体を引くので、claude が入っていない
 * (あるいは npm 版で .cmd シムしか無い) Windows では解決が null になり、spawnImpl まで
 * 辿り着かないテストが出る。**CI は ubuntu で必ず `[bin]` を返すので緑のまま**という、
 * 気付けない経路だった (Opus2 実測 2026-09-10 — PATH を外すと 5 件落ちた)。
 * 解決そのものを見るテストは opts で resolveCmdImpl を上書きする。
 */
const fixedCmd = (bin) => [bin ?? 'claude'];
const runT = (opts) => runClaude({ resolveCmdImpl: fixedCmd, ...opts });

async function argsFor(opts) {
  const seen = {};
  const res = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x',
    spawnImpl: fakeSpawn(seen), resolveCmdImpl: fixedCmd, ...opts,
  });
  return { args: seen.args, bin: seen.bin, res };
}

test('spawn には win32 以外でだけ detached が渡る (killTree が孫まで届く前提)', async () => {
  // Windows では detachOption() が {} なので、落としても手元では永久に気付けない。
  // 実行 OS ごとの期待をここで固定する (Opus2 指摘 2026-09-11)
  const seen = {};
  await runT({ cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl: fakeSpawn(seen) });
  assert.equal(seen.opts?.detached, process.platform === 'win32' ? undefined : true);
  // 既存のオプションを落としていないことも一緒に見る
  assert.equal(seen.opts?.windowsHide, true);
  assert.deepEqual(seen.opts?.stdio, ['pipe', 'pipe', 'pipe']);
});

test('契約が無い job では権限に関わる引数が 1 つも増えない (回帰)', async () => {
  const { args } = await argsFor({ allowedTools: ['Read', 'Edit'] });
  assert.deepEqual(args, [
    '-p', '--output-format', 'json',
    '--model', 'opus',
    '--permission-mode', 'default',
    // キャッシュのための常時付与。権限には触らないので「増えない」の対象外
    '--exclude-dynamic-system-prompt-sections',
    '--session-id', args[args.indexOf('--session-id') + 1],
    '--allowedTools', 'Read', 'Edit',
  ]);
  for (const flag of [
    '--json-schema', '--tools', '--disallowedTools', '--strict-mcp-config', '--setting-sources',
  ]) {
    assert.equal(args.includes(flag), false, `${flag} が勝手に付いている`);
  }
});

test('--effort は指定したときだけ付く', async () => {
  const specified = await argsFor({ effort: 'low' });
  const i = specified.args.indexOf('--effort');
  assert.ok(i > 0, '--effort が付いていない');
  assert.equal(specified.args[i + 1], 'low');

  const omitted = await argsFor({});
  assert.equal(omitted.args.includes('--effort'), false, '未指定なのに --effort が付いている');
});

test('スキーマを渡した job だけ --json-schema が付き、structured_output を返す', async () => {
  const { args, res } = await argsFor({ jsonSchema: SCHEMAS.report });
  const i = args.indexOf('--json-schema');
  assert.ok(i > 0, '--json-schema が付いていない');
  assert.deepEqual(JSON.parse(args[i + 1]), SCHEMAS.report);
  // 結果 JSON の structured_output はパース済みのオブジェクトで返る
  assert.deepEqual(res.structuredOutput, { 本文: 'ok' });
});

test('スキーマ無しでは structuredOutput は null (縮退の判定に使う)', async () => {
  const seen = {};
  const spawnImpl = (bin, args) => {
    seen.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    setImmediate(() => {
      child.stdout.emit('data', `${JSON.stringify({ is_error: false, session_id: 's1', result: '散文' })}\n`);
      child.emit('close', 0);
    });
    return child;
  };
  const res = await runT({ cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl });
  assert.equal(res.structuredOutput, null);
  assert.equal(res.result, '散文');
});

test('参照ディレクトリを空にすれば --add-dir は付かない (touch 制限中)', async () => {
  // --add-dir は読取専用にできないので、残すと touch 集合の外へ書ける
  const withDirs = await argsFor({ addDirs: ['C:/other/repo'] });
  assert.ok(withDirs.args.includes('--add-dir'), '通常の job で参照ディレクトリが渡っていない');
  const narrowed = await argsFor({ addDirs: [] });
  assert.equal(narrowed.args.includes('--add-dir'), false, 'touch 制限中に cwd の外を開いている');
});

test('touch 制限の 4 点セットがそのまま引数になる', async () => {
  const { args } = await argsFor({
    permissionMode: 'default',
    allowedTools: ['Read', 'Edit(./src/a.js)'],
    tools: ['Read', 'Grep', 'Edit'],
    disallowedTools: ['Bash', 'Agent'],
    strictMcp: true,
  });
  // --tools はカンマ区切り 1 引数 (CLI の受け取り方)
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Edit');
  assert.ok(args.includes('--strict-mcp-config'));
  const d = args.indexOf('--disallowedTools');
  assert.deepEqual(args.slice(d + 1, d + 3), ['Bash', 'Agent']);
  // 順序: --tools は --allowedTools より前 (どちらでも効くが、読みで迷わないよう固定する)
  assert.ok(args.indexOf('--tools') < args.indexOf('--allowedTools'));
});

test('空のツール集合は「1 つも使わせない」として渡す (無指定と区別する)', async () => {
  // 空配列を省略すると、絞ったつもりで全ツールが使える状態になる (sol 指摘 2026-08-03)。
  // CLI は `--tools ""` を全ツール無効として受ける (実測)
  const empty = await argsFor({ tools: [] });
  assert.equal(empty.args[empty.args.indexOf('--tools') + 1], '',
    '空のツール集合が無指定に化けている');

  // null だけが「絞らない」= 契約が無い job
  const none = await argsFor({ tools: null, disallowedTools: [], settingSources: null });
  for (const flag of ['--tools', '--disallowedTools', '--strict-mcp-config', '--setting-sources']) {
    assert.equal(none.args.includes(flag), false, `${flag} が無指定でも付いている`);
  }
});

test('touch 制限中は外部 settings を読ませない (permissions.allow で破られる)', async () => {
  // 作者の user settings に `permissions.allow: ["Edit"]` が 1 行あるだけで
  // touch 制限が破れる (実測 2026-08-03)。job 専用 hooks は --settings 側なので残る
  const { args } = await argsFor({ settingSources: '', settingsFile: 'C:/tmp/job/settings.json' });
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--settings') + 1], 'C:/tmp/job/settings.json',
    'job 専用 hooks まで落としている');
});

test('spawn 前に停止指示が来ていたら起動しない (既存の契約を壊さない)', async () => {
  const seen = {};
  const res = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x',
    handle: { stopRequested: true },
    spawnImpl: fakeSpawn(seen),
  });
  assert.equal(res.aborted, true);
  assert.equal(seen.args, undefined, 'spawn してしまっている');
});

test('--exclude-dynamic-system-prompt-sections はどの経路でも必ず付く', async () => {
  // 動的セクション (cwd / env / git status) が system prompt に残っていると、
  // job がファイルを触るたびに**その後ろの会話履歴が丸ごと**再キャッシュになる。
  // 経路ごとに付け外しすると、外れた経路だけが静かに高くつく — 常時付与を固定する
  const flag = '--exclude-dynamic-system-prompt-sections';
  const cases = {
    '新規セッション': {},
    'resume': { resume: true, sessionId: 's1' },
    '画像あり (stream-json 経路)': {
      images: [{ mediaType: 'image/png', bytes: Buffer.from('x') }],
    },
    '契約で絞られた job': {
      permissionMode: 'default',
      tools: ['Read', 'Edit'],
      disallowedTools: ['Agent'],
      strictMcp: true,
      settingSources: '',
      addDirs: [],
    },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const { args } = await argsFor(opts);
    assert.equal(args.filter((a) => a === flag).length, 1, `${name}: ${flag} が 1 個ではない`);
  }
});

test('result JSON の usage を計測用に正規化して返す', async () => {
  // 実機で確認した実形 (2026-08-04): input / cache_creation / cache_read / output。
  // 入力の大半は cacheRead なので、in / out だけに畳まず読み書きを分けて持つ
  const seen = {};
  const res = await runT({
    cwd: 'C:/tmp',
    model: 'opus',
    prompt: 'x',
    spawnImpl: fakeSpawn(seen, {
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 6100,
        cache_read_input_tokens: 470000,
        output_tokens: 2000,
        // 使わないキーが増えても壊れない (CLI 側で付いてくる)
        service_tier: 'standard',
        iterations: [{ input_tokens: 10 }],
      },
    }),
  });
  assert.deepEqual(res.usage, {
    inputTokens: 20,
    cacheReadTokens: 470000,
    cacheWriteTokens: 6100,
    outputTokens: 2000,
  });
});

test('usage が無い / 壊れている result でも従来どおり動く', async () => {
  // usage は計測のためだけの値なので、欠けても job の成否には触らせない
  const bare = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl: fakeSpawn({}),
  });
  assert.equal(bare.ok, true);
  assert.equal(bare.usage, null);
  assert.deepEqual(bare.structuredOutput, { 本文: 'ok' });

  for (const usage of [null, 'なんか文字列', {}, { input_tokens: -1 }, { input_tokens: 'x' }]) {
    const res = await runT({
      cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl: fakeSpawn({}, { usage }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.usage, null, `usage=${JSON.stringify(usage)} を値として拾っている`);
  }

  // キーごと無い項目があっても、取れた分は返す (行から落ちるのは欠けた項目だけ)
  const partial = await runT({
    cwd: 'C:/tmp',
    model: 'opus',
    prompt: 'x',
    spawnImpl: fakeSpawn({}, { usage: { output_tokens: 12, cache_read_input_tokens: 0 } }),
  });
  assert.deepEqual(partial.usage, {
    inputTokens: undefined,
    cacheReadTokens: 0,
    cacheWriteTokens: undefined,
    outputTokens: 12,
  });
});

test('usage は計測値として出せる非負の安全整数だけ通す (表示側と同じ基準)', async () => {
  // 正規化が緩いと「正規化は通ったのに表示で黙って落ちる」二段構えになり、
  // 取れなかったのか弾かれたのかがログから区別できない (sol 指摘 2026-08-04)
  const usageOf = async (usage) => {
    const res = await runT({
      cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl: fakeSpawn({}, { usage }),
    });
    assert.equal(res.ok, true, '計測値の縮退が job の成否に触れている');
    return res.usage;
  };

  // 整数でない・安全整数を超える・負・非数はすべて弾く (1 項目だけなら usage ごと null)
  for (const bad of [
    1.5, -0.5, Number.MAX_SAFE_INTEGER + 1, 1e300, Infinity, -Infinity, NaN,
    '1000', null, undefined, true, [], {},
  ]) {
    assert.equal(
      await usageOf({ input_tokens: bad }), null,
      `input_tokens=${String(bad)} を値として拾っている`,
    );
  }

  // 弾くのは壊れた項目だけ。同じ usage の中の正しい項目は残す
  assert.deepEqual(
    await usageOf({
      input_tokens: 1.5,
      cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
      cache_creation_input_tokens: 6100,
      output_tokens: 2000,
    }),
    {
      inputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: 6100,
      outputTokens: 2000,
    },
  );

  // 境界: 安全整数ちょうどと 0 は通す
  assert.deepEqual(
    await usageOf({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }),
    {
      inputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      outputTokens: 0,
    },
  );
});

test('onSpawn は子プロセスの pid と時刻を知らせ、throw しても起動は続く', async () => {
  const seen = {};
  const spawned = [];
  const res = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x',
    spawnImpl: (bin, args) => Object.assign(fakeSpawn(seen)(bin, args), { pid: 4242 }),
    onSpawn: (info) => { spawned.push(info); throw new Error('記録できない'); },
  });
  assert.equal(res.ok, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].pid, 4242);
  assert.equal(spawned[0].runtime, 'claude');
  assert.ok(Number.isFinite(spawned[0].at));
  // spawn 前の停止では呼ばれない (起動していないので副作用も無い)
  const before = [];
  const stopped = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x', spawnImpl: fakeSpawn({}),
    handle: { stopRequested: true }, onSpawn: (info) => before.push(info),
  });
  assert.equal(stopped.aborted, true);
  assert.equal(before.length, 0);
});

// ---- claude CLI の在り処 (src/clicmd.js を通す) ----

test('npm 版 claude の .cmd シムは中身を読んで実体 (bin/claude.exe) へ辿る', () => {
  // Node 20.12 以降の spawn は .cmd を直接起動できない (EINVAL)。
  // **実体の名前を決め打ちしない** — claude は 2.0 まで cli.js、2.1 以降 bin/claude.exe で、
  // 決め打ちだと版が変わった日に「PATH に居るのに全 job が起動しない」になる
  const entry = 'C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const files = {
    'C:/npm/claude.cmd':
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
      + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    [entry]: '',
  };
  const norm = (p) => String(p).replaceAll('\\', '/');
  const fs = {
    exists: (p) => Object.hasOwn(files, norm(p)),
    readFile: (p) => {
      if (!Object.hasOwn(files, norm(p))) throw new Error('ENOENT');
      return files[norm(p)];
    },
  };
  assert.deepEqual(
    resolveClaudeCommand({ platform: 'win32', env: { PATH: 'C:/npm' }, ...fs })
      .map(norm),
    [entry],
    '.exe の実体に node を噛ませてしまっている',
  );
  // ネイティブ導入 (PATH 上の claude.exe) はそのまま使う
  assert.deepEqual(
    resolveClaudeCommand({
      platform: 'win32',
      env: { PATH: 'C:/bin' },
      exists: (p) => norm(p) === 'C:/bin/claude.exe',
    }).map(norm),
    ['C:/bin/claude.exe'],
  );
  assert.equal(
    resolveClaudeCommand({ platform: 'win32', env: { PATH: 'C:/bin' }, exists: () => false }),
    null,
  );
});

test('多語コマンドは先頭を実行ファイル、残りを引数の先頭へ置く', async () => {
  const { bin, args } = await argsFor({ resolveCmdImpl: () => ['C:/node.exe', 'C:/cli.js'] });
  assert.equal(bin, 'C:/node.exe');
  assert.equal(args[0], 'C:/cli.js', '実体の JS が -p より前に来ていない');
  assert.equal(args[1], '-p');
});

test('claude を解決できなければ spawn せず claudeBin の直し方を案内する', async () => {
  const seen = {};
  const res = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x',
    spawnImpl: fakeSpawn(seen), resolveCmdImpl: () => null,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /claude を起動できません/);
  assert.match(res.error, /claudeBin/, '直し方を書かないと原因に辿り着けない');
  assert.equal(seen.args, undefined, 'spawn してしまっている');
  assert.ok(res.sessionId, '呼び出し側が記録に使うのでセッション ID は返す');
});

test('claudeBin に絶対パスを書いた人へ「PATH に無い」と言わない', async () => {
  // 設定に絶対パスを書いてあるなら PATH は無関係。そこを取り違えると直す場所を探せない。
  // **解決は実物を通す** (resolveCmdImpl を渡さない) — 文言は設定値の形で決まる
  const seen = {};
  const broken = resolve(tmpdir(), 'communitd-該当しないシム.cmd');
  const res = await runClaude({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x', claudeBin: broken, spawnImpl: fakeSpawn(seen),
  });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes(broken), res.error);
  assert.match(res.error, /実体を辿れません/);
  assert.equal(res.error.includes('PATH'), false, 'PATH のせいにしている');
  assert.match(res.error, /claudeBin/);
  assert.equal(seen.args, undefined, '辿れないシムを spawn してしまっている');
});

test('spawn の ENOENT / EINVAL には claudeBin の直し方を添える', async () => {
  // 生の errno だけだと「PATH に居るのに落ちる」(.cmd シム) の原因が分からない
  const failing = (code) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    setImmediate(() => child.emit('error', Object.assign(new Error(`spawn claude ${code}`), { code })));
    return child;
  };
  for (const code of ['ENOENT', 'EINVAL']) {
    const res = await runT({
      cwd: 'C:/tmp', model: 'opus', prompt: 'x',
      spawnImpl: failing(code), resolveCmdImpl: fixedCmd,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, new RegExp(code));
    assert.match(res.error, /claudeBin/);
  }
  // 別の errno には足さない (的外れな案内を増やさない)
  const other = await runT({
    cwd: 'C:/tmp', model: 'opus', prompt: 'x',
    spawnImpl: failing('EACCES'), resolveCmdImpl: fixedCmd,
  });
  assert.equal(other.error.includes('claudeBin'), false);
});
