# pi ランタイム

> [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) で動く bot。
> codex のモデル (OpenAI の GPT 系) を **claude と同じ制御**で動かすためのランタイム。
> 経緯と実機の記録は [docs/notes/2026-10-12-pi-probe.md](../notes/2026-10-12-pi-probe.md)。

## なぜ pi か

codex ランタイムは権限が sandbox の 2 値 (read-only / workspace-write) しかなく、hook も
セッションの継続も持たない (能力表 `src/runtime.js` で `pathScopedPermissions` / `hooks` /
`resume` が false)。だから codex の bot には touch 制限つきの委譲を渡せず、verify NG も
1 回目が最終 NG になる。pi は最小のハーネスで、権限・hook・構造化出力を持たない代わりに
**拡張から道具の呼び出しと「終わる直前」に割り込める**。そこへ communitd の規則を入れる。

## 設定

```json
"piCmd": ["node", "C:/Users/<you>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
"bots": {
  "reviewer": {
    "tokenEnv": "REVIEWER_DISCORD_TOKEN",
    "displayName": "Reviewer",
    "runtime": "pi",
    "model": "openai/<model-id>",
    "effort": "xhigh",
    "rolePromptFile": "roles/reviewer.md"
  }
}
```

- 導入: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.1.0`。
  `piCmd` を書かなければ PATH の `pi` を引く (src/clicmd.js — claude / codex と同じ解決)
- ログイン: pi を一度起動して `/login` (ChatGPT のアカウントなら OpenAI → ChatGPT Plus/Pro)。
  保存先は `~/.pi/agent/auth.json`。pi はこのファイルをロックして扱う (proper-lockfile) ので、
  job が並んでも壊れない。codex CLI のログインとは別のログインになる。
  確かめるなら `pi auth check --provider openai --no-refresh --json` (モデルは呼ばない)
- `model` は pi の `provider/id` で書く (省略不可)。`effort` は pi の `--thinking` の値
  (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`)
- engines は Node 22.19 以上だが、22.17 でも動いた (2026-10-12)

## 権限 — claude と同じ設定で決まる

**チャンネルの `tools` / `allowedTools` / `permissionMode` と、契約の touch 制限がそのまま効く。**
`codexSandbox` は見ない。照合は job ごとの拡張 (src/pi-extension.js) が道具の呼び出し
1 回ずつに行い (src/pi-policy.js)、止めた呼び出しは理由つきでモデルへ返る。

| pi の道具 | 照合する名前 | 通る条件 |
|---|---|---|
| `read` / `grep` / `find` / `ls` | Read / Grep / Glob | 作業ディレクトリ (と `claudeAddDirs`) の中。裸の `Read` などがあれば場所を問わない |
| `edit` / `write` | Edit / Write | 作業ディレクトリ (と参照ディレクトリ) の**実体の中**だけ。`acceptEdits` なら全部、`default` は裸の `Edit` / `Write` か、`Edit(./パス)` との完全一致 (既存ファイルの `edit` だけ — 新規作成の `write` は通らない)。`plan` は書けない |
| `bash` | Bash | 裸の `Bash` なら全部。`Bash(git *)` のようなルールは、連結 (`&&` `\|\|` `;` `\|` `&`) をほどいた**全部の片**が合うときだけ |

claude の照合を完全には再現できないところは、**claude より狭く倒す**:

- シェルのコマンド置換 (`$(` / バッククォート)・プロセス置換・`/dev/null` と `2>&1` 以外の
  リダイレクトは、ルールに合っても通さない (コミットメッセージにバッククォートを書いても止まる)
- 前置きの代入 (`FOO=1 git status`) や wrapper (`timeout 10 git …`) はルールに合わない
- パス限定の `Edit(./パス)` は touch 集合を作ったのと同じ関数 (src/toolrules.js の
  `describePathRule`) で対象を規則の形へ直して完全一致だけを通す — リンク・hardlink・予約名も止まる。
  gitignore 形のパターン (`Edit(./src/**)`) は完全一致しないので止まる
- **pi が道具の中で書き換えるパスの形は断る**: 先頭の `@` (pi が外す)・`~` (ホームへ展開)・`file://` などの URL・
  `/c/…` `/mnt/c/…` (Windows で `C:\…` へ読み替え)・特殊な空白 (普通の空白へ置換)。照合は生の値を
  作業ディレクトリ基準で解いて行うので、通すと照合したパスと触るパスがずれる (2026-10-12 のレビューで、
  `~/x` の書込みと `@../x` の読取が作業ディレクトリの外へ届くのを再現した)
- Windows が特別扱いする名前 (代替データストリームの `:`・`NUL` などの予約名・末尾の空白やドット) は、
  モードに関係なく読み書きとも断る (touch 集合の変換と同じ基準)
- 設定の絞り込み (`tools` / `disallowedTools`) が配列でない、`permissionMode` が `null` などの壊れた設定は全部止める
- `WebSearch` / `WebFetch` に当たる道具は pi に無い (許可されていても使えない)。
  `PowerShell` の道具も見せない (シェルは Git Bash)

使えない道具はそもそも見せない (`--tools` を権限から組む)。止めた呼び出しは
claude の `permission_denials` と同じ形で返し、承認の候補 (src/bridge/turn.js) になる。
ツール軌跡には載せない (pi は止めた呼び出しにも失敗として実行の終わりを出すが、claude の軌跡も拒否は載せない)。

