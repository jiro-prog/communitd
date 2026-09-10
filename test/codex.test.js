import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CODEX_CMD_HINT,
  CODEX_SANDBOXES,
  DEFAULT_CODEX_SANDBOX,
  createIsolatedHome,
  readUserReasoningEffort,
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
