import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';
import {
  TOOLS_CHOICES,
  addChannel,
  buildChannelEntry,
  checkCwdSafety,
  isUnsafeCwd,
  normalizeCwd,
  saveConfigAtomically,
  validateChannelName,
} from '../src/project.js';

const base = { guildId: '1', allowedUserIds: ['2'], channels: { sandbox: { cwd: 'C:/tmp' } } };

test('使えるチャンネル名', () => {
  for (const name of ['kumamikan', 'advisor', 'my-project', 'my_project', 'プロジェクト', 'a1']) {
    assert.deepEqual(validateChannelName(name, base), [], `弾かれる: ${name}`);
  }
});

test('Discord が変換してしまう表記は弾く (config と一致しなくなる)', () => {
  assert.ok(validateChannelName('MyProject', base).some((e) => e.includes('大文字')));
  assert.ok(validateChannelName('my project', base).some((e) => e.includes('空白')));
  assert.ok(validateChannelName('  padded  ', base).some((e) => e.includes('前後に空白')));
  assert.ok(validateChannelName('bad/name', base).length > 0);
  assert.ok(validateChannelName('with.dot', base).length > 0);
});

test('空・非文字列は弾く', () => {
  for (const name of ['', '   ', undefined, null, 42]) {
    assert.ok(validateChannelName(name, base).length > 0, `通ってしまう: ${String(name)}`);
  }
});

test('既存チャンネルとの重複を弾く', () => {
  const errors = validateChannelName('sandbox', base);
  assert.ok(errors.some((e) => e.includes('既にあります')));
  // config が空でも落ちない
  assert.deepEqual(validateChannelName('sandbox', {}), []);
  assert.deepEqual(validateChannelName('sandbox'), []);
});

test('cwd は config の書き方 (forward slash・絶対パス) に揃える', () => {
  assert.equal(normalizeCwd('C:\\Users\\me\\projects\\foo'), 'C:/Users/me/projects/foo');
  assert.equal(normalizeCwd('C:/Users/me/projects/foo'), 'C:/Users/me/projects/foo');
  // 貼り付けの引用符と前後空白を許容
  assert.equal(normalizeCwd('  "C:/Users/me/foo"  '), 'C:/Users/me/foo');
  // 末尾のスラッシュは落とす (ルートは残す)
  assert.equal(normalizeCwd('C:/Users/me/foo/'), 'C:/Users/me/foo');
  assert.equal(normalizeCwd('/'), '/');
});

test('cwd の空入力は null', () => {
  assert.equal(normalizeCwd(''), null);
  assert.equal(normalizeCwd('   '), null);
  assert.equal(normalizeCwd('""'), null);
  assert.equal(normalizeCwd(undefined), null);
  assert.equal(normalizeCwd(42), null);
});

const BRIDGE = 'C:/Users/me/projects/communitd';

test('ブリッジ本体とその祖先は cwd にできない (.env のトークンが読めるため)', () => {
  assert.equal(isUnsafeCwd(BRIDGE, BRIDGE), true);
  assert.equal(isUnsafeCwd('C:/Users/me/projects', BRIDGE), true);
  assert.equal(isUnsafeCwd('C:/Users/me', BRIDGE), true);
  assert.equal(isUnsafeCwd('C:/', BRIDGE), true);
  // 表記ゆれ (バックスラッシュ・末尾スラッシュ・大小文字) で抜けられない
  assert.equal(isUnsafeCwd('C:\\Users\\me\\projects', BRIDGE), true);
  assert.equal(isUnsafeCwd('C:/Users/me/projects/', BRIDGE), true);
  assert.equal(isUnsafeCwd('C:/USERS/ME/PROJECTS', BRIDGE), true);
  assert.equal(isUnsafeCwd(BRIDGE.toUpperCase(), BRIDGE), true);
});

test('ブリッジ直下の sandbox や無関係なディレクトリは cwd にできる', () => {
  assert.equal(isUnsafeCwd(`${BRIDGE}/sandbox`, BRIDGE), false);
  assert.equal(isUnsafeCwd(`${BRIDGE}/sandbox/deep`, BRIDGE), false);
  assert.equal(isUnsafeCwd('C:/Users/me/projects/kumamikan', BRIDGE), false);
  assert.equal(isUnsafeCwd('D:/other', BRIDGE), false);
  // 名前が前方一致するだけの別ディレクトリは祖先ではない
  assert.equal(isUnsafeCwd('C:/Users/me/projects/communitd-old', BRIDGE), false);
  assert.equal(isUnsafeCwd('C:/Users/meow', BRIDGE), false);
});

test('junction / シンボリックリンク経由でも、解決後のパスで判定される', () => {
  // CLI は realpath 済みのパスを渡す契約。link 表記のままなら素通りしうるが、
  // 解決後 (= ブリッジの親) を渡せば拒否される
  assert.equal(isUnsafeCwd('C:/link-to-projects', BRIDGE), false);
  assert.equal(isUnsafeCwd('C:/Users/me/projects', BRIDGE), true);
});

