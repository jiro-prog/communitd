// Bot 出力に含まれる「制御マーカー」の解釈と、Discord へ出す前の無害化。
//
// discord.js には依存しない (送信ラッパが受けるのは send / edit を持つオブジェクトだけ) ので、
// 境界条件はすべてテストから直接叩ける。
//
// 平文の @名前 は**一切**制御命令として扱わない。以前は本文中の平文の呼び名
// (bot の displayName と作者の別名) を実メンションへ変換していたが、例文・引用・仕様の説明でそのまま暴発した
// (「@Opus と書くと起動する」と説明しただけで Opus が起動する)。
//
// 起動と通知を決めるのは、応答末尾の独立行に置かれた制御フッターだけ:
//   [[handoff:opus]]    … その bot を呼ぶ (bot-key は config.json の bots のキー)
//   [[notify:owner]]    … 人間 (ownerUserId) へ通知する
// 添付指定の [[attach: 相対パス.png]] も同じマーカー文法族なので、行の解釈は
// このモジュールに一本化してある (文法を 3 つ別々に生やすと二重管理が増えるだけ)。

import { chunkText } from './text.js';
import { formatJst } from './time.js';

// ---- コード領域 (旧 text.js から移設) ----

/**
 * Discord のコード領域 (インライン ` … `・コードブロック ``` … ```) の [開始, 終了) 一覧。
 *
 * 開始と終了のデリミタ長を対応させて走査する。正規表現で `+ … `+ と書くと
 * ``` `` `[[handoff:opus]]` `` ``` のような「外 2 個・内 1 個」で領域を取り違え、
 * 説明のつもりで書いたコード内のフッターを本物として実行してしまう。
 * 二重バッククォートは Discord でも「バッククォートを含むコード」の書き方。
 *
 * `~~~` は対象外 — Discord の Markdown はバッククォートのみを案内している。
 *
 * **閉じていないコードブロック (``` 以上) は EOF までコード扱いにする。**
 * 応答が途中で切れたコード例の末尾にフッター行が残ると、説明のつもりの行が
 * 本物の起動指示になってしまう (sol 指摘 2026-07-31)。閉じ忘れは「起動しない」側へ倒す。
 * 閉じていないインラインコード (` / ``) は行内で完結する書き方なので従来どおり平文扱い
 * — こちらまでコードにすると、本文にバッククォートが 1 つ紛れただけで委譲が落ちる。
 */
export function codeRegions(text) {
  return scanCode(text).regions;
}

/**
 * コード領域の走査結果。
 *
 * `unclosedAt` は**閉じ忘れたコードブロックの開始位置** (無ければ -1)。
 * 閉じ忘れは末尾までコード扱いになるので、そこに制御フッターが入ると
 * **警告もなく実行されない** — 委譲したつもりで相手が起動しない、という
 * いちばん気付きにくい失敗になる。呼び出し側がそれを見せられるように分けて返す。
 */
function scanCode(text) {
  const regions = [];
  let unclosedAt = -1;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const run = backtickRun(text, i);
    const openEnd = i + run;
    // コードブロック (3 個以上) は同じ長さ以上の列でも閉じられる
    const close = findClosingRun(text, openEnd, run, run >= 3);
    if (close === -1) {
      if (run >= 3) {
        regions.push([i, text.length]); // 閉じ忘れたコードブロックは末尾まで (fail-closed)
        unclosedAt = i;
        break;
      }
      i = openEnd; // 閉じていないインラインは Discord もコード表示しない
      continue;
    }
    regions.push([i, close]);
    i = close;
  }
  return { regions, unclosedAt };
}

/** index から続くバッククォートの個数 */
function backtickRun(text, index) {
  let run = 0;
  while (text[index + run] === '`') run++;
  return run;
}

/** 閉じデリミタの終端 index (見つからなければ -1) */
function findClosingRun(text, from, need, allowLonger) {
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const run = backtickRun(text, i);
    if (run === need || (allowLonger && run > need)) return i + run;
    i += run; // 長さが合わない列は中身の一部 (``code with ` inside``)
  }
  return -1;
}

export function insideCode(index, regions) {
  return regions.some(([start, end]) => index >= start && index < end);
}

// ---- マーカー行 ----

export const MARKER_KINDS = ['attach', 'handoff', 'notify'];

/**
 * 制御マーカーは**行頭で独立した 1 行**だけを拾う。
 * 説明文の途中に現れた同じ綴りを命令として実行しないため。
 */
const MARKER_LINE = /^[ \t]*\[\[[ \t]*(attach|handoff|notify)[ \t]*:[ \t]*(.*?)[ \t]*\]\][ \t]*$/;

/**
 * 行が「マーカーのつもりだが不可視文字のせいで成立していない」かどうかを見るための除去対象。
 * ゼロ幅・BOM・NBSP・各種の幅つき空白。モデルはこれらを混ぜることがあり、
 * 混ざったまま実行すると「見た目は同じなのに宛先が違う」余地になるので、
 * **正規化して実行するのではなく、実行せず警告する** (fail-closed)。
 */
const INVISIBLE = new RegExp(String.raw`[\u00a0\u1680\u180e\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]`, 'g');

