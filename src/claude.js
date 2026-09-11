import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CLAUDE_CLI, cliCmdHint, cliCmdReason, resolveCliCommand, resolveConfiguredCommand } from './clicmd.js';
import { detachOption, killTree, scrubEnv } from './proc.js';

// claude CLI の在り処 (`CLAUDE_CLI`) は src/clicmd.js が正本。ネイティブ導入なら
// PATH の `claude.exe`、npm 版なら `.cmd` シムが起動する実体を辿る (Windows で要る)
export { CLAUDE_CLI };

/** claude が見つからないときの案内 (doctor と同じ文言を使う) */
export const CLAUDE_BIN_HINT = cliCmdHint(CLAUDE_CLI);

/**
 * claude CLI が `--effort` に受け付ける値。**src 内でここだけが正本**で、
 * `bots.<key>.effort` の検証 (src/config.js) もこの配列を見る。
 *
 * 許容値の正本は claude CLI の --help (二重管理)。CLI 側が値を変えてもここは追随せず、
 * 乖離は無症状になる — 不正値でも CLI は stderr へ警告を出して既定 effort へ落ちるだけで、
 * ブリッジは成功時の stderr を捨てる (実測 2026-08-05)。変更時は両方を確認すること。
 *
 * codex 側の値域は別 (`CODEX_EFFORTS` — `none` / `minimal` がある)。
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * spawn できる形の claude コマンドへ解決する (実体は src/clicmd.js)。
 * @param {{platform?: string, env?: object, exists?: (p: string) => boolean, nodeBin?: string}} deps
 * @returns {string[]|null}
 */
export function resolveClaudeCommand(deps = {}) {
  return resolveCliCommand({ ...CLAUDE_CLI, ...deps });
}

/**
 * ローカルの claude CLI をヘッドレス実行する。
 * プロンプトは stdin 渡し (Windows の引数クォート問題と injection を避ける)。
 * 認証はローカルの claude login (サブスク) をそのまま継承する。
 */
