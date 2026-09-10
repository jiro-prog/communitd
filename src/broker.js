// 実行中の job からの承認要求を、人間が押すまで待たせる層 (T5)。
//
// PreToolUse hook は claude の子プロセスで、ブリッジ本体は別プロセス。localhost に
// ポートは開かず、**job 専用ディレクトリのファイル 2 枚**でやり取りする
// (T2 の settings / T3 の verify state / T4 の trace と同じ形。settingsDir に相乗り):
//
//   <dir>/<id>.ask.json   hook → ブリッジ (「これを実行してよいか」)
//   <dir>/<id>.ans.json   ブリッジ → hook (「allow / deny / pass」)
//
// どちらも tmp へ書いて rename する。**読めない・壊れている・間に合わないはすべて deny。**
// 判定が付かない側に倒すのは src/interactions.js:120 と同じ規則。
//
// 原則がもう 1 つある: **hook が無かったときより厳しくしない。**
// grant にできない要求 (シェル・パス・https 以外) はここで裁かず pass を返し、
// claude の通常判定へ戻す。そちらで拒否されれば従来どおり job 終了後の
// 承認カード経路 (permission_denials) が扱う。

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeGrant } from './toolrules.js';

export const ASK_SUFFIX = '.ask.json';
export const ANS_SUFFIX = '.ans.json';

/** ブリッジが承認を待つ上限の既定 (= job が止まっていられる時間) */
export const DEFAULT_APPROVAL_WAIT_MS = 3 * 60 * 1000;
/** ask を拾う / ans を待つ間隔 */
export const APPROVAL_POLL_MS = 400;
/**
 * hook 側がブリッジの待機上限より余分に待つ猶予。
 * **正規経路はブリッジ側が deny を返して畳むこと** — hook 側の打ち切りや CLI の
 * timeout kill で終わると、Discord のカードが「承認待ち」の見た目のまま残る。
 * だから待ち上限は必ず ブリッジ < hook < CLI の timeout の順に置く。
 */
export const HOOK_GRACE_MS = 5000;
/** ask に載せる tool_input の上限 (WebFetch の url が入る想定。超えたら載せない) */
export const MAX_ASK_INPUT_CHARS = 8000;

/**
 * ask 1 件をどう扱うか (純粋関数)。
 *
 * @param {object} ask hook の payload (tool_name / tool_input)
 * @param {{cwd?: string|null, allowedRules?: string[],
 *          isApproved?: (grant: object) => boolean}} ctx
 *        allowedRules = この job へ実際に渡した --allowedTools。
 *        isApproved = 承認済み台帳 (data/tools-extra.json) の照会
 * @returns {{decision: 'pass'}
 *          |{decision: 'allow'|'deny', reason: string, grant?: object, rule?: string}
 *          |{decision: 'ask', grant: object, rule: string}}
 */
export function decideAsk(ask, { cwd = null, allowedRules = [], isApproved = () => false } = {}) {
  const tool = String(ask?.tool_name ?? ask?.toolName ?? '').trim();
  if (tool === '') return { decision: 'pass' };
  // 全許可モードのチャンネルでは、どうせ通る呼び出しにカードを出しても意味がない
  // (payload に permission_mode が入っている — T0 §1.1)
  if (ask?.permission_mode === 'bypassPermissions') return { decision: 'pass' };
  // 素のツール名で既に許可されている = hook が無くても通る呼び出し。聞かない
  if (allowedRules.includes(tool)) return { decision: 'pass' };

  const proposed = proposeGrant(ask, { cwd });
  // grant にできない要求はここで裁かない (裁くと hook が無いときより厳しくなる)
  if (!proposed.ok) return { decision: 'pass' };
  if (allowedRules.includes(proposed.rule)) return { decision: 'pass' };

  // **この job の開始後に承認されたぶんも効かせる。** 承認済みルールは job 開始時点の
  // スナップショットで渡している (src/bridge/job.js) が、hook 経路はその更新にあたる
  if (isApproved(proposed.grant)) {
    return {
      decision: 'allow',
      reason: '承認済みのルールです',
      grant: proposed.grant,
      rule: proposed.rule,
    };
  }
  return { decision: 'ask', grant: proposed.grant, rule: proposed.rule };
}

/**
 * 1 job のあいだ「どのルールをカードにしたか」を持つ台帳。
 *
 * **予約は同期的に済ませる。** 判定 (重複・上限) から記録までに投稿の await を挟むと、
 * 同時に届いた ask が全部「まだ聞いていない」と判定され、同じカードが並んだり
 * 上限を超えたりする (sol 指摘 2026-08-02)。だから枠を先に取り、
 * **カードを出せなかったときだけ**返す — 出せなかったものを「聞いた」に数えると、
 * job 終了後のカードまで抑止してしまう。
 *
 * @param {{max?: number}} opts max = 1 job に出すカードの上限
 */
