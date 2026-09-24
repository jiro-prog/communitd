// 委譲契約と報告の構造化 (T6) — スキーマ定義・検証・touch 集合の実権限への変換。
//
// **このモジュールは fs も CLI も Discord も触らない** (src/config.js と同じ理由で、
// 判定をテストから直接叩けるようにする)。唯一の例外はパス実体の確認で、それは
// src/toolrules.js の describePathRule に委ねてある — 承認候補の判定と同じ規則を
// 使わないと「候補には出ないのに touch 集合では通る」がすぐ起きる。
//
// ## なぜ構造化するのか
//
// roles/worker.md は依頼ブロックを「契約の正本」と呼ぶが、それをパースするコードは
// 無かった。touch 集合は規律であって制約ではなく、受入基準は誰も検査していない。
// `--json-schema` で最終出力を拘束すれば、touch 集合を**実際の権限**へ変換できる。
//
// ## 二層にしない (T0 実測による設計変更)
//
// 当初案は「result (散文) を投稿し、structured_output を別に受け取る」だったが、
// 実測で **`--json-schema` を渡すと `result` は structured_output と同じ
// JSON 文字列になる**ことが分かった。散文の置き場が無いので、**両スキーマに必須の
// `本文` を持たせ、Discord へはそれを投稿する** (作者裁定 2026-08-02)。
// 制御フッターも `本文` の末尾に置かれるので、投稿テキスト側で従来どおり発火する。
//
// ## touch 制限は「絞る」ことしかしない
//
// 契約が権限を**増やせる**経路を作ると、validateConfig の fail-closed を迂回する
// 第二の権限経路になる。だから変換の入力は必ずチャンネルの実効権限で、出力は
// その部分集合。元が読み取り専用なら touch 集合を書いても書込みは付かない。

import { WAITING_REASONS } from './cases.js';
import { PROPOSAL_KINDS, REMEDIES, TARGET_OPS } from './proposals.js';
import { describePathRule } from './toolrules.js';

/** role ファイルが宣言できるスキーマ種別 */
export const CONTRACT_KINDS = [
  'delegation', 'report', 'task-proposal', 'task-approval', 'task-review', 'case-turn',
];

/**
 * role ファイルの先頭に置く宣言 (プロトコル版マーカーと同じ流儀)。
 * 種別名にはハイフンを許す (`task-proposal`) — 知らない綴りは CONTRACT_KINDS 側で落ちる。
 */
const KIND_MARKER = /<!--\s*communitd-schema:\s*([a-z-]+)\s*-->/;
/** マーカーを探す範囲 (先頭のみ。本文中の言及を拾わない) */
const HEAD_CHARS = 400;

/**
 * role テキストが宣言しているスキーマ種別。
 * **宣言が無ければ null = 構造化しない** (その job は完全に従来どおり動く)。
 * bot キーで分岐しないのは、担当の入れ替えでコードを触らずに済ませるため。
 */
export function readContractKind(text) {
  const m = KIND_MARKER.exec(String(text ?? '').slice(0, HEAD_CHARS));
  if (!m) return null;
  return CONTRACT_KINDS.includes(m[1]) ? m[1] : null;
}

/**
 * この job で実際に使うスキーマ種別。役割文の宣言に**チャンネル設定とランタイムを重ねた**結果。
 *
 * 宣言があっても null になる経路が 2 つある:
 * - codex は `--json-schema` を持たない
 * - チャンネルが `structuredOutput: false` で切っている (成果物へ向かわない場)
 *
 * 判断を index.js に置くとテストが書けないので、ここへ集める
 * (判断ロジックは配線層に書かない)。
 *
 * `override` は**その 1 job だけ種別を差し替える**口 (スカウト job が使う —
 * 同じ bot の通常の役割のまま、その job の応答だけ task-proposal で検査したい)。
 * **もともと構造化する job にしか乗らない**: 宣言の無い bot や structuredOutput を
 * 切ったチャンネルで構造化が始まると、「宣言が無ければ完全に従来どおり」が破れる。
 * 上書きの寿命と保管は呼び出し側の責任 (ここは種別の優先順位だけを決める)。
 *
 * @param {object} p
 * @param {string} [p.roleText] その bot 自身の役割文 (共通規定ではない)
 * @param {string} [p.runtime]
 * @param {boolean} [p.structuredOutput] resolveStructuredOutputEnabled(cc) の結果
 * @param {string|null} [p.override] この job だけ使う種別 (知らない綴りは宣言へ倒す)
 */
export function resolveContractKind({
  roleText, runtime = 'claude', structuredOutput = true, override = null,
} = {}) {
  if ((runtime ?? 'claude') === 'codex') return null;
  if (structuredOutput === false) return null;
  const declared = readContractKind(roleText);
  if (!declared || !override) return declared;
  return CONTRACT_KINDS.includes(override) ? override : declared;
}

/**
 * フィールド名 → 人間向けの呼び名。
 *
 * **スキーマのキーは ASCII でなければならない** (実測 2026-08-02: 日本語のプロパティ名を
 * 渡すと API が `400 tools.*.custom.input_schema.properties: Property keys should match
 * pattern` を返し、構造化出力そのものが返らない)。裁定は「必須の `本文` を持たせ、
 * Discord にはそれを投稿する」という**意味**なので、そちらは保ったままキーだけ ASCII にし、
 * 人間が読む面 (役割文・契約ブロック・エラー文) はこの表で日本語に戻す。
 */
export const FIELD_LABELS = {
  body: '本文',
  background: '背景',
  purpose: '目的',
  touch_set: 'touch集合',
  acceptance: '受入基準',
  stop_conditions: '停止条件',
  touch_restricted: 'touch制限',
  changed_files: '変更ファイル',
  did: 'やったこと',
  verification: '検証結果',
  remaining: '残課題',
  tasks: '起票するタスク',
  title: 'タイトル',
  rationale: '理由',
  touch: 'touch集合',
  job_budget: 'job予算',
  approve: '承認',
  drop: '破棄',
  pending: '承認待ちのタスク',
  board: 'ボードの現状',
  state: '状態',
  id: 'id',
  reason: '破棄の理由',
  target: 'レビュー対象',
  verdict: '判定',
  branch: 'ブランチ',
  merge_commit: 'マージコミット',
  adjudication: '組織提案の裁定',
  proposal_id: '提案 ID',
  decision: '採否',
  // 発議。**キー名は src/proposals.js の INPUT_KEYS と同じ綴り**にしてある —
  // 検証を通った値をそのまま ProposalStore.raise() へ渡すので、ここで名前を変えると
  // 契約とゲートの間に翻訳層が要る (翻訳層は綴りの取り違えを黙って通す)
  // 案件の 1 ターン。**bot の自由文を権限の根拠にしない**
  // ための欄で、ここに書いたものだけが台帳へ写る
  result: '成果',
  artifact: '成果物',
  observed: '観測した事実',
  claimed: '主張',
  next: '次の一手',
  plan: '次の action',
  waiting: '待ち条件',
  condition: '条件',
  why: '待つ理由',
  summary: '要旨',
  claim: '引受けの返事',
  scope: '範囲',
  finding: '気づき',
  expected: '望む状態',
  actual: '実際',
  subject_id: '対象 ID',
  condition_id: '観測条件 ID',
  initiative: '発議',
  kind: '種別',
  targets: '対象',
  duty: '職務',
  // summary は案件の 1 ターン側 (上) と同じ綴り・同じ訳語なので、ここには書かない
  evidence: '根拠',
  remedy: '直し先',
  change: '変更案',
  diff: 'diff',
  benefits: '利点',
  risks: 'リスク',
  cost: 'コスト',
  trial: '試用',
  deadline: '期限',
  successCriteria: '成功条件',
  rollback: 'ロールバック',
  botKey: 'bot キー',
  slug: 'slug',
  dutyKey: 'duty キー',
  op: '操作',
  channel: 'チャンネル',
  tool: 'ツール',
  pointer: 'pointer',
  doc: '文書',
  path: 'パス',
  taskId: 'タスク id',
};

/**
 * レビューの判定。この 4 値以外は検査で落とす。
 *
 * `drop` は後から足した「対象が不要」の判定。無かった頃は、重複と分かったタスクを
 * 落とす言葉が無く、契約を消費して判定なしで終わっていた (#46 が review で 2 時間 40 分)。
 */
export const REVIEW_VERDICTS = ['merge', 'send-back', 'block', 'drop'];

/**
 * 契約を保存するときの内部ラベル (配信ステップの名前・ログに出る)。
 * 種別が増えたのに二択のままだと、起票や承認まで「報告の保存」と記録される。
 */
export function contractSaveLabel(kind) {
  return Object.hasOwn(SAVE_LABELS, kind) ? SAVE_LABELS[kind] : '契約の保存';
}

const SAVE_LABELS = {
  delegation: '委譲契約の保存',
  report: '報告の保存',
  'task-proposal': '起票の保存',
  'task-approval': '承認の保存',
  'task-review': 'レビュー依頼の保存',
  'case-turn': '案件の記録の保存',
};

const label = (key) => FIELD_LABELS[key] ?? key;

/**
 * 1 フィールドの上限 (Discord とプロンプトの両方を壊さないための安全弁)。
 *
 * **超えたら黙って切らずに不適合にする。** `slice()` していた頃は、本文の末尾に置いた
 * 制御フッターが切り落とされて **handoff が黙って消えた** (sol 指摘 2026-08-03)。
 * スキーマ側にも同じ上限を書いてあるので、モデルは生成時点で守れる。
 */
export const MAX_TEXT_CHARS = 6000;
export const MAX_ITEMS = 100;
export const MAX_ITEM_CHARS = 1000;
/** 報告の「やったこと」は 3 件以内 (roles/worker.md の様式そのまま) */
export const MAX_DID_ITEMS = 3;

/**
 * 1 回のスカウトが起票できるタスクの上限。
 * **0 件も正しい報告** (「今回は起票なし」) なので下限は無い。上限があるのは、
 * 1 回の巡回で承認待ちの山を作らせないため — 溜まった分は承認側の負担になる。
 */
