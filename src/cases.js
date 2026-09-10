/**
 * 社会台帳のドメイン判断 — 目的 (Mandate) / 気づき (Finding) / 案件 (Case) / 引受け (Claim) /
 * 操作 (Action) / 証拠 (Evidence) の**純粋な**状態遷移と、保存時の不変条件。
 * 仕様は docs/society-ledger.md §2〜§7 (S1 の実装仕様)。
 *
 * **ここには I/O も時計も無い。** `now` は必ず引数で受ける (ミリ秒か ISO 文字列)。保存は
 * `src/society-store.js` の責務で、このモジュールは「スナップショット → 新しいスナップショット」
 * だけを扱う。分けてあるのは、遷移の許可条件をファイルもプロセスも無い場所で全部試せるようにするため。
 *
 * 呼び出し規約:
 * - 入力のスナップショットは**書き換えない** (毎回複製して返す)。
 * - 戻りは `{ok, snapshot, ...}`。失敗しても `snapshot` は必ず入っている — 断ったときは入力のまま、
 *   「断ったこと自体を記録する」場合 (二人目の受諾が declined に落ちる等) は記録済みのものが入る。
 */

import { DEFAULT_OFFER_RECHECK_MIN } from './society-policy.js';

// ---- 閉集合 (綴り違いを黙って通さない) ----

/** Case の状態 (§3)。`resolved` は検収合格、`closed` は理由付きの終結で成功に数えない */
export const CASE_STATES = Object.freeze(['open', 'active', 'waiting', 'verifying', 'resolved', 'closed']);

/** 終端。ここからは動かない (再発は `supersedes` 付きの新 Case) */
export const CASE_TERMINAL_STATES = Object.freeze(['resolved', 'closed']);

/** 待ちの理由 (§3)。**内部の待ちを人間待ち (`authority`) に変換しない** */
export const WAITING_REASONS = Object.freeze([
  'dependency', 'offer', 'evidence', 'budget', 'authority', 'paused', 'reconcile',
]);

/** 理由付き終結の理由 (§3)。`superseded` は新 Case の ID を持つ */
export const CLOSE_REASONS = Object.freeze(['duplicate', 'unnecessary', 'mandate-ended', 'superseded']);

/** Claim の状態 (§4) */
export const CLAIM_STATES = Object.freeze(['offered', 'accepted', 'declined', 'expired', 'released', 'handed-over']);

/** Action の状態 (§5) */
export const ACTION_STATES = Object.freeze([
  'planned', 'sending', 'sent', 'accepted', 'running', 'settled', 'reconcile', 'cancelled',
]);

/** 依存の到達条件 (§3) */
export const DEPENDENCY_CONDITIONS = Object.freeze(['resolved', 'artifact-ready', 'service-ready']);

/** 既存台帳への参照 (§7)。**状態は写さず参照だけ持つ** */
export const LINK_KINDS = Object.freeze(['task', 'proposal', 'run', 'commit', 'thread']);

/** Finding の出所 (§2) */
export const FINDING_SOURCE_KINDS = Object.freeze(['report', 'event', 'duty', 'sample']);

/** Finding の処理 (§2) */
export const FINDING_DISPOSITIONS = Object.freeze(['pending', 'adopted', 'dismissed']);

/** 停止マーカーを付けられるのは人間と内部の判断だけ (§3) */
export const STOP_SOURCES = Object.freeze(['human', 'internal']);

/**
 * 停止の解除ができる操作 (§3)。**人間の発言 (`human-message`) では解除しない** —
 * 「止めてください」と言った後の雑談で勝手に動き出すのを防ぐため、明示の操作だけを通す。
 */
export const RESUME_SOURCES = Object.freeze(['owner-command', 'retry']);

/** 種別ごとの ID 接頭辞 (§2)。再利用しない */
export const ID_PREFIXES = Object.freeze({
  mandate: 'M', finding: 'F', case: 'C', claim: 'CL',
  action: 'A', evidence: 'E', observation: 'O', roleTrial: 'RT',
});

/** コレクション名 → ID 接頭辞 (counters の単調性検査に使う) */
export const COLLECTION_PREFIXES = Object.freeze({
  mandates: 'M', findings: 'F', cases: 'C', claims: 'CL',
  actions: 'A', evidence: 'E', observations: 'O', roleTrials: 'RT',
});

/** 送信から何ミリ秒見つからなければ未受付と確定してよいか (§5・既存 `classifySendError` と同じ 2 分) */
export const RECONCILE_TIMEOUT_MS = 2 * 60 * 1000;

// ---- 小さな道具 ----

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

/**
 * `now` をミリ秒へ。**時計を持たないので既定値は無い** — 呼び出し側が必ず渡す
 * (ここで `Date.now()` に落とすと、テストが実時刻に依存して固定できなくなる)。
 */
function toMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(now);
  if (Number.isFinite(parsed)) return parsed;
  throw new TypeError('now にはミリ秒か ISO 文字列を渡す (cases.js は時計を持たない)');
}

/** 日時は UTC で保存する (§12.4 — 日次枠だけが JST) */
function iso(now) {
  return new Date(toMs(now)).toISOString();
}

function clone(snapshot) {
  return structuredClone(snapshot);
}

function fail(snapshot, code, reason) {
  return { ok: false, code, reason, snapshot };
}

/** 変更した Case は版を上げる (Action が `caseVersion` で「どの版に対する操作か」を持つため) */
function touchCase(record, now) {
  record.version = (Number.isSafeInteger(record.version) ? record.version : 0) + 1;
  record.updatedAt = iso(now);
  return record;
}

function isTerminal(caseRecord) {
  return CASE_TERMINAL_STATES.includes(caseRecord?.state);
}

/**
 * その Action が属する Case が終端なら返す (そうでなければ null)。
 *
 * **終端の Case は動かさない** (§3「終端 → —」)。ただし Action の状態・結果・evidence・
 * 受付記録・消費の確定は残す — 閉じた後に判明した事実まで捨てると、外で起きたことを
 * 台帳に書けない経路ができてしまう (Fable 検収 (a))。
 */
function terminalCaseOf(draft, action) {
  const target = draft.cases?.[action.caseId];
  return target && isTerminal(target) ? target : null;
}

/** 終端 Case に当たったときの戻り (Action 側は記録済み・Case は触っていない) */
function terminalResult(draft, actionId) {
  return {
    ok: true,
    applied: false,
    code: 'terminal',
    snapshot: draft,
    actionId,
  };
}

/** 既定の再確認時刻 (引受け申し出の再確認は 5 分 — §12.4) */
function defaultNextCheckAt(now, minutes = DEFAULT_OFFER_RECHECK_MIN) {
  return iso(toMs(now) + minutes * 60 * 1000);
}

/**
 * 次の契機 (§3 の不変条件) を 1 つのフィールドに畳む。
 *
 * 仕様は「`runningAction` / `nextAction` / `waiting` の**いずれか**を必ず持つ」なので、
 * 3 本の別フィールドではなく **`nextTrigger` の 1 フィールド**にしてある — 別々に持つと
 * 「実行中の action と待ち条件が両方入っている Case」が作れてしまい、
 * *次の契機が一意に読める* (C03) が保証できない。
 */
function trigger(kind, payload = {}) {
  if (kind === 'waiting') {
    return {
      kind: 'waiting',
      reason: payload.reason,
      condition: payload.condition,
      nextCheckAt: payload.nextCheckAt,
      // 待っている相手が Action のときだけ入る (照合待ちなど)。**別の Action の待ちを
      // 自分の契機と取り違えないための識別子**で、相手が Action でない待ちは null
      actionId: payload.actionId ?? null,
    };
  }
  return { kind, actionId: payload.actionId };
}

function waitingTrigger({ reason, condition, nextCheckAt, actionId = null }) {
  return trigger('waiting', { reason, condition, nextCheckAt, actionId });
}

/**
 * 終わった Action を指したままの契機を立て直す (指していなければ何もしない)。
 *
 * **終わった Action を指す契機は保存できない** (§3 の不変条件) ので、Case を動かさない
 * 経路 (停止中・旧世代) でも契機だけは外しておく必要がある。外さないと、
 * 「止めた後に返ってきた結果」ごと台帳に残せなくなる (Opus2 指摘 ①)。
 */
function detachTrigger(draft, target, action, { reason, condition }, now) {
  if (!target || isTerminal(target)) return;
  if (target.nextTrigger?.actionId !== action.id) return;
  target.nextTrigger = waitingTrigger({ reason, condition, nextCheckAt: defaultNextCheckAt(now) });
  touchCase(target, now);
}

/**
 * 停止中の Case が持つ待ち条件の文面。**1 か所に置く** — settle・取り消し・照合の
 * どこから止めても同じ文になっていないと、`resumeCase` が「これは停止の待ちか」を
 * 読めなくなる (再開の立て直しはこの待ちを見て決める)。
 */
const PAUSED_CONDITION = '停止の解除を待つ (owner の再開操作か、task に結ぶ /retry)';

/**
 * 停止中の Case で、その Action を指していた契機を「解除待ち」へ倒す。
 *
 * **state は動かさない** (§3 — 止めた Case は明示の解除まで動かない)。`settleAction` の
 * 停止分岐と同じ形にそろえてあるので、止めた後に何が返ってきても契機は
 * `waiting(paused)` の 1 種類に収束する。
 *
 * @returns {boolean} 停止中だったか (true なら呼び出し側は通常の立て直しをしない)
 */
function pauseTriggerOn(draft, target, now) {
  if (!target.stop) return false;
  target.nextTrigger = waitingTrigger({
    reason: 'paused',
    condition: PAUSED_CONDITION,
    nextCheckAt: defaultNextCheckAt(now),
  });
  touchCase(target, now);
  return true;
}

/** 待ち条件として保存できる形か (理由・条件・再確認時刻がそろっているか) */
function badWaiting(waiting) {
  if (!isPlainObject(waiting)) return '待ち条件はオブジェクトで渡す';
  if (!WAITING_REASONS.includes(waiting.reason)) {
    return `待ちの理由が不明: ${JSON.stringify(waiting.reason)} (${WAITING_REASONS.join(' | ')})`;
  }
  if (!isNonEmptyString(waiting.condition)) return '待ち条件 (condition) を文で書く';
  if (!isNonEmptyString(waiting.nextCheckAt)) return '再確認時刻 (nextCheckAt) が要る';
  return null;
}

// ---- ID 採番 (§2) ----

/**
 * 次の ID を採る。**再利用しない** (`counters` は単調に増えるだけ)。
 * @returns {{id: string, snapshot: object}} 採番後のスナップショット付き
 */
export function nextId(snapshot, prefix) {
  const draft = clone(snapshot);
  return { id: takeId(draft, prefix), snapshot: draft };
}

function takeId(draft, prefix) {
  if (!Object.values(ID_PREFIXES).includes(prefix)) {
    throw new TypeError(`未知の ID 接頭辞: ${prefix} (${Object.values(ID_PREFIXES).join(' / ')})`);
  }
  if (!isPlainObject(draft.counters)) draft.counters = {};
  const current = Number.isSafeInteger(draft.counters[prefix]) ? draft.counters[prefix] : 0;
  const next = current + 1;
  draft.counters[prefix] = next;
  return `${prefix}-${next}`;
}

// ---- Mandate (§2) ----

/**
 * policy の Mandate (版の写し) を台帳へ置く。同じ key と version が既にあれば**採番せずそれを返す** —
 * 起動のたびに同じ版の写しが増えると、Case が指す版が世代ごとに割れる。
 */
export function registerMandate(snapshot, record, now) {
  const draft = clone(snapshot);
  if (!isPlainObject(record) || !isNonEmptyString(record.key) || !isPositiveInt(record.version)) {
    return fail(snapshot, 'invalid', 'Mandate の写しには key と version (正整数) が要る');
  }
  const existing = Object.values(draft.mandates ?? {})
    .find((m) => m.key === record.key && m.version === record.version);
  if (existing) return { ok: true, snapshot: draft, mandateId: existing.id, created: false };

  const id = takeId(draft, ID_PREFIXES.mandate);
  draft.mandates[id] = { ...record, id, copiedAt: record.copiedAt ?? iso(now) };
  return { ok: true, snapshot: draft, mandateId: id, created: true };
}

// ---- Finding (§2) と事象の同一性 (§3) ----

/**
 * 事象キー `(mandateId, sourceKind, subjectId, conditionId, episodeId)`。
 * 同じキーの気づきは既存の未終結 Case へ追記する (新しい Case を作らない)。
 */
