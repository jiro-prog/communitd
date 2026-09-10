import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS } from '../src/attachments.js';
import { DEFAULT_MAX_BOT_HOPS } from '../src/hops.js';
import { resolveSociety } from '../src/society-policy.js';
import {
  ATTACHMENT_LIMIT_KEYS,
  AUTONOMY_KEYS,
  AUTONOMY_SCOUT_KEYS,
  AUTONOMY_WORKER_KEYS,
  BOT_REQUIRED_KEYS,
  BOT_RUNTIMES,
  CODEX_OPTIONAL_BOT_KEYS,
  DEFAULT_AUTONOMY_ENABLED,
  DEFAULT_BASE_BRANCH,
  DEFAULT_DIRECTION_FILE,
  DEFAULT_DUTY_INTERVAL_MIN,
  DEFAULT_DUTY_MAX_OPEN_PROPOSALS,
  DEFAULT_INITIATIVE_BUDGET,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_JOBS_PER_DAY,
  DEFAULT_SCOUT_INTERVAL_MIN,
  DEFAULT_SCOUT_MAX_OPEN_TASKS,
  DEFAULT_TASK_JOB_BUDGET,
  DEFAULT_HOOKS_ENABLED,
  DEFAULT_VERIFY_MAX_RETRIES,
  DEFAULT_MAX_TOOL_APPROVAL_CARDS,
  DEFAULT_OWNER_NAMES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_STRUCTURED_OUTPUT,
  DEFAULT_TOOL_APPROVAL_TTL_MS,
  DEFAULT_TOOL_APPROVAL_WAIT_MS,
  DEFAULT_TRANSCRIPT_CHAR_BUDGET,
  MAX_TOOL_APPROVAL_CARDS_RANGE,
  POLICY_FILE,
  SECRETS_FILE,
  SECRET_KEYS,
  TOOL_APPROVAL_TTL_RANGE_MS,
  TOOL_APPROVAL_WAIT_RANGE_MS,
  TRANSCRIPT_CHAR_BUDGET_RANGE,
  TOOL_PRESETS,
  VERIFY_MAX_RETRIES_RANGE,
  channelConfigForName,
  loadConfigSources,
  mergeConfigSources,
  resolveAddDirs,
  resolveAutonomy,
  resolveChannelRoster,
  resolveAllowedTools,
  resolveCodexSandbox,
  resolveHooksEnabled,
  resolveVerifyCommand,
  resolveVerifyMaxRetries,
  resolveMaxBotHops,
  resolveMaxSelfHops,
  resolveMaxToolApprovalCards,
  resolveOwnerTargets,
  resolvePermissionMode,
  resolveStructuredOutputEnabled,
  resolveToolApprovalTtlMs,
  resolveToolApprovalWaitMs,
  resolveTranscriptCharBudget,
  isInitiativeEnabled,
  resolveDuties,
  resolveDutyBots,
  resolveExecBotKeys,
  resolveApplyChannel,
  resolveInitiativeBudget,
  validateAttachmentLimits,
  validateAutonomy,
  validateConfig,
} from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 検証を通る最小 config に patch を重ねる */
function cfg(patch = {}) {
  return {
    guildId: '1',
    allowedUserIds: ['2'],
    channels: { sandbox: { cwd: 'C:/tmp' } },
    ...patch,
  };
}

/**
 * 検証を通る最小の bot (必須 4 キー) に patch を重ねる。
 * 個々のテストが見たいのは 4 キー**以外**の検査なので、そこはこの helper で満たす。
 */
function bot(patch = {}) {
  return {
    tokenEnv: 'T', displayName: 'D', model: 'opus', rolePromptFile: 'roles/worker.md', ...patch,
  };
}

test('妥当な config はエラーなし', () => {
  assert.deepEqual(validateConfig(cfg()), []);
});

test('bots.<key> の tokenEnv / displayName / model / rolePromptFile は必須', () => {
  // **どれも「書き忘れても起動はする」状態だった。** 症状が job の途中に出るので、
  // 起動時に落として直し方を出す (文書は必須と書いていた)
  assert.deepEqual(BOT_REQUIRED_KEYS.map(([k]) => k),
    ['tokenEnv', 'displayName', 'model', 'rolePromptFile']);
  assert.deepEqual(validateConfig(cfg({ bots: { w: bot() } })), []);

  for (const [key] of BOT_REQUIRED_KEYS) {
    for (const value of [undefined, '', '   ', 42, null, [], {}]) {
      const errors = validateConfig(cfg({ bots: { w: bot({ [key]: value }) } }));
      assert.equal(errors.length, 1, `bots.w.${key} = ${JSON.stringify(value)} が通ってしまう`);
      assert.ok(errors[0].startsWith(`bots.w.${key} が要る`), errors[0]);
      // 直し方 (何を書けばよいか) がエラー文に入っている
      assert.match(errors[0], /例: /);
    }
  }
  // 全部欠けたら 4 件まとめて出す (1 つ直すたびに次が出る、を繰り返させない)
  assert.equal(validateConfig(cfg({ bots: { w: {} } })).length, 4);
  // bot がオブジェクトでなければ 4 件並べずに 1 件で断る
  const notObject = validateConfig(cfg({ bots: { w: ['claude'] } }));
  assert.equal(notObject.length, 1);
  assert.match(notObject[0], /bots\.w はオブジェクトで書く/);
});

test('runtime は claude | codex だけ (省略 = claude)', () => {
  // コード側は 10 箇所以上で `runtime === 'codex'` の厳密一致を見ているので、綴り違いは
  // **全部 claude 側へ倒れる**。起動する CLI も effort / codexInstructionsFile の可否も
  // model の要否も、1 語の書き損じでまとめて黙って変わる
  assert.deepEqual(BOT_RUNTIMES, ['claude', 'codex']);
  for (const runtime of [undefined, 'claude', 'codex']) {
    assert.deepEqual(validateConfig(cfg({ bots: { w: bot({ runtime }) } })), [],
      `runtime: ${JSON.stringify(runtime)} が通らない`);
  }
  for (const runtime of ['Codex', 'CLAUDE', 'gemini', ' codex ', '', 42, null]) {
    const errors = validateConfig(cfg({ bots: { w: bot({ runtime }) } }));
    assert.ok(errors.some((e) => e.startsWith('bots.w.runtime:')),
      `runtime: ${JSON.stringify(runtime)} が通ってしまう (${errors.join(' / ')})`);
  }
  // 綴り違いは model の要否まで巻き込む — runtime と model の 2 件が並んで出る
  const both = validateConfig(cfg({ bots: { w: bot({ runtime: 'Codex', model: undefined }) } }));
  assert.equal(both.length, 2, both.join(' / '));
  assert.ok(both.some((e) => e.startsWith('bots.w.runtime:')));
  assert.ok(both.some((e) => e.startsWith('bots.w.model が要る')));
});

test('model は codex ランタイムでだけ省略できる (書くなら非空)', () => {
  // codex の `-m` は条件付きで渡している (src/codex.js) ので、省略すると codex 側の
  // 既定モデルで走る。しかも `codex exec --help` は使えるモデル名を列挙しないので、
  // 書かせると third party は当てずっぽうになる。claude は `--model` が無条件で必須
  assert.deepEqual(CODEX_OPTIONAL_BOT_KEYS, ['model']);

  const codexBot = (patch = {}) => bot({ runtime: 'codex', model: undefined, ...patch });
  assert.deepEqual(validateConfig(cfg({ bots: { r: codexBot() } })), [],
    'codex で model 省略が通らない');
  assert.deepEqual(validateConfig(cfg({ bots: { r: codexBot({ model: 'gpt-x' }) } })), []);

  // 書いたなら効く値であること (空文字は「設定したつもり」の典型)
  for (const value of ['', '   ', 42, null, [], {}]) {
    const errors = validateConfig(cfg({ bots: { r: codexBot({ model: value }) } }));
    assert.equal(errors.length, 1, `codex の model = ${JSON.stringify(value)} が通ってしまう`);
    assert.ok(errors[0].startsWith('bots.r.model は非空の文字列で書く'), errors[0]);
    assert.match(errors[0], /省略もできる/, '省略できることが分からない');
  }

  // claude (runtime 未指定を含む) は従来どおり必須
  for (const runtime of [undefined, 'claude']) {
    const errors = validateConfig(cfg({ bots: { w: bot({ runtime, model: undefined }) } }));
    assert.equal(errors.length, 1, `runtime: ${runtime} で model 省略が通ってしまう`);
    assert.ok(errors[0].startsWith('bots.w.model が要る'), errors[0]);
    // 直し方は claude の話だけにする (codex では必須ではないため)
    assert.equal(errors[0].includes('codex'), false, errors[0]);
  }
});

