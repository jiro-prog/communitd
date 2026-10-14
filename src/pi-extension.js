// pi の拡張 — pi ランタイムの job で pi が `-e` で読み込む (docs/reference/pi-runtime.md)。
//
// pi は権限・hook・構造化出力を持たない代わりに、拡張から道具の呼び出しと「終わる直前」に
// 割り込める。job ごとの設定 (環境変数 COMMUNITD_PI_CONFIG が指す JSON) に従って 3 つを担う:
//   1. 道具の呼び出しを権限で止める (`tool_call` → src/pi-policy.js) — claude の allowedTools 相当。
//      権限で通る呼び出しでも、同じ形を続けてくり返す足踏みは止めてやり方を変えさせる (createRepeatGuard)
//   2. 最終報告を道具 `submit_report` の引数で受け取る (引数のスキーマ = 契約のスキーマ)
//      — claude の `--json-schema` 相当
//   3. 終わる直前に verify を走らせ、NG なら同じ会話へ差し戻す (`agent_before_settle`)
//      — claude の Stop hook 相当。回数と状態ファイルは src/verify.js の runVerifyHook をそのまま使う
//
// **pi のプロセスの中で動く。** console へ書くと pi の JSON 出力 (stdout) に混ざるので、
// 診断は stderr へだけ出す。

import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  PI_CONFIG_ENV, PI_REPORT_TOOL, decidePiToolCall, piDenialOf,
} from './pi-policy.js';
import { runVerifyHook } from './verify.js';

/** 最終報告を出さずに終えようとしたときに促す回数 (無条件に続けると止まらなくなる) */
export const MAX_REPORT_NUDGES = 2;

/**
 * 同じ呼び出しを**続けて**何回まで通すか。これを超えた回は止めて、やり方を変えるよう返す。
 * arXiv 2610.12176 (MASS) の付録 I.2 で、モデル自身が進化させたワークフローに入れていた
 * 「同じ呼び出しを引数を変えずに 2 回を超えてくり返したら止めて、直前のエラーを読み直す」に倣う
 */
export const MAX_SAME_CALLS = 2;

const REPORT_DESCRIPTION =
  '最終報告。作業をすべて終えたら最後に 1 回だけ呼ぶ。引数がそのまま報告になり、'
  + '本文 (body) は Discord へそのまま投稿される。呼んだ時点で作業は終わる。'
  + '検証で差し戻されたら、直したうえで全体の報告として呼び直す (直した分だけを書かない)';

const log = (message) => {
  try { process.stderr.write(`[communitd] ${message}\n`); } catch { /* 診断の失敗で止めない */ }
};

/**
 * job の設定を読む。**読めなければ理由を返す** (呼び出し側は全部の道具を止める)。
 * @returns {{ok: true, config: object} | {ok: false, reason: string}}
 */
export function readPiJobConfig(env = process.env, readFile = readFileSync) {
  const path = env?.[PI_CONFIG_ENV];
  if (typeof path !== 'string' || path === '') return { ok: false, reason: `${PI_CONFIG_ENV} が設定されていません` };
  let config;
  try {
    config = JSON.parse(String(readFile(path, 'utf8')));
  } catch (err) {
    return { ok: false, reason: `設定ファイルを読めません: ${err?.message ?? err}` };
  }
  if (!config || typeof config !== 'object' || !config.policy || typeof config.policy !== 'object') {
    return { ok: false, reason: '設定ファイルに policy がありません' };
  }
  if (typeof config.policy.cwd !== 'string' || config.policy.cwd === '') {
    return { ok: false, reason: '設定ファイルに作業ディレクトリがありません' };
  }
  return { ok: true, config };
}

/** キーの順に依らない JSON (同じ引数を同じ文字列にする) */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 足踏みの見張り。直前と**まったく同じ呼び出し** (道具と引数) が続いた回数を数え、
 * 上限を超えた回を知らせる。違う呼び出しが 1 回でも挟まれば数え直す
 * (編集してから同じファイルを読み直す、のような普通の流れでは鳴らない)。
 * 止めた回も「直前の呼び出し」のままなので、引数を変えるまで止め続ける
 */
export function createRepeatGuard({ limit = MAX_SAME_CALLS } = {}) {
  let lastKey = null;
  let count = 0;
  return {
    /** @returns {{repeated: boolean, count: number}} count はこの呼び出しで何回目か */
    observe(toolName, input) {
      const key = `${String(toolName ?? '')}\u0000${stableJson(input ?? {})}`;
      count = key === lastKey ? count + 1 : 1;
      lastKey = key;
      return { repeated: count > limit, count };
    },
    /** 会話へ新しい材料 (verify の結果・促し) を差し込んだら数え直す */
    reset() {
      lastKey = null;
      count = 0;
    },
  };
}

