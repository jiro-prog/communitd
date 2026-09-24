import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOUT_MAX_OPEN_TASKS } from '../src/config.js';
import {
  DEFAULT_JOB_BUDGET,
  MERGED_WINDOW_MS,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  TaskBoardStore,
  canSpendJob,
  canTransition,
  planFiling,
  planTouchMigration,
  remainingJobs,
  scoutBoardView,
  sendBackCount,
  tasksMissingTouch,
  touchOverlaps,
} from '../src/board.js';

function tempFile(name = 'tasks.json') {
  return join(mkdtempSync(join(tmpdir(), 'communitd-board-')), name);
}

const board = () => new TaskBoardStore(tempFile());

/** 時刻は全部注入する (テストが実時計に依存しないように) */
const T0 = Date.parse('2026-08-27T00:00:00.000Z');
const at = (minutes) => T0 + minutes * 60_000;
const iso = (minutes) => new Date(at(minutes)).toISOString();

function seed(store, over = {}, options = { now: T0 }) {
  return store.propose({
    channel: 'observatory',
    title: 'タスク一覧に状態バッジを足す',
    rationale: '状態が色で分かると社会の様子が一目で読める',
    touch: ['src/render/table.ts'],
    ...over,
  }, options);
}

// ---- 遷移表 ----

test('canTransition は遷移表そのもの', () => {
  assert.equal(canTransition('proposed', 'approved'), true);
  assert.equal(canTransition('approved', 'in-progress'), true);
  assert.equal(canTransition('in-progress', 'review'), true);
  assert.equal(canTransition('review', 'merged'), true);

  // 差し戻し (裁定 2026-08-28)。M0-1 では「終端まで一方通行」だったが、
  // レビューが通らなかったときに同じスレッドの続きとして直させる辺を足した
  assert.equal(canTransition('review', 'in-progress'), true);

  assert.equal(canTransition('proposed', 'merged'), false);
  assert.equal(canTransition('proposed', 'in-progress'), false);
  assert.equal(canTransition('approved', 'review'), false);
  assert.equal(canTransition('in-progress', 'merged'), false);
  assert.equal(canTransition('merged', 'review'), false);
  assert.equal(canTransition('知らない状態', 'approved'), false);
  assert.equal(canTransition('proposed', '知らない状態'), false);
});

test('遷移表の行と行き先はすべて既知の状態で、終端からは出口が無い', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...TASK_STATES].sort());
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(TASK_STATES.includes(to), `未知の行き先: ${from} → ${to}`);
    }
  }
  for (const state of TERMINAL_STATES) {
    assert.deepEqual([...TRANSITIONS[state]], [], `${state} から出る辺がある`);
  }
});

// ---- 起票 ----

test('起票するとスキーマどおりのタスクが 1 件できる', () => {
  const store = board();
  const task = seed(store);

  assert.deepEqual(Object.keys(task).sort(), [
    'branch', 'channel', 'createdAt', 'history', 'id', 'jobBudget',
    'jobsSpent', 'rationale', 'state', 'threadId', 'title', 'touch', 'updatedAt',
  ]);
  assert.equal(task.id, '1');
  assert.deepEqual(task.touch, ['src/render/table.ts']);
  assert.equal(task.state, 'proposed');
  assert.equal(task.channel, 'observatory');
  assert.equal(task.threadId, null);
  assert.equal(task.branch, null);
  assert.equal(task.jobsSpent, 0);
  assert.equal(task.jobBudget, DEFAULT_JOB_BUDGET);
  assert.equal(task.createdAt, iso(0));
  assert.equal(task.updatedAt, iso(0));
  assert.deepEqual(task.history, [{ at: iso(0), from: null, to: 'proposed' }]);
});

test('id はボード内で一意 — 読み直しても採番が戻らない', () => {
  const path = tempFile();
  const first = new TaskBoardStore(path);
  assert.equal(seed(first, { title: 'A' }).id, '1');
  assert.equal(seed(first, { title: 'B' }).id, '2');

  const reopened = new TaskBoardStore(path);
  assert.equal(seed(reopened, { title: 'C' }).id, '3');
  assert.deepEqual(reopened.list().map((t) => t.title), ['A', 'B', 'C']);
});

test('起票は空の channel / title と壊れた jobBudget を断る', () => {
  const store = board();
  const ok = { channel: 'c', title: 'x', touch: ['src/a.ts'] };
  assert.throws(() => store.propose({ ...ok, channel: '' }), /channel/);
  assert.throws(() => store.propose({ ...ok, title: '   ' }), /title/);
  assert.throws(() => store.propose({ ...ok, jobBudget: 0 }), /jobBudget/);
  assert.throws(() => store.propose({ ...ok, jobBudget: 1.5 }), /jobBudget/);
  assert.deepEqual(store.list(), []);
});

// ---- touch ----

