import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_TASK_START_CHARS,
  MAX_THREAD_NAME_CHARS,
  adjudicationRequestMessage,
  adjudicationThreadName,
  allowedMentionsFor,
  detectLegacyMentions,
  initiativeStartMessage,
  initiativeThreadName,
  neutralizeRawMentions,
  parseAttachMarkers,
  normalizeNewlines,
  resolveOutgoingText,
  safePayload,
  scoutStartMessage,
  scoutThreadName,
  sendBackMessage,
  sendBody,
  sendControlMention,
  stripMarkerLines,
  taskStartMessage,
  taskThreadName,
} from '../src/mentions.js';
import { shouldIgnoreOwnMessage } from '../src/trigger.js';

/** 3 bot + owner の標準的な文脈 (送信元は opus) */
function ctx(overrides = {}) {
  return {
    selfBotKey: 'opus',
    bots: [
      { key: 'fable', displayName: 'Fable', userId: 'F1' },
      { key: 'opus', displayName: 'Opus', userId: 'O1' },
      { key: 'sol', displayName: 'Sol', userId: 'S1' },
    ],
    owner: { userId: 'H1', names: ['So', 'そう'] },
    ...overrides,
  };
}

// ---- 起動する唯一の経路: 末尾の制御フッター ----

test('末尾の [[handoff:key]] だけが実メンションを 1 件生む', () => {
  const out = resolveOutgoingText('検収お願いします。\n\n[[handoff:fable]]', ctx());
  assert.deepEqual(out.mention, { kind: 'handoff', userId: 'F1', label: 'Fable' });
  assert.equal(out.body, '検収お願いします。');
  assert.deepEqual(out.warnings, []);
});

test('[[notify:owner]] は ownerUserId へ解決する', () => {
  const out = resolveOutgoingText('裁定をお願いします。\n\n[[notify:owner]]', ctx());
  assert.deepEqual(out.mention, { kind: 'notify', userId: 'H1', label: 'So' });
  assert.equal(out.body, '裁定をお願いします。');
});

test('フッターは大文字小文字と余白を吸収する', () => {
  for (const line of ['[[handoff:FABLE]]', '[[ handoff : fable ]]', '  [[handoff:fable]]  ']) {
    const out = resolveOutgoingText(`本文\n\n${line}`, ctx());
    assert.equal(out.mention?.userId, 'F1', `解決できていない: ${line}`);
  }
});

test('画像添付マーカーと並べてもフッターとして成立する', () => {
  const out = resolveOutgoingText(
    ['できました。', '', '[[attach: out/a.png]]', '[[handoff:fable]]'].join('\n'),
    ctx(),
  );
  assert.deepEqual(out.attachMarkers, ['out/a.png']);
  assert.equal(out.mention?.userId, 'F1');
  assert.equal(out.body, 'できました。');
});

// ---- 起動しない経路 (誤起動ゼロ) ----

test('平文の @名前 では起動しない (変換せず警告だけ出す)', () => {
  const out = resolveOutgoingText('@Fable 検収お願いします。@So 判断ください。', ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body, '@Fable 検収お願いします。@So 判断ください。');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /`@Fable`/);
  assert.match(out.warnings[0], /`@So`/);
  assert.match(out.warnings[0], /\[\[handoff:ボットキー\]\]/);
});

test('引用・説明としての @名前 も同じく起動しない', () => {
  const out = resolveOutgoingText('> @Opus 実装して\nと書かれていました。', ctx());
  assert.equal(out.mention, null);
});

test('コード内のフッターは実行も除去もしない (説明として残す)', () => {
  const text = ['書き方はこうです。', '', '```', '[[handoff:fable]]', '```'].join('\n');
  const out = resolveOutgoingText(text, ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body.includes('[[handoff:fable]]'), true);
  assert.deepEqual(out.warnings, []); // 説明を書いただけで警告は出さない
});

test('インラインコード内のフッターも実行しない', () => {
  const out = resolveOutgoingText('末尾に `[[handoff:fable]]` と書きます', ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body, '末尾に `[[handoff:fable]]` と書きます');
});

test('デリミタ長を対応させる — 外 2 個・内 1 個のコードスパン', () => {
  // ``` `` `X` `` ``` のような入れ子で領域を取り違えると、説明のつもりの
  // フッターを本物として実行してしまう
  const out = resolveOutgoingText('表記は `` `[[handoff:fable]]` `` です', ctx());
  assert.equal(out.mention, null);
});

test('閉じていないインラインコードはコード扱いしない', () => {
  // 本文にバッククォートが 1 つ紛れただけで委譲が落ちる方が困る
  const out = resolveOutgoingText('` 補足\n\n[[handoff:fable]]', ctx());
  assert.equal(out.mention?.userId, 'F1');
});

