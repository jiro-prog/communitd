// 日本時間 (JST) の暦日と表示。
//
// **保存する値は UTC の ISO 文字列のまま。** data/*.json に入っているのは機械が読む台帳で、
// そこを JST にすると既存ファイルと非互換になり、読む側にタイムゾーンの解釈が要るようになる。
// 直すべきなのは人間が読めない表示の方なので、ここが受け持つのは「見せるとき」と
// 「暦日で区切るとき」だけ。
//
// Intl ではなく固定オフセットで刻む。日本には夏時間が無いので +09:00 は通年で正しく、
// 実行機のタイムゾーンにも ICU の版にも依存しない — つまりテストがどの機械でも同じ結果になる。
// (ローカル時刻で切ると、機械の設定次第で「境目でだけ落ちる」種類の壊れ方をする。)

/** JST の UTC からのずれ。日本に夏時間は無いので通年でこの値 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 表示に添える札。付けずに出した時刻は UTC と読まれてしまう */
export const JST_LABEL = 'JST';

/**
 * ms / Date / ISO 文字列を ms へ。読めない値は NaN。
 *
 * 経路を分けてあるのは、文字列や null を `Number()` へ通すと 1970 年や NaN に
 * 化けて「読めなかった」ことが分からなくなるため。
 */
export function msOfTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
  return Number.NaN;
}

/**
 * JST の壁時計を UTC の ISO として読めるようにずらす。
 * **戻り値を絶対時刻として使わないこと** — 表示用に桁を切り出すためだけの中間形。
 * @returns {string|null} 読めない値・Date が表せない範囲は null
 */
function jstIso(value) {
  const ms = msOfTime(value);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + JST_OFFSET_MS);
  // 範囲外は Invalid Date になる。表示のために落ちないよう、ここで null に倒す
  return Number.isNaN(shifted.getTime()) ? null : shifted.toISOString();
}

/**
 * JST の暦日 (`2026-08-28`)。日次予算の区切りもスレッド名もこの暦で揃える。
 * @returns {string|null} 読めない値は null
 */
export function jstDayKey(value) {
  const iso = jstIso(value);
  return iso === null ? null : iso.slice(0, 10);
}

/**
 * 人間に見せる日時 (`2026-08-28 18:00 JST`)。
 *
 * 読めない値は **null を返す** — 「時刻不明」のような言い換えは、それが出る文の
 * 文脈で決めるべきもので、ここで勝手に文言を作らない。
 *
 * @param {number|Date|string} value
 * @param {{label?: boolean}} [options] label=false で札を省く (名前などに埋めるとき)
 * @returns {string|null}
 */
export function formatJst(value, { label = true } = {}) {
  const iso = jstIso(value);
  if (iso === null) return null;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}${label ? ` ${JST_LABEL}` : ''}`;
}
