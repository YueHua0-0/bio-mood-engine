/**
 * 06 §8 M01 / M04 / M05 / M06 / M07 / M08 / M10 / M11 / M15 / M16 / M17
 * 睡眠状态机、滞回、打断续睡、质量与转换矩阵。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../../lib/core/models.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';
import { updateSleep, sleepModule } from '../../lib/modules/sleep/index.mjs';
import {
  ALLOWED_TRANSITIONS,
  EXPLICIT_ILLEGAL_TRANSITIONS,
  ILLEGAL_TRANSITIONS,
  SLEEP_THRESHOLDS,
  guardTransition,
  isLegalTransition,
  nextTransitionHintMs
} from '../../lib/modules/sleep/state-machine.mjs';

const CONFIG = Object.freeze({ timezone: 'Asia/Shanghai' });
const TZ = 'Asia/Shanghai';
const MASTER_SEED = '0123456789abcdef0123456789abcdef';

const NOW_2330 = '2026-11-09T15:30:00.000Z'; // 本地 23:30
const NOW_1400 = '2026-11-09T06:00:00.000Z'; // 本地 14:00
const NOW_0100 = '2026-11-08T17:00:00.000Z'; // 本地 01:00
const NOW_2200 = '2026-11-09T14:00:00.000Z'; // 本地 22:00

function shift(iso, minutes) {
  return toIso(parseTime(iso) + minutes * 60_000);
}

function sleepState(overrides = {}) {
  return {
    state: 'awake',
    state_since: NOW_2200,
    sleep_started_at: null,
    last_wake_at: null,
    planned_wake_at: null,
    sleep_debt: 0.15,
    sleep_quality: 0.7,
    sleepiness: 0.25,
    circadian_phase: 0.5,
    interruption_count: 0,
    recovery_progress: 1,
    last_transition_reason: 'init',
    ...overrides
  };
}

function run(previous, now, { event = null, urgent = false, urgent_interrupt = false, config = CONFIG } = {}) {
  // C-06-01：06 只接受 07 的 derived.event_intensity，不再读原始 event.intensity。
  const inputs = {
    event_intensity: event && typeof event.intensity === 'number' ? event.intensity : null,
    urgent,
    planned_wake_at: previous.planned_wake_at
  };
  if (urgent_interrupt) inputs.urgent_interrupt = true;
  return updateSleep({ previous, inputs, now, rng: null, config });
}

test('M01 默认初始化：awake / 0.25 / 0.15，契约字段齐全', () => {
  const state = createDefaultState({
    character_id: 'whale_character',
    timezone: TZ,
    now: NOW_2330,
    master_seed_hex: MASTER_SEED
  });
  assert.equal(state.sleep.state, 'awake');
  assert.equal(state.sleep.sleepiness, 0.25);
  assert.equal(state.sleep.sleep_debt, 0.15);
  assert.equal(state.sleep.sleep_quality, 0.7);

  const result = run(state.sleep, state.last_tick_at);
  assert.equal(result.state.state, 'awake');
  assert.equal(result.state.sleepiness, 0.25);
  assert.equal(result.state.sleep_debt, 0.15);
  assert.equal(result.state.sleep_quality, 0.7);
  assert.equal(result.state.circadian_phase, 0.979167); // 本地 23:30
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.diagnostics.module, 'sleep');
  assert.equal(typeof result.diagnostics.elapsed_ms, 'number');

  assert.equal(sleepModule.name, 'sleep');
  assert.equal(typeof sleepModule.update, 'function');
  assert.equal(typeof sleepModule.sleepinessSteady, 'function');
});

test('M04 困倦度滞回：0.549 不困、0.551 困倦、0.52 保持困倦', () => {
  const below = run(sleepState({ sleepiness: 0.549, state_since: NOW_2330 }), NOW_2330);
  assert.equal(below.state.state, 'awake');

  const above = run(sleepState({ sleepiness: 0.551, state_since: NOW_2330 }), NOW_2330);
  assert.equal(above.state.state, 'sleepy');
  assert.equal(above.state.last_transition_reason, 'felt_sleepy');

  const keep = run(
    sleepState({ state: 'sleepy', sleepiness: 0.52, state_since: NOW_2330 }),
    NOW_2330
  );
  assert.equal(keep.state.state, 'sleepy');

  const back = run(
    sleepState({ state: 'sleepy', sleepiness: 0.49, state_since: NOW_2330 }),
    NOW_2330
  );
  assert.equal(back.state.state, 'awake');
  assert.equal(back.state.last_transition_reason, 'no_longer_sleepy');
});

test('M05 入睡窗口：白天 0.80 不尝试入睡，0.86 强制尝试', () => {
  const daytime = run(
    sleepState({ state: 'sleepy', sleepiness: 0.8, state_since: NOW_1400 }),
    NOW_1400
  );
  assert.equal(daytime.state.state, 'sleepy');

  const forced = run(
    sleepState({ state: 'sleepy', sleepiness: 0.86, state_since: NOW_1400 }),
    NOW_1400
  );
  assert.equal(forced.state.state, 'trying_to_sleep');
  assert.equal(forced.state.last_transition_reason, 'started_trying_to_sleep');
});

test('M06 20 分钟入睡门槛，urgent 阻断入睡', () => {
  const stillTrying = run(
    sleepState({ state: 'trying_to_sleep', sleepiness: 0.75, state_since: shift(NOW_0100, -19) }),
    NOW_0100
  );
  assert.equal(stillTrying.state.state, 'trying_to_sleep');

  const asleep = run(
    sleepState({ state: 'trying_to_sleep', sleepiness: 0.75, state_since: shift(NOW_0100, -20) }),
    NOW_0100
  );
  assert.equal(asleep.state.state, 'sleeping');
  assert.equal(asleep.state.last_transition_reason, 'fell_asleep');
  // 时间驱动转换回填到阈值边界：since + 20 分钟 = now
  assert.equal(asleep.state.state_since, NOW_0100);
  assert.equal(asleep.state.sleep_started_at, NOW_0100);
  assert.ok(asleep.state.planned_wake_at);

  const urgent = run(
    sleepState({ state: 'trying_to_sleep', sleepiness: 0.75, state_since: shift(NOW_0100, -25) }),
    NOW_0100,
    { urgent: true }
  );
  assert.equal(urgent.state.state, 'trying_to_sleep');
});

test('M07 到达 planned_wake_at 转 waking_up，10 分钟后 awake', () => {
  const waking = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(NOW_2200, -120),
      sleep_started_at: shift(NOW_2200, -480),
      planned_wake_at: NOW_2200,
      sleepiness: 0.2
    }),
    NOW_2200
  );
  assert.equal(waking.state.state, 'waking_up');
  assert.equal(waking.state.last_transition_reason, 'planned_wake');
  assert.equal(waking.state.state_since, NOW_2200);

  const awake = run(
    sleepState({
      state: 'waking_up',
      state_since: shift(NOW_2200, -10),
      sleep_started_at: shift(NOW_2200, -480),
      planned_wake_at: shift(NOW_2200, -5),
      sleepiness: 0.2
    }),
    NOW_2200
  );
  assert.equal(awake.state.state, 'awake');
  assert.equal(awake.state.last_transition_reason, 'woke_naturally');
  assert.equal(awake.state.last_wake_at, NOW_2200);
});

test('M08 睡眠中困倦度衰减到 0.20 不触发醒来', () => {
  let previous = sleepState({
    state: 'sleeping',
    state_since: NOW_2200,
    sleep_started_at: NOW_2200,
    planned_wake_at: shift(NOW_2200, 12 * 60),
    sleepiness: 0.9,
    sleep_quality: 0.7
  });
  let now = NOW_2200;
  for (let i = 0; i < 10; i += 1) {
    now = shift(now, 60);
    const result = run(previous, now);
    assert.equal(result.state.state, 'sleeping');
    assert.ok(result.state.sleepiness >= 0.15 - 1e-9);
    previous = result.state;
  }
  assert.ok(previous.sleepiness <= 0.200001);
});

test('M10 睡眠被打断与续睡：强度 0.35、15 分钟窗口、recovery_progress 0.70 门槛', () => {
  const base = sleepState({
    state: 'sleeping',
    state_since: shift(NOW_2200, -180),
    sleep_started_at: shift(NOW_2200, -180),
    planned_wake_at: shift(NOW_2200, 600),
    sleepiness: 0.3,
    sleep_debt: 0.5
  });

  const mild = run(base, NOW_2200, { event: { event_type: 'message', intensity: 0.3 } });
  assert.equal(mild.state.state, 'sleeping');

  const broken = run(base, NOW_2200, { event: { event_type: 'message', intensity: 0.35 } });
  assert.equal(broken.state.state, 'interrupted');
  assert.equal(broken.state.last_transition_reason, 'interrupted_by_event');
  assert.equal(broken.state.interruption_count, 1);
  assert.equal(broken.state.sleep_debt, 0.4575); // 0.5 - 0.075*0.7*1 + 0.01
  assert.equal(broken.state.sleep_quality, 0.725); // 0.775（3h 公式值）- 0.05

  // 恢复进度 414/600 = 0.69 < 0.70：续睡；此时困倦度仅 0.20，旧口径必转醒。
  const resumed = run(
    sleepState({
      state: 'interrupted',
      state_since: shift(NOW_2200, -15),
      sleep_started_at: shift(NOW_2200, -414),
      planned_wake_at: shift(NOW_2200, 186),
      sleepiness: 0.2,
      interruption_count: 1,
      sleep_quality: 0.65
    }),
    NOW_2200
  );
  assert.equal(resumed.state.state, 'sleeping');
  assert.equal(resumed.state.last_transition_reason, 'resumed_sleep');
  assert.equal(resumed.state.state_since, NOW_2200);

  // 恢复进度 420/600 = 0.70：放弃续睡；此时困倦度 0.95，旧口径必续睡。
  const gaveUp = run(
    sleepState({
      state: 'interrupted',
      state_since: shift(NOW_2200, -15),
      sleep_started_at: shift(NOW_2200, -420),
      planned_wake_at: shift(NOW_2200, 180),
      sleepiness: 0.95,
      interruption_count: 1,
      sleep_quality: 0.65
    }),
    NOW_2200
  );
  assert.equal(gaveUp.state.state, 'waking_up');
  assert.equal(gaveUp.state.last_transition_reason, 'gave_up_sleep');
});

test('M11 睡眠质量公式：0 打断 8h → 0.85；极端打断 → 下限 0.20', () => {
  const now = NOW_2200;
  const clean = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(now, -60),
      sleep_started_at: shift(now, -480),
      planned_wake_at: shift(now, 60),
      sleepiness: 0.2,
      interruption_count: 0,
      sleep_quality: 0.7
    }),
    now
  );
  assert.equal(clean.state.sleep_quality, 0.85);

  const broken = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(now, -60),
      sleep_started_at: shift(now, -480),
      planned_wake_at: shift(now, 60),
      sleepiness: 0.2,
      interruption_count: 20,
      sleep_quality: 0.2
    }),
    now
  );
  assert.equal(broken.state.sleep_quality, 0.2);
});

test('M15 非法转换显式禁止，守卫保持原状态并返回 SLEEP_ILLEGAL_TRANSITION', () => {
  const banned = [
    ['awake', 'sleeping'],
    ['awake', 'trying_to_sleep'],
    ['sleepy', 'sleeping'],
    ['trying_to_sleep', 'awake'],
    ['sleeping', 'awake'],
    ['sleeping', 'sleepy'],
    ['interrupted', 'awake'],
    ['interrupted', 'sleepy'],
    ['waking_up', 'sleeping'],
    ['waking_up', 'sleepy']
  ];
  for (const [from, to] of banned) {
    assert.equal(isLegalTransition(from, to), false, `${from} -> ${to} 应非法`);
    assert.ok(
      EXPLICIT_ILLEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to),
      `${from} -> ${to} 必须在显式禁止表中`
    );
    assert.ok(ILLEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to));
    const guard = guardTransition({ from, to });
    assert.equal(guard.ok, false);
    assert.deepEqual(guard.warnings, ['SLEEP_ILLEGAL_TRANSITION']);
  }
  assert.equal(isLegalTransition('awake', 'awake'), true);
  assert.equal(isLegalTransition('sleeping', 'waking_up'), true);
  assert.equal(isLegalTransition('nope', 'awake'), false);
});

test('M16 完整睡眠周期：转换全部合法、recovery_progress 单调至 1', () => {
  const start = '2026-11-08T16:00:00.000Z'; // 本地次日 00:00
  let previous = sleepState({
    state: 'sleepy',
    state_since: start,
    sleepiness: 0.75,
    sleep_debt: 0.6
  });
  let now = start;
  const seen = [];
  let lastRecovery = 0;
  let inSession = false;

  for (let i = 0; i < 12; i += 1) {
    now = shift(now, 60);
    const result = run(previous, now);
    const from = previous.state;
    const to = result.state.state;
    assert.equal(isLegalTransition(from, to), true, `${from} -> ${to} 必须合法`);
    if (from !== to) seen.push(`${from}->${to}`);
    assert.ok(ALLOWED_TRANSITIONS[from].includes(to) || from === to);

    if (to === 'sleeping') inSession = true;
    if (inSession && ['sleeping', 'interrupted', 'waking_up'].includes(to)) {
      assert.ok(
        result.state.recovery_progress >= lastRecovery - 1e-9,
        `recovery 必须单调：${lastRecovery} -> ${result.state.recovery_progress}`
      );
      lastRecovery = result.state.recovery_progress;
    }
    if (to === 'awake' && inSession) {
      assert.equal(result.state.recovery_progress, 1);
      inSession = false;
    }
    previous = result.state;
  }

  assert.ok(seen.includes('sleepy->trying_to_sleep'));
  assert.ok(seen.includes('trying_to_sleep->sleeping'));
  assert.ok(seen.includes('sleeping->waking_up'));
  assert.ok(seen.includes('waking_up->awake'));

  // 打断路径同样只能走合法边
  const interrupted = run(
    sleepState({
      state: 'sleeping',
      state_since: NOW_2200,
      sleep_started_at: shift(NOW_2200, -120),
      planned_wake_at: shift(NOW_2200, 600),
      sleepiness: 0.25
    }),
    NOW_2200,
    { event: { event_type: 'thunder', intensity: 0.9 } }
  );
  assert.equal(interrupted.state.state, 'interrupted');
  assert.equal(isLegalTransition('sleeping', 'interrupted'), true);
  assert.equal(
    nextTransitionHintMs({ state: 'interrupted', stateSinceMs: parseTime(NOW_2200), plannedWakeAtMs: null }),
    parseTime(NOW_2200) + SLEEP_THRESHOLDS.resumeMinutes * 60_000
  );
});

test('M17 无计划唤醒推进 10 小时仍保持 sleeping', () => {
  let previous = sleepState({
    state: 'sleeping',
    state_since: NOW_2200,
    sleep_started_at: NOW_2200,
    planned_wake_at: shift(NOW_2200, 12 * 60),
    sleepiness: 0.3,
    sleep_debt: 0.6
  });
  let now = NOW_2200;
  for (let i = 0; i < 10; i += 1) {
    now = shift(now, 60);
    const result = run(previous, now);
    assert.equal(result.state.state, 'sleeping');
    previous = result.state;
  }
});

test('契约：只写 sleep.* 贡献、只返回 state.sleep、不静默写其他模块', () => {
  const previous = sleepState({ state: 'sleepy', sleepiness: 0.6, state_since: NOW_2330 });
  const result = run(previous, NOW_2330);
  for (const key of Object.keys(result.contributions)) {
    assert.match(key, /^sleep\./);
    assert.ok(!key.startsWith('stress.'));
    assert.ok(!key.startsWith('mood.'));
    assert.ok(!key.startsWith('cycle.'));
  }
  for (const sources of Object.values(result.contributions)) {
    assert.deepEqual(Object.keys(sources), ['sleep']);
    assert.equal(typeof sources.sleep, 'number');
  }
  assert.ok(result.reason_codes.length <= 16);
  assert.ok(result.warnings.length <= 16);
});
