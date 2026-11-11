/**
 * T02：`forRandom(12345,1000,fn)` 连跑两次序列完全一致；注入失败时输出含 seed/i/value。
 * T03：1000 组随机状态跑 I1/I2/I7（数值域、版本 +1、`mood.event` 贡献恒 0）。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { MOOD_KEYS } from '../../lib/core/constants.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { assertInRange } from '../helpers/assert.mjs';
import { isoAfter } from '../helpers/clock.mjs';
import { forRandom, randomSeries } from '../helpers/random.mjs';
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
const EVENT_DIR = new URL('../fixtures/events/', import.meta.url);
const EVENTS = readdirSync(EVENT_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, EVENT_DIR), 'utf8')));

function eventAt(template, index, occurredAt) {
  return {
    ...structuredClone(template),
    event_id: `evt_20261109_prop${String(index).padStart(5, '0')}`,
    idempotency_key: `evt_20261109_prop${String(index).padStart(5, '0')}`,
    occurred_at: occurredAt,
    received_at: isoAfter(occurredAt, 1),
    source: { ...template.source, conversation_id: `group_${index % 7}` }
  };
}

test('T02 forRandom 确定性：同一 seed 连跑两次序列完全一致', () => {
  const first = randomSeries(12345, 1000);
  const second = randomSeries(12345, 1000);
  assert.deepEqual(first, second, '同一 seed 的序列必须逐项相等');
  assert.equal(first.length, 1000);
  const other = randomSeries(12346, 1000);
  assert.notDeepEqual(first.slice(0, 50), other.slice(0, 50), '不同 seed 不应退化成同一序列');
});

test('T02 属性失败：错误信息带 seed/i/value，可直接复现', () => {
  let captured = null;
  try {
    forRandom(777, 100, (value, index) => {
      captured = value;
      if (index === 42) assert.fail('boom');
    });
  } catch (err) {
    assert.match(err.message, /seed=777/);
    assert.match(err.message, /i=42/);
    assert.match(err.message, /value=0\.\d+/);
    assert.deepEqual(Object.keys(err.repro).sort(), ['i', 'seed', 'value']);
    assert.equal(err.repro.i, 42);
    assert.equal(err.repro.value, captured, 'repro.value 必须是失败当次的值');
    return;
  }
  assert.fail('forRandom 必须把失败抛出');
});

test('T03 1000 组随机状态：I1/I2/I7 全部成立，mood.event 贡献恒 0', () => {
  const seed = 20261109;
  let state = makeState();
  let now = state.last_tick_at;
  forRandom(seed, 1000, (value, index) => {
    now = isoAfter(now, 30 + Math.floor(value * 7140));
    const template = EVENTS[index % EVENTS.length];
    const out = advance({
      state,
      event: index % 2 === 0 ? eventAt(template, index, isoAfter(now, -30)) : null,
      now,
      rngProvider: RandomProvider.fromPersisted({
        random: state.random,
        character_id: state.character_id
      }),
      modules: MODULES
    });
    state = out.state;
    assertInRange(state, `i${index}`);
    assert.equal(state.state_version, 42 + index + 1, `i${index} I2：版本必须恰好 +1`);
    for (const dimension of MOOD_KEYS) {
      const entry = out.diagnostics.contributions?.[`mood.${dimension}`];
      const eventContribution = entry?.event ?? 0;
      assert.equal(eventContribution, 0, `i${index} I7：mood.${dimension} 的 event 贡献必须为 0`);
    }
  });
  assert.equal(state.state_version, 1042);
});
