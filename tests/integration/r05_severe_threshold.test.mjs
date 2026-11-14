/**
 * E-D（R05 severe 阈值补强）：真实 event + 真实 mood 的阈值三点与自然 0.52。
 *
 * 两处判定：
 *   coordinator：derived.event_intensity >= 0.7
 *   mood：inputs.event.intensity >= 0.7
 *
 * A 组（模块级可观测）：用真实 event 模块产出 derived，再把真实 mood 模块在同一次
 * 调用的输入上以 dt=1800s 重放，观察 0.06 与 0.12 的限幅差异。
 *
 * B 组（端到端事实记录）：真实 advance() 在事件应用阶段以 dt=0 调用 mood，
 * alpha=0 且 mood 的事件贡献恒为 0（I7），因此 A1/A2/A3 的最终 mood 输出相同。
 * 这是当前时序语义，不是阈值判定失败；测试显式记录该事实，不要求端到端出现档位差。
 *
 * 所有测试模块均为对真实模块的透传包装（只记录、不改变返回），不是桩。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { createDefaultState, validateState } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { alphaFor } from '../../lib/modules/mood/inertia.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

const T0 = '2026-11-09T08:00:00.000Z';
const NOW = '2026-11-09T09:00:00.000Z';
const EVENT_AT = '2026-11-09T08:30:00.000Z';
const SEVERE = 0.7;
const REPLAY_DT = 1_800;
const MOOD_KEYS = Object.freeze([
  'energy',
  'stability',
  'sensitivity',
  'social_drive',
  'stress',
  'physical_comfort',
  'closeness_need'
]);

/**
 * 合法极端初始状态：validateState 必须通过。
 * energy=1 与高压力/高睡眠债使 dt=3600 的首轮惯性饱和到限幅边界。
 */
function buildState() {
  const state = createDefaultState({
    character_id: 'char_0000000000000000',
    timezone: 'Asia/Shanghai',
    now: T0,
    master_seed_hex: '00112233445566778899aabbccddeeff',
    config: {}
  });
  state.mood.energy = 1;
  state.stress.stress = 1;
  state.sleep.sleep_debt = 1;
  state.sleep.sleep_quality = 0.2;
  state.sleep.sleepiness = 1;
  return state;
}

assert.equal(validateState(buildState()).ok, true, '初始状态必须满足状态契约');

function eventFor({ override = undefined, relationship = 'ordinary', direct = false } = {}) {
  const event = {
    event_id: 'evt_00000002',
    event_type: 'conflict',
    occurred_at: EVENT_AT,
    source_key: 'wechat:group_1:sender_a',
    source: { relationship_tag: relationship, is_direct_question: direct }
  };
  if (override !== undefined) event.intensity_override = override;
  return event;
}

/**
 * 真实 advance() 链路；event/mood 包装只记录，不改变计算。
 * 返回 derived、mood 两次调用的输入与结果、最终状态。
 */
function runChain(event) {
  const state = buildState();
  const provider = RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
  const calls = [];
  let derived = null;

  const eventRecorder = {
    name: 'event',
    update(args) {
      const result = eventModule.update(args);
      const value = result.derived && result.derived.event_intensity;
      if (typeof value === 'number') derived = value;
      return result;
    }
  };
  const moodRecorder = {
    name: 'mood',
    update(args) {
      const record = {
        dt: args.inputs && args.inputs.dt,
        intensity: args.inputs && args.inputs.event ? args.inputs.event.intensity : null,
        args
      };
      const result = moodModule.update(args);
      record.result = result;
      calls.push(record);
      return result;
    }
  };

  const out = advance({
    state,
    event,
    now: NOW,
    rngProvider: provider,
    config: { timezone: 'Asia/Shanghai' },
    modules: [
      cycleModule,
      sleepModule,
      stressModule,
      eventRecorder,
      regulationModule,
      moodRecorder,
      behaviorModule,
      deliveryModule
    ]
  });

  return { state, provider, out, calls, derived };
}

/** 在同一次 mood 调用的真实输入上重放，只改 dt，用于观察限幅档位。 */
function replayMood(record, dt) {
  return moodModule.update({ ...record.args, inputs: { ...record.args.inputs, dt } });
}

function energyDelta(result, previous) {
  return Math.round((result.state.energy - previous.energy) * 1e6) / 1e6;
}

function assertTiming(calls, expectedIntensity, label) {
  assert.equal(calls.length, 2, `${label} 应有且仅有两次 mood 调用`);
  assert.equal(calls[0].dt, 3_600, `${label} 首轮 dt 必须为 3600`);
  assert.equal(calls[0].intensity, null, `${label} 首轮不得携带事件强度`);
  assert.equal(calls[1].dt, 0, `${label} 事件应用轮 dt 必须为 0`);
  assert.equal(calls[1].intensity, expectedIntensity, `${label} 事件轮强度必须是真实 derived`);
  assert.equal(alphaFor('energy', 0), 0, 'dt=0 时 alpha 必须精确为 0');
}

