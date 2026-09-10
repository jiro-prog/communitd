import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WAITING_REASONS } from '../src/cases.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_KINDS,
  FIELD_LABELS,
  MAX_DID_ITEMS,
  MAX_ITEMS,
  MAX_ITEM_CHARS,
  MAX_PROPOSED_TASKS,
  MAX_TEXT_CHARS,
  NARROWED_DENY_TOOLS,
  REVIEW_VERDICTS,
  SCHEMAS,
  approvalBoard,
  bindContract,
  bodyOf,
  canDelegateTo,
  classifyExternalSettings,
  consumableBy,
  contractFor,
  contractSaveLabel,
  formatContractTag,
  formatSchemaTag,
  isTouchRestricted,
  narrowForTouchSet,
  readContractKind,
  readSchemaTag,
  resolveContractKind,
  resolveJobContractKind,
  readContractNonce,
  renderForKind,
  requiresContract,
  validateContract,
} from '../src/contract.js';
import { canonicalCwd } from '../src/grants.js';
import { describePathRule } from '../src/toolrules.js';
import { TOOL_PRESETS, resolveAllowedTools } from '../src/config.js';
import {
  PROPOSAL_INPUT_KEYS,
  PROPOSAL_KINDS,
  REMEDIES,
  TARGET_OPS,
} from '../src/proposals.js';
import { resolveOutgoingText } from '../src/mentions.js';
import { CONTRACT_TTL_MS, ContractStore, MAX_PENDING_CONTRACTS } from '../src/store.js';

/** touch 集合の判定は実体を見るので、本物のディレクトリを用意する */
const CWD = canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-contract-')));
mkdirSync(join(CWD, 'src'), { recursive: true });
mkdirSync(join(CWD, 'test'), { recursive: true });
for (const f of ['src/a.js', 'src/b.js', 'test/a.test.js']) {
  writeFileSync(join(CWD, f), '// x\n', 'utf8');
}

const DELEGATION = {
  body: '実装をお願いします。\n\n[[handoff:opus]]',
  background: '触れる範囲が規律でしか守られていない',
  purpose: 'touch 集合を実権限にする',
  touch_set: ['src/a.js', 'test/a.test.js'],
  acceptance: ['npm test が通る'],
  stop_conditions: ['touch 集合の外が必要になったら'],
};
const REPORT = {
  body: 'done',
  changed_files: ['src/a.js'],
  did: ['直した'],
  verification: 'npm test → 531 pass',
  remaining: [],
};
const PROPOSAL = {
  body: '巡回して 2 件起票した。\n\n[[handoff:fable]]',
  tasks: [
    { title: '状態バッジを足す', rationale: '一目で読める', touch: ['src/render/table.ts'] },
    {
      title: 'タイムラインを足す',
      rationale: '順序が追える',
      touch: ['src/timeline.ts', 'src/style.css'],
      job_budget: 8,
    },
  ],
};

// ---- スキーマ種別の宣言 ----

test('スキーマ種別は役割文の宣言で決まる (宣言が無ければ構造化しない)', () => {
  assert.equal(readContractKind('<!-- communitd-schema: delegation -->\n# Fable'), 'delegation');
  assert.equal(readContractKind('<!-- communitd-schema:report-->'), 'report');
  // 宣言なし = null。ここが null の job は完全に従来どおり動く。
  // 改名前の yobidashi-schema もここに入る — 移行は済んだので、もう構造化しない
  // (src/protocol.js と同じ理由。緩めて戻すと旧マーカーの役割文が黙って通る)
  const bads = ['', null, undefined, '# Fable', '<!-- communitd-schema: unknown -->',
    '<!-- yobidashi-schema: delegation -->\n# role', '<!-- yobidashi-schema: report -->\n# role'];
  for (const bad of bads) {
    assert.equal(readContractKind(bad), null, `拾ってはいけない: ${JSON.stringify(bad)}`);
  }
  // 本文中の言及は拾わない (先頭だけを見る)
  assert.equal(readContractKind(`${'x'.repeat(500)}<!-- communitd-schema: delegation -->`), null);
});

test('全スキーマが必須の本文 (body) を持つ (Discord へ出す唯一のフィールド)', () => {
  for (const kind of CONTRACT_KINDS) {
    const schema = SCHEMAS[kind];
    assert.ok(schema.required.includes('body'), `${kind} に body が無い`);
    assert.equal(schema.additionalProperties, false, `${kind} が余分なキーを許している`);
    assert.equal(schema.properties.body.type, 'string');
  }
});

test('スキーマのキーは ASCII だけ (日本語キーは API が 400 で弾く)', () => {
  // 実測 2026-08-02: 日本語のプロパティ名を渡すと
  // `400 ... input_schema.properties: Property keys should match pattern` になり、
  // structured_output が返らない。ここが緩むと構造化が丸ごと死ぬので固定する
  for (const kind of CONTRACT_KINDS) {
    for (const key of Object.keys(SCHEMAS[kind].properties)) {
      assert.match(key, /^[a-zA-Z0-9_-]+$/, `${kind}.${key} が ASCII ではない`);
      assert.ok(FIELD_LABELS[key], `${kind}.${key} に日本語の呼び名が無い`);
    }
  }
  // description は日本語でよい (制約はキーだけ)
  assert.match(SCHEMAS.delegation.properties.body.description, /本文/);
});

// ---- 検証 ----

