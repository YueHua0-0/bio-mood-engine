/**
 * 02 §4.1 / §5.1 / §5.2：CharacterState 的构造、校验、归一化、摘要与指纹。
 *
 * 调用约定（02 §4.1）：
 * - validateState 只在 API/适配层入口调用一次；协调器内部只依赖 normalizeState。
 * - normalizeState 对非有限数值抛 INVALID_REQUEST，绝不静默改成 0。
 */

import { createHash } from 'node:crypto';

import {
  CONFIG_VERSION_AFTER_MIGRATION,
  CYCLE_LENGTH_SOURCES,
  CYCLE_PHASES,
  DEFAULT_STATE,
  ENGINE_VERSION,
  FORBIDDEN_KEYS,
  LIMITS,
  MOOD_KEYS,
  REGULATION_KEYS,
  SCHEMA_VERSION,
  SLEEP_STATES,
  STATE_KEYS,
  BASE_STREAMS,
  RANDOM_ALGORITHM,
  RANDOM_ALGORITHM_VERSION
} from './constants.mjs';

import {
  assertTimeZone,
  localParts,
  localWallToUtc,
  parseTime,
  toIso
} from './clock.mjs';

import { RandomProvider } from './random.mjs';

const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function invalid(path, message, got) {
  return { ok: false, path, code: 'INVALID_REQUEST', message, got };
}

export function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** 范围断言，失败抛 INVALID_REQUEST（00 §9.2）。 */
export function assertInRange(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw contractError('INVALID_REQUEST', `${name} must be within [${min},${max}]`, {
      path: name,
      got: value
    });
  }
  return value;
}

/**
 * 02 §5.1：默认状态工厂。
 *
 * @param {{character_id:string, timezone:string, now:string, engine_version?:string,
 *          master_seed_hex:string, config?:object}} params
 */
export function createDefaultState({
  character_id,
  timezone,
  now,
  engine_version = ENGINE_VERSION,
  master_seed_hex,
  config = {}
}) {
  if (typeof character_id !== 'string' || !CHARACTER_ID_RE.test(character_id)) {
    throw contractError('INVALID_REQUEST', 'character_id must match ^[a-z][a-z0-9_-]{0,63}$', {
      path: 'character_id',
      got: String(character_id)
    });
  }
  assertTimeZone(timezone);
  const nowMs = parseTime(now, 'now');
  const canonicalNow = toIso(nowMs);

  if (!config || typeof config !== 'object') {
    throw contractError('INVALID_REQUEST', 'config must be an object', { path: 'config' });
  }
  const configVersion = Number.isInteger(config.config_version) && config.config_version >= 1
    ? config.config_version
    : CONFIG_VERSION_AFTER_MIGRATION;

  const local = localParts(canonicalNow, timezone);
  // 06 §4.3：planned_wake_at 默认本地 07:30；若已过则顺延到次日。
  let wakeYear = local.year;
  let wakeMonth = local.month;
  let wakeDay = local.day;
  const wakeOffset = localWallToUtc(
    { year: wakeYear, month: wakeMonth, day: wakeDay, hour: 7, minute: 30, second: 0 },
    timezone,
    canonicalNow
  );
  if (wakeOffset <= nowMs) {
    const nextDayMs = nowMs + 86_400_000;
    const nextLocal = localParts(toIso(nextDayMs), timezone);
    wakeYear = nextLocal.year;
    wakeMonth = nextLocal.month;
    wakeDay = nextLocal.day;
  }
  const plannedWakeAt = toIso(
    localWallToUtc(
      { year: wakeYear, month: wakeMonth, day: wakeDay, hour: 7, minute: 30, second: 0 },
      timezone,
      canonicalNow
    )
  );

  const provider = new RandomProvider({
    master_seed_hex,
    character_id,
    algorithm_version: RANDOM_ALGORITHM_VERSION
  });

  const state = {
    schema_version: SCHEMA_VERSION,
    engine_version,
    character_id,
    state_version: 0,
    created_at: canonicalNow,
    updated_at: canonicalNow,
    last_tick_at: canonicalNow,
    timezone,
    config_version: configVersion,
    cycle: {
      anchor_at: canonicalNow,
      cycle_index: DEFAULT_STATE.cycle.cycle_index,
      cycle_length_days: DEFAULT_STATE.cycle.cycle_length_days,
      cycle_length_source: DEFAULT_STATE.cycle.cycle_length_source,
      cycle_day: DEFAULT_STATE.cycle.cycle_day,
      phase: DEFAULT_STATE.cycle.phase,
      phase_started_at: canonicalNow,
      phase_progress: DEFAULT_STATE.cycle.phase_progress,
      confidence: DEFAULT_STATE.cycle.confidence,
      model_version: DEFAULT_STATE.cycle.model_version
    },
    sleep: {
      state: DEFAULT_STATE.sleep.state,
      state_since: canonicalNow,
      sleep_started_at: null,
      last_wake_at: null,
      planned_wake_at: plannedWakeAt,
      sleep_debt: DEFAULT_STATE.sleep.sleep_debt,
      sleep_quality: DEFAULT_STATE.sleep.sleep_quality,
      sleepiness: DEFAULT_STATE.sleep.sleepiness,
      circadian_phase: round6(local.dayFraction % 1),
      interruption_count: DEFAULT_STATE.sleep.interruption_count,
      recovery_progress: DEFAULT_STATE.sleep.recovery_progress,
      last_transition_reason: DEFAULT_STATE.sleep.last_transition_reason
    },
    stress: {
      level: DEFAULT_STATE.stress.level,
      active_events: [],
      last_decay_at: canonicalNow,
      last_event_at: null,
      model_version: DEFAULT_STATE.stress.model_version
    },
    regulation: { ...DEFAULT_STATE.regulation },
    mood: { ...DEFAULT_STATE.mood },
    random: provider.toPersisted()
  };

  return normalizeState(state);
}

