# Changelog

このファイルの書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従う。

## [Unreleased]

### Changed

- **発議と組織提案 (`initiative` / `/proposals`) を「実験的・非対応」と明記した。** README (日英) に注記を置き、
  [セキュリティモデル](docs/reference/security-model.md) に一節を足した — 誰が何を裁定するか、機構で
  閉じていること、残っているリスク (裁定カードに差分が出ないこと、`config.policy.json` への提案の採択は
  権限の付与と同じであること、適用回路のチャンネルがブリッジ自身のリポジトリを `cwd` にするので
  `.env` が読めること)。コードは変えていない。

### Fixed

- **コードとテストのコメントが、公開されていない設計文書を出典に指していた。**
  `docs/social-engineering.md` などへの参照 (テストの架空のパスを除いて約 90 行) と、文書名なしの
  章番号 (`§3.9` など、約 600 箇所) を取り除いた。出典を外すと意味が通らない箇所は本文を書き直した。
  利用者に見える文言も同じ文書を名指ししていたので直した — タスク・提案の遷移違反のエラーは
  実装側の遷移表の名前 (`TRANSITIONS` / `PROPOSAL_TRANSITIONS`) を指し、`kt-metrics` の注記は
  出典を外した。

### Changed

- **`src/config.js` (1600 行強) を項目ごとの `src/config-*.js` に分けた。** 設定ファイルの読み込み
  (`config-sources`)・チャンネル (`config-channel`)・自律運転 (`config-autonomy`)・上限
  (`config-limits`)・bot (`config-bots`)・発議 (`config-initiative`)。`src/config.js` は窓口として
  全部を再公開するので、読み込む側は変わらない。`validateConfig` は `validateBots` /
  `validateLimits` / `validateChannel` を順に呼ぶ形になったが、エラーの内容と順序は変えていない
  (旧実装と 2 万通りの設定で突き合わせて一致)。

### Added

- **型検査を段階的に入れた (`npm run typecheck`、CI の lint job でも回る)。** TypeScript の
  `tsc` で、**先頭に `// @ts-check` を付けたファイルだけ**を `strictNullChecks` 付きで見る
  (`tsconfig.check.json`)。まず `src/` と `scripts/` の 38 ファイルに付けた。付けるために JSDoc を
  実際の形に合わせた (`let x = null` の型、`@param {object}` の中身、`ok` で分かれる戻り値など)。
  コードの変更は型のための言い換えだけで、振る舞いは変えていない。
- **`npm run lint` が文書への参照も見る** (`scripts/check-doc-refs.mjs`、単独なら
  `npm run check:docs`)。Markdown の相対リンクと、`src/`・`scripts/` に書いた `docs/*.md` が
  追跡しているファイルを指していなければ落とす。

## [0.1.6] - 2026-09-12

### Changed

実際に第三者の手順どおり (clone → 例をコピー → bot 2 体 → 一周) 導入して詰まった所の反映。

- **`npm run doctor` が「設定例のまま」の値を ❌ にする。** `guildId` / `allowedUserIds` /
  `ownerUserId` の `000000000000000000` と、`channels.<name>.cwd` の `C:/path/to/your/project` は
  非空の文字列なので起動時の検証を通ってしまう。そのまま起動すると**スラッシュコマンドの登録が
  `Missing Access` で落ち、メンションは全部拒否される**のに、ログからは設定の取り違えだと
  読み取れなかった。スラッシュ登録の失敗にも「guildId が設定例のまま」と名指しする案内を足した。
- **未登録チャンネルの警告に、今のチャンネル名と登録されている名前を並べる。**
  「未登録です」だけでは、綴り違いなのか場所違いなのかが Discord 側から分からなかった。
  判定は完全一致・スレッドは親チャンネルの名前、という判定そのものも文面に書く。
- **`/status` の運転の行を、自律運転を設定していないチャンネルでは「未設定」と書く。**
  従来は kill switch の状態 (`▶️ 自律運転は動いています`) をそのまま出していたので、
  メンションでしか動かないチャンネルでも「動いている」と読めた。止められているときは
  未設定でも状態を出す。