function analyze(override, expectedSevere) {
  const run = runChain(eventFor({ override }));
  const label = `A(${override})`;

  assert.equal(run.derived, override, `${label} 的 derived 必须等于 override`);
  assert.equal(run.derived >= SEVERE, expectedSevere, `${label} 的 coordinator 判定不符`);
  assertTiming(run.calls, override, label);

  // 端到端：记录事件应用轮的 mood 结果就是最终 mood。
  assert.deepEqual(run.calls[1].result.state, run.out.state.mood, `${label} 最终 mood 必须来自 dt=0 的事件轮`);

  // 事件记录：真实 active_events 回显强度，与档位无关。
  const active = run.out.state.stress.active_events;
  assert.equal(active.length, 1, `${label} 必须记录 1 条活动事件`);
  assert.equal(active[0].intensity, override, `${label} active_events.intensity 必须回显真实强度`);
  assert.equal(active[0].remaining, override, `${label} active_events.remaining 必须回显真实强度`);
  assert.ok(
    run.out.diagnostics.warnings.includes('INTENSITY_OVERRIDE'),
    `${label} 必须记录 INTENSITY_OVERRIDE`
  );

  // 模块级重放：同输入、dt=1800，观察普通 / severe 限幅。
  const previous = run.calls[1].args.previous;
  const normalReplay = replayMood(run.calls[1], REPLAY_DT);
  const delta = energyDelta(normalReplay, previous);

  if (expectedSevere) {
    assert.ok(Math.abs(delta) > 0.07 && Math.abs(delta) <= 0.12, `${label} severe 档 delta 应落在 (0.07,0.12]，实际 ${delta}`);
    assert.equal(
      normalReplay.warnings.includes('CLAMPED_DELTA'),
      false,
      `${label} severe 档不得触发 0.06 限幅`
    );
  } else {
    assert.equal(delta, -0.06, `${label} 普通档必须先被 0.06 限幅，实际 ${delta}`);
    assert.ok(
      normalReplay.warnings.includes('CLAMPED_DELTA'),
      `${label} 普通档必须记录 CLAMPED_DELTA`
    );
  }

  return { run, delta };
}

test('E-D A1：真实 derived=0.699999 走普通档，dt=1800 重放被 0.06 限幅', () => {
  const { delta } = analyze(0.699999, false);
  assert.equal(delta, -0.06);
});

test('E-D A2：真实 derived=0.700000 走 severe 档，dt=1800 重放允许超过 0.06', () => {
  const { delta } = analyze(0.7, true);
  assert.ok(Math.abs(delta) > 0.06, 'severe 档必须突破普通档 0.06 边界');
});

test('E-D A3：真实 derived=0.700001 走 severe 档，dt=1800 重放允许超过 0.06', () => {
  const { delta } = analyze(0.700001, true);
  assert.ok(Math.abs(delta) > 0.06, 'severe 档必须突破普通档 0.06 边界');
});

test('E-D B1：conflict×conflict+直问自然得到 0.520000，走普通档', () => {
  const run = runChain(eventFor({ relationship: 'conflict', direct: true }));
  const label = 'B1';

  assert.equal(run.derived, 0.52, 'B1 的自然强度必须精确为 0.52');
  assert.equal(run.derived >= SEVERE, false, 'B1 必须走普通档');
  assertTiming(run.calls, 0.52, label);

  const active = run.out.state.stress.active_events;
  assert.equal(active.length, 1);
  assert.equal(active[0].intensity, 0.52, 'B1 active_events.intensity 必须为 0.52');

  const previous = run.calls[1].args.previous;
  const replay = replayMood(run.calls[1], REPLAY_DT);
  assert.equal(energyDelta(replay, previous), -0.06, 'B1 重放必须被 0.06 限幅');
  assert.ok(replay.warnings.includes('CLAMPED_DELTA'), 'B1 必须记录 CLAMPED_DELTA');
});

test('E-D 时序事实：A1/A2/A3 的端到端 mood 输出相同（dt=0，alpha=0）', () => {
  const moods = [0.699999, 0.7, 0.700001].map((override) => runChain(eventFor({ override })).out.state.mood);
  assert.deepEqual(moods[0], moods[1], 'A1 与 A2 的端到端 mood 必须相同');
  assert.deepEqual(moods[1], moods[2], 'A2 与 A3 的端到端 mood 必须相同');
  for (const key of MOOD_KEYS) {
    assert.equal(typeof moods[0][key], 'number', `mood.${key} 必须是数值`);
  }
});
