// ESLint (flat config)。
//
// **見るのは「動かないコード」だけ。** 整形規則は入れない (formatter も入れない) —
// 整形の差分が混じると、外から来た PR で「何が変わったか」が読めなくなる。
// 規則は `@eslint/js` の recommended をそのまま使い、この repo 固有の足し引きは
// **理由を書けるものだけ**に留める。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // 追跡していない置き場は見ない (.gitignore と同じ顔ぶれ)。
    // node_modules と .git は flat config の既定で除外される
    ignores: [
      'data/**',
      'sandbox/**',
      'tmp/**',
      '.worktrees/**',
      '.tmp-openai-docs-cache/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // 使わない値を**書いてあること自体**で示す形は、この repo では意図的に使う:
      //   - `const { secret, ...rest } = obj` … 「これを除いた残り」を作る
      //   - `_` で始まる引数・変数 … 「位置は要るが読まない」
      // どちらも「消し忘れ」ではないので、名前の付け方で意図を表せるようにする。
      // catch の束縛は既定 (all) のまま — 握りつぶすときは `catch {}` と束縛なしで書く流儀
      // なので、`catch (err) {}` で err を落とす書き方を素通りさせない
      'no-unused-vars': ['error', {
        ignoreRestSiblings: true,
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // `no-irregular-whitespace` は既定のまま (テンプレートリテラルも見る)。
      // Discord の字下げ (U+3000) や不可視文字の検体を意図して書く箇所は 3 行だけなので、
      // 設定で丸ごと外さず、その行にインラインで理由を書く — U+00A0 / U+FEFF の
      // 貼り付け事故はテンプレートリテラル (コマンドやパスも組む) でこそ拾いたい
    },
  },
];
