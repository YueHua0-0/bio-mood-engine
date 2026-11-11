/**
 * 16 §3.1 / §5：仿真脚本校验与事件排序。
 *
 * 只做纯校验与格式转换，不推进引擎、不写文件：
 * - 时间错误 → INVALID_TIME；区间/字段/种子错误 → INVALID_REQUEST；
 * - 事件超过 20,000 条 → PAYLOAD_TOO_LARGE；
 * - 种子必须来自 tests/fixtures/seeds.json（禁止真实角色种子）；
 * - 事件按 at 升序稳定排序，同一时刻保留输入顺序。
 */

import { readFileSync } from 'node:fs';

import { parseTime } from '../../lib/core/clock.mjs';
import { assertTimeZone } from '../../lib/core/clock.mjs';
import { assertNoForbiddenFields } from '../../lib/core/models.mjs';
import { EVENT_TYPES, RELATIONSHIP_TAGS } from '../../lib/modules/stress/event.mjs';

export const MAX_EVENTS = 20_000;
export const DEFAULT_STEP_SECONDS = 3600;

const HEX32_RE = /^[0-9a-f]{32}$/;
const SCENARIO_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export const TRACKED_PATHS = Object.freeze([
  'sleep.sleepiness',
  'sleep.sleep_debt',
  'stress.level',
  'cycle.phase_progress'
]);

export class SimError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SimError';
    this.code = code;
    this.details = details;
  }
}

let cachedSeeds = null;

/** 读取测试种子白名单（只读文件，不缓存到磁盘）。 */
export function loadSeedWhitelist() {
  if (cachedSeeds) return cachedSeeds;
  const url = new URL('../../tests/fixtures/seeds.json', import.meta.url);
  let raw;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (cause) {
    throw new SimError('INVALID_REQUEST', `cannot read tests/fixtures/seeds.json: ${cause.message}`);
  }
  const seeds = Array.isArray(raw?.seeds) ? raw.seeds : [];
  const set = new Set();
  for (const seed of seeds) {
    if (typeof seed === 'string' && HEX32_RE.test(seed)) set.add(seed);
  }
  if (set.size === 0) {
    throw new SimError('INVALID_REQUEST', 'tests/fixtures/seeds.json must list at least one 32-hex seed');
  }
  cachedSeeds = set;
  return cachedSeeds;
}

function fail(code, message, details) {
  throw new SimError(code, message, details);
}

function parseIso(value, field) {
  try {
    return parseTime(value, field);
  } catch (cause) {
    throw new SimError('INVALID_TIME', `${field}: ${cause.message}`, { field, got: value });
  }
}

function readString(obj, key, { required = true, fallback = null, pattern = null, label = key } = {}) {
  const value = obj?.[key];
  if (value === undefined || value === null) {
    if (!required) return fallback;
    fail('INVALID_REQUEST', `${label} is required`, { path: key });
  }
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_REQUEST', `${label} must be a non-empty string`, { path: key, got: value });
  }
  if (pattern && !pattern.test(value)) {
    fail('INVALID_REQUEST', `${label} has an invalid format`, { path: key, got: value });
  }
  return value;
}

function readBoolean(obj, key, fallback = false) {
  const value = obj?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    fail('INVALID_REQUEST', `${key} must be a boolean`, { path: key, got: value });
  }
  return value;
}

function parseStepSeconds(raw) {
  if (raw === undefined || raw === null) return DEFAULT_STEP_SECONDS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    fail('INVALID_REQUEST', 'step_seconds must be a positive integer', {
      path: 'step_seconds',
      got: raw
    });
  }
  if (raw % 3600 !== 0) {
    fail('INVALID_REQUEST', 'step_seconds must be a multiple of 3600', {
      path: 'step_seconds',
      got: raw
    });
  }
  return raw;
}

