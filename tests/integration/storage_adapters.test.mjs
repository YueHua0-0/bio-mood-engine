/**
 * 04 §7 / §9：独立部署存储介质的适配测试（W1）。
 *
 * 覆盖：
 * - `createFileStore`：单键读写、删除、原子替换、键白名单、单键上限、重启恢复；
 * - `createSqliteStore`：`node:sqlite` 可用时持久化，不可用时回退 `file-store` 且带警告；
 * - 两种介质都能被 `createRepository` 直接使用（S09 的介质侧验证）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDefaultState } from '../../lib/core/models.mjs';
import { createFileStore } from '../../lib/storage/file-store.mjs';
import { createRepository } from '../../lib/storage/repository.mjs';
import { createSqliteStore } from '../../lib/storage/sqlite-store.mjs';
import { CHARACTER_ID, MASTER_SEED } from '../unit/_random_vectors.mjs';

const NOW = '2026-11-09T08:00:00.000Z';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bm-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * SQLite 在 Windows 上会锁住 .db / -wal / -shm，必须在删除目录前关闭全部连接。
 * 返回的 `add(store)` 用于登记需要在清理阶段关闭的连接。
 */
async function sqliteTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bm-storage-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) {
      try {
        await store.close();
      } catch {
        // 已显式关闭。
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, add(store) { stores.push(store); return store; } };
}

function baseState() {
  return createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: NOW,
    master_seed_hex: MASTER_SEED
  });
}

function openRepo(storage) {
  return createRepository({
    storage,
    character_id: CHARACTER_ID,
    clock: () => NOW,
    logger: { info() {}, warn() {}, error() {} }
  });
}

// ---------------------------------------------------------------------------
// file-store
// ---------------------------------------------------------------------------

test('SA-F1 file-store 读写删除与重启恢复', async (t) => {
  const dir = await tempDir(t);
  const store = createFileStore({ dir, clock: () => NOW });

  assert.equal(await store.get('state'), null);
  await store.set('state', '{"state_version":0}');
  assert.equal(await store.get('state'), '{"state_version":0}');
  await store.delete('state');
  assert.equal(await store.get('state'), null);
  await store.delete('state'); // 删除不存在的键不抛错

  await store.set('meta', '{"schema_migrations":[]}');
  const reopened = createFileStore({ dir });
  assert.equal(await reopened.get('meta'), '{"schema_migrations":[]}');
});

test('SA-F2 file-store 原子替换且不留临时文件', async (t) => {
  const dir = await tempDir(t);
  const store = createFileStore({ dir });

  await store.set('state', '{"a":1}');
  await store.set('state', '{"a":2}');

  assert.equal(await store.get('state'), '{"a":2}');
  const files = await readdir(dir);
  assert.deepEqual(files, ['state.json']);
});

test('SA-F3 file-store 键白名单与单键上限', async (t) => {
  const dir = await tempDir(t);
  const store = createFileStore({ dir });

  for (const key of ['STATE', 'history2', '../state', 'a'.repeat(65)]) {
    await assert.rejects(
      () => store.get(key),
      (err) => err.code === 'INVALID_REQUEST'
    );
  }

  // 恰好 8 KiB 允许；8 KiB + 1 拒绝且保留旧值。
  await store.set('state', 'a'.repeat(8 * 1024));
  await assert.rejects(
    () => store.set('state', 'a'.repeat(8 * 1024 + 1)),
    (err) => err.code === 'STORAGE_FAILED' && err.details?.reason === 'state_too_large'
  );
  assert.equal((await store.get('state')).length, 8 * 1024);

  // history 仅文件 / SQLite 模式可用。
  await store.set('history', '[]');
  assert.equal(await store.get('history'), '[]');
});

test('SA-F4 createRepository 可直接使用 file-store', async (t) => {
  const dir = await tempDir(t);
  const state = baseState();
  const repo = openRepo(createFileStore({ dir, clock: () => NOW }));
  const saved = await repo.saveState(state, 0);
  assert.equal(saved.ok, true);

  const reopened = openRepo(createFileStore({ dir }));
  const loaded = await reopened.loadState(CHARACTER_ID);
  assert.equal(loaded.state_version, 0);
  assert.equal(loaded.random.master_seed_hex, MASTER_SEED);
});

// ---------------------------------------------------------------------------
// sqlite-store
// ---------------------------------------------------------------------------

test('SA-S1 sqlite-store 可用时持久化', async (t) => {
  const { dir, add } = await sqliteTempDir(t);
  const path = join(dir, 'engine.db');
  const store = add(createSqliteStore({ path, clock: () => NOW }));

  if (store.driver !== 'sqlite') {
    t.skip('node:sqlite 不可用，回退路径由 SA-S2 覆盖');
    return;
  }

  assert.deepEqual(store.warnings, []);
  assert.equal(await store.get('state'), null);
  await store.set('state', '{"state_version":0}');
  assert.equal(await store.get('state'), '{"state_version":0}');
  await store.delete('state');
  assert.equal(await store.get('state'), null);

  await store.set('cfg', '{"tone":"warm"}');
  await store.close();

  const reopened = add(createSqliteStore({ path }));
  assert.equal(reopened.driver, 'sqlite');
  assert.equal(await reopened.get('cfg'), '{"tone":"warm"}');
  await assert.rejects(
    () => reopened.set('state', 'a'.repeat(8 * 1024 + 1)),
    (err) => err.code === 'STORAGE_FAILED' && err.details?.reason === 'state_too_large'
  );
});

test('SA-S2 node:sqlite 不可用时回退 file-store', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'engine.db');
  const store = createSqliteStore({
    path,
    clock: () => NOW,
    load_sqlite: () => {
      throw new Error('node:sqlite unavailable');
    }
  });

  assert.equal(store.driver, 'file');
  assert.deepEqual(store.warnings, ['SQLITE_UNAVAILABLE']);

  await store.set('meta', '{"schema_migrations":[]}');
  const reopened = createSqliteStore({
    path,
    load_sqlite: () => {
      throw new Error('node:sqlite unavailable');
    }
  });
  assert.equal(await reopened.get('meta'), '{"schema_migrations":[]}');
});

test('SA-S3 createRepository 可直接使用 sqlite-store', async (t) => {
  const { dir, add } = await sqliteTempDir(t);
  const path = join(dir, 'engine.db');
  const state = baseState();
  const store = add(createSqliteStore({ path, clock: () => NOW }));

  const repo = openRepo(store);
  const saved = await repo.saveState(state, 0);
  assert.equal(saved.ok, true);

  const reopened = add(createSqliteStore({ path }));
  const loaded = openRepo(reopened).loadState(CHARACTER_ID);
  assert.equal((await loaded).state_version, 0);
});