test('空・非文字列のパスは判定しない (呼び出し側で弾く)', () => {
  assert.equal(isUnsafeCwd('', BRIDGE), false);
  assert.equal(isUnsafeCwd(BRIDGE, ''), false);
  assert.equal(isUnsafeCwd(undefined, BRIDGE), false);
  assert.equal(isUnsafeCwd(BRIDGE, undefined), false);
});

/** メモリ上の fake fs (失敗と割り込みを差し込めるようにしてある) */
function memfs(initial = {}, faults = {}) {
  const files = new Map(Object.entries(initial));
  const fail = (op, path) => {
    const f = faults[op];
    if (f && (f === true || f === path)) throw new Error(`${op} が失敗しました`);
  };
  return {
    files,
    readFileSync(path) {
      fail('readFileSync', path);
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    writeFileSync(path, data, options) {
      fail('writeFileSync', path);
      // flag:'wx' = 既存なら失敗 (lock の取り合いを再現する)
      if (options?.flag === 'wx' && files.has(path)) {
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      }
      files.set(path, faults.truncate ? String(data).slice(0, 10) : data);
    },
    copyFileSync(from, to) {
      fail('copyFileSync', to);
      files.set(to, files.get(from));
      faults.duringBackup?.(files); // バックアップ中の割り込みを再現する
    },
    renameSync(from, to) {
      fail('renameSync', to);
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmSync(path) {
      files.delete(path);
    },
  };
}

// 書き換え先は policy だけ (secrets と合成後の config は保存しない)
const CONFIG_PATH = 'C:/bridge/config.policy.json';
const ORIGINAL = `${JSON.stringify(base, null, 2)}\n`;
const nextConfig = () => addChannel(base, 'newproj', buildChannelEntry({ cwd: 'C:/new' }));

/** 実ファイルを触らずに 1 回保存する (既定は pid 由来の suffix を固定値に) */
function save(fs, { originalRaw = ORIGINAL, config = nextConfig(), suffix = 'A', companions = [] } = {}) {
  return saveConfigAtomically({
    configPath: CONFIG_PATH,
    originalRaw,
    nextConfig: config,
    fs,
    uniqueSuffix: suffix,
    companions,
  });
}

// 書き換えない側 (add-project は secrets をこれで渡す)
const SECRETS_PATH = 'C:/bridge/config.secrets.json';
const SECRETS = '{\n  "guildId": "G1"\n}\n';
const withSecrets = [{ path: SECRETS_PATH, originalRaw: SECRETS }];

/** 一時ファイル・lock が残っていないこと */
function noLeftovers(fs, message = '') {
  const leftovers = [...fs.files.keys()].filter((p) => /\.(tmp-|lock)/.test(p));
  assert.deepEqual(leftovers, [], `残骸がある ${message}`);
}

test('保存: 一時ファイル経由で置き換え、バックアップを残す', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL });
  const result = save(fs);
  assert.equal(result.ok, true);
  assert.equal(result.backupPath, `${CONFIG_PATH}.bak`);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG_PATH)), nextConfig());
  assert.equal(fs.files.get(`${CONFIG_PATH}.bak`), ORIGINAL, 'バックアップが元の内容でない');
  noLeftovers(fs);
  assert.match(fs.files.get(CONFIG_PATH), /\n$/, '末尾に改行がない');
});

test('保存: 一時ファイル名はプロセスごとに固有 (他プロセスの書きかけを掴まない)', () => {
  const seen = [];
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL });
  const spy = { ...fs, writeFileSync(path, data, options) { seen.push(path); fs.writeFileSync(path, data, options); } };
  save(spy, { suffix: '1234' });
  assert.ok(seen.includes(`${CONFIG_PATH}.tmp-1234`), `固有名で書いていない: ${seen.join(', ')}`);
  assert.ok(!seen.includes(`${CONFIG_PATH}.tmp`), '固定名の一時ファイルを使っている');
});

test('保存: lock を取れなければ書かない (CLI の二重起動)', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL, [`${CONFIG_PATH}.lock`]: '9999\n' });
  const result = save(fs, { suffix: 'B' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked');
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL, 'lock 中なのに書いている');
  assert.equal(fs.files.get(`${CONFIG_PATH}.lock`), '9999\n', '他プロセスの lock を消している');
  assert.equal(fs.files.has(`${CONFIG_PATH}.tmp-B`), false);
});

