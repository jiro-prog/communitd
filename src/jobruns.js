// job の実行記録 (docs/implementation-plan.md P1 / docs/social-engineering.md §11)。
//
// 「動いている」「人間を待っている」「失敗した」「結果が分からない」を、Discord の
// スレッドを読み直さずに判定するための台帳。**task の状態は `TaskBoardStore` が正本、
// 1 本の job がどこまで進んだかはこの店が正本** — 同じ値を両方で編集しない。
//
// 記録するのは復旧の判断に要る最小限だけ: いつ受け付け・いつ走り・どの段階で・どう終わり・
// 次に誰が動くか。生のプロンプト・ツール入力の全文・トークン・承認済み権限の複製は
// 保存しない (それらは transcript とセッションの側にある)。
//
// **fail-closed の向き。** 受付の記録に失敗した job は起動しない (記録が無い job は
// 復旧の判断から漏れる)。実行後の記録に失敗したら「結果不明」として残し、自動復旧は止まる。
// ファイルが壊れていたら `broken` に理由を持つ — 「記録が読めない」を「仕事が無い」と
// 読み替えないための印。

import { JsonStore } from './store.js';
import { msOfTime } from './time.js';

/** 1 本の job が通る段階。`reconcile` は再起動後に前プロセスの記録へ付く印 (段階ではなく状態) */
export const RUN_STAGES = Object.freeze([
  'queued',     // 受付済み・レーン待ち
  'starting',   // 起動準備 (role / 契約 / transcript の組み立て — モデルはまだ動いていない)
  'model',      // ランタイム (claude / codex) が走っている
  'approval',   // ツール承認待ち (hook が人間のボタンを待っている)
  'verify',     // ブリッジ側の最終検証
  'deliver',    // 結果の配送 (本文・添付・制御メンション)
  'ended',      // 終端
  'reconcile',  // 前プロセスが終端まで記録できなかった (要照合)
]);

/** まだ終わっていない段階 (再起動時に要照合へ倒す対象) */
export const LIVE_STAGES = Object.freeze(['queued', 'starting', 'model', 'approval', 'verify', 'deliver']);

/**
 * 終了の分類。`runJob` / `runItem` の全 return・throw・停止経路を `classifyReason` で
 * ここへ写す。増やすときは `classifyReason` と `nextActorFor` も直す。
 */
export const RUN_OUTCOMES = Object.freeze([
  'ok',              // 配送まで済んだ
  'verify-failed',   // モデルは走り結果も配送したが verify NG (handoff は止めた)
  'aborted',         // 実行中に中断された (/stop・再起動・タイムアウト)
  'failed',          // ランタイムが失敗を返した (API エラー・spawn 失敗・タイムアウト)
  'deliver-failed',  // モデルは成功したが Discord への配送で落ちた
  'not-started',     // 設定・契約の不備で起動しなかった (role 読めない・契約を強制できない)
  'stopped',         // 起動前に人間が止めた
  'cancelled',       // 待機中に取り消された
  'internal-error',  // ブリッジ自身の例外
  'unknown',         // 記録から読み取れない (要照合を閉じたときなど)
]);

/** 止まった理由 (outcome が aborted / stopped / cancelled のときに誰が止めたか) */
export const STOP_KINDS = Object.freeze(['human', 'shutdown', 'timeout', 'runtime']);

/** 次に動くべき主体 */
export const NEXT_ACTORS = Object.freeze(['bot', 'reviewer', 'human', 'recovery', 'none', 'unknown']);

/** 終端記録の保持期間 (初期案 30 日)。未終端 (live / reconcile) は消さない */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const isoAt = (now) => new Date(now).toISOString();

/**
 * `runJob` の終了理由 (計測ログに出る短い識別子) → 分類。
 *
 * **文字列の部分一致で再実行可否は決めない。** ここで決めるのは「どの種類の終わり方か」
 * だけで、やり直してよいかは実行記録の他の欄 (モデルが起動したか・成果があるか) と
 * 突き合わせて判断する側 (src/recovery.js) が持つ。
 *
 * @param {string|null|undefined} reason
 * @returns {{outcome: string, detail: string, stopKind: string|null}}
 */
