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
一時 `CODEX_HOME` には認証情報のコピーが入るため、成功・失敗・停止・タイムアウトの
どの経路でも削除する。用意に失敗した場合は `--ignore-user-config` へ退避する
(= sandbox は `read-only` に固定される。fail-closed)。ただし `workspace-write` を
指定したチャンネルと、組み込み指示を差し替える bot (次節) では**退避せずに落とす** —
どちらも隔離 `config.toml` が読まれないと成立せず、黙って走らせると「そのつもりで
渡した実行文脈」が実物と食い違うため。

`plugins` / `marketplaces` を持ち込まないのも意図的で、隔離環境でこれらを読ませると
モデル一覧の取得が終わらず job が固まる。また Windows では
`[windows] sandbox = "unelevated"` が必須 — 無いと `sandbox_mode` に関わらず
`read-only` へ落ち、`"elevated"` にすると書込み時に昇格待ちで無応答になる (いずれも実測)。

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

