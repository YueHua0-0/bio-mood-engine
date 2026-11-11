/**
 * T07：四时区 DST 语义（上海 / 纽约 / 伦敦 / 悉尼）——跨日、日长、偏移。
 * T08：同一 zone 与不同 zone 的角色推进互不影响（隔离运行 == 交替运行）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { diffSeconds, localParts } from '../../lib/core/clock.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { createDefaultState, stateFingerprint } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { isoAfter } from '../helpers/clock.mjs';
import { loadValidState } from '../helpers/state.mjs';

const MODULES = [
  cycleModule,
  sleepModule,
  stressModule,
  eventModule,
  regulationModule,
  moodModule,
  behaviorModule,
  deliveryModule
];
const ZONES = JSON.parse(readFileSync(new URL('../fixtures/timezones.json', import.meta.url), 'utf8')).zones;

function offsetAt(iso, zone) {
  const p = localParts(iso, zone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const utcSeconds = Math.floor(Date.parse(iso) / 1000) * 1000;
  const minutes = Math.round((localAsUtc - utcSeconds) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const dayKey = (iso, zone) => {
  const p = localParts(iso, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

test('T07 时区：四区偏移、DST 前后本地小时与 fixture 一致', () => {
  for (const [zone, spec] of Object.entries(ZONES)) {
    if (!spec.has_dst) {
      assert.equal(spec.transitions.length, 0, `${zone} 不应有 DST 迁移`);
      for (const iso of ['2026-01-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z', '2026-11-09T12:00:00.000Z']) {
        assert.equal(offsetAt(iso, zone), spec.utc_offset, `${zone} 在 ${iso} 的偏移不符`);
      }
      continue;
    }
    for (const transition of spec.transitions) {
      const before = localParts(isoAfter(transition.at, -1), zone);
      const after = localParts(transition.at, zone);
      assert.equal(before.hour, transition.local_hour_before, `${zone} ${transition.at} 迁移前小时不符`);
      assert.equal(after.hour, transition.local_hour_after, `${zone} ${transition.at} 迁移后小时不符`);
      assert.equal(offsetAt(isoAfter(transition.at, -1), zone), transition.offset_before);
      assert.equal(offsetAt(transition.at, zone), transition.offset_after);
    }
  }
});

test('T07 跨日与日长：上海跨日 +1 天，纽约/伦敦 23h，悉尼 25h', () => {
  assert.notEqual(
    dayKey('2026-11-09T15:59:59.000Z', 'Asia/Shanghai'),
    dayKey('2026-11-09T16:00:01.000Z', 'Asia/Shanghai'),
    '上海本地跨日必须更换 day_key'
  );
  assert.equal(diffSeconds('2026-11-09T15:59:59.000Z', '2026-11-09T16:00:01.000Z'), 2);

  // 纽约春季前跳：墙上 01:00 → 03:00，但真实只过了 1 小时。
  const nyJump = diffSeconds('2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z');
  assert.equal(nyJump, 3600);
  assert.equal(localParts('2026-03-08T06:00:00.000Z', 'America/New_York').hour, 1);
  assert.equal(localParts('2026-03-08T07:00:00.000Z', 'America/New_York').hour, 3);

  const nyDay = diffSeconds('2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z');
  assert.equal(nyDay, 23 * 3600, '纽约 2026-03-08 只有 23 小时');

  const londonDay = diffSeconds('2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z');
  assert.equal(londonDay, 23 * 3600, '伦敦 2026-03-29 只有 23 小时');

  const sydneyDay = diffSeconds('2026-04-04T13:00:00.000Z', '2026-04-05T14:00:00.000Z');
  assert.equal(sydneyDay, 25 * 3600, '悉尼 2026-04-05 有 25 小时');
});

function runSteps(state, count) {
  let current = state;
  let now = state.last_tick_at;
  const provider = RandomProvider.fromPersisted({
    random: state.random,
    character_id: state.character_id
  });
  const out = [];
  for (let step = 0; step < count; step += 1) {
    now = isoAfter(now, 3600);
    current = advance({ state: current, event: null, now, rngProvider: provider, modules: MODULES }).state;
    out.push(current);
  }
  return out;
}

test('T08 时钟回拨：-10min → CLOCK_REGRESSION，-2min → CLOCK_TOLERATED，时间戳不回退', () => {
  const state = loadValidState();
  for (const [offsetSeconds, expected] of [[-600, 'CLOCK_REGRESSION'], [-120, 'CLOCK_TOLERATED']]) {
    const out = advance({
      state,
      event: null,
      now: isoAfter(state.last_tick_at, offsetSeconds),
      rngProvider: RandomProvider.fromPersisted({
        random: state.random,
        character_id: state.character_id
      }),
      modules: MODULES
    });
    assert.ok(out.diagnostics.warnings.includes(expected), `回拨 ${offsetSeconds}s 应产生 ${expected}`);
    assert.equal(out.state.last_tick_at, state.last_tick_at, '回拨不得写入更早的时间');
    assert.equal(out.state.updated_at, state.last_tick_at);
    assert.equal(out.state.state_version, state.state_version + 1);
  }
});

test('T08b 事件 occurred_at 超前 6 分钟不改变推进基准（钳制在 /v1/events 入口，见 A21）', () => {
  const state = loadValidState();
  const now = isoAfter(state.last_tick_at, 300);
  const event = JSON.parse(readFileSync(new URL('../fixtures/events/direct_question.json', import.meta.url), 'utf8'));
  event.occurred_at = isoAfter(now, 360);
  event.received_at = now;
  const out = advance({
    state,
    event,
    now,
    rngProvider: RandomProvider.fromPersisted({
      random: state.random,
      character_id: state.character_id
    }),
    modules: MODULES
  });
  assert.equal(out.state.last_tick_at, now, '推进基准不得被未来事件推高');
  assert.ok(out.state.state_version > state.state_version);
  // P-02-02：钳制与 FUTURE_OCCURRED_AT 属入站规范化，在 POST /v1/events 入口完成，
  // 断言落在 tests/unit/api_endpoints.test.mjs 的 A21；`effectiveNow` 不处理事件时间。
});

test('时区隔离：同 zone 与不同 zone 的两个角色，交替推进结果等于各自单独推进', () => {
  const east = loadValidState();
  const sharedNow = east.last_tick_at;
  const west = createDefaultState({
    character_id: 'char_west',
    timezone: 'America/New_York',
    now: sharedNow,
    master_seed_hex: east.random.master_seed_hex
  });
  assert.notEqual(east.timezone, west.timezone);

  const eastAlone = runSteps(east, 24);
  const westAlone = runSteps(west, 24);

  let eastState = east;
  let westState = west;
  let now = sharedNow;
  const eastProvider = RandomProvider.fromPersisted({
    random: east.random,
    character_id: east.character_id
  });
  const westProvider = RandomProvider.fromPersisted({
    random: west.random,
    character_id: west.character_id
  });
  const eastMixed = [];
  const westMixed = [];
  for (let step = 0; step < 24; step += 1) {
    now = isoAfter(now, 3600);
    eastState = advance({
      state: eastState,
      event: null,
      now,
      rngProvider: eastProvider,
      modules: MODULES
    }).state;
    westState = advance({
      state: westState,
      event: null,
      now,
      rngProvider: westProvider,
      modules: MODULES
    }).state;
    eastMixed.push(eastState);
    westMixed.push(westState);
  }

  assert.deepEqual(
    eastMixed.map((state) => stateFingerprint(state)),
    eastAlone.map((state) => stateFingerprint(state)),
    '东八区角色受西五区推进影响'
  );
  assert.deepEqual(
    westMixed.map((state) => stateFingerprint(state)),
    westAlone.map((state) => stateFingerprint(state)),
    '西五区角色受东八区推进影响'
  );
  assert.equal(eastState.timezone, 'Asia/Shanghai');
  assert.equal(westState.timezone, 'America/New_York');
  assert.equal(eastState.character_id, 'whale_character');
  assert.equal(westState.character_id, 'char_west');
});
