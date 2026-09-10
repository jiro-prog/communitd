import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRANT_SCHEMA_VERSION } from '../src/grants.js';
import { ToolExtraStore, canonicalCwd } from '../src/toolstore.js';

function tempFile(name = 'tools-extra.json') {
  return join(mkdtempSync(join(tmpdir(), 'communitd-tools-')), name);
}

/** 実在する作業ディレクトリ (canonicalCwd は realpath を通す) */
function workspace() {
  return canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-cwd-')));
}

const CWD = workspace();
const OTHER_CWD = workspace();

const grant = (value, cwd = CWD) => ({ kind: 'web-domain', tool: 'WebFetch', value, cwd });

// ---- canonicalCwd ----

test('canonicalCwd は同じ場所を同じ文字列にする', () => {
  const root = mkdtempSync(join(tmpdir(), 'communitd-canon-'));
  const base = canonicalCwd(root);
  assert.equal(typeof base, 'string');
  assert.equal(base.includes('\\'), false, '区切りが正規化されていない');
  assert.equal(canonicalCwd(`${root}/`), base);
  assert.equal(canonicalCwd(root.replaceAll('\\', '/')), base);
});

test('canonicalCwd は解決できないものを null にする (fail-closed の材料)', () => {
  assert.equal(canonicalCwd(join(tmpdir(), 'communitd-does-not-exist-xyz')), null);
  assert.equal(canonicalCwd(''), null);
  assert.equal(canonicalCwd(null), null);
});

test('canonicalCwd はリンクを実体へ寄せる (別名で二重承認にならない)', () => {
  const real = mkdtempSync(join(tmpdir(), 'communitd-real-'));
  const linkParent = mkdtempSync(join(tmpdir(), 'communitd-link-'));
  const link = join(linkParent, 'alias');
  try {
    symlinkSync(real, link, 'junction');
  } catch {
    return;
  }
  assert.equal(canonicalCwd(link), canonicalCwd(real));
});

// ---- 基本 ----

test('承認を足すと読み直せる (原子的に書く / スキーマ版つき)', () => {
  const path = tempFile();
  const store = new ToolExtraStore(path);
  assert.deepEqual(store.rulesFor('sandbox', CWD), []);

  assert.equal(store.add('sandbox', { ...grant('a.example.com'), approvedBy: 'U1' }).added, true);
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
  assert.equal(existsSync(`${path}.tmp`), false, '一時ファイルが残っている');

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.version, GRANT_SCHEMA_VERSION);
  assert.equal(raw.channels.sandbox[0].kind, 'web-domain');
  assert.equal(raw.channels.sandbox[0].value, 'a.example.com', '保存値がルール文字列になっている');
  assert.equal(raw.channels.sandbox[0].cwd, CWD, '保存された cwd が正規形でない');

  // 別インスタンス = 再起動後の読み込み
  assert.deepEqual(new ToolExtraStore(path).rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
});

test('同じ grant は二重に積まない', () => {
  const store = new ToolExtraStore(tempFile());
  assert.equal(store.add('sandbox', grant('a.example.com')).added, true);
  assert.equal(store.add('sandbox', grant('a.example.com')).added, false);
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
  assert.equal(store.has('sandbox', grant('a.example.com')), true);
  assert.equal(store.has('sandbox', grant('b.example.com')), false);
});

test('チャンネルごとに分かれている (別チャンネルへ漏れない)', () => {
  const store = new ToolExtraStore(tempFile());
  store.add('sandbox', grant('a.example.com'));
  assert.deepEqual(store.rulesFor('kumamikan', CWD), []);
});

// ---- cwd 束縛 ----

test('cwd を向け替えたチャンネルでは過去の承認が効かない', () => {
  const store = new ToolExtraStore(tempFile());
  store.add('sandbox', grant('a.example.com'));
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
  assert.deepEqual(store.rulesFor('sandbox', OTHER_CWD), [],
    '別プロジェクトへ承認が移っている');
  assert.equal(store.has('sandbox', grant('a.example.com', OTHER_CWD)), false);
});

