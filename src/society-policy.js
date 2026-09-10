/**
 * 自律社会の設定 (`config.policy.json` の `society`) — 仕様は docs/society-ledger.md と
 * docs/social-engineering.md §12.4。
 *
 * **既定は `off`** — 書いていない配備で社会が動き出さない (`autonomy` / `initiative` と同じ fail-closed)。
 * 検証は allowlist 方式にしてある。未知キーを黙って無視すると「書いたつもりの設定が効いていない」に
 * 化けるが、これは人が見ていない間に動く機構なので、その食い違いは起動時に落とすほうがよい。
 *
 * ここは**純粋関数だけ** — ファイルも時計も持たない (`now` は引数で受ける)。
 */

/** `society.mode` の閉集合。`off` は台帳に触れず既存経路をそのまま使う (受入 C15 の基準) */
export const SOCIETY_MODES = Object.freeze(['off', 'observe', 'active']);

/** 既定は off。設定に書いていない配備では社会由来の起動が一切起きない */
export const DEFAULT_SOCIETY_MODE = 'off';

/**
 * `observe` で起こしてよい Action の kind (docs/society-ledger.md §12「observe = 記録と
 * 読取り専用の観測・相談 Action だけ。task 起票・割当変更・コード反映は行わない」)。
 *
 * **設定には出さない固定の集合**。observe は「人がまだ任せていない」段階の呼び方なので、
 * どこまで起こしてよいかを配備ごとに書き換えられるようにすると、observe と active の
 * 区別そのものが配備ごとに変わってしまう (受入 C15 の基準が読めなくなる)。
 * 台帳 (`src/cases.js`) の kind は閉集合ではない — ここは**この門でだけ**使う。
 */
export const OBSERVE_ACTION_KINDS = Object.freeze(['consult', 'investigate', 'measure', 'assess']);

/**
 * 総予算 B (受付 / 日)。§12.4 の推奨値 24 — E1 一巡の見積 15〜20 受付に余裕を足した数で、
 * 既存 autonomy チャンネル上限の合計 (120) 以下。
 */
export const DEFAULT_SOCIETY_MAX_JOBS_PER_DAY = 24;

/** 確保枠の割合 (B のうち追跡・観測のために通常業務から守る分) */
export const SOCIETY_RESERVED_RATIO = 0.1;

/** 引受け申し出の再確認間隔 (分)。§12.4 の時定数 */
export const DEFAULT_OFFER_RECHECK_MIN = 5;

/** `society` が持てるキー (増やすときは validateSociety も直す) */
export const SOCIETY_KEYS = Object.freeze(['mode', 'maxJobsPerDay', 'authority', 'offerRecheckMin', 'mandates']);

/** 1 つの Mandate が持てるキー (増やすときは validateSociety も直す) */
export const SOCIETY_MANDATE_KEYS = Object.freeze([
  'version', 'goal', 'tolerance', 'channels', 'resources', 'escalate', 'state', 'authority',
]);

/** Mandate が持てるキー (`resources`) */
export const SOCIETY_MANDATE_RESOURCE_KEYS = Object.freeze(['maxJobsPerDay', 'channels']);

/** Mandate の状態 (§2)。`ended` の Mandate からは新しい Case を作らない */
export const MANDATE_STATES = Object.freeze(['active', 'suspended', 'ended']);

/**
 * Mandate キーは **RFC 6901 pointer の 1 セグメントとして安定して書ける形**に限る
 * (`duties` と同じ理由 — `/` や `~` を含むキーはエスケープが要り、提案の target と表記が割れる)。
 */
const MANDATE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

/** 総予算 B のうち追跡・観測に確保する枠 = max(1, ceil(B × 0.10)) (§12.4) */
export function reservedJobsPerDay(maxJobsPerDay = DEFAULT_SOCIETY_MAX_JOBS_PER_DAY) {
  const b = isPositiveInt(maxJobsPerDay) ? maxJobsPerDay : DEFAULT_SOCIETY_MAX_JOBS_PER_DAY;
  return Math.max(1, Math.ceil(b * SOCIETY_RESERVED_RATIO));
}

