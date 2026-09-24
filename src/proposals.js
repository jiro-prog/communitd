// 発議と組織提案のライフサイクル。
//
// 提案は `review → merged` を前提にする task board へは載せず、ここ (`data/proposals.json`) を
// 正本にする。採択後にコード変更が要るものだけ board へタスク化し、`taskIds[]` で結ぶ。
//
// このモジュールが持つのは**保存前に閉じるゲート**と状態機械だけ:
//   - `kind` の閉集合と `work | process | org` への写像 (bot に class を自己申告させない)
//   - `targets[]` の正規化・実在確認と `subjectKeys` の生成 (キーの組み立てはブリッジが独占する)
//   - `subjectKeys` の名前空間をまたぐ展開と競合判定 (1 subject に open な提案は高々 1 件)
//   - `change.touch` と diff の照合 (申告した対象と実際に触る場所を一致させる)
//   - 裁定の revision snapshot と digest (裁定は ID でなく「裁定した内容」に束縛する)
//
// class 別の裁定 UI と `org-apply` (適用エンジン = src/apply.js) はここには無い。
// ここは**その手前で決まっていなければならないこと**だけを閉じる層で、UI も適用も、
// この層が返す subjectKeys / digest / touch を根拠にして書く。適用の**記録**
// (`applyTaskId` / `receipt` / `applyAttempts[]`) だけは提案の状態の一部なのでここが持つ。

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { JsonStore } from './store.js';
import { POLICY_FILE, SECRETS_FILE, resolveAllowedTools } from './config.js';
import { TERMINAL_STATES } from './board.js';
import { applyDiffFile, diffTouchPaths, parseUnifiedDiff } from './diffs.js';
import { createPathResolver, isSafeRepoPath, samePathLoose, underPathLoose } from './repopath.js';

// ---- 閉集合 ----

/** 裁定権を分ける class。`org` だけが作者 (CEO) 専決 */
export const PROPOSAL_CLASSES = Object.freeze(['work', 'process', 'org']);

/** 直し先の序列 (`check > tooling > policy > role`)。並列の選択肢ではない */
export const REMEDIES = Object.freeze(['check', 'tooling', 'policy', 'role']);

/** target の操作。存在条件がこれで変わる */
export const TARGET_OPS = Object.freeze(['add', 'edit', 'remove']);

/** 関係 bot の意見。賛同と反論は同時に存在してよい */
export const POSITION_STANCES = Object.freeze(['second', 'contest']);

/** 状態機械。`adjudicated` の採否は `decision` が持つ */
export const PROPOSAL_STATES = Object.freeze([
  'raised', 'deliberating', 'adjudicated', 'trial', 'measured', 'withdrawn',
]);

/** 効果測定の結果 */
export const PROPOSAL_OUTCOMES = Object.freeze(['effective', 'ineffective', 'reverted']);

/**
 * 裁定記録 (`adjudication`) が**いまも生きている**状態 (作者裁定 2026-09-04)。
 *
 * `deliberating` へ戻した提案にも裁定記録は監査のために残るが、そちらは履歴でしかない —
 * 戻す判断そのものが「裁定時と食い違っている」なので、戻した後に digest を照合すると
 * **再裁定が構造的に不可能**になる (`revalidate` の注記)。
 */
const LIVE_ADJUDICATION_STATES = Object.freeze(['adjudicated', 'trial']);

/**
 * 遷移と一緒に書き換えてよいフィールド。
 * ここに無いもの (とりわけ `class` / `kind` / `subjectKeys` / `input`) は、
 * 提案の**同一性**を決めるので状態遷移では動かさない。
 */
const PATCHABLE_FIELDS = Object.freeze(['decision', 'outcome', 'trial']);

/**
 * 許される遷移。**ここに無い辺は API が拒否する** (board.js と同じ作り)。
 *
 * `raised → deliberating → adjudicated` が幹。採択された `process | org` は
 * `trial → measured`、`work` は task 化して完了後に `measured` へ直接進む。
 * 裁定後に前提が変わったとき (digest 不一致・差し戻し・verify NG) は
 * `deliberating` へ戻して**新しい revision で再裁定**にかける。
 */
export const PROPOSAL_TRANSITIONS = Object.freeze({
  raised: Object.freeze(['deliberating', 'withdrawn']),
  deliberating: Object.freeze(['adjudicated', 'withdrawn']),
  adjudicated: Object.freeze(['trial', 'measured', 'deliberating', 'withdrawn']),
  trial: Object.freeze(['measured', 'deliberating', 'withdrawn']),
  measured: Object.freeze([]),
  withdrawn: Object.freeze([]),
});

/**
 * bot が書いてよい入力側フィールド。`subjectKeys` も state も履歴もここには無い。
 *
 * **公開しているのは契約スキーマ (src/contract.js の report.initiative) と
 * 綴りが同じであることをテストで固定するため。** 検証を通った値をそのまま
 * `raise()` へ渡す作りなので、片方だけ名前が変わると全部「未知のキー」で落ちる。
 */
export const PROPOSAL_INPUT_KEYS = Object.freeze([
  'kind', 'targets', 'duty', 'summary', 'evidence', 'remedy', 'change', 'benefits', 'risks',
  'cost', 'trial',
]);
const INPUT_KEYS = PROPOSAL_INPUT_KEYS;

const CHANGE_KEYS = ['touch', 'diff'];
const TRIAL_KEYS = ['deadline', 'successCriteria', 'rollback'];

/** 英小文字・数字・`-` だけ (新設 bot の slug) */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 適用の基点。**ref ではなく commit OID** — 名前は裁定と適用の間に動く */
const COMMIT_OID = /^[0-9a-f]{40}$/i;

const fail = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isStringArray = (v) => Array.isArray(v) && v.every((x) => isNonEmptyString(x));
const isoAt = (now) => new Date(now).toISOString();

/**
 * 秘密側のファイルは派生物まで含めて対象外 (安全境界)。
 *
 * **大小文字を無視して比べる。** Windows では `CONFIG.SECRETS.JSON` が同じ実体を指すうえ、
 * 秘密ファイルがまだ無い環境では resolver 側の別名検出も効かない (存在しないので
 * 「大小文字だけ違う既存の名前」に当たらない) — 文字列側でも塞いでおく。
 */
export function isSecretPath(path) {
  if (typeof path !== 'string') return false;
  const lower = path.toLowerCase();
  const secret = SECRETS_FILE.toLowerCase();
  return lower === secret || lower.startsWith(`${secret}.`);
}

// ---- kind の表 (「subjectKeys の生成規則」) ----
//
// 各 kind は target 1 件を `{key, required, allowed, ops}` へ写す関数を持つ。
//   key      … その target が生む subjectKey
//   required … touch の下限 (必ず含まれていなければならない)
//   allowed  … touch の上限に足せる分 (含めても含めなくてもよい)
//   ops      … パスごとに許す diff の操作 (`create` / `edit` / `delete`)
// 表に無い kind は保存前に拒否する。

const EDIT = ['edit'];
const CREATE = ['create'];
const DELETE = ['delete'];
const CREATE_OR_EDIT = ['create', 'edit'];
const ANY_OP = ['create', 'edit', 'delete'];

