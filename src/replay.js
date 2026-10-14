// ハーネスの改訂の下書きの検証 (解き直し) — arXiv 2610.02616 (VERSE) の「下書きの改訂を提出の前に
// 走らせて確かめる」と「今通っているタスクを 1 本混ぜて回帰を見る (カナリア)」を写したもの
// (docs/notes/2026-10-13-verse.md)。VERSE では検証なしで提案役を自己進化させると何もしないより悪く、
// 検証があると最良だった。本番の流れからは失敗がほとんど出ないので、過去の失敗を解き直すことが
// 改訂の材料になる失敗を作る唯一の手でもある。
//
// 流れ:
// 1. 役割文 (roles/) を触ったタスク R (ハーネスの改訂) の worker が完了すると、R はレビューへ進むが
//    レビュー担当はまだ呼ばない。R の作業ツリーにある下書きの役割文で、過去のタスクを解き直す
//    タスク (replay 欄付きの普通の板のタスク) を立てる:
//    - 差し戻しの再現 — R の理由が名指しした (#123)、レビューで差し戻されたことのある merge 済みの
//      タスク。狙った失敗が再発するか
//    - カナリア — 差し戻しの無い最近の merge 済みのタスク。前は通っていたものを壊していないか
//    解き直しは元のタスクが始まった版 (merge の第 1 親と元のブランチの分岐点) から走り、merge しない
// 2. 解き直しの worker が完了すると、レビューの証拠を測って取り下げ (ブランチは残す — レビュー担当が
//    差分を読む)、結果を replay 欄に残す
// 3. tick が「R の解き直しが全部落ち着いた (取り下げ・止まった) か、期限が来た」を見て R のレビューを
//    呼び、依頼に結果を載せる。**再発したか・カナリアが壊れたかを決めるのはレビュー担当** (§3.11)
//
// ここは判断の側 (純粋) と、元のタスクの基点を git で決める口だけ。板と Discord は src/bridge/board.js。

import { parseMergeNote } from './review-evidence-backtest.js';
import { awaitingReplays, isReplayTask, touchesHarness } from './scheduler.js';
import { runGit } from './worktree.js';

// 解き直しの物差しは判断の層 (src/scheduler.js) が持つ — 着手の同時枠と見回りも同じものを見る
export { awaitingReplays, isReplayTask };

/** 解き直しのタスクの題の頭。元の題の頭の [slug] は外して付ける (主題の進み具合に数えさせない) */
export const REPLAY_TITLE_PREFIX = '[replay]';

/** 解き直しを落ち着いたと数える状態 (取り下げ = 完了して結果を残した / 止まった = 要人間のまま) */
const SETTLED_STATES = Object.freeze(['dropped', 'merged', 'blocked']);

/** 依頼に載せる元の差し戻しの理由の長さ */
const REASON_CHARS = 240;

