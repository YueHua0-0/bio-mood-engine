/**
 * E-A：普通流水线 rngProvider 传播回归（R01）。
 *
 * 背景：02 的 runPipeline 长期只向模块传 `rng`，导致 05 在正常跨周期时
 * 拿不到 `rngProvider`，退化为 28.4 天常数粗推进并产生 CYCLE_COARSE_ROLL，
 * 违反 05 §5.4“正常跨周期（≤64）必须逐周期采样”。
 *
 * 本文件只验证接线与可观测结果，不修改模块实现：
 * - EA1 / EA2 / EA4：真实 advance() 路径；
 * - EA3：advanceCycleDays() 模块级 64/65 边界（不重复 4.4 万次小时分块）；
 * - EA5：hint 细分回滚不重复消耗周期随机数，且快照保留临时 cycle:* 流。
 *
 * 参考路径刻意不经过 runPipeline()，避免再次出现“两条同错路径相互一致”的假绿。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CYCLE_MODEL_VERSION } from '../../lib/core/constants.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { cycleModule, updateCycle } from '../../lib/modules/cycle/index.mjs';
import {
  EXPECTED_CYCLE_LENGTH_DAYS,
  advanceCycleDays,
  sampleCycleLength
} from '../../lib/modules/cycle/advance.mjs';
import { phaseDetail } from '../../lib/modules/cycle/phase.mjs';

import { CHARACTER_ID, MASTER_SEED } from '../unit/_random_vectors.mjs';

const T0 = '2026-11-09T08:00:00.000Z';
const T0_MS = Date.parse(T0);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TIMEZONE = 'Asia/Shanghai';
const HOURS_180 = 180 * 24;
const HOURS_60 = 60 * 24;

/** 00 §3.1 的 cycle 状态字段全量。 */
const CYCLE_FIELDS = Object.freeze([
  'cycle_index',
  'cycle_day',
  'cycle_length_days',
  'cycle_length_source',
  'phase',
  'phase_progress',
  'anchor_at',
  'phase_started_at',
  'confidence',
  'model_version'
]);

function makeState() {
  return createDefaultState({
    character_id: CHARACTER_ID,
    timezone: TIMEZONE,
    now: T0,
    master_seed_hex: MASTER_SEED,
    config: {}
  });
}

function providerOf(state) {
  return RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
}

function atHours(hours) {
  return new Date(T0_MS + hours * HOUR_MS).toISOString();
}

function cycleSnapshot(state) {
  return Object.fromEntries(CYCLE_FIELDS.map((key) => [key, state.cycle[key]]));
}

/** 只取 cycle:* 临时流的消耗计数（单位：u32）。 */
function cycleCounters(provider) {
  const counters = provider.snapshotCounters();
  return Object.fromEntries(
    Object.keys(counters)
      .filter((label) => label.startsWith('cycle:'))
      .sort((a, b) => Number(a.slice('cycle:'.length)) - Number(b.slice('cycle:'.length)))
      .map((label) => [label, counters[label]])
  );
}

/** 构造“第 day 天、周期长度 length、锚点 anchorMs”的合法 cycle 状态。 */
function anchoredCycle({ day, length = EXPECTED_CYCLE_LENGTH_DAYS, anchorMs }) {
  const detail = phaseDetail((day - 1) / length);
  return {
    anchor_at: new Date(anchorMs).toISOString(),
    cycle_index: 0,
    cycle_length_days: length,
    cycle_length_source: 'sampled',
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: new Date(anchorMs + detail.phase_start * length * DAY_MS).toISOString(),
    phase_progress: detail.phase_progress,
    confidence: 0.5,
    model_version: CYCLE_MODEL_VERSION
  };
}

let longRunCache = null;
function longRun180() {
  if (longRunCache) return longRunCache;
  const state = makeState();
  const provider = providerOf(state);
  const out = advance({
    state,
    event: null,
    now: atHours(HOURS_180),
    rngProvider: provider,
    config: {},
    modules: [cycleModule]
  });
  longRunCache = { out, provider };
  return longRunCache;
}

// ---------------------------------------------------------------------------
// EA1：180 天真实 advance 与逐小时独立参考路径全量对照
// ---------------------------------------------------------------------------