test('必須フィールドの欠落・型違い・余分なキーを落とす', () => {
  assert.equal(validateContract('delegation', DELEGATION).ok, true);
  assert.equal(validateContract('report', REPORT).ok, true);

  const bad = [
    ['delegation', null, /オブジェクト/],
    ['delegation', { ...DELEGATION, body: undefined }, /本文/],
    ['delegation', { ...DELEGATION, body: '   ' }, /本文/],
    ['delegation', { ...DELEGATION, touch_set: 'src/a.js' }, /配列/],
    ['delegation', { ...DELEGATION, touch_set: [1, 2] }, /文字列/],
    ['delegation', { ...DELEGATION, touch_restricted: 'true' }, /true \/ false/],
    ['delegation', { ...DELEGATION, extra: 'x' }, /契約に無いキー/],
    ['report', { ...REPORT, verification: [] }, /文字列/],
    ['report', { ...REPORT, remaining: undefined }, /残課題/],
    ['unknown', DELEGATION, /未知のスキーマ種別/],
  ];
  for (const [kind, value, pattern] of bad) {
    const r = validateContract(kind, value);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(value)}`);
    assert.match(r.reason, pattern);
  }
});

test('長すぎるフィールドは黙って切らずに不適合にする', () => {
  // slice していた頃は、本文の末尾に置いた制御フッターが切り落とされて
  // **handoff が黙って消えた** (sol 指摘 2026-08-03)
  const long = `${'あ'.repeat(MAX_TEXT_CHARS)}\n\n[[handoff:opus]]`;
  const r = validateContract('delegation', { ...DELEGATION, body: long });
  assert.equal(r.ok, false, '切り詰めて通してしまっている');
  assert.match(r.reason, /長すぎます/);

  // 配列の件数・要素の長さも同じ
  assert.equal(
    validateContract('delegation', {
      ...DELEGATION, touch_set: Array.from({ length: MAX_ITEMS + 1 }, () => 'src/a.js'),
    }).ok, false,
  );
  assert.equal(
    validateContract('delegation', { ...DELEGATION, touch_set: ['x'.repeat(MAX_ITEM_CHARS + 1)] }).ok,
    false,
  );
  // 上限ちょうどは通す (境界で落とさない)
  const edge = validateContract('delegation', { ...DELEGATION, body: 'あ'.repeat(MAX_TEXT_CHARS) });
  assert.equal(edge.ok, true);
  assert.equal(edge.contract.body.length, MAX_TEXT_CHARS, '通したのに切っている');
});

test('スキーマ側にも同じ上限を書く (モデルが生成時点で守れる)', () => {
  for (const kind of CONTRACT_KINDS) {
    for (const [key, spec] of Object.entries(SCHEMAS[kind].properties)) {
      if (spec.type === 'string') {
        assert.equal(spec.maxLength, MAX_TEXT_CHARS, `${kind}.${key} に maxLength が無い`);
      } else if (spec.type === 'array') {
        assert.ok(Number.isSafeInteger(spec.maxItems), `${kind}.${key} に maxItems が無い`);
        assert.ok(spec.maxItems <= MAX_ITEMS, `${kind}.${key} の maxItems が上限を超えている`);
        if (spec.items.type === 'object') {
          // オブジェクトの配列は、要素の中の文字列 1 つずつに上限を書く
          for (const [k, sub] of Object.entries(spec.items.properties)) {
            if (sub.type !== 'string') continue;
            assert.equal(sub.maxLength, MAX_ITEM_CHARS, `${kind}.${key}[].${k} に maxLength が無い`);
          }
        } else {
          assert.equal(spec.items.maxLength, MAX_ITEM_CHARS, `${kind}.${key} の要素に maxLength が無い`);
        }
      }
    }
  }
});

test('説明文の件数と実際の上限を食い違わせない (やったこと = 3 件以内)', () => {
  // 「3 行以内」と書いたのに 100 件通ると、検査しているつもりで検査していない
  // (sol 指摘 2026-08-03)
  assert.equal(SCHEMAS.report.properties.did.maxItems, MAX_DID_ITEMS);
  assert.match(SCHEMAS.report.properties.did.description, new RegExp(`${MAX_DID_ITEMS} 件`));
  const over = Array.from({ length: MAX_DID_ITEMS + 1 }, (_, i) => `やった ${i}`);
  const r = validateContract('report', { ...REPORT, did: over });
  assert.equal(r.ok, false, '説明より多い件数を通している');
  assert.match(r.reason, /やったこと/);
  assert.equal(validateContract('report', { ...REPORT, did: over.slice(0, MAX_DID_ITEMS) }).ok, true);
  // 他のフィールドは従来どおり 100 件まで
  assert.equal(SCHEMAS.report.properties.remaining.maxItems, MAX_ITEMS);
});

test('外部 settings に制限が書かれていたら touch 制限の job を起動しない', () => {
  // touch 制限は --setting-sources '' で外部 settings を丸ごと落とす。allow だけを
  // 落とす指定が CLI に無いので、deny や拒否 hook も一緒に消えて権限が広がる
  // (sol 指摘 2026-08-03)。分類できない以上は起動しないのが「部分集合」の守り方
  const restrictive = [
    ['permissions.deny', { permissions: { deny: ['Edit'] } }],
    ['permissions.ask', { permissions: { ask: ['Bash'] } }],
    ['PreToolUse hook', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } }],
  ];
  for (const [what, settings] of restrictive) {
    const r = classifyExternalSettings([{ label: 'user settings', settings }]);
    assert.equal(r.ok, false, `落としてはいけない制限を見逃している: ${what}`);
    assert.match(r.reason, /制限/);
    assert.equal(r.restrictive.length, 1);
  }

  // 制限でないもの (許可・実行後 hook・空・読めなかった) は止めない
  for (const settings of [
    null, {}, { permissions: {} }, { permissions: { allow: ['Edit'] } },
    { permissions: { deny: [] } },
    { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } },
  ]) {
    assert.deepEqual(
      classifyExternalSettings([{ label: 'user settings', settings }]), { ok: true },
      `止めてはいけない: ${JSON.stringify(settings)}`,
    );
  }
  assert.deepEqual(classifyExternalSettings([]), { ok: true });

  // 管理者ポリシーは打ち消せないので、**存在するだけで**止める (中身は問わない)
  for (const settings of [null, {}, { model: 'opus' }, { permissions: { allow: ['Edit'] } }]) {
    const r = classifyExternalSettings([{ label: '管理者ポリシー', settings, managed: true }]);
    assert.equal(r.ok, false, `管理者ポリシーを見逃している: ${JSON.stringify(settings)}`);
    assert.match(r.restrictive[0], /管理者ポリシー/);
  }
  // どのファイルが原因かを名前で返す (作者が直せるように)
  const multi = classifyExternalSettings([
    { label: 'user settings', settings: { permissions: { deny: ['Edit'] } } },
    { label: 'project settings', settings: { permissions: { allow: ['Read'] } } },
  ]);
  assert.equal(multi.restrictive.length, 1);
  assert.match(multi.restrictive[0], /user settings/);
});

test('touch 制限は省略で有効・false のときだけ解除される', () => {
  assert.equal(isTouchRestricted(DELEGATION), true);
  assert.equal(isTouchRestricted({ ...DELEGATION, touch_restricted: true }), true);
  assert.equal(isTouchRestricted({ ...DELEGATION, touch_restricted: false }), false);
});

// ---- touch 集合 → 実権限 ----

const FULL = resolveAllowedTools({ tools: 'full' });

test('touch 集合は対象パスへの Edit だけになる (書込み経路を残さない)', () => {
  const n = narrowForTouchSet({ touchSet: ['src/a.js', 'src/b.js'], allowedTools: FULL, cwd: CWD });
  assert.equal(n.ok, true);
  assert.deepEqual(n.rules, ['Edit(./src/a.js)', 'Edit(./src/b.js)']);

  // 実測に基づく 5 点セット。どれか 1 つでも欠けると絞り込みが素通りする
  assert.equal(n.permissionMode, 'default', 'acceptEdits のままだと Edit(パス) が迂回される');
  assert.equal(n.strictMcp, true);
  // user settings の permissions.allow が --allowedTools に勝って権限を付与する (T0 §2.4)。
  // 実測 2026-08-03: `permissions.allow: ["Edit"]` を 1 行足すだけで touch 制限が破れた
  assert.equal(n.settingSources, '', '外部 settings を読ませたままにしている');
  for (const denied of NARROWED_DENY_TOOLS) {
    assert.ok(n.disallowedTools.includes(denied), `${denied} を明示的に落としていない`);
    assert.equal(n.tools.includes(denied), false, `${denied} が組み込みツールに残っている`);
    assert.equal(
      n.allowedTools.some((r) => r.split('(')[0] === denied), false,
      `${denied} が allowedTools に残っている`,
    );
  }
  // 裸の書込みツールは残らない (残ると全ファイルが対象になる)
  for (const rule of n.allowedTools) {
    assert.equal(['Edit', 'Write', 'NotebookEdit'].includes(rule), false, `裸の ${rule} が残っている`);
  }
  // 読み取りは残る (残さないと調査すらできない)
  assert.ok(n.allowedTools.includes('Read'));
  assert.ok(n.tools.includes('Read') && n.tools.includes('Edit'));

  // 参照ディレクトリ (--add-dir) は 1 つも開かない。読取専用にできない口なので、
  // 残すと touch 集合どころか作業ツリーの外へ書ける (sol 指摘 2026-08-03)
  assert.deepEqual(n.addDirs, [], 'cwd の外を開いたままにしている');
  assert.ok(n.warnings.some((w) => w.includes('参照ディレクトリ')), '開かないことを黙っている');
});

test('絞り込みは権限を増やさない (元の実効権限の部分集合)', () => {
  const base = resolveAllowedTools({ tools: 'standard' });
  const n = narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: base, cwd: CWD });
  assert.equal(n.ok, true);
  for (const rule of n.allowedTools) {
    // 追加されてよいのは touch 集合のパス限定ルールだけ
    if (n.rules.includes(rule)) continue;
    assert.ok(base.includes(rule), `元の権限に無いルールが増えている: ${rule}`);
  }
  for (const tool of n.tools) {
    assert.ok(
      base.some((r) => r.split('(')[0] === tool),
      `元の権限に無いツールが --tools へ増えている: ${tool}`,
    );
  }
});

test('パス限定の権限を別パスへ広げない (包含は証明できないので完全一致だけ)', () => {
  // 元が `Edit(./src/a.js)` だけのチャンネルで `test/a.test.js` を touch 集合に書いても、
  // そこへの書込みを新規付与してはいけない (sol 指摘 2026-08-03: 実際に付与されていた)
  const base = ['Read', 'Edit(./src/a.js)'];
  const n = narrowForTouchSet({
    touchSet: ['src/a.js', 'test/a.test.js'], allowedTools: base, cwd: CWD,
  });
  assert.equal(n.ok, true);
  assert.deepEqual(n.rules, ['Edit(./src/a.js)'], '元の権限に無いパスへ広げている');
  assert.deepEqual(n.allowedTools.filter((r) => r.startsWith('Edit')), ['Edit(./src/a.js)']);
  const denied = n.rejected.find((r) => r.path === 'test/a.test.js');
  assert.ok(denied, '広げられなかったことを黙って落としている');
  assert.match(denied.reason, /権限/);

  // 元が裸の Edit を持つなら、touch 集合のどれへ絞っても「狭める」側にしかならない
  const bare = narrowForTouchSet({
    touchSet: ['src/a.js', 'test/a.test.js'], allowedTools: ['Read', 'Edit'], cwd: CWD,
  });
  assert.deepEqual(bare.rules, ['Edit(./src/a.js)', 'Edit(./test/a.test.js)']);
});

test('plan (読取専用) を default へ上げない・未知のモードでは起動しない', () => {
  // plan を default へ「狭める」と、読めるだけだった job が書けるようになる
  // (sol 指摘 2026-08-03: 実際に昇格していた)
  const plan = narrowForTouchSet({
    touchSet: ['src/a.js'], allowedTools: FULL, cwd: CWD, permissionMode: 'plan',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.permissionMode, 'plan', '読取専用モードを書込み可へ上げている');
  assert.deepEqual(plan.rules, [], 'plan なのに書込みルールを作っている');
  assert.equal(plan.tools.includes('Edit'), false);
  assert.ok(plan.warnings.some((w) => w.includes('plan')));

  // acceptEdits / bypassPermissions は default へ狭める (絞る向き)
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
    const n = narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: FULL, cwd: CWD, permissionMode: mode });
    assert.equal(n.permissionMode, 'default', `${mode} を default へ落としていない`);
  }
  // 安全性を証明できないモードでは起動しない
  for (const mode of ['auto', 'unknown', '', null]) {
    const n = narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: FULL, cwd: CWD, permissionMode: mode });
    assert.equal(n.ok, false, `通してはいけないモード: ${JSON.stringify(mode)}`);
    assert.match(n.reason, /permissionMode/);
  }
});

test('touch 集合に新規ファイルは書けない (Edit は既存ファイル専用)', () => {
  // 通すと「編集できる」と案内しておいて実際には何もできない。
  // 新規作成には Write が要るが、touch 制限中の Write は落としてある
  const n = narrowForTouchSet({ touchSet: ['src/a.js', 'src/new.js'], allowedTools: FULL, cwd: CWD });
  assert.deepEqual(n.rules, ['Edit(./src/a.js)']);
  const rejected = n.rejected.find((r) => r.path === 'src/new.js');
  assert.ok(rejected, '新規パスを黙って通している');
  assert.match(rejected.reason, /存在しない|新規作成/);

  // 承認候補の側は従来どおり新規パスも出す (人間が config.json へ貼る用途)
  assert.equal(describePathRule('Edit', 'src/new.js', CWD).ok, true);
  assert.equal(describePathRule('Edit', 'src/new.js', CWD, { mustExist: true }).ok, false);
});

test('書込み権限はあるが touch 集合と 1 件も重ならなければ起動しない', () => {
  // 「絞ったのに何も書けない job」を黙って走らせず、理由を見せて止める
  const n = narrowForTouchSet({
    touchSet: ['test/a.test.js'], allowedTools: ['Read', 'Edit(./src/a.js)'], cwd: CWD,
  });
  assert.equal(n.ok, false);
  assert.match(n.reason, /書込み権限に含まれません/);
  assert.equal(n.rejected.length, 1);
});

test('元が読み取り専用なら touch 集合があっても書込みは付かない', () => {
  const n = narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: TOOL_PRESETS.readonly, cwd: CWD });
  assert.equal(n.ok, true);
  assert.equal(n.allowedTools.some((r) => r.startsWith('Edit')), false, '契約が書込みを付与している');
  assert.equal(n.tools.includes('Edit'), false);
  assert.ok(n.warnings.some((w) => w.includes('書込み')), '増やせないことを黙って落としている');
});

test('1 ファイルに絞れないパスは絞り込みに使わない', () => {
  const outside = [
    'src/*.js', 'src/**', 'src', '.', '../etc/passwd', '/etc/passwd', 'C:/Windows/x.js',
    'src/../../x.js', '  src/a.js', '.env', 'src/a[1].js', '',
  ];
  const n = narrowForTouchSet({ touchSet: [...outside, 'src/a.js'], allowedTools: FULL, cwd: CWD });
  assert.equal(n.ok, true);
  assert.deepEqual(n.rules, ['Edit(./src/a.js)'], `絞りに使ってはいけない指定が通った: ${n.rules}`);
  assert.equal(n.rejected.length, outside.length);
  for (const r of n.rejected) assert.ok(r.reason, `理由が空: ${r.path}`);
  assert.ok(n.warnings.some((w) => w.includes('編集できません')));
});

test('1 件も絞り込めなければ job を起動させない (fail-open にしない)', () => {
  for (const touchSet of [[], ['src/*.js'], ['../outside.js'], 'src/a.js']) {
    const n = narrowForTouchSet({ touchSet, allowedTools: FULL, cwd: CWD });
    assert.equal(n.ok, false, `起動させてはいけない: ${JSON.stringify(touchSet)}`);
    assert.ok(n.reason);
  }
  // cwd を解決できない job も同じ (照合できない絞り込みは使わない)
  assert.equal(narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: FULL, cwd: null }).ok, false);
});

test('同じパスを 2 度書いてもルールは 1 つ', () => {
  const n = narrowForTouchSet({ touchSet: ['src/a.js', './src/a.js'], allowedTools: FULL, cwd: CWD });
  assert.deepEqual(n.rules, ['Edit(./src/a.js)']);
});

// ---- 束縛と持ち回り ----

const bound = (over = {}) => bindContract({
  id: 'c-1', nonce: 'aaaaaaaa', kind: 'delegation', contract: DELEGATION, threadId: 'T1',
  fromBotKey: 'fable', toBotKey: 'opus', cwd: CWD, channelName: 'dev', at: '2026-08-02T00:00:00Z',
  ...over,
});
const job = (over = {}) => ({
  botKey: 'opus', threadId: 'T1', cwd: CWD, triggeredByBotKey: 'fable', ...over,
});

test('契約は thread・委譲元・宛先・作業ディレクトリへ束縛される', () => {
  assert.equal(contractFor(bound(), job()).ok, true);
  // 束縛が 1 つでも噛み合わなければ使わない (別の担当・別スレッドへ流用しない)
  const mismatches = [
    [{ botKey: 'sol' }, /別の担当/],
    [{ threadId: 'T9' }, /別スレッド/],
    [{ cwd: `${CWD}/other` }, /作業ディレクトリ/],
    [{ triggeredByBotKey: 'sol' }, /委譲元/],
    [{ triggeredByBotKey: null }, /委譲元/], // 人間が直接呼んだ job
  ];
  for (const [over, pattern] of mismatches) {
    const r = contractFor(bound(), job(over));
    assert.equal(r.ok, false, `流用してはいけない: ${JSON.stringify(over)}`);
    assert.match(r.reason, pattern);
  }
  assert.equal(contractFor(null, job()).ok, false);
  assert.equal(contractFor({ ...bound(), kind: 'report' }, job()).ok, false);
});

test('touch 制限つきの委譲は codex ランタイムへ渡さない (Fable → Sol)', () => {
  // codex の権限は read-only / workspace-write の 2 値でパス単位に絞れない。
  // 渡すと「絞ったつもりで作業ツリー全体を書ける」になる (sol 指摘 2026-08-03)
  const denied = canDelegateTo('delegation', DELEGATION, 'codex');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /codex/);
  assert.match(denied.reason, /touch 制限を解除|claude ランタイム/);

  // 制限を外した委譲は渡してよい (権限ではなく依頼文の構造化にすぎない)
  assert.deepEqual(
    canDelegateTo('delegation', { ...DELEGATION, touch_restricted: false }, 'codex'), { ok: true },
  );
  // claude 宛は従来どおり
  assert.deepEqual(canDelegateTo('delegation', DELEGATION, 'claude'), { ok: true });
  assert.deepEqual(canDelegateTo('delegation', DELEGATION, undefined), { ok: true });
  // 報告は権限を持たないのでどの担当へでも渡せる (検収の照合材料)
  assert.deepEqual(canDelegateTo('report', REPORT, 'codex'), { ok: true });
});

test('契約を本体の cwd で束縛すれば、作業ツリーで走る相手との間でも通る', () => {
  // §8-2 の worktree 分離で、worker は .worktrees/task-N・reviewer は本体、と cwd が
  // 分かれた。ブリッジは契約を本体へ寄せて保存する (index.js の contractCwd) —
  // 寄せないと worker が保存した契約を reviewer が取り出せず、レビュー job が起動しない
  // ままタスクが review に残る (Sol 指摘 2026-08-28)
  const worktree = `${CWD}/.worktrees/task-9`;
  const entry = bound({ cwd: CWD });
  assert.equal(contractFor(entry, job({ cwd: CWD })).ok, true, '本体で走る受け手が取り出せない');
  // **照合そのものは緩めない** — 本体で束縛した契約は、作業ツリーの cwd で来たら別物
  assert.equal(contractFor(entry, job({ cwd: worktree })).ok, false, 'cwd の照合が緩んでいる');
});

test('束縛に足りない情報があれば契約を作らない', () => {
  for (const over of [
    { kind: 'unknown' }, { threadId: '' }, { fromBotKey: '' }, { toBotKey: '' },
    { cwd: '' }, { contract: null }, { id: '' }, { id: undefined },
  ]) {
    assert.equal(bindContract({ ...bound(), ...over }), null, `作ってはいけない: ${JSON.stringify(over)}`);
  }
});

test('報告も同じ形で束縛して持ち回る (検収がフィールド照合になる)', () => {
  const entry = bindContract({
    id: 'r-1', nonce: 'bbbbbbbb', kind: 'report', contract: REPORT, threadId: 'T1',
    fromBotKey: 'opus', toBotKey: 'fable', cwd: CWD, at: '2026-08-03T00:00:00Z',
  });
  assert.equal(entry.kind, 'report');
  const r = contractFor(entry, {
    botKey: 'fable', threadId: 'T1', cwd: CWD, triggeredByBotKey: 'opus',
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'report');
  assert.deepEqual(r.contract.changed_files, ['src/a.js']);
  // 束縛は委譲と同じ規則 (別の担当・人間起動には流用しない)
  assert.equal(contractFor(entry, { botKey: 'sol', threadId: 'T1', cwd: CWD, triggeredByBotKey: 'opus' }).ok, false);
  assert.equal(contractFor(entry, { botKey: 'fable', threadId: 'T1', cwd: CWD, triggeredByBotKey: null }).ok, false);
});

test('報告ブロックは自己申告であることと突き合わせ先を書く', () => {
  const text = renderForKind('report', REPORT);
  assert.match(text, /src\/a\.js/);
  assert.match(text, /自己申告/);
  assert.match(text, /git status 差分/, '検収の機械的な照合先を書いていない');
  // 種別で描き分ける (委譲は依頼ブロック)
  assert.match(renderForKind('delegation', DELEGATION), /委譲契約/);
  assert.equal(renderForKind('unknown', REPORT), '');
});

test('保存後に壊れた契約は使わない (読むたびに検証する)', () => {
  const broken = { ...bound(), contract: { ...DELEGATION, touch_set: 'src/a.js' } };
  const r = contractFor(broken, job());
  assert.equal(r.ok, false);
  assert.match(r.reason, /壊れています/);
});

// ---- プロンプトへの描画 ----

test('契約ブロックは受入基準を実行しないことと、実際の書込み範囲を書く', () => {
  const n = narrowForTouchSet({ touchSet: ['src/a.js'], allowedTools: FULL, cwd: CWD });
  const text = renderForKind('delegation', DELEGATION, n);
  assert.match(text, /npm test が通る/);
  assert.match(text, /コマンドとして\*\*実行することはない\*\*|実行することはない/);
  assert.match(text, /Edit\(\.\/src\/a\.js\)/);
  // 実行文脈の「ファイル権限」行と同じ範囲を指していることを明示する
  // (describeWriteAccess が Edit(パス) を読むようになったので、食い違いはもう無い)
  assert.match(text, /実行文脈/);
  assert.equal(text.includes('「読み取り専用」と出る'), false);
  assert.match(text, /touch 制限が有効/);
});

test('touch 制限を解除した契約はその旨を書く', () => {
  const text = renderForKind('delegation', { ...DELEGATION, touch_restricted: false });
  assert.match(text, /touch 制限は解除されている/);
  assert.equal(text.includes('touch 制限が有効'), false);
});

test('絞り込めなかった指定は契約ブロックにも出す (黙って落とさない)', () => {
  const n = narrowForTouchSet({ touchSet: ['src/a.js', 'src/*.js'], allowedTools: FULL, cwd: CWD });
  const text = renderForKind('delegation', DELEGATION, n);
  assert.match(text, /src\/\*\.js/);
  assert.match(text, /パターン文字/);
});

// ---- 本文の配送 (制御フッターが従来どおり発火すること) ----

const OUT_CTX = {
  selfBotKey: 'fable',
  bots: [{ key: 'opus', displayName: 'Opus', userId: 'U-OPUS', inRoster: true }],
  owner: { userId: 'U-OWNER', names: ['So'] },
};

test('本文の末尾に置いた制御フッターは従来どおり発火する', () => {
  // 構造化しても投稿されるのは `本文` なので、抽出は同じ経路を通る。
  // ここが落ちると「委譲したのに相手が起動しない」に戻る (プロトコル移行時の事故)
  const checked = validateContract('delegation', DELEGATION);
  assert.equal(checked.ok, true);
  const outgoing = resolveOutgoingText(bodyOf(checked.contract), OUT_CTX);
  assert.equal(outgoing.mention?.userId, 'U-OPUS', 'handoff が発火していない');
  assert.equal(outgoing.body.includes('[[handoff:opus]]'), false, 'マーカー行が本文に残っている');
  assert.match(outgoing.body, /実装をお願いします/);
});

test('本文の中のフッターも 1 通 1 個の規則がそのまま効く', () => {
  const two = resolveOutgoingText('報告です\n\n[[handoff:opus]]\n[[notify:owner]]', OUT_CTX);
  assert.equal(two.mention, null, '2 個書いたのに実行されている');
  assert.ok(two.warnings.length > 0);
  const owner = resolveOutgoingText('裁定をお願いします\n\n[[notify:owner]]', OUT_CTX);
  assert.equal(owner.mention?.userId, 'U-OWNER');
});


// ---- 契約ストア ----

const storeFile = () => join(mkdtempSync(join(tmpdir(), 'communitd-cstore-')), 'contracts.json');

/** bound() の at から 1 時間後 */
const NOW = Date.parse('2026-08-02T01:00:00Z');

/** 読みやすいラベル → 制御メッセージへ載せられる形式の nonce */
const nonceOf = (label) => Buffer.from(String(label)).toString('hex').padEnd(8, '0').slice(0, 16);

/**
 * その handoff の制御メッセージに載る nonce つきで契約を積む。
 * **now を固定して渡す** — push は期限切れを掃除するので、実時刻に任せると
 * 固定の `at` を持つテスト用契約が日付をまたいだ日から突然消える (時刻依存のテストになる)
 */
function pushBound(store, { id, msgId, over = {} }) {
  store.push('T1', 'opus', bound({ id, nonce: nonceOf(msgId), ...over }), { now: NOW });
}

/** その制御メッセージで起動した job による claim */
const claimBy = (store, msgId, over = {}) => store.claim('T1', 'opus', {
  fromBotKey: 'fable', nonce: nonceOf(msgId), now: NOW, ...over,
});

test('契約ストアは宛先ごとの FIFO キュー (連続委譲が上書きされない)', () => {
  // 単一値だと、同じ相手へ続けて委譲したとき後の契約が前を上書きし、
  // **1 本目の job に 2 本目の契約が効く** (job はキューで待つ — sol 指摘 2026-08-03)
  const file = storeFile();
  const store = new ContractStore(file);
  pushBound(store, { id: 'c-1', msgId: 'M1' });
  pushBound(store, {
    id: 'c-2', msgId: 'M2', over: { contract: { ...DELEGATION, touch_set: ['src/b.js'] } },
  });

  // どの handoff で起動したかで受け取る契約が決まる
  assert.equal(claimBy(store, 'M1').id, 'c-1', '別の handoff の契約を渡している');
  assert.equal(claimBy(store, 'M2').id, 'c-2');
  assert.equal(claimBy(store, 'M1'), null);

  // 別スレッド・別担当には出てこない (束縛はここでも効く)
  pushBound(store, { id: 'c-3', msgId: 'M3' });
  const key = { fromBotKey: 'fable', nonce: nonceOf('M3'), now: NOW };
  assert.equal(store.claim('T2', 'opus', key), null);
  assert.equal(store.claim('T1', 'sol', key), null);
  // 再読み込みしても残る (承認台帳と違い、契約は再起動をまたぐ)
  assert.equal(new ContractStore(file).claim('T1', 'opus', key).id, 'c-3');
});

test('起動しなかった handoff の契約は、次の handoff に流用されない', () => {
  // 制御メッセージが hop 上限・停止中で job にならないことがある。送信元 bot だけの
  // 束縛だと、次の同じ送信元からの handoff が古い契約を消費する (sol 指摘 2026-08-03)
  const store = new ContractStore(storeFile());
  pushBound(store, { id: 'orphan', msgId: 'M-dead' }); // この handoff は起動しなかった
  pushBound(store, { id: 'live', msgId: 'M-live' });

  assert.equal(claimBy(store, 'M-live').id, 'live', '古い契約を掴んでいる');
  // 起動しなかった分は残るが、対応するメッセージが二度と来ないので誰も掴めない
  assert.deepEqual(store.list('T1', 'opus').map((e) => e.id), ['orphan']);
});

test('nonce は投稿より前に確定する (受信が先行しても取りこぼさない)', () => {
  // 投稿後にメッセージ ID を書き戻す形だと、受け手の MessageCreate が書き戻しより
  // 先に届いたときに claim が null になり、契約なし = touch 制限なしで起動した
  // (sol 指摘 2026-08-03)。nonce を先に決めれば順序に関係なく結び付く
  assert.equal(bindContract({ ...bound(), nonce: undefined }), null, 'nonce 無しで契約を作っている');
  assert.equal(bindContract({ ...bound(), nonce: '' }), null);
  assert.equal(bindContract({ ...bound(), nonce: 'ZZZZ' }), null, 'タグにできない nonce を通している');

  // 保存された契約は、投稿する制御メッセージのタグと同じ nonce を持つ
  const entry = bound({ id: 'c-1', nonce: 'a1b2c3d4' });
  const tag = formatContractTag(entry.nonce);
  assert.equal(tag, '`契約:a1b2c3d4`');
  assert.equal(readContractNonce(`<@U1>\n${tag}`), 'a1b2c3d4');

  const store = new ContractStore(storeFile());
  store.push('T1', 'opus', entry);
  // 受け手はタグから読んだ nonce で引く (メッセージ ID の書き戻しを待たない)
  const claimKey = { fromBotKey: 'fable', nonce: readContractNonce(`<@U1>\n${tag}`), now: NOW };
  assert.equal(store.claim('T1', 'opus', claimKey).id, 'c-1');
});

test('契約タグが付いた handoff で契約が無ければ起動させない (fail-closed)', () => {
  // 保存に失敗した・期限切れ・取り消された契約を「契約なしの handoff」と
  // 取り違えると、touch 制限が黙って外れる
  assert.equal(requiresContract('<@U1>\n`契約:a1b2c3d4`'), true);
  assert.equal(requiresContract('<@U1>'), false, 'タグ無しを契約つきと誤判定している');
  assert.equal(requiresContract(''), false);
  assert.equal(requiresContract(null), false);
  // 壊れたタグは契約つき扱いにしない (起動を止める理由にならない)
  assert.equal(requiresContract('<@U1>\n`契約:xyz`'), false);
  assert.equal(formatContractTag('xyz'), '', 'タグにできない値を書き出している');
});

test('人間が直接呼んだ job はストアに触れない (handoff job の契約を消さない)', () => {
  // Fable 実行中に人間が Opus を直接呼ぶと、人間 job が先に走る。
  // ここで契約を消費・破棄すると、続く本来の handoff job が契約なし =
  // touch 制限なしで起動する (sol 指摘 2026-08-03)
  for (const bad of [{ triggeredByBotKey: null }, { triggeredByBotKey: '' }, {}]) {
    assert.equal(consumableBy(bad), null, `ストアを触ろうとしている: ${JSON.stringify(bad)}`);
  }
  const match = consumableBy({ triggeredByBotKey: 'fable' });
  assert.equal(typeof match, 'function');
  assert.equal(match({ fromBotKey: 'fable' }), true);
  assert.equal(match({ fromBotKey: 'sol' }), false);

  // 送信元が違う job も掴めない (掴めないだけで、契約は残る)
  const store = new ContractStore(storeFile());
  pushBound(store, { id: 'c-1', msgId: 'M1' });
  assert.equal(claimBy(store, 'M1', { fromBotKey: 'sol' }), null);
  assert.deepEqual(store.list('T1', 'opus').map((e) => e.id), ['c-1'], '契約が消えている');
  assert.equal(claimBy(store, 'M1').id, 'c-1');
});

test('受付時に claim すれば、取り消された job の契約が居座らない', () => {
  // 契約を job 開始時まで残すと、待機中に /stop・/restart force で取り消された job の
  // 契約がストアに居座り、次の handoff がそれを消費して対応がずれる
  // (role 読込失敗など、契約消費前に終わる経路でも同じ — sol 指摘 2026-08-03)
  const store = new ContractStore(storeFile());
  pushBound(store, { id: 'old', msgId: 'M1' });
  assert.equal(claimBy(store, 'M1').id, 'old'); // 受付の時点で claim
  assert.deepEqual(store.list('T1', 'opus'), [], '受付後もストアに残っている');

  // その job が /stop で取り消される → 契約は job と一緒に捨てられる
  pushBound(store, { id: 'new', msgId: 'M2' });
  assert.equal(claimBy(store, 'M2').id, 'new', '取り消された job の契約を消費している');
});

test('契約ストアは配送に失敗した 1 件だけを取り消せる', () => {
  const store = new ContractStore(storeFile());
  pushBound(store, { id: 'c-1', msgId: 'M1' });
  pushBound(store, { id: 'c-2', msgId: 'M2' });
  // 宛先ごと消すと、同じ相手宛の他の未消費契約まで巻き添えになる
  assert.equal(store.removeById('T1', 'opus', 'c-2'), true);
  assert.equal(store.removeById('T1', 'opus', 'c-2'), false);
  assert.deepEqual(store.list('T1', 'opus').map((e) => e.id), ['c-1']);
});

test('未消費契約が上限に達したら、古い方を捨てず新しい保存を失敗させる', () => {
  // 捨てられる契約に対応する handoff は**既に配送済み**。捨てると 1 本目の job が
  // 2 本目の契約を受け取り、以降ずっと対応がずれる (sol 指摘 2026-08-03)。
  // 新しい handoff の方を止めるのが正しい向き
  const store = new ContractStore(storeFile());
  for (let i = 1; i <= MAX_PENDING_CONTRACTS; i++) {
    pushBound(store, { id: `c-${i}`, msgId: `M${i}` });
  }
  assert.throws(() => store.push('T1', 'opus', bound({ id: 'c-new' }), { now: NOW }), /上限/);
  assert.deepEqual(
    store.list('T1', 'opus').map((e) => e.id),
    Array.from({ length: MAX_PENDING_CONTRACTS }, (_, i) => `c-${i + 1}`),
  );
  // 1 件消化すれば、また積める
  assert.equal(claimBy(store, 'M1').id, 'c-1');
  store.push('T1', 'opus', bound({ id: 'c-new' }));
  assert.equal(store.list('T1', 'opus').at(-1).id, 'c-new');
});

test('期限切れで埋まったキューは新しい保存で解ける (閉塞しない)', () => {
  // 掃除を claim 側だけに置くと、起動しなかった handoff の契約が上限まで溜まった時点で
  // 「新しい handoff を送れない → claim も起きない → 掃除されない」で詰まる
  // (sol 指摘 2026-08-03)
  const store = new ContractStore(storeFile());
  for (let i = 1; i <= MAX_PENDING_CONTRACTS; i++) {
    pushBound(store, { id: `stale-${i}`, msgId: `M${i}` });
  }
  const later = NOW + CONTRACT_TTL_MS + 1;
  // 期限切れ 5 件 + 新規 1 件 = 保存できる (古い方は上限判定の前に掃除される)
  store.push('T1', 'opus', bound({ id: 'fresh', nonce: nonceOf('M-new'), at: new Date(later).toISOString() }),
    { now: later });
  assert.deepEqual(store.list('T1', 'opus').map((e) => e.id), ['fresh'], '期限切れが残って閉塞している');
});

test('期限切れの契約は claim のときにも掃除する (キューを埋めない)', () => {
  // 起動しなかった handoff の契約を残したままにすると、上限に達して
  // 新しい委譲が保存できなくなる
  const store = new ContractStore(storeFile());
  pushBound(store, { id: 'stale', msgId: 'M-old' });
  pushBound(store, { id: 'fresh', msgId: 'M-new', over: { at: '2026-08-02T00:30:00Z' } });

  // stale は 60 分前・fresh は 30 分前。上限 45 分なら stale だけが落ちる
  const ttlMs = 45 * 60 * 1000;
  assert.equal(claimBy(store, 'M-new', { ttlMs }).id, 'fresh');
  assert.deepEqual(store.list('T1', 'opus'), [], '期限切れが残っている');
  // 既定の上限は 24 時間 (委譲から丸 1 日消費されないなら、その handoff は起動しなかった)
  assert.equal(CONTRACT_TTL_MS, 24 * 60 * 60 * 1000);

  // 保存時刻を読めない契約も溜めない
  const broken = new ContractStore(storeFile());
  broken.push('T1', 'opus', { ...bound({ id: 'broken' }), at: 'いつか' });
  assert.equal(broken.sweep('T1', 'opus', { now: NOW }), 1);
  assert.deepEqual(broken.list('T1', 'opus'), []);
});

// ---- resolveContractKind (役割文の宣言 × チャンネル設定 × ランタイム) ----

const DECLARED = '<!-- communitd-schema: report -->\n# Opus';

test('resolveContractKind: 宣言があり claude・構造化有効なら宣言どおり', () => {
  assert.equal(resolveContractKind({ roleText: DECLARED }), 'report');
  assert.equal(resolveContractKind({ roleText: DECLARED, runtime: 'claude' }), 'report');
  assert.equal(
    resolveContractKind({ roleText: DECLARED, structuredOutput: true }),
    'report',
  );
});

test('resolveContractKind: チャンネルが切っていれば宣言があっても null', () => {
  assert.equal(
    resolveContractKind({ roleText: DECLARED, structuredOutput: false }),
    null,
    'structuredOutput: false が効いていない',
  );
});

test('resolveContractKind: codex は宣言があっても null (--json-schema を持たない)', () => {
  assert.equal(resolveContractKind({ roleText: DECLARED, runtime: 'codex' }), null);
  // 切っていない codex でも同じ
  assert.equal(
    resolveContractKind({ roleText: DECLARED, runtime: 'codex', structuredOutput: true }),
    null,
  );
});

test('resolveContractKind: 宣言が無ければ設定に関わらず null', () => {
  for (const structuredOutput of [true, false, undefined]) {
    assert.equal(resolveContractKind({ roleText: '# Opus', structuredOutput }), null);
  }
});

test('task-proposal: 役割文が宣言すればその種別になる (既存の切り口はそのまま)', () => {
  const role = '<!-- communitd-protocol: 2 -->\n<!-- communitd-schema: task-proposal -->\n# Opus — スカウト';
  assert.equal(readContractKind(role), 'task-proposal');
  assert.equal(resolveContractKind({ roleText: role }), 'task-proposal');
  // codex・structuredOutput: false で切れるのは他の種別と同じ
  assert.equal(resolveContractKind({ roleText: role, runtime: 'codex' }), null);
  assert.equal(resolveContractKind({ roleText: role, structuredOutput: false }), null);
  // ハイフンを許しても知らない綴りは通さない
  for (const bad of ['task-proposals', 'task-', '-', 'proposal']) {
    assert.equal(readContractKind(`<!-- communitd-schema: ${bad} -->`), null, bad);
  }
  // 既存の宣言は従来どおり
  assert.equal(readContractKind('<!-- communitd-schema:report-->'), 'report');
});

test('task-proposal: 正常系 (0 件・複数件・job_budget の省略と指定)', () => {
  const none = validateContract('task-proposal', { body: '今回は起票なし', tasks: [] });
  assert.equal(none.ok, true, '起票なしを不適合にしている');
  assert.deepEqual(none.contract.tasks, []);

  const many = validateContract('task-proposal', PROPOSAL);
  assert.equal(many.ok, true);
  assert.deepEqual(many.contract, PROPOSAL, '通したのに中身が変わっている');
  assert.equal(many.contract.tasks[0].job_budget, undefined, '省略した job_budget を勝手に埋めている');
  assert.equal(many.contract.tasks[1].job_budget, 8);

  // 上限ちょうどは通す (境界で落とさない)
  const edge = validateContract('task-proposal', {
    body: 'ok',
    tasks: Array.from(
      { length: MAX_PROPOSED_TASKS },
      (_, i) => ({ title: `t${i}`, rationale: 'r', touch: [`src/t${i}.ts`] }),
    ),
  });
  assert.equal(edge.ok, true);
  assert.equal(edge.contract.tasks.length, MAX_PROPOSED_TASKS);
});

test('task-proposal: 異常系は不適合にして、何件目が悪いかを返す', () => {
  const task = (over = {}) => ({ title: 'タイトル', rationale: '理由', touch: ['src/a.ts'], ...over });
  const bad = [
    [{ body: 'x' }, /起票するタスク/],
    [{ body: 'x', tasks: 'なし' }, /配列/],
    [{ ...PROPOSAL, body: '  ' }, /本文/],
    [{ body: 'x', tasks: [task(), 'まだある'] }, /2 件目 がオブジェクトではありません/],
    [{ body: 'x', tasks: [task({ title: '' })] }, /1 件目: タイトル が空です/],
    [{ body: 'x', tasks: [task(), task({ rationale: '   ' })] }, /2 件目: 理由 が空です/],
    [{ body: 'x', tasks: [{ rationale: '理由', touch: ['src/a.ts'] }] }, /1 件目: タイトル がありません/],
    [{ body: 'x', tasks: [{ title: 'タイトル', touch: ['src/a.ts'] }] }, /1 件目: 理由 がありません/],
    // touch は必須で、空配列も通さない (§3.9 — 宣言の無いタスクが発議を全件止める)
    [{ body: 'x', tasks: [{ title: 'タイトル', rationale: '理由' }] }, /1 件目: touch集合 がありません/],
    [{ body: 'x', tasks: [task({ touch: [] })] }, /1 件目: touch集合 は 1 件以上書きます/],
    [{ body: 'x', tasks: [task({ touch: 'src/a.ts' })] }, /1 件目: touch集合 は配列で書きます/],
    [{ body: 'x', tasks: [task({ touch: [''] })] }, /1 件目: touch集合 の要素は空でない文字列/],
    [{ body: 'x', tasks: [task({ touch: [42] })] }, /1 件目: touch集合 の要素は空でない文字列/],
    [
      { body: 'x', tasks: [task({ touch: ['あ'.repeat(MAX_ITEM_CHARS + 1)] })] },
      /1 件目: touch集合 の要素が長すぎます/,
    ],
    [{ body: 'x', tasks: [task({ title: 42 })] }, /1 件目: タイトル は文字列で書きます/],
    [{ body: 'x', tasks: [task({ note: 'おまけ' })] }, /1 件目: 契約に無いキー/],
    [{ body: 'x', tasks: [task({ title: 'あ'.repeat(MAX_ITEM_CHARS + 1) })] }, /1 件目: タイトル が長すぎます/],
    [{ ...PROPOSAL, extra: 'x' }, /契約に無いキー/],
  ];
  for (const [value, pattern] of bad) {
    const r = validateContract('task-proposal', value);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(value)}`);
    assert.match(r.reason, pattern);
  }

  // 6 件以上は上限で落とす (1 回の巡回で承認待ちの山を作らせない)
  const over = validateContract('task-proposal', {
    body: 'x',
    tasks: Array.from({ length: MAX_PROPOSED_TASKS + 1 }, () => task()),
  });
  assert.equal(over.ok, false);
  assert.match(over.reason, /起票するタスク の要素が多すぎます/);

  // job_budget は 1 以上の整数だけ
  for (const job_budget of [0, -1, 1.5, '3', null, true, NaN, Infinity]) {
    const r = validateContract('task-proposal', { body: 'x', tasks: [task({ job_budget })] });
    assert.equal(r.ok, false, `job_budget=${JSON.stringify(job_budget)} を通している`);
    assert.match(r.reason, /1 件目: job予算 は 1 以上の整数で書きます/);
  }
});

