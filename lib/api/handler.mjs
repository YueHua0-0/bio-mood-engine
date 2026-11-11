/**
 * 12 §6.0：请求处理顺序（v1.7.12 定死，A06/A10 依赖）。
 *
 *   1. request_id = UUID            ← 最先；413/415 也必须有
 *   2. 令牌解析 + 常量时间比较       ← 401，不读 body
 *   3. 角色白名单（路径参数）        ← 403（POST 的 body.character_id 在解析后再查）
 *   4. 限流计数（鉴权后、校验前）    ← 429，不读 body
 *   5. Content-Type                 ← 415，不读 body
 *   6. body 累计 > 64 KiB           ← 413，立即停止读取
 *   7. JSON 解析                    ← 400
 *   8. schema 校验                  ← 400 / INVALID_TIME
 *   9. 路由到业务
 *
 * 第 9 步（W2）：
 * - `/v1/events`：幂等键解析 → 重复回放 → 02 的 `advance` → 04 单事务写 state/evlog/idem/meta。
 * - `/v1/tick`：纯时间推进；`dry_run` 只算不写。
 * - `/v1/state/{id}`：只读投影 `state_summary`。
 * - `/v1/admin/reset`：全部委托 04 的 `adminReset`（12 §5.8「唯一实现」）。
 * 本文件只做装配与契约映射，不含业务算法（12 §2 / §10）。
 */

import { randomUUID } from 'node:crypto';

import { parseTime } from '../core/clock.mjs';
import { ENGINE_VERSION, LIMITS, MODULE_ORDER, SCHEMA_VERSION } from '../core/constants.mjs';
import { advance } from '../core/coordinator.mjs';
import { stateSummary } from '../core/models.mjs';
import { RandomProvider } from '../core/random.mjs';
import { behaviorModule } from '../modules/behavior/index.mjs';
import { cycleModule } from '../modules/cycle/index.mjs';
import { deliveryModule } from '../modules/delivery/index.mjs';
import { moodModule } from '../modules/mood/index.mjs';
import { regulationModule } from '../modules/regulation/index.mjs';
import { sleepModule } from '../modules/sleep/index.mjs';
import { eventModule, stressModule } from '../modules/stress/index.mjs';
import { computeIntensity } from '../modules/stress/event.mjs';
import { constantTimeEqual, isCharacterAllowed, parseBearer, readAuthHeader, tokenFingerprint } from './auth.mjs';
import { contractError, successEnvelope, toErrorResponse } from './errors.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { BODY_ROUTES, PUBLIC_ROUTES, matchRoute, pathnameOf } from './router.mjs';
import {
  isJsonContentType,
  parseJsonBody,
  readBody,
  validateAdminResetBody,
  validateCharacterIdParam,
  validateEventBody,
  validateTickBody
} from './validate.mjs';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {} });
const LOG_OPTIONAL_FIELDS = [
  'character_id',
  'event_id',
  'state_version_before',
  'state_version_after',
  'policy',
  'error_code'
];

/** 00 §5.4 / 02 §4.3：8 个模块必须按固定顺序注册。 */
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

/** 12 §5.5：冲突最多重试 2 次（总计 3 次尝试）。 */
const RETRY_DELAYS_MS = Object.freeze([200, 600]);
const SNAPSHOT_LIMIT = 12;

