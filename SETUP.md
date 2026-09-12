# セットアップ

**最小構成で一周してから、高度な運用へ進む。** 最小 = bot 2 体 (manager / worker) + チャンネル 1 つ。
§0 から §5 まで順に進めば、Discord から依頼して成果ファイルが出るところまで届く。
verify・hooks・自律運転・独立 reviewer・自動復旧は §0 の「高度な運用」以降で、最初の一周では要らない。

## 必要なもの

- **Node.js 20.6 以上** (`node --version`)。`--env-file` を使うので 20.6 未満では起動しない
- **`claude` CLI が認証済み** — `claude -p "test"` が応答すること。ブリッジはローカルの CLI を
  そのまま起動するので、**サブスク認証を継承する** (API キーは要らない)
- **`git`** — 作業ディレクトリの差分を検収の材料にするため
- **`codex` CLI** — reviewer (codex ランタイムの bot) を使うときだけ。使わないなら不要
- **Discord のサーバー 1 つ** (自分が管理者であること) と、そこに招待する bot アプリ
- **OS**: Windows 11 で検証済み。macOS / Linux はコード上は分岐済みだが**実機未検証**
  (CI は ubuntu で単体テストが緑)。動かないところがあれば issue にしてほしい

起動前の診断は `npm run doctor` (読むだけ・Discord もモデルも動かさない)。§3 で使う。

## 0. 設定ファイルを作る

設定は「どのチャンネルで、どのディレクトリを、どの権限で claude に触らせるか」を決めるもの。
**内容を自分の目で確認してから**保存する。リポジトリ直下に**同梱の例をコピーして**始める:

```
cp config.policy.example.json config.policy.json
cp config.secrets.example.json config.secrets.json
cp .env.example .env
```

**この `cp` は初回だけ。** 一度書き始めたら**写し直さない** — 例で上書きすると、`cwd` は
`C:/path/to/your/project` に、サーバー ID とユーザー ID は `000000000000000000` に巻き戻る。
後の節を読み返して二度目の `cp` を打つのが、実地の導入でいちばん多かった詰まり方
(`npm run doctor` が「設定例のまま」と ❌ を出すので気づける)。既にファイルがあるなら、
差分を見ながら**手で足す**。

**`config.policy.json` の例は 2 つある。** 上の `config.policy.example.json` は
**写しただけで安全寄り** (`readonly` / `permissionMode: default`) — エージェントは読むだけで、
ファイルは書き換えないしシェルも走らせない。§4 の委譲テスト (`hello.txt` を書く) まで進むなら、
書込みと `git`/`node`/`npm` のシェルを許した開発用の例へ差し替える:

```
cp config.policy.dev.example.json config.policy.json
```

違いは `channels.my-project` の 2 行だけ (`"tools": "standard"` / `"permissionMode": "acceptEdits"`)。
**強い方を選ぶのは明示的な操作にしてある** — 既定が安全寄りなのと、同梱の例を写せば安全寄りなのは
別だから。完了時の機械検証 (`verify`) はどちらの例にも入れていない。最初の一周では要らないし、
自分のプロジェクトで通らないコマンドを書くと委譲そのものが止まるため — 足すのは
「高度な運用」まで読んでからでよい。

### どのファイルに何を書くか

| ファイル | git | 書くもの | 必須キー |
| --- | --- | --- | --- |
| `config.policy.json` | 追跡する | bot・チャンネル・権限・予算 | `bots.<key>.tokenEnv` / `displayName` / `rolePromptFile` / `model` (claude のとき必須)、`channels.<name>.cwd` |
| `config.secrets.json` | 追跡しない | サーバー ID・ユーザー ID | `guildId` / `allowedUserIds` |
| `.env` | 追跡しない | Discord bot のトークン | `config.policy.json` の `tokenEnv` に書いた変数名すべて |

**`config.secrets.json` に置けるのは 4 キーだけ** (`guildId` / `allowedUserIds` / `ownerUserId` /
`ownerNames`)。他を書くと起動時に落ちる。逆にこの 4 つを `config.policy.json` 側へ書いても落ちる。
分けてあるのは、採択された組織提案の diff をブリッジが `config.policy.json` へ当てる回路があるため —
**裁定権者を、その適用回路から書き換えられないように**秘密側へ固定してある。同じキーを両方に書くと
「どちらが効くか」が設定から読めないので、起動時に断る。

### `config.policy.json` を埋める

コピーした例はこの形になっている:

