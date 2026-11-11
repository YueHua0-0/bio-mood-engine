import assert from 'node:assert/strict';
import test from 'node:test';

import { MASTER_SEED } from './_random_vectors.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { MIGRATIONS, assertCompatibleEngine, migrate } from '../../lib/core/versioning.mjs';

const START = '2026-11-09T08:00:00.000Z';

function baseState() {
  return createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED
  });
}

test('T23 迁移 1 → 2 幂等（两次结果深度相等）', () => {
  const original = MIGRATIONS[1];
  MIGRATIONS[1] = [(state) => ({ ...state, schema_version: 2 })];
  try {
    const state = baseState();
    const once = migrate(state, 2);
    const twice = migrate(once, 2);
    assert.equal(once.schema_version, 2);
    assert.deepEqual(once, twice);
    assert.deepEqual(migrate(state, 2), once);
  } finally {
    MIGRATIONS[1] = original;
  }
});

test('T24 schema_version 高于引擎时抛 STATE_VERSION_CONFLICT', () => {
  const state = baseState();
  state.schema_version = 99;
  assert.throws(() => migrate(state, 1), (err) => err.code === 'STATE_VERSION_CONFLICT');
  assert.throws(() => assertCompatibleEngine(state, '0.1.0'), (err) => err.code === 'STATE_VERSION_CONFLICT');
});

test('schema_version 缺失视为损坏（INTERNAL），不猜测', () => {
  const state = baseState();
  delete state.schema_version;
  assert.throws(() => migrate(state, 1), (err) => err.code === 'INTERNAL');
});

test('没有注册迁移步骤时拒绝跳级', () => {
  assert.throws(() => migrate(baseState(), 2), (err) => err.code === 'INTERNAL');
});

test('engine_version 主版本高于运行时不兼容', () => {
  const state = baseState();
  state.engine_version = '2.0.0';
  assert.throws(
    () => assertCompatibleEngine(state, '1.0.0'),
    (err) => err.code === 'STATE_VERSION_CONFLICT'
  );
});

test('engine_version 同主版本且 schema 一致时通过', () => {
  const state = baseState();
  assert.deepEqual(assertCompatibleEngine(state, '0.1.0'), { ok: true });
  assert.deepEqual(assertCompatibleEngine(state, '0.2.0'), { ok: true });
});
