import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_OFFER_RECHECK_MIN,
  DEFAULT_SOCIETY_MAX_JOBS_PER_DAY,
  DEFAULT_SOCIETY_MODE,
  OBSERVE_ACTION_KINDS,
  SOCIETY_KEYS,
  SOCIETY_MODES,
  checkEffectivePermission,
  defaultSocietyAuthority,
  isSocietyEnabled,
  mandateRecord,
  reservedJobsPerDay,
  resolveSociety,
  validateSociety,
} from '../src/society-policy.js';

const T0 = Date.parse('2026-09-07T09:00:00.000Z');

/** 検証を通る最小の society 設定 */
function society(patch = {}) {
  return {
    channels: { 'society-trial': { cwd: 'C:/tmp' }, 'yobidashi-dev': { cwd: 'C:/tmp' } },
    bots: { fable: {}, opus2: {}, sol: { runtime: 'codex' } },
    society: { ...patch },
  };
}

function mandate(patch = {}) {
  return {
    version: 1,
    goal: '委譲が verify NG で止まったままにならない',
    tolerance: '1 営業日以内に次の担当が決まる',
    channels: ['society-trial'],
    resources: { maxJobsPerDay: 6 },
    escalate: '人間の承認が要る変更に当たったら止める',
    ...patch,
  };
}

// ---- 既定値 ----

test('society: 書いていなければ off (既定で社会は動き出さない)', () => {
  const resolved = resolveSociety({});
  assert.equal(resolved.mode, 'off');
  assert.equal(DEFAULT_SOCIETY_MODE, 'off');
  assert.equal(isSocietyEnabled({}), false);
  assert.equal(isSocietyEnabled({ society: {} }), false);
  assert.equal(isSocietyEnabled({ society: { mode: 'observe' } }), true);
  assert.deepEqual(validateSociety({}), []);
  // 壊れた値は既定へ倒す (落とすのは validateSociety の仕事)
  assert.equal(resolveSociety({ society: { mode: 'ACTIVE' } }).mode, 'off');
});

test('society: observe で起こせる Action は固定の 4 種で、設定では増やせない', () => {
  assert.deepEqual(OBSERVE_ACTION_KINDS, ['consult', 'investigate', 'measure', 'assess']);
  assert.equal(Object.isFrozen(OBSERVE_ACTION_KINDS), true);
  // **設定の allowlist には出さない** — 配備ごとに observe の意味が変わると C15 が読めない
  assert.equal(SOCIETY_KEYS.includes('observeActionKinds'), false);
  assert.deepEqual(SOCIETY_KEYS, ['mode', 'maxJobsPerDay', 'authority', 'offerRecheckMin', 'mandates']);
});

test('society: 総予算 B は 24 受付/日、確保枠は max(1, ceil(B × 0.10))', () => {
  const resolved = resolveSociety(society({ mode: 'observe' }));
  assert.equal(resolved.maxJobsPerDay, DEFAULT_SOCIETY_MAX_JOBS_PER_DAY);
  assert.equal(resolved.maxJobsPerDay, 24);
  assert.equal(resolved.reservedJobsPerDay, 3);
  assert.equal(resolved.authority, 'fable', '既定の担当は config.bots の先頭 (codex 以外)');
  assert.equal(resolved.offerRecheckMin, DEFAULT_OFFER_RECHECK_MIN);
  assert.deepEqual([1, 5, 10, 20, 24, 40].map(reservedJobsPerDay), [1, 1, 1, 2, 3, 4]);
  assert.equal(reservedJobsPerDay(0), 3, '不正値は既定 B に倒す');
});

test('society: mandates は既定を埋めた形で解決され、authority を継ぐ', () => {
  const resolved = resolveSociety(society({
    mode: 'observe',
    authority: 'opus2',
    mandates: { delivery: mandate(), quality: mandate({ authority: 'fable', state: 'suspended' }) },
  }));
  assert.deepEqual(Object.keys(resolved.mandates), ['delivery', 'quality']);
  assert.equal(resolved.mandates.delivery.authority, 'opus2');
  assert.equal(resolved.mandates.delivery.state, 'active');
  assert.equal(resolved.mandates.delivery.key, 'delivery');
  assert.deepEqual(resolved.mandates.delivery.escalate, ['人間の承認が要る変更に当たったら止める']);
  assert.equal(resolved.mandates.quality.authority, 'fable');
  assert.equal(resolved.mandates.quality.state, 'suspended');
});

