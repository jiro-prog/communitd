// ツール権限の承認要求台帳 (in-memory)。
//
// 「誰が・どこで・何を承認したのか」を取り違えないための束縛と、期限・冪等性を持つ。
// **意図的に永続しない** — 再起動をまたいだ承認要求は宙に浮くより無効になるべきで、
// 生き残った古いボタンを押しても「無効」と返るのが fail-closed の側。
// 待機 Promise (hook 経路) も同じ理由で永続しない — 再起動すれば claude 子プロセスごと
// 消えるので、待っている hook も一緒に捨てるのが筋。
//
// **hook 経路の申請 (`hook: true`) は job を止めて待っている。**
// 待機者を持ったまま申請を消す経路 (revoke / sweep / 期限切れ) が 1 つでもあると
// hook は永久に待ち、その job は二度と進まない。だから「申請を消す・決着させる」
// すべての口が settle() を通る形にしてある。

import { randomUUID } from 'node:crypto';
import { grantDigest, validateGrant } from './grants.js';

/** 承認カードの寿命 (既定 30 分) */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** ボタンの customId 接頭辞。Discord の customId は 100 字まで */
export const APPROVAL_PREFIX = 'toolperm';

/**
 * 押せるボタン。allow は「確認へ進む」で、恒久化を確定させるのは confirm だけ —
 * **ただし hook 経路 (job を止めて待っている申請) は allow 1 手で確定まで進む**
 * (作者裁定 2026-08-02: job が止まっている状況で 2 タップは重い)。
 */
export const ACTIONS = ['allow', 'confirm', 'deny'];

/**
 * 決着済みの申請をもう一度押したときの理由。
 * timeout (待機上限・期限切れ) は原因が 2 通りあるので、畳んだときの説明をそのまま出す。
 */
function resolvedReason(request) {
  const { action, note } = request?.resolved ?? {};
  if (action === 'confirm') return 'この申請はすでに承認済みです';
  if (action === 'timeout') return `この申請は無効です (${note ?? EXPIRE_NOTE})`;
  return 'この申請はすでに却下済みです';
}

/** 待機上限で畳んだときの既定の説明 */
const EXPIRE_NOTE = '承認待ちの上限に達しました';

/** customId を組み立てる (`toolperm:allow:<nonce>`) */
export function buildCustomId(action, nonce) {
  return `${APPROVAL_PREFIX}:${action}:${nonce}`;
}

/**
 * customId を解釈する。自分のものでなければ null
 * (他機能のボタンを取り込まないため、形が違えば黙って無視する)。
 */
export function parseCustomId(customId) {
  const parts = String(customId ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== APPROVAL_PREFIX) return null;
  const [, action, nonce] = parts;
  if (!ACTIONS.includes(action)) return null;
  if (!nonce) return null;
  return { action, nonce };
}

export class ApprovalRegistry {
  /**
   * @param {{ttlMs?: number, now?: () => number}} opts
   *        now を差せるようにしてあるのは期限のテストのため
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.requests = new Map(); // nonce → request
    // nonce → resolve 関数。hook 経路で job を止めて待っている側の解決口。
    // 申請そのものと分けて持つのは、request を JSON で表せる値だけに保つため
    this.waiters = new Map();
  }

  /**
   * 申請を登録して nonce を発行する。
   *
   * 文脈 (guild / channel / thread / bot / チャンネル設定 / canonical cwd / grant の指紋) を
   * 要求へ焼き付けるのが要点で、ボタン押下時にこれと突き合わせることで
   * 「別スレッドのカードを押して別の許可が通る」取り違えを防ぐ。
   * カードのメッセージ ID は投稿後に bindMessage() で足す。
   *
   * @returns {object|null} 妥当でない grant なら null (申請にしない)
   */
  register(req) {
    const checked = validateGrant(req?.grant);
    if (!checked.ok) return null;
    const nonce = randomUUID();
    const request = {
      ...req,
      // hook 経路 (job を止めて待っている) かどうか。カードの文面・ボタン・段数が変わる
      hook: req?.hook === true,
      grant: checked.grant,
      digest: grantDigest(checked.grant),
      nonce,
      messageId: null,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      pendingConfirm: null,
      resolved: null, // {action, userId, at}
    };
    this.requests.set(nonce, request);
    return request;
  }