```json
{
  "claudeBin": "claude",
  "bots": {
    "manager": {
      "tokenEnv": "MANAGER_DISCORD_TOKEN",
      "displayName": "Manager",
      "model": "opus",
      "rolePromptFile": "roles/manager.md"
    },
    "worker": {
      "tokenEnv": "WORKER_DISCORD_TOKEN",
      "displayName": "Worker",
      "model": "sonnet",
      "rolePromptFile": "roles/worker.md"
    }
  },
  "channels": {
    "my-project": {
      "cwd": "C:/path/to/your/project",
      "tools": "readonly",
      "permissionMode": "default"
    }
  }
}
```

(`config.policy.dev.example.json` はこの `channels.my-project` が
`"tools": "standard"` / `"permissionMode": "acceptEdits"` になっているだけで、他は同じ。)

直すのは **`cwd` だけ**でよい。自分のプロジェクトの**絶対パス**に置き換える
(Windows でも `/` 区切りで書ける)。`channels` のキー (`my-project`) は Discord の
チャンネル名と一致させる — §1 で同じ名前のチャンネルを作る。

`bots` のキー (`manager` / `worker`) は**あなたが決める識別子**で、Discord 上の名前ではない。
`displayName` が Discord での表示名。3 体目を足すなら §2 で bot をもう 1 つ作り、
`"reviewer": { "tokenEnv": "REVIEWER_DISCORD_TOKEN", "displayName": "Reviewer",
"runtime": "codex", "rolePromptFile": "roles/reviewer.md" }` を足す。
**codex ランタイムでは `model` を省略できる** — その場合は codex の既定モデル
(`~/.codex/config.toml`) が使われる。指定するなら `codex exec -m` が受け付ける名前を書く。

### `config.secrets.json` を埋める

**Discord のサーバーがまだ無ければ、先に §1 を済ませてからここへ戻る** (サーバー ID が要るため)。

```json
{
  "guildId": "自分のサーバーの ID",
  "allowedUserIds": ["自分のユーザー ID"],
  "ownerUserId": "自分のユーザー ID",
  "ownerNames": ["あなたの呼び名"]
}
```

ID の取り方: Discord の設定 → 詳細設定 → **開発者モード** を ON にしてから、
サーバー名を右クリック → 「サーバー ID をコピー」/ 自分のアイコンを右クリック →
「ユーザー ID をコピー」。

`ownerUserId` は bot が判断を仰ぐ相手 (省略可)。書いておくと、bot が応答末尾の独立行に
`[[notify:owner]]` を置いたとき実メンションになって通知が飛ぶ。`ownerNames` は
**通知先ではなく**「平文で呼んでも届かない」と警告するための呼び名 (省略時は `owner`)。
bot の `displayName` と同じ呼び名は起動時に拒否する (どちらを呼んだつもりか判別できなくなるため)。

### ⚠️ `allowedUserIds` に載せる人は、この PC でコマンドを実行できるのと同じ

ブリッジはメンションを受けるとローカルの `claude` CLI をあなたのユーザー権限で起動する。
チャンネル設定によっては、そのエージェントはファイルを書き換え、`git` や `npm` を実行し、
ネットワークへ出る。**`allowedUserIds` に書いた Discord ユーザーは、その実行を依頼できる。**
自分以外を載せるのは、その人にこの PC のシェルを渡すのと同じだと考えて決めること。
入口は 3 段で塞いである — `guildId` で自サーバー以外を遮断、`allowedUserIds` で発言者を限定、
自前 bot 以外の bot 発言は常時無視。`guildId` と `allowedUserIds` は**必須**で、
どちらかが空なら起動時に理由を表示して終了する (設定漏れを「制限なし」と解釈しない)。
Discord トークンは claude 子プロセスの環境変数から自動で除去される。

### ツール許可

ツール許可はプリセット一語で書ける: `"tools": "readonly"` (読取+検索のみ) /
`"standard"` (編集 + git/node/npm の Bash・PowerShell) / `"full"` (シェル全許可)。
追加は `"toolsExtra"`、細かく書きたければ従来の `"allowedTools"` 配列も使える (そちらが優先)。
`tools`/`allowedTools` 未指定は `readonly`、`permissionMode` 未指定は `default`
(fail-closed — `acceptEdits` を使うチャンネルは明示的に書く。[セキュリティモデル](docs/reference/security-model.md) 参照)。
同梱の例も §0 のとおり 2 つに分けてある: `config.policy.example.json` が `readonly` / `default`、
`config.policy.dev.example.json` が `standard` / `acceptEdits`。

---

### 高度な運用 (最初の一周では要らない)

ここから先は一周できてから読めばよい。