test('同梱の example と実際の設定ファイルが起動時検証を通る', () => {
  // 「clone → example をコピー → doctor」が通ることの回帰。ここが崩れると
  // SETUP のとおりに進めた第三者が最初の起動で落ちる
  const pairs = [['config.policy.example.json', 'config.secrets.example.json']];
  // 作者の実設定はこのリポジトリにしか無いので、在るときだけ見る (CI では飛ばす)。
  // **書かれた OS の上でだけ**見る: 設定の cwd は絶対パスなので、WSL から Windows 側の
  // ツリーを検証すると同じディレクトリでも綴りが違い (`C:/…` と `/mnt/c/…`)、
  // 直しようのない不一致で落ちる。その設定を使うのは Windows 側のブリッジの方
  const realPolicy = resolve(ROOT, 'config.policy.json');
  const usable = process.platform === 'win32'
    || !(existsSync(realPolicy) && /"[A-Za-z]:[\\/]/.test(readFileSync(realPolicy, 'utf8')));
  if (usable && existsSync(realPolicy) && existsSync(resolve(ROOT, 'config.secrets.json'))) {
    pairs.push(['config.policy.json', 'config.secrets.json']);
  }
  for (const [policy, secrets] of pairs) {
    const { config, errors } = loadConfigSources({
      policyPath: resolve(ROOT, policy),
      secretsPath: resolve(ROOT, secrets),
      readFile: (p) => readFileSync(p, 'utf8'),
    });
    assert.deepEqual(errors, [], `${policy} を読めない`);
    assert.deepEqual(validateConfig(config, { repoRoot: ROOT }), [], `${policy} が検証を通らない`);
  }
});

test('claudeBin / codexCmd は文字列 1 語でも語の配列でも書ける (省略可)', () => {
  for (const value of ['claude', ['claude'], ['node', 'C:/x/cli.js'], 'C:/bin/claude.exe']) {
    assert.deepEqual(validateConfig(cfg({ claudeBin: value })), [], JSON.stringify(value));
    assert.deepEqual(validateConfig(cfg({ codexCmd: value })), [], JSON.stringify(value));
  }
  assert.deepEqual(validateConfig(cfg()), []);
});

test('claudeBin / codexCmd の書き損じは起動時に落とす', () => {
  // **この 2 つは「起動できません」の案内が指す唯一の直し先**なので、黙って既定へ
  // 落とすと直したつもりで同じエラーが出続ける (Opus2 指摘 2026-09-10)。
  // 空配列は「設定したつもり」の典型
  for (const value of [[], 42, '', '   ', ['node', ''], {}, null, ['a', 3]]) {
    for (const key of ['claudeBin', 'codexCmd']) {
      const errors = validateConfig(cfg({ [key]: value }));
      assert.equal(errors.length, 1, `${key}: ${JSON.stringify(value)} が通ってしまう`);
      assert.ok(errors[0].includes(key), errors[0]);
    }
  }
});

test('bot の effort は Claude CLI の許容値を指定できる', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(validateConfig(cfg({ bots: { opus: bot({ effort }) } })), []);
  }
  // 未指定には既定値を補わず、従来どおりにする
  assert.deepEqual(validateConfig(cfg({ bots: { opus: bot() } })), []);
});

test('bot の effort の不正値は起動時に落とす', () => {
  for (const effort of ['turbo', 1, '']) {
    const errors = validateConfig(cfg({ bots: { opus: bot({ effort }) } }));
    assert.ok(
      errors.some((e) => e.includes('bots.opus.effort')),
      `effort=${JSON.stringify(effort)} が通ってしまう`,
    );
  }
});

test('codex bot への effort 指定は起動時に落とす (黙って無視しない)', () => {
  const errors = validateConfig(cfg({ bots: { sol: bot({ runtime: 'codex', effort: 'low' }) } }));
  assert.ok(errors.some((e) => e.includes('bots.sol.effort') && e.includes('codex')));
  assert.deepEqual(validateConfig(cfg({ bots: { sol: bot({ runtime: 'codex' }) } })), []);
});

test('codexInstructionsFile は codex bot だけ・非空の文字列で書く', () => {
  const file = 'prompts/codex-consult.md';
  assert.deepEqual(
    validateConfig(cfg({ bots: { sol: bot({ runtime: 'codex', codexInstructionsFile: file }) } })),
    [],
  );
  // claude ランタイムには配線が無い。黙って無視すると「相談役にしたつもりの bot が
  // 組み込み指示のまま動いている」ことに誰も気付けない
  const wrongRuntime = validateConfig(cfg({ bots: { opus: bot({ codexInstructionsFile: file }) } }));
  assert.ok(
    wrongRuntime.some((e) => e.includes('bots.opus.codexInstructionsFile') && e.includes('codex')),
  );
  for (const value of ['', 1, null]) {
    const errors = validateConfig(
      cfg({ bots: { sol: bot({ runtime: 'codex', codexInstructionsFile: value }) } }),
    );
    assert.ok(
      errors.some((e) => e.includes('bots.sol.codexInstructionsFile')),
      `codexInstructionsFile=${JSON.stringify(value)} が通ってしまう`,
    );
  }
});

test('maxBotHops は未設定なら既定 12・書けばその値', () => {
  assert.equal(resolveMaxBotHops(cfg()), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxBotHops(cfg({ limits: {} })), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxBotHops({}), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxBotHops(), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxBotHops(cfg({ limits: { maxBotHops: 20 } })), 20);
  // 0 = bot 起点の起動を止める、という有効な設定
  assert.equal(resolveMaxBotHops(cfg({ limits: { maxBotHops: 0 } })), 0);
  assert.deepEqual(validateConfig(cfg({ limits: { maxBotHops: 0 } })), []);
  assert.deepEqual(validateConfig(cfg({ limits: { maxBotHops: 12 } })), []);
});

test('maxBotHops の書き損じは起動時に落とす (黙って既定へ落とさない)', () => {
  for (const maxBotHops of [-1, 1.5, '12', null, Number.NaN, Infinity]) {
    assert.ok(
      validateConfig(cfg({ limits: { maxBotHops } })).some((e) => e.includes('maxBotHops')),
      `maxBotHops=${String(maxBotHops)} が通ってしまう`,
    );
  }
});

test('maxSelfHops は未設定なら maxBotHops と同じ (先回りして絞らない)', () => {
  assert.equal(resolveMaxSelfHops(cfg()), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxSelfHops(cfg({ limits: {} })), DEFAULT_MAX_BOT_HOPS);
  assert.equal(resolveMaxSelfHops(), DEFAULT_MAX_BOT_HOPS);
  // maxBotHops だけを絞れば自己呼び出しもそこまで
  assert.equal(resolveMaxSelfHops(cfg({ limits: { maxBotHops: 4 } })), 4);
  // 暴走したときに自己呼び出しだけを絞れる (0 = 機能ごと切る)
  assert.equal(resolveMaxSelfHops(cfg({ limits: { maxBotHops: 12, maxSelfHops: 2 } })), 2);
  assert.equal(resolveMaxSelfHops(cfg({ limits: { maxSelfHops: 0 } })), 0);
  assert.deepEqual(validateConfig(cfg({ limits: { maxSelfHops: 0 } })), []);
  // 絞るのは自己呼び出しだけ — bot 間ホップは巻き添えにしない
  assert.equal(resolveMaxBotHops(cfg({ limits: { maxSelfHops: 2 } })), DEFAULT_MAX_BOT_HOPS);
});

test('maxSelfHops の書き損じは起動時に落とす (黙って既定へ落とさない)', () => {
  for (const maxSelfHops of [-1, 1.5, '3', null, Number.NaN, Infinity]) {
    assert.ok(
      validateConfig(cfg({ limits: { maxSelfHops } })).some((e) => e.includes('maxSelfHops')),
      `maxSelfHops=${String(maxSelfHops)} が通ってしまう`,
    );
  }
});

test('ownerUserId を書けば既定の呼び名で変換先になる', () => {
  assert.deepEqual(resolveOwnerTargets({ ownerUserId: 'U1' }), [
    { displayName: DEFAULT_OWNER_NAMES[0], userId: 'U1' },
  ]);
  assert.deepEqual(validateConfig(cfg({ ownerUserId: 'U1' })), []);
});

test('ownerNames で呼び名を複数指定できる', () => {
  assert.deepEqual(resolveOwnerTargets({ ownerUserId: 'U1', ownerNames: ['So', 'そう'] }), [
    { displayName: 'So', userId: 'U1' },
    { displayName: 'そう', userId: 'U1' },
  ]);
  assert.deepEqual(validateConfig(cfg({ ownerUserId: 'U1', ownerNames: ['So', 'そう'] })), []);
});

test('ownerUserId 未設定なら変換先なし (allowedUserIds から推測しない)', () => {
  assert.deepEqual(resolveOwnerTargets({ allowedUserIds: ['U1', 'U2'] }), []);
  assert.deepEqual(resolveOwnerTargets({ ownerUserId: '   ', allowedUserIds: ['U1'] }), []);
  assert.deepEqual(resolveOwnerTargets({}), []);
  assert.deepEqual(resolveOwnerTargets(), []);
  // 未設定そのものは設定ミスではない (人間へメンションしない運用)
  assert.deepEqual(validateConfig(cfg()), []);
});

test('ownerUserId / ownerNames の書き損じは起動時に落とす', () => {
  for (const ownerUserId of ['', '   ', 123, null]) {
    assert.ok(
      validateConfig(cfg({ ownerUserId })).some((e) => e.includes('ownerUserId')),
      `ownerUserId=${String(ownerUserId)} が通ってしまう`,
    );
  }
  for (const ownerNames of [[], 'So', [''], [123]]) {
    assert.ok(
      validateConfig(cfg({ ownerUserId: 'U1', ownerNames })).some((e) => e.includes('ownerNames')),
      `ownerNames=${JSON.stringify(ownerNames)} が通ってしまう`,
    );
  }
  // 呼び名だけ書いて ID が無い = メンションしたつもりで届かない
  assert.ok(
    validateConfig(cfg({ ownerNames: ['そう'] })).some((e) => e.includes('ownerUserId')),
    'ownerNames だけの設定が通ってしまう',
  );
});

test('owner の呼び名が bot 表示名と衝突したら起動拒否', () => {
  const bots = { sol: bot({ displayName: 'Sol' }), opus: bot({ displayName: 'Opus' }) };
  for (const ownerNames of [['Sol'], ['sol'], [' SOL '], ['So', 'Opus']]) {
    const errors = validateConfig(cfg({ ownerUserId: 'U1', ownerNames, bots }));
    assert.ok(
      errors.some((e) => e.includes('呼び名')),
      `衝突が見逃されている: ${JSON.stringify(ownerNames)}`,
    );
  }
  // 前方一致は衝突ではない (@So は @Sol にマッチしない)
  assert.deepEqual(validateConfig(cfg({ ownerUserId: 'U1', bots })), []);
  assert.deepEqual(validateConfig(cfg({ ownerUserId: 'U1', ownerNames: ['So', 'そう'], bots })), []);
  // owner 未設定なら衝突しようがない
  assert.deepEqual(validateConfig(cfg({ bots })), []);
});

test('ownerNames が空配列・非文字列混じりでも解決は壊れない (検証は validateConfig の仕事)', () => {
  assert.deepEqual(resolveOwnerTargets({ ownerUserId: 'U1', ownerNames: [] }), [
    { displayName: DEFAULT_OWNER_NAMES[0], userId: 'U1' },
  ]);
  assert.deepEqual(resolveOwnerTargets({ ownerUserId: 'U1', ownerNames: ['', 'そう'] }), [
    { displayName: 'そう', userId: 'U1' },
  ]);
});

