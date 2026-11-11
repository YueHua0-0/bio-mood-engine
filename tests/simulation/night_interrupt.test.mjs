/**
 * C-06-02 验收：用一晚夜间打断仿真确认续睡阈值。
 *
 * 场景：本地 23:15 入睡、07:30 计划唤醒，在 00:30 / 02:00 / 03:30 / 05:00 / 06:30 / 07:00
 * 各投递一次强度 0.5 的事件。断言「续睡 / 短暂醒来 / 完全清醒」三种结果都出现，
 * 且不得出现几乎每次打断都走 waking_up 的分布。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { updateSleep } from '../../lib/modules/sleep/index.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';

const CONFIG = Object.freeze({ timezone: 'Asia/Shanghai' });
const T0 = '2026-11-10T15:15:00.000Z'; // 本地 23:15 入睡
const T_END = '2026-11-11T01:00:00.000Z'; // 本地次日 09:00
const PLANNED = '2026-11-10T23:30:00.000Z'; // 本地次日 07:30
const INTERRUPTS = new Set([
  '2026-11-10T16:30:00.000Z', // 00:30
  '2026-11-10T18:00:00.000Z', // 02:00
  '2026-11-10T19:30:00.000Z', // 03:30
  '2026-11-10T21:00:00.000Z', // 05:00
  '2026-11-10T22:30:00.000Z', // 06:30
  '2026-11-10T23:00:00.000Z' // 07:00
]);

function simulateNight() {
  let prev = {
    state: 'sleeping',
    state_since: T0,
    sleep_started_at: T0,
    last_wake_at: null,
    planned_wake_at: PLANNED,
    sleep_debt: 0.45,
    sleep_quality: 0.8,
    sleepiness: 0.8,
    circadian_phase: 0.97,
    interruption_count: 0,
    recovery_progress: 0,
    last_transition_reason: 'init'
  };
  const counts = new Map();
  for (let t = parseTime(T0); t <= parseTime(T_END); t += 60_000) {
    const now = toIso(t);
    const event = INTERRUPTS.has(now) ? { event_type: 'message', intensity: 0.5 } : null;
    const result = updateSleep({
      previous: prev,
      inputs: {
        event_intensity: event ? event.intensity : null,
        urgent: false,
        planned_wake_at: prev.planned_wake_at
      },
      now,
      rng: null,
      config: CONFIG
    });
    const next = result.state;
    if (next.state !== prev.state) {
      const key = `${prev.state} -> ${next.state} (${next.last_transition_reason})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    prev = next;
  }
  return counts;
}

test('C-06-02 夜间打断仿真：续睡 / 短暂醒来 / 完全清醒三种结果都出现', () => {
  const counts = simulateNight();
  const resumed = counts.get('interrupted -> sleeping (resumed_sleep)') ?? 0;
  const gaveUp = counts.get('interrupted -> waking_up (gave_up_sleep)') ?? 0;
  const wokeNaturally = counts.get('waking_up -> awake (woke_naturally)') ?? 0;
  const plannedWake = counts.get('sleeping -> waking_up (planned_wake)') ?? 0;

  // 输出分布，便于人工核对（验收要求贴原始输出）。
  console.log(
    `[night_interrupt] resumed=${resumed} gaveUp=${gaveUp} wokeNaturally=${wokeNaturally} plannedWake=${plannedWake}`
  );

  // 续睡：打断发生在恢复进度 < 0.70 的前半夜。
  assert.ok(resumed >= 1, '至少出现一次 resumed_sleep');
  // 短暂醒来：放弃续睡后经 waking_up 转醒，随后可再次入睡。
  assert.ok(gaveUp >= 1, '至少出现一次 gave_up_sleep');
  // 完全清醒：到达 planned_wake_at 后转醒。
  assert.ok(plannedWake >= 1 && wokeNaturally >= 1, '计划唤醒与自然转醒都必须出现');
  // 不得出现几乎每次打断都走 waking_up 的分布。
  assert.ok(gaveUp / (resumed + gaveUp) <= 0.5, `waking_up 占比过高：${gaveUp}/${resumed + gaveUp}`);
});
