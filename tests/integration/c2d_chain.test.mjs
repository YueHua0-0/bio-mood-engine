/**
 * C2-D：真实链路九维周期链路测试。
 *
 * 覆盖：cycle 模块产出九维 phase_impact → coordinator 装配 → mood 消费 → 状态写回 → 诊断聚合。
 * 仅验证既有契约在真实链路中成立；不修改生产代码。
 *
 * 链路入口：advance()（与生产 handler 使用同一组真实模块，按 MODULE_ORDER 装配）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOOD_KEYS,
  MODULE_ORDER,
  MOOD_MODEL_VERSION,
  PHASE_VECTOR_KEYS_V2
} from '../../lib/core/constants.mjs';
import { createDefaultState, round6, validateState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { alphaFor } from '../../lib/modules/mood/inertia.mjs';
import { cycleTerms } from '../../lib/modules/mood/contributions.mjs';
import { FLOATS_PER_TICK } from '../../lib/modules/mood/noise.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

import { CHARACTER_ID, MASTER_SEED } from '../unit/_random_vectors.mjs';
import { loadValidState } from '../helpers/state.mjs';

const HOUR_MS = 3_600_000;
/** fixture last_tick_at = 2026-11-09T04:48:00.000Z，+1h 恰好一个 3600s chunk。 */
const NOW = '2026-11-09T05:48:00.000Z';
const CHUNK_SECONDS = 3600;

/** 与 lib/api/handler.mjs 的 MODULE_TABLE 同构（该表未导出，D0 守卫防漂移）。 */
const MODULE_TABLE = Object.freeze({
  cycle: cycleModule,
  sleep: sleepModule,
  stress: stressModule,
  event: eventModule,
  regulation: regulationModule,
  mood: moodModule,
  behavior: behaviorModule,
  delivery: deliveryModule
});

/**
 * 按 MODULE_ORDER 装配真实模块。
 * capture 非空时，mood 用透明包装记录实收 args（原样转发、原样返回）。
 */
function realModules(capture = null) {
  return MODULE_ORDER.map((name) => {
    if (name === 'mood' && capture) {
      return {
        name: 'mood',
        update: (args) => {
          capture.push(args);
          return moodModule.update(args);
        }
      };
    }
    return MODULE_TABLE[name];
  });
}

function providerFor(state) {
  return RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
}

function runChain(state, { capture = null, now = NOW, modules = null } = {}) {
  return advance({
    state,
    event: null,
    now,
    rngProvider: providerFor(state),
    config: {},
    modules: modules ?? realModules(capture)
  });
}

function moodStreamCounter(state) {
  return state.random.streams.mood.counter;
}

function cycleContrib(diagnostics, dim) {
  return diagnostics.contributions[`mood.${dim}`].cycle;
}

// ---------------------------------------------------------------------------
// D0：装配一致性守卫
// ---------------------------------------------------------------------------
test('C2-D D0：按 MODULE_ORDER 装配的模块序列与真实模块表一致', () => {
  const modules = realModules();
  assert.deepEqual(modules.map((m) => m.name), [...MODULE_ORDER]);
  assert.equal(modules.length, 8);
  for (const module of modules) {
    assert.equal(typeof module.update, 'function', `${module.name} 必须有 update`);
  }
  assert.equal(MODULE_TABLE.mood, moodModule);
});

