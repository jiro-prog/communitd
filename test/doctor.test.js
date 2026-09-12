import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from '../src/config.js';
import { diagnose, formatDiagnosis } from '../src/doctor.js';
import { classifySocietySnapshot, emptySnapshot } from '../src/society-store.js';

const T0 = Date.parse('2026-09-07T09:00:00.000Z');

const ROOT = 'C:/bridge';
const ROLE = '<!-- communitd-protocol: 2 -->\n# role';

function harness(over = {}) {
  const files = {
    [`${ROOT}/roles/_common.md`]: ROLE,
    [`${ROOT}/roles/fable.md`]: ROLE,
    [`${ROOT}/roles/opus.md`]: ROLE,
    'C:/work/kt/.communitd/direction.md': '# direction',
    ...(over.files ?? {}),
  };
  for (const key of over.missingFiles ?? []) delete files[key];
  const config = over.config ?? {
    guildId: 'G', allowedUserIds: ['U'], ownerUserId: 'U', claudeBin: 'claude',
    bots: {
      fable: { tokenEnv: 'FABLE_TOKEN', rolePromptFile: 'roles/fable.md' },
      opus: { tokenEnv: 'OPUS_TOKEN', rolePromptFile: 'roles/opus.md' },
    },
    channels: {
      kt: {
        cwd: 'C:/work/kt', hooks: true, verify: 'npm test',
        autonomy: { enabled: true, baseBranch: 'master', worker: { bots: ['opus'] }, reviewer: 'fable', directionFile: '.communitd/direction.md' },
      },
      chat: { cwd: 'C:/work/chat' },
    },
  };
  return diagnose({
    root: ROOT,
    config,
    configErrors: over.configErrors ?? [],
    env: over.env ?? { FABLE_TOKEN: 'x', OPUS_TOKEN: 'y' },
    // CLI の解決は platform で分岐する。既定を固定しないと、テストが走る OS で
    // 判定が変わる (Windows だけ .cmd シムの読み替えが入る)
    platform: over.platform ?? 'linux',
    fs: {
      // path.join は**実機**の区切りを使うので、照合の側で / に揃える
      exists: (p) => Object.hasOwn(files, String(p).replaceAll('\\', '/')),
      realpath: (p) => { if ((over.missingDirs ?? []).includes(p)) throw new Error('ENOENT'); return p; },
      // 実物 (scripts/doctor.mjs の readFileSync) と同じく errno の code を載せる —
      // doctor は「無い (ENOENT)」と「読めない (EACCES 等)」を code で分ける (§12.3 (1))
      readFile: (raw) => {
        const p = String(raw).replaceAll('\\', '/'); // exists と同じく / に揃える
        if (Object.hasOwn(over.unreadable ?? {}, p)) {
          const err = new Error(`${over.unreadable[p]}: permission denied, open '${p}'`);
          err.code = over.unreadable[p];
          throw err;
        }
        if (!Object.hasOwn(files, p)) {
          const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return files[p];
      },
      canWrite: () => over.writable ?? true,
      // 社会台帳の隣の `.tmp.*` を数えるためだけ (実物は scripts/doctor.mjs の readdirSync)
      ...(over.list === undefined ? {} : { list: () => over.list }),
    },
    git: {
      isRepo: (cwd) => (over.notRepo ?? []).includes(cwd) ? false : true,
      isIgnored: () => over.ignored ?? true,
      branchExists: () => over.branch ?? true,
    },
    // over.cli を渡すと版の引き方 (どの語で呼ばれたか) まで観察できる
    cli: over.cli ?? { version: (bin) => (over.noCli ?? []).includes(bin) ? null : `${bin} 2.1.220` },
    dataFiles: over.dataFiles ?? [],
  });
}

const levels = (out, scope) => out.findings.filter((f) => f.scope === scope).map((f) => f.level);

test('全部そろっていれば ok で、fail が無い', () => {
  const out = harness();
  assert.equal(out.ok, true, JSON.stringify(out.findings.filter((f) => f.level !== 'ok')));
  assert.ok(out.findings.some((f) => f.scope === 'cli' && /claude --version/.test(f.message)));
  assert.ok(out.findings.some((f) => f.scope === 'channels.kt' && /\.worktrees\/ は Git の無視対象/.test(f.message)));
  assert.ok(out.findings.some((f) => f.scope === 'channels.kt' && /自動復旧は observe/.test(f.message)));
  assert.ok(out.findings.some((f) => f.scope === 'discord' && /診断では行わない/.test(f.message)));
  const text = formatDiagnosis(out);
  assert.match(text, /^✅ \[config\]/);
  assert.match(text, /診断: 起動できる見込み/);
});

test('config が通らなければそこで止まり、エラーをそのまま並べる', () => {
  const out = harness({ configErrors: ['guildId が未設定', 'channels.kt.cwd が無い'], config: null });
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f) => f.message), ['guildId が未設定', 'channels.kt.cwd が無い']);
  assert.match(formatDiagnosis(out), /診断: ❌ 2 件/);
});

