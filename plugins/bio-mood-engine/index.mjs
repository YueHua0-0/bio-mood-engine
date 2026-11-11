/**
 * 13 §4.1 / §5.1：WeChatAgent 插件唯一入口。
 *
 * `setup(api)` 必须同步、≤2 s、零网络/零存储/零定时器：只做配置规范化与工具注册。
 */

import { toIso } from '../../lib/core/clock.mjs';
import { normalizeConfig, collectToolSchemaErrors } from './lib/adapter/wechatagent/manifest.mjs';
import { createTools } from './lib/adapter/wechatagent/tools.mjs';
import {
  beforeContextHook,
  afterResponseHook,
  FICTION_DISCLAIMER
} from './lib/adapter/wechatagent/hooks.mjs';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

/** 13 §5.1：宿主可能把 ctx 挂在 api 上，也可能直接把 api 当 ctx。 */
function resolveCtx(api) {
  const ctx = api?.ctx ?? api ?? {};
  return {
    storage: ctx.storage,
    config: typeof ctx.config === 'function' ? ctx.config : () => ({}),
    chat: ctx.chat ?? (ctx.chatId ? { id: ctx.chatId } : undefined),
    actor: ctx.actor ?? (ctx.actorId ? { id: ctx.actorId } : undefined),
    now: ctx.now,
    clock: ctx.clock,
    logger: ctx.logger
  };
}

let activeCtx = null;

/**
 * 13 §4.1：宿主以**单个 ctx** 调钩子（`ctx.message` / `ctx.text`）；
 * 只有内部测试才会传 `(input, ctx)`。这里区分「宿主 ctx」与「测试入参」。
 */
function hookCtxOf(input, ctx) {
  if (ctx) return ctx;
  if (input && (typeof input.config === 'function' || input.storage)) return input;
  return activeCtx ?? {};
}

/**
 * @param {object} api 宿主 API v2：`registerTool({id,description,parameters,execute})`、`ctx.*`。
 */
export function setup(api = {}) {
  if (!api || typeof api !== 'object') throw new TypeError('setup(api) requires a host api object');
  if (api.apiVersion !== undefined && String(api.apiVersion) !== '2') {
    const err = new Error('unsupported plugin apiVersion');
    err.code = 'PLUGIN_MANIFEST_INVALID';
    err.details = { field: 'apiVersion', got: String(api.apiVersion) };
    throw err;
  }

  const ctx = resolveCtx(api);
  activeCtx = ctx;
  const { settings, warnings, errors } = normalizeConfig(ctx.config());
  const logger = api.logger ?? ctx.logger ?? NOOP_LOGGER;
  // 宿主 ctx.now 是本次调用开始的毫秒时间；缺失时才退回墙钟（P-13-10）。
  const clock = api.clock ?? ctx.clock ?? (() => toIso(api.now ?? ctx.now ?? Date.now()));
  if (warnings.length > 0) logger.warn({ code: 'FASTCFG_INVALID', warnings: [...warnings], errors: [...errors] });
  const tools = createTools({ ctx, settings, clock, logger });

  // P-13-14 / P-13-18：工具与页面 action 参数用同一套受限子集，越界就在这里失败。
  const schemaErrors = collectToolSchemaErrors([...TOOL_DEFINITIONS, ...ACTION_DEFINITIONS]);
  if (schemaErrors.length > 0) {
    const err = new Error('tool parameters violate the host schema subset');
    err.code = 'PLUGIN_TOOL_SCHEMA_INVALID';
    err.details = { errors: schemaErrors };
    throw err;
  }

  if (typeof api.registerTool === 'function') {
    for (const def of TOOL_DEFINITIONS) {
      api.registerTool({
        ...def,
        async execute(runtime = {}, args = {}) {
          const result = await tools[def.id](args, {
            ctx: runtime,
            clock: runtime.clock ?? clock,
            signal: runtime.signal
          });
          // 宿主只接受字符串或 {content,isError}：工具结果统一序列化为 content。
          return { content: JSON.stringify(result) };
        }
      });
    }
  }
  if (typeof api.registerAction === 'function') {
    api.registerAction({
      ...ACTION_DEFINITIONS[0],
      async execute(actionCtx = {}) {
        return tools.state({}, {
          ctx: actionCtx,
          clock: actionCtx.clock ?? clock,
          signal: actionCtx.signal
        });
      }
    });
  }
  if (typeof api.registerHook === 'function') {
    api.registerHook('before-context', (hookCtx) =>
      beforeContextHook(hookCtx?.message ?? {}, hookCtxOf(hookCtx, null))
    );
    api.registerHook('after-response', (hookCtx) =>
      afterResponseHook(hookCtx ?? {}, hookCtxOf(hookCtx, null))
    );
  }

  return { settings, warnings, tools };
}