  /**
   * カードを投稿できたら、そのメッセージ ID を申請へ束縛する。
   * **ID を取れなければ束縛しない** — 押されたカードを特定できない申請は
   * 承認できてはいけないので、呼び出し側はここで false を受けたら revoke する。
   * @returns {boolean} 束縛できたか
   */
  bindMessage(nonce, messageId) {
    const request = this.requests.get(nonce);
    if (!request) return false;
    if (typeof messageId !== 'string' || messageId === '') return false;
    request.messageId = messageId;
    return true;
  }

  /**
   * 申請を取り消す (カードを投稿できなかったとき)。
   * 押せないカードに対応する申請を台帳へ残さない。
   * **待機者へは deny を返す** — 消すだけだと hook が永久に待つ。
   */
  revoke(nonce) {
    this.settle(nonce, 'deny', '申請を取り消しました');
    return this.requests.delete(nonce);
  }

  get(nonce) {
    return this.requests.get(nonce) ?? null;
  }

  /**
   * hook 経路の申請が決着するまで待つ。**この間 job は止まっている。**
   * 待ち上限は呼び出し側 (承認ブローカ) が持ち、上限に達したら expire() が呼ばれる —
   * 期限を二重に持たない。
   *
   * @returns {Promise<{decision: 'allow'|'deny', reason: string}>}
   *          allow を返すのは commit() (= 保存が通った) からだけ
   */
  awaitDecision(nonce) {
    const request = this.requests.get(nonce);
    if (!request) return Promise.resolve(denied('この申請は無効です'));
    if (request.resolved) {
      return Promise.resolve(
        request.resolved.action === 'confirm'
          ? { decision: 'allow', reason: '承認済みです' }
          : denied(resolvedReason(request)),
      );
    }
    // 同じ申請を 2 か所から待つ形は作らない (どちらが解決されるかが不定になる)
    if (this.waiters.has(nonce)) return Promise.resolve(denied('この申請は既に待機中です'));
    return new Promise((resolveWait) => this.waiters.set(nonce, resolveWait));
  }

  /**
   * 待機者へ決着を渡す。**多重解決しない** (2 度目以降は false)。
   * 待機者が居なければ何もしない — hook 経路でない申請でも同じ口を通せるようにするため。
   */
  settle(nonce, decision, reason = '') {
    const resolveWait = this.waiters.get(nonce);
    if (!resolveWait) return false;
    this.waiters.delete(nonce);
    resolveWait(decision === 'allow' ? { decision: 'allow', reason } : denied(reason));
    return true;
  }

  /**
   * 承認待ちの上限に達した申請を無効にする。
   * **申請ごと無効にする**のが要点 — 待機だけ畳んで押せるカードを残すと、
   * job が進んだ後に押した人が「押したのに続行しない」を見ることになる。
   */
  expire(nonce, note = EXPIRE_NOTE) {
    const request = this.requests.get(nonce);
    if (request && !request.resolved) {
      // note は「なぜ無効になったか」— カードと再押下の説明にそのまま使う
      request.resolved = { action: 'timeout', userId: null, at: this.now(), note };
    }
    this.settle(nonce, 'deny', note);
    return request ?? null;
  }

  /**
   * 待機者をすべて deny で畳む (job の中断・ブリッジ停止)。
   * @returns {number} 畳んだ数
   */
  denyAll(reason = '中断されました') {
    let closed = 0;
    for (const nonce of [...this.waiters.keys()]) {
      if (this.settle(nonce, 'deny', reason)) closed++;
    }
    return closed;
  }

