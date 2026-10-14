/**
 * codex の `--output-schema` へ渡せる形への変換と、返ってきた値の後始末。
 *
 * **うちの `SCHEMAS` (src/contract.js) はそのままでは 400 になる。** codex は OpenAI の
 * structured outputs の strict 制約をそのまま通すので、実測 (codex-cli 0.154.0、2026-09-18)
 * で次の 3 つに落ちた:
 * - `'required' is required to be supplied and to be an array including every key in
 *   properties. Missing 'touch_restricted'` … **任意キーを required から外せない**
 * - `'minProperties' is not permitted` … 個数の下限・上限を書けない (case-turn の `next`)
 * - 任意キーを表す口が `required` から外すことではなく **`null` を許す型**になる
 *
 * そこで `toStrictSchema` が「全キー required + 任意キーは nullable」へ書き換え、
 * `stripNullOptionals` が返ってきた `null` を**原スキーマ基準で**削って元の形へ戻す。
 * 戻せば `validateContract` (src/contract.js) は無改修で通る — **様式の正本は 1 つ**の
 * ままにして、ランタイムの都合はこのファイルへ閉じ込める。
 *
 * `maxLength` / `maxItems` / `minItems` / `minimum` / `enum` / `description` は受理された
 * (実測) ので落とさない。説明文はモデルが読む面なので特に残す。
 *
 * **ここは純粋関数だけ・import なし。** 変換の正しさは表を読むだけで確かめられる状態に保つ。
 */

/** JSON Schema の節として扱えるか (配列と null を除いたオブジェクト) */
function isNode(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * strict では書けないキー。**黙って落とす** — 残すと 400 になり、
 * 「スキーマを渡した job だけ全部落ちる」という分かりにくい壊れ方をする。
 */
const UNSUPPORTED_KEYS = ['minProperties', 'maxProperties'];

/**
 * 任意キーの表し方を「required から外す」から「null を許す」へ移す。
 *
 * enum に `null` を足すのは、`type` だけ nullable にしても enum が閉じていると
 * モデルが null を返せなくなるため (値域の外になる)。
 *
 * **`type` の無い任意キーは落とす** (Opus2 指摘 2026-09-18)。黙って素通りさせると
 * strict 側では required のまま null も返せない節になり、**その任意キーが codex でだけ
 * 必須になる** — 原スキーマを足した時点では気付けず、実行時に 400 か不履行で出る。
 */
function nullable(node, path) {
  if (!isNode(node) || node.type === undefined) {
    throw new Error(
      `${path} は任意キーなのに type が無い — strict では「書かなくてよい」を type の null で`
      + '表すので、型の無い節は codex 側でだけ必須になる (原スキーマに type を書くこと)',
    );
  }
  const out = { ...node };
  if (typeof node.type === 'string') out.type = [node.type, 'null'];
  else if (Array.isArray(node.type) && !node.type.includes('null')) out.type = [...node.type, 'null'];
  if (Array.isArray(node.enum) && !node.enum.includes(null)) out.enum = [...node.enum, null];
  return out;
}

function convert(node, path) {
  if (!isNode(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYS.includes(key)) continue;
    // properties / required / items は下で組み直す
    if (key === 'properties' || key === 'required' || key === 'items') continue;
    out[key] = value;
  }
  if (node.items !== undefined) out.items = convert(node.items, `${path}[]`);
  if (isNode(node.properties)) {
    const required = Array.isArray(node.required) ? node.required : [];
    const properties = {};
    for (const [name, sub] of Object.entries(node.properties)) {
      const at = `${path}.${name}`;
      const converted = convert(sub, at);
      properties[name] = required.includes(name) ? converted : nullable(converted, at);
    }
    out.properties = properties;
    // **全キーを required に並べる** (strict の要求)。任意かどうかは nullable 側で表す
    out.required = Object.keys(properties);
    // 知らないキーを足させない。原スキーマも全 object でこう書いているが、
    // 書き忘れた節があっても strict 側では閉じる
    out.additionalProperties = false;
  } else if (Array.isArray(node.required)) {
    out.required = [...node.required];
  }
  return out;
}

/**
 * `SCHEMAS[kind]` を codex の `--output-schema` へ渡せる形にする。
 *
 * 原スキーマは変更しない (新しいオブジェクトを返す) — 同じ表を claude 側が
 * `--json-schema` でそのまま使い続けるため。
 *
 * @param {object} schema 原スキーマ (src/contract.js の SCHEMAS の 1 つ)
 * @param {string} [path] エラー文に出す経路 (入れ子の位置を示す)
 * @returns {object} strict 制約を満たすスキーマ
 * @throws {Error} 任意キーに `type` が無いとき (nullable にできない = codex で必須になる)
 */
export function toStrictSchema(schema, path = '$') {
  return convert(schema, path);
}

/**
 * strict スキーマの戻り値を原スキーマの形へ戻す。
 *
 * strict では任意キーも必ず生えてきて、値が無いときは `null` で返る
 * (nested も: report の `adjudication: null`、case-turn の `next.waiting: null`、
 * task-proposal の `tasks[].job予算: null` — いずれも実測)。`validateContract` は
 * null を通さないので、**原スキーマで任意のキーが null なら削る**。
 *
 * **required のキーの null は残す。** そこはモデルが埋めそこねた本物の不履行なので、
 * 黙って消すと「様式に合わない応答」が「合っている」に化ける — 検査へ落とさせる。
 *
 * @param {*} value codex が返した値 (JSON.parse 済み)
 * @param {object} schema **原**スキーマ (strict 変換前のもの)
 * @returns {*} 任意キーの null を除いた値
 */
export function stripNullOptionals(value, schema) {
  if (!isNode(schema)) return value;
  if (Array.isArray(value)) {
    return schema.items === undefined ? value : value.map((v) => stripNullOptionals(v, schema.items));
  }
  if (!isNode(value) || !isNode(schema.properties)) return value;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const out = {};
  for (const [key, sub] of Object.entries(value)) {
    const subSchema = schema.properties[key];
    // 知らないキーはそのまま残す (落とすのは検査の仕事)
    if (subSchema === undefined) {
      out[key] = sub;
      continue;
    }
    if (sub === null && !required.includes(key)) continue;
    out[key] = stripNullOptionals(sub, subSchema);
  }
  return out;
}