test('閉じていないコードブロックは末尾までコード扱い (途中で切れた例文から起動しない)', () => {
  // 応答が切り詰められてフェンスが閉じないまま終わると、例として書いたフッターが
  // 本物の起動指示に化ける — 閉じ忘れは「起動しない」側へ倒す
  const cut = ['書き方はこうです。', '', '```', '[[handoff:fable]]'].join('\n');
  const out = resolveOutgoingText(cut, ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body.includes('[[handoff:fable]]'), true, '説明として残っていない');

  // 閉じていないフェンスより前のフッターも巻き込まれない
  const before = ['[[handoff:fable]]'].join('\n');
  assert.equal(resolveOutgoingText(before, ctx()).mention?.userId, 'F1');

  // attach も同じ扱い (未閉鎖フェンス内は送信対象にしない)
  assert.deepEqual(parseAttachMarkers('```\n[[attach: a.png]]'), []);
});

test('生の <@id> は無効化され、起動判定の迂回路にならない', () => {
  // 実 ID は snowflake (数字) — 受信側 (src/trigger.js) が生 content から拾う形
  const out = resolveOutgoingText('よろしく <@100000000000000001> と <@!100000000000000001>', ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body.includes('<@'), false);
  assert.match(out.warnings.join('\n'), /2 件を無効化/);
});

test('生 ID の無害化はコード領域の中にも効く (受信側は生 content を見るため)', () => {
  const out = resolveOutgoingText('```\n<@123456789>\n```', ctx());
  assert.equal(out.body.includes('<@123456789>'), false);
  assert.equal(out.body.includes('[mention:123456789]'), true);
});

test('role メンションと everyone / here も無害化する', () => {
  const { text, count } = neutralizeRawMentions('<@&999888777> と @everyone と @here');
  assert.equal(text, '[role:999888777] と [everyone] と [here]');
  assert.equal(count, 3);
  // 語の一部 (@hereafter) は対象外
  assert.equal(neutralizeRawMentions('@hereafter').count, 0);
});

// ---- fail-closed ----

test('未知の bot-key は起動せず、使える宛先を警告に出す', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:nobody]]', ctx());
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /未知の宛先/);
  assert.match(out.warnings[0], /fable/);
  assert.equal(out.warnings[0].includes('opus'), false, '自分自身を候補に挙げてはいけない');
});

test('自分宛の handoff は自己呼び出しとして解決する (kind で他人宛と区別できる)', () => {
  const out = resolveOutgoingText('次は実装をやります。\n\n[[handoff:opus]]', ctx());
  assert.deepEqual(out.mention, { kind: 'self', userId: 'O1', label: 'Opus' });
  assert.deepEqual(out.warnings, [], '自己呼び出しは警告を出さない');
});

test('編成から自分が外れていれば自己呼び出しも起動しない', () => {
  // 送信側の allowlist は自分にも効く。実行文脈でも同じ条件で案内を落としてある
  const bots = [
    { key: 'fable', displayName: 'Fable', userId: 'F1', inRoster: true },
    { key: 'opus', displayName: 'Opus', userId: 'O1', inRoster: false },
  ];
  const out = resolveOutgoingText('本文\n\n[[handoff:opus]]', ctx({ bots }));
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /編成に入っていません/);
});

test('未ログインの bot 宛は起動しない', () => {
  const bots = [
    { key: 'fable', displayName: 'Fable', userId: null },
    { key: 'opus', displayName: 'Opus', userId: 'O1' },
  ];
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]', ctx({ bots }));
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /起動していません/);
});

test('編成 (/roster) から外れた bot 宛は起動しない', () => {
  const bots = [
    { key: 'fable', displayName: 'Fable', userId: 'F1', inRoster: false },
    { key: 'opus', displayName: 'Opus', userId: 'O1', inRoster: true },
  ];
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]', ctx({ bots }));
  assert.equal(out.mention, null, '起動していても編成外なら呼ばせない');
  assert.match(out.warnings[0], /編成に入っていません/);
  assert.match(out.warnings[0], /roster/, '直し方が分からない警告になっている');
});

test('未知の宛先の候補に編成外を並べない', () => {
  const bots = [
    { key: 'fable', displayName: 'Fable', userId: 'F1', inRoster: false },
    { key: 'sol', displayName: 'Sol', userId: 'S1', inRoster: true },
    { key: 'opus', displayName: 'Opus', userId: 'O1', inRoster: true },
  ];
  const out = resolveOutgoingText('本文\n\n[[handoff:nobody]]', ctx({ bots }));
  assert.match(out.warnings[0], /未知の宛先/);
  assert.match(out.warnings[0], /sol/);
  assert.equal(out.warnings[0].includes('fable'), false, '呼べない相手を候補に挙げている');
});

test('フッターが複数あればどれも実行しない', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]\n[[notify:owner]]', ctx());
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /2 個/);
  // マーカー行そのものは本文から消える (Discord へ晒さない)
  assert.equal(out.body, '本文');
});