test('起票は touch を必須にする — 無い / 空 / 壊れたパスは断って何も書かない', () => {
  const store = board();
  const ok = { channel: 'c', title: 'x' };
  assert.throws(() => store.propose(ok), /touch は必須/);
  assert.throws(() => store.propose({ ...ok, touch: [] }), /touch は必須/);
  assert.throws(() => store.propose({ ...ok, touch: 'src/a.ts' }), /touch は必須/);
  // リポジトリ相対・POSIX 区切りだけ (isSafeRepoPath と同じ正規形)
  assert.throws(() => store.propose({ ...ok, touch: ['/etc/passwd'] }), /使えないパス/);
  assert.throws(() => store.propose({ ...ok, touch: ['../外.ts'] }), /使えないパス/);
  assert.throws(() => store.propose({ ...ok, touch: ['src\\a.ts'] }), /使えないパス/);
  assert.throws(() => store.propose({ ...ok, touch: ['./src/a.ts'] }), /使えないパス/);
  assert.throws(() => store.propose({ ...ok, touch: [''] }), /使えないパス/);
  assert.throws(() => store.propose({ ...ok, touch: [42] }), /使えないパス/);
  // 大小文字だけが違うパスは Windows では同じ実体
  assert.throws(() => store.propose({ ...ok, touch: ['src/a.ts', 'SRC/A.TS'] }), /重複/);
  assert.deepEqual(store.list(), []);
});

test('touch の前後の空白は落として保存する (書き損じで一致しないキーを作らない)', () => {
  const store = board();
  const task = seed(store, { touch: ['  src/a.ts  ', 'src/b.ts'] });
  assert.deepEqual(task.touch, ['src/a.ts', 'src/b.ts']);
});

test('start に touch を渡すと差し替わり、履歴に残る (省略なら据え置き)', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });

  const started = store.start(task.id, {
    threadId: 777, touch: ['src/render/table.ts', 'src/style.css'], now: at(2), by: 'opus',
  });
  assert.deepEqual(started.touch, ['src/render/table.ts', 'src/style.css']);
  assert.deepEqual(started.history.at(-1), {
    at: iso(2), from: 'approved', to: 'in-progress', by: 'opus',
    touch: ['src/render/table.ts', 'src/style.css'],
  });

  // 差し戻して着手し直しても、渡さなければ据え置き (履歴にも載らない)
  store.submitForReview(task.id, { now: at(3) });
  const back = store.sendBack(task.id, { now: at(4), reason: '直して' });
  assert.deepEqual(back.touch, ['src/render/table.ts', 'src/style.css']);
  assert.equal(Object.hasOwn(back.history.at(-1), 'touch'), false);

  // 壊れた touch は遷移ごと拒否する (状態も touch も動かない)
  assert.throws(() => store.start(task.id, { touch: [] }), /touch は必須/);
  assert.equal(store.get(task.id).state, 'in-progress');
});

test('touchOverlaps は重なったパスを返す (大小文字だけの違いも同じ実体として扱う)', () => {
  assert.equal(touchOverlaps(['tools/a.py', 'doc/b.md'], ['doc/b.md']), 'doc/b.md');
  // 返すのは呼び出し側 (a) の表記 — 理由文に書くのは今回の起票が宣言したパス
  assert.equal(touchOverlaps(['tools/A.py'], ['tools/a.py']), 'tools/A.py');
  assert.equal(touchOverlaps(['tools/a.py'], ['tools/b.py']), null);
  // 重なりが無い / 宣言が無いときは null (真偽値で分岐しても倒れない)
  assert.equal(touchOverlaps([], ['tools/a.py']), null);
  assert.equal(touchOverlaps(['tools/a.py'], []), null);
  assert.equal(touchOverlaps(null, undefined), null);
  assert.equal(touchOverlaps(['tools/a.py'], [42, null, 'tools/a.py']), 'tools/a.py');
});

// ---- 起票の制動 (重なり + 枠) ----

/** planFiling / scoutBoardView が見るのは id と state と touch だけ */
const onBoard = (id, state, touch) => ({ id, state, title: `#${id}`, touch });
/** スカウトの起票 (proposedTasks — src/scheduler.js の戻りと同じ形) */
const wanted = (title, touch) => ({
  channel: 'kumamikan-tools', title, rationale: 'r', jobBudget: 4, touch,
});

test('planFiling: 既にあるタスクと touch が重なる起票は載せない (#46 の再発防止)', () => {
  const plan = planFiling({
    wanted: [wanted('new_ticket に pytest', ['tools/new_ticket.py', 'doc/x.md'])],
    // #45 は review — 「着手前」だけを見ていたころは見えなかった状態
    openTasks: [onBoard('45', 'review', ['tools/new_ticket.py'])],
    maxOpenTasks: 3,
  });
  assert.deepEqual(plan.file, []);
  assert.deepEqual(plan.deferred, []);
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /#45/, '相手の id が分からないと避けようがない');
  assert.match(plan.rejected[0].reason, /tools\/new_ticket\.py/);

  // 終端は競合の相手にしない (merged になった後なら続き物を積める)
  const after = planFiling({
    wanted: [wanted('new_ticket に pytest', ['tools/new_ticket.py'])],
    openTasks: [onBoard('45', 'merged', ['tools/new_ticket.py'])],
    maxOpenTasks: 3,
  });
  assert.deepEqual(after.file.map((t) => t.title), ['new_ticket に pytest']);
});

