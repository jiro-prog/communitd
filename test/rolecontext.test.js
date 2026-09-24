import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRuntimeContext,
  describeSubagentAccess,
  describeWriteAccess,
} from '../src/rolecontext.js';

test('codex は sandbox が書込み可否の正本 (allowedTools は見ない)', () => {
  const rw = describeWriteAccess({
    runtime: 'codex',
    sandbox: 'workspace-write',
    allowedTools: [],
  });
  assert.equal(rw.canWrite, true);
  assert.match(rw.text, /workspace-write/);

  const ro = describeWriteAccess({
    runtime: 'codex',
    sandbox: 'read-only',
    allowedTools: ['Edit', 'Write'],
  });
  assert.equal(ro.canWrite, false, 'allowedTools は codex の sandbox を上書きしない');
  assert.match(ro.text, /読み取り専用/);
});

test('claude は allowedTools が正本 (sandbox は見ない)', () => {
  const rw = describeWriteAccess({ runtime: 'claude', allowedTools: ['Read', 'Edit', 'Write'] });
  assert.equal(rw.canWrite, true);
  assert.match(rw.text, /Edit/);

  const ro = describeWriteAccess({
    runtime: 'claude',
    sandbox: 'workspace-write',
    allowedTools: ['Read', 'Glob'],
  });
  assert.equal(ro.canWrite, false, 'codexSandbox は claude の権限を上げない');
});

test('パス限定の Edit(パス) も書込みとして数える (touch 制限中に嘘をつかない)', () => {
  // narrowForTouchSet は裸の Edit を落として Edit(./パス) に置き換える。
  // 裸の綴りしか数えないと、実際には編集できる job が「読み取り専用」と出る
  const a = describeWriteAccess({
    runtime: 'claude',
    allowedTools: ['Read', 'Grep', 'Edit(./src/a.js)', 'Edit(./test/a.test.js)'],
  });
  assert.equal(a.canWrite, true);
  assert.match(a.text, /パス限定/);
  assert.match(a.text, /Edit\(\.\/src\/a\.js\)/);
  assert.match(a.text, /Edit\(\.\/test\/a\.test\.js\)/);
  assert.doesNotMatch(a.text, /読み取り専用/);
});

