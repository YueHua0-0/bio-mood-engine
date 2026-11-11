/**
 * 13 §5.2 / §5.4 / §5.7 / §5.9：四个工具的实现。
 *
 * 边界：
 * - 所有状态读写经 04 的聊天作用域仓库；本文件不直接碰 `ctx.storage`。
 * - 入参校验失败不写任何键；任何内部失败映射为 DEGRADED，聊天继续。
 * - 不返回正文、原始账号、完整种子；`state_summary` 由 00 §12.4 的只读投影生成。
 */

import { createHash, randomBytes } from 'node:crypto';

import { toIso, parseTime } from '../../../../../lib/core/clock.mjs';
import { advance } from '../../../../../lib/core/coordinator.mjs';
import { createDefaultState, stateSummary } from '../../../../../lib/core/models.mjs';
import { RandomProvider, createMasterSeed } from '../../../../../lib/core/random.mjs';
import { MODULE_ORDER } from '../../../../../lib/core/constants.mjs';
import { behaviorModule } from '../../../../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../../../../lib/modules/cycle/index.mjs';
import { applyManualCorrection } from '../../../../../lib/modules/cycle/advance.mjs';
import { deliveryModule } from '../../../../../lib/modules/delivery/index.mjs';
import { eventModule, stressModule } from '../../../../../lib/modules/stress/index.mjs';
import { moodModule } from '../../../../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../../../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../../../../lib/modules/sleep/index.mjs';
import { normalizeEvent, buildEventFromMessage, eventLogRecord } from './events.mjs';
import { STATE_SEED_FIELD, normalizeConfig } from './manifest.mjs';
import { actorIdOf, chatIdOf, createBindingRepo, createChatRepo, readOnlySnapshot } from './repo.mjs';
import {
  degradedResult,
  errorToResult,
  isReadOnlyWarning,
  isStorageDegradeWarning
} from './degrade.mjs';
import { behaviorInputsFromState } from './hooks.mjs';

const MODULE_TABLE = Object.freeze({
  cycle: cycleModule,
  sleep: sleepModule,
  stress: stressModule,
  event: eventModule,
  regulation: regulationModule,
  mood: moodModule,
  behavior: behaviorModule,
  delivery: deliveryModule
});
const MODULES = Object.freeze(MODULE_ORDER.map((name) => MODULE_TABLE[name]));

const ADMIN_ACTIONS = Object.freeze([
  'bind_primary',
  'reset_state',
  'reset_seed',
  'manual_cycle_correction',
  'export_diagnostics'
]);
const ADMIN_FIELDS = Object.freeze(['action', 'confirm', 'anchor_at', 'cycle_length_days', 'now']);
const TICK_FIELDS = Object.freeze(['now', 'dry_run']);
const STATE_FIELDS = Object.freeze(['detailed']);
const ENGINE_BUDGET_MS = 5000;

function toolError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details !== undefined) err.details = details;
  return err;
}

function assertNoUnknown(params, allowed) {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw toolError('INVALID_REQUEST', 'unknown field', { unknown_fields: unknown });
  }
}

function disabledResult() {
  return degradedResult([], { details: { warnings: [], reason: 'disabled' } });
}

function engineConfigOf(state) {
  return { timezone: state.timezone };
}

function settingsOfRuntime(runtime) {
  // P-13-15：宿主每次调用都会注入最新 ctx（含 config()）；setup 时的快照会遮住设置页的保存结果，故优先读实时配置。
  if (runtime.ctx && typeof runtime.ctx.config === 'function') {
    return normalizeConfig(runtime.ctx.config()).settings;
  }
  if (runtime.settings) return runtime.settings;
  return normalizeConfig({}).settings;
}

function adminHashOf(actorId) {
  return createHash('sha256').update(String(actorId), 'utf8').digest('hex').slice(0, 12);
}

function authorize(settings, actorId, storedHashes = []) {
  if (!actorId) throw toolError('UNAUTHORIZED', 'admin actor is required');
  const hash = adminHashOf(actorId);
  // P-13-17：设置非空即以设置为准；留空则沿用落盘的上一次非空白名单（`meta.admin_hashes`）。
  const effective = settings.adminActorIds.length > 0 ? settings.adminActorIds : storedHashes;
  if (!effective.includes(hash)) {
    throw toolError('UNAUTHORIZED', 'actor is not in adminActorIds');
  }
  return hash;
}

