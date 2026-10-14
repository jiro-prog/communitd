import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_CLI, cliCmdHint, cliCmdReason, resolveConfiguredCommand } from './clicmd.js';
import {
  PI_CONFIG_ENV, PI_REPORT_TOOL, PI_PERMISSION_MODES, piToolsFor, piTraceEntry,
} from './pi-policy.js';
import { detachOption, killTree, scrubEnv } from './proc.js';
import { appendTraceEntry } from './trace.js';

// pi ランタイム (docs/reference/pi-runtime.md)。pi は最小のコーディングエージェントで、
// 権限・hook・構造化出力を持たない代わりに拡張から全部に割り込める。
// その拡張が src/pi-extension.js で、job ごとの設定はこのファイルが一時ディレクトリへ書く。

export { PI_CLI };

/** pi が見つからないときの案内 (doctor と同じ文言を使う) */
export const PI_CMD_HINT = cliCmdHint(PI_CLI);

/**
 * pi の `--thinking` に渡せる値。**src 内でここだけが正本**で、`bots.<key>.effort` の検証
 * (src/config.js) もこの配列を見る。値域の正本は pi 自身 (`pi --help` の --thinking)
 */
export const PI_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** pi が読み込む拡張 (絶対パス) */
export const PI_EXTENSION_FILE = fileURLToPath(new URL('./pi-extension.js', import.meta.url));

/** 失敗の詳細として残す stdout / stderr の末尾 */
const DETAIL_CHARS = 1500;

/**
 * pi の起動引数 (コマンド本体は含まない)。
 *
 * - `--mode json`: イベントを JSONL で stdout へ出して終わる。プロンプトは stdin で渡す
 *   (Windows のコマンドラインは約 32k 字が上限で、role + transcript はそれを超える)
 * - `--no-session`: セッションを残さない (この版は resume を使わない)
 * - 拡張・スキル・テンプレート・テーマ・MCP は**この job の拡張だけ**に絞る。
 *   `--no-approve` はリポジトリの中の `.pi/` (プロジェクトの設定と拡張) を読まない —
 *   作業対象のリポジトリが拡張を置けば、それが pi のプロセスの中で動いてしまう
 * - AGENTS.md / CLAUDE.md は読ませる (claude の bot が CLAUDE.md を読むのと揃える)
 *
 * @returns {string[]}
 */
export function buildPiArgs({ model, effort = null, tools, rolePromptFile, imagePaths = [] }) {
  const args = [
    '--mode', 'json',
    '--no-session',
    '--no-extensions', '-e', PI_EXTENSION_FILE,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--thinking', effort);
  // 空 = 道具を 1 つも見せない (`--tools ""` は解釈が CLI 次第なので、明示の口を使う)
  if (tools.length > 0) args.push('--tools', tools.join(','));
  else args.push('--no-tools');
  args.push('--append-system-prompt', rolePromptFile);
  for (const p of imagePaths) args.push(`@${p}`);
  return args;
}

/**
 * pi の JSON イベントを 1 行ずつ畳む。成功・失敗の判定と計測の材料をここで集める。
 * 道具の実行が終わるたびに onToolEnd を呼ぶ (ツール軌跡の 1 行と進捗表示のため)。
 *
 * isBlocked は「拡張が止めた呼び出しか」。pi は止めた呼び出しにも失敗として実行の終わりを出す
 * (pi-agent-core の agent-loop) ので、数えるとツールの失敗が水増しになる — claude の軌跡も
 * 拒否された呼び出しは載せない (src/trace.js)
 */
export function createPiEventReader({ onToolEnd = null, isBlocked = null } = {}) {
  const state = {
    numTurns: 0,
    lastText: '',
    lastError: null,
    aborted: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageSeen: false,
    cost: 0,
    toolCalls: 0,
  };
  const pendingArgs = new Map();
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

  function onEvent(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'tool_execution_start' && typeof e.toolCallId === 'string') {
      pendingArgs.set(e.toolCallId, e.args ?? null);
      return;
    }
    if (e.type === 'tool_execution_end') {
      const args = pendingArgs.get(e.toolCallId) ?? null;
      pendingArgs.delete(e.toolCallId);
      // 拡張から呼んだ入れ子の呼び出しは数えない (モデルの呼び出しではない)
      if (e.parentToolCallId) return;
      if (typeof isBlocked === 'function' && e.isError === true) {
        let blocked = false;
        try { blocked = isBlocked(e.toolCallId) === true; } catch { /* 分からなければ数える */ }
        if (blocked) return;
      }
      if (e.toolName !== PI_REPORT_TOOL) state.toolCalls += 1;
      if (typeof onToolEnd === 'function') {
        try { onToolEnd({ toolName: e.toolName, args, isError: e.isError === true }); } catch { /* 記録の失敗で止めない */ }
      }
      return;
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const m = e.message;
      state.numTurns += 1;
      const u = m.usage;
      if (u && typeof u === 'object') {
        state.usageSeen = true;
        state.usage.input += num(u.input);
        state.usage.output += num(u.output);
        state.usage.cacheRead += num(u.cacheRead);
        state.usage.cacheWrite += num(u.cacheWrite);
        const c = Number(u.cost?.total);
        if (Number.isFinite(c) && c >= 0) state.cost += c;
      }
      const text = Array.isArray(m.content)
        ? m.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
        : '';
      // **最後の応答の本文だけ**を最終回答にする (空なら空)。前の応答の本文を持ち越すと、
      // 道具を呼ぶ前の独り言 (「まず a.js を読みます」) が最終回答として配送される
      state.lastText = text.trim();
      if (m.stopReason === 'error') state.lastError = String(m.errorMessage ?? 'モデルの応答がエラーで終わりました');
      else if (m.stopReason === 'aborted') state.aborted = true;
      else state.lastError = null;
    }
  }

  return { onEvent, state };
}

