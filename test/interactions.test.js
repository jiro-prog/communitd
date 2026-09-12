import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalRegistry, buildCustomId } from '../src/approvals.js';
import { canonicalCwd } from '../src/grants.js';
import { RESTART_EXIT_CODE } from '../src/restart.js';
import {
  admitJob,
  createInteractionHandler,
  createLifecycle,
  pumpJobs,
  runShutdown,
  stopJobs,
} from '../src/interactions.js';
import { RosterStore } from '../src/roster.js';
import { PauseStore } from '../src/store.js';

const CONFIG = { guildId: 'G1', allowedUserIds: ['U1'] };
const BOT = { key: 'fable' };
const BOT_ENTRIES = [
  { key: 'fable', displayName: 'Fable', userId: 'F1' },
  { key: 'opus', displayName: 'Opus', userId: 'O1' },
  { key: 'sol', displayName: 'Sol', userId: null },
];

// 送信はすべて src/mentions.js のラッパを通るのでペイロードはオブジェクト。
// 本文だけをログに残しつつ、allowedMentions が漏れなく付いているかを別途記録する
const mentionGuards = [];
function body(payload) {
  mentionGuards.push(payload?.allowedMentions ?? null);
  return typeof payload === 'string' ? payload : payload?.content;
}

/** 呼ばれた順に足りる 1 本のログを共有し、ACK と kill の前後関係を見る */
function harness({
  active = 0,
  waiting = 0,
  activeItems = null,
  dequeuedItems = null,
  channelKnown = true,
  channelConfig = { cwd: 'C:/tmp', channelName: 'sandbox' },
  deferFails = false,
  roster = new RosterStore(join(mkdtempSync(join(tmpdir(), 'communitd-roster-')), 'roster.json')),
  pauseStore = new PauseStore(join(mkdtempSync(join(tmpdir(), 'communitd-pause-')), 'pause.json')),
  botEntries = () => BOT_ENTRIES,
  lifecycle = createLifecycle(),
  restartDrainMs = 30000,
  respondDelayMs = 0,
  respondHangs = false, // 応答が永久に返らない (Discord API のハング)
  onShutdown = null, // 実 runShutdown を繋ぎたいとき用
  reissueReview = null, // /review の実体 (省略すると配線なし = 機能無効)
  caseCommand = null, // /case の実体 (省略すると配線なし = 機能無効)
  societyStop = null, // /stop の案件停止 (省略すると配線なし = 案件は止まらない)
  ownerUserId = 'U1', // 案件を開く / 相談を出せるのは owner だけ (既定の打ち手 U1 を owner にする)
} = {}) {
  const log = [];
  const reviewCalls = [];
  const caseCalls = [];
  const societyCalls = [];
  const mkActive = (n) =>
    Array.from({ length: n }, (_, i) => ({
      handle: { stopRequested: false, abort: () => log.push(`abort:${i}`) },
    }));
  const mkWaiting = (n) =>
    Array.from({ length: n }, (_, i) => ({
      handle: { stopRequested: false },
      placeholder: { edit: async (p) => log.push(`cancel:${i}:${body(p).slice(0, 4)}`) },
    }));

  const selected = {
    active: activeItems ?? mkActive(active),
    dequeued: dequeuedItems ?? mkWaiting(waiting),
  };
  const jobs = {
    activeCount: selected.active.length,
    waitingCount: selected.dequeued.length,
    selectForStop(sel) {
      log.push(`select:${JSON.stringify(sel)}`);
      return selected;
    },
  };
  const notices = [];
  const exits = [];
  const onInteraction = createInteractionHandler({
    config: CONFIG,
    channelConfigFor: () => (channelKnown ? channelConfig : null),
    jobs,
    // drain を待っている間に新規 job を受け付けていないかを、待ちの時点で記録する
    waitForJobsDrained: async (ms) => {
      log.push(`accepting-at-drain:${lifecycle.accepting}`);
      log.push(`drain:${ms}`);
    },
    writeRestartNotice: (n) => { notices.push(n); log.push('notice'); },
    shutdown: async (code, msg, opts) => {
      exits.push(code);
      // drained = 呼び出し元が待ち切り済み。shutdown 側で待ち直させない印
      log.push(`shutdown:${code}:drained=${opts?.drained === true}`);
      if (onShutdown) await onShutdown(code, msg, opts);
    },
    restartDrainMs,
    lifecycle,
    roster,
    pauseStore,
    botEntries,
    reissueReview: reissueReview
      ? async (args) => { reviewCalls.push(args); return reissueReview(args); }
      : null,
    caseCommand: caseCommand
      ? async (args) => { caseCalls.push(args); return caseCommand(args); }
      : null,
    societyStop: societyStop
      ? (args) => { societyCalls.push(args); return societyStop(args); }
      : null,
    ownerUserId,
  });

  function interaction({
    commandName = 'stop',
    options = {},
    inThread = true,
    userId = 'U1',
    guildId = 'G1',
    channelId = 'T1',
    isCommand = true,
    inGuild = true,
  } = {}) {
    return {
      commandName,
      guildId,
      channelId,
      user: { id: userId },
      channel: { id: channelId, isThread: () => inThread },
      options: {
        getString: (n) => options[n] ?? null,
        getBoolean: (n) => options[n] ?? null,
      },
      isChatInputCommand: () => isCommand,
      inGuild: () => inGuild,
      deferReply: async () => {
        if (deferFails) { log.push('defer:failed'); throw new Error('Unknown interaction'); }
        log.push('defer');
      },
      // 応答を待っている間に受付が開いたままになっていないかを、応答の最中に記録する
      editReply: async (p) => {
        log.push(`accepting-at-respond:${lifecycle.accepting}`);
        log.push(`edit:${body(p)}`);
        if (respondHangs) await new Promise(() => {});
        if (respondDelayMs) {
          await new Promise((r) => setTimeout(r, respondDelayMs));
          // 応答が返るのを待っている間に drain が始まっていたか (並行性の観測点)
          log.push(`respond-done:drain-started=${log.some((l) => l.startsWith('drain:'))}`);
        }
      },
      reply: async (p) => {
        log.push(`accepting-at-respond:${lifecycle.accepting}`);
        log.push(`reply:${body(p)}`);
      },
    };
  }

  return {
    log, jobs, notices, exits, onInteraction, interaction, selected, roster, pauseStore, lifecycle,
    reviewCalls, caseCalls, societyCalls,
  };
}

const find = (log, re) => log.findIndex((l) => re.test(l));

test('未許可ユーザー / 別 guild は ephemeral で拒否し job に触らない', async () => {
  for (const patch of [{ userId: 'U9' }, { guildId: 'G2' }]) {
    const h = harness({ active: 1 });
    await h.onInteraction(BOT, h.interaction(patch));
    assert.ok(h.log.some((l) => l.startsWith('reply:⚠️')), `拒否されていない: ${JSON.stringify(patch)}`);
    assert.ok(!h.log.some((l) => l.startsWith('select')), 'job を触っている');
    assert.ok(!h.log.includes('defer'), '拒否なのに ACK している');
  }
});

test('管轄外チャンネルは拒否する', async () => {
  const h = harness({ active: 1, channelKnown: false });
  await h.onInteraction(BOT, h.interaction());
  assert.ok(h.log.some((l) => /reply:⚠️.*channels/.test(l)));
  assert.ok(!h.log.some((l) => l.startsWith('select')));
});

test('チャット入力コマンド以外・DM は無視する', async () => {
  for (const patch of [{ isCommand: false }, { inGuild: false }]) {
    const h = harness();
    await h.onInteraction(BOT, h.interaction(patch));
    assert.deepEqual(h.log, [], `反応してしまう: ${JSON.stringify(patch)}`);
  }
});

// ---- /pause・/resume (自律運転の kill switch) ----

test('/pause は自律運転を止め、いつ誰が止めたかを返す', async () => {
  const h = harness({ active: 2 });
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause', options: { reason: '様子を見る' } }));

  assert.equal(h.pauseStore.paused, true, '止まっていない');
  assert.equal(h.pauseStore.current().by, 'U1');
  assert.equal(h.pauseStore.current().reason, '様子を見る');
  const reply = h.log.find((l) => l.startsWith('edit:'));
  assert.match(reply, /停止中/);
  assert.match(reply, /<@U1>/, '誰が止めたかが出ていない');
  assert.match(reply, /様子を見る/, '理由が出ていない');
  assert.match(reply, /実行中の job はそのまま/, '実行中を殺さないことが伝わっていない');
  // 表示は JST・保存は UTC の ISO (src/time.js)。配線が外れると Z 付きの生 ISO が出る
  assert.match(reply, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} JST/, '止めた時刻が JST で出ていない');
  assert.equal(
    reply.includes(h.pauseStore.current().at), false, '保存値の ISO をそのまま出している',
  );
  // **job には触らない** (/stop とは別物)
  assert.ok(!h.log.some((l) => l.startsWith('select')), 'job を止めている');
  assert.ok(!h.log.some((l) => l.startsWith('abort')), '実行中の job を殺している');
});

