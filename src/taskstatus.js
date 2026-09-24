// タスクの「いまどうなっているか」を 1 つの語へ導く。**純粋関数だけ** — board・実行記録・キュー・契約・pause・
// バックオフ・復旧の勘定を引数で受け、Discord にもファイルにも触らない。
//
// 判定の向き: **待つ理由が説明できるものを停滞と誤判定しない。** 走っている・レーン待ち・
// ツール承認待ち・人間の返信待ちはそれぞれの語で返し、「復旧待ち」は
// 「次に動くべき主体が居ないまま猶予を過ぎた」ときだけ。分からないものは `reconcile` (要照合)
// で、失敗にも成功にも寄せない。

import { msOfTime } from './time.js';
import { isLive } from './jobruns.js';

/** 状態の語彙。増やすときは `describeStatus` / `nextOperationFor` も直す */
export const TASK_STATUS = Object.freeze([
  'running',        // job が走っている (起動準備・モデル・検証・配送)
  'queued',         // job が受付済みでレーン待ち
  'approval-wait',  // ツール承認のボタンを人間が押すのを待っている
  'handoff-wait',   // 次の担当を呼んだ直後 (受付待ち・猶予内)
  'review-wait',    // レビュー担当の起動待ち (猶予内)
  'reply-wait',     // 人間の返信待ち (質問・報告)
  'retry-scheduled',// 自動再試行の予定がある
  'recovery-wait',  // 止まっている — 人間の /retry か自動復旧の対象
  'stopped',        // 人間 (/stop) かブリッジの停止で中断された (自動では起こさない)
  'reconcile',      // 要照合 — 前プロセスの結末や実行記録が無く、走っていないと言い切れない
  'blocked',        // 要人間 (board の blocked)
  'paused',         // 自律運転が止まっていて着手されない
  'backoff',        // チャンネルのバックオフ中で着手されない
  'open',           // 着手待ち (proposed / approved)
  'done',           // 終端 (merged / dropped)
  'unknown',
]);

/** 「復旧待ち」として一覧に載せる状態 */
export const RECOVERY_STATUSES = Object.freeze(['recovery-wait', 'reconcile', 'stopped']);

/** 無実行の検知猶予。この間は「起動待ち」として扱い、過ぎたら復旧待ちに倒す (初期値 5 分) */
export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

const WORKING_STATES = Object.freeze(['in-progress', 'review']);
const TERMINAL = Object.freeze(['merged', 'dropped']);

/**
 * @param {object} p
 * @param {object} p.task ボードのタスク
 * @param {object[]} [p.runs] そのスレッドの実行記録 (受付順。JobRunStore.forThread)
 * @param {object[]} [p.pendingContracts] そのスレッドの未消費契約 (どの宛先でも)
 * @param {boolean} [p.paused] 自律運転が止まっているか
 * @param {number} [p.backoffUntil] チャンネルのバックオフ明け (ms)
 * @param {object|null} [p.recovery] 復旧の勘定 (`{nextAutoAt, autoCount}` — P4)
 * @param {string|null} [p.reviewerKey] チャンネルの reviewer (review 固着の検出に使う)
 * @param {number} [p.now]
 * @param {number} [p.graceMs]
 * @returns {{status: string, reason: string, since: number|null, waitedMs: number|null,
 *            next: string, run: object|null, stopKind: string|null}}
 */
