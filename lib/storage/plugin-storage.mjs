/**
 * 04 §4.3 / §5.5：聊天作用域的仓库适配器。
 *
 * `ctx.storage` 本身已按"账号 + 插件 + 聊天"隔离，本适配器负责两件事：
 * 1. 作用域判定：未配置 `primaryChatIds` → 全部写操作 `DEGRADED` + `PRIMARY_UNBOUND`；
 *    已配置但当前聊天不在数组中 → `DEGRADED` + `NON_PRIMARY_READONLY`，只读，不写任何键。
 * 2. 插件模式下的存储边界（04 §5.1 / §5.2）：
 *    - 键白名单：只允许 state / evlog / idem / meta / cfg，`history` 在插件模式被拒绝；
 *    - 单键硬上限：set 前按字节数校验，不额外读其他键（合计 84 KiB 由淘汰保证）；
 *    - 值归一：写一律 JSON 字符串，读把 null/undefined 统一成 null。
 */

import { createRepository } from './repository.mjs';

/** 04 §5.1 / 00 §11.5：插件模式允许的键与单键硬上限。 */
const KEY_CAP = {
  state: 8 * 1024,
  evlog: 16 * 1024,
  idem: 32 * 1024,
  meta: 24 * 1024,
  cfg: 4 * 1024
};
const KEY_WHITELIST = new Set(Object.keys(KEY_CAP));

/** raw storage + characterId + chatId → 同一个包装对象，保证仓库内的按角色锁仍然生效。 */
const GUARDED = new WeakMap();

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function degradeResult(warnings) {
  return { ok: false, code: 'DEGRADED', details: { warnings: [...warnings] } };
}

function degradeError(warnings) {
  const err = new Error('chat scope is read-only');
  err.code = 'DEGRADED';
  err.details = { warnings: [...warnings] };
  return err;
}

function createGuardedStorage(raw) {
  function assertKey(key) {
    if (!KEY_WHITELIST.has(key)) {
      throw contractError(
        'INVALID_REQUEST',
        `storage key is not allowed in plugin mode: ${String(key)}`,
        { key }
      );
    }
  }

  return {
    async get(key) {
      assertKey(key);
      const value = await raw.get(key);
      // 宿主 API 是 Promise<any>：缺失可能是 null 或 undefined，统一归一为 null。
      return value === null || value === undefined ? null : value;
    },
    async set(key, value) {
      assertKey(key);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > KEY_CAP[key]) {
        // state 用固定 reason（00 §11）；其余键不发明 reason，只带 key。
        const details = key === 'state' ? { reason: 'state_too_large' } : { key };
        throw contractError('STORAGE_FAILED', `${key} exceeds ${KEY_CAP[key]} bytes`, details);
      }
      await raw.set(key, serialized);
    },
    async delete(key) {
      assertKey(key);
      await raw.delete(key);
    }
  };
}

function guardedStorageFor(raw, characterId, chatId) {
  let byChat = GUARDED.get(raw);
  if (!byChat) {
    byChat = new Map();
    GUARDED.set(raw, byChat);
  }
  const cacheKey = `${characterId}:${chatId ?? ''}`;
  let guarded = byChat.get(cacheKey);
  if (!guarded) {
    guarded = createGuardedStorage(raw);
    byChat.set(cacheKey, guarded);
  }
  return guarded;
}

export function createChatScopedRepo(options = {}) {
  const {
    storage,
    characterId,
    chatId,
    // P-13-20：内部保留数组形状，但 v1 只有首项是有效主会话。
    primaryChatIds: rawPrimaryChatIds,
    // 旧调用方仍可能传 primaryChatId（单字符串），做兼容归一。
    primaryChatId: legacyPrimaryChatId,
    config = {},
    clock,
    logger,
    id_factory: idFactory,
    hooks,
    migrations
  } = options;

  const primaryChatIds = Array.isArray(rawPrimaryChatIds)
    ? rawPrimaryChatIds
    : (legacyPrimaryChatId ? [legacyPrimaryChatId] : []);

  const warnings = [];
  if (primaryChatIds.length === 0) warnings.push('PRIMARY_UNBOUND');
  else if (primaryChatIds[0] !== chatId) warnings.push('NON_PRIMARY_READONLY');

  if (warnings.length > 0) {
    return {
      readOnly: true,
      warnings: [...warnings],
      async loadState() {
        return null;
      },
      async saveState() {
        return degradeResult(warnings);
      },
      async findEventResult() {
        return null;
      },
      async listRecentEvents() {
        return [];
      },
      async appendEvent() {
        return { duplicate: false, dropped: true };
      },
      async transaction() {
        throw degradeError(warnings);
      }
    };
  }

  return createRepository({
    storage: guardedStorageFor(storage, characterId, chatId),
    character_id: characterId,
    clock,
    logger,
    id_factory: idFactory,
    hooks,
    migrations,
    chat_id: chatId,
    // v1 只登记唯一主会话；当前聊天已通过首项严格相等判定。
    primary_chat_id: primaryChatIds[0],
    // admin 操作的 source_key 是当前聊天；单主会话下它与唯一 primary 相同。
    admin_source_key: chatId ? `wechat:${chatId}:admin` : undefined,
    config
  });
}

export default createChatScopedRepo;
