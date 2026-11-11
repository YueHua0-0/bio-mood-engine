/**
 * 05 §5.1 / §5.4 / §5.5：周期长度采样、跨周期 O(1) 推进与人工校正。
 *
 * 硬性约束：
 * - 只做按周期循环（上限 64 次），禁止按天/按小时循环（I12）；
 * - 无 `rngProvider` 时（02 的粗推进）用期望长度 28.4 做常数时间推进并告警；
 * - 不读墙钟、不用 `Math.random()`，时间只来自传入的 ISO 字符串。
 */

import { LIMITS } from '../../core/constants.mjs';
import { parseTime, toIso } from '../../core/clock.mjs';
import { round6 } from '../../core/models.mjs';

import { phaseDetail } from './phase.mjs';

const MS_PER_DAY = 86_400_000;
const MAX_CYCLE_STEPS = 64;
const TOL = 1e-9;

export const EXPECTED_CYCLE_LENGTH_DAYS = 28.4;

/** 05 §5.1 的采样参数默认值；配置只能收紧，不能越出 [24,34]。 */
export const CYCLE_SAMPLE_DEFAULTS = Object.freeze({
  base_days: EXPECTED_CYCLE_LENGTH_DAYS,
  sd_days: 1.2,
  min_days: 24,
  max_days: 34
});

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 05 §6：配置校验。`base` 越界、`min >= max`、`sd` 越界一律拒绝启动。
 * @returns {{base_days:number, sd_days:number, min_days:number, max_days:number}}
 */
export function resolveCycleConfig(config = {}) {
  const raw = config && typeof config === 'object' ? config.cycle : null;
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) => {
    const value = source[key];
    if (value === undefined || value === null) return CYCLE_SAMPLE_DEFAULTS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw contractError('INVALID_REQUEST', `config.cycle.${key} must be a finite number`, {
        path: `config.cycle.${key}`,
        got: String(value)
      });
    }
    return value;
  };

  const base = pick('base_days');
  const sd = pick('sd_days');
  const min = pick('min_days');
  const max = pick('max_days');

  if (min < CYCLE_SAMPLE_DEFAULTS.min_days || max > CYCLE_SAMPLE_DEFAULTS.max_days || min >= max) {
    throw contractError('INVALID_REQUEST', 'cycle length bounds must satisfy 24 <= min < max <= 34', {
      path: 'config.cycle',
      min,
      max
    });
  }
  if (!(sd > 0) || sd > 2) {
    throw contractError('INVALID_REQUEST', 'cycle sd_days must be within (0,2]', {
      path: 'config.cycle.sd_days',
      got: sd
    });
  }
  if (base < min || base > max) {
    throw contractError('INVALID_REQUEST', 'cycle base_days must lie within [min,max]', {
      path: 'config.cycle.base_days',
      got: base
    });
  }
  return { base_days: base, sd_days: sd, min_days: min, max_days: max };
}

function streamFor(cycleIndex, rngProvider) {
  if (rngProvider && typeof rngProvider.stream === 'function') {
    return rngProvider.stream(`cycle:${cycleIndex}`);
  }
  if (rngProvider && typeof rngProvider.nextNormal === 'function') {
    return rngProvider;
  }
  return null;
}

/**
 * 05 §5.1：每个周期只消耗 1 次 `nextNormal()`，流标签 `cycle:${cycle_index}`。
 *
 * @param {number} cycleIndex
 * @param {object} rngProvider RandomProvider 或单条 RandomStream
 * @param {object} [config]
 */
export function sampleCycleLength(cycleIndex, rngProvider, config = {}) {
  if (!Number.isInteger(cycleIndex) || cycleIndex < 0) {
    throw contractError('INVALID_REQUEST', 'cycle_index must be a non-negative integer', {
      path: 'cycle_index',
      got: cycleIndex
    });
  }
  const { base_days, sd_days, min_days, max_days } = resolveCycleConfig(config);
  const stream = streamFor(cycleIndex, rngProvider);
  if (!stream) {
    throw contractError('MODULE_FAILED', 'sampleCycleLength requires a random provider', {
      module: 'cycle'
    });
  }
  const z = stream.nextNormal();
  return round6(clamp(base_days + sd_days * z, min_days, max_days));
}

function confidenceAfter(previousConfidence, completedCycles, source) {
  const base = Number.isFinite(previousConfidence) ? previousConfidence : 0.4;
  if (!(completedCycles > 0)) return round6(clamp(base, 0, 1));
  if (source === 'manual') {
    return round6(clamp(Math.max(0.5, base - 0.01 * completedCycles), 0, 1));
  }
  return round6(clamp(Math.min(0.9, base + 0.04 * completedCycles), 0, 1));
}

