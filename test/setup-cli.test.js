// プロジェクトを足す CLI の共通の読み書き (src/setup-cli.js) の中止の経路。
// abort は「戻らない」約束なので、テストでは例外を投げる関数を渡す — 戻ってしまうと
// 中止の後ろの処理 (存在しないファイルの読み込みなど) が走り、別の失敗に化ける。
//
// Discord へ実際に繋ぐ分岐 (listChannels など) は扱わない。connectDiscord の成功側は
// REST を組み立てるだけでネットワークに出ないので、伏字の対象 (tokens) まではここで見る。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { POLICY_FILE, SECRETS_FILE } from '../src/config.js';
import { createSetupIo } from '../src/setup-cli.js';

class Aborted extends Error {}

function abort(message) {
  throw new Aborted(message);
}

/** 中止されたこと・理由の文言が入っていることを見る */
function assertAborts(fn, ...fragments) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Aborted, `abort 以外で落ちた: ${err?.stack ?? err}`);
    for (const fragment of fragments) {
      assert.ok(err.message.includes(fragment), `「${fragment}」が中止理由に無い:\n${err.message}`);
    }
    return true;
  });
}

const BOT = { displayName: 'Alpha', model: 'm', rolePromptFile: 'roles/worker.md' };
const POLICY = { bots: { alpha: { ...BOT, tokenEnv: 'ALPHA_TOKEN' } }, channels: {} };
const SECRETS = { guildId: '1', allowedUserIds: ['2'] };

/** 一時ディレクトリを root にする。値が文字列ならそのまま、オブジェクトなら JSON で書く */
function makeRoot(t, { policy, secrets } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'communitd-setup-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of [[POLICY_FILE, policy], [SECRETS_FILE, secrets]]) {
    if (value === undefined) continue;
    writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return root;
}

/** root 直下の名前と中身 — 中止の前後で比べて「何も書いていない」を見る */
function snapshot(root) {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name);
        return [name, statSync(path).isDirectory() ? '<dir>' : readFileSync(path, 'utf8')];
      }),
  );
}

/** loadConfig が中止し、root を書き換えていないことを見る */
function assertLoadAborts(root, ...fragments) {
  const before = snapshot(root);
  const io = createSetupIo({ root, abort, env: {} });
  assertAborts(() => io.loadConfig(), ...fragments);
  assert.deepEqual(snapshot(root), before, '中止したのにファイルが変わった');
}

test('パスは root 直下の policy / secrets を指す', (t) => {
  const root = makeRoot(t);
  const io = createSetupIo({ root, abort, env: {} });
  assert.equal(io.policyPath, resolve(root, POLICY_FILE));
  assert.equal(io.secretsPath, resolve(root, SECRETS_FILE));
});

test('loadConfig: 揃っていれば合成後の config と生の中身を返す', (t) => {
  const root = makeRoot(t, { policy: POLICY, secrets: SECRETS });
  const io = createSetupIo({ root, abort, env: {} });
  const loaded = io.loadConfig();
  assert.deepEqual(loaded.config, { ...POLICY, ...SECRETS });
  assert.deepEqual(loaded.policy, POLICY);
  assert.deepEqual(loaded.secrets, SECRETS);
  // 保存直前の「途中で誰かが触っていないか」の照合に使うので、読んだ文字列そのものであること
  assert.equal(loaded.policyRaw, readFileSync(join(root, POLICY_FILE), 'utf8'));
  assert.equal(loaded.secretsRaw, readFileSync(join(root, SECRETS_FILE), 'utf8'));
});

test('loadConfig: ファイルが無ければ中止し、何も作らない', (t) => {
  // 両方無い → 先に読む policy で止まる
  const empty = makeRoot(t);
  assertLoadAborts(empty, `${POLICY_FILE} がありません`, resolve(empty, POLICY_FILE), 'SETUP.md §0');
  assert.deepEqual(readdirSync(empty), []);

  const noSecrets = makeRoot(t, { policy: POLICY });
  assertLoadAborts(noSecrets, `${SECRETS_FILE} がありません`, resolve(noSecrets, SECRETS_FILE));
  assert.deepEqual(readdirSync(noSecrets), [POLICY_FILE]);
});

test('loadConfig: ファイルとして読めなければ中止する', (t) => {
  const root = makeRoot(t, { secrets: SECRETS });
  mkdirSync(join(root, POLICY_FILE));
  assertLoadAborts(root, `${POLICY_FILE} を読めません`);
});

test('loadConfig: JSON として壊れていれば中止する', (t) => {
  assertLoadAborts(makeRoot(t, { policy: '{ "bots": ', secrets: SECRETS }), `${POLICY_FILE} を JSON として読めません`);
  assertLoadAborts(makeRoot(t, { policy: POLICY, secrets: '{ guildId: 1 }' }), `${SECRETS_FILE} を JSON として読めません`);
});