test('permissionMode の 4 値それぞれで書込み案内が変わる (allowedTools だけ見ない)', () => {
  // 同じ allowedTools でもモードで実態が変わる。allowedTools だけを見て
  // 「一覧の外は拒否される」と書くと plan / acceptEdits / bypassPermissions で嘘になる
  const allowedTools = ['Read', 'Edit(./src/a.js)'];

  const plan = describeWriteAccess({ runtime: 'claude', allowedTools, permissionMode: 'plan' });
  assert.equal(plan.canWrite, false, 'plan では書けない');
  assert.match(plan.text, /読み取り専用/);
  assert.match(plan.text, /plan/);
  assert.doesNotMatch(plan.text, /パス限定/);

  const dflt = describeWriteAccess({ runtime: 'claude', allowedTools, permissionMode: 'default' });
  assert.equal(dflt.canWrite, true);
  assert.match(dflt.text, /パス限定/);
  assert.match(dflt.text, /Edit\(\.\/src\/a\.js\)/);

  for (const mode of ['acceptEdits', 'bypassPermissions']) {
    const m = describeWriteAccess({ runtime: 'claude', allowedTools, permissionMode: mode });
    assert.equal(m.canWrite, true, mode);
    assert.match(m.text, new RegExp(mode), mode);
    // **範囲を主張しない。** 照合を迂回するので「一覧の外は拒否される」は嘘になる
    assert.doesNotMatch(m.text, /パス限定 \(次の/, mode);
    assert.match(m.text, /範囲は絞られていない/, mode);
  }
});

test('plan は裸の書込みツールがあっても読み取り専用 (モードが勝つ)', () => {
  const plan = describeWriteAccess({
    runtime: 'claude',
    allowedTools: ['Edit', 'Write', 'NotebookEdit'],
    permissionMode: 'plan',
  });
  assert.equal(plan.canWrite, false);
  assert.match(plan.text, /読み取り専用/);
});

test('permissionMode 省略時は default 扱い (既存の呼び出しが挙動を変えない)', () => {
  const omitted = describeWriteAccess({ runtime: 'claude', allowedTools: ['Edit(./src/a.js)'] });
  const explicit = describeWriteAccess({
    runtime: 'claude',
    allowedTools: ['Edit(./src/a.js)'],
    permissionMode: 'default',
  });
  assert.deepEqual(omitted, explicit);
});

test('codex は permissionMode を見ない (sandbox が正本のまま)', () => {
  for (const permissionMode of ['plan', 'acceptEdits', 'bypassPermissions', 'default']) {
    const access = describeWriteAccess({
      runtime: 'codex',
      sandbox: 'workspace-write',
      permissionMode,
    });
    assert.equal(access.canWrite, true, permissionMode);
    assert.match(access.text, /workspace-write/, permissionMode);
  }
});

test('Write(パス) / NotebookEdit(パス) は書込みとして数えない (claude が照合しない)', () => {
  // src/toolrules.js:38-41 の実測。数えると「書けます」と案内して実際には書けない
  const ro = describeWriteAccess({
    runtime: 'claude',
    allowedTools: ['Read', 'Write(./src/a.js)', 'NotebookEdit(./nb.ipynb)'],
  });
  assert.equal(ro.canWrite, false);
  assert.match(ro.text, /読み取り専用/);
});

test('パス限定が多いときは件数に畳む (実行文脈を 1 行に保つ)', () => {
  const many = Array.from({ length: 8 }, (_, i) => `Edit(./src/f${i}.js)`);
  const access = describeWriteAccess({ runtime: 'claude', allowedTools: many });
  assert.equal(access.canWrite, true);
  assert.match(access.text, /他 3 件/);
  assert.equal(access.text.includes('Edit(./src/f7.js)'), false);
});

test('裸の書込みがあればパス限定より裸の綴りを出す (絞られていない job)', () => {
  const access = describeWriteAccess({
    runtime: 'claude',
    allowedTools: ['Edit', 'Write', 'Edit(./src/a.js)'],
  });
  assert.equal(access.canWrite, true);
  assert.match(access.text, /Edit \/ Write が許可されている/);
  assert.doesNotMatch(access.text, /パス限定/);
});

test('実行文脈のファイル権限行に touch 制限の実範囲が出る', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    allowedTools: ['Read', 'Edit(./src/a.js)'],
    permissionMode: 'default',
    peers: [],
  });
  assert.match(text, /- ファイル権限: 書込み可だがパス限定/);
  assert.match(text, /Edit\(\.\/src\/a\.js\)/);
});

test('引き継ぎ文書は置いてあるときだけ実行文脈に出る', () => {
  // スレッドは毎回切れるがプロジェクトの現在地は続く。在り処を実行文脈へ出しておくと
  // 「次に進めて」の一言で始められる。**置いていないプロジェクトへは案内しない**
  const withHandoff = buildRuntimeContext({
    selfKey: 'opus', cwd: 'C:/tmp/x', handoffFile: 'docs/HANDOFF.md', peers: [],
  });
  assert.match(withHandoff, /- 引き継ぎ: `docs\/HANDOFF\.md`/);
  assert.match(withHandoff, /着手前に読み、区切りがついたら更新する/);

  const without = buildRuntimeContext({ selfKey: 'opus', cwd: 'C:/tmp/x', peers: [] });
  assert.equal(without.includes('引き継ぎ'), false, '無いファイルを読めと案内している');
  assert.equal(buildRuntimeContext({ selfKey: 'opus', peers: [] }).includes('引き継ぎ'), false);
});

test('実行文脈は permissionMode も映す (plan のチャンネルで書けると言わない)', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    allowedTools: ['Read', 'Edit'],
    permissionMode: 'plan',
    peers: [],
  });
  assert.match(text, /- ファイル権限: 読み取り専用/);
  assert.match(text, /plan/);
});

test('既定 (何も渡さない) は読み取り専用へ倒れる', () => {
  assert.equal(describeWriteAccess().canWrite, false);
  assert.equal(describeWriteAccess({ runtime: 'codex' }).canWrite, false);
});

