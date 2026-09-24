// 同じ仕事を起こし直す判断。
// **純粋関数と、再開世代の台帳だけ。** Discord・Git・子プロセス・キューは src/recovery-wiring.js が
// 引数で渡してくる。
//
// 再開の原則: 既存のスレッド・ブランチ・worktree・未コミット変更を維持し、担当 (worker) を
// 同じスレッドで呼び直す。契約の nonce は再利用せず、権限も予算も増やさない。
// 走っている・待っている・生きている子が居るかもしれない仕事には手を出さない。

import { JsonStore } from './store.js';
import { remainingJobs } from './board.js';
import { pickWorker } from './scheduler.js';
import { msOfTime } from './time.js';
import { statusLabel } from './taskstatus.js';

/** 再開先 */
export const RETRY_TARGETS = Object.freeze(['worker', 'reviewer']);

/** これらの状態では `/retry` は何も起こさない (走っている・起動待ちの最中) */
const BUSY_STATUSES = Object.freeze(['running', 'queued', 'approval-wait', 'handoff-wait', 'review-wait']);

const TERMINAL = Object.freeze(['merged', 'dropped']);

/**
 * `/retry` を通してよいか (純粋)。
 *
 * @param {object} p
 * @param {object|null} p.task ボードのタスク (スレッドから引いたもの)
 * @param {string|null} [p.id] 打った人が書いた id (任意・一致しないと断る)
 * @param {object} p.status deriveTaskStatus の戻り
 * @param {boolean} [p.paused]
 * @param {boolean} [p.inFlight] 同じタスクの再開が進行中
 * @param {boolean} [p.liveJob] キューにそのスレッドの job が居る (実行中・待機中)
 * @param {object[]} [p.pendingContracts] そのスレッドの未消費契約
 * @param {'alive'|'gone'|'unknown'|null} [p.liveness] 要照合の子プロセスの生存 (照合対象が無ければ null)
 * @param {string[]} [p.workerKeys] チャンネルの worker
 * @param {string|null} [p.reviewerKey]
 * @param {string[]} [p.availableBotKeys] 起動している bot
 * @param {number|null} [p.hopBudget] hops 側の残り予算 (null = 門番なし)
 * @returns {{ok: boolean, reason: string, target: string|null, workerKey: string|null,
 *            warnings: string[], previous: object|null}}
 */
