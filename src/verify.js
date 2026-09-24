// @ts-check
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detachOption, killTree, scrubEnv } from './proc.js';

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFY_OUTPUT_MAX_CHARS = 1024 * 1024;
export const VERIFY_DISPLAY_MAX_CHARS = 1900;
export const VERIFY_TAIL_LINES = 20;

/**
 * 作者が config.json に直接書いた検証コマンドを非同期実行する。
 *
 * shell: true は `npm test` のような shell 文字列をそのまま受けるために必要。
 * これは allowedTools の外にある任意コマンド実行経路なので、値の出所は作者管理の
 * config.json だけに限定し、エージェント出力や承認データから組み立てない。
 *
 * @param {object} p
 * @param {string} p.command 検証コマンド (shell 文字列)
 * @param {string} p.cwd
 * @param {number} [p.timeoutMs]
 * @param {number} [p.maxOutputChars]
 * @param {string[]} [p.scrubEnvKeys] 子へ渡さない環境変数
 * @param {{stopRequested?: boolean, abort?: () => void}|null} [p.handle] 停止の口 (撃たれたら走らせない・走っていれば止める)
 * @param {boolean} [p.detachGroup]
 * @param {typeof spawn} [p.spawnImpl]
 */
export function runVerify({
  command,
  cwd,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  maxOutputChars = VERIFY_OUTPUT_MAX_CHARS,
  scrubEnvKeys = [],
  handle,
  // **Stop hook から呼ぶときは false。** hook プロセスは claude の子なので、ここで
  // グループを分けると (POSIX の detached = setsid) ブリッジが claude のグループを
  // 撃っても `npm test` のツリーだけ生き残る。ブリッジ本体から呼ぶ経路 (job / orgapply)
  // だけが detach してよい (Opus2 指摘 2026-09-11)。
  // 代償として hook 側の timeout の killTree は直下の sh までしか殺せないが、その sh は
  // claude のグループに残るので**ブリッジからの停止では孫まで届く** — 総和では確実になる
  detachGroup = true,
  spawnImpl = spawn,
}) {
  if (handle?.stopRequested) {
    return Promise.resolve({
      ran: false,
      ok: false,
      aborted: true,
      command: String(command ?? ''),
      durationMs: 0,
      output: '',
      error: '停止指示により検証を中断',
    });
  }

  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(String(command ?? ''), {
        cwd,
        env: scrubEnv(process.env, scrubEnvKeys),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // win32 以外はプロセスグループを分ける。shell: true なので直下は sh で、
        // `npm test` が起こすテストランナーは孫。グループごとでないと届かない (src/proc.js)。
        // hook 経路では分けない — 上の detachGroup を見ること
        ...(detachGroup ? detachOption() : {}),
      });
    } catch (err) {
      resolvePromise(failedResult({ command, startedAt, error: `spawn failed: ${err.message}` }));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const append = (chunk) => {
      output += chunk;
      if (output.length > maxOutputChars) output = output.slice(-maxOutputChars);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const result = (extra = {}) => ({
      ran: true,
      ok: false,
      command: String(command ?? ''),
      durationMs: Date.now() - startedAt,
      output,
      ...extra,
    });

    if (handle) {
      handle.abort = () => {
        handle.stopRequested = true;
        if (!settled) {
          aborted = true;
          killTree(child);
        }
      };
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // close が来ない場合もキューを永久に掴まない。多重 resolve は settled で防ぐ。
      setTimeout(
        () => finish(result({ timedOut: true, error: `timeout after ${formatDuration(timeoutMs)}` })),
        8000,
      ).unref?.();
    }, timeoutMs);

    child.on('error', (err) => finish(result({ error: `spawn failed: ${err.message}` })));
    child.on('close', (code, signal) => {
      if (aborted) {
        finish(result({ aborted: true, error: '停止指示により検証を中断' }));
        return;
      }
      if (timedOut) {
        finish(result({ timedOut: true, error: `timeout after ${formatDuration(timeoutMs)}` }));
        return;
      }
      finish(result({ ok: code === 0, code, signal }));
    });
  });
}

function failedResult({ command, startedAt, error }) {
  return {
    ran: true,
    ok: false,
    command: String(command ?? ''),
    durationMs: Date.now() - startedAt,
    output: '',
    error,
  };
}

/** Discord へ載せる verify 結果。先頭の判定を残し、出力だけ末尾から切り詰める。 */
export function formatVerifyResult(
  result,
  { maxChars = VERIFY_DISPLAY_MAX_CHARS, maxLines = VERIFY_TAIL_LINES } = {},
) {
  const ok = result?.ok === true;
  const status = ok ? '✅ verify 成功' : '❌ verify 失敗';
  const handoff = ok ? '' : '\n⛔ verify NG のため、次の担当は呼び出していません';
  const exit = result?.timedOut
    ? 'timeout'
    : result?.aborted
      ? 'aborted'
      : Number.isInteger(result?.code)
        ? `exit ${result.code}`
        : '起動エラー';
  const command = sanitizeOutput(result?.command || '(コマンド不明)').slice(0, 500);
  const header = `${status} (${exit} / ${formatDuration(result?.durationMs)})${handoff}\n$ ${command}`;
  const raw = [result?.error, result?.output].filter(Boolean).join('\n').trim();
  const empty = '(出力なし)';
  const fenceOverhead = '\n```text\n\n```'.length;
  const room = Math.max(0, maxChars - header.length - fenceOverhead);
  const body = tailText(raw || empty, { maxLines, maxChars: room });
  return `${header}\n\`\`\`text\n${body}\n\`\`\``.slice(0, maxChars);
}

