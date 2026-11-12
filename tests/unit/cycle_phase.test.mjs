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

test('C13：跨越边界逐日采样（九维 profile=1.0），相邻两天 pain_load 差 ≤0.55，其余 ≤0.45', () => {
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
