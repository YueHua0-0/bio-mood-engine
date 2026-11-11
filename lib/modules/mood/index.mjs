/**
 * 09 情绪计算引擎：唯一写入 mood.* 的模块。
 *
 * 全部为虚构角色状态模拟：home / tau / 权重均为契约冻结的虚构参数，
 * 不包含任何真实心理测量或医学语义。
 *
 * 硬性契约：
 * - inputs.dt 由 02 显式传入（整数秒，>= 0），缺失或非法即 MODULE_FAILED；
 *   不得从 now - last_tick_at 推算，也不得兜底（00 v1.7.6 §4.1）。
 * - inputs.event.intensity 只来自 07 的 derived.event_intensity，缺失为 null；
 *   只用于 severity_high，绝不产生 event 贡献（I7）。
 * - inputs.mood 不存在（09 §4.2 只声明 previous），不得私读。
 * - 噪声每 tick 固定消耗 14 个 float，与 dt 无关；dt = 0 时 alpha 精确为 0。
 */

import {
  CYCLE_PHASES,
  CYCLE_SCALARS,
  CYCLE_SCALARS_FALLBACK,
  INTERFACE_VERSION,
  LIMITS,
  MOOD_HOME,
  MOOD_KEYS
} from '../../core/constants.mjs';
import { round6 } from '../../core/models.mjs';

import {
  PHASE_VECTOR_KEYS,
  cycleTerms,
  recoveryTerm,
  regulationTerms,
  sleepTerms,
  stressTerms
} from './contributions.mjs';
import { alphaFor, applyLimits } from './inertia.mjs';
import { noiseFor } from './noise.mjs';
import { buildReasonCodes } from './reasons.mjs';

const MODEL_VERSION = 1;
const SLEEP_DEFAULTS = Object.freeze({ sleep_debt: 0.15, sleep_quality: 0.7, sleepiness: 0.25 });
const STRESS_DEFAULT = 0.15;
const REGULATION_DEFAULT = 0.5;
const SEVERE_THRESHOLD = 0.7;
const REGULATION_KEYS = Object.freeze([
  'reward_sensitivity',
  'arousal',
  'threat_sensitivity',
  'calm_regulation',
  'social_reassurance_drive',
  'fatigue_load'
]);

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
 * 00 v1.7.6 §4.1 / 09 §4.2：dt 必须显式传入且为非负整数秒。
 * 不得用 now - last_tick_at 推算；缺失即 MODULE_FAILED。
 */
function requireDtSeconds({ inputs }) {
  const value = inputs?.dt;
  if (!Number.isInteger(value) || value < 0) {
    throw contractError('MODULE_FAILED', 'inputs.dt must be a non-negative integer (seconds)', {
      module: 'mood',
      path: 'inputs.dt',
      dt: value
    });
  }
  return value;
}

/** 缺失（undefined/null）用 fallback；存在但非有限数值视为输入损坏，拒绝推进。 */
function readField(source, key, fallback, path, flags) {
  const raw = source && typeof source === 'object' ? source[key] : undefined;
  if (raw === undefined || raw === null) {
    flags.missing = true;
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw contractError('INVALID_REQUEST', `${path} must be a finite number`, {
      path,
      got: String(raw)
    });
  }
  if (raw < 0 || raw > 1) {
    flags.clamped = true;
    return clamp01(raw);
  }
  return raw;
}

/** 09 §5.6 / §6：缺 previous 任一分量用 home，不得用 0 代替。 */
function readPrevious(previous) {
  const values = {};
  const flags = { missing: false, clamped: false };
  for (const key of MOOD_KEYS) {
    values[key] = readField(previous, key, MOOD_HOME[key], `previous.${key}`, flags);
  }
  return { values, missing: flags.missing, clamped: flags.clamped };
}

/**
 * 09 §4.2 / §5.6：phase_vector 必须来自 05 的 derived.phase_impact。
 * 降级时 05 省略 derived，协调器不传改键；本模块按全 0 向量计算。
 */
