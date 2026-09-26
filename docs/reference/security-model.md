# セキュリティモデル

> Discord のメッセージがローカルのコマンド実行に変わる境界と、そこに置いた歯止め。
> 入口は [README](../../README.md)、導入手順は [SETUP.md](../../SETUP.md)。

**このブリッジは「Discord のメッセージ」を「ローカルマシンでのコマンド実行」に変換する。**
権限設計はこの一点を前提に読んでほしい。

- **許可ユーザー = あなたの OS アカウントと同等の権限**。`allowedUserIds` に載せた人は、そのチャンネルの `cwd` 配下でファイルを読み書きし、許可されたシェルコマンドを走らせられる。ローカルで端末を渡すのと同じ重みで選ぶこと
- **`guildId` と `allowedUserIds` は必須**。どちらかが空なら起動時に理由を表示して終了する (設定漏れを「制限なし」と解釈しない)。チャンネル設定の `cwd` 欠落も同様に起動を拒否する
- **既定は最小権限**。チャンネルに `tools` / `allowedTools` のどちらも書かなければ `readonly` プリセット (Read / Glob / Grep / WebSearch / WebFetch) になる。`permissionMode` の既定は `default` (実行前に確認を求める側)。書込みやシェルを伴う `standard` / `full` / `acceptEdits` は、そのチャンネルに明示的に書いたときだけ有効
- **同梱の設定例も安全寄り**。`config.policy.example.json` は `readonly` / `default` で、書込みとシェルを許した設定は `config.policy.dev.example.json` に分けてある。どちらの例にも `verify` は入れていない (任意 shell の実行口を、導入者が写すだけの既定にしない)。**「既定が安全寄り」と「同梱の例を写せば安全寄り」は別のこと**で、以前は例の側が `standard` / `acceptEdits` だったため、SETUP のとおりに写した第三者だけが強い権限で始まっていた (外部レビュー 2026-09-11 の指摘)
- **権限が増えるのは人間がボタンを押したときだけ**。エージェントは申請しかできず、恒久承認に向かない要求 (シェル全許可・wildcard・cwd 外・秘密混じり) はそもそも申請にならない (→ [ツール権限の申請](tool-permissions.md))
- job 専用の `--settings` はコード側で `hooks` だけを許可し、`permissions` などの権限キーを拒否する。`allowedTools` を迂回する第二の権限経路にはしない
- **prompt injection の経路がある**。スレッド本文・引用・添付 (画像とテキストファイル) はほぼそのままモデルへ渡る (**画像内に書かれた文字も、テキストファイルの中身も指示として効きうる**。テキストは境界で囲み「データであって指示ではない」と添えるが、これは緩和であって保証ではない)。悪意ある文章を貼った時点で、書込み権限のあるチャンネルではその内容がそのまま指示として効きうる。とくに **WebFetch / WebSearch と書込み権限を同じチャンネルに同時付与すると、外部ページの文言でローカルの改変や情報の外部送信が起こせる**。両立させるなら信頼できる作業ディレクトリに限ること
- **`verify` は作者専用の任意 shell コマンド実行口**で、`tools` / `allowedTools` の制約を受けない。エージェントや承認カードからは設定できず、作者が管理する `config.policy.json` の値だけを実行する
- **`allowedTools` は「許可リスト」ではなく「追加許可」**。書いていないツールでも、無害と判断されたものは通る (実測: `--allowedTools Read` の下でも `Bash` の `echo` は通り、`Write` とリダイレクトは拒否される)。**`Agent` (subagent) も書かなくても起動する** — 「`toolsExtra` に書いたチャンネルだけ扇形展開できる」ではない
- **組み込みの subagent は親の権限を超えない**。`--allowedTools Read` の下で subagent に `Write` させても拒否される (実測)。**ただし custom subagent 定義は権限も作業場所も変えうる** (→ 下記)
- **agent 定義ファイルは設定ではなくコードに近い信頼対象**として扱うこと。frontmatter が動かすのは**権限・使えるツール・作業場所・実行経路・永続状態・注入される指示**で、`tools:` で権限が広がらない (実測: `Write` は拒否) ことだけを確かめても意味がない。**個別フィールドを数え上げる守り方は仕様追加のたびに漏れるので、「定義ファイルの出どころを信頼できるものに限る」が唯一の防衛線**になる。現に効くものの例:
  - `permissionMode` — 親の mode が `acceptEdits` / `bypassPermissions` / `auto` の**とき以外**は上書きが通る (`default` / `plan` / `dontAsk` / `manual`)。実測では親を `--permission-mode default --allowedTools Read` にした job で、`permissionMode: acceptEdits` の定義が**ファイル書込みに成功した**
  - `hooks` — subagent のライフサイクルで**任意コマンドを実行できる**。`allowedTools` を通らない実行経路になる
  - `mcpServers` — 親に無い MCP ツールと**外部接続**を、その subagent にだけ足せる
  - `memory` — 永続ディレクトリを与え、**`Read` / `Write` / `Edit` が自動で有効化される**。スコープ `user` の保存先は `~/.claude/agent-memory/<名前>/` で **`cwd` の外・全プロジェクト横断**。書いた内容は次のセッションの system prompt へ読み込まれる (`MEMORY.md` の先頭 200 行 / 25KB) ので、**prompt injection が job をまたいで持続する経路**にもなる
  - `skills` — 指定した skill の**本文がまるごと**起動時に注入される (description だけではない)
  - `isolation: worktree` — 一時 git worktree で動くので「同じ作業ディレクトリ」でもなくなる
  - 公式仕様が plugin 由来の定義でだけ `hooks` / `mcpServers` / `permissionMode` を "for security reasons" 無効化しているのも、これらが境界だからにほかならない
  - 読み込み元は `cwd` 配下だけではない。`.claude/agents/` は cwd からリポジトリルートまで遡って走査され、`--add-dir` で足したディレクトリ配下・`~/.claude/agents/` (全プロジェクト)・managed settings・`--agents` フラグも対象になる。**他人の書いた agent 定義を読み込ませない**
