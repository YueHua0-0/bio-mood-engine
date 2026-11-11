/**
 * 09 §5.5：解释码，最多 16 个，按固定优先级输出。
 */

import { LIMITS, MOOD_KEYS } from '../../core/constants.mjs';

export const SLEEP_DEBT_HIGH = 0.5;
export const STRESS_HIGH = 0.55;
export const SATURATED_HIGH = 0.95;
export const SATURATED_LOW = 0.05;
export const SIGNIFICANT = 1e-6;

const DIMENSION_CODES = Object.freeze([
  { dim: 'energy', test: (v) => v < 0.35, code: 'energy_low' },
  { dim: 'stability', test: (v) => v < 0.4, code: 'stability_low' },
  { dim: 'sensitivity', test: (v) => v > 0.65, code: 'sensitivity_high' },
  { dim: 'social_drive', test: (v) => v < 0.3, code: 'social_drive_low' },
  { dim: 'closeness_need', test: (v) => v > 0.65, code: 'closeness_need_high' },
  { dim: 'physical_comfort', test: (v) => v < 0.35, code: 'physical_comfort_low' }
]);

const COMPETING_SOURCES = Object.freeze(['cycle', 'sleep', 'stress', 'regulation', 'noise', 'event']);

function pushUnique(list, code) {
  if (!list.includes(code)) list.push(code);
}

/** 任一维的 |recovery| 严格大于其余来源时视为"恢复主导"。 */
function recoveryDominant(contributions) {
  for (const dim of MOOD_KEYS) {
    const entry = contributions[`mood.${dim}`];
    if (!entry) continue;
    const recovery = Math.abs(entry.recovery ?? 0);
    if (recovery <= SIGNIFICANT) continue;
    let strongest = 0;
    for (const source of COMPETING_SOURCES) strongest = Math.max(strongest, Math.abs(entry[source] ?? 0));
    if (recovery > strongest + 1e-12) return true;
  }
  return false;
}

/** 除 noise 外没有任何显著来源时视为"仅噪声"。 */
function noiseOnly(contributions) {
  for (const dim of MOOD_KEYS) {
    const entry = contributions[`mood.${dim}`];
    if (!entry) continue;
    for (const source of ['cycle', 'sleep', 'stress', 'regulation', 'recovery']) {
      if (Math.abs(entry[source] ?? 0) > SIGNIFICANT) return false;
    }
  }
  return true;
}

/**
 * @param {{sleepDebt:number, stressLevel:number, phase:string,
 *          contributions:object, next:object, clamped:boolean,
 *          missingUpstream:boolean}} params
 * @returns {string[]}
 */
export function buildReasonCodes({
  sleepDebt,
  stressLevel,
  phase,
  contributions,
  next,
  clamped,
  missingUpstream
}) {
  const codes = [];

  if (sleepDebt >= SLEEP_DEBT_HIGH) pushUnique(codes, 'sleep_debt_high');
  if (stressLevel >= STRESS_HIGH) pushUnique(codes, 'stress_high');
  if (phase === 'luteal_like') pushUnique(codes, 'luteal_like');
  if (phase === 'menstrual_like') pushUnique(codes, 'menstrual_like');
  if (recoveryDominant(contributions)) pushUnique(codes, 'recovery_dominant');
  if (clamped) pushUnique(codes, 'clamped_delta');
  for (const dim of MOOD_KEYS) {
    if (next[dim] >= SATURATED_HIGH) pushUnique(codes, 'saturated_high');
    if (next[dim] <= SATURATED_LOW) pushUnique(codes, 'saturated_low');
  }
  for (const entry of DIMENSION_CODES) {
    if (entry.test(next[entry.dim])) pushUnique(codes, entry.code);
  }
  if (missingUpstream) pushUnique(codes, 'missing_upstream');
  if (noiseOnly(contributions)) pushUnique(codes, 'noise_only');

  return codes.slice(0, LIMITS.maxReasonCodes);
}