function forbidden(message = 'token is not allowed for this character') {
  return contractError('FORBIDDEN_CHARACTER', message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientRequestIdOf(req) {
  const value = req.headers?.['x-request-id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sendJson(res, status, body, { close = false, headers: extra = {} } = {}) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    ...extra
  };
  if (close) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(text);
}

/**
 * `/health` 的存储探测：只调 `loadState({readOnly:true})`（不新增 `ping()` 契约）。
 * `state === null` 视为存储正常；只有读取抛错才是 degraded（A18）。
 */
async function probeStorage(repo) {
  try {
    await repo.loadState(undefined, { readOnly: true });
    return 'ok';
  } catch {
    return 'degraded';
  }
}

function versionData() {
  return { api_version: 'v1', engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION };
}

/** 07 §4.2 / 04 §6：evlog 的 `source_key` 形状（不含正文）。 */
function sourceKeyOf(event) {
  const conversation = event?.source?.conversation_id ?? event?.conversation_id ?? 'primary';
  if (event.event_type === 'long_silence') return `silence:${conversation}`;
  if (event.event_type === 'conflict' || event.event_type === 'admin_command') {
    return `wechat:${conversation}:*`;
  }
  return `wechat:${conversation}:${event?.source?.sender_id ?? 'unknown'}`;
}

/** 04 的 `loadState` 在部分替身里返回 `{state, warnings}`；这里统一成状态或 null。 */
function unwrapState(loaded) {
  if (loaded === null || loaded === undefined) return null;
  if (typeof loaded === 'object' && Object.hasOwn(loaded, 'state') && !Object.hasOwn(loaded, 'state_version')) {
    return loaded.state ?? null;
  }
  return loaded;
}

/** 02 §5.11：`character_id` 的 engine config 只需时区；其余走模块默认值。 */
function engineConfigOf(state) {
  return { timezone: state.timezone };
}

/**
 * 00 §5.3 / 02 §5.3（P-02-02）：入站事件时间规范化。
 * `occurred_at > received_at + 5 min` 时钳制到 `received_at`，并追加 `FUTURE_OCCURRED_AT`。
 * `effectiveNow()` 不参与——它只保证推进基准不回退，与事件时间钳制职责分离。
 */
function clampEventTime(body, warnings) {
  const receivedMs = parseTime(body.received_at, 'received_at');
  const occurredMs = parseTime(body.occurred_at, 'occurred_at');
  if (occurredMs <= receivedMs + LIMITS.clockToleranceMs) return body;
  warnings.push('FUTURE_OCCURRED_AT');
  return { ...body, occurred_at: body.received_at };
}

export function createHandler({
  repo,
  config = {},
  clock,
  idFactory,
  logger = NOOP_LOGGER
} = {}) {
  if (!repo) throw new Error('createHandler requires a repo');
  const time = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const newId = typeof idFactory === 'function' ? idFactory : () => randomUUID();
  const limiter = createRateLimiter({ clock: time });

  async function readState(characterId) {
    const loaded = await repo.loadState(characterId);
    return unwrapState(loaded);
  }

  async function readSnapshot(characterId, stateVersion) {
    if (typeof repo.transaction !== 'function') return null;
    try {
      return await repo.transaction(async (tx) => {
        const meta = await tx.get('meta');
        const list = Array.isArray(meta?.snapshots) ? meta.snapshots : [];
        const hit = list.find((entry) => entry.state_version === stateVersion);
        return hit?.summary ?? null;
      }, { characterId });
    } catch {
      return null;
    }
  }

  async function appendSnapshot(tx, summary) {
    const meta = (await tx.get('meta')) ?? {};
    const list = Array.isArray(meta.snapshots) ? meta.snapshots : [];
    meta.snapshots = [
      ...list.filter((entry) => entry.state_version !== summary.state_version),
      { state_version: summary.state_version, updated_at: summary.updated_at, summary }
    ].slice(-SNAPSHOT_LIMIT);
    if (typeof tx.putMeta === 'function') await tx.putMeta(meta);
    else await tx.put('meta', meta);
  }

  function duplicateData(characterId, key, hit, summary) {
    const data = {
      event_id: hit.event_id ?? key,
      character_id: characterId,
      state_version: hit.state_version,
      duplicate: true,
      processed_at: hit.processed_at,
      state_summary: summary ?? null,
      delivery: null,
      behavior_context: null
    };
    // 12 §5.4：`snapshot_evicted` 仅在 true 时出现，false 整键省略。
    if (summary === null) data.snapshot_evicted = true;
    return data;
  }

  /** 12 §5.4：`Idempotency-Key` 头 > `body.idempotency_key` > `body.event_id`。 */
  function resolveIdempotencyKey(req, body) {
    const header = req.headers?.['idempotency-key'];
    const headerKey = typeof header === 'string' && header.length > 0 ? header : undefined;
    const bodyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined;
    if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
      throw contractError('INVALID_REQUEST', 'Idempotency-Key does not match idempotency_key', {
        reason: 'idempotency_key_conflict'
      });
    }
    return headerKey ?? bodyKey ?? body.event_id;
  }

  function runAdvance(state, event, now) {
    const rngProvider = RandomProvider.fromPersisted({
      random: state.random,
      character_id: state.character_id
    });
    return advance({
      state,
      event,
      now,
      rngProvider,
      config: engineConfigOf(state),
      modules: MODULES
    });
  }

  /** 12 §5.5：乐观锁冲突时重读状态、重跑推进，最多 3 次尝试。 */
  async function withVersionRetry(run) {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (err) {
        if (err?.code !== 'STATE_VERSION_CONFLICT' || attempt >= RETRY_DELAYS_MS.length) throw err;
        await delay(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
      }
    }
  }

  async function handleEvent(req, body, warnings, record) {
    const characterId = body.character_id;
    const key = resolveIdempotencyKey(req, body);
    const processedAt = time();

    return withVersionRetry(async () => {
      // 幂等：重复请求返回首次 state_version / processed_at，不重新计算。
      if (typeof repo.findEventResult === 'function') {
        const hit = await repo.findEventResult(characterId, key);
        if (hit) {
          const summary = await readSnapshot(characterId, hit.state_version);
          record.state_version_after = hit.state_version;
          return duplicateData(characterId, key, hit, summary);
        }
      }

      const state = await readState(characterId);
      if (state === null) throw contractError('NOT_FOUND', 'character state not found', { character_id: characterId });
      record.state_version_before = state.state_version;

      const out = runAdvance(state, body, body.received_at);
      const summary = stateSummary(out.state);
      const eventRecord = {
        event_id: body.event_id,
        character_id: characterId,
        event_type: body.event_type,
        source_key: sourceKeyOf(body),
        intensity: computeIntensity(body),
        occurred_at: body.occurred_at
      };

      await repo.transaction(async (tx) => {
        await tx.putState(out.state, state.state_version);
        await tx.appendEvent(eventRecord);
        await tx.appendIdempotency({
          key,
          event_id: body.event_id,
          processed_at: processedAt,
          result: { state_version: out.state.state_version, processed_at: processedAt }
        });
        await appendSnapshot(tx, summary);
      }, { characterId });

      record.state_version_after = out.state.state_version;
      record.policy = out.delivery?.policy;

      return {
        event_id: body.event_id,
        character_id: characterId,
        state_version: out.state.state_version,
        duplicate: false,
        processed_at: processedAt,
        state_summary: summary,
        delivery: out.delivery,
        behavior_context: out.behavior_context,
        diagnostics: {
          ...out.diagnostics,
          warnings: [...new Set([...(out.diagnostics?.warnings ?? []), ...warnings])]
        }
      };
    });
  }

  async function handleTick(body, record) {
    const characterId = body.character_id;
    return withVersionRetry(async () => {
      const state = await readState(characterId);
      if (state === null) {
        // 12 §5.7 / A14：`cur === null → 0`；没有状态时 dry_run 只回版本号，不写任何键。
        if (body.dry_run === true) return { state_version: 0, dry_run: true, delivery: null };
        throw contractError('NOT_FOUND', 'character state not found', { character_id: characterId });
      }
      record.state_version_before = state.state_version;

      const out = runAdvance(state, null, body.now);
      const summary = stateSummary(out.state);
      record.policy = out.delivery?.policy;

      if (body.dry_run === true) {
        // 12 §5.7：只算不写；版本为"若保存将得到"的值。
        return { state_version: state.state_version + 1, dry_run: true, delivery: out.delivery };
      }

      await repo.transaction(async (tx) => {
        await tx.putState(out.state, state.state_version);
        await appendSnapshot(tx, summary);
      }, { characterId });

      record.state_version_after = out.state.state_version;
      return {
        state_version: out.state.state_version,
        dry_run: false,
        delivery: out.delivery,
        state_summary: summary,
        diagnostics: out.diagnostics
      };
    });
  }

  async function handleGetState(characterId) {
    const state = await readState(characterId);
    if (state === null) throw contractError('NOT_FOUND', 'character state not found', { character_id: characterId });
    return {
      state_summary: stateSummary(state),
      state_version: state.state_version,
      updated_at: state.updated_at
    };
  }

  /** 12 §5.8 / 13 §5.9：`manual_cycle_correction` 的 prepare 回调，调用 05 的人工校正。 */
  async function prepareCycleCorrection(current, payload, now) {
    const anchorMs = Date.parse(payload.anchor_at);
    if (anchorMs > Date.parse(now)) {
      throw contractError('INVALID_REQUEST', 'payload.anchor_at must not be later than now', {
        path: 'payload.anchor_at'
      });
    }
    const rngProvider = RandomProvider.fromPersisted({
      random: current.random,
      character_id: current.character_id
    });
    const result = cycleModule.update({
      previous: current.cycle,
      inputs: {
        manual_anchor_at: payload.anchor_at,
        manual_cycle_length_days: payload.cycle_length_days
      },
      now,
      rng: rngProvider.stream(`cycle:${current.cycle.cycle_index}`),
      config: engineConfigOf(current)
    });
    return { ...current, cycle: result.state };
  }

  async function handleAdminReset(body, requestId, record) {
    const characterId = body.character_id;
    const result = await repo.adminReset(characterId, {
      operation: body.operation,
      payload: body.payload,
      now: body.now,
      prepare: body.operation === 'manual_cycle_correction' ? prepareCycleCorrection : undefined
    });
    if (!result || result.ok !== true) {
      const details = { ...(result?.details ?? {}) };
      throw contractError(result?.code ?? 'INTERNAL', 'admin reset failed', details);
    }
    record.state_version_after = result.state_version;
    // 12 §5.8：应用审计日志只写操作类型与时间，不含状态、种子或数值。
    logger.info?.({ ts: time(), level: 'info', audit: 'admin_reset', operation: result.operation, at: result.accepted_at, character_id: characterId, request_id: requestId });
    return { operation: result.operation, accepted_at: result.accepted_at, state_version: result.state_version };
  }

  async function dispatch(req, requestId, record) {
    // 2. 鉴权：管理端点只与管理员令牌比较，失败不区分原因。
    const route = matchRoute(req.method, record.path);
    const expected = route?.name === 'admin_reset' ? config.adminToken : config.businessToken;
    const presented = parseBearer(readAuthHeader(req.headers));
    if (!presented || !expected || !constantTimeEqual(presented, expected)) {
      throw contractError('UNAUTHORIZED', 'missing or invalid credentials');
    }

    // 3. 角色白名单：路径里带 character_id 的端点此刻就能判定；空名单 fail-closed。
    if (route && !PUBLIC_ROUTES.has(route.name)) {
      if (!Array.isArray(config.allowedCharacterIds) || config.allowedCharacterIds.length === 0) {
        throw forbidden('no characters are allowed for this token');
      }
      if (route.params.characterId !== undefined) {
        const characterId = validateCharacterIdParam(route.params.characterId);
        if (!isCharacterAllowed(config.allowedCharacterIds, characterId)) throw forbidden();
        record.character_id = characterId;
      }
    }

    // 4. 限流：鉴权后、校验前；/health 与 /version 不计入。
    if (route && !PUBLIC_ROUTES.has(route.name)) {
      const scope = route.name === 'events' ? 'events' : 'other';
      const result = limiter.consume(scope, tokenFingerprint(presented));
      if (!result.allowed) {
        throw contractError('RATE_LIMITED', 'rate limit exceeded', {
          retry_after_seconds: result.retry_after_seconds
        });
      }
    }

    // 未注册路径：鉴权通过后 404（不暴露"有哪些路径"）。
    if (!route) throw contractError('NOT_FOUND', 'route not found', { path: record.path });

    // 5–8. Content-Type → 64 KiB → JSON → schema
    let parsedBody = null;
    let warnings = [];
    if (BODY_ROUTES.has(route.name)) {
      if (!isJsonContentType(req.headers['content-type'])) {
        throw contractError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', {
          expected: 'application/json'
        });
      }
      const text = await readBody(req);
      const parsed = parseJsonBody(text);
      let result;
      if (route.name === 'events') result = validateEventBody(parsed);
      else if (route.name === 'tick') result = validateTickBody(parsed);
      else result = validateAdminResetBody(parsed);

      record.character_id = result.body.character_id;
      if (result.body.event_id !== undefined) record.event_id = result.body.event_id;
      warnings = result.warnings ?? [];
      // 00 §5.3（P-02-02）：钳制发生在入站入口，先于幂等判定与推进；
      // `runAdvance` 与 `evlog` 都使用钳制后的 `occurred_at`。
      parsedBody = route.name === 'events' ? clampEventTime(result.body, warnings) : result.body;

      // POST 的 character_id 在 body 里，只能在解析后校验（§6.0 第 3 步的补充）。
      if (!isCharacterAllowed(config.allowedCharacterIds, result.body.character_id)) throw forbidden();
    }

    // 9. 业务分发
    if (route.name === 'health') return { status: 'ok', storage: await probeStorage(repo) };
    if (route.name === 'version') return versionData();
    if (route.name === 'events') return handleEvent(req, parsedBody, warnings, record);
    if (route.name === 'tick') return handleTick(parsedBody, record);
    if (route.name === 'state') return handleGetState(record.character_id);
    if (route.name === 'admin_reset') return handleAdminReset(parsedBody, requestId, record);
    throw contractError('INTERNAL', 'endpoint not implemented');
  }

  return async function handler(req, res) {
    const startedAt = Date.now();
    const requestId = newId();
    const record = {
      request_id: requestId,
      method: req.method,
      path: pathnameOf(req.url),
      status: 200
    };

    try {
      const data = await dispatch(req, requestId, record);
      if (!res.writableEnded) sendJson(res, 200, successEnvelope(requestId, data));
    } catch (err) {
      const { status, body } = toErrorResponse(err, requestId, {
        logger,
        clientRequestId: clientRequestIdOf(req)
      });
      record.status = status;
      record.error_code = body.error.code;
      if (!res.writableEnded) {
        // 429 必须回 `Retry-After`，值与 details.retry_after_seconds 同值（12 §5.3）。
        const extra = {};
        if (status === 429 && body.error.details.retry_after_seconds !== undefined) {
          extra['Retry-After'] = String(body.error.details.retry_after_seconds);
        }
        // 413/415 时 body 未被消费：回包后关闭连接，避免 keep-alive 串流。
        sendJson(res, status, body, {
          close: status === 413 || status === 415,
          headers: extra
        });
        // P-12-04 ③：客户端未及时断开时兜底销毁 socket，防止连接泄漏。
        // unref 让定时器不阻止进程退出；正常 close 时立即取消。
        if (status === 413 || status === 415) {
          const timer = setTimeout(() => {
            if (!req.socket.destroyed) req.socket.destroy();
          }, 2000);
          timer.unref?.();
          res.on('close', () => clearTimeout(timer));
        }
      }
    } finally {
      const entry = {
        ts: time(),
        level: 'info',
        request_id: requestId,
        method: req.method,
        path: record.path,
        status: record.status,
        duration_ms: Date.now() - startedAt
      };
      for (const key of LOG_OPTIONAL_FIELDS) {
        if (record[key] !== undefined) entry[key] = record[key];
      }
      logger.info?.(entry);
    }
  };
}