test('/pause は二度打っても最初の記録を上書きしない', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause', options: { reason: '1 回目' } }));
  const first = h.pauseStore.current();
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause', options: { reason: '2 回目' } }));

  assert.deepEqual(h.pauseStore.current(), first, '止めた時刻と理由が上書きされている');
  assert.ok(h.log.some((l) => /既に止まっています/.test(l)));
});

test('/resume は停止を解除し、元から動いていればそう言う', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'resume' }));
  assert.match(h.log.find((l) => l.startsWith('edit:')), /元から止まっていません/);
  assert.equal(h.pauseStore.paused, false);

  await h.onInteraction(BOT, h.interaction({ commandName: 'pause', options: { reason: '調査中' } }));
  const stoppedAt = h.pauseStore.current().at;
  await h.onInteraction(BOT, h.interaction({ commandName: 'resume' }));
  assert.equal(h.pauseStore.paused, false, '再開できていない');
  const reply = h.log.filter((l) => l.startsWith('edit:')).at(-1);
  assert.match(reply, /再開しました/);
  assert.match(reply, /調査中/, '何の停止を解いたのかが出ていない');
  // 解いた停止の時刻も JST で出す (/pause 側と同じ配線)
  assert.match(reply, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} JST/, '停止の時刻が JST で出ていない');
  assert.equal(reply.includes(stoppedAt), false, '保存値の ISO をそのまま出している');
});

test('/pause は保存できなければ「止めた」と言わない', async () => {
  const broken = {
    current: () => null,
    pause() { throw new Error('disk full'); },
    resume() { throw new Error('disk full'); },
  };
  const h = harness({ pauseStore: broken });
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause' }));
  const reply = h.log.find((l) => l.startsWith('edit:'));
  assert.match(reply, /保存できなかったため止めていません/);
  assert.match(reply, /disk full/);
});

test('/resume は pause.json が読めない間は解けない (壊せば kill switch が外れる、にしない)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'communitd-pause-')), 'pause.json');
  writeFileSync(file, '{ 壊れた', 'utf8');
  const pauseStore = new PauseStore(file);
  const h = harness({ pauseStore });

  await h.onInteraction(BOT, h.interaction({ commandName: 'resume' }));
  const reply = h.log.filter((l) => l.startsWith('edit:')).at(-1);
  assert.match(reply, /data\/pause\.json が読めないので\*\*停止扱い\*\*です/);
  assert.match(reply, /台帳を直すか手で退避してから再起動/);
  assert.equal(pauseStore.paused, true, '再開できてしまっている');
  assert.equal(readFileSync(file, 'utf8'), '{ 壊れた', '壊れたファイルを上書きしている');

  // /pause も同じ (止まっているものを止め直せない)
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause', options: { reason: 'x' } }));
  assert.match(h.log.filter((l) => l.startsWith('edit:')).at(-1), /停止扱い/);
});

test('pause 機能を持たないプロセスでも落ちない', async () => {
  const h = harness({ pauseStore: null });
  await h.onInteraction(BOT, h.interaction({ commandName: 'pause' }));
  assert.match(h.log.find((l) => l.startsWith('edit:')), /無効です/);
});

test('ACK は最初の abort より先に出す (同期 kill で 3 秒を超えても失効させない)', async () => {
  const h = harness({ active: 2, waiting: 1 });
  await h.onInteraction(BOT, h.interaction());
  const ack = find(h.log, /^defer$/);
  const firstAbort = find(h.log, /^abort:/);
  assert.ok(ack >= 0, 'ACK していない');
  assert.ok(firstAbort >= 0, 'abort していない');
  assert.ok(ack < firstAbort, `ACK が kill より後: ${h.log.join(' | ')}`);
  assert.ok(ack < find(h.log, /^select:/), 'ACK が job 選択より後');
});

test('force 再起動でも ACK が最初の abort より先', async () => {
  const h = harness({ active: 2 });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.ok(find(h.log, /^defer$/) < find(h.log, /^abort:/), h.log.join(' | '));
});

test('/stop: スレッド内は そのスレッドだけ・scope:all は全体', async () => {
  const h = harness({ active: 1, waiting: 1 });
  await h.onInteraction(BOT, h.interaction({ channelId: 'T7' }));
  assert.ok(h.log.includes('select:{"threadId":"T7","all":false}'), h.log.join(' | '));
  assert.ok(h.log.includes('abort:0'), '実行中 job へ中断を送っていない');
  assert.ok(h.log.some((l) => l.startsWith('cancel:0')), '待機 job を取り消していない');
  assert.equal(h.selected.dequeued[0].handle.stopRequested, true);
  assert.ok(h.log.some((l) => /^edit:⏹ 停止指示 \(このスレッド\)/.test(l)), h.log.join(' | '));

  const all = harness({ active: 1 });
  await all.onInteraction(BOT, all.interaction({ options: { scope: 'all' }, channelId: 'T7' }));
  assert.ok(all.log.includes('select:{"threadId":"T7","all":true}'), all.log.join(' | '));
  assert.ok(all.log.some((l) => /^edit:⏹ 停止指示 \(全体\)/.test(l)));
});

test('/stop: スレッド外は全体扱いで、その旨を返す', async () => {
  const h = harness({ active: 1 });
  await h.onInteraction(BOT, h.interaction({ inThread: false }));
  assert.ok(h.log.includes('select:{"threadId":null,"all":true}'), h.log.join(' | '));
  assert.ok(h.log.some((l) => /^edit:⏹ 停止指示 \(全体 — スレッド外なので全体扱い\)/.test(l)));
});

test('/stop: 案件の停止マーカーは job を止めるより先に付け、再開の口を返す', async () => {
  // 先に印が付いていれば、実行中 job の settle も待機中 job の取り消しも台帳の停止分岐へ入る
  const order = [];
  const activeItems = [{
    jobId: 'job-1',
    handle: { stopRequested: false, abort: () => order.push('abort') },
    onStop: () => order.push('onStop:active'),
  }];
  const dequeuedItems = [{
    jobId: 'job-2',
    handle: { stopRequested: false },
    placeholder: { edit: async () => {} },
    onStop: () => order.push('onStop:waiting'),
  }];
  const h = harness({
    activeItems,
    dequeuedItems,
    societyStop: () => {
      order.push('society');
      return { ok: true, stopped: ['C-1', 'C-2'], skipped: [] };
    },
  });
  await h.onInteraction(BOT, h.interaction({ channelId: 'T7' }));

  assert.deepEqual(order, ['society', 'onStop:waiting', 'onStop:active', 'abort'], order.join(' | '));
  // **対象の選び直しはしない** (2 回目の selectForStop は待機分を返さず ⏳ が残る)
  assert.deepEqual(h.log.filter((l) => l.startsWith('select:')), ['select:{"threadId":"T7","all":false}']);
  assert.deepEqual(h.societyCalls, [{
    threadId: 'T7', all: false, userId: 'U1', jobIds: ['job-1', 'job-2'],
  }]);
  const replied = h.log.find((l) => /^edit:⏹ 停止指示/.test(l));
  assert.match(replied, /⏹ 案件 C-1 も停止しました \(再開は `\/case resume:C-1`\)/);
  assert.match(replied, /⏹ 案件 C-2 も停止しました \(再開は `\/case resume:C-2`\)/);
});

test('/stop: 台帳が読めなければ job は止めて、印を付けられなかったことを返す', async () => {
  const h = harness({
    active: 1,
    societyStop: () => ({ ok: false, code: 'halted', reason: '台帳を開けていません', stopped: [], skipped: [] }),
  });
  await h.onInteraction(BOT, h.interaction());
  assert.ok(h.log.includes('abort:0'), '台帳が読めないだけで job を止めそこねている');
  const replied = h.log.find((l) => /^edit:⏹ 停止指示/.test(l));
  assert.match(replied, /⚠️ 案件の台帳が読めないので停止マーカーは付けられませんでした/);
});

test('/stop: 案件の配線が無い配備は従来どおり 1 行だけ返す (回帰)', async () => {
  const h = harness({ active: 1, waiting: 1 });
  await h.onInteraction(BOT, h.interaction());
  const replied = h.log.find((l) => /^edit:⏹ 停止指示/.test(l));
  assert.equal(/案件/.test(replied), false, replied);
  assert.deepEqual(h.societyCalls, []);
});

test('/restart force と shutdown は案件を止めない (停止は再起動で変わらない)', async () => {
  const h = harness({ active: 1, societyStop: () => ({ ok: true, stopped: ['C-1'], skipped: [] }) });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.ok(h.log.includes('abort:0'), '前提: job は止めている');
  assert.deepEqual(h.societyCalls, [], '再起動で案件へ停止マーカーを付けている');
});

test('/restart: job があれば拒否し、終了しない', async () => {
  for (const state of [{ active: 1 }, { waiting: 1 }]) {
    const h = harness(state);
    await h.onInteraction(BOT, h.interaction({ commandName: 'restart' }));
    assert.ok(h.log.some((l) => /^edit:⚠️.*再起動しません/.test(l)), h.log.join(' | '));
    assert.deepEqual(h.exits, [], '拒否したのに終了している');
    assert.ok(!h.log.some((l) => l.startsWith('notice')), '拒否したのに再起動通知を予約している');
  }
});