test('validateConfig が落とす設定は doctor でも ❌ になる (必須キーの欠落)', () => {
  // doctor は configErrors をそのまま並べるので、検証を足したぶんは自動で ❌ になる。
  // その配線を実際に validateConfig を通して固定する (起動前に気付ける経路)
  const config = {
    guildId: 'G', allowedUserIds: ['U'],
    bots: { w: { tokenEnv: 'T', displayName: 'D', rolePromptFile: 'roles/worker.md' } }, // model 欠落
    channels: {},
  };
  const configErrors = validateConfig(config);
  assert.equal(configErrors.length, 1, configErrors.join(' / '));
  const out = harness({ config: null, configErrors });
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f) => f.level), ['fail']);
  assert.match(out.findings[0].message, /bots\.w\.model が要る/);
  assert.match(formatDiagnosis(out), /診断: ❌ 1 件/);
});

test('設定例のまま残っている ID と cwd は ❌ (検証は通ってしまうので doctor で止める)', () => {
  // `000000000000000000` も `C:/path/to/your/project` も「非空の文字列」なので
  // validateConfig は通す。そのまま起動すると、スラッシュコマンドは Missing Access で
  // 落ち、メンションは全部拒否される — 理由はログから読めない (実地の導入で起きた)
  const example = {
    guildId: '000000000000000000',
    allowedUserIds: ['000000000000000000'],
    ownerUserId: '000000000000000000',
    claudeBin: 'claude',
    bots: {
      fable: {
        tokenEnv: 'FABLE_TOKEN', displayName: 'Fable', model: 'opus', rolePromptFile: 'roles/fable.md',
      },
    },
    channels: { 'my-project': { cwd: 'C:/path/to/your/project' } },
  };
  assert.deepEqual(validateConfig(example), [], '前提: 設定例のままでも検証は通る');

  const out = harness({ config: example, env: { FABLE_TOKEN: 'x' } });
  assert.equal(out.ok, false);
  const fails = out.findings.filter((f) => f.level === 'fail').map((f) => f.message);
  assert.equal(fails.length, 4, fails.join(' / '));
  assert.ok(fails.some((m) => /^guildId が設定例のまま \(000000000000000000\)/.test(m)), fails.join(' / '));
  assert.ok(fails.some((m) => /^allowedUserIds が設定例のまま/.test(m)), fails.join(' / '));
  assert.ok(fails.some((m) => /^ownerUserId が設定例のまま/.test(m)), fails.join(' / '));
  // cwd は「解決できません」ではなく「例のまま」と言う (直し方が違う)
  const cwd = out.findings.find((f) => f.scope === 'channels.my-project');
  assert.equal(cwd.level, 'fail');
  assert.match(cwd.message, /^cwd が設定例のまま \(C:\/path\/to\/your\/project\)/);
  assert.equal(/解決できません/.test(cwd.message), false);

  // 実際の値を書いてあれば何も言わない (0 が並ぶだけの別の ID を誤検知しない)
  const real = harness({
    config: {
      ...example, guildId: '123456789012345678', allowedUserIds: ['1010'], ownerUserId: '1010',
      channels: { 'my-project': { cwd: 'C:/work/kt' } },
    },
    env: { FABLE_TOKEN: 'x' },
  });
  assert.deepEqual(real.findings.filter((f) => f.level === 'fail'), []);
});

