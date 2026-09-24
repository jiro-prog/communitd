// 組織提案の裁定 UI と、bot の構造化裁定。
//
// 裁定権は class で分かれる。
//   org               … 作者 (CEO) だけ。Discord interaction で検証した owner が押す
//   work / process    … 経営裁量の bot が構造化出力で裁定する。誰が持つかは
//                       `initiative.execBotKeys` だけが決める — **コード既定は無く、
//                       空なら誰も裁定できない** (src/config.js の resolveExecBotKeys)。
//                       bot はボタンを押せないので UI 経路は持たない
//
// **既存のツール権限 approval とは何も共有しない**。あちらは TTL 30 分の
// in-memory で、再起動で失効するのが正しい短命な承認。こちらは数日待つ裁定で、
// 正本は ProposalStore の永続レコード。custom ID から**永続 proposal ID を直接引く**。
//
// カードは**出した時点の digest に束縛する**。押した瞬間に現在の digest と照合し、
// 食い違えば裁定させずに最新版を出し直す — でないと、カードを出した後に内容が
// 差し替わったとき、押す人は読んでいない内容を承認できてしまう
// (grants.js が承認カードの nonce を grant の指紋へ束縛しているのと同じ動機)。

import { formatJst } from './time.js';

/** ボタンの customId 接頭辞。ツール権限の `toolperm` とは別系統 */
export const PROPOSAL_PREFIX = 'proposal';

/** カードから起こせる裁定 */
export const PROPOSAL_ACTIONS = ['accept', 'reject'];

/** 理由モーダルの入力欄 ID */
export const RATIONALE_FIELD = 'rationale';

/** 理由の上限 (Discord の入力欄と ProposalStore の記録に同じ値を使う) */
export const MAX_RATIONALE_CHARS = 1000;

// Discord のコンポーネント種別と色 (純粋モジュールに discord.js を持ち込まない)
const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const COMPONENT_TEXT_INPUT = 4;
const BUTTON_SUCCESS = 3;
const BUTTON_DANGER = 4;
const TEXT_INPUT_PARAGRAPH = 2;

const decisionOf = (action) => (action === 'accept' ? 'accepted' : 'rejected');

/** `proposal:accept:<id>:<digest>` — Discord の customId は 100 字まで */
export function buildProposalCustomId(action, id, digest) {
  return `${PROPOSAL_PREFIX}:${action}:${id}:${digest}`;
}

/** customId を解釈する。自分のものでなければ null (他のボタンを横取りしない) */
export function parseProposalCustomId(customId) {
  const parts = String(customId ?? '').split(':');
  if (parts.length !== 4) return null;
  const [prefix, action, id, digest] = parts;
  if (prefix !== PROPOSAL_PREFIX) return null;
  if (!PROPOSAL_ACTIONS.includes(action)) return null;
  if (!id || !digest) return null;
  return { action, id, digest, decision: decisionOf(action) };
}

/**
 * カードが今もその提案を指しているか。**押下時と理由の送信時の両方で通す。**
 *
 * @param {object|null} proposal 現在の提案 (無ければ null)
 * @param {{digest: string, currentDigest: string|null}} card カードに焼いた digest と現在値
 * @returns {{ok: true} | {ok: false, stage: 'gone'|'stale', reason: string}}
 */
export function checkProposalBinding(proposal, { digest, currentDigest }) {
  if (!proposal) {
    return { ok: false, stage: 'gone', reason: 'この提案は見つかりません (記録が入れ替わったか、消えています)' };
  }
  if (proposal.class !== 'org') {
    return {
      ok: false,
      stage: 'gone',
      reason: `提案 ${proposal.id} は ${proposal.class} なので、このカードでは裁定しません`,
    };
  }
  if (proposal.state !== 'deliberating') {
    return {
      ok: false,
      stage: 'gone',
      reason: `提案 ${proposal.id} は ${proposal.state} なので裁定待ちではありません`,
    };
  }
  if (!currentDigest || currentDigest !== digest) {
    return {
      ok: false,
      stage: 'stale',
      reason: '提案の内容がカードを出したときから変わっています。読んでいない内容を承認しないよう、裁定せずに最新版を出し直します',
    };
  }
  return { ok: true };
}

/**
 * 裁定カードの本文とボタン。
 *
 * @param {object} proposal ProposalStore のレコード
 * @param {{digest: string, stage?: 'request'|'accepted'|'rejected'|'gone'|'stale',
 *          ownerMention?: string|null, note?: string, escape?: (s: string) => string}} view
 * @returns {{content: string, components: Array<object>}}
 */
