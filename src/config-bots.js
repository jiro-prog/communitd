// bot の定義 (`bots.<key>`) と CLI の起動コマンド (`claudeBin` / `codexCmd`) の検証。

import { CLAUDE_EFFORTS } from './claude.js';
import { CODEX_EFFORTS } from './codex.js';
import { validateBotDuties } from './config-initiative.js';
import { isNonEmptyString, isPlainObject } from './config-util.js';

/**
 * `bots.<key>` に必ず要るキーと、欠けたときに何を書けばよいか。
 *
 * **どれも「書き忘れても起動はする」状態だった** — 症状は起動時ではなく job の途中に出る
 * (`model` が無ければ `--model undefined` で spawn が落ち、`rolePromptFile` が無ければ
 * その bot だけ役割文なしで走る)。SETUP と README は必須と書いているので、
 * 文書のほうが正しく、検証を合わせる。
 */
export const BOT_REQUIRED_KEYS = [
  ['tokenEnv', '.env に置く Discord トークンの環境変数名。例: "MANAGER_DISCORD_TOKEN"'],
  ['displayName', 'Discord 上の表示名。例: "Manager"'],
  ['model', 'claude --model へそのまま渡るモデル名。例: "opus" / "sonnet"'],
  ['rolePromptFile', 'その bot の役割文のパス。例: "roles/worker.md" — ファイル名がそのまま役の名前になる'],
];

/**
 * `bots.<key>.runtime` に書ける値。**省略 = `claude`。**
 *
 * 綴り違いを黙って通すと、コード側は 10 箇所以上で `runtime === 'codex'` の厳密一致を見て
 * いるので**全部が claude 側へ倒れる** — `"Codex"` と書いただけで、起動する CLI も
 * `effort` / `codexInstructionsFile` の可否も `model` の要否も、まとめて黙って変わる。
 * 「どの CLI が動くか」は無症状で間違えていい設定ではないので、閉集合で縛る。
 */
export const BOT_RUNTIMES = ['claude', 'codex'];

/**
 * `runtime: "codex"` の bot では省略できるキー。
 *
 * codex の `-m` は**条件付き**で渡している (`src/codex.js`) ので、`model` を書かなければ
 * codex 側の既定モデル (`~/.codex/config.toml`) で走る。しかも `codex exec --help` は
 * 使えるモデル名を列挙しないので、**書かせると third party は当てずっぽうになる**。
 * claude は `--model` を無条件で渡すため省略できない (`src/claude.js`)。
 *
 * ただし**書いたなら効く値であること**は要る — 空文字は「設定したつもり」の典型。
 */
export const CODEX_OPTIONAL_BOT_KEYS = ['model'];

/**
 * bot 同士で displayName が衝突していないか。
 * 同じ表示名が 2 体に付いていると、**人間はスレッド上でどちらを指しているか見分けられず**
 * (メンション候補にも同じ名前が 2 つ並ぶ)、旧記法の警告 (`src/mentions.js` の
 * `detectLegacyMentions`) も宛先を言い当てられない。owner の呼び名との衝突
 * (`validateOwnerNameClash`) と同じ理由で起動時に落とす。
 * 照合は trim + 大文字小文字無視 (検出側の正規表現が i フラグで、名前も trim するため)。
 */
export function validateDisplayNameClash(config = {}) {
  if (!isPlainObject(config.bots)) return [];
  const errors = [];
  const seen = new Map(); // 正規化した表示名 → 先に名乗った [bot キー, 綴り]
  for (const [key, bot] of Object.entries(config.bots)) {
    const displayName = bot?.displayName;
    // 欠落・型違いは BOT_REQUIRED_KEYS 側が落とす (同じ設定に 2 行出さない)
    if (!isNonEmptyString(displayName)) continue;
    const normalized = displayName.trim().toLowerCase();
    const first = seen.get(normalized);
    if (first === undefined) {
      seen.set(normalized, [key, displayName]);
      continue;
    }
    // **両方の綴りを出す。** 片方だけだと「うちは Sol とは書いていない」で終わってしまう
    // (照合は trim + 大小文字無視なので、見た目が違っても衝突する)
    errors.push(
      `bots.${first[0]} / bots.${key} の displayName が重複 — メンションの解決が曖昧になる ` +
        `(前後の空白と大小文字は無視して照合: ${JSON.stringify(first[1])} / ${JSON.stringify(displayName)})`,
    );
  }
  return errors;
}

/**
 * `claudeBin` / `codexCmd` の型検証。
 *
 * **この 2 つは「起動できません」のエラー文が案内する唯一の直し先**なので、書き損じを
 * 黙って既定へ落とすと、直したつもりで同じエラーが出続ける (Opus2 指摘 2026-09-10 —
 * `"codex"` (文字列でなく) / `[]` / `42` のどれもエラー 0 で通っていた)。
 *
 * 書ける形は 2 つ: 実行ファイル名かパスの文字列 1 語 (`"claude"`)、または
 * 語の配列 (`["node", "…/cli.js"]`)。**空配列は「設定したつもり」の典型**なので落とす。
 */