test('planFiling: 大小文字だけが違うパスも重なりとして断る (fail-closed)', () => {
  const plan = planFiling({
    wanted: [wanted('A', ['tools/A.py'])],
    openTasks: [onBoard('40', 'in-progress', ['tools/a.py'])],
    maxOpenTasks: 3,
  });
  assert.deepEqual(plan.file, []);
  assert.match(plan.rejected[0].reason, /#40/);
});

test('planFiling: 同じ巡回の中でも、先に載せたものと重なれば断る', () => {
  const plan = planFiling({
    wanted: [wanted('A', ['tools/a.py']), wanted('B', ['doc/b.md', 'tools/a.py'])],
    openTasks: [],
    maxOpenTasks: 3,
  });
  assert.deepEqual(plan.file.map((t) => t.title), ['A']);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].task.title, 'B');
  assert.match(plan.rejected[0].reason, /同じ巡回/);
  assert.match(plan.rejected[0].reason, /tools\/a\.py/);
});

test('planFiling: 枠 (maxOpenTasks − open) を超えた分は見送る — 着手済みは open に数えない', () => {
  const plan = planFiling({
    wanted: [wanted('A', ['tools/a.py']), wanted('B', ['tools/b.py']), wanted('C', ['tools/c.py'])],
    openTasks: [
      onBoard('40', 'proposed', ['tools/x.py']),
      onBoard('41', 'approved', ['tools/y.py']),
      // ここから下は open ではない (planTick の scout 判定と同じ定義)
      onBoard('42', 'in-progress', ['tools/z.py']),
      onBoard('43', 'review', ['tools/w.py']),
      onBoard('44', 'blocked', ['tools/v.py']),
    ],
    maxOpenTasks: 3,
  });
  assert.deepEqual(plan.file.map((t) => t.title), ['A']);
  assert.deepEqual(plan.deferred.map((t) => t.title), ['B', 'C']);
  assert.deepEqual(plan.rejected, []);

  // 枠が埋まっていれば 1 件も載らない (ボードには触らないので次の巡回で再起票できる)
  const full = planFiling({
    wanted: [wanted('A', ['tools/a.py'])],
    openTasks: [
      onBoard('40', 'proposed', ['tools/x.py']),
      onBoard('41', 'approved', ['tools/y.py']),
      onBoard('42', 'approved', ['tools/z.py']),
    ],
    maxOpenTasks: 3,
  });
  assert.deepEqual(full.file, []);
  assert.deepEqual(full.deferred.map((t) => t.title), ['A']);
});

test('planFiling: 重なりで断ったものは枠を消費しない', () => {
  const plan = planFiling({
    wanted: [wanted('重なりあり', ['tools/x.py']), wanted('重なりなし', ['tools/new.py'])],
    openTasks: [
      onBoard('40', 'proposed', ['tools/x.py']),
      onBoard('41', 'approved', ['tools/y.py']),
    ],
    maxOpenTasks: 3, // 枠は 1
  });
  assert.deepEqual(plan.file.map((t) => t.title), ['重なりなし']);
  assert.deepEqual(plan.rejected.map((r) => r.task.title), ['重なりあり']);
  assert.deepEqual(plan.deferred, []);
});

