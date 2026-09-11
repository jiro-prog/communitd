# codex ランタイム

> claude の代わりに codex exec で動く bot の sandbox と、組み込み指示の差し替え。
> 入口は [README](../../README.md)、導入手順は [SETUP.md](../../SETUP.md)。

## sandbox (書込みの可否)

チャンネルごとに `codexSandbox` で決める。**既定は `read-only`**、`workspace-write` を
書いたチャンネルでだけ codex の bot がファイルを作れる。未知の値は起動時に落とす
(綴り違いが「解放したつもり」にならないようにするため)。claude 側の `tools` /
`allowedTools` は codex には効かないので、**書込みを許すチャンネルには両方書く**。
決めた値はそのまま実行文脈へ出るので、その bot は毎回自分が書けるかを知って走る。

```json
"channels": {
  "sandbox":   { "cwd": "...", "codexSandbox": "workspace-write" },
  "my-project": { "cwd": "..." }
}
```

`workspace-write` でも書けるのは作業ディレクトリと OS の一時領域だけで、
その外への書込みは拒否される (実測確認済み)。

**なぜ `--ignore-user-config` を使っていないか**

`~/.codex/config.toml` の MCP サーバーを読み込ませないために以前は
`--ignore-user-config` を付けていたが、codex v0.144.5 ではこのフラグが

- `--sandbox` と `-c sandbox_mode` を無視して sandbox を `read-only` へ固定する
- `model_reasoning_effort` も無視して `none` へ落とす (推論なしでレビューさせてしまう)

という副作用を持つ。そこで **job ごとに一時的な `CODEX_HOME` を作り、必要なキーだけを
書き起こした `config.toml` と認証情報だけを置く**方式に変えた。ユーザー設定を削って使う
のではなく必要なものだけ書くので、`[mcp_servers.*]` は最初から存在しない。
一時 `CODEX_HOME` には認証情報のコピー (`workspace-write` では sandbox ユーザーの
資格情報も) が入るため、成功・失敗・停止・タイムアウトに加え、**起動そのものに失敗した
経路** — `spawn` の同期例外、出力先を作れない、codex コマンドを解決できない — でも削除する。
Windows では kill された codex が sqlite を掴んだままで `EBUSY` になることがあるので、
間隔を空けて 3 回までやり直す。**告知は 1 回目の失敗の時点で出す** —
`[codex] … を削除できません: <パス> … 3 回やり直します` の 1 行。やり直しのタイマーは
プロセスの終了を止めないので、`/restart` や停止がその間に挟まると結末を言う機会が
来ず、資格情報の写しが誰にも知られないまま残ってしまう。やり直して消えたら
`… を削除しました (N 回目)`、最後まで消せなければ `… の削除に失敗` を出す
(**黙って残さない**。人が手で消せるようにどの行にもパスを添える)。
用意に失敗した場合は `--ignore-user-config` へ退避する
(= sandbox は `read-only` に固定される。fail-closed)。ただし `workspace-write` を
指定したチャンネルと、組み込み指示を差し替える bot (次節) では**退避せずに落とす** —
どちらも隔離 `config.toml` が読まれないと成立せず、黙って走らせると「そのつもりで
渡した実行文脈」が実物と食い違うため。

`plugins` / `marketplaces` を持ち込まないのも意図的で、隔離環境でこれらを読ませると
モデル一覧の取得が終わらず job が固まる。また Windows では
`[windows] sandbox = "unelevated"` が必須 — 無いと `sandbox_mode` に関わらず
`read-only` へ落ち、`"elevated"` にすると書込み時に昇格待ちで無応答になる (いずれも実測)。

**Windows: `workspace-write` では sandbox の状態も写す**

書込みを許す job では、実 `CODEX_HOME` から次の 3 つも隔離 home へ写す。

- `cap_sid`
- `.sandbox-secrets/sandbox_users.json` (sandbox 用ローカルユーザーの資格情報)
- `.sandbox/setup_marker.json`

これが無いと codex は `.sandbox/sandbox.<日付>.log` に
`sandbox setup required: sandbox setup marker missing or incompatible` と書いて sandbox の
setup をやり直そうとし、**最初のコマンドが返らないまま job のタイムアウトまで沈黙する**
(実測 2026-09-11、codex 0.144.5 と 0.154.0 の両方。`sandbox_users.json` だけ欠けても
`sandbox users missing or incompatible with marker version` で同じ症状になる)。
`.sandbox-bin` (command-runner 群・数百 MB) は写さなくてよい。