test('guildId 欠落・空文字は起動拒否', () => {
  for (const guildId of [undefined, '', '   ', 123, null]) {
    const errors = validateConfig(cfg({ guildId }));
    assert.ok(errors.some((e) => e.includes('guildId')), `guildId=${String(guildId)} が通ってしまう`);
  }
});

test('allowedUserIds 欠落・空配列・非文字列は起動拒否', () => {
  for (const allowedUserIds of [undefined, [], '2', [''], [123]]) {
    const errors = validateConfig(cfg({ allowedUserIds }));
    assert.ok(
      errors.some((e) => e.includes('allowedUserIds')),
      `allowedUserIds=${JSON.stringify(allowedUserIds)} が通ってしまう`,
    );
  }
});

test('channels の cwd 欠落は起動拒否', () => {
  const errors = validateConfig(cfg({ channels: { sandbox: { tools: 'readonly' } } }));
  assert.ok(errors.some((e) => e.includes('channels.sandbox.cwd')));
});

test('tools の typo は起動拒否 (黙って昇格させない)', () => {
  const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', tools: 'standrad' } } }));
  assert.ok(errors.some((e) => e.includes('channels.a.tools')));
});

test('Object.prototype 由来の名前はプリセットとして通さない', () => {
  const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', tools: 'constructor' } } }));
  assert.ok(errors.some((e) => e.includes('channels.a.tools')));
});

test('permissionMode の typo は起動拒否 (touch 制限が未知モードを裁けない)', () => {
  for (const permissionMode of ['acceptedits', 'Default', 'yolo', '']) {
    const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', permissionMode } } }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.permissionMode')),
      `permissionMode=${JSON.stringify(permissionMode)} が通ってしまう`,
    );
  }
  assert.deepEqual(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', permissionMode: 'plan' } } })),
    [],
  );
});

test('allowedTools / toolsExtra の型不正は起動拒否', () => {
  assert.ok(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', allowedTools: 'Read' } } }))
      .some((e) => e.includes('allowedTools は配列')),
  );
  assert.ok(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', toolsExtra: 'mcp__X' } } }))
      .some((e) => e.includes('toolsExtra は配列')),
  );
});

test('claudeAddDirs は絶対パスへ正規化し、重複と cwd 自身を落とす', () => {
  // `--add-dir` は実 OS へ渡す引数なので、絶対パスの綴りは実 OS の規則で決まる。
  // 事例も resolve() で作る — `C:/…` と直に書くと Windows でしか絶対パスにならない
  const cwd = resolve('/tmp/work');
  const docs = resolve('/tmp/docs');
  assert.deepEqual(resolveAddDirs({ cwd }), []); // 未指定なら何も渡さない
  assert.deepEqual(resolveAddDirs({ cwd, claudeAddDirs: [] }), []);
  assert.deepEqual(
    resolveAddDirs({ cwd, claudeAddDirs: [docs, '../notes', ` ${docs} `] }),
    [docs, resolve('/tmp/notes')], // 相対は cwd 基準・重複は 1 回
  );
  // cwd 自身は常に渡っているので二重に足さない (表記ゆれも同じ扱い)
  assert.deepEqual(resolveAddDirs({ cwd, claudeAddDirs: [cwd, '.', 'sub/..'] }), []);
  // 検証を素通りした値が混ざっても、そこだけ落として残りは渡す
  assert.deepEqual(
    resolveAddDirs({ cwd, claudeAddDirs: [null, '', '   ', 3, docs] }),
    [docs],
  );
});

test('claudeAddDirs の型不正は起動拒否 (足したつもりで効かないを作らない)', () => {
  assert.deepEqual(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', claudeAddDirs: ['C:/tmp/docs'] } } })),
    [],
  );
  for (const bad of ['C:/tmp/docs', [''], [null], [3], {}]) {
    const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', claudeAddDirs: bad } } }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.claudeAddDirs')),
      `${JSON.stringify(bad)} は起動時に落とす`,
    );
  }
});

test('hooks は未指定なら無効・明示した boolean だけを採る', () => {
  assert.equal(DEFAULT_HOOKS_ENABLED, false);
  assert.equal(resolveHooksEnabled(), false);
  assert.equal(resolveHooksEnabled({}), false);
  assert.equal(resolveHooksEnabled({ hooks: false }), false);
  assert.equal(resolveHooksEnabled({ hooks: true }), true);
  // 検証を素通りした truthy 値でも有効化しない
  assert.equal(resolveHooksEnabled({ hooks: 'true' }), false);
});

test('hooks の型不正は起動拒否する', () => {
  assert.deepEqual(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', hooks: true } } })),
    [],
  );
  for (const bad of ['true', 1, 0, null, [], {}]) {
    const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', hooks: bad } } }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.hooks:')),
      `${JSON.stringify(bad)} は起動時に落とす`,
    );
  }
});


test('verify は未指定なら無効・非空文字列なら trim して採る', () => {
  assert.equal(resolveVerifyCommand(), null);
  assert.equal(resolveVerifyCommand({}), null);
  assert.equal(resolveVerifyCommand({ verify: '' }), null);
  assert.equal(resolveVerifyCommand({ verify: '  npm test  ' }), 'npm test');
});

test('verify は hooks: true と組でだけ有効になる', () => {
  assert.deepEqual(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', hooks: true, verify: 'npm test' } } })),
    [],
  );
  for (const channel of [
    { cwd: 'C:/tmp', verify: 'npm test' },
    { cwd: 'C:/tmp', hooks: false, verify: 'npm test' },
  ]) {
    const errors = validateConfig(cfg({ channels: { a: channel } }));
    assert.ok(errors.some((e) => e.includes('hooks: true')));
  }
});

