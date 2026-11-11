/**
 * 09 §5.1 / §5.3：七维惯性系数、单步裁剪与硬边界断言。
 *
 * dt 由 02 的 inputs.dt 显式提供；本文件不读任何墙钟，也不做兜底推算。
 */

import { DELTA_LIMITS } from '../../core/constants.mjs';

/** 09 §4.3：每维自己的时间常数（小时），不得共用同一 alpha。 */
export const TAU_HOURS = Object.freeze({
  energy: 2.0,
  stability: 6.0,
  sensitivity: 4.0,
  social_drive: 3.0,
  stress: 1.5,
  physical_comfort: 4.0,
  closeness_need: 2.5
});

/** 09 §5.3：普通 / 高严重度 / 硬上限。数值来自 00 §7.3 的冻结表。 */
export const NORMAL_LIMIT = DELTA_LIMITS.mood.normal;
export const SEVERE_LIMIT = DELTA_LIMITS.mood.severe;
export const HARD_LIMIT = DELTA_LIMITS.mood.hard;

const EPS = 1e-12;

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

/**
 * 09 §5.1：`alpha = 1 - 2 ** (-dt_hours / tau)`。
 * dt = 0 时 2 ** 0 === 1，alpha 精确为 0；dt < 0 按 0 处理（09 §6）。
 */
export function alphaFor(dim, dtSeconds) {
  const tau = TAU_HOURS[dim];
  if (tau === undefined) {
    throw contractError('INVALID_REQUEST', `unknown mood dimension: ${String(dim)}`, {
      path: 'dim',
      got: String(dim)
    });
  }
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
  return 1 - 2 ** (-(dtSeconds / 3600) / tau);
}

/** severity_high 只放宽本步上限，不改变来源权重（09 §5.2）。 */
export function limitFor(severityHigh) {
  return severityHigh ? SEVERE_LIMIT : NORMAL_LIMIT;
}

/** 09 §5.3 第二道：硬上限为断言，不裁剪；触发即实现错误。 */
export function assertHardBound(delta) {
  if (!Number.isFinite(delta) || Math.abs(delta) > HARD_LIMIT + EPS) {
    throw contractError('MODULE_FAILED', 'mood delta exceeds the hard bound', {
      module: 'mood',
      path: 'delta',
      delta,
      hard: HARD_LIMIT
    });
  }
  return delta;
}

/**
 * 09 §5.3：裁到 0.06 / 0.12，再断言 |delta| ≤ 0.15，最后把状态夹回 [0,1]。
 *
 * @param {number} previous 上一 tick 的维度值
 * @param {number} deltaRaw 七个来源之和（已含 alpha）
 * @param {boolean} severityHigh 是否高严重度
 * @returns {{delta:number, next:number, limit:number, clamped:boolean,
 *            saturatedHigh:boolean, saturatedLow:boolean}}
 */
export function applyLimits(previous, deltaRaw, severityHigh) {
  const limit = limitFor(severityHigh);
  const delta = Math.min(limit, Math.max(-limit, deltaRaw));
  assertHardBound(delta);
  const next = clamp01(previous + delta);
  return {
    delta,
    next,
    limit,
    clamped: Math.abs(deltaRaw) > limit + EPS,
    saturatedHigh: next >= 1,
    saturatedLow: next <= 0
  };
}