test('同じチャンネル名でも cwd ごとに別々に積める', () => {
  const store = new ToolExtraStore(tempFile());
  store.add('sandbox', grant('a.example.com'));
  store.add('sandbox', grant('b.example.com', OTHER_CWD));
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
  assert.deepEqual(store.rulesFor('sandbox', OTHER_CWD), ['WebFetch(domain:b.example.com)']);
});

test('cwd が分からなければ何も返さない (照合できない承認は使わない)', () => {
  const store = new ToolExtraStore(tempFile());
  store.add('sandbox', grant('a.example.com'));
  for (const cwd of [null, undefined, '']) {
    assert.deepEqual(store.rulesFor('sandbox', cwd), [], `返してはいけない: ${JSON.stringify(cwd)}`);
  }
});

// ---- 検証を通らない grant ----

test('妥当でない grant は「保存できない」と返す (「既にある」と混ぜない)', () => {
  const store = new ToolExtraStore(tempFile());
  const cases = [
    { ...grant('a.example.com'), kind: 'path-exact' },
    grant('localhost'),
    { rule: 'WebFetch(domain:a.example.com)', cwd: CWD },                // 旧形式
    { kind: 'shell-exact', tool: 'Bash', value: 'npm ci', cwd: CWD },    // かつての shell 許可
    grant('a.example.com', CWD.replaceAll('/', '\\')),                   // 非正規形の cwd
  ];
  for (const bad of cases) {
    const r = store.add('sandbox', bad);
    assert.equal(r.ok, false, `保存してはいけない: ${JSON.stringify(bad)}`);
    assert.equal(typeof r.reason, 'string');
  }
  assert.equal(store.add('', grant('a.example.com')).ok, false);
  assert.deepEqual(store.rulesFor('sandbox', CWD), []);
});

test('「既にある」と「保存できない」は戻り値で区別できる', () => {
  // 呼び出し側はこの区別で「承認済みにしてよいか」を決める。
  // 同じ値で返すと、保存ゼロなのに「承認しました」と表示できてしまう
  const store = new ToolExtraStore(tempFile());
  assert.deepEqual(store.add('sandbox', grant('a.example.com')), { ok: true, added: true });
  assert.deepEqual(store.add('sandbox', grant('a.example.com')), { ok: true, added: false });
  assert.equal(store.add('sandbox', grant('localhost')).ok, false);
});

test('読み込み時にも検証する (後から厳しくした条件で弾ける)', () => {
  const path = tempFile();
  writeFileSync(path, JSON.stringify({
    version: GRANT_SCHEMA_VERSION,
    channels: {
      sandbox: [
        grant('a.example.com'),
        { ...grant('localhost') },                                // ホストを特定できない
        { ...grant('b.example.com'), extra: 'x' },                 // 余分なキー
        { kind: 'tool', tool: 'Edit', value: 'Edit', cwd: CWD },   // かつてのパス許可
        { kind: 'shell-exact', tool: 'Bash', value: 'npm ci', cwd: CWD }, // かつての shell 許可
        { ...grant('c.example.com'), cwd: CWD.replaceAll('/', '\\') },    // 非正規形の cwd
        'Bash(legacy-string)',
        null,
      ],
    },
  }));
  assert.deepEqual(new ToolExtraStore(path).rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
});

// ---- スキーマ版 ----

test('旧形式・未知のスキーマ版は読まない (fail-closed)', () => {
  for (const content of [
    JSON.stringify({ sandbox: [{ rule: 'WebFetch(domain:a.example.com)', cwd: CWD }] }), // version なし = 旧形式
    JSON.stringify({ version: 99, channels: { sandbox: [grant('a.example.com')] } }),
    JSON.stringify({ version: GRANT_SCHEMA_VERSION, channels: 'x' }),
    '[]', 'null', '"x"',
  ]) {
    const path = tempFile();
    writeFileSync(path, content);
    assert.deepEqual(new ToolExtraStore(path).rulesFor('sandbox', CWD), [],
      `読んではいけない: ${content.slice(0, 40)}`);
  }
});

test('壊れた JSON は退避して空から始める', () => {
  const path = tempFile();
  writeFileSync(path, '{ broken');
  assert.deepEqual(new ToolExtraStore(path).rulesFor('sandbox', CWD), []);
  const backups = readdirSync(join(path, '..')).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1, '壊れたファイルを痕跡なく捨てている');
});

