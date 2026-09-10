// 統一 diff の文法ゲートと決定論的な適用 (docs/social-engineering.md §3.9)。
//
// 組織提案が持つ変更案は自由文の草案でなく `{touch, diff}` の機械可読形で、
// 裁定側・照合側・適用側が**同じ文字列**を見る。ここはその diff を
// 「正規化済みの通常ファイルに対する text の create / edit / delete だけ」へ閉じる層。
//
// 絶対パス、`..`、rename / copy、binary、mode 変更、symlink、submodule を落とすのは、
// touch 集合の照合をすり抜けて別の場所へ書く経路を作らないため。**旧側と新側の両方**を
// パスとして返し、呼び出し側が touch と突き合わせられるようにする (片側しか見ないと
// rename 相当の diff で touch の外へ書ける)。

import { isSafeRepoPath } from './repopath.js';

// パスの正規形は repopath.js が正本 (提案側のゲートと同じ判定を使う)
export { isSafeRepoPath };

/** git が付ける「末尾に改行が無い」印 */
const NO_NEWLINE_MARK = '\\ No newline at end of file';

/** 通常ファイル以外は扱わない (120000=symlink / 160000=submodule / 100755=実行属性) */
const REGULAR_FILE_MODE = '100644';

/** 受け付けない拡張ヘッダ (前方一致, 理由) */
const REJECTED_HEADERS = [
  ['similarity index', 'rename / copy を含む diff'],
  ['dissimilarity index', 'rename / copy を含む diff'],
  ['rename from', 'rename を含む diff'],
  ['rename to', 'rename を含む diff'],
  ['copy from', 'copy を含む diff'],
  ['copy to', 'copy を含む diff'],
  ['old mode', 'mode 変更を含む diff'],
  ['new mode', 'mode 変更を含む diff'],
  ['GIT binary patch', 'binary diff'],
  ['Binary files', 'binary diff'],
];

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const fail = (reason) => ({ ok: false, reason });

/**
 * 統一 diff を解析する。**文法から外れたものは解釈せずに落とす** (推測して当てない)。
 *
 * @param {string} text
 * @returns {{ok: true, files: object[]} | {ok: false, reason: string}}
 *   files[] は `{path, op:'create'|'edit'|'delete', oldPath, newPath, hunks[]}`。
 *   oldPath / newPath は create / delete のとき片側が null になる。
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || text.trim() === '') return fail('diff が空です');
  // CR が混じった diff は「同じ行」の判定が壊れる。正規化を要求して fail-closed にする
  if (text.includes('\r')) return fail('CR を含む diff は受け付けません (LF へ正規化してください)');

  const lines = text.split('\n');
  const files = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i] === '') { i += 1; continue; }

    let declared = null;
    if (lines[i].startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]);
      if (!m) return fail(`diff --git 行を解釈できません: ${lines[i]}`);
      declared = { old: m[1], new: m[2] };
      i += 1;
    }

    // 拡張ヘッダ (--- が来るまで)
    while (i < lines.length && !lines[i].startsWith('--- ')) {
      const head = lines[i];
      const rejected = REJECTED_HEADERS.find(([prefix]) => head.startsWith(prefix));
      if (rejected) return fail(`${rejected[1]}は適用できません: ${head}`);
      if (head.startsWith('index ')) { i += 1; continue; }
      if (head.startsWith('new file mode ') || head.startsWith('deleted file mode ')) {
        const mode = head.trim().split(' ').at(-1);
        if (mode !== REGULAR_FILE_MODE) {
          return fail(`通常ファイル (${REGULAR_FILE_MODE}) 以外は適用できません: ${head}`);
        }
        i += 1;
        continue;
      }
      return fail(`解釈できない行があります: ${head}`);
    }
    if (i >= lines.length) return fail('--- 行がありません');

    const oldSide = parseSide(lines[i], '--- ');
    if (!oldSide.ok) return oldSide;
    i += 1;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) return fail('+++ 行がありません');
    const newSide = parseSide(lines[i], '+++ ');
    if (!newSide.ok) return newSide;
    i += 1;

    const sides = resolveSides(oldSide.path, newSide.path);
    if (!sides.ok) return sides;
    const { op, path, oldPath, newPath } = sides;
    if (declared && ((oldPath && declared.old !== oldPath) || (newPath && declared.new !== newPath))) {
      return fail(`diff --git 行と ---/+++ のパスが食い違っています (${path})`);
    }
    if (files.some((f) => f.path === path)) return fail(`同じファイルが 2 回現れます: ${path}`);

    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const parsed = parseHunk(lines, i);
      if (!parsed.ok) return parsed;
      hunks.push(parsed.hunk);
      i = parsed.next;
    }
    if (hunks.length === 0) return fail(`ハンクがありません: ${path}`);

    const shape = checkShape(op, hunks, path);
    if (shape) return fail(shape);
    const coords = checkCoordinates(hunks, path);
    if (coords) return fail(coords);

    files.push({ path, op, oldPath, newPath, hunks });
  }

  if (files.length === 0) return fail('diff にファイルが 1 件もありません');
  return { ok: true, files };
}

/** `--- a/path` か `--- /dev/null` だけを受ける (タイムスタンプ付きの形は受けない) */
function parseSide(line, prefix) {
  const rest = line.slice(prefix.length);
  if (rest === '/dev/null') return { ok: true, path: null };
  // 旧側は a/・新側は b/ に固定する (取り違えた diff を「解釈」しない)
  const marker = prefix === '--- ' ? 'a' : 'b';
  const m = new RegExp(`^${marker}/(.+)$`).exec(rest);
  if (!m) return fail(`${prefix.trim()} 行を解釈できません: ${line}`);
  if (!isSafeRepoPath(m[1])) return fail(`パスとして受け付けられません: ${m[1]}`);
  return { ok: true, path: m[1] };
}