test('planFiling: touch 不明の非終端タスクが 1 件でもあれば全件断る (fail-closed)', () => {
  // touch が読めない相手は「何とでも競合する」— 重なりが無いことを確かめられない
  // (発議側の taskConflicts と同じ扱い。normalizeTouch の注記が書いている不変条件)
  for (const broken of [null, [], 'src/a.ts', undefined]) {
    const plan = planFiling({
      wanted: [wanted('A', ['tools/a.py']), wanted('B', ['tools/b.py'])],
      openTasks: [
        onBoard('40', 'proposed', broken),
        onBoard('41', 'approved', ['tools/y.py']),
      ],
      maxOpenTasks: 6, // 枠は余っている
    });
    const label = JSON.stringify(broken);
    assert.deepEqual(plan.file, [], `touch=${label} で起票が通っている`);
    assert.deepEqual(plan.deferred, [], `touch=${label} で見送りに回っている`);
    assert.deepEqual(plan.rejected.map((r) => r.task.title), ['A', 'B'], label);
    for (const { reason } of plan.rejected) {
      assert.match(reason, /#40/, 'どのタスクが不明なのか分からない');
      assert.match(reason, /touch が不明/);
      assert.match(reason, /migrate-task-touch/, '直し方が書かれていない');
    }
  }

  // 終端 (merged / dropped) の touch 不明は対象外 — 競合の相手ではないため
  for (const state of ['merged', 'dropped']) {
    const plan = planFiling({
      wanted: [wanted('A', ['tools/a.py'])],
      openTasks: [onBoard('40', state, null)],
      maxOpenTasks: 6,
    });
    assert.deepEqual(plan.file.map((t) => t.title), ['A'], state);
    assert.deepEqual(plan.rejected, [], state);
  }
});

test('planFiling: 壊れた入力でも落ちない (枠が読めなければ設定の既定と同じ数)', () => {
  assert.deepEqual(planFiling(), { file: [], rejected: [], deferred: [] });
  assert.deepEqual(planFiling({ wanted: null, openTasks: null }).file, []);
  // touch の読めない非終端 (#40) が混ざっているので載せない (fail-closed)
  const plan = planFiling({
    wanted: [null, 'x', wanted('A', ['tools/a.py'])],
    openTasks: [null, { id: '9' }, onBoard('40', 'proposed', null)],
  });
  assert.deepEqual(plan.file, []);
  assert.deepEqual(plan.rejected.map((r) => r.task.title), ['A']);
  assert.match(plan.rejected[0].reason, /#40/);

  // null や {id:'9'} のように state の読めない値は比較対象ですらない (不明とも数えない)
  assert.deepEqual(
    planFiling({
      wanted: [wanted('A', ['tools/a.py'])],
      openTasks: [null, { id: '9' }, 'x'],
    }).file.map((t) => t.title),
    ['A'],
  );
  // 既定は config.js を読まずに持っている (config.js がこのモジュールを読むので循環する)
  const many = Array.from(
    { length: DEFAULT_SCOUT_MAX_OPEN_TASKS + 3 },
    (_, i) => wanted(`T${i}`, [`tools/${i}.py`]),
  );
  assert.equal(planFiling({ wanted: many, openTasks: [] }).file.length, DEFAULT_SCOUT_MAX_OPEN_TASKS);
});

// ---- スカウトへ見せるボード ----

test('scoutBoardView: 非終端すべてと直近 48 時間の merged を渡す', () => {
  const hoursBack = (hours) => new Date(at(-hours * 60)).toISOString();
  const landed = (id, hoursAgo) => ({
    id,
    state: 'merged',
    title: `m${id}`,
    updatedAt: hoursBack(hoursAgo),
    history: [
      { at: hoursBack(hoursAgo + 5), from: null, to: 'proposed' },
      { at: hoursBack(hoursAgo), from: 'review', to: 'merged' },
    ],
  });
  const tasks = [
    onBoard('1', 'proposed', ['tools/a.py']),
    onBoard('2', 'approved', ['tools/b.py']),
    onBoard('3', 'in-progress', ['tools/c.py']),
    onBoard('4', 'review', ['tools/d.py']),
    onBoard('5', 'blocked', ['tools/e.py']),
    landed('6', 47),
    landed('7', 49), // 窓の外
    { id: '8', state: 'dropped', title: 'd8', updatedAt: hoursBack(1) },
    null, // 壊れた値が混ざっても落ちない
  ];
  // 非終端が先・直近の merged が後 (一覧が長すぎるときは末尾から削られる)
  assert.deepEqual(
    scoutBoardView(tasks, { now: at(0) }).map((t) => t.id),
    ['1', '2', '3', '4', '5', '6'],
  );

  // 窓は差し替えられる (既定は 48 時間)
  assert.equal(MERGED_WINDOW_MS, 48 * 60 * 60 * 1000);
  assert.deepEqual(
    scoutBoardView(tasks, { now: at(0), mergedWindowMs: 50 * 60 * 60 * 1000 }).map((t) => t.id),
    ['1', '2', '3', '4', '5', '6', '7'],
  );
  assert.deepEqual(scoutBoardView(null, { now: at(0) }), []);
});

test('scoutBoardView: merged の時刻は履歴の to:merged 行で見る (読めなければ載せない)', () => {
  const base = { id: '9', state: 'merged', title: 'm9' };
  const hoursBack = (hours) => new Date(at(-hours * 60)).toISOString();
  const shown = (task) => scoutBoardView([task], { now: at(0) }).length;

  // 見るのは履歴だけ — 終端に入った後で updatedAt が動いても窓はずれない
  assert.equal(shown({
    ...base, updatedAt: hoursBack(0), history: [{ at: hoursBack(72), from: 'review', to: 'merged' }],
  }), 0);
  assert.equal(shown({
    ...base, updatedAt: hoursBack(72), history: [{ at: hoursBack(1), from: 'review', to: 'merged' }],
  }), 1);
  // updatedAt へは落とさない (「最後に触られた時刻」は着地の時刻ではない)
  assert.equal(shown({ ...base, updatedAt: hoursBack(1), history: [] }), 0);
  assert.equal(shown({ ...base, updatedAt: hoursBack(1) }), 0);
  // 読めない時刻は「直近」と言い切れないので載せない
  assert.equal(shown({ ...base, history: [{ at: 'いつか', from: 'review', to: 'merged' }] }), 0);
  assert.equal(shown(base), 0);
});

test('scoutBoardView: now より未来に着地した merged は載せない', () => {
  // startScout はスレッド作成を待つ間に merge が着地しうる。tick の now を渡すと
  // その 1 件が「未来」になり、窓を過ぎても一覧から消えなくなる
  const future = {
    id: '9',
    state: 'merged',
    title: 'm9',
    history: [{ at: new Date(at(60)).toISOString(), from: 'review', to: 'merged' }],
  };
  assert.deepEqual(scoutBoardView([future], { now: at(0) }), []);
  assert.deepEqual(scoutBoardView([future], { now: at(60) }).map((t) => t.id), ['9']);
});

test('tasksMissingTouch は移行が要るタスクだけを拾う (終端は数えない)', () => {
  const tasks = [
    { id: '1', state: 'approved', touch: ['src/a.ts'] },
    { id: '2', state: 'approved' }, // 宣言なし
    { id: '3', state: 'in-progress', touch: [] }, // 空配列も宣言なし
    { id: '4', state: 'blocked', touch: null },
    { id: '5', state: 'merged' }, // 終端は競合判定の材料ではない
    { id: '6', state: 'dropped' },
    null, // 壊れた値が混ざっても落ちない
    { id: '7' },
  ];
  assert.deepEqual(tasksMissingTouch(tasks).map((t) => t.id), ['2', '3', '4']);
  assert.deepEqual(tasksMissingTouch([]), []);
  assert.deepEqual(tasksMissingTouch(null), []);
});

test('planTouchMigration は書く前に全件検証する (途中まで移行された盤面を作らない)', () => {
  const tasks = [
    { id: '9', state: 'blocked', title: 'A' },
    { id: '31', state: 'review', title: 'B' },
    { id: '33', state: 'approved', title: 'C', touch: ['src/x.ts'] },
    { id: '40', state: 'merged', title: 'D' },
  ];

  const ok = planTouchMigration(tasks, [['9', ['  src/a.ts ']], ['31', ['src/b.ts']]]);
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.plan, [
    { id: '9', title: 'A', touch: ['src/a.ts'] },
    { id: '31', title: 'B', touch: ['src/b.ts'] },
  ]);

  // **2 件目のパスが不正なら計画ごと落ちる** (1 件目だけ書かれる状態を作らない)
  const bad = planTouchMigration(tasks, [['9', ['src/a.ts']], ['31', ['../外.ts']]]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /タスク 31: .*使えないパス/);
  assert.equal(planTouchMigration(tasks, [['9', []]]).reason.includes('touch は必須'), true);

  // 対象外・不在・重複指定も書く前に落とす
  assert.match(planTouchMigration(tasks, [['33', ['src/y.ts']]]).reason, /移行の対象ではありません/);
  assert.match(planTouchMigration(tasks, [['40', ['src/y.ts']]]).reason, /移行の対象ではありません/);
  assert.match(planTouchMigration(tasks, [['99', ['src/y.ts']]]).reason, /ボードにありません/);
  assert.match(
    planTouchMigration(tasks, [['9', ['src/a.ts']], ['9', ['src/b.ts']]]).reason,
    /二度指定されています/,
  );
  assert.deepEqual(planTouchMigration(tasks, []), { ok: true, plan: [] });
  assert.deepEqual(planTouchMigration(), { ok: true, plan: [] });
});

test('setTouch は touch を持たない終端でないタスクだけに入る (移行専用)', () => {
  const path = tempFile();
  const store = new TaskBoardStore(path);
  const task = seed(store);

  // 既に持っているタスクは断る (走っている最中に範囲を広げる口にしない)
  assert.throws(() => store.setTouch(task.id, ['src/other.ts']), /既に touch があります/);

  // touch を持たない古い形のタスク (移行前のボード) を直接置く
  store.write('9', {
    ...task, id: '9', state: 'blocked', touch: undefined, history: [],
  });
  const migrated = store.setTouch('9', ['src/dropped.ts', ' src/main.ts '], { now: at(5) });
  assert.deepEqual(migrated.touch, ['src/dropped.ts', 'src/main.ts']);
  assert.equal(migrated.state, 'blocked'); // 状態は動かさない
  assert.deepEqual(migrated.history, []); // 履歴も積まない (遷移ではない)
  assert.equal(migrated.updatedAt, iso(5));
  assert.deepEqual(new TaskBoardStore(path).get('9').touch, ['src/dropped.ts', 'src/main.ts']);

  // 終端のタスクは対象外 (閉じた記録を書き換える理由が無い)
  store.write('10', { ...task, id: '10', state: 'merged', touch: undefined });
  assert.throws(() => store.setTouch('10', ['src/a.ts']), /移行の対象ではありません/);
  assert.throws(() => store.setTouch('99', ['src/a.ts']), /ボードにありません/);
});

// ---- 幹の遷移 ----

test('起票 → 承認 → 着手 → レビュー提出 → 完了まで通る (履歴が積まれる)', () => {
  const store = board();
  const task = seed(store);

  store.approve(task.id, { by: 'fable', now: at(1) });
  const started = store.start(task.id, { threadId: 777, by: 'opus', now: at(2) });
  assert.equal(started.state, 'in-progress');
  assert.equal(started.threadId, '777');
  assert.equal(started.branch, 'task/1', 'branch 省略時は task/<id>');

  store.submitForReview(task.id, { by: 'opus', now: at(3) });
  const merged = store.complete(task.id, { by: 'fable', note: 'merge --no-ff', now: at(4) });

  assert.equal(merged.state, 'merged');
  assert.equal(merged.createdAt, iso(0), 'createdAt は動かない');
  assert.equal(merged.updatedAt, iso(4));
  assert.deepEqual(merged.history.map((h) => h.to), [
    'proposed', 'approved', 'in-progress', 'review', 'merged',
  ]);
  assert.deepEqual(merged.history.at(-1), {
    at: iso(4), from: 'review', to: 'merged', by: 'fable', note: 'merge --no-ff',
  });
});

test('branch は明示すればそちらが残る', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  const started = store.start(task.id, { threadId: '1', branch: 'task/1-badge', now: at(2) });
  assert.equal(started.branch, 'task/1-badge');
});