function parseAssertions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxDelta = source.max_abs_delta_per_step ?? 0.15;
  if (typeof maxDelta !== 'number' || !Number.isFinite(maxDelta) || maxDelta <= 0) {
    fail('INVALID_REQUEST', 'assertions.max_abs_delta_per_step must be a positive number', {
      path: 'assertions.max_abs_delta_per_step'
    });
  }
  const noEdge = source.no_edge_run_hours ?? 72;
  if (typeof noEdge !== 'number' || !Number.isFinite(noEdge) || noEdge <= 0) {
    fail('INVALID_REQUEST', 'assertions.no_edge_run_hours must be a positive number', {
      path: 'assertions.no_edge_run_hours'
    });
  }
  const ranges = source.mean_ranges ?? {};
  if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges)) {
    fail('INVALID_REQUEST', 'assertions.mean_ranges must be an object', {
      path: 'assertions.mean_ranges'
    });
  }
  const meanRanges = {};
  for (const [path, value] of Object.entries(ranges)) {
    if (!Array.isArray(value) || value.length !== 2) {
      fail('INVALID_REQUEST', `assertions.mean_ranges.${path} must be [min,max]`, {
        path: `assertions.mean_ranges.${path}`
      });
    }
    const [min, max] = value;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      fail('INVALID_REQUEST', `assertions.mean_ranges.${path} must be finite min <= max`, {
        path: `assertions.mean_ranges.${path}`
      });
    }
    meanRanges[path] = [min, max];
  }
  return {
    max_abs_delta_per_step: maxDelta,
    mean_ranges: meanRanges,
    no_edge_run_hours: noEdge
  };
}

function normalizeEvent(raw, index, { startMs, endMs }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_REQUEST', `events[${index}] must be an object`, { index });
  }
  const at = raw.at;
  const atMs = parseIso(at, `events[${index}].at`);
  if (atMs < startMs || atMs >= endMs) {
    fail('INVALID_REQUEST', `events[${index}].at is outside [start_at,end_at)`, {
      index,
      at,
      start_at: raw.start_at ?? null
    });
  }
  const eventId = readString(raw, 'event_id', {
    pattern: EVENT_ID_RE,
    label: `events[${index}].event_id`
  });
  const eventType = readString(raw, 'event_type', { label: `events[${index}].event_type` });
  if (!EVENT_TYPES.includes(eventType)) {
    fail('INVALID_REQUEST', `events[${index}].event_type is not in the frozen enum`, {
      index,
      event_type: eventType
    });
  }
  const relationshipTag = raw.relationship_tag ?? 'ordinary';
  if (typeof relationshipTag !== 'string') {
    fail('INVALID_REQUEST', `events[${index}].relationship_tag must be a string`, { index });
  }
  const conversationId = raw.conversation_id ?? 'sim_conversation';
  const senderId = raw.sender_id ?? 'sim_sender';
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    fail('INVALID_REQUEST', `events[${index}].conversation_id must be a non-empty string`, { index });
  }
  if (typeof senderId !== 'string' || senderId.length === 0) {
    fail('INVALID_REQUEST', `events[${index}].sender_id must be a non-empty string`, { index });
  }
  const isMentioned = readBoolean(raw, 'is_mentioned');
  const isDirectQuestion = readBoolean(raw, 'is_direct_question');
  let intensityOverride;
  if (raw.intensity_override !== undefined && raw.intensity_override !== null) {
    const value = raw.intensity_override;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
      fail('INVALID_REQUEST', `events[${index}].intensity_override must be within [-1,1]`, {
        index,
        got: value
      });
    }
    intensityOverride = value;
  }
  if (!RELATIONSHIP_TAGS.includes(relationshipTag)) {
    // 未知关系标签由 07 降级为 unknown，不阻断仿真；保留原值供报告追踪。
  }
  return {
    index,
    at,
    atMs,
    engine: {
      event_id: eventId,
      event_type: eventType,
      occurred_at: at,
      received_at: at,
      source: {
        platform: 'wechat',
        conversation_id: conversationId,
        conversation_kind: 'group',
        sender_id: senderId,
        is_mentioned: isMentioned,
        is_direct_question: isDirectQuestion,
        relationship_tag: relationshipTag
      },
      payload: {
        message_type: 'text',
        is_direct_question: isDirectQuestion
      },
      ...(intensityOverride === undefined ? {} : { intensity_override: intensityOverride })
    }
  };
}