const KINDS = Object.freeze({
  'role-edit': {
    class: 'org',
    target(t, ctx) {
      const bot = needBot(t, ctx, ['botKey']);
      if (!bot.ok) return bot;
      const doc = roleDocOf(ctx, bot.value);
      return target(`role:${bot.value}`, { required: [doc], ops: { [doc]: EDIT } });
    },
  },
  'role-retire': {
    class: 'org',
    target(t, ctx) {
      const bot = needBot(t, ctx, ['botKey']);
      if (!bot.ok) return bot;
      const doc = roleDocOf(ctx, bot.value);
      if (!ctx.fileExists(doc)) return fail(`${doc} がありません (廃止する role 文書が無い)`);
      const shared = roleDocSharedBy(ctx, bot.value);
      if (shared.length > 0) {
        return fail(`${doc} は ${shared.join(' / ')} も使っています (消すと巻き添えになります)`);
      }
      return target(`role:${bot.value}`, {
        required: [POLICY_FILE, doc],
        ops: { [POLICY_FILE]: EDIT, [doc]: DELETE },
        // 廃止は policy 上の bot が**実際に消えている**ことまで要求する
        pointer: `/bots/${bot.value}`,
        op: 'remove',
      });
    },
  },
  'role-create': {
    class: 'org',
    target(t, ctx) {
      const slug = needSlug(t, ctx, ['slug']);
      if (!slug.ok) return slug;
      const doc = newRoleDoc(slug.value);
      if (ctx.fileExists(doc)) return fail(`${doc} は既にあります (新設できません)`);
      return target(`role:new/${slug.value}`, {
        required: [POLICY_FILE, doc],
        ops: { [POLICY_FILE]: EDIT, [doc]: CREATE },
        // 新設は policy 上の bot が**実際に増えている**ことまで要求する
        pointer: `/bots/${slug.value}`,
        op: 'add',
      });
    },
  },
  'duty-edit': {
    class: 'org',
    target(t, ctx) {
      const bot = needBot(t, ctx, ['botKey', 'dutyKey', 'op']);
      if (!bot.ok) return bot;
      const op = needOp(t);
      if (!op.ok) return op;
      if (!isNonEmptyString(t.dutyKey)) return fail('duty-edit の dutyKey がありません');
      const duties = ctx.policy?.bots?.[bot.value]?.duties;
      const exists = isPlainObject(duties) && Object.hasOwn(duties, t.dutyKey);
      if (op.value === 'add' && exists) return fail(`duty ${t.dutyKey} は既にあります (op:add では追加できません)`);
      if (op.value !== 'add' && !exists) return fail(`duty ${t.dutyKey} がありません (op:${op.value} には実在が要ります)`);
      const doc = roleDocOf(ctx, bot.value);
      return target(`duty:${bot.value}/${t.dutyKey}`, {
        required: [POLICY_FILE],
        allowed: [doc],
        ops: { [POLICY_FILE]: EDIT, [doc]: EDIT },
        pointer: `/bots/${bot.value}/duties/${t.dutyKey}`,
        op: op.value,
      });
    },
  },
  staffing: {
    class: 'org',
    target(t, ctx) {
      const op = needOp(t);
      if (!op.ok) return op;
      if (op.value === 'add') {
        const slug = needSlug(t, ctx, ['slug', 'op']);
        if (!slug.ok) return slug;
        const doc = newRoleDoc(slug.value);
        if (ctx.fileExists(doc)) return fail(`${doc} は既にあります (増員できません)`);
        return target(`role:new/${slug.value}`, {
          required: [POLICY_FILE, doc],
          ops: { [POLICY_FILE]: EDIT, [doc]: CREATE },
          pointer: `/bots/${slug.value}`,
          op: 'add',
        });
      }
      const bot = needBot(t, ctx, ['botKey', 'op']);
      if (!bot.ok) return bot;
      const doc = roleDocOf(ctx, bot.value);
      if (op.value === 'remove') {
        if (!ctx.fileExists(doc)) return fail(`${doc} がありません (廃止する role 文書が無い)`);
        const shared = roleDocSharedBy(ctx, bot.value);
        if (shared.length > 0) {
          return fail(`${doc} は ${shared.join(' / ')} も使っています (消すと巻き添えになります)`);
        }
        return target(`role:${bot.value}`, {
          required: [POLICY_FILE, doc],
          ops: { [POLICY_FILE]: EDIT, [doc]: DELETE },
          pointer: `/bots/${bot.value}`,
          op: 'remove',
        });
      }
      return target(`role:${bot.value}`, {
        required: [POLICY_FILE],
        allowed: [doc],
        ops: { [POLICY_FILE]: EDIT, [doc]: EDIT },
        pointer: `/bots/${bot.value}`,
        op: 'subtree',
      });
    },
  },
  'tool-grant': {
    class: 'org',
    target(t, ctx) {
      const extra = onlyKeys(t, ['channel', 'tool', 'op']);
      if (extra) return fail(extra);
      const op = needOp(t);
      if (!op.ok) return op;
      // toolsExtra は配列で、扱えるのは要素の**出し入れ**だけ。`edit` を許すと
      // 「1 ツールを足す/外す」以外の配列操作が op の名前で通ってしまう
      if (op.value === 'edit') return fail('tool-grant の op は add か remove だけです');
      if (!isNonEmptyString(t.channel) || !isNonEmptyString(t.tool)) {
        return fail('tool-grant は channel と tool が要ります');
      }
      const cc = ctx.policy?.channels?.[t.channel];
      if (!isPlainObject(cc)) return fail(`チャンネル ${t.channel} が policy にありません`);
      // allowedTools 直書きのチャンネルでは toolsExtra が無視される = 通しても何も変わらない
      if (Array.isArray(cc.allowedTools)) {
        return fail(`${t.channel} は allowedTools を直書きしているため tool-grant では変えられません (policy-edit へ回す)`);
      }
      const inExtra = (cc.toolsExtra ?? []).includes(t.tool);
      if (op.value === 'add' && resolveAllowedTools(cc).includes(t.tool)) {
        return fail(`${t.tool} は既に ${t.channel} の権限に含まれています`);
      }
      if (op.value !== 'add' && !inExtra) {
        return fail(`${t.tool} は ${t.channel} の toolsExtra にありません`);
      }
      return target(`tool:${t.channel}/${t.tool}`, {
        required: [POLICY_FILE],
        ops: { [POLICY_FILE]: EDIT },
        membership: { channel: t.channel, tool: t.tool, op: op.value },
      });
    },
  },
  'policy-edit': {
    class: 'org',
    target(t, ctx) {
      const extra = onlyKeys(t, ['pointer', 'op']);
      if (extra) return fail(extra);
      const op = needOp(t);
      if (!op.ok) return op;
      const parsed = parsePointer(t.pointer);
      if (!parsed.ok) return parsed;
      if (parsed.segments.length === 0) return fail('policy-edit でルート全体は指せません');
      const here = resolvePointer(ctx.policy, parsed.segments);
      if (!here.ok) return here;
      if (op.value === 'add') {
        const parent = resolvePointer(ctx.policy, parsed.segments.slice(0, -1));
        if (!parent.ok || !parent.found) return fail(`親 pointer がありません: ${formatPointer(parsed.segments.slice(0, -1))}`);
        if (here.found) return fail(`${formatPointer(parsed.segments)} は既にあります (op:add では追加できません)`);
      } else if (!here.found) {
        return fail(`${formatPointer(parsed.segments)} がありません (op:${op.value} には実在が要ります)`);
      }
      return target(`policy:${formatPointer(parsed.segments)}`, {
        required: [POLICY_FILE],
        ops: { [POLICY_FILE]: EDIT },
        pointer: formatPointer(parsed.segments),
        op: op.value,
      });
    },
  },
  'governance-edit': {
    class: 'org',
    target(t, ctx) {
      const doc = needDoc(t, ctx);
      if (!doc.ok) return doc;
      // allowlist と governance の対象は排他 — allowlist 文書は恒久的に非規範文書で、
      // そこへ安全規定を書いても効かない (書けてしまうと process-edit 経由で改変できる)
      if (ctx.processEditAllowlist.some((d) => samePathLoose(d, doc.value))) {
        return fail(`${doc.value} は processEditAllowlist に載っているため governance-edit の対象にできません`);
      }
      return target(`doc:${doc.value}`, { required: [doc.value], ops: { [doc.value]: EDIT } });
    },
  },
  'process-edit': {
    class: 'process',
    target(t, ctx) {
      const doc = needDoc(t, ctx);
      if (!doc.ok) return doc;
      if (!ctx.processEditAllowlist.includes(doc.value)) {
        return fail(`${doc.value} は processEditAllowlist に無いため process-edit にできません (governance-edit として出し直す)`);
      }
      return target(`doc:${doc.value}`, { required: [doc.value], ops: { [doc.value]: EDIT } });
    },
  },
  'check-add': { class: 'work', target: pathTarget(CREATE_OR_EDIT) },
  'tooling-add': { class: 'work', target: pathTarget(CREATE_OR_EDIT) },
  'work-item': {
    class: 'work',
    target(t, ctx) {
      if (Object.hasOwn(t, 'taskId')) {
        const extra = onlyKeys(t, ['taskId']);
        if (extra) return fail(extra);
        const task = ctx.taskById(String(t.taskId));
        if (!task) return fail(`タスク ${t.taskId} がボードにありません`);
        // touch 不明の task は競合判定に使えない = 同じ対象への提案を止められない
        if (!isStringArray(task.touch) || task.touch.length === 0) {
          return fail(`タスク ${t.taskId} に touch がありません (touch 不明のタスクへは発議できません)`);
        }
        const ops = Object.fromEntries(task.touch.map((p) => [p, ANY_OP]));
        return target(`task:${String(t.taskId)}`, { allowed: task.touch, ops });
      }
      return pathTarget(ANY_OP)(t, ctx);
    },
  },
});

/** kind の閉集合 (表に無い kind は保存前に拒否) */
export const PROPOSAL_KINDS = Object.freeze(Object.keys(KINDS));

/** kind → class の写像。bot の自己申告ではなくここが正本 */
export function classForKind(kind) {
  return KINDS[kind]?.class ?? null;
}

/**
 * その提案が触ってよいパスの上限 (必須 ∪ 許可)。
 * 結ぶ task が提案の範囲に収まっているかを見るのに使う。
 */
export function touchScopeOf(input, ctx) {
  const spec = KINDS[input?.kind];
  if (!spec) return [];
  const scope = new Set();
  for (const raw of input.targets ?? []) {
    const one = spec.target(raw, ctx);
    if (!one.ok) continue;
    for (const path of [...one.required, ...one.allowed]) scope.add(path);
  }
  return [...scope];
}

function target(key, { required = [], allowed = [], ops = {}, pointer = null, op = null, membership = null }) {
  return { ok: true, key, required, allowed, ops, pointer, op, membership };
}

function pathTarget(ops) {
  return (t, ctx) => {
    const extra = onlyKeys(t, ['path']);
    if (extra) return fail(extra);
    if (!isSafeRepoPath(t.path)) return fail(`path として受け付けられません: ${t.path}`);
    // 新規ファイルを作れるように「親ディレクトリが実在」までを条件にする
    const parent = dirname(t.path);
    if (parent !== '.' && !ctx.dirExists(parent)) return fail(`${parent} がありません`);
    return target(`path:${t.path}`, { required: [t.path], ops: { [t.path]: ops } });
  };
}

/**
 * 新設する bot の役割文の置き場。まだ policy に居ないので決め打ちしかできない。
 */
const newRoleDoc = (slug) => `roles/${slug}.md`;

/**
 * 実在する bot の役割文。**policy の `rolePromptFile` が正本。**
 *
 * `roles/<botKey>.md` の決め打ちは既に破れていた — 同じ役割文を共有する 2 体目
 * (worker が 2 人) では実在しないパスを指し、`role-edit` も `duty-edit` も
 * 「その bot の憲章」を掴めていなかった。
 */
const roleDocOf = (ctx, key) => {
  const file = ctx?.policy?.bots?.[key]?.rolePromptFile;
  return isNonEmptyString(file) ? file.trim() : newRoleDoc(key);
};

/**
 * その役割文を他の bot も指しているか (共有されている憲章か)。
 *
 * **廃止 (`role-retire` / `staffing` の remove) は役割文を delete する**ので、共有された
 * ファイルを消すと巻き添えの bot が起動できなくなる。決め打ちの頃は 2 体目のパスが
 * 実在せず「文書が無い」で偶然止まっていたが、`rolePromptFile` を正本にすると届いてしまう。
 */
const roleDocSharedBy = (ctx, key) => {
  const doc = roleDocOf(ctx, key);
  const bots = ctx?.policy?.bots;
  if (!isPlainObject(bots)) return [];
  return Object.keys(bots)
    .filter((k) => k !== key && samePathLoose(roleDocOf(ctx, k), doc));
};

function onlyKeys(obj, keys) {
  if (!isPlainObject(obj)) return 'targets[] の要素がオブジェクトではありません';
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k));
  return unknown.length > 0 ? `target に未知のキーがあります: ${unknown.join(' / ')}` : null;
}

function needBot(t, ctx, keys) {
  const extra = onlyKeys(t, keys);
  if (extra) return fail(extra);
  if (!isNonEmptyString(t.botKey)) return fail('target の botKey がありません');
  if (!isPlainObject(ctx.policy?.bots) || !Object.hasOwn(ctx.policy.bots, t.botKey)) {
    return fail(`bot ${t.botKey} が policy にありません`);
  }
  return { ok: true, value: t.botKey };
}

function needSlug(t, ctx, keys) {
  const extra = onlyKeys(t, keys);
  if (extra) return fail(extra);
  if (!isNonEmptyString(t.slug) || !SLUG.test(t.slug)) {
    return fail(`slug は英小文字・数字・- だけで書きます: ${t.slug}`);
  }
  if (isPlainObject(ctx.policy?.bots) && Object.hasOwn(ctx.policy.bots, t.slug)) {
    return fail(`bot ${t.slug} は既にあります (新設できません)`);
  }
  return { ok: true, value: t.slug };
}

function needOp(t) {
  if (!TARGET_OPS.includes(t?.op)) return fail(`target の op は ${TARGET_OPS.join(' / ')} のどれかです`);
  return { ok: true, value: t.op };
}

function needDoc(t, ctx) {
  const extra = onlyKeys(t, ['doc']);
  if (extra) return fail(extra);
  if (!isSafeRepoPath(t.doc)) return fail(`doc として受け付けられません: ${t.doc}`);
  if (!ctx.fileExists(t.doc)) return fail(`${t.doc} がありません`);
  return { ok: true, value: t.doc };
}

// ---- RFC 6901 pointer ----

