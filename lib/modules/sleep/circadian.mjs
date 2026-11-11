/**
 * 06 §5.1 / §5.2 / §5.6：昼夜节律、困倦度收敛与计划唤醒（纯函数）。
 *
 * 硬性约束：
 * - 不读取任何系统时间；只用传入的 `now` / `sleepStartedAt`。
 * - 本地时间一律走 Intl.DateTimeFormat（复用 lib/core/clock.mjs），禁止手写时区偏移。
 * - 所有对外数值 round6，禁止 NaN / Infinity / -0。
 *
 * 本模块的全部数值均为虚构角色状态模拟，不是人体医学模型。
 */

import {
  assertTimeZone,
  localParts,
  localWallToUtc,
  parseTime,
  toIso
} from '../../core/clock.mjs';

/** 00 §7.3 / 06 §5.2：单步 sleepiness 变化上限。 */
export const SLEEPINESS_STEP_LIMIT = 0.20;

/** 06 §5.6：默认本地唤醒时刻 07:30。 */
export const DEFAULT_WAKE_LOCAL = Object.freeze({ hour: 7, minute: 30 });

/** 06 §5.6：入睡时若计划唤醒距 now 不足 3 小时则顺延一天。 */
export const MIN_PLANNED_SLEEP_HOURS = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function round6(value) {
  const r = Math.round(value * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeHour(hour) {
  if (!Number.isFinite(hour)) return 0;
  const wrapped = ((hour % 24) + 24) % 24;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * 06 §5.1：本地小时（含分秒小数），0 ≤ h < 24。
 * @param {string} now UTC ISO 毫秒
 * @param {string} timeZone IANA 时区名
 */
export function localHour(now, timeZone) {
  const parts = localParts(now, timeZone);
  return parts.hour + parts.minute / 60 + parts.second / 3600;
}

/** 06 §5.1：昼夜相位 [0,1)，0 = 本地 00:00，0.5 = 12:00。 */
export function circadianPhase(hour) {
  return round6(normalizeHour(hour) / 24);
}

/** 06 §5.1：峰值 03:00 的夜晚系数，[0,1]。 */
export function nightFactor(hour) {
  const h = normalizeHour(hour);
  return 0.5 * (1 + Math.cos((2 * Math.PI * (h - 3)) / 24));
}

/**
 * 06 §5.2 的清醒态昼夜稳态目标（02 的 coarseForward 也通过本函数注入）。
 *
 * target = clamp(0.10 + 0.45 * sleep_debt + 0.55 * night_factor, 0, 1)
 *
 * @param {number} hour 本地小时
 * @param {number} sleepDebt 睡眠债 [0,1]
 * @returns {number} round6 后的 [0,1]
 */
export function sleepinessSteady(hour, sleepDebt) {
  const h = normalizeHour(hour);
  const debt = clamp01(finiteOr(sleepDebt, 0));
  return round6(clamp01(0.10 + 0.45 * debt + 0.55 * nightFactor(h)));
}

/**
 * 06 §5.2：单步困倦度推进（含 0.20 变化上限与 [0,1] 钳制）。
 *
 * - 清醒态（awake/sleepy/trying_to_sleep/waking_up）：向昼夜稳态指数收敛（τ=2h）
 * - 睡眠态（sleeping）：向 0.15 指数收敛（τ=1h）
 * - 打断态（interrupted）：不衰减，s += 0.02 * Δt_h，上限 1
 *
 * `state` 既可以是 sleep.state 字符串，也可以直接传上一时刻的 state.sleep 对象。
 *
 * @param {{state:string|object, sleepDebt:number, localHour:number, deltaHours:number, sleepiness?:number}} params
 * @returns {number} round6 后的 [0,1]
 */
export function nextSleepiness({ state, sleepDebt, localHour: hour, deltaHours, sleepiness } = {}) {
  const phase = typeof state === 'string' ? state : state?.state;
  const current = clamp01(finiteOr(sleepiness, finiteOr(state?.sleepiness, 0.25)));
  const debt = clamp01(finiteOr(sleepDebt, 0));
  const dt = Math.max(0, finiteOr(deltaHours, 0));
  const h = normalizeHour(hour);

  let raw;
  if (phase === 'sleeping') {
    raw = 0.15 + (current - 0.15) * Math.exp(-dt / 1);
  } else if (phase === 'interrupted') {
    raw = Math.min(1, current + 0.02 * dt);
  } else {
    const target = clamp01(0.10 + 0.45 * debt + 0.55 * nightFactor(h));
    raw = target + (current - target) * Math.exp(-dt / 2);
  }
  raw = clamp01(raw);

  const delta = raw - current;
  const limited = Math.abs(delta) > SLEEPINESS_STEP_LIMIT
    ? clamp01(current + Math.sign(delta) * SLEEPINESS_STEP_LIMIT)
    : raw;
  return round6(limited);
}

/** 06 §5.3：sleep_quality 必须落在 [0.20, 0.98]。 */
export function clampQuality(value) {
  return round6(Math.min(0.98, Math.max(0.20, finiteOr(value, 0.7))));
}

/** 唤醒时刻配置（config.sleep.wake_hour / wake_minute），非法时回落到默认 07:30。 */
function wakeLocalOf(config) {
  const sleep = config && typeof config === 'object' ? config.sleep : null;
  const hour = sleep?.wake_hour;
  const minute = sleep?.wake_minute;
  const okHour = Number.isInteger(hour) && hour >= 0 && hour <= 23;
  const okMinute = Number.isInteger(minute) && minute >= 0 && minute <= 59;
  return {
    hour: okHour ? hour : DEFAULT_WAKE_LOCAL.hour,
    minute: okMinute ? minute : DEFAULT_WAKE_LOCAL.minute
  };
}

/**
 * 把"本地墙上时间"解析为 UTC 毫秒；夏令时造成的偏移差用一次定点校正吸收。
 * 不读系统时区，偏移全部来自 Intl。
 */
function resolveLocalWall({ year, month, day, hour, minute }, timeZone, referenceIso) {
  let ms = localWallToUtc({ year, month, day, hour, minute, second: 0 }, timeZone, referenceIso);
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(toIso(ms), timeZone);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      break;
    }
    const desired = hour * 60 + minute;
    const actual = p.hour * 60 + p.minute;
    ms += (desired - actual) * 60_000;
  }
  return ms;
}

/**
 * 06 §5.6：计划唤醒时刻。
 *
 * 默认 = 入睡当日本地 07:30；已过则顺延一天；距离入睡不足 3 小时再顺延一天。
 * 跨日只做"本地日期 +1 再重算本地 07:30"，不做"小时 +24"式累加。
 *
 * @param {{sleepStartedAt:string, timezone:string, config?:object}} params
 * @returns {string} UTC ISO 毫秒
 */
export function planWakeAt({ sleepStartedAt, timezone, config } = {}) {
  const startedMs = parseTime(sleepStartedAt, 'sleepStartedAt');
  assertTimeZone(timezone);
  const { hour, minute } = wakeLocalOf(config);
  const startLocal = localParts(toIso(startedMs), timezone);

  let date = { year: startLocal.year, month: startLocal.month, day: startLocal.day };
  let reference = toIso(startedMs);
  let candidate = resolveLocalWall({ ...date, hour, minute }, timezone, reference);

  let guard = 0;
  while (
    (candidate <= startedMs || candidate - startedMs < MIN_PLANNED_SLEEP_HOURS * HOUR_MS) &&
    guard < 4
  ) {
    const nextLocal = localParts(toIso(candidate + DAY_MS), timezone);
    date = { year: nextLocal.year, month: nextLocal.month, day: nextLocal.day };
    reference = toIso(candidate);
    candidate = resolveLocalWall({ ...date, hour, minute }, timezone, reference);
    guard += 1;
  }
  return toIso(candidate);
}