test('society: mandateRecord は台帳へ置く版の写しを作る', () => {
  const resolved = resolveSociety(society({ mode: 'observe', mandates: { delivery: mandate({ version: 4 }) } }));
  const record = mandateRecord(resolved.mandates.delivery, 'M-7', T0);
  assert.equal(record.id, 'M-7');
  assert.equal(record.key, 'delivery');
  assert.equal(record.version, 4);
  assert.equal(record.state, 'active');
  assert.equal(record.copiedAt, new Date(T0).toISOString());
  assert.deepEqual(record.channels, ['society-trial']);
  assert.equal(record.resources.maxJobsPerDay, 6);
});

// ---- 構造の検証 (mode に関係なく常に見る) ----

test('society: 未知キー・型違い・不正値は起動時に落とす', () => {
  const errs = (patch) => validateSociety(society(patch));
  assert.deepEqual(errs({}), []);
  assert.deepEqual(validateSociety({ society: [] }), ['society はオブジェクトで書く']);
  assert.ok(errs({ maxJobs: 10 }).some((e) => e.includes('未知のキー')));
  assert.ok(errs({ mode: 'on' }).some((e) => e.includes(SOCIETY_MODES.join(' | '))));
  for (const bad of [0, -1, 1.5, '24']) {
    assert.ok(errs({ maxJobsPerDay: bad }).some((e) => e.includes('maxJobsPerDay')), String(bad));
  }
  assert.ok(errs({ offerRecheckMin: 0 }).some((e) => e.includes('offerRecheckMin')));
  assert.ok(errs({ authority: '' }).some((e) => e.includes('authority')));
  // 書けるキーの一覧は allowlist と一致する
  assert.deepEqual([...SOCIETY_KEYS], ['mode', 'maxJobsPerDay', 'authority', 'offerRecheckMin', 'mandates']);
});

test('society: mandates は構造を常に検査する (off でも)', () => {
  const errs = (m) => validateSociety(society({ mandates: m }));
  assert.deepEqual(errs({ delivery: mandate() }), []);
  assert.ok(validateSociety(society({ mandates: [] })).some((e) => e.includes('オブジェクトで書く')));
  assert.ok(errs({ Delivery: mandate() }).some((e) => e.includes('英小文字・数字')));
  assert.ok(errs({ delivery: mandate({ version: undefined }) }).some((e) => e.includes('version')));
  assert.ok(errs({ delivery: mandate({ goal: '' }) }).some((e) => e.includes('goal')));
  assert.ok(errs({ delivery: mandate({ tolerance: undefined }) }).some((e) => e.includes('tolerance')));
  assert.ok(errs({ delivery: mandate({ escalate: undefined }) }).some((e) => e.includes('escalate')));
  assert.ok(errs({ delivery: mandate({ state: 'paused' }) }).some((e) => e.includes('state')));
  assert.ok(errs({ delivery: { ...mandate(), scope: 'x' } }).some((e) => e.includes('不明なキー')));
});

test('society: mandates の channels は実在するチャンネルだけ', () => {
  const missing = validateSociety(society({ mandates: { delivery: mandate({ channels: ['society-trial', 'nope'] }) } }));
  assert.ok(missing.some((e) => e.includes('channels が channels に無い: nope')), missing.join(' / '));
  assert.ok(validateSociety(society({ mandates: { delivery: mandate({ channels: [] }) } }))
    .some((e) => e.includes('1 件以上')));
});

test('society: Mandate への配分は総予算 B を超えられない', () => {
  const over = validateSociety(society({
    maxJobsPerDay: 8,
    mandates: { delivery: mandate({ resources: { maxJobsPerDay: 9 } }) },
  }));
  assert.ok(over.some((e) => e.includes('総予算 B (8) を超えている')), over.join(' / '));
  assert.deepEqual(validateSociety(society({
    maxJobsPerDay: 8,
    mandates: { delivery: mandate({ resources: { maxJobsPerDay: 8 } }) },
  })), []);
  assert.ok(validateSociety(society({ mandates: { delivery: mandate({ resources: {} }) } }))
    .some((e) => e.includes('resources.maxJobsPerDay')));
});

// ---- 稼働条件 (mode !== off のときだけ) ----

test('society: mode が off なら担当が居なくても起動できる (機構ごと止めている設定)', () => {
  assert.deepEqual(validateSociety({
    channels: { 'society-trial': {} },
    bots: {},
    society: { mode: 'off', mandates: { delivery: mandate() } },
  }), []);
});

