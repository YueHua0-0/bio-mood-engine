import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chunkElapsed,
  coarseForward,
  diffSeconds,
  effectiveNow,
  localParts,
  parseTime,
  toIso
} from '../../lib/core/clock.mjs';

test('T05 非法时间格式抛 INVALID_TIME', () => {
  for (const bad of ['2026-11-09T09:20:01Z', 'not-a-time', '2026-02-30T00:00:00.000Z', '2026-11-09 09:20:01.000Z']) {
    assert.throws(() => parseTime(bad, 'now'), (err) => err.code === 'INVALID_TIME', bad);
  }
});

test('T06 parseTime 返回正确毫秒数且往返一致', () => {
  const ms = parseTime('2026-11-09T09:20:01.000Z', 'x');
  assert.equal(ms - parseTime('2026-11-09T09:20:00.000Z', 'x'), 1000);
  const samples = [
    '1970-01-01T00:00:00.000Z',
    '2026-11-09T09:20:01.000Z',
    '2024-02-29T23:59:59.999Z',
    '1999-12-31T23:00:00.000Z'
  ];
  for (const iso of samples) assert.equal(toIso(parseTime(iso, 'x')), iso);
});

test('T07 localParts 使用 IANA 时区（Asia/Shanghai 16:00Z = 次日 00:00）', () => {
  const parts = localParts('2026-11-09T16:00:00.000Z', 'Asia/Shanghai');
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 10);
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 0);
  assert.equal(parts.second, 0);
  assert.equal(parts.dayFraction, 0);
});

test('T08 夏令时切换不产生 hour=24 或偏移错误（America/New_York）', () => {
  const before = localParts('2026-03-08T06:59:00.000Z', 'America/New_York');
  assert.equal(before.hour, 1);
  assert.equal(before.minute, 59);
  const after = localParts('2026-03-08T07:00:00.000Z', 'America/New_York');
  assert.equal(after.hour, 3);
  assert.equal(after.minute, 0);
  for (let hour = 0; hour < 24; hour += 1) {
    const iso = toIso(parseTime('2026-03-08T00:00:00.000Z', 'x') + hour * 3_600_000);
    assert.ok(localParts(iso, 'America/New_York').hour < 24);
  }
});

test('T09/T10/T11/T12 分块边界', () => {
  assert.deepEqual(chunkElapsed({ elapsedSeconds: 0 }), { chunks: [], leftoverSeconds: 0, coarse: false });
  assert.deepEqual(chunkElapsed({ elapsedSeconds: 3600 }), { chunks: [3600], leftoverSeconds: 0, coarse: false });
  assert.deepEqual(chunkElapsed({ elapsedSeconds: 3601 }), { chunks: [3600, 1], leftoverSeconds: 0, coarse: false });
  const day = chunkElapsed({ elapsedSeconds: 86_400 });
  assert.equal(day.chunks.length, 24);
  assert.equal(day.coarse, false);
});

test('T13/T14 4320 步上限与粗推进标记', () => {
  const exact = chunkElapsed({ elapsedSeconds: 180 * 86_400 });
  assert.equal(exact.chunks.length, 4320);
  assert.equal(exact.coarse, false);
  assert.equal(exact.leftoverSeconds, 0);

  const overflow = chunkElapsed({ elapsedSeconds: 181 * 86_400 });
  assert.equal(overflow.chunks.length, 4320);
  assert.equal(overflow.coarse, true);
  assert.equal(overflow.leftoverSeconds, 86_400);
});