function readNumber(obj, path, { min, max, integer = false, nullable = false }) {
  const value = obj;
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(path, 'must be a finite number', String(value));
  }
  if (integer && !Number.isInteger(value)) {
    throw invalid(path, 'must be an integer', value);
  }
  if (value < min || value > max) {
    throw invalid(path, `must be within [${min},${max}]`, value);
  }
  return value;
}

function readTime(obj, path, { nullable = false } = {}) {
  if (obj === null && nullable) return null;
  if (typeof obj !== 'string') {
    throw invalid(path, 'must be a UTC ISO 8601 string with milliseconds', String(obj));
  }
  try {
    parseTime(obj, path);
  } catch (err) {
    throw invalid(path, err.message, obj);
  }
  return obj;
}

function readEnum(obj, path, allowed) {
  if (typeof obj !== 'string' || !allowed.includes(obj)) {
    throw invalid(path, `must be one of ${allowed.join('|')}`, String(obj));
  }
  return obj;
}

/**
 * 严格校验。返回 {ok:true,state} 或结构化错误对象（02 §4.1）。
 */
export function validateState(state, { maxSchemaVersion = SCHEMA_VERSION } = {}) {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return invalid('state', 'state must be an object', typeof state);
    }
    assertNoForbiddenFields(state);

    for (const key of Object.keys(state)) {
      if (!STATE_KEYS.includes(key)) {
        return invalid(key, 'unknown top-level key', key);
      }
    }

    const schema = state.schema_version;
    if (!Number.isInteger(schema) || schema < 1) {
      return { ok: false, path: 'schema_version', code: 'INTERNAL', message: 'schema_version is missing or invalid', got: schema };
    }
    if (schema > maxSchemaVersion) {
      return { ok: false, path: 'schema_version', code: 'STATE_VERSION_CONFLICT', message: 'state schema is newer than this engine', got: schema };
    }
    if (typeof state.engine_version !== 'string' || !SEMVER_RE.test(state.engine_version)) {
      return invalid('engine_version', 'must be semver', String(state.engine_version));
    }
    if (typeof state.character_id !== 'string' || !CHARACTER_ID_RE.test(state.character_id)) {
      return invalid('character_id', 'must match ^[a-z][a-z0-9_-]{0,63}$', String(state.character_id));
    }
    if (!Number.isInteger(state.state_version) || state.state_version < 0) {
      return invalid('state_version', 'must be a non-negative integer', state.state_version);
    }
    readTime(state.created_at, 'created_at');
    readTime(state.updated_at, 'updated_at');
    readTime(state.last_tick_at, 'last_tick_at');
    if (typeof state.timezone !== 'string') {
      return invalid('timezone', 'must be an IANA timezone name', String(state.timezone));
    }
    try {
      assertTimeZone(state.timezone);
    } catch (err) {
      return invalid('timezone', err.message, state.timezone);
    }
    if (!Number.isInteger(state.config_version) || state.config_version < 1) {
      return invalid('config_version', 'must be an integer >= 1', state.config_version);
    }

    // cycle
    const cycle = state.cycle;
    if (!cycle || typeof cycle !== 'object') return invalid('cycle', 'is required', typeof cycle);
    readTime(cycle.anchor_at, 'cycle.anchor_at');
    readNumber(cycle.cycle_index, 'cycle.cycle_index', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
    const lengthDays = readNumber(cycle.cycle_length_days, 'cycle.cycle_length_days', {
      min: LIMITS.minCycleLengthDays,
      max: LIMITS.maxCycleLengthDays
    });
    readEnum(cycle.cycle_length_source, 'cycle.cycle_length_source', CYCLE_LENGTH_SOURCES);
    readNumber(cycle.cycle_day, 'cycle.cycle_day', { min: 1, max: lengthDays });
    readEnum(cycle.phase, 'cycle.phase', CYCLE_PHASES);
    readTime(cycle.phase_started_at, 'cycle.phase_started_at');
    const progress = readNumber(cycle.phase_progress, 'cycle.phase_progress', { min: 0, max: 1 });
    if (progress >= 1) return invalid('cycle.phase_progress', 'must be within [0,1)', progress);
    readNumber(cycle.confidence, 'cycle.confidence', { min: 0, max: 1 });
    readNumber(cycle.model_version, 'cycle.model_version', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });

    // sleep
    const sleep = state.sleep;
    if (!sleep || typeof sleep !== 'object') return invalid('sleep', 'is required', typeof sleep);
    readEnum(sleep.state, 'sleep.state', SLEEP_STATES);
    readTime(sleep.state_since, 'sleep.state_since');
    readTime(sleep.sleep_started_at, 'sleep.sleep_started_at', { nullable: true });
    readTime(sleep.last_wake_at, 'sleep.last_wake_at', { nullable: true });
    readTime(sleep.planned_wake_at, 'sleep.planned_wake_at', { nullable: true });
    readNumber(sleep.sleep_debt, 'sleep.sleep_debt', { min: 0, max: 1 });
    readNumber(sleep.sleep_quality, 'sleep.sleep_quality', { min: 0.2, max: 0.98 });
    readNumber(sleep.sleepiness, 'sleep.sleepiness', { min: 0, max: 1 });
    const circadian = readNumber(sleep.circadian_phase, 'sleep.circadian_phase', { min: 0, max: 1 });
    if (circadian >= 1) return invalid('sleep.circadian_phase', 'must be within [0,1)', circadian);
    readNumber(sleep.interruption_count, 'sleep.interruption_count', { min: 0, max: 20, integer: true });
    readNumber(sleep.recovery_progress, 'sleep.recovery_progress', { min: 0, max: 1 });
    if (typeof sleep.last_transition_reason !== 'string' || sleep.last_transition_reason.length === 0) {
      return invalid('sleep.last_transition_reason', 'must be a non-empty string', String(sleep.last_transition_reason));
    }

    // stress
    const stress = state.stress;
    if (!stress || typeof stress !== 'object') return invalid('stress', 'is required', typeof stress);
    readNumber(stress.level, 'stress.level', { min: 0, max: 1 });
    if (!Array.isArray(stress.active_events)) return invalid('stress.active_events', 'must be an array', typeof stress.active_events);
    if (stress.active_events.length > LIMITS.maxActiveEvents) {
      return invalid('stress.active_events', `must hold at most ${LIMITS.maxActiveEvents} events`, stress.active_events.length);
    }
    for (let i = 0; i < stress.active_events.length; i += 1) {
      const ev = stress.active_events[i];
      const base = `stress.active_events[${i}]`;
      if (!ev || typeof ev !== 'object') return invalid(base, 'must be an object', typeof ev);
      if (typeof ev.event_id !== 'string' || !EVENT_ID_RE.test(ev.event_id)) {
        return invalid(`${base}.event_id`, 'must match ^[A-Za-z0-9_-]{8,128}$', String(ev.event_id));
      }
      if (typeof ev.event_type !== 'string') return invalid(`${base}.event_type`, 'must be a string', String(ev.event_type));
      readTime(ev.started_at, `${base}.started_at`);
      readNumber(ev.intensity, `${base}.intensity`, { min: -1, max: 1 });
      readNumber(ev.remaining, `${base}.remaining`, { min: -1, max: 1 });
      if (typeof ev.decay_profile !== 'string') return invalid(`${base}.decay_profile`, 'must be a string', String(ev.decay_profile));
      if (typeof ev.source_key !== 'string' || ev.source_key.length === 0) {
        return invalid(`${base}.source_key`, 'must be a non-empty string', String(ev.source_key));
      }
    }
    readTime(stress.last_decay_at, 'stress.last_decay_at');
    readTime(stress.last_event_at, 'stress.last_event_at', { nullable: true });
    readNumber(stress.model_version, 'stress.model_version', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });

    // regulation
    const regulation = state.regulation;
    if (!regulation || typeof regulation !== 'object') return invalid('regulation', 'is required', typeof regulation);
    for (const key of REGULATION_KEYS) {
      readNumber(regulation[key], `regulation.${key}`, { min: 0, max: 1 });
    }
    readNumber(regulation.model_version, 'regulation.model_version', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });

    // mood
    const mood = state.mood;
    if (!mood || typeof mood !== 'object') return invalid('mood', 'is required', typeof mood);
    for (const key of MOOD_KEYS) {
      readNumber(mood[key], `mood.${key}`, { min: 0, max: 1 });
    }
    readNumber(mood.model_version, 'mood.model_version', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });

    // random
    const random = state.random;
    if (!random || typeof random !== 'object') return invalid('random', 'is required', typeof random);
    if (random.algorithm !== RANDOM_ALGORITHM) return invalid('random.algorithm', `must be "${RANDOM_ALGORITHM}"`, String(random.algorithm));
    if (random.algorithm_version !== RANDOM_ALGORITHM_VERSION) {
      return invalid('random.algorithm_version', `must be ${RANDOM_ALGORITHM_VERSION}`, random.algorithm_version);
    }
    if (typeof random.master_seed_hex !== 'string' || !HEX32_RE.test(random.master_seed_hex)) {
      return invalid('random.master_seed_hex', 'must be 32 lowercase hex characters', String(random.master_seed_hex));
    }
    const streamKeys = Object.keys(random.streams ?? {});
    const expected = [...BASE_STREAMS].sort();
    const actual = [...streamKeys].sort();
    if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
      return invalid('random.streams', `keys must be exactly ${BASE_STREAMS.join('|')}`, streamKeys.join(','));
    }
    for (const label of BASE_STREAMS) {
      const entry = random.streams[label];
      if (!entry || typeof entry !== 'object') return invalid(`random.streams.${label}`, 'is required', typeof entry);
      if (typeof entry.seed_hex !== 'string' || !HEX32_RE.test(entry.seed_hex)) {
        return invalid(`random.streams.${label}.seed_hex`, 'must be 32 lowercase hex characters', String(entry.seed_hex));
      }
      if (!Number.isInteger(entry.counter) || entry.counter < 0) {
        return invalid(`random.streams.${label}.counter`, 'must be a non-negative integer', entry.counter);
      }
    }

    return { ok: true, state };
  } catch (err) {
    if (err && typeof err === 'object' && 'path' in err) return err;
    if (err && typeof err === 'object' && err.details && 'path' in err.details) {
      return {
        ok: false,
        path: err.details.path,
        code: err.code ?? 'INVALID_REQUEST',
        message: err.message,
        got: err.details.got ?? null
      };
    }
    return { ok: false, path: null, code: 'INTERNAL', message: err?.message ?? String(err), got: null };
  }
}

