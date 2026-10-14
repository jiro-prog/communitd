import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { snowflakeAt } from '../src/bridge/discord.js';
import { findRequestMessage, gitDirtyFor } from '../src/bridge/recovery.js';
import { canonicalCwd } from '../src/toolstore.js';
import { worktreePathFor } from '../src/worktree.js';

// src/bridge/recovery.js — 送達不明の再開要求をスレッドで探す走査 (findRequestMessage)。
// この結果で再開要求が sent / failed / 不明のまま塞ぐ に分かれる (src/recovery-wiring.js の settleOpenRequest)。
// discord.js の client と channel は偽物を注入し、messages.fetch は呼ばれた引数を溜めて決めたページを返す。

const THREAD = '700';
const MARKER = '再開要求 42-1';
const SINCE = Date.UTC(2026, 9, 7, 3, 0, 0);
const BASE = BigInt(snowflakeAt(SINCE));
const BOT_A = 'U-A';
const BOT_B = 'U-B';
const OTHER = 'U-OTHER';

/** BASE から n 進めた snowflake (BigInt で並べるので数値文字列) */
const idAt = (n) => (BASE + BigInt(n)).toString();

const msg = (n, { author = BOT_A, content = '途中経過' } = {}) => ({ id: idAt(n), author: { id: author }, content });

/** from から count 件の、印を持たない自前の投稿 (挿入順は昇順) */
function page(from, count) {
  return Array.from({ length: count }, (_, i) => msg(from + i));
}

/** discord.js の Collection と同じく Map で返す (走査は batch.values() を読む) */
const asBatch = (messages) => new Map(messages.map((m) => [m.id, m]));

/**
 * 偽の bot registry。messages.fetch は pages を順に返し、尽きたら空。
 * channel を cache に置かないときは channels.fetch が返す (cached: false)
 */
function harness({ pages = [], cached = true, channel: given, users = [BOT_A, BOT_B] } = {}) {
  const calls = [];
  const channelFetches = [];
  const channel = given !== undefined ? given : {
    messages: {
      fetch: async (opts) => {
        calls.push(opts);
        return asBatch(pages[calls.length - 1] ?? []);
      },
    },
  };
  const client = {
    channels: {
      cache: new Map(cached ? [[THREAD, channel]] : []),
      fetch: async (id) => {
        channelFetches.push(id);
        return cached ? null : channel;
      },
    },
  };
  const bots = new Map(users.map((userId, i) => [`bot${i}`, { key: `bot${i}`, userId, client }]));
  return { bots, calls, channelFetches };
}

test('2 ページ目にある印つきの自前 bot の投稿を見つけ、次の after は 1 ページ目の最大 id', async () => {
  const { bots, calls } = harness({
    // 印を持つのは fetch に使った bot (先頭) ではなく、別の自前 bot の投稿
    pages: [page(1, 100), [msg(101), msg(102, { author: BOT_B, content: `${MARKER} — 続きから` }), msg(103)]],
  });

  const got = await findRequestMessage(bots, { threadId: THREAD, marker: MARKER, since: SINCE });

  assert.deepEqual(got, { messageId: idAt(102), complete: true, scanned: 103 });
  assert.deepEqual(calls, [
    { after: snowflakeAt(SINCE - 5 * 60 * 1000), limit: 100 }, // 要求の作成時刻の 5 分前から
    { after: idAt(100), limit: 100 },
  ]);
});

