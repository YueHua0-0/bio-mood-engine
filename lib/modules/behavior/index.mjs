/**
 * 10 人格行为映射：把 `mood.*` / `sleep.*` / `stress.level` 映射成行为倾向。
 *
 * 全部为虚构角色状态模拟，不构成任何真实心理或健康判断。
 *
 * 硬性契约：
 * - 只读 `mood.*` / `sleep.*` / `stress.level`，不写任何状态；`contributions` 恒为 `{}`。
 * - `previous` 只读 `verbosity_bias` / `affection_expression` 两个键，其余字段（含完整的
 *   `behavior_context`）一律忽略，保证"跨 advance 无记忆"。
 * - 不读 `inputs.dt`（本模块 §4.2 未声明），不消费随机数，不读系统时间。
 * - `hard_rule_precedence` 恒为 `true`（I8），不随任何输入变化。
 */

import { INTERFACE_VERSION, LIMITS, MOOD_HOME, SLEEP_STATES } from '../../core/constants.mjs';
import { round6 } from '../../core/models.mjs';

import { latencyRange } from './latency.mjs';
import { buildNotes, NOTES_MAX_COUNT, NOTE_MAX_CHARS } from './notes.mjs';
import { buildReasonCodes } from './reasons.mjs';
import { AFFECTION_TIERS, VERBOSITY_TIERS, pickAffection, pickVerbosity, sleepConstraint } from './tone.mjs';

const MODEL_VERSION = 1;
const CONTEXT_MAX_CHARS = 800;
const STRESS_DEFAULT = 0.15;
const SLEEP_DEFAULTS = Object.freeze({ state: 'awake', sleepiness: 0.25, sleep_debt: 0.15 });
const MOOD_INPUT_KEYS = Object.freeze(['energy', 'stability', 'sensitivity', 'social_drive', 'closeness_need', 'physical_comfort']);

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pushUnique(list, code) {
  if (!list.includes(code)) list.push(code);
}

/**
 * 读取 `[0,1]` 数值：非有限值拒绝；越界钳制并记 `INPUT_CLAMPED`。
 */
function readUnitValue(raw, path, fallback, { missingCode, warnings }) {
  if (raw === undefined || raw === null) {
    if (missingCode) pushUnique(warnings, missingCode);
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw contractError('INVALID_REQUEST', `${path} must be a finite number`, { module: 'behavior', path });
  }
  const clamped = clamp01(raw);
  if (clamped !== raw) pushUnique(warnings, 'INPUT_CLAMPED');
  return clamped;
}

/** 10 §5.1：回避倾向（保留未 round6 的值供 §5.2 使用）。 */
export function avoidanceTendency(x) {
  return clamp01(
    0.55 - 0.50 * x.social_drive + 0.40 * x.stress + 0.30 * x.sensitivity - 0.30 * x.stability
  );
}

/** 10 §5.2：回复概率（`avoidance` 取 round6 前的值）。 */
export function replyLikelihood(x) {
  return clamp01(
    0.30 +
      0.40 * x.social_drive +
      0.25 * (1 - x.avoidance) +
      0.20 * x.energy -
      0.35 * x.sleepiness -
      0.25 * x.sleep_debt
  );
}

/**
 * 10 §5.9：注入长度保护。超限按"删 notes 末条 → 删 reason_codes 末条 → 追加
 * `context_truncated`"处理；数值与枚举字段本身仍超限才抛 `MODULE_FAILED`。
 */
export function trimContext(context, maxChars = CONTEXT_MAX_CHARS) {
  const notes = [...context.behavior_notes];
  const codes = [...context.reason_codes];
  let truncated = false;

  const measure = () =>
    JSON.stringify({ ...context, behavior_notes: notes, reason_codes: codes }).length;

  while (measure() > maxChars) {
    if (notes.length > 0) {
      notes.pop();
      truncated = true;
      continue;
    }
    if (codes.length > 1) {
      codes.pop();
      truncated = true;
      continue;
    }
    throw contractError('MODULE_FAILED', 'behavior_context exceeds injection limit', {
      module: 'behavior',
      limit: maxChars
    });
  }

  if (truncated && !codes.includes('context_truncated')) {
    codes.push('context_truncated');
    while (measure() > maxChars && codes.length > 1) {
      codes.splice(codes.length - 2, 1);
    }
    if (measure() > maxChars) {
      throw contractError('MODULE_FAILED', 'behavior_context exceeds injection limit', {
        module: 'behavior',
        limit: maxChars
      });
    }
  }

  return {
    context: { ...context, behavior_notes: notes, reason_codes: codes },
    truncated
  };
}

/**
 * 10 §4.1：行为映射入口。
 *
 * @param {{previous: object|null, inputs: object, now: string, rng: any, config: object}} args
 */