test('/restart: job が無ければ通知を予約して終了コード 42 で落ちる', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', channelId: 'C9' }));
  assert.ok(h.log.includes('edit:🔄 再起動します'));
  assert.deepEqual(h.notices, [{ channelId: 'C9', botKey: 'fable' }]);
  assert.deepEqual(h.exits, [RESTART_EXIT_CODE]);
  assert.ok(!h.log.some((l) => l.startsWith('drain')), 'job が無いのに drain を待っている');
});

test('/restart force: 全 job を中断し、応答してから drain → 終了', async () => {
  const h = harness({ active: 1, waiting: 1 });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  // /stop と同じ stopJobs を通るので選択の形も揃う (threadId 省略 = 全レーン)
  assert.ok(h.log.includes('select:{"threadId":null,"all":true}'), h.log.join(' | '));
  assert.ok(h.log.includes('abort:0'));
  assert.ok(h.log.some((l) => l.startsWith('cancel:0')));
  const replied = find(h.log, /^edit:🔄 再起動します \(実行中 1 件/);
  assert.ok(replied >= 0, '中断件数を返していない');
  assert.ok(replied < find(h.log, /^drain:30000$/), '応答より先に drain を待っている');
  assert.ok(find(h.log, /^drain:/) < find(h.log, /^shutdown:/), 'drain を待たずに落ちている');
  assert.deepEqual(h.exits, [RESTART_EXIT_CODE]);
});

test('ACK に失敗しても停止処理は続け、応答は reply で試す', async () => {
  const h = harness({ active: 1, deferFails: true });
  await h.onInteraction(BOT, h.interaction());
  assert.ok(h.log.includes('defer:failed'));
  assert.ok(h.log.includes('abort:0'), 'ACK 失敗で停止まで諦めている');
  assert.ok(h.log.some((l) => l.startsWith('reply:⏹ 停止指示')), h.log.join(' | '));
});

test('知らないコマンドは黙殺せず返す', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'unknown' }));
  assert.ok(h.log.some((l) => /^edit:⚠️ 未対応のコマンド/.test(l)), h.log.join(' | '));
  assert.deepEqual(h.exits, []);
});

// ---- /case (自律社会の案件) ----

test('/case: 配線が無ければ機能が無効だと返す', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'case' }));
  assert.ok(h.log.some((l) => /^edit:⚠️ 案件 \(自律社会\) の機能が無効です/.test(l)), h.log.join(' | '));
});

test('/case: 引数なしは一覧として実体へ渡し、本文をそのまま出す', async () => {
  const h = harness({ caseCommand: async () => '📁 進行中の案件 1 件' });
  await h.onInteraction(BOT, h.interaction({ commandName: 'case', channelId: 'T9' }));
  assert.equal(h.caseCalls.length, 1);
  assert.equal(h.caseCalls[0].action, 'list');
  assert.equal(h.caseCalls[0].channelName, 'sandbox', 'チャンネル名を渡していない');
  assert.equal(h.caseCalls[0].threadId, 'T9', 'スレッド ID を渡していない');
  assert.equal(h.caseCalls[0].userId, 'U1', '打った人を渡していない');
  assert.ok(h.log.some((l) => l === 'edit:📁 進行中の案件 1 件'), h.log.join(' | '));
});

test('/case: スレッド外では threadId を渡さない (案件のスレッドに任せる)', async () => {
  const h = harness({ caseCommand: async () => 'ok' });
  await h.onInteraction(BOT, h.interaction({ commandName: 'case', inThread: false }));
  assert.equal(h.caseCalls[0].threadId, null);
});

test('/case: 足りない引数は実体を呼ばずに断る', async () => {
  const h = harness({ caseCommand: async () => 'ok' });
  await h.onInteraction(BOT, h.interaction({ commandName: 'case', options: { new: 'quality' } }));
  assert.deepEqual(h.caseCalls, [], '検査を通さずに台帳を触っている');
  assert.ok(h.log.some((l) => /^edit:⚠️ .*goal/.test(l)), h.log.join(' | '));
});

test('/case: new と offer の引数を実体へそのまま渡す', async () => {
  const opened = harness({ caseCommand: async () => '📁 案件 C-1 を開きました' });
  await opened.onInteraction(BOT, opened.interaction({
    commandName: 'case',
    options: { new: 'quality', goal: 'verify を緑に', acceptance: 'npm test 全通過' },
  }));
  assert.deepEqual(
    { ...opened.caseCalls[0], channelName: undefined, threadId: undefined, userId: undefined },
    { action: 'new', mandateKey: 'quality', goal: 'verify を緑に', acceptance: 'npm test 全通過', channelName: undefined, threadId: undefined, userId: undefined },
  );

  const consulted = harness({ caseCommand: async () => '🤝 相談します' });
  await consulted.onInteraction(BOT, consulted.interaction({
    commandName: 'case',
    options: { id: 'C-1', bot: 'opus', responsibility: 'assessor', summary: '検収して' },
  }));
  const req = consulted.caseCalls[0];
  assert.equal(req.action, 'offer');
  assert.equal(req.id, 'C-1');
  assert.equal(req.botKey, 'opus');
  assert.equal(req.responsibility, 'assessor');
  assert.equal(req.summary, '検収して');
});

test('/case: 案件を開く / 相談を出す / 停止を解除するのは owner だけ (一覧と詳細は全員)', async () => {
  // 予算と責任を動かす操作なので org 提案の裁定と同じ扱い (Fable 裁定 2026-09-08)。
  // 再開が同じ門なのは §12.2 (g) —「解除は owner の操作か同じ認可の操作だけ」
  const opens = { new: 'quality', goal: 'x', acceptance: 'y' };
  const offers = { id: 'C-1', bot: 'opus' };
  const resumes = { resume: 'C-1' };
  for (const options of [opens, offers, resumes]) {
    const other = harness({ caseCommand: async () => 'ok', ownerUserId: 'SO' });
    await other.onInteraction(BOT, other.interaction({ commandName: 'case', options }));
    assert.deepEqual(other.caseCalls, [], `owner 以外が台帳を触っている: ${JSON.stringify(options)}`);
    assert.ok(
      other.log.some((l) => /^edit:⚠️ 案件を開く \/ 相談を出す \/ 停止を解除できるのは作者 \(ownerUserId\) だけです/.test(l)),
      other.log.join(' | '),
    );

    // ownerUserId が未設定なら誰も通さない (設定漏れを「全員可」にしない)
    const unset = harness({ caseCommand: async () => 'ok', ownerUserId: null });
    await unset.onInteraction(BOT, unset.interaction({ commandName: 'case', options }));
    assert.deepEqual(unset.caseCalls, [], `ownerUserId 未設定で通している: ${JSON.stringify(options)}`);

    // owner なら通る
    const owner = harness({ caseCommand: async () => 'ok', ownerUserId: 'U1' });
    await owner.onInteraction(BOT, owner.interaction({ commandName: 'case', options }));
    assert.equal(owner.caseCalls.length, 1, `owner を止めている: ${JSON.stringify(options)}`);
  }

  // 読むだけは owner でなくても通る
  for (const options of [{}, { id: 'C-1' }]) {
    const reader = harness({ caseCommand: async () => 'ok', ownerUserId: 'SO' });
    await reader.onInteraction(BOT, reader.interaction({ commandName: 'case', options }));
    assert.equal(reader.caseCalls.length, 1, `読むのを止めている: ${JSON.stringify(options)}`);
  }
});

test('/case: 実体が落ちても interaction は返す', async () => {
  const h = harness({ caseCommand: async () => { throw new Error('台帳が壊れています'); } });
  await h.onInteraction(BOT, h.interaction({ commandName: 'case' }));
  assert.ok(h.log.some((l) => /^edit:⚠️ 案件を読めませんでした: .*台帳が壊れています/.test(l)), h.log.join(' | '));
});

// ---- /review (review で止まったタスクの出し直し) ----

test('/review: スレッド外では実体を呼ばない (対象が決まらない)', async () => {
  const h = harness({ reissueReview: async () => ({ ok: true, reason: '出し直しました' }) });
  await h.onInteraction(BOT, h.interaction({ commandName: 'review', inThread: false }));
  assert.deepEqual(h.reviewCalls, [], 'スレッド外で board を触っている');
  assert.ok(h.log.some((l) => /^edit:⚠️ タスクのスレッドで打ってください/.test(l)), h.log.join(' | '));
});

test('/review: 配線が無ければ機能が無効だと返す', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'review' }));
  assert.ok(h.log.some((l) => /^edit:⚠️ 自律運転の機能が無効です/.test(l)), h.log.join(' | '));
});

