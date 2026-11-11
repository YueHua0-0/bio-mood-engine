/**
 * 07 事件与压力模块：两个入口与 ModuleResult 组装。
 *
 * 硬性契约（00 §4.2 / 07 §4.4）：
 * - 只有 applyEvent 可以输出 `derived.event_intensity`；updateStress 的返回对象绝不出现 `derived` 键。
 * - `derived` 在 `inputs.event === null`（纯时间推进）时整键省略，不写 null / 0 占位。
 * - 只写 `stress.*`；`contributions` 只有 `stress.level`，来源键固定 decay / event / silence。
 * - 单步 `stress.level` 变化 ≤ 0.30；active_events ≤ 32；|remaining| < 0.005 剔除。
 */

import { createHash } from 'node:crypto';

import { DELTA_LIMITS, INTERFACE_VERSION, LIMITS } from '../../core/constants.mjs';
import { localParts, parseTime, toIso } from '../../core/clock.mjs';
import { round6 } from '../../core/models.mjs';

import { baseIntensity, computeIntensityDetail, DECAY_PROFILE, isEventType } from './event.mjs';
import { approach, instantResponse, remainingAt, sumRemaining, targetStress } from './decay.mjs';
import { mergeIntensity, pruneAndSort, withinMergeWindow } from './merge.mjs';

const MODEL_VERSION = 1;
const BASE_LEVEL = 0.15;
const MAX_STEP = DELTA_LIMITS.stress.normal;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** 07 §5.7：静默判定阈值（严格大于 6 小时）。 */
const SILENCE_THRESHOLD_MS = 6 * 3_600_000;
const SILENCE_FALLBACK_CONVERSATION = 'primary';

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dedupe(list, max) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.slice(0, max);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isIso(value) {
  if (typeof value !== 'string') return false;
  try {
    parseTime(value, 'time');
    return true;
  } catch {
    return false;
  }
}

function earlierIso(a, b) {
  if (!isIso(a)) return b;
  if (!isIso(b)) return a;
  return parseTime(a, 'a') <= parseTime(b, 'b') ? a : b;
}

function laterIso(a, b) {
  if (!isIso(a)) return isIso(b) ? b : null;
  if (!isIso(b)) return a;
  return parseTime(a, 'a') >= parseTime(b, 'b') ? a : b;
}

/** 00 §4.2：上一时刻 `state.stress`；缺字段按 MISSING_STRESS_DATA 降级。 */
function readPreviousStress(previous, warnings) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    warnings.push('DEGRADED', 'MISSING_STRESS_DATA');
    return {
      level: BASE_LEVEL,
      active_events: [],
      last_decay_at: null,
      last_event_at: null,
      model_version: MODEL_VERSION
    };
  }

  let degraded = false;
  let level = BASE_LEVEL;
  if (typeof previous.level === 'number' && Number.isFinite(previous.level)) {
    level = clamp(previous.level, 0, 1);
    if (level !== previous.level) warnings.push('INPUT_CLAMPED');
  } else {
    degraded = true;
  }

  const activeEvents = Array.isArray(previous.active_events) ? previous.active_events : [];
  if (!Array.isArray(previous.active_events)) degraded = true;

  const lastDecayAt = isIso(previous.last_decay_at) ? previous.last_decay_at : null;
  if (lastDecayAt === null) degraded = true;

  if (degraded) warnings.push('DEGRADED', 'MISSING_STRESS_DATA');

  return {
    level,
    active_events: activeEvents,
    last_decay_at: lastDecayAt,
    last_event_at: isIso(previous.last_event_at) ? previous.last_event_at : null,
    model_version: Number.isInteger(previous.model_version) ? previous.model_version : MODEL_VERSION
  };
}

function elapsedSeconds(lastDecayAt, now, nowMs) {
  if (!lastDecayAt) return { dt: 0, regression: false };
  const fromMs = parseTime(lastDecayAt, 'last_decay_at');
  const dt = Math.floor((nowMs - fromMs) / 1000);
  if (dt < 0) return { dt: 0, regression: true };
  return { dt, regression: false };
}

/** 07 §5.3：旧事件按上一 tick 的 remaining 复合衰减。 */
function decayEvents(events, dtSeconds) {
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    let remaining = Number(ev.remaining);
    const intensity = Number(ev.intensity);
    if (!Number.isFinite(remaining)) {
      if (!Number.isFinite(intensity)) continue;
      remaining = intensity;
    }
    const profile =
      typeof ev.decay_profile === 'string' && Object.hasOwn(DECAY_PROFILE, ev.decay_profile)
        ? ev.decay_profile
        : DECAY_PROFILE[ev.event_type] ?? 'none';
    out.push({
      event_id: ev.event_id,
      event_type: ev.event_type,
      started_at: ev.started_at,
      intensity: Number.isFinite(intensity) ? round6(clamp(intensity, -1, 1)) : round6(clamp(remaining, -1, 1)),
      remaining: remainingAt(remaining, profile, dtSeconds),
      decay_profile: profile,
      source_key: ev.source_key
    });
  }
  return out;
}