// ---- 特殊なチャンネル名 ----

test('__proto__ のようなチャンネル名でも保存成功を偽装しない', () => {
  // 素のブラケット代入は Object の特殊 setter を踏み、メモリ上は許可済みに見えるのに
  // JSON には書かれない = 再起動で消える「保存成功の偽装」になる
  const path = tempFile();
  const store = new ToolExtraStore(path);

  let added = false;
  try {
    added = store.add('__proto__', grant('a.example.com')).added === true;
  } catch {
    added = false; // 保存できないと分かって throw するのも正しい振る舞い
  }

  const onDisk = new ToolExtraStore(path).rulesFor('__proto__', CWD);
  assert.deepEqual(store.rulesFor('__proto__', CWD), onDisk,
    'メモリとディスクで許可が食い違っている (保存成功を偽装している)');
  if (added) {
    assert.deepEqual(onDisk, ['WebFetch(domain:a.example.com)'], '足したと言ったのに保存されていない');
  }
  // prototype は汚染されない
  assert.equal({}.a, undefined);
  assert.equal(Array.isArray(Object.prototype), false);
});

test('constructor / toString のような名前でも普通に往復する', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const path = tempFile();
    const store = new ToolExtraStore(path);
    assert.equal(store.add(name, grant('a.example.com')).added, true, `保存できていない: ${name}`);
    assert.deepEqual(store.rulesFor(name, CWD), ['WebFetch(domain:a.example.com)']);
    assert.deepEqual(new ToolExtraStore(path).rulesFor(name, CWD),
      ['WebFetch(domain:a.example.com)'], `再読込で消えている: ${name}`);
    // 別チャンネルへ漏れない (prototype 経由で拾っていない)
    assert.deepEqual(store.rulesFor('sandbox', CWD), []);
  }
});

test('チャンネル名が文字列でなければ保存しない', () => {
  const store = new ToolExtraStore(tempFile());
  for (const name of ['', null, undefined, 42, {}]) {
    assert.equal(store.add(name, grant('a.example.com')).ok, false,
      `保存してはいけない: ${JSON.stringify(name)}`);
  }
});

test('ファイル側に __proto__ が入っていても prototype から拾わない', () => {
  const path = tempFile();
  writeFileSync(path, JSON.stringify({
    version: GRANT_SCHEMA_VERSION,
    channels: { __proto__: [grant('a.example.com')], sandbox: [grant('b.example.com')] },
  }));
  const store = new ToolExtraStore(path);
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:b.example.com)']);
  // 未登録チャンネルが prototype 経由で許可を拾わない
  assert.deepEqual(store.rulesFor('kumamikan', CWD), []);
  assert.equal({}.a, undefined);
});

// ---- 保存失敗 ----

test('保存に失敗したらメモリも変わらない (許可がディスクとズレない)', () => {
  const path = tempFile();
  const store = new ToolExtraStore(path);
  store.add('sandbox', grant('a.example.com'));

  store.persist = () => { throw new Error('EACCES: permission denied'); };

  assert.throws(() => store.add('sandbox', grant('b.example.com')), /EACCES/);
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)'], 'メモリだけ許可が増えている');
  assert.deepEqual(new ToolExtraStore(path).rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
});

test('保存に失敗しても既存の状態は壊れない (新しいチャンネルでも)', () => {
  const store = new ToolExtraStore(tempFile());
  store.add('sandbox', grant('a.example.com'));
  store.persist = () => { throw new Error('ENOSPC'); };

  assert.throws(() => store.add('kumamikan', grant('a.example.com')), /ENOSPC/);
  assert.deepEqual(store.rulesFor('kumamikan', CWD), [], '書けていないチャンネルが生えている');
  assert.deepEqual(store.rulesFor('sandbox', CWD), ['WebFetch(domain:a.example.com)']);
});
