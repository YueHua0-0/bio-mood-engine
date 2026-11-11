/**
 * 04 §8：S01–S34 断言骨架（实现后置）。
 *
 * 本文件在设计阶段先固化断言与被测契约，`lib/storage/*.mjs` 实现提交后自动启用。
 * 骨架阶段 `node --test` 会显示 32 skipped / 0 fail，这是预期结果，不是通过。
 *
 * 被测契约（04 §4/§5，实现必须与此一致）：
 * - 工厂：createRepository({ storage, character_id, clock?, id_factory?, logger?, hooks?, migrations? })
 *   storage 为宿主单键接口 { get(key), set(key, value), delete(key) }，值为 JSON 字符串。
 * - 键：固定字面量 state / evlog / idem / meta / cfg（04 §5.1），不得加命名空间前缀。
 * - 事务：transaction(fn) 先做"内存缓冲"，fn 正常返回且缓冲非空时才进入 WAL；
 *   缓冲为空（如幂等命中）不写任何键（04 §5.3 "不写任何键"）。
 * - WAL 步骤（hooks.beforeStep 的 step 名）：W1 / W2 / W3 / W4 / W5 / W6 / W7 / W8a / W8b。
 *   W2 后 = beforeStep('W3')，W8 第一删后 = beforeStep('W8b')。
 * - 崩溃注入：hook 内先调 storage.crash() 再抛 fatal 错误，模拟进程死亡（后续补偿全部失败）。
 * - saveState(state, expectedVersion)：不存在状态时 expectedVersion=0 且 state.state_version=0 视为初始化；
 *   存在状态时要求 state.state_version === expectedVersion + 1；版本不符返回 { ok:false, code }。
 * - putState(state, expectedVersion)：W4 重读 state 后再校验版本，不符抛 STATE_VERSION_CONFLICT。
 *
 * 已裁决（v1.7.3）：
 * - C-04-01：meta.rollback_state 脱敏（seed 替换为 master_seed_id）；meta.state_backup 是唯一例外，
 *   允许含完整种子。管理动作失败不回滚，走 recovery_required。
 * - C-04-02：事务内业务错误码原样透传，仅存储层错误转 STORAGE_FAILED。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDefaultState } from '../../lib/core/models.mjs';
import { CHARACTER_ID, MASTER_SEED } from './_random_vectors.mjs';

let repositoryModule = null;
try {
  repositoryModule = await import('../../lib/storage/repository.mjs');
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

let pluginModule = null;
try {
  pluginModule = await import('../../lib/storage/plugin-storage.mjs');
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

const createRepository = repositoryModule?.createRepository;
const createChatScopedRepo = pluginModule?.createChatScopedRepo;

const SKIP = repositoryModule && pluginModule
  ? false
  : '04 实现未提交（当前仅设计与断言骨架）';

const FIXED_NOW = '2026-11-09T09:00:00.000Z';
const START = '2026-11-09T08:00:00.000Z';
const EVENT_ID = 'evt_20261109_0001';

// ---------------------------------------------------------------------------
// 测试替身：宿主 ctx.storage（单键 get/set/delete，值一律走 JSON 字符串）
// ---------------------------------------------------------------------------

function crashError() {
  const err = new Error('simulated process crash');
  err.fatal = true;
  return err;
}

function transientStorageError() {
  return new Error('storage unavailable');
}

function createMemoryStorage(initial = {}) {
  const data = new Map();
  for (const [key, value] of Object.entries(initial)) {
    data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const state = {
    ops: 0,
    crashed: false,
    log: [],
    writeFailures: new Map(),
    readFailures: new Map()
  };

  function before(op, key) {
    if (state.crashed) throw crashError();
    state.ops += 1;
    state.log.push({ op, key });
  }

  function consumeFailure(map, key) {
    const remaining = map.get(key) ?? 0;
    if (remaining > 0) {
      map.set(key, remaining === Infinity ? Infinity : remaining - 1);
      throw transientStorageError();
    }
  }

  const storage = {
    async get(key) {
      before('get', key);
      consumeFailure(state.readFailures, key);
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      before('set', key);
      consumeFailure(state.writeFailures, key);
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) {
      before('delete', key);
      consumeFailure(state.writeFailures, key);
      data.delete(key);
    },

    // —— 测试观测面 ——
    raw(key) {
      return data.has(key) ? data.get(key) : null;
    },
    json(key) {
      const raw = storage.raw(key);
      return raw === null ? null : JSON.parse(raw);
    },
    keys() {
      return [...data.keys()];
    },
    get ops() {
      return state.ops;
    },
    get log() {
      return state.log;
    },
    writes() {
      return state.log.filter((entry) => entry.op !== 'get');
    },
    failNextWrites(key, times = 1) {
      state.writeFailures.set(key, times);
    },
    failNextReads(key, times = 1) {
      state.readFailures.set(key, times);
    },
    crash() {
      state.crashed = true;
    },
    /** 模拟进程重启：同一份持久介质，故障与崩溃标记清零。 */
    restart() {
      state.crashed = false;
      state.ops = 0;
      state.log.length = 0;
      state.writeFailures.clear();
      state.readFailures.clear();
    }
  };

  return storage;
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

function baseState(overrides = {}) {
  return createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: START,
    master_seed_hex: MASTER_SEED,
    ...overrides
  });
}

function bumped(state, changes = {}) {
  return {
    ...state,
    ...changes,
    state_version: state.state_version + 1,
    updated_at: FIXED_NOW,
    last_tick_at: FIXED_NOW
  };
}

function createIdFactory() {
  let n = 0;
  return () => `tx_${String((n += 1)).padStart(4, '0')}`;
}

