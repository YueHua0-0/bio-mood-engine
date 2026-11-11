/**
 * 11 消息交付与唤醒策略：只输出策略，不发送、不调度、不写存储。
 *
 * 全部为虚构角色状态模拟：`sleep_debt` / `sleepiness` 是模拟量，不是真实健康指标。
 *
 * 硬性契约：
 * - 五条规则严格按 11 §5.3 顺序命中即停；不得改成加权打分。
 * - `wake_cost` 必须在策略判定前算好并输出（所有分支都要有值）。
 * - `silent_ignore` 是"不触发 DSH 但保留记录"，不是丢弃。
 * - 合并结果经 `coalesced_into` 返回（00 v1.7.8 §12.4）；不计算、不输出 `urgency`。
 * - 不读 `inputs.dt`（本模块 §4.2 未声明）；不消费随机数；不读系统时间。
 */

import { INTERFACE_VERSION, LIMITS, SLEEP_STATES } from '../../core/constants.mjs';
import { parseTime, toIso } from '../../core/clock.mjs';
import { round6 } from '../../core/models.mjs';

import { decidePolicy, wakeCost } from './policy.mjs';
import { coalesce, planQueue } from './queue.mjs';
import { orderReasonCodes } from './reasons.mjs';
import { urgencyOf } from './urgency.mjs';

const MODEL_VERSION = 1;
const SLEEP_DEFAULTS = Object.freeze({ state: 'awake', sleepiness: 0.25, sleep_debt: 0.15 });
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

const EPS = 1e-9;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function ge(a, b) {
  return a - b >= -EPS;
}

function lt(a, b) {
  return a - b < -EPS;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pushUnique(list, code) {
  if (!list.includes(code)) list.push(code);
}

function readUnitValue(raw, path, fallback, { missingCode, warnings }) {
  if (raw === undefined || raw === null) {
    if (missingCode) pushUnique(warnings, missingCode);
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw contractError('INVALID_REQUEST', `${path} must be a finite number`, { module: 'delivery', path });
  }
  const clamped = clamp01(raw);
  if (clamped !== raw) pushUnique(warnings, 'INPUT_CLAMPED');
  return clamped;
}

function readSleep(inputs, warnings) {
  const sleep = inputs?.sleep;
  let state = SLEEP_DEFAULTS.state;
  if (!sleep || typeof sleep !== 'object' || sleep.state === undefined || sleep.state === null) {
    pushUnique(warnings, 'MISSING_SLEEP_DATA');
  } else if (!SLEEP_STATES.includes(sleep.state)) {
    pushUnique(warnings, 'UNKNOWN_SLEEP_STATE');
  } else {
    state = sleep.state;
  }
  const sleepiness = readUnitValue(sleep?.sleepiness, 'inputs.sleep.sleepiness', SLEEP_DEFAULTS.sleepiness, {
    missingCode: 'MISSING_SLEEP_DATA',
    warnings
  });
  const sleepDebt = readUnitValue(sleep?.sleep_debt, 'inputs.sleep.sleep_debt', SLEEP_DEFAULTS.sleep_debt, {
    missingCode: 'MISSING_SLEEP_DATA',
    warnings
  });

  // 11 §6：缺上游 / 非法枚举属降级，DEGRADED 与具体 MISSING_* / UNKNOWN_* 同时出现。
  if (warnings.some((code) => code === 'MISSING_SLEEP_DATA' || code === 'UNKNOWN_SLEEP_STATE')) {
    warnings.unshift('DEGRADED');
  }

  return {
    state,
    sleepiness,
    sleep_debt: sleepDebt,
    planned_wake_at: typeof sleep?.planned_wake_at === 'string' ? sleep.planned_wake_at : null
  };
}

function readEvent(inputs) {
  const event = inputs?.event;
  if (!event || typeof event !== 'object') return null;

  const eventType = event.event_type;
  // baseUrgency 抛 INVALID_REQUEST，保证非枚举不被兜底成 group_message。
  urgencyOf(event);

  const eventId = event.event_id;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) {
    throw contractError('INVALID_REQUEST', 'event_id must match ^[A-Za-z0-9_-]{8,128}$', {
      module: 'delivery',
      path: 'inputs.event.event_id'
    });
  }

  const rawConversation = event.conversation_id;
  let conversationId = null;
  if (typeof rawConversation === 'string' && rawConversation.length > 0 && rawConversation.length <= 128) {
    conversationId = rawConversation;
  }

  return {
    event_type: eventType,
    is_mentioned: event.is_mentioned === true,
    event_id: eventId,
    conversation_id: conversationId
  };
}

