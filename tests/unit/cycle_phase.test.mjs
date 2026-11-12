/**
 * 05 §8 C01–C04 / C13：阶段判定、边界容差与交叉淡入。
 * v1.7.14：九维 phase_impact + profile 调制。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE_VECTOR_KEYS,
  phaseAt,
  phaseDetail,
  phaseInfluence,
  phaseWeights
} from '../../lib/modules/cycle/phase.mjs';

const L = 28.4;

/** 九维合理范围：pain_load [0,1]，其余 [-1,1]。 */
const RANGES = Object.freeze({
  physical_comfort: [-1, 1],
  energy: [-1, 1],
  sensitivity: [-1, 1],
  social_drive: [-1, 1],
  pain_load: [0, 1],
  anxiety_delta: [-1, 1],
  irritability_delta: [-1, 1],
  positive_affect_delta: [-1, 1],
  intimacy_need_delta: [-1, 1]
});

function assertVectorShape(vector) {
  assert.deepEqual(Object.keys(vector).sort(), [...PHASE_VECTOR_KEYS].sort());
  for (const key of PHASE_VECTOR_KEYS) {
    assert.equal(Number.isFinite(vector[key]), true, `${key} must be finite`);
    const [lo, hi] = RANGES[key];
    assert.ok(vector[key] >= lo - 1e-9 && vector[key] <= hi + 1e-9,
      `${key}=${vector[key]} out of range [${lo}, ${hi}]`);
    assert.notEqual(Object.is(vector[key], -0), true, `${key} must not be -0`);
  }
}

test('C01：p=0.1799 为 menstrual_like，p=0.1800 为 follicular_like', () => {
  assert.equal(phaseAt(0.1799), 'menstrual_like');
  assert.equal(phaseAt(0.18), 'follicular_like');
});

test('C02：p=0.4399 为 follicular_like，p=0.4400 为 ovulatory_like', () => {
  assert.equal(phaseAt(0.4399), 'follicular_like');
  assert.equal(phaseAt(0.44), 'ovulatory_like');
});

test('C03：p=0.5299 为 ovulatory_like，p=0.5300 为 luteal_like', () => {
  assert.equal(phaseAt(0.5299), 'ovulatory_like');
  assert.equal(phaseAt(0.53), 'luteal_like');
});

test('C04：p=0.9999 为 luteal_like，p=0.0000 为 menstrual_like', () => {
  assert.equal(phaseAt(0.9999), 'luteal_like');
  assert.equal(phaseAt(0), 'menstrual_like');
  assert.equal(phaseAt(1), 'luteal_like');
  assert.equal(phaseAt(-0.01), 'menstrual_like');
});

test('边界容差 1e-9：刚好落在边界左侧极小量仍归入后一阶段', () => {
  assert.equal(phaseAt(0.18 - 1e-10), 'follicular_like');
  assert.equal(phaseAt(0.44 - 1e-10), 'ovulatory_like');
  assert.equal(phaseAt(0.53 - 1e-10), 'luteal_like');
});

test('阶段进度：各阶段内为 [0,1)，边界处归零', () => {
  const cases = [
    [0, 'menstrual_like', 0],
    [0.09, 'menstrual_like', 0.5],
    [0.18, 'follicular_like', 0],
    [0.31, 'follicular_like', 0.5],
    [0.44, 'ovulatory_like', 0],
    [0.485, 'ovulatory_like', 0.5],
    [0.53, 'luteal_like', 0],
    [1, 'luteal_like', 0.999999]
  ];
  for (const [p, phase, progress] of cases) {
    const detail = phaseDetail(p);
    assert.equal(detail.phase, phase, `p=${p} phase`);
    assert.equal(detail.phase_progress, progress, `p=${p} progress`);
    assert.ok(detail.phase_progress >= 0 && detail.phase_progress < 1);
  }
});