function createLogger() {
  const entries = [];
  const push = (level) => (entry) => entries.push({ level, ...(typeof entry === 'string' ? { message: entry } : entry) });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function openRepo(storage, overrides = {}) {
  return createRepository({
    storage,
    character_id: CHARACTER_ID,
    clock: () => FIXED_NOW,
    id_factory: createIdFactory(),
    logger: createLogger(),
    ...overrides
  });
}

function totalBytes(storage) {
  return storage.keys().reduce((sum, key) => sum + Buffer.byteLength(storage.raw(key), 'utf8'), 0);
}

function eventRecord(overrides = {}) {
  return {
    event_id: EVENT_ID,
    event_type: 'group_message',
    occurred_at: '2026-11-09T08:59:00.000Z',
    processed_at: FIXED_NOW,
    source_key: 'wechat:group_1:sender_a',
    intensity: 0.02,
    idempotency_key: EVENT_ID,
    state_version_before: 0,
    state_version_after: 1,
    ...overrides
  };
}

function idemRecord(overrides = {}) {
  return {
    key: EVENT_ID,
    character_id: CHARACTER_ID,
    result: { delivery: { policy: 'deliver_now' } },
    expires_at: '2026-11-16T09:00:00.000Z',
    ...overrides
  };
}

/** 一次标准推进事务：读状态 → 查幂等 → 写状态/事件/幂等。 */
async function advanceOnce(repo, { idemKey = EVENT_ID, eventId = EVENT_ID } = {}) {
  return repo.transaction(async (tx) => {
    const cur = await tx.getState(CHARACTER_ID);
    assert.ok(cur, 'advanceOnce 需要已存在的状态');
    const dup = await tx.getIdempotency(idemKey);
    if (dup) return { duplicate: true, ...dup };
    const updated = bumped(cur.state);
    await tx.putState(updated, cur.version);
    await tx.appendEvent(eventRecord({
      event_id: eventId,
      idempotency_key: idemKey,
      state_version_before: cur.version,
      state_version_after: cur.version + 1
    }));
    await tx.appendIdempotency(idemRecord({ key: idemKey }));
    return { duplicate: false, state_version: cur.version + 1 };
  });
}

/** 在指定 WAL 步骤前模拟进程死亡；调用方随后用 storage.restart() 表示"下一个进程"。 */
async function simulateCrashAt(storage, step) {
  const repo = openRepo(storage, {
    hooks: {
      beforeStep(current) {
        if (current !== step) return;
        storage.crash();
        throw crashError();
      }
    }
  });
  await assert.rejects(() => advanceOnce(repo, { idemKey: 'idem_crash' }));
}

// ---------------------------------------------------------------------------
// S01–S18：仓库接口、乐观锁、幂等、预算、恢复
// ---------------------------------------------------------------------------

test('S01 空库 loadState 返回 null', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  assert.equal(await repo.loadState(CHARACTER_ID), null);
});

test('S02 saveState 版本匹配 → ok:true 且版本 +1', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();

  const created = await repo.saveState(v0, 0);
  assert.deepEqual(created, { ok: true, state_version: 0 });

  const saved = await repo.saveState(bumped(v0), 0);
  assert.equal(saved.ok, true);
  assert.equal(saved.state_version, 1);
  assert.equal(storage.json('state').state_version, 1);
});

test('S03 expectedVersion 落后 1 → STATE_VERSION_CONFLICT 且键值不变', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();
  await repo.saveState(v0, 0);
  const v1 = bumped(v0);
  await repo.saveState(v1, 0);
  const before = storage.raw('state');

  const conflict = await repo.saveState(bumped(v1), 0);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'STATE_VERSION_CONFLICT');
  assert.equal(storage.raw('state'), before);
});

test('S04 两个并发写抢同一版本 → 只成功一个', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();
  await repo.saveState(v0, 0);

  const stateA = bumped(v0, { mood: { ...v0.mood, energy: 0.11 } });
  const stateB = bumped(v0, { mood: { ...v0.mood, energy: 0.22 } });
  const [a, b] = await Promise.all([repo.saveState(stateA, 0), repo.saveState(stateB, 0)]);

  const okCount = [a, b].filter((r) => r.ok).length;
  assert.equal(okCount, 1);
  assert.equal([a, b].find((r) => !r.ok).code, 'STATE_VERSION_CONFLICT');
  assert.equal(storage.json('state').state_version, 1);
});

test('S05 重复 idempotency_key → duplicate:true 且 state_version 不变', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  const first = await advanceOnce(repo, { idemKey: 'idem_same' });
  const second = await advanceOnce(repo, { idemKey: 'idem_same' });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((await repo.loadState(CHARACTER_ID)).state_version, 1);

  const found = await repo.findEventResult(CHARACTER_ID, 'idem_same');
  assert.ok(found);
  assert.equal(found.state_version, 1);
  assert.match(found.result_digest, /^[0-9a-f]{16}$/);
});

test('S06 同 event_id 不同 key → 两次都推进，evlog 只留一条', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const logger = createLogger();
  const repo = openRepo(storage, { logger });
  await repo.saveState(baseState(), 0);

  await advanceOnce(repo, { idemKey: 'idem_first', eventId: EVENT_ID });
  await advanceOnce(repo, { idemKey: 'idem_second', eventId: EVENT_ID });

  assert.equal((await repo.loadState(CHARACTER_ID)).state_version, 2);
  assert.equal((await repo.listRecentEvents(CHARACTER_ID, 10)).length, 1);
  assert.ok(logger.entries.some((entry) => entry.code === 'DUPLICATE_EVENT_ID'));
});

test('S07 事件写失败 → 状态回滚到旧版本，无半成品', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  storage.failNextWrites('evlog', 1);

  await assert.rejects(() => advanceOnce(repo), (err) => err.code === 'STORAGE_FAILED');

  assert.equal((await repo.loadState(CHARACTER_ID)).state_version, 0);
  assert.equal(await repo.findEventResult(CHARACTER_ID, EVENT_ID), null);
  assert.equal(storage.json('meta').tx_journal ?? null, null);
});

test('S08 合计逼近配额 → 按 快照→幂等→日志 淘汰，state 保留', { skip: SKIP }, async () => {
  // 构造的是超限场景（300 条 idem + 200 条 evlog），断言的是淘汰后的稳态；
  // note 固定 40 字符，让总量可预期（否则单条 evlog 均长波动会让断言不稳定）。
  const v0 = baseState();
  const idem = [];
  for (let i = 0; i < 300; i += 1) {
    idem.push({
      key: `idem_${String(i).padStart(3, '0')}`,
      character_id: CHARACTER_ID,
      event_id: `evt_${String(i).padStart(8, '0')}`,
      state_version: i,
      result_digest: 'a'.repeat(16),
      result: { note: 'x'.repeat(60) },
      processed_at: '2026-11-09T08:00:00.000Z',
      expires_at: '2026-11-16T08:00:00.000Z'
    });
  }
  const evlog = [];
  for (let i = 0; i < 200; i += 1) {
    evlog.push(eventRecord({
      event_id: `evt_log_${String(i).padStart(8, '0')}`,
      occurred_at: '2026-11-01T08:00:00.000Z',
      note: 'y'.repeat(40)
    }));
  }
  const snapshots = [];
  for (let i = 0; i < 12; i += 1) {
    snapshots.push({ state_version: i, updated_at: '2026-11-01T08:00:00.000Z', summary: { v: i } });
  }

  const storage = createMemoryStorage({
    state: v0,
    idem,
    evlog,
    meta: { schema_migrations: [], state_backup: null, snapshots, tx_journal: null, rollback_state: null }
  });
  const logger = createLogger();
  const repo = openRepo(storage, { logger });
  const stateBefore = storage.raw('state');

  // 04 §5.2：单次 loadState 最多淘汰 64 条，剩余留到后续轮次；这里跑到稳态。
  for (let round = 0; round < 20; round += 1) {
    await repo.loadState(CHARACTER_ID);
    if (totalBytes(storage) <= 64 * 1024) break;
  }

  assert.equal(storage.raw('state'), stateBefore, 'state 永不淘汰');
  assert.ok(totalBytes(storage) <= 64 * 1024, '稳态合计必须回到 64 KiB 内');
  assert.ok(storage.json('meta').snapshots.length < snapshots.length, '先淘汰最旧快照');
  assert.ok(logger.entries.some((entry) => entry.code === 'STORAGE_EVICTED'));
});

