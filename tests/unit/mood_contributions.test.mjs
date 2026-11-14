/**
 * 09 §8 M02–M07 / M09–M11 / M13–M21：来源分解、上限、dt、噪声与解释码。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_STATE, DELTA_LIMITS, MOOD_HOME, MOOD_KEYS, MOOD_MODEL_VERSION, CYCLE_CONTRIB_WEIGHTS } from '../../lib/core/constants.mjs';
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
import { cycleTerms, CYCLE_GAIN } from '../../lib/modules/mood/contributions.mjs';

import { loadValidState } from '../helpers/state.mjs';

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
  out.model_version = MOOD_MODEL_VERSION;
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

// ============================================================
// C2-A：phase_vector 严格输入校验（v1.7.14）
// 测试通过 updateMood() 公开入口触发，不导出 readPhaseVector。
// ============================================================

/** 九维合法 phase_vector（V2）。 */
const VALID_V2_VECTOR = Object.freeze({
  physical_comfort: 0.05,
  energy: 0.06,
  sensitivity: -0.02,
  social_drive: 0.05,
  pain_load: 0.30,
  anxiety_delta: 0.10,
  irritability_delta: 0.08,
  positive_affect_delta: 0.15,
  intimacy_need_delta: 0.20
});

/** 四维合法 phase_vector（V1，兼容降级）。 */
const VALID_V1_VECTOR = Object.freeze({
  physical_comfort: 0.05,
  energy: 0.06,
  sensitivity: -0.02,
  social_drive: 0.05
});

/**
 * 调用 updateMood 并断言抛 MODULE_FAILED。
 * 同时断言错误对象包含 code='MODULE_FAILED' 和 module='mood'。
 * @param {object} inputsOverride 替换 makeInputs 中的 cycle 部分
 * @param {object} [expectedDetails] 可选 details 字段断言
 */
function assertMoodFailed(inputsOverride, expectedDetails) {
  const prev = makeMood();
  let result;
  assert.throws(() => {
    result = runMood({ previous: prev, inputs: { ...makeInputs(), ...inputsOverride } });
  }, (err) => {
    assert.equal(err.code, 'MODULE_FAILED', `expect MODULE_FAILED, got ${err.code}`);
    assert.ok(err.details, `expect err.details to exist`);
    assert.equal(err.details.module, 'mood', `expect err.details.module='mood', got ${err.details?.module}`);
    if (expectedDetails) {
      for (const [k, v] of Object.entries(expectedDetails)) {
        assert.equal(err.details[k], v, `expect err.details.${k}=${v}, got ${err.details?.[k]}`);
      }
    }
    return true;
  });
  // T19：原子性 —— 错误发生前 updateMood 不应写入任何状态
  assert.ok(result === undefined, 'updateMood 抛错后不应返回状态对象');
}

// T1：合法四维（V1）—— 接受
test('C2-A T1：合法四维（V1）phase_vector 被接受', () => {
  const prev = makeMood();
  const inputs = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: { ...VALID_V1_VECTOR }, scalars: { cycle_sensitivity: 0.45 } }
  };
  const result = runMood({ previous: prev, inputs });
  assert.ok(result && typeof result.state === 'object');
  // 旧四维贡献应正常（cycleTerms 只看四维）
  const cycleContrib = result.contributions['mood.energy'].cycle;
  assert.ok(typeof cycleContrib === 'number');
});

// T2：合法九维（V2）—— 接受
test('C2-A T2：合法九维（V2）phase_vector 被接受', () => {
  const prev = makeMood();
  const inputs = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: { ...VALID_V2_VECTOR }, scalars: { cycle_sensitivity: 0.45 } }
  };
  const result = runMood({ previous: prev, inputs });
  assert.ok(result && typeof result.state === 'object');
});

