/**
 * 07 §5.3 / §5.5 / §5.5.1：五档衰减、压力目标与半衰期趋近、新事件即时响应。
 *
 * 逐 tick 复合：remaining(t2) = remaining(t1) × exp(-(t2-t1)/τ)；
 * 禁止用"原始强度 × 总时长"重算。全部为纯函数。
 */

import { round6 } from '../../core/models.mjs';

/** 07 §5.3：τ（秒）；`none` 不衰减。 */
export const TAU_SECONDS = Object.freeze({
  fast: 120,
  medium: 900,
  slow: 3600,
  very_slow: 14400,
  none: Infinity
});

/** 07 §5.5：无事件时的压力基线，不是 0。 */
export const STRESS_BASELINE = 0.15;
/** 07 §5.5：趋近半衰期 30 分钟。 */
export const APPROACH_HALF_LIFE_SECONDS = 1800;
/** 07 §5.5.1：新事件的即时响应系数。 */
export const INSTANT_COEFFICIENT = 0.5;
/** 00 §7.3：单步 `stress.level` 变化上限。 */
export const MAX_STEP = 0.30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 07 §5.3：衰减系数；非法档位按不衰减处理。 */
export function decayFactor(profile, dtSeconds) {
  const tau = TAU_SECONDS[profile];
  if (!Number.isFinite(tau) || !(dtSeconds > 0)) return 1;
  return Math.exp(-dtSeconds / tau);
}

/** 07 §5.3：把上一 tick 的 remaining 复合衰减 dtSeconds 秒。 */
export function remainingAt(remaining, profile, dtSeconds) {
  const base = Number.isFinite(remaining) ? remaining : 0;
  const seconds = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
  return round6(clamp(base * decayFactor(profile, seconds), -1, 1));
}

/** 07 §5.5：Σ remaining_signed（负强度参与求和，用于抵扣）。 */
export function sumRemaining(events) {
  let sum = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    const value = Number(ev?.remaining);
    if (Number.isFinite(value)) sum += value;
  }
  return round6(sum);
}

/** 07 §5.5：target = clamp(0.15 + Σremaining, 0, 1)。 */
export function targetStress(totalRemaining) {
  const total = Number.isFinite(totalRemaining) ? totalRemaining : 0;
  return round6(clamp(STRESS_BASELINE + total, 0, 1));
}

function applyDelta(level, rawDelta, limit, warnings) {
  const base = Number.isFinite(level) ? clamp(level, 0, 1) : STRESS_BASELINE;
  const bounded = clamp(Number.isFinite(rawDelta) ? rawDelta : 0, -limit, limit);
  const next = round6(clamp(base + bounded, 0, 1));
  const clamped = Math.abs(Number.isFinite(rawDelta) ? rawDelta : 0) > limit + 1e-9;
  if (clamped && Array.isArray(warnings)) warnings.push('STRESS_CLAMPED');
  return { level: next, delta: round6(next - base), clamped };
}

/**
 * 07 §5.5：按半衰期 30 分钟趋近目标；单步变化裁剪到 ±limit。
 * @returns {{level:number, delta:number, clamped:boolean}}
 */
export function approach({ level, target, dtSeconds, limit = MAX_STEP, warnings = null }) {
  const seconds = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
  const alpha = 1 - Math.pow(2, -seconds / APPROACH_HALF_LIFE_SECONDS);
  const safeTarget = Number.isFinite(target) ? clamp(target, 0, 1) : STRESS_BASELINE;
  return applyDelta(level, (safeTarget - level) * alpha, limit, warnings);
}

/**
 * 07 §5.5.1：新事件在同一推进内的即时反馈，系数 0.5。
 * @returns {{level:number, delta:number, clamped:boolean}}
 */
export function instantResponse({ level, target, limit = MAX_STEP, warnings = null }) {
  const safeTarget = Number.isFinite(target) ? clamp(target, 0, 1) : STRESS_BASELINE;
  return applyDelta(level, (safeTarget - level) * INSTANT_COEFFICIENT, limit, warnings);
}
