import { resolve } from 'node:path';

// cwd レーン単位のジョブキュー (副作用なし — タイマーも I/O も持たない)。
// 直列化の目的は「同じ作業ツリー / Unity のようなロック付き資源を 2 つの job が
// 同時に触らないこと」なので、直列の単位は作業ディレクトリで必要十分。
// cwd が違うチャンネル同士は並走してよい。

/** cwd → レーンキー。同じ作業ツリーを指す設定は同じレーンへ寄せる */
export function laneKeyFor(cwd) {
  return resolve(cwd);
}

/**
 * job 1 本の計測ログ行 (console.log 用)。
 *
 * 待ち時間と実行時間を分けて出すのが要点。「遅い」の原因がレーン待ち (別 job が
 * 同じ作業ツリーを掴んでいた) なのかモデルの実行そのものなのかを、ログだけで
 * 切り分けられるようにする。job ID があるのは、並走した job のログが混ざっても
 * 1 本を追えるようにするため。
 *
 * prompt / ctx は「何を渡したか」側の内訳。文字数予算が実際に発火しているか
 * (omit が 0 のまま = 安全弁として働いていないだけ) をここで見る。
 * prompt は role を含めた**実投入の総文字数**で、内訳として role 分を併記する —
 * 本文だけ数えると role を厚くした分が計測から消える (sol 指摘 2026-08-01)。
 * spawn 前に失敗した job では取れないので、無い時は黙って出さない。
 *
 * tok は**実消費**の側。文字数はブリッジが渡した分しか数えないので、セッションが
 * 抱えている履歴 (resume で毎リクエスト読み直す分) が見えない。消費のほぼ全部は
 * cacheRead なので (実測 2026-08-04: 2817 リクエストで入力の 95%)、in / out だけでなく
 * 読み書きを分けて出す。cacheWrite が跳ねている job = キャッシュの前方一致が
 * 切れた job で、これが見えないとセッションの持ち方を変えた効果を判定できない。
 * usage を返さないランタイム (codex) では黙って落ちる。
 *
 * **JSONL のような機械可読の計測基盤は作らない** (1 人運用の規模に対し過剰 —
 * 2026-08-01 方針)。必要になったらこの行を grep すれば足りる。
 */
export function formatJobMetrics({
  jobId,
  botKey,
  threadId,
  queueWaitMs,
  runMs,
  reason,
  promptChars,
  rolePromptChars,
  contextMessages,
  omittedMessages,
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens,
  verifyMs,
  verifyPassed,
  verifyAttempts,
  toolCalls,
  toolFailures,
  readsBeforeFirstEdit,
}) {
  const verify = count(verifyPassed);
  const parts = [
    `queueWait ${seconds(queueWaitMs)}s`,
    `run ${seconds(runMs)}s`,
    ...(count(promptChars) === null
      ? []
      : [
          `prompt ${count(promptChars)} chars`
            + (count(rolePromptChars) === null ? '' : ` (role ${count(rolePromptChars)})`),
        ]),
    ...(count(contextMessages) === null
      ? []
      : [`ctx ${count(contextMessages)} 件 (省略 ${count(omittedMessages) ?? 0})`]),
    ...tokenParts({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }),
    // 「最初の編集までに何回読んだか」は文脈注入が足りているかの代理指標。
    // 編集の無い job では取れないので括弧ごと落とす。失敗 0 件のときも書かない
    ...(count(toolCalls) === null
      ? []
      : [
          `tools ${count(toolCalls)} 件`
            + parenthesize([
              count(toolFailures) ? `失敗 ${count(toolFailures)}` : null,
              count(readsBeforeFirstEdit) === null
                ? null
                : `編集前 Read ${count(readsBeforeFirstEdit)}`,
            ]),
        ]),
    ...(verify === null
      ? []
      : [
          `verify ${seconds(verifyMs)}s (${verify === 1 ? 'pass' : 'fail'}, ` +
            `${count(verifyAttempts) ?? 0} runs)`,
        ]),
    reason,
  ];
  return `[job ${jobId} ${botKey} thread:${threadId}] ${parts.join(' / ')}`;
}

/** 取れた注記だけを括弧へ畳む (1 つも無ければ括弧そのものを出さない) */
function parenthesize(notes) {
  const kept = notes.filter(Boolean);
  return kept.length > 0 ? ` (${kept.join(', ')})` : '';
}

