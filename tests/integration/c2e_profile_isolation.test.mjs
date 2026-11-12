/**
 * C2-E：cycle.profile 四参数（pain_sensitivity / luteal_sensitivity /
 * mood_variability / intimacy_variability）的引擎内部隔离测试。
 *
 * 边界（E-C 授权）：
 * - 只新增本测试文件与测试辅助函数，不修改任何生产代码；
 * - 使用真实 advance() 验证 profile 隔离，直接调用 phaseInfluence() 验证 crossfade；
 * - 不重复插件端到端用例（E-B 已覆盖配置传递与真实计算）。
 *
 * ============================================================================
 * 材料一：参数 × 相位 × phase_vector 分量支撑矩阵（EC1 / EC5 的前置依据）
 * ============================================================================
 *
 * 记 w_m / w_f / w_o / w_l 为 phaseWeights(p) 的四阶段权重，分量值取自
 * PHASE_IMPACT_MATRIX。只有"被 profile 乘到的分量在该锚点非零"，才允许要求
 * 目标维度出现差异；分量为零时差异必须精确为零（零支撑区间）。
 *
 * 参数                 | menstrual (w_m=1)        | follicular (w_f=1)   | ovulatory (w_o=1)     | luteal (w_l=1)
 * ---------------------|--------------------------|----------------------|-----------------------|------------------------
 * pain_sensitivity     | pain_load 0.60 → 支撑    | 0.05 → 支撑          | 0.05 → 支撑           | 0.35 → 支撑
 * luteal_sensitivity   | w_l=0 → 零支撑（精确 0） | w_l=0 → 零支撑       | w_l=0 → 零支撑        | w_l=1，anx 0.12 / irr 0.18 → 支撑
 * mood_variability     | anx -0.15 / irr 0.20 /   | -0.10 / -0.10 /      | -0.05 / -0.05 /       | +0.12 / +0.18 /
 *                      | pos -0.15 → 支撑         | +0.20 → 支撑         | +0.25 → 支撑          | -0.10 → 支撑
 * intimacy_variability | intimacy -0.10 → 支撑    | +0.05 → 支撑         | +0.35 → 支撑          | -0.05 → 支撑
 *
 * 结论：
 * - pain_sensitivity / mood_variability / intimacy_variability 在其被乘分量上
 *   四个相位均非零，因此这些参数在四个锚点都允许出现差异（但测试仍逐项核对
 *   实际 phase_vector，而不是仅凭"参数有直接依赖"推断）。
 * - luteal_sensitivity 仅通过 w_l × luteal.{anxiety,irritability} 生效；w_l = 0
 *   的锚点（menstrual / follicular / ovulatory）是零支撑区间，必须精确相等。
 *   周期起点 boundary=0 的 50% 黄体权重属于既有行为，不在本测试范围内，
 *   本测试的锚点都远离 crossfade 窗口。
 *
 * ============================================================================
 * 材料二：EC5-E3 单调性断言（完整口径）
 * ============================================================================
 *
 * 比较对象：固定 luteal_sensitivity = 1.5 的九维输出 vs 默认 profile（四参数=1）。
 * 采样点：p 从 0.50 到 0.56，步长 0.0025，共 25 点；不硬编码 crossfade 窗口宽度，
 *         每个点的 w_l 由 phaseWeights(p, 28.4).luteal_like 实测。
 * 断言量：diff_anx(p) = anx(ls=1.5) - anx(default)；diff_irr(p) 同理。
 * 边界条件：
 *   1) w_l(p) === 0        ⇒ diff === 0（精确零支撑，不是近似）。
 *   2) 0 < w_l(p) < 1      ⇒ diff >= 0，且随 p 单调非减（相邻点容差 -1e-9）。
 *   3) w_l(p) === 1        ⇒ diff > 0（黄体上界行为；不断言具体幅值）。
 *   4) 至少存在一个 0 < w_l < 1 的过渡点且 diff > 0，证明 crossfade 确实生效。
 *   5) 符号方向：luteal.anxiety_delta = +0.12、irritability_delta = +0.18 均为正，
 *      ls = 1.5 > 1 只会放大它们，故 diff 不允许为负。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CYCLE_MODEL_VERSION,
  MODULE_ORDER,
  MOOD_KEYS,
  PHASE_IMPACT_MATRIX,
  PHASE_VECTOR_KEYS_V2,
  REGULATION_KEYS
} from '../../lib/core/constants.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { phaseDetail, phaseInfluence, phaseWeights } from '../../lib/modules/cycle/phase.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

import { CHARACTER_ID, MASTER_SEED } from '../unit/_random_vectors.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 与 phaseWeights / phaseInfluence 的默认周期长度一致，避免采样抖动。 */
const CYCLE_LENGTH_DAYS = 28.4;
const T0 = '2026-11-09T09:00:00.000Z';
const TIMEZONE = 'Asia/Shanghai';

/** 与 lib/api/handler.mjs 的 MODULE_TABLE 同构（E-C 不改生产装配，本文件自带一份）。 */
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

const MODULES = MODULE_ORDER.map((name) => MODULE_TABLE[name]);

