/**
 * 06 §5.4 / §5.5：睡眠六态状态机、滞回阈值、打断与续睡、合法转换矩阵。
 *
 * 全部为纯函数：输入是「上一状态 + 本次观测」，输出是「目标状态 + 稳定原因码」，
 * 不写任何外部状态、不读系统时间。副作用（债务/质量/时间戳）由 index.mjs 统一落地。
 *
 * 本模块为虚构角色状态模拟，不构成任何医学或健康判断。
 */

import { SLEEP_STATES } from '../../core/constants.mjs';

/** 06 §5.4 的阈值表（滞回、入睡窗口、打断与续睡）。 */
export const SLEEP_THRESHOLDS = Object.freeze({
  /** awake → sleepy */
  sleepyEnter: 0.55,
  /** sleepy → awake（滞回 0.05） */
  sleepyExit: 0.50,
  /** sleepy → trying_to_sleep：夜间窗口内的阈值 */
  tryingEnterNight: 0.72,
  /** sleepy → trying_to_sleep：夜间窗口外的例外阈值 */
  tryingEnterHard: 0.85,
  /** trying_to_sleep → sleepy */
  tryingExit: 0.67,
  /** trying_to_sleep 持续满 20 分钟才入睡 */
  fallAsleepMinutes: 20,
  /** 睡眠中事件强度达到 0.35 触发打断 */
  interruptIntensity: 0.35,
  /** 打断后 15 分钟重新评估 */
  resumeMinutes: 15,
  /** 续睡所需的最大恢复进度：超过则放弃续睡（C-06-02，阈值由 16 夜间仿真确定） */
  resumeRecoveryMax: 0.70,
  /** waking_up 持续 10 分钟后清醒 */
  wakeMinutes: 10
});

/** 06 §5.5：打断的记账规则。 */
export const INTERRUPTION_RULES = Object.freeze({
  max_count: 20,
  debt_bump: 0.01,
  quality_penalty: 0.05
});

/** 06 §5.4：入睡判定窗口 [21,24) ∪ [0,5)（跨日，P-16-04 裁决 ①：覆盖 nightFactor 峰值）。 */
export const SLEEP_WINDOW_START_HOUR = 21;
export const SLEEP_WINDOW_END_HOUR = 5;

/** 06 §5.4 合法转换矩阵；未列出的目标一律非法，同态视为"不转换"。 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  awake: Object.freeze(['sleepy']),
  sleepy: Object.freeze(['awake', 'trying_to_sleep']),
  trying_to_sleep: Object.freeze(['sleepy', 'sleeping']),
  sleeping: Object.freeze(['interrupted', 'waking_up']),
  interrupted: Object.freeze(['sleeping', 'waking_up']),
  waking_up: Object.freeze(['awake'])
});

/** 06 §5.4 显式列出的禁止跳转（矩阵推导的完整禁止集见 ILLEGAL_TRANSITIONS）。 */
export const EXPLICIT_ILLEGAL_TRANSITIONS = Object.freeze([
  Object.freeze(['awake', 'sleeping']),
  Object.freeze(['awake', 'trying_to_sleep']),
  Object.freeze(['sleepy', 'sleeping']),
  Object.freeze(['trying_to_sleep', 'awake']),
  Object.freeze(['sleeping', 'awake']),
  Object.freeze(['sleeping', 'sleepy']),
  Object.freeze(['interrupted', 'awake']),
  Object.freeze(['interrupted', 'sleepy']),
  Object.freeze(['waking_up', 'sleeping']),
  Object.freeze(['waking_up', 'sleepy'])
]);

/** 由矩阵推导的完整禁止集（20 条，不含同态）。 */
export const ILLEGAL_TRANSITIONS = Object.freeze(
  SLEEP_STATES.flatMap((from) =>
    SLEEP_STATES
      .filter((to) => to !== from && !ALLOWED_TRANSITIONS[from].includes(to))
      .map((to) => Object.freeze([from, to]))
  )
);

