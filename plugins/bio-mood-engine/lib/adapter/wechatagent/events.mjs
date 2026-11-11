/**
 * 13 §5.3：把微信消息压缩成不含正文的标准事件。
 *
 * 正文只在内存中参与一次 SHA-256；本模块不缓存、不落库、不写日志。
 * 所有外部文本都视为不可信数据：这里不解析、不执行、不拼接任何提示词。
 */

import { createHash } from 'node:crypto';

import { parseTime, toIso } from '../../../../../lib/core/clock.mjs';
import { isEventType, RELATIONSHIP_TAGS, computeIntensity } from '../../../../../lib/modules/stress/event.mjs';

const TEXT_HASH_RE = /^[0-9a-f]{64}$/;
const SENDER_HASH_RE = /^[0-9a-f]{12}$/;
const EVENT_ID_LEN = 24;

const OBSERVE_FIELDS = Object.freeze([
  'event_type',
  'occurred_at',
  'conversation_id',
  'sender_id',
  'relationship_tag',
  'is_mentioned',
  'is_direct_question',
  'text_hash'
]);

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details !== undefined) err.details = details;
  return err;
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 13 §5.3：`text_hash = SHA-256(text)`，正文用完即弃。 */
export function hashText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw contractError('INVALID_REQUEST', 'text must be a non-empty string', { path: 'text' });
  }
  return sha256Hex(text);
}

/** 13 §5.3：`sender_id = SHA-256(sender_key)` 前 12 位十六进制。 */
export function senderIdOf(rawSenderKey) {
  if (typeof rawSenderKey !== 'string' || rawSenderKey.length === 0) {
    throw contractError('INVALID_REQUEST', 'sender key must be a non-empty string', {
      path: 'sender_key'
    });
  }
  return sha256Hex(rawSenderKey).slice(0, 12);
}

/** 13 §5.3：`event_id = SHA-256(conversation_id|sender_id|occurred_at|text_hash)` 前 24 位。 */
export function eventIdOf({ conversation_id, sender_id, occurred_at, text_hash }) {
  return sha256Hex(`${conversation_id}|${sender_id}|${occurred_at}|${text_hash}`).slice(0, EVENT_ID_LEN);
}

/** 00 §2.1：`wechat:<conversation_id>:<sender_id>`。 */
export function sourceKeyOf({ conversation_id, sender_id }) {
  return `wechat:${conversation_id}:${sender_id}`;
}

function readBoolean(params, key) {
  const value = params[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw contractError('INVALID_REQUEST', `${key} must be a boolean`, { path: key });
  }
  return value;
}

/**
 * 13 §5.2 第 01 步 / P04：入参校验。失败不写任何键。
 */
export function validateObserveParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw contractError('INVALID_REQUEST', 'observe params must be an object', { path: 'params' });
  }
  const unknown = Object.keys(params).filter((key) => !OBSERVE_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw contractError('INVALID_REQUEST', 'unknown field in observe params', { unknown_fields: unknown });
  }
  if (!isEventType(params.event_type)) {
    throw contractError('INVALID_REQUEST', 'event_type is not in 00 §2.3', {
      path: 'event_type',
      got: String(params.event_type)
    });
  }
  if (typeof params.text_hash !== 'string' || !TEXT_HASH_RE.test(params.text_hash)) {
    throw contractError('INVALID_REQUEST', 'text_hash must be 64 lowercase hex characters', {
      path: 'text_hash'
    });
  }
  if (typeof params.conversation_id !== 'string' || params.conversation_id.length < 1 || params.conversation_id.length > 128) {
    throw contractError('INVALID_REQUEST', 'conversation_id must be 1-128 characters', {
      path: 'conversation_id'
    });
  }
  if (typeof params.sender_id !== 'string' || !SENDER_HASH_RE.test(params.sender_id)) {
    // 13 §6：明文账号标识必须先脱敏，绝不接收原始值。
    throw contractError('INVALID_REQUEST', 'sender_id must be a 12-hex hash, not a raw account id', {
      path: 'sender_id',
      reason: 'sender_id_not_hashed'
    });
  }

  const occurredAt = toIso(parseTime(params.occurred_at, 'occurred_at'));
  const relationship = params.relationship_tag;
  const warnings = [];
  let relationshipTag = 'unknown';
  if (relationship !== undefined) {
    if (typeof relationship !== 'string' || !RELATIONSHIP_TAGS.includes(relationship)) {
      warnings.push('UNKNOWN_RELATIONSHIP_TAG');
    } else {
      relationshipTag = relationship;
    }
  }

  return {
    event_type: params.event_type,
    occurred_at: occurredAt,
    conversation_id: params.conversation_id,
    sender_id: params.sender_id,
    relationship_tag: relationshipTag,
    is_mentioned: readBoolean(params, 'is_mentioned'),
    is_direct_question: readBoolean(params, 'is_direct_question'),
    text_hash: params.text_hash,
    warnings
  };
}

/**
 * 13 §5.3：标准事件；字段形状与 00 §12.3 的事件请求保持一致（不含正文）。
 */
export function normalizeEvent(params) {
  const input = validateObserveParams(params);
  const eventId = eventIdOf(input);
  const event = {
    event_id: eventId,
    event_type: input.event_type,
    occurred_at: input.occurred_at,
    source: {
      platform: 'wechat',
      conversation_id: input.conversation_id,
      sender_id: input.sender_id,
      is_mentioned: input.is_mentioned,
      relationship_tag: input.relationship_tag
    },
    payload: {
      message_type: 'text',
      text_hash: input.text_hash,
      text_summary: '',
      is_direct_question: input.is_direct_question
    },
    tags: []
  };
  return {
    event,
    event_id: eventId,
    idempotency_key: eventId,
    source_key: sourceKeyOf(input),
    warnings: input.warnings
  };
}

/**
 * 从宿主原始消息构造标准事件：正文只在这里参与一次哈希，随后被丢弃。
 * 群消息正文不会进入事件对象、不会进入 config，也不会被当作系统指令。
 */
export function buildEventFromMessage({ text, sender_key, ...meta }) {
  return normalizeEvent({
    ...meta,
    sender_id: meta.sender_id ?? senderIdOf(sender_key),
    text_hash: hashText(text)
  });
}

/** 13 §5.4 / 04 §5.1：`evlog` 条目只保留事件元数据。 */
export function eventLogRecord(event, characterId) {
  return {
    event_id: event.event_id,
    character_id: characterId,
    event_type: event.event_type,
    source_key: sourceKeyOf({
      conversation_id: event.source.conversation_id,
      sender_id: event.source.sender_id
    }),
    intensity: computeIntensity(event),
    occurred_at: event.occurred_at
  };
}

export default normalizeEvent;
