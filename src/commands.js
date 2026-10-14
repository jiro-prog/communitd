// スラッシュコマンドの定義と、オプションの解釈 (純粋関数)。
// Discord への登録は src/bridge/discord.js、実行は src/interactions.js の責務 — ここは形と規則だけを持つ。

import { formatJst } from './time.js';

// ApplicationCommandOptionType (discord.js の enum 値。純粋モジュールに
// discord.js を持ち込まないため数値で書く)
const OPTION_STRING = 3;
const OPTION_BOOLEAN = 5;

export const STOP_SCOPES = ['this', 'all'];
export const DEFAULT_STOP_SCOPE = 'this';

/**
 * guild スコープで登録するコマンド一覧。
 * テキストトリガー (`stop` / `再起動` とだけ発言) の置き換えなので、
 * 認可・停止範囲・再起動の拒否条件は従来と同じ規則を引き継ぐ。
 */
export const SLASH_COMMANDS = [
  {
    name: 'stop',
    description: '実行中の job を止める (Claude Code の Esc 相当)',
    options: [
      {
        type: OPTION_STRING,
        name: 'scope',
        description: '停止範囲 (既定: このスレッドだけ)',
        required: false,
        choices: [
          { name: 'this — このスレッドの job だけ', value: 'this' },
          { name: 'all — 全スレッドの job', value: 'all' },
        ],
      },
    ],
  },
  {
    name: 'roster',
    description: 'このスレッドで呼べる bot を絞る (省略すると現在の編成を表示)',
    options: [
      {
        type: OPTION_STRING,
        name: 'members',
        description: 'bot キーを空白/カンマ区切りで (all=解除・none=誰も呼ばない)',
        required: false,
      },
    ],
  },
  {
    name: 'pause',
    description: '自律運転を止める (人間のメンションは通る・実行中の job も止めない)',
    options: [
      {
        type: OPTION_STRING,
        name: 'reason',
        description: '止める理由 (記録に残る)',
        required: false,
      },
    ],
  },
  {
    name: 'resume',
    description: '自律運転を再開する',
  },
  {
    // 裁定カードはスレッドの流れに埋もれる。数日待つ裁定を「見つけられない」で
    // 止めないため、一覧と再掲の入口を常設する (§3.9)
    name: 'proposals',
    description: '組織提案の一覧を出す (id を指定すると裁定カードを出し直す)',
    options: [
      {
        type: OPTION_STRING,
        name: 'id',
        description: '裁定カードを出し直す提案 ID (省略すると一覧)',
        required: false,
      },
      {
        // 再裁定で閉じられない提案 (手で転記済み・作り直した) の出口 (作者裁定 2026-09-04)。
        // **理由は必須** — withdrawn は終端なので、理由が残らないと同じ提案が再発議される
        type: OPTION_STRING,
        name: 'withdraw',
        description: 'その提案を取り下げる理由 (id と一緒に指定する。作者だけ)',
        required: false,
      },
    ],
  },
  {
    // 作者を呼んでいるものは停止通知・稟議・blocked の 3 系統に散っていて、
    // 「どこで何が止まっているか」を探すのにスレッドを巡る必要があった (§10)。
    // 入口を 1 つにする — 裁定だけが作者の仕事なら、その入口も 1 つであるべき
    name: 'inbox',
    description: '作者を待っているもの (停止・質問 / 稟議 / 要人間) を一覧する',
    options: [
      {
        type: OPTION_STRING,
        name: 'close',
        description: '手動で閉じる停止通知の id (別のスレッドで答えたとき)',
        required: false,
      },
    ],
  },
  {
    // review で止まったタスクは、契約が無いと誰も判定を返せない (判定を書けるのは
    // task-review 契約を持つ job だけ)。人間が起こす口が無いと #46 のように固着する
    name: 'review',
    description: 'review のまま止まったタスクのレビューを出し直す (タスクのスレッドで打つ)',
    options: [
      {
        type: OPTION_STRING,
        name: 'id',
        description: '対象のタスク id (省略するとこのスレッドのタスク)',
        required: false,
      },
    ],
  },
  {
    // 朝開いて 30 秒で「何が終わり・何が動き・何を決めるか」を掴む 1 通 (§11.5)。
    // 受信箱 (/inbox) は作者の手が要るものだけ、こちらはチャンネルの全体像。明示の照会だけで定時通知は無い
    name: 'status',
    description: 'このチャンネルの状況 (過去 24h の完了 / 進行中 / 復旧待ち / 判断待ち / 運転) を出す',
  },
  {
    // 止まった仕事 (verify NG 後の無実行・実行失敗・再起動で切れた job) を、同じスレッド・同じ
    // ブランチ・同じ作業ツリーの続きとして担当に起こし直す口 (§11.3)。これが無いと人間が
    // 内部契約やボードを修復してから担当をメンションするしかない
    name: 'retry',
    description: '止まったタスクを同じ仕事の続きとして起こし直す (タスクのスレッドで打つ)',
    options: [
      {
        type: OPTION_STRING,
        name: 'id',
        description: '対象のタスク id (省略するとこのスレッドのタスク)',
        required: false,
      },
    ],
  },
  {
    // 自律社会 (docs/society-ledger.md) を人が覗く / 手で起こす口。observe で回している間は
    // 「台帳に何が積まれているか」を読む手段がスレッドの流し読みしか無く、試行を始められない。
    // **サブコマンドではなく平らなオプション**にしてあるのは他の /コマンドと同じ流儀
    name: 'case',
    description: '自律社会の案件を見る / 開く / 相談を出す / 再開する (引数なしで進行中の一覧)',
    options: [
      {
        type: OPTION_STRING,
        name: 'id',
        description: '案件 id (単体で詳細・bot と一緒に指定すると相談を出す)',
        required: false,
      },
      {
        // 停止の解除は**明示の操作だけ** (§12.2 (g))。人間の発言では解除しないので、
        // 止めた案件を動かし直す口はここにしかない
        type: OPTION_STRING,
        name: 'resume',
        description: '停止を解除する案件 id (他のオプションとは併用できない)',
        required: false,
      },
      {
        type: OPTION_STRING,
        name: 'new',
        description: '案件を開く Mandate のキー (goal と acceptance も要る)',
        required: false,
      },
      {
        type: OPTION_STRING,
        name: 'goal',
        description: '望む状態 (new と一緒に指定する)',
        required: false,
      },
      {
        type: OPTION_STRING,
        name: 'acceptance',
        description: '受入条件 — 何が観測できたら終わりか (new と一緒に指定する)',
        required: false,
      },
      {
        type: OPTION_STRING,
        name: 'bot',
        description: '相談先の bot キー (id と一緒に指定する)',
        required: false,
      },
      {
        type: OPTION_STRING,
        name: 'responsibility',
        description: '引き受けてほしい責務 (既定: owner)',
        required: false,
        choices: [
          { name: 'owner — 案件の責任主体', value: 'owner' },
          { name: 'implementer — 実装', value: 'implementer' },
          { name: 'investigator — 調査', value: 'investigator' },
          { name: 'assessor — 検収', value: 'assessor' },
        ],
      },
      {
        type: OPTION_STRING,
        name: 'summary',
        description: '相談の要旨 (起動文に載る。bot と一緒に指定する)',
        required: false,
      },
    ],
  },
  {
    name: 'restart',
    description: 'ブリッジを再起動する (作業ツリーの現在のコードと .env を反映)',
    options: [
      {
        type: OPTION_BOOLEAN,
        name: 'force',
        description: '実行中・待機中の job を中断してでも再起動する (既定: false)',
        required: false,
      },
    ],
  },
];

