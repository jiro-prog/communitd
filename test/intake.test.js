import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTAKE_ACTION_KINDS,
  INTAKE_SCHEMA,
  MAX_INTAKE_ACTIONS,
  MAX_THREAD_TITLE_CHARS,
  THREAD_WINDOW_MS,
  agoLabel,
  allowsDirectTrigger,
  buildIntakePrompt,
  buildThreadTable,
  formatThreadRow,
  handoffBody,
  intakeReply,
  isIntakePost,
  planIntake,
  threadStateOf,
  validateIntakeOutput,
} from '../src/intake.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- 入口: 受付が受けるか ----

const post = (patch = {}) => ({
  intakeEnabled: true, isThread: false, senderKind: 'human', mentionedBotUserIds: [], intakeBotUserId: 'IB', ...patch,
});

test('isIntakePost: 受付が有効なチャンネル直下の人間の発言だけを受ける', () => {
  assert.equal(isIntakePost(post()), true);
  assert.equal(isIntakePost(post({ intakeEnabled: false })), false);
  // 書き損じ (true 以外) は受けない側へ倒す
  assert.equal(isIntakePost(post({ intakeEnabled: 'true' })), false);
  assert.equal(isIntakePost(post({ isThread: true })), false);
  // bot・メンテ用 bot・受付自身の中継は受けない (受付が受付を起こす輪を作らない)
  for (const senderKind of ['bot', 'maintenance', 'relay', null]) {
    assert.equal(isIntakePost(post({ senderKind })), false, senderKind);
  }
  // 受付 bot が分からない (ready 前) なら受けない
  assert.equal(isIntakePost(post({ intakeBotUserId: null })), false);
});

test('isIntakePost: 他の bot へのメンション付きはその bot へ直行、受付 bot への明示メンションは受ける', () => {
  assert.equal(isIntakePost(post({ mentionedBotUserIds: ['FB'] })), false);
  assert.equal(isIntakePost(post({ mentionedBotUserIds: ['IB', 'FB'] })), false);
  assert.equal(isIntakePost(post({ mentionedBotUserIds: ['IB'] })), true);
});

test('allowsDirectTrigger: 受付チャンネルの直下では明示メンションだけ (返信は受付が受ける)', () => {
  assert.equal(allowsDirectTrigger({ intakeEnabled: true, isThread: false, via: 'mention' }), true);
  assert.equal(allowsDirectTrigger({ intakeEnabled: true, isThread: false, via: 'reply' }), false);
  // スレッドの中と受付の無いチャンネルは今までどおり
  assert.equal(allowsDirectTrigger({ intakeEnabled: true, isThread: true, via: 'reply' }), true);
  assert.equal(allowsDirectTrigger({ intakeEnabled: false, isThread: false, via: 'reply' }), true);
});

test('allowsDirectTrigger: 受付の中継はチャンネル直下では何も起こさない (メンションが紛れても)', () => {
  for (const intakeEnabled of [true, false]) {
    assert.equal(allowsDirectTrigger({ intakeEnabled, isThread: false, via: 'mention', senderKind: 'relay' }), false);
  }
  // スレッドの中の専用の 1 通は通す (中継の起動経路はそれだけ)
  assert.equal(allowsDirectTrigger({ intakeEnabled: true, isThread: true, via: 'mention', senderKind: 'relay' }), true);
  // 人間の明示メンションは今までどおり
  assert.equal(allowsDirectTrigger({ intakeEnabled: true, isThread: false, via: 'mention', senderKind: 'human' }), true);
});

// ---- スレッドの状態 ----

test('threadStateOf: 走っている記録は作業中、要照合はそれと分ける', () => {
  assert.equal(threadStateOf({ stage: 'model' }), 'working');
  assert.equal(threadStateOf({ stage: 'queued' }), 'working');
  assert.equal(threadStateOf({ stage: 'reconcile' }), 'reconcile');
});

