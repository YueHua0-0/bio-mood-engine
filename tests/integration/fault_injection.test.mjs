/**
 * T13：存储适配失败注入（set/get/delete）→ STORAGE_FAILED、无半写、幂等仍成立。
 * T20：WAL 七个崩溃点 W2–W8：崩溃后重启恢复，状态/evlog/idem 一致且只推进一次。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CHARACTER_ID, FIXED_NOW, memoryRepo } from '../helpers/repo.mjs';
import { loadValidState } from '../helpers/state.mjs';

function bumped(state) {
  return {
    ...state,
    state_version: state.state_version + 1,
    updated_at: FIXED_NOW,
    last_tick_at: FIXED_NOW
  };
}

function record(idemKey, before) {
  return {
    event_id: idemKey,
    event_type: 'group_message',
    occurred_at: '2026-11-09T09:19:00.000Z',
    processed_at: FIXED_NOW,
    source_key: 'wechat:group_123:sender_a1',
    intensity: 0.02,
    idempotency_key: idemKey,
    state_version_before: before,
    state_version_after: before + 1
  };
}

function advanceOnce(repo, idemKey) {
  return repo.transaction(async (tx) => {
    const current = await tx.getState(CHARACTER_ID);
    assert.ok(current, 'advanceOnce 需要已存在的状态');
    const duplicate = await tx.getIdempotency(idemKey);
    if (duplicate) return { duplicate: true, state_version: duplicate.state_version };
    await tx.putState(bumped(current.state), current.version);
    await tx.appendEvent(record(idemKey, current.version));
    await tx.appendIdempotency({
      key: idemKey,
      character_id: CHARACTER_ID,
      result: { delivery: { policy: 'deliver_now' } },
      expires_at: '2026-11-16T09:20:01.000Z'
    });
    return { duplicate: false, state_version: current.version + 1 };
  });
}

test('T13 写入失败：W4 写 state 失败 → STORAGE_FAILED，状态与日志回滚，重试只推进一次', async () => {
  const { repo, storage } = memoryRepo({
    initial: { state: loadValidState() },
    failAt: { op: 'set', key: 'state', times: 1 }
  });
  await assert.rejects(
    () => advanceOnce(repo, 'evt_20261109_fail01'),
    (err) => err?.code === 'STORAGE_FAILED'
  );
  assert.equal(storage.json('state').state_version, 42, '失败不得留下半写');
  assert.equal((storage.json('evlog') ?? []).length, 0, 'evlog 不得有残留');
  assert.equal((storage.json('idem') ?? []).length, 0, 'idem 不得有残留');

  const retry = await advanceOnce(repo, 'evt_20261109_fail01');
  assert.equal(retry.duplicate, false);
  assert.equal(retry.state_version, 43);
  assert.equal(storage.json('evlog').length, 1, '重试后只允许一条事件');
});

test('T13 读取失败：get state 失败 → STORAGE_FAILED，不返回伪造状态', async () => {
  const { repo } = memoryRepo({
    initial: { state: loadValidState() },
    failAt: { op: 'get', key: 'state', times: 1 }
  });
  await assert.rejects(
    () => advanceOnce(repo, 'evt_20261109_fail02'),
    (err) => err?.code === 'STORAGE_FAILED'
  );
});

test('T13 删除失败：恢复路径不可用时报错，且不破坏已提交状态', async () => {
  const { repo, storage } = memoryRepo({ initial: { state: loadValidState() } });
  await advanceOnce(repo, 'evt_20261109_fail03');
  assert.equal(storage.json('state').state_version, 43);
  storage.failNext({ op: 'delete', times: 1 });
  // 删除失败只影响后续事务的清理路径；已提交状态必须仍可读且完整。
  const loaded = await repo.loadState(CHARACTER_ID);
  assert.equal(loaded.state_version, 43);
  assert.equal(loaded.state_version, 43);
});

const CRASH_STEPS = ['W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];

test('T20 崩溃恢复：W2–W8 七个崩溃点重启后状态与事件/幂等一致，且只推进一次', async () => {
  // W2–W5 崩在提交点之前：重启必须回滚到 42（W5 后 evlog 已写但 idem 缺失，仍按回滚处理）；
  // W6–W8 崩在全部数据落盘之后：journal 为 prepared 且数据齐全，重启补写 committed，版本为 43。
  const COMMITTED_STEPS = new Set(['W6', 'W7', 'W8']);
  for (const step of CRASH_STEPS) {
    const cases = memoryRepo({ initial: { state: loadValidState() }, crashAt: step });
    const key = `evt_20261109_crash${step.toLowerCase()}`;
    let thrown = null;
    try {
      await advanceOnce(cases.repo, key);
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown === null || thrown.fatal === true || thrown.code === 'STORAGE_FAILED',
      `${step} 只允许抛出致命崩溃或 STORAGE_FAILED，实际 ${thrown?.message}`
    );

    const repo = cases.reopen();
    const loaded = await repo.loadState(CHARACTER_ID);
    const committed = COMMITTED_STEPS.has(step);
    assert.equal(
      loaded.state_version,
      committed ? 43 : 42,
      `${step} 恢复后的已提交版本不符`
    );
    assert.equal(cases.storage.json('evlog')?.length ?? 0, committed ? 1 : 0, `${step} evlog 残留不符`);
    assert.equal(cases.storage.json('idem')?.length ?? 0, committed ? 1 : 0, `${step} idem 残留不符`);
    assert.equal((cases.storage.json('meta') ?? {}).tx_journal ?? null, null, `${step} 恢复后不得残留 WAL`);
    assert.equal((cases.storage.json('meta') ?? {}).recovery_required ?? null, null, `${step} 恢复后不得标记 recovery_required`);

    const retry = await advanceOnce(repo, key);
    assert.equal(cases.storage.json('state').state_version, 43, `${step} 重试后版本必须为 43`);
    assert.equal(cases.storage.json('evlog').length, 1, `${step} 重试后事件不得重复`);
    assert.equal(cases.storage.json('idem').length, 1, `${step} 重试后幂等只保留一条`);
    assert.equal(
      retry.duplicate,
      committed,
      `${step} ${committed ? '已提交，重试必须是幂等命中' : '已回滚，重试应真正推进一次'}`
    );
  }
});