/** P-13-17：读「上次非空管理员白名单」，供设置留空时沿用；读不到按空处理（fail-closed）。 */
async function storedAdminHashes({ repo }) {
  if (!repo || scopeFailure(repo)) return [];
  try {
    const meta = await repo.transaction(async (tx) => (await tx.get('meta')) ?? {});
    return Array.isArray(meta.admin_hashes) ? meta.admin_hashes : [];
  } catch {
    return [];
  }
}

function seedOf(settings) {
  return settings.masterSeedHex || createMasterSeed(randomBytes(16));
}

function initialState({ settings, now }) {
  return createDefaultState({
    character_id: settings.characterId,
    timezone: settings.timezone,
    now,
    [STATE_SEED_FIELD]: seedOf(settings),
    config: {}
  });
}

function providerOf(state) {
  return RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
}

function runAdvance(state, event, now, pending = []) {
  const started = Date.now();
  const result = advance({
    state,
    event,
    now,
    rngProvider: providerOf(state),
    config: engineConfigOf(state),
    modules: MODULES,
    queue: pending
  });
  // 02 §7 / 13 §5.2：引擎预算 5 s；同步实现只能事后判定，绝不带着超时结果提交。
  if (Date.now() - started > ENGINE_BUDGET_MS) {
    throw toolError('ABORTED', 'engine budget exceeded');
  }
  return result;
}

/**
 * 13 §5.9：进程内易失待交付队列。
 * 以 `ctx.storage` 为作用域隔离（同一进程内不同聊天、不同测试互不影响），不持久化。
 */
const PENDING_QUEUES = new WeakMap();

export function pendingQueue(ctx, settings) {
  const storage = ctx?.storage;
  if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) return [];
  let byKey = PENDING_QUEUES.get(storage);
  if (!byKey) {
    byKey = new Map();
    PENDING_QUEUES.set(storage, byKey);
  }
  const chatId = ctx.chat?.id ?? ctx.chatId ?? '';
  const key = `${settings.characterId}:${chatId}`;
  let queue = byKey.get(key);
  if (!queue) {
    queue = [];
    byKey.set(key, queue);
  }
  return queue;
}

/** 13 §5.9：队列项的会话标识与 11 读取时同源（`event.source.conversation_id` 优先）。 */
function conversationOf(event) {
  return event?.source?.conversation_id ?? event?.conversation_id ?? null;
}

/**
 * 13 §5.9 / P-13-07：队列项除 `{event_id, conversation_id, queued_at, merged_count}` 外，
 * 还必须带 11 §5.6 的过期判定时刻与 11 §5.7 的 `evlog` 最小字段。
 */
function queueItemOf(event, queuedAt, log) {
  return {
    event_id: event.event_id,
    conversation_id: conversationOf(event),
    queued_at: queuedAt,
    merged_count: 1,
    deliver_after: null,
    expires_at: null,
    event_type: log.event_type,
    source_key: log.source_key,
    intensity: log.intensity,
    occurred_at: log.occurred_at
  };
}

