// 子プロセスの生存確認 (前プロセスの子が生きていないことを確認できるまで、同じタスクを
// 起こさない)。
//
// **pid だけでは同一性を決めない。** pid は再利用されるので、「その pid のプロセスが居る」
// だけでは前プロセスの claude が生きているのか、無関係な別プロセスなのか分からない。
// 実行記録に残した起動時刻と、いま居るプロセスの起動時刻を突き合わせ、
// 名前 (claude / codex) も見る。判定は 3 値 — `alive` / `gone` / `unknown`。
// **unknown は gone ではない**: 確かめられなかったときは「起こさない」側へ倒す。
//
// OS コマンドの実行は注入で受ける (テストは出力の文字列だけを渡す)。

import { execFile } from 'node:child_process';
import { msOfTime } from './time.js';

/** 起動時刻の揺れとして許す幅。CIM の CreationDate と Node の Date.now() は同じ時計でも ms 単位でずれる */
export const SPAWN_TIME_TOLERANCE_MS = 10 * 1000;

/** 判定の 3 値 */
export const LIVENESS = Object.freeze(['alive', 'gone', 'unknown']);

/**
 * pid のプロセスを OS に聞く。
 * @param {number} pid
 * @param {{platform?: string, run?: (file: string, args: string[]) => Promise<string>}} deps
 * @returns {Promise<{alive: boolean, createdAt: number|null, name: string|null, command: string|null, error: string|null}>}
 *   alive=false は「その pid のプロセスが見つからない」。error が入っていたら聞けなかった
 */
export async function inspectProcess(pid, { platform = process.platform, run = runCommand } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { alive: false, createdAt: null, name: null, command: null, error: 'pid が不正' };
  }
  try {
    if (platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { `
        + `[pscustomobject]@{ pid = $_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o'); `
        + `name = $_.Name; cmd = $_.CommandLine } } | ConvertTo-Json -Compress`;
      const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      return parseWindowsProcess(out);
    }
    const out = await run('ps', ['-o', 'lstart=,comm=,args=', '-p', String(pid)]);
    return parseUnixProcess(out);
  } catch (err) {
    // `ps -p` は居ないと exit 1 で終わる。それは「見つからない」であって「聞けなかった」ではない
    const exitCode = Number.isInteger(err?.exitCode)
      ? err.exitCode
      : Number.parseInt(/exited with code (\d+)/i.exec(String(err?.message ?? ''))?.[1] ?? '', 10);
    if (platform !== 'win32' && exitCode === 1) {
      return { alive: false, createdAt: null, name: null, command: null, error: null };
    }
    return {
      alive: false, createdAt: null, name: null, command: null,
      error: String(err?.message ?? err),
    };
  }
}

/** PowerShell (ConvertTo-Json) の出力 → 1 件。空なら居ない */
export function parseWindowsProcess(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { alive: false, createdAt: null, name: null, command: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { alive: false, createdAt: null, name: null, command: null, error: `出力を読めません (${err.message})` };
  }
  const one = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!one || typeof one !== 'object') {
    return { alive: false, createdAt: null, name: null, command: null, error: null };
  }
  const createdAt = msOfTime(one.created);
  return {
    alive: true,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    name: one.name === null || one.name === undefined ? null : String(one.name),
    command: one.cmd === null || one.cmd === undefined ? null : String(one.cmd),
    error: null,
  };
}

/** `ps -o lstart=,comm=,args=` の 1 行 → 1 件。空なら居ない */
export function parseUnixProcess(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (!line) return { alive: false, createdAt: null, name: null, command: null, error: null };
  // lstart は "Fri Sep  5 16:07:51 2026" の 5 語。続く 1 語が comm、残りが args
  const words = line.split(/\s+/);
  const createdAt = Date.parse(words.slice(0, 5).join(' '));
  return {
    alive: true,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    name: words[5] ?? null,
    command: words.slice(6).join(' ') || null,
    error: null,
  };
}

/**
 * 記録した子プロセスがいまも生きているか (純粋)。
 *
 * - 居ない → `gone`
 * - 居て、起動時刻が記録と一致し、名前もランタイムと合う → `alive`
 * - 居るが起動時刻が合わない (pid の再利用) → `gone`
 * - 居るが起動時刻を読めない・聞けなかった・記録に pid が無い → `unknown` (**gone とは言わない**)
 *
 * @param {{pid?: number|null, at?: string|number|null, runtime?: string|null}|null} spawn 実行記録の spawn 欄
 * @param {{alive: boolean, createdAt: number|null, name: string|null, command: string|null, error: string|null}} inspected
 * @returns {'alive'|'gone'|'unknown'}
 */
export function judgeLiveness(spawn, inspected, { toleranceMs = SPAWN_TIME_TOLERANCE_MS } = {}) {
  if (!spawn || !Number.isSafeInteger(spawn.pid) || spawn.pid <= 0) return 'unknown';
  if (!inspected || inspected.error) return 'unknown';
  if (!inspected.alive) return 'gone';
  const recordedAt = msOfTime(spawn.at);
  if (!Number.isFinite(recordedAt) || inspected.createdAt === null) return 'unknown';
  if (Math.abs(inspected.createdAt - recordedAt) > toleranceMs) return 'gone'; // pid の再利用
  const runtime = String(spawn.runtime ?? '').toLowerCase();
  const label = `${inspected.name ?? ''} ${inspected.command ?? ''}`.toLowerCase();
  if (runtime && label.trim() !== '' && !label.includes(runtime)) return 'gone';
  return 'alive';
}

/** execFile を Promise に (stdout だけ返す)。失敗は message に exit code を含めて投げる */
function runCommand(file, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const wrapped = new Error(`${file} exited with code ${err.code ?? '?'}: ${String(err.message).slice(0, 200)}`);
        wrapped.exitCode = Number.isInteger(err.code) ? err.code : null;
        reject(wrapped);
        return;
      }
      resolvePromise(String(stdout ?? ''));
    });
  });
}
