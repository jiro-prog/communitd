// チャンネル設定 (`channels.<name>`) の解釈と検証 — ツール権限のプリセット、permissionMode、
// hooks / verify / 参照ディレクトリ / codex の sandbox / roster、チャンネル名からの引き当て。

import { resolve } from 'node:path';
import { CODEX_SANDBOXES, DEFAULT_CODEX_SANDBOX } from './codex.js';
import { validateAutonomy } from './config-autonomy.js';
import { inRange, isNonEmptyString, isPlainObject } from './config-util.js';

/**
 * ツール許可プリセット (claude ランタイム用)。
 * config.channels.<name> は "tools": "readonly"|"standard"|"full" の一語 + "toolsExtra" で
 * 書ける。明示の "allowedTools" 配列があればそちらが優先 (後方互換)。
 */
export const TOOL_PRESETS = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'Bash(git *)', 'Bash(node *)', 'Bash(npm *)',
    'PowerShell(git *)', 'PowerShell(node *)', 'PowerShell(npm *)',
  ],
  full: [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'Bash', 'PowerShell',
  ],
};

// 既定は最小権限 (fail-closed)。書込み・シェルを伴う standard / full と
// acceptEdits は config.json に明示的に書いたチャンネルでのみ有効になる。
export const DEFAULT_TOOLS_PRESET = 'readonly';
export const DEFAULT_PERMISSION_MODE = 'default';
/**
 * 書ける permissionMode。**列挙で縛る** — 綴り違いを CLI へそのまま渡すと
 * 起動エラーになるうえ、契約の touch 制限が「安全に絞れないモード」として
 * job を止める側にも効く (src/contract.js の NARROWED_MODE)。
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const DEFAULT_HOOKS_ENABLED = false;
/**
 * 構造化出力 (委譲契約と報告様式) を使うか。
 *
 * **既定は有効** — ここだけは「書かなければ何も起きない」が現状維持の側になる。
 * 種別そのものは役割文の `<!-- communitd-schema: ... -->` が決めており
 * (src/contract.js)、この設定はそれを**チャンネル単位で黙らせる**ためだけにある。
 *
 * 切ると委譲の touch 制限も効かなくなる (契約が構造として届かないため)。
 * 書けないチャンネルなら実害は無いが、書込みを許した場所で切るのは作者の判断。
 */
export const DEFAULT_STRUCTURED_OUTPUT = true;
export const DEFAULT_VERIFY_MAX_RETRIES = 1;
export const VERIFY_MAX_RETRIES_RANGE = [0, 3];

/** プリセット名の照合 (Object.prototype 由来のキーを拾わない) */
function presetFor(name) {
  return Object.hasOwn(TOOL_PRESETS, name) ? TOOL_PRESETS[name] : null;
}

/**
 * チャンネル設定から claude へ渡す allowedTools を決める。
 *
 * @param {object} cc チャンネル設定
 * @param {string[]} approvedExtra Discord で人間が承認したルール (data/tools-extra.json)。
 *        config.json と同じ扱いで足すが、**config 側を書き換えはしない** — 手書きの正本と
 *        承認由来を混ぜないため、出所は保存先で区別する (src/toolstore.js)
 */
export function resolveAllowedTools(cc = {}, approvedExtra = []) {
  const base = Array.isArray(cc.allowedTools)
    ? cc.allowedTools
    : [
        ...(presetFor(cc.tools ?? DEFAULT_TOOLS_PRESET) ?? TOOL_PRESETS[DEFAULT_TOOLS_PRESET]),
        ...(cc.toolsExtra ?? []),
      ];
  return [...new Set([...base, ...(approvedExtra ?? [])])];
}

/** チャンネル設定から claude へ渡す permissionMode を決める */
export function resolvePermissionMode(cc = {}) {
  return cc.permissionMode ?? DEFAULT_PERMISSION_MODE;
}

/**
 * Claude ランタイム専用の hook 基盤を有効にするか。
 * 未知の値は起動時検証で弾き、ここでは false へ落として fail-closed にする。
 */
export function resolveHooksEnabled(cc = {}) {
  return typeof cc.hooks === 'boolean' ? cc.hooks : DEFAULT_HOOKS_ENABLED;
}