export function classifyReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') return { outcome: 'unknown', detail: '', stopKind: null };
  switch (text) {
    case 'ok': return { outcome: 'ok', detail: '', stopKind: null };
    case 'verify-failed': return { outcome: 'verify-failed', detail: '', stopKind: null };
    case 'aborted': return { outcome: 'aborted', detail: '', stopKind: null };
    case 'deliver-failed': return { outcome: 'deliver-failed', detail: '', stopKind: null };
    case 'stopped-before-start': return { outcome: 'stopped', detail: '', stopKind: 'human' };
    case 'internal-error': return { outcome: 'internal-error', detail: '', stopKind: null };
    case 'protocol-mismatch':
    case 'role-unreadable':
    case 'contract-unenforceable':
      return { outcome: 'not-started', detail: text, stopKind: null };
    default:
      break;
  }
  const failed = /^failed\((.*)\)$/s.exec(text);
  if (failed) {
    const detail = failed[1];
    // タイムアウトはブリッジが子を殺した停止で、モデルの失敗ではない (区別して残す)
    const stopKind = /^timeout after/i.test(detail) ? 'timeout' : null;
    return { outcome: 'failed', detail, stopKind };
  }
  return { outcome: 'unknown', detail: text, stopKind: null };
}

/**
 * 終わり方から「次に動くべき主体」を決める (純粋)。
 *
 * **job が終わったことを、仕事全体の完了や停滞とみなさない** — ここで出すのは
 * 「この job の直後、誰の番か」だけ。
 *
 * @param {{outcome: string, handoff?: {toBotKey?: string|null, kind?: string}|null,
 *          taskState?: string|null, taskSubmitted?: boolean}} p
 * @returns {string} NEXT_ACTORS のいずれか
 */
export function nextActorFor({ outcome, handoff = null, taskState = null, taskSubmitted = false } = {}) {
  switch (outcome) {
    case 'ok':
      if (handoff?.kind === 'handoff' && handoff.toBotKey) return 'bot';
      if (handoff?.kind === 'notify') return 'human';
      if (taskSubmitted || taskState === 'review') return 'reviewer';
      return 'human';
    case 'verify-failed':
    case 'failed':
    case 'deliver-failed':
    case 'internal-error':
    case 'not-started':
      // 止まった仕事。人間が起こし直すか、安全なら自動復旧が拾う (P3 / P4)
      return 'recovery';
    case 'aborted':
    case 'stopped':
    case 'cancelled':
      return 'human';
    default:
      return 'unknown';
  }
}

/**
 * 実行記録の台帳 (`data/job-runs.json`)。
 *
 * entry の形 (欠けた欄は null):
 * `{ id, taskId, threadId, botKey, channelName, cwd, trigger: {messageId, byBotKey, kind},
 *    attempt, intent: {contractExpected, nonce}, contract, contractState,
 *    stage, stageDetail, acceptedAt, startedAt, observedAt, endedAt,
 *    spawn: {pid, at, runtime}, modelResult, lastActivity, delivery, evidence,
 *    outcome, reason, stopKind, next, handoff, reconcile, placeholderId }`
 */
export class JobRunStore extends JsonStore {
  constructor(filePath) {
    super(filePath);
    // このプロセスで保存に失敗した回数と直近の理由。実行後の記録に失敗した job は
    // 「結果不明」で、これが 1 件でもあれば自動復旧は止まる (P4)
    this.writeFailures = [];
  }

  /**
   * 読めなかった理由 (読めていれば null)。
   *
   * **基底が持つ判定をそのまま使い、文字列で返す** — 「記録が 1 件も無い =
   * 何も走っていない」と読まれないための印で、読む側 (src/index.js の /status・
   * src/bridge/recorder.js の起動ログ) は文字列を期待している。
   * 台帳を退避しないのは基底と同じ (§12.3 (1))。
   *
   * @returns {string|null}
   */
  get broken() {
    return this.brokenInfo === null ? null : this.brokenInfo.reason;
  }

  /** 保存に失敗した事実を残してから投げ直す (呼び出し側が結果不明として扱えるように) */
  commit(next) {
    try {
      super.commit(next);
    } catch (err) {
      this.writeFailures.push({ at: isoAt(Date.now()), message: String(err?.message ?? err) });
      throw err;
    }
  }