test('保存: 二重起動でも後勝ちで先の追加を消さない', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL });
  // A が先に保存 (lock は解放される)
  const a = save(fs, { suffix: 'A', config: addChannel(base, 'from-a', { cwd: 'C:/a' }) });
  assert.equal(a.ok, true);
  // B は同じ「読み込み時の raw」を持ったまま後から保存しようとする
  const b = save(fs, { suffix: 'B', config: addChannel(base, 'from-b', { cwd: 'C:/b' }) });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'changed');
  const saved = JSON.parse(fs.files.get(CONFIG_PATH));
  assert.ok(saved.channels['from-a'], 'A の追加が消えている');
  assert.ok(!saved.channels['from-b'], 'B が後勝ちで上書きしている');
  noLeftovers(fs);
});

test('保存: 事前確認の後・差し替えの前に割り込まれたら中止する', () => {
  // lock を取らない手編集が、一時ファイルの検証中に入ってくる状況
  const intruder = `${ORIGINAL}\n// 手で足した行`;
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL });
  const read = fs.readFileSync.bind(fs);
  let reads = 0;
  fs.readFileSync = (path) => {
    reads++;
    // 1 = 事前確認 / 2 = 一時ファイルの読み戻し / 3 = 差し替え直前の再確認
    if (reads === 3) fs.files.set(CONFIG_PATH, intruder);
    return read(path);
  };

  const result = save(fs);
  assert.equal(reads >= 3, true, '差し替え直前に確認していない');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'changed');
  assert.equal(fs.files.get(CONFIG_PATH), intruder, '割り込んだ編集を消している');
  noLeftovers(fs);
});

test('保存: バックアップ作成中に割り込まれた編集も消さない', () => {
  const intruder = `${ORIGINAL}\n// バックアップ中に手で足した行`;
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL }, {
    duringBackup: (files) => files.set(CONFIG_PATH, intruder),
  });

  const result = save(fs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'changed');
  assert.equal(fs.files.get(CONFIG_PATH), intruder, 'バックアップ中の編集を上書きしている');
  noLeftovers(fs);
});

test('保存: 対話中に config.policy.json が変わっていたら上書きしない', () => {
  const edited = `${ORIGINAL}\n// 別の編集`;
  const fs = memfs({ [CONFIG_PATH]: edited });
  const result = save(fs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'changed');
  assert.equal(fs.files.get(CONFIG_PATH), edited, '別の編集を消している');
  assert.equal(fs.files.has(`${CONFIG_PATH}.bak`), false);
  noLeftovers(fs);
});

test('保存: 対話中に secrets が変わっていたら policy も書かない', () => {
  // 起動時検証も Discord の確認も合成後の config で行っている以上、対話中に guildId が
  // 変われば「別の Guild で確かめた結果」を根拠に policy を書くことになる (sol 指摘)
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL, [SECRETS_PATH]: '{\n  "guildId": "G2"\n}\n' });
  const result = save(fs, { companions: withSecrets });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'changed');
  assert.ok(result.message.includes('config.secrets.json'), result.message);
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL, 'secrets が変わったのに policy を書いている');
  assert.equal(fs.files.has(`${CONFIG_PATH}.bak`), false);
  noLeftovers(fs);
});

test('保存: バックアップ後に secrets が変わっても差し替えない', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL, [SECRETS_PATH]: SECRETS }, {
    duringBackup: (files) => files.set(SECRETS_PATH, '{\n  "guildId": "G-changed"\n}\n'),
  });
  const result = save(fs, { companions: withSecrets });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'changed');
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL, '差し替え直前の確認をしていない');
  noLeftovers(fs);
});

test('保存: secrets が同じなら書き換えずに policy だけ保存する', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL, [SECRETS_PATH]: SECRETS });
  const result = save(fs, { companions: withSecrets });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG_PATH)), nextConfig());
  assert.equal(fs.files.get(SECRETS_PATH), SECRETS, 'secrets を書き換えている');
  assert.equal(fs.files.has(`${SECRETS_PATH}.bak`), false, 'secrets のバックアップを作っている');
  noLeftovers(fs);
});

test('保存: secrets が消えていたら書かない (読めない側へ倒す)', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL });
  const result = save(fs, { companions: withSecrets });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'read-failed');
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL);
  noLeftovers(fs);
});

test('保存: 書き込み失敗でも元の config は無傷', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL }, { writeFileSync: `${CONFIG_PATH}.tmp-A` });
  const result = save(fs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-failed');
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL);
  noLeftovers(fs, '(壊れた一時ファイル)');
});

test('保存: 一時ファイルが途中までしか書けていなければ差し替えない', () => {
  const fs = memfs({ [CONFIG_PATH]: ORIGINAL }, { truncate: true });
  const result = save(fs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-failed');
  assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL, '途中まで書けた内容で上書きしている');
  noLeftovers(fs);
});