test('task-proposal: スキーマの形と説明文が実際の上限と食い違わない', () => {
  const schema = SCHEMAS['task-proposal'];
  assert.deepEqual(schema.required, ['body', 'tasks']);
  assert.equal(schema.properties.tasks.maxItems, MAX_PROPOSED_TASKS);
  assert.match(schema.properties.tasks.description, new RegExp(`${MAX_PROPOSED_TASKS} 件`));

  const items = schema.properties.tasks.items;
  assert.equal(items.additionalProperties, false, '要素が余分なキーを許している');
  assert.deepEqual(items.required, ['title', 'rationale', 'touch']);
  assert.equal(items.properties.job_budget.minimum, 1);
  // touch は 1 件以上 (空配列を通すと「宣言したつもりで宣言されていない」タスクができる)
  assert.equal(items.properties.touch.minItems, 1);
  assert.equal(items.properties.touch.items.maxLength, MAX_ITEM_CHARS);
  // 要素の中のキーも ASCII で、日本語の呼び名を持つ (エラー文が読めなくなる)
  for (const key of Object.keys(items.properties)) {
    assert.match(key, /^[a-zA-Z0-9_-]+$/, `tasks[].${key} が ASCII ではない`);
    assert.ok(FIELD_LABELS[key], `tasks[].${key} に日本語の呼び名が無い`);
  }
});