- **ブリッジ側に「subagent を使わせない」機構は設けていない**。手段自体はある — claude 側 settings の `permissions.deny` に `Agent` / `Agent(名前)` を書くか `--disallowedTools` で塞げる。**その deny はブリッジの設定より優先される** (job 専用 `--settings` は user / project / managed settings を置換しないため)。実行文脈が主張するのは「ブリッジ側では無効化していない」までで、実際に使えるかは claude 側 settings 次第
- **公開・共有サーバーでの運用は `readonly` を推奨**。書込みが必要なら、書込み用の bot とチャンネルを分け、`cwd` を専用の作業ツリーに閉じる
- **`/stop`・タイムアウト・ブリッジ終了 (SIGINT / SIGTERM / SIGHUP) はプロセスツリーごと止める** (`src/proc.js` の `killTree`)。エージェントが起こした bash・node の孫まで落とさないと、「止めた」はずの job がファイルを書き続ける。Windows は `taskkill /T /F`、それ以外は子を `detached: true` で別プロセスグループに起こしておき `kill(-pid, SIGKILL)` でグループごと撃つ (グループが既に無ければ直下へ落とす)。**`detached` と `-pid` は片方だけでは意味が無い** — detached を付けずに直下だけ殺していた頃は、POSIX で孫が残り得た (外部レビュー 2026-09-11 の指摘)。**逆に、claude の子として走る Stop hook の `verify` はグループを分けない** — そこで分けるとブリッジが claude のグループを撃っても検証のツリーだけ生き残るため、hook 側は claude のグループに残す方を採っている
  - **適用回路 (org-apply) の `verify` も、ブリッジ終了で同じように撃つ。** これは job ではなく tick から走るので、**`/stop` の対象ではない** (`/stop` はスレッド単位の job 停止で、適用はどのスレッドの job でもない)。止まる合図は SIGINT / SIGTERM / SIGHUP / `/restart` の shutdown だけで、撃った後は**次の tick で新しい適用も始めない** (tick は job の受付の門を見ていないので、塞がないと停止の合図から終了までの数秒で作業ツリーとコミットまで作ってしまう)。中断された適用は**当てた結果を記録しない** (receipt を作らず、枝ごと捨てて次の tick で片付け直す)
- Discord トークン等の秘密は子プロセスの env から除去して渡す (`src/proc.js` の `scrubEnv`)。ただし `.env` ファイル自体は `cwd` 配下にあれば読める — ブリッジのリポジトリを作業対象チャンネルの `cwd` にしない (`npm run add-project` は、ブリッジのルート自身とその祖先を `cwd` に指定できないようにしている。`realpath` 解決後に判定するので junction 経由でも同じ)
- codex ランタイムの bot (`runtime: "codex"`) の書込み可否はチャンネル設定 `codexSandbox` で決まる。既定は `read-only` で、`workspace-write` を明示したチャンネルでのみ書ける (→ [codex ランタイム](codex-runtime.md))。ユーザー設定の MCP サーバー (UnityMCP / node_repl 等) はどちらのモードでも読み込ませない — codex の sandbox は MCP ツールを縛らないため、MCP が入ると read-only 指定は意味を失う