- SETUP.md: §0 の `cp` は初回だけ (写し直すと `cwd` と ID が例に戻る) / §3 の doctor の出力例を
  実物に更新 / §5 の一周の確認を `/status` の実態に合わせ、トラブルシューティングに
  `Missing Access` と「同じサーバーで 2 つのブリッジを動かしたとき」を追加。

## [0.1.5] - 2026-09-12

### Added

- **lint を足した (`npm run lint`)。** eslint の flat config で `@eslint/js` の recommended だけを
  使い、**整形規則は入れていない** (formatter も入れていない) — 整形の差分が混じると、外から来た
  PR で何が変わったのかが読めなくなるため。CI に lint job を 1 つ足した (ubuntu / Node 22)。
- **CONTRIBUTING.md と issue テンプレート** (バグ報告 / 機能の提案 + 脆弱性を SECURITY.md へ
  誘導する `config.yml`)。README と README.en から辿れる。
- **`jsconfig.json`** — エディタが JSDoc から型を推論できるようにする調査用の設定。
  **CI には入れていない** (`tsc --checkJs` は現状 3000 件超の指摘が出る。ほとんどは JSDoc の
  書き方の問題で実バグではない)。

### Fixed

- **ブリッジを止めても、適用回路 (org-apply) の `verify` だけが止まらなかった。** 走っている
  検証に停止の口 (`handle`) を渡しておらず、SIGINT / SIGTERM / SIGHUP / `/restart` で終了しても
  `npm test` の子ツリーが自前の 10 分タイムアウトまでブリッジより長生きしていた
  (「停止はプロセスツリーごと」がこの経路だけ成り立っていなかった)。停止経路から撃てるようにし、
  撃った後は**次の tick で新しい適用を始めない** (tick は job の受付の門を見ていないので、
  塞がないと停止の合図から終了までの数秒で作業ツリーとコミットまで作ってしまう)。
  中断された適用は receipt を作らない (従来どおり fail-closed)。
  適用は job ではないので `/stop` (スレッド単位の job 停止) の対象ではない。
- **承認された提案が設定を壊しても、そのまま commit できていた。** 適用後の内容を**書く前に**
  起動時とまったく同じ手順 (JSON 解析 → secrets と合成 → `validateConfig`) へ通し、通らなければ
  当てない (新しい段 `validate`)。壊れた設定が merge されると次の起動が exit 1 で止まり、
  ラッパーは 42 以外で再起動しないため、そこで復旧の手段ごと失われていた。
  見るのは `config.policy.json` だけではない — 起動時検証は役割文のスキーマ宣言も読むので、
  `roles/*.md` から宣言を消す提案も同じ経路で止める。読む先は**適用後の内容**
  (同じ diff の中身、無ければ基点) なので、役割文を新設する提案が「宣言が無い」と誤判定されない。
  役割文のプロトコル版マーカー (`communitd-protocol`) と、全 bot に前置される
  `roles/_common.md` も同じ経路で見る — 壊すと merge 後にその bot (共通規定なら全 bot) の
  job が `protocol-mismatch` で起動しなくなる。**参照中の役割文を消す提案**も同じ理由で
  止める (bot ごと退ける提案は従来どおり通る)。
- **bot 同士で `displayName` が重複していても起動していた。** 同じ表示名が 2 体に付いていると
  メンションの解決が曖昧になるので、owner の呼び名との衝突と同じく起動時に落とす
  (照合は前後の空白と大文字小文字を無視)。

## [0.1.4] - 2026-09-12

### Fixed

- **テストが Linux で時間依存で落ちていた** (v0.1.3 の ubuntu CI、1 件)。隔離 CODEX_HOME の削除
  再試行の告知を検査する試験が、再試行間隔 5ms × 3 回より長い 20ms を待ってから「まだ 1 回しか
  告知していない」ことを見ていた。Windows の粗いタイマーでは偶然通り、Linux では 20ms 以内に
  最終告知まで出て落ちる。間隔を待ち時間より十分長く取った。製品コードは無変更。

## [0.1.3] - 2026-09-12

### Added

