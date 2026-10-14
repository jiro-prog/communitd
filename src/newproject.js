// 新しいプロジェクトを 1 コマンドで自律運転まで立ち上げる (npm run new-project) の純粋ロジック。
// 読み書き・git・Discord は scripts/new-project.mjs 側の責務 — ここは引数の解釈と組み立てだけ。
//
// add-project (対話・既存ディレクトリ・手動の /restart) との違い:
//   ディレクトリを作り、方向性ドキュメントを初回 commit し、autonomy 付きで登録し、
//   再起動の依頼 (data/restart-request.json) を置くところまでを、問い合わせなしで行う。
//   既定値はここに集め、聞かずに決める (docs/handoff/2026-10-01-new-project.md)。

import { parseArgs } from 'node:util';
import { TOOLS_CHOICES } from './project.js';

/**
 * 聞かずに決める既定値。先行の自律運転プロジェクトに合わせ、
 * tools だけは無人の夜に GPU モデルなどを起動させないよう standard (git / node / npm) にする。
 * Python など別の実行環境が要るプロジェクトは --tools full を明示する。
 * **bot はここに書かない** — bot のキーは配備ごとに違うので、既存の自律運転チャンネルに揃える
 * (resolveProjectBots)。
 */
export const NEW_PROJECT_DEFAULTS = Object.freeze({
  tools: 'standard',
  baseBranch: 'main',
  directionFile: 'docs/direction.md',
  scoutMaxOpenTasks: 3,
  maxConcurrentTasks: 1,
  verifyMaxRetries: 2,
});

/** 初回 commit のメッセージ (先行プロジェクトの初版と同じ形) */
export const INIT_COMMIT_MESSAGE = 'init: 器と方向性ドキュメント初版';

/** 方向性ドキュメントの上限。スカウトと承認役が毎回読むので、厚すぎるものは削ってから渡す */
export const DIRECTION_MAX_CHARS = 32 * 1024;

export const NEW_PROJECT_USAGE = [
  '使い方: npm run new-project -- --name <名前> --direction <direction.md のパス> --verify "<検証コマンド>" [オプション]',
  '  --name        チャンネル名 = プロジェクトのフォルダ名 (小文字・数字・ハイフン)',
  '  --direction   方向性ドキュメント。docs/direction.md として初回 commit に入る',
  '  --verify      merge 前に必ず通す検証コマンド (例: "npm run typecheck && npm test && npm run build")',
  `  --tools       ${TOOLS_CHOICES.filter((t) => t !== 'readonly').join(' | ')} (既定 ${NEW_PROJECT_DEFAULTS.tools})`,
  `  --base-branch 基点ブランチ (既定 ${NEW_PROJECT_DEFAULTS.baseBranch})`,
  '  --parent      プロジェクトを作る親フォルダ (既定: ブリッジの隣)',
  '  --scout       起票する bot のキー',
  '  --worker      実装する bot のキー (カンマ区切りで複数可)',
  '  --reviewer    レビューする bot のキー (worker と別の bot)',
  '                bot の既定は既存の自律運転チャンネル (最後に足したもの) と同じ。まだ無いときは 3 つとも要る',
  '  --dry-run     何も作らずに、作る内容と検証結果だけを表示する',
].join('\n');

/**
 * 引数の解釈。**読めない引数は黙って無視せずエラーにする** (scripts/run.mjs と同じ方針)。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{options: object|null, errors: string[]}}
 */
export function parseNewProjectArgs(argv = []) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        name: { type: 'string' },
        direction: { type: 'string' },
        verify: { type: 'string' },
        tools: { type: 'string' },
        'base-branch': { type: 'string' },
        parent: { type: 'string' },
        scout: { type: 'string' },
        worker: { type: 'string' },
        reviewer: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }));
  } catch (err) {
    return { options: null, errors: [err.message] };
  }

  const errors = [];
  const text = (key) => (typeof values[key] === 'string' ? values[key].trim() : '');
  for (const key of ['name', 'direction', 'verify']) {
    if (!text(key)) errors.push(`--${key} は必須です`);
  }
  const tools = text('tools') || NEW_PROJECT_DEFAULTS.tools;
  if (tools === 'readonly') {
    errors.push('--tools readonly は選べません (自律運転は実装するので書込みが要ります)');
  } else if (!TOOLS_CHOICES.includes(tools)) {
    errors.push(`--tools は ${TOOLS_CHOICES.filter((t) => t !== 'readonly').join(' / ')} のどれか`);
  }
  const baseBranch = text('base-branch') || NEW_PROJECT_DEFAULTS.baseBranch;
  if (!isSafeBranchName(baseBranch)) {
    errors.push(`--base-branch に使えない名前です: ${baseBranch}`);
  }
  if (errors.length > 0) return { options: null, errors };
  return {
    options: {
      name: text('name'),
      direction: text('direction'),
      verify: text('verify'),
      tools,
      baseBranch,
      parent: text('parent') || null,
      scout: text('scout') || null,
      workers: text('worker') ? text('worker').split(',').map((s) => s.trim()).filter(Boolean) : null,
      reviewer: text('reviewer') || null,
      dryRun: values['dry-run'] === true,
    },
    errors: [],
  };
}

