// ブリッジ全体の上限 (`limits.*`) — bot 間ホップ、会話の文字数予算、ツール承認カード、添付。

import { DEFAULT_LIMITS } from './attachments.js';
import { inRange, isPlainObject } from './config-util.js';
import { DEFAULT_MAX_BOT_HOPS } from './hops.js';

/**
 * bot 間の連続ホップ上限。未設定は既定 (hops.js)。
 * 0 は「bot 起点では一切起動しない」という有効な設定なので許す。
 */
export function resolveMaxBotHops(config = {}) {
  const v = config?.limits?.maxBotHops;
  return Number.isSafeInteger(v) && v >= 0 ? v : DEFAULT_MAX_BOT_HOPS;
}

/**
 * 連続**自己**呼び出しの上限。
 *
 * **未設定なら maxBotHops と同じ** = 別枠では絞らない。自己呼び出しも bot ホップを
 * 消費するので、書かなければ全体の枠 (既定 12) で止まる。先回りして小さい既定を
 * 置かないのは「最初から絞るより、暴走したら必要なところだけ絞る」方針のため
 * (作者裁定 2026-08-21)。0 は「自己呼び出しを一切許さない」= 機能ごと切る口。
 */
export function resolveMaxSelfHops(config = {}) {
  const v = config?.limits?.maxSelfHops;
  return Number.isSafeInteger(v) && v >= 0 ? v : resolveMaxBotHops(config);
}

/**
 * 文脈に載せる遡り分の文字数上限 (既定 80000)。
 *
 * これは日常的に効かせる値ではなく暴発防止の安全弁 — Discord の 1 発言は最大 2000 字で、
 * transcriptFetchLimit 件並べば十数万字になる。効くのは履歴を再構築する経路の遡り分だけで、
 * 既読カーソルの差分とトリガー以降は対象外 (落とすと恒久欠落する — src/transcript.js)。
 */
export const DEFAULT_TRANSCRIPT_CHAR_BUDGET = 80000;
/** 下限は Discord の 1 発言上限 (2000 字) — これを下回ると 1 件も載らない設定になる */
export const TRANSCRIPT_CHAR_BUDGET_RANGE = [2000, 10 * 1000 * 1000];

export function resolveTranscriptCharBudget(config = {}) {
  const v = config?.limits?.transcriptCharBudget;
  return inRange(v, TRANSCRIPT_CHAR_BUDGET_RANGE) ? v : DEFAULT_TRANSCRIPT_CHAR_BUDGET;
}

/** ツール権限の承認カードが有効な時間 (既定 30 分) */
export const DEFAULT_TOOL_APPROVAL_TTL_MS = 30 * 60 * 1000;
/**
 * hook 経路の承認で **job を止めて待てる上限** (既定 3 分)。カードの寿命
 * (toolApprovalTtlMs) とは別の値で、こちらは「作業ツリーのレーンが塞がる時間」。
 * 待っている間、同じ cwd の他チャンネルの job はすべて止まる。
 */
export const DEFAULT_TOOL_APPROVAL_WAIT_MS = 3 * 60 * 1000;
/** 1 job で出す承認カードの上限 (既定 3 件) */
export const DEFAULT_MAX_TOOL_APPROVAL_CARDS = 3;

/**
 * 承認まわりの上下限。「正の整数」だけでは受入条件 (短い期限・少ないカード) を満たせない
 * — MAX_SAFE_INTEGER を書けば実質無期限・無制限になる (sol 指摘 2026-07-31)。
 * 期限は 1 分〜24 時間、カードは 1〜10 件に収める。
 */
export const TOOL_APPROVAL_TTL_RANGE_MS = [60 * 1000, 24 * 60 * 60 * 1000];
export const MAX_TOOL_APPROVAL_CARDS_RANGE = [1, 10];
/**
 * 待機上限は 30 秒〜10 分。上を絞るのは、待っている間ずっと同じ作業ツリーの
 * 他チャンネルが止まるため — 「押し忘れて 1 時間レーンが死ぬ」を設定で作れないようにする。
 */
export const TOOL_APPROVAL_WAIT_RANGE_MS = [30 * 1000, 10 * 60 * 1000];

/**
 * 承認カードの寿命。範囲外は既定へ落とす
 * (書き損じそのものは validateConfig が起動時に落とすので、ここは保険)。
 */
export function resolveToolApprovalTtlMs(config = {}) {
  const v = config?.limits?.toolApprovalTtlMs;
  return inRange(v, TOOL_APPROVAL_TTL_RANGE_MS) ? v : DEFAULT_TOOL_APPROVAL_TTL_MS;
}