test('threadStateOf: 終わった記録は「次に誰の番か」で分ける', () => {
  assert.equal(threadStateOf({ stage: 'ended', next: 'human' }), 'human');
  assert.equal(threadStateOf({ stage: 'ended', next: 'bot' }), 'handoff');
  assert.equal(threadStateOf({ stage: 'ended', next: 'reviewer' }), 'review');
  assert.equal(threadStateOf({ stage: 'ended', next: 'recovery' }), 'recovery');
  assert.equal(threadStateOf({ stage: 'ended', next: 'none' }), 'human');
  assert.equal(threadStateOf({ stage: 'ended', next: 'unknown' }), 'unknown');
});

test('threadStateOf: 板のタスクの終端と blocked は記録より先に見る', () => {
  assert.equal(threadStateOf({ stage: 'model' }, { task: { state: 'merged' } }), 'done');
  assert.equal(threadStateOf({ stage: 'ended', next: 'bot' }, { task: { state: 'dropped' } }), 'done');
  assert.equal(threadStateOf({ stage: 'ended', next: 'recovery' }, { task: { state: 'blocked' } }), 'human');
  // 走っている job は blocked より優先 (いま動いている事実の方が新しい)
  assert.equal(threadStateOf({ stage: 'model' }, { task: { state: 'blocked' } }), 'working');
  // 記録の無い板のタスク
  assert.equal(threadStateOf(null, { task: { state: 'review' } }), 'review');
  assert.equal(threadStateOf(null, { task: { state: 'approved' } }), 'unknown');
});

// ---- スレッド表 ----

const run = (threadId, patch = {}) => ({
  id: `${threadId}-${patch.acceptedAt ?? 'r'}`,
  threadId,
  botKey: 'fable',
  stage: 'ended',
  next: 'human',
  acceptedAt: iso(2 * HOUR),
  endedAt: iso(HOUR),
  ...patch,
});

test('buildThreadTable: スレッドごとに最後に受け付けた記録で状態を出し、最後の動きが新しい順に並べる', () => {
  const { rows, omitted } = buildThreadTable({
    now: NOW,
    threads: [{ id: 'T1', name: 'ログイン直し', archived: false }, { id: 'T2', name: 'README', archived: true }],
    runs: [
      run('T1', { acceptedAt: iso(3 * HOUR), endedAt: iso(2 * HOUR), next: 'bot' }),
      run('T1', { acceptedAt: iso(30 * MIN), endedAt: null, stage: 'model', observedAt: iso(MIN), botKey: 'opus' }),
      run('T2', { acceptedAt: iso(5 * HOUR), endedAt: iso(4 * HOUR) }),
    ],
  });
  assert.equal(omitted, 0);
  assert.deepEqual(rows.map((r) => [r.threadId, r.state, r.botKey]), [['T1', 'working', 'opus'], ['T2', 'human', 'fable']]);
  assert.equal(rows[0].name, 'ログイン直し');
  assert.equal(rows[0].lastActiveAt, NOW - MIN);
  assert.equal(rows[1].archived, true);
});

test('buildThreadTable: 窓より古いスレッドは外すが、作業中と板の未完了は窓に関係なく載せる', () => {
  const old = THREAD_WINDOW_MS + DAY;
  const { rows } = buildThreadTable({
    now: NOW,
    runs: [
      run('OLD', { acceptedAt: iso(old + HOUR), endedAt: iso(old) }),
      run('LIVE', { acceptedAt: iso(old), endedAt: null, stage: 'model' }),
      run('TASK', { acceptedAt: iso(old + HOUR), endedAt: iso(old) }),
      run('DONE', { acceptedAt: iso(old + HOUR), endedAt: iso(old) }),
    ],
    tasks: [{ id: 87, threadId: 'TASK', state: 'review' }, { id: 88, threadId: 'DONE', state: 'merged' }],
  });
  assert.deepEqual(rows.map((r) => r.threadId).sort(), ['LIVE', 'TASK']);
  const task = rows.find((r) => r.threadId === 'TASK');
  assert.equal(task.taskId, 87);
  assert.equal(task.taskState, 'review');
});

