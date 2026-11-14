/**
 * 05 · 生理周期模块入口：updateCycle 与 ModuleResult 组装。
 *
 * 虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或现实健康预测。
 * 只写 `state.cycle`，只输出 `derived.phase_impact`（**九维** phase_impact，v1.7.14 周期扩展）。
 * 九维字段：physical_comfort / energy / sensitivity / social_drive（旧四维）
 *          + pain_load / anxiety_delta / irritability_delta / positive_affect_delta / intimacy_need_delta（新五维）。
 */

import {
  CYCLE_PHASES,
  CYCLE_MODEL_VERSION,
  INTERFACE_VERSION,
  LIMITS,
  PHASE_VECTOR_KEYS_V2
} from '../../core/constants.mjs';
import { parseTime, toIso } from '../../core/clock.mjs';
import { round6 } from '../../core/models.mjs';

import { phaseDetail, phaseInfluence } from './phase.mjs';
import {
  advanceCycleDays,
  applyManualCorrection,
  resolveCycleConfig,
  sampleCycleLength
} from './advance.mjs';

const MS_PER_DAY = 86_400_000;
const TOL = 1e-9;
const DAY_EPSILON = 1e-5;

const DEGRADED_CYCLE = Object.freeze({
  cycle_index: 0,
  cycle_length_days: 28.4,
  cycle_length_source: 'sampled',
  cycle_day: 1,
  phase: 'menstrual_like',
  phase_progress: 0,
  confidence: 0.4,
  model_version: CYCLE_MODEL_VERSION
});

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = code === 'DEGRADED';
  if (details) err.details = details;
  return err;
}

function moduleFailed(message, details) {
  return contractError('MODULE_FAILED', message, { module: 'cycle', ...(details ?? {}) });
}

