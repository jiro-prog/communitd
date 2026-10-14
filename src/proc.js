import { spawnSync } from 'node:child_process';

/**
 * 子プロセスへ渡す env から秘密 (Discord トークン等) を除いたコピーを返す。
 * acceptEdits + Bash 許可下で prompt injection されても env から抜けない。
 */
export function scrubEnv(baseEnv, keys = []) {
  const env = { ...baseEnv };
  for (const key of keys) delete env[key];
  return env;
}

/**
 * spawn へ混ぜる「プロセスグループを分ける」オプション。
 *
 * win32 以外では **これが無いと killTree が孫を殺せない**。detached を付けないと子は
 * ブリッジと同じプロセスグループに居るので、グループを指定して殺す (`-pid`) 手段が無く、
 * `child.kill()` で死ぬのは直下の 1 つだけ — claude / codex が起こした bash・node は
 * `/stop` やタイムアウトの後も走り続ける (GPT-6 Astra の外部レビュー 2026-09-11)。
 *
 * win32 は taskkill /T がツリーを辿るので不要。**付けると逆に新しいコンソールが開く**
 * 挙動があるので、Windows では何も足さない。
 *
 * Ctrl+C の伝播は失わない — ブリッジは SIGINT / SIGTERM を自分で受けて走行中の job を
 * abort する (`src/index.js` → `src/bridge/shutdown.js`) ので、端末のフォアグラウンド
 * グループ経由の伝播に依存していない。
 */
export function detachOption(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * 子プロセスをツリーごと殺す。
 *
 * Windows の child.kill() は直下プロセスのみ terminate し、子が spawn した
 * bash/ツール群が孤児として走り続ける (実測確認済み)。taskkill /T でツリーごと殺す。
 *
 * win32 以外は `detachOption` で分けたプロセスグループ全体へ SIGKILL を送る。
 * グループが既に消えている (ESRCH)・権限が無い (EPERM)・detached でない配置では
 * 例外になるので、その場合だけ従来どおり直下へ落とす。
 *
 * **直下が終了済みでもグループへ撃つ。** ここを `exitCode` で塞ぐと、`close` が来ないまま
 * タイムアウトした場合 — つまり**孫が stdout パイプを握ったまま生きている**、ツリー撃ちが
 * 最も要る場面 — でだけ発火し、その先の `child.kill()` は終了済みの子に何も送らないので
 * killTree が丸ごと no-op になる (Opus2 指摘 2026-09-11)。
 * pid 再利用は起きない: POSIX ではプロセスグループ ID として使われている pid は、その
 * グループが空になるまで新しいプロセスへ割り当てられない。孫が生きている限り `-pid` は
 * 必ずその孫のグループを指し、空なら ESRCH で下の直下撃ちへ落ちるだけ。
 *
 * platform / kill を注入できるのは**実プロセスを起こさずに分岐を試す**ため
 * (実プロセスでの確認は test/proc.test.js の win32 以外のテストが受け持つ)。
 */
export function killTree(child, { platform = process.platform, kill = posixKill } = {}) {
  if (platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  if (platform !== 'win32' && child.pid) {
    try {
      kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // グループごと殺せなかった。直下だけでも落とす (下へ抜ける)
    }
  }
  child.kill('SIGKILL');
}

/** process.kill を this 束縛なしで呼べる形にしておく (注入の既定値) */
function posixKill(pid, signal) {
  return process.kill(pid, signal);
}
