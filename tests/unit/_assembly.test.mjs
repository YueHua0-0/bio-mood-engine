/**
 * 装配契约测试（G1 裁决的建议项）。
 *
 * 02 的 buildInputs 是对 05–11 各 §4.2 字段表的"手工翻译"；每接入一个模块都可能漂一次。
 * 本测试用 tests/fixtures/assembly.shape.json 固化字段表：
 * - 顶层键集必须完全相等（缺字段 / 多字段都失败）；
 * - nested 声明的子对象逐层做同样的断言；
 * - optional 列出的键允许缺省，但缺省时不得出现在键集里。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MASTER_SEED } from './_random_vectors.mjs';
import { moduleOf, result } from './_stubs.mjs';

import { CONTRACT_VERSION, CYCLE_SCALARS, MODULE_ORDER } from '../../lib/core/constants.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { runPipeline } from '../../lib/core/coordinator.mjs';

const START = '2026-11-09T08:00:00.000Z';
const SHAPE = JSON.parse(readFileSync(new URL('../fixtures/assembly.shape.json', import.meta.url), 'utf8'));
const PHASE_VECTOR = Object.freeze({
  physical_comfort: 0.42,
  energy: 0.42,
  sensitivity: 0.62,
  social_drive: 0.42
});
const EVENT = Object.freeze({
  event_id: 'evt_20261109_asm00001',
  event_type: 'direct_question',
  occurred_at: '2026-11-09T07:59:00.000Z',
  intensity: 0.72,
  source: {
    platform: 'wechat',
    conversation_id: 'conv_asm_1',
    sender_id: 'sender_asm_1',
    is_mentioned: true
  }
});
/** 07 的最终强度（含倍率/@/bonus），故意与原始 event.intensity 不同，用于锁定"转发自 derived"。 */
const DERIVED_INTENSITY = 0.66;

function modulesFor(captured, { withPhaseImpact }) {
  const handlers = {
    cycle: ({ previous, inputs }) => {
      captured.cycle = inputs;
      const overrides = withPhaseImpact ? { derived: { phase_impact: { ...PHASE_VECTOR } } } : {};
      return result('cycle', { ...previous }, overrides);
    },
    sleep: ({ previous, inputs }) => {
      captured.sleep = inputs;
      return result('sleep', { ...previous });
    },
    stress: ({ previous, inputs }) => {
      captured.stress = inputs;
      return result('stress', { ...previous });
    },
    event: ({ previous, inputs }) => {
      captured.event = inputs;
      // 07 的 applyEvent 是 derived.event_intensity 的唯一输出点。
      return result('event', { ...previous }, { derived: { event_intensity: DERIVED_INTENSITY } });
    },
    regulation: ({ previous, inputs }) => {
      captured.regulation = inputs;
      return result('regulation', { ...previous });
    },
    mood: ({ previous, inputs }) => {
      captured.mood = inputs;
      (captured.moodCalls ??= []).push(inputs);
      return result('mood', { ...previous });
    },
    behavior: ({ inputs }) => {
      captured.behavior = inputs;
      return result('behavior', { verbosity_bias: 'normal', affection_expression: 'normal' });
    },
    delivery: ({ inputs }) => {
      captured.delivery = inputs;
      return result('delivery', { policy: 'deliver_now' });
    }
  };
  return MODULE_ORDER.map((name) => moduleOf(name, handlers[name]));
}

function runAssembly({ withPhaseImpact, now = START, dtSeconds = 0 }) {
  const state = createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED
  });
  // 装配用例针对"已初始化"状态：避免 advance 的 default 残留断言干扰输入形状检查。
  state.cycle = { ...state.cycle, cycle_length_source: 'sampled' };
  const captured = {};
  const rngProvider = RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
  const out = runPipeline({
    draft: state,
    event: EVENT,
    now,
    rngProvider,
    modules: modulesFor(captured, { withPhaseImpact }),
    queue: [],
    dtSeconds
  });
  return { state: out.state, captured };
}

