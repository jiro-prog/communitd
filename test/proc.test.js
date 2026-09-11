import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { detachOption, killTree, scrubEnv } from '../src/proc.js';

test('指定キーを子プロセス env から除去する', () => {
  const base = { PATH: '/usr/bin', FABLE_DISCORD_TOKEN: 'secret', OPUS_DISCORD_TOKEN: 'secret2' };
  const env = scrubEnv(base, ['FABLE_DISCORD_TOKEN', 'OPUS_DISCORD_TOKEN']);
  assert.equal(env.PATH, '/usr/bin');
  assert.ok(!('FABLE_DISCORD_TOKEN' in env));
  assert.ok(!('OPUS_DISCORD_TOKEN' in env));
});

test('元の env を書き換えない (親プロセスのトークンは残る)', () => {
  const base = { FABLE_DISCORD_TOKEN: 'secret' };
  scrubEnv(base, ['FABLE_DISCORD_TOKEN']);
  assert.equal(base.FABLE_DISCORD_TOKEN, 'secret');
});

test('存在しないキー・空リストでも落ちない', () => {
  assert.deepEqual(scrubEnv({ A: '1' }, ['NOPE']), { A: '1' });
  assert.deepEqual(scrubEnv({ A: '1' }, []), { A: '1' });
  assert.deepEqual(scrubEnv({ A: '1' }), { A: '1' });
});

test('process.env をそのまま渡しても親の env は無傷', () => {
  process.env.COMMUNITD_TEST_TOKEN = 'secret';
  try {
    const env = scrubEnv(process.env, ['COMMUNITD_TEST_TOKEN']);
    assert.ok(!('COMMUNITD_TEST_TOKEN' in env));
    assert.equal(process.env.COMMUNITD_TEST_TOKEN, 'secret');
  } finally {
    delete process.env.COMMUNITD_TEST_TOKEN;
  }
});

// ---- 停止処理 (killTree / detachOption) ----
//
// win32 は taskkill /T がツリーを辿るので従来どおり。それ以外は **プロセスグループ**が
// 効かせどころで、spawn 側の detached と killTree の -pid は片方だけでは意味が無い。
// 分岐の形は注入 (platform / kill) で、実際に孫が死ぬかは実プロセスで確かめる。

const isWindows = process.platform === 'win32';

test('detachOption は win32 でだけ何も足さない', () => {
  assert.deepEqual(detachOption('win32'), {});
  assert.deepEqual(detachOption('linux'), { detached: true });
  assert.deepEqual(detachOption('darwin'), { detached: true });
});

/** kill の呼びを数えるだけの偽 child (実プロセスを起こさずに分岐を試す) */
function fakeChild(pid) {
  const killed = [];
  return { pid, killed, kill: (signal) => killed.push(signal ?? null) };
}

test('win32 以外: killTree はプロセスグループ (-pid) へ SIGKILL を撃つ', () => {
  const child = fakeChild(4242);
  const sent = [];
  killTree(child, { platform: 'linux', kill: (pid, signal) => sent.push([pid, signal]) });
  assert.deepEqual(sent, [[-4242, 'SIGKILL']]);
  assert.deepEqual(child.killed, [], 'グループごと殺せたのに直下へも撃っている');
});