export function deriveTaskStatus({
  task, runs = [], pendingContracts = [], paused = false, backoffUntil = 0, recovery = null,
  reviewerKey = null, now = Date.now(), graceMs = DEFAULT_GRACE_MS,
} = {}) {
  const at = msOf(now);
  const out = (status, reason, since, next, run = null, extra = {}) => {
    const sinceMs = finiteOrNull(msOfTime(since));
    return {
      status,
      reason,
      since: sinceMs,
      waitedMs: sinceMs === null ? null : Math.max(0, at - sinceMs),
      next,
      run,
      stopKind: null,
      ...extra,
    };
  };
  if (!task || typeof task !== 'object' || typeof task.state !== 'string') {
    return out('unknown', 'タスクを読めない', null, 'unknown');
  }
  const lastTransition = lastHistoryAt(task) ?? task.updatedAt ?? task.createdAt ?? null;

  if (TERMINAL.includes(task.state)) return out('done', task.state, lastTransition, 'none');
  if (task.state === 'blocked') {
    return out('blocked', lastHistoryNote(task) || '要人間', lastTransition, 'human');
  }
  if (!WORKING_STATES.includes(task.state)) {
    if (paused) return out('paused', '自律運転が停止中 (`/resume` で再開)', lastTransition, 'human');
    const until = msOf(backoffUntil);
    if (until > at) {
      return out('backoff', `チャンネルがバックオフ中 (${Math.ceil((until - at) / 60000)} 分後に明ける)`, lastTransition, 'scheduler');
    }
    return out(
      'open',
      task.state === 'approved' ? '着手待ち (次の tick で同時枠が空けば起動)' : '承認待ち',
      lastTransition,
      'scheduler',
    );
  }

  // ---- in-progress / review ----
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === 'object');
  const live = list.filter((r) => isLive(r) && r.stage !== 'reconcile');
  if (live.length > 0) {
    const run = live[live.length - 1];
    if (run.stage === 'approval') {
      return out('approval-wait', `${run.botKey} がツール承認のボタンを待っている${run.stageDetail ? ` (${run.stageDetail})` : ''}`, run.observedAt ?? run.startedAt, 'human', run);
    }
    if (run.stage === 'queued') {
      return out('queued', `${run.botKey} の job がレーン待ち`, run.acceptedAt, 'bot', run);
    }
    return out('running', `${run.botKey} の job が走っている (${stageLabel(run.stage)})`, run.startedAt ?? run.acceptedAt, 'bot', run);
  }

  const reconciling = list.filter((r) => r.stage === 'reconcile');
  if (reconciling.length > 0) {
    // 表示は最新 1 件で代表させるが、**起こす可否は全件を見る** (recovery-wiring の livenessOf)
    const run = reconciling[reconciling.length - 1];
    const others = reconciling.length > 1 ? ` (未照合 ${reconciling.length} 件)` : '';
    return out(
      'reconcile',
      `前プロセスの job (${run.botKey} / 段階 ${stageLabel(run.reconcile?.fromStage ?? '?')}) の結末が記録されていない${others}`
        + ' — 子プロセスが残っていないことを確かめるまで起こさない',
      run.reconcile?.at ?? run.observedAt,
      'human',
      run,
    );
  }

  const nextAuto = msOf(recovery?.nextAutoAt);
  if (nextAuto > at) {
    return out(
      'retry-scheduled',
      `自動再試行 ${(Number(recovery?.autoCount) || 0) + 1} 回目を予定 (${Math.ceil((nextAuto - at) / 60000)} 分後)`,
      recovery?.lastAt ?? lastTransition,
      'recovery',
    );
  }

  const ended = list.filter((r) => r.stage === 'ended');
  if (ended.length === 0) {
    // 起動メッセージは出たはずなのに job の記録が無い。直後なら受付待ち、過ぎたら要照合 —
    // 導入前に着手したタスク (記録が無いのが普通) もここに来る。「走っていない」と決めない
    const since = lastTransition;
    const waited = finiteOrNull(msOfTime(since));
    if (waited !== null && at - waited < graceMs) {
      return out('handoff-wait', '起動メッセージ送信済み・job の受付待ち', since, 'bot');
    }
    return out(
      'reconcile',
      '実行記録が無い (導入前に着手したか、起動メッセージが受け付けられていない) — 起こす前に状態を確かめる',
      since,
      'human',
    );
  }

  const run = ended[ended.length - 1];
  const endedAt = run.endedAt ?? run.observedAt;
  const withinGrace = (() => {
    const ms = finiteOrNull(msOfTime(endedAt));
    return ms !== null && at - ms < graceMs;
  })();
  const stopped = ['aborted', 'stopped', 'cancelled'].includes(run.outcome);
  if (stopped) {
    const who = run.stopKind === 'shutdown' ? 'ブリッジの停止 (再起動)' : run.stopKind === 'timeout' ? 'タイムアウト' : '人間の /stop';
    return out('stopped', `${who}で中断 (${run.botKey})`, endedAt, 'human', run, { stopKind: run.stopKind ?? null });
  }

  // review で止まっているのに、最後に走ったのが reviewer の job で判定が適用されなかった (= #46 型)
  if (task.state === 'review' && reviewerKey && run.botKey === reviewerKey && run.outcome === 'ok' && run.next !== 'reviewer') {
    return out('recovery-wait', 'レビュー job は終わったが判定が適用されていない (`/review` で出し直す)', endedAt, 'recovery', run);
  }

  switch (run.next) {
    case 'bot': {
      const to = run.handoff?.toBotKey ?? '次の担当';
      return withinGrace
        ? out('handoff-wait', `${to} を呼んだ直後 (受付待ち)`, endedAt, 'bot', run)
        : out('recovery-wait', `${to} を呼んだが job が起動していない`, endedAt, 'recovery', run);
    }
    case 'reviewer': {
      const hasReviewContract = (Array.isArray(pendingContracts) ? pendingContracts : [])
        .some((c) => c?.kind === 'task-review');
      if (withinGrace) return out('review-wait', 'レビュー担当の起動待ち', endedAt, 'reviewer', run);
      return hasReviewContract
        ? out('recovery-wait', 'レビュー担当を呼んだが job が起動していない (契約は未消費)', endedAt, 'recovery', run)
        : out('recovery-wait', 'レビュー契約が無い — `/review` で出し直す', endedAt, 'recovery', run);
    }
    case 'human':
    case 'none':
      return out(
        'reply-wait',
        run.handoff?.kind === 'notify' ? `${run.botKey} の質問に人間の返信待ち` : `${run.botKey} の報告に人間の返信待ち`,
        endedAt,
        'human',
        run,
      );
    case 'recovery':
      return out('recovery-wait', recoveryReason(run), endedAt, 'recovery', run);
    default:
      return out('reconcile', `直前の job (${run.botKey}) の結果が不明`, endedAt, 'human', run);
  }
}

