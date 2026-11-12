/**
 * 02 §4.3 / §5.5 / §5.6 / §5.7：固定流水线、失败回滚、变化上限校验、版本校验与互斥。
 *
 * 关键设计：
 * - 唯一的推进入口是 advance（00 §11.4）；10/11 由协调器内部按第 7/8 步调用。
 * - 事件只在最后一个 chunk 应用，避免离线多日时重复计入（02 §5.5）。
 * - 时间片细分采用"随机快照回滚 + 重算"，禁止消耗两倍随机数。
 * - 本文件不读取任何墙钟（02 §9 自检禁止 wall-clock / performance 计时）；
 *   module_ms 完全来自各模块自报的 diagnostics.elapsed_ms。
 */

import {
  CYCLE_SCALARS,
  CYCLE_SCALARS_FALLBACK,
  DELTA_LIMITS,
  INTERFACE_VERSION,
  LIMITS,
  MODULE_ORDER,
  MODULE_STATE_KEY,
  MOOD_KEYS,
  REGULATION_KEYS
} from './constants.mjs';

import {
  chunkElapsed,
  coarseForward,
  diffSeconds,
  effectiveNow,
  parseTime,
  toIso
} from './clock.mjs';

import { normalizeState, round6 } from './models.mjs';

function contractError(code, message, details) {
  const err = new Error(message);
  err.retryable = code === 'STATE_VERSION_CONFLICT';
  err.code = code;
  if (details) err.details = details;
  return err;
}

function moduleFailed(name, cause, extra) {
  return contractError('MODULE_FAILED', `module ${name} failed: ${cause?.message ?? String(cause)}`, {
    module: name,
    ...(extra ?? {})
  });
}

/** 02 §5.7：乐观锁校验（纯函数）。 */
export function checkVersion({ expectedVersion, actualVersion }) {
  if (expectedVersion !== actualVersion) {
    throw contractError('STATE_VERSION_CONFLICT', 'state_version conflict', {
      expected: expectedVersion,
      actual: actualVersion
    });
  }
  return true;
}

/**
 * 02 §5.7：把"读-算-写"串起来的最小互斥。
 * 纯函数核心不加锁，由 API / 适配层用本函数包住同一 character_id 的推进。
 */