test('EA1：真实 advance 180 天与逐小时 updateCycle 参考路径的 cycle 状态完全一致', () => {
  const { out, provider } = longRun180();

  const refState = makeState();
  const refProvider = providerOf(refState);
  const refWarnings = [];
  let refCycle = refState.cycle;
  for (let hour = 1; hour <= HOURS_180; hour += 1) {
    const result = updateCycle({
      previous: refCycle,
      inputs: {},
      now: atHours(hour),
      rng: refProvider.stream(`cycle:${refCycle.cycle_index}`),
      rngProvider: refProvider,
      config: {}
    });
    refCycle = result.state;
    refWarnings.push(...result.warnings);
  }

  assert.deepEqual(
    cycleSnapshot(out.state),
    Object.fromEntries(CYCLE_FIELDS.map((key) => [key, refCycle[key]])),
    '协调器路径与逐小时参考路径必须逐字段一致'
  );

  // 证明本用例确实跨过多个周期，且采样已恢复。
  assert.ok(out.state.cycle.cycle_index >= 6, '180 天应至少跨过 6 个周期');
  assert.notEqual(
    out.state.cycle.cycle_length_days,
    EXPECTED_CYCLE_LENGTH_DAYS,
    '采样恢复后周期长度不应仍是 28.4'
  );
  assert.equal(
    out.diagnostics.warnings.includes('CYCLE_COARSE_ROLL'),
    false,
    '正常跨周期不得产生 CYCLE_COARSE_ROLL'
  );
  assert.equal(refWarnings.includes('CYCLE_COARSE_ROLL'), false);
  assert.deepEqual(cycleCounters(provider), cycleCounters(refProvider), '随机流消耗必须与独立参考路径一致');
});

// ---------------------------------------------------------------------------
// EA2：随机数消耗——每个新周期恰好一次 nextNormal（=2 个 u32）
// ---------------------------------------------------------------------------

test('EA2：正常跨周期时每个 cycle:N 流恰好消耗 2 个 u32', () => {
  const { out, provider } = longRun180();
  const counters = cycleCounters(provider);
  const expectedLabels = Array.from(
    { length: out.state.cycle.cycle_index + 1 },
    (_, index) => `cycle:${index}`
  );

  assert.deepEqual(Object.keys(counters), expectedLabels, '不得创建多余的周期流');
  for (const label of expectedLabels) {
    assert.equal(counters[label], 2, `${label} 必须恰好消耗一次 nextNormal（2 个 u32）`);
  }
  assert.equal(
    counters[`cycle:${out.state.cycle.cycle_index + 1}`],
    undefined,
    '尚未进入的周期不应提前创建流'
  );
});

// ---------------------------------------------------------------------------
// EA3：65 周期以上的既有粗推进分支保持不变
// ---------------------------------------------------------------------------

test('EA3：超过 64 个周期仍走粗推进，64 次采样后不再创建新流', () => {
  const state = makeState();
  const base = anchoredCycle({ day: 1, anchorMs: T0_MS });
  const deltaDays = 2400;

  // 独立推算预期结果：用探针 provider 按 05 §5.4 的逐步规则预取同样的长度。
  const probe = providerOf(state);
  let rest = deltaDays - (EXPECTED_CYCLE_LENGTH_DAYS - (base.cycle_day - 1));
  let expectedIndex = base.cycle_index + 1;
  let expectedDay = 1;
  let loops = 0;
  for (; loops < 64; loops += 1) {
    const length = sampleCycleLength(expectedIndex, probe, {});
    if (rest < length) {
      expectedDay = 1 + rest;
      break;
    }
    rest -= length;
    expectedIndex += 1;
  }
  assert.equal(loops, 64, '2400 天必须超过 64 个周期');
  const coarseCycles = Math.floor(rest / EXPECTED_CYCLE_LENGTH_DAYS);
  expectedIndex += coarseCycles;
  // 05 §5.4 既有实现：粗推进后 cycle_day 仍按 [1, length] 截断，允许落在周期末尾。
  expectedDay = Math.min(1 + (rest - coarseCycles * EXPECTED_CYCLE_LENGTH_DAYS), EXPECTED_CYCLE_LENGTH_DAYS);

  const provider = providerOf(state);
  const warnings = [];
  const out = advanceCycleDays({
    cycle: base,
    deltaDays,
    rngProvider: provider,
    config: {},
    warnings
  });

  assert.ok(warnings.includes('CYCLE_COARSE_ROLL'), '超过 64 个周期必须告警');
  assert.equal(out.cycle_index, expectedIndex, 'cycle_index 必须与粗推进结果一致');
  assert.ok(Math.abs(out.cycle_day - expectedDay) < 1e-6, 'cycle_day 必须与粗推进结果一致');
  assert.equal(out.cycle_length_days, EXPECTED_CYCLE_LENGTH_DAYS);

  const counters = cycleCounters(provider);
  const sampledLabels = Array.from({ length: 64 }, (_, index) => `cycle:${index + 1}`);
  assert.deepEqual(Object.keys(counters), sampledLabels, '只允许采样 1..64，不得创建 cycle:65');
  for (const label of sampledLabels) {
    assert.equal(counters[label], 2, `${label} 必须恰好消耗一次 nextNormal`);
  }
});