test('S09 重新构造仓库后 loadState 与写入前深度相等', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  await advanceOnce(repo);
  const saved = await repo.loadState(CHARACTER_ID);

  const reopened = await openRepo(storage).loadState(CHARACTER_ID);
  assert.deepEqual(reopened, saved);
});

test('S10 迁移 1→2 连续执行两次 → 第二次 no-op，结果深度相等', { skip: SKIP }, async () => {
  const step = (state) => ({ ...state, sleep: { ...state.sleep, sleep_debt: 0.5 } });
  const migrations = { target_version: 2, steps: { 1: [step] } };
  const storage = createMemoryStorage({ state: baseState() });

  const first = await openRepo(storage, { migrations }).loadState(CHARACTER_ID);
  assert.equal(first.schema_version, 2);
  assert.equal(first.sleep.sleep_debt, 0.5);

  const second = await openRepo(storage, { migrations }).loadState(CHARACTER_ID);
  assert.deepEqual(second, first);
  assert.deepEqual(
    storage.json('meta').schema_migrations.map((m) => [m.from, m.to]),
    [[1, 2]]
  );
});

test('S11 迁移中途抛错 → 恢复 state_backup，备份仍存在', { skip: SKIP }, async () => {
  const migrations = {
    target_version: 2,
    steps: { 1: [() => { throw new Error('migration boom'); }] }
  };
  const v0 = baseState();
  const storage = createMemoryStorage({ state: v0 });

  await assert.rejects(
    () => openRepo(storage, { migrations }).loadState(CHARACTER_ID),
    (err) => err.code === 'INTERNAL'
  );

  assert.deepEqual(storage.json('state'), v0);
  assert.ok(storage.json('meta').state_backup, '失败后备份必须保留');
});

test('S12 非法键名（65 字符 / 含 :）→ INVALID_REQUEST', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  const before = storage.raw('state');

  await assert.rejects(
    () => repo.transaction(async (tx) => { await tx.put('a'.repeat(65), {}); }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  await assert.rejects(
    () => repo.transaction(async (tx) => { await tx.put('bad:key', {}); }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  assert.equal(storage.raw('state'), before);
});

test('S13 state 可序列化且 8 KiB 边界', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();

  // 默认状态 ≤8 KiB 且可序列化
  assert.equal(Buffer.byteLength(JSON.stringify(v0), 'utf8') <= 8 * 1024, true);
  assert.deepEqual(JSON.parse(JSON.stringify(v0)), v0);
  await repo.saveState(v0, 0);

  // 恰好 8 KiB：允许（用合法字符串字段 sleep.last_transition_reason 撑体积，不引入新字段）
  const padTo = (state, target) => {
    const probe = { ...state, sleep: { ...state.sleep, last_transition_reason: '' } };
    const filler = 'x'.repeat(target - Buffer.byteLength(JSON.stringify(probe), 'utf8'));
    return { ...state, sleep: { ...state.sleep, last_transition_reason: filler } };
  };
  const exact = padTo(bumped(v0), 8 * 1024);
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), 8 * 1024);
  assert.equal((await repo.saveState(exact, 0)).ok, true);

  // 8 KiB + 1：拒绝，旧状态保留
  const tooBig = padTo(bumped(exact), 8 * 1024 + 1);
  const before = storage.raw('state');
  const rejected = await repo.saveState(tooBig, 1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'STORAGE_FAILED');
  assert.equal(rejected.details?.reason, 'state_too_large');
  assert.equal(storage.raw('state'), before);
});

test('S14 事务回调抛错 → 所有键保持事务前值', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();
  await repo.saveState(v0, 0);
  await advanceOnce(repo, { idemKey: 'idem_keep' });

  const snapshot = Object.fromEntries(storage.keys().map((key) => [key, storage.raw(key)]));

  await assert.rejects(
    () => repo.transaction(async (tx) => {
      await tx.putState(bumped(v0), 1);
      throw new Error('callback boom');
    }),
    (err) => err.code === 'STORAGE_FAILED' // 无 code 的异常 → 存储层错误（C-04-02）
  );

  for (const [key, value] of Object.entries(snapshot)) {
    assert.equal(storage.raw(key), value, `键 ${key} 必须保持事务前值`);
  }
});

test('S15 state 被写坏 → 从 meta.state_backup 恢复并告警', { skip: SKIP }, async () => {
  const backup = bumped(baseState());
  const storage = createMemoryStorage({
    state: '{"schema_version":1,"broken":true}',
    meta: {
      schema_migrations: [],
      state_backup: { schema_version: 1, state: backup, digest: 'x', created_at: FIXED_NOW },
      snapshots: [],
      tx_journal: null,
      rollback_state: null
    }
  });
  const logger = createLogger();
  const repo = openRepo(storage, { logger });

  const restored = await repo.loadState(CHARACTER_ID);
  assert.equal(restored.state_version, backup.state_version);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn'));
});

test('S16 91 天前事件 / 8 天前幂等 → 被清理，state 不受影响', { skip: SKIP }, async () => {
  const v0 = baseState();
  const storage = createMemoryStorage({
    state: v0,
    evlog: [
      eventRecord({ event_id: 'evt_old_00000001', occurred_at: '2026-08-10T08:00:00.000Z' }),
      eventRecord({ event_id: 'evt_new_00000001', occurred_at: '2026-11-08T08:00:00.000Z' })
    ],
    idem: [
      idemRecord({ key: 'idem_expired_01', expires_at: '2026-11-02T08:00:00.000Z' }),
      idemRecord({ key: 'idem_fresh_0001', expires_at: '2026-11-16T08:00:00.000Z' })
    ],
    meta: { schema_migrations: [], state_backup: null, snapshots: [], tx_journal: null, rollback_state: null }
  });
  const repo = openRepo(storage);

  await repo.loadState(CHARACTER_ID);

  const recent = await repo.listRecentEvents(CHARACTER_ID, 10);
  assert.deepEqual(recent.map((ev) => ev.event_id), ['evt_new_00000001']);
  assert.equal(await repo.findEventResult(CHARACTER_ID, 'idem_expired_01'), null);
  assert.ok(await repo.findEventResult(CHARACTER_ID, 'idem_fresh_0001'));
  assert.deepEqual(storage.json('state'), v0);
});

