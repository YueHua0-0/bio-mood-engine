/**
 * 10 §5.4–§5.6：话量倾向 / 亲密表达（±0.05 滞回）与睡眠约束。
 *
 * 滞回只作用于"上一次档位 → 本次档位"的迁移；档位本身由冻结阈值决定。
 * 判定顺序固定：话量先 low 再 high，亲密先 reserved 再 warm。
 */

const EPS = 1e-9;

export const VERBOSITY_TIERS = Object.freeze(['low', 'normal', 'high']);
export const AFFECTION_TIERS = Object.freeze(['reserved', 'normal', 'warm']);

function ge(a, b) {
  return a - b >= -EPS;
}

function gt(a, b) {
  return a - b > EPS;
}

function lt(a, b) {
  return a - b < -EPS;
}

/** 基础阈值判定（无滞回）。 */
function baseVerbosity({ energy, sleepiness, social_drive }) {
  if (lt(energy, 0.35) || gt(sleepiness, 0.60)) return 'low';
  if (ge(energy, 0.62) && ge(social_drive, 0.58)) return 'high';
  return 'normal';
}

/**
 * 10 §5.4：带滞回的话量倾向。
 * `prevTier` 为 null / 非法档时直接走基础阈值（调用方负责追加 HYSTERESIS_RESET）。
 */
export function pickVerbosity(x, prevTier) {
  const { energy, sleepiness, social_drive } = x;
  if (prevTier === 'low') {
    if (lt(energy, 0.40) || gt(sleepiness, 0.55)) return 'low';
    return baseVerbosity(x);
  }
  if (prevTier === 'high') {
    if (ge(energy, 0.57) && ge(social_drive, 0.53)) return 'high';
    return baseVerbosity(x);
  }
  return baseVerbosity(x);
}

/** 基础阈值判定（无滞回）。 */
function baseAffection({ closeness_need, stress }) {
  if (lt(closeness_need, 0.35) || gt(stress, 0.70)) return 'reserved';
  if (ge(closeness_need, 0.70) && lt(stress, 0.50)) return 'warm';
  return 'normal';
}

/**
 * 10 §5.5：带滞回的亲密表达。
 * 先 reserved 再 warm：高压力下宁可克制，不允许因亲近需求高而输出 warm。
 */
export function pickAffection(x, prevTier) {
  const { closeness_need, stress } = x;
  if (prevTier === 'reserved') {
    if (lt(closeness_need, 0.40) || gt(stress, 0.65)) return 'reserved';
    return baseAffection(x);
  }
  if (prevTier === 'warm') {
    if (ge(closeness_need, 0.65) && lt(stress, 0.55)) return 'warm';
    return baseAffection(x);
  }
  return baseAffection(x);
}

/**
 * 10 §5.6：睡眠约束。
 * `sleeping` 优先于一切行为倾向；`sleepiness > 0.60` 严格大于才切换为 sleepy。
 */
export function sleepConstraint(sleep) {
  const state = sleep?.state;
  if (state === 'sleeping') {
    return { should_reply: false, tone: 'sleepy', max_reply_length: 'short' };
  }
  if (state === 'waking_up') {
    return { should_reply: true, tone: 'waking', max_reply_length: 'normal' };
  }
  const sleepiness = typeof sleep?.sleepiness === 'number' ? sleep.sleepiness : 0;
  return {
    should_reply: true,
    tone: gt(sleepiness, 0.60) ? 'sleepy' : 'none',
    max_reply_length: 'normal'
  };
}