**subagent (`Agent` ツール) は claude ランタイムの job ならブリッジ側で無効化していない** (codex
ランタイムには無い。可否は実行文脈の「subagent:」行に出るので、役割文には書かない)。`--allowedTools`
は許可リストではなく追加許可で、`Agent` は書かなくても起動する (実測)。`toolsExtra` に `"Agent"` と
書いても増えるものは無いので、書かないこと (「書けば使える／書かなければ使えない」という誤解を作らない
ため)。ブリッジ側に使わせない設定は用意していないが、**claude 側 settings (user / project / managed) の
`permissions.deny: ["Agent"]` はそのまま効く** — job 専用 `--settings` はそれらを置換しないので、deny が
あるとブリッジの想定より狭くなる。組み込みの subagent は親の権限を超えないので、`readonly` チャンネル
では subagent も読み取りしかできない。

プロジェクト固有のレビュアーを定義したいときは、そのチャンネルの `cwd` 配下に `.claude/agents/*.md` を
置けば headless でも読まれる (実測)。**ただし agent 定義は設定ではなくコードに近い信頼対象**で、
frontmatter は権限・使えるツール・作業場所・実行経路・永続状態を動かす: `permissionMode` (チャンネルの
`permissionMode` が `acceptEdits` / `bypassPermissions` / `auto` の**とき以外**は親より強い権限へ上書き
できる。実測: `readonly` + `default` の親で `permissionMode: acceptEdits` の agent が書込みに成功) /
`hooks` (`allowedTools` を通らない任意コマンドの実行経路になる) / `mcpServers` (親に無いツールと外部接続を
足せる) / `memory` (永続ディレクトリと `Read`・`Write`・`Edit` が自動で付く。スコープ `user` の保存先は
`~/.claude/agent-memory/<名前>/` で **`cwd` の外**、内容は次セッションの system prompt へ読み込まれる) /
`skills` (skill の本文がまるごと注入される) / `isolation: worktree` (別ツリーで動く)。`tools:` フィールド
では広がらない。**フィールドを数え上げる守り方は仕様追加のたびに漏れる**ので、読み込ませる定義の出どころを
絞ること — 読み込み元は `cwd` 配下に限らず、リポジトリルートまでの各 `.claude/agents/`・`claudeAddDirs` で
足したディレクトリ・`~/.claude/agents/` も対象。詳細は [セキュリティモデル](docs/reference/security-model.md)。

作業ディレクトリの外を読ませたいときは `"claudeAddDirs": ["../design-notes"]` (相対パスは `cwd` 基準・
claude ランタイム専用)。**`--add-dir` は読み書きの両方を開ける口で、読取専用にはできない** — 参照のつもり
で足したディレクトリにも書けてしまうので、足すのは「書かれても `git status` で気付けるツリー」だけにする
(`.env` や秘密の置き場は足さない)。ターン末尾の 📋 差分は `cwd` のぶんしか出ないので、追加ディレクトリ側の
変更は自分で確認する。詳細は [参照ディレクトリ](docs/reference/add-dir.md)。

Claude Code の hook 基盤を使うチャンネルには `"hooks": true` を書く (boolean・claude ランタイム専用)。
省略または `false` なら job 専用の `--settings` を渡さず従来どおり動く。`true` のときに生成する settings は
`hooks` だけを許可し、`permissions` など `allowedTools` を迂回する権限キーは受け付けない。あなたの user
settings にある hooks は置換されず、job 専用 hooks と両方走る。

雑談のように成果物へ向かわない場を作るなら `"structuredOutput": false` (boolean・省略時は有効)。役割文の
`<!-- communitd-schema: ... -->` 宣言を**そのチャンネルでだけ黙らせ**、委譲契約も報告様式も使わない素の応答
に戻す。様式が振る舞いを決めるので、「やったこと / 検証結果 / 残課題」を埋めさせる限りエージェントは仕事の顔
から抜けない。**切ると委譲の touch 集合が実権限にならない** (契約が構造として届かないため) ので、書込みを
許したチャンネルで切るかは自分の判断。書き損じ (`"false"` など文字列) は起動時に拒否し、解決側は「切れて
いない」方へ倒す。

そのチャンネルで既定として呼べる bot を絞るなら `"roster": ["worker", "reviewer"]` (bot キーの配列)。編成は
本来スレッド単位 (`/roster`) だが、**打ち忘れたスレッドは全員呼べる**ので、勝手に呼ばれると困る相手がいる
チャンネルではここに既定を書く。スレッドで `/roster` を打つとこの既定を上書きし、`/roster all` は「全員」
ではなく**この既定へ戻る**。省略すれば従来どおり制限なし、`[]` はそのチャンネルでは handoff 禁止。
`config.bots` に無いキーを書くと起動時に落ちる (綴り違いを黙って無視すると「絞ったつもり」の穴になるため)。