/** 13 §5.9「合并队列的消费规则」：判定顺序固定为先看 coalesced_into、再看 policy。 */
function applyQueueRules(queue, delivery, event, queuedAt, log) {
  if (!delivery) return;
  if (delivery.coalesced_into) {
    // 13 §5.9：折叠保留项，`merged_count = 旧值 + coalesced_into.merged_count - 1`。
    // 15 §4.2 E07 要求合并后同会话只剩 1 条保留项（唤醒后只交付 1 条），
    // 因此同会话的其它待交付项一并移出队列（见台账 C-13-01）。
    const keep = delivery.coalesced_into;
    const retained = queue.find((item) => item.event_id === keep.event_id) ?? null;
    const mergedCount = (retained?.merged_count ?? 1) + keep.merged_count - 1;
    const remaining = queue.filter((item) => item.conversation_id !== keep.conversation_id);
    queue.length = 0;
    queue.push(...remaining);
    // 保留项沿用原排队时刻与过期判定时刻；merged 后的 `delivery.expires_at` 已为 null，
    // 因此优先取原项（P-13-07）。
    queue.push({
      ...queueItemOf(event, retained?.queued_at ?? keep.earliest_queued_at, log),
      event_id: keep.event_id,
      conversation_id: keep.conversation_id,
      queued_at: retained?.queued_at ?? keep.earliest_queued_at,
      merged_count: mergedCount,
      deliver_after: retained?.deliver_after ?? null,
      expires_at: retained?.expires_at ?? null,
      event_type: retained?.event_type ?? log.event_type,
      source_key: retained?.source_key ?? log.source_key,
      intensity: retained?.intensity ?? log.intensity,
      occurred_at: retained?.occurred_at ?? log.occurred_at
    });
    return;
  }
  if (delivery.policy === 'queue_until_awake') {
    queue.push({
      ...queueItemOf(event, queuedAt, log),
      deliver_after: delivery.deliver_after ?? null,
      expires_at: delivery.expires_at ?? null
    });
    return;
  }
  // 其它策略（含 deliver_now / urgent_interrupt / silent_ignore）：本条已不在队列。
  const index = queue.findIndex((item) => item.event_id === event.event_id);
  if (index >= 0) queue.splice(index, 1);
}

/**
 * 13 §5.9 / 11 §5.6：入口清理过期排队项（P-13-07）。
 *
 * `now > expires_at` 的项移出队列，按 11 §5.6 改判 `silent_ignore` + `expired`，
 * 并按 11 §5.7 补写一条 `evlog`。只在 `observe` / `tick` 入口执行，不引入定时器。
 * 返回需要写入的 `evlog` 记录，由调用方在其事务内 `appendEvent`。
 */
export function purgeExpiredQueue(queue, now, characterId) {
  if (!Array.isArray(queue) || queue.length === 0) return [];
  const nowMs = parseTime(now, 'now');
  const expired = [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (!item || typeof item.expires_at !== 'string') continue;
    if (nowMs <= parseTime(item.expires_at, 'expires_at')) continue;
    queue.splice(index, 1);
    expired.push({
      // 原事件在入队当轮已写进 `evlog`，过期记录必须用独立 event_id 才能落盘（04 §5.4）。
      event_id: `exp_${createHash('sha256')
        .update(`${item.event_id}|${item.expires_at}`, 'utf8')
        .digest('hex')
        .slice(0, 16)}`,
      character_id: characterId,
      event_type: item.event_type,
      source_key: item.source_key,
      intensity: item.intensity,
      occurred_at: item.occurred_at,
      policy: 'silent_ignore',
      reason_codes: ['expired']
    });
  }
  return expired.reverse();
}

function deliveryOf(state) {
  return deliveryModule.update({
    inputs: {
      sleep: {
        state: state.sleep.state,
        sleepiness: state.sleep.sleepiness,
        sleep_debt: state.sleep.sleep_debt
      },
      event: null
    },
    now: state.updated_at
  }).state;
}

function behaviorOf(state) {
  return behaviorModule.update({ previous: null, inputs: behaviorInputsFromState(state) }).state;
}

function scopeFailure(repo) {
  if (!repo.readOnly) return null;
  return degradedResult(repo.warnings, {
    details: { warnings: [...repo.warnings], reason: 'readonly_scope' },
    cold_snapshot: null
  });
}

/**
 * P-13-13：降级时回显**脱敏后的生效配置**，用于实机排查「设置是否真的到达插件」。
 * 只暴露非敏感项与白名单条数，不回显哈希、种子、令牌。
 */
function configDebugOf(settings) {
  const ids = Array.isArray(settings.primaryChatIds) ? settings.primaryChatIds : [];
  return {
    enabled: settings.enabled,
    // P-13-20：v1 只回显唯一主会话；空字符串保留给 PRIMARY_UNBOUND 场景。
    primary_chat_id: ids[0] ?? (settings.primaryChatId || ''),
    primary_chat_count: ids.length > 0 ? 1 : 0,
    admin_ids: Array.isArray(settings.adminActorIds) ? settings.adminActorIds.length : 0,
    engine_mode: settings.engineMode,
    shadow_mode: settings.shadowMode
  };
}

/**
 * P-13-12：把模型能填的参数补成 `buildEventFromMessage` 需要的形状。
 * `sender_key` / `conversation_id` / `occurred_at` 全部来自 `ctx`，模型不必也无法伪造。
 */