test('/review: 実体へ thread と id と bot を渡し、{ok, reason} をそのまま出す', async () => {
  const ok = harness({ reissueReview: async () => ({ ok: true, reason: '#46 のレビューを出し直しました' }) });
  await ok.onInteraction(BOT, ok.interaction({
    commandName: 'review', options: { id: ' 46 ' }, channelId: 'T9',
  }));
  assert.equal(ok.reviewCalls.length, 1);
  assert.equal(ok.reviewCalls[0].thread.id, 'T9', 'interaction のチャンネルを渡していない');
  assert.equal(ok.reviewCalls[0].id, '46', 'id の前後の空白を落としていない');
  assert.equal(ok.reviewCalls[0].bot, BOT, '打った bot を渡していない');
  assert.ok(ok.log.some((l) => /^edit:✅ #46 のレビューを出し直しました/.test(l)), ok.log.join(' | '));

  // 断られた理由はそのまま人間に見せる (何をすればいいかはあちらが書いている)
  const ng = harness({ reissueReview: async () => ({ ok: false, reason: '#46 は merged です' }) });
  await ng.onInteraction(BOT, ng.interaction({ commandName: 'review' }));
  assert.equal(ng.reviewCalls[0].id, null, 'id 省略時に空文字を渡している');
  assert.ok(ng.log.some((l) => /^edit:⚠️ #46 は merged です/.test(l)), ng.log.join(' | '));
});

test('/review: 理由が既に印を持っていれば接頭辞を重ねない', async () => {
  // 実機で `⚠️ ⚠️ レビュー担当 (opus2) が起動していません` が出た (召喚側の 1 行は
  // そのまま人へ出すものなので、⚠️ / ⏸ で始まることがある)
  const cases = [
    [{ ok: false, reason: '⚠️ レビュー担当 (opus2) が起動していません' }, /^edit:⚠️ レビュー担当/],
    [{ ok: false, reason: '⏸ 自律運転が停止中です' }, /^edit:⏸ 自律運転が停止中です/],
    [{ ok: false, reason: '#46 は merged です' }, /^edit:⚠️ #46 は merged です/],
    [{ ok: true, reason: '#46 のレビューを出し直しました' }, /^edit:✅ #46 のレビューを出し直しました/],
  ];
  for (const [out, expected] of cases) {
    const h = harness({ reissueReview: async () => out });
    await h.onInteraction(BOT, h.interaction({ commandName: 'review' }));
    assert.ok(h.log.some((l) => expected.test(l)), `${JSON.stringify(out)} → ${h.log.join(' | ')}`);
    assert.equal(
      h.log.some((l) => /^edit:(⚠️ ⚠️|⚠️ ⏸)/.test(l)),
      false,
      `印が二重になっている: ${h.log.join(' | ')}`,
    );
  }
});

// ---- ツール権限の承認ボタン ----

/** 承認ボタンだけを見る最小のハーネス */
/** grant の cwd は正規形でなければ検証を通らない */
const GRANT_CWD = canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-cwd-')));
const GRANT = { kind: 'web-domain', tool: 'WebFetch', value: 'docs.example.com', cwd: GRANT_CWD };

function approvalHarness(opts = {}) {
  const { saveFails = null, saveResult, hook = false } = opts;
  // undefined を返す実装も差し込めるよう、キーの有無で判定する
  const overrideSave = Object.hasOwn(opts, 'saveResult');
  const saved = [];
  const approvals = new ApprovalRegistry();
  const onInteraction = createInteractionHandler({
    config: CONFIG,
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'sandbox' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    approvals,
    saveApprovedRule: (req) => {
      if (saveFails) throw new Error(saveFails);
      if (overrideSave) return saveResult; // 保存しない実装を差し込む
      // 保存側へ届くのは grant そのもの (どの作業ツリー向けかを含む)
      saved.push(req.grant);
      return { ok: true, added: true };
    },
  });

  // BOT は fable なので、申請もその bot が出した扱いにする (押下時に照合される)
  const request = approvals.register({
    guildId: 'G1', channelId: 'T1', threadId: 'T1', botKey: BOT.key, channelName: 'sandbox',
    grant: GRANT, rule: 'WebFetch(domain:docs.example.com)',
    ...(hook ? { hook: true, waitMs: 180_000 } : {}),
  });
  assert.equal(approvals.bindMessage(request.nonce, 'M1'), true);
  // hook 経路は job が止まって待っている。押下がその待機をどう解くかまで見る
  const decided = hook ? approvals.awaitDecision(request.nonce) : null;

  const updates = [];
  const quiet = [];
  function button(action, {
    userId = 'U1', guildId = 'G1', channelId = 'T1', messageId = 'M1', customId = null,
  } = {}) {
    return {
      customId: customId ?? buildCustomId(action, request.nonce),
      guildId,
      channelId,
      message: { id: messageId },
      user: { id: userId, bot: false },
      isButton: () => true,
      isChatInputCommand: () => false,
      inGuild: () => true,
      update: async (p) => updates.push(p),
      reply: async (p) => quiet.push(p.content),
    };
  }
  return { onInteraction, approvals, request, saved, updates, quiet, button, decided };
}

test('承認台帳を渡すなら保存関数も必須 (配線漏れは起動時に落とす)', () => {
  assert.throws(
    () => createInteractionHandler({
      config: CONFIG,
      channelConfigFor: () => null,
      jobs: {},
      waitForJobsDrained: async () => {},
      writeRestartNotice: () => {},
      shutdown: async () => {},
      approvals: new ApprovalRegistry(),
    }),
    /saveApprovedRule/,
  );
});

test('承認ボタン: allow → confirm の 2 手でだけ保存される', async () => {
  const h = approvalHarness();
  await h.onInteraction(BOT, h.button('allow'));
  assert.deepEqual(h.saved, [], 'allow 1 手で保存してしまっている');
  assert.match(h.updates.at(-1).content, /よろしいですか/);

  await h.onInteraction(BOT, h.button('confirm'));
  assert.deepEqual(h.saved, [GRANT], '保存に渡るのが構造化 grant になっていない');
  assert.match(h.updates.at(-1).content, /承認しました/);
  assert.deepEqual(h.updates.at(-1).components, [], '決着後もボタンが残っている');
  // 応答ペイロードにも allowedMentions が付く (承認カードも送信経路のひとつ)
  assert.deepEqual(h.updates.at(-1).allowedMentions.parse, []);
});

test('承認ボタン: 保存に失敗したら承認済みにしない (再確定できる)', async () => {
  const h = approvalHarness({ saveFails: 'EACCES: permission denied' });
  await h.onInteraction(BOT, h.button('allow'));
  await h.onInteraction(BOT, h.button('confirm'));

  assert.deepEqual(h.saved, []);
  assert.equal(h.request.resolved, null, '保存できていないのに承認済みになっている');
  assert.match(h.quiet.at(-1), /保存できなかった/);
  // カードは確認段階のまま = もう一度「確定」を押せる
  assert.match(h.updates.at(-1).content, /よろしいですか/);
  assert.match(h.updates.at(-1).content, /まだ何も許可していません/);
  assert.ok(h.updates.at(-1).components.length > 0, 'やり直せるボタンが消えている');
});

test('承認ボタン: 保存されなかった戻り値では承認済みにしない', async () => {
  // 「既にある」と「保存できない」を同じ偽値で返す実装だと、保存ゼロなのに
  // 「恒久設定として保存しました」と表示されてしまう (実測 2026-08-01)
  for (const saveResult of [false, null, undefined, {}, { ok: false, reason: 'cwd が消えました' }]) {
    const h = approvalHarness({ saveResult });
    await h.onInteraction(BOT, h.button('allow'));
    await h.onInteraction(BOT, h.button('confirm'));

    assert.equal(h.request.resolved, null,
      `保存できていないのに承認済みになっている: ${JSON.stringify(saveResult)}`);
    assert.equal(h.updates.at(-1).content.includes('承認しました'), false,
      `承認したと表示している: ${JSON.stringify(saveResult)}`);
    assert.match(h.updates.at(-1).content, /まだ何も許可していません/);
  }
});

test('承認ボタン: 既に保存済み (ok:true, added:false) なら承認済みにする', async () => {
  const h = approvalHarness({ saveResult: { ok: true, added: false } });
  await h.onInteraction(BOT, h.button('allow'));
  await h.onInteraction(BOT, h.button('confirm'));

  assert.equal(h.request.resolved?.action, 'confirm');
  assert.match(h.updates.at(-1).content, /承認しました/);
  assert.match(h.updates.at(-1).content, /既に保存済み/);
});

test('承認ボタン: 却下では何も保存しない', async () => {
  const h = approvalHarness();
  await h.onInteraction(BOT, h.button('deny'));
  assert.deepEqual(h.saved, []);
  assert.match(h.updates.at(-1).content, /却下/);
});

test('承認ボタン: 未許可ユーザー・別チャンネル・別カードからは通らない', async () => {
  for (const patch of [{ userId: 'U9' }, { guildId: 'G2' }, { channelId: 'T9' }, { messageId: 'M9' }]) {
    const h = approvalHarness();
    await h.onInteraction(BOT, h.button('allow', patch));
    await h.onInteraction(BOT, h.button('confirm', patch));
    assert.deepEqual(h.saved, [], `通してはいけない: ${JSON.stringify(patch)}`);
    assert.ok(h.quiet.length > 0, '理由を返していない');
  }
});

test('承認ボタン (hook 経路): 1 タップで保存し、保存の後に job を再開させる', async () => {
  const h = approvalHarness({ hook: true });
  await h.onInteraction(BOT, h.button('allow'));
  assert.deepEqual(h.saved, [GRANT], '1 タップで保存されていない');
  assert.match(h.updates.at(-1).content, /承認しました/);
  assert.match(h.updates.at(-1).content, /この job はそのまま続きます/);
  assert.deepEqual(h.updates.at(-1).components, [], '決着後もボタンが残っている');
  assert.deepEqual(await h.decided, { decision: 'allow', reason: '承認されました' });
});

test('承認ボタン (hook 経路): 保存に失敗したら allow を返さない', async () => {
  // ディスクに無い許可でツールが走ると、次の job では効くのに再起動すると消える
  for (const opts of [{ saveFails: 'EACCES' }, { saveResult: { ok: false, reason: 'cwd が消えました' } }]) {
    const h = approvalHarness({ hook: true, ...opts });
    await h.onInteraction(BOT, h.button('allow'));
    assert.deepEqual(h.saved, []);
    assert.equal(h.request.resolved, null, '保存できていないのに承認済みになっている');
    assert.equal(h.approvals.waitingCount, 1, '保存に失敗したのに job を再開させている');
    // カードは申請段階へ戻す (hook 経路に確定ボタンは無い — 押しても通らない)
    assert.deepEqual(h.updates.at(-1).components[0].components.map((c) => c.label), ['承認して続行', '却下']);
    assert.match(h.updates.at(-1).content, /まだ何も許可していません/);
    // やり直しが通れば保存され、そこで初めて待機が解ける
    h.approvals.denyAll('片付け');
    assert.equal((await h.decided).decision, 'deny');
  }
});

test('承認ボタン (hook 経路): 却下は待っている job へ deny を返す', async () => {
  const h = approvalHarness({ hook: true });
  await h.onInteraction(BOT, h.button('deny'));
  assert.deepEqual(h.saved, []);
  assert.equal((await h.decided).decision, 'deny');
});

test('承認ボタン (hook 経路): 待機上限を過ぎたカードは却下と別の見出しで畳む', async () => {
  const h = approvalHarness({ hook: true });
  h.approvals.expire(h.request.nonce);
  assert.equal((await h.decided).decision, 'deny');
  await h.onInteraction(BOT, h.button('allow'));
  assert.deepEqual(h.saved, [], '上限後に押して保存されている');
  assert.match(h.quiet.at(-1), /上限に達しました/);
  // 誰も押していないのに「却下しました」と描かない
  assert.match(h.updates.at(-1).content, /承認待ちの上限/);
  assert.deepEqual(h.updates.at(-1).components, []);
});

test('承認ボタン: 決着後の再押下では二重に保存しない', async () => {
  const h = approvalHarness();
  await h.onInteraction(BOT, h.button('allow'));
  await h.onInteraction(BOT, h.button('confirm'));
  await h.onInteraction(BOT, h.button('confirm'));
  assert.equal(h.saved.length, 1, '二重に保存している');
  assert.match(h.quiet.at(-1), /すでに承認済み/);
});

test('承認ボタン: 知らない customId には反応しない', async () => {
  const h = approvalHarness();
  await h.onInteraction(BOT, h.button('allow', { customId: 'other:thing:1' }));
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.quiet, []);
  assert.deepEqual(h.saved, []);
});

test('承認ボタン: 失効した nonce は無効カードに描き直して何も許可しない', async () => {
  const h = approvalHarness();
  const stale = { ...h.button('confirm'), customId: buildCustomId('confirm', 'gone-nonce') };
  await h.onInteraction(BOT, stale);
  assert.deepEqual(h.saved, []);
  assert.match(h.quiet.at(-1), /無効/);
  assert.match(h.updates.at(-1).content, /何も許可していません/);
});

// ---- /roster (スレッド別の編成) ----

const rosterOut = (log) => log.filter((l) => l.startsWith('edit:')).at(-1) ?? '';

test('/roster: members 省略は現況を表示するだけ', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster' }));
  assert.match(rosterOut(h.log), /未設定/);
  assert.equal(h.roster.get('T1'), null, '表示だけのはずが書き込んでいる');
});

test('/roster: 指定した面子を保存し、次の job から効くと伝える', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus fable' } }));
  assert.deepEqual(h.roster.get('T1'), ['opus', 'fable']);
  assert.match(rosterOut(h.log), /Opus \(`opus`\).*Fable \(`fable`\)/);
  assert.match(rosterOut(h.log), /次の job から/);
});

test('/roster: 編成はスレッドごとに独立している', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus' } }));
  await h.onInteraction(BOT, h.interaction({
    commandName: 'roster', channelId: 'T2', options: { members: 'sol' },
  }));
  assert.deepEqual(h.roster.get('T1'), ['opus']);
  assert.deepEqual(h.roster.get('T2'), ['sol']);
});

test('/roster: 未知のキーは何も保存せずに断る', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus' } }));
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus haiku' } }));
  assert.match(rosterOut(h.log), /⚠️.*haiku/);
  assert.deepEqual(h.roster.get('T1'), ['opus'], '拒否したのに前の編成を壊している');
});

test('/roster: all で解除・none で誰も呼べない', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'none' } }));
  assert.deepEqual(h.roster.get('T1'), []);
  assert.match(rosterOut(h.log), /誰も呼べません/);

  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'all' } }));
  assert.equal(h.roster.get('T1'), null);
  assert.match(rosterOut(h.log), /解除/);
});

