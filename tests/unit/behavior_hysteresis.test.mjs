/**
 * 10 §8 B03 / B04 与 §5.4–§5.5 的 ±0.05 滞回：
 * 滞回只在同一次 advance 的 chunk 间生效；跨 advance 一律 HYSTERESIS_RESET。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { updateBehavior } from '../../lib/modules/behavior/index.mjs';
import { pickAffection, pickVerbosity } from '../../lib/modules/behavior/tone.mjs';

const NOW = '2026-11-10T08:00:00.000Z';

function run(mood, sleep = {}, previous = null) {
  return updateBehavior({
    previous,
    inputs: {
      mood: { energy: 0.60, stability: 0.65, sensitivity: 0.45, social_drive: 0.55, closeness_need: 0.45, ...mood },
      sleep: { state: 'awake', sleepiness: 0.20, sleep_debt: 0.15, ...sleep },
      stress: { level: 0.15 }
    },
    now: NOW,
    rng: null,
    config: {}
  });
}

test('B03 话量滞回：初次 high 后 energy 0.58↔0.62 在 chunk 间保持 high', () => {
  const prev = { verbosity_bias: 'high', affection_expression: 'normal' };
  const at058 = run({ energy: 0.58, social_drive: 0.60 }, {}, prev);
  const at062 = run({ energy: 0.62, social_drive: 0.60 }, {}, prev);
  assert.equal(at058.state.verbosity_bias, 'high');
  assert.equal(at062.state.verbosity_bias, 'high');

  // 对照：没有 previous（跨 advance 无记忆）时 0.58 直接落到 normal
  const reset = run({ energy: 0.58, social_drive: 0.60 }, {}, null);
  assert.equal(reset.state.verbosity_bias, 'normal');
  assert.ok(reset.warnings.includes('HYSTERESIS_RESET'));
});

test('B03 话量滞回释放：energy 跌破 0.55 或 social_drive 跌破 0.50 后回基础阈值', () => {
  assert.equal(pickVerbosity({ energy: 0.54, sleepiness: 0.2, social_drive: 0.60 }, 'high'), 'normal');
  assert.equal(pickVerbosity({ energy: 0.60, sleepiness: 0.2, social_drive: 0.49 }, 'normal'), 'normal');
  assert.equal(pickVerbosity({ energy: 0.20, sleepiness: 0.2, social_drive: 0.60 }, 'low'), 'low');
  assert.equal(pickVerbosity({ energy: 0.45, sleepiness: 0.2, social_drive: 0.60 }, 'low'), 'normal');
});

test('B04 亲密表达滞回：初次 warm 后 closeness 0.68↔0.72 保持 warm', () => {
  const prev = { verbosity_bias: 'normal', affection_expression: 'warm' };
  const at068 = run({ closeness_need: 0.68 }, {}, prev);
  const at072 = run({ closeness_need: 0.72 }, {}, prev);
  assert.equal(at068.state.affection_expression, 'warm');
  assert.equal(at072.state.affection_expression, 'warm');

  // 对照：无 previous 时 0.68 直接落 normal
  assert.equal(run({ closeness_need: 0.68 }, {}, null).state.affection_expression, 'normal');
});

test('B04 判定顺序：先 reserved 再 warm，高压力不得 warm', () => {
  assert.equal(pickAffection({ closeness_need: 0.90, stress: 0.75 }, null), 'reserved');
  assert.equal(pickAffection({ closeness_need: 0.90, stress: 0.49 }, null), 'warm');
  assert.equal(pickAffection({ closeness_need: 0.68, stress: 0.40 }, 'warm'), 'warm');
  assert.equal(pickAffection({ closeness_need: 0.68, stress: 0.56 }, 'warm'), 'normal');
});

test('跨 advance：previous 缺键或档位非法一律 HYSTERESIS_RESET', () => {
  const missing = run({ energy: 0.62 }, {}, { verbosity_bias: 'high' });
  assert.ok(missing.warnings.includes('HYSTERESIS_RESET'));

  const illegal = run({ energy: 0.62 }, {}, { verbosity_bias: 'loud', affection_expression: 'warm' });
  assert.ok(illegal.warnings.includes('HYSTERESIS_RESET'));
  assert.equal(illegal.state.affection_expression !== undefined, true);
});
