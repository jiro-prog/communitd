import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthorizedSender } from '../src/authz.js';

const config = { guildId: 'G1', allowedUserIds: ['U1', 'U2'] };
const ourBotIds = ['B1', 'B2'];

function sender(patch = {}) {
  return { config, guildId: 'G1', authorId: 'U1', isBot: false, ourBotIds, ...patch };
}

test('許可ユーザーの発言は通る', () => {
  assert.equal(isAuthorizedSender(sender()), true);
  assert.equal(isAuthorizedSender(sender({ authorId: 'U2' })), true);
});

test('別 Guild からの発言は拒否', () => {
  assert.equal(isAuthorizedSender(sender({ guildId: 'G2' })), false);
  assert.equal(isAuthorizedSender(sender({ guildId: null })), false);
});

test('許可リスト外の人間は拒否', () => {
  assert.equal(isAuthorizedSender(sender({ authorId: 'U9' })), false);
});

test('自前 bot は通り、他所の bot は拒否', () => {
  assert.equal(isAuthorizedSender(sender({ isBot: true, authorId: 'B1' })), true);
  assert.equal(isAuthorizedSender(sender({ isBot: true, authorId: 'X9' })), false);
  // 自前 bot は allowedUserIds に載っていなくても通る (Fable → Opus 委譲)
  assert.equal(isAuthorizedSender(sender({ isBot: true, authorId: 'B2' })), true);
});

test('config 側が空なら誰も通さない (設定漏れ = 全開放にしない)', () => {
  assert.equal(isAuthorizedSender(sender({ config: {} })), false);
  assert.equal(isAuthorizedSender(sender({ config: { guildId: '' } })), false);
  assert.equal(
    isAuthorizedSender(sender({ config: { guildId: 'G1' }, authorId: 'U1' })),
    false,
  );
  // guildId が無ければ bot 発言も通さない
  assert.equal(isAuthorizedSender(sender({ config: {}, isBot: true, authorId: 'B1' })), false);
});

test('ourBotIds 未指定でも bot 発言は素通りしない', () => {
  assert.equal(
    isAuthorizedSender({ config, guildId: 'G1', authorId: 'B1', isBot: true }),
    false,
  );
});