test('subagent の可否は allowedTools で決まらない (ブリッジ側では無効化していない)', () => {
  // `--allowedTools` は許可リストではなく追加許可で、Agent はそこに無くても起動する
  // (T0 実測 6.3 / 再実測 2026-08-02)。toolsExtra の有無で書き分けると実行文脈が嘘をつく
  for (const allowedTools of [[], ['Read'], ['Agent'], ['Agent(Explore)']]) {
    const access = describeSubagentAccess({ runtime: 'claude', allowedTools });
    assert.equal(access.canUse, true, JSON.stringify(allowedTools));
    assert.match(access.text, /同じ権限/);
    // **「権限を超えない」と保証しない。** custom subagent 定義は permissionMode / hooks /
    // mcpServers / isolation で信頼境界を動かす (実測と公式仕様)。断定を戻したらここで落ちる
    assert.doesNotMatch(access.text, /超えられない/);
    assert.match(access.text, /権限・使えるツール・作業場所・永続状態を変え/);
    assert.match(access.text, /hook による別の実行経路/);
    // 「常に使える」とも言い切らない — claude 側 settings の deny で偽になる
    assert.match(access.text, /ブリッジ側では無効化していない/);
    assert.match(access.text, /deny があればそちらが優先/);
    // 自己検証の禁止 (worker の役割文) を実行文脈からも外さない
    assert.match(access.text, /自己検証/);
  }
  assert.equal(describeSubagentAccess({ runtime: 'codex' }).canUse, false);
  assert.equal(describeSubagentAccess().canUse, true, 'ランタイム既定は claude');
});

test('実行文脈に subagent の行が出る (codex では使えないと出る)', () => {
  const claude = buildRuntimeContext({ selfKey: 'opus', allowedTools: ['Read'], peers: [] });
  assert.match(claude, /- subagent: 使える \(Agent ツール/);
  const codex = buildRuntimeContext({ selfKey: 'sol', runtime: 'codex', peers: [] });
  assert.match(codex, /- subagent: 使えない/);
});

const PEERS = [
  { key: 'fable', displayName: 'Fable', userId: '1' },
  { key: 'opus', displayName: 'Opus', userId: '2' },
  { key: 'sol', displayName: 'Sol', userId: null },
];

test('呼べる相手から自分と未起動の bot を外す', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    displayName: 'Opus',
    channelName: 'yobidashi-dev',
    cwd: 'C:/w',
    allowedTools: ['Edit'],
    peers: PEERS,
    owner: { userId: '9', names: ['So'] },
  });
  assert.match(text, /\[\[handoff:fable\]\]/);
  assert.doesNotMatch(text, /\[\[handoff:opus\]\]/, '自分は呼べない');
  assert.doesNotMatch(text, /\[\[handoff:sol\]\]/, '未起動の bot は呼び先に出さない');
  assert.match(text, /いま起動していない: Sol/);
  assert.match(text, /`\[\[notify:owner\]\]` \(So\)/);
  assert.match(text, /`yobidashi-dev`/);
  assert.match(text, /`C:\/w`/);
});

