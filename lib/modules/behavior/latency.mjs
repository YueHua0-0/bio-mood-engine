/**
 * 10 §5.3：回复延迟四档区间。
 *
 * 只给区间、不采样：同一输入必须得到同一区间，具体秒数由宿主在区间内决定。
 * 比较前先 round6，阈值比较用 1e-9 容差，恰等于阈值时计入较高一档。
 */

import { round6 } from '../../core/models.mjs';

const EPS = 1e-9;

/** 自上而下首个满足 `r >= min` 的档即为结果（`r` 已 round6）。 */
export const LATENCY_TIERS = Object.freeze([
  Object.freeze({ min: 0.70, range: Object.freeze([10, 120]) }),
  Object.freeze({ min: 0.40, range: Object.freeze([60, 600]) }),
  Object.freeze({ min: 0.20, range: Object.freeze([300, 1800]) }),
  Object.freeze({ min: Number.NEGATIVE_INFINITY, range: Object.freeze([1200, 7200]) })
]);

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

/**
 * @param {number} r reply_likelihood（可传未 round6 的值）
 * @returns {[number, number]} 整数秒区间
 */
export function latencyRange(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) {
    throw contractError('INVALID_REQUEST', 'reply_likelihood must be a finite number', {
      module: 'behavior',
      path: 'reply_likelihood'
    });
  }
  const value = round6(r);
  for (const tier of LATENCY_TIERS) {
    if (value - tier.min >= -EPS) return [tier.range[0], tier.range[1]];
  }
  /* istanbul ignore next -- 最后一档 min=-Infinity，不可达 */
  throw contractError('MODULE_FAILED', 'latency tier table is incomplete', { module: 'behavior' });
}