`read-only` では写さない — sandbox setup を要さずに通るうえ、資格情報を要らない job の
一時領域にまで置かないため (`auth.json` と同じ扱い)。実 home に無ければ写さない
(非 Windows や、sandbox を一度も setup していない環境)。在るのに写せなかったときは隔離 home を
作らず、`workspace-write` は降格せずに落ちる — 中途半端な home で起動すると、症状が
「無反応のまま固まる」に戻るため。

## 推論量 (`effort`)

`bots.<key>.effort` に `none | minimal | low | medium | high | xhigh | max` を書くと、その値が
隔離 `CODEX_HOME` の `model_reasoning_effort` になる。**書かなければユーザー
`~/.codex/config.toml` の値がそのまま写る**ので、既存の bot の振る舞いは変わらない
(claude ランタイムの `effort` は `--effort` へ渡る別物で、値域も `low` 以上だけ →
[運用の口](operations.md))。

**bot ごとに変えられる必要があるのはモデル側の制約による。** ChatGPT アカウント認証の codex で
使える会話モデル `gpt-5.5` は `model_reasoning_effort = "max"` を 400 (`reasoning.effort`) で
拒むため、ユーザー設定が `max` の環境ではその bot だけ下げないと毎回落ちる (実測 2026-09-11、
codex CLI 0.144.5)。「codex CLI が知っている値」と「そのモデルで通る値」は別物で、後者は
起動して初めて分かる。

```json
"bots": {
  "consult": { "runtime": "codex", "model": "gpt-5.5", "effort": "medium",
               "rolePromptFile": "roles/consult.md" }
}
```

上も codex 関連のキーだけの**部分例** (`tokenEnv` / `displayName` は省略)。未知の値は起動時の
検証で落とす — 隔離 `config.toml` へそのまま書くと codex が 400 で落ち、原因が「隔離 config の
中身」になって遠いため。なお隔離 `CODEX_HOME` を用意できず `--ignore-user-config` へ退避した
場合は、この指定も含めて `model_reasoning_effort` は `none` に落ちる (前節)。

## 相談役として使う (codex の組み込み指示を差し替える)

codex ランタイムは既定で Codex の「コーディングエージェント」用システムプロンプトを
持っている。`bots.<key>.codexInstructionsFile` を書くと、その指示が**指定したファイルの
内容で置き換わる** (`model_instructions_file`)。同じ codex ランタイムのまま、
コードを書く bot と、コードを書かない相談役を並べて置ける。

```json
"bots": {
  "reviewer": { "runtime": "codex", "rolePromptFile": "roles/reviewer.md" },
  "consult":  { "runtime": "codex",
                "rolePromptFile": "roles/consult.md",
                "codexInstructionsFile": "prompts/codex-consult.md" }
}
```

上は codex 関連のキーだけを抜き出した**部分例**で、どの bot にも要る `tokenEnv` と
`displayName` は省いてある (そのまま写すと起動時の検証で落ちる)。全部そろった形は
[SETUP.md](../../SETUP.md) の §0 を見ること。

**codex ランタイムでは `model` を省略できる** — `-m` は条件付きでしか渡さないので、書かなければ
codex 側の既定モデル (`~/.codex/config.toml`) で走る。指定するなら `codex exec -m` が受け付ける
名前を書く (claude ランタイムの `model` は `--model` へ無条件に渡るので省略できない)。

- 差し替わるのは**ランタイム組み込みの指示だけ**。`rolePromptFile` (共通規定 + その bot の
  職務 + 実行文脈) は従来どおり本文へ連結される。層が違うので置き場所も `roles/` ではなく
  `prompts/` に分けてある (`prompts/codex-consult.md` が最小の見本)。
- 未指定の bot は組み込み指示のまま。既存の bot の振る舞いは変わらない。
- 指示は**内容を隔離 `CODEX_HOME` へ写してから**指す。元のパスを `config.toml` へ書くと、
  読んでから codex が開くまでの間に書き換わった指示が乗る窓ができる (role prompt と同じ理由)。
- 読めないファイルを指していたら **spawn 前に落とす**。組み込み指示のまま黙って走ると、
  相談役のつもりの bot がコーディングエージェントとして応答してしまう。
- `claude` ランタイムの bot に書くと起動時に落とす (配線が無く、書いても効かないため)。
- 相談役には `codexSandbox` を上げない (既定の `read-only` のまま) のが素直。