export function validateCliCommands(config = {}) {
  const errors = [];
  for (const key of ['claudeBin', 'codexCmd']) {
    const value = config?.[key];
    if (value === undefined) continue;
    const ok = isNonEmptyString(value)
      || (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString));
    if (ok) continue;
    errors.push(
      `${key} は実行ファイルの名前かパスを文字列で、または語の配列で書く `
      + `(受け取った値: ${JSON.stringify(value)}／例: "claude" / `
      + '["node", "<npm prefix>/node_modules/@openai/codex/bin/codex.js"]・省略可)',
    );
  }
  return errors;
}

/**
 * `bots.<key>` の起動時検証 (1 体ずつの必須キー・runtime・effort・duty と、bot 間の表示名の衝突)。
 *
 * @returns {string[]} 人間向けエラー行
 */
export function validateBots(config = {}) {
  const errors = [];
  for (const [key, bot] of Object.entries(isPlainObject(config.bots) ? config.bots : {})) {
    if (!isPlainObject(bot)) {
      errors.push(`bots.${key} はオブジェクトで書く (${BOT_REQUIRED_KEYS.map(([k]) => k).join(' / ')})`);
      continue;
    }
    // どの CLI で走るか。**この 1 語が他の検証の分岐にもなる**ので、先に閉集合で縛る
    if (bot.runtime !== undefined && !BOT_RUNTIMES.includes(bot.runtime)) {
      errors.push(
        `bots.${key}.runtime: ${JSON.stringify(bot.runtime)} は不明 `
        + `(${BOT_RUNTIMES.join(' | ')} のどれか・省略時は ${BOT_RUNTIMES[0]}) `
        + '— 知らない値を黙って claude 扱いにすると、起動する CLI も model の要否も変わる',
      );
    }
    // **欠けたら起動しない。** どれも「書いてあるつもり」で落ちると、症状が起動時ではなく
    // job の途中に出る — `model` が無ければ `--model undefined` で spawn が落ち、
    // `rolePromptFile` が無ければその bot だけ役割文なしで走る
    const codexOptional = bot.runtime === 'codex' ? CODEX_OPTIONAL_BOT_KEYS : [];
    for (const [required, hint] of BOT_REQUIRED_KEYS) {
      const value = bot[required];
      if (isNonEmptyString(value)) continue;
      if (codexOptional.includes(required)) {
        // 省略は許すが、書いたなら効く値であること
        if (value === undefined) continue;
        errors.push(
          `bots.${key}.${required} は非空の文字列で書く `
          + `(runtime: "codex" では省略もできる — その場合は codex の既定モデルが使われる`
          + `／受け取った値: ${JSON.stringify(value)})`,
        );
        continue;
      }
      errors.push(
        `bots.${key}.${required} が要る (${hint}／受け取った値: ${JSON.stringify(value ?? null)})`,
      );
    }
    // 推論量はランタイムごとに値域が違う (claude の `--effort` / codex の
    // `model_reasoning_effort`)。**値域の正本は src/claude.js と src/codex.js の 1 箇所ずつ**で、
    // ここは runtime で引き分けるだけ。codex で書けるようにしたのはモデル側の制約のため —
    // `gpt-5.5` は `max` を拒むので、ユーザー ~/.codex/config.toml が `max` の環境では
    // bot ごとに下げられないと起動できない (実測 2026-09-11)
    const effort = bot.effort;
    const runtime = bot.runtime === 'codex' ? 'codex' : 'claude';
    const effortLevels = runtime === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
    if (effort !== undefined && !effortLevels.includes(effort)) {
      errors.push(
        `bots.${key}.effort: ${JSON.stringify(effort)} は runtime: "${runtime}" では使えない ` +
          `(claude: ${CLAUDE_EFFORTS.join(' | ')} ／ codex: ${CODEX_EFFORTS.join(' | ')}・省略可)`,
      );
    }
    // Codex 組み込み指示の差し替え (相談役として立てる bot の口 — src/codex.js)。
    // claude ランタイムには配線が無いので、書いたのに効かない状態を黙って通さない。
    // **ファイルの存在確認はしない** — config.js は fs を持たない (冒頭のとおり副作用なし)。
    // 読めるかどうかは doctor と、起動時の runCodex が見る
    const codexInstructions = bot.codexInstructionsFile;
    if (codexInstructions !== undefined) {
      if (bot.runtime !== 'codex') {
        errors.push(
          `bots.${key}.codexInstructionsFile は runtime: "codex" でしか使えない ` +
            '(claude ランタイムには配線されていない)',
        );
      } else if (!isNonEmptyString(codexInstructions)) {
        errors.push(
          `bots.${key}.codexInstructionsFile: ${JSON.stringify(codexInstructions)} は不正 ` +
            '(リポジトリ相対のパスを非空の文字列で書く・省略可)',
        );
      }
    }
    // duty は発議の巡回とイベント配信の宛先を決める。綴り違いを黙って無視すると
    // 「拾うつもりのイベントが誰にも届いていない」まま静かに動く
    errors.push(...validateBotDuties(bot, { botKey: key }));
  }
  // 1 体ずつ見ても分からない衝突は、ループを抜けてから見る
  errors.push(...validateDisplayNameClash(config));
  return errors;
}