// T3：键顺序打乱 —— 接受（形状校验按排序比对）
test('C2-A T3：键顺序打乱（四维、九维）均被接受', () => {
  const v1Shuffled = { energy: 0.1, social_drive: 0.1, physical_comfort: 0.1, sensitivity: 0.1 };
  const v2Shuffled = {
    social_drive: 0.1, anxiety_delta: 0.1, physical_comfort: 0.1, intimacy_need_delta: 0.1,
    positive_affect_delta: 0.1, sensitivity: 0.1, irritability_delta: 0.1, pain_load: 0.1, energy: 0.1
  };
  for (const vec of [v1Shuffled, v2Shuffled]) {
    const prev = makeMood();
    const inputs = {
      ...makeInputs(),
      cycle: { phase: 'follicular_like', phase_vector: vec, scalars: { cycle_sensitivity: 0.45 } }
    };
    const result = runMood({ previous: prev, inputs });
    assert.ok(result && typeof result.state === 'object');
  }
});

// T4：缺一个键 —— MODULE_FAILED
test('C2-A T4：缺少一个键 —— MODULE_FAILED', () => {
  const v1Missing = { physical_comfort: 0.1, energy: 0.1, sensitivity: 0.1 }; // 少 social_drive
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: v1Missing, scalars: { cycle_sensitivity: 0.45 } }
  });
  const v2Missing = { ...VALID_V2_VECTOR }; delete v2Missing.energy;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: v2Missing, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T5：多一个多余键 —— MODULE_FAILED
test('C2-A T5：多余键 —— MODULE_FAILED', () => {
  const v1Extra = { ...VALID_V1_VECTOR, unknown_extra: 0.1 };
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: v1Extra, scalars: { cycle_sensitivity: 0.45 } }
  });
  const v2Extra = { ...VALID_V2_VECTOR, unknown_extra: 0.1 };
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: v2Extra, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T6：空对象 —— MODULE_FAILED
test('C2-A T6：空对象 —— MODULE_FAILED', () => {
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: {}, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T7：数组 —— MODULE_FAILED
test('C2-A T7：phase_vector 为数组 —— MODULE_FAILED', () => {
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: [], scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T8：显式 null —— MODULE_FAILED
test('C2-A T8：phase_vector 显式 null —— MODULE_FAILED', () => {
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: null, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T8b：cycleInput 本身显式 null —— MODULE_FAILED
test('C2-A T8b：cycleInput 本身显式 null —— MODULE_FAILED', () => {
  // 通过覆盖 inputs.cycle 为 null
  assertMoodFailed({ cycle: null });
});

// T9：phase_vector 属性缺失或 undefined —— 降级全零向量 + missing=true
test('C2-A T9：phase_vector 缺失或 undefined —— 降级全零向量', () => {
  const prev = makeMood();
  // 场景 A：cycleInput 有 phase 属性但无 phase_vector 属性
  const inputsNoKey = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', scalars: { cycle_sensitivity: 0.45 } }
  };
  const rng1 = makeStream();
  const resultA = runMood({ previous: prev, inputs: inputsNoKey, rng: rng1 });
  assert.ok(resultA && typeof resultA.state === 'object', '缺失属性应降级，不是抛错');

  // 场景 B：phase_vector 显式 undefined
  const inputsUnd = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: undefined, scalars: { cycle_sensitivity: 0.45 } }
  };
  const rng2 = makeStream();
  const resultB = runMood({ previous: prev, inputs: inputsUnd, rng: rng2 });
  assert.ok(resultB && typeof resultB.state === 'object', 'undefined 应降级');
});

// T10：向量存在，某值为 undefined —— MODULE_FAILED
test('C2-A T10：向量值为 undefined —— MODULE_FAILED', () => {
  const bad = { ...VALID_V2_VECTOR }; bad.energy = undefined;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: bad, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T11：向量值为 null —— MODULE_FAILED
test('C2-A T11：向量值为 null —— MODULE_FAILED', () => {
  const bad = { ...VALID_V2_VECTOR }; bad.energy = null;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: bad, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T12：向量值为 string / boolean —— MODULE_FAILED
test('C2-A T12：向量值为非 number 原始类型 —— MODULE_FAILED', () => {
  for (const badVal of ['0.1', true, false, 'hello']) {
    const bad = { ...VALID_V2_VECTOR }; bad.energy = badVal;
    assertMoodFailed({
      cycle: { phase: 'follicular_like', phase_vector: bad, scalars: { cycle_sensitivity: 0.45 } }
    });
  }
});

// T12b：new Number(0) 装箱对象 —— MODULE_FAILED（typeof 不是 'number'）
test('C2-A T12b：向量值为 new Number(0) 装箱对象 —— MODULE_FAILED', () => {
  const bad = { ...VALID_V2_VECTOR }; bad.energy = new Number(0);
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: bad, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T13：NaN / Infinity / -Infinity —— MODULE_FAILED
test('C2-A T13：向量值为非有限数 —— MODULE_FAILED', () => {
  for (const badVal of [NaN, Infinity, -Infinity]) {
    const bad = { ...VALID_V2_VECTOR }; bad.energy = badVal;
    assertMoodFailed({
      cycle: { phase: 'follicular_like', phase_vector: bad, scalars: { cycle_sensitivity: 0.45 } }
    });
  }
});

// T14：数值越界（±1.01）—— MODULE_FAILED（不再静默 clamp）
test('C2-A T14：向量值越界 ±1.01 —— MODULE_FAILED', () => {
  const badPos = { ...VALID_V2_VECTOR }; badPos.energy = 1.01;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: badPos, scalars: { cycle_sensitivity: 0.45 } }
  });
  const badNeg = { ...VALID_V2_VECTOR }; badNeg.energy = -1.01;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: badNeg, scalars: { cycle_sensitivity: 0.45 } }
  });
  // 特殊：Number.MAX_VALUE 远超范围
  const maxV = { ...VALID_V2_VECTOR }; maxV.energy = Number.MAX_VALUE;
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: maxV, scalars: { cycle_sensitivity: 0.45 } }
  });
});