test('task-proposal: bodyOf は本文を返し、renderForKind は承認する側の一覧を作る', () => {
  assert.equal(bodyOf(PROPOSAL), PROPOSAL.body);

  const block = renderForKind('task-proposal', PROPOSAL);
  assert.match(block, /起票されたタスク案/);
  assert.match(block, /1\. 状態バッジを足す/);
  assert.match(block, /2\. タイムラインを足す \/ job 予算 8/);
  assert.match(block, /一目で読める/);
  assert.match(block, /承認するまで着手されない/);
  assert.equal(block.includes(PROPOSAL.body), false, '本文は Discord へ出す面なのでブロックに混ぜない');

  // 0 件でも黙って空にしない (「起票なし」と読める)
  assert.match(renderForKind('task-proposal', { body: 'x', tasks: [] }), /今回は起票なし/);
  assert.equal(renderForKind('task-proposal', null), '');
});

test('task-proposal を足しても既存の 2 種別は変わらない', () => {
  // 種別が増えても既存の並びは動かない (増える側は末尾へ足す)
  assert.deepEqual(CONTRACT_KINDS.slice(0, 3), ['delegation', 'report', 'task-proposal']);
  assert.equal(validateContract('delegation', DELEGATION).ok, true);
  assert.equal(validateContract('report', REPORT).ok, true);
  assert.deepEqual(validateContract('report', REPORT).contract, REPORT);
  assert.match(renderForKind('delegation', DELEGATION), /委譲契約/);
  assert.match(renderForKind('report', REPORT), /直前の報告/);
  // 権限に関わるのは委譲だけ (起票は touch 集合を持たない)
  assert.deepEqual(canDelegateTo('task-proposal', PROPOSAL, 'codex'), { ok: true });
});