test('同じ宛先を 2 回書いた場合も実行しない (通知を 1 回に畳まない)', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]\n[[handoff:fable]]', ctx());
  assert.equal(out.mention, null);
});

test('ownerUserId 未設定なら [[notify:owner]] は実行しない', () => {
  const out = resolveOutgoingText('本文\n\n[[notify:owner]]', ctx({ owner: null }));
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /ownerUserId/);
});

test('notify の宛先は owner だけ', () => {
  const out = resolveOutgoingText('本文\n\n[[notify:fable]]', ctx());
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /未知の宛先/);
});

test('本文の途中に置いた制御マーカーは実行せず、誤配置として警告する', () => {
  const out = resolveOutgoingText('[[handoff:fable]]\n\n本文が後ろにある', ctx());
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /末尾の独立行/);
  assert.equal(out.body, '本文が後ろにある');
});

test('行の途中に書かれたマーカーはマーカーとして扱わない', () => {
  const out = resolveOutgoingText('説明中に [[handoff:fable]] と書いた行です', ctx());
  assert.equal(out.mention, null);
  assert.equal(out.body, '説明中に [[handoff:fable]] と書いた行です');
});

// ---- 改行・不可視文字 ----

test('CRLF でもフッターは成立する (行末の \\r で不発にしない)', () => {
  const out = resolveOutgoingText('検収お願いします。\r\n\r\n[[handoff:fable]]\r\n', ctx());
  assert.equal(out.mention?.userId, 'F1', 'CRLF で委譲が落ちている');
  assert.equal(out.body, '検収お願いします。');
  assert.equal(out.body.includes('\r'), false, '本文に \\r が残っている');
  // 単独 CR も LF へ寄せる
  assert.equal(resolveOutgoingText('本文\r\r[[handoff:fable]]', ctx()).mention?.userId, 'F1');
  assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
});

test('不可視文字を含む疑似フッターは実行せず警告する', () => {
  // ゼロ幅スペース・NBSP が紛れた「見た目は正しいフッター」
  for (const line of ['[[handoff:​fable]]', '[[handoff:fable]] ', '﻿[[handoff:fable]]']) {
    const out = resolveOutgoingText(`本文\n\n${line}`, ctx());
    assert.equal(out.mention, null, `実行してはいけない: ${JSON.stringify(line)}`);
    assert.ok(
      out.warnings.some((w) => w.includes('不可視文字')),
      `警告が出ていない: ${JSON.stringify(line)}`,
    );
  }
});

test('不可視文字の警告は正しいフッターには出ない', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]', ctx());
  assert.equal(out.warnings.filter((w) => w.includes('不可視文字')).length, 0);
});

// ---- 旧記法の警告 ----

test('フッターで呼べているなら旧記法の指摘は出さない (雑音を増やさない)', () => {
  const out = resolveOutgoingText('@Fable 検収お願いします。\n\n[[handoff:fable]]', ctx());
  assert.equal(out.mention?.userId, 'F1');
  assert.deepEqual(out.warnings, []);
});

test('コード内の @名前 は旧記法として数えない', () => {
  assert.deepEqual(detectLegacyMentions('`@Fable` と書きます', ['Fable']), []);
  assert.deepEqual(detectLegacyMentions('@Fable と書きます', ['Fable']), ['Fable']);
  // 名前の一部に埋もれた表記は拾わない
  assert.deepEqual(detectLegacyMentions('@Solaris は別物', ['Sol']), []);
  // 非 ASCII の呼び名 (\b が使えない)
  assert.deepEqual(detectLegacyMentions('@そう 判断ください', ['そう']), ['そう']);
});

// ---- マーカー行の共通パーサ ----

test('parseAttachMarkers は独立行だけを拾い重複を畳む', () => {
  const text = [
    'グラフです。',
    '[[attach: out/chart.png]]',
    '説明中に [[attach: x.png]] と書いた行は対象外です。',
    '[[attach: out/chart.png]]',
    '[[attach:out/second.png]]',
  ].join('\n');
  assert.deepEqual(parseAttachMarkers(text), ['out/chart.png', 'out/second.png']);
  const body = stripMarkerLines(text);
  assert.equal(body.includes('[[attach: out/chart.png]]'), false);
  assert.equal(body.includes('説明中に [[attach: x.png]] と書いた行'), true);
});

test('コードブロック内の attach は送信対象にしない', () => {
  const text = ['書き方:', '```', '[[attach: out/a.png]]', '```'].join('\n');
  assert.deepEqual(parseAttachMarkers(text), []);
  assert.equal(stripMarkerLines(text).includes('[[attach: out/a.png]]'), true);
});

// ---- 送信ペイロード ----

