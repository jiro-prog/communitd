# Contributing

**In English (summary).** communitd is a personal project shared in the open; the maintainer is
one person and the working language is Japanese. Issues and pull requests in English are welcome —
they will be answered in English. Before writing code, please **open an issue first** so we can
agree on the shape of the change; a PR that arrives without one may sit unanswered for a while.
Requirements: Node.js 20.6+ (the linter needs 20.19+ / 22.13+ / 24+), Git, and — to actually run
the bridge — a Claude Code subscription. Run `npm test` (Node's built-in runner, ~1800 cases) and
`npm run lint` before pushing; CI runs the tests on ubuntu and windows (Node 20 / 22) and the
linter on ubuntu. **Do not report security problems in a public
issue** — see [SECURITY.md](SECURITY.md). Contributions are accepted under the MIT license.

以下は日本語での案内です。

---

## このプロジェクトについて

communitd は Discord のメンションを、手元で動く Claude Code / Codex へ橋渡しするブリッジです。
**作者 1 人の個人プロジェクト**を公開している形で、開発の会話もコード内のコメントも日本語です。
英語の issue / PR も歓迎します (英語で返します)。

読むと早い順:

- [README.md](README.md) — 何ができるか・何が要るか
- [SETUP.md](SETUP.md) — 0 から一周する手順
- [docs/reference/](docs/reference/) — 権限の境界・運用の口・制御マーカーなどの参照

## まず issue を立ててください

コードを書く前に issue で**何を直したいか**を教えてください。このリポジトリは

- 権限の境界 (誰が何を実行できるか) が設計の中心で、
- 「動くようにする」変更が**安全側の前提を静かに壊す**ことがある

ため、変更の形をすり合わせてから書くほうが、お互いの手戻りが少なくて済みます。
issue テンプレートは「バグ報告」と「機能の提案」の 2 種類です。

**脆弱性は公開 issue に書かないでください。** 報告先は [SECURITY.md](SECURITY.md) にあります。

## 開発環境

| 要るもの | 版 | 備考 |
| --- | --- | --- |
| Node.js | 20.6 以上 | ブリッジ本体の要件 (`package.json` の `engines`) |
| Node.js (lint) | 20.19 以上 / 22.13 以上 / 24 以上 | eslint 10 の要件 (21.x と 22.0〜22.12 は対象外)。テストだけなら 20.6 で足りる |
| Git | — | 作業ツリーの作成に `git worktree` を使う (版の下限は決めていません) |
| Claude Code | — | **実際にブリッジを動かすとき**だけ。テストと lint には要らない |

```sh
git clone https://github.com/jiro-prog/communitd.git
cd communitd
npm ci
npm test
npm run lint
```

テストと lint は**設定ファイルも Discord トークンも無しで通ります** (実際に起動するまでの
手順は SETUP.md)。

## テスト

```sh
npm test          # Node 組み込みのランナー。全部で 1800 件強・1 分前後
```

- テストは `test/*.test.js`。**実行の入口は `scripts/test.mjs`** です — シェルやバージョンに
  よって glob の展開が変わり、展開できないと「0 件のまま成功」になるため、入口を固定しています。
- CI は `ubuntu-latest` × `windows-latest` × Node 20 / 22 の 4 通りを回します。
  **パスの意味論の違いは実際に出ます** (Windows で通って Linux で落ちた事例が公開初日にあります)。
  片方の OS でしか通らない書き方をしたら、その場で気づけるようにするための構成です。
- 外部サービスを叩くテストはありません。子プロセスを起こすテストはありますが、
  実際の `claude` / `codex` は呼びません (偽物を注入します)。

**新しい振る舞いにはテストを付けてください。** このリポジトリのテストは「何が起きるか」より
**「なぜそうでなければいけないか」**を書く場所でもあります (既存のテスト名を見ると雰囲気が
つかめます)。

## lint

```sh
npm run lint      # eslint (flat config) + 文書への参照チェック
```

- 規則は `@eslint/js` の recommended だけで、**整形規則は入れていません** (formatter も
  入れていません)。整形の差分が混じると、PR で何が変わったのかが読めなくなるためです。
  インデントや引用符の好みで指摘することはありません。
- 規則を外すときは**インラインの `eslint-disable-next-line` に理由を書いてください**。
  設定ファイル側で丸ごと切るのは、その規則がこのリポジトリの書き方と根本的に合わないとき
  だけにしています (`eslint.config.js` の冒頭にその判断を書いています)。
- lint は続けて `scripts/check-doc-refs.mjs` (単独なら `npm run check:docs`) を回し、Markdown の
  相対リンクと、`src/`・`scripts/` に書いた `docs/*.md` が**追跡しているファイルを指しているか**を
  見ます。公開されていない文書を出典に書くと、読む人には行き止まりになるためです。

型検査 (`tsc --checkJs`) は**まだ導入していません**。`jsconfig.json` は置いてあるので
エディタの補完は効きますが、CI には入れていません (現状 3000 件超の指摘が出ます。
ほとんどは JSDoc の書き方の問題で、実バグではありません)。

## コードの流儀

このリポジトリ固有の約束です。合わせてもらえると読みやすくなります。

- **コメントには「なぜ」を書く。** 何をしているかはコードが語るので、コメントは
  「なぜこの順番なのか」「なぜここで倒すのか」を残す場所にしています。日本語で構いません。
- **副作用は注入する。** git・fs・子プロセス・Discord は呼び出し側から渡し、
  判断の層は純粋関数に切ってあります (テストが実物を叩かずに順番まで固定できます)。
- **迷ったら安全側へ倒す (fail-closed)。** 設定が読めない・検証できない・権限が決まらない
  ときは「通さない」を既定にしています。
- **秘密を出力に混ぜない。** トークンは子プロセスの環境変数から除去し、ログにも Discord にも
  値や長さを出しません。

## PR を出すとき

- コミットメッセージは**何を・なぜ**を 1 行目に。本文で背景を書くのは歓迎です (日本語・英語可)。
- `npm test` と `npm run lint` が通っていること。CI でも回ります。
- 振る舞いが変わる変更は [CHANGELOG.md](CHANGELOG.md) の `Unreleased` に 1 行足してください。
- **触らなくてよいもの:** `config.policy.json` (作者の実運用設定)、`roles/*.md` (bot の役割文)、
  `docs/` のうち `docs/reference/` 以外 (内部の記録)。これらは公開スナップショットには
  含まれないか、作者の運用に直結しています。

## ライセンス

MIT ([LICENSE](LICENSE))。PR を出した時点で、その変更が MIT で配布されることに同意したものと
します。