test('buildThreadTable: 記録の無い板のタスクも載る / 名前とアーカイブが分からなければ null', () => {
  const { rows } = buildThreadTable({ now: NOW, tasks: [{ id: 9, threadId: 'T9', state: 'in-progress' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, null);
  assert.equal(rows[0].archived, null);
  assert.equal(rows[0].lastActiveAt, null);
  assert.equal(rows[0].botKey, null);
});

test('buildThreadTable: 行数の上限を超えた分は数だけ返す (古い方を落とす)', () => {
  const runs = [1, 2, 3, 4].map((n) => run(`T${n}`, { acceptedAt: iso(n * HOUR + MIN), endedAt: iso(n * HOUR) }));
  const { rows, omitted } = buildThreadTable({ now: NOW, runs, maxRows: 2 });
  assert.deepEqual(rows.map((r) => r.threadId), ['T1', 'T2']);
  assert.equal(omitted, 2);
});

test('buildThreadTable: 壊れた記録・ID の無いものは読み飛ばす', () => {
  const { rows } = buildThreadTable({ now: NOW, runs: [null, { threadId: '' }, run('T1')], tasks: [null, { id: 1 }] });
  assert.deepEqual(rows.map((r) => r.threadId), ['T1']);
});

test('agoLabel / formatThreadRow: 振り分けに要る項目が 1 行に並ぶ', () => {
  assert.equal(agoLabel(NOW - 5 * MIN, NOW), '5 分前');
  assert.equal(agoLabel(NOW - 3 * HOUR, NOW), '3 時間前');
  assert.equal(agoLabel(NOW - 3 * DAY, NOW), '3 日前');
  assert.equal(agoLabel(Number.NaN, NOW), '不明');
  const line = formatThreadRow({
    threadId: 'T1', name: 'ログイン直し', archived: true, botKey: 'opus', state: 'working',
    taskId: 87, taskState: 'in-progress', lastActiveAt: NOW - 5 * MIN,
  }, { now: NOW });
  assert.match(line, /^- T1 「ログイン直し」/);
  for (const part of ['担当: opus', '状態: 作業中', '5 分前', '板のタスク #87 (in-progress)', 'アーカイブ済み']) {
    assert.ok(line.includes(part), `${part} が無い: ${line}`);
  }
  assert.match(formatThreadRow({ threadId: 'T2', state: 'unknown' }, { now: NOW }), /「\(名前不明\)」.*担当: 不明/);
});

// ---- プロンプト ----

test('buildIntakePrompt: 投稿・直近の発言・スレッド表・担当の 4 節を出す', () => {
  const text = buildIntakePrompt({
    now: NOW,
    post: { authorName: 'そう', content: 'ログインが落ちる\nあと README の誤字', attachments: ['trace.txt'] },
    recent: [{ authorName: 'Intake', content: '前の返事', isBot: true }, { authorName: 'そう', content: 'x'.repeat(600) }],
    rows: [{ threadId: 'T1', name: 'ログイン直し', state: 'working', botKey: 'opus', lastActiveAt: NOW - MIN }],
    omitted: 3,
    assignees: [{ key: 'fable', displayName: 'Fable', role: 'manager (既定)' }, { key: 'opus' }],
  });
  for (const heading of ['# 受付する投稿', '# チャンネル直下の直近の発言', '# このチャンネルのスレッド', '# 回せる担当']) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.includes('ログインが落ちる\nあと README の誤字'));
  assert.ok(text.includes('添付: trace.txt'));
  assert.ok(text.includes('[Intake (bot)]: 前の返事'));
  // 長い発言は切る (表と投稿を押し出さない)
  assert.ok(text.includes('…(以下略)'));
  assert.ok(!text.includes('x'.repeat(600)));
  assert.ok(text.includes('- T1 「ログイン直し」'));
  assert.ok(text.includes('ほかに 3 本'));
  assert.ok(text.includes('- fable (Fable) — manager (既定)'));
  assert.ok(text.includes('- opus'));
});

test('buildIntakePrompt: 空の節は空だと書く (受付が「表を見落とした」と区別できるように)', () => {
  const text = buildIntakePrompt({ now: NOW, post: { authorName: 'そう', content: '質問' } });
  assert.ok(text.includes('(なし — 回せる既存のスレッドは無い)'));
  assert.ok(text.includes('(なし — スレッドへは回せない。その場で答える)'));
  assert.ok(!text.includes('添付:'));
});

// ---- 出力の様式 ----

test('INTAKE_SCHEMA: キーは ASCII、行動の種類は INTAKE_ACTION_KINDS と同じ', () => {
  const keys = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      keys.push(k);
      walk(v);
    }
    walk(node.items);
  };
  walk(INTAKE_SCHEMA);
  assert.ok(keys.length > 0);
  for (const k of keys) assert.match(k, /^[a-z_]+$/, k);
  assert.deepEqual(INTAKE_SCHEMA.properties.actions.items.properties.kind.enum, [...INTAKE_ACTION_KINDS]);
  assert.equal(INTAKE_SCHEMA.properties.actions.maxItems, MAX_INTAKE_ACTIONS);
  assert.deepEqual(INTAKE_SCHEMA.required, ['body', 'actions']);
});

