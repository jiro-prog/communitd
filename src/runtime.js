/**
 * ランタイム (どの CLI で走るか) ごとの**能力**の表。
 *
 * この repo は長らく「`runtime === 'codex'` か否か」を能力の代わりに使ってきた
 * (16 箇所 / 9 ファイル)。名前で聞くと**能力が 1 つ変わっただけで全箇所を探し直すことになる** —
 * codex が `--output-schema` を持てば構造化出力の可否だけが反転し、verify をブリッジ側の段へ
 * 移せば hook の有無だけが要らなくなるのに、名前比較は「codex は全部できない」を 1 語へ
 * 畳んでいるので、どの箇所がどの能力を見ているのか読んで判別するしかない。能力ごとの列に
 * 開いておけば、変わった能力の列を 1 つ書き換えるだけで済む。
 *
 * **ここは能力の表と解決だけ。** 実際にどう起動するか (引数・spawn) は src/claude.js と
 * src/codex.js が持ち、この表はそれを参照するだけで実行はしない (副作用なし)。
 *
 * **書いてよいのは「そのランタイムにできるか」だけ。** 配備の設定で切れるもの
 * (チャンネルの `structuredOutput`、claude 側 settings の `permissions.deny`、
 * codex の sandbox) は能力ではないので混ぜない — 混ぜると「できるはずなのに切ってある」と
 * 「そもそもできない」が同じ false になり、案内の文面が書けなくなる。
 */

import { CLAUDE_EFFORTS } from './claude.js';
import { CODEX_EFFORTS } from './codex.js';
import { PI_EFFORTS } from './pi.js';

/**
 * @typedef {object} RuntimeCapabilities
 * @property {string} name 表のキーそのもの (`runtimeOf` の戻り値と一致する)
 * @property {boolean} resume セッション id を控えて次の job も同じセッションを続けられるか。
 *   claude は `--resume` を持ち、sessions.json (src/store.js) に控える。codex はステートレスで、
 *   文脈は毎回スレッド transcript の再構成で渡す (src/bridge/job.js)
 * @property {boolean} schema 構造化出力を受け取れるか。契約 (report / delegation)・duty の発議・
 *   裁定はすべてこれで回収するので、**持たないランタイムには duty も裁定権も持たせられない**
 *   (src/contract.js・src/society-policy.js が起動時に落とす)。**渡し方はランタイムで違う** —
 *   claude は `--json-schema` に原スキーマをそのまま、codex は `--output-schema` に
 *   strict 変換したもの (全キー required + 任意は nullable — src/strict-schema.js)
 * @property {boolean} pathScopedPermissions `allowedTools` と `permissionMode` で**パス単位に**
 *   書込みを絞れるか (契約の touch 制限)。codex は sandbox の 2 値 (read-only /
 *   workspace-write) しか持たず、作業ツリー全体か何も書けないかの粒度になる
 * @property {boolean} hooks Stop / PreToolUse hook を差し込めるか (src/hooks.js)。
 *   **verify そのものはランタイムを問わず走る** — ブリッジ側の最終検証 (src/bridge/job.js)
 *   が hook の結果が無ければ 1 回実行するため。この列が言うのは「同一セッション内で
 *   差し戻せるか」と「ツール承認カードを出せるか」で、false のランタイムでは
 *   **1 回目の verify NG がそのまま最終 NG**になる。pi は差し戻しだけを拡張で持つ
 *   (src/pi-extension.js)。実行中の承認カードは claude だけ
 * @property {boolean} subagent Agent ツール (subagent) を持つか
 * @property {readonly string[]} efforts `bots.<key>.effort` に書ける値。**値域の正本は
 *   src/claude.js と src/codex.js の 1 箇所ずつ**で、ここは runtime で引き分けるだけ
 * @property {readonly string[]} optionalBotKeys `BOT_REQUIRED_KEYS` (src/config.js) のうち、
 *   このランタイムでは省略できるキー
 * @property {boolean} instructionsFile `bots.<key>.codexInstructionsFile` の配線があるか
 *   (組み込み指示の差し替え — src/codex.js)。配線の無いランタイムで書かれたら起動時に落とす
 * @property {boolean} intake 受付 bot (`bots.<key>.intake` — docs/notes/2026-10-11-intake.md) を担えるか。
 *   受付は通常の job を通らず、ランタイムを直接呼ぶ (src/bridge/intake.js)。配線は claude だけ
 */

/**
 * ランタイム名 → 能力。**凍結する** — 実行中に書き換わると、同じ job の中で
 * 「できる / できない」が入れ替わり、権限の案内と実際の権限がずれる。
 *
 * `Object.freeze` は 1 段しか凍らせないので、中身の配列も凍っていること
 * (`efforts` は正本の src/claude.js・src/codex.js 側で凍らせてある — Opus2 指摘 2026-09-18)。
 *
 * @type {Readonly<Record<string, RuntimeCapabilities>>}
 */