function assertKeysExact(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} 键集不一致`);
}

function assertAssembly(captured) {
  for (const name of MODULE_ORDER) {
    const spec = SHAPE.modules[name];
    assert.ok(spec, `fixture 缺少模块 ${name}`);
    const inputs = captured[name];
    assert.ok(inputs && typeof inputs === 'object', `未捕获 ${name} 的 inputs`);
    assertKeysExact(Object.keys(inputs), spec.keys, `${name} inputs`);
    for (const nested of spec.nested ?? []) {
      const target = nested.path.split('.').reduce((node, key) => node?.[key], inputs);
      assert.ok(target && typeof target === 'object', `${name}.${nested.path} 缺失`);
      const optional = new Set(nested.optional ?? []);
      assertKeysExact(
        Object.keys(target).filter((key) => !optional.has(key)),
        nested.keys,
        `${name}.${nested.path}`
      );
    }
  }
}

test('装配契约：8 个模块的 inputs 与 05–11 §4.2 字段表逐层一致', () => {
  const { captured } = runAssembly({ withPhaseImpact: true });
  assertAssembly(captured);
  assert.deepEqual(captured.mood.cycle.phase_vector, PHASE_VECTOR);
});

test('装配契约：05 降级（无 derived）时 phase_vector 整键省略且不平铺到顶层', () => {
  const { captured } = runAssembly({ withPhaseImpact: false });
  assertAssembly(captured);
  assert.equal('phase_vector' in captured.mood.cycle, false);
  assert.equal(captured.mood.phase_vector, undefined);
  // 降级只影响向量，scalars 仍须存在（09 §5.2 的 stability 项依赖它）
  assert.equal(typeof captured.mood.cycle.scalars.cycle_sensitivity, 'number');
});

test('I-1：delivery 的 inputs.sleep 四项齐全，睡眠交付链路不走 MISSING_SLEEP_DATA', () => {
  const { state, captured } = runAssembly({ withPhaseImpact: true });
  assert.deepEqual(captured.delivery.sleep, {
    state: state.sleep.state,
    sleepiness: state.sleep.sleepiness,
    sleep_debt: state.sleep.sleep_debt,
    planned_wake_at: state.sleep.planned_wake_at
  });
  assert.deepEqual(captured.delivery.queue, { pending: [] });
  assert.equal(captured.delivery.event.is_mentioned, true);
  assert.equal(captured.delivery.event.conversation_id, 'conv_asm_1');
});

test('I-2：mood 的 cycle.scalars.cycle_sensitivity 取 08 §5.1 冻结表', () => {
  const { state, captured } = runAssembly({ withPhaseImpact: true });
  assert.equal(
    captured.mood.cycle.scalars.cycle_sensitivity,
    CYCLE_SCALARS[state.cycle.phase].cycle_sensitivity
  );
});

test('I-2：事件严重度只经 inputs.event.intensity 传入，不平铺 event 字段', () => {
  const { captured } = runAssembly({ withPhaseImpact: true });
  assert.deepEqual(captured.mood.event, { intensity: DERIVED_INTENSITY });
  assert.equal(captured.mood.event.event_type, undefined);
});

test('装配：07 输出 derived.event_intensity 时，09 的 inputs.event.intensity 等于它', () => {
  const { captured } = runAssembly({ withPhaseImpact: true });
  assert.equal(captured.mood.event.intensity, DERIVED_INTENSITY);
  assert.notEqual(captured.mood.event.intensity, EVENT.intensity, '不得回退到原始 event.intensity');
});

test('09 装配：02 把本步 dt 原样传给 mood（不是 chunk 上限）', () => {
  const { captured } = runAssembly({ withPhaseImpact: true, dtSeconds: 600 });
  assert.deepEqual(captured.moodCalls.map((inputs) => inputs.dt), [600]);
  assert.equal(Number.isInteger(captured.mood.dt), true, 'dt 必须是整数秒');
});

test('09 装配：mood 只声明 §4.2 字段，不出现 inputs.mood / 顶层 phase_vector', () => {
  const { captured } = runAssembly({ withPhaseImpact: true });
  assert.equal(captured.mood.dt, 0, '未传入 dt 时为 0');
  assert.equal('mood' in captured.mood, false, '09 §4.2 已移除 inputs.mood');
  assert.equal('phase_vector' in captured.mood, false, 'phase_vector 只在 cycle 子对象内');
  assert.deepEqual(Object.keys(captured.mood.cycle).sort(), ['phase', 'phase_vector', 'scalars']);
});

test('装配契约：fixture 的 contract 版本与 CONTRACT_VERSION 同步（软检查，只告警）', () => {
  assert.match(SHAPE.contract, /v1\.\d+\.\d+/, 'fixture contract 必须带 v1.x.y 版本号');
  if (!SHAPE.contract.includes(CONTRACT_VERSION)) {
    console.warn(`[assembly] fixture contract 未同步：${SHAPE.contract} ≠ ${CONTRACT_VERSION}`);
  }
});
