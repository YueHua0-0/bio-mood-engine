/**
 * 05 §5.2 / §5.3：周期阶段判定、阶段进度与九维原始影响向量（v1.7.14）。
 *
 * 全部为虚构角色状态模拟，不是人体医学模型；阶段名保留 `_like` 后缀。
 * 本文件不读时间、不用随机、不写状态，只做纯函数计算。
 */

import { round6 } from '../../core/models.mjs';
import {
  PHASE_IMPACT_MATRIX,
  PHASE_VECTOR_KEYS_V2,
  PHASE_VECTOR_KEYS_V1
} from '../../core/constants.mjs';

const TOL = 1e-9;
const PROGRESS_CAP = 0.999999;

/** 阶段起点比例（左闭右开，05 §5.2）。 */
export const PHASE_STARTS = Object.freeze([0, 0.18, 0.44, 0.53]);

export const PHASE_ORDER = Object.freeze([
  'menstrual_like',
  'follicular_like',
  'ovulatory_like',
  'luteal_like'
]);

/** 九维字段（新顺序：旧四维在前，新五维在后）。 */
export const PHASE_VECTOR_KEYS = PHASE_VECTOR_KEYS_V2;

/** 旧四维字段（兼容/降级用）。 */
export const PHASE_VECTOR_KEYS_V1_EXPORT = PHASE_VECTOR_KEYS_V1;

