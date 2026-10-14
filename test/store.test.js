import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PauseStore, TickStateStore, brokenLedgers, formatBrokenLedgers } from '../src/store.js';
import { initialState, persistedState, restoreState } from '../src/scheduler.js';

function tempFile(name = 'pause.json') {
  return join(mkdtempSync(join(tmpdir(), 'communitd-pause-')), name);
}

const T0 = Date.parse('2026-08-28T09:00:00.000Z');

// ---- 自律運転の kill switch (docs/social-engineering.md §3.7) ----

test('止めていなければ動いている扱い (ファイルが無くても落ちない)', () => {
  const store = new PauseStore(tempFile());
  assert.equal(store.paused, false);
  assert.equal(store.current(), null);
  assert.equal(store.last(), null);
});

test('止めると「いつ誰がなぜ」を残す', () => {
  const store = new PauseStore(tempFile());
  const entry = store.pause({ by: 'U1', reason: '様子を見る', now: T0 });
  assert.deepEqual(entry, {
    paused: true, at: '2026-08-28T09:00:00.000Z', by: 'U1', reason: '様子を見る',
  });
  assert.equal(store.paused, true);
  assert.deepEqual(store.current(), entry);
  // 理由は省略できる (前後の空白は落とす)
  const bare = new PauseStore(tempFile()).pause({ now: T0 });
  assert.equal(bare.reason, '');
  assert.equal(bare.by, null);
});

test('**再起動を跨いで止まったまま**になる (勝手に動き出さない)', () => {
  const path = tempFile();
  const before = new PauseStore(path);
  before.pause({ by: 'U1', reason: '暴走の調査', now: T0 });

  // 別プロセスが同じファイルを読み直した状況
  const after = new PauseStore(path);
  assert.equal(after.paused, true, '再起動で停止が解けている');
  assert.equal(after.current().reason, '暴走の調査', '止めた理由が消えている');
  assert.equal(after.current().at, '2026-08-28T09:00:00.000Z');

  // ディスクにも落ちている
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.pause.paused, true);
});

test('再開すると解け、それも再起動を跨ぐ', () => {
  const path = tempFile();
  const store = new PauseStore(path);
  store.pause({ by: 'U1', reason: '調査', now: T0 });

  const before = store.resume({ by: 'U2', now: T0 + 60_000 });
  assert.equal(before.reason, '調査', '止まっていたときの記録を返していない');
  assert.equal(store.paused, false);
  assert.equal(store.current(), null);
  // 「いつ誰が再開したか」は残す
  assert.deepEqual(store.last(), {
    paused: false, at: '2026-08-28T09:01:00.000Z', by: 'U2', reason: '',
  });
  assert.equal(new PauseStore(path).paused, false, '再開が永続していない');

  // 元から動いているときの再開は null (何も止まっていなかった)
  assert.equal(new PauseStore(tempFile()).resume({ by: 'U1', now: T0 }), null);
});

// ---- 読込の 4 分類 (docs/social-engineering.md §12.3 (1)) ----
// ① 有効な JSON の中の値が不正 ② ファイルが不正な JSON ③ 読込エラー ④ 初回 (不在)。
// ①だけが「ファイルは読めている」— ②③ はファイル単位の破損で、扱いが違う

test('① 有効な JSON の中の壊れた値は「止まっている」側へ倒す (ファイルは読めている)', () => {
  const path = tempFile();
  // paused: false と**明示されているときだけ**動いてよい
  writeFileSync(path, JSON.stringify({ pause: { at: 'いつか' } }), 'utf8');
  assert.equal(new PauseStore(path).paused, true, '壊れた記録で自律運転が動き出す');
  assert.equal(new PauseStore(path).broken, null, 'ファイルは読めているのに broken にしている');

  writeFileSync(path, JSON.stringify({ pause: { paused: 'true' } }), 'utf8');
  assert.equal(new PauseStore(path).paused, true);

  // 記録そのものが無い / 形が違うものは「止めていない」(押していないボタンは効かない)
  for (const pause of [undefined, null, 'stopped', 42, ['x']]) {
    writeFileSync(path, JSON.stringify(pause === undefined ? {} : { pause }), 'utf8');
    assert.equal(new PauseStore(path).paused, false, JSON.stringify(pause));
  }
  // ここは書ける (台帳そのものは読めているので、証拠を消す心配が無い)
  const ok = new PauseStore(path);
  ok.pause({ by: 'U1', now: T0 });
  assert.equal(new PauseStore(path).paused, true);
});

