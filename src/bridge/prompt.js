// スレッドの transcript からモデルへ渡す prompt を組む (src/index.js から切り出し)。
// 取捨の判断は src/transcript.js (selectTranscript)、添付の取得は src/attachments.js。
// ここは Discord の fetch と整形だけを持つ。
import {
  collectAttachments,
  describeAttachmentFailures,
  formatTextAttachments,
} from '../attachments.js';
import { selectTranscript } from '../transcript.js';

// ブリッジ自身が出す運用メッセージの接頭辞 (transcript から除外する)
// 注: 📋 (git 差分) は Fable の検収材料なので意図的に含めない
// 🔐 は承認待ちの placeholder、ℹ️ は権限通知の注記 (どちらも job の状態であって発言ではない)。
// 承認カード本文は `**` 始まりなのでここには載らない — カードはスレッドの中身として
// 次の文脈にも出るのが正 (何を申請したかが agent 側からも見える)
// 🛟 は停滞の通知 (§11.2) — job の状態であって発言ではない
export const INFRA_PREFIXES = ['⏳', '⚙️', '⚠️', '❌', '⏹', '🔐', 'ℹ️', '🛟'];

/**
 * メッセージ起点スレッドの、親チャンネル側に残った起点投稿。
 * 削除済み・権限不足・そもそも起点なし (独立スレッド) では null を返して job を続行する
 * — 文脈が一行減るだけで、ここで throw して job ごと落とす価値はない。
 */
async function fetchStarter(thread) {
  try {
    return (await thread.fetchStarterMessage()) ?? null;
  } catch {
    return null;
  }
}

export function speakerName(msg) {
  return `[${msg.member?.displayName ?? msg.author.displayName ?? msg.author.username}]`;
}

export function formatLine(msg, refs) {
  const body = msg.cleanContent || (msg.attachments.size ? '(添付のみ)' : '(空)');
  return `${speakerName(msg)}: ${body.replaceAll('\n', '\n  ')}${attachmentSuffix(msg, refs)}`;
}

/**
 * 発言に添付があったことと、それが何番目で入力されたかを本文と同じ行に添える。
 * 対応付けは添付 1 件ずつ (`a.png → 画像 #1, b.md → テキスト #1`) —
 * 発言単位でまとめると、画像とテキストが混在したとき対応が読めなくなる。
 * 番号が付かない添付 = モデルへ渡せなかったもの (理由は末尾の「# 添付」に出る)。
 * @param {Map<string, string>|null} refs attachment ID → 入力番号の表示
 */
export function attachmentSuffix(msg, refs) {
  const atts = [...msg.attachments.values()];
  if (atts.length === 0) return '';
  const names = atts.map((a) => {
    const name = a.name ?? '(名前なし)';
    const ref = refs?.get(a.id);
    return ref ? `${name} → ${ref}` : name;
  });
  return ` [添付: ${names.join(', ')}]`;
}

/**
 * @param {object} deps
 * @param {Map<string, {key: string, userId: string|null}>} deps.bots 起動中の bot (自分たちの投稿の判定に使う)
 * @param {{fetchLimit: number, transcriptCharBudget: number, attachments: object}} deps.limits
 */