/**
 * pointer を segment 列へ。ルートは `/` とも `''` とも書ける
 * (`config.policy.json` に空文字キーは無いので、RFC の「`/` = 空文字キー」と衝突しない)。
 */
export function parsePointer(pointer) {
  if (typeof pointer !== 'string') return fail('pointer が文字列ではありません');
  if (pointer === '' || pointer === '/') return { ok: true, segments: [] };
  if (!pointer.startsWith('/')) return fail(`pointer は / で始めます: ${pointer}`);
  const segments = [];
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return fail(`pointer のエスケープが不正です: ${pointer}`);
    if (raw === '') return fail(`pointer に空のセグメントがあります: ${pointer}`);
    segments.push(raw.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return { ok: true, segments };
}

/** segment 列を pointer 文字列へ (ルートは `/`) */
export function formatPointer(segments) {
  if (!segments || segments.length === 0) return '/';
  return `/${segments.map((s) => String(s).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/**
 * pointer を辿る。**配列の中へは入らない** — 配列の要素は並べ替えで pointer が壊れるので、
 * 指せるのは配列そのものまで (変更 pointer の導出も配列は丸ごと 1 件として出す)。
 */
function resolvePointer(root, segments) {
  let node = root;
  for (let i = 0; i < segments.length; i += 1) {
    if (Array.isArray(node)) return fail(`配列の要素は pointer で指せません: ${formatPointer(segments)}`);
    if (!isPlainObject(node)) return { ok: true, found: false, value: undefined };
    if (!Object.hasOwn(node, segments[i])) return { ok: true, found: false, value: undefined };
    node = node[segments[i]];
  }
  return { ok: true, found: true, value: node };
}

// ---- subjectKeys の展開と競合判定 ----

/**
 * subjectKey を正規化された対象集合へ展開する。**名前空間をまたいで比べるため**に要る —
 * `role:sol` と `policy:/bots/sol` を別物として通すと、bot の廃止提案と同じ bot の
 * duty 編集が同時に走る。
 */
export function expandSubjectKey(key, ctx) {
  if (typeof key !== 'string') return [];
  if (key.startsWith('role:new/')) {
    const slug = key.slice('role:new/'.length);
    // `new/` は「まだ実在しない」印であって展開先には残さない
    return [`policy:/bots/${slug}`, `file:${newRoleDoc(slug)}`];
  }
  if (key.startsWith('role:')) {
    const bot = key.slice('role:'.length);
    return [`policy:/bots/${bot}`, `file:${roleDocOf(ctx, bot)}`];
  }
  if (key.startsWith('duty:')) {
    const [bot, ...rest] = key.slice('duty:'.length).split('/');
    return [`policy:${formatPointer(['bots', bot, 'duties', rest.join('/')])}`];
  }
  if (key.startsWith('tool:')) {
    const [channel] = key.slice('tool:'.length).split('/');
    // 配列なので要素は指せない。同じ配列への同時編集は実際に衝突するのでコンテナで競合させる
    return [`policy:${formatPointer(['channels', channel, 'toolsExtra'])}`];
  }
  if (key.startsWith('path:')) return [`file:${key.slice('path:'.length)}`];
  if (key.startsWith('doc:')) return [`file:${key.slice('doc:'.length)}`];
  if (key.startsWith('task:')) {
    const id = key.slice('task:'.length);
    const task = ctx?.taskById?.(id) ?? null;
    return [key, ...touchEntries(task?.touch)];
  }
  if (key.startsWith('policy:')) return [key];
  return [key];
}

/** touch 集合 → 展開後の対象集合 (`config.policy.json` を含むなら policy のルートも) */
function touchEntries(touch) {
  if (!isStringArray(touch)) return [];
  const entries = touch.map((p) => `file:${p}`);
  if (touch.includes(POLICY_FILE)) entries.push('policy:/');
  return entries;
}

/** subjectKeys をまとめて展開する */
export function expandSubjectKeys(keys, ctx) {
  return [...new Set((keys ?? []).flatMap((k) => expandSubjectKey(k, ctx)))];
}

/**
 * 展開後の対象集合が 1 つでも包含関係にあるか。
 * `policy:` は RFC 6901 の**セグメント列**で比べる (文字列 prefix だと
 * `/bots/sol` が `/bots/solaris` を誤って包含する)。`file:` と `task:` は完全一致のみ。
 */
export function entriesConflict(rawA, rawB) {
  // `file:` は**大小文字を無視して**比べる — Windows では `new.txt` と `NEW.TXT` が
  // 同じ実体なので、まだ存在しないファイル同士でも二重発議になる。
  // `policy:` は JSON のキーなので大小文字は意味を持つ (そのまま比べる)
  const norm = (e) => (e.startsWith('file:') ? e.toLowerCase() : e);
  const a = rawA.map(norm);
  const b = rawB.map(norm);
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.startsWith('policy:') && y.startsWith('policy:')) {
        const sx = parsePointer(x.slice('policy:'.length));
        const sy = parsePointer(y.slice('policy:'.length));
        if (!sx.ok || !sy.ok) continue;
        if (isPrefix(sx.segments, sy.segments) || isPrefix(sy.segments, sx.segments)) return true;
      }
    }
  }
  return false;
}

function isPrefix(outer, inner) {
  if (outer.length > inner.length) return false;
  return outer.every((seg, i) => seg === inner[i]);
}

/** 2 つの subjectKeys 集合が競合するか (展開してから包含を見る) */
export function subjectsConflict(a, b, ctx) {
  return entriesConflict(expandSubjectKeys(a, ctx), expandSubjectKeys(b, ctx));
}

/**
 * open なタスクと競合するか。**touch を持たないタスクは何とでも競合する** —
 * 競合判定に使えない以上「触っているかもしれない」と見なす (fail-closed)。
 */
export function taskConflicts(keys, task, ctx) {
  if (!isStringArray(task?.touch) || task.touch.length === 0) return true;
  return entriesConflict(expandSubjectKeys(keys, ctx), [`task:${task.id}`, ...touchEntries(task.touch)]);
}

// ---- 入力側の検証 ----

/** bot が書く `initiative-proposal` の形 (state も subjectKeys も履歴もここには無い) */
export function validateProposalInput(input) {
  if (!isPlainObject(input)) return fail('提案がオブジェクトではありません');
  if (Object.hasOwn(input, 'class')) {
    return fail('class は bot が申告しません (kind から機械が決めます)');
  }
  const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
  if (unknown.length > 0) return fail(`未知のキーを含みます: ${unknown.join(' / ')}`);

  if (!PROPOSAL_KINDS.includes(input.kind)) return fail(`未知の kind: ${input.kind}`);
  if (!Array.isArray(input.targets) || input.targets.length === 0) return fail('targets[] が空です');
  for (const field of ['duty', 'summary', 'cost']) {
    if (!isNonEmptyString(input[field])) return fail(`${field} が空です`);
  }
  if (!REMEDIES.includes(input.remedy)) return fail(`remedy は ${REMEDIES.join(' > ')} のどれかです`);
  for (const field of ['evidence', 'benefits', 'risks']) {
    if (!isStringArray(input[field])) return fail(`${field}[] は文字列の配列です`);
  }
  if (!isPlainObject(input.change)) return fail('change がありません');
  const changeUnknown = Object.keys(input.change).filter((k) => !CHANGE_KEYS.includes(k));
  if (changeUnknown.length > 0) return fail(`change に未知のキーがあります: ${changeUnknown.join(' / ')}`);
  if (!isStringArray(input.change.touch) || input.change.touch.length === 0) {
    return fail('change.touch が空です');
  }
  if (!isNonEmptyString(input.change.diff)) return fail('change.diff が空です');

  const klass = classForKind(input.kind);
  const trial = validateTrial(input.trial, klass);
  if (!trial.ok) return trial;
  return { ok: true };
}

/**
 * `trial` は期限・成功条件・ロールバック。
 * **`org` と `process` では必須** — この 2 つは状態機械が `trial → measured` を通るので、
 * 期限が無いと「期限切れを放置して仮配置を恒久化させない」監視ができない。
 */
function validateTrial(trial, klass) {
  const needed = klass === 'org' || klass === 'process';
  if (trial === undefined || trial === null) {
    return needed ? fail(`${klass} の提案には trial (期限・成功条件・ロールバック) が要ります`) : { ok: true };
  }
  if (!isPlainObject(trial)) return fail('trial がオブジェクトではありません');
  const unknown = Object.keys(trial).filter((k) => !TRIAL_KEYS.includes(k));
  if (unknown.length > 0) return fail(`trial に未知のキーがあります: ${unknown.join(' / ')}`);
  if (!isNonEmptyString(trial.deadline) || !Number.isFinite(Date.parse(trial.deadline))) {
    return fail('trial.deadline は日時 (ISO 8601) で書きます');
  }
  if (!isNonEmptyString(trial.successCriteria)) return fail('trial.successCriteria が空です');
  if (!isNonEmptyString(trial.rollback)) return fail('trial.rollback が空です');
  return { ok: true };
}

// ---- 予約対象の横断ゲート ----

/**
 * パスによって使える kind を class と無関係に縛る。
 * これが無いと `check-add` や `work-item` の `{path}` に `roles/<bot>.md` と書くだけで
 * `work` class として CEO ゲートを迂回できる。
 */
function reservedPathGate(kind, path, targets, ctx) {
  // 比較はすべて**大小文字を無視して**行う (Windows では別名が同じ実体を指す)
  if (isSecretPath(path)) return `${path} はどの kind からも対象にできません`;
  if (samePathLoose(path, POLICY_FILE)) {
    const allowed = ['policy-edit', 'duty-edit', 'role-edit', 'role-create', 'role-retire', 'staffing', 'tool-grant'];
    return allowed.includes(kind) ? null : `${POLICY_FILE} は ${kind} からは触れません`;
  }
  if (underPathLoose(path, 'roles/')) {
    const allowed = ['role-edit', 'role-create', 'role-retire', 'staffing', 'duty-edit'];
    if (!allowed.includes(kind)) return `roles/** は ${kind} からは触れません`;
    // duty-edit が触れるのは対象 bot の憲章だけ (他人の役割文書は書き換えさせない)
    if (kind === 'duty-edit' && !targets.some((t) => samePathLoose(roleDocOf(ctx, t.botKey), path))) {
      return 'duty-edit が触れるのは対象 bot の役割文 (policy の rolePromptFile) だけです';
    }
    return null;
  }
  if (path.toLowerCase().endsWith('.md')) {
    // 許す側 (process-edit) は完全一致・禁じる側 (governance-edit) は大小文字無視。
    // どちらも「安全側に倒す」向きで非対称にする
    const listedExact = ctx.processEditAllowlist.includes(path);
    const listedLoose = ctx.processEditAllowlist.some((doc) => samePathLoose(doc, path));
    if (!listedExact && kind !== 'governance-edit') {
      return `${path} は processEditAllowlist 外の文書なので governance-edit だけが対象にできます`;
    }
    if (listedLoose && kind === 'governance-edit') {
      return `${path} は processEditAllowlist に載っているため governance-edit の対象にできません`;
    }
  }
  return null;
}

// ---- 保存前の総合ゲート ----

/**
 * 提案を保存してよいか。**保存時・裁定時・task 化時・適用直前に同じものを通す。**
 *
 * @param {object} input bot が書いた `initiative-proposal`
 * @param {ProposalContext} ctx
 * @returns {{ok:true, kind, class, subjectKeys, touch, files} | {ok:false, reason}}
 */
export function checkProposal(input, ctx) {
  const shape = validateProposalInput(input);
  if (!shape.ok) return shape;

  const spec = KINDS[input.kind];
  const resolved = [];
  for (const raw of input.targets) {
    const one = spec.target(raw, ctx);
    if (!one.ok) return one;
    resolved.push(one);
  }

  const subjectKeys = [...new Set(resolved.map((r) => r.key))].sort();
  const required = [...new Set(resolved.flatMap((r) => r.required))];
  const allowed = [...new Set([...required, ...resolved.flatMap((r) => r.allowed)])];
  const ops = {};
  for (const r of resolved) {
    for (const [path, list] of Object.entries(r.ops)) {
      ops[path] = [...new Set([...(ops[path] ?? []), ...list])];
    }
  }

  const touch = input.change.touch;
  if (typeof ctx?.checkPath !== 'function') return fail('ctx.checkPath がありません (パスの実体を確かめられません)');
  // **秘密側は何よりも先に落とす。** 後段の実体判定でもだいたい落ちるが、
  // 安全境界は「なぜ落ちたか」が読める順番で置く
  for (const path of [...touch, ...required, ...allowed]) {
    if (isSecretPath(path)) return fail(`${SECRETS_FILE} はどの提案の対象にもできません`);
  }
  for (const path of touch) {
    if (!isSafeRepoPath(path)) return fail(`touch のパスとして受け付けられません: ${path}`);
    // 実体まで見る — 大小文字だけ違う別名・symlink / junction・リポジトリ外を落とす
    const resolvedPath = ctx.checkPath(path);
    if (!resolvedPath.ok) return fail(resolvedPath.reason);
  }
  // 重複は**大小文字を無視して**見る (Windows では同じ実体を 2 回書いたことになる)
  if (new Set(touch.map((p) => p.toLowerCase())).size !== touch.length) return fail('touch に重複があります');

  // touch は「必須を下限・許可を上限」で効かせる (三者一致にはしない)
  const missing = required.filter((p) => !touch.includes(p));
  if (missing.length > 0) return fail(`touch に必須のファイルがありません: ${missing.join(' / ')}`);
  const over = touch.filter((p) => !allowed.includes(p));
  if (over.length > 0) return fail(`touch が ${input.kind} で許された範囲を超えています: ${over.join(' / ')}`);

  for (const path of touch) {
    const reason = reservedPathGate(input.kind, path, input.targets, ctx);
    if (reason) return fail(reason);
  }

  const parsed = parseUnifiedDiff(input.change.diff);
  if (!parsed.ok) return parsed;
  const diffPaths = diffTouchPaths(parsed.files);
  const onlyInDiff = diffPaths.filter((p) => !touch.includes(p));
  const onlyInTouch = touch.filter((p) => !diffPaths.includes(p));
  if (onlyInDiff.length > 0 || onlyInTouch.length > 0) {
    return fail(
      'diff と touch が一致しません'
      + (onlyInDiff.length > 0 ? ` (diff だけ: ${onlyInDiff.join(' / ')})` : '')
      + (onlyInTouch.length > 0 ? ` (touch だけ: ${onlyInTouch.join(' / ')})` : ''),
    );
  }

  // **全ファイルへ実際に当ててみる。** 「当たること」「実際に中身が変わること」
  // 「操作後の存在条件を満たすこと」まで見ないと、旧内容が違う diff や
  // 文脈だけで実変更ゼロの diff が「対象を触った」ことになって通る
  const applied = {};
  for (const file of parsed.files) {
    const allowedOps = ops[file.path] ?? [];
    if (!allowedOps.includes(file.op)) {
      return fail(`${input.kind} は ${file.path} を ${file.op} できません (許すのは ${allowedOps.join(' / ') || 'なし'})`);
    }
    const exists = ctx.fileExists(file.path);
    if (file.op === 'create' && exists) return fail(`${file.path} は既にあります (create できません)`);
    if (file.op !== 'create' && !exists) return fail(`${file.path} がありません (${file.op} できません)`);

    const before = file.op === 'create' ? null : ctx.readFile(file.path);
    const result = applyDiffFile(file, before);
    if (!result.ok) return fail(`${file.path}: ${result.reason}`);
    if (file.op === 'delete') {
      if (result.after !== null) return fail(`${file.path} は削除後に残ります`);
    } else {
      if (result.after === null) return fail(`${file.path} は適用後に存在しません`);
      if (result.after === before) return fail(`${file.path} に実際の変更がありません`);
    }
    applied[file.path] = result.after;
  }

  // **target ごとに、その target の範囲内で実際に何か変わっていること。**
  // pointer を持つ target は後段でさらに細かく見るが、`work-item {taskId}` のように
  // pointer を持たない target も、余分に並べて subject (競合枠) だけ占有できてはいけない
  for (const one of resolved) {
    const scope = new Set([...one.required, ...one.allowed]);
    if (scope.size > 0 && !parsed.files.some((file) => scope.has(file.path))) {
      return fail(`target (${one.key}) に対応する変更が diff にありません`);
    }
  }

  const policyCheck = checkPolicyChanges(input.kind, resolved, parsed.files, ctx, applied);
  if (!policyCheck.ok) return policyCheck;

  return {
    ok: true,
    kind: input.kind,
    class: spec.class,
    subjectKeys,
    touch: [...touch].sort(),
    files: parsed.files,
    applied,
  };
}

/**
 * ファイル集合だけでなく **diff の実変更**を `targets[]` と突き合わせる。
 * 同じファイルの別の場所を変える提案は touch 判定では止まらないので、
 * `config.policy.json` については diff 適用後の JSON から変更 pointer 集合を導出して照合する。
 */
function checkPolicyChanges(kind, resolved, files, ctx, applied) {
  const file = files.find((f) => samePathLoose(f.path, POLICY_FILE));
  if (!file) return { ok: true };
  if (file.op !== 'edit') return fail(`${POLICY_FILE} は edit だけです`);

  const before = ctx.readFile(file.path);
  if (typeof before !== 'string') return fail(`${POLICY_FILE} を読めません`);
  let beforeJson;
  let afterJson;
  try {
    beforeJson = JSON.parse(before);
    afterJson = JSON.parse(applied[file.path]);
  } catch (err) {
    return fail(`diff 適用後の ${POLICY_FILE} を JSON として読めません: ${err.message}`);
  }

  const changes = changedPointers(beforeJson, afterJson);
  if (changes.length === 0) return fail(`${POLICY_FILE} を touch しているのに変更がありません`);

  // tool-grant は pointer ではなく toolsExtra の membership 差分で見る
  if (kind === 'tool-grant') {
    return checkMembership(resolved, beforeJson, afterJson, changes);
  }

  const expectations = resolved.filter((r) => r.pointer !== null);
  if (expectations.length === 0) return fail(`${kind} は ${POLICY_FILE} の変更 pointer を判定できません`);

  const parsedChanges = [];
  for (const change of changes) {
    const parsed = parsePointer(change.path);
    if (!parsed.ok) return parsed;
    parsedChanges.push({ ...change, segments: parsed.segments });
  }
  for (const change of parsedChanges) {
    const covered = expectations.some((exp) => coversChange(exp, change.segments, change.op));
    if (!covered) {
      return fail(`targets[] と食い違う変更です: ${change.path} (${change.op})`);
    }
  }
  // **target ごとに対応する変更が実在すること。** これが無いと、余分な target を
  // 宣言して subject (競合枠) だけ占有する提案が通る
  for (const exp of expectations) {
    const hit = parsedChanges.some((change) => coversChange(exp, change.segments, change.op));
    if (!hit) return fail(`${exp.pointer} に対応する変更が diff にありません (op:${exp.op})`);
  }
  return { ok: true };
}

/**
 * その変更 pointer が target の期待に収まるか。
 * **`op` は申告であると同時に制約**にする — `edit` と申告して対象ごと消す、
 * `add` と申告して別の場所を書き換える、といった食い違いを通さない。
 */
function coversChange(exp, changeSegments, changeOp) {
  const expSegments = parsePointer(exp.pointer);
  if (!expSegments.ok) return false;
  // role-* / staffing の編集は `/bots/<bot>` の子孫または同一で見る
  if (exp.op === 'subtree' || exp.op === 'edit') {
    if (!isPrefix(expSegments.segments, changeSegments)) return false;
    // 対象そのものの削除は edit では認めない (消すなら remove の提案として出す)
    return !(changeOp === 'remove' && sameSegments(expSegments.segments, changeSegments));
  }
  // add / remove は key そのものが完全一致であること
  if (exp.op === 'add') return changeOp === 'add' && sameSegments(expSegments.segments, changeSegments);
  if (exp.op === 'remove') return changeOp === 'remove' && sameSegments(expSegments.segments, changeSegments);
  return false;
}

const sameSegments = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * `toolsExtra` の membership 差分を `{tool, op}` と照合し、
 * **前後で `resolveAllowedTools` の結果が実際に変わる**ことまで確かめる
 * (preset に含まれるツールは toolsExtra から消しても残るので、これを見ないと
 *  「採択されたのに権限が変わらない」提案が通る)。
 */
function checkMembership(resolved, beforeJson, afterJson, changes) {
  // **channel ごとに期待を集合へまとめてから実差分と突き合わせる。**
  // target 単位で「追加はちょうど 1 件」と見ると、同じチャンネルへ 2 ツール足す
  // 正当な提案が落ちる (どちらの target から見ても差分が 2 件に見えるため)
  const byChannel = new Map();
  for (const m of resolved.map((r) => r.membership).filter(Boolean)) {
    if (!byChannel.has(m.channel)) byChannel.set(m.channel, { add: new Set(), remove: new Set() });
    byChannel.get(m.channel)[m.op === 'add' ? 'add' : 'remove'].add(m.tool);
  }
  for (const [channel, wanted] of byChannel) {
    const both = [...wanted.add].filter((tool) => wanted.remove.has(tool));
    if (both.length > 0) return fail(`${channel} の ${both.join(' / ')} を追加と削除の両方で指定しています`);
  }

  const pointers = new Set([...byChannel.keys()].map((ch) => formatPointer(['channels', ch, 'toolsExtra'])));
  for (const change of changes) {
    if (!pointers.has(change.path)) {
      return fail(`tool-grant が toolsExtra 以外を変更しています: ${change.path}`);
    }
  }

  for (const [channel, wanted] of byChannel) {
    const beforeCc = beforeJson?.channels?.[channel] ?? {};
    const afterCc = afterJson?.channels?.[channel] ?? {};
    if (Array.isArray(afterCc.allowedTools)) {
      return fail(`${channel} に allowedTools を足す変更は tool-grant では扱えません`);
    }
    const beforeExtra = new Set(beforeCc.toolsExtra ?? []);
    const afterExtra = new Set(afterCc.toolsExtra ?? []);
    const added = [...afterExtra].filter((tool) => !beforeExtra.has(tool));
    const removed = [...beforeExtra].filter((tool) => !afterExtra.has(tool));
    if (!sameTools(added, wanted.add) || !sameTools(removed, wanted.remove)) {
      return fail(
        `${channel} の toolsExtra 差分が targets[] と一致しません `
        + `(diff は 追加:${fmt(added)} 削除:${fmt(removed)} / targets は 追加:${fmt([...wanted.add])} 削除:${fmt([...wanted.remove])})`,
      );
    }
    // **ツールごとに**解決済み権限が実際に動くことまで見る。合計だけ見ると、
    // preset に含まれるツールの削除 (何も変わらない) が他のツールの追加に紛れて通る
    const beforeTools = new Set(resolveAllowedTools(beforeCc));
    const afterTools = new Set(resolveAllowedTools(afterCc));
    for (const tool of wanted.add) {
      if (beforeTools.has(tool) || !afterTools.has(tool)) {
        return fail(`${channel} の解決済み権限に ${tool} が増えていません`);
      }
    }
    for (const tool of wanted.remove) {
      if (!beforeTools.has(tool) || afterTools.has(tool)) {
        return fail(`${channel} の解決済み権限から ${tool} が減りません (preset に含まれるツールです)`);
      }
    }
  }
  return { ok: true };
}

const sameTools = (list, wanted) => list.length === wanted.size && list.every((tool) => wanted.has(tool));
const fmt = (list) => (list.length === 0 ? 'なし' : list.join(','));

/**
 * JSON Patch 相当の canonical な変更集合 (`add` / `remove` / `replace` の path)。
 * **配列は丸ごと 1 件**として扱う (要素の pointer は作らない — 並べ替えで壊れる)。
 */
export function changedPointers(before, after, segments = [], out = []) {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
      const here = [...segments, key];
      if (!Object.hasOwn(before, key)) out.push({ op: 'add', path: formatPointer(here) });
      else if (!Object.hasOwn(after, key)) out.push({ op: 'remove', path: formatPointer(here) });
      else changedPointers(before[key], after[key], here, out);
    }
    return out;
  }
  if (!deepEqual(before, after)) out.push({ op: 'replace', path: formatPointer(segments) });
  return out;
}