export function runClaude({
  // 文字列 1 語でも `["node", "…/cli.js"]` の配列でも書ける。1 語は絶対パスでない限り
  // spawn の直前に PATH から引き直す (Windows の .cmd シム対策 — src/clicmd.js)
  claudeBin = 'claude',
  // 解決をテストから固定するための差し替え口 (実機の PATH に判定を委ねない)
  resolveCmdImpl = null,
  cwd,
  model,
  effort,
  prompt,
  images = [],
  rolePromptFile,
  settingsFile,
  sessionId,
  resume = false,
  permissionMode = 'default',
  allowedTools = [],
  // T6: 契約の touch 制限で使う絞り込み。**どれも「狭める」向きにしか渡さない**
  // (組み込みツール自体の限定 / 明示的な拒否 / MCP の遮断)
  tools = null,
  disallowedTools = [],
  strictMcp = false,
  settingSources = null,
  jsonSchema = null,
  addDirs = [],
  timeoutMs = 3600000,
  maxStdoutBytes = 64 * 1024 * 1024,
  scrubEnvKeys = [],
  handle,
  // 子プロセスが立った直後に pid と時刻を知らせる (実行記録 — src/jobruns.js)。
  // 「モデルが起動した = ここから先は副作用がありうる」の境目を記録するためだけの口で、
  // 起動そのものには関与しない。省略可・throw しても起動は続ける
  onSpawn = null,
  // 組み立てた引数をテストから検査するための差し替え口 (src/verify.js と同じ流儀)。
  // 権限に関わる引数が増えたので、「契約が無い job では 1 つも増えない」を固定できる形にする
  spawnImpl = spawn,
}) {
  // spawn 前に stop が来ていたら起動せず中断 (空振り窓の封鎖)
  if (handle?.stopRequested) {
    return Promise.resolve({
      ok: false,
      aborted: true,
      sessionId: sessionId ?? null,
      error: '停止指示により中断',
    });
  }

  const sid = sessionId ?? randomUUID();
  // 画像を渡す唯一の口が stream-json 入力で、これは stream-json 出力 + --verbose を
  // 強制する (実測: どちらか欠けると即エラー終了)。出力が全イベント列になり stdout が
  // 膨らむので、画像がある job だけ切り替える (sol 裁定 2026-07-31)。
  // 最終行は従来の json 出力と同形の result イベントなので parseResultJson は共通。
  const streamJson = images.length > 0;
  const args = [
    '-p',
    ...(streamJson
      ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
      : ['--output-format', 'json']),
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--permission-mode', permissionMode,
    // 動的セクション (cwd / env / memory paths / git status) を system prompt から
    // 最初の user メッセージへ移す。**全 job に常時付ける。**
    //
    // これらは system prompt の末尾にあり、job がファイルを触ると次の job で中身が変わる。
    // prompt cache は前方一致なので、そこが変わると**その後ろの会話履歴が丸ごと**
    // 作り直しになる — 長寿命セッションほど 1 回の損失が育つ (実測 2026-08-04:
    // job 境界 33 回中 13 回で 250〜445k の cacheWrite。TTL 切れでは説明できない —
    // 189 分空いてヒット / 5 分でミスが混在する)。
    //
    // `--system-prompt` で既定を置き換えると無視されるが、ここは
    // `--append-system-prompt-file` (既定への追記) なので効く。resume・構造化出力との
    // 併用も実機で確認済み (2026-08-04)
    '--exclude-dynamic-system-prompt-sections',
    resume ? '--resume' : '--session-id', sid,
  ];
  if (rolePromptFile) args.push('--append-system-prompt-file', rolePromptFile);
  if (settingsFile) args.push('--settings', settingsFile);
  // 最終出力をスキーマへ拘束する。結果 JSON の structured_output にパース済みで入る
  // (T0 §4.1)。**result はそのスキーマの JSON 文字列になる**ので、人間向けの散文は
  // スキーマ側の `本文` フィールドで受ける (src/contract.js)
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  // 外部 settings (user / project / local) を読み込ませない。
  // **`--settings` で渡す job 専用の hooks は別枠なので残る** (実測 2026-08-03)。
  // これが無いと、作者の settings に `permissions.allow: ["Edit"]` を 1 行足すだけで
  // touch 制限が破れる (実測: 破れた。管理者ポリシーだけは仕様上どのみち残る)
  if (typeof settingSources === 'string') args.push('--setting-sources', settingSources);
  // 使える組み込みツール自体を絞る。**--allowedTools より手前の層**で、
  // ここに無いツールはそもそも呼べない (touch 制限の強制に要る — 実測 2026-08-02)。
  // **空配列は「1 つも使わせない」という指定**なので省略しない (null だけが無指定 —
  // 省略すると絞ったつもりで全ツールが使える。実測: `--tools ""` は全ツール無効になる)
  if (Array.isArray(tools)) args.push('--tools', tools.join(','));
  if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);
  // Agent / Task は --allowedTools に書かなくても呼べる (T0 §6c) ので、
  // 止めるには明示的な拒否が要る
  if (disallowedTools.length > 0) args.push('--disallowedTools', ...disallowedTools);
  // MCP サーバを 1 つも読まない (書けないと分かったモデルが MCP へ迂回するのを塞ぐ)
  if (strictMcp) args.push('--strict-mcp-config');
  // 参照用に開く追加ディレクトリ (config の channels.<name>.claudeAddDirs)。
  // --add-dir は read/write 両方を開ける口で、読取専用にはできない (src/config.js)
  if (addDirs.length > 0) args.push('--add-dir', ...addDirs);

  // claude 子プロセスに Discord トークン等の秘密を渡さない
  const env = scrubEnv(process.env, scrubEnvKeys);

  // 引数を組み立て終えてから解決する。**doctor と同じ関数を通す** — 別々に解決すると
  // 「doctor は緑なのに全 job が起動できない」配置ができる (Opus2 指摘 2026-09-10)
  const cmd = resolveCmdImpl ? resolveCmdImpl(claudeBin) : resolveConfiguredCommand(claudeBin, CLAUDE_CLI);
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      sessionId: sid,
      error: `claude を起動できません (${cliCmdReason(claudeBin, CLAUDE_CLI)}) — ${CLAUDE_BIN_HINT}`,
    });
  }
  const [bin, ...binArgs] = cmd;

  return new Promise((resolvePromise) => {
    const child = spawnImpl(bin, [...binArgs, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // win32 以外はプロセスグループを分ける。これが無いと killTree が
      // claude の起こした孫 (bash / node) を殺せない (src/proc.js)
      ...detachOption(),
    });
    // chunk 境界のマルチバイト文字を StringDecoder に持ち越させる
    // (Buffer += だと 64KiB 境界で日本語が U+FFFD 化する)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // pid が取れないときも知らせる (spawn 失敗は error イベントで別に報告される)
    if (typeof onSpawn === 'function') {
      try { onSpawn({ pid: child.pid ?? null, at: Date.now(), runtime: 'claude' }); } catch { /* 記録の失敗で起動は止めない */ }
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflowed = false;

    // 即時停止 (Discord の stop コマンド): 呼び出し側が handle.abort() で
    // プロセスツリーごと中断できる。settled 後の stale abort は flag のみ立てる
    // (次の runClaude/runCodex の入口チェックが拾う。死に pid への taskkill も防ぐ)
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
      resolvePromise(value);
    };

    const timeoutResult = () => ({
      ok: false,
      sessionId: sid,
      error: `timeout after ${Math.round(timeoutMs / 60000)} min`,
      detail: (stderr || stdout).slice(-1500),
    });

    const overflowResult = () => ({
      ok: false,
      sessionId: sid,
      error: `出力が上限 ${formatBytes(maxStdoutBytes)} を超えたため中断`,
      detail: stdout.slice(-1500),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // close が来ないケースの保険。settled ガードがあるので多重 resolve はしない
      setTimeout(() => finish(timeoutResult()), 8000).unref?.();
    }, timeoutMs);

    // stdout は結果 JSON を取り出すため全部持つ必要があるが、無制限に貯めると
    // 暴走した job でブリッジごとメモリを失う。上限を超えたら子ごと止める
    child.stdout.on('data', (d) => {
      if (overflowed) return;
      stdout += d;
      if (stdout.length > maxStdoutBytes) {
        overflowed = true;
        killTree(child);
        setTimeout(() => finish(overflowResult()), 8000).unref?.();
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({
      ok: false,
      sessionId: sid,
      // 実行ファイルが見つからない / 直接起動できない (Windows の .cmd シム) の 2 つは
      // 生の errno だけでは原因が分からないので、設定の直し方を添える
      error: `spawn failed: ${err.message}`
        + (['ENOENT', 'EINVAL'].includes(err.code) ? ` — ${CLAUDE_BIN_HINT}` : ''),
    }));
    child.on('close', (code) => {
      if (aborted) {
        finish({ ok: false, aborted: true, sessionId: sid, error: '停止指示により中断' });
        return;
      }
      if (overflowed) {
        finish(overflowResult());
        return;
      }
      if (timedOut) {
        // tree-kill 完了後にキューへ制御を返す (次 job との並走を防ぐ)
        finish(timeoutResult());
        return;
      }
      const json = parseResultJson(stdout);
      if (!json) {
        finish({
          ok: false,
          sessionId: sid,
          code,
          error: `no JSON result (exit ${code})`,
          detail: (stderr || stdout).slice(-1500),
        });
        return;
      }
      finish({
        ok: !json.is_error,
        sessionId: json.session_id ?? sid,
        result: json.result ?? '',
        // --json-schema を渡したときだけ入る (パース済みのオブジェクト — T0 §4.1)。
        // stream-json 経路でも同じキーに入る (T0 §4.3) ので分岐は要らない
        structuredOutput: json.structured_output ?? null,
        costUsd: json.total_cost_usd,
        numTurns: json.num_turns,
        // トークンの実消費 (計測ログ用)。取れなければ null で、呼び出し側は行から落とす
        usage: normalizeUsage(json.usage),
        permissionDenials: json.permission_denials ?? [],
        code,
        detail: json.is_error ? (stderr || '').slice(-1500) : undefined,
      });
    });

    child.stdin.on('error', () => {}); // 起動失敗時の EPIPE を握りつぶす (error イベント側で報告される)
    // stream-json のときだけ JSON 1 行。画像ブロックを先に置き、指示文を最後に置く
    // (画像→指示の順が「この画像について」という読み方になる)
    child.stdin.write(streamJson ? `${JSON.stringify(userMessage(prompt, images))}\n` : prompt);
    child.stdin.end();
  });
}

/**
 * result JSON の usage を計測用に正規化する。
 *
 * 実形は実機で確認した (2026-08-04 / CLI 2.1.x): `usage` に `input_tokens` /
 * `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` が並ぶ
 * (他に `iterations` などが付くが、job 単位の合計はこの 4 つで足りる)。
 * json 経路・stream-json 経路のどちらも最終行は同形なので分岐は要らない。
 *
 * **入力の大半は cacheRead** (実測: 2817 リクエストで 95%) なので、
 * in / out だけ見ても消費は分からない。読み書きを分けて返すのが要点。
 *
 * 通すのは**非負の安全整数だけ**。判定を `src/queue.js` の `count()` と同じ基準に
 * 揃えてある — ここが緩い (float や 2^53 超を通す) と、正規化は成功したのに表示側で
 * 黙って落ちる二段構えになり、「取れなかった」のか「弾かれた」のかがログから
 * 区別できなくなる (sol 指摘 2026-08-04)。
 *
 * @returns {{inputTokens?: number, cacheReadTokens?: number,
 *   cacheWriteTokens?: number, outputTokens?: number}|null} 1 つも取れなければ null
 */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const usage = {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : null;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** stream-json 入力の 1 メッセージ (画像ブロック + 指示文) */
function userMessage(prompt, images) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.bytes.toString('base64') },
        })),
        { type: 'text', text: prompt },
      ],
    },
  };
}

function parseResultJson(stdout) {
  // stdout は基本 1 行の JSON だが、防御的に末尾側から { で始まる行を探す
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* 次の行へ */ }
  }
  return null;
}
