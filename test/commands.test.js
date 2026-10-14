import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CASE_RESPONSIBILITIES,
  DEFAULT_STOP_SCOPE,
  SLASH_COMMANDS,
  STOP_SCOPES,
  formatPauseState,
  resolveCaseRequest,
  resolveStopScope,
} from '../src/commands.js';

const byName = Object.fromEntries(SLASH_COMMANDS.map((c) => [c.name, c]));

test('登録するのは /stop・/roster・/restart と、自律運転の /pause・/resume・/proposals・/review', () => {
  // コマンドが増えても既存が消えていないことを見る (並び順には意味がない)
  const names = SLASH_COMMANDS.map((c) => c.name);
  for (const name of ['stop', 'roster', 'restart', 'pause', 'resume', 'proposals', 'review']) {
    assert.ok(names.includes(name), `/${name} が登録されていない`);
  }
  assert.equal(new Set(names).size, names.length, '同じ名前を二重に登録している');
  for (const cmd of SLASH_COMMANDS) {
    assert.ok(cmd.description, `${cmd.name} に説明がない`);
    // Discord の制約 (名前は小文字・説明は 100 字以内)
    assert.match(cmd.name, /^[a-z]{1,32}$/);
    assert.ok(cmd.description.length <= 100, `${cmd.name} の説明が長すぎる`);
  }
});

test('/case は全オプション任意で、責務は閉じた選択式', () => {
  const cmd = byName.case;
  assert.ok(cmd, '/case が登録されていない');
  const names = cmd.options.map((o) => o.name);
  assert.deepEqual(names, ['id', 'resume', 'new', 'goal', 'acceptance', 'bot', 'responsibility', 'summary']);
  // 引数なしで一覧が出せること = 全部任意
  assert.equal(cmd.options.some((o) => o.required), false, '必須のオプションがある');
  const responsibility = cmd.options.find((o) => o.name === 'responsibility');
  assert.deepEqual(responsibility.choices.map((c) => c.value), CASE_RESPONSIBILITIES);
  // authority は config が決める担当なので手では立てない
  assert.equal(CASE_RESPONSIBILITIES.includes('authority'), false);
});

test('/case の引数は 4 つの操作へ振り分ける (足りない組み合わせは断る)', () => {
  // 引数なし = 一覧
  assert.deepEqual(resolveCaseRequest({}), { ok: true, request: { action: 'list' } });
  assert.deepEqual(resolveCaseRequest({ id: '  ' }), { ok: true, request: { action: 'list' } });
  // id だけ = 詳細
  assert.deepEqual(resolveCaseRequest({ id: 'C-1' }), { ok: true, request: { action: 'detail', id: 'C-1' } });
  // id + bot = 相談 (責務は既定 owner・要旨は任意)
  assert.deepEqual(resolveCaseRequest({ id: 'C-1', bot: 'opus' }), {
    ok: true,
    request: { action: 'offer', id: 'C-1', botKey: 'opus', responsibility: 'owner', summary: null },
  });
  assert.equal(
    resolveCaseRequest({ id: 'C-1', bot: 'opus', responsibility: 'assessor', summary: 'みて' }).request.responsibility,
    'assessor',
  );
  // 知らない責務は既定へ倒す (Discord の choices を抜けてきた値を信じない)
  assert.equal(resolveCaseRequest({ id: 'C-1', bot: 'opus', responsibility: 'authority' }).request.responsibility, 'owner');
  // new = 案件を開く (goal と acceptance が要る)
  assert.deepEqual(resolveCaseRequest({ new: 'quality', goal: 'verify を緑に', acceptance: 'npm test 全通過' }), {
    ok: true,
    request: { action: 'new', mandateKey: 'quality', goal: 'verify を緑に', acceptance: 'npm test 全通過' },
  });

  // 足りない / 混ざった組み合わせは台帳へ降ろす前に断る
  const rejects = [
    [{ new: 'quality' }, /goal/],
    [{ new: 'quality', goal: 'x' }, /acceptance/],
    [{ new: 'quality', goal: 'x', acceptance: 'y', id: 'C-1' }, /new は id \/ bot と一緒に/],
    [{ new: 'quality', goal: 'x', acceptance: 'y', bot: 'opus' }, /new は id \/ bot と一緒に/],
    [{ bot: 'opus' }, /案件の id/],
    [{ goal: 'x' }, /new .* と一緒に/],
  ];
  for (const [options, re] of rejects) {
    const out = resolveCaseRequest(options);
    assert.equal(out.ok, false, JSON.stringify(options));
    assert.match(out.reason, re);
  }
});