function resolveSides(oldPath, newPath) {
  if (oldPath === null && newPath === null) return fail('旧側も新側も /dev/null です');
  if (oldPath === null) return { ok: true, op: 'create', path: newPath, oldPath: null, newPath };
  if (newPath === null) return { ok: true, op: 'delete', path: oldPath, oldPath, newPath: null };
  if (oldPath !== newPath) return fail(`rename は適用できません (${oldPath} → ${newPath})`);
  return { ok: true, op: 'edit', path: oldPath, oldPath, newPath };
}

function parseHunk(lines, start) {
  const m = HUNK_HEAD.exec(lines[start]);
  if (!m) return fail(`ハンクヘッダを解釈できません: ${lines[start]}`);
  const oldStart = Number(m[1]);
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  if (oldCount === 0 && newCount === 0) return fail(`何も変えないハンクです: ${lines[start]}`);
  // 行数が 0 のときの開始番号は「その行の**後ろ**へ挿入する」意味なので 0 を許す。
  // 行数が 1 以上なら 1 始まりでなければならない (0 行目は存在しない)
  if (oldCount > 0 && oldStart < 1) return fail(`ハンクの旧側開始位置が不正です: ${lines[start]}`);
  if (newCount > 0 && newStart < 1) return fail(`ハンクの新側開始位置が不正です: ${lines[start]}`);

  let i = start + 1;
  let oldLeft = oldCount;
  let newLeft = newCount;
  const body = [];
  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) return fail('ハンクが途中で終わっています');
    const raw = lines[i];
    i += 1;
    if (raw === NO_NEWLINE_MARK) {
      if (body.length === 0) return fail('改行なし印の位置が不正です');
      body.at(-1).noNewline = true;
      continue;
    }
    // **行の先頭 1 文字は必ず ' ' / '-' / '+'。** 空行を「空の文脈行」と読むような
    // 補完はしない — 1 文字落ちた diff を解釈すると、当てた結果が承認した内容とずれる
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === ' ') {
      if (oldLeft <= 0 || newLeft <= 0) return fail('ハンクの行数がヘッダと合いません');
      oldLeft -= 1;
      newLeft -= 1;
    } else if (sign === '-') {
      if (oldLeft <= 0) return fail('ハンクの行数がヘッダと合いません');
      oldLeft -= 1;
    } else if (sign === '+') {
      if (newLeft <= 0) return fail('ハンクの行数がヘッダと合いません');
      newLeft -= 1;
    } else {
      return fail(`ハンク内の行を解釈できません: ${raw}`);
    }
    body.push({ sign, text, noNewline: false });
  }
  if (lines[i] === NO_NEWLINE_MARK) {
    if (body.length === 0) return fail('改行なし印の位置が不正です');
    body.at(-1).noNewline = true;
    i += 1;
  }
  return { ok: true, hunk: { oldStart, oldCount, newStart, newCount, body }, next: i };
}

