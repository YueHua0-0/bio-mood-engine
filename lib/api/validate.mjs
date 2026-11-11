/**
 * 12 §5.2 / §6.0 第 5–8 步：Content-Type、64 KiB 上限、JSON 解析与严格 schema 校验。
 *
 * 全部校验只做形状与枚举，不做业务计算（12 §2 非目标）。
 * 未知字段一律拒绝并给出点号路径；时间一律走 02 的 `parseTime`（INVALID_TIME）。
 */

import { parseTime } from '../core/clock.mjs';
import { EVENT_TYPES, RELATIONSHIP_TAGS } from '../modules/stress/event.mjs';
import { contractError } from './errors.mjs';

export const BODY_LIMIT_BYTES = 65536;

const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const RELATIONSHIP_TAG_SET = new Set(RELATIONSHIP_TAGS);
const ADMIN_OPERATIONS = new Set(['reset_state', 'reset_seed', 'manual_cycle_correction']);

const EVENT_KEYS = new Set([
  'api_version',
  'event_id',
  'idempotency_key',
  'character_id',
  'event_type',
  'occurred_at',
  'received_at',
  'source',
  'payload',
  'tags'
]);
const SOURCE_KEYS = new Set([
  'platform',
  'conversation_id',
  'conversation_kind',
  'sender_id',
  'is_mentioned',
  'relationship_tag'
]);
const EVENT_PAYLOAD_KEYS = new Set(['message_type', 'text_hash', 'text_summary', 'is_direct_question']);
const TICK_KEYS = new Set(['character_id', 'now', 'dry_run']);
const ADMIN_KEYS = new Set(['character_id', 'operation', 'now', 'payload']);
const CORRECTION_PAYLOAD_KEYS = new Set(['anchor_at', 'cycle_length_days']);

function invalid(message, details) {
  return contractError('INVALID_REQUEST', message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectUnknown(object, allowed, prefix, unknown) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) unknown.push(prefix === '' ? key : `${prefix}.${key}`);
  }
}

/** §6.0 第 5 步：只对带 body 的方法要求；`charset` 参数允许。 */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function asBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * §6.0 第 6 步：累计读取，超过上限立即停止读取（不读完全部再判）。
 * 超限时 pause 请求，由 handler 回 413 后关闭连接。
 */
export function readBody(req, limit = BODY_LIMIT_BYTES) {
  // P-12-04 ①：有 Content-Length 且已超限时，读 body 之前直接拒绝。
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(
      contractError('PAYLOAD_TOO_LARGE', `body exceeds ${limit} bytes`, { reason: 'body_too_large' })
    );
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = asBuffer(chunk);
      size += buffer.length;
      if (size > limit) {
        req.pause();
        finish(
          reject,
          contractError('PAYLOAD_TOO_LARGE', `body exceeds ${limit} bytes`, { reason: 'body_too_large' })
        );
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(reject, err));
    req.on('aborted', () =>
      finish(reject, contractError('INVALID_REQUEST', 'request aborted before the body completed'))
    );
  });
}

/** §6.0 第 7 步：JSON 解析失败 → INVALID_REQUEST。 */
export function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw invalid('request body must be a JSON object', { reason: 'body_required' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('request body is not valid JSON', { reason: 'invalid_json' });
  }
  if (!isPlainObject(parsed)) throw invalid('request body must be a JSON object', { reason: 'body_not_object' });
  return parsed;
}

function assertCharacterId(value, path) {
  if (typeof value !== 'string' || !CHARACTER_ID_RE.test(value)) {
    throw invalid(`${path} must match ^[a-z][a-z0-9_-]{0,63}$`, { path });
  }
  return value;
}

function assertEventId(value, path) {
  if (typeof value !== 'string' || !EVENT_ID_RE.test(value)) {
    throw invalid(`${path} must be 8–128 characters of [A-Za-z0-9_-]`, { path });
  }
  return value;
}

function assertOpaqueId(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw invalid(`${path} must be a 1–128 character string`, { path });
  }
  return value;
}

/** 00 §2.2：毫秒 + Z；02 的 `parseTime` 负责日历合法性与往返校验。 */
export function assertIsoTime(value, path) {
  try {
    return parseTime(value, path);
  } catch (err) {
    if (err?.code !== 'INVALID_TIME') throw err;
    throw contractError('INVALID_TIME', `${path} must be UTC ISO 8601 with milliseconds and Z`, { path });
  }
}

