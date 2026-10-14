// npm start のラッパー。ブリッジ本体を子プロセスで起動し、Discord からの
// restart (終了コード 42) のときだけ再起動する。
// クラッシュ (それ以外のコード) では再起動せずラッパーごと終了する —
// 暴走ループと二重ログインを構造的に防ぐため。
// 毎回 spawn し直すので、コードと .env は再起動のたびに読み直される。
//
// `--log <path>` を渡したときだけ、画面に出る行と同じものをファイルへ追記する
// (端末を閉じると消える計測行を手元に残すため)。ローテーションは無い。
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESTART_EXIT_CODE,
  formatLogChunk,
  formatLogLine,
  parseRunArgs,
  shouldRestart,
} from '../src/restart.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'src', 'index.js');

const { logPath, error: argError } = parseRunArgs(process.argv.slice(2));
if (argError) {
  console.error(`[run] ${argError}`);
  process.exit(1);
}

// 控えのファイルは**ラッパーの寿命で 1 回だけ**開く。再起動しても同じ fd へ書き続けるので、
// /restart をまたいで 1 本のファイルに繋がる。
// 書き込みは同期 — process.exit() で終わる経路が複数あり、非同期の write だと末尾が落ちる。
let logFd = null;
if (logPath) {
  const file = resolve(ROOT, logPath);
  try {
    mkdirSync(dirname(file), { recursive: true });
    logFd = openSync(file, 'a');
  } catch (err) {
    // 頼まれた控えを黙って落とさない — 取れないなら起動させない
    console.error(`[run] 控えのファイルを開けません (${file}): ${err?.message ?? err}`);
    process.exit(1);
  }
}

let logBroken = false;
function writeLog(text) {
  if (logFd === null || logBroken || !text) return;
  try {
    writeSync(logFd, text);
  } catch (err) {
    logBroken = true;
    console.error(`[run] 控えに書けなくなりました (以後は画面だけ): ${err?.message ?? err}`);
  }
}

// ラッパー自身の [run] 行も控えに残す (再起動がいつ起きたかが読めないと計測が繋がらない)
function note(msg, { error = false } = {}) {
  if (error) console.error(msg);
  else console.log(msg);
  writeLog(formatLogLine(msg));
}

// 子の出力を画面へそのまま流しつつ、同じ内容を時刻付きで控える
function captureToLog(src, sink) {
  let pending = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    sink.write(chunk);
    const next = formatLogChunk(pending, chunk);
    pending = next.pending;
    writeLog(next.text);
  });
  src.on('end', () => {
    if (!pending) return;
    writeLog(formatLogLine(pending));
    pending = '';
  });
}

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, ['--env-file=.env', ENTRY], {
    cwd: ROOT,
    // 控えを取らないときは従来どおり inherit (子から見た環境を一切変えない)。
    // 取るときだけ stdout/stderr を pipe する — stdin は inherit のまま
    stdio: logFd === null ? 'inherit' : ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (logFd !== null) {
    captureToLog(child.stdout, process.stdout);
    captureToLog(child.stderr, process.stderr);
  }

  child.on('error', (err) => {
    note(`[run] ブリッジを起動できません: ${err.message}`, { error: true });
    process.exit(1);
  });

  // 'exit' ではなく 'close' — pipe した stdout/stderr を読み切ってから終了判定に入る
  // (終了直前の行が控えから落ちないため)。inherit のときは pipe が無いので
  // exit の直後に発火し、従来と同じタイミングになる
  child.on('close', (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(typeof code === 'number' ? code : 0);
    }
    if (shouldRestart(code)) {
      note(`[run] 終了コード ${RESTART_EXIT_CODE} — ブリッジを再起動します`);
      start();
      return;
    }
    if (signal) {
      note(`[run] ブリッジが ${signal} で終了しました (再起動しません)`, { error: true });
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
