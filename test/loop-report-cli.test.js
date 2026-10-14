import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../scripts/loop-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'loop-report.mjs');

test('parseArgs: --channel は必須・既定は data/ と config.policy.json・期間は JST の暦日', () => {
  const opts = parseArgs(['--channel', 'proj']);
  assert.equal(opts.channel, 'proj');
  assert.match(opts.data, /[\\/]data$/);
  assert.match(opts.policy, /config\.policy\.json$/);
  assert.deepEqual([opts.since, opts.until, opts.json], [null, null, false]);
  const ranged = parseArgs(['--channel', 'proj', '--since', '2026-10-08', '--until', '2026-10-14', '--json', '--data', 'd', '--policy', 'p.json']);
  assert.equal(ranged.since, Date.parse('2026-10-08T00:00:00+09:00'));
  assert.equal(ranged.until, Date.parse('2026-10-15T00:00:00+09:00'));
  assert.deepEqual([ranged.json, ranged.data, ranged.policy], [true, 'd', 'p.json']);
});

test('parseArgs: チャンネル無し・知らないオプション・値無し・逆さの期間は断る', () => {
  assert.throws(() => parseArgs([]), /--channel/);
  assert.throws(() => parseArgs(['--channel', 'proj', '--runs', 'x.json']), /知らないオプション: --runs/);
  assert.throws(() => parseArgs(['--channel', 'proj', 'extra']), /知らないオプション: extra/);
  assert.throws(() => parseArgs(['--channel']), /値が渡されていません/);
  assert.throws(() => parseArgs(['--channel', 'proj', '--since', '--json']), /値が渡されていません/);
  assert.throws(() => parseArgs(['--channel', 'proj', '--since', '2026-10-14', '--until', '2026-10-13']), /--since は --until より前/);
});

describe('CLI (一時ディレクトリの台帳で走らせる。boots.json は置かない = 配備前)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-report-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, 'data');
  const policy = join(dir, 'policy.json');
  const now = Date.now();
  const iso = (agoMin) => new Date(now - agoMin * 60_000).toISOString();
  // 作業場所をこのリポジトリのルートにする (パスが同じなので git を呼ばずに本体と読み、boots の無いことで止まる)
  writeFileSync(policy, JSON.stringify({
    bots: {},
    channels: {
      proj: { cwd: ROOT, autonomy: { enabled: true, baseBranch: 'dev', scout: { bot: 'sc' }, planner: { bot: 'pl' }, harness: { bot: 'pl' }, maxJobsPerDay: 5 } },
    },
  }));
  const writeData = (files) => {
    rmSync(data, { recursive: true, force: true });
    mkdirSync(data, { recursive: true });
    for (const [name, value] of Object.entries(files)) writeFileSync(join(data, name), JSON.stringify(value));
  };
  const ledgers = {
    'job-runs.json': {
      j1: { id: 'j1', botKey: 'sc', channelName: 'proj', taskId: null, trigger: { kind: 'bot' }, acceptedAt: iso(30), startedAt: iso(30), endedAt: iso(20), evidence: { toolCalls: 12 } },
    },
    'tasks.json': {
      1: { id: '1', channel: 'proj', state: 'proposed', history: [{ at: iso(21), from: null, to: 'proposed', by: 'sc' }] },
    },
    'recovery.json': {},
    'inbox.json': { 1: { id: '1', channel: 'proj', openedAt: iso(90), closedAt: null } },
  };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, '--data', data, '--policy', policy, ...args], { encoding: 'utf8' });

  test('文を出し、boots が無いので ④ は「起動の記録なし」(0 にしない)・何も書かない', () => {
    writeData(ledgers);
    const before = readdirSync(data).sort();
    const res = cli('--channel', 'proj');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^回し方の成績 #proj /);
    assert.match(res.stdout, / スカウト 1・空 0・12\/12 \| 企画・改訂 0$/m);
    assert.match(res.stdout, /^④ 配備: 起動の記録なし — ④ は読めない \(boots\.json が無い\)$/m);
    assert.match(res.stdout, /^受信箱: 開いた用件 1 件・最古 1\.5 h /m);
    assert.equal(res.stdout.trimEnd().split('\n').filter((l) => /^\d\d-\d\d job /.test(l)).length, 7);
    assert.ok(res.stdout.trimEnd().length <= 1900);
    assert.deepEqual(readdirSync(data).sort(), before);
  });

  test('--json は集計をそのまま (時刻は +09:00)', () => {
    writeData(ledgers);
    const res = cli('--channel', 'proj', '--json');
    assert.equal(res.status, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.equal(json.channel, 'proj');
    assert.equal(json.deploy.status, 'unreadable');
    assert.match(json.at, /\+09:00$/);
    assert.equal(json.days.length, 7);
    assert.equal(json.inbox.open, 1);
  });

  test('設定に無いチャンネル・無い台帳・知らないオプションは exit 1 で理由を言う', () => {
    writeData(ledgers);
    const unknown = cli('--channel', 'nope');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /channels に nope がありません/);
    writeData(Object.fromEntries(Object.entries(ledgers).filter(([name]) => name !== 'recovery.json')));
    const missing = cli('--channel', 'proj');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /再開の台帳 .*recovery\.json を読めません/);
    const bad = cli('--channel', 'proj', '--bogus');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /知らないオプション: --bogus/);
  });
});