機械検証を入れるなら `"hooks": true, "verify": "npm test"` と書く (claude ランタイム専用、codex は対象外)。
`verify` は `cwd` で実行するあなた管理の任意 shell コマンドで、ツール許可プリセットの外にある (エージェントや
承認カードからは設定できない)。NG は Stop hook から同一セッションへ差し戻し、`"verifyMaxRetries": 0`〜`3`
(既定 1) を使い切っても NG なら結果をスレッドへ投稿して handoff を止める。コマンドの上限は 10 分、表示は
出力末尾 20 行を Discord 1900 字以内に切り詰める。`verify` だけを書いて `hooks: true` を欠いた設定や、
範囲外の回数は起動時に拒否する。

エージェントが自分でタスクを起票して並行開発する**自律運転**を入れるなら `"autonomy": { ... }` (省略時は
無効)。書けるキーは `enabled` (boolean・**`true` と書いたときだけ**自律起動が始まる。`"true"` や `1` は「動かない」側へ倒し、起動時にも拒否する) / `directionFile`
(方向性ドキュメント = その社会の憲法。`cwd` 基準・既定 `docs/direction.md`) / `baseBranch` (タスクごとの
作業ツリーを生やす基点ブランチ・既定 `main`。**既定ブランチの自動検出はしない** — たまたま別のブランチが
出ていた日に「前のタスクの未マージの変更の上に積まれる」が静かに再発するので、書いてある方へ倒す。対象
リポジトリでは `.worktrees/` を Git の無視対象に入れておくこと。入っていないとタスク job は作業ツリーを
作らずに落ちる) / `scout: { bot, intervalMin, maxOpenTasks }` (種を起票する担当・起こす間隔 (分)・未着手が
この件数あれば起票を止める。既定 60 分 / 6 件) / `worker: { bots: [...] }` (実装担当) / `reviewer` (昇格を
裁く bot) / `maxConcurrentTasks` (同時に走らせるタスク数・既定 2) / `maxJobsPerDay` (そのチャンネルの 1 日
あたり自律 job 数・既定 40) / `taskJobBudget` (1 タスクへ払い出す job 数・既定 20)。数値はすべて 1 以上の
整数で、`scout.bot` / `worker.bots` / `reviewer` は `config.bots` に実在するキーだけ書ける。**未知キー・
型違い・範囲外・綴り違いの bot キーは起動時に拒否する** — 自律運転の設定は「絞ったつもりが効いていない」
「担当を書いたつもりで誰も起票しない」が無症状で進むので、他のキーより強く落としてある。加えて
`enabled: true` には同じチャンネルの `verify` (と `hooks: true`) が要り、`worker.bots` が `reviewer` 1 人
だけの編成も拒否する (人が見ていない間に既定ブランチへ昇格する経路なので、機械検証と「執筆と検収は別 bot」
を設定で外せないようにしてある)。`recovery: { mode, graceMin, maxAutoRetries, retryDelaysMin }` は止まった
タスクの自動復旧 (既定 `mode: "observe"` = 判断をログに残すだけで起こさない。`"auto"` で副作用が始まって
いないと実行記録で確認できる停止だけを起こし直す。`"off"` で判定もしない。猶予 5 分・上限 2 回・間隔
[5, 15] 分が初期値)。

自律運転を止めたくなったら **`/pause`** (理由は `reason:` に書ける。再開は `/resume`)。止まるのは**自律起動
だけ**で、実行中の job は殺さず、人間のメンション・handoff・自己呼び出しは従来どおり通る (いま動いている
job を止めるのは `/stop`)。状態は `data/pause.json` に永続するので、**ブリッジを再起動しても止まったまま** —
解除は明示的に `/resume` を打ったときだけ。

足りない許可は手で書かずに済ませられる: 拒否されたツール要求はスレッドに**承認カード**として出て、
「承認する」→「恒久設定として確定」の 2 段階を踏むと `data/tools-extra.json` に積まれ、**次の job から**
効く (`config.policy.json` は書き換えない)。押せるのは `allowedUserIds` の人間だけ、期限は既定 30 分
(`limits.toolApprovalTtlMs`・1 分〜24 時間)、1 job あたりのカードは既定 3 件まで
(`limits.maxToolApprovalCards`・1〜10。範囲外は起動時に落ちる)。

`"hooks": true` のチャンネルはこれに加えて、**実行中にその場でカードが出る**: ツールを呼ぶ直前に PreToolUse
hook がブリッジへ問い合わせ、「承認して続行」を 1 タップ押すと保存され、**止まっていたその job がそのまま
続く**。押されないまま既定 3 分 (`limits.toolApprovalWaitMs`・30 秒〜10 分。**カードの期限
`toolApprovalTtlMs` より短いことを起動時に検証する**) 経つと拒否として続行する。**待っている間は同じ `cwd`
の job がすべて止まる**ので上限は短めにしてある。対象は自動承認できるドメイン限定 (`WebFetch`) だけで、
それ以外は従来どおり job 終了後のカードになる。

