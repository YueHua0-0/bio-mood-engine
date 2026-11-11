/**
 * 04 §5.6：迁移执行器的单元测试。
 * 只验证"备份 → 应用 → 记录 → 清理"的顺序与失败恢复，不重复 S10/S11 的仓库级用例。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultState } from '../../lib/core/models.mjs';
import { applyMigrations } from '../../lib/storage/migrations.mjs';
import { CHARACTER_ID, MASTER_SEED } from './_random_vectors.mjs';

const NOW = '2026-11-09T09:00:00.000Z';

function baseState() {
  return createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: NOW,
    master_seed_hex: MASTER_SEED
  });
}

function createHarness(state = baseState()) {
  const harness = {
    state,
    meta: { schema_migrations: [], state_backup: null, snapshots: [], tx_journal: null, rollback_state: null },
    writes: [],
    warnings: [],
    clock: () => NOW,
    store: {
      writeState: async (next) => {
        harness.state = next;
        harness.writes.push('state');
      },
      writeMeta: async (next) => {
        harness.meta = next;
        harness.writes.push('meta');
      }
    },
    logger: {
      warn(entry) {
        harness.warnings.push(entry);
      }
    }
  };
  return harness;
}

test('M01 未配置迁移 → 原样返回且不写任何键', async () => {
  const harness = createHarness();
  const result = await applyMigrations({
    state: harness.state,
    meta: harness.meta,
    migrations: null,
    store: harness.store,
    clock: harness.clock,
    logger: harness.logger
  });
  assert.equal(result, harness.state);
  assert.deepEqual(harness.writes, []);
});

test('M02 1→2：备份 → 写状态 → 记录迁移 → 清备份', async () => {
  const harness = createHarness();
  const step = (state) => ({ ...state, sleep: { ...state.sleep, sleep_debt: 0.5 } });
  const result = await applyMigrations({
    state: harness.state,
    meta: harness.meta,
    migrations: { target_version: 2, steps: { 1: [step] } },
    store: harness.store,
    clock: harness.clock,
    logger: harness.logger
  });

  assert.equal(result.schema_version, 2);
  assert.equal(result.sleep.sleep_debt, 0.5);
  assert.deepEqual(
    harness.meta.schema_migrations.map(({ from, to }) => [from, to]),
    [[1, 2]]
  );
  assert.equal(harness.meta.state_backup, null);
  assert.deepEqual(harness.writes, ['meta', 'state', 'meta']);
});

test('M03 步骤抛错 → 回写原状态、保留备份、INTERNAL', async () => {
  const harness = createHarness();
  const before = structuredClone(harness.state);
  const step = () => {
    throw new Error('boom');
  };

  await assert.rejects(
    applyMigrations({
      state: harness.state,
      meta: harness.meta,
      migrations: { target_version: 2, steps: { 1: [step] } },
      store: harness.store,
      clock: harness.clock,
      logger: harness.logger
    }),
    (err) => err.code === 'INTERNAL'
  );

  assert.deepEqual(harness.state, before);
  assert.ok(harness.meta.state_backup, '备份必须保留供人工取证');
  assert.deepEqual(harness.meta.state_backup.state, before);
  // 04 §5.6 / P-14-04：失败时必须落下 migration_failed_at，供 reset_state 逃生舱判定。
  assert.ok(harness.meta.migration_failed_at, 'migration_failed_at 必须写入 meta');
  assert.equal(
    harness.meta.migration_failed_at,
    harness.clock(),
    'migration_failed_at 应取注入的 clock()'
  );
  assert.equal(harness.warnings[0]?.code, 'MIGRATION_FAILED');
});

test('M04 目标版本没有对应步骤 → STATE_VERSION_CONFLICT，不写键', async () => {
  const harness = createHarness();
  await assert.rejects(
    applyMigrations({
      state: harness.state,
      meta: harness.meta,
      migrations: { target_version: 2, steps: {} },
      store: harness.store,
      clock: harness.clock,
      logger: harness.logger
    }),
    (err) => err.code === 'STATE_VERSION_CONFLICT'
  );
  assert.deepEqual(harness.writes, []);
});

test('M05 已处于目标版本 → no-op，不写键', async () => {
  const harness = createHarness({ ...baseState(), schema_version: 2 });
  const result = await applyMigrations({
    state: harness.state,
    meta: harness.meta,
    migrations: { target_version: 2, steps: { 1: [] } },
    store: harness.store,
    clock: harness.clock,
    logger: harness.logger
  });
  assert.equal(result.schema_version, 2);
  assert.deepEqual(harness.writes, []);
});

test('M06 备份超过 8 KiB → 迁移失败且不写任何键（不得跳过备份继续迁移）', async () => {
  const big = {
    ...baseState(),
    sleep: { ...baseState().sleep, last_transition_reason: 'x'.repeat(9 * 1024) }
  };
  const harness = createHarness(big);
  const before = structuredClone(big);
  let stepCalls = 0;

  await assert.rejects(
    applyMigrations({
      state: harness.state,
      meta: harness.meta,
      migrations: {
        target_version: 2,
        steps: { 1: [(state) => { stepCalls += 1; return state; }] }
      },
      store: harness.store,
      clock: harness.clock,
      logger: harness.logger
    }),
    (err) => err.code === 'STORAGE_FAILED' && err.details?.reason === 'migration_failed'
  );

  assert.equal(stepCalls, 0, '备份写不进去时不得继续执行迁移步骤');
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.state, before);
  assert.equal(harness.meta.state_backup, null);
  assert.equal(harness.warnings[0]?.code, 'MIGRATION_FAILED');
  assert.equal(harness.warnings[0]?.reason, 'state_too_large');
});
