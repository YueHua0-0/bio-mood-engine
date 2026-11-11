import assert from 'node:assert/strict';
import test from 'node:test';

import { MASTER_SEED } from './_random_vectors.mjs';
import { moduleOf, moodState, regulationState, result } from './_stubs.mjs';

import { createDefaultState, stateFingerprint } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';
import {
  advance,
  aggregateDiagnostics,
  checkVersion,
  createCoordinator,
  createMutex
} from '../../lib/core/coordinator.mjs';

const START = '2026-11-09T08:00:00.000Z';

function baseState(overrides = {}) {
  const state = createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED,
    ...overrides
  });
  // 本文件的用例验证"已初始化后的推进"：cycle 必须已被 05 采样，
  // 否则会命中 advance 末尾的 default 残留断言（00 v1.7.6 §3.2）。
  if (state.cycle.cycle_length_source === 'default') {
    state.cycle = { ...state.cycle, cycle_length_source: 'sampled' };
  }
  return state;
}

function providerFor(state) {
  return RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
}

function run({ state = baseState(), now, modules, event = null, config = {}, urgent = false }) {
  const provider = providerFor(state);
  const out = advance({ state, event, now, rngProvider: provider, modules, config, urgent });
  return { ...out, provider };
}

test('T18 离线 72h 且带 1 条事件：事件只应用一次', () => {
  let applications = 0;
  const eventModule = moduleOf('event', ({ previous, inputs }) => {
    if (inputs.event) applications += 1;
    return result('event', { ...previous, last_event_at: inputs.event?.occurred_at ?? previous.last_event_at });
  });

  const out = run({
    now: '2026-11-12T08:00:00.000Z',
    modules: [eventModule],
    event: {
      event_id: 'evt_00000001',
      event_type: 'praise',
      occurred_at: '2026-11-12T07:59:00.000Z',
      intensity: 0.5,
      source_key: 'wechat:group_1:sender_a'
    }
  });

  assert.equal(applications, 1);
  assert.equal(out.state.stress.last_event_at, '2026-11-12T07:59:00.000Z');
  assert.equal(out.state.state_version, 1);
  assert.equal(out.state.last_tick_at, '2026-11-12T08:00:00.000Z');
  assert.equal(out.state.updated_at, '2026-11-12T08:00:00.000Z');
});

test('02 装配：chunk=60 时 08 收到 dt=60，事件阶段收到 dt=0', () => {
  const state = baseState();
  const seen = [];
  const regulation = moduleOf('regulation', ({ previous, inputs }) => {
    seen.push(inputs.dt);
    return result('regulation', { ...previous });
  });
  run({
    state,
    now: new Date(Date.parse(START) + 60_000).toISOString(),
    modules: [regulation],
    event: {
      event_id: 'evt_00000004',
      event_type: 'praise',
      occurred_at: '2026-11-09T08:00:30.000Z',
      intensity: 0.3,
      source_key: 'wechat:group_1:sender_a'
    }
  });
  assert.deepEqual(seen, [60, 0]);
});

test('advance 结束仍为 default → MODULE_FAILED（cycle_source_unresolved）', () => {
  const state = baseState();
  state.cycle = { ...state.cycle, cycle_length_source: 'default' };
  assert.throws(
    () => run({ state, now: '2026-11-09T09:00:00.000Z', modules: [] }),
    (err) => err.code === 'MODULE_FAILED' && err.details?.reason === 'cycle_source_unresolved'
  );
});

test('T19 模块返回缺字段 → MODULE_FAILED', () => {
  const broken = moduleOf('sleep', ({ previous }) => ({ state: previous }));
  assert.throws(
    () => run({ now: '2026-11-09T09:00:00.000Z', modules: [broken] }),
    (err) => err.code === 'MODULE_FAILED' && err.details.module === 'sleep'
  );
});