function pushWarning(warnings, code) {
  if (Array.isArray(warnings) && !warnings.includes(code)) warnings.push(code);
}

/**
 * 05 §5.4 / §5.5：按周期推进，最多 64 次迭代。
 *
 * 返回值恒为新的 `state.cycle` 对象；可选 `warnings` 数组用于接收
 * `CYCLE_COARSE_ROLL`（02 的粗推进不传，由协调器统一追加离线警告）。
 *
 * @param {{cycle:object, deltaDays:number, rngProvider?:object, config?:object, warnings?:string[]}} params
 */
export function advanceCycleDays({ cycle, deltaDays, rngProvider = null, config = {}, warnings = null } = {}) {
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    throw contractError('MODULE_FAILED', 'cycle state must be an object', { module: 'cycle' });
  }
  if (typeof deltaDays !== 'number' || !Number.isFinite(deltaDays) || deltaDays < 0) {
    throw contractError('INVALID_REQUEST', 'deltaDays must be a finite non-negative number', {
      path: 'deltaDays',
      got: String(deltaDays)
    });
  }

  resolveCycleConfig(config);
  const safeWarnings = Array.isArray(warnings) ? warnings : null;

  const anchorMs = parseTime(cycle.anchor_at, 'cycle.anchor_at');
  let cycleIndex = cycle.cycle_index;
  if (!Number.isInteger(cycleIndex) || cycleIndex < 0) {
    throw contractError('MODULE_FAILED', 'cycle_index is corrupted', {
      module: 'cycle',
      path: 'cycle.cycle_index',
      got: cycleIndex
    });
  }
  const startIndex = cycleIndex;
  const source = cycle.cycle_length_source === 'manual' ? 'manual' : 'sampled';
  const modelVersion = Number.isInteger(cycle.model_version) && cycle.model_version >= 1
    ? cycle.model_version
    : 1;

  let length = Number(cycle.cycle_length_days);
  if (!Number.isFinite(length) || length <= 0) {
    throw contractError('MODULE_FAILED', 'cycle_length_days is corrupted', {
      module: 'cycle',
      path: 'cycle.cycle_length_days',
      got: String(cycle.cycle_length_days)
    });
  }
  length = round6(clamp(length, LIMITS.minCycleLengthDays, LIMITS.maxCycleLengthDays));

  let day = Number(cycle.cycle_day);
  if (!Number.isFinite(day) || day <= 0) {
    throw contractError('MODULE_FAILED', 'cycle_day is corrupted', {
      module: 'cycle',
      path: 'cycle.cycle_day',
      got: String(cycle.cycle_day)
    });
  }

  let anchor = anchorMs;

  if (deltaDays > 0) {
    const remaining = length - (day - 1);
    if (deltaDays < remaining - TOL) {
      day += deltaDays;
    } else {
      // 跨过当前周期末尾：新周期起点 = 旧起点 + 已过天数 + 本周期剩余天数
      let rest = deltaDays - remaining;
      anchor += (day - 1 + remaining) * MS_PER_DAY;
      cycleIndex += 1;
      day = 1;

      const canSample = Boolean(streamFor(cycleIndex, rngProvider));
      let loops = 0;
      for (loops = 0; loops < MAX_CYCLE_STEPS; loops += 1) {
        if (!canSample) break;
        length = sampleCycleLength(cycleIndex, rngProvider, config);
        if (rest < length) {
          day = 1 + rest;
          break;
        }
        rest -= length;
        anchor += length * MS_PER_DAY;
        cycleIndex += 1;
      }

      if (!canSample) {
        // 02 的粗推进不传 rngProvider：按期望长度做常数时间推进（C12b / C12c）。
        const cycles = Math.floor(rest / EXPECTED_CYCLE_LENGTH_DAYS);
        cycleIndex += cycles;
        day = 1 + (rest - cycles * EXPECTED_CYCLE_LENGTH_DAYS);
        anchor += cycles * EXPECTED_CYCLE_LENGTH_DAYS * MS_PER_DAY;
        length = EXPECTED_CYCLE_LENGTH_DAYS;
        pushWarning(safeWarnings, 'CYCLE_COARSE_ROLL');
      } else if (loops === MAX_CYCLE_STEPS && rest >= 0) {
        // 超过 64 个周期（约 4 年以上）：期望长度粗推进，不再逐周期采样。
        const cycles = Math.floor(rest / EXPECTED_CYCLE_LENGTH_DAYS);
        cycleIndex += cycles;
        day = 1 + (rest - cycles * EXPECTED_CYCLE_LENGTH_DAYS);
        anchor += cycles * EXPECTED_CYCLE_LENGTH_DAYS * MS_PER_DAY;
        length = EXPECTED_CYCLE_LENGTH_DAYS;
        pushWarning(safeWarnings, 'CYCLE_COARSE_ROLL');
      }
    }
  }

  day = round6(clamp(day, 1, length));
  if (!Number.isSafeInteger(cycleIndex)) {
    throw contractError('MODULE_FAILED', 'cycle_index overflowed', {
      module: 'cycle',
      path: 'cycle.cycle_index'
    });
  }
  const p = (day - 1) / length;
  const detail = phaseDetail(p);
  const next = {
    anchor_at: toIso(Math.floor(anchor)),
    cycle_index: cycleIndex,
    cycle_length_days: round6(length),
    cycle_length_source: source,
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: toIso(Math.floor(anchor + detail.phase_start * length * MS_PER_DAY)),
    phase_progress: detail.phase_progress,
    confidence: confidenceAfter(cycle.confidence, cycleIndex - startIndex, source),
    model_version: modelVersion
  };
  return next;
}