export function eventKeyOf({ mandateId, sourceKind, subjectId, conditionId, episodeId }) {
  return [mandateId, sourceKind, subjectId, conditionId, episodeId]
    .map((part) => encodeURIComponent(String(part ?? '')))
    .join('|');
}

function findingEventKey(finding) {
  return eventKeyOf({
    mandateId: finding.mandateId,
    sourceKind: finding.source?.kind,
    subjectId: finding.subject?.subjectId,
    conditionId: finding.subject?.conditionId,
    episodeId: finding.subject?.episodeId,
  });
}

/**
 * 気づきを記録する。**原因・修正 diff・touch が未確定でも保存できる** (§2・受入 C02) —
 * 「目的と実際が食い違っている」ことだけで残せないと、原因が分かるまで観測が消える。
 */
export function addFinding(snapshot, input, now) {
  const draft = clone(snapshot);
  const mandate = draft.mandates?.[input?.mandateId];
  if (!mandate) return fail(snapshot, 'no-mandate', `Mandate が台帳に無い: ${input?.mandateId}`);
  for (const key of ['expected', 'actual']) {
    if (!isNonEmptyString(input?.[key])) return fail(snapshot, 'invalid', `Finding には ${key} が要る`);
  }
  if (!FINDING_SOURCE_KINDS.includes(input?.source?.kind)) {
    return fail(snapshot, 'invalid', `Finding の source.kind が不明 (${FINDING_SOURCE_KINDS.join(' | ')})`);
  }
  for (const key of ['subjectId', 'conditionId', 'episodeId']) {
    if (!isNonEmptyString(input?.subject?.[key])) {
      return fail(snapshot, 'invalid', `Finding の subject.${key} が要る (事象の同一性を決める)`);
    }
  }

  const id = takeId(draft, ID_PREFIXES.finding);
  draft.findings[id] = {
    id,
    mandateId: input.mandateId,
    mandateVersion: mandate.version,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: Array.isArray(input.evidenceRefs) ? [...input.evidenceRefs] : [],
    subject: { ...input.subject },
    source: { ...input.source },
    hypothesis: isNonEmptyString(input.hypothesis) ? input.hypothesis : null,
    disposition: 'pending',
    dispositionReason: null,
    caseId: null,
    at: iso(now),
  };
  return { ok: true, snapshot: draft, findingId: id };
}

/**
 * 気づきを採用して調査 Case を開く (§3 の `— → open`)。
 *
 * **編集先 (touch / files / diff) は入れない** (受入 C02) — 原因が分かる前に編集先を仮入力すると、
 * 「調べるまで分からないはずのこと」が台帳に既定値として残り、後から本当に確定した値と区別できない。
 *
 * 同じ事象キーの未終結 Case があれば新規に作らず `findingIds` へ追記する (`appended: true`)。
 */
