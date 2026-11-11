/**
 * 07 §5.4 / §5.6：300 秒同源合并、去重、按 |remaining| 降序排序与 32 条截断。
 *
 * 合并公式 `max(a,b) + 0.5×min(a,b)` 保证同源重复刺激不做简单相加。
 * 排序键用绝对值，使强安慰与强冲突都优先保留（00 §3.2）。
 */

import { LIMITS } from '../../core/constants.mjs';
import { parseTime } from '../../core/clock.mjs';
import { round6 } from '../../core/models.mjs';

/** 07 §5.4：同源合并窗口。 */
export const MERGE_WINDOW_SECONDS = 300;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 07 §5.4：合并两条强度。
 * @returns {{remaining:number, clamped:boolean}}
 */
export function mergeIntensity(a, b) {
  const left = Number.isFinite(a) ? a : 0;
  const right = Number.isFinite(b) ? b : 0;
  const raw = Math.max(left, right) + 0.5 * Math.min(left, right);
  return {
    remaining: round6(clamp(raw, -1, 1)),
    clamped: raw > 1 + 1e-9 || raw < -1 - 1e-9
  };
}

/** 07 §5.4：300 秒内视为同一刺激窗口（300s 合并、301s 新建）。 */
export function withinMergeWindow(startedAtIso, nowMs, windowSeconds = MERGE_WINDOW_SECONDS) {
  try {
    const startedMs = parseTime(startedAtIso, 'started_at');
    return Math.abs(nowMs - startedMs) <= windowSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * 07 §5.6：剔除 |remaining| < 0.005 → 按 event_id 去重 → |remaining| 降序 → 截断 32 条。
 * 全部 round6 并去掉 -0。
 * @returns {{events:object[], evicted:boolean, pruned:number}}
 */
export function pruneAndSort(
  events,
  { maxActive = LIMITS.maxActiveEvents, threshold = LIMITS.eventPruneThreshold } = {}
) {
  const list = Array.isArray(events) ? events : [];
  const byId = new Map();
  let pruned = 0;

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') {
      pruned += 1;
      continue;
    }
    const remaining = Number(ev.remaining);
    if (!Number.isFinite(remaining) || Math.abs(remaining) < threshold) {
      pruned += 1;
      continue;
    }
    const remainingOut = round6(clamp(remaining, -1, 1));
    const rawIntensity = Number(ev.intensity);
    const candidate = {
      event_id: ev.event_id,
      event_type: ev.event_type,
      started_at: ev.started_at,
      intensity: Number.isFinite(rawIntensity) ? round6(clamp(rawIntensity, -1, 1)) : remainingOut,
      remaining: remainingOut,
      decay_profile: ev.decay_profile,
      source_key: ev.source_key
    };
    const existing = byId.get(candidate.event_id);
    if (!existing || Math.abs(candidate.remaining) > Math.abs(existing.remaining)) {
      byId.set(candidate.event_id, candidate);
    } else {
      pruned += 1;
    }
  }

  const ordered = [...byId.values()].sort((a, b) => {
    const diff = Math.abs(b.remaining) - Math.abs(a.remaining);
    if (Math.abs(diff) > 1e-12) return diff;
    return String(a.event_id).localeCompare(String(b.event_id));
  });
  const kept = ordered.slice(0, maxActive);

  return { events: kept, evicted: ordered.length > kept.length, pruned };
}
