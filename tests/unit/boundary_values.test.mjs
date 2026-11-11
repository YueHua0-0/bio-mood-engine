/**
 * T15：边界值——[0,1] 字段取 0 / 1 时模块钳制方向正确；
 * 越界与 NaN 输入被 `validateState` 以明确路径拒绝；时间分块边界不破坏不变量。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { diffSeconds } from '../../lib/core/clock.mjs';
import { validateState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { assertInRange } from '../helpers/assert.mjs';
import { isoAfter } from '../helpers/clock.mjs';
import { makeState } from '../helpers/state.mjs';

const MODULES = [
  cycleModule,
  sleepModule,
  stressModule,
  eventModule,
  regulationModule,
  moodModule,
  behaviorModule,
  deliveryModule
];

function runAt(state, elapsedSeconds) {
  const now = isoAfter(state.last_tick_at, elapsedSeconds);
  return advance({
    state,
    event: null,
    now,
    rngProvider: RandomProvider.fromPersisted({
      random: state.random,
      character_id: state.character_id
    }),
    modules: MODULES
  }).state;
}

test('T15 边界 0/1：核心 [0,1] 字段落到两端后仍被钳制在闭区间', () => {
  const cases = [
    ['mood.energy', { mood: { energy: 0 } }, { mood: { energy: 1 } }],
    ['mood.stability', { mood: { stability: 0 } }, { mood: { stability: 1 } }],
    ['sleep.sleep_debt', { sleep: { sleep_debt: 0 } }, { sleep: { sleep_debt: 1 } }],
    ['sleep.sleepiness', { sleep: { sleepiness: 0 } }, { sleep: { sleepiness: 1 } }],
    ['cycle.confidence', { cycle: { confidence: 0 } }, { cycle: { confidence: 1 } }],
    ['stress.level', { stress: { level: 0 } }, { stress: { level: 1 } }],
    ['regulation.fatigue_load', { regulation: { fatigue_load: 0 } }, { regulation: { fatigue_load: 1 } }]
  ];
  for (const [label, low, high] of cases) {
    for (const override of [low, high]) {
      for (const elapsed of [60, 3600, 21_600, 172_800]) {
        const state = runAt(makeState(override), elapsed);
        assertInRange(state, `${label}@${elapsed}`);
      }
    }
  }
});

test('T15 越界/NaN 输入：validateState 以明确路径拒绝，不进入推进', () => {
  for (const [label, override] of [
    ['mood.energy', { mood: { energy: 1.2 } }],
    ['mood.sensitivity', { mood: { sensitivity: -0.1 } }],
    ['sleep.sleep_debt', { sleep: { sleep_debt: 1.5 } }],
    ['cycle.confidence', { cycle: { confidence: Number.NaN } }],
    ['stress.level', { stress: { level: Number.POSITIVE_INFINITY } }]
  ]) {
    const result = validateState(makeState(override));
    assert.equal(result.ok, false, `${label} 必须被拒绝`);
    assert.equal(result.path, label, `${label} 的错误路径应指向具体字段`);
  }
});

test('T15 时间分块：0s / 6h / 13h / 48h 边界不产生非法状态', () => {
  for (const elapsed of [0, 3600 * 6, 3600 * 13, 3600 * 48]) {
    const state = makeState();
    const next = runAt(state, elapsed);
    assertInRange(next, `elapsed${elapsed}`);
    assert.equal(next.last_tick_at, isoAfter(state.last_tick_at, elapsed));
    assert.equal(diffSeconds(state.last_tick_at, next.last_tick_at), elapsed);
  }
});