// ---- 不正遷移 ----

test('遷移表に無い遷移は拒否する (proposed から直接 merged にできない)', () => {
  const store = board();
  const task = seed(store);

  assert.throws(() => store.complete(task.id), /proposed から merged へ進めません/);
  assert.throws(() => store.start(task.id, { threadId: '1' }), /proposed から in-progress へ進めません/);
  assert.throws(() => store.submitForReview(task.id), /proposed から review へ進めません/);

  const after = store.get(task.id);
  assert.equal(after.state, 'proposed', '拒否した遷移で状態が動いてはいけない');
  assert.equal(after.history.length, 1, '拒否した遷移は履歴にも残さない');
  assert.equal(after.updatedAt, iso(0));
});

test('承認済みからレビュー提出はできない (実装を飛ばせない)', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  assert.throws(() => store.submitForReview(task.id), /approved から review へ進めません/);
  assert.throws(() => store.approve(task.id), /approved から approved へ進めません/);
  assert.equal(store.get(task.id).state, 'approved');
});

test('終端状態からはどこへも進めない', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  store.drop(task.id, { reason: '既存タスクと重複していた', by: 'fable', now: at(2) });

  const dropped = store.get(task.id);
  assert.equal(dropped.state, 'dropped');
  assert.equal(dropped.history.at(-1).note, '既存タスクと重複していた');

  assert.throws(() => store.approve(task.id), /dropped から/);
  assert.throws(() => store.start(task.id, { threadId: '1' }), /dropped から/);
  assert.throws(() => store.submitForReview(task.id), /dropped から/);
  assert.throws(() => store.complete(task.id), /dropped から/);
  assert.throws(() => store.block(task.id), /dropped から/);
  assert.throws(() => store.drop(task.id), /dropped から/);
});