/**
 * 02 §5.2：裁剪 + round6 + 去 -0 + 数组清洗。返回新对象，不修改入参。
 */
export function normalizeState(state) {
  if (!state || typeof state !== 'object') {
    throw contractError('INVALID_REQUEST', 'state must be an object', { path: 'state' });
  }
  const num = (value, path, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw contractError('INVALID_REQUEST', `${path} must be a finite number`, { path, got: String(value) });
    }
    return round6(Math.min(max, Math.max(min, n)));
  };

  const out = {
    schema_version: state.schema_version,
    engine_version: state.engine_version,
    character_id: state.character_id,
    state_version: state.state_version,
    created_at: state.created_at,
    updated_at: state.updated_at,
    last_tick_at: state.last_tick_at,
    timezone: state.timezone,
    config_version: state.config_version,
    cycle: {
      anchor_at: state.cycle.anchor_at,
      cycle_index: state.cycle.cycle_index,
      cycle_length_days: num(state.cycle.cycle_length_days, 'cycle.cycle_length_days', LIMITS.minCycleLengthDays, LIMITS.maxCycleLengthDays),
      cycle_length_source: state.cycle.cycle_length_source,
      cycle_day: num(state.cycle.cycle_day, 'cycle.cycle_day', 1, LIMITS.maxCycleLengthDays),
      phase: state.cycle.phase,
      phase_started_at: state.cycle.phase_started_at,
      phase_progress: num(state.cycle.phase_progress, 'cycle.phase_progress', 0, 0.999999),
      confidence: num(state.cycle.confidence, 'cycle.confidence', 0, 1),
      model_version: state.cycle.model_version
    },
    sleep: {
      state: state.sleep.state,
      state_since: state.sleep.state_since,
      sleep_started_at: state.sleep.sleep_started_at ?? null,
      last_wake_at: state.sleep.last_wake_at ?? null,
      planned_wake_at: state.sleep.planned_wake_at ?? null,
      sleep_debt: num(state.sleep.sleep_debt, 'sleep.sleep_debt', 0, 1),
      sleep_quality: num(state.sleep.sleep_quality, 'sleep.sleep_quality', 0.2, 0.98),
      sleepiness: num(state.sleep.sleepiness, 'sleep.sleepiness', 0, 1),
      circadian_phase: num(state.sleep.circadian_phase, 'sleep.circadian_phase', 0, 0.999999),
      interruption_count: state.sleep.interruption_count,
      recovery_progress: num(state.sleep.recovery_progress, 'sleep.recovery_progress', 0, 1),
      last_transition_reason: state.sleep.last_transition_reason
    },
    stress: {
      level: num(state.stress.level, 'stress.level', 0, 1),
      active_events: normalizeActiveEvents(state.stress.active_events),
      last_decay_at: state.stress.last_decay_at,
      last_event_at: state.stress.last_event_at ?? null,
      model_version: state.stress.model_version
    },
    regulation: { model_version: state.regulation.model_version },
    mood: { model_version: state.mood.model_version },
    random: {
      algorithm: state.random.algorithm,
      algorithm_version: state.random.algorithm_version,
      master_seed_hex: state.random.master_seed_hex,
      streams: normalizeStreams(state.random.streams)
    }
  };

  for (const key of REGULATION_KEYS) {
    out.regulation[key] = num(state.regulation[key], `regulation.${key}`, 0, 1);
  }
  for (const key of MOOD_KEYS) {
    out.mood[key] = num(state.mood[key], `mood.${key}`, 0, 1);
  }
  return out;
}

function normalizeActiveEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const byId = new Map();
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    const remaining = Number(ev.remaining);
    if (!Number.isFinite(remaining)) continue;
    if (Math.abs(remaining) < LIMITS.eventPruneThreshold) continue;
    const candidate = {
      event_id: ev.event_id,
      event_type: ev.event_type,
      started_at: ev.started_at,
      intensity: round6(Number(ev.intensity)),
      remaining: round6(remaining),
      decay_profile: ev.decay_profile,
      source_key: ev.source_key
    };
    const existing = byId.get(candidate.event_id);
    if (!existing || Math.abs(candidate.remaining) > Math.abs(existing.remaining)) {
      byId.set(candidate.event_id, candidate);
    }
  }
  return [...byId.values()]
    .sort((a, b) => Math.abs(b.remaining) - Math.abs(a.remaining))
    .slice(0, LIMITS.maxActiveEvents);
}

function normalizeStreams(streams) {
  const out = {};
  for (const label of BASE_STREAMS) {
    const entry = streams?.[label];
    out[label] = { seed_hex: entry?.seed_hex, counter: entry?.counter };
  }
  return out;
}

/** 00 §12.4 / 12 §4.1.1：只读投影（脱敏），不是完整状态。 */
export function stateSummary(state) {
  const masterSeedId = createHash('sha256')
    .update(state.random.master_seed_hex, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return {
    character_id: state.character_id,
    timezone: state.timezone,
    state_version: state.state_version,
    updated_at: state.updated_at,
    cycle: {
      phase: state.cycle.phase,
      cycle_day: state.cycle.cycle_day,
      phase_progress: state.cycle.phase_progress,
      confidence: state.cycle.confidence
    },
    sleep: {
      state: state.sleep.state,
      sleep_debt: state.sleep.sleep_debt,
      sleepiness: state.sleep.sleepiness,
      planned_wake_at: state.sleep.planned_wake_at
    },
    stress: {
      level: state.stress.level,
      active_event_count: state.stress.active_events.length
    },
    mood: Object.fromEntries(MOOD_KEYS.map((k) => [k, state.mood[k]])),
    regulation: Object.fromEntries(REGULATION_KEYS.map((k) => [k, state.regulation[k]])),
    random: {
      algorithm: state.random.algorithm,
      algorithm_version: state.random.algorithm_version,
      master_seed_id: masterSeedId
    }
  };
}

/** 稳定序列化：键按字典序递归排序，保证指纹可复现。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256(规范化 JSON) 前 16 hex，用于测试断言（02 §4.1）。 */
export function stateFingerprint(state) {
  return createHash('sha256').update(stableStringify(normalizeState(state)), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 00 §3.3：禁止字段扫描。命中时抛 INVALID_REQUEST。
 */
export function assertNoForbiddenFields(obj, path = '') {
  if (obj === null || typeof obj !== 'object') return true;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return true;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw contractError('INVALID_REQUEST', `forbidden field: ${key}`, {
        path: path ? `${path}.${key}` : key,
        got: key
      });
    }
    assertNoForbiddenFields(value, path ? `${path}.${key}` : key);
  }
  return true;
}