test('verify の型不正・空文字列は起動拒否する', () => {
  for (const bad of ['', '   ', 1, false, null, [], {}]) {
    const errors = validateConfig(cfg({
      channels: { a: { cwd: 'C:/tmp', hooks: true, verify: bad } },
    }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.verify は')),
      `${JSON.stringify(bad)} は起動時に落とす`,
    );
  }
});

test('verifyMaxRetries は既定 1・範囲 0〜3', () => {
  assert.equal(DEFAULT_VERIFY_MAX_RETRIES, 1);
  assert.deepEqual(VERIFY_MAX_RETRIES_RANGE, [0, 3]);
  assert.equal(resolveVerifyMaxRetries(), 1);
  assert.equal(resolveVerifyMaxRetries({}), 1);
  assert.equal(resolveVerifyMaxRetries({ verifyMaxRetries: 0 }), 0);
  assert.equal(resolveVerifyMaxRetries({ verifyMaxRetries: 3 }), 3);
  assert.equal(resolveVerifyMaxRetries({ verifyMaxRetries: 4 }), 1);

  for (const bad of [-1, 4, 1.5, '1', null]) {
    const errors = validateConfig(cfg({
      channels: { a: { cwd: 'C:/tmp', hooks: true, verifyMaxRetries: bad } },
    }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.verifyMaxRetries')),
      `${JSON.stringify(bad)} は起動時に落とす`,
    );
  }
});
test('複数の不備をまとめて報告する', () => {
  const errors = validateConfig({ channels: { a: {} } });
  assert.equal(errors.length, 3); // guildId / allowedUserIds / channels.a.cwd
});

test('tools/allowedTools 未指定は readonly に落ちる (standard へ暗黙昇格しない)', () => {
  const tools = resolveAllowedTools({ cwd: 'C:/tmp' });
  assert.deepEqual(tools, TOOL_PRESETS.readonly);
  for (const t of ['Edit', 'Write', 'Bash', 'Bash(git *)', 'PowerShell']) {
    assert.ok(!tools.includes(t), `${t} が既定で許可されている`);
  }
});

test('tools プリセットは明示時のみ有効・toolsExtra は後置される', () => {
  assert.deepEqual(resolveAllowedTools({ tools: 'standard' }), TOOL_PRESETS.standard);
  assert.deepEqual(resolveAllowedTools({ tools: 'full' }), TOOL_PRESETS.full);
  assert.deepEqual(resolveAllowedTools({ toolsExtra: ['mcp__UnityMCP'] }), [
    ...TOOL_PRESETS.readonly,
    'mcp__UnityMCP',
  ]);
});

test('明示の allowedTools 配列が最優先 (後方互換)', () => {
  assert.deepEqual(resolveAllowedTools({ tools: 'full', allowedTools: ['Read'] }), ['Read']);
  assert.deepEqual(resolveAllowedTools({ allowedTools: [] }), []);
});

test('Discord で承認したルールは preset にも明示 allowedTools にも足される', () => {
  assert.deepEqual(resolveAllowedTools({ tools: 'readonly' }, ['Bash(npm ci)']), [
    ...TOOL_PRESETS.readonly,
    'Bash(npm ci)',
  ]);
  // 明示配列を書いているチャンネルでも承認は効く (書いた人の意図を上書きはしない・足すだけ)
  assert.deepEqual(resolveAllowedTools({ allowedTools: ['Read'] }, ['Bash(npm ci)']),
    ['Read', 'Bash(npm ci)']);
});

test('承認ルールが config と重複しても二重に渡さない', () => {
  assert.deepEqual(resolveAllowedTools({ allowedTools: ['Read', 'Read'] }, ['Read']), ['Read']);
});

test('承認ルールが無い / 壊れていても既定の許可は変わらない', () => {
  assert.deepEqual(resolveAllowedTools({ tools: 'readonly' }, []), TOOL_PRESETS.readonly);
  assert.deepEqual(resolveAllowedTools({ tools: 'readonly' }, null), TOOL_PRESETS.readonly);
  assert.deepEqual(resolveAllowedTools({ tools: 'readonly' }), TOOL_PRESETS.readonly);
});

test('承認まわりの上限は書き損じも「実質無制限」も起動時に落とす', () => {
  const base = { guildId: 'G1', allowedUserIds: ['U1'] };
  const [ttlMin, ttlMax] = TOOL_APPROVAL_TTL_RANGE_MS;
  const [cardMin, cardMax] = MAX_TOOL_APPROVAL_CARDS_RANGE;

  // 正の整数というだけでは足りない — MAX_SAFE_INTEGER は実質無期限・無制限
  for (const bad of ['30m', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER, ttlMin - 1, ttlMax + 1]) {
    assert.ok(
      validateConfig({ ...base, limits: { toolApprovalTtlMs: bad } })
        .some((e) => e.includes('toolApprovalTtlMs')),
      `落とせていない: ${JSON.stringify(bad)}`,
    );
  }
  for (const bad of ['3', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER, cardMax + 1]) {
    assert.ok(
      validateConfig({ ...base, limits: { maxToolApprovalCards: bad } })
        .some((e) => e.includes('maxToolApprovalCards')),
      `落とせていない: ${JSON.stringify(bad)}`,
    );
  }
  // 省略と範囲内の値は通す (境界も含む)。
  // 短い TTL を書くときは待機上限もそれより短くする — 既定の待機上限 (3 分) のままだと
  // 「押せなくなった後も job が止まり続ける」組み合わせになり、別の検証で落ちる
  assert.deepEqual(validateConfig(base), []);
  const wait = TOOL_APPROVAL_WAIT_RANGE_MS[0];
  for (const [ttl, cards] of [[ttlMin, cardMin], [ttlMax, cardMax], [60000, 5]]) {
    assert.deepEqual(
      validateConfig({
        ...base,
        limits: { toolApprovalTtlMs: ttl, maxToolApprovalCards: cards, toolApprovalWaitMs: wait },
      }),
      [], `通すべき値を落としている: ${ttl} / ${cards}`,
    );
  }
});

test('承認まわりの上限は既定へ落ちる (書かなければ効く値がある)', () => {
  assert.equal(resolveToolApprovalTtlMs({}), DEFAULT_TOOL_APPROVAL_TTL_MS);
  assert.equal(resolveToolApprovalTtlMs({ limits: { toolApprovalTtlMs: 60000 } }), 60000);
  assert.equal(resolveMaxToolApprovalCards({}), DEFAULT_MAX_TOOL_APPROVAL_CARDS);
  assert.equal(resolveMaxToolApprovalCards({ limits: { maxToolApprovalCards: 5 } }), 5);
  // 範囲外は既定へ (validateConfig が起動を止めるので実運用では到達しない保険)
  for (const bad of ['30m', -1, Number.MAX_SAFE_INTEGER, TOOL_APPROVAL_TTL_RANGE_MS[1] + 1]) {
    assert.equal(resolveToolApprovalTtlMs({ limits: { toolApprovalTtlMs: bad } }),
      DEFAULT_TOOL_APPROVAL_TTL_MS, `既定へ落ちていない: ${JSON.stringify(bad)}`);
  }
  for (const bad of [-1, 0, Number.MAX_SAFE_INTEGER, MAX_TOOL_APPROVAL_CARDS_RANGE[1] + 1]) {
    assert.equal(resolveMaxToolApprovalCards({ limits: { maxToolApprovalCards: bad } }),
      DEFAULT_MAX_TOOL_APPROVAL_CARDS, `既定へ落ちていない: ${JSON.stringify(bad)}`);
  }
});

test('承認の待機上限は範囲外を起動時に落とし、省略は既定へ', () => {
  const base = { guildId: 'G1', allowedUserIds: ['U1'] };
  const [min, max] = TOOL_APPROVAL_WAIT_RANGE_MS;
  // 長く取れると、承認待ちの間ずっと同じ作業ツリーの他チャンネルが止まる
  for (const bad of ['3m', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER, min - 1, max + 1]) {
    assert.ok(
      validateConfig({ ...base, limits: { toolApprovalWaitMs: bad } })
        .some((e) => e.includes('toolApprovalWaitMs')),
      `落とせていない: ${JSON.stringify(bad)}`,
    );
  }
  for (const good of [min, max, 120_000]) {
    assert.deepEqual(validateConfig({ ...base, limits: { toolApprovalWaitMs: good } }), [],
      `通すべき値を落としている: ${good}`);
  }
  assert.equal(resolveToolApprovalWaitMs({}), DEFAULT_TOOL_APPROVAL_WAIT_MS);
  assert.equal(resolveToolApprovalWaitMs({ limits: { toolApprovalWaitMs: 60_000 } }), 60_000);
  assert.equal(resolveToolApprovalWaitMs({ limits: { toolApprovalWaitMs: max + 1 } }),
    DEFAULT_TOOL_APPROVAL_WAIT_MS);
  assert.ok(DEFAULT_TOOL_APPROVAL_WAIT_MS < DEFAULT_TOOL_APPROVAL_TTL_MS);
});

test('待機上限がカードの寿命以上になる組み合わせは起動時に落とす', () => {
  // それぞれ単体では範囲内でも、組み合わせると「押せなくなった後も job が止まり続ける」
  // (60 秒で期限切れのカードを 10 分待つ設定 — sol 指摘 2026-08-02)
  const base = { guildId: 'G1', allowedUserIds: ['U1'] };
  const bad = { toolApprovalTtlMs: 60_000, toolApprovalWaitMs: 600_000 };
  assert.ok(
    validateConfig({ ...base, limits: bad }).some((e) => e.includes('toolApprovalWaitMs')),
    '通してはいけない組み合わせ',
  );
  // 片方だけ書いた設定も実効値 (省略側は既定) で見る
  assert.ok(
    validateConfig({ ...base, limits: { toolApprovalTtlMs: 60_000 } })
      .some((e) => e.includes('toolApprovalWaitMs')),
    '省略側の既定と組み合わせた結果を見ていない',
  );
  assert.deepEqual(
    validateConfig({ ...base, limits: { toolApprovalTtlMs: 600_000, toolApprovalWaitMs: 60_000 } }),
    [],
  );
});

test('transcriptCharBudget は範囲外を起動時に落とし、省略は既定へ', () => {
  const base = { guildId: 'G1', allowedUserIds: ['U1'] };
  const [min, max] = TRANSCRIPT_CHAR_BUDGET_RANGE;

  // 小さすぎる値は「1 件も載らない」設定なので黙って既定へ落とさず止める
  for (const bad of ['80000', 0, -1, 1.5, null, min - 1, max + 1]) {
    assert.ok(
      validateConfig({ ...base, limits: { transcriptCharBudget: bad } })
        .some((e) => e.includes('transcriptCharBudget')),
      `落とせていない: ${JSON.stringify(bad)}`,
    );
  }
  for (const ok of [min, max, 80000]) {
    assert.deepEqual(validateConfig({ ...base, limits: { transcriptCharBudget: ok } }), [],
      `通すべき値を落としている: ${ok}`);
  }

  assert.equal(resolveTranscriptCharBudget({}), DEFAULT_TRANSCRIPT_CHAR_BUDGET);
  assert.equal(resolveTranscriptCharBudget({ limits: { transcriptCharBudget: 20000 } }), 20000);
  // 範囲外は既定へ (validateConfig が起動を止めるので実運用では到達しない保険)
  for (const bad of ['80000', 0, -1, min - 1]) {
    assert.equal(resolveTranscriptCharBudget({ limits: { transcriptCharBudget: bad } }),
      DEFAULT_TRANSCRIPT_CHAR_BUDGET, `既定へ落ちていない: ${JSON.stringify(bad)}`);
  }
});

test('codexSandbox 未指定の既定は read-only (書込みは明示時のみ)', () => {
  assert.equal(resolveCodexSandbox({}), 'read-only');
  assert.equal(resolveCodexSandbox({ codexSandbox: 'workspace-write' }), 'workspace-write');
  assert.equal(resolveCodexSandbox({ codexSandbox: 'read-only' }), 'read-only');
  // 検証を素通りした値でも全開放にしない
  assert.equal(resolveCodexSandbox({ codexSandbox: 'danger-full-access' }), 'read-only');
  assert.equal(resolveCodexSandbox({ codexSandbox: 'WORKSPACE-WRITE' }), 'read-only');
});

test('未知の codexSandbox は起動拒否 (綴り違いを黙って read-only にしない)', () => {
  assert.deepEqual(validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp' } } })), []);
  assert.deepEqual(
    validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', codexSandbox: 'workspace-write' } } })),
    [],
  );
  for (const bad of ['danger-full-access', 'workspace_write', 'write', '', null, 3]) {
    const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', codexSandbox: bad } } }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.codexSandbox')),
      `${JSON.stringify(bad)} は起動時に落とす`,
    );
  }
});

test('permissionMode 未指定の既定は default (acceptEdits ではない)', () => {
  assert.equal(DEFAULT_PERMISSION_MODE, 'default');
  assert.equal(resolvePermissionMode({}), 'default');
  assert.equal(resolvePermissionMode({ permissionMode: 'acceptEdits' }), 'acceptEdits');
});

test('channelConfigForName は未登録・prototype 名で null', () => {
  const config = cfg();
  assert.deepEqual(channelConfigForName(config, 'sandbox'), {
    cwd: 'C:/tmp',
    channelName: 'sandbox',
  });
  assert.equal(channelConfigForName(config, 'unknown'), null);
  assert.equal(channelConfigForName(config, 'toString'), null);
  assert.equal(channelConfigForName({}, 'sandbox'), null);
});

test('limits.attachments は省略可・書くなら正の整数だけ', () => {
  assert.deepEqual(validateConfig(cfg()), [], '未設定は既定値で動く');
  assert.deepEqual(
    validateConfig(cfg({ limits: { attachments: { maxImagesPerJob: 4, maxBytesPerImage: 1024 } } })),
    [],
  );

  // 0 / 負値 / 小数 / 非数を黙って通すと「無制限」や「全部拒否」に化ける
  for (const bad of [0, -1, 1.5, '4', null, NaN, Infinity]) {
    const errors = validateAttachmentLimits({ maxImagesPerJob: bad });
    assert.ok(
      errors.some((e) => e.includes('maxImagesPerJob') && e.includes('正の整数')),
      `${JSON.stringify(bad)} は拒否する`,
    );
  }
  assert.deepEqual(validateAttachmentLimits([]), ['limits.attachments はオブジェクトで書く']);
  assert.deepEqual(validateAttachmentLimits(undefined), []);
});

test('limits.attachments の未知キーは黙って無視せず拒否する', () => {
  // タイプミスが「上限を設定したつもりで効いていない」に化けるのを防ぐ
  const errors = validateAttachmentLimits({ maxImagePerJob: 4, maxBytesPreImage: 1024 });
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.includes('不明なキー')));
  assert.deepEqual(
    validateAttachmentLimits(Object.fromEntries(ATTACHMENT_LIMIT_KEYS.map((k) => [k, 1]))).filter(
      (e) => e.includes('不明なキー'),
    ),
    [],
    '既知キーは全て通る',
  );
});