/** 改行コードを LF に揃える (CRLF のままだと行末が \r になりマーカーが成立しない) */
export function normalizeNewlines(text) {
  return String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/**
 * 本文を行に割り、マーカー行を位置つきで拾う。
 * コード領域内の行は inCode: true を立てるだけで捨てない — 呼び出し側が
 * 「命令として実行しない / 本文からも消さない」を区別できるようにする。
 */
function scanMarkers(text) {
  const { regions, unclosedAt } = scanCode(text);
  const lines = text.split('\n');
  const markers = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_LINE.exec(lines[i]);
    if (m) {
      markers.push({
        kind: m[1].toLowerCase(),
        arg: m[2].trim(),
        line: i,
        offset,
        inCode: insideCode(offset, regions),
        // 閉じ忘れたコードブロックに飲み込まれた = 書いた本人は実行するつもりだった
        swallowed: unclosedAt >= 0 && offset >= unclosedAt,
        // 不可視文字が紛れていたら実行しない。宛先名の中に入っていると
        // 「見た目は同じなのに別の宛先」になりうる
        invisible: stripInvisible(lines[i]) !== lines[i],
      });
    }
    offset += lines[i].length + 1; // +1 = 削った '\n'
  }
  return { lines, markers };
}

/** 不可視文字を落とす (判定用。本文をこれで書き換えることはしない) */
function stripInvisible(line) {
  return line.replace(INVISIBLE, '');
}

/**
 * 制御フッターの開始行。末尾から遡って「空行かマーカー行」だけが続く範囲を
 * フッターとみなす。画像添付と handoff を並べて書けるようにするための定義で、
 * 本文の途中に紛れた handoff は (誤配置として) ここに入らない。
 */
function footerStartLine(lines, liveMarkers) {
  const markerLines = new Set(liveMarkers.map((m) => m.line));
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '' || markerLines.has(i)) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

/**
 * 添付マーカーの引数だけを取り出す (重複は畳む)。
 * コード領域内の行は説明とみなして拾わない。
 */
export function parseAttachMarkers(text) {
  const { markers } = scanMarkers(String(text ?? ''));
  const out = [];
  for (const m of markers) {
    if (m.inCode || m.kind !== 'attach' || !m.arg) continue;
    if (!out.includes(m.arg)) out.push(m.arg);
  }
  return out;
}

/** マーカー行を本文から取り除く (コード領域内は説明として残す) */
export function stripMarkerLines(text) {
  const src = String(text ?? '');
  const { lines, markers } = scanMarkers(src);
  const dropped = new Set(markers.filter((m) => !m.inCode).map((m) => m.line));
  if (dropped.size === 0) return src;
  return dropLines(lines, dropped);
}

