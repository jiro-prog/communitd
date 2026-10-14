// 受付 (チャンネル直下の振り分け) の配線。設計は docs/notes/2026-10-11-intake.md、判断は src/intake.js。
//
// 受付 bot がチャンネル直下の人間の投稿を受け、`runClaude` を**直接**呼ぶ — 通常の runJob は通さない
// (スレッド前提の ⏳・差分・verify・セッション記録・契約・実行記録を持ち込まない)。モデルは構造化出力で
// 行動を返し、ここが検査してから実行する: その場で答える / スレッドを立てて担当を起こす / 既存の
// スレッドへ中継して担当を起こす。担当を起こすのは**スレッドの中の専用の 1 通**だけで、受け手は
// それを人間の重みで受ける (src/authz.js の relay・src/bridge/messages.js)。
//
// 作業ディレクトリのレーン (src/queue.js) には入れない — 同じ列だと worker が走っている間は答えられない。
// 代わりに**チャンネルごとに直列** — 連投された 2 通が同じ仕事に 2 本立てないよう、2 通目は 1 通目の
// 結果 (直下に返した報告とスレッド表) を見てから振り分ける。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaude } from '../claude.js';
import { resolveChannelRoster } from '../config.js';
import { NARROWED_DENY_TOOLS } from '../contract.js';
import {
  DEFAULT_INTAKE_EFFORT, DEFAULT_INTAKE_TIMEOUT_MS, INTAKE_SCHEMA, INTAKE_TOOLS, RECENT_CHANNEL_MESSAGES,
  buildIntakePrompt, buildThreadTable, handoffBody, intakeReply, planIntake, validateIntakeOutput,
} from '../intake.js';
import { replySafe, sendBody, sendControlMention, sendSafe } from '../mentions.js';
import { checkRoleProtocol } from '../protocol.js';
import { formatJobMetrics } from '../queue.js';
import { roleNameOf } from '../rolecontext.js';
import { chunkText } from '../text.js';
import { canonicalCwd } from '../toolstore.js';

/** 受け取った印 (スマホから貼った人が「見られたか」を分かるように)。終わったら外す */
export const INTAKE_RECEIVED_EMOJI = '⏳';
/** 受付できなかった印 (返信と一緒に付ける) */
export const INTAKE_FAILED_EMOJI = '❌';

/** スレッド表のために取りに行くアーカイブ済みスレッドの数。**仮置き** (表の窓は 1 週間・30 行) */
const ARCHIVED_THREADS_FETCH = 50;

/** Discord の 1 通の上限より少し手前 (src/mentions.js の sendBody と同じ) */
const CHUNK = 1900;

/** 発言者の表示名 (サーバーのニックネーム → ユーザーの表示名 → ユーザー名) */
function authorNameOf(m) {
  return m?.member?.displayName ?? m?.author?.displayName ?? m?.author?.username ?? '不明';
}

