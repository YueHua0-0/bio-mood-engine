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
  PHASE_VECTOR_KEYS_V2,
  CYCLE_CONTRIB_WEIGHTS
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
 *
 * v1.7.14 C2-B 扩展：九维 phase_vector 全部消费。
 *   - 旧四维：energy / sensitivity / social_drive / physical_comfort
 *     保持 × CYCLE_GAIN 语义不变。
 *   - 新五维：pain_load / anxiety_delta / irritability_delta
 *     / positive_affect_delta / intimacy_need_delta
 *     贡献权重来自 constants.mjs CYCLE_CONTRIB_WEIGHTS（契约集中维护），
 *     同样乘 CYCLE_GAIN 保持统一缩放。
 *   - pain_load 叠加到 physical_comfort（负向）和 energy（负向）
 *   - anxiety_delta 叠加到 stability（负向）和 sensitivity（正向）
 *   - irritability_delta 叠加到 stability（负向）和 sensitivity（正向）
 *   - positive_affect_delta 叠加到 stability（正向）和 social_drive（正向）
 *   - intimacy_need_delta 叠加到 closeness_need（正向）—— cycle 渠道新增来源
 *
 * closeness_need 的 stress / regulation / recovery / noise 旧来源全部保留，
 * intimacy 只是新增 cycle 渠道叠加，不替换任何旧来源。
 * stress 维度在 cycle 渠道恒为 0（stress 经独立 stress 模块进入）。
 */
export function cycleTerms(vector, cycleSensitivity) {
  const out = zeroTerms();
  const w = CYCLE_CONTRIB_WEIGHTS;

  // ---- 旧四维：语义完全不变，× CYCLE_GAIN 保留 ----
  out.energy = CYCLE_GAIN * vector.energy;
  out.sensitivity = CYCLE_GAIN * vector.sensitivity;
  out.social_drive = CYCLE_GAIN * vector.social_drive;
  out.physical_comfort = CYCLE_GAIN * vector.physical_comfort;
  out.stability = -0.3 * (cycleSensitivity - 0.5);

  // ---- 新五维（v1.7.14 周期扩展）：CYCLE_GAIN × 契约权重 ----
  const pl = vector.pain_load ?? 0;
  const anx = vector.anxiety_delta ?? 0;
  const irr = vector.irritability_delta ?? 0;
  const pos = vector.positive_affect_delta ?? 0;
  const intim = vector.intimacy_need_delta ?? 0;

  // 疼痛 → 身体舒适度下降 + 能量下降
  out.physical_comfort -= CYCLE_GAIN * w.w_pain_pc.initial * pl;
  out.energy -= CYCLE_GAIN * w.w_pain_energy.initial * pl;

  // 焦虑 → 稳定性下降 + 敏感度上升
  out.stability -= CYCLE_GAIN * w.w_anx_stab.initial * anx;
  out.sensitivity += CYCLE_GAIN * w.w_anx_sens.initial * anx;

  // 易激惹 → 稳定性下降 + 敏感度上升
  out.stability -= CYCLE_GAIN * w.w_irr_stab.initial * irr;
  out.sensitivity += CYCLE_GAIN * w.w_irr_sens.initial * irr;

  // 积极情绪 → 稳定性上升 + 社交驱动力上升
  out.stability += CYCLE_GAIN * w.w_pos_stab.initial * pos;
  out.social_drive += CYCLE_GAIN * w.w_pos_social.initial * pos;

  // 亲密需求 → closeness_need 上升（cycle 渠道新增来源）
  out.closeness_need = CYCLE_GAIN * w.w_intimacy.initial * intim;

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
