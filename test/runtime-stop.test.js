import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runClaude } from '../src/claude.js';
import { runCodex } from '../src/codex.js';
import { classifyReason } from '../src/jobruns.js';

// runClaude / runCodex の止め方の経路 (停止の指示・タイムアウト・出力上限・結果なし・exit≠0)。
// 壊れると、刺さった CLI が処理の列を掴んだままになり (同時枠 1 のチャンネルは全部止まる)、
// /stop が効かず、タイムアウトが「失敗」として記録されて自動復旧の判断を誤らせる。

/**
 * 自分からは閉じない偽の子プロセス。本物の CLI が刺さったときと同じで、ブリッジが止めない限り終わらない。
 *
 * **kill() は回数と signal を控えるだけで、close は出さない。** 殺された子の close はテストが
 * `closeAsKilled()` で手で出す — kill() の中で自動的に出すと、「kill した」と「close まで待った」を
 * 区別できず、kill した直後に close を待たずに終わる回帰がすり抜ける。close を待つのは
 * 刺さった子と次の job を並走させないため (src/claude.js の close ハンドラ)。
 *
 * **pid を持たせない。** killTree は pid があると本物の `taskkill /pid N /T /F` (win32) や
 * `process.kill(-pid)` (それ以外) を撃つ (src/proc.js)。pid が無ければ両方とも
 * `child.kill('SIGKILL')` に落ちるので、偽の kill で回数と signal を数えられる。
 */
function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  // 本物と同じく、殺された子の close は (code: null, signal) で来る
  child.closeAsKilled = () => child.emit('close', null, 'SIGKILL');
  return child;
}

/** Promise が終わったかを同期に覗けるようにする (close を待っているかを見るため) */
function track(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; });
  return state;
}

/**
 * spawn の差し替え。`script(child, args)` で子の振る舞い (出力・自分からの close) を足す。
 * 起こした子は `spawned` に残る (kill が何回呼ばれたかを後で見る)。
 */
function spawner(script = () => {}) {
  const spawned = [];
  const spawnImpl = (bin, args) => {
    const child = hangingChild();
    spawned.push(child);
    setImmediate(() => script(child, args));
    return child;
  };
  return { spawnImpl, spawned };
}

// 解決は固定する (実機の PATH に判定を委ねない — test/claude.test.js の runT と同じ理由)
const RUNTIMES = {
  claude: (opts) => runClaude({
    cwd: process.cwd(), model: 'opus', prompt: 'x', resolveCmdImpl: (b) => [b ?? 'claude'], ...opts,
  }),
  codex: (opts) => runCodex({
    cwd: process.cwd(), prompt: 'x', resolveCmdImpl: () => ['codex'], ...opts,
  }),
};

/**
 * runJob が実行記録へ渡す終了理由の合成 (src/bridge/job.js:690-704 をそのまま写す)。
 * 分類は src/jobruns.js の classifyReason の実物を通す
 */