test('allowedMentionsFor は挙げた ID だけを許可し parse を空にする', () => {
  assert.deepEqual(allowedMentionsFor(['F1']), {
    parse: [], users: ['F1'], roles: [], repliedUser: false,
  });
  // 空・重複・非文字列は落とす
  assert.deepEqual(allowedMentionsFor(['F1', 'F1', '', null]).users, ['F1']);
  assert.deepEqual(allowedMentionsFor().users, []);
});

test('safePayload は allowedMentions を必ず付ける (文字列でも files でも)', () => {
  assert.deepEqual(safePayload('hi'), { content: 'hi', allowedMentions: allowedMentionsFor() });
  const withFiles = safePayload({ files: ['x'] }, { mentionUserIds: ['F1'] });
  assert.deepEqual(withFiles.files, ['x']);
  assert.deepEqual(withFiles.allowedMentions.users, ['F1']);
  // 呼び出し側が allowedMentions を上書きしようとしても勝てない
  const forced = safePayload({ content: 'x', allowedMentions: { parse: ['users'] } });
  assert.deepEqual(forced.allowedMentions.parse, []);
});

test('mentionUserIds はペイロードのキーとして漏れない', () => {
  assert.equal('mentionUserIds' in safePayload('x', { mentionUserIds: ['F1'] }), false);
});

// ---- 送信 (分割と通知回数) ----

/** send を記録するだけの channel */
function fakeChannel() {
  const sent = [];
  return {
    sent,
    send: async (payload) => { sent.push(payload); return payload; },
    mentioned: () => sent.flatMap((p) => p.allowedMentions.users),
    text: () => sent.map((p) => p.content).join(''),
  };
}

test('本文には実メンションを一切載せない (分割されても通知ゼロ)', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i}: ${'x'.repeat(60)}`).join('\n');
  const ch = fakeChannel();
  const sent = await sendBody(ch, { body: long, mention: { userId: 'F1' } }, { chunkSize: 300 });
  assert.ok(sent > 1, '分割されていない (テストの前提が崩れている)');
  assert.deepEqual(ch.mentioned(), [], '本文で相手を呼んでいる');
  assert.equal(ch.text().includes('<@F1>'), false);
});

test('制御メンションは専用の 1 通で、そこだけが通知になる', async () => {
  const ch = fakeChannel();
  await sendBody(ch, { body: '報告です' });
  await sendControlMention(ch, { userId: 'F1' });
  assert.equal(ch.sent.length, 2);
  assert.equal(ch.sent[1].content, '<@F1>');
  assert.deepEqual(ch.mentioned(), ['F1'], '通知が増えている / 載っていない');
  assert.deepEqual(ch.sent[0].allowedMentions.users, []);
});

test('閉じ忘れたコードブロックに飲み込まれたフッターは警告に出す', () => {
  // 閉じ忘れは末尾までコード扱い (fail-closed) なので実行されないが、警告が無いと
  // 「委譲したつもりで相手が起動しない」に気付けない — いちばん見えにくい失敗
  const fence = '`'.repeat(3);
  const swallowed = resolveOutgoingText(
    ['直してください', `${fence}js`, 'const x = 1;', '', '[[handoff:fable]]'].join('\n'),
    ctx(),
  );
  assert.equal(swallowed.mention, null, '閉じ忘れの中を実行してしまっている');
  assert.equal(swallowed.warnings.length, 1);
  assert.match(swallowed.warnings[0], /閉じていないコードブロック/);
  assert.match(swallowed.warnings[0], /\[\[handoff:fable\]\]/);

  // 閉じてあれば従来どおり実行され、警告も出ない
  const closed = resolveOutgoingText(
    ['直してください', `${fence}js`, 'const x = 1;', fence, '', '[[handoff:fable]]'].join('\n'),
    ctx(),
  );
  assert.equal(closed.mention?.userId, 'F1');
  assert.deepEqual(closed.warnings, []);
});

test('警告に生メンションを復活させない (警告が起動経路にならない)', async () => {
  // 警告はモデルが書いた文字列を引用するので、本文で潰した生 ID が警告で復活しうる。
  // allowedMentions は通知を止めるだけで、受信側は生の msg.content を見るため、
  // それだけで別の bot が起動する (sol 指摘 2026-08-03)
  const { resolveTrigger } = await import('../src/trigger.js');
  const fence = '`'.repeat(3);
  const cases = [
    // 未閉鎖フェンスに飲み込まれたフッターの引数
    ['本文', `${fence}js`, 'x', '', '[[handoff:<@100000000000000001>]]'].join('\n'),
    // 未知の宛先 (引数をそのまま警告に載せる経路)
    '本文\n\n[[handoff:<@100000000000000001>]]',
    // 本文中の誤配置
    '[[handoff:<@100000000000000001>]]\n\n本文',
    // 不可視文字入りの行 (行そのものを抜粋する経路)
    `本文\n\n[[handoff:​<@100000000000000001>]]`,
  ];
  for (const raw of cases) {
    const out = resolveOutgoingText(raw, ctx());
    const joined = out.warnings.join('\n');
    assert.ok(out.warnings.length > 0, `警告が出ていない: ${JSON.stringify(raw)}`);
    assert.equal(joined.includes('<@'), false, `生メンションが警告に残った: ${joined}`);
    assert.equal(out.body.includes('<@'), false);
    // 実際にその警告を投稿しても、受信側の起動判定に引っかからない
    const trigger = await resolveTrigger({
      content: `⚠️ メンション制御の警告:\n${joined}`,
      botUserId: '100000000000000001',
      authorIsBot: true,
      otherBots: [],
    });
    assert.equal(trigger.triggered, false, `警告が起動経路になっている: ${joined}`);
  }
});