/** Stop hook からモデルへ返す理由。Discord 記法は使わず、修正に必要な末尾だけ渡す。 */
export function formatVerifyFailureReason(result, { maxChars = 1500, maxLines = VERIFY_TAIL_LINES } = {}) {
  const raw = [result?.error, result?.output].filter(Boolean).join('\n').trim() || '(出力なし)';
  const header = `verify が失敗しました (${verifyExit(result)})。失敗を直してから完了してください。\n`;
  return `${header}${tailText(raw, { maxLines, maxChars: Math.max(0, maxChars - header.length) })}`
    .slice(0, maxChars);
}

/** 改行を正規化し、末尾 N 行・最大文字数へ純粋に整形する。 */
export function tailText(text, { maxLines = VERIFY_TAIL_LINES, maxChars = VERIFY_DISPLAY_MAX_CHARS } = {}) {
  if (maxChars <= 0) return '';
  const normalized = sanitizeOutput(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd();
  let out = normalized.split('\n').slice(-Math.max(1, maxLines)).join('\n');
  if (out.length > maxChars) {
    if (maxChars === 1) return '…';
    out = `…${out.slice(-(maxChars - 1))}`;
  }
  return out;
}

function sanitizeOutput(text) {
  return String(text ?? '')
    // 制御文字を**狙って**落とす (テストランナーの出力をそのまま Discord へ流さない)。
    // no-control-regex はこの regex そのものを疑う規則なので、ここだけ外す
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replaceAll('```', "'''");
}

function verifyExit(result) {
  if (result?.timedOut) return `timeout / ${formatDuration(result.durationMs)}`;
  if (result?.aborted) return 'aborted';
  if (Number.isInteger(result?.code)) return `exit ${result.code}`;
  return '起動エラー';
}

function formatDuration(ms) {
  const n = Number(ms);
  return `${(Number.isFinite(n) && n > 0 ? n / 1000 : 0).toFixed(1)}s`;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

/** Stop hook の全試行を親プロセスへ渡す job 専用状態ファイル。 */
export function readVerifyState(path) {
  if (!path) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || !value.lastResult) return null;
    if (!isNonNegativeInteger(value.attempts) || !isNonNegativeInteger(value.blocksUsed)) return null;
    if (!isNonNegativeNumber(value.totalDurationMs)) return null;
    if (typeof value.lastResult !== 'object' || typeof value.lastResult.ok !== 'boolean') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Claude Code の Stop hook として 1 回実行する。
 * NG のうち maxRetries 回だけ block し、それ以降は最終 NG を状態へ残して終了する。
 */
export async function runVerifyHook(config, hookInput = {}, { runVerifyImpl = runVerify } = {}) {
  validateHookConfig(config);
  if (hookInput?.hook_event_name && hookInput.hook_event_name !== 'Stop') {
    throw new Error(`verify hook は Stop 専用です: ${hookInput.hook_event_name}`);
  }

  const previous = readVerifyState(config.stateFile) ?? {
    attempts: 0,
    blocksUsed: 0,
    totalDurationMs: 0,
  };
  const result = await runVerifyImpl({
    command: config.command,
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    // この関数は claude の子 (Stop hook) の中で走る。ここで setsid すると
    // ブリッジの killTree が claude のグループを撃っても検証のツリーだけ残る
    detachGroup: false,
  });
  const shouldBlock = !result.ok && previous.blocksUsed < config.maxRetries;
  const state = {
    attempts: previous.attempts + 1,
    blocksUsed: previous.blocksUsed + (shouldBlock ? 1 : 0),
    totalDurationMs: previous.totalDurationMs + result.durationMs,
    stopHookActive: hookInput?.stop_hook_active === true,
    lastResult: result,
  };
  writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  return shouldBlock
    ? { decision: 'block', reason: formatVerifyFailureReason(result) }
    : null;
}

function validateHookConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('verify hook config が不正です');
  if (typeof config.command !== 'string' || config.command.trim() === '') {
    throw new TypeError('verify hook command が未設定です');
  }
  if (typeof config.cwd !== 'string' || config.cwd === '') throw new TypeError('verify hook cwd が未設定です');
  if (typeof config.stateFile !== 'string' || config.stateFile === '') {
    throw new TypeError('verify hook stateFile が未設定です');
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3) {
    throw new TypeError('verify hook maxRetries は 0〜3 で指定します');
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TypeError('verify hook timeoutMs は正の整数で指定します');
  }
}

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function main() {
  const index = process.argv.indexOf('--hook');
  if (index < 0 || !process.argv[index + 1]) throw new Error('使い方: node verify.js --hook <config.json>');
  const config = JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
  const response = await runVerifyHook(config, await readStdin());
  if (response) process.stdout.write(JSON.stringify(response));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`verify hook internal error: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
