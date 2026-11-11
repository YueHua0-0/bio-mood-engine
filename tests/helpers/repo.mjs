/**
 * 14 §4.2 的存储替身：`memoryRepo({ failAt })`。
 *
 * 宿主契约是单键 `get/set/delete`，值一律 JSON 字符串（04 §4.1）。
 * `failAt` 注入读/写/删失败与半写：`{ op:'set'|'get'|'delete', key:'state', times:1 }`；
 * `crashAt` 在指定 WAL 步骤后模拟进程死亡（storage 置为 crashed，后续补偿全部失败）。
 * 不含业务规则，只做存储与仓库装配。
 */

import { createRepository } from '../../lib/storage/repository.mjs';

import { VALID_STATE } from './state.mjs';

export const CHARACTER_ID = VALID_STATE.character_id;
export const MASTER_SEED = VALID_STATE.random.master_seed_hex;
export const FIXED_NOW = VALID_STATE.updated_at;
export const START = '2026-11-09T08:00:00.000Z';

export function crashError() {
  const err = new Error('simulated process crash');
  err.fatal = true;
  return err;
}

export function storageError() {
  const err = new Error('storage unavailable');
  err.code = 'STORAGE_FAILED';
  return err;
}

export function createMemoryStorage(initial = {}) {
  const data = new Map();
  for (const [key, value] of Object.entries(initial)) {
    data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const runtime = { crashed: false, ops: 0, log: [], failures: [] };

  function before(op, key) {
    if (runtime.crashed) throw crashError();
    runtime.ops += 1;
    runtime.log.push({ op, key });
    const hit = runtime.failures.findIndex(
      (item) => item.op === op && (item.key === undefined || item.key === key) && item.times > 0
    );
    if (hit >= 0) {
      const item = runtime.failures[hit];
      item.times = item.times === Infinity ? Infinity : item.times - 1;
      throw storageError();
    }
  }

  const storage = {
    async get(key) {
      before('get', key);
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      before('set', key);
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) {
      before('delete', key);
      data.delete(key);
    },

    raw: (key) => (data.has(key) ? data.get(key) : null),
    json(key) {
      const raw = storage.raw(key);
      return raw === null ? null : JSON.parse(raw);
    },
    keys: () => [...data.keys()],
    dump() {
      return Object.fromEntries([...data.entries()]);
    },
    get ops() {
      return runtime.ops;
    },
    get log() {
      return runtime.log;
    },
    writes() {
      return runtime.log.filter((entry) => entry.op !== 'get');
    },
    failNext(spec) {
      runtime.failures.push({
        op: spec.op ?? 'set',
        key: spec.key,
        times: spec.times ?? 1
      });
    },
    crash() {
      runtime.crashed = true;
    },
    restart() {
      runtime.crashed = false;
      runtime.ops = 0;
      runtime.log.length = 0;
      runtime.failures.length = 0;
    }
  };

  return storage;
}

export function createTestLogger() {
  const entries = [];
  const push = (level) => (entry) =>
    entries.push({ level, ...(typeof entry === 'string' ? { message: entry } : entry) });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function idFactory() {
  let n = 0;
  return () => `tx_${String((n += 1)).padStart(4, '0')}`;
}

/**
 * @param {{failAt?:object|object[], crashAt?:string, initial?:object, clock?:Function,
 *          hooks?:object, migrations?:object, logger?:object, character_id?:string}} [options]
 */
export function memoryRepo(options = {}) {
  const {
    failAt,
    crashAt,
    initial = {},
    clock = () => FIXED_NOW,
    hooks = {},
    migrations = null,
    logger = createTestLogger(),
    character_id: characterId = CHARACTER_ID,
    seed_factory: seedFactory = undefined
  } = options;

  const storage = createMemoryStorage(initial);
  for (const spec of Array.isArray(failAt) ? failAt : failAt ? [failAt] : []) {
    storage.failNext(spec);
  }

  const mergedHooks = { ...hooks };
  if (crashAt) {
    // 04 §5.3.2 的崩溃点是"Wn 写入之后"，而仓库的 `beforeStep` 在写入之前触发，
    // 因此把逻辑崩溃点映射到下一个写入点，并在到达时让存储永久失效。
    // 崩溃只模拟一次：重启后的恢复回放会再次经过同一写入点，不应无限崩溃。
    const CRASH_AFTER = { W2: 'W3', W3: 'W4', W4: 'W5', W5: 'W6', W6: 'W7', W7: 'W8a', W8: 'W8b' };
    const trigger = CRASH_AFTER[crashAt] ?? crashAt;
    let crashArmed = true;
    mergedHooks.beforeStep = (step) => {
      hooks.beforeStep?.(step);
      if (!crashArmed || step !== trigger) return;
      crashArmed = false;
      storage.crash();
      throw crashError();
    };
  }

  function open(overrides = {}) {
    return createRepository({
      storage,
      character_id: characterId,
      clock,
      id_factory: idFactory(),
      logger,
      hooks: mergedHooks,
      migrations,
      seed_factory: seedFactory,
      ...overrides
    });
  }

  const repo = open();

  return {
    storage,
    repo,
    logger,
    character_id: characterId,
    /** 同一个持久介质上的"新进程"：清掉故障与崩溃标记后重建仓库。 */
    reopen(overrides = {}) {
      storage.restart();
      return open(overrides);
    },
    /** 不重置故障标记的重建（用于验证恢复路径本身失败）。 */
    cloneRepo(overrides = {}) {
      return open(overrides);
    }
  };
}
