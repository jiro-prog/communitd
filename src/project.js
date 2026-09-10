// プロジェクト (チャンネル) 追加の純粋ロジック。
// 対話と読み書きは scripts/add-project.mjs 側の責務 — ここは検証と組み立てだけ。

import { basename, resolve, win32 } from 'node:path';
import { DEFAULT_TOOLS_PRESET, POLICY_FILE, TOOL_PRESETS } from './config.js';

/** tools プリセットの選択肢 (対話の並び順もこれに従う) */
export const TOOLS_CHOICES = Object.keys(TOOL_PRESETS);

/**
 * チャンネル名の検証。config.channels のキーは Discord のチャンネル「名」と
 * 一致していなければ引けない (channelConfigForName) ので、Discord 側が
 * 勝手に変換してしまう表記を先に弾く。
 *
 * @param {string} name
 * @param {object} config 既存 config (重複チェック用)
 * @returns {string[]} 人間向けエラー行 (空 = 使ってよい)
 */
export function validateChannelName(name, config = {}) {
  if (typeof name !== 'string' || name.trim() === '') return ['チャンネル名が空です'];
  const errors = [];
  if (name !== name.trim()) errors.push('前後に空白があります');
  const trimmed = name.trim();
  if (/[A-Z]/.test(trimmed)) {
    errors.push('大文字は使えません (Discord が小文字へ変換するため config と一致しなくなる)');
  }
  if (/\s/.test(trimmed)) {
    errors.push('空白は使えません (Discord がハイフンへ変換するため config と一致しなくなる)');
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(trimmed)) {
    errors.push('使えるのは文字・数字・ハイフン・アンダースコアだけです');
  }
  if (Object.hasOwn(config?.channels ?? {}, trimmed)) {
    errors.push(`channels.${trimmed} は既にあります (別の名前にするか ${POLICY_FILE} を直接編集してください)`);
  }
  return errors;
}

/**
 * 作業ディレクトリの表記を設定ファイルの書き方へ揃える。
 * 既存の設定が `C:/Users/...` 形式なので、Windows の `\` は `/` に直す。
 * 相対パスは呼び出し元の cwd 基準で絶対化する。
 *
 * 「もう絶対パスか」は **win32 の規則**で見る (`win32.isAbsolute`)。先頭 `/` も
 * ドライブレターも絶対と判るので、どちらの OS で書かれた設定でも同じ答えになる。
 * 実行 OS の規則だと Linux で `C:/…` が相対扱いになり、cwd を頭に付けた
 * 意味のないパスができる。
 *
 * @returns {string|null} 空入力なら null
 */
export function normalizeCwd(input) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  const trimmed = input.trim().replace(/^["']|["']$/g, ''); // 貼り付けの引用符を許容
  if (trimmed === '') return null;
  const abs = win32.isAbsolute(trimmed) ? trimmed : resolve(trimmed);
  return abs.replaceAll('\\', '/').replace(/(?<=.)\/$/, ''); // 末尾の / は落とす
}

/** パス比較用の正規化。Windows の大小無視に合わせ、安全側 (拒否しやすい側) に倒す */
function comparablePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  return p.trim().replaceAll('\\', '/').replace(/(?<=.)\/$/, '').toLowerCase();
}

/**
 * cwd としてブリッジ自身 (またはその祖先) を選ばせない。
 * 最小権限の readonly でも Read は付くので、そこを作業ディレクトリにすると
 * `.env` の Discord トークンや config.secrets.json をモデルに読ませられる。
 * 直下の sandbox のような**子**ディレクトリは対象外 (安全なので許可する)。
 *
 * junction / シンボリックリンクで回り込めないよう、呼び出し側は
 * realpath 解決済みのパスを渡すこと。
 *
 * @param {string} cwd 作業ディレクトリ (realpath 済み)
 * @param {string} bridgeRoot ブリッジのルート (realpath 済み)
 */
export function isUnsafeCwd(cwd, bridgeRoot) {
  const target = comparablePath(cwd);
  const root = comparablePath(bridgeRoot);
  if (!target || !root) return false;
  if (target === root) return true; // ブリッジ本体そのもの
  return root.startsWith(`${target}/`); // cwd がブリッジの祖先 (= .env に届く)
}

/**
 * cwd としてその実体パスを使ってよいか。
 * junction / シンボリックリンクでの回り込みを塞ぐため realpath で解決してから見る。
 * **解決できない場合は拒否する** — 安全確認ができない入力を通すと、
 * 解決に失敗する仕掛けを置くだけでガードを抜けられてしまう (fail-closed)。
 *
 * @param {string} cwd 入力された作業ディレクトリ
 * @param {string} bridgeRoot ブリッジのルート (realpath 済み)
 * @param {{realpath: (p: string) => string}} deps realpathSync を注入する
 * @returns {{ok: true, real: string} | {ok: false, reason: 'unresolvable'|'inside-bridge'}}
 */
