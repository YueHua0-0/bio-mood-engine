/**
 * 07 §5.1–§5.2：基础强度、关系倍率、@ 加成、直接提问 bonus 与最终强度。
 *
 * 全部数值来自 00 §2.3 / §2.4 的冻结表，禁止在别处另存副本。
 * 本文件是纯函数，不读系统时间、不使用随机数。
 */

import { round6 } from '../../core/models.mjs';

/** 00 §2.3：9 种事件类型的基础强度（负值表示降低压力）。 */
export const BASE_INTENSITY = Object.freeze({
  group_message: 0.02,
  mention: 0.08,
  important_person_appear: 0.12,
  comfort_received: -0.10,
  conflict: 0.25,
  long_silence: 0.05,
  direct_question: 0.06,
  admin_command: 0,
  system_event: 0
});

/** 00 §2.3：事件类型对应的衰减档。 */
export const DECAY_PROFILE = Object.freeze({
  group_message: 'fast',
  mention: 'medium',
  important_person_appear: 'slow',
  comfort_received: 'medium',
  conflict: 'slow',
  long_silence: 'very_slow',
  direct_question: 'medium',
  admin_command: 'none',
  system_event: 'none'
});

/** 00 §2.4：6 种关系标签的倍率；`admin` 为 0 是"管理指令不制造压力"的管理语义。 */
export const RELATIONSHIP_MULTIPLIER = Object.freeze({
  ordinary: 1.0,
  important: 1.5,
  intimate: 1.3,
  conflict: 2.0,
  admin: 0.0,
  unknown: 1.0
});

export const EVENT_TYPES = Object.freeze(Object.keys(BASE_INTENSITY));
export const RELATIONSHIP_TAGS = Object.freeze(Object.keys(RELATIONSHIP_MULTIPLIER));

/** 07 §5.2：`@` 的强度下限（至少按 mention 计）。 */
export const MENTION_FLOOR = 0.08;
/** 07 §5.2：直接提问的附加，倍率之后相加、不被倍率放大。 */
export const DIRECT_QUESTION_BONUS = 0.02;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isEventType(value) {
  return typeof value === 'string' && Object.hasOwn(BASE_INTENSITY, value);
}

/** 07 §5.1：基础强度；非枚举值抛 INVALID_REQUEST（00 §9.2）。 */
export function baseIntensity(eventType) {
  if (!isEventType(eventType)) {
    throw contractError('INVALID_REQUEST', `unknown event_type: ${String(eventType)}`, {
      path: 'event_type',
      got: String(eventType)
    });
  }
  return BASE_INTENSITY[eventType];
}

export function decayProfile(eventType) {
  return isEventType(eventType) ? DECAY_PROFILE[eventType] : 'none';
}

/**
 * 07 §5.1：关系倍率。未知/缺失按 `unknown`（1.0），不得根据正文猜测。
 * @returns {{tag:string, multiplier:number, known:boolean}}
 */
export function relationshipInfo(tag) {
  const known = typeof tag === 'string' && Object.hasOwn(RELATIONSHIP_MULTIPLIER, tag);
  if (!known) {
    return { tag: 'unknown', multiplier: RELATIONSHIP_MULTIPLIER.unknown, known: false };
  }
  return { tag, multiplier: RELATIONSHIP_MULTIPLIER[tag], known: true };
}

export function relationshipMultiplier(tag) {
  return relationshipInfo(tag).multiplier;
}

function isMentioned(event) {
  const value = event?.source?.is_mentioned ?? event?.is_mentioned;
  return value === true;
}

function isDirectQuestion(event) {
  const value =
    event?.payload?.is_direct_question ??
    event?.source?.is_direct_question ??
    event?.is_direct_question;
  return value === true;
}

/**
 * 07 §5.2：强度明细（含 base / 倍率 / bonus / override 与告警）。
 * 只做数值计算与输入校验，不判断事件是否合法（event_id / occurred_at 由 index 校验）。
 */
export function computeIntensityDetail(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw contractError('INVALID_REQUEST', 'event must be an object', { path: 'event' });
  }
  const warnings = [];
  const base = baseIntensity(event.event_type);

  let value = base;
  const mentioned = isMentioned(event);
  // 只有正强度才允许 @ 提升，避免把 comfort_received（−0.10）翻成正压力。
  if (mentioned && value > 0) value = Math.max(value, MENTION_FLOOR);

  const relationship = relationshipInfo(event?.source?.relationship_tag ?? event?.relationship_tag);
  if (!relationship.known) warnings.push('UNKNOWN_RELATIONSHIP_TAG');

  const bonus = isDirectQuestion(event) ? DIRECT_QUESTION_BONUS : 0;
  let raw = value * relationship.multiplier + bonus;

  const override = event.intensity_override;
  let overrideApplied = false;
  if (override !== null && override !== undefined) {
    if (typeof override !== 'number' || !Number.isFinite(override)) {
      throw contractError('INVALID_REQUEST', 'intensity_override must be a finite number within [-1,1]', {
        path: 'intensity_override',
        got: String(override)
      });
    }
    if (override < -1 || override > 1) warnings.push('INPUT_CLAMPED');
    raw = override;
    overrideApplied = true;
    warnings.push('INTENSITY_OVERRIDE');
  }

  return {
    intensity: round6(clamp(raw, -1, 1)),
    base,
    multiplier: relationship.multiplier,
    relationship_tag: relationship.tag,
    mentioned,
    bonus,
    override_applied: overrideApplied,
    decay_profile: DECAY_PROFILE[event.event_type],
    warnings
  };
}

/** 07 §4.1：本次事件的最终强度（已含 override / 倍率 / @ / bonus，clamp 到 [-1,1]）。 */
export function computeIntensity(event) {
  return computeIntensityDetail(event).intensity;
}