export function createMutex() {
  let tail = Promise.resolve();
  const runExclusive = (fn) => {
    if (typeof fn !== 'function') {
      return Promise.reject(contractError('INVALID_REQUEST', 'createMutex() requires a function'));
    }
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  runExclusive.isLocked = () => false;
  return runExclusive;
}

function assertModules(modules) {
  if (!Array.isArray(modules)) {
    throw contractError('INVALID_REQUEST', 'modules must be an array', { path: 'modules' });
  }
  let lastIndex = -1;
  const seen = new Set();
  for (const mod of modules) {
    if (!mod || typeof mod !== 'object' || typeof mod.name !== 'string' || typeof mod.update !== 'function') {
      throw contractError('INVALID_REQUEST', 'each module must be { name, update }', {
        path: 'modules'
      });
    }
    const index = MODULE_ORDER.indexOf(mod.name);
    if (index < 0) {
      throw contractError('INVALID_REQUEST', `unknown module: ${mod.name}`, { module: mod.name });
    }
    if (seen.has(mod.name)) {
      throw contractError('INVALID_REQUEST', `duplicate module: ${mod.name}`, { module: mod.name });
    }
    if (index < lastIndex) {
      throw contractError('INVALID_REQUEST', `modules must follow the order of 00 §5.4 (${MODULE_ORDER.join(' > ')})`, {
        module: mod.name
      });
    }
    lastIndex = index;
    seen.add(mod.name);
  }
}

function sanitizeLabel(raw) {
  const cleaned = String(raw).toLowerCase().replace(/[^a-z0-9:_-]/g, '_').slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'event';
}

function streamLabelFor(name, state, event) {
  switch (name) {
    case 'cycle':
      return `cycle:${state.cycle.cycle_index}`;
    case 'sleep':
      return 'sleep';
    case 'stress':
      return 'event';
    case 'event':
      return event && event.event_id ? sanitizeLabel(`event:${event.event_id}`) : 'event';
    case 'regulation':
    case 'mood':
      return 'mood';
    default:
      return 'delivery';
  }
}

/** 08 / 09 共用的睡眠三量（06 输出）。 */
function sleepNumbers(state) {
  return {
    sleep_debt: state.sleep.sleep_debt,
    sleep_quality: state.sleep.sleep_quality,
    sleepiness: state.sleep.sleepiness
  };
}

/** 09 的 `inputs.cycle.scalars`：复用 08 §5.1 的冻结映射，非法阶段回落 0.50。 */
function cycleScalarsFor(phase) {
  const scalars = CYCLE_SCALARS[phase];
  return {
    cycle_sensitivity: scalars ? scalars.cycle_sensitivity : CYCLE_SCALARS_FALLBACK
  };
}

function activityOf(state) {
  const ids = (state.stress.active_events ?? []).map((ev) => ev.event_id);
  return { last_event_at: state.stress.last_event_at, recent_event_ids: ids };
}

/**
 * 各模块 §4.2 声明的 inputs 字段（只传声明过的键，避免隐式耦合）。
 * 字段表与 tests/fixtures/assembly.shape.json 一一对应，由 _assembly.test.mjs 锁定。
 */
function buildInputs(name, { state, event, now, derived, queue, urgent, dt, eventIntensity = null, urgentInterrupt = false }) {
  const activity = activityOf(state);
  switch (name) {
    case 'cycle':
      return {};
    case 'sleep':
      // 06 §4.2 / C-06-01：打断强度只传 07 的 derived.event_intensity，不传原始 event；
      // urgent 仅阻断入睡，urgent_interrupt 仅强制唤醒，两者拆名。
      return {
        urgent: Boolean(urgent),
        urgent_interrupt: Boolean(urgentInterrupt),
        event_intensity: typeof eventIntensity === 'number' ? eventIntensity : null,
        planned_wake_at: state.sleep.planned_wake_at
      };
    case 'stress':
      return { event: null, activity };
    case 'event':
      return { event, activity };
    case 'regulation':
      return {
        cycle: { phase: state.cycle.phase },
        sleep: sleepNumbers(state),
        stress: { level: state.stress.level, active_events: state.stress.active_events },
        mood: {
          energy: state.mood.energy,
          stability: state.mood.stability,
          closeness_need: state.mood.closeness_need
        },
        dt
      };
    case 'mood': {
      // 09 §4.2：phase_vector 只能来自 05 的 derived.phase_impact（降级时整键省略），
      // scalars 必须嵌在 inputs.cycle 下，禁止平铺到 inputs 顶层。
      const cycle = { phase: state.cycle.phase };
      if (derived.phase_impact) cycle.phase_vector = derived.phase_impact;
      cycle.scalars = cycleScalarsFor(state.cycle.phase);
      return {
        cycle,
        sleep: sleepNumbers(state),
        stress: { level: state.stress.level },
        regulation: {
          reward_sensitivity: state.regulation.reward_sensitivity,
          arousal: state.regulation.arousal,
          threat_sensitivity: state.regulation.threat_sensitivity,
          calm_regulation: state.regulation.calm_regulation,
          social_reassurance_drive: state.regulation.social_reassurance_drive,
          fatigue_load: state.regulation.fatigue_load
        },
        event: {
          // 09 §4.2：intensity 只能来自 07 的 derived.event_intensity（00 v1.7.5 §4.2）。
          // 不回退到原始 event.intensity，否则调用方可绕过 computeIntensity / override / 倍率。
          intensity: typeof derived.event_intensity === 'number' ? derived.event_intensity : null
        },
        dt
      };
    }
    case 'behavior':
      return {
        mood: {
          energy: state.mood.energy,
          stability: state.mood.stability,
          sensitivity: state.mood.sensitivity,
          social_drive: state.mood.social_drive,
          closeness_need: state.mood.closeness_need,
          physical_comfort: state.mood.physical_comfort
        },
        sleep: {
          state: state.sleep.state,
          sleepiness: state.sleep.sleepiness,
          sleep_debt: state.sleep.sleep_debt
        },
        stress: { level: state.stress.level },
        now
      };
    case 'delivery':
      return {
        event: event
          ? {
              event_type: event.event_type,
              is_mentioned: event?.source?.is_mentioned ?? Boolean(event.is_mentioned),
              event_id: event.event_id,
              conversation_id: event?.source?.conversation_id ?? event.conversation_id ?? null
            }
          : null,
        sleep: {
          state: state.sleep.state,
          sleepiness: state.sleep.sleepiness,
          sleep_debt: state.sleep.sleep_debt,
          planned_wake_at: state.sleep.planned_wake_at
        },
        queue: { pending: Array.isArray(queue) ? queue : [] }
      };
    default:
      return {};
  }
}

function assertFiniteNumber(name, path, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw moduleFailed(name, new Error(`${path} must be a finite number`), { path });
  }
  return value;
}

