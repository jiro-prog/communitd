import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  CODEX_CMD_HINT,
  CODEX_SANDBOXES,
  DEFAULT_CODEX_SANDBOX,
  createIsolatedHome,
  readUserReasoningEffort,
  removeTempDir,
  renderCodexConfig,
  resolveCodexCommand,
  runCodex,
} from '../src/codex.js';

// ---- codex コマンドの解決 (配備ごとの絶対パスを持たない) ----

const NPM_ENTRY = 'node_modules/@openai/codex/bin/codex.js';
/** exists の中身を「このパスだけ在る」で作る (区切りは win32 の \ で来る) */
const only = (...paths) => {
  const want = paths.map((p) => p.replaceAll('\\', '/'));
  return (p) => want.includes(String(p).replaceAll('\\', '/'));
};

test('非 Windows は PATH 解決に任せる (絶対パスを埋め込まない)', () => {
  const cmd = resolveCodexCommand({ platform: 'linux', env: {}, exists: () => false });
  assert.deepEqual(cmd, ['codex']);
  // 作者の環境のパスが既定に残っていないこと (公開できる既定であること)
  assert.equal(cmd.join(' ').includes('C:/Users'), false);
});

test('Windows は npm の .cmd シムではなく実体の JS を node で叩く', () => {
  // Node 20.12 以降の spawn は .cmd / .bat を直接起動できない (EINVAL)
  const dir = 'C:/npm';
  const cmd = resolveCodexCommand({
    platform: 'win32',
    env: { PATH: `C:/other;${dir}` },
    exists: only(`${dir}/codex.cmd`, `${dir}/${NPM_ENTRY}`),
    nodeBin: 'C:/node/node.exe',
  });
  assert.deepEqual(cmd, ['C:/node/node.exe', `C:\\npm\\${NPM_ENTRY}`.replaceAll('/', '\\')]);
});

test('Windows でも codex.exe があればそのまま使う', () => {
  const cmd = resolveCodexCommand({
    platform: 'win32',
    env: { PATH: 'C:/bin' },
    exists: only('C:/bin/codex.exe'),
  });
  assert.deepEqual(cmd, ['C:\\bin\\codex.exe']);
});

test('シムはあるのに実体を辿れなければ PATH の続きを見る', () => {
  const cmd = resolveCodexCommand({
    platform: 'win32',
    env: { PATH: '"C:/broken" ;C:/bin' },
    exists: only('C:/broken/codex.cmd', 'C:/bin/codex.exe'),
  });
  assert.deepEqual(cmd, ['C:\\bin\\codex.exe']);
});

test('Windows で見つからなければ null (黙って spawn せず codexCmd を案内させる)', () => {
  assert.equal(
    resolveCodexCommand({ platform: 'win32', env: { PATH: 'C:/bin' }, exists: () => false }),
    null,
  );
  assert.match(CODEX_CMD_HINT, /codexCmd/);
  // 案内は実体の在り処まで書く (npm 版の codex は .cmd シムなので名前だけでは直せない)
  assert.match(CODEX_CMD_HINT, /@openai\/codex\/bin\/codex\.js/);
});

