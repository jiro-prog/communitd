import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Events } from 'discord.js';

import { botRoleFor, createDiscordWiring, snowflakeAt } from '../src/bridge/discord.js';
import { SLASH_COMMANDS } from '../src/commands.js';

// src/bridge/discord.js — bot の client 群の起動と、チャンネル・ユーザーの解決。
// discord.js の Client は偽物を注入し、イベントは手で起こす。

function captureConsole(t) {
  const logs = [];
  const errors = [];
  const { log, error } = console;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  t.after(() => {
    console.log = log;
    console.error = error;
  });
  return { logs, errors };
}

class FakeClient {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.user = null;
    this.registered = null;
    this.destroyed = false;
    this.application = {
      commands: {
        set: async (commands, guildId) => {
          if (this.failRegister) throw new Error('Missing Access');
          this.registered = [commands, guildId];
        },
      },
    };
    this.channels = { cache: new Map(), fetch: async () => null };
    FakeClient.instances.push(this);
  }

  once(event, fn) { this.handlers.set(`once:${event}`, fn); }

  on(event, fn) { this.handlers.set(event, fn); }

  login(token) {
    this.token = token;
    if (token === 'bad-intents') return Promise.reject(new Error('Used disallowed intents'));
    if (token === 'bad-token') return Promise.reject(new Error('An invalid token was provided.'));
    return Promise.resolve(token);
  }

  async destroy() { this.destroyed = true; }

  ready(id, tag) {
    this.user = { id, tag };
    return this.handlers.get(`once:${Events.ClientReady}`)();
  }
}

const CONFIG = {
  guildId: 'G1',
  bots: {
    fable: { tokenEnv: 'FABLE_TOKEN', displayName: 'Fable' },
    opus: { tokenEnv: 'OPUS_TOKEN', displayName: 'Opus' },
    sol: { tokenEnv: 'SOL_TOKEN', displayName: 'Sol' },
  },
  channels: { kt: { cwd: 'C:/kt', verify: 'npm test' } },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function harness(t, { env = {}, config = CONFIG } = {}) {
  const io = captureConsole(t);
  FakeClient.instances = [];
  const bots = new Map();
  const discord = createDiscordWiring({ config, bots });
  const calls = { messages: [], interactions: [], announced: 0, exits: [] };
  discord.loginBots({
    env,
    Client: FakeClient,
    // 実物は process.exit。テストでプロセスごと落ちないよう注入で受ける
    exit: (code) => calls.exits.push(code),
    onMessage: async (bot, msg) => { calls.messages.push([bot.key, msg]); if (msg?.fail) throw new Error('handler failed'); },
    onInteraction: async (bot, interaction) => { calls.interactions.push([bot.key, interaction]); },
    announceRestartComplete: async () => { calls.announced += 1; },
  });
  return { ...io, bots, discord, calls };
}

test('loginBots はトークンのある bot だけ起動し、client は通知を閉じた設定で作る', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't-fable', OPUS_TOKEN: 't-opus' } });
  assert.deepEqual([...h.bots.keys()], ['fable', 'opus']);
  assert.ok(h.errors.some((e) => e.includes('[sol] env SOL_TOKEN が未設定 — このボットはスキップ')), h.errors.join('\n'));
  assert.equal(FakeClient.instances.length, 2);
  for (const client of FakeClient.instances) {
    assert.equal(client.options.intents.length, 3);
    assert.deepEqual(client.options.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
  assert.equal(h.bots.get('fable').client.token, 't-fable');
  assert.equal(h.bots.get('fable').userId, null, 'ready 前は userId を持たない');
});

test('ready で userId が入り、スラッシュコマンドを guild へ登録し、全 bot が揃ったら再起動完了を知らせる', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1', OPUS_TOKEN: 't2' } });
  const fable = h.bots.get('fable');
  const opus = h.bots.get('opus');
  await fable.client.ready('F', 'Fable#0001');
  await settle();
  assert.equal(fable.userId, 'F');
  assert.deepEqual(fable.client.registered, [SLASH_COMMANDS, 'G1']);
  assert.ok(h.logs.some((l) => l === '[fable] logged in as Fable#0001 (F)'), h.logs.join('\n'));
  assert.ok(h.logs.some((l) => l.startsWith('[fable] スラッシュコマンド登録: /')), h.logs.join('\n'));
  assert.equal(h.calls.announced, 0, '1 体しか揃っていないのに完了を知らせている');
  await opus.client.ready('O', 'Opus#0001');
  await settle();
  assert.equal(h.calls.announced, 1);
});