test('封鎖は作業中のどの段からもできて、理由が履歴に残る', () => {
  for (const [minutes, advance] of [[1, ['approve']], [2, ['approve', 'start']], [3, ['approve', 'start', 'submitForReview']]]) {
    const store = board();
    const task = seed(store);
    for (const [i, step] of advance.entries()) {
      if (step === 'start') store.start(task.id, { threadId: '9', now: at(i + 1) });
      else store[step](task.id, { now: at(i + 1) });
    }
    const blocked = store.block(task.id, { reason: 'job 予算切れ', now: at(minutes + 1) });
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.history.at(-1).note, 'job 予算切れ');
    assert.equal(blocked.updatedAt, iso(minutes + 1));
  }
});

test('知らない状態への遷移も、無い id への操作も落とす', () => {
  const store = board();
  const task = seed(store);
  assert.throws(() => store.transition(task.id, '知らない状態'), /進めません/);
  assert.throws(() => store.approve('999'), /タスク 999 がボードにありません/);
  assert.equal(store.get('999'), null);
});

// ---- 一覧・スレッド対応 ----

test('list は channel と state で絞れて id 昇順', () => {
  const store = board();
  const a = seed(store, { channel: 'observatory', title: 'A' });
  seed(store, { channel: 'observatory', title: 'B' });
  seed(store, { channel: 'yobidashi-dev', title: 'C' });
  store.approve(a.id, { now: at(1) });

  assert.deepEqual(store.list().map((t) => t.id), ['1', '2', '3']);
  assert.deepEqual(store.list({ channel: 'observatory' }).map((t) => t.title), ['A', 'B']);
  assert.deepEqual(store.list({ state: 'proposed' }).map((t) => t.id), ['2', '3']);
  assert.deepEqual(store.list({ state: ['approved', 'proposed'] }).map((t) => t.id), ['1', '2', '3']);
  assert.deepEqual(store.list({ channel: 'observatory', state: 'approved' }).map((t) => t.id), ['1']);
});