/**
 * 校验并规范化脚本（纯函数）。
 *
 * @param {object} raw 已解析的 JSON 对象
 * @param {{seedWhitelist?:Set<string>}} [options]
 */
export function parseScenario(raw, { seedWhitelist = loadSeedWhitelist() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_REQUEST', 'scenario must be a JSON object');
  }
  try {
    assertNoForbiddenFields(raw);
  } catch (cause) {
    fail(cause.code ?? 'INVALID_REQUEST', cause.message, cause.details);
  }

  const scenarioId = readString(raw, 'scenario_id', {
    pattern: SCENARIO_ID_RE,
    label: 'scenario_id'
  });
  const characterId = readString(raw, 'character_id', {
    pattern: CHARACTER_ID_RE,
    label: 'character_id'
  });
  const timezone = readString(raw, 'timezone', { label: 'timezone' });
  try {
    assertTimeZone(timezone);
  } catch (cause) {
    fail('INVALID_REQUEST', cause.message, { path: 'timezone', got: timezone });
  }

  const seed = raw.master_seed_hex;
  if (typeof seed !== 'string' || !HEX32_RE.test(seed)) {
    fail('INVALID_REQUEST', 'master_seed_hex must be 32 lowercase hex characters', {
      path: 'master_seed_hex',
      got: seed
    });
  }
  if (!seedWhitelist.has(seed)) {
    fail('INVALID_REQUEST', 'master_seed_hex is not in tests/fixtures/seeds.json', {
      path: 'master_seed_hex'
    });
  }

  if (raw.start_at === undefined || raw.start_at === null) {
    fail('INVALID_TIME', 'start_at is required', { field: 'start_at' });
  }
  const startMs = parseIso(raw.start_at, 'start_at');
  const endMs = parseIso(raw.end_at, 'end_at');
  if (endMs <= startMs) {
    fail('INVALID_REQUEST', 'end_at must be greater than start_at', {
      start_at: raw.start_at,
      end_at: raw.end_at
    });
  }
  const stepSeconds = parseStepSeconds(raw.step_seconds);

  const configOverrides = raw.config_overrides ?? {};
  if (!configOverrides || typeof configOverrides !== 'object' || Array.isArray(configOverrides)) {
    fail('INVALID_REQUEST', 'config_overrides must be an object', { path: 'config_overrides' });
  }

  if (!Array.isArray(raw.events)) {
    fail('INVALID_REQUEST', 'events must be an array', { path: 'events' });
  }
  if (raw.events.length > MAX_EVENTS) {
    fail('PAYLOAD_TOO_LARGE', `events must contain at most ${MAX_EVENTS} items`, {
      count: raw.events.length,
      max: MAX_EVENTS
    });
  }
  const events = raw.events.map((event, index) =>
    normalizeEvent(event, index, { startMs, endMs })
  );
  events.sort((a, b) => (a.atMs === b.atMs ? a.index - b.index : a.atMs - b.atMs));

  const assertions = parseAssertions(raw.assertions);

  return {
    scenario_id: scenarioId,
    description: typeof raw.description === 'string' ? raw.description : '',
    character_id: characterId,
    timezone,
    master_seed_hex: seed,
    start_at: raw.start_at,
    end_at: raw.end_at,
    start_ms: startMs,
    end_ms: endMs,
    step_seconds: stepSeconds,
    config_overrides: configOverrides,
    events,
    assertions
  };
}

/** 读取并校验脚本文件。 */
export function loadScenarioFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new SimError('INVALID_REQUEST', `cannot read scenario: ${cause.message}`, { file: filePath });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new SimError('INVALID_REQUEST', `scenario is not valid JSON: ${cause.message}`, {
      file: filePath
    });
  }
  return parseScenario(raw);
}

export { HEX32_RE };
