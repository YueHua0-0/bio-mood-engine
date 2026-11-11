/**
 * 14 §4.2 的状态构造器：从 `tests/fixtures/state.valid.json` 派生，禁止手写全量。
 *
 * 深合并只覆盖模块子对象的一层键；顶层字段直接替换。返回值总是新对象。
 */

import { readFileSync } from 'node:fs';

export const VALID_STATE = Object.freeze(
  JSON.parse(readFileSync(new URL('../fixtures/state.valid.json', import.meta.url), 'utf8'))
);

export const VALID_NOW = VALID_STATE.updated_at;

/** 冻结基线的深拷贝。 */
export function loadValidState() {
  return structuredClone(VALID_STATE);
}

/**
 * @param {object} [overrides] 顶层字段或模块子对象；子对象按键合并。
 */
export function makeState(overrides = {}) {
  const base = loadValidState();
  for (const [key, value] of Object.entries(overrides)) {
    const existing = base[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      base[key] = { ...existing, ...value };
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** 版本推进后的状态（只改版本与时间基准，不做业务计算）。 */
export function withVersion(state, stateVersion, { updatedAt = state.updated_at } = {}) {
  return { ...structuredClone(state), state_version: stateVersion, updated_at: updatedAt, last_tick_at: updatedAt };
}