test('/roster: 起動していない bot を入れたら黙って呑まずに知らせる', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus sol' } }));
  assert.deepEqual(h.roster.get('T1'), ['opus', 'sol'], '未起動でも編成には入れる');
  assert.match(rosterOut(h.log), /⚠️ sol はいま起動していません/);
});

test('/roster: スレッド外では保存しない (どのスレッドの編成か決まらない)', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({
    commandName: 'roster', inThread: false, options: { members: 'opus' },
  }));
  assert.match(rosterOut(h.log), /⚠️.*スレッド/);
  assert.equal(h.roster.get('T1'), null);
});

test('/roster: 保存に失敗したら「変えていません」と返す', async () => {
  const broken = {
    get: () => null,
    set: () => { throw new Error('EACCES'); },
    clear: () => { throw new Error('EACCES'); },
  };
  const h = harness({ roster: broken });
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'opus' } }));
  assert.match(rosterOut(h.log), /⚠️.*編成は変えていません.*EACCES/);
});

test('/roster も未許可ユーザー・管轄外チャンネルは入口で弾く', async () => {
  for (const patch of [{ userId: 'U9' }, { guildId: 'G2' }]) {
    const h = harness();
    await h.onInteraction(BOT, h.interaction({ ...patch, commandName: 'roster', options: { members: 'opus' } }));
    assert.equal(h.roster.get('T1'), null, `入口を素通りしている: ${JSON.stringify(patch)}`);
  }
  const off = harness({ channelKnown: false });
  await off.onInteraction(BOT, off.interaction({ commandName: 'roster', options: { members: 'opus' } }));
  assert.equal(off.roster.get('T1'), null);
});

// ---- 停止経路 (stopJobs / lifecycle) ----
// ここが抜けると Ctrl-C でブリッジだけ消えて claude ツリーが生き残る。
// Windows の child.kill は直下しか terminate しない (src/proc.js:13-15)

test('stopJobs は実行中 job に abort を送り、待機 job を取り消す', async () => {
  const log = [];
  const activeItems = [
    { handle: { stopRequested: false, abort: () => log.push('abort:0') } },
    { handle: { stopRequested: false, abort: () => log.push('abort:1') } },
  ];
  const dequeuedItems = [
    { handle: { stopRequested: false }, placeholder: { edit: async () => log.push('cancel:0') } },
  ];
  const jobs = {
    selectForStop: (sel) => {
      log.push(`select:${JSON.stringify(sel)}`);
      return { active: activeItems, dequeued: dequeuedItems };
    },
  };

  const { active, dequeued, cancelled } = stopJobs(jobs, { all: true, message: '⏹ 停止' });
  await cancelled;

  assert.deepEqual(active, activeItems);
  assert.deepEqual(dequeued, dequeuedItems);
  assert.equal(log[0], 'select:{"threadId":null,"all":true}');
  // active を分割代入で捨てると子プロセスツリーが孤児として残る (T1 のバグ)
  assert.ok(log.includes('abort:0') && log.includes('abort:1'), '実行中 job へ中断が届いていない');
  assert.ok(log.includes('cancel:0'), '待機 job の ⏳ が放置されている');
  assert.equal(dequeuedItems[0].handle.stopRequested, true, 'spawn 前の停止が flag として届かない');
});