test('win32 以外: グループへの SIGKILL が投げたら child.kill へ落ちる', () => {
  // グループが既に消えている (ESRCH)・detached でない配置でここへ来る。
  // 直下だけでも落とせないと、停止したはずの job が走り続ける
  const child = fakeChild(4242);
  killTree(child, {
    platform: 'linux',
    kill: () => { const err = new Error('kill ESRCH'); err.code = 'ESRCH'; throw err; },
  });
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('win32 以外: pid が無ければ従来どおり直下へ SIGKILL', () => {
  const child = fakeChild(undefined);
  const sent = [];
  killTree(child, { platform: 'linux', kill: (pid, signal) => sent.push([pid, signal]) });
  assert.deepEqual(sent, [], 'pid が無いのにグループへ撃っている');
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('win32 で pid が取れないときの経路は変えていない (直下へ SIGKILL)', () => {
  const child = fakeChild(null);
  killTree(child, { platform: 'win32' });
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('win32 以外: 直下が終了済みでもグループへ撃つ (孫が残っている場面を取りこぼさない)', () => {
  // **exitCode で塞がないこと。** close が来ないままタイムアウトする = 孫が stdout パイプを
  // 握ったまま生きている場面でだけ発火し、その先の child.kill は終了済みの子に何も送らないので
  // killTree が丸ごと no-op になる。pid 再利用は起きない — POSIX ではプロセスグループ ID として
  // 使われている pid は、そのグループが空になるまで別プロセスへ割り当てられない (Opus2 指摘)
  for (const exited of [{ exitCode: 0 }, { exitCode: null, signalCode: 'SIGKILL' }]) {
    const child = { ...fakeChild(4242), ...exited };
    const sent = [];
    killTree(child, { platform: 'linux', kill: (pid, signal) => sent.push([pid, signal]) });
    assert.deepEqual(sent, [[-4242, 'SIGKILL']], `終了済み (${JSON.stringify(exited)}) を素通りしている`);
    assert.deepEqual(child.killed, [], 'グループごと殺せたのに直下へも撃っている');
  }
});

test(
  'win32 以外: killTree は孫プロセスまで止める (実プロセス)',
  { skip: isWindows && 'win32 は taskkill /T の経路 — この分岐は通らない', timeout: 60_000 },
  async () => {
    // 直下は sh、その sh が起こす sleep が「claude が起こした bash」にあたる孫。
    // detached が無い / グループへ撃たない実装では sh だけ死に、sleep は 120 秒生き残る
    const child = spawn('sh', ['-c', 'sleep 120 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      ...detachOption(),
    });
    // spawn 自体の失敗を uncaught にしない (listener が無いと 'error' が投げる)
    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });

    let grandchild = 0;
    try {
      grandchild = Number(await firstLine(child.stdout).catch((err) => {
        throw spawnError ? new Error(`sh を起こせない: ${spawnError.message}`) : err;
      }));
      assert.ok(Number.isInteger(grandchild) && grandchild > 0, `孫の pid を読めない: ${grandchild}`);
      assert.ok(isAlive(grandchild), '孫がそもそも起きていない (テストの前提が崩れている)');

      // **`close` ではなく `exit` を待つ。** 孫は sh の stdout パイプを握ったままなので、
      // 孫を殺し損ねた実装では `close` が来ず、アサーションの文言ではなくテストの
      // タイムアウトになる (後始末の finally も走らない。Opus2 指摘)
      const exited = once(child, 'exit');
      killTree(child);
      await exited;

      // SIGKILL は即座に届くが、孤児になった孫が zombie から回収されるまでは pid が残る。
      // 余裕をもって待ち、消えたことを ESRCH で確かめる
      assert.ok(await waitGone(grandchild, 20_000), `孫 ${grandchild} が killTree 後も生きている`);
    } finally {
      for (const pid of [grandchild, child.pid]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* 既に居ない */ } }
      }
      // 孫が掴んでいたパイプを手放す (失敗時に開いたままハンドルが残らないように)。
      // **`?.` で見る** — spawn に失敗した経路では stdout が null で、本来の失敗
      // (「sh を起こせない」) が TypeError にすり替わる (Opus2 指摘)
      child.stdout?.destroy();
    }
  },
);

/** シグナル 0 は「送らずに存在だけ確かめる」。zombie もここでは「居る」側 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(25);
  }
  return !isAlive(pid);
}

/** stdout の最初の 1 行 (孫の pid) を待つ。改行が来ないまま閉じたら失敗として扱う */
function firstLine(stream) {
  return new Promise((resolveLine, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', reject);
    };
    const onData = (chunk) => {
      buf += chunk;
      const at = buf.indexOf('\n');
      if (at < 0) return;
      cleanup();
      resolveLine(buf.slice(0, at).trim());
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`孫の pid が来ないまま stdout が閉じた: ${JSON.stringify(buf)}`));
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', reject);
  });
}
