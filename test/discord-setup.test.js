import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TEXT_CHANNEL_TYPE,
  createChannelAndSave,
  ensureChannel,
  matchTextChannels,
  pickChannelCreator,
  redact,
  rollbackChannel,
} from '../src/discord-setup.js';

const GUILD = 'G1';
const TOKEN = 'MTIzNDU2Nzg5.SECRET.TOKEN-VALUE';

/**
 * Discord API の fake。呼ばれた順を log に残し、失敗を差し込める。
 * 作成したチャンネルは一覧にも現れる (作成後の一意性確認を実挙動どおりにする)。
 */
function fakeDiscord({ channels = [], faults = {}, log = [] } = {}) {
  const state = [...channels];
  let listCalls = 0;
  return {
    log,
    listChannels: async (guildId) => {
      log.push(`list:${guildId}`);
      listCalls++;
      if (faults.list) throw faults.list;
      if (listCalls > 1 && faults.listAfterCreate) throw faults.listAfterCreate;
      if (listCalls > 1 && faults.listAfterCreateReturns) return [...faults.listAfterCreateReturns];
      return [...state];
    },
    createChannel: async (guildId, body) => {
      log.push(`create:${guildId}:${body.name}:${body.type}`);
      if (faults.create) throw faults.create;
      const created = faults.createReturns ?? { id: 'C-NEW', name: body.name, type: body.type };
      if (created.id) state.push(created);
      return created;
    },
    deleteChannel: async (channelId) => {
      log.push(`delete:${channelId}`);
      if (faults.delete) throw faults.delete;
      const i = state.findIndex((c) => c.id === channelId);
      if (i >= 0) state.splice(i, 1);
    },
  };
}

const err = (status, message) => Object.assign(new Error(message), { status });

test('チャンネル作成担当は config.bots の先頭 (bot キーを決め打ちしない)', () => {
  // 顔ぶれは配備ごとに違うので、コード側に特定の bot キーの既定を持たない
  const config = { bots: { second: { displayName: 'Second' }, first: { displayName: 'First' } } };
  assert.equal(pickChannelCreator(config).key, 'second', '先頭を採っていない');
  // 指名したいときだけ preferred を渡す。居なければ先頭へ倒す
  assert.equal(pickChannelCreator(config, 'first').key, 'first');
  assert.equal(pickChannelCreator(config, 'nobody').key, 'second');
  assert.equal(pickChannelCreator({ bots: {} }), null);
  assert.equal(pickChannelCreator({}), null);
  assert.equal(pickChannelCreator(), null);
});

test('同名テキストチャンネルを列挙する (大小文字を無視・種別で絞る)', () => {
  const channels = [
    { id: '1', name: 'general', type: TEXT_CHANNEL_TYPE },
    { id: '2', name: 'Kumamikan', type: TEXT_CHANNEL_TYPE },
    { id: '3', name: 'voice-room', type: 2 },
    { id: '4', name: 'kumamikan', type: TEXT_CHANNEL_TYPE },
  ];
  assert.deepEqual(matchTextChannels(channels, 'kumamikan'), [
    { id: '2', name: 'Kumamikan' },
    { id: '4', name: 'kumamikan' },
  ]);
  assert.deepEqual(matchTextChannels(channels, 'general'), [{ id: '1', name: 'general' }]);
  assert.deepEqual(matchTextChannels(channels, 'voice-room'), [], 'ボイスチャンネルを拾っている');
  assert.deepEqual(matchTextChannels(channels, 'nowhere'), []);
  assert.deepEqual(matchTextChannels(channels, ''), []);
  assert.deepEqual(matchTextChannels(null, 'general'), []);
});

test('トークンはエラー文から伏せる', () => {
  assert.equal(redact(`401: ${TOKEN} is invalid`, [TOKEN]), '401: *** is invalid');
  assert.equal(redact(new Error(`auth ${TOKEN}`), [TOKEN]), 'auth ***');
  // 短い文字列を伏字対象にすると無関係な語まで壊すので対象外
  assert.equal(redact('abc の話', ['abc']), 'abc の話');
  assert.equal(redact(undefined, [TOKEN]), 'undefined');
});

test('正常系: 無ければテキストチャンネルを作り、作成後に一意性を確かめる', async () => {
  const discord = fakeDiscord();
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.deepEqual(result, { ok: true, channel: { id: 'C-NEW', name: 'newproj' }, created: true });
  assert.deepEqual(discord.log, [
    'list:G1',
    `create:G1:newproj:${TEXT_CHANNEL_TYPE}`,
    'list:G1', // 作成後の確認
  ]);
});

