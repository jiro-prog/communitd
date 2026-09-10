# セキュリティ

## まず知っておくこと

**communitd は「Discord のメッセージ」を「あなたのマシンでのコマンド実行」に変換します。**
このブリッジを動かすということは、Discord のチャンネルをローカルのシェルにつなぐということです。
権限の話はすべてこの一点から読んでください。

- **`allowedUserIds` に載せた人は、あなたの端末を渡されたのとほぼ同じです。** その人は、
  チャンネルに設定した作業ディレクトリの下でファイルを読み書きさせ、許可したシェルコマンドを
  走らせられます。**自分以外を載せるかどうかは、その重みで決めてください。**
- **`guildId` と `allowedUserIds` は必須です。** どちらかが空ならブリッジは起動を拒否します —
  設定漏れを「制限なし」と解釈しません。
- **既定は最小権限です。** チャンネルに `tools` を書かなければ `readonly`、`permissionMode` を
  書かなければ `default`。書込みやシェルは、そのチャンネルに明示的に書いたときだけ有効になります。
- **公開サーバー・共有サーバーでは `readonly` を使ってください。** 書込みが必要なら、書込み用の
  bot とチャンネルを分け、作業ディレクトリを使い捨ての作業ツリーに閉じてください。

## prompt injection の経路があります

スレッドの本文・引用・添付 (**画像の中に書かれた文字も、アップロードされたテキストファイルの
中身も**) は、ほぼそのままモデルへ渡ります。緩和はしていますが、保証ではありません。

とくに危ないのは **`WebFetch` / `WebSearch` と書込み権限を同じチャンネルに同時に与えること**です。
外部ページに書かれた文言が、そのままローカルの改変や情報の外部送信の指示として効きえます。
両方が必要なら、信頼できる作業ディレクトリに限ってください。

`.claude/agents/*.md` の agent 定義は、**設定ではなくコードに近い信頼対象**として扱ってください。
権限・使えるツール・作業場所・実行経路・永続状態を動かせます。出どころを信頼できるものに限ること。

境界と根拠の全文は [docs/reference/security-model.md](docs/reference/security-model.md)。

## 脆弱性の報告

**公開 issue には書かないでください。** GitHub の **private vulnerability reporting**
(リポジトリの Security タブ → "Report a vulnerability") から連絡してください。

含めてほしいもの: 再現手順 / 影響 (何が読める・書ける・実行できるようになるか) / 対象の版
(コミット SHA) / 環境 (OS・Node の版)。

**対応の目安**: これは個人が趣味で保守しているプロジェクトです。**受領の返信は 1 週間以内**を
目指しますが、SLA ではありません。修正の可否と時期は影響の大きさ次第で、直ったら報告者へ
知らせたうえで公開します (希望があればクレジットします)。

**対象外**: 設定どおりに動いた結果 (例:「`allowedUserIds` に入れた人がファイルを消せた」
「`full` を書いたチャンネルで任意コマンドが動いた」) は仕様です。上の「まず知っておくこと」が
その説明にあたります。

---

## Security (English summary)

- **This bridge turns Discord messages into command execution on your machine.** Anyone listed in
  `allowedUserIds` can effectively run commands on it — treat adding a user as handing them a terminal.
- `guildId` and `allowedUserIds` are mandatory; the bridge refuses to start without them.
  Defaults are least privilege (`readonly` tools, `default` permission mode).
- **Prompt injection is a real path**: thread text, quotes, text inside images and uploaded text
  files all reach the model. Granting `WebFetch`/`WebSearch` *and* write access to the same channel
  is the dangerous combination.
- **Report vulnerabilities privately** via GitHub's private vulnerability reporting (Security tab →
  "Report a vulnerability"), not in a public issue. Include repro steps, impact, the commit SHA and
  your environment (OS, Node version).
- This is a hobby project maintained by one person: expect an acknowledgement within about a week,
  not a guaranteed SLA. Behaviour that matches the documented configuration is not a vulnerability.