/**
 * /stop の停止範囲を決める。
 * 未指定は this。スレッド外 (チャンネル直) には止める対象のスレッドが無いので
 * all に倒す — テキスト時代の「チャンネル直の stop = 全体停止」と同じ規則。
 *
 * @param {{scope?: string|null, inThread?: boolean}} p
 * @returns {{all: boolean, requested: string, fellBackToAll: boolean}}
 */
export function resolveStopScope({ scope = null, inThread = false } = {}) {
  const requested = STOP_SCOPES.includes(scope) ? scope : DEFAULT_STOP_SCOPE;
  const all = requested === 'all' || !inThread;
  return { all, requested, fellBackToAll: all && requested !== 'all' };
}

/** `/case` の責務。設定で決まる `authority` は手では立てない (config が決める担当) */
export const CASE_RESPONSIBILITIES = ['owner', 'implementer', 'investigator', 'assessor'];
export const DEFAULT_CASE_RESPONSIBILITY = 'owner';

/**
 * `/case` の引数から「何をするか」を決める (純粋関数)。
 *
 * 平らなオプションなので**組み合わせの検査はここで済ませる** — 足りない引数のまま
 * 台帳へ降ろすと、断り方が台帳の語 (`invalid` / `no-case`) になって人に読めない。
 *
 * @returns {{ok: true, request: {action: 'list'|'detail'|'new'|'offer'|'resume'}}|{ok: false, reason: string}}
 */
