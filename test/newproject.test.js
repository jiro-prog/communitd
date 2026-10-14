import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mergeConfigSources, validateConfig } from '../src/config.js';
import {
  DIRECTION_MAX_CHARS,
  NEW_PROJECT_DEFAULTS,
  buildAutonomousEntry,
  buildGitignore,
  buildReadme,
  checkDirectionText,
  parseNewProjectArgs,
  resolveProjectBots,
} from '../src/newproject.js';
import { addChannel } from '../src/project.js';

const REQUIRED = ['--name', 'demo', '--direction', 'd.md', '--verify', 'npm test'];

test('必須の 3 つがそろえば既定値で埋まる', () => {
  const { options, errors } = parseNewProjectArgs(REQUIRED);
  assert.deepEqual(errors, []);
  assert.deepEqual(options, {
    name: 'demo',
    direction: 'd.md',
    verify: 'npm test',
    tools: NEW_PROJECT_DEFAULTS.tools,
    baseBranch: NEW_PROJECT_DEFAULTS.baseBranch,
    parent: null,
    scout: null,
    workers: null,
    reviewer: null,
    dryRun: false,
  });
});

test('--scout / --worker / --reviewer を受け取る (worker はカンマ区切り)', () => {
  const { options } = parseNewProjectArgs([...REQUIRED, '--scout', 'a', '--worker', 'b, c', '--reviewer', 'd']);
  assert.equal(options.scout, 'a');
  assert.deepEqual(options.workers, ['b', 'c']);
  assert.equal(options.reviewer, 'd');
});

test('必須が欠けると全部まとめて知らせる', () => {
  const { options, errors } = parseNewProjectArgs([]);
  assert.equal(options, null);
  for (const key of ['--name', '--direction', '--verify']) {
    assert.ok(errors.some((e) => e.includes(key)), `${key} の欠落を知らせていない`);
  }
});

test('知らない引数・位置引数は黙って無視しない', () => {
  assert.ok(parseNewProjectArgs([...REQUIRED, '--force']).errors.length > 0);
  assert.ok(parseNewProjectArgs([...REQUIRED, 'extra']).errors.length > 0);
});

test('tools: readonly と知らない値は弾き、full は通す', () => {
  assert.ok(parseNewProjectArgs([...REQUIRED, '--tools', 'readonly']).errors.some((e) => e.includes('readonly')));
  assert.ok(parseNewProjectArgs([...REQUIRED, '--tools', 'root']).errors.length > 0);
  assert.equal(parseNewProjectArgs([...REQUIRED, '--tools', 'full']).options.tools, 'full');
});

test('base-branch: git の引数に化ける名前を弾く', () => {
  for (const bad of ['-x', 'a b', 'a..b', 'main/', '']) {
    const { errors } = parseNewProjectArgs([...REQUIRED, '--base-branch', bad]);
    if (bad === '') continue; // 空は既定値へ倒れる
    assert.ok(errors.length > 0, `通ってしまう: ${bad}`);
  }
  assert.equal(parseNewProjectArgs([...REQUIRED, '--base-branch', 'master']).options.baseBranch, 'master');
  assert.equal(parseNewProjectArgs([...REQUIRED, '--base-branch', '']).options.baseBranch, 'main');
});

test('--dry-run と --parent を受け取る', () => {
  const { options } = parseNewProjectArgs([...REQUIRED, '--dry-run', '--parent', 'C:/work']);
  assert.equal(options.dryRun, true);
  assert.equal(options.parent, 'C:/work');
});

test('方向性ドキュメント: 空と厚すぎだけを止める', () => {
  assert.ok(checkDirectionText('').length > 0);
  assert.ok(checkDirectionText('   \n').length > 0);
  assert.ok(checkDirectionText(undefined).length > 0);
  assert.ok(checkDirectionText('x'.repeat(DIRECTION_MAX_CHARS + 1)).length > 0);
  assert.deepEqual(checkDirectionText('# 方向\n\n- やること'), []);
});

const BOTS = { scout: 'alpha', workers: ['alpha'], reviewer: 'beta' };

/** 自律運転のチャンネルを持つ設定 (bot のキーは配備ごとに違うので、例とも作者の環境とも別の名前) */
function configWith(channels) {
  return {
    bots: { alpha: {}, beta: {}, gamma: {} },
    channels,
  };
}

function autonomous({ scout, workers, reviewer, enabled = true }) {
  return {
    cwd: 'C:/p',
    autonomy: {
      enabled,
      ...(scout ? { scout: { bot: scout } } : {}),
      worker: { bots: workers },
      reviewer,
    },
  };
}

test('自律運転のエントリは起動時検証を通る (verify・hooks・自己レビュー禁止を満たす)', () => {
  const entry = buildAutonomousEntry({ cwd: 'C:/projects/demo', verify: 'npm test', bots: BOTS });
  assert.equal(entry.autonomy.enabled, true);
  assert.equal(entry.hooks, true);
  assert.equal(entry.verify, 'npm test');
  assert.equal(entry.autonomy.scout.bot, 'alpha');
  assert.equal(entry.autonomy.reviewer, 'beta');
  const policy = {
    bots: {
      alpha: { tokenEnv: 'ALPHA_TOKEN', model: 'opus' },
      beta: { tokenEnv: 'BETA_TOKEN', model: 'opus' },
    },
    channels: {},
  };
  const secrets = { guildId: '1', allowedUserIds: ['2'] };
  const { config, errors } = mergeConfigSources(addChannel(policy, 'demo', entry), secrets);
  assert.deepEqual(errors, []);
  const problems = validateConfig(config);
  assert.deepEqual(problems.filter((line) => line.includes('channels.demo')), []);
});