function messageMetaOf(params, ctx, clock) {
  // 13 §5.3：occurred_at 优先取宿主 ctx.now，其次取注入时钟；两者都不由模型提供。
  const occurredAt =
    typeof ctx?.now === 'number' ? toIso(ctx.now) : typeof clock === 'function' ? clock() : toIso(Date.now());
  return {
    event_type: params.event_type,
    occurred_at: occurredAt,
    conversation_id: ctx?.chat?.id ?? '',
    sender_id: adminHashOf(ctx?.actor?.id ?? ''),
    text: params.text,
    is_mentioned: params.is_mentioned,
    is_direct_question: params.is_direct_question,
    relationship_tag: params.relationship_tag
  };
}

/**
 * 13 §5.2 / §5.4：事件摄入。
 * @param {object} params 见 §4.4
 * @param {{ctx?:object, signal?:AbortSignal}} runtime 仅测试或宿主内部使用
 */
export async function observe(params, runtime = {}) {
  const settings = settingsOfRuntime(runtime);
  const ctx = runtime.ctx ?? runtime.defaultCtx;
  let normalized;
  try {
    // P-13-12：模型只传明文 `text`，其余标识由插件从 ctx 派生；正文只参与一次哈希。
    normalized =
      typeof params?.text === 'string' && typeof params?.text_hash !== 'string'
        ? buildEventFromMessage(messageMetaOf(params, ctx, runtime.clock))
        : normalizeEvent(params);
  } catch (err) {
    return errorToResult(err);
  }

  if (!settings.enabled) return disabledResult();
  if (settings.engineMode !== 'embedded') {
    return degradedResult([], { details: { warnings: [], reason: 'remote_not_implemented' } });
  }

  const repo = createChatRepo({
    ctx,
    settings,
    clock: runtime.clock,
    logger: runtime.logger,
    migrations: runtime.migrations
  });
  const scope = scopeFailure(repo);
  if (scope) return scope;

  try {
    const queue = pendingQueue(ctx, settings);
    const logRecord = eventLogRecord(normalized.event, settings.characterId);
    const outcome = await repo.transaction(
      async (tx) => {
        const duplicate = await tx.getIdempotency(normalized.idempotency_key);
        if (duplicate) {
          return {
            duplicate: true,
            state_version: duplicate.state_version,
            processed_at: duplicate.processed_at,
            warnings: []
          };
        }

        let current = await tx.getState(settings.characterId);
        if (!current) {
          // 13 §5.2：首条事件负责初始化。04 的空库只接受 version 0，
          // 因此先把默认态落为 v0，再在同一事务里推进到 v1（见台账 P-13-04）。
          const init = initialState({ settings, now: normalized.event.occurred_at });
          const saved = await repo.saveState(init, 0);
          if (!saved.ok) throw toolError(saved.code ?? 'STORAGE_FAILED', 'state bootstrap failed');
          current = { state: init, version: 0 };
        }
        const state = current.state;
        // 13 §5.9 / 11 §5.6：入口先清理过期排队项，过期记录在同一事务内落 evlog（P-13-07）。
        for (const expired of purgeExpiredQueue(
          queue,
          normalized.event.occurred_at,
          settings.characterId
        )) {
          await tx.appendEvent(expired);
        }
        const result = runAdvance(state, normalized.event, normalized.event.occurred_at, queue);

        await tx.putState(result.state, state.state_version);
        await tx.appendEvent(logRecord);
        await tx.appendIdempotency({
          key: normalized.idempotency_key,
          event_id: normalized.event_id,
          result: {
            state_version: result.state.state_version,
            processed_at: result.state.updated_at
          }
        });

        // P-13-17：把「最近一次非空管理员白名单」落到 meta，供设置留空时沿用。
        // 只在设置非空且与落盘值不同时写，避免每条消息都多一次 meta 写入。
        if (settings.adminActorIds.length > 0) {
          const meta = (await tx.get('meta')) ?? {};
          const prev = Array.isArray(meta.admin_hashes) ? meta.admin_hashes : [];
          const changed =
            prev.length !== settings.adminActorIds.length ||
            prev.some((hash, index) => hash !== settings.adminActorIds[index]);
          if (changed) {
            meta.admin_hashes = [...settings.adminActorIds];
            await tx.putMeta(meta);
          }
        }

        return {
          duplicate: false,
          state: result.state,
          state_version: result.state.state_version,
          delivery: result.delivery,
          behavior_context: result.behavior_context,
          diagnostics: result.diagnostics,
          warnings: result.diagnostics?.warnings ?? []
        };
      },
      { signal: runtime.signal }
    );

    if (outcome.duplicate) {
      return {
        ok: true,
        character_id: settings.characterId,
        event_id: normalized.event_id,
        duplicate: true,
        state_version: outcome.state_version,
        processed_at: outcome.processed_at,
        state_summary: null,
        delivery: null,
        behavior_context: null
      };
    }

    const response = {
      ok: true,
      character_id: settings.characterId,
      event_id: normalized.event_id,
      duplicate: false,
      state_version: outcome.state_version,
      processed_at: outcome.state.updated_at,
      state_summary: stateSummary(outcome.state),
      delivery: outcome.delivery,
      behavior_context: outcome.behavior_context
    };
    // 13 §5.9：合并队列只在成功提交后更新；失败/降级不污染队列。
    applyQueueRules(queue, outcome.delivery, normalized.event, normalized.event.occurred_at, logRecord);
    if (settings.debugLogging) {
      response.diagnostics = {
        ...(outcome.diagnostics ?? {}),
        warnings: [...normalized.warnings, ...(outcome.diagnostics?.warnings ?? [])]
      };
    }
    return response;
  } catch (err) {
    return errorToResult(err, normalized.warnings);
  }
}