function requirePresent(object, key, path) {
  if (!(key in object) || object[key] === undefined) {
    throw invalid(`${path} is required`, { path });
  }
  return object[key];
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') throw invalid(`${path} must be a boolean`, { path });
  return value;
}

/** `GET /v1/state/{character_id}` 的路径参数。 */
export function validateCharacterIdParam(value) {
  return assertCharacterId(value, 'character_id');
}

/**
 * §6.0 第 8 步：`POST /v1/events` 的严格 schema。
 * @returns {{body: object, warnings: string[]}}
 */
export function validateEventBody(body) {
  const unknown = [];
  collectUnknown(body, EVENT_KEYS, '', unknown);
  if (unknown.length > 0) {
    throw invalid(`unknown field: ${unknown[0]}`, { unknown_fields: unknown });
  }

  const characterId = assertCharacterId(requirePresent(body, 'character_id', 'character_id'), 'character_id');
  const eventId = assertEventId(requirePresent(body, 'event_id', 'event_id'), 'event_id');
  const eventType = requirePresent(body, 'event_type', 'event_type');
  if (typeof eventType !== 'string' || !EVENT_TYPE_SET.has(eventType)) {
    throw invalid('event_type must be one of the 00 §2.3 values', {
      path: 'event_type',
      expected: [...EVENT_TYPE_SET]
    });
  }
  assertIsoTime(requirePresent(body, 'occurred_at', 'occurred_at'), 'occurred_at');
  assertIsoTime(requirePresent(body, 'received_at', 'received_at'), 'received_at');

  if ('idempotency_key' in body && body.idempotency_key !== undefined) {
    assertEventId(body.idempotency_key, 'idempotency_key');
  }
  if ('api_version' in body && body.api_version !== undefined && typeof body.api_version !== 'string') {
    throw invalid('api_version must be a string', { path: 'api_version' });
  }

  const source = requirePresent(body, 'source', 'source');
  if (!isPlainObject(source)) throw invalid('source must be an object', { path: 'source' });
  const sourceUnknown = [];
  collectUnknown(source, SOURCE_KEYS, 'source', sourceUnknown);
  if (sourceUnknown.length > 0) {
    throw invalid(`unknown field: ${sourceUnknown[0]}`, { unknown_fields: sourceUnknown });
  }
  const platform = requirePresent(source, 'platform', 'source.platform');
  if (typeof platform !== 'string' || platform.length === 0) {
    throw invalid('source.platform must be a non-empty string', { path: 'source.platform' });
  }
  const conversationId = assertOpaqueId(
    requirePresent(source, 'conversation_id', 'source.conversation_id'),
    'source.conversation_id'
  );
  assertOpaqueId(
    requirePresent(source, 'conversation_kind', 'source.conversation_kind'),
    'source.conversation_kind'
  );
  const senderId = assertOpaqueId(requirePresent(source, 'sender_id', 'source.sender_id'), 'source.sender_id');
  if ('is_mentioned' in source && source.is_mentioned !== undefined) {
    assertBoolean(source.is_mentioned, 'source.is_mentioned');
  }

  const warnings = [];
  let relationshipTag = source.relationship_tag;
  if (relationshipTag === undefined) {
    relationshipTag = 'unknown';
    warnings.push('UNKNOWN_RELATIONSHIP_TAG');
  } else if (typeof relationshipTag !== 'string' || !RELATIONSHIP_TAG_SET.has(relationshipTag)) {
    // 00 §2.4：未知标签按 unknown 处理，不得根据内容猜测。
    relationshipTag = 'unknown';
    warnings.push('UNKNOWN_RELATIONSHIP_TAG');
  }

  const payload = requirePresent(body, 'payload', 'payload');
  if (!isPlainObject(payload)) throw invalid('payload must be an object', { path: 'payload' });
  const payloadUnknown = [];
  collectUnknown(payload, EVENT_PAYLOAD_KEYS, 'payload', payloadUnknown);
  if (payloadUnknown.length > 0) {
    throw invalid(`unknown field: ${payloadUnknown[0]}`, { unknown_fields: payloadUnknown });
  }
  const messageType = requirePresent(payload, 'message_type', 'payload.message_type');
  if (typeof messageType !== 'string' || messageType.length === 0) {
    throw invalid('payload.message_type must be a non-empty string', { path: 'payload.message_type' });
  }
  if ('text_hash' in payload && payload.text_hash !== undefined && typeof payload.text_hash !== 'string') {
    throw invalid('payload.text_hash must be a string', { path: 'payload.text_hash' });
  }
  if ('text_summary' in payload && payload.text_summary !== undefined && typeof payload.text_summary !== 'string') {
    throw invalid('payload.text_summary must be a string', { path: 'payload.text_summary' });
  }
  if ('is_direct_question' in payload && payload.is_direct_question !== undefined) {
    assertBoolean(payload.is_direct_question, 'payload.is_direct_question');
  }

  if ('tags' in body && body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      throw invalid('tags must be an array of strings', { path: 'tags' });
    }
  }

  return {
    body: {
      ...body,
      character_id: characterId,
      event_id: eventId,
      event_type: eventType,
      source: { ...source, conversation_id: conversationId, sender_id: senderId, relationship_tag: relationshipTag }
    },
    warnings
  };
}