// ---- 承認 (task-approval) ----

/** 承認する側が返す形 (pending は書かない) */
const APPROVAL = {
  body: '2 件見た。1 件通す。\n\n[[handoff:opus]]',
  approve: ['3'],
  drop: [{ id: '4', reason: '既存タスクと重複している' }],
};
/** ブリッジが保存する形 (承認待ちの一覧と、重複を見つける材料を載せる) */
const PENDING = {
  body: '起票 2 件の承認をお願いします',
  approve: [],
  drop: [],
  pending: [
    {
      id: '3',
      title: '状態バッジを足す',
      rationale: '一目で読める',
      touch: ['src/render/table.ts', 'src/style.css'],
      job_budget: 20,
    },
    { id: '4', title: 'タイムラインを足す', rationale: '順序が追える' },
  ],
  board: [
    { id: '1', state: 'review', title: 'pytest を足す', touch: ['tools/new_ticket.py'] },
    { id: '2', state: 'merged', title: '例外台帳の lint' },
  ],
};

test('task-approval: 応答の形もブリッジが保存する形も通る', () => {
  const answered = validateContract('task-approval', APPROVAL);
  assert.equal(answered.ok, true, answered.reason);
  assert.deepEqual(answered.contract, APPROVAL);
  assert.equal(answered.contract.pending, undefined, '書いていない欄を埋めている');
  assert.equal(answered.contract.board, undefined, '参考欄まで埋めている');

  const saved = validateContract('task-approval', PENDING);
  assert.equal(saved.ok, true, saved.reason);
  assert.deepEqual(saved.contract, PENDING);

  // 何も通さない承認も正しい応答
  assert.equal(validateContract('task-approval', { body: 'x', approve: [], drop: [] }).ok, true);
});