test('呼べる相手に役とランタイムを添える (役割文から固有名詞を外した分の対応表)', () => {
  // 役割文は「reviewer 役を呼ぶ」「codex には touch 制限つき委譲を渡せない」としか書けない。
  // どの bot がそれに当たるかを実行文脈が示さないと宛先が決まらない
  const text = buildRuntimeContext({
    selfKey: 'mgr',
    peers: [
      { key: 'mgr', displayName: 'Mgr', userId: '1', rolePromptFile: 'roles/manager.md' },
      { key: 'w1', displayName: 'W1', userId: '2', rolePromptFile: 'roles/worker.md' },
      { key: 'rv', displayName: 'Rv', userId: '3', rolePromptFile: 'roles/reviewer.md', runtime: 'codex' },
      { key: 'bare', displayName: 'Bare', userId: '4' },
    ],
  });
  assert.match(text, /`\[\[handoff:w1\]\]` W1 \(worker\)/);
  assert.match(text, /`\[\[handoff:rv\]\]` Rv \(reviewer, codex\)/, 'codex を添えていない');
  assert.match(text, /`\[\[handoff:bare\]\]` Bare(?! \()/, '役が無いのに括弧を出している');
  // claude は既定なので出さない (全 job の system prompt を 1 行ずつ太らせない)
  assert.doesNotMatch(text, /\(worker, claude\)/);
});

test('同じ役割文を共有する 2 体は同じ役として出る (役と表示名は別軸)', () => {
  const text = buildRuntimeContext({
    selfKey: 'mgr',
    peers: [
      { key: 'mgr', displayName: 'Mgr', userId: '1' },
      { key: 'w1', displayName: 'W1', userId: '2', rolePromptFile: 'roles/worker.md' },
      { key: 'w2', displayName: 'W2', userId: '3', rolePromptFile: 'roles/worker.md' },
    ],
  });
  assert.match(text, /`\[\[handoff:w1\]\]` W1 \(worker\)/);
  assert.match(text, /`\[\[handoff:w2\]\]` W2 \(worker\)/);
});

// /roster 未設定のスレッドに出るのは「プロセス全体でログイン済みの bot」で、
// 作者が口頭で「このスレッドは Fable なし」と言っても Fable は出続ける。取り違えると
// 編成の指示を無視して呼んでしまうので、一覧の意味を必ず添える (sol 指摘 2026-08-01)
test('編成が未設定なら「起動中の bot」であってスレッド編成ではないと断る', () => {
  const text = buildRuntimeContext({ selfKey: 'sol', peers: PEERS });
  assert.match(text, /呼べる相手 \(いま起動している bot\)/);
  assert.match(text, /このスレッドの編成ではない/);
  assert.match(text, /作者がスレッドで.*指定していたら、そちらが優先/);
});

test('編成が設定されていれば呼べる相手を絞り、断り書きは出さない', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    displayName: 'Opus',
    // /roster members:"opus fable" 相当 (applyRoster が付ける形)
    peers: [
      { key: 'fable', displayName: 'Fable', userId: '1', inRoster: true },
      { key: 'opus', displayName: 'Opus', userId: '2', inRoster: true },
      { key: 'sol', displayName: 'Sol', userId: '3', inRoster: false },
    ],
    rosterSource: 'thread',
  });
  assert.match(text, /呼べる相手 \(このスレッドの編成\)/);
  assert.match(text, /\[\[handoff:fable\]\]/);
  assert.doesNotMatch(text, /\[\[handoff:sol\]\]/, '編成外を呼び先に出している');
  assert.match(text, /編成から外れている: Sol/);
  assert.doesNotMatch(text, /このスレッドの編成ではない/, '絞ってあるのに断り書きが残っている');
});

test('編成外と未起動は理由を混ぜない', () => {
  const text = buildRuntimeContext({
    selfKey: 'fable',
    peers: [
      { key: 'opus', displayName: 'Opus', userId: null, inRoster: true },
      { key: 'sol', displayName: 'Sol', userId: '3', inRoster: false },
    ],
    rosterSource: 'thread',
  });
  assert.match(text, /いま起動していない: Opus/);
  assert.match(text, /編成から外れている: Sol/);
  assert.match(text, /呼べる相手: いない/);
});

test('編成で全員外されたら呼べる相手は居ない', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    peers: [
      { key: 'fable', displayName: 'Fable', userId: '1', inRoster: false },
      { key: 'sol', displayName: 'Sol', userId: '3', inRoster: false },
    ],
    rosterSource: 'thread',
  });
  assert.match(text, /呼べる相手: いない/);
  assert.match(text, /編成から外れている: Fable \/ Sol/);
});

test('呼べる相手が居ないなら編成の断り書きも要らない', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    peers: [{ key: 'opus', displayName: 'Opus', userId: '2' }],
  });
  assert.doesNotMatch(text, /このスレッドの編成ではない/);
});

test('呼べる相手が居ないスレッドでもそう書く', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    displayName: 'Opus',
    peers: [{ key: 'opus', displayName: 'Opus', userId: '2' }],
    owner: { userId: '9', names: ['So'] },
  });
  assert.match(text, /呼べる相手: いない/);
});

test('ownerUserId 未設定なら notify は使えないと書く', () => {
  const text = buildRuntimeContext({ selfKey: 'sol', peers: PEERS, owner: null });
  assert.match(text, /作者への通知: 使えない/);
});

test('Sol の実行文脈は sandbox の実値を映す (role の直書きではない)', () => {
  const rw = buildRuntimeContext({
    selfKey: 'sol',
    displayName: 'Sol',
    runtime: 'codex',
    sandbox: 'workspace-write',
    peers: PEERS,
  });
  assert.match(rw, /書込み可/);

  const ro = buildRuntimeContext({
    selfKey: 'sol',
    displayName: 'Sol',
    runtime: 'codex',
    sandbox: 'read-only',
    peers: PEERS,
  });
  assert.match(ro, /読み取り専用/);
});