export function updateBehavior({ previous, inputs }) {
  const warnings = [];
  const source = inputs ?? {};

  // --- mood 五维：缺字段按 09 的 home 降级 ---
  const moodInput = source.mood ?? {};
  const mood = {};
  for (const key of MOOD_INPUT_KEYS) {
    mood[key] = readUnitValue(moodInput[key], `inputs.mood.${key}`, MOOD_HOME[key], {
      missingCode: 'MISSING_MOOD_DATA',
      warnings
    });
  }

  // --- 压力：缺省取 09 的 home ---
  const stress = readUnitValue(source.stress?.level, 'inputs.stress.level', STRESS_DEFAULT, {
    missingCode: 'MISSING_STRESS_DATA',
    warnings
  });

  // --- 睡眠：整块缺失按契约默认值；state 非枚举按 awake 处理 ---
  const sleepInput = source.sleep;
  let sleepState = SLEEP_DEFAULTS.state;
  if (!sleepInput || typeof sleepInput !== 'object') {
    pushUnique(warnings, 'MISSING_SLEEP_DATA');
  } else if (sleepInput.state === undefined || sleepInput.state === null) {
    pushUnique(warnings, 'MISSING_SLEEP_DATA');
  } else if (!SLEEP_STATES.includes(sleepInput.state)) {
    pushUnique(warnings, 'UNKNOWN_SLEEP_STATE');
  } else {
    sleepState = sleepInput.state;
  }
  const sleepiness = readUnitValue(sleepInput?.sleepiness, 'inputs.sleep.sleepiness', SLEEP_DEFAULTS.sleepiness, {
    missingCode: 'MISSING_SLEEP_DATA',
    warnings
  });
  const sleepDebt = readUnitValue(sleepInput?.sleep_debt, 'inputs.sleep.sleep_debt', SLEEP_DEFAULTS.sleep_debt, {
    missingCode: 'MISSING_SLEEP_DATA',
    warnings
  });

  // --- previous：只认两个键，其余一律忽略 ---
  const prevVerbosity = previous && VERBOSITY_TIERS.includes(previous.verbosity_bias)
    ? previous.verbosity_bias
    : null;
  const prevAffection = previous && AFFECTION_TIERS.includes(previous.affection_expression)
    ? previous.affection_expression
    : null;
  if (!previous || prevVerbosity === null || prevAffection === null) {
    pushUnique(warnings, 'HYSTERESIS_RESET');
  }

  // --- 四个连续量 ---
  const avoidanceRaw = avoidanceTendency({ ...mood, stress });
  const avoidance = round6(avoidanceRaw);
  const reply = round6(
    replyLikelihood({ ...mood, stress, sleepiness, sleep_debt: sleepDebt, avoidance: avoidanceRaw })
  );
  const socialInitiative = round6(
    clamp01(0.50 * mood.social_drive + 0.30 * mood.energy - 0.40 * avoidanceRaw)
  );
  const needForReassurance = round6(
    clamp01(0.60 * mood.closeness_need + 0.40 * mood.sensitivity - 0.30 * mood.stability)
  );

  // --- 档位（滞回只在同一次 advance 的 chunk 间生效） ---
  const verbosityBias = pickVerbosity(
    { energy: mood.energy, sleepiness, social_drive: mood.social_drive },
    prevVerbosity
  );
  const affectionExpression = pickAffection(
    { closeness_need: mood.closeness_need, stress },
    prevAffection
  );

  const noteResult = buildNotes({
    sleep_state: sleepState,
    sleepiness,
    sleep_debt: sleepDebt,
    stress,
    energy: mood.energy,
    social_drive: mood.social_drive,
    avoidance,
    closeness_need: mood.closeness_need,
    physical_comfort: mood.physical_comfort,
    affection_expression: affectionExpression
  });
  for (const code of noteResult.warnings) pushUnique(warnings, code);

  const reasonCodes = buildReasonCodes({
    sleep_state: sleepState,
    sleepiness,
    sleep_debt: sleepDebt,
    stress,
    energy: mood.energy,
    social_drive: mood.social_drive,
    avoidance,
    reply_likelihood: reply,
    closeness_need: mood.closeness_need,
    physical_comfort: mood.physical_comfort,
    affection_expression: affectionExpression,
    truncated: false
  });

  const context = {
    avoidance_tendency: avoidance,
    reply_likelihood: reply,
    social_initiative: socialInitiative,
    need_for_reassurance: needForReassurance,
    response_latency_range_seconds: latencyRange(reply),
    verbosity_bias: verbosityBias,
    affection_expression: affectionExpression,
    sleep_constraint: sleepConstraint({ state: sleepState, sleepiness }),
    behavior_notes: noteResult.notes.slice(0, NOTES_MAX_COUNT),
    reason_codes: reasonCodes,
    hard_rule_precedence: true
  };

  const trimmed = trimContext(context);
  if (trimmed.truncated) pushUnique(warnings, 'CONTEXT_TRUNCATED');

  // §6：缺上游 / 非法枚举属降级，DEGRADED 与具体 MISSING_* 同时出现。
  if (warnings.some((code) => code.startsWith('MISSING_') || code === 'UNKNOWN_SLEEP_STATE')) {
    warnings.unshift('DEGRADED');
  }

  pushUnique(warnings, 'NO_STATE_CONTRIBUTIONS');

  return {
    state: trimmed.context,
    contributions: {},
    reason_codes: trimmed.context.reason_codes.slice(0, LIMITS.maxReasonCodes),
    warnings: warnings.slice(0, LIMITS.maxWarnings),
    next_transition_at: null,
    diagnostics: {
      module: 'behavior',
      model_version: MODEL_VERSION,
      interface_version: INTERFACE_VERSION,
      elapsed_ms: 0,
      note_max_chars: NOTE_MAX_CHARS
    }
  };
}

export const behaviorModule = {
  name: 'behavior',
  update: updateBehavior
};

export { buildNotes, NOTE_TABLE, isNoteSafe } from './notes.mjs';
export { buildReasonCodes, REASON_ORDER } from './reasons.mjs';
export { latencyRange, LATENCY_TIERS } from './latency.mjs';
export { pickVerbosity, pickAffection, sleepConstraint, VERBOSITY_TIERS, AFFECTION_TIERS } from './tone.mjs';

export default behaviorModule;
