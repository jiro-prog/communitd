import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mentionsBot,
  replyAuthorId,
  resolveTrigger,
  shouldIgnoreOwnMessage,
  shouldLookupReply,
} from '../src/trigger.js';

const ME = 'BOT_OPUS';
const MY_ROLE = 'ROLE_OPUS';
const OTHER = { userId: 'BOT_SOL', roleId: 'ROLE_SOL' };
const NONE = { triggered: false, via: null };

/** 返信先投稿者 ID を返す lookup + 呼ばれた回数 */
function lookup(value) {
  const fn = () => {
    fn.calls++;
    return typeof value === 'function' ? value() : value;
  };
  fn.calls = 0;
  return fn;
}

function trig(patch = {}) {
  return resolveTrigger({
    content: '',
    botUserId: ME,
    botRoleId: MY_ROLE,
    authorIsBot: false,
    otherBots: [OTHER],
    lookupReply: lookup(null),
    ...patch,
  });
}

/** discord.js Message の最小フェイク */
function fakeMessage({ authorIsBot = false, reference = { messageId: 'M1', channelId: 'C1', type: 0 }, channelId = 'C1', fetchReference } = {}) {
  return {
    author: { bot: authorIsBot },
    reference,
    channelId,
    fetchReference: fetchReference ?? (async () => ({ author: { id: ME } })),
  };
}

test('自分宛メンションで起動する (ユーザー / ロール / <@!id>)', async () => {
  assert.deepEqual(await trig({ content: `<@${ME}> やって` }), { triggered: true, via: 'mention' });
  assert.deepEqual(await trig({ content: `<@!${ME}> やって` }), { triggered: true, via: 'mention' });
  assert.deepEqual(await trig({ content: `<@&${MY_ROLE}> やって` }), { triggered: true, via: 'mention' });
});

test('他 bot 宛メンションだけでは起動しない', async () => {
  assert.deepEqual(await trig({ content: `<@${OTHER.userId}> やって` }), NONE);
  assert.deepEqual(await trig({ content: '@Opus と書いただけ' }), NONE);
});

test('bot 発言のメンションは従来どおり起動する (bot 間委譲)', async () => {
  assert.deepEqual(
    await trig({ content: `<@${ME}> 実装して`, authorIsBot: true }),
    { triggered: true, via: 'mention' },
  );
});

test('人間が自分の発言へ返信すればメンションなしで起動する', async () => {
  assert.deepEqual(
    await trig({ content: 'そこもう少し詳しく', lookupReply: lookup(ME) }),
    { triggered: true, via: 'reply' },
  );
});

test('他人・他 bot の発言への返信では起動しない', async () => {
  assert.deepEqual(await trig({ content: 'ありがとう', lookupReply: lookup('HUMAN_1') }), NONE);
  assert.deepEqual(await trig({ content: 'ありがとう', lookupReply: lookup(OTHER.userId) }), NONE);
});

test('bot からの返信は起動しない (bot 同士はメンションで委譲する)', async () => {
  assert.deepEqual(
    await trig({ content: '了解です', authorIsBot: true, lookupReply: lookup(ME) }),
    NONE,
  );
});

test('自分への返信 + 自分へのメンションでも起動は 1 回 (via は mention に畳まれる)', async () => {
  assert.deepEqual(
    await trig({ content: `<@${ME}> 続きお願い`, lookupReply: lookup(ME) }),
    { triggered: true, via: 'mention' },
  );
});

test('自分への返信 + 他 bot への明示メンションは、そちらへの依頼とみなして起動しない', async () => {
  assert.deepEqual(
    await trig({ content: `<@${OTHER.userId}> これどう思う?`, lookupReply: lookup(ME) }),
    NONE,
  );
  assert.deepEqual(
    await trig({ content: `<@&${OTHER.roleId}> これどう思う?`, lookupReply: lookup(ME) }),
    NONE,
  );
});

test('本文で宛先が決まるときは返信先を取りに行かない (API 待ちを挟まない)', async () => {
  const mine = lookup(ME);
  await trig({ content: `<@${ME}> やって`, lookupReply: mine });
  assert.equal(mine.calls, 0, '自分宛メンションで参照取得が走っている');

  const other = lookup(ME);
  await trig({ content: `<@${OTHER.userId}> やって`, lookupReply: other });
  assert.equal(other.calls, 0, '他 bot 宛メンションで参照取得が走っている');

  const fromBot = lookup(ME);
  await trig({ content: 'ふむ', authorIsBot: true, lookupReply: fromBot });
  assert.equal(fromBot.calls, 0, 'bot 発言で参照取得が走っている');

  const human = lookup(ME);
  await trig({ content: 'そこ詳しく', lookupReply: human });
  assert.equal(human.calls, 1, '宛先未確定の発言で参照取得が走っていない');
});

