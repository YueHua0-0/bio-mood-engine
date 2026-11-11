/**
 * 13 §5.2 / §5.4：聊天作用域仓库的装配与只读快照。
 *
 * 适配层不直接调用 `ctx.storage.get/set`，所有键访问都经 `createChatScopedRepo`。
 */

import { createChatScopedRepo } from '../../../../../lib/storage/plugin-storage.mjs';

/** 13 §2.1：vp 里 chat id 与 actor id 的字段名可能不同，集中归一。 */
export function chatIdOf(ctx) {
  return ctx?.chat?.id ?? ctx?.chatId ?? '';
}

export function actorIdOf(ctx) {
  return ctx?.actor?.id ?? ctx?.actorId ?? '';
}

/**
 * @returns repo；未绑定 primary 或非主聊天时为 `readOnly:true` 的降级桩。
 */
export function createChatRepo({ ctx, settings, clock, logger, migrations = null }) {
  return createChatScopedRepo({
    storage: ctx.storage,
    characterId: settings.characterId,
    chatId: chatIdOf(ctx),
    // P-13-19：多主会话共享引擎，settings.primaryChatIds 由 normalizeConfig 产出。
    primaryChatIds: settings.primaryChatIds,
    primaryChatId: settings.primaryChatId,
    config: { timezone: settings.timezone },
    clock,
    logger,
    migrations
  });
}

/**
 * 仅 `bind_primary` 使用：把 primary 视作当前聊天以获得 meta 写权限。
 * 不得用于状态初始化，因此调用方只允许写 meta。
 */
export function createBindingRepo({ ctx, settings, clock, logger }) {
  const chatId = chatIdOf(ctx);
  return createChatScopedRepo({
    storage: ctx.storage,
    characterId: settings.characterId,
    chatId,
    // bind_primary 是 bootstrap 兜底，把当前聊天临时当作唯一 primary。
    primaryChatIds: [chatId],
    primaryChatId: chatId,
    config: { timezone: settings.timezone },
    clock,
    logger
  });
}

/**
 * 13 §5.2 第 03 步：只读快照；永不写盘、永不推进。
 * @returns {{state:object|null, warnings:string[]}}
 */
export async function readOnlySnapshot(repo, characterId) {
  const result = await repo.loadState(characterId, { readOnly: true });
  if (result === null || typeof result !== 'object') {
    return { state: null, warnings: [] };
  }
  return {
    state: result.state ?? null,
    warnings: Array.isArray(result.warnings) ? [...result.warnings] : []
  };
}
