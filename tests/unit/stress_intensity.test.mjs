/**
 * 07 §8 用例 S01–S05、S13、S15–S17、S24、S25（强度 / 倍率 / 合并 / 派生输出）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEvent,
  eventModule,
  stressModule,
  updateStress
} from '../../lib/modules/stress/index.mjs';
import {
  baseIntensity,
  computeIntensity,
  decayProfile,
  relationshipMultiplier
} from '../../lib/modules/stress/event.mjs';

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

function evt(overrides = {}) {
  const base = {
    event_id: 'evt_20261109_int0001',
    event_type: 'group_message',
    occurred_at: NOW,
    source: {
      platform: 'wechat',
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

function collectKeys(value, target, out = []) {
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (key === target) out.push(key);
    collectKeys(child, target, out);
  }
  return out;
}

test('S01：9 种事件 × ordinary 的强度严格等于 00 §2.3 表', () => {
  const table = {
    group_message: 0.02,
    mention: 0.08,
    important_person_appear: 0.12,
    comfort_received: -0.1,
    conflict: 0.25,
    long_silence: 0.05,
    direct_question: 0.06,
    admin_command: 0,
    system_event: 0
  };
  for (const [eventType, expected] of Object.entries(table)) {
    assert.equal(baseIntensity(eventType), expected, `baseIntensity(${eventType})`);
    assert.equal(computeIntensity(evt({ event_type: eventType })), expected, `computeIntensity(${eventType})`);
  }
});

test('S01：衰减档与 00 §2.3 一致', () => {
  assert.deepEqual(
    ['group_message', 'mention', 'important_person_appear', 'comfort_received', 'conflict', 'long_silence', 'direct_question', 'admin_command', 'system_event'].map(decayProfile),
    ['fast', 'medium', 'slow', 'medium', 'slow', 'very_slow', 'medium', 'none', 'none']
  );
});

test('S02：6 种关系 × mention 的倍率', () => {
  const expected = {
    ordinary: 0.08,
    important: 0.12,
    intimate: 0.104,
    conflict: 0.16,
    admin: 0,
    unknown: 0.08
  };
  for (const [tag, value] of Object.entries(expected)) {
    assert.equal(
      computeIntensity(evt({ event_type: 'mention', source: { relationship_tag: tag } })),
      value,
      tag
    );
  }
  assert.equal(relationshipMultiplier('important'), 1.5);
  assert.equal(relationshipMultiplier('intimate'), 1.3);
  assert.equal(relationshipMultiplier('conflict'), 2);
  assert.equal(relationshipMultiplier('admin'), 0);
  assert.equal(relationshipMultiplier('nonsense'), 1);
});

test('S03：group_message + is_mentioned 提升到 0.08（不叠加成 0.10）', () => {
  assert.equal(computeIntensity(evt({ source: { is_mentioned: true } })), 0.08);
});

test('S03：负强度事件不适用 @ 提升', () => {
  assert.equal(
    computeIntensity(evt({ event_type: 'comfort_received', source: { is_mentioned: true } })),
    -0.1
  );
});

test('S04：direct_question + is_direct_question 为 0.080（0.06+0.02）', () => {
  assert.equal(
    computeIntensity(evt({ event_type: 'direct_question', payload: { is_direct_question: true } })),
    0.08
  );
  // bonus 在倍率之后相加、不被倍率放大
  assert.equal(
    computeIntensity(
      evt({
        event_type: 'direct_question',
        source: { relationship_tag: 'conflict' },
        payload: { is_direct_question: true }
      })
    ),
    0.14
  );
});

test('S05：300 秒内同源两条合并为 1 条', () => {
  const previous = stressState({
    active_events: [
      {
        event_id: 'evt_seed_merge01',
        event_type: 'mention',
        started_at: '2026-11-09T08:55:00.000Z',
        intensity: 0.08,
        remaining: 0.08,
        decay_profile: 'medium',
        source_key: 'wechat:conv_1:sender_1'
      }
    ]
  });
  const result = runApply(
    evt({ event_id: 'evt_20261109_int0002', event_type: 'mention' }),
    { previous }
  );
  assert.equal(result.state.active_events.length, 1);
  assert.equal(result.state.active_events[0].event_id, 'evt_seed_merge01');
  assert.equal(result.state.active_events[0].remaining, 0.12);
  assert.equal(result.state.active_events[0].started_at, '2026-11-09T08:55:00.000Z');
});

test('S05：301 秒同源两条保留 2 条', () => {
  const previous = stressState({
    active_events: [
      {
        event_id: 'evt_seed_merge02',
        event_type: 'mention',
        started_at: '2026-11-09T08:54:59.000Z',
        intensity: 0.08,
        remaining: 0.08,
        decay_profile: 'medium',
        source_key: 'wechat:conv_1:sender_1'
      }
    ]
  });
  const result = runApply(
    evt({ event_id: 'evt_20261109_int0003', event_type: 'mention' }),
    { previous }
  );
  assert.equal(result.state.active_events.length, 2);
});

test('S13：同 event_id 连发 3 次，level 与列表只计 1 次', () => {
  const event = evt({ event_id: 'evt_20261109_dup00001', event_type: 'conflict' });
  const first = runApply(event);
  const second = runApply(event, { previous: first.state });
  const third = runApply(event, { previous: second.state });

  assert.equal(first.state.active_events.length, 1);
  assert.equal(second.state.active_events.length, 1);
  assert.equal(third.state.active_events.length, 1);
  assert.equal(second.state.level, first.state.level);
  assert.equal(third.state.level, first.state.level);
  assert.ok(second.reason_codes.includes('duplicate_event'));
  assert.ok(second.warnings.includes('DUPLICATE_EVENT_MERGED'));
});

test('S15：注入 NaN 强度抛 INVALID_REQUEST 且不改动 previous', () => {
  const previous = stressState();
  const snapshot = JSON.parse(JSON.stringify(previous));
  for (const bad of [
    evt({ intensity: Number.NaN }),
    evt({ intensity: Number.POSITIVE_INFINITY }),
    evt({ intensity_override: Number.NaN })
  ]) {
    assert.throws(
      () => runApply(bad, { previous }),
      (err) => err.code === 'INVALID_REQUEST',
      'NaN 强度必须被拒绝'
    );
  }
  assert.deepEqual(previous, snapshot);
  assert.equal(previous.active_events.length, 0);
});

test('S15：非法 event_type / event_id 抛 INVALID_REQUEST', () => {
  const previous = stressState();
  assert.throws(
    () => runApply(evt({ event_type: 'not_a_type' }), { previous }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => runApply(evt({ event_id: 'short' }), { previous }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => runApply(evt({ occurred_at: '2026-11-09 09:00:00' }), { previous }),
    (err) => err.code === 'INVALID_TIME'
  );
});

test('S16：同输入同 now 执行两次输出深度相等（无随机）', () => {
  const event = evt({ event_type: 'mention', source: { relationship_tag: 'important' } });
  const previous = stressState({
    active_events: [
      {
        event_id: 'evt_seed_det001',
        event_type: 'group_message',
        started_at: '2026-11-09T08:58:00.000Z',
        intensity: 0.02,
        remaining: 0.02,
        decay_profile: 'fast',
        source_key: 'wechat:conv_1:sender_2'
      }
    ]
  });
  const a = runApply(event, { previous });
  const b = runApply(event, { previous });
  assert.deepEqual(a, b);
  assert.deepEqual(runStress(previous), runStress(previous));
});

test('S17：返回对象无 mood 键、无 mood.* 贡献', () => {
  const result = runApply(evt({ event_type: 'conflict' }));
  assert.deepEqual(collectKeys(result, 'mood'), []);
  assert.deepEqual(Object.keys(result.contributions), ['stress.level']);
  assert.deepEqual(Object.keys(result.contributions['stress.level']).sort(), ['decay', 'event', 'silence']);
  assert.deepEqual(collectKeys(runStress(stressState()), 'mood'), []);
});

test('S24：applyEvent 输出 derived.event_intensity，且等于 computeIntensity 的最终值', () => {
  const event = evt({
    event_id: 'evt_20261109_dev00001',
    event_type: 'mention',
    source: { relationship_tag: 'important', is_mentioned: true },
    payload: { is_direct_question: true }
  });
  const result = runApply(event);
  assert.equal(typeof result.derived.event_intensity, 'number');
  assert.equal(result.derived.event_intensity, 0.14);
  assert.equal(result.derived.event_intensity, computeIntensity(event));
});

test('S24：intensity_override 优先于 computeIntensity，derived 反映最终值', () => {
  const event = evt({ event_type: 'conflict', intensity_override: 0.42 });
  const result = runApply(event);
  assert.equal(computeIntensity(event), 0.42);
  assert.equal(result.derived.event_intensity, 0.42);
  assert.equal(result.state.active_events[0].intensity, 0.42);
  assert.ok(result.warnings.includes('INTENSITY_OVERRIDE'));
});

test('S24：关系倍率 / @ / direct_question 全部计入 derived', () => {
  const event = evt({
    event_type: 'group_message',
    source: { relationship_tag: 'conflict', is_mentioned: true },
    payload: { is_direct_question: true }
  });
  // base=0.02 -> @ 提升到 0.08；×2.0 = 0.16；+0.02 = 0.18
  assert.equal(runApply(event).derived.event_intensity, 0.18);
});

test('S24：零强度事件也输出 derived.event_intensity = 0，但不入 active_events', () => {
  const event = evt({ event_type: 'admin_command', source: { relationship_tag: 'admin' } });
  const result = runApply(event);
  assert.equal(result.derived.event_intensity, 0);
  assert.equal(result.state.active_events.length, 0);
  assert.equal(result.state.last_event_at, NOW);
});

test('S25：updateStress（inputs.event === null）返回对象不含 derived 键', () => {
  const result = runStress(stressState());
  assert.equal('derived' in result, false);
  assert.equal(result.derived, undefined);
});

test('S25：applyEvent 收到 inputs.event === null 时省略整个 derived 键', () => {
  const result = applyEvent({
    previous: stressState(),
    inputs: { event: null, activity: { last_event_at: null, recent_event_ids: [] } },
    now: NOW,
    rng: null,
    config: {}
  });
  assert.equal('derived' in result, false);
});

test('S25：updateStress 携带事件时抛 INVALID_REQUEST', () => {
  assert.throws(
    () =>
      updateStress({
        previous: stressState(),
        inputs: { event: evt(), activity: {} },
        now: NOW,
        rng: null,
        config: {}
      }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});

test('source_key：普通事件 / 冲突 / 管理指令 / 静默四种形状', () => {
  const mention = runApply(evt({ event_id: 'evt_20261109_key00001', event_type: 'mention' }));
  assert.equal(mention.state.active_events[0].source_key, 'wechat:conv_1:sender_1');

  const conflict = runApply(evt({ event_id: 'evt_20261109_key00002', event_type: 'conflict' }));
  assert.equal(conflict.state.active_events[0].source_key, 'wechat:conv_1:*');

  const admin = runApply(evt({ event_id: 'evt_20261109_key00003', event_type: 'admin_command' }));
  assert.equal(admin.state.active_events.length, 0);
});

test('模块注册表：stress 与 event 均导出 name / update', () => {
  assert.equal(stressModule.name, 'stress');
  assert.equal(stressModule.update, updateStress);
  assert.equal(eventModule.name, 'event');
  assert.equal(eventModule.update, applyEvent);
});

test('贡献值形状：只写 stress.level，来源固定 decay/event/silence 且无 -0', () => {
  const result = runApply(evt({ event_type: 'conflict' }));
  const contribution = result.contributions['stress.level'];
  for (const value of Object.values(contribution)) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
    assert.equal(Object.is(value, -0), false);
  }
  const plain = runStress(stressState());
  assert.deepEqual(plain.contributions['stress.level'], { decay: 0, event: 0, silence: 0 });
});