/**
 * `authority` を書いていないときの担当 (§12.4)。
 *
 * **コードは bot キーを決め打ちしない** — 顔ぶれは配備ごとに違うので、`config.bots` の
 * 先頭の bot を採る。候補が居なければ null で、稼働条件の検証が「担当が居ない」として落とす。
 * codex ランタイムの bot は構造化出力を返せないので候補から外す (§3.8 の duty と同じ制約)。
 *
 * **倒すのは既定を解決するときだけ。** 明示的に書いた bot が居ないときに黙って別の bot へ
 * 倒すと、書いた設定が効いていないことに気付けない — そちらは validateSociety が落とす。
 */
export function defaultSocietyAuthority(config = {}) {
  const bots = isPlainObject(config?.bots) ? config.bots : {};
  return Object.keys(bots).find((key) => bots[key]?.runtime !== 'codex') ?? null;
}

/** 社会が動く設定か (`off` 以外)。**書いていなければ false** */
export function isSocietyEnabled(config = {}) {
  return resolveSociety(config).mode !== DEFAULT_SOCIETY_MODE;
}

/**
 * `society` の実効値 (既定を埋めた形)。壊れた値は既定へ倒す
 * (綴り違い・型不正は validateSociety が起動時に落とすので、ここで例外にしない)。
 *
 * @returns {{mode: string, maxJobsPerDay: number, reservedJobsPerDay: number, authority: string,
 *            offerRecheckMin: number, mandates: Record<string, object>}}
 */
export function resolveSociety(config = {}) {
  const society = isPlainObject(config?.society) ? config.society : {};
  const mode = SOCIETY_MODES.includes(society.mode) ? society.mode : DEFAULT_SOCIETY_MODE;
  const maxJobsPerDay = isPositiveInt(society.maxJobsPerDay)
    ? society.maxJobsPerDay
    : DEFAULT_SOCIETY_MAX_JOBS_PER_DAY;
  const authority = isNonEmptyString(society.authority)
    ? society.authority.trim()
    : defaultSocietyAuthority(config);
  const offerRecheckMin = isPositiveInt(society.offerRecheckMin)
    ? society.offerRecheckMin
    : DEFAULT_OFFER_RECHECK_MIN;

  const mandates = {};
  const raw = isPlainObject(society.mandates) ? society.mandates : {};
  for (const key of Object.keys(raw).sort()) {
    const m = isPlainObject(raw[key]) ? raw[key] : {};
    mandates[key] = {
      key,
      version: isPositiveInt(m.version) ? m.version : 1,
      goal: isNonEmptyString(m.goal) ? m.goal.trim() : '',
      tolerance: isNonEmptyString(m.tolerance) ? m.tolerance.trim() : '',
      // 前後の空白は落とす — validateSociety が channels の実在を trim して見るので、
      // 解決側が落とさないと「検証は通るのに実行時に別名で引けない」がありうる
      channels: Array.isArray(m.channels) ? m.channels.filter(isNonEmptyString).map((c) => c.trim()) : [],
      resources: {
        // 資源上限は Mandate ごとの配分。書いていなければ総予算 B をそのまま上限にする
        maxJobsPerDay: isPositiveInt(m.resources?.maxJobsPerDay) ? m.resources.maxJobsPerDay : maxJobsPerDay,
        channels: Array.isArray(m.resources?.channels)
          ? m.resources.channels.filter(isNonEmptyString).map((c) => c.trim())
          : [],
      },
      escalate: normalizeEscalate(m.escalate),
      state: MANDATE_STATES.includes(m.state) ? m.state : 'active',
      // Mandate 個別の裁定責務。書いていなければ society 全体の authority を継ぐ
      authority: isNonEmptyString(m.authority) ? m.authority.trim() : authority,
    };
  }

  return {
    mode,
    maxJobsPerDay,
    reservedJobsPerDay: reservedJobsPerDay(maxJobsPerDay),
    authority,
    offerRecheckMin,
    mandates,
  };
}

