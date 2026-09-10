import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMPTY_INBOX,
  InboxStore,
  MAX_INBOX_CHARS,
  MAX_ROW_SUMMARY_CHARS,
  MAX_SUMMARY_CHARS,
  formatInbox,
  summarizeForInbox,
} from '../src/inbox.js';
import { createInteractionHandler } from '../src/interactions.js';

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const minutes = (n) => n * 60000;
const hours = (n) => minutes(60 * n);

const storePath = () => join(mkdtempSync(join(tmpdir(), 'communitd-inbox-')), 'inbox.json');
const store = () => new InboxStore(storePath());

const notice = (over = {}) => ({
  channel: 'yobidashi-dev',
  threadId: 'T1',
  botKey: 'opus',
  summary: '仕様に無い配置の裁定をお願いします',
  messageId: 'M1',
  ...over,
});

// ---- InboxStore ----

test('open は entry を 1 件足す (開いたまま・閉じ方は未定)', () => {
  const s = store();
  const entry = s.open(notice(), { now: T0 });

  assert.equal(entry.id, '1');
  assert.equal(entry.channel, 'yobidashi-dev');
  assert.equal(entry.threadId, 'T1');
  assert.equal(entry.botKey, 'opus');
  assert.equal(entry.summary, '仕様に無い配置の裁定をお願いします');
  assert.equal(entry.messageId, 'M1');
  assert.equal(entry.openedAt, new Date(T0).toISOString());
  assert.equal(entry.closedAt, null);
  assert.equal(entry.closedBy, null);
  assert.equal(s.openList().length, 1);
});

test('threadId が無い記録は断る (どのスレッドの待ちか決まらない)', () => {
  const s = store();
  assert.throws(() => s.open(notice({ threadId: null })), /threadId/);
  assert.equal(s.openList().length, 0);
});

test('同じスレッドに open があれば件数は増えず、要旨・時刻・メッセージ ID・誰からを上書きする', () => {
  const s = store();
  const first = s.open(notice(), { now: T0 });
  const second = s.open(
    notice({ summary: '催促: まだ待っています', messageId: 'M2', botKey: 'fable', channel: 'observatory' }),
    { now: T0 + hours(2) },
  );

  assert.equal(second.id, first.id, '別 entry になっている (1 スレッド 1 open のはず)');
  assert.equal(s.openList().length, 1);
  assert.equal(second.summary, '催促: まだ待っています');
  assert.equal(second.messageId, 'M2');
  assert.equal(second.openedAt, new Date(T0 + hours(2)).toISOString());
  // 要旨は催促した bot のものなので、「誰から」も催促した側に揃える
  assert.equal(second.botKey, 'fable');
  assert.equal(second.channel, 'observatory');
});

test('上書きで渡されなかった値は消さない (書かれなかっただけで、消しに来たのではない)', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  const second = s.open({ threadId: 'T1', summary: '続きです' }, { now: T0 + hours(1) });

  assert.equal(second.botKey, 'opus');
  assert.equal(second.channel, 'yobidashi-dev');
  assert.equal(second.summary, '続きです');
  assert.equal(second.messageId, null, 'メッセージ ID は毎回その通のものへ差し替える');
});

test('別スレッドの通知は別の entry になる', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  s.open(notice({ threadId: 'T2', botKey: 'fable' }), { now: T0 });
  assert.deepEqual(s.openList().map((e) => e.id), ['1', '2']);
});

test('スレッドに人間が発言したら human-reply で閉じる', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  s.open(notice({ threadId: 'T2' }), { now: T0 });

  const closed = s.closeByThread('T1', { now: T0 + hours(1) });

  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedBy, 'human-reply');
  assert.equal(closed[0].closedAt, new Date(T0 + hours(1)).toISOString());
  assert.deepEqual(s.openList().map((e) => e.threadId), ['T2'], '別スレッドまで閉じている');
  // 二度目は閉じる対象が無い (閉じ済みを掘り返さない)
  assert.deepEqual(s.closeByThread('T1', { now: T0 + hours(2) }), []);
});