const reasonOf = (res) => {
  if (res.aborted) return 'aborted';
  if (!res.ok) return `failed(${(res.error ?? '実行エラー').slice(0, 60)})`;
  return 'ok';
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** codex の `-o` (最終メッセージの書き出し先) */
const outFileOf = (args) => args[args.indexOf('-o') + 1];

for (const [name, run] of Object.entries(RUNTIMES)) {
  test(`${name}: 停止の指示は子を kill し、close を待って「停止」で終わる`, async () => {
    const { spawnImpl, spawned } = spawner((child) => child.stderr.emit('data', '作業中'));
    const handle = {};
    const pending = run({ spawnImpl, handle, timeoutMs: 2000 });
    const state = track(pending);
    await sleep(5);
    handle.abort();
    // **await の前に見る。** kill しない回帰でも、タイムアウトが代わりに kill するので
    // `aborted` の結果自体は返ってしまう
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].kills, ['SIGKILL'], '停止の指示で kill していない');
    await sleep(10);
    assert.equal(state.settled, false, 'close を待たずに終わっている');
    spawned[0].closeAsKilled();
    const res = await pending;
    assert.deepEqual(spawned[0].kills, ['SIGKILL']);
    assert.equal(handle.stopRequested, true);
    assert.equal(res.ok, false);
    assert.equal(res.aborted, true);
    assert.equal(res.error, '停止指示により中断');
    // 停止は「失敗」ではない。誰が止めたか (human) は stop 要求の側で記録される
    assert.deepEqual(classifyReason(reasonOf(res)), { outcome: 'aborted', detail: '', stopKind: null });
  });

  test(`${name}: 終わった後の停止の指示は kill を撃たず、次の起動を止める印だけ残す`, async () => {
    // /stop の二度押しや、終わった直後の /stop。死んだ子 (再利用された pid) へ撃たない
    const { spawnImpl, spawned } = spawner((child, args) => {
      if (name === 'claude') child.stdout.emit('data', '{"is_error":false,"result":"ok"}\n');
      else writeFileSync(outFileOf(args), 'ok', 'utf8');
      child.emit('close', 0);
    });
    const handle = {};
    // timeoutMs は短く明示する (タイマーを消し忘れる回帰で既定の 1 時間プロセスが居座らない)
    const res = await run({ spawnImpl, handle, timeoutMs: 2000 });
    assert.equal(res.ok, true);
    handle.abort();
    assert.deepEqual(spawned[0].kills, []);
    assert.equal(handle.stopRequested, true);
    // 同じ handle で次を起こしても spawn せずに止まる (入口の検査が印を拾う)
    const next = await run({ spawnImpl, handle, timeoutMs: 2000 });
    assert.equal(next.aborted, true);
    assert.equal(spawned.length, 1, '停止の印があるのに次を起動した');
  });

  test(`${name}: タイムアウトは子を kill し、close を待って stopKind timeout で記録される`, async () => {
    const { spawnImpl, spawned } = spawner((child) => child.stderr.emit('data', '応答待ち'));
    const pending = run({ spawnImpl, timeoutMs: 20 });
    const state = track(pending);
    // タイムアウト (20ms) で kill された後も、close が来るまでは終わらない
    await sleep(50);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].kills, ['SIGKILL'], 'タイムアウトで kill していない');
    assert.equal(state.settled, false, 'close を待たずに終わっている');
    spawned[0].closeAsKilled();
    const res = await pending;
    assert.deepEqual(spawned[0].kills, ['SIGKILL']);
    assert.equal(res.ok, false);
    assert.equal(res.aborted, undefined, 'タイムアウトを停止の指示と取り違えている');
    assert.match(res.error, /^timeout after \d+ min$/);
    assert.match(res.detail, /応答待ち/);
    // ブリッジが子を殺した停止で、モデルの失敗ではない (自動復旧がここを見て判断する)
    const classified = classifyReason(reasonOf(res));
    assert.equal(classified.outcome, 'failed');
    assert.equal(classified.stopKind, 'timeout');
  });
}

test('claude: 出力が上限を超えたら子を kill し、close を待って上限超過で終わる', async () => {
  const { spawnImpl, spawned } = spawner((child) => {
    child.stdout.emit('data', 'x'.repeat(17));
    // kill の後に届いた出力では撃ち直さない
    child.stdout.emit('data', 'y'.repeat(17));
  });
  const pending = RUNTIMES.claude({ spawnImpl, maxStdoutBytes: 16, timeoutMs: 2000 });
  const state = track(pending);
  await sleep(10);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].kills, ['SIGKILL'], '上限を超えた時点で kill していない');
  assert.equal(state.settled, false, 'close を待たずに終わっている');
  spawned[0].closeAsKilled();
  const res = await pending;
  assert.deepEqual(spawned[0].kills, ['SIGKILL']);
  assert.equal(res.ok, false);
  assert.equal(res.aborted, undefined);
  assert.equal(res.error, '出力が上限 16B を超えたため中断');
  assert.equal(res.detail, 'x'.repeat(17), '上限を超えた後の出力まで貯めている');
  assert.deepEqual(classifyReason(reasonOf(res)), {
    outcome: 'failed', detail: '出力が上限 16B を超えたため中断', stopKind: null,
  });
});