function finish({ delivery, warnings, extraCodes }) {
  const codes = orderReasonCodes([...(delivery.reason_codes ?? []), ...(extraCodes ?? [])]);
  pushUnique(warnings, 'NO_STATE_CONTRIBUTIONS');
  return {
    state: { ...delivery, reason_codes: codes.slice(0, LIMITS.maxReasonCodes) },
    contributions: {},
    reason_codes: codes.slice(0, LIMITS.maxReasonCodes),
    warnings: warnings.slice(0, LIMITS.maxWarnings),
    next_transition_at: delivery.expires_at ?? null,
    diagnostics: {
      module: 'delivery',
      model_version: MODEL_VERSION,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0
    }
  };
}

/**
 * 11 §4.1：交付策略入口。
 *
 * `inputs.event === null` 表示纯时间推进（`tick` / chunk 步）：没有待判定的消息，
 * 按 11 §5.3 规则 0 返回 `silent_ignore` + `no_event`（与 `sleeping` 等其余码互斥），
 * `urgency` 记 0 仅用于把 `wake_cost` 算出来。
 */
export function updateDelivery({ inputs, now }) {
  const warnings = [];
  const nowMs = parseTime(now, 'now');
  const nowIso = toIso(nowMs);

  const sleep = readSleep(inputs, warnings);
  const event = readEvent(inputs);

  if (!event) {
    const cost = wakeCost({ sleep_debt: sleep.sleep_debt, sleepiness: sleep.sleepiness, urgency: 0 });
    return finish({
      delivery: {
        policy: 'silent_ignore',
        wake_candidate: false,
        wake_cost: round6(cost),
        recommended_delay_seconds: 0,
        deliver_after: nowIso,
        expires_at: null,
        reason_codes: ['no_event']
      },
      warnings
    });
  }

  const urgency = urgencyOf(event);
  const cost = wakeCost({ sleep_debt: sleep.sleep_debt, sleepiness: sleep.sleepiness, urgency });
  let policy = decidePolicy({ sleepState: sleep.state, sleepiness: sleep.sleepiness, urgency, wakeCost: cost });

  const codes = [];
  if (sleep.state === 'sleeping') codes.push('sleeping');
  if (policy === 'urgent_interrupt') codes.push('urgent_conflict');
  if (policy === 'wake_candidate') codes.push('wake_candidate_low_cost');
  if (sleep.state === 'sleeping' && ge(urgency, 0.70) && policy === 'queue_until_awake') {
    codes.push('wake_cost_high');
  }
  if (sleep.state === 'sleeping' && lt(urgency, 0.70)) codes.push('low_event_urgency');
  if (policy === 'silent_ignore' && sleep.state === 'awake') codes.push('awake_high_sleepiness');
  if (sleep.state !== 'sleeping' && sleep.state !== 'awake') codes.push('sleepy_passthrough');

  let delay = 0;
  let deliverAfter = nowIso;
  let expiresAt = null;
  let coalescedInto = null;

  if (policy === 'queue_until_awake') {
    const plan = planQueue({ now, planned_wake_at: sleep.planned_wake_at });
    delay = plan.delay;
    deliverAfter = plan.deliver_after;
    expiresAt = plan.expires_at;
    for (const code of plan.reason_codes) codes.push(code);

    const merge = coalesce({
      pending: inputs?.queue?.pending,
      event,
      now
    });
    for (const code of merge.warnings) pushUnique(warnings, code);
    if (merge.triggered) {
      policy = 'silent_ignore';
      delay = 0;
      deliverAfter = nowIso;
      expiresAt = null;
      codes.push('coalesced');
      coalescedInto = merge.coalesced_into;
    }
  }

  // §6：合并产生的策略必须是 silent_ignore，否则视为实现错误。
  if (codes.includes('coalesced') && policy !== 'silent_ignore') {
    throw contractError('MODULE_FAILED', 'coalesced delivery must be silent_ignore', {
      module: 'delivery'
    });
  }

  const delivery = {
    policy,
    wake_candidate: policy === 'wake_candidate' || policy === 'urgent_interrupt',
    wake_cost: round6(cost),
    recommended_delay_seconds: delay,
    deliver_after: deliverAfter,
    expires_at: expiresAt,
    reason_codes: codes
  };
  if (coalescedInto) delivery.coalesced_into = coalescedInto;

  return finish({ delivery, warnings });
}

export const deliveryModule = {
  name: 'delivery',
  update: updateDelivery
};

export { baseUrgency, urgencyOf, EVENT_TYPES, MENTION_FLOOR } from './urgency.mjs';
export { decidePolicy, wakeCost, recheck, POLICIES } from './policy.mjs';
export { planQueue, coalesce } from './queue.mjs';
export { orderReasonCodes, REASON_ORDER } from './reasons.mjs';

export default deliveryModule;
