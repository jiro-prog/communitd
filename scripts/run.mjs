// npm start のラッパー。ブリッジ本体を子プロセスで起動し、Discord からの
// restart (終了コード 42) のときだけ再起動する。
// クラッシュ (それ以外のコード) では再起動せずラッパーごと終了する —
// 暴走ループと二重ログインを構造的に防ぐため。
// 毎回 spawn し直すので、コードと .env は再起動のたびに読み直される。
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESTART_EXIT_CODE, shouldRestart } from '../src/restart.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'src', 'index.js');

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, ['--env-file=.env', ENTRY], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('error', (err) => {
    console.error(`[run] ブリッジを起動できません: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(typeof code === 'number' ? code : 0);
    }
    if (shouldRestart(code)) {
      console.log(`[run] 終了コード ${RESTART_EXIT_CODE} — ブリッジを再起動します`);
      start();
      return;
    }
    if (signal) {
      console.error(`[run] ブリッジが ${signal} で終了しました (再起動しません)`);
      process.exit(1);
    }
    process.exit(typeof code === 'number' ? code : 0);
  });
}

// Ctrl+C / kill は子へ伝えて自分も終わる (再起動しない)。
// 子側は SIGINT/SIGTERM で待機 job の placeholder を ⏹ に直してから終了する。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