/** `escalate` は 1 行でも複数行でも書ける (人間へ委ねる条件は 1 つとは限らない) */
function normalizeEscalate(value) {
  if (isNonEmptyString(value)) return [value.trim()];
  if (Array.isArray(value)) return value.filter(isNonEmptyString).map((v) => v.trim());
  return [];
}

/**
 * policy の Mandate から台帳に置く**版の写し** (`M-` 記録) を作る。
 *
 * 台帳が参照するのは写しであって config ではない — 実行中に policy を書き換えても、
 * 走っている Case が見る Mandate の版は動かない (§2「台帳には版の写しを置き、実行時はその版を参照する」)。
 *
 * @param {object} policyMandate `resolveSociety(config).mandates[key]`
 * @param {string} id 台帳が採番した `M-<n>`
 * @param {number|string} now 時刻 (ミリ秒か ISO 文字列)
 */
export function mandateRecord(policyMandate = {}, id, now) {
  const ms = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) {
    // 素の RangeError (Invalid time value) だと、どの引数が悪いのか呼び出し側で分からない
    throw new TypeError(
      `mandateRecord の now には時刻 (ミリ秒か ISO 文字列) を渡す (受け取った値: ${JSON.stringify(now ?? null)})`,
    );
  }
  const at = new Date(ms).toISOString();
  return {
    id,
    key: isNonEmptyString(policyMandate.key) ? policyMandate.key : null,
    version: isPositiveInt(policyMandate.version) ? policyMandate.version : 1,
    goal: policyMandate.goal ?? '',
    tolerance: policyMandate.tolerance ?? '',
    channels: Array.isArray(policyMandate.channels) ? [...policyMandate.channels] : [],
    resources: {
      maxJobsPerDay: policyMandate.resources?.maxJobsPerDay ?? DEFAULT_SOCIETY_MAX_JOBS_PER_DAY,
      channels: Array.isArray(policyMandate.resources?.channels) ? [...policyMandate.resources.channels] : [],
    },
    escalate: normalizeEscalate(policyMandate.escalate),
    state: MANDATE_STATES.includes(policyMandate.state) ? policyMandate.state : 'active',
    // 渡ってくるのは resolveSociety が解決済みの Mandate なので、ここでは既に
    // society 全体の authority を継いでいる。素の policy を渡された場合だけ null になる
    authority: policyMandate.authority ?? null,
    copiedAt: at,
  };
}