/**
 * 02 §5.6：协调器统一执行变化上限校验。
 * - mood 超过硬上限 0.15 → 断言失败（MODULE_FAILED，不裁剪）。
 * - 其余超出裁剪档 → 裁剪到上限并追加 CLAMPED_DELTA。
 */
function enforceDeltaLimits({ name, previous, next, severe, warnings }) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw moduleFailed(name, new Error('state must be an object'));
  }
  const out = { ...next };
  const clamp = (path, value, prevValue, limit) => {
    const current = assertFiniteNumber(name, path, value);
    if (typeof prevValue !== 'number' || !Number.isFinite(prevValue)) return round6(current);
    const delta = current - prevValue;
    if (Math.abs(delta) > limit + 1e-9) {
      warnings.push('CLAMPED_DELTA');
      return round6(prevValue + Math.sign(delta) * limit);
    }
    return round6(current);
  };

  if (name === 'mood') {
    const limit = severe ? DELTA_LIMITS.mood.severe : DELTA_LIMITS.mood.normal;
    for (const key of MOOD_KEYS) {
      const current = assertFiniteNumber(name, `mood.${key}`, out[key]);
      const prevValue = previous?.[key];
      if (typeof prevValue === 'number' && Number.isFinite(prevValue)) {
        const delta = current - prevValue;
        if (Math.abs(delta) > DELTA_LIMITS.mood.hard + 1e-9) {
          throw moduleFailed(name, new Error(`mood.${key} delta ${round6(delta)} exceeds hard limit ${DELTA_LIMITS.mood.hard}`), {
            path: `mood.${key}`,
            delta: round6(delta),
            hard_limit: DELTA_LIMITS.mood.hard
          });
        }
      }
      out[key] = clamp(`mood.${key}`, current, prevValue, limit);
    }
    return out;
  }

  if (name === 'regulation') {
    for (const key of REGULATION_KEYS) {
      out[key] = clamp(`regulation.${key}`, out[key], previous?.[key], DELTA_LIMITS.regulation.normal);
    }
    return out;
  }

  if (name === 'sleep') {
    out.sleepiness = clamp('sleep.sleepiness', out.sleepiness, previous?.sleepiness, DELTA_LIMITS.sleepiness.normal);
    return out;
  }

  if (name === 'stress' || name === 'event') {
    // stress / event 都写 state.stress
    out.level = clamp('stress.level', out.level, previous?.level, DELTA_LIMITS.stress.normal);
    return out;
  }

  // cycle 等其余模块只做有限性校验，不施加变化上限。
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'number') assertFiniteNumber(name, `${name}.${key}`, value);
  }
  return out;
}