test('society: observe / active は担当 bot が実在し codex でないことを求める', () => {
  for (const mode of ['observe', 'active']) {
    // 書いた担当が居ない (既定の解決は config.bots の先頭へ倒すので、明示指定で見る)
    const absent = validateSociety({
      channels: { 'society-trial': {} }, bots: { opus: {} }, society: { mode, authority: 'nobody' },
    });
    assert.ok(absent.some((e) => e.includes('居ない bot が入っている: nobody')), absent.join(' / '));
    assert.ok(absent.some((e) => e.includes(`society.mode が ${mode}`)));
    // bot が 1 体でも居れば既定は決まる (以前は fable が居ないだけで起動できなかった)
    assert.deepEqual(validateSociety({
      channels: { 'society-trial': {} }, bots: { opus: {} }, society: { mode },
    }), []);

    const codex = validateSociety(society({ mode, authority: 'sol' }));
    assert.ok(codex.some((e) => e.includes('runtime: "codex"')), codex.join(' / '));
    assert.deepEqual(validateSociety(society({ mode })), []);
    assert.deepEqual(validateSociety(society({ mode, authority: 'opus2' })), []);
  }
});

test('society: 既定の担当は config.bots の先頭だが、明示指定は倒さない', () => {
  // **コードは bot キーを決め打ちしない** — 顔ぶれは配備ごとに違う
  const oneBot = { channels: { 'society-trial': {} }, bots: { second: {} }, society: { mode: 'observe' } };
  assert.equal(defaultSocietyAuthority(oneBot), 'second');
  assert.equal(resolveSociety(oneBot).authority, 'second');
  assert.deepEqual(validateSociety(oneBot), []);

  assert.equal(defaultSocietyAuthority({ bots: { first: {}, second: {} } }), 'first');
  // codex ランタイムは候補にしない (構造化出力を返せない)
  assert.equal(defaultSocietyAuthority({ bots: { first: { runtime: 'codex' }, second: {} } }), 'second');
  // 候補が居なければ null。稼働条件の検証が「担当を決められない」として落とす
  assert.equal(defaultSocietyAuthority({ bots: { first: { runtime: 'codex' } } }), null);
  assert.equal(defaultSocietyAuthority({ bots: {} }), null);
  const noCandidate = validateSociety({
    channels: { 'society-trial': {} }, bots: { first: { runtime: 'codex' } }, society: { mode: 'observe' },
  });
  assert.equal(noCandidate.length, 1, noCandidate.join('\n'));
  assert.match(noCandidate[0], /担当になれる bot/);

  // **明示的に書いた担当は黙って倒さない** — 書いた設定が効かないほうが分かりにくい
  const explicit = validateSociety({
    channels: { 'society-trial': {} }, bots: { opus2: {} }, society: { mode: 'observe', authority: 'fable' },
  });
  assert.ok(explicit.some((e) => e.includes('society.authority') && e.includes('fable')), explicit.join(' / '));

});

test('society: Mandate ごとの authority も実在と runtime を見る', () => {
  const errs = validateSociety(society({
    mode: 'active',
    mandates: { delivery: mandate({ authority: 'sol' }), quality: mandate({ authority: 'nobody' }) },
  }));
  assert.ok(errs.some((e) => e.includes('society.mandates.delivery.authority') && e.includes('codex')), errs.join(' / '));
  assert.ok(errs.some((e) => e.includes('society.mandates.quality.authority') && e.includes('nobody')), errs.join(' / '));
});

test('society: authority のエラーは場所ごとに出る (同じ bot を 2 か所で指しても畳まない)', () => {
  const errs = validateSociety(society({
    mode: 'active',
    authority: 'nobody',
    mandates: { delivery: mandate({ authority: 'nobody' }) },
  }));
  assert.ok(errs.some((e) => e.startsWith('society.authority')), errs.join(' / '));
  assert.ok(errs.some((e) => e.startsWith('society.mandates.delivery.authority')), errs.join(' / '));
});

test('society: resolveSociety は channels の前後の空白を落とす (validate と同じ見え方にする)', () => {
  const resolved = resolveSociety(society({
    mode: 'observe',
    mandates: {
      delivery: mandate({
        channels: [' society-trial '],
        resources: { maxJobsPerDay: 2, channels: [' yobidashi-dev '] },
      }),
    },
  }));
  assert.deepEqual(resolved.mandates.delivery.channels, ['society-trial']);
  assert.deepEqual(resolved.mandates.delivery.resources.channels, ['yobidashi-dev']);
  // 検証側も trim して実在を見る (書き方の揺れで「無いチャンネル」にしない)
  assert.deepEqual(validateSociety(society({
    mandates: { delivery: mandate({ channels: [' society-trial '] }) },
  })), []);
});