test('S17 两个事务使用同一 key → 一个成功、一个 duplicate', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  const first = await advanceOnce(repo, { idemKey: 'idem_twice' });
  const writesBefore = storage.writes().length;
  const second = await advanceOnce(repo, { idemKey: 'idem_twice' });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(storage.writes().length, writesBefore, 'duplicate 路径不得写任何键');
  assert.equal((await repo.loadState(CHARACTER_ID)).state_version, 1);
});

test('S18 非主聊天 / 未配置 primary_chat_id → DEGRADED 且不写键', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const nonPrimary = createChatScopedRepo({
    storage,
    characterId: CHARACTER_ID,
    chatId: 'chat_other',
    primaryChatId: 'chat_primary',
    config: {},
    clock: () => FIXED_NOW
  });
  const unbound = createChatScopedRepo({
    storage,
    characterId: CHARACTER_ID,
    chatId: 'chat_a',
    config: {},
    clock: () => FIXED_NOW
  });

  const cases = [
    [nonPrimary, 'NON_PRIMARY_READONLY'],
    [unbound, 'PRIMARY_UNBOUND']
  ];
  for (const [repo, warning] of cases) {
    const saved = await repo.saveState(baseState(), 0);
    assert.equal(saved.ok, false);
    assert.equal(saved.code, 'DEGRADED');
    assert.ok(saved.details?.warnings?.includes(warning), `details.warnings 必须含 ${warning}`);
    await assert.rejects(
      () => repo.transaction(async (tx) => tx.getState(CHARACTER_ID)),
      (err) => err.code === 'DEGRADED'
    );
  }
  assert.equal(storage.keys().length, 0, '只读降级不得写任何键');
});

// ---------------------------------------------------------------------------
// S19–S27：WAL 崩溃点与启动恢复
// ---------------------------------------------------------------------------

test('S19 崩溃点 W02 后（仅 rollback_state）→ 清理孤儿快照，state 不变', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W3');
  assert.ok(storage.json('meta').rollback_state, '崩溃时 rollback_state 应已写入');
  assert.equal(storage.json('meta').tx_journal ?? null, null);

  storage.restart();
  const reopened = openRepo(storage);
  const state = await reopened.loadState(CHARACTER_ID);

  assert.equal(state.state_version, 0);
  assert.equal(storage.json('meta').rollback_state, null);
  assert.equal(storage.json('meta').tx_journal, null);
});

test('S20 崩溃点 W03 后（无状态写入）→ 回滚为空操作，journal 被清理', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W4');
  assert.equal(storage.json('meta').tx_journal.phase, 'prepared');

  storage.restart();
  const state = await openRepo(storage).loadState(CHARACTER_ID);

  assert.equal(state.state_version, 0);
  assert.equal(storage.json('meta').tx_journal, null);
  assert.equal(storage.json('meta').rollback_state, null);
});

test('S21 崩溃点 W04 后（状态已写、日志未写）→ state 恢复旧版本', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W5');
  assert.equal(storage.json('state').state_version, 1);

  storage.restart();
  const state = await openRepo(storage).loadState(CHARACTER_ID);

  assert.equal(state.state_version, 0, 'state_version 不得前进');
  assert.equal(storage.json('meta').tx_journal, null);
});

test('S22 崩溃点 W05 后（日志已写、幂等未写）→ 状态回滚且日志项被删，可重试', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W6');

  storage.restart();
  const reopened = openRepo(storage);
  const state = await reopened.loadState(CHARACTER_ID);
  assert.equal(state.state_version, 0);
  assert.equal((await reopened.listRecentEvents(CHARACTER_ID, 10)).length, 0);

  const retry = await advanceOnce(reopened, { idemKey: 'idem_crash' });
  assert.equal(retry.duplicate, false);
  assert.equal((await reopened.loadState(CHARACTER_ID)).state_version, 1);
});

test('S22b 崩溃瞬间取证：W5 已写入日志，恢复后该条被删除', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  let snapshot = null;
  const probe = openRepo(storage, {
    hooks: {
      beforeStep(step) {
        if (step === 'W6') {
          snapshot = storage.raw('evlog');
          storage.crash();
          throw crashError();
        }
      }
    }
  });

  await assert.rejects(() => advanceOnce(probe, { idemKey: 'idem_crash_probe' }));
  assert.equal(JSON.parse(snapshot).length, 1, 'W5 之后 evlog 必须已落盘');

  storage.restart();
  const reopened = openRepo(storage);
  assert.equal((await reopened.loadState(CHARACTER_ID)).state_version, 0);
  assert.equal((await reopened.listRecentEvents(CHARACTER_ID, 10)).length, 0);
});

test('S23 崩溃点 W06 后、W07 前（全部写入、无提交标记）→ 补写 committed，不重复推进', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W7');
  assert.equal(storage.json('meta').tx_journal.phase, 'prepared');

  storage.restart();
  const reopened = openRepo(storage);
  const state = await reopened.loadState(CHARACTER_ID);

  assert.equal(state.state_version, 1, '已全部写入，不得回滚');
  assert.ok(await reopened.findEventResult(CHARACTER_ID, 'idem_crash'));
  assert.equal(storage.json('meta').tx_journal, null);
  assert.equal(storage.json('meta').rollback_state, null);
});

test('S24 崩溃点 W07 后（有提交标记）→ 仅清理，状态保留', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W8a');
  assert.equal(storage.json('meta').tx_journal.phase, 'committed');

  storage.restart();
  const state = await openRepo(storage).loadState(CHARACTER_ID);

  assert.equal(state.state_version, 1);
  assert.equal(storage.json('meta').tx_journal, null);
  assert.equal(storage.json('meta').rollback_state, null);
});

test('S25 崩溃点 W08 第一删后（剩 journal）→ 启动清理 journal，状态保留', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W8b');
  assert.equal(storage.json('meta').rollback_state, null);
  assert.ok(storage.json('meta').tx_journal);

  storage.restart();
  const state = await openRepo(storage).loadState(CHARACTER_ID);

  assert.equal(state.state_version, 1);
  assert.equal(storage.json('meta').tx_journal, null);
});

