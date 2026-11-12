/**
 * 08 神经调节特征模块。
 *
 * 只写 regulation.*，只产出中性抽象特征；全部为虚构角色状态模拟，不包含任何
 * 真实递质、浓度、受体或医学指标语义。
 */

import { INTERFACE_VERSION, LIMITS, REGULATION_KEYS } from '../../core/constants.mjs';
import { parseTime } from '../../core/clock.mjs';

import { cycleScalars, isKnownCyclePhase } from './cycle-map.mjs';
import { stepInertia } from './inertia.mjs';
import {
  arousalTerms,
  calmRegulationTerms,
  comfortSignal,
  fatigueLoadTerms,
  rewardSensitivityTerms,
  socialReassuranceDriveTerms,
  threatSensitivityTerms
} from './targets.mjs';

const MODEL_VERSION = 1;

/** 08 §5.6 的 reason_code 阈值，与 09 §5.6 保持一致。 */
const SLEEP_DEBT_HIGH = 0.5;
const STRESS_HIGH = 0.55;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * 惯性使用的 target 保留公式全精度，只在 [0,1] 边界钳制。
 * 公开的 target* 按 08 §5.3 再做 round6；此处不 round6 是为了让八来源贡献之和
 * 与 next - previous 精确闭合（§5.5）。
 */
function targetValue(terms) {
  let sum = 0;
  for (const value of Object.values(terms)) sum += value;
  return clamp01(sum);
}

/** 上一 tick 的 regulation 六维；缺键降级（疲劳取 0.30，其余 0.50），非有限值拒绝。 */
function readPrevious(previous) {
  const values = {};
  let missing = false;
  let clamped = false;
  const hasAny = REGULATION_KEYS.some((key) => {
    const raw = previous?.[key];
    return raw !== undefined && raw !== null;
  });
  for (const key of REGULATION_KEYS) {
    const raw = previous?.[key];
    if (raw === undefined || raw === null) {
      values[key] = hasAny && key === 'fatigue_load' ? 0.3 : 0.5;
      missing = true;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw contractError('INVALID_REQUEST', `regulation.${key} must be a finite number`, {
        path: `regulation.${key}`,
        got: String(raw)
      });
    }
    if (raw < 0 || raw > 1) {
      values[key] = clamp01(raw);
      clamped = true;
      continue;
    }
    values[key] = raw;
  }
  return { values, missing, clamped };
}

/** 读取上游标量：缺失/非有限值用契约默认值，有限越界先 clamp。 */
function readUpstream(source, key, fallback, flags) {
  const raw = source && typeof source === 'object' ? source[key] : undefined;
  if (raw === undefined || raw === null || typeof raw !== 'number' || !Number.isFinite(raw)) {
    flags.missing = true;
    return fallback;
  }
  if (raw < 0 || raw > 1) {
    flags.clamped = true;
    return clamp01(raw);
  }
  return raw;
}

/**
 * 00 v1.7.6 §4.1 / 08 §4.2：dt 必须由 02 显式传入（整数秒，≥ 0）。
 * 模块不得从 now - last_tick_at 推算，也不得兜底默认值；缺失即 MODULE_FAILED。
 */
function requireDtSeconds({ inputs }) {
  const value = inputs?.dt;
  if (!Number.isInteger(value) || value < 0) {
    throw contractError('MODULE_FAILED', 'inputs.dt must be a non-negative integer (seconds)', {
      module: 'regulation',
      path: 'inputs.dt',
      dt: value
    });
  }
  return value;
}

/**
 * 08 §4.1：神经调节特征推进。
 *
 * @param {{previous:object, inputs:object, now:string, rng:object, config:object}} params
 * @returns {object} ModuleResult
 */
