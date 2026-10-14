import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SOCIETY_SCHEMA, SocietyStore, emptySnapshot, initSocietyLedger,
} from '../src/society-store.js';
import {
  acceptClaim, addFinding, adoptFinding, offerClaim, registerMandate, validateSnapshot,
} from '../src/cases.js';

const T0 = Date.parse('2026-09-07T09:00:00.000Z');

/** 一時領域は必ず後始末する (%TEMP% に残骸を積まない) */
function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'communitd-society-'));
  try {
    return fn(dir, join(dir, 'society.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 責任主体・予算・次の契機を持つところまで進めたスナップショット */
function seededSnapshot(now = T0) {
  let snapshot = emptySnapshot(now);
  snapshot = registerMandate(snapshot, { key: 'quality', version: 1, state: 'active' }, now).snapshot;
  snapshot = addFinding(snapshot, {
    mandateId: 'M-1',
    expected: 'verify が緑のまま',
    actual: 'verify NG が 3 日続いている',
    source: { kind: 'duty' },
    subject: { subjectId: 'task-77', conditionId: 'verify-red', episodeId: 'ep-1' },
  }, now).snapshot;
  snapshot = adoptFinding(snapshot, {
    findingId: 'F-1',
    desiredOutcome: 'verify を緑に戻す',
    acceptance: { condition: 'npm test が全通過する', version: 1 },
    budget: { allocated: 4 },
  }, now).snapshot;
  snapshot = offerClaim(snapshot, { caseId: 'C-1', responsibility: 'owner', botKey: 'opus' }, now).snapshot;
  snapshot = acceptClaim(snapshot, 'CL-1', {
    plan: { claimId: 'CL-1', kind: 'investigate', target: { channel: 'yobidashi-dev' } },
  }, now).snapshot;
  return snapshot;
}

function openObserve(file) {
  return new SocietyStore(file, { mode: 'observe', now: () => T0 });
}

// ---- C01: 破損・消失・未知版・書込失敗を空や成功として扱わない ----

test('society: mode off ではファイルシステムに触れない (壊れた台帳が隣にあっても読まない)', () => {
  withTemp((dir, file) => {
    writeFileSync(file, '{ これは JSON ではない');
    writeFileSync(`${file}.tmp.999.abc`, '{}');
    const before = readFileSync(file);

    const store = new SocietyStore(file, { mode: 'off', now: () => T0 });
    assert.equal(store.state, 'off');
    assert.equal(store.snapshot, null);
    assert.equal(store.broken, null);
    assert.deepEqual(store.leftovers, []);
    // off は「壊れている」ではなく「使っていない」— 起動を止める理由にはならない
    assert.equal(store.haltReason, null);

    const out = store.update(0, (s) => s);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'off');
    assert.deepEqual(readFileSync(file), before);
  });
});

test('society: off なら台帳が無いディレクトリでも何も作らない', () => {
  withTemp((dir) => {
    const file = join(dir, 'not-created', 'society.json');
    const store = new SocietyStore(file, { mode: 'off', now: () => T0 });
    assert.equal(store.state, 'off');
    assert.equal(existsSync(join(dir, 'not-created')), false);
  });
});

test('society: observe / active でファイルが無ければ「初回」と推測せず起動を止める', () => {
  for (const mode of ['observe', 'active']) {
    withTemp((dir, file) => {
      const store = new SocietyStore(file, { mode, now: () => T0 });
      assert.equal(store.state, 'absent', mode);
      assert.equal(store.snapshot, null, mode);
      assert.equal(store.revision, null, mode);
      assert.match(store.haltReason, /初回とは推測しません/);
      assert.match(store.haltReason, new RegExp(`society.mode が ${mode}`));
      assert.match(store.haltReason, /society-init/);

      const out = store.update(0, () => emptySnapshot(T0));
      assert.equal(out.ok, false, mode);
      assert.equal(out.code, 'absent', mode);
      // 読めなかった台帳を勝手に作らない (次の起動が「初回」に見えるのを防ぐ)
      assert.equal(existsSync(file), false, mode);
    });
  }
});

test('society: 正常保存 — revision と updatedAt が進み、tmp を残さない', () => {
  withTemp((dir, file) => {
    assert.equal(initSocietyLedger(file, { now: T0 }).ok, true);
    const store = openObserve(file);
    assert.equal(store.state, 'ok');
    assert.equal(store.revision, 0);

    const out = store.update(0, () => seededSnapshot(T0));
    assert.equal(out.ok, true);
    assert.equal(out.revision, 1);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.schema, SOCIETY_SCHEMA);
    assert.equal(saved.revision, 1);
    assert.equal(saved.updatedAt, new Date(T0).toISOString());
    // tmp → rename なので、成功した保存の後に痕跡は残らない
    assert.deepEqual(readdirSync(dir), ['society.json']);
  });
});

test('society: 開き直しても owner・budget・nextTrigger が残る (再起動を跨いだ責任と次の契機)', () => {
  withTemp((dir, file) => {
    initSocietyLedger(file, { now: T0 });
    const before = openObserve(file);
    before.update(0, () => seededSnapshot(T0));
    const written = before.snapshot.cases['C-1'];

    const after = openObserve(file);
    assert.equal(after.state, 'ok');
    assert.equal(after.revision, 1);
    const restored = after.snapshot.cases['C-1'];
    assert.equal(restored.owner, 'CL-1');
    assert.equal(after.snapshot.claims['CL-1'].botKey, 'opus');
    assert.equal(after.snapshot.claims['CL-1'].generation, 1);
    assert.deepEqual(restored.budget, { allocated: 4, reserved: 1, charged: 0 });
    assert.deepEqual(restored.nextTrigger, { kind: 'nextAction', actionId: 'A-1' });
    assert.deepEqual(restored, written);
    assert.deepEqual(validateSnapshot(after.snapshot), []);
  });
});

test('society: 構文エラー・構造不正・未知 schema・revision 不正は broken にして書かない', () => {
  const injections = [
    ['syntax-error', '{ "schema": "society/1", '],
    ['shape-error', '[]'],
    ['shape-error', JSON.stringify({ schema: SOCIETY_SCHEMA, revision: 0, cases: [] })],
    ['shape-error', JSON.stringify({ ...emptySnapshot(T0), counters: undefined })],
    ['unknown-schema', JSON.stringify({ ...emptySnapshot(T0), schema: 'society/2' })],
    ['bad-revision', JSON.stringify({ ...emptySnapshot(T0), revision: 1.5 })],
    ['bad-revision', JSON.stringify({ ...emptySnapshot(T0), revision: -1 })],
  ];
  for (const [kind, text] of injections) {
    withTemp((dir, file) => {
      writeFileSync(file, text);
      const before = readFileSync(file);
      const store = openObserve(file);
      assert.equal(store.state, 'broken', `${kind}: ${text.slice(0, 40)}`);
      assert.equal(store.broken.kind, kind, `${kind}: ${text.slice(0, 40)}`);
      assert.ok(store.broken.reason.length > 0);
      assert.equal(store.snapshot, null);
      assert.match(store.haltReason, /読まない・書かない/);

      const out = store.update(0, () => emptySnapshot(T0));
      assert.equal(out.ok, false);
      assert.equal(out.code, 'broken');
      // **壊れたファイルは在処に残す** (退避も上書きもしない — 人が直すための証拠)
      assert.deepEqual(readFileSync(file), before);
    });
  }
});

test('society: 読取エラー (ファイルの代わりにディレクトリ) も broken として止まる', () => {
  withTemp((dir, file) => {
    mkdirSync(file);
    writeFileSync(join(file, 'keep.txt'), 'これは消えない');
    const store = openObserve(file);
    assert.equal(store.state, 'broken');
    assert.equal(store.broken.kind, 'read-error');
    assert.ok(['EISDIR', 'EACCES', 'EPERM'].includes(store.broken.code), store.broken.code);

    const out = store.update(0, () => emptySnapshot(T0));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'broken');
    assert.equal(readFileSync(join(file, 'keep.txt'), 'utf8'), 'これは消えない');
  });
});