export function resolveCaseRequest(options = {}) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const id = text(options.id);
  const mandateKey = text(options.new);
  const goal = text(options.goal);
  const acceptance = text(options.acceptance);
  const botKey = text(options.bot);
  const summary = text(options.summary);
  const resumeId = text(options.resume);
  const responsibility = CASE_RESPONSIBILITIES.includes(options.responsibility)
    ? options.responsibility
    : DEFAULT_CASE_RESPONSIBILITY;

  if (resumeId !== '') {
    // **停止の解除は単独の操作**。同じ 1 回で相談まで出せると、解除は通ったが相談は
    // 出せなかったときに「いまどこまで動いたか」が読めない (new / offer と同じ理由)
    if (id !== '' || mandateKey !== '' || botKey !== '' || goal !== '' || acceptance !== '' || summary !== '') {
      return { ok: false, reason: 'resume は他のオプションと一緒に指定できません' };
    }
    return { ok: true, request: { action: 'resume', id: resumeId } };
  }
  if (mandateKey !== '') {
    // **開くのと相談は別の操作**。1 回の /case で両方やると、開けたが相談は出せなかった
    // ときに「どこまで進んだか」が読めない
    if (id !== '' || botKey !== '') return { ok: false, reason: 'new は id / bot と一緒に指定できません' };
    if (goal === '') return { ok: false, reason: 'new には goal (望む状態) が要ります' };
    if (acceptance === '') {
      return { ok: false, reason: 'new には acceptance (何が観測できたら終わりか) が要ります' };
    }
    return { ok: true, request: { action: 'new', mandateKey, goal, acceptance } };
  }
  if (botKey !== '') {
    if (id === '') return { ok: false, reason: 'bot に相談を出す案件の id も指定してください' };
    return { ok: true, request: { action: 'offer', id, botKey, responsibility, summary: summary || null } };
  }
  if (goal !== '' || acceptance !== '') {
    return { ok: false, reason: 'goal / acceptance は new (Mandate のキー) と一緒に指定してください' };
  }
  if (id !== '') return { ok: true, request: { action: 'detail', id } };
  return { ok: true, request: { action: 'list' } };
}

/**
 * 自律運転の現況を 1 行で書く。**いつ誰が止めたかを必ず含める** —
 * 「止まっている」だけだと、止めた人が居なくなった後に誰も解除の判断ができない。
 *
 * @param {object|null} entry PauseStore.current() の戻り (null = 動いている)
 */
export function formatPauseState(entry) {
  if (!entry) return '▶️ 自律運転は動いています';
  const at = formatJst(entry.at) ?? '時刻不明';
  const by = entry.by ? `<@${entry.by}>` : '誰か不明';
  const reason = String(entry.reason ?? '').trim();
  return `⏸ 自律運転は停止中 (${at} に ${by} が停止${reason ? ` / 理由: ${reason}` : ''})`;
}