test('maxBytesTotal < maxBytesPerImage は拒否する (どの画像も通らない設定)', () => {
  assert.ok(
    validateAttachmentLimits({ maxBytesPerImage: 10485760, maxBytesTotal: 1024 })
      .some((e) => e.includes('maxBytesTotal')),
  );
  // 等値は許す (1 枚ちょうどまで)
  assert.deepEqual(validateAttachmentLimits({ maxBytesPerImage: 1024, maxBytesTotal: 1024 }), []);
  assert.deepEqual(validateAttachmentLimits({ maxBytesPerImage: 1024, maxBytesTotal: 4096 }), []);
});

test('片側だけ指定しても既定値とマージした実効値で不変条件を見る', () => {
  // 既定は maxBytesPerImage 10MB / maxBytesTotal 20MB
  assert.equal(DEFAULT_LIMITS.maxBytesPerImage, 10 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxBytesTotal, 20 * 1024 * 1024);

  // 合計だけ 1KB → 既定の単体上限 10MB を下回る
  assert.ok(
    validateAttachmentLimits({ maxBytesTotal: 1024 }).some((e) => e.includes('実効値')),
    'maxBytesTotal だけ小さくした設定を拒否する',
  );
  // 単体だけ 30MB → 既定の合計上限 20MB を上回る
  assert.ok(
    validateAttachmentLimits({ maxBytesPerImage: 30 * 1024 * 1024 }).some((e) => e.includes('実効値')),
    'maxBytesPerImage だけ大きくした設定を拒否する',
  );

  // 既定と矛盾しない片側指定は通す
  assert.deepEqual(validateAttachmentLimits({ maxBytesTotal: 30 * 1024 * 1024 }), []);
  assert.deepEqual(validateAttachmentLimits({ maxBytesPerImage: 1024 }), []);
  assert.deepEqual(validateAttachmentLimits({ maxImagesPerJob: 8 }), []);
});

test('テキスト添付の上限キーも同じ規則で検証する', () => {
  const keys = [
    'maxTextFilesPerJob',
    'maxBytesPerTextFile',
    'maxTextBytesTotal',
    'maxTextCharsPerFile',
    'maxTextCharsTotal',
  ];
  for (const key of keys) {
    assert.ok(ATTACHMENT_LIMIT_KEYS.includes(key), `${key} は設定できる`);
    assert.ok(
      validateAttachmentLimits({ [key]: 0 }).some((e) => e.includes(key) && e.includes('正の整数')),
      `${key} の 0 は拒否する`,
    );
  }
  // 既定値は画像と独立した枠として持つ
  assert.equal(DEFAULT_LIMITS.maxTextFilesPerJob, 4);
  assert.equal(DEFAULT_LIMITS.maxBytesPerTextFile, 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxTextBytesTotal, 2 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxTextCharsPerFile, 8000);
  assert.equal(DEFAULT_LIMITS.maxTextCharsTotal, 16000);
});

test('テキストの合計上限が単体上限を下回る組み合わせを拒否する', () => {
  // バイト側: 合計だけ絞ると、どのファイルも通らない
  assert.ok(
    validateAttachmentLimits({ maxTextBytesTotal: 1024 })
      .some((e) => e.includes('maxTextBytesTotal') && e.includes('maxBytesPerTextFile')),
    '実効値 (既定 1MiB の単体上限) と突き合わせて拒否する',
  );
  // 文字側: 合計より大きい単体上限は、書いた数字どおりには効かない
  assert.ok(
    validateAttachmentLimits({ maxTextCharsPerFile: 100000 })
      .some((e) => e.includes('maxTextCharsTotal') && e.includes('maxTextCharsPerFile')),
  );
  // 等値と、両方の兼ね合いが取れた指定は通る
  assert.deepEqual(
    validateAttachmentLimits({ maxTextCharsPerFile: 4000, maxTextCharsTotal: 4000 }),
    [],
  );
  assert.deepEqual(
    validateAttachmentLimits({ maxBytesPerTextFile: 2048, maxTextBytesTotal: 8192 }),
    [],
  );
  // 画像側の不変条件と混ざらない
  assert.deepEqual(validateAttachmentLimits({ maxTextFilesPerJob: 8 }), []);
});

// ---- 設定ファイルの分離 (policy / secrets) ----

/** 実ファイルを触らずに loader を回す (値を渡さないキーは「ファイルが無い」扱い) */
function sources(policy, secrets) {
  const files = new Map();
  if (policy !== undefined) files.set(POLICY_FILE, policy);
  if (secrets !== undefined) files.set(SECRETS_FILE, secrets);
  return loadConfigSources({
    policyPath: POLICY_FILE,
    secretsPath: SECRETS_FILE,
    readFile: (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      const value = files.get(p);
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  });
}

test('config 分離: policy と secrets を 1 枚の config へ合成する', () => {
  const { config, errors } = sources(
    { claudeBin: 'claude', channels: { a: { cwd: 'C:/a' } } },
    { guildId: 'G1', allowedUserIds: ['U1'], ownerUserId: 'U1' },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(config, {
    claudeBin: 'claude',
    channels: { a: { cwd: 'C:/a' } },
    guildId: 'G1',
    allowedUserIds: ['U1'],
    ownerUserId: 'U1',
  });
  // 合成後は分離前とまったく同じ起動検証を通る (identity 境界は解決済み config で見る)
  assert.deepEqual(validateConfig(config), []);
});

test('config 分離: secrets に置けるキーは allowlist で固定する', () => {
  // ownerUserId / ownerNames が secrets 側なのは、org-apply (policy にしか触れない)
  // から裁定権者とその呼称を変更できなくするため (docs/social-engineering.md §3.9)
  assert.deepEqual(SECRET_KEYS, ['guildId', 'allowedUserIds', 'ownerUserId', 'ownerNames']);
});

test('config 分離: allowlist 外のキーを secrets へ置いたら起動させない', () => {
  // channels を secrets へ移せば git の追跡から外せてしまう —
  // 「policy の現在値はリポジトリを見れば分かる」が org-apply の前提
  const { config, errors } = sources({ claudeBin: 'claude' }, { channels: { a: { cwd: 'C:/a' } } });
  assert.equal(config, null);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('channels'), errors[0]);
  assert.ok(errors[0].includes(SECRETS_FILE), errors[0]);
});

test('config 分離: 秘密キーを policy 側に置いたら起動させない', () => {
  // 「secrets に置ける」だけでは分離目的を満たさない — policy 側に残っていれば
  // org-apply (policy にしか触れない) から書き換えられる (sol 指摘 2026-08-29)。
  // allowlist は両側に効かせる
  for (const key of SECRET_KEYS) {
    const { config, errors } = sources({ [key]: 'x', channels: {} }, { guildId: 'G1' });
    assert.equal(config, null, `${key} を policy 側に置いたのに通っている`);
    assert.equal(errors.length, 1, `${key}: ${JSON.stringify(errors)}`);
    assert.ok(errors[0].includes(key), errors[0]);
    assert.ok(errors[0].includes(POLICY_FILE), errors[0]);
  }
});

test('config 分離: 同じキーが両方にあれば拒否する', () => {
  // 重なるキーは必ず SECRET_KEYS (secrets 側は allowlist に縛られている) なので、
  // policy 側の禁止で落ちる
  const { config, errors } = sources({ guildId: 'G-policy', channels: {} }, { guildId: 'G-secret' });
  assert.equal(config, null);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('guildId'), errors[0]);
});

test('config 分離: 読めない・壊れているときは合成も検証もしない', () => {
  const missing = sources({ channels: {} }); // secrets が無い
  assert.equal(missing.config, null);
  assert.equal(missing.errors.length, 1);
  assert.ok(missing.errors[0].includes(SECRETS_FILE), missing.errors[0]);
  assert.ok(missing.errors[0].includes('SETUP.md'), missing.errors[0]);

  const broken = sources('{ "channels": ', { guildId: 'G1' });
  assert.equal(broken.config, null);
  assert.equal(broken.errors.length, 1);
  assert.ok(broken.errors[0].includes(POLICY_FILE), broken.errors[0]);
});

test('config 分離: オブジェクトでない設定は受け取らない', () => {
  for (const [policy, secrets] of [[[], {}], [{}, null], ['"文字列"', {}]]) {
    const merged = typeof policy === 'string' ? sources(policy, secrets) : mergeConfigSources(policy, secrets);
    assert.equal(merged.config, null);
    assert.ok(merged.errors.length > 0);
  }
});