test('/case の resume は単独の操作として振り分ける', () => {
  // 停止の解除は明示の操作だけ (§12.2 (g)) — 認可は interactions 側の owner 限定の門
  assert.deepEqual(resolveCaseRequest({ resume: 'C-1' }), { ok: true, request: { action: 'resume', id: 'C-1' } });
  assert.deepEqual(resolveCaseRequest({ resume: ' C-2 ' }), { ok: true, request: { action: 'resume', id: 'C-2' } });
  assert.deepEqual(resolveCaseRequest({ resume: '  ' }), { ok: true, request: { action: 'list' } });
  // 併用は断る (解除は通ったが相談は出せなかった、を作らない)
  for (const options of [
    { resume: 'C-1', id: 'C-1' },
    { resume: 'C-1', bot: 'opus' },
    { resume: 'C-1', new: 'quality', goal: 'x', acceptance: 'y' },
    { resume: 'C-1', summary: 'みて' },
  ]) {
    const out = resolveCaseRequest(options);
    assert.equal(out.ok, false, JSON.stringify(options));
    assert.match(out.reason, /resume は他のオプションと一緒に/);
  }
});

test('/stop の scope は this / all の選択式で任意', () => {
  const [scope] = byName.stop.options;
  assert.equal(scope.name, 'scope');
  assert.equal(scope.type, 3, 'STRING 型ではない');
  assert.equal(scope.required, false);
  assert.deepEqual(scope.choices.map((c) => c.value), STOP_SCOPES);
  for (const c of scope.choices) assert.ok(c.name.length <= 100, `選択肢の表示名が長すぎる: ${c.name}`);
});

test('/pause の reason は自由入力で任意 / /resume は引数なし', () => {
  const [reason] = byName.pause.options;
  assert.equal(reason.name, 'reason');
  assert.equal(reason.type, 3, 'STRING 型ではない');
  assert.equal(reason.required, false);
  assert.equal(byName.resume.options ?? undefined, undefined, '/resume に引数がある');
});

test('/review の id は自由入力で任意 (省略するとこのスレッドのタスク)', () => {
  const [id] = byName.review.options;
  assert.equal(id.name, 'id');
  assert.equal(id.type, 3, 'STRING 型ではない');
  assert.equal(id.required, false);
});

test('formatPauseState はいつ誰が止めたかを必ず含める', () => {
  assert.match(formatPauseState(null), /動いています/);
  assert.match(formatPauseState(undefined), /動いています/);

  const line = formatPauseState({
    paused: true, at: '2026-08-28T09:00:00.000Z', by: 'U1', reason: '様子を見る',
  });
  assert.match(line, /停止中/);
  assert.match(line, /2026-08-28 18:00 JST/, '止めた時刻が JST で入っていない');
  assert.match(line, /<@U1>/, '止めた人が無い');
  assert.match(line, /様子を見る/, '理由が無い');

  // 欠けていても「不明」と言って黙らない
  const bare = formatPauseState({ paused: true });
  assert.match(bare, /時刻不明/);
  assert.match(bare, /誰か不明/);
  assert.equal(/理由/.test(bare), false, '理由が無いのに空の理由欄を出している');
});

test('/roster の members は自由入力で任意 (省略 = 現況の表示)', () => {
  const [members] = byName.roster.options;
  assert.equal(members.name, 'members');
  assert.equal(members.type, 3, 'STRING 型ではない');
  assert.equal(members.required, false);
  assert.ok(members.description.length <= 100, '選択肢の説明が長すぎる');
});

test('/restart の force は真偽値で任意 (既定は素の再起動)', () => {
  const [force] = byName.restart.options;
  assert.equal(force.name, 'force');
  assert.equal(force.type, 5, 'BOOLEAN 型ではない');
  assert.equal(force.required, false);
});

test('スレッド内: scope 未指定はそのスレッドだけ', () => {
  assert.deepEqual(resolveStopScope({ inThread: true }), {
    all: false,
    requested: DEFAULT_STOP_SCOPE,
    fellBackToAll: false,
  });
  assert.deepEqual(resolveStopScope({ scope: 'this', inThread: true }), {
    all: false,
    requested: 'this',
    fellBackToAll: false,
  });
});

test('スレッド内: scope:all は全体停止', () => {
  assert.deepEqual(resolveStopScope({ scope: 'all', inThread: true }), {
    all: true,
    requested: 'all',
    fellBackToAll: false,
  });
});

test('スレッド外は止める対象のスレッドが無いので全体停止に倒す', () => {
  assert.deepEqual(resolveStopScope({ inThread: false }), {
    all: true,
    requested: 'this',
    fellBackToAll: true,
  });
  assert.deepEqual(resolveStopScope({ scope: 'this', inThread: false }), {
    all: true,
    requested: 'this',
    fellBackToAll: true,
  });
  // 明示的な all はフォールバックではない
  assert.deepEqual(resolveStopScope({ scope: 'all', inThread: false }), {
    all: true,
    requested: 'all',
    fellBackToAll: false,
  });
});

test('未知の scope・引数なしでも既定 (this) に落ちる', () => {
  for (const scope of [null, undefined, '', 'ALL', 'everything', 42]) {
    assert.equal(
      resolveStopScope({ scope, inThread: true }).requested,
      DEFAULT_STOP_SCOPE,
      `既定に落ちない: ${String(scope)}`,
    );
  }
  assert.deepEqual(resolveStopScope(), { all: true, requested: 'this', fellBackToAll: true });
});
