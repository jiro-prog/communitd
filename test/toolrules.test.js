import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalCwd } from '../src/grants.js';
import {
  collectProposals, describePathRule, proposeGrant, sanitizeForDisplay,
  suggestPathRule, suggestShellRule,
} from '../src/toolrules.js';

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const edit = (filePath) => ({ tool_name: 'Edit', tool_input: { file_path: filePath } });
const fetchUrl = (url) => ({ tool_name: 'WebFetch', tool_input: { url } });

/** 実ファイルを持つ作業ディレクトリ (grant の cwd は正規形でなければならない) */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'communitd-cwd-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.js'), '// x');
  return canonicalCwd(root);
}

// ---- 自動承認できるもの (ドメインだけ) ----

test('WebFetch はドメイン限定の grant になる (URL 丸ごとにしない)', () => {
  const cwd = workspace();
  const r = proposeGrant(fetchUrl('https://Docs.Example.com/a/b?q=1'), { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.rule, 'WebFetch(domain:docs.example.com)');
  assert.deepEqual(r.grant, { kind: 'web-domain', tool: 'WebFetch', value: 'docs.example.com', cwd });
});

test('grant の cwd は渡された正規形そのもの (表記が混ざらない)', () => {
  const cwd = workspace();
  const r = proposeGrant(fetchUrl('https://example.com/x'), { cwd });
  assert.equal(r.grant.cwd, cwd);
  // 非正規形を渡されたら grant にしない (呼び出し側の canonical 化漏れを検出する)
  assert.equal(proposeGrant(fetchUrl('https://example.com/x'), { cwd: cwd.replaceAll('/', '\\') }).ok,
    false);
});

test('cwd を解決できなければ何も承認しない', () => {
  assert.equal(proposeGrant(fetchUrl('https://example.com/x')).ok, false);
  assert.match(proposeGrant(fetchUrl('https://example.com/x'), { cwd: null }).reason, /作業ディレクトリ/);
});

// ---- シェルは自動承認しない ----

test('シェルコマンドは grant にしない (wrapper 除去で完全一致が保証されない)', () => {
  const cwd = workspace();
  for (const tool of ['Bash', 'PowerShell']) {
    const r = proposeGrant({ tool_name: tool, tool_input: { command: 'npm ci' } }, { cwd });
    assert.equal(r.ok, false, `${tool} を自動承認してはいけない`);
    assert.match(r.reason, /wrapper|自動承認できません/);
  }
});

test('安全に書けるシェルには、人間が貼れる候補を添える', () => {
  const cwd = workspace();
  assert.equal(proposeGrant(bash('npm ci'), { cwd }).suggestion, 'Bash(npm ci)');
  assert.equal(
    proposeGrant({ tool_name: 'PowerShell', tool_input: { command: 'git status' } }, { cwd }).suggestion,
    'PowerShell(git status)',
  );
});

test('安全に書けないシェルには候補も出さない', () => {
  const cwd = workspace();
  for (const cmd of [
    '', '  ', ' npm ci', 'npm ci ', 'git *', 'ls ?.txt',
    'git status; rm -rf x', 'git status && curl evil', 'git status | sh',
    'echo $(cat s)', 'echo `id`', "sh -c 'rm x'", 'cat > out',
    'node ../evil.js', 'cat /etc/passwd', 'node C:/tmp/x.js',
    'cat .env', 'node x.js --token abc', 'node x.js 0123456789abcdef0123456789abcdef',
    `node ${'ab-'.repeat(70)}`,
  ]) {
    const r = proposeGrant(bash(cmd), { cwd });
    assert.equal(r.ok, false);
    assert.equal(r.suggestion, undefined, `候補を出してはいけない: ${JSON.stringify(cmd)}`);
  }
  assert.equal(suggestShellRule('Read', 'npm ci'), null);
});

// ---- パスも自動承認しない ----

test('ファイルパスの拒否は grant にしない', () => {
  const cwd = workspace();
  for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const r = proposeGrant({ tool_name: tool, tool_input: { [key]: 'src/index.js' } }, { cwd });
    assert.equal(r.ok, false, `${tool} を自動承認してはいけない`);
    assert.match(r.reason, /自動承認できません/);
  }
});

