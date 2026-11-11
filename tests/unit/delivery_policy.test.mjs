/**
 * 11 §8 D01–D08 / D15–D17：紧急度、唤醒代价、五条规则与输出形状。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { updateDelivery } from '../../lib/modules/delivery/index.mjs';
import { POLICIES, decidePolicy, wakeCost } from '../../lib/modules/delivery/policy.mjs';
import { REASON_ORDER } from '../../lib/modules/delivery/reasons.mjs';
import { EVENT_TYPES, urgencyOf } from '../../lib/modules/delivery/urgency.mjs';

const NOW = '2026-11-10T08:00:00.000Z';

function makeEvent(overrides = {}) {
  return {
    event_type: 'group_message',
    is_mentioned: false,
    event_id: 'evt_aaaaaaaa',
    conversation_id: 'conv_a',
    ...overrides
  };
}

function run({ event = makeEvent(), sleep = {}, pending = [] } = {}) {
  return updateDelivery({
    previous: null,
    inputs: {
      event,
      sleep: { state: 'awake', sleepiness: 0.25, sleep_debt: 0.15, planned_wake_at: null, ...sleep },
      queue: { pending }
    },
    now: NOW,
    rng: null,
    config: {}
  });
}

test('D01 sleeping + conflict + 低睡眠负债/中度困倦 -> urgent_interrupt', () => {
  const result = run({
    event: makeEvent({ event_type: 'conflict' }),
    sleep: { state: 'sleeping', sleepiness: 0.60, sleep_debt: 0.10 }
  });
  assert.equal(result.state.policy, 'urgent_interrupt');
  assert.equal(result.state.wake_candidate, true);
  assert.ok(result.state.reason_codes.includes('sleeping'));
  assert.ok(result.state.reason_codes.includes('urgent_conflict'));
  assert.equal(result.state.recommended_delay_seconds, 0);
});

test('D02 sleeping + admin_command + 低睡眠负债/低困倦 -> wake_candidate', () => {
  const result = run({
    event: makeEvent({ event_type: 'admin_command' }),
    sleep: { state: 'sleeping', sleepiness: 0.20, sleep_debt: 0.10 }
  });
  assert.equal(result.state.policy, 'wake_candidate');
  assert.equal(result.state.wake_candidate, true);
  assert.ok(result.state.reason_codes.includes('wake_candidate_low_cost'));
});

test('D03 sleeping + group_message -> queue_until_awake，delay 取 planned_wake_at', () => {
  const result = run({
    sleep: { state: 'sleeping', sleepiness: 0.60, sleep_debt: 0.30, planned_wake_at: '2026-11-10T08:30:00.000Z' }
  });
  assert.equal(result.state.policy, 'queue_until_awake');
  assert.equal(result.state.wake_candidate, false);
  assert.equal(result.state.recommended_delay_seconds, 1800);
  assert.equal(result.state.deliver_after, '2026-11-10T08:30:00.000Z');
  assert.ok(result.state.reason_codes.includes('planned_wake_reached'));
});

test('D04 awake + sleepiness 0.85：urgency 0.49 -> silent_ignore；0.51 -> deliver_now', () => {
  assert.equal(decidePolicy({ sleepState: 'awake', sleepiness: 0.85, urgency: 0.49, wakeCost: 0.3 }), 'silent_ignore');
  assert.equal(decidePolicy({ sleepState: 'awake', sleepiness: 0.85, urgency: 0.51, wakeCost: 0.3 }), 'deliver_now');
  assert.equal(decidePolicy({ sleepState: 'awake', sleepiness: 0.84, urgency: 0.10, wakeCost: 0.3 }), 'deliver_now');
});

test('D05 awake + deliver_now：wake_cost 仍为合法 number 且 round6 后等于自身', () => {
  const result = run({ event: makeEvent({ event_type: 'group_message' }) });
  assert.equal(result.state.policy, 'deliver_now');
  assert.equal(result.state.recommended_delay_seconds, 0);
  assert.equal(typeof result.state.wake_cost, 'number');
  assert.ok(result.state.wake_cost >= 0 && result.state.wake_cost <= 1);
  assert.equal(Number(result.state.wake_cost.toFixed(6)), result.state.wake_cost);
  assert.equal(result.state.expires_at, null);
});

test('D06 conflict 同时满足规则 1 与规则 2：优先 urgent_interrupt', () => {
  const result = run({
    event: makeEvent({ event_type: 'conflict' }),
    sleep: { state: 'sleeping', sleepiness: 0.50, sleep_debt: 0.10 }
  });
  assert.ok(result.state.wake_cost < 0.70);
  assert.equal(result.state.policy, 'urgent_interrupt');
});

test('D07 urgency 0.94（未达 0.95）：wake_cost 低 -> wake_candidate；高 -> queue', () => {
  assert.equal(decidePolicy({ sleepState: 'sleeping', sleepiness: 0.6, urgency: 0.94, wakeCost: 0.60 }), 'wake_candidate');
  assert.equal(decidePolicy({ sleepState: 'sleeping', sleepiness: 0.6, urgency: 0.94, wakeCost: 0.75 }), 'queue_until_awake');
});

test('D08 wake_cost 恰为 0.70 -> queue（严格小于才唤醒）', () => {
  const exact = wakeCost({ sleep_debt: 0.8, sleepiness: 0.666667, urgency: 0.80 });
  assert.equal(exact, 0.70);
  assert.equal(decidePolicy({ sleepState: 'sleeping', sleepiness: 0.666667, urgency: 0.80, wakeCost: 0.70 }), 'queue_until_awake');

  const justBelow = wakeCost({ sleep_debt: 0.8, sleepiness: 0.666, urgency: 0.80 });
  assert.ok(justBelow < 0.70);
  assert.equal(
    decidePolicy({ sleepState: 'sleeping', sleepiness: 0.666, urgency: 0.80, wakeCost: justBelow }),
    'wake_candidate'
  );
});

test('D15 枚举遍历：policy 恒为五值之一、reason_codes 有序且 ≤16、数值合法', () => {
  const states = ['awake', 'sleepy', 'trying_to_sleep', 'sleeping', 'interrupted', 'waking_up'];
  for (const eventType of EVENT_TYPES) {
    for (const isMentioned of [false, true]) {
      for (const state of states) {
        const result = run({
          event: makeEvent({ event_type: eventType, is_mentioned: isMentioned }),
          sleep: { state, sleepiness: 0.5, sleep_debt: 0.3, planned_wake_at: '2026-11-10T09:00:00.000Z' }
        });
        const delivery = result.state;
        assert.ok(POLICIES.includes(delivery.policy), `非法 policy: ${delivery.policy}`);
        assert.ok(Array.isArray(delivery.reason_codes));
        assert.ok(delivery.reason_codes.length <= 16);
        const ordered = REASON_ORDER.filter((code) => delivery.reason_codes.includes(code));
        assert.deepEqual(delivery.reason_codes, ordered, 'reason_codes 必须按 §5.8 排序');
        assert.ok(Number.isFinite(delivery.wake_cost));
        assert.ok(delivery.wake_cost >= 0 && delivery.wake_cost <= 1);
        assert.ok(Number.isInteger(delivery.recommended_delay_seconds));
        if (delivery.policy !== 'queue_until_awake') {
          assert.equal(delivery.recommended_delay_seconds, 0);
          assert.equal(delivery.expires_at, null);
        }
        if (state !== 'sleeping' && state !== 'awake') {
          assert.equal(delivery.policy, 'deliver_now');
          assert.ok(delivery.reason_codes.includes('sleepy_passthrough'));
        }
      }
    }
  }
});

test('D16 九种事件各加 @：urgency 全部 ≥0.60，且不因 @ 降低', () => {
  for (const eventType of EVENT_TYPES) {
    const plain = urgencyOf({ event_type: eventType, is_mentioned: false });
    const mentioned = urgencyOf({ event_type: eventType, is_mentioned: true });
    assert.ok(mentioned >= 0.60, `${eventType} 加 @ 后 urgency 必须 ≥0.60`);
    assert.ok(mentioned >= plain, `${eventType} 的 @ 不得降低 urgency`);
  }
});

test('D17 不改变入参：深度冻结的 inputs 也能完成计算', () => {
  const inputs = {
    event: Object.freeze(makeEvent({ event_type: 'conflict' })),
    sleep: Object.freeze({ state: 'sleeping', sleepiness: 0.3, sleep_debt: 0.1, planned_wake_at: null }),
    queue: Object.freeze({ pending: Object.freeze([]) })
  };
  const result = updateDelivery({ previous: null, inputs, now: NOW, rng: null, config: {} });
  assert.equal(result.state.policy, 'urgent_interrupt');
});

test('非枚举 event_type 拒绝，不兜底为 group_message', () => {
  assert.throws(
    () => run({ event: makeEvent({ event_type: 'unknown_type' }) }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});

test('D18 纯时间推进（event=null, sleeping）：规则 0 -> silent_ignore + no_event（v1.7.9）', () => {
  const result = run({ event: null, sleep: { state: 'sleeping', sleepiness: 0.81, sleep_debt: 0.28 } });
  assert.equal(result.state.policy, 'silent_ignore');
  assert.deepEqual(result.state.reason_codes, ['no_event']);
  assert.equal(result.state.recommended_delay_seconds, 0);
  assert.equal(result.state.expires_at, null);
  assert.equal(result.state.wake_candidate, false);
  assert.equal('coalesced_into' in result.state, false);
  assert.equal(typeof result.state.wake_cost, 'number');
  assert.ok(result.state.wake_cost >= 0 && result.state.wake_cost <= 1);
  assert.equal(Number(result.state.wake_cost.toFixed(6)), result.state.wake_cost);
  assert.equal(result.state.deliver_after, NOW);
});

test('D19 event=null + awake + 低困倦：仍 silent_ignore + no_event，不得 deliver_now', () => {
  const result = run({ event: null, sleep: { state: 'awake', sleepiness: 0.20 } });
  assert.equal(result.state.policy, 'silent_ignore');
  assert.deepEqual(result.state.reason_codes, ['no_event']);
});

test('D20 no_event 互斥：sleeping 条件同时成立时 reason_codes 只有 no_event', () => {
  const result = run({ event: null, sleep: { state: 'sleeping', sleepiness: 0.95, sleep_debt: 0.95 } });
  assert.deepEqual(result.state.reason_codes, ['no_event']);
  assert.ok(!result.state.reason_codes.includes('sleeping'));
});

test('§6 降级：sleep.state 非枚举 -> DEGRADED + UNKNOWN_SLEEP_STATE', () => {
  const result = run({ sleep: { state: 'hibernating' } });
  assert.equal(result.state.policy, 'deliver_now');
  assert.ok(result.warnings.includes('DEGRADED'));
  assert.ok(result.warnings.includes('UNKNOWN_SLEEP_STATE'));
});

test('§6 降级：sleepiness / sleep_debt 缺失 -> DEGRADED + MISSING_SLEEP_DATA', () => {
  const result = updateDelivery({
    previous: null,
    inputs: { event: makeEvent(), sleep: {}, queue: { pending: [] } },
    now: NOW,
    rng: null,
    config: {}
  });
  assert.ok(result.warnings.includes('DEGRADED'));
  assert.ok(result.warnings.includes('MISSING_SLEEP_DATA'));
});
