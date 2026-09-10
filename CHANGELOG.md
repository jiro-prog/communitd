# Changelog

このファイルの書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従う。

## [Unreleased]

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

[Unreleased]: https://github.com/jiro-prog/communitd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jiro-prog/communitd/releases/tag/v0.1.0