// T15：边界值（1 / -1 / 0 / Number.MIN_VALUE / -0）—— 接受
test('C2-A T15：边界值 ±1 / 0 / MIN_VALUE / -0 均被接受', () => {
  const boundaryV = {
    physical_comfort: 1,
    energy: -1,
    sensitivity: 0,
    social_drive: Number.MIN_VALUE, // ~5e-324，非常接近 0 的正数，合法
    pain_load: -0, // -0 === 0，合法
    anxiety_delta: 0.5,
    irritability_delta: 0.5,
    positive_affect_delta: 0.5,
    intimacy_need_delta: 0.5
  };
  const prev = makeMood();
  const inputs = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: boundaryV, scalars: { cycle_sensitivity: 0.45 } }
  };
  const rng = makeStream();
  const result = runMood({ previous: prev, inputs, rng });
  // 只需验证合法输入被接受，完整 mood 更新成功
  assert.ok(result && typeof result.state === 'object');
  assert.equal(result.state.model_version, MOOD_MODEL_VERSION);
});

// T16：合法九维调用 cycleTerms，旧四维贡献与纯四维输入一致
test('C2-A T16：九维 vector 下 cycleTerms 旧四维贡献与 V1 输入完全一致', () => {
  // 通过 runMood 的 contributions 输出来验证 cycleTerms 对旧四维的处理。
  // 仅 energy 字段设为已知值，其余四维为 0；新五维全部为 0。
  const prev = makeMood();
  const v1OnlyEnergy = { ...VALID_V1_VECTOR, energy: 0.10, physical_comfort: 0, sensitivity: 0, social_drive: 0 };
  const v2OnlyEnergy = { ...VALID_V2_VECTOR, energy: 0.10, physical_comfort: 0, sensitivity: 0, social_drive: 0,
    pain_load: 0, anxiety_delta: 0, irritability_delta: 0, positive_affect_delta: 0, intimacy_need_delta: 0 };

  const cycleSens = 0.5;
  const inputsV1 = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: v1OnlyEnergy, scalars: { cycle_sensitivity: cycleSens } }
  };
  const inputsV2 = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: v2OnlyEnergy, scalars: { cycle_sensitivity: cycleSens } }
  };
  const rng1 = makeStream();
  const rng2 = makeStream();
  const resultV1 = runMood({ previous: prev, inputs: inputsV1, rng: rng1 });
  const resultV2 = runMood({ previous: prev, inputs: inputsV2, rng: rng2 });

  // 验证 cycle.energy 贡献值相同 —— cycleTerms 只看四维字段，新五维为 0 时贡献应一致
  assert.equal(resultV1.contributions['mood.energy'].cycle, resultV2.contributions['mood.energy'].cycle);
  assert.equal(resultV1.contributions['mood.physical_comfort'].cycle, resultV2.contributions['mood.physical_comfort'].cycle);
  assert.equal(resultV1.contributions['mood.sensitivity'].cycle, resultV2.contributions['mood.sensitivity'].cycle);
  assert.equal(resultV1.contributions['mood.social_drive'].cycle, resultV2.contributions['mood.social_drive'].cycle);
  // stability 的 cycle 贡献（cycleSensitivity 偏移）也应相同
  assert.equal(resultV1.contributions['mood.stability'].cycle, resultV2.contributions['mood.stability'].cycle);
});