test('自前でない作者の同じ印は拾わない', async () => {
  const foreign = msg(1, { author: OTHER, content: MARKER });
  const noAuthor = { id: idAt(2), content: MARKER };

  const onlyForeign = harness({ pages: [[foreign, noAuthor, msg(3)]] });
  assert.deepEqual(
    await findRequestMessage(onlyForeign.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    { messageId: null, complete: true, scanned: 3 },
  );

  // 先に来る他人の印を飛ばして、後ろの自前の印を返す
  const both = harness({ pages: [[foreign, msg(4, { author: BOT_B, content: MARKER })]] });
  assert.deepEqual(
    await findRequestMessage(both.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    { messageId: idAt(4), complete: true, scanned: 2 },
  );
});

test('since ありで短いページに尽きたら、見つからなくても complete: true (末尾まで走査した)', async () => {
  const { bots, calls } = harness({ pages: [page(1, 100), page(101, 100), page(201, 7)] });

  const got = await findRequestMessage(bots, { threadId: THREAD, marker: MARKER, since: SINCE });

  assert.deepEqual(got, { messageId: null, complete: true, scanned: 207 });
  assert.deepEqual(calls.map((c) => c.after), [snowflakeAt(SINCE - 5 * 60 * 1000), idAt(100), idAt(200)]);

  // 満杯の直後が空ページでも末尾に届いている
  const empty = harness({ pages: [page(1, 100), []] });
  assert.deepEqual(
    await findRequestMessage(empty.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    { messageId: null, complete: true, scanned: 100 },
  );
});

test('since 無しは最新 100 件だけを見る — 見つからなければ短いページでも complete: false', async () => {
  for (const since of [undefined, null, Number.NaN]) {
    const short = harness({ pages: [page(1, 3)] });
    assert.deepEqual(
      await findRequestMessage(short.bots, { threadId: THREAD, marker: MARKER, since }),
      { messageId: null, complete: false, scanned: 3 },
      `since=${since}`,
    );
    assert.deepEqual(short.calls, [{ limit: 100 }], `since=${since} で after を付けた`);
  }

  // 満杯でも 2 ページ目は取らない
  const full = harness({ pages: [page(1, 100), page(101, 100)] });
  assert.deepEqual(
    await findRequestMessage(full.bots, { threadId: THREAD, marker: MARKER }),
    { messageId: null, complete: false, scanned: 100 },
  );
  assert.deepEqual(full.calls, [{ limit: 100 }]);

  // 最新 100 件の中にあれば見つかる
  const hit = harness({ pages: [[msg(1), msg(2, { content: MARKER })]] });
  assert.deepEqual(
    await findRequestMessage(hit.bots, { threadId: THREAD, marker: MARKER }),
    { messageId: idAt(2), complete: true, scanned: 2 },
  );
});

test('30 ページ満杯なら 31 回目を取らずに complete: false (打ち切り = 不完全)', async () => {
  const pages = Array.from({ length: 31 }, (_, i) => page(i * 100 + 1, 100));
  const { bots, calls } = harness({ pages });

  const got = await findRequestMessage(bots, { threadId: THREAD, marker: MARKER, since: SINCE });

  assert.deepEqual(got, { messageId: null, complete: false, scanned: 3000 });
  assert.equal(calls.length, 30);
  assert.equal(calls[29].after, idAt(2900));
});

test('降順で返るページも昇順に並べて、次の after を最大 id に決める', async () => {
  const { bots, calls } = harness({ pages: [page(1, 100).reverse(), [msg(101, { content: MARKER })]] });

  const got = await findRequestMessage(bots, { threadId: THREAD, marker: MARKER, since: SINCE });

  assert.deepEqual(got, { messageId: idAt(101), complete: true, scanned: 101 });
  assert.equal(calls[1].after, idAt(100)); // 並べなければ末尾の最小 id (idAt(1)) になる
});

test('cache に無いスレッドは channels.fetch で取り、userId の無い bot の client は使わない', async () => {
  const { bots, channelFetches } = harness({ cached: false, pages: [[msg(1, { content: MARKER })]] });
  // 先頭に起動していない bot (client が無いので、使えば落ちる)
  const withDown = new Map([['down', { key: 'down', userId: null, client: null }], ...bots]);

  const got = await findRequestMessage(withDown, { threadId: 700, marker: MARKER, since: SINCE });

  assert.deepEqual(got, { messageId: idAt(1), complete: true, scanned: 1 });
  assert.deepEqual(channelFetches, [THREAD]); // threadId は文字列にして引く
});

test('起動している bot が無い・スレッドが取れない・messages.fetch が無いときは投げる', async () => {
  const none = harness({ users: [null, null] });
  await assert.rejects(
    findRequestMessage(none.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    /起動している bot がありません/,
  );

  const missing = harness({ cached: false, channel: null });
  await assert.rejects(
    findRequestMessage(missing.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    new RegExp(`スレッド ${THREAD} を取得できません`),
  );
  assert.deepEqual(missing.channelFetches, [THREAD]);

  const noMessages = harness({ channel: { id: THREAD } });
  await assert.rejects(
    findRequestMessage(noMessages.bots, { threadId: THREAD, marker: MARKER, since: SINCE }),
    new RegExp(`スレッド ${THREAD} を取得できません`),
  );
});

// src/bridge/recovery.js — 再開メッセージに載せる「作業ツリーに前回の変更が残っているか」(gitDirtyFor)。
// 答えで retryMessage が「捨てずに続ける」/「変更は見えない」/ 書かない に分かれる (src/recovery.js)。
// 一時リポジトリに git worktree add で .worktrees/task-N を作り、本物の git status で回す。
// 一時ディレクトリがどこかのリポジトリの中にある環境では skip する — git -C は祖先を遡って .git を探すので、
// 進めると**このテストを走らせているリポジトリ**に git を打つことになる。

const TASK_ID = 7;
const AUTONOMY = { enabled: true, baseBranch: 'master' };
const TASK = { id: TASK_ID, channel: 'proj' };

/** git が dir をリポジトリの中と見ていないこと (test/bridge-messages.test.js の門と同じ) */
function outsideAnyRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore', windowsHide: true });
    return false;
  } catch {
    return true;
  }
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

/**
 * master に 1 コミット (`.worktrees/` の無視設定と a.txt) を持つ一時リポジトリ。
 * worktree: true なら TASK_ID の作業ツリーを `git worktree add` で作る。用意できない環境では null
 */
function tempRepo(t, { worktree = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-gitdirty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  if (!outsideAnyRepo(dir)) return null;
  execFileSync('git', ['init', '-q', '--initial-branch=master', join(dir, 'repo')], { windowsHide: true });
  const repo = canonicalCwd(join(dir, 'repo'));
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.gitignore', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  const tree = worktreePathFor(repo, TASK_ID);
  if (worktree) git(repo, 'worktree', 'add', '-q', '-b', `task/${TASK_ID}`, tree, 'master');
  return { dir, repo, tree, config: { channels: { proj: { cwd: repo } } } };
}

test('gitDirtyFor: タスクの作業ツリーを見て本体を見ない — 本体だけ dirty なら false、作業ツリーに未 commit の変更があれば true', (t) => {
  const h = tempRepo(t);
  if (!h) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const dirty = () => gitDirtyFor(h.config, { task: TASK, autonomy: AUTONOMY });

  assert.equal(dirty(), false, '本体も作業ツリーも clean');

  // 本体に作者の未 commit の変更 (追跡ファイルの変更と未追跡ファイル) — これが常態
  writeFileSync(join(h.repo, 'a.txt'), 'author edit\n');
  writeFileSync(join(h.repo, 'notes.txt'), 'x\n');
  assert.notEqual(git(h.repo, 'status', '--porcelain'), '', '前提: 本体は dirty');
  assert.equal(dirty(), false, '本体の変更を作業ツリーの変更と取り違えた');

  // 前回の担当の変更が作業ツリーに残っている
  writeFileSync(join(h.tree, 'a.txt'), 'worker edit\n');
  assert.equal(dirty(), true, '追跡ファイルの未 commit の変更');
  git(h.tree, 'commit', '-q', '-a', '-m', 'worker');
  assert.equal(dirty(), false, 'commit 済みの変更は「残っている」に数えない');
  writeFileSync(join(h.tree, 'new.js'), 'x\n');
  assert.equal(dirty(), true, '未追跡ファイル');
});

test('gitDirtyFor: 自律運転でないタスクはチャンネル本体を見る (job が本体で走る)', (t) => {
  const h = tempRepo(t, { worktree: false });
  if (!h) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  const off = { enabled: false };

  assert.equal(gitDirtyFor(h.config, { task: TASK, autonomy: off }), false);
  writeFileSync(join(h.repo, 'notes.txt'), 'x\n');
  assert.equal(gitDirtyFor(h.config, { task: TASK, autonomy: off }), true);
});

test('gitDirtyFor: 設定にチャンネルが無い・cwd が無い・cwd が消えたら null (git を打たない)', () => {
  const missing = join(tmpdir(), `communitd-gitdirty-missing-${process.pid}`);
  const cases = [
    [{}, '設定に channels が無い'],
    [{ channels: { proj: {} } }, 'cwd が無い'],
    [{ channels: { proj: { cwd: '' } } }, 'cwd が空'],
    [{ channels: { proj: { cwd: missing } } }, 'cwd が消えた'],
  ];
  for (const [config, label] of cases) {
    assert.equal(gitDirtyFor(config, { task: TASK, autonomy: AUTONOMY }), null, label);
  }
});

test('gitDirtyFor: 未登録チャンネル・作業ツリーが無い・git でない dir は null (本体へ倒れない)', (t) => {
  const h = tempRepo(t, { worktree: false });
  if (!h) {
    t.skip('一時ディレクトリが git の管理下にある');
    return;
  }
  // 本体を dirty にしておく — 本体へ倒れていれば true になるので、null が「本体を見ていない」の証拠になる
  writeFileSync(join(h.repo, 'notes.txt'), 'x\n');
  const off = { enabled: false };
  assert.equal(gitDirtyFor(h.config, { task: TASK, autonomy: off }), true, '前提: 登録済みの本体なら読める');
  assert.equal(
    gitDirtyFor(h.config, { task: { ...TASK, channel: 'other' }, autonomy: off }),
    null,
    '未登録チャンネル (登録済みのチャンネルの cwd を借りない)',
  );
  assert.equal(gitDirtyFor(h.config, { task: TASK, autonomy: AUTONOMY }), null, '作業ツリーが無い');

  // リポジトリの外の dir: .worktrees/task-N が (ただの dir として) あっても、本体としても読めない
  const plain = canonicalCwd(mkdtempSync(join(h.dir, 'plain-')));
  mkdirSync(worktreePathFor(plain, TASK_ID), { recursive: true });
  const config = { channels: { proj: { cwd: plain } } };
  assert.equal(gitDirtyFor(config, { task: TASK, autonomy: AUTONOMY }), null, 'git でない dir (作業ツリー側)');
  assert.equal(gitDirtyFor(config, { task: TASK, autonomy: { enabled: false } }), null, 'git でない dir (本体側)');
});

test('gitDirtyFor: パス片に使えないタスク ID は投げる (null に畳むのは呼び手の safeGitDirty)', () => {
  const config = { channels: { proj: { cwd: tmpdir() } } };
  assert.throws(
    () => gitDirtyFor(config, { task: { id: '../evil', channel: 'proj' }, autonomy: AUTONOMY }),
    /使えないタスク ID/,
  );
});