const deepEqual = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/** キー順に依存しない形 (digest と比較の両方で使う) */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

// ---- 裁定 snapshot と digest ----

/**
 * 裁定の瞬間に固める revision。**対象フィールドを列挙しない** — 列挙は必ず漏れ、
 * 漏れたところ (evidence や benefits) を承認後に書き換えれば監査記録を偽装できる。
 * 入力側を丸ごと入れ、加えて**裁定の前提とした外部状態**の digest も持つ。
 */
export function snapshotOf(proposal, ctx, { baseCommit = null } = {}) {
  const touch = [...(proposal?.input?.change?.touch ?? [])].sort();
  return {
    input: canonicalize(proposal?.input ?? null),
    subjectKeys: [...(proposal?.subjectKeys ?? [])].sort(),
    // **意見も裁定の前提。** 反論が付いたことを snapshot が知らないと、
    // カードを出した後に反論が入っても digest が変わらず、作者は反論を読まないまま
    // 古いカードから採択できてしまう (sol 指摘 2026-08-29)
    positions: canonicalize(proposal?.positions ?? []),
    external: {
      processEditAllowlist: [...(ctx?.processEditAllowlist ?? [])].sort(),
      files: Object.fromEntries(touch.map((p) => [p, fileRevision(ctx, p)])),
      baseCommit: baseCommit ?? null,
    },
  };
}

