/**
 * 02 §4.2 / §5.3 / §5.4：时间解析、本地分解、时钟钳制、离线分块与粗推进。
 *
 * 硬性约束：
 * - 不读取任何墙钟（02 §9 的自检正则禁止 wall-clock 与 performance 计时），
 *   所有 UTC 换算都用整数运算手写，避免夏令时与本地时区污染。
 * - 本地时间必须走 Intl.DateTimeFormat，禁止手写 +8 偏移。
 */

import { LIMITS, MOOD_HOME, MOOD_KEYS } from './constants.mjs';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const MS_PER_DAY = 86_400_000;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** Howard Hinnant 的 days_from_civil：返回 1970-01-01 起的天数。 */
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
}

/**
 * 解析 UTC ISO 8601 毫秒时间（必须带 Z）。
 * @returns {number} epoch 毫秒
 */
export function parseTime(value, field = 'time') {
  if (typeof value !== 'string') {
    throw contractError('INVALID_TIME', `${field} must be a UTC ISO 8601 string with milliseconds`, {
      field,
      got: typeof value
    });
  }
  const m = ISO_RE.exec(value);
  if (!m) {
    throw contractError('INVALID_TIME', `${field} must match YYYY-MM-DDTHH:mm:ss.sssZ`, {
      field,
      got: value
    });
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ms = Number(m[7]);
  if (month < 1 || month > 12) {
    throw contractError('INVALID_TIME', `${field} has an invalid month`, { field, got: value });
  }
  if (day < 1 || day > 31) {
    throw contractError('INVALID_TIME', `${field} has an invalid day`, { field, got: value });
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw contractError('INVALID_TIME', `${field} has an invalid time of day`, { field, got: value });
  }
  const epochMs =
    daysFromCivil(year, month, day) * MS_PER_DAY +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    ms;
  // 往返校验可拦住 2026-02-30 这类"格式合法但日期不存在"的输入。
  if (toIso(epochMs) !== value) {
    throw contractError('INVALID_TIME', `${field} is not a real calendar time`, { field, got: value });
  }
  return epochMs;
}

/** @returns {string} 'YYYY-MM-DDTHH:mm:ss.sssZ' */
export function toIso(ms) {
  if (!Number.isFinite(ms)) {
    throw contractError('INVALID_TIME', 'time value must be a finite epoch milliseconds number');
  }
  const floored = Math.floor(ms);
  const days = Math.floor(floored / MS_PER_DAY);
  let rest = floored - days * MS_PER_DAY;
  const hour = Math.floor(rest / 3_600_000);
  rest -= hour * 3_600_000;
  const minute = Math.floor(rest / 60_000);
  rest -= minute * 60_000;
  const second = Math.floor(rest / 1_000);
  const millis = rest - second * 1_000;
  const { year, month, day } = civilFromDays(days);
  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`
  );
}

/** 整数秒，向下取整（02 §4.2）。 */
export function diffSeconds(fromIso, toIsoValue) {
  const from = parseTime(fromIso, 'from');
  const to = parseTime(toIsoValue, 'to');
  return Math.floor((to - from) / 1000);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw contractError('INVALID_REQUEST', 'timezone must be a non-empty IANA name', {
      path: 'timezone'
    });
  }
  try {
    // 只做可用性探测，不读取系统本地时区。
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw contractError('INVALID_REQUEST', `unknown IANA timezone: ${timeZone}`, {
      path: 'timezone',
      got: timeZone
    });
  }
}

export { assertTimeZone };

/**
 * 本地时间分解（02 §4.2）。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number,dayFraction:number}}
 */
export function localParts(iso, timeZone) {
  const ms = parseTime(iso, 'iso');
  assertTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  });
  const parts = dtf.formatToParts(ms);
  const bag = {};
  for (const part of parts) bag[part.type] = part.value;
  const hour = Number(bag.hour) % 24;
  const minute = Number(bag.minute);
  const second = Number(bag.second);
  const dayFraction = (hour * 3600 + minute * 60 + second) / 86_400;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute,
    second,
    weekday: WEEKDAY_INDEX[bag.weekday] ?? 0,
    dayFraction
  };
}

/**
 * 把"本地墙上时间"换算为 UTC epoch 毫秒（用于默认 planned_wake_at 等初始化值）。
 * 偏移量由同一时刻的 Intl 分解反推，夏令时由 Intl 负责。
 */
export function localWallToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone, referenceIso) {
  assertTimeZone(timeZone);
  const referenceMs = parseTime(referenceIso, 'reference');
  const ref = localParts(referenceIso, timeZone);
  const localAsUtc = daysFromCivil(ref.year, ref.month, ref.day) * MS_PER_DAY +
    ref.hour * 3_600_000 + ref.minute * 60_000 + ref.second * 1_000;
  const offset = referenceMs - localAsUtc;
  const targetLocal = daysFromCivil(year, month, day) * MS_PER_DAY +
    hour * 3_600_000 + minute * 60_000 + second * 1_000;
  return targetLocal + offset;
}

/**
 * 00 §5.2 的时钟钳制。
 * @returns {{effective_now:string, warnings:string[], deltaMs:number}}
 */
export function effectiveNow({ now, lastTickAt }) {
  const nowMs = parseTime(now, 'now');
  const lastMs = parseTime(lastTickAt, 'last_tick_at');
  const delta = nowMs - lastMs;
  if (delta < -LIMITS.clockToleranceMs) {
    return { effective_now: lastTickAt, warnings: ['CLOCK_REGRESSION'], deltaMs: 0 };
  }
  if (delta < 0) {
    return { effective_now: lastTickAt, warnings: ['CLOCK_TOLERATED'], deltaMs: 0 };
  }
  return { effective_now: now, warnings: [], deltaMs: delta };
}

/** 00 §5.3 / 02 §5.4：按 1 小时分块，最多 4320 步。 */
export function chunkElapsed({ elapsedSeconds, maxSteps = LIMITS.maxSteps, maxChunkSeconds = LIMITS.maxChunkSeconds }) {
  if (!Number.isFinite(elapsedSeconds)) {
    throw contractError('INVALID_REQUEST', 'elapsedSeconds must be finite', {
      path: 'elapsedSeconds',
      got: String(elapsedSeconds)
    });
  }
  const out = [];
  let remaining = Math.max(0, Math.floor(elapsedSeconds));
  let steps = 0;
  while (remaining > 0 && steps < maxSteps) {
    const take = Math.min(remaining, maxChunkSeconds);
    out.push(take);
    remaining -= take;
    steps += 1;
  }
  return { chunks: out, leftoverSeconds: remaining, coarse: remaining > 0 };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** 06 §5.1：峰值 03:00 的夜晚系数。 */
export function nightFactor(localHour) {
  return 0.5 * (1 + Math.cos((2 * Math.PI * (localHour - 3)) / 24));
}

function localHourOf(iso, timeZone) {
  const p = localParts(iso, timeZone);
  return p.hour + p.minute / 60 + p.second / 3600;
}

/**
 * 02 §5.4 的粗推进（离线超过 4320 步时只调用一次）。
 *
 * 周期推进由 05 的 advanceCycleDays 负责；为避免 02 -> 05 的循环依赖，
 * 协调器在检测到 cycle 模块导出 advanceCycleDays 时通过 hooks 注入（见 coordinator.mjs）。
 *
 * @param {{state:object, leftoverSeconds:number, now:string, config:object, hooks?:object}} params
 */
export function coarseForward({ state, leftoverSeconds, now, config, rngProvider = null, hooks = {} }) {
  if (!(leftoverSeconds > 0)) return state;
  const days = leftoverSeconds / 86_400;
  const next = structuredClone(state);
  const timezone = next.timezone;
  const effectiveConfig = config ?? {};

  // 情绪向 home 收敛
  const decay = Math.exp(-days / 7);
  for (const key of MOOD_KEYS) {
    const home = (effectiveConfig?.mood?.home && Number.isFinite(effectiveConfig.mood.home[key]))
      ? effectiveConfig.mood.home[key]
      : MOOD_HOME[key];
    next.mood[key] = round6(clamp01(home + (next.mood[key] - home) * decay));
  }

  // 压力衰减 + 清理过期事件
  next.stress.level = round6(clamp01(next.stress.level * Math.exp(-days / 2)));
  next.stress.active_events = (next.stress.active_events ?? [])
    .filter((ev) => Math.abs(ev.remaining) >= LIMITS.eventPruneThreshold)
    .map((ev) => ({ ...ev, remaining: round6(ev.remaining) }));
  next.stress.last_decay_at = now;

  // 睡眠债按日均净变化推进（02 §5.4 表：0.014×16 − 0.075×0.7×8）
  const dailyNet = 0.014 * 16 - 0.075 * 0.7 * 8;
  next.sleep.sleep_debt = round6(clamp01(next.sleep.sleep_debt + dailyNet * days));

  // 困倦度：由 06 的 sleepinessSteady(localHour, sleepDebt) 注入（02 §5.4，I-4）；
  // 02 不保留公式副本，缺 hook 时按 I-3 的口径失败而非静默退化。
  const hour = localHourOf(now, timezone);
  if (typeof hooks.sleepinessSteady !== 'function') {
    throw coarseHookMissing('sleep');
  }
  next.sleep.sleepiness = round6(clamp01(hooks.sleepinessSteady(hour, next.sleep.sleep_debt)));
  next.sleep.circadian_phase = round6((hour / 24) % 1);

  // 跨越 planned_wake_at 则醒来
  if (next.sleep.state !== 'awake' && next.sleep.planned_wake_at) {
    if (parseTime(now, 'now') >= parseTime(next.sleep.planned_wake_at, 'planned_wake_at')) {
      next.sleep.state = 'awake';
      next.sleep.state_since = now;
      next.sleep.last_wake_at = now;
      next.sleep.last_transition_reason = 'coarse_wake';
      next.sleep.recovery_progress = round6(clamp01(next.sleep.recovery_progress ?? 1));
    }
  }

  // 周期按整天推进：必须使用 05 注入的 advanceCycleDays（I-3），
  // 02 不保留"滚动天数"降级副本——缺 hook 说明模块表不完整，直接失败。
  // 必须把 rngProvider 一并传入：跨多个周期时每个新周期都要用 cycle:${index} 流采样，
  // 否则 180 天粗推进与逐小时推进的 cycle_length_days 会不一致（C12）。
  if (typeof hooks.advanceCycleDays !== 'function') {
    throw coarseHookMissing('cycle');
  }
  next.cycle = hooks.advanceCycleDays({
    cycle: next.cycle,
    deltaDays: days,
    rngProvider,
    config: effectiveConfig
  });

  return next;
}

/** 02 §5.4 粗推进依赖 05/06 注入；缺失即 MODULE_FAILED（I-3 / I-4）。 */
function coarseHookMissing(module) {
  return contractError('MODULE_FAILED', `coarseForward requires ${module} hook`, { module });
}