test('エントリの worker 配列は渡した配列と別物 (書き換えても呼び出し元が汚れない)', () => {
  const a = buildAutonomousEntry({ cwd: 'C:/a', verify: 'v', bots: BOTS });
  a.autonomy.worker.bots.push('x');
  assert.deepEqual(BOTS.workers, ['alpha']);
});

test('bot: 既存の自律運転チャンネルのうち最後に足したものに揃える', () => {
  const config = configWith({
    old: autonomous({ scout: 'beta', workers: ['beta'], reviewer: 'alpha' }),
    latest: autonomous({ scout: 'alpha', workers: ['alpha', 'gamma'], reviewer: 'beta' }),
    manual: { cwd: 'C:/m' },
  });
  const { bots, from, errors } = resolveProjectBots(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(bots, { scout: 'alpha', workers: ['alpha', 'gamma'], reviewer: 'beta' });
  assert.equal(from, 'latest');
  bots.workers.push('x');
  assert.deepEqual(config.channels.latest.autonomy.worker.bots, ['alpha', 'gamma'], '揃えた元の配列を汚した');
});

test('bot: 止めているチャンネルと scout の無いチャンネルは揃える元にしない', () => {
  const config = configWith({
    base: autonomous({ scout: 'alpha', workers: ['alpha'], reviewer: 'beta' }),
    stopped: autonomous({ scout: 'gamma', workers: ['gamma'], reviewer: 'alpha', enabled: false }),
    noScout: autonomous({ workers: ['beta'], reviewer: 'gamma' }),
  });
  assert.equal(resolveProjectBots(config).from, 'base');
});

test('bot: 引数で指定したものが優先、残りは揃える', () => {
  const config = configWith({ base: autonomous({ scout: 'alpha', workers: ['alpha'], reviewer: 'beta' }) });
  const partial = resolveProjectBots(config, { reviewer: 'gamma' });
  assert.deepEqual(partial.bots, { scout: 'alpha', workers: ['alpha'], reviewer: 'gamma' });
  assert.equal(partial.from, 'base');
  const all = resolveProjectBots(config, { scout: 'gamma', workers: ['gamma'], reviewer: 'alpha' });
  assert.deepEqual(all.bots, { scout: 'gamma', workers: ['gamma'], reviewer: 'alpha' });
  assert.equal(all.from, null, '全部を引数で決めたのに揃えた元を名乗る');
});

test('bot: 揃える元が無く指定も足りなければ、足りない引数と使える bot を知らせる', () => {
  const { bots, errors } = resolveProjectBots(configWith({}), { scout: 'alpha' });
  assert.equal(bots, null);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('--worker') && errors[0].includes('--reviewer'));
  assert.ok(!errors[0].includes('--scout'), '指定済みの --scout まで求めている');
  assert.ok(errors[0].includes('alpha / beta / gamma'));
});

test('公開の設定例のままでも、bot を指定すれば起動時検証を通る (設定例の bot は manager / worker)', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const policy = read('config.policy.example.json');
  const secrets = read('config.secrets.example.json');
  const { config: base } = mergeConfigSources(policy, secrets);
  assert.ok(resolveProjectBots(base).errors.length > 0, '設定例に自律運転のチャンネルが入った — 下の前提を見直す');

  const { bots, errors } = resolveProjectBots(base, { scout: 'worker', workers: ['worker'], reviewer: 'manager' });
  assert.deepEqual(errors, []);
  const entry = buildAutonomousEntry({ cwd: 'C:/projects/demo', verify: 'npm test', bots });
  const { config, errors: mergeErrors } = mergeConfigSources(addChannel(policy, 'demo', entry), secrets);
  assert.deepEqual(mergeErrors, []);
  assert.deepEqual(validateConfig(config).filter((line) => line.includes('channels.demo')), []);
});

test('.gitignore はタスクの作業ツリー (.worktrees/) を無視する (無いとタスク job が作業ツリーを作れない)', () => {
  const lines = buildGitignore().split('\n').map((l) => l.trim());
  assert.ok(lines.includes('.worktrees/'));
});

test('new-project は .gitignore を初回 commit に明示パスで入れる', () => {
  const script = readFileSync(new URL('../scripts/new-project.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes("writeFileSync(resolve(cwd, '.gitignore'), buildGitignore())"));
  assert.ok(script.includes("git(['add', '--', 'README.md', '.gitignore', NEW_PROJECT_DEFAULTS.directionFile])"));
});

test('README は方向性ドキュメントを正本として指す', () => {
  const readme = buildReadme({ name: 'demo' });
  assert.match(readme, /^# demo/);
  assert.ok(readme.includes(NEW_PROJECT_DEFAULTS.directionFile));
});
