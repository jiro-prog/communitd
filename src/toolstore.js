// @ts-check
// 人間が Discord で承認したツール権限の永続 (data/tools-extra.json)。
//
// **config.json は書き換えない。** あれは人間が手で書く正本で、機械が書き戻すと
// 整形や並びが壊れるうえ、承認由来のルールと手書きのルールを見分けられなくなる。
//
// 保存するのは**構造化 grant** (src/grants.js) であってルール文字列ではない。
// 記法が変わった日に文字列だと移行できないし、保存値と表示値の区別も付かない。
// 読み込み・保存の両方で validateGrant を通すので、壊れた・古い・widen された
// エントリは黙って使われない (fail-closed)。
//
// 保存形式 (version は src/grants.js の GRANT_SCHEMA_VERSION と同じ):
//   { "version": 2, "channels": { "sandbox": [ {kind, tool, value, cwd, ...} ] } }
//
// チャンネル名は config.json 由来の任意の文字列なので、`channels` を素のオブジェクトとして
// 読み書きしない。`channels['__proto__'] = [...]` は Object の特殊 setter を踏み、
// **メモリ上は許可済みに見えるのに JSON には書かれない**「保存成功の偽装」になる
// (実測 2026-08-01)。読み書きは readChannel / writeChannel に通す。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GRANT_SCHEMA_VERSION, grantFingerprint, renderRule, validateGrant } from './grants.js';

// cwd の正規化は grant の検証と同じ関数でなければ意味がない (validateGrant が
// 「cwd は正規形そのもの」を要求する) ので、grants.js のものを再輸出する
export { canonicalCwd } from './grants.js';

/** チャンネル名で引く (`__proto__` のような名前で prototype を返さない) */
function readChannel(channels, name) {
  if (!channels || typeof name !== 'string' || !Object.hasOwn(channels, name)) return null;
  const value = channels[name];
  return Array.isArray(value) ? value : null;
}

/** own property として書く (`__proto__` の setter を踏まない) */
function writeChannel(channels, name, value) {
  Object.defineProperty(channels, name, {
    value, writable: true, enumerable: true, configurable: true,
  });
}

/**
 * 保存データの複製。structuredClone は `__proto__` の own property を素直に運ばないので、
 * JSON 経由で作り直す (grant は JSON で表せる値しか持たない)。
 */
function cloneData(data) {
  const channels = {};
  for (const [name, entries] of Object.entries(data.channels ?? {})) {
    if (Array.isArray(entries)) writeChannel(channels, name, JSON.parse(JSON.stringify(entries)));
  }
  return { version: data.version, channels };
}