/** mood 透明包装：记录实收 args（原样转发、原样返回）。 */
function modulesWithCapture(capture) {
  if (!capture) return MODULES;
  return MODULE_ORDER.map((name) => {
    if (name !== 'mood') return MODULE_TABLE[name];
    return {
      name: 'mood',
      update: (args) => {
        const result = moodModule.update(args);
        capture.push({ args, warnings: result.warnings ?? [] });
        return result;
      }
    };
  });
}

/**
 * 构造"周期第 day 天、周期长度固定 28.4 天"的合法状态。
 *
 * anchor_at 前移 (day-1) 天，使 now = T0 + 1h 时 cycle_day 恰好推进 1/24 天；
 * cycle_length_source = 'sampled' 以免首次推进消耗 cycle 采样随机数。
 */
function anchoredState({ day }) {
  const state = createDefaultState({
    character_id: CHARACTER_ID,
    timezone: TIMEZONE,
    now: T0,
    master_seed_hex: MASTER_SEED,
    config: {}
  });
  const anchorMs = Date.parse(T0) - (day - 1) * DAY_MS;
  const detail = phaseDetail((day - 1) / CYCLE_LENGTH_DAYS);
  state.cycle = {
    anchor_at: new Date(anchorMs).toISOString(),
    cycle_index: 0,
    cycle_length_days: CYCLE_LENGTH_DAYS,
    cycle_length_source: 'sampled',
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: new Date(
      Math.floor(anchorMs + detail.phase_start * CYCLE_LENGTH_DAYS * DAY_MS)
    ).toISOString(),
    phase_progress: detail.phase_progress,
    confidence: 0.5,
    model_version: CYCLE_MODEL_VERSION
  };
  return state;
}

function configOf(profile) {
  return profile ? { cycle: { profile } } : {};
}

/** 从同一个 state 的持久化随机游标出发，推进到 now。 */
function advanceOnce(state, { profile = null, now, capture = null } = {}) {
  const rngProvider = RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
  return advance({
    state,
    event: null,
    now,
    rngProvider,
    config: configOf(profile),
    modules: modulesWithCapture(capture)
  });
}

function moodOf(state) {
  return Object.fromEntries(MOOD_KEYS.map((dim) => [dim, state.mood[dim]]));
}

function regOf(state) {
  return Object.fromEntries(REGULATION_KEYS.map((key) => [key, state.regulation[key]]));
}

function progressOf(state) {
  return (state.cycle.cycle_day - 1) / state.cycle.cycle_length_days;
}

/** 单步（1h，恰好一个 chunk）运行，返回 mood / phase_vector / diagnostics。 */
function runSingle({ day, profile = null, offsetHours = 1 }) {
  const base = anchoredState({ day });
  const capture = [];
  const now = new Date(Date.parse(T0) + offsetHours * HOUR_MS).toISOString();
  const out = advanceOnce(base, { profile, now, capture });
  assert.equal(capture.length, 1, '1h 推进应恰好调用一次 mood');
  return {
    base,
    out,
    args: capture[0].args,
    moodWarnings: capture[0].warnings,
    mood: moodOf(out.state),
    vector: capture[0].args.inputs.cycle.phase_vector,
    diagnostics: out.diagnostics
  };
}

function assertMoodEqual(a, b, dims, label) {
  for (const dim of dims) {
    assert.equal(a[dim], b[dim], `${label}: ${dim} 必须精确相等（${a[dim]} vs ${b[dim]}）`);
  }
}

/**
 * 只断言 **mood 模块自身** 未触发裁剪 / [0,1] 边界。
 *
 * 注意：装配层的 warnings 是跨模块聚合的，首步 regulation 因惯性与目标差距会
 * 合法触发与 0.05 上限相关的 CLAMPED_DELTA；它来自 08 的既有行为，与本测试
 * 的 mood 线性前提无关，因此必须按模块（mood 自己的 warnings）判定。
 * mood 的 clamp 残差仅允许 round6 量级（≤1e-5）。
 */
function assertNoClamp(diagnostics, moodWarnings, label) {
  assert.ok(
    !moodWarnings.includes('CLAMPED_DELTA'),
    `${label}: mood 不应出现 CLAMPED_DELTA（实际 warnings: ${moodWarnings.join(',')}）`
  );
  for (const dim of MOOD_KEYS) {
    const residual = diagnostics.contributions[`mood.${dim}`].clamp;
    assert.ok(
      Math.abs(residual) <= 1e-5,
      `${label}: mood.${dim} 出现裁剪/边界残差 ${residual}`
    );
  }
}

// ---------------------------------------------------------------------------
// EC1：直接依赖（A1）、零支撑区间（A2）、支撑矩阵前置核对（A3）
// ---------------------------------------------------------------------------

