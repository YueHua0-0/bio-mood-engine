/**
 * 04 §4/§5：插件模式的键值仓库。
 *
 * 设计要点（04 §5.3、§5.3.1、§5.3.2）：
 * - `transaction(fn)` 先执行 fn，写操作只进内存缓冲；缓冲为空不写任何键。
 * - 缓冲非空才进入 WAL：W1 读 → W2 rollback_state → W3 journal(prepared) →
 *   W4 重读校验后写 state → W5 evlog → W6 idem → W7 committed → W8a/W8b 清理。
 * - 仓库内部按 character_id 串行化 `saveState` 与 WAL 提交；fn 的读与计算不持锁。
 * - 崩溃恢复由 `recover()` 承担，`recovery_required` 一旦落盘即拒绝推进。
 */

import { createHash, randomBytes } from 'node:crypto';

import { CONFIG_VERSION_AFTER_MIGRATION, SCHEMA_VERSION } from '../core/constants.mjs';
import { parseTime } from '../core/clock.mjs';
import { createDefaultState, validateState } from '../core/models.mjs';
import { createMasterSeed, RandomProvider } from '../core/random.mjs';
import { applyMigrations } from './migrations.mjs';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TX_KEY_OPS = 40;
const STATE_LIMIT_BYTES = 8 * 1024;
const TOTAL_LIMIT_BYTES = 64 * 1024;
const EVLOG_LIMIT = 200;
const IDEM_LIMIT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const EVLOG_RETENTION_MS = 90 * DAY_MS;
const IDEM_RETENTION_MS = 7 * DAY_MS;
/** 单次读取路径最多淘汰的条目数：钩子预算 800 ms，剩余部分留到后续轮次。 */
const EVICT_PER_LOAD = 64;
/**
 * 单键写目标：低于 00 §11.5 的单键硬上限，为下一次 append 预留空间。
 * 不压到硬上限，否则 evlog 恰好 16 KiB 时再 append 一条就会先撞 plugin-storage 的硬上限。
 */
const EVLOG_WRITE_TARGET_BYTES = 14 * 1024;
const IDEM_WRITE_TARGET_BYTES = 30 * 1024;

const DELETED = Symbol('deleted');

const LOCKS = new WeakMap();

/** 04 §6：管理动作枚举。 */
const ADMIN_OPERATIONS = new Set(['reset_state', 'reset_seed', 'manual_cycle_correction']);
/** 04 §6 默认审计来源；13 可通过 `admin_source_key` 传 `wechat:<primaryChatId>:admin`。 */
const ADMIN_SOURCE_KEY = 'wechat:admin:admin';

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function storageError(message, details) {
  return contractError('STORAGE_FAILED', message, details);
}

/** 04 §5.3：事务被 `signal` 中止。内部码，不属于 00 §9.2；12 映射为 INTERNAL。 */
function abortedError() {
  return contractError('ABORTED', 'transaction aborted');
}