function validateModuleResult(name, result) {
  if (!result || typeof result !== 'object') {
    throw moduleFailed(name, new Error('must return a ModuleResult object'));
  }
  if (!result.contributions || typeof result.contributions !== 'object' || Array.isArray(result.contributions)) {
    throw moduleFailed(name, new Error('ModuleResult.contributions is required'), { path: 'contributions' });
  }
  if (result.reason_codes !== undefined) {
    if (!Array.isArray(result.reason_codes) || result.reason_codes.length > LIMITS.maxReasonCodes) {
      throw moduleFailed(name, new Error(`reason_codes must be a string array of at most ${LIMITS.maxReasonCodes}`), {
        path: 'reason_codes'
      });
    }
    if (result.reason_codes.some((c) => typeof c !== 'string')) {
      throw moduleFailed(name, new Error('reason_codes must contain strings only'), { path: 'reason_codes' });
    }
  }
  if (result.warnings !== undefined) {
    if (!Array.isArray(result.warnings) || result.warnings.length > LIMITS.maxWarnings) {
      throw moduleFailed(name, new Error(`warnings must be a string array of at most ${LIMITS.maxWarnings}`), {
        path: 'warnings'
      });
    }
    if (result.warnings.some((w) => typeof w !== 'string')) {
      throw moduleFailed(name, new Error('warnings must contain strings only'), { path: 'warnings' });
    }
  }
  const interfaceVersion = result?.diagnostics?.interface_version;
  if (interfaceVersion !== undefined && interfaceVersion !== INTERFACE_VERSION) {
    throw moduleFailed(name, new Error(`unsupported interface_version: ${interfaceVersion}`), {
      path: 'diagnostics.interface_version',
      expected: INTERFACE_VERSION
    });
  }
  if (!result.state || typeof result.state !== 'object') {
    throw moduleFailed(name, new Error('ModuleResult.state is required'), { path: 'state' });
  }
}

const KNOWN_DERIVED_KEYS = Object.freeze(['phase_impact', 'event_intensity']);

/**
 * 固定流水线（00 §5.4 第 1–8 步）。
 *
 * @returns {{state:object, delivery:object|null, behavior_context:object|null, next_transition_at:string|null}}
 */
export function runPipeline({
  draft,
  event = null,
  now,
  rngProvider,
  config = {},
  moduleResults = [],
  previousBehaviorContext = null,
  modules = [],
  queue = [],
  urgent = false,
  urgentInterrupt = false,
  eventIntensity = null,
  warnings = [],
  dtSeconds = 0
}) {
  let state = draft;
  const derived = {};
  let delivery = null;
  let behavior_context = null;
  let nextTransitionMs = null;
  const nowMs = parseTime(now, 'now');

  for (const mod of modules) {
    const name = mod.name;
    const stateKey = MODULE_STATE_KEY[name];
    let previous;
    if (name === 'behavior') previous = previousBehaviorContext;
    else if (name === 'delivery') previous = null;
    else previous = state[stateKey];

    const inputs = buildInputs(name, {
      state,
      event,
      now,
      derived,
      queue,
      urgent,
      dt: dtSeconds,
      eventIntensity,
      urgentInterrupt
    });
    const rng = rngProvider.stream(streamLabelFor(name, state, event));

    let result;
    try {
      result = mod.update({ previous, inputs, now, rng, config });
    } catch (cause) {
      if (cause && cause.code) throw cause;
      throw moduleFailed(name, cause);
    }
    validateModuleResult(name, result);

    if (result.derived !== undefined) {
      if (!result.derived || typeof result.derived !== 'object' || Array.isArray(result.derived)) {
        throw moduleFailed(name, new Error('derived must be an object'), { path: 'derived' });
      }
      for (const [key, value] of Object.entries(result.derived)) {
        if (!KNOWN_DERIVED_KEYS.includes(key)) {
          warnings.push('UNKNOWN_DERIVED_KEY');
          continue;
        }
        derived[key] = value;
      }
    }

    if (stateKey) {
      // severe 的唯一权威是 07 的 derived.event_intensity（00 v1.7.5 §4.2），
      // 不得回退到 event.intensity；07 未输出时视为非 severe。
      const severe = typeof derived.event_intensity === 'number' && derived.event_intensity >= 0.7;
      const merged = enforceDeltaLimits({
        name,
        previous,
        next: result.state,
        severe,
        warnings
      });
      state = { ...state, [stateKey]: merged };
    } else if (name === 'behavior') {
      behavior_context = result.state;
    } else if (name === 'delivery') {
      delivery = result.state;
    }

    if (result.next_transition_at !== undefined && result.next_transition_at !== null) {
      let hintMs = null;
      try {
        hintMs = parseTime(result.next_transition_at, 'next_transition_at');
      } catch {
        hintMs = null;
      }
      if (hintMs === null || hintMs > nowMs + 3_600_000) {
        warnings.push('INVALID_TRANSITION_HINT');
      } else if (nextTransitionMs === null || hintMs < nextTransitionMs) {
        nextTransitionMs = hintMs;
      }
    }

    moduleResults.push({
      ...result,
      diagnostics: {
        module: name,
        model_version: result?.diagnostics?.model_version ?? 1,
        interface_version: INTERFACE_VERSION,
        elapsed_ms: Number.isFinite(result?.diagnostics?.elapsed_ms) ? result.diagnostics.elapsed_ms : 0
      }
    });
  }

  return {
    state,
    delivery,
    behavior_context,
    next_transition_at: nextTransitionMs === null ? null : toIso(nextTransitionMs)
  };
}