const msOf = (iso) => {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
const short = (sha) => String(sha ?? '').slice(0, 7);
const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** レビューで差し戻された / 封鎖された履歴 (新しい順) */
function sendBacks(task) {
  return (Array.isArray(task?.history) ? task.history : [])
    .filter((h) => h?.from === 'review' && (h.to === 'in-progress' || h.to === 'blocked'))
    .reverse();
}

const lastMerge = (task) => (Array.isArray(task?.history) ? task.history : []).filter((h) => h?.to === 'merged').at(-1) ?? null;

/**
 * 解き直す過去のタスクを選ぶ (純粋)。どちらも同じチャンネルの merge 済みで、merge の note が読める
 * (基点を決められる)・役割文を触らない・解き直しではないもの。
 *
 * - 差し戻しの再現: 改訂の理由 (と題) に `#123` で名指しされた順に、差し戻しの履歴があるもの `cases` 件まで
 * - カナリア: 名指しされていない・差し戻しの履歴が無い・`src/` を触るもののうち merge の新しい順に `canary` 件
 *
 * @param {object} revision 改訂のタスク (R)
 * @param {object[]} tasks ボードのタスク
 * @returns {Array<{task: object, kind: 'sent-back'|'canary', reason: string, merge: object}>}
 */
export function pickReplayCases(revision, tasks, { cases = 0, canary = 0 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const usable = (task) => task && task.channel === revision?.channel && task.state === 'merged'
    && !isReplayTask(task) && !touchesHarness(task) && String(task.id) !== String(revision?.id)
    && parseMergeNote(lastMerge(task)?.note) !== null;
  const named = [];
  for (const m of `${revision?.title ?? ''}\n${revision?.rationale ?? ''}`.matchAll(/#(\d+)/g)) {
    if (!named.includes(m[1])) named.push(m[1]);
  }
  const picked = [];
  for (const id of named) {
    if (picked.length >= Math.max(0, cases)) break;
    const task = list.find((t) => String(t?.id) === id);
    if (!usable(task) || sendBacks(task).length === 0) continue;
    picked.push({ task, kind: 'sent-back', reason: String(sendBacks(task)[0].note ?? '').trim(), merge: parseMergeNote(lastMerge(task).note) });
  }
  const canaries = list
    .filter((task) => usable(task) && !named.includes(String(task.id)) && sendBacks(task).length === 0)
    .filter((task) => (Array.isArray(task.touch) ? task.touch : []).some((p) => /^src[\\/]/.test(String(p))))
    .sort((a, b) => (msOf(lastMerge(b).at) ?? 0) - (msOf(lastMerge(a).at) ?? 0))
    .slice(0, Math.max(0, canary));
  for (const task of canaries) {
    picked.push({ task, kind: 'canary', reason: '', merge: parseMergeNote(lastMerge(task).note) });
  }
  return picked;
}

/**
 * 元のタスクが始まった版を git で決める (読むだけ)。merge commit の第 1 親 (merge 直前の基点) と
 * 元のブランチの先端の分岐点 — worker が着手したときの版。決まらなければ null
 */
export async function resolveReplayBase({ repoRoot, merge, git = runGit }) {
  if (!merge?.commit || !merge?.tip) return null;
  try {
    const base = (await git(repoRoot, ['merge-base', merge.tip, `${merge.commit}^1`])).trim();
    return /^[0-9a-f]{7,64}$/.test(base) ? base : null;
  } catch {
    return null;
  }
}

/**
 * 解き直しのタスクを立てる中身 (純粋)。題・理由・touch は元のタスクのまま (題の頭の [slug] だけ外す)。
 * worker には元のタスクと同じ依頼が届く — 解き直しであることは題の頭の印だけで伝わる
 *
 * @returns {{proposal: {channel, title, rationale, touch, jobBudget}, replay: object}}
 */
export function replayTaskSpec(picked, { revisionId, base, jobBudget }) {
  const { task, kind } = picked;
  const title = String(task.title ?? '').replace(/^\s*\[[a-z0-9-]+\]\s*/, '').trim();
  return {
    proposal: {
      channel: task.channel,
      title: `${REPLAY_TITLE_PREFIX} ${title}`,
      rationale: String(task.rationale ?? ''),
      touch: Array.isArray(task.touch) ? [...task.touch] : [],
      jobBudget,
    },
    replay: { of: String(revisionId), caseId: String(task.id), kind, base },
  };
}

/**
 * 解き直しを待っている改訂の、落ち着き方 (純粋)。tick が R のレビューを呼ぶかを決める。
 * 落ち着いた = 解き直しが全部 取り下げ (結果あり)・merge・止まった。期限 = 解き直しを立ててから `timeoutMs`
 *
 * @returns {Array<{revision: object, replays: object[], how: 'settled'|'timeout', unsettled: object[]}>}
 *   レビューを呼んでよい改訂だけ
 */
export function planReplaySettle(tasks, { now, timeoutMs }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const at = typeof now === 'number' ? now : msOf(now);
  const out = [];
  for (const revision of list) {
    if (revision?.state !== 'review' || revision.replay?.status !== 'running') continue;
    const replays = list.filter((t) => isReplayTask(t) && t.replay.of === String(revision.id));
    const unsettled = replays.filter((t) => !SETTLED_STATES.includes(t.state));
    if (unsettled.length === 0) {
      out.push({ revision, replays, how: 'settled', unsettled });
      continue;
    }
    const started = msOf(revision.replay.startedAt);
    if (started !== null && Number.isFinite(at) && at - started >= timeoutMs) {
      out.push({ revision, replays, how: 'timeout', unsettled });
    }
  }
  return out;
}

const OUTCOME_LABELS = Object.freeze({
  submitted: '完了を報告',
  'verify-ng': 'verify NG のまま報告',
  blocked: '止まった (要人間)',
  timeout: '期限切れ (終わらなかった)',
  manual: '取りやめ (/review で待つのをやめた)',
  unknown: '結果不明',
});

/**
 * 解き直しの結果 1 件 (純粋)。元のタスクの差し戻しの理由と並べ、レビュー担当が再発を読む材料にする。
 * 差分は `git diff <基点>..<ブランチ>` で読む (取り下げてもブランチは残る)
 */
export function replayLine(replay, caseTask, { evidenceChars = 200, reasonChars = REASON_CHARS } = {}) {
  const r = replay.replay ?? {};
  const outcome = r.outcome ?? (replay.state === 'blocked' ? { result: 'blocked' } : { result: 'unknown' });
  const label = OUTCOME_LABELS[outcome.result] ?? outcome.result;
  const kind = r.kind === 'canary' ? 'カナリア' : '差し戻しの再現';
  const where = `基点 ${short(r.base)}${replay.branch ? `・\`git diff ${short(r.base)}..${replay.branch}\`` : ''}`;
  const lines = [`- #${replay.id} ← ${kind} #${r.caseId} (${where}): ${label}`];
  if (outcome.evidence) lines.push(`  証拠: ${oneLine(String(outcome.evidence).split('\n')[0], evidenceChars)}`);
  if (r.kind !== 'canary') {
    const reason = sendBacks(caseTask)[0]?.note ?? '';
    lines.push(`  元の差し戻しの理由: ${reason ? oneLine(reason, reasonChars) : '(note なし)'}`);
  }
  return lines.join('\n');
}

/**
 * レビュー依頼に載せる解き直しの節の上限。落ちた検証 (1200)・レビューの証拠 (1200)・承認時の備考 (2500) と
 * 合わせてレビュー契約の本文 (6000) に収まる長さ — 超えると契約が作れず、改訂がレビューへ進めない
 */
export const MAX_REPLAY_SUMMARY_CHARS = 1000;

/**
 * R のレビュー依頼に載せる節 (純粋)。解き直しが無ければ、無かった理由の 1 行。
 * 長いときは証拠と理由を詰め、それでも入らなければ後ろの解き直しを「…ほか n 件」に畳む (黙って切らない)
 */
export function formatReplaySummary(revision, tasks, { maxChars = MAX_REPLAY_SUMMARY_CHARS } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const r = revision?.replay ?? null;
  if (!r) return null;
  if (r.status === 'none') return oneLine(`下書きの検証: 解き直していません — ${r.reason ?? '対象が無い'}`, maxChars);
  const replays = list.filter((t) => isReplayTask(t) && t.replay.of === String(revision.id))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const head = '下書きの検証 (この改訂の作業ツリーの役割文で過去のタスクを解き直した結果 — 判定ではなく材料。'
    + '差し戻しの再現は元の理由と同じ失敗が出ていないか、カナリアは前に通ったものを壊していないかを差分で読む):';
  // 解き直しを閉じた後に出し直された提出 (差し戻し → 直して再提出) は、結果が前の下書きのもの
  const lastSubmit = (Array.isArray(revision.history) ? revision.history : [])
    .filter((h) => h?.from === 'in-progress' && h.to === 'review').map((h) => msOf(h.at)).filter((ms) => ms !== null).at(-1) ?? null;
  const done = msOf(r.doneAt);
  const tail = [
    ...(r.how === 'timeout' ? ['(期限が来たので、終わっていない解き直しを取り下げてレビューを呼んだ)'] : []),
    ...(done !== null && lastSubmit !== null && lastSubmit > done
      ? ['(この結果は前の提出の下書きで解き直したもの — その後の変更は解き直していない)'] : []),
  ];
  const caseOf = (replay) => list.find((t) => String(t.id) === replay.replay.caseId);
  const build = (shown, opts) => {
    const rest = replays.length - shown;
    return [
      head,
      ...replays.slice(0, shown).map((replay) => replayLine(replay, caseOf(replay), opts)),
      ...(rest > 0 ? [`…ほか ${rest} 件 (\`git branch --list 'task/*'\` の解き直しのブランチで読む)`] : []),
      ...tail,
    ].join('\n');
  };
  for (const opts of [{}, { evidenceChars: 100, reasonChars: 120 }]) {
    const text = build(replays.length, opts);
    if (text.length <= maxChars) return text;
  }
  for (let shown = replays.length - 1; shown >= 0; shown -= 1) {
    const text = build(shown, { evidenceChars: 100, reasonChars: 120 });
    if (text.length <= maxChars) return text;
  }
  return build(0, {}).slice(0, maxChars);
}