// ---- 編成の出所 (rosterSource) ----
// 実行文脈は「正本」として提示されるので、チャンネル既定を「このスレッドの編成」と
// 名乗ると、共通規定の解釈 (作者が /roster で設定したもの) と食い違う

const ROSTER_PEERS = [
  { key: 'fable', displayName: 'Fable', userId: '1', inRoster: false },
  { key: 'opus', displayName: 'Opus', userId: '2', inRoster: true },
  { key: 'sol', displayName: 'Sol', userId: '3', inRoster: true },
];

test('チャンネル既定の編成は「このスレッドの編成」と名乗らない', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    peers: ROSTER_PEERS,
    rosterSource: 'channel',
  });
  assert.match(text, /呼べる相手 \(チャンネル既定の編成\)/);
  assert.doesNotMatch(
    text,
    /このスレッドの編成\)/,
    'config 由来の編成を /roster で設定したものとして出している',
  );
  assert.match(text, /チャンネル既定の編成から外れている: Fable/);
  // 絞られている以上、未設定スレッド向けの断り書きは出さない
  assert.doesNotMatch(text, /このスレッドの編成ではない/);
});

test('スレッド編成とチャンネル既定は同じ絞り込みで名前だけが違う', () => {
  const ofThread = buildRuntimeContext({ selfKey: 'opus', peers: ROSTER_PEERS, rosterSource: 'thread' });
  const ofChannel = buildRuntimeContext({ selfKey: 'opus', peers: ROSTER_PEERS, rosterSource: 'channel' });
  assert.equal(
    ofThread.replace(/このスレッドの編成/g, '編成'),
    ofChannel.replace(/チャンネル既定の編成/g, '編成'),
    '呼び名以外に差が出ている (絞り込みの挙動が出所で変わってはいけない)',
  );
});

test('未知の出所は「編成あり」に化けさせない (fail-closed 側の文言へ)', () => {
  for (const rosterSource of [null, undefined, 'guild', true]) {
    const text = buildRuntimeContext({ selfKey: 'opus', peers: ROSTER_PEERS, rosterSource });
    assert.match(text, /呼べる相手 \(いま起動している bot\)/, String(rosterSource));
    assert.match(text, /このスレッドの編成ではない/, String(rosterSource));
  }
});

// ---- 構造化出力の無効化 (structuredOutput: false) ----
// CLI の --json-schema を落としても役割文の「スキーマで検査する」は消えないので、
// 正本である実行文脈で打ち消さないとモデルは報告調のまま返す

test('構造化を切ったチャンネルでは実行文脈がそう明示する', () => {
  const text = buildRuntimeContext({ selfKey: 'opus', peers: [], structuredOutput: false });
  assert.match(text, /- 構造化された応答: \*\*このチャンネルでは無効\*\*/);
  assert.match(text, /プレーンテキストで返す/);
  // 役割文が名指しで指示している様式を、名指しで打ち消す
  assert.match(text, /schema 宣言/);
  assert.match(text, /やったこと \/ 検証結果 \/ 残課題/);
});

test('構造化が有効なら行そのものを出さない (既定側を太らせない)', () => {
  for (const structuredOutput of [true, undefined]) {
    const text = buildRuntimeContext({ selfKey: 'opus', peers: [], structuredOutput });
    assert.doesNotMatch(text, /構造化された応答/, String(structuredOutput));
  }
});

test('構造化の無効化は「食い違ったらこちらを信じる」の下に置かれる', () => {
  // 実行文脈の冒頭宣言より後ろに無いと、役割文を打ち消す根拠にならない
  const text = buildRuntimeContext({ selfKey: 'opus', peers: [], structuredOutput: false });
  const declaration = text.indexOf('ここに書かれた事実が正本');
  const line = text.indexOf('構造化された応答');
  assert.ok(declaration >= 0 && line > declaration, '打ち消しが正本宣言より前に出ている');
});

// ---- 自己呼び出しの案内 ----