const EC1_CASES = [
  {
    name: 'pain_sensitivity',
    day: 5, // menstrual，p≈0.141，远离 crossfade
    value: 1.5,
    expect: { physical_comfort: -1, energy: -1 },
    untouched: ['stability', 'sensitivity', 'social_drive', 'closeness_need', 'stress'],
    support: ({ vector }) => {
      assert.ok(vector.pain_load > 0, `支撑前置失败：pain_load=${vector.pain_load}`);
    }
  },
  {
    name: 'luteal_sensitivity',
    day: 22, // luteal，w_l=1
    value: 1.5,
    expect: { stability: -1, sensitivity: +1 },
    untouched: ['energy', 'social_drive', 'closeness_need', 'physical_comfort', 'stress'],
    support: ({ out }) => {
      const w = phaseWeights(progressOf(out.state), out.state.cycle.cycle_length_days);
      assert.equal(w.luteal_like, 1, '支撑前置失败：luteal 锚点 w_l 必须为 1');
      assert.ok(
        PHASE_IMPACT_MATRIX.luteal_like.anxiety_delta !== 0 &&
          PHASE_IMPACT_MATRIX.luteal_like.irritability_delta !== 0,
        '支撑前置失败：luteal 焦虑/易激惹分量必须非零'
      );
    }
  },
  {
    name: 'mood_variability',
    day: 10, // follicular，p≈0.317
    value: 1.5,
    expect: { stability: +1, sensitivity: -1, social_drive: +1 },
    untouched: ['energy', 'closeness_need', 'physical_comfort', 'stress'],
    support: ({ vector }) => {
      assert.ok(vector.anxiety_delta !== 0, '支撑前置失败：anxiety_delta 为 0');
      assert.ok(vector.irritability_delta !== 0, '支撑前置失败：irritability_delta 为 0');
      assert.ok(vector.positive_affect_delta !== 0, '支撑前置失败：positive_affect_delta 为 0');
    }
  },
  {
    name: 'intimacy_variability',
    day: 15, // ovulatory，p≈0.493
    value: 1.5,
    expect: { closeness_need: +1 },
    untouched: ['energy', 'stability', 'sensitivity', 'social_drive', 'physical_comfort', 'stress'],
    support: ({ vector }) => {
      assert.ok(
        vector.intimacy_need_delta > 0,
        `支撑前置失败：intimacy_need_delta=${vector.intimacy_need_delta}`
      );
    }
  }
];

test('C2-E EC1-A1：四个参数在各自支撑锚点上产生方向正确的直接差异', () => {
  for (const item of EC1_CASES) {
    const base = runSingle({ day: item.day });
    const variant = runSingle({ day: item.day, profile: { [item.name]: item.value } });

    item.support(variant);

    for (const [dim, direction] of Object.entries(item.expect)) {
      const delta = variant.mood[dim] - base.mood[dim];
      assert.ok(
        direction > 0 ? delta > 0 : delta < 0,
        `${item.name}: ${dim} 方向错误，delta=${delta}`
      );
    }
    assertMoodEqual(base.mood, variant.mood, item.untouched, `${item.name} 单步直接映射`);
    assertNoClamp(base.diagnostics, base.moodWarnings, `${item.name} baseline`);
    assertNoClamp(variant.diagnostics, variant.moodWarnings, `${item.name} variant`);
  }
});

test('C2-E EC1-A2：luteal_sensitivity 在 w_l=0 的三个锚点是精确零支撑区间', () => {
  for (const day of [5, 10, 15]) {
    const base = runSingle({ day });
    const variant = runSingle({ day, profile: { luteal_sensitivity: 1.5 } });
    const w = phaseWeights(progressOf(variant.out.state), variant.out.state.cycle.cycle_length_days);

    assert.equal(w.luteal_like, 0, `day=${day}: 该锚点必须处于 w_l=0 区间`);
    assert.deepEqual(
      variant.vector,
      base.vector,
      `day=${day}: w_l=0 时九维 phase_vector 必须逐键相等`
    );
    assert.deepEqual(variant.mood, base.mood, `day=${day}: w_l=0 时七维 mood 必须逐键相等`);
  }
});