test('警告の無害化は role メンション・everyone にも効く', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:<@&100000000000000001> @everyone]]', ctx());
  const joined = out.warnings.join('\n');
  assert.equal(joined.includes('<@&'), false);
  assert.equal(joined.includes('@everyone'), false);
  assert.match(joined, /\[role:100000000000000001\]/);
});

test('制御メンションには 1 行の目印を添えられる (T6 の契約タグ)', async () => {
  // 契約を受け手へ結び付ける目印。**通知は増やさない**し、起動を決めるのは
  // 従来どおりメンション 1 個だけ
  const ch = fakeChannel();
  await sendControlMention(ch, { userId: 'F1' }, { suffix: '`契約:a1b2c3d4`' });
  assert.equal(ch.sent[0].content, '<@F1>\n`契約:a1b2c3d4`');
  assert.deepEqual(ch.mentioned(), ['F1'], '通知先が増減している');

  // 空・空白だけの目印は付けない (契約が無い handoff は従来と同じ 1 行)
  for (const suffix of ['', '   ', null, undefined]) {
    const plain = fakeChannel();
    await sendControlMention(plain, { userId: 'F1' }, { suffix });
    assert.equal(plain.sent[0].content, '<@F1>', `余計な行が付いた: ${JSON.stringify(suffix)}`);
  }
  const noOpts = fakeChannel();
  await sendControlMention(noOpts, { userId: 'F1' });
  assert.equal(noOpts.sent[0].content, '<@F1>');
});

test('宛先が無ければ制御メンションは送らない', async () => {
  const ch = fakeChannel();
  await sendControlMention(ch, null);
  await sendControlMention(ch, {});
  assert.equal(ch.sent.length, 0);
});

test('本文が空 (画像のみ) でも送信は成立する', async () => {
  const ch = fakeChannel();
  await sendBody(ch, { body: '', mention: null });
  assert.equal(ch.sent[0].content, '(画像のみ)');
});

// ---- 空・異常入力 ----

test('マーカーのない本文はそのまま通る', () => {
  const out = resolveOutgoingText('ふつうの返信', ctx());
  assert.equal(out.body, 'ふつうの返信');
  assert.equal(out.mention, null);
  assert.deepEqual(out.attachMarkers, []);
  assert.deepEqual(out.warnings, []);
});

test('null / 空文字でも落ちない', () => {
  for (const raw of [null, undefined, '']) {
    const out = resolveOutgoingText(raw, ctx());
    assert.equal(out.body, '');
    assert.equal(out.mention, null);
  }
  assert.deepEqual(parseAttachMarkers(null), []);
  assert.equal(stripMarkerLines(null), '');
});

test('文脈が空でも落ちない (ready 前)', () => {
  const out = resolveOutgoingText('本文\n\n[[handoff:fable]]', {});
  assert.equal(out.mention, null);
  assert.match(out.warnings[0], /未知の宛先/);
});

// ---- 自律運転のタスクスレッド (docs/social-engineering.md §3.1) ----

const TASK = {
  id: '3',
  title: 'タスク一覧に状態バッジを足す',
  rationale: '状態が色で分かると社会の様子が一目で読める',
  branch: 'task/3',
  jobBudget: 20,
};

test('スレッド名は task/<id> で始まり、Discord の上限へ丸める', () => {
  assert.equal(taskThreadName(TASK), 'task/3 タスク一覧に状態バッジを足す');
  // 改行や連続空白は 1 つに潰す (スレッド名に改行は入れられない)
  assert.equal(taskThreadName({ id: 7, title: '前半\n  後半' }), 'task/7 前半 後半');
  assert.equal(taskThreadName({ id: '9' }), 'task/9', 'タイトル無しでも id は残す');

  const long = taskThreadName({ id: '1', title: 'あ'.repeat(200) });
  assert.equal(long.length, MAX_THREAD_NAME_CHARS);
  assert.equal(long.startsWith('task/1 '), true, '削るのはタイトル側');
  assert.equal(long.endsWith('…'), true, '切ったことが見た目で分かる');
  // 上限ちょうどは丸めない
  const edge = taskThreadName({ id: '1', title: 'あ'.repeat(MAX_THREAD_NAME_CHARS - 7) });
  assert.equal(edge.length, MAX_THREAD_NAME_CHARS);
  assert.equal(edge.endsWith('…'), false);
});