test('返信先の取得が失敗 (reject / throw) しても落ちず、メンション判定だけで決まる', async () => {
  const boom = () => { throw new Error('Unknown Message'); };
  assert.deepEqual(await trig({ content: 'そこ詳しく', lookupReply: boom }), NONE);
  assert.deepEqual(
    await trig({ content: `<@${ME}> そこ詳しく`, lookupReply: boom }),
    { triggered: true, via: 'mention' },
  );
  const rejected = () => Promise.reject(new Error('Missing Access'));
  assert.deepEqual(await trig({ content: 'そこ詳しく', lookupReply: rejected }), NONE);
  assert.deepEqual(
    await trig({ content: `<@&${MY_ROLE}> そこ詳しく`, lookupReply: rejected }),
    { triggered: true, via: 'mention' },
  );
});

test('lookupReply 未指定でもメンション判定は動く', async () => {
  assert.deepEqual(await trig({ content: 'そこ詳しく', lookupReply: null }), NONE);
  assert.deepEqual(
    await trig({ content: `<@${ME}> やって`, lookupReply: null }),
    { triggered: true, via: 'mention' },
  );
});

test('ready 前 (botUserId なし) は何があっても起動しない', async () => {
  assert.deepEqual(
    await resolveTrigger({ content: `<@${ME}> やって`, botUserId: null, lookupReply: lookup(ME) }),
    NONE,
  );
  assert.deepEqual(await resolveTrigger(), NONE);
});

test('ロール ID 未設定でもユーザーメンションは効く', async () => {
  assert.deepEqual(
    await trig({ content: `<@${ME}> やって`, botRoleId: null }),
    { triggered: true, via: 'mention' },
  );
  assert.deepEqual(await trig({ content: '<@&> やって', botRoleId: null }), NONE);
});

test('mentionsBot: 文字列以外・ID 未設定は false', () => {
  assert.equal(mentionsBot(undefined, { userId: ME }), false);
  assert.equal(mentionsBot(null, { userId: ME }), false);
  assert.equal(mentionsBot(`<@${ME}>`, {}), false);
  assert.equal(mentionsBot(`<@${ME}>`), false);
});

test('replyAuthorId: 返信先の投稿者を返す', async () => {
  assert.equal(await replyAuthorId(fakeMessage()), ME);
  assert.equal(
    await replyAuthorId(fakeMessage({ fetchReference: async () => ({ author: { id: 'HUMAN_1' } }) })),
    'HUMAN_1',
  );
});

test('replyAuthorId: 取得失敗 (削除済み・権限不足) は null', async () => {
  const deleted = fakeMessage({
    fetchReference: async () => { throw new Error('Unknown Message'); },
  });
  assert.equal(await replyAuthorId(deleted), null);

  const denied = fakeMessage({ fetchReference: () => Promise.reject(new Error('Missing Access')) });
  assert.equal(await replyAuthorId(denied), null);

  // author を持たない応答 (システムメッセージ等) も null
  assert.equal(await replyAuthorId(fakeMessage({ fetchReference: async () => ({}) })), null);
  assert.equal(await replyAuthorId(fakeMessage({ fetchReference: async () => null })), null);
});

test('replyAuthorId: 返信でないものは fetch せず null', async () => {
  const never = async () => { throw new Error('fetch してはいけない'); };
  assert.equal(await replyAuthorId(fakeMessage({ reference: null, fetchReference: never })), null);
  assert.equal(await replyAuthorId(fakeMessage({ reference: {}, fetchReference: never })), null);
  // 転送 (MessageReferenceType.Forward = 1)
  assert.equal(
    await replyAuthorId(fakeMessage({ reference: { messageId: 'M1', channelId: 'C1', type: 1 }, fetchReference: never })),
    null,
  );
  // 別チャンネルの発言への参照
  assert.equal(
    await replyAuthorId(fakeMessage({ reference: { messageId: 'M1', channelId: 'C9', type: 0 }, fetchReference: never })),
    null,
  );
  // bot 発言は返信起動の対象外
  assert.equal(await replyAuthorId(fakeMessage({ authorIsBot: true, fetchReference: never })), null);
  assert.equal(await replyAuthorId(undefined), null);
});

test('shouldLookupReply: 通常の返信だけ取りに行く', () => {
  assert.equal(shouldLookupReply({ reference: { messageId: 'M1', channelId: 'C1', type: 0 }, channelId: 'C1' }), true);
  // type 未提供の古い payload も返信として扱う
  assert.equal(shouldLookupReply({ reference: { messageId: 'M1' }, channelId: 'C1' }), true);
});