test('スレッドとタスクは 1:1 — 同じスレッドを 2 つのタスクに結び付けない', () => {
  const store = board();
  const a = seed(store, { title: 'A' });
  const b = seed(store, { title: 'B' });
  store.approve(a.id, { now: at(1) });
  store.approve(b.id, { now: at(1) });
  store.start(a.id, { threadId: '999', now: at(2) });

  assert.equal(store.findByThread('999').id, a.id);
  assert.equal(store.findByThread('見つからない'), null);
  assert.equal(store.findByThread(null), null);

  assert.throws(() => store.start(b.id, { threadId: '999', now: at(3) }), /1:1/);
  assert.equal(store.get(b.id).state, 'approved', '断ったら状態は動かない');
});

// ---- job 予算 ----

test('job 予算は消費できるが履歴も状態も汚さない', () => {
  const store = board();
  const task = seed(store, {}, { now: T0 });
  store.approve(task.id, { now: at(1) });
  store.start(task.id, { threadId: '5', now: at(2) });

  const spent = store.spendJob(task.id, { now: at(3) });
  assert.equal(spent.jobsSpent, 1);
  assert.equal(spent.state, 'in-progress');
  assert.equal(spent.updatedAt, iso(3));
  assert.equal(spent.history.length, 3, '履歴は遷移だけの台帳');

  assert.equal(store.spendJob(task.id, { count: 2, now: at(4) }).jobsSpent, 3);
  assert.equal(remainingJobs(store.get(task.id)), DEFAULT_JOB_BUDGET - 3);

  assert.throws(() => store.spendJob(task.id, { count: 0 }), /count/);
  store.block(task.id, { reason: '予算切れ', now: at(5) });
  assert.throws(() => store.spendJob(task.id), /blocked なので job 予算を消費できません/);
});

test('remainingJobs は使い切りと壊れた値を 0 に丸める', () => {
  assert.equal(remainingJobs({ jobsSpent: 0, jobBudget: 20 }), 20);
  assert.equal(remainingJobs({ jobsSpent: 20, jobBudget: 20 }), 0);
  assert.equal(remainingJobs({ jobsSpent: 25, jobBudget: 20 }), 0);
  assert.equal(remainingJobs({}), 0);
  assert.equal(remainingJobs(null), 0);
});

// ---- 永続化 ----

test('保存はディスクへ落ちて、読み直しても同じボードになる', () => {
  const path = tempFile();
  const store = new TaskBoardStore(path);
  const task = seed(store);
  store.approve(task.id, { by: 'fable', now: at(1) });
  store.start(task.id, { threadId: '4242', now: at(2) });

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw['1'].state, 'in-progress');
  assert.equal(raw['1'].threadId, '4242');

  const reopened = new TaskBoardStore(path);
  const reloaded = reopened.get('1');
  assert.equal(reloaded.state, 'in-progress');
  assert.equal(reloaded.branch, 'task/1');
  assert.equal(reloaded.history.at(1).by, 'fable');
  assert.equal(reopened.findByThread('4242').id, '1');
});

// ---- 封鎖からの復帰 (検収裁定 2026-08-27) ----

test('blocked は終端ではない — 復帰の行き先は approved だけ', () => {
  assert.deepEqual([...TERMINAL_STATES], ['merged', 'dropped']);
  assert.deepEqual([...TRANSITIONS.blocked], ['approved']);
  assert.equal(canTransition('blocked', 'approved'), true);
  for (const to of ['in-progress', 'review', 'merged', 'dropped', 'blocked']) {
    assert.equal(canTransition('blocked', to), false, `blocked → ${to} を通している`);
  }
});

test('resume は approved へ戻し、addBudget を積み増して履歴に残す', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  store.start(task.id, { threadId: '7', now: at(2) });
  store.spendJob(task.id, { count: DEFAULT_JOB_BUDGET, now: at(3) });
  store.block(task.id, { reason: 'job 予算切れ', now: at(4) });
  assert.equal(remainingJobs(store.get(task.id)), 0);

  const resumed = store.resume(task.id, { addBudget: 5, by: 'so', note: '追い予算', now: at(5) });
  assert.equal(resumed.state, 'approved');
  assert.equal(resumed.jobBudget, DEFAULT_JOB_BUDGET + 5);
  assert.equal(resumed.jobsSpent, DEFAULT_JOB_BUDGET, '使った分は履歴なので減らさない');
  assert.equal(remainingJobs(resumed), 5);
  assert.deepEqual(resumed.history.at(-1), {
    at: iso(5), from: 'blocked', to: 'approved', by: 'so', note: '追い予算', addBudget: 5,
  });

  // 戻った先は承認済みなので、着手からやり直せる
  assert.equal(store.start(task.id, { now: at(6) }).state, 'in-progress');
});