/**
 * そのチャンネルで構造化出力 (委譲契約・報告様式) を使うか。
 *
 * 雑談のように成果物へ向かわない job のための口。様式が振る舞いを決めるので、
 * 「やったこと / 検証結果 / 残課題」を埋めさせる限りエージェントは仕事の顔から抜けない。
 *
 * 未知の値は既定 (有効) へ落として fail-closed にする — 切る側が防御の薄い方なので、
 * 書き損じで黙って契約が消えるより「切ったつもりが効いていない」の方が安全。
 */
export function resolveStructuredOutputEnabled(cc = {}) {
  return typeof cc.structuredOutput === 'boolean' ? cc.structuredOutput : DEFAULT_STRUCTURED_OUTPUT;
}

/** 未設定・型不正なら検証コマンド無しへ倒す (型不正そのものは起動時検証で弾く) */
export function resolveVerifyCommand(cc = {}) {
  return isNonEmptyString(cc.verify) ? cc.verify.trim() : null;
}

/** Stop hook が verify NG を同一セッションへ差し戻す上限 (0 = 報告だけ) */
export function resolveVerifyMaxRetries(cc = {}) {
  return inRange(cc.verifyMaxRetries, VERIFY_MAX_RETRIES_RANGE)
    ? cc.verifyMaxRetries
    : DEFAULT_VERIFY_MAX_RETRIES;
}

/**
 * チャンネル設定の claudeAddDirs を claude の `--add-dir` へ渡す形へ正規化する。
 * 相対パスは cc.cwd 基準・重複と cwd 自身は落とす (cwd は常に渡っている)。
 *
 * **`--add-dir` は読み書きの両方を開ける。** 参照用のつもりで足したディレクトリでも
 * 書けてしまい、読取専用にはできない。だからここでの境界は「書けないこと」ではなく
 * 「書いたら git 差分に出ること」で担保する — 足すのは git 管理下のツリーに限る
 * (2026-08-01 方針: 止めるのは取り返しがつかないものだけ)。
 *
 * 実在確認はしない (cwd と同じ扱い)。綴り違いは claude 側の起動エラーとして
 * スレッドに出るので、黙って落として「足したつもり」にするより分かりやすい。
 */