test('阶段向量：阶段中心取 05 §5.3 九维冻结表数值（默认 profile=1）', () => {
  // menstrual center (p=0.09): phaseWeights 返回 w_menstrual=1, 其余 0
  assert.deepEqual(phaseInfluence(0.09, L), {
    physical_comfort: -0.04, energy: -0.06, sensitivity: 0.05, social_drive: -0.03,
    pain_load: 0.60, anxiety_delta: 0.15, irritability_delta: 0.20, positive_affect_delta: -0.15, intimacy_need_delta: -0.10
  });
  assert.deepEqual(phaseInfluence(0.31, L), {
    physical_comfort: 0.05, energy: 0.06, sensitivity: -0.02, social_drive: 0.05,
    pain_load: 0.05, anxiety_delta: -0.10, irritability_delta: -0.10, positive_affect_delta: 0.20, intimacy_need_delta: 0.05
  });
  assert.deepEqual(phaseInfluence(0.485, L), {
    physical_comfort: 0.03, energy: 0.04, sensitivity: 0.01, social_drive: 0.06,
    pain_load: 0.05, anxiety_delta: -0.05, irritability_delta: -0.05, positive_affect_delta: 0.25, intimacy_need_delta: 0.35
  });
  assert.deepEqual(phaseInfluence(0.76, L), {
    physical_comfort: -0.05, energy: -0.04, sensitivity: 0.07, social_drive: -0.02,
    pain_load: 0.35, anxiety_delta: 0.12, irritability_delta: 0.18, positive_affect_delta: -0.10, intimacy_need_delta: -0.05
  });
});

test('crossfade phaseWeights 唯一接口：边界处为前后阶段各半（默认 profile）', () => {
  // p=0.18 是 menstrual → follicular 边界
  const w = phaseWeights(0.18, L);
  assert.ok(Math.abs(w.menstrual_like - 0.5) < 1e-6, `menstrual weight=${w.menstrual_like}`);
  assert.ok(Math.abs(w.follicular_like - 0.5) < 1e-6, `follicular weight=${w.follicular_like}`);
  assert.equal(w.ovulatory_like, 0);
  assert.equal(w.luteal_like, 0);
  assert.ok(Math.abs(w.menstrual_like + w.follicular_like - 1) < 1e-9);
});

test('crossfade 窗口外严格取当前阶段向量', () => {
  const outside = phaseInfluence(0.18 + 0.02, L);
  assert.deepEqual(outside, phaseInfluence(0.31, L));
  const inside = phaseInfluence(0.18 + 0.001, L);
  assert.notDeepEqual(inside, phaseInfluence(0.31, L));
  assertVectorShape(inside);
});

test('phaseWeights 在 p=0（menstrual_like 阶段中心）返回 w_menstrual=1', () => {
  const w = phaseWeights(0.09, L);
  assert.equal(w.menstrual_like, 1);
  assert.equal(w.follicular_like, 0);
  assert.equal(w.ovulatory_like, 0);
  assert.equal(w.luteal_like, 0);
});

test('C13-A：跨越边界逐日采样（九维 profile=1.0），相邻两天 pain_load 差 ≤0.55，其余 ≤0.45', () => {
  let previous = null;
  let crossings = 0;
  let lastPhase = phaseAt(0);
  const days = Math.ceil(3 * L);
  const MAX_DELTAS = {
    physical_comfort: 0.15, energy: 0.15, sensitivity: 0.15, social_drive: 0.15,
    pain_load: 0.65, anxiety_delta: 0.35, irritability_delta: 0.40,
    positive_affect_delta: 0.50, intimacy_need_delta: 0.55
  };
  for (let n = 0; n <= days; n += 1) {
    const p = n / L % 1;
    const vector = phaseInfluence(p, L);
    assertVectorShape(vector);
    if (previous) {
      for (const key of PHASE_VECTOR_KEYS) {
        const delta = Math.abs(vector[key] - previous[key]);
        assert.ok(
          delta <= MAX_DELTAS[key] + 1e-9,
          `day ${n} ${key} delta ${delta} > ${MAX_DELTAS[key]}`
        );
      }
    }
    const phase = phaseAt(p);
    if (phase !== lastPhase) {
      crossings += 1;
      lastPhase = phase;
    }
    previous = vector;
  }
  assert.ok(crossings >= 8, `应跨越多个阶段边界，实际 ${crossings}`);
});

