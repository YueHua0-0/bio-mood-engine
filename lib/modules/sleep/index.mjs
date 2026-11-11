/**
 * 06 · 睡眠模块：updateSleep 与 ModuleResult 组装。
 *
 * 只写 `state.sleep` 与 `sleep.*` 贡献；不写 stress.* / mood.* / cycle.*，不读系统时间。
 * 全部数值为虚构角色状态模拟（睡眠债、睡眠质量均为模拟量），不是医学指标。
 */

import { INTERFACE_VERSION, SLEEP_STATES } from '../../core/constants.mjs';
import { parseTime, toIso } from '../../core/clock.mjs';

import {
  clamp01,
  clampQuality,
  localHour,
  nextSleepiness,
  planWakeAt,
  round6,
  sleepinessSteady
} from './circadian.mjs';

import {
  INTERRUPTION_RULES,
  decideTransition,
  guardTransition,
  nextTransitionHintMs
} from './state-machine.mjs';

const HOUR_MS = 3_600_000;
const HINT_WINDOW_MS = 3_600_000;

/** 06 §6：previous 缺字段时的契约默认值（02 §5.1 / 00 §3.2）。 */
const SLEEP_DEFAULTS = Object.freeze({
  state: 'awake',
  sleep_debt: 0.15,
  sleep_quality: 0.7,
  sleepiness: 0.25,
  interruption_count: 0,
  recovery_progress: 1,
  last_transition_reason: 'init'
});

const ACTIVE_SLEEP_STATES = Object.freeze(['sleeping', 'interrupted', 'waking_up']);