test('shouldLookupReply: 返信でないものは取りに行かない', () => {
  assert.equal(shouldLookupReply({ reference: null, channelId: 'C1' }), false);
  assert.equal(shouldLookupReply({ reference: {}, channelId: 'C1' }), false);
  assert.equal(shouldLookupReply(), false);
  assert.equal(
    shouldLookupReply({ reference: { messageId: 'M1', channelId: 'C1', type: 1 }, channelId: 'C1' }),
    false,
  );
  assert.equal(
    shouldLookupReply({ reference: { messageId: 'M1', channelId: 'C9', type: 0 }, channelId: 'C1' }),
    false,
  );
  assert.equal(
    shouldLookupReply({ authorIsBot: true, reference: { messageId: 'M1', channelId: 'C1', type: 0 }, channelId: 'C1' }),
    false,
  );
});

// ---- 自分自身の発言 (自己呼び出しの入口) ----

const own = (content) => shouldIgnoreOwnMessage({ authorId: ME, botUserId: ME, content });
/** 実際に載る形の契約 nonce (randomUUID から 16 桁の hex) */
const NONCE = 'a1b2c3d4e5f60718';

test('自分の普通の投稿は捨てる (報告 1 通ごとに job が湧かない)', () => {
  assert.equal(own('実装が終わりました。変更は src/hops.js です'), true);
  assert.equal(own(''), true);
  // 制御フッターの生テキストが本文に残っていても、それだけでは起動しない
  assert.equal(own('次は検証をやります\n[[handoff:opus]]'), true);
  // 無害化された後の表記も同じ (src/mentions.js が <@id> をこの形へ潰す)
  assert.equal(own(`[mention:${ME}]`), true);
});

test('制御メッセージの形と完全一致するときだけ通す', () => {
  assert.equal(own(`<@${ME}>`), false);
  assert.equal(own(`<@${ME}>\n\`契約:${NONCE}\``), false, '契約タグ付きの制御メッセージ');
  assert.equal(own(`<@${ME}>\n`), false, '末尾の改行は Discord 側で付きうる');
});

test('制御メッセージの形から外れたら通さない', () => {
  assert.equal(own(`<@!${ME}>`), true, 'sendControlMention が生成しない表記');
  assert.equal(own(`続きお願いします <@${ME}>`), true, '前に本文がある');
  assert.equal(own(`<@${ME}> 続きお願いします`), true, '後ろに本文がある');
  assert.equal(own(`<@${ME}>\n\`契約:zzzz\``), true, '契約タグの形が不正');
  assert.equal(own(`<@${ME}>\n\`契約:${NONCE}\` 追記`), true, 'タグ行に余分な文字');
  assert.equal(own(`<@${ME}>\n\`契約:${NONCE}\`\n本文`), true, '3 行目がある');
  assert.equal(own(`<@${ME}>\n<@${ME}>`), true, '2 行目が契約タグでない');
});

// ブリッジは verify の失敗出力・ツール軌跡・git 差分を**無害化せずに**スレッドへ出す。
// 「本文のどこかに自分宛メンションがあれば通す」にしていると、外部由来の文字列に
// bot ID が紛れただけで自己 job が湧く (sol 指摘 2026-08-21)
test('verify の失敗出力に bot ID が紛れても自己起動しない', () => {
  const verifyOutput = [
    '❌ verify 失敗 (npm test)',
    '```',
    `test/mentions.test.js:124 生の <@${ME}> は無効化され、起動判定の迂回路にならない`,
    `  actual: '<@${ME}>'`,
    '```',
  ].join('\n');
  assert.equal(own(verifyOutput), true, 'verify 出力で自己 job が湧いている');
  // 1 行に畳まれていても、制御メッセージそのものでなければ通さない
  assert.equal(own(`assert failed: <@${ME}>`), true);
});

test('他の担当を呼んだ自分の投稿は通さない', () => {
  assert.equal(own(`<@${OTHER.userId}>`), true);
});

test('自分のロールメンションでは自己起動しない (入口は userId 一致だけ)', () => {
  assert.equal(shouldIgnoreOwnMessage({ authorId: ME, botUserId: ME, content: `<@&${MY_ROLE}>` }), true);
});

test('他人の発言はこの判定の対象外 (通常のトリガー判定へ回す)', () => {
  assert.equal(shouldIgnoreOwnMessage({ authorId: 'HUMAN', botUserId: ME, content: 'ふつうの依頼' }), false);
  assert.equal(shouldIgnoreOwnMessage({ authorId: OTHER.userId, botUserId: ME, content: `<@${ME}>` }), false);
  // ready 前 (botUserId が空) は自分の発言を判定できない — 捨てない
  assert.equal(shouldIgnoreOwnMessage({ authorId: ME, botUserId: '', content: 'x' }), false);
});