export const RUNTIMES = Object.freeze({
  claude: Object.freeze({
    name: 'claude',
    resume: true,
    schema: true,
    pathScopedPermissions: true,
    hooks: true,
    subagent: true,
    efforts: CLAUDE_EFFORTS,
    optionalBotKeys: Object.freeze([]),
    instructionsFile: false,
    intake: true,
  }),
  codex: Object.freeze({
    name: 'codex',
    resume: false,
    // P-3 (2026-09-18) で `--output-schema` を配線した。strict 制約があるので原スキーマは
    // そのまま渡せないが、変換と null の後始末は src/strict-schema.js に閉じている
    schema: true,
    pathScopedPermissions: false,
    hooks: false,
    subagent: false,
    efforts: CODEX_EFFORTS,
    // codex の `-m` は条件付きで渡すので、書かなければ codex 側の既定モデルで走る
    optionalBotKeys: Object.freeze(['model']),
    instructionsFile: true,
    intake: false,
  }),
  // pi (docs/reference/pi-runtime.md)。権限・差し戻し・構造化出力は claude と同じ設定を
  // job ごとの拡張 (src/pi-extension.js) で効かせる。この版はセッションを残さない
  // (文脈は codex と同じく毎回スレッド transcript の再構成)
  pi: Object.freeze({
    name: 'pi',
    resume: false,
    // 道具 `submit_report` の引数のスキーマとして渡す (pi は素の JSON Schema を検証する)
    schema: true,
    // allowedTools / permissionMode / 契約の絞り込みを拡張が道具の呼び出しごとに照合する
    // (src/pi-policy.js)。パス限定の Edit は touch 集合と同じ関数で完全一致だけを通す
    pathScopedPermissions: true,
    hooks: true,
    subagent: false,
    efforts: PI_EFFORTS,
    optionalBotKeys: Object.freeze([]),
    instructionsFile: false,
    intake: false,
  }),
});

/** `bots.<key>.runtime` を書かなかった bot が走るランタイム */
export const DEFAULT_RUNTIME = 'claude';

/**
 * `bots.<key>.runtime` に書ける値 = 表のキー。src/config.js が同じ名前で再輸出する
 * (設定の検証はそちらから引く)。
 */
export const BOT_RUNTIMES = Object.freeze(Object.keys(RUNTIMES));

/**
 * bot 設定 (または runtime 名) を表のキーへ解決する。**知らない綴りは既定へ倒す。**
 *
 * 倒してよいのは、綴り違いを起動時の検証 (src/config.js の `BOT_RUNTIMES`) が落としている
 * から。ここまで届く不明値は「設定に無い bot」や実行時に欠けた値なので、例外を投げるより
 * 既定で走らせるほうが安全側になる (従来の `runtime === 'codex' ? 'codex' : 'claude'` と
 * 同じ結果)。**倒す先を 1 箇所にしておくのが要点** — 散らばった `?? 'claude'` は、
 * 表に 3 つ目のランタイムが載った日に全部が黙って claude 扱いのまま残る。
 *
 * @param {{runtime?: string}|string|null|undefined} botOrName bot 設定か runtime 名
 * @returns {string} 表のキー
 */
export function runtimeOf(botOrName) {
  const name = typeof botOrName === 'string' ? botOrName : botOrName?.runtime;
  return Object.hasOwn(RUNTIMES, name) ? name : DEFAULT_RUNTIME;
}

/**
 * その bot (または runtime 名) の能力。
 *
 * 文字列も受けるのは、runtime 名しか手元に無い呼び出し側があるため
 * (src/rolecontext.js の `describeWriteAccess` / `describeSubagentAccess`、
 * src/contract.js の `resolveContractKind`)。
 *
 * @param {{runtime?: string}|string|null|undefined} botOrName
 * @returns {RuntimeCapabilities}
 */
export function capabilitiesOf(botOrName) {
  return RUNTIMES[runtimeOf(botOrName)];
}

/**
 * その runtime 名がその能力を**持つと表に書いてあるか**。**知らない綴りは false。**
 *
 * `runtimeOf` / `capabilitiesOf` と規則が違うのが要点。あちらは不明値を既定 (claude) へ
 * 倒すので、知らない runtime は**能力を持っている扱い**になる。権限を絞れるかどうかの
 * 判定でそれをやると「絞れるか分からない担当へ touch 制限つきで委譲する」という最悪の
 * 食い違いになるので (src/contract.js の `canDelegateTo`)、**権限側は fail-closed**。
 *
 * だから `=== true` と `Object.hasOwn` の両方が要る — `RUNTIMES[name]?.[cap]` の否定形へ
 * 書き換えると、`'__proto__'` のような継承経由のキーや綴り違いが許可側へ倒れる
 * (Opus2 指摘 2026-09-18)。
 *
 * @param {string|null|undefined} name runtime 名 (未指定は既定のランタイム)
 * @param {string} capability 能力の列名 (`RuntimeCapabilities` のキー)
 * @returns {boolean} 表に `true` と書いてあるときだけ true
 */
export function canRuntime(name, capability) {
  const key = name ?? DEFAULT_RUNTIME;
  return Object.hasOwn(RUNTIMES, key) && RUNTIMES[key][capability] === true;
}