export function adoptFinding(snapshot, input, now) {
  const draft = clone(snapshot);
  const finding = draft.findings?.[input?.findingId];
  if (!finding) return fail(snapshot, 'no-finding', `Finding が台帳に無い: ${input?.findingId}`);
  if (finding.disposition !== 'pending') {
    return fail(snapshot, 'not-pending', `Finding ${finding.id} は既に ${finding.disposition}`);
  }
  const mandate = draft.mandates?.[finding.mandateId];
  if (!mandate) return fail(snapshot, 'no-mandate', `Mandate が台帳に無い: ${finding.mandateId}`);
  if (mandate.state !== 'active') {
    return fail(snapshot, 'mandate-not-active', `Mandate ${mandate.id} は ${mandate.state} なので Case を開けない`);
  }

  const key = findingEventKey(finding);
  const existing = Object.values(draft.cases ?? {})
    .find((c) => c.eventKey === key && !isTerminal(c));
  if (existing) {
    existing.findingIds.push(finding.id);
    touchCase(existing, now);
    finding.disposition = 'adopted';
    finding.caseId = existing.id;
    return { ok: true, snapshot: draft, caseId: existing.id, appended: true };
  }

  if (!isNonEmptyString(input.desiredOutcome)) {
    return fail(snapshot, 'invalid', 'Case には desiredOutcome (望む結果) が要る');
  }
  if (!isNonEmptyString(input.acceptance?.condition) || !isPositiveInt(input.acceptance?.version)) {
    return fail(snapshot, 'invalid', 'Case には acceptance {condition, version} が要る (検収条件と版)');
  }

  const id = takeId(draft, ID_PREFIXES.case);
  draft.cases[id] = {
    id,
    version: 1,
    mandateId: finding.mandateId,
    mandateVersion: finding.mandateVersion,
    eventKey: key,
    findingIds: [finding.id],
    desiredOutcome: input.desiredOutcome,
    acceptance: { condition: input.acceptance.condition, version: input.acceptance.version },
    owner: null,
    budget: {
      allocated: isPositiveInt(input.budget?.allocated) ? input.budget.allocated : null,
      reserved: 0,
      charged: 0,
    },
    links: [],
    dependencies: [],
    parentId: null,
    childIds: [],
    // 開いた直後は「誰かが引き受ける」のを待っている。責任の空白を作らないための待ち (§4)
    nextTrigger: waitingTrigger({
      reason: 'offer',
      condition: 'owner の Claim が accepted になる',
      nextCheckAt: isNonEmptyString(input.nextCheckAt) ? input.nextCheckAt : defaultNextCheckAt(now),
    }),
    state: 'open',
    stop: null,
    closeReason: null,
    supersedes: isNonEmptyString(input.supersedes) ? input.supersedes : null,
    supersededBy: null,
    resolution: null,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  finding.disposition = 'adopted';
  finding.caseId = id;
  return { ok: true, snapshot: draft, caseId: id, appended: false };
}

/** 採用しない気づき (理由を残す。同じ観測が何度も上がってきたときの記録になる) */
export function dismissFinding(snapshot, findingId, reason, now) {
  const draft = clone(snapshot);
  const finding = draft.findings?.[findingId];
  if (!finding) return fail(snapshot, 'no-finding', `Finding が台帳に無い: ${findingId}`);
  if (finding.disposition !== 'pending') {
    return fail(snapshot, 'not-pending', `Finding ${findingId} は既に ${finding.disposition}`);
  }
  if (!isNonEmptyString(reason)) return fail(snapshot, 'invalid', '却下には理由が要る');
  finding.disposition = 'dismissed';
  finding.dispositionReason = reason;
  finding.at = finding.at ?? iso(now);
  return { ok: true, snapshot: draft, findingId };
}

// ---- Claim (§4) ----

function claimsOf(draft, caseId, responsibility) {
  return Object.values(draft.claims ?? {})
    .filter((cl) => cl.caseId === caseId && cl.responsibility === responsibility);
}

function acceptedClaim(draft, caseId, responsibility) {
  return claimsOf(draft, caseId, responsibility).find((cl) => cl.state === 'accepted') ?? null;
}

function issuedGeneration(draft, caseId, responsibility) {
  return claimsOf(draft, caseId, responsibility)
    .reduce((max, cl) => Math.max(max, Number.isSafeInteger(cl.generation) ? cl.generation : 0), 0);
}

/**
 * 引受けの申し出 (`offered`)。**責任は移らない** — 送っただけでは Case は動かない (§4)。
 */
export function offerClaim(snapshot, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[input?.caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${input?.caseId}`);
  if (isTerminal(target)) return fail(snapshot, 'terminal', `Case ${target.id} は ${target.state} (終端)`);
  if (target.stop) return fail(snapshot, 'stopped', `Case ${target.id} は停止マーカーが付いている`);
  if (!isNonEmptyString(input.responsibility)) return fail(snapshot, 'invalid', 'responsibility が要る');
  if (!isNonEmptyString(input.botKey)) return fail(snapshot, 'invalid', 'botKey が要る');

  const id = takeId(draft, ID_PREFIXES.claim);
  draft.claims[id] = {
    id,
    caseId: target.id,
    responsibility: input.responsibility,
    botKey: input.botKey,
    scope: input.scope ?? null,
    state: 'offered',
    deadline: isNonEmptyString(input.deadline) ? input.deadline : defaultNextCheckAt(now),
    generation: 0,
    handoverTo: null,
    reason: null,
    offeredAt: iso(now),
    acceptedAt: null,
    endedAt: null,
  };
  return { ok: true, snapshot: draft, claimId: id };
}

/**
 * 受諾 (`accepted`)。ここで初めて責任が移る (§4)。
 *
 * - **同一責務の accepted は同時 1 件** — 二人目は `declined` に理由付きで落ちる (先に保存した方が勝ち)。
 * - `permissionOk` は受諾時点の実効権限 (`既存能力 ∩ Mandate ∩ Claim.scope`) の再検証結果。
 *   S1 は台帳の層なので**注入で受ける** (実際の照合は S2 で既存の権限解決へ結ぶ)。
 * - owner の受諾で Case が動くときは `plan` (最初の Action) を**同じ update で**渡す。
 *   渡さないと「担当は居るが次の契機が無い Case」ができ、§3 の不変条件を満たせない。
 * - `plan` の代わりに `waiting` (理由と条件) を渡してもよい。**plan とは排他**で、
 *   使うのは「引き受けさせるが最初の一手は起こせない」場面だけ (observe の門で
 *   `implement` を断るときなど)。担当は決まったのに動けないのだから、Case は待ちになる。
 *
 * ⚠️ **`ok: false` でも `snapshot` を保存する呼び出しがある。** `occupied` (二人目) と
 * `permission` (権限の再検証に落ちた) は Claim を `declined` にした**新しいスナップショット**を
 * 返す — 呼び出し側が `ok` だけ見て捨てると、§4 の「後から declined に落ちて理由が残る」が
 * 消える。断られた理由も台帳に残すこと (S2 の配線側の注意点・Opus2 申し送り)。
 */
export function acceptClaim(snapshot, claimId, options, now) {
  const draft = clone(snapshot);
  const claim = draft.claims?.[claimId];
  if (!claim) return fail(snapshot, 'no-claim', `Claim が台帳に無い: ${claimId}`);
  if (claim.state !== 'offered') return fail(snapshot, 'not-offered', `Claim ${claimId} は ${claim.state}`);
  const target = draft.cases?.[claim.caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${claim.caseId}`);
  if (isTerminal(target)) return fail(snapshot, 'terminal', `Case ${target.id} は ${target.state} (終端)`);
  if (target.stop) return fail(snapshot, 'stopped', `Case ${target.id} は停止マーカーが付いている`);

  if (isNonEmptyString(claim.deadline) && toMs(now) > Date.parse(claim.deadline)) {
    claim.state = 'expired';
    claim.endedAt = iso(now);
    claim.reason = '申し出の期限が切れた';
    return { ok: false, code: 'expired', reason: claim.reason, snapshot: draft, claimId };
  }

  // 二人目は「先に保存された方が勝ち」で declined に落とし、**理由を残す** (§4)
  const holder = acceptedClaim(draft, claim.caseId, claim.responsibility);
  if (holder) {
    claim.state = 'declined';
    claim.endedAt = iso(now);
    claim.reason = `同一責務 (${claim.responsibility}) の accepted は同時 1 件 — 既に ${holder.id} (${holder.botKey}) が引き受けている`;
    return { ok: false, code: 'occupied', reason: claim.reason, snapshot: draft, claimId, holderId: holder.id };
  }

  if (options?.permissionOk === false) {
    claim.state = 'declined';
    claim.endedAt = iso(now);
    claim.reason = isNonEmptyString(options.permissionReason)
      ? options.permissionReason
      : '受諾時点の実効権限の再検証に通らなかった';
    return { ok: false, code: 'permission', reason: claim.reason, snapshot: draft, claimId };
  }

  const plan = isPlainObject(options?.plan) ? options.plan : null;
  const waiting = isPlainObject(options?.waiting) ? options.waiting : null;
  if (plan && waiting) {
    return fail(
      snapshot, 'invalid',
      '最初の一手 (plan) と待ち (waiting) は同時に渡せない — どちらが次の契機か決まらない',
    );
  }
  const activates = claim.responsibility === 'owner' && target.owner == null
    && (target.state === 'open' || target.state === 'waiting');
  if (activates && !plan && !waiting) {
    return fail(
      snapshot, 'plan-required',
      `Case ${target.id} を active にするには最初の Action (plan) を同じ update で渡す — `
      + '「担当は居るが次の契機が無い」状態は保存できない (§3 の不変条件)',
    );
  }

  claim.state = 'accepted';
  claim.acceptedAt = iso(now);
  claim.generation = issuedGeneration(draft, claim.caseId, claim.responsibility) + 1;

  if (claim.responsibility === 'owner') target.owner = claim.id;

  // **最初の一手は責務を問わず同じ update で植える** (Fable 検収 2026-09-08)。
  // owner のときだけ植えていた頃は、investigator / assessor として受けた bot に
  // 最初の Action が立たず、二度と起動されなかった (様式は accept に `next.plan` を必須にしている)。
  // 契機を動かすかは `planActionOn` の規則に任せる — owner 以外なら待ちも生きた契機も保たれる
  let actionId = null;
  if (plan) {
    // **受けた Claim の下に植える。** 呼び出し側が `claimId` を渡しても上書きする —
    // 受諾の返事で別の担当の Action を立てられると、責任の所在と Action の持ち主がずれる
    const planned = planActionOn(draft, { ...plan, caseId: target.id, claimId: claim.id }, now);
    if (!planned.ok) return { ...planned, snapshot };
    actionId = planned.actionId;
    if (activates) {
      target.state = 'active';
      // **活性化したときだけは契機を必ず向ける** (Opus2 指摘 ③ への答え)。規則の重複ではなく
      // 「active になった Case は最初の一手を指す」という保証 — 向けないまま active にすると
      // 「owner あり + waiting(offer)」という保存できない形が作れてしまう
      target.nextTrigger = trigger('nextAction', { actionId });
    }
  } else if (activates && waiting) {
    // 最初の一手を起こせない受諾 (observe の門)。**担当が決まった Case は待ちとして残す** —
    // 契機を書かないと「担当は居るが次の契機が無い」保存できない形になる
    const entry = {
      reason: waiting.reason,
      condition: waiting.condition,
      nextCheckAt: isNonEmptyString(waiting.nextCheckAt) ? waiting.nextCheckAt : defaultNextCheckAt(now),
    };
    const bad = badWaiting(entry);
    if (bad) return fail(snapshot, 'invalid', bad);
    if (entry.reason === 'offer') {
      return fail(
        snapshot, 'invalid',
        'owner が決まる受諾で waiting(offer) にはできない — 誰も満たせない条件で止まる',
      );
    }
    target.state = 'waiting';
    target.nextTrigger = waitingTrigger(entry);
  }
  touchCase(target, now);
  return { ok: true, snapshot: draft, claimId, generation: claim.generation, actionId };
}

/** 申し出を断る (相手の意思で `declined`) */
export function declineClaim(snapshot, claimId, reason, now) {
  const draft = clone(snapshot);
  const claim = draft.claims?.[claimId];
  if (!claim) return fail(snapshot, 'no-claim', `Claim が台帳に無い: ${claimId}`);
  if (claim.state !== 'offered') return fail(snapshot, 'not-offered', `Claim ${claimId} は ${claim.state}`);
  claim.state = 'declined';
  claim.reason = isNonEmptyString(reason) ? reason : '理由なし';
  claim.endedAt = iso(now);
  return { ok: true, snapshot: draft, claimId };
}

/**
 * 引受けが解けたときの共通処理 (辞退 `released` / 交代 `handed-over` / 担当消失 `expired`)。
 *
 * **次の Claim が accepted になるまで Case を `waiting(offer)` にする** (§4) — 責任の空白を作らない。
 * 新しい世代を accepted にする前に、旧世代の Action は `cancelled` か `reconcile` に倒して
 * 確定操作をできなくする (遅れて返ってきた結果で Case が動かないようにするため)。
 */
function endClaim(draft, claim, { state, reason, handoverTo = null }, now) {
  claim.state = state;
  claim.reason = reason;
  claim.handoverTo = handoverTo;
  claim.endedAt = iso(now);

  const stale = Object.values(draft.actions ?? {}).filter((a) => a.claimId === claim.id);
  const cancelled = [];
  for (const action of stale) {
    if (action.state === 'planned') {
      cancelActionOn(draft, action, { reason: `担当 ${claim.id} が ${state} になったので取り消し` }, now);
      cancelled.push(action.id);
    } else if (['sending', 'sent', 'accepted', 'running'].includes(action.state)) {
      // 送ってしまったものは勝手に取り消さない — 外部に起きているかもしれないので照合へ回す
      action.state = 'reconcile';
      action.updatedAt = iso(now);
      action.reason = `担当 ${claim.id} が ${state} になった時点で外部の状態が不明`;
      cancelled.push(action.id);
    }
  }

  const target = draft.cases[claim.caseId];
  if (target && !isTerminal(target) && claim.responsibility === 'owner') {
    target.owner = null;
    target.state = 'waiting';
    target.nextTrigger = waitingTrigger({
      reason: 'offer',
      condition: `${state} により担当が空いた — 次の owner が accepted になる`,
      nextCheckAt: defaultNextCheckAt(now),
    });
    touchCase(target, now);
  }
  return cancelled;
}

/** 辞退 (`released`)。Case は `waiting(offer)` へ */
export function releaseClaim(snapshot, claimId, reason, now) {
  const draft = clone(snapshot);
  const claim = draft.claims?.[claimId];
  if (!claim) return fail(snapshot, 'no-claim', `Claim が台帳に無い: ${claimId}`);
  if (claim.state !== 'accepted') return fail(snapshot, 'not-accepted', `Claim ${claimId} は ${claim.state}`);
  const cancelled = endClaim(draft, claim, {
    state: 'released', reason: isNonEmptyString(reason) ? reason : '辞退',
  }, now);
  return { ok: true, snapshot: draft, claimId, cancelledActionIds: cancelled };
}

/** 交代・分割 (`handed-over`)。新しい担当への申し出を同じ update で作る */
export function handOverClaim(snapshot, claimId, input, now) {
  const draft = clone(snapshot);
  const claim = draft.claims?.[claimId];
  if (!claim) return fail(snapshot, 'no-claim', `Claim が台帳に無い: ${claimId}`);
  if (claim.state !== 'accepted') return fail(snapshot, 'not-accepted', `Claim ${claimId} は ${claim.state}`);
  if (!isNonEmptyString(input?.botKey)) return fail(snapshot, 'invalid', '交代先の botKey が要る');
  // 停止中の Case へ新しい申し出を作らない (`offerClaim` と同じ門) —
  // 止めてあるのに次の担当を探し始めると、停止マーカーが実質効かなくなる
  if (draft.cases?.[claim.caseId]?.stop) {
    return fail(snapshot, 'stopped', `Case ${claim.caseId} は停止マーカーが付いているので交代先を募らない`);
  }

  const nextClaimId = takeId(draft, ID_PREFIXES.claim);
  const cancelled = endClaim(draft, claim, {
    state: 'handed-over',
    reason: isNonEmptyString(input.reason) ? input.reason : `${input.botKey} へ引き継ぎ`,
    handoverTo: nextClaimId,
  }, now);
  draft.claims[nextClaimId] = {
    id: nextClaimId,
    caseId: claim.caseId,
    responsibility: claim.responsibility,
    botKey: input.botKey,
    scope: input.scope ?? claim.scope ?? null,
    state: 'offered',
    deadline: isNonEmptyString(input.deadline) ? input.deadline : defaultNextCheckAt(now),
    generation: 0,
    handoverTo: null,
    reason: null,
    offeredAt: iso(now),
    acceptedAt: null,
    endedAt: null,
  };
  return { ok: true, snapshot: draft, claimId, nextClaimId, cancelledActionIds: cancelled };
}

/**
 * 担当が消えた (bot 不在・期限切れ) — `expired`。辞退と同じく Case は `waiting(offer)` へ。
 *
 * **引受け期限の経過だけで生きた job を再実行しない** (§4) ので、外に出した Action は
 * `cancelled` ではなく `reconcile` に倒す (照合が済むまで未受付と決めない)。
 */
export function expireClaim(snapshot, claimId, reason, now) {
  const draft = clone(snapshot);
  const claim = draft.claims?.[claimId];
  if (!claim) return fail(snapshot, 'no-claim', `Claim が台帳に無い: ${claimId}`);
  if (!['offered', 'accepted'].includes(claim.state)) {
    return fail(snapshot, 'not-live', `Claim ${claimId} は ${claim.state}`);
  }
  if (claim.state === 'offered') {
    // 申し出が流れただけなので Case は動かさない (責任はもともと移っていない)。
    // ⚠️ `waiting(offer)` の `nextCheckAt` は過ぎたまま残る — **次に誰へ声を掛けるかを
    // 決めるのは tick 側**で、ここで再確認時刻だけ延ばすと「誰も動いていないのに
    // 期限だけ先送りされる Case」ができる (Opus2 申し送り・S2 の巡回で拾う)
    claim.state = 'expired';
    claim.reason = isNonEmptyString(reason) ? reason : '申し出の期限が切れた';
    claim.endedAt = iso(now);
    return { ok: true, snapshot: draft, claimId, cancelledActionIds: [] };
  }
  const cancelled = endClaim(draft, claim, {
    state: 'expired', reason: isNonEmptyString(reason) ? reason : '担当が消えた (bot 不在・期限切れ)',
  }, now);
  return { ok: true, snapshot: draft, claimId, cancelledActionIds: cancelled };
}

// ---- Action / Outbox (§5) ----

function releaseReservation(draft, action, now) {
  if (!action.budget?.reserved) return;
  action.budget.reserved = false;
  action.budget.releasedAt = iso(now);
  const target = draft.cases[action.caseId];
  if (target) target.budget.reserved = Math.max(0, (target.budget.reserved ?? 0) - 1);
}

/**
 * 新しい Action へ**次の契機を向け直してよいか** (§3)。
 *
 * 契機は Case ごとに 1 つしかないので、Action を作るたびに奪うと「いま進んでいる仕事」が
 * 見えなくなる。owner が居る案件へ相談を出しただけで契機が相談へ移り、その相談が返って
 * きたときに戻す先が無くなる — これが S2-3b で `waiting(authority)` を借りた根 (Fable 検収)。
 *
 * - (a) 契機が無い → 向ける
 * - (b) **終わった** Action を指している → 向ける (指したままにできないため)
 * - (c) **生きた** Action を指している → 保つ (進んでいる仕事を止めない)
 * - (d) 待ち → **owner 自身の次の一手のときだけ**向ける。他人の Action で待ちを解かない
 *
 * ⚠️ (d) が実際に効くのは `acceptClaim` (受諾と同じ update の最初の一手) と `applyNextTrigger`
 * だけ。`planAction` は `state === 'waiting'` を**その前に**断るので、待ちを解く道は
 * `resumeFromWaiting` に一本化されている (Opus2 観察 ④ 2026-09-08)。
 */
function shouldRepointTo(draft, target, action) {
  const next = target.nextTrigger;
  if (!isPlainObject(next)) return true;
  if (next.kind === 'waiting') {
    return isNonEmptyString(target.owner) && action.claimId === target.owner;
  }
  return !LIVE_ACTION_STATES.includes(draft.actions?.[next.actionId]?.state);
}

function planActionOn(draft, input, now) {
  const target = draft.cases?.[input?.caseId];
  if (!target) return { ok: false, code: 'no-case', reason: `Case が台帳に無い: ${input?.caseId}` };
  if (isTerminal(target)) return { ok: false, code: 'terminal', reason: `Case ${target.id} は ${target.state} (終端)` };
  if (target.stop) return { ok: false, code: 'stopped', reason: `Case ${target.id} は停止マーカーが付いている` };
  const claim = draft.claims?.[input?.claimId];
  if (!claim) return { ok: false, code: 'no-claim', reason: `Claim が台帳に無い: ${input?.claimId}` };
  if (claim.state !== 'accepted') return { ok: false, code: 'not-accepted', reason: `Claim ${claim.id} は ${claim.state}` };
  if (claim.caseId !== target.id) return { ok: false, code: 'invalid', reason: 'Claim と Case が対応していない' };
  if (!isNonEmptyString(input.kind)) return { ok: false, code: 'invalid', reason: 'Action には kind が要る' };

  const budget = target.budget ?? { allocated: null, reserved: 0, charged: 0 };
  if (isPositiveInt(budget.allocated) && (budget.reserved + budget.charged) >= budget.allocated) {
    return {
      ok: false, code: 'budget',
      reason: `Case ${target.id} の配分 (${budget.allocated}) を使い切っている `
        + `(予約 ${budget.reserved} / 確定 ${budget.charged})`,
    };
  }

  const id = takeId(draft, ID_PREFIXES.action);
  draft.actions[id] = {
    id,
    caseId: target.id,
    caseVersion: target.version,
    claimId: claim.id,
    claimGeneration: claim.generation,
    kind: input.kind,
    target: isPlainObject(input.target) ? { ...input.target } : null,
    // この Action が伴う「引受けの申し出」(相談 = consult のときだけ入る)。
    // **受諾も辞退も、戻ってきた job をこの ID で Claim へ結び直すためにここに置く** —
    // 本文や宛先から推測すると、同じ相手への 2 件目の相談で取り違える
    offerClaimId: isNonEmptyString(input.offerClaimId) ? input.offerClaimId : null,
    // 何をする予定か (人が読む要旨)。起動文と `/case` の材料で、遷移には効かない
    note: isNonEmptyString(input.note) ? input.note : null,
    contractRef: isNonEmptyString(input.contractRef) ? input.contractRef : null,
    state: 'planned',
    // 予算はここで予約する (§5)。送る前に取っておかないと、送信中に別の action が同じ枠を使う
    budget: {
      source: isNonEmptyString(input.budget?.source) ? input.budget.source : null,
      reserved: true,
      reservedAt: iso(now),
      charged: false,
      chargedAt: null,
      releasedAt: null,
    },
    delivery: { messageId: null, runId: null, sendingAt: null, sentAt: null },
    result: null,
    reason: null,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  target.budget.reserved = (target.budget.reserved ?? 0) + 1;
  // **契機を動かすかはここで決める** — 呼び出し側が各自で書くと規則が散る
  const repointed = shouldRepointTo(draft, target, draft.actions[id]);
  if (repointed) target.nextTrigger = trigger('nextAction', { actionId: id });
  return { ok: true, actionId: id, repointed };
}

/**
 * 起動意図を保存する (`planned`)。**Case の変更と同じ update に入る形**にしてある (§5) —
 * 「送ったが台帳に無い」も「台帳にあるが送っていない」も、境界①の片側だけが残ると照合できない。
 */
export function planAction(snapshot, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[input?.caseId];
  if (target && target.state === 'waiting') {
    return fail(
      snapshot, 'waiting',
      `Case ${target.id} は waiting — 条件成立の証拠を付けて resumeFromWaiting で戻す (§3)`,
    );
  }
  const planned = planActionOn(draft, input, now);
  if (!planned.ok) return { ...planned, snapshot };
  // 契機を向けるかは planActionOn が決める (生きた契機は奪わない)
  touchCase(draft.cases[input.caseId], now);
  return { ok: true, snapshot: draft, actionId: planned.actionId, repointed: planned.repointed };
}

/**
 * 送信直前 (`sending`)。**`/pause` 中は新しい sending を作らない** (§3) — 照合と後始末は続ける。
 */
export function markSending(snapshot, actionId, options, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (action.state !== 'planned') return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state}`);
  if (options?.paused === true) {
    return fail(snapshot, 'paused', '/pause 中は新しい Action を送らない (照合と後始末だけ続ける)');
  }
  const target = draft.cases[action.caseId];
  if (target?.stop) return fail(snapshot, 'stopped', `Case ${target.id} は停止マーカーが付いている`);
  action.state = 'sending';
  action.delivery.sendingAt = iso(now);
  action.updatedAt = iso(now);
  if (terminalCaseOf(draft, action)) return terminalResult(draft, actionId);
  // 送りに出た時点で「次の契機」は *立てる予定の action* ではなく *外に出た操作* になる
  if (target && target.nextTrigger?.actionId === action.id) {
    target.nextTrigger = trigger('runningAction', { actionId: action.id });
    touchCase(target, now);
  }
  return { ok: true, applied: true, snapshot: draft, actionId };
}

/** 送信 API が message ID を返した (`sent`) */
export function markSent(snapshot, actionId, input, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (!['sending', 'reconcile', 'sent'].includes(action.state)) {
    return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state}`);
  }
  if (!isNonEmptyString(input?.messageId)) return fail(snapshot, 'invalid', 'messageId が要る');
  action.state = 'sent';
  action.delivery.messageId = input.messageId;
  action.delivery.sentAt = iso(now);
  action.updatedAt = iso(now);
  if (terminalCaseOf(draft, action)) return terminalResult(draft, actionId);
  return { ok: true, applied: true, snapshot: draft, actionId };
}

