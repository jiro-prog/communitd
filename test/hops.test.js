import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_BOT_HOPS, HopTracker } from '../src/hops.js';

test('既定の上限は 12 (6 では検収の往復で足りない)', () => {
  assert.equal(DEFAULT_MAX_BOT_HOPS, 12);
  assert.equal(new HopTracker().max, 12);
});

test('上限までは許可し、超えたら止める', () => {
  const t = new HopTracker(3);
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 1, warn: false });
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 2, warn: false });
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 3, warn: false });
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 3, warn: true });
});

test('上限到達の通知は 1 スレッドにつき 1 回だけ', () => {
  const t = new HopTracker(1);
  t.take('T1');
  assert.equal(t.take('T1').warn, true);
  for (let i = 0; i < 5; i++) {
    const hop = t.take('T1');
    assert.equal(hop.allowed, false);
    assert.equal(hop.warn, false, '上限に張り付いたスレッドで警告を撒いている');
  }
});

test('人間の発言でカウンタと通知済みフラグが戻る', () => {
  const t = new HopTracker(2);
  t.take('T1');
  t.take('T1');
  assert.equal(t.take('T1').allowed, false);
  assert.equal(t.hops('T1'), 2);

  t.reset('T1');
  assert.equal(t.hops('T1'), 0);
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 1, warn: false });
  // 再び上限に達したら通知はもう一度出る (別の行き詰まりなので黙らせない)
  t.take('T1');
  assert.equal(t.take('T1').warn, true);
});

test('カウンタはスレッドごとに独立', () => {
  const t = new HopTracker(1);
  assert.equal(t.take('T1').allowed, true);
  assert.equal(t.take('T2').allowed, true, '別スレッドが巻き添えで止まっている');
  assert.equal(t.take('T1').allowed, false);
  assert.equal(t.hops('T2'), 1);

  t.reset('T1');
  assert.equal(t.hops('T2'), 1, 'reset が別スレッドまで戻している');
});

test('上限 0 は bot 起点の起動を一切許さない', () => {
  const t = new HopTracker(0);
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 0, warn: true });
  assert.equal(t.take('T1').warn, false);
});

test('未知スレッドの hops は 0 / reset は無害', () => {
  const t = new HopTracker();
  assert.equal(t.hops('never-seen'), 0);
  t.reset('never-seen');
  assert.equal(t.hops('never-seen'), 0);
});

// ---- 連続自己呼び出し (bot 間ホップとは別枠) ----

test('自己呼び出しは既定では別枠で絞らない (bot ホップ全体の枠に従う)', () => {
  assert.equal(new HopTracker().selfMax, DEFAULT_MAX_BOT_HOPS);
  assert.equal(new HopTracker(5).selfMax, 5);
  // 書いたときだけその値 (0 も有効 = 自己呼び出しを止める)
  assert.equal(new HopTracker(12, 3).selfMax, 3);
  assert.equal(new HopTracker(12, 0).selfMax, 0);
});

test('自己呼び出しは上限まで許可し、超えたら止める (通知は 1 回だけ)', () => {
  const t = new HopTracker(12, 2);
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 1, warn: false });
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 2, warn: false });
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: false, hops: 2, warn: true });
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: false, hops: 2, warn: false });
});

test('bot 間ホップとは別枠 — 自己呼び出しは take を消費しない', () => {
  const t = new HopTracker(12, 3);
  t.takeSelf('T1', 'opus');
  assert.equal(t.hops('T1'), 0, 'takeSelf が bot 間ホップまで進めている');
  assert.equal(t.selfHops('T1', 'opus'), 1);
});

test('別の担当が動くと自己呼び出しの連鎖は切れる (bot 間ホップは切れない)', () => {
  const t = new HopTracker(12, 2);
  t.take('T1');
  t.takeSelf('T1', 'opus');
  t.takeSelf('T1', 'opus');
  assert.equal(t.takeSelf('T1', 'opus').allowed, false);

  t.breakSelfChain('T1');
  assert.equal(t.selfHops('T1', 'opus'), 0);
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 1, warn: false });
  assert.equal(t.hops('T1'), 1, 'breakSelfChain が bot 間ホップまで戻している');
});

