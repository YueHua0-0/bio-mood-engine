/**
 * 08 §8 测试：R01 / R07–R10 / R12–R14 / R16。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CYCLE_SCALARS, REGULATION_KEYS } from '../../lib/core/constants.mjs';
import {
  cycleScalars,
  isKnownCyclePhase
} from '../../lib/modules/regulation/cycle-map.mjs';
import {
  arousalTerms,
  calmRegulationTerms,
  comfortSignal,
  fatigueLoadTerms,
  rewardSensitivityTerms,
  socialReassuranceDriveTerms,
  targetArousal,
  targetCalmRegulation,
  targetFatigueLoad,
  targetFromTerms,
  targetRewardSensitivity,
  targetSocialReassuranceDrive,
  targetThreatSensitivity,
  threatSensitivityTerms
} from '../../lib/modules/regulation/targets.mjs';
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

/** 固定种子的 LCG，避免测试自身使用 Math.random。 */
function makeRandom(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function expected(terms) {
  return targetFromTerms(terms);
}

test('R01 六个 target 纯函数各 30 组随机输入与 §5.3 公式一致且落在 [0,1]', () => {
  const random = makeRandom();
  const sample = () => ({
    cycle_reward: random(),
    cycle_energy: random(),
    cycle_sensitivity: random(),
    cycle_social: random(),
    sleep_debt: random(),
    sleep_quality: random(),
    sleepiness: random(),
    stress: random(),
    stability: random(),
    energy: random(),
    closeness_need: random(),
    comfort_signal: random(),
    previous_fatigue_load: random()
  });

  const cases = [
    [targetRewardSensitivity, rewardSensitivityTerms],
    [targetArousal, arousalTerms],
    [targetThreatSensitivity, threatSensitivityTerms],
    [targetCalmRegulation, calmRegulationTerms],
    [targetSocialReassuranceDrive, socialReassuranceDriveTerms],
    [targetFatigueLoad, fatigueLoadTerms]
  ];

  for (const [targetFn, termsFn] of cases) {
    for (let i = 0; i < 30; i += 1) {
      const x = sample();
      const actual = targetFn(x);
      const formula = expected(termsFn(x));
      assert.ok(Number.isFinite(actual), 'target 必须是有限值');
      assert.ok(actual >= 0 && actual <= 1, `target 越界: ${actual}`);
      assert.ok(Math.abs(actual - formula) <= 1e-12, `${targetFn.name} 与公式不一致`);
      assert.equal(targetFn(x), targetFn(x), '纯函数必须逐位稳定');
    }
  }
});

test('R07 cycleScalars 与常数表深度相等；阶段缺失/非法回 0.50 且不抛错', () => {
  for (const phase of Object.keys(CYCLE_SCALARS)) {
    assert.equal(isKnownCyclePhase(phase), true);
    assert.deepEqual(cycleScalars(phase), CYCLE_SCALARS[phase]);
  }

  for (const phase of [undefined, null, '', 'unknown_like', 42]) {
    assert.equal(isKnownCyclePhase(phase), false);
    assert.deepEqual(cycleScalars(phase), {
      cycle_reward: 0.5,
      cycle_energy: 0.5,
      cycle_sensitivity: 0.5,
      cycle_social: 0.5
    });
  }

  const result = run(baseInputs({ cycle: { phase: 'unknown_like' } }));
  assert.ok(result.warnings.includes('MISSING_CYCLE_DATA'));
  assert.ok(result.reason_codes.includes('cycle_data_missing'));
});

test('R08 缺 sleep_debt 用 0.15 并追加 MISSING_SLEEP_DATA', () => {
  const degraded = run(baseInputs({ sleep: { sleep_quality: 0.7, sleepiness: 0.3 } }));
  const explicit = run(baseInputs({ sleep: { sleep_debt: 0.15, sleep_quality: 0.7, sleepiness: 0.3 } }));

  assert.ok(degraded.warnings.includes('MISSING_SLEEP_DATA'));
  assert.deepEqual(degraded.state, explicit.state);
  assert.deepEqual(degraded.contributions, explicit.contributions);
});

test('R09 缺上一 tick 情绪三量用 0.60/0.65/0.45 并追加 MISSING_MOOD_DATA', () => {
  const degraded = run(baseInputs({ mood: {} }));
  const explicit = run(baseInputs({ mood: { energy: 0.6, stability: 0.65, closeness_need: 0.45 } }));

  assert.ok(degraded.warnings.includes('MISSING_MOOD_DATA'));
  assert.deepEqual(degraded.state, explicit.state);
  assert.deepEqual(degraded.contributions, explicit.contributions);
});

test('previous 缺六维时用 0.5 初始化并追加 MISSING_REGULATION_DATA / DEGRADED', () => {
  const result = run(baseInputs(), {});
  assert.ok(result.warnings.includes('MISSING_REGULATION_DATA'));
  assert.ok(result.warnings.includes('DEGRADED'));
  for (const key of REGULATION_KEYS) {
    assert.ok(result.state[key] >= 0 && result.state[key] <= 1);
  }
});

test('R10 同输入同 now 两次输出深度相等', () => {
  const inputs = baseInputs({
    stress: { level: 0.4, active_events: [{ event_id: 'evt_20261109_0001', remaining: -0.02 }] }
  });
  const first = run(inputs);
  const second = run(inputs);
  assert.deepEqual(second, first);
});

test('R12 active_events 含负强度时 comfort_signal > 0，reward_sensitivity 更高', () => {
  const negative = [{ event_id: 'evt_20261109_neg1', remaining: -0.08 }];
  const positive = [{ event_id: 'evt_20261109_pos1', remaining: 0.08 }];

  assert.ok(comfortSignal(negative) > 0);
  assert.equal(comfortSignal(positive), 0);

  // dt=600 使 target 差值不被 0.05 单步上限吞掉
  const withComfort = run(baseInputs({ stress: { level: 0.2, active_events: negative }, dt: 600 }));
  const withoutComfort = run(baseInputs({ stress: { level: 0.2, active_events: positive }, dt: 600 }));

  assert.ok(withComfort.state.reward_sensitivity > withoutComfort.state.reward_sensitivity);
  assert.ok(withComfort.reason_codes.includes('comfort_received'));
});

test('R13 全正向事件 / 空事件时 comfort_signal = 0', () => {
  assert.equal(comfortSignal([]), 0);
  assert.equal(comfortSignal(null), 0);
  assert.equal(comfortSignal([{ remaining: 0.05 }, { remaining: 0.1 }]), 0);
  assert.equal(comfortSignal([{ remaining: 0 }]), 0);
});

test('R14 返回对象只含 regulation.*，不写其他模块', () => {
  const result = run();
  assert.deepEqual(
    Object.keys(result.state).sort(),
    [...REGULATION_KEYS, 'model_version'].sort()
  );
  assert.equal(Object.keys(result.contributions).length, REGULATION_KEYS.length);
  for (const key of Object.keys(result.contributions)) {
    assert.match(key, /^regulation\./);
    assert.deepEqual(
      Object.keys(result.contributions[key]).sort(),
      ['base', 'clamp', 'comfort', 'cycle', 'inertia', 'mood_lag', 'sleep', 'stress'].sort()
    );
  }
  assert.equal('mood' in result.state, false);
  assert.equal('cycle' in result.state, false);
  assert.equal('sleep' in result.state, false);
  assert.equal('stress' in result.state, false);
});

test('R16 model_version 恒为 1，六维 round6 后无 -0', () => {
  const result = run(baseInputs({ stress: { level: 0.5, active_events: [] } }));
  assert.equal(result.state.model_version, 1);
  for (const key of REGULATION_KEYS) {
    const value = result.state[key];
    assert.equal(Object.is(value, -0), false, `${key} 不得为 -0`);
    assert.equal(value, Math.round(value * 1e6) / 1e6, `${key} 必须 round6`);
  }
});