// ---- 子が自分で閉じる失敗: kill は要らず、終わった後にタイムアウトも撃たない ----

/**
 * 子が自分で close した失敗を走らせ、kill が 1 回も呼ばれないことまで見る。
 * timeoutMs を短くしておき、終わった後に待つ — タイマーが残っていれば終わった子へ
 * kill (= 本物なら再利用された pid への taskkill) を撃つ
 */
async function runSelfClosing(run, script) {
  const { spawnImpl, spawned } = spawner(script);
  const res = await run({ spawnImpl, timeoutMs: 30 });
  await sleep(60);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].kills, [], '自分で閉じた子へ kill を撃った');
  return res;
}

test('claude: 結果 JSON が無ければ exit 0 でも失敗にし、stderr を detail に残す', async () => {
  const res = await runSelfClosing(RUNTIMES.claude, (child) => {
    child.stdout.emit('data', 'JSON ではない出力\n');
    child.stderr.emit('data', '何かが壊れた');
    child.emit('close', 0);
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 0);
  assert.equal(res.error, 'no JSON result (exit 0)');
  assert.match(res.detail, /何かが壊れた/);
  assert.deepEqual(classifyReason(reasonOf(res)), {
    outcome: 'failed', detail: 'no JSON result (exit 0)', stopKind: null,
  });
});

test('claude: exit≠0 で結果 JSON が無ければ exit code ごと失敗の理由に載る', async () => {
  const res = await runSelfClosing(RUNTIMES.claude, (child) => {
    child.stderr.emit('data', 'Error: 認証が切れています');
    child.emit('close', 1);
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.error, 'no JSON result (exit 1)');
  assert.match(res.detail, /認証が切れています/);
  const classified = classifyReason(reasonOf(res));
  assert.equal(classified.outcome, 'failed');
  assert.equal(classified.stopKind, null, 'exit≠0 をタイムアウトと取り違えている');
});

test('claude: exit≠0 で is_error の結果 JSON があれば、その理由で失敗する', async () => {
  const res = await runSelfClosing(RUNTIMES.claude, (child) => {
    child.stdout.emit('data', `${JSON.stringify({ is_error: true, session_id: 's1', result: 'API Error: 529 overloaded' })}\n`);
    child.emit('close', 1);
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.error, 'API Error: 529 overloaded');
  assert.deepEqual(classifyReason(reasonOf(res)), {
    outcome: 'failed', detail: 'API Error: 529 overloaded', stopKind: null,
  });
});

test('codex: 最終メッセージが無ければ exit 0 でも失敗にし、stderr を detail に残す', async () => {
  // codex は結果 JSON を stdout から読まない。`-o` のファイルが無い・空なのが「結果なし」
  const res = await runSelfClosing(RUNTIMES.codex, (child) => {
    child.stdout.emit('data', '{"type":"turn.started"}\n');
    child.stderr.emit('data', '何かが壊れた');
    child.emit('close', 0);
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 0);
  assert.equal(res.error, 'codex exit 0 (no output)');
  assert.match(res.detail, /何かが壊れた/);
  assert.deepEqual(classifyReason(reasonOf(res)), {
    outcome: 'failed', detail: 'codex exit 0 (no output)', stopKind: null,
  });
});

test('codex: exit≠0 なら最終メッセージがあっても失敗にする', async () => {
  const res = await runSelfClosing(RUNTIMES.codex, (child, args) => {
    writeFileSync(outFileOf(args), '途中までの回答', 'utf8');
    child.stderr.emit('data', 'stream disconnected');
    child.emit('close', 1);
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.error, 'codex exit 1');
  assert.match(res.detail, /stream disconnected/);
  const classified = classifyReason(reasonOf(res));
  assert.equal(classified.outcome, 'failed');
  assert.equal(classified.stopKind, null, 'exit≠0 をタイムアウトと取り違えている');
});