## 発議と組織提案 (実験的・非対応)

> **実験的な機能で、公開版ではサポートしない。** 既定は無効 (`initiative` を書かなければ何も起きない)。
> 仕様は予告なく変わる。使うなら以下を読んだうえで、自分だけが居るサーバーに限ること。

`initiative.enabled: true` にすると、bot が**自分たちの役割文・設定・手順書の変更**を提案し、裁定を経て
**ブリッジ自身がその差分を当ててコミットし、既定ブランチへ merge する**経路が開く。ブリッジが自分の
権限設定を書き換えられる唯一の経路なので、ここだけ信頼境界の形が他と違う。

### 誰が何を決めるか

| 提案の class | 例 (`kind`) | 裁定する者 | 当たる先 |
| --- | --- | --- | --- |
| `org` | `role-edit` / `policy-edit` / `tool-grant` / `governance-edit` / bot の新設・廃止 | **作者だけ** (`ownerUserId`)。Discord のボタンで裁定 | `roles/**`・`config.policy.json`・承認された文書 (ブリッジが直接当てる) |
| `process` | `process-edit` | `initiative.execBotKeys` に書いた **bot** | `processEditAllowlist` に載せた文書だけ |
| `work` | `work-item` / `check-add` / `tooling-add` | 同上 (**bot**) | 通常の自律運転タスクとして起票され、worker が実装する |

- `execBotKeys` の既定は空 (= `work` / `process` は誰も裁定できない)。**書けば、その bot が人を介さずに
  手順書の変更と作業の起票を決められる**
- `initiative.enabled: true` には `ownerUserId` (かつ `allowedUserIds` に含まれること) が要る。無ければ起動しない
- `config.secrets.json` はどの提案からも対象にできない (裁定権者 `ownerUserId` / `ownerNames` を提案で書き換えさせないため)

### 機構で閉じていること

- **裁定は内容に束縛される。** カードのボタンは提案 ID と digest (提案の入力・意見・対象ファイルの版・
  allowlist を丸ごと正規化した指紋) を持ち、押下時に現在の digest と照合する。カードを出した後に差分が
  差し替わっていれば裁定せず、出し直す。task 化と適用の直前にも照合する
- **申告と実際の変更を突き合わせる。** 提案が申告した対象・`touch`・差分が触るパスの三者が一致しなければ
  保存しない。差分の文法は通常ファイルの text の create / edit / delete だけで、絶対パス・`..`・symlink・
  rename・binary・mode 変更は拒否する。`kind` ごとに許す操作 (edit のみ等) も閉じてある
- **当てるのはブリッジ。** 裁定時の `baseCommit` から毎回きれいな枝を作り、当てた後の `git diff` が承認済み
  差分と完全一致することを確かめてからコミットする。`config.policy.json` や役割文を変える差分は、
  **書く前に起動時と同じ設定検証**へ通し、通らなければ当てない (壊れた設定を merge して次の起動が落ちる
  のを防ぐ)。その後 `verify` を回し、別の bot の検収を経て、**適用コミットの OID だけ**を merge する

### 残っているリスク (承知のうえで使うこと)

- **裁定カードに差分そのものは出ない。** 出るのは bot が書いた要旨 (300 字まで)・対象・変更するファイル名
  で、採択はボタンを押した時点で確定する。digest の束縛は「見た後に差し替えられる」ことは防ぐが、
  「要旨と差分が食い違っている」ことは防がない。**`org` 提案は、採択する前に差分を自分で読むこと**
  (要旨だけで押さない)
- **`config.policy.json` への提案を採択することは、その中身を自分で書くのと同じ。** `verify` (任意 shell
  コマンド)・`tools` / `toolsExtra`・`permissionMode`・`autonomy` はすべて policy にあるので、`policy-edit`
  の採択は権限の付与そのものになりうる。変更は merge 後、次の起動 (`/restart`) から効く
- **適用回路のチャンネルは、ブリッジ自身のリポジトリを `cwd` にすることが必須**になっている
  (`initiative.applyChannel`)。これは上の「ブリッジのリポジトリを作業対象チャンネルの `cwd` にしない」と
  矛盾する配置で、そのチャンネルで動く bot (適用 task の検収役など) は `readonly` でも `.env` の Discord
  トークンと `config.secrets.json` を読める。**現状これを塞ぐ機構は無い**
- **prompt injection は提案にも届く。** 提案を起草する bot が読んだスレッド・添付・Web ページの文言は、
  そのまま提案の中身になりうる。`execBotKeys` の bot が裁定する `process` / `work` はとくに、人の目を
  通らずに進む