test('task-approval: 異常系は不適合にして、どこが悪いかを返す', () => {
  const bad = [
    [{ body: 'x', drop: [] }, /承認/],
    [{ body: 'x', approve: [] }, /破棄/],
    [{ ...APPROVAL, body: '   ' }, /本文/],
    [{ ...APPROVAL, approve: '3' }, /配列/],
    [{ ...APPROVAL, approve: [3] }, /文字列/],
    [{ body: 'x', approve: [], drop: [{ reason: 'r' }] }, /1 件目: id がありません/],
    [{ body: 'x', approve: [], drop: [{ id: '4' }] }, /1 件目: 破棄の理由 がありません/],
    [{ body: 'x', approve: [], drop: [{ id: '4', reason: '  ' }] }, /1 件目: 破棄の理由 が空です/],
    [{ body: 'x', approve: [], drop: [{ id: '4', reason: 'r', note: 'x' }] }, /契約に無いキー/],
    [{ ...PENDING, pending: [{ id: '3' }] }, /1 件目: タイトル がありません/],
    [{ ...PENDING, pending: [{ id: '3', title: 'A', job_budget: 0 }] }, /job予算/],
    [{ ...PENDING, pending: [{ id: '3', title: 'A', touch: 'src/a.ts' }] }, /配列/],
    // 参考欄 (§9.3) も提示用の形が決まっている — 余分なキーや欠けは落とす
    [{ ...PENDING, board: [{ id: '1', title: 'A' }] }, /1 件目: 状態 がありません/],
    [{ ...PENDING, board: [{ id: '1', state: 'review' }] }, /1 件目: タイトル がありません/],
    [{ ...PENDING, board: [{ id: '1', state: 'review', title: 'A', note: 'x' }] }, /契約に無いキー/],
    [{ ...PENDING, board: [{ id: '1', state: 'review', title: 'A', touch: 'x' }] }, /配列/],
    [{ ...PENDING, board: {} }, /配列/],
    [{ ...APPROVAL, extra: 'x' }, /契約に無いキー/],
  ];
  for (const [value, pattern] of bad) {
    const r = validateContract('task-approval', value);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(value)}`);
    assert.match(r.reason, pattern);
  }

  // 1 回の承認で扱うのは今回の起票 (最大 5 件) まで
  const over = validateContract('task-approval', {
    body: 'x',
    approve: Array.from({ length: MAX_PROPOSED_TASKS + 1 }, (_, i) => String(i)),
    drop: [],
  });
  assert.equal(over.ok, false);
  assert.match(over.reason, /承認 の要素が多すぎます/);
});

test('task-approval: 承認する側のプロンプトに id つきの一覧が出る', () => {
  const block = renderForKind('task-approval', PENDING);
  assert.match(block, /id `3` — 状態バッジを足す \/ job 予算 20/);
  assert.match(block, /id `4` — タイムラインを足す/);
  assert.match(block, /一目で読める/, '理由が落ちている');
  assert.match(block, /整合/);
  assert.match(block, /重複/);
  assert.match(block, /粒度/);
  assert.match(block, /自動で破棄される/, '言及しなかった分の扱いが伝わっていない');
  assert.equal(block.includes(PENDING.body), false, '本文は Discord へ出す面なので混ぜない');

  assert.match(renderForKind('task-approval', APPROVAL), /- \(なし\)/, 'pending 無しで落ちている');
  assert.equal(renderForKind('task-approval', null), '');
});

test('task-approval: 重複を見つける材料 (touch と参考欄と見る点) が出る — §9.3', () => {
  const block = renderForKind('task-approval', PENDING);
  // 承認待ちの touch (宣言が無ければそう書く — 空欄だと見落としと区別できない)
  assert.match(block, /touch: src\/render\/table\.ts \/ src\/style\.css/);
  assert.match(block, /touch: \(宣言なし\)/, 'touch の無い起票が空欄になっている');
  // 参考欄 — 承認待ち以外のボードの現状
  assert.match(block, /## 参考/);
  assert.match(block, /- \[review\] #1: pytest を足す \(touch: tools\/new_ticket\.py\)/);
  assert.match(block, /- \[merged\] #2: 例外台帳の lint/);
  // 見る点は 3 つ (重複 / 範囲 / 粒度) で、予算は判断材料にしない
  assert.match(block, /①重複/);
  assert.match(block, /②範囲/);
  assert.match(block, /③粒度/);
  assert.match(block, /touch ≤ 5/);
  assert.match(block, /job 予算は判断材料にしない/);

  // 参考欄が空でも落ちない (「見ていない」と「無い」を区別する)
  const alone = renderForKind('task-approval', { ...PENDING, board: [] });
  assert.match(alone, /## 参考[\s\S]*- \(なし\)/);
});

test('approvalBoard: 今回の起票を除いた参考欄を作る (上限で契約を落とさない)', () => {
  const tasks = [
    { id: '1', state: 'review', title: 'A', touch: ['tools/a.py', ' tools/b.py '] },
    { id: 2, state: 'proposed', title: 'B' }, // 数値 id も文字列に寄せる
    { id: '3', state: 'merged', title: 'C', touch: [] },
    { id: '', state: 'proposed', title: '欠け' }, // 様式が空文字を拒むので載せない
    { id: '9', state: 'proposed', title: '' },
    null,
  ];
  assert.deepEqual(approvalBoard(tasks, { excludeIds: ['2'] }), [
    { id: '1', state: 'review', title: 'A', touch: ['tools/a.py', 'tools/b.py'] },
    { id: '3', state: 'merged', title: 'C' }, // 空の touch は載せない
  ]);
  // 除外は数値で渡しても効く (ボードの id は文字列だが呼び出し側は task をそのまま持つ)
  assert.deepEqual(approvalBoard(tasks, { excludeIds: [1, 2, 3] }), []);
  assert.deepEqual(approvalBoard(tasks), [
    { id: '1', state: 'review', title: 'A', touch: ['tools/a.py', 'tools/b.py'] },
    { id: '2', state: 'proposed', title: 'B' },
    { id: '3', state: 'merged', title: 'C' },
  ]);

  // 上限を超える分は末尾から落とす (契約が落ちると承認 job ごと失われる)
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => ({
    id: String(i + 1), state: 'proposed', title: `T${i}`,
  }));
  const capped = approvalBoard(many);
  assert.equal(capped.length, MAX_ITEMS);
  assert.equal(capped.at(-1).id, String(MAX_ITEMS), '先頭から順に詰めていない');
  assert.equal(validateContract('task-approval', { ...PENDING, board: capped }).ok, true);

  assert.deepEqual(approvalBoard(null), []);
  assert.deepEqual(approvalBoard([], { excludeIds: null }), []);
});

test('契約の保存ラベルは種別ごとに出し分ける', () => {
  assert.equal(contractSaveLabel('delegation'), '委譲契約の保存');
  assert.equal(contractSaveLabel('report'), '報告の保存');
  assert.equal(contractSaveLabel('task-proposal'), '起票の保存');
  assert.equal(contractSaveLabel('task-approval'), '承認の保存');
  // 種別が増えたのに二択のまま、を防ぐ
  const labels = CONTRACT_KINDS.map(contractSaveLabel);
  assert.equal(new Set(labels).size, CONTRACT_KINDS.length, '同じラベルを共有している種別がある');
  // 知らない種別・prototype 由来の名前は既定へ
  for (const kind of ['unknown', 'constructor', '', null, undefined]) {
    assert.equal(contractSaveLabel(kind), '契約の保存', JSON.stringify(kind));
  }
});

test('task-approval を足しても既存の 3 種別は変わらない', () => {
  assert.deepEqual(CONTRACT_KINDS.slice(0, 3), ['delegation', 'report', 'task-proposal']);
  assert.ok(CONTRACT_KINDS.includes('task-approval'));
  assert.equal(validateContract('delegation', DELEGATION).ok, true);
  assert.equal(validateContract('report', REPORT).ok, true);
  assert.equal(validateContract('task-proposal', PROPOSAL).ok, true);
  assert.match(renderForKind('delegation', DELEGATION), /委譲契約/);
  assert.match(renderForKind('report', REPORT), /直前の報告/);
  assert.match(renderForKind('task-proposal', PROPOSAL), /起票されたタスク案/);
  // 権限に関わるのは委譲だけ
  assert.deepEqual(canDelegateTo('task-approval', APPROVAL, 'codex'), { ok: true });
});

// ---- レビュー (task-review) ----

/** レビューする側が返す形 */
const REVIEW = {
  body: 'diff を読み、テストを回して main へ入れた。\n\n[[notify:owner]]',
  verdict: 'merge',
  merge_commit: 'a1b2c3d',
};
/** ブリッジが保存する形 (レビュー対象を載せる) */
const REVIEW_TARGET = {
  body: 'タスク 3 のレビューをお願いします',
  verdict: 'send-back',
  reason: '(未判定 — ブリッジが様式を満たすために埋めた欄)',
  target: [{ id: '3', title: '状態バッジを足す', branch: 'task/3', job_budget: 20 }],
};

test('task-review: 判定は 4 値だけ / 応答もブリッジの提示も通る', () => {
  // drop は §9.4 で足した「対象が不要」— 増やすときは設計の裁定を経ること
  assert.deepEqual(REVIEW_VERDICTS, ['merge', 'send-back', 'block', 'drop']);
  assert.equal(validateContract('task-review', REVIEW).ok, true);
  assert.equal(validateContract('task-review', REVIEW_TARGET).ok, true);
  for (const verdict of REVIEW_VERDICTS) {
    // merge だけはマージコミットが要る (§12.3 (2) — ブリッジが git で照合する)
    const r = validateContract('task-review', {
      body: 'x', verdict, reason: '理由', ...(verdict === 'merge' ? { merge_commit: 'a1b2c3d' } : {}),
    });
    assert.equal(r.ok, true, `${verdict}: ${r.reason}`);
  }
  // 4 値以外は落とす (綴り違いを通すと「判定したつもりが効かない」になる)
  for (const verdict of ['merged', 'approve', 'ok', 'MERGE', 'dropped', '', 3]) {
    const r = validateContract('task-review', { body: 'x', verdict, reason: '理由' });
    assert.equal(r.ok, false, `${JSON.stringify(verdict)} を通している`);
  }
  assert.match(
    validateContract('task-review', { body: 'x', verdict: 'merged' }).reason,
    /merge \/ send-back \/ block \/ drop/,
    '使える値を示していない',
  );
});

test('task-review: merge はマージコミットの SHA が要る (§12.3 (2))', () => {
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'a1b2c3d' }).ok, true);
  // 完全 OID も短縮 OID (7 桁) も通る
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'f'.repeat(40) }).ok, true);

  // 記載なし = 照合しようがない完了 (無関係な commit と区別が付かない)
  const missing = validateContract('task-review', { body: 'x', verdict: 'merge' });
  assert.equal(missing.ok, false, 'SHA なしの merge を通している');
  assert.match(missing.reason, /マージコミット/);

  // 大文字の OID も通す — git 自身が解決するので、見た目の違いで報告を落とさない
  // (照合する側が git と receipt に当てる前に小文字へ揃える。Opus 指摘 2026-09-07)
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'ABC1234' }).ok, true);
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'AbC1234dEf' }).ok, true);

  // SHA の形をしていないものは受け取らない (git へ渡す前に落とす)
  for (const sha of ['', '  ', 'abc123', 'a'.repeat(41), 'HEAD', 'task/1', 'zzzzzzz', 'ghijklm']) {
    const r = validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: sha });
    assert.equal(r.ok, false, `${JSON.stringify(sha)} を通している`);
  }
  assert.match(
    validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'HEAD~1' }).reason,
    /16 進 7〜40 桁/,
    '何が悪いのか示していない',
  );
  // merge 以外では従来どおり任意 (書いてあっても形は問わない)
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'block', reason: '理由', merge_commit: 'HEAD' }).ok, true);
});

test('task-review: merge 以外は理由が要る (merge だけ省略可)', () => {
  assert.equal(validateContract('task-review', { body: 'x', verdict: 'merge', merge_commit: 'a1b2c3d' }).ok, true);
  // drop も同じ門を通る — 「不要」と判断した根拠が残らないと後から追えない
  for (const verdict of ['send-back', 'block', 'drop']) {
    for (const reason of [undefined, '', '   ']) {
      const r = validateContract('task-review', { body: 'x', verdict, ...(reason === undefined ? {} : { reason }) });
      assert.equal(r.ok, false, `${verdict} / ${JSON.stringify(reason)} を通している`);
      assert.match(r.reason, /理由 \(reason\) が必要です/);
    }
    assert.equal(validateContract('task-review', { body: 'x', verdict, reason: '理由' }).ok, true);
  }
});

test('task-review: 提示欄の型違い・余分なキーは落とす', () => {
  const bad = [
    [{ body: 'x' }, /判定/],
    [{ verdict: 'merge' }, /本文/],
    [{ ...REVIEW_TARGET, target: [{ id: '3', title: 'A' }] }, /1 件目: ブランチ がありません/],
    [{ ...REVIEW_TARGET, target: [{ id: '3', title: 'A', branch: '' }] }, /1 件目: ブランチ が空です/],
    [{ ...REVIEW_TARGET, target: [{ id: '3', title: 'A', branch: 'b', extra: 'x' }] }, /契約に無いキー/],
    [{ ...REVIEW, extra: 'x' }, /契約に無いキー/],
  ];
  for (const [value, pattern] of bad) {
    const r = validateContract('task-review', value);
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(value)}`);
    assert.match(r.reason, pattern);
  }
});

