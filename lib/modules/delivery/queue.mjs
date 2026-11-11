/**
 * 11 §5.4–§5.5：排队延迟、上限与同会话 10 分钟合并。
 *
 * 只算计划、不调度：`deliver_after` 是"最早可交付时刻"，宿主不保证准点。
 */

import { parseTime, toIso } from '../../core/clock.mjs';

/** 合并窗口：`(now-600s, now]`。 */
export const COALESCE_WINDOW_MS = 600_000;
/** 缺 `planned_wake_at` 时的重校验间隔（不是交付时刻）。 */
export const DEFAULT_RECHECK_SECONDS = 1800;
/** 单次排队延迟上限。 */
export const MAX_DELAY_SECONDS = 86_400;
/** 排队项有效期。 */
export const EXPIRES_AFTER_SECONDS = 86_400;
/** 合并阈值：窗口内同会话累计项（含本条）。 */
export const COALESCE_THRESHOLD = 3;

/**
 * 11 §5.4：排队延迟与过期时间。
 *
 * @param {{now: string, planned_wake_at: string|null}} args
 * @returns {{delay: number, deliver_after: string, expires_at: string, reason_codes: string[]}}
 */
export function planQueue({ now, planned_wake_at: plannedWakeAt }) {
  const nowMs = parseTime(now, 'now');
  const codes = [];
  let delay;

  let wakeMs = null;
  if (typeof plannedWakeAt === 'string' && plannedWakeAt.length > 0) {
    try {
      wakeMs = parseTime(plannedWakeAt, 'inputs.sleep.planned_wake_at');
    } catch {
      wakeMs = null;
    }
  }

  if (wakeMs === null) {
    delay = DEFAULT_RECHECK_SECONDS;
    codes.push('planned_wake_missing');
  } else {
    delay = Math.max(0, Math.floor((wakeMs - nowMs) / 1000));
    codes.push('planned_wake_reached');
    if (delay > MAX_DELAY_SECONDS) {
      delay = MAX_DELAY_SECONDS;
      codes.push('queue_capped');
    }
  }

  return {
    delay,
    deliver_after: toIso(nowMs + delay * 1000),
    expires_at: toIso(nowMs + (delay + EXPIRES_AFTER_SECONDS) * 1000),
    reason_codes: codes
  };
}

/**
 * 11 §5.5：同会话 10 分钟窗口合并。
 *
 * 只决定"折进哪条、折了几条"；不计算 `urgency`（`pending` 里没有，且合并项全是
 * `queue_until_awake`，`urgency < 0.70`，对策略无区分意义）。
 *
 * @param {{pending: Array, event: object, now: string}} args
 */
export function coalesce({ pending, event, now }) {
  const nowMs = parseTime(now, 'now');
  const list = Array.isArray(pending) ? pending : [];
  const conversationId = event?.conversation_id;
  const warnings = [];
  let skipped = 0;

  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    if (list.length > 0) warnings.push('DEGRADED');
    return { triggered: false, merged_count: 1, warnings };
  }

  const windowed = [];
  for (const item of list) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.conversation_id !== 'string' ||
      item.conversation_id.length === 0 ||
      typeof item.event_id !== 'string' ||
      typeof item.queued_at !== 'string'
    ) {
      skipped += 1;
      continue;
    }
    if (item.conversation_id !== conversationId) continue;
    const queuedMs = parseTime(item.queued_at, 'inputs.queue.pending[].queued_at');
    if (queuedMs > nowMs - COALESCE_WINDOW_MS && queuedMs <= nowMs) {
      windowed.push({ event_id: item.event_id, conversation_id: item.conversation_id, queued_at: item.queued_at, queuedMs });
    }
  }

  if (skipped > 0) warnings.push('DEGRADED');

  const mergedCount = windowed.length + 1;
  if (mergedCount < COALESCE_THRESHOLD) {
    return { triggered: false, merged_count: mergedCount, warnings };
  }

  windowed.sort((a, b) => {
    if (a.queuedMs !== b.queuedMs) return a.queuedMs - b.queuedMs;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  const keep = windowed[0];

  return {
    triggered: true,
    merged_count: mergedCount,
    coalesced_into: {
      event_id: keep.event_id,
      conversation_id: conversationId,
      earliest_queued_at: keep.queued_at,
      merged_count: mergedCount
    },
    warnings
  };
}
