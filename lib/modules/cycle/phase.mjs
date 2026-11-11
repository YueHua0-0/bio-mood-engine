/**
 * 05 §5.2 / §5.3：周期阶段判定、阶段进度与四维原始影响向量。
 *
 * 全部为虚构角色状态模拟，不是人体医学模型；阶段名保留 `_like` 后缀。
 * 本文件不读时间、不用随机、不写状态，只做纯函数计算。
 */

import { round6 } from '../../core/models.mjs';

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

/** 05 §5.3 冻结表；禁止在别处复制或改动数值。 */
const PHASE_VECTORS = Object.freeze({
  menstrual_like: Object.freeze({
    physical_comfort: -0.1,
    energy: -0.06,
    sensitivity: 0.05,
    social_drive: -0.03
  }),
  follicular_like: Object.freeze({
    physical_comfort: 0.05,
    energy: 0.06,
    sensitivity: -0.02,
    social_drive: 0.05
  }),
  ovulatory_like: Object.freeze({
    physical_comfort: 0.03,
    energy: 0.04,
    sensitivity: 0.01,
    social_drive: 0.06
  }),
  luteal_like: Object.freeze({
    physical_comfort: -0.07,
    energy: -0.04,
    sensitivity: 0.07,
    social_drive: -0.02
  })
});

export const PHASE_VECTOR_KEYS = Object.freeze([
  'physical_comfort',
  'energy',
  'sensitivity',
  'social_drive'
]);

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

function vectorOf(phase) {
  return PHASE_VECTORS[phase];
}

function blend(prev, next, weight) {
  const out = {};
  for (const key of PHASE_VECTOR_KEYS) {
    out[key] = round6((1 - weight) * prev[key] + weight * next[key]);
  }
  return out;
}

function cloneVector(phase) {
  const source = vectorOf(phase);
  const out = {};
  for (const key of PHASE_VECTOR_KEYS) out[key] = round6(source[key]);
  return out;
}

/**
 * 05 §5.3：四维原始阶段影响向量，边界前后各 0.5 天线性交叉淡入。
 *
 * @param {number} progress       整体进度 p ∈ [0,1)
 * @param {number} cycleLengthDays 当前周期长度（天），用于把 0.5 天折算为进度
 * @param {object} [config]       保留参数位；向量数值是冻结表，不受配置影响
 * @returns {{physical_comfort:number, energy:number, sensitivity:number, social_drive:number}}
 */
export function phaseInfluence(progress, cycleLengthDays = 28.4, config = {}) {
  void config;
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

  if (nearest >= 0 && distance < window) {
    // b=0 的前一阶段是 luteal（跨周期回绕）；b=1 的后一阶段是 menstrual。
    const prevIndex = nearest === 0 ? 3 : nearest - 1;
    const nextIndex = (prevIndex + 1) % 4;
    const boundary = boundaries[nearest];
    const weight = Math.min(Math.max((p - (boundary - window)) / (2 * window), 0), 1);
    return blend(vectorOf(PHASE_ORDER[prevIndex]), vectorOf(PHASE_ORDER[nextIndex]), weight);
  }

  return cloneVector(phaseAt(p));
}
