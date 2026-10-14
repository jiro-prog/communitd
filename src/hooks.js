import { fileURLToPath } from 'node:url';
import { HOOK_GRACE_MS } from './broker.js';

/**
 * Claude Code へ渡す job 専用 settings を組み立てる。
 * settings は権限経路にもなれるため、トップレベルキーは hooks だけに固定する。
 */
export function buildHookSettings(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('hook settings の入力はオブジェクトで渡す');
  }

  const unknownKeys = Object.keys(options).filter((key) => key !== 'enabled' && key !== 'hooks');
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `hook settings の入力で許可されていないキー: ${unknownKeys.join(', ')} (入力メタキー: enabled、settings に出力可能: hooks)`,
    );
  }

  const enabled = options.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new TypeError('hook settings の enabled は boolean で渡す');
  }
  if (!enabled) return null;

  const hooks = options.hooks === undefined ? {} : options.hooks;
  if (!isPlainObject(hooks)) {
    throw new TypeError('hook settings の hooks はオブジェクトで渡す');
  }

  // 循環参照・BigInt 等は spawn 前に失敗させ、戻り値は JSON の plain object に固定する。
  // JSON.stringify と同じく、値が undefined のプロパティはここで脱落する。
  return JSON.parse(JSON.stringify({ hooks }));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * job 専用 verify config を読む Stop hook を組み立てる。
 * command は Claude Code が shell 経由で起動するため、可変な検証コマンド本体は
 * ここへ埋めず JSON ファイルに隔離する (shell に渡るのは固定 script と config path だけ)。
 */
export function buildVerifyStopHooks({ configFile, timeoutMs }) {
  if (typeof configFile !== 'string' || configFile === '') {
    throw new TypeError('verify Stop hook の configFile が未設定です');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('verify Stop hook の timeoutMs は正の整数で指定します');
  }

  // wrapper 側が timeout → killTree → 8 秒の保険 resolve を行うので、Claude 側は
  // それより 10 秒長く待つ。先に hook だけ切られて検証プロセスが孤児になるのを防ぐ。
  const timeout = Math.ceil(timeoutMs / 1000) + 10;
  return {
    Stop: [{ hooks: [{ type: 'command', command: hookCommand('./verify.js', configFile), timeout }] }],
  };
}

/**
 * 実行されたツールを 1 行ずつ追記する hook を組み立てる。
 * matcher を書かない = 全ツールに一致。**hook は何も返さない**ので許可判定は変わらない。
 *
 * **PostToolUse と PostToolUseFailure の両方**に載せる (実測 CLI 2.1.220):
 * - `PreToolUse` は実行**前**に発火するので、拒否された呼び出しまで記録されて証拠にならない
 *   (deny された Read は PreToolUse だけ発火し、PostToolUse は発火しない)
 * - `PostToolUse` は**成功したときだけ**発火する。これだけだと落ちたテスト実行が軌跡から
 *   消え、総数も過少になる。失敗は `PostToolUseFailure` が拾う
 *
 * ツール 1 回ごとに node が 1 プロセス起動する分だけ job が遅くなる。
 */
export function buildTraceToolHooks({ traceFile, timeoutMs }) {
  if (typeof traceFile !== 'string' || traceFile === '') {
    throw new TypeError('ツール軌跡 hook の traceFile が未設定です');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('ツール軌跡 hook の timeoutMs は正の整数で指定します');
  }
  const entry = () => [
    {
      hooks: [
        {
          type: 'command',
          command: hookCommand('./trace.js', traceFile),
          timeout: Math.ceil(timeoutMs / 1000),
        },
      ],
    },
  ];
  return { PostToolUse: entry(), PostToolUseFailure: entry() };
}

/**
 * 承認ブローカへ問い合わせる PreToolUse hook を組み立てる (T5)。
 *
 * **matcher で対象ツールを絞るのが要点。** `--allowedTools` は許可リストではなく
 * 追加許可で、指定外でも無害なものは通る (T0 §6.3c) ため、hook 側で「このツールは
 * 拒否されるか」を正確には再現できない。全ツールに載せると、通るはずの呼び出しにまで
 * ブリッジとの往復が挟まる。承認カードにできるのはドメイン限定 (`WebFetch`) だけなので、
 * 対象もそれに限る。
 *
 * timeout は **ブリッジの待機上限 < hook 自身の打ち切り < CLI の timeout** の順に置く。
 * CLI に kill されると Discord のカードが「承認待ち」の見た目のまま残るので、
 * 正規経路は必ずブリッジ側の deny になるようにする (T3 の verify と同じ形)。
 */
export function buildApprovalPreToolHooks({ configFile, waitMs, tools }) {
  if (typeof configFile !== 'string' || configFile === '') {
    throw new TypeError('承認 PreToolUse hook の configFile が未設定です');
  }
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0) {
    throw new TypeError('承認 PreToolUse hook の waitMs は正の整数で指定します');
  }
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => /^[A-Za-z][A-Za-z0-9_]*$/.test(t))) {
    throw new TypeError('承認 PreToolUse hook の tools はツール名の配列で指定します');
  }
  const timeout = Math.ceil((waitMs + HOOK_GRACE_MS) / 1000) + 10;
  return {
    PreToolUse: [
      {
        // matcher は正規表現。対象は 1〜数件なので素直に交替で書く
        matcher: tools.join('|'),
        hooks: [{ type: 'command', command: hookCommand('./broker.js', configFile), timeout }],
      },
    ],
  };
}

/** hook から起動する自前スクリプトの起動行 (shell へ渡るのは固定パスだけ)。 */
function hookCommand(scriptRelative, argFile) {
  const script = fileURLToPath(new URL(scriptRelative, import.meta.url));
  return [process.execPath, script, '--hook', argFile].map(quoteHookArg).join(' ');
}

/** T0 の Windows 実測と同じ、hook command のパス引数クォート。 */
function quoteHookArg(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    // Windows のパスには `"` を含められない。slash 化して JSON/command の
    // backslash 解釈差も避ける (Claude Code / node はこの表記を受け付ける)。
    return `"${text.replaceAll('\\', '/')}"`;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}