export function buildProposalCard(proposal = {}, {
  digest = '', stage = 'request', ownerMention = null, note = '', escape = (s) => s,
} = {}) {
  const head = {
    request: '🏛 組織提案の裁定 (CEO 専決)',
    accepted: '✅ 採択しました',
    rejected: '🚫 却下しました',
    gone: '⚠️ このカードは使えません',
    stale: '♻️ 内容が変わったので出し直しました',
  }[stage] ?? '🏛 組織提案の裁定 (CEO 専決)';

  if (stage === 'gone') {
    return { content: `**${head}**\n${escape(note || '裁定待ちではなくなっています。')}`, components: [] };
  }

  const input = proposal.input ?? {};
  const lines = [`**${head}** — 提案 #${escape(String(proposal.id ?? '?'))}`];
  if (stage === 'request' && ownerMention) lines.push(ownerMention);
  lines.push(
    `種別: \`${escape(String(input.kind ?? '(不明)'))}\` / 対象: ${formatKeys(proposal.subjectKeys, escape)}`,
    `発議: ${escape(String(proposal.raisedBy ?? '(不明)'))}`
    + ` / 追跡担当: ${escape(String(proposal.ownerBotKey ?? '(不明)'))}`,
    `要旨: ${escape(truncate(String(input.summary ?? ''), 300))}`,
  );
  if (input.remedy || input.cost) {
    lines.push(`直し先: ${escape(String(input.remedy ?? '(不明)'))} / 費用: ${escape(truncate(String(input.cost ?? '(不明)'), 80))}`);
  }
  const touch = Array.isArray(input.change?.touch) ? input.change.touch : [];
  if (touch.length > 0) {
    lines.push(`変更: ${touch.map((p) => `\`${escape(p)}\``).join(' ')}`);
  }
  if (input.trial?.deadline) {
    lines.push(`試用期限: ${escape(formatJst(input.trial.deadline) ?? String(input.trial.deadline))}`);
  }
  const positions = Array.isArray(proposal.positions) ? proposal.positions : [];
  if (positions.length > 0) {
    const second = positions.filter((p) => p?.stance === 'second').length;
    const contest = positions.filter((p) => p?.stance === 'contest').length;
    lines.push(`意見: 賛同 ${second} / 反論 ${contest}`);
  }
  if (note) lines.push(escape(note));
  if (stage === 'request') {
    lines.push('**採択は押した時点で確定**します。却下は理由の入力欄が出ます (理由は必須)。');
  }
  if (stage === 'accepted' || stage === 'rejected') {
    const by = proposal.adjudication?.by;
    if (by) lines.push(`裁定: ${escape(String(by))}`);
    const rationale = proposal.adjudication?.rationale;
    if (rationale) lines.push(`理由: ${escape(truncate(String(rationale), 400))}`);
  }

  return {
    content: lines.join('\n').slice(0, 1900),
    // 決着済み・出し直し済みのカードからはボタンを外す (再押下の余地を残さない)
    components: stage === 'request' ? [buttons(proposal.id, digest)] : [],
  };
}

function buttons(id, digest) {
  return {
    type: COMPONENT_ACTION_ROW,
    components: [
      button('採択する', BUTTON_SUCCESS, buildProposalCustomId('accept', id, digest)),
      button('却下する', BUTTON_DANGER, buildProposalCustomId('reject', id, digest)),
    ],
  };
}

function button(label, style, customId) {
  return { type: COMPONENT_BUTTON, style, label, custom_id: customId };
}

/**
 * 理由の入力モーダル。**却下の経路だけが通る** (作者裁定 2026-08-30 — 採択は
 * ボタンを押した時点で確定する)。却下は終端なので、理由が残らないと同じ提案が
 * 再発議されて同じ議論を繰り返す。
 *
 * これ自体が確認画面を兼ねる — 別に「本当によいですか」を挟まなくても、
 * 送信するまで裁定は確定しないし、送信を止めれば何も起きない。
 */
export function buildRationaleModal(action, id, digest) {
  return {
    custom_id: buildProposalCustomId(action, id, digest),
    title: `提案 #${id} を${action === 'accept' ? '採択' : '却下'}`.slice(0, 45),
    components: [{
      type: COMPONENT_ACTION_ROW,
      components: [{
        type: COMPONENT_TEXT_INPUT,
        custom_id: RATIONALE_FIELD,
        label: '理由 (記録に残ります)',
        style: TEXT_INPUT_PARAGRAPH,
        required: true,
        min_length: 1,
        max_length: MAX_RATIONALE_CHARS,
      }],
    }],
  };
}

/**
 * `/proposals` の一覧。**裁定待ちを先に、その次に走っているもの**を出す。
 * 一覧に出ないと、スクロールで流れたカードを追う手段が無くなる。
 */