test('stopJobs は handle / abort / placeholder が欠けていても落ちない', async () => {
  // enqueue 直後や spawn 直前など、item が揃っていない瞬間に Ctrl-C されても
  // 残りの job の中断を巻き添えにしない
  const jobs = {
    selectForStop: () => ({
      active: [{}, { handle: {} }],
      dequeued: [{}, { handle: { stopRequested: false } }],
    }),
  };
  const { active, cancelled } = stopJobs(jobs, { all: true, message: '⏹' });
  assert.equal(active.length, 2);
  await assert.doesNotReject(cancelled);
});

test('stopJobs: placeholder の編集が失敗しても他の取り消しは進む', async () => {
  const log = [];
  const jobs = {
    selectForStop: () => ({
      active: [{ handle: { abort: () => log.push('abort') } }],
      dequeued: [
        { placeholder: { edit: async () => { throw new Error('Unknown Message'); } } },
        { placeholder: { edit: async () => log.push('cancel:1') } },
      ],
    }),
  };
  const { cancelled } = stopJobs(jobs, { all: true, message: '⏹' });
  await assert.doesNotReject(cancelled, '1 件の編集失敗で終了処理ごと倒れる');
  assert.ok(log.includes('cancel:1'), '1 件失敗すると残りの取り消しが飛ぶ');
  assert.ok(log.includes('abort'), '取り消しの失敗が実行中 job の中断を巻き添えにしている');
});

test('lifecycle: 停止が始まったら新規 job を受け付けない', () => {
  const lc = createLifecycle();
  assert.equal(lc.accepting, true);
  lc.stopAccepting();
  assert.equal(lc.accepting, false, 'drain 待ちの間に届いた job が spawn されてしまう');
});

test('lifecycle: beginShutdown は最初の 1 回だけ true (二重 shutdown を弾く)', () => {
  const lc = createLifecycle();
  assert.equal(lc.beginShutdown(), true);
  assert.equal(lc.accepting, false, 'shutdown 中なのに受付が開いている');
  // /restart force は abort 済みの状態から shutdown を呼ぶ (src/interactions.js)
  assert.equal(lc.beginShutdown(), false, '後始末が二重に走る');
});

test('pumpJobs: 停止が始まっていたら待機 job を 1 本も起こさない', () => {
  const lc = createLifecycle();
  const waiting = [{ id: 'a' }, { id: 'b' }];
  const started = [];
  const jobs = { takeStartable: () => waiting.splice(0) };

  lc.stopAccepting();
  assert.deepEqual(pumpJobs(jobs, lc, (i) => started.push(i.id)), []);
  assert.deepEqual(started, [], '停止中に job を起動している (殺す対象が増えるだけ)');
  assert.equal(waiting.length, 2, 'キューから取り出してしまっている');
});

test('pumpJobs: 通常時は取り出した job をすべて起こす', () => {
  const started = [];
  const jobs = { takeStartable: () => [{ id: 'a' }, { id: 'b' }] };
  const out = pumpJobs(jobs, createLifecycle(), (i) => started.push(i.id));
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(out.length, 2);
});

test('admitJob: ⏳ を出す前に停止が始まっていたら何も送らず積まない', async () => {
  const lc = createLifecycle();
  lc.stopAccepting();
  let sent = false;
  const r = await admitJob({
    lifecycle: lc,
    sendPlaceholder: async () => { sent = true; return {}; },
    accept: () => assert.fail('停止中なのにキューへ積んでいる'),
  });
  assert.equal(r.admitted, false);
  assert.equal(sent, false, '停止中に Discord を叩いて終了を遅らせている');
});

test('admitJob: ⏳ を送っている最中に停止が始まったら積まず、⏳ を取り消す', async () => {
  // trigger 解決・スレッド作成・⏳ 送信の await 中に Ctrl-C が入る競合。
  // shutdown の selectForStop は済んでいるので、ここで積むと誰にも止められない
  const lc = createLifecycle();
  const placeholder = { id: 'ph' };
  const edits = [];
  const r = await admitJob({
    lifecycle: lc,
    sendPlaceholder: async () => {
      lc.beginShutdown(); // 送信の往復中に SIGINT が届いた
      return placeholder;
    },
    accept: () => assert.fail('停止後にキューへ積んでいる (⏳ のまま残る)'),
    editPlaceholder: async (ph, text) => edits.push([ph, text]),
  });
  assert.equal(r.admitted, false);
  assert.deepEqual(edits, [[placeholder, '⏹ ブリッジ停止により受け付けませんでした — 再メンションしてください']]);
});

test('admitJob: 取り消し編集が失敗しても落ちない', async () => {
  const lc = createLifecycle();
  await assert.doesNotReject(
    admitJob({
      lifecycle: lc,
      sendPlaceholder: async () => { lc.stopAccepting(); return { id: 'ph' }; },
      accept: () => assert.fail('積んではいけない'),
      editPlaceholder: async () => { throw new Error('Unknown Message'); },
    }),
  );
});

test('admitJob: 通常時は placeholder を渡してキューへ積む', async () => {
  const placeholder = { id: 'ph' };
  const accepted = [];
  const r = await admitJob({
    lifecycle: createLifecycle(),
    sendPlaceholder: async () => placeholder,
    accept: (ph) => accepted.push(ph),
    editPlaceholder: async () => assert.fail('受け付けたのに取り消している'),
  });
  assert.equal(r.admitted, true);
  assert.deepEqual(accepted, [placeholder]);
});

test('runShutdown: 実行中 job を abort し、取消編集と drain を並行に待ってから切断・終了', async () => {
  const events = [];
  const jobs = {
    selectForStop: () => ({
      active: [{ handle: { abort: () => events.push('abort') } }],
      dequeued: [
        {
          handle: { stopRequested: false },
          placeholder: {
            edit: async () => {
              await new Promise((r) => setTimeout(r, 20));
              events.push('edit-done');
            },
          },
        },
      ],
    }),
  };
  const ran = await runShutdown({
    jobs,
    lifecycle: createLifecycle(),
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drain: async (ms) => events.push(`drain:${ms}`),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });

  assert.equal(ran, true);
  // drain が edit-done より前 = 並行。直列だと編集の遅れが drain の持ち時間を食う
  assert.deepEqual(events, ['abort', 'drain:8000', 'edit-done', 'destroy', 'exit']);
});

test('runShutdown: job ではない子 (org-apply の verify) も同じ瞬間に撃つ', async () => {
  // 適用回路は tick から走るのでキューに居ない — ここを配線しないと、停止しても
  // verify の子ツリーが自前の 10 分タイムアウトまでブリッジより長生きする
  const events = [];
  const shutdown = (abortOrgApply) => runShutdown({
    jobs: { selectForStop: () => ({ active: [{ handle: { abort: () => events.push('job') } }], dequeued: [] }) },
    lifecycle: createLifecycle(),
    cancelMessage: '⏹',
    drainMs: 0,
    hardExitMs: 15000,
    drain: async () => {},
    destroyClients: async () => {},
    exit: () => events.push('exit'),
    abortOrgApply,
  });

  await shutdown(() => events.push('org-apply'));
  assert.deepEqual(events, ['job', 'org-apply', 'exit']);

  // 撃てなくても停止は続ける (notifyStop と同じ流儀)
  events.length = 0;
  const { error } = console;
  console.error = () => {};
  try {
    await shutdown(() => { throw new Error('居ません'); });
  } finally {
    console.error = error;
  }
  assert.deepEqual(events, ['job', 'exit']);
});

test('runShutdown: ⏳ の送信中に停止しても、取消編集が終わるまで切断・終了しない', async () => {
  // キューにまだ載っていない受付は selectForStop で拾えない。待たずに exit すると
  // Discord には ⏳ が出たままプロセスが消える (sol 指摘)
  const lc = createLifecycle();
  const events = [];
  let resolveSend;
  const sending = new Promise((r) => { resolveSend = r; });

  const admitting = admitJob({
    lifecycle: lc,
    sendPlaceholder: async () => {
      events.push('send-start');
      await sending; // ⏳ の送信が Discord から返ってこない間に SIGINT が入る
      events.push('send-resolve');
      return { id: 'ph' };
    },
    accept: () => assert.fail('停止後にキューへ積んでいる'),
    editPlaceholder: async () => events.push('edit'),
  });

  const shuttingDown = runShutdown({
    jobs: { selectForStop: () => ({ active: [], dequeued: [] }) }, // キューはまだ空
    lifecycle: lc,
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drain: async () => events.push('drain'),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['send-start'], '受付の決着を待たずに終了処理が進んでいる');

  resolveSend();
  const [, ran] = await Promise.all([admitting, shuttingDown]);
  assert.equal(ran, true);
  assert.deepEqual(events, ['send-start', 'send-resolve', 'edit', 'destroy', 'exit']);
  assert.equal(lc.pendingAdmissions, 0, '受付の登録が解除されていない');
});

test('lifecycle: 進行中の受付を数え、片付いたら待ちを解く', async () => {
  const lc = createLifecycle();
  await lc.waitForAdmissions(); // 何も無ければ即座に返る

  const releaseA = lc.beginAdmission();
  const releaseB = lc.beginAdmission();
  assert.equal(lc.pendingAdmissions, 2);

  let settled = false;
  const waiting = lc.waitForAdmissions().then(() => { settled = true; });
  releaseA();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, '1 件残っているのに待ちが解けている');

  releaseB();
  releaseB(); // 二重解除しても数がずれない
  await waiting;
  assert.equal(settled, true);
  assert.equal(lc.pendingAdmissions, 0);
});

