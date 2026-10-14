import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthorizedSender, isMaintenanceBot, roleIdsOf, senderKindOf } from '../src/authz.js';

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

const withRoles = { ...config, allowedRoleIds: ['R1'] };

test('許可ロールを持つ人は allowedUserIds に居なくても通る', () => {
  assert.equal(
    isAuthorizedSender(sender({ config: withRoles, authorId: 'U9', roleIds: ['R1'] })),
    true,
  );
  // 複数持ちでも 1 つ一致すれば通る
  assert.equal(
    isAuthorizedSender(sender({ config: withRoles, authorId: 'U9', roleIds: ['R0', 'R1'] })),
    true,
  );
});

test('ロールが違う / 持っていない人は通らない', () => {
  for (const roleIds of [['R2'], [], undefined, null, ['']]) {
    assert.equal(
      isAuthorizedSender(sender({ config: withRoles, authorId: 'U9', roleIds })),
      false,
      `通してしまう: ${JSON.stringify(roleIds)}`,
    );
  }
});

test('allowedRoleIds が空 / 未設定ならロールでは誰も増えない', () => {
  for (const allowedRoleIds of [undefined, [], [''], 'R1']) {
    assert.equal(
      isAuthorizedSender(sender({ config: { ...config, allowedRoleIds }, authorId: 'U9', roleIds: ['R1'] })),
      false,
      `通してしまう: ${JSON.stringify(allowedRoleIds)}`,
    );
  }
});

test('発言者 ID が取れないものはロールを持っていても通さない', () => {
  // ロールを足す前は「allowedUserIds に undefined は入っていない」で必ず false だった層
  for (const authorId of [undefined, null, '', 123]) {
    assert.equal(
      isAuthorizedSender(sender({ config: withRoles, authorId, roleIds: ['R1'] })),
      false,
      `通してしまう: ${String(authorId)}`,
    );
  }
});

test('@everyone (= guildId) は判定側でも落とす (検証を通らない config が来た日のため)', () => {
  // GuildMemberRoleManager は roles.cache に必ず guild.id を入れる = 全員が持っているロール
  const everyone = { ...config, allowedRoleIds: ['G1'] };
  assert.equal(
    isAuthorizedSender(sender({ config: everyone, authorId: 'U9', roleIds: ['G1'] })),
    false,
  );
  // 他のロールと一緒に書いてあっても、落ちるのは @everyone だけ
  const mixed = { ...config, allowedRoleIds: ['G1', 'R1'] };
  assert.equal(isAuthorizedSender(sender({ config: mixed, authorId: 'U9', roleIds: ['G1'] })), false);
  assert.equal(isAuthorizedSender(sender({ config: mixed, authorId: 'U9', roleIds: ['R1'] })), true);
});

test('ロールは Guild の境界も bot の扱いも緩めない', () => {
  // 別 Guild のロールは (ID が一致していても) 通さない
  assert.equal(
    isAuthorizedSender(sender({ config: withRoles, guildId: 'G2', authorId: 'U9', roleIds: ['R1'] })),
    false,
  );
  // 他所の bot はロールを持っていても通さない
  assert.equal(
    isAuthorizedSender(sender({ config: withRoles, isBot: true, authorId: 'X9', roleIds: ['R1'] })),
    false,
  );
});

test('roleIdsOf は discord.js の 2 つの形と「取れなかった」を吸収する', () => {
  // キャッシュのある GuildMember (Collection)
  assert.deepEqual(roleIdsOf({ roles: { cache: new Map([['R1', {}], ['R2', {}]]) } }), ['R1', 'R2']);
  // 未キャッシュの interaction (APIInteractionGuildMember)
  assert.deepEqual(roleIdsOf({ roles: ['R1', 'R2'] }), ['R1', 'R2']);
  // member が取れない・形が違う → 空 (ロールでは通さない)
  for (const member of [null, undefined, {}, { roles: null }, { roles: {} }, { roles: 'R1' }]) {
    assert.deepEqual(roleIdsOf(member), [], `空でない: ${JSON.stringify(member)}`);
  }
  // 空文字や非文字列は落とす (allowedRoleIds 側の書き損じと噛み合わせない)
  assert.deepEqual(roleIdsOf({ roles: ['', 'R1', null, 7] }), ['R1']);
});

