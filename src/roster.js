// @ts-check
// スレッドごとの編成 (そのスレッドで呼んでよい bot) の allowlist。
//
// これまで「今回は Sol を使わない」は作者がスレッドで言うだけの規律で、
// 実行文脈には起動中の bot が全員「呼べる相手」として並んでいた。役割文には
// 「作者の指定が優先」と書いてあるが、破っても何も起きない (sol 指摘 2026-08-01)。
//
// 締めるときは**生成側 (実行文脈) と解決側 (handoff の宛先) の両方**へ同じ allowlist を
// 通す。片方だけだと「文脈に出ないのに呼べる」「呼べないのに文脈には出る」のどちらかになり、
// どちらもモデルから見ると理由の分からない不発になる。
//
// 未設定のスレッドは制限なし — 既定を「全員呼べる」に置くのは、設定を忘れたスレッドで
// 突然 handoff が落ちる方が事故が大きいため。禁止は明示的に設定したときだけ効く。
//
// ただしこの既定が逆に働くチャンネルがある (呼ばれて困る相手がいる場所では、打ち忘れが
// そのまま事故になる)。その初期値が config.json の channels.<name>.roster で、
// スレッド編成はそれを**上書きする**関係にある (resolveEffectiveRoster)。

import { JsonStore } from './store.js';

/** 編成を解除する (= 全員呼べるに戻す) 指定 */
const CLEAR_WORDS = ['all', 'any', 'clear', 'reset', '解除', '全員'];
/** 誰も呼べない (単独で完結させる) 指定 */
const SOLO_WORDS = ['none', 'solo', 'なし', '単独'];

/**
 * `/roster members:` の入力を bot キーの一覧へ。
 *
 * 未知のキーが 1 つでもあれば**部分適用せず**拒否する。半分だけ効いた編成は
 * 「指定したのに呼べる」に化けるので、全部通るか何も変えないかのどちらかにする。
 *
 * @param {string} input
 * @param {string[]} knownKeys config.bots のキー
 * @returns {{ok: true, keys: string[]|null} | {ok: false, reason: string}}
 *   keys: null = 編成を解除 / [] = 誰も呼べない / [...] = その面子だけ
 */
export function parseRosterMembers(input, knownKeys = []) {
  const raw = String(input ?? '').trim();
  if (raw === '' || CLEAR_WORDS.includes(raw.toLowerCase())) return { ok: true, keys: null };
  if (SOLO_WORDS.includes(raw.toLowerCase())) return { ok: true, keys: [] };

  const known = new Map(knownKeys.map((k) => [String(k).toLowerCase(), k]));
  const keys = [];
  const unknown = [];
  for (const token of raw.split(/[\s,、/／]+/).filter(Boolean)) {
    const hit = known.get(token.replace(/^@/, '').toLowerCase());
    if (!hit) unknown.push(token);
    else if (!keys.includes(hit)) keys.push(hit);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `知らない bot キーです: ${unknown.join(' / ')}`
        + `${knownKeys.length ? ` (使えるのは ${knownKeys.join(' / ')})` : ''}`,
    };
  }
  if (keys.length === 0) {
    return { ok: false, reason: '編成に入れる bot を 1 つ以上指定してください (誰も呼ばないなら none)' };
  }
  return { ok: true, keys };
}

/**
 * この job で効く編成を決める。スレッド編成 (`/roster`) が明示されていればそれ、
 * 無ければチャンネル既定 (`channels.<name>.roster`)、どちらも無ければ制限なし。
 *
 * スレッドを先に見るのは `/roster` が「このスレッドだけ変える」ための道具だから。
 * だから `/roster all` はスレッド側の指定を**消す**だけで、チャンネル既定へ戻る
 * (編成そのものの無効化ではない — 無効にしたいなら config を変える)。
 *
 * 空配列は「誰も呼べない」という**有効な編成**なので、`??` ではなく isArray で見る。
 *
 * @param {string[]|null} threadRoster RosterStore.get の戻り
 * @param {string[]|null} channelRoster resolveChannelRoster の戻り
 * @returns {{keys: string[]|null, source: 'thread'|'channel'|null}}
 */
export function resolveEffectiveRoster(threadRoster = null, channelRoster = null) {
  if (Array.isArray(threadRoster)) return { keys: threadRoster, source: 'thread' };
  if (Array.isArray(channelRoster)) return { keys: channelRoster, source: 'channel' };
  return { keys: null, source: null };
}

/**
 * bot 一覧へ「このスレッドの編成に入っているか」を付ける。
 * allowed が配列でなければ (= 未設定) 全員 true。
 *
 * @param {Array<{key: string}>} entries
 * @param {string[]|null} allowed
 */
export function applyRoster(entries = [], allowed = null) {
  if (!Array.isArray(allowed)) return entries.map((e) => ({ ...e, inRoster: true }));
  const set = new Set(allowed.map((k) => String(k).toLowerCase()));
  return entries.map((e) => ({ ...e, inRoster: set.has(String(e.key).toLowerCase()) }));
}

/**
 * 編成を人間向けの 1 行に。
 *
 * 出典を併記するのは、チャンネル既定が効いているスレッドで「未設定」とだけ返すと
 * **嘘になる**ため。`/roster` を打っていないのに絞られている理由がここにしか出ない。
 *
 * @param {string[]|null} allowed
 * @param {Array<{key: string, displayName?: string}>} entries 表示名の引き当て用
 * @param {'thread'|'channel'|null} [source] 効いている編成の出所 (resolveEffectiveRoster)
 */
export function formatRoster(allowed, entries = [], source = null) {
  if (!Array.isArray(allowed)) return '未設定 — 起動している bot はすべて呼べます';
  const from = source === 'channel' ? ' (チャンネル既定)' : '';
  if (allowed.length === 0) return `誰も呼べません (handoff 禁止・作者へ返す)${from}`;
  const name = (key) => entries.find((e) => e?.key === key)?.displayName ?? key;
  return `${allowed.map((k) => `${name(k)} (\`${k}\`)`).join(' / ')}${from}`;
}

/** threadId → 編成 を JSON で永続化する薄い KV。 */
export class RosterStore extends JsonStore {
  /** @returns {string[]|null} 未設定なら null */
  get(threadId) {
    const entry = this.data[String(threadId)];
    return Array.isArray(entry?.keys) ? entry.keys : null;
  }

  // set / clear は JsonStore.commit を通す。保存に失敗したときにメモリだけ新しい編成に
  // なっていると、「変えていません」と返した直後の job がその編成で走る (sol 指摘 2026-08-01)

  set(threadId, keys, meta = {}) {
    this.commit({ ...this.data, [String(threadId)]: { keys: [...keys], ...meta } });
  }

  /** @returns {boolean} 消すものがあったか */
  clear(threadId) {
    const id = String(threadId);
    if (!(id in this.data)) return false;
    const next = { ...this.data };
    delete next[id];
    this.commit(next);
    return true;
  }
}
