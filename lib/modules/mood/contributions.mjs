/**
 * 09 §5.2：七维 x 八来源的原始项（raw_term）。
 *
 * 本文件只算"乘 alpha 之前"的来源项；`recovery` 见 recoveryTerm()，
 * `noise` 见 noise.mjs，`event` 恒 0（事件只经 stress 通道进入）。
 */

import {
  MOOD_HOME,
  MOOD_KEYS,
  PHASE_VECTOR_KEYS_V1,
  PHASE_VECTOR_KEYS_V2
} from '../../core/constants.mjs';

export const CONTRIBUTION_SOURCES = Object.freeze([
  'cycle',
  'sleep',
  'stress',
  'regulation',
  'recovery',
  'noise',
  'event',
  'clamp'
]);

/**
 * 05 §5.3 九维阶段向量键集（v1.7.14 周期扩展）。
 * 统一数据源：cycle 模块与本模块均指向 PHASE_VECTOR_KEYS_V2；
 * 旧四维键集 PHASE_VECTOR_KEYS_V1 仅用于输入兼容校验。
 */
export const PHASE_VECTOR_KEYS = PHASE_VECTOR_KEYS_V2;
export { PHASE_VECTOR_KEYS_V1 };

/** 09 §5.2：05 的向量只在本模块乘一次 0.6。 */
export const CYCLE_GAIN = 0.6;

/** 09 §5.2：recovery 项的系数。 */
export const RECOVERY_GAIN = 0.6;

function zeroTerms() {
  const out = {};
  for (const key of MOOD_KEYS) out[key] = 0;
  return out;
}

/**
 * 09 §5.2 cycle：0.6 × 05 原始向量；stability 用 cycle_sensitivity 偏移。
 * 注意 stress / closeness_need 恒为 0。
 */
export function cycleTerms(vector, cycleSensitivity) {
  const out = zeroTerms();
  out.energy = CYCLE_GAIN * vector.energy;
  out.sensitivity = CYCLE_GAIN * vector.sensitivity;
  out.social_drive = CYCLE_GAIN * vector.social_drive;
  out.physical_comfort = CYCLE_GAIN * vector.physical_comfort;
  out.stability = -0.3 * (cycleSensitivity - 0.5);
  return out;
}

/** 09 §5.2 sleep。 */
export function sleepTerms({ sleepDebt, sleepQuality, sleepiness }) {
  const out = zeroTerms();
  out.energy = -0.35 * sleepDebt + 0.15 * (1 - sleepQuality);
  out.physical_comfort = -0.2 * sleepDebt;
  out.stability = -0.15 * sleepDebt;
  out.sensitivity = 0.1 * sleepiness;
  out.social_drive = -0.2 * sleepiness;
  return out;
}

/**
 * 09 §5.2 stress。
 *
 * `stress.stress` 是唯一以"目标减当前"形式表达的 raw_term：
 * mood.stress 的目标直接等于 07 的 stress.level，稳态满足
 * `level - prev + 0.6 * (home - prev) = 0`，即 prev = (level + 0.09) / 1.6。
 */
export function stressTerms({ level, previousStress }) {
  const out = zeroTerms();
  out.stress = level - previousStress;
  out.energy = -0.15 * level;
  out.stability = -0.25 * level;
  out.sensitivity = 0.2 * level;
  out.social_drive = -0.1 * level;
  out.closeness_need = 0.1 * level;
  out.physical_comfort = -0.1 * level;
  return out;
}

/** 09 §5.2 regulation（六个中性特征，0.5 为无偏移）。 */
export function regulationTerms(regulation) {
  const out = zeroTerms();
  out.energy = 0.1 * (regulation.arousal - 0.5);
  out.sensitivity = 0.1 * (regulation.threat_sensitivity - 0.5);
  out.social_drive = 0.1 * (regulation.social_reassurance_drive - 0.5);
  out.physical_comfort = -0.1 * (regulation.fatigue_load - 0.5);
  out.stability = 0.1 * (regulation.calm_regulation - 0.5);
  out.closeness_need = 0.08 * (regulation.social_reassurance_drive - 0.5);
  return out;
}

/** 09 §5.2 recovery：`(home - prev) * alpha * 0.6`（alpha 由调用方乘入）。 */
export function recoveryTerm(dim, previous) {
  return (MOOD_HOME[dim] - previous) * RECOVERY_GAIN;
}

export { zeroTerms };
