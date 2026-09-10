// 委譲契約 (T6) の受け渡しの配線 (src/index.js から切り出し)。
// 判断は src/contract.js が持ち、ここは ContractStore と job の受付・起動を結ぶ:
// 受付時に契約を取り出す (claimContract)、起動しない handoff の契約を捨てる
// (discardContractFor)、取り出した契約を実権限へ変換する (applyIncomingContract)。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePermissionMode } from '../config.js';
import {
  canDelegateTo,
  classifyExternalSettings,
  consumableBy,
  contractFor,
  isTouchRestricted,
  narrowForTouchSet,
  readContractNonce,
  requiresContract,
  touchSetOf,
} from '../contract.js';

/**
 * 契約を束縛する作業ディレクトリ。**リポジトリ本体へ寄せる** (§8-2)。
 *
 * cwd の完全一致で契約を縛るのは「job の途中で junction を差し替えたら、A で起きた拒否が
 * B 向けの承認になる」を防ぐため (sol 指摘 2026-08-01)。見ているのは**どのプロジェクトの
 * 話か**であって、同じリポジトリの中のどのチェックアウトか、ではない。
 *
 * worktree 分離で worker (作業ツリー) と reviewer (本体) の cwd が分かれたので、本体へ
 * 寄せないと worker が保存した契約を reviewer が取り出せず、**レビュー job が起動せず
 * タスクが review のまま残る** (Sol 指摘 2026-08-28)。照合そのものは緩めない。
 */
export function contractCwd(cc) {
  return cc.repoRoot ?? cc.cwd;
}

/**
 * `--setting-sources` で落とされる外部 settings を読む (user / project / local)。
 *
 * **読めなかったファイルは「無い」として扱う。** 存在しないのが普通で、
 * 読めない場合も落とすことで権限が広がるのは中身に制限があったときだけ —
 * それは classifyExternalSettings が見つけられないので、読めたものだけで判定する。
 * (管理者ポリシー settings は `--setting-sources` の対象外なので読まない。)
 */
export function readExternalSettings(cwd) {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const candidates = [
    ['user settings', join(userDir, 'settings.json')],
    ['project settings', join(cwd, '.claude', 'settings.json')],
    ['project settings (local)', join(cwd, '.claude', 'settings.local.json')],
  ];
  const sources = [];
  for (const [label, path] of candidates) {
    try {
      sources.push({ label, settings: JSON.parse(readFileSync(path, 'utf8')) });
    } catch { /* 無い / 読めない / 壊れている — 落としても権限は広がらない */ }
  }
  // 管理者ポリシーは `--setting-sources` で落とせず優先度も上。**あるだけで**申告する
  // (中身が読めても打ち消せないので、読めたかどうかで扱いを変えない)
  const managed = managedPolicyPath();
  if (managed && existsSync(managed)) {
    sources.push({ label: `管理者ポリシー (${managed})`, settings: null, managed: true });
  }
  return sources;
}