// T17：合法九维输入完整 mood 更新成功（公开接口行为验证）
test('C2-A T17：合法九维输入触发完整 mood 更新', () => {
  const prev = makeMood();
  const inputs = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: { ...VALID_V2_VECTOR }, scalars: { cycle_sensitivity: 0.45 } }
  };
  const result = runMood({ previous: prev, inputs });
  // 七维状态全部被写入
  for (const key of Object.keys(MOOD_HOME)) {
    assert.ok(typeof result.state[key] === 'number', `mood.${key} 必须是 number`);
  }
  // model_version 由 C2-C 统一为 MOOD_MODEL_VERSION（2）
  assert.equal(result.state.model_version, MOOD_MODEL_VERSION);
});

// T19：非法输入失败时 mood 状态未被部分更新（原子性）
test('C2-A T19：非法 phase_vector 输入后 mood 状态无部分更新 —— 原子性', () => {
  const prev = makeMood();
  const prevSnapshot = JSON.parse(JSON.stringify(prev));

  // 触发非法输入（多余键 → MODULE_FAILED）
  assert.throws(() => {
    runMood({ previous: prev, inputs: {
      ...makeInputs(),
      cycle: { phase: 'follicular_like', phase_vector: { ...VALID_V1_VECTOR, extra_bad_key: 0.1 }, scalars: { cycle_sensitivity: 0.45 } }
    }});
  }, (err) => {
    assert.equal(err.code, 'MODULE_FAILED');
    assert.equal(err.details.module, 'mood');
    return true;
  });

  // previous 对象本身不应被 updateMood 修改（它只读取 previous）
  assert.deepEqual(prev, prevSnapshot, 'previous 对象不应被副作用修改');
});

// C2-A 额外：非普通对象守卫（Date / Map / null-prototype 对象）
test('C2-A：非普通对象（Date / Map）—— MODULE_FAILED', () => {
  const badDate = Object.assign({}, VALID_V2_VECTOR, {}); // 还是普通对象，但 Date 本身不行
  // Date 实例
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: new Date(), scalars: { cycle_sensitivity: 0.45 } }
  });
  // Map
  assertMoodFailed({
    cycle: { phase: 'follicular_like', phase_vector: new Map(), scalars: { cycle_sensitivity: 0.45 } }
  });
});

test('C2-A：null-prototype 对象（Object.create(null)）—— 被接受（isPlainObject 返回 true）', () => {
  const nullProto = Object.create(null);
  for (const [k, v] of Object.entries(VALID_V2_VECTOR)) nullProto[k] = v;
  const prev = makeMood();
  const inputs = {
    ...makeInputs(),
    cycle: { phase: 'follicular_like', phase_vector: nullProto, scalars: { cycle_sensitivity: 0.45 } }
  };
  const result = runMood({ previous: prev, inputs });
  assert.ok(result && typeof result.state === 'object');
});