test('稼働中の設定 (policy + secrets) があれば起動検証を通る', (t) => {
  const policyPath = resolve(ROOT, POLICY_FILE);
  const secretsPath = resolve(ROOT, SECRETS_FILE);
  if (!existsSync(policyPath) || !existsSync(secretsPath)) {
    return t.skip(`稼働中の設定なし (${SECRETS_FILE} は gitignore)`);
  }
  const { config, errors } = loadConfigSources({
    policyPath,
    secretsPath,
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(validateConfig(config), []);
});

// ---- channels.<name>.roster (チャンネル既定の編成) ----

test('resolveChannelRoster: 未設定なら null (従来どおり制限なし)', () => {
  assert.equal(resolveChannelRoster({}), null);
  assert.equal(resolveChannelRoster(), null);
  // 型不正はここでは既定へ落とす (起動時検証が別に弾く)
  assert.equal(resolveChannelRoster({ roster: 'opus' }), null);
});

test('resolveChannelRoster: 空配列は「handoff 禁止」として通す', () => {
  assert.deepEqual(resolveChannelRoster({ roster: [] }), []);
});

test('resolveChannelRoster は重複を畳み、指定順と前後空白を正規化する', () => {
  assert.deepEqual(resolveChannelRoster({ roster: [' opus ', 'fable', 'opus'] }), ['opus', 'fable']);
});

test('channels.roster は bot キーの配列でなければ起動時に落ちる', () => {
  for (const roster of ['opus', 42, {}, ['opus', ''], ['opus', 3]]) {
    const errors = validateConfig(cfg({
      bots: { opus: bot() },
      channels: { sandbox: { cwd: 'C:/tmp', roster } },
    }));
    assert.ok(
      errors.some((e) => e.includes('channels.sandbox.roster')),
      `${JSON.stringify(roster)} を通している`,
    );
  }
});

test('channels.roster の知らない bot キーは起動時に落ちる', () => {
  const errors = validateConfig(cfg({
    bots: { opus: bot(), fable: bot() },
    channels: { sandbox: { cwd: 'C:/tmp', roster: ['opus', 'haiku'] } },
  }));
  assert.ok(errors.some((e) => e.includes('haiku')), '綴り違いを黙って呑んでいる');
  assert.ok(errors.some((e) => e.includes('opus / fable')), '使えるキーを示していない');
});

test('channels.roster: 実在するキーと空配列は通る', () => {
  const bots = { opus: bot(), fable: bot() };
  for (const roster of [['opus'], ['opus', 'fable'], []]) {
    assert.deepEqual(
      validateConfig(cfg({ bots, channels: { sandbox: { cwd: 'C:/tmp', roster } } })),
      [],
      JSON.stringify(roster),
    );
  }
});

// ---- channels.<name>.structuredOutput (委譲契約と報告様式の切り替え) ----

test('structuredOutput: 未設定なら有効 (現状維持が既定)', () => {
  assert.equal(DEFAULT_STRUCTURED_OUTPUT, true);
  assert.equal(resolveStructuredOutputEnabled({}), true);
  assert.equal(resolveStructuredOutputEnabled(), true);
});

test('structuredOutput: false で切れる', () => {
  assert.equal(resolveStructuredOutputEnabled({ structuredOutput: false }), false);
  assert.equal(resolveStructuredOutputEnabled({ structuredOutput: true }), true);
});

test('structuredOutput: 未知の値は「切れていない」側へ倒す', () => {
  // 切る側が防御の薄い方なので、書き損じで黙って契約が消える方が危ない
  for (const v of ['false', 0, null, 'no']) {
    assert.equal(resolveStructuredOutputEnabled({ structuredOutput: v }), true, JSON.stringify(v));
  }
});

test('structuredOutput の書き損じは起動時に落とす', () => {
  for (const structuredOutput of ['false', 0, null, 'off']) {
    const errors = validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', structuredOutput } } }));
    assert.ok(
      errors.some((e) => e.includes('channels.a.structuredOutput')),
      `${JSON.stringify(structuredOutput)} が通ってしまう`,
    );
  }
  for (const structuredOutput of [true, false]) {
    assert.deepEqual(
      validateConfig(cfg({ channels: { a: { cwd: 'C:/tmp', structuredOutput } } })),
      [],
      String(structuredOutput),
    );
  }
});

// ---- channels.<name>.autonomy (自律運転 — docs/social-engineering.md §3.7) ----

/**
 * 自律運転を書いたチャンネルの config。
 * `enabled: true` を通すには verify (と hooks: true) が要るので既定で入れてある。
 */
function autonomyCfg(autonomy, channelExtra = {}) {
  return cfg({
    bots: { opus: bot(), fable: bot(), sol: bot() },
    channels: { obs: { cwd: 'C:/tmp', hooks: true, verify: 'npm test', autonomy, ...channelExtra } },
  });
}

test('autonomy: 未設定なら自律運転は止まっていて、数値は §3.7 の既定値', () => {
  assert.equal(DEFAULT_AUTONOMY_ENABLED, false);
  // 既定値そのものを固定する (SETUP.md の記述と乖離したら気付けるように)
  assert.equal(DEFAULT_MAX_CONCURRENT_TASKS, 2);
  assert.equal(DEFAULT_MAX_JOBS_PER_DAY, 40);
  assert.equal(DEFAULT_TASK_JOB_BUDGET, 20);
  assert.equal(DEFAULT_SCOUT_INTERVAL_MIN, 60);
  assert.equal(DEFAULT_SCOUT_MAX_OPEN_TASKS, 6);
  assert.equal(DEFAULT_DIRECTION_FILE, 'docs/direction.md');
  assert.equal(DEFAULT_BASE_BRANCH, 'main');

  const a = resolveAutonomy({});
  assert.deepEqual(a, {
    enabled: false,
    directionFile: 'docs/direction.md',
    baseBranch: 'main',
    scout: { bot: null, intervalMin: 60, maxOpenTasks: 6 },
    worker: { bots: [] },
    reviewer: null,
    maxConcurrentTasks: 2,
    maxJobsPerDay: 40,
    taskJobBudget: 20,
    // 自動復旧 (§11.4) の既定は観測だけ — 書かない配備で勝手に起こし直さない
    recovery: { mode: 'observe', graceMin: 5, maxAutoRetries: 2, retryDelaysMin: [5, 15] },
  });
  assert.deepEqual(resolveAutonomy(), a, '引数なしでも同じ形');
  assert.deepEqual(resolveAutonomy({ autonomy: {} }), a);
});

test('autonomy: 書いた値を採り、bot キーは重複と前後空白を正規化する', () => {
  const a = resolveAutonomy({
    autonomy: {
      enabled: true,
      directionFile: ' docs/vision.md ',
      baseBranch: ' develop ',
      scout: { bot: ' opus ', intervalMin: 15, maxOpenTasks: 3 },
      worker: { bots: [' opus ', 'sol', 'opus'] },
      reviewer: 'fable',
      maxConcurrentTasks: 4,
      maxJobsPerDay: 120,
      taskJobBudget: 8,
    },
  });
  assert.equal(a.enabled, true);
  assert.equal(a.directionFile, 'docs/vision.md');
  assert.equal(a.baseBranch, 'develop');
  assert.deepEqual(a.scout, { bot: 'opus', intervalMin: 15, maxOpenTasks: 3 });
  assert.deepEqual(a.worker.bots, ['opus', 'sol']);
  assert.equal(a.reviewer, 'fable');
  assert.equal(a.maxConcurrentTasks, 4);
  assert.equal(a.maxJobsPerDay, 120);
  assert.equal(a.taskJobBudget, 8);
});

test('autonomy: enabled は true と書いたときだけ true (書き損じで動き出さない)', () => {
  for (const enabled of ['true', 1, 'yes', null, {}, 'on']) {
    assert.equal(
      resolveAutonomy({ autonomy: { enabled } }).enabled,
      false,
      `${JSON.stringify(enabled)} で自律運転が始まっている`,
    );
  }
  assert.equal(resolveAutonomy({ autonomy: { enabled: true } }).enabled, true);
});

test('autonomy: 型不正は resolve では既定へ倒す (拒否は起動時検証の仕事)', () => {
  const a = resolveAutonomy({
    autonomy: {
      directionFile: '   ',
      baseBranch: '   ',
      maxConcurrentTasks: 0,
      maxJobsPerDay: -1,
      taskJobBudget: 1.5,
      scout: 'opus',
      worker: ['opus'],
      reviewer: 42,
    },
  });
  assert.deepEqual(a, resolveAutonomy({}), '既定へ倒しきれていない');
});

test('autonomy: 妥当な設定・省略は起動検証を通る', () => {
  assert.deepEqual(validateConfig(autonomyCfg({
    enabled: true,
    directionFile: 'docs/direction.md',
    scout: { bot: 'opus', intervalMin: 30, maxOpenTasks: 4 },
    worker: { bots: ['opus', 'sol'] },
    reviewer: 'fable',
    maxConcurrentTasks: 2,
    maxJobsPerDay: 40,
    taskJobBudget: 20,
  })), []);
  // 丸ごと省略・空オブジェクトも従来どおり
  assert.deepEqual(validateConfig(cfg()), []);
  assert.deepEqual(validateConfig(autonomyCfg({})), []);
  assert.deepEqual(validateAutonomy(undefined), []);
});

test('autonomy の未知キーは黙って無視せず拒否する', () => {
  const errors = validateConfig(autonomyCfg({
    maxConcurentTasks: 3,
    scout: { bot: 'opus', interval: 30 },
    worker: { bots: ['opus'], bot: 'opus' },
  }));
  assert.ok(
    errors.some((e) => e.includes('channels.obs.autonomy.maxConcurentTasks は不明なキー')),
    '綴り違いのキーを呑んでいる',
  );
  assert.ok(errors.some((e) => e.includes('channels.obs.autonomy.scout.interval は不明なキー')));
  assert.ok(errors.some((e) => e.includes('channels.obs.autonomy.worker.bot は不明なキー')));
  assert.ok(errors.some((e) => e.includes(AUTONOMY_KEYS.join(' / '))), '使えるキーを示していない');
  assert.ok(errors.some((e) => e.includes(AUTONOMY_SCOUT_KEYS.join(' / '))));
  assert.ok(errors.some((e) => e.includes(AUTONOMY_WORKER_KEYS.join(' / '))));
});

test('autonomy の型違いは起動時に落とす', () => {
  const cases = [
    [{ enabled: 'true' }, 'autonomy.enabled'],
    [{ enabled: 1 }, 'autonomy.enabled'],
    [{ directionFile: '' }, 'autonomy.directionFile'],
    [{ directionFile: 42 }, 'autonomy.directionFile'],
    [{ reviewer: 42 }, 'autonomy.reviewer'],
    [{ scout: 'opus' }, 'autonomy.scout'],
    [{ scout: { bot: 42 } }, 'autonomy.scout.bot'],
    [{ worker: ['opus'] }, 'autonomy.worker'],
    [{ worker: { bots: 'opus' } }, 'autonomy.worker.bots'],
    [{ worker: { bots: ['opus', 3] } }, 'autonomy.worker.bots'],
  ];
  for (const [autonomy, needle] of cases) {
    const errors = validateConfig(autonomyCfg(autonomy));
    assert.ok(
      errors.some((e) => e.includes(`channels.obs.${needle}`)),
      `${JSON.stringify(autonomy)} が通ってしまう`,
    );
  }
  for (const autonomy of ['on', 42, ['opus'], null]) {
    assert.ok(
      validateConfig(autonomyCfg(autonomy)).some((e) => e.includes('channels.obs.autonomy はオブジェクトで書く')),
      `${JSON.stringify(autonomy)} が通ってしまう`,
    );
  }
});

test('autonomy のペース設定は 1 以上の整数だけ通す', () => {
  const bad = [0, -1, 1.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1];
  for (const key of ['maxConcurrentTasks', 'maxJobsPerDay', 'taskJobBudget']) {
    for (const value of bad) {
      assert.ok(
        validateConfig(autonomyCfg({ [key]: value })).some((e) => e.includes(`channels.obs.autonomy.${key}`)),
        `${key}=${JSON.stringify(value)} が通ってしまう`,
      );
    }
    assert.deepEqual(validateConfig(autonomyCfg({ [key]: 1 })), [], key);
  }
  for (const key of ['intervalMin', 'maxOpenTasks']) {
    for (const value of bad) {
      assert.ok(
        validateConfig(autonomyCfg({ scout: { [key]: value } }))
          .some((e) => e.includes(`channels.obs.autonomy.scout.${key}`)),
        `scout.${key}=${JSON.stringify(value)} が通ってしまう`,
      );
    }
    assert.deepEqual(validateConfig(autonomyCfg({ scout: { [key]: 1 } })), [], key);
  }
});

test('autonomy の担当に知らない bot キーを書いたら落とす', () => {
  const errors = validateConfig(autonomyCfg({
    scout: { bot: 'haiku' },
    worker: { bots: ['opus', 'gpt'] },
    reviewer: 'nobody',
  }));
  assert.equal(errors.length, 3, `想定外のエラー: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => e.includes('autonomy.scout.bot に知らない bot キー: haiku')));
  assert.ok(errors.some((e) => e.includes('autonomy.worker.bots に知らない bot キー: gpt')));
  assert.ok(errors.some((e) => e.includes('autonomy.reviewer に知らない bot キー: nobody')));
  assert.ok(errors.some((e) => e.includes('使えるのは opus / fable / sol')), '使えるキーを示していない');
});

test('autonomy.enabled: true には verify が要る (無人で main へ昇格する経路だから)', () => {
  const withoutVerify = validateConfig(cfg({
    bots: { opus: bot(), fable: bot() },
    channels: {
      obs: { cwd: 'C:/tmp', autonomy: { enabled: true, scout: { bot: 'opus' }, reviewer: 'fable' } },
    },
  }));
  assert.ok(
    withoutVerify.some((e) => e.includes('channels.obs.autonomy.enabled: true には channels.obs.verify')),
    '機械検証の無いチャンネルで自律運転を許している',
  );
  // enabled を書かなければ verify が無くても従来どおり通る (既定は「何も起きない」側)
  assert.deepEqual(validateConfig(cfg({
    bots: { opus: bot() },
    channels: { obs: { cwd: 'C:/tmp', autonomy: { enabled: false, scout: { bot: 'opus' } } } },
  })), []);
  // verify + hooks を書けば通る
  assert.deepEqual(validateConfig(autonomyCfg({ enabled: true, scout: { bot: 'opus' }, reviewer: 'fable' })), []);
});

test('autonomy: worker が reviewer だけの編成は起動時に落とす (自己レビュー禁止)', () => {
  const errors = validateConfig(autonomyCfg({
    enabled: true,
    worker: { bots: ['fable'] },
    reviewer: 'fable',
  }));
  assert.ok(errors.some((e) => e.includes('自己レビュー禁止')), '執筆と検収が同じ bot の編成を通している');
  // 別の worker が居れば通る
  assert.deepEqual(
    validateConfig(autonomyCfg({ enabled: true, worker: { bots: ['opus', 'fable'] }, reviewer: 'fable' })),
    [],
  );
  // enabled でないチャンネルは編成の途中経過として許す (止まっているものは危なくない)
  assert.deepEqual(
    validateConfig(autonomyCfg({ worker: { bots: ['fable'] }, reviewer: 'fable' })),
    [],
  );
});

// ---- 発議機構 (§3.9) ----

const initiativeCfg = (initiative, over = {}) => cfg({
  bots: { fable: bot(), opus: bot() },
  allowedUserIds: ['2', 'so'],
  ownerUserId: 'so',
  initiative,
  ...over,
});

test('initiative: 書かなければ何も要求しない (既定は無効)', () => {
  assert.deepEqual(validateConfig(cfg()), []);
  assert.equal(isInitiativeEnabled(cfg()), false);
  assert.deepEqual(resolveExecBotKeys(cfg()), []);
});

test('initiative: 有効にするなら ownerUserId が要る (org を裁定できるのは So だけ)', () => {
  const errors = validateConfig(initiativeCfg({ enabled: true }, { ownerUserId: undefined }));
  assert.ok(errors.some((e) => e.includes('ownerUserId が要る')), '裁定不能な設定を通している');
  assert.deepEqual(validateConfig(initiativeCfg({ enabled: true })), []);
  // 無効なら ownerUserId は要らない (従来どおり任意)
  assert.deepEqual(validateConfig(initiativeCfg({ enabled: false }, { ownerUserId: undefined })), []);
});

test('initiative: 有効なら ownerUserId は allowedUserIds にも入っていること', () => {
  // 裁定 UI は identity 境界と owner 判定の両方を要求する。片方だけの設定は
  // 「カードは届くのに押せない」= 永久に裁定できない構成になる (sol 指摘 2026-08-29)
  const errors = validateConfig(initiativeCfg({ enabled: true }, { allowedUserIds: ['2'] }));
  assert.ok(errors.some((e) => e.includes('allowedUserIds にも入れる')), '裁定不能な設定を通している');
  // 無効なら従来どおり縛らない
  assert.deepEqual(validateConfig(initiativeCfg({ enabled: false }, { allowedUserIds: ['2'] })), []);
});

test('initiative: execBotKeys は実在する bot だけ・既定は空 (誰も裁定できない)', () => {
  assert.deepEqual(resolveExecBotKeys(initiativeCfg({ enabled: true, execBotKeys: ['fable'] })), ['fable']);
  assert.deepEqual(resolveExecBotKeys(initiativeCfg({ enabled: true })), []);

  const errors = validateConfig(initiativeCfg({ enabled: true, execBotKeys: ['nobody'] }));
  assert.ok(errors.some((e) => e.includes('居ない bot')), '存在しない bot に裁定権を与えている');
});

/** 適用回路として通る形のチャンネル (§3.9 — autonomy はあるが scout は持たない) */
const applyChannels = (over = {}) => ({
  apply: {
    cwd: 'C:/tmp',
    // 自律運転には機械検証が要る (既存の autonomy 検証)
    verify: 'npm test',
    hooks: true,
    autonomy: { enabled: true, worker: { bots: ['opus'] }, reviewer: 'fable', ...over },
  },
});

test('initiative: applyChannel は実在するチャンネル・既定は無し (適用回路を持たない)', () => {
  // 適用回路を置く場所が決まらないと、どのチャンネルの設定で roles/** と policy へ
  // 書いてよいかが決まらない。書いていない配備では基点が取れないので、
  // **org / process の採択そのものを拒否する** (却下と work は通る)
  assert.equal(resolveApplyChannel(cfg()), null);
  assert.equal(resolveApplyChannel(initiativeCfg({ enabled: true })), null);
  assert.equal(resolveApplyChannel(initiativeCfg({ enabled: true, applyChannel: 'apply' })), 'apply');

  const ok = initiativeCfg({ enabled: true, applyChannel: 'apply' }, { channels: applyChannels() });
  assert.deepEqual(validateConfig(ok), []);
  assert.ok(
    validateConfig(initiativeCfg({ enabled: true, applyChannel: 'nowhere' }))
      .some((e) => e.includes('channels に無い')),
    '実在しないチャンネルを適用回路にしている',
  );
  assert.ok(
    validateConfig(initiativeCfg({ enabled: true, applyChannel: '' }))
      .some((e) => e.includes('チャンネル名を書く')),
  );
});

test('initiative: 適用回路のチャンネルは cwd・autonomy・scout まで見る', () => {
  const withChannels = (channels, over = {}) => initiativeCfg(
    { enabled: true, applyChannel: 'apply', ...over }, { channels },
  );

  // cwd はブリッジ自身のリポジトリと同じでなければならない (検証と適用がずれる)
  assert.deepEqual(validateConfig(withChannels(applyChannels()), { repoRoot: 'C:/tmp' }), []);
  assert.ok(
    validateConfig(withChannels(applyChannels()), { repoRoot: 'C:/other' })
      .some((e) => e.includes('ブリッジ自身のリポジトリと同じにする')),
    '別リポジトリのチャンネルを適用回路にしている',
  );
  // repoRoot を渡さない呼び出し (add-project) では cwd を見ない
  assert.deepEqual(validateConfig(withChannels(applyChannels())), []);

  // autonomy が無ければ適用 task が走らない
  assert.ok(
    validateConfig(withChannels({ apply: { cwd: 'C:/tmp' } }))
      .some((e) => e.includes('autonomy.enabled が true でないと')),
  );
  // worker と reviewer の両方が要る (片方が欠けると採択した提案の錠が滞留する)
  assert.ok(
    validateConfig(withChannels(applyChannels({ worker: { bots: [] } })))
      .some((e) => e.includes('autonomy.worker.bots が要る')),
  );
  assert.ok(
    validateConfig(withChannels(applyChannels({ reviewer: undefined })))
      .some((e) => e.includes('autonomy.reviewer が要る')),
  );
  // scout.bot は未設定 — 適用 task 以外を副作用で起こさない
  assert.ok(
    validateConfig(withChannels(applyChannels({ scout: { bot: 'opus' } })))
      .some((e) => e.includes('scout.bot は未設定にする')),
  );
});

test('initiative: 機構を止めていれば applyChannel の稼働条件までは求めない', () => {
  // enabled:false は「機構ごと入り切り」なので、止めた状態の設定が起動できないのは食い違う。
  // 構造 (実在) は常に見るが、autonomy まわりは有効なときだけ
  const stopped = initiativeCfg(
    { enabled: false, applyChannel: 'apply' },
    { channels: { apply: { cwd: 'C:/other' } }, ownerUserId: undefined },
  );
  assert.deepEqual(validateConfig(stopped, { repoRoot: 'C:/tmp' }), []);

  // 止めていても、実在しないチャンネル名は書き間違いなので落とす
  assert.ok(
    validateConfig(initiativeCfg({ enabled: false, applyChannel: 'nowhere' }))
      .some((e) => e.includes('channels に無い')),
  );
});

test('initiative: 未知のキーと型違いは起動時に落とす', () => {
  assert.ok(validateConfig(initiativeCfg({ enabled: true, budget: 3 })).some((e) => e.includes('未知のキー')));
  assert.ok(validateConfig(initiativeCfg({ enabled: 'yes' })).some((e) => e.includes('true / false')));
  assert.ok(validateConfig(initiativeCfg({ execBotKeys: 'fable' })).some((e) => e.includes('execBotKeys')));
  assert.ok(validateConfig(cfg({ initiative: [] })).some((e) => e.includes('オブジェクト')));
});

test('initiative: 構造化出力を返せない bot には duty も裁定権も持たせない', () => {
  // 発議も裁定も report の任意フィールドで受け取るので、返せない bot に持たせると
  // スレッドと job 予算だけ消えて何も回収できない (sol 指摘 2026-08-30)
  const withBots = (bots, initiative) => cfg({
    bots, allowedUserIds: ['so'], ownerUserId: 'so', initiative,
  });
  const declared = () => 'report';
  const undeclared = () => null;

  // codex は --json-schema を持たない
  const codex = withBots({ sol: bot({ runtime: 'codex' }), fable: bot() }, { enabled: true, execBotKeys: ['sol'] });
  assert.ok(
    validateConfig(codex, { contractKindOf: declared }).some((e) => e.includes('runtime: "codex"')),
    '裁定を回収できない設定を通している',
  );
  const codexDuty = withBots(
    { sol: bot({ runtime: 'codex', duties: { audit: {} } }), fable: bot() },
    { enabled: true, execBotKeys: ['fable'] },
  );
  assert.ok(validateConfig(codexDuty, { contractKindOf: declared }).some((e) => e.includes('duty')));

  // 役割文にスキーマ宣言が無い bot は種別の上書きが乗らない
  const bare = withBots({ fable: bot({ duties: { ops: {} } }) }, { enabled: true, execBotKeys: ['fable'] });
  assert.ok(
    validateConfig(bare, { contractKindOf: undeclared }).some((e) => e.includes('スキーマ宣言')),
    '発議を回収できない設定を通している',
  );
  assert.deepEqual(validateConfig(bare, { contractKindOf: declared }), []);

  // 読み手を渡さなければ役割文は見ない (config だけで分かる codex は落とす)
  assert.deepEqual(validateConfig(bare), []);
  assert.ok(validateConfig(codex).some((e) => e.includes('runtime: "codex"')));

  // 無効なら縛らない (止まっている機構の設定は途中経過として許す)
  const off = withBots({ sol: bot({ runtime: 'codex', duties: { audit: {} } }) }, { enabled: false });
  assert.deepEqual(validateConfig(off, { contractKindOf: undeclared }), []);
});

test('initiative: duty があるのに自律チャンネルの構造化出力が切られていたら落とす', () => {
  // bot も役割文も正しいのに、チャンネル側で切られていると resolveContractKind が
  // null になり、発議 job がスレッドと予算だけ消費する (sol 指摘 2026-08-30)
  const chan = (over) => cfg({
    bots: { fable: bot({ duties: { ops: {} } }), opus: bot() },
    allowedUserIds: ['so'],
    ownerUserId: 'so',
    initiative: { enabled: true, execBotKeys: ['fable'] },
    channels: {
      observatory: {
        cwd: 'C:/tmp',
        hooks: true,
        verify: 'npm test',
        autonomy: { enabled: true, worker: { bots: ['opus'] }, reviewer: 'fable' },
        ...over,
      },
    },
  });
  const declared = () => 'report';

  assert.ok(
    validateConfig(chan({ structuredOutput: false }), { contractKindOf: declared })
      .some((e) => e.includes('structuredOutput: false')),
    '発議を回収できないチャンネル設定を通している',
  );
  assert.deepEqual(validateConfig(chan({}), { contractKindOf: declared }), []);
  assert.deepEqual(validateConfig(chan({ structuredOutput: true }), { contractKindOf: declared }), []);

  // 自律運転が無効なチャンネルは巡回もイベントも来ないので縛らない
  const idle = cfg({
    bots: { fable: bot({ duties: { ops: {} } }) },
    allowedUserIds: ['so'],
    ownerUserId: 'so',
    initiative: { enabled: true, execBotKeys: ['fable'] },
    channels: { communitd: { cwd: 'C:/tmp', structuredOutput: false } },
  });
  assert.deepEqual(validateConfig(idle, { contractKindOf: declared }), []);

  // duty を持つ bot が居なければ縛らない (巡回もイベントも起きない)
  const noDuty = cfg({
    bots: { fable: bot(), opus: bot() },
    allowedUserIds: ['so'],
    ownerUserId: 'so',
    initiative: { enabled: true, execBotKeys: ['fable'] },
    channels: {
      observatory: {
        cwd: 'C:/tmp',
        hooks: true,
        verify: 'npm test',
        structuredOutput: false,
        autonomy: { enabled: true, worker: { bots: ['opus'] }, reviewer: 'fable' },
      },
    },
  });
  assert.deepEqual(validateConfig(noDuty, { contractKindOf: declared }), []);
});

// ---- duty (§3.8 bot 組織 OS) ----

test('duty: 書かなければ持たない / 書けば既定を埋めて key 昇順で返す', () => {
  assert.deepEqual(resolveDuties({}), []);
  assert.deepEqual(resolveDuties({ duties: 'x' }), []);
  assert.equal(resolveInitiativeBudget({}), DEFAULT_INITIATIVE_BUDGET);
  assert.equal(resolveInitiativeBudget({ initiativeBudget: 3 }), 3);
  // 壊れた値は既定へ倒す (綴り違いは validateConfig が落とす)
  assert.equal(resolveInitiativeBudget({ initiativeBudget: 0 }), DEFAULT_INITIATIVE_BUDGET);

  assert.deepEqual(
    resolveDuties({ duties: { review: { intervalMin: 30 }, audit: {} } }),
    [
      {
        key: 'audit',
        intervalMin: DEFAULT_DUTY_INTERVAL_MIN,
        maxOpenProposals: DEFAULT_DUTY_MAX_OPEN_PROPOSALS,
        eventKinds: [],
      },
      {
        key: 'review',
        intervalMin: 30,
        maxOpenProposals: DEFAULT_DUTY_MAX_OPEN_PROPOSALS,
        eventKinds: [],
      },
    ],
  );
  // 知らないイベントは落とす (閉集合の外は「そのイベントでは起きない」)・重複も潰す
  assert.deepEqual(
    resolveDuties({ duties: { a: { eventKinds: ['block', '知らない', 'block'] } } })[0].eventKinds,
    ['block'],
  );
});

test('duty: resolveDutyBots は duty を持つ bot だけを bot キー昇順で返す', () => {
  const config = {
    bots: {
      sol: { duties: { audit: { eventKinds: ['block'] } }, initiativeBudget: 2 },
      opus: {},
      fable: { duties: { ops: {} } },
    },
  };
  assert.deepEqual(resolveDutyBots(config).map((b) => b.botKey), ['fable', 'sol']);
  assert.equal(resolveDutyBots(config)[1].initiativeBudget, 2);
  assert.deepEqual(resolveDutyBots({}), []);
});

test('duty: 綴り違い・型違い・pointer に書けないキーは起動時に落とす', () => {
  const dutyCfg = (patch) => cfg({ bots: { sol: bot(patch) } });
  const errs = (patch) => validateConfig(dutyCfg(patch));

  assert.deepEqual(errs({ duties: { audit: { intervalMin: 60, maxOpenProposals: 2, eventKinds: ['block'] } } }), []);
  assert.ok(errs({ duties: [] }).some((e) => e.includes('オブジェクトで書く')));
  assert.ok(errs({ duties: { audit: { interval: 60 } } }).some((e) => e.includes('不明なキー')));
  assert.ok(errs({ duties: { audit: { intervalMin: 0 } } }).some((e) => e.includes('1 以上の整数')));
  assert.ok(errs({ duties: { audit: { eventKinds: 'block' } } }).some((e) => e.includes('配列で書く')));
  assert.ok(errs({ duties: { audit: { eventKinds: ['blocked'] } } }).some((e) => e.includes('不明なイベント')));
  // pointer の 1 セグメントとして安定して書けるキーだけ (`/` や `~` はエスケープが要る)
  assert.ok(errs({ duties: { 'a/b': {} } }).some((e) => e.includes('英小文字・数字')));
  assert.ok(errs({ duties: { Audit: {} } }).some((e) => e.includes('英小文字・数字')));
  assert.ok(errs({ initiativeBudget: 1.5 }).some((e) => e.includes('initiativeBudget')));
});

// ---- 自律社会 (docs/society-ledger.md・§12.4) ----

test('society: 書いていない config には何も言わない (既定は off)', () => {
  assert.deepEqual(validateConfig(cfg()), []);
  assert.equal(Object.hasOwn(cfg(), 'society'), false);
  assert.equal(resolveSociety(cfg()).mode, 'off');
  assert.deepEqual(validateConfig(cfg({ society: { mode: 'off' } })), []);
});

test('society: validateConfig から validateSociety が呼ばれている', () => {
  const errs = (society) => validateConfig(cfg({ society, bots: { fable: bot(), sol: bot({ runtime: 'codex' }) } }));
  assert.ok(errs({ maxJobs: 1 }).some((e) => e.includes('society の未知のキー')));
  assert.ok(errs({ mode: 'on' }).some((e) => e.includes('society.mode')));
  assert.ok(errs({ maxJobsPerDay: 0 }).some((e) => e.includes('society.maxJobsPerDay')));
  // mandates の channels は config.channels と突き合わせる (cfg のチャンネルは sandbox だけ)
  const mandate = {
    version: 1, goal: 'g', tolerance: 't', channels: ['society-trial'],
    resources: { maxJobsPerDay: 2 }, escalate: 'e',
  };
  assert.ok(errs({ mandates: { delivery: mandate } }).some((e) => e.includes('channels が channels に無い')));
  assert.deepEqual(errs({ mandates: { delivery: { ...mandate, channels: ['sandbox'] } } }), []);
  // mode ≠ off は担当 bot の実在と runtime を見る
  assert.ok(errs({ mode: 'observe', authority: 'nobody' }).some((e) => e.includes('居ない bot')));
  assert.ok(errs({ mode: 'active', authority: 'sol' }).some((e) => e.includes('codex')));
  assert.deepEqual(errs({ mode: 'active' }), []);
});
