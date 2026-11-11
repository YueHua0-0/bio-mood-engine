/**
 * 08 §5.2 / §5.3：六个中性调节特征的目标公式与 comfort_signal。
 *
 * 全部为纯函数：相同入参逐位相同，不推进时间、不读取 previous 以外的状态。
 * 公式权重是冻结的（08 §5.3 规则 4），不按角色或配置调参。
 */

import { round6 } from '../../core/models.mjs';

/** 贡献分解的八个来源键（08 §4.3 / §5.5）。 */
export const CONTRIBUTION_SOURCES = Object.freeze([
  'base',
  'cycle',
  'sleep',
  'stress',
  'comfort',
  'mood_lag',
  'inertia',
  'clamp'
]);

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 公式结果统一 clamp(0,1) 再 round6（08 §5.3 规则 1）。 */
export function targetFromTerms(terms) {
  let sum = 0;
  for (const value of Object.values(terms)) sum += value;
  return round6(clamp01(sum));
}

/**
 * 08 §5.2：只奖励"确实收到安慰"的比例。
 * neg = Σ max(0, -remaining)；all = Σ |remaining|；无事件/全正向/分母为 0 时取 0。
 */
export function comfortSignal(activeEvents) {
  if (!Array.isArray(activeEvents)) return 0;
  let neg = 0;
  let all = 0;
  for (const event of activeEvents) {
    const remaining = event && typeof event === 'object' ? Number(event.remaining) : Number.NaN;
    if (!Number.isFinite(remaining)) continue;
    all += Math.abs(remaining);
    if (remaining < 0) neg += -remaining;
  }
  if (!(all > 0) || !(neg > 0)) return 0;
  return round6(clamp01(neg / all));
}

/** reward_sensitivity 的逐项贡献（未乘 blend）。 */
export function rewardSensitivityTerms(x = {}) {
  return {
    base: 0.4,
    cycle: 0.15 * clamp01(x.cycle_reward),
    sleep: 0.15 * (1 - clamp01(x.sleep_debt)),
    stress: 0.1 * (1 - clamp01(x.stress)),
    comfort: 0.1 * clamp01(x.comfort_signal),
    mood_lag: -0.05 * clamp01(x.previous_fatigue_load)
  };
}

export function targetRewardSensitivity(x = {}) {
  return targetFromTerms(rewardSensitivityTerms(x));
}

/** arousal 的逐项贡献（未乘 blend）。 */
export function arousalTerms(x = {}) {
  return {
    base: 0.35,
    cycle: 0.2 * clamp01(x.cycle_energy),
    sleep: 0.2 * (1 - clamp01(x.sleep_debt)) + 0.15 * (1 - clamp01(x.sleepiness)),
    stress: 0.1 * clamp01(x.stress)
  };
}

export function targetArousal(x = {}) {
  return targetFromTerms(arousalTerms(x));
}

/** threat_sensitivity 的逐项贡献（未乘 blend）。 */
export function threatSensitivityTerms(x = {}) {
  return {
    base: 0.3,
    stress: 0.2 * clamp01(x.stress),
    cycle: 0.15 * clamp01(x.cycle_sensitivity),
    sleep: 0.1 * clamp01(x.sleep_debt),
    mood_lag: 0.1 * (1 - clamp01(x.stability))
  };
}

export function targetThreatSensitivity(x = {}) {
  return targetFromTerms(threatSensitivityTerms(x));
}

/** calm_regulation 的逐项贡献（未乘 blend）。 */
export function calmRegulationTerms(x = {}) {
  return {
    base: 0.55,
    sleep: 0.15 * clamp01(x.sleep_quality),
    stress: 0.1 * (1 - clamp01(x.stress)) - 0.05 * clamp01(x.stress),
    mood_lag: -0.1 * clamp01(x.previous_fatigue_load)
  };
}

export function targetCalmRegulation(x = {}) {
  return targetFromTerms(calmRegulationTerms(x));
}

/** social_reassurance_drive 的逐项贡献（未乘 blend）。 */
export function socialReassuranceDriveTerms(x = {}) {
  return {
    base: 0.35,
    mood_lag: 0.2 * clamp01(x.closeness_need) + 0.15 * (1 - clamp01(x.energy)),
    stress: 0.1 * clamp01(x.stress),
    cycle: 0.1 * clamp01(x.cycle_social)
  };
}

export function targetSocialReassuranceDrive(x = {}) {
  return targetFromTerms(socialReassuranceDriveTerms(x));
}

/** fatigue_load 的逐项贡献（未乘 blend）。 */
export function fatigueLoadTerms(x = {}) {
  return {
    base: 0.2,
    sleep: 0.5 * clamp01(x.sleep_debt) + 0.25 * (1 - clamp01(x.sleep_quality)) + 0.1 * (1 - clamp01(x.sleepiness))
  };
}

export function targetFatigueLoad(x = {}) {
  return targetFromTerms(fatigueLoadTerms(x));
}