// ---------------------------------------------------------------------------
// EA4：正常跨周期不告警（与 EA1 互补，不替代全量状态比较）
// ---------------------------------------------------------------------------

test('EA4：真实 advance 正常跨周期不产生 CYCLE_COARSE_ROLL', () => {
  const state = makeState();
  const provider = providerOf(state);
  const out = advance({
    state,
    event: null,
    now: atHours(HOURS_60),
    rngProvider: provider,
    config: {},
    modules: [cycleModule]
  });

  assert.ok(out.state.cycle.cycle_index >= 2, '60 天应至少跨过 2 个周期');
  assert.equal(
    out.diagnostics.warnings.includes('CYCLE_COARSE_ROLL'),
    false,
    '正常跨周期推进不得出现粗推进告警'
  );
});

// ---------------------------------------------------------------------------
// EA5：hint 细分回滚不重复消耗周期随机数，且快照保留临时 cycle:* 流
// ---------------------------------------------------------------------------

/** 包装真实 cycle 模块：周期推进仍由 updateCycle 完成，仅注入一次提示时刻。 */
function cycleWithHint(hintAt) {
  let fired = false;
  return {
    name: 'cycle',
    update(args) {
      const result = cycleModule.update(args);
      if (!fired) {
        fired = true;
        return { ...result, next_transition_at: hintAt };
      }
      return result;
    }
  };
}

test('EA5：同一 chunk 内先跨周期再触发 hint，回滚不重复消耗 cycle:1', () => {
  // 锚点使周期在 T0+30min 回绕；hint 落在回绕之前的 T0+15min。
  const anchorMs = T0_MS - (EXPECTED_CYCLE_LENGTH_DAYS - 0.5 / 24) * DAY_MS;
  const cycle = anchoredCycle({ day: EXPECTED_CYCLE_LENGTH_DAYS, anchorMs });
  const hintAt = atHours(0.25);

  const state = makeState();
  state.cycle = cycle;
  const provider = providerOf(state);
  const out = advance({
    state,
    event: null,
    now: atHours(1),
    rngProvider: provider,
    config: {},
    modules: [cycleWithHint(hintAt)]
  });

  const refState = makeState();
  refState.cycle = cycle;
  const refProvider = providerOf(refState);
  const reference = advance({
    state: refState,
    event: null,
    now: atHours(1),
    rngProvider: refProvider,
    config: {},
    modules: [cycleModule]
  });

  assert.deepEqual(cycleSnapshot(out.state), cycleSnapshot(reference.state), '回滚后状态必须与无 hint 参考一致');
  assert.equal(cycleCounters(provider)['cycle:1'], 2, '被丢弃的预判轮不得留下额外消耗');
  assert.equal(cycleCounters(refProvider)['cycle:1'], 2);

  // 继续推进到 T0+2h，并在 T0+90min 触发一次 hint；此时不应再消耗 cycle:1，
  // 且快照恢复必须保留已存在的临时流。
  const nextProvider = provider;
  const second = advance({
    state: out.state,
    event: null,
    now: atHours(2),
    rngProvider: nextProvider,
    config: {},
    modules: [cycleWithHint(atHours(1.5))]
  });

  const counters = cycleCounters(nextProvider);
  assert.ok(Object.prototype.hasOwnProperty.call(counters, 'cycle:1'), '快照必须保留临时 cycle:1 流');
  assert.equal(counters['cycle:1'], 2, 'hint 回滚不得重置或追加 cycle:1 的消耗');
  assert.equal(second.state.cycle.cycle_index, 1, '第二段推进不应再次跨周期');
});
