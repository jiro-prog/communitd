# communitd

Discord のメンションで、ローカルの Claude Code エージェントに仕事を振るブリッジ。
`community` + `-d` (`httpd` / `sshd` の d、そして Discord の d) — bot たちの共同体を常駐させる。

*English: [README.en.md](README.en.md)*

## これで何ができるか

- **頼む → 実装 → 検証 → 検収済みの成果**が Discord のスレッドの中で一周する。人間がするのは依頼と裁定だけ。
- **止まった仕事が見つかる。** job ごとの実行記録から「実行中 / 承認待ち / 返信待ち / 復旧待ち」を `/inbox` と `/status` に並べ、`/retry` で同じスレッド・同じブランチの続きとして起こし直せる。
- **働く様子が残る。** 相談・委譲・検収・ツールの軌跡・verify の結果がスレッドに残る。

## 必要なもの

- **Claude のサブスク (Pro / Max など) が要る。** ブリッジはローカルの `claude` CLI を起動して
  **その認証をそのまま使う** — API キーは要らないが、**課金なしでは動かない**
- **Node.js 20.6 以上** / **`git`** / **`claude` CLI が認証済み** (`claude -p "test"` が応答すること)
- **`codex` CLI** は reviewer 役 (codex ランタイム) を使うときだけ。使わないなら不要
- **Discord のサーバー 1 つ** (自分が管理者であること) と、そこへ招待する bot アプリ 2 つ
- **OS**: Windows 11 で検証済み。macOS / Linux はコード上分岐済みだが**実機未検証** (CI は ubuntu で緑)
- 設定は 3 ファイル。同梱の例をコピーして埋める:

  | ファイル | git | 必須キー |
  | --- | --- | --- |
  | `config.policy.json` | 追跡する | `bots.<key>.tokenEnv` / `displayName` / `rolePromptFile` / `model` (claude のとき必須)、`channels.<name>.cwd` |
  | `config.secrets.json` | 追跡しない | `guildId` / `allowedUserIds` |
  | `.env` | 追跡しない | `tokenEnv` に書いた変数名すべて |

- **`config.policy.json` の例は 2 つある。** `config.policy.example.json` は**写しただけで安全寄り**
  (`"tools": "readonly"` / `"permissionMode": "default"` — エージェントは読むだけで、書込みもシェルも
  しない)。書込みと `git`/`node`/`npm` のシェルを許した開発用は
  `config.policy.dev.example.json` で、**そちらは明示的に選ぶ** (SETUP.md §0)。分けてあるのは、
  「既定が安全寄り」と「同梱の例を写せば安全寄り」が別のことだから
  → [セキュリティモデル](docs/reference/security-model.md)
- 起動前に **`npm run doctor`** — Discord もモデルも動かさずに設定・CLI・作業ディレクトリを診断する。
  ❌ が 1 件でもあれば起動しても失敗する
- 手順の全文は **[SETUP.md](SETUP.md)**。`allowedUserIds` に載せる人は**この PC でコマンドを実行できるのと
  同じ**なので、そこだけは読んでから決めること

## 最小の使い方

1. [SETUP.md](SETUP.md) §0〜§3 のとおり bot 2 体 (manager / worker) とチャンネル 1 つを作り、`npm start`。起動前に `npm run doctor` で設定・CLI・作業ディレクトリを読み取りだけで診断できる。
2. そのチャンネルで `@Manager hello.txt に「こんにちは」と書くタスクを Worker に委譲して`。manager が委譲 → worker が実装 → manager が検分して報告、まで自動で回る (SETUP.md §4)。
3. 成果はファイルと、スレッドの `📋 git status 差分` / `🔧 ツール軌跡` / verify の行で確かめる。接続できただけでは一周ではない。
4. 自律運転 (エージェントが自分で起票・実装・レビュー・merge) と独立 reviewer は、その後に `autonomy` を書いて始める (SETUP.md の「高度な運用」)。