function safeParse(value) {
  if (typeof value !== 'string') return null;
  try {
    return parseTime(value, 'sleep_time');
  } catch {
    return null;
  }
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 06 §5.1 / §5.6：时区只来自配置快照（00 §8.1），不读系统时区。
 * 缺失时按 UTC 处理；非法值由 Intl 校验抛 INVALID_REQUEST（06 §6）。
 */
function resolveTimeZone(config) {
  const tz = config && typeof config === 'object' ? config.timezone : null;
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
}

/**
 * 读取并规范化上一时刻 sleep 状态；缺失/非法时回落契约默认值 + MISSING_SLEEP_DATA。
 */
function readPrevious(previous, nowIso, warnings) {
  const nowMs = parseTime(nowIso, 'now');
  if (!previous || typeof previous !== 'object' || !SLEEP_STATES.includes(previous.state)) {
    warnings.push('MISSING_SLEEP_DATA');
    return {
      state: 'awake',
      state_since: nowIso,
      state_since_ms: nowMs,
      sleep_started_at: null,
      sleep_started_ms: null,
      last_wake_at: null,
      planned_wake_at: null,
      planned_wake_ms: null,
      sleep_debt: SLEEP_DEFAULTS.sleep_debt,
      sleep_quality: SLEEP_DEFAULTS.sleep_quality,
      sleepiness: SLEEP_DEFAULTS.sleepiness,
      interruption_count: SLEEP_DEFAULTS.interruption_count,
      recovery_progress: SLEEP_DEFAULTS.recovery_progress,
      last_transition_reason: 'recovered_from_unknown_state',
      degraded: true
    };
  }

  const stateSinceMs = safeParse(previous.state_since);
  if (stateSinceMs === null) warnings.push('MISSING_SLEEP_DATA');
  const numericFields = [
    previous.sleep_debt,
    previous.sleep_quality,
    previous.sleepiness,
    previous.interruption_count,
    previous.recovery_progress
  ];
  if (numericFields.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    warnings.push('MISSING_SLEEP_DATA');
  }
  const startedMs = safeParse(previous.sleep_started_at);
  const wakeMs = safeParse(previous.planned_wake_at);
  const lastWakeMs = safeParse(previous.last_wake_at);

  return {
    state: previous.state,
    state_since: stateSinceMs === null ? nowIso : toIso(stateSinceMs),
    state_since_ms: stateSinceMs === null ? nowMs : stateSinceMs,
    sleep_started_at: startedMs === null ? null : toIso(startedMs),
    sleep_started_ms: startedMs,
    last_wake_at: lastWakeMs === null ? null : toIso(lastWakeMs),
    planned_wake_at: wakeMs === null ? null : toIso(wakeMs),
    planned_wake_ms: wakeMs,
    sleep_debt: clamp01(finiteOr(previous.sleep_debt, SLEEP_DEFAULTS.sleep_debt)),
    sleep_quality: clampQuality(finiteOr(previous.sleep_quality, SLEEP_DEFAULTS.sleep_quality)),
    sleepiness: clamp01(finiteOr(previous.sleepiness, SLEEP_DEFAULTS.sleepiness)),
    interruption_count: clampInt(
      previous.interruption_count,
      0,
      INTERRUPTION_RULES.max_count,
      SLEEP_DEFAULTS.interruption_count
    ),
    recovery_progress: clamp01(finiteOr(previous.recovery_progress, SLEEP_DEFAULTS.recovery_progress)),
    last_transition_reason: typeof previous.last_transition_reason === 'string' && previous.last_transition_reason.length > 0
      ? previous.last_transition_reason
      : SLEEP_DEFAULTS.last_transition_reason,
    degraded: false
  };
}

/**
 * 单步 Δt_h：sleep 状态没有 last_update 字段，唯一可用时间戳是 state_since。
 * 取 min(now - state_since, 1h)：1 小时分块下与真实步长一致；状态刚切换时为 0。
 */
function deltaHoursOf(nowMs, stateSinceMs) {
  if (!Number.isFinite(stateSinceMs)) return 1;
  const hours = (nowMs - stateSinceMs) / HOUR_MS;
  if (!(hours > 0)) return 0;
  return Math.min(hours, 1);
}

/** 06 §5.3：本次睡眠的恢复进度（单调、跨日安全）。 */
function recoveryOf({ startedMs, plannedMs, nowMs, fallback }) {
  if (!Number.isFinite(startedMs) || !Number.isFinite(plannedMs) || plannedMs <= startedMs) {
    return fallback;
  }
  const plannedHours = Math.max(0.5, (plannedMs - startedMs) / HOUR_MS);
  const sleptHours = Math.max(0, (nowMs - startedMs) / HOUR_MS);
  return round6(clamp01(sleptHours / plannedHours));
}

/** 06 §5.3：睡眠质量公式（0 打断且 ≥6 h → 0.85，极端打断 → 0.20）。 */
function qualityOf({ interruptionCount, sleptHours }) {
  return clampQuality(
    0.85 - 0.06 * interruptionCount - (0.15 * Math.max(0, 6 - sleptHours)) / 6
  );
}

/**
 * 06 §4.2 / C-06-01：打断强度只取 07 的 derived.event_intensity（由 02 预判后注入），
 * 不得回退到原始 event.intensity。
 */
function eventIntensityOf(inputs) {
  const value = inputs && typeof inputs === 'object' ? inputs.event_intensity : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 06 §4.4：next_transition_at 必须满足 now < hint ≤ now + 1h，否则返回 null。
 */
function transitionHint({ state, stateSinceMs, plannedWakeAtMs, nowMs }) {
  const hintMs = nextTransitionHintMs({ state, stateSinceMs, plannedWakeAtMs });
  if (!Number.isFinite(hintMs)) return null;
  if (hintMs <= nowMs || hintMs > nowMs + HINT_WINDOW_MS) return null;
  return toIso(hintMs);
}

/** 入睡时确定 planned_wake_at：inputs 人工值优先，其次沿用仍有效的旧值，最后按默认 07:30 重算。 */
function resolvePlannedWake({ inputs, prev, nowMs, nowIso, timezone, config }) {
  for (const raw of [inputs.planned_wake_at, prev.planned_wake_at]) {
    const ms = safeParse(raw);
    if (ms !== null && ms > nowMs) return toIso(ms);
  }
  return planWakeAt({ sleepStartedAt: nowIso, timezone, config });
}

/**
 * 06 §4.1 / §4.3：睡眠模块主函数（纯函数，返回 00 §4.2 的 ModuleResult）。
 *
 * @param {{previous:object, inputs:object, now:string, rng:object, config:object}} params
 */
export function updateSleep({ previous, inputs, now, rng, config } = {}) {
  const nowMs = parseTime(now, 'now');
  const nowIso = toIso(nowMs);
  const timezone = resolveTimeZone(config);
  const hour = localHour(nowIso, timezone);

  const warningList = [];
  const prev = readPrevious(previous, nowIso, warningList);
  const deltaHours = deltaHoursOf(nowMs, prev.state_since_ms ?? nowMs);

  const requestInputs = inputs && typeof inputs === 'object' ? inputs : {};
  const eventIntensity = eventIntensityOf(requestInputs);
  const urgent = requestInputs.urgent === true;
  const urgentInterrupt = requestInputs.urgent_interrupt === true;

  // 1) 睡眠债：睡眠态按质量扣减，其余（含打断/清醒）按清醒速率累积（06 §5.2「被打断会略微更清醒」）。
  let sleepDebt = prev.sleep_debt;
  if (prev.state === 'sleeping') {
    sleepDebt -= 0.075 * prev.sleep_quality * deltaHours;
  } else {
    sleepDebt += 0.014 * deltaHours;
  }
  sleepDebt = round6(clamp01(sleepDebt));

  // 2) 困倦度：按上一状态选择曲线。
  const sleepiness = nextSleepiness({
    state: prev.state,
    sleepiness: prev.sleepiness,
    sleepDebt,
    localHour: hour,
    deltaHours
  });
  if (Math.abs(sleepiness - prev.sleepiness) >= 0.20 - 1e-9) {
    warningList.push('SLEEPINESS_CLAMPED');
  }

  // 3) 睡眠质量：睡眠中按公式随已睡小时推进；其余状态保持（打断瞬间另行扣减）。
  let quality = prev.sleep_quality;
  if (prev.state === 'sleeping') {
    const sleptHours = Number.isFinite(prev.sleep_started_ms)
      ? Math.max(0, (nowMs - prev.sleep_started_ms) / HOUR_MS)
      : 0;
    quality = qualityOf({ interruptionCount: prev.interruption_count, sleptHours });
  }

  // 4) 状态机决策（只读观测值，不改入参）。
  // C-06-02：续睡判定看本次睡眠的恢复进度，用决策时刻可得的 started/planned 现算。
  const recoveryAtDecision = recoveryOf({
    startedMs: prev.sleep_started_ms,
    plannedMs: prev.planned_wake_ms,
    nowMs,
    fallback: prev.recovery_progress
  });
  const decision = decideTransition({
    previous: prev.state,
    sleepiness,
    localHour: hour,
    nowMs,
    stateSinceMs: prev.state_since_ms ?? nowMs,
    plannedWakeAtMs: prev.planned_wake_ms,
    urgent,
    urgentInterrupt,
    eventIntensity,
    recoveryProgress: recoveryAtDecision
  });

  let nextState = prev.state;
  let stateSince = prev.state_since;
  let sleepStartedAt = prev.sleep_started_at;
  let lastWakeAt = prev.last_wake_at;
  let plannedWakeAt = prev.planned_wake_at;
  let interruptionCount = prev.interruption_count;
  let reason = prev.last_transition_reason;
  let transitioned = false;

  if (decision && decision.to !== prev.state) {
    const guard = guardTransition({ from: prev.state, to: decision.to });
    if (!guard.ok) {
      // 非法转换：保持原状态与 state_since，只追加警告（06 §5.4 / §6）。
      warningList.push(...guard.warnings);
    } else {
      transitioned = true;
      nextState = decision.to;
      // 时间驱动转换回填到阈值边界（见 state-machine），使入睡/转醒时刻不受分块粒度影响。
      const atMs = Math.min(
        nowMs,
        Math.max(prev.state_since_ms ?? nowMs, Number.isFinite(decision.atMs) ? decision.atMs : nowMs)
      );
      stateSince = toIso(atMs);
      reason = decision.reason;

      if (decision.to === 'interrupted') {
        // 06 §5.5：单次 tick 只计一次打断。
        interruptionCount = Math.min(INTERRUPTION_RULES.max_count, interruptionCount + 1);
        sleepDebt = round6(clamp01(sleepDebt + INTERRUPTION_RULES.debt_bump));
        quality = clampQuality(quality - INTERRUPTION_RULES.quality_penalty);
      } else if (decision.to === 'sleeping' && prev.state === 'trying_to_sleep') {
        sleepStartedAt = stateSince;
        interruptionCount = 0;
        plannedWakeAt = resolvePlannedWake({ inputs: requestInputs, prev, nowMs, nowIso, timezone, config });
      } else if (decision.to === 'awake' && prev.state === 'waking_up') {
        lastWakeAt = stateSince;
      }
    }
  }

  const startedMs = safeParse(sleepStartedAt);
  const plannedMs = safeParse(plannedWakeAt);
  let recovery = prev.recovery_progress;
  if (ACTIVE_SLEEP_STATES.includes(nextState)) {
    recovery = recoveryOf({
      startedMs,
      plannedMs,
      nowMs,
      fallback: prev.recovery_progress
    });
  }

  const next = {
    state: nextState,
    state_since: stateSince,
    sleep_started_at: sleepStartedAt,
    last_wake_at: lastWakeAt,
    planned_wake_at: plannedWakeAt,
    sleep_debt: round6(clamp01(sleepDebt)),
    sleep_quality: clampQuality(quality),
    sleepiness: round6(clamp01(sleepiness)),
    circadian_phase: round6((((hour / 24) % 1) + 1) % 1),
    interruption_count: clampInt(interruptionCount, 0, INTERRUPTION_RULES.max_count, 0),
    recovery_progress: round6(clamp01(recovery)),
    last_transition_reason: reason
  };

  const contributions = {
    'sleep.sleepiness': { sleep: round6(next.sleepiness - prev.sleepiness) },
    'sleep.sleep_debt': { sleep: round6(next.sleep_debt - prev.sleep_debt) },
    'sleep.sleep_quality': { sleep: round6(next.sleep_quality - prev.sleep_quality) },
    'sleep.recovery_progress': { sleep: round6(next.recovery_progress - prev.recovery_progress) }
  };

  const reasonCodes = uniq([
    next.state,
    ...(transitioned ? [reason] : [])
  ]).slice(0, 16);

  return {
    state: next,
    contributions,
    reason_codes: reasonCodes,
    warnings: uniq(warningList).slice(0, 16),
    next_transition_at: transitionHint({
      state: next.state,
      stateSinceMs: safeParse(next.state_since),
      plannedWakeAtMs: plannedMs,
      nowMs
    }),
    diagnostics: {
      module: 'sleep',
      model_version: 1,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0
    }
  };
}

/** 02 的 coarseForward 通过 hooks.sleepinessSteady 注入昼夜稳态（00 §5.3 / 02 §5.4）。 */
export const sleepModule = {
  name: 'sleep',
  update: updateSleep,
  sleepinessSteady
};

export { sleepinessSteady };
