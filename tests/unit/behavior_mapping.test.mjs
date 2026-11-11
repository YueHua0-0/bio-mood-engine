/**
 * 10 §8 B01–B02 / B05–B17：行为映射的量、区间、睡眠约束、文案、原因码与降级。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { NOTE_MAX_CHARS, NOTE_TABLE, buildNotes, isNoteSafe } from '../../lib/modules/behavior/notes.mjs';
import { REASON_ORDER } from '../../lib/modules/behavior/reasons.mjs';
import { LATENCY_TIERS, latencyRange } from '../../lib/modules/behavior/latency.mjs';
import { updateBehavior, trimContext } from '../../lib/modules/behavior/index.mjs';

const NOW = '2026-11-10T08:00:00.000Z';

function makeInputs(overrides = {}) {
  return {
    mood: {
      energy: 0.60,
      stability: 0.65,
      sensitivity: 0.45,
      social_drive: 0.55,
      closeness_need: 0.45,
      ...(overrides.mood ?? {})
    },
    sleep: {
      state: 'awake',
      sleepiness: 0.25,
      sleep_debt: 0.15,
      ...(overrides.sleep ?? {})
    },
    stress: { level: 0.15, ...(overrides.stress ?? {}) }
  };
}

function run(overrides = {}, previous = null) {
  return updateBehavior({ previous, inputs: makeInputs(overrides), now: NOW, rng: null, config: {} });
}

test('B01 延迟档位边界：0.70/0.69/0.40/0.39/0.20/0.19', () => {
  assert.deepEqual(latencyRange(0.70), [10, 120]);
  assert.deepEqual(latencyRange(0.69), [60, 600]);
  assert.deepEqual(latencyRange(0.40), [60, 600]);
  assert.deepEqual(latencyRange(0.39), [300, 1800]);
  assert.deepEqual(latencyRange(0.20), [300, 1800]);
  assert.deepEqual(latencyRange(0.19), [1200, 7200]);
});

test('B01 先 round6 再判档：0.6999999 归入 0.70 档', () => {
  assert.deepEqual(latencyRange(0.6999999), [10, 120]);
  assert.deepEqual(latencyRange(0.699999), [60, 600]);
  assert.deepEqual(latencyRange(0.1999999), [300, 1800]);
  assert.deepEqual(latencyRange(0.199999), [1200, 7200]);
});

test('B02 四档区间：整数秒、min ≤ max、互不重叠', () => {
  for (const tier of LATENCY_TIERS) {
    const [min, max] = tier.range;
    assert.ok(Number.isInteger(min) && Number.isInteger(max), '端点必须为整数秒');
    assert.ok(min <= max, 'min 不得大于 max');
  }
  for (let i = 0; i < LATENCY_TIERS.length - 1; i += 1) {
    const upper = LATENCY_TIERS[i];
    const lower = LATENCY_TIERS[i + 1];
    assert.ok(upper.min > lower.min, '档位阈值必须严格递减');
  }
});

test('B05 七个输入各取 0/1 的全组合：四个连续量合法且无 -0', () => {
  const keys = [
    ['mood', 'energy'],
    ['mood', 'stability'],
    ['mood', 'sensitivity'],
    ['mood', 'social_drive'],
    ['mood', 'closeness_need'],
    ['sleep', 'sleepiness'],
    ['sleep', 'sleep_debt']
  ];
  for (let bits = 0; bits < 1 << keys.length; bits += 1) {
    const overrides = { mood: {}, sleep: {} };
    keys.forEach(([group, key], index) => {
      overrides[group][key] = (bits >> index) & 1;
    });
    const result = run(overrides);
    const ctx = result.state;
    for (const field of ['avoidance_tendency', 'reply_likelihood', 'social_initiative', 'need_for_reassurance']) {
      const value = ctx[field];
      assert.ok(Number.isFinite(value), `${field} 必须有限`);
      assert.ok(value >= 0 && value <= 1, `${field} 必须在 [0,1]`);
      assert.ok(!Object.is(value, -0), `${field} 不得为 -0`);
    }
  }
});

test('B06 sleeping 优先于一切倾向：should_reply=false / sleepy / short', () => {
  const result = run({
    sleep: { state: 'sleeping' },
    mood: { energy: 1.0, social_drive: 1.0, closeness_need: 1.0 },
    stress: { level: 0 }
  });
  assert.equal(result.state.sleep_constraint.should_reply, false);
  assert.equal(result.state.sleep_constraint.tone, 'sleepy');
  assert.equal(result.state.sleep_constraint.max_reply_length, 'short');
  assert.equal(result.state.hard_rule_precedence, true);
});

test('B07 waking_up：should_reply=true、tone=waking', () => {
  const result = run({ sleep: { state: 'waking_up' } });
  assert.equal(result.state.sleep_constraint.should_reply, true);
  assert.equal(result.state.sleep_constraint.tone, 'waking');
  assert.equal(result.state.sleep_constraint.max_reply_length, 'normal');
});

test('B08 sleepiness 0.60/0.61：严格大于才切 sleepy', () => {
  assert.equal(run({ sleep: { state: 'awake', sleepiness: 0.60 } }).state.sleep_constraint.tone, 'none');
  assert.equal(run({ sleep: { state: 'awake', sleepiness: 0.61 } }).state.sleep_constraint.tone, 'sleepy');
});

test('B09 含数字文案被拒并回退兜底', () => {
  assert.equal(isNoteSafe('回复概率 0.3'), false);
  assert.equal(isNoteSafe('\u8bca\u65ad\u7ed3\u8bba'), false);
  assert.equal(isNoteSafe('energy 偏高'), false);
  assert.equal(isNoteSafe('a'.repeat(NOTE_MAX_CHARS + 1)), false);

  const table = [
    { priority: 1, when: () => true, text: '回复概率 0.3' },
    { priority: 2, when: () => true, text: '语气自然，跟随当前情境' }
  ];
  const { notes, warnings } = buildNotes({}, table);
  assert.deepEqual(notes, ['语气自然，跟随当前情境']);
  assert.ok(warnings.includes('INVALID_BEHAVIOR_NOTE'));
});

test('B10 文案顺序严格等于 §5.8 优先级序；截断先删 notes 再删 codes', () => {
  const result = run({
    sleep: { state: 'sleeping', sleepiness: 0.9, sleep_debt: 0.9 },
    stress: { level: 0.9 },
    mood: { energy: 0.1, social_drive: 0.1, closeness_need: 0.9 }
  });
  const notes = result.state.behavior_notes;
  assert.ok(notes.length <= 3);
  const indices = notes.map((text) => NOTE_TABLE.findIndex((entry) => entry.text === text));
  assert.ok(indices.every((idx) => idx >= 0), '文案必须来自固定表');
  assert.deepEqual([...indices].sort((a, b) => a - b), indices, '文案顺序必须等于优先级序');

  const context = {
    avoidance_tendency: 0.5,
    reply_likelihood: 0.5,
    social_initiative: 0.5,
    need_for_reassurance: 0.5,
    response_latency_range_seconds: [60, 600],
    verbosity_bias: 'normal',
    affection_expression: 'normal',
    sleep_constraint: { should_reply: true, tone: 'none', max_reply_length: 'normal' },
    behavior_notes: ['当前处于睡眠模拟状态，倾向延迟回应', '刚醒来，回应节奏偏慢', '困倦明显，表达应简短'],
    reason_codes: ['sleeping', 'sleepiness_high', 'sleep_debt_high', 'stress_high'],
    hard_rule_precedence: true
  };
  const trimmed = trimContext(context, JSON.stringify(context).length - 10);
  assert.ok(trimmed.truncated);
  assert.ok(trimmed.context.behavior_notes.length < context.behavior_notes.length, '应先删 notes');
  assert.ok(trimmed.context.reason_codes.includes('context_truncated'));
});

test('B11 同输入同 previous 两次输出深度相等，contributions 为 {}', () => {
  const previous = { verbosity_bias: 'high', affection_expression: 'warm' };
  const a = run({}, previous);
  const b = run({}, previous);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.reason_codes, b.reason_codes);
  assert.deepEqual(a.contributions, {});
  assert.ok(a.warnings.includes('NO_STATE_CONTRIBUTIONS'));
});

test('B12 缺 mood / sleep / stress：契约默认值降级且输出合法', () => {
  const result = updateBehavior({ previous: null, inputs: {}, now: NOW, rng: null, config: {} });
  assert.ok(result.warnings.includes('MISSING_MOOD_DATA'));
  assert.ok(result.warnings.includes('MISSING_STRESS_DATA'));
  assert.ok(result.warnings.includes('MISSING_SLEEP_DATA'));
  assert.ok(result.warnings.includes('HYSTERESIS_RESET'));
  assert.equal(result.state.hard_rule_precedence, true);
  assert.ok(result.state.behavior_notes.length >= 1);
});

test('B13 hard_rule_precedence 恒为 true（含 sleeping / 高压力 / 低能量组合）', () => {
  const cases = [
    { sleep: { state: 'sleeping' } },
    { stress: { level: 1 } },
    { mood: { energy: 0 } },
    { mood: { energy: 0, social_drive: 0 }, sleep: { state: 'sleeping', sleepiness: 1 }, stress: { level: 1 } }
  ];
  for (const item of cases) {
    assert.equal(run(item).state.hard_rule_precedence, true);
  }
});

test('B14 仅提升 social_drive：reply_likelihood 单调不减', () => {
  for (let i = 0; i <= 50; i += 1) {
    const base = {
      energy: (i % 7) / 7,
      stability: (i % 5) / 5,
      sensitivity: (i % 3) / 3,
      closeness_need: (i % 11) / 11
    };
    const low = run({ mood: { ...base, social_drive: 0.10 } }).state.reply_likelihood;
    const high = run({ mood: { ...base, social_drive: 0.90 } }).state.reply_likelihood;
    assert.ok(high >= low, `social_drive 升高时 reply_likelihood 不得下降（i=${i}）`);
  }
});

test('B15 reason_codes ≤16 且顺序固定；文案无禁用词与数字', () => {
  const result = run({
    sleep: { state: 'sleeping', sleepiness: 0.9, sleep_debt: 0.9 },
    stress: { level: 0.9 },
    mood: { energy: 0.1, social_drive: 0.1, closeness_need: 0.9, stability: 0.1, sensitivity: 0.9 }
  });
  const codes = result.state.reason_codes;
  assert.ok(codes.length <= 16);
  const ordered = REASON_ORDER.filter((code) => codes.includes(code));
  assert.deepEqual(codes, ordered);

  const banned = ['\u8bca\u65ad', '\u6fc0\u7d20', '\u533b\u5b66', '\u6cbb\u7597'];
  for (const note of result.state.behavior_notes) {
    assert.ok(note.length <= NOTE_MAX_CHARS);
    assert.equal(/[0-9]/.test(note), false, '文案不得含数字');
    for (const word of banned) assert.equal(note.includes(word), false);
  }
});

test('B16 previous 只读两个键：完整 behavior_context 与两键子集输出深度相等', () => {
  const twoKeys = { verbosity_bias: 'high', affection_expression: 'warm' };
  const full = {
    avoidance_tendency: 0.9,
    reply_likelihood: 0.05,
    social_initiative: 0.01,
    need_for_reassurance: 0.02,
    response_latency_range_seconds: [1200, 7200],
    verbosity_bias: 'high',
    affection_expression: 'warm',
    sleep_constraint: { should_reply: false, tone: 'sleepy', max_reply_length: 'short' },
    behavior_notes: ['不应被读取'],
    reason_codes: ['energy_low'],
    hard_rule_precedence: true
  };
  const a = run({}, twoKeys);
  const b = run({}, full);
  assert.deepEqual(a.state, b.state);
  assert.ok(!a.warnings.includes('HYSTERESIS_RESET'));
  assert.ok(!b.warnings.includes('HYSTERESIS_RESET'));
});

test('B17 09 home 稳态：previous=null 时 verbosity_bias 必须为 normal（v1.7.9）', () => {
  const result = run({
    mood: { energy: 0.60, social_drive: 0.55 },
    sleep: { state: 'awake', sleepiness: 0.25, sleep_debt: 0.15 }
  });
  assert.equal(result.state.verbosity_bias, 'normal');

  // 对照：进入阈值之上才允许 high；保持阈值只对 previous='high' 生效
  assert.equal(run({ mood: { energy: 0.63, social_drive: 0.59 } }).state.verbosity_bias, 'high');
  assert.equal(run({ mood: { energy: 0.61, social_drive: 0.57 } }).state.verbosity_bias, 'normal');
  const prevHigh = { verbosity_bias: 'high', affection_expression: 'normal' };
  assert.equal(run({ mood: { energy: 0.57, social_drive: 0.53 } }, prevHigh).state.verbosity_bias, 'high');
  assert.equal(run({ mood: { energy: 0.56, social_drive: 0.53 } }, prevHigh).state.verbosity_bias, 'normal');
});

test('输入越界钳制并追加 INPUT_CLAMPED；NaN 拒绝', () => {
  const clamped = run({ mood: { energy: 1.2 } });
  assert.ok(clamped.warnings.includes('INPUT_CLAMPED'));
  assert.equal(clamped.state.reply_likelihood <= 1, true);

  assert.throws(
    () => run({ mood: { energy: Number.NaN } }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});