/**
 * 13 §5.2 / P12：只读状态；未绑定或非主聊天返回 DEGRADED + 冷快照（可能为 null）。
 */
export async function state(params = {}, runtime = {}) {
  try {
    assertNoUnknown(params, STATE_FIELDS);
    if (params.detailed !== undefined && params.detailed !== false) {
      throw toolError('INVALID_REQUEST', 'state only supports detailed=false', {
        path: 'detailed'
      });
    }
  } catch (err) {
    return errorToResult(err);
  }

  const settings = settingsOfRuntime(runtime);
  if (!settings.enabled) return disabledResult();

  const ctx = runtime.ctx ?? runtime.defaultCtx;
  const repo = createChatRepo({
    ctx,
    settings,
    clock: runtime.clock,
    logger: runtime.logger,
    migrations: runtime.migrations
  });
  const scope = scopeFailure(repo);
  if (scope) return { ...scope, details: { ...scope.details, config: configDebugOf(settings) } };

  try {
    const snapshot = await readOnlySnapshot(repo, settings.characterId);
    if (isReadOnlyWarning(snapshot.warnings) || isStorageDegradeWarning(snapshot.warnings)) {
      return degradedResult(snapshot.warnings, {
        details: { warnings: snapshot.warnings, reason: 'readonly_scope' }
      });
    }
    if (!snapshot.state) {
      return {
        ok: true,
        character_id: settings.characterId,
        state_version: 0,
        state_summary: null,
        delivery: null,
        behavior_context: null
      };
    }

    let delivery = null;
    let behavior = null;
    try {
      delivery = deliveryOf(snapshot.state);
      behavior = behaviorOf(snapshot.state);
    } catch (err) {
      return errorToResult(err, snapshot.warnings);
    }

    return {
      ok: true,
      character_id: settings.characterId,
      state_version: snapshot.state.state_version,
      state_summary: stateSummary(snapshot.state),
      delivery,
      behavior_context: behavior
    };
  } catch (err) {
    return errorToResult(err);
  }
}

/**
 * 13 §4.4 / §5.9：纯时间推进；dry_run 只算不写。
 */
