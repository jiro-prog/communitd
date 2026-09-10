# prompt cache の維持

> 会話履歴のキャッシュを job 境界で壊さないための扱い。
> 入口は [README](../../README.md)、導入手順は [SETUP.md](../../SETUP.md)。

claude ランタイムには `--exclude-dynamic-system-prompt-sections` を**全 job に常時**渡す
(`src/claude.js`)。CLI は既定の system prompt の末尾へ cwd / env / memory paths / **git status** を
入れており、job がファイルを触ると次の job でその中身が変わる。prompt cache は前方一致なので、
そこが変わると**その後ろの会話履歴が丸ごと**作り直しになる。このフラグはその塊を
最初の user メッセージへ移すので、**この要因による破壊は起きなくなる**。

- **消えるのは CLI 組込みの動的セクション起因の破壊だけ。** ブリッジ自身が
  `--append-system-prompt-file` で system prompt へ足している role (共通規定 + 役割文 +
  **実行文脈** + **委譲契約ブロック**) は job ごとに組み直しており、実行文脈は権限と編成
  (`/roster` とチャンネル既定) を、契約ブロックは依頼内容そのものを写す。ここが前 job と変われば、
  やはりその後ろの会話履歴は作り直しになる (`src/bridge/job.js` の `roleText`)。
  **system prompt に載る可変部の安定化は未着手** — `roleText` の変化と `cacheW` の相関を
  `tok` 行で観測してから設計する
- 効くのは**既定の system prompt を使っている場合だけ**。`--system-prompt` で置き換えると無視される
  (ブリッジは `--append-system-prompt-file` = 既定への追記なので対象)
- 実測: job 境界 33 回のうち 13 回で 250〜445k の `cacheW` が起きていた。
  TTL 切れでは説明できない — 189 分空いてヒット / 5 分でミスが混在する。
  小規模な A/B では `cacheW` 8.0k → 3.6k、`cacheR` 21.6k → 25.5k。
  **損失は履歴サイズに比例する**ので、長寿命スレッドほど 1 回あたりが大きい。
  ただし**この 13 回のうち何回が動的セクション起因かは切り分けられていない** —
  role の可変部も同じ位置で効くので、フラグで全部が消えるとは限らない
- 切り替えた直後の 1 回だけは prefix が変わるためコールドスタートになる (以後は再利用)

効果の判定には計測ログの `tok` を使う (→ [計測ログ](metrics.md))。

