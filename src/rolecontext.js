// job ごとにブリッジが生成する「実行文脈」ブロック (純粋関数)。
//
// 役割ファイルに「この bot は read-only」「呼べるのは誰と誰」と書くと、
// config.json を変えた瞬間に role が嘘をつく。実際そうなった —
// codexSandbox を workspace-write へ上げても役割文は read-only を
// 主張したままで、モデルは書けるのに「書けません」と答えた (2026-08-01)。
//
// だから権限と編成の正本は config.json 側に一本化し、そこから毎回テキストを
// 起こして役割文の後ろへ差し込む。役割文が書くのは「どう振る舞うか」だけ。

import { basename } from 'node:path';
import { OBSERVE_ACTION_KINDS } from './society-policy.js';

/** 書込みとみなす claude ツール名 (プリセット・allowedTools のどちらでも同じ綴り) */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * パス限定の書込みルール。**`Edit(パス)` だけ**を見る。
 *
 * `Write(パス)` / `NotebookEdit(パス)` は `--allowedTools` に書いても claude が照合しない
 * (`src/toolrules.js:38-41` の実測)。数えると「書けます」と案内して実際には書けない。
 */
const PINNED_EDIT = /^Edit\s*\(/;

/** パス限定ルールを実行文脈に並べる上限 (超えた分は件数だけ出す — 契約ブロックに全件ある) */
const PINNED_LIST_MAX = 5;

/**
 * 書込みが起きないモード。`src/contract.js:READONLY_MODES` と同じ判断を持つ —
 * allowedTools に書込みツールがあっても plan では通らない。
 */
const READONLY_MODES = ['plan'];

/**
 * `--allowedTools` の照合を迂回するモード。**ここでは範囲を主張してはいけない。**
 *
 * `acceptEdits` は `Edit(パス)` の照合を丸ごと迂回する (実測 2026-08-02 / CLI 2.1.220 —
 * `src/contract.js:narrowForTouchSet` が touch 制限中に default へ狭めているのはこのため)。
 * `bypassPermissions` は権限確認そのものを飛ばす。どちらでも「一覧の外は拒否される」は嘘になる。
 */
const RULE_BYPASSING_MODES = ['acceptEdits', 'bypassPermissions'];

// 効いている編成の出所 → 実行文脈での呼び名 (src/roster.js の resolveEffectiveRoster)。
// 未設定 (null) はここに入れない — 「編成がある」と「起動中の bot が並んでいるだけ」は
// 別の意味で、文言だけでなく後続の注記の有無も変わる
const ROSTER_SOURCE_LABELS = {
  thread: 'このスレッドの編成',
  channel: 'チャンネル既定の編成',
};

/**
 * このランタイム × チャンネル設定でファイルを書けるか。
 *
 * codex (Sol) は sandbox が正本で allowedTools は効かない。逆に claude は
 * sandbox を持たず allowedTools **と permissionMode** が正本 — 同じ質問でも見る場所が
 * 違うので、判定をここへ集めて role 側に「自分がどちらのランタイムか」を書かせない。
 *
 * **裸のツール名だけを見ると touch 制限中に嘘をつく。** T6 の絞り込み
 * (`src/contract.js:narrowForTouchSet`) は裸の `Edit` を落として `Edit(./パス)` に
 * 置き換えるので、裸の綴りしか数えないと「読み取り専用」と出る。実際には列挙された
 * 既存ファイルを編集できるので、パス限定も書込みとして数える。
 *
 * **ただしパス限定と言えるのは `default` のときだけ。** allowedTools だけを見て
 * 「一覧の外は拒否される」と書くと、`plan` (実際は書けない) と `acceptEdits` /
 * `bypassPermissions` (実際は一覧の外も書ける) の両方で誤案内になる (sol 指摘 2026-08-03)。
 *
 * @returns {{canWrite: boolean, text: string}}
 */
export function describeWriteAccess({
  runtime, sandbox, allowedTools = [], permissionMode = 'default',
} = {}) {
  if (runtime === 'codex') {
    return sandbox === 'workspace-write'
      ? {
          canWrite: true,
          text: '書込み可 (codex sandbox = workspace-write)。'
            + '書けるのは作業ディレクトリ配下だけで、ネットワークは遮断されている',
        }
      : {
          canWrite: false,
          text: '読み取り専用 (codex sandbox = read-only)。ファイルを書けないので編集を約束しない',
        };
  }
  if (READONLY_MODES.includes(permissionMode)) {
    return {
      canWrite: false,
      text: `読み取り専用 (permissionMode: ${permissionMode} — 計画のためのモードで、`
        + '書込みツールが許可されていても通らない)。編集を約束しない',
    };
  }
  if (RULE_BYPASSING_MODES.includes(permissionMode)) {
    return {
      canWrite: true,
      text: `書込み可 (permissionMode: ${permissionMode})。`
        + '**このモードは allowedTools の照合を迂回する**ので、パス限定のルールが書かれていても'
        + '範囲は絞られていない — どのファイルを触ったかは自分で報告に挙げること',
    };
  }
  const granted = WRITE_TOOLS.filter((t) => allowedTools.includes(t));
  if (granted.length > 0) {
    return { canWrite: true, text: `書込み可 (${granted.join(' / ')} が許可されている)` };
  }
  const pinned = allowedTools
    .filter((r) => typeof r === 'string' && PINNED_EDIT.test(r.trim()))
    .map((r) => r.trim());
  if (pinned.length > 0) {
    const shown = pinned.slice(0, PINNED_LIST_MAX).map((r) => `\`${r}\``).join(' / ');
    const rest = pinned.length - PINNED_LIST_MAX;
    return {
      canWrite: true,
      text: `書込み可だがパス限定 (次の**既存ファイル**への Edit だけ): ${shown}`
        + (rest > 0 ? ` 他 ${rest} 件` : '')
        + '。新規作成と、この一覧の外のファイルはツール側で拒否される',
    };
  }
  return {
    canWrite: false,
    text: '読み取り専用 (書込みツールが許可されていない)。編集を約束しない',
  };
}

/**
 * このランタイムで subagent (Agent ツール) を使えるか。
 *
 * **claude では allowedTools を見ない。** `--allowedTools` は許可リストではなく追加許可で、
 * `Agent` はそこに書かなくても起動する (T0 実測 6.3 / 再実測 2026-08-02: `--allowedTools Read`
 * だけの job で `Agent` が呼ばれ、拒否もされなかった)。だから「toolsExtra に書いたチャンネル
 * だけ使える」と書くと、実行文脈が事実と食い違う。
 *
 * **「権限を超えない」とは書かない。** 組み込みの subagent は親の allowedTools に縛られる
 * (T0 実測 6.3b) が、**custom subagent 定義は信頼境界を動かす** — `permissionMode` は親の
 * mode 次第で上書きが通り (実測 2026-08-02: 親 `--permission-mode default --allowedTools
 * Read` の下で `permissionMode: acceptEdits` の定義が Write に成功)、`hooks` は任意コマンドの
 * 実行経路になり、`mcpServers` は親に無いツールと外部接続を足し、`memory` は cwd 外へ書ける
 * 永続領域と Read/Write/Edit を付け、`isolation: worktree` は別ツリーで動かす。
 * 読み込み元も cwd 配下に限らない。個別フィールドの列挙では追随しきれないので、
 * 文面は「定義次第で変わりうる」までを言う。境界の詳細は docs/reference/security-model.md。
 *
 * **canUse はランタイムの能力**であって保証ではない。claude 側 settings
 * (user / project / managed) の `permissions.deny: ["Agent"]` で実際には使えないことがある。
 * ブリッジはその settings を置換しないので (T0 実測 2b)、文面もそこまでしか主張しない。
 *
 * @returns {{canUse: boolean, text: string}}
 */
export function describeSubagentAccess({ runtime } = {}) {
  if (runtime === 'codex') {
    return { canUse: false, text: '使えない (codex ランタイムに subagent は無い)' };
  }
  return {
    canUse: true,
    text: '使える (Agent ツール — ブリッジ側では無効化していない。claude 側 settings の deny が'
      + 'あればそちらが優先)。組み込みの subagent はこの job と同じ権限・同じ作業ディレクトリで'
      + '動くが、**custom subagent 定義 (agent 定義ファイル) は権限・使えるツール・作業場所・'
      + '永続状態を変え、hook による別の実行経路も持ちうる**。'
      + '自分が書いた実装の検収には使わない (同じセッションの延長なので自己検証になる)',
  };
}

/**
 * 呼べる相手に添える「何の役か / どのランタイムか」。
 *
 * **役割文から固有名詞を外した以上、対応表はここにしか無い。** 役割文は
 * 「reviewer 役を呼ぶ」「codex ランタイムには touch 制限つき委譲を渡せない」と書くので、
 * どの bot がそれに当たるかを実行文脈が示さないと宛先が決まらない。
 *
 * 役は `rolePromptFile` の basename (`roles/worker.md` → `worker`)。**表示名とは別軸**で、
 * 同じ役割文を共有する 2 体 (worker が 2 人) も同じ役として出る。
 * runtime は claude のとき省略する — 既定の側を全 job の system prompt に載せない。
 */
function peerTraits(peer = {}) {
  const traits = [];
  const file = typeof peer.rolePromptFile === 'string' ? peer.rolePromptFile.trim() : '';
  if (file !== '') traits.push(basename(file).replace(/\.[^.]+$/, ''));
  if (peer.runtime && peer.runtime !== 'claude') traits.push(peer.runtime);
  return traits.length > 0 ? ` (${traits.join(', ')})` : '';
}

/**
 * 実行文脈ブロックを組み立てる。
 *
 * peers には**自分も含めて**渡してよい (自分は呼べる相手から落とす)。
 * userId が無い bot は「設定はあるが今は起動していない」— 呼んでも
 * src/mentions.js に弾かれるので、呼べる相手には出さず別行で知らせる。
 *
 * @param {object} ctx
 * @param {string} ctx.selfKey 自分の bot キー
 * @param {string} [ctx.displayName]
 * @param {string} [ctx.runtime] 'claude' | 'codex'
 * @param {string} [ctx.channelName]
 * @param {string} [ctx.cwd]
 * @param {string} [ctx.sandbox] codex の sandbox
 * @param {string[]} [ctx.allowedTools] claude の allowedTools
 * @param {string} [ctx.permissionMode] claude の**実効** permissionMode
 *        (touch 制限中は絞り込み後の値。src/bridge/job.js が claudeOpts へ渡すものと同じ)
 * @param {Array<{key: string, displayName?: string, userId?: string|null, inRoster?: boolean,
 *                rolePromptFile?: string|null, runtime?: string}>} [ctx.peers]
 *        inRoster: false = この job で効いている編成から外されている (src/roster.js)。
 *        rolePromptFile / runtime は呼べる相手の「何の役か」を出すのに使う (peerTraits)
 * @param {number} [ctx.maxSelfHops] 連続自己呼び出しの上限 (0 = 使えないので行を出さない)
 * @param {boolean} [ctx.structuredOutput] 構造化出力 (委譲契約・報告様式) が有効か。
 *        false のときだけ 1 行出す — CLI の `--json-schema` を落としても、役割文に残る
 *        「スキーマで検査する」「報告様式に分ける」は消えないので、正本であるここで
 *        打ち消さないとモデルは報告調のまま返す (sol 指摘 2026-08-14)
 * @param {'thread'|'channel'|null} [ctx.rosterSource] 効いている編成の出所
 *        (resolveEffectiveRoster の source)。**boolean にしない** — 実行文脈は「正本」として
 *        提示されるので、チャンネル既定を「このスレッドの編成」と書くと共通規定の解釈
 *        (作者が /roster で設定したもの) と食い違う (sol 指摘 2026-08-14)
 * @param {{userId?: string, names?: string[]}|null} [ctx.owner]
 * @param {string|null} [ctx.handoffFile] 引き継ぎ文書の相対パス (作業ディレクトリ基準)。
 *        **その場にファイルがあるときだけ**ブリッジが渡す — スレッドをまたいで
 *        「現在地」を運ぶのはこの 1 通ではなく文書の側で、実行文脈はその在り処を指すだけ。
 *        置いていないプロジェクトへ「読め」と案内しないよう、判定は呼び出し側 (fs) が持つ
 * @returns {string}
 */
/**
 * 案件に結ばれた job の実行文脈。
 *
 * **決定権者と自分の Claim の世代をここに書く。** 世代は「いま自分が確定操作をしてよいか」の
 * 根拠で、交代が済んだ後の遅い応答は台帳が弾く — その理由をモデル側にも見せておく。
 * 次の起動を `next.plan` に限るのもここで言う (自由文の `[[handoff:]]` は Action にならない)。
 *
 * @param {object|null} societyCase `{caseId, desiredOutcome, authority, claimId, claimGeneration,
 *   responsibility, actionId, actionKind, mode}`
 */
function describeCase(societyCase) {
  if (!societyCase || typeof societyCase !== 'object') return [];
  const {
    caseId, desiredOutcome, authority, claimId, claimGeneration, responsibility,
    actionId, actionKind, mode,
  } = societyCase;
  if (!caseId) return [];
  const lines = [
    `- 案件: \`${caseId}\`${desiredOutcome ? ` — ${desiredOutcome}` : ''}`
      + `${mode ? ` (society.mode: ${mode})` : ''}`,
  ];
  if (mode === 'observe') {
    // 門はブリッジ側にあるが (`src/bridge/society.js`)、**断られる理由は先に見せる** —
    // 書いてから「起こしませんでした」と返されるより、書く前に分かる方が job 1 本ぶん安い
    lines.push(
      `  - **observe で起こせる Action は ${OBSERVE_ACTION_KINDS.map((k) => `\`${k}\``).join(' / ')} だけ。**`
      + ' それ以外を `next.plan` に書くと Action は作られず、案件は人間待ち (waiting(authority)) になる',
    );
  }
  if (authority) {
    lines.push(
      `  - 決定権者: \`${authority}\` — 案件の裁定 (受入条件の変更・終結) はこの担当が決める。`
      + '判断を仰ぐなら本文でそう書く',
    );
  }
  if (claimId) {
    lines.push(
      `  - あなたの引受け: \`${claimId}\`${responsibility ? ` (${responsibility})` : ''}`
      + `${Number.isSafeInteger(claimGeneration) ? ` / 世代 ${claimGeneration}` : ''} — `
      + '**この世代でなくなった後の応答は確定に使われない** (交代・辞退の後の遅い戻りは証拠として残るだけ)',
    );
  }
  if (actionId) {
    lines.push(`  - この起動: \`${actionId}\`${actionKind ? ` (${actionKind})` : ''}`);
  }
  lines.push(
    '  - **次の起動は `next.plan` に書く。** 案件付きの job では本文の `[[handoff:...]]` は'
    + '無視される (台帳を通らない起動は作らない) — 待つなら `next.waiting` を書く',
  );
  return lines;
}