function pruneOpts() {
  return { maxActive: LIMITS.maxActiveEvents, threshold: LIMITS.eventPruneThreshold };
}

/** 07 §4.2：普通事件 `wechat:<conversation_id>:<sender_id>`；冲突/管理取 `*`；静默固定 `silence:`。 */
function sourceKeyOf(event) {
  const conversation =
    event?.source?.conversation_id ?? event?.conversation_id ?? SILENCE_FALLBACK_CONVERSATION;
  if (event.event_type === 'long_silence') return `silence:${conversation}`;
  if (event.event_type === 'conflict' || event.event_type === 'admin_command') {
    return `wechat:${conversation}:*`;
  }
  const sender = event?.source?.sender_id ?? event?.sender_id ?? 'unknown';
  return `wechat:${conversation}:${sender}`;
}

function timezoneOf(config) {
  const candidate = config?.timezone;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'UTC';
}

function conversationOf({ activity, config }) {
  const candidate =
    activity?.conversation_id ??
    config?.stress?.silence_conversation_id ??
    config?.conversation_id;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : SILENCE_FALLBACK_CONVERSATION;
}

function localDateKey(nowIso, timezone) {
  let parts;
  try {
    parts = localParts(nowIso, timezone);
  } catch {
    parts = localParts(nowIso, 'UTC');
  }
  return `${String(parts.year).padStart(4, '0')}${pad2(parts.month)}${pad2(parts.day)}`;
}

/**
 * 07 §5.7：确定性 `event_id` 与幂等键（幂等键不含 `:`，见 00 §2.1）。
 * 不拼任何原始 id，只使用 sha256(conversation_id) 前 8 位。
 */
export function silenceIdentity(conversationId, nowIso, timezone = 'UTC') {
  const day = localDateKey(nowIso, timezone);
  const digest = createHash('sha256').update(String(conversationId), 'utf8').digest('hex').slice(0, 8);
  return { day, digest, event_id: `evt_silence_${day}_${digest}`, idempotency_key: `silence_${digest}_${day}` };
}

/**
 * 07 §5.7：惰性生成 `long_silence`。
 * 三条同时满足才有事件：距参考时间 > 6h、无未过期的非静默事件、角色本地当天未生成过。
 */
function maybeBuildSilence({ previous, activity, now, nowMs, config, events }) {
  const references = [];
  if (isIso(activity?.last_event_at)) references.push(activity.last_event_at);
  if (isIso(previous.last_event_at)) references.push(previous.last_event_at);

  if (references.length === 0) {
    const activityMissing =
      !activity || typeof activity !== 'object' || !Object.hasOwn(activity, 'last_event_at');
    return { event: null, warnings: activityMissing ? ['MISSING_ACTIVITY_DATA'] : [] };
  }

  const referenceMs = Math.max(...references.map((value) => parseTime(value, 'last_event_at')));
  if (nowMs - referenceMs <= SILENCE_THRESHOLD_MS) return { event: null, warnings: [] };
  if (events.some((ev) => ev.event_type !== 'long_silence')) return { event: null, warnings: [] };

  const timezone = timezoneOf(config);
  const conversationId = conversationOf({ activity, config });
  const identity = silenceIdentity(conversationId, now, timezone);
  const known = new Set([
    ...(Array.isArray(activity?.recent_event_ids) ? activity.recent_event_ids : []),
    ...events.map((ev) => ev.event_id)
  ]);
  if (known.has(identity.event_id)) return { event: null, warnings: [] };

  const intensity = baseIntensity('long_silence');
  return {
    event: {
      event_id: identity.event_id,
      event_type: 'long_silence',
      started_at: now,
      intensity,
      remaining: intensity,
      decay_profile: DECAY_PROFILE.long_silence,
      source_key: `silence:${conversationId}`
    },
    warnings: []
  };
}

/** 07 §6：事件形状校验；非法时抛 INVALID_REQUEST，状态保持不变。 */
function validateEvent(event, nowMs) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw contractError('INVALID_REQUEST', 'event must be an object', { path: 'inputs.event' });
  }
  if (typeof event.event_id !== 'string' || !EVENT_ID_RE.test(event.event_id)) {
    throw contractError('INVALID_REQUEST', 'event_id must match ^[A-Za-z0-9_-]{8,128}$', {
      path: 'event_id',
      got: String(event.event_id)
    });
  }
  if (!isEventType(event.event_type)) {
    throw contractError('INVALID_REQUEST', `unknown event_type: ${String(event.event_type)}`, {
      path: 'event_type',
      got: String(event.event_type)
    });
  }
  if (event.intensity !== undefined && event.intensity !== null) {
    if (typeof event.intensity !== 'number' || !Number.isFinite(event.intensity)) {
      throw contractError('INVALID_REQUEST', 'intensity must be a finite number', {
        path: 'intensity',
        got: String(event.intensity)
      });
    }
  }
  const occurredMs = parseTime(event.occurred_at, 'occurred_at');
  return { occurredMs, regression: occurredMs > nowMs };
}

