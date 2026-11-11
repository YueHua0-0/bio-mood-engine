/**
 * 08 §8 测试：R02–R06 / R11 / R15。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { REGULATION_KEYS } from '../../lib/core/constants.mjs';
import {
  MAX_STEP_DELTA,
  blendFor,
  stepInertia
} from '../../lib/modules/regulation/inertia.mjs';
import { updateRegulation } from '../../lib/modules/regulation/index.mjs';

const PREVIOUS = Object.freeze({
  reward_sensitivity: 0.5,
  arousal: 0.5,
  threat_sensitivity: 0.5,
  calm_regulation: 0.5,
  social_reassurance_drive: 0.5,
  fatigue_load: 0.5,
  model_version: 1
});

function baseInputs(overrides = {}) {
  return {
    cycle: { phase: 'follicular_like' },
    sleep: { sleep_debt: 0.25, sleep_quality: 0.7, sleepiness: 0.3 },
    stress: { level: 0.2, active_events: [] },
    mood: { energy: 0.6, stability: 0.65, closeness_need: 0.45 },
    dt: 3600,
    ...overrides
  };
}

function run(inputs = baseInputs(), previous = PREVIOUS) {
  return updateRegulation({
    previous,
    inputs,
    now: '2026-11-09T09:00:00.000Z',
    rng: null,
    config: {}
  });
}

test('R02 dt=2700 单步走完差距 50%', () => {
  assert.equal(blendFor(2700), 0.5);
  // 差距 0.06，50% = 0.03，低于单步 0.05 上限
  const result = stepInertia({ previous: 0.2, target: 0.26, dtSeconds: 2700 });
  assert.ok(Math.abs(result.next - 0.23) <= 1e-6, `next=${result.next}`);
});

test('R02b dt=60 只走差距的 ≈1.5%（P1：不得按 3600 兜底）', () => {
  const blend = blendFor(60);
  assert.ok(Math.abs(blend - (1 - 2 ** (-60 / 2700))) <= 1e-12);
  const result = stepInertia({ previous: 0.2, target: 0.26, dtSeconds: 60 });
  assert.ok(Math.abs(result.next - (0.2 + 0.06 * blend)) <= 1e-6, `next=${result.next}`);
  assert.equal(result.clamped, false);
});

test('R03 dt=5400 单步走完差距 75%', () => {
  assert.equal(blendFor(5400), 0.75);
  const result = stepInertia({ previous: 0.2, target: 0.26, dtSeconds: 5400 });
  assert.ok(Math.abs(result.next - 0.245) <= 1e-6, `next=${result.next}`);
});

test('R04 raw=0.20 裁剪到 0.05 并追加 CLAMPED_DELTA', () => {
  const result = stepInertia({ previous: 0.2, target: 0.4, dtSeconds: 100000 });
  assert.equal(result.clamped, true);
  assert.equal(result.delta, MAX_STEP_DELTA);
  assert.ok(Math.abs(result.next - 0.25) <= 1e-6);

  const moduleResult = run(baseInputs({ dt: 100000 }), {
    reward_sensitivity: 0.2,
    arousal: 0.2,
    threat_sensitivity: 0.2,
    calm_regulation: 0.2,
    social_reassurance_drive: 0.2,
    fatigue_load: 0.2,
    model_version: 1
  });
  assert.ok(moduleResult.warnings.includes('CLAMPED_DELTA'));
  assert.ok(moduleResult.reason_codes.includes('clamped_delta'));
  for (const key of REGULATION_KEYS) {
    assert.ok(moduleResult.state[key] <= 0.25 + 1e-9, `${key} 单步不得超过 0.05`);
  }
});

test('R05 连续 200 tick 单调逼近固定 target，最终 |next-target|<0.01', () => {
  const target = 0.85;
  let previous = 0.5;
  for (let i = 0; i < 200; i += 1) {
    const result = stepInertia({ previous, target, dtSeconds: 3600 });
    assert.ok(result.next >= previous - 1e-12, `第 ${i} 步非单调`);
    previous = result.next;
  }
  assert.ok(Math.abs(previous - target) < 0.01, `final=${previous}`);
});

test('R06 target=0 / target=1 分别饱和于 0 / 1，不越界、不 -0', () => {
  let low = 0.5;
  let high = 0.5;
  for (let i = 0; i < 200; i += 1) {
    low = stepInertia({ previous: low, target: 0, dtSeconds: 3600 }).next;
    high = stepInertia({ previous: high, target: 1, dtSeconds: 3600 }).next;
  }
  assert.equal(low, 0);
  assert.equal(high, 1);
  assert.equal(Object.is(low, -0), false);
  assert.equal(Object.is(high, -0), false);
  assert.ok(low >= 0 && high <= 1);

  const lowStep = stepInertia({ previous: 0.01, target: 0, dtSeconds: 100000 });
  assert.equal(lowStep.saturatedLow, true);
  assert.equal(lowStep.next, 0);
  const highStep = stepInertia({ previous: 0.99, target: 1, dtSeconds: 100000 });
  assert.equal(highStep.saturatedHigh, true);
  assert.equal(highStep.next, 1);
});

test('dt=0 只重算 target，next=prev 且贡献全 0', () => {
  const result = run(baseInputs({ dt: 0 }));
  for (const key of REGULATION_KEYS) {
    assert.equal(result.state[key], PREVIOUS[key]);
    for (const value of Object.values(result.contributions[`regulation.${key}`])) {
      assert.equal(value, 0);
      assert.equal(Object.is(value, -0), false);
    }
  }
});

test('inputs.dt 缺失或非法 → MODULE_FAILED（不兜底、不从 now 推算）', () => {
  assert.throws(
    () => run(baseInputs({ dt: undefined })),
    (err) => err.code === 'MODULE_FAILED' && err.details?.path === 'inputs.dt'
  );
  assert.throws(
    () => run(baseInputs({ dt: -60 })),
    (err) => err.code === 'MODULE_FAILED' && err.details?.path === 'inputs.dt'
  );
  assert.throws(
    () => run(baseInputs({ dt: 1.5 })),
    (err) => err.code === 'MODULE_FAILED' && err.details?.path === 'inputs.dt'
  );
});

test('R15 单维八来源贡献之和等于 next - previous（±1e-9）', () => {
  const result = run(baseInputs({
    stress: { level: 0.42, active_events: [{ event_id: 'evt_20261109_contrl', remaining: -0.03 }] }
  }));
  for (const key of REGULATION_KEYS) {
    const contributions = result.contributions[`regulation.${key}`];
    const sum = Object.values(contributions).reduce((acc, value) => acc + value, 0);
    const delta = result.state[key] - PREVIOUS[key];
    assert.ok(Math.abs(sum - delta) <= 1e-9, `${key}: sum=${sum} delta=${delta}`);
  }
});

test('R17 上游 stress 单步 +0.06：六维增量不超过 w_max × blend × Δ（P-08-01）', () => {
  const delta = 0.06;
  // threat_sensitivity 的 stress 权重 0.20 是六个目标公式中的最大者。
  const wMax = 0.2;
  const bound = wMax * blendFor(3600) * delta;

  const low = run(baseInputs({ stress: { level: 0.2, active_events: [] } }));
  const high = run(baseInputs({ stress: { level: 0.26, active_events: [] } }));

  for (const key of REGULATION_KEYS) {
    const step = Math.abs(high.state[key] - low.state[key]);
    // round6 会带来 ≤5e-7 的误差。
    assert.ok(step <= bound + 1e-5, `${key} 被上游放大: ${step} > ${bound}`);
  }

  // 09 §5.2 的 regulation 系数为 0.10（closeness_need 0.08），alpha[d] ≤ 1。
  assert.ok(0.1 * bound <= 7.3e-4, `09 的间接贡献上界失守: ${0.1 * bound}`);
});

test('R11 30 天逐小时仿真：不贴边、无持续振荡，7 日均值落在 [0.2,0.8]', () => {
  const phases = ['menstrual_like', 'follicular_like', 'ovulatory_like', 'luteal_like'];
  const history = Object.fromEntries(REGULATION_KEYS.map((key) => [key, []]));
  let previous = { ...PREVIOUS };

  for (let day = 0; day < 30; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const wave = Math.sin((day * 24 + hour) / 24);
      const inputs = baseInputs({
        cycle: { phase: phases[day % phases.length] },
        sleep: {
          sleep_debt: 0.3 + 0.08 * wave,
          sleep_quality: 0.78,
          sleepiness: 0.32 + 0.05 * wave
        },
        stress: {
          level: 0.28 + 0.06 * wave,
          active_events: hour % 12 === 0
            ? [{ event_id: 'evt_sim_00000001', remaining: -0.02 }]
            : []
        },
        mood: {
          energy: 0.6 + 0.05 * wave,
          stability: 0.66,
          closeness_need: 0.48
        },
        dt: 3600
      });
      const result = run(inputs, previous);
      previous = result.state;
      for (const key of REGULATION_KEYS) history[key].push(result.state[key]);
    }
  }

  for (const key of REGULATION_KEYS) {
    const values = history[key];
    assert.equal(values.length, 720);
    for (const value of values) {
      assert.ok(Number.isFinite(value), `${key} 出现非有限值`);
      assert.ok(value > 0.01 && value < 0.99, `${key} 贴边: ${value}`);
    }
    const last7Days = values.slice(-168);
    const mean = last7Days.reduce((acc, value) => acc + value, 0) / last7Days.length;
    assert.ok(mean >= 0.2 && mean <= 0.8, `${key} 7 日均值越界: ${mean}`);
    for (let i = 1; i < last7Days.length; i += 1) {
      assert.ok(Math.abs(last7Days[i] - last7Days[i - 1]) <= MAX_STEP_DELTA + 1e-9, `${key} 出现持续振荡`);
    }
  }
});