test('保存: バックアップ・置き換えに失敗しても元の config は無傷', () => {
  for (const faults of [{ copyFileSync: true }, { renameSync: true }]) {
    const fs = memfs({ [CONFIG_PATH]: ORIGINAL }, faults);
    const result = save(fs);
    assert.equal(result.ok, false, `失敗を返していない: ${JSON.stringify(faults)}`);
    assert.equal(fs.files.get(CONFIG_PATH), ORIGINAL, `元 config が壊れた: ${JSON.stringify(faults)}`);
    noLeftovers(fs, JSON.stringify(faults));
  }
});

test('保存: config.policy.json が読めなくなっていたら何もしない', () => {
  const fs = memfs({}, {});
  const result = save(fs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'read-failed');
  noLeftovers(fs, '(読めないのに何か書いている)');
  assert.equal(fs.files.has(CONFIG_PATH), false);
});

test('cwd の安全確認: realpath 解決後のパスで判定する', () => {
  // junction: 入力は無関係な名前でも、実体がブリッジの親なら拒否する
  const realpath = (p) => (p === 'C:/link' ? 'C:/Users/me/projects' : p);
  assert.deepEqual(checkCwdSafety('C:/link', BRIDGE, { realpath }), {
    ok: false,
    reason: 'inside-bridge',
  });
  assert.deepEqual(checkCwdSafety(`${BRIDGE}/sandbox`, BRIDGE, { realpath }), {
    ok: true,
    real: `${BRIDGE}/sandbox`,
  });
  // 解決結果はバックスラッシュでも正規化される
  assert.deepEqual(
    checkCwdSafety('X', BRIDGE, { realpath: () => 'C:\\Users\\me\\projects\\kumamikan' }),
    { ok: true, real: 'C:/Users/me/projects/kumamikan' },
  );
});

test('cwd の安全確認: realpath が失敗したら拒否する (fail-closed)', () => {
  const boom = () => { throw new Error('ELOOP: symlink が壊れています'); };
  assert.deepEqual(checkCwdSafety('C:/broken-link', BRIDGE, { realpath: boom }), {
    ok: false,
    reason: 'unresolvable',
  });
  // 解決結果が空・非文字列でも通さない
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(
      checkCwdSafety('C:/whatever', BRIDGE, { realpath: () => bad }),
      { ok: false, reason: 'unresolvable' },
      `通ってしまう: ${String(bad)}`,
    );
  }
});

test('エントリは既定で最小権限 (readonly)', () => {
  assert.deepEqual(buildChannelEntry({ cwd: 'C:/tmp' }), { cwd: 'C:/tmp', tools: 'readonly' });
  assert.deepEqual(buildChannelEntry({ cwd: 'C:/tmp', tools: 'standard' }), {
    cwd: 'C:/tmp',
    tools: 'standard',
  });
  // toolsExtra は指定したときだけ書く
  assert.deepEqual(buildChannelEntry({ cwd: 'C:/tmp', toolsExtra: [] }), {
    cwd: 'C:/tmp',
    tools: 'readonly',
  });
  assert.deepEqual(buildChannelEntry({ cwd: 'C:/tmp', toolsExtra: ['mcp__UnityMCP'] }), {
    cwd: 'C:/tmp',
    tools: 'readonly',
    toolsExtra: ['mcp__UnityMCP'],
  });
});

test('選べる tools は config.js のプリセットと同じ', () => {
  assert.deepEqual(TOOLS_CHOICES, ['readonly', 'standard', 'full']);
});

test('addChannel は既存を壊さず 1 件足す', () => {
  const entry = buildChannelEntry({ cwd: 'C:/new', tools: 'standard' });
  const next = addChannel(base, 'newproj', entry);
  assert.deepEqual(Object.keys(next.channels), ['sandbox', 'newproj']);
  assert.deepEqual(next.channels.sandbox, base.channels.sandbox);
  assert.deepEqual(next.channels.newproj, entry);
  assert.equal(next.guildId, base.guildId);
  // 元の config は変わらない
  assert.deepEqual(Object.keys(base.channels), ['sandbox']);
});

test('channels が無い config にも足せる', () => {
  const next = addChannel({ guildId: '1', allowedUserIds: ['2'] }, 'first', { cwd: 'C:/x' });
  assert.deepEqual(next.channels, { first: { cwd: 'C:/x' } });
});

test('追記後の config が起動時検証を通る (CLI が書く前に確かめる形)', () => {
  const next = addChannel(base, 'newproj', buildChannelEntry({ cwd: 'C:/new', tools: 'full' }));
  assert.deepEqual(validateConfig(next), []);

  // 不正な tools は起動時検証で落ちる = CLI も書き込まない
  const bad = addChannel(base, 'oops', { cwd: 'C:/new', tools: 'writable' });
  assert.ok(validateConfig(bad).some((e) => e.includes('tools')));
  // cwd が無いエントリも同様
  assert.ok(validateConfig(addChannel(base, 'oops', { tools: 'readonly' })).some((e) => e.includes('cwd')));
});