// ============================================================
// C2-B：九维贡献计算（v1.7.14 周期扩展）
// 所有贡献权重来自 CYCLE_CONTRIB_WEIGHTS × CYCLE_GAIN。
// 直接调 cycleTerms() 纯函数验证，绕开 runMood 的 alpha/round6/applyLimits。
// 旧四维贡献语义完全不变（C2-A T16 已验证）。
// ============================================================

/** C2-B 辅助：构造仅指定字段非零的九维向量，其余全部 0。 */
function makeV2Vector(overrides = {}) {
  const v = {
    physical_comfort: 0, energy: 0, sensitivity: 0, social_drive: 0,
    pain_load: 0, anxiety_delta: 0, irritability_delta: 0,
    positive_affect_delta: 0, intimacy_need_delta: 0,
    ...overrides
  };
  return Object.freeze(v);
}

/** C2-B 辅助：精确计算 cycleTerms 预期输出（与实现一致，用于验证）。 */
function expectedCycleTerms(vector, cycleSensitivity = 0.5) {
  const w = CYCLE_CONTRIB_WEIGHTS;
  const g = CYCLE_GAIN;
  const out = {};
  // 七维 mood 输出，初始化 0
  for (const k of MOOD_KEYS) out[k] = 0;
  // 旧四维
  out.energy = g * vector.energy;
  out.sensitivity = g * vector.sensitivity;
  out.social_drive = g * vector.social_drive;
  out.physical_comfort = g * vector.physical_comfort;
  out.stability = -0.3 * (cycleSensitivity - 0.5);
  // 新五维叠加
  const pl = vector.pain_load ?? 0;
  const anx = vector.anxiety_delta ?? 0;
  const irr = vector.irritability_delta ?? 0;
  const pos = vector.positive_affect_delta ?? 0;
  const intim = vector.intimacy_need_delta ?? 0;
  out.physical_comfort -= g * w.w_pain_pc.initial * pl;
  out.energy -= g * w.w_pain_energy.initial * pl;
  out.stability -= g * w.w_anx_stab.initial * anx;
  out.sensitivity += g * w.w_anx_sens.initial * anx;
  out.stability -= g * w.w_irr_stab.initial * irr;
  out.sensitivity += g * w.w_irr_sens.initial * irr;
  out.stability += g * w.w_pos_stab.initial * pos;
  out.social_drive += g * w.w_pos_social.initial * pos;
  out.closeness_need = g * w.w_intimacy.initial * intim;
  return out;
}

/** C2-B 辅助：直接调 cycleTerms 纯函数获取原始贡献（未乘 alpha、未 round6）。 */
function rawCycleContrib(phaseVector, cycleSensitivity = 0.5) {
  return cycleTerms(phaseVector, cycleSensitivity);
}

// C2-B T1：全零九维向量 —— 输出 = cycleSensitivity 偏移，新五维全零无影响
test('C2-B T1：全零九维 phase_vector —— cycleTerms 仅输出 cycle_sensitivity 偏移', () => {
  const v = makeV2Vector();
  const out = rawCycleContrib(v, 0.5);
  // cycleSensitivity=0.5 时 stability 偏移 = -0.3*(0.5-0.5) = 0
  assert.equal(out.stability, 0);
  // 旧四维都是 0，新五维也都是 0 → 所有输出都是 0
  assert.equal(out.energy, 0);
  assert.equal(out.sensitivity, 0);
  assert.equal(out.social_drive, 0);
  assert.equal(out.physical_comfort, 0);
  assert.equal(out.closeness_need, 0);
  assert.equal(out.stress, 0, 'stress 恒为 0');
});

// C2-B T2：pain_load=0.5 单独非零 —— pc ↓ + energy ↓ 验证方向和数值
test('C2-B T2：pain_load 单独 → physical_comfort 负向 + energy 负向', () => {
  const v = makeV2Vector({ pain_load: 0.5 });
  const out = rawCycleContrib(v);
  const w = CYCLE_CONTRIB_WEIGHTS;
  const g = CYCLE_GAIN;
  const expected = expectedCycleTerms(v);
  // 精确数值验证（纯函数，无 alpha）
  assert.equal(out.physical_comfort, expected.physical_comfort);
  assert.equal(out.energy, expected.energy);
  // 方向
  assert.ok(out.physical_comfort < 0, `pain↑ → pc 必须↓ (got ${out.physical_comfort})`);
  assert.ok(out.energy < 0, `pain↑ → energy 必须↓ (got ${out.energy})`);
});