/**
 * 05 §5.5：人工校正。长度 `[20,45]`、锚点不得晚于 `now`，否则 INVALID_REQUEST。
 * `cycle_index` 不回退，也不重置随机流。
 */
export function applyManualCorrection({
  cycle,
  now,
  manual_anchor_at = null,
  manual_cycle_length_days = null
} = {}) {
  if (!cycle || typeof cycle !== 'object') {
    throw contractError('MODULE_FAILED', 'cycle state must be an object', { module: 'cycle' });
  }
  const nowMs = parseTime(now, 'now');
  let anchorMs;
  try {
    anchorMs = parseTime(cycle.anchor_at, 'cycle.anchor_at');
  } catch {
    throw contractError('MODULE_FAILED', 'cycle.anchor_at is corrupted', {
      module: 'cycle',
      path: 'cycle.anchor_at'
    });
  }

  if (manual_anchor_at !== null && manual_anchor_at !== undefined) {
    let parsed;
    try {
      parsed = parseTime(manual_anchor_at, 'manual_anchor_at');
    } catch {
      throw contractError('INVALID_REQUEST', 'manual_anchor_at must be a UTC ISO 8601 timestamp', {
        path: 'inputs.manual_anchor_at',
        got: String(manual_anchor_at)
      });
    }
    if (parsed > nowMs) {
      throw contractError('INVALID_REQUEST', 'manual_anchor_at must not be in the future', {
        path: 'inputs.manual_anchor_at',
        got: manual_anchor_at
      });
    }
    anchorMs = parsed;
  }

  let length = Number(cycle.cycle_length_days);
  if (manual_cycle_length_days !== null && manual_cycle_length_days !== undefined) {
    const manual = Number(manual_cycle_length_days);
    if (
      typeof manual_cycle_length_days !== 'number' ||
      !Number.isFinite(manual) ||
      manual < LIMITS.minCycleLengthDays ||
      manual > LIMITS.maxCycleLengthDays
    ) {
      throw contractError('INVALID_REQUEST', `manual_cycle_length_days must be within [${LIMITS.minCycleLengthDays},${LIMITS.maxCycleLengthDays}]`, {
        path: 'inputs.manual_cycle_length_days',
        got: String(manual_cycle_length_days)
      });
    }
    length = manual;
  }
  if (!Number.isFinite(length) || length <= 0) {
    throw contractError('MODULE_FAILED', 'cycle_length_days is corrupted', {
      module: 'cycle',
      path: 'cycle.cycle_length_days'
    });
  }
  length = round6(clamp(length, LIMITS.minCycleLengthDays, LIMITS.maxCycleLengthDays));

  const elapsedDays = (nowMs - anchorMs) / MS_PER_DAY;
  const day = round6(clamp(1 + elapsedDays, 1, length));
  const p = (day - 1) / length;
  const detail = phaseDetail(p);

  return {
    anchor_at: toIso(anchorMs),
    cycle_index: Number.isInteger(cycle.cycle_index) && cycle.cycle_index >= 0 ? cycle.cycle_index : 0,
    cycle_length_days: length,
    cycle_length_source: 'manual',
    cycle_day: day,
    phase: detail.phase,
    phase_started_at: toIso(Math.floor(anchorMs + detail.phase_start * length * MS_PER_DAY)),
    phase_progress: detail.phase_progress,
    confidence: 0.95,
    model_version: Number.isInteger(cycle.model_version) && cycle.model_version >= 1
      ? cycle.model_version
      : 1
  };
}

export { MAX_CYCLE_STEPS };
