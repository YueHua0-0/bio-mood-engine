/**
 * 15 E03 / C-06-01 验收：
 * 睡眠中收到 conflict 消息时，02 先预判 11 的交付策略，再用 rng 快照回滚重跑。
 * - 返回 delivery.policy = urgent_interrupt
 * - sleep.state = waking_up
 * - state_version 只 +1
 * - 回滚重跑不重复消耗随机数：各流 counter 与单遍 runPipeline 一致
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MASTER_SEED } from './_random_vectors.mjs';

import { advance, runPipeline } from '../../lib/core/coordinator.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';
import { BASE_STREAMS } from '../../lib/core/constants.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { stressModule, eventModule } from '../../lib/modules/stress/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

const NOW = '2026-11-09T16:00:00.000Z'; // 本地 00:00，处于睡眠窗口
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

function baseState() {
  const state = createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: NOW,
    master_seed_hex: MASTER_SEED
  });
  state.cycle = { ...state.cycle, cycle_length_source: 'sampled' };
  state.sleep = {
    ...state.sleep,
    state: 'sleeping',
    state_since: NOW,
    sleep_started_at: toIso(parseTime(NOW) - 60 * 60_000),
    planned_wake_at: toIso(parseTime(NOW) + 7 * 60 * 60_000),
    sleepiness: 0.8,
    sleep_debt: 0.3,
    recovery_progress: 1 / 8,
    interruption_count: 0,
    last_transition_reason: 'fell_asleep'
  };
  state.last_tick_at = NOW;
  return state;
}

const EVENT = Object.freeze({
  event_id: 'evt_e03_conflict',
  event_type: 'conflict',
  occurred_at: NOW,
  intensity: 0.9,
  source_key: 'wechat:group_1:sender_a'
});

test('E03 睡眠中冲突消息：urgent_interrupt + waking_up + state_version 只 +1', () => {
  const state = baseState();
  const provider = RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
  const out = advance({ state, event: EVENT, now: NOW, rngProvider: provider, modules: MODULES });

  assert.equal(out.delivery.policy, 'urgent_interrupt');
  assert.equal(out.state.sleep.state, 'waking_up');
  assert.equal(out.state.state_version, state.state_version + 1);
});

test('C-06-01 回滚重跑不重复消耗随机数：counter 与单遍路径一致', () => {
  const state = baseState();
  const providerA = RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
  const out = advance({ state, event: EVENT, now: NOW, rngProvider: providerA, modules: MODULES });

  // 单遍路径：不做预判，直接跑一次流水线。
  const providerB = RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
  runPipeline({
    draft: state,
    event: EVENT,
    now: NOW,
    rngProvider: providerB,
    modules: MODULES,
    dtSeconds: 0
  });

  // 临时流（如 event:evt_*）不持久化，按基础流比对已落盘计数。
  const single = providerB.snapshotCounters();
  for (const label of BASE_STREAMS) {
    assert.equal(out.state.random.streams[label].counter, single[label], `stream ${label}`);
  }
});