function readPhaseVector(cycleInput) {
  const raw = cycleInput && typeof cycleInput === 'object' ? cycleInput.phase_vector : undefined;
  if (raw === undefined || raw === null) {
    const zeros = {};
    for (const key of PHASE_VECTOR_KEYS) zeros[key] = 0;
    return { vector: zeros, missing: true };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw contractError('INVALID_REQUEST', 'inputs.cycle.phase_vector must be an object', {
      path: 'inputs.cycle.phase_vector',
      got: typeof raw
    });
  }
  const vector = {};
  for (const key of PHASE_VECTOR_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) {
      vector[key] = 0;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw contractError('INVALID_REQUEST', `inputs.cycle.phase_vector.${key} must be a finite number`, {
        path: `inputs.cycle.phase_vector.${key}`,
        got: String(value)
      });
    }
    vector[key] = Math.min(1, Math.max(-1, value));
  }
  return { vector, missing: false };
}

/** 09 §4.2：只读 07 的派生强度；缺失为 null，不回退原始 event.intensity。 */
function readEventIntensity(inputs) {
  const raw = inputs?.event?.intensity;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw contractError('INVALID_REQUEST', 'inputs.event.intensity must be a finite number or null', {
      path: 'inputs.event.intensity',
      got: String(raw)
    });
  }
  return clamp01(raw);
}

/** 09 §4.1：`cycleContribution(phase, vec)`，stability 的偏移取 08 §5.1 冻结表。 */
export function cycleContribution(phase, vec) {
  const scalars = CYCLE_SCALARS[phase];
  const sensitivity = scalars ? scalars.cycle_sensitivity : CYCLE_SCALARS_FALLBACK;
  return cycleTerms(vec, sensitivity);
}

/** 09 §4.1：四个上游来源的原始项（尚未乘 alpha）。 */
export function computeContributions({ vector, cycleSensitivity, sleep, stressLevel, previousStress, regulation }) {
  return {
    cycle: cycleTerms(vector, cycleSensitivity),
    sleep: sleepTerms(sleep),
    stress: stressTerms({ level: stressLevel, previousStress }),
    regulation: regulationTerms(regulation)
  };
}

/**
 * 09 §4.1 / §5.2：七维推进。
 *
 * @param {{previous:object, inputs:object, now:string, rng:object, config:object}} params
 * @returns {object} ModuleResult
 */