/**
 * 受信側が同じ Action ID の job を **1 件だけ**受け付けた (`accepted`)。
 * 受付記録 (`delivery.runId`) と消費確定 (`budget.charged`) を同じ update で保存する (§5)。
 */
export function markAccepted(snapshot, actionId, input, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (!isNonEmptyString(input?.runId)) return fail(snapshot, 'invalid', 'runId が要る (受付記録)');
  // **受付記録は 1 つの Action につき 1 件だけ。** 状態に関係なく先に見る — reconcile へ倒れた
  // Action に別の run を当てると、既に記録した run が消えて二重受付が読めなくなる
  // (`reconcileActions` が同じ場面を pending で断るのと同じ意味・Fable 検収 (d))
  const knownRun = action.delivery.runId;
  if (isNonEmptyString(knownRun) && knownRun !== input.runId) {
    return fail(
      snapshot, 'already-accepted',
      `Action ${actionId} は既に ${knownRun} で受け付けている (${input.runId} は別の run — 二重受付)`,
    );
  }
  if (action.state === 'accepted' || action.state === 'running') {
    // 同じ受付の再送は冪等 (別の run は上で断っている)
    return { ok: true, applied: false, snapshot: draft, actionId, duplicate: true };
  }
  if (!['sent', 'sending', 'reconcile'].includes(action.state)) {
    return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state}`);
  }
  action.state = 'accepted';
  action.delivery.runId = input.runId;
  action.updatedAt = iso(now);
  chargeReservation(draft, action, now);
  if (terminalCaseOf(draft, action)) return { ...terminalResult(draft, actionId), duplicate: false };
  noteDelivered(draft, action, now);
  return { ok: true, applied: true, snapshot: draft, actionId, duplicate: false };
}

/**
 * 受付が判明したときに Case をどう動かすか。**`markAccepted` と照合の両方がここを通る** —
 * 経路ごとに書くと、同じ場面なのに「待ちのまま」と「active」に割れる (Opus2 指摘 ③)。
 *
 * Case を動かさない場合が 4 つある:
 * - **旧世代の Action** — 交代・辞退の後に届いた受付で責任主体や次の契機を書き換えない
 *   (§4「新世代を accepted にする前に旧世代の確定操作をできなくする」・Opus2 指摘 ②)
 * - **停止マーカー** — 止めた Case は受付が判明しても復活しない (§3)
 * - **担当が空いている** — `waiting(offer)` を消すと「誰が引き受けるのか待ち」が読めなくなる
 * - **自分以外を待っている** — 下記のとおり
 *
 * `waiting → active` に戻すのは **この Action の照合を待っていたとき**だけ (Fable 検収 (e))。
 * `dependency` や `budget` の待ちは、受付記録が付いても条件そのものは成立していない —
 * そこで戻すと「依存が満たされていないのに動いている Case」ができ、しかも証拠として残るのは
 * 受付記録なので、何を根拠に待ちを解いたのかが説明できなくなる。
 */
function noteDelivered(draft, action, now) {
  const target = draft.cases[action.caseId];
  if (!target || isTerminal(target)) return;
  if (target.stop) return;
  if (!generationCurrent(draft, action)) return;
  if (!target.owner) return;

  const next = target.nextTrigger;
  if (target.state === 'waiting') {
    const waitingForThis = next?.kind === 'waiting'
      && next.reason === 'reconcile'
      && next.actionId === action.id;
    if (!waitingForThis) return;
    // 待ち条件 (この Action の照合) が成立した証拠を残してから戻す (§3)
    addEvidenceOn(draft, {
      caseId: target.id,
      actionId: action.id,
      source: { kind: 'delivery', actionId: action.id },
      observed: { runId: action.delivery.runId, note: '照合待ちだった Action の受付記録が確認できた' },
      conclusion: 'accepted-delivery',
    }, now);
    target.state = 'active';
  } else if (next?.actionId !== action.id) {
    // 別のものを指している契機は上書きしない (自分は runningAction として追える)
    return;
  }
  target.nextTrigger = trigger('runningAction', { actionId: action.id });
  touchCase(target, now);
}

function chargeReservation(draft, action, now) {
  if (action.budget.charged) return;
  action.budget.charged = true;
  action.budget.chargedAt = iso(now);
  const target = draft.cases[action.caseId];
  if (!target) return;
  if (action.budget.reserved) {
    action.budget.reserved = false;
    target.budget.reserved = Math.max(0, (target.budget.reserved ?? 0) - 1);
  }
  target.budget.charged = (target.budget.charged ?? 0) + 1;
}

/** job が走り出した (`running`) */
export function markRunning(snapshot, actionId, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (action.state !== 'accepted') return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state}`);
  action.state = 'running';
  action.updatedAt = iso(now);
  if (terminalCaseOf(draft, action)) return terminalResult(draft, actionId);
  return { ok: true, applied: true, snapshot: draft, actionId };
}

