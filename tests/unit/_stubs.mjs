/** 02 / 03 的测试桩模块。只允许出现在 tests/ 下，不得放进 lib/。 */

import {
  MOOD_KEYS,
  REGULATION_KEYS
} from '../../lib/core/constants.mjs';

export function moduleOf(name, update, extra = {}) {
  return { name, update, ...extra };
}

export function result(name, state, overrides = {}) {
  return {
    state,
    contributions: {},
    reason_codes: [],
    warnings: [],
    next_transition_at: null,
    diagnostics: { module: name, model_version: 1, interface_version: 1, elapsed_ms: 0 },
    ...overrides
  };
}

/** 返回一份完整的 mood 子状态（仅改指定维度）。 */
export function moodState(previous, changes = {}) {
  const next = {};
  for (const key of MOOD_KEYS) next[key] = key in changes ? changes[key] : previous[key];
  next.model_version = previous.model_version;
  return next;
}

export function regulationState(previous, changes = {}) {
  const next = {};
  for (const key of REGULATION_KEYS) next[key] = key in changes ? changes[key] : previous[key];
  next.model_version = previous.model_version;
  return next;
}