test('/inbox close は manual で閉じる。未知 id・閉じ済みは null', () => {
  const s = store();
  s.open(notice(), { now: T0 });

  const closed = s.close('1', { now: T0 + minutes(30) });
  assert.equal(closed.closedBy, 'manual');
  assert.equal(closed.closedAt, new Date(T0 + minutes(30)).toISOString());
  assert.equal(s.openList().length, 0);

  assert.equal(s.close('1'), null, '閉じ済みをもう一度閉じている');
  assert.equal(s.close('99'), null, '無い id を閉じている');
  assert.equal(s.get('1').closedBy, 'manual', '閉じ方が書き換わっている');
});

test('継承プロパティの id は台帳のものとして扱わない (/inbox close:__proto__ でゴミを書かない)', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  const before = JSON.stringify(s.data);

  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(s.get(id), null, `get('${id}') が拾っている`);
    assert.equal(s.close(id), null, `close('${id}') が「閉じました」を返している`);
  }
  assert.equal(JSON.stringify(s.data), before, '保存内容が変わっている');
  assert.deepEqual(Object.keys(s.data), ['1'], '"undefined" などのゴミキーが増えている');
  assert.equal(s.openList().length, 1, '本物の entry が巻き添えになっている');
});

test('保存後に読み直しても open は残る (再起動で「呼んだのに誰も来ない」を残さない)', () => {
  const path = storePath();
  const first = new InboxStore(path);
  first.open(notice(), { now: T0 });
  first.open(notice({ threadId: 'T2' }), { now: T0 });
  first.close('2', { now: T0 });

  const reloaded = new InboxStore(path);
  assert.deepEqual(reloaded.openList().map((e) => e.id), ['1']);
  assert.equal(reloaded.get('2').closedBy, 'manual');
  // 採番も引き継ぐ (再起動のたびに id が 1 へ戻らない)
  assert.equal(reloaded.open(notice({ threadId: 'T3' }), { now: T0 }).id, '3');
});

// ---- summarizeForInbox ----

test('要旨は制御フッター行を除いた最後の非空段落', () => {
  const body = [
    '調査しました。',
    '',
    '§10.4 の option 設計が書かれていないので止めます。close は string でよいですか。',
    '',
    '[[notify:owner]]',
  ].join('\n');
  assert.equal(
    summarizeForInbox(body),
    '§10.4 の option 設計が書かれていないので止めます。close は string でよいですか。',
  );
});

test('要旨は複数行の段落を 1 行へ均す / 空本文は空文字', () => {
  assert.equal(summarizeForInbox('前置き\n\n質問です\nどちらにしますか'), '質問です どちらにしますか');
  assert.equal(summarizeForInbox('  \n\n  '), '');
  assert.equal(summarizeForInbox(null), '');
  // フッターしか無い応答でマーカーを要旨にしない
  assert.equal(summarizeForInbox('[[notify:owner]]'), '');
});

test('要旨は末尾のコードブロックを飛ばして直前の段落を拾う', () => {
  const fence = '`'.repeat(3);
  const body = [
    '差し戻しの verify がここで落ちます。どちらの挙動が正ですか。',
    '',
    `${fence}text`,
    'not ok 3 - formatInbox は 1900 字で切る',
    `${fence}`,
    '',
    '[[notify:owner]]',
  ].join('\n');
  assert.equal(summarizeForInbox(body), '差し戻しの verify がここで落ちます。どちらの挙動が正ですか。');

  // フェンスの中に空行があってコードブロックが複数段落に割れても、続けて飛ばす
  const split = [
    '質問です。',
    '',
    `${fence}`,
    'line1',
    '',
    'line2',
    `${fence}`,
  ].join('\n');
  assert.equal(summarizeForInbox(split), '質問です。');

  // 途中のコードブロックは触らない (最後の段落が本文ならそれを拾う)
  const middle = [`${fence}js`, 'code()', `${fence}`, '', 'これが質問です。'].join('\n');
  assert.equal(summarizeForInbox(middle), 'これが質問です。');

  // コードブロックしか無ければ空 (フェンスの中身を要旨にしない)
  assert.equal(summarizeForInbox([`${fence}text`, 'ok 1119', `${fence}`].join('\n')), '');
});