export async function tick(params = {}, runtime = {}) {
  let now;
  let dryRun;
  try {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw toolError('INVALID_REQUEST', 'tick params must be an object', { path: 'params' });
    }
    assertNoUnknown(params, TICK_FIELDS);
    now = toIso(parseTime(params.now, 'now'));
    if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
      throw toolError('INVALID_REQUEST', 'dry_run must be a boolean', { path: 'dry_run' });
    }
    dryRun = params.dry_run === true;
  } catch (err) {
    return errorToResult(err);
  }

  const settings = settingsOfRuntime(runtime);
  const ctx = runtime.ctx ?? runtime.defaultCtx;
  const repo = createChatRepo({
    ctx,
    settings,
    clock: runtime.clock,
    logger: runtime.logger,
    migrations: runtime.migrations
  });
  const scope = scopeFailure(repo);
  if (scope) return scope;
  try {
    // P-13-17：设置留空时沿用落盘的上一次非空白名单，因此授权要等 repo 就绪后才能判定。
    authorize(settings, actorIdOf(ctx), settings.adminActorIds.length > 0 ? [] : await storedAdminHashes({ repo }));
  } catch (err) {
    return errorToResult(err);
  }
  if (!settings.enabled) return disabledResult();

  try {
    const outcome = await repo.transaction(
      async (tx) => {
        const current = await tx.getState(settings.characterId);
        if (!current) return { missing: true };
        const queue = pendingQueue(ctx, settings);
        if (!dryRun) {
          // 13 §5.9 / 11 §5.6：入口先清理过期排队项，过期记录落 evlog（P-13-07）。
          // `dry_run` 只算不写，因此不清理队列、不写 evlog。
          for (const expired of purgeExpiredQueue(queue, now, settings.characterId)) {
            await tx.appendEvent(expired);
          }
        }
        const result = runAdvance(current.state, null, now, queue);
        if (!dryRun) await tx.putState(result.state, current.state.state_version);
        return {
          missing: false,
          state_version: result.state.state_version,
          delivery: result.delivery
        };
      },
      { signal: runtime.signal }
    );

    if (outcome.missing) {
      return dryRun
        ? {
            ok: true,
            character_id: settings.characterId,
            state_version: 0,
            dry_run: true,
            delivery: null
          }
        : degradedResult([], { details: { warnings: [], reason: 'state_not_initialized' } });
    }

    return {
      ok: true,
      character_id: settings.characterId,
      state_version: outcome.state_version,
      dry_run: dryRun,
      delivery: outcome.delivery
    };
  } catch (err) {
    return errorToResult(err);
  }
}

async function prepareCycleCorrection(current, payload, now) {
  const anchorMs = Date.parse(payload.anchor_at);
  if (anchorMs > Date.parse(now)) {
    throw toolError('INVALID_REQUEST', 'anchor_at must not be later than now', {
      path: 'anchor_at'
    });
  }
  return {
    ...current,
    cycle: applyManualCorrection({
      cycle: current.cycle,
      now,
      manual_anchor_at: payload.anchor_at,
      manual_cycle_length_days: payload.cycle_length_days ?? null
    })
  };
}

async function exportDiagnostics(repo, settings) {
  const snapshot = await readOnlySnapshot(repo, settings.characterId);
  const events = await repo.listRecentEvents(settings.characterId, 20);
  return {
    ok: true,
    action: 'export_diagnostics',
    result: {
      state_summary: snapshot.state ? stateSummary(snapshot.state) : null,
      recent_events: (Array.isArray(events) ? events : []).map((entry) => ({
        event_id: entry.event_id,
        event_type: entry.event_type,
        source_key: entry.source_key,
        intensity: entry.intensity,
        occurred_at: entry.occurred_at
      }))
    }
  };
}

async function bindPrimary(ctx, settings, clock) {
  const chatId = chatIdOf(ctx);
  if (!chatId) {
    throw toolError('INVALID_REQUEST', 'current chat id is required', { path: 'chat_id' });
  }
  const repo = createBindingRepo({ ctx, settings, clock });
  const outcome = await repo.transaction(async (tx) => {
    const meta = (await tx.get('meta')) ?? {};
    if (meta.primary_chat_id) return { bound: false, primary_chat_id: meta.primary_chat_id };
    meta.primary_chat_id = chatId;
    await tx.putMeta(meta);
    return { bound: true, primary_chat_id: chatId };
  });
  return {
    ok: true,
    action: 'bind_primary',
    result: { primary_chat_id: outcome.primary_chat_id }
  };
}

/**
 * 13 §5.9：管理动作。授权失败不执行任何写操作。
 */