test('validateIntakeOutput: 外形だけを見る (行動 1 件の書き損じで本文まで捨てない)', () => {
  assert.deepEqual(validateIntakeOutput({ body: ' 答え ', actions: [] }), { ok: true, value: { body: '答え', actions: [] } });
  assert.deepEqual(validateIntakeOutput({ body: '答え' }).value.actions, []);
  const broken = validateIntakeOutput({ body: 'x', actions: [{ kind: 'nope' }] });
  assert.equal(broken.ok, true);
  assert.equal(validateIntakeOutput(null).ok, false);
  assert.equal(validateIntakeOutput([]).ok, false);
  assert.equal(validateIntakeOutput({ body: '  ', actions: [] }).ok, false);
  assert.equal(validateIntakeOutput({ body: 'x', actions: {} }).ok, false);
});

// ---- 実行計画 ----

const ROWS = [
  { threadId: 'T1', archived: false },
  { threadId: 'T2', archived: true },
];
const KEYS = ['fable', 'opus'];
const plan = (actions, opts = {}) => planIntake({ output: { body: '本文', actions }, rows: ROWS, assigneeKeys: KEYS, ...opts });

test('planIntake: 新規と中継を実行計画にする (題は 1 行に潰して丸める)', () => {
  const result = plan([
    { kind: 'new_thread', title: 'ログイン\n落ちる', assignee: 'fable', brief: ' 直して ' },
    { kind: 'route', thread_id: 'T1', assignee: 'opus', brief: '続き' },
    { kind: 'new_thread', title: 'あ'.repeat(200), assignee: 'fable', brief: 'b' },
  ]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.actions[0], { kind: 'new_thread', title: 'ログイン 落ちる', assignee: 'fable', brief: '直して' });
  assert.deepEqual(result.actions[1], { kind: 'route', threadId: 'T1', assignee: 'opus', brief: '続き', unarchive: false });
  assert.equal(result.actions[2].title.length, MAX_THREAD_TITLE_CHARS);
  assert.equal(result.body, '本文');
});

test('planIntake: アーカイブ済みのスレッドへの中継には unarchive を付ける', () => {
  assert.equal(plan([{ kind: 'route', thread_id: 'T2', assignee: 'fable', brief: 'b' }]).actions[0].unarchive, true);
});

test('planIntake: 実行してはいけないものは理由つきで落とし、残りは実行する', () => {
  const result = plan([
    { kind: 'route', thread_id: 'T404', assignee: 'fable', brief: 'b' }, // 表に無い
    { kind: 'route', thread_id: 'T1', assignee: 'sol', brief: 'b' }, // 呼べない担当
    { kind: 'new_thread', title: '  ', assignee: 'fable', brief: 'b' }, // 題が空
    { kind: 'new_thread', title: 't', assignee: 'fable', brief: ' ' }, // 依頼文が空
    { kind: 'delete', assignee: 'fable', brief: 'b' }, // 知らない行動
    'route', // 形が読めない
    { kind: 'route', thread_id: 'T1', assignee: 'fable', brief: '1 通目' },
    { kind: 'route', thread_id: 'T1', assignee: 'opus', brief: '2 通目' }, // 同じスレッドへ 2 回
  ]);
  assert.deepEqual(result.actions.map((a) => a.brief), ['1 通目']);
  assert.deepEqual(result.rejected.map((r) => r.index), [0, 1, 2, 3, 4, 5, 7]);
  assert.match(result.rejected[0].reason, /表に無いスレッド/);
  assert.match(result.rejected[1].reason, /呼べない担当/);
  assert.match(result.rejected[6].reason, /2 回/);
});

