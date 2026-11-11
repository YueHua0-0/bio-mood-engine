/**
 * T19：`ModuleResult` 形状快照 + `diagnostics.interface_version` + `next_transition_at` 合法性。
 * T21：装配契约镜像（`tests/fixtures/assembly.shape.json` ↔ 05–11 §4.2 字段表）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONTRACT_VERSION,
  MODULE_ORDER
} from '../../lib/core/constants.mjs';
import { advance, runPipeline } from '../../lib/core/coordinator.mjs';
import { parseTime } from '../../lib/core/clock.mjs';
import { stateFingerprint } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { fixedClock, isoAfter } from '../helpers/clock.mjs';
import { makeState } from '../helpers/state.mjs';

const SHAPE = JSON.parse(
  readFileSync(new URL('../fixtures/assembly.shape.json', import.meta.url), 'utf8')
);
const REAL_MODULES = Object.freeze({
  cycle: cycleModule,
  sleep: sleepModule,
  stress: stressModule,
  event: eventModule,
  regulation: regulationModule,
  mood: moodModule,
  behavior: behaviorModule,
  delivery: deliveryModule
});
const ALLOWED_DERIVED = new Set(['phase_impact', 'event_intensity']);
const RESULT_KEYS = [
  'state',
  'contributions',
  'reason_codes',
  'warnings',
  'next_transition_at',
  'diagnostics'
];

function assertModuleResult(name, result, now) {
  const keys = Object.keys(result);
  for (const key of RESULT_KEYS) {
    assert.ok(keys.includes(key), `${name} 缺少 ModuleResult.${key}`);
  }
  for (const key of keys) {
    assert.ok(
      RESULT_KEYS.includes(key) || key === 'derived',
      `${name} 出现未声明字段 ${key}`
    );
  }
  assert.equal(result.diagnostics.module, name, `${name}.diagnostics.module 不符`);
  assert.equal(result.diagnostics.interface_version, 1, `${name}.diagnostics.interface_version 必须为 1`);
  assert.equal(Number.isInteger(result.diagnostics.model_version), true, `${name}.diagnostics.model_version 必须是整数`);
  assert.equal(typeof result.diagnostics.elapsed_ms, 'number', `${name}.diagnostics.elapsed_ms 必须是数字`);
  assert.ok(Array.isArray(result.reason_codes), `${name}.reason_codes 必须是数组`);
  assert.ok(Array.isArray(result.warnings), `${name}.warnings 必须是数组`);
  assert.ok(result.contributions && typeof result.contributions === 'object', `${name}.contributions 必须是对象`);
  if ('derived' in result) {
    for (const key of Object.keys(result.derived)) {
      assert.ok(ALLOWED_DERIVED.has(key), `${name}.derived.${key} 不在 00 §4.2 白名单`);
    }
  }
  if (result.next_transition_at !== null) {
    const hint = parseTime(result.next_transition_at, `${name}.next_transition_at`);
    const current = parseTime(now, 'now');
    assert.ok(hint > current, `${name}.next_transition_at 必须晚于 now`);
    assert.ok(hint <= current + 3_600_000, `${name}.next_transition_at 不得超过 now+1h`);
  }
}

test('T19 模块形状：8 个模块的真实返回值均符合 ModuleResult 快照', () => {
  const state = makeState();
  const now = isoAfter(state.last_tick_at, 300);
  const seen = new Map();
  const wrapped = MODULE_ORDER.map((name) => ({
    name,
    update(params) {
      const result = REAL_MODULES[name].update(params);
      assertModuleResult(name, result, now);
      seen.set(name, result);
      return result;
    }
  }));
  const out = advance({
    state,
    event: null,
    now,
    rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
    modules: wrapped
  });
  assert.deepEqual([...seen.keys()].sort(), [...MODULE_ORDER].sort(), '8 个模块必须全部执行');
  assert.deepEqual(Object.keys(out.diagnostics.module_ms).sort(), [...MODULE_ORDER].sort());
  assert.equal(out.state.state_version, state.state_version + 1);
});

function stubModule(name, overrides) {
  return {
    name,
    update({ previous }) {
      return {
        state: { ...previous },
        contributions: {},
        reason_codes: [],
        warnings: [],
        next_transition_at: null,
        diagnostics: { module: name, model_version: 1, interface_version: 1, elapsed_ms: 0 },
        ...overrides
      };
    }
  };
}

function runWithHint(hint, now) {
  const state = makeState();
  return advance({
    state,
    event: null,
    now,
    rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
    modules: [stubModule('mood', { next_transition_at: hint })]
  });
}

test('T19 非法 next_transition_at：过去 / 格式错误 / 超过 now+1h 均被忽略且不死循环', () => {
  const state = makeState();
  const now = isoAfter(state.last_tick_at, 600);
  const past = isoAfter(now, -60);
  const bad = '2026-11-09 17:30';
  const tooFar = isoAfter(now, 7200);
  for (const hint of [past, bad, tooFar]) {
    const out = runWithHint(hint, now);
    assert.ok(
      out.diagnostics.warnings.includes('INVALID_TRANSITION_HINT'),
      `提示 ${hint} 未被忽略`
    );
    assert.equal(out.state.state_version, state.state_version + 1);
    assert.equal(out.state.last_tick_at, now);
  }
});

test('T19 derived 白名单外的键被忽略并追加 UNKNOWN_DERIVED_KEY，不视为形状错误', () => {
  const state = makeState();
  const now = isoAfter(state.last_tick_at, 60);
  const out = advance({
    state,
    event: null,
    now,
    rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
    modules: [stubModule('cycle', { derived: { unknown_metric: 1 } })]
  });
  assert.ok(out.diagnostics.warnings.includes('UNKNOWN_DERIVED_KEY'));
  assert.equal(out.state.state_version, state.state_version + 1);
});

const PHASE_VECTOR = Object.freeze({
  physical_comfort: 0.42,
  energy: 0.42,
  sensitivity: 0.62,
  social_drive: 0.42
});
const EVENT = Object.freeze({
  event_id: 'evt_20261109_shape001',
  event_type: 'direct_question',
  occurred_at: '2026-11-09T09:19:00.000Z',
  intensity: 0.72,
  source: {
    platform: 'wechat',
    conversation_id: 'conv_shape_1',
    sender_id: 'sender_shape_1',
    is_mentioned: true
  }
});
const DERIVED_INTENSITY = 0.66;

function captureInputs() {
  const captured = {};
  const handlers = {
    cycle: ({ previous, inputs }) => {
      captured.cycle = inputs;
      return stubModule('cycle', { state: { ...previous }, derived: { phase_impact: PHASE_VECTOR } }).update({
        previous
      });
    },
    sleep: ({ previous, inputs }) => {
      captured.sleep = inputs;
      return stubModule('sleep', { state: { ...previous } }).update({ previous });
    },
    stress: ({ previous, inputs }) => {
      captured.stress = inputs;
      return stubModule('stress', { state: { ...previous } }).update({ previous });
    },
    event: ({ previous, inputs }) => {
      captured.event = inputs;
      return stubModule('event', {
        state: { ...previous },
        derived: { event_intensity: DERIVED_INTENSITY }
      }).update({ previous });
    },
    regulation: ({ previous, inputs }) => {
      captured.regulation = inputs;
      return stubModule('regulation', { state: { ...previous } }).update({ previous });
    },
    mood: ({ previous, inputs }) => {
      captured.mood = inputs;
      return stubModule('mood', { state: { ...previous } }).update({ previous });
    },
    behavior: ({ inputs }) => {
      captured.behavior = inputs;
      return stubModule('behavior', {
        state: { verbosity_bias: 'normal', affection_expression: 'normal' }
      }).update({ previous: {} });
    },
    delivery: ({ inputs }) => {
      captured.delivery = inputs;
      return stubModule('delivery', { state: { policy: 'deliver_now' } }).update({ previous: {} });
    }
  };
  const state = makeState();
  runPipeline({
    draft: state,
    event: EVENT,
    now: state.last_tick_at,
    rngProvider: RandomProvider.fromPersisted({
      random: state.random,
      character_id: state.character_id
    }),
    modules: MODULE_ORDER.map((name) => ({ name, update: handlers[name] })),
    queue: []
  });
  return captured;
}

test('T21 装配镜像：assembly.shape.json 与 8 个模块的 inputs 键集完全一致', () => {
  const captured = captureInputs();
  assert.match(SHAPE.contract, /v1\.\d+\.\d+/, 'fixture 必须带契约版本');
  assert.ok(SHAPE.contract.includes(CONTRACT_VERSION), 'assembly.shape.json 的契约版本必须与 CONTRACT_VERSION 同步');
  assert.deepEqual(Object.keys(SHAPE.modules).sort(), [...MODULE_ORDER].sort(), 'fixture 模块集必须等于 MODULE_ORDER');
  for (const name of MODULE_ORDER) {
    const spec = SHAPE.modules[name];
    const inputs = captured[name];
    assert.ok(inputs, `未捕获 ${name}.inputs`);
    assert.deepEqual(Object.keys(inputs).sort(), [...spec.keys].sort(), `${name} inputs 顶层键集不一致`);
    for (const nested of spec.nested ?? []) {
      const target = nested.path.split('.').reduce((node, key) => node?.[key], inputs);
      assert.ok(target && typeof target === 'object', `${name}.${nested.path} 缺失`);
      const optional = new Set(nested.optional ?? []);
      const actual = Object.keys(target).filter((key) => !optional.has(key)).sort();
      assert.deepEqual(actual, [...nested.keys].sort(), `${name}.${nested.path} 键集不一致`);
    }
  }
  assert.equal(stateFingerprint(makeState()), stateFingerprint(makeState()), 'fixture 派生状态必须可重复');
});