/**
 * 受諾時点の実効権限 (`既存能力 ∩ Mandate ∩ Claim.scope` — docs/society-ledger.md §3・受入 C05)。
 *
 * **受諾で権限が増えないことを、受諾の瞬間にもう一度確かめる**ための判定。申し出を作った時点と
 * 受諾の時点の間に bot が落ちたり編成が変わったりするので、申し出たときに通ったことは根拠にならない。
 * 落ちた理由は全部返す — 1 つ直したら次が出る、を繰り返さないため。
 *
 * 見るもの:
 * - **起動しているか** (`bots[botKey]` があり userId を持つ) — 居ない相手は引き受けられない
 * - **claude ランタイムか** — codex は `--json-schema` を持たず、受諾を構造化で返せない (§3.8)
 * - **そのチャンネルの構造化出力が有効か** — 切ってある場は成果物へ向かわない場
 * - **Mandate の channels に入っているか** (Mandate が channels を持つときだけ)
 * - **スレッドの編成 (roster) が許しているか** — 宛先の allowlist を受諾だけ迂回しない
 *
 * @param {object} p
 * @param {string} p.botKey 受諾しようとしている bot
 * @param {object} p.bots `config.bots` (キー = bot キー)。`online` は起動しているか
 * @param {string|null} [p.channelName] 宛先スレッドのチャンネル
 * @param {boolean} [p.structuredOutput] そのチャンネルの構造化出力
 * @param {object|null} [p.mandate] 台帳の Mandate の写し (`channels` を見る)
 * @param {object|null} [p.claim] 引受け (いまは `scope` を記録として見るだけ)
 * @param {string[]|null} [p.roster] スレッドの編成 (null = 制限なし)
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkEffectivePermission({
  botKey, bots = {}, channelName = null, structuredOutput = true,
  mandate = null, claim = null, roster = null,
} = {}) {
  const reasons = [];
  const key = isNonEmptyString(botKey) ? botKey.trim() : '';
  const bot = isPlainObject(bots) && key !== '' ? bots[key] : null;
  if (!bot) {
    reasons.push(`${key || '(空)'} は設定に無い bot です`);
  } else if (bot.online === false) {
    reasons.push(`${key} は起動していません`);
  }
  if (bot && bot.runtime === 'codex') {
    reasons.push(`${key} は runtime: "codex" なので引受けを構造化して返せません`);
  }
  if (structuredOutput === false) {
    reasons.push(
      `${channelName ? `チャンネル ${channelName} は` : 'このチャンネルは'} structuredOutput が false です`,
    );
  }
  const allowed = Array.isArray(mandate?.channels) ? mandate.channels : [];
  if (allowed.length > 0) {
    // **分からないなら断る。** channels を持つ Mandate で宛先チャンネルが不明なとき、
    // 判定を飛ばすと「channel を渡し忘れた相談」が範囲外でも受諾できてしまう
    // (Opus2 指摘 ③ 2026-09-08 — fail-open を fail-closed へ)
    if (!isNonEmptyString(channelName)) {
      reasons.push(
        `Mandate ${mandate.id ?? ''} は channels (${allowed.join(' / ')}) に限られていますが、`
        + '宛先のチャンネルが分かりません',
      );
    } else if (!allowed.includes(channelName.trim())) {
      reasons.push(`Mandate ${mandate.id ?? ''} の channels (${allowed.join(' / ')}) の外です`);
    }
  }
  if (Array.isArray(roster) && key !== '' && !roster.includes(key)) {
    reasons.push(`${key} はこのスレッドの編成に入っていません`);
  }
  // scope は「判断できる範囲」の記録で、いまは狭める材料としてだけ持つ (広げる経路は無い)
  if (claim && isNonEmptyString(claim.scope) === false && claim.scope !== null && claim.scope !== undefined) {
    reasons.push('Claim の scope が文字列ではありません');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * `society` の設定検証。
 *
 * **構造 (未知キー・型・値域・channels の実在) は常に見るが、稼働条件は `mode !== 'off'` のときだけ見る。**
 * `off` は機構ごと止める設定なので、止めたまま担当を書き忘れた config が起動できないのは食い違う
 * (`initiative.applyChannel` と同じ扱い — Sol 指摘 2026-08-31)。
 *
 * 稼働条件 (§12.4):
 * - `authority` の bot が実在する — 担当不在で `active` は起動を拒否する
 * - その bot が `runtime: "codex"` でない — codex は `--json-schema` を持たず、引受け・裁定を
 *   構造化出力で受け取れない (§3.8 の duty と同じ制約)
 *
 * @param {object} config 合成後の config
 * @param {{bots?: object|null}} [deps] bot 定義 (省略すると config.bots を見る)
 * @returns {string[]} 人間向けエラー行 (空配列 = 起動してよい)
 */