  /**
   * ボタン押下を判定する。判定だけを返し、保存も投稿もしない
   * (副作用は呼び出し側に置き、ここは判定に徹する)。
   *
   * 恒久化は 2 段階: `allow` で確認へ進み、`confirm` で確定する。
   * 誤タップ 1 回で恒久設定が入らないようにするためで、確定できるのは
   * **allow を押したのと同じ人**だけ。
   *
   * confirm が通っても台帳はまだ確定しない (`stage: 'pending-save'`)。
   * 呼び出し側が保存に成功してから commit() を呼ぶ — 保存に失敗した申請を
   * 「承認済み」にしてしまうと、ディスクには無い許可がメモリにだけ残る。
   *
   * @param {{nonce: string, action: 'allow'|'confirm'|'deny', userId: string, isBot?: boolean,
   *          guildId: string, channelId: string, messageId?: string|null, botKey?: string|null,
   *          isAuthorized: boolean}} press
   * @returns {{ok: true, request: object, action: string, stage: 'confirm'|'pending-save'|'denied'}
   *          |{ok: false, reason: string, request?: object}}
   */
  resolve(press = {}) {
    const request = this.requests.get(press.nonce);
    // 再起動・期限切れ掃除の後に古いボタンを押した場合はここに来る
    if (!request) {
      return { ok: false, reason: 'この申請は無効です (期限切れ、またはブリッジの再起動で失効しました)' };
    }
    if (request.resolved) {
      return { ok: false, request, reason: resolvedReason(request) };
    }
    if (this.now() > request.expiresAt) {
      // 期限切れのカードを押した = もう何も許可できない。**hook 経路は待っている側も畳む** —
      // 畳まないと、押した人には「期限切れ」と返しながら job は待ち上限まで止まり続ける
      // (sol 指摘 2026-08-02)。2 段階カードには待機者が居ないので従来どおり判定だけ返す
      if (request.hook) this.expire(press.nonce, 'カードの期限が切れました');
      return { ok: false, request, reason: 'この申請は期限切れです (何も許可していません)' };
    }
    // bot は Discord のボタンを押せないが、判定を人間かどうかに依存させない
    if (press.isBot) return { ok: false, request, reason: 'bot は承認できません' };
    if (!press.isAuthorized) return { ok: false, request, reason: 'このユーザーは承認できません' };
    // 申請が生まれた場所以外からの承認は受けない (カードの取り違え防止)
    if (press.guildId !== request.guildId || press.channelId !== request.channelId) {
      return { ok: false, request, reason: '申請が出されたチャンネル以外からは承認できません' };
    }
    // 押されたカードそのものかを見る。**片方でも欠けていたら通さない** —
    // 同じスレッドに複数のカードが並ぶので、特定できないまま承認してはいけない
    if (!request.messageId || !press.messageId || press.messageId !== request.messageId) {
      return { ok: false, request, reason: '押されたカードを特定できないため承認できません' };
    }
    // どの bot の申請かも照合する (別 bot 経由の interaction で通さない)
    if (!press.botKey || press.botKey !== request.botKey) {
      return { ok: false, request, reason: '申請を出した bot 以外からは承認できません' };
    }
    // 登録後に grant がすり替わっていないか (メモリ破壊・実装ミスの検出)
    if (grantDigest(request.grant) !== request.digest) {
      return { ok: false, request, reason: '申請の内容が変わっているため承認できません' };
    }

    if (press.action === 'deny') {
      request.resolved = { action: 'deny', userId: press.userId, at: this.now() };
      // 待っている hook を放置しない (押した本人にはカードで、job には deny で返る)
      this.settle(press.nonce, 'deny', '却下されました');
      return { ok: true, request, action: 'deny', stage: 'denied' };
    }

    if (press.action === 'allow') {
      request.pendingConfirm = { userId: press.userId, at: this.now() };
      // hook 経路は 1 タップで保存まで進む。job が止まって待っている状況で
      // 2 タップを挟むと、その間ずっと作業ディレクトリのレーンが塞がる
      return request.hook
        ? { ok: true, request, action: 'allow', stage: 'pending-save' }
        : { ok: true, request, action: 'allow', stage: 'confirm' };
    }

    // confirm — hook 経路のカードには確定ボタンが無い (1 タップで確定する)。
    // 組み立てた customId で叩かれても、経路を 1 本に保つため受けない
    if (request.hook) {
      return { ok: false, request, reason: 'この申請は「承認して続行」だけで決まります' };
    }
    // ここではまだ確定させない (保存が通ってから commit)
    if (!request.pendingConfirm) {
      return { ok: false, request, reason: '先に「承認」を押してください (恒久設定は 2 段階で確定します)' };
    }
    if (request.pendingConfirm.userId !== press.userId) {
      return { ok: false, request, reason: '承認を始めた人と同じ人が確定してください' };
    }
    return { ok: true, request, action: 'confirm', stage: 'pending-save' };
  }

