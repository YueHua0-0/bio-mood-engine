import assert from 'node:assert/strict';
import test from 'node:test';

import { MASTER_SEED } from './_random_vectors.mjs';

import {
  createDefaultState,
  normalizeState,
  round6,
  stateFingerprint,
  stateSummary,
  validateState
} from '../../lib/core/models.mjs';

const NOW = '2026-11-09T08:00:00.000Z';

function baseState(overrides = {}) {
  return createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: NOW,
    master_seed_hex: MASTER_SEED,
    ...overrides
  });
}

test('T01 默认状态校验通过，关键默认值符合 02 §5.1', () => {
  const state = baseState();
  const check = validateState(state);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(state.schema_version, 1);
  assert.equal(state.state_version, 0);
  assert.equal(state.sleep.state, 'awake');
  assert.equal(state.sleep.sleep_debt, 0.15);
  assert.equal(state.sleep.sleep_quality, 0.7);
  assert.equal(state.sleep.sleepiness, 0.25);
  assert.equal(state.stress.level, 0.15);
  assert.deepEqual(state.stress.active_events, []);
  assert.equal(state.regulation.reward_sensitivity, 0.5);
  assert.equal(Object.keys(state.random.streams).length, 5);
  // planned_wake_at 是本地 07:30（Asia/Shanghai = UTC+8 → 23:30Z 前一天）
  assert.equal(state.sleep.planned_wake_at, '2026-11-09T23:30:00.000Z');
  assert.equal(state.last_tick_at, NOW);
});

test('T02 越界拒绝 — mood.energy 1.2', () => {
  const state = baseState();
  state.mood.energy = 1.2;
  const check = validateState(state);
  assert.equal(check.ok, false);
  assert.equal(check.path, 'mood.energy');
  assert.equal(check.code, 'INVALID_REQUEST');
});

test('T03 NaN 被拒绝，不得静默改成 0', () => {
  const state = baseState();
  state.mood.energy = Number.NaN;
  assert.throws(() => normalizeState(state), (err) => err.code === 'INVALID_REQUEST');
  const check = validateState(state);
  assert.equal(check.ok, false);
  assert.equal(check.path, 'mood.energy');
});

test('T04 round6 四舍五入并去掉 -0', () => {
  assert.equal(round6(0.12345678), 0.123457);
  assert.equal(round6(-1e-9), 0);
  assert.equal(Object.is(round6(-1e-9), -0), false);
});

test('越界值归一化后落在边界', () => {
  const state = baseState();
  state.mood.energy = 1.2;
  const normalized = normalizeState(state);
  assert.equal(normalized.mood.energy, 1);
  const check = validateState(normalized);
  assert.equal(check.ok, true);
});

test('forbidden 字段被拒绝', () => {
  const state = baseState();
  state.sleep.text = '今天好累';
  const check = validateState(state);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'INVALID_REQUEST');
  assert.match(check.message, /forbidden/i);
});

test('T25 stateFingerprint 稳定且对数值变化敏感', () => {
  const a = baseState();
  const b = baseState();
  assert.equal(stateFingerprint(a), stateFingerprint(b));
  b.mood.energy = round6(b.mood.energy + 0.01);
  assert.notEqual(stateFingerprint(a), stateFingerprint(b));
});

test('NaN 直接校验也返回结构化错误', () => {
  const state = baseState();
  state.mood.energy = Number.NaN;
  assert.throws(() => normalizeState(state), (err) => err.code === 'INVALID_REQUEST');
});

test('normalizeState 去 -0 且 active_events 排序/去重/截断', () => {
  const state = baseState();
  state.sleep.sleep_debt = -0.0000001;
  state.stress.active_events = [];
  for (let i = 0; i < 40; i += 1) {
    state.stress.active_events.push({
      event_id: `evt_${String(i).padStart(4, '0')}`,
      event_type: 'praise',
      started_at: NOW,
      intensity: 0.5,
      remaining: 0.01 * (i + 1) * (i % 2 === 0 ? 1 : -1),
      decay_profile: 'fast',
      source_key: 'wechat:group_1:sender_a'
    });
  }
  state.stress.active_events.push({
    event_id: 'evt_0000',
    event_type: 'praise',
    started_at: NOW,
    intensity: 0.5,
    remaining: -0.9,
    decay_profile: 'fast',
    source_key: 'wechat:group_1:sender_a'
  });
  state.stress.active_events.push({
    event_id: 'evt_tiny',
    event_type: 'praise',
    started_at: NOW,
    intensity: 0.1,
    remaining: 0.001,
    decay_profile: 'fast',
    source_key: 'wechat:group_1:sender_a'
  });

  const normalized = normalizeState(state);
  assert.equal(Object.is(normalized.sleep.sleep_debt, -0), false);
  assert.equal(normalized.stress.active_events.length, 32);
  const ids = normalized.stress.active_events.map((ev) => ev.event_id);
  assert.equal(new Set(ids).size, 32);
  const duplicated = normalized.stress.active_events.find((ev) => ev.event_id === 'evt_0000');
  if (duplicated) assert.equal(duplicated.remaining, -0.9);
  assert.ok(!ids.includes('evt_tiny'));
  for (let i = 1; i < normalized.stress.active_events.length; i += 1) {
    const prev = Math.abs(normalized.stress.active_events[i - 1].remaining);
    const cur = Math.abs(normalized.stress.active_events[i].remaining);
    assert.ok(prev >= cur);
  }
});

test('stateSummary 脱敏且不含种子明文', () => {
  const state = baseState();
  const summary = stateSummary(state);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(MASTER_SEED));
  assert.equal(summary.random.master_seed_id.length, 8);
  assert.deepEqual(Object.keys(summary.mood).length, 7);
});

test('未知顶层键与未知 stream 键被拒绝', () => {
  const extra = baseState();
  extra.unknown_key = 1;
  assert.equal(validateState(extra).ok, false);

  const badStreams = baseState();
  badStreams.random.streams.extra = { seed_hex: 'a'.repeat(32), counter: 0 };
  const check = validateState(badStreams);
  assert.equal(check.ok, false);
  assert.equal(check.path, 'random.streams');
});

test('非法时区被拒绝', () => {
  assert.throws(
    () => createDefaultState({
      character_id: 'whale_character',
      timezone: 'Mars/Olympus',
      now: NOW,
      master_seed_hex: MASTER_SEED
    }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});