export function validateSociety(config = {}, { bots = null } = {}) {
  const society = config?.society;
  if (society === undefined) return [];
  if (!isPlainObject(society)) return ['society はオブジェクトで書く'];

  const errors = [];
  const unknown = Object.keys(society).filter((k) => !SOCIETY_KEYS.includes(k));
  if (unknown.length > 0) {
    errors.push(`society の未知のキー: ${unknown.join(' / ')} (書けるのは ${SOCIETY_KEYS.join(' / ')})`);
  }

  if (society.mode !== undefined && !SOCIETY_MODES.includes(society.mode)) {
    errors.push(
      `society.mode: ${JSON.stringify(society.mode)} は不明 `
      + `(${SOCIETY_MODES.join(' | ')} の文字列で書く／省略時は ${DEFAULT_SOCIETY_MODE})`,
    );
  }
  if (society.maxJobsPerDay !== undefined && !isPositiveInt(society.maxJobsPerDay)) {
    errors.push(
      `society.maxJobsPerDay は 1 以上の整数で書く (受け取った値: ${JSON.stringify(society.maxJobsPerDay)}／`
      + `省略時は ${DEFAULT_SOCIETY_MAX_JOBS_PER_DAY} 受付/日)`,
    );
  }
  if (society.offerRecheckMin !== undefined && !isPositiveInt(society.offerRecheckMin)) {
    errors.push(
      `society.offerRecheckMin は 1 以上の整数 (分) で書く (受け取った値: ${JSON.stringify(society.offerRecheckMin)}／`
      + `省略時は ${DEFAULT_OFFER_RECHECK_MIN})`,
    );
  }
  if (society.authority !== undefined && !isNonEmptyString(society.authority)) {
    errors.push('society.authority には裁定責務を引き受ける bot キーを書く');
  }

  const channels = isPlainObject(config?.channels) ? config.channels : {};
  const maxJobs = isPositiveInt(society.maxJobsPerDay) ? society.maxJobsPerDay : DEFAULT_SOCIETY_MAX_JOBS_PER_DAY;
  errors.push(...validateMandates(society, { channels, maxJobs }));

  // 機構ごと止めている config では、稼働条件までは求めない
  const mode = SOCIETY_MODES.includes(society.mode) ? society.mode : DEFAULT_SOCIETY_MODE;
  if (mode === DEFAULT_SOCIETY_MODE) return errors;

  const botTable = isPlainObject(bots) ? bots : (isPlainObject(config?.bots) ? config.bots : {});
  // **場所ごとに見る** (bot キーで畳まない) — 同じ bot を 2 か所で指していると、
  // 畳んだ側の場所が報告に出ず「どこを直せばいいのか」が分からなくなる
  const authorities = [];
  if (isNonEmptyString(society.authority)) {
    authorities.push([society.authority.trim(), 'society.authority']);
  } else {
    // 省略時は config.bots の先頭 (codex は除く)。候補が居なければここで落ちる
    authorities.push([
      defaultSocietyAuthority({ bots: botTable }),
      'society.authority (省略時は config.bots の先頭・codex は担当にできない)',
    ]);
  }
  if (isPlainObject(society.mandates)) {
    for (const [key, m] of Object.entries(society.mandates)) {
      if (isPlainObject(m) && isNonEmptyString(m.authority)) {
        authorities.push([m.authority.trim(), `society.mandates.${key}.authority`]);
      }
    }
  }
  for (const [key, at] of authorities) {
    // 既定が決まらない配備 (bot が 1 体も居ない / 全員 codex)。
    // 「居ない bot が入っている: null」と言うと直す場所を取り違える
    if (!isNonEmptyString(key)) {
      errors.push(
        `${at} を決められない — society.mode が ${mode} なら、受付・未受諾追跡の担当になれる bot `
        + '(codex 以外) が config.bots に 1 体は要る',
      );
      continue;
    }
    if (!Object.hasOwn(botTable, key)) {
      errors.push(
        `${at} に居ない bot が入っている: ${key} — `
        + `society.mode が ${mode} なら受付・未受諾追跡の担当が実在しないと起動できない`,
      );
      continue;
    }
    if (botTable[key]?.runtime === 'codex') {
      errors.push(
        `${at} の bot ${key} は runtime: "codex" なので裁定責務を持てない — `
        + 'codex は --json-schema を持たず、引受けも裁定も構造化出力で受け取るため',
      );
    }
  }
  return errors;
}