test('質問文と同じ段落にフェンスがあっても質問を落とさない (落とすのはフェンスの中の行だけ)', () => {
  const fence = '`'.repeat(3);

  // 質問の直後の行からブロックが始まる形 (bot の出力ではこちらが普通)
  const tight = [
    'ここで落ちます。どちらが正ですか。',
    `${fence}text`,
    'not ok 3 - formatInbox',
    fence,
  ].join('\n');
  assert.equal(summarizeForInbox(tight), 'ここで落ちます。どちらが正ですか。');

  // 前置きの段落があると、質問ごと捨てて前置きを拾ってしまうのが退行の形だった
  const withLead = [
    '調査しました。',
    '',
    'ここで落ちます。どちらが正ですか。',
    `${fence}text`,
    'not ok 3 - formatInbox',
    fence,
    '',
    '[[notify:owner]]',
  ].join('\n');
  assert.equal(summarizeForInbox(withLead), 'ここで落ちます。どちらが正ですか。');

  // 先頭がコードブロックで、最後の行が質問
  const codeFirst = [`${fence}js`, 'code()', fence, '最後の行が質問です。'].join('\n');
  assert.equal(summarizeForInbox(codeFirst), '最後の行が質問です。');

  // 閉じ忘れたブロックは末尾まで落ちる (閉じ忘れは事故なので拾わない側へ倒す)
  const unclosed = ['質問です。', '', `${fence}text`, 'log line'].join('\n');
  assert.equal(summarizeForInbox(unclosed), '質問です。');
});

test('要旨は 140 字を超えると切る', () => {
  const long = 'あ'.repeat(200);
  const out = summarizeForInbox(long);
  assert.equal(out.length, MAX_SUMMARY_CHARS + 1, '「…」込みで 141 字のはず');
  assert.ok(out.endsWith('…'));
  assert.equal(summarizeForInbox('あ'.repeat(MAX_SUMMARY_CHARS)).length, MAX_SUMMARY_CHARS);
});

// ---- formatInbox ----

const proposal = (over = {}) => ({
  id: '5',
  class: 'org',
  state: 'deliberating',
  raisedBy: 'fable',
  taskIds: [],
  input: { kind: 'role-edit', summary: 'sol の憲章に検収の観点を足す' },
  origin: { threadId: 'T9' },
  createdAt: new Date(T0 - hours(3)).toISOString(),
  updatedAt: new Date(T0 - hours(3)).toISOString(),
  ...over,
});

const task = (over = {}) => ({
  id: '12',
  channel: 'kumamikan-tools',
  title: 'verify が原因不明で落ち続ける',
  state: 'blocked',
  threadId: 'T5',
  jobBudget: 6,
  jobsSpent: 4,
  updatedAt: new Date(T0 - minutes(20)).toISOString(),
  ...over,
});