**実験的・非対応の機能:** bot が役割文・設定・手順書の変更を提案し、裁定を経てブリッジ自身が当てる
**発議と組織提案** (`initiative` / `/proposals`) は公開版ではサポートしない (既定で無効)。ブリッジが自分の
権限設定を書き換えられる経路なので、使うなら先に [セキュリティモデル](docs/reference/security-model.md#発議と組織提案-実験的非対応) を読むこと。

## 仕組み

```
人間 ──@メンション──▶ manager: 課題を把握・分解 ──[[handoff:worker]]──▶ worker: 実装
                          ▲                                                │
                          └─────────── [[handoff:manager]] (検収依頼) ◀─────┘
```

- **チャンネル = プロジェクト、スレッド = 仕事の単位。** チャンネル名から作業ディレクトリと権限を引き
  (`config.policy.json` の `channels`)、@メンションでスレッドが生え、スレッド × bot ごとに claude
  セッションを保持する (2 回目以降は `--resume` で会話が続く)
- **役割文は 3 段**: 全 bot 共通の `roles/_common.md` → bot ごとの `roles/<役>.md` → job ごとに
  ブリッジが生成する**実行文脈** (権限・編成・作業ディレクトリ)。食い違ったら実行文脈が正しい —
  「誰が居るか」「何が書けるか」を役割文に書くと、設定を変えた瞬間に役割文が嘘をつくため
- **役の名前は役割文のファイル名**。`roles/worker.md` を指す bot は `worker` 役で、実行文脈の
  「呼べる相手」にその名前が添えられる (`[[handoff:worker]] Worker (worker)`)
- **bot が誰かを呼べるのは制御フッターだけ。** 応答末尾の独立行 `[[handoff:<bot キー>]]` /
  `[[notify:owner]]` が唯一の起動経路で、本文中の平文の `@名前` は変換しない (例文や引用での暴発を
  止めるため)。bot 間ホップは既定 12 回で止まり、人間が発言するとリセットされる
  → [制御マーカー](docs/reference/control-markers.md)
- **委譲は構造として渡る。** 委譲の 5 部 (背景 / 目的 / touch 集合 / 受入基準 / 停止条件) を
  `--json-schema` で受け取り、**touch 集合をそのまま受け手の実権限へ変換する** — 規律ではなく機構で
  集合の外を編集させない → [委譲契約](docs/reference/delegation-contract.md)
- **完了時の機械検証**: チャンネルに `"verify": "npm test"` を書くと Stop hook で実行し、NG は同一
  セッションへ差し戻す (既定 1 回)。最終 NG なら結果を投稿して handoff を止める
- **job は作業ディレクトリごとに直列・別ディレクトリなら並走。** 同じ git ツリーを 2 本の job が
  同時に触らないようにしつつ、別プロジェクトの依頼は待たされない
- コードの層は 3 つ: `src/*.js` = 判断 (純粋関数・単体テストの対象) / `src/bridge/*.js` = 配線
  (Discord・git・子プロセスを結ぶ。依存はすべて注入で受けるので偽物で試せる) / `src/index.js` =
  組み立て (設定の検証・台帳・配線の順序だけ)

## セキュリティモデル

**このブリッジは「Discord のメッセージ」を「ローカルマシンでのコマンド実行」に変換する。**
権限設計はこの一点を前提に読んでほしい。

- **許可ユーザー = あなたの OS アカウントと同等の権限。** `allowedUserIds` に載せた人は、そのチャンネルの
  `cwd` 配下でファイルを読み書きし、許可されたシェルコマンドを走らせられる
- **`guildId` と `allowedUserIds` は必須。** どちらかが空なら起動時に終了する (設定漏れを「制限なし」と
  解釈しない)
- **既定は最小権限。** `tools` を書かなければ `readonly`、`permissionMode` を書かなければ `default`。
  書込みやシェルを伴う設定は明示したチャンネルだけで有効
- **権限が増えるのは人間がボタンを押したときだけ。** エージェントは申請しかできず、恒久承認に向かない
  要求 (シェル全許可・wildcard・`cwd` 外・秘密混じり) はそもそも申請にならない
- **prompt injection の経路がある。** スレッド本文・引用・添付 (画像の中の文字も、テキストファイルの
  中身も) はほぼそのままモデルへ渡る。とくに **WebFetch / WebSearch と書込み権限を同じチャンネルに
  同時付与すると、外部ページの文言でローカルの改変や情報の外部送信が起こせる**
- **agent 定義ファイル (`.claude/agents/*.md`) は設定ではなくコードに近い信頼対象。** 権限・使えるツール・
  作業場所・実行経路・永続状態を動かせるので、出どころを信頼できるものに限ること
- **公開・共有サーバーでの運用は `readonly` を推奨。** 書込みが必要なら bot とチャンネルを分け、`cwd` を
  専用の作業ツリーに閉じる

全文と根拠は → [セキュリティモデル](docs/reference/security-model.md)

## スラッシュコマンド

起動中の**全 bot に登録**される (停止は緊急操作なので、1 体が落ちていても別の bot 経由で打てる)。
state はプロセス共有なので、どの bot のコマンドを選んでも結果は同じ。

| コマンド | 何をするか |
| --- | --- |
| `/stop` | 実行中の job を止める (Claude Code の Esc 相当)。`scope:all` で全体停止 |
| `/roster` | このスレッドで呼べる bot を絞る (省略すると現在の編成を表示) |
| `/pause` | 自律運転を止める (人間のメンションは通る・実行中の job も止めない) |
| `/resume` | 自律運転を再開する |
| `/proposals` | 組織提案の一覧を出す (id を指定すると裁定カードを出し直す)。**実験的** — `initiative` を有効にしたときだけ意味を持つ |
| `/inbox` | 作者を待っているもの (停止・質問 / 稟議 / 要人間) を一覧する |
| `/review` | review のまま止まったタスクのレビューを出し直す (タスクのスレッドで打つ) |
| `/status` | このチャンネルの状況 (過去 24h の完了 / 進行中 / 復旧待ち / 判断待ち / 運転) を出す |
| `/retry` | 止まったタスクを同じ仕事の続きとして起こし直す (タスクのスレッドで打つ) |
| `/case` | 自律社会の案件を見る / 開く / 相談を出す / 再開する |
| `/restart` | ブリッジを再起動する (作業ツリーの現在のコードと `.env` を反映) |

## 起動

```
cp .env.example .env   # トークンを記入 (SETUP.md)
npm ci
npm run doctor
npm start
```

設定は 2 ファイルに分かれている: **git 管理する** `config.policy.json` (bot・channel・権限・予算などの
非秘密設定) と、**gitignore する** `config.secrets.json` (`guildId` / `allowedUserIds` / `ownerUserId` /
`ownerNames`)。起動時に 1 枚の config へ合成し、secrets 側に allowlist 外のキーがある・両方に同じキーが
ある・どちらかが読めない場合は起動しない。分けてあるのは、採択された組織提案の diff をブリッジが policy へ
当てる回路があるため — policy が追跡可能でないと差分も巻き戻しも作れず、裁定権者 (`ownerUserId` /
`ownerNames`) を secrets 側に固定しておかないとその回路から書き換えられてしまう。

`npm start` は再起動ラッパー (`scripts/run.mjs`) 経由で本体を起動する。`/restart` を打つと本体が終了
コード 42 で終わり、ラッパーが spawn し直す (コードと `.env` を読み直す)。クラッシュ (42 以外) では
再起動しない — 暴走ループと二重ログインを防ぐため。

プロジェクトを増やすときは `npm run add-project` — 対話で作業ディレクトリを確認し、`config.policy.json`
の `channels` に追記して起動時と同じ検証まで通す。Discord のテキストチャンネルも同時に作る (同名があれば
再利用。作成担当は `config.bots` の先頭の bot で、その bot のロールに「チャンネルの管理」が要る)。
**`config.policy.json` 全体が 2 スペース整形で書き直される**点に注意 (値は変わらない)。

テストは `npm test` (node:test・追加依存なし)。push / PR では Node 20・22 で CI が回る。

## ドキュメント

- [SETUP.md](SETUP.md) — 0 から一周するまでの手順。まずこれ
- [セキュリティモデル](docs/reference/security-model.md) — 権限の境界と、そこに置いた歯止め
- [運用の口](docs/reference/operations.md) — 何が job を起こし、どう並び、どのコマンドで止め直せるか
- [ツール権限の申請](docs/reference/tool-permissions.md) — 足りない許可を Discord のボタンで足す
- [制御マーカー](docs/reference/control-markers.md) — `[[handoff:…]]` / `[[notify:owner]]` / `[[attach:…]]`
- [委譲契約](docs/reference/delegation-contract.md) — 委譲の 5 部と touch 集合 → 実権限
- [codex ランタイム](docs/reference/codex-runtime.md) — codex exec で動く bot と、組み込み指示の差し替え
- [参照ディレクトリ](docs/reference/add-dir.md) — 作業ディレクトリの外を読ませる口
- [添付](docs/reference/attachments.md) — 画像とテキストファイルの上限と扱い
- [ツール軌跡](docs/reference/tool-trace.md) — job が実際に呼んだツールを残す
- [計測ログ](docs/reference/metrics.md) — 所要時間とトークン使用量
- [prompt cache の維持](docs/reference/prompt-cache.md) — 会話キャッシュを job 境界で壊さない
- [SECURITY.md](SECURITY.md) — 運用上の注意と、脆弱性の報告先 (公開 issue には書かない)
- [CONTRIBUTING.md](CONTRIBUTING.md) — issue / PR の出し方、テストと lint の回し方、コードの流儀
- [CHANGELOG.md](CHANGELOG.md) — 版ごとの変更

## 制約・既知の注意

- Discord の 1 メッセージ 2000 字制限。長文は分割送信される (`src/text.js`)。コードブロックをまたぐ
  境界では閉じフェンスと開き直しを補うので表示は崩れないが、**1 つのブロックが複数メッセージに割れる**
  ことはある
- GIF は受信・送信とも非対応。アニメーションの解釈がランタイム依存で「静止画」として扱えると言い切れない
  ため、初版では拒否している
- 転送されるのは本文・画像・テキストファイルのみ。動画・音声・書庫などの添付はモデルへ渡らない
  (件数だけ伝える)
- 並列は作業ディレクトリのレーン数が上限。サブスクのレート上限は全 job で共有するため、同時に走らせ
  すぎると各 job が遅くなる・失敗することがある。その場合は `limits.maxConcurrentJobs` で絞る
- **同じ作業ディレクトリで対話セッションを並走させると衝突しうる。** 役割文では commit 前の
  `git status` 確認を義務づけているが、大きな作業を同時に走らせない運用が前提
- macOS / Linux は**実機未検証** (コード上は分岐済み・CI は ubuntu で単体テストが緑)

## ライセンス

MIT — [LICENSE](LICENSE)