test('T15 10 年离线在 2 秒内完成分块', () => {
  const started = process.hrtime.bigint();
  const result = chunkElapsed({ elapsedSeconds: 3650 * 86_400 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.chunks.length, 4320);
  assert.equal(result.coarse, true);
  assert.ok(elapsedMs < 2000, `chunking took ${elapsedMs.toFixed(1)}ms`);
});

test('T16 回拨超过 5 分钟 → CLOCK_REGRESSION 且 elapsed 归零', () => {
  const result = effectiveNow({ now: '2026-11-09T07:54:59.000Z', lastTickAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(result.effective_now, '2026-11-09T08:00:00.000Z');
  assert.deepEqual(result.warnings, ['CLOCK_REGRESSION']);
  assert.equal(result.deltaMs, 0);
});

test('T17 回拨 2 分钟 → CLOCK_TOLERATED', () => {
  const result = effectiveNow({ now: '2026-11-09T07:58:00.000Z', lastTickAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(result.effective_now, '2026-11-09T08:00:00.000Z');
  assert.deepEqual(result.warnings, ['CLOCK_TOLERATED']);
});

test('正常前进不产生警告', () => {
  const result = effectiveNow({ now: '2026-11-09T09:00:00.000Z', lastTickAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(result.effective_now, '2026-11-09T09:00:00.000Z');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.deltaMs, 3_600_000);
});

test('diffSeconds 向下取整', () => {
  assert.equal(diffSeconds('2026-11-09T08:00:00.000Z', '2026-11-09T09:00:59.999Z'), 3659);
});

test('coarseForward 30 天粗推进：情绪向 home 收敛、睡眠债按日均净变化', () => {
  const state = {
    timezone: 'Asia/Shanghai',
    mood: { energy: 0.95, stability: 0.2, sensitivity: 0.9, social_drive: 0.9, stress: 0.8, physical_comfort: 0.1, closeness_need: 0.95, model_version: 1 },
    stress: { level: 0.9, active_events: [{ event_id: 'evt_0001', remaining: 0.001 }], last_decay_at: '2026-01-01T00:00:00.000Z', model_version: 1 },
    sleep: {
      state: 'sleeping',
      state_since: '2026-01-01T00:00:00.000Z',
      planned_wake_at: '2026-01-01T07:30:00.000Z',
      sleep_debt: 0.2,
      sleep_quality: 0.7,
      sleepiness: 0.2,
      circadian_phase: 0,
      recovery_progress: 0.4,
      last_transition_reason: 'asleep',
      model_version: 1
    },
    cycle: { cycle_index: 0, cycle_length_days: 28, cycle_day: 16, phase: 'luteal_like', model_version: 1 }
  };
  const next = coarseForward({
    state,
    leftoverSeconds: 30 * 86_400,
    now: '2026-02-01T00:00:00.000Z',
    hooks: {
      advanceCycleDays: ({ cycle }) => ({ ...cycle, cycle_day: 1 }),
      sleepinessSteady: (hour, sleepDebt) => 0.10 + 0.45 * sleepDebt
    }
  });
  assert.ok(Math.abs(next.mood.energy - 0.60) < 0.01, `energy=${next.mood.energy}`);
  assert.ok(next.mood.stability > 0.6);
  assert.ok(next.stress.level < 0.05);
  assert.deepEqual(next.stress.active_events, []);
  // 30 天 × (-0.196) → 0.2 - 5.88 → 0
  assert.equal(next.sleep.sleep_debt, 0);
  assert.equal(next.sleep.state, 'awake');
  assert.equal(next.sleep.last_transition_reason, 'coarse_wake');
  assert.notEqual(next.cycle.cycle_day, 16);
  assert.deepEqual(state.mood.energy, 0.95, 'coarseForward 不得修改入参');
});

test('coarseForward 缺 05/06 注入 hook → MODULE_FAILED，不静默退化', () => {
  const state = {
    timezone: 'Asia/Shanghai',
    mood: { energy: 0.6, stability: 0.6, sensitivity: 0.5, social_drive: 0.5, stress: 0.2, physical_comfort: 0.7, closeness_need: 0.5, model_version: 1 },
    stress: { level: 0.2, active_events: [], last_decay_at: '2026-01-01T00:00:00.000Z', model_version: 1 },
    sleep: {
      state: 'awake',
      sleep_debt: 0.2,
      sleep_quality: 0.7,
      sleepiness: 0.2,
      circadian_phase: 0,
      recovery_progress: 1,
      last_transition_reason: 'init',
      model_version: 1
    },
    cycle: { cycle_index: 0, cycle_length_days: 28, cycle_day: 1, phase: 'menstrual_like', model_version: 1 }
  };
  assert.throws(
    () => coarseForward({ state, leftoverSeconds: 86_400, now: '2026-02-01T00:00:00.000Z' }),
    (err) => err.code === 'MODULE_FAILED' && err.details?.module === 'sleep'
  );
  assert.throws(
    () => coarseForward({
      state,
      leftoverSeconds: 86_400,
      now: '2026-02-01T00:00:00.000Z',
      hooks: { sleepinessSteady: () => 0.2 }
    }),
    (err) => err.code === 'MODULE_FAILED' && err.details?.module === 'cycle'
  );
});