// C2-B T3：anxiety_delta=+0.3 单独 —— stability ↓ + sensitivity ↑
test('C2-B T3：anxiety_delta 单独 → stability 负向 + sensitivity 正向', () => {
  const v = makeV2Vector({ anxiety_delta: 0.3 });
  const out = rawCycleContrib(v);
  const expected = expectedCycleTerms(v);
  assert.equal(out.stability, expected.stability);
  assert.equal(out.sensitivity, expected.sensitivity);
  assert.ok(out.stability < 0, `anxiety↑ → stability 必须↓`);
  assert.ok(out.sensitivity > 0, `anxiety↑ → sensitivity 必须↑`);
});

// C2-B T4：irritability_delta=+0.3 单独 —— stability ↓ + sensitivity ↑
test('C2-B T4：irritability_delta 单独 → stability 负向 + sensitivity 正向', () => {
  const v = makeV2Vector({ irritability_delta: 0.3 });
  const out = rawCycleContrib(v);
  const expected = expectedCycleTerms(v);
  assert.equal(out.stability, expected.stability);
  assert.equal(out.sensitivity, expected.sensitivity);
  assert.ok(out.stability < 0, `irr↑ → stability 必须↓`);
  assert.ok(out.sensitivity > 0, `irr↑ → sensitivity 必须↑`);
});

// C2-B T5：positive_affect_delta=+0.3 单独 —— stability ↑ + social_drive ↑
test('C2-B T5：positive_affect_delta 单独 → stability 正向 + social_drive 正向', () => {
  const v = makeV2Vector({ positive_affect_delta: 0.3 });
  const out = rawCycleContrib(v);
  const expected = expectedCycleTerms(v);
  assert.equal(out.stability, expected.stability);
  assert.equal(out.social_drive, expected.social_drive);
  assert.ok(out.stability > 0, `positive↑ → stability 必须↑`);
  assert.ok(out.social_drive > 0, `positive↑ → social_drive 必须↑`);
});

// C2-B T6：intimacy_need_delta=+0.5 单独 —— closeness_need ↑（cycle 新增来源）
test('C2-B T6：intimacy_need_delta 单独 → closeness_need 正向（cycle 新增渠道）', () => {
  const v = makeV2Vector({ intimacy_need_delta: 0.5 });
  const out = rawCycleContrib(v);
  const expected = expectedCycleTerms(v);
  assert.equal(out.closeness_need, expected.closeness_need);
  assert.ok(out.closeness_need > 0, `intimacy↑ → closeness_need 必须↑`);
  assert.equal(out.stress, 0, 'stress 恒为 0');
  assert.equal(out.energy, 0, 'intimacy 不应影响 energy');
});

// C2-B T7：九维全非零 —— cycleTerms 与 expectedCycleTerms 逐维精确一致
test('C2-B T7：九维全非零输入 —— cycleTerms 与 CYCLE_CONTRIB_WEIGHTS 精确一致', () => {
  const v = makeV2Vector({
    physical_comfort: 0.05, energy: 0.06, sensitivity: -0.02, social_drive: 0.05,
    pain_load: 0.5, anxiety_delta: 0.3, irritability_delta: 0.2,
    positive_affect_delta: 0.25, intimacy_need_delta: 0.4
  });
  const expected = expectedCycleTerms(v, 0.5);
  const out = rawCycleContrib(v, 0.5);
  for (const dim of MOOD_KEYS) {
    assert.equal(out[dim], expected[dim], `${dim}: expect ${expected[dim]}, got ${out[dim]}`);
  }
});