/**
 * 新しいチャンネルの担当 bot を決める。引数で指定したものを優先し、残りは**既存の自律運転チャンネル
 * (config に後から足したもの = 最後のもの) に揃える**。bot のキーは配備ごとに違うので既定値は持たない
 * (設定例の bot は manager / worker)。キーが実在するか・reviewer が worker と別かは起動時検証
 * (validateConfig) が見るので、ここでは決まらないものだけを知らせる。
 *
 * @param {object} config 合成済みの設定
 * @param {{scout?: string|null, workers?: string[]|null, reviewer?: string|null}} [given] 引数で指定した bot
 * @returns {{bots: {scout: string, workers: string[], reviewer: string}|null, from: string|null, errors: string[]}}
 *   from = 揃えたチャンネル名 (全部を引数で決めたときは null)
 */
export function resolveProjectBots(config, given = {}) {
  const template = Object.entries(config?.channels ?? {})
    .filter(([, ch]) => ch?.autonomy?.enabled === true && ch.autonomy.scout?.bot
      && ch.autonomy.worker?.bots?.length > 0 && ch.autonomy.reviewer)
    .at(-1);
  const t = template?.[1].autonomy;
  const scout = given.scout ?? t?.scout.bot ?? null;
  const workers = given.workers?.length > 0 ? [...given.workers] : (t ? [...t.worker.bots] : null);
  const reviewer = given.reviewer ?? t?.reviewer ?? null;

  const missing = [!scout && '--scout', !workers && '--worker', !reviewer && '--reviewer'].filter(Boolean);
  if (missing.length > 0) {
    const keys = Object.keys(config?.bots ?? {});
    return {
      bots: null,
      from: null,
      errors: [`揃える自律運転のチャンネルがまだ無いので、${missing.join(' / ')} で bot を指定してください`
        + ` (使えるのは ${keys.join(' / ') || '(bot が未登録)'}。reviewer は worker と別の bot)`],
    };
  }
  const usedTemplate = template && (!given.scout || !(given.workers?.length > 0) || !given.reviewer);
  return { bots: { scout, workers, reviewer }, from: usedTemplate ? template[0] : null, errors: [] };
}

/** git に渡すブランチ名として安全か (引数に化ける先頭 `-` や空白・制御文字を弾く) */
function isSafeBranchName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..') && !name.endsWith('/');
}

/**
 * 方向性ドキュメントの中身の検査 (形式は縛らない。空と厚すぎだけを止める)。
 * @returns {string[]} エラー行 (空 = 使ってよい)
 */
export function checkDirectionText(text) {
  if (typeof text !== 'string' || text.trim() === '') return ['方向性ドキュメントが空です'];
  if (text.length > DIRECTION_MAX_CHARS) {
    return [`方向性ドキュメントが長すぎます (${text.length} 字 > ${DIRECTION_MAX_CHARS} 字)。スカウトが毎回読むので削ってください`];
  }
  return [];
}

/**
 * channels.<name> に書く、自律運転つきのエントリ。
 * 形は先行プロジェクト (scout あり) に揃える。verify と hooks は enabled の必須条件
 * (config.js validateAutonomy)。bots は resolveProjectBots の結果。
 */
export function buildAutonomousEntry({ cwd, tools = NEW_PROJECT_DEFAULTS.tools, verify, baseBranch = NEW_PROJECT_DEFAULTS.baseBranch, bots }) {
  const d = NEW_PROJECT_DEFAULTS;
  return {
    cwd,
    tools,
    hooks: true,
    verify,
    verifyMaxRetries: d.verifyMaxRetries,
    autonomy: {
      enabled: true,
      directionFile: d.directionFile,
      baseBranch,
      scout: { bot: bots.scout, maxOpenTasks: d.scoutMaxOpenTasks },
      worker: { bots: [...bots.workers] },
      reviewer: bots.reviewer,
      maxConcurrentTasks: d.maxConcurrentTasks,
    },
  };
}

/**
 * 初回 commit に入れる .gitignore。**タスクの作業ツリー (`.worktrees/`) を無視する** —
 * 無いとタスク job が作業ツリーを作らずに落ちる (src/worktree.js の prepareWorktree は fail-closed)。
 * understanding-map は初回 commit に .gitignore が無く、雛形タスクが作った .gitignore にも入らず、
 * doctor が ❌ を出していた (2026-10-07)。依存やビルド出力の行は言語が決まってからエージェントが足す
 */
export function buildGitignore() {
  return [
    '# communitd の自律運転がタスクごとに作る作業ツリー (.worktrees/task-N)。消さないこと',
    '.worktrees/',
    '',
  ].join('\n');
}

/** 初回 commit に入れる README (中身はエージェントが育てる) */
export function buildReadme({ name }) {
  return [
    `# ${name}`,
    '',
    'communitd の自律運転で開発しているプロジェクト。',
    `方向性 (やること・やらないこと・品質基準) は [${NEW_PROJECT_DEFAULTS.directionFile}](${NEW_PROJECT_DEFAULTS.directionFile}) が正本。`,
    '',
  ].join('\n');
}
