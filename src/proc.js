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
 * Windows の child.kill() は直下プロセスのみ terminate し、子が spawn した
 * bash/ツール群が孤児として走り続ける (実測確認済み)。taskkill /T でツリーごと殺す。
 */
export function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGKILL');
  }
}
