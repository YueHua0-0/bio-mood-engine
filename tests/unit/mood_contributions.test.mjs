/**
 * 09 §8 M02–M07 / M09–M11 / M13–M21：来源分解、上限、dt、噪声与解释码。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DELTA_LIMITS, MOOD_HOME, MOOD_KEYS } from '../../lib/core/constants.mjs';
import { round6 } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';

import {
  HARD_LIMIT,
  NORMAL_LIMIT,
  SEVERE_LIMIT,
  TAU_HOURS,
  alphaFor,
  applyLimits,
  assertHardBound
} from '../../lib/modules/mood/inertia.mjs';
import { FLOATS_PER_TICK, noiseFor } from '../../lib/modules/mood/noise.mjs';
import { moodModule, updateMood } from '../../lib/modules/mood/index.mjs';

import { CHARACTER_ID, MASTER_SEED } from './_random_vectors.mjs';

const NOW = '2026-11-09T08:00:00.000Z';
const SOURCES = ['cycle', 'sleep', 'stress', 'regulation', 'recovery', 'noise', 'event', 'clamp'];
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

function runMood({ previous = makeMood(), inputs = makeInputs(), rng = makeStream() } = {}) {
  return updateMood({ previous, inputs, now: NOW, rng, config: {} });
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

test('M02 每维贡献恰好 8 个来源键，无缺项', () => {
  const out = runMood();
  assert.deepEqual(
    Object.keys(out.contributions).sort(),
    MOOD_KEYS.map((key) => `mood.${key}`).sort()
  );
  for (const key of MOOD_KEYS) {
    assert.deepEqual(Object.keys(out.contributions[`mood.${key}`]).sort(), [...SOURCES].sort(), key);
  }
});

test('M03 任意 tick 的 event 贡献恒为 0', () => {
  let previous = makeMood();
  for (let i = 0; i < 60; i += 1) {
    const intensity = i % 2 === 0 ? 0.9 : null;
    const out = runMood({
      previous,
      inputs: makeInputs({ event: { intensity }, dt: 600 + (i % 4) * 600 })
    });
    for (const key of MOOD_KEYS) {
      assert.equal(out.contributions[`mood.${key}`].event, 0, `${key} event`);
    }
    previous = out.state;
  }
});

test('M04 普通事件单步任一维变化 ≤ 0.06', () => {
  const previous = makeMood({ energy: 0.9, stress: 0.1, physical_comfort: 0.2 });
  const out = runMood({ previous, inputs: makeInputs({ stress: { level: 0.6 } }) });
  for (const key of MOOD_KEYS) {
    assert.ok(Math.abs(out.state[key] - previous[key]) <= NORMAL_LIMIT + 1e-12, key);
  }
  assert.ok(out.warnings.includes('CLAMPED_DELTA'));
});

test('M05 intensity=0.8 时允许到 0.12，但不越界', () => {
  const previous = makeMood({ stress: 0.1 });
  const out = runMood({
    previous,
    inputs: makeInputs({ stress: { level: 1 }, event: { intensity: 0.8 } })
  });
  assert.equal(round6(out.state.stress - previous.stress), SEVERE_LIMIT);
  assert.ok(out.state.stress <= 1);
  assert.equal(out.warnings.includes('CLAMPED_DELTA'), true);
});

test('M06 delta_raw=+0.30（普通）裁剪到 +0.06 并追加 CLAMPED_DELTA，不抛错', () => {
  const previous = makeMood({ stress: 0.1 });
  const out = runMood({ previous, inputs: makeInputs({ stress: { level: 1 } }) });
  assert.equal(round6(out.state.stress - previous.stress), NORMAL_LIMIT);
  assert.ok(out.warnings.includes('CLAMPED_DELTA'));
  assert.ok(Math.abs(out.state.stress - previous.stress) <= HARD_LIMIT);
});

test('M06b 硬上限 0.15 是断言：绕过 clamp 的 0.20 → MODULE_FAILED', () => {
  assert.equal(assertHardBound(0.12), 0.12);
  assertCode(() => assertHardBound(0.2), 'MODULE_FAILED');
  // applyLimits 正常路径永远不会产出 >0.12
  assert.equal(applyLimits(0.5, 0.3, false).delta, NORMAL_LIMIT);
  assert.equal(applyLimits(0.5, 0.3, true).delta, SEVERE_LIMIT);
});

test('M07 dt = tau 时 alpha 精确为 0.5（逐维不同）', () => {
  for (const key of MOOD_KEYS) {
    assert.ok(Math.abs(alphaFor(key, TAU_HOURS[key] * 3600) - 0.5) < 1e-12, key);
  }
});

test('M09 噪声每维 |noise| ≤ 0.008，每 tick 固定 14 个 float', () => {
  const stream = makeStream();
  const before = stream.counter;
  for (let i = 0; i < 100_000; i += 1) {
    const noise = noiseFor(stream);
    for (const key of MOOD_KEYS) {
      assert.ok(Math.abs(noise[key]) <= 0.008, `${key} ${noise[key]}`);
    }
  }
  assert.equal(stream.counter - before, 100_000 * FLOATS_PER_TICK);
});

test('M10 上游 NaN → INVALID_REQUEST，入参不被修改', () => {
  const previous = makeMood();
  const snapshot = JSON.stringify(previous);
  assertCode(
    () => runMood({ previous, inputs: makeInputs({ sleep: { sleep_debt: NaN, sleep_quality: 0.7, sleepiness: 0.25 } }) }),
    'INVALID_REQUEST'
  );
  assert.equal(JSON.stringify(previous), snapshot);
});

test('M11 同种子同输入两次输出深度相等', () => {
  const first = runMood();
  const second = runMood();
  assert.deepEqual(first, second);
});

test('M13 stress.level 0.15→0.80：mood.stress 上升并收敛到 (level+0.09)/1.6', () => {
  let previous = makeMood();
  const start = previous.stress;
  for (let i = 0; i < 400; i += 1) {
    const out = runMood({ previous, inputs: makeInputs({ stress: { level: 0.8 } }) });
    previous = out.state;
  }
  const steady = (0.8 + 0.09) / 1.6;
  assert.ok(previous.stress > start);
  assert.ok(Math.abs(previous.stress - steady) < 0.02, `${previous.stress} vs ${steady}`);
});

test('M14 缺失 cycle / sleep / stress / regulation 分别降级并仍输出合法状态', () => {
  const cases = [
    ['MISSING_CYCLE_DATA', makeInputs({ cycle: { phase: 'follicular_like', scalars: { cycle_sensitivity: 0.45 } } })],
    ['MISSING_SLEEP_DATA', makeInputs({ sleep: {} })],
    ['MISSING_STRESS_DATA', makeInputs({ stress: {} })],
    ['MISSING_REGULATION_DATA', makeInputs({ regulation: {} })]
  ];
  for (const [code, inputs] of cases) {
    const out = runMood({ inputs });
    assert.ok(out.warnings.includes(code), `${code}: ${out.warnings.join(',')}`);
    for (const key of MOOD_KEYS) assert.ok(out.state[key] >= 0 && out.state[key] <= 1);
  }
});

test('M15 每维八项之和等于 next - previous（±1e-9）', () => {
  let previous = makeMood({ energy: 0.9, stress: 0.1 });
  for (let i = 0; i < 200; i += 1) {
    const out = runMood({
      previous,
      inputs: makeInputs({
        dt: 600 + (i % 6) * 600,
        stress: { level: (i % 10) / 10 }
      })
    });
    for (const key of MOOD_KEYS) {
      const entry = out.contributions[`mood.${key}`];
      let sum = 0;
      for (const source of SOURCES) sum += entry[source];
      assert.ok(
        Math.abs(sum - (out.state[key] - previous[key])) < 1e-9,
        `${key}: sum=${sum} delta=${out.state[key] - previous[key]}`
      );
    }
    previous = out.state;
  }
});

test('M16 round6(-1e-9) 归一为 0，输出无 -0', () => {
  assert.equal(round6(-1e-9), 0);
  assert.equal(Object.is(round6(-1e-9), -0), false);
  const out = runMood();
  for (const key of MOOD_KEYS) {
    assert.equal(Object.is(out.state[key], -0), false, key);
    for (const source of SOURCES) {
      assert.equal(Object.is(out.contributions[`mood.${key}`][source], -0), false, `${key}.${source}`);
    }
  }
});

test('M17 只写 mood.*，cycle 贡献每维一次且不合并 05 的诊断键', () => {
  const out = runMood();
  for (const key of Object.keys(out.contributions)) {
    assert.ok(key.startsWith('mood.'), key);
  }
  for (const key of MOOD_KEYS) {
    assert.equal(typeof out.contributions[`mood.${key}`].cycle, 'number');
  }
  assert.equal(out.contributions['cycle.energy'], undefined);
});

test('M18 解释码 ≤16、顺序固定、可复现', () => {
  const inputs = makeInputs({
    cycle: { phase: 'luteal_like', phase_vector: { ...BASE_VECTOR }, scalars: { cycle_sensitivity: 0.62 } },
    sleep: { sleep_debt: 0.6, sleep_quality: 0.7, sleepiness: 0.5 },
    stress: { level: 0.8 }
  });
  const first = runMood({ inputs });
  const second = runMood({ inputs });
  assert.deepEqual(first.reason_codes, second.reason_codes);
  assert.ok(first.reason_codes.length <= 16);
  assert.deepEqual(first.reason_codes.slice(0, 3), ['sleep_debt_high', 'stress_high', 'luteal_like']);
  assert.equal(new Set(first.reason_codes).size, first.reason_codes.length);
});

test('M19 dt=0：alpha 精确为 0、噪声仍消耗 14 个 float、recovery 全 0', () => {
  for (const key of MOOD_KEYS) assert.equal(alphaFor(key, 0), 0, key);
  const stream = makeStream();
  const before = stream.counter;
  const previous = makeMood({ energy: 0.9 });
  const out = runMood({ previous, inputs: makeInputs({ dt: 0 }), rng: stream });
  assert.equal(stream.counter - before, FLOATS_PER_TICK);
  for (const key of MOOD_KEYS) {
    assert.equal(out.contributions[`mood.${key}`].recovery, 0, `${key} recovery`);
    assert.equal(out.contributions[`mood.${key}`].cycle, 0, `${key} cycle`);
  }
});

test('M20 dt=60 与 dt=3600 的 energy 恢复项分别按各自 alpha 计算', () => {
  const a60 = alphaFor('energy', 60);
  const a3600 = alphaFor('energy', 3600);
  assert.ok(Math.abs(a60 - (1 - 2 ** (-60 / 7200))) < 1e-12);
  assert.ok(Math.abs(a3600 - (1 - 2 ** (-3600 / 7200))) < 1e-12);
  assert.ok(a60 < a3600 / 40, 'dt=60 不得按 3600 计算');

  const previous = makeMood({ energy: 0.9 });
  const short = runMood({ previous, inputs: makeInputs({ dt: 60 }) });
  const long = runMood({ previous, inputs: makeInputs({ dt: 3600 }) });
  const expected60 = round6((MOOD_HOME.energy - 0.9) * 0.6 * a60);
  const expected3600 = round6((MOOD_HOME.energy - 0.9) * 0.6 * a3600);
  assert.equal(short.contributions['mood.energy'].recovery, expected60);
  assert.equal(long.contributions['mood.energy'].recovery, expected3600);
});

test('M21 intensity 0.8 → 0.12 档；null → 0.06 档（其余输入相同）', () => {
  const previous = makeMood({ stress: 0.1 });
  const severe = runMood({
    previous,
    inputs: makeInputs({ stress: { level: 1 }, event: { intensity: 0.8 } })
  });
  const normal = runMood({
    previous,
    inputs: makeInputs({ stress: { level: 1 }, event: { intensity: null } })
  });
  assert.equal(round6(severe.state.stress - previous.stress), SEVERE_LIMIT);
  assert.equal(round6(normal.state.stress - previous.stress), NORMAL_LIMIT);
});

test('severity_high 不跨调用：高一档事件后下一 tick 回到 0.06 档', () => {
  const first = makeMood({ stress: 0.1 });
  const severe = runMood({
    previous: first,
    inputs: makeInputs({ stress: { level: 1 }, event: { intensity: 0.8 } })
  });
  const after = runMood({
    previous: severe.state,
    inputs: makeInputs({ stress: { level: 1 }, event: { intensity: null } })
  });
  assert.equal(round6(severe.state.stress - first.stress), SEVERE_LIMIT);
  assert.equal(round6(after.state.stress - severe.state.stress), NORMAL_LIMIT);
});

test('模块注册：name=mood，只导出 update', () => {
  assert.equal(moodModule.name, 'mood');
  assert.equal(typeof moodModule.update, 'function');
  assert.equal(moodModule.update, updateMood);
});

test('dt 缺失或非法 → MODULE_FAILED（不推算、不兜底）', () => {
  for (const dt of [undefined, null, -1, 1.5, '60']) {
    const inputs = makeInputs();
    if (dt === undefined) delete inputs.dt;
    else inputs.dt = dt;
    assertCode(() => runMood({ inputs }), 'MODULE_FAILED');
  }
});

test('§4.1 导出面与 cycleContribution / computeContributions 语义', async () => {
  const mod = await import('../../lib/modules/mood/index.mjs');
  for (const name of [
    'updateMood',
    'alphaFor',
    'cycleContribution',
    'computeContributions',
    'applyLimits',
    'buildReasonCodes'
  ]) {
    assert.equal(typeof mod[name], 'function', name);
  }
  const cycle = mod.cycleContribution('luteal_like', {
    physical_comfort: 0.1,
    energy: 0.1,
    sensitivity: 0.1,
    social_drive: 0.1
  });
  assert.ok(Math.abs(cycle.energy - 0.06) < 1e-12);
  assert.ok(Math.abs(cycle.stability - -0.3 * (0.62 - 0.5)) < 1e-12);

  const computed = mod.computeContributions({
    vector: { physical_comfort: 0, energy: 0, sensitivity: 0, social_drive: 0 },
    cycleSensitivity: 0.5,
    sleep: { sleepDebt: 0.2, sleepQuality: 0.7, sleepiness: 0.3 },
    stressLevel: 0.4,
    previousStress: 0.2,
    regulation: { ...NEUTRAL_REGULATION }
  });
  assert.deepEqual(Object.keys(computed).sort(), ['cycle', 'regulation', 'sleep', 'stress']);
  assert.ok(Math.abs(computed.stress.stress - 0.2) < 1e-12);
});

test('DELTA_LIMITS.mood 与 09 §5.3 冻结值一致', () => {
  assert.deepEqual(DELTA_LIMITS.mood, { normal: 0.06, severe: 0.12, hard: 0.15 });
});
