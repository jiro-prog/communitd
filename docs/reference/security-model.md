# セキュリティモデル

> Discord のメッセージがローカルのコマンド実行に変わる境界と、そこに置いた歯止め。
> 入口は [README](../../README.md)、導入手順は [SETUP.md](../../SETUP.md)。

**このブリッジは「Discord のメッセージ」を「ローカルマシンでのコマンド実行」に変換する。**
権限設計はこの一点を前提に読んでほしい。

- **許可ユーザー = あなたの OS アカウントと同等の権限**。`allowedUserIds` に載せた人は、そのチャンネルの `cwd` 配下でファイルを読み書きし、許可されたシェルコマンドを走らせられる。ローカルで端末を渡すのと同じ重みで選ぶこと
- **`guildId` と `allowedUserIds` は必須**。どちらかが空なら起動時に理由を表示して終了する (設定漏れを「制限なし」と解釈しない)。チャンネル設定の `cwd` 欠落も同様に起動を拒否する
- **既定は最小権限**。チャンネルに `tools` / `allowedTools` のどちらも書かなければ `readonly` プリセット (Read / Glob / Grep / WebSearch / WebFetch) になる。`permissionMode` の既定は `default` (実行前に確認を求める側)。書込みやシェルを伴う `standard` / `full` / `acceptEdits` は、そのチャンネルに明示的に書いたときだけ有効
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
- Discord トークン等の秘密は子プロセスの env から除去して渡す (`src/proc.js` の `scrubEnv`)。ただし `.env` ファイル自体は `cwd` 配下にあれば読める — ブリッジのリポジトリを作業対象チャンネルの `cwd` にしない (`npm run add-project` は、ブリッジのルート自身とその祖先を `cwd` に指定できないようにしている。`realpath` 解決後に判定するので junction 経由でも同じ)
- codex ランタイムの bot (`runtime: "codex"`) の書込み可否はチャンネル設定 `codexSandbox` で決まる。既定は `read-only` で、`workspace-write` を明示したチャンネルでのみ書ける (→ [codex ランタイム](codex-runtime.md))。ユーザー設定の MCP サーバー (UnityMCP / node_repl 等) はどちらのモードでも読み込ませない — codex の sandbox は MCP ツールを縛らないため、MCP が入ると read-only 指定は意味を失う