- **`bots.<key>.effort` を codex ランタイムでも書けるようにした。** 未指定だとユーザーの
  `~/.codex/config.toml` の `model_reasoning_effort` を隔離 CODEX_HOME へ写すので、`max` を
  拒むモデル (`gpt-5.5`) では bot が必ず落ちていた。値域の正本は `CODEX_EFFORTS` (`src/codex.js`)。

### Changed

- **同梱の設定例を「写しただけで安全寄り」にした。** `config.policy.example.json` の channels が
  `tools: "standard"` / `permissionMode: "acceptEdits"` で、**既定 (`readonly` / `default`) より強い**
  まま公開されていた。SETUP のとおりに写した第三者だけが、書込みと `git`/`node`/`npm` のシェルを
  許した状態で始まることになる。例を `readonly` / `default` に落とし、書込みとシェルを許した
  開発用は `config.policy.dev.example.json` として分けた (SETUP.md §0 で明示的に選ぶ)。
  「既定が安全寄り」と「サンプルを写せば安全寄り」は別、という外部レビューの指摘への対処。
  **`verify` はどちらの例にも入れていない** — 導入者のプロジェクトで通らないコマンドが既定で
  入っていると、最初の一周 (SETUP §4) が verify NG で止まるため。

### Fixed

- **Windows で codex の `workspace-write` が最小コマンドにも応答せず、job のタイムアウトまで固まっていた。**
  隔離 CODEX_HOME に Windows sandbox の状態ファイル (`cap_sid` / `.sandbox-secrets/sandbox_users.json` /
  `.sandbox/setup_marker.json`) が無く、codex が sandbox の setup をやり直そうとして最初の
  powershell が返らなかった。`workspace-write` のときだけ実 home から写す (`read-only` は setup を
  要しないので写さない — 資格情報を撒かない)。
- **codex の起動に失敗した経路で隔離 CODEX_HOME (認証と sandbox ユーザーの写し) が残っていた。**
  `spawn` の同期例外や出力先の作成失敗が共通の削除経路に届いていなかった。どの経路でも削除し、
  削除が `EBUSY` で失敗したら初回に告知したうえで 250ms・1s・4s で再試行する。
- **Linux / macOS で `/stop` とタイムアウトが孫プロセスを殺せていなかった。** `killTree` は
  win32 では `taskkill /T /F` でツリーごと止めるのに、それ以外は `child.kill('SIGKILL')` で直下の
  1 つだけ。spawn 側に `detached` が無くプロセスグループも分かれていなかったため、claude / codex が
  起こした bash・node は停止後も走り続けた (ファイルを書き続けうる)。子を別プロセスグループで起こし
  (`src/claude.js` / `src/codex.js` / `src/verify.js`)、`kill(-pid, SIGKILL)` でグループごと撃つように
  した。グループが既に無い場合は従来どおり直下へ落とす。**Windows の経路は無変更。**
  Stop hook の `verify` は claude の子として走るので、そこだけはグループを分けない
  (分けるとブリッジの停止が検証のツリーへ届かなくなる)。
- **端末を閉じた (SIGHUP) ときにブリッジだけ消えて、エージェントのツリーが残っていた。**
  上記でプロセスグループを分けたぶん、端末の SIGHUP は子へ届かなくなる。`SIGHUP` も
  `SIGINT` / `SIGTERM` と同じ後始末 (走行中 job の中断 → `killTree`) へ配線した。

## [0.1.2] - 2026-09-11

### Fixed

- **作業ツリーの撤去が「綴りの違う同じ場所」で黙って空振りしていた。** git は必ず実体の綴りで
  報告するのに、こちらは設定値から組み立てた綴りで照合していたため、**Windows の 8.3 短縮名**
  (`C:\Users\RUNNER~1\…`)・junction / symlink・macOS の `/var` → `/private/var` では
  `git worktree list` に居るツリーを「登録されていない」と読み違え、**作業ツリーもタスクの枝も
  残り続けた**。比較の前に実体で引き直すようにした (`src/worktree.js`)。
- **テストが `core.autocrlf=true` で clone した作業ツリーで落ちていた。** 行末に敏感な照合を
  CRLF でも通るようにし、併せて `.gitattributes` (`* text=auto eol=lf`) で作業ツリーの改行を
  LF に固定した。