// ---------------------------------------------------------------------------
// D1：上游周期模块实际产出九维 phase_impact
// ---------------------------------------------------------------------------
test('C2-D D1：真实 cycle 模块产出九维 phase_impact（键集/取值域）', () => {
  const state = loadValidState();
  const result = cycleModule.update({
    previous: state.cycle,
    inputs: {},
    now: NOW,
    rng: providerFor(state).stream('cycle'),
    config: {}
  });

  assert.ok(result.derived, '正常路径必须携带 derived');
  const vector = result.derived.phase_impact;
  assert.deepEqual(Object.keys(vector).sort(), [...PHASE_VECTOR_KEYS_V2].sort());
  assert.equal(Object.keys(vector).length, 9);

  for (const key of PHASE_VECTOR_KEYS_V2) {
    assert.equal(typeof vector[key], 'number', `${key} 必须是原始 number`);
    assert.ok(Number.isFinite(vector[key]), `${key} 必须有限`);
  }
  assert.ok(vector.pain_load >= 0 && vector.pain_load <= 1, `pain_load 越界: ${vector.pain_load}`);
  for (const key of PHASE_VECTOR_KEYS_V2) {
    if (key === 'pain_load') continue;
    assert.ok(vector[key] >= -1 && vector[key] <= 1, `${key} 越界: ${vector[key]}`);
  }
});

// ---------------------------------------------------------------------------
// D2：coordinator 装配层原样透传
// ---------------------------------------------------------------------------
test('C2-D D2：mood 实收 phase_vector 与 cycle 产出逐键相等（装配层透传）', () => {
  const state = loadValidState();
  const capture = [];
  const out = runChain(state, { capture });

  assert.equal(capture.length, 1, '1h 推进应恰好调用一次 mood');
  const received = capture[0].inputs.cycle.phase_vector;
  assert.deepEqual(Object.keys(received).sort(), [...PHASE_VECTOR_KEYS_V2].sort());

  const expected = cycleModule.update({
    previous: state.cycle,
    inputs: {},
    now: NOW,
    rng: providerFor(state).stream('cycle'),
    config: {}
  }).derived.phase_impact;

  for (const key of PHASE_VECTOR_KEYS_V2) {
    assert.equal(received[key], expected[key], `${key} 透传值被改写`);
  }
  assert.equal(typeof capture[0].inputs.cycle.scalars.cycle_sensitivity, 'number');
  assert.equal(capture[0].inputs.dt, CHUNK_SECONDS);
  assert.equal(out.state.mood.model_version, MOOD_MODEL_VERSION);
});

// ---------------------------------------------------------------------------
// D3：mood 真实消费九维并生成周期贡献（输入贡献，不是最终状态变化）
// ---------------------------------------------------------------------------
test('C2-D D3：28 天真实推进中 cycle 贡献与 cycleTerms×alpha 精确一致（含方向性）', () => {
  const DAYS = 28;
  let cursor = loadValidState();
  const startMs = Date.parse(NOW);
  const samples = [];

  for (let i = 0; i < 24 * DAYS; i += 1) {
    const capture = [];
    const now = new Date(startMs + i * HOUR_MS).toISOString();
    const out = runChain(cursor, { capture, now });
    const args = capture[0];

    samples.push({
      phase: out.state.cycle.phase,
      vector: args.inputs.cycle.phase_vector,
      sensitivity: args.inputs.cycle.scalars.cycle_sensitivity,
      dt: args.inputs.dt,
      diagnostics: out.diagnostics
    });
    cursor = out.state;
  }

  assert.equal(samples.length, 24 * DAYS);

  let strongPainSeen = 0;
  let positiveIntimacySeen = 0;

  for (const sample of samples) {
    const { vector, sensitivity, dt, diagnostics, phase } = sample;
    const raw = cycleTerms(vector, sensitivity);

    for (const dim of MOOD_KEYS) {
      const alpha = alphaFor(dim, dt);
      const expected = round6(raw[dim] * alpha);
      const actual = cycleContrib(diagnostics, dim);
      assert.equal(
        actual,
        expected,
        `${phase} ${dim} 链路不一致：vector=${JSON.stringify(vector)}` +
          ` raw=${raw[dim]} alpha=${alpha} expected=${expected} actual=${actual}`
      );
    }

    // 方向性：仅使用契约已确认的映射，不对 stability 追加 pain_load 假设。
    if (vector.pain_load > 1e-9) {
      // pain_load → physical_comfort(-0.20) / energy(-0.10)
      if (vector.pain_load >= 0.3) {
        strongPainSeen += 1;
        assert.ok(
          cycleContrib(diagnostics, 'physical_comfort') < 0,
          `${phase} pain_load=${vector.pain_load} 时 physical_comfort 周期贡献应为负`
        );
        assert.ok(
          cycleContrib(diagnostics, 'energy') < 0,
          `${phase} pain_load=${vector.pain_load} 时 energy 周期贡献应为负`
        );
      }
    }
    if (vector.intimacy_need_delta > 1e-9) {
      positiveIntimacySeen += 1;
      assert.ok(
        cycleContrib(diagnostics, 'closeness_need') > 0,
        `${phase} intimacy_need_delta=${vector.intimacy_need_delta} 时 closeness_need 周期贡献应为正`
      );
    }
  }

  // 覆盖率守卫：确认断言没有被“恰好未触发”而空转。
  assert.ok(strongPainSeen > 0, '28 天推进必须覆盖 pain_load >= 0.3 的相位');
  assert.ok(positiveIntimacySeen > 0, '28 天推进必须覆盖 intimacy_need_delta > 0 的相位');
  assert.deepEqual(
    [...new Set(samples.map((s) => s.phase))].sort(),
    ['follicular_like', 'luteal_like', 'menstrual_like', 'ovulatory_like']
  );
});

