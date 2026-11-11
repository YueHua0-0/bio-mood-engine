/**
 * T10：迁移链 1→2→3 按顺序执行、只执行一次、失败原子回滚、缺步骤明确报错。
 * 迁移实现见 04 §5.6；本用例只注入用户态 `{target_version, steps}`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXED_NOW, memoryRepo } from '../helpers/repo.mjs';
import { makeState } from '../helpers/state.mjs';

function versionedState() {
  return makeState({ schema_version: 1 });
}

function chain() {
  const order = [];
  const migrations = {
    target_version: 3,
    steps: {
      1: [
        (state) => {
          order.push('1->2');
          return { ...state, engine_version: '0.2.0' };
        }
      ],
      2: [
        (state) => {
          order.push('2->3');
          return { ...state, engine_version: '0.3.0' };
        }
      ]
    }
  };
  return { order, migrations };
}

test('T10 迁移：1→2→3 顺序执行，迁移记录与备份清理正确', async () => {
  const { order, migrations } = chain();
  const { repo, storage } = memoryRepo({ initial: { state: versionedState() }, migrations });
  const loaded = await repo.loadState('whale_character');
  assert.equal(loaded.schema_version, 3);
  assert.equal(loaded.engine_version, '0.3.0');
  assert.deepEqual(order, ['1->2', '2->3']);

  const meta = storage.json('meta');
  assert.deepEqual(
    meta.schema_migrations.map((item) => [item.from, item.to]),
    [[1, 2], [2, 3]]
  );
  assert.equal(meta.state_backup, null, '迁移成功后必须删除备份');
  assert.equal(storage.json('state').schema_version, 3);
});

test('T10 迁移幂等：同一存储再次打开不重复执行', async () => {
  const { order, migrations } = chain();
  const first = memoryRepo({ initial: { state: versionedState() }, migrations });
  await first.repo.loadState('whale_character');
  assert.equal(order.length, 2);

  const second = memoryRepo({ initial: first.storage.dump(), migrations });
  const loaded = await second.repo.loadState('whale_character');
  assert.equal(loaded.schema_version, 3);
  assert.equal(order.length, 2, '第二次打开不得重复跑迁移');
  assert.equal(second.storage.json('meta').schema_migrations.length, 2);
});

test('T10 迁移失败：回写原状态、保留备份、抛 INTERNAL，不猜测后续版本', async () => {
  const { migrations } = chain();
  migrations.steps[2] = [
    () => {
      throw new Error('boom');
    }
  ];
  const { repo, storage } = memoryRepo({ initial: { state: versionedState() }, migrations });
  await assert.rejects(
    () => repo.loadState('whale_character'),
    (err) => err?.code === 'INTERNAL'
  );
  assert.equal(storage.json('state').schema_version, 1, '失败后状态必须停留在 1');
  assert.equal(storage.json('state').engine_version, '0.1.0');
  const meta = storage.json('meta');
  assert.ok(meta.state_backup && meta.state_backup.schema_version === 1, '必须保留备份');
  assert.equal(meta.schema_migrations.length, 0, '失败必须回滚整条链的迁移记录');
  assert.equal(meta.state_backup.created_at, FIXED_NOW);
});

test('T10 未知新版本：schema_version=99 → STATE_VERSION_CONFLICT，拒绝写入', async () => {
  const state = makeState({ schema_version: 99 });
  const { repo, storage } = memoryRepo({ initial: { state } });
  await assert.rejects(
    () => repo.loadState('whale_character'),
    (err) => err?.code === 'STATE_VERSION_CONFLICT'
  );
  assert.equal(storage.json('state').schema_version, 99, '读取失败不得改写磁盘状态');
});

test('T10 迁移缺步骤：不得静默跳过，抛 STATE_VERSION_CONFLICT', async () => {
  const { migrations } = chain();
  delete migrations.steps[2];
  const { repo, storage } = memoryRepo({ initial: { state: versionedState() }, migrations });
  await assert.rejects(
    () => repo.loadState('whale_character'),
    (err) => err?.code === 'STATE_VERSION_CONFLICT'
  );
  assert.equal(storage.json('state').schema_version, 2);
});