test('T20 情绪单步 +0.09 被裁剪到 0.06 并追加 CLAMPED_DELTA', () => {
  const state = baseState();
  const stub = moduleOf('mood', ({ previous }) => result('mood', moodState(previous, { energy: previous.energy + 0.09 })));
  const out = run({ state, now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  assert.equal(out.state.mood.energy, 0.66);
  assert.ok(out.diagnostics.warnings.includes('CLAMPED_DELTA'));
});

test('T21 高严重度事件（derived.event_intensity=0.8）允许 +0.12 不裁剪', () => {
  const state = baseState();
  // 07 的 applyEvent 是 derived.event_intensity 的唯一输出点；02 不回退到 event.intensity。
  const stress = moduleOf('event', ({ previous, inputs }) =>
    result('event', { ...previous, last_event_at: inputs.event.occurred_at }, {
      derived: { event_intensity: 0.8 }
    }));
  const stub = moduleOf('mood', ({ previous }) => result('mood', moodState(previous, { energy: previous.energy + 0.12 })));
  // elapsed = 0：只有"应用事件"这一次流水线，便于单独观察情绪步长
  const out = run({
    state,
    now: START,
    modules: [stress, stub],
    event: {
      event_id: 'evt_00000002',
      event_type: 'praise',
      occurred_at: '2026-11-09T07:59:00.000Z',
      intensity: 0.8,
      source_key: 'wechat:group_1:sender_a'
    }
  });
  assert.equal(out.state.mood.energy, 0.72);
  assert.ok(!out.diagnostics.warnings.includes('CLAMPED_DELTA'));
});

test('T21b 原始 event.intensity 不参与 severe：07 未输出 derived 时仍按 0.06 裁剪', () => {
  const state = baseState();
  const stub = moduleOf('mood', ({ previous }) => result('mood', moodState(previous, { energy: previous.energy + 0.09 })));
  const out = run({
    state,
    now: START,
    modules: [stub],
    event: {
      event_id: 'evt_00000003',
      event_type: 'praise',
      occurred_at: '2026-11-09T07:59:00.000Z',
      intensity: 0.8,
      source_key: 'wechat:group_1:sender_a'
    }
  });
  assert.equal(out.state.mood.energy, 0.66, '回退到 event.intensity 就会错误放宽到 0.12 档');
  assert.ok(out.diagnostics.warnings.includes('CLAMPED_DELTA'));
});

test('T22 checkVersion 不一致抛 STATE_VERSION_CONFLICT（可重试）', () => {
  assert.equal(checkVersion({ expectedVersion: 3, actualVersion: 3 }), true);
  assert.throws(
    () => checkVersion({ expectedVersion: 41, actualVersion: 42 }),
    (err) => err.code === 'STATE_VERSION_CONFLICT' && err.retryable === true
  );
});

test('T26 提示的转换点落在片内：重算到该时刻并精确写入', () => {
  const calls = [];
  const stub = moduleOf('sleep', ({ previous, now }) => {
    calls.push(now);
    const hint = calls.length === 1 ? toIso(parseTime(now, 'now') - 600_000) : null;
    return result('sleep', { ...previous }, { next_transition_at: hint });
  });
  const out = run({ now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  assert.ok(calls.includes('2026-11-09T08:50:00.000Z'), `calls=${calls.join(',')}`);
  assert.equal(out.state.last_tick_at, '2026-11-09T09:00:00.000Z');
});

test('T26b 片内细分后第二段 dt = stepEnd - 提示时刻（3600 → 600 + 3000）', () => {
  const seen = [];
  const stub = moduleOf('regulation', ({ previous, inputs, now }) => {
    seen.push(inputs.dt);
    // 只在第一次（09:00 的整片探测）给提示：08:10，距片首 600s。
    const hint = seen.length === 1 ? toIso(parseTime(now, 'now') - 3_000_000) : null;
    return result('regulation', { ...previous }, { next_transition_at: hint });
  });
  run({ now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  // [0]=被丢弃的整片探测（3600），[1]=重算段 600，[2]=补齐段 3000。
  // 若补齐段误用原始 step（3600），这里会是 3600，09 的 alpha 与 08 的 blend 都会偏大。
  assert.deepEqual(seen, [3600, 600, 3000]);
});

test('T27 每片最多 8 次细分，不进入死循环', () => {
  const calls = [];
  const stub = moduleOf('sleep', ({ previous, now }) => {
    calls.push(now);
    return result('sleep', { ...previous }, {
      next_transition_at: toIso(parseTime(now, 'now') - 60_000)
    });
  });
  const out = run({ now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  assert.ok(calls.length <= 10, `calls=${calls.length}`);
  assert.equal(out.state.last_tick_at, '2026-11-09T09:00:00.000Z');
});

test('T28 早于片首的提示被忽略并追加 INVALID_TRANSITION_HINT', () => {
  let calls = 0;
  const stub = moduleOf('sleep', ({ previous, now }) => {
    calls += 1;
    return result('sleep', { ...previous }, {
      next_transition_at: toIso(parseTime(now, 'now') - 4_000_000)
    });
  });
  const out = run({ now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  assert.equal(calls, 1);
  assert.ok(out.diagnostics.warnings.includes('INVALID_TRANSITION_HINT'));
});

test('T29 细分重算使用随机快照回滚，不重复计入被丢弃的那次', () => {
  const plain = moduleOf('mood', ({ previous, rng }) => {
    rng.nextU32();
    return result('mood', moodState(previous, {}));
  });
  const withHint = moduleOf('mood', ({ previous, rng, now }) => {
    rng.nextU32();
    return result('mood', moodState(previous, {}), {
      next_transition_at: toIso(parseTime(now, 'now') - 1_200_000)
    });
  });

  const a = run({ now: '2026-11-09T09:00:00.000Z', modules: [plain] });
  // 整片一次推进只消耗 1 个随机数
  assert.equal(a.provider.stream('mood').counter, 1);

  const b = run({ now: '2026-11-09T09:00:00.000Z', modules: [withHint] });
  // 有效推进为两段（08:40 与 09:00），被丢弃的 09:00 那次不计入；
  // 若未回滚则会消耗 3 个。唯一权威来源是写回后的 state.random（00 §11.4）。
  assert.equal(b.state.random.streams.mood.counter, 2);
});

test('T30 多模块提示取最早；模块顺序被强制校验', () => {
  const times = [];
  const cycle = moduleOf('cycle', ({ previous, now }) => {
    times.push(`cycle:${now}`);
    return result('cycle', { ...previous }, { next_transition_at: toIso(parseTime(now, 'now') - 1_800_000) });
  });
  const sleep = moduleOf('sleep', ({ previous, now }) => {
    times.push(`sleep:${now}`);
    return result('sleep', { ...previous }, { next_transition_at: toIso(parseTime(now, 'now') - 600_000) });
  });
  run({ now: '2026-11-09T09:00:00.000Z', modules: [cycle, sleep] });
  assert.ok(times.includes('sleep:2026-11-09T08:30:00.000Z'), times.join(','));

  assert.throws(
    () => run({ now: '2026-11-09T09:00:00.000Z', modules: [sleep, cycle] }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});

test('T31 情绪单步超过硬上限 0.15 → MODULE_FAILED（不裁剪，state_version 不变）', () => {
  const state = baseState();
  const before = stateFingerprint(state);
  const stub = moduleOf('mood', ({ previous }) => result('mood', moodState(previous, { energy: previous.energy + 0.2 })));
  assert.throws(
    () => run({ state, now: '2026-11-09T09:00:00.000Z', modules: [stub] }),
    (err) => err.code === 'MODULE_FAILED' && err.details.path === 'mood.energy'
  );
  assert.equal(state.state_version, 0);
  assert.equal(stateFingerprint(state), before);
});

test('T32 返回对象只有四个键，且随机计数器已写回', () => {
  const out = run({ now: '2026-11-09T09:00:00.000Z', modules: [] });
  assert.deepEqual(Object.keys(out).filter((k) => k !== 'provider').sort(), [
    'behavior_context',
    'delivery',
    'diagnostics',
    'state'
  ]);
  assert.equal(out.state.random.algorithm, 'pcg32');
  assert.equal(Array.isArray(out.diagnostics.warnings), true);
});

test('时钟回拨的警告进入 diagnostics.warnings（T32 补充）', () => {
  const out = run({ now: '2026-11-09T07:50:00.000Z', modules: [] });
  assert.ok(out.diagnostics.warnings.includes('CLOCK_REGRESSION'));
  assert.equal(out.state.last_tick_at, START);
  assert.equal(out.state.state_version, 1);
});

test('超过 4320 步进入粗推进并追加 LONG_OFFLINE_COARSE', () => {
  // 粗推进依赖 05/06 注入 advanceCycleDays / sleepinessSteady（I-3 / I-4）
  let coarseArgs = null;
  const cycle = moduleOf('cycle', ({ previous }) => result('cycle', { ...previous }), {
    advanceCycleDays: (args) => {
      coarseArgs = args;
      return { ...args.cycle };
    }
  });
  const sleep = moduleOf('sleep', ({ previous }) => result('sleep', { ...previous }), {
    sleepinessSteady: (hour, sleepDebt) => 0.10 + 0.45 * sleepDebt
  });
  const out = run({ now: '2027-11-01T00:00:00.000Z', modules: [cycle, sleep] });
  assert.ok(out.diagnostics.warnings.some((w) => /^LONG_OFFLINE_COARSE:\d+h$/.test(w)), out.diagnostics.warnings.join(','));
  const hours = Number(out.diagnostics.warnings.find((w) => w.startsWith('LONG_OFFLINE_COARSE')).split(':')[1].replace('h', ''));
  assert.ok(hours > 0);
  // 05 §4.1：粗推进必须把 rngProvider 透传下去，否则跨周期无法用 cycle:${index} 采样（C12 会假绿）
  assert.ok(coarseArgs, 'advanceCycleDays hook 应被调用');
  assert.equal(typeof coarseArgs.rngProvider?.stream, 'function', 'coarse 必须收到 rngProvider');
  assert.equal(typeof coarseArgs.rngProvider?.serialize, 'function');
});

test('advance 不修改入参 state，且把随机计数器写回 state.random', () => {
  const state = baseState();
  const before = stateFingerprint(state);
  const stub = moduleOf('mood', ({ previous, rng }) => {
    rng.nextU32();
    return result('mood', moodState(previous, {}));
  });
  const out = run({ state, now: '2026-11-09T09:00:00.000Z', modules: [stub] });
  assert.equal(stateFingerprint(state), before);
  assert.equal(out.state.random.streams.mood.counter, 1);
});

test('aggregateDiagnostics 累加同键贡献并按去重保留首次警告', () => {
  const diagnostics = aggregateDiagnostics([
    {
      contributions: { 'mood.energy': { sleep: -0.03 }, 'mood.stability': { regulation: 0.01 } },
      warnings: ['SLEEP_DEBT_HIGH', 'SLEEP_DEBT_HIGH'],
      diagnostics: { module: 'mood', elapsed_ms: 2 }
    },
    {
      contributions: { 'mood.energy': { sleep: -0.02, cycle: 0.01 } },
      warnings: ['CYCLE_LUTEAL'],
      diagnostics: { module: 'mood', elapsed_ms: 3 }
    }
  ]);
  assert.equal(diagnostics.contributions['mood.energy'].sleep, -0.05);
  assert.equal(diagnostics.contributions['mood.energy'].cycle, 0.01);
  assert.deepEqual(diagnostics.warnings, ['SLEEP_DEBT_HIGH', 'SLEEP_DEBT_HIGH', 'CYCLE_LUTEAL']);
  assert.equal(diagnostics.module_ms.mood, 5);
});

test('behavior / delivery 模块产出上下文而不写 state', () => {
  const behavior = moduleOf('behavior', () => result('behavior', { verbosity_bias: 0.1 }));
  const delivery = moduleOf('delivery', () => result('delivery', { action: 'SILENT' }));
  const out = run({ now: '2026-11-09T09:00:00.000Z', modules: [behavior, delivery] });
  assert.deepEqual(out.behavior_context, { verbosity_bias: 0.1 });
  assert.deepEqual(out.delivery, { action: 'SILENT' });
  assert.equal(out.state.behavior_context, undefined);
});

test('createCoordinator 绑定模块后可直接推进', () => {
  const state = baseState();
  const stub = moduleOf('regulation', ({ previous }) => result('regulation', regulationState(previous, { arousal: 0.52 })));
  const coordinator = createCoordinator({ modules: [stub] });
  const out = coordinator.advance({
    state,
    event: null,
    now: '2026-11-09T09:00:00.000Z',
    rngProvider: providerFor(state)
  });
  assert.equal(out.state.regulation.arousal, 0.52);
});

test('createMutex 串行化并发调用', async () => {
  const runExclusive = createMutex();
  const order = [];
  await Promise.all([
    runExclusive(async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a-end');
    }),
    runExclusive(async () => {
      order.push('b-start');
      order.push('b-end');
    })
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});