export function createPromptBuilder({ bots, limits }) {
  const FETCH_LIMIT = limits.fetchLimit;
  const TRANSCRIPT_CHAR_BUDGET = limits.transcriptCharBudget;
  const ATTACHMENT_LIMITS = limits.attachments;

  function isInfraMessage(msg) {
    const authorIsOurs = [...bots.values()].some((b) => b.userId === msg.author.id);
    return authorIsOurs && INFRA_PREFIXES.some((p) => msg.content.startsWith(p));
  }

  async function buildPrompt(bot, triggerMsg, thread, entry, includeSelf = false) {
    // 前回このボットが読んだ位置以降 (新規セッションなら遡り + トリガー以降) の発言を集める。
    // history = 予算超過時に落としてよい遡り分 / required = 落とすと恒久欠落する分。
    // 既読カーソル経由で拾った差分は「次回はもう読まれない」ので全件 required にする
    let history = [];
    let required = [];
    let truncated = false;
    let fetchFailed = false;
    try {
      if (entry?.lastMessageId) {
        // 既読位置から前方ページネーション
        // (単発 fetch だと未読 > limit の時に中間メッセージが恒久欠落する)
        let cursor = entry.lastMessageId;
        const cap = 300;
        for (;;) {
          const batch = await thread.messages.fetch({ after: cursor, limit: 100 });
          if (batch.size === 0) break;
          const arr = [...batch.values()];
          required.push(...arr);
          cursor = arr.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id;
          if (batch.size < 100) break;
          if (required.length >= cap) {
            truncated = true;
            break;
          }
        }
      } else {
        const before = await thread.messages.fetch({ before: triggerMsg.id, limit: FETCH_LIMIT });
        history = [...before.values()];
        // トリガーより後の発言も取り込む: 長い委譲文の後続チャンクはトリガーの後に
        // 投稿されるが、直列キューにより job 実行時点では投稿完了が保証されている
        const after = await thread.messages.fetch({ after: triggerMsg.id, limit: FETCH_LIMIT });
        required = [...after.values()];
      }
    } catch {
      // スレッド化直後などは履歴なしで続行するが、既読カーソルは前進させない
      fetchFailed = true;
    }

    // チャンネル直メンションは起点メッセージから startThread() でスレッドを生やすため、
    // 起点の発言は親チャンネル側に残り thread.messages.fetch では絶対に返らない。
    // 補わないと「人間が最初に何を頼んだか」が全 job から丸ごと落ちる。
    // 継続セッションで毎ターン先頭に積み直さないよう新規セッションに限定する。
    const starter = entry?.lastMessageId ? null : await fetchStarter(thread);

    // 予算判定は画像取得より前に置く — 落とした発言の画像まで取りに行かないため
    // (collectAttachments は relevant を受けているので、絞った時点で自動的に対象外になる)。
    // 測るのは画像番号を付ける前の整形結果。番号分だけ実測とはずれるが、実際に渡した
    // 文字数は promptChars としてログに出るのでそちらが正
    const { messages: relevant, omitted } = selectTranscript({
      starter,
      history,
      required,
      triggerId: triggerMsg.id,
      botUserId: bot.userId,
      includeSelf,
      isInfra: isInfraMessage,
      charBudget: TRANSCRIPT_CHAR_BUDGET,
      measure: (m) => formatLine(m, null).length + 1,
    });

    // 添付は文脈の全発言 + トリガーから集める。期限付き CDN URL をモデルへ渡すのではなく、
    // ブリッジ側で取得・検証したバイト列を画像入力とプロンプト本文へ回す
    const collected = await collectAttachments(
      [...relevant, triggerMsg].map((m) => ({
        messageId: m.id,
        attachments: [...m.attachments.values()],
      })),
      { limits: ATTACHMENT_LIMITS },
    );
    // どの添付が何番目で入力されたかを **添付 1 件ずつ** 対応付ける。
    // 発言単位だと、画像とテキストが混ざったときどの名前がどの番号か決まらない
    const refs = new Map();
    collected.images.forEach((img, i) => refs.set(img.attachmentId, `画像 #${i + 1}`));
    collected.texts.forEach((t, i) => refs.set(t.attachmentId, `テキスト #${i + 1}`));
    const speakerById = new Map([...relevant, triggerMsg].map((m) => [m.id, speakerName(m)]));

    const lines = relevant.map((m) => formatLine(m, refs));
    const trigger =
      `${speakerName(triggerMsg)}: ${triggerMsg.cleanContent}${attachmentSuffix(triggerMsg, refs)}`;

    // 省略は疑似発言としてではなく見出し直下に書く (時系列の中に偽の発言を混ぜない)
    const omitNote = omitted > 0 ? `(起点投稿を除く過去 ${omitted} 件を省略)\n` : '';
    const head =
      lines.length || omitted > 0
        ? `# Discord スレッドの新着発言 (文脈)\n${omitNote}${lines.length ? `${lines.join('\n')}\n` : ''}\n# あなた宛の指示\n`
        : '';
    // 取得できなかった添付は黙って落とさない (「添付は無かった」と誤読させない)
    const notes = [
      ...(collected.images.length
        ? [`画像 ${collected.images.length} 枚を #1 から順に入力しています。`]
        : []),
      ...(collected.texts.length
        ? [`テキスト添付 ${collected.texts.length} 件を「# 添付テキスト」に #1 から順に載せています。`]
        : []),
      ...describeAttachmentFailures(collected),
    ];
    // 本文は別セクションに出す。メタ情報 (何を渡した / 渡せなかった) と本体を混ぜない
    const textSection = formatTextAttachments(collected.texts, {
      speakerOf: (t) => speakerById.get(t.messageId) ?? null,
    });
    const prompt = [
      `${head}${trigger}`,
      notes.length ? `# 添付\n${notes.join('\n')}` : '',
      textSection ? `# 添付テキスト\n${textSection}` : '',
    ].filter(Boolean).join('\n\n');

    // 既読位置 = 実際にモデルへ渡した最新 snowflake (実行中に届いた発言は次回に回る)。
    // ページネーション打ち切り時・fetch 失敗時はトリガーまで進めない (未読を取りこぼさない)。
    // 起点投稿は history/required に混ぜない: 常に triggerMsg より小さい snowflake なので
    // 既読位置を動かす理由がなく、混ぜると打ち切り時 (truncated) の max 計算に無用な項が増える。
    // 文字数予算で落とした発言はここでは既読に含める — 落とすのは必ずトリガーより古い
    // history 側だけなので snowflake の max は動かず、既読位置は予算の有無で変わらない
    let lastSeenId;
    if (fetchFailed && entry?.lastMessageId) {
      lastSeenId = entry.lastMessageId;
    } else {
      const fetchedIds = [...history, ...required].map((m) => m.id);
      const seenIds = truncated ? fetchedIds : [triggerMsg.id, ...fetchedIds];
      lastSeenId = seenIds.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    }
    return {
      prompt,
      lastSeenId,
      images: collected.images,
      contextMessages: relevant.length,
      omittedMessages: omitted,
    };
  }

  return { buildPrompt, isInfraMessage };
}