// ---------------------------------------------------------------------------
// D4：状态写回与版本
// ---------------------------------------------------------------------------
test('C2-D D4：真实写回后 mood 状态键集完整、版本为 2', () => {
  const out = runChain(loadValidState());
  const mood = out.state.mood;

  assert.equal(mood.model_version, 2);
  assert.deepEqual(
    Object.keys(mood).sort(),
    [...MOOD_KEYS, 'model_version'].sort()
  );
  for (const key of MOOD_KEYS) {
    assert.ok(Number.isFinite(mood[key]), `${key} 必须有限`);
    assert.ok(mood[key] >= 0 && mood[key] <= 1, `${key} 越界: ${mood[key]}`);
    assert.equal(Object.is(mood[key], -0), false, `${key} 不得为 -0`);
  }
});

// ---------------------------------------------------------------------------
// D5：缺失输入降级（真实 cycle 不可用路径）
// ---------------------------------------------------------------------------
test('C2-D D5：cycle 不可用 → mood 收到无 phase_vector，周期贡献全 0 且状态合法', () => {
  const state = loadValidState();
  state.cycle.anchor_at = null; // 触发真实 isUsable() === false → degradedResult（无 derived）

  let captured = null;
  const out = runChain(state, { capture: { push: (args) => { captured = args; } } });

  assert.equal(captured.inputs.cycle?.phase_vector, undefined, '降级路径不应注入 phase_vector');
  assert.ok(out.diagnostics.warnings.includes('MISSING_CYCLE_DATA'));

  // 降级向量按全零处理：八个 phase_vector 驱动维度周期贡献必须为 0。
  const zeroVector = Object.fromEntries(PHASE_VECTOR_KEYS_V2.map((key) => [key, 0]));
  const expected = cycleTerms(zeroVector, captured.inputs.cycle.scalars.cycle_sensitivity);
  for (const key of MOOD_KEYS) {
    const alpha = alphaFor(key, captured.inputs.dt);
    assert.equal(
      cycleContrib(out.diagnostics, key),
      round6(expected[key] * alpha),
      `${key} 降级周期贡献不符合全零向量语义`
    );
  }
  // cycleTerms 的 stability 项只依赖 cycle_sensitivity（C2-B 冻结旧语义），不来自 phase_vector。
  for (const key of ['physical_comfort', 'energy', 'sensitivity', 'social_drive', 'closeness_need']) {
    assert.equal(cycleContrib(out.diagnostics, key), 0, `${key} 降级时必须为 0`);
  }
  assert.equal(out.state.mood.model_version, 2);
  for (const key of MOOD_KEYS) {
    assert.ok(Number.isFinite(out.state.mood[key]));
    assert.ok(out.state.mood[key] >= 0 && out.state.mood[key] <= 1);
  }
});