export async function admin(params = {}, runtime = {}) {
  let action;
  try {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw toolError('INVALID_REQUEST', 'admin params must be an object', { path: 'params' });
    }
    assertNoUnknown(params, ADMIN_FIELDS);
    action = params.action;
    if (!ADMIN_ACTIONS.includes(action)) {
      throw toolError('INVALID_REQUEST', 'unsupported admin action', { action: String(action) });
    }
  } catch (err) {
    return errorToResult(err);
  }

  const settings = settingsOfRuntime(runtime);
  const ctx = runtime.ctx ?? runtime.defaultCtx;
  const clock = runtime.clock ?? (() => toIso(Date.now()));
  const repo = createChatRepo({
    ctx,
    settings,
    clock,
    logger: runtime.logger,
    migrations: runtime.migrations
  });
  try {
    // P-13-17：设置留空时沿用落盘的上一次非空白名单。
    authorize(settings, actorIdOf(ctx), settings.adminActorIds.length > 0 ? [] : await storedAdminHashes({ repo }));
  } catch (err) {
    return errorToResult(err);
  }

  try {
    if (action === 'bind_primary') {
      return await bindPrimary(ctx, settings, clock);
    }

    const scope = scopeFailure(repo);
    if (scope) return scope;

    if (action === 'export_diagnostics') {
      return await exportDiagnostics(repo, settings);
    }

    if (action === 'manual_cycle_correction') {
      if (typeof params.anchor_at !== 'string') {
        throw toolError('INVALID_REQUEST', 'anchor_at is required', { path: 'anchor_at' });
      }
      if (
        params.cycle_length_days !== undefined &&
        (!Number.isInteger(params.cycle_length_days) ||
          params.cycle_length_days < 20 ||
          params.cycle_length_days > 45)
      ) {
        throw toolError('INVALID_REQUEST', 'cycle_length_days must be within [20,45]', {
          path: 'cycle_length_days'
        });
      }
      const now = toIso(parseTime(params.now, 'now'));
      const payload = { anchor_at: params.anchor_at };
      if (params.cycle_length_days !== undefined) payload.cycle_length_days = params.cycle_length_days;
      const result = await repo.adminReset(settings.characterId, {
        operation: action,
        payload,
        now,
        prepare: prepareCycleCorrection
      });
      return mapAdminResult(action, result, {
        cycle: {
          anchor_at: params.anchor_at,
          cycle_length_days: params.cycle_length_days ?? null,
          cycle_length_source: 'manual'
        }
      });
    }

    if (params.confirm !== true) {
      throw toolError('INVALID_REQUEST', 'reset requires confirm=true');
    }
    const now = toIso(parseTime(params.now, 'now'));
    const result = await repo.adminReset(settings.characterId, {
      operation: action,
      now
    });
    return mapAdminResult(action, result);
  } catch (err) {
    return errorToResult(err);
  }
}

function mapAdminResult(action, result, extraResult = {}) {
  if (result?.ok === true) {
    return {
      ok: true,
      action,
      result: { state_version: result.state_version, ...extraResult }
    };
  }
  return {
    ok: false,
    code: 'DEGRADED',
    action,
    result: {
      recovery_required: true,
      reason: result?.details?.reason ?? 'admin_reset_failed',
      ...extraResult
    },
    details: { warnings: [] }
  };
}

/**
 * 绑定宿主 ctx / 设置，返回四个工具。
 * `runtime.ctx` 可覆盖注册时的 ctx（宿主按聊天调用），`runtime.signal` 供中止测试。
 */
export function createTools({ ctx, settings, clock, logger, migrations = null }) {
  const base = { ctx, settings, clock, logger, migrations };
  return {
    observe: (params, runtime = {}) =>
      observe(params, { ...base, ...runtime, ctx: runtime.ctx ?? ctx, defaultCtx: ctx }),
    state: (params = {}, runtime = {}) =>
      state(params, { ...base, ...runtime, ctx: runtime.ctx ?? ctx, defaultCtx: ctx }),
    tick: (params = {}, runtime = {}) =>
      tick(params, { ...base, ...runtime, ctx: runtime.ctx ?? ctx, defaultCtx: ctx }),
    admin: (params = {}, runtime = {}) =>
      admin(params, { ...base, ...runtime, ctx: runtime.ctx ?? ctx, defaultCtx: ctx })
  };
}

export const TOOL_NAMES = Object.freeze(['observe', 'state', 'tick', 'admin']);

export default createTools;