test('loadConfig: 2 つを合成できなければ理由を並べて中止する (追記していない)', (t) => {
  const cases = [
    // policy がオブジェクトでない
    [{ policy: '[]', secrets: SECRETS }, `${POLICY_FILE} がオブジェクトとして読めない`],
    // 秘密のキーが policy 側にある
    [{ policy: { ...POLICY, guildId: '1' }, secrets: SECRETS }, `${POLICY_FILE} に置けないキー: guildId`],
    // secrets に置けないキーがある
    [{ policy: POLICY, secrets: { ...SECRETS, channels: {} } }, `${SECRETS_FILE} に置けないキー: channels`],
  ];
  for (const [files, reason] of cases) {
    assertLoadAborts(makeRoot(t, files), '設定ファイルを合成できません', `  - ${reason}`, '中止しました (追記していません)');
  }
});

test('checkExisting: 起動時検証を通る設定なら何もしない', (t) => {
  const root = makeRoot(t, { policy: POLICY, secrets: SECRETS });
  const io = createSetupIo({ root, abort, env: {} });
  assert.equal(io.checkExisting(io.loadConfig().config), undefined);
});

test('checkExisting: 既存の設定が検証に落ちれば中止し、何も書かない', (t) => {
  // 合成はできるが guildId が無い
  const root = makeRoot(t, { policy: POLICY, secrets: { allowedUserIds: ['2'] } });
  const before = snapshot(root);
  const io = createSetupIo({ root, abort, env: {} });
  const { config } = io.loadConfig();
  assertAborts(
    () => io.checkExisting(config),
    `既存の設定 (${POLICY_FILE} + ${SECRETS_FILE}) に問題があります`,
    '  - guildId が未設定',
    '中止しました (追記していません)',
  );
  assert.deepEqual(snapshot(root), before);
});

test('connectDiscord: bot が 0 件なら Discord へ繋ぐ前に中止する', (t) => {
  const io = createSetupIo({ root: makeRoot(t), abort, env: { ALPHA_TOKEN: 'tok-alpha' } });
  assertAborts(() => io.connectDiscord({ ...SECRETS, bots: {} }), `${POLICY_FILE} に bots がありません`);
  assertAborts(() => io.connectDiscord({ ...SECRETS }), `${POLICY_FILE} に bots がありません`);
});

test('connectDiscord: チャンネルを作る bot のトークンが env に無ければ起動方法を案内して中止する', (t) => {
  const root = makeRoot(t);
  // 他の bot のトークンがあっても、作る役 (先頭) のが無ければ止まる
  const config = {
    ...SECRETS,
    bots: { alpha: { ...BOT, tokenEnv: 'ALPHA_TOKEN' }, beta: { ...BOT, tokenEnv: 'BETA_TOKEN' } },
  };
  const env = { BETA_TOKEN: 'tok-beta' };

  const byDefault = createSetupIo({ root, abort, env });
  assertAborts(() => byDefault.connectDiscord(config), 'ALPHA_TOKEN が環境にありません', 'npm run add-project から起動');

  const custom = createSetupIo({ root, abort, env, launchHint: 'npm run new-project' });
  assertAborts(() => custom.connectDiscord(config), 'ALPHA_TOKEN が環境にありません', 'npm run new-project から起動');

  // 空文字は「無い」と同じ
  const blank = createSetupIo({ root, abort, env: { ALPHA_TOKEN: '' } });
  assertAborts(() => blank.connectDiscord(config), 'ALPHA_TOKEN が環境にありません');
});

test('connectDiscord: 伏字の対象は env にトークンがある bot だけ (無い bot を除く)', (t) => {
  const config = {
    ...SECRETS,
    bots: {
      alpha: { ...BOT, tokenEnv: 'ALPHA_TOKEN' },
      beta: { ...BOT, tokenEnv: 'BETA_TOKEN' },
      gamma: { ...BOT, tokenEnv: 'GAMMA_TOKEN' },
    },
  };
  const env = { ALPHA_TOKEN: 'tok-alpha', GAMMA_TOKEN: 'tok-gamma' };
  const io = createSetupIo({ root: makeRoot(t), abort, env });
  // ネットワークに出るのは discord.* を呼んだときだけ — ここでは呼ばない
  const { creator, tokens, discord } = io.connectDiscord(config);
  assert.equal(creator.key, 'alpha');
  assert.deepEqual(tokens, ['tok-alpha', 'tok-gamma']);
  assert.deepEqual(
    Object.keys(discord).sort(),
    ['createChannel', 'deleteChannel', 'listChannels'],
  );
  for (const fn of Object.values(discord)) assert.equal(typeof fn, 'function');
});
