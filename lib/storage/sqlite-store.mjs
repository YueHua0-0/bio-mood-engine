/**
 * 04 §5.10 / §7：`node:sqlite` 存储介质。
 *
 * - Node ≥ 22.5 且 `node:sqlite` 可用时用 SQLite（单表 kv，键为固定字面量）；
 * - 不可用（模块缺失 / `DatabaseSync` 不存在 / 打开失败）时回退 `file-store`，
 *   返回对象带 `warnings:['SQLITE_UNAVAILABLE']`，禁止退化为内存存储（04 §6）；
 * - 不引入第三方依赖，也不 import `node:fs`（目录创建由部署方负责，或走回退的 file-store）。
 */

import { createRequire } from 'node:module';

import { createFileStore } from './file-store.mjs';

const KEY_CAP = {
  state: 8 * 1024,
  evlog: 16 * 1024,
  idem: 32 * 1024,
  meta: 24 * 1024,
  cfg: 4 * 1024,
  history: 2 * 1024 * 1024
};
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function storageError(message, details) {
  return contractError('STORAGE_FAILED', message, details);
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || !(key in KEY_CAP)) {
    throw contractError('INVALID_REQUEST', `storage key is not allowed in sqlite mode: ${String(key)}`, { key });
  }
}

function serialize(value) {
  return typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
}

/** 默认加载器；测试可注入一个抛错的实现来验证回退路径。 */
function loadNodeSqlite() {
  const require = createRequire(import.meta.url);
  return require('node:sqlite');
}

function openSqlite(sqlite, path) {
  const db = new sqlite.DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    db,
    select: db.prepare('SELECT value FROM kv WHERE key = ?'),
    upsert: db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'),
    remove: db.prepare('DELETE FROM kv WHERE key = ?')
  };
}

/**
 * @param {{path: string, clock?: () => string, load_sqlite?: () => object}} options
 * @returns {{driver: 'sqlite'|'file', path: string, warnings: string[], get: Function, set: Function, delete: Function, close: Function}}
 */
export function createSqliteStore({ path, clock, load_sqlite: loadSqlite = loadNodeSqlite } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw contractError('INVALID_REQUEST', 'sqlite-store requires a non-empty path');
  }

  let sqlite = null;
  try {
    sqlite = loadSqlite();
  } catch {
    sqlite = null;
  }

  let opened = null;
  if (sqlite && typeof sqlite.DatabaseSync === 'function') {
    try {
      opened = openSqlite(sqlite, path);
    } catch {
      opened = null;
    }
  }

  if (!opened) {
    // 回退目录由 path 派生，避免与同名 .db 文件冲突；行为与 file-store 完全一致。
    const fallback = createFileStore({ dir: `${path}.files`, clock });
    fallback.warnings = ['SQLITE_UNAVAILABLE'];
    return fallback;
  }

  const { db, select, upsert, remove } = opened;

  async function get(key) {
    assertKey(key);
    try {
      const row = select.get(key);
      return row === undefined ? null : row.value;
    } catch {
      throw storageError(`failed to read ${key}`, { key });
    }
  }

  async function set(key, value) {
    assertKey(key);
    const serialized = serialize(value);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > KEY_CAP[key]) {
      const details = key === 'state' ? { reason: 'state_too_large' } : { key };
      throw storageError(`${key} exceeds ${KEY_CAP[key]} bytes`, details);
    }
    try {
      upsert.run(key, serialized);
    } catch {
      throw storageError(`failed to write ${key}`, { key });
    }
  }

  async function deleteKey(key) {
    assertKey(key);
    try {
      remove.run(key);
    } catch {
      throw storageError(`failed to delete ${key}`, { key });
    }
  }

  return {
    driver: 'sqlite',
    path,
    warnings: [],
    get,
    set,
    delete: deleteKey,
    async close() {
      db.close();
    }
  };
}

export default createSqliteStore;