/** 送信結果が不明 (`reconcile`)。**無条件に再送しない** (§5) */
export function markReconcile(snapshot, actionId, reason, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (!['sending', 'sent', 'accepted', 'running'].includes(action.state)) {
    return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state}`);
  }
  action.state = 'reconcile';
  action.reason = isNonEmptyString(reason) ? reason : '送信結果が不明';
  action.updatedAt = iso(now);
  setReconcileWaiting(draft, action, now);
  return { ok: true, snapshot: draft, actionId };
}

/**
 * その Action の照合待ちを Case の契機にする。
 *
 * **自分を指している契機だけを書き換える** (`cancelActionOn` と同じ門・Fable 検収 (f))。
 * 門が無いと、owner 不在の `waiting(offer)` が別 Action の照合で上書きされ、
 * 「誰も引き受けていない」という一番読めなければならない状態が消える。
 */
function setReconcileWaiting(draft, action, now) {
  const target = draft.cases[action.caseId];
  if (!target || isTerminal(target)) return;
  if (target.nextTrigger?.actionId !== action.id) return;
  // 止めた Case は照合へ倒しても `active → waiting` に落とさない (§3「止めた Case は動かない」)。
  // 契機だけを解除待ちにしておけば、再開したときに元の state から続けられる
  if (pauseTriggerOn(draft, target, now)) return;
  target.nextTrigger = waitingTrigger({
    reason: 'reconcile',
    condition: `Action ${action.id} の送信結果を外部と照合する`,
    nextCheckAt: iso(toMs(now) + RECONCILE_TIMEOUT_MS),
    actionId: action.id,
  });
  if (target.state === 'active') target.state = 'waiting';
  touchCase(target, now);
}

/**
 * 取り消し (`cancelled`)。**未受付が確認できたときだけ予約を返す** (§5) —
 * 送信・受付が不明のまま返却すると、外で走っている job のぶんが二重に使える。
 */
export function cancelAction(snapshot, actionId, input, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  if (!['planned', 'sending', 'reconcile'].includes(action.state)) {
    return fail(snapshot, 'bad-state', `Action ${actionId} は ${action.state} なので取り消せない`);
  }
  if (action.state !== 'planned' && input?.confirmedUnaccepted !== true) {
    return fail(
      snapshot, 'unconfirmed',
      `Action ${actionId} は送信済みかもしれない — 未受付を確認 (confirmedUnaccepted) してから取り消す`,
    );
  }
  cancelActionOn(draft, action, { reason: input?.reason }, now);
  return { ok: true, snapshot: draft, actionId };
}

/** 取り消しの実体 (draft を直接書き換える)。照合の途中からも呼ぶので snapshot を差し替えない */
function cancelActionOn(draft, action, { reason }, now) {
  action.state = 'cancelled';
  action.reason = isNonEmptyString(reason) ? reason : '取り消し';
  action.updatedAt = iso(now);
  releaseReservation(draft, action, now);
  const target = draft.cases[action.caseId];
  if (!target || isTerminal(target)) return;
  // **この Action を指している契機だけ**を立て直す。「照合待ちなら何でも」にすると、
  // 別の Action を待っている条件文を上書きしてしまう (Opus2 指摘)
  if (target.nextTrigger?.actionId !== action.id) return;
  // 止めた Case は「次の一手を立て直す」ではなく「解除を待つ」— state も動かさない
  if (pauseTriggerOn(draft, target, now)) return;
  target.nextTrigger = waitingTrigger({
    reason: 'reconcile',
    condition: `Action ${action.id} は未受付で取り消した — 次の一手を立て直す`,
    nextCheckAt: defaultNextCheckAt(now),
  });
  if (target.state === 'active') target.state = 'waiting';
  touchCase(target, now);
}

/** その Action の Claim が「いまの世代」か (§4)。交代・辞退の後は false */
function generationCurrent(draft, action) {
  const claim = draft.claims?.[action.claimId];
  if (!claim) return false;
  const holder = acceptedClaim(draft, claim.caseId, claim.responsibility);
  if (!holder || holder.id !== claim.id) return false;
  return holder.generation === action.claimGeneration;
}

/**
 * 結果の保存 (`settled`、境界③)。
 *
 * **settle の時点で Claim の世代が現在と一致しなければ Case を動かさない** (§4) —
 * 旧世代の遅延応答は evidence として残すが、確定には使わない。
 * 成果物ありなら `active → verifying`、そうでなければ `next` (次の action か待ち条件) を必ず付ける。
 *
 * 受け付ける状態に **`reconcile` を含める** (受付記録があるものに限る)。走っている最中に Case が
 * 閉じたり担当が交代したりすると、生きた Action は `reconcile` へ倒れる — そこへ返ってきた結果を
 * 状態だけで弾くと、**job 完了の瞬間にしか手元に無い `result` と evidence が永久に消える**
 * (Opus2 再レビュー A)。照合は「外で走ったか」を後から復元できるが、その中身は復元できない。
 * 受付記録 (`delivery.runId`) が無い Action は、どの job の結果か照合できないので従来どおり断る。
 */
export function settleAction(snapshot, actionId, input, now) {
  const draft = clone(snapshot);
  const action = draft.actions?.[actionId];
  if (!action) return fail(snapshot, 'no-action', `Action が台帳に無い: ${actionId}`);
  const settleable = ['accepted', 'running'].includes(action.state)
    || (action.state === 'reconcile' && isNonEmptyString(action.delivery?.runId));
  if (!settleable) {
    return fail(
      snapshot, 'bad-state',
      action.state === 'reconcile'
        ? `Action ${actionId} は reconcile で受付記録 (delivery.runId) が無い — どの job の結果か照合できない`
        : `Action ${actionId} は ${action.state}`,
    );
  }
  const target = draft.cases[action.caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${action.caseId}`);

  action.state = 'settled';
  action.result = isPlainObject(input?.result) ? { ...input.result } : null;
  action.updatedAt = iso(now);

  let evidenceId = null;
  if (isPlainObject(input?.evidence)) {
    const added = addEvidenceOn(draft, { ...input.evidence, caseId: target.id, actionId: action.id }, now);
    if (!added.ok) return { ...added, snapshot };
    evidenceId = added.evidenceId;
  }

  if (isTerminal(target)) {
    // **終端の Case は動かさない** (§3「終端 → —」)。結果と証拠は残すが、closeReason も
    // resolution も契機も触らない — 閉じた Case が結果の到着で待ちに戻ると、
    // 「終わった」と読めるものが後から動く (Fable 検収 (a))
    action.reason = `Case ${target.id} は ${target.state} (終端) なので結果を確定に使わない`;
    return { ...terminalResult(draft, actionId), evidenceId };
  }

  if (!generationCurrent(draft, action)) {
    // 旧世代の結果は**証拠としてだけ**残す。Case は動かさない (§4)
    const note = addEvidenceOn(draft, {
      caseId: target.id,
      actionId: action.id,
      source: { kind: 'action', actionId: action.id, claimId: action.claimId },
      observed: { note: '旧世代の Claim による結果 — 確定に使わない' },
      claimed: isPlainObject(input?.result) ? { ...input.result } : null,
      conclusion: 'stale-generation',
    }, now);
    action.reason = '旧世代の Claim による結果なので Case を動かさない';
    detachTrigger(draft, target, action, {
      reason: 'reconcile',
      condition: `Action ${action.id} は旧世代の結果だった — 次の一手を立て直す`,
    }, now);
    return {
      ok: true, applied: false, code: 'stale-generation', snapshot: draft, actionId,
      evidenceId: note.ok ? note.evidenceId : evidenceId,
    };
  }

  if (target.stop) {
    // 結果は残すが Case は動かさない。**契機だけは立て直す** — 終わった Action を
    // 指したままだと不変条件に落ち、止めた後に返ってきた結果ごと保存できなくなる
    action.reason = '停止マーカーが付いている Case なので遷移しない';
    detachTrigger(draft, target, action, { reason: 'paused', condition: PAUSED_CONDITION }, now);
    return { ok: true, applied: false, code: 'stopped', snapshot: draft, actionId, evidenceId };
  }

  const hasArtifact = isPlainObject(input?.result) && input.result.artifact != null;
  if (hasArtifact && target.state === 'active') {
    target.state = 'verifying';
    target.nextTrigger = waitingTrigger({
      reason: 'evidence',
      condition: `Action ${action.id} の成果を検収する (検収者 ≠ 実装者)`,
      nextCheckAt: defaultNextCheckAt(now),
    });
    touchCase(target, now);
    return { ok: true, applied: true, snapshot: draft, actionId, evidenceId, state: target.state };
  }

  const applied = applyNextTrigger(draft, target, input?.next, now, { settledActionId: action.id });
  if (!applied.ok) return { ...applied, snapshot };
  return {
    ok: true, applied: true, snapshot: draft, actionId, evidenceId, state: target.state,
    // 契機が別の Action を指していたので触っていない (呼び出し側が「待ちを立てた」と誤解しないように)
    keptTrigger: applied.keptTrigger === true,
  };
}

/** まだ終わっていない Action の状態 (これを指している契機は「生きている」) */
const LIVE_ACTION_STATES = Object.freeze(['planned', 'sending', 'sent', 'accepted', 'running', 'reconcile']);

/**
 * 契機が「いま終わった Action」**以外**の、まだ生きている Action を指しているか。
 *
 * owner が決まった後に届く 2 通目の相談の返事 (occupied / 辞退 / 返事なし) は
 * `waiting(offer)` で settle される。owner が居るからと無条件に差し替えると、
 * owner の `nextAction` が消えて「owner 付きの引受け待ち」という読めない Case が残り、
 * その Action が送信前に取り消されると誰も動けなくなる (Fable 検収 2026-09-08)。
 */
function pointsAtOtherLiveAction(draft, target, settledActionId) {
  const actionId = target.nextTrigger?.actionId ?? null;
  if (!isNonEmptyString(actionId) || actionId === settledActionId) return false;
  return LIVE_ACTION_STATES.includes(draft.actions?.[actionId]?.state);
}

/**
 * 次の契機を差し替える (Action を終えた後・検収に落ちた後)。
 * **必ず次の action か待ち条件を付ける** — 付けずに保存できると Case が誰にも拾われず沈む。
 *
 * **責任主体が居ない Case の state は動かさない** (Fable 検収 (b))。owner を持たない Case は
 * まだ「誰が引き受けるか待ち」なので、そこへ `active` を書くと保存できない形になる
 * (`validateSnapshot` の「active / verifying なら owner あり」に落ちる)。
 * その場合でも**いま終わった Action を指している契機だけは立て直す** — 終わった Action を
 * 指したままの契機も保存できないため。
 *
 * @param {string|null} settledActionId いま終わった Action (契機を立て直す必要があるかの判定に使う)
 */
function applyNextTrigger(draft, target, next, now, { settledActionId = null } = {}) {
  if (!isPlainObject(next)) {
    return { ok: false, code: 'next-required', reason: '次の action (plan) か待ち条件 (waiting) を付ける' };
  }
  const hasOwner = isNonEmptyString(target.owner);

  if (isPlainObject(next.plan)) {
    // **断らずに Action は作る** (Fable 裁定 2026-09-08)。契機を動かすかは `planActionOn` の
    // 規則だけが決める。`planned` の Action は契機と無関係に `dispatchPlanned` が送るので、
    // S2-2 で恐れた「誰も指さない孤児と返らない予約」にはならない (あの前提が誤りだった) —
    // 相談 (authority の Claim で契機を取らずに植える Action) と同じ形で一貫する
    const planned = planActionOn(draft, { caseId: target.id, ...next.plan }, now);
    if (!planned.ok) return planned;
    // 契機を向けたのは planActionOn。**向けなかったなら active にもしない** —
    // 「担当は居るが契機は別の待ち」を active と書くと、状態と契機の説明がずれる
    if (hasOwner && planned.repointed) target.state = 'active';
    touchCase(target, now);
    return { ok: true, actionId: planned.actionId, keptTrigger: !planned.repointed };
  }
  if (isPlainObject(next.waiting)) {
    const waiting = {
      reason: next.waiting.reason,
      condition: next.waiting.condition,
      nextCheckAt: isNonEmptyString(next.waiting.nextCheckAt) ? next.waiting.nextCheckAt : defaultNextCheckAt(now),
    };
    const bad = badWaiting(waiting);
    if (bad) return { ok: false, code: 'invalid', reason: bad };
    // **待ちだけは自前で判断する。** 待ちは Action を作らないので `planActionOn` を通らない —
    // 差し替えてよいのは、契機がいま終わった Action 自身を指しているか、無いか、
    // 責任主体が居るとき。生きた別の Action を指しているならそちらを保つ (孤児は出ない)
    const keptForLive = settledActionId !== null && pointsAtOtherLiveAction(draft, target, settledActionId);
    const repoint = !keptForLive
      && (hasOwner
        || target.nextTrigger == null
        || (settledActionId !== null && target.nextTrigger?.actionId === settledActionId));
    if (!repoint) return { ok: true, actionId: null, keptTrigger: true };
    if (hasOwner) target.state = 'waiting';
    target.nextTrigger = waitingTrigger(waiting);
    touchCase(target, now);
    return { ok: true, actionId: null, keptTrigger: false };
  }
  return { ok: false, code: 'next-required', reason: '次の action (plan) か待ち条件 (waiting) を付ける' };
}

/**
 * `waiting → active` (§3)。**条件が成立した証拠を必ず残す** — 「もう大丈夫そう」で戻すと、
 * 何が変わって動き出したのかが後から読めない。
 */
export function resumeFromWaiting(snapshot, caseId, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  if (target.state !== 'waiting') return fail(snapshot, 'bad-state', `Case ${caseId} は ${target.state}`);
  if (target.stop) return fail(snapshot, 'stopped', `Case ${caseId} は停止マーカーが付いている`);
  if (!isPlainObject(input?.evidence)) {
    return fail(snapshot, 'evidence-required', '待ち条件が成立した証拠 (evidence) を付ける');
  }
  if (!isPlainObject(input?.plan)) {
    return fail(snapshot, 'plan-required', '再開するなら次の Action (plan) を同じ update で渡す');
  }
  if (!isNonEmptyString(target.owner)) {
    // 責任主体が居ない Case を active にはできない (§3・保存できない形になる)。
    // 待ちを解くより先に、引き受ける担当を決める必要がある
    return fail(
      snapshot, 'no-owner',
      `Case ${caseId} には責任主体 (owner) が居ない — active に戻す前に owner の Claim を accepted にする`,
    );
  }
  const added = addEvidenceOn(draft, { ...input.evidence, caseId }, now);
  if (!added.ok) return { ...added, snapshot };
  const planned = planActionOn(draft, { caseId, ...input.plan }, now);
  if (!planned.ok) return { ...planned, snapshot };
  target.state = 'active';
  target.nextTrigger = trigger('nextAction', { actionId: planned.actionId });
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId, actionId: planned.actionId, evidenceId: added.evidenceId };
}

// ---- 検収 (§3・§6) ----

/**
 * 引き受けたことがある Claim の状態。**誘われただけ (`offered`) や、断った・期限切れ
 * (`declined` / `expired`) は「実装側に立った」に数えない。**
 */
const ENGAGED_CLAIM_STATES = Object.freeze(['accepted', 'released', 'handed-over']);

/**
 * その Claim は一度でも引き受けられたか。
 *
 * 状態だけで見ると `expired` (担当消失) が漏れる — accepted の後に bot が居なくなった
 * 実装者は状態が `expired` になるので、状態リストだけでは実装側に数えられず、
 * **自分が書いたものを自分で検収できてしまう** (Fable 検収 (c))。受諾を経たかどうかは
 * `acceptedAt` と `generation` に残っているので、そちらを見る。
 */
function hasEngaged(claim) {
  if (ENGAGED_CLAIM_STATES.includes(claim.state)) return true;
  return isNonEmptyString(claim.acceptedAt)
    || (Number.isSafeInteger(claim.generation) && claim.generation > 0);
}

/**
 * その Case で**実際に実装側に立った** bot キー (検収者と同じなら自己検収)。
 *
 * 声を掛けられただけの bot まで数えると、二人同時受諾で `declined` に落ちた bot が
 * その Case を永久に検収できなくなる (Opus2 指摘 ④) — 自己検収の禁止は
 * 「自分の成果を自分で合格にしない」ためのもので、誘われた事実は成果ではない。
 *
 * `authority` も同じ理由で除外する (Opus2 指摘 ① 2026-09-08)。差配 (誰に相談するかを決める) は
 * 成果ではないし、authority の Claim は `ensureAuthorityClaimOn` が**すべての案件に**作るので、
 * 数えると既定の決定権者がどの案件も検収できなくなる。
 */