export function checkCwdSafety(cwd, bridgeRoot, { realpath }) {
  let real;
  try {
    real = realpath(cwd);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (typeof real !== 'string' || real.trim() === '') return { ok: false, reason: 'unresolvable' };
  const normalized = real.replaceAll('\\', '/');
  if (isUnsafeCwd(normalized, bridgeRoot)) return { ok: false, reason: 'inside-bridge' };
  return { ok: true, real: normalized };
}

/**
 * 設定ファイルを安全に置き換える。書き換え先は `config.policy.json` だけで、
 * secrets と合成後の config は**保存しない** (docs/social-engineering.md §3.9)。
 * - 排他 lock を取ってから書く (CLI の二重起動を直列化する)
 * - 一時ファイル名はプロセスごとに固有 (他プロセスの書きかけを rename しない)
 * - 読み込み時から中身が変わっていたら上書きしない。lock を取らない手編集とも
 *   競合しないよう、rename の直前にもう一度確かめる
 * - 同一ディレクトリの一時ファイルへ書いて読み戻し検証してから rename で差し替える
 *   (途中まで書かれた設定ファイルを残さない)
 * fs は注入する — 実ファイルを触らずに失敗経路をテストするため。
 *
 * @param {{path: string, originalRaw: string}[]} [companions] 書き換えないが、変わって
 *        いたらこの保存を中止するファイル。add-project は `config.secrets.json` を渡す —
 *        検証も Discord 接続も policy + secrets の**合成後**で行っている以上、対話中に
 *        secrets 側 (`guildId` など) が変わると、別の Guild で確認した結果を根拠に
 *        policy を書くことになる (sol 指摘 2026-08-29)
 * @returns {{ok: true, backupPath: string} | {ok: false, reason: string, message: string}}
 */
export function saveConfigAtomically({
  configPath,
  originalRaw,
  nextConfig,
  fs,
  uniqueSuffix = String(process.pid),
  lockSuffix = '.lock',
  backupSuffix = '.bak',
  companions = [],
}) {
  const tmpPath = `${configPath}.tmp-${uniqueSuffix}`;
  const backupPath = `${configPath}${backupSuffix}`;
  const lockPath = `${configPath}${lockSuffix}`;

  // flag: 'wx' = 既にあれば失敗。取れた側だけが書き込みへ進む
  try {
    fs.writeFileSync(lockPath, `${uniqueSuffix}\n`, { flag: 'wx' });
  } catch {
    return {
      ok: false,
      reason: 'locked',
      message:
        `他の add-project が実行中です (${lockPath})。` +
        '終了しているのにこのファイルが残っている場合は、消してからやり直してください',
    };
  }

  try {
    const before = ensureUnchanged(fs, configPath, originalRaw, companions);
    if (before) return before;

    const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    try {
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      // 「書けたつもりで途中までしか出ていない」(容量不足など) を読み戻して確かめる
      const written = fs.readFileSync(tmpPath, 'utf8');
      if (written !== serialized) throw new Error('一時ファイルの内容が書いた内容と一致しません');
      JSON.parse(written);
    } catch (err) {
      discard(fs, tmpPath);
      return { ok: false, reason: 'write-failed', message: `一時ファイルに書けません: ${err.message}` };
    }

    // 一時ファイルの検証中に割り込まれていないか (無駄なバックアップを作る前に見る)
    const afterWrite = ensureUnchanged(fs, configPath, originalRaw, companions);
    if (afterWrite) {
      discard(fs, tmpPath);
      return afterWrite;
    }

    try {
      fs.copyFileSync(configPath, backupPath);
    } catch (err) {
      discard(fs, tmpPath);
      return { ok: false, reason: 'backup-failed', message: `バックアップを作れません: ${err.message}` };
    }

    // バックアップ中に割り込まれた編集も消さない。差し替えの直前が最後の確認点
    const afterBackup = ensureUnchanged(fs, configPath, originalRaw, companions);
    if (afterBackup) {
      discard(fs, tmpPath);
      return afterBackup;
    }

    try {
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      discard(fs, tmpPath);
      return { ok: false, reason: 'replace-failed', message: `置き換えに失敗しました: ${err.message}` };
    }

    return { ok: true, backupPath };
  } finally {
    discard(fs, lockPath);
  }
}

/**
 * 読み込み時から変わっていれば「中止すべき理由」を返す (変わっていなければ null)。
 * 書き換え先に加えて `companions` — 書き換えはしないが、変わっていたらこの保存を
 * 無効にするファイル — も見る。
 */
function ensureUnchanged(fs, configPath, originalRaw, companions = []) {
  const targets = [
    { path: configPath, originalRaw, writing: true },
    ...companions.map((c) => ({ ...c, writing: false })),
  ];
  for (const target of targets) {
    // ファイル名はパスから採る — この関数は書き換え先を知らない汎用の保存経路で、
    // メッセージだけが特定のファイル名を名乗ると、呼び出し先を変えたときに嘘になる
    const label = basename(target.path);
    let current;
    try {
      current = fs.readFileSync(target.path, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'read-failed', message: `${label} を読み直せません: ${err.message}` };
    }
    if (current !== target.originalRaw) {
      return {
        ok: false,
        reason: 'changed',
        message: target.writing
          ? `対話の途中で ${label} が変更されています (別の編集を消さないため中止)`
          : `対話の途中で ${label} が変更されています (この内容を前提に検証したので中止)`,
      };
    }
  }
  return null;
}

/** 一時ファイル・lock の後始末 (消せなくても本体は無事なので黙って進む) */
function discard(fs, path) {
  try {
    fs.rmSync(path, { force: true });
  } catch { /* 残っても実害はない */ }
}

/**
 * channels.<name> に書くエントリ。
 * 既定は最小権限 (readonly) — 書込みは明示的に選んだときだけ付く。
 */
export function buildChannelEntry({ cwd, tools = DEFAULT_TOOLS_PRESET, toolsExtra = [] } = {}) {
  const entry = { cwd, tools };
  if (Array.isArray(toolsExtra) && toolsExtra.length > 0) entry.toolsExtra = [...toolsExtra];
  return entry;
}

/**
 * チャンネルを 1 件足した config を返す (元の config は変更しない)。
 * キー順は既存 → 新規の順で、他の設定には触れない。
 */
export function addChannel(config, name, entry) {
  return {
    ...config,
    channels: { ...(config?.channels ?? {}), [name]: entry },
  };
}