/** 02 §4.3：把 moduleResults 汇总为 00 §11.4 的 diagnostics 对象。 */
export function aggregateDiagnostics(moduleResults = []) {
  const contributions = {};
  const warnings = [];
  const module_ms = {};
  for (const result of moduleResults) {
    const name = result?.diagnostics?.module ?? 'unknown';
    for (const [dimension, sources] of Object.entries(result?.contributions ?? {})) {
      if (!sources || typeof sources !== 'object') continue;
      if (!contributions[dimension]) contributions[dimension] = {};
      for (const [source, value] of Object.entries(sources)) {
        const numeric = Number(value);
        const base = contributions[dimension][source] ?? 0;
        contributions[dimension][source] = round6(base + (Number.isFinite(numeric) ? numeric : 0));
      }
    }
    for (const warning of result?.warnings ?? []) warnings.push(warning);
    const ms = Number(result?.diagnostics?.elapsed_ms ?? 0);
    module_ms[name] = (module_ms[name] ?? 0) + (Number.isFinite(ms) ? ms : 0);
  }
  return { contributions, warnings, module_ms };
}

function dedupeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.slice(0, LIMITS.maxWarnings);
}

function coarseHooks(modules) {
  const hooks = {};
  const cycle = modules.find((m) => m.name === 'cycle');
  if (cycle && typeof cycle.advanceCycleDays === 'function') {
    hooks.advanceCycleDays = cycle.advanceCycleDays;
  }
  const sleep = modules.find((m) => m.name === 'sleep');
  if (sleep && typeof sleep.sleepinessSteady === 'function') {
    hooks.sleepinessSteady = sleep.sleepinessSteady;
  }
  return hooks;
}

/**
 * C-06-01 / 02 §5.5：事件落地前先调用 07 与 11 的纯函数预判。
 * 只用于取值，不提交：调用方随后恢复 rng 快照再重跑下游。
 */
function predictEventRound({ draft, event, now, queue, urgent, modules, config, rngProvider }) {
  const eventModule = modules.find((mod) => mod.name === 'event');
  const deliveryModule = modules.find((mod) => mod.name === 'delivery');
  if (!eventModule || !deliveryModule) return null;
  try {
    const eventResult = eventModule.update({
      previous: draft.stress,
      inputs: buildInputs('event', { state: draft, event, now, derived: {}, queue, urgent, dt: 0 }),
      now,
      rng: rngProvider.stream(streamLabelFor('event', draft, event)),
      config
    });
    const intensity =
      eventResult && eventResult.derived && typeof eventResult.derived.event_intensity === 'number'
        ? eventResult.derived.event_intensity
        : null;
    const deliveryResult = deliveryModule.update({
      previous: null,
      inputs: buildInputs('delivery', {
        state: draft,
        event,
        now,
        derived: { event_intensity: intensity },
        queue,
        urgent,
        dt: 0
      }),
      now,
      rng: rngProvider.stream(streamLabelFor('delivery', draft, event)),
      config
    });
    return {
      event_intensity: intensity,
      policy: deliveryResult && deliveryResult.state ? deliveryResult.state.policy : null,
      delivery: deliveryResult && deliveryResult.state ? deliveryResult.state : null
    };
  } catch {
    // 预判失败不改变主路径：交给正式流水线抛出契约错误。
    return null;
  }
}