test('トークンは有無だけ見て値を出さない。未設定は fail', () => {
  const out = harness({ env: { FABLE_TOKEN: 'super-secret-token-value' } });
  const fable = out.findings.find((f) => f.scope === 'bots.fable' && /FABLE_TOKEN/.test(f.message));
  assert.equal(fable.level, 'ok');
  assert.ok(!/super-secret/.test(JSON.stringify(out.findings)), 'トークンの値が出ている');
  const opus = out.findings.find((f) => f.scope === 'bots.opus' && /OPUS_TOKEN/.test(f.message));
  assert.equal(opus.level, 'fail');
  assert.equal(out.ok, false);
});

test('役割文のプロトコル版・CLI・cwd・Git・.worktrees・基点ブランチ・data/ の失敗を拾う', () => {
  const stale = harness({ files: { [`${ROOT}/roles/opus.md`]: '<!-- communitd-protocol: 1 -->' } });
  assert.ok(stale.findings.some((f) => f.scope === 'bots.opus' && f.level === 'fail' && /プロトコル版 1/.test(f.message)));

  const noCli = harness({ noCli: ['claude'] });
  assert.ok(noCli.findings.some((f) => f.scope === 'cli' && f.level === 'fail'));

  const missing = harness({ missingDirs: ['C:/work/chat'] });
  assert.ok(missing.findings.some((f) => f.scope === 'channels.chat' && f.level === 'fail' && /解決できません/.test(f.message)));

  const notRepo = harness({ notRepo: ['C:/work/kt', 'C:/work/chat'] });
  assert.deepEqual(levels(notRepo, 'channels.kt').filter((l) => l === 'fail'), ['fail'], '自律運転のチャンネルは Git 必須');
  assert.ok(notRepo.findings.some((f) => f.scope === 'channels.chat' && f.level === 'warn'));

  const notIgnored = harness({ ignored: false });
  assert.ok(notIgnored.findings.some((f) => f.scope === 'channels.kt' && f.level === 'fail' && /\.gitignore に無い/.test(f.message)));

  const noBranch = harness({ branch: false });
  assert.ok(noBranch.findings.some((f) => f.scope === 'channels.kt' && f.level === 'fail' && /基点ブランチ master/.test(f.message)));

  const noDirection = harness({ missingFiles: ['C:/work/kt/.communitd/direction.md'] });
  assert.ok(noDirection.findings.some((f) => f.scope === 'channels.kt' && f.level === 'warn' && /方向性ドキュメント/.test(f.message)));

  const readonly = harness({ writable: false });
  assert.ok(readonly.findings.some((f) => f.scope === 'data' && f.level === 'fail'));
});

test('cwd がブリッジ自身や祖先なら warn (.env が読める — 開発チャンネルの意図的な配備は止めない)', () => {
  const out = harness({
    config: {
      guildId: 'G', allowedUserIds: ['U'], bots: {},
      channels: { self: { cwd: ROOT }, parent: { cwd: 'C:/' }, child: { cwd: `${ROOT}/sandbox` } },
    },
  });
  assert.equal(out.findings.find((f) => f.scope === 'channels.self').level, 'warn');
  assert.match(out.findings.find((f) => f.scope === 'channels.self').message, /ブリッジ自身か、その祖先/);
  assert.equal(out.findings.find((f) => f.scope === 'channels.parent').level, 'warn');
  assert.ok(out.findings.some((f) => f.scope === 'channels.child' && f.level === 'ok'));
  assert.equal(out.ok, true);
  assert.ok(out.findings.some((f) => f.scope === 'config' && f.level === 'warn' && /ownerUserId/.test(f.message)));
});

