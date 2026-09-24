// 自律社会の配線。
//
// S1 で入った台帳 (`src/society-store.js`) と純粋な遷移 (`src/cases.js`) を、
// 起動・配送・受付・照合へ結ぶ層。**判断は持たない** — 遷移の可否は cases.js が決め、
// ここが持つのは「順序」と「外側 (Discord・実行記録) との突き合わせ」だけ。
//
// 守っている順序: ① society.json に意図 (`planned` → `sending`) → ② 外部操作 (投稿) →
// ③ society.json に結果 (`sent` / `cancelled` / `reconcile`)。①と③の間で落ちたら、
// 次の tick の照合が **Action ID を鍵に**外側を探し、見つかれば③を完成させ、
// 見つからなければ `reconcile` に残す。再実行しても 1 回に収束する。

import {
  CASE_TERMINAL_STATES,
  acceptClaim, addFinding, adoptFinding, cancelAction, declineClaim, expireClaim, linkCase,
  markAccepted, markReconcile, markRunning, markSending, markSent, offerClaim, planAction,
  reconcileActions, registerMandate, resumeCase, settleAction, stopCase,
} from '../cases.js';
import { classifySendError } from '../recovery.js';
import { OBSERVE_ACTION_KINDS, checkEffectivePermission, mandateRecord } from '../society-policy.js';

/** tick が回らなかった理由 (`/status` と判断で使う) */
export const SOCIETY_STOP_REASONS = Object.freeze([
  'off', 'halted', 'not-ready', 'paused', 'not-accepting',
]);

/** ログに出さない停止理由 (異常ではない・起動直後に毎分出さない) */
const QUIET_STOPS = Object.freeze(['off', 'not-ready']);

/**
 * 起動メッセージに載せる案件の印。**印だけの行**として読む (前後の空白は許す) —
 * 本文中の引用や説明を印と取り違えないため。
 *
 * **`[[...]]` の文法は使わない** — あれは「起動を決める」記法で、種類を増やすと
 * プロトコル版の管理対象になる (`src/contract.js` の契約タグと同じ流儀)。
 * **本文の印だけでは実行できない**: 受信側は保存済みの Action と照合して初めて受け付ける。
 */
const ACTION_TAG_ONLY = /^`案件:(A-\d+)`$/;

export function formatActionTag(actionId) {
  return /^A-\d+$/.test(String(actionId ?? '')) ? `\`案件:${actionId}\`` : '';
}

/**
 * 起動メッセージに載っていた Action ID (無ければ null)。
 *
 * **本文の最後の空でない行が印そのものであるときだけ**読む (`launchText` が置く位置)。
 * どこにあっても読むと、印を引用しただけの報告 — 「対象: `` `案件:A-5` `` を見て」— が
 * 起動の照合に掛かり、通常の handoff が「受付済み」で拒否されて契約ごと捨てられる
 * (Fable 検収 2026-09-07 (c))。
 */
export function readActionId(content) {
  const lines = String(content ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const m = ACTION_TAG_ONLY.exec(line);
    return m ? m[1] : null;
  }
  return null;
}

function isTerminalCase(record) {
  return CASE_TERMINAL_STATES.includes(record?.state);
}

/** スレッド走査の 1 ページ (既定は Discord の上限と同じ) */
export const SCAN_PAGE_SIZE = 100;

/** 1 スレッドで辿るページ数の上限 (これを越えたら「最後まで見ていない」) */
export const SCAN_MAX_PAGES = 30;

/**
 * ページを辿って投稿を集める。**ページングの判断はここ 1 か所**にある
 * (`fetchPage` を注入するので Discord なしで試せる)。
 *
 * `complete` = 走査がスレッドの末尾まで届いたか。**「見つからない」と言ってよいのは
 * complete のときだけ**なので、判定が甘いと届いている起動を取り消すことになる:
 * - ページが上限より少ない → そこが末尾 = complete (`after` の有無に関係ない —
 *   `since` 無しでも、1 ページに収まるスレッドは全件読めている)
 * - `after` 無しでページが満杯 → **最新 N 件しか見ていない** = incomplete
 * - `SCAN_MAX_PAGES` まで辿っても終わらない → incomplete
 *
 * @param {{fetchPage: (args: {after: string|null, limit: number}) => Promise<object[]>}} deps
 *   `fetchPage` は**古い順に並べた**投稿の配列を返す (id と content を持つもの)
 * @returns {Promise<{complete: boolean, posts: object[], pages: number}>}
 */