test('codex を解決できなければ spawn せず、隔離 CODEX_HOME を残さない', async () => {
  // 認証コピーを置いた temp を消し忘れる経路を作らない (finish() と同じ不変条件)
  const prev = process.env.CODEX_HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'communitd-fakehome-'));
  writeFileSync(join(fakeHome, 'auth.json'), '{}');
  process.env.CODEX_HOME = fakeHome;
  const homes = () => readdirSync(tmpdir()).filter((n) => n.startsWith('communitd-codexhome-'));
  const before = homes();
  try {
    const res = await runCodex({
      cwd: process.cwd(),
      prompt: 'x',
      sandbox: 'workspace-write',
      resolveCmdImpl: () => null,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /codex を起動できません/);
    assert.match(res.error, /PATH に codex が見つかりません/, '未設定なら PATH の話でよい');
    assert.match(res.error, /codexCmd/, '直し方 (codexCmd) を書かないと原因に辿り着けない');
    assert.deepEqual(homes(), before, '認証コピーを含む隔離 home が temp に残っている');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// 実行文脈は config の codexSandbox を「書込み可」としてモデルへ渡す。隔離 CODEX_HOME を
// 用意できないときに黙って read-only で走らせると、その表示が嘘になる (sol 指摘 2026-08-01)。
// auth.json の無い CODEX_HOME を指せば createIsolatedHome が null を返すので、
// codex を spawn する前に失敗して戻ることを確認できる
test('workspace-write を用意できないときは降格せず失敗させる', async () => {
  const prev = process.env.CODEX_HOME;
  const empty = mkdtempSync(join(tmpdir(), 'communitd-noauth-'));
  process.env.CODEX_HOME = empty;
  try {
    const res = await runCodex({ cwd: process.cwd(), prompt: 'x', sandbox: 'workspace-write' });
    assert.equal(res.ok, false);
    assert.match(res.error, /workspace-write/);
    assert.match(res.error, /auth\.json/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(empty, { recursive: true, force: true });
  }
});

test('既定 sandbox は read-only (書込みは明示したチャンネルだけ)', () => {
  assert.equal(DEFAULT_CODEX_SANDBOX, 'read-only');
  assert.deepEqual(CODEX_SANDBOXES, ['read-only', 'workspace-write']);
  assert.equal(
    CODEX_SANDBOXES.includes('danger-full-access'),
    false,
    '全開放モードは渡せる選択肢に載せない',
  );
});

test('隔離 config には MCP / plugins / marketplaces を書かない', () => {
  const toml = renderCodexConfig({ sandbox: 'workspace-write', effort: 'xhigh' });
  for (const forbidden of ['mcp_servers', 'plugins', 'marketplaces', 'projects']) {
    assert.equal(toml.includes(forbidden), false, `${forbidden} を持ち込まない`);
  }
  assert.match(toml, /sandbox_mode = "workspace-write"/);
  assert.match(toml, /model_reasoning_effort = "xhigh"/);
  assert.match(toml, /approval_policy = "never"/);
});

test('Windows で書込みを成立させる [windows] sandbox = unelevated を必ず書く', () => {
  // elevated だと書込み時に昇格待ちで無応答になり、無指定だと read-only へ落ちる
  for (const sandbox of CODEX_SANDBOXES) {
    const toml = renderCodexConfig({ sandbox, effort: null });
    assert.match(toml, /\[windows\]\s*\nsandbox = "unelevated"/);
  }
});

test('effort が読めなければ行ごと省く (不正値を書き込まない)', () => {
  const toml = renderCodexConfig({ sandbox: 'read-only', effort: null });
  assert.equal(toml.includes('model_reasoning_effort'), false);
  assert.match(toml, /sandbox_mode = "read-only"/);
});

test('ユーザー config のトップレベルから reasoning effort を読む', () => {
  assert.equal(readUserReasoningEffort('model_reasoning_effort = "xhigh"\n'), 'xhigh');
  assert.equal(readUserReasoningEffort("model_reasoning_effort = 'high'"), 'high');
  assert.equal(readUserReasoningEffort('model = "x"\nmodel_reasoning_effort = "low"\n'), 'low');
  assert.equal(readUserReasoningEffort('  model_reasoning_effort   =  "MEDIUM"'), 'medium');
});

test('codex が受け付ける effort は全部読む (取りこぼすと既定の none で走る)', () => {
  // 未知の値は行ごと省く実装なので、この一覧が古いとユーザーの設定が黙って消える。
  // 2026-09-10 に max を取りこぼして Sol が推論なしでレビューしていた
  for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(
      readUserReasoningEffort(`model_reasoning_effort = "${level}"`),
      level,
      `${level} を読み落とすと隔離 config から行ごと消える`,
    );
  }
});

test('セクション以降の同名キーは拾わない (プロファイル設定に引きずられない)', () => {
  const toml = [
    'model = "gpt"',
    '',
    '[profiles.other]',
    'model_reasoning_effort = "none"',
  ].join('\n');
  assert.equal(readUserReasoningEffort(toml), null);
});

test('未知の effort 値・空入力は null (既定へ委ねる)', () => {
  assert.equal(readUserReasoningEffort('model_reasoning_effort = "turbo"'), null);
  assert.equal(readUserReasoningEffort(''), null);
  assert.equal(readUserReasoningEffort(null), null);
  assert.equal(readUserReasoningEffort(undefined), null);
});

// ---- 一時領域の後始末 (認証と sandbox ユーザーの写しを残さない) ----

/** job が作る一時ディレクトリの一覧 (隔離 CODEX_HOME と出力先) */
const tempDirs = () =>
  readdirSync(tmpdir()).filter(
    (n) => n.startsWith('communitd-codexhome-') || n.startsWith('communitd-codex-'),
  );

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const throwing = (code, message) => () => {
  const err = new Error(message);
  err.code = code;
  throw err;
};

/** console を差し替えて拾う (後始末の告知は標準出力にしか出ない) */
function captureConsole() {
  const logs = [];
  const errors = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore: () => {
      console.log = original.log;
      console.error = original.error;
    },
  };
}

test('spawn の同期例外でも隔離 home と出力先を残さない', async () => {
  // spawn は非同期の 'error' だけでなく同期例外も投げる (Sol の sandbox では EPERM)。
  // これを Promise の executor の中でやると reject が finish() を素通りし、認証と
  // sandbox ユーザーの写しを置いた temp が残る (sol 指摘 2026-09-11)
  const prev = process.env.CODEX_HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'communitd-fakehome-'));
  writeFileSync(join(fakeHome, 'auth.json'), '{}');
  process.env.CODEX_HOME = fakeHome;
  const before = tempDirs();
  try {
    const res = await runCodex({
      cwd: process.cwd(),
      prompt: 'x',
      resolveCmdImpl: () => ['codex'],
      spawnImpl: throwing('EPERM', 'spawn EPERM'),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /spawn failed/);
    assert.deepEqual(tempDirs(), before, '認証コピーを含む temp が残っている');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('同期例外でも ENOENT / EINVAL には直し方を添える (error イベントと同じ文)', async () => {
  const res = await runCodex({
    cwd: process.cwd(),
    prompt: 'x',
    resolveCmdImpl: () => ['codex'],
    spawnImpl: throwing('ENOENT', 'spawn ENOENT'),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /spawn failed: spawn ENOENT/);
  assert.match(res.error, /codexCmd/, '設定の直し先を書かないと原因に辿り着けない');
});

test('spawn には win32 以外でだけ detached が渡る (killTree が孫まで届く前提)', async () => {
  // Windows では detachOption() が {} なので、落としても手元では永久に気付けない。
  // spawn の直後に throw させて opts だけ見る (子は起こさない。Opus2 指摘 2026-09-11)
  let opts = null;
  const res = await runCodex({
    cwd: process.cwd(),
    prompt: 'x',
    resolveCmdImpl: () => ['codex'],
    spawnImpl: (bin, args, spawnOpts) => {
      opts = spawnOpts;
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(opts?.detached, process.platform === 'win32' ? undefined : true);
  assert.equal(opts?.windowsHide, true);
});

test('出力先を作れないときは throw せず、作った隔離 home を消してから返す', async () => {
  // 呼び出し側は Promise を待っている。同期 throw だと隔離 home を抱えたまま
  // job が internal-error で落ちる。**隔離 home が実際に作られる条件で試す** —
  // TEMP を壊す形だと隔離 home の方が先に落ち、この経路の削除を消してもテストが通る
  // (sol 指摘 2026-09-11)
  const prev = process.env.CODEX_HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'communitd-fakehome-'));
  writeFileSync(join(fakeHome, 'auth.json'), '{}');
  process.env.CODEX_HOME = fakeHome;
  const homes = () => readdirSync(tmpdir()).filter((n) => n.startsWith('communitd-codexhome-'));
  const before = homes();
  try {
    const res = await runCodex({
      cwd: process.cwd(),
      prompt: 'x',
      resolveCmdImpl: () => ['codex'],
      mkdtempImpl: throwing('ENOSPC', 'ENOSPC: no space left on device'),
      spawnImpl: () => assert.fail('出力先が無いのに spawn している'),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /一時出力ディレクトリを作れない/);
    assert.match(res.error, /ENOSPC/, '原因が分からないと直せない');
    assert.deepEqual(homes(), before, '認証コピーを含む隔離 home が temp に残っている');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('消せない一時ディレクトリは間隔を空けてやり直す (Windows の EBUSY)', async () => {
  // kill された codex が sqlite を掴んだままだと 1 回目の削除が落ちる。掴みが外れれば消える
  const io = captureConsole();
  let calls = 0;
  const rm = () => {
    calls += 1;
    if (calls < 3) throwing('EBUSY', 'EBUSY: resource busy or locked')();
  };
  try {
    removeTempDir('/tmp/communitd-does-not-matter', '一時出力ディレクトリ', { delays: [5, 5, 5], rm });
    assert.equal(calls, 1, 'やり直しを待たずに呼び出し側を止めている');
    await sleep(80);
    assert.equal(calls, 3, '掴みが外れた後もやり直していない');
  } finally {
    io.restore();
  }
  // 消えたら結末も 1 行残す (先に「消せません」と言ってあるため)
  assert.equal(io.logs.length, 1, io.logs.join(' / '));
  assert.match(io.logs[0], /一時出力ディレクトリ\s?を削除しました/);
  assert.match(io.logs[0], /3 回目/);
});

test('やり直す前に 1 行目を出す (終了が挟まっても残ったパスが分かるように)', async () => {
  // やり直しのタイマーは unref してあり、/restart や停止はそれを待たない。最後の告知まで
  // 黙っていると、資格情報の写しが「誰にも知られずに」残りうる (sol 指摘 2026-09-11)
  const io = captureConsole();
  try {
    // 間隔は sleep より十分長く取る — 5ms × 3 だと Linux の精密なタイマーでは 20ms 後に
    // 最終告知まで出てしまい、「途中で言い直さない」の検査が成り立たない (Windows のタイマーは
    // 粗いので偶然通っていた。v0.1.3 の ubuntu CI で発覚)
    removeTempDir('/tmp/communitd-stuck-home', '認証コピーを含む一時 CODEX_HOME', {
      delays: [60, 60, 60],
      rm: throwing('EBUSY', 'EBUSY: resource busy or locked'),
    });
    assert.equal(io.errors.length, 1, '1 回目の失敗を黙っている');
    assert.match(io.errors[0], /認証コピーを含む一時 CODEX_HOME\s?を削除できません/);
    assert.match(io.errors[0], /communitd-stuck-home/, '残ったパスを書いていない');
    assert.match(io.errors[0], /3 回やり直します/);
    assert.match(io.errors[0], /手動で削除/);
    // やり直しの途中では言い直さない (同じ 1 件を何度も出さない)
    await sleep(20);
    assert.equal(io.errors.length, 1, 'やり直すたびに告知している');
    // 最後まで消せなければ従来どおり締めの 1 行 (3 回目の失敗は 180ms 後)
    await sleep(400);
    assert.equal(io.errors.length, 2);
    assert.match(io.errors[1], /認証コピーを含む一時 CODEX_HOME の削除に失敗/);
  } finally {
    io.restore();
  }
});

test('最後まで消せなければ黙らない (認証が temp に残ったことを知らせる)', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    removeTempDir('/tmp/communitd-stuck', '認証コピーを含む一時 CODEX_HOME', {
      delays: [],
      rm: throwing('EBUSY', 'EBUSY: resource busy or locked'),
    });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /認証コピーを含む一時 CODEX_HOME/);
  assert.match(errors[0], /手動で削除/);
});

// ---- bot ごとの effort (bots.<key>.effort) ----

/**
 * auth.json (と任意の config.toml) だけを置いた偽 CODEX_HOME で fn を走らせる。
 * fn が受け取る keep に渡したディレクトリも後始末する。
 */
async function withFakeCodexHome(configToml, fn) {
  const prev = process.env.CODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), 'communitd-fakehome-'));
  writeFileSync(join(home, 'auth.json'), '{}');
  if (configToml !== null) writeFileSync(join(home, 'config.toml'), configToml);
  process.env.CODEX_HOME = home;
  const cleanup = [home];
  try {
    return await fn({ home, keep: (dir) => { if (dir) cleanup.push(dir); } });
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

const tomlOf = (dir) => readFileSync(join(dir, 'config.toml'), 'utf8');

test('bot ごとの effort はユーザー設定より優先する (gpt-5.5 は max を拒む)', async () => {
  // ChatGPT アカウント認証で使える会話モデル gpt-5.5 は "max" を 400 で拒む。
  // ユーザー ~/.codex/config.toml が max の環境では、この上書きが無いと必ず落ちる
  await withFakeCodexHome('model_reasoning_effort = "max"\n', ({ keep }) => {
    const dir = createIsolatedHome('read-only', null, 'medium');
    keep(dir);
    const toml = tomlOf(dir);
    assert.match(toml, /model_reasoning_effort = "medium"/);
    assert.equal(toml.includes('"max"'), false, 'ユーザー設定の max が残っている');
  });
});

test('effort 未指定の bot は従来どおりユーザー設定を写す', async () => {
  await withFakeCodexHome('model_reasoning_effort = "max"\n', ({ keep }) => {
    const dir = createIsolatedHome('read-only');
    keep(dir);
    assert.match(tomlOf(dir), /model_reasoning_effort = "max"/);
  });
});

test('codex が知らない effort は書かず、ユーザー設定 / 既定へ委ねる', async () => {
  // 未知の値を隔離 config.toml へ書くと codex が 400 で落ち、原因が「隔離 config の中身」に
  // なって遠い。起動時の検証 (src/config.js) を素通りした値に対する二重の歯止め
  await withFakeCodexHome('model_reasoning_effort = "high"\n', ({ keep }) => {
    const dir = createIsolatedHome('read-only', null, 'turbo');
    keep(dir);
    assert.match(tomlOf(dir), /model_reasoning_effort = "high"/);
  });
  await withFakeCodexHome(null, ({ keep }) => {
    const dir = createIsolatedHome('read-only', null, 'turbo');
    keep(dir);
    assert.equal(tomlOf(dir).includes('model_reasoning_effort'), false);
  });
});

test('runCodex の effort は spawn した codex の CODEX_HOME まで届く', async () => {
  // 配線の端から端まで (runCodex → createIsolatedHome → 子プロセスの CODEX_HOME) を見る。
  // 偽の codex は -o で渡された出力先へ隔離 config.toml をそのまま書き戻すだけ
  await withFakeCodexHome('model_reasoning_effort = "max"\n', async ({ keep }) => {
    const dir = mkdtempSync(join(tmpdir(), 'communitd-fakecodex-'));
    keep(dir);
    const script = join(dir, 'fake-codex.mjs');
    writeFileSync(script, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const out = process.argv[process.argv.indexOf('-o') + 1];",
      "writeFileSync(out, readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));",
      '',
    ].join('\n'));
    const res = await runCodex({
      cwd: process.cwd(),
      prompt: 'x',
      effort: 'medium',
      resolveCmdImpl: () => [process.execPath, script],
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.result, /model_reasoning_effort = "medium"/);
    assert.equal(res.result.includes('"max"'), false, 'ユーザー設定の max が子プロセスまで届いている');
  });
});

// ---- Windows sandbox の状態ファイル (workspace-write が固まらないために要る) ----

const SANDBOX_STATE = ['cap_sid', '.sandbox-secrets/sandbox_users.json', '.sandbox/setup_marker.json'];

/** 実 home 側に sandbox の状態ファイルを置く (内容はパスをそのまま書く) */
function putSandboxState(home, relPaths = SANDBOX_STATE) {
  for (const rel of relPaths) {
    const to = join(home, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, `content of ${rel}`);
  }
}

const hasFile = (dir, rel) => existsSync(join(dir, ...rel.split('/')));

test('workspace-write では sandbox の状態ファイルを写す (無いと job が無反応で固まる)', async () => {
  // codex は marker が無いと sandbox setup をやり直そうとし、最初のコマンドが返らないまま
  // タイムアウトまで沈黙する (2026-09-11 に Sol のレビューがこれで止まった)
  await withFakeCodexHome(null, ({ keep, home }) => {
    putSandboxState(home);
    const dir = createIsolatedHome('workspace-write');
    keep(dir);
    for (const rel of SANDBOX_STATE) {
      assert.equal(hasFile(dir, rel), true, `${rel} を写していない`);
      assert.equal(readFileSync(join(dir, ...rel.split('/')), 'utf8'), `content of ${rel}`);
    }
  });
});

test('read-only では写さない (sandbox setup が要らず、資格情報を撒かない)', async () => {
  // sandbox_users.json は sandbox 用ローカルユーザーの資格情報。auth.json と同じ扱いで、
  // 要らない job の temp にまで置かない
  await withFakeCodexHome(null, ({ keep, home }) => {
    putSandboxState(home);
    const dir = createIsolatedHome('read-only');
    keep(dir);
    for (const rel of SANDBOX_STATE) assert.equal(hasFile(dir, rel), false, `${rel} を写している`);
    assert.equal(existsSync(join(dir, 'auth.json')), true, '認証は従来どおり写す');
  });
});

test('実 home に無い状態ファイルは飛ばす (非 Windows・sandbox 未 setup の環境)', async () => {
  await withFakeCodexHome(null, ({ keep, home }) => {
    putSandboxState(home, ['cap_sid']);
    const dir = createIsolatedHome('workspace-write');
    keep(dir);
    assert.ok(dir, '写せる分だけ写して隔離 home は作る');
    assert.equal(hasFile(dir, 'cap_sid'), true);
    assert.equal(hasFile(dir, '.sandbox/setup_marker.json'), false);
  });
});

test('在るのに写せなければ隔離 home を作らない (中途半端な home で固まらせない)', async () => {
  // 欠けたまま workspace-write で走ると症状は「無反応のまま固まる」。runCodex は
  // 隔離 home 無しの workspace-write を降格させずに落とすので、ここで null を返せば
  // 人間には理由の分かる失敗として見える
  await withFakeCodexHome(null, ({ home }) => {
    putSandboxState(home, ['cap_sid', '.sandbox/setup_marker.json']);
    // ファイルの位置にディレクトリを置く = 読めるが copyFileSync が失敗する形
    mkdirSync(join(home, '.sandbox-secrets', 'sandbox_users.json'), { recursive: true });
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('communitd-codexhome-'));
    assert.equal(createIsolatedHome('workspace-write'), null);
    assert.deepEqual(
      readdirSync(tmpdir()).filter((n) => n.startsWith('communitd-codexhome-')),
      before,
      '作りかけの隔離 home が temp に残っている',
    );
  });
});

// ---- 組み込み指示の差し替え (相談役として立てる bot) ----

test('指示ファイルを渡すと model_instructions_file を書く (パスは / へ正規化)', () => {
  const toml = renderCodexConfig({
    sandbox: 'read-only',
    effort: null,
    instructionsFile: 'C:\\Users\\x\\instructions.md',
  });
  assert.match(toml, /model_instructions_file = "C:\/Users\/x\/instructions\.md"/);
  // TOML では \ がエスケープ開始文字。Windows パスをそのまま書くと解釈が壊れる
  assert.equal(toml.includes('\\'), false);
});

test('指示ファイル未指定なら model_instructions_file を書かない (既存 bot は組み込み指示のまま)', () => {
  const toml = renderCodexConfig({ sandbox: 'read-only', effort: null });
  assert.equal(toml.includes('model_instructions_file'), false);
});

test('隔離 home には指示の内容そのものを書き出し、config.toml からそこを指す', () => {
  // 元のパスを config.toml へ書くと、読んでから codex が開くまでの間に指示が
  // 書き換わる窓ができる (role prompt を一時ファイルへ写す bridge/job.js と同じ理由)
  const prev = process.env.CODEX_HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'communitd-fakehome-'));
  writeFileSync(join(fakeHome, 'auth.json'), '{}');
  process.env.CODEX_HOME = fakeHome;
  let dir = null;
  try {
    dir = createIsolatedHome('read-only', '相談役として答える');
    assert.ok(dir, '隔離 home を作れる');
    assert.equal(readFileSync(join(dir, 'instructions.md'), 'utf8'), '相談役として答える');
    const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
    assert.match(toml, /model_instructions_file = ".*\/instructions\.md"/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    for (const d of [fakeHome, dir]) if (d) rmSync(d, { recursive: true, force: true });
  }
});

test('読めない指示ファイルは spawn 前に落とす', async () => {
  const res = await runCodex({
    cwd: process.cwd(),
    prompt: 'x',
    instructionsFile: join(tmpdir(), 'communitd-instructions-that-does-not-exist.md'),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /指示ファイルを読めない/);
});

test('隔離 CODEX_HOME を用意できないときは read-only でも指示の差し替えごと落とす', async () => {
  // 退避 (--ignore-user-config) は隔離 config.toml を読まないので差し替えが黙って消え、
  // 相談役のつもりの bot が組み込みのコーディングエージェントとして応答してしまう
  const prev = process.env.CODEX_HOME;
  const empty = mkdtempSync(join(tmpdir(), 'communitd-noauth-'));
  const instructions = join(empty, 'instructions.md');
  writeFileSync(instructions, '相談役として答える');
  process.env.CODEX_HOME = empty;
  try {
    const res = await runCodex({
      cwd: process.cwd(),
      prompt: 'x',
      sandbox: 'read-only',
      instructionsFile: instructions,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /指示の差し替え/);
    assert.match(res.error, /auth\.json/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(empty, { recursive: true, force: true });
  }
});