// C2-B T8：V1 输入无新五维键 —— cycleTerms 自动降级新五维为 0，旧四维不变
test('C2-B T8：V1 四维输入（无新五维键）—— cycleTerms 自动降级新五维为 0，旧四维不变', () => {
  const v1Only = { ...VALID_V1_VECTOR };
  const out = rawCycleContrib(v1Only);
  const expected = expectedCycleTerms(v1Only);
  for (const dim of MOOD_KEYS) {
    assert.equal(out[dim], expected[dim], `${dim} 应一致`);
  }
  // closeness_need 为 0（intimacy_need_delta 不存在，??0 降级）
  assert.equal(out.closeness_need, 0);
});

// C2-B T9：closeness_need 纯 cycle 渠道 —— 单独验证 CYCLE_GAIN × w_intimacy × intimacy
test('C2-B T9：closeness_need cycle 渠道 —— CYCLE_GAIN × w_intimacy.initial × intimacy 精确一致', () => {
  const g = CYCLE_GAIN;
  const w = CYCLE_CONTRIB_WEIGHTS;
  const v = makeV2Vector({ intimacy_need_delta: 0.5 });
  const out = rawCycleContrib(v);
  const expectedCycleCloseness = g * w.w_intimacy.initial * 0.5;
  assert.equal(out.closeness_need, expectedCycleCloseness);
  // 其他维度不应受影响（全部为 0 或仅有 stability 的 cycleSensitivity 偏移）
  assert.equal(out.energy, 0);
  assert.equal(out.physical_comfort, 0);
  assert.equal(out.sensitivity, 0);
  assert.equal(out.social_drive, 0);
});

// C2-B T10：独立数值 oracle —— 预期值由冻结契约手工计算并写死，
// 不读取生产权重、不读取 CYCLE_GAIN，也不调用 expectedCycleTerms()。
// 同时覆盖旧四维单次缩放、新五维九条映射及未映射的 stress 维度。
test('C2-B T10：九维贡献与独立手工数值一致', () => {
  const v = makeV2Vector({
    physical_comfort: 0.05, energy: 0.06, sensitivity: -0.02, social_drive: 0.05,
    pain_load: 0.5, anxiety_delta: 0.3, irritability_delta: 0.2,
    positive_affect_delta: 0.25, intimacy_need_delta: 0.4
  });
  const out = rawCycleContrib(v, 0.5);
  const rounded = Object.fromEntries(
    Object.entries(out).map(([key, value]) => [key, round6(value)])
  );
  assert.deepEqual(rounded, {
    physical_comfort: -0.03,
    energy: 0.006,
    stability: -0.0264,
    sensitivity: 0.0204,
    social_drive: 0.045,
    stress: 0,
    closeness_need: 0.06
  });
});

// C2-B CT1：九维周期贡献权重与冻结契约一致（Contract Test）
// 与 T7 计算映射测试互补——T7 用生产权重验证公式；
// CT1 独立断言生产权重值仍然符合冻结设计参数。
// 若有人误改 constants.mjs 中的 initial 值，此测试会立即失败。
test('C2-B CT1：CYCLE_CONTRIB_WEIGHTS 与冻结契约一致（Contract Test）', () => {
  const expectedInitial = Object.freeze({
    w_pain_pc:       0.20,
    w_pain_energy:   0.10,
    w_anx_stab:      0.15,
    w_anx_sens:      0.10,
    w_irr_stab:      0.12,
    w_irr_sens:      0.12,
    w_pos_stab:      0.10,
    w_pos_social:    0.10,
    w_intimacy:      0.25
  });
  for (const [key, expectedVal] of Object.entries(expectedInitial)) {
    const actual = CYCLE_CONTRIB_WEIGHTS[key];
    assert.ok(actual, `${key} 必须存在于 CYCLE_CONTRIB_WEIGHTS`);
    assert.equal(actual.initial, expectedVal,
      `${key}.initial 冻结值 ${expectedVal}，实际 ${actual.initial}（权重被篡改？）`);
    // range 必须存在且为 [0, max] 形式
    assert.ok(Array.isArray(actual.range), `${key}.range 必须是数组`);
    assert.equal(actual.range.length, 2, `${key}.range 必须有 [min, max] 两项`);
    assert.ok(actual.range[0] >= 0, `${key}.range[0] 必须 ≥ 0`);
    assert.ok(actual.range[1] >= actual.initial, `${key}.range[1] 必须 ≥ initial`);
  }
  // 额外：契约规定 CYCLE_GAIN = 0.6
  assert.equal(CYCLE_GAIN, 0.6, 'CYCLE_GAIN 冻结值 0.6，实际被篡改？');
});