/**
 * ハンクの**旧側と新側の座標が整合している**か。
 *
 * 新側の開始行は「旧側の位置 + それまでの増減」で決まる。これを見ないと
 * `@@ -1 +99 @@` のように新側だけ嘘の座標を書いた diff が当たってしまい、
 * 「承認した diff」と「実際に入る変更」の対応が崩れる。
 */
function checkCoordinates(hunks, path) {
  let delta = 0;
  let prevEnd = 0; // 直前のハンクが覆った旧側の終わり (0 始まり)
  for (const hunk of hunks) {
    const oldPos = hunkStart(hunk.oldStart, hunk.oldCount);
    const newPos = hunkStart(hunk.newStart, hunk.newCount);
    if (oldPos < prevEnd) return `ハンクの順序が逆か重なっています: ${path}`;
    if (newPos !== oldPos + delta) {
      return `ハンクの新側開始位置が旧側と整合しません: ${path} (@@ -${hunk.oldStart} +${hunk.newStart} @@)`;
    }
    delta += hunk.newCount - hunk.oldCount;
    prevEnd = oldPos + hunk.oldCount;
  }
  return null;
}

/** そのハンクが旧側 / 新側で始まる位置 (0 始まり)。行数 0 は「その行の後ろへ挿入」 */
export function hunkStart(start, count) {
  return count === 0 ? start : start - 1;
}

/** create は追加行だけ・delete は削除行だけ (中途半端な create/delete を受けない) */
function checkShape(op, hunks, path) {
  if (op === 'create') {
    if (hunks.length !== 1 || hunks[0].oldCount !== 0) return `作成の diff に旧側の行があります: ${path}`;
    if (hunks[0].body.some((l) => l.sign !== '+')) return `作成の diff に追加以外の行があります: ${path}`;
  }
  if (op === 'delete') {
    if (hunks.length !== 1 || hunks[0].newCount !== 0) return `削除の diff に新側の行があります: ${path}`;
    if (hunks[0].body.some((l) => l.sign !== '-')) return `削除の diff に削除以外の行があります: ${path}`;
  }
  return null;
}

/**
 * diff が触るファイルパス (旧側と新側の両方・`/dev/null` は除く)。
 * touch 集合との照合はこれで行う。
 */
export function diffTouchPaths(files) {
  const paths = new Set();
  for (const file of files ?? []) {
    if (file?.oldPath) paths.add(file.oldPath);
    if (file?.newPath) paths.add(file.newPath);
  }
  return [...paths].sort();
}

/**
 * 1 ファイル分の diff を当てる。**位置も文脈も完全一致でなければ当てない** —
 * ずれを吸収すると「承認した diff」と「実際に入った変更」が別物になる。
 *
 * @param {object} file parseUnifiedDiff が返した要素
 * @param {string|null} before 現在の内容 (存在しなければ null)
 * @returns {{ok: true, after: string|null} | {ok: false, reason: string}}
 *   after は delete のとき null。
 */