/** hook 経路で job を止めて待てる上限 (範囲外は既定へ落とす) */
export function resolveToolApprovalWaitMs(config = {}) {
  const v = config?.limits?.toolApprovalWaitMs;
  return inRange(v, TOOL_APPROVAL_WAIT_RANGE_MS) ? v : DEFAULT_TOOL_APPROVAL_WAIT_MS;
}

/** 1 job あたりの承認カード上限 */
export function resolveMaxToolApprovalCards(config = {}) {
  const v = config?.limits?.maxToolApprovalCards;
  return inRange(v, MAX_TOOL_APPROVAL_CARDS_RANGE) ? v : DEFAULT_MAX_TOOL_APPROVAL_CARDS;
}

/**
 * limits.attachments で書けるキー。未知キーは黙って無視せずエラーにする —
 * タイプミスが「設定したつもりの上限が効いていない」に化けるのを防ぐ。
 */
export const ATTACHMENT_LIMIT_KEYS = [
  'maxImagesPerJob',
  'maxBytesPerImage',
  'maxBytesTotal',
  'fetchTimeoutMs',
  // テキスト添付は画像と別枠。バイト上限は取得の可否を、文字数上限はプロンプトへ
  // 載せる量を切る (超過分は truncate されるので、拒否とは意味が違う)
  'maxTextFilesPerJob',
  'maxBytesPerTextFile',
  'maxTextBytesTotal',
  'maxTextCharsPerFile',
  'maxTextCharsTotal',
];

/**
 * 「合計 < 単体」だとどの添付も通らない設定になる組み合わせ。
 * [合計側のキー, 単体側のキー] で並べる。
 */
const ATTACHMENT_TOTAL_PAIRS = [
  ['maxBytesTotal', 'maxBytesPerImage'],
  ['maxTextBytesTotal', 'maxBytesPerTextFile'],
  ['maxTextCharsTotal', 'maxTextCharsPerFile'],
];

/**
 * 添付上限の不変条件。
 * 0・負値・小数・非数を弾き、合計上限が単体上限を下回る (どの画像も通らない)
 * 組み合わせも拒否する。既定値は attachments.js 側の DEFAULT_LIMITS。
 */
export function validateAttachmentLimits(attachments) {
  if (attachments === undefined) return [];
  if (!isPlainObject(attachments)) return ['limits.attachments はオブジェクトで書く'];

  const errors = [];
  for (const key of Object.keys(attachments)) {
    if (!ATTACHMENT_LIMIT_KEYS.includes(key)) {
      errors.push(`limits.attachments.${key} は不明なキー (使えるのは ${ATTACHMENT_LIMIT_KEYS.join(' / ')})`);
    }
  }
  for (const key of ATTACHMENT_LIMIT_KEYS) {
    if (!Object.hasOwn(attachments, key)) continue;
    const value = attachments[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(
        `limits.attachments.${key} は正の整数で書く (受け取った値: ${JSON.stringify(value)})`,
      );
    }
  }
  // 不変条件は「既定値とマージした実効値」で見る。片側だけ書いた設定は
  // それ単体では妥当に見えても、省略した側に既定値が入った結果で破れる
  // (例: maxBytesTotal だけ 1KB にすると既定 10MB の単体上限を下回る)
  const effective = (key) =>
    (Number.isSafeInteger(attachments[key]) && attachments[key] > 0
      ? attachments[key]
      : DEFAULT_LIMITS[key]);
  for (const [totalKey, perKey] of ATTACHMENT_TOTAL_PAIRS) {
    const total = effective(totalKey);
    const per = effective(perKey);
    if (total < per) {
      errors.push(
        `limits.attachments の実効値が ${totalKey} (${total}) < ${perKey} (${per}) ` +
          '— 省略した側には既定値が入るので、両方の兼ね合いで書く',
      );
    }
  }
  return errors;
}

/**
 * `limits.*` の起動時検証。実効値同士の兼ね合い (待機上限 < カードの寿命) も見るので、
 * `limits` 単体ではなく config を受ける。
 *
 * @returns {string[]} 人間向けエラー行
 */