/**
 * 00 §11.4 推进入口。
 *
 * @param {{state:object, event?:object|null, now:string, rngProvider:object, config?:object,
 *          modules:Array<{name:string, update:Function}>, queue?:Array, urgent?:boolean}} params
 * @returns {{state:object, delivery:object|null, behavior_context:object|null,
 *            diagnostics:{contributions:object, warnings:string[], module_ms:object}}}
 */
export function advance(params) {
  const { state, event = null, now, rngProvider, config = {}, modules } = params;
  if (!state || typeof state !== 'object') {
    throw contractError('INVALID_REQUEST', 'state is required', { path: 'state' });
  }
  if (typeof now !== 'string') {
    throw contractError('INVALID_REQUEST', 'now is required (UTC ISO 8601 with milliseconds)', {
      path: 'now'
    });
  }
  parseTime(now, 'now');
  if (!rngProvider || typeof rngProvider.stream !== 'function' || typeof rngProvider.serialize !== 'function') {
    throw contractError('INVALID_REQUEST', 'rngProvider must be a RandomProvider instance', {
      path: 'rngProvider'
    });
  }
  if (event !== null && (typeof event !== 'object' || Array.isArray(event))) {
    throw contractError('INVALID_REQUEST', 'event must be an object or null', { path: 'event' });
  }
  assertModules(modules);
  const queue = Array.isArray(params.queue) ? params.queue : [];
  const urgent = params.urgent === true;

  const { effective_now, warnings: clockWarnings } = effectiveNow({
    now,
    lastTickAt: state.last_tick_at
  });
  const { chunks, leftoverSeconds, coarse } = chunkElapsed({
    elapsedSeconds: diffSeconds(state.last_tick_at, effective_now)
  });

  let draft = structuredClone(state);
  let t = state.last_tick_at;
  let delivery = null;
  let behavior_context = null;
  const moduleResults = [];
  const warnings = [...clockWarnings];
  let provider = rngProvider;

  for (const step of chunks) {
    const stepEnd = parseTime(t, 'chunk_start') + step * 1000;
    let guard = 0;

    while (parseTime(t, 'chunk_start') < stepEnd && guard < LIMITS.maxSubdivisionsPerChunk) {
      guard += 1;
      const snapshot = provider.serialize();
      const prevDraft = draft;
      const prevDelivery = delivery;
      const prevBehavior = behavior_context;
      const resultMark = moduleResults.length;
      const warningMark = warnings.length;

      let res = runPipeline({
        draft,
        event: null,
        now: toIso(stepEnd),
        rngProvider: provider,
        config,
        moduleResults,
        previousBehaviorContext: behavior_context,
        modules,
        queue,
        urgent,
        warnings,
        // 00 v1.7.6 §4.1：dt 为本步实际跨度（细分后可能小于 chunk 秒数）
        dtSeconds: Math.max(0, Math.floor((stepEnd - parseTime(t, 'chunk_start')) / 1000))
      });
      draft = res.state;
      delivery = res.delivery;
      behavior_context = res.behavior_context;
      let nextMs = stepEnd;

      if (res.next_transition_at) {
        const hintMs = parseTime(res.next_transition_at, 'next_transition_at');
        const chunkStartMs = parseTime(t, 'chunk_start');
        if (hintMs <= chunkStartMs) {
          // 提示落在本片之外（早于片首）：忽略（02 §5.5 / T28）。
          warnings.push('INVALID_TRANSITION_HINT');
        } else if (hintMs < stepEnd) {
          // 丢弃本次结果，用同一随机快照重算到提示时刻（00 §4.2 / §5.4.2）。
          draft = prevDraft;
          delivery = prevDelivery;
          behavior_context = prevBehavior;
          moduleResults.length = resultMark;
          warnings.length = warningMark;
          provider = provider.constructor.restore(snapshot);
          res = runPipeline({
            draft,
            event: null,
            now: res.next_transition_at,
            rngProvider: provider,
            config,
            moduleResults,
            previousBehaviorContext: prevBehavior,
            modules,
            queue,
            urgent,
            warnings,
            // 细分重算：dt 到提示时刻为止
            dtSeconds: Math.max(0, Math.floor((hintMs - chunkStartMs) / 1000))
          });
          draft = res.state;
          delivery = res.delivery;
          behavior_context = res.behavior_context;
          nextMs = hintMs;
        }
      }
      t = toIso(nextMs);
    }

    // 细分次数用尽仍落后片末时，补一次"忽略提示"的推进，保证时间轴不漂移。
    if (parseTime(t, 'chunk_start') < stepEnd) {
      const res = runPipeline({
        draft,
        event: null,
        now: toIso(stepEnd),
        rngProvider: provider,
        config,
        moduleResults,
        previousBehaviorContext: behavior_context,
        modules,
        queue,
        urgent,
        warnings,
        dtSeconds: Math.max(0, Math.floor((stepEnd - parseTime(t, 'chunk_start')) / 1000))
      });
      draft = res.state;
      delivery = res.delivery;
      behavior_context = res.behavior_context;
      t = toIso(stepEnd);
    }
  }

  if (coarse) {
    draft = coarseForward({
      state: draft,
      leftoverSeconds,
      now: effective_now,
      config,
      // 粗推进跨多个周期时，05 需要 provider 用 cycle:${index} 流采样（05 §4.1）
      rngProvider: provider,
      hooks: coarseHooks(modules)
    });
    warnings.push(`LONG_OFFLINE_COARSE:${Math.round(leftoverSeconds / 3600)}h`);
  }

  // 新事件只在最后应用一次（02 §5.5）。
  if (event) {
    // 应用事件这一轮通常 elapsed=0：dt 必须为 0（仅有噪声），不得叠加一次惯性。
    const dtSeconds = Math.max(
      0,
      Math.floor((parseTime(effective_now) - parseTime(t, 'chunk_start')) / 1000)
    );
    // C-06-01：先预判 11 的交付策略与 07 的 derived.event_intensity，再恢复 rng 快照重跑。
    // 预判不提交，因此回滚重跑不会重复消耗随机数（计数器与单遍路径一致）。
    const snapshot = provider.serialize();
    const predicted = predictEventRound({
      draft,
      event,
      now: effective_now,
      queue,
      urgent,
      modules,
      config,
      rngProvider: provider
    });
    provider = provider.constructor.restore(snapshot);

    const res = runPipeline({
      draft,
      event,
      now: effective_now,
      rngProvider: provider,
      config,
      moduleResults,
      previousBehaviorContext: behavior_context,
      modules,
      queue,
      urgent,
      // 06 只接受 07 的强度；11 预判 urgent_interrupt 时强制唤醒。
      eventIntensity: predicted ? predicted.event_intensity : null,
      urgentInterrupt: Boolean(predicted && predicted.policy === 'urgent_interrupt'),
      warnings,
      dtSeconds
    });
    draft = res.state;
    behavior_context = res.behavior_context;
    // 对外 delivery 保留预判结果；第二遍不得覆盖，否则 E03 会重算成 deliver_now。
    delivery = predicted && predicted.delivery ? predicted.delivery : res.delivery;
  }

  // 00 §11.4 方案 A：协调器写回随机计数器，调用方不得再次写回。
  const normalized = normalizeState(draft);
  // 00 v1.7.6 §3.2：default 只是初始化临时态，一次推进结束必须已被 05 采样解析。
  if (normalized.cycle?.cycle_length_source === 'default') {
    throw moduleFailed('cycle', new Error('cycle_length_source stayed default after advance'), {
      reason: 'cycle_source_unresolved'
    });
  }
  normalized.random = provider.toPersisted();
  normalized.state_version = state.state_version + 1;
  normalized.updated_at = effective_now;
  normalized.last_tick_at = effective_now;

  const diagnostics = aggregateDiagnostics(moduleResults);
  diagnostics.warnings = dedupeWarnings([...warnings, ...diagnostics.warnings]);

  return {
    state: normalized,
    delivery,
    behavior_context,
    diagnostics
  };
}

/**
 * 02 §4.3：把模块表与配置绑定成协调器，适配层只需要持有返回值。
 */
export function createCoordinator({ modules, config = {}, logger = null } = {}) {
  assertModules(modules);
  return {
    modules,
    config,
    logger,
    runPipeline: (params) =>
      runPipeline({ modules, config, ...params }),
    advance: (params) => advance({ modules, config, ...params })
  };
}
