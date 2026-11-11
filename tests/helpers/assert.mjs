/**
 * 14 §4.2 的断言辅助：递归扫描数值字段。
 *
 * `assertInRange(state)` 回答 I1：所有 `[0,1]` 字段在范围内、无 `NaN` / `Infinity` / `-0`。
 * 只使用 node:assert，不含业务规则；范围表来自 00 §3.2 / §13。
 */

import assert from 'node:assert/strict';

import { LIMITS, MOOD_KEYS, REGULATION_KEYS } from '../../lib/core/constants.mjs';

/** 00 §3.2：直接取其值的 [0,1] 路径。 */
function unitPaths(state) {
  return [
    ['cycle.confidence', state.cycle.confidence],
    ['cycle.phase_progress', state.cycle.phase_progress],
    ['sleep.sleep_debt', state.sleep.sleep_debt],
    ['sleep.sleep_quality', state.sleep.sleep_quality],
    ['sleep.sleepiness', state.sleep.sleepiness],
    ['sleep.circadian_phase', state.sleep.circadian_phase],
    ['sleep.recovery_progress', state.sleep.recovery_progress],
    ['stress.level', state.stress.level],
    ...MOOD_KEYS.map((key) => [`mood.${key}`, state.mood[key]]),
    ...REGULATION_KEYS.map((key) => [`regulation.${key}`, state.regulation[key]])
  ];
}

function walkNumbers(value, path, visit) {
  if (typeof value === 'number') {
    visit(path, value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNumbers(item, `${path}[${index}]`, visit));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walkNumbers(item, path ? `${path}.${key}` : key, visit);
  }
}

/** 任意数值字段都不允许 NaN / Infinity / -0（00 §4.4 / I1）。 */
export function assertFiniteNoNegativeZero(state, label = 'state') {
  walkNumbers(state, '', (path, value) => {
    assert.ok(Number.isFinite(value), `${label}.${path} 必须是有限数，实际 ${value}`);
    assert.equal(Object.is(value, -0), false, `${label}.${path} 不得为 -0`);
  });
}

/** I1：`[0,1]` 字段在范围内；`[0,1)` 字段小于 1；阶段进度等半开区间单独校验。 */
export function assertInRange(state, label = 'state') {
  assertFiniteNoNegativeZero(state, label);
  for (const [path, value] of unitPaths(state)) {
    assert.ok(
      typeof value === 'number' && value >= 0 && value <= 1,
      `${label}.${path} 必须在 [0,1]，实际 ${value}`
    );
  }
  assert.ok(state.cycle.phase_progress >= 0 && state.cycle.phase_progress < 1, `${label}.cycle.phase_progress 必须落在 [0,1)`);
  assert.ok(state.sleep.circadian_phase >= 0 && state.sleep.circadian_phase < 1, `${label}.sleep.circadian_phase 必须落在 [0,1)`);
  assert.ok(
    state.stress.active_events.length <= LIMITS.maxActiveEvents,
    `${label}.stress.active_events 不得超过 ${LIMITS.maxActiveEvents} 条`
  );
  for (const [index, event] of state.stress.active_events.entries()) {
    assert.ok(event.intensity >= -1 && event.intensity <= 1, `${label}.stress.active_events[${index}].intensity 越界`);
    assert.ok(event.remaining >= -1 && event.remaining <= 1, `${label}.stress.active_events[${index}].remaining 越界`);
  }
}

/** 00 §2.2：UTC ISO 8601 + 毫秒 + Z。 */
export function assertUtcIso(value, label = 'time') {
  assert.equal(typeof value, 'string', `${label} 必须是字符串`);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${label} 必须是带毫秒的 UTC ISO`);
}

/** 只比较结构化对象，禁止字符串化后比较（14 §6）。 */
export function assertDeepEqualObject(actual, expected, label = 'value') {
  assert.deepEqual(actual, expected, `${label} 结构不一致`);
}