/** 检查点只覆盖 W1 前与 W1–W6 每个 await 之后；W7 之后不得调用。 */
function checkAbort(signal) {
  if (signal && signal.aborted) throw abortedError();
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 规范化 JSON：键名排序、无空白，保证同一对象得到同一 digest。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestValue(value) {
  return sha256Hex(canonicalJson(value)).slice(0, 16);
}

function defaultMeta() {
  return {
    schema_migrations: [],
    state_backup: null,
    snapshots: [],
    tx_journal: null,
    rollback_state: null
  };
}

function normalizeMeta(meta) {
  const next = meta && typeof meta === 'object' ? { ...meta } : {};
  if (!Array.isArray(next.schema_migrations)) next.schema_migrations = [];
  if (!Array.isArray(next.snapshots)) next.snapshots = [];
  if (!('state_backup' in next)) next.state_backup = null;
  if (!('tx_journal' in next)) next.tx_journal = null;
  if (!('rollback_state' in next)) next.rollback_state = null;
  return next;
}

async function readJson(storage, key) {
  const raw = await storage.get(key);
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
}

async function writeJson(storage, key, value) {
  await storage.set(key, JSON.stringify(value));
}

async function deleteKey(storage, key) {
  await storage.delete(key);
}

/** 按 `character_id` 的进程内互斥；同一 storage 的同一角色串行。 */
function withLock(storage, characterId, task) {
  let map = LOCKS.get(storage);
  if (!map) {
    map = new Map();
    LOCKS.set(storage, map);
  }
  const previous = map.get(characterId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  map.set(characterId, settled);
  // chain 完成后立即回收，避免长时间运行时累积已 resolve 的 Promise。
  settled.then(() => {
    if (map.get(characterId) === settled) map.delete(characterId);
  });
  return run;
}

/** 脱敏：`master_seed_hex` → `master_seed_id`，其余字段原样保留。 */
function sanitizeState(state) {
  const copy = clone(state);
  const random = copy.random ?? {};
  if (typeof random.master_seed_hex === 'string') {
    random.master_seed_id = sha256Hex(random.master_seed_hex).slice(0, 8);
    delete random.master_seed_hex;
  }
  copy.random = random;
  return copy;
}

/** 用 rollback_state + 当前状态的种子恢复；streams 与计数器全部取回滚快照。 */
function restoreFromRollback(rollback, currentState) {
  const { master_seed_id: _discarded, ...previousRandom } = rollback.random ?? {};
  const seed = currentState?.random?.master_seed_hex;
  const random = seed === undefined ? { ...previousRandom } : { ...previousRandom, master_seed_hex: seed };
  return { ...clone(rollback), random };
}

function stateBytes(state) {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

function eventIdsOf(list, reference) {
  const previous = new Set((Array.isArray(reference) ? reference : []).map((entry) => entry.event_id));
  return (Array.isArray(list) ? list : [])
    .map((entry) => entry.event_id)
    .filter((eventId) => eventId !== undefined && !previous.has(eventId));
}

function idemKeysOf(list, reference) {
  const previous = new Set((Array.isArray(reference) ? reference : []).map((entry) => entry.key));
  return (Array.isArray(list) ? list : [])
    .map((entry) => entry.key)
    .filter((key) => key !== undefined && !previous.has(key));
}

// ---------------------------------------------------------------------------
// 事务对象
// ---------------------------------------------------------------------------

function createTx({ storage, characterId, clock, logger, preparedState }) {
  const buffer = new Map();
  const reads = new Map();
  let ops = 0;
  let expectedVersion = null;

  function assertKey(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      throw contractError('INVALID_REQUEST', `invalid storage key: ${String(key)}`, { key });
    }
  }

  function count() {
    ops += 1;
    if (ops > TX_KEY_OPS) {
      throw storageError('transaction exceeded 40 storage operations', { reason: 'counter_too_large' });
    }
  }

  async function get(key) {
    assertKey(key);
    count();
    if (buffer.has(key)) {
      const buffered = buffer.get(key);
      return buffered === DELETED ? null : clone(buffered);
    }
    if (reads.has(key)) return clone(reads.get(key));
    // ensureReady 已完成迁移；事务必须复用其内存结果，配置迁移不得为落盘额外写 state。
    const value = key === 'state' ? clone(preparedState) : await readJson(storage, key);
    reads.set(key, value);
    return clone(value);
  }

  async function put(key, value) {
    assertKey(key);
    count();
    buffer.set(key, clone(value));
  }

  async function del(key) {
    assertKey(key);
    count();
    buffer.set(key, DELETED);
  }

  async function getState(id) {
    if (id !== undefined && id !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', { expected: characterId, got: id });
    }
    const state = await get('state');
    return state ? { state, version: state.state_version } : null;
  }

  async function putState(state, version) {
    if (stateBytes(state) > STATE_LIMIT_BYTES) {
      throw storageError('state exceeds 8 KiB', { reason: 'state_too_large' });
    }
    expectedVersion = version;
    await put('state', state);
  }

  async function getIdempotency(key) {
    const list = (await get('idem')) ?? [];
    const hit = (Array.isArray(list) ? list : []).find(
      (entry) => entry.key === key && entry.character_id === characterId
    );
    if (!hit) return null;
    if (Date.parse(hit.expires_at) <= Date.parse(clock())) return null;
    return hit;
  }

  async function appendEvent(record) {
    const list = (await get('evlog')) ?? [];
    const events = Array.isArray(list) ? list : [];
    if (events.some((entry) => entry.event_id === record.event_id)) {
      logger.warn({ code: 'DUPLICATE_EVENT_ID', event_id: record.event_id });
      return { duplicate: true };
    }
    const next = [...events, clone(record)];
    await put('evlog', next.length > EVLOG_LIMIT ? next.slice(next.length - EVLOG_LIMIT) : next);
    return { duplicate: false };
  }

  async function appendIdempotency(record) {
    const list = (await get('idem')) ?? [];
    const entries = Array.isArray(list) ? list : [];
    const bufferedState = buffer.has('state') && buffer.get('state') !== DELETED ? buffer.get('state') : null;
    const stateVersion = bufferedState?.state_version ?? reads.get('state')?.state_version ?? 0;
    const bufferedEvents = buffer.get('evlog');
    const related = Array.isArray(bufferedEvents)
      ? bufferedEvents.find((entry) => entry.idempotency_key === record.key)
      : null;
    const entry = {
      character_id: characterId,
      key: record.key,
      event_id: record.event_id ?? related?.event_id ?? null,
      state_version: stateVersion,
      result_digest: digestValue(record.result ?? null),
      result: clone(record.result ?? null),
      processed_at: record.processed_at ?? clock(),
      expires_at: record.expires_at ?? new Date(Date.parse(clock()) + IDEM_RETENTION_MS).toISOString()
    };
    const next = entries.filter((item) => !(item.key === entry.key && item.character_id === characterId));
    next.push(entry);
    await put('idem', next.length > IDEM_LIMIT ? next.slice(next.length - IDEM_LIMIT) : next);
  }

  /** 12 §5.5：事务内写 `meta`（`snapshots` 回放摘要），由 commit 合并到 `meta` 键。 */
  async function putMeta(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw contractError('INVALID_REQUEST', 'meta must be an object', { path: 'meta' });
    }
    await put('meta', value);
  }

  return {
    get,
    put,
    del,
    getState,
    putState,
    putMeta,
    getIdempotency,
    appendEvent,
    appendIdempotency,
    /** 内部：提交阶段的变更集。 */
    $changes: () => buffer,
    $expectedVersion: () => expectedVersion
  };
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createRepository(options = {}) {
  const {
    storage,
    character_id: characterId,
    clock = () => new Date().toISOString(),
    id_factory: idFactory,
    // P-04-02：种子格式只由 03 的 createMasterSeed 决定；这里只注入熵源（仅初始化边界）。
    seed_factory: seedFactory = () => createMasterSeed(randomBytes(16)),
    admin_source_key: adminSourceKey = ADMIN_SOURCE_KEY,
    logger = { info() {}, warn() {}, error() {} },
    hooks = {},
    migrations = null
  } = options;

  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw contractError('INVALID_REQUEST', 'storage must implement get/set/delete');
  }
  if (typeof characterId !== 'string' || !CHARACTER_ID_RE.test(characterId)) {
    throw contractError('INVALID_REQUEST', 'character_id must match ^[a-z][a-z0-9_-]{0,63}$');
  }

  const maxSchemaVersion = migrations?.target_version ?? SCHEMA_VERSION;
  let sequence = 0;
  const nextId = idFactory ?? (() => `tx_${String((sequence += 1)).padStart(4, '0')}`);

  /** 损坏的幂等记录告警按 key 限流：同 key 1 分钟内只告警一次，避免刷日志。 */
  const idemWarnAt = new Map();
  function warnIdemInvalid(key) {
    const now = Date.parse(clock());
    const last = idemWarnAt.get(key);
    if (last !== undefined && now - last < 60 * 1000) return;
    // 内存卫生：不同 key 灌入时防止 map 单调增长。
    if (idemWarnAt.size >= 64) idemWarnAt.clear();
    idemWarnAt.set(key, now);
    logger.warn({ code: 'IDEM_RECORD_INVALID', key });
  }

  function hook(step) {
    hooks.beforeStep?.(step);
  }

  async function markRecoveryRequired(operation, reason) {
    try {
      const meta = normalizeMeta(await readJson(storage, 'meta'));
      meta.recovery_required = { operation, at: clock(), reason };
      await writeJson(storage, 'meta', meta);
    } catch {
      logger.error({ code: 'RECOVERY_MARK_FAILED', operation, reason });
    }
  }

  function isValidJournal(journal) {
    return (
      journal &&
      typeof journal === 'object' &&
      typeof journal.tx_id === 'string' &&
      Number.isInteger(journal.prev_version ?? 0) &&
      Number.isInteger(journal.to_version) &&
      Array.isArray(journal.idem_keys) &&
      Array.isArray(journal.evlog_event_ids)
    );
  }

  async function dropIdem(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    const list = await readJson(storage, 'idem');
    if (!Array.isArray(list)) return;
    const next = list.filter((entry) => !keys.includes(entry.key));
    if (next.length !== list.length) await writeJson(storage, 'idem', next);
  }

  async function dropEvents(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return;
    const list = await readJson(storage, 'evlog');
    if (!Array.isArray(list)) return;
    const next = list.filter((entry) => !eventIds.includes(entry.event_id));
    if (next.length !== list.length) await writeJson(storage, 'evlog', next);
  }

  async function cleanupJournal(meta) {
    meta.rollback_state = null;
    meta.tx_journal = null;
    await writeJson(storage, 'meta', meta);
  }

  /** 04 §5.3.2：启动/推进前的恢复状态机。 */
  async function recover() {
    const meta = normalizeMeta(await readJson(storage, 'meta'));
    if (meta.recovery_required) {
      throw storageError('recovery_required is set', { recovery_required: true });
    }

    const journal = meta.tx_journal;
    if (!journal) {
      if (meta.rollback_state) {
        meta.rollback_state = null;
        await writeJson(storage, 'meta', meta);
      }
      return;
    }

    if (!isValidJournal(journal)) {
      await markRecoveryRequired('recover', 'journal_corrupt');
      throw storageError('tx_journal is corrupt', { recovery_required: true });
    }

    if (journal.phase === 'committed') {
      await cleanupJournal(meta);
      return;
    }
    if (journal.phase !== 'prepared') {
      await markRecoveryRequired('recover', 'journal_corrupt');
      throw storageError('tx_journal has unknown phase', { recovery_required: true });
    }

    const current = await readJson(storage, 'state');
    const version = current ? current.state_version : null;

    if (version === null || version < journal.to_version) {
      await dropIdem(journal.idem_keys);
      await dropEvents(journal.evlog_event_ids);
      await cleanupJournal(meta);
      return;
    }

    if (version === journal.to_version) {
      const idems = await readJson(storage, 'idem');
      const list = Array.isArray(idems) ? idems : [];
      const complete = journal.idem_keys.every((key) => list.some((entry) => entry.key === key));
      if (complete) {
        journal.phase = 'committed';
        meta.tx_journal = journal;
        await writeJson(storage, 'meta', meta);
        await cleanupJournal(meta);
        return;
      }
      if (!meta.rollback_state) {
        await markRecoveryRequired('recover', 'rollback_missing');
        throw storageError('rollback_state is missing', { recovery_required: true });
      }
      const restored = restoreFromRollback(meta.rollback_state, current);
      const check = validateState(restored, { maxSchemaVersion });
      if (!check.ok) {
        await markRecoveryRequired('recover', 'rollback_invalid');
        throw storageError('rollback_state is not a valid state', { recovery_required: true });
      }
      try {
        await writeJson(storage, 'state', restored);
      } catch {
        await markRecoveryRequired('recover', 'recovery_failed');
        throw storageError('failed to write restored state', { recovery_required: true });
      }
      await dropEvents(journal.evlog_event_ids);
      await dropIdem(journal.idem_keys);
      await cleanupJournal(meta);
      return;
    }

    await markRecoveryRequired('recover', 'state_ahead_of_journal');
    throw storageError('state is ahead of tx_journal', { recovery_required: true });
  }

  /**
   * 写路径的公共前置：读 state → 校验（必要时从 state_backup 恢复）→ 迁移 → 淘汰。
   * `loadState({readOnly:false})` 与 `transaction()` 共用；只读路径不得调用。
   *
   * 整段持仓库锁执行（04 §5.4，P2 裁决 A）：`state_backup` 只能保证迁移失败可恢复，
   * 不能保证并发下迁移函数不被重复应用到同一状态；锁内执行把"迁移函数必须幂等"
   * 从并发正确性的必要条件降为兜底假设。
   */
  async function prepareWritePath() {
    return withLock(storage, characterId, async () => {
      const meta = normalizeMeta(await readJson(storage, 'meta'));
      let state = null;
      let parseFailed = false;
      try {
        state = await readJson(storage, 'state');
      } catch (err) {
        // 宿主存储失败必须原样上抛 STORAGE_FAILED；只有解析失败才走"损坏 → 备份"路径。
        if (err?.code === 'STORAGE_FAILED') throw err;
        parseFailed = true;
      }

      if (state === null && !parseFailed) {
        await maintain(null, meta);
        return { state: null, meta, migrated: false };
      }

      let check = parseFailed ? { ok: false, code: 'INTERNAL' } : validateState(state, { maxSchemaVersion });
      if (!check.ok) {
        const backup = meta.state_backup?.state;
        if (!backup) {
          throw contractError(check.code ?? 'INTERNAL', 'state is corrupt and no backup is available');
        }
        state = clone(backup);
        await writeJson(storage, 'state', state);
        logger.warn({ code: 'STATE_RESTORED_FROM_BACKUP', state_version: state.state_version });
        check = validateState(state, { maxSchemaVersion });
        if (!check.ok) throw contractError('INTERNAL', 'state_backup is not a valid state');
      }

      const schemaBefore = state.schema_version;
      state = await runMigrations(state, meta);
      await maintain(state, meta);
      return { state, meta, migrated: state.schema_version !== schemaBefore };
    });
  }

  /**
   * 写路径的 ensureReady：恢复 + 迁移 + 淘汰。
   * `loadState({readOnly:false})` 与 `transaction()` 共用；
   * 迁移段与淘汰段均在仓库锁内执行，与 `commit()` 的 W1–W8b 串行（04 §5.4）。
   */
  async function ensureReady() {
    await recover();
    return prepareWritePath();
  }

  async function ensureMeta() {
    const meta = await readJson(storage, 'meta');
    if (meta === null) await writeJson(storage, 'meta', defaultMeta());
  }

  async function loadState(id, options = {}) {
    if (id !== undefined && id !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', { expected: characterId, got: id });
    }

    // 与 `loadStateReadOnly()` 严格等价：不迁移、不淘汰、不恢复、不写盘。
    if (options.readOnly) return loadStateReadOnly();

    const { state } = await ensureReady();
    return state === null ? null : clone(state);
  }

  /**
   * 13 §5.6 的 before-context 只读路径：不迁移、不淘汰、不恢复、不写任何键。
   * 待办事项以 warnings 返回，由调用方决定是否 DEGRADED。
   */
  async function loadStateReadOnly() {
    const meta = normalizeMeta(await readJson(storage, 'meta'));
    if (meta.recovery_required) {
      throw storageError('recovery_required is set', { recovery_required: true });
    }

    const warnings = [];
    let state = null;
    try {
      state = await readJson(storage, 'state');
    } catch {
      state = null;
    }

    // 崩溃在 W4 之后、W7 之前时，磁盘上的 state 可能尚未提交。
    // 只读路径不恢复，但必须返回"已提交版本"（rollback_state），否则 13 会缓存到幽灵版本，
    // 下一次 advance 恢复后 state_version 回退（违反 I2 的"不回退"直觉）。
    const prepared = meta.tx_journal && meta.tx_journal.phase === 'prepared';
    if (meta.tx_journal || meta.rollback_state) warnings.push('RECOVERY_DEFERRED');
    if (prepared && meta.rollback_state) {
      state = restoreFromRollback(meta.rollback_state, state);
    }

    if (state === null) return { state: null, warnings };

    if (migrations?.target_version > state.schema_version) warnings.push('MIGRATION_DEFERRED');

    const evlog = await readJson(storage, 'evlog');
    const idem = await readJson(storage, 'idem');
    const cfg = await readJson(storage, 'cfg');
    const total =
      sizeOf('state', state) +
      sizeOf('meta', meta) +
      sizeOf('evlog', evlog) +
      sizeOf('idem', idem) +
      sizeOf('cfg', cfg);
    if (total > TOTAL_LIMIT_BYTES) warnings.push('STORAGE_OVER_BUDGET');

    return { state: clone(state), warnings };
  }

  /** 00 §8：配置版本独立于 schema；只在内存升级，由后续原写操作持久化。 */
  function migrateConfigVersion(state) {
    return state.config_version < CONFIG_VERSION_AFTER_MIGRATION
      ? { ...state, config_version: CONFIG_VERSION_AFTER_MIGRATION }
      : state;
  }

  async function runMigrations(state, meta) {
    const migrated = await applyMigrations({
      state,
      meta,
      migrations,
      clock,
      logger,
      store: {
        writeState: (next) => writeJson(storage, 'state', next),
        writeMeta: (next) => writeJson(storage, 'meta', next)
      }
    });
    return migrateConfigVersion(migrated);
  }

  function sizeOf(key, value) {
    if (value === null || value === undefined) return 0;
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }

  async function maintain(state, meta) {
    const now = Date.parse(clock());
    const rawEvents = await readJson(storage, 'evlog');
    const rawIdem = await readJson(storage, 'idem');
    let events = Array.isArray(rawEvents) ? rawEvents.slice() : [];
    let idems = Array.isArray(rawIdem) ? rawIdem.slice() : [];
    let eventsChanged = false;
    let idemChanged = false;
    let metaChanged = false;

    const freshEvents = events.filter((entry) => Date.parse(entry.occurred_at) >= now - EVLOG_RETENTION_MS);
    if (freshEvents.length !== events.length) {
      events = freshEvents;
      eventsChanged = true;
    }
    const freshIdem = idems.filter((entry) => Date.parse(entry.expires_at) > now);
    if (freshIdem.length !== idems.length) {
      idems = freshIdem;
      idemChanged = true;
    }
    if (events.length > EVLOG_LIMIT) {
      events = events.slice(events.length - EVLOG_LIMIT);
      eventsChanged = true;
    }
    if (idems.length > IDEM_LIMIT) {
      idems = idems.slice(idems.length - IDEM_LIMIT);
      idemChanged = true;
    }

    const rawState = await storage.get('state');
    const rawCfg = await storage.get('cfg');
    const total = () =>
      sizeOf('state', rawState) +
      sizeOf('cfg', rawCfg) +
      sizeOf('meta', meta) +
      sizeOf('evlog', events.length ? events : null) +
      sizeOf('idem', idems.length ? idems : null);

    let evicted = 0;
    while (total() > TOTAL_LIMIT_BYTES && evicted < EVICT_PER_LOAD) {
      if (meta.snapshots.length > 0) {
        meta.snapshots.shift();
        metaChanged = true;
        evicted += 1;
        continue;
      }
      if (idems.length > 0) {
        idems.shift();
        idemChanged = true;
        evicted += 1;
        continue;
      }
      if (events.length > 0) {
        events.shift();
        eventsChanged = true;
        evicted += 1;
        continue;
      }
      break;
    }

    // 单键写目标：即使总量未超 64 KiB，也要把 evlog/idem 压到硬上限以下，
    // 否则下一次 appendEvent 会先撞 plugin-storage 的单键硬上限而整笔失败（04 §5.2）。
    // 这一步不受 EVICT_PER_LOAD 限制：它只发生在写路径，且是"先淘汰再写"的必要前提。
    while (events.length > 0 && sizeOf('evlog', events) > EVLOG_WRITE_TARGET_BYTES) {
      events.shift();
      eventsChanged = true;
      evicted += 1;
    }
    while (idems.length > 0 && sizeOf('idem', idems) > IDEM_WRITE_TARGET_BYTES) {
      idems.shift();
      idemChanged = true;
      evicted += 1;
    }

    if (eventsChanged) await writeJson(storage, 'evlog', events);
    if (idemChanged) await writeJson(storage, 'idem', idems);
    if (metaChanged) await writeJson(storage, 'meta', meta);
    if (evicted > 0) logger.warn({ code: 'STORAGE_EVICTED', removed: evicted });
  }

  /** 低层写 API：不执行迁移；调用方必须传入版本正确的完整状态。 */
  async function saveState(state, expectedVersion) {
    const check = validateState(state, { maxSchemaVersion });
    if (!check.ok) {
      return { ok: false, code: check.code ?? 'INVALID_REQUEST', details: { warnings: [] } };
    }
    if (stateBytes(state) > STATE_LIMIT_BYTES) {
      return { ok: false, code: 'STORAGE_FAILED', details: { reason: 'state_too_large' } };
    }
    return withLock(storage, characterId, async () => {
      await ensureMeta();
      const current = await readJson(storage, 'state');
      if (current === null) {
        if (expectedVersion !== 0 || state.state_version !== 0) {
          return { ok: false, code: 'STATE_VERSION_CONFLICT' };
        }
        await writeJson(storage, 'state', state);
        return { ok: true, state_version: 0 };
      }
      if (current.state_version !== expectedVersion || state.state_version !== expectedVersion + 1) {
        return { ok: false, code: 'STATE_VERSION_CONFLICT' };
      }
      await writeJson(storage, 'state', state);
      return { ok: true, state_version: expectedVersion + 1 };
    });
  }

  async function findEventResult(id, key) {
    if (id !== undefined && id !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', { expected: characterId, got: id });
    }
    const list = await readJson(storage, 'idem');
    if (!Array.isArray(list)) return null;
    const hit = list.find((entry) => entry.key === key && entry.character_id === characterId);
    if (!hit) {
      // 缺 character_id 或多角色串读都视为损坏记录：不猜测归属，只告警。
      if (list.some((entry) => entry.key === key)) {
        warnIdemInvalid(key);
      }
      return null;
    }
    if (Date.parse(hit.expires_at) <= Date.parse(clock())) return null;
    return clone(hit);
  }

  async function listRecentEvents(id, limit = 20) {
    if (id !== undefined && id !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', { expected: characterId, got: id });
    }
    const list = await readJson(storage, 'evlog');
    if (!Array.isArray(list)) return [];
    const now = Date.parse(clock());
    return list
      .filter((entry) => Date.parse(entry.occurred_at) >= now - EVLOG_RETENTION_MS)
      .sort((left, right) => {
        const delta = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
        if (delta !== 0) return delta;
        return String(left.event_id).localeCompare(String(right.event_id));
      })
      .slice(0, limit)
      .map((entry) => clone(entry));
  }

  async function appendEvent(id, record) {
    if (id !== undefined && id !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', { expected: characterId, got: id });
    }
    return withLock(storage, characterId, async () => {
      const list = await readJson(storage, 'evlog');
      const events = Array.isArray(list) ? list : [];
      if (events.some((entry) => entry.event_id === record.event_id)) {
        logger.warn({ code: 'DUPLICATE_EVENT_ID', event_id: record.event_id });
        return { duplicate: true };
      }
      const next = [...events, clone(record)];
      await writeJson(storage, 'evlog', next.length > EVLOG_LIMIT ? next.slice(next.length - EVLOG_LIMIT) : next);
      return { duplicate: false };
    });
  }

  /**
   * 04 §5.3：中止发生在 W2/W3（尚未写业务键）时，清掉 prepare 痕迹后抛 ABORTED。
   * 清理失败也不阻断：下一次 `recover()` 在无 journal 时会清掉 `rollback_state`。
   */
  async function abortPrepared(signal, meta) {
    if (!signal || !signal.aborted) return;
    try {
      meta.rollback_state = null;
      meta.tx_journal = null;
      await writeJson(storage, 'meta', meta);
    } catch {
      logger.error({ code: 'ABORT_CLEANUP_FAILED' });
    }
    throw abortedError();
  }

  async function commit(tx, signal) {
    const changes = tx.$changes();
    const prevMeta = normalizeMeta(await readJson(storage, 'meta'));

    checkAbort(signal);
    hook('W1');
    const prevState = await readJson(storage, 'state');
    const prevEvlog = await readJson(storage, 'evlog');
    const prevIdem = await readJson(storage, 'idem');
    checkAbort(signal);

    const writesState = changes.has('state');
    const writesEvlog = changes.has('evlog');
    const writesIdem = changes.has('idem');
    const newState = writesState ? changes.get('state') : null;
    const newEvlog = writesEvlog ? changes.get('evlog') : null;
    const newIdem = writesIdem ? changes.get('idem') : null;

    // P-12-09：事务内 `putMeta` 的缓冲必须合并进 meta，否则 12 §5.4 的回放摘要永远写不进去。
    const bufferedMeta = changes.has('meta') ? changes.get('meta') : null;
    const meta = bufferedMeta ? normalizeMeta({ ...prevMeta, ...bufferedMeta }) : prevMeta;
    meta.rollback_state = prevState ? sanitizeState(prevState) : null;
    hook('W2');
    await writeJson(storage, 'meta', meta);
    await abortPrepared(signal, meta);

    const journal = {
      tx_id: nextId(),
      phase: 'prepared',
      prev_version: prevState ? prevState.state_version : null,
      to_version: newState ? newState.state_version : null,
      idem_keys: writesIdem ? idemKeysOf(newIdem, prevIdem) : [],
      evlog_event_ids: writesEvlog ? eventIdsOf(newEvlog, prevEvlog) : [],
      created_at: clock()
    };
    meta.tx_journal = journal;
    hook('W3');
    await writeJson(storage, 'meta', meta);
    await abortPrepared(signal, meta);

    try {
      if (writesState) {
        hook('W4');
        const current = await readJson(storage, 'state');
        const expected = tx.$expectedVersion() ?? (current ? current.state_version : 0);
        const valid = current === null
          ? expected === 0 && newState.state_version === 0
          : current.state_version === expected && newState.state_version === expected + 1;
        if (!valid) throw contractError('STATE_VERSION_CONFLICT', 'state version conflict');
        await writeJson(storage, 'state', newState);
        checkAbort(signal);
      }

      if (writesEvlog) {
        hook('W5');
        await writeJson(storage, 'evlog', newEvlog);
        checkAbort(signal);
      }

      if (writesIdem) {
        hook('W6');
        await writeJson(storage, 'idem', newIdem);
        checkAbort(signal);
      }

      hook('W7');
      journal.phase = 'committed';
      meta.tx_journal = journal;
      try {
        await writeJson(storage, 'meta', meta);
      } catch {
        await writeJson(storage, 'meta', meta);
      }

      hook('W8a');
      meta.rollback_state = null;
      await writeJson(storage, 'meta', meta);

      hook('W8b');
      meta.tx_journal = null;
      await writeJson(storage, 'meta', meta);
    } catch (err) {
      try {
        if (writesState) {
          if (prevState === null) await deleteKey(storage, 'state');
          else await writeJson(storage, 'state', prevState);
        }
        if (writesEvlog) {
          if (prevEvlog === null) await deleteKey(storage, 'evlog');
          else await writeJson(storage, 'evlog', prevEvlog);
        }
        if (writesIdem) {
          if (prevIdem === null) await deleteKey(storage, 'idem');
          else await writeJson(storage, 'idem', prevIdem);
        }
        meta.rollback_state = null;
        meta.tx_journal = null;
        await writeJson(storage, 'meta', meta);
      } catch {
        await markRecoveryRequired('transaction', 'rollback_failed');
        throw storageError('rollback failed', { recovery_required: true });
      }
      if (err && err.code && err.code !== 'STORAGE_FAILED') throw err;
      throw storageError('storage transaction failed');
    }

    return undefined;
  }

  async function transaction(fn, opts = {}) {
    const signal = opts === null ? undefined : opts.signal;
    // P-13-02：ensureReady 期间 abort 不生效——先完成迁移，再判定中止并如实记录 migrated。
    const ready = await ensureReady();
    if (signal && signal.aborted) {
      // 中止在 ensureReady 之后才生效：迁移可能已经落盘，日志必须如实记录（P3-1）。
      logger.warn({ code: 'ABORTED_AFTER_READY', migrated: Boolean(ready?.migrated) });
      throw abortedError();
    }
    const tx = createTx({ storage, characterId, clock, logger, preparedState: ready.state });
    let result;
    try {
      result = await fn(tx);
    } catch (err) {
      if (err && err.code && err.code !== 'STORAGE_FAILED') throw err;
      throw storageError('transaction callback failed');
    }
    checkAbort(signal);
    if (tx.$changes().size === 0) return result;
    await withLock(storage, characterId, () => commit(tx, signal));
    return result;
  }

  function assertAdminPayload(operation, payload) {
    const value = payload === undefined || payload === null ? {} : payload;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw contractError('INVALID_REQUEST', 'payload must be an object', { path: 'payload' });
    }
    const allowed = operation === 'manual_cycle_correction' ? ['anchor_at', 'cycle_length_days'] : [];
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw contractError('INVALID_REQUEST', 'unknown field in payload', { unknown_fields: unknown });
    }
    if (operation !== 'manual_cycle_correction') return;
    if (typeof value.anchor_at !== 'string') {
      throw contractError('INVALID_REQUEST', 'payload.anchor_at is required', { path: 'payload.anchor_at' });
    }
    if (value.cycle_length_days !== undefined) {
      const days = value.cycle_length_days;
      if (!Number.isInteger(days) || days < 20 || days > 45) {
        throw contractError('INVALID_REQUEST', 'payload.cycle_length_days must be an integer within [20,45]', {
          path: 'payload.cycle_length_days',
          got: days
        });
      }
    }
  }

  /** 04 §6：`reset_state` / `reset_seed` 的新状态。纯构造，不写盘；参数错误在写前抛出。 */
  function buildAdminState({ current, operation, now }) {
    if (operation === 'reset_state') {
      const next = createDefaultState({
        character_id: characterId,
        timezone: current.timezone,
        now,
        engine_version: current.engine_version,
        // 必须沿用原种子：否则与 meta.master_seed_id 不一致（04 §6、S39）。
        master_seed_hex: current.random.master_seed_hex,
        config: { config_version: current.config_version }
      });
      next.state_version = current.state_version + 1;
      next.created_at = current.created_at;
      next.updated_at = now;
      return next;
    }

    const seed = seedFactory();
    const provider = new RandomProvider({
      master_seed_hex: seed,
      character_id: characterId,
      algorithm_version: current.random.algorithm_version
    });
    const next = clone(current);
    next.random = provider.toPersisted();
    next.state_version = current.state_version + 1;
    next.updated_at = now;
    return next;
  }

  /** 04 §6：管理动作的审计记录；只追加、按 200 条 / 14 KiB 收缩。 */
  async function appendAdminEvent(operation, occurredAt) {
    const eventId = `adm_${sha256Hex(`${characterId}|${operation}|${occurredAt}`).slice(0, 16)}`;
    const list = await readJson(storage, 'evlog');
    let events = Array.isArray(list) ? list.slice() : [];
    events.push({
      event_id: eventId,
      character_id: characterId,
      event_type: 'admin_command',
      source_key: adminSourceKey,
      intensity: 0,
      occurred_at: occurredAt
    });
    if (events.length > EVLOG_LIMIT) events = events.slice(events.length - EVLOG_LIMIT);
    while (events.length > 0 && sizeOf('evlog', events) > EVLOG_WRITE_TARGET_BYTES) events.shift();
    await writeJson(storage, 'evlog', events);
  }

  /**
   * 04 §6：管理重置的唯一实现（12 / 13 只调用）。
   * 不走 `transaction()`：写序 state → idem（仅 reset_state）→ evlog → meta；
   * 失败不回滚已写键，只写 `meta.recovery_required` 并返回 STORAGE_FAILED。
   *
   * 分层（P1）：`lib/storage` 不依赖 `lib/modules`。`manual_cycle_correction` 的业务
   * 计算由调用方通过 `prepare(state, payload, now) -> newState` 注入；04 只负责写盘与
   * 强制 `state_version = 旧值 + 1`、`updated_at = now`。
   * 时间基准只用调用方传入的 `now`（来自请求体），不读 factory 的 `clock`。
   */
  async function adminReset(characterIdArg, request = {}) {
    if (characterIdArg !== characterId) {
      throw contractError('INVALID_REQUEST', 'character_id mismatch', {
        expected: characterId,
        got: characterIdArg
      });
    }
    const { operation, payload = undefined, now, prepare } = request ?? {};
    if (!ADMIN_OPERATIONS.has(operation)) {
      throw contractError('INVALID_REQUEST', 'unknown admin operation', { operation });
    }
    if (typeof now !== 'string') {
      throw contractError('INVALID_REQUEST', 'now is required', { path: 'now' });
    }
    parseTime(now, 'now');
    if (operation === 'manual_cycle_correction' && typeof prepare !== 'function') {
      throw contractError('INVALID_REQUEST', 'manual_cycle_correction requires a prepare callback', {
        reason: 'prepare_required'
      });
    }
    assertAdminPayload(operation, payload);

    return withLock(storage, characterId, async () => {
      const stored = await readJson(storage, 'state');
      if (stored === null) {
        throw contractError('NOT_FOUND', 'state not found', { character_id: characterId });
      }
      // 复用本次管理操作的状态读取；配置迁移仅改内存，由原管理写序一次落盘。
      const current = migrateConfigVersion(stored);
      const metaBefore = normalizeMeta(await readJson(storage, 'meta'));
      // 04 §6：reset_state 是迁移失败后的唯一逃生舱，允许并清除备份；
      // reset_seed / manual_cycle_correction 在备份未清时拒绝，避免种子与备份分叉。
      if (metaBefore.state_backup && operation !== 'reset_state') {
        return { ok: false, code: 'STORAGE_FAILED', details: { reason: 'migration_backup_pending' } };
      }

      let next;
      if (operation === 'manual_cycle_correction') {
        next = await prepare(clone(current), payload ?? {}, now);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          throw contractError('INVALID_REQUEST', 'prepare must return a state object', { path: 'prepare' });
        }
        next = clone(next);
      } else {
        next = buildAdminState({ current, operation, now });
      }
      // prepare 也不能把当前管理写操作的配置版本回退到 v1。
      next = migrateConfigVersion(next);
      // 版本与时间戳由 04 统一写死，prepare 不得自行决定。
      next.state_version = current.state_version + 1;
      next.updated_at = now;
      if (next.character_id !== characterId) {
        throw contractError('INVALID_REQUEST', 'prepare returned a state for another character', {
          expected: characterId,
          got: next.character_id
        });
      }
      const check = validateState(next, { maxSchemaVersion });
      if (!check.ok) {
        throw contractError(check.code ?? 'INTERNAL', 'admin reset produced an invalid state');
      }
      if (stateBytes(next) > STATE_LIMIT_BYTES) {
        return { ok: false, code: 'STORAGE_FAILED', details: { reason: 'state_too_large' } };
      }

      try {
        await writeJson(storage, 'state', next);
        if (operation === 'reset_state') await writeJson(storage, 'idem', []);
        await appendAdminEvent(operation, now);
        const meta = normalizeMeta(await readJson(storage, 'meta'));
        meta.master_seed_id = sha256Hex(next.random.master_seed_hex).slice(0, 8);
        if (operation === 'reset_state') {
          // 状态已整体重建，旧备份继续保留会在下一次 loadState 覆盖刚重置的状态。
          meta.state_backup = null;
          delete meta.migration_failed_at;
        }
        await writeJson(storage, 'meta', meta);
      } catch {
        await markRecoveryRequired(operation, 'admin_reset_failed');
        return { ok: false, code: 'STORAGE_FAILED', details: { recovery_required: true } };
      }

      return { ok: true, operation, accepted_at: now, state_version: next.state_version };
    });
  }

  return {
    loadState,
    saveState,
    findEventResult,
    listRecentEvents,
    appendEvent,
    transaction,
    adminReset
  };
}

export default createRepository;
