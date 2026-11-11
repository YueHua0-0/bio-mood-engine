/**
 * 11 §5.8：delivery 的 reason_codes 稳定排序（≤16）。
 *
 * 表序即输出序；去重后最多 13 个。实现不得发明新码。
 */

export const REASON_ORDER = Object.freeze([
  'no_event',
  'sleeping',
  'urgent_conflict',
  'wake_candidate_low_cost',
  'wake_cost_high',
  'low_event_urgency',
  'awake_high_sleepiness',
  'sleepy_passthrough',
  'planned_wake_reached',
  'planned_wake_missing',
  'queue_capped',
  'coalesced',
  'state_changed_awake',
  'expired'
]);

/** @param {Iterable<string>} codes */
export function orderReasonCodes(codes) {
  const hit = new Set(codes);
  return REASON_ORDER.filter((code) => hit.has(code));
}
