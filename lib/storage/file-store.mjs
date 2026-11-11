/**
 * 04 §5.10 / §7：独立部署的 JSON 文件存储（临时文件 + 同目录 rename 原子替换）。
 *
 * 只实现宿主单键接口 `{ get, set, delete }`，供 `createRepository` 使用：
 * - 每个键一个 `<dir>/<key>.json`，键名固定字面量（04 §5.1），不拼角色或时间戳；
 * - 写路径先写同目录临时文件，再 `rename` 覆盖，避免"先删后写"留下半个文件（04 §10.4）；
 * - 单键硬上限在写入前按字节校验，与插件适配器保持一致；
 * - `history` 仅文件 / SQLite 模式可用，插件模式由 `plugin-storage.mjs` 拒绝。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 04 §5.1 / 00 §11.5：键白名单与单键硬上限（文件模式额外允许 history）。 */
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
    throw contractError('INVALID_REQUEST', `storage key is not allowed in file mode: ${String(key)}`, { key });
  }
}

function serialize(value) {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value === undefined ? null : value);
  return text;
}

/**
 * @param {{dir: string, clock?: () => string}} options
 * @returns {{driver: 'file', dir: string, clock: () => string, get: Function, set: Function, delete: Function, close: Function}}
 */
export function createFileStore({ dir, clock = () => new Date().toISOString() } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw contractError('INVALID_REQUEST', 'file-store requires a non-empty dir');
  }
  const root = resolve(dir);
  let ensured = null;

  async function ensureDir() {
    if (!ensured) {
      ensured = mkdir(root, { recursive: true }).catch((err) => {
        ensured = null;
        throw storageError('failed to create storage directory', { reason: 'mkdir_failed' });
      });
    }
    await ensured;
  }

  function fileOf(key) {
    return join(root, `${key}.json`);
  }

  async function get(key) {
    assertKey(key);
    await ensureDir();
    try {
      return await readFile(fileOf(key), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
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

    await ensureDir();
    const target = fileOf(key);
    const temp = join(root, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temp, serialized, 'utf8');
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw storageError(`failed to write ${key}`, { key });
    }
  }

  async function remove(key) {
    assertKey(key);
    await ensureDir();
    try {
      await unlink(fileOf(key));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw storageError(`failed to delete ${key}`, { key });
    }
  }

  return {
    driver: 'file',
    dir: root,
    // history 采样任务与仓库共用同一时间基准；本模块只持久化，不生成采样。
    clock,
    get,
    set,
    delete: remove,
    async close() {}
  };
}

export default createFileStore;
