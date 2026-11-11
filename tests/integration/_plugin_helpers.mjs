/**
 * W5 插件测试夹具（下划线开头，不被 node --test 收集）。
 * 只装配宿主上下文与内存存储，不实现任何业务规则。
 */

import { createHash } from 'node:crypto';

import { createMemoryStorage } from '../helpers/repo.mjs';
import { setup } from '../../plugins/bio-mood-engine/index.mjs';

export const CHARACTER_ID = 'whale_character';
export const PRIMARY_CHAT = 'chat_primary';
export const OTHER_CHAT = 'chat_other';
export const ADMIN_ACTOR = 'admin_open_id_001';
export const FIXED_SEED = '0123456789abcdef0123456789abcdef';
export const T0 = '2026-11-09T09:00:00.000Z';

export function actorHash(actorId) {
  return createHash('sha256').update(actorId, 'utf8').digest('hex').slice(0, 12);
}

export function defaultConfig(overrides = {}) {
  return {
    enabled: true,
    primaryChatId: PRIMARY_CHAT,
    adminActorIds: [actorHash(ADMIN_ACTOR)],
    characterId: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    masterSeedHex: FIXED_SEED,
    behaviorContextMaxChars: 800,
    debugLogging: false,
    shadowMode: false,
    engineMode: 'embedded',
    engineRemoteUrl: '',
    engineRemoteToken: '',
    afterResponseMode: 'off',
    ...overrides
  };
}

export function makeCtx(overrides = {}) {
  const storage = overrides.storage ?? createMemoryStorage();
  const config = defaultConfig(overrides.config);
  const chatId = overrides.chatId ?? PRIMARY_CHAT;
  const actorId = overrides.actorId ?? ADMIN_ACTOR;
  const clock = overrides.clock ?? (() => T0);
  const logs = [];
  const logger = overrides.logger ?? {
    info: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry)
  };
  const ctx = {
    storage,
    config: () => config,
    chat: { id: chatId },
    actor: { id: actorId },
    clock,
    logger
  };
  return { ctx, storage, config, logs, logger, chatId, actorId, clock };
}

/**
 * 宿主契约（API v2，见 workspace 根 `WeChatAgent-plugin-api-v2.md` 与官方样例
 * `chat-notes-1.1.0` / `chat-archive`）：
 * - `registerTool({id, description, parameters, execute(ctx, args)})`，`execute` 只返回
 *   字符串或 `{content, isError}`；
 * - `registerHook(name, handler)`，handler 只有一个 `ctx` 参数。
 * 夹具按此形状装配，`tools.xxx(args, runtime)` 把 runtime 合并进宿主 ctx 并还原 JSON 结果。
 */
export function install(ctx) {
  const registered = {};
  const registeredHooks = {};
  const api = {
    apiVersion: 2,
    ctx,
    logger: ctx.logger,
    clock: ctx.clock,
    registerTool(tool) {
      if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string') {
        throw new TypeError('registerTool requires an object with a string id');
      }
      if (!tool.parameters || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object') {
        throw new TypeError(`tool ${tool.id} must declare an object parameters schema`);
      }
      if (typeof tool.execute !== 'function') {
        throw new TypeError(`tool ${tool.id} must declare execute(ctx, args)`);
      }
      registered[tool.id] = async (args = {}, runtime = {}) =>
        unwrapToolResult(await tool.execute({ ...ctx, ...runtime }, args));
    },
    registerHook(name, handler) {
      registeredHooks[name] = handler;
    }
  };
  const setupResult = setup(api);
  return { api, tools: registered, hooks: registeredHooks, settings: setupResult.settings };
}

/** 宿主只接受字符串或 `{content,isError}`；测试把 content 还原成工具结果对象。 */
function unwrapToolResult(result) {
  if (typeof result === 'string') return JSON.parse(result);
  if (result && typeof result.content === 'string') {
    try {
      return JSON.parse(result.content);
    } catch {
      return result.content;
    }
  }
  return result;
}

export function eventParams(overrides = {}) {
  return {
    event_type: 'mention',
    occurred_at: T0,
    conversation_id: PRIMARY_CHAT,
    sender_id: 'a1b2c3d4e5f6',
    relationship_tag: 'intimate',
    is_mentioned: true,
    is_direct_question: false,
    text_hash: 'b'.repeat(64),
    ...overrides
  };
}