test('安全に書ける場合だけ、人間が貼れるパス候補を添える', () => {
  const cwd = workspace();
  // ./ でアンカーする (付けないと任意の深さの同名ファイルに一致する)
  assert.equal(proposeGrant(edit(join(cwd, 'src', 'index.js')), { cwd }).suggestion,
    'Edit(./src/index.js)');
  // Write / NotebookEdit は claude が照合できる Edit ルールとして出す
  assert.equal(
    proposeGrant({ tool_name: 'Write', tool_input: { file_path: 'src/new.js' } }, { cwd }).suggestion,
    'Edit(./src/new.js)',
  );
  assert.equal(
    proposeGrant({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb' } }, { cwd }).suggestion,
    'Edit(./a.ipynb)',
  );
  assert.equal(
    proposeGrant({ tool_name: 'Read', tool_input: { file_path: 'src/index.js' } }, { cwd }).suggestion,
    'Read(./src/index.js)',
  );
});

test('安全に書けないパスでは候補も出さない', () => {
  const cwd = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'communitd-out-'));
  writeFileSync(join(outside, 'data.txt'), 'x');
  mkdirSync(join(cwd, 'adir'));

  for (const p of [
    'src', 'adir', '.',                       // ディレクトリ (配下すべてが対象になる)
    '../escape.js', join(outside, 'data.txt'), // cwd 外
    'file[1].js', 'a*.js', '!keep.js', 'a#b.js', // gitignore の特殊文字
    'trailing.js ',                            // 末尾空白は gitignore が無視する
    '.env', 'keys/api-key.txt',                // 秘密
  ]) {
    const r = proposeGrant(edit(p), { cwd });
    assert.equal(r.ok, false);
    assert.equal(r.suggestion, undefined, `候補を出してはいけない: ${p}`);
  }
});

test('cwd 配下のリンクが外を指していれば候補を出さない', () => {
  const cwd = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'communitd-out-'));
  writeFileSync(join(outside, 'data.txt'), 'x');
  try {
    symlinkSync(outside, join(cwd, 'link'), 'junction');
  } catch {
    return;
  }
  assert.equal(suggestPathRule('Edit', { file_path: 'link/data.txt' }, cwd), null);
});

test('cwd の中で完結するリンクも候補にしない (実体が touch 集合の外へ届く)', () => {
  // 外向きリンクだけを見ていると、cwd 内のリンク (alias/target.js → real/target.js) が
  // 素通りし、touch 集合に無い実体へ編集が届く (sol 指摘 2026-08-03)
  const cwd = workspace();
  mkdirSync(join(cwd, 'real'));
  writeFileSync(join(cwd, 'real', 'target.js'), '// x');
  try {
    symlinkSync(join(cwd, 'real'), join(cwd, 'alias'), 'junction');
  } catch {
    return; // リンクを作れない環境では判定できない
  }
  const r = describePathRule('Edit', 'alias/target.js', cwd);
  assert.equal(r.ok, false, 'リンク越しのパスを絞り込みに使っている');
  assert.match(r.reason, /リンク/);
  assert.equal(suggestPathRule('Edit', { file_path: 'alias/target.js' }, cwd), null);
  // 実体そのものは通る (リンクでなければ従来どおり)
  assert.equal(describePathRule('Edit', 'real/target.js', cwd).rule, 'Edit(./real/target.js)');
});

test('hardlink のあるファイルは候補にしない (別名から同じ変更が見える)', () => {
  // realpath では見抜けない (別名ではなく同じ実体そのもの)。touch 集合の中の名前を
  // 編集しただけで、集合の外の名前からも変更が見える (sol 指摘 2026-08-03)
  const cwd = workspace();
  mkdirSync(join(cwd, 'real'));
  writeFileSync(join(cwd, 'real', 'target.js'), '// x');
  try {
    linkSync(join(cwd, 'real', 'target.js'), join(cwd, 'alias.js'));
  } catch {
    return; // hardlink を作れない環境では判定できない
  }
  for (const path of ['alias.js', 'real/target.js']) {
    const r = describePathRule('Edit', path, cwd);
    assert.equal(r.ok, false, `hardlink を絞り込みに使っている: ${path}`);
    assert.match(r.reason, /別名|hardlink/);
    assert.equal(suggestPathRule('Edit', { file_path: path }, cwd), null);
  }
  // 別名の無いファイルは従来どおり通る
  assert.equal(describePathRule('Edit', 'src/index.js', cwd).rule, 'Edit(./src/index.js)');
});

test('Windows のフルパスは通常のパスとして扱う (区切りで弾かない)', () => {
  const cwd = workspace();
  assert.equal(suggestPathRule('Edit', { file_path: join(cwd, 'src', 'index.js') }, cwd),
    'Edit(./src/index.js)');
});