export function formatProposalQueue(proposals = [], { escape = (s) => s, limit = 10 } = {}) {
  const awaiting = proposals.filter((p) => p?.state === 'deliberating');
  const others = proposals.filter((p) => p?.state !== 'deliberating');
  if (awaiting.length === 0 && others.length === 0) return '提案はありません。';

  const lines = [];
  if (awaiting.length > 0) {
    lines.push(`**裁定待ち (${awaiting.length} 件)**`);
    for (const p of awaiting.slice(0, limit)) lines.push(`・${describe(p, escape)}`);
    if (awaiting.length > limit) lines.push(`  … ほか ${awaiting.length - limit} 件`);
  }
  if (others.length > 0) {
    lines.push(`**進行中 (${others.length} 件)**`);
    for (const p of others.slice(0, limit)) lines.push(`・${describe(p, escape)}`);
    if (others.length > limit) lines.push(`  … ほか ${others.length - limit} 件`);
  }
  return lines.join('\n').slice(0, 1900);
}

function describe(proposal, escape) {
  const kind = proposal?.input?.kind ?? '(不明)';
  const summary = truncate(String(proposal?.input?.summary ?? ''), 60);
  return `#${escape(String(proposal?.id ?? '?'))} [${escape(String(proposal?.class ?? '?'))}]`
    + ` \`${escape(String(kind))}\` ${escape(summary)}`
    + ` (${escape(String(proposal?.state ?? '?'))} / 発議 ${escape(String(proposal?.raisedBy ?? '?'))})`;
}

/**
 * カードを出す先の候補 (前から順に試す)。
 * 発議元スレッドが archive されていたら親チャンネルへ落とす — 投稿できずに
 * 「裁定待ちのまま誰も気付かない」提案を作らないため。
 */
export function cardTargets(proposal, { fallbackChannelId = null } = {}) {
  const ids = [proposal?.origin?.threadId, proposal?.origin?.channelId, fallbackChannelId];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
}

/**
 * bot の構造化出力から work / process を裁定する。
 *
 * **org はここを通らない** — `canAdjudicate` が bot を弾くので、
 * 誤って org を書いてきた report は「裁定できません」で返る (ゲートは 1 本)。
 *
 * @param {{adjudication: object}} report 検証済みの report 契約
 * @param {{botKey: string, store: object, ctx: object, ownerUserId: string|null,
 *          execBotKeys: string[], baseCommit?: string|null, now?: number}} deps
 *   baseCommit は適用の基点。git を読むのは呼び出し側の仕事なので、
 *   ここは受け取って store へ渡すだけ
 * @returns {{ok: boolean, note: string, proposal?: object, notifyOwner?: boolean}}
 */
export function applyBotAdjudication(report, {
  botKey, store, ctx, ownerUserId = null, execBotKeys = [], baseCommit = null, now = Date.now(),
} = {}) {
  const entry = report?.adjudication;
  if (!entry) return { ok: false, note: '' };
  if (!store || !ctx) {
    return { ok: false, note: '⚠️ 提案の裁定は無効です (ProposalStore が配線されていません)' };
  }
  const id = String(entry.proposal_id ?? '');
  try {
    const proposal = store.adjudicate(id, {
      decision: entry.decision,
      rationale: entry.rationale,
      actor: { kind: 'bot', botKey },
      ctx,
      ownerUserId,
      execBotKeys,
      baseCommit,
      now,
    });
    const label = proposal.decision === 'accepted' ? '採択' : '却下';
    return {
      ok: true,
      proposal,
      // process の裁定は作者へ事後通知する (承認を求めるのではなく、決まったことを伝える)
      notifyOwner: proposal.class === 'process',
      note: `🏛 提案 #${proposal.id} (${proposal.class}) を${label}しました`,
    };
  } catch (err) {
    return { ok: false, note: `⚠️ 提案 #${id} を裁定できませんでした: ${err.message}` };
  }
}

/** process の裁定を作者へ伝える文面 (承認依頼ではないのでボタンは付けない) */
export function buildProcessNotice(proposal, { escape = (s) => s } = {}) {
  const label = proposal?.decision === 'accepted' ? '採択' : '却下';
  const lines = [
    `🏛 process 提案 #${escape(String(proposal?.id ?? '?'))} を${label}しました (経営裁量・事後通知)`,
    `種別: \`${escape(String(proposal?.input?.kind ?? '(不明)'))}\` / 対象: ${formatKeys(proposal?.subjectKeys, escape)}`,
    `要旨: ${escape(truncate(String(proposal?.input?.summary ?? ''), 300))}`,
    `裁定: ${escape(String(proposal?.adjudication?.by ?? '(不明)'))}`,
  ];
  const rationale = proposal?.adjudication?.rationale;
  if (rationale) lines.push(`理由: ${escape(truncate(String(rationale), 400))}`);
  return lines.join('\n').slice(0, 1900);
}

function formatKeys(keys, escape) {
  if (!Array.isArray(keys) || keys.length === 0) return '(不明)';
  return keys.map((k) => `\`${escape(String(k))}\``).join(' ');
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