export function createAskLedger({ max = 3 } = {}) {
  const rules = new Set();
  return {
    /** @returns {{ok: true}|{ok: false, reason: 'asked'|'limit'}} */
    reserve(rule) {
      if (rules.has(rule)) return { ok: false, reason: 'asked' };
      if (rules.size >= max) return { ok: false, reason: 'limit' };
      rules.add(rule);
      return { ok: true };
    },
    /** 枠を返す (カードを出せなかったとき) */
    release(rule) {
      return rules.delete(rule);
    },
    /** この job で既にカードにしたか (job 終了後の重複カードを抑える) */
    has(rule) {
      return rules.has(rule);
    },
    get size() {
      return rules.size;
    },
  };
}

/**
 * 応答を正規化する。**知らない値・壊れた値はすべて deny** (fail-closed)。
 * pass だけは「何も返さない」= claude の通常判定なので、権限は増えない。
 */
export function normalizeAnswer(value) {
  const decision = value?.decision;
  const reason = typeof value?.reason === 'string' ? value.reason.slice(0, 500) : '';
  if (decision === 'pass') return { decision: 'pass', reason };
  if (decision === 'allow') return { decision: 'allow', reason: reason || '承認されました' };
  return { decision: 'deny', reason: reason || '承認されませんでした' };
}

/** hook の stdout へ出す形。pass は **何も出さない** (判定に関与しない) */
export function decisionOutput(answer) {
  const { decision, reason } = normalizeAnswer(answer);
  if (decision === 'pass') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** hook payload → ask ファイルの中身 (丸ごとは持たない) */
export function askFrom(id, hookInput = {}) {
  const input = hookInput?.tool_input;
  // 大きすぎる入力は載せない。grant を作れず pass になるだけで、通常判定へ戻る
  let toolInput = null;
  try {
    const json = JSON.stringify(input ?? null);
    if (typeof json === 'string' && json.length <= MAX_ASK_INPUT_CHARS) toolInput = JSON.parse(json);
  } catch { /* 循環参照等。載せない */ }
  return {
    id,
    tool_name: String(hookInput?.tool_name ?? '').slice(0, 80),
    tool_input: toolInput,
    tool_use_id: String(hookInput?.tool_use_id ?? '').slice(0, 120) || null,
    session_id: String(hookInput?.session_id ?? '').slice(0, 120) || null,
    permission_mode: String(hookInput?.permission_mode ?? '').slice(0, 40) || null,
  };
}

/** tmp へ書いて rename (読み手が半端な JSON を掴まない) */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** 読めない・壊れているは null (呼び出し側が deny へ倒す) */
function readJsonFile(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * ブリッジ側: job の一時ディレクトリを見張り、届いた ask を裁いて ans を書く。
 *
 * **1 job に 1 つ。** job が終わる・中断されるときは必ず stop() を呼ぶ —
 * 待っている hook を deny で畳まないと、claude 側が待ち上限まで進まない。
 */
export class ApprovalBroker {
  /**
   * @param {object} p
   * @param {string} p.dir       ask / ans を置く job 専用ディレクトリ
   * @param {(ask: object, ctx: {signal: AbortSignal}) => Promise<object>} p.decide
   *        1 件の裁定 (カードを出して待つ本体)。**signal が abort されたら速やかに返すこと**
   * @param {number} [p.waitMs]  1 件あたりの待ち上限
   * @param {number} [p.pollMs]  ディレクトリを見る間隔
   * @param {(err: Error) => void} [p.onError]
   */
  constructor({ dir, decide, waitMs = DEFAULT_APPROVAL_WAIT_MS, pollMs = APPROVAL_POLL_MS, onError = () => {} }) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('承認ブローカの dir が未設定です');
    if (typeof decide !== 'function') throw new TypeError('承認ブローカの decide が未設定です');
    if (!Number.isSafeInteger(waitMs) || waitMs <= 0) {
      throw new TypeError('承認ブローカの waitMs は正の整数で指定します');
    }
    this.dir = dir;
    this.decide = decide;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.onError = onError;
    this.seen = new Set(); // 拾った ask (同じファイルを二度裁かない)
    this.answered = new Set(); // 応答を書いた id (多重解決の最終ガード)
    this.pending = new Map(); // id → AbortController
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.timer || this.stopped) return this;
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  /**
   * 見張りを止め、**待っている hook をすべて deny で畳む**。
   * job の終了・中断・ブリッジ停止のどの経路からも必ず通ること。
   */
  stop(reason = 'job が終了したため承認を待てません') {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const [id, controller] of this.pending) {
      controller.abort();
      this.answer(id, { decision: 'deny', reason });
    }
    this.pending.clear();
  }

  tick() {
    let names;
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // ディレクトリごと消えた (job の後始末と競合した)
    }
    for (const name of names) {
      if (!name.endsWith(ASK_SUFFIX) || this.seen.has(name)) continue;
      this.seen.add(name);
      void this.handle(name);
    }
  }

  async handle(name) {
    const id = name.slice(0, -ASK_SUFFIX.length);
    if (this.stopped) {
      this.answer(id, { decision: 'deny', reason: 'ブリッジが承認を受け付けていません' });
      return;
    }
    const ask = readJsonFile(join(this.dir, name));
    if (!ask) {
      this.answer(id, { decision: 'deny', reason: '承認要求を読めませんでした' });
      return;
    }

    // 待ち上限はここ 1 か所だけが持つ。decide 側にも期限を置くと、
    // どちらが先に切れたかで挙動が変わる
    const controller = new AbortController();
    let timer = null;
    const expired = new Promise((resolveExpired) => {
      timer = setTimeout(() => {
        controller.abort();
        resolveExpired({ decision: 'deny', reason: '承認待ちが上限に達したため実行しません' });
      }, this.waitMs);
      timer.unref?.();
    });
    this.pending.set(id, controller);

    let answer;
    try {
      answer = await Promise.race([
        Promise.resolve().then(() => this.decide(ask, { signal: controller.signal })),
        expired,
      ]);
    } catch (err) {
      this.onError(err);
      answer = { decision: 'deny', reason: '承認処理でエラーが発生したため実行しません' };
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
    this.answer(id, answer);
  }

  /** 応答を 1 回だけ書く (stop と decide の決着が競合しても二重に書かない) */
  answer(id, value) {
    if (this.answered.has(id)) return false;
    this.answered.add(id);
    try {
      writeJsonAtomic(join(this.dir, `${id}${ANS_SUFFIX}`), normalizeAnswer(value));
      return true;
    } catch (err) {
      // 書けなければ hook 側は待ち上限で deny になる (fail-closed のまま)
      this.onError(err);
      return false;
    }
  }

  /** 待っている件数 (placeholder 表示・テスト用) */
  get waitingCount() {
    return this.pending.size;
  }
}