test('society: mandateRecord の now が不正なら理由の分かる例外になる', () => {
  const m = resolveSociety(society({ mandates: { delivery: mandate() } })).mandates.delivery;
  assert.equal(mandateRecord(m, 'M-1', T0).copiedAt, new Date(T0).toISOString());
  assert.equal(mandateRecord(m, 'M-1', '2026-09-07T09:00:00.000Z').copiedAt, new Date(T0).toISOString());
  for (const bad of [undefined, null, 'きのう', NaN]) {
    assert.throws(() => mandateRecord(m, 'M-1', bad), /mandateRecord の now には時刻/, String(bad));
  }
});

test('society: 担当を bots ではなく注入で渡せる (config を組み立てずに判定できる)', () => {
  const config = { channels: { 'society-trial': {} }, society: { mode: 'active' } };
  assert.ok(validateSociety(config).some((e) => e.includes('担当になれる bot')));
  assert.deepEqual(validateSociety(config, { bots: { fable: {} } }), []);
});

// ---- 受諾時の実効権限 ----

const BOTS = {
  opus: { runtime: 'claude', online: true },
  sol: { runtime: 'codex', online: true },
  ghost: { runtime: 'claude', online: false },
};

test('実効権限: 起動している claude の bot が、構造化の有効なチャンネルで受けられる', () => {
  const out = checkEffectivePermission({ botKey: 'opus', bots: BOTS, channelName: 'society-trial' });
  assert.deepEqual(out, { ok: true, reasons: [] });
});

test('実効権限: 落ちる分岐は理由をすべて返す', () => {
  const missing = checkEffectivePermission({ botKey: 'nobody', bots: BOTS });
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.some((r) => /設定に無い bot/.test(r)));

  const offline = checkEffectivePermission({ botKey: 'ghost', bots: BOTS });
  assert.equal(offline.ok, false);
  assert.ok(offline.reasons.some((r) => /起動していません/.test(r)));

  const codex = checkEffectivePermission({ botKey: 'sol', bots: BOTS });
  assert.equal(codex.ok, false);
  assert.ok(codex.reasons.some((r) => /codex/.test(r)));

  const plain = checkEffectivePermission({
    botKey: 'opus', bots: BOTS, structuredOutput: false, channelName: 'chat',
  });
  assert.equal(plain.ok, false);
  assert.ok(plain.reasons.some((r) => /structuredOutput/.test(r)));

  const outside = checkEffectivePermission({
    botKey: 'opus', bots: BOTS, channelName: 'yobidashi-dev',
    mandate: { id: 'M-1', channels: ['society-trial'] },
  });
  assert.equal(outside.ok, false);
  assert.ok(outside.reasons.some((r) => /channels/.test(r)));

  const offRoster = checkEffectivePermission({
    botKey: 'opus', bots: BOTS, channelName: 'society-trial', roster: ['fable'],
  });
  assert.equal(offRoster.ok, false);
  assert.ok(offRoster.reasons.some((r) => /編成に入っていません/.test(r)));

  // 複数落ちたら全部返す (1 つ直したら次が出る、を繰り返さない)
  const many = checkEffectivePermission({
    botKey: 'sol', bots: BOTS, channelName: 'chat', structuredOutput: false, roster: ['fable'],
  });
  assert.equal(many.ok, false);
  assert.equal(many.reasons.length, 3, many.reasons.join(' / '));
});

test('実効権限: channels を持つ Mandate で宛先チャンネルが分からなければ断る', () => {
  // fail-open だと「channel を渡し忘れた相談」が範囲外でも受諾できてしまう (Opus2 指摘 ③ 2026-09-08)
  for (const channelName of [null, undefined, '', '  ']) {
    const unknown = checkEffectivePermission({
      botKey: 'opus', bots: BOTS, channelName, mandate: { id: 'M-1', channels: ['society-trial'] },
    });
    assert.equal(unknown.ok, false, JSON.stringify(channelName));
    assert.ok(unknown.reasons.some((r) => /チャンネルが分かりません/.test(r)), unknown.reasons.join(' / '));
  }
  // 範囲の中と分かれば通る
  assert.equal(checkEffectivePermission({
    botKey: 'opus', bots: BOTS, channelName: 'society-trial',
    mandate: { id: 'M-1', channels: ['society-trial'] },
  }).ok, true);
});

test('実効権限: Mandate に channels が無ければチャンネルでは絞らない', () => {
  assert.equal(checkEffectivePermission({
    botKey: 'opus', bots: BOTS, channelName: 'どこでも', mandate: { id: 'M-1' },
  }).ok, true);
  // 編成が未設定 (null) も絞らない
  assert.equal(checkEffectivePermission({ botKey: 'opus', bots: BOTS, roster: null }).ok, true);
});