/** 管理者ポリシー settings の置き場 (OS ごとに固定) */
export function managedPolicyPath() {
  if (process.platform === 'win32') {
    return join(process.env.PROGRAMDATA || 'C:/ProgramData', 'ClaudeCode', 'managed-settings.json');
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
}

/**
 * @param {object} deps
 * @param {import('../store.js').ContractStore} deps.contracts
 * @param {(userId: string|null|undefined) => string|null} deps.botKeyOf Discord のユーザー ID → bot キー
 */
export function createContractWiring({ contracts, botKeyOf }) {
  /**
   * 起動しない handoff の契約を捨てる。
   *
   * タグ付きの制御メッセージを終端で捨てる経路 (受付停止・チャンネル未登録・
   * ホップ上限・受付失敗) はすべてここを通す。残すと未消費のまま溜まり、
   * 24 時間以内に上限へ達して**新しい委譲が保存できなくなる** (sol 指摘 2026-08-03)。
   *
   * @returns {object|null} **実際に捨てた契約** (無ければ null)。本文に印があっても、
   *   失効した後や既に取り出された後はストアに無いので null になる — 呼び出し側が
   *   「捨てました」と人に伝えてよいかの判定に使う (Opus レビュー 2026-09-08 ②)
   */
  function discardContractFor(bot, msg, why) {
    try {
      if (!msg?.channel?.isThread?.()) return null; // bot 間の handoff はスレッド内だけ
      const fromBotKey = botKeyOf(msg.author?.id);
      const nonce = readContractNonce(msg.content);
      if (!fromBotKey || !nonce) return null;
      const dropped = contracts.claim(msg.channel.id, bot.key, { fromBotKey, nonce });
      if (dropped) {
        console.log(
          `[contract] 起動しない handoff の契約を捨てました (${why}) `
          + `thread:${msg.channel.id} ${fromBotKey} → ${bot.key}`,
        );
      }
      return dropped ?? null;
    } catch (err) {
      // 捨てられなくても 24 時間で期限切れになる (誤適用は nonce が防ぐ)
      console.error(`[contract] 起動しない handoff の契約を捨てられませんでした: ${err.message}`);
      return null;
    }
  }

  /**
   * この job が消費してよい契約をストアから取り出す (受付時に 1 回だけ)。
   *
   * 取り出しに失敗したら**契約なしとして扱わず**、その旨を job へ伝える —
   * 契約があるのに読めないまま走らせると touch 制限が黙って外れる。
   *
   * @returns {{entry: object|null, error: string|null}}
   */
  function claimContract({ bot, thread, cc, triggerMsg }) {
    // 人間が直接呼んだ job はストアに触れない (契約は handoff で起動された 1 回のもの)
    const fromBotKey = botKeyOf(triggerMsg.author?.id);
    if (!consumableBy({ triggeredByBotKey: fromBotKey })) return { entry: null, error: null };
    // **制御メッセージに載った nonce で結び付ける。** 投稿より前に決まっているので、
    // 受け手の MessageCreate が先に届いても取りこぼさない
    const nonce = readContractNonce(triggerMsg.content);
    const expected = requiresContract(triggerMsg.content);
    if (!nonce) return { entry: null, error: null, expected };
    try {
      const entry = contracts.claim(thread.id, bot.key, { fromBotKey, nonce });
      return { entry, error: null, expected };
    } catch (err) {
      console.error(`[contract] 取り出しに失敗 (thread:${thread.id} → ${bot.key}): ${err.message}`);
      return { entry: null, error: err.message, expected };
    }
  }

  /**
   * この job に効く委譲契約を取り出し、touch 制限を実権限へ変換する (T6)。
   *
   * **契約は「呼ばれた 1 回」に効く。** 取り出せたら消す — 残すと同じスレッドの次の
   * job まで黙って絞られたり、古い touch 集合で走ったりする。
   *
   * @returns {{contract: object|null, narrowed: object|null, stop: string|null}}
   *          stop が入っていたら**モデルを起動してはいけない** (理由をそのまま出す)
   */
  function applyIncomingContract({ bot, thread, cc, triggerMsg, baseAllowedTools, claimed }) {
    const none = { kind: null, contract: null, narrowed: null, stop: null };
    // 受付時に取り出せなかった (ストアが読めない) — 契約なしとして走らせない。
    // 契約があるのに読めないまま走らせると touch 制限が黙って外れる
    if (claimed?.error) {
      return { ...none, stop: `❌ 引き継ぎ構造を取り出せなかったため起動しません: ${claimed.error}` };
    }
    const entry = claimed?.entry;
    // **契約タグが付いた handoff なのに契約が無い = 失われている。** 素通しすると
    // touch 制限が黙って外れるので、契約なしの handoff と同じには扱わない
    if (!entry && claimed?.expected) {
      return {
        ...none,
        stop:
          `❌ ${bot.cfg.displayName} を起動しませんでした — 委譲契約が見つかりません\n`
          + '(契約つきで呼ばれましたが、契約が保存されていないか期限切れです)\n'
          + '→ 委譲し直してください',
      };
    }
    if (!entry) return none;

    const usable = contractFor(entry, {
      botKey: bot.key,
      threadId: thread.id,
      cwd: contractCwd(cc),
      triggeredByBotKey: botKeyOf(triggerMsg.author?.id),
    });
    if (!usable.ok) {
      // 宛先も送信元も一致した契約が使えない = 作業ディレクトリの変更か保存の破損。
      // **元の権限のまま走らせない** — 絞る前提で委譲されたものを素通しするのと同じ
      return {
        ...none,
        stop:
          `❌ ${bot.cfg.displayName} を起動しませんでした — 引き継いだ契約を適用できません\n`
          + `${usable.reason}\n→ 委譲し直してください`,
      };
    }

    // 報告は権限を持たない — 検収の照合材料として載せるだけ
    if (usable.kind !== 'delegation' || !isTouchRestricted(usable.contract)) {
      console.log(
        `[contract] 適用 (${usable.kind}${usable.kind === 'delegation' ? ' / touch 制限なし' : ''}) `
        + `thread:${thread.id} → ${bot.key}`,
      );
      return { kind: usable.kind, contract: usable.contract, narrowed: null, stop: null };
    }

    // touch 制限つきの契約は claude ランタイムにしか保存されない (canDelegateTo が
    // 保存側で止める)。それでもここへ来たなら設定変更などで前提が崩れているので、
    // 絞れないまま走らせず止める
    const allowed = canDelegateTo(usable.kind, usable.contract, bot.cfg.runtime ?? 'claude');
    if (!allowed.ok) {
      return {
        kind: usable.kind,
        contract: usable.contract,
        narrowed: null,
        stop: `❌ ${bot.cfg.displayName} を起動しませんでした — ${allowed.reason}`,
      };
    }

    // 外部 settings に制限が書かれていたら、それごと落とすことになるので走らせない
    // (touch 制限は --setting-sources '' で user/project/local を丸ごと落とす)
    const external = classifyExternalSettings(readExternalSettings(cc.cwd));
    if (!external.ok) {
      return {
        kind: usable.kind,
        contract: usable.contract,
        narrowed: null,
        stop: `❌ ${bot.cfg.displayName} を起動しませんでした — ${external.reason}`,
      };
    }

    const narrowed = narrowForTouchSet({
      touchSet: touchSetOf(usable.contract),
      allowedTools: baseAllowedTools,
      cwd: cc.cwd,
      // 元のモードを渡す。plan (読取専用) を default へ上げると昇格になる
      permissionMode: resolvePermissionMode(cc),
    });
    if (!narrowed.ok) {
      const detail = (narrowed.rejected ?? []).map((r) => `・${r.path} — ${r.reason}`).join('\n');
      return {
        kind: usable.kind,
        contract: usable.contract,
        narrowed: null,
        stop:
          `❌ ${bot.cfg.displayName} を起動しませんでした — touch 制限を強制できません\n`
          + `${narrowed.reason}\n${detail}\n`
          + '→ touch 集合を「作業ディレクトリ基準の相対パスで 1 ファイルずつ」書き直すか、'
          + '探索が必要な依頼なら touch 制限を解除して委譲し直してください',
      };
    }
    console.log(
      `[contract] 適用 (touch 制限 ${narrowed.rules.length} 件`
      + `${narrowed.rejected.length ? ` / 変換不可 ${narrowed.rejected.length} 件` : ''}) `
      + `thread:${thread.id} → ${bot.key}`,
    );
    return { kind: usable.kind, contract: usable.contract, narrowed, stop: null };
  }

  return { contractCwd, discardContractFor, claimContract, applyIncomingContract };
}