// ---- ここから下は hook プロセス側 ----

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function validateHookConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('承認 hook config が不正です');
  if (typeof config.dir !== 'string' || config.dir === '') {
    throw new TypeError('承認 hook の dir が未設定です');
  }
  if (!Number.isSafeInteger(config.waitMs) || config.waitMs <= 0) {
    throw new TypeError('承認 hook の waitMs は正の整数で指定します');
  }
}

/**
 * hook 側: PreToolUse 1 件をブリッジへ渡し、決着を待つ。
 *
 * **待ち切れない・読めない・書けないはすべて deny。** 唯一 pass を返すのは
 * 「この event / ツールは判定材料が無い」ときで、それは claude の通常判定へ戻すだけ。
 *
 * @returns {Promise<object|null>} stdout へ出す JSON (null = 何も出さない)
 */
export async function runApprovalHook(config, hookInput = {}, { sleep = delay, now = () => Date.now() } = {}) {
  validateHookConfig(config);
  // 取り違えを避けるため event 名は照合する (別 event に載せられても判定しない)
  if (hookInput?.hook_event_name && hookInput.hook_event_name !== 'PreToolUse') return null;
  if (String(hookInput?.tool_name ?? '').trim() === '') return null;

  const id = randomUUID();
  writeJsonAtomic(join(config.dir, `${id}${ASK_SUFFIX}`), askFrom(id, hookInput));

  const pollMs = Number.isSafeInteger(config.pollMs) && config.pollMs > 0 ? config.pollMs : APPROVAL_POLL_MS;
  const deadline = now() + config.waitMs + HOOK_GRACE_MS;
  const ansPath = join(config.dir, `${id}${ANS_SUFFIX}`);
  for (;;) {
    const answer = readJsonFile(ansPath);
    if (answer) return decisionOutput(answer);
    if (now() >= deadline) {
      // ブリッジ側が畳めなかった (落ちた・書けなかった)。ここで止めるのが最後の砦
      return decisionOutput({
        decision: 'deny',
        reason: '承認の応答が無かったため実行しません (ブリッジ側の待機上限)',
      });
    }
    await sleep(pollMs);
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
  if (index < 0 || !process.argv[index + 1]) throw new Error('使い方: node broker.js --hook <config.json>');
  const config = JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
  const response = await runApprovalHook(config, await readStdin());
  if (response) process.stdout.write(JSON.stringify(response));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    // **判定できないまま実行させない。** 理由はそのままモデルへ渡る (T0 §1.3)。
    // exit code は 0 のまま — 異常終了にすると出した deny が読まれない
    process.stdout.write(JSON.stringify(decisionOutput({
      decision: 'deny',
      reason: `承認ブローカの内部エラーのため実行しません: ${err?.message ?? err}`,
    })));
    process.stderr.write(`approval hook internal error: ${err?.stack ?? err}\n`);
  });
}
