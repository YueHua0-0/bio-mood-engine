/**
 * 10 §5.10：reason_codes 稳定排序（≤16）。
 *
 * 只允许本表列出的码；实现不得发明新码。输出顺序严格按表序去重。
 */

const EPS = 1e-9;

export const REASON_ORDER = Object.freeze([
  'sleeping',
  'waking_up',
  'sleepiness_high',
  'sleep_debt_high',
  'stress_high',
  'energy_low',
  'energy_high',
  'social_drive_low',
  'social_drive_high',
  'avoidance_high',
  'reply_likely',
  'reply_unlikely',
  'closeness_high',
  'reserved_tone',
  'warm_tone',
  'context_truncated'
]);

function ge(a, b) {
  return a - b >= -EPS;
}

function gt(a, b) {
  return a - b > EPS;
}

function lt(a, b) {
  return a - b < -EPS;
}

/**
 * @param {object} ctx 已 round6 的判定量 + 档位 + 截断标记
 * @returns {string[]} 按 §5.10 顺序去重后的码
 */
export function buildReasonCodes(ctx) {
  const hit = new Set();
  const {
    sleep_state: sleepState,
    sleepiness,
    sleep_debt: sleepDebt,
    stress,
    energy,
    social_drive: socialDrive,
    avoidance,
    reply_likelihood: reply,
    closeness_need: closenessNeed,
    affection_expression: affection,
    truncated
  } = ctx;

  if (sleepState === 'sleeping') hit.add('sleeping');
  if (sleepState === 'waking_up') hit.add('waking_up');
  if (gt(sleepiness, 0.75)) hit.add('sleepiness_high');
  if (ge(sleepDebt, 0.50)) hit.add('sleep_debt_high');
  if (ge(stress, 0.55)) hit.add('stress_high');
  if (lt(energy, 0.35)) hit.add('energy_low');
  if (ge(energy, 0.70) && ge(socialDrive, 0.60)) hit.add('energy_high');
  if (lt(socialDrive, 0.40)) hit.add('social_drive_low');
  if (ge(socialDrive, 0.60)) hit.add('social_drive_high');
  if (ge(avoidance, 0.60)) hit.add('avoidance_high');
  if (ge(reply, 0.70)) hit.add('reply_likely');
  if (lt(reply, 0.20)) hit.add('reply_unlikely');
  if (ge(closenessNeed, 0.70)) hit.add('closeness_high');
  if (affection === 'reserved') hit.add('reserved_tone');
  if (affection === 'warm') hit.add('warm_tone');
  if (truncated) hit.add('context_truncated');

  return REASON_ORDER.filter((code) => hit.has(code));
}