export const MAX_PROPOSED_TASKS = 5;

/**
 * 1 発議が指せる対象の数 (`targets[]`)。
 * 異動や兼務解消は複数の bot にまたがるので 1 件には縛れないが、
 * 数十を一度に動かす提案は 1 回の裁定で読める大きさを超えている。
 */
export const MAX_TARGETS = 20;

/**
 * `change.diff` の上限。**本文 (MAX_TEXT_CHARS) より広い。**
 * あちらは Discord へ出す面の都合で決まった値だが、diff は機械が読んで適用する側で
 * 表示には出ない — 同じ上限を当てると、正しい role 差分が長さだけで落ちる。
 */
export const MAX_DIFF_CHARS = 20000;

/**
 * 文字列配列フィールドの共通形 (JSON Schema 側)。
 * maxItems は説明文と食い違わせない — 「3 行以内」と書いたのに 100 件通ると、
 * 検査しているつもりで検査していないことになる (sol 指摘 2026-08-03)。
 */
const stringArray = (description, maxItems = MAX_ITEMS) => ({
  type: 'array',
  items: { type: 'string', maxLength: MAX_ITEM_CHARS },
  maxItems,
  description,
});

/** 散文フィールドの共通形 */
const prose = (description) => ({ type: 'string', maxLength: MAX_TEXT_CHARS, description });

/**
 * `--json-schema` へ渡すスキーマ。
 *
 * `本文` が先頭にあるのは、これが**人間が読む唯一のフィールド**だから。
 * 制御フッター ([[handoff:...]] / [[notify:owner]]) もここへ書く — 別フィールドに
 * 分けると、フッターの抽出とマーカーの無害化を 2 か所で持つことになる。
 */