export function updateMood({ previous, inputs, now, rng, config } = {}) {
  void now;
  void config;
  const dt = requireDtSeconds({ inputs });

  const warnings = [];
  const prev = readPrevious(previous);
  if (prev.missing) {
    warnings.push('MISSING_MOOD_DATA', 'DEGRADED');
  }
  if (prev.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const sleepFlags = { missing: false, clamped: false };
  const sleep = {
    sleep_debt: readField(inputs?.sleep, 'sleep_debt', SLEEP_DEFAULTS.sleep_debt, 'inputs.sleep.sleep_debt', sleepFlags),
    sleep_quality: readField(inputs?.sleep, 'sleep_quality', SLEEP_DEFAULTS.sleep_quality, 'inputs.sleep.sleep_quality', sleepFlags),
    sleepiness: readField(inputs?.sleep, 'sleepiness', SLEEP_DEFAULTS.sleepiness, 'inputs.sleep.sleepiness', sleepFlags)
  };
  if (sleepFlags.missing) warnings.push('MISSING_SLEEP_DATA');
  if (sleepFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const stressFlags = { missing: false, clamped: false };
  const stressLevel = readField(inputs?.stress, 'level', STRESS_DEFAULT, 'inputs.stress.level', stressFlags);
  if (stressFlags.missing) warnings.push('MISSING_STRESS_DATA');
  if (stressFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const regulationFlags = { missing: false, clamped: false };
  const regulation = {};
  for (const key of REGULATION_KEYS) {
    regulation[key] = readField(
      inputs?.regulation,
      key,
      REGULATION_DEFAULT,
      `inputs.regulation.${key}`,
      regulationFlags
    );
  }
  if (regulationFlags.missing) warnings.push('MISSING_REGULATION_DATA');
  if (regulationFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const vectorRead = readPhaseVector(inputs?.cycle);
  const scalarFlags = { missing: false, clamped: false };
  const cycleSensitivity = readField(
    inputs?.cycle?.scalars,
    'cycle_sensitivity',
    CYCLE_SCALARS_FALLBACK,
    'inputs.cycle.scalars.cycle_sensitivity',
    scalarFlags
  );
  if (vectorRead.missing || scalarFlags.missing) warnings.push('MISSING_CYCLE_DATA');
  if (scalarFlags.clamped) pushUnique(warnings, 'INPUT_CLAMPED');

  const phase = inputs?.cycle?.phase;
  const knownPhase = CYCLE_PHASES.includes(phase) ? phase : null;

  const intensity = readEventIntensity(inputs);
  const severityHigh = intensity !== null && intensity >= SEVERE_THRESHOLD;

  const noise = noiseFor(rng);
  const rawTerms = computeContributions({
    vector: vectorRead.vector,
    cycleSensitivity,
    sleep: {
      sleepDebt: sleep.sleep_debt,
      sleepQuality: sleep.sleep_quality,
      sleepiness: sleep.sleepiness
    },
    stressLevel,
    previousStress: prev.values.stress,
    regulation
  });

  const state = {};
  const contributions = {};
  let anyClamped = false;

  for (const dim of MOOD_KEYS) {
    const alpha = alphaFor(dim, dt);
    const raw = {
      cycle: rawTerms.cycle[dim] * alpha,
      sleep: rawTerms.sleep[dim] * alpha,
      stress: rawTerms.stress[dim] * alpha,
      regulation: rawTerms.regulation[dim] * alpha,
      recovery: recoveryTerm(dim, prev.values[dim]) * alpha,
      noise: noise[dim],
      event: 0
    };
    // I7：事件只经 07 的 stress 通道进入，本模块的 event 项恒为 0。
    if (raw.event !== 0) {
      throw contractError('MODULE_FAILED', 'event contribution must stay 0 (I7)', {
        module: 'mood',
        path: `mood.${dim}.event`
      });
    }

    let deltaRaw = 0;
    for (const source of Object.keys(raw)) deltaRaw += raw[source];

    const limited = applyLimits(prev.values[dim], deltaRaw, severityHigh);
    if (limited.clamped) anyClamped = true;

    const previousRounded = round6(prev.values[dim]);
    const nextRounded = round6(limited.next);
    state[dim] = nextRounded;

    const rounded = {};
    let accounted = 0;
    for (const source of ['cycle', 'sleep', 'stress', 'regulation', 'recovery', 'noise', 'event']) {
      rounded[source] = round6(raw[source]);
      accounted += rounded[source];
    }
    // clamp 吸收裁剪与 [0,1] 边界，保证八项之和精确等于 next - previous（M15）。
    rounded.clamp = round6(nextRounded - previousRounded - accounted);
    contributions[`mood.${dim}`] = rounded;
  }
  state.model_version = MODEL_VERSION;

  if (anyClamped) {
    pushUnique(warnings, 'CLAMPED_DELTA');
  }

  const missingUpstream = warnings.some((code) => code.startsWith('MISSING_') && code !== 'MISSING_MOOD_DATA');
  const reasonCodes = buildReasonCodes({
    sleepDebt: sleep.sleep_debt,
    stressLevel,
    phase: knownPhase,
    contributions,
    next: state,
    clamped: anyClamped,
    missingUpstream
  });

  return {
    state,
    contributions,
    reason_codes: reasonCodes.slice(0, LIMITS.maxReasonCodes),
    warnings: warnings.slice(0, LIMITS.maxWarnings),
    next_transition_at: null,
    diagnostics: {
      module: 'mood',
      model_version: MODEL_VERSION,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0
    }
  };
}

export const moodModule = {
  name: 'mood',
  update: updateMood
};

export { alphaFor, applyLimits } from './inertia.mjs';
export { buildReasonCodes } from './reasons.mjs';

export default moodModule;