/**
 * トークン内訳を 1 パートへ畳む。in / out が両方取れなければパートごと出さない
 * (キャッシュの値だけが単独で並んでも読めないため)。
 */
function tokenParts({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }) {
  const head = [
    tokens(inputTokens) === null ? null : `in ${tokens(inputTokens)}`,
    tokens(outputTokens) === null ? null : `out ${tokens(outputTokens)}`,
  ].filter(Boolean);
  if (head.length === 0) return [];
  return [
    `tok ${head.join(', ')}`
      + parenthesize([
        tokens(cacheReadTokens) === null ? null : `cacheR ${tokens(cacheReadTokens)}`,
        tokens(cacheWriteTokens) === null ? null : `cacheW ${tokens(cacheWriteTokens)}`,
      ]),
  ];
}

/**
 * トークン数の表示。桁が大きいので k で畳む (1000 未満は生の数字)。
 * **0 は落とさない** — 「キャッシュが 1 つも効かなかった」は読み取りたい値そのもの。
 */
function tokens(v) {
  const n = count(v);
  if (n === null) return null;
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** 計測値として出せる非負整数だけ通す (取れなかった項目は行から落とす) */
function count(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** ミリ秒 → 秒 (小数第 1 位)。負値・非数は 0 扱い */
function seconds(ms) {
  const n = Number(ms);
  return (Number.isFinite(n) && n > 0 ? n / 1000 : 0).toFixed(1);
}

/**
 * item = { laneKey, threadId, botKey, placeholder, handle, run }
 * - 同一レーンは同時 1 本・FIFO
 * - 異なるレーンは並行 (maxConcurrent が 0 でなければその数まで)
 */
export class JobQueue {
  /** @param {{maxConcurrent?: number}} [opts] maxConcurrent は正の整数以外なら無制限 */
  constructor({ maxConcurrent = 0 } = {}) {
    this.maxConcurrent =
      Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 0;
    this.waiting = []; // 受付順 (全レーン混在)
    this.active = new Map(); // laneKey → 実行中 item (レーンあたり 1 本)
  }

  get activeCount() {
    return this.active.size;
  }

  get waitingCount() {
    return this.waiting.length;
  }

  /** 全レーン合計の同時実行上限に達しているか */
  atCapacity() {
    return this.maxConcurrent > 0 && this.active.size >= this.maxConcurrent;
  }

  laneBusy(laneKey) {
    return this.active.has(laneKey) || this.waiting.some((i) => i.laneKey === laneKey);
  }

  /** 受付時に「(キュー待ち)」と表示すべきか — 自レーンが塞がっているか上限到達 */
  wouldQueue(laneKey) {
    return this.laneBusy(laneKey) || this.atCapacity();
  }

  push(item) {
    this.waiting.push(item);
  }

  /**
   * いま開始してよい job を受付順に取り出し、実行中として登録して返す。
   * レーンが塞がっている job は後続に順番を譲るだけで、キュー内の順序は保つ
   * (同一レーン内の FIFO は崩れない)。
   * @returns {object[]} 呼び出し側が起動すべき item
   */
  takeStartable() {
    const started = [];
    for (let i = 0; i < this.waiting.length; ) {
      if (this.atCapacity()) break;
      const item = this.waiting[i];
      if (this.active.has(item.laneKey)) {
        i++; // このレーンは実行中 — 次の item を見る (異レーンは追い越して走ってよい)
        continue;
      }
      this.waiting.splice(i, 1);
      this.active.set(item.laneKey, item);
      started.push(item);
    }
    return started;
  }

  /** job 完了 — レーンを解放する (別 item に上書きされている場合は触らない) */
  finish(item) {
    if (this.active.get(item.laneKey) === item) this.active.delete(item.laneKey);
  }

  /**
   * stop 対象の選択。待機中の該当 job はこの時点でキューから外す
   * (呼び出し側が placeholder を ⏹ に編集する)。実行中 job は abort を呼ぶのが
   * 呼び出し側の責務で、レーンの解放は job 自身の完了 (finish) を待つ。
   * @param {{threadId?: string|null, all?: boolean}} p
   * @returns {{active: object[], dequeued: object[]}}
   */
  selectForStop({ threadId = null, all = false } = {}) {
    const match = (item) => all || (threadId !== null && item.threadId === threadId);
    const active = [...this.active.values()].filter(match);
    const dequeued = this.waiting.filter(match);
    if (dequeued.length > 0) this.waiting = this.waiting.filter((i) => !match(i));
    return { active, dequeued };
  }
}