export function applyDiffFile(file, before) {
  if (file?.op === 'create') {
    if (before !== null && before !== undefined) return fail(`作成対象が既に存在します: ${file.path}`);
  } else if (typeof before !== 'string') {
    return fail(`対象ファイルがありません: ${file?.path}`);
  }

  const source = typeof before === 'string' ? splitLines(before) : { lines: [], endsWithNewline: true, eol: '\n' };
  if (source.eol === null) {
    return fail(`改行 (LF / CRLF) が混在しているファイルは扱えません: ${file.path}`);
  }
  const out = [];
  let cursor = 0;
  // **最後に出力した行**が改行なしで終わるか。入力全体の EOF 状態ではなく
  // 出力側を追う — そうしないと、改行なしの最終行だけを消したときに
  // 「その手前の行が持っていた改行」まで失う
  let tailNoNewline = false;

  /** 原本の [from, to) を写す。原本の最終行まで写したときだけ改行なしを引き継ぐ */
  const copy = (from, to) => {
    if (to <= from) return;
    out.push(...source.lines.slice(from, to));
    tailNoNewline = to === source.lines.length ? !source.endsWithNewline : false;
  };

  for (const hunk of file.hunks) {
    const start = hunkStart(hunk.oldStart, hunk.oldCount);
    if (start < cursor) return fail(`ハンクが重なっています: ${file.path}`);
    if (start > source.lines.length) return fail(`ハンクの位置がファイル末尾を超えています: ${file.path}`);
    copy(cursor, start);
    cursor = start;
    // 新側の座標も実際の出力位置と合っていること (parse 時の整合検査をここでも効かせる)
    if (out.length !== hunkStart(hunk.newStart, hunk.newCount)) {
      return fail(`ハンクの新側開始位置が実際の位置と合いません: ${file.path}`);
    }

    for (const line of hunk.body) {
      if (line.sign === ' ' || line.sign === '-') {
        if (source.lines[cursor] !== line.text) {
          return fail(`${file.path}:${cursor + 1} の内容が diff の前提と違います`);
        }
        cursor += 1;
      }
      if (line.sign === ' ' || line.sign === '+') {
        out.push(line.text);
        tailNoNewline = line.noNewline;
      }
    }
    // ハンクが旧側の末尾まで届いているなら、旧側の改行有無も印と一致していなければならない
    if (cursor === source.lines.length && file.op !== 'create') {
      const oldMark = lastOldMark(hunk);
      if (oldMark !== null && oldMark === source.endsWithNewline) {
        return fail(`${file.path} の末尾改行が diff の前提と違います`);
      }
    }
  }

  if (file.op === 'delete') {
    // 先頭から末尾まで覆っていること。**残った行が 1 行も無いこと**まで見ないと、
    // 途中の 1 行だけを削る diff で「ファイルごと消す」ことになる
    if (cursor !== source.lines.length || out.length !== 0) {
      return fail(`削除の diff がファイル全体を覆っていません: ${file.path}`);
    }
    return { ok: true, after: null };
  }

  copy(cursor, source.lines.length);
  return { ok: true, after: joinLines(out, !tailNoNewline, source.eol) };
}

/** そのハンクの旧側末尾行に「改行なし」印が付いていたか (旧側の行が無ければ null) */
function lastOldMark(hunk) {
  for (let i = hunk.body.length - 1; i >= 0; i -= 1) {
    const line = hunk.body[i];
    if (line.sign === '-' || line.sign === ' ') return line.noNewline;
  }
  return null;
}

/**
 * 原本を行へ割り、**改行の様式 (LF / CRLF) をファイル側の事実として取り出す。**
 *
 * diff 本体は LF 正規化を要求している (CR を含む diff は受けない) 一方、対象ファイルは
 * CRLF のことがある。行末の CR を「内容」として比べると、CRLF のリポジトリでは
 * どんな diff も当たらない。ここで様式として分離し、書き戻すときに**元の様式へ戻す** —
 * 承認された diff が、意図しない改行コードの一括変換を伴わないようにする。
 *
 * @returns {{lines: string[], endsWithNewline: boolean, eol: string|null}}
 *   eol が null = 混在。どちらへ寄せても書き戻しが決定論にならないので扱わない
 */
function splitLines(text) {
  const lines = text.split('\n');
  const endsWithNewline = lines.length > 0 && lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  // 改行で終わっている行だけが CR を持ちうる (末尾に改行が無い最終行は対象外)
  const terminated = endsWithNewline ? lines : lines.slice(0, -1);
  const withCr = terminated.filter((line) => line.endsWith('\r')).length;
  if (withCr === 0) return { lines, endsWithNewline, eol: '\n' };
  if (withCr !== terminated.length) return { lines, endsWithNewline, eol: null };
  return {
    lines: lines.map((line, i) => (i < terminated.length ? line.slice(0, -1) : line)),
    endsWithNewline,
    eol: '\r\n',
  };
}

function joinLines(lines, endsWithNewline, eol = '\n') {
  if (lines.length === 0) return '';
  return lines.join(eol) + (endsWithNewline ? eol : '');
}