test('task-review: レビューする側のプロンプトに対象と手順が出る', () => {
  const block = renderForKind('task-review', REVIEW_TARGET);
  assert.match(block, /id `3` — 状態バッジを足す \/ job 予算 20/);
  assert.match(block, /ブランチ: `task\/3`/);
  assert.match(block, /merge --no-ff/, 'マージの手順が無い');
  assert.match(block, /実ファイル/);
  assert.match(block, /テストを回す/);
  assert.match(block, /差し戻しは 2 回まで/);
  // §12.3 (2) — merge の申告は git で照合され、適用 task だけ書くものが違う
  assert.match(block, /`merge_commit` は必須/);
  assert.match(block, /適用 task \(org-apply\) だけは例外/);
  assert.match(block, /検収した commit/);
  // §9.4 — 不要と分かったときの逃げ道と、そのとき何をしないか
  assert.match(block, /verdict: "drop"/);
  assert.match(block, /ブランチは消さない/);
  assert.equal(block.includes(REVIEW_TARGET.body), false, '本文は Discord へ出す面なので混ぜない');

  assert.match(renderForKind('task-review', REVIEW), /対象が渡されていない/);
  assert.equal(renderForKind('task-review', null), '');
  assert.equal(contractSaveLabel('task-review'), 'レビュー依頼の保存');
});

test('resolveContractKind: override はその job だけ種別を差し替える (スカウト job)', () => {
  assert.equal(resolveContractKind({ roleText: DECLARED }), 'report', '前提: 宣言は report');
  assert.equal(resolveContractKind({ roleText: DECLARED, override: 'task-proposal' }), 'task-proposal');
  // 知らない綴り・空は宣言へ倒す (黙って構造化を切らない)
  for (const override of ['proposal', 'task-proposals', '', null, undefined]) {
    assert.equal(
      resolveContractKind({ roleText: DECLARED, override }), 'report', JSON.stringify(override),
    );
  }
  // **もともと構造化しない job には乗らない** (宣言が無ければ従来どおり、が破れない)
  assert.equal(resolveContractKind({ roleText: '# Opus', override: 'task-proposal' }), null);
  assert.equal(
    resolveContractKind({ roleText: DECLARED, override: 'task-proposal', structuredOutput: false }),
    null,
  );
  assert.equal(
    resolveContractKind({ roleText: DECLARED, override: 'task-proposal', runtime: 'codex' }),
    null,
  );
});

test('resolveContractKind: 既定は「有効・claude」(呼び出し漏れで黙って切れない)', () => {
  assert.equal(resolveContractKind({ roleText: DECLARED }), 'report');
  assert.equal(resolveContractKind(), null, 'roleText 無しは宣言なし扱い');
  // structuredOutput に boolean 以外が来ても切らない (解決は config 側で済んでいる)
  assert.equal(resolveContractKind({ roleText: DECLARED, structuredOutput: 'false' }), 'report');
});

// ---- 組織提案の裁定 (§3.9) ----

const ADJUDICATION = { proposal_id: '12', decision: 'accepted', rationale: '職務の重なりが実測で出ている' };

