/**
 * 12 §5.3：两个独立的滑动窗口计数器。
 *
 * - `events`：`POST /v1/events` 120 次 / 60 s。
 * - `other`：`/v1/state`、`/v1/tick`、`/v1/admin/reset` 合计 60 次 / 60 s。
 * - `/health` 与 `/version` 不调用本模块（永不计入）。
 * - 计数位置由 handler 固定为"鉴权之后、请求校验之前"；键是令牌指纹，不是原始令牌。
 * - 时间一律取注入的 `clock()`（与 04 同口径），不读墙钟。
 */

export const WINDOW_MS = 60_000;

export const DEFAULT_LIMITS = Object.freeze({ events: 120, other: 60 });

export function createRateLimiter({ clock, limits = DEFAULT_LIMITS, windowMs = WINDOW_MS } = {}) {
  if (typeof clock !== 'function') throw new Error('createRateLimiter requires a clock function');
  /** @type {Map<string, number[]>} */
  const buckets = new Map();

  function nowMs() {
    const value = clock();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  /**
   * @param {'events'|'other'} scope
   * @param {string} key 令牌指纹
   * @returns {{allowed: boolean, retry_after_seconds?: number}}
   */
  function consume(scope, key) {
    const limit = limits[scope] ?? limits.other;
    const bucketKey = `${scope}:${key}`;
    const now = nowMs();
    const cutoff = now - windowMs;
    const hits = buckets.get(bucketKey) ?? [];
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    if (hits.length >= limit) {
      buckets.set(bucketKey, hits);
      const retrySeconds = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
      return { allowed: false, retry_after_seconds: retrySeconds };
    }

    hits.push(now);
    buckets.set(bucketKey, hits);
    return { allowed: true };
  }

  return { consume };
}