test('society: 部分更新の痕跡 (.tmp.*) は読まず消さず、片付くまで書き込みを断る', () => {
  withTemp((dir, file) => {
    initSocietyLedger(file, { now: T0 });
    const leftover = `${file}.tmp.4242.deadbeef`;
    writeFileSync(leftover, JSON.stringify({ schema: SOCIETY_SCHEMA, revision: 99 }));
    const before = readFileSync(file);

    const store = openObserve(file);
    assert.equal(store.state, 'ok');
    assert.deepEqual(store.leftovers, [leftover]);
    assert.equal(store.healthy, false);
    assert.match(store.haltReason, /部分更新の痕跡/);
    // 痕跡は台帳として読まない (revision 99 を採らない)
    assert.equal(store.revision, 0);

    const out = store.update(0, () => seededSnapshot(T0));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'leftovers');
    assert.deepEqual(readFileSync(file), before);
    // 勝手に消さない — 中身を確かめるのは人間
    assert.equal(existsSync(leftover), true);
  });
});

// ---- C04 の一部: 版の食い違いと書込失敗 ----

test('society: revision が食い違えば何も書かず conflict を返す', () => {
  withTemp((dir, file) => {
    initSocietyLedger(file, { now: T0 });
    const store = openObserve(file);
    store.update(0, () => seededSnapshot(T0));
    const before = readFileSync(file);

    let called = false;
    const out = store.update(0, (s) => { called = true; return s; });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'conflict');
    assert.equal(out.revision, 1);
    // mutate すら呼ばない (呼ぶと「古い版の上に組み立てた新しい版」ができる)
    assert.equal(called, false);
    assert.equal(store.revision, 1);
    assert.deepEqual(readFileSync(file), before);
  });
});