/** `POST /v1/tick`：`{character_id, now, dry_run?}`。 */
export function validateTickBody(body) {
  const unknown = [];
  collectUnknown(body, TICK_KEYS, '', unknown);
  if (unknown.length > 0) throw invalid(`unknown field: ${unknown[0]}`, { unknown_fields: unknown });

  const characterId = assertCharacterId(requirePresent(body, 'character_id', 'character_id'), 'character_id');
  assertIsoTime(requirePresent(body, 'now', 'now'), 'now');
  const dryRun = 'dry_run' in body && body.dry_run !== undefined ? assertBoolean(body.dry_run, 'dry_run') : false;
  return { body: { ...body, character_id: characterId, dry_run: dryRun }, warnings: [] };
}

/** `POST /v1/admin/reset`：`payload` 按 operation 分支校验（12 §5.8 P1-3）。 */
export function validateAdminResetBody(body) {
  const unknown = [];
  collectUnknown(body, ADMIN_KEYS, '', unknown);
  if (unknown.length > 0) throw invalid(`unknown field: ${unknown[0]}`, { unknown_fields: unknown });

  const characterId = assertCharacterId(requirePresent(body, 'character_id', 'character_id'), 'character_id');
  const operation = requirePresent(body, 'operation', 'operation');
  if (typeof operation !== 'string' || !ADMIN_OPERATIONS.has(operation)) {
    throw invalid('operation must be reset_state, reset_seed or manual_cycle_correction', {
      path: 'operation',
      expected: [...ADMIN_OPERATIONS]
    });
  }
  assertIsoTime(requirePresent(body, 'now', 'now'), 'now');

  const payload = body.payload;
  if (operation === 'manual_cycle_correction') {
    if (!isPlainObject(payload)) throw invalid('payload is required for manual_cycle_correction', { path: 'payload' });
    const payloadUnknown = [];
    collectUnknown(payload, CORRECTION_PAYLOAD_KEYS, 'payload', payloadUnknown);
    if (payloadUnknown.length > 0) {
      throw invalid(`unknown field: ${payloadUnknown[0]}`, { unknown_fields: payloadUnknown });
    }
    assertIsoTime(requirePresent(payload, 'anchor_at', 'payload.anchor_at'), 'payload.anchor_at');
    if (payload.cycle_length_days !== undefined) {
      const days = payload.cycle_length_days;
      if (!Number.isInteger(days) || days < 20 || days > 45) {
        throw invalid('payload.cycle_length_days must be an integer in [20,45]', {
          path: 'payload.cycle_length_days'
        });
      }
    }
  } else if (payload !== undefined) {
    if (!isPlainObject(payload)) throw invalid('payload must be an object', { path: 'payload' });
    const extra = Object.keys(payload);
    if (extra.length > 0) {
      throw invalid(`unknown field: payload.${extra[0]}`, {
        unknown_fields: extra.map((key) => `payload.${key}`)
      });
    }
  }

  return { body: { ...body, character_id: characterId }, warnings: [] };
}

export { EVENT_TYPES, RELATIONSHIP_TAGS };
