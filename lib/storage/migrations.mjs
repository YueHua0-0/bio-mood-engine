/**
 * 04 §5.6：schema 迁移执行器。
 *
 * 迁移前把完整状态写入 `meta.state_backup`（00 §10.2.1 的唯一例外），
 * 成功即删；失败则回写原状态、保留备份并抛 `INTERNAL`，不猜测后续版本。
 */

import { createHash } from 'node:crypto';

import { ENGINE_VERSION } from '../core/constants.mjs';

/** 00 §10.2.1：`meta.state_backup` 是完整种子的唯一例外，上限 8 KiB。 */
const STATE_BACKUP_LIMIT_BYTES = 8 * 1024;

function migrationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function digestState(state) {
  const canonical = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(state), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 逐级应用迁移，直到 `migrations.target_version`。
 * @param {object} params
 * @param {object} params.state 当前状态
 * @param {object} params.meta 可变 meta 对象（就地更新）
 * @param {{target_version:number, steps:Record<number, Function[]>}} params.migrations
 * @param {{writeState: Function, writeMeta: Function}} params.store
 * @param {() => string} params.clock
 * @param {{warn: Function}} [params.logger]
 */
export async function applyMigrations({ state, meta, migrations, store, clock, logger }) {
  if (!migrations || typeof migrations.target_version !== 'number') return state;

  let current = state;
  // 04 §5.6：整条迁移链是一个事务，失败必须回到链开始前的状态（而不是只回退一步）。
  const originalState = clone(state);
  const originalMigrations = [...(meta.schema_migrations ?? [])];
  while (current.schema_version < migrations.target_version) {
    const from = current.schema_version;
    const to = from + 1;
    const steps = migrations.steps?.[from];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw migrationError('STATE_VERSION_CONFLICT', `no migration step from schema ${from}`);
    }

    const backupBytes = Buffer.byteLength(JSON.stringify(current), 'utf8');
    if (backupBytes > STATE_BACKUP_LIMIT_BYTES) {
      // 不能"备份写不进去就跳过备份继续迁移"：直接失败并保留原状态。
      logger?.warn?.({ code: 'MIGRATION_FAILED', from, to, reason: 'state_too_large' });
      const err = migrationError('STORAGE_FAILED', `state_backup exceeds 8 KiB (${backupBytes} bytes)`);
      // 00 §11：migration_failed 是迁移失败的固定 reason，比 INTERNAL 更可断言。
      err.details = { reason: 'migration_failed' };
      throw err;
    }

    meta.state_backup = {
      schema_version: from,
      state: clone(current),
      digest: digestState(current),
      created_at: clock()
    };
    await store.writeMeta(meta);

    try {
      let next = current;
      for (const step of steps) next = step(clone(next));
      next = { ...next, schema_version: to };
      await store.writeState(next);
      meta.schema_migrations = [
        ...(meta.schema_migrations ?? []),
        { from, to, applied_at: clock(), engine_version: ENGINE_VERSION }
      ];
      meta.state_backup = null;
      await store.writeMeta(meta);
      current = next;
    } catch (err) {
      meta.schema_migrations = originalMigrations;
      meta.state_backup = {
        schema_version: originalState.schema_version,
        state: clone(originalState),
        digest: digestState(originalState),
        created_at: clock()
      };
      // 04 §5.6：失败时保留备份并记录失败时刻，供 reset_state 逃生舱判定（P-14-04）。
      meta.migration_failed_at = clock();
      await store.writeState(originalState);
      await store.writeMeta(meta);
      logger?.warn?.({ code: 'MIGRATION_FAILED', from, to });
      throw migrationError('INTERNAL', `migration ${from}->${to} failed: ${err.message}`);
    }
  }
  return current;
}

export default applyMigrations;