カードになるのは「ドメイン限定 (`WebFetch(domain:example.com)`)」だけ。**シェルコマンドとファイルパスは
自動承認しない** (claude は照合前に `timeout` や `xargs` のような wrapper を外すので文字列の完全一致が実行
内容を固定できず、パス指定子は gitignore パターンなので実行中にディレクトリへ変わると範囲を保証できない)。
`Bash` / `Read` / `Edit` / `Write` の拒否では、安全に書ける場合だけ「`config.policy.json` へ貼れる候補」が
警告と一緒に表示されるので、範囲を自分で確かめてから貼る。承認は**チャンネル設定と作業ディレクトリの組**に
束縛されるので、`config.policy.json` の `cwd` を別リポジトリへ向け替えると過去の承認は効かなくなる。

`roles/*.md` を編集したら **`/restart` が要る**: 役割文は job ごとに読み直されるが、それを解釈するパーサは
プロセス起動時のコードのままなので、片方だけ新しいと委譲が黙って落ちる。これを防ぐため役割文の先頭の
`<!-- communitd-protocol: N -->` とブリッジの版を job 開始時に照合し、噛み合わなければモデルを起動せず
「版不一致・要 restart」と返す。記法を変えるときは `roles/*.md` と `src/protocol.js` の両方を同時に上げる
こと。MCP・`WebSearch`・`Task`・`Glob`/`Grep`、wildcard、シェル連結、cwd 外、秘密らしい入力はそもそも申請に
ならず理由だけが返る (それらが要るなら `config.policy.json` に人間が直接書く)。承認を取り消したいときは
`data/tools-extra.json` から該当行を消して再起動する。詳細は [ツール権限の申請](docs/reference/tool-permissions.md)。

プロジェクトを増やすとき: `npm run add-project` の対話に答えると、作業ディレクトリの実在確認 → `channels`
への追記 → **起動時とまったく同じ検証**まで済ませてくれる (書き込み前に内容を表示して確認を取り、
`config.policy.json.bak` を残す)。検証に落ちる内容は書き込まない。ブリッジ自身のディレクトリとその親は
`cwd` に指定できない (`.env` の Discord トークンが読める配置になるため)。判定は `realpath` 解決後に行い、
解決できないパスは拒否する。`config.policy.json` に書かれるのも**解決後の実体パス**。書き込みは
`config.policy.json.lock` で二重起動を弾いたうえで、プロセス固有の一時ファイルへ書いて読み戻し、差し替え
直前にもう一度中身を確かめてから置き換える (対話中に `config.policy.json` が別途編集されていた場合は上書き
せず中止する。CLI が異常終了して `config.policy.json.lock` が残ったときは、他に動いていないことを確かめて
消す)。ただし**書き込むと `config.policy.json` 全体が 2 スペース整形で書き直される**。Discord のテキスト
チャンネルも同じ対話の中で作る (同名があれば作らずそれを使う)。作成担当は `config.bots` の**先頭の bot**で、
その bot のロールに **「チャンネルの管理」** が必要 — サーバー設定 → ロール → 対象 bot のロール → チャンネル
の管理。権限が強いので、担当する 1 体にだけ付けるのがよい。権限不足や API 失敗のときは
`config.policy.json` を書き換えず中止し、逆に config の保存に失敗したときは**その実行で作ったチャンネル
だけ**削除して元の状態へ戻す (既存を再利用した場合は消さない)。トークンはエラー表示にも出さない。

job の所要時間: job が終わるたびにコンソールへ
`[job <id> <bot> thread:<id>] queueWait 1.2s / run 62.1s / ok` の 1 行が出る。待ち時間 (レーンが空くまで) と
実行時間が分かれているので、「遅い」がキュー待ちなのかモデル実行なのかはこの行で切り分けられる
([計測ログ](docs/reference/metrics.md))。

job の並列度: job はチャンネル設定の `cwd` ごとに直列 (同じ作業ツリーを 2 つの job が同時に触らない)、`cwd`
が違うチャンネル同士は並走する。全レーン合計の同時実行数を絞りたいときだけ `limits.maxConcurrentJobs` に
正の整数を書く (未設定・0 は無制限)。サブスクのレート上限は全 job で共有するので、同時実行が増えて
遅い/失敗が出るようなら `2` などに設定する。

bot の自己呼び出し: bot は制御フッターに**自分のキー**を書いて自分をもう一度起動できる (長い作業を
「調査 → 実装 → 検証」と区切り、その境目ごとに verify・報告・人間の割り込みを挟むため)。**既定では専用の
上限を置かず** `maxBotHops` の枠 (12) で止まる。連続で回りすぎるようなら `limits.maxSelfHops` に小さい整数を
書いて自己呼び出しだけを絞る (`0` なら機能ごと切れる)。どちらの枠も人間が発言すればリセットされる。