test('重複: 同名が複数あれば中止する (どれも同じ設定で動いてしまうため)', async () => {
  const discord = fakeDiscord({
    channels: [
      { id: 'C-1', name: 'newproj', type: TEXT_CHANNEL_TYPE },
      { id: 'C-2', name: 'NewProj', type: TEXT_CHANNEL_TYPE },
    ],
  });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.match(result.message, /C-1, C-2/);
  assert.deepEqual(discord.log, ['list:G1'], '重複しているのに作成している');
});

test('重複: 作成直後に同名が増えていたら、作った分を消して中止する', async () => {
  const discord = fakeDiscord({
    faults: {
      listAfterCreateReturns: [
        { id: 'C-NEW', name: 'newproj', type: TEXT_CHANNEL_TYPE },
        { id: 'C-RACE', name: 'newproj', type: TEXT_CHANNEL_TYPE },
      ],
    },
  });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.match(result.message, /削除しました/);
  assert.deepEqual(discord.log, [
    'list:G1',
    `create:G1:newproj:${TEXT_CHANNEL_TYPE}`,
    'list:G1',
    'delete:C-NEW',
  ]);
});

test('作成後の一覧に自分のチャンネルが無ければ中止する (0 件)', async () => {
  const discord = fakeDiscord({ faults: { listAfterCreateReturns: [] } });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unverified');
  assert.match(result.message, /一覧に見つかりません/);
  assert.ok(discord.log.includes('delete:C-NEW'), '確認できないのにチャンネルを残している');
});

test('作成後の一覧が別 ID の同名 1 件なら中止する (他所が作ったもの)', async () => {
  const discord = fakeDiscord({
    faults: {
      listAfterCreateReturns: [{ id: 'C-OTHER', name: 'newproj', type: TEXT_CHANNEL_TYPE }],
    },
  });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unverified');
  assert.match(result.message, /別のチャンネル \(ID: C-OTHER\)/);
  assert.ok(discord.log.includes('delete:C-NEW'), '自分が作った分を消していない');
});

test('作成後の確認ができなければ、作った分を消して中止する', async () => {
  const discord = fakeDiscord({ faults: { listAfterCreate: err(500, 'Service Unavailable') } });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'api-failed');
  assert.match(result.message, /削除しました/);
  assert.ok(discord.log.includes('delete:C-NEW'), '確認できないのにチャンネルを残している');
});

test('重複: 同名があれば作らずそれを使う', async () => {
  const discord = fakeDiscord({
    channels: [{ id: 'C-OLD', name: 'newproj', type: TEXT_CHANNEL_TYPE }],
  });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj' });
  assert.deepEqual(result, { ok: true, channel: { id: 'C-OLD', name: 'newproj' }, created: false });
  assert.deepEqual(discord.log, ['list:G1'], '既存があるのに作成 API を呼んでいる');
});

test('権限不足: 403 は理由と対処を返し、作成もしない', async () => {
  const discord = fakeDiscord({ faults: { create: err(403, 'Missing Permissions') } });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj', secrets: [TOKEN] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'forbidden');
  assert.match(result.message, /チャンネルの管理/);

  // 一覧取得の時点で 403 なら作成を試みない
  const denied = fakeDiscord({ faults: { list: err(403, 'Missing Access') } });
  const listResult = await ensureChannel({ discord: denied, guildId: GUILD, name: 'newproj' });
  assert.equal(listResult.reason, 'forbidden');
  assert.deepEqual(denied.log, ['list:G1']);
});