  /**
   * 保存が通った申請を確定させる。**保存に成功した後にだけ呼ぶこと。**
   * 呼ばなければ申請は未確定のまま残り、もう一度「確定」を押せる。
   *
   * **待機者へ allow を返す唯一の口がここ。** ディスクに書けていない許可で
   * ツールを走らせないため、hook への allow は必ず保存の後ろに置く。
   * @returns {object|null} 確定した申請
   */
  commit(nonce, userId) {
    const request = this.requests.get(nonce);
    if (!request || request.resolved) return null;
    request.resolved = { action: 'confirm', userId, at: this.now() };
    this.settle(nonce, 'allow', '承認されました');
    return request;
  }

  /**
   * 期限切れの要求を捨てる (常駐プロセスなので放置すると溜まる)。
   * 処理済みでも期限までは残す — 消してしまうと二度目の押下に
   * 「無効です」と返ってしまい、「すでに承認済み」と区別が付かなくなる。
   * **消す前に待機者へ deny を返す** — 消すだけだと hook が永久に待つ。
   */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [nonce, req] of this.requests) {
      if (now > req.expiresAt) {
        this.settle(nonce, 'deny', 'この申請は期限切れです');
        this.requests.delete(nonce);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.requests.size;
  }

  /** 待っている hook の数 (診断・テスト用) */
  get waitingCount() {
    return this.waiters.size;
  }
}

/** 待機者へ返す拒否 (理由は必ず埋める — hook が空文字を返すとモデルに何も伝わらない) */
function denied(reason) {
  return { decision: 'deny', reason: reason || '承認されませんでした' };
}

// ---- 承認カードの表示 ----
// discord.js の Builder は使わず素の API JSON で組む (interactions.js と同じ流儀。
// このモジュールを discord.js 非依存に保ち、文面をテストから直接検査できるようにする)。

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_SUCCESS = 3;
const BUTTON_DANGER = 4;
const BUTTON_SECONDARY = 2;

/**
 * 申請カードの本文とボタン。
 *
 * **表示のときだけ無害化する。** 保存する grant は無加工のままで、
 * ここで潰したバッククォートや制御文字が保存値へ回ることはない。
 *
 * @param {object} request register() の戻り
 * @param {{stage?: 'request'|'confirm'|'approved'|'denied'|'invalid'|'expired', note?: string,
 *          escape?: (s: string) => string}} view
 * @returns {{content: string, components: Array<object>}}
 */
