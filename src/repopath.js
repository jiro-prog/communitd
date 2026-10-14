// リポジトリ相対パスの正規形と実体解決 (docs/social-engineering.md §3.9)。
//
// 提案の `targets[]` / `change.touch` / diff のパスは、**書ける範囲を決める鍵**なので
// 「文字列として安全か」だけでは足りない。Windows では
//   - `CONFIG.SECRETS.JSON` と `config.secrets.json` が同じ実体
//   - 末尾の空白・ドットは黙って落とされる (`config.secrets.json.` も同じ実体)
//   - `x.json:ads` は代替データストリーム
//   - junction / symlink はリポジトリ外の実体を指せる
// のいずれも「別名で同じものを触る」経路になる。表記ゆれを 1 か所で潰し、
// **実体は lstat で 1 成分ずつ確かめる** (statSync は link を辿るので使わない)。
//
// 判定は 2 層。文字列だけで落とせるものは純粋関数 (`isSafeRepoPath`) で、
// 実体が要るものは resolver で見る。安全境界の比較 (`config.secrets.json` かどうか等) は
// **大小文字を無視して**行う — 実ファイルが無ければ resolver では別名を捕まえられないので、
// 「まだ存在しない秘密ファイルを作る」提案を文字列側でも塞ぐ。

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Windows の予約デバイス名 (拡張子が付いていても同じ) */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * リポジトリ相対・POSIX 区切りのパスとして受け付けてよいか (文字列だけで分かる分)。
 * `./` も末尾スラッシュも許さない — 表記違いで同じファイルが別のキーになると、
 * touch 集合の一意性ゲートも競合判定も抜けられる。
 */
export function isSafeRepoPath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\\')) return false; // Windows 区切りは受けない
  if (p.includes(':')) return false; // ドライブレター / 代替データストリーム (ADS)
  if ([...p].some((ch) => ch.codePointAt(0) < 0x20)) return false; // 制御文字
  if (p.startsWith('/')) return false; // 絶対パス
  return p.split('/').every((seg) => {
    if (seg === '' || seg === '.' || seg === '..') return false;
    // 末尾の空白・ドットは Windows が黙って落とすので、その形は受け付けない
    if (seg !== seg.trimEnd() || seg.endsWith('.')) return false;
    return !RESERVED_NAME.test(seg);
  });
}

/** 安全境界の比較用。大小文字だけが違うパスは**同じもの**として扱う (fail-closed) */
export function samePathLoose(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** `prefix/` 配下か (大小文字は無視する) */
export function underPathLoose(path, prefix) {
  return typeof path === 'string' && path.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * 作業ディレクトリを基点にパスの実体を解決する。
 *
 * @param {{cwd: string}} p
 * @returns {{root: string|null, check: (path: string) => object}}
 *   check は `{ok:true, kind:'file'|'dir'|'missing', abs}` か `{ok:false, reason}`。
 *   **判断できないものはすべて `ok:false`** — 呼び出し側は提案ごと落とす。
 */
export function createPathResolver({ cwd }) {
  const root = canonicalRoot(cwd);
  return {
    root,
    check(path) {
      if (!isSafeRepoPath(path)) return { ok: false, reason: `パスとして受け付けられません: ${path}` };
      if (!root) return { ok: false, reason: `作業ディレクトリを解決できません: ${cwd}` };

      let dir = root;
      const segments = path.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const last = i === segments.length - 1;

        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          return { ok: false, reason: `${path} の親ディレクトリを読めません` };
        }
        // **大小文字だけが違う既存の名前は別名として拒否する。**
        // Windows では同じ実体なので、通すと touch 集合の外へ書ける
        if (!entries.includes(seg)) {
          const aliases = entries.filter((e) => e.toLowerCase() === seg.toLowerCase());
          if (aliases.length > 0) {
            return { ok: false, reason: `大小文字だけが違う名前が既にあります: ${path} (実体は ${aliases.join(' / ')})` };
          }
          // 途中が無ければその先も無い (作成できるのは末尾だけ)
          return { ok: true, kind: 'missing', abs: last ? join(dir, seg) : null };
        }

        const abs = join(dir, seg);
        let st;
        try {
          st = lstatSync(abs); // link を辿らない — 辿るとリポジトリ外の実体が通常ファイルに見える
        } catch {
          return { ok: false, reason: `${path} を確認できません` };
        }
        if (st.isSymbolicLink()) return { ok: false, reason: `symlink / junction は対象にできません: ${path}` };
        if (last) {
          if (!st.isFile() && !st.isDirectory()) {
            return { ok: false, reason: `通常のファイル / ディレクトリではありません: ${path}` };
          }
          if (!within(root, realpathOf(abs))) {
            return { ok: false, reason: `リポジトリの外を指しています: ${path}` };
          }
          return { ok: true, kind: st.isFile() ? 'file' : 'dir', abs };
        }
        if (!st.isDirectory()) return { ok: false, reason: `${path} の途中がディレクトリではありません` };
        dir = abs;
      }
      return { ok: false, reason: `パスを解決できません: ${path}` };
    },
    /** 実体が通常ファイルのときだけ中身を返す */
    read(path) {
      const resolved = this.check(path);
      if (!resolved.ok || resolved.kind !== 'file') return null;
      try {
        return readFileSync(resolved.abs, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** 実際のケーシングまで解決した作業ディレクトリ (解決できなければ null = fail-closed) */
function canonicalRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const real = realpathOf(cwd);
  return real === null ? null : real.replace(new RegExp(`\\${sep}+$`), '');
}

function realpathOf(p) {
  try {
    const resolver = realpathSync.native ?? realpathSync;
    return resolver(p);
  } catch {
    return null;
  }
}

function within(root, real) {
  if (typeof real !== 'string') return false;
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}