test('resume の addBudget は省略で 0 積み増し / 不正値は拒否して何も動かさない', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  store.block(task.id, { reason: '要人間', now: at(2) });

  for (const addBudget of [-1, 1.5, '5', null, NaN, Infinity]) {
    assert.throws(() => store.resume(task.id, { addBudget }), /addBudget/, JSON.stringify(addBudget));
  }
  assert.equal(store.get(task.id).state, 'blocked', '拒否したのに状態が動いている');
  assert.equal(store.get(task.id).jobBudget, DEFAULT_JOB_BUDGET);
  assert.equal(store.get(task.id).history.length, 3);

  const resumed = store.resume(task.id, { now: at(3) });
  assert.equal(resumed.state, 'approved');
  assert.equal(resumed.jobBudget, DEFAULT_JOB_BUDGET, '省略時に予算が増えている');
  assert.deepEqual(resumed.history.at(-1), { at: iso(3), from: 'blocked', to: 'approved' });
});

test('merged / dropped は終端のまま (resume も効かない)', () => {
  const store = board();
  const merged = seed(store, { title: 'A' });
  store.approve(merged.id, { now: at(1) });
  store.start(merged.id, { threadId: '1', now: at(2) });
  store.submitForReview(merged.id, { now: at(3) });
  store.complete(merged.id, { now: at(4) });
  assert.throws(() => store.resume(merged.id), /merged から approved へ進めません/);

  const dropped = seed(store, { title: 'B' });
  store.drop(dropped.id, { now: at(1) });
  assert.throws(() => store.resume(dropped.id), /dropped から approved へ進めません/);
});

test('spendJob は blocked を引き続き拒否する (止まっている間に予算を溶かさない)', () => {
  const store = board();
  const task = seed(store);
  store.approve(task.id, { now: at(1) });
  store.start(task.id, { threadId: '2', now: at(2) });
  store.block(task.id, { reason: '要人間', now: at(3) });
  assert.throws(() => store.spendJob(task.id), /blocked なので job 予算を消費できません/);

  // 復帰すれば再び消費できる
  store.resume(task.id, { addBudget: 2, now: at(4) });
  assert.equal(store.spendJob(task.id, { now: at(5) }).jobsSpent, 1);
});

// ---- 差し戻し (裁定 2026-08-28) ----

/** 着手済み (in-progress) のタスクを 1 件作る */
function started(store, over = {}) {
  const task = seed(store, over);
  store.approve(task.id, { now: at(1) });
  return store.start(task.id, { threadId: `T${task.id}`, now: at(2) });
}

test('レビューから実装中へ戻せる (スレッドもブランチもそのまま)', () => {
  const store = board();
  const task = started(store);
  store.submitForReview(task.id, { now: at(3) });

  const back = store.sendBack(task.id, { reason: 'テストが足りない', by: 'fable', now: at(4) });
  assert.equal(back.state, 'in-progress');
  assert.equal(back.threadId, task.threadId, 'スレッドを外している');
  assert.equal(back.branch, 'task/1', 'ブランチを付け替えている');
  assert.deepEqual(back.history.at(-1), {
    at: iso(4), from: 'review', to: 'in-progress', by: 'fable', note: 'テストが足りない',
  });
  // 直したらもう一度レビューへ出せる
  assert.equal(store.submitForReview(task.id, { now: at(5) }).state, 'review');
});

test('差し戻しの回数は履歴から数える (別フィールドで持たない)', () => {
  const store = board();
  const task = started(store);
  assert.equal(sendBackCount(store.get(task.id)), 0);

  store.submitForReview(task.id, { now: at(3) });
  store.sendBack(task.id, { reason: '1 回目', now: at(4) });
  assert.equal(sendBackCount(store.get(task.id)), 1);

  store.submitForReview(task.id, { now: at(5) });
  store.sendBack(task.id, { reason: '2 回目', now: at(6) });
  assert.equal(sendBackCount(store.get(task.id)), 2);

  // 壊れた入力でも落ちない
  assert.equal(sendBackCount(null), 0);
  assert.equal(sendBackCount({ history: 'なし' }), 0);
});

test('差し戻しても job 予算は消費し続けられる (blocked とは違う)', () => {
  const store = board();
  const task = started(store);
  store.submitForReview(task.id, { now: at(3) });
  // review 中は走っていないが、予算の門番はボードではなく hops が持つ
  assert.equal(canSpendJob(store.get(task.id)), true);

  store.sendBack(task.id, { reason: 'r', now: at(4) });
  assert.equal(store.spendJob(task.id, { now: at(5) }).jobsSpent, 1);

  store.block(task.id, { reason: '要人間', now: at(6) });
  assert.equal(canSpendJob(store.get(task.id)), false);
  for (const state of ['merged', 'dropped', 'blocked']) {
    assert.equal(canSpendJob({ state }), false, state);
  }
  for (const state of ['proposed', 'approved', 'in-progress', 'review']) {
    assert.equal(canSpendJob({ state }), true, state);
  }
  assert.equal(canSpendJob(null), false);
});

test('壊れた値が混ざっていても一覧が落ちない', () => {
  const store = board();
  seed(store);
  store.commit({ ...store.data, ごみ: 'これはタスクではない', 'ごみ2': null });
  assert.deepEqual(store.list().map((t) => t.id), ['1']);
  assert.equal(store.get('ごみ'), null);
});