test('report の裁定は任意フィールドで、書くなら 3 項目そろえる', () => {
  // 書かない report は従来どおり通る
  assert.equal(validateContract('report', REPORT).ok, true);

  const ok = validateContract('report', { ...REPORT, adjudication: ADJUDICATION });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.contract.adjudication, ADJUDICATION);

  const bad = [
    [{ ...ADJUDICATION, decision: 'maybe' }, /採否/],
    [{ ...ADJUDICATION, decision: undefined }, /採否/],
    [{ ...ADJUDICATION, rationale: '  ' }, /理由/],
    [{ ...ADJUDICATION, proposal_id: undefined }, /提案 ID/],
    [{ ...ADJUDICATION, class: 'work' }, /契約に無いキー/],
    ['12', /オブジェクト/],
  ];
  for (const [adjudication, pattern] of bad) {
    const r = validateContract('report', { ...REPORT, adjudication });
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(adjudication)}`);
    assert.match(r.reason, pattern);
  }
});

test('様式タグは起動メッセージそのものに載る (スレッド ID の 1 枠に頼らない)', () => {
  // `threadId:botKey` の枠は、親チャンネルへ落としたときに生えるスレッドの ID が
  // 投稿先と違って外れる / 同じ場所へ 2 件並べると先の job が枠を食う (sol 指摘 2026-08-30)
  assert.equal(formatSchemaTag('report'), '`様式:report`');
  assert.equal(formatSchemaTag('task-proposal'), '`様式:task-proposal`');
  assert.equal(readSchemaTag('## 裁定の依頼 `様式:report` です'), 'report');
  assert.equal(readSchemaTag(`<@1>\n${formatSchemaTag('task-review')}`), 'task-review');

  // 知らない綴りは載せないし読まない (fail-closed — 黙って別の様式で走らせない)
  assert.equal(formatSchemaTag('しらない'), '');
  assert.equal(formatSchemaTag(undefined), '');
  assert.equal(readSchemaTag('`様式:しらない`'), null);
  assert.equal(readSchemaTag('`様式:reports`'), null);
  assert.equal(readSchemaTag('様式:report'), null, 'コードスパンでない文字列を拾っている');
  assert.equal(readSchemaTag(''), null);
  assert.equal(readSchemaTag(null), null);

  // 契約タグとは別系統 (同じ 1 通に両方載っても取り違えない)
  const both = `${formatContractTag('0123456789abcdef')} ${formatSchemaTag('report')}`;
  assert.equal(readSchemaTag(both), 'report');
  assert.equal(readContractNonce(both), '0123456789abcdef');
  assert.equal(readSchemaTag(formatContractTag('0123456789abcdef')), null);
});

test('resolveJobContractKind: 目印があるときは共有枠を取り出さない', () => {
  // 枠は threadId:botKey に 1 つしかない。目印つきの job が先に取り出すと、
  // 同じ宛先で待っていた task-review の枠が消えてその job が既定様式で走る
  let claimed = 0;
  const claimSlot = () => { claimed += 1; return 'task-review'; };

  const tagged = resolveJobContractKind({
    roleText: DECLARED, triggerContent: `<@1> ${formatSchemaTag('report')}`, claimSlot,
  });
  assert.equal(tagged, 'report');
  assert.equal(claimed, 0, '目印があるのに共有枠を奪っている');

  // 目印が無ければ従来どおり枠を使う
  assert.equal(resolveJobContractKind({ roleText: DECLARED, triggerContent: '<@1>', claimSlot }), 'task-review');
  assert.equal(claimed, 1);

  // 知らない綴りの目印は目印として扱わない (枠へ落ちる)
  assert.equal(
    resolveJobContractKind({ roleText: DECLARED, triggerContent: '`様式:しらない`', claimSlot }),
    'task-review',
  );
  assert.equal(claimed, 2);

  // 宣言の無い bot・codex・構造化を切ったチャンネルでは目印があっても null
  assert.equal(resolveJobContractKind({ roleText: '# 宣言なし', triggerContent: formatSchemaTag('report'), claimSlot }), null);
  assert.equal(resolveJobContractKind({ roleText: DECLARED, runtime: 'codex', triggerContent: formatSchemaTag('report') }), null);
  assert.equal(
    resolveJobContractKind({ roleText: DECLARED, structuredOutput: false, triggerContent: formatSchemaTag('report') }),
    null,
  );
  // 呼び出し漏れでも落ちない (枠なし = 宣言どおり)
  assert.equal(resolveJobContractKind({ roleText: DECLARED }), 'report');
});

// ---- 発議 (§3.9 の 3 経路のうち (1)) ----

const INITIATIVE = {
  kind: 'duty-edit',
  targets: [{ botKey: 'sol', dutyKey: 'review', op: 'edit' }],
  duty: 'org-audit',
  summary: 'レビューの巡回間隔が長すぎて滞留している',
  evidence: ['review 滞留の中央値が 3 日', '直近 5 件のうち 4 件が 2 日以上'],
  remedy: 'policy',
  change: {
    touch: ['config.policy.json'],
    diff: '--- a/config.policy.json\n+++ b/config.policy.json\n@@\n-  30\n+  15\n',
  },
  benefits: ['滞留が縮む'],
  risks: ['巡回が増えて日次予算を食う'],
  cost: '1 job',
  trial: {
    deadline: '2026-09-30T00:00:00Z',
    successCriteria: '滞留の中央値が 1 日を切る',
    rollback: 'intervalMin を 30 へ戻す',
  },
};

/** キーごと落とした複製 (`undefined` を入れると「型が違う」で落ちて必須の検査にならない) */
const without = (obj, key) => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};

test('report の発議は任意フィールドで、書くなら入力側を全部そろえる', () => {
  const ok = validateContract('report', { ...REPORT, initiative: INITIATIVE });
  assert.equal(ok.ok, true, ok.reason);
  // **そのまま ProposalStore.raise() へ渡す**ので、通った値が変わっていないこと
  assert.deepEqual(ok.contract.initiative, INITIATIVE);

  // trial は work では省ける (必須かどうかを決めるのは proposals.js のゲート)
  const noTrial = without({ ...INITIATIVE, kind: 'work-item', targets: [{ taskId: '31' }] }, 'trial');
  assert.equal(validateContract('report', { ...REPORT, initiative: noTrial }).ok, true);
});

test('発議: 未知の kind / remedy / op と、書けないキーは様式で落とす', () => {
  const bad = [
    [{ ...INITIATIVE, kind: 'なんとなく' }, /種別/],
    [{ ...INITIATIVE, remedy: 'いい感じに' }, /直し先/],
    [{ ...INITIATIVE, targets: [{ botKey: 'sol', op: 'delete' }] }, /操作/],
    // class・subjectKeys はブリッジが付けるので bot は書けない
    [{ ...INITIATIVE, class: 'work' }, /契約に無いキー/],
    [{ ...INITIATIVE, subjectKeys: ['role:sol'] }, /契約に無いキー/],
    [{ ...INITIATIVE, targets: [{ botKey: 'sol', 誰か: 'x' }] }, /契約に無いキー/],
    [{ ...INITIATIVE, targets: [] }, /対象 は 1 件以上/],
    [{ ...INITIATIVE, targets: 'sol' }, /対象 は配列/],
    [{ ...INITIATIVE, change: { touch: [], diff: 'x' } }, /touch集合 は 1 件以上/],
    [{ ...INITIATIVE, change: { touch: ['a'] } }, /diff がありません/],
    [{ ...INITIATIVE, change: 'roles/sol.md を直す' }, /変更案 がオブジェクトではありません/],
    [{ ...INITIATIVE, trial: { deadline: '2026-09-30' } }, /成功条件 がありません/],
    [{ ...INITIATIVE, summary: '   ' }, /要旨 が空です/],
    [without(INITIATIVE, 'cost'), /コスト がありません/],
    [without(INITIATIVE, 'targets'), /対象 がありません/],
    [{ ...INITIATIVE, evidence: '滞留' }, /根拠 は配列/],
    ['duty-edit', /発議 がオブジェクトではありません/],
  ];
  for (const [initiative, pattern] of bad) {
    const r = validateContract('report', { ...REPORT, initiative });
    assert.equal(r.ok, false, `通してはいけない: ${JSON.stringify(initiative)}`);
    assert.match(r.reason, pattern);
  }
});

test('発議: 裁定と同じ report に同居できる (別の提案の話なので片方を落とさない)', () => {
  const r = validateContract('report', {
    ...REPORT, adjudication: ADJUDICATION, initiative: INITIATIVE,
  });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.contract.adjudication, ADJUDICATION);
  assert.deepEqual(r.contract.initiative, INITIATIVE);
});

test('発議: スキーマのキーは proposals.js の入力側と綴りまで同じ', () => {
  // 翻訳層を挟まずに raise() へ渡すので、ここがずれると「未知のキー」で全部落ちる
  const spec = SCHEMAS.report.properties.initiative;
  assert.deepEqual(Object.keys(spec.properties).sort(), [...PROPOSAL_INPUT_KEYS].sort());
  assert.deepEqual(spec.properties.kind.enum, [...PROPOSAL_KINDS]);
  assert.deepEqual(spec.properties.remedy.enum, [...REMEDIES]);
  assert.deepEqual(spec.properties.targets.items.properties.op.enum, [...TARGET_OPS]);
  // 要素のキーも ASCII で日本語の呼び名を持つ (エラー文が読めなくなる)
  for (const key of [...Object.keys(spec.properties),
    ...Object.keys(spec.properties.targets.items.properties),
    ...Object.keys(spec.properties.change.properties),
    ...Object.keys(spec.properties.trial.properties)]) {
    assert.match(key, /^[a-zA-Z0-9_-]+$/, `initiative.${key} が ASCII ではない`);
    assert.ok(FIELD_LABELS[key], `initiative.${key} に日本語の呼び名が無い`);
  }
  // diff は本文より広い上限を持つ (Discord へ出す面ではないので長さで落とさない)
  assert.ok(spec.properties.change.properties.diff.maxLength > MAX_TEXT_CHARS);
});

// ---- 案件の 1 ターン (docs/society-ledger.md・S2-3a) ----

const CASE_TURN = {
  body: '調べました',
  result: { observed: ['npm test 1589 件全通過'], claimed: ['たぶん直った'] },
  next: { waiting: { why: 'evidence', condition: '検収を待つ' } },
};

test('case-turn: 本文と次の一手が必須で、成果と気づきは任意', () => {
  assert.equal(validateContract('case-turn', CASE_TURN).ok, true);
  // result も finding も無くてよい (待つだけのターンがある)
  assert.equal(validateContract('case-turn', { body: 'x', next: CASE_TURN.next }).ok, true);
  // **次の一手は必ず要る** — 案件は次の契機を 1 つ持つ (§3 の不変条件)
  assert.match(validateContract('case-turn', { body: 'x' }).reason, /次の一手/);
  assert.match(validateContract('case-turn', { next: CASE_TURN.next }).reason, /本文/);
});

test('case-turn: 待ちの理由は閉集合 (台帳の WAITING_REASONS と同じ)', () => {
  const why = SCHEMAS['case-turn'].properties.next.properties.waiting.properties.why;
  assert.deepEqual([...why.enum].sort(), [...WAITING_REASONS].sort());
  assert.equal(validateContract('case-turn', {
    body: 'x', next: { waiting: { why: 'いい感じ', condition: 'y' } },
  }).ok, false);
});

test('case-turn: 成果は観測と主張を分けて持ち、artifact は任意', () => {
  const result = SCHEMAS['case-turn'].properties.result;
  assert.deepEqual(result.required, ['observed']);
  assert.ok(result.properties.artifact.description.includes('検収待ち'));
  // 観測が無い成果は受け付けない (検収は observed にだけ結ぶ)
  assert.equal(validateContract('case-turn', {
    body: 'x', result: { claimed: ['たぶん'] }, next: CASE_TURN.next,
  }).ok, false);
});

test('case-turn: 気づきは原因が分からなくても書ける (対象と観測条件は要る)', () => {
  const finding = { expected: 'a', actual: 'b', subject_id: 'task-77', condition_id: 'verify-red' };
  assert.equal(validateContract('case-turn', { ...CASE_TURN, finding }).ok, true);
  assert.equal(validateContract('case-turn', {
    ...CASE_TURN, finding: { ...finding, subject_id: undefined },
  }).ok, false);
  // 仮説は任意 (思い当たらなければ省く)
  assert.equal(validateContract('case-turn', {
    ...CASE_TURN, finding: { ...finding, hypothesis: '索引の入力' },
  }).ok, true);
});

test('case-turn: 役割文の宣言でも選べる種別として登録されている', () => {
  assert.ok(CONTRACT_KINDS.includes('case-turn'));
  assert.equal(readContractKind('<!-- communitd-schema: case-turn -->\n# role'), 'case-turn');
  assert.equal(bodyOf(CASE_TURN), '調べました');
});

test('case-turn: next は plan か waiting のどちらか一方 (空も両方も落とす)', () => {
  const plan = { plan: { kind: 'implement', summary: 'x' } };
  const waiting = { waiting: { why: 'evidence', condition: 'y' } };
  assert.equal(validateContract('case-turn', { body: 'x', next: plan }).ok, true);
  assert.equal(validateContract('case-turn', { body: 'x', next: waiting }).ok, true);
  // 空 — 台帳が next-required で断り、Action が running のまま止まる
  const empty = validateContract('case-turn', { body: 'x', next: {} });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /どちらかを書きます/);
  // 両方 — どちらを採るかがブリッジ任せになる
  const both = validateContract('case-turn', { body: 'x', next: { ...plan, ...waiting } });
  assert.equal(both.ok, false);
  assert.match(both.reason, /同時に書けません/);
  // スキーマ側にも出す (モデルの生成に効かせる)
  assert.equal(SCHEMAS['case-turn'].properties.next.minProperties, 1);
  assert.equal(SCHEMAS['case-turn'].properties.next.maxProperties, 1);
});

test('case-turn: claim は任意で、decline には理由が要る', () => {
  const base = { body: 'x', next: { waiting: { why: 'offer', condition: 'y' } } };
  const planned = { body: 'x', next: { plan: { kind: 'investigate', summary: 'ログを読む' } } };
  // 相談でなければ書かなくてよい
  assert.equal(validateContract('case-turn', base).ok, true);
  assert.equal(validateContract('case-turn', {
    ...planned, claim: { decision: 'accept' },
  }).ok, true);
  assert.equal(validateContract('case-turn', {
    ...base, claim: { decision: 'decline', reason: '手が離せません' },
  }).ok, true);
  // **断るなら理由が要る** — 次に誰へ声を掛けるかを決める材料になる
  const bare = validateContract('case-turn', { ...base, claim: { decision: 'decline' } });
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /decline のときは理由/);
  // 採否は閉集合
  assert.equal(validateContract('case-turn', { ...base, claim: { decision: 'maybe' } }).ok, false);
  assert.equal(validateContract('case-turn', { ...base, claim: {} }).ok, false);
  // 範囲は任意
  assert.equal(validateContract('case-turn', {
    ...planned, claim: { decision: 'accept', scope: '調査だけ' },
  }).ok, true);
  // **引き受けるなら最初の一手が要る** — accept + waiting は台帳が plan-required で断るが、
  // そのとき相談の Action は settle 済みで、申し出は offered のまま誰も再送しない
  const noPlan = validateContract('case-turn', { ...base, claim: { decision: 'accept' } });
  assert.equal(noPlan.ok, false);
  assert.match(noPlan.reason, /accept のときは最初の一手/);
});