export function buildRuntimeContext({
  selfKey,
  displayName,
  runtime = 'claude',
  channelName,
  cwd,
  sandbox,
  allowedTools = [],
  permissionMode = 'default',
  peers = [],
  rosterSource = null,
  structuredOutput = true,
  maxSelfHops = 0,
  owner = null,
  handoffFile = null,
  societyCase = null,
} = {}) {
  const access = describeWriteAccess({ runtime, sandbox, allowedTools, permissionMode });
  const subagents = describeSubagentAccess({ runtime });
  const others = peers.filter((p) => p?.key && p.key !== selfKey);
  const offRoster = others.filter((p) => p.inRoster === false);
  const onRoster = others.filter((p) => p.inRoster !== false);
  const callable = onRoster.filter((p) => p.userId);
  const offline = onRoster.filter((p) => !p.userId);

  const lines = [
    '# 実行文脈 (ブリッジが job ごとに生成)',
    '',
    'ここに書かれた事実が正本。前段の共通規定・役割文と食い違ったら、こちらを信じる。',
    '',
    `- あなた: ${displayName || selfKey} (bot キー \`${selfKey}\`) / ランタイム: ${runtime}`,
  ];
  if (channelName) lines.push(`- チャンネル: \`${channelName}\``);
  if (cwd) lines.push(`- 作業ディレクトリ: \`${cwd}\``);
  // 引き継ぎ。**スレッドは毎回切れるが、プロジェクトの現在地は続いている** —
  // 「次に進めて」の一言で始められるようにするための在り処
  if (handoffFile) {
    lines.push(
      `- 引き継ぎ: \`${handoffFile}\` — このプロジェクトの現在地・次にやること・裁定待ち。`
      + '**着手前に読み、区切りがついたら更新する**',
    );
  }
  lines.push(`- ファイル権限: ${access.text}`);
  lines.push(`- subagent: ${subagents.text}`);
  // 有効なときは書かない。役割文が既に説明しているうえ、既定側に行が増えると
  // 全 job の system prompt が太る (切ったチャンネルだけが例外的な状態)
  if (structuredOutput === false) {
    lines.push(
      '- 構造化された応答: **このチャンネルでは無効**。役割文の schema 宣言と報告様式'
        + ' (やったこと / 検証結果 / 残課題) の指示は効かないので、**プレーンテキストで返す** —'
        + ' 成果物へ向かわない場なので、報告調にしない',
    );
  }

  // 案件に結ばれた job。**この job が誰の何のために
  // 走っているか**と、次の一手をどこへ書くかを実行文脈で示す。案件が無い job では 1 行も出さない
  lines.push(...describeCase(societyCase));

  // 編成が設定されているスレッドでは、外された bot はここに出さないうえに送信側でも
  // 弾かれる (src/roster.js・src/mentions.js)。設定が無いスレッドでは「呼べる」=
  // プロセス全体でログイン済みの bot でしかないので、作者がスレッドで口頭指定した編成の
  // 方が上位だと明示して取り違えを防ぐ (sol 指摘 2026-08-01)。
  //
  // 出所を書き分けるのは、チャンネル既定 (config.json) を「このスレッドの編成」と
  // 名乗ると `/roster` で設定した覚えのない編成が正本として出てしまうため
  const rosterLabel = ROSTER_SOURCE_LABELS[rosterSource] ?? null;
  lines.push(
    callable.length > 0
      ? `- 呼べる相手 (${rosterLabel ?? 'いま起動している bot'}): `
        + callable.map((p) => `\`[[handoff:${p.key}]]\` ${p.displayName || p.key}${peerTraits(p)}`).join(' / ')
      : '- 呼べる相手: いない (このターンで完結させ、必要なら作者へ返す)',
  );
  if (callable.length > 0 && !rosterLabel) {
    lines.push(
      '  - これは技術的に届く宛先の一覧で、このスレッドの編成ではない。'
        + '作者がスレッドで「今回は誰を使う / 誰は呼ばない」と指定していたら、そちらが優先する',
    );
  }
  if (offRoster.length > 0) {
    lines.push(
      `- ${rosterLabel ?? '編成'}から外れている: ${offRoster.map((p) => p.displayName || p.key).join(' / ')}`
        + ' (呼んでも起動しない — 担当分は自分で引き受けるか作者へ返す)',
    );
  }
  if (offline.length > 0) {
    lines.push(
      `- いま起動していない: ${offline.map((p) => p.displayName || p.key).join(' / ')} (呼んでも届かない)`,
    );
  }
  // 切ってあるチャンネル (maxSelfHops: 0) では行ごと出さない。「使えない」と書くと
  // 存在だけ教えることになるうえ、全 job の system prompt が 1 行ずつ太る。
  // 編成から自分が外されているスレッドでも呼べない (送信側の allowlist は自分にも
  // 効く — src/mentions.js) ので、そこでも出さない
  const selfOnRoster = peers.find((p) => p?.key === selfKey)?.inRoster !== false;
  if (maxSelfHops > 0 && selfOnRoster) {
    lines.push(
      `- 自己呼び出し: \`[[handoff:${selfKey}]]\` で自分をもう一度起動できる`
        + ` (連続 ${maxSelfHops} 回まで・人間が発言すると戻る)。使いどころは共通規定`,
    );
  }
  lines.push(
    owner?.userId
      ? `- 作者への通知: \`[[notify:owner]]\` (${owner.names?.[0] || 'owner'})`
      : '- 作者への通知: 使えない (ownerUserId が未設定)',
  );

  return lines.join('\n');
}