reviewer (codex ランタイム・任意): `runtime: "codex"` で `claude -p` の代わりに `codex exec` を
**read-only sandbox** で起動するレビュー/相談係。ローカルの codex CLI にログイン済みであることが前提。
使わないなら `bots` から消すだけでよい。詳しくは [codex ランタイム](docs/reference/codex-runtime.md)。

相談役の bot (任意): codex ランタイムには Codex 組み込みの「コーディングエージェント」指示が入っている。
`bots.<key>.codexInstructionsFile` (リポジトリ相対のパス) を書くと、その指示が指定ファイルの内容に
**置き換わる** — コードを書く bot と、コードを書かない相談役を同じ codex ランタイムで並べられる。見本は
`prompts/codex-consult.md`、詳しくは [codex ランタイム](docs/reference/codex-runtime.md)。書いていない bot は組み込み指示のままなので、
既存の bot には影響しない。

## 1. Discord サーバー (既にあれば飛ばす)

自分用サーバーを 1 つ作る。テキストチャンネルを `config.policy.json` の `channels` のキー名と
**同名**で作る。例のままなら `#my-project` の 1 つ。

## 2. Bot を作る (manager / worker の 2 体、reviewer を使うなら 3 体)

https://discord.com/developers/applications で以下を **2 回** (manager 用 / worker 用):

1. **New Application** → 名前は `displayName` に合わせる (例のままなら `Manager`、2 回目は `Worker`)
2. 左メニュー **Bot**:
   - **Reset Token** → トークンをコピー (§3 で `.env` へ)
   - **Privileged Gateway Intents** → **MESSAGE CONTENT INTENT** を **ON**
     (これを忘れるとメッセージ本文が読めない)
3. 左メニュー **OAuth2 → URL Generator**:
   - Scopes: `bot` と `applications.commands` (後者はスラッシュコマンド `/stop` `/restart` 用。
     `bot` に含まれるので既に招待済みの bot を入れ直す必要はない)
   - Bot Permissions: `View Channels` / `Send Messages` / `Create Public Threads` /
     `Send Messages in Threads` / `Read Message History` / `Attach Files`
   - 生成された URL を開き、自分のサーバーへ招待
   - 起動ログに `[<bot キー>] スラッシュコマンド登録: /stop /roster /pause /resume /proposals
     /inbox /review /status /retry /case /restart` が出れば登録成功 (guild スコープなので即時反映)

### 役の名前は役割文のファイル名で決まる

`bots.<key>.rolePromptFile` の**ファイル名 (拡張子を除いた部分) が、そのまま「役」の名前**になる。
`roles/worker.md` を指す bot は `worker` 役。実行文脈の「呼べる相手」にはこの名前が添えられ
(`[[handoff:worker]] Worker (worker)`)、役割文もこの名前で相手を指す
(「実装は worker 役へ渡す」「reviewer 役が居ればレビューを受ける」)。

**同梱の 3 本 (`roles/manager.md` / `worker.md` / `reviewer.md`) はそのまま使えるので、
最初は改名しないこと。** 改名すると役割文の中の「worker 役」がどの bot を指すのか決まらなくなる。
2 体目の worker を足したいときは、bot キーだけ変えて `rolePromptFile` は `roles/worker.md` のまま
共有すればよい (同じ役として出る)。

## 3. トークン設定・診断・起動

```
cd <clone 先>
cp .env.example .env        # §0 で済ませていれば不要
# .env に §2 でコピーしたトークンを記入
npm ci                      # package-lock.json どおりに入れる (npm install でも可)
npm run doctor              # 起動前に必ず
npm start
```

### `npm run doctor` の読み方 (起動前に必ず)

Discord もモデルも動かさず、設定・トークン環境変数の有無 (値は出さない)・役割文のプロトコル版・
`claude` / `codex` CLI・各チャンネルの作業ディレクトリと Git・`data/` の書き込み可否を並べる。

- **✅** … 問題なし
- **⚠️** … 動くが不利になる点 (例: `cwd` が Git リポジトリでないので差分が検収材料にならない)。
  そのままでも起動できる
- **❌** … 起動しても失敗する。**直してから `npm start`**。1 件でもあると終了コードが 1 になる

最後の行が `診断: 起動できる見込み (⚠️ N 件)` なら次へ進んでよい。
`診断: ❌ N 件 / ⚠️ M 件 — ❌ を直してから npm start` なら、上の ❌ 行がそのまま直す場所。

**clone 直後に例をコピーしてトークンだけ入れた状態ではこう出る**
(`[cli]` の行と `[data]` の 2 行は環境で変わる — `data/` は初回起動時に作られるので、
まだ無い状態では「確かめられなかった」になる):