/**
 * 13 §5.3：四个模型工具。宿主用对象式 `registerTool({id, description, parameters, execute})`，
 * `parameters` 必须是受限子集内的 object Schema（P-13-10）。
 */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    id: 'observe',
    description: '记录一条真实聊天事件并推进角色状态；只在用户发言后调用，用户刚说的那句原文放进 text。',
    parameters: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: [
            'group_message',
            'mention',
            'important_person_appear',
            'comfort_received',
            'conflict',
            'long_silence',
            'direct_question',
            'admin_command',
            'system_event'
          ]
        },
        text: { type: 'string', minLength: 1, maxLength: 1000, description: '用户刚发言的原文；插件内哈希后立即丢弃' },
        relationship_tag: {
          type: 'string',
          enum: ['ordinary', 'important', 'intimate', 'conflict', 'admin', 'unknown']
        },
        is_mentioned: { type: 'boolean' },
        is_direct_question: { type: 'boolean' }
      },
      required: ['event_type', 'text'],
      additionalProperties: false
    }
  },
  {
    id: 'state',
    description: '读取当前角色的状态摘要（只读，不推进时间、不写盘）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    id: 'tick',
    description: '按给定时间推进角色状态；dry_run 为 true 时只计算不写盘。',
    parameters: {
      type: 'object',
      properties: {
        now: { type: 'string', minLength: 24, maxLength: 24 },
        dry_run: { type: 'boolean' }
      },
      required: ['now'],
      additionalProperties: false
    }
  },
  {
    id: 'admin',
    description: '管理员动作（重置、手动校正、导出诊断等），仅白名单哈希可调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['bind_primary', 'reset_state', 'reset_seed', 'manual_cycle_correction', 'export_diagnostics']
        },
        confirm: { type: 'boolean' },
        anchor_at: { type: 'string', maxLength: 32 },
        cycle_length_days: { type: 'integer', minimum: 20, maximum: 45 },
        now: { type: 'string', minLength: 24, maxLength: 24 }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
]);

/**
 * P-13-18：插件页面 action。页面 ctx 没有 `actor.id`，因此这里只暴露只读状态，
 * 不提供 `tick` / `admin` 这类需要管理员授权的操作。
 */
export const ACTION_DEFINITIONS = Object.freeze([
  {
    id: 'read-state',
    description: '插件页面读取当前角色状态摘要（只读，不推进时间、不写盘）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
]);

/**
 * 13 §4.1：模块级 hooks。宿主以单个 `ctx` 调用（`ctx.message` / `ctx.text`），
 * 因此这里同时兼容「宿主单参」与「内部 (input, ctx)」两种调用（P-13-10）。
 */
export const hooks = Object.freeze({
  'before-context': (input = {}, ctx) =>
    beforeContextHook(input?.message ?? input, hookCtxOf(input, ctx)),
  'after-response': (input = {}, ctx) => afterResponseHook(input, hookCtxOf(input, ctx))
});

export { FICTION_DISCLAIMER };

export default { setup, hooks };