test('admitJob: 受け付けた場合も進行中の登録を解除する', async () => {
  const lc = createLifecycle();
  await admitJob({
    lifecycle: lc,
    sendPlaceholder: async () => ({ id: 'ph' }),
    accept: () => {},
  });
  assert.equal(lc.pendingAdmissions, 0, 'shutdown が hardExit まで待つことになる');
});

test('admitJob: accept が投げても進行中の登録を解除する', async () => {
  const lc = createLifecycle();
  await assert.rejects(
    admitJob({
      lifecycle: lc,
      sendPlaceholder: async () => ({ id: 'ph' }),
      accept: () => { throw new Error('queue full'); },
    }),
  );
  assert.equal(lc.pendingAdmissions, 0);
});

test('runShutdown: drained なら進行中の受付を待ち直さない', async () => {
  // /restart force が自前の枠で待ち切ったあと。ここで待ち直すと hardExit が
  // 別枠で計時され、実効上限が restartDrainMs + hardExitMs になる (sol 指摘)
  const lc = createLifecycle();
  lc.beginAdmission(); // 解除されない受付
  const events = [];
  await runShutdown({
    jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
    lifecycle: lc,
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drained: true,
    drain: async () => events.push('drain'),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });
  assert.deepEqual(events, ['destroy', 'exit']);
});

test('runShutdown: drained でなければ進行中の受付を待つ', async () => {
  const lc = createLifecycle();
  const release = lc.beginAdmission();
  const events = [];
  const running = runShutdown({
    jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
    lifecycle: lc,
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drain: async () => {},
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, [], '進行中の受付を待たずに落ちている');
  release();
  await running;
  assert.deepEqual(events, ['destroy', 'exit']);
});

test('runShutdown: drainMs が 0 (呼び出し元が待ち切った) なら drain し直さない', async () => {
  const events = [];
  await runShutdown({
    jobs: {
      selectForStop: () => ({
        active: [{ handle: { abort: () => events.push('abort') } }],
        dequeued: [],
      }),
    },
    lifecycle: createLifecycle(),
    cancelMessage: '⏹',
    drainMs: 0,
    hardExitMs: 15000,
    drain: async () => events.push('drain'),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });
  assert.deepEqual(events, ['abort', 'destroy', 'exit'], '待ち切ったのに drain し直している');
});

test('runShutdown: 実行中 job が無ければ drain を待たない', async () => {
  const events = [];
  await runShutdown({
    jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
    lifecycle: createLifecycle(),
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drain: async () => events.push('drain'),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });
  assert.deepEqual(events, ['destroy', 'exit']);
});

test('runShutdown: 二重呼び出しでは後始末を走らせない', async () => {
  const lc = createLifecycle();
  const events = [];
  const deps = {
    jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
    lifecycle: lc,
    cancelMessage: '⏹',
    drainMs: 8000,
    hardExitMs: 15000,
    drain: async () => {},
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  };
  assert.equal(await runShutdown(deps), true);
  // /restart force は abort 済みの状態から shutdown を呼ぶ
  assert.equal(await runShutdown(deps), false);
  assert.deepEqual(events, ['destroy', 'exit'], '後始末が二重に走っている');
});

test('runShutdown: Discord API が固まっても hardExit で必ず終わる', async () => {
  const events = [];
  // drain が返ってこない = 実行中 job のレーンが解放されないまま固まった状態
  void runShutdown({
    jobs: { selectForStop: () => ({ active: [{ handle: { abort: () => {} } }], dequeued: [] }) },
    lifecycle: createLifecycle(),
    cancelMessage: '⏹',
    drainMs: 1000,
    hardExitMs: 5,
    drain: () => new Promise(() => {}),
    destroyClients: async () => events.push('destroy'),
    exit: () => events.push('exit'),
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(events, ['exit'], 'hardExit が効かず終われない');
});

test('/restart force: drain を待つ間は新規 job を受け付けない', async () => {
  const h = harness({ active: 1 });
  assert.equal(h.lifecycle.accepting, true);
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.ok(
    h.log.includes('accepting-at-drain:false'),
    `drain 待ちの間にメンションが通る: ${JSON.stringify(h.log)}`,
  );
});

test('/restart force: 30 秒待ったあと shutdown 側で drain し直さない', async () => {
  // 待ち直すと実効待機が 30 秒 + shutdown の drain になり、裁定した上限を超える
  const h = harness({ active: 1 });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.deepEqual(
    h.log.filter((l) => l.startsWith('drain:')),
    ['drain:30000'],
    `drain が 1 回で終わっていない: ${JSON.stringify(h.log)}`,
  );
  assert.ok(h.log.includes('shutdown:42:drained=true'), h.log.join(' | '));
});

test('/restart force: 取消編集が返らなくても上限で打ち切って shutdown へ進む', async () => {
  // handleRestart のこの区間はまだ hardExit の管理外。Discord の編集が返らないと、
  // 受付を閉じたまま終了処理へ進めず永久に居座る (sol 指摘)
  const h = harness({
    active: 1,
    dequeuedItems: [
      { handle: { stopRequested: false }, placeholder: { edit: () => new Promise(() => {}) } },
    ],
    restartDrainMs: 20,
  });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.ok(
    h.log.includes('shutdown:42:drained=true'),
    `取消編集の未解決で終了処理へ進めていない: ${JSON.stringify(h.log)}`,
  );
  assert.deepEqual(h.exits, [RESTART_EXIT_CODE]);
});

test('/restart force: 進行中の受付も同じ枠で待ち、shutdown 側で待ち直さない', async () => {
  // ⏳ の送信中 (キュー未登録) の受付を restart 側の枠で待たないと、shutdown が
  // waitForAdmissions で待ち直し、hardExit が別枠で計時されて実効上限が
  // restartDrainMs + hardExitMs になる (sol 指摘)
  const lifecycle = createLifecycle();
  const events = [];
  let resolveSend;
  const sending = new Promise((r) => { resolveSend = r; });

  // ⏳ を送っている最中 = まだキューに載っていない受付
  const admitting = admitJob({
    lifecycle,
    sendPlaceholder: async () => { await sending; return { id: 'ph' }; },
    accept: () => assert.fail('停止後にキューへ積んでいる'),
    editPlaceholder: async () => events.push('admit-cancel'),
  });

  const h = harness({
    active: 1,
    restartDrainMs: 200,
    lifecycle,
    // fake ではなく実物の runShutdown を繋ぐ (待ち直しの有無を実際に見る)
    onShutdown: async (code, msg, opts) =>
      runShutdown({
        jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
        lifecycle,
        cancelMessage: msg,
        drainMs: 200,
        hardExitMs: 150,
        drained: opts?.drained === true,
        drain: async () => events.push('drain'),
        destroyClients: async () => events.push('destroy'),
        exit: () => events.push('exit'),
      }),
  });

  // restart の待ちが始まったあとに ⏳ の送信が返る
  setTimeout(() => resolveSend(), 30);

  const startedAt = Date.now();
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  const elapsed = Date.now() - startedAt;
  await admitting;

  // restart の枠で待たないと、⏳ を取り消す前に落ちる
  assert.deepEqual(events, ['admit-cancel', 'destroy', 'exit'], `順序: ${JSON.stringify(events)}`);
  // shutdown で待ち直していれば hardExit(150ms) が別枠で走る
  assert.ok(elapsed < 200, `実効上限が restartDrainMs + hardExitMs になっている (${elapsed}ms)`);
});

test('/restart force: job が 0 件で受付だけ進行中でも、同じ枠で待ち切る', async () => {
  // active/waiting が 0 だと busy 判定は false。ここで後始末の枠を通さないと、
  // 進行中の受付を shutdown 側が hardExit の別枠で待ち、実効上限が
  // restartDrainMs + hardExitMs になる (sol 指摘)
  const RESTART_DRAIN = 60;
  const HARD_EXIT = 150;
  const lifecycle = createLifecycle();
  lifecycle.beginAdmission(); // 解除されない受付 = ⏳ の送信が返ってこない
  const events = [];
  const h = harness({
    restartDrainMs: RESTART_DRAIN,
    respondHangs: true, // 応答も返らない
    lifecycle,
    onShutdown: async (code, msg, opts) =>
      runShutdown({
        jobs: { selectForStop: () => ({ active: [], dequeued: [] }) },
        lifecycle,
        cancelMessage: msg,
        drainMs: RESTART_DRAIN,
        hardExitMs: HARD_EXIT,
        drained: opts?.drained === true,
        drain: async () => events.push('drain'),
        destroyClients: async () => events.push('destroy'),
        exit: () => events.push('exit'),
      }),
  });

  const startedAt = Date.now();
  const running = h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  await Promise.race([running, new Promise((r) => setTimeout(r, 500))]);
  const elapsed = Date.now() - startedAt;

  // 待ち直すと waitForAdmissions が解けず hardExit だけで終わる (destroy が飛ぶ)
  assert.deepEqual(events, ['destroy', 'exit'], `順序: ${JSON.stringify(events)}`);
  assert.ok(
    elapsed < RESTART_DRAIN + HARD_EXIT,
    `実効上限が restartDrainMs + hardExitMs になっている (${elapsed}ms)`,
  );
});

test('/restart force: 応答が返るのを待たずに drain を始める', async () => {
  // 直列だと「応答の上限 + drain の上限」の足し算になり、裁定した 30 秒を超える。
  // 応答が返らないだけで中断完了の確認が始まらないのも本末転倒 (sol 指摘)
  const h = harness({ active: 1, restartDrainMs: 200, respondDelayMs: 40 });
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  assert.ok(
    h.log.includes('respond-done:drain-started=true'),
    `応答の完了を待ってから drain している: ${JSON.stringify(h.log)}`,
  );
  assert.ok(h.log.includes('shutdown:42:drained=true'), h.log.join(' | '));
});

test('/restart force: 応答が遅れても取消編集の期限を数え直さない', async () => {
  // 期限の起点は「編集が始まった時点」。応答の後から数え直すと、応答に
  // かかった分だけ取消編集に余計な猶予を与えることになる (sol 指摘)
  const RESTART_DRAIN = 120;
  const RESPOND_DELAY = 400; // 期限より十分長く応答を止める
  const h = harness({
    active: 1,
    dequeuedItems: [
      { handle: { stopRequested: false }, placeholder: { edit: () => new Promise(() => {}) } },
    ],
    restartDrainMs: RESTART_DRAIN,
    respondDelayMs: RESPOND_DELAY,
  });

  const startedAt = Date.now();
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart', options: { force: true } }));
  const elapsed = Date.now() - startedAt;

  assert.ok(h.log.includes('shutdown:42:drained=true'), h.log.join(' | '));
  // 応答にも同じ上限が掛かるので、起点が正しければ全体で 1 回分 (実測 ~125ms) で終わる。
  // 応答の後から数え直すと 2 回分 (実測 ~245ms) になる
  assert.ok(
    elapsed < RESTART_DRAIN * 2 - 40,
    `応答の後から取消編集の期限を数え直している (${elapsed}ms)`,
  );
});

test('/restart: job が無くても、応答が返らなければ上限で打ち切って shutdown へ進む', async () => {
  // 受付は既に閉じていて、shutdown の hardExit はまだ始まっていない区間。
  // ここで止まると accepting:false / shutdown 未到達のまま居座る (sol 指摘)
  const h = harness({ restartDrainMs: 20, respondHangs: true });
  // 上限が無いとここが永久に返らないので、待ち切らずに結果だけ見る
  const running = h.onInteraction(BOT, h.interaction({ commandName: 'restart' }));
  await Promise.race([running, new Promise((r) => setTimeout(r, 300))]);
  assert.deepEqual(h.exits, [RESTART_EXIT_CODE], '応答の未解決でプロセスが居座る');
  assert.ok(h.log.includes('shutdown:42:drained=true'), h.log.join(' | '));
});

test('/restart: job が無くても後始末の枠を通り、drained を立てる', async () => {
  // job が 0 件でも ⏳ の送信中が残っていることがある。busy かどうかで分岐すると
  // その受付を shutdown 側の別枠 (hardExit) で待つことになる (sol 指摘)
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart' }));
  assert.ok(h.log.includes('shutdown:42:drained=true'), h.log.join(' | '));
  assert.ok(!h.log.some((l) => l.startsWith('drain:')), 'job が無いのに drain を待っている');
});

test('/restart: job が無くても、応答を待っている間に新規 job を受け付けない', async () => {
  // 再起動が確定してから落ちるまでの数百 ms。ここで受けた job は
  // 直後の shutdown で中断されるだけ (sol 指摘)
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart' }));
  assert.ok(
    h.log.includes('accepting-at-respond:false'),
    `応答中に受付が開いている: ${JSON.stringify(h.log)}`,
  );
  assert.equal(h.lifecycle.accepting, false);
});

test('/stop は受付を閉じない (ブリッジは止めない)', async () => {
  // 閉じてしまうと /stop 以降このプロセスが二度とメンションを受けなくなる
  const h = harness({ active: 1, waiting: 1 });
  await h.onInteraction(BOT, h.interaction({ options: { scope: 'all' } }));
  assert.equal(h.lifecycle.accepting, true);
});

test('/restart: 拒否されたときは受付を閉じない (ブリッジは動き続ける)', async () => {
  const h = harness({ active: 1 }); // force なし + job あり = 拒否
  await h.onInteraction(BOT, h.interaction({ commandName: 'restart' }));
  assert.ok(h.log.some((l) => /^edit:⚠️.*再起動しません/.test(l)), h.log.join(' | '));
  assert.equal(h.lifecycle.accepting, true, '再起動しないのにメンションを受け付けなくなっている');
});

test('interaction 応答・待機 job の取り消しも allowedMentions を明示している', async () => {
  // ここまでのテストで通った全送信 (reply / editReply / placeholder.edit) を検査する。
  // 1 経路でもラッパを通し忘れると、本文に残った文字列がそのまま通知になる
  assert.ok(mentionGuards.length > 0, '送信が 1 件も記録されていない (前提が崩れている)');
  for (const am of mentionGuards) {
    assert.ok(am, `allowedMentions の無い送信がある (${mentionGuards.length} 件中)`);
    assert.deepEqual(am.parse, []);
    assert.deepEqual(am.users, []);
    assert.equal(am.repliedUser, false);
  }
});

// ---- チャンネル既定の編成 (channels.<name>.roster) ----

const CH_ROSTER = { cwd: 'C:/tmp', channelName: 'sandbox', roster: ['opus'] };

test('/roster: チャンネル既定は「未設定」ではなく既定として表示する', async () => {
  const h = harness({ channelConfig: CH_ROSTER });
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster' }));
  assert.match(rosterOut(h.log), /Opus \(`opus`\)/);
  assert.match(rosterOut(h.log), /チャンネル既定/);
  assert.doesNotMatch(rosterOut(h.log), /未設定/, '絞られているのに未設定と言っている');
  assert.equal(h.roster.get('T1'), null, '表示だけのはずが書き込んでいる');
});

test('/roster: スレッドの指定はチャンネル既定を上書きする', async () => {
  const h = harness({ channelConfig: CH_ROSTER });
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'fable' } }));
  assert.deepEqual(h.roster.get('T1'), ['fable']);
  assert.match(rosterOut(h.log), /Fable \(`fable`\)/);
  assert.doesNotMatch(rosterOut(h.log), /チャンネル既定/, 'スレッド指定に既定の注記が付いている');
});