/** 止めた理由に出す呼び出しの見出し (長い引数は切る) */
function describeCall(toolName, input) {
  const target = input?.command ?? input?.path ?? input?.pattern ?? '';
  const text = String(target).replace(/\s+/g, ' ').trim();
  return text === '' ? String(toolName) : `${toolName} ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}

const continueWith = (customType, content) => ({
  entries: [{ type: 'custom_message', customType, content, display: true }],
  continue: true,
});

/**
 * 設定から拡張を組み立てる (テストはここへ偽の pi と verify を渡す)。
 * @param {object} p
 * @param {object} p.config readPiJobConfig の config
 * @param {Function} [p.runVerifyHookImpl]
 */
export function createCommunitdExtension({
  config,
  runVerifyHookImpl = runVerifyHook,
  writeFile = writeFileSync,
  appendFile = appendFileSync,
  removeFile = (path) => rmSync(path, { force: true }),
} = {}) {
  const report = config.report && typeof config.report === 'object' ? config.report : null;
  const policy = { ...config.policy, report: report !== null };
  return function communitdExtension(pi) {
    let reported = false;
    let nudges = 0;
    let verifyBlocks = 0;
    const repeats = createRepeatGuard();

    // 止めた呼び出しを記録する。toolCallId は src/pi.js が「止めた呼び出し」を軌跡から外すのに使う
    // (pi は止めた呼び出しにも失敗として実行の終わりを出すので、外さないとツールの失敗が水増しになる)
    const recordBlocked = (event, extra = {}) => {
      if (typeof config.denialsFile !== 'string' || config.denialsFile === '') return;
      try {
        const record = { ...piDenialOf(event?.toolName, event?.input), toolCallId: event?.toolCallId ?? null, ...extra };
        appendFile(config.denialsFile, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (err) {
        log(`止めた呼び出しを記録できません: ${err?.message ?? err}`);
      }
    };

    pi.on('tool_call', async (event) => {
      const decision = decidePiToolCall({ toolName: event?.toolName, input: event?.input ?? {}, policy });
      if (!decision.allow) {
        recordBlocked(event);
        return { block: true, reason: decision.reason };
      }
      // 足踏み: 権限では通る呼び出しを、続けて同じ形で出し続けている。最終報告と、拡張から呼んだ
      // 入れ子の呼び出し (モデルの呼び出しではない) は数えない
      if (event?.toolName === PI_REPORT_TOOL || event?.parentToolCallId) return undefined;
      const seen = repeats.observe(event?.toolName, event?.input);
      if (!seen.repeated) return undefined;
      // **承認の候補にはしない** (権限で止めたのではない)。印を付けて同じファイルへ書き、
      // src/pi.js が permissionDenials から外す
      recordBlocked(event, { stall: true });
      return {
        block: true,
        reason: `同じ呼び出し (${describeCall(event?.toolName, event?.input)}) を続けて ${seen.count} 回目なので止めました。`
          + '引数を変えずにくり返しても、結果は変わらない見込みです。直前の結果やエラーを読み直して原因を考え、'
          + '引数かやり方を変えてください。進められないなら、わかっていることを報告して終えてください。',
      };
    });

    if (report) {
      pi.registerTool({
        name: PI_REPORT_TOOL,
        label: '最終報告',
        description: REPORT_DESCRIPTION,
        // 契約のスキーマをそのまま渡す。pi は TypeBox でない素の JSON Schema も検証する
        // (合わなければ理由つきでモデルへ返り、モデルが出し直す)
        parameters: report.schema,
        async execute(_toolCallId, params) {
          // 書けなければ throw = 道具の失敗としてモデルへ返る (黙って報告を落とさない)
          writeFile(report.file, JSON.stringify(params), 'utf8');
          reported = true;
          return {
            content: [{ type: 'text', text: '最終報告を受け取りました。' }],
            details: undefined,
            terminate: true,
          };
        },
      });
    }

    pi.on('agent_before_settle', async (event) => {
      // 止められた・落ちた回は検証しない (ブリッジが停止・失敗として扱う)
      if (event?.outcome !== 'completed') return undefined;
      // **報告が無ければ、検証より先に促す。** 先に検証すると、報告を忘れた回のたびに verify が
      // 丸ごともう 1 回走る (最大 10 分 × 回数、状態ファイルの試行回数も水増しになる)。
      // 検証は報告が手元にあるときか、促しを使い切った後だけ
      if (report && !reported && nudges < MAX_REPORT_NUDGES) {
        nudges += 1;
        repeats.reset();
        return continueWith(
          'communitd-report',
          `作業を終える前に ${PI_REPORT_TOOL} を 1 回呼んで、最終報告を出してください `
            + '(文章だけで終えると報告として受け取れません)。',
        );
      }
      if (config.verify) {
        let verdict = null;
        try {
          verdict = await runVerifyHookImpl(config.verify, {
            hook_event_name: 'Stop',
            stop_hook_active: verifyBlocks > 0,
          });
        } catch (err) {
          // 状態ファイルが書かれていなければ、ブリッジが最後に 1 回検証する (fail-open にはならない)
          log(`verify を実行できません: ${err?.message ?? err}`);
        }
        if (verdict?.decision === 'block') {
          verifyBlocks += 1;
          // 直した後の報告を取り直す。**報告ファイルも消す** — 残すと、直した後に報告を出し直さずに
          // 終えたとき、差し戻し前の報告 (直す前の本文・変更ファイル) が合格した成果として配送される
          if (report) {
            reported = false;
            nudges = 0;
            try { removeFile(report.file); } catch (err) { log(`古い報告を消せません: ${err?.message ?? err}`); }
          }
          repeats.reset();
          return continueWith(
            'communitd-verify',
            '検証 (verify) が通っていません。直してから、全体の最終報告をもう一度出してください。\n\n'
              + String(verdict.reason ?? ''),
          );
        }
      }
      return undefined;
    });
  };
}

/** pi が呼ぶ入口。設定が読めなければ**全部の道具を止める** (fail-closed) */
export default function communitd(pi) {
  const read = readPiJobConfig();
  if (!read.ok) {
    log(`設定を読めないため、すべての道具を止めます: ${read.reason}`);
    pi.on('tool_call', async () => ({ block: true, reason: `communitd の設定を読めないため止めました (${read.reason})` }));
    return;
  }
  createCommunitdExtension({ config: read.config })(pi);
}
