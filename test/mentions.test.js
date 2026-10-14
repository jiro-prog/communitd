import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_REVIEW_APPROVAL_CHARS,
  MAX_SCOUT_TITLE_CHARS,
  MAX_TASK_START_CHARS,
  MAX_THREAD_NAME_CHARS,
  adjudicationRequestMessage,
  approvalNoteMessages,
  adjudicationThreadName,
  carryMessages,
  allowedMentionsFor,
  detectLegacyMentions,
  harnessStartMessage,
  harnessThreadName,
  initiativeStartMessage,
  initiativeThreadName,
  neutralizeRawMentions,
  parseAttachMarkers,
  normalizeNewlines,
  planStartMessage,
  planThreadName,
  resolveOutgoingText,
  reviewApprovalSection,
  safePayload,
  scoutReportMessages,
  scoutStartMessage,
  scoutThreadName,
  sendBackMessage,
  sendBody,
  sendControlMention,
  stripFooterControls,
  stripMarkerLines,
  taskStartMessage,
  taskThreadName,
} from '../src/mentions.js';
import { INFRA_PREFIXES } from '../src/bridge/prompt.js';
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

test('stripFooterControls は末尾フッターの呼び出し行だけを外す (attach・本文中・コード内は残す)', () => {
  const text = [
    '本文です。',
    '[[handoff:mid]]',
    '```',
    '[[handoff:code]]',
    '```',
    '',
    '[[attach: out/a.png]]',
    '[[handoff:x]]\r',
    '[[notify:owner]]',
  ].join('\n');
  const out = stripFooterControls(text);
  assert.deepEqual(out.removed, ['[[handoff:x]]', '[[notify:owner]]']);
  // 外した後の本文は resolveOutgoingText で何も呼ばない (本文中の行は従来どおり不発の警告だけ)
  const ctx = { bots: [{ key: 'mid', userId: '2' }, { key: 'x', userId: '3' }], owner: { userId: '1' } };
  const resolved = resolveOutgoingText(out.text, ctx);
  assert.equal(resolved.mention, null);
  assert.ok(resolved.warnings.some((w) => w.includes('本文中の `[[handoff:mid]]` は実行していません')));
  assert.deepEqual(resolved.attachMarkers, ['out/a.png']);
  assert.match(out.text, /^\[\[handoff:mid\]\]$/m);
  assert.match(out.text, /^\[\[handoff:code\]\]$/m);

  // 呼び出しが無ければ何も外さない。不可視文字入りは実行されないので触らない
  assert.deepEqual(stripFooterControls('本文\n[[attach: a.png]]').removed, []);
  assert.deepEqual(stripFooterControls('本文\n[[handoff:o​pus]]').removed, []);
  assert.deepEqual(stripFooterControls(null), { text: '', removed: [] });
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
    // 不可視文字入りの行 (行そのものを抜粋する経路)。不可視文字そのものが検体
    // eslint-disable-next-line no-irregular-whitespace
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

test('承認時の備考は運用の接頭辞で始めず (文脈から外されない)、生メンションを潰す', () => {
  assert.deepEqual(approvalNoteMessages({ note: '' }), [], '備考が無ければ出さない');
  assert.deepEqual(approvalNoteMessages({ note: '  \n ' }), []);

  const [text, ...rest] = approvalNoteMessages({ note: '承認します。\n- <@123456789> を呼ばない\n- touch の外は触らない', approver: 'Reviewer' });
  assert.deepEqual(rest, [], '短い備考は 1 通');
  assert.ok(text.startsWith('### 承認時の備考 (Reviewer)\n'), text);
  assert.equal(INFRA_PREFIXES.some((p) => text.startsWith(p)), false, '運用メッセージとして文脈から外される');
  assert.match(text, /\n\n承認します。\n- \[mention:123456789\] を呼ばない\n- touch の外は触らない$/);
  assert.equal(/<@\d+>/.test(text), false, '生メンションが残っている (受信側が起動と読む)');
  assert.ok(approvalNoteMessages({ note: 'x' })[0].startsWith('### 承認時の備考\n'), '承認した bot が分からなければ括弧を付けない');
});

test('長い承認時の備考は切らずに分ける (注意は本文の末尾に来る) — どの通も 1 通の上限内で、接頭辞で始めない', () => {
  const tail = '着手する人への注意: ⚠️ 作業ツリーの src を戻している途中で落ちると差分が残る';
  const note = `${'①重複: なし。\n'.repeat(500)}${tail}`;
  const parts = approvalNoteMessages({ note, approver: 'Reviewer' });
  assert.ok(parts.length >= 3, `分けていない (${parts.length} 通)`);
  for (const [i, part] of parts.entries()) {
    assert.ok(part.length <= MAX_TASK_START_CHARS, `${i + 1} 通目が上限を超える (${part.length} 字)`);
    assert.equal(INFRA_PREFIXES.some((p) => part.startsWith(p)), false, `${i + 1} 通目が文脈から外される`);
  }
  assert.ok(parts[0].startsWith('### 承認時の備考 (Reviewer)\n'));
  for (const part of parts.slice(1)) assert.ok(part.startsWith('### 承認時の備考 (続き)\n'), part.slice(0, 40));
  assert.ok(parts.at(-1).endsWith(tail), '末尾の注意が消えている');
  // 見出しを外してつなげると元の本文に戻る (途中を落としていない)
  const body = parts.map((p, i) => (i === 0 ? p : p.slice('### 承認時の備考 (続き)\n'.length))).join('');
  assert.ok(body.endsWith(note), '途中が欠けている');
});

test('レビューの依頼に載せる承認時の備考は、無ければ空・長ければ上限で切る', () => {
  assert.equal(reviewApprovalSection(''), '');
  assert.equal(reviewApprovalSection(null), '');
  assert.equal(
    reviewApprovalSection(' 触る範囲は a.js だけ \n'),
    '\n\n承認時の備考 (承認した側が着手する人へ残した注意を含む — 守られているかも見る):\n触る範囲は a.js だけ',
  );
  const long = reviewApprovalSection('い'.repeat(MAX_REVIEW_APPROVAL_CHARS + 10));
  assert.ok(long.endsWith(`${'い'.repeat(MAX_REVIEW_APPROVAL_CHARS)}…`));
  assert.equal(long.includes('い'.repeat(MAX_REVIEW_APPROVAL_CHARS + 1)), false);
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

test('ハーネスの改訂: スレッド名は JST で刻み、起動文は成績と改訂の範囲と 0 件の許可を 1 通に載せる', () => {
  const at = Date.parse('2026-10-12T09:15:30.000Z');
  assert.equal(harnessThreadName(at), 'harness/2026-10-12 18:15 JST');
  assert.equal(harnessThreadName('いま'), 'harness');

  const text = harnessStartMessage({
    botUserId: 'F1',
    verdictLines: ['opus (worker): 今 `aaaaaaaaaaaa` 25 本・問題 8% ← 前 記録前 70 本・13% → 同等 (z -0.70)'],
    gateReason: '計測済み',
    editable: ['roles/_common.md', 'roles/worker.md'],
  });
  assert.ok(text.startsWith('<@F1>\n'));
  assert.match(text, /### 成績 \(bot ごとに 今の版 ← 前の版 \/ 計測済み\)\n- opus \(worker\): 今 `aaaaaaaaaaaa` 25 本/);
  assert.match(text, /直してよいのは `roles\/_common\.md` \/ `roles\/worker\.md` だけ/);
  assert.match(text, /起票は 0 件か 1 件/);
  assert.match(text, /communitd-protocol/);
  assert.match(text, /scripts\/harness-report\.mjs/);
  assert.match(text, /task-proposal 様式/);
  assert.ok(text.length <= MAX_TASK_START_CHARS);

  // 成績の行が多ければそちらを削り、規律は残す
  const many = harnessStartMessage({ botUserId: 'F1', verdictLines: Array.from({ length: 40 }, (_, i) => `bot${i}: ${'x'.repeat(80)}`), editable: ['roles/worker.md'] });
  assert.ok(many.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${many.length} 字)`);
  assert.match(many, /- …ほか \d+ 体/);
  assert.match(many, /0 件も正しい報告/);
  // 直してよい役割文が無ければ起票しないよう言う
  assert.match(harnessStartMessage({ botUserId: 'F1' }), /直してよい役割文が無い — 起票しないこと/);
  // model / effort の変更: 申し送りが企画の巡回へ届くならそこへ (作者を直接呼ばない)、届かなければ従来どおり
  assert.match(text, /model \/ effort の変更は起票せず `\[\[notify:owner\]\]` で上げる/);
  const carried = harnessStartMessage({ botUserId: 'F1', editable: ['roles/worker.md'], carry: true });
  assert.match(carried, /model \/ effort の変更は起票せず `carry` \(申し送り\) に書く \(次の企画の巡回がまとめて作者に上げる\)/);
  assert.doesNotMatch(carried, /notify:owner/);
  // 台帳が無ければ節も「当たったか」の手順も出さない
  assert.doesNotMatch(text, /前の改訂/);
  assert.match(text, /--trace <job id>/);

  // 前の改訂の台帳は成績の後・進め方の前に置き、当たったかを本文の頭に書かせる
  const withLedger = harnessStartMessage({
    botUserId: 'F1',
    verdictLines: ['opus (worker): 今 `bbbbbbbbbbbb` 25 本・問題 4%'],
    editable: ['roles/worker.md'],
    ledgerLines: ['#135 10-12 13:27 merge (roles/worker.md): 1 項 — 狙い: 差し戻しを減らす', 'opus: `aaaa` 26 本・8% → `bbbb` 25 本・問題 1 (4%) — #148 sent-back'],
  });
  assert.match(withLedger, /### 成績[^]*### 前の改訂 \(台帳\)\n- #135 10-12 13:27 merge \(roles\/worker\.md\): 1 項 — 狙い: 差し戻しを減らす\n- opus: `aaaa`[^]*### 進め方/);
  assert.match(withLedger, /前の改訂の狙いが当たったか.*本文 \(body\) の頭に 1 行書く \(0 件でも\)/);
  assert.ok(withLedger.length <= MAX_TASK_START_CHARS);
});

test('企画の巡回: スレッド名は JST で刻み、起動文は主題の現状と考え抜く手順と柵を 1 通に載せる', () => {
  const at = Date.parse('2026-10-12T09:15:30.000Z');
  assert.equal(planThreadName(at), 'plan/2026-10-12 18:15 JST');
  assert.equal(planThreadName('いま'), 'plan');

  const text = planStartMessage({
    botUserId: 'F1',
    themesFile: 'docs/themes.md',
    directionFile: 'docs/direction.md',
    mode: 'add',
    reason: '進行中の主題 1 / 上限 2',
    themeLines: ['[active] pi-worker — Sol を worker に (タスク merged 2 / 進行中 1 / 捨てた 0)', 'これまで: 完了 1 / 取り下げ 0 (結果はファイルに)'],
  });
  assert.ok(text.startsWith('<@F1>\n'));
  assert.match(text, /### 主題 \(`docs\/themes\.md` \/ 進行中の主題 1 \/ 上限 2\)\n- \[active\] pi-worker — Sol を worker に/);
  assert.match(text, /`docs\/direction\.md` \(範囲と柵の正本\)/);
  assert.match(text, /scripts\/harness-report\.mjs/);
  // 回し方の成績は loop-report を読ませ、node -e で数え直させない (チャンネル名は字面のまま — 引数を増やさない)
  const loopReportRead = /`node scripts\/harness-report\.mjs` \(成績と問題の抜粋\)・`node scripts\/loop-report\.mjs --channel <チャンネル名>` \(回し方の成績\)・/;
  const loopReportCite = /\*\*回し方も振り返る\*\*: 空回りの巡回・日次上限で止まった時間 \(loop-report の数字を引く。`node -e` で数え直さない\)。/;
  assert.match(text, loopReportRead);
  assert.match(text, loopReportCite);
  // 考え抜く手順: 振り返り → 候補 3 つ以上 → 反論 → 0〜1 件
  assert.match(text, /1\. \*\*振り返り\*\*/);
  assert.match(text, /2\. \*\*候補を 3 つ以上\*\*/);
  assert.match(text, /3\. \*\*反論\*\*/);
  assert.match(text, /4\. \*\*起票は 0 件か 1 件。\*\* touch は `docs\/themes\.md` だけ/);
  assert.match(text, /易しい仕事 \(テストを足すだけなど\) で数を稼ぐ主題は選ばない/);
  // 柵
  assert.match(text, /役割文 \(ハーネスの改訂の領分\)・設定・台帳・作者の返事待ちの設計は主題にしない/);
  assert.match(text, /方向性ドキュメントは書き換えない/);
  assert.match(text, /0 件も正しい報告/);
  assert.match(text, /task-proposal 様式/);
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);

  // 配備待ちの主題は [waiting] にさせる (枠に数えず、スカウトも割らない)
  assert.match(text, /残りが配備 \(`\/restart`\) や時間の経過を待つ確認だけなら `\[waiting\]` にする \(枠に数えず、スカウトも割らない/);
  // 回し方も振り返り、設定と作者にしかできないものは主題にせず 1 通にまとめて上げる (同じ用件を重ねない)
  assert.match(text, /\*\*回し方も振り返る\*\*.*主題にせず数字を添えて\*\*まとめて 1 通\*\*で上げる \(本文の最後に `\[\[notify:owner\]\]`。無ければ呼ばない/);
  assert.match(text, /開いている同じ用件は重ねない/);
  assert.doesNotMatch(text, /### 回し方/, '数字を渡していないのに見出しを出している');
  assert.doesNotMatch(text, /\*\*申し送り\*\*/, '申し送りが無いのにさばかせている');
  // 申し送りを出したなら、1 件ずつさばかせる
  const carried = planStartMessage({ botUserId: 'F1', themesFile: 'docs/themes.md', carryCount: 2 });
  assert.match(carried, /- \*\*申し送り\*\* \(この上の投稿、2 件\) を 1 件ずつさばき、本文に 1 行ずつ書く: 主題で扱う \/ 捨てる \(理由\) \/ 作者にしかできない/);
  assert.ok(carried.indexOf('**申し送り**') < carried.indexOf('**回し方も振り返る**'));

  // 上限なら振り返りが先 — 枠を空けたら同じ 1 件で足してよい (段の番号は詰める)
  const review = planStartMessage({ botUserId: 'F1', themesFile: 'docs/themes.md', mode: 'review' });
  assert.match(review, /2\. \*\*主題は上限\*\* — 振り返りで枠を空けない限り新しい主題は足さない。空けたら同じ 1 件で足してよい \(候補 3 つ以上 → 反論 → 1 つ/);
  assert.doesNotMatch(review, /2\. \*\*候補を 3 つ以上\*\*/);
  assert.match(review, /3\. \*\*起票は 0 件か 1 件。\*\*/);
  // 回し方の数字 (ブリッジの勘定) は主題の後・進め方の前に載る
  const loop = planStartMessage({
    botUserId: 'F1', themesFile: 'docs/themes.md', mode: 'review',
    themeLines: ['[waiting] job-cost — 重さ (タスク merged 3 / 進行中 0 / 捨てた 0)'],
    loopLines: ['スカウト: 続けて提案 0 件 2 回 — 間隔 240 分 (設定 60 分)', '自律起動: 今日 23 / 40 job'],
  });
  assert.match(loop, /- \[waiting\] job-cost[^]*\n\n### 回し方 \(ブリッジの勘定\)\n- スカウト: 続けて提案 0 件 2 回 — 間隔 240 分 \(設定 60 分\)\n- 自律起動: 今日 23 \/ 40 job\n\n### 進め方/);
  assert.match(loop, loopReportRead);
  assert.match(loop, loopReportCite);
  assert.ok(loop.length <= MAX_TASK_START_CHARS);
  // 主題がまだ無い
  assert.match(planStartMessage({ botUserId: 'F1', themesFile: 'docs/themes.md' }), /- \(まだ無い — 最初の主題を考える\)/);
  // 主題の行が多ければそちらを削り、手順と柵は残す
  const many = planStartMessage({
    botUserId: 'F1', themesFile: 'docs/themes.md', themeLines: Array.from({ length: 40 }, (_, i) => `[active] t${i} — ${'x'.repeat(80)}`),
    loopLines: [
      'スカウト: 続けて提案 0 件 9 回 — 間隔 240 分 (設定 60 分。0 件が続くと伸び、merge で戻る)',
      '自律起動: 今日 40 / 40 job (着手・巡回・自動復旧の数。レビュー・承認は数えない)',
    ],
  });
  assert.match(many, /### 回し方[^]*回し方も振り返る/, '主題の行より先に回し方を削っている');
  assert.ok(many.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${many.length} 字)`);
  assert.match(many, /- …ほか \d+ 行/);
  assert.match(many, /0 件も正しい報告/);
  // 1 通に収めるために削られるのは主題の行で、loop-report を読ませる 2 か所は残る
  assert.match(many, loopReportRead);
  assert.match(many, loopReportCite);
});

test('スカウトの起動文: 企画の巡回を置いたチャンネルでは進行中の主題を優先させ、題に [slug] を付けさせる', () => {
  const text = scoutStartMessage({
    botUserId: 'O1',
    directionFile: 'docs/direction.md',
    themes: { file: 'docs/themes.md', active: [{ slug: 'pi-worker', title: 'Sol を worker に' }, { slug: 'owner-view', title: '見るべきものを束ねる' }] },
  });
  assert.match(text, /進行中の主題 \(`docs\/themes\.md`\) の次の 1 歩を優先する:\*\* `pi-worker` Sol を worker に \/ `owner-view` 見るべきものを束ねる/);
  assert.match(text, /題の頭に `\[slug\]` を付ける/);
  assert.match(text, /主題ファイル自体は触らない/);
  // 主題が無い / 企画の巡回を置いていない
  assert.match(scoutStartMessage({ botUserId: 'O1', directionFile: 'd.md', themes: { file: 'docs/themes.md', active: [] } }), /進行中の主題は無い/);
  assert.doesNotMatch(scoutStartMessage({ botUserId: 'O1', directionFile: 'd.md' }), /主題/);
});

test('スカウトの起動文: 企画の巡回があるチャンネルだけ、気づきと作者の手が要るものを申し送りに書かせる', () => {
  const withPlanner = scoutStartMessage({ botUserId: 'O1', directionFile: 'd.md', themes: { file: 'docs/themes.md', active: [] } });
  assert.match(withPlanner, /作者の手が要るもの \(配備・`\/retry`・設定\) は `carry` \(申し送り\) に書く — 次の企画の巡回がまとめてさばく。`\[\[notify:owner\]\]` で作者を直接呼ばない/);
  // 企画の巡回が無ければ申し送りは届かないので言わない
  assert.doesNotMatch(scoutStartMessage({ botUserId: 'O1', directionFile: 'd.md' }), /carry/);
  // 一覧が長くても規律は残る (一覧の方を削る)
  const many = scoutStartMessage({
    botUserId: 'O1', directionFile: 'd.md', themes: { file: 'docs/themes.md', active: [] },
    openTasks: Array.from({ length: 60 }, (_, i) => ({ id: String(i), state: 'merged', title: 'x'.repeat(120) })),
  });
  assert.ok(many.length <= MAX_TASK_START_CHARS);
  assert.match(many, /`carry` \(申し送り\)/);
});

test('carryMessages: 申し送りを時刻と書き手つきで並べ、生メンションと制御フッターを潰し、長ければ分ける', () => {
  assert.deepEqual(carryMessages({ items: [] }), []);
  assert.deepEqual(carryMessages(), []);
  const at = Date.parse('2026-10-14T06:30:00.000Z'); // 15:30 JST
  const [only] = carryMessages({
    items: [
      { at, from: 'opus', text: '日次上限 40 に 19:58 で達して 4 時間止まった\n(巡回 20・着手 20) <@123456789012> [[notify:owner]]' },
      { at, from: '', text: '#89 は /retry 待ち' },
      { at, from: 'opus', text: '   ' },
    ],
  });
  assert.ok(only.startsWith('### 申し送り (前の企画の巡回の後 2 件)\n'), only);
  assert.match(only, /\n- 10-14 15:30 opus: 日次上限 40 に 19:58 で達して 4 時間止まった \(巡回 20・着手 20\) /);
  assert.match(only, /\n- 10-14 15:30 \?: #89 は \/retry 待ち$/);
  assert.doesNotMatch(only, /<@123456789012>/, '生メンションが残っている');
  assert.doesNotMatch(only, /\[\[notify/, '制御フッターの表記が残っている');
  // 長ければ切らずに分け、2 通目以降は (続き) の見出しで始める
  const long = carryMessages({ items: Array.from({ length: 12 }, (_, i) => ({ at, from: 'opus', text: `${i} ${'x'.repeat(290)}` })) });
  assert.ok(long.length >= 2);
  for (const text of long) assert.ok(text.length <= MAX_TASK_START_CHARS);
  assert.ok(long[1].startsWith('### 申し送り (続き)\n'));
  assert.equal(long.join('\n').match(/x{290}/g).length, 12, '分けるときに申し送りを落としている');
});

test('scoutReportMessages: 前回の巡回の報告を時刻と件数つきで出し、生メンションと制御フッターの行を外し、長ければ分ける', () => {
  assert.deepEqual(scoutReportMessages({ report: null }), [], '前回が無ければ出さない');
  assert.deepEqual(scoutReportMessages(), []);
  const at = Date.parse('2026-10-13T21:12:00.000Z'); // 10-14 06:12 JST
  const [only, ...rest] = scoutReportMessages({
    report: { at, proposed: 0, body: '起票なし。\r\n次の巡回への申し送り: <@123456789012> の件は #164 待ち\n\n[[notify:owner]]\n' },
  });
  assert.deepEqual(rest, []);
  assert.equal(
    only,
    '### 前回の巡回 (10-14 06:12 JST) の報告 — 提案 0 件\n参考。判断は今回の巡回で\n\n'
      + '起票なし。\n次の巡回への申し送り: [mention:123456789012] の件は #164 待ち',
  );
  assert.ok(!INFRA_PREFIXES.some((p) => only.startsWith(p)), '運用の接頭辞で始まると文脈から外される');
  // 本文が空でも件数は材料になる (見出しと参考の行だけ)
  assert.deepEqual(
    scoutReportMessages({ report: { at, proposed: 2, body: '' } }),
    ['### 前回の巡回 (10-14 06:12 JST) の報告 — 提案 2 件\n参考。判断は今回の巡回で'],
  );

  // 本文の上限 (契約の 6000 字) いっぱいでも切らずに分け、どの通も 1 通の上限内・2 通目以降は (続き) で始める
  const body = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')} ${'y'.repeat(96)}`).join('\n').padEnd(6000, '。');
  assert.equal(body.length, 6000);
  const parts = scoutReportMessages({ report: { at, proposed: 3, body } });
  assert.ok(parts.length >= 4, `分けていない (${parts.length} 通)`);
  for (const part of parts) assert.ok(part.length <= MAX_TASK_START_CHARS, `${part.length} 字`);
  assert.ok(parts[0].startsWith('### 前回の巡回 (10-14 06:12 JST) の報告 — 提案 3 件\n'));
  for (const part of parts.slice(1)) assert.ok(part.startsWith('### 前回の巡回の報告 (続き)\n'), part.slice(0, 40));
  const joined = parts.map((p, i) => (i === 0 ? p : p.slice('### 前回の巡回の報告 (続き)\n'.length))).join('');
  assert.ok(joined.endsWith(body), '分けるときに本文を落としている');
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

test('スカウトの一覧は題を「 — 」の前に縮める (題 200〜600 字の merged 12 件がすべて載る)', () => {
  // 主題 50〜100 字・題全体 200〜600 字。題のまま並べると 1 通に 4 行ほどしか入らなかった
  const merged = Array.from({ length: 12 }, (_, i) => {
    const subject = `主題${i}を直す`.padEnd(50 + Math.round((i * 50) / 11), 'あ');
    const total = 200 + i * 36;
    return {
      id: String(118 + i),
      state: 'merged',
      subject,
      title: `${subject} — ${'い'.repeat(total - subject.length - 3)}`,
    };
  });
  assert.equal(merged[11].title.length, 596);
  assert.equal(merged[11].subject.length, 100);
  const text = scoutStartMessage({
    botUserId: 'O1', directionFile: 'docs/direction.md', openTasks: merged,
  });
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
  // 行の形 `- [state] id: 題` は保ち、題の部分だけが主題になる
  for (const task of merged) {
    assert.ok(text.includes(`\n- [merged] ${task.id}: ${task.subject}\n`), `${task.id} が主題で載っていない`);
  }
  assert.doesNotMatch(text, /…ほか/);
});

test('主題が 100 字を超えたら 100 字 + … で切る (「 — 」が無い題は全体を切る)', () => {
  assert.equal(MAX_SCOUT_TITLE_CHARS, 100);
  const text = scoutStartMessage({
    botUserId: 'O1',
    directionFile: 'docs/direction.md',
    openTasks: [
      { id: '1', state: 'proposed', title: `${'う'.repeat(130)} — ${'え'.repeat(200)}` },
      { id: '2', state: 'approved', title: 'お'.repeat(300) },
      { id: '3', state: 'review', title: '短い主題 — 詳細' },
      { id: '4', state: 'blocked', title: 'か'.repeat(100) }, // ちょうど 100 字は切らない
      { id: '5', state: 'in-progress', title: '改行を\n含む  主題 — 詳細' },
    ],
  });
  assert.ok(text.includes(`\n- [proposed] 1: ${'う'.repeat(100)}…\n`));
  assert.ok(text.includes(`\n- [approved] 2: ${'お'.repeat(100)}…\n`));
  assert.ok(text.includes('\n- [review] 3: 短い主題\n'));
  assert.ok(text.includes(`\n- [blocked] 4: ${'か'.repeat(100)}\n`));
  assert.ok(text.includes('\n- [in-progress] 5: 改行を 含む 主題\n'));
});

test('主題に縮めても溢れる件数なら「…ほか n 件」を残して末尾から削る (規律は残す)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(100 + i), state: 'merged', title: `${'あ'.repeat(90)}${i} — ${'い'.repeat(400)}`,
  }));
  const text = scoutStartMessage({
    botUserId: 'O1', directionFile: 'docs/direction.md', openTasks: many,
  });
  assert.ok(text.length <= MAX_TASK_START_CHARS, `1 通に収まっていない (${text.length} 字)`);
  const shown = text.split('\n').filter((line) => line.startsWith('- [merged] '));
  assert.ok(shown.length >= 10, `主題に縮めても ${shown.length} 行しか載っていない`);
  // 削るのは末尾から — 先頭 (scoutBoardView が新しい merged を置く側) が残る
  assert.deepEqual(
    shown.map((line) => line.split(' ')[2]),
    many.slice(0, shown.length).map((task) => `${task.id}:`),
  );
  assert.ok(text.includes(`\n- …ほか ${many.length - shown.length} 件\n`), '削ったことが分からない');
  assert.match(text, /task-proposal 様式/, '規律まで削っている');
  assert.match(text, /0 件も正しい報告/);
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