export function planRetry({
  task = null, id = null, status = null, paused = false, inFlight = false, liveJob = false,
  pendingContracts = [], liveness = null, livePids = [], unknownPids = [], workerKeys = [], reviewerKey = null,
  availableBotKeys = [], hopBudget = null, openRequest = null, now = Date.now(),
} = {}) {
  const ng = (reason) => ({ ok: false, reason, target: null, workerKey: null, warnings: [], previous: null });
  if (!task || typeof task !== 'object' || !task.id) {
    return ng('このスレッドに対応するタスクがありません (タスクのスレッドで打ってください)');
  }
  const taskId = String(task.id);
  const wanted = String(id ?? '').trim();
  if (wanted !== '' && wanted !== taskId) {
    return ng(`このスレッドのタスクは #${taskId} です (#${wanted} のスレッドで打ってください)`);
  }
  if (TERMINAL.includes(task.state)) return ng(`#${taskId} は ${task.state} です — 終わった仕事は起こしません`);
  if (task.state === 'blocked') {
    return ng(
      `#${taskId} は blocked (要人間) です — \`/retry\` では解消しません。`
      + '止めた理由 (裁定待ち・権限不足・予算切れ・差し戻し 2 回) を片付けて復帰させてください',
    );
  }
  if (task.state === 'proposed' || task.state === 'approved') {
    return ng(
      `#${taskId} は ${task.state} (着手前) です — 着手はスケジューラが起こします`
      + `${paused ? ' (自律運転が停止中なので `/resume` が要ります)' : ''}`,
    );
  }
  if (paused) return ng('自律運転が停止中です — `/resume` してから打ってください');
  if (inFlight) return ng(`#${taskId} の再開は進行中です (連打しても 1 回だけ起こします)`);
  // **送信済み・受付前の再開要求が残っていたら起こさない** (送信完了と受け手の受付の間には
  // Gateway の遅延がある。実行記録もキューもまだ前の失敗を示しているので、状態だけ見ると
  // 二重に起こせてしまう — レビュー指摘 2026-09-05)。要求は受付で照合して閉じる
  if (openRequest) {
    const label = requestMarker(taskId, openRequest.generation);
    if (openRequest.result === 'send-unknown') {
      return ng(
        `#${taskId} の再開要求 (${label}) の**送達が不明**です — スレッドに「${label}」の投稿が無いことを確かめられるまで起こしません`
        + ' (Discord に届き次第、次の `/retry` で自動的に照合します)',
      );
    }
    const sentAt = msOfTime(openRequest.sentAt ?? openRequest.at);
    const waitedMin = Number.isFinite(sentAt) ? Math.max(0, Math.floor((now - sentAt) / 60000)) : null;
    return ng(
      `#${taskId} の再開要求 (${label}) は送信済みで、${openRequest.targetBotKey ?? '担当'} の受付待ちです`
      + `${waitedMin === null ? '' : ` (${waitedMin} 分前)`} — 受け付けられれば消えます。`
      + '猶予 (5 分) を過ぎても受け付けられなければ期限切れになり、もう一度打てます',
    );
  }
  const st = status ?? { status: 'unknown', reason: '' };
  if (liveJob || BUSY_STATUSES.includes(st.status)) {
    return ng(
      `#${taskId} は${statusLabel(st.status)}です (${st.reason || '進行中'}) — 起こし直しません。`
      + `${st.status === 'handoff-wait' || st.status === 'review-wait' ? ' 猶予 (5 分) を過ぎても動かなければもう一度打ってください' : ''}`,
    );
  }
  const pending = (Array.isArray(pendingContracts) ? pendingContracts : []).filter(Boolean);
  if (pending.length > 0) {
    return ng(
      `#${taskId} には未消費の契約が ${pending.length} 件あります (${pending.map((c) => `${c.kind ?? '?'} → ${c.toBotKey ?? '?'}`).join(' / ')})`
      + ' — 受け手の起動待ちなので起こし直しません。動かないなら `/review` か契約の期限切れ (24 時間) を待ってください',
    );
  }
  // 要照合: **スレッドの全未照合記録の子プロセス**を見た結果 (最新 1 件ではない — レビュー指摘 2026-09-05)。
  // 1 件でも alive / unknown なら起こさない。判定の集約は呼び出し側 (recovery-wiring の livenessOf)
  if (st.status === 'reconcile' || liveness === 'alive' || liveness === 'unknown') {
    if (liveness === 'alive') {
      const pids = (Array.isArray(livePids) && livePids.length > 0 ? livePids : [st.run?.spawn?.pid ?? '?']).join(' / ');
      return ng(`#${taskId} は要照合で、前の job の子プロセス (pid ${pids}) が**まだ生きています** — 終わるのを待つか、手で止めてから打ってください`);
    }
    if (liveness === 'unknown') {
      const pids = (Array.isArray(unknownPids) && unknownPids.length > 0 ? unknownPids : [st.run?.spawn?.pid ?? '?']).join(' / ');
      return ng(`#${taskId} は要照合で、前の job の子プロセス (pid ${pids}) の生存を確かめられません — OS で確認し、居なければもう一度打ってください`);
    }
  }

  const warnings = [];
  if (st.status === 'reconcile' && liveness === null) {
    warnings.push(
      '前の job の子プロセスを特定できないため、残っていないことは確認できていません'
      + ' (実行記録に pid が無い — 導入前の job)。OS で claude / codex のプロセスが残っていないか確かめてください',
    );
  }
  const previous = st.run
    ? {
      id: st.run.id, botKey: st.run.botKey, outcome: st.run.outcome, reason: st.reason,
      endedAt: st.run.endedAt ?? st.run.observedAt ?? null, stopKind: st.run.stopKind ?? null,
    }
    : null;

  if (task.state === 'review') {
    if (!reviewerKey) return ng(`#${taskId} は review ですが reviewer が未設定です`);
    return { ok: true, reason: `#${taskId} は review — レビュー担当 (${reviewerKey}) を \`/review\` と同じ判定で呼び直します`, target: 'reviewer', workerKey: null, warnings, previous };
  }

  // in-progress → worker
  const left = remainingJobs(task);
  if (left <= 0) {
    return ng(
      `#${taskId} の job 予算が残っていません (消費 ${Number(task.jobsSpent) || 0} / ${Number(task.jobBudget) || 0})`
      + ' — 予算は勝手に増やしません。追い予算を出すなら blocked にしてから復帰 (resume) で積み増してください',
    );
  }
  if (hopBudget !== null && hopBudget <= 0 && left > 0) {
    // 台帳には残があるのに門番が 0 = 別の job が先に使った。門番の値が正
    return ng(`#${taskId} の job 予算はこのプロセスの門番では 0 です (台帳 残 ${left}) — 再起動すると台帳の値で門番が組み直されます`);
  }
  const workerKey = pickWorker({ worker: { bots: Array.isArray(workerKeys) ? workerKeys : [] } }, availableBotKeys);
  if (!workerKey) {
    return ng(`#${taskId} の担当 (${(workerKeys ?? []).join(' / ') || '未設定'}) が起動していません`);
  }
  return {
    ok: true,
    reason: `#${taskId} は in-progress — 担当 ${workerKey} を同じスレッド・同じブランチの続きとして呼び直します (残り job 予算 ${left})`,
    target: 'worker',
    workerKey,
    warnings,
    previous,
  };
}