```
✅ [config] config.policy.json + config.secrets.json は検証を通った (bot 2 体 / channel 1 件)
❌ [config] guildId が設定例のまま (000000000000000000) — 起動を許可する Discord サーバーの ID に置き換える (SETUP.md §1。開発者モードでサーバー名を右クリック → ID をコピー)
❌ [config] allowedUserIds が設定例のまま (000000000000000000) — 自分の Discord ユーザー ID に置き換える。例の値のままだと全メンションが拒否されます
❌ [config] ownerUserId が設定例のまま (000000000000000000) — 自分のユーザー ID に置き換えるか、人間への通知を使わないならキーごと消す
✅ [roles] roles/_common.md のプロトコル版は一致
✅ [bots.manager] 環境変数 MANAGER_DISCORD_TOKEN は設定されている (値は表示しない)
✅ [bots.manager] 役割文 roles/manager.md のプロトコル版は一致
✅ [bots.worker] 環境変数 WORKER_DISCORD_TOKEN は設定されている (値は表示しない)
✅ [bots.worker] 役割文 roles/worker.md のプロトコル版は一致
✅ [cli] <claude の実体パス> --version → 2.1.269 (Claude Code)
❌ [channels.my-project] cwd が設定例のまま (C:/path/to/your/project) — このチャンネルで作業するディレクトリの絶対パスに置き換える (SETUP.md §0)
⚠️ [data] data/ の書き込み可否を確かめられなかった (無ければ起動時に作られる)
✅ [data] data/society.json は無いが society.mode は off — 台帳は要らない
✅ [discord] Discord への接続とモデルの起動は診断では行わない — `npm start` のログと SETUP.md §4 の動作確認で確かめる

診断: ❌ 4 件 / ⚠️ 1 件 — ❌ を直してから npm start
```

**「設定例のまま」の 4 件は、埋めるべき場所がまだ埋まっていないという意味**で、埋めれば消える。
値の形 (非空の文字列) としては正しいので起動時の検証は通ってしまう — だからここで止める。
**例の ID のまま起動すると、スラッシュコマンドの登録が `Missing Access` で落ち、メンションも
全部拒否される** (どちらもログからは設定の取り違えだと読み取りにくい)。

### CLI が見つからないとき (`claudeBin` / `codexCmd`)

どちらも**書かなければ PATH から探す**。PATH に `.exe` があればそれを直接起動する。Windows の
npm グローバルは `.cmd` シムで Node から直接起動できないので、その場合はシムの中身を読んで実体
まで辿る (npm が置くシムの実物で確認済み。pnpm も同じ書式だが実機未確認)。辿れない配置なら、
実体を明示する:

```json
"claudeBin": "C:/path/to/claude.exe",
"codexCmd": ["node", "C:/path/to/node_modules/@openai/codex/bin/codex.js"]
```

`claudeBin` は**文字列 1 語でも語の配列でも**書ける。`codexCmd` も同じ。1 語なら PATH から解決し、
絶対パスならそのまま使う (`.cmd` を指した場合は中身を読んで実体へ辿る)。

### 起動

コンソールに `[manager] logged in as ...` `[worker] logged in as ...` が出れば接続完了。

`npm start` は再起動ラッパー `scripts/run.mjs` 経由でブリッジ本体を起動する。Discord で `/restart` を
打つと本体が終了コード 42 で終わり、ラッパーが `node --env-file=.env src/index.js` を spawn し直す
(コードと `.env` を読み直す)。**それ以外の終了コード = クラッシュではラッパーも終了する** — 暴走ループと
二重ログインを防ぐためで、その場合はターミナルで `npm start` をやり直す。ターミナルを閉じるとブリッジも
止まる点は従来どおり。

## 4. 動作確認

`cwd` に指定したディレクトリを **git リポジトリにしておく** (`git init` でよい)。必須ではないが、
リポジトリでないと `📋 実行前後の git status 差分` が出ず、何が変わったかを機械的に確かめられない。

1. `#my-project` で `@Manager こんにちは。今の作業ディレクトリで ls して何があるか教えて`
2. スレッドが生え、⏳→⚙️→応答が返れば疎通 OK
3. 委譲テスト: `@Manager hello.txt に「こんにちは」と書くタスクを Worker に委譲して`
   - **これは書込みを許したチャンネルでしか通らない。** §0 で `config.policy.example.json`
     (readonly) の方を写したままなら Worker は「書けない」と返す。ここまで来たら `cwd` は既に
     自分のパスへ直してあるので、**写し直さず** `config.policy.json` の `channels.my-project` に
     この 2 行を足して (`cp` し直すと `cwd` が `C:/path/to/your/project` へ巻き戻る)、
     ターミナルで `npm start` をやり直すか Discord で `/restart` を打つ:

     ```json
     "tools": "standard",
     "permissionMode": "acceptEdits"
     ```

   - Manager の返信末尾の `[[handoff:worker]]` で Worker が起動し、実装 → `[[handoff:manager]]` →
     Manager が検分して報告、まで自動で回れば完成
   - フッターの行は Discord には出ず、代わりに末尾へ実メンションが 1 つ付く。
     `⚠️ メンション制御の警告` が出たときは、そこに書かれた理由 (未知の宛先・フッターが 2 個・
     平文で呼んでいる等) でその委譲は**実行されていない**

