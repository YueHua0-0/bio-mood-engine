/**
 * 11 §5.1：事件紧急度基表（冻结）与 @ 修正。
 *
 * `is_mentioned` 只上调、不下调：`urgency = max(base, 0.60)`，`system_event` 也不例外。
 */

import { round6 } from '../../core/models.mjs';

/** 00 §2.3 的九种事件类型 -> 11 §5.1 的紧急度。 */
export const BASE_URGENCY = Object.freeze({
  conflict: 1.00,
  admin_command: 0.90,
  important_person_appear: 0.75,
  direct_question: 0.70,
  mention: 0.60,
  comfort_received: 0.50,
  group_message: 0.20,
  long_silence: 0.10,
  system_event: 0.00
});

export const EVENT_TYPES = Object.freeze(Object.keys(BASE_URGENCY));

/** @ 的紧急度下限。 */
export const MENTION_FLOOR = 0.60;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

/** @returns {number} 基表值 */
export function baseUrgency(eventType) {
  if (!Object.prototype.hasOwnProperty.call(BASE_URGENCY, eventType)) {
    throw contractError('INVALID_REQUEST', 'event_type is not in the frozen enum', {
      module: 'delivery',
      path: 'inputs.event.event_type',
      value: eventType
    });
  }
  return BASE_URGENCY[eventType];
}

/** §5.1：含 @ 修正的紧急度，先 round6 再参与比较。 */
export function urgencyOf(event) {
  const base = baseUrgency(event?.event_type);
  const value = event?.is_mentioned === true ? Math.max(base, MENTION_FLOOR) : base;
  return round6(value);
}