function implementerKeys(draft, caseId) {
  const keys = new Set();
  for (const claim of Object.values(draft.claims ?? {})) {
    if (claim.caseId !== caseId) continue;
    if (claim.responsibility === 'assessor' || claim.responsibility === 'authority') continue;
    if (!hasEngaged(claim)) continue;
    if (isNonEmptyString(claim.botKey)) keys.add(claim.botKey);
  }
  return keys;
}

/**
 * 検収合格 (`verifying → resolved`)。
 *
 * 必要条件 (§3・§6): 検収者 ≠ 実装者 / 検収者の bot・run ID・model ID / Case の `acceptance` の版 /
 * 対象の版 (`subjectRevision`)。どれか欠けたら合格にしない — 「誰がどの版を見て合格にしたか」が
 * 残らない合格は、後から検証できないので合格ではない。
 */
export function acceptVerification(snapshot, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[input?.caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${input?.caseId}`);
  if (isTerminal(target)) return fail(snapshot, 'terminal', `Case ${target.id} は ${target.state} (終端)`);
  if (target.state !== 'verifying') return fail(snapshot, 'bad-state', `Case ${target.id} は ${target.state}`);
  if (target.stop) return fail(snapshot, 'stopped', `Case ${target.id} は停止マーカーが付いている`);

  const assessor = input?.assessor;
  for (const key of ['botKey', 'runId', 'modelId']) {
    if (!isNonEmptyString(assessor?.[key])) {
      return fail(snapshot, 'assessor-identity', `検収者の ${key} が要る (bot 名だけでは足りない — §6)`);
    }
  }
  if (implementerKeys(draft, target.id).has(assessor.botKey)) {
    return fail(snapshot, 'self-review', `検収者 ${assessor.botKey} はこの Case の実装側 — 自己検収は通さない`);
  }
  if (input?.acceptanceVersion !== target.acceptance.version) {
    return fail(
      snapshot, 'acceptance-version',
      `検収した acceptance の版 (${input?.acceptanceVersion}) が Case の版 (${target.acceptance.version}) と違う`,
    );
  }
  if (!isNonEmptyString(input?.subjectRevision)) {
    return fail(snapshot, 'subject-revision', '対象の版 (subjectRevision: commit / task revision / 台帳 revision) が要る');
  }
  if (!isPlainObject(input?.observed)) {
    return fail(snapshot, 'observed-required', '検収の結論は observed (実行で確認された事実) に結ぶ (§6)');
  }

  const added = addEvidenceOn(draft, {
    caseId: target.id,
    source: { kind: 'bot', botKey: assessor.botKey, runId: assessor.runId, modelId: assessor.modelId },
    subjectRevision: input.subjectRevision,
    methodVersion: input.methodVersion ?? null,
    observed: input.observed,
    claimed: input.claimed ?? null,
    assessor: assessor.botKey,
    conclusion: 'accepted',
    uncertainty: input.uncertainty ?? null,
  }, now);
  if (!added.ok) return { ...added, snapshot };

  // 終端にする前に、まだ生きている Action を片付ける (§4 と同じ「確定操作をできなくする」)
  const swept = sweepLiveActions(draft, target.id, `Case ${target.id} が resolved になった`, now);

  target.state = 'resolved';
  target.nextTrigger = null;
  target.resolution = {
    evidenceId: added.evidenceId,
    assessor: { ...assessor },
    acceptanceVersion: target.acceptance.version,
    subjectRevision: input.subjectRevision,
    at: iso(now),
  };
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId: target.id, evidenceId: added.evidenceId, ...swept };
}

/**
 * 終端にする Case に残っている「生きた Action」を片付ける (§4「確定操作をできなくする」)。
 *
 * - `planned` は外へ出ていないので `cancelled` にして**予約を返す**
 * - `sending | sent | accepted | running` は外で走っているかもしれないので `reconcile` へ倒す
 *   — **未受付と決めない**。予約も返さない (返すと、外で走っている job のぶんが二重に使える)
 *
 * 片付けないと、終端の Case に紐づく Action が後から settle されて
 * 「閉じたはずの Case が動く」経路が残る (Fable 検収 (a))。
 */
function sweepLiveActions(draft, caseId, why, now) {
  const cancelledActionIds = [];
  const reconciledActionIds = [];
  for (const action of Object.values(draft.actions ?? {})) {
    if (action.caseId !== caseId) continue;
    if (action.state === 'planned') {
      cancelActionOn(draft, action, { reason: `${why} — 未送信なので取り消し` }, now);
      cancelledActionIds.push(action.id);
    } else if (['sending', 'sent', 'accepted', 'running'].includes(action.state)) {
      action.state = 'reconcile';
      action.reason = `${why} — 外部の状態が不明なので照合へ回す`;
      action.updatedAt = iso(now);
      reconciledActionIds.push(action.id);
    }
  }
  return { cancelledActionIds, reconciledActionIds };
}

/** 不合格・証拠不足 (`verifying → active | waiting`)。**次の action か待ち条件を必ず付ける** (§3) */
export function rejectVerification(snapshot, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[input?.caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${input?.caseId}`);
  if (target.state !== 'verifying') return fail(snapshot, 'bad-state', `Case ${target.id} は ${target.state}`);
  if (target.stop) return fail(snapshot, 'stopped', `Case ${target.id} は停止マーカーが付いている`);

  let evidenceId = null;
  if (isPlainObject(input?.evidence)) {
    const added = addEvidenceOn(draft, { ...input.evidence, caseId: target.id, conclusion: 'rejected' }, now);
    if (!added.ok) return { ...added, snapshot };
    evidenceId = added.evidenceId;
  }
  const applied = applyNextTrigger(draft, target, input?.next, now);
  if (!applied.ok) return { ...applied, snapshot };
  return { ok: true, snapshot: draft, caseId: target.id, evidenceId, state: target.state };
}

// ---- 終結・親子・依存・参照・停止 (§3・§7) ----

/** 理由付きの終結 (`closed`)。**成功に数えない** */
export function closeCase(snapshot, caseId, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  if (isTerminal(target)) return fail(snapshot, 'terminal', `Case ${caseId} は既に ${target.state} (終端)`);
  if (!CLOSE_REASONS.includes(input?.closeReason)) {
    return fail(snapshot, 'invalid', `closeReason が不明 (${CLOSE_REASONS.join(' | ')})`);
  }
  if (input.closeReason === 'superseded') {
    const successor = draft.cases?.[input?.supersededBy];
    if (!successor) {
      return fail(snapshot, 'invalid', 'superseded で閉じるなら、引き継ぐ新しい Case の ID (supersededBy) が要る');
    }
    successor.supersedes = caseId;
    touchCase(successor, now);
    target.supersededBy = successor.id;
  }
  // 閉じる前に生きた Action を片付ける — 残すと「閉じた Case が結果の到着で動く」(検収 (a))
  const swept = sweepLiveActions(draft, caseId, `Case ${caseId} が closed (${input.closeReason}) になった`, now);

  target.state = 'closed';
  target.closeReason = input.closeReason;
  target.closeNote = isNonEmptyString(input.note) ? input.note : null;
  target.nextTrigger = null;
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId, ...swept };
}

/**
 * 親を子へ分割する。**親の `owner` はそのまま残る** (§3) —
 * 子が全部 `resolved` になっても親は自動で `resolved` にならない (親の検収は親の `acceptance` で別に行う)。
 */
export function createChildCase(snapshot, parentId, input, now) {
  const draft = clone(snapshot);
  const parent = draft.cases?.[parentId];
  if (!parent) return fail(snapshot, 'no-case', `Case が台帳に無い: ${parentId}`);
  if (isTerminal(parent)) return fail(snapshot, 'terminal', `Case ${parentId} は ${parent.state} (終端)`);
  if (!isNonEmptyString(input?.desiredOutcome)) {
    return fail(snapshot, 'invalid', '子 Case には desiredOutcome が要る');
  }
  if (!isNonEmptyString(input?.acceptance?.condition) || !isPositiveInt(input?.acceptance?.version)) {
    return fail(snapshot, 'invalid', '子 Case には acceptance {condition, version} が要る');
  }
  const id = takeId(draft, ID_PREFIXES.case);
  draft.cases[id] = {
    id,
    version: 1,
    mandateId: parent.mandateId,
    mandateVersion: parent.mandateVersion,
    // 事象キーは継承しない — 分割で作った子に同じキーを持たせると、次の Finding の追記先が割れる
    eventKey: null,
    findingIds: [],
    desiredOutcome: input.desiredOutcome,
    acceptance: { condition: input.acceptance.condition, version: input.acceptance.version },
    owner: null,
    budget: {
      allocated: isPositiveInt(input.budget?.allocated) ? input.budget.allocated : null,
      reserved: 0,
      charged: 0,
    },
    links: [],
    dependencies: [],
    parentId,
    childIds: [],
    nextTrigger: waitingTrigger({
      reason: 'offer',
      condition: 'owner の Claim が accepted になる',
      nextCheckAt: defaultNextCheckAt(now),
    }),
    state: 'open',
    stop: null,
    closeReason: null,
    supersedes: null,
    supersededBy: null,
    resolution: null,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  parent.childIds.push(id);
  touchCase(parent, now);
  return { ok: true, snapshot: draft, caseId: id, parentId };
}

/** 依存の登録。**循環 (A→B→A・3 つ以上の環) は登録の時点で断る** (§3) */
export function addDependency(snapshot, caseId, dependency, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  const other = draft.cases?.[dependency?.caseId];
  if (!other) return fail(snapshot, 'no-case', `依存先の Case が台帳に無い: ${dependency?.caseId}`);
  if (!DEPENDENCY_CONDITIONS.includes(dependency?.condition)) {
    return fail(snapshot, 'invalid', `依存の condition が不明 (${DEPENDENCY_CONDITIONS.join(' | ')})`);
  }
  if (dependency.caseId === caseId) return fail(snapshot, 'cycle', '自分自身には依存できない');
  const already = target.dependencies.some((d) => d.caseId === dependency.caseId && d.condition === dependency.condition);
  if (!already) {
    target.dependencies.push({
      caseId: dependency.caseId,
      condition: dependency.condition,
      revision: dependency.revision ?? null,
    });
  }
  const cycle = findDependencyCycle(draft.cases);
  if (cycle) {
    return fail(snapshot, 'cycle', `依存が循環する: ${cycle.join(' → ')}`);
  }
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId };
}

/**
 * 既存台帳への参照 (§7)。**明示的に結んだものだけ** — 既存 task の自動移行はしない
 * (過去の正常運転を成功案件として台帳に書かないため)。
 */
export function linkCase(snapshot, caseId, link, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  if (!LINK_KINDS.includes(link?.kind)) {
    return fail(snapshot, 'invalid', `link.kind が不明 (${LINK_KINDS.join(' | ')})`);
  }
  if (!isNonEmptyString(link?.id)) return fail(snapshot, 'invalid', 'link.id が要る');
  if (!isNonEmptyString(link?.role)) {
    return fail(snapshot, 'invalid', 'link.role が要る (この参照が Case の中で何なのか)');
  }
  const entry = {
    kind: link.kind,
    id: String(link.id),
    revision: link.revision ?? null,
    role: link.role,
    at: iso(now),
  };
  const index = target.links.findIndex((l) => l.kind === entry.kind && l.id === entry.id);
  if (index >= 0) target.links[index] = entry;
  else target.links.push(entry);
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId };
}

/**
 * 停止マーカーを付ける (§3)。tick・新しい担当・別 Case からの付替えで復活しない。
 * 解除は `resumeCase` の明示操作だけ。
 */
export function stopCase(snapshot, caseId, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  if (isTerminal(target)) return fail(snapshot, 'terminal', `Case ${caseId} は ${target.state} (終端)`);
  if (!STOP_SOURCES.includes(input?.by)) {
    return fail(snapshot, 'invalid', `stop.by が不明 (${STOP_SOURCES.join(' | ')})`);
  }
  target.stop = {
    by: input.by,
    at: iso(now),
    actionId: isNonEmptyString(input.actionId) ? input.actionId : null,
    sourceId: isNonEmptyString(input.sourceId) ? input.sourceId : null,
    reason: isNonEmptyString(input.reason) ? input.reason : null,
  };
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId };
}