function buildResult({ module, state, decay, event: eventDelta, silence, reasonCodes, warnings, derived }) {
  const contribution = {
    decay: round6(Number.isFinite(decay) ? decay : 0),
    event: round6(Number.isFinite(eventDelta) ? eventDelta : 0),
    silence: round6(Number.isFinite(silence) ? silence : 0)
  };
  const result = {
    state,
    contributions: { 'stress.level': contribution },
    reason_codes: dedupe(reasonCodes, LIMITS.maxReasonCodes),
    warnings: dedupe(warnings, LIMITS.maxWarnings),
    next_transition_at: null,
    diagnostics: {
      module,
      model_version: MODEL_VERSION,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0
    }
  };
  if (derived !== undefined) result.derived = derived;
  return result;
}

function stressStateOf({ level, events, now, lastEventAt }) {
  return {
    level: round6(clamp(level, 0, 1)),
    active_events: events,
    last_decay_at: now,
    last_event_at: lastEventAt,
    model_version: MODEL_VERSION
  };
}

/**
 * 00 §5.4 第 6 步：只衰减 + 惰性补 `long_silence`，不应用外部事件。
 * 返回对象**不含** `derived` 键（07 §4.4）。
 */
export function updateStress({ previous, inputs, now, rng, config }) {
  void rng;
  const input = inputs && typeof inputs === 'object' ? inputs : {};
  if (input.event !== null && input.event !== undefined) {
    throw contractError('INVALID_REQUEST', 'updateStress requires inputs.event === null', {
      path: 'inputs.event'
    });
  }

  const warnings = [];
  const reasonCodes = ['stress_decayed'];
  const nowMs = parseTime(now, 'now');
  const prev = readPreviousStress(previous, warnings);
  const { dt, regression } = elapsedSeconds(prev.last_decay_at, now, nowMs);
  if (regression) warnings.push('CLOCK_REGRESSION');

  const startLevel = prev.level;
  const decayed = decayEvents(prev.active_events, dt);
  const first = pruneAndSort(decayed, pruneOpts());
  if (first.evicted) warnings.push('EVENTS_EVICTED');

  const decayStep = approach({
    level: startLevel,
    target: targetStress(sumRemaining(first.events)),
    dtSeconds: dt
  });
  if (decayStep.clamped) warnings.push('STRESS_CLAMPED');
  const levelAfterDecay = decayStep.level;

  const silence = maybeBuildSilence({
    previous: prev,
    activity: input.activity ?? null,
    now,
    nowMs,
    config,
    events: first.events
  });
  warnings.push(...silence.warnings);

  let events = first.events;
  let level = levelAfterDecay;
  let lastEventAt = prev.last_event_at;

  if (silence.event) {
    const inserted = pruneAndSort([...events, silence.event], pruneOpts());
    if (inserted.evicted) warnings.push('EVENTS_EVICTED');
    events = inserted.events;

    const instant = instantResponse({ level, target: targetStress(sumRemaining(events)) });
    if (instant.clamped) warnings.push('STRESS_CLAMPED');
    let nextLevel = instant.level;
    if (Math.abs(nextLevel - startLevel) > MAX_STEP + 1e-9) {
      nextLevel = round6(clamp(startLevel + Math.sign(nextLevel - startLevel) * MAX_STEP, 0, 1));
      warnings.push('STRESS_CLAMPED');
    }
    level = nextLevel;
    lastEventAt = silence.event.started_at;
    reasonCodes.push('long_silence_generated');
  }

  return buildResult({
    module: 'stress',
    state: stressStateOf({ level, events, now, lastEventAt }),
    decay: levelAfterDecay - startLevel,
    event: 0,
    silence: level - levelAfterDecay,
    reasonCodes,
    warnings
  });
}

/**
 * 00 §5.4 第 7 步：应用单条新事件（含即时响应），并输出 `derived.event_intensity`。
 */
