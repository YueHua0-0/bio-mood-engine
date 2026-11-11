/**
 * 05 §8 C01–C04 / C13：阶段判定、边界容差与交叉淡入。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE_VECTOR_KEYS,
  phaseAt,
  phaseDetail,
  phaseInfluence
} from '../../lib/modules/cycle/phase.mjs';

const L = 28.4;

function assertVectorShape(vector) {
  assert.deepEqual(Object.keys(vector).sort(), [...PHASE_VECTOR_KEYS].sort());
  for (const key of PHASE_VECTOR_KEYS) {
    assert.equal(Number.isFinite(vector[key]), true, `${key} must be finite`);
    assert.ok(vector[key] >= -0.15 && vector[key] <= 0.15, `${key} out of raw range`);
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
  // 跨周期回绕：p=1 截断为 luteal，p<0 钳制为 menstrual
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

test('阶段向量：阶段中心取 05 §5.3 冻结表数值', () => {
  assert.deepEqual(phaseInfluence(0.09, L), {
    physical_comfort: -0.1,
    energy: -0.06,
    sensitivity: 0.05,
    social_drive: -0.03
  });
  assert.deepEqual(phaseInfluence(0.31, L), {
    physical_comfort: 0.05,
    energy: 0.06,
    sensitivity: -0.02,
    social_drive: 0.05
  });
  assert.deepEqual(phaseInfluence(0.485, L), {
    physical_comfort: 0.03,
    energy: 0.04,
    sensitivity: 0.01,
    social_drive: 0.06
  });
  assert.deepEqual(phaseInfluence(0.76, L), {
    physical_comfort: -0.07,
    energy: -0.04,
    sensitivity: 0.07,
    social_drive: -0.02
  });
});

test('交叉淡入：0.18 边界为前后阶段各半的线性混合', () => {
  assert.deepEqual(phaseInfluence(0.18, L), {
    physical_comfort: -0.025,
    energy: 0,
    sensitivity: 0.015,
    social_drive: 0.01
  });
});

test('交叉淡入：0/1 回绕边界为 luteal 与 menstrual 各半', () => {
  assert.deepEqual(phaseInfluence(0, L), {
    physical_comfort: -0.085,
    energy: -0.05,
    sensitivity: 0.06,
    social_drive: -0.025
  });
  const nearWrap = phaseInfluence(1 - 1e-9, L);
  assertVectorShape(nearWrap);
  assert.equal(nearWrap.energy, -0.05);
});

test('交叉淡入窗口随周期长度缩放：窗口外严格取当前阶段向量', () => {
  // W = 0.5/28.4 ≈ 0.017606；0.18+0.02 已在窗口外
  assert.deepEqual(phaseInfluence(0.18 + 0.02, L), phaseInfluence(0.31, L));
  const tiny = phaseInfluence(0.18 + 0.001, L);
  assert.notDeepEqual(tiny, phaseInfluence(0.31, L));
  assertVectorShape(tiny);
});

test('C13：跨越 4 个边界逐日采样，相邻两天任一维差 ≤ 0.15', () => {
  let previous = null;
  let crossings = 0;
  let lastPhase = phaseAt(0);
  const days = Math.ceil(3 * L);
  for (let n = 0; n <= days; n += 1) {
    const p = n / L % 1;
    const vector = phaseInfluence(p, L);
    assertVectorShape(vector);
    if (previous) {
      for (const key of PHASE_VECTOR_KEYS) {
        assert.ok(
          Math.abs(vector[key] - previous[key]) <= 0.15 + 1e-9,
          `day ${n} ${key} delta too large`
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