// ---- 候補にもしないもの ----

test('http・IP・読めない URL は候補にしない', () => {
  const cwd = workspace();
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://localhost/x',
    'https://127.0.0.1/x', 'not a url']) {
    assert.equal(proposeGrant(fetchUrl(url), { cwd }).ok, false, `候補にしてはいけない: ${url}`);
  }
  assert.equal(proposeGrant({ tool_name: 'WebFetch', tool_input: {} }, { cwd }).ok, false);
});

test('入力を束縛できないツールは候補にしない (MCP・検索・サブエージェント等)', () => {
  const cwd = workspace();
  for (const tool of ['mcp__UnityMCP__run', 'WebSearch', 'Task', 'Glob', 'Grep', 'TodoWrite']) {
    const r = proposeGrant({ tool_name: tool, tool_input: { pattern: '**' } }, { cwd });
    assert.equal(r.ok, false, `${tool} を候補にしてはいけない`);
    assert.match(r.reason, /入力を絞った形で許可できない/);
  }
  assert.equal(proposeGrant({ tool_name: '' }, { cwd }).ok, false);
});

// ---- 貼付候補は表示しても変わらないこと ----

test('表示で変わってしまう候補は出さない (貼っても効かないものを見せない)', () => {
  const cwd = workspace();
  // バッククォートを含むパスは表示時に ' へ潰れるので、貼ると別ファイルを指す
  writeFileSync(join(cwd, 'a`b.js'), 'x');
  assert.equal(suggestPathRule('Edit', { file_path: 'a`b.js' }, cwd), null);
  assert.equal(suggestShellRule('Bash', 'node a`b.js'), null);
});

test('出した候補は sanitizeForDisplay を通しても変わらない (不変条件)', () => {
  const cwd = workspace();
  const candidates = [
    suggestPathRule('Edit', { file_path: 'src/index.js' }, cwd),
    suggestPathRule('Read', { file_path: 'src/index.js' }, cwd),
    suggestShellRule('Bash', 'npm ci'),
    suggestShellRule('PowerShell', 'git status'),
    proposeGrant(bash('npx tsc --noEmit'), { cwd }).suggestion,
    proposeGrant(edit('src/index.js'), { cwd }).suggestion,
  ].filter(Boolean);
  assert.ok(candidates.length >= 5, '候補が生成されていない (テストの前提が崩れている)');
  for (const c of candidates) {
    assert.equal(sanitizeForDisplay(c, c.length), c, `表示で変わる候補を出している: ${c}`);
  }
});

// ---- 表示の無害化 ----

test('sanitizeForDisplay はバッククォートと制御文字を潰す (表示のときだけ使う)', () => {
  assert.equal(sanitizeForDisplay('```\n偽の承認済み表示'), "''' 偽の承認済み表示");
  assert.equal(sanitizeForDisplay('x'.repeat(20), 10), `${'x'.repeat(10)}…`);
  assert.equal(sanitizeForDisplay(null), '');
});

// ---- 集約 ----

test('同じ grant は 1 件に畳み、上限を超えた分は件数で返す', () => {
  const cwd = workspace();
  const denials = [
    fetchUrl('https://a.example.com/1'), fetchUrl('https://a.example.com/2'),
    fetchUrl('https://b.example.com/1'), fetchUrl('https://c.example.com/1'),
  ];
  const { proposals, dropped } = collectProposals(denials, { cwd, max: 2 });
  assert.deepEqual(proposals.map((p) => p.rule),
    ['WebFetch(domain:a.example.com)', 'WebFetch(domain:b.example.com)']);
  assert.equal(dropped, 1, '切り捨てを黙って隠している');
});

test('候補にできない拒否は理由と貼れる候補つきで並ぶ', () => {
  const cwd = workspace();
  const { proposals, rejected } = collectProposals(
    [bash('npm ci'), bash('npm ci'), edit('src/index.js')], { cwd },
  );
  assert.deepEqual(proposals, []);
  assert.equal(rejected.length, 2, '重複を畳めていない / 種類を落としている');
  assert.equal(rejected.find((r) => r.tool === 'Bash').suggestion, 'Bash(npm ci)');
  assert.equal(rejected.find((r) => r.tool === 'Edit').suggestion, 'Edit(./src/index.js)');
});