test('society: 不変条件に落ちる mutate は書かず、メモリも動かさない', () => {
  withTemp((dir, file) => {
    initSocietyLedger(file, { now: T0 });
    const store = openObserve(file);
    store.update(0, () => seededSnapshot(T0));
    const before = readFileSync(file);

    const out = store.update(1, (s) => {
      // 次の契機を消す = §3 の不変条件に落ちる形
      s.cases['C-1'].nextTrigger = null;
      return s;
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid');
    assert.ok(out.errors.some((e) => e.includes('次の契機が無い')), out.errors.join(' / '));
    assert.equal(store.revision, 1);
    assert.deepEqual(store.snapshot.cases['C-1'].nextTrigger, { kind: 'nextAction', actionId: 'A-1' });
    assert.deepEqual(readFileSync(file), before);
  });
});

test('society: 書込みに失敗したらメモリを巻き戻して throw する', () => {
  withTemp((dir, file) => {
    initSocietyLedger(file, { now: T0 });
    const store = openObserve(file);
    const before = store.snapshot;

    // 保存先の親を「ファイル」にして mkdir を失敗させる (ディスク不良の代わり)
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    store.filePath = join(blocker, 'society.json');

    // 何で落ちたのかまで固定する (握って ok:false に化けていないこと)
    assert.throws(
      () => store.update(0, () => seededSnapshot(T0)),
      (err) => err instanceof Error && ['ENOTDIR', 'EEXIST', 'ENOENT'].includes(err.code),
      '保存先の親がファイルなら fs のエラーがそのまま出る',
    );
    // 「呼び出し側は失敗を報告したのに、動いているプロセスには新しい値が効いている」を作らない
    assert.equal(store.revision, 0);
    assert.deepEqual(store.snapshot, before);
    assert.equal(readdirSync(dir).includes('society.json'), true);
  });
});

// ---- 明示初期化 ----

test('society-init: 無ければ revision 0 の台帳を作り、あれば上書きしない', () => {
  withTemp((dir, file) => {
    const first = initSocietyLedger(file, { now: T0 });
    assert.equal(first.ok, true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.schema, SOCIETY_SCHEMA);
    assert.equal(saved.revision, 0);
    assert.deepEqual(saved.cases, {});
    assert.deepEqual(saved.counters, {});
    assert.deepEqual(validateSnapshot(saved), []);

    writeFileSync(file, JSON.stringify({ ...saved, revision: 7 }));
    const again = initSocietyLedger(file, { now: T0 });
    assert.equal(again.ok, false);
    assert.match(again.reason, /上書きしません/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 7);
  });
});

test('society-init: 本体が無くても部分更新の痕跡が残っていれば作らない', () => {
  withTemp((dir, file) => {
    // rename の前に落ちた形 (本体は無く tmp だけ残っている)
    const leftover = `${file}.tmp.4242.deadbeef`;
    writeFileSync(leftover, JSON.stringify({ schema: SOCIETY_SCHEMA, revision: 3 }));

    const out = initSocietyLedger(file, { now: T0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /部分更新の痕跡/);
    // 空台帳を作ってしまうと、書きかけの中身を隣に残したまま「空から始まった台帳」ができる
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(leftover), true);

    // 人が片付ければ作れる
    rmSync(leftover);
    assert.equal(initSocietyLedger(file, { now: T0 }).ok, true);
  });
});