export function resolveAddDirs(cc = {}) {
  const cwd = isNonEmptyString(cc.cwd) ? resolve(cc.cwd) : '';
  const out = [];
  for (const dir of Array.isArray(cc.claudeAddDirs) ? cc.claudeAddDirs : []) {
    if (!isNonEmptyString(dir)) continue;
    const abs = resolve(cwd, dir.trim());
    if (abs === cwd || out.includes(abs)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * チャンネル設定から codex ランタイム (Sol) の sandbox を決める。
 * 既定は read-only — 書込みは「そのチャンネルに明示的に書いたときだけ」有効になる。
 * 未知の値は起動時検証で弾く (ここでは既定へ落として fail-closed にする)。
 */
export function resolveCodexSandbox(cc = {}) {
  return CODEX_SANDBOXES.includes(cc.codexSandbox) ? cc.codexSandbox : DEFAULT_CODEX_SANDBOX;
}

/**
 * チャンネル既定の編成 (そのチャンネルのスレッドで既定として効く allowlist)。
 *
 * `/roster` はスレッド単位なので、**打ち忘れたスレッドは全員呼べる**。通常の作業
 * チャンネルではそれが正しい (禁止は明示的に設定したときだけ効く — src/roster.js) が、
 * 「勝手に高いモデルを呼ばれると困る」チャンネルでは既定が逆に働く。ここはその初期値。
 *
 * 省略 = null = 従来どおり制限なし (新しい設定の既定は「何も起きない」側)。
 * 空配列は `/roster none` と同じ「このチャンネルでは handoff 禁止」として通す。
 *
 * 綴り違い・型不正は起動時検証で弾く。ここで [] へ倒すと 1 文字の書き損じで
 * 全 handoff が黙って止まり、逆に null へ倒すと「絞ったつもり」の穴になる。
 */
export function resolveChannelRoster(cc = {}) {
  if (!Array.isArray(cc.roster)) return null;
  const out = [];
  for (const key of cc.roster) {
    if (!isNonEmptyString(key)) continue;
    const trimmed = key.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** チャンネル名 → チャンネル設定 (未登録なら null) */
export function channelConfigForName(config, channelName) {
  const channels = config?.channels;
  if (!channels || typeof channelName !== 'string') return null;
  if (!Object.hasOwn(channels, channelName)) return null;
  return { ...channels[channelName], channelName };
}

/**
 * 設定を引く名前。**スレッドは親チャンネルの名前で判定する** —
 * 判定に使う名前をここ 1 か所で決めて、警告文と実際の解決がずれないようにする。
 * @returns {string|null}
 */
export function channelNameOf(channel) {
  const base = channel?.isThread?.() ? channel.parent : channel;
  return typeof base?.name === 'string' ? base.name : null;
}

/**
 * 未登録チャンネルの案内。**今の名前と、登録されている名前を並べる** —
 * 「未登録です」だけだと、綴り違いなのか場所違いなのかが Discord 側から分からない
 * (実地の導入で実際に詰まった: 2026-09-12)。
 */
export function unregisteredChannelNotice(config, channelName) {
  // チャンネル名は Discord 由来なので、引用が壊れない形に均す (メンションは
  // 送信側の allowedMentions が既に殺している)
  const shown = String(channelName ?? '(不明)').replace(/[`\r\n]/g, '').slice(0, 60) || '(不明)';
  // 名前は**認可を通った人にしか出ない** (メンションもスラッシュも先に認可を見る)。
  // 多いときは頭だけ — 1 通に収まらないと肝心の「今の名前」が読めなくなる
  const names = Object.keys(config?.channels ?? {});
  const shownNames = names.slice(0, 8).map((n) => `\`${n}\``).join(' / ');
  const more = names.length > 8 ? ` ほか ${names.length - 8} 件` : '';
  const registered = names.length === 0
    ? '登録されているチャンネルがありません'
    : `登録されているのは ${shownNames}${more}`;
  return `⚠️ このチャンネル (\`${shown}\`) は config.policy.json の channels に未登録です`
    + ` — ${registered} (名前は完全一致・スレッドは親チャンネルの名前で判定)`;
}

/**
 * 設定例のまま残っている ID か (`config.secrets.example.json` の `000000000000000000`)。
 *
 * **写しただけで起動できてしまうのがいちばん分かりにくい**: guildId が例のままだと
 * スラッシュコマンドの登録が `Missing Access` で落ち、allowedUserIds が例のままだと
 * 全メンションが黙って拒否される (実地の導入で両方起きた: 2026-09-12)。
 */
export function isExampleId(value) {
  return typeof value === 'string' && /^0{5,}$/.test(value.trim());
}

/** 設定例のまま残っている作業ディレクトリか (`C:/path/to/your/project`) */
export function isExampleCwd(value) {
  if (typeof value !== 'string') return false;
  return /(^|[/\\])path[/\\]to[/\\]your[/\\]project[/\\]?$/i.test(value.trim());
}

/**
 * `channels.<name>` 1 つ分の起動時検証。
 *
 * @param {string} name チャンネル名 (エラー文の位置表示に使う)
 * @param {unknown} cc channels.<name>
 * @param {{botKeys?: string[]}} context `config.bots` のキー (roster と autonomy の担当の照合に使う)
 * @returns {string[]} 人間向けエラー行
 */
export function validateChannel(name, cc, { botKeys = [] } = {}) {
  const errors = [];
  if (!isPlainObject(cc)) {
    errors.push(`channels.${name} はオブジェクトで書く`);
    return errors;
  }
  if (!isNonEmptyString(cc.cwd)) {
    errors.push(`channels.${name}.cwd が未設定 — 作業ディレクトリのパスを書く`);
  }
  if (cc.tools !== undefined && !presetFor(cc.tools)) {
    errors.push(`channels.${name}.tools: "${cc.tools}" は不明 (readonly | standard | full)`);
  }
  if (cc.allowedTools !== undefined && !Array.isArray(cc.allowedTools)) {
    errors.push(`channels.${name}.allowedTools は配列で書く`);
  }
  if (cc.toolsExtra !== undefined && !Array.isArray(cc.toolsExtra)) {
    errors.push(`channels.${name}.toolsExtra は配列で書く`);
  }
  if (cc.permissionMode !== undefined && !PERMISSION_MODES.includes(cc.permissionMode)) {
    errors.push(
      `channels.${name}.permissionMode: ${JSON.stringify(cc.permissionMode)} は不明 `
        + `(${PERMISSION_MODES.join(' | ')})`,
    );
  }
  if (cc.hooks !== undefined && typeof cc.hooks !== 'boolean') {
    errors.push(`channels.${name}.hooks: boolean (true | false) で書く`);
  }
  if (cc.structuredOutput !== undefined && typeof cc.structuredOutput !== 'boolean') {
    errors.push(
      `channels.${name}.structuredOutput: boolean (true | false) で書く `
        + '(省略 = 有効・false でそのチャンネルだけ委譲契約と報告様式を切る)',
    );
  }
  if (cc.verify !== undefined && !isNonEmptyString(cc.verify)) {
    errors.push(`channels.${name}.verify は非空のコマンド文字列で書く`);
  }
  // verify は作者が config.json に直接書いた任意の shell コマンドを実行する。
  // allowedTools / tools プリセットの外にある作者専用の実行経路であり、承認カードや
  // エージェント出力から値を足すことはない。差し戻し機構を持たない中間モードも作らない。
  if (cc.verify !== undefined && cc.hooks !== true) {
    errors.push(`channels.${name}.verify を使うには hooks: true が必要`);
  }
  if (
    cc.verifyMaxRetries !== undefined &&
    !inRange(cc.verifyMaxRetries, VERIFY_MAX_RETRIES_RANGE)
  ) {
    errors.push(
      `channels.${name}.verifyMaxRetries は ${VERIFY_MAX_RETRIES_RANGE[0]}〜` +
        `${VERIFY_MAX_RETRIES_RANGE[1]} の整数で書く (省略時は ${DEFAULT_VERIFY_MAX_RETRIES})`,
    );
  }
  // 書き損じを黙って無視すると「参照できるつもりのディレクトリが渡っていない」に化ける
  if (
    cc.claudeAddDirs !== undefined &&
    (!Array.isArray(cc.claudeAddDirs) || !cc.claudeAddDirs.every(isNonEmptyString))
  ) {
    errors.push(
      `channels.${name}.claudeAddDirs は非空の文字列 (ディレクトリのパス) の配列で書く ` +
        '— 相対パスは cwd 基準',
    );
  }
  // 書込み解放は「設定に明示したチャンネルだけ」。綴り違いを黙って
  // read-only へ落とすと「解放したつもり」になるので起動時に落とす
  if (cc.codexSandbox !== undefined && !CODEX_SANDBOXES.includes(cc.codexSandbox)) {
    errors.push(
      `channels.${name}.codexSandbox: ${JSON.stringify(cc.codexSandbox)} は不明 ` +
        `(${CODEX_SANDBOXES.join(' | ')})`,
    );
  }
  // 編成の綴り違いは起動時に落とす。黙って無視すると「絞ったつもり」の穴になり、
  // 黙って落とすと空集合 = 全 handoff 停止になる。どちらも無症状で気付けない
  if (cc.roster !== undefined) {
    if (!Array.isArray(cc.roster) || !cc.roster.every(isNonEmptyString)) {
      errors.push(
        `channels.${name}.roster は bot キーの配列で書く ` +
          '(省略 = 制限なし / [] = このチャンネルでは handoff 禁止)',
      );
    } else {
      const known = botKeys;
      const unknown = cc.roster.map((k) => k.trim()).filter((k) => !known.includes(k));
      if (unknown.length > 0) {
        errors.push(
          `channels.${name}.roster に知らない bot キー: ${unknown.join(' / ')}` +
            `${known.length ? ` (使えるのは ${known.join(' / ')})` : ''}`,
        );
      }
    }
  }
  errors.push(...validateAutonomy(cc.autonomy, {
    channel: name,
    botKeys,
    hasVerify: isNonEmptyString(cc.verify),
  }));
  return errors;
}
