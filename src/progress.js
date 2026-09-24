// 「⚙️ 作業中…」の placeholder に、いまの段階・経過・最後に観測できた活動を出す。
//
// 情報源は増やさない: 段階は実行記録の側が知っていて、ツールは `hooks: true` のチャンネルで
// 実行後 hook が積む軌跡 (src/trace.js) にある。**軌跡は実行「後」のイベント**なので、
// 出すのは「最後に完了したツール」であって、いま実行中のツールではない。
//
// 更新は**変わったときだけ・30 秒以上の間隔**。Discord の編集レートに当てないためと、
// 承認待ちの表示 (🔐) を上書きしないため。終了・停止で必ず止める。

/** 更新間隔の初期値 (これより短くしない — 編集レートと読みやすさの両方) */
export const PROGRESS_INTERVAL_MS = 30 * 1000;

/**
 * 1 行の本文 (純粋)。
 * @param {object} p
 * @param {string} p.displayName
 * @param {string} p.channelName
 * @param {string} [p.model]
 * @param {string} p.stage 実行記録の段階 (starting / model / verify / deliver)
 * @param {number|null} p.startedAt job が走り出した時刻 (ms)
 * @param {number} p.now
 * @param {boolean} [p.hooks] 軌跡が取れるチャンネルか
 * @param {number|null} [p.toolCalls] 完了したツールの数
 * @param {{tool: string, arg?: string|null, at?: number|null}|null} [p.lastTool] 最後に完了したツール
 */
export function formatProgressLine({
  displayName, channelName, model = null, stage = 'model', startedAt = null, now = Date.now(),
  hooks = false, toolCalls = null, lastTool = null,
} = {}) {
  const head = `⚙️ ${displayName} 作業中… (${channelName}${model ? ` / model: ${model}` : ''})`;
  const parts = [`段階: ${stageLabel(stage)}`];
  const elapsed = elapsedLabel(startedAt, now);
  if (elapsed) parts.push(`経過 ${elapsed}`);
  if (hooks) {
    if (Number.isSafeInteger(toolCalls) && toolCalls > 0) {
      parts.push(`ツール ${toolCalls} 件`);
      if (lastTool?.tool) {
        const ago = elapsedLabel(lastTool.at ?? null, now);
        parts.push(
          `最後に完了したツール: ${lastTool.tool}${lastTool.arg ? ` ${lastTool.arg}` : ''}${ago ? ` (${ago} 前)` : ''}`,
        );
      }
    } else {
      parts.push('完了したツールはまだ無い (長い思考か最初のツールの実行中)');
    }
  } else {
    parts.push('ツールの詳細は取れない (hooks 無効)');
  }
  return `${head} — ${parts.join(' / ')}`.slice(0, 1900);
}

function stageLabel(stage) {
  switch (stage) {
    case 'starting': return '起動準備';
    case 'model': return 'モデル実行中';
    case 'approval': return 'ツール承認待ち';
    case 'verify': return '最終検証';
    case 'deliver': return '結果配送';
    default: return String(stage ?? '?');
  }
}

/** `12m` / `1h05m`。分より細かくは出さない。読めなければ空文字 */
export function elapsedLabel(from, now) {
  // null / undefined / 空文字を 0 (1970 年) に読まない — 読めないものは出さない
  const start = typeof from === 'number'
    ? from
    : (typeof from === 'string' && from.trim() !== '' ? Date.parse(from) : Number.NaN);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '';
  const minutes = Math.max(0, Math.floor((now - start) / 60000));
  if (minutes < 1) return '1m 未満';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/**
 * 定期的に placeholder を描き直す係。
 *
 * @param {object} p
 * @param {() => object|null} p.snapshot いまの状態 (`formatProgressLine` の引数 + `suspended`)。
 *   null / `suspended: true` なら何もしない (承認待ちの表示を上書きしない)
 * @param {(text: string) => Promise<unknown>} p.edit placeholder の編集
 * @param {(snap: object) => void} [p.onChange] 新しい活動を観測したとき (実行記録へ写す)
 * @param {number} [p.intervalMs]
 * @param {(fn: () => void, ms: number) => unknown} [p.setIntervalImpl]
 * @param {(handle: unknown) => void} [p.clearIntervalImpl]
 */
export function createProgressReporter({
  snapshot,
  edit,
  onChange = null,
  intervalMs = PROGRESS_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let lastText = null;
  let lastToolCalls = null;
  let stopped = false;
  // 進行中の編集。stop() はこれを待つ — 終端の ❌ / ⏹ を直後の tick が上書きしないため
  let editing = null;
  const period = Number.isSafeInteger(intervalMs) && intervalMs >= PROGRESS_INTERVAL_MS
    ? intervalMs
    : PROGRESS_INTERVAL_MS;

  async function tick() {
    if (stopped || editing) return false;
    let snap;
    try {
      snap = snapshot();
    } catch {
      return false; // 状態が読めない tick は飛ばす (次で読み直す)
    }
    if (!snap || snap.suspended) return false;
    const calls = Number.isSafeInteger(snap.toolCalls) ? snap.toolCalls : null;
    if (calls !== null && calls !== lastToolCalls) {
      lastToolCalls = calls;
      try { onChange?.(snap); } catch { /* 記録できなくても表示は続ける */ }
    }
    const text = formatProgressLine(snap);
    if (text === lastText) return false;
    lastText = text;
    editing = (async () => {
      try {
        await edit(text);
      } catch { /* 表示だけの失敗。次の tick で描き直す */ }
    })();
    try {
      await editing;
    } finally {
      editing = null;
    }
    return true;
  }

  return {
    start() {
      if (timer !== null || stopped) return;
      timer = setIntervalImpl(() => { void tick(); }, period);
      timer?.unref?.();
    },
    /** 止めて、進行中の編集があればそれを待つ (終端の表示を上書きさせない) */
    async stop() {
      stopped = true;
      if (timer !== null) clearIntervalImpl(timer);
      timer = null;
      if (editing) await editing;
    },
    tick,
    get intervalMs() {
      return period;
    },
  };
}