test('② ファイルが不正な JSON なら退避せず停止扱いにし、commit を断る', () => {
  const path = tempFile();
  writeFileSync(path, '{ "pause": ', 'utf8');
  const store = new PauseStore(path);

  assert.equal(store.broken.kind, 'syntax-error');
  assert.match(store.broken.reason, /JSON として読めません/);
  assert.ok(Date.parse(store.broken.at) > 0, '壊れていると気づいた時刻が無い');
  assert.equal(store.healthy, false);

  // **退避しない** — 動かすと次の起動が「初回」に見えて停止が黙って解ける
  assert.deepEqual(readdirSync(dirname(path)), ['pause.json'], '退避ファイルを作っている');
  assert.equal(readFileSync(path, 'utf8'), '{ "pause": ', '壊れたファイルの中身が変わっている');

  // 停止扱い (合成記録)。読む側は人が押した停止と同じ形で受け取れる
  assert.equal(store.paused, true);
  assert.deepEqual(store.current(), {
    paused: true,
    by: 'system',
    reason: `pause.json が読めない: ${store.broken.reason}`,
    broken: true,
    at: store.broken.at,
  });
  assert.deepEqual(store.last(), store.current());

  // 書き込みは全部断る (証拠を上書きしない)。/resume でも解けない
  assert.throws(() => store.resume({ by: 'U1', now: T0 }), /台帳を直すか手で退避してから/);
  assert.throws(() => store.pause({ by: 'U1', now: T0 }), /pause\.json が読めないので保存しません/);
  // commit を迂回する save() にも同じ門を置く (Opus2 レビュー 2026-09-07 Minor1)
  assert.throws(() => store.save(), /pause\.json が読めないので保存しません/);
  assert.equal(readFileSync(path, 'utf8'), '{ "pause": ');
  assert.equal(new PauseStore(path).paused, true, '再起動しても停止扱いのまま (退避されていない)');

  // トップレベルが object でないもの (配列・文字列) も同じ扱い
  for (const text of ['[]', '"止めた"', '42', 'null']) {
    const other = tempFile();
    writeFileSync(other, text, 'utf8');
    const s = new PauseStore(other);
    assert.equal(s.broken.kind, 'shape-error', text);
    assert.equal(s.paused, true, text);
    assert.throws(() => s.resume({ by: 'U1', now: T0 }), text);
  }
});

test('③ 読込エラー (権限・種別) は破損と区別して残す — これも停止扱いで、退避しない', () => {
  // 読めないパスの注入: ディレクトリを台帳として開く (EISDIR — OS を問わず読込に失敗する)
  const dir = mkdtempSync(join(tmpdir(), 'communitd-pause-dir-'));
  const store = new PauseStore(dir);

  assert.equal(store.broken.kind, 'read-error');
  assert.equal(typeof store.broken.code, 'string', 'errno の code を落としている');
  assert.match(store.broken.reason, /読み込めません/);
  assert.equal(store.paused, true, '読めないことを「止めていない」と読んでいる');
  assert.equal(store.current().broken, true);
  assert.throws(() => store.pause({ by: 'U1', now: T0 }), /台帳を直すか手で退避してから/);
  assert.deepEqual(readdirSync(dir), [], '読めないものを触っている');
});

test('④ 初回 (ファイル不在) だけが空から始まってよい (broken にしない)', () => {
  const path = tempFile();
  const store = new PauseStore(path);
  assert.equal(store.broken, null);
  assert.equal(store.healthy, true);
  assert.equal(store.paused, false);
  // 空から始めたぶんは書ける (ここで初めてファイルが生える)
  store.pause({ by: 'U1', now: T0 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pause.paused, true);
});

test('brokenLedgers: 読めない台帳だけを {file, reason} で並べる (broken を持たない偽物は健全扱い)', () => {
  const bad = tempFile();
  writeFileSync(bad, '{ broken', 'utf8');
  const list = brokenLedgers([
    new PauseStore(bad),
    new PauseStore(tempFile()),          // 初回 = 健全
    { paused: false },                    // 配線のテストが渡す偽物 (broken を持たない)
    null,
    { filePath: '/x/job-runs.json', broken: 'JSON として読めません (…)' }, // JobRunStore は文字列
  ]);
  assert.deepEqual(list.map((l) => l.file), ['pause.json', 'job-runs.json']);
  assert.match(formatBrokenLedgers(list), /^pause\.json: JSON として読めません.* \/ job-runs\.json: /);
  assert.deepEqual(brokenLedgers(), []);
});

test('保存に失敗したらメモリも巻き戻す (JsonStore の流儀)', () => {
  // 親が「ファイル」なので mkdir も書き込みも必ず失敗する場所
  const blocker = tempFile('not-a-directory');
  writeFileSync(blocker, 'x', 'utf8');
  const store = new PauseStore(join(blocker, 'pause.json'));

  assert.throws(() => store.pause({ by: 'U1', now: T0 }));
  assert.equal(store.paused, false, '書けていないのに止まったことになっている');
});

// ---- スケジューラの勘定 (docs/social-engineering.md §3.9) ----

test('TickStateStore はチャンネルごとに勘定を持ち越す (壊れた値は無いものとして扱う)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'communitd-tick-')), 'tick-states.json');
  const store = new TickStateStore(path);
  assert.equal(store.get('observatory'), null);

  const saved = persistedState({
    ...initialState(),
    dayKey: '2026-08-29',
    jobsToday: 3,
    lastScoutAt: T0,
    initiative: { lastRunAt: { 'sol/audit': T0 }, spentToday: { sol: 1 } },
  });
  store.set('observatory', saved);
  assert.deepEqual(store.get('observatory'), saved);
  // 読み直しても同じ (再起動直後の連発を防ぐのがこの store の役目)
  assert.deepEqual(new TickStateStore(path).get('observatory'), saved);
  assert.deepEqual(restoreState(new TickStateStore(path).get('observatory')).initiative, saved.initiative);

  // 別チャンネルは混ざらない
  assert.equal(store.get('yobidashi-dev'), null);

  writeFileSync(path, JSON.stringify({ observatory: '壊れた値' }), 'utf8');
  assert.equal(new TickStateStore(path).get('observatory'), null);
});