export async function collectThreadPosts({
  fetchPage, after: from = null, pageSize = SCAN_PAGE_SIZE, maxPages = SCAN_MAX_PAGES,
} = {}) {
  const posts = [];
  let after = from;
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchPage({ after, limit: pageSize });
    const items = Array.isArray(batch) ? batch : [];
    posts.push(...items);
    if (items.length < pageSize) return { complete: true, posts, pages: page };
    if (after === null) return { complete: false, posts, pages: page }; // 最新 N 件だけ
    after = items[items.length - 1]?.id ?? after;
  }
  return { complete: false, posts, pages: maxPages };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function msOf(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 遷移の結果が現状と同じか (`revision` と `updatedAt` は `update` が付けるのでまだ入っていない)。
 *
 * 素朴に JSON へ落として比べる — 台帳は 1 ファイルに収まる大きさで、
 * ここで比べる相手は同じ関数群が同じ順で組み立てたオブジェクトなのでキーの順も揃う。
 */
function unchanged(before, after) {
  if (before === after) return true;
  if (!before || !after) return false;
  try {
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false; // 比べられないなら書く側へ倒す (書き損じより無駄な版の方が軽い)
  }
}

function oneLine(text, max) {
  const flat = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 社会の配線を組む。
 *
 * @param {object} p
 * @param {object} p.society `resolveSociety(config)` の戻り (mode / offerRecheckMin …)
 * @param {object|null} p.store `SocietyStore` (mode off なら fs に触れていない)
 * @param {object} p.pauseStore `/pause` の台帳 (`paused` を読む — autonomyTick と同じ API)
 * @param {object} p.lifecycle 受付の可否 (`accepting`)
 * @param {object|null} [p.jobRuns] 実行記録 (`forAction` で受付を探す)
 * @param {(args: {botKey, threadId, text, mentionUserIds}) => Promise<object>} [p.postAs]
 *   **宛先以外の bot の client** から投稿し、送れた `Message` を返す (自分の多行発言は捨てられるため)
 * @param {(args: {threadId, since}) => Promise<{complete: boolean, messages: object[]}>} [p.scanThread]
 *   スレッドの**自前 bot の投稿**を走査する。`complete` は末尾まで届いたか
 * @param {(key: string) => string|null} [p.botUserId]
 * @param {() => string[]} [p.availableBotKeys] 起動している bot キー
 * @param {() => boolean} [p.ready] Discord が ready か (走査と投稿ができるか)
 * @param {() => object} [p.botFacts] bot キー → `{runtime, online}` (実効権限の材料)
 * @param {(name: string|null) => boolean} [p.channelStructuredOutput] そのチャンネルの構造化出力
 * @param {(threadId: string|null) => string[]|null} [p.threadRoster] スレッドの編成 (null = 制限なし)
 * @param {object} [p.log] ログの出口 (テストから差し替える)
 * @param {() => number} [p.now] 時計 (注入)
 */
export function createSocietyWiring({
  society, store = null, pauseStore = null, lifecycle = null,
  jobRuns = null, postAs = null, scanThread = null,
  botUserId = () => null, availableBotKeys = () => [], ready = () => true,
  // 実効権限の材料 (判断は src/society-policy.js の純粋関数が持つ。ここは事実を渡すだけ)
  botFacts = () => ({}), channelStructuredOutput = () => true, threadRoster = () => null,
  log = console, now = () => Date.now(),
}) {
  const mode = typeof society?.mode === 'string' ? society.mode : 'off';
  const enabled = mode !== 'off';
  /** 未受付のまま置いておける時間 = 引受け申し出の再確認 × 2 (時定数から) */
  const unacceptedGraceMs = Math.max(1, Number(society?.offerRecheckMin) || 5) * 2 * 60 * 1000;

  /**
   * 直近に出した「止まっている理由」。同じ理由を 60 秒ごとに撒かないための印で、
   * 理由が変わったらもう一度だけ出す (`src/bridge/scheduler.js` の `brokenNoticed` と同じ流儀)。
   */
  let noticedStop = null;
  /** 走査が不完全で照合を見送ったことのログも 1 回だけ */
  let noticedScanGap = false;
  /** Mandate の写しを合わせたか (ready 後の最初の tick で 1 回) */
  let syncedMandates = false;
  /** 直近の照合で hold に入った Action (`/status` と `/case` が「見えていない件数」を出す材料) */
  let heldActionIds = [];

  /** 社会由来の処理を止める理由 (無ければ null)。off は「止まっている」ではないので null */
  function haltReason() {
    return store?.haltReason ?? null;
  }

  function caseCounts() {
    const cases = store?.snapshot?.cases;
    if (!cases || typeof cases !== 'object') return null;
    const counts = { open: 0, active: 0, waiting: 0, verifying: 0, resolved: 0, closed: 0 };
    for (const record of Object.values(cases)) {
      if (Object.hasOwn(counts, record?.state)) counts[record.state] += 1;
    }
    return counts;
  }

  /**
   * 待ちの内訳と、再確認時刻を過ぎた待ちの件数 (受入 C14「何を待っているかが読める」)。
   *
   * 件数だけでは「止まっているのか進んでいるのか」が読めない — 引受け待ちが 3 件と
   * 依存待ちが 3 件は別の話で、期限が過ぎている待ちは誰かが見に行く必要がある。
   */
  function waitingCounts(at = now()) {
    const cases = store?.snapshot?.cases;
    if (!cases || typeof cases !== 'object') return null;
    const reasons = {};
    let overdue = 0;
    for (const record of Object.values(cases)) {
      const next = record?.nextTrigger;
      if (next?.kind !== 'waiting') continue;
      if (CASE_TERMINAL_STATES.includes(record.state)) continue;
      const reason = isNonEmptyString(next.reason) ? next.reason : '不明';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      // **停止中の待ちは期限切れに数えない。** 解けるのは人の再開操作だけで時計では動かない —
      // 数えると「見に行けば進むもの」の件数に、見に行っても進まないものが混ざる
      if (next.reason === 'paused' || record.stop) continue;
      const due = Date.parse(next.nextCheckAt ?? '');
      if (Number.isFinite(due) && due <= at) overdue += 1;
    }
    return { reasons, overdue };
  }

  /** 停止マーカーが付いたまま終わっていない案件の数 (`/status` の `停止 n`) */
  function stoppedCount() {
    const cases = store?.snapshot?.cases;
    if (!cases || typeof cases !== 'object') return 0;
    return Object.values(cases)
      .filter((record) => record?.stop && !CASE_TERMINAL_STATES.includes(record.state)).length;
  }

  /** `/status` と起動ログが使う形。off なら mode だけ (触っていない台帳の話をしない) */
  function summary(at = now()) {
    if (!enabled) return { mode };
    const waiting = waitingCounts(at);
    return {
      mode,
      state: store?.state ?? null,
      healthy: store?.healthy === true,
      revision: store?.revision ?? null,
      haltReason: haltReason(),
      leftovers: store?.leftovers?.length ?? 0,
      cases: caseCounts(),
      // 直近の照合で「外を見きれなかった」Action。予約を握ったまま残るので見える所に出す
      held: heldActionIds.length,
      waiting: waiting?.reasons ?? null,
      overdue: waiting?.overdue ?? 0,
      // 止めた案件は「待っている」でも「進んでいる」でもない — 人が再開を決めるまで動かない
      stopped: stoppedCount(),
    };
  }

  /**
   * いまのスナップショット。
   *
   * ⚠️ **内部のオブジェクトをそのまま返す** (複製しない — 60 秒ごとの tick で丸ごと複製すると
   * 台帳が育つほど無駄が増えるため)。読む側は書き換えないこと。書き換えてよいのは
   * `store.update(revision, mutate)` に渡される複製だけ。
   */
  function snapshot() {
    return store?.snapshot ?? null;
  }

  /**
   * 止める仕事の種類 (「`/pause` 中は新しい `sending` を作らない。照合と後始末は続ける」)。
   *
   * @returns {{dispatch: string|null, reconcile: string|null}} 止める理由 (null = 回してよい)
   */
  function stopReason() {
    if (!enabled) return { dispatch: 'off', reconcile: 'off' };
    if (store?.healthy !== true) return { dispatch: 'halted', reconcile: 'halted' };
    // 走査も投稿も Discord が要る。**モジュール読込時には走らせない**ので、ready を待つ
    if (ready() !== true) return { dispatch: 'not-ready', reconcile: 'not-ready' };
    // ここから下は**配送だけ**を止める — 止めているのは「新しく起こすこと」で、
    // 外に出てしまったものの照合と後始末は続ける (でないと予約が返らない)
    if (pauseStore?.paused === true) return { dispatch: 'paused', reconcile: null };
    if (lifecycle && lifecycle.accepting !== true) return { dispatch: 'not-accepting', reconcile: null };
    return { dispatch: null, reconcile: null };
  }

  /**
   * 純粋な遷移を 1 つ保存する。
   *
   * **遷移は `update` の外で計算する** — cases.js は純粋なので、断られたときに何も書かずに済む
   * (mutate の中で判断すると、断り方を store 側へ持ち込むことになる)。
   * conflict は読み直して 1 回だけやり直し、それでも駄目なら次の tick へ回す。
   */
  function commit(label, transition, { keepRefusal = false } = {}) {
    if (store?.healthy !== true) {
      return { ok: false, code: 'halted', reason: haltReason() ?? '台帳を開けていません' };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const out = transition(store.snapshot);
      // **断られても保存する**モード。`acceptClaim` の `occupied` / `permission` は
      // 「2 人目を declined に落として理由を残す」遷移で、`ok: false` でも
      // 返ったスナップショットに記録が入っている — 捨てると理由が消える
      if (!out.ok && !(keepRefusal && isPlainObject(out.snapshot))) {
        return { ok: false, code: out.code, reason: out.reason, result: out };
      }
      if (!out.ok && unchanged(store.snapshot, out.snapshot)) {
        // 何も書かれていない断り (前提が足りない等) は従来どおり失敗として返す
        return { ok: false, code: out.code, reason: out.reason, result: out };
      }
      // **何も変わっていなければ書かない。** 照合は live な Action があるかぎり毎 tick 走るので、
      // 変化の無い保存を通すと revision が 60 秒ごとに進み、そのたびに disk へ書く
      // (台帳の版は「何かが起きた」の目印なので、起きていない版を積まない)
      if (unchanged(store.snapshot, out.snapshot)) {
        return { ok: true, revision: store.revision, result: out, unchanged: true };
      }
      let saved;
      try {
        saved = store.update(store.revision, () => out.snapshot);
      } catch (err) {
        // `SocietyStore.update` は書込失敗を throw する (メモリは巻き戻っている)。
        // ここで握らないと受付の経路まで例外が抜け、job の入口が落ちる
        const reason = `台帳へ書けませんでした: ${err?.message ?? err}`;
        log.error?.(`[society] ${label} — ${reason}`);
        return { ok: false, code: 'write-error', reason };
      }
      // 断りを保存した場合は `ok: false` のまま返す (保存できたことは `saved: true` で示す) —
      // 呼び出し側は「記録は残った」と「引き受けられなかった」の両方を知る必要がある
      if (saved.ok) {
        return {
          ok: out.ok !== false,
          saved: true,
          refused: out.ok === false,
          code: out.code,
          reason: out.reason,
          revision: saved.revision,
          result: out,
        };
      }
      if (saved.code === 'conflict' && attempt === 0) continue; // 読み直して 1 回だけ
      const reason = saved.reason ?? (saved.errors ?? []).join(' / ');
      log.error?.(`[society] ${label} を保存できませんでした (${saved.code}): ${reason}`);
      return { ok: false, code: saved.code, reason };
    }
    return { ok: false, code: 'conflict', reason: '版が動き続けています (次の tick でやり直します)' };
  }

  // ---- Mandate の写し ----

  /**
   * 設定の Mandate を台帳へ**版ごとに写す** (「台帳には版の写しを置き、実行時はその版を参照する」)。
   *
   * 台帳が読むのは写しであって config ではないので、写しが 1 つも無い配備では Case を作れない
   * (`caseContext` の authority も写しから引く)。**同じ key + version が既にあれば触らない** —
   * 版を上げたときだけ新しい記録が増え、走っている Case が見る版は動かない。
   * 設定から消えた Mandate を `ended` にはしない (どう畳むかは S3 で決める)。
   *
   * 複数の Mandate も **1 つの update** にまとめる (途中で落ちて半分だけ写るのを避ける)。
   */
  function syncMandates(at = now()) {
    if (!enabled) return { ok: false, code: 'off', added: [] };
    if (store?.healthy !== true) {
      return { ok: false, code: 'halted', reason: haltReason() ?? '台帳を開けていません', added: [] };
    }
    const policy = isPlainObject(society?.mandates) ? society.mandates : {};
    const keys = Object.keys(policy);
    if (keys.length === 0) return { ok: true, added: [], unchanged: true };

    const out = commit('Mandate の写しの同期', (s) => {
      let next = s;
      const added = [];
      for (const key of keys) {
        // id は registerMandate が採番する (写しの中身だけ渡す)
        const registered = registerMandate(next, mandateRecord(policy[key], null, at), at);
        if (!registered.ok) return registered;
        if (registered.created) {
          added.push({ key, version: policy[key].version, mandateId: registered.mandateId });
        }
        next = registered.snapshot;
      }
      return { ok: true, snapshot: next, added };
    });
    if (!out.ok) {
      log.error?.(`[society] Mandate の写しを更新できませんでした (${out.code}): ${out.reason ?? ''}`);
      return { ok: false, code: out.code, reason: out.reason, added: [] };
    }
    const added = out.result?.added ?? [];
    if (added.length > 0) {
      log.log?.(
        `[society] Mandate の写しを ${added.length} 件足しました `
        + `(${added.map((a) => `${a.key} v${a.version} = ${a.mandateId}`).join(' / ')})`,
      );
    }
    return { ok: true, added };
  }

  // ---- 相談 (offered) ----

  /**
   * 裁定責務 (authority) の Claim を確かめ、無ければ **相談なしで accepted にする**。
   *
   * authority は設定 (`society.mandates.<key>.authority`) で決まる担当なので、
   * 「引き受けますか」と聞く相手ではない — 聞いてしまうと、誰も引き受けていない Case では
   * 相談の Action を立てる根拠 (accepted な Claim) が永久に作れない。
   * **相談を出すのはこの Claim の下**で、`offer` と同じ update に入る。
   */
  function ensureAuthorityClaimOn(snapshot, caseId, at) {
    const record = snapshot.cases?.[caseId];
    const mandate = record ? snapshot.mandates?.[record.mandateId] ?? null : null;
    const botKey = mandate?.authority ?? society?.authority ?? null;
    if (!isNonEmptyString(botKey)) {
      return { ok: false, code: 'no-authority', reason: `案件 ${caseId} の裁定責務 (authority) が決まっていません` };
    }
    const existing = Object.values(snapshot.claims ?? {})
      .find((c) => c.caseId === caseId && c.responsibility === 'authority' && c.state === 'accepted');
    if (existing) return { ok: true, snapshot, claimId: existing.id, created: false };

    const offered = offerClaim(snapshot, {
      caseId, responsibility: 'authority', botKey, scope: '案件の裁定と相談の差配',
    }, at);
    if (!offered.ok) return offered;
    const accepted = acceptClaim(offered.snapshot, offered.claimId, { permissionOk: true }, at);
    if (!accepted.ok) return accepted;
    return { ok: true, snapshot: accepted.snapshot, claimId: offered.claimId, created: true };
  }

  /**
   * 相談を出す。**1 つの update** で
   * authority の Claim (無ければ) → 引受けの申し出 (`offered`) → 相談の Action (`planned`) を作る。
   *
   * 3 つを分けると、申し出だけが残って誰も聞かれていない Case や、
   * 相談だけ飛んで台帳に申し出が無い Case ができる (「意図と操作を同じ update に」)。
   * 送るのは tick の `dispatchPlanned`。
   */
  function offer({
    caseId, responsibility, botKey, scope = null, threadId = null, channel = null, summary = null,
  }, at = now()) {
    let claimId = null;
    let actionId = null;
    const out = commit(`案件 ${caseId} の相談`, (s) => {
      const authority = ensureAuthorityClaimOn(s, caseId, at);
      if (!authority.ok) return authority;
      const offered = offerClaim(authority.snapshot, { caseId, responsibility, botKey, scope }, at);
      if (!offered.ok) return offered;
      claimId = offered.claimId;
      const record = offered.snapshot.cases?.[caseId];
      const thread = threadId
        ?? record?.links?.find((l) => l.kind === 'thread')?.id
        ?? null;
      const planned = planAction(offered.snapshot, {
        caseId,
        claimId: authority.claimId,
        kind: 'consult',
        target: { botKey, threadId: thread, channel },
        offerClaimId: offered.claimId,
        note: summary,
      }, at);
      if (planned.ok) actionId = planned.actionId;
      return planned;
    });
    if (!out.ok) {
      log.error?.(`[society] 案件 ${caseId} の相談を作れませんでした (${out.code}): ${out.reason ?? ''}`);
      return { ok: false, code: out.code, reason: out.reason };
    }
    log.log?.(`[society] 案件 ${caseId} の ${responsibility} を ${botKey} へ相談します (${claimId} / ${actionId})`);
    return { ok: true, claimId, actionId };
  }

  // ---- 配送 (planned → sending → sent) ----

  /**
   * その宛先へ送っても案件の戻りが返らない理由 (無ければ null)。
   *
   * **送る前に見る。** 送ってしまうと Action は受け付けられたまま settle されず、
   * 10 分ルールでしか片付かない (しかもその間ずっと予約を握る)。
   */
  function deliverabilityGap(target) {
    const key = target?.botKey ?? null;
    if (!isNonEmptyString(key)) return '宛先の bot が決まっていません';
    // **投稿先が無い起動は送りに出さない。** postAs が落ちて照合へ回っても、threadId が無い
    // Action はスレッドを走査できず `scanned` にならないので hold に入り、予約を握ったまま
    // 戻ってこない (Opus2 指摘 ② 2026-09-08)。ここで断れば取り消して予約を返せる
    if (!isNonEmptyString(target?.threadId)) return '宛先のスレッドが決まっていません';
    const facts = botFacts()?.[key] ?? null;
    if (!facts) return `${key} は設定に無い bot です`;
    if (facts.online === false) return `${key} は起動していません`;
    if (facts.runtime === 'codex') return `${key} は runtime: "codex" で構造化出力を返せません`;
    if (channelStructuredOutput(target.channel ?? null) === false) {
      return `${target.channel ?? 'このチャンネル'} は structuredOutput が false です`;
    }
    return null;
  }

  /** 宛先以外の投げ手を選ぶ (担当自身の client からは起こせない) */
  function pickAnnouncer(targetBotKey) {
    return availableBotKeys().filter((key) => key !== targetBotKey).sort()[0] ?? null;
  }

  function launchText(action, userId) {
    const record = store?.snapshot?.cases?.[action.caseId];
    const outcome = oneLine(record?.desiredOutcome ?? '', 140);
    // 相談は「引き受けるかどうか」を聞く起動なので、返し方まで書く —
    // 受諾は `claim.decision` でしか成立しない (本文で「やります」と書いても台帳は動かない)
    const offered = action.offerClaimId ? store?.snapshot?.claims?.[action.offerClaimId] ?? null : null;
    const headline = action.kind === 'consult' && offered
      ? `案件 ${action.caseId} / consult — ${offered.responsibility} の引受けの相談`
        + `${outcome ? ` (${outcome})` : ''}。受けるなら \`claim.decision: accept\` と最初の一手を`
        + ' `next.plan` に、受けないなら `decline` と理由を'
      : `案件 ${action.caseId} / ${action.kind}${outcome ? ` — ${outcome}` : ''}`;
    return [
      `<@${userId}>`,
      headline,
      // 戻りの様式。**実行文脈にも同じことが出る**が、起動文にも書いておくと
      // スレッドを人が読んだときに「この job は案件の 1 ターン」と分かる
      '`様式:case-turn` (成果は `result`、次の一手は `next.plan` か `next.waiting` に書く)',
      // **印は最終行**。本文の ID だけでは実行できない (受信側が保存済みの Action と照合する)
      formatActionTag(action.id),
    ].join('\n');
  }

  /** planned の Action を 1 件送る。境界①②③はそれぞれ別の update */
  async function dispatchOne(action, at) {
    const actionId = action.id;
    // ① 起動の意図を保存する (paused ならここで断られる = 新しい sending を作らない)
    const sending = commit(`${actionId} の sending`, (s) => markSending(
      s, actionId, { paused: pauseStore?.paused === true }, at,
    ));
    if (!sending.ok) {
      if (!['paused', 'stopped'].includes(sending.code)) {
        log.error?.(`[society] ${actionId} を送りに出せません (${sending.code}): ${sending.reason ?? ''}`);
      }
      return false;
    }

    // ② 外部操作 — ここで落ちると台帳は sending のまま残り、次の照合が投稿を探す
    const target = action.target ?? {};
    // **構造化の戻りを返せない宛先へは送らない。** 送っても案件の戻り (`case-turn`) が
    // 返らないので、Action は受け付けられたまま settle されず宙に浮く。
    // まだ**送っていない**ので予約は返す (未受付が確定している)
    const undeliverable = deliverabilityGap(target);
    if (undeliverable) {
      // **申し出も同じ update で閉じる。** 相談の Action だけ取り消すと `offered` の申し出が
      // 宙に残り、誰も返事をしないまま S2-4 の期限 tick まで片付かない (Fable 検収 (b))
      const offerClaimId = isNonEmptyString(action.offerClaimId) ? action.offerClaimId : null;
      commit(`${actionId} の取り消し`, (s) => {
        const cancelled = cancelAction(s, actionId, {
          confirmedUnaccepted: true,
          reason: `構造化の戻りを返せない宛先です: ${undeliverable}`,
        }, at);
        if (!cancelled.ok || !offerClaimId) return cancelled;
        if (cancelled.snapshot.claims?.[offerClaimId]?.state !== 'offered') return cancelled;
        return declineClaim(cancelled.snapshot, offerClaimId, `相談を送れませんでした: ${undeliverable}`, at);
      });
      log.error?.(`[society] ${actionId} は送りません (${undeliverable}) — 取り消して予約を返しました`);
      return false;
    }
    const userId = botUserId(target.botKey);
    const announcer = pickAnnouncer(target.botKey);
    let posted = null;
    let failure = null;
    if (!userId) {
      failure = { kind: 'failed', message: `宛先 ${target.botKey} の Discord ID が取れません (起動していない?)` };
    } else if (!announcer || typeof postAs !== 'function') {
      failure = { kind: 'failed', message: `${target.botKey} を呼べる別の bot が居ません (担当自身からは起こせません)` };
    } else {
      try {
        posted = await postAs({
          botKey: announcer,
          threadId: target.threadId,
          text: launchText(action, userId),
          mentionUserIds: [userId],
        });
      } catch (err) {
        failure = { kind: classifySendError(err), message: String(err?.message ?? err).slice(0, 160) };
      }
    }

    // ③ 結果を保存する
    if (failure) {
      if (failure.kind === 'failed') {
        // 送れていないことが確定 (4xx など) — **ここでだけ予約を返す**
        commit(`${actionId} の取り消し`, (s) => cancelAction(
          s, actionId, { confirmedUnaccepted: true, reason: `送信できませんでした: ${failure.message}` }, at,
        ));
        log.error?.(`[society] ${actionId} は送れませんでした (${failure.message}) — 取り消して予約を返しました`);
      } else {
        // 送れたか分からない — **無条件に再送しない**。照合が投稿と実行記録を探す
        commit(`${actionId} の照合待ち`, (s) => markReconcile(s, actionId, `送達不明: ${failure.message}`, at));
        log.error?.(`[society] ${actionId} の送達が不明です (${failure.message}) — 照合に回しました`);
      }
      return false;
    }

    const sent = commit(`${actionId} の sent`, (s) => markSent(s, actionId, { messageId: posted?.id ?? null }, at));
    if (!sent.ok) {
      // **受付側が先に進めていた形は成功**。投稿は届き、宛先 bot が受け取って
      // `markAccepted` (messageId の補完つき) まで済ませている — 失敗として数えると、
      // 実際には動いている起動が「送れなかった」と読める (Fable 検収 2026-09-07 (f))
      const current = store?.snapshot?.actions?.[actionId];
      if (sent.code === 'bad-state' && ['accepted', 'running', 'settled'].includes(current?.state)) {
        log.log?.(
          `[society] ${actionId} を ${target.botKey} へ送りました `
          + `(case ${action.caseId} / ${action.kind} / 投稿は ${announcer} / 受付が先に済んでいます)`,
        );
        return true;
      }
      // 投稿は出ている。台帳は sending のままなので、次の照合が印を見つけて sent にする
      log.error?.(`[society] ${actionId} は投稿できましたが sent を保存できませんでした (${sent.code}) — 照合に任せます`);
      return false;
    }
    log.log?.(
      `[society] ${actionId} を ${target.botKey} へ送りました `
      + `(case ${action.caseId} / ${action.kind} / 投稿は ${announcer})`,
    );
    return true;
  }

  /** `planned` の Action を ID 順に 1 件ずつ送る (終端・停止マーカーの Case は飛ばす) */
  async function dispatchPlanned(at = now()) {
    const snap = store?.snapshot;
    if (!snap) return 0;
    const planned = Object.values(snap.actions ?? {})
      .filter((a) => a.state === 'planned')
      .filter((a) => {
        const record = snap.cases?.[a.caseId];
        return record && !isTerminalCase(record) && !record.stop;
      })
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    let dispatched = 0;
    for (const action of planned) {
      // 直列に回す (1 件ごとに台帳へ書くので、並列にすると版が競合する)
      if (await dispatchOne(action, at)) dispatched += 1;
    }
    return dispatched;
  }

  // ---- 受付 (accepted) ----

  /**
   * 印付きの起動を保存済みの Action と照合する。**本文の印だけでは実行させない**。
   *
   * @returns {{ok: true, action: object|null}|{ok: false, reason: string}}
   *   `action` が null = 印の無い通常のメンション (従来どおり通す)
   */
  function screenAction({ content, messageId = null, botKey = null, threadId = null } = {}) {
    const actionId = readActionId(content);
    if (!actionId) return { ok: true, action: null };
    // **off は印を見ない。** 機構ごと止めている設定なので、印の付いた文字列が本文に
    // 混ざっているだけで通常の handoff を止めてはいけない — 印の書き方を説明した文を
    // 次の bot へ渡す場面は現に起きる (Opus2 S2-2 レビュー ①・受入 C15)
    if (!enabled) return { ok: true, action: null };
    const refuse = (why) => ({ ok: false, reason: `案件 ${actionId} は起動しません — ${why}` });
    if (store?.healthy !== true) return refuse(`社会台帳を開けていません (${haltReason() ?? '理由不明'})`);

    const snap = store.snapshot;
    const action = snap.actions?.[actionId];
    if (!action) return refuse('台帳に無い Action です (作り直された台帳か、別のプロセスの操作)');
    // **再配送は state より先に見る** — 受け付けた後は state が accepted / running へ進むので、
    // 状態だけで断ると「まだ送っていない」という誤解を招く理由が出る
    if (action.delivery?.runId) {
      return refuse(`既に受け付け済みです (job ${action.delivery.runId}) — 同じ投稿の再配送`);
    }
    // **送りに出たことが保存済みなら受け付ける。** `sending` を断ると、投稿は成功したのに
    // `markSent` の保存前に落ちた起動が永久に走らない (投稿は 1 回しか配信されない) —
    // `cases.js` の `markAccepted` も `sending` からの受付を許している (Opus2 S2-2 レビュー ③)。
    // 二重起動は下の `delivery.runId` の門が止める
    if (!['sending', 'sent', 'reconcile'].includes(action.state)) {
      return refuse(`まだ送っていない Action です (state: ${action.state})`);
    }
    // messageId の照合は**記録がある場合だけ** (境界②で落ちた形は記録が無い)
    if (messageId && action.delivery?.messageId && String(action.delivery.messageId) !== String(messageId)) {
      return refuse(`記録された投稿 (${action.delivery.messageId}) と違う投稿です`);
    }
    if (botKey && action.target?.botKey && action.target.botKey !== botKey) {
      return refuse(`宛先は ${action.target.botKey} で、${botKey} 宛ではありません`);
    }
    if (threadId && action.target?.threadId && String(action.target.threadId) !== String(threadId)) {
      return refuse('別のスレッドの Action です');
    }
    const record = snap.cases?.[action.caseId];
    if (!record || isTerminalCase(record)) {
      return refuse(`案件 ${action.caseId} は ${record?.state ?? '不明'} (終端) です`);
    }
    if (record.stop) {
      // **止めた案件の起動は受け付けない**。送った後に人が止めた形なので、
      // ここで取り消して予約を返しておかないと、誰も受けない Action が枠を握ったまま残る
      cancelStoppedAction(action, `案件 ${action.caseId} は停止中 (/stop) — 受け付けずに取り消しました`);
      return {
        ok: false,
        reason: `案件 ${action.caseId} は停止中なので起動しません (再開は \`/case resume:${action.caseId}\`)`,
      };
    }
    return {
      ok: true,
      action: { actionId, caseId: action.caseId, claimGeneration: action.claimGeneration },
    };
  }

  /**
   * 止めた案件へ届いた起動を取り消して予約を返す (受け付けないと決めた直後に呼ぶ)。
   *
   * `sent` からは直接取り消せない (遷移表) ので、**照合へ倒してから**未受付を確定させる —
   * いま受付を断ったのだから未受付は確定している。台帳にも「送った → 受けなかった → 返した」
   * の順で残る。契機の立て直しは `cases.js` の停止分岐が `waiting(paused)` で受ける。
   */
  function cancelStoppedAction(action, why, at = now()) {
    if (action.state === 'sent') {
      const marked = commit(`${action.id} の照合待ち`, (s) => markReconcile(s, action.id, why, at));
      if (!marked.ok) return marked;
    }
    const done = commit(`${action.id} の取り消し`, (s) => cancelAction(s, action.id, {
      confirmedUnaccepted: true, reason: why,
    }, at));
    if (!done.ok) {
      log.error?.(`[society] ${action.id} を取り消せませんでした (${done.code}): ${done.reason ?? ''}`);
    }
    return done;
  }

  /**
   * 案件に結ばれた job の実行文脈の材料。台帳を読むだけで、無ければ null。
   *
   * `authority` は Mandate の写しにある決定権者 — **案件の裁定を誰が持つか**は
   * 設定 (`society.mandates.<key>.authority`) で決まっていて、bot が名乗るものではない。
   */
  function caseContext(actionId) {
    const snap = store?.snapshot;
    const action = snap?.actions?.[actionId];
    if (!action) return null;
    const record = snap.cases?.[action.caseId] ?? null;
    const claim = snap.claims?.[action.claimId] ?? null;
    const mandate = record ? snap.mandates?.[record.mandateId] ?? null : null;
    return {
      caseId: action.caseId,
      desiredOutcome: record?.desiredOutcome ?? null,
      authority: mandate?.authority ?? society?.authority ?? null,
      claimId: action.claimId,
      claimGeneration: action.claimGeneration,
      responsibility: claim?.responsibility ?? null,
      actionId,
      actionKind: action.kind,
      mode,
    };
  }

  /**
   * observe では起こせない kind か (`OBSERVE_ACTION_KINDS` 以外)。
   *
   * **判断はここ 1 か所**。台帳 (`cases.js`) の kind は閉集合ではないので、断るのは配線の役目で、
   * `active` は従来どおり無検査・`off` はそもそもこの層を通らない (受入 C15)。
   */
  function blockedByObserve(kind) {
    return mode === 'observe' && !OBSERVE_ACTION_KINDS.includes(kind);
  }

  /**
   * 門に当たった plan の代わりに置く待ち。**人間待ち (`authority`)** にするのは、
   * observe が「人がまだ任せていない」という人間の決めた制限だから — 内部の待ちに翻訳すると、
   * 時計や tick で解けるものに見えてしまう (「内部の待ちを人間待ちに変換しない」の裏返し)。
   */
  function observeWaiting(kind) {
    return {
      waiting: {
        reason: 'authority',
        condition: `observe では ${kind} の Action を起こせない — mode を active にするか、人が行う`,
      },
    };
  }

  /**
   * 門が効いたときの 1 行。**台帳を読んでから書く** — 契機を人間待ちへ向けたのか、
   * 別の生きた仕事を保ったのかは `applyNextTrigger` / `acceptClaim` の規則が決めるので、
   * こちらで先に決め打つと注記と台帳が食い違う。
   */
  function observeNote(caseId, kind) {
    const next = store?.snapshot?.cases?.[caseId]?.nextTrigger ?? null;
    const authority = next?.kind === 'waiting' && next.reason === 'authority';
    return `ℹ️ observe では ${kind} は起こしません (mode を active にするか人が行う) — `
      + (authority ? `案件 ${caseId} は waiting(authority) です` : `案件 ${caseId} の契機は動かしていません`);
  }

  /**
   * 構造化された戻り (`case-turn`) を台帳へ写す (S2-3a)。
   *
   * **ここに書かれたものだけが台帳に入る。** 本文に何を書いても Action にはならず、
   * 逆にここへ書けたから通るのでもない — 遷移の可否は `src/cases.js` が決める。
   *
   * 順序は「気づき → 成果と次の一手」。気づきは Case とは独立に残す (原因が分からなくても
   * 保存できるのが C02 の要点) ので、settle が断られても消えない。
   *
   * @returns {{ok: boolean, notes: string[], settled: boolean}} notes は Discord へ添える 1 行群
   */
  function applyTurn(actionId, contract, { verifyResult = null, at = now() } = {}) {
    const notes = [];
    const action = store?.snapshot?.actions?.[actionId];
    if (!action) {
      return { ok: false, settled: false, notes: [`⚠️ 案件の Action (${actionId}) が台帳にありません — 記録は残していません`] };
    }
    const runId = action.delivery?.runId ?? null;
    // **verify が通っていない成果は確定させない** (Opus2 S2-3a レビュー ①)。
    // 既存経路が「NG なら handoff を落として人へ返す」で守ってきたものを、案件でも守る
    const verifyFailed = Boolean(verifyResult && verifyResult.ok === false);
    // settle できる状態か。**二重 apply で気づきだけ増えるのを防ぐ** (Fable 検収の軽微 1 件) —
    // 既に settled の Action へもう一度当てても、台帳は 1 回ぶんしか変わらない
    const settleable = ['accepted', 'running'].includes(action.state)
      || (action.state === 'reconcile' && isNonEmptyString(action.delivery?.runId));
    if (!settleable) {
      return {
        ok: false,
        settled: false,
        notes: [`ℹ️ 案件 ${action.caseId} の ${actionId} は ${action.state} なので、この戻りは記録しません`],
      };
    }

    if (contract.finding) {
      const record = store.snapshot.cases?.[action.caseId] ?? null;
      const added = commit(`${action.caseId} の気づき`, (s) => addFinding(s, {
        mandateId: record?.mandateId,
        expected: contract.finding.expected,
        actual: contract.finding.actual,
        // **誰の観測かを残す** — 出所の無い気づきは後から評価できない
        source: { kind: 'report', botKey: action.target?.botKey ?? null, runId },
        subject: {
          subjectId: contract.finding.subject_id,
          conditionId: contract.finding.condition_id,
          // 事象の一期間は**ブリッジが決める** — bot に名乗らせない
          episodeId: `${action.caseId}:${contract.finding.condition_id}`,
        },
        hypothesis: contract.finding.hypothesis ?? null,
      }, at));
      notes.push(added.ok
        ? `📝 気づきを ${added.result.findingId} として残しました (採用は決定権者の判断)`
        : `⚠️ 気づきを残せませんでした (${added.code}: ${added.reason ?? ''})`);
    }

    const outcome = verifyFailed ? 'verify-failed' : 'ok';
    // 理由は**理由として読める形**で残す (台帳に `npm test` とだけ書かれていても意味が取れない)
    const reason = verifyFailed ? `verify NG (${oneLine(verifyResult.command ?? 'verify', 60)})` : '';
    const settleInput = { result: { runId, outcome, reason } };
    if (contract.result) {
      settleInput.result = {
        runId,
        outcome,
        reason,
        // **NG のときは成果物を持たせない** — artifact があると検収待ちへ進んでしまう
        artifact: verifyFailed ? null : contract.result.artifact ?? null,
        observed: contract.result.observed ?? [],
        claimed: contract.result.claimed ?? [],
      };
      // **観測と主張を分けて証拠に残す** — 検収は observed にだけ結ばれる
      settleInput.evidence = {
        source: { kind: 'bot', botKey: action.target?.botKey ?? null, runId, actionId },
        observed: {
          facts: contract.result.observed ?? [],
          ...(verifyResult ? { verify: verifyResult.ok ? 'ok' : 'failed' } : {}),
        },
        claimed: { statements: contract.result.claimed ?? [] },
      };
    }
    // 相談の戻り。**受諾の記録は settle とは別の update** で、順序も決まっている —
    // 先に相談を settle して Case を `waiting(offer)` にし、その後で受諾が active にする。
    // 逆にすると、受諾で立てた契機を settle が上書きしてしまう
    const offerClaimId = isNonEmptyString(action.offerClaimId) ? action.offerClaimId : null;
    const consulted = offerClaimId && isPlainObject(contract.claim) ? offerClaimId : null;
    const strayClaim = !offerClaimId && isPlainObject(contract.claim);
    // **相談なのに返事が無い。** `claim` を書かずに `next.plan` だけ返されると、申し出は `offered` の
    // まま (誰も引き受けていない) なのに、authority の Claim を借りて相談先が動き続ける —
    // 責任主体が決まらないまま仕事だけ進む形になる (Opus2 指摘 2026-09-08 / `strayClaim` の逆側)。
    // 次の一手は使わず `waiting(offer)` へ倒し、返事が要ることを notes で返す
    const unanswered = offerClaimId && !isPlainObject(contract.claim) ? offerClaimId : null;

    // 相談の settle は**引受け待ち**へ倒す。owner が既に居る案件でも `waiting(authority)` を
    // 借りる必要はない (S2-4a で撤去) — 契機は `planActionOn` が owner の生きた Action を
    // 指したまま保つので、この待ちは書かれても採用されず `keptTrigger` で返ってくる
    const offerWaiting = (claimId, condition) => ({
      waiting: {
        reason: 'offer',
        condition: `${store.snapshot.claims?.[claimId]?.responsibility ?? '引受け'}${condition}`,
      },
    });
    // observe の門は**この戻りが実際に mapNext を使うときだけ**見る (verify NG と相談の返事は
    // 先に別の待ちへ倒れるので、そこで kind を断っても何も変わらない)
    const mapped = mapNext(contract.next, action);
    const gated = !verifyFailed && !consulted && !unanswered
      && mapped?.plan && blockedByObserve(mapped.plan.kind)
      ? mapped.plan.kind
      : null;
    // NG のときは bot が書いた次の一手を使わない (直すまで先へ進めない)
    const next = verifyFailed
      ? {
        waiting: {
          reason: 'evidence',
          condition: `verify が通っていない (${oneLine(verifyResult.command ?? 'verify', 60)}) — 直してから次へ進む`,
        },
      }
      // 相談の settle では**受諾を待つ**形にしておく。次の一手は受諾と同じ update で積む
      : consulted
        ? offerWaiting(consulted, ' の受諾を記録する')
        : unanswered
          ? offerWaiting(unanswered, ' の返事がない — `claim.decision` を書いて出し直す')
          : gated
            ? observeWaiting(gated)
            : mapped;
    if (next) settleInput.next = next;

    const before = Object.keys(store.snapshot.actions ?? {});
    const settled = commit(`${actionId} の settled`, (s) => settleAction(s, actionId, settleInput, at));
    if (!settled.ok) {
      notes.push(`⚠️ 案件 ${action.caseId} を進められませんでした (${settled.code}: ${settled.reason ?? ''})`);
      return { ok: false, settled: false, notes };
    }
    const state = store.snapshot.cases?.[action.caseId]?.state ?? '不明';
    // **実際に起きたことを書く。** 「next.plan を書いたか」ではなく「Action が増えたか」を見る —
    // artifact があると台帳は検収待ちへ進んで plan を作らない (Opus2 S2-3a レビュー ③)
    const planned = Object.keys(store.snapshot.actions ?? {}).find((id) => !before.includes(id)) ?? null;
    // **台帳が契機を保った**ときは待ちに倒したと書かない (Fable 検収 (a))。owner が決まった後の
    // 2 通目の返事は `waiting(offer)` で settle されるが、owner の Action が生きているので
    // 台帳はそちらを保つ — notes が「待ちにしました」と言うと実際と食い違う
    const keptTrigger = settled.result?.keptTrigger === true;
    const owner = store.snapshot.cases?.[action.caseId]?.owner ?? null;
    if (verifyFailed) {
      notes.push(`⛔ verify NG のため案件 ${action.caseId} は先へ進めていません (state: ${state}) — 直してから次の一手を書いてください`);
    } else if (settled.result.applied === false) {
      notes.push(`ℹ️ 案件 ${action.caseId} は ${settled.result.code} なので結果だけ残しました (state: ${state})`);
    } else if (planned) {
      // **Action を作りかつ契機を保ったときは両方を書く** (Fable 検収 (b))。「立てました」だけだと
      // その一手が案件の次の契機になったように読めるが、実際は別の仕事が進んでいる
      notes.push(`▶️ 案件 ${action.caseId} の次の一手 ${planned} を立てました (state: ${state})`
        + (keptTrigger
          ? ` — 契機はそのまま (${owner ? `owner は既に ${owner}` : '引受け待ちのまま'})`
          : ''));
    } else if (state === 'verifying') {
      notes.push(`✅ 案件 ${action.caseId} の成果を提出しました (検収待ち)`
        + `${next?.plan ? ' — 成果物があるので next.plan は積んでいません' : ''}`);
    } else if (keptTrigger) {
      notes.push(
        `ℹ️ 案件 ${action.caseId} の次の契機はそのままです`
        + `${owner ? ` (owner は既に ${owner})` : ''} — 進んでいる仕事は止めていません (state: ${state})`,
      );
    } else if (!consulted && !unanswered) {
      notes.push(`⏸ 案件 ${action.caseId} は ${next?.waiting?.reason ?? '次の契機'} 待ちにしました (state: ${state})`);
    }

    // 門で断ったことは必ず返す — 黙って捨てると「next.plan を書いたのに何も起きない」になる
    if (gated) notes.push(observeNote(action.caseId, gated));

    // 相談ではない job が `claim` を書いてきた — 黙って捨てない (書いたのに効かない、を残す)
    if (strayClaim) {
      notes.push('⚠️ この job は相談ではありません — `claim` は記録していません (引受けは相談への返事でだけ成立します)');
    }
    // 相談の job が返事を書かなかった — 進んでいないことを見えるようにする
    if (unanswered) {
      notes.push(
        'ℹ️ この job は引受けの相談です — `claim.decision` (accept / decline) が無いので'
        + '引受けは記録していません'
        + (keptTrigger ? '' : `。次の一手も積まず引受け待ちのままです (state: ${state})`),
      );
    }
    if (consulted) notes.push(...applyClaimDecision(consulted, contract, action, at));

    return { ok: true, settled: true, notes };
  }

  /**
   * 相談への返事を Claim へ写す。**受諾は「書いたから成立する」ものではない** —
   * 実効権限を再検証し、同じ責務を先に受けた人が居れば 2 人目は declined に落ちる。
   *
   * `occupied` / `permission` はどちらも `ok: false` だが、**返ったスナップショットに
   * declined と理由が書かれている**ので保存する (`keepRefusal`)。
   */
  function applyClaimDecision(offerClaimId, contract, action, at) {
    const claim = contract.claim;
    const notes = [];
    const offered = store.snapshot.claims?.[offerClaimId] ?? null;
    const responsibility = offered?.responsibility ?? '引受け';

    if (claim.decision === 'decline') {
      const out = commit(`${offerClaimId} の辞退`, (s) => declineClaim(s, offerClaimId, claim.reason, at));
      notes.push(out.ok
        ? `↩️ 辞退を記録しました (${oneLine(claim.reason ?? '', 80)})`
        : `⚠️ 辞退を記録できませんでした (${out.code}: ${out.reason ?? ''})`);
      return notes;
    }

    // 受諾 — 実効権限を**受諾の時点で**もう一度確かめる
    const permission = checkPermission(action, offered);
    // **受諾の最初の一手は新しい Claim に結ぶ** — mapNext は「いまの Action の Claim」を
    // 入れるが、受諾では相談を出した authority ではなく受けた本人の Claim が持ち主になる
    const mapped = mapNext(contract.next, action);
    let plan = mapped?.plan
      ? { kind: mapped.plan.kind, note: mapped.plan.note, target: mapped.plan.target }
      : null;
    // observe の門は受諾の最初の一手にも掛ける。**引受けそのものは通す** (記録は observe の仕事) —
    // 起こせないのは Action の方なので、案件を活性化する受諾では待ちを代わりに渡す
    const gated = plan && blockedByObserve(plan.kind) ? plan.kind : null;
    if (gated) plan = null;
    const accepted = commit(`${offerClaimId} の受諾`, (s) => acceptClaim(s, offerClaimId, {
      permissionOk: permission.ok,
      permissionReason: permission.ok ? null : `実効権限の再検証に通りませんでした: ${permission.reasons.join(' / ')}`,
      plan: plan ?? undefined,
      waiting: gated ? observeWaiting(gated).waiting : undefined,
    }, at), { keepRefusal: true });

    if (accepted.refused) {
      if (accepted.code === 'occupied') {
        notes.push(`⛔ 既に別の担当が受諾済みです (occupied) — ${offerClaimId} は declined として記録しました`);
      } else if (accepted.code === 'permission') {
        notes.push(`⛔ 実効権限の再検証で落ちました (${permission.reasons.join(' / ')}) — declined として記録しました`);
      } else {
        notes.push(`⚠️ 受諾を記録できませんでした (${accepted.code}: ${accepted.reason ?? ''})`);
      }
      return notes;
    }
    if (!accepted.ok) {
      notes.push(accepted.code === 'plan-required'
        ? `⚠️ ${responsibility} を引き受けるには最初の一手 (\`next.plan\`) が要ります — 受諾していません`
        : `⚠️ 受諾を記録できませんでした (${accepted.code}: ${accepted.reason ?? ''})`);
      return notes;
    }
    const generation = accepted.result.generation ?? '?';
    notes.push(`✅ ${offerClaimId} を ${responsibility} として受諾しました (世代 ${generation})`
      + `${accepted.result.actionId ? ` — 最初の一手 ${accepted.result.actionId} を立てました` : ''}`);
    if (gated) notes.push(observeNote(action.caseId, gated));
    return notes;
  }

  /** 実効権限の再検証 (判断は `src/society-policy.js` の純粋関数が持つ) */
  function checkPermission(action, offered) {
    const snap = store.snapshot;
    const record = snap.cases?.[action.caseId] ?? null;
    const mandate = record ? snap.mandates?.[record.mandateId] ?? null : null;
    const channelName = action.target?.channel ?? null;
    return checkEffectivePermission({
      botKey: offered?.botKey ?? action.target?.botKey ?? null,
      bots: botFacts(),
      channelName,
      structuredOutput: channelStructuredOutput(channelName),
      mandate,
      claim: offered,
      roster: threadRoster(action.target?.threadId ?? null),
    });
  }

  /**
   * 契約の `next` → `settleAction` の `next`。
   *
   * **宛先とスレッドは台帳が決める** — bot は「何をするか」だけを書き、いまの Action と
   * 同じ相手・同じスレッドへ次の起動を積む。別の bot へ渡すのは相談 (`consult`) の仕事で、
   * それは S2-3b が受諾とセットで入れる。
   */
  function mapNext(next, action) {
    if (!next || typeof next !== 'object') return null;
    if (next.plan) {
      return {
        plan: {
          claimId: action.claimId,
          kind: next.plan.kind,
          // 要旨は Action に残す — 起動文と /case の材料 (遷移には効かない)
          note: next.plan.summary ?? null,
          target: { ...(action.target ?? {}) },
        },
      };
    }
    if (next.waiting) {
      // 契約側は `why` (FIELD_LABELS の衝突を避けた名前)、台帳側は `reason`
      return { waiting: { reason: next.waiting.why, condition: next.waiting.condition } };
    }
    return null;
  }

  /**
   * 受付の記録 (`accepted` + 消費の確定)。**これが保存できるまで実行キューへ渡さない**。
   * @returns {{ok: boolean, code?: string, reason?: string}}
   */
  function noteAccepted(actionId, { runId, messageId = null } = {}, at = now()) {
    // 境界② (投稿は出たが `sent` の保存前に落ちた) で受け付けたときは、受付と同じ流れで
    // 投稿 ID も記録する — ここで書いておかないと、照合が「送ったのに投稿が無い」と読む
    const action = store?.snapshot?.actions?.[actionId];
    if (action && action.state === 'sending' && messageId && !action.delivery?.messageId) {
      const sent = commit(`${actionId} の sent (受付から補完)`, (s) => markSent(s, actionId, { messageId }, at));
      if (!sent.ok) return sent;
    }
    return commit(`${actionId} の受付`, (s) => markAccepted(s, actionId, { runId }, at));
  }

  /** job が走り出した (`running`)。**失敗しても job は止めない** (照合が拾う) */
  function noteRunning(actionId, at = now()) {
    const out = commit(`${actionId} の running`, (s) => markRunning(s, actionId, at));
    if (!out.ok) log.error?.(`[society] ${actionId} の running を保存できませんでした (${out.code})`);
    return out;
  }

  /**
   * job が終わった (`settled`)。次の一手は **S2-3 の構造化された戻り**で置き換えるので、
   * ここでは「戻りを見て決める」待ちにしておく (成果物なし = Case は `waiting(evidence)`)。
   *
   * `terminal` / `stopped` / `stale-generation` は失敗にしない — 結果は残っている。
   */
  function noteSettled(actionId, { runId = null, outcome = null, reason = '' } = {}, at = now()) {
    const out = commit(`${actionId} の settled`, (s) => settleAction(s, actionId, {
      result: { outcome, runId, reason: reason || null },
      next: {
        waiting: {
          reason: 'evidence',
          condition: `job ${runId ?? '?'} の戻りから次の一手を決める (S2-3 の構造化された戻りで置き換える)`,
        },
      },
    }, at));
    if (!out.ok) {
      // 既に settled = 構造化された戻りが先に写している (fallback が二重に呼ばれただけ)。
      // エラーとして残すと「毎回失敗している」に見える
      if (out.code === 'bad-state') return { ok: true, skipped: true, code: out.code };
      log.error?.(`[society] ${actionId} の settled を保存できませんでした (${out.code})`);
    }
    return out;
  }

  // ---- 照合 (reconcile) ----

  /** 宛先スレッドを 1 回ずつ走査して、印 → messageId を集める */
  async function scanForMarkers(live) {
    const since = new Map();
    for (const action of live) {
      const threadId = action.target?.threadId ?? null;
      if (!threadId) continue;
      const at = msOf(action.delivery?.sendingAt ?? action.createdAt);
      const current = since.get(threadId);
      if (current === undefined || (at !== null && (current === null || at < current))) {
        since.set(threadId, at);
      }
    }
    const found = new Map();
    const complete = new Map();
    for (const [threadId, from] of since) {
      if (typeof scanThread !== 'function') {
        complete.set(threadId, false);
        continue;
      }
      try {
        const scan = await scanThread({ threadId, since: from });
        complete.set(threadId, scan?.complete === true);
        for (const message of scan?.messages ?? []) {
          const id = readActionId(message?.content);
          if (id && !found.has(id)) found.set(id, String(message.id));
        }
      } catch (err) {
        complete.set(threadId, false);
        log.error?.(`[society] スレッド ${threadId} を走査できませんでした: ${err?.message ?? err}`);
      }
    }
    return { found, complete };
  }

  /**
   * その記録は「受付が生きている」か。
   *
   * **開いただけで走らなかった記録は数えない** — 受付の途中で台帳へ書けず `cancel` した記録
   * (`startedAt` が無く `outcome: 'cancelled'`) を受付とみなすと、job は走っていないのに
   * 照合が Action を `accepted` + `charged` にしてしまう (Fable 検収 2026-09-07 (a) の幻の受付)。
   */
  function hasRun(record) {
    if (!record) return false;
    if (record.outcome === null || record.outcome === undefined) return true; // まだ終わっていない
    return typeof record.startedAt === 'string' && record.startedAt !== '';
  }

  /** 実行記録に受付があるか (操作 ID で探す。**走ったことのある記録だけ**) */
  function runIdFor(actionId) {
    try {
      const runs = jobRuns?.forAction?.(actionId) ?? [];
      return runs.find((record) => hasRun(record))?.id ?? null;
    } catch (err) {
      log.error?.(`[society] 実行記録を読めませんでした: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 外側 (Discord の投稿・実行記録) と台帳を Action ID で突き合わせる。
   *
   * **走査が不完全なまま「見つからない」と確定しない**。probe の `null` は
   * 「探したが無かった」と読まれ、`reconcileActions` は送信から 2 分でそれを `cancelled` に
   * するので、走査できなかった Action を null で答えると届いている起動を取り消してしまう。
   *
   * なので**照合そのものは毎 tick 必ず回し、走査できなかった Action だけを `hold` に預ける**
   * (`cases.js` の任意引数)。1 件の消えたスレッドで全案件の判断が止まらず、預けた分は
   * 状態も予約も動かないまま次の tick へ回る。
   */
  async function reconcile(at = now()) {
    const snap = store?.snapshot;
    const empty = {
      checked: 0, accepted: [], sent: [], cancelled: [], pending: [], stale: [], held: [], settled: [],
    };
    if (!snap) return empty;
    // **外に出ている Action が 1 件も無くても回す** — 回収したいのは accepted / running のまま
    // 残った Action で、それは live (sending / sent / reconcile) に入らない
    const settled = settleDeadRuns(at);
    const live = Object.values(snap.actions ?? {})
      .filter((a) => ['sending', 'sent', 'reconcile'].includes(a.state));
    if (live.length === 0) return { ...empty, settled };

    const { found, complete } = await scanForMarkers(live);
    const scanned = (action) => complete.get(action.target?.threadId ?? '') === true;

    // **走査できたスレッドの後始末は、走査できないスレッドと切り離して済ませる** —
    // 1 件の消えたスレッドで全案件の予約が返らなくなるのを避ける
    const cancelled = cancelUnaccepted(at, scanned);

    // 走査できなかったスレッドの Action は「探せなかった」— probe では「無かった」と
    // 区別できないので、**名指しで判断を預ける** (Fable 検収の裁定で cases.js に口が付いた)。
    // 照合そのものは毎 tick 必ず回す = 走査できた Action は他人の都合で待たされない
    const hold = live.filter((a) => !scanned(a) && !found.has(a.id)).map((a) => a.id);
    if (hold.length > 0 && !noticedScanGap) {
      log.error?.(
        `[society] スレッドを最後まで走査できないので判断を保留します (${hold.join(' / ')}) — `
        + '見つからないことを確かめられないまま取り消すと、届いている起動を落とします',
      );
    }
    noticedScanGap = hold.length > 0;

    const probe = {
      runFor: (actionId) => runIdFor(actionId),
      messageFor: (actionId) => found.get(actionId) ?? null,
    };
    const out = commit('照合', (s) => reconcileActions(s, probe, at, { hold }));
    const result = out.ok ? out.result : { sent: [], accepted: [], cancelled: [], pending: [], stale: [] };
    // **hold は「見えていない」の目印**なので、次の照合まで持っておく (`/status` と `/case` が読む)
    heldActionIds = hold;
    return {
      checked: live.length,
      ...result,
      held: hold,
      settled,
      cancelled: [...result.cancelled, ...cancelled],
    };
  }

  /**
   * 受け付けたのに実行記録が終わっている Action を終端まで書く。
   *
   * プロセスが job の途中で死んだ形と、`noteSettled` を取りこぼした形の回収点。
   * 照合 (`reconcileActions`) が見るのは `sending / sent / reconcile` だけなので、
   * `accepted` / `running` のまま残った Action は**ここでしか拾えない** (Fable 検収 (b))。
   * 記録がまだ生きているものは触らない (走っている最中に確定させない)。
   */
  function settleDeadRuns(at) {
    const settled = [];
    for (const action of Object.values(store?.snapshot?.actions ?? {})) {
      if (!['accepted', 'running'].includes(action.state)) continue;
      const runId = action.delivery?.runId;
      if (typeof runId !== 'string' || runId === '') continue;
      let record;
      try {
        record = jobRuns?.get?.(runId) ?? null;
      } catch (err) {
        log.error?.(`[society] 実行記録 ${runId} を読めませんでした: ${err?.message ?? err}`);
        continue;
      }
      if (!record || record.outcome === null || record.outcome === undefined) continue; // live は触らない
      const out = noteSettled(action.id, {
        runId,
        outcome: record.outcome,
        reason: record.reason ?? record.stageDetail ?? '',
      }, at);
      if (out.ok) {
        settled.push(action.id);
        log.log?.(`[society] ${action.id} は job ${runId} が ${record.outcome} で終わっていたので確定しました`);
      }
    }
    return settled;
  }

  /**
   * 送ってはあるが受け付けられないまま置かれている Action を取り消して予約を返す。
   *
   * **走査が complete で、実行記録にも無いときだけ**「未受付を確認した」と言える。
   * ここは Action 単位で判断するので、別のスレッドが走査できなくても止まらない。
   */
  function cancelUnaccepted(at, scanned) {
    const cancelled = [];
    for (const action of Object.values(store.snapshot?.actions ?? {})) {
      if (action.state !== 'sent' || !action.delivery?.messageId || action.delivery?.runId) continue;
      if (!scanned(action)) continue;
      const sentAt = msOf(action.delivery.sentAt ?? action.delivery.sendingAt);
      if (sentAt === null || at - sentAt < unacceptedGraceMs) continue;
      if (runIdFor(action.id) !== null) continue;
      const minutes = Math.round((at - sentAt) / 60000);
      const why = `送信から ${minutes} 分たっても受付が無いことを確認 (スレッド走査は完了・実行記録なし)`;
      // `sent` からは直接取り消せない (遷移表)。**照合へ倒してから**未受付を確定させる —
      // 台帳にも「送った → 照合した → 受付が無いと確かめた → 返した」の順で残る
      const marked = commit(`${action.id} の照合待ち`, (s) => markReconcile(s, action.id, why, at));
      if (!marked.ok) continue;
      const done = commit(`${action.id} の取り消し`, (s) => cancelAction(s, action.id, {
        confirmedUnaccepted: true,
        reason: why,
      }, at));
      if (done.ok) {
        cancelled.push(action.id);
        log.log?.(`[society] ${action.id} は ${minutes} 分受け付けられなかったので取り消しました (予約を返却)`);
      }
    }
    return cancelled;
  }

  /**
   * 返事の来ない申し出を期限で閉じる (「`offered` は `offerRecheckMin` ごとに再確認」)。
   *
   * **相談がまだ生きているうちは触らない。** 送っただけ・走っている最中の申し出を
   * 期限で閉じると、返ってきた受諾が `not-offered` で弾かれて job が丸ごと無駄になる。
   * 数えるのは相談が終わって (settled / cancelled) からで、起点は申し出た時刻
   * (`offeredAt`) — 「声を掛けてから何分たったか」が人に読める数え方だから。
   *
   * 期限切れは 1 つの update にまとめる (何件あっても版は 1 つ)。
   */
  function expireOffers(at = now()) {
    if (!enabled || store?.healthy !== true) return { expired: [] };
    const s = store.snapshot;
    const recheckMs = Math.max(1, society?.offerRecheckMin ?? 5) * 60_000;
    const consultOf = new Map();
    for (const action of Object.values(s.actions ?? {})) {
      if (isNonEmptyString(action.offerClaimId)) consultOf.set(action.offerClaimId, action);
    }
    const due = [];
    for (const claim of Object.values(s.claims ?? {})) {
      if (claim.state !== 'offered') continue;
      const consult = consultOf.get(claim.id);
      // 相談を伴わない申し出 (手で置いたもの) と、まだ返事を待てる相談は触らない
      if (!consult || !['settled', 'cancelled'].includes(consult.state)) continue;
      const since = Date.parse(claim.offeredAt ?? '');
      if (!Number.isFinite(since) || at - since < recheckMs) continue;
      due.push({ claimId: claim.id, minutes: Math.floor((at - since) / 60_000) });
    }
    if (due.length === 0) return { expired: [] };

    const out = commit('返事の来ない申し出の期限切れ', (draft) => {
      let next = draft;
      const expired = [];
      for (const item of due) {
        const done = expireClaim(next, item.claimId, `返事がないまま ${item.minutes} 分`, at);
        if (!done.ok) continue; // 読んでから書くまでに動いていたら飛ばす (次の tick で拾う)
        next = done.snapshot;
        expired.push(item.claimId);
      }
      return { ok: true, snapshot: next, expired };
    });
    if (!out.ok) {
      log.error?.(`[society] 申し出の期限切れを保存できませんでした (${out.code}): ${out.reason ?? ''}`);
      return { expired: [] };
    }
    const expired = out.result?.expired ?? [];
    if (expired.length > 0) {
      log.log?.(`[society] 返事の来ない申し出を ${expired.length} 件 expired にしました (${expired.join(' / ')})`);
    }
    return { expired };
  }

  // ---- 停止と再開 ----

  /** まだ止められる案件か (終端・既に停止済みは対象外 — 上書きすると誰がいつ止めたかが消える) */
  function stoppable(record) {
    return Boolean(record) && !isTerminalCase(record) && !record.stop;
  }

  /**
   * `/stop` で止めた job の案件へ停止マーカーを付ける。
   *
   * **job を止める前に呼ぶ。** 先に印が付いていれば、実行中 job の settle も待機中 job の
   * 取り消しも `settleAction` の停止分岐 (`code: 'stopped'`) に入り、結果は残しつつ Case は
   * 動かず契機が `waiting(paused)` になる。後から印を付けると、その間に届いた戻りが
   * 案件を先へ進めてしまう。
   *
   * 範囲は `/stop` と同じ粒度 — `scope:this` は「止めた job の案件 ∪ このスレッドに結ばれた
   * 案件」、`scope:all` は全案件。**1 回の update** で付けるので、途中で落ちて半分だけ
   * 止まった状態にはならない。
   *
   * @param {{threadId?: string|null, all?: boolean, userId?: string|null, jobIds?: string[]}} p
   * @returns {{ok: boolean, stopped: string[], skipped: string[], code?: string, reason?: string}}
   */
  function stopCases({ threadId = null, all = false, userId = null, jobIds = [] } = {}, at = now()) {
    if (!enabled) return { ok: true, stopped: [], skipped: [], code: 'off' };
    if (store?.healthy !== true) {
      return {
        ok: false, stopped: [], skipped: [], code: 'halted',
        reason: haltReason() ?? '台帳を開けていません',
      };
    }
    const snap = store.snapshot;
    // caseId → 止めた job の Action (無ければ null)。**job から引くのが第一** —
    // スレッドに結ばれていない案件でも、走っていた job の分は確実に止まる
    const targets = new Map();
    for (const jobId of Array.isArray(jobIds) ? jobIds : []) {
      // 実行記録に残っている案件の紐づけ (`{caseId, actionId, claimGeneration}`)
      const bound = jobRuns?.get?.(jobId)?.society ?? null;
      if (!isNonEmptyString(bound?.caseId) || targets.has(bound.caseId)) continue;
      if (!stoppable(snap.cases?.[bound.caseId])) continue;
      targets.set(bound.caseId, isNonEmptyString(bound.actionId) ? bound.actionId : null);
    }
    for (const record of Object.values(snap.cases ?? {})) {
      if (targets.has(record.id) || !stoppable(record)) continue;
      if (all) {
        targets.set(record.id, null);
        continue;
      }
      if (!isNonEmptyString(threadId)) continue;
      const linked = (record.links ?? [])
        .some((link) => link?.kind === 'thread' && String(link.id) === String(threadId));
      if (linked) targets.set(record.id, null);
    }
    if (targets.size === 0) return { ok: true, stopped: [], skipped: [] };

    const out = commit('/stop による案件の停止', (draft) => {
      let next = draft;
      const stopped = [];
      const skipped = [];
      for (const [caseId, actionId] of targets) {
        if (!stoppable(next.cases?.[caseId])) {
          skipped.push(caseId);
          continue;
        }
        const done = stopCase(next, caseId, {
          by: 'human', actionId, sourceId: userId, reason: '/stop',
        }, at);
        if (!done.ok) {
          skipped.push(caseId);
          continue;
        }
        next = done.snapshot;
        stopped.push(caseId);
      }
      return { ok: true, snapshot: next, stopped, skipped };
    });
    if (!out.ok) {
      log.error?.(`[society] 案件を止められませんでした (${out.code}): ${out.reason ?? ''}`);
      return { ok: false, stopped: [], skipped: [], code: out.code, reason: out.reason };
    }
    const stopped = out.result?.stopped ?? [];
    if (stopped.length > 0) {
      log.log?.(`[society] /stop で案件 ${stopped.join(' / ')} に停止マーカーを付けました`);
    }
    return { ok: true, stopped, skipped: out.result?.skipped ?? [] };
  }

  /**
   * 停止の解除 (`/case resume:<id>`)。**owner の明示操作だけ** — 認可は interactions 側の門で、
   * ここは台帳の遷移と、立て直した一手を返すだけ。
   */
  function resumeStoppedCase(caseId, at = now()) {
    const out = commit(`案件 ${caseId} の再開`, (s) => resumeCase(s, caseId, { by: 'owner-command' }, at));
    if (!out.ok) return { ok: false, code: out.code, reason: out.reason };
    return { ok: true, code: out.result?.code ?? 'resumed', replanned: out.result?.replanned ?? null };
  }

  // ---- `/case` の口 (手動操作) ----

  /** 終端でない = まだ誰かが見る必要がある案件 */
  const LIVE_CASE_STATES = ['open', 'active', 'waiting', 'verifying'];

  /** 引受けを「責務 (bot)」で読む。Claim が消えていても ID は出す (追える形を残す) */
  function claimLabel(s, claimId) {
    const claim = claimId ? s.claims?.[claimId] : null;
    if (!claim) return claimId ? `${claimId} (台帳に無い)` : '担当なし';
    return `${claim.responsibility} ${claim.botKey ?? '?'}`;
  }

  /** 次の契機の 1 行。**何を待っているかを必ず書く** — 件数だけでは次の一手が決まらない */
  function triggerLine(s, record) {
    const next = record?.nextTrigger;
    if (!isPlainObject(next)) return '契機なし (保存できない形)';
    if (next.kind === 'waiting') {
      return `待ち (${next.reason}) — ${oneLine(next.condition ?? '', 70)}`;
    }
    const action = s.actions?.[next.actionId] ?? null;
    const where = action?.target?.botKey ?? '宛先未定';
    const head = next.kind === 'runningAction' ? '実行中' : '次の一手';
    return `${head} ${next.actionId} ${action?.kind ?? '?'} → ${where} (${action?.state ?? '?'})`;
  }

  /** 進行中の案件の一覧 (終結したものは出さない — 出すと「いま見るもの」が埋もれる) */
  function caseList(escape) {
    const s = snapshot();
    const rows = Object.values(s?.cases ?? {})
      .filter((c) => LIVE_CASE_STATES.includes(c.state))
      .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
    if (rows.length === 0) return '📁 進行中の案件はありません';
    const shown = rows.slice(0, 15);
    const lines = shown.map((c) => [
      // 止めた案件は行頭で分かるようにする — 一覧で「動いていない理由」が読めないと、
      // 期限切れの待ちと同じに見えて誰かが催促しに行くことになる
      `${c.stop ? '⏹ ' : ''}**${c.id}** \`${c.state}\` / ${escape(claimLabel(s, c.owner))} / `
      + `${escape(oneLine(c.desiredOutcome ?? '', 60))}`,
      // 字下げは全角空白 (U+3000) でしか出せない — Discord は行頭の半角空白を畳む
      // eslint-disable-next-line no-irregular-whitespace
      `　${escape(triggerLine(s, c))}`,
    ].join('\n'));
    const more = rows.length > shown.length ? `\n…ほか ${rows.length - shown.length} 件` : '';
    return `📁 進行中の案件 ${rows.length} 件\n${lines.join('\n')}${more}`;
  }

  /** 1 件の詳細。**予算と待ちまで出す** — 止まっている案件の次の一手はそこで決まる */
  function caseDetail(caseId, escape) {
    const s = snapshot();
    const record = s?.cases?.[caseId];
    if (!record) return `⚠️ 案件 ${escape(String(caseId))} は台帳にありません`;
    const mandate = s.mandates?.[record.mandateId] ?? null;
    const claims = Object.values(s.claims ?? {}).filter((c) => c.caseId === caseId);
    const actions = Object.values(s.actions ?? {}).filter((a) => a.caseId === caseId);
    const live = actions.filter((a) => !['settled', 'cancelled'].includes(a.state));
    const budget = record.budget ?? {};
    const lines = [
      `📁 **${record.id}** \`${record.state}\` (版 ${record.version})`,
      `目的: ${escape(oneLine(record.desiredOutcome ?? '', 200))}`,
      `受入: ${escape(oneLine(record.acceptance?.condition ?? '(未設定)', 200))} (v${record.acceptance?.version ?? '?'})`,
      `Mandate: ${escape(mandate ? `${mandate.key} v${mandate.version} (${mandate.id})` : String(record.mandateId))}`,
      `担当: ${escape(claimLabel(s, record.owner))}`,
      `契機: ${escape(triggerLine(s, record))}`,
      `予算: 配分 ${budget.allocated ?? '無制限'} / 予約 ${budget.reserved ?? 0} / 確定 ${budget.charged ?? 0}`,
    ];
    if (record.stop) {
      // **誰がいつ何を止めたかまで出す。** 止めた本人が居なくなった後に、
      // 解除してよいかを判断できるのはこの 3 つ (by / at / どの起動を止めたか) だから
      lines.push(
        `⏹ 停止: ${escape(String(record.stop.by ?? '?'))} / ${escape(String(record.stop.at ?? '?'))}`
        + ` / ${escape(String(record.stop.actionId ?? '起動なし'))}`
        + ` / ${escape(oneLine(record.stop.reason ?? '理由なし', 80))}`,
      );
      // 字下げは全角空白 (U+3000) でしか出せない — Discord は行頭の半角空白を畳む
      // eslint-disable-next-line no-irregular-whitespace
      lines.push(`　再開は \`/case resume:${escape(String(record.id))}\``);
    }
    const offers = claims.filter((c) => c.state === 'offered');
    if (offers.length > 0) {
      lines.push(`返事待ちの申し出: ${offers.map((c) => `${c.id} ${c.responsibility}→${c.botKey}`).join(' / ')}`);
    }
    if (live.length > 0) {
      lines.push(`外に出ている起動: ${live.map((a) => `${a.id} ${a.kind} (${a.state})`).join(' / ')}`);
    }
    const held = heldActionIds.filter((id) => s.actions?.[id]?.caseId === caseId);
    if (held.length > 0) lines.push(`⚠️ 照合で見きれていない起動: ${held.join(' / ')}`);
    return lines.join('\n');
  }

  /** その key の **active な最新版**の写し (無ければ null) */
  function activeMandateFor(s, key) {
    return Object.values(s?.mandates ?? {})
      .filter((m) => m.key === key && m.state === 'active')
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
  }

  /**
   * 人が案件を開く (`/case new`)。気づきの採用と同じ道を通す — Case は Finding からしか
   * 生えないので、手で開くときも Finding を 1 件作ってから採用する。
   *
   * 事象キーは**開いた瞬間 (時刻 + 台帳の版) で一意にする** — 人が「新しく開く」と言った
   * のだから、同じ目的でも既存 Case へ追記せずに別の案件にする。版まで混ぜるのは、
   * 同じミリ秒に 2 回開いたときに片方が既存へ吸われないようにするため。
   */
  function openCaseByHand({ mandateKey, goal, acceptance, threadId = null, userId = null }, at = now()) {
    // **写しを先に合わせる** — 設定に足したばかりの Mandate は台帳にまだ無い
    syncMandates(at);
    const s = snapshot();
    const mandate = activeMandateFor(s, mandateKey);
    if (!mandate) {
      const known = [...new Set(Object.values(s?.mandates ?? {})
        .filter((m) => m.state === 'active').map((m) => m.key))];
      return {
        ok: false,
        reason: `active な Mandate "${mandateKey}" が台帳にありません`
          + ` (写してあるのは ${known.length > 0 ? known.join(' / ') : 'なし'})`,
      };
    }
    let caseId = null;
    const out = commit(`案件を開く (${mandateKey})`, (draft) => {
      const finding = addFinding(draft, {
        mandateId: mandate.id,
        expected: goal,
        actual: '(手で開いた案件 — 実際の状態はこれから調べる)',
        source: { kind: 'sample', userId: userId ?? null },
        subject: {
          subjectId: mandateKey,
          conditionId: 'manual',
          episodeId: `manual:${new Date(at).toISOString()}#${store?.revision ?? 0}`,
        },
      }, at);
      if (!finding.ok) return finding;
      const adopted = adoptFinding(finding.snapshot, {
        findingId: finding.findingId,
        desiredOutcome: goal,
        acceptance: { condition: acceptance, version: 1 },
      }, at);
      if (!adopted.ok) return adopted;
      caseId = adopted.caseId;
      if (!isNonEmptyString(threadId)) return adopted;
      // スレッドを結んでおかないと、相談の宛先スレッドが決まらず配送の門で断られる
      return linkCase(adopted.snapshot, adopted.caseId, {
        kind: 'thread', id: threadId, role: '案件のスレッド',
      }, at);
    });
    if (!out.ok) return { ok: false, reason: `${out.code}: ${out.reason ?? ''}` };
    return { ok: true, caseId };
  }

  /**
   * `/case` の実体。**表示も台帳操作もここに集める** — interactions.js は引数を読んで
   * 何をするかを決めるだけで、台帳の形は知らない。
   *
   * @param {{action: 'list'|'detail'|'new'|'offer'|'resume', escape?: Function}} req
   */
  function caseCommand(req = {}) {
    const escape = typeof req.escape === 'function' ? req.escape : (s) => s;
    if (!enabled) return '⚠️ 社会の機構は off です (config.policy.json の society.mode)';
    if (store?.healthy !== true) {
      return `⛔ 台帳を開けていません — ${escape(oneLine(haltReason() ?? '理由不明', 160))}`;
    }
    const at = now();
    if (req.action === 'new') {
      const opened = openCaseByHand({
        mandateKey: req.mandateKey, goal: req.goal, acceptance: req.acceptance,
        threadId: req.threadId, userId: req.userId,
      }, at);
      if (!opened.ok) return `⚠️ 案件を開けませんでした: ${escape(oneLine(opened.reason, 300))}`;
      return `📁 案件 **${opened.caseId}** を開きました (引受け待ち)\n`
        + `${caseDetail(opened.caseId, escape)}`;
    }
    if (req.action === 'offer') {
      const out = offer({
        caseId: req.id,
        responsibility: req.responsibility,
        botKey: req.botKey,
        threadId: req.threadId,
        channel: req.channelName,
        summary: req.summary ?? null,
      }, at);
      if (!out.ok) return `⚠️ 相談を出せませんでした (${escape(String(out.code))}): ${escape(oneLine(out.reason ?? '', 300))}`;
      return `🤝 案件 **${escape(String(req.id))}** の ${escape(String(req.responsibility))} を `
        + `${escape(String(req.botKey))} へ相談します (${out.claimId} / ${out.actionId})\n`
        + '次の tick で起動します';
    }
    if (req.action === 'resume') {
      const out = resumeStoppedCase(req.id, at);
      if (!out.ok) {
        return `⚠️ 案件 **${escape(String(req.id))}** を再開できませんでした `
          + `(${escape(String(out.code))}): ${escape(oneLine(out.reason ?? '', 300))}`;
      }
      const head = `▶️ 案件 **${escape(String(req.id))}** を再開しました`;
      if (out.replanned) return `${head} — ${out.replanned} を立て直しました (次の tick で送信します)`;
      const record = snapshot()?.cases?.[req.id] ?? null;
      return `${head} — ${escape(triggerLine(snapshot(), record))}`;
    }
    if (req.action === 'detail') return caseDetail(req.id, escape);
    return caseList(escape);
  }

  /**
   * 1 tick 分。**照合を先に回してから配送する** — 外に出ているものを確定させる前に
   * 新しく送ると、同じ Case に二重の起動が並ぶ。
   *
   * `async` にしてあるのは投げ方をそろえるため (Opus2 S2-1 レビュー ③)。同期関数だと
   * `setInterval` のコールバックから投げた例外が Promise になる前に外へ抜ける。
   */
  async function societyTick(at = now()) {
    const stop = stopReason();
    noticeStop(stop.dispatch);
    if (stop.dispatch !== null && stop.reconcile !== null) {
      return { ran: false, reason: stop.dispatch, skipped: stop.dispatch, at };
    }
    // **写しは Case より先**。`caseContext` の authority は写しから引くので、
    // 写しの無い Mandate の Case を作らせない (ready 後の最初の tick で 1 回)
    if (!syncedMandates && store?.healthy === true) {
      syncedMandates = true;
      syncMandates(at);
    }
    // **照合は配送を止めていても回す**。順序も照合が先 — 外に出ているものを
    // 確定させる前に新しく送ると、同じ Case に二重の起動が並ぶ
    const reconciled = await reconcile(at);
    // 照合の後 (相談の Action が settled / cancelled に落ちてから) 期限を見る
    const expired = expireOffers(at).expired;
    const dispatched = stop.dispatch === null ? await dispatchPlanned(at) : 0;
    return { ran: true, dispatched, reconciled, expired, skipped: stop.dispatch ?? null, at };
  }

  /**
   * 止まっている理由のログは 1 回だけ。理由が変わればもう一度、解けたら「再開」を 1 回。
   * `off` と `not-ready` は異常ではないので黙る (起動直後に毎分出さない)。
   */
  function noticeStop(reason) {
    if (noticedStop === reason) return;
    if (reason === null) {
      if (noticedStop !== null && !QUIET_STOPS.includes(noticedStop)) {
        log.log?.(`[society] ${mode} を再開します (${noticedStop} が解けました)`);
      }
    } else if (!QUIET_STOPS.includes(reason)) {
      log.error?.(`[society] ⛔ ${reason} — ${stopDetail(reason)}`);
    }
    noticedStop = reason;
  }

  function stopDetail(reason) {
    if (reason === 'halted') return `社会由来の処理は止めます: ${haltReason() ?? '台帳を開けていません'}`;
    if (reason === 'paused') return '/pause 中なので新しい起動は作りません (照合と後始末は続けます)';
    return '受付を止めています (再起動・停止の途中) — 照合と後始末は続けます';
  }

  return {
    mode,
    enabled,
    haltReason,
    summary,
    snapshot,
    stopReason,
    societyTick,
    dispatchPlanned,
    reconcile,
    syncMandates,
    expireOffers,
    caseCommand,
    stopCases,
    screenAction,
    caseContext,
    applyTurn,
    offer,
    noteAccepted,
    noteRunning,
    noteSettled,
  };
}

/**
 * 起動ログの 1 行 (mode off なら null = 出さない)。
 * `/status` と同じ材料 (`summary()`) から作るので、表示と実態がずれない。
 */
export function societyStartupLine(summary) {
  if (!summary || summary.mode === undefined || summary.mode === 'off') return null;
  if (summary.haltReason) {
    return `[society] ⛔ ${summary.haltReason} — 社会由来の処理は止めます `
      + '(既存の受付・自律起動は動きます)';
  }
  const counts = summary.cases;
  const open = counts
    ? `案件 ${['open', 'active', 'waiting', 'verifying'].map((s) => `${s} ${counts[s]}`).join(' / ')}`
    : '案件の件数は不明';
  return `[society] mode=${summary.mode} data/society.json revision ${summary.revision} (${open})`;
}