test('S26 恢复时回滚写失败 → 写 recovery_required，后续推进 STORAGE_FAILED', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  await simulateCrashAt(storage, 'W6');
  storage.restart();
  storage.failNextWrites('state', Infinity);

  const reopened = openRepo(storage);
  await assert.rejects(
    () => reopened.loadState(CHARACTER_ID),
    (err) => err.code === 'STORAGE_FAILED'
  );
  assert.ok(storage.json('meta').recovery_required, '必须落盘 recovery_required');

  await assert.rejects(
    () => reopened.transaction(async (tx) => tx.getState(CHARACTER_ID)),
    (err) => err.code === 'STORAGE_FAILED' && err.details?.recovery_required === true
  );
});

test('S27 journal 结构损坏 → 不猜测，写 recovery_required', { skip: SKIP }, async () => {
  const storage = createMemoryStorage({ state: baseState() });
  const meta = {
    schema_migrations: [],
    state_backup: null,
    snapshots: [],
    tx_journal: { phase: 'prepared' },
    rollback_state: null
  };
  await storage.set('meta', meta);

  const repo = openRepo(storage);
  await assert.rejects(
    () => repo.loadState(CHARACTER_ID),
    (err) => err.code === 'STORAGE_FAILED'
  );
  assert.ok(storage.json('meta').recovery_required);
  assert.equal(storage.json('state').state_version, 0, '不得猜测并改动 state');
});

// ---------------------------------------------------------------------------
// S28–S29：敏感字段边界与事务规模上限
// ---------------------------------------------------------------------------

test('S28 master_seed_hex 只出现在 state 与 meta.state_backup.state', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  await advanceOnce(repo);

  const leaked = storage.keys().filter((key) => {
    const raw = storage.raw(key);
    if (!raw.includes(MASTER_SEED)) return false;
    if (key === 'state') return false;
    if (key === 'meta') {
      const m = storage.json('meta');
      const rest = { ...m, state_backup: m.state_backup ? { ...m.state_backup, state: null } : null };
      return JSON.stringify(rest).includes(MASTER_SEED);
    }
    return true;
  });
  assert.deepEqual(leaked, [], 'rollback_state / evlog / idem / cfg / snapshots 中不得出现完整主种子');
  assert.ok(storage.raw('state').includes(MASTER_SEED));

  // rollback_state 只在事务执行期间存在：用 beforeStep('W4') 抓快照，避免 if 空过
  let captured = null;
  const probeRepo = openRepo(storage, {
    hooks: {
      beforeStep(step) {
        if (step === 'W4') captured = storage.json('meta').rollback_state;
      }
    }
  });
  await advanceOnce(probeRepo, { idemKey: 'idem_seed_probe' });
  assert.ok(captured, 'W4 前 rollback_state 必须已写入');
  assert.equal(captured.random.master_seed_hex, undefined);
  assert.match(captured.random.master_seed_id, /^[0-9a-f]{8}$/);
});

test('S29 事务超过 40 次键操作 → STORAGE_FAILED，不产生部分提交', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  const before = storage.raw('state');

  let okOps = 0;
  const failure = await repo
    .transaction(async (tx) => {
      // 04 §5.3 的边界是"≤40 次"：恰好 40 次必须通过。
      for (let i = 0; i < 40; i += 1) {
        await tx.get('state');
        okOps += 1;
      }
      await tx.get('state'); // 第 41 次
    })
    .then(() => null, (err) => err);

  assert.equal(okOps, 40, '恰好 40 次不得提前失败');
  assert.equal(failure?.code, 'STORAGE_FAILED');
  assert.equal(storage.raw('state'), before);
  assert.equal(storage.json('meta').tx_journal, null);
});

test('S30 事务内抛业务错误 → 原样透传，不转 STORAGE_FAILED', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  const before = storage.raw('state');

  await assert.rejects(
    () => repo.transaction(async () => {
      throw Object.assign(new Error('module boom'), { code: 'MODULE_FAILED' });
    }),
    (err) => err.code === 'MODULE_FAILED'
  );

  assert.equal(storage.raw('state'), before);
  assert.equal(storage.json('meta').recovery_required, undefined);
  assert.equal(storage.json('meta').tx_journal, null);
});

test('S31 先写 state 再抛业务错误 → 回滚且透传', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();
  await repo.saveState(v0, 0);
  const before = storage.raw('state');

  await assert.rejects(
    () => repo.transaction(async (tx) => {
      await tx.putState(bumped(v0), 0);
      throw Object.assign(new Error('module boom'), { code: 'MODULE_FAILED' });
    }),
    (err) => err.code === 'MODULE_FAILED'
  );

  assert.equal(storage.raw('state'), before, 'state 必须回滚到旧版本');
  assert.equal(storage.json('meta').tx_journal, null);
  assert.equal(storage.json('meta').rollback_state, null);
});

// ---------------------------------------------------------------------------
// S32–S34：只读路径、插件模式存储边界、值类型兼容
// ---------------------------------------------------------------------------

test('S32 loadState({readOnly:true}) 不迁移、不淘汰、不写任何键', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);
  const migrationsBefore = storage.json('meta').schema_migrations;
  storage.restart(); // 清空观测日志，只统计只读路径自身的写入

  let stepCalls = 0;
  const readOnlyRepo = openRepo(storage, {
    migrations: {
      target_version: 2,
      steps: {
        1: [(state) => {
          stepCalls += 1;
          return { ...state, schema_version: 2 };
        }]
      }
    }
  });

  const result = await readOnlyRepo.loadState(CHARACTER_ID, { readOnly: true });

  assert.equal(stepCalls, 0, '只读路径不得执行迁移步骤');
  assert.equal(storage.writes().length, 0, '只读路径不得写任何键');
  assert.deepEqual(storage.json('meta').schema_migrations, migrationsBefore);
  assert.equal(storage.json('state').schema_version, 1);
  assert.equal(result.state.state_version, 0);
  assert.ok(result.warnings.includes('MIGRATION_DEFERRED'));
});

test('S33 非主聊天 appendEvent 不写键；主聊天单键越限被拒', { skip: SKIP }, async () => {
  // 非主聊天：appendEvent 直接丢弃，零写入
  const readonlyStorage = createMemoryStorage();
  const readonlyRepo = createChatScopedRepo({
    storage: readonlyStorage,
    characterId: CHARACTER_ID,
    chatId: 'chat_b',
    primaryChatId: 'chat_a',
    clock: () => FIXED_NOW,
    logger: createLogger(),
    id_factory: createIdFactory()
  });

  const dropped = await readonlyRepo.appendEvent(eventRecord());
  assert.equal(dropped.dropped, true);
  assert.equal(readonlyStorage.writes().length, 0);
  assert.deepEqual(readonlyStorage.keys(), []);

  // 主聊天：evlog 超过 16 KiB 的单键硬上限 → 整体回滚，不落盘。
  // 注意：这里测的是"事务缓冲里直接塞入超大 evlog"的 W5 写盘失败回滚路径（W4 已写 state，需回滚），
  // 不是 appendEvent 的常规路径——常规 appendEvent 由 S35 覆盖"先淘汰再写"。
  const storage = createMemoryStorage();
  const repo = createChatScopedRepo({
    storage,
    characterId: CHARACTER_ID,
    chatId: 'chat_a',
    primaryChatId: 'chat_a',
    clock: () => FIXED_NOW,
    logger: createLogger(),
    id_factory: createIdFactory()
  });
  await repo.saveState(baseState(), 0);

  const overflow = Array.from({ length: 200 }, (_, i) => eventRecord({ event_id: `evt_${i}` }));
  assert.ok(Buffer.byteLength(JSON.stringify(overflow), 'utf8') > 16 * 1024);

  await assert.rejects(
    () => repo.transaction(async (tx) => {
      await tx.put('evlog', overflow);
    }),
    (err) => err.code === 'STORAGE_FAILED'
  );
  assert.equal(storage.raw('evlog'), null, '越界写必须整体回滚');
});

