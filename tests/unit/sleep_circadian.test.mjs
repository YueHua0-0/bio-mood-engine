/**
 * 06 §8 M02 / M03 / M09 / M12 / M13 / M14 / M18 / M19 / M20
 * 昼夜节律、睡眠债、跨日与夏令时、性能、确定性、协调器切分与 next_transition_at 窗口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createDefaultState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { localParts, parseTime, toIso } from '../../lib/core/clock.mjs';
import { sleepModule, sleepinessSteady, updateSleep } from '../../lib/modules/sleep/index.mjs';
import {
  circadianPhase,
  localHour,
  nextSleepiness,
  nightFactor,
  planWakeAt
} from '../../lib/modules/sleep/circadian.mjs';

const CONFIG = Object.freeze({ timezone: 'Asia/Shanghai' });
const TZ = 'Asia/Shanghai';
const MASTER_SEED = '0123456789abcdef0123456789abcdef';
const HOUR = 3_600_000;

function shift(iso, minutes) {
  return toIso(parseTime(iso) + minutes * 60_000);
}

function sleepState(overrides = {}) {
  return {
    state: 'awake',
    state_since: '2026-11-09T14:00:00.000Z',
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

function run(previous, now, { event = null, urgent = false, config = CONFIG } = {}) {
  return updateSleep({
    previous,
    // C-06-01：06 只接受 07 的 derived.event_intensity，不再读原始 event.intensity。
    inputs: {
      event_intensity: event && typeof event.intensity === 'number' ? event.intensity : null,
      urgent,
      planned_wake_at: previous.planned_wake_at
    },
    now,
    rng: null,
    config
  });
}

function assertRanges(sleep) {
  assert.ok(sleep.sleep_debt >= 0 && sleep.sleep_debt <= 1, `sleep_debt=${sleep.sleep_debt}`);
  assert.ok(sleep.sleepiness >= 0 && sleep.sleepiness <= 1, `sleepiness=${sleep.sleepiness}`);
  assert.ok(sleep.sleep_quality >= 0.2 && sleep.sleep_quality <= 0.98, `quality=${sleep.sleep_quality}`);
  assert.ok(sleep.circadian_phase >= 0 && sleep.circadian_phase < 1, `phase=${sleep.circadian_phase}`);
  assert.ok(sleep.recovery_progress >= 0 && sleep.recovery_progress <= 1);
  assert.ok(Number.isInteger(sleep.interruption_count));
  assert.ok(sleep.interruption_count >= 0 && sleep.interruption_count <= 20);
}

function closeTo(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `期望 ${expected}，实际 ${actual}`);
}

test('昼夜函数：localHour / nightFactor / 相位/稳态与 0.20 单步上限', () => {
  assert.equal(localHour('2026-11-09T00:00:00.000Z', TZ), 8);
  assert.equal(localHour('2026-11-08T19:00:00.000Z', TZ), 3);
  assert.equal(circadianPhase(23.5), 0.979167);
  assert.equal(nightFactor(3), 1);
  assert.ok(nightFactor(15) < 0.01);
  assert.ok(nightFactor(15) >= 0);

  assert.equal(sleepinessSteady(3, 0.5), 0.875); // 0.10 + 0.225 + 0.55
  assert.equal(sleepinessSteady(15, 0), 0.10);
  assert.equal(sleepinessSteady(3, 1), 1);
  assert.equal(sleepinessSteady(3, -5), 0.65);
  assert.equal(typeof sleepModule.sleepinessSteady, 'function');
  assert.equal(sleepModule.sleepinessSteady(3, 0.5), sleepinessSteady(3, 0.5));

  // 清醒态向稳态收敛；睡眠态向 0.15 收敛；打断态 +0.02/h
  closeTo(nextSleepiness({ state: 'awake', sleepiness: 0.25, sleepDebt: 0, localHour: 15, deltaHours: 1 }), 0.19098);
  closeTo(nextSleepiness({ state: 'sleeping', sleepiness: 0.35, sleepDebt: 0.5, localHour: 2, deltaHours: 1 }), 0.223576, 2e-6);
  // 睡眠态 1 小时从 0.8 掉到 0.389，仍受 0.20 单步上限约束 → 0.60
  assert.equal(nextSleepiness({ state: 'sleeping', sleepiness: 0.8, sleepDebt: 0.5, localHour: 2, deltaHours: 1 }), 0.6);
  assert.equal(nextSleepiness({ state: 'interrupted', sleepiness: 0.5, sleepDebt: 0.5, localHour: 2, deltaHours: 1 }), 0.52);
  // 极端目标被 0.20 截断
  assert.equal(nextSleepiness({ state: 'awake', sleepiness: 0, sleepDebt: 1, localHour: 3, deltaHours: 1 }), 0.2);
});

test('M02 白天 14:00 睡眠债 0.30 不困（不入 sleepy/sleeping）', () => {
  const now = '2026-11-09T06:00:00.000Z'; // 本地 14:00
  const out = run(
    sleepState({ state: 'awake', sleepiness: 0.25, sleep_debt: 0.3, state_since: shift(now, -60) }),
    now
  );
  assert.equal(out.state.state, 'awake');
  closeTo(out.state.sleepiness, 0.250264);
  assert.ok(out.state.sleepiness < 0.55);
});

test('M03 本地 23:30 起连推 7 天：进入 sleepy，夜间峰值逐日稳定', () => {
  let previous = sleepState({ sleepiness: 0.25, sleep_debt: 0.15, state_since: '2026-11-09T15:30:00.000Z' });
  let now = '2026-11-09T15:30:00.000Z';
  let sawSleepy = false;
  const peaks = [];
  let blockPeak = 0;

  for (let i = 0; i < 24 * 7; i += 1) {
    now = toIso(parseTime(now) + HOUR);
    const out = run(previous, now);
    assertRanges(out.state);
    if (out.state.state === 'sleepy') sawSleepy = true;
    blockPeak = Math.max(blockPeak, out.state.sleepiness);
    previous = out.state;
    if ((i + 1) % 24 === 0) {
      peaks.push(blockPeak);
      blockPeak = 0;
    }
  }

  assert.equal(sawSleepy, true);
  const tail = peaks.slice(-3);
  const spread = Math.max(...tail) - Math.min(...tail);
  assert.ok(spread <= 0.05, `夜间峰值不稳定：peaks=${JSON.stringify(peaks)}`);
});

test('M09 睡眠债：清醒 24h +0.336；睡眠 1h（质量 0.7）-0.0525', () => {
  let previous = sleepState({
    state: 'awake',
    sleepiness: 0.25,
    sleep_debt: 0.15,
    state_since: '2026-11-09T00:00:00.000Z' // 本地 08:00
  });
  let now = '2026-11-09T00:00:00.000Z';
  for (let i = 0; i < 24; i += 1) {
    now = toIso(parseTime(now) + HOUR);
    // P-16-04：入睡窗口扩到 [0,5) 后，自然推进会在本地 02:00 之后入睡；
    // 本用例只验证睡眠债公式（清醒 +0.014/h、睡眠 −0.075×质量/h），因此每步强制清醒态。
    const step = run({ ...previous, state: 'awake' }, now).state;
    previous = { ...step, state: 'awake', sleep_started_at: null };
  }
  assert.equal(previous.sleep_debt, 0.486);

  const slept = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(now, -60),
      sleep_started_at: shift(now, -60),
      planned_wake_at: shift(now, 420),
      sleepiness: 0.2,
      sleep_debt: 0.5,
      sleep_quality: 0.7
    }),
    now
  );
  assert.equal(slept.state.sleep_debt, 0.4475);
});

test('M12 跨日 23:00 → 次日 08:00 与夏令时切换无非法跳转', () => {
  const start = '2026-11-09T15:00:00.000Z'; // 本地 23:00
  let previous = sleepState({
    state: 'sleepy',
    state_since: start,
    sleepiness: 0.7,
    sleep_debt: 0.5,
    planned_wake_at: '2026-11-09T23:30:00.000Z' // 本地次日 07:30
  });
  let now = start;
  let wrapped = false;

  for (let i = 0; i < 9; i += 1) {
    now = toIso(parseTime(now) + HOUR);
    const out = run(previous, now);
    assertRanges(out.state);
    const hour = localHour(now, TZ);
    assert.equal(out.state.circadian_phase, Math.round((hour / 24) * 1e6) / 1e6);
    if (hour === 0) {
      wrapped = true;
      assert.equal(out.state.circadian_phase, 0);
    }
    previous = out.state;
  }
  assert.equal(wrapped, true);
  assert.ok(['waking_up', 'awake'].includes(previous.state), previous.state);
  assert.equal(previous.last_transition_reason, 'planned_wake');

  // 夏令时（America/New_York 2026-03-08 02:00 → 03:00）
  closeTo(localHour('2026-03-08T06:59:00.000Z', 'America/New_York'), 1.983333);
  assert.equal(localHour('2026-03-08T07:00:00.000Z', 'America/New_York'), 3);

  let dstPrev = sleepState({
    state: 'awake',
    state_since: '2026-03-08T04:00:00.000Z', // 本地 23:00 EST
    sleepiness: 0.25,
    sleep_debt: 0.2
  });
  let dstNow = '2026-03-08T04:00:00.000Z';
  for (let i = 0; i < 10; i += 1) {
    dstNow = toIso(parseTime(dstNow) + HOUR);
    const out = updateSleep({
      previous: dstPrev,
      inputs: { event: null, urgent: false, planned_wake_at: dstPrev.planned_wake_at },
      now: dstNow,
      rng: null,
      config: { timezone: 'America/New_York' }
    });
    assertRanges(out.state);
    const hour = localHour(dstNow, 'America/New_York');
    assert.equal(out.state.circadian_phase, Math.round((hour / 24) * 1e6) / 1e6);
    dstPrev = out.state;
  }

  // 计划唤醒：本地 07:30，跨夏令时仍精确落在本地 07:30
  const wake = planWakeAt({
    sleepStartedAt: '2026-03-07T20:00:00.000Z',
    timezone: 'America/New_York',
    config: {}
  });
  const localWake = localParts(wake, 'America/New_York');
  assert.equal(localWake.hour, 7);
  assert.equal(localWake.minute, 30);
});

test('M13 性能：720 步 < 1s，字段始终合法', () => {
  let previous = sleepState({
    state: 'awake',
    state_since: '2026-11-09T00:00:00.000Z',
    sleepiness: 0.25,
    sleep_debt: 0.15
  });
  let now = '2026-11-09T00:00:00.000Z';
  const started = performance.now();
  for (let i = 0; i < 720; i += 1) {
    now = toIso(parseTime(now) + HOUR);
    const out = run(previous, now);
    assertRanges(out.state);
    previous = out.state;
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `720 步耗时 ${elapsed.toFixed(1)}ms`);
});

test('M14 确定性：同输入同输出；单步变化不超过 0.20', () => {
  const now = '2026-11-08T19:00:00.000Z'; // 本地 03:00
  const previous = sleepState({
    state: 'awake',
    state_since: shift(now, -60),
    sleepiness: 0,
    sleep_debt: 1
  });
  const first = run(previous, now);
  const second = run(previous, now);
  assert.deepEqual(first, second);

  assert.equal(first.state.sleepiness, 0.2);
  assert.ok(Math.abs(first.contributions['sleep.sleepiness'].sleep) <= 0.2 + 1e-9);
  assert.ok(first.warnings.includes('SLEEPINESS_CLAMPED'));
  assert.equal(first.next_transition_at, null);
});

function buildState(now) {
  const state = createDefaultState({
    character_id: 'whale_character',
    timezone: TZ,
    now,
    master_seed_hex: MASTER_SEED
  });
  // 协调器用例验证"已初始化"状态的推进：cycle 必须已采样（00 v1.7.6 §3.2）。
  state.cycle = { ...state.cycle, cycle_length_source: 'sampled' };
  return state;
}

function providerFor(state) {
  return RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
}

test('M18 trying_to_sleep 满 20 分钟入睡，协调器按小时推进误差 ≤1s', () => {
  const t0 = '2026-11-09T15:30:00.000Z'; // 本地 23:30
  const state = buildState(t0);
  state.sleep = {
    ...state.sleep,
    state: 'trying_to_sleep',
    state_since: t0,
    sleepiness: 0.8,
    sleep_debt: 0.4
  };

  const result = advance({
    state,
    now: toIso(parseTime(t0) + HOUR),
    rngProvider: providerFor(state),
    config: CONFIG,
    modules: [sleepModule]
  });

  assert.equal(result.state.sleep.state, 'sleeping');
  const expected = parseTime(t0) + 20 * 60_000;
  assert.ok(Math.abs(parseTime(result.state.sleep.sleep_started_at) - expected) <= 1000);
  assertRanges(result.state.sleep);
});

test('M19 interrupted 15 分钟：状态机按阈值边界切分续睡/转醒', () => {
  const t0 = '2026-11-09T15:30:00.000Z';
  const resumeAt = toIso(parseTime(t0) + 15 * 60_000);

  const resumeState = buildState(t0);
  resumeState.sleep = {
    ...resumeState.sleep,
    state: 'interrupted',
    state_since: t0,
    sleep_started_at: shift(t0, -120),
    planned_wake_at: shift(t0, 480),
    sleepiness: 0.2,
    interruption_count: 1
  };
  const resumed = advance({
    state: resumeState,
    now: toIso(parseTime(t0) + HOUR),
    rngProvider: providerFor(resumeState),
    config: CONFIG,
    modules: [sleepModule]
  });
  assert.equal(resumed.state.sleep.state, 'sleeping');
  assert.equal(resumed.state.sleep.last_transition_reason, 'resumed_sleep');
  assert.ok(Math.abs(parseTime(resumed.state.sleep.state_since) - parseTime(resumeAt)) <= 1000);

  const giveUpState = buildState(t0);
  giveUpState.sleep = {
    ...giveUpState.sleep,
    state: 'interrupted',
    state_since: t0,
    sleep_started_at: shift(t0, -420),
    planned_wake_at: shift(t0, 180),
    sleepiness: 0.95,
    interruption_count: 1
  };
  const gaveUp = advance({
    state: giveUpState,
    now: toIso(parseTime(t0) + HOUR),
    rngProvider: providerFor(giveUpState),
    config: CONFIG,
    modules: [sleepModule]
  });
  assert.ok(['waking_up', 'awake'].includes(gaveUp.state.sleep.state), gaveUp.state.sleep.state);
  assert.equal(gaveUp.state.sleep.interruption_count, 1);
  assertRanges(gaveUp.state.sleep);
});

test('M20 next_transition_at 全部满足 now < hint ≤ now+1h 或 null', () => {
  const now = '2026-11-08T18:00:00.000Z'; // 本地 02:00
  const nowMs = parseTime(now);
  const states = ['awake', 'sleepy', 'trying_to_sleep', 'sleeping', 'interrupted', 'waking_up'];

  for (const stateName of states) {
    for (const offset of [-120, -30, -5, 0, 1, 30, 90, 600]) {
      const previous = sleepState({
        state: stateName,
        state_since: toIso(nowMs - 5 * 60_000),
        sleep_started_at: toIso(nowMs - 180 * 60_000),
        planned_wake_at: toIso(nowMs + offset * 60_000),
        sleepiness: stateName === 'sleeping' ? 0.2 : 0.7,
        sleep_debt: 0.3
      });
      const out = run(previous, now);
      const hint = out.next_transition_at;
      if (hint === null) continue;
      const hintMs = parseTime(hint);
      assert.ok(hintMs > nowMs, `${stateName} hint 必须晚于 now`);
      assert.ok(hintMs <= nowMs + HOUR, `${stateName} hint 必须在 1 小时内`);
    }
  }

  // 四态提示值本身
  const hintTrying = run(
    sleepState({ state: 'trying_to_sleep', state_since: shift(now, -5), sleepiness: 0.75 }),
    now
  );
  assert.equal(hintTrying.next_transition_at, shift(now, 15));

  const hintSleeping = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(now, -60),
      sleep_started_at: shift(now, -120),
      planned_wake_at: shift(now, 30),
      sleepiness: 0.2
    }),
    now
  );
  assert.equal(hintSleeping.next_transition_at, shift(now, 30));

  const hintInterrupted = run(
    sleepState({ state: 'interrupted', state_since: shift(now, -5), sleepiness: 0.7 }),
    now
  );
  assert.equal(hintInterrupted.next_transition_at, shift(now, 10));

  const hintWaking = run(
    sleepState({ state: 'waking_up', state_since: shift(now, -5), sleepiness: 0.2 }),
    now
  );
  assert.equal(hintWaking.next_transition_at, shift(now, 5));

  // 睡眠中计划唤醒超过 1 小时 → null（不污染协调器）
  const farWake = run(
    sleepState({
      state: 'sleeping',
      state_since: shift(now, -60),
      sleep_started_at: shift(now, -120),
      planned_wake_at: shift(now, 300),
      sleepiness: 0.2
    }),
    now
  );
  assert.equal(farWake.next_transition_at, null);
});
