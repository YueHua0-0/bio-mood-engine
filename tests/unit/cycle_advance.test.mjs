/**
 * 05 §8 C05–C18：跨周期推进、采样、置信度、人工校正、确定性与降级。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CYCLE_MODEL_VERSION, CYCLE_PHASES, LIMITS, PHASE_VECTOR_KEYS_V2 } from '../../lib/core/constants.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';
import { createDefaultState, round6, validateState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';

import {
  MAX_CYCLE_STEPS,
  advanceCycleDays,
  applyManualCorrection,
  sampleCycleLength
} from '../../lib/modules/cycle/advance.mjs';
import { phaseInfluence } from '../../lib/modules/cycle/phase.mjs';
import { cycleModule, updateCycle } from '../../lib/modules/cycle/index.mjs';

import { CHARACTER_ID, MASTER_SEED } from './_random_vectors.mjs';

const START = '2026-01-01T00:00:00.000Z';
const START_MS = parseTime(START, 'start');
const MS_PER_DAY = 86_400_000;
const HOUR_MS = 3_600_000;
const L0 = 28.4;

function atDays(days) {
  return toIso(START_MS + Math.round(days * MS_PER_DAY));
}

function atHours(hours) {
  return toIso(START_MS + Math.round(hours * HOUR_MS));
}

function provider() {
  return new RandomProvider({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID });
}

function makeCycle(overrides = {}) {
  return {
    anchor_at: START,
    cycle_index: 0,
    cycle_length_days: L0,
    cycle_length_source: 'sampled',
    cycle_day: 1,
    phase: 'menstrual_like',
    phase_started_at: START,
    phase_progress: 0,
    confidence: 0.4,
    model_version: 1,
    ...overrides
  };
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

function assertCycleState(state) {
  assert.equal(Number.isFinite(state.cycle_length_days), true);
  assert.ok(state.cycle_length_days >= LIMITS.minCycleLengthDays);
  assert.ok(state.cycle_length_days <= LIMITS.maxCycleLengthDays);
  assert.ok(state.cycle_day >= 1);
  assert.ok(state.cycle_day <= state.cycle_length_days + 1e-9);
  assert.ok(CYCLE_PHASES.includes(state.phase));
  assert.ok(state.phase_progress >= 0 && state.phase_progress < 1);
  assert.ok(state.confidence >= 0 && state.confidence <= 1);
  for (const key of ['cycle_index', 'model_version']) {
    assert.equal(Number.isInteger(state[key]), true, `${key} must be integer`);
  }
}

function advanceWholeCycles(cycle, count, rngProvider) {
  let current = cycle;
  for (let i = 0; i < count; i += 1) {
    const remaining = current.cycle_length_days - (current.cycle_day - 1);
    current = advanceCycleDays({ cycle: current, deltaDays: remaining, rngProvider });
  }
  return current;
}

test('C05：推进 L+0.5 天 → cycle_index +1，cycle_day≈1.5', () => {
  const rngProvider = provider();
  const out = advanceCycleDays({ cycle: makeCycle(), deltaDays: L0 + 0.5, rngProvider });
  assert.equal(out.cycle_index, 1);
  assert.equal(out.cycle_day, 1.5);
  assert.equal(out.anchor_at, toIso(START_MS + Math.round(L0 * MS_PER_DAY)));
  assertCycleState(out);
});

test('C06：一次推进 12 个周期 → cycle_index +12，逐周期采样 12 次，耗时 <5 ms', () => {
  const probe = provider();
  let delta = L0;
  for (let i = 1; i <= 11; i += 1) delta += sampleCycleLength(i, probe);

  const rngProvider = provider();
  const started = process.hrtime.bigint();
  const out = advanceCycleDays({ cycle: makeCycle(), deltaDays: delta, rngProvider });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(out.cycle_index, 12);
  assert.equal(out.cycle_day, 1);
  assert.ok(elapsedMs < 5, `12 个周期推进耗时 ${elapsedMs} ms`);
  for (let i = 1; i <= 12; i += 1) {
    // counter 以 u32 计；一次 nextNormal() 消耗 2 个 u32
    assert.equal(rngProvider.stream(`cycle:${i}`).counter, 2, `cycle:${i} 应采样 1 次`);
  }
});

test('C07：采样 10 万次全部落在 [24,34]，均值 28.4±0.05，标准差 1.15±0.1', () => {
  const stream = provider().stream('cycle:sample_probe');
  const count = 100_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < count; i += 1) {
    const value = sampleCycleLength(0, stream);
    assert.ok(value >= 24 && value <= 34, `采样越界：${value}`);
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const sd = Math.sqrt(Math.max(variance, 0));
  assert.ok(Math.abs(mean - 28.4) <= 0.05, `均值 ${mean}`);
  assert.ok(Math.abs(sd - 1.15) <= 0.1, `标准差 ${sd}`);
});

test('C08：同种子同输入执行两次，输出深度相等', () => {
  const cycle = makeCycle({ cycle_day: 3 });
  const now = atDays(3);
  const run = () => {
    const rng = provider().stream('cycle:0');
    return updateCycle({ previous: cycle, inputs: {}, now, rng, config: {} });
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.deepEqual(first.derived, second.derived);

  // 跨周期（含逐周期采样）同样必须确定
  const crossing = () =>
    updateCycle({
      previous: makeCycle(),
      inputs: {},
      now: atDays(180),
      rng: provider().stream('cycle:0'),
      rngProvider: provider(),
      config: {}
    });
  assert.deepEqual(crossing(), crossing());
});

test('C08b default 首次 updateCycle 消耗 1 次 nextNormal 并转 sampled', () => {
  const stream = provider().stream('cycle:0');
  let calls = 0;
  const rng = {
    nextNormal: (...args) => {
      calls += 1;
      return stream.nextNormal(...args);
    }
  };
  const result = updateCycle({
    previous: makeCycle({ cycle_length_source: 'default', cycle_length_days: 28 }),
    inputs: {},
    now: atHours(1),
    rng,
    config: {}
  });
  assert.equal(calls, 1, '必须且只能消耗 1 次 nextNormal 采样');
  assert.equal(result.state.cycle_length_source, 'sampled');
  assert.ok(result.state.cycle_length_days >= 24 && result.state.cycle_length_days <= 34);
  assert.notEqual(result.state.cycle_length_days, 28);
});

test('C08c default 且缺 rng → MODULE_FAILED，不得静默转 sampled', () => {
  assertCode(
    () => updateCycle({
      previous: makeCycle({ cycle_length_source: 'default' }),
      inputs: {},
      now: atHours(1),
      rng: null,
      config: {}
    }),
    'MODULE_FAILED'
  );
});

test('C09：人工校正 → confidence=0.95、source=manual，并重算 cycle_day/phase', () => {
  const now = atDays(10);
  const rng = provider().stream('cycle:0');
  const result = updateCycle({
    previous: makeCycle(),
    inputs: { manual_anchor_at: atDays(7), manual_cycle_length_days: 30 },
    now,
    rng,
    config: {}
  });
  assert.equal(result.state.confidence, 0.95);
  assert.equal(result.state.cycle_length_source, 'manual');
  assert.equal(result.state.cycle_length_days, 30);
  assert.equal(result.state.cycle_day, 4);
  assert.equal(result.state.phase, 'menstrual_like');
  assert.ok(result.reason_codes.includes('cycle_manual_correction'));
  assertCycleState(result.state);
});

test('C09 边界：人工长度越界或锚点在未来 → INVALID_REQUEST', () => {
  const now = atDays(10);
  const base = { previous: makeCycle(), now, rng: provider().stream('cycle:0'), config: {} };
  assertCode(
    () => updateCycle({ ...base, inputs: { manual_cycle_length_days: 19 } }),
    'INVALID_REQUEST'
  );
  assertCode(
    () => updateCycle({ ...base, inputs: { manual_cycle_length_days: 46 } }),
    'INVALID_REQUEST'
  );
  assertCode(
    () => updateCycle({ ...base, inputs: { manual_anchor_at: atDays(11) } }),
    'INVALID_REQUEST'
  );
});

test('C10：人工校正后跑 10 个周期 → 0.95 → 0.85（下限 0.50）', () => {
  const manual = applyManualCorrection({
    cycle: makeCycle(),
    now: atDays(3),
    manual_anchor_at: START,
    manual_cycle_length_days: 30
  });
  assert.equal(manual.confidence, 0.95);

  const rngProvider = provider();
  const after10 = advanceWholeCycles(manual, 10, rngProvider);
  assert.equal(after10.confidence, 0.85);

  const after50 = advanceWholeCycles(after10, 40, rngProvider);
  assert.equal(after50.confidence, 0.5);
});

test('C11：自动置信度跑 20 个周期 → 封顶 0.90', () => {
  const rngProvider = provider();
  const after10 = advanceWholeCycles(makeCycle(), 10, rngProvider);
  assert.equal(after10.confidence, 0.8);
  const after20 = advanceWholeCycles(after10, 10, rngProvider);
  assert.equal(after20.confidence, 0.9);
  const after40 = advanceWholeCycles(after20, 20, rngProvider);
  assert.equal(after40.confidence, 0.9);
});

test('C12：离线 180 天一次推进 vs 逐小时推进，cycle_index/cycle_day/phase 完全一致', () => {
  const initial = makeCycle();

  const oneShotProvider = provider();
  const oneShot = updateCycle({
    previous: initial,
    inputs: {},
    now: atDays(180),
    rng: oneShotProvider.stream('cycle:0'),
    rngProvider: oneShotProvider,
    config: {}
  }).state;

  const hourlyProvider = provider();
  let hourly = initial;
  for (let hour = 1; hour <= 180 * 24; hour += 1) {
    const now = atHours(hour);
    const rng = hourlyProvider.stream(`cycle:${hourly.cycle_index}`);
    hourly = updateCycle({
      previous: hourly,
      inputs: {},
      now,
      rng,
      rngProvider: hourlyProvider,
      config: {}
    }).state;
  }

  assert.equal(hourly.cycle_index, oneShot.cycle_index);
  assert.equal(hourly.cycle_day, oneShot.cycle_day);
  assert.equal(hourly.phase, oneShot.phase);
});

test('C12 补充（协调器实际路径，无 rngProvider）：180 天一次推进与逐小时推进一致', () => {
  const initial = makeCycle();

  const oneShot = updateCycle({
    previous: initial,
    inputs: {},
    now: atDays(180),
    rng: provider().stream('cycle:0'),
    config: {}
  }).state;

  const hourlyProvider = provider();
  let hourly = initial;
  for (let hour = 1; hour <= 180 * 24; hour += 1) {
    const rng = hourlyProvider.stream(`cycle:${hourly.cycle_index}`);
    hourly = updateCycle({
      previous: hourly,
      inputs: {},
      now: atHours(hour),
      rng,
      config: {}
    }).state;
  }

  assert.equal(hourly.cycle_index, oneShot.cycle_index);
  assert.equal(hourly.cycle_day, oneShot.cycle_day);
  assert.equal(hourly.phase, oneShot.phase);
});

test('C12b：一次推进 65 个周期 → 粗推进并追加 CYCLE_COARSE_ROLL，耗时 <10 ms', () => {
  const probe = provider();
  let delta = L0;
  for (let i = 1; i <= 65; i += 1) delta += sampleCycleLength(i, probe);
  delta += 0.5;

  const rngProvider = provider();
  const warnings = [];
  const started = process.hrtime.bigint();
  const out = advanceCycleDays({ cycle: makeCycle(), deltaDays: delta, rngProvider, warnings });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(warnings.includes('CYCLE_COARSE_ROLL'), '缺少 CYCLE_COARSE_ROLL');
  assert.ok(out.cycle_index > 64);
  assert.ok(elapsedMs < 10, `65 个周期推进耗时 ${elapsedMs} ms`);
  assertCycleState(out);
});

test('C12c：一次推进 10 年 → 最多 64 次逐周期采样，不超时', () => {
  const rngProvider = provider();
  const warnings = [];
  const started = process.hrtime.bigint();
  const out = advanceCycleDays({
    cycle: makeCycle(),
    deltaDays: 3650,
    rngProvider,
    warnings
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(warnings.includes('CYCLE_COARSE_ROLL'));
  assert.ok(out.cycle_index > 100, `10 年应推进上百个周期，实际 ${out.cycle_index}`);
  const sampled = Object.values(rngProvider.snapshotCounters()).filter((n) => n > 0).length;
  assert.equal(sampled, MAX_CYCLE_STEPS, `最多迭代 ${MAX_CYCLE_STEPS} 次，实际 ${sampled}`);
  assert.ok(elapsedMs < 10, `10 年推进耗时 ${elapsedMs} ms`);
  assertCycleState(out);
});

test('C13-A 补充：原始逐日差（九维 phase_impact）≤ 阶段最大差 + 余量', () => {
  const RAW_MAX = {
    physical_comfort: 0.15, energy: 0.15, sensitivity: 0.15, social_drive: 0.15,
    pain_load: 0.65, anxiety_delta: 0.35, irritability_delta: 0.40,
    positive_affect_delta: 0.50, intimacy_need_delta: 0.55
  };
  let previous = null;
  for (let day = 0; day <= Math.ceil(2 * L0); day += 1) {
    const p = day / L0 % 1;
    const vector = phaseInfluence(p, L0);
    if (previous) {
      for (const key of Object.keys(vector)) {
        const rawDelta = Math.abs(vector[key] - previous[key]);
        assert.ok(rawDelta <= RAW_MAX[key] + 1e-9, `day ${day} ${key} 原始差 ${rawDelta}`);
      }
    }
    previous = vector;
  }
});

test('C14：min=23/max=35 与 sd=-1 → INVALID_REQUEST', () => {
  assertCode(
    () => sampleCycleLength(0, provider(), { cycle: { min_days: 23, max_days: 35 } }),
    'INVALID_REQUEST'
  );
  assertCode(
    () => sampleCycleLength(0, provider(), { cycle: { sd_days: -1 } }),
    'INVALID_REQUEST'
  );
  assertCode(
    () =>
      updateCycle({
        previous: makeCycle(),
        inputs: {},
        now: atDays(1),
        rng: provider().stream('cycle:0'),
        config: { cycle: { min_days: 23, max_days: 35 } }
      }),
    'INVALID_REQUEST'
  );
  assertCode(
    () =>
      advanceCycleDays({
        cycle: makeCycle(),
        deltaDays: 1,
        rngProvider: provider(),
        config: { cycle: { sd_days: -1 } }
      }),
    'INVALID_REQUEST'
  );
});

test('C15：同一 now 下 Asia/Shanghai 与 UTC 的 cycle_day/phase 完全一致', () => {
  const now = atDays(9.25);
  const run = (timezone) => {
    const rng = provider().stream('cycle:0');
    return updateCycle({
      previous: makeCycle(),
      inputs: {},
      now,
      rng,
      config: { timezone }
    }).state;
  };
  const shanghai = run('Asia/Shanghai');
  const utc = run('UTC');
  assert.equal(shanghai.cycle_day, utc.cycle_day);
  assert.equal(shanghai.phase, utc.phase);
});

test('C16：一周期内逐小时推进，phase_progress 单调不减，过界归 0', () => {
  const rngProvider = provider();
  let cycle = makeCycle();
  let previousPhase = cycle.phase;
  let previousProgress = -1;
  let resets = 0;
  for (let hour = 1; hour <= Math.floor(L0 * 24); hour += 1) {
    const now = atHours(hour);
    const rng = rngProvider.stream(`cycle:${cycle.cycle_index}`);
    const next = updateCycle({
      previous: cycle,
      inputs: {},
      now,
      rng,
      rngProvider,
      config: {}
    }).state;
    if (next.phase === previousPhase) {
      assert.ok(next.phase_progress >= previousProgress - 1e-9, `hour ${hour} progress 回退`);
    } else {
      assert.ok(next.phase_progress <= previousProgress + 1e-6, `hour ${hour} 过界未归零`);
      resets += 1;
      previousPhase = next.phase;
    }
    previousProgress = next.phase_progress;
    cycle = next;
  }
  assert.ok(resets >= 3, `一周期内应至少跨越 3 个阶段边界，实际 ${resets}`);
});

test('C17：任意时刻 cycle_day ∈ [1,34] 且 1 起算', () => {
  const rngProvider = provider();
  let cycle = makeCycle();
  for (let step = 1; step <= 2000; step += 1) {
    const now = toIso(START_MS + Math.round(step * 0.37 * MS_PER_DAY));
    const rng = rngProvider.stream(`cycle:${cycle.cycle_index}`);
    cycle = updateCycle({
      previous: cycle,
      inputs: {},
      now,
      rng,
      rngProvider,
      config: {}
    }).state;
    assert.ok(cycle.cycle_day >= 1, `day=${cycle.cycle_day}`);
    assert.ok(cycle.cycle_day <= cycle.cycle_length_days + 1e-9);
    assert.ok(cycle.cycle_day <= LIMITS.maxCycleLengthDays);
    assert.ok(CYCLE_PHASES.includes(cycle.phase));
  }
});

test('C18：合并 contributions 只含 cycle.* 键，无 mood/stress/sleep 前缀', () => {
  const results = [
    updateCycle({
      previous: makeCycle(),
      inputs: {},
      now: atDays(1),
      rng: provider().stream('cycle:0'),
      config: {}
    }),
    updateCycle({
      previous: makeCycle(),
      inputs: { manual_cycle_length_days: 30 },
      now: atDays(1),
      rng: provider().stream('cycle:0'),
      config: {}
    }),
    updateCycle({
      previous: null,
      inputs: {},
      now: START,
      rng: provider().stream('cycle:0'),
      config: {}
    })
  ];

  const merged = {};
  for (const result of results) {
    for (const [dimension, sources] of Object.entries(result.contributions)) {
      for (const [source, value] of Object.entries(sources)) {
        merged[dimension] = merged[dimension] ?? {};
        merged[dimension][source] = round6((merged[dimension][source] ?? 0) + value);
      }
    }
  }
  const keys = Object.keys(merged);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(key.startsWith('cycle.'), `非法贡献键：${key}`);
    assert.equal(key.startsWith('mood.'), false);
    assert.equal(key.startsWith('stress.'), false);
    assert.equal(key.startsWith('sleep.'), false);
  }
});

test('降级：previous 缺字段时省略整个 derived 键并追加 MISSING_CYCLE_DATA', () => {
  const cases = [
    null,
    {},
    { anchor_at: START, cycle_index: 0 },
    { ...makeCycle(), confidence: undefined },
    { ...makeCycle(), phase_progress: undefined }
  ];
  for (const previous of cases) {
    const result = updateCycle({
      previous,
      inputs: {},
      now: START,
      rng: provider().stream('cycle:0'),
      config: {}
    });
    assert.equal('derived' in result, false, '降级不得输出 derived（也不得输出全 0 占位）');
    assert.ok(result.warnings.includes('MISSING_CYCLE_DATA'));
    assertCycleState(result.state);
    assert.equal(result.state.phase, 'menstrual_like');
    assert.equal(result.state.cycle_day, 1);
  }
});

test('C2-C cycle 版本：新旧输入计算、降级输出与诊断统一为 2', () => {
  assert.equal(CYCLE_MODEL_VERSION, 2);
  for (const previousVersion of [1, 2]) {
    const previous = makeCycle({ model_version: previousVersion });
    const result = updateCycle({
      previous,
      inputs: {},
      now: atHours(1),
      rng: provider().stream('cycle:0'),
      config: {}
    });
    assert.equal(previous.model_version, previousVersion, '计算不得回写 previous 的历史版本');
    assert.equal(result.state.model_version, 2);
    assert.equal(result.diagnostics.model_version, 2);
  }

  const degraded = updateCycle({
    previous: null,
    inputs: {},
    now: START,
    rng: provider().stream('cycle:0'),
    config: {}
  });
  assert.ok(degraded.warnings.includes('MISSING_CYCLE_DATA'));
  assert.equal(degraded.state.model_version, 2);
  assert.equal(degraded.diagnostics.model_version, 2);
});

test('ModuleResult 形状：完整字段 + diagnostics 固定值 + derived 九维向量（v1.7.14 周期扩展）', () => {
  const result = updateCycle({
    previous: makeCycle(),
    inputs: {},
    now: atDays(2),
    rng: provider().stream('cycle:0'),
    config: {}
  });
  assert.deepEqual(result.diagnostics, {
    module: 'cycle',
    model_version: 2,
    interface_version: 2,
    elapsed_ms: 0
  });
  assert.ok(Array.isArray(result.reason_codes));
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.next_transition_at, null);
  assert.deepEqual(Object.keys(result.derived), ['phase_impact']);
  // C1-F01：derived.phase_impact 必须完整包含九维（键集与常量严格一致，不从测试复制清单）
  assert.deepEqual(
    Object.keys(result.derived.phase_impact).sort(),
    [...PHASE_VECTOR_KEYS_V2].sort(),
    'phase_impact 键集必须与 PHASE_VECTOR_KEYS_V2 常量完全一致'
  );
  for (const value of Object.values(result.derived.phase_impact)) {
    assert.equal(Number.isFinite(value), true);
    assert.notEqual(Object.is(value, -0), true);
  }
  // 明确断言九维数量为 9
  assert.equal(Object.keys(result.derived.phase_impact).length, 9,
    'phase_impact 必须恰好包含 9 个字段（旧四维 + 新五维）');
  // 各字段值域：pain_load ∈ [0,1]，其余 ∈ [-1,1]
  assert.ok(result.derived.phase_impact.pain_load >= 0 && result.derived.phase_impact.pain_load <= 1);
  const signedKeys = ['physical_comfort', 'energy', 'sensitivity', 'social_drive',
    'anxiety_delta', 'irritability_delta', 'positive_affect_delta', 'intimacy_need_delta'];
  for (const key of signedKeys) {
    assert.ok(result.derived.phase_impact[key] >= -1 && result.derived.phase_impact[key] <= 1,
      `${key}=${result.derived.phase_impact[key]} 越界`);
  }

  const base = createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED
  });
  const validation = validateState({ ...base, cycle: result.state });
  assert.equal(validation.ok, true, `state 校验失败：${validation.path}`);
});

test('cycleModule 导出形状：{ name, update, advanceCycleDays }', () => {
  assert.equal(cycleModule.name, 'cycle');
  assert.equal(cycleModule.update, updateCycle);
  assert.equal(cycleModule.advanceCycleDays, advanceCycleDays);
});

test('无 rngProvider 的粗推进：常数时间按 28.4 天推进并追加 CYCLE_COARSE_ROLL', () => {
  const warnings = [];
  const out = advanceCycleDays({ cycle: makeCycle(), deltaDays: 60, warnings });
  assert.ok(warnings.includes('CYCLE_COARSE_ROLL'));
  assert.ok(out.cycle_index >= 1);
  assert.ok(out.cycle_length_days === 28.4);
  assertCycleState(out);

  // 不跨周期时不应告警，也不消耗任何随机数
  const noCross = [];
  const within = advanceCycleDays({ cycle: makeCycle(), deltaDays: 1, warnings: noCross });
  assert.deepEqual(noCross, []);
  assert.equal(within.cycle_index, 0);
  assert.equal(within.cycle_day, 2);
});

test('advanceCycleDays 对损坏输入返回明确错误码', () => {
  assertCode(
    () => advanceCycleDays({ cycle: makeCycle({ cycle_day: 0 }), deltaDays: 1 }),
    'MODULE_FAILED'
  );
  assertCode(
    () => advanceCycleDays({ cycle: makeCycle(), deltaDays: -1 }),
    'INVALID_REQUEST'
  );
  assertCode(
    () =>
      updateCycle({
        previous: makeCycle({ anchor_at: atDays(2) }),
        inputs: {},
        now: atDays(1),
        rng: provider().stream('cycle:0'),
        config: {}
      }),
    'MODULE_FAILED'
  );
});