function isIso(value) {
  if (typeof value !== 'string') return false;
  try {
    parseTime(value, 'cycle');
    return true;
  } catch {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 缺字段的判定只针对"无法计算"的核心字段；可推导字段缺失会重算。 */
function isUsable(previous) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false;
  const required = [
    'anchor_at',
    'cycle_index',
    'cycle_length_days',
    'cycle_day',
    'phase',
    'phase_progress',
    'confidence'
  ];
  for (const key of required) {
    if (previous[key] === undefined || previous[key] === null) return false;
  }
  if (!isIso(previous.anchor_at)) return false;
  if (!Number.isInteger(previous.cycle_index) || previous.cycle_index < 0) return false;
  if (!Number.isFinite(previous.cycle_length_days)) return false;
  if (!Number.isFinite(previous.cycle_day)) return false;
  if (!CYCLE_PHASES.includes(previous.phase)) return false;
  if (!Number.isFinite(previous.phase_progress)) return false;
  if (!Number.isFinite(previous.confidence)) return false;
  return true;
}

function normalizePrevious(previous) {
  const length = round6(
    clamp(previous.cycle_length_days, LIMITS.minCycleLengthDays, LIMITS.maxCycleLengthDays)
  );
  const day = round6(clamp(previous.cycle_day, 1, length));
  const source = previous.cycle_length_source === 'manual'
    ? 'manual'
    : previous.cycle_length_source === 'default'
      ? 'default'
      : 'sampled';
  const detail = phaseDetail((day - 1) / length);
  const anchorMs = parseTime(previous.anchor_at, 'cycle.anchor_at');
  return {
    anchor_at: previous.anchor_at,
    cycle_index: previous.cycle_index,
    cycle_length_days: length,
    cycle_length_source: source,
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: toIso(Math.floor(anchorMs + detail.phase_start * length * MS_PER_DAY)),
    phase_progress: detail.phase_progress,
    confidence: round6(clamp(previous.confidence, 0, 1)),
    // 只读加载由存储层原样返回；进入当前九维计算后，新输出统一标记为 v2。
    model_version: CYCLE_MODEL_VERSION
  };
}

function finalizePhase(cycle) {
  const length = cycle.cycle_length_days;
  const day = round6(clamp(cycle.cycle_day, 1, length));
  const detail = phaseDetail((day - 1) / length);
  const anchorMs = parseTime(cycle.anchor_at, 'cycle.anchor_at');
  return {
    ...cycle,
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: toIso(Math.floor(anchorMs + detail.phase_start * length * MS_PER_DAY)),
    phase_progress: detail.phase_progress
  };
}

function diagnostics() {
  return {
    module: 'cycle',
    model_version: CYCLE_MODEL_VERSION,
    interface_version: INTERFACE_VERSION,
    elapsed_ms: 0
  };
}

function degradedResult(now) {
  const state = {
    anchor_at: now,
    cycle_index: DEGRADED_CYCLE.cycle_index,
    cycle_length_days: DEGRADED_CYCLE.cycle_length_days,
    cycle_length_source: DEGRADED_CYCLE.cycle_length_source,
    cycle_day: DEGRADED_CYCLE.cycle_day,
    phase: DEGRADED_CYCLE.phase,
    phase_started_at: now,
    phase_progress: DEGRADED_CYCLE.phase_progress,
    confidence: DEGRADED_CYCLE.confidence,
    model_version: DEGRADED_CYCLE.model_version
  };
  return {
    state,
    contributions: {
      'cycle.phase_progress': { cycle: 0 },
      'cycle.confidence': { cycle: 0 }
    },
    reason_codes: [],
    warnings: ['MISSING_CYCLE_DATA'],
    next_transition_at: null,
    diagnostics: diagnostics()
  };
}

function sampleDefaultLength(cycle, rng, config) {
  if (cycle.cycle_length_source !== 'default') return cycle;
  // 00 v1.7.6 §3.2：default 是初始化临时态，首次 updateCycle 必须消耗 1 次 nextNormal() 采样。
  // 缺 rng 时不得静默当作 sampled（否则 28 会被误当成采样结果），必须失败。
  if (!rng || typeof rng.nextNormal !== 'function') {
    throw contractError('MODULE_FAILED', 'cycle_length_source=default requires a nextNormal() sample', {
      module: 'cycle',
      reason: 'cycle_source_unresolved'
    });
  }
  const length = sampleCycleLength(cycle.cycle_index, rng, config);
  return { ...cycle, cycle_length_days: length, cycle_length_source: 'sampled' };
}

/**
 * 05 §4.1：周期模块统一入口。
 *
 * @param {{previous:object, inputs:object, now:string, rng:object, config:object,
 *          rngProvider?:object}} params
 * @returns {object} ModuleResult
 */
export function updateCycle({ previous, inputs = {}, now, rng, config = {}, rngProvider = null } = {}) {
  if (typeof now !== 'string') {
    throw contractError('INVALID_REQUEST', 'now is required (UTC ISO 8601 with milliseconds)', {
      path: 'now'
    });
  }
  const nowMs = parseTime(now, 'now');

  // 配置先校验；非法配置必须拒绝，而不是带着坏参数继续算。
  resolveCycleConfig(config);

  if (!isUsable(previous)) {
    return degradedResult(now);
  }

  const anchorMs = parseTime(previous.anchor_at, 'cycle.anchor_at');
  if (nowMs < anchorMs) {
    throw moduleFailed('now is earlier than cycle.anchor_at', {
      path: 'now',
      now,
      anchor_at: previous.anchor_at
    });
  }

  const warnings = [];
  const reason_codes = [];
  let cycle = normalizePrevious(previous);

  const hasManualAnchor = inputs.manual_anchor_at !== undefined && inputs.manual_anchor_at !== null;
  const hasManualLength =
    inputs.manual_cycle_length_days !== undefined && inputs.manual_cycle_length_days !== null;

  if (hasManualAnchor || hasManualLength) {
    cycle = applyManualCorrection({
      cycle,
      now,
      manual_anchor_at: hasManualAnchor ? inputs.manual_anchor_at : null,
      manual_cycle_length_days: hasManualLength ? inputs.manual_cycle_length_days : null
    });
    reason_codes.push('cycle_manual_correction');
  } else {
    cycle = sampleDefaultLength(cycle, rng, config);
    const elapsedDays = (nowMs - anchorMs) / MS_PER_DAY;
    // cycle.cycle_day 以 6 位小数落盘，周期回绕时 anchor_at 也会随之平移，因此
    // 同一次推进的 predict 轮会读到 ±1e-6 天的舍入噪声。负向噪声不应被判定为
    // "cycle_day 超前"（那会让合法推进随机 MODULE_FAILED）；仅超过 1e-5 天才报错。
    const rawDelta = elapsedDays + 1 - cycle.cycle_day;
    const deltaDays = rawDelta >= 0 ? round6(rawDelta) : rawDelta < -DAY_EPSILON ? rawDelta : 0;
    if (deltaDays > TOL) {
      cycle = advanceCycleDays({ cycle, deltaDays, rngProvider, config, warnings });
    } else if (deltaDays < -TOL) {
      throw moduleFailed('cycle_day is ahead of the elapsed time', {
        path: 'cycle.cycle_day',
        cycle_day: cycle.cycle_day,
        elapsed_days: round6(elapsedDays)
      });
    }
  }

  cycle = finalizePhase(cycle);

  const length = cycle.cycle_length_days;
  const phaseProgress = cycle.phase_progress;
  const progressP = (cycle.cycle_day - 1) / length;
  const phaseVector = phaseInfluence(progressP, length, config);

  const contributions = {
    'cycle.phase_progress': { cycle: round6(phaseProgress - previous.phase_progress) },
    'cycle.confidence': { cycle: round6(cycle.confidence - previous.confidence) }
  };

  return {
    state: {
      anchor_at: cycle.anchor_at,
      cycle_index: cycle.cycle_index,
      cycle_length_days: round6(length),
      cycle_length_source: cycle.cycle_length_source,
      cycle_day: round6(cycle.cycle_day),
      phase: cycle.phase,
      phase_started_at: cycle.phase_started_at,
      phase_progress: phaseProgress,
      confidence: round6(cycle.confidence),
      model_version: cycle.model_version
    },
    contributions,
    reason_codes,
    warnings,
    next_transition_at: null,
    derived: {
      phase_impact: Object.fromEntries(
        PHASE_VECTOR_KEYS_V2.map((key) => [key, phaseVector[key]])
      )
    },
    diagnostics: diagnostics()
  };
}

/** 05 §7：协调器通过 `{ name, update, advanceCycleDays }` 注入粗推进钩子。 */
export const cycleModule = {
  name: 'cycle',
  update: updateCycle,
  advanceCycleDays
};
