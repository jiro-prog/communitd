// Discord へ出す文字列の加工 (純粋関数)。
//
// メンションの解決・無害化は src/mentions.js が持つ (制御マーカーの解釈と
// コード領域の判定をそちらに一本化してある)。ここは分割だけ。
//
// 分割はコードブロックのフェンスを保つ。素朴に切ると ``` の内側に境界が来て、
// 前のメッセージは閉じられないコードブロック・後ろのメッセージは素のテキストとして
// 表示される (長い diff や設計を貼ると必ずこれが起きていた)。またぐときは
// 前のチャンクを閉じ、次のチャンクを同じフェンス・同じ言語指定で開き直す。
//
// コード領域の判定を mentions.js の codeRegions と共有しないのは目的が違うため。
// あちらは「制御フッターを実行してよいか」を決める fail-closed の判定でインラインコードも
// 見る。こちらは表示を崩さないための整形で、行頭のフェンス行だけを追えばよい。

/** 行頭のコードフェンス (``` 以上)。2 つめのキャプチャは言語指定など */
const FENCE_LINE = /^[ \t]*(`{3,})[ \t]*(.*?)[ \t]*$/;

/**
 * フェンスの開閉を行単位で追う。
 *
 * @returns {{marks: Array<{at: number, open: {fence: string, info: string}|null}>,
 *            fences: Array<[number, number]>}}
 *   marks: その位置**以降**で開いているブロック (at = フェンス行の本文終端)
 *   fences: フェンス行そのものの [本文開始, 本文終端) — ここで切ると開き直せない
 */
function scanFences(src) {
  const marks = [];
  const fences = [];
  let open = null;
  let at = 0;
  for (const line of src.split('\n')) {
    const end = at + line.length;
    const m = FENCE_LINE.exec(line);
    if (m) {
      const fence = m[1];
      if (!open) {
        open = { fence, info: m[2] };
        marks.push({ at: end, open });
        fences.push([at, end]);
      } else if (m[2] === '' && fence.length >= open.fence.length) {
        // 閉じるのは「開始と同じ長さ以上のバッククォートだけの行」。
        // ``` の中に出てくる短い列や言語指定つきの行は中身の一部
        open = null;
        marks.push({ at: end, open: null });
        fences.push([at, end]);
      }
    }
    at = end + 1; // +1 = 削った '\n'
  }
  return { marks, fences };
}

/** offset までを出力した時点で開いているブロック (無ければ null) */
function openAt(marks, offset) {
  let open = null;
  for (const mark of marks) {
    if (mark.at > offset) break;
    open = mark.open;
  }
  return open;
}

/** offset がフェンス行を割っているならその行頭を返す (割っていなければ -1) */
function fenceLineStart(fences, offset) {
  for (const [start, end] of fences) {
    if (offset > start && offset < end) return start;
  }
  return -1;
}

/**
 * pos から最大 budget 文字ぶんの切断位置。
 * なるべく改行で切り、フェンス行は割らない。
 */
function chooseCut(src, fences, pos, budget) {
  const limit = pos + budget;
  if (limit >= src.length) return src.length;
  let cut = src.lastIndexOf('\n', limit);
  if (cut - pos < budget * 0.5) cut = limit; // 近くに改行が無ければ上限で切る
  const fenceStart = fenceLineStart(fences, cut);
  if (fenceStart > pos) cut = fenceStart; // フェンス自体を割ると閉じ直せない
  return cut;
}

/**
 * Discord の 1 メッセージ上限に合わせた分割 (なるべく改行位置で切る)。
 * コードブロックをまたぐ境界では閉じフェンスと開き直しを補うので、
 * 補った分を除けば結合して元のテキストに戻る。
 */
export function chunkText(text, size) {
  const src = String(text ?? '');
  const { marks, fences } = scanFences(src);
  const chunks = [];
  let pos = 0;
  let carry = null; // 前のチャンクを閉じたので開き直すブロック

  for (;;) {
    // 開き直しの改行は、切った位置に元の改行が残っているなら足さない。
    // 足すと ```js の直後に空行が 1 行増える (改行位置で切った境界では必ずこうなる)
    const prefix = carry
      ? `${carry.fence}${carry.info}${src[pos] === '\n' ? '' : '\n'}`
      : '';
    if (prefix.length + src.length - pos <= size) {
      chunks.push(prefix + src.slice(pos));
      break;
    }

    // 閉じフェンスを足すと上限を超えることがある。超えた分だけ詰めて決め直す
    // (詰めると開いていない位置まで戻ることがあり、そのときは補完自体が要らなくなる)
    let budget = size - prefix.length;
    let cut = pos;
    let open = null;
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      cut = chooseCut(src, fences, pos, budget);
      open = openAt(marks, cut);
      suffix = open ? `\n${open.fence}` : '';
      if (prefix.length + (cut - pos) + suffix.length <= size) break;
      budget = size - prefix.length - suffix.length;
    }
    if (cut <= pos) {
      // 上限が極端に小さくフェンスを収められない。崩れても進める方を採る
      cut = Math.min(src.length, pos + Math.max(1, size - prefix.length));
      open = null;
      suffix = '';
    }

    chunks.push(prefix + src.slice(pos, cut) + suffix);
    carry = open;
    pos = cut;
  }
  return chunks;
}