/** 人に見せる本文 (メンションは名前に直った形 — 受付に ID の羅列を読ませない) */
function textOf(m) {
  return String(m?.cleanContent ?? m?.content ?? '');
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.root                  役割文の相対パスの基点 (リポジトリの根)
 * @param {import('../jobruns.js').JobRunStore} deps.jobRuns
 * @param {object|null} deps.board            板 (無い配備では null)
 * @param {object} deps.lifecycle
 * @param {() => Array<{key: string, displayName?: string, userId: string|null, rolePromptFile?: string|null}>} deps.botEntries
 *        呼べる bot (src/bridge/discord.js — **受付 bot は既に外れている**)
 * @param {Function} [deps.runClaudeImpl]     テストから差し替える
 * @param {() => number} [deps.now]
 */
export function createIntakeWiring({
  config, root, jobRuns, board = null, lifecycle, botEntries,
  runClaudeImpl = runClaude, now = () => Date.now(),
}) {
  /** channelId → そのチャンネルで最後に積んだ受付 (チャンネルごとに直列にする鎖) */
  const chains = new Map();
  /** 走っている runClaude の handle (全体停止で撃つ) */
  const live = new Set();
  /** 受け付けてまだ終わっていない数 (待っている分を含む) */
  let inflight = 0;
  /** 全体停止の世代。進んだら、積まれていた受付も走らせない */
  let generation = 0;

  /**
   * 受付 bot の入口 (src/bridge/messages.js が isIntakePost を通したものだけ渡す)。
   * 返す Promise は**その投稿の受付が終わるまで**解決しない (テストと停止の待ち合わせのため)。
   */
  async function handlePost(bot, msg, { configured }) {
    if (!lifecycle.accepting) return;
    const gen = generation;
    inflight++;
    // 印は鎖に並ぶ前に付ける — 前の受付を待っている間も「見られた」が分かるように
    const mark = await msg.react(INTAKE_RECEIVED_EMOJI).catch(() => null);
    const channelId = msg.channel.id;
    const prev = chains.get(channelId) ?? Promise.resolve();
    const next = prev
      .then(() => runOne(bot, msg, configured, gen, mark))
      .catch((err) => console.error(`[intake msg:${msg.id}] 受付の後始末で例外`, err))
      .finally(() => {
        inflight--;
        if (chains.get(channelId) === next) chains.delete(channelId);
      });
    chains.set(channelId, next);
    await next;
  }

  const stoppedNow = (gen) => !lifecycle.accepting || gen !== generation;

  async function runOne(bot, msg, configured, gen, mark) {
    const startedAt = now();
    let result;
    try {
      result = await triage(bot, msg, configured, gen);
    } catch (err) {
      console.error(`[intake msg:${msg.id}] 受付で例外`, err);
      result = { ok: false, error: `内部エラー: ${err.message}` };
    }
    if (mark) await mark.users?.remove?.(bot.userId).catch(() => {});

    let text;
    if (result.stopped) {
      text = '⏹ 受付を止めたため、この投稿は振り分けていません — 必要ならもう一度貼ってください';
    } else if (!result.ok) {
      await msg.react(INTAKE_FAILED_EMOJI).catch(() => {});
      text = `⚠️ 受付できませんでした (${String(result.error ?? '理由不明').slice(0, 300)}) — bot を直接メンションしてください`;
    } else {
      text = intakeReply({ body: result.plan.body, done: result.done, rejected: result.plan.rejected });
    }
    await replyInChunks(msg, text);

    console.log(formatJobMetrics({
      jobId: `intake-${msg.id}`,
      botKey: bot.key,
      threadId: msg.channel.id,
      queueWaitMs: (result.runStartedAt ?? startedAt) - startedAt,
      runMs: now() - (result.runStartedAt ?? startedAt),
      reason: result.stopped
        ? 'intake-stopped'
        : !result.ok
          ? `intake-failed: ${String(result.error ?? '').slice(0, 80)}`
          : `intake-ok (行動 ${result.done.length}${result.plan.rejected.length ? ` / 落とした ${result.plan.rejected.length}` : ''})`,
      promptChars: result.promptChars,
      ...(result.usage ?? {}),
    }));
  }

  /** 1 通目は返信 (どの投稿への答えか分かるように)、残りはチャンネルへ続けて */
  async function replyInChunks(msg, text) {
    const chunks = chunkText(text, CHUNK);
    for (const [i, chunk] of chunks.entries()) {
      try {
        if (i === 0) await replySafe(msg, chunk);
        else await sendSafe(msg.channel, chunk);
      } catch (err) {
        console.error(`[intake msg:${msg.id}] 返信を送れませんでした: ${err.message}`);
        return;
      }
    }
  }

  /**
   * 受付 1 回: 文脈を集めて runClaude → 出力を検査 → 実行。
   * @returns {Promise<{ok: boolean, stopped?: boolean, error?: string, plan?: object, done?: object[],
   *   usage?: object|null, promptChars?: number, runStartedAt?: number}>}
   */
  async function triage(bot, msg, configured, gen) {
    if (stoppedNow(gen)) return { ok: false, stopped: true };
    const cwd = canonicalCwd(configured?.cwd);
    if (!cwd) return { ok: false, error: `作業ディレクトリを解決できません (${configured?.cwd ?? '未設定'})` };
    const roleFile = typeof bot.cfg?.rolePromptFile === 'string' ? resolve(root, bot.cfg.rolePromptFile) : null;
    if (!roleFile) return { ok: false, error: '受付 bot に rolePromptFile がありません' };
    let roleText;
    try {
      roleText = readFileSync(roleFile, 'utf8');
    } catch (err) {
      return { ok: false, error: `役割文を読めません (${bot.cfg.rolePromptFile}): ${err.message}` };
    }
    const proto = checkRoleProtocol(roleText);
    if (!proto.ok) return { ok: false, error: `${bot.cfg.rolePromptFile}: ${proto.reason}` };

    const at = now();
    const [recent, threads] = await Promise.all([recentMessages(msg), channelThreads(msg.channel)]);
    const { rows, omitted } = buildThreadTable({
      threads,
      runs: safeList(() => jobRuns.list({ channel: configured.channelName }), '実行記録'),
      tasks: board ? safeList(() => board.list({ channel: configured.channelName }), '板') : [],
      now: at,
    });
    const assignees = assigneesFor(configured);
    const prompt = buildIntakePrompt({
      post: {
        authorName: authorNameOf(msg),
        content: textOf(msg),
        attachments: [...(msg.attachments?.values?.() ?? [])].map((a) => a?.name).filter(Boolean),
      },
      recent,
      rows,
      omitted,
      assignees,
      now: at,
    });
    // Discord を読んでいる間に止められていないか (積まれていた受付もここで落ちる)
    if (stoppedNow(gen)) return { ok: false, stopped: true };

    const handle = { stopRequested: false };
    handle.abort = () => { handle.stopRequested = true; };
    live.add(handle);
    const runStartedAt = now();
    let res;
    try {
      res = await runClaudeImpl({
        claudeBin: config.claudeBin,
        cwd,
        model: bot.cfg.model,
        effort: bot.cfg.effort ?? DEFAULT_INTAKE_EFFORT,
        prompt,
        // 役割文は roles/intake.md **だけ** — 共通規定 (roles/_common.md) を付けると制御フッターや
        // 停止契約を教えることになり、受付が本文にフッターを書く。起動の経路は actions だけ
        rolePromptFile: roleFile,
        // 毎回新しいセッション (resume しない・記録しない) — 調整役は全履歴ではなく直近と表で動く
        resume: false,
        permissionMode: 'default',
        // 読むだけ。書けない・shell なし・サブエージェントなし・MCP なし・外部 settings を読まない
        tools: [...INTAKE_TOOLS],
        allowedTools: [...INTAKE_TOOLS],
        disallowedTools: [...NARROWED_DENY_TOOLS],
        strictMcp: true,
        settingSources: '',
        addDirs: [],
        // 常に構造化する (チャンネルの structuredOutput には従わない — 受付の様式は受付のもの)
        jsonSchema: INTAKE_SCHEMA,
        timeoutMs: DEFAULT_INTAKE_TIMEOUT_MS,
        scrubEnvKeys: Object.values(config.bots ?? {}).map((b) => b?.tokenEnv).filter(Boolean),
        handle,
      });
    } finally {
      live.delete(handle);
    }
    const promptChars = roleText.length + prompt.length;
    const usage = res?.usage ?? null;
    const base = { usage, promptChars, runStartedAt };
    if (res?.aborted || stoppedNow(gen)) return { ...base, ok: false, stopped: true };
    if (!res?.ok) return { ...base, ok: false, error: res?.error ?? '受付のモデルが失敗しました' };
    const checked = validateIntakeOutput(res.structuredOutput);
    if (!checked.ok) return { ...base, ok: false, error: `出力の様式違反: ${checked.error}` };

    const plan = planIntake({ output: checked.value, rows, assigneeKeys: assignees.map((a) => a.key) });
    const done = await execute(bot, msg, plan, assignees);
    return { ...base, ok: true, plan, done };
  }

  function safeList(read, label) {
    try {
      return read();
    } catch (err) {
      console.error(`[intake] ${label}を読めません (表から抜けます): ${err.message}`);
      return [];
    }
  }

  /** チャンネル直下の直近の発言 (古い順・この投稿の前まで)。受付自身の返信も含む — 提案の後の「進めて」を読むため */
  async function recentMessages(msg) {
    try {
      const fetched = await msg.channel.messages.fetch({ limit: RECENT_CHANNEL_MESSAGES, before: msg.id });
      return [...fetched.values()]
        .sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0))
        .map((m) => ({ authorName: authorNameOf(m), content: textOf(m), isBot: m.author?.bot === true }));
    } catch (err) {
      console.error(`[intake msg:${msg.id}] 直近の発言を取れません (無しで続けます): ${err.message}`);
      return [];
    }
  }

  /** このチャンネルのスレッド (名前とアーカイブ済みか)。取れなくても表は実行記録から組める */
  async function channelThreads(channel) {
    const out = [];
    const add = (fetched) => {
      for (const t of fetched?.threads?.values?.() ?? []) {
        out.push({ id: t.id, name: t.name, archived: t.archived === true });
      }
    };
    try {
      add(await channel.threads.fetchActive());
    } catch (err) {
      console.error(`[intake] 稼働中のスレッドを取れません: ${err.message}`);
    }
    try {
      add(await channel.threads.fetchArchived({ type: 'public', limit: ARCHIVED_THREADS_FETCH }));
    } catch (err) {
      console.error(`[intake] アーカイブ済みのスレッドを取れません: ${err.message}`);
    }
    return out;
  }

  /** 回せる担当 = 起動している bot (受付 bot は botEntries から外れている) をチャンネルの編成で絞ったもの */
  function assigneesFor(configured) {
    const roster = resolveChannelRoster(configured ?? {});
    const allowed = Array.isArray(roster) ? new Set(roster.map((k) => String(k).toLowerCase())) : null;
    return botEntries()
      .filter((b) => b.userId)
      .filter((b) => !allowed || allowed.has(String(b.key).toLowerCase()))
      .map((b) => ({ key: b.key, displayName: b.displayName, role: roleNameOf(b.rolePromptFile), userId: b.userId }));
  }

  /**
   * 計画を実行する。**1 件の失敗で残りを止めない** — 落ちたものは返信に理由つきで出る。
   * 起動は必ず「本文 → 専用のメンション 1 通」の 2 通 (src/mentions.js の sendControlMention の流儀)。
   */
  async function execute(bot, msg, plan, assignees) {
    const userIdOf = new Map(assignees.map((a) => [a.key, a.userId]));
    const newThreads = plan.actions.filter((a) => a.kind === 'new_thread').length;
    const original = { authorName: authorNameOf(msg), content: textOf(msg), url: msg.url ?? null };
    // 元の投稿から立てられるのは 1 本だけ (投稿 1 つにスレッド 1 つ)
    let starterUsed = msg.hasThread === true;
    const done = [];
    for (const action of plan.actions) {
      // 中継の行き先は最初から分かっている — 失敗しても返信でどのスレッドの話か辿れるように先に入れる
      const entry = {
        kind: action.kind, threadId: action.kind === 'route' ? action.threadId : null, assignee: action.assignee, error: null,
      };
      done.push(entry);
      try {
        let thread;
        let quote = original;
        if (action.kind === 'new_thread') {
          if (newThreads === 1 && !starterUsed) {
            // 今の直メンションと同じ形 — 起点の発言は担当側の fetchStarter が拾うので引用しない
            thread = await msg.startThread({ name: action.title });
            starterUsed = true;
            quote = null;
          } else {
            thread = await msg.channel.threads.create({ name: action.title });
          }
        } else {
          thread = await bot.client.channels.fetch(action.threadId);
          // 表は実行記録から組んでいるので通常は起きない — 別チャンネルのスレッドへは投げない
          if (!thread?.isThread?.() || thread.parentId !== msg.channel.id) {
            throw new Error('このチャンネルのスレッドではありません');
          }
          if (thread.archived) {
            // 戻せなくても投稿は試す (投稿で戻ることがある — 実機で確かめる。docs/notes/2026-10-11-intake.md)
            await thread.setArchived(false).catch((err) => {
              console.error(`[intake] スレッド ${thread.id} のアーカイブを戻せません: ${err.message}`);
            });
          }
        }
        entry.threadId = thread.id;
        await sendBody(thread, { body: handoffBody({ brief: action.brief, original: quote }) });
        await sendControlMention(thread, { userId: userIdOf.get(action.assignee) });
      } catch (err) {
        entry.error = err.message;
        console.error(`[intake msg:${msg.id}] ${action.kind} (${action.assignee}) に失敗: ${err.message}`);
      }
    }
    return done;
  }

  /**
   * 全体停止 (`/stop scope:all`・再起動・停止)。走っている受付を撃ち、積まれていた受付も走らせない。
   * @returns {number} 止めた受付の数 (走っている分 + 待っている分)
   */
  function abortAll() {
    generation++;
    for (const handle of live) {
      try { handle.abort(); } catch (err) { console.error(`[intake] 停止を伝えられませんでした: ${err.message}`); }
    }
    return inflight;
  }

  return { handlePost, abortAll, get inflight() { return inflight; } };
}