## 5. 一周の確認 (接続だけで終わらせない)

- 成果ファイル (`hello.txt`) が `cwd` に出来ていること
- スレッドに `📋 実行前後の git status 差分` と (hooks を有効にしていれば) `🔧 ツール軌跡` が
  出ていること
- `verify` を書いたチャンネルなら verify の結果行が出ていること
- `/status` の末尾の行に `job N 本 (ok N)` が出ていること。**「完了」の節はボードのタスク
  (自律運転) 用**なので、メンションで動かしただけの job はそこには載らない。自律運転を
  設定していないチャンネルでは、運転の行も `自律運転は未設定 (このチャンネルはメンションで
  動きます)` と出る
- bot を 2 体以上入れたサーバーでは、**`/status` や `/restart` をどのアプリのコマンドとして
  打っても同じブリッジに届く** (同じプロセスが両方の bot に登録するため)

## トラブルシューティング

- `/stop` `/restart` が Discord の入力候補に出ない → まず起動ログを見る。`スラッシュコマンドの登録に失敗`
  が出ていればその理由 (権限・レート制限・`guildId` の指定間違いなど) が原因。ログ上は成功しているのに
  出ない場合は Discord クライアント側のキャッシュなので、Ctrl+R で再読込する
- `スラッシュコマンドの登録に失敗: Missing Access` → **`guildId` が実在しないサーバーを指している。**
  例のまま (`000000000000000000`) なら案内にその旨が出る。書き換えたつもりなら、bot がそのサーバーに
  招待されているかも確認する。この状態ではメンションも `guildId` 不一致で拒否される
- **同じサーバーで 2 つのブリッジを動かしている** (例: 本番と試用) → スラッシュコマンドは
  **プロセスごとに全 bot へ登録される**ので、入力候補には同じ `/restart` が複数並ぶ。どのアプリの
  コマンドを選んだかで**止まるブリッジが変わる**。試用側を操作したいなら、そのブリッジの bot を
  選ぶか、ターミナルで Ctrl-C → `npm start` する方が確実
- `[<bot名>] ログイン失敗: Used disallowed intents` → **その bot だけ** MESSAGE CONTENT INTENT が未設定。
  Developer Portal → 該当アプリ → Bot → Privileged Gateway Intents で ON → Save → 再起動
- `[<bot名>] ログイン失敗: An invalid token was provided` → `.env` のそのトークンが失効/貼り間違い。
  Reset Token して再記入
- bot がメンションに無反応 → MESSAGE CONTENT INTENT の ON を確認。`guildId` と `allowedUserIds` が
  例の値のままだと**全メンションが黙って拒否される** (`npm run doctor` が ❌ で教える)
- `⚠️ このチャンネル (…) は config.policy.json の channels に未登録です` → 警告に**今のチャンネル名と
  登録されている名前**が並ぶので、綴りを見比べる。判定は完全一致で、スレッドは親チャンネルの名前を見る
  (Discord は作成時に小文字化・空白を `-` に変えるが、`_` はそのまま残る)
- `npm run doctor` / `npm start` が `node: .env: not found` だけ出して終わる → `.env` がまだ無い。
  `cp .env.example .env` してトークンを記入する (どちらも `--env-file=.env` で起動するため)
- `no JSON result` エラー → そのチャンネルの `cwd` で `claude -p "test"` を手で叩いて認証・動作を確認
- `PATH に claude が見つかりません` / `PATH に codex が見つかりません` → その CLI が入っていないか、
  PATH に無い。入れ直すか、§3「CLI が見つからないとき」のとおり `claudeBin` / `codexCmd` に実体を書く
- `<パス> から実体を辿れません` → `claudeBin` / `codexCmd` に書いた `.cmd` シムから起動先を読めなかった。
  そのシムが起動している実体 (`.exe` か `.js`) を直接指定する。`.js` なら
  `["node", "<その .js のパス>"]` の形で書く
- `<コマンド> を起動できません` (doctor) → パスは辿れたが `--version` が返らない。そのコマンドを
  ターミナルで直接叩いて、認証やインストールの状態を確かめる
- 役割文を編集したら「版不一致・要 restart」→ `/restart` (役割文は job ごとに読み直されるが、パーサは
  プロセス起動時のまま)