test('API 失敗: 500 や 401 は理由を分けて返す', async () => {
  const down = fakeDiscord({ faults: { create: err(500, 'Internal Server Error') } });
  const result = await ensureChannel({ discord: down, guildId: GUILD, name: 'newproj' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'api-failed');

  const bad = fakeDiscord({ faults: { list: err(401, 'Unauthorized') } });
  const unauthorized = await ensureChannel({ discord: bad, guildId: GUILD, name: 'newproj' });
  assert.equal(unauthorized.reason, 'unauthorized');
  assert.match(unauthorized.message, /トークンを確認/);

  // id を返さない応答も失敗として扱う
  const broken = fakeDiscord({ faults: { createReturns: { name: 'newproj' } } });
  const noId = await ensureChannel({ discord: broken, guildId: GUILD, name: 'newproj' });
  assert.equal(noId.ok, false);
  assert.equal(noId.reason, 'api-failed');
});

test('失敗メッセージにトークンを出さない', async () => {
  const discord = fakeDiscord({ faults: { create: err(500, `token=${TOKEN} で失敗`) } });
  const result = await ensureChannel({ discord, guildId: GUILD, name: 'newproj', secrets: [TOKEN] });
  assert.equal(result.message.includes(TOKEN), false, 'トークンが漏れている');
  assert.match(result.message, /\*\*\*/);
});

test('ロールバック: 自分が作ったチャンネルだけ消す', async () => {
  const created = fakeDiscord();
  const a = await rollbackChannel({
    discord: created,
    channel: { id: 'C-NEW', name: 'newproj' },
    created: true,
  });
  assert.deepEqual(a, { ok: true, deleted: true });
  assert.deepEqual(created.log, ['delete:C-NEW']);

  // 既存を再利用しただけなら消さない (人の作ったチャンネルを消さない)
  const reused = fakeDiscord();
  const b = await rollbackChannel({
    discord: reused,
    channel: { id: 'C-OLD', name: 'newproj' },
    created: false,
  });
  assert.deepEqual(b, { ok: true, skipped: true });
  assert.deepEqual(reused.log, []);
});

test('ロールバック失敗は握り潰さず、手で消すよう伝える', async () => {
  const discord = fakeDiscord({ faults: { delete: err(403, `token=${TOKEN}`) } });
  const result = await rollbackChannel({
    discord,
    channel: { id: 'C-NEW', name: 'newproj' },
    created: true,
    secrets: [TOKEN],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /手動で削除/);
  assert.equal(result.message.includes(TOKEN), false);
});

test('通し: チャンネルを作って config を保存する', async () => {
  const discord = fakeDiscord();
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    save: () => ({ ok: true, backupPath: 'config.json.bak' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.channel, { id: 'C-NEW', name: 'newproj' });
  assert.deepEqual(discord.log, [
    'list:G1',
    `create:G1:newproj:${TEXT_CHANNEL_TYPE}`,
    'list:G1',
  ]);
});

test('通し: チャンネルを用意できなければ config を保存しない', async () => {
  const discord = fakeDiscord({ faults: { create: err(403, 'Missing Permissions') } });
  let saveCalled = 0;
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    save: () => { saveCalled++; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'channel');
  assert.equal(saveCalled, 0, 'チャンネルを作れないのに config を書いている');
});

test('通し: config 保存に失敗したら作成したチャンネルを消す', async () => {
  const discord = fakeDiscord();
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    save: () => ({ ok: false, reason: 'changed', message: '対話中に変更されています' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.deepEqual(result.rolledBack, { ok: true, deleted: true });
  assert.ok(discord.log.includes('delete:C-NEW'), 'ロールバックしていない');
});

test('通し: save が同期 throw してもチャンネルを置き去りにしない', async () => {
  const discord = fakeDiscord();
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    secrets: [TOKEN],
    save: () => { throw new Error(`書き込み中に落ちました (${TOKEN})`); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.equal(result.saved.reason, 'save-failed');
  assert.equal(result.saved.message.includes(TOKEN), false, 'トークンが漏れている');
  assert.deepEqual(result.rolledBack, { ok: true, deleted: true });
  assert.ok(discord.log.includes('delete:C-NEW'), 'ロールバックしていない');
});

test('通し: save が reject してもチャンネルを置き去りにしない', async () => {
  const discord = fakeDiscord();
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    secrets: [TOKEN],
    save: () => Promise.reject(new Error(`ENOSPC ${TOKEN}`)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.match(result.saved.message, /config を保存できません/);
  assert.equal(result.saved.message.includes(TOKEN), false);
  assert.deepEqual(result.rolledBack, { ok: true, deleted: true });
});

test('通し: save が結果を返さなくても失敗として扱う', async () => {
  const discord = fakeDiscord();
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    save: () => undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.ok(result.saved.message, '失敗理由が空になっている');
  assert.deepEqual(result.rolledBack, { ok: true, deleted: true });
});

test('通し: 既存チャンネル利用時に保存が失敗しても、そのチャンネルは消さない', async () => {
  const discord = fakeDiscord({
    channels: [{ id: 'C-OLD', name: 'newproj', type: TEXT_CHANNEL_TYPE }],
  });
  const result = await createChannelAndSave({
    discord,
    guildId: GUILD,
    name: 'newproj',
    save: () => ({ ok: false, reason: 'write-failed', message: '書けません' }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rolledBack, { ok: true, skipped: true });
  assert.deepEqual(discord.log, ['list:G1'], '既存チャンネルを消している');
});