export function validateLimits(config = {}) {
  const errors = [];
  // 上限の書き損じを黙って既定へ落とすと「12 のつもりが 12 でない」に化ける
  const hops = config.limits?.maxBotHops;
  if (hops !== undefined && !(Number.isSafeInteger(hops) && hops >= 0)) {
    errors.push(
      `limits.maxBotHops は 0 以上の整数で書く (受け取った値: ${JSON.stringify(hops)}／` +
        `省略時は ${DEFAULT_MAX_BOT_HOPS}・0 は bot 起点の起動を止める)`,
    );
  }

  const selfHops = config.limits?.maxSelfHops;
  if (selfHops !== undefined && !(Number.isSafeInteger(selfHops) && selfHops >= 0)) {
    errors.push(
      `limits.maxSelfHops は 0 以上の整数で書く (受け取った値: ${JSON.stringify(selfHops)}／` +
        '省略時は maxBotHops と同じ・0 は自己呼び出しを止める)',
    );
  }

  // 承認まわりの上下限。「正の整数」だけ見ると MAX_SAFE_INTEGER で実質無期限・無制限に
  // できてしまい、「短い期限・少ないカード」という前提が崩れる
  const ttl = config.limits?.toolApprovalTtlMs;
  if (ttl !== undefined && !inRange(ttl, TOOL_APPROVAL_TTL_RANGE_MS)) {
    errors.push(
      `limits.toolApprovalTtlMs は ${TOOL_APPROVAL_TTL_RANGE_MS[0]}〜${TOOL_APPROVAL_TTL_RANGE_MS[1]} ` +
        `(1 分〜24 時間) のミリ秒で書く (受け取った値: ${JSON.stringify(ttl)}／` +
        `省略時は ${DEFAULT_TOOL_APPROVAL_TTL_MS})`,
    );
  }
  // 待機上限も同じ理由で上下限を持つ。長くすると同じ作業ツリーの他チャンネルが
  // その間ずっと止まるので、上限は控えめに固定する
  const wait = config.limits?.toolApprovalWaitMs;
  if (wait !== undefined && !inRange(wait, TOOL_APPROVAL_WAIT_RANGE_MS)) {
    errors.push(
      `limits.toolApprovalWaitMs は ${TOOL_APPROVAL_WAIT_RANGE_MS[0]}〜${TOOL_APPROVAL_WAIT_RANGE_MS[1]} ` +
        `(30 秒〜10 分) のミリ秒で書く (受け取った値: ${JSON.stringify(wait)}／` +
        `省略時は ${DEFAULT_TOOL_APPROVAL_WAIT_MS}・承認待ちの間は同じ cwd の job が止まる)`,
    );
  }
  const cards = config.limits?.maxToolApprovalCards;
  if (cards !== undefined && !inRange(cards, MAX_TOOL_APPROVAL_CARDS_RANGE)) {
    errors.push(
      `limits.maxToolApprovalCards は ${MAX_TOOL_APPROVAL_CARDS_RANGE[0]}〜${MAX_TOOL_APPROVAL_CARDS_RANGE[1]} ` +
        `の整数で書く (受け取った値: ${JSON.stringify(cards)}／省略時は ${DEFAULT_MAX_TOOL_APPROVAL_CARDS})`,
    );
  }

  // 小さすぎる値を黙って既定へ落とすと「絞ったつもりが効いていない」に化ける。
  // 逆に極端に大きい値は安全弁として無意味なので、上下限で受け止める
  // **実効値同士**で見る。片方だけ書いた設定はそれ単体では妥当でも、省略側に既定値が
  // 入った結果で破れる。待機上限がカードの寿命以上だと、押せる時間より長く job が
  // 止まったままになる (期限切れのカードを押しても何も許可されない — sol 指摘 2026-08-02)
  const effectiveWait = resolveToolApprovalWaitMs(config);
  const effectiveTtl = resolveToolApprovalTtlMs(config);
  if (effectiveWait >= effectiveTtl) {
    errors.push(
      `limits.toolApprovalWaitMs (実効値 ${effectiveWait}) は ` +
        `limits.toolApprovalTtlMs (実効値 ${effectiveTtl}) より短く書く ` +
        '— カードの期限が待機上限より先に来ると、押せなくなった後も job が止まり続ける',
    );
  }

  const budget = config.limits?.transcriptCharBudget;
  if (budget !== undefined && !inRange(budget, TRANSCRIPT_CHAR_BUDGET_RANGE)) {
    errors.push(
      `limits.transcriptCharBudget は ${TRANSCRIPT_CHAR_BUDGET_RANGE[0]}〜${TRANSCRIPT_CHAR_BUDGET_RANGE[1]} ` +
        `の整数で書く (受け取った値: ${JSON.stringify(budget)}／省略時は ${DEFAULT_TRANSCRIPT_CHAR_BUDGET})`,
    );
  }

  errors.push(...validateAttachmentLimits(config.limits?.attachments));
  return errors;
}
