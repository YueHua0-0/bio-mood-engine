/**
 * 11 §5.2–§5.3 / §5.6：唤醒代价、五条策略规则与交付前重新校验。
 *
 * 规则必须严格按优先级命中即停：不得改成加权打分或并行比较。
 */

import { round6 } from '../../core/models.mjs';
import { parseTime, toIso } from '../../core/clock.mjs';

import { DEFAULT_RECHECK_SECONDS, planQueue } from './queue.mjs';

const EPS = 1e-9;

export const POLICIES = Object.freeze([
  'deliver_now',
  'queue_until_awake',
  'silent_ignore',
  'wake_candidate',
  'urgent_interrupt'
]);

function ge(a, b) {
  return a - b >= -EPS;
}

function lt(a, b) {
  return a - b < -EPS;
}

function le(a, b) {
  return a - b <= EPS;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 11 §5.2：唤醒代价。输入先 clamp(0,1)，结果 round6。 */
export function wakeCost({ sleep_debt, sleepiness, urgency }) {
  return round6(
    clamp01(0.30 + 0.45 * clamp01(sleep_debt) + 0.30 * clamp01(sleepiness) - 0.20 * clamp01(urgency))
  );
}

/**
 * 11 §5.3：五条规则，命中即停。
 *
 * @param {{sleepState: string, sleepiness: number, urgency: number, wakeCost: number}} ctx
 * @returns {string} 五个 policy 之一
 */
export function decidePolicy(ctx) {
  const { sleepState, sleepiness, urgency, wakeCost: cost } = ctx;

  if (sleepState === 'sleeping') {
    if (ge(urgency, 0.95) && le(cost, 0.85)) return 'urgent_interrupt';
    if (ge(urgency, 0.70) && lt(cost, 0.70)) return 'wake_candidate';
    return 'queue_until_awake';
  }

  if (sleepState === 'awake' && ge(sleepiness, 0.85) && lt(urgency, 0.50)) {
    return 'silent_ignore';
  }

  return 'deliver_now';
}

/**
 * 11 §5.6：交付前的重新校验（纯函数，宿主在 `deliver_after` 时调用）。
 *
 * 判定顺序：先看是否过期（过期即不再交付），再看是否已醒，最后顺延重校验间隔。
 *
 * @param {{queueItem: object, sleep: object, now: string}} args
 * @returns {object} 仅含需要更新的字段，宿主负责与已有计划合并
 */
export function recheck({ queueItem, sleep, now }) {
  const nowMs = parseTime(now, 'now');
  const item = queueItem ?? {};

  if (
    item.character_id !== undefined &&
    sleep?.character_id !== undefined &&
    item.character_id !== sleep.character_id
  ) {
    const err = new Error('queue item belongs to another character');
    err.code = 'INVALID_REQUEST';
    err.retryable = false;
    err.details = { module: 'delivery', path: 'queueItem.character_id' };
    throw err;
  }

  if (item.expires_at) {
    const expiresMs = parseTime(item.expires_at, 'queueItem.expires_at');
    if (nowMs > expiresMs) {
      return {
        policy: 'silent_ignore',
        recommended_delay_seconds: 0,
        deliver_after: toIso(nowMs),
        expires_at: null,
        reason_codes: ['expired']
      };
    }
  }

  if (sleep?.state === 'awake') {
    return {
      policy: 'deliver_now',
      recommended_delay_seconds: 0,
      deliver_after: toIso(nowMs),
      expires_at: null,
      reason_codes: ['state_changed_awake']
    };
  }

  const planned = typeof item.planned_wake_at === 'string' ? item.planned_wake_at : null;
  const plan = planQueue({ now, planned_wake_at: planned });
  const delay = planned ? plan.delay : DEFAULT_RECHECK_SECONDS;

  return {
    policy: 'queue_until_awake',
    recommended_delay_seconds: delay,
    deliver_after: toIso(nowMs + delay * 1000),
    expires_at: item.expires_at ?? plan.expires_at,
    reason_codes: plan.reason_codes
  };
}