test('login に失敗した bot は registry から外し、原因を名前つきで出す', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 'bad-intents', OPUS_TOKEN: 'bad-token', SOL_TOKEN: 'ok' } });
  await settle();
  assert.deepEqual([...h.bots.keys()], ['sol']);
  const intents = h.errors.find((e) => e.startsWith('[fable] ログイン失敗'));
  assert.match(intents, /MESSAGE CONTENT INTENT を ON にして保存/);
  const token = h.errors.find((e) => e.startsWith('[opus] ログイン失敗'));
  assert.match(token, /\.env の OPUS_TOKEN を確認/);
  assert.ok(FakeClient.instances.filter((c) => c.destroyed).length === 2, '落ちた client を破棄していない');
  // 残った 1 体が ready になれば完了通知は出る (落ちた bot を待たない)
  await h.bots.get('sol').client.ready('S', 'Sol#0001');
  await settle();
  assert.equal(h.calls.announced, 1);
  // 一部が落ちただけなら締めの行も終了もしない (残った bot で運用は続く)
  assert.deepEqual(h.calls.exits, []);
  assert.equal(h.errors.some((e) => e.includes('起動できた bot がありません')), false);
});

test('全 bot が login に失敗したら締めの 1 行を出して非 0 で終わる', async (t) => {
  // 個々の失敗理由は出ているが「結局 1 体も起動していない」を言う行が無いと、
  // 窓を閉じた人にも監視にも失敗が伝わらない (終了コード 0 で終わっていた)
  const h = harness(t, { env: { FABLE_TOKEN: 'bad-intents', OPUS_TOKEN: 'bad-token', SOL_TOKEN: 'bad-token' } });
  await settle();
  assert.deepEqual([...h.bots.keys()], [], '全滅なのに registry に残っている');
  const closing = h.errors.filter((e) => e.includes('起動できた bot がありません'));
  assert.equal(closing.length, 1, `締めの行は 1 回だけ (${closing.length} 回)`);
  assert.match(closing[0], /npm start` をやり直して/);
  // **42 は /restart の合図**なので使わない (scripts/run.mjs が再起動してしまう)
  assert.deepEqual(h.calls.exits, [1]);
});

test('トークンが 1 つも無いときは login を試みないので、この経路では終了しない', async (t) => {
  // その場合の停止は src/index.js の bots.size === 0 が担う (二重に落とさない)
  const h = harness(t, { env: {} });
  await settle();
  assert.equal(FakeClient.instances.length, 0, 'トークン無しで client を作っている');
  assert.deepEqual(h.calls.exits, []);
  assert.equal(h.errors.some((e) => e.includes('起動できた bot がありません')), false);
});

test('MessageCreate / InteractionCreate は配線したハンドラへ渡り、ハンドラの失敗はログに残る', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1' } });
  const { client } = h.bots.get('fable');
  client.handlers.get(Events.MessageCreate)({ channelId: 'T1', content: 'hi' });
  client.handlers.get(Events.MessageCreate)({ channelId: 'T2', fail: true });
  client.handlers.get(Events.InteractionCreate)({ channelId: 'C1', commandName: 'status' });
  await settle();
  assert.equal(h.calls.messages.length, 2);
  assert.equal(h.calls.messages[0][0], 'fable');
  assert.equal(h.calls.interactions.length, 1);
  assert.ok(h.errors.some((e) => e.startsWith('[fable thread:T2]') && e.includes('handler failed')), h.errors.join('\n'));
  client.handlers.get(Events.Error)(new Error('socket hang up'));
  assert.ok(h.errors.some((e) => e === '[fable] gateway error: socket hang up'));
});

test('スラッシュコマンドの登録に失敗しても常駐は続け、原因を出す', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1' } });
  const { client } = h.bots.get('fable');
  client.failRegister = true;
  await client.ready('F', 'Fable#0001');
  await settle();
  const line = h.errors.find((e) => e.startsWith('[fable] スラッシュコマンドの登録に失敗: Missing Access'));
  assert.ok(line, h.errors.join('\n'));
  assert.match(line, /メンション経路は生きています/);
  assert.equal(h.bots.get('fable').userId, 'F', '登録失敗で ready の処理を止めている');
});

test('guildId が設定例のままなら、Missing Access の理由としてそれを名指しする', async (t) => {
  // 実在しないサーバーへ登録しようとするので Missing Access になるが、その文言からは
  // 設定の取り違えだと読めない (実地の導入で詰まった: 2026-09-12)
  const h = harness(t, {
    env: { FABLE_TOKEN: 't1' },
    config: { ...CONFIG, guildId: '000000000000000000' },
  });
  const { client } = h.bots.get('fable');
  client.failRegister = true;
  await client.ready('F', 'Fable#0001');
  await settle();
  const line = h.errors.find((e) => e.startsWith('[fable] スラッシュコマンドの登録に失敗: Missing Access'));
  assert.ok(line, h.errors.join('\n'));
  assert.match(line, /guildId が設定例のまま \(000000000000000000\) です/);
  assert.match(line, /この値のままではメンションも拒否されます/);
});

test('botKeyOf / botEntries は registry の素の形を返す', (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1', OPUS_TOKEN: 't2' } });
  h.bots.get('fable').userId = 'F';
  assert.equal(h.discord.botKeyOf('F'), 'fable');
  assert.equal(h.discord.botKeyOf('nobody'), null);
  assert.equal(h.discord.botKeyOf(null), null);
  // rolePromptFile / runtime も載る — 実行文脈が「呼べる相手」に役とランタイムを添えるため
  assert.deepEqual(h.discord.botEntries(), [
    { key: 'fable', displayName: 'Fable', userId: 'F', rolePromptFile: null, runtime: 'claude' },
    { key: 'opus', displayName: 'Opus', userId: null, rolePromptFile: null, runtime: 'claude' },
  ]);
});

test('findGuildChannel はキャッシュだけを見て、同名のスレッドや別 guild を拾わない', (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1' } });
  const { client } = h.bots.get('fable');
  const kt = { id: 'C-kt', guildId: 'G1', name: 'kt', isThread: () => false };
  // discord.js の Collection と同じ `find` を持たせる (キャッシュは Map ではなく Collection)
  client.channels.cache = Object.assign(new Map([
    ['thread', { id: 'T', guildId: 'G1', name: 'kt', isThread: () => true }],
    ['other-guild', { id: 'X', guildId: 'G2', name: 'kt', isThread: () => false }],
    ['kt', kt],
  ]), { find(fn) { return [...this.values()].find(fn); } });
  assert.equal(h.discord.findGuildChannel(client, 'kt'), kt);
  assert.equal(h.discord.findGuildChannel(client, 'nope'), null);
});

test('channelConfigFor はスレッドなら親チャンネルの名前で設定を引く', (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1' } });
  const thread = { isThread: () => true, parent: { name: 'kt' } };
  assert.deepEqual(h.discord.channelConfigFor(thread), { cwd: 'C:/kt', verify: 'npm test', channelName: 'kt' });
  assert.equal(h.discord.channelConfigFor({ isThread: () => false, name: 'unknown' }), null);
  assert.equal(h.discord.channelConfigFor({ isThread: () => true, parent: null }), null);
});

test('otherBotMentionIds は自分以外の起動済み bot の ID と管理ロールを返す', (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1', OPUS_TOKEN: 't2', SOL_TOKEN: 't3' } });
  h.bots.get('fable').userId = 'F';
  h.bots.get('opus').userId = 'O';
  // sol は ready 前 (userId null) — 判定に載せない
  const guild = { roles: { botRoleFor: (id) => (id === 'O' ? { id: 'R-O' } : null) } };
  assert.deepEqual(h.discord.otherBotMentionIds(h.bots.get('fable'), guild), [{ userId: 'O', roleId: 'R-O' }]);
  assert.equal(botRoleFor(guild, 'O'), 'R-O');
  assert.equal(botRoleFor(guild, 'F'), null);
  assert.equal(botRoleFor(null, 'F'), null);
});

test('postToThread は起動済みの bot から順に試し、archive されたスレッドは飛ばす', async (t) => {
  const h = harness(t, { env: { FABLE_TOKEN: 't1', OPUS_TOKEN: 't2' } });
  const fable = h.bots.get('fable');
  const opus = h.bots.get('opus');
  const sent = [];
  fable.userId = null; // ready 前は使わない
  opus.userId = 'O';
  opus.client.channels.fetch = async (id) => (id === 'T1'
    ? { id, isThread: () => true, archived: false, send: async (payload) => { sent.push(payload); return { id: 'm' }; } }
    : { id, isThread: () => true, archived: true, send: async () => { throw new Error('should not send'); } });
  assert.equal(await h.discord.postToThread('T1', 'x'.repeat(2000)), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.length, 1900, '1900 字で切っていない');
  assert.equal(await h.discord.postToThread('T-archived', 'hello'), false);
  assert.equal(await h.discord.postToThread(null, 'hello'), false);
});

test('snowflakeAt は Discord epoch からのミリ秒を 22 bit 左へ寄せた ID を返す', () => {
  assert.equal(snowflakeAt(1420070400000), '0');
  assert.equal(snowflakeAt(1420070400000 + 1000), String(1000n << 22n));
  // epoch より前や不正値は epoch に丸める (負の ID を作らない)
  assert.equal(snowflakeAt(0), '0');
  assert.equal(snowflakeAt(Number.NaN), '0');
});