test('data/ の壊れた JSON は fail (自律起動が止まる、と書く)。無いファイルは何も言わない', () => {
  const out = harness({
    files: { [`${ROOT}/data/job-runs.json`]: '{ broken', [`${ROOT}/data/tasks.json`]: '{}' },
    dataFiles: [`${ROOT}/data/job-runs.json`, `${ROOT}/data/tasks.json`, `${ROOT}/data/nope.json`],
  });
  const fails = out.findings.filter((f) => f.scope === 'data' && f.level === 'fail');
  assert.equal(fails.length, 1);
  assert.match(fails[0].message, /data\/job-runs\.json が JSON として読めない/);
  // 2026-09-07 (§12.3 (1)) から退避しない = 直さないかぎり自律起動は止まったまま
  assert.match(fails[0].message, /自律起動が止まる \(fail-closed\)。直すか手で退避する/);
  assert.equal(/退避されて空から始まる/.test(fails[0].message), false);
  assert.equal(out.ok, false, '壊れた data のまま起動できることにしている');
});

test('data/ の読取エラー (EACCES 等) は不在と区別して fail (Opus2 Major2)', () => {
  const out = harness({
    // 実在するが読めない台帳: ランタイムでは broken = 自律起動が止まる
    unreadable: { [`${ROOT}/data/pause.json`]: 'EACCES' },
    dataFiles: [`${ROOT}/data/pause.json`, `${ROOT}/data/nope.json`],
  });
  const fails = out.findings.filter((f) => f.scope === 'data' && f.level === 'fail');
  assert.equal(fails.length, 1, JSON.stringify(out.findings.filter((f) => f.scope === 'data')));
  assert.match(fails[0].message, /data\/pause\.json を読めない \(EACCES\)/);
  assert.match(fails[0].message, /自律起動が止まる \(fail-closed\)/);
  assert.equal(out.ok, false);
  // 無いファイル (ENOENT) は従来どおり何も言わない
  assert.equal(out.findings.some((f) => f.scope === 'data' && /nope\.json/.test(f.message)), false);
});

// Opus2 レビュー 2026-09-07 Minor1: 門でない台帳 (sessions / contracts / inbox / roster) は
// 自律起動を止めない — 診断も src/index.js と同じ分け方で書く
test('data/ の壊れた JSON でも門でない台帳は「自律起動は止まらない」と書く (fail のまま)', () => {
  const out = harness({
    files: { [`${ROOT}/data/sessions.json`]: '[]', [`${ROOT}/data/pause.json`]: '{ broken' },
    dataFiles: [`${ROOT}/data/sessions.json`, `${ROOT}/data/pause.json`],
  });
  const fails = out.findings.filter((f) => f.scope === 'data' && f.level === 'fail');
  assert.equal(fails.length, 2);
  const sessions = fails.find((f) => /sessions\.json/.test(f.message));
  const pause = fails.find((f) => /pause\.json/.test(f.message));
  assert.match(sessions.message, /自律起動は止まらないが、その台帳への書き込みは断られる/);
  assert.match(pause.message, /自律起動が止まる \(fail-closed\)/);
  assert.equal(out.ok, false);
});

test('codex ランタイムの bot が居れば codex CLI も見る', () => {
  const out = harness({
    config: {
      guildId: 'G', allowedUserIds: ['U'], codexCmd: ['codex'],
      bots: { sol: { tokenEnv: 'SOL_TOKEN', runtime: 'codex', rolePromptFile: 'roles/fable.md' } },
      channels: {},
    },
    env: { SOL_TOKEN: 'x' },
    noCli: ['codex'],
  });
  assert.ok(out.findings.some((f) => f.scope === 'cli' && f.level === 'fail' && /codex/.test(f.message)));
  assert.ok(!out.findings.some((f) => f.scope === 'cli' && /claude --version/.test(f.message)), 'claude bot が居ないのに claude を見ている');
});

