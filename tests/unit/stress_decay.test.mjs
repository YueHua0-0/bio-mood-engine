/**
 * 07 §8 用例 S06–S12、S14、S18–S23（衰减 / 目标趋近 / 即时响应 / 列表维护 / long_silence）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEvent,
  silenceIdentity,
  updateStress
} from '../../lib/modules/stress/index.mjs';
import {
  approach,
  instantResponse,
  remainingAt,
  targetStress,
  TAU_SECONDS
} from '../../lib/modules/stress/decay.mjs';

const NOW = '2026-11-09T09:00:00.000Z';

function stressState(overrides = {}) {
  return {
    level: 0.15,
    active_events: [],
    last_decay_at: NOW,
    last_event_at: null,
    model_version: 1,
    ...overrides
  };
}

function activeEvent(overrides = {}) {
  return {
    event_id: 'evt_seed_decay01',
    event_type: 'mention',
    started_at: NOW,
    intensity: 0.08,
    remaining: 0.08,
    decay_profile: 'medium',
    source_key: 'wechat:conv_1:sender_1',
    ...overrides
  };
}

function runStress(previous, { now = NOW, inputs = {} } = {}) {
  return updateStress({
    previous,
    inputs: {
      event: null,
      activity: { last_event_at: previous.last_event_at, recent_event_ids: [] },
      ...inputs
    },
    now,
    rng: null,
    config: {}
  });
}

function evt(overrides = {}) {
  const base = {
    event_id: 'evt_20261109_dec0001',
    event_type: 'conflict',
    occurred_at: NOW,
    source: {
      conversation_id: 'conv_1',
      sender_id: 'sender_1',
      relationship_tag: 'ordinary',
      is_mentioned: false
    },
    payload: { is_direct_question: false }
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...(overrides.source ?? {}) },
    payload: { ...base.payload, ...(overrides.payload ?? {}) }
  };
}

function runApply(event, { previous = stressState(), now = NOW } = {}) {
  return applyEvent({
    previous,
    inputs: {
      event,
      activity: { last_event_at: previous.last_event_at, recent_event_ids: [] }
    },
    now,
    rng: null,
    config: {}
  });
}

test('S06：四条有界衰减在各自 τ 处剩余 0.3679×intensity（±1e-6）', () => {
  for (const profile of ['fast', 'medium', 'slow', 'very_slow']) {
    const expected = 0.5 * Math.exp(-1);
    const actual = remainingAt(0.5, profile, TAU_SECONDS[profile]);
    assert.ok(Math.abs(actual - expected) < 1e-6, `${profile}: ${actual} vs ${expected}`);
  }
  assert.equal(remainingAt(0.5, 'none', 100000), 0.5);
});

test('S07：fast 83.18s / medium 623.83s 剩余约 50%（±1e-3）', () => {
  assert.ok(Math.abs(remainingAt(0.5, 'fast', 83.18) - 0.25) < 1e-3);
  assert.ok(Math.abs(remainingAt(0.5, 'medium', 623.83) - 0.25) < 1e-3);
});

test('S08：dt=1800 走完差距 50%，dt=3600 走完 75%', () => {
  const half = approach({ level: 0.15, target: 0.35, dtSeconds: 1800 });
  assert.ok(Math.abs(half.level - 0.25) < 1e-9, `half=${half.level}`);
  const threeQuarter = approach({ level: 0.15, target: 0.35, dtSeconds: 3600 });
  assert.ok(Math.abs(threeQuarter.level - 0.3) < 1e-9, `3/4=${threeQuarter.level}`);
  assert.equal(approach({ level: 0.15, target: 0.35, dtSeconds: 0 }).level, 0.15);
});

test('S09：目标突变 0→1 单次变化恰为 0.30 并追加 STRESS_CLAMPED', () => {
  const warnings = [];
  const step = approach({ level: 0, target: 1, dtSeconds: 1800, warnings });
  assert.equal(step.level, 0.3);
  assert.equal(step.delta, 0.3);
  assert.equal(step.clamped, true);
  assert.ok(warnings.includes('STRESS_CLAMPED'));
});

test('S10：35 条事件截断到 32 条并追加 EVENTS_EVICTED', () => {
  const events = [];
  for (let i = 0; i < 35; i += 1) {
    events.push(
      activeEvent({
        event_id: `evt_bulk_${String(i).padStart(4, '0')}`,
        event_type: 'group_message',
        decay_profile: 'none',
        intensity: 0.02,
        remaining: 0.02 + i * 0.001
      })
    );
  }
  const result = runStress(stressState({ active_events: events }));
  assert.equal(result.state.active_events.length, 32);
  assert.ok(result.warnings.includes('EVENTS_EVICTED'));
  // 按 |remaining| 降序，最强刺激优先保留
  assert.equal(result.state.active_events[0].remaining, 0.054);
});

test('S11：remaining=0.004 剔除，0.006 保留', () => {
  const result = runStress(
    stressState({
      active_events: [
        activeEvent({
          event_id: 'evt_small_0001',
          event_type: 'group_message',
          decay_profile: 'none',
          intensity: 0.004,
          remaining: 0.004
        }),
        activeEvent({
          event_id: 'evt_small_0002',
          event_type: 'group_message',
          decay_profile: 'none',
          intensity: 0.006,
          remaining: 0.006
        })
      ]
    })
  );
  assert.equal(result.state.active_events.length, 1);
  assert.equal(result.state.active_events[0].event_id, 'evt_small_0002');
  assert.equal(result.state.active_events[0].remaining, 0.006);
});

test('S12：同一天多次满足静默条件只生成 1 条 long_silence', () => {
  const first = runStress(
    stressState({ last_event_at: '2026-11-08T18:00:00.000Z' }),
    { now: '2026-11-09T01:00:00.000Z' }
  );
  const silences = first.state.active_events.filter((ev) => ev.event_type === 'long_silence');
  assert.equal(silences.length, 1);
  assert.match(silences[0].event_id, /^evt_silence_20261109_[0-9a-f]{8}$/);
  assert.equal(silences[0].intensity, 0.05);
  assert.equal(silences[0].decay_profile, 'very_slow');
  assert.equal(silences[0].source_key, 'silence:primary');
  assert.ok(first.contributions['stress.level'].silence > 0);

  const second = runStress(first.state, { now: '2026-11-09T08:30:00.000Z' });
  const again = second.state.active_events.filter((ev) => ev.event_type === 'long_silence');
  assert.equal(again.length, 1);
  assert.equal(again[0].event_id, silences[0].event_id);
});

test('S12：确定性 event_id 与幂等键按 07 §5.7 生成', () => {
  const identity = silenceIdentity('group_123', '2026-11-09T09:00:00.000Z', 'Asia/Shanghai');
  assert.match(identity.event_id, /^evt_silence_\d{8}_[0-9a-f]{8}$/);
  assert.match(identity.idempotency_key, /^silence_[0-9a-f]{8}_\d{8}$/);
  assert.equal(identity.idempotency_key.includes(':'), false);
  assert.equal(identity.event_id.includes('group_123'), false);
});

test('S14：comfort_received 使 Σremaining<0，target 低于 0.15', () => {
  assert.ok(targetStress(-0.1) < 0.15);
  assert.equal(targetStress(-0.1), 0.05);
  assert.equal(targetStress(0), 0.15);
  assert.equal(targetStress(2), 1);
  assert.equal(targetStress(-1), 0);
});

test('S18：dt=0 时应用 conflict，level 立即上升 (target-level)×0.5', () => {
  const result = runApply(evt({ event_type: 'conflict' }));
  assert.equal(result.state.level, 0.275);
  assert.equal(result.contributions['stress.level'].event, 0.125);
  assert.equal(result.contributions['stress.level'].decay, 0);
});

test('S19：应用 comfort_received 时 level 立即下降，contributions.event 为负', () => {
  const result = runApply(evt({ event_type: 'comfort_received' }));
  assert.ok(result.state.level < 0.15);
  assert.equal(result.state.level, 0.1);
  assert.ok(result.contributions['stress.level'].event < 0);
  assert.equal(result.contributions['stress.level'].event, -0.05);
});

test('S20：距 last_event_at 7 小时的一次推进会惰性生成 long_silence 并更新 last_event_at', () => {
  const result = runStress(stressState({ last_event_at: '2026-11-09T02:00:00.000Z' }));
  const silence = result.state.active_events.find((ev) => ev.event_type === 'long_silence');
  assert.ok(silence, '必须生成 long_silence');
  assert.equal(silence.source_key, 'silence:primary');
  assert.equal(result.state.last_event_at, NOW);
  assert.ok(result.reason_codes.includes('long_silence_generated'));
});

test('S21：inputs.activity 缺失但 previous.last_event_at 存在时仍按该时间判断', () => {
  const result = updateStress({
    previous: stressState({ last_event_at: '2026-11-09T02:00:00.000Z' }),
    inputs: { event: null },
    now: NOW,
    rng: null,
    config: {}
  });
  assert.equal(result.warnings.includes('MISSING_ACTIVITY_DATA'), false);
  assert.ok(result.state.active_events.some((ev) => ev.event_type === 'long_silence'));
});

test('S21：activity 与 previous.last_event_at 全缺失时不生成并追加 MISSING_ACTIVITY_DATA', () => {
  const result = updateStress({
    previous: stressState({ last_event_at: null }),
    inputs: { event: null },
    now: NOW,
    rng: null,
    config: {}
  });
  assert.equal(result.state.active_events.length, 0);
  assert.ok(result.warnings.includes('MISSING_ACTIVITY_DATA'));
});

test('S22：即时响应 + 衰减合计单次 level 变化 ≤0.30', () => {
  const previous = stressState({
    level: 0.9,
    active_events: [
      activeEvent({
        event_id: 'evt_seed_comfort1',
        event_type: 'comfort_received',
        decay_profile: 'none',
        intensity: -0.1,
        remaining: -0.1,
        source_key: 'wechat:conv_1:sender_comfort'
      })
    ],
    last_decay_at: '2026-11-09T08:30:00.000Z'
  });
  const result = runApply(evt({ event_type: 'conflict' }), { previous });
  const total = Math.abs(result.state.level - 0.9);
  assert.ok(total <= 0.3 + 1e-9, `总变化 ${total} 超过 0.30`);
  assert.equal(result.state.level, 0.6);
  assert.ok(result.warnings.includes('STRESS_CLAMPED'));
});

test('S23：负强度衰减到 -0.004 被剔除，-0.006 保留', () => {
  const result = runStress(
    stressState({
      active_events: [
        activeEvent({
          event_id: 'evt_small_neg1',
          event_type: 'comfort_received',
          decay_profile: 'none',
          intensity: -0.004,
          remaining: -0.004
        }),
        activeEvent({
          event_id: 'evt_small_neg2',
          event_type: 'comfort_received',
          decay_profile: 'none',
          intensity: -0.006,
          remaining: -0.006
        })
      ]
    })
  );
  assert.equal(result.state.active_events.length, 1);
  assert.equal(result.state.active_events[0].event_id, 'evt_small_neg2');
  assert.equal(result.state.active_events[0].remaining, -0.006);
  assert.equal(Object.is(result.state.active_events[0].remaining, -0), false);
});

test('衰减：逐 tick 复合等于一次性衰减到同一时刻', () => {
  const step1 = remainingAt(0.5, 'slow', 900);
  const step2 = remainingAt(step1, 'slow', 900);
  const once = remainingAt(0.5, 'slow', 1800);
  assert.ok(Math.abs(step2 - once) < 1e-6);
});

test('即时响应：系数 0.5 且单步上限 0.30', () => {
  const step = instantResponse({ level: 0, target: 1 });
  assert.equal(step.level, 0.3);
  assert.equal(step.clamped, true);
});

test('上升与下降：level 始终留在 [0,1]', () => {
  const up = runApply(evt({ event_id: 'evt_20261109_bound001', event_type: 'conflict' }), {
    previous: stressState({ level: 1 })
  });
  assert.ok(up.state.level <= 1 && up.state.level >= 0);
  const down = runApply(evt({ event_id: 'evt_20261109_bound002', event_type: 'comfort_received' }), {
    previous: stressState({ level: 0 })
  });
  assert.ok(down.state.level >= 0 && down.state.level <= 1);
  assert.ok(down.state.level > 0);
});