test('planIntake: 上限を超えた分は落とす', () => {
  const many = Array.from({ length: MAX_INTAKE_ACTIONS + 2 }, (_, i) => ({
    kind: 'new_thread', title: `t${i}`, assignee: 'fable', brief: 'b',
  }));
  const result = plan(many);
  assert.equal(result.actions.length, MAX_INTAKE_ACTIONS);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /まで/);
});

test('planIntake: 担当が 1 人も居なければ何も起こさない (その場で答えるだけ)', () => {
  const result = plan([{ kind: 'new_thread', title: 't', assignee: 'fable', brief: 'b' }], { assigneeKeys: [] });
  assert.equal(result.actions.length, 0);
  assert.equal(result.rejected.length, 1);
});

// ---- 投稿の文面 ----

test('handoffBody: 起点から立てたスレッドには引用を付けず、それ以外は元の投稿を引用する', () => {
  const plain = handoffBody({ brief: '直して' });
  assert.equal(plain, '📥 受付からの依頼\n直して');
  assert.ok(!plain.includes('<@'), 'メンションは載せない (起動は専用の 1 通)');
  const quoted = handoffBody({
    brief: '続き', original: { authorName: 'そう', content: '1 行目\n2 行目', url: 'https://discord.com/x' },
  });
  assert.ok(quoted.includes('元の投稿 — そう (https://discord.com/x):'));
  assert.ok(quoted.includes('> 1 行目\n> 2 行目'));
});

test('handoffBody / intakeReply: 受付の文字列と引用の生メンションは潰す (中継は人間の重みで通るため)', () => {
  const body = handoffBody({
    brief: '<@123456789> に頼む @everyone',
    original: { authorName: 'そう', content: '<@!987654321> と <@&555555555> へ' },
  });
  for (const raw of ['<@123456789>', '<@!987654321>', '<@&555555555>', '@everyone']) {
    assert.ok(!body.includes(raw), `${raw} が残っている: ${body}`);
  }
  assert.ok(body.includes('[mention:123456789]'));
  const reply = intakeReply({
    body: '<@123456789> よろしく',
    done: [{ kind: 'route', threadId: 'T1', assignee: 'opus', error: '<@123456789> 失敗' }],
    rejected: [{ index: 0, reason: '表に無いスレッド: "<@123456789>"' }],
  });
  assert.ok(!reply.includes('<@123456789>'), reply);
  // 行き先のチャンネルリンク (<#id>) は潰さない
  assert.ok(reply.includes('<#T1>'));
});

test('intakeReply: 本文のあとに行き先のリンクと、実行しなかった理由を並べる', () => {
  const text = intakeReply({
    body: '2 件に分けました',
    done: [
      { kind: 'new_thread', threadId: 'T9', assignee: 'fable' },
      { kind: 'route', threadId: 'T1', assignee: 'opus' },
      { kind: 'new_thread', threadId: null, assignee: 'fable', error: 'スレッドを作れない' },
    ],
    rejected: [{ index: 3, reason: '表に無いスレッド: "T404"' }],
  });
  assert.ok(text.startsWith('2 件に分けました\n\n'));
  assert.ok(text.includes('→ 新規 <#T9> (fable)'));
  assert.ok(text.includes('→ 中継 <#T1> (opus)'));
  assert.ok(text.includes('⚠️ 新規 (スレッドを立てられなかった) → fable: スレッドを作れない'));
  assert.ok(text.includes('⚠️ 実行しなかった (4 件目): 表に無いスレッド'));
  assert.equal(intakeReply({ body: '答え' }), '答え');
});