test('codexCmd が多語なら全語で版を引く (先頭の node の版を codex の版として報告しない)', () => {
  // Windows の npm グローバルは .cmd シムなので ["node", "…/codex.js"] と書くことになる。
  // 先頭だけ渡すと `node --version` の結果が「codex は ok」として並んでしまう
  const calls = [];
  const out = harness({
    config: {
      guildId: 'G', allowedUserIds: ['U'], codexCmd: ['node', 'C:/npm/codex.js'],
      bots: { sol: { tokenEnv: 'SOL_TOKEN', runtime: 'codex', rolePromptFile: 'roles/fable.md' } },
      channels: {},
    },
    env: { SOL_TOKEN: 'x' },
    cli: { version: (bin, args = []) => { calls.push([bin, ...args]); return 'codex-cli 0.9.0'; } },
  });
  assert.deepEqual(calls, [['node', 'C:/npm/codex.js']]);
  const cli = out.findings.find((f) => f.scope === 'cli');
  assert.match(cli.message, /node C:\/npm\/codex\.js --version/);
  assert.equal(cli.level, 'ok');
});

test('doctor は実行系と同じ解決をする (シムしか辿れない Windows で緑にならない)', () => {
  // 以前は doctor だけ shell 経由で PATH のシムを引いていたので、
  // 「doctor は ✅ なのに全 job が起動できない」配置ができていた
  const out = harness({
    platform: 'win32',
    env: { FABLE_TOKEN: 'x', OPUS_TOKEN: 'y', PATH: 'C:/pnpm' },
    files: { 'C:/pnpm/claude.cmd': '' }, // シムはあるが実体を辿れない
    cli: { version: () => 'claude 2.1.220' }, // shell 経由なら通ってしまう状況を模す
  });
  const cli = out.findings.find((f) => f.scope === 'cli');
  assert.equal(cli.level, 'fail');
  assert.match(cli.message, /claudeBin/, '直し方 (claudeBin) を書かないと原因に辿り着けない');
  assert.equal(out.ok, false);
});

test('Windows でも実体まで辿れれば ok (シムを読んで解決し、全語で版を引く)', () => {
  const entry = 'C:/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const calls = [];
  const out = harness({
    platform: 'win32',
    env: { FABLE_TOKEN: 'x', OPUS_TOKEN: 'y', PATH: 'C:/npm' },
    files: {
      'C:/npm/claude.cmd': 'title %COMSPEC% & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
      [entry]: '',
    },
    cli: { version: (bin, args = []) => { calls.push([bin, ...args]); return 'claude 2.1.220'; } },
  });
  assert.deepEqual(calls.map((c) => c.map((s) => s.replaceAll('\\', '/'))), [[entry]],
    'シムの中身から実体を引けていない');
  const cli = out.findings.find((f) => f.scope === 'cli');
  assert.equal(cli.level, 'ok');
});

test('見つからない側の findings にも「なぜ見に行ったか」を残す', () => {
  // codex を探した理由 (runtime: "codex" の bot が居る) が消えると、
  // codex を使っていないつもりの人が ❌ の意味を追えない
  const out = harness({
    platform: 'win32',
    config: {
      guildId: 'G', allowedUserIds: ['U'], claudeBin: 'C:/bin/claude.exe',
      bots: { sol: { tokenEnv: 'SOL_TOKEN', runtime: 'codex', rolePromptFile: 'roles/fable.md' } },
      channels: {},
    },
    env: { SOL_TOKEN: 'x', PATH: 'C:/bin' },
    files: { 'C:/bin/claude.exe': '' },
  });
  const cli = out.findings.find((f) => f.scope === 'cli');
  assert.equal(cli.level, 'fail');
  assert.match(cli.message, /runtime: "codex" の bot が居ます/);
  assert.match(cli.message, /codexCmd/);
  // 前置きが二重にならない (「codex が見つかりません — PATH に codex が見つかりません」)
  assert.equal(/見つかりません.*見つかりません/.test(cli.message), false, cli.message);
});