/**
 * 再開メッセージ。**1 行目は `<@botId>` ちょうど** (起動メッセージと同じ流儀 —
 * 担当自身の client からは投げないこと)。前回どこで止まったかを 1 通に入れる。
 */
/** 再開要求の印 (`再開要求 77-3`)。再開メッセージの末尾に置き、送達不明のときにスレッドで探す鍵 */
export function requestMarker(taskId, generation) {
  return `再開要求 ${String(taskId)}-${Number(generation) || 0}`;
}

/** 印を読む (受付側の照合)。無ければ null */
export function parseRequestMarker(content) {
  const m = /再開要求 ([^\s-]+)-(\d+)/.exec(String(content ?? ''));
  if (!m) return null;
  const generation = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(generation) || generation <= 0) return null;
  return { taskId: m[1], generation };
}

/** 「相手が投稿を保存していない」と言い切れる Discord API のエラーコード (4xx 系) */
const DEFINITE_DISCORD_CODES = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10008, // Unknown Message
  40005, // Request entity too large
  50001, // Missing Access
  50007, // Cannot send messages to this user
  50013, // Missing Permissions
  50021, // Cannot execute action on a system message
  50035, // Invalid Form Body
  50083, // Thread is archived
  160002, // Thread is locked / cannot send
]);

/** 送信そのものが始まっていない・拒まれたと分かる文面 (自前の postAs が投げる日本語も含む) */
const DEFINITE_FAILURE_TEXT = /Missing Access|Missing Permissions|Unknown Channel|Unknown Guild|Cannot send messages|Invalid Form Body|Request entity too large|is archived|Thread is locked|起動していません|取得できません|archive されています|rate limit/i;