## [0.1.1] - 2026-09-11

### Added

- **CI に Windows を追加。** `ubuntu-latest` × `windows-latest` × Node 20 / 22 で回す。
  開発は Windows・CI は ubuntu だけ、という組み合わせだと、パスの意味論の違いが公開してから出る。

### Fixed

- **テストが Linux で通らなかった** (9 件)。`src/clicmd.js` の Windows 向けのパス操作が実行 OS の
  規則で動き、Linux では `C:/…` が相対パス扱いになっていた。**Windows のパス文字列を読む所は
  `path.win32` で固定**し、実 OS へ渡す引数を扱う所 (`--add-dir` / パス承認ルール) は実 OS の
  規則のままにして、事例の側を OS に依らない形へ直した。製品の動作は変わらない。
- **`npm test` が「1 件も走らないまま成功」しうる書き方だった。** `test/*.test.js` の展開を
  シェル任せにしていたため、展開できるかがシェルと Node の版に依存し、**展開できなかったときは
  0 件のまま exit 0** になる (走っていないのに緑)。入口を `scripts/test.mjs` にして、ファイルを
  自分で並べ、0 件なら落とすようにした。

## [0.1.0] - 2026-09-11

最初の公開版。

### Added

- **Discord のメンションでローカルの Claude Code エージェントを起動するブリッジ。** チャンネルが
  プロジェクト (作業ディレクトリと権限の対応)、スレッドが仕事の単位で、スレッド × bot ごとに
  claude セッションを保つ (2 回目以降は `--resume` で会話が続く)。
- **bot 同士の handoff。** 応答末尾の独立行 `[[handoff:<bot キー>]]` / `[[notify:owner]]` だけが
  起動経路で、本文中の平文の `@名前` は変換しない (例文や引用での暴発を止めるため)。
- **委譲契約。** 委譲の 5 部 (背景 / 目的 / touch 集合 / 受入基準 / 停止条件) を `--json-schema` で
  受け取り、**touch 集合をそのまま受け手の実権限へ変換する** — 規律ではなく機構で集合の外を編集させない。
- **完了時の機械検証 (`verify`)。** Stop hook で任意のコマンドを実行し、NG は同一セッションへ
  差し戻す。最終 NG なら結果を投稿して handoff を止める。
- **実行記録と復旧。** job 1 本ごとの受付 → 起動 → モデル → 検証 → 配送を `data/job-runs.json` に残し、
  `/inbox` `/status` に「実行中 / 承認待ち / 返信待ち / 復旧待ち」を並べる。止まった仕事は `/retry` で
  同じスレッド・同じブランチの続きとして起こし直せる。
- **自律運転 (既定 off)。** エージェントが自分で起票・実装・レビュー・既定ブランチへの昇格まで回す。
  `/pause` `/resume` で止められ、停止状態は再起動をまたいで残る。
- **ツール権限の申請。** 拒否されたツール要求が Discord の承認カードになり、人間が押したぶんだけ
  次の job から効く。`hooks: true` のチャンネルでは実行中にその場で出て、押すと同じ job が続行する。
- **codex ランタイム。** `runtime: "codex"` の bot は `codex exec` を read-only sandbox で起動する。
  組み込み指示を差し替えて「コードを書かない相談役」としても立てられる。
- **起動前の診断 `npm run doctor`。** Discord もモデルも動かさず、設定・CLI・作業ディレクトリ・
  `data/` の状態を ✅ / ⚠️ / ❌ で並べる。
- **fail-closed な設定検証。** `guildId` / `allowedUserIds` / bot の必須キー / ツール許可 /
  自律運転のパラメータを起動時に検証し、書き損じが「絞ったつもり」や「全開放」に化けないようにする。

<!-- 版どうしの比較リンク ([Unreleased] / [0.1.0]) は publish-snapshot が --repo から生成する -->

[Unreleased]: https://github.com/jiro-prog/communitd/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/jiro-prog/communitd/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/jiro-prog/communitd/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jiro-prog/communitd/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jiro-prog/communitd/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jiro-prog/communitd/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jiro-prog/communitd/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jiro-prog/communitd/releases/tag/v0.1.0