test('起動メッセージは 1 行目が <@botId> ちょうどで、タスク文脈を載せる', () => {
  const text = taskStartMessage({ task: TASK, botUserId: 'O1', directionFile: 'docs/direction.md' });
  const lines = text.split('\n');
  assert.equal(lines[0], '<@O1>', '1 行目が制御メッセージの形になっていない');
  assert.match(text, /タスク 3: タスク一覧に状態バッジを足す/);
  assert.match(text, /一目で読める/, '起票の理由が落ちている');
  assert.match(text, /`task\/3` で作業する/);
  assert.match(text, /20 job/);
  assert.match(text, /`docs\/direction.md`/);
  assert.match(text, /報告様式/);
  // 完了の報告にフッタを書かせない (書くと完了と見なされず review へ進まない)
  assert.match(text, /完了の報告には本文に制御フッタを書かないこと/);
  assert.match(text, /自己呼び出し.*は、従来どおりフッタでよい/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);
});

test('起動メッセージは宛先自身の発言としては通らない (多行だから)', () => {
  // これは事故ではなく前提: worker 自身の client から投げると
  // shouldIgnoreOwnMessage に捨てられる = 別の bot が投げなければならない
  const text = taskStartMessage({ task: TASK, botUserId: 'O1' });
  assert.equal(
    shouldIgnoreOwnMessage({ authorId: 'O1', botUserId: 'O1', content: text }),
    true,
    '自分の多行発言が通るようになっている (自己呼び出しの暴発防止が壊れている)',
  );
  // 別の bot が投げた分にはこの判定はかからない
  assert.equal(shouldIgnoreOwnMessage({ authorId: 'F1', botUserId: 'O1', content: text }), false);
});

test('起動メッセージは 1 通に収める (溢れたら理由を削り、約束は残す)', () => {
  const text = taskStartMessage({
    task: { ...TASK, title: 'あ'.repeat(1000), rationale: 'い'.repeat(1000) },
    botUserId: 'O1',
    directionFile: 'docs/direction.md',
  });
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
  assert.equal(text.split('\n')[0], '<@O1>');
  assert.match(text, /報告様式/, '約束まで削っている');
  assert.match(text, /…/, '削ったことが分かる印が無い');
});

test('差し戻しメッセージは指摘をそのまま載せ、次が無いことを伝える', () => {
  const text = sendBackMessage({
    task: TASK, botUserId: 'O1', reason: 'test/a.test.js:12 のケースが無い', budget: 2,
  });
  assert.equal(text.split('\n')[0], '<@O1>', '1 行目が制御メッセージの形になっていない');
  assert.match(text, /差し戻し — タスク 3/);
  assert.match(text, /test\/a.test.js:12 のケースが無い/, '指摘が落ちている');
  assert.match(text, /`task\/3` のまま直す/);
  assert.match(text, /追い予算 2 job/);
  assert.match(text, /次の差し戻しは無い/);
  assert.match(text, /報告様式/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);

  // 宛先自身の発言としては通らない (別の bot が投げる前提)
  assert.equal(shouldIgnoreOwnMessage({ authorId: 'O1', botUserId: 'O1', content: text }), true);
});

