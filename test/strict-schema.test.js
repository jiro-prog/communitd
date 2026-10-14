import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMAS, validateContract } from '../src/contract.js';
import { stripNullOptionals, toStrictSchema } from '../src/strict-schema.js';

const KINDS = Object.keys(SCHEMAS);

/** strict 側と原スキーマの同じ節を対で歩く (object と配列要素だけ) */
function eachNode(strict, origin, fn, path = '$') {
  fn(strict, origin, path);
  if (strict.properties) {
    for (const [key, sub] of Object.entries(strict.properties)) {
      eachNode(sub, origin.properties[key], fn, `${path}.${key}`);
    }
  }
  if (strict.items) eachNode(strict.items, origin.items, fn, `${path}[]`);
}

/**
 * 「strict が返してくる形」を作る — 原スキーマで書かなかった任意キーを **null で埋める**。
 * 実機の codex はこの形で返した (nested も配列要素も。実測 2026-09-18)。
 */
function fillNulls(value, schema) {
  if (Array.isArray(value)) {
    return schema.items === undefined ? value : value.map((v) => fillNulls(v, schema.items));
  }
  if (value === null || typeof value !== 'object' || !schema.properties) return value;
  const out = {};
  for (const [key, sub] of Object.entries(schema.properties)) {
    out[key] = Object.hasOwn(value, key) ? fillNulls(value[key], sub) : null;
  }
  return out;
}

test('strict 変換: どの object も required = 全キー・additionalProperties false', () => {
  // codex は `'required' is required to ... including every key in properties` で 400 にする
  // (実測 2026-09-18 — `Missing 'touch_restricted'`)
  for (const kind of KINDS) {
    eachNode(toStrictSchema(SCHEMAS[kind]), SCHEMAS[kind], (strict, _origin, path) => {
      if (!strict.properties) return;
      assert.deepEqual(strict.required, Object.keys(strict.properties), `${kind} ${path}`);
      assert.equal(strict.additionalProperties, false, `${kind} ${path}`);
    });
  }
});

test('strict 変換: 任意キーだけが nullable になる (必須キーの型は変えない)', () => {
  for (const kind of KINDS) {
    eachNode(toStrictSchema(SCHEMAS[kind]), SCHEMAS[kind], (strict, origin, path) => {
      if (!strict.properties) return;
      const required = Array.isArray(origin.required) ? origin.required : [];
      for (const key of Object.keys(strict.properties)) {
        const s = strict.properties[key];
        const o = origin.properties[key];
        if (required.includes(key)) {
          assert.deepEqual(s.type, o.type, `${kind} ${path}.${key} の必須キーの型が変わっている`);
          continue;
        }
        assert.deepEqual(s.type, [o.type, 'null'], `${kind} ${path}.${key} が nullable でない`);
        // enum を閉じたままにすると、型で null を許しても値域の外になって返せない
        if (o.enum) assert.deepEqual(s.enum, [...o.enum, null], `${kind} ${path}.${key} の enum`);
      }
    });
  }
});

test('strict 変換: 書けないキー (minProperties / maxProperties) は落とす', () => {
  // `'minProperties' is not permitted` (実測 — case-turn の next)
  const origin = SCHEMAS['case-turn'].properties.next;
  assert.equal(origin.minProperties, 1, '前提が変わっている (原スキーマから個数制約が消えた)');
  assert.equal(origin.maxProperties, 1);
  for (const kind of KINDS) {
    eachNode(toStrictSchema(SCHEMAS[kind]), SCHEMAS[kind], (strict, _origin, path) => {
      assert.equal(Object.hasOwn(strict, 'minProperties'), false, `${kind} ${path}`);
      assert.equal(Object.hasOwn(strict, 'maxProperties'), false, `${kind} ${path}`);
    });
  }
  // 「ちょうど 1 つ」の検査そのものは validateContract 側に残る (落としたのは CLI へ渡す形だけ)
  const two = validateContract('case-turn', {
    body: 'x',
    next: { plan: { kind: 'investigate', summary: 'a' }, waiting: { why: 'evidence', condition: 'b' } },
  });
  assert.equal(two.ok, false, '個数制約が両方から消えている');
});

