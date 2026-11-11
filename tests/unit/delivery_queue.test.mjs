/**
 * 11 §8 D09–D14：排队延迟、24h 上限、合并（coalesced_into）与重新校验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { recheck } from '../../lib/modules/delivery/policy.mjs';
import { COALESCE_THRESHOLD, planQueue } from '../../lib/modules/delivery/queue.mjs';
import { updateDelivery } from '../../lib/modules/delivery/index.mjs';

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

function run({ sleep = {}, pending = [], event = makeEvent() } = {}) {
  return updateDelivery({
    previous: null,
    inputs: {
      event,
      sleep: { state: 'sleeping', sleepiness: 0.60, sleep_debt: 0.30, planned_wake_at: null, ...sleep },
      queue: { pending }
    },
    now: NOW,
    rng: null,
    config: {}
  });
}

function pendingItem(conversation_id, queued_at, event_id) {
  return { conversation_id, queued_at, event_id };
}

test('D09 planned_wake_at 有效：delay = 差值，expires = deliver_after + 24h', () => {
  const plan = planQueue({ now: NOW, planned_wake_at: '2026-11-10T08:30:00.000Z' });
  assert.equal(plan.delay, 1800);
  assert.equal(plan.deliver_after, '2026-11-10T08:30:00.000Z');
  assert.equal(plan.expires_at, '2026-11-11T08:30:00.000Z');
  assert.deepEqual(plan.reason_codes, ['planned_wake_reached']);
});

test('D10 planned_wake_at 缺失：1800 是重校验间隔，不是交付时刻', () => {
  const result = run();
  assert.equal(result.state.policy, 'queue_until_awake');
  assert.equal(result.state.recommended_delay_seconds, 1800);
  assert.equal(result.state.deliver_after, '2026-11-10T08:30:00.000Z');
  assert.equal(result.state.expires_at, '2026-11-11T08:30:00.000Z');
  assert.ok(result.state.reason_codes.includes('planned_wake_missing'));
});

test('D11 planned_wake_at 超 24h：delay 截断为 86400 并追加 queue_capped', () => {
  const result = run({ sleep: { planned_wake_at: '2026-11-11T14:00:00.000Z' } });
  assert.equal(result.state.recommended_delay_seconds, 86400);
  assert.equal(result.state.deliver_after, '2026-11-11T08:00:00.000Z');
  assert.ok(result.state.reason_codes.includes('queue_capped'));
});

test('D12 10 分钟内同会话第 3 条：silent_ignore + coalesced_into(merged_count=3)', () => {
  const pending = [
    pendingItem('conv_a', '2026-11-10T07:55:00.000Z', 'evt_old_0001'),
    pendingItem('conv_a', '2026-11-10T07:57:00.000Z', 'evt_old_0002')
  ];
  const result = run({ pending });
  const delivery = result.state;

  assert.equal(delivery.policy, 'silent_ignore');
  assert.deepEqual(delivery.coalesced_into, {
    event_id: 'evt_old_0001',
    conversation_id: 'conv_a',
    earliest_queued_at: '2026-11-10T07:55:00.000Z',
    merged_count: 3
  });
  assert.equal(delivery.recommended_delay_seconds, 0);
  assert.equal(delivery.expires_at, null);
  assert.equal(delivery.deliver_after, NOW);
  assert.ok(delivery.reason_codes.includes('sleeping'));
  assert.ok(delivery.reason_codes.includes('coalesced'));
  assert.ok(delivery.reason_codes.indexOf('sleeping') < delivery.reason_codes.indexOf('coalesced'));
});

test('D12 窗口外的 pending 不参与合并（第 2 条仍是 queue）', () => {
  const pending = [pendingItem('conv_a', '2026-11-10T07:49:00.000Z', 'evt_old_0001')];
  const result = run({ pending });
  assert.equal(result.state.policy, 'queue_until_awake');
  assert.equal(result.state.coalesced_into, undefined);
});

test('D12b 第 4、5 条继续到达：merged_count 递增，保留项不变', () => {
  const base = [
    pendingItem('conv_a', '2026-11-10T07:55:00.000Z', 'evt_old_0001'),
    pendingItem('conv_a', '2026-11-10T07:57:00.000Z', 'evt_old_0002')
  ];
  const three = run({ pending: base });
  assert.equal(three.state.coalesced_into.merged_count, 3);

  const four = run({ pending: [...base, pendingItem('conv_a', '2026-11-10T07:58:00.000Z', 'evt_old_0003')] });
  assert.equal(four.state.coalesced_into.merged_count, 4);
  assert.equal(four.state.coalesced_into.event_id, 'evt_old_0001');

  const five = run({
    pending: [
      ...base,
      pendingItem('conv_a', '2026-11-10T07:58:00.000Z', 'evt_old_0003'),
      pendingItem('conv_a', '2026-11-10T07:59:00.000Z', 'evt_old_0004')
    ]
  });
  assert.equal(five.state.coalesced_into.merged_count, 5);
  assert.equal(five.state.coalesced_into.event_id, 'evt_old_0001');
});

test('D12c queued_at 完全相同：取 event_id 字典序最小者（确定性）', () => {
  const pending = [
    pendingItem('conv_a', '2026-11-10T07:55:00.000Z', 'evt_zzz_0001'),
    pendingItem('conv_a', '2026-11-10T07:55:00.000Z', 'evt_aaa_0001')
  ];
  const result = run({ pending });
  assert.equal(result.state.coalesced_into.event_id, 'evt_aaa_0001');
  assert.equal(result.state.coalesced_into.earliest_queued_at, '2026-11-10T07:55:00.000Z');

  const again = run({ pending: [...pending].reverse() });
  assert.equal(again.state.coalesced_into.event_id, 'evt_aaa_0001');
});

test('D12 其他会话的 pending 不参与合并', () => {
  const pending = [
    pendingItem('conv_b', '2026-11-10T07:55:00.000Z', 'evt_old_0001'),
    pendingItem('conv_b', '2026-11-10T07:57:00.000Z', 'evt_old_0002')
  ];
  const result = run({ pending });
  assert.equal(result.state.policy, 'queue_until_awake');
});

test('合并阈值常量与 §5.5 一致（窗口 10 分钟、≥3 条）', () => {
  assert.equal(COALESCE_THRESHOLD, 3);
});

test('D13 recheck：已醒 -> deliver_now + state_changed_awake', () => {
  const result = recheck({
    queueItem: {
      event_id: 'evt_old_0001',
      queued_at: '2026-11-10T07:55:00.000Z',
      expires_at: '2026-11-11T08:00:00.000Z',
      recommended_delay_seconds: 1800
    },
    sleep: { state: 'awake' },
    now: NOW
  });
  assert.equal(result.policy, 'deliver_now');
  assert.equal(result.recommended_delay_seconds, 0);
  assert.deepEqual(result.reason_codes, ['state_changed_awake']);
});

test('D14 recheck：已过 expires_at -> silent_ignore + expired', () => {
  const result = recheck({
    queueItem: {
      event_id: 'evt_old_0001',
      queued_at: '2026-11-09T07:55:00.000Z',
      expires_at: '2026-11-10T07:00:00.000Z'
    },
    sleep: { state: 'sleeping' },
    now: NOW
  });
  assert.equal(result.policy, 'silent_ignore');
  assert.equal(result.expires_at, null);
  assert.deepEqual(result.reason_codes, ['expired']);
});

test('recheck：仍 sleeping 且未过期 -> 保持 queue，delay 取重校验间隔', () => {
  const result = recheck({
    queueItem: { event_id: 'evt_old_0001', queued_at: '2026-11-10T07:55:00.000Z', expires_at: '2026-11-11T08:00:00.000Z' },
    sleep: { state: 'sleeping' },
    now: NOW
  });
  assert.equal(result.policy, 'queue_until_awake');
  assert.equal(result.recommended_delay_seconds, 1800);
  assert.equal(result.deliver_after, '2026-11-10T08:30:00.000Z');
  assert.equal(result.expires_at, '2026-11-11T08:00:00.000Z');
});