  /** 台帳として信用できるか (壊れていない・このプロセスで書き損ねていない) */
  get healthy() {
    return this.broken === null && this.writeFailures.length === 0;
  }

  /** @returns {object|null} 壊れた値・継承プロパティは無いものとして扱う */
  get(id) {
    const key = String(id ?? '');
    if (key === '' || !Object.hasOwn(this.data, key)) return null;
    const entry = this.data[key];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  /**
   * 条件に合う記録を受付順 (acceptedAt 昇順・同時刻は id) で返す。
   * @param {{threadId?: string|null, taskId?: string|null, channel?: string|null,
   *          botKey?: string|null, live?: boolean|null}} filter
   *   live=true は終端でないもの (LIVE_STAGES + reconcile)、false は終端だけ
   */
  list({ threadId = null, taskId = null, channel = null, botKey = null, live = null } = {}) {
    return Object.keys(this.data)
      .map((key) => this.get(key))
      .filter((r) => r !== null)
      .filter((r) => threadId === null || r.threadId === String(threadId))
      .filter((r) => taskId === null || r.taskId === String(taskId))
      .filter((r) => channel === null || r.channelName === channel)
      .filter((r) => botKey === null || r.botKey === botKey)
      .filter((r) => live === null || isLive(r) === live)
      .sort(byAccepted);
  }

  /** 終わっていない記録 (走っている・待っている・要照合) */
  liveList() {
    return this.list({ live: true });
  }

  /** そのタスクの記録 (受付順) */
  forTask(taskId) {
    return taskId === null || taskId === undefined ? [] : this.list({ taskId });
  }

  /** そのスレッドの記録 (受付順) */
  forThread(threadId) {
    return threadId === null || threadId === undefined ? [] : this.list({ threadId });
  }

  /**
   * その Action ID で受け付けた記録 (受付順)。社会台帳の照合が「外で job が立ったか」を
   * 操作 ID で探すための口 (docs/society-ledger.md §7 — 再実行しても 1 回に収束させる鍵)。
   */
  forAction(actionId) {
    const key = String(actionId ?? '');
    if (key === '') return [];
    return this.list().filter((r) => r.society?.actionId === key);
  }

  /** そのタスクの最新の記録 (無ければ null) */
  latestForTask(taskId) {
    const runs = this.forTask(taskId);
    return runs.length > 0 ? runs[runs.length - 1] : null;
  }

  /**
   * 受付 (⏳ を出した直後・契約を claim する**前**)。
   *
   * ここで throw したら**呼び出し側は起動しない** (記録の無い job を走らせない)。
   * `intent` に「契約つきの handoff か」と nonce を残すので、claim と `bindContract` の
   * 間で落ちても、再起動後の照合で「契約を消費したのに束縛の記録が無い」と分かる。
   *
   * @returns {object} 作った記録
   */
  open({
    id, taskId = null, threadId, botKey, channelName = null, cwd = null,
    trigger = {}, intent = {}, placeholderId = null, society = null,
  }, { now = Date.now() } = {}) {
    const key = String(id ?? '');
    if (key === '') throw new Error('実行記録には id が必要です');
    if (this.get(key)) throw new Error(`実行記録 ${key} は既にあります`);
    const thread = String(threadId ?? '');
    if (thread === '') throw new Error('実行記録には threadId が必要です');
    const bot = String(botKey ?? '');
    if (bot === '') throw new Error('実行記録には botKey が必要です');
    const at = isoAt(now);
    const prior = this.list({ threadId: thread, botKey: bot }).length;
    const entry = {
      id: key,
      taskId: taskId === null || taskId === undefined ? null : String(taskId),
      threadId: thread,
      botKey: bot,
      channelName: asText(channelName),
      cwd: asText(cwd),
      trigger: {
        messageId: asText(trigger.messageId),
        byBotKey: asText(trigger.byBotKey),
        kind: trigger.byBotKey ? (trigger.self === true ? 'self' : 'bot') : 'human',
      },
      attempt: prior + 1,
      intent: {
        contractExpected: intent.contractExpected === true,
        nonce: asText(intent.nonce),
      },
      contract: null,
      // none = 契約の無い job / pending = claim 前 / bound = 束縛済み /
      // missing = タグ付きなのに契約が無かった / error = ストアを読めなかった
      contractState: intent.contractExpected === true || intent.nonce ? 'pending' : 'none',
      stage: 'queued',
      stageDetail: '',
      acceptedAt: at,
      startedAt: null,
      observedAt: at,
      endedAt: null,
      spawn: null,
      modelResult: null,
      lastActivity: null,
      delivery: {},
      evidence: null,
      outcome: null,
      reason: '',
      stopKind: null,
      stopRequestedAt: null,
      next: null,
      handoff: null,
      reconcile: null,
      placeholderId: asText(placeholderId),
      // 社会台帳の Action に結ぶ受付 (docs/society-ledger.md §5)。印なしの起動は null。
      // **操作 ID (Action ID) はここにしか残らない** — 照合はこれを鍵に外側 (Discord の投稿と
      // 実行記録) を探すので、受付の記録と同じ update で書く
      society: societyRef(society),
    };
    this.write(key, entry);
    return entry;
  }

  /**
   * claim の結果を job へ束縛する (受付の直後)。
   * 保存する契約は**参照だけ** (id / kind / nonce / 送信元) — 本文は ContractStore の側にあり、
   * 消費された後は transcript に残る。
   *
   * @param {{entry?: object|null, error?: string|null, expected?: boolean}} claimed
   */
  bindContract(id, { entry = null, error = null, expected = false } = {}, { now = Date.now() } = {}) {
    const record = this.require(id);
    let contractState = 'none';
    if (error) contractState = 'error';
    else if (entry) contractState = 'bound';
    else if (expected || record.intent?.nonce) contractState = 'missing';
    const contract = entry
      ? {
        id: asText(entry.id),
        kind: asText(entry.kind),
        nonce: asText(entry.nonce),
        fromBotKey: asText(entry.fromBotKey),
      }
      : null;
    return this.patch(id, { contract, contractState, observedAt: isoAt(now) });
  }

  /** レーンが空いて実際に走り出した */
  start(id, { now = Date.now() } = {}) {
    const at = isoAt(now);
    return this.patch(id, { stage: 'starting', stageDetail: '', startedAt: at, observedAt: at });
  }

  /** 段階を進める (終端は `finish` で) */
  setStage(id, stage, { now = Date.now(), detail = '' } = {}) {
    if (!LIVE_STAGES.includes(stage)) {
      throw new Error(`段階 ${JSON.stringify(stage)} は setStage では扱えません (${LIVE_STAGES.join(' / ')})`);
    }
    const at = isoAt(now);
    return this.patch(id, {
      stage,
      stageDetail: String(detail ?? ''),
      observedAt: at,
      lastActivity: { at, kind: 'stage', detail: stage },
    });
  }

  /**
   * ランタイムの子プロセスが起動した。**ここから先は副作用がありうる** —
   * pid と時刻を残すのは、再起動後に「前プロセスの子がまだ生きていないか」を
   * 確かめるため (pid だけでは同一性を決めない — src/procstate.js)。
   */
  noteSpawn(id, { pid = null, at = Date.now(), runtime = null } = {}) {
    const when = isoAt(at);
    return this.patch(id, {
      stage: 'model',
      stageDetail: '',
      spawn: {
        pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        at: when,
        runtime: asText(runtime),
      },
      observedAt: when,
      lastActivity: { at: when, kind: 'stage', detail: 'model' },
    });
  }

  /** ランタイムが返した (成否・中断)。成果の有無はここでは決めない */
  noteModelResult(id, { ok = false, aborted = false, error = null } = {}, { now = Date.now() } = {}) {
    return this.patch(id, {
      modelResult: aborted ? 'aborted' : ok ? 'ok' : 'failed',
      stageDetail: ok || aborted ? '' : String(error ?? '').slice(0, 200),
      observedAt: isoAt(now),
    });
  }

  /** 観測できた活動 (実行後 hook が記録した最後のツールなど)。段階は動かさない */
  noteActivity(id, { at = Date.now(), kind = 'tool', detail = '' } = {}) {
    const when = isoAt(at);
    return this.patch(id, {
      observedAt: when,
      lastActivity: { at: when, kind: String(kind), detail: String(detail ?? '').slice(0, 200) },
    });
  }

  /**
   * 配送の進み (本文・添付・制御メンション …)。`status` は
   * pending / sent / failed / unknown。**unknown は「送ったが応答を受け取れなかった」**で、
   * 自動再送の対象にはしない (P4)
   */
  noteDelivery(id, step, status, { now = Date.now() } = {}) {
    const record = this.require(id);
    const label = String(step ?? '').trim();
    if (label === '') throw new Error('配送記録には step が必要です');
    if (!['pending', 'sent', 'failed', 'unknown'].includes(status)) {
      throw new Error(`配送状態 ${JSON.stringify(status)} は知りません`);
    }
    return this.patch(id, {
      stage: record.stage === 'ended' || record.stage === 'reconcile' ? record.stage : 'deliver',
      delivery: { ...(record.delivery ?? {}), [label]: status },
      observedAt: isoAt(now),
    });
  }

  /** 停止の指示が届いた (中断の完了は `finish` が記録する) */
  markStopRequested(id, kind, { now = Date.now() } = {}) {
    if (!STOP_KINDS.includes(kind)) throw new Error(`停止理由 ${JSON.stringify(kind)} は知りません`);
    const record = this.get(id);
    if (!record || !isLive(record)) return record;
    return this.patch(id, { stopKind: record.stopKind ?? kind, stopRequestedAt: isoAt(now) });
  }

  /**
   * 終端。理由の分類と「次に動く主体」をここで確定する。
   *
   * @param {{reason?: string, stopKind?: string|null, handoff?: object|null,
   *          taskState?: string|null, taskSubmitted?: boolean, evidence?: object|null,
   *          now?: number}} p
   */
  finish(id, {
    reason = '', stopKind = null, handoff = null, taskState = null, taskSubmitted = false,
    evidence = null, now = Date.now(),
  } = {}) {
    const record = this.require(id);
    const classified = classifyReason(reason);
    const at = isoAt(now);
    const kind = stopKind ?? record.stopKind ?? classified.stopKind;
    const next = nextActorFor({ outcome: classified.outcome, handoff, taskState, taskSubmitted });
    return this.patch(id, {
      stage: 'ended',
      stageDetail: classified.detail,
      endedAt: at,
      observedAt: at,
      outcome: classified.outcome,
      reason: String(reason ?? ''),
      stopKind: kind ?? null,
      next,
      handoff: handoff
        ? { toBotKey: asText(handoff.toBotKey), kind: asText(handoff.kind) }
        : null,
      evidence: evidence && typeof evidence === 'object' ? { ...evidence } : record.evidence,
    });
  }

  /** 待機中に取り消された (走っていないので副作用は無い) */
  cancel(id, { stopKind = 'human', now = Date.now(), reason = '' } = {}) {
    const record = this.get(id);
    if (!record || !isLive(record)) return record;
    const at = isoAt(now);
    return this.patch(id, {
      stage: 'ended',
      stageDetail: String(reason ?? ''),
      endedAt: at,
      observedAt: at,
      outcome: 'cancelled',
      reason: 'cancelled',
      stopKind: STOP_KINDS.includes(stopKind) ? stopKind : 'human',
      next: 'human',
    });
  }

  /**
   * 終了処理が始まった。生きている記録すべてに「止めたのはブリッジの停止」と残す —
   * 再起動後の照合で、途中で切れた job が**意図的な停止**だったことが分かるように
   * (自動復活させない根拠)。
   * @returns {object[]} 印を付けた記録
   */
  markShutdown({ now = Date.now(), reason = 'shutdown' } = {}) {
    const marked = [];
    for (const record of this.liveList()) {
      if (record.stage === 'reconcile') continue;
      marked.push(this.patch(record.id, {
        stopKind: record.stopKind ?? 'shutdown',
        stopRequestedAt: record.stopRequestedAt ?? isoAt(now),
        stageDetail: record.stageDetail || String(reason ?? ''),
      }));
    }
    return marked;
  }

  /**
   * 起動時: 前プロセスが終端まで記録できなかったものを**要照合**にする。
   *
   * 「終わっていない」からといって「走っている」とも「失敗した」とも決めない。
   * 前プロセスの子が生きていないことを確かめられるまで、同じタスクを起こさない
   * (判定は src/procstate.js と src/recovery.js の側)。
   *
   * @returns {object[]} 要照合にした記録
   */
  reconcileOnStartup({ now = Date.now() } = {}) {
    const out = [];
    for (const record of this.liveList()) {
      if (record.stage === 'reconcile') {
        out.push(record); // 前回の起動で既に要照合 — そのまま残す (二重に印を付けない)
        continue;
      }
      out.push(this.patch(record.id, {
        stage: 'reconcile',
        reconcile: {
          at: isoAt(now),
          fromStage: record.stage,
          resolvedAt: null,
          resolvedBy: null,
          how: null,
        },
        observedAt: isoAt(now),
      }));
    }
    return out;
  }

  /**
   * 要照合を閉じる (人間の /retry・子が居ないことの確認・手動)。
   * outcome が未確定なら `unknown` — 結果は分からなかった、と正直に残す。
   */
  resolveReconcile(id, { how = 'manual', by = null, now = Date.now(), outcome = null } = {}) {
    const record = this.require(id);
    if (record.stage !== 'reconcile') {
      throw new Error(`実行記録 ${record.id} は要照合ではありません (${record.stage})`);
    }
    const at = isoAt(now);
    const decided = RUN_OUTCOMES.includes(outcome) ? outcome : 'unknown';
    return this.patch(id, {
      stage: 'ended',
      endedAt: at,
      observedAt: at,
      outcome: record.outcome ?? decided,
      reason: record.reason || `reconciled:${how}`,
      next: record.next ?? (decided === 'ok' ? 'none' : 'unknown'),
      reconcile: { ...(record.reconcile ?? {}), resolvedAt: at, resolvedBy: asText(by), how: String(how) },
    });
  }

  /**
   * 保持期間を過ぎた**終端**記録を消す。未終端 (走っている・要照合) は残す —
   * 未解決の記録が消えると「止まった仕事」が台帳から消える。
   * @returns {number} 消した件数
   */
  pruneEnded({ now = Date.now(), retentionMs = RUN_RETENTION_MS } = {}) {
    const next = { ...this.data };
    let removed = 0;
    for (const record of this.list()) {
      if (isLive(record)) continue;
      const endedAt = msOfTime(record.endedAt ?? record.observedAt);
      if (!Number.isFinite(endedAt) || now - endedAt <= retentionMs) continue;
      delete next[record.id];
      removed += 1;
    }
    if (removed > 0) this.commit(next);
    return removed;
  }

  patch(id, fields) {
    const record = this.require(id);
    const next = { ...record, ...fields };
    this.write(record.id, next);
    return next;
  }

  require(id) {
    const record = this.get(id);
    if (!record) throw new Error(`実行記録 ${id} がありません`);
    return record;
  }

  write(id, entry) {
    this.commit({ ...this.data, [String(id)]: entry });
  }
}

/** 終わっていない記録か (壊れた値は「終わっている」側へ倒す — 数えない方が害が小さい) */
export function isLive(record) {
  return Boolean(record) && (LIVE_STAGES.includes(record.stage) || record.stage === 'reconcile');
}

function byAccepted(a, b) {
  const left = msOfTime(a.acceptedAt);
  const right = msOfTime(b.acceptedAt);
  const l = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
  const r = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
  if (l !== r) return l < r ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

function asText(value) {
  return value === null || value === undefined ? null : String(value);
}

/**
 * 社会台帳への参照 (`{caseId, actionId, claimGeneration}`)。
 * **Action ID の無い参照は持たない** — 照合の鍵にならないものを書くと、
 * 「案件に結んだつもりの記録」が探せないまま残る。
 */
function societyRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const actionId = asText(ref.actionId);
  if (actionId === null || actionId === '') return null;
  return {
    caseId: asText(ref.caseId),
    actionId,
    claimGeneration: Number.isSafeInteger(ref.claimGeneration) ? ref.claimGeneration : null,
  };
}
