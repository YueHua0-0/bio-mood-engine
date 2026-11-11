/**
 * 09 §8 M01 / M08 / M12：长时稳定性、回归 home 与统计边界。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MOOD_HOME, MOOD_KEYS } from '../../lib/core/constants.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { updateMood } from '../../lib/modules/mood/index.mjs';

import { CHARACTER_ID, MASTER_SEED } from './_random_vectors.mjs';

const NOW = '2026-11-09T08:00:00.000Z';
const BASE_VECTOR = Object.freeze({
  physical_comfort: 0.05,
  energy: 0.06,
  sensitivity: -0.02,
  social_drive: 0.05
});
const NEUTRAL_REGULATION = Object.freeze({
  reward_sensitivity: 0.5,
  arousal: 0.5,
  threat_sensitivity: 0.5,
  calm_regulation: 0.5,
  social_reassurance_drive: 0.5,
  fatigue_load: 0.5
});

function makeMood(overrides = {}) {
  const out = {};
  for (const key of MOOD_KEYS) out[key] = MOOD_HOME[key];
  out.model_version = 1;
  return { ...out, ...overrides };
}

function makeInputs(overrides = {}) {
  return {
    cycle: {
      phase: 'follicular_like',
      phase_vector: { ...BASE_VECTOR },
      scalars: { cycle_sensitivity: 0.45 }
    },
    sleep: { sleep_debt: 0.15, sleep_quality: 0.7, sleepiness: 0.25 },
    stress: { level: 0.15 },
    regulation: { ...NEUTRAL_REGULATION },
    event: { intensity: null },
    dt: 3600,
    ...overrides
  };
}

function makeStream() {
  return new RandomProvider({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID }).stream('mood');
}

function runMood({ previous, inputs, rng }) {
  return updateMood({ previous, inputs, now: NOW, rng, config: {} });
}

test('M01 1000 回合随机输入：七维始终有限且落在 [0,1]，无 -0', () => {
  const rng = makeStream();
  let previous = makeMood();
  for (let i = 0; i < 1000; i += 1) {
    const inputs = makeInputs({
      dt: 600 + ((i * 7) % 7) * 500,
      sleep: {
        sleep_debt: 0.1 + ((i * 13) % 30) / 100,
        sleep_quality: 0.5 + ((i * 17) % 40) / 100,
        sleepiness: 0.2 + ((i * 11) % 40) / 100
      },
      stress: { level: 0.15 + ((i * 19) % 45) / 100 },
      event: { intensity: i % 37 === 0 ? 0.8 : null }
    });
    const out = runMood({ previous, inputs, rng });
    for (const key of MOOD_KEYS) {
      const value = out.state[key];
      assert.equal(Number.isFinite(value), true, `${key} not finite`);
      assert.ok(value >= 0 && value <= 1, `${key}=${value}`);
      assert.equal(Object.is(value, -0), false, `${key} is -0`);
    }
    previous = out.state;
  }
});

test('M08 无输入 3 天：各偏离维与 home 的距离收缩到初始距离的 50% 以下', () => {
  const rng = makeStream();
  const displaced = { energy: 0.9, stress: 0.9, closeness_need: 0.05 };
  let previous = makeMood(displaced);
  const initial = {};
  for (const key of Object.keys(displaced)) {
    initial[key] = Math.abs(previous[key] - MOOD_HOME[key]);
  }
  for (let i = 0; i < 72; i += 1) {
    const out = runMood({ previous, inputs: makeInputs({ dt: 3600 }), rng });
    previous = out.state;
  }
  for (const key of Object.keys(displaced)) {
    const distance = Math.abs(previous[key] - MOOD_HOME[key]);
    assert.ok(distance < initial[key] * 0.5, `${key}: ${distance} vs ${initial[key]}`);
  }
});

test('M12 30 天逐小时：七维均值在 [0.2,0.8]，7 天窗口标准差 < 0.12，边界占比 < 5%', () => {
  const rng = makeStream();
  let previous = makeMood();
  const series = {};
  for (const key of MOOD_KEYS) series[key] = [];

  const inputs = makeInputs({
    sleep: { sleep_debt: 0.25, sleep_quality: 0.7, sleepiness: 0.3 },
    stress: { level: 0.3 }
  });

  for (let i = 0; i < 720; i += 1) {
    const out = runMood({ previous, inputs, rng });
    previous = out.state;
    for (const key of MOOD_KEYS) series[key].push(out.state[key]);
  }

  const WINDOW = 168;
  for (const key of MOOD_KEYS) {
    const values = series[key];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(mean >= 0.2 && mean <= 0.8, `${key} mean=${mean}`);

    let maxSd = 0;
    for (let start = 0; start + WINDOW <= values.length; start += WINDOW) {
      const slice = values.slice(start, start + WINDOW);
      const sliceMean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
      const variance = slice.reduce((sum, value) => sum + (value - sliceMean) ** 2, 0) / slice.length;
      maxSd = Math.max(maxSd, Math.sqrt(variance));
    }
    assert.ok(maxSd < 0.12, `${key} 7d sd=${maxSd}`);

    const edge = values.filter((value) => value <= 0.02 || value >= 0.98).length / values.length;
    assert.ok(edge < 0.05, `${key} edge share=${edge}`);
  }
});
