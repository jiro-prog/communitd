import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInteractionHandler } from '../src/interactions.js';
import { SLASH_COMMANDS } from '../src/commands.js';

// ---- /retry — interaction 側は門番と表示だけ ----

const CONFIG = { guildId: 'G1', allowedUserIds: ['U1'] };
const BOT = { key: 'fable' };
const body = (p) => (typeof p === 'string' ? p : p?.content);

function harness(retryTask) {
  const log = [];
  const calls = [];
  const onInteraction = createInteractionHandler({
    config: CONFIG,
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'kt' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    retryTask: retryTask ? async (args) => { calls.push(args); return retryTask(args); } : null,
  });
  const interaction = ({ id = null, inThread = true } = {}) => ({
    commandName: 'retry',
    guildId: 'G1',
    channelId: 'T77',
    user: { id: 'U1' },
    channel: { id: 'T77', isThread: () => inThread },
    options: { getString: (n) => (n === 'id' ? id : null), getBoolean: () => null },
    isChatInputCommand: () => true,
    inGuild: () => true,
    deferReply: async () => { log.push('defer'); },
    editReply: async (p) => { log.push(`edit:${body(p)}`); },
    reply: async (p) => { log.push(`reply:${body(p)}`); },
  });
  return { log, calls, onInteraction, interaction };
}

test('/retry はスラッシュコマンドとして登録され、id を任意で取る', () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === 'retry');
  assert.ok(cmd, '/retry が登録されていない');
  assert.deepEqual(cmd.options.map((o) => [o.name, o.required]), [['id', false]]);
});

test('/retry: スレッド外では実体を呼ばず、配線が無ければ無効と返す', async () => {
  const h = harness(async () => ({ ok: true, reason: 'x' }));
  await h.onInteraction(BOT, h.interaction({ inThread: false }));
  assert.deepEqual(h.calls, []);
  assert.ok(h.log.some((l) => /^edit:⚠️ タスクのスレッドで打ってください/.test(l)), h.log.join(' | '));
  const none = harness(null);
  await none.onInteraction(BOT, none.interaction());
  assert.ok(none.log.some((l) => /^edit:⚠️ 復旧の機能が無効です/.test(l)), none.log.join(' | '));
});

test('/retry: 実体へ thread / id / bot / userId を渡し、結果と警告を出す', async () => {
  const ok = harness(async () => ({
    ok: true, reason: '🔁 #77 は in-progress — 担当 opus を呼び直します', warnings: ['子プロセスを確認できていません'],
  }));
  await ok.onInteraction(BOT, ok.interaction({ id: ' 77 ' }));
  assert.equal(ok.calls[0].thread.id, 'T77');
  assert.equal(ok.calls[0].id, '77', 'id の前後の空白を落としていない');
  assert.equal(ok.calls[0].bot, BOT);
  assert.equal(ok.calls[0].userId, 'U1');
  const edited = ok.log.find((l) => l.startsWith('edit:'));
  assert.equal(edited, 'edit:🔁 #77 は in-progress — 担当 opus を呼び直します\n⚠️ 子プロセスを確認できていません');

  const ng = harness(async () => ({ ok: false, reason: '#77 は merged です' }));
  await ng.onInteraction(BOT, ng.interaction());
  assert.equal(ng.calls[0].id, null, 'id 省略時に空文字を渡している');
  assert.ok(ng.log.some((l) => l === 'edit:⚠️ #77 は merged です'), ng.log.join(' | '));

  // 理由が既に印を持っていれば重ねない (/review と同じ流儀)
  const marked = harness(async () => ({ ok: false, reason: '⏸ 自律運転が停止中です' }));
  await marked.onInteraction(BOT, marked.interaction());
  assert.ok(marked.log.some((l) => l === 'edit:⏸ 自律運転が停止中です'), marked.log.join(' | '));

  const thrown = harness(async () => { throw new Error('store が壊れている'); });
  await thrown.onInteraction(BOT, thrown.interaction());
  assert.ok(thrown.log.some((l) => /^edit:⚠️ 起こし直せませんでした: store が壊れている/.test(l)), thrown.log.join(' | '));
});