export function applyEvent({ previous, inputs, now, rng, config }) {
  void rng;
  void config;
  const input = inputs && typeof inputs === 'object' ? inputs : {};
  const event = input.event ?? null;

  const warnings = [];
  const reasonCodes = [];
  const nowMs = parseTime(now, 'now');
  const prev = readPreviousStress(previous, warnings);
  const { dt, regression } = elapsedSeconds(prev.last_decay_at, now, nowMs);
  if (regression) warnings.push('CLOCK_REGRESSION');

  const startLevel = prev.level;
  const decayed = decayEvents(prev.active_events, dt);
  const first = pruneAndSort(decayed, pruneOpts());
  if (first.evicted) warnings.push('EVENTS_EVICTED');

  const decayStep = approach({
    level: startLevel,
    target: targetStress(sumRemaining(first.events)),
    dtSeconds: dt
  });
  if (decayStep.clamped) warnings.push('STRESS_CLAMPED');
  const levelAfterDecay = decayStep.level;

  // 纯衰减调用：整键省略 derived（07 §4.4 省略条件）。
  if (event === null) {
    return buildResult({
      module: 'event',
      state: stressStateOf({
        level: levelAfterDecay,
        events: first.events,
        now,
        lastEventAt: prev.last_event_at
      }),
      decay: levelAfterDecay - startLevel,
      event: 0,
      silence: 0,
      reasonCodes: ['stress_decayed'],
      warnings
    });
  }

  const { occurredMs, regression: futureEvent } = validateEvent(event, nowMs);
  if (futureEvent) warnings.push('CLOCK_REGRESSION');

  const detail = computeIntensityDetail(event);
  warnings.push(...detail.warnings);
  const intensity = detail.intensity;
  const startedAt = toIso(occurredMs);

  // 07 §5.7 / S13：同 event_id 仍然有效时幂等，不重复计入 Σremaining。
  // 重复事件不改变任何状态，因此也不输出 derived.event_intensity（07 §4.4）：
  // 否则 02 会把"重复消息"当成一次新的 severe 事件。
  if (first.events.some((ev) => ev.event_id === event.event_id)) {
    return buildResult({
      module: 'event',
      state: stressStateOf({
        level: levelAfterDecay,
        events: first.events,
        now,
        lastEventAt: laterIso(prev.last_event_at, startedAt)
      }),
      decay: levelAfterDecay - startLevel,
      event: 0,
      silence: 0,
      reasonCodes: ['duplicate_event'],
      warnings: [...warnings, 'DUPLICATE_EVENT_MERGED']
    });
  }

  let events = first.events;
  let level = levelAfterDecay;
  let eventDelta = 0;

  if (intensity !== 0) {
    const sourceKey = sourceKeyOf(event);
    const candidateIndex = events.findIndex(
      (ev) => ev.source_key === sourceKey && withinMergeWindow(ev.started_at, nowMs)
    );
    const next = events.slice();

    if (candidateIndex >= 0) {
      const existing = next[candidateIndex];
      const merged = mergeIntensity(existing.remaining, intensity);
      if (merged.clamped) warnings.push('MERGE_CLAMPED');
      const profile =
        Math.abs(intensity) > Math.abs(existing.intensity)
          ? DECAY_PROFILE[event.event_type]
          : existing.decay_profile;
      next[candidateIndex] = {
        event_id: existing.event_id,
        event_type: existing.event_type,
        started_at: earlierIso(existing.started_at, startedAt),
        intensity: merged.remaining,
        remaining: merged.remaining,
        decay_profile: profile,
        source_key: existing.source_key
      };
    } else {
      next.push({
        event_id: event.event_id,
        event_type: event.event_type,
        started_at: startedAt,
        intensity,
        remaining: intensity,
        decay_profile: DECAY_PROFILE[event.event_type],
        source_key: sourceKey
      });
    }

    const pruned = pruneAndSort(next, pruneOpts());
    if (pruned.evicted) warnings.push('EVENTS_EVICTED');
    events = pruned.events;

    const instant = instantResponse({ level, target: targetStress(sumRemaining(events)) });
    if (instant.clamped) warnings.push('STRESS_CLAMPED');
    let nextLevel = instant.level;
    if (Math.abs(nextLevel - startLevel) > MAX_STEP + 1e-9) {
      nextLevel = round6(clamp(startLevel + Math.sign(nextLevel - startLevel) * MAX_STEP, 0, 1));
      warnings.push('STRESS_CLAMPED');
    }
    eventDelta = nextLevel - levelAfterDecay;
    level = nextLevel;
  }

  reasonCodes.push('event_applied');

  return buildResult({
    module: 'event',
    state: stressStateOf({
      level,
      events,
      now,
      lastEventAt: laterIso(prev.last_event_at, startedAt)
    }),
    decay: levelAfterDecay - startLevel,
    event: eventDelta,
    silence: 0,
    reasonCodes,
    warnings,
    derived: { event_intensity: intensity }
  });
}

/** 02 §5.5 注册表：两个入口必须按 stress → event 顺序调用。 */
export const stressModule = { name: 'stress', update: updateStress };
export const eventModule = { name: 'event', update: applyEvent };