export const SCHEMAS = {
  delegation: {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'background', 'purpose', 'touch_set', 'acceptance', 'stop_conditions'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '相手を呼ぶ制御フッター ([[handoff:...]] / [[notify:owner]]) はこの末尾の独立行に置く',
      ),
      background: prose('背景 — なぜこの作業が要るのか'),
      purpose: prose('目的 — 何ができれば完了か'),
      touch_set: stringArray(
        'touch 集合 — 触ってよいファイルの相対パス (作業ディレクトリ基準)。'
        + 'ディレクトリ・ワイルドカードは使えない — 1 ファイルずつ書く',
      ),
      acceptance: stringArray('受入基準 — 満たすべき条件。**コマンドとして実行されることはない**'),
      stop_conditions: stringArray('停止条件 — ここに当たったら実装を止めて返す'),
      touch_restricted: {
        type: 'boolean',
        description:
          'touch 制限 — 省略時は true。true にすると受け手の書込み権限が touch_set の'
          + 'ファイルだけに絞られる。どこを直すか分からない探索的な依頼のときだけ false にする',
      },
    },
  },
  report: {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'changed_files', 'did', 'verification', 'remaining'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '制御フッターはこの末尾の独立行に置く',
      ),
      changed_files: stringArray('変更ファイル — この job で変更したファイルの相対パス'),
      did: stringArray('やったこと — 3 件以内', MAX_DID_ITEMS),
      verification: prose('検証結果 — 実行したコマンドと結果'),
      remaining: stringArray('残課題 — 要実機確認の項目を含む。無ければ空配列'),
      // 組織提案の裁定。**bot が裁定できるのは work / process だけ**で、
      // 権限判定はブリッジの canAdjudicate が持つ — ここに書けたから通るのではない
      adjudication: {
        type: 'object',
        additionalProperties: false,
        required: ['proposal_id', 'decision', 'rationale'],
        description:
          '組織提案の裁定 — 裁定を任されている bot だけが書く (裁定しないなら丸ごと省く)。'
          + 'work / process が対象で、org は作者の裁定 UI が正本なのでここには書けない',
        properties: {
          proposal_id: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '裁定する提案の ID' },
          decision: {
            type: 'string',
            enum: ['accepted', 'rejected'],
            description: '採否 — accepted なら task 化へ進み、rejected は終端になる',
          },
          rationale: prose('裁定理由 — 記録に残る。自分の起草分を裁定するときも必ず書く'),
        },
      },
      // 発議 (3 経路のうち (1))。**任意** — 全 report に提案や
      // 「問題なし」の作文を書かせない。見落としはイベントと定期巡回が補う。
      // ここに書けたから通るのではなく、保存の可否は checkProposal (src/proposals.js)
      // が決める。class・subjectKeys・追跡責任者はブリッジが付与するので書けない
      initiative: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'targets', 'duty', 'summary', 'evidence', 'remedy', 'change',
          'benefits', 'risks', 'cost'],
        description:
          '発議 — 担当領域について「望ましい状態との乖離」を見つけたときだけ書く (無ければ丸ごと省く)。'
          + '**採否はここでは決まらない**: work / process は経営裁量の bot が、'
          + 'role・権限・編成・予算を動かす org は作者が裁定する',
        properties: {
          kind: {
            type: 'string',
            enum: [...PROPOSAL_KINDS],
            description:
              '種別 — これで裁定権 (work / process / org) が決まる。'
              + '役割・duty・権限・編成・予算を動かすものは必ず org 側の kind になる',
          },
          targets: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_TARGETS,
            description:
              '対象 — kind ごとに形が決まっている構造化された対象指定。'
              + '**キー文字列は組み立てない** (subjectKeys はブリッジが作る)。'
              + 'role-* は botKey か slug、duty-edit は botKey + dutyKey + op、'
              + 'tool-grant は channel + tool + op、policy-edit は pointer + op、'
              + 'governance-edit / process-edit は doc、check-add / tooling-add は path、'
              + 'work-item は taskId か path',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [],
              properties: {
                botKey: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '対象 bot のキー' },
                slug: {
                  type: 'string',
                  maxLength: MAX_ITEM_CHARS,
                  description: '新設 bot の slug — 英小文字・数字・- だけ',
                },
                dutyKey: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '対象 duty のキー' },
                op: {
                  type: 'string',
                  enum: [...TARGET_OPS],
                  description: '操作 — add は対象が不在、edit / remove は実在が要る',
                },
                channel: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '対象チャンネル名' },
                tool: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '対象ツール名' },
                pointer: {
                  type: 'string',
                  maxLength: MAX_ITEM_CHARS,
                  description: 'policy の位置 — RFC 6901 の JSON pointer (例 /bots/sol/duties/review)',
                },
                doc: {
                  type: 'string',
                  maxLength: MAX_ITEM_CHARS,
                  description: '対象文書のリポジトリ相対パス (POSIX 区切り・`./` なし)',
                },
                path: {
                  type: 'string',
                  maxLength: MAX_ITEM_CHARS,
                  description: '対象ファイルのリポジトリ相対パス (POSIX 区切り・`./` なし)',
                },
                taskId: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードのタスク id' },
              },
            },
          },
          duty: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description: '職務 — この発議が自分のどの duty から出たのか',
          },
          summary: prose('要旨 — 何がどうなっているので何をしたいのか'),
          evidence: stringArray(
            '根拠 — 観測した事実 (件数・滞留時間・具体的な出来事)。'
            + '**心当たりではなく観測**を書く。裁定する側はここを見る',
          ),
          remedy: {
            type: 'string',
            enum: [...REMEDIES],
            description:
              `直し先 — 並列の選択肢ではなく ${REMEDIES.join(' > ')} の序列で選ぶ。`
              + '検査器やツールで強制できるものを role の文面に書かない '
              + '(文面を増やすのがいちばん安いので、放っておくとそこへ寄る)',
          },
          change: {
            type: 'object',
            additionalProperties: false,
            required: ['touch', 'diff'],
            description: '変更案 — 自由文の草案ではなく、適用側と裁定側が同じ文字列を見る機械可読形',
            properties: {
              touch: {
                type: 'array',
                items: { type: 'string', maxLength: MAX_ITEM_CHARS },
                minItems: 1,
                maxItems: MAX_ITEMS,
                description:
                  'touch 集合 — diff が触るファイルのリポジトリ相対パス。'
                  + 'diff のヘッダと**完全に一致**していなければ保存前に拒否される',
              },
              diff: {
                type: 'string',
                maxLength: MAX_DIFF_CHARS,
                description:
                  'diff — 通常ファイルの text の create / edit / delete だけ。'
                  + '**全体置換の草案は受け付けない** (原文に後から入った変更を黙って巻き戻すため)。'
                  + 'rename・binary・mode 変更・symlink は拒否される',
              },
            },
          },
          benefits: stringArray('利点 — 通ったら何が良くなるのか'),
          risks: stringArray('リスク — 通ったら何が悪くなりうるのか。空にしない'),
          cost: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description: 'コスト — 実施に要る手間 (job 数・人の確認・移行作業)',
          },
          trial: {
            type: 'object',
            additionalProperties: false,
            required: ['deadline', 'successCriteria', 'rollback'],
            description:
              '試用 — **org と process では必須**。期限が無いと「期限切れを放置して'
              + '仮配置を恒久化させない」監視そのものが書けない。work では省いてよい',
            properties: {
              deadline: {
                type: 'string',
                maxLength: MAX_ITEM_CHARS,
                description: '期限 — ISO 8601 の日時 (例 2026-09-30T00:00:00Z)',
              },
              successCriteria: prose('成功条件 — 何が観測できたら効果ありとするのか'),
              rollback: prose('ロールバック — 効果が無かったときに何をどう戻すのか'),
            },
          },
        },
      },
    },
  },
  // 案件の 1 ターン。案件に結ばれた job の戻り。
  //
  // **bot の自由文を権限の根拠にしない。** 台帳へ写るのはこの欄に書かれたものだけで、
  // 本文に「次は opus へ」と書いても Action にはならない (次の起動は `next.plan` だけ)。
  // 逆に、ここへ書けたから通るのでもない — 遷移の可否は `src/cases.js` が決める。
  'case-turn': {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'next'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '**次の起動をここに書いても効かない** (制御フッターは案件付きの job では使わない — next.plan を使う)',
      ),
      result: {
        type: 'object',
        additionalProperties: false,
        required: ['observed'],
        description:
          '成果 — この job で分かったこと (無ければ丸ごと省く)。'
          + '**観測と主張を分ける** — 検収は observed にだけ結ばれる',
        properties: {
          artifact: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description:
              '成果物 — commit OID・task の id など、検収できる形の指し先。'
              + '**これを書くと案件は検収待ち (verifying) へ進む**ので、検収してほしいときだけ書く',
          },
          observed: stringArray(
            '観測した事実 — 実行して確かめたものだけ (コマンドの結果・件数・OID)。'
            + '確かめていないことは claimed へ',
          ),
          claimed: stringArray('主張 — 確かめていない見立て。検収の根拠にはならない'),
        },
      },
      next: {
        type: 'object',
        additionalProperties: false,
        // **「どちらか一方」を検査でも縛る。** 空だと台帳が next-required で断り、
        // Action は running のまま止まって fallback が bot の意図と無関係な待ちに倒す
        minProperties: 1,
        maxProperties: 1,
        description:
          '次の一手 — **plan か waiting のどちらか一方だけ**書く (両方・空はどちらも不可)。'
          + '案件は「次に何が起きたら動くか」を必ず 1 つ持つ (不変条件)',
        properties: {
          plan: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'summary'],
            description: '次の action — 自分がもう一度動く (宛先とスレッドはブリッジが決める)',
            properties: {
              kind: {
                type: 'string',
                maxLength: MAX_ITEM_CHARS,
                description: '種別 — investigate / measure / assess / consult など',
              },
              summary: prose('要旨 — 次に何をするのか'),
            },
          },
          waiting: {
            type: 'object',
            additionalProperties: false,
            required: ['why', 'condition'],
            description: '待ち条件 — 自分では進められないとき。**内部の待ちを人間待ちにしない**',
            properties: {
              why: {
                type: 'string',
                enum: [...WAITING_REASONS],
                description:
                  '待つ理由 — dependency (別の案件) / evidence (証拠) / budget (予算) / '
                  + 'authority (人間の判断) / offer (引受け) / paused / reconcile',
              },
              condition: prose('条件 — 何が起きたら動けるのか (これが満たされたかを次の tick が見る)'),
            },
          },
        },
      },
      claim: {
        type: 'object',
        additionalProperties: false,
        required: ['decision'],
        description:
          '引受けの返事 — **相談 (consult) で呼ばれたときだけ**書く。'
          + '受けるなら accept と最初の一手 (next.plan)、受けないなら decline と理由を書く。'
          + '**ここで書けたから引き受けたことになるのではない** — 受諾は実効権限を'
          + '再検証して通ったときに成立し、同じ責務を先に受けた人が居れば断られる',
        properties: {
          decision: {
            type: 'string',
            enum: ['accept', 'decline'],
            description: '採否 — accept (引き受ける) / decline (引き受けない)',
          },
          reason: prose('理由 — decline のときは必須。次に誰へ声を掛けるかを決める材料になる'),
          scope: prose('範囲 — 引き受ける範囲を狭めたいときだけ書く (省略すると相談の範囲のまま)'),
        },
      },
      finding: {
        type: 'object',
        additionalProperties: false,
        required: ['expected', 'actual', 'subject_id', 'condition_id'],
        description:
          '気づき — 目的と実際の食い違いに気づいたときだけ書く (無ければ丸ごと省く)。'
          + '**原因も直し方も分からなくてよい** — 分かるまで残せないと観測が消える (受入 C02)',
        properties: {
          expected: prose('望む状態 — Mandate から見て、どうなっているべきか'),
          actual: prose('実際 — 何が起きているのか'),
          subject_id: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description: '対象 ID — task / run / 検証対象の正規 ID (同じ事象をまとめる鍵)',
          },
          condition_id: {
            type: 'string',
            maxLength: MAX_ITEM_CHARS,
            description: '観測条件 ID — どの観測でそう見えたのか (観測方法の版をまたいで継承する)',
          },
          hypothesis: prose('仮説 — 思い当たる原因があれば。無ければ省く'),
        },
      },
    },
  },
  // スカウトの起票。ボードの propose へ機械が流す前提なので、
  // タスク 1 件を散文ではなくオブジェクトで受ける — 本文を人が読んで転記する形にすると、
  // 起票が人手を介さないと進まなくなる (自律運転の意味が無い)
  'task-proposal': {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'tasks'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '制御フッターはこの末尾の独立行に置く',
      ),
      tasks: {
        type: 'array',
        maxItems: MAX_PROPOSED_TASKS,
        description:
          `起票するタスク — ${MAX_PROPOSED_TASKS} 件以内。`
          + '**今回は起票なし**なら空配列 (無理に埋めない)。承認を経てから着手される',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'rationale', 'touch'],
          properties: {
            title: {
              type: 'string',
              maxLength: MAX_ITEM_CHARS,
              description: 'タイトル — 1 タスク = 1 スレッドで完結する大きさで書く',
            },
            rationale: {
              type: 'string',
              maxLength: MAX_ITEM_CHARS,
              description: '理由 — 方向性ドキュメントのどこに効くのか。承認する側はここを見る',
            },
            // **起票の時点で必須** — touch 不明のタスクが open にあると、
            // 発議側は「触っているかもしれない」と見なして全件拒否する (fail-closed)
            touch: {
              type: 'array',
              items: { type: 'string', maxLength: MAX_ITEM_CHARS },
              minItems: 1,
              maxItems: MAX_ITEMS,
              description:
                'touch 集合 — このタスクで触るファイルの相対パス (チャンネルの作業ディレクトリ基準)。'
                + '1 つ以上・1 ファイルずつ書く (ディレクトリやワイルドカードは使えない)。'
                + '新しく作るファイルも書く',
            },
            job_budget: {
              type: 'integer',
              minimum: 1,
              description: 'job 予算 — 1 以上の整数。省略時はチャンネル設定の既定が使われる',
            },
          },
        },
      },
    },
  },
  // 承認 (proposed → approved | dropped)。**この種別だけ往復で形が違う**:
  // ブリッジは `pending` を埋めて保存し、承認する側は `body` / `approve` / `drop` を返す。
  // 同じスキーマに両方を置いてあるのは、契約の保存と検査が種別 1 つで完結するため。
  'task-approval': {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'approve', 'drop'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '制御フッターはこの末尾の独立行に置く',
      ),
      approve: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_ITEM_CHARS },
        maxItems: MAX_PROPOSED_TASKS,
        description:
          '承認するタスクの id — 提示された一覧の id をそのまま書く。'
          + '承認したものだけが着手される。無ければ空配列',
      },
      drop: {
        type: 'array',
        maxItems: MAX_PROPOSED_TASKS,
        description:
          '破棄するタスク — id と理由。無ければ空配列。'
          + '**どちらにも書かなかった id は自動で破棄される** (承認待ちを残さないため)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'reason'],
          properties: {
            id: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードのタスク id' },
            reason: {
              type: 'string',
              maxLength: MAX_ITEM_CHARS,
              description: '破棄の理由 — 起票した側が次に活かせる言葉で書く',
            },
          },
        },
      },
      pending: {
        type: 'array',
        maxItems: MAX_PROPOSED_TASKS,
        description:
          '承認待ちのタスク — **ブリッジが埋める提示用の欄。承認する側は書かない**',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title'],
          properties: {
            id: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードのタスク id' },
            title: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'タイトル' },
            rationale: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '起票時の理由' },
            // **重複を見つける材料**は touch — タイトルの言い換えは見抜けないが、
            // 同じファイルを掴んでいるかは参考欄と突き合わせれば分かる
            touch: {
              type: 'array',
              items: { type: 'string', maxLength: MAX_ITEM_CHARS },
              maxItems: MAX_ITEMS,
              description: 'touch 集合 — このタスクで触るファイルの相対パス',
            },
            job_budget: { type: 'integer', minimum: 1, description: '払い出す job 予算' },
          },
        },
      },
      // 承認する側は pending しか見えず、**重複を見つける材料がなかった**
      // (#46 の重複が 1〜9 分で全部通った)。ボードの現状を同じ契約に載せる
      board: {
        type: 'array',
        maxItems: MAX_ITEMS,
        description:
          'ボードの現状 — **ブリッジが埋める参考用の欄。承認する側は書かない**。'
          + '非終端のタスクと直近 48 時間に merged になったもの (今回の承認待ちは除く)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'state', 'title'],
          properties: {
            id: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードのタスク id' },
            state: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードの状態' },
            title: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'タイトル' },
            touch: {
              type: 'array',
              items: { type: 'string', maxLength: MAX_ITEM_CHARS },
              maxItems: MAX_ITEMS,
              description: 'touch 集合 — 宣言があるときだけ載る',
            },
          },
        },
      },
    },
  },
  // レビュー → 昇格。承認と同じ非対称の形: ブリッジは `target` を埋めて保存し、
  // レビューする側は `verdict` (+ 理由 / マージコミット) を返す。
  // **merge の実行はレビュー担当の shell 仕事**で、ブリッジは git を持たない。
  'task-review': {
    type: 'object',
    additionalProperties: false,
    required: ['body', 'verdict'],
    properties: {
      body: prose(
        '本文 — Discord へそのまま投稿される。人間が読む唯一のフィールド。'
        + '制御フッターはこの末尾の独立行に置く',
      ),
      verdict: {
        type: 'string',
        enum: REVIEW_VERDICTS,
        maxLength: MAX_TEXT_CHARS,
        description:
          '判定 — merge (main へ入れた) / send-back (直させる) / block (詰んだので要人間) / '
          + 'drop (対象が不要 — 重複・既に着地)。'
          + 'merge と書くのは、**自分で main へマージし終えたあと**だけ',
      },
      reason: {
        type: 'string',
        maxLength: MAX_TEXT_CHARS,
        description:
          '理由 — merge 以外 (send-back / block / drop) では必須。'
          + '直す側がそのまま作業に移れる具体さで書く '
          + '(ファイル:行 / 失敗シナリオ / 推奨する直し方)。drop なら何の重複なのか',
      },
      merge_commit: {
        type: 'string',
        maxLength: MAX_TEXT_CHARS,
        description:
          'マージコミット — merge のとき必須。マージコミットの SHA (7〜40 桁の 16 進)。'
          + 'ブリッジが base への取り込みを git で照合する。照合できなければ merged にならない',
      },
      target: {
        type: 'array',
        maxItems: 1,
        description: 'レビュー対象 — **ブリッジが埋める提示用の欄。レビューする側は書かない**',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'branch'],
          properties: {
            id: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'ボードのタスク id' },
            title: { type: 'string', maxLength: MAX_ITEM_CHARS, description: 'タイトル' },
            branch: { type: 'string', maxLength: MAX_ITEM_CHARS, description: '作業ブランチ' },
            job_budget: { type: 'integer', minimum: 1, description: '払い出した job 予算' },
          },
        },
      },
    },
  },
};