export function buildApprovalCard(request = {}, { stage = 'request', note = '', escape = (s) => s } = {}) {
  // hook 経路は job を止めて待っている。**同じ見出しにしない** — 1 タップの意味も
  // 効き始める時点も違うので、押す人が取り違えないところまで書き分ける
  const waiting = request.hook === true;
  const head = {
    request: waiting ? '🔐 ツール権限の申請 (job を止めて待っています)' : '🔐 ツール権限の申請',
    confirm: '❓ 恒久設定として保存します。よろしいですか',
    approved: waiting
      ? '✅ 承認しました (恒久設定として保存 / この job はそのまま続きます)'
      : '✅ 承認しました (恒久設定として保存)',
    denied: '🚫 却下しました (何も許可していません)',
    invalid: '⚠️ この申請は無効です (期限切れ、またはブリッジの再起動で失効しました)',
    expired: '⌛ この申請は無効になりました (何も許可していません)',
  }[stage] ?? '🔐 ツール権限の申請';

  // 失効したカードは中身を持たないことがある (台帳から消えている) ので、
  // 見出しだけで成立する形にしておく
  if (stage === 'invalid') {
    return {
      content: `**${head}**\n何も許可していません。必要なら agent にもう一度依頼してください。`,
      components: [],
    };
  }

  const grant = request.grant ?? {};
  // 承認できる種類だけをここに書く。増やすときは src/grants.js の GRANT_KINDS と
  // 同時に足すこと — 載っていない kind は「押さないでください」へ落ちる
  const scope = {
    'web-domain': 'このドメインだけ (https のみ)',
  }[grant.kind] ?? '(不明 — 押さないでください)';

  const lines = [
    `**${head}**`,
    `申請元: ${escape(String(request.botKey ?? '(不明)'))} / #${escape(String(request.channelName ?? '(不明)'))}`,
    `ルール: \`${escape(String(request.rule ?? '(不明)'))}\``,
    `範囲: ${scope}`,
  ];
  if (note) lines.push(escape(note));
  if (stage === 'request' || stage === 'confirm') {
    lines.push(
      waiting
        ? '「承認して続行」を押すと**その場で恒久設定として保存**され、' +
            `**いま止まっているこの job がそのまま続きます** (1 タップで確定します)。${waitLabel(request)}` +
            '押されなければ拒否として job を続行します。'
        : '効くのは**次の job から**です (実行中の job は再開しません)。' +
            'ブリッジを再起動すると、この申請は無効になります。',
    );
  }
  if (request.resolved && (stage === 'approved' || stage === 'denied')) {
    lines.push(`${stage === 'approved' ? '承認者' : '操作者'}: <@${request.resolved.userId}>`);
  }
  // 無効になったカードは原因を書く (待機上限と期限切れは別物で、押した人も居ない)
  if (stage === 'expired') {
    lines.push(`理由: ${escape(String(request.resolved?.note ?? EXPIRE_NOTE))}`);
    if (waiting) lines.push('job は待たずに続行しました。必要ならもう一度依頼してください。');
  }

  return { content: lines.join('\n').slice(0, 1900), components: componentsFor(request, stage) };
}

/** 「あと何分待つか」。待機上限が渡っていないカードでは書かない (嘘を書かない) */
function waitLabel(request) {
  const ms = request?.waitMs;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60000);
  return `待つのは約 ${minutes >= 1 ? `${minutes} 分` : `${Math.round(ms / 1000)} 秒`}で、`;
}

function componentsFor(request, stage) {
  if (stage === 'request') {
    return [row([
      // hook 経路は 1 タップで確定する。ラベルでもそれが分かる形にする
      button(request.hook === true ? '承認して続行' : '承認する', BUTTON_SUCCESS,
        buildCustomId('allow', request.nonce)),
      button('却下', BUTTON_DANGER, buildCustomId('deny', request.nonce)),
    ])];
  }
  if (stage === 'confirm') {
    return [row([
      button('恒久設定として確定', BUTTON_SUCCESS, buildCustomId('confirm', request.nonce)),
      button('やめる', BUTTON_SECONDARY, buildCustomId('deny', request.nonce)),
    ])];
  }
  return []; // 決着済み・無効なカードからはボタンを外す (再押下の余地を残さない)
}

function row(components) {
  return { type: COMPONENT_ACTION_ROW, components };
}

function button(label, style, customId) {
  return { type: COMPONENT_BUTTON, style, label, custom_id: customId };
}
