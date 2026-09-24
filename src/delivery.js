// @ts-check
// 1 ターンぶんの投稿を「順序」と「完了境界」で束ねる (純粋関数)。
//
// 次の agent を呼ぶ制御メンションは**すべて送り終えたあとの専用 1 通**で、
// 途中で 1 つでも失敗したら送らない。以前は本文の最終チャンクに載せていたので、
// 添付や警告の送信に失敗しても相手が起動し、欠けた文脈のまま次が走った。
// スレッドの archive・削除・権限喪失もここで同じ扱いになる。
//
// 失敗しても claude セッションは巻き戻さない (副作用は既に起きている)。
// 「配信に失敗した」ことを人間へ見せて止まるのが正しい終わり方。

/**
 * @param {object} [p]
 * @param {Array<{label: string, run: () => Promise<any>, required?: boolean}>} [p.steps]
 *        required: true の失敗は以降を続けない (本文が届いていないのに注記だけ足さない)
 * @param {object|null} [p.mention] 制御フッターで解決した宛先 (無ければ handoff しない)
 * @param {() => Promise<any>} [p.sendMention] 宛先を呼ぶ 1 通の送信
 * @param {(failures: string[]) => Promise<any>} [p.notifyFailure] 呼べなかったことの告知
 * @returns {Promise<{delivered: boolean, handedOff: boolean, failures: string[]}>}
 */
export async function deliverTurn({ steps = [], mention = null, sendMention, notifyFailure } = {}) {
  const failures = [];

  // 失敗はどの経路でも必ず告知へ回す (告知そのものは失敗しうるので best-effort)。
  // 本文が落ちた場合はスレッドへ出せないことが多いので、呼び出し側は
  // placeholder の編集など別の手段を notifyFailure に渡す
  const fail = async () => {
    try {
      await notifyFailure?.(failures);
    } catch { /* 告知できなくても handoff しない判断は変わらない */ }
    return { delivered: false, handedOff: false, failures };
  };

  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failures.push(`${step.label}: ${err?.message ?? err}`);
      if (step.required) return fail();
    }
  }

  if (failures.length > 0) return fail();
  if (!mention) return { delivered: true, handedOff: false, failures };

  try {
    // mention があるときは呼び出し側が必ず渡す。欠けていれば下の catch が失敗として記録する
    await /** @type {() => Promise<any>} */ (sendMention)();
  } catch (err) {
    failures.push(`制御メンション: ${err?.message ?? err}`);
    return fail();
  }
  return { delivered: true, handedOff: true, failures };
}