// ---------------------------------------------------------------------------
// C2-C：版本迁移与诊断
// ---------------------------------------------------------------------------

// C2-C T1：state.model_version / diagnostics.model_version 统一取自 MOOD_MODEL_VERSION
test('C2-C T1：state 与 diagnostics 的 model_version 统一为 MOOD_MODEL_VERSION', () => {
  const out = runMood();
  assert.equal(MOOD_MODEL_VERSION, 2, 'MOOD_MODEL_VERSION 冻结值 2');
  assert.equal(out.state.model_version, MOOD_MODEL_VERSION);
  assert.equal(out.diagnostics.model_version, MOOD_MODEL_VERSION);
  assert.equal(out.diagnostics.module, 'mood');
  // 与 DEFAULT_STATE 内置初始态保持一致（单一事实源）
  assert.equal(DEFAULT_STATE.mood.model_version, MOOD_MODEL_VERSION);
});

// C2-C T2：真实 fixture 的旧状态（model_version=1）经 updateMood 完整处理路径 → 迁移为 2
test('C2-C T2：fixture 旧状态（model_version=1）经 updateMood 后版本迁移为 2 且七维无丢失', () => {
  const previous = loadValidState().mood; // tests/fixtures/state.valid.json：mood.model_version = 1
  assert.equal(previous.model_version, 1, 'fixture 必须保持 v1，作为迁移输入基线');

  const out = runMood({ previous });
  assert.equal(out.state.model_version, 2);
  assert.equal(out.diagnostics.model_version, 2);

  // 完整状态路径：输出键集恰为七维 + model_version，无字段丢失、无多余字段
  assert.deepEqual(
    Object.keys(out.state).sort(),
    [...MOOD_KEYS, 'model_version'].sort()
  );
  for (const key of MOOD_KEYS) {
    assert.ok(Number.isFinite(out.state[key]), `${key} 必须为有限数`);
    assert.ok(out.state[key] >= 0 && out.state[key] <= 1, `${key} 必须落在 [0,1]`);
    assert.equal(Object.is(out.state[key], -0), false, `${key} 不得为 -0`);
  }
  // 八来源贡献完整，迁移过程未影响贡献分解
  assert.deepEqual(
    Object.keys(out.contributions).sort(),
    MOOD_KEYS.map((key) => `mood.${key}`).sort()
  );
});

// C2-C T3：model_version 不参与计算——仅版本号不同时，状态与随机流消耗完全一致
test('C2-C T3：model_version 不参与噪声/惯性计算（previous=1 与 2 输出一致）', () => {
  const inputs = makeInputs();
  const streamOld = makeStream();
  const streamCur = makeStream();
  const beforeOld = streamOld.counter;
  const beforeCur = streamCur.counter;
  const outOld = runMood({ previous: makeMood({ model_version: 1 }), inputs, rng: streamOld });
  const outCur = runMood({ previous: makeMood({ model_version: 2 }), inputs, rng: streamCur });

  assert.equal(streamOld.counter - beforeOld, streamCur.counter - beforeCur);
  assert.deepEqual(outOld.contributions, outCur.contributions);
  assert.deepEqual(outOld.reason_codes, outCur.reason_codes);
  for (const key of MOOD_KEYS) {
    assert.equal(outOld.state[key], outCur.state[key], `${key} 不应受 model_version 影响`);
  }
  for (const key of MOOD_KEYS) {
    assert.ok(outOld.state[key] >= 0 && outOld.state[key] <= 1, key);
  }
});