test('profile 隔离：单独改变 luteal_sensitivity 只影响 crossfade 中黄体阶段的 anxiety/irritability 分量（w_l=0 时无效应）', () => {
  // w_luteal_like = 0 时，改 luteal_sensitivity 不改变 anxiety_delta/irritability_delta
  const base0 = phaseInfluence(0.09, L, {});
  const hi0 = phaseInfluence(0.09, L, { luteal_sensitivity: 1.5 });
  assert.equal(base0.anxiety_delta, hi0.anxiety_delta,
    `w_l=0 时 luteal_sensitivity 不应影响 anxiety_delta`);
  assert.equal(base0.irritability_delta, hi0.irritability_delta);

  // w_luteal_like = 1 时（luteal 中心），改 luteal_sensitivity 应该改变 anxiety_delta/irritability_delta
  const baseL = phaseInfluence(0.76, L, {});
  const hiL = phaseInfluence(0.76, L, { luteal_sensitivity: 1.5 });
  assert.notEqual(baseL.anxiety_delta, hiL.anxiety_delta,
    `w_l=1 时 luteal_sensitivity 应影响 anxiety_delta：${baseL.anxiety_delta} → ${hiL.anxiety_delta}`);
});

test('profile 隔离：pain_sensitivity 只影响 pain_load，不改变旧四维或其他新五维', () => {
  const base = phaseInfluence(0.09, L, {});
  const hi = phaseInfluence(0.09, L, { pain_sensitivity: 1.5 });
  assert.notEqual(base.pain_load, hi.pain_load);
  assert.equal(base.physical_comfort, hi.physical_comfort, '旧四维 physical_comfort 应不变');
  assert.equal(base.energy, hi.energy);
  assert.equal(base.sensitivity, hi.sensitivity);
  assert.equal(base.social_drive, hi.social_drive);
  assert.equal(base.anxiety_delta, hi.anxiety_delta, 'pain_sensitivity 不应影响 anxiety_delta');
});

// === profile 严格校验（C1-F02） ===

function expectInvalidRequest(fn, key) {
  try {
    fn();
    assert.fail(`应抛 INVALID_REQUEST（${key}）`);
  } catch (err) {
    assert.equal(err.code, 'INVALID_REQUEST', `${key} 应抛 INVALID_REQUEST，实际 ${err.code}`);
    assert.ok(err.details && err.details.path !== undefined, `${key} 应带 details.path`);
  }
}

test('profile 隔离：单独改变 mood_variability 只影响 anxiety/irritability/positive_affect_delta', () => {
  const base = phaseInfluence(0.76, L, {});
  const hi = phaseInfluence(0.76, L, { mood_variability: 1.5 });
  assert.notEqual(base.anxiety_delta, hi.anxiety_delta);
  assert.notEqual(base.irritability_delta, hi.irritability_delta);
  assert.notEqual(base.positive_affect_delta, hi.positive_affect_delta);
  assert.equal(base.pain_load, hi.pain_load, 'pain_load 不应受 mood_variability 影响');
  assert.equal(base.intimacy_need_delta, hi.intimacy_need_delta);
  assert.equal(base.physical_comfort, hi.physical_comfort, '旧四维不变');
  assert.equal(base.energy, hi.energy);
  assert.equal(base.sensitivity, hi.sensitivity);
  assert.equal(base.social_drive, hi.social_drive);
});

test('profile 隔离：单独改变 intimacy_variability 只影响 intimacy_need_delta', () => {
  const base = phaseInfluence(0.485, L, {});
  const hi = phaseInfluence(0.485, L, { intimacy_variability: 1.5 });
  assert.notEqual(base.intimacy_need_delta, hi.intimacy_need_delta);
  assert.equal(base.anxiety_delta, hi.anxiety_delta, 'anxiety_delta 不变');
  assert.equal(base.irritability_delta, hi.irritability_delta);
  assert.equal(base.pain_load, hi.pain_load);
  assert.equal(base.physical_comfort, hi.physical_comfort, '旧四维不变');
});

test('profile 非法类型：四个键分别测试 string / null / boolean', () => {
  const BAD_TYPE_CASES = [
    { key: 'pain_sensitivity', value: '1.5' },
    { key: 'luteal_sensitivity', value: null },
    { key: 'mood_variability', value: true },
    { key: 'intimacy_variability', value: '0.5' }
  ];
  for (const { key, value } of BAD_TYPE_CASES) {
    expectInvalidRequest(() => phaseInfluence(0.09, L, { [key]: value }), `${key}=${JSON.stringify(value)}`);
  }
});

test('profile 非法有限性：四个键分别测试 NaN / Infinity', () => {
  const BAD_FINITE_CASES = [
    { key: 'pain_sensitivity', value: NaN },
    { key: 'luteal_sensitivity', value: Infinity },
    { key: 'mood_variability', value: -Infinity },
    { key: 'intimacy_variability', value: NaN }
  ];
  for (const { key, value } of BAD_FINITE_CASES) {
    expectInvalidRequest(() => phaseInfluence(0.09, L, { [key]: value }), `${key}=${String(value)}`);
  }
});