test('空・null でも落ちない', () => {
  assert.deepEqual(collectProposals(null), { proposals: [], rejected: [], dropped: 0 });
});

test('パス判定は承認候補と touch 集合の変換で同じ規則を使う (理由つき)', () => {
  // 片方だけ緩めると「承認候補には出ないのに touch 集合では通る」がすぐ起きるので、
  // suggestPathRule は describePathRule の薄い包みでなければならない
  const cwd = workspace();
  const ok = describePathRule('Edit', 'src/index.js', cwd);
  assert.deepEqual(ok, { ok: true, rule: 'Edit(./src/index.js)', relative: 'src/index.js' });
  assert.equal(suggestPathRule('Edit', { file_path: 'src/index.js' }, cwd), ok.rule);

  const bad = [
    ['src/*.js', /パターン文字/],
    ['src', /ディレクトリ/],
    ['.', /作業ディレクトリ自身|ディレクトリ/],
    ['../outside.js', /作業ディレクトリの外/],
    // 絶対パスの綴りは実 OS の規則で決まる (posix に `C:` ドライブは無く、そこでは
    // `C:/Windows/x.js` は本当にただの相対パス)。resolve で実 OS の形に直して渡す
    [resolve('/outside/x.js'), /作業ディレクトリの外/],
    [' src/index.js', /前後に空白/],
    ['', /空/],
    ['.env', /秘密/],
    [null, /空/],
  ];
  for (const [path, pattern] of bad) {
    const r = describePathRule('Edit', path, cwd);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(path)}`);
    assert.match(r.reason, pattern);
    // 同じ入力は承認候補にもならない (規則が 1 か所であることの確認)
    assert.equal(suggestPathRule('Edit', { file_path: path }, cwd), null,
      `候補には出てしまう: ${JSON.stringify(path)}`);
  }
  assert.equal(describePathRule('Bash', 'src/index.js', cwd).ok, false);
  assert.equal(describePathRule('Edit', 'src/index.js', null).ok, false);
});

test('Windows が特別扱いするパスは通さない (git 差分に出ないものを掴ませない)', () => {
  // どれも「通常のリポジトリファイルではないのに書き込めてしまう」経路で、
  // 変更が git 差分に出ないため検収から消える (sol 指摘 2026-08-03: 実測で通っていた)
  const cwd = workspace();
  const bad = [
    ['src/index.js:shadow', /代替データストリーム|使えない文字/], // NTFS ADS
    ['src/a:b.js', /使えない文字/],
    ['src/NUL', /予約デバイス名/],
    ['NUL', /予約デバイス名/],
    ['src/nul.txt', /予約デバイス名/], // 拡張子を付けても予約のまま
    ['src/COM1', /予約デバイス名/],
    ['src/lpt9.js', /予約デバイス名/],
    ['src/CONIN$', /予約デバイス名/], // コンソールデバイス
    ['src/conout$.txt', /予約デバイス名/],
    ['src/COM¹', /予約デバイス名/], // 上付き数字も Win32 はデバイス名として解釈する
    ['src/COM²', /予約デバイス名/],
    ['src/COM³', /予約デバイス名/],
    ['src/lpt¹.js', /予約デバイス名/],
    ['src/LPT²', /予約デバイス名/],
    ['src/LPT³', /予約デバイス名/],
    ['src/a.js ', /前後に空白/], // 前後の空白は入口で落ちる
    ['src/dir /b.js', /末尾に空白/], // 中間セグメントの末尾空白 (resolve が黙って落とす)
    ['src/a.js.', /末尾に空白かドット/],
    ['src/dir./b.js', /末尾に空白かドット/],
    ['src/a<b.js', /使えない文字/],
    ['src/a>b.js', /使えない文字/],
    ['src/a"b.js', /使えない文字/],
    ['src/a|b.js', /使えない文字/],
  ];
  for (const [path, pattern] of bad) {
    const r = describePathRule('Edit', path, cwd);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(path)}`);
    assert.match(r.reason, pattern, `理由が違う: ${JSON.stringify(path)}`);
    assert.equal(suggestPathRule('Edit', { file_path: path }, cwd), null,
      `承認候補に出てしまう: ${JSON.stringify(path)}`);
  }
  // 予約語を「含む」だけの普通の名前は通す (console.js を巻き添えにしない)
  assert.equal(describePathRule('Edit', 'src/console.js', cwd).ok, true);
  assert.equal(describePathRule('Edit', 'src/nullable.js', cwd).ok, true);
});