/**
 * 種別ごとの不変条件 (JSON Schema では書けない「あるフィールドの値で必須が変わる」形)。
 * **通した後に見る** — 型が合っていることを前提にできるので条件が短く済む。
 * @returns {string|null} 人間向けの理由 (null = 問題なし)
 */
function kindInvariant(kind, contract) {
  if (kind === 'case-turn') {
    // **断るなら理由が要る。** 辞退は責任の空白を作る操作で、次に誰へ声を掛けるかを
    // 決めるのは理由を読んだ側 (「declined に落ちて理由が残る」と同じ要求)
    if (contract.claim?.decision === 'decline' && String(contract.claim.reason ?? '').trim() === '') {
      return `${label('claim')} が decline のときは理由 (reason) が必要です`;
    }
    // **引き受けるなら最初の一手が要る。** accept + `next.waiting` は台帳側が `plan-required` で
    // 断るが、断られた時点で相談の Action は settle 済みなので、申し出は `offered` のまま誰にも
    // 再送されない (Opus2 指摘 ④ 2026-09-08)。生成の時点で縛れば、その取り逃しが起きない
    if (contract.claim?.decision === 'accept' && !isPlainObject(contract.next?.plan)) {
      return `${label('claim')} が accept のときは最初の一手 (next.plan) が必要です`;
    }
    return null;
  }
  if (kind !== 'task-review') return null;
  // 差し戻しと封鎖は「なぜか」が無いと次の一手が決められない。merge だけ省略を許す
  // (判定が増えても `merge 以外` のままなので、drop も足した時点で理由必須になる)
  if (contract.verdict !== 'merge' && String(contract.reason ?? '').trim() === '') {
    return `${label('verdict')} が ${contract.verdict} のときは理由 (reason) が必要です`;
  }
  // **merge は「もう base へ入れた」の宣言**なので、照合できる形の SHA が無ければ受け取らない
  //。ブリッジは取り込みを git で確かめてから merged にするので、SHA が無い判定は
  // 「確かめようがない完了」= 無関係な commit と区別が付かない
  if (contract.verdict === 'merge') {
    const sha = String(contract.merge_commit ?? '').trim();
    if (sha === '') {
      return `${label('verdict')} が merge のときは ${label('merge_commit')} (merge_commit) が必要です`;
    }
    if (!MERGE_COMMIT_RE.test(sha)) {
      return `${label('merge_commit')} は 16 進 7〜40 桁の SHA で書いてください: ${JSON.stringify(contract.merge_commit)}`;
    }
  }
  return null;
}

/**
 * マージコミットの SHA として受け取る形 (git の短縮 OID 〜 完全 OID)。
 *
 * **大文字も受ける** (`/i`)。git 自身が `ABC1234` を解決するので、ここで弾くと
 * コピー元の見た目が違うだけで検収の報告が様式エラーになる (Opus 指摘 2026-09-07)。
 * 照合する側 (`src/bridge/board.js`) が git と receipt に当てる前に小文字へ揃える。
 */
const MERGE_COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/**
 * モデルが返した構造化出力を検証する。
 *
 * **通らなかったものは「様式不履行」として扱い、契約にも権限にも使わない。**
 * 表示だけは素の result へ縮退するので情報は落ちない (呼び出し側の責務)。
 *
 * @returns {{ok: true, contract: object} | {ok: false, reason: string}}
 */
export function validateContract(kind, value) {
  const schema = Object.hasOwn(SCHEMAS, kind) ? SCHEMAS[kind] : null;
  if (!schema) return { ok: false, reason: `未知のスキーマ種別: ${kind}` };
  if (!isPlainObject(value)) return { ok: false, reason: '構造化出力がオブジェクトではありません' };

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key)) {
      return { ok: false, reason: `契約に無いキーを含みます: ${key}` };
    }
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) return { ok: false, reason: `${label(key)} がありません` };
  }

  const out = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    if (spec.type === 'string') {
      if (typeof raw !== 'string') return { ok: false, reason: `${label(key)} は文字列で書きます` };
      if (schema.required.includes(key) && raw.trim() === '') {
        return { ok: false, reason: `${label(key)} が空です` };
      }
      // 切り詰めない。本文を切ると末尾の制御フッターごと消える
      if (raw.length > MAX_TEXT_CHARS) {
        return { ok: false, reason: `${label(key)} が長すぎます (${raw.length} 字 / 上限 ${MAX_TEXT_CHARS} 字)` };
      }
      // 決まった値しか採らないフィールド (レビューの判定など)。綴り違いを通すと、
      // 知らない値のまま「何もしない」経路へ落ちて、判定したつもりが効かない
      if (Array.isArray(spec.enum) && !spec.enum.includes(raw)) {
        return {
          ok: false,
          reason: `${label(key)} は ${spec.enum.join(' / ')} のどれかで書きます (受け取った値: ${JSON.stringify(raw)})`,
        };
      }
      out[key] = raw;
    } else if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        return { ok: false, reason: `${label(key)} は true / false で書きます` };
      }
      out[key] = raw;
    } else if (spec.type === 'object') {
      // 単体のオブジェクト (report の adjudication)。配列の要素と同じ規則で見る
      const checked = validateObjectValue(label(key), raw, spec);
      if (!checked.ok) return checked;
      out[key] = checked.value;
    } else {
      if (!Array.isArray(raw)) return { ok: false, reason: `${label(key)} は配列で書きます` };
      // 上限はフィールドごと (スキーマに書いた maxItems と同じ値で検査する)
      const maxItems = Number.isSafeInteger(spec.maxItems) ? spec.maxItems : MAX_ITEMS;
      if (raw.length > maxItems) {
        return { ok: false, reason: `${label(key)} の要素が多すぎます (${raw.length} 件 / 上限 ${maxItems} 件)` };
      }
      // オブジェクトの配列 (task-proposal の tasks) は 1 件ずつ中身まで見る
      if (spec.items?.type === 'object') {
        const checked = validateObjectItems(label(key), raw, spec.items);
        if (!checked.ok) return checked;
        out[key] = checked.value;
        continue;
      }
      if (!raw.every((item) => typeof item === 'string')) {
        return { ok: false, reason: `${label(key)} の要素は文字列で書きます` };
      }
      const long = raw.find((item) => item.length > MAX_ITEM_CHARS);
      if (long !== undefined) {
        return { ok: false, reason: `${label(key)} の要素が長すぎます (上限 ${MAX_ITEM_CHARS} 字)` };
      }
      out[key] = [...raw];
    }
  }
  const broken = kindInvariant(kind, out);
  return broken ? { ok: false, reason: broken } : { ok: true, contract: out };
}

/**
 * オブジェクト配列の要素を 1 件ずつ検証する (task-proposal の tasks)。
 *
 * 流儀は上と同じ — **切り詰めず、合わないものは不適合にして理由を返す**。
 * 理由には何件目かを入れる: 5 件まとめて起票された中の 1 件が悪いとき、
 * どれを直せばいいか分からないと様式不履行から抜け出せない。
 *
 * 返す値は既知のキーだけを詰め直したもの (余分なキーは上で落としてある)。
 */