test('S34 loadState 读取兼容 null / 对象 / 字符串三种初值', { skip: SKIP }, async () => {
  function literalStorage(initial) {
    const data = new Map(Object.entries(initial));
    const log = [];
    return {
      async get(key) {
        return data.has(key) ? data.get(key) : undefined; // 宿主可能返回 undefined
      },
      async set(key, value) {
        log.push(key);
        data.set(key, value);
      },
      async delete(key) {
        log.push(key);
        data.delete(key);
      },
      raw(key) {
        return data.has(key) ? data.get(key) : null;
      },
      writes() {
        return log;
      }
    };
  }

  const state = baseState();

  // 1) 缺失（get 返回 undefined）→ state 为 null
  const emptyStorage = literalStorage({});
  const absent = await openRepo(emptyStorage).loadState(CHARACTER_ID, { readOnly: true });
  assert.equal(absent.state, null);

  // 2) 字符串（宿主规范化后的形态）
  const stringStorage = literalStorage({ state: JSON.stringify(state) });
  const fromString = await openRepo(stringStorage).loadState(CHARACTER_ID, { readOnly: true });
  assert.deepEqual(fromString.state, state);

  // 3) 对象（历史写入或宿主自行序列化）
  const objectStorage = literalStorage({ state });
  const fromObject = await openRepo(objectStorage).loadState(CHARACTER_ID, { readOnly: true });
  assert.deepEqual(fromObject.state, state);

  for (const storage of [emptyStorage, stringStorage, objectStorage]) {
    assert.equal(storage.writes().length, 0, '只读读取不得写键');
  }
});

test('S35 evlog 超 16 KiB 时 transaction 先淘汰再写，不抛 STORAGE_FAILED', { skip: SKIP }, async () => {
  const evlog = Array.from({ length: 160 }, (_, i) => eventRecord({
    event_id: `evt_${String(i).padStart(3, '0')}`,
    idempotency_key: `idem_${i}`,
    state_version_before: i,
    state_version_after: i + 1
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(evlog), 'utf8') > 16 * 1024, '夹具必须超过 evlog 硬上限');
  const oldest = evlog[0].event_id;

  const storage = createMemoryStorage({ state: baseState(), evlog });
  const repo = createChatScopedRepo({
    storage,
    characterId: CHARACTER_ID,
    chatId: 'chat_a',
    primaryChatId: 'chat_a',
    clock: () => FIXED_NOW,
    logger: createLogger(),
    id_factory: createIdFactory()
  });

  // 04 §5.2：ensureReady() 先把 evlog 压到写目标（14 KiB），再 append，不得撞 16 KiB 硬上限。
  const result = await repo.transaction(async (tx) => {
    const cur = await tx.getState(CHARACTER_ID);
    const dup = await tx.getIdempotency('idem_new');
    if (dup) return { duplicate: true };
    await tx.putState(bumped(cur.state), cur.version);
    await tx.appendEvent(eventRecord({
      event_id: 'evt_new',
      idempotency_key: 'idem_new',
      state_version_before: cur.version,
      state_version_after: cur.version + 1
    }));
    await tx.appendIdempotency(idemRecord({ key: 'idem_new' }));
    return { duplicate: false, state_version: cur.version + 1 };
  });

  assert.equal(result.duplicate, false);
  const after = storage.json('evlog');
  assert.ok(after.length < evlog.length, '最旧条目必须被淘汰');
  assert.ok(!after.some((entry) => entry.event_id === oldest), '最旧条目被淘汰');
  assert.ok(after.some((entry) => entry.event_id === 'evt_new'), '新事件必须写入');
  assert.ok(Buffer.byteLength(JSON.stringify(after), 'utf8') <= 16 * 1024, '写后仍须在硬上限内');
});

test('S36 readOnly 遇 prepared journal 返回已提交版本并附 RECOVERY_DEFERRED', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  await repo.saveState(baseState(), 0);

  // 崩溃在 W5 前：W4 已写 state=v1，但 journal 仍是 prepared（未提交）。
  await simulateCrashAt(storage, 'W5');
  storage.restart();

  const readOnlyRepo = openRepo(storage);
  const result = await readOnlyRepo.loadState(CHARACTER_ID, { readOnly: true });

  assert.ok(result.warnings.includes('RECOVERY_DEFERRED'));
  assert.equal(result.state.state_version, 0, '只读路径不得返回未提交的 v1');
  assert.equal(storage.json('state').state_version, 1, '磁盘仍是未提交 v1，留给下一次写路径恢复');
  assert.equal(storage.writes().length, 0, '只读路径不得写盘');
});

test('S37 迁移/淘汰在事务边界外：fn 抛错不回滚维护写入', { skip: SKIP }, async () => {
  // 预置 55 条约 14.5 KiB：只让"单键写前收缩"（evlog > 14 KiB）触发，
  // 五键合计仍 < 64 KiB，确保"跨键总量淘汰"不参与，断言归因唯一。
  const evlog = Array.from({ length: 55 }, (_, i) => eventRecord({
    event_id: `evt_${String(i).padStart(3, '0')}`,
    idempotency_key: `idem_${i}`,
    state_version_before: i,
    state_version_after: i + 1
  }));
  const evlogBytes = Buffer.byteLength(JSON.stringify(evlog), 'utf8');
  assert.ok(evlogBytes > 14 * 1024, `evlog 必须超过单键写目标 14 KiB（实际 ${evlogBytes}）`);
  assert.ok(evlogBytes < 16 * 1024, 'evlog 必须低于单键硬上限 16 KiB');
  const oldest = evlog[0].event_id;
  const storage = createMemoryStorage({ state: baseState(), evlog });
  const repo = openRepo(storage, {
    migrations: {
      target_version: 2,
      steps: { 1: [(state) => ({ ...state, schema_version: 2 })] }
    }
  });

  await assert.rejects(
    () => repo.transaction(async (tx) => {
      const cur = await tx.getState(CHARACTER_ID);
      await tx.putState(bumped(cur.state), cur.version);
      throw Object.assign(new Error('module boom'), { code: 'MODULE_FAILED' });
    }),
    (err) => err.code === 'MODULE_FAILED'
  );

  const stored = storage.json('state');
  assert.equal(stored.schema_version, 2, '迁移属于维护写入，不回滚');
  assert.equal(stored.state_version, 0, 'fn 的 putState 不得落盘');
  assert.equal(storage.json('meta').schema_migrations.length, 1);

  const after = storage.json('evlog');
  assert.ok(after.length < evlog.length, '淘汰属于维护写入，不回滚');
  assert.ok(!after.some((entry) => entry.event_id === oldest));
});