裸の `Read` があるチャンネルでは、claude の bot と同じく作業ディレクトリの外も読める —
pi のログイン情報 `~/.pi/agent/auth.json` も含む (`~/…` の形は断るが、絶対パスなら届く)。

**OS の囲いは無い。** codex の sandbox (書込みは作業ツリーだけ・ネットワーク遮断) は効かず、
許可ルールだけになる — Windows 上の claude ランタイムと同じ立場。

## 足踏みで止める

権限で通る呼び出しでも、**直前とまったく同じ呼び出し (道具と引数) を続けて 3 回目**からは止めて、
「直前の結果やエラーを読み直して、引数かやり方を変えて。進められないなら報告して終えて」と返す
(src/pi-extension.js の `createRepeatGuard`)。違う呼び出しが 1 回でも挟まれば数え直すので、
編集してから同じファイルを読み直す・テストを流し直す、のような普通の流れでは鳴らない。
促しや verify の差し戻しで会話へ材料を足したときも数え直す。最終報告の道具は数えない。

- 由来: arXiv 2610.12176 (MASS) の付録 I.2。モデル自身が進化させたワークフローに
  「同じ呼び出しを引数を変えずに 2 回を超えてくり返したら止めて、直前のエラーを読み直す」が入っていた
  (論文の失敗例は、裏で走らせたシェルのログを同じ引数で見に行き続けるもの)
- 止めた呼び出しは**承認の候補にしない** (権限で止めたのではない)。記録は止めた呼び出しと同じファイルに
  `stall: true` の印で書き、src/pi.js が `permissionDenials` から外して件数を `stallBlocks` で返す。
  軌跡にも載せない。止めた job があればブリッジのログに `[pi] <スレッド>:<bot> 同じ呼び出しのくり返しを n 回止めた`
- job は終わらせない (止めるのはその呼び出しだけ)。抜け出せなければ job の時間切れが上限

## 最終報告 — 道具の引数で受け取る

pi には最終出力をスキーマで縛る口が無い。役割文が様式を宣言している bot (`communitd-schema`) では、
拡張が道具 `submit_report` を登録し、**引数のスキーマ = 契約のスキーマ**にする。pi は素の
JSON Schema も検証するので、合わない引数は理由つきでモデルへ返り、モデルが出し直す。
受け取った引数が `structuredOutput`、`result` はその JSON 文字列 (claude と同じ形)。
実行文脈には「最後に `submit_report` を呼ぶ」の 1 行が出る。呼ばずに終えようとしたら
2 回まで促し、それでも無ければ様式不履行として扱う (本文へ縮退)。

## verify の差し戻し — 終わる直前に割り込む

`hooks: true` のチャンネルでは、拡張が `agent_before_settle` (pi が止まる直前) で
verify を走らせ、NG なら理由を同じ会話へ差し込んで続けさせる。回数・状態ファイルは
claude の Stop hook と同じ `runVerifyHook` (src/verify.js) なので、`verifyMaxRetries` も
ブリッジ側の読み取り (verify-failed の判定・計測) もそのまま。
`hooks: false` のチャンネルでは拡張は検証せず、ブリッジが最後に 1 回だけ検証する。

- **報告が無い回は、検証より先に促す** (促しの枠が残っている間)。先に検証すると、報告を忘れた回の
  たびに verify が丸ごともう 1 回走る。検証は報告が手元にあるときか、促しを使い切った後
- **差し戻したら報告ファイルを消して取り直す。** 残すと、直した後に報告を出し直さずに終えたとき、
  差し戻し前の報告 (直す前の本文・変更ファイル) が合格した成果として配送される
- 最終回答の本文は**最後の応答の本文だけ** (報告の道具が無い job)。前の応答の独り言を持ち越さない

## 起動のしかた (src/pi.js)

- `--mode json`: イベントを JSONL で stdout へ出して終わる。**プロンプトは stdin**
  (Windows のコマンドラインは約 32k 字が上限で、role + transcript はそれを超える)
- 役割文は job ごとのスナップショットを `--append-system-prompt <ファイル>` で渡す。
  pi はファイルが無いと**パスの文字列そのもの**を指示文にするので、起動前に在ることを確かめる
- `--no-session`: この版はセッションを残さない。文脈は codex と同じく毎回スレッド transcript を
  再構成する (resume は次の版)
- 拡張・スキル・テンプレート・テーマ・MCP は **この job の拡張だけ**に絞る。
  `--no-approve` で作業対象のリポジトリの `.pi/` (プロジェクトの設定と拡張) を読まない —
  読ませると、リポジトリに置かれた拡張が pi のプロセスの中で動く。AGENTS.md / CLAUDE.md は読む
- 環境: `PI_TELEMETRY=0` (利用状況を送らない)、`PI_OFFLINE=1` (起動時の版確認・モデル一覧の更新をしない)、
  Discord のトークンは claude / codex と同じく渡さない。拡張の設定は `COMMUNITD_PI_CONFIG` が指す一時ファイル
- 計測: `message_end` の usage を合算する (`input` は cache を含まない — claude と同じ物差し)。
  ツール軌跡は `tool_execution_end` から書く (hook のプロセスが要らないので、hooks の設定に関係なく常に取る)

## まだ無いもの

- セッションの継続 (resume) と、長くなったセッションの切り替え (T-2)
- `apply_patch` — codex のモデルは V4A の差分で鍛えられている。第三者の拡張
  (`pi-openai-codex-compat` など、pi 1.1 系に固定) を入れて版を固定する予定
- 実行中の承認カード (claude だけ)
- 画像は `@パス` で渡す (未実測)
