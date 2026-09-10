import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRANT_KINDS,
  GRANT_SCHEMA_VERSION,
  canonicalCwd,
  grantDigest,
  grantFingerprint,
  makeGrant,
  renderRule,
  validateGrant,
} from '../src/grants.js';

/** 実在する作業ディレクトリ (validateGrant は cwd が正規形であることを要求する) */
const CWD = canonicalCwd(mkdtempSync(join(tmpdir(), 'communitd-cwd-')));
const web = (value, over = {}) => ({ kind: 'web-domain', tool: 'WebFetch', value, cwd: CWD, ...over });

// ---- canonicalCwd ----

test('canonicalCwd は同じ場所を同じ文字列にする', () => {
  const root = mkdtempSync(join(tmpdir(), 'communitd-canon-'));
  const base = canonicalCwd(root);
  assert.equal(typeof base, 'string');
  assert.equal(base.includes('\\'), false, '区切りが正規化されていない');
  assert.equal(canonicalCwd(`${root}/`), base);
  assert.equal(canonicalCwd(root.replaceAll('\\', '/')), base);
  assert.equal(canonicalCwd(base), base, '正規形を通しても変わってはいけない');
});

test('canonicalCwd は解決できないものを null にする (fail-closed の材料)', () => {
  assert.equal(canonicalCwd(join(tmpdir(), 'communitd-does-not-exist-xyz')), null);
  assert.equal(canonicalCwd(''), null);
  assert.equal(canonicalCwd(null), null);
});

test('canonicalCwd はリンクを実体へ寄せる', () => {
  const real = mkdtempSync(join(tmpdir(), 'communitd-real-'));
  const linkParent = mkdtempSync(join(tmpdir(), 'communitd-link-'));
  const link = join(linkParent, 'alias');
  try {
    symlinkSync(real, link, 'junction');
  } catch {
    return;
  }
  assert.equal(canonicalCwd(link), canonicalCwd(real));
});

// ---- 自動承認できる種類 ----

test('自動承認できるのはドメイン限定だけ (shell は grant にしない)', () => {
  // claude は照合前に timeout / xargs のような wrapper を外すので、
  // コマンド文字列の完全一致では実行されるコマンドを固定できない
  assert.deepEqual(GRANT_KINDS, ['web-domain']);
  assert.equal(validateGrant(web('docs.example.com')).ok, true);
  assert.equal(
    validateGrant({ kind: 'shell-exact', tool: 'Bash', value: 'npm ci', cwd: CWD }).ok,
    false,
    'shell-exact をまだ受け付けている',
  );
});

test('ルール文字列は grant から組み立てる (保存するのは grant の方)', () => {
  assert.equal(renderRule(web('example.com')), 'WebFetch(domain:example.com)');
});

test('付随メタデータは持てる (承認者・時刻・出所)', () => {
  assert.equal(validateGrant(web('example.com', {
    approvedBy: 'U1', approvedAt: '2026-08-01T00:00:00.000Z', botKey: 'opus', threadId: 'T1',
  })).ok, true);
});

// ---- 落とすもの (fail-closed) ----

test('未知の kind・余分なキー・欠けたキーは破棄する', () => {
  assert.match(validateGrant(web('example.com', { kind: 'path-exact' })).reason, /未知の kind/);
  assert.match(validateGrant(web('example.com', { extra: 1 })).reason, /未知のキー/);
  for (const key of ['kind', 'tool', 'value', 'cwd']) {
    const broken = web('example.com');
    delete broken[key];
    assert.match(validateGrant(broken).reason, new RegExp(key));
  }
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(validateGrant(bad).ok, false, `通してはいけない: ${JSON.stringify(bad)}`);
  }
});

test('kind とツールの組み合わせが違えば破棄する', () => {
  assert.equal(validateGrant(web('example.com', { tool: 'Bash' })).ok, false);
  // 裸のツール名 (かつてのパス許可) は kind そのものが無いので通らない
  assert.equal(validateGrant({ kind: 'tool', tool: 'Edit', value: 'Edit', cwd: CWD }).ok, false);
});

test('ドメインは https の実ホストだけ (IP・localhost・大文字は破棄)', () => {
  for (const host of ['localhost', '127.0.0.1', 'EXAMPLE.com', 'example', '', 'ex ample.com']) {
    assert.equal(validateGrant(web(host)).ok, false, `通してはいけない: ${host}`);
  }
});

test('秘密らしいホスト名は恒久承認しない', () => {
  // 発行済みエンドポイントがホスト名に秘密を含むことがある。
  // 承認ログにも Discord にも残るので、疑わしければ通さない
  for (const host of [
    'api-key-0123456789abcdef0123456789abcdef.example.com',
    'token.example.com',
    'secret-endpoint.example.com',
    'my-credentials.example.com',
    '0123456789abcdef0123456789abcdef.example.com',
  ]) {
    const r = validateGrant(web(host));
    assert.equal(r.ok, false, `通してはいけない: ${host}`);
    assert.match(r.reason, /秘密/);
  }
  // 普通のホストは通る
  assert.equal(validateGrant(web('docs.example.com')).ok, true);
  assert.equal(validateGrant(web('api.example.com')).ok, true);
});

test('cwd は正規形そのものでなければ破棄する', () => {
  // 表記違いを許すと「承認も保存も成功したのに次の job で一致しない」が起きる
  for (const cwd of [
    CWD.replaceAll('/', '\\'),                // Windows 表記
    `${CWD}/`,                                // 末尾スラッシュ
    join(tmpdir(), 'communitd-not-exist-xyz'), // 実在しない
    'relative/path',
  ]) {
    const r = validateGrant(web('example.com', { cwd }));
    assert.equal(r.ok, false, `通してはいけない: ${cwd}`);
    assert.match(r.reason, /cwd/);
  }
});

test('前後の空白がある値は破棄する (保存値は無加工が原則)', () => {
  assert.equal(validateGrant(web(' example.com')).ok, false);
  assert.equal(validateGrant(web('example.com ')).ok, false);
});

// ---- makeGrant ----

test('makeGrant は値に手を加えない (trim して別の値を承認しない)', () => {
  assert.equal(makeGrant({ kind: 'web-domain', tool: 'WebFetch', value: ' example.com ', cwd: CWD }).ok,
    false, '空白を落として通してしまっている');
  const ok = makeGrant({ kind: 'web-domain', tool: 'WebFetch', value: 'example.com', cwd: CWD });
  assert.equal(ok.ok, true);
  assert.equal(ok.grant.value, 'example.com');
});

// ---- 指紋 ----

test('digest は値ごとに変わり、メタデータでは変わらない', () => {
  const a = web('example.com');
  const b = web('example.com', { approvedBy: 'U1' });
  assert.equal(grantDigest(a), grantDigest(b), 'メタデータで指紋が変わっている');
  assert.notEqual(grantDigest(a), grantDigest(web('other.example.com')));
  assert.equal(grantDigest(a).length, 16);
});

test('監査用の指紋には値そのものを含めない', () => {
  const fp = grantFingerprint(web('secret-host.example.com'));
  assert.equal(fp.includes('secret-host'), false, '監査ログに値が漏れている');
  assert.match(fp, /^web-domain\/WebFetch#[0-9a-f]{16}$/);
});

test('スキーマ版は明示されている', () => {
  assert.equal(GRANT_SCHEMA_VERSION, 2);
});