/** 一時ディレクトリを消す (失敗はログだけ。報告と設定しか入っていない) */
function removeDir(dir) {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (err) { console.error(`[pi] 一時ディレクトリを削除できません: ${dir} (${err.message})`); }
}

/**
 * 止められた呼び出しの記録 (1 行 1 件、拡張が書く)。壊れた行は落とす。
 * `toolCallId` は軌跡から外すための印で、返す形 (claude の `permission_denials`) には含めない
 */
function readDenials(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v.tool_name === 'string') out.push(v);
    } catch { /* 1 行だけ捨てる */ }
  }
  return out;
}

const withoutCallId = ({ toolCallId: _id, ...denial }) => denial;
/** 足踏みで止めた呼び出し (拡張が `stall: true` を付ける)。権限で止めたのではないので承認の候補にしない */
const isStall = (record) => record?.stall === true;

/**
 * pi を 1 回走らせる (runClaude / runCodex と同じ形で返す)。
 *
 * 権限は claude ランタイムと**同じ設定**で決まる — チャンネルの allowedTools と permissionMode、
 * 契約の touch 制限 (tools / disallowedTools)。照合は拡張 (src/pi-extension.js) が道具の
 * 呼び出しごとに行い、見せる道具の集合もここで絞る。OS の囲い (codex の sandbox) は無い。
 *
 * jsonSchema を渡すと、拡張が道具 `submit_report` (引数のスキーマ = jsonSchema) を登録し、
 * その引数を `structuredOutput` で返す。`result` は claude と同じくその JSON 文字列。
 *
 * verify を渡すと、拡張が終わる直前に verify を走らせて NG を同じ会話へ差し戻す
 * (回数と状態ファイルは src/verify.js の runVerifyHook — claude の Stop hook と同じもの)。
 *
 * 同じ呼び出しを続けてくり返した回は拡張が止める (足踏み)。その件数を `stallBlocks` で返す
 * (`permissionDenials` には入れない)。
 */