test('codex を起動できないときは codexCmd の設定を案内する', () => {
  const out = harness({
    config: {
      guildId: 'G', allowedUserIds: ['U'],
      bots: { sol: { tokenEnv: 'SOL_TOKEN', runtime: 'codex', rolePromptFile: 'roles/fable.md' } },
      channels: {},
    },
    env: { SOL_TOKEN: 'x' },
    noCli: ['codex'],
  });
  const cli = out.findings.find((f) => f.scope === 'cli');
  assert.equal(cli.level, 'fail');
  assert.match(cli.message, /codexCmd/, '直し方 (codexCmd) を書かないと原因に辿り着けない');
});

// ---- 社会台帳 (docs/society-ledger.md §1・S2-1) ----
// **他の台帳と唯一違うのは「不在」の意味**。既存は不在 = 初回だが、society は
// observe / active で不在なら起動停止 (初回と推測しない)。

const SOCIETY = `${ROOT}/data/society.json`;
const societyConfig = (society) => ({
  guildId: 'G', allowedUserIds: ['U'], ownerUserId: 'U', claudeBin: 'claude',
  bots: { fable: { tokenEnv: 'FABLE_TOKEN', rolePromptFile: 'roles/fable.md' } },
  channels: { chat: { cwd: 'C:/work/chat' } },
  ...(society ? { society } : {}),
});
const dataFindings = (out) => out.findings.filter((f) => f.scope === 'data');

test('doctor: society.json が無くても off なら fail にしない', () => {
  const out = harness({ config: societyConfig(null), dataFiles: [SOCIETY] });
  assert.deepEqual(dataFindings(out).filter((f) => f.level === 'fail'), []);
  assert.ok(dataFindings(out).some((f) => /society\.json は無いが society\.mode は off/.test(f.message)));
  assert.equal(out.ok, true);
});

test('doctor: observe / active で society.json が無ければ fail (初回と推測しない)', () => {
  for (const mode of ['observe', 'active']) {
    const out = harness({ config: societyConfig({ mode }), dataFiles: [SOCIETY] });
    const fails = dataFindings(out).filter((f) => f.level === 'fail');
    assert.equal(fails.length, 1, `${mode}: ${JSON.stringify(dataFindings(out))}`);
    assert.match(fails[0].message, /data\/society\.json が無い/);
    assert.match(fails[0].message, new RegExp(`society\\.mode が ${mode}`));
    assert.match(fails[0].message, /不在を初回と推測しない/);
    assert.match(fails[0].message, /society-init/);
    assert.equal(out.ok, false);
  }
});

test('doctor: 破損の分類はランタイムと一致する (診断が ✅ なのに起動で止まる、を作らない)', () => {
  // Opus2 S2-1 レビュー ①: 未知 schema・revision 不正・コレクション欠落は
  // JSON.parse だけ見る診断を素通りしていた
  const cases = [
    ['syntax-error', '{ broken'],
    ['shape-error', '[]'],
    ['unknown-schema', JSON.stringify({ ...emptySnapshot(T0), schema: 'society/2' })],
    ['bad-revision', JSON.stringify({ ...emptySnapshot(T0), revision: '3' })],
    ['shape-error', JSON.stringify({ schema: 'society/1', revision: 0 })], // コレクション欠落
  ];
  for (const [kind, text] of cases) {
    // ランタイム側の分類 (SocietyStore が使うのと同じ関数)
    assert.equal(classifySocietySnapshot(text).broken.kind, kind, text.slice(0, 40));
    const out = harness({
      config: societyConfig({ mode: 'observe' }), files: { [SOCIETY]: text }, dataFiles: [SOCIETY],
    });
    const fails = dataFindings(out).filter((f) => f.level === 'fail');
    assert.equal(fails.length, 1, `${kind}: ${JSON.stringify(dataFindings(out))}`);
    assert.match(fails[0].message, /society\.json は台帳として読めない/);
    assert.match(fails[0].message, new RegExp(kind));
    assert.equal(out.ok, false);
  }
  // 正しい台帳 (空のスナップショット) は何も言わない
  const healthy = harness({
    config: societyConfig({ mode: 'observe' }),
    files: { [SOCIETY]: JSON.stringify(emptySnapshot(T0)) },
    dataFiles: [SOCIETY],
  });
  assert.deepEqual(dataFindings(healthy).filter((f) => f.level !== 'ok'), []);
});