/** 止まった理由の 1 行 (outcome ごと) */
export function recoveryReason(run) {
  const detail = String(run?.stageDetail ?? '').trim();
  switch (run?.outcome) {
    case 'verify-failed': return `verify NG のまま止まっている (${run.botKey})`;
    case 'failed': return `実行失敗: ${detail || '理由不明'} (${run.botKey})`;
    case 'deliver-failed': return `成果の配送に失敗 (${run.botKey} — モデルは成功済み)`;
    case 'internal-error': return `ブリッジの内部エラー (${run.botKey})`;
    case 'not-started': return `起動できなかった: ${detail || '理由不明'} (${run.botKey})`;
    default: return `${run?.outcome ?? '不明'} (${run?.botKey ?? '?'})`;
  }
}

/** 一覧に出す「次の操作」 */
export function nextOperationFor(status) {
  switch (status?.status) {
    case 'recovery-wait': return 'スレッドで `/retry`';
    case 'reconcile': return '子プロセスの残りを確かめて `/retry` (無ければ起こす)';
    case 'stopped': return '続けるなら `/retry`';
    case 'approval-wait': return '承認カードのボタン';
    case 'reply-wait': return 'スレッドに返信';
    case 'blocked': return '原因を直して復帰 (resume)';
    case 'paused': return '`/resume`';
    default: return '';
  }
}

/** 人が読む段階名 */
export function stageLabel(stage) {
  switch (stage) {
    case 'queued': return 'レーン待ち';
    case 'starting': return '起動準備';
    case 'model': return 'モデル実行中';
    case 'approval': return 'ツール承認待ち';
    case 'verify': return '最終検証';
    case 'deliver': return '結果配送';
    case 'ended': return '終了';
    case 'reconcile': return '要照合';
    default: return String(stage ?? '?');
  }
}

/** 人が読む状態名 */
export function statusLabel(status) {
  switch (status) {
    case 'running': return '実行中';
    case 'queued': return 'キュー待ち';
    case 'approval-wait': return '承認待ち';
    case 'handoff-wait': return '起動待ち';
    case 'review-wait': return 'レビュー待ち';
    case 'reply-wait': return '返信待ち';
    case 'retry-scheduled': return '再開予定';
    case 'recovery-wait': return '復旧待ち';
    case 'stopped': return '人間による停止';
    case 'reconcile': return '要照合';
    case 'blocked': return '要人間';
    case 'paused': return '自律運転停止中';
    case 'backoff': return 'バックオフ中';
    case 'open': return '着手待ち';
    case 'done': return '完了';
    default: return String(status ?? '?');
  }
}

/**
 * 復旧待ちの一覧 (待たせている時間が長い順)。
 * @param {object[]} tasks ボードのタスク
 * @param {(task: object) => object} statusOf タスク → deriveTaskStatus の戻り
 * @param {{excludeThreadIds?: Iterable<string>}} [options] 別の節 (停止・質問) に既に載っているスレッド
 */
export function recoveryRows(tasks, statusOf, { excludeThreadIds = [] } = {}) {
  const excluded = new Set([...excludeThreadIds].map(String));
  const rows = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !WORKING_STATES.includes(task.state)) continue;
    if (task.threadId && excluded.has(String(task.threadId))) continue;
    let status;
    try {
      status = statusOf(task);
    } catch (err) {
      status = { status: 'reconcile', reason: `状態を判定できない (${err?.message ?? err})`, since: null, waitedMs: null, next: 'human', run: null };
    }
    if (!RECOVERY_STATUSES.includes(status.status)) continue;
    rows.push({ task, status });
  }
  return rows.sort((a, b) => {
    const l = a.status.waitedMs ?? Number.POSITIVE_INFINITY;
    const r = b.status.waitedMs ?? Number.POSITIVE_INFINITY;
    if (l === r) return String(a.task.id).localeCompare(String(b.task.id));
    return l > r ? -1 : 1;
  });
}

function lastHistoryAt(task) {
  const history = Array.isArray(task?.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.at) return history[i].at;
  }
  return null;
}

function lastHistoryNote(task) {
  const history = Array.isArray(task?.history) ? task.history : [];
  const last = history[history.length - 1];
  return typeof last?.note === 'string' ? last.note.split('\n')[0].trim() : '';
}

function msOf(value) {
  const ms = msOfTime(value);
  return Number.isFinite(ms) ? ms : 0;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