test('strict 変換: type の無い任意キーは落とす (codex でだけ必須になるため)', () => {
  // 黙って通すと strict 側では required のまま null も返せない節になる。
  // いまの 6 種には該当が無い (= 変換は通る) が、足した日に気付けるようにする
  for (const kind of KINDS) {
    assert.doesNotThrow(() => toStrictSchema(SCHEMAS[kind]), `${kind} が throw する`);
  }
  const broken = {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string' },
      // 型の無い任意キー (enum だけ / 説明だけ、のような書き方)
      note: { description: '任意のメモ' },
    },
  };
  assert.throws(() => toStrictSchema(broken), /\$\.note は任意キーなのに type が無い/);
  // 入れ子でも経路が分かる (どこを直せばいいのかがエラー文から読める)
  const nested = {
    type: 'object',
    required: ['tasks'],
    properties: {
      tasks: { type: 'array', items: { type: 'object', required: [], properties: { memo: {} } } },
    },
  };
  assert.throws(() => toStrictSchema(nested), /\$\.tasks\[\]\.memo/);
});

test('strict 変換: 説明と値域は残す (モデルが読む面・検査の根拠)', () => {
  const strict = toStrictSchema(SCHEMAS.report);
  assert.equal(strict.properties.body.description, SCHEMAS.report.properties.body.description);
  assert.equal(strict.properties.body.maxLength, SCHEMAS.report.properties.body.maxLength);
  assert.equal(strict.properties.did.maxItems, SCHEMAS.report.properties.did.maxItems);
  assert.equal(
    strict.properties.did.items.maxLength,
    SCHEMAS.report.properties.did.items.maxLength,
    '配列要素の制約が落ちている',
  );
});

// **知らないキーワードは実行時まで気付けない。** strict が受け付けない語を SCHEMAS へ足すと
// 落ちるのは codex の 400 (= `codex exit 1`) で、テストは緑のまま通る。実測で受理を確かめた
// 語だけを許し、増えたらここで落とす (Opus2 指摘 2026-09-18)
const ACCEPTED_KEYWORDS = [
  'additionalProperties', 'description', 'enum', 'items', 'maxItems', 'maxLength',
  'minItems', 'minimum', 'properties', 'required', 'type',
];

test('strict 出力に出るキーワードは実測で受理したものだけ', () => {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      // properties のキーはプロパティ名なので数えない (値だけ潜る)
      if (key === 'properties') Object.values(value).forEach(walk);
      else if (key === 'items') walk(value);
    }
  };
  for (const kind of KINDS) walk(toStrictSchema(SCHEMAS[kind]));

  assert.deepEqual(
    [...found].filter((k) => !ACCEPTED_KEYWORDS.includes(k)).sort(), [],
    '実測していないキーワードが strict 出力に出ている (codex が 400 を返す語かもしれない)',
  );
  assert.deepEqual(
    ACCEPTED_KEYWORDS.filter((k) => !found.has(k)), [],
    '使われなくなった語が白リストに残っている',
  );
});

test('strict 変換は原スキーマを書き換えない (claude 側は同じ表をそのまま渡す)', () => {
  for (const kind of KINDS) {
    const before = JSON.stringify(SCHEMAS[kind]);
    toStrictSchema(SCHEMAS[kind]);
    assert.equal(JSON.stringify(SCHEMAS[kind]), before, `${kind} の原スキーマが変わった`);
  }
});

// ---- 戻り値の後始末 ----