test('doctor: society.json の破損と読取エラーは mode で重さが変わる', () => {
  // off なら実害が無いので warn (observe にする前に直す、と書く)
  const off = harness({ config: societyConfig(null), files: { [SOCIETY]: '{ broken' }, dataFiles: [SOCIETY] });
  const warns = dataFindings(off).filter((f) => f.level === 'warn');
  assert.ok(warns.some((f) => /society\.json は台帳として読めない/.test(f.message)), JSON.stringify(dataFindings(off)));
  assert.equal(off.ok, true);

  const unreadable = harness({
    config: societyConfig({ mode: 'active' }),
    unreadable: { [SOCIETY]: 'EACCES' },
    dataFiles: [SOCIETY],
  });
  const fails = dataFindings(unreadable).filter((f) => f.level === 'fail');
  assert.match(fails[0].message, /society\.json を読めない \(EACCES\)/);
  assert.match(fails[0].message, /社会由来の処理は止まる/);
});

test('doctor: society.json の隣の .tmp.* は off で warn / observe で fail', () => {
  const leftovers = ['society.json', 'society.json.tmp.4242.deadbeef', 'pause.json'];
  const observe = harness({
    config: societyConfig({ mode: 'observe' }),
    files: { [SOCIETY]: JSON.stringify(emptySnapshot(T0)) },
    dataFiles: [SOCIETY], list: leftovers,
  });
  const fails = dataFindings(observe).filter((f) => f.level === 'fail');
  assert.equal(fails.length, 1, JSON.stringify(dataFindings(observe)));
  assert.match(fails[0].message, /部分更新の痕跡が残っている \(society\.json\.tmp\.4242\.deadbeef\)/);
  assert.match(fails[0].message, /消していない/);

  const off = harness({
    config: societyConfig(null),
    files: { [SOCIETY]: JSON.stringify(emptySnapshot(T0)) },
    dataFiles: [SOCIETY], list: leftovers,
  });
  assert.deepEqual(dataFindings(off).filter((f) => f.level === 'fail'), []);
  assert.ok(dataFindings(off).some((f) => f.level === 'warn' && /部分更新の痕跡/.test(f.message)));
});

test('doctor: 他の台帳の扱いは変わらない (society を足しても)', () => {
  const out = harness({
    config: societyConfig({ mode: 'observe' }),
    files: { [SOCIETY]: JSON.stringify(emptySnapshot(T0)), [`${ROOT}/data/pause.json`]: '{ broken' },
    dataFiles: [SOCIETY, `${ROOT}/data/pause.json`, `${ROOT}/data/nope.json`],
  });
  const fails = dataFindings(out).filter((f) => f.level === 'fail');
  assert.equal(fails.length, 1);
  assert.match(fails[0].message, /data\/pause\.json が JSON として読めない/);
  assert.match(fails[0].message, /自律起動が止まる \(fail-closed\)/);
  // fs.list を持たない呼び出し (既存のテスト・古い doctor.mjs) でも落ちない
  assert.equal(out.findings.some((f) => /部分更新の痕跡/.test(f.message)), false);
});