test('自己呼び出しの行は使えるときだけ出す (切ってあるなら存在も教えない)', () => {
  const on = buildRuntimeContext({ selfKey: 'opus', peers: PEERS, maxSelfHops: 3 });
  assert.match(on, /自己呼び出し: `\[\[handoff:opus\]\]`/);
  assert.match(on, /連続 3 回まで/);

  assert.doesNotMatch(
    buildRuntimeContext({ selfKey: 'opus', peers: PEERS, maxSelfHops: 0 }),
    /自己呼び出し/,
    '切ってあるチャンネルで使い方を案内している',
  );
  // 渡し忘れで勝手に案内しない (既定は出さない側)
  assert.doesNotMatch(buildRuntimeContext({ selfKey: 'opus', peers: PEERS }), /自己呼び出し/);
});

test('編成から自分が外れていれば自己呼び出しも案内しない', () => {
  // 送信側の allowlist は自分にも効く (src/mentions.js) ので、案内すると呼べない宛先を教えることになる
  const peers = [
    { key: 'fable', displayName: 'Fable', userId: '1', inRoster: true },
    { key: 'opus', displayName: 'Opus', userId: '2', inRoster: false },
  ];
  const text = buildRuntimeContext({ selfKey: 'opus', peers, maxSelfHops: 3 });
  assert.doesNotMatch(text, /自己呼び出し/);
});

// ---- 案件に結ばれた job の実行文脈 ----

const CASE = {
  caseId: 'C-3',
  desiredOutcome: 'verify を緑に戻す',
  authority: 'fable',
  claimId: 'CL-7',
  claimGeneration: 2,
  responsibility: 'owner',
  actionId: 'A-12',
  actionKind: 'investigate',
  mode: 'observe',
};

test('案件付きの job は案件・決定権者・自分の Claim と世代・この起動を出す', () => {
  const text = buildRuntimeContext({ selfKey: 'opus', societyCase: CASE });
  assert.match(text, /- 案件: `C-3` — verify を緑に戻す \(society\.mode: observe\)/);
  assert.match(text, /決定権者: `fable`/);
  assert.match(text, /あなたの引受け: `CL-7` \(owner\) \/ 世代 2/);
  // 世代の意味 (旧世代の応答は確定に使われない) まで書く
  assert.match(text, /この世代でなくなった後の応答は確定に使われない/);
  assert.match(text, /この起動: `A-12` \(investigate\)/);
  // 次の起動は台帳を通す — 自由文の handoff は効かない
  assert.match(text, /次の起動は `next\.plan` に書く/);
  assert.match(text, /`\[\[handoff:\.\.\.\]\]` は無視される/);
});

test('案件付きの job は observe のとき起こせる Action の 4 種を出す', () => {
  // 門はブリッジ側にあるが、断られる理由を先に見せる (書いてから断られると job 1 本ぶん無駄になる)
  const observing = buildRuntimeContext({ selfKey: 'opus', societyCase: CASE });
  assert.match(observing, /observe で起こせる Action は `consult` \/ `investigate` \/ `measure` \/ `assess` だけ/);
  assert.match(observing, /人間待ち \(waiting\(authority\)\) になる/);
  // active では出さない (制限が無いのに制限を読ませない)
  const active = buildRuntimeContext({ selfKey: 'opus', societyCase: { ...CASE, mode: 'active' } });
  assert.equal(/observe で起こせる/.test(active), false, active);
});

test('案件が無い job では 1 行も増やさない', () => {
  const text = buildRuntimeContext({ selfKey: 'opus' });
  assert.equal(/案件/.test(text), false, text);
  // caseId の無い値は無視する (壊れた入力で実行文脈を汚さない)
  assert.equal(/案件/.test(buildRuntimeContext({ selfKey: 'opus', societyCase: {} })), false);
  assert.equal(/案件/.test(buildRuntimeContext({ selfKey: 'opus', societyCase: 'C-1' })), false);
});

test('案件の欄は分かっている分だけ出す (欠けた材料で嘘を書かない)', () => {
  const text = buildRuntimeContext({
    selfKey: 'opus',
    societyCase: { caseId: 'C-9', authority: null, claimId: null, actionId: null },
  });
  assert.match(text, /- 案件: `C-9`$/m);
  assert.equal(/決定権者/.test(text), false);
  assert.equal(/あなたの引受け/.test(text), false);
  assert.equal(/この起動/.test(text), false);
  assert.match(text, /次の起動は `next\.plan` に書く/);
});