export class ToolExtraStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: GRANT_SCHEMA_VERSION, channels: {} };
    if (!existsSync(filePath)) return;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      // 壊れたファイルは黙って捨てず退避して痕跡を残す (SessionStore と同じ流儀)
      const backup = `${filePath}.corrupt-${Date.now()}`;
      try { renameSync(filePath, backup); } catch { /* 退避失敗時はそのまま */ }
      console.error(`[tools] tools-extra.json が壊れていたため退避: ${backup}`);
      return;
    }

    // 旧形式 (version 無し = ルール文字列の配列だった頃) と未知の版は読まない。
    // 「読めたつもりで権限が消える」より「読まなかったと言い切る」方を採る
    if (!isPlainObject(parsed) || parsed.version !== GRANT_SCHEMA_VERSION) {
      console.error(
        `[tools] tools-extra.json のスキーマ版が ${JSON.stringify(parsed?.version)} ` +
          `(期待: ${GRANT_SCHEMA_VERSION}) のため読み込みません — 承認は 0 件として起動します`,
      );
      return;
    }
    if (!isPlainObject(parsed.channels)) {
      console.error('[tools] tools-extra.json の channels が壊れているため読み込みません');
      return;
    }
    // 読み込んだ内容も own property として積み直す (JSON.parse は __proto__ を
    // own property にするが、以後の代入で踏まないよう最初から揃えておく)
    this.data = cloneData({ version: GRANT_SCHEMA_VERSION, channels: parsed.channels });
  }

  /**
   * そのチャンネル**かつその作業ディレクトリ**で有効な grant。
   * 読むたびに validateGrant を通す — 保存時に妥当でも、検証が厳しくなった後は使わない。
   *
   * @param {string} channelName チャンネル設定名
   * @param {string|null} cwd canonicalCwd() を通した作業ディレクトリ。
   *        null (解決できない) なら何も返さない — 照合できない承認は使わない
   * @returns {{grants: object[], rejected: number}}
   */
  grantsFor(channelName, cwd) {
    const entries = readChannel(this.data.channels, channelName);
    if (!entries || !cwd) return { grants: [], rejected: 0 };
    const grants = [];
    let rejected = 0;
    for (const entry of entries) {
      const checked = validateGrant(entry);
      if (!checked.ok) {
        rejected++;
        continue;
      }
      if (checked.grant.cwd !== cwd) continue; // 別の作業ツリー向け (数えない)
      grants.push(checked.grant);
    }
    return { grants, rejected };
  }

  /** claude へ渡すルール文字列 (重複なし) */
  rulesFor(channelName, cwd) {
    const { grants, rejected } = this.grantsFor(channelName, cwd);
    if (rejected > 0) {
      console.error(
        `[tools] ${channelName}: 検証に通らない承認 ${rejected} 件を無視しました (fail-closed)`,
      );
    }
    const rules = [];
    for (const grant of grants) {
      const rule = renderRule(grant);
      if (!rules.includes(rule)) rules.push(rule);
    }
    return rules;
  }

  /** 承認済みか (二重承認のカードを無駄に出さないため) */
  has(channelName, grant) {
    const checked = validateGrant(grant);
    if (!checked.ok) return false;
    const target = renderRule(checked.grant);
    return this.rulesFor(channelName, checked.grant.cwd).includes(target);
  }

  /**
   * 承認を 1 件足して保存する。既にあれば何もしない。
   *
   * 順序が肝: **clone → 一時ファイルへ書く → rename 成功 → メモリを差し替える**。
   * 先にメモリを触ると、ディスク満杯・ACL・rename 失敗のときに
   * 「次の job では許可されているのに再起動すると消える」状態が残る。
   * 保存に失敗したら throw する — 呼び出し側が「承認済み」と表示しないため。
   *
   * 戻りは**タグ付き**。「既にある (承認済み)」と「保存できない」を同じ値で返すと、
   * 呼び出し側が後者まで「承認済み」として確定してしまう (実測 2026-08-01)。
   *
   * @returns {{ok: true, added: boolean} | {ok: false, reason: string}}
   *          ok:true + added:false = 既に同じ承認がある (確定してよい)
   * @throws {Error} 保存に失敗したとき (メモリは変更されない)
   */
  add(channelName, grant) {
    if (typeof channelName !== 'string' || channelName === '') {
      return { ok: false, reason: 'チャンネル名が不正です' };
    }
    const checked = validateGrant(grant);
    if (!checked.ok) {
      console.error(`[tools] 保存を拒否: ${checked.reason}`);
      return { ok: false, reason: checked.reason };
    }
    if (this.has(channelName, checked.grant)) return { ok: true, added: false };

    const next = cloneData(this.data);
    const entries = readChannel(next.channels, channelName) ?? [];
    entries.push({ ...checked.grant });
    writeChannel(next.channels, channelName, entries);

    this.persist(next); // 失敗すればここで throw — this.data は元のまま
    // 書けたはずのものが読み戻せない (= 保存成功の偽装) まま「承認済み」にしない
    if (!readChannel(next.channels, channelName)?.length) {
      throw new Error(`チャンネル名 ${JSON.stringify(channelName)} の承認を保存できませんでした`);
    }
    this.data = next;
    console.log(`[tools] 保存: ${channelName} ${grantFingerprint(checked.grant)}`);
    return { ok: true, added: true };
  }

  /** 現在のメモリ状態を書き出す (壊れかけの JSON を残さない) */
  save() {
    this.persist(this.data);
  }

  persist(data) {
    // tmp 書き込み → rename のアトミック更新 (書き込み途中クラッシュで JSON を壊さない)
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