// ---------------------------------------------------------------------------
// D6：异常输入归属（越界 phase_vector 必须 MODULE_FAILED / module=mood）
// ---------------------------------------------------------------------------
test('C2-D D6：链路内越界 phase_vector → MODULE_FAILED 且归属 mood，入参不被修改', () => {
  const state = loadValidState();
  const snapshot = structuredClone(state);

  const poisoned = MODULE_ORDER.map((name) => {
    if (name !== 'cycle') return MODULE_TABLE[name];
    return {
      name: 'cycle',
      update: (args) => {
        const result = cycleModule.update(args);
        if (!result.derived?.phase_impact) return result;
        return {
          ...result,
          derived: {
            ...result.derived,
            phase_impact: { ...result.derived.phase_impact, energy: 1.5 }
          }
        };
      }
    };
  });

  assert.throws(
    () => runChain(state, { modules: poisoned }),
    (err) => {
      assert.equal(err.code, 'MODULE_FAILED');
      assert.equal(err.details?.module, 'mood');
      return true;
    }
  );
  assert.deepEqual(state, snapshot, '失败推进不得就地修改入参 state');
});

// ---------------------------------------------------------------------------
// D7：随机流行为（各路径的实际消耗）
// ---------------------------------------------------------------------------
test('C2-D D7：正常与降级路径每次 mood 调用均固定消耗 FLOATS_PER_TICK 个随机数', () => {
  const normal = loadValidState();
  const normalCalls = [];
  const beforeNormal = moodStreamCounter(normal);
  const normalOut = runChain(normal, { capture: normalCalls });
  const normalDelta = moodStreamCounter(normalOut.state) - beforeNormal;
  assert.equal(normalCalls.length, 1);
  assert.equal(normalDelta, normalCalls.length * FLOATS_PER_TICK);

  const degraded = loadValidState();
  degraded.cycle.anchor_at = null;
  const degradedCalls = [];
  const beforeDegraded = moodStreamCounter(degraded);
  const degradedOut = runChain(degraded, { capture: degradedCalls });
  const degradedDelta = moodStreamCounter(degradedOut.state) - beforeDegraded;
  assert.equal(degradedCalls.length, 1);
  assert.equal(degradedDelta, degradedCalls.length * FLOATS_PER_TICK);
});

// ---------------------------------------------------------------------------
// D8：九维链路确定性
// ---------------------------------------------------------------------------
test('C2-D D8：九维链路同输入两次推进结果完全一致', () => {
  const first = runChain(loadValidState());
  const second = runChain(loadValidState());

  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.diagnostics.contributions, second.diagnostics.contributions);
  assert.deepEqual(first.diagnostics.warnings, second.diagnostics.warnings);
});

// ---------------------------------------------------------------------------
// D9：写回合法性、版本隔离
// ---------------------------------------------------------------------------
test('C2-D D9：写回状态通过 validateState，且版本升级不外溢到其他模块', () => {
  const fixtureOut = runChain(loadValidState());
  assert.doesNotThrow(() => validateState(fixtureOut.state));
  assert.equal(fixtureOut.state.mood.model_version, 2);
  // cycle / mood 的旧状态进入当前九维计算后均升级为 v2；其他模块版本不外溢。
  assert.equal(fixtureOut.state.cycle.model_version, 2);
  assert.equal(fixtureOut.state.stress.model_version, 1);
  assert.equal(fixtureOut.state.regulation.model_version, 1);

  const fresh = createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: NOW,
    master_seed_hex: MASTER_SEED
  });
  const defaultOut = runChain(fresh, { now: new Date(Date.parse(NOW) + HOUR_MS).toISOString() });
  assert.doesNotThrow(() => validateState(defaultOut.state));
  assert.equal(defaultOut.state.cycle.model_version, 2);
  assert.equal(defaultOut.state.mood.model_version, MOOD_MODEL_VERSION);
});