function validateObjectItems(at, raw, itemSpec) {
  const out = [];
  for (const [index, item] of raw.entries()) {
    const checked = validateObjectValue(`${at} の ${index + 1} 件目`, item, itemSpec);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

/**
 * オブジェクト 1 件を検証する (配列の要素と、単体のオブジェクトフィールドで共用)。
 * @param {string} at 理由に添える位置 (「〜の 1 件目」「〜」)
 */
function validateObjectValue(at, item, spec) {
  const required = Array.isArray(spec.required) ? spec.required : [];
  if (!isPlainObject(item)) return { ok: false, reason: `${at} がオブジェクトではありません` };
  for (const k of Object.keys(item)) {
    if (!Object.hasOwn(spec.properties, k)) {
      return { ok: false, reason: `${at}: 契約に無いキーを含みます: ${k}` };
    }
  }
  // 「どれか 1 つだけ」を持つ欄 (case-turn の next = plan か waiting)。**検査側でも見る** —
  // `--json-schema` の minProperties がランタイムで効くかに依存させない (Opus2 S2-3a レビュー ②)
  const count = Object.keys(item).length;
  if (Number.isSafeInteger(spec.minProperties) && count < spec.minProperties) {
    return {
      ok: false,
      reason: `${at}: ${Object.keys(spec.properties).map(label).join(' か ')} のどちらかを書きます (空です)`,
    };
  }
  if (Number.isSafeInteger(spec.maxProperties) && count > spec.maxProperties) {
    return {
      ok: false,
      reason: `${at}: ${Object.keys(spec.properties).map(label).join(' と ')} は同時に書けません (どちらか一方)`,
    };
  }
  const value = {};
  for (const [k, field] of Object.entries(spec.properties)) {
    if (!Object.hasOwn(item, k)) {
      if (required.includes(k)) return { ok: false, reason: `${at}: ${label(k)} がありません` };
      continue;
    }
    const v = item[k];
    if (field.type === 'string') {
      if (typeof v !== 'string') return { ok: false, reason: `${at}: ${label(k)} は文字列で書きます` };
      if (v.trim() === '') return { ok: false, reason: `${at}: ${label(k)} が空です` };
      const max = Number.isSafeInteger(field.maxLength) ? field.maxLength : MAX_ITEM_CHARS;
      if (v.length > max) {
        return { ok: false, reason: `${at}: ${label(k)} が長すぎます (${v.length} 字 / 上限 ${max} 字)` };
      }
      // 決まった値しか採らないフィールドは綴り違いをここで落とす。通してしまうと、
      // 後段が「知らない値」を見て何もしないまま「書いたのに効かない」になる
      if (Array.isArray(field.enum) && !field.enum.includes(v)) {
        return {
          ok: false,
          reason: `${at}: ${label(k)} は ${field.enum.join(' / ')} のどれかで書きます (受け取った値: ${JSON.stringify(v)})`,
        };
      }
      value[k] = v;
    } else if (field.type === 'integer') {
      const min = Number.isSafeInteger(field.minimum) ? field.minimum : 1;
      if (!Number.isSafeInteger(v) || v < min) {
        return {
          ok: false,
          reason: `${at}: ${label(k)} は ${min} 以上の整数で書きます (受け取った値: ${JSON.stringify(v)})`,
        };
      }
      value[k] = v;
    } else if (field.type === 'object') {
      // 入れ子のオブジェクト (発議の change / trial)。同じ規則で 1 段深く見る
      const checked = validateObjectValue(`${at}: ${label(k)}`, v, field);
      if (!checked.ok) return checked;
      value[k] = checked.value;
    } else if (field.type === 'array') {
      // オブジェクトの中の配列 (task-proposal の touch・発議の targets)。件数の下限まで
      // 見るのは、空配列を通すと「宣言したつもりで宣言されていない」形ができるため
      if (!Array.isArray(v)) return { ok: false, reason: `${at}: ${label(k)} は配列で書きます` };
      const minItems = Number.isSafeInteger(field.minItems) ? field.minItems : 0;
      const maxItems = Number.isSafeInteger(field.maxItems) ? field.maxItems : MAX_ITEMS;
      if (v.length < minItems) {
        return { ok: false, reason: `${at}: ${label(k)} は ${minItems} 件以上書きます (${v.length} 件)` };
      }
      if (v.length > maxItems) {
        return { ok: false, reason: `${at}: ${label(k)} の要素が多すぎます (${v.length} 件 / 上限 ${maxItems} 件)` };
      }
      if (field.items?.type === 'object') {
        const checked = validateObjectItems(`${at}: ${label(k)}`, v, field.items);
        if (!checked.ok) return checked;
        value[k] = checked.value;
        continue;
      }
      if (field.items?.type !== 'string') {
        return { ok: false, reason: `${at}: ${label(k)} の要素の型を検査できません` };
      }
      if (!v.every((item) => typeof item === 'string' && item.trim() !== '')) {
        return { ok: false, reason: `${at}: ${label(k)} の要素は空でない文字列で書きます` };
      }
      const max = Number.isSafeInteger(field.items.maxLength) ? field.items.maxLength : MAX_ITEM_CHARS;
      if (v.some((item) => item.length > max)) {
        return { ok: false, reason: `${at}: ${label(k)} の要素が長すぎます (上限 ${max} 字)` };
      }
      value[k] = [...v];
    } else {
      // 検査の書き漏らしで無検査のフィールドを作らない (fail-closed)
      return { ok: false, reason: `${at}: ${label(k)} の型を検査できません` };
    }
  }
  return { ok: true, value };
}

/** touch 制限が有効か (省略時は絞る — 明示的に false と書いたときだけ解除) */
export function isTouchRestricted(contract) {
  return contract?.touch_restricted !== false;
}

/** 契約の touch 集合 (配列でなければ空) */
export function touchSetOf(contract) {
  return Array.isArray(contract?.touch_set) ? contract.touch_set : [];
}

/** Discord へ投稿する本文 */
export function bodyOf(contract) {
  return typeof contract?.body === 'string' ? contract.body : '';
}

// ---- touch 集合 → 実権限 ----

/**
 * 書込みとみなす裸のツール名。**元の権限にこれが 1 つも無ければ書込みは付与しない**
 * (契約が権限を増やせないようにするための入口判定)。
 */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * touch 制限中に**必ず無効化する**ツール。
 *
 * 実測 (2026-08-02 / CLI 2.1.220) で、これらを塞がないと touch 外へ書けることを確認した:
 * - `Bash` / `PowerShell` — リダイレクトや `sed -i` で任意のファイルを書ける。
 *   `Bash(git *)` のような前置き許可でも同じ (照合前に wrapper が外れる — src/grants.js)
 * - `Write` / `NotebookEdit` — `Write(パス)` は受理されても照合されない (再実測済み) ため、
 *   パス限定に絞れない。書込みは `Edit(パス)` に一本化する
 * - `Agent` / `Task` — **省略では止まらない** (`--allowedTools` と無関係に呼べる)。
 *   さらに custom subagent 定義は `permissionMode` を上書きできる (T0-results の訂正)。
 *   明示的に落とす必要がある
 */
export const NARROWED_DENY_TOOLS = ['Bash', 'PowerShell', 'Write', 'NotebookEdit', 'Agent', 'Task'];

/**
 * touch 制限中も残してよい読み取り系。**元の権限にあるものだけ**が実際に渡る
 * (ここは「残す候補」であって付与ではない)。
 */
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/**
 * 元の permissionMode → touch 制限中に使う mode。
 *
 * **`plan` は読取専用なので `default` へ「狭める」ことにならない** — 上げると
 * 読めるだけだった job が書けるようになる (sol 指摘 2026-08-03: 実際に昇格していた)。
 * `plan` は据え置き、それ以外は `acceptEdits` の迂回を止めるため `default` へ落とす。
 * **表に無い mode は起動しない** — 安全性を証明できないものを黙って通さない。
 */
const NARROWED_MODE = {
  plan: 'plan',
  default: 'default',
  acceptEdits: 'default',
  bypassPermissions: 'default',
};

/** plan は書込みが無い前提のモード (touch 集合があっても書込みは付与しない) */
const READONLY_MODES = ['plan'];

/** ルール文字列からツール名を取る (`Bash(git *)` → `Bash`) */
function toolNameOf(rule) {
  return String(rule ?? '').split('(')[0].trim();
}

/**
 * 契約の touch 集合を、この job の実権限へ変換する。
 *
 * **実測に基づく 4 点セットで初めて強制になる** (どれか 1 つでも欠けると素通りする):
 *   1. `permissionMode: 'default'` — `acceptEdits` は `Edit(パス)` の照合を丸ごと迂回する
 *      (実測 2026-08-02: acceptEdits では touch 外のファイルが書き換わった)
 *   2. `--tools` を読み取り系 + `Edit` に限定する (組み込みツール自体を減らす)
 *   3. `--allowedTools` の書込みを `Edit(./パス)` だけにする
 *   4. `--disallowedTools` で NARROWED_DENY_TOOLS を明示的に落とす
 * さらに MCP は `--strict-mcp-config` で締める (実測では書けないと分かったモデルが
 * MCP ツールへ迂回を試みた)。
 *
 * @param {object} p
 * @param {string[]} p.touchSet 契約の touch集合
 * @param {string[]} p.allowedTools チャンネルの実効権限 (resolveAllowedTools の戻り)
 * @param {string} p.cwd canonical cwd
 * 外部 settings も落とす: `permissions.allow` は `--allowedTools` に**勝って権限を付与する**
 * ので、作者の user settings に 1 行足すだけで絞り込みが破れる
 * (実測 2026-08-03: 実際に破れた)。`--setting-sources ''` で user / project / local を
 * すべて読ませない — job 専用の `--settings` (hooks) は別枠なので残る (実測済み)。
 *
 * @returns {{ok: true, permissionMode: string, tools: string[], allowedTools: string[],
 *            disallowedTools: string[], strictMcp: true, settingSources: string,
 *            rules: string[], rejected: Array<{path: string, reason: string}>,
 *            warnings: string[]}
 *          |{ok: false, reason: string, rejected?: Array<{path: string, reason: string}>}}
 */
export function narrowForTouchSet({
  touchSet = [], allowedTools = [], cwd = null, permissionMode = 'default',
} = {}) {
  if (!Array.isArray(touchSet) || touchSet.length === 0) {
    return { ok: false, reason: 'touch 集合が空です (絞り込む対象がありません)' };
  }
  if (!cwd) return { ok: false, reason: '作業ディレクトリを解決できないため絞り込めません' };
  if (!Object.hasOwn(NARROWED_MODE, permissionMode)) {
    return {
      ok: false,
      reason: `permissionMode "${permissionMode}" は touch 制限の下で安全に絞り込めません `
        + `(扱えるのは ${Object.keys(NARROWED_MODE).join(' / ')})`,
    };
  }
  const narrowedMode = NARROWED_MODE[permissionMode];

  const baseNames = new Set(allowedTools.map(toolNameOf));
  const warnings = [];

  // **書込みを付与できるのは、元の権限が既に書込みを持っているときだけ。**
  // ここを緩めると契約が権限を増やす経路になる。
  //
  // 裸の書込みツール (`Edit` / `Write` / `NotebookEdit`) は全ファイルが対象なので、
  // touch 集合のどれへ絞っても「狭める」側にしかならない。
  // 一方、元が既に**パス限定**の場合 (`Edit(./src/a.js)` だけを持つチャンネル) は、
  // 別のパスへ広げてはいけない (sol 指摘 2026-08-03: 実際に広がっていた)。
  // claude のパス指定子は gitignore パターンで、`src/a.js` が既存ルールに含まれるかを
  // 文字列から安全には言えない — **包含は証明できないので完全一致だけ**を通す。
  // plan は読取専用のモード。ここで書込みを足すと「読めるだけ」だった job が書けるようになる
  const readOnlyMode = READONLY_MODES.includes(permissionMode);
  const bareWrite = !readOnlyMode && WRITE_TOOLS.some((t) => allowedTools.includes(t));
  const pinnedWrites = new Set(
    readOnlyMode
      ? []
      : allowedTools.filter((r) => WRITE_TOOLS.includes(toolNameOf(r)) && r !== toolNameOf(r)),
  );
  const hasWriteAccess = bareWrite || pinnedWrites.size > 0;

  const rules = [];
  const rejected = [];
  const seen = new Set();
  let convertible = 0;
  for (const path of touchSet) {
    // mustExist: Edit は既存ファイル専用。新規作成は Write が要るが、それは落としてある
    const described = describePathRule('Edit', path, cwd, { mustExist: true });
    if (!described.ok) {
      rejected.push({ path: String(path), reason: described.reason });
      continue;
    }
    if (seen.has(described.rule)) continue;
    seen.add(described.rule);
    convertible += 1;
    if (!bareWrite && !pinnedWrites.has(described.rule)) {
      rejected.push({
        path: String(path),
        reason: hasWriteAccess
          ? 'このチャンネルの書込み権限に含まれないファイルです (契約で権限は増やせない)'
          : 'このチャンネルは元から書込み権限を持ちません (契約で権限は増やせない)',
      });
      continue;
    }
    rules.push(described.rule);
  }

  // 1 件も変換できないなら絞り込みが成立しない。**fail-open にしない** —
  // 「絞れなかったので元の権限で走らせる」は契約を無視して走るのと同じ
  if (convertible === 0) {
    return {
      ok: false,
      reason: 'touch 集合のどれも 1 ファイルに絞り込めませんでした',
      rejected,
    };
  }
  // 書込み権限はあるのに touch 集合と 1 件も重ならない = 委譲元の想定と実権限が食い違う。
  // 何も書けない job を黙って走らせるより、理由を見せて止める
  if (hasWriteAccess && rules.length === 0) {
    return {
      ok: false,
      reason: 'touch 集合のどれもこのチャンネルの書込み権限に含まれません',
      rejected,
    };
  }
  if (rejected.length > 0) {
    warnings.push(
      `touch 集合のうち ${rejected.length} 件は絞り込みに使えないため、そのファイルは編集できません`,
    );
  }
  if (!hasWriteAccess) {
    warnings.push(
      readOnlyMode
        ? `このチャンネルは permissionMode: ${permissionMode} (読取専用) なので、`
          + 'touch 集合があっても編集はできません (契約でモードを上げることはしない)'
        : 'このチャンネルは元から書込み権限を持たないため、touch 集合があっても編集はできません '
          + '(契約で権限を増やすことはしない)',
    );
  }
  warnings.push(
    'touch 制限中は参照ディレクトリ (claudeAddDirs) を開きません '
    + '— --add-dir は読み書きの両方を開ける口で、touch 集合の外へ書けてしまうため',
  );

  // --tools は「使える組み込みツール」の集合。元の権限から導けるものだけを残す
  const tools = READONLY_TOOLS.filter((t) => baseNames.has(t));
  if (rules.length > 0) tools.push('Edit');

  // --allowedTools は元のルールから危険な経路を落としたもの + touch のパス限定
  const kept = allowedTools.filter((rule) => {
    const name = toolNameOf(rule);
    if (NARROWED_DENY_TOOLS.includes(name)) return false;
    if (WRITE_TOOLS.includes(name)) return false; // 裸の Edit はパス限定に置き換える
    return tools.includes(name);
  });

  return {
    ok: true,
    permissionMode: narrowedMode,
    tools,
    // rules は「元の権限に既に含まれていたもの」だけ (裸の書込みがあるか、
    // パス限定と完全一致したもの) なので、ここで権限が増えることはない
    allowedTools: [...new Set([...kept, ...rules])],
    disallowedTools: [...NARROWED_DENY_TOOLS],
    strictMcp: true,
    // 空文字 = user / project / local のどれも読まない
    settingSources: '',
    // **cwd の外を開かない。** `--add-dir` は読取専用にできない (docs/reference/add-dir.md)
    // ので、残すと touch 集合の外どころか作業ツリーの外へ書ける (sol 指摘 2026-08-03)
    addDirs: [],
    rules,
    rejected,
    warnings,
  };
}

/**
 * その契約を、そのランタイムの担当へ渡してよいか。
 *
 * **touch 制限は claude ランタイムでしか強制できない。** codex (Sol) の権限は
 * `codexSandbox` の read-only / workspace-write の 2 値で、パス単位に絞る口が無い。
 * 渡してしまうと「touch 制限のつもりで委譲したのに、受け手は作業ツリー全体を書ける」
 * という**最悪の食い違い**になるので、保存する前に止める (sol 指摘 2026-08-03)。
 *
 * 制限の無い契約は渡してよい — その場合の契約は権限ではなく依頼文の構造化にすぎない。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function canDelegateTo(kind, contract, runtime) {
  // 縛るのは委譲の touch 制限だけ。報告は権限を持たないのでどの担当へでも渡せる
  if (kind !== 'delegation' || !isTouchRestricted(contract)) return { ok: true };
  if ((runtime ?? 'claude') === 'claude') return { ok: true };
  return {
    ok: false,
    reason:
      `touch 制限つきの委譲は ${runtime} ランタイムの担当へ渡せません `
      + '(パス単位に権限を絞る口が無く、作業ツリー全体を書けてしまう)。'
      + 'touch 制限を解除して渡すか、claude ランタイムの担当へ委譲してください',
  };
}

/**
 * 契約を次の job へ持ち回るための保存形。
 *
 * **thread・送信元・宛先・作業ディレクトリへ束縛する。** 束縛しないと、人間が直接
 * 起動した job や別の bot が、他人宛の契約で権限を絞られたり緩められたりする。
 */
export function bindContract({
  kind, contract, threadId, fromBotKey, toBotKey, cwd, channelName, at, id, nonce,
}) {
  if (!CONTRACT_KINDS.includes(kind)) return null;
  if (!isNonEmptyString(threadId) || !isNonEmptyString(fromBotKey) || !isNonEmptyString(toBotKey)) {
    return null;
  }
  if (!isNonEmptyString(cwd) || !isPlainObject(contract)) return null;
  // id は「配送に失敗したこの 1 件だけを取り消す」ために要る
  // (宛先ごと消すと同じ相手宛の他の未消費契約まで巻き添えになる)
  if (!isNonEmptyString(id)) return null;
  // nonce は制御メッセージへ載る識別子。**投稿より前に決まっている**必要がある
  if (formatContractTag(nonce) === '') return null;
  return {
    id,
    nonce,
    kind,
    contract,
    threadId,
    fromBotKey,
    toBotKey,
    cwd,
    channelName: channelName ?? null,
    at: at ?? null,
  };
}

/**
 * 外部 settings (user / project / local) のうち、**落とすと権限が広がるもの**を見つける。
 *
 * touch 制限は `--setting-sources ''` で外部 settings を落とす。`permissions.allow` が
 * `--allowedTools` に勝って権限を付与するためだが、これは **`permissions.deny` や
 * 拒否 hook も一緒に落とす** — 通常 job では効いていた禁止が touch job では消え、
 * 「元の実効権限の部分集合」でなくなる (sol 指摘 2026-08-03)。
 *
 * CLI は allow だけを落とす指定を持たないので、**制限が書かれていたら起動しない**。
 * (管理者ポリシー settings は `--setting-sources` の対象外で残るため、ここでは見ない。)
 *
 * **管理者ポリシー (managed) は別扱い。** `--setting-sources` の対象外で優先度が上、
 * 同じ permission 形式を使うので、裸の `Edit` 許可が書かれていても打ち消せず、
 * 読めなければ中身も分からない。だから **存在するだけで touch 制限 job を止める**
 * (Fable 裁定 2026-08-03: 実運用のマシンに policy は無いので影響は無く、
 * 「うっかり置かれた policy」を検出できれば足りる)。
 *
 * @param {Array<{label: string, settings: object|null, managed?: boolean}>} sources
 * @returns {{ok: true} | {ok: false, restrictive: string[], reason: string}}
 */
export function classifyExternalSettings(sources = []) {
  const restrictive = [];
  for (const { label, settings, managed } of sources) {
    if (managed === true) {
      restrictive.push(`${label} (管理者ポリシーは打ち消せません)`);
      continue;
    }
    if (!isPlainObject(settings)) continue;
    const permissions = isPlainObject(settings.permissions) ? settings.permissions : {};
    // deny / ask はどちらも「そのままでは実行させない」= 制限
    const limits = ['deny', 'ask'].filter((k) => Array.isArray(permissions[k]) && permissions[k].length > 0);
    // PreToolUse hook は実行前に deny を返せる
    const hooks = isPlainObject(settings.hooks) && Array.isArray(settings.hooks.PreToolUse)
      && settings.hooks.PreToolUse.length > 0;
    if (limits.length > 0 || hooks) {
      restrictive.push(`${label} (${[...limits.map((k) => `permissions.${k}`), ...(hooks ? ['PreToolUse hook'] : [])].join(' / ')})`);
    }
  }
  if (restrictive.length === 0) return { ok: true };
  return {
    ok: false,
    restrictive,
    reason:
      '外部 settings に制限が書かれています: '
      + `${restrictive.join(' / ')}。touch 制限は外部 settings を丸ごと落とすため、`
      + 'この制限も一緒に消えて権限が広がります (CLI に「許可だけ落とす」指定がない)。'
      + 'その制限を config.policy.json 側へ移すか、touch 制限を解除して委譲し直してください',
  };
}

/**
 * 制御メッセージへ載せる契約タグと、その読み取り。
 *
 * **投稿より前に決まる識別子でなければならない。** 投稿後にメッセージ ID を契約へ
 * 書き戻す形にしていた頃は、受け手の MessageCreate が書き戻しより先に届くと
 * 契約なし = touch 制限なしで起動した (sol 指摘 2026-08-03)。nonce を先に決めて
 * 契約と制御メッセージの**両方**へ載せれば、順序に関係なく完全一致で結び付く。
 *
 * 制御マーカー (`[[...]]`) の文法は使わない — あれは「起動を決める」記法で、
 * 種類を増やすとプロトコル版の管理対象になる。ここは起動には一切関与しない目印。
 */
const CONTRACT_TAG = /`契約:([0-9a-f]{8,32})`/;

export function formatContractTag(nonce) {
  return /^[0-9a-f]{8,32}$/.test(String(nonce ?? '')) ? `\`契約:${nonce}\`` : '';
}

/** 制御メッセージに載っていた契約 nonce (無ければ null) */
export function readContractNonce(content) {
  const m = CONTRACT_TAG.exec(String(content ?? ''));
  return m ? m[1] : null;
}

/**
 * 起動メッセージそのものへ載せるスキーマ種別の目印 (sol 指摘 2026-08-30)。
 *
 * **`threadId:botKey` の 1 枠に置く上書きでは足りない場面がある。**
 * - archive されたスレッドを避けて親チャンネルへ投稿すると、そこから生える
 *   スレッドの ID は投稿先と違う (`msg.startThread()` — 起点メッセージ ID になる) ので、
 *   スレッド ID に紐付けた上書きは**必ず外れる**。
 * - 同じスレッドへ 2 件依頼すると、先に走った job が 1 枠を消費して残りが素通りする。
 *
 * 目印を**トリガー投稿の本文**へ載せれば、どこにスレッドが生えても、何件並んでも、
 * その job を起こした 1 通から種別が決まる。契約 nonce と同じ流儀 (起動には関与しない目印)。
 */
const SCHEMA_TAG = /`様式:([a-z-]+)`/;

export function formatSchemaTag(kind) {
  return CONTRACT_KINDS.includes(kind) ? `\`様式:${kind}\`` : '';
}

/** 起動メッセージに載っていたスキーマ種別 (無ければ / 知らない綴りなら null) */
export function readSchemaTag(content) {
  const m = SCHEMA_TAG.exec(String(content ?? ''));
  return m && CONTRACT_KINDS.includes(m[1]) ? m[1] : null;
}

/**
 * この job で使う種別。**目印 → 共有枠**の順に見る。
 *
 * **目印があるときは枠を触らない** (sol 指摘 2026-08-30)。共有枠は
 * `threadId:botKey` に 1 つしかないので、目印つきの job が先に取り出してしまうと、
 * 同じ宛先で待っていた別の依頼 (`task-review` など) の枠が消え、その job が
 * 既定の様式で走って滞留する。取り出しは「枠を使うと決めたとき」だけに限る。
 *
 * @param {object} p
 * @param {string} [p.triggerContent] その job を起こした投稿の本文
 * @param {() => (string|null)} [p.claimSlot] 共有枠を取り出す (**目印が無いときだけ呼ばれる**)
 */
export function resolveJobContractKind({
  roleText, runtime = 'claude', structuredOutput = true,
  triggerContent = '', claimSlot = () => null,
} = {}) {
  const tagged = readSchemaTag(triggerContent);
  return resolveContractKind({
    roleText,
    runtime,
    structuredOutput,
    override: tagged ?? claimSlot(),
  });
}

/**
 * この job は契約つきで起動したはずか。
 *
 * **タグが載っているのに契約を取り出せなかったら起動してはいけない。**
 * 「契約なしの handoff」と「契約を失った handoff」を区別できるのがタグの主目的で、
 * 後者を素通しすると touch 制限が黙って外れる。
 */
export function requiresContract(content) {
  return readContractNonce(content) !== null;
}

/**
 * この job が取り出してよい契約の条件 (ストアへ渡す述語)。
 *
 * **人間が直接呼んだ job には null を返す = ストアに触れない。** 触れて捨てると、
 * あとから走る本来の handoff job が契約なしで起動し、touch 制限が黙って外れる
 * (sol 指摘 2026-08-03: Fable 実行中に人間が Opus を直接呼ぶと再現した)。
 *
 * @returns {((entry: object) => boolean)|null} null = 取り出さない
 */
export function consumableBy({ triggeredByBotKey } = {}) {
  if (!isNonEmptyString(triggeredByBotKey)) return null;
  return (entry) => entry?.fromBotKey === triggeredByBotKey;
}

/**
 * 保存済みの契約をこの job へ適用してよいか。
 *
 * **人間が直接起動した job には適用しない** — 契約は「呼ばれた 1 回」に効くもので、
 * 同じスレッドで人間が話しかけただけの job まで権限が絞られると、理由の分からない
 * 拒否になる。宛先・送信元・作業ディレクトリのどれかが違えば使わない (fail-closed)。
 *
 * @param {object|null} entry bindContract の戻り
 * @param {{botKey: string, threadId: string, cwd: string, triggeredByBotKey: string|null}} job
 * @returns {{ok: true, contract: object} | {ok: false, reason: string}}
 */
export function contractFor(entry, { botKey, threadId, cwd, triggeredByBotKey } = {}) {
  if (!entry || !CONTRACT_KINDS.includes(entry.kind)) {
    return { ok: false, reason: '引き継ぐ構造がありません' };
  }
  if (entry.toBotKey !== botKey) return { ok: false, reason: '別の担当宛の契約です' };
  if (entry.threadId !== threadId) return { ok: false, reason: '別スレッドの契約です' };
  if (entry.cwd !== cwd) return { ok: false, reason: '別の作業ディレクトリ向けの契約です' };
  // handoff で起動された job だけが対象。人間の直接起動には効かせない
  if (!triggeredByBotKey || triggeredByBotKey !== entry.fromBotKey) {
    return { ok: false, reason: '委譲元からの起動ではありません' };
  }
  const checked = validateContract(entry.kind, entry.contract);
  if (!checked.ok) return { ok: false, reason: `保存されていた契約が壊れています: ${checked.reason}` };
  return { ok: true, kind: entry.kind, contract: checked.contract };
}

/**
 * 契約をプロンプトへ載せる形 (受け手が読む依頼ブロック)。
 * 受入基準は**文字列として渡すだけ** — コマンドとして実行することは絶対にしない
 * (モデルが書いた文字列を実行すると、config.json の verify とは別の実行経路になる)。
 */
export function renderContract(contract, narrowed = null) {
  if (!isPlainObject(contract)) return '';
  const list = (items) => (items ?? []).map((i) => `- ${i}`).join('\n') || '- (なし)';
  const lines = [
    '# 委譲契約 (ブリッジが構造化して受け取った。これがこの job の契約の正本)',
    '',
    `## 背景\n${contract.background ?? ''}`,
    `## 目的\n${contract.purpose ?? ''}`,
    `## touch してよいファイル\n${list(contract.touch_set)}`,
    `## 受入基準\n${list(contract.acceptance)}`,
    '',
    '受入基準はブリッジが**コマンドとして実行することはない**。検証は自分で行い、',
    'チャンネルに verify が設定されていればブリッジがそれとは別に実行する。',
    `## 停止条件\n${list(contract.stop_conditions)}`,
  ];

  if (!isTouchRestricted(contract)) {
    lines.push(
      '',
      '**touch 制限は解除されている** (探索的な依頼)。権限は絞られていないので、'
      + '触ったファイルは報告に必ず挙げること。',
    );
    return lines.join('\n');
  }

  lines.push('', '## ファイル権限 (上の実行文脈より、この job ではこちらが正確)');
  if (narrowed?.rules?.length) {
    lines.push(
      '**touch 制限が有効。** 書込みは次の**既存ファイル**への `Edit` だけに絞ってある — '
      + 'それ以外は shell も新規作成もツール側で拒否される:',
      narrowed.rules.map((r) => `- \`${r}\``).join('\n'),
      '',
      '実行文脈の「ファイル権限」行も同じ範囲を指している (パス限定の書込み)。'
      + '**上のパスは編集できる** (既存ファイルの編集だけ — 新規作成はできない)。'
      + '集合の外が必要になったら止めて依頼元へ返すこと — **承認カードでは足せない** '
      + '(実行中のカードはドメイン限定の WebFetch だけが対象)。'
      + 'touch 集合を直した委譲をやり直してもらうのが唯一の道。',
      '',
      '**この制限が縛るのは、あなたが直接ツールで書き込む範囲だけ。** '
      + 'チャンネルに verify が設定されていれば、ブリッジはあなたが編集したコードを '
      + 'OS 権限のシェルで実行する — つまり touch 集合の中に書いたコードの**実行時の副作用**は '
      + '制限の外にある。集合の外へ副作用を出すコードを書かないこと (CI と同じ約束事)。',
    );
    for (const warning of narrowed.warnings ?? []) lines.push(`- ⚠️ ${warning}`);
    if (narrowed.rejected?.length) {
      lines.push(
        '- ⚠️ 次の指定は 1 ファイルに絞り込めなかったため編集できない:',
        narrowed.rejected.map((r) => `  - ${r.path} — ${r.reason}`).join('\n'),
      );
    }
  } else {
    lines.push('**touch 制限が有効だが、絞り込みは適用されていない。** 集合の外は触らないこと。');
  }
  return lines.join('\n');
}

/**
 * 直前の報告をプロンプトへ載せる形 (検収する側が読む)。
 *
 * **これは自己申告**であって証拠ではない。検収の機械的な材料は
 * スレッドの「📋 実行前後の git status 差分」なので、突き合わせろとまで書く
 * (roles/manager.md が求めている検収手順を、構造化した側からも支える)。
 */
export function renderReport(contract) {
  if (!isPlainObject(contract)) return '';
  const list = (items) => (items ?? []).map((i) => `- ${i}`).join('\n') || '- (なし)';
  return [
    '# 直前の報告 (ブリッジが構造化して受け取った。検収はこの一覧と実物を突き合わせる)',
    '',
    `## 変更ファイル (自己申告)\n${list(contract.changed_files)}`,
    `## やったこと\n${list(contract.did)}`,
    `## 検証結果\n${contract.verification ?? ''}`,
    `## 残課題\n${list(contract.remaining)}`,
    '',
    '**変更ファイルはワーカーの自己申告。** スレッドに出ている「📋 実行前後の git status 差分」と',
    '突き合わせ、集合外の変更が混ざっていないかを自分で確かめること。',
  ].join('\n');
}

/**
 * スカウトの起票をプロンプトへ載せる形 (承認する側が読む)。
 *
 * **承認するまで着手されない** (タスクボードの proposed → approved)。
 * 検収と同じで、ここに出るのは提案そのものであって既に決まったことではない —
 * 承認側が見るべき軸 (方向性との整合・重複・粒度) を渡す側からも書いておく。
 */
export function renderProposal(contract) {
  if (!isPlainObject(contract)) return '';
  const tasks = Array.isArray(contract.tasks) ? contract.tasks : [];
  const lines = ['# 起票されたタスク案 (ブリッジが構造化して受け取った。承認の対象はこの一覧)', ''];
  if (tasks.length === 0) {
    lines.push('- (なし — 今回は起票なし)');
  } else {
    tasks.forEach((task, i) => {
      const budget = Number.isSafeInteger(task?.job_budget) ? ` / job 予算 ${task.job_budget}` : '';
      lines.push(`## ${i + 1}. ${task?.title ?? ''}${budget}`, `${task?.rationale ?? ''}`);
      // touch は承認の判断材料 (粒度と対象が題名どおりか)。無い起票は様式で落ちるが、
      // 描画側は落とさずに「宣言なし」と出す — 承認者が黙って通さないように
      const touch = Array.isArray(task?.touch) ? task.touch : [];
      lines.push(`touch: ${touch.length > 0 ? touch.join(' / ') : '(宣言なし)'}`);
    });
  }
  lines.push(
    '',
    '**承認するまで着手されない。** 方向性ドキュメントとの整合・既存タスクとの重複・',
    '1 スレッドで完結する粒度かを見て、承認するものだけをボードへ通すこと。',
  );
  return lines.join('\n');
}

/**
 * ボードのタスク → 承認契約の参考欄。**純粋** — 呼び出し側が渡した並びを保つ。
 *
 * 今回の承認待ち (`pending` に出ているもの) は `excludeIds` で外す — 参考欄に自分自身が
 * 並ぶと「既に同じタスクがある」に見える。`MAX_ITEMS` を超える分は末尾を落とす:
 * 呼び出し側 (`scoutBoardView` — src/board.js) が非終端を先・merged を後に並べているので、
 * 落ちるのは着地済みの方から。**ここで落とすのは契約の上限に当てて承認 job ごと
 * 失わないため**で、上限に当たること自体は起票の枠が別に止める。
 *
 * @param {object[]} tasks ボードのタスク (id / state / title / touch を読む)
 * @param {{excludeIds?: Array<string|number>}} options
 * @returns {Array<{id: string, state: string, title: string, touch?: string[]}>}
 */
export function approvalBoard(tasks, { excludeIds = [] } = {}) {
  const skip = new Set(
    (Array.isArray(excludeIds) ? excludeIds : []).map((id) => String(id)),
  );
  const out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (out.length >= MAX_ITEMS) break;
    const id = String(task?.id ?? '');
    const state = String(task?.state ?? '');
    const title = String(task?.title ?? '');
    // 様式が空文字を拒むので、欠けているものは載せない (承認 job ごと落とさない)
    if (id === '' || state === '' || title === '' || skip.has(id)) continue;
    const item = { id, state, title };
    const touch = (Array.isArray(task?.touch) ? task.touch : [])
      .filter((path) => typeof path === 'string' && path.trim() !== '')
      .map((path) => path.trim())
      .slice(0, MAX_ITEMS);
    if (touch.length > 0) item.touch = touch;
    out.push(item);
  }
  return out;
}

/**
 * 承認待ちの一覧をプロンプトへ載せる形 (承認する側が読む)。
 *
 * **ボードの id をそのまま出す**のが要点。承認の応答は id で返ってくるので、
 * ここに出ていない id は「今回の起票ではない」として弾ける (src/scheduler.js)。
 *
 * 後から足したのは **touch と参考欄**。承認する側が見ていたのは id / title / 理由 /
 * 予算だけで、重複を見つける材料が無かった (#46 の重複がそのまま通った)。
 * 逆に**予算は判断材料から外す** — 下限 (`MIN_TASK_JOB_BUDGET`) と上限
 * (`taskJobBudget`) は機構が見ているので、承認者が読むと二重の門になる。
 */
export function renderApproval(contract) {
  if (!isPlainObject(contract)) return '';
  const pending = Array.isArray(contract.pending) ? contract.pending : [];
  const lines = ['# 承認待ちのタスク (ブリッジが構造化して受け取った。承認の対象はこの一覧)', ''];
  if (pending.length === 0) {
    lines.push('- (なし)');
  } else {
    for (const task of pending) {
      const budget = Number.isSafeInteger(task?.job_budget) ? ` / job 予算 ${task.job_budget}` : '';
      lines.push(
        `## id \`${task?.id ?? ''}\` — ${task?.title ?? ''}${budget}`,
        `${task?.rationale ?? '(理由の記載なし)'}`,
        `touch: ${touchLine(task?.touch)}`,
      );
    }
  }
  const board = Array.isArray(contract.board) ? contract.board : [];
  lines.push(
    '',
    '## 参考: いまボードにあるもの (非終端と直近 48 時間の merged)',
    ...(board.length === 0
      ? ['- (なし)']
      : board.map(
        (task) => `- [${task?.state ?? ''}] #${task?.id ?? ''}: ${task?.title ?? ''}`
          + ` (touch: ${touchLine(task?.touch)})`,
      )),
    '',
    '## 見る点',
    '- **①重複** — 同じ仕事・言い換えが参考欄に無いか。**touch が重なるものは特に疑う**',
    '- **②範囲** — 方向性ドキュメントとの整合。touch がその範囲内か (関係ない場所を掴んでいないか)',
    '- **③粒度** — touch ≤ 5 を目安に、1 スレッドで完結する大きさか',
    '- **job 予算は判断材料にしない** — 下限も上限も機構が見ている',
    '',
    '通すものの id を `approve` に、落とすものを理由つきで `drop` に書くこと。',
    '**どちらにも書かなかった id は自動で破棄される** (幽霊の承認待ちを残さないため)。',
    '本当に要るものを落としても、次の巡回で改めて起票される。',
  );
  return lines.join('\n');
}

/** touch の 1 行表記。宣言が無ければそう書く (空欄だと「見落とし」と区別できない) */
function touchLine(touch) {
  const list = (Array.isArray(touch) ? touch : [])
    .filter((path) => typeof path === 'string' && path.trim() !== '');
  return list.length > 0 ? list.join(' / ') : '(宣言なし)';
}

/**
 * レビュー依頼をプロンプトへ載せる形。
 *
 * **手順まで書く。** ここが「1 タスク = 1 マージコミット」を守れる唯一の場所で、
 * ブリッジは git を持たない — merge を実行するのはレビューする側の shell 仕事。
 */
export function renderReview(contract) {
  if (!isPlainObject(contract)) return '';
  const target = (Array.isArray(contract.target) ? contract.target : [])[0] ?? null;
  const budget = Number.isSafeInteger(target?.job_budget) ? ` / job 予算 ${target.job_budget}` : '';
  return [
    '# レビュー対象 (ブリッジが構造化して受け取った。判定を返すまでがこの job)',
    '',
    target
      ? `## id \`${target.id ?? ''}\` — ${target.title ?? ''}${budget}\nブランチ: \`${target.branch ?? ''}\``
      : '- (対象が渡されていない — 判定せず人間に確認すること)',
    '',
    '## 手順',
    `- \`${target?.branch ?? 'task/<id>'}\` の diff と**実ファイルの両方**を自分で確認する`,
    '- テストを回す (通ることを自分で確かめてから通す — 報告の自己申告を信用しない)',
    '- 通れば **main へ `merge --no-ff`** して、`verdict: "merge"` と `merge_commit` を返す',
    '  (1 タスク = 1 マージコミット = `git revert` 一発で戻せる単位)',
    '- **`merge_commit` は必須** (16 進 7〜40 桁)。ブリッジが「実在する / base に入っている /',
    '  そのブランチの成果を含む」を git で照合し、通らなければ merged にせず review のまま返す',
    '- **適用 task (org-apply) だけは例外**: merge を打つのはブリッジ自身なので、検収の時点で',
    '  マージコミットはまだ無い。`merge_commit` には**検収した commit** (依頼の案内に出ている',
    '  適用 commit の OID = 作業ツリーの HEAD) を書く。ブリッジが receipt と一致するか確かめる',
    '- 直させるなら `verdict: "send-back"` + 理由。**理由は必須**で、',
    '  直す側がそのまま作業に移れる具体さで書く (ファイル:行 / 失敗シナリオ / 推奨する直し方)',
    '- 詰んだ (原因不明で落ち続ける・仕様の裁定が要る) なら `verdict: "block"` + 理由',
    '- 対象そのものが不要 (別のタスクと重複・既に着地済み) なら `verdict: "drop"` + 理由。',
    '  **ブランチは消さない** (残しても実害はディスクだけで、消す判断はここに無い)',
    '',
    '**差し戻しは 2 回まで。** 2 回目の差し戻しは自動で要人間 (blocked) になる。',
  ].join('\n');
}

/** 契約の種別に応じたプロンプトブロック */
export function renderForKind(kind, contract, narrowed = null) {
  if (kind === 'report') return renderReport(contract);
  if (kind === 'delegation') return renderContract(contract, narrowed);
  if (kind === 'task-proposal') return renderProposal(contract);
  if (kind === 'task-approval') return renderApproval(contract);
  if (kind === 'task-review') return renderReview(contract);
  return '';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}