function validateMandates(society, { channels, maxJobs }) {
  if (society.mandates === undefined) return [];
  if (!isPlainObject(society.mandates)) {
    return ['society.mandates はオブジェクトで書く (キーが Mandate の ID — 配列にしない)'];
  }
  const errors = [];
  for (const [key, mandate] of Object.entries(society.mandates)) {
    const at = `society.mandates.${key}`;
    if (!MANDATE_KEY_RE.test(key)) {
      errors.push(`society.mandates のキー "${key}" は英小文字・数字・- だけで書く (pointer の 1 セグメントになる)`);
    }
    if (!isPlainObject(mandate)) {
      errors.push(`${at} はオブジェクトで書く (${SOCIETY_MANDATE_KEYS.join(' / ')})`);
      continue;
    }
    for (const k of Object.keys(mandate)) {
      if (!SOCIETY_MANDATE_KEYS.includes(k)) {
        errors.push(`${at}.${k} は不明なキー (使えるのは ${SOCIETY_MANDATE_KEYS.join(' / ')})`);
      }
    }
    if (!isPositiveInt(mandate.version)) {
      errors.push(`${at}.version は 1 以上の整数で書く (台帳へ写す版になるので省略できない)`);
    }
    for (const k of ['goal', 'tolerance']) {
      if (!isNonEmptyString(mandate[k])) {
        errors.push(`${at}.${k} には ${k === 'goal' ? '望む状態' : '許容範囲'}を文で書く`);
      }
    }
    if (!Array.isArray(mandate.channels) || mandate.channels.length === 0
        || !mandate.channels.every(isNonEmptyString)) {
      errors.push(`${at}.channels にはチャンネル名を 1 件以上並べる`);
    } else {
      const missing = mandate.channels.filter((name) => !Object.hasOwn(channels, name.trim()));
      if (missing.length > 0) {
        errors.push(`${at}.channels が channels に無い: ${missing.join(' / ')}`);
      }
    }
    if (!isPlainObject(mandate.resources)) {
      errors.push(`${at}.resources はオブジェクトで書く (${SOCIETY_MANDATE_RESOURCE_KEYS.join(' / ')})`);
    } else {
      for (const k of Object.keys(mandate.resources)) {
        if (!SOCIETY_MANDATE_RESOURCE_KEYS.includes(k)) {
          errors.push(`${at}.resources.${k} は不明なキー (使えるのは ${SOCIETY_MANDATE_RESOURCE_KEYS.join(' / ')})`);
        }
      }
      if (!isPositiveInt(mandate.resources.maxJobsPerDay)) {
        errors.push(`${at}.resources.maxJobsPerDay は 1 以上の整数で書く (この Mandate に配る受付/日)`);
      } else if (mandate.resources.maxJobsPerDay > maxJobs) {
        errors.push(
          `${at}.resources.maxJobsPerDay (${mandate.resources.maxJobsPerDay}) が総予算 B (${maxJobs}) を超えている — `
          + '配分の合計が全体上限を越えると、Mandate ごとの上限が上限として効かない',
        );
      }
      if (mandate.resources.channels !== undefined
          && (!Array.isArray(mandate.resources.channels) || !mandate.resources.channels.every(isNonEmptyString))) {
        errors.push(`${at}.resources.channels にはチャンネル名の文字列を並べる`);
      }
    }
    if (normalizeEscalate(mandate.escalate).length === 0) {
      errors.push(`${at}.escalate には判断を人間へ委ねる条件を書く (文字列か文字列の配列)`);
    }
    if (mandate.state !== undefined && !MANDATE_STATES.includes(mandate.state)) {
      errors.push(
        `${at}.state: ${JSON.stringify(mandate.state)} は不明 (${MANDATE_STATES.join(' | ')}／省略時は active)`,
      );
    }
    if (mandate.authority !== undefined && !isNonEmptyString(mandate.authority)) {
      errors.push(`${at}.authority には裁定責務を引き受ける bot キーを書く`);
    }
  }
  return errors;
}