/** 6 種すべての最小形 (nested・配列要素・任意キーの省略を含む) */
const SAMPLES = {
  delegation: {
    body: '依頼です',
    background: 'なぜ要るか',
    purpose: '何ができれば完了か',
    touch_set: ['src/a.js'],
    acceptance: ['npm test が通る'],
    stop_conditions: ['仕様に無い造形が要る'],
  },
  report: {
    body: 'やりました',
    changed_files: ['src/a.js'],
    did: ['直した'],
    verification: 'npm test 緑',
    remaining: [],
  },
  'case-turn': {
    body: '見ました',
    result: { observed: ['ログに 3 件'] },
    next: { plan: { kind: 'investigate', summary: '次はログを読む' } },
  },
  'task-proposal': {
    body: '2 件起票します',
    tasks: [
      { title: '直す', rationale: '壊れている', touch: ['src/a.js'] },
      { title: '足す', rationale: '欠けている', touch: ['src/b.js'], job_budget: 2 },
    ],
  },
  'task-approval': {
    body: '承認しました',
    approve: ['task-1'],
    drop: [{ id: 'task-2', reason: '重複' }],
  },
  // 任意キー (reason) を書いた形。書いた任意キーが strip で消えないことも一緒に見る
  'task-review': { body: '差し戻します', verdict: 'send-back', reason: '指摘 3 件' },
};

test('null 埋めで返ってきても、strip すれば原スキーマの形に戻る (6 種すべて)', () => {
  for (const kind of KINDS) {
    const sample = SAMPLES[kind];
    assert.ok(sample, `${kind} の標本が無い (種別が増えたら足すこと)`);
    // 前提: 標本そのものは様式に合っている
    const plain = validateContract(kind, sample);
    assert.equal(plain.ok, true, `${kind} の標本が不適合: ${plain.reason ?? ''}`);

    const filled = fillNulls(sample, SCHEMAS[kind]);
    // 前提: null 埋めのままでは通らない (だから strip が要る)
    assert.equal(validateContract(kind, filled).ok, false, `${kind}: null 埋めが素通りしている`);

    const stripped = stripNullOptionals(filled, SCHEMAS[kind]);
    assert.deepEqual(stripped, sample, `${kind}: 元の形に戻っていない`);
    assert.equal(validateContract(kind, stripped).ok, true, `${kind}: strip しても通らない`);
  }
});

test('strip: nested object と配列要素の中の null も削る', () => {
  const value = {
    body: 'x',
    tasks: [{ title: 't', rationale: 'r', touch: ['a'], job_budget: null }],
  };
  const out = stripNullOptionals(value, SCHEMAS['task-proposal']);
  assert.deepEqual(out.tasks, [{ title: 't', rationale: 'r', touch: ['a'] }]);

  const turn = stripNullOptionals({
    body: 'x',
    result: { artifact: null, observed: ['a'], claimed: null },
    next: { plan: { kind: 'investigate', summary: 's' }, waiting: null },
    claim: null,
    finding: null,
  }, SCHEMAS['case-turn']);
  assert.deepEqual(turn, {
    body: 'x',
    result: { observed: ['a'] },
    next: { plan: { kind: 'investigate', summary: 's' } },
  });
  assert.equal(validateContract('case-turn', turn).ok, true);
});

test('strip: 必須キーの null は残す (様式不履行を検査へ落とす)', () => {
  // ここで消すと「本文が無い応答」が「様式に合っている」に化ける
  const out = stripNullOptionals({ body: null, verdict: null, reason: null }, SCHEMAS['task-review']);
  assert.deepEqual(out, { body: null, verdict: null });
  assert.equal(validateContract('task-review', out).ok, false);
});

test('strip: 知らないキーと非オブジェクトはそのまま (落とすのは検査の仕事)', () => {
  const out = stripNullOptionals({ body: 'x', しらない: null, verdict: 'merge' }, SCHEMAS['task-review']);
  assert.deepEqual(out, { body: 'x', しらない: null, verdict: 'merge' });
  for (const value of [null, 'text', 42, true, []]) {
    assert.deepEqual(stripNullOptionals(value, SCHEMAS.report), value);
  }
  // スキーマが無ければ何もしない
  assert.deepEqual(stripNullOptionals({ a: null }, null), { a: null });
});