test('担当が違えば自己連鎖は数え直す (通知済みフラグも連鎖ごと)', () => {
  const t = new HopTracker(12, 1);
  assert.equal(t.takeSelf('T1', 'opus').allowed, true);
  assert.equal(t.takeSelf('T1', 'opus').warn, true, 'opus が上限に達した通知');

  // sol の自己呼び出しは opus の連鎖を引き継がない
  assert.deepEqual(t.takeSelf('T1', 'sol'), { allowed: true, hops: 1, warn: false });
  assert.equal(t.selfHops('T1', 'opus'), 0, '連鎖は担当ごとに 1 本だけ');
  assert.equal(t.takeSelf('T1', 'sol').warn, true, '担当が代わったのに通知が黙らされている');
});

test('人間の発言は自己連鎖も戻す', () => {
  const t = new HopTracker(12, 1);
  t.takeSelf('T1', 'opus');
  assert.equal(t.takeSelf('T1', 'opus').allowed, false);

  t.reset('T1');
  assert.equal(t.selfHops('T1', 'opus'), 0);
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 1, warn: false });
});

test('自己連鎖はスレッドごとに独立 / 上限 0 は自己呼び出しを一切許さない', () => {
  const t = new HopTracker(12, 1);
  assert.equal(t.takeSelf('T1', 'opus').allowed, true);
  assert.equal(t.takeSelf('T2', 'opus').allowed, true, '別スレッドが巻き添えで止まっている');

  const off = new HopTracker(12, 0);
  assert.deepEqual(off.takeSelf('T1', 'opus'), { allowed: false, hops: 0, warn: true });
  assert.equal(off.takeSelf('T1', 'opus').warn, false);
});

// ---- タスクスレッドの job 予算 (無人運転の門番 — docs/social-engineering.md §3.5) ----

test('予算を払い出していないスレッドは従来どおり (門番が居ない)', () => {
  const t = new HopTracker(3);
  assert.equal(t.taskBudget('T1'), null);
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 1, warn: false });
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 1, warn: false });
  assert.equal(t.taskBudget('T1'), null, '触っていないスレッドに予算が生えている');
  t.reset('T1');
  assert.equal(t.taskBudget('T1'), null);
});

test('予算の付与は 0 以上の整数だけ受ける (書き損じを黙って無制限にしない)', () => {
  const t = new HopTracker();
  for (const jobs of [-1, 1.5, '3', null, undefined, NaN, Infinity]) {
    assert.throws(() => t.grantTaskBudget('T1', jobs), /job 予算/, JSON.stringify(jobs));
  }
  assert.equal(t.taskBudget('T1'), null, '弾いたのに門番が付いている');
  // 0 は「予算ゼロの門番」として通す (そのスレッドを止めておく操作)
  assert.equal(t.grantTaskBudget('T1', 0), 0);
  assert.equal(t.taskBudget('T1'), 0);
  assert.equal(t.take('T1').allowed, false);
});

test('releaseTaskBudget は積んだのに起動しなかったぶんを戻す (0 で止める)', () => {
  const t = new HopTracker();
  // 予算を配っていないスレッドには何もしない (門番ごと不在 = 従来どおりを壊さない)
  assert.equal(t.releaseTaskBudget('T1', 1), null);
  assert.equal(t.taskBudget('T1'), null, '戻しただけで門番が付いている');

  t.grantTaskBudget('T1', 2);
  assert.equal(t.releaseTaskBudget('T1', 1), 1);
  assert.equal(t.taskBudget('T1'), 1);

  // 他の job が先に使っていても負の残高にはしない
  assert.equal(t.releaseTaskBudget('T1', 5), 0);
  assert.equal(t.taskBudget('T1'), 0, '門番そのものは外さない');

  for (const jobs of [-1, 1.5, '3', null, undefined, NaN]) {
    assert.throws(() => t.releaseTaskBudget('T1', jobs), /job 予算/, JSON.stringify(jobs));
  }
});

