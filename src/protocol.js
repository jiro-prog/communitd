// @ts-check
// role prompt とブリッジ本体の「プロトコル版」照合 (純粋関数)。
//
// role ファイルは job ごとに読み直されるのに、それを解釈する送信パーサは
// プロセス起動時のコードのまま。だから「role だけ先に新しい」状態が必ず生まれる
// (コードをコミットしてから /restart するまでの窓)。実際、制御フッターへの移行では
// 新記法で書かれた委譲を旧パーサが解釈できず、委譲が黙って落ちた (2026-08-01)。
//
// スナップショットでは防げない (起動時点で role が新しければ同じこと) ので、
// **job 開始時に版を照合して、噛み合わないなら model を起動しない**方針を採る。
// 黙って失敗するのを、見える失敗に変えるのが目的。

/**
 * ブリッジが解釈できる role プロトコルの版。
 *
 * 1 = 平文の @名前 を実メンションへ変換していた旧プロトコル
 * 2 = 制御フッター ([[handoff:...]] / [[notify:owner]]) だけが起動を決める
 *
 * roles/*.md 側の版マーカーと**必ず同時に**上げること。
 */
export const PROTOCOL_VERSION = 2;

/** role ファイルの先頭付近に置く版マーカー */
const MARKER = /<!--\s*communitd-protocol:\s*(\d+)\s*-->/;

/** マーカーを探す範囲 (先頭のみ。本文中の言及を拾わない) */
const HEAD_CHARS = 400;

/**
 * role テキストから宣言された版を読む。
 * @returns {number|null} 宣言が無い / 読めなければ null
 */
export function readProtocolVersion(text) {
  const m = MARKER.exec(String(text ?? '').slice(0, HEAD_CHARS));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * この role を今のブリッジで動かしてよいか。
 * 欠落も不一致も等しく拒否する — 「宣言が無い role」は旧プロトコルのまま
 * 書かれている可能性があり、通すと移行前の事故がそのまま再現する。
 *
 * @returns {{ok: true, version: number} | {ok: false, version: number|null, reason: string}}
 */
export function checkRoleProtocol(text, expected = PROTOCOL_VERSION) {
  const version = readProtocolVersion(text);
  if (version === null) {
    return {
      ok: false,
      version: null,
      reason:
        `role prompt にプロトコル版の宣言がありません (期待: ${expected})。` +
        `先頭に <!-- communitd-protocol: ${expected} --> を書いてください`,
    };
  }
  if (version !== expected) {
    return {
      ok: false,
      version,
      reason:
        `role prompt のプロトコル版 ${version} が、動作中のブリッジ (${expected}) と違います。` +
        (version > expected
          ? 'ブリッジのコードが古いままです — /restart で新しいコードを読み込ませてください'
          : 'role prompt が古いままです — 新しい記法へ更新してください'),
    };
  }
  return { ok: true, version };
}