/** 06 §5.4：纯函数合法性判定；同态（from === to）不算转换，返回 true。 */
export function isLegalTransition(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  if (!(from in ALLOWED_TRANSITIONS) || !(to in ALLOWED_TRANSITIONS)) return false;
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 转换守卫：非法转换必须保持原状态并给出警告，不得静默跳转、不得抛错。
 * @returns {{ok:boolean, warnings:string[]}}
 */
export function guardTransition({ from, to } = {}) {
  if (from === to) return { ok: true, warnings: [] };
  if (isLegalTransition(from, to)) return { ok: true, warnings: [] };
  return { ok: false, warnings: ['SLEEP_ILLEGAL_TRANSITION'] };
}

/** 06 §5.4：本地小时是否落在入睡窗口 [21,24) ∪ [0,5)。 */
export function inSleepWindow(hour) {
  if (!Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return h >= SLEEP_WINDOW_START_HOUR || h < SLEEP_WINDOW_END_HOUR;
}

function step(to, reason, atMs) {
  return { from: null, to, reason, atMs };
}

/**
 * 06 §5.4：单步转换决策。返回 null 表示保持原状态。
 *
 * `atMs` 是本次转换"本应发生"的时刻（毫秒）：
 * - 时间驱动转换（满 20 / 15 / 10 分钟、到达 planned_wake_at）回填到阈值边界，
 *   保证协调器按小时推进时入睡/转醒时刻误差仍为 0 秒（06 §8 M18/M19）；
 * - 由困倦度或事件驱动的转换取当前 `now`（区间内的真实交叉点不可观测）。
 *
 * 判定顺序固定，保证同输入同输出（I5）：
 * - sleeping 不以 sleepiness 触发醒来（06 §5.4 v1.2 判定说明）；
 * - trying_to_sleep 先看"满 20 分钟且非紧急"，再看"困倦度回落"；
 * - interrupted 先看计划唤醒，再看 15 分钟后的续睡/转醒。
 *
 * @param {{previous:string, sleepiness:number, localHour:number, nowMs:number,
 *          stateSinceMs:number|null, plannedWakeAtMs:number|null, urgent?:boolean,
 *          urgentInterrupt?:boolean, eventIntensity?:number|null,
 *          recoveryProgress?:number|null}} params
 * @returns {{from:string, to:string, reason:string, atMs:number}|null}
 */
export function decideTransition({
  previous,
  sleepiness,
  localHour,
  nowMs,
  stateSinceMs,
  plannedWakeAtMs,
  urgent = false,
  urgentInterrupt = false,
  eventIntensity = null,
  recoveryProgress = null
} = {}) {
  if (typeof previous !== 'string' || !(previous in ALLOWED_TRANSITIONS)) return null;
  const s = Number.isFinite(sleepiness) ? sleepiness : 0;
  const recovery = Number.isFinite(recoveryProgress) ? recoveryProgress : 0;
  const since = Number.isFinite(stateSinceMs) ? stateSinceMs : nowMs;
  const elapsedMin = (nowMs - since) / 60_000;
  const wakeReached = Number.isFinite(plannedWakeAtMs) && nowMs >= plannedWakeAtMs;
  const wakeAt = wakeReached ? plannedWakeAtMs : nowMs;

  switch (previous) {
    case 'awake':
      if (s >= SLEEP_THRESHOLDS.sleepyEnter) return step('sleepy', 'felt_sleepy', nowMs);
      return null;

    case 'sleepy':
      if (
        s >= SLEEP_THRESHOLDS.tryingEnterHard ||
        (s >= SLEEP_THRESHOLDS.tryingEnterNight && inSleepWindow(localHour))
      ) {
        return step('trying_to_sleep', 'started_trying_to_sleep', nowMs);
      }
      if (s < SLEEP_THRESHOLDS.sleepyExit) return step('awake', 'no_longer_sleepy', nowMs);
      return null;

    case 'trying_to_sleep':
      if (elapsedMin >= SLEEP_THRESHOLDS.fallAsleepMinutes && urgent !== true) {
        return step('sleeping', 'fell_asleep', since + SLEEP_THRESHOLDS.fallAsleepMinutes * 60_000);
      }
      if (s < SLEEP_THRESHOLDS.tryingExit) return step('sleepy', 'gave_up_trying', nowMs);
      return null;

    case 'sleeping':
      if (wakeReached) return step('waking_up', 'planned_wake', wakeAt);
      if (urgentInterrupt === true) return step('waking_up', 'urgent_interrupt', nowMs);
      if (Number.isFinite(eventIntensity) && eventIntensity >= SLEEP_THRESHOLDS.interruptIntensity) {
        return step('interrupted', 'interrupted_by_event', nowMs);
      }
      return null;

    case 'interrupted':
      if (wakeReached) return step('waking_up', 'planned_wake', wakeAt);
      if (elapsedMin >= SLEEP_THRESHOLDS.resumeMinutes) {
        const at = since + SLEEP_THRESHOLDS.resumeMinutes * 60_000;
        // C-06-02：续睡不再看困倦度（入睡后约 22 分钟即低于 0.60，几乎不可达），
        // 改看本次睡眠的恢复进度：尚未睡够七成才续睡，否则放弃并转醒。
        return recoveryProgress < SLEEP_THRESHOLDS.resumeRecoveryMax
          ? step('sleeping', 'resumed_sleep', at)
          : step('waking_up', 'gave_up_sleep', at);
      }
      return null;

    case 'waking_up':
      if (elapsedMin >= SLEEP_THRESHOLDS.wakeMinutes) {
        return step('awake', 'woke_naturally', since + SLEEP_THRESHOLDS.wakeMinutes * 60_000);
      }
      return null;

    default:
      return null;
  }
}

/**
 * 06 §4.4：当前状态对应的"下一个转换提示"原始毫秒值（未做 1 小时窗口校验）。
 *
 * | trying_to_sleep | state_since + 20 分钟 |
 * | sleeping        | planned_wake_at       |
 * | interrupted     | state_since + 15 分钟 |
 * | waking_up       | state_since + 10 分钟 |
 * | 其余            | null                  |
 */
export function nextTransitionHintMs({ state, stateSinceMs, plannedWakeAtMs } = {}) {
  switch (state) {
    case 'trying_to_sleep':
      return Number.isFinite(stateSinceMs) ? stateSinceMs + SLEEP_THRESHOLDS.fallAsleepMinutes * 60_000 : null;
    case 'sleeping':
      return Number.isFinite(plannedWakeAtMs) ? plannedWakeAtMs : null;
    case 'interrupted':
      return Number.isFinite(stateSinceMs) ? stateSinceMs + SLEEP_THRESHOLDS.resumeMinutes * 60_000 : null;
    case 'waking_up':
      return Number.isFinite(stateSinceMs) ? stateSinceMs + SLEEP_THRESHOLDS.wakeMinutes * 60_000 : null;
    default:
      return null;
  }
}