test('3 系統が混ざると 3 節が出て、各行に経過と止めているものが入る', () => {
  const s = store();
  s.open(notice(), { now: T0 - minutes(160) });

  const out = formatInbox({
    notifies: s.openList(),
    proposals: [proposal()],
    tasks: [task()],
    now: T0,
    findTask: (threadId) => (threadId === 'T1' ? { id: '7', state: 'in-progress' } : null),
  });

  assert.match(out, /\*\*停止・質問 \(1 件\)\*\*/);
  assert.match(out, /\*\*稟議 \(1 件\)\*\*/);
  assert.match(out, /\*\*要人間 \(1 件\)\*\*/);
  // 停止・質問: 誰から / 経過 / 要旨 / 止めている task と state / スレッドリンク
  assert.match(out, /・#1 opus 2h40m 「仕様に無い配置の裁定をお願いします」 \(task #7 in-progress\) <#T1>/);
  // 稟議: 種別と、止めている task (無ければそう書く)
  assert.match(out, /・#5 fable 3h0m `role-edit` 「sol の憲章に検収の観点を足す」 \(task 無し\) <#T9>/);
  // 要人間: 残り job (「返すと何本動くか」が 1 行で分かる)
  assert.match(out, /・#12 20m 「verify が原因不明で落ち続ける」 \(残 job 2\) <#T5>/);
  assert.match(out, /\/inbox close/, '手動で閉じる導線が出ていない');
});

test('稟議は org の deliberating だけ / 要人間は blocked だけ', () => {
  const out = formatInbox({
    proposals: [
      proposal({ id: '1', class: 'process' }),
      proposal({ id: '2', state: 'adjudicated' }),
      proposal({ id: '3' }),
    ],
    tasks: [task({ id: '20', state: 'review' }), task({ id: '21' })],
    now: T0,
  });
  assert.match(out, /\*\*稟議 \(1 件\)\*\*/);
  assert.match(out, /・#3 /);
  assert.match(out, /\*\*要人間 \(1 件\)\*\*/);
  assert.match(out, /・#21 /);
  assert.ok(!out.includes('停止・質問'), '空の節を出している');
});

test('各節は待たせている時間が長い順', () => {
  const s = store();
  s.open(notice({ threadId: 'T1', summary: '新しい方' }), { now: T0 - minutes(10) });
  s.open(notice({ threadId: 'T2', summary: '古い方' }), { now: T0 - hours(30) });
  s.open(notice({ threadId: 'T3', summary: '中くらい' }), { now: T0 - hours(2) });

  const out = formatInbox({
    notifies: s.openList(),
    tasks: [
      task({ id: '1', title: 'あとの方', updatedAt: new Date(T0 - minutes(5)).toISOString() }),
      task({ id: '2', title: 'さきの方', updatedAt: new Date(T0 - hours(9)).toISOString() }),
    ],
    now: T0,
  });
  const order = (...needles) => needles.map((n) => out.indexOf(n));
  assert.deepEqual(
    order('古い方', '中くらい', '新しい方').slice().sort((a, b) => a - b),
    order('古い方', '中くらい', '新しい方'),
    '停止・質問が長い順に並んでいない',
  );
  assert.ok(out.indexOf('さきの方') < out.indexOf('あとの方'), '要人間が長い順に並んでいない');
  assert.match(out, /1d6h/, '1 日を超えた待ちが日数で出ていない');
});

test('稟議の経過は deliberating に入った時刻 (意見が付いても待ち時間は戻らない)', () => {
  const deliberated = (id, { since, updatedAt }) => proposal({
    id,
    updatedAt: new Date(updatedAt).toISOString(),
    history: [
      { at: new Date(since - hours(1)).toISOString(), from: null, to: 'raised', by: 'opus' },
      { at: new Date(since).toISOString(), from: 'raised', to: 'deliberating', by: 'opus' },
    ],
  });
  // #1 は 10 時間待たせているが、さっき意見 (position) が付いたので updatedAt は新しい
  const active = deliberated('1', { since: T0 - hours(10), updatedAt: T0 - minutes(1) });
  const quiet = deliberated('2', { since: T0 - hours(2), updatedAt: T0 - hours(2) });

  const out = formatInbox({ proposals: [quiet, active], now: T0 });
  assert.ok(out.indexOf('・#1 ') < out.indexOf('・#2 '), 'updatedAt で並べている (議論が活発だと下がる)');
  assert.match(out, /・#1 fable 10h0m /);
  assert.match(out, /・#2 fable 2h0m /);
});

test('再審議なら最後に deliberating へ入った時刻。history が無ければ updatedAt へ落とす', () => {
  const again = proposal({
    id: '3',
    updatedAt: new Date(T0 - minutes(5)).toISOString(),
    history: [
      { at: new Date(T0 - hours(40)).toISOString(), from: 'raised', to: 'deliberating', by: 'opus' },
      { at: new Date(T0 - hours(30)).toISOString(), from: 'deliberating', to: 'adjudicated', by: 'owner:so' },
      { at: new Date(T0 - hours(4)).toISOString(), from: 'adjudicated', to: 'deliberating', by: 'fable' },
    ],
  });
  const noHistory = proposal({ id: '4', updatedAt: new Date(T0 - hours(6)).toISOString() });

  const out = formatInbox({ proposals: [again, noHistory], now: T0 });
  assert.match(out, /・#3 fable 4h0m /, '前の世代の時刻を見ている');
  assert.match(out, /・#4 fable 6h0m /, 'history 無しで updatedAt に落ちていない');
  assert.ok(out.indexOf('・#4 ') < out.indexOf('・#3 '), '稟議が長い順に並んでいない');
});

test('適用の失敗 (deliberating → deliberating の自己遷移) で待ち時間を巻き戻さない', () => {
  // failApply は既に deliberating の提案へ自己遷移の履歴を積む (src/proposals.js:1635)
  const retried = proposal({
    id: '5',
    updatedAt: new Date(T0 - minutes(2)).toISOString(),
    history: [
      { at: new Date(T0 - hours(9)).toISOString(), from: 'raised', to: 'deliberating', by: 'opus' },
      { at: new Date(T0 - hours(1)).toISOString(), from: 'deliberating', to: 'deliberating', note: '適用に失敗' },
      { at: new Date(T0 - minutes(2)).toISOString(), from: 'deliberating', to: 'deliberating', note: '再度失敗' },
    ],
  });
  const out = formatInbox({ proposals: [retried], now: T0 });
  assert.match(out, /・#5 fable 9h0m /, '自己遷移で「入った時刻」が上書きされている');
});

test('全部空なら 1 行だけ返す (これが出る状態が社会の正常)', () => {
  assert.equal(formatInbox({ now: T0 }), '作者を待っているものはありません');
  assert.equal(
    formatInbox({ notifies: null, proposals: null, tasks: null, now: T0 }),
    '作者を待っているものはありません',
  );
});

test('停止 + 稟議だけで枠を使い切っても、要人間の見出し・先頭 1 行・案内行は消えない', () => {
  const s = store();
  for (let i = 0; i < 14; i += 1) {
    s.open(notice({ threadId: `T${i}`, summary: 'あ'.repeat(MAX_SUMMARY_CHARS) }), { now: T0 - minutes(i) });
  }
  // 停止 1 行 ≈ 94 字・稟議 1 行 ≈ 120 字。**素朴に連結して末尾を切ると、停止 10 行 +
  // 稟議 10 行 (計 2200 字弱) だけで 1900 字に達し、要人間の節と案内行は丸ごと消える。**
  const proposals = Array.from({ length: 12 }, (_, i) => proposal({
    id: String(i + 1),
    taskIds: ['101', '102', '103'],
    input: { kind: 'role-edit', summary: 'い'.repeat(100) },
  }));
  // 要人間の 1 行を稟議の 1 行より長くしておく — こうすると「稟議が入り切らずに残した枠」に
  // 要人間の 2 行目も必ず入らないので、出る件数が枠の端数で揺れない
  const tasks = Array.from({ length: 12 }, (_, i) => task({
    id: String(i + 1),
    title: 'う'.repeat(100),
    threadId: '9'.repeat(60),
  }));

  const out = formatInbox({ notifies: s.openList(), proposals, tasks, now: T0 });
  const lines = out.split('\n');

  assert.ok(out.length <= MAX_INBOX_CHARS, `1900 字を超えている: ${out.length}`);
  assert.match(out, /\*\*停止・質問 \(14 件\)\*\*/);
  assert.match(out, /\*\*稟議 \(12 件\)\*\*/);
  assert.match(out, /\*\*要人間 \(12 件\)\*\*/, '末尾を切るだけなら消えている節が消えている');

  const head = lines.indexOf('**要人間 (12 件)**');
  assert.match(lines[head + 1], /^・#1 /, '要人間の先頭 1 行が出ていない');
  assert.equal(lines[head + 2], '  … ほか 11 件', '削った分が件数で残っていない');
  // 案内行も先に取り置いてあるので、行が溢れても最終行に残る
  assert.match(lines.at(-1), /^— 停止・質問はそのスレッドに返信すれば閉じます/);
  assert.match(out, /… ほか 4 件/, '停止・質問の溢れが件数で出ていない');
});

test('一覧の要旨は 60 字で切る (台帳の 140 字はそのまま)', () => {
  const s = store();
  const long = summarizeForInbox('い'.repeat(200));
  s.open(notice({ summary: long }), { now: T0 });

  assert.equal(s.get('1').summary.length, MAX_SUMMARY_CHARS + 1, '台帳が 140 字で保たれていない');
  const out = formatInbox({ notifies: s.openList(), now: T0 });
  assert.match(out, new RegExp(`「${'い'.repeat(MAX_ROW_SUMMARY_CHARS)}…」`));
  assert.ok(!out.includes('い'.repeat(MAX_ROW_SUMMARY_CHARS + 1)), '60 字を超えて出している');
});

test('escape は要旨にも「誰から」にも効く', () => {
  const s = store();
  s.open(notice({ botKey: 'op@us', summary: '`rm -rf` を打ちますか' }), { now: T0 });
  const out = formatInbox({
    notifies: s.openList(),
    now: T0,
    escape: (v) => String(v).replaceAll('`', "'").replaceAll('@', '＠'),
  });
  assert.match(out, /・#1 op＠us /, '「誰から」に escape が効いていない');
  assert.match(out, /「'rm -rf' を打ちますか」/, '要旨に escape が効いていない');
});

test('閉じ済みの entry は出ない (openList を渡し損ねても出さない)', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  s.close('1', { now: T0 + minutes(1) });
  assert.equal(formatInbox({ notifies: s.list(), now: T0 }), EMPTY_INBOX);
});

test('openedAt を読めない停止通知は「経過?」で先頭に出す (放置を隠さない)', () => {
  const s = store();
  s.open(notice({ threadId: 'T1', summary: '時刻あり' }), { now: T0 - hours(5) });
  const broken = { ...s.open(notice({ threadId: 'T2', summary: '時刻なし' }), { now: T0 }), openedAt: null };

  const out = formatInbox({ notifies: [...s.openList().slice(0, 1), broken], now: T0 });
  assert.ok(out.indexOf('時刻なし') < out.indexOf('時刻あり'), '読めない時刻が後ろへ行っている');
  assert.match(out, /・#2 opus 経過\? 「時刻なし」/);
});

test('board を引けなくても一覧は出る (描画のために落とさない)', () => {
  const s = store();
  s.open(notice(), { now: T0 });
  const out = formatInbox({
    notifies: s.openList(),
    now: T0,
    findTask: () => { throw new Error('board が壊れている'); },
  });
  assert.match(out, /・#1 opus 0m .* \(task 無し\) <#T1>/);
});

// ---- /inbox (interaction) ----

const CONFIG = { guildId: 'G1', allowedUserIds: ['U1'] };
const BOT = { key: 'fable' };

function harness({ inbox = null, board = null, proposals = null } = {}) {
  const log = [];
  const onInteraction = createInteractionHandler({
    config: CONFIG,
    channelConfigFor: () => ({ cwd: 'C:/tmp', channelName: 'yobidashi-dev' }),
    jobs: { activeCount: 0, waitingCount: 0, selectForStop: () => ({ active: [], dequeued: [] }) },
    waitForJobsDrained: async () => {},
    writeRestartNotice: () => {},
    shutdown: async () => {},
    inbox,
    boardOf: () => board,
    proposals,
  });
  const interaction = ({ close = null } = {}) => ({
    commandName: 'inbox',
    guildId: 'G1',
    channelId: 'T1',
    user: { id: 'U1' },
    channel: { id: 'T1', isThread: () => true },
    options: { getString: (n) => (n === 'close' ? close : null), getBoolean: () => null },
    isChatInputCommand: () => true,
    inGuild: () => true,
    deferReply: async () => { log.push('defer'); },
    editReply: async (p) => { log.push(`edit:${p.content}`); },
    reply: async (p) => { log.push(`reply:${p.content}`); },
  });
  return { log, onInteraction, interaction };
}

test('/inbox は 3 節を出す。board / proposals が無くても落ちない', async () => {
  const s = store();
  s.open(notice(), { now: Date.now() - minutes(5) });
  const h = harness({
    inbox: s,
    board: {
      list: () => [task()],
      findByThread: (id) => (id === 'T1' ? { id: '7', state: 'in-progress' } : null),
    },
    proposals: { openList: () => [proposal()] },
  });

  await h.onInteraction(BOT, h.interaction());
  const [, edited] = h.log;
  assert.match(edited, /停止・質問 \(1 件\)/);
  assert.match(edited, /稟議 \(1 件\)/);
  assert.match(edited, /要人間 \(1 件\)/);
  assert.match(edited, /\(task #7 in-progress\)/);

  const bare = harness({ inbox: store() });
  await bare.onInteraction(BOT, bare.interaction());
  assert.equal(bare.log[1], 'edit:作者を待っているものはありません');
});

test('/inbox close は手動で閉じ、未知 id と閉じ済みを区別する', async () => {
  const s = store();
  s.open(notice(), { now: Date.now() });
  const h = harness({ inbox: s });

  await h.onInteraction(BOT, h.interaction({ close: ' 1 ' }));
  assert.match(h.log[1], /^edit:📪 #1 を閉じました/);
  assert.equal(s.openList().length, 0);
  assert.equal(s.get('1').closedBy, 'manual');

  await h.onInteraction(BOT, h.interaction({ close: '1' }));
  assert.match(h.log[3], /^edit:📪 #1 は既に閉じています/);

  await h.onInteraction(BOT, h.interaction({ close: '99' }));
  assert.match(h.log[5], /^edit:⚠️ 停止通知 #99 は見つかりません/);
});

test('/inbox close は一覧の表示どおり # 付きで打っても通る', async () => {
  const s = store();
  s.open(notice(), { now: Date.now() });
  const h = harness({ inbox: s });

  // 一覧は `#1` と出すので、So はそれをそのまま写して打つ
  await h.onInteraction(BOT, h.interaction({ close: '#1' }));

  assert.match(h.log[1], /^edit:📪 #1 を閉じました/);
  assert.ok(!h.log[1].includes('##'), '# が二重になっている');
  assert.equal(s.get('1').closedBy, 'manual');
});

test('受信箱が配線されていなければ ⚠️ を返す (黙って空一覧にしない)', async () => {
  const h = harness({ inbox: null });
  await h.onInteraction(BOT, h.interaction());
  assert.equal(h.log[1], 'edit:⚠️ 受信箱の機能が無効です');
});

// ---- 復旧待ち (§11.2) ----

const recoveryRow = (over = {}) => ({
  task: { id: '77', title: 'doc_path_lint に死活検査を足す', state: 'in-progress', threadId: 'T77' },
  status: {
    status: 'recovery-wait',
    reason: 'verify NG のまま止まっている (opus)',
    since: T0 - hours(4),
    waitedMs: hours(4),
    next: 'recovery',
    run: { id: 'j1' },
  },
  ...over,
});

test('復旧待ちは 4 節目に出て、状態・理由・次の操作・スレッドが 1 行に入る', () => {
  const out = formatInbox({ recoveries: [recoveryRow()], now: T0 });
  assert.match(out, /\*\*復旧待ち \(1 件\)\*\*/);
  assert.match(out, /・#77 4h0m 「doc_path_lint に死活検査を足す」 \(復旧待ち: verify NG のまま止まっている \(opus\) → スレッドで `\/retry`\) <#T77>/);
  assert.match(out, /— 復旧待ちは仕事が動き出せば消えます/);
  assert.ok(!/停止・質問はそのスレッドに/.test(out), '停止・質問の案内が無関係に出ている');
});

test('復旧待ちは停止・質問に載っているスレッドと blocked の task を重ねない', () => {
  const s = store();
  s.open(notice({ threadId: 'T77' }), { now: T0 - minutes(10) });
  const out = formatInbox({
    notifies: s.openList(),
    recoveries: [recoveryRow(), recoveryRow({ task: { id: '9', title: 'x', state: 'blocked', threadId: 'T9' } })],
    now: T0,
  });
  assert.match(out, /停止・質問 \(1 件\)/);
  assert.ok(!/復旧待ち/.test(out), '同じスレッドの問題が 2 節に出ている');
});

test('復旧待ちだけでも空の 1 行にならず、長い順に並び、理由は 80 字で切る', () => {
  const out = formatInbox({
    recoveries: [
      recoveryRow({ task: { id: '1', title: 'a', state: 'review', threadId: 'A' }, status: { status: 'reconcile', reason: 'あ'.repeat(120), since: T0 - minutes(5), waitedMs: minutes(5), next: 'human', run: null } }),
      recoveryRow({ task: { id: '2', title: 'b', state: 'in-progress', threadId: 'B' }, status: { status: 'stopped', reason: '人間の /stop で中断 (opus)', since: T0 - hours(1), waitedMs: hours(1), next: 'human', run: null } }),
    ],
    now: T0,
  });
  assert.notEqual(out, EMPTY_INBOX);
  const lines = out.split('\n');
  const head = lines.indexOf('**復旧待ち (2 件)**');
  assert.match(lines[head + 1], /^・#2 1h0m 「b」 \(人間による停止: 人間の \/stop で中断 \(opus\) → 続けるなら `\/retry`\)/);
  assert.match(lines[head + 2], /^・#1 5m 「a」 \(要照合: あ{80}… → 子プロセスの残りを確かめて/);
});
