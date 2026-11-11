/**
 * 02 §5.8：schema_version 迁移与 engine_version 兼容判定。
 *
 * 规则：
 * - 逐级执行，不允许跳级；
 * - 每个迁移函数 `(state) => newState` 必须幂等；
 * - 迁移后先 normalizeState 再 validateState；
 * - schema_version 缺失视为损坏（INTERNAL），不猜测。
 */

import { ENGINE_VERSION, SCHEMA_VERSION } from './constants.mjs';
import { normalizeState, validateState } from './models.mjs';

/**
 * 迁移注册表：键为"源版本"，值为把 n 升到 n+1 的步骤函数数组。
 * 未来引入 schema_version = 2 时，在此登记 MIGRATIONS[1] = [ ... ]。
 */
export const MIGRATIONS = {
  1: []
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function versionError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = code === 'STATE_VERSION_CONFLICT';
  if (details) err.details = details;
  return err;
}

function highestRegisteredVersion() {
  const keys = Object.keys(MIGRATIONS).map(Number).filter(Number.isInteger);
  return keys.length === 0 ? SCHEMA_VERSION : Math.max(SCHEMA_VERSION, ...keys.map((k) => k + 1));
}

/**
 * @param {object} state
 * @param {number} targetVersion 目标 schema_version
 */
export function migrate(state, targetVersion = SCHEMA_VERSION) {
  if (!state || typeof state !== 'object') {
    throw versionError('INTERNAL', 'state must be an object');
  }
  const current = state.schema_version;
  if (!Number.isInteger(current) || current < 1) {
    throw versionError('INTERNAL', 'schema_version is missing or invalid; state is corrupted');
  }
  if (current === targetVersion) {
    // 幂等：已处于目标版本时不重复执行迁移。
    return normalizeState(state);
  }
  if (current > SCHEMA_VERSION) {
    throw versionError('STATE_VERSION_CONFLICT', 'state schema is newer than this engine', {
      schema_version: current,
      supported: SCHEMA_VERSION
    });
  }
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw versionError('INTERNAL', 'targetVersion must be a positive integer', { targetVersion });
  }
  if (targetVersion > highestRegisteredVersion()) {
    throw versionError('INTERNAL', `no migration registered up to version ${targetVersion}`, {
      targetVersion,
      highest: highestRegisteredVersion()
    });
  }
  if (targetVersion < current) {
    throw versionError('STATE_VERSION_CONFLICT', 'downgrade migration is not supported', {
      schema_version: current,
      targetVersion
    });
  }

  let working = normalizeState(state);
  for (let version = current; version < targetVersion; version += 1) {
    const steps = MIGRATIONS[version];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw versionError('INTERNAL', `no migration step registered for ${version} -> ${version + 1}`, {
        from: version,
        to: version + 1
      });
    }
    for (const step of steps) {
      if (typeof step !== 'function') {
        throw versionError('INTERNAL', `migration step for ${version} must be a function`);
      }
      working = step(working);
      working = normalizeState({ ...working, schema_version: version + 1 });
      const check = validateState(working, { maxSchemaVersion: targetVersion });
      if (!check.ok) {
        throw versionError('INTERNAL', `migration ${version} -> ${version + 1} produced an invalid state`, {
          path: check.path,
          message: check.message
        });
      }
    }
  }
  return working;
}

/**
 * engine_version 兼容判定：主版本不同视为不兼容（需要升级/降级引擎）。
 * @returns {{ok:true, warning?:string}}
 */
export function assertCompatibleEngine(state, engineVersion = ENGINE_VERSION) {
  if (!state || typeof state !== 'object') {
    throw versionError('INTERNAL', 'state must be an object');
  }
  if (!Number.isInteger(state.schema_version) || state.schema_version < 1) {
    throw versionError('INTERNAL', 'schema_version is missing or invalid; state is corrupted');
  }
  if (state.schema_version > SCHEMA_VERSION) {
    throw versionError('STATE_VERSION_CONFLICT', 'state schema is newer than this engine', {
      schema_version: state.schema_version,
      supported: SCHEMA_VERSION
    });
  }
  const stateVersion = SEMVER_RE.exec(String(state.engine_version ?? ''));
  const runtimeVersion = SEMVER_RE.exec(String(engineVersion));
  if (!stateVersion) {
    throw versionError('INTERNAL', 'state.engine_version is not semver', {
      engine_version: state.engine_version
    });
  }
  if (!runtimeVersion) {
    throw versionError('INTERNAL', 'engineVersion is not semver', { engine_version: engineVersion });
  }
  if (Number(stateVersion[1]) > Number(runtimeVersion[1])) {
    throw versionError('STATE_VERSION_CONFLICT', 'state was written by a newer major engine version', {
      state_engine_version: state.engine_version,
      runtime_engine_version: engineVersion
    });
  }
  if (Number(stateVersion[1]) < Number(runtimeVersion[1])) {
    return { ok: true, warning: 'ENGINE_MAJOR_UPGRADE' };
  }
  return { ok: true };
}