// ---- メンテ用の bot (maintenanceBotIds) ----

const withMaint = { ...config, maintenanceBotIds: ['MB'] };

test('メンテ用に登録した bot は通り、登録していない他所の bot は今までどおり拒否', () => {
  assert.equal(isAuthorizedSender(sender({ config: withMaint, authorId: 'MB', isBot: true })), true);
  assert.equal(isAuthorizedSender(sender({ config: withMaint, authorId: 'XB', isBot: true })), false);
  // 書いていない配備では、メンテ用の口は開かない
  assert.equal(isAuthorizedSender(sender({ authorId: 'MB', isBot: true })), false);
  // 別 Guild からは、メンテ用の bot でも通さない
  assert.equal(isAuthorizedSender(sender({ config: withMaint, authorId: 'MB', isBot: true, guildId: 'G2' })), false);
});

test('メンテ用の ID を人間が名乗っても、人間としての許可リストでしか通らない', () => {
  // isBot=false の発言は allowedUserIds の照合だけ (メンテ用の ID は人間の許可にならない)
  assert.equal(isAuthorizedSender(sender({ config: withMaint, authorId: 'MB', isBot: false })), false);
});

test('senderKindOf: 人間 / 自前の bot / メンテ用の bot を分ける', () => {
  assert.equal(senderKindOf({ config: withMaint, authorId: 'U1', isBot: false, ourBotIds }), 'human');
  assert.equal(senderKindOf({ config: withMaint, authorId: 'B1', isBot: true, ourBotIds }), 'bot');
  assert.equal(senderKindOf({ config: withMaint, authorId: 'MB', isBot: true, ourBotIds }), 'maintenance');
  // 自前の bot の ID をメンテ用に書いても bot のまま (登録の重複で権限を広げない)
  const dup = { ...config, maintenanceBotIds: ['B1'] };
  assert.equal(senderKindOf({ config: dup, authorId: 'B1', isBot: true, ourBotIds }), 'bot');
});

test('isMaintenanceBot: 空・非文字列の ID は一致させない', () => {
  assert.equal(isMaintenanceBot(withMaint, 'MB'), true);
  assert.equal(isMaintenanceBot(withMaint, ''), false);
  assert.equal(isMaintenanceBot(withMaint, undefined), false);
  assert.equal(isMaintenanceBot({ ...config, maintenanceBotIds: ['', null] }, ''), false);
  assert.equal(isMaintenanceBot(config, 'MB'), false);
});

// ---- 受付 bot の中継 (docs/notes/2026-10-11-intake.md) ----

test('senderKindOf: 受付 bot の投稿は relay (人間の枝へ通す中継)', () => {
  const relayBotIds = ['B2'];
  assert.equal(senderKindOf({ config, authorId: 'B2', isBot: true, ourBotIds, relayBotIds }), 'relay');
  // 受付 bot 以外の自前の bot は bot のまま
  assert.equal(senderKindOf({ config, authorId: 'B1', isBot: true, ourBotIds, relayBotIds }), 'bot');
  // 人間が受付 bot の ID を名乗っても人間 (isBot が先)
  assert.equal(senderKindOf({ config, authorId: 'B2', isBot: false, ourBotIds, relayBotIds }), 'human');
  // 渡さなければ今までどおり
  assert.equal(senderKindOf({ config, authorId: 'B2', isBot: true, ourBotIds }), 'bot');
  // 空の ID は一致させない
  assert.equal(senderKindOf({ config, authorId: '', isBot: true, ourBotIds, relayBotIds: [''] }), 'bot');
});