test('差し戻しメッセージは指摘が無くても・長すぎても 1 通に収まる', () => {
  const bare = sendBackMessage({ task: { id: '9' }, botUserId: 'O1' });
  assert.match(bare, /指摘の記載なし/);
  assert.match(bare, /`task\/9` のまま直す/);
  assert.match(bare, /次の差し戻しは無い/);

  const long = sendBackMessage({ task: TASK, botUserId: 'O1', reason: 'あ'.repeat(4000), budget: 2 });
  assert.ok(long.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${long.length} 字)`);
  assert.match(long, /…/);
  assert.match(long, /報告様式/, '約束まで削っている');
});

test('スカウトのスレッド名は JST で刻む (日次予算の区切りと同じ暦)', () => {
  const at = Date.parse('2026-08-27T09:15:30.000Z');
  assert.equal(scoutThreadName(at), 'scout/2026-08-27 18:15 JST');
  assert.equal(scoutThreadName(new Date(at)), 'scout/2026-08-27 18:15 JST');
  assert.ok(scoutThreadName(at).length <= MAX_THREAD_NAME_CHARS);
  // 壊れた時刻でもスレッド作成を落とさない
  for (const bad of ['いま', undefined, null, NaN]) {
    assert.equal(scoutThreadName(bad), 'scout', JSON.stringify(bad));
  }
});

test('スカウトの起動文はボードの現状と様式の指示を載せる', () => {
  const text = scoutStartMessage({
    botUserId: 'O1',
    directionFile: 'docs/direction.md',
    openTasks: [
      { id: '3', state: 'proposed', title: '状態バッジを足す' },
      { id: '4', state: 'approved', title: 'タイムラインを足す' },
      { id: '5', state: 'in-progress', title: '検索を足す' },
      { id: '6', state: 'review', title: 'pytest を足す' },
      { id: '7', state: 'blocked', title: '認証を足す' },
      { id: '8', state: 'merged', title: '例外台帳の lint' },
    ],
  });
  assert.equal(text.split('\n')[0], '<@O1>', '1 行目が制御メッセージの形になっていない');
  // §9.1 — 着手前だけでなく、進行中と直近に着地したものも見せる
  assert.match(text, /### いまボードにあるもの \(進行中・直近に着地したものを含む\)/);
  assert.match(text, /- \[proposed\] 3: 状態バッジを足す/);
  assert.match(text, /- \[approved\] 4: タイムラインを足す/);
  assert.match(text, /- \[in-progress\] 5: 検索を足す/);
  assert.match(text, /- \[review\] 6: pytest を足す/);
  assert.match(text, /- \[blocked\] 7: 認証を足す/);
  assert.match(text, /- \[merged\] 8: 例外台帳の lint/);
  assert.match(text, /二重に起票しない/);
  assert.match(text, /`docs\/direction.md`/);
  assert.match(text, /task-proposal 様式/);
  assert.match(text, /0 件も正しい報告/);
  // 承認はブリッジが自動で回すので、フッタを書かせない (書くと承認担当が二重に起動する)
  assert.match(text, /制御フッタ.*を書かない/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);
});

test('ボードが空なら (なし) と伝える / 方向性が無ければ起票させない', () => {
  assert.match(scoutStartMessage({ botUserId: 'O1', directionFile: 'd.md' }), /- \(なし\)/);
  assert.match(scoutStartMessage({ botUserId: 'O1' }), /方向性ドキュメントが設定されていない/);
});

test('一覧が長ければ一覧の方を削る (様式と 0 件の許可は残す)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(i + 1), state: 'proposed', title: 'あ'.repeat(80),
  }));
  const text = scoutStartMessage({
    botUserId: 'O1', directionFile: 'docs/direction.md', openTasks: many,
  });
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
  assert.match(text, /…ほか \d+ 件/, '削ったことが分からない');
  assert.match(text, /task-proposal 様式/, '規律まで削っている');
  assert.match(text, /0 件も正しい報告/);
  assert.equal(text.split('\n')[0], '<@O1>');
});

test('裁定依頼は提案の中身と返し方を載せる (work / process が滞留しないように)', () => {
  const text = adjudicationRequestMessage({
    botUserId: 'F1',
    proposal: {
      id: '7',
      class: 'process',
      raisedBy: 'opus',
      subjectKeys: ['doc:docs/handbook.md'],
      input: {
        kind: 'process-edit',
        duty: 'org-audit',
        remedy: 'policy',
        summary: '手順が古い',
        evidence: ['3 回連続で差し戻し'],
        benefits: ['往復が減る'],
        risks: ['書き換えの手間'],
        cost: '1 job',
      },
    },
  });
  assert.equal(text.split('\n')[0], '<@F1>', '1 行目が制御メッセージの形になっていない');
  assert.match(text, /提案 #7 \(process \/ process-edit\)/);
  assert.match(text, /doc:docs\/handbook\.md/);
  assert.match(text, /起草: opus/);
  assert.match(text, /手順が古い/);
  assert.match(text, /3 回連続で差し戻し/);
  assert.match(text, /report 様式/);
  assert.match(text, /proposal_id: "7"/);
  assert.match(text, /理由は必ず書く/);
  assert.match(text, /保留は状態として無い/);
  assert.match(text, /制御フッタ.*を書かない/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);

  // 欠けた提案でも組み立てられる (投稿できずに滞留させない)
  const bare = adjudicationRequestMessage({ botUserId: 'F1', proposal: { id: '8' } });
  assert.equal(bare.split('\n')[0], '<@F1>');
  assert.match(bare, /\(記載なし\)/);
  assert.match(bare, /\(不明\)/);
});

test('裁定依頼と巡回は様式・発議の目印をこの 1 通に載せる', () => {
  const withTags = adjudicationRequestMessage({
    botUserId: 'F1',
    proposal: { id: '7', class: 'work' },
    schemaTag: '`様式:report`',
    initiativeTag: '`発議:裁定`',
  });
  assert.match(withTags, /`様式:report`/);
  assert.match(withTags, /`発議:裁定`/);
  assert.equal(withTags.split('\n')[0], '<@F1>', '1 行目が制御メッセージの形でなくなっている');

  const patrol = initiativeStartMessage({
    botUserId: 'S1', duty: 'audit', schemaTag: '`様式:report`', initiativeTag: '`発議:巡回`',
  });
  assert.match(patrol, /`様式:report`/);
  assert.match(patrol, /`発議:巡回`/);
  assert.equal(patrol.split('\n')[0], '<@S1>');

  // 目印を渡さなくても見出しは崩れない (末尾に空白を残さない)
  for (const text of [
    adjudicationRequestMessage({ botUserId: 'F1', proposal: { id: '7', class: 'work' } }),
    initiativeStartMessage({ botUserId: 'S1', duty: 'audit' }),
  ]) {
    const heading = text.split('\n').find((l) => l.startsWith('## '));
    assert.equal(heading, heading.trimEnd());
    assert.equal(text.includes('様式:'), false);
    assert.equal(text.includes('発議:'), false);
  }
});

test('裁定依頼を親チャンネルへ落とすときのスレッド名は proposal/<id>', () => {
  // bot 起点の投稿はスレッドの中だけが job になるので、archive されたスレッドを
  // 避けるときは親へ直接投げず、専用スレッドを立ててその中へ入れる
  assert.equal(
    adjudicationThreadName({ id: '7', input: { summary: '兼務を解く' } }),
    'proposal/7 兼務を解く',
  );
  assert.equal(adjudicationThreadName({ id: '7' }), 'proposal/7');
  assert.equal(adjudicationThreadName({}), 'proposal/?');
  assert.equal(adjudicationThreadName(), 'proposal/?');
  const long = adjudicationThreadName({ id: '7', input: { summary: 'あ'.repeat(200) } });
  assert.ok(long.length <= MAX_THREAD_NAME_CHARS);
  assert.match(long, /…$/);
});

test('発議のスレッド名は duty と JST を刻む', () => {
  const at = Date.parse('2026-08-27T09:15:30.000Z');
  assert.equal(initiativeThreadName('org-audit', at), 'initiative/org-audit/2026-08-27 18:15 JST');
  assert.ok(initiativeThreadName('org-audit', at).length <= MAX_THREAD_NAME_CHARS);
  // 壊れた時刻・欠けた duty でもスレッド作成を落とさない
  assert.equal(initiativeThreadName('audit', 'いま'), 'initiative/audit');
  assert.equal(initiativeThreadName('', at), `initiative/duty/${'2026-08-27 18:15 JST'}`);
});

test('発議の起動文は open な提案と「発議なしも正常」を載せる', () => {
  const text = initiativeStartMessage({
    botUserId: 'S1',
    duty: 'org-audit',
    directionFile: 'docs/direction.md',
    openProposals: [
      { id: '3', class: 'org', state: 'deliberating', summary: '兼務を解く' },
      { id: '4', class: 'process', state: 'trial', summary: '手順を短くする' },
    ],
  });
  assert.equal(text.split('\n')[0], '<@S1>', '1 行目が制御メッセージの形になっていない');
  assert.match(text, /duty: org-audit/);
  assert.match(text, /定期巡回です/);
  assert.match(text, /- \[org\/deliberating\] 3: 兼務を解く/);
  assert.match(text, /- \[process\/trial\] 4: 手順を短くする/);
  assert.match(text, /重ねて発議しないこと/);
  assert.match(text, /report 様式/);
  assert.match(text, /発議なし.*も正常な巡回/);
  assert.match(text, /check > tooling > policy > role/);
  // 裁定はブリッジが回すので、フッタを書かせない
  assert.match(text, /制御フッタ.*を書かない/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);
});

test('発議の起動文はイベント契機を書き分け、一覧が長ければ一覧の方を削る', () => {
  assert.match(
    initiativeStartMessage({ botUserId: 'S1', duty: 'audit', trigger: 'block — タスク #3' }),
    /\*\*block — タスク #3\*\* を受けて起こしました/,
  );
  assert.match(initiativeStartMessage({ botUserId: 'S1', duty: 'audit' }), /- \(なし\)/);

  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(i + 1), class: 'org', state: 'raised', summary: 'あ'.repeat(80),
  }));
  const text = initiativeStartMessage({
    botUserId: 'S1', duty: 'audit', directionFile: 'd.md', openProposals: many,
  });
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
  assert.match(text, /…ほか \d+ 件/, '削ったことが分からない');
  assert.match(text, /発議なし.*も正常な巡回/, '規律まで削っている');
});

test('起動メッセージは欠けた値でも組み立てられる (人間へ確認を促す)', () => {
  const text = taskStartMessage({ task: { id: '1' }, botUserId: 'O1' });
  assert.equal(text.split('\n')[0], '<@O1>');
  assert.match(text, /\(記載なし\)/);
  assert.match(text, /`task\/1` で作業する/, 'branch 未設定でも task\\/<id> へ倒す');
  assert.match(text, /job 予算: 未設定/);
  assert.match(text, /方向性ドキュメントが設定されていない/);
});
