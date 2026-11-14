/**
 * M-C15：九维周期向量的逐小时变化上限（仅适用于 1 小时 tick）。
 *
 * 理论来源（05 §5.3 / 05 §5.4）：
 *   - 九维阶段中心表中 pain_load 的最大相邻阶段差为 0.60 − 0.05 = 0.55；
 *   - profile 倍率上限为 1.5；
 *   - 阶段切换的 crossfade 窗口为边界两侧各半日，全程 24 小时线性过渡。
 * 因此逐小时变化上界 = 0.55 × 1.5 ÷ 24 = 0.034375，须满足 ≤ 0.04。
 *
 * oracle 独立性：下面的理论常数与阶段边界均由文档数值独立写出，
 * 不读取生产矩阵、生产常量或生产函数返回值来生成期望值；
 * 生产实现只作为被测对象。
 *
 * 本门禁不适用于非 1 小时 tick：步长变大时单步变化必然放大，
 * 该限制在最后一个用例中以负向对照显式证明。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { phaseInfluence } from '../../lib/modules/cycle/phase.mjs';

/** 文档值：pain_load 相邻阶段最大差（menstrual 0.60 → follicular 0.05）。 */
const MAX_ADJACENT_GAP = 0.55;
/** 文档值：四档 profile 倍率上限。 */
const MAX_PROFILE = 1.5;
/** 文档值：crossfade 全程 24 小时（边界两侧各半日）。 */
const TRANSITION_HOURS = 24;
/** 门禁上限。 */
const RATE_CAP = 0.04;
/** 独立计算的理论上界。 */
const THEORETICAL_RATE = (MAX_ADJACENT_GAP * MAX_PROFILE) / TRANSITION_HOURS;

/** 文档值：阶段进度边界（05 §5.3）。用于判定 crossfade 窗口位置。 */
const PHASE_BOUNDARIES = [0.18, 0.44, 0.53, 1.0];
const DIMS = [
  'physical_comfort',
  'energy',
  'pain_load',
  'sensitivity',
  'social_drive',
  'anxiety_delta',
  'irritability_delta',
  'positive_affect_delta',
  'intimacy_need_delta'
];

function profileOf(multiplier) {
  return {
    pain_sensitivity: multiplier,
    luteal_sensitivity: multiplier,
    mood_variability: multiplier,
    intimacy_variability: multiplier
  };
}

function scanHourly({ cycleLengthDays, multiplier }) {
  const totalHours = Math.round(cycleLengthDays * 24);
  let worst = { delta: 0, dim: null, hour: null };
  const samples = [];
  for (let hour = 0; hour < totalHours; hour += 1) {
    const current = phaseInfluence(hour / totalHours, cycleLengthDays, profileOf(multiplier));
    const next = phaseInfluence((hour + 1) / totalHours, cycleLengthDays, profileOf(multiplier));
    let stepMax = 0;
    for (const dim of DIMS) {
      const delta = Math.abs(next[dim] - current[dim]);
      if (delta > stepMax) stepMax = delta;
      if (delta > worst.delta) worst = { delta, dim, hour };
    }
    samples.push({ hour, progress: hour / totalHours, stepMax, current, next });
  }
  return { worst, samples, totalHours };
}

/** 与测试同源的断言入口，供负向对照验证「该断言确实会失败」。 */
function assertRateWithinCap(worst) {
  assert.ok(
    worst.delta <= RATE_CAP + 1e-9,
    `逐小时变化超限：dim=${worst.dim} hour=${worst.hour} delta=${worst.delta} > ${RATE_CAP}`
  );
}

test('M-C15：四档 profile 在 1 小时 tick 下逐维变化 ≤ 0.04', () => {
  for (const multiplier of [0, 0.75, 1.0, 1.5]) {
    const { worst } = scanHourly({ cycleLengthDays: 28.4, multiplier });
    assertRateWithinCap(worst);
    assert.ok(
      worst.delta <= THEORETICAL_RATE + 1e-6,
      `profile=${multiplier} 实测 ${worst.delta} 超过理论值 ${THEORETICAL_RATE}`
    );
  }
});