test('C2-E EC1-A3：支撑矩阵由真实 phase_vector 复核（不为零支撑的锚点要求差异）', () => {
  // 四个锚点的真实 phase_vector 支撑情况：参数 × 锚点 → 是否允许差异。
  const anchors = {
    menstrual: 5,
    follicular: 10,
    ovulatory: 15,
    luteal: 22
  };
  const supportOf = {
    pain_sensitivity: ({ vector }) => vector.pain_load !== 0,
    luteal_sensitivity: ({ out }) =>
      phaseWeights(progressOf(out.state), out.state.cycle.cycle_length_days).luteal_like !== 0,
    mood_variability: ({ vector }) =>
      vector.anxiety_delta !== 0 ||
      vector.irritability_delta !== 0 ||
      vector.positive_affect_delta !== 0,
    intimacy_variability: ({ vector }) => vector.intimacy_need_delta !== 0
  };

  for (const [phaseName, day] of Object.entries(anchors)) {
    const base = runSingle({ day });
    for (const [param, supported] of Object.entries(supportOf)) {
      const variant = runSingle({ day, profile: { [param]: 1.5 } });
      const isSupported = supported(variant);
      const changed = MOOD_KEYS.some((dim) => variant.mood[dim] !== base.mood[dim]);
      assert.equal(
        changed,
        isSupported,
        `${phaseName}/${param}: 支撑=${isSupported} 但变化=${changed}（支撑矩阵与实际不一致）`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// EC2：56 步（28 天 × 12h）的严格相等集合与反馈泄漏
// ---------------------------------------------------------------------------

/**
 * 直接影响 / 反馈可达 / 严格不受影响。
 *
 * 反馈图（唯一跨维串扰来源）：
 *   regulation 读取上一 tick 的 mood.{energy, stability, closeness_need}
 *   - stability → threat_sensitivity → mood.sensitivity
 *   - energy + closeness_need → social_reassurance_drive → mood.{social_drive, closeness_need}
 * 运行 12h tick 时，同一 advance 内第 2 个 1h 子步起就会发生上述反馈，
 * 因此"严格相等集合"必须排除所有可能经反馈路径到达的维度。
 */
const EC2_CASES = [
  {
    name: 'pain_sensitivity',
    values: [0, 1.5],
    direct: ['physical_comfort', 'energy'],
    feedbackReach: ['social_drive', 'closeness_need'],
    strictEqual: ['stability', 'sensitivity', 'stress']
  },
  {
    name: 'luteal_sensitivity',
    values: [0, 1.5],
    direct: ['stability', 'sensitivity'],
    feedbackReach: [],
    strictEqual: ['energy', 'social_drive', 'closeness_need', 'physical_comfort', 'stress']
  },
  {
    name: 'mood_variability',
    values: [0, 1.5],
    direct: ['stability', 'sensitivity', 'social_drive'],
    feedbackReach: [],
    strictEqual: ['energy', 'closeness_need', 'physical_comfort', 'stress']
  },
  {
    name: 'intimacy_variability',
    values: [0, 1.5],
    direct: ['closeness_need'],
    feedbackReach: ['social_drive'],
    strictEqual: ['energy', 'stability', 'sensitivity', 'physical_comfort', 'stress']
  }
];

const STEPS_56 = 56;

function runSequence(profile, steps = STEPS_56) {
  let state = createDefaultState({
    character_id: CHARACTER_ID,
    timezone: TIMEZONE,
    now: T0,
    master_seed_hex: MASTER_SEED,
    config: {}
  });
  const states = [state];
  for (let i = 1; i <= steps; i += 1) {
    const now = new Date(Date.parse(T0) + i * 12 * HOUR_MS).toISOString();
    state = advanceOnce(state, { profile, now }).state;
    states.push(state);
  }
  return states;
}

test('C2-E EC2：56 步序列中严格相等集合保持相等，直接影响与反馈维出现真实差异', () => {
  const baseline = runSequence(null);

  // 每个参数跑两档：0（关闭调制）与 1.5（上界），基线为四参数默认 1.0。
  for (const item of EC2_CASES) {
    for (const value of item.values) {
      const label = `${item.name}=${value}`;
      const variant = runSequence({ [item.name]: value });
      const maxDiff = Object.fromEntries(MOOD_KEYS.map((dim) => [dim, 0]));

      for (let i = 0; i < baseline.length; i += 1) {
        const a = baseline[i];
        const b = variant[i];

        // 周期轨迹必须完全相同：profile 只作用于 phase_vector，不得影响周期推进。
        assert.equal(a.cycle.cycle_day, b.cycle.cycle_day, `${label}: 第 ${i} 步 cycle_day 漂移`);
        assert.equal(a.cycle.phase, b.cycle.phase, `${label}: 第 ${i} 步 phase 漂移`);

        for (const dim of MOOD_KEYS) {
          maxDiff[dim] = Math.max(maxDiff[dim], Math.abs(a.mood[dim] - b.mood[dim]));
        }
        assertMoodEqual(a.mood, b.mood, item.strictEqual, `${label} 第 ${i} 步严格相等`);
      }

      // 只判定“差异是否存在”：mood 值经 round6，非零差异的最小可表示单位即 1e-6，
      // 因此 maxDiff > 0 等价于“存在差异”，不引入额外的业务幅值阈值。
      for (const dim of item.direct) {
        assert.ok(maxDiff[dim] > 0, `${label}: 直接维度 ${dim} 全程无差异（测试失效）`);
      }
      for (const dim of item.feedbackReach) {
        assert.ok(
          maxDiff[dim] > 0,
          `${label}: 反馈维度 ${dim} 全程无差异（未观察到反馈传播，只要求非零）`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// EC3：线性/仿射（反对称性），前置条件必须实际断言
// ---------------------------------------------------------------------------

/**
 * 反对称性只在下列前提全部成立时适用，且逐项断言：
 *   1) 三组使用完全相同的初始 state（并验证 advance 不修改入参）；
 *   2) 同一 RNG 游标出发，推进后随机流消耗完全一致；
 *   3) 周期轨迹一致（profile 不影响 cycle）；
 *   4) 单步未触发 clamp / applyLimits / [0,1] 边界（clamp 残差与警告都断言）。
 */
const EC3_CASES = [
  { name: 'pain_sensitivity', day: 5, dims: { physical_comfort: -1, energy: -1 }, vectorKeys: ['pain_load'] },
  { name: 'luteal_sensitivity', day: 22, dims: { stability: -1, sensitivity: +1 }, vectorKeys: ['anxiety_delta', 'irritability_delta'] },
  { name: 'mood_variability', day: 10, dims: { stability: +1, sensitivity: -1, social_drive: +1 }, vectorKeys: ['anxiety_delta', 'irritability_delta', 'positive_affect_delta'] },
  { name: 'intimacy_variability', day: 15, dims: { closeness_need: +1 }, vectorKeys: ['intimacy_need_delta'] }
];

const ANTISYMMETRY_TOL = 5e-6;

test('C2-E EC3：仿射参数满足反对称性（相同初始 state / 相同 RNG / 无裁剪）', () => {
  const d = 0.25;

  for (const item of EC3_CASES) {
    const base = anchoredState({ day: item.day });
    const snapshot = JSON.stringify(base);
    const now = new Date(Date.parse(T0) + HOUR_MS).toISOString();

    const captures = { neutral: [], plus: [], minus: [] };
    const neutral = advanceOnce(base, { profile: null, now, capture: captures.neutral });
    const plus = advanceOnce(base, { profile: { [item.name]: 1 + d }, now, capture: captures.plus });
    const minus = advanceOnce(base, { profile: { [item.name]: 1 - d }, now, capture: captures.minus });

    // 前提 1：同一初始 state，且 advance 未修改入参。
    assert.equal(JSON.stringify(base), snapshot, `${item.name}: advance 修改了入参 state`);
    // 前提 2：同一 RNG 游标出发，消耗完全一致。
    assert.deepEqual(neutral.state.random, plus.state.random, `${item.name}: RNG 消耗不一致（neutral vs plus）`);
    assert.deepEqual(neutral.state.random, minus.state.random, `${item.name}: RNG 消耗不一致（neutral vs minus）`);
    // 前提 3：周期轨迹一致。
    assert.deepEqual(neutral.state.cycle, plus.state.cycle, `${item.name}: 周期轨迹漂移（plus）`);
    assert.deepEqual(neutral.state.cycle, minus.state.cycle, `${item.name}: 周期轨迹漂移（minus）`);
    // 前提 4：单步未触发 mood 自身的裁剪。
    assertNoClamp(neutral.diagnostics, captures.neutral[0].warnings, `${item.name} neutral`);
    assertNoClamp(plus.diagnostics, captures.plus[0].warnings, `${item.name} plus`);
    assertNoClamp(minus.diagnostics, captures.minus[0].warnings, `${item.name} minus`);

    const neutralMood = moodOf(neutral.state);
    const plusMood = moodOf(plus.state);
    const minusMood = moodOf(minus.state);

    for (const [dim, direction] of Object.entries(item.dims)) {
      const deltaPlus = plusMood[dim] - neutralMood[dim];
      const deltaMinus = minusMood[dim] - neutralMood[dim];
      assert.ok(
        direction > 0 ? deltaPlus > 0 : deltaPlus < 0,
        `${item.name}: ${dim} 正向偏移方向错误，delta=${deltaPlus}`
      );
      assert.ok(
        direction > 0 ? deltaMinus < 0 : deltaMinus > 0,
        `${item.name}: ${dim} 负向偏移方向错误，delta=${deltaMinus}`
      );
      assert.ok(
        Math.abs(deltaPlus + deltaMinus) <= ANTISYMMETRY_TOL,
        `${item.name}: ${dim} 反对称性失败，|plus+minus|=${Math.abs(deltaPlus + deltaMinus)}`
      );
    }

    // phase_vector 本身是线性映射：三个输出必须满足 v(1+d) + v(1-d) = 2 v(1)。
    const vNeutral = captures.neutral[0].args.inputs.cycle.phase_vector;
    const vPlus = captures.plus[0].args.inputs.cycle.phase_vector;
    const vMinus = captures.minus[0].args.inputs.cycle.phase_vector;
    for (const key of item.vectorKeys) {
      const residual = Math.abs(vPlus[key] + vMinus[key] - 2 * vNeutral[key]);
      assert.ok(residual <= 3e-6, `${item.name}: phase_vector.${key} 线性残差 ${residual}`);
    }
  }
});

// ---------------------------------------------------------------------------
// EC4：mv × ls 双线性
// ---------------------------------------------------------------------------

const P_LUTEAL = 0.765;

function influenceAt(p, profile) {
  return phaseInfluence(p, CYCLE_LENGTH_DAYS, profile ? { cycle: { profile } } : {});
}

test('C2-E EC4：黄体区间内 mood_variability × luteal_sensitivity 呈双线性', () => {
  const w = phaseWeights(P_LUTEAL, CYCLE_LENGTH_DAYS);
  assert.equal(w.luteal_like, 1, 'EC4 锚点必须处于纯黄体区间');

  const f11 = influenceAt(P_LUTEAL, { mood_variability: 1, luteal_sensitivity: 1 });
  const fA1 = influenceAt(P_LUTEAL, { mood_variability: 1.5, luteal_sensitivity: 1 });
  const f1B = influenceAt(P_LUTEAL, { mood_variability: 1, luteal_sensitivity: 1.5 });
  const fAB = influenceAt(P_LUTEAL, { mood_variability: 1.5, luteal_sensitivity: 1.5 });
  const fA0 = influenceAt(P_LUTEAL, { mood_variability: 1.5, luteal_sensitivity: 0.5 });
  const f0B = influenceAt(P_LUTEAL, { mood_variability: 1, luteal_sensitivity: 0.5 });

  // 交叉差分 D(a,b) = f(a,b) - f(a,1) - f(1,b) + f(1,1) = γ·(a-1)·(b-1)
  for (const key of ['anxiety_delta', 'irritability_delta']) {
    const dPositive = fAB[key] - fA1[key] - f1B[key] + f11[key];
    const dNegative = fA0[key] - fA1[key] - f0B[key] + f11[key];

    assert.ok(dPositive > 0, `${key}: (a-1)(b-1)>0 时交叉项必须为正，实际 ${dPositive}`);
    assert.ok(dNegative < 0, `${key}: (a-1)(b-1)<0 时交叉项必须为负，实际 ${dNegative}`);
    assert.ok(
      Math.abs(dPositive + dNegative) <= 2e-6,
      `${key}: 双线性交叉项不对称，|D+ + D-|=${Math.abs(dPositive + dNegative)}`
    );
  }

  // 与 ls 无关或与 mv 无关的分量，其交叉差分必须为 0。
  for (const key of PHASE_VECTOR_KEYS_V2) {
    if (key === 'anxiety_delta' || key === 'irritability_delta') continue;
    const cross = fAB[key] - fA1[key] - f1B[key] + f11[key];
    assert.ok(Math.abs(cross) <= 2e-6, `${key}: 不应存在 mv×ls 交叉项，实际 ${cross}`);
  }

  // 旧四维不乘任何 profile。
  for (const key of ['physical_comfort', 'energy', 'sensitivity', 'social_drive']) {
    assert.equal(fAB[key], f11[key], `${key}: 旧四维不得被 profile 调制`);
  }
});

test('C2-E EC4-R：真实链路把 profile 透传到 cycle → mood 的 phase_vector', () => {
  const profile = { mood_variability: 1.5, luteal_sensitivity: 1.5 };
  const run = runSingle({ day: 22, profile });
  const p = progressOf(run.out.state);
  const expected = phaseInfluence(p, run.out.state.cycle.cycle_length_days, { cycle: { profile } });

  for (const key of PHASE_VECTOR_KEYS_V2) {
    assert.equal(run.vector[key], expected[key], `${key}: 真实链路 phase_vector 与 phaseInfluence 不一致`);
  }
});

// ---------------------------------------------------------------------------
// EC5：crossfade（直接调用 phaseInfluence）
// ---------------------------------------------------------------------------

test('C2-E EC5-E1：非黄体区间 w_l=0 时 ls 对九维输出无影响', () => {
  for (const p of [0.09, 0.31, 0.485]) {
    const w = phaseWeights(p, CYCLE_LENGTH_DAYS);
    assert.equal(w.luteal_like, 0, `p=${p}: 该点必须处于 w_l=0 区间（支撑矩阵前置）`);
    assert.deepEqual(
      influenceAt(p, { luteal_sensitivity: 1.5 }),
      influenceAt(p, {}),
      `p=${p}: w_l=0 时九维输出必须完全相等`
    );
  }
});

test('C2-E EC5-E2：纯黄体区间 w_l=1 时 ls 只放大焦虑/易激惹，其余七维不变', () => {
  const w = phaseWeights(P_LUTEAL, CYCLE_LENGTH_DAYS);
  assert.equal(w.luteal_like, 1, 'E2 锚点必须处于纯黄体区间');

  const base = influenceAt(P_LUTEAL, {});
  const variant = influenceAt(P_LUTEAL, { luteal_sensitivity: 1.5 });

  assert.ok(variant.anxiety_delta > base.anxiety_delta, 'anxiety_delta 应被放大');
  assert.ok(variant.irritability_delta > base.irritability_delta, 'irritability_delta 应被放大');

  const unchanged = PHASE_VECTOR_KEYS_V2.filter(
    (key) => key !== 'anxiety_delta' && key !== 'irritability_delta'
  );
  for (const key of unchanged) {
    assert.equal(variant[key], base[key], `${key}: 不应随 luteal_sensitivity 变化`);
  }
});

test('C2-E EC5-E3：黄体权重上升过程中 ls 差值单调非减，零支撑精确为零', () => {
  const START = 0.5;
  const END = 0.56;
  const STEP = 0.0025;

  const points = [];
  for (let i = 0; i <= Math.round((END - START) / STEP); i += 1) {
    const p = START + i * STEP;
    const w = phaseWeights(p, CYCLE_LENGTH_DAYS);
    const base = influenceAt(p, {});
    const variant = influenceAt(p, { luteal_sensitivity: 1.5 });
    points.push({
      p,
      wL: w.luteal_like,
      diffAnx: variant.anxiety_delta - base.anxiety_delta,
      diffIrr: variant.irritability_delta - base.irritability_delta
    });
  }

  assert.equal(points.length, 25, '采样点数必须为 25');
  assert.equal(points[0].wL, 0, '起点必须仍在零支撑区');
  assert.equal(points[points.length - 1].wL, 1, '终点必须进入纯黄体区');

  let sawTransition = false;
  let maxTransitionDiff = -Infinity;

  for (let i = 0; i < points.length; i += 1) {
    const { p, wL, diffAnx, diffIrr } = points[i];

    for (const [name, diff] of [['anxiety_delta', diffAnx], ['irritability_delta', diffIrr]]) {
      // 边界 1：零支撑区必须精确为 0。
      if (wL === 0) {
        assert.equal(diff, 0, `p=${p}: w_l=0 时 ${name} 差值必须精确为 0，实际 ${diff}`);
      }
      // 边界 2/3：符号方向只允许非负。
      assert.ok(diff >= 0, `p=${p}: ${name} 差值不应为负（${diff}）`);
      if (wL === 1) {
        assert.ok(diff > 0, `p=${p}: 纯黄体区 ${name} 差值必须为正（${diff}）`);
      }
      if (wL > 0 && wL < 1) {
        sawTransition = true;
        maxTransitionDiff = Math.max(maxTransitionDiff, diff);
      }
      // 边界 4：相邻点单调非减（容差 -1e-9）。
      if (i > 0) {
        const prev = i - 1;
        const prevDiff = name === 'anxiety_delta' ? points[prev].diffAnx : points[prev].diffIrr;
        assert.ok(
          diff - prevDiff >= -1e-9,
          `p=${p}: ${name} 差值随黄体权重下降（${prevDiff} → ${diff}）`
        );
      }
    }
  }

  assert.ok(sawTransition, '必须观察到 0<w_l<1 的 crossfade 过渡点');
  assert.ok(maxTransitionDiff > 0, '过渡区必须出现正的 ls 差值，证明 crossfade 生效');
});

// ---------------------------------------------------------------------------
// EC6：两跳反馈（图结构断言，不设幅值阈值）
// ---------------------------------------------------------------------------

test('C2-E EC6-A：ls → stability（第 1 步）→ threat_sensitivity（第 2 步）', () => {
  const base = anchoredState({ day: 22 });
  const t1 = new Date(Date.parse(T0) + HOUR_MS).toISOString();
  const t2 = new Date(Date.parse(T0) + 2 * HOUR_MS).toISOString();
  const profile = { luteal_sensitivity: 1.5 };

  // 第 1 步：同一个基线 state 的两次克隆，使用相同 RNG 状态。
  const a1 = advanceOnce(base, { profile: null, now: t1 });
  const b1 = advanceOnce(base, { profile, now: t1 });
  assert.deepEqual(a1.state.regulation, b1.state.regulation, '第 1 步不得出现 cycle→regulation 的同 tick 反馈');
  assert.ok(b1.state.mood.stability < a1.state.mood.stability, '第 1 步 stability 必须下降（直接映射）');
  assert.ok(b1.state.mood.sensitivity > a1.state.mood.sensitivity, '第 1 步 sensitivity 必须上升（直接映射）');

  // 第 2 步：从各自第 1 步的输出继续推进，而不是回到基线锚点。
  assert.notEqual(a1.state.mood.stability, b1.state.mood.stability, '第 2 步前两组状态必须已经分化');
  const a2 = advanceOnce(a1.state, { profile: null, now: t2 });
  const b2 = advanceOnce(b1.state, { profile, now: t2 });
  assert.ok(a2.state.cycle.cycle_day > a1.state.cycle.cycle_day, '第 2 步必须从第 1 步输出继续推进');
  assert.equal(a2.state.updated_at, t2);

  // 图结构：第 2 步 regulation 只有 threat_sensitivity 发生变化，其余五维精确相等。
  const regA = regOf(a2.state);
  const regB = regOf(b2.state);
  assert.ok(
    regB.threat_sensitivity > regA.threat_sensitivity,
    'stability 下降应经 mood_lag 推高 threat_sensitivity'
  );
  for (const key of REGULATION_KEYS) {
    if (key === 'threat_sensitivity') continue;
    assert.equal(regB[key], regA[key], `${key}: 第 2 步不应被 stability 路径影响`);
  }
  // 第 2 步 mood.sensitivity 仍高于对照组，且差值方向与直接映射一致。
  assert.ok(b2.state.mood.sensitivity > a2.state.mood.sensitivity, '第 2 步 sensitivity 必须仍高于对照组');
});

test('C2-E EC6-B：ps → energy（第 1 步）→ social_reassurance_drive（第 2 步）', () => {
  const base = anchoredState({ day: 5 });
  const t1 = new Date(Date.parse(T0) + HOUR_MS).toISOString();
  const t2 = new Date(Date.parse(T0) + 2 * HOUR_MS).toISOString();
  const profile = { pain_sensitivity: 0 };

  const a1 = advanceOnce(base, { profile: null, now: t1 });
  const b1 = advanceOnce(base, { profile, now: t1 });
  assert.deepEqual(a1.state.regulation, b1.state.regulation, '第 1 步不得出现 cycle→regulation 的同 tick 反馈');
  assert.ok(b1.state.mood.energy > a1.state.mood.energy, 'pain=0 时 energy 必须更高（直接映射）');

  const a2 = advanceOnce(a1.state, { profile: null, now: t2 });
  const b2 = advanceOnce(b1.state, { profile, now: t2 });
  assert.ok(a2.state.cycle.cycle_day > a1.state.cycle.cycle_day, '第 2 步必须从第 1 步输出继续推进');

  const regA = regOf(a2.state);
  const regB = regOf(b2.state);
  assert.ok(
    regB.social_reassurance_drive < regA.social_reassurance_drive,
    'energy 升高应经 mood_lag 压低 social_reassurance_drive'
  );
  for (const key of REGULATION_KEYS) {
    if (key === 'social_reassurance_drive') continue;
    assert.equal(regB[key], regA[key], `${key}: 第 2 步不应被 energy 路径影响`);
  }

  // 同 tick 的第二跳出口：SRD 同时写入 social_drive 与 closeness_need。
  assert.ok(b2.state.mood.social_drive < a2.state.mood.social_drive, 'SRD 下降应压低 social_drive');
  assert.ok(b2.state.mood.closeness_need < a2.state.mood.closeness_need, 'SRD 下降应压低 closeness_need');
});

test('C2-E EC6-C：iv → closeness_need（第 1 步）→ social_reassurance_drive（第 2 步）', () => {
  const base = anchoredState({ day: 15 }); // ovulatory，intimacy 分量 0.35
  const t1 = new Date(Date.parse(T0) + HOUR_MS).toISOString();
  const t2 = new Date(Date.parse(T0) + 2 * HOUR_MS).toISOString();
  const profile = { intimacy_variability: 1.5 };

  const a1 = advanceOnce(base, { profile: null, now: t1 });
  const b1 = advanceOnce(base, { profile, now: t1 });
  assert.deepEqual(a1.state.regulation, b1.state.regulation, '第 1 步不得出现 cycle→regulation 的同 tick 反馈');
  assert.ok(b1.state.mood.closeness_need > a1.state.mood.closeness_need, '第 1 步 closeness_need 必须上升');

  // 第 1 步是纯直接映射：除 closeness_need 外六维必须精确相等。
  for (const dim of MOOD_KEYS) {
    if (dim === 'closeness_need') continue;
    assert.equal(
      b1.state.mood[dim],
      a1.state.mood[dim],
      `第 1 步 ${dim} 不应被 intimacy 直接影响`
    );
  }

  // 第 2 步从各自第 1 步输出继续推进。
  const a2 = advanceOnce(a1.state, { profile: null, now: t2 });
  const b2 = advanceOnce(b1.state, { profile, now: t2 });
  assert.ok(a2.state.cycle.cycle_day > a1.state.cycle.cycle_day, '第 2 步必须从第 1 步输出继续推进');

  // 图结构：closeness_need 上升 → SRD 上升；其余五个 regulation 维精确相等。
  const regA = regOf(a2.state);
  const regB = regOf(b2.state);
  assert.ok(
    regB.social_reassurance_drive > regA.social_reassurance_drive,
    'closeness_need 上升应经 mood_lag 推高 social_reassurance_drive'
  );
  for (const key of REGULATION_KEYS) {
    if (key === 'social_reassurance_drive') continue;
    assert.equal(regB[key], regA[key], `${key}: 第 2 步不应被 closeness_need 路径影响`);
  }

  // 同 tick 出口：SRD 上升应推高 social_drive；
  // closeness_need 自身同时受 recovery 拉动，净方向不稳定，因此断言其 regulation 来源增量。
  assert.ok(b2.state.mood.social_drive > a2.state.mood.social_drive, 'SRD 上升应推高 social_drive');
  assert.ok(
    b2.diagnostics.contributions['mood.closeness_need'].regulation >
      a2.diagnostics.contributions['mood.closeness_need'].regulation,
    'SRD 上升应推高 closeness_need 的 regulation 来源'
  );
});

test('C2-E EC6-D：mv → stability（第 1 步）→ threat_sensitivity（第 2 步）', () => {
  const base = anchoredState({ day: 10 }); // follicular，anx/irr/pos 均非零
  const t1 = new Date(Date.parse(T0) + HOUR_MS).toISOString();
  const t2 = new Date(Date.parse(T0) + 2 * HOUR_MS).toISOString();
  const profile = { mood_variability: 1.5 };

  const a1 = advanceOnce(base, { profile: null, now: t1 });
  const b1 = advanceOnce(base, { profile, now: t1 });
  assert.deepEqual(a1.state.regulation, b1.state.regulation, '第 1 步不得出现 cycle→regulation 的同 tick 反馈');
  assert.ok(b1.state.mood.stability > a1.state.mood.stability, '第 1 步 stability 必须上升（直接映射）');
  assert.ok(b1.state.mood.sensitivity < a1.state.mood.sensitivity, '第 1 步 sensitivity 必须下降（直接映射）');
  assert.ok(b1.state.mood.social_drive > a1.state.mood.social_drive, '第 1 步 social_drive 必须上升（直接映射）');

  // 第 1 步是纯直接映射：其余四维必须精确相等。
  for (const dim of ['energy', 'closeness_need', 'physical_comfort', 'stress']) {
    assert.equal(b1.state.mood[dim], a1.state.mood[dim], `第 1 步 ${dim} 不应被 mv 直接影响`);
  }

  // 第 2 步从各自第 1 步输出继续推进。
  const a2 = advanceOnce(a1.state, { profile: null, now: t2 });
  const b2 = advanceOnce(b1.state, { profile, now: t2 });
  assert.ok(a2.state.cycle.cycle_day > a1.state.cycle.cycle_day, '第 2 步必须从第 1 步输出继续推进');

  // 图结构：stability 上升 → threat_sensitivity 下降；其余五个 regulation 维精确相等。
  const regA = regOf(a2.state);
  const regB = regOf(b2.state);
  assert.ok(
    regB.threat_sensitivity < regA.threat_sensitivity,
    'stability 上升应经 mood_lag 压低 threat_sensitivity'
  );
  for (const key of REGULATION_KEYS) {
    if (key === 'threat_sensitivity') continue;
    assert.equal(regB[key], regA[key], `${key}: 第 2 步不应被 stability 路径影响`);
  }
  assert.ok(b2.state.mood.sensitivity < a2.state.mood.sensitivity, '第 2 步 sensitivity 必须仍低于对照组');
});
