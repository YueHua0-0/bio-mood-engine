/**
 * T10：迁移链 1→2→3 按顺序执行、只执行一次、失败原子回滚、缺步骤明确报错。
 * 迁移实现见 04 §5.6；本用例只注入用户态 `{target_version, steps}`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultState } from '../../lib/core/models.mjs';
import { CHARACTER_ID, FIXED_NOW, MASTER_SEED, START, memoryRepo } from '../helpers/repo.mjs';
import { makeState } from '../helpers/state.mjs';

function versionedState() {
  return makeState({ schema_version: 1 });
}

function freshState(config) {
  return createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED,
    config
  });
}

function legacyState() {
  return makeState({ schema_version: 1, config_version: 1 });
}

/** 真实事务链：ensureReady/runMigrations → tx.getState → tx.putState → WAL W4。 */
async function writeOneVersion(repo) {
  return repo.transaction(async (tx) => {
    const current = await tx.getState(CHARACTER_ID);
    assert.ok(current, '事务必须读到待迁移状态');
    const next = {
      ...current.state,
      state_version: current.version + 1,
      updated_at: FIXED_NOW,
      last_tick_at: FIXED_NOW
    };
    await tx.putState(next, current.version);
    return next;
  });
}

/** v1 管理写与直接 v2 控制组必须具有相同操作序列和最终状态。 */
async function runAdminMigration({ operation, payload, prepare, seed }) {
  const initial = legacyState();
  const migrating = memoryRepo({
    initial: { state: initial },
    seed_factory: seed ? () => seed : undefined
  });
  const control = memoryRepo({
    initial: { state: { ...initial, config_version: 2 } },
    seed_factory: seed ? () => seed : undefined
  });
  const request = { operation, payload, prepare, now: FIXED_NOW };

  const result = await migrating.repo.adminReset(CHARACTER_ID, request);
  const controlResult = await control.repo.adminReset(CHARACTER_ID, request);
  assert.equal(result.ok, true);
  assert.deepEqual(result, controlResult);

  const state = migrating.storage.json('state');
  assert.equal(state.config_version, 2);
  assert.deepEqual(state, control.storage.json('state'));
  assert.deepEqual(
    migrating.storage.writes(),
    control.storage.writes(),
    'v1→v2 不得比已 v2 的同一管理操作多任何 set/delete'
  );
  assert.equal(
    migrating.storage.writes().filter((entry) => entry.op === 'set' && entry.key === 'state').length,
    1,
    '配置迁移必须复用原管理操作唯一一次 state 写入'
  );
  return { initial, result, state, storage: migrating.storage };
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
  assert.equal(loaded.config_version, 2, 'schema 迁移后配置维度独立升级');
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
  assert.equal(loaded.config_version, 2);
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

test('CM1 新建状态默认 config_version=2，显式旧版构造仍保留 v1', () => {
  assert.equal(freshState().config_version, 2);
  assert.equal(freshState({ config_version: 1 }).config_version, 1);
});

test('CM2 v1 只读加载保持 v1，且 writes=0', async () => {
  const initial = legacyState();
  const { repo, storage } = memoryRepo({ initial: { state: initial } });
  assert.equal(initial.cycle.model_version, 1, 'fixture 必须保留周期模型历史版本');
  const loaded = await repo.loadState(CHARACTER_ID, { readOnly: true });
  assert.equal(loaded.state.config_version, 1);
  assert.equal(loaded.state.cycle.model_version, 1, '只读加载不得升级 cycle.model_version');
  assert.equal(storage.json('state').config_version, 1);
  assert.equal(storage.json('state').cycle.model_version, 1);
  assert.deepEqual(storage.writes(), [], '只读加载不得写 state/meta/evlog/idem/cfg');
});

test('CM3 写路径 loadState 返回 v2，重复执行为内存幂等且不额外写盘', async () => {
  const { repo, storage } = memoryRepo({ initial: { state: legacyState() } });
  const first = await repo.loadState(CHARACTER_ID);
  const second = await repo.loadState(CHARACTER_ID);
  assert.equal(first.config_version, 2);
  assert.deepEqual(second, first, '重复 config 迁移必须返回相同状态');
  assert.equal(storage.json('state').config_version, 1, '没有原写操作时不得仅为升级版本写盘');
  assert.deepEqual(storage.writes(), [], 'config 迁移自身不得产生任何持久化写入');
});

test('CM4 真实事务随原 W4 写回 v2，写入序列与已 v2 控制组一致', async () => {
  const initial = legacyState();
  const migrating = memoryRepo({ initial: { state: initial } });
  const control = memoryRepo({ initial: { state: { ...initial, config_version: 2 } } });

  const migrated = await writeOneVersion(migrating.repo);
  const controlResult = await writeOneVersion(control.repo);
  const expected = { ...initial, config_version: 2, state_version: initial.state_version + 1 };

  assert.deepEqual(migrated, expected, '除 config_version/state_version 外不得改变无关字段');
  assert.deepEqual(migrated, controlResult);
  assert.deepEqual(migrating.storage.json('state'), migrated, 'v2 必须随原事务落盘');
  assert.deepEqual(
    migrating.storage.writes(),
    control.storage.writes(),
    'v1→v2 不得比已 v2 的同一事务多任何 set/delete'
  );
  assert.equal(
    migrating.storage.writes().filter((entry) => entry.op === 'set' && entry.key === 'state').length,
    1,
    'state 只能由原 WAL W4 写一次'
  );
});

test('CM5 已 v2 状态重复加载与事务保持 v2，无配置迁移附加写入', async () => {
  const { repo, storage } = memoryRepo({
    initial: { state: { ...legacyState(), config_version: 2 } }
  });
  const first = await repo.loadState(CHARACTER_ID);
  const second = await repo.loadState(CHARACTER_ID);
  assert.equal(first.config_version, 2);
  assert.deepEqual(second, first);
  assert.deepEqual(storage.writes(), []);

  const once = await writeOneVersion(repo);
  const twice = await writeOneVersion(repo);
  assert.equal(once.config_version, 2);
  assert.equal(twice.config_version, 2);
  assert.equal(storage.json('state').config_version, 2);
});

test('CM6 cycle profile 变化不驱动 config_version 升级', () => {
  const low = { pain_sensitivity: 0, luteal_sensitivity: 0, mood_variability: 0, intimacy_variability: 0 };
  const high = { pain_sensitivity: 1.5, luteal_sensitivity: 1.5, mood_variability: 1.5, intimacy_variability: 1.5 };
  const legacyLow = freshState({ config_version: 1, cycle: { profile: low } });
  const legacyHigh = freshState({ config_version: 1, cycle: { profile: high } });
  assert.equal(legacyLow.config_version, 1);
  assert.equal(legacyHigh.config_version, 1);
  assert.deepEqual(legacyHigh, legacyLow, '运行时 profile 不进入持久化状态，也不得隐式升级版本');

  const currentLow = freshState({ cycle: { profile: low } });
  const currentHigh = freshState({ cycle: { profile: high } });
  assert.equal(currentLow.config_version, 2);
  assert.equal(currentHigh.config_version, 2);
  assert.deepEqual(currentHigh, currentLow);
});

test('CM7 adminReset reset_state：v1 随原管理写入迁移，保留种子与创建时间并清空 idem', async () => {
  const { initial, result, state, storage } = await runAdminMigration({ operation: 'reset_state' });
  assert.equal(result.state_version, initial.state_version + 1);
  assert.equal(state.random.master_seed_hex, initial.random.master_seed_hex);
  assert.equal(state.created_at, initial.created_at);
  assert.equal(state.updated_at, FIXED_NOW);
  assert.deepEqual(storage.json('idem'), []);
  assert.ok(storage.json('evlog').some((entry) => entry.event_type === 'admin_command'));
});

test('CM8 adminReset reset_seed：v1 迁移不改变换种、保留其他状态及审计语义', async () => {
  const seed = '00112233445566778899aabbccddeeff';
  const { initial, result, state, storage } = await runAdminMigration({ operation: 'reset_seed', seed });
  assert.equal(result.state_version, initial.state_version + 1);
  assert.equal(state.random.master_seed_hex, seed);
  assert.notEqual(state.random.master_seed_hex, initial.random.master_seed_hex);
  assert.deepEqual(state.mood, initial.mood);
  assert.deepEqual(state.cycle, initial.cycle);
  assert.ok(storage.json('evlog').some((entry) => entry.event_type === 'admin_command'));
});

test('CM9 adminReset manual_cycle_correction：prepare 收到 v2，且不能回退配置版本', async () => {
  const anchor = '2026-11-01T00:00:00.000Z';
  const { initial, result, state, storage } = await runAdminMigration({
    operation: 'manual_cycle_correction',
    payload: { anchor_at: anchor },
    prepare: (current) => {
      assert.equal(current.config_version, 2, 'prepare 必须复用已迁移的状态');
      return {
        ...current,
        config_version: 1,
        cycle: { ...current.cycle, anchor_at: anchor, cycle_length_source: 'manual' }
      };
    }
  });
  assert.equal(result.state_version, initial.state_version + 1);
  assert.equal(state.cycle.anchor_at, anchor);
  assert.equal(state.cycle.cycle_length_source, 'manual');
  assert.equal(state.config_version, 2, 'prepare 不得将管理写结果回退为 v1');
  assert.ok(storage.json('evlog').some((entry) => entry.event_type === 'admin_command'));
});

test('CM10 saveState 是低层原样写 API，调用方负责提供正确配置版本', async () => {
  const { repo, storage } = memoryRepo();
  const initial = freshState();
  assert.equal(initial.config_version, 2, '生产空库 bootstrap 的调用方状态必须为 v2');
  assert.deepEqual(await repo.saveState(initial, 0), { ok: true, state_version: 0 });
  assert.deepEqual(storage.json('state'), initial, '低层 API 不得改写调用方提供的 v2 状态');

  const callerLegacy = { ...initial, config_version: 1, state_version: 1 };
  assert.deepEqual(await repo.saveState(callerLegacy, 0), { ok: true, state_version: 1 });
  assert.equal(
    storage.json('state').config_version,
    1,
    'saveState 不得暗中承担迁移；生产调用方不得借此写入旧版本'
  );
});