test('M-C15：最大档 profile 必须逼近理论上界（防止断言恒真）', () => {
  const { worst } = scanHourly({ cycleLengthDays: 28.4, multiplier: MAX_PROFILE });
  assert.equal(worst.dim, 'pain_load', '最大变化维度应为 pain_load');
  assert.ok(
    worst.delta >= THEORETICAL_RATE - 0.002,
    `最大档实测 ${worst.delta} 明显低于理论上界 ${THEORETICAL_RATE}，测度可能失效`
  );
});

test('M-C15：上界与周期长度无关（21 / 28.4 / 35 天同值）', () => {
  const rates = [21, 28.4, 35].map((cycleLengthDays) => scanHourly({ cycleLengthDays, multiplier: MAX_PROFILE }).worst.delta);
  for (const rate of rates) {
    // 28.4 天折算为 681.6 小时，整点采样会带来 <1e-3 的离散误差，上界本身不随周期长度变化。
    assert.ok(
      Math.abs(rate - THEORETICAL_RATE) < 1e-3,
      `周期长度变体偏离理论上界：${rates.join(' / ')}（理论 ${THEORETICAL_RATE}）`
    );
    assert.ok(rate <= RATE_CAP + 1e-9, `周期长度变体超限：${rate}`);
  }
});

test('M-C15：阶段边界与周期环绕只在 crossfade 窗口内产生变化', () => {
  const { samples, totalHours } = scanHourly({ cycleLengthDays: 28.4, multiplier: MAX_PROFILE });
  const halfWindow = 0.5 / 28.4;
  const circularDistance = (a, b) => Math.min(Math.abs(a - b), Math.abs(a - b - 1), Math.abs(a - b + 1));
  const nearBoundary = (progress) =>
    PHASE_BOUNDARIES.some((boundary) => circularDistance(progress, boundary) <= halfWindow + 1e-9);

  let wrapChecked = false;
  for (const sample of samples) {
    // 任一端点落入过渡窗口，该小时就会产生混合变化。
    if (nearBoundary(sample.progress) || nearBoundary((sample.hour + 1) / totalHours)) {
      assert.ok(sample.stepMax <= RATE_CAP + 1e-9, `边界附近 hour=${sample.hour} 超限：${sample.stepMax}`);
    } else {
      assert.equal(sample.stepMax, 0, `crossfade 窗口外 hour=${sample.hour} 出现非零变化：${sample.stepMax}`);
    }
    if (sample.hour === totalHours - 1) {
      assert.ok(sample.stepMax <= RATE_CAP + 1e-9, `周期环绕（p→0）单步变化超限：${sample.stepMax}`);
      wrapChecked = true;
    }
  }
  assert.ok(wrapChecked, '未覆盖周期环绕采样点');
});

test('M-C15 负向对照：24 小时步长必然超限，证明门禁只适用于 1 小时 tick', () => {
  const daily = { delta: 0, dim: null, hour: null };
  for (let day = 0; day < 28; day += 1) {
    const current = phaseInfluence(day / 28, 28.4, profileOf(MAX_PROFILE));
    const next = phaseInfluence((day + 1) / 28, 28.4, profileOf(MAX_PROFILE));
    for (const dim of DIMS) {
      const delta = Math.abs(next[dim] - current[dim]);
      if (delta > daily.delta) Object.assign(daily, { delta, dim, hour: day });
    }
  }
  assert.ok(daily.delta > RATE_CAP, `24h 步长应表现为超限，实际 ${daily.delta}`);
  assert.equal(daily.dim, 'pain_load');
  // 同一断言入口必须对超限样本报错，证明断言不是恒真。
  assert.throws(() => assertRateWithinCap(daily), /超限/);
});

test('M-C15 负向对照：仿造越界序列必须触发断言失败', () => {
  const forged = { delta: 0.045, dim: 'pain_load', hour: 42 };
  assert.throws(() => assertRateWithinCap(forged), /delta=0\.045/);
  assert.doesNotThrow(() => assertRateWithinCap({ delta: 0.034356, dim: 'pain_load', hour: 57 }));
});
