// @ts-check
/**
 * スレッド文脈に載せる発言の選別と整列。
 *
 * discord.js にも I/O にも依存しない純粋関数にしてある (取得は src/bridge/prompt.js の役目)。
 * 起点投稿 (親チャンネル側に残る startThread の元メッセージ) をここで合流させる。
 */

/** measure 未指定時の文字数見積り (本文だけ)。実際の整形は呼び出し側の責務 */
const defaultMeasure = (m) => (m?.content ?? '').length;

/**
 * 発言を history と required に分けて渡すのは、**落としてよいものと落とすと
 * 恒久欠落するものが混ざっている**ため。
 *
 * - history = トリガーより前の遡り分。既読カーソルはもともとここまで戻らないので、
 *   予算超過時に古い方から捨ててよい (取得上限 FETCH_LIMIT で切っているのと同じ性質)。
 * - required = トリガー以降の発言と、既読カーソルからの未読差分。捨てても
 *   lastMessageId は前進するので、落とした発言は二度と読まれない。予算の対象外。
 *
 * @param {object} params
 * @param {{id: string}|null} params.starter 起点投稿 (新規セッション時のみ。無ければ null)。無条件保持
 * @param {Array<{id: string}>} [params.history] 予算超過時に古い順で落としてよい発言
 * @param {Array<{id: string}>} [params.required] 落とすと恒久欠落する発言 (無条件保持)
 * @param {string} params.triggerId 「あなた宛の指示」として別枠に出すトリガーの ID
 * @param {string} params.botUserId 自分の user ID
 * @param {boolean} [params.includeSelf] 自分の過去発言も文脈に含めるか (履歴を再構築する時)
 * @param {(msg: object) => boolean} [params.isInfra] ブリッジの運用メッセージ判定
 * @param {number} [params.charBudget] starter + history の文字数上限 (0 以下 = 無制限)
 * @param {(msg: object) => number} [params.measure] 1 発言の文字数 (既定は本文長)
 * @returns {{messages: Array<object>, omitted: number}}
 *   messages = createdTimestamp 昇順・ID 重複なし / omitted = 予算で落とした history の件数
 */
export function selectTranscript({
  starter,
  history = [],
  required = [],
  triggerId,
  botUserId,
  includeSelf = false,
  isInfra = () => false,
  charBudget = 0,
  measure = defaultMeasure,
}) {
  const seen = new Set();
  const pick = (list) =>
    list
      // 起点投稿がトリガー自身のケース (人間のチャンネル直メンション) はここで落ちる
      .filter((m) => m && m.id !== triggerId)
      // claude は自分の過去発言を resume セッションが持つので除外。履歴を再構築する
      // 経路 (codex / 新規・復旧セッション) は includeSelf=true で取り込む
      .filter((m) => includeSelf || m.author.id !== botUserId)
      .filter((m) => !isInfra(m))
      // 起点投稿が history 側にも現れうる (既存スレッドの取得範囲次第) ので一度だけに畳む。
      // pinned を先に通すので、重複したときに落ちるのは予算対象の側になる
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

  const pinned = pick([...(starter ? [starter] : []), ...required]);
  const candidates = pick(history).sort(byTime);

  const starterKept = starter ? pinned.some((m) => m.id === starter.id) : false;
  const { kept, omitted } = applyBudget(candidates, {
    charBudget,
    measure,
    used: starterKept && starter ? measure(starter) : 0,
  });

  return { messages: [...pinned, ...kept].sort(byTime), omitted };
}

const byTime = (a, b) => a.createdTimestamp - b.createdTimestamp;

/**
 * 新しい方から詰め、入らなくなった時点で**それより古い分をまとめて**落とす。
 * 飛ばし飛ばしに残すと「これ以前 N 件を省略」が嘘になるので、落とすのは必ず
 * 連続した最古側の塊にする。
 */
function applyBudget(ordered, { charBudget, measure, used }) {
  if (!(charBudget > 0)) return { kept: ordered, omitted: 0 };
  let total = used;
  for (let i = ordered.length - 1; i >= 0; i--) {
    total += measure(ordered[i]);
    if (total > charBudget) return { kept: ordered.slice(i + 1), omitted: i + 1 };
  }
  return { kept: ordered, omitted: 0 };
}
