// 設定の検証と解釈が共通で使う、値の形の判定。

export function inRange(v, [min, max]) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}
