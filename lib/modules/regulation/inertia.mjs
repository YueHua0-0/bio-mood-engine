/**
 * 08 §5.4 / §5.5：45 分钟惯性、单步 0.05 裁剪与贡献分解。
 *
 * dt 由调用方提供（02 已按 ≤3600 秒分块），本文件不读任何墙钟。
 */

import { DELTA_LIMITS } from '../../core/constants.mjs';
import { round6 } from '../../core/models.mjs';

/** 08 §5.4：半衰期 2700 秒（45 分钟）。 */
export const INERTIA_HALF_LIFE_SECONDS = 2700;

/** 08 §5.4：单次更新任一维度的变化上限。 */
export const MAX_STEP_DELTA = DELTA_LIMITS.regulation.normal;

const DECOMPOSITION_SOURCES = Object.freeze([
  'base',
  'cycle',
  'sleep',
  'stress',
  'comfort',
  'mood_lag',
  'inertia',
  'clamp'
]);

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clampNumber(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function cleanZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * 08 §5.4：blend = 1 - 2 ** (-dt / 2700)。
 * dt 为负按 0 处理；dt = 0 时 blend = 0（只重算 target，next = prev）。
 */
export function blendFor(dtSeconds) {
  const dt = typeof dtSeconds === 'number' && Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
  if (dt === 0) return 0;
  return 1 - 2 ** (-dt / INERTIA_HALF_LIFE_SECONDS);
}

/**
 * 单维推进（08 §5.4）。
 *
 * @param {{previous:number, target:number, dtSeconds:number,
 *          terms?:Record<string, number>}} params
 * @returns {{next:number, blend:number, raw:number, delta:number, actualDelta:number,
 *            clamped:boolean, saturatedHigh:boolean, saturatedLow:boolean,
 *            contributions:Record<string, number>}}
 */
export function stepInertia({ previous, target, dtSeconds = 0, terms = null } = {}) {
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous < 0 || previous > 1) {
    throw contractError('INVALID_REQUEST', 'regulation previous must be a finite number within [0,1]', {
      path: 'previous',
      got: String(previous)
    });
  }
  if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 1) {
    throw contractError('INVALID_REQUEST', 'regulation target must be a finite number within [0,1]', {
      path: 'target',
      got: String(target)
    });
  }

  const blend = blendFor(dtSeconds);
  const raw = (target - previous) * blend;
  const delta = clampNumber(raw, -MAX_STEP_DELTA, MAX_STEP_DELTA);
  const clamped = Math.abs(raw) > MAX_STEP_DELTA + 1e-12;
  const next = round6(clampNumber(previous + delta, 0, 1));

  const contributions = {};
  for (const source of DECOMPOSITION_SOURCES) {
    if (source === 'clamp') continue;
    if (source === 'inertia') {
      contributions[source] = cleanZero(-previous * blend);
      continue;
    }
    const term = terms && typeof terms[source] === 'number' && Number.isFinite(terms[source])
      ? terms[source]
      : 0;
    contributions[source] = cleanZero(term * blend);
  }

  // 08 §5.5：clamp 吸收目标钳制、单步裁剪与边界饱和，保证 Σ contributions == next - previous。
  let accounted = 0;
  for (const source of DECOMPOSITION_SOURCES) {
    if (source === 'clamp') continue;
    accounted += contributions[source];
  }
  let residual = (next - previous) - accounted;
  if (Math.abs(residual) < 1e-12) residual = 0;
  contributions.clamp = cleanZero(residual);

  return {
    next,
    blend,
    raw,
    delta,
    actualDelta: cleanZero(next - previous),
    clamped,
    saturatedHigh: next === 1,
    saturatedLow: next === 0,
    contributions
  };
}