/**
 * 送信の失敗を「確実に送れていない」と「送れたか分からない」に分ける (純粋)。
 *
 * **既定は unknown。** failed と言えるのは、Discord が要求を拒んだ (4xx・既知のエラーコード) か、
 * 送信そのものが始まらなかった (チャンネルを取得できない・bot が居ない) と分かるときだけ。
 * ソケットが閉じた (`UND_ERR_SOCKET` / `other side closed`)・タイムアウト・5xx は、相手が投稿を
 * 保存していないとは言い切れないので unknown — 未送信へ戻すと二重に起こす (レビュー指摘 2026-09-05 B)。
 * @returns {'failed'|'unknown'}
 */
export function classifySendError(err) {
  const status = Number(err?.status ?? err?.httpStatus ?? err?.response?.status ?? err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) return 'failed';
  if (Number.isInteger(status) && status >= 500) return 'unknown';
  if (DEFINITE_DISCORD_CODES.has(Number(err?.code))) return 'failed';
  const text = `${err?.name ?? ''} ${err?.message ?? err ?? ''}`;
  if (DEFINITE_FAILURE_TEXT.test(text)) return 'failed';
  return 'unknown';
}

export function retryMessage({
  task = {}, botUserId, attempt = 1, previous = null, remaining = null, directionFile = '',
  gitChanged = null, lastActivity = null, kind = 'manual', requestId = null, max = 1900,
} = {}) {
  const id = String(task.id ?? '').trim();
  const branch = String(task.branch ?? '').trim() || `task/${id}`;
  const head = [
    `<@${botUserId}>`,
    '',
    `## 再開 — タスク ${id}: ${String(task.title ?? '').replace(/\s+/g, ' ').trim()} (試行 ${attempt}${kind === 'auto' ? ' / 自動復旧' : ''})`,
    '前の job が止まったので、**同じスレッド・同じブランチ・同じ作業ツリーの続き**として進めてください。',
    '',
    '### 前回の状態',
  ];
  const state = [];
  if (previous) {
    state.push(`- 終わり方: ${previous.outcome ?? '不明'}${previous.reason ? ` — ${String(previous.reason).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    if (previous.endedAt) state.push(`- 時刻: ${previous.endedAt}`);
  } else {
    state.push('- 実行記録が無い (導入前の job)。スレッドの最後の報告と `git status` / `git log` で現状を確かめること');
  }
  if (lastActivity) state.push(`- 最後に観測できた活動: ${lastActivity}`);
  if (gitChanged === true) state.push('- 作業ツリーには前回の変更が残っている (**捨てずに続ける**)');
  else if (gitChanged === false) state.push('- 作業ツリーに前回の変更は見えない (コミット済みか、何もしていない)');
  const tail = [
    '',
    '### 約束',
    `- ブランチ \`${branch}\` のまま続ける (新しいブランチを切らない・\`reset\` や \`checkout --\` で既存の変更を消さない)`,
    '- 既にある編集・コミット・テスト結果を確かめてから続ける (最初からやり直さない)',
    Number.isSafeInteger(remaining) ? `- 残り job 予算: ${remaining} job (この job も 1 消費する)` : '- 残り job 予算: 不明 — 人間に確認すること',
    directionFile ? `- \`${directionFile}\` の方向・やらないこと・粒度・品質基準に従う` : null,
    '- 終わったら報告様式 (本文 / 変更ファイル / やったこと / 検証結果 / 残課題) で返す。**完了の報告には制御フッタを書かない**',
  ].filter(Boolean);
  // 印は**必ず残す** (送達不明のときにスレッドで探す鍵)。溢れたら本文側を削る
  const marker = requestId ? `\n${requestId}` : '';
  const text = [...head, ...state, ...tail].join('\n');
  const room = max - marker.length;
  return (text.length <= room ? text : `${text.slice(0, room - 1)}…`) + marker;
}

// ---- 自動復旧の判断 ----

/** planRecovery が返す行動 */
export const RECOVERY_ACTIONS = Object.freeze(['none', 'observe', 'schedule', 'retry', 'halt']);

/**
 * 止まった job の**副作用の見立て** (純粋)。自動で起こし直せるのは副作用が始まっていないと
 * 実行記録で確認できるものだけ。
 *
 * - `none`: モデルの子プロセスが起動していない (spawn 記録なし) — 起動前の失敗
 * - `none-observed`: 起動はしたが、hooks で軌跡が取れ・ツール 0 件・git 差分なし
 * - `config`: 設定・契約の不備で起動しなかった (起こし直しても同じ結果 — 人間が直す)
 * - `delivered-model`: モデルは成功して配送で落ちた (成功したモデル実行を繰り返さない)
 * - `unknown`: それ以外 (API エラー・タイムアウト・trace 不在だけでは「なし」と言わない)
 *
 * @param {object|null} run 終端の実行記録
 * @returns {'none'|'none-observed'|'config'|'delivered-model'|'unknown'}
 */
export function classifySideEffects(run) {
  if (!run || typeof run !== 'object') return 'unknown';
  if (run.outcome === 'not-started') return 'config';
  if (run.outcome === 'deliver-failed' || run.modelResult === 'ok') return 'delivered-model';
  if (!run.spawn) return 'none';
  const ev = run.evidence ?? {};
  if (ev.hooks === true && ev.traceReadable === true && ev.toolCalls === 0 && ev.gitChanged === false) {
    return 'none-observed';
  }
  return 'unknown';
}

/**
 * 自動復旧の判断 (純粋)。**観測 mode が既定** — 起こさず、自動化していたら何をしたかを返す。
 *
 * @param {object} p
 * @param {object} p.task
 * @param {object} p.status deriveTaskStatus の戻り (`run` は直前の終端記録)
 * @param {{mode: string, graceMin: number, maxAutoRetries: number, retryDelaysMin: number[]}} p.config
 * @param {object|null} [p.recovery] RecoveryStore.recoveryOf(task.id)
 * @param {boolean} [p.paused]
 * @param {number} [p.backoffUntil]
 * @param {number|null} [p.dayJobsLeft] チャンネルの日次予算の残 (null = 不明 → 止める)
 * @param {boolean} [p.jobRunsHealthy] 実行記録の台帳が信用できるか (書き込みの失敗も含む)
 * @param {Array<{file: string, reason: string}>} [p.brokenLedgers] 読めない制御台帳
 *   (pause / tasks / recovery / job-runs …)。**1 件でもあれば halt** — 停止しているか・
 *   何が走ったか・何が仕事かの、どれか 1 つでも読めないなら起こす判断ができない
 * @param {'board'|'apply'|'scout'|'initiative'} [p.taskKind]
 * @param {number} p.now
 * @returns {{action: string, reason: string, safety: string, nextAt: number|null}}
 */
export function planRecovery({
  task, status, config, recovery = null, paused = false, backoffUntil = 0, dayJobsLeft = null,
  jobRunsHealthy = true, brokenLedgers = [], taskKind = 'board', now = Date.now(),
} = {}) {
  const out = (action, reason, safety = 'unknown', nextAt = null) => ({ action, reason, safety, nextAt });
  const mode = config?.mode ?? 'observe';
  if (mode === 'off') return out('none', '自動復旧は off');
  const unreadable = (Array.isArray(brokenLedgers) ? brokenLedgers : [])
    .map((l) => (typeof l === 'string' ? l : l?.file))
    .filter(Boolean);
  if (!jobRunsHealthy || unreadable.length > 0) {
    const which = unreadable.length > 0 ? unreadable.join(' / ') : 'job-runs.json';
    return out('halt', `制御台帳が信用できない (${which}) — 自動復旧を止めています。人間が確認するまで起こしません`);
  }
  if (taskKind !== 'board') return out('none', `${taskKind} は自動復旧の対象外`);
  if (!task || !status) return out('none', '判定の材料が無い');
  if (status.status !== 'recovery-wait') return out('none', `${status.status} は自動復旧の対象外`);
  const run = status.run ?? null;
  if (!run) return out('none', '実行記録の無い停止は自動では起こさない (要照合と同じ扱い)');
  if (run.stopKind) return out('none', `意図的な停止 (${run.stopKind}) は自動では起こさない`);
  const safety = classifySideEffects(run);
  if (safety === 'config') return out('observe', `設定・契約の不備 (${run.stageDetail || run.outcome}) — 起こし直しても同じ結果なので人間が直す`, safety);
  if (safety === 'delivered-model') return out('observe', 'モデルは成功して配送で落ちた — 成功したモデル実行を繰り返さない (本文を保存していないので自動再送もしない)', safety);
  if (safety === 'unknown') return out('observe', `副作用が始まっている可能性がある (${run.outcome}${run.stageDetail ? `: ${String(run.stageDetail).slice(0, 80)}` : ''}) — 既存成果を照合できる経路ができるまで手動復旧`, safety);

  const count = Number(recovery?.autoCount) || 0;
  const max = Number.isSafeInteger(config?.maxAutoRetries) ? config.maxAutoRetries : 0;
  if (count >= max) return out('observe', `自動再試行の上限 (${max} 回) に達した — 復旧待ちに残す (人間の \`/retry\`)`, safety);
  if (paused) return out('observe', '自律運転が停止中 — 起こさない', safety);
  const left = Number(task.jobBudget) - Number(task.jobsSpent || 0);
  if (!(left > 0)) return out('observe', 'task の job 予算が残っていない — 起こさない (予算は増やさない)', safety);
  if (dayJobsLeft === null || dayJobsLeft <= 0) return out('observe', 'チャンネルの日次予算が残っていない (か不明) — 起こさない', safety);

  const endedAt = msOfTime(run.endedAt ?? run.observedAt);
  if (!Number.isFinite(endedAt)) return out('observe', '前の job の終了時刻が読めない — 起こさない', safety);
  const delays = Array.isArray(config?.retryDelaysMin) && config.retryDelaysMin.length > 0 ? config.retryDelaysMin : [5, 15];
  const delayMin = delays[Math.min(count, delays.length - 1)];
  const graceMin = Number.isSafeInteger(config?.graceMin) && config.graceMin > 0 ? config.graceMin : 5;
  // **最も遅い開始可能時刻を採る**: 猶予・再試行間隔・チャンネルのバックオフ
  const earliest = Math.max(endedAt + delayMin * 60000, endedAt + graceMin * 60000, Number(backoffUntil) || 0);
  if (now < earliest) {
    return out('schedule', `自動再試行 ${count + 1} 回目を ${new Date(earliest).toISOString()} に予定 (間隔 ${delayMin} 分)`, safety, earliest);
  }
  return mode === 'auto'
    ? out('retry', `自動再試行 ${count + 1} 回目 (副作用なし: ${safety})`, safety)
    : out('observe', `[観測] 自動なら今起こす: 再試行 ${count + 1} 回目 (副作用なし: ${safety})`, safety);
}

/**
 * 再開世代の台帳 (`data/recovery.json`)。
 *
 * entry: `{ taskId, generation, attempts: [{generation, at, by, kind, target, previousRunId, result}],
 *           auto: {count, nextAt, lastReason, lastAt} }`
 *
 * **await の前に世代を確保する**ための店。手動 (`/retry`) も自動も同じ入口を使い、
 * 同じ task で同時に 2 本起こさない。自動の回数と次回時刻はここに永続する — 再起動や手動再開で
 * 自動枠をリセットしない。
 */
/**
 * 再開要求の結果の語彙。**送信と受付を分ける** (レビュー指摘 2026-09-05):
 * pending (送信前) → sent (送れた・受付待ち) | send-unknown (送れたか分からない) | failed(理由) (確実に送れていない)
 * → accepted (受け手の job が受け付けた) | expired (猶予内に受け付けられなかった)。
 * sent / send-unknown / pending は**未完了**で、同じ task の新しい再開を塞ぐ。
 */
export const OPEN_REQUEST_RESULTS = Object.freeze(['pending', 'sent', 'send-unknown']);

export class RecoveryStore extends JsonStore {
  get(taskId) {
    const key = String(taskId ?? '');
    if (key === '' || !Object.hasOwn(this.data, key)) return null;
    const entry = this.data[key];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  /** 全 task の記録 (起動時の照合に使う) */
  list() {
    return Object.keys(this.data).map((key) => this.get(key)).filter((e) => e !== null);
  }

  /** 再開を 1 回始める (世代を進めて記録)。@returns {{generation: number, entry: object}} */
  begin(taskId, {
    by = null, kind = 'manual', target = null, targetBotKey = null, previousRunId = null, now = Date.now(),
  } = {}) {
    const key = String(taskId ?? '');
    if (key === '') throw new Error('復旧の記録には taskId が必要です');
    const current = this.get(key) ?? { taskId: key, generation: 0, attempts: [], auto: { count: 0, nextAt: null, lastReason: '', lastAt: null } };
    const generation = (Number(current.generation) || 0) + 1;
    const attempt = {
      generation, at: new Date(now).toISOString(), by: by === null || by === undefined ? null : String(by),
      kind: kind === 'auto' ? 'auto' : 'manual', target: target ?? null,
      targetBotKey: targetBotKey === null || targetBotKey === undefined ? null : String(targetBotKey),
      previousRunId: previousRunId ?? null, result: 'pending',
      sentAt: null, messageId: null, acceptedAt: null, runId: null,
    };
    const next = {
      ...current,
      generation,
      attempts: [...(Array.isArray(current.attempts) ? current.attempts : []), attempt].slice(-50),
      auto: kind === 'auto'
        ? { ...(current.auto ?? {}), count: (Number(current.auto?.count) || 0) + 1, nextAt: null, lastAt: attempt.at }
        : { ...(current.auto ?? {}), nextAt: null },
    };
    this.write(key, next);
    return { generation, entry: next };
  }

  /**
   * 始めた再開の結果。`sent` のときは送信時刻と (取れれば) メッセージ ID を残す —
   * 受付の照合と、送達不明の確認に使う鍵。
   */
  settle(taskId, generation, result, { now = Date.now(), messageId = null } = {}) {
    const entry = this.get(taskId);
    if (!entry) return null;
    const at = new Date(now).toISOString();
    const attempts = (Array.isArray(entry.attempts) ? entry.attempts : []).map((a) => {
      if (a?.generation !== generation) return a;
      // Gateway の MessageCreate は REST の応答より先に届くことがある — 受け手が既に受け付けた
      // (accepted) 要求へ、遅れて返ってきた送信結果で結果を上書きしない (ID と時刻だけ補う)
      if (a.result === 'accepted') {
        return { ...a, sentAt: a.sentAt ?? at, messageId: a.messageId ?? (messageId ? String(messageId) : null) };
      }
      const next = { ...a, result: String(result ?? ''), settledAt: at };
      if (result === 'sent' || result === 'send-unknown') {
        next.sentAt = a.sentAt ?? at;
        if (messageId) next.messageId = String(messageId);
      }
      return next;
    });
    const next = { ...entry, attempts };
    this.write(entry.taskId, next);
    return next;
  }

  /** 世代で 1 件引く (受付側の照合) */
  attemptOf(taskId, generation) {
    const entry = this.get(taskId);
    const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
    return attempts.find((a) => a?.generation === Number(generation)) ?? null;
  }

  /** その task の未完了の再開要求 (送信前・送信済み受付待ち・送達不明)。無ければ null */
  openRequest(taskId) {
    const entry = this.get(taskId);
    const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      if (OPEN_REQUEST_RESULTS.includes(attempts[i]?.result)) return attempts[i];
    }
    return null;
  }

  /**
   * 受け手の job が受け付けた — 要求を閉じる。照合は **起動メッセージの ID** で、ID を持たない要求
   * (reviewer の召喚は制御メンションの ID を取れない) は宛先 bot と時刻で照合する。
   * @returns {object|null} 閉じた要求 (該当が無ければ null)
   */
  markAccepted(taskId, { triggerMessageId = null, botKey = null, runId = null, now = Date.now() } = {}) {
    const entry = this.get(taskId);
    if (!entry) return null;
    const at = new Date(now).toISOString();
    let matched = null;
    const attempts = (Array.isArray(entry.attempts) ? entry.attempts : []).map((a) => {
      if (matched || !OPEN_REQUEST_RESULTS.includes(a?.result)) return a;
      const byMessage = a.messageId && triggerMessageId && String(a.messageId) === String(triggerMessageId);
      const sentAt = msOfTime(a.sentAt ?? a.at);
      const byBot = !a.messageId && botKey && a.targetBotKey === botKey
        && (!Number.isFinite(sentAt) || msOfTime(now) >= sentAt);
      if (!byMessage && !byBot) return a;
      matched = { ...a, result: 'accepted', acceptedAt: at, runId: runId ?? null };
      return matched;
    });
    if (!matched) return null;
    this.write(entry.taskId, { ...entry, attempts });
    return matched;
  }

  /** 猶予内に受け付けられなかった要求を閉じる (送信済みが前提 — 送達不明は期限で閉じない) */
  expire(taskId, generation, { now = Date.now() } = {}) {
    const entry = this.get(taskId);
    if (!entry) return null;
    const attempts = (Array.isArray(entry.attempts) ? entry.attempts : []).map((a) => (
      a?.generation === generation && a.result === 'sent'
        ? { ...a, result: 'expired', expiredAt: new Date(now).toISOString() }
        : a
    ));
    this.write(entry.taskId, { ...entry, attempts });
    return this.get(taskId);
  }

  /** 自動再試行の予定。count は増やさない — 増えるのは begin(kind:'auto') のとき */
  scheduleAuto(taskId, { nextAt, reason = '', now = Date.now() } = {}) {
    const key = String(taskId ?? '');
    if (key === '') throw new Error('復旧の記録には taskId が必要です');
    const current = this.get(key) ?? { taskId: key, generation: 0, attempts: [], auto: { count: 0, nextAt: null, lastReason: '', lastAt: null } };
    const at = msOfTime(nextAt);
    if (!Number.isFinite(at)) throw new Error('nextAt を時刻として読めません');
    const next = {
      ...current,
      auto: { ...(current.auto ?? {}), count: Number(current.auto?.count) || 0, nextAt: new Date(at).toISOString(), lastReason: String(reason ?? ''), scheduledAt: new Date(now).toISOString() },
    };
    this.write(key, next);
    return next;
  }

  /** 自動の予定を取り消す (人間が起こした・対象外になった) */
  cancelAuto(taskId) {
    const entry = this.get(taskId);
    if (!entry || !entry.auto?.nextAt) return entry;
    const next = { ...entry, auto: { ...entry.auto, nextAt: null } };
    this.write(entry.taskId, next);
    return next;
  }

  /** taskstatus / recovery が読む形 (`{nextAutoAt, autoCount, lastAt}`) */
  recoveryOf(taskId) {
    const entry = this.get(taskId);
    if (!entry) return null;
    return {
      nextAutoAt: entry.auto?.nextAt ?? null,
      autoCount: Number(entry.auto?.count) || 0,
      lastAt: entry.auto?.lastAt ?? entry.attempts?.at?.(-1)?.at ?? null,
      generation: Number(entry.generation) || 0,
    };
  }

  write(taskId, entry) {
    this.commit({ ...this.data, [String(taskId)]: entry });
  }
}