function invalid(message, details) {
  const err = new Error(message);
  err.code = 'INVALID_REQUEST';
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clampProgress(progress) {
  const p = Number(progress);
  if (!Number.isFinite(p)) {
    throw invalid('progress must be a finite number', { path: 'progress', got: String(progress) });
  }
  return Math.min(Math.max(p, 0), 1 - 1e-12);
}

/** 阶段序号：0 menstrual / 1 follicular / 2 ovulatory / 3 luteal。 */
function phaseIndexAt(progress) {
  const p = clampProgress(progress);
  if (p >= PHASE_STARTS[3] - TOL) return 3;
  if (p >= PHASE_STARTS[2] - TOL) return 2;
  if (p >= PHASE_STARTS[1] - TOL) return 1;
  return 0;
}

/** 00 §2.5：只返回四个 `_like` 阶段之一。 */
export function phaseAt(progress) {
  return PHASE_ORDER[phaseIndexAt(progress)];
}

/**
 * 阶段窗口与阶段内进度（05 §5.2）。
 * @returns {{phase:string, phase_start:number, phase_end:number, phase_progress:number}}
 */
export function phaseDetail(progress) {
  const p = clampProgress(progress);
  const index = phaseIndexAt(p);
  const start = PHASE_STARTS[index];
  const end = index + 1 < PHASE_STARTS.length ? PHASE_STARTS[index + 1] : 1;
  const raw = (p - start) / (end - start);
  const bounded = Math.min(Math.max(raw, 0), PROGRESS_CAP);
  return {
    phase: PHASE_ORDER[index],
    phase_start: start,
    phase_end: end,
    phase_progress: round6(bounded)
  };
}

/**
 * 05 §5.3.2 唯一权重接口：返回 crossfade 所需四阶段权重。
 *
 * 四个权重始终存在且 w_m + w_f + w_o + w_l = 1 ± 1e-9。
 * 非过渡区当前阶段权重为 1，其余 0；过渡区仅相邻两个阶段权重非零。
 *
 * @param {number} progress       整体进度 p ∈ [0,1)
 * @param {number} cycleLengthDays 当前周期长度（天）
 * @returns {{menstrual_like:number, follicular_like:number, ovulatory_like:number, luteal_like:number}}
 */
export function phaseWeights(progress, cycleLengthDays = 28.4) {
  const p = clampProgress(progress);
  const length = Number(cycleLengthDays);
  const effectiveLength = Number.isFinite(length) && length > 0 ? length : 28.4;
  const window = 0.5 / effectiveLength;

  const boundaries = [0, PHASE_STARTS[1], PHASE_STARTS[2], PHASE_STARTS[3], 1];
  let nearest = -1;
  let distance = Infinity;
  for (let i = 0; i < boundaries.length; i += 1) {
    const d = Math.abs(p - boundaries[i]);
    if (d < distance) {
      distance = d;
      nearest = i;
    }
  }

  const w = {
    menstrual_like: 0,
    follicular_like: 0,
    ovulatory_like: 0,
    luteal_like: 0
  };

  if (nearest >= 0 && distance < window) {
    const prevIndex = nearest === 0 ? 3 : nearest - 1;
    const nextIndex = (prevIndex + 1) % 4;
    const boundary = boundaries[nearest];
    const t = Math.min(Math.max((p - (boundary - window)) / (2 * window), 0), 1);
    w[PHASE_ORDER[prevIndex]] = round6(1 - t);
    w[PHASE_ORDER[nextIndex]] = round6(t);
  } else {
    const phaseIdx = phaseIndexAt(p);
    w[PHASE_ORDER[phaseIdx]] = 1;
  }

  return w;
}

/**
 * 05 §5.3：九维 phase_impact（v1.7.14）。
 *
 * crossfade 中对四阶段矩阵分量做加权混合，然后按 profile 调制规则逐项应用：
 *   - pain_load × pain_sensitivity（所有阶段）
 *   - anxiety_delta / irritability_delta 整体 × mood_variability，
 *     但 crossfade 中黄体阶段的焦虑/易激惹分量 × luteal_sensitivity（按实际 w_l 连续调制）
 *   - positive_affect_delta × mood_variability
 *   - intimacy_need_delta × intimacy_variability
 *   - 旧四维（physical_comfort / energy / sensitivity / social_drive）直接混合，不乘任何 profile
 *
 * profile 非法值（非有限、类型错、超出 [0,1.5]）**不在此处 clamp**；
 * 由配置层（13 §4.4）回退默认 1.0 并去重记 FASTCFG_INVALID。若绕过配置层进入引擎，按模块输入契约失败。
 *
 * @param {number} progress       整体进度 p ∈ [0,1)
 * @param {number} cycleLengthDays 当前周期长度（天）
 * @param {object} [config]       { cycle: { profile: {...} } } 或直接 profile 对象
 * @returns {object} 九维 phase_impact
 */
export function phaseInfluence(progress, cycleLengthDays = 28.4, config = {}) {
  const profile = resolveProfile(config);
  const w = phaseWeights(progress, cycleLengthDays);

  // 1. 九维加权混合（crossfade）
  const mixed = {};
  for (const key of PHASE_VECTOR_KEYS) {
    let sum = 0;
    for (const phase of PHASE_ORDER) {
      sum += w[phase] * PHASE_IMPACT_MATRIX[phase][key];
    }
    mixed[key] = sum;
  }

  // 2. profile 调制
  const out = {};
  const ps = profile.pain_sensitivity ?? 1;
  const ls = profile.luteal_sensitivity ?? 1;
  const mv = profile.mood_variability ?? 1;
  const iv = profile.intimacy_variability ?? 1;

  // 旧四维：直接混合值，不乘任何 profile（D2）
  out.physical_comfort = round6(mixed.physical_comfort);
  out.energy = round6(mixed.energy);
  out.sensitivity = round6(mixed.sensitivity);
  out.social_drive = round6(mixed.social_drive);

  // 新五维
  out.pain_load = round6(clampRange(mixed.pain_load * ps, 0, 1));

  // anxiety_delta / irritability_delta：整体乘 mv，crossfade 中黄体分量额外乘 ls
  const luteal = PHASE_IMPACT_MATRIX.luteal_like;
  const wL = w.luteal_like;
  const adjAnx = mixed.anxiety_delta + wL * luteal.anxiety_delta * (ls - 1);
  const adjIrr = mixed.irritability_delta + wL * luteal.irritability_delta * (ls - 1);

  out.anxiety_delta = round6(clampRange(mv * adjAnx, -1, 1));
  out.irritability_delta = round6(clampRange(mv * adjIrr, -1, 1));
  out.positive_affect_delta = round6(clampRange(mv * mixed.positive_affect_delta, -1, 1));
  out.intimacy_need_delta = round6(clampRange(iv * mixed.intimacy_need_delta, -1, 1));

  return out;
}

/** 从 config 中提取 profile，支持两种形状。 */
function resolveProfile(config) {
  if (config && typeof config === 'object') {
    if (config.cycle && config.cycle.profile && typeof config.cycle.profile === 'object') {
      return config.cycle.profile;
    }
    if (config.pain_sensitivity !== undefined || config.luteal_sensitivity !== undefined) {
      return config;
    }
  }
  return {};
}

function clampRange(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}