/**
 * 停止した Action をそのまま立て直せない理由 (無ければ null)。
 *
 * **相談 (`consult`) は立て直さない** — 申し出は `offered` のまま残っているか期限で閉じており、
 * 同じ相手にもう一度声を掛けるかは人が決めることで、停止の解除に含めるものではない。
 */
function replanGap(draft, action) {
  if (!action) return '停止した Action が台帳に無い';
  if (!['settled', 'cancelled'].includes(action.state)) {
    return `${action.id} は ${action.state} でまだ終わっていない`;
  }
  if (action.kind === 'consult' || isNonEmptyString(action.offerClaimId)) {
    return `${action.id} は相談 (consult) — 引受けの申し出は立て直さない`;
  }
  const claim = draft.claims?.[action.claimId] ?? null;
  if (!claim || claim.state !== 'accepted' || !generationCurrent(draft, action)) {
    return `${action.claimId} は accepted のいまの世代ではない`;
  }
  return null;
}

/**
 * 停止の解除。**`by: 'human-message'` は通さない** (§3) —
 * 人間の発言で解除できると、「止めて」と言った後の雑談で勝手に動き出す。
 *
 * 契機が `waiting(paused)` (= 止めた時点で走っていた仕事が停止で終わった形) なら、
 * **止めた Action と同じ Claim・kind・宛先で一手を立て直す** — task の `/retry` と同じ意味で、
 * 「止めて、また動かす」を人が 2 回操作しなくて済むようにする。立て直せないときは理由を
 * `waiting(evidence)` の条件に残す (黙って解除だけすると、誰も次を決めない Case になる)。
 *
 * @returns {{ok: boolean, snapshot: object, caseId?: string, replanned?: string|null, code?: string}}
 *   `code` は `replanned` (立て直した) / `needs-plan` (立て直せない) / `resumed` (解除だけ)
 */
export function resumeCase(snapshot, caseId, input, now) {
  const draft = clone(snapshot);
  const target = draft.cases?.[caseId];
  if (!target) return fail(snapshot, 'no-case', `Case が台帳に無い: ${caseId}`);
  if (!target.stop) return fail(snapshot, 'not-stopped', `Case ${caseId} は停止していない`);
  if (!RESUME_SOURCES.includes(input?.by)) {
    return fail(
      snapshot, 'not-allowed',
      `停止を解除できるのは ${RESUME_SOURCES.join(' / ')} だけ (受け取った値: ${JSON.stringify(input?.by)}) — `
      + '人間の発言 (human-message) では解除しない',
    );
  }
  const stop = target.stop;
  target.stop = null;
  target.resumedAt = iso(now);
  target.resumedBy = input.by;

  let replanned = null;
  let code = 'resumed';
  if (target.nextTrigger?.kind === 'waiting' && target.nextTrigger.reason === 'paused') {
    const stopped = isNonEmptyString(stop?.actionId) ? draft.actions?.[stop.actionId] ?? null : null;
    const gap = replanGap(draft, stopped);
    const planned = gap ? null : planActionOn(draft, {
      caseId,
      claimId: stopped.claimId,
      kind: stopped.kind,
      target: stopped.target,
      note: `再開: ${stopped.id} の続き${isNonEmptyString(stopped.note) ? ` — ${stopped.note}` : ''}`,
      contractRef: stopped.contractRef,
      budget: { source: stopped.budget?.source ?? null },
    }, now);
    if (planned?.ok) {
      replanned = planned.actionId;
      code = 'replanned';
      // **契機は必ずこの一手へ向ける。** 立て直したのに `waiting(paused)` のままだと、
      // 停止が解けているのに「解除待ち」と読める Case が残る (planActionOn の規則は
      // 「生きた仕事を奪わない」ためのもので、ここには奪う相手が居ない)
      target.nextTrigger = trigger('nextAction', { actionId: replanned });
    } else {
      code = 'needs-plan';
      target.nextTrigger = waitingTrigger({
        reason: 'evidence',
        condition: `停止は解除したが前の一手を立て直せない (${gap ?? `${planned.code}: ${planned.reason}`}) — `
          + 'owner の next.plan か /case offer で次の一手を決める',
        nextCheckAt: defaultNextCheckAt(now),
      });
    }
  }
  touchCase(target, now);
  return { ok: true, snapshot: draft, caseId, replanned, code };
}

// ---- Evidence / Observation / RoleTrial (§2・§6) ----

function addEvidenceOn(draft, input, now) {
  if (!isPlainObject(input?.source)) {
    return { ok: false, code: 'invalid', reason: 'evidence には source (bot / run ID / コマンド / 人間) が要る' };
  }
  if (!isPlainObject(input?.observed) && !isPlainObject(input?.claimed)) {
    return { ok: false, code: 'invalid', reason: 'evidence には observed か claimed のどちらかが要る' };
  }
  const id = takeId(draft, ID_PREFIXES.evidence);
  draft.evidence[id] = {
    id,
    caseId: input.caseId ?? null,
    actionId: input.actionId ?? null,
    source: { ...input.source },
    at: iso(now),
    subjectRevision: input.subjectRevision ?? null,
    methodVersion: input.methodVersion ?? null,
    // **主張と観測を分ける** (§6) — 検収の結論は observed にだけ結ぶ
    observed: isPlainObject(input.observed) ? { ...input.observed } : null,
    claimed: isPlainObject(input.claimed) ? { ...input.claimed } : null,
    assessor: input.assessor ?? null,
    conclusion: input.conclusion ?? null,
    uncertainty: input.uncertainty ?? null,
  };
  return { ok: true, evidenceId: id };
}

/** 証拠を残す。**元ログの保持期限を越えて読めるよう、必要な値を写しておく** (§6) */
export function addEvidence(snapshot, input, now) {
  const draft = clone(snapshot);
  const added = addEvidenceOn(draft, input, now);
  if (!added.ok) return { ...added, snapshot };
  return { ok: true, snapshot: draft, evidenceId: added.evidenceId };
}

/**
 * 観測 (`O-`) と役割 trial (`RT-`) は **S1 では形だけ** (作成と保存)。
 * 遷移 (`effective` / `ineffective` / `reverted` / `inconclusive` の判定) は S5 / S6 で足す。
 */
function createTrialRecord(snapshot, prefix, input, now) {
  const draft = clone(snapshot);
  for (const key of ['purpose', 'hypothesis', 'owner', 'comparison']) {
    if (!isNonEmptyString(input?.[key])) {
      return fail(snapshot, 'invalid', `${prefix} 記録には ${key} が要る`);
    }
  }
  if (!isPositiveInt(input?.deadline?.durationMin) || !isNonEmptyString(input?.deadline?.at)) {
    return fail(snapshot, 'invalid', `${prefix} 記録には deadline {durationMin, at} が要る`);
  }
  const id = takeId(draft, prefix);
  const record = {
    id,
    version: isPositiveInt(input.version) ? input.version : 1,
    purpose: input.purpose,
    hypothesis: input.hypothesis,
    owner: input.owner,
    comparison: input.comparison,
    deadline: { durationMin: input.deadline.durationMin, at: input.deadline.at, extended: false },
    decision: 'pending',
    createdAt: iso(now),
  };
  if (prefix === ID_PREFIXES.observation) draft.observations[id] = record;
  else draft.roleTrials[id] = record;
  return { ok: true, snapshot: draft, id };
}

export function createObservation(snapshot, input, now) {
  return createTrialRecord(snapshot, ID_PREFIXES.observation, input, now);
}

export function createRoleTrial(snapshot, input, now) {
  return createTrialRecord(snapshot, ID_PREFIXES.roleTrial, input, now);
}

/** 不一致が続いている一期間 (§3)。bridge が発行し、同じ事象は同じ episode を使う */
export function openEpisode(snapshot, episodeId, input, now) {
  const draft = clone(snapshot);
  if (!isNonEmptyString(episodeId)) return fail(snapshot, 'invalid', 'episodeId が要る');
  if (!isPlainObject(draft.episodes)) draft.episodes = {};
  if (draft.episodes[episodeId]) return { ok: true, snapshot: draft, episodeId, created: false };
  draft.episodes[episodeId] = {
    id: episodeId,
    mandateId: input?.mandateId ?? null,
    conditionId: input?.conditionId ?? null,
    subjectId: input?.subjectId ?? null,
    openedAt: iso(now),
    closedAt: null,
  };
  return { ok: true, snapshot: draft, episodeId, created: true };
}

// ---- 照合 (§5・§7 の境界①〜③) ----

/**
 * 外部 (Discord の投稿・JobRun) を **Action ID で**探し直す (§5 の `reconcile`)。
 *
 * `probe` は `{messageFor(actionId) → messageId|null, runFor(actionId) → runId|null}`。
 * 本物の Discord / JobRun を注入する場所で、ここには I/O を持たせない。
 *
 * - 見つかれば `sent` / `accepted` へ進める (**再送しない**)。
 * - 送信から `RECONCILE_TIMEOUT_MS` (2 分) 以上たっても見つからなければ `cancelled` にして予約を返す。
 * - **冪等**: 何度呼んでも同じ結果に収束し、同じ操作 ID の Action が増えない (二重起票・二重計上をしない)。
 *
 * `hold` は**判断を保留する Action ID**。probe が「探したが無かった」と「探せなかった」を
 * 区別できないので、後者は呼び出し側が名指しで預ける — 預かった Action は状態を動かさず
 * `pending` に入れる (2 分の取り消しもしない)。外側を確かめられないまま未受付と決めると、
 * 届いている起動を取り消してしまう (Fable 検収 2026-09-07 の裁定)。
 *
 * @param {{hold?: string[]}} [options] 既定は空 = 従来どおり全件を判断する
 */
export function reconcileActions(snapshot, probe, now, { hold = [] } = {}) {
  const draft = clone(snapshot);
  const held = new Set((Array.isArray(hold) ? hold : []).map((id) => String(id)));
  const at = toMs(now);
  const resolved = [];
  const accepted = [];
  const cancelled = [];
  const pending = [];
  // 受け付けられていたが、そのときの担当はもう居ない (受付と消費だけ確定して Case は動かさない)
  const stale = [];

  for (const action of Object.values(draft.actions ?? {})) {
    if (!['sending', 'sent', 'reconcile'].includes(action.state)) continue;
    if (held.has(action.id)) {
      // 外側を確かめられなかった Action。**状態も予約も動かさない** (次の tick でやり直す)
      pending.push(action.id);
      continue;
    }

    const runId = probe?.runFor ? probe.runFor(action.id) : null;
    const messageId = probe?.messageFor ? probe.messageFor(action.id) : null;

    if (isNonEmptyString(messageId) && !isNonEmptyString(action.delivery.messageId)) {
      action.delivery.messageId = messageId;
      action.delivery.sentAt = action.delivery.sentAt ?? iso(now);
    }
    if (isNonEmptyString(runId)) {
      // 受け付けられていた — 予約を確定に振り替える (二重計上しないよう charge は 1 回だけ)
      if (action.delivery.runId && action.delivery.runId !== runId) {
        pending.push(action.id);
        continue;
      }
      action.state = 'accepted';
      action.delivery.runId = runId;
      action.updatedAt = iso(now);
      // 受付記録と消費は**世代に関係なく**確定する (外で 1 件走ったのは動かせない事実)
      chargeReservation(draft, action, now);
      if (!generationCurrent(draft, action)) {
        // 旧世代の受付では Case を動かさない — 担当が空いている Case を
        // 「責任者不在のまま active」にしてしまうため (Opus2 指摘 ②)
        action.reason = '旧世代の Claim による受付 — 結果は確定に使わない';
        stale.push(action.id);
      }
      noteDelivered(draft, action, now);
      accepted.push(action.id);
      continue;
    }
    if (isNonEmptyString(messageId)) {
      if (action.state !== 'sent') {
        action.state = 'sent';
        action.updatedAt = iso(now);
      }
      resolved.push(action.id);
      continue;
    }

    const sentAt = Date.parse(action.delivery.sentAt ?? action.delivery.sendingAt ?? action.createdAt);
    if (Number.isFinite(sentAt) && at - sentAt >= RECONCILE_TIMEOUT_MS) {
      // 送信から 2 分たっても外に無い = 未受付が確認できた。**ここで初めて**予約を返す (§5)
      cancelActionOn(draft, action, {
        reason: `照合で見つからなかった (送信から ${Math.round((at - sentAt) / 1000)} 秒)`,
      }, now);
      cancelled.push(action.id);
      continue;
    }
    if (action.state !== 'reconcile') {
      action.state = 'reconcile';
      action.reason = '送信結果が不明 — 照合待ち';
      action.updatedAt = iso(now);
      setReconcileWaiting(draft, action, now);
    }
    pending.push(action.id);
  }

  return { ok: true, snapshot: draft, sent: resolved, accepted, cancelled, pending, stale };
}

