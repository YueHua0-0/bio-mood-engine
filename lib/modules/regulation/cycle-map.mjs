/**
 * 08 §5.1：周期阶段 -> 四个标量的冻结映射。
 *
 * 映射表只允许来自 lib/core/constants.mjs 的 CYCLE_SCALARS，禁止在本模块另存副本，
 * 否则 02 的 inputs.cycle.scalars 与 08 的 target 公式会漂移。
 */

import {
  CYCLE_SCALARS,
  CYCLE_SCALARS_FALLBACK
} from '../../core/constants.mjs';

/** 四个标量的固定键序（与 CYCLE_SCALARS 的条目一致）。 */
export const CYCLE_SCALAR_KEYS = Object.freeze([
  'cycle_reward',
  'cycle_energy',
  'cycle_sensitivity',
  'cycle_social'
]);

/** 阶段是否在冻结表内；缺失/非法一律视为无周期数据。 */
export function isKnownCyclePhase(phase) {
  return typeof phase === 'string' && Object.prototype.hasOwnProperty.call(CYCLE_SCALARS, phase);
}

/**
 * 05 阶段 -> 四个标量（08 §5.1）。
 *
 * 阶段缺失或非法时四个标量均取 0.50，不抛错，由调用方追加 MISSING_CYCLE_DATA。
 * 只读阶段标签，不读 cycle_day，避免边界抖动被放大。
 */
export function cycleScalars(phase) {
  if (!isKnownCyclePhase(phase)) {
    return {
      cycle_reward: CYCLE_SCALARS_FALLBACK,
      cycle_energy: CYCLE_SCALARS_FALLBACK,
      cycle_sensitivity: CYCLE_SCALARS_FALLBACK,
      cycle_social: CYCLE_SCALARS_FALLBACK
    };
  }
  const entry = CYCLE_SCALARS[phase];
  return {
    cycle_reward: entry.cycle_reward,
    cycle_energy: entry.cycle_energy,
    cycle_sensitivity: entry.cycle_sensitivity,
    cycle_social: entry.cycle_social
  };
}