/** 指定行を落として本文を組み直す (空行の連続は畳む) */
function dropLines(lines, dropped) {
  return lines
    .filter((_, i) => !dropped.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- 生メンションの無害化 ----

// モデルが直接 <@123> と書いた場合、allowedMentions では通知を止められても
// **文字列は本文に残る**。受信側 (src/trigger.js) は生 content を見て起動判定を
// するので、文字列のまま流すと迂回路になる。読める形へ潰してから送る。
const RAW_USER = /<@!?(\d{5,25})>/g;
const RAW_ROLE = /<@&(\d{5,25})>/g;
const RAW_BROADCAST = /@(everyone|here)(?![A-Za-z0-9_])/g;

/**
 * 本文中の生メンション表記を、通知にも起動にもならない形へ置き換える。
 * コード領域の中も対象にする — Discord は本文の文字列を見て mention を解析するし、
 * こちらの起動判定も生 content を見るので、コード内でも迂回路として成立してしまう。
 * @returns {{text: string, count: number}}
 */
export function neutralizeRawMentions(text) {
  let count = 0;
  const out = String(text ?? '')
    .replace(RAW_USER, (_, id) => { count++; return `[mention:${id}]`; })
    .replace(RAW_ROLE, (_, id) => { count++; return `[role:${id}]`; })
    .replace(RAW_BROADCAST, (_, word) => { count++; return `[${word}]`; });
  return { text: out, count };
}

/**
 * 旧記法 (`@<displayName>` / `@<owner の呼び名>` のような平文の呼び名) がコード外に残っていないか。
 * 変換はしない — 「呼んだつもりで呼べていない」ことを人間に見せるための検出。
 * @param {string[]} names 検出対象の呼び名 (bot の displayName + owner の別名)
 * @returns {string[]} 見つかった呼び名 (重複なし・出現順)
 */
export function detectLegacyMentions(text, names = []) {
  const src = String(text ?? '');
  const regions = codeRegions(src);
  const found = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') continue;
    const re = new RegExp(`@${escapeRegExp(name.trim())}(?![A-Za-z0-9_])`, 'gi');
    for (const m of src.matchAll(re)) {
      if (insideCode(m.index, regions)) continue;
      if (!found.includes(name)) found.push(name);
      break;
    }
  }
  return found;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 解決 ----

/**
 * 制御フッター 1 件を実際の宛先へ解決する。
 * 解決できない指定は「黙って無視」にしない — 委譲が消えたことに気付けなくなる。
 */
function resolveControl(marker, ctx) {
  if (marker.kind === 'notify') {
    if (marker.arg.toLowerCase() !== 'owner') {
      return { ok: false, reason: `\`[[notify:${marker.arg}]]\` は未知の宛先です (使えるのは owner だけ)` };
    }
    if (!ctx.owner?.userId) {
      return { ok: false, reason: '`[[notify:owner]]` は無視しました (config.secrets.json の ownerUserId が未設定)' };
    }
    return {
      ok: true,
      mention: { kind: 'notify', userId: ctx.owner.userId, label: ctx.owner.names?.[0] ?? 'owner' },
    };
  }

  const bots = ctx.bots ?? [];
  const key = marker.arg.toLowerCase();
  const bot = bots.find((b) => typeof b?.key === 'string' && b.key.toLowerCase() === key);
  if (!bot) {
    // 候補には編成外を並べない (呼べない名前を示すと、次のターンでそれを呼びに行く)
    const usable = bots
      .filter((b) => b.key !== ctx.selfBotKey && b.inRoster !== false)
      .map((b) => b.key)
      .join(' / ');
    return {
      ok: false,
      reason: `\`[[handoff:${marker.arg}]]\` は未知の宛先です${usable ? ` (使えるのは ${usable})` : ''}`,
    };
  }
  // **自分宛は自己呼び出し** (仕事を区切って自分で続ける)。ここから先の判定は
  // 他人宛と共通で通す — 編成から外されている担当は自分でも呼べない。
  // 連続回数の上限は受信側 (src/hops.js の takeSelf) が持つ
  //
  // 起動していても、このスレッドの編成 (/roster) から外れていれば呼ばせない。
  // 実行文脈の生成側でも同じ allowlist で落としてある (src/roster.js)
  if (bot.inRoster === false) {
    return {
      ok: false,
      reason: `\`[[handoff:${marker.arg}]]\` の宛先はこのスレッドの編成に入っていません (/roster で変更できます)`,
    };
  }
  if (!bot.userId) {
    return { ok: false, reason: `\`[[handoff:${marker.arg}]]\` の宛先はいま起動していません` };
  }
  return {
    ok: true,
    mention: {
      // 呼び出し側 (制御メッセージの文言・ログ) が他人への委譲と見分けるための種別。
      // 起動そのものは userId のメンション 1 個で決まる — kind は関与しない
      kind: bot.key === ctx.selfBotKey ? 'self' : 'handoff',
      userId: bot.userId,
      label: bot.displayName ?? bot.key,
    },
  };
}

/**
 * Bot の生出力を、Discord へ送ってよい形へ解決する。
 *
 * 順序の定義 (呼び出し側もこの順に依存している):
 *   解決 → マーカー行の除去 → 生メンションの無害化 → (呼び出し側で) 分割 →
 *   最終チャンクにだけ実メンションを足す
 *
 * @param {string} raw モデルの最終テキスト
 * @param {object} ctx
 * @param {string} ctx.selfBotKey 送信元の bot キー (自分宛 = 自己呼び出しの判別と、
 *        「未知の宛先」警告の候補一覧から自分を外すのに使う)
 * @param {Array<{key: string, displayName?: string, userId?: string|null, inRoster?: boolean}>} ctx.bots
 *        起動対象になりうる bot (inRoster: false = このスレッドの編成外・呼ばせない)
 * @param {{userId: string, names?: string[]}|null} ctx.owner 人間 (未設定なら null)
 * @returns {{body: string, attachMarkers: string[],
 *            mention: {kind: string, userId: string, label: string}|null,
 *            warnings: string[]}}
 */
export function resolveOutgoingText(raw, ctx = {}) {
  // 改行は先に LF へ揃える。CRLF のままだと行末に \r が残り、マーカー行の
  // 「行末まで」の判定に落ちて委譲が黙って不発になる
  const text = normalizeNewlines(raw);
  const { lines, markers } = scanMarkers(text);
  // コード内のマーカーは命令として扱わず、本文からも消さない (説明として残す)。
  // 不可視文字入りのマーカーも同じ扱い — 実行しないし、人間が気付けるよう残す
  const live = markers.filter((m) => !m.inCode && !m.invisible);
  const footerStart = footerStartLine(lines, live);
  const warnings = [];

  const attachMarkers = [];
  for (const m of live) {
    if (m.kind === 'attach' && m.arg && !attachMarkers.includes(m.arg)) attachMarkers.push(m.arg);
  }

  const controls = live.filter((m) => m.kind === 'handoff' || m.kind === 'notify');
  const inFooter = controls.filter((m) => m.line >= footerStart);
  for (const stray of controls.filter((m) => m.line < footerStart)) {
    warnings.push(
      `本文中の \`[[${stray.kind}:${stray.arg}]]\` は実行していません (制御フッターは末尾の独立行だけが有効)`,
    );
  }

  let mention = null;
  if (inFooter.length > 1) {
    // どれか 1 つを選ぶと「意図しない方を起動した」になる。全部止めて人間に見せる
    warnings.push(
      `制御フッターが ${inFooter.length} 個ありました — どれも実行していません (有効なのは 1 個だけ)`,
    );
  } else if (inFooter.length === 1) {
    const resolved = resolveControl(inFooter[0], ctx);
    if (resolved.ok) mention = resolved.mention;
    else warnings.push(resolved.reason);
  }

  // **閉じ忘れたコードブロックに飲み込まれた制御フッターを黙って落とさない。**
  // 閉じたコードブロックの中のマーカーは「説明として書いた」ものなので警告しないが、
  // 閉じ忘れは事故であって意図ではない — 委譲したつもりで相手が起動しない、という
  // いちばん気付きにくい失敗になる (実測 2026-08-03)
  for (const m of markers) {
    if (!m.swallowed || (m.kind !== 'handoff' && m.kind !== 'notify')) continue;
    warnings.push(
      `\`[[${m.kind}:${m.arg}]]\` は**閉じていないコードブロックの中**にあるため実行していません `
        + '(``` を閉じてから、フッターを末尾の独立行に置き直してください)',
    );
  }

  // 「マーカーのつもりだが不可視文字が紛れている」行を黙って落とさない。
  // 正規化して実行はしない — 見た目が同じで宛先が違う余地を残さないため
  for (const line of pseudoMarkerLines(lines, markers)) {
    warnings.push(
      `\`${line}\` は不可視文字を含むため制御マーカーとして実行していません ` +
        '(空白・ゼロ幅文字を取り除いて書き直してください)',
    );
  }

  const neutralized = neutralizeRawMentions(dropLines(lines, new Set(live.map((m) => m.line))));
  if (neutralized.count > 0) {
    warnings.push(
      `生のメンション表記 ${neutralized.count} 件を無効化しました (呼び出しは制御フッターだけが行います)`,
    );
  }

  // 呼べているならもう伝わっているので、旧記法の指摘は「呼べていない時」だけ出す
  if (!mention) {
    const legacy = detectLegacyMentions(text, legacyNames(ctx));
    if (legacy.length > 0) {
      warnings.push(
        `平文の ${legacy.map((n) => `\`@${n}\``).join(' ')} では起動しません — ` +
          '呼ぶときは末尾の独立行に `[[handoff:ボットキー]]` / `[[notify:owner]]` を書いてください',
      );
    }
  }

  // **警告も本文と同じ強さで無害化する。** 警告はモデルが書いた文字列 (マーカーの引数・
  // 宛先名・行の抜粋) をそのまま引用するので、`[[handoff:<@123>]]` のような入力を
  // 素通しすると、本文では潰した生 ID が警告の側で復活する。受信側は生の
  // `msg.content` を見るので、それだけで別の bot が起動する (sol 指摘 2026-08-03)。
  // 個々の push 側で無害化すると足し忘れが必ず出るため、**出口で一括して**通す
  return {
    body: neutralized.text,
    attachMarkers,
    mention,
    warnings: warnings.map((w) => neutralizeRawMentions(w).text),
  };
}

/**
 * 「マーカーのつもりだが不可視文字が紛れている」行。2 通りある:
 *   - 形としては成立しているが不可視文字入り (宛先名の中に紛れている等)
 *   - 不可視文字のせいで形として成立していない (取り除けば成立する)
 * どちらも実行せず、取り除いた形を見せて書き直してもらう。
 * @returns {string[]} 不可視文字を取り除いた行 (最大 3 件)
 */
function pseudoMarkerLines(lines, markers) {
  const found = [];
  const byLine = new Map(markers.map((m) => [m.line, m]));
  for (let i = 0; i < lines.length && found.length < 3; i++) {
    const marker = byLine.get(i);
    if (marker) {
      if (marker.invisible && !marker.inCode) found.push(stripInvisible(lines[i]).trim());
      continue;
    }
    const line = lines[i];
    if (!line.includes('[[')) continue; // 見当違いの行を舐めない
    const cleaned = stripInvisible(line);
    if (cleaned !== line && MARKER_LINE.test(cleaned)) found.push(cleaned.trim());
  }
  return found;
}

/** 旧記法の検出対象 (自分の名前も含める — 自分宛の誤記も「呼べていない」ので) */
function legacyNames(ctx) {
  return [
    ...(ctx.bots ?? []).map((b) => b?.displayName).filter(Boolean),
    ...(ctx.owner?.names ?? []),
  ];
}

// ---- 送信 ----

/**
 * Discord へ渡す allowedMentions。**ここで挙げた user ID 以外は通知にならない。**
 * parse を空にするのが要点で、既定の parse: ['users'] のままだと本文に残った
 * 生 <@id> がそのまま通知になる (= 制御フッターを迂回できる)。
 */
export function allowedMentionsFor(userIds = []) {
  const users = [...new Set(userIds.filter((id) => typeof id === 'string' && id !== ''))];
  return { parse: [], users, roles: [], repliedUser: false };
}

/**
 * 送信ペイロードを組み立てる唯一の口。文字列でもオブジェクト (files 付き) でも受ける。
 * 呼び出し側が allowedMentions を書き忘れる余地を残さないため、必ずここを通す。
 */
export function safePayload(content, { mentionUserIds = [], ...rest } = {}) {
  const base = typeof content === 'string' ? { content } : { ...content };
  return { ...base, ...rest, allowedMentions: allowedMentionsFor(mentionUserIds) };
}

/** channel.send のラッパ (allowedMentions 必須) */
export function sendSafe(channel, content, opts = {}) {
  return channel.send(safePayload(content, opts));
}

/** message.edit のラッパ (allowedMentions 必須) */
export function editSafe(message, content, opts = {}) {
  return message.edit(safePayload(content, opts));
}

/** message.reply のラッパ (allowedMentions 必須) */
export function replySafe(message, content, opts = {}) {
  return message.reply(safePayload(content, opts));
}

/**
 * 本文を分割して送る。**実メンションは一切載せない。**
 *
 * 次の agent を呼ぶのは「本文・添付・通知・警告をすべて送り終えたあと」の専用 1 通
 * (sendControlMention) に一本化してある。本文の最終チャンクに載せていた頃は、
 * 添付や警告の送信に失敗しても相手が起動してしまい、不完全な文脈で次が走った。
 *
 * @param {{send: (payload: object) => Promise<any>}} channel
 * @param {{body: string}} outgoing
 * @returns {Promise<number>} 送った通数
 */
export async function sendBody(channel, outgoing, { chunkSize = 1900 } = {}) {
  const chunks = chunkText(outgoing?.body || '(画像のみ)', chunkSize);
  for (const chunk of chunks) await sendSafe(channel, chunk);
  return chunks.length;
}

/**
 * 制御フッターで指定された宛先を呼ぶ**専用の 1 通**。
 * これがこのターンの完了境界で、ここまで何も失敗していないときにだけ送る。
 *
 * suffix は呼び出し側が意味を決める不透明な 1 行 (T6 の委譲契約タグ)。
 * **この通で渡さないと受け手が結び付けられない**ものだけを載せる —
 * 起動そのものを決めるのは従来どおりメンション 1 個だけで、書式には関与しない。
 */
export function sendControlMention(channel, mention, { suffix = '' } = {}) {
  if (!mention?.userId) return Promise.resolve(null);
  const tail = typeof suffix === 'string' && suffix.trim() !== '' ? `\n${suffix.trim()}` : '';
  return sendSafe(channel, `<@${mention.userId}>${tail}`, { mentionUserIds: [mention.userId] });
}

// ---- 自律運転のタスクスレッド ----

/** Discord のスレッド名の上限 */
export const MAX_THREAD_NAME_CHARS = 100;

/**
 * 起動メッセージ 1 通の上限 (sendBody の chunkSize と同じ)。
 *
 * **分割させない。** 分割すると 1 通目 (メンションのある通) だけで job が立ち、
 * 続きが届く前に読まれる。起票のタイトルと理由は 1000 字ずつ通るので、
 * 素直に足すと 1 通に収まらないことがある — 収まらない分は理由から削る。
 */
export const MAX_TASK_START_CHARS = 1900;

/** 見出しへ入れる 1 行 (改行と連続空白を潰す) */
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * タスク用スレッドの名前。`task/<id> <タイトル>` を Discord の上限へ丸める。
 *
 * id を先頭に置くのは、スレッド名からボードのタスクを引けるようにするため
 * (スレッドとタスクは 1:1)。タイトルが長いときに削るのはタイトル側。
 */
export function taskThreadName(task, { max = MAX_THREAD_NAME_CHARS } = {}) {
  const prefix = `task/${oneLine(task?.id)}`;
  const title = oneLine(task?.title);
  if (!title) return prefix.slice(0, max);
  const name = `${prefix} ${title}`;
  return name.length <= max ? name : `${name.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * タスクスレッドへ投稿する起動メッセージ。
 *
 * **1 行目は `<@botId>` ちょうど** (制御メッセージと同じ流儀)。ただしこの通は
 * 2 行を超えるので、**宛先 bot 自身の client からは投稿しないこと** —
 * 自分の多行発言は src/trigger.js の shouldIgnoreOwnMessage が捨てるため、
 * 送っても job が立たない (暴発防止の仕組みをそのまま利用している)。
 *
 * @param {object} p
 * @param {object} p.task ボードのタスク (id / title / rationale / branch / jobBudget)
 * @param {string} p.botUserId 起こす担当の Discord ユーザー ID
 * @param {string} [p.directionFile] 方向性ドキュメントのパス
 */
export function taskStartMessage({
  task = {}, botUserId, directionFile = '', max = MAX_TASK_START_CHARS,
} = {}) {
  const id = oneLine(task.id);
  const budget = Number.isSafeInteger(task.jobBudget) && task.jobBudget > 0 ? task.jobBudget : null;
  const head = [
    `<@${botUserId}>`,
    '',
    `## タスク ${id}: ${oneLine(task.title)}`,
    '自律運転のスケジューラが起こしたタスクです。このスレッドで完結させてください。',
    '',
    '### 理由 (起票時)',
  ];
  const tail = [
    '',
    '### 約束',
    `- ブランチ \`${oneLine(task.branch) || `task/${id}`}\` で作業する (main へ直接コミットしない)`,
    budget === null
      ? '- job 予算: 未設定 — 人間に確認すること'
      : `- job 予算は ${budget} job。使い切るとこのスレッドは止まり、`
        + '人間が追い予算を出すまで再開しない (発言では戻らない)',
    directionFile
      ? `- 着手前に \`${directionFile}\` (方向性ドキュメント) を読み、`
        + 'そこに書かれた方向・やらないこと・粒度・品質基準に従う'
      : '- 方向性ドキュメントが設定されていない — 迷ったら人間に聞くこと',
    '- 終わったら報告様式 (本文 / 変更ファイル / やったこと / 検証結果 / 残課題) で返す',
    '- **完了の報告には本文に制御フッタを書かないこと** (レビューはブリッジが自動で回す)。'
      + '途中で区切る自己呼び出しや上位へのエスカレーションは、従来どおりフッタでよい',
  ];
  const reason = String(task.rationale ?? '').trim() || '(記載なし)';
  const build = (body) => [...head, body, ...tail].join('\n');

  const full = build(reason);
  if (full.length <= max) return full;
  // 溢れた分は理由から削る (約束は削らない — 削ると規律が伝わらない)
  const room = reason.length - (full.length - max) - 1;
  return build(room > 0 ? `${reason.slice(0, room)}…` : '…').slice(0, max);
}

/**
 * 差し戻しの再開メッセージ (review → in-progress)。
 *
 * **理由をそのまま載せる。** レビューの本文はスレッドに出ているが、直す側の job は
 * この 1 通で起こされるので、何を直すのかがここに無いと読み落とす経路ができる。
 *
 * 1 行目が `<@botId>` ちょうどなのは taskStartMessage と同じ理由 —
 * **担当自身の client から投げないこと** (投げるのは判定を出したレビュー担当)。
 */
export function sendBackMessage({
  task = {}, botUserId, reason = '', budget = null, max = MAX_TASK_START_CHARS,
} = {}) {
  const id = oneLine(task.id);
  const head = [
    `<@${botUserId}>`,
    '',
    `## 差し戻し — タスク ${id}: ${oneLine(task.title)}`,
    'レビューが通らなかったので、同じスレッド・同じブランチの続きとして直してください。',
    '',
    '### 指摘',
  ];
  const tail = [
    '',
    '### 約束',
    `- ブランチ \`${oneLine(task.branch) || `task/${id}`}\` のまま直す (新しいブランチを切らない)`,
    Number.isSafeInteger(budget) && budget > 0
      ? `- 追い予算 ${budget} job を出してある。**次の差し戻しは無い** — `
        + '2 回目は自動で要人間になり、このスレッドは止まる'
      : '- **次の差し戻しは無い** — 2 回目は自動で要人間になり、このスレッドは止まる',
    '- 直したら報告様式 (本文 / 変更ファイル / やったこと / 検証結果 / 残課題) で返す',
  ];
  const body = String(reason ?? '').trim() || '(指摘の記載なし — レビューの本文を読むこと)';
  const build = (text) => [...head, text, ...tail].join('\n');

  const full = build(body);
  if (full.length <= max) return full;
  const room = body.length - (full.length - max) - 1;
  return build(room > 0 ? `${body.slice(0, room)}…` : '…').slice(0, max);
}

/**
 * スカウト用スレッドの名前。**JST で刻む** — 日次予算の区切り (src/scheduler.js の
 * dayKeyFor) と同じ暦で並ぶので、後から「その日の巡回」を追いやすい。
 * 同じ日に複数回巡回するので時刻まで入れる。
 */
export function scoutThreadName(now, { max = MAX_THREAD_NAME_CHARS } = {}) {
  // 文字列や null を Number() へ通すと 1970 年になってしまうので、数値と Date だけ受ける
  const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Number.NaN);
  const at = formatJst(ms);
  if (at === null) return 'scout';
  return `scout/${at}`.slice(0, max);
}

/**
 * `work` / `process` 提案の裁定を経営裁量の bot へ頼む文面。
 *
 * **この経路が無いと提案は永久に滞留する** (sol 指摘 2026-08-30) — org には作者の
 * 裁定カードがあるが、work / process は「bot はボタンを押せないので report の
 * `adjudication` から受ける」形なので、誰かが**その bot を起こさない限り**
 * 採否が返ってこない。稟議通知 (カード) と違って、これは裁定の配送そのもの。
 *
 * 1 行目が `<@botId>` ちょうどなのは taskStartMessage と同じ理由 —
 * **宛先自身の client から投げないこと**。
 *
 * @param {object} p
 * @param {string} p.botUserId 裁定する bot の Discord ユーザー ID
 * @param {object} p.proposal ProposalStore の提案 (保存済みのもの)
 * @param {string} [p.schemaTag] 起こす job の様式を決める目印 (src/contract.js の
 *   formatSchemaTag)。**この 1 通に載せる**ので、スレッドがどこに生えても、
 *   同じ場所へ複数の依頼が並んでも取り違えない
 */
export function adjudicationRequestMessage({
  botUserId, proposal = {}, schemaTag = '', initiativeTag = '', max = MAX_TASK_START_CHARS,
} = {}) {
  const id = oneLine(proposal.id);
  const input = proposal.input ?? {};
  const list = (items) => (Array.isArray(items) && items.length > 0
    ? items.map((x) => `- ${oneLine(x)}`)
    : ['- (記載なし)']);
  const head = [
    `<@${botUserId}>`,
    '',
    [
      `## 裁定の依頼 — 提案 #${id} (${oneLine(proposal.class)} / ${oneLine(input.kind)})`,
      schemaTag,
      initiativeTag,
    ].filter((part) => part !== '').join(' '),
    `対象: ${(Array.isArray(proposal.subjectKeys) ? proposal.subjectKeys : []).map(oneLine).join(' ') || '(不明)'}`,
    `起草: ${oneLine(proposal.raisedBy)} / duty: ${oneLine(input.duty)} / 直し先: ${oneLine(input.remedy)}`,
    '',
    '### 要旨',
    oneLine(input.summary) || '(記載なし)',
    '',
    '### 根拠',
    ...list(input.evidence),
    '',
    '### 利点 / リスク / コスト',
    ...list(input.benefits),
    ...list(input.risks),
    `- コスト: ${oneLine(input.cost) || '(記載なし)'}`,
    '',
    '### 返し方',
    '- 返答は **report 様式**。`adjudication` に '
      + `\`{proposal_id: "${id}", decision: "accepted" | "rejected", rationale: "..."}\` を書く`,
    '- **理由は必ず書く。** 却下は終端なので、残らないと同じ提案が再発議されて同じ議論になる',
    '- 自分の起草分でも裁定してよい (経営判断であって、実装物の自己レビューではない)',
    '- 通せないなら却下でよい。**保留は状態として無い** — 決めずに置くと滞留する',
    '- **本文に制御フッタ ([[handoff:...]]) を書かないこと。** 採否の適用はブリッジが回す',
  ];
  const text = head.join('\n');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 裁定依頼を落とすスレッドの名前。`proposal/<id> <要旨>`。
 *
 * 発議元のスレッドが archive されているときに**親チャンネルへ直接投げない**ため
 * (sol 指摘 2026-08-30)。bot 起点の投稿はスレッドの中だけが job になるので、
 * チャンネルへ投げると「投稿は通ったのに裁定 job が立たない」で滞留する。
 */
export function adjudicationThreadName(proposal = {}, { max = MAX_THREAD_NAME_CHARS } = {}) {
  const prefix = `proposal/${oneLine(proposal.id) || '?'}`;
  const summary = oneLine(proposal.input?.summary);
  if (!summary) return prefix.slice(0, max);
  const name = `${prefix} ${summary}`;
  return name.length <= max ? name : `${name.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 発議の巡回スレッドの名前。`initiative/<duty>/<JST>`。
 * duty を名前に入れるのは、同じ日に別の duty が回ったとき一覧で区別するため。
 */
export function initiativeThreadName(duty, now, { max = MAX_THREAD_NAME_CHARS } = {}) {
  const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Number.NaN);
  const at = formatJst(ms);
  const key = oneLine(duty) || 'duty';
  return (at === null ? `initiative/${key}` : `initiative/${key}/${at}`).slice(0, max);
}

/**
 * 発議 job の起動メッセージ (発議 3 経路のうち (2) と (3) が共用する)。
 *
 * **「提案なし」を正常と書いておく**のが要点 (「budget はノルマではなく上限であり、
 * 『提案なし』が正常な巡回も認める」)。書かないと、観測して何も無かった巡回が
 * 無理やり提案をひねり出す — 発議の質は裁定の負荷にそのまま乗る。
 *
 * 1 行目が `<@botId>` ちょうどなのは taskStartMessage と同じ理由 —
 * **担当自身の client から投げないこと**。
 *
 * @param {object} p
 * @param {string} p.botUserId 担当 bot の Discord ユーザー ID
 * @param {string} p.duty 起こす duty のキー
 * @param {string} [p.trigger] 起こした理由 (定期巡回なら空、イベントならその説明)
 * @param {string} [p.directionFile] 方向性ドキュメントのパス
 * @param {Array<{id: string, class: string, state: string, summary: string}>} [p.openProposals]
 *   その duty で今 open な提案 (重ねて発議させないための材料)
 * @param {string} [p.schemaTag] 起こす job の様式を決める目印 (src/contract.js の formatSchemaTag)
 * @param {string} [p.initiativeTag] 発議機構が起こした job の目印
 *   (src/scheduler.js の formatInitiativeTag — バックオフの証拠に数えないため)
 */
export function initiativeStartMessage({
  botUserId, duty = '', trigger = '', directionFile = '', openProposals = [],
  schemaTag = '', initiativeTag = '', max = MAX_TASK_START_CHARS,
} = {}) {
  const key = oneLine(duty) || '(duty 未指定)';
  const head = [
    `<@${botUserId}>`,
    '',
    [`## 発議の巡回 — duty: ${key}`, schemaTag, initiativeTag]
      .filter((part) => part !== '').join(' '),
    trigger
      ? `**${oneLine(trigger)}** を受けて起こしました。`
      : 'この duty の定期巡回です。',
    '担当領域を観測し、**望ましい状態との乖離**があれば発議してください。',
    '',
    '### この duty で今 open な提案',
  ];
  const tail = [
    '**同じ対象へ重ねて発議しないこと。** 言いたいことが既にある提案の話なら、'
      + '新しい提案ではなくそちらへの意見にする (1 つの対象に open な提案は 1 件まで)。',
    '',
    '### 進め方',
    directionFile
      ? `- まず \`${directionFile}\` (方向性ドキュメント) を読む`
      : '- 方向性ドキュメントが設定されていない — その旨を報告に書くこと',
    '- 返答は **report 様式**。発議するときだけ任意の `initiative` を埋める',
    '- **「今回は発議なし」も正常な巡回。** 乖離が無ければ `initiative` を丸ごと省いて、'
      + '観測した結果だけを報告すること (予算はノルマではなく上限)',
    '- `remedy` は `check > tooling > policy > role` の**序列**で選ぶ '
      + '— 検査器やツールで強制できるものを役割文の文面に書かない',
    '- `change` は `touch` と `diff` の機械可読形で書く。**全体置換の草案は受け付けない**',
    '- **本文に制御フッタ ([[handoff:...]]) を書かないこと。** '
      + '裁定はブリッジが回すので、書くと関係のない bot が起動する',
  ];
  const build = (items) => [...head, ...items, ...tail].join('\n');

  const lines = (Array.isArray(openProposals) ? openProposals : []).map(
    (p) => `- [${oneLine(p?.class)}/${oneLine(p?.state)}] ${oneLine(p?.id)}: ${oneLine(p?.summary)}`,
  );
  if (lines.length === 0) return build(['- (なし)', '']).slice(0, max);

  const kept = [];
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1;
    const trial = [...kept, line, ...(rest > 0 ? [`- …ほか ${rest} 件`] : []), ''];
    if (build(trial).length > max) break;
    kept.push(line);
  }
  const dropped = lines.length - kept.length;
  return build([...kept, ...(dropped > 0 ? [`- …ほか ${dropped} 件`] : []), '']).slice(0, max);
}

/**
 * スカウト job の起動メッセージ。
 *
 * **ボードの現状を渡すのが要点。** 何が既に起票されているか分からないまま巡回させると、
 * 同じ改善を何度も起票して承認側の負担になる。長くなったら一覧の方を削る
 * (規律の側を削ると、様式も 0 件の許可も伝わらなくなる)。
 *
 * 1 行目が `<@botId>` ちょうどなのは taskStartMessage と同じ理由 —
 * **担当自身の client から投げないこと** (多行の自分の発言は捨てられる)。
 *
 * @param {object} p
 * @param {string} p.botUserId スカウト担当の Discord ユーザー ID
 * @param {string} [p.directionFile] 方向性ドキュメントのパス
 * @param {Array<{id: string, state: string, title: string}>} [p.openTasks]
 *   いまボードにあるもの (非終端すべてと、直近に merged になったもの。
 *   選ぶのは `scoutBoardView` — src/board.js)
 */
export function scoutStartMessage({
  botUserId, directionFile = '', openTasks = [], max = MAX_TASK_START_CHARS,
} = {}) {
  const head = [
    `<@${botUserId}>`,
    '',
    '## 巡回 (スカウト)',
    '方向性ドキュメントとコードベースを見て、次にやるべきことを起票してください。',
    '',
    '### いまボードにあるもの (進行中・直近に着地したものを含む)',
  ];
  const tail = [
    '**同じことを二重に起票しないこと。** 既にあるものの言い換えは起票しない。',
    '',
    '### 進め方',
    directionFile
      ? `- まず \`${directionFile}\` (方向性ドキュメント) を読む — `
        + '方向・やらないこと・粒度・品質基準はそこが正本'
      : '- 方向性ドキュメントが設定されていない — 起票せず、その旨を報告すること',
    '- 1 タスク = 1 スレッドで完結する大きさに割る',
    '- 返答は **task-proposal 様式** (本文 / 起票するタスク) で返す',
    '- **1 件ごとに touch (触るファイルの相対パス) を宣言する。** 宣言の無い起票はボードが断る '
      + '— 触る場所が分からないタスクがあると、そのチャンネルでは組織提案が全件拒否されるため',
    '- **0 件も正しい報告。** 起票するに値するものが無ければ空配列で返すこと',
    '- **本文に制御フッタ ([[handoff:...]]) を書かないこと。** '
      + '承認はブリッジが自動で回すので、書くと承認担当が二重に起動する',
  ];
  const build = (items) => [...head, ...items, ...tail].join('\n');

  const lines = (Array.isArray(openTasks) ? openTasks : []).map(
    (task) => `- [${oneLine(task?.state)}] ${oneLine(task?.id)}: ${oneLine(task?.title)}`,
  );
  if (lines.length === 0) return build(['- (なし)', '']).slice(0, max);

  const kept = [];
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1;
    const trial = [...kept, line, ...(rest > 0 ? [`- …ほか ${rest} 件`] : []), ''];
    if (build(trial).length > max) break;
    kept.push(line);
  }
  const dropped = lines.length - kept.length;
  return build([...kept, ...(dropped > 0 ? [`- …ほか ${dropped} 件`] : []), '']).slice(0, max);
}
