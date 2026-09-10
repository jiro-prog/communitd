import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEnv } from '../src/proc.js';

test('指定キーを子プロセス env から除去する', () => {
  const base = { PATH: '/usr/bin', FABLE_DISCORD_TOKEN: 'secret', OPUS_DISCORD_TOKEN: 'secret2' };
  const env = scrubEnv(base, ['FABLE_DISCORD_TOKEN', 'OPUS_DISCORD_TOKEN']);
  assert.equal(env.PATH, '/usr/bin');
  assert.ok(!('FABLE_DISCORD_TOKEN' in env));
  assert.ok(!('OPUS_DISCORD_TOKEN' in env));
});

test('元の env を書き換えない (親プロセスのトークンは残る)', () => {
  const base = { FABLE_DISCORD_TOKEN: 'secret' };
  scrubEnv(base, ['FABLE_DISCORD_TOKEN']);
  assert.equal(base.FABLE_DISCORD_TOKEN, 'secret');
});

test('存在しないキー・空リストでも落ちない', () => {
  assert.deepEqual(scrubEnv({ A: '1' }, ['NOPE']), { A: '1' });
  assert.deepEqual(scrubEnv({ A: '1' }, []), { A: '1' });
  assert.deepEqual(scrubEnv({ A: '1' }), { A: '1' });
});

test('process.env をそのまま渡しても親の env は無傷', () => {
  process.env.COMMUNITD_TEST_TOKEN = 'secret';
  try {
    const env = scrubEnv(process.env, ['COMMUNITD_TEST_TOKEN']);
    assert.ok(!('COMMUNITD_TEST_TOKEN' in env));
    assert.equal(process.env.COMMUNITD_TEST_TOKEN, 'secret');
  } finally {
    delete process.env.COMMUNITD_TEST_TOKEN;
  }
});