// ---------------------------------------------------------------------------
// S39–S40b：管理重置（04 §6）与事务中止边界（04 §5.3）
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 包一层 storage，供 signal 用例在指定写入后触发 abort。 */
function wrapStorage(storage, onAfterSet) {
  return {
    async get(key) {
      return storage.get(key);
    },
    async set(key, value) {
      await storage.set(key, value);
      onAfterSet(key, value);
    },
    async delete(key) {
      return storage.delete(key);
    }
  };
}

test('S39 adminReset 写序 state→idem→evlog→meta；第二步失败不回滚只写 recovery_required', { skip: SKIP }, async () => {
  // --- 失败段：idem 写入失败（第二步） ---
  const storage = createMemoryStorage();
  const repo = openRepo(storage);
  const v0 = baseState();
  await repo.saveState(v0, 0);
  await storage.set('idem', JSON.stringify([idemRecord()]));
  await storage.set('evlog', JSON.stringify([eventRecord()]));

  storage.failNextWrites('idem', 1);
  const failed = await repo.adminReset(CHARACTER_ID, { operation: 'reset_state', now: FIXED_NOW });

  assert.deepEqual(failed, {
    ok: false,
    code: 'STORAGE_FAILED',
    details: { recovery_required: true }
  });
  const stateAfterFailure = storage.json('state');
  assert.equal(stateAfterFailure.state_version, 1, 'state 先写且不回滚');
  assert.equal(stateAfterFailure.random.master_seed_hex, MASTER_SEED, 'reset_state 必须沿用原种子');
  assert.equal(stateAfterFailure.created_at, v0.created_at, 'created_at 保留');
  assert.equal(stateAfterFailure.updated_at, FIXED_NOW);
  const metaAfterFailure = storage.json('meta');
  assert.equal(metaAfterFailure.recovery_required.operation, 'reset_state');
  assert.equal(metaAfterFailure.tx_journal, null, '没走 transaction，不应有 journal');
  assert.equal(metaAfterFailure.rollback_state, null);
  assert.deepEqual(storage.json('idem'), [idemRecord()], '第二步失败，idem 未清空');
  assert.ok(
    !storage.json('evlog').some((entry) => entry.event_type === 'admin_command'),
    '第三步失败，evlog 无本次审计记录'
  );

  // --- 成功段：reset_state ---
  const okStorage = createMemoryStorage();
  const okRepo = openRepo(okStorage);
  const v1 = baseState();
  await okRepo.saveState(v1, 0);
  await okStorage.set('idem', JSON.stringify([idemRecord()]));
  await okStorage.set('evlog', JSON.stringify([eventRecord()]));

  const okResult = await okRepo.adminReset(CHARACTER_ID, { operation: 'reset_state', now: FIXED_NOW });
  assert.deepEqual(okResult, {
    ok: true,
    operation: 'reset_state',
    accepted_at: FIXED_NOW,
    state_version: 1
  });
  const reset = okStorage.json('state');
  assert.equal(reset.state_version, 1);
  assert.equal(reset.random.master_seed_hex, MASTER_SEED);
  assert.equal(reset.created_at, v1.created_at);
  assert.deepEqual(okStorage.json('idem'), [], 'reset_state 清空 idem');
  const admin = okStorage.json('evlog').at(-1);
  assert.equal(admin.event_type, 'admin_command');
  assert.equal(admin.character_id, CHARACTER_ID);
  assert.equal(admin.source_key, 'wechat:admin:admin');
  assert.equal(admin.intensity, 0);
  assert.equal(admin.occurred_at, FIXED_NOW);
  assert.match(admin.event_id, /^adm_[0-9a-f]{16}$/);
  assert.equal(okStorage.json('meta').master_seed_id, sha256Hex(MASTER_SEED).slice(0, 8));

  // --- reset_seed 段：种子变化、master_seed_id 同步、idem/evlog 保留 ---
  const NEW_SEED = '00112233445566778899aabbccddeeff';
  const seedStorage = createMemoryStorage();
  const seedRepo = openRepo(seedStorage, { seed_factory: () => NEW_SEED });
  const v2 = baseState();
  await seedRepo.saveState(v2, 0);
  await seedStorage.set('idem', JSON.stringify([idemRecord()]));
  await seedStorage.set('evlog', JSON.stringify([eventRecord()]));

  const reseed = await seedRepo.adminReset(CHARACTER_ID, { operation: 'reset_seed', now: FIXED_NOW });
  assert.equal(reseed.ok, true);
  assert.equal(reseed.state_version, 1);
  const reseeded = seedStorage.json('state');
  assert.equal(reseeded.random.master_seed_hex, NEW_SEED);
  assert.equal(reseeded.created_at, v2.created_at);
  assert.deepEqual(seedStorage.json('idem'), [idemRecord()], 'reset_seed 保留 idem');
  assert.ok(seedStorage.json('evlog').some((entry) => entry.event_type === 'admin_command'));
  assert.equal(seedStorage.json('meta').master_seed_id, sha256Hex(NEW_SEED).slice(0, 8));
  assert.equal(seedStorage.json('meta').tx_journal, null);

  // --- manual_cycle_correction 段：04 不依赖 05，业务计算由 prepare 注入 ---
  const manualStorage = createMemoryStorage();
  const manualRepo = openRepo(manualStorage);
  await manualRepo.saveState(baseState(), 0);
  await manualStorage.set('idem', JSON.stringify([idemRecord()]));
  const manualBefore = manualStorage.raw('state');

  await assert.rejects(
    () => manualRepo.adminReset(CHARACTER_ID, {
      operation: 'manual_cycle_correction',
      now: FIXED_NOW,
      payload: { anchor_at: '2026-11-01T00:00:00.000Z' }
    }),
    (err) => err.code === 'INVALID_REQUEST' && err.details.reason === 'prepare_required'
  );
  assert.equal(manualStorage.raw('state'), manualBefore, '缺 prepare 不得写任何键');

  const ANCHOR = '2026-11-01T00:00:00.000Z';
  const manualResult = await manualRepo.adminReset(CHARACTER_ID, {
    operation: 'manual_cycle_correction',
    now: FIXED_NOW,
    payload: { anchor_at: ANCHOR },
    prepare: (state) => ({ ...state, cycle: { ...state.cycle, anchor_at: ANCHOR, cycle_length_source: 'manual' } })
  });
  assert.equal(manualResult.ok, true);
  assert.equal(manualResult.state_version, 1);
  const corrected = manualStorage.json('state');
  assert.equal(corrected.cycle.anchor_at, ANCHOR);
  assert.equal(corrected.cycle.cycle_length_source, 'manual');
  assert.equal(corrected.updated_at, FIXED_NOW);
  assert.deepEqual(manualStorage.json('idem'), [idemRecord()], 'manual_cycle_correction 不清 idem');
  assert.ok(manualStorage.json('evlog').some((entry) => entry.event_type === 'admin_command'));

  // --- state_backup 逃生舱段：reset_state 放行并清备份，reset_seed 仍拒绝 ---
  const backupStorage = createMemoryStorage();
  const backupRepo = openRepo(backupStorage);
  await backupRepo.saveState(baseState(), 0);
  await backupStorage.set('meta', JSON.stringify({
    ...backupStorage.json('meta'),
    state_backup: { schema_version: 1, state: baseState(), created_at: FIXED_NOW },
    migration_failed_at: FIXED_NOW
  }));

  const escape = await backupRepo.adminReset(CHARACTER_ID, { operation: 'reset_state', now: FIXED_NOW });
  assert.equal(escape.ok, true, 'reset_state 是迁移失败后的逃生舱');
  assert.equal(escape.state_version, 1);
  const escapeMeta = backupStorage.json('meta');
  assert.equal(escapeMeta.state_backup, null, 'reset_state 必须清除备份');
  assert.ok(!('migration_failed_at' in escapeMeta), 'reset_state 清除 migration_failed_at');
  assert.ok(backupStorage.json('evlog').some((entry) => entry.event_type === 'admin_command'));

  const blockedStorage = createMemoryStorage();
  const blockedRepo = openRepo(blockedStorage, { seed_factory: () => NEW_SEED });
  await blockedRepo.saveState(baseState(), 0);
  await blockedStorage.set('meta', JSON.stringify({
    ...blockedStorage.json('meta'),
    state_backup: { schema_version: 1, state: baseState(), created_at: FIXED_NOW }
  }));
  const blocked = await blockedRepo.adminReset(CHARACTER_ID, { operation: 'reset_seed', now: FIXED_NOW });
  assert.deepEqual(blocked, {
    ok: false,
    code: 'STORAGE_FAILED',
    details: { reason: 'migration_backup_pending' }
  });
  assert.equal(blockedStorage.json('state').state_version, 0, '被拒绝时零写入');

  // --- prepare 返回非法状态：写盘前拒绝 ---
  const badStorage = createMemoryStorage();
  const badRepo = openRepo(badStorage);
  await badRepo.saveState(baseState(), 0);
  const badBefore = badStorage.raw('state');
  await assert.rejects(
    () => badRepo.adminReset(CHARACTER_ID, {
      operation: 'manual_cycle_correction',
      now: FIXED_NOW,
      payload: { anchor_at: ANCHOR },
      prepare: (state) => ({ ...state, cycle: { ...state.cycle, cycle_length_days: 50 } })
    }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  assert.equal(badStorage.raw('state'), badBefore, '非法状态必须在任何写盘之前拒绝');
  assert.equal(badStorage.json('meta').recovery_required, undefined);
});

test('S40 写第 3 个键后 abort → ABORTED 且回滚全部已写键', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const controller = new AbortController();
  const repo = createRepository({
    storage: wrapStorage(storage, (key) => {
      if (key === 'idem') controller.abort();
    }),
    character_id: CHARACTER_ID,
    clock: () => FIXED_NOW,
    id_factory: createIdFactory(),
    logger: createLogger()
  });
  const v0 = baseState();
  await repo.saveState(v0, 0);

  const stateBefore = storage.raw('state');
  const evlogBefore = storage.raw('evlog');
  const idemBefore = storage.raw('idem');

  await assert.rejects(
    () => repo.transaction(async (tx) => {
      const cur = await tx.getState(CHARACTER_ID);
      assert.equal(cur.version, 0);
      await tx.putState(bumped(cur.state), cur.version);
      await tx.appendEvent(eventRecord({ idempotency_key: 'idem_abort' }));
      await tx.appendIdempotency(idemRecord({ key: 'idem_abort' }));
      return { state_version: 1 };
    }, { signal: controller.signal }),
    (err) => err.code === 'ABORTED'
  );

  assert.equal(storage.raw('state'), stateBefore, 'state 必须回滚');
  assert.equal(storage.raw('evlog'), evlogBefore, 'evlog 必须回滚');
  assert.equal(storage.raw('idem'), idemBefore, 'idem 必须回滚');
  assert.equal(storage.json('state').state_version, 0, 'state_version 不变');
  assert.equal(storage.json('meta').tx_journal, null);
  assert.equal(storage.json('meta').rollback_state, null);
  assert.equal(storage.json('meta').recovery_required, undefined, '中止不得误记 recovery_required');
});

test('S40b W7 提交后 abort → 事务成功，不抛 ABORTED、不误伤', { skip: SKIP }, async () => {
  const storage = createMemoryStorage();
  const controller = new AbortController();
  const repo = createRepository({
    storage: wrapStorage(storage, (key, value) => {
      if (key !== 'meta' || typeof value !== 'string') return;
      const meta = JSON.parse(value);
      if (meta.tx_journal && meta.tx_journal.phase === 'committed') controller.abort();
    }),
    character_id: CHARACTER_ID,
    clock: () => FIXED_NOW,
    id_factory: createIdFactory(),
    logger: createLogger()
  });
  await repo.saveState(baseState(), 0);

  const result = await repo.transaction(async (tx) => {
    const cur = await tx.getState(CHARACTER_ID);
    await tx.putState(bumped(cur.state), cur.version);
    return { state_version: cur.version + 1 };
  }, { signal: controller.signal });

  assert.deepEqual(result, { state_version: 1 });
  assert.equal(storage.json('state').state_version, 1, '已提交事务不得被撤销');
  assert.equal(storage.json('meta').tx_journal, null, 'W8b 照常清理');
  assert.equal(storage.json('meta').rollback_state, null);
  assert.equal(storage.json('meta').recovery_required, undefined);
});
