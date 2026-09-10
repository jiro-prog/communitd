import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverTurn } from '../src/delivery.js';

/** 呼ばれた順を 1 本のログに集める */
function harness({ failing = [], mentionFails = false, mention = { userId: 'F1' } } = {}) {
  const log = [];
  const step = (label, required = false) => ({
    label,
    required,
    run: async () => {
      log.push(label);
      if (failing.includes(label)) throw new Error(`${label} が送れない`);
    },
  });
  return {
    log,
    mention,
    step,
    sendMention: async () => {
      log.push('mention');
      if (mentionFails) throw new Error('archived');
    },
    notifyFailure: async (failures) => log.push(`notify:${failures.length}`),
  };
}

test('全部成功したら最後に制御メンションを 1 回だけ送る', async () => {
  const h = harness();
  const res = await deliverTurn({
    steps: [h.step('本文', true), h.step('添付'), h.step('警告')],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: h.notifyFailure,
  });
  assert.deepEqual(h.log, ['本文', '添付', '警告', 'mention'], '投稿順が固定されていない');
  assert.deepEqual(res, { delivered: true, handedOff: true, failures: [] });
});

test('宛先が無ければ handoff せずに完了する', async () => {
  const h = harness({ mention: null });
  const res = await deliverTurn({
    steps: [h.step('本文', true)],
    mention: null,
    sendMention: h.sendMention,
  });
  assert.deepEqual(h.log, ['本文'], '呼ぶ相手が無いのに送っている');
  assert.deepEqual(res, { delivered: true, handedOff: false, failures: [] });
});

test('途中の送信が失敗したら handoff しない (不完全な文脈で次を走らせない)', async () => {
  const h = harness({ failing: ['添付'] });
  const res = await deliverTurn({
    steps: [h.step('本文', true), h.step('添付'), h.step('警告')],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: h.notifyFailure,
  });
  // 残りのステップは続ける (届けられるものは届ける) が、最後の呼び出しはしない
  assert.deepEqual(h.log, ['本文', '添付', '警告', 'notify:1']);
  assert.equal(h.log.includes('mention'), false, '失敗しているのに次を呼んでいる');
  assert.equal(res.delivered, false);
  assert.equal(res.handedOff, false);
  assert.match(res.failures[0], /添付/);
});

test('本文が失敗したら以降を続けず、失敗も告知する', async () => {
  const h = harness({ failing: ['本文'] });
  const res = await deliverTurn({
    steps: [h.step('本文', true), h.step('添付')],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: h.notifyFailure,
  });
  // 添付へは進まないが、失敗の告知だけは必ず通る (placeholder 経由でも届く)
  assert.deepEqual(h.log, ['本文', 'notify:1'], '本文の失敗を握り潰している');
  assert.equal(res.handedOff, false);
});

test('制御メンションだけ失敗した場合も handoff 済みにせず告知する (archive・削除)', async () => {
  const h = harness({ mentionFails: true });
  const res = await deliverTurn({
    steps: [h.step('本文', true)],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: h.notifyFailure,
  });
  assert.deepEqual(h.log, ['本文', 'mention', 'notify:1']);
  assert.equal(res.delivered, false);
  assert.equal(res.handedOff, false);
  assert.match(res.failures[0], /制御メンション: archived/);
});

test('失敗の告知そのものが失敗しても判断は変わらない', async () => {
  const h = harness({ failing: ['添付'] });
  const res = await deliverTurn({
    steps: [h.step('本文', true), h.step('添付')],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: async () => { throw new Error('archived'); },
  });
  assert.equal(res.handedOff, false);
  assert.equal(h.log.includes('mention'), false);
});

test('複数の失敗をまとめて返す', async () => {
  const h = harness({ failing: ['添付', '警告'] });
  const res = await deliverTurn({
    steps: [h.step('本文', true), h.step('添付'), h.step('警告')],
    mention: h.mention,
    sendMention: h.sendMention,
    notifyFailure: h.notifyFailure,
  });
  assert.equal(res.failures.length, 2);
  assert.ok(h.log.includes('notify:2'));
});

test('ステップが無い・引数が空でも落ちない', async () => {
  assert.deepEqual(await deliverTurn(), { delivered: true, handedOff: false, failures: [] });
  assert.deepEqual(
    await deliverTurn({ steps: [], mention: null }),
    { delivered: true, handedOff: false, failures: [] },
  );
});