export function runPi({
  piCmd = null,
  resolveCmdImpl = null,
  cwd,
  model,
  effort = null,
  prompt,
  imagePaths = [],
  rolePromptFile,
  allowedTools = [],
  permissionMode = 'default',
  tools = null,
  disallowedTools = [],
  addDirs = [],
  jsonSchema = null,
  // {command, cwd, stateFile, maxRetries, timeoutMs} — src/verify.js の hook config と同じ形
  verify = null,
  // 道具の実行 1 回ごとに 1 行追記する (src/trace.js の形)。進捗表示と計測が読む
  traceFile = null,
  timeoutMs = 3600000,
  scrubEnvKeys = [],
  handle,
  onSpawn = null,
  spawnImpl = spawn,
  mkdtempImpl = mkdtempSync,
}) {
  if (handle?.stopRequested) {
    return Promise.resolve({ ok: false, aborted: true, error: '停止指示により中断' });
  }
  if (!PI_PERMISSION_MODES.includes(permissionMode)) {
    return Promise.resolve({ ok: false, error: `permissionMode "${permissionMode}" は pi ランタイムで扱えません` });
  }
  // `--append-system-prompt` は**在るファイルなら中身、無ければ文字列そのもの**を指示文にする
  // (pi 1.1.0 の resource-loader)。消えたファイルを渡すと、パスの文字列が役割文の代わりになる
  if (typeof rolePromptFile !== 'string' || !existsSync(rolePromptFile)) {
    return Promise.resolve({ ok: false, error: `役割文のスナップショットがありません: ${rolePromptFile}` });
  }
  const cmd = resolveCmdImpl ? resolveCmdImpl(piCmd) : resolveConfiguredCommand(piCmd, PI_CLI);
  if (!cmd) {
    return Promise.resolve({ ok: false, error: `pi を起動できません (${cliCmdReason(piCmd, PI_CLI)}) — ${PI_CMD_HINT}` });
  }

  let workDir;
  try {
    workDir = mkdtempImpl(join(tmpdir(), 'communitd-pi-'));
  } catch (err) {
    return Promise.resolve({ ok: false, error: `一時ディレクトリを作れないため起動できません (${err.message})` });
  }
  const configFile = join(workDir, 'config.json');
  const reportFile = join(workDir, 'report.json');
  const denialsFile = join(workDir, 'denials.jsonl');
  const report = jsonSchema ? { schema: jsonSchema, file: reportFile } : null;
  const piTools = piToolsFor({ allowedTools, permissionMode, tools, disallowedTools, report: report !== null });
  try {
    writeFileSync(configFile, `${JSON.stringify({
      policy: { cwd, addDirs, permissionMode, allowedTools, tools, disallowedTools },
      report,
      verify,
      denialsFile,
    }, null, 2)}\n`, 'utf8');
  } catch (err) {
    removeDir(workDir);
    return Promise.resolve({ ok: false, error: `拡張の設定を書き出せないため起動できません (${err.message})` });
  }

  const [bin, ...binArgs] = cmd;
  const args = [...binArgs, ...buildPiArgs({ model, effort, tools: piTools, rolePromptFile, imagePaths })];
  const env = scrubEnv(process.env, scrubEnvKeys);
  env[PI_CONFIG_ENV] = configFile;
  // 利用状況の送信と、起動時のネットワーク処理 (版の確認・モデル一覧の更新) を止める
  env.PI_TELEMETRY = '0';
  env.PI_OFFLINE = '1';

  let child;
  try {
    child = spawnImpl(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...detachOption(),
    });
  } catch (err) {
    removeDir(workDir);
    return Promise.resolve({
      ok: false,
      error: `spawn failed: ${err.message}` + (['ENOENT', 'EINVAL'].includes(err.code) ? ` — ${PI_CMD_HINT}` : ''),
    });
  }

  const reader = createPiEventReader({
    onToolEnd: ({ toolName, args: toolArgs, isError }) => {
      const entry = piTraceEntry(toolName, toolArgs, isError);
      if (entry && traceFile) appendTraceEntry(traceFile, { ...entry, at: Date.now() });
    },
    // 拡張は止める前に記録を書く (pi が実行の終わりを出すより先) ので、ここで読めば間に合う
    isBlocked: (toolCallId) => typeof toolCallId === 'string'
      && readDenials(denialsFile).some((d) => d.toolCallId === toolCallId),
  });

  return new Promise((resolvePromise) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    if (typeof onSpawn === 'function') {
      try { onSpawn({ pid: child.pid ?? null, at: Date.now(), runtime: 'pi' }); } catch { /* 記録の失敗で起動は止めない */ }
    }

    let buffer = '';
    let stdoutTail = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    if (handle) {
      handle.abort = () => {
        handle.stopRequested = true;
        if (!settled) {
          aborted = true;
          killTree(child);
        }
      };
    }

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeDir(workDir);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(
        () => finish({ ok: false, error: `timeout after ${Math.round(timeoutMs / 60000)} min` }),
        8000,
      ).unref?.();
    }, timeoutMs);

    const consume = (line) => {
      if (line.trim() === '') return;
      try { reader.onEvent(JSON.parse(line)); } catch { /* JSON でない行 (診断) は読み飛ばす */ }
    };
    child.stdout.on('data', (d) => {
      buffer += d;
      stdoutTail = (stdoutTail + d).slice(-DETAIL_CHARS);
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-DETAIL_CHARS * 4); });
    child.on('error', (err) => finish({
      ok: false,
      error: `spawn failed: ${err.message}` + (['ENOENT', 'EINVAL'].includes(err.code) ? ` — ${PI_CMD_HINT}` : ''),
    }));
    child.on('close', (code) => {
      consume(buffer);
      buffer = '';
      if (aborted) {
        finish({ ok: false, aborted: true, error: '停止指示により中断' });
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          error: `timeout after ${Math.round(timeoutMs / 60000)} min`,
          detail: (stderr || stdoutTail).slice(-DETAIL_CHARS),
        });
        return;
      }
      const s = reader.state;
      const usage = s.usageSeen
        ? {
            inputTokens: s.usage.input,
            cacheReadTokens: s.usage.cacheRead,
            cacheWriteTokens: s.usage.cacheWrite,
            outputTokens: s.usage.output,
          }
        : null;
      // 報告は**拡張が検証を通した引数**だけ (pi がスキーマで検査してから execute が呼ばれる)
      let structuredOutput = null;
      if (report) {
        try { structuredOutput = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { /* 出さずに終えた */ }
      }
      const blocked = readDenials(denialsFile);
      const permissionDenials = blocked.filter((d) => !isStall(d)).map(withoutCallId);
      const stallBlocks = blocked.filter(isStall).length;
      const result = structuredOutput ? JSON.stringify(structuredOutput) : s.lastText;
      const common = {
        usage, costUsd: s.cost, numTurns: s.numTurns, toolCalls: s.toolCalls, permissionDenials, stallBlocks, code,
      };
      if (code !== 0 || s.lastError || s.aborted || result === '') {
        finish({
          ok: false,
          ...common,
          error: s.lastError
            ? `pi: ${s.lastError.slice(0, 200)}`
            : `pi exit ${code}${result === '' ? ' (no output)' : ''}`,
          detail: (stderr || stdoutTail).slice(-DETAIL_CHARS),
        });
        return;
      }
      finish({ ok: true, ...common, result, structuredOutput });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