test('/roster: 解除で戻る先はチャンネル既定 (全員ではない)', async () => {
  const h = harness({ channelConfig: CH_ROSTER });
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'fable' } }));
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'all' } }));
  assert.equal(h.roster.get('T1'), null, 'スレッド側の指定が消えていない');
  assert.match(rosterOut(h.log), /解除/);
  assert.match(rosterOut(h.log), /Opus \(`opus`\)/, '既定へ戻ることを伝えていない');
  assert.doesNotMatch(
    rosterOut(h.log),
    /すべて呼べます/,
    '既定で絞られたままなのに「すべて呼べます」と言っている',
  );
});

test('/roster: チャンネル既定が無ければ従来どおり「すべて呼べます」', async () => {
  const h = harness();
  await h.onInteraction(BOT, h.interaction({ commandName: 'roster', options: { members: 'all' } }));
  assert.match(rosterOut(h.log), /解除|未設定/);
  assert.match(rosterOut(h.log), /すべて呼べます/);
});

test('stopJobs は止める前に item.onStop へ「誰が・待機中か」を知らせる (実行記録の意図的停止)', async () => {
  const log = [];
  const jobs = {
    selectForStop: () => ({
      active: [{ handle: { abort: () => log.push('abort') }, onStop: (info) => log.push(`stop:${info.kind}:${info.waiting}`) }],
      dequeued: [
        { handle: {}, onStop: (info) => log.push(`stop:${info.kind}:${info.waiting}`) },
        { handle: {}, onStop: () => { throw new Error('記録できない'); } },
      ],
    }),
  };
  const { cancelled } = stopJobs(jobs, { all: true, message: '⏹', stopKind: 'shutdown' });
  await cancelled;
  // 通知は abort より先 (中断で job が先に終わっても記録が追い付くように)
  assert.deepEqual(log, ['stop:shutdown:true', 'stop:shutdown:false', 'abort']);
  // 既定は human (/stop)
  const seen = [];
  stopJobs({ selectForStop: () => ({ active: [{ onStop: (i) => seen.push(i.kind) }], dequeued: [] }) }, { all: true, message: '⏹' });
  assert.deepEqual(seen, ['human']);
});
