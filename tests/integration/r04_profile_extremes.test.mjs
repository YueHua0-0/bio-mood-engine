/**
 * E-C（R04 联合极值矩阵）：四个 cycle profile 系数的合法极值组合。
 *
 * 矩阵（合法域 [0,1.5]，见 manifest.settingProblem）：
 *   X1 = (0,    0,    0,    0   )
 *   X2 = (1.5,  1.5,  1.5,  1.5 )
 *   X3 = (0,    1.5,  0,    1.5 )
 *
 * 每条组合同时跑两条路径：
 *   宿主路径：normalizeSettings → ctx.config → runAdvance → engineConfigOf → advance
 *   参考路径：直接核心 advance({ config: { timezone, cycle: { profile } } })
 * 参考路径不经过宿主规范化与 engineConfigOf，避免两条同错路径相互一致。
 *
 * 每个 tick 对完整 state 做 deepEqual；不对比较范围做预先裁剪。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { MODULE_ORDER } from '../../lib/core/constants.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

import { makeCtx, install, eventParams, T0 } from './_plugin_helpers.mjs';

const TICKS = 56;
const STEP_HOURS = 12;
const MS_PER_HOUR = 3_600_000;

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
const MODULES = Object.freeze(MODULE_ORDER.map((name) => MODULE_TABLE[name]));

const PROFILE_FIELDS = Object.freeze([
  'pain_sensitivity',
  'luteal_sensitivity',
  'mood_variability',
  'intimacy_variability'
]);

const CYCLE_BASELINE_FIELDS = Object.freeze([
  'cycle_index',
  'cycle_day',
  'cycle_length_days',
  'phase',
  'phase_progress'
]);

const CASES = Object.freeze([
  {
    id: 'X1',
    profile: { pain_sensitivity: 0, luteal_sensitivity: 0, mood_variability: 0, intimacy_variability: 0 },
    settings: {
      cyclePainSensitivity: 0,
      cycleLutealSensitivity: 0,
      cycleMoodVariability: 0,
      cycleIntimacyVariability: 0
    }
  },
  {
    id: 'X2',
    profile: {
      pain_sensitivity: 1.5,
      luteal_sensitivity: 1.5,
      mood_variability: 1.5,
      intimacy_variability: 1.5
    },
    settings: {
      cyclePainSensitivity: 1.5,
      cycleLutealSensitivity: 1.5,
      cycleMoodVariability: 1.5,
      cycleIntimacyVariability: 1.5
    }
  },
  {
    id: 'X3',
    profile: { pain_sensitivity: 0, luteal_sensitivity: 1.5, mood_variability: 0, intimacy_variability: 1.5 },
    settings: {
      cyclePainSensitivity: 0,
      cycleLutealSensitivity: 1.5,
      cycleMoodVariability: 0,
      cycleIntimacyVariability: 1.5
    }
  }
]);

function atStep(step) {
  return new Date(Date.parse(T0) + step * STEP_HOURS * MS_PER_HOUR).toISOString();
}

/** 宿主真实链路：设置 → 规范化 → install → observe → 56 次 tick。 */
async function hostSequence(settings) {
  const h = makeCtx({ config: settings });
  const { tools } = install(h.ctx);
  const first = await tools.observe(eventParams());
  assert.equal(first.ok, true, 'observe 必须成功');
  const states = [h.storage.json('state')];
  for (let step = 1; step <= TICKS; step += 1) {
    const tick = await tools.tick({ now: atStep(step) });
    assert.equal(tick.ok, true, `tick ${step} 必须成功，实际 ${tick.code ?? 'unknown'}`);
    states.push(h.storage.json('state'));
  }
  return { h, states };
}

/** 独立核心参考：直接调用 advance，配置只含 timezone 与显式 cycle.profile。 */
function referenceSequence(initialState, profile) {
  let state = structuredClone(initialState);
  const states = [structuredClone(state)];
  for (let step = 1; step <= TICKS; step += 1) {
    const result = advance({
      state,
      event: null,
      now: atStep(step),
      rngProvider: RandomProvider.fromPersisted({
        random: state.random,
        character_id: state.character_id
      }),
      config: { timezone: state.timezone, cycle: { profile } },
      modules: MODULES
    });
    state = result.state;
    states.push(structuredClone(state));
  }
  return states;
}

let defaultHostCache = null;
async function defaultHostSequence() {
  if (!defaultHostCache) defaultHostCache = hostSequence({});
  return defaultHostCache;
}

function assertFiniteTree(value, path = 'state') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} 必须是有限数值，实际 ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFiniteTree(item, `${path}.${key}`);
  }
}

function assertContractRange(state, label) {
  assertFiniteTree(state, label);
  for (const [key, value] of Object.entries(state.mood)) {
    if (key === 'model_version') continue;
    assert.ok(value >= 0 && value <= 1, `${label}.mood.${key} 超出 [0,1]，实际 ${value}`);
  }
  const cycle = state.cycle;
  assert.ok(
    cycle.cycle_length_days >= 24 && cycle.cycle_length_days <= 34,
    `${label}.cycle.cycle_length_days 超出 [24,34]，实际 ${cycle.cycle_length_days}`
  );
  assert.ok(
    cycle.cycle_day >= 1 && cycle.cycle_day <= cycle.cycle_length_days,
    `${label}.cycle.cycle_day 超出 [1,length]，实际 ${cycle.cycle_day}`
  );
  assert.ok(
    cycle.phase_progress >= 0 && cycle.phase_progress < 1,
    `${label}.cycle.phase_progress 超出 [0,1)，实际 ${cycle.phase_progress}`
  );
}

async function assertJointExtreme(item) {
  const { id, settings, profile } = item;
  const host = await hostSequence(settings);
  const baseline = await defaultHostSequence();
  const reference = referenceSequence(host.states[0], profile);

  assert.equal(
    host.h.logs.some((entry) => entry.code === 'FASTCFG_INVALID'),
    false,
    `${id} 的合法极值不得触发 FASTCFG_INVALID`
  );

  const persisted = String(host.h.storage.raw('cfg') ?? '');
  for (const field of PROFILE_FIELDS) {
    assert.equal(persisted.includes(field), false, `${id} 不得把 ${field} 写入持久化 cfg`);
  }
  assert.equal(persisted.includes('"profile"'), false, `${id} 不得把 profile 对象写入持久化 cfg`);

  for (let step = 0; step <= TICKS; step += 1) {
    assert.deepEqual(
      host.states[step],
      reference[step],
      `${id} 第 ${step} tick 的完整 state 必须与独立核心参考一致`
    );
    for (const field of CYCLE_BASELINE_FIELDS) {
      assert.deepEqual(
        host.states[step].cycle[field],
        baseline.states[step].cycle[field],
        `${id} 第 ${step} tick 的 cycle.${field} 不得受 profile 影响`
      );
    }
    assertContractRange(host.states[step], `${id} tick ${step}`);
  }
}

test('E-C X1 全最小极值 (0,0,0,0) 与独立核心参考逐 tick 全 state 一致', async () => {
  await assertJointExtreme(CASES[0]);
});

test('E-C X2 全最大极值 (1.5,1.5,1.5,1.5) 与独立核心参考逐 tick 全 state 一致', async () => {
  await assertJointExtreme(CASES[1]);
});

test('E-C X3 交替极值 (0,1.5,0,1.5) 与独立核心参考逐 tick 全 state 一致', async () => {
  await assertJointExtreme(CASES[2]);
});