export function updateRegulation({ previous, inputs, now, rng, config } = {}) {
  const warnings = [];
  const reasonCodes = [];

  const previousState = readPrevious(previous);
  if (previousState.missing) {
    warnings.push('MISSING_REGULATION_DATA');
    warnings.push('DEGRADED');
  }
  if (previousState.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const sleepInput = inputs?.sleep;
  const sleepFlags = { missing: false, clamped: false };
  const sleepDebt = readUpstream(sleepInput, 'sleep_debt', 0.15, sleepFlags);
  const sleepQuality = readUpstream(sleepInput, 'sleep_quality', 0.7, sleepFlags);
  const sleepiness = readUpstream(sleepInput, 'sleepiness', 0.25, sleepFlags);
  if (sleepFlags.missing) warnings.push('MISSING_SLEEP_DATA');
  if (sleepFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const stressInput = inputs?.stress;
  const stressFlags = { missing: false, clamped: false };
  const stressLevel = readUpstream(stressInput, 'level', 0.15, stressFlags);
  const activeEvents = Array.isArray(stressInput?.active_events) ? stressInput.active_events : [];
  if (stressFlags.missing) warnings.push('MISSING_STRESS_DATA');

  const lagInput = inputs?.mood;
  const lagFlags = { missing: false, clamped: false };
  const energy = readUpstream(lagInput, 'energy', 0.6, lagFlags);
  const stability = readUpstream(lagInput, 'stability', 0.65, lagFlags);
  const closenessNeed = readUpstream(lagInput, 'closeness_need', 0.45, lagFlags);
  if (lagFlags.missing) warnings.push('MISSING_MOOD_DATA');
  if (lagFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const cycleInput = inputs?.cycle;
  const phase = cycleInput && typeof cycleInput === 'object' ? cycleInput.phase : undefined;
  const cycleKnown = isKnownCyclePhase(phase);
  if (!cycleKnown) {
    warnings.push('MISSING_CYCLE_DATA');
    pushUnique(reasonCodes, 'cycle_data_missing');
  }
  const scalars = cycleScalars(phase);
  const comfort = comfortSignal(activeEvents);

  const dtSeconds = requireDtSeconds({ inputs });

  const termSets = {
    reward_sensitivity: rewardSensitivityTerms({
      cycle_reward: scalars.cycle_reward,
      sleep_debt: sleepDebt,
      stress: stressLevel,
      comfort_signal: comfort,
      previous_fatigue_load: previousState.values.fatigue_load
    }),
    arousal: arousalTerms({
      cycle_energy: scalars.cycle_energy,
      sleep_debt: sleepDebt,
      sleepiness,
      stress: stressLevel
    }),
    threat_sensitivity: threatSensitivityTerms({
      stress: stressLevel,
      cycle_sensitivity: scalars.cycle_sensitivity,
      sleep_debt: sleepDebt,
      stability
    }),
    calm_regulation: calmRegulationTerms({
      sleep_quality: sleepQuality,
      stress: stressLevel,
      previous_fatigue_load: previousState.values.fatigue_load
    }),
    social_reassurance_drive: socialReassuranceDriveTerms({
      closeness_need: closenessNeed,
      energy,
      stress: stressLevel,
      cycle_social: scalars.cycle_social
    }),
    fatigue_load: fatigueLoadTerms({
      sleep_debt: sleepDebt,
      sleep_quality: sleepQuality,
      sleepiness
    })
  };

  const state = {};
  const contributions = {};
  let clampedDelta = false;
  let saturatedHigh = false;
  let saturatedLow = false;

  for (const key of REGULATION_KEYS) {
    const target = targetValue(termSets[key]);
    const stepped = stepInertia({
      previous: previousState.values[key],
      target,
      dtSeconds,
      terms: termSets[key]
    });
    state[key] = stepped.next;
    contributions[`regulation.${key}`] = stepped.contributions;
    if (stepped.clamped) clampedDelta = true;
    if (stepped.saturatedHigh) saturatedHigh = true;
    if (stepped.saturatedLow) saturatedLow = true;
  }
  state.model_version = MODEL_VERSION;

  if (sleepDebt >= SLEEP_DEBT_HIGH) pushUnique(reasonCodes, 'sleep_debt_high');
  if (stressLevel >= STRESS_HIGH) pushUnique(reasonCodes, 'stress_high');
  if (comfort > 0) pushUnique(reasonCodes, 'comfort_received');
  if (cycleKnown && phase === 'luteal_like') pushUnique(reasonCodes, 'luteal_like');
  if (cycleKnown && phase === 'menstrual_like') pushUnique(reasonCodes, 'menstrual_like');
  if (clampedDelta) {
    pushUnique(warnings, 'CLAMPED_DELTA');
    pushUnique(reasonCodes, 'clamped_delta');
  }
  if (saturatedHigh) pushUnique(reasonCodes, 'saturated_high');
  if (saturatedLow) pushUnique(reasonCodes, 'saturated_low');

  return {
    state,
    contributions,
    reason_codes: reasonCodes.slice(0, LIMITS.maxReasonCodes),
    warnings: warnings.slice(0, LIMITS.maxWarnings),
    next_transition_at: null,
    diagnostics: {
      module: 'regulation',
      model_version: MODEL_VERSION,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0
    }
  };
}

export const regulationModule = {
  name: 'regulation',
  update: updateRegulation
};

export { cycleScalars } from './cycle-map.mjs';
export {
  comfortSignal,
  targetArousal,
  targetCalmRegulation,
  targetFatigueLoad,
  targetRewardSensitivity,
  targetSocialReassuranceDrive,
  targetThreatSensitivity
} from './targets.mjs';
export { blendFor, stepInertia } from './inertia.mjs';

export default regulationModule;