test('予算の分だけ bot 起点が通り、切れたら上限到達と同じ様式で止まる', () => {
  const t = new HopTracker(12);
  t.grantTaskBudget('T1', 2);
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 1, warn: false });
  assert.equal(t.taskBudget('T1'), 1);
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 2, warn: false });
  assert.equal(t.taskBudget('T1'), 0);

  // 予算切れ。形は hop 上限到達と同じで、通知は 1 スレッドにつき 1 回だけ
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 2, warn: true });
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 2, warn: false });
  assert.equal(t.hops('T1'), 2, '拒否したターンで hop が進んでいる');
});

test('hop 上限で止まるターンは予算を減らさない (二重に取り上げない)', () => {
  const t = new HopTracker(1);
  t.grantTaskBudget('T1', 5);
  assert.equal(t.take('T1').allowed, true);
  assert.equal(t.taskBudget('T1'), 4);
  assert.equal(t.take('T1').allowed, false, 'hop 上限で止まっていない');
  assert.equal(t.taskBudget('T1'), 4, 'hop 上限で止まったターンが予算を食っている');
});

test('自己呼び出し 1 回で減る予算は 1 (takeSelf は見るだけ・消費点は take)', () => {
  const t = new HopTracker(12, 12);
  t.grantTaskBudget('T1', 3);
  // index.js は自己呼び出しでも takeSelf → take と両方を通す
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: true, hops: 1, warn: false });
  assert.equal(t.taskBudget('T1'), 3, 'takeSelf が予算を減らしている');
  assert.equal(t.take('T1').allowed, true);
  assert.equal(t.taskBudget('T1'), 2, '自己呼び出し 1 回で 2 消費している');
});

test('予算切れは自己呼び出しも止め、連鎖を進めない', () => {
  const t = new HopTracker(12, 12);
  t.grantTaskBudget('T1', 0);
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: false, hops: 0, warn: true });
  assert.equal(t.selfHops('T1', 'opus'), 0, '拒否したのに自己連鎖が進んでいる');
  // 予算はスレッドに 1 本なので、通知も take/takeSelf をまたいで 1 回だけ
  assert.deepEqual(t.takeSelf('T1', 'opus'), { allowed: false, hops: 0, warn: false });
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 0, warn: false });
});

test('人間の発言は hop を戻すが予算は戻さない (無人スレッドで無限に湧かせない)', () => {
  const t = new HopTracker(12);
  t.grantTaskBudget('T1', 1);
  t.take('T1');
  assert.equal(t.take('T1').allowed, false);
  assert.equal(t.taskBudget('T1'), 0);

  t.reset('T1');
  assert.equal(t.hops('T1'), 0, 'counts が戻っていない');
  assert.equal(t.taskBudget('T1'), 0, '人間の発言で予算が戻っている');
  // 予算切れは人間が喋っても解けない。通知済みフラグだけは戻るのでもう一度だけ報せる
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 0, warn: true });
  assert.deepEqual(t.take('T1'), { allowed: false, hops: 0, warn: false });
});

test('予算は積み増しできる (詰まったタスクへ追い予算を出せる)', () => {
  const t = new HopTracker(12);
  assert.equal(t.grantTaskBudget('T1', 2), 2);
  assert.equal(t.grantTaskBudget('T1', 3), 5, '再付与が上書きになっている');
  assert.equal(t.taskBudget('T1'), 5);
  for (let i = 0; i < 5; i++) assert.equal(t.take('T1').allowed, true, `${i + 1} 回目`);
  assert.equal(t.take('T1').allowed, false);

  assert.equal(t.grantTaskBudget('T1', 1), 1, '使い切った後は残 0 からの積み増し');
  assert.deepEqual(t.take('T1'), { allowed: true, hops: 6, warn: false });
});

test('予算はスレッドごとに独立 (無人スレッドが人間のスレッドを巻き込まない)', () => {
  const t = new HopTracker(12);
  t.grantTaskBudget('T1', 1);
  assert.equal(t.take('T1').allowed, true);
  assert.equal(t.take('T1').allowed, false);
  assert.equal(t.take('T2').allowed, true, '別スレッドが巻き添えで止まっている');
  assert.equal(t.taskBudget('T2'), null);
});