/** snapshot 全体の指紋。ID ではなく**これ**に裁定を束縛する (grants.js と同じ作り) */
export function proposalDigest(snapshot) {
  return createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex').slice(0, 16);
}

/**
 * 承認された diff そのものの指紋。receipt が「何を当てたか」を指すために使う。
 * snapshot 全体の digest とは別 — あちらは裁定の前提すべて、こちらは当てた本体だけ。
 */
export function diffDigestOf(diff) {
  return createHash('sha256').update(String(diff ?? '')).digest('hex').slice(0, 16);
}

/**
 * いまの内容の digest。**裁定カードをこれに束縛する** —
 * カードを出した後に内容が差し替わったら、押しても裁定させずに出し直す
 * (読んでいない内容を承認させない)。
 */
export function digestOf(proposal, ctx, options = {}) {
  return proposalDigest(snapshotOf(proposal, ctx, options));
}

/** 対象ファイルの revision (無ければ null — 「無い」ことも前提のうち) */
function fileRevision(ctx, path) {
  const text = ctx?.readFile?.(path);
  if (typeof text !== 'string') return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * その actor がこの class を裁定してよいか。**fail-closed** —
 * `ownerUserId` が渡らなければ誰も裁定できない (裁定不能な提案を黙って通さない)。
 *
 * @param {{class: string}} proposal
 * @param {{kind: string, userId?: string, botKey?: string}} actor
 *   Discord interaction で検証済みのものを渡す (bot キーの自称では通らない)
 * @param {{ownerUserId?: string, execBotKeys?: string[]}} authority
 *   execBotKeys は `work | process` を経営裁量で裁定できる bot (CEO 代理 = Fable)
 */
export function canAdjudicate(proposal, actor, { ownerUserId = null, execBotKeys = [] } = {}) {
  const klass = proposal?.class;
  if (!PROPOSAL_CLASSES.includes(klass)) return false;
  const isOwner = Boolean(ownerUserId)
    && actor?.kind === 'owner'
    && isNonEmptyString(actor?.userId)
    && actor.userId === ownerUserId;
  if (isOwner) return true;
  // 役割・権限・編成・予算 (= org) は作者だけ。bot キーでも「bot でない任意ユーザー」でも通さない
  if (klass === 'org') return false;
  return actor?.kind === 'bot' && isNonEmptyString(actor?.botKey) && execBotKeys.includes(actor.botKey);
}

// ---- 実行文脈 ----

/**
 * ゲートが見る外部状態。テストからは丸ごと差し替えられる。
 *
 * @typedef {object} ProposalContext
 * @property {object} policy               `config.policy.json` の現在値
 * @property {string[]} processEditAllowlist 非規範文書の allowlist
 * @property {(p: string) => object} checkPath パスの実体判定 (`{ok, kind}` / `{ok:false, reason}`)
 * @property {(p: string) => boolean} fileExists
 * @property {(p: string) => boolean} dirExists
 * @property {(p: string) => string|null} readFile
 * @property {(id: string) => object|null} taskById
 * @property {Array<{id: string, touch?: string[]}>} openTasks 終端でないタスク
 */

/**
 * 実リポジトリを見る文脈 (fs 依存はここだけ)。
 *
 * 実体判定は `createPathResolver` に一本化する。**`statSync` は使わない** —
 * link を辿るので、junction / symlink 越しのリポジトリ外の実体が
 * 「通常ファイル」に見えてしまう。
 */
export function createRepoContext({ cwd, policy, board = null, openTasks = null } = {}) {
  const resolver = createPathResolver({ cwd });
  const tasks = openTasks ?? (board ? openTasksOf(board) : []);
  const kindOf = (p) => {
    const resolved = resolver.check(p);
    return resolved.ok ? resolved.kind : null;
  };
  return {
    policy: policy ?? {},
    processEditAllowlist: Array.isArray(policy?.processEditAllowlist) ? policy.processEditAllowlist : [],
    checkPath: (p) => resolver.check(p),
    fileExists: (p) => kindOf(p) === 'file',
    dirExists: (p) => kindOf(p) === 'dir',
    readFile: (p) => resolver.read(p),
    taskById: (id) => (board ? board.get(id) : tasks.find((t) => String(t.id) === String(id)) ?? null),
    openTasks: tasks,
  };
}

/** 発議元の位置 (チャンネル / スレッド)。読めない値は持たない */
function normalizeOrigin(origin) {
  if (!isPlainObject(origin)) return null;
  const channelId = isNonEmptyString(origin.channelId) ? String(origin.channelId) : null;
  const threadId = isNonEmptyString(origin.threadId) ? String(origin.threadId) : null;
  return channelId || threadId ? { channelId, threadId } : null;
}

/** 終端でないタスクだけを競合判定の材料にする (touch が無いものは fail-closed で残す) */
export function openTasksOf(board) {
  return board.list()
    .filter((task) => !TERMINAL_STATES.includes(task.state))
    .map((task) => ({ id: task.id, touch: Array.isArray(task.touch) ? task.touch : null }));
}

// ---- ストア ----

/**
 * その提案が裁定待ち (`deliberating`) へ入った回数 = **再審議の世代**。
 *
 * 裁定 → drift で差し戻し → 再裁定、は同じ提案 ID の**別の依頼**なので、
 * 「前の世代で裁定 bot を起こし終えた」を理由に次の世代を配らないのは誤り
 * (sol 指摘 2026-08-30)。配送の勘定はこの世代ごとに持つ。
 */
export function deliberationCount(proposal) {
  const history = Array.isArray(proposal?.history) ? proposal.history : [];
  return history.filter((entry) => entry?.to === 'deliberating').length;
}

/** これ以上進まない提案 (`adjudicated:rejected` と `withdrawn`、および測定済み) */
export function isTerminal(proposal) {
  if (!proposal) return true;
  if (proposal.state === 'withdrawn' || proposal.state === 'measured') return true;
  return proposal.state === 'adjudicated' && proposal.decision === 'rejected';
}

export class ProposalStore extends JsonStore {
  /**
   * @returns {object|null} 壊れた値は無いものとして扱う
   *
   * **内部値そのものは返さない。** 参照を渡すと、受け取った側が `class` を書き換えるだけで
   * 保存済みの提案が変わり、CEO ゲート (org は作者だけ) を迂回できる。
   * 読み出しは複製、書き込みも複製 (`write`) にして、外から掴める参照を無くす。
   */
  get(id) {
    const proposal = this.data[String(id)];
    return isPlainObject(proposal) ? structuredClone(proposal) : null;
  }

  /** @param {{state?: string|string[], class?: string, open?: boolean}} filter */
  list({ state = null, class: klass = null, open = null } = {}) {
    const states = state === null ? null : [].concat(state);
    return Object.keys(this.data)
      .map((key) => this.get(key))
      .filter((p) => p !== null)
      .filter((p) => states === null || states.includes(p.state))
      .filter((p) => klass === null || p.class === klass)
      .filter((p) => open === null || isTerminal(p) !== open)
      .sort((a, b) => (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0));
  }

  /** 終端でない提案 (競合判定の相手) */
  openList() {
    return this.list({ open: true });
  }

  /** 裁定待ち (稟議通知とカード再掲の対象) */
  awaitingAdjudication({ class: klass = null } = {}) {
    return this.list({ state: 'deliberating', class: klass });
  }

  nextId() {
    let max = 0;
    for (const key of Object.keys(this.data)) {
      const n = Number.parseInt(key, 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  /**
   * 発議を保存する。**ゲートを通らなければ保存しない** (拒否時はディスクもメモリも動かない)。
   *
   * `id` / `raisedBy` / `ownerBotKey` / `subjectKeys` / `class` / state / 履歴は
   * ここで付与する — bot に自己申告させない。
   *
   * @throws {Error} ゲートに落ちたとき / 既存の open な提案・タスクと競合するとき
   */
  raise(input, { raisedBy, ctx, origin = null, now = Date.now() } = {}) {
    if (!isNonEmptyString(raisedBy)) throw new Error('raisedBy は必須です (ブリッジが付与します)');
    if (!ctx) throw new Error('ctx は必須です');
    const checked = checkProposal(input, ctx);
    if (!checked.ok) throw new Error(`提案を保存できません: ${checked.reason}`);

    // open な proposal は 1 つの subject につき高々 1 件。代表 1 件ではなく集合で見る
    for (const other of this.openList()) {
      if (subjectsConflict(checked.subjectKeys, other.subjectKeys, ctx)) {
        throw new Error(
          `提案 ${other.id} と対象が競合します (open な提案は 1 subject につき 1 件) — `
          + '意見 (positions) か検証へ切り替えてください',
        );
      }
    }
    for (const task of ctx.openTasks ?? []) {
      if (taskConflicts(checked.subjectKeys, task, ctx)) {
        throw new Error(`タスク ${task.id} と対象が競合します — 発議ではなくそのタスクで扱ってください`);
      }
    }

    const id = this.nextId();
    const at = isoAt(now);
    const proposal = {
      id,
      class: checked.class,
      state: 'raised',
      decision: null,
      outcome: null,
      raisedBy,
      ownerBotKey: raisedBy, // 追跡責任者の既定。人事へ移管したときはブリッジが付け替える
      // 稟議カードの投稿先。**発議の時点で記録する** — 後から「どのスレッドの話か」を
      // 推測すると、無関係なスレッドへ org の裁定カードが出る
      origin: normalizeOrigin(origin),
      subjectKeys: checked.subjectKeys,
      input: canonicalize(input),
      positions: [],
      revisions: [],
      adjudication: null,
      taskIds: [],
      // 適用回路 (src/apply.js) の記録。**`applyTaskId` は二重適用を防ぐ錠**で、
      // 一度立つと差し戻し (`failApply`) 以外では下りない。錠は revision と digest にも
      // 束縛する (`applyRevision` / `applyDigest`) — ID だけだと旧世代の失敗が新しい錠を
      // 落とせる。`receipt` は当てて verify に通った事実、`applyAttempts[]` は
      // 当て直しの回数 (board の差し戻しとは別勘定)
      applyTaskId: null,
      applyRevision: null,
      applyDigest: null,
      receipt: null,
      applyAttempts: [],
      trial: null,
      createdAt: at,
      updatedAt: at,
      history: [{ at, from: null, to: 'raised', by: raisedBy }],
    };
    this.write(id, proposal);
    return proposal;
  }

  /**
   * 関係 bot の意見。賛同と反論は同時に存在できるので、単一の現在状態にせず配列へ残す。
   * `by` は起動元 bot からブリッジが付与する (自己申告させない)。
   */
  addPosition(id, { by, stance, rationale = '', now = Date.now() } = {}) {
    const proposal = this.require(id);
    // **意見が言えるのは裁定の前まで。** 裁定後にも足せると、その提案の digest が
    // 動いて採択が再裁定へ差し戻される (誰でも止められる経路になる)。
    // 言い足りないことは新しい提案として出す
    if (!['raised', 'deliberating'].includes(proposal.state)) {
      throw new Error(`提案 ${id} は ${proposal.state} なので意見を足せません (意見は裁定の前まで)`);
    }
    if (!isNonEmptyString(by)) throw new Error('position の by は必須です (ブリッジが付与します)');
    if (!POSITION_STANCES.includes(stance)) {
      throw new Error(`stance は ${POSITION_STANCES.join(' / ')} のどちらかです`);
    }
    const at = isoAt(now);
    const positions = [...proposal.positions, { at, by, stance, rationale: String(rationale ?? '') }];
    const next = { ...proposal, positions, updatedAt: at };
    // 意見が付いた時点で審議中。稟議通知はここから先でブリッジが出す
    if (next.state === 'raised') {
      next.state = 'deliberating';
      next.history = [...proposal.history, { at, from: 'raised', to: 'deliberating', by }];
    }
    this.write(proposal.id, next);
    return next;
  }

  /**
   * 審議へ送る (裁定待ちにする)。
   *
   * **引数はここで組み直す。** 呼び出し側の options をそのまま private 遷移へ
   * 渡すと、`patch` に相乗りして class を書き換えられる (org を work と偽って
   * CEO ゲートを迂回できる)。公開 API が渡してよいのは `now` / `by` / `note` だけ。
   */
  deliberate(id, { now = Date.now(), by = null, note = '' } = {}) {
    return this.#transition(id, 'deliberating', { now, by, note });
  }

  /**
   * 裁定。**裁定した内容に束縛する** — この瞬間の入力側と外部状態を revision として
   * 固め、その digest を裁定記録に持つ。以後の照合 (task 化・適用直前) はこの digest を見る。
   *
   * @param {{decision: 'accepted'|'rejected', actor: object, rationale?: string,
   *          ctx: object, ownerUserId?: string, execBotKeys?: string[],
   *          baseCommit?: string|null, now?: number}} options
   * @throws {Error} 権限が無いとき / 前提が裁定前に変わっていたとき
   */
  adjudicate(id, {
    decision, actor, rationale = '', ctx, ownerUserId = null, execBotKeys = [],
    baseCommit = null, now = Date.now(),
  } = {}) {
    const proposal = this.require(id);
    if (decision !== 'accepted' && decision !== 'rejected') {
      throw new Error('decision は accepted か rejected です');
    }
    if (!ctx) throw new Error('ctx は必須です');
    // **書く前に遷移の可否まで確かめる。** 後段で落とすと、裁定に失敗した提案へ
    // revision だけが積まれ、「何度も裁定されたように見える」記録が残る
    if (proposal.state !== 'deliberating') {
      throw new Error(
        `提案 ${proposal.id} は ${proposal.state} から adjudicated へ進めません `
        + '(提案の状態機械 PROPOSAL_TRANSITIONS に無い)',
      );
    }
    if (!canAdjudicate(proposal, actor, { ownerUserId, execBotKeys })) {
      throw new Error(
        `${proposal.class} の裁定権がありません`
        + (proposal.class === 'org' ? ' (org は作者の owner interaction だけが裁定できます)' : ''),
      );
    }
    // **却下には理由を必須にする** (UI ではなくここで強制する — 入口が増えても崩れない)。
    // 却下は終端なので、理由が残らないと同じ提案が再発議されて同じ議論を繰り返す。
    // 採択は提案本文と diff が「何を承認したか」を既に残しているので、理由が無くても
    // 記録は欠けない (**作者裁定 2026-08-30** — 採択のたびに理由を書かせる手数を外した)。
    // 権限の判定より後に置くのは、裁定権の無い相手へ「理由さえ書けば通る」と読める
    // 応答を返さないため
    if (proposal.class === 'org' && decision === 'rejected' && !isNonEmptyString(rationale)) {
      throw new Error(`提案 ${id} の却下には理由が要ります`);
    }
    // 裁定の直前にもう一度ゲートを通す (open 中に allowlist や対象ファイルが動いていることがある)。
    //
    // **却下は通さない** (作者裁定 2026-09-04)。再検証が見るのは「この diff がいまも当たるか」で、
    // 却下は終端で何も当てない — 当否を却下の可否に効かせる理由が無い。実機では、既に手で
    // 転記済みの提案が `checkProposal` で必ず落ち、**採択も却下もできないまま deliberating に
    // 残った**。「読んでいない内容を却下させない」保証は、ここではなくカードの digest 束縛
    // (`checkProposalBinding` — src/adjudication.js) が担っている。
    if (decision === 'accepted') {
      const revalidated = this.revalidate(id, ctx, { now });
      if (!revalidated.ok) throw new Error(`裁定できません: ${revalidated.reason}`);
    }

    // revalidate は状態を動かしうるので、固めるのは**読み直した現在値**
    const current = this.require(id);
    // **基点が無いまま採択させない** (org / process だけ)。基点の無い accepted は
    // `adjudicated:accepted` のまま誰も動かせなくなる — 適用は「基点が無い」で止まり、
    // 再裁定は `deliberating` からしか通らないので、取り下げるしか出口が無い
    // (Sol 指摘 2026-08-31)。却下と work は当てないので基点は要らない。
    //
    // **再検証より後に置く。** 先に見ると、allowlist から外れて本来 `withdrawn` に
    // すべき提案が「基点が無い」で止まり、行き先が決まらないまま残る (Sol 指摘 2026-08-31)
    if (decision === 'accepted' && current.class !== 'work' && !COMMIT_OID.test(String(baseCommit ?? ''))) {
      throw new Error(
        `提案 ${id} (${current.class}) は適用の基点が無いので採択できません — `
        + 'initiative.applyChannel と、そのチャンネルの autonomy.baseBranch を設定してください',
      );
    }
    const snapshot = snapshotOf(current, ctx, { baseCommit });
    const digest = proposalDigest(snapshot);
    const at = isoAt(now);
    const revision = current.revisions.length + 1;
    const by = actor?.kind === 'owner' ? `owner:${actor.userId}` : `bot:${actor?.botKey}`;
    const entry = { at, from: current.state, to: 'adjudicated', by };
    if (rationale) entry.note = String(rationale);
    // revision・裁定記録・状態を**1 回の書き込み**で入れる (途中で落ちた記録を残さない)
    const next = {
      ...current,
      revisions: [...current.revisions, { revision, at, digest, snapshot }],
      adjudication: { revision, digest, decision, by, at, rationale: String(rationale ?? '') },
      decision,
      state: 'adjudicated',
      updatedAt: at,
      history: [...current.history, entry],
    };
    this.write(current.id, next);
    return next;
  }

  /**
   * 前提が裁定時から動いていないか。**保存時・裁定時・task 化時・適用直前に呼ぶ。**
   *
   * 再検証は順序で閉じる — (1) 対象が allowlist から外れたなら `withdrawn`
   * (class が変わる以上、同じ提案のままでは続けられない)、
   * (2) まだ allowlist 内で digest だけが変わったなら `deliberating` へ戻して再裁定。
   *
   * @returns {{ok: true} | {ok: false, reason: string, action: 'withdrawn'|'deliberating'}}
   */
  revalidate(id, ctx, { now = Date.now() } = {}) {
    const proposal = this.require(id);
    if (isTerminal(proposal)) return { ok: true };

    const listed = (doc) => ctx.processEditAllowlist.includes(doc);
    const docs = (proposal.input?.targets ?? []).map((t) => t?.doc).filter(isNonEmptyString);
    const kind = proposal.input?.kind;
    if (kind === 'process-edit' && docs.some((d) => !listed(d))) {
      return this.#divert(proposal, 'withdrawn', 'processEditAllowlist から対象が外れました (governance-edit として出し直してください)', now);
    }
    if (kind === 'governance-edit' && docs.some((d) => listed(d))) {
      return this.#divert(proposal, 'withdrawn', '対象が processEditAllowlist に載ったため governance-edit では扱えません', now);
    }

    const checked = checkProposal(proposal.input, ctx);
    if (!checked.ok) {
      return this.#divert(proposal, 'deliberating', `前提が変わりました: ${checked.reason}`, now);
    }
    // **旧 `adjudication` を照合するのは、その裁定がまだ生きている状態だけ** (作者裁定 2026-09-04)。
    // `#divert` は監査のために裁定記録を残すので、一度 `deliberating` へ戻した提案は
    // 「digest が裁定時と食い違っている」のが前提そのもの。ここで照合すると**再裁定が
    // 構造的に不可能**になり、戻した提案は二度と閉じられない (「deliberating へ
    // 戻して再裁定」が実機で通らなかった原因)。戻った後の記録は履歴として残すだけ。
    if (proposal.adjudication && LIVE_ADJUDICATION_STATES.includes(proposal.state)) {
      const digest = proposalDigest(snapshotOf(proposal, ctx, {
        baseCommit: proposal.revisions.at(-1)?.snapshot?.external?.baseCommit ?? null,
      }));
      if (digest !== proposal.adjudication.digest) {
        return this.#divert(proposal, 'deliberating', '裁定時の内容と食い違っています (再裁定が要ります)', now);
      }
    }
    return { ok: true };
  }

  /**
   * 再検証で行き先が決まったときの共通処理 (状態を動かしてから理由を返す)。
   *
   * **`decision` も落とす。** 戻した後も `accepted` が残っていると、
   * 「再裁定待ちなのに採択済み」として task 化や試用開始が通ってしまう。
   * 裁定の記録そのもの (`adjudication` / `revisions`) は監査のために残す。
   */
  #divert(proposal, to, reason, now) {
    if (proposal.state !== to && PROPOSAL_TRANSITIONS[proposal.state]?.includes(to)) {
      this.#transition(proposal.id, to, { now, note: reason, patch: { decision: null } });
    }
    return { ok: false, reason, action: to };
  }

  /**
   * 「いまその提案の採択が生きているか」を一括で確かめる。
   *
   * 状態・採否・(必要なら) 裁定 digest の 3 つを**同時に**見る。どれか 1 つだけを
   * 見ていると、drift で `deliberating` へ戻した提案から古い採択を根拠に
   * 実作業を起こせてしまう。
   *
   * @param {{ctx?: object|null, states: string[], what: string, now: number}} p
   *   ctx を渡すと裁定時の内容と食い違っていないかまで見る (**適用より前**の
   *   関門でだけ渡す — 適用後は対象ファイルが動いているのが正常なので照合しない)
   */
  #requireLive(id, { ctx = null, states, what, now }) {
    const proposal = this.require(id);
    if (!states.includes(proposal.state)) {
      throw new Error(`提案 ${id} は ${proposal.state} なので${what}できません (要 ${states.join(' / ')})`);
    }
    if (proposal.decision !== 'accepted') throw new Error(`提案 ${id} は採択されていません`);
    if (ctx) {
      const revalidated = this.revalidate(id, ctx, { now });
      if (!revalidated.ok) throw new Error(`${what}できません: ${revalidated.reason}`);
    }
    return this.require(id);
  }

  /** 採択された提案を取り下げる / 出し直させる */
  withdraw(id, { reason = '', by = null, now = Date.now() } = {}) {
    return this.#transition(id, 'withdrawn', { now, by, note: reason });
  }

  /**
   * 試用開始。**`process | org` だけが通る道** — `work` は task 化して完了後に
   * `measured` へ直接進む。期限は input.trial の deadline をそのまま使う。
   *
   * ここでは digest を照合しない。org の試用は**適用の後**に始まるので、
   * 対象ファイルが裁定時から動いているのが正常な状態になる。
   */
  startTrial(id, { ctx = null, by = null, now = Date.now() } = {}) {
    const proposal = this.#requireLive(id, { states: ['adjudicated'], what: '試用を開始', now });
    if (proposal.class === 'work') {
      throw new Error(`提案 ${id} は work なので試用を挟みません (task 化して完了後に measured へ進めます)`);
    }
    // **試用は適用の後。** org / process の採択は必ず diff を伴うので、当てるまで
    // 「仮に置いた」状態は存在しない。receipt が無いまま試用を始めると、期限監視だけが
    // 動いて中身は入っていない提案ができる
    if (!isPlainObject(proposal.receipt) || proposal.receipt.digest !== proposal.adjudication?.digest) {
      throw new Error(`提案 ${id} はまだ適用されていません (裁定 digest に対応する receipt が要ります)`);
    }
    // 適用 task が merge されるまでは、当てた枝は main に入っていない
    if (isNonEmptyString(proposal.applyTaskId)) {
      if (!ctx) throw new Error('ctx は必須です (適用タスクが merge されたか確かめます)');
      const task = ctx.taskById?.(proposal.applyTaskId) ?? null;
      if (task?.state !== 'merged') {
        throw new Error(`適用タスク ${proposal.applyTaskId} は ${task?.state ?? '不明'} なのでまだ試用へ進めません`);
      }
    }
    const deadline = proposal.input?.trial?.deadline;
    if (!isNonEmptyString(deadline)) throw new Error(`提案 ${id} に trial.deadline がありません`);
    return this.#transition(id, 'trial', {
      now,
      by,
      patch: { trial: { startedAt: isoAt(now), deadline } },
    });
  }

  /**
   * 効果測定まで見て終える。**class ごとに入り口が違う** —
   * `process | org` は試用を経てから、`work` は task 化した後から。
   */
  measure(id, { outcome, ctx, note = '', by = null, now = Date.now() } = {}) {
    if (!PROPOSAL_OUTCOMES.includes(outcome)) {
      throw new Error(`outcome は ${PROPOSAL_OUTCOMES.join(' / ')} のどれかです`);
    }
    if (!ctx) throw new Error('ctx は必須です (結んだ task が完了しているか確かめます)');
    const klass = this.require(id).class;
    const states = klass === 'work' ? ['adjudicated'] : ['trial'];
    const proposal = this.#requireLive(id, { states, what: '効果を記録', now });
    if (klass === 'work' && proposal.taskIds.length === 0) {
      throw new Error(`提案 ${id} は task 化されていません (work は task の完了をもって measured へ進みます)`);
    }
    // **結んだ task が本当に片付いていること。** 件数だけ見ていると、
    // 実在しない id を結んだだけで「完了後」を満たしたことにできる
    for (const taskId of proposal.taskIds) {
      const task = ctx.taskById?.(taskId) ?? null;
      if (!task) throw new Error(`提案 ${id} が結んでいるタスク ${taskId} がボードにありません`);
      if (!TERMINAL_STATES.includes(task.state)) {
        throw new Error(`タスク ${taskId} は ${task.state} なのでまだ効果を測れません (要 ${TERMINAL_STATES.join(' / ')})`);
      }
    }
    if (klass === 'work' && !proposal.taskIds.some((taskId) => ctx.taskById(taskId)?.state === 'merged')) {
      throw new Error(`提案 ${id} の task は 1 件も merged になっていません (破棄されただけの提案は効果を測れません)`);
    }
    return this.#transition(id, 'measured', { now, by, note, patch: { outcome } });
  }

  /**
   * 採択後に作った task を結ぶ (組織記憶は proposal 側を正本にする)。
   *
   * **task 化は「実作業を起こす」関門なので digest まで照合する**。
   * 裁定時の内容と食い違っていれば task は作らせず、再裁定へ戻す。
   *
   * 結ぶ相手が**実在し、この提案の範囲を触る task であること**も確かめる。
   * 文字列を受け取るだけだと、存在しない id を結んで「task 化した」ことにできる。
   *
   * `apply` を立てると**適用 task** として結ぶ (`applyTaskId`)。二重適用の錠を
   * 同じ書き込みで下ろすため、別メソッドに分けずここへ寄せてある — 2 回に分けると、
   * 途中で落ちたときに「task はあるが錠は掛かっていない」提案が残る。
   *
   * **錠は task ID だけでなく revision と digest にも束縛する** (`applyRevision` /
   * `applyDigest`)。ID だけだと、旧 task の遅れて届いた失敗が新しい世代の錠と receipt を
   * 落とせる (Sol 指摘 2026-08-30)。
   */
  linkTask(id, taskId, { ctx, by = null, now = Date.now(), apply = false } = {}) {
    if (!ctx) throw new Error('ctx は必須です (task 化の前に裁定 digest を照合します)');
    const proposal = this.#requireLive(id, { ctx, states: ['adjudicated', 'trial'], what: 'task 化', now });
    if (!isNonEmptyString(taskId)) throw new Error('taskId は必須です');
    if (apply) {
      if (proposal.class === 'work') {
        throw new Error(`提案 ${id} は work なので適用回路 (org-apply) の対象外です`);
      }
      if (isNonEmptyString(proposal.applyTaskId)) {
        throw new Error(`提案 ${id} は既にタスク ${proposal.applyTaskId} で適用中です (二重適用はできません)`);
      }
      if (proposal.taskIds.includes(taskId)) {
        throw new Error(`タスク ${taskId} は既にこの提案へ結ばれています (適用タスクは作り直します)`);
      }
      if (!proposal.adjudication) throw new Error(`提案 ${id} に裁定の記録がありません`);
    }
    if (proposal.taskIds.includes(taskId)) return proposal;

    const task = ctx.taskById?.(String(taskId)) ?? null;
    if (!task) throw new Error(`タスク ${taskId} がボードにありません`);
    if (TERMINAL_STATES.includes(task.state)) {
      throw new Error(`タスク ${taskId} は ${task.state} なので結べません (これから走る task を結びます)`);
    }
    // touch 不明の task は「どこを触るか分からない」ので結ばない (fail-closed)。
    // 分かるなら、この提案が触ってよい範囲の内側でなければならない
    const scope = new Set(touchScopeOf(proposal.input, ctx));
    if (!isStringArray(task.touch) || task.touch.length === 0) {
      throw new Error(`タスク ${taskId} に touch がありません (提案との対応を確かめられません)`);
    }
    const outside = task.touch.filter((path) => !scope.has(path));
    if (outside.length > 0) {
      throw new Error(`タスク ${taskId} の touch が提案 ${id} の範囲外です: ${outside.join(' / ')}`);
    }
    const at = isoAt(now);
    const next = {
      ...proposal,
      taskIds: [...proposal.taskIds, taskId],
      ...(apply
        ? {
          applyTaskId: String(taskId),
          applyRevision: proposal.adjudication.revision,
          applyDigest: proposal.adjudication.digest,
        }
        : {}),
      updatedAt: at,
      history: [...proposal.history, { at, from: proposal.state, to: proposal.state, taskId, ...(by ? { by } : {}) }],
    };
    this.write(proposal.id, next);
    return next;
  }

  /**
   * ブリッジが当てて verify に通った事実 (receipt)。**後段の merge はこれだけを根拠にする。**
   *
   * 適用 task には修正担当も書込み権限も無いので、現行の「worker の完了 report を見て
   * `review` へ進める」経路は使えない (src/bridge/board.js の `noteTaskCompletion`)。
   * ここへ記録が付いたことをもって、ブリッジが `in-progress → review` を進める。
   *
   * receipt そのものは `makeReceipt` (src/apply.js) が組み立てる。ここで確かめるのは
   * **その receipt が、いま掛かっている錠に対応しているか**。digest だけを見ると、
   * 同じ digest の別 revision の receipt も通ってしまう (Sol 指摘 2026-08-30) ので、
   * 錠の revision・その revision の基点・承認 diff の指紋・verify の成否まで照合し、
   * **既にある receipt の上書きも拒否する** (当て直しは failApply を通す)。
   */
  recordReceipt(id, receipt, { now = Date.now(), by = null } = {}) {
    const proposal = this.require(id);
    if (proposal.state !== 'adjudicated' || proposal.decision !== 'accepted') {
      throw new Error(`提案 ${id} は ${proposal.state} なので適用の記録を残せません (要 adjudicated:accepted)`);
    }
    if (!isPlainObject(receipt)) throw new Error('receipt がありません');
    if (!isNonEmptyString(proposal.applyTaskId)) {
      throw new Error(`提案 ${id} は適用中ではありません (applyTaskId がありません)`);
    }
    if (isPlainObject(proposal.receipt)) {
      throw new Error(`提案 ${id} には既に receipt があります (当て直すなら failApply を通します)`);
    }
    if (String(receipt.proposalId) !== String(proposal.id)) {
      throw new Error(`receipt の proposalId (${receipt.proposalId}) が提案 ${proposal.id} と違います`);
    }
    if (receipt.digest !== proposal.adjudication?.digest || proposal.applyDigest !== proposal.adjudication?.digest) {
      throw new Error(`receipt の digest が裁定 (${proposal.adjudication?.digest}) と違います`);
    }
    if (receipt.revision !== proposal.applyRevision) {
      throw new Error(`receipt の revision (${receipt.revision}) が錠を取った revision (${proposal.applyRevision}) と違います`);
    }
    const locked = proposal.revisions.find((r) => r.revision === proposal.applyRevision) ?? null;
    const baseCommit = locked?.snapshot?.external?.baseCommit ?? null;
    if (!isNonEmptyString(baseCommit) || String(receipt.baseCommit).toLowerCase() !== String(baseCommit).toLowerCase()) {
      throw new Error(`receipt の baseCommit が revision ${proposal.applyRevision} の基点 (${baseCommit}) と違います`);
    }
    if (receipt.diffDigest !== diffDigestOf(proposal.input?.change?.diff)) {
      throw new Error(`receipt の diffDigest が承認された diff と違います (別の diff を当てています)`);
    }
    if (receipt.verify?.ok !== true) {
      throw new Error(`verify に通っていない適用は receipt になりません (失敗は failApply へ)`);
    }
    const at = isoAt(now);
    const entry = { at, from: proposal.state, to: proposal.state, note: `適用 ${receipt.appliedCommit}` };
    if (by) entry.by = by;
    const next = {
      ...proposal,
      receipt: canonicalize(receipt),
      updatedAt: at,
      history: [...proposal.history, entry],
    };
    this.write(proposal.id, next);
    return next;
  }

  /**
   * 適用が通らなかったとき (検収の差し戻し・verify NG)。
   *
   * **戻す先は作業ツリーではなく提案。** 直す対象は diff なので、新しい revision を
   * 作って再裁定を受け、承認後にきれいな枝へ当て直す。旧 task の終端化
   * (`dropped` / 理由 `superseded`) と worktree の解放は呼び出し側の仕事だが、
   * **提案側の 3 つ — 試行の記録・`applyTaskId` の解放・`deliberating` への差し戻し —
   * は 1 回の書き込みで行う。** 途中で落ちると「適用中のまま誰も進められない」提案が残る。
   *
   * 試行が上限に達したかの判定は呼び出し側 (`shouldEscalateApply`)。ここは記録するだけで、
   * 「もう当て直さない」を決めるのは適用回路の側に置く。
   *
   * **どの task の失敗かを必ず名乗らせる。** 錠と一致しない task ID を受けると、
   * 旧 task の遅れて届いた失敗が、既に始まっている新しい世代の錠と receipt を消す
   * (Sol 指摘 2026-08-30)。錠が掛かっていない提案は差し戻す対象そのものが無い。
   *
   * 既に `deliberating` へ落ちている提案 (`revalidate` の差し戻しが先に走った場合) では
   * **状態を動かさず錠だけ解放する** — 遷移表に無い辺を通さずに、宙に浮いた錠を外せる。
   */
  failApply(id, {
    reason, verdict = null, appliedCommit = null, verify = null, taskId = null,
    now = Date.now(), by = null,
  } = {}) {
    const proposal = this.require(id);
    if (!isNonEmptyString(reason)) throw new Error('failApply の reason は必須です');
    if (isTerminal(proposal)) {
      throw new Error(`提案 ${proposal.id} は終端 (${proposal.state}) なので差し戻せません`);
    }
    if (!isNonEmptyString(proposal.applyTaskId)) {
      throw new Error(`提案 ${proposal.id} は適用中ではありません (解放する錠がありません)`);
    }
    if (!isNonEmptyString(taskId)) throw new Error('failApply の taskId は必須です (どの適用の失敗かを照合します)');
    if (String(taskId) !== proposal.applyTaskId) {
      throw new Error(
        `タスク ${taskId} はこの提案の適用タスク (${proposal.applyTaskId}) ではありません`
        + ' — 古い適用の失敗で新しい適用を落とさせません',
      );
    }
    const to = proposal.state === 'deliberating' ? proposal.state : 'deliberating';
    if (to !== proposal.state && !PROPOSAL_TRANSITIONS[proposal.state]?.includes(to)) {
      throw new Error(`提案 ${proposal.id} は ${proposal.state} から ${to} へ戻せません`);
    }
    const at = isoAt(now);
    const attempt = {
      at,
      revision: proposal.applyRevision ?? proposal.adjudication?.revision ?? null,
      taskId: String(taskId),
      appliedCommit: isNonEmptyString(appliedCommit) ? String(appliedCommit) : null,
      verify: isPlainObject(verify) ? { ok: verify.ok === true } : null,
      verdict: isNonEmptyString(verdict) ? String(verdict) : null,
      reason: String(reason),
    };
    const entry = { at, from: proposal.state, to, note: String(reason) };
    if (by) entry.by = by;
    const next = {
      ...proposal,
      applyTaskId: null,
      applyRevision: null,
      applyDigest: null,
      receipt: null,
      applyAttempts: [...(proposal.applyAttempts ?? []), attempt],
      // **`decision` も落とす。** 残っていると「再裁定待ちなのに採択済み」として
      // 次の task 化が通る (#divert と同じ理由)
      decision: null,
      state: to,
      updatedAt: at,
      history: [...proposal.history, entry],
    };
    this.write(proposal.id, next);
    return next;
  }

  /**
   * 期限切れの試用 (scheduler が拾う)。**期限切れを放置して仮配置を恒久化させない。**
   * `planTick` は board だけでなくこれも明示的な入力に取る。
   */
  dueTrials(now = Date.now()) {
    return this.list({ state: 'trial' }).filter((p) => {
      const due = Date.parse(p.trial?.deadline ?? '');
      return Number.isFinite(due) && due <= now;
    });
  }

  /**
   * 遷移の実体。**表に無い辺は書き込む前に拒否する。**
   *
   * **private にしてある。** 公開してしまうと class 別の道筋 (work は試用を挟まない、
   * org は試用を経てからでないと measured へ行けない) を素通りして状態を動かせる。
   * 外から動かす入り口は deliberate / adjudicate / startTrial / measure / withdraw だけ。
   *
   * `patch` で書き換えてよいのは `PATCHABLE_FIELDS` だけ。**同一性を決める側
   * (id / class / kind / subjectKeys / input / 裁定記録) は遷移では動かさない** —
   * 引数の受け渡しを 1 か所間違えただけで class を偽れる作りにしない。
   */
  #transition(id, to, { now = Date.now(), by = null, note = '', patch = {} } = {}) {
    const forbidden = Object.keys(patch).filter((key) => !PATCHABLE_FIELDS.includes(key));
    if (forbidden.length > 0) {
      throw new Error(`遷移で書き換えられないフィールドです: ${forbidden.join(' / ')}`);
    }
    const proposal = this.require(id);
    if (isTerminal(proposal)) {
      throw new Error(`提案 ${proposal.id} は終端 (${proposal.state}) なので ${to} へ進めません`);
    }
    if (!PROPOSAL_TRANSITIONS[proposal.state]?.includes(to)) {
      throw new Error(
        `提案 ${proposal.id} は ${proposal.state} から ${to} へ進めません `
        + '(提案の状態機械 PROPOSAL_TRANSITIONS に無い)',
      );
    }
    const at = isoAt(now);
    const entry = { at, from: proposal.state, to };
    if (by) entry.by = by;
    if (note) entry.note = note;
    const next = {
      ...proposal,
      ...patch,
      state: to,
      updatedAt: at,
      history: [...proposal.history, entry],
    };
    this.write(proposal.id, next);
    return next;
  }

  /**
   * 動かす前に必ず通す funnel。
   *
   * **`class` は `kind` から導く値なので、保存値と食い違っていたら壊れている** —
   * 改変であれ手編集であれ、そのまま進めると軽い class として裁定できてしまう。
   * digest は入力側 (`input`) を守るが `class` は snapshot に含まれないので、
   * ここで毎回導き直して照合する (fail-closed)。
   */
  require(id) {
    const proposal = this.get(id);
    if (!proposal) throw new Error(`提案 ${id} がありません`);
    const derived = classForKind(proposal.input?.kind);
    if (derived === null || derived !== proposal.class) {
      throw new Error(
        `提案 ${id} の class (${proposal.class}) が kind (${proposal.input?.kind}) から導かれる値と違います`,
      );
    }
    return proposal;
  }

  /** 書き込みも複製で受ける (呼び出し側が握っているオブジェクトと内部値を切り離す) */
  write(id, proposal) {
    this.commit({ ...this.data, [String(id)]: structuredClone(proposal) });
  }
}