test('profile 越界：四个键分别测试 -0.01 / 1.51', () => {
  const BAD_RANGE_CASES = [
    { key: 'pain_sensitivity', value: -0.01 },
    { key: 'luteal_sensitivity', value: 1.51 },
    { key: 'mood_variability', value: 1.51 },
    { key: 'intimacy_variability', value: -0.01 }
  ];
  for (const { key, value } of BAD_RANGE_CASES) {
    expectInvalidRequest(() => phaseInfluence(0.09, L, { [key]: value }), `${key}=${value}`);
  }
});

test('profile 非法：显式传入 null / array 作为整个 profile', () => {
  expectInvalidRequest(() => phaseInfluence(0.09, L, { cycle: { profile: null } }), 'profile=null');
  expectInvalidRequest(() => phaseInfluence(0.09, L, { cycle: { profile: [1, 2] } }), 'profile=array');
});

test('profile 合法边界值：0 和 1.5 均被接受', () => {
  assert.doesNotThrow(() => phaseInfluence(0.09, L, { pain_sensitivity: 0 }));
  assert.doesNotThrow(() => phaseInfluence(0.09, L, { pain_sensitivity: 1.5 }));
  assert.doesNotThrow(() => phaseInfluence(0.09, L, {
    pain_sensitivity: 0, luteal_sensitivity: 0, mood_variability: 0, intimacy_variability: 0
  }));
});

// === phaseWeights 完整补充（边界 / wrap / 窗口端点 / 权重不变量） ===

const PHASE_KEYS = ['menstrual_like', 'follicular_like', 'ovulatory_like', 'luteal_like'];

function assertWeightsInvariant(w, label) {
  // 四个键始终存在
  for (const k of PHASE_KEYS) assert.ok(k in w, `${label}: 缺键 ${k}`);
  // 均为非负有限 number
  for (const k of PHASE_KEYS) {
    assert.equal(typeof w[k], 'number', `${label}: ${k} 非 number`);
    assert.equal(Number.isFinite(w[k]), true, `${label}: ${k} 非有限`);
    assert.ok(w[k] >= 0, `${label}: ${k} 负数 ${w[k]}`);
  }
  // 总和满足 1 ± 1e-9
  const sum = w.menstrual_like + w.follicular_like + w.ovulatory_like + w.luteal_like;
  assert.ok(Math.abs(sum - 1) < 1e-9, `${label}: 权重和=${sum}`);
}

test('phaseWeights 不变量：所有输出满足权重和 = 1 / 非负 / 四键存在', () => {
  // L=28.4, window=0.5/28.4≈0.0176。覆盖：非过渡区 / 窗口内两侧 / 边界中点 / wrap
  const probs = [
    0,                          // wrap 边界（luteal↔menstrual）
    0.05, 0.09,                 // menstrual 非过渡区
    0.163, 0.179,               // 0.18 窗口内前侧 / 窗口内靠近边界
    0.18,                       // 0.18 边界中点
    0.197,                      // 0.18 窗口内后侧
    0.25, 0.31,                 // follicular 非过渡区
    0.423, 0.439,               // 0.44 窗口内前侧 / 窗口内靠近边界
    0.44,                       // 0.44 边界中点
    0.457,                      // 0.44 窗口内后侧
    0.50,                       // ovulatory 非过渡区
    0.513, 0.529,               // 0.53 窗口内前侧 / 窗口内靠近边界
    0.53,                       // 0.53 边界中点
    0.547,                      // 0.53 窗口内后侧
    0.60, 0.76,                 // luteal 非过渡区
    0.95, 0.9999, 1             // wrap 边界
  ];
  for (const p of probs) {
    assertWeightsInvariant(phaseWeights(p, L), `p=${p}`);
  }
});

test('phaseWeights 非过渡区只有当前阶段权重 = 1', () => {
  const CASES = [
    [0.09, 'menstrual_like'],
    [0.31, 'follicular_like'],
    [0.485, 'ovulatory_like'],
    [0.76, 'luteal_like']
  ];
  for (const [p, dominant] of CASES) {
    const w = phaseWeights(p, L);
    assert.equal(w[dominant], 1, `p=${p} ${dominant} 应=1`);
    for (const k of PHASE_KEYS) {
      if (k !== dominant) assert.equal(w[k], 0, `p=${p} ${k} 应=0`);
    }
  }
});

