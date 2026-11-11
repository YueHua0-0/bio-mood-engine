/**
 * T05：同 idempotency_key 并发 10 次 → 仅 1 次推进，其余 duplicate，evlog 仅 1 条。
 * T06：同角色并行 20 次推进 → 串行完成，版本严格 +1，无半写、无重复事件日志。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMutex } from '../../lib/core/coordinator.mjs';
import { loadValidState } from '../helpers/state.mjs';
import { CHARACTER_ID, FIXED_NOW, memoryRepo } from '../helpers/repo.mjs';

function bumped(state) {
  return {
    ...state,
    state_version: state.state_version + 1,
    updated_at: FIXED_NOW,
    last_tick_at: FIXED_NOW
  };
}

function eventRecord({ eventId, idemKey, before, after }) {
  return {
    event_id: eventId,
    event_type: 'group_message',
    occurred_at: '2026-11-09T09:19:00.000Z',
    processed_at: FIXED_NOW,
    source_key: 'wechat:group_123:sender_a1',
    intensity: 0.02,
    idempotency_key: idemKey,
    state_version_before: before,
    state_version_after: after
  };
}

function idemRecord(key) {
  return {
    key,
    character_id: CHARACTER_ID,
    result: { delivery: { policy: 'deliver_now' } },
    expires_at: '2026-11-16T09:20:01.000Z'
  };
}

function advanceOnce(repo, idemKey) {
  return repo.transaction(async (tx) => {
    const current = await tx.getState(CHARACTER_ID);
    assert.ok(current, 'advanceOnce 需要已存在的状态');
    const duplicate = await tx.getIdempotency(idemKey);
    if (duplicate) return { duplicate: true, state_version: duplicate.state_version };
    const next = bumped(current.state);
    await tx.putState(next, current.version);
    await tx.appendEvent(
      eventRecord({
        eventId: idemKey,
        idemKey,
        before: current.version,
        after: current.version + 1
      })
    );
    await tx.appendIdempotency(idemRecord(idemKey));
    return { duplicate: false, state_version: current.version + 1 };
  });
}

test('T05 幂等并发：同一 idempotency_key 并发 10 次只推进一次', async () => {
  const { repo, storage } = memoryRepo({ initial: { state: loadValidState() } });
  const mutex = createMutex();
  const key = 'evt_20261109_concurrent01';
  const results = await Promise.all(
    Array.from({ length: 10 }, () => mutex(() => advanceOnce(repo, key)))
  );
  const advanced = results.filter((item) => item.duplicate === false);
  const duplicates = results.filter((item) => item.duplicate === true);
  assert.equal(advanced.length, 1, '只允许一次真正推进');
  assert.equal(duplicates.length, 9, '其余九次必须是幂等命中');
  assert.equal(storage.json('state').state_version, 43);
  assert.equal(storage.json('evlog').length, 1, 'evlog 不得重复写入');
  assert.equal(storage.json('idem').length, 1, 'idem 只保留一条');
  for (const item of duplicates) {
    assert.equal(item.state_version, 43, '幂等结果必须返回已提交版本');
  }
});

test('T06 并发串行：同角色 20 个不同 key 全部完成且版本严格 +1', async () => {
  const { repo, storage } = memoryRepo({ initial: { state: loadValidState() } });
  const mutex = createMutex();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      mutex(() => advanceOnce(repo, `evt_20261109_parallel${String(index).padStart(2, '0')}`))
    )
  );
  const versions = results.map((item) => item.state_version).sort((a, b) => a - b);
  assert.deepEqual(
    versions,
    Array.from({ length: 20 }, (_, index) => 43 + index),
    '每次推进必须恰好 +1，不允许跳号'
  );
  assert.equal(storage.json('state').state_version, 62);
  const events = storage.json('evlog');
  assert.equal(events.length, 20);
  assert.equal(new Set(events.map((entry) => entry.event_id)).size, 20, '事件 id 不得重复');
  const state = storage.json('state');
  assert.equal(state.state_version, 62, '落盘状态可被完整解析（无半写）');
  const lastEvent = events[events.length - 1];
  assert.equal(lastEvent.state_version_after, 62);
  assert.equal(storage.json('meta').tx_journal, null, '提交完成后不得残留 WAL');
});