// ---- 保存時の不変条件 (§3) ----

/**
 * スナップショットが保存してよい形か。**1 件でも返れば `update` は何も書かない**
 * (`src/society-store.js` が呼ぶ)。
 *
 * @returns {string[]} 人間向けのエラー行 (空配列 = 保存してよい)
 */
export function validateSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return ['スナップショットが object ではない'];
  const errors = [];
  for (const name of [...Object.keys(COLLECTION_PREFIXES), 'episodes', 'counters']) {
    if (!isPlainObject(snapshot[name])) errors.push(`${name} は ID をキーにした object で持つ (配列にしない)`);
  }
  if (errors.length > 0) return errors;

  // ID の重複なし・counters の単調 (採番は再利用しない)
  for (const [name, prefix] of Object.entries(COLLECTION_PREFIXES)) {
    let max = 0;
    for (const [key, record] of Object.entries(snapshot[name])) {
      if (!isPlainObject(record)) {
        errors.push(`${name}.${key} が object ではない`);
        continue;
      }
      if (record.id !== key) errors.push(`${name}.${key} の id (${record.id}) がキーと一致しない`);
      const m = /^(.+)-(\d+)$/.exec(key);
      if (!m || m[1] !== prefix) {
        errors.push(`${name}.${key} の ID は ${prefix}-<整数> の形で採る`);
        continue;
      }
      max = Math.max(max, Number(m[2]));
    }
    const counter = snapshot.counters[prefix];
    if (counter !== undefined && !Number.isSafeInteger(counter)) {
      errors.push(`counters.${prefix} は整数で持つ`);
    } else if ((counter ?? 0) < max) {
      errors.push(`counters.${prefix} (${counter ?? 0}) が採番済みの ${prefix}-${max} より小さい — ID を再利用してしまう`);
    }
  }

  for (const [id, target] of Object.entries(snapshot.cases)) {
    if (!CASE_STATES.includes(target.state)) {
      errors.push(`cases.${id}.state が不明: ${JSON.stringify(target.state)} (${CASE_STATES.join(' | ')})`);
      continue;
    }
    if (target.mandateId && !snapshot.mandates[target.mandateId]) {
      errors.push(`cases.${id}.mandateId が台帳に無い: ${target.mandateId}`);
    }
    for (const findingId of target.findingIds ?? []) {
      if (!snapshot.findings[findingId]) errors.push(`cases.${id}.findingIds に無い Finding: ${findingId}`);
    }
    if (isTerminal(target)) {
      // **終端 Case は次の契機を持たない** (§3「終端 → —」)。持っていると、
      // tick も照合もそこを見て動き出せてしまう
      if (target.nextTrigger != null) {
        errors.push(
          `cases.${id} は ${target.state} (終端) なのに次の契機 (nextTrigger) を持っている — `
          + '終端の Case が後から動く経路になる',
        );
      }
      if (target.state === 'closed' && target.closeReason === 'superseded'
          && !snapshot.cases[target.supersededBy]) {
        errors.push(
          `cases.${id} は superseded で閉じているのに、引き継ぎ先 (supersededBy: `
          + `${JSON.stringify(target.supersededBy ?? null)}) が台帳に無い — 続きをたどれない`,
        );
      }
      if (target.state === 'closed' && !CLOSE_REASONS.includes(target.closeReason)) {
        errors.push(`cases.${id} は closed なのに closeReason が不明 (${CLOSE_REASONS.join(' | ')})`);
      }
      if (target.state === 'resolved' && !isPlainObject(target.resolution)) {
        errors.push(`cases.${id} は resolved なのに検収の記録 (resolution) が無い`);
      }
    } else {
      errors.push(...validateNextTrigger(snapshot, id, target));
    }
    if (target.stop && !STOP_SOURCES.includes(target.stop.by)) {
      errors.push(`cases.${id}.stop.by が不明 (${STOP_SOURCES.join(' | ')})`);
    }
    // **動いている Case には責任主体が要る。** owner の居ない active / verifying は、
    // 担当が消えたのに waiting(offer) へ倒し損ねた形で、責任の空白が読めなくなる
    if (['active', 'verifying'].includes(target.state) && !target.owner) {
      errors.push(
        `cases.${id} は ${target.state} なのに責任主体 (owner) が居ない — `
        + '担当が空いた Case は waiting(offer) で「誰が引き受けるかを待っている」と読めなければならない',
      );
    }
    if (target.owner) {
      const owner = snapshot.claims[target.owner];
      if (!owner) errors.push(`cases.${id}.owner が台帳に無い Claim を指している: ${target.owner}`);
      else if (owner.state !== 'accepted') errors.push(`cases.${id}.owner (${owner.id}) が accepted でない (${owner.state})`);
      else if (owner.caseId !== id) errors.push(`cases.${id}.owner (${owner.id}) が別の Case の Claim`);
    }
    if (target.parentId) {
      const parent = snapshot.cases[target.parentId];
      if (!parent) errors.push(`cases.${id}.parentId が台帳に無い: ${target.parentId}`);
      else if (!(parent.childIds ?? []).includes(id)) errors.push(`cases.${target.parentId}.childIds に ${id} が無い`);
    }
    for (const dep of target.dependencies ?? []) {
      if (!snapshot.cases[dep?.caseId]) errors.push(`cases.${id}.dependencies に無い Case: ${dep?.caseId}`);
      if (!DEPENDENCY_CONDITIONS.includes(dep?.condition)) {
        errors.push(`cases.${id}.dependencies の condition が不明: ${JSON.stringify(dep?.condition)}`);
      }
    }
    for (const link of target.links ?? []) {
      if (!LINK_KINDS.includes(link?.kind)) errors.push(`cases.${id}.links の kind が不明: ${JSON.stringify(link?.kind)}`);
    }
  }

  const cycle = findDependencyCycle(snapshot.cases);
  if (cycle) errors.push(`Case の依存が循環している: ${cycle.join(' → ')} — 保存できない`);

  // 同一責務の accepted は同時 1 件 (§4)
  const holders = new Map();
  for (const [id, claim] of Object.entries(snapshot.claims)) {
    if (!CLAIM_STATES.includes(claim.state)) {
      errors.push(`claims.${id}.state が不明: ${JSON.stringify(claim.state)} (${CLAIM_STATES.join(' | ')})`);
    }
    if (!snapshot.cases[claim.caseId]) errors.push(`claims.${id}.caseId が台帳に無い: ${claim.caseId}`);
    if (claim.state !== 'accepted') continue;
    const key = JSON.stringify([claim.caseId, claim.responsibility]);
    if (holders.has(key)) {
      errors.push(
        `同一責務の accepted が 2 件ある: ${holders.get(key)} と ${id} `
        + `(case ${claim.caseId} / ${claim.responsibility}) — 責任主体は 1 件でなければ読めない`,
      );
    } else {
      holders.set(key, id);
    }
  }

  for (const [id, action] of Object.entries(snapshot.actions)) {
    if (!ACTION_STATES.includes(action.state)) {
      errors.push(`actions.${id}.state が不明: ${JSON.stringify(action.state)} (${ACTION_STATES.join(' | ')})`);
    }
    if (!snapshot.cases[action.caseId]) errors.push(`actions.${id}.caseId が台帳に無い: ${action.caseId}`);
    if (!snapshot.claims[action.claimId]) errors.push(`actions.${id}.claimId が台帳に無い: ${action.claimId}`);
    if (action.state === 'accepted' && !isNonEmptyString(action.delivery?.runId)) {
      errors.push(`actions.${id} は accepted なのに受付記録 (delivery.runId) が無い`);
    }
    if (action.state === 'accepted' && action.budget?.charged !== true) {
      errors.push(`actions.${id} は accepted なのに消費が確定していない (budget.charged)`);
    }
    // 相談が伴う申し出は、同じ Case の Claim でなければならない — 別 Case の Claim を
    // 指した相談は、受諾したときに責任が別の案件へ付いてしまう
    if (action.offerClaimId) {
      const offered = snapshot.claims[action.offerClaimId];
      if (!offered) {
        errors.push(`actions.${id}.offerClaimId が台帳に無い: ${action.offerClaimId}`);
      } else if (offered.caseId !== action.caseId) {
        errors.push(
          `actions.${id}.offerClaimId (${action.offerClaimId}) が別の Case (${offered.caseId}) の Claim を指している`,
        );
      }
    }
    // 終端 Case にこれから送る予定の Action は残せない (閉じた案件が動き出す)
    if (action.state === 'planned' && isTerminal(snapshot.cases[action.caseId])) {
      errors.push(
        `actions.${id} は planned なのに Case ${action.caseId} は `
        + `${snapshot.cases[action.caseId].state} (終端) — 終端にする時点で cancelled にする`,
      );
    }
  }

  for (const [id, evidence] of Object.entries(snapshot.evidence)) {
    if (evidence.caseId && !snapshot.cases[evidence.caseId]) {
      errors.push(`evidence.${id}.caseId が台帳に無い: ${evidence.caseId}`);
    }
    if (!isPlainObject(evidence.source)) errors.push(`evidence.${id}.source が無い (出所の無い証拠は使えない)`);
  }

  for (const [id, finding] of Object.entries(snapshot.findings)) {
    if (!FINDING_DISPOSITIONS.includes(finding.disposition)) {
      errors.push(`findings.${id}.disposition が不明: ${JSON.stringify(finding.disposition)}`);
    }
    if (finding.caseId && !snapshot.cases[finding.caseId]) {
      errors.push(`findings.${id}.caseId が台帳に無い: ${finding.caseId}`);
    }
  }
  return errors;
}

function validateNextTrigger(snapshot, id, target) {
  const next = target.nextTrigger;
  if (!isPlainObject(next)) {
    return [
      `cases.${id} (${target.state}) に次の契機が無い — `
      + 'runningAction / nextAction / waiting のいずれかを必ず持つ (§3 の不変条件)',
    ];
  }
  if (next.kind === 'waiting') {
    const bad = badWaiting(next);
    if (bad) return [`cases.${id}.nextTrigger: ${bad}`];
    // **owner が居るのに引受け待ちは読めない。** 担当は決まっているのに「誰かが引き受けるのを
    // 待つ」契機になっている Case は、誰も満たせない条件で止まる (再 offer は occupied で断られ、
    // owner は既に accepted)。2 通目の相談の返事が owner の契機を潰す形で作れていた
    if (next.reason === 'offer' && isNonEmptyString(target.owner)) {
      return [
        `cases.${id} は owner (${target.owner}) が居るのに nextTrigger が waiting(offer) — `
        + 'owner が居るのに引受け待ちは読めない (誰も満たせない条件で止まる)',
      ];
    }
    return [];
  }
  if (next.kind === 'runningAction' || next.kind === 'nextAction') {
    const action = snapshot.actions[next.actionId];
    if (!action) return [`cases.${id}.nextTrigger が台帳に無い Action を指している: ${next.actionId}`];
    if (action.caseId !== id) return [`cases.${id}.nextTrigger が別の Case の Action を指している: ${next.actionId}`];
    if (next.kind === 'nextAction' && action.state !== 'planned') {
      return [`cases.${id}.nextTrigger は nextAction だが ${next.actionId} は ${action.state} (planned ではない)`];
    }
    // 外へ出た操作は照合が済むまで「次の契機」でいられる (reconcile も生きている状態)
    if (next.kind === 'runningAction'
        && !['sending', 'sent', 'accepted', 'running', 'reconcile'].includes(action.state)) {
      return [`cases.${id}.nextTrigger は runningAction だが ${next.actionId} は ${action.state} (終わっている)`];
    }
    return [];
  }
  return [`cases.${id}.nextTrigger.kind が不明: ${JSON.stringify(next.kind)} (runningAction | nextAction | waiting)`];
}

/**
 * 依存の環を 1 つ返す (無ければ null)。**3 つ以上の環も見つける** —
 * 直接の往復 (A→B→A) だけを見ると、A→B→C→A が通ってしまう。
 */
function findDependencyCycle(cases) {
  const visiting = new Set();
  const done = new Set();
  const stack = [];

  const walk = (id) => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    for (const dep of cases[id]?.dependencies ?? []) {
      if (!cases[dep?.caseId]) continue;
      const found = walk(dep.caseId);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };

  for (const id of Object.keys(cases ?? {})) {
    const found = walk(id);
    if (found) return found;
  }
  return null;
}