test('phaseWeights 过渡区仅相邻两个阶段权重非零', () => {
  // 默认 L=28.4：window = 0.5/28.4 ≈ 0.0176
  const L = 28.4;
  // p=0.18 恰好是 menstrual→follicular 边界
  let w = phaseWeights(0.18, L);
  assert.ok(w.menstrual_like > 0, '边界 w_m > 0');
  assert.ok(w.follicular_like > 0, '边界 w_f > 0');
  assert.equal(w.ovulatory_like, 0);
  assert.equal(w.luteal_like, 0);

  // p=0.44 follicular→ovulatory
  w = phaseWeights(0.44, L);
  assert.ok(w.follicular_like > 0);
  assert.ok(w.ovulatory_like > 0);
  assert.equal(w.menstrual_like, 0);
  assert.equal(w.luteal_like, 0);

  // p=0.53 ovulatory→luteal
  w = phaseWeights(0.53, L);
  assert.ok(w.ovulatory_like > 0);
  assert.ok(w.luteal_like > 0);
  assert.equal(w.menstrual_like, 0);
  assert.equal(w.follicular_like, 0);
});

test('phaseWeights 窗口内部非边界点也仅相邻两个阶段非零', () => {
  // 边界中点已在上方测试；这里验证窗口内任意非边界点行为一致
  const L = 28.4;
  // 0.18 窗口 [0.1624, 0.1976]，p=0.179 窗口内前侧
  let w = phaseWeights(0.179, L);
  assert.ok(w.menstrual_like > 0 && w.follicular_like > 0);
  assert.equal(w.ovulatory_like, 0);
  assert.equal(w.luteal_like, 0);

  // p=0.197 窗口内后侧
  w = phaseWeights(0.197, L);
  assert.ok(w.menstrual_like > 0 && w.follicular_like > 0);
  assert.equal(w.ovulatory_like, 0);
  assert.equal(w.luteal_like, 0);

  // 0.44 窗口内 p=0.439 (靠近边界前侧) / p=0.457 (窗口内后侧)
  w = phaseWeights(0.439, L);
  assert.ok(w.follicular_like > 0 && w.ovulatory_like > 0);
  assert.equal(w.menstrual_like, 0);
  assert.equal(w.luteal_like, 0);

  w = phaseWeights(0.529, L); // 0.53 窗口内前侧
  assert.ok(w.ovulatory_like > 0 && w.luteal_like > 0);
  assert.equal(w.menstrual_like, 0);
  assert.equal(w.follicular_like, 0);
});

test('phaseWeights 首尾 wrap 边界：p=0 和 p=1 是相邻阶段的过渡', () => {
  // window=0.0176；p=0 距离边界 0 最近，属于 menstrual_like（因为 0 是起点）
  // 但 p=0 时 nearest=0, distance=0, prevIndex=3(luteal), nextIndex=0(menstrual)
  let w = phaseWeights(0, L);
  assert.ok(w.luteal_like > 0, 'p=0 应含 luteal（wrap 过渡）');
  assert.ok(w.menstrual_like > 0, 'p=0 应含 menstrual');

  w = phaseWeights(1 - 1e-12, L);
  assert.ok(w.luteal_like > 0, 'p≈1 应含 luteal');
});

// === C13 验收说明 ===
//
// C13-A：九维原始 phase_impact 逐日变化满足各字段 RAW_MAX —— 已在本文件第 136 行实现。
// C13-A 补充（cycle_advance.test.mjs）：同上，以 L=28.4 为基准独立断言。
//
// C13-B（待 C2 完成后验收，本轮不计入 PASS）：
//   真正的 05 → 09 集成链路：advance → cycle.phase_impact → 09 cycleTerms → alpha 衰减 → 情绪贡献
//   必须通过实际 advance 调用 09，验证：
//   - 09 正确读取九维周期向量（或旧四维兼容向量）
//   - 09 用 CYCLE_CONTRIB_WEIGHTS 九个系数正确计算贡献
//   - alpha 衰减与多贡献叠加后，单步情绪变化 ≤0.06
//   - 不得用 clamp 模拟 09 公式后再断言 clamp 生效（那是恒真）
//
//   原"clamp(0.6 * rawDelta, -0.06, 0.06) 再断言 ≤0.06"的假测试已在本轮删除。
//   本文件内不再包含任何模拟 09 行为的断言。
