/**
 * 16 §7：M04–M11 —— A1–A8 异常检测。
 *
 * 用例都在 `offline_30d` 的真实 trace 上克隆后注入单点伪造，避免手写
 * trace 与引擎形状不一致；只在断言里检查被注入的那一项，其余告警放行。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MOOD_HOME } from '../../lib/core/constants.mjs';
import { analyzeTrace } from '../../tools/sim/analyze.mjs';
import { loadScenarioFile } from '../../tools/sim/parse.mjs';
import { executeScenario } from '../../tools/sim/run.mjs';

const SCENARIO_PATH = fileURLToPath(
  new URL('../../tools/sim/scenarios/offline_30d.json', import.meta.url)
);

const scenario = loadScenarioFile(SCENARIO_PATH);
const BASE = await executeScenario(scenario);
const BASE_TRACE = BASE.sim.trace;

function cloneTrace() {
  return structuredClone(BASE_TRACE);
}

function analyze(trace, { events = [], contributions = null } = {}) {
  return analyzeTrace({ trace, events, assertions: {}, contributions });
}

function findByCode(result, code) {
  return result.anomalies.filter((anomaly) => anomaly.code === code);
}

/** 找一个 `mood.energy` 处于 [0.40, 0.75] 的非首行步骤，注入 +0.2 不会撞上 1.0 上界。 */
function energyStep() {
  const index = BASE_TRACE.findIndex(
    (row, position) => position > 0 && row.mood.energy >= 0.4 && row.mood.energy <= 0.75
  );
  assert.ok(index > 0, 'offline_30d 应存在 energy 处于 [0.40, 0.75] 的步骤');
  return index;
}

test('M04 伪造 mood.energy=1.2 的 trace → A1 越界', () => {
  const trace = cloneTrace();
  trace[200].mood.energy = 1.2;
  const result = analyze(trace);
  const hits = findByCode(result, 'A1').filter((anomaly) => anomaly.path === 'mood.energy');
  assert.equal(hits.length, 1, '应报 1 条 mood.energy 越界');
  assert.equal(hits[0].value, 1.2);
  assert.equal(hits[0].t, trace[200].t);
});

test('M05 单步伪造跳变 0.2 → A2（error 级）', () => {
  const index = energyStep();
  const trace = cloneTrace();
  trace[index].mood.energy = Number((trace[index - 1].mood.energy + 0.2).toFixed(6));
  const result = analyze(trace);
  const hits = findByCode(result, 'A2').filter(
    (anomaly) => anomaly.path === 'mood.energy' && anomaly.severity === 'error'
  );
  assert.ok(hits.length >= 1, '单步 0.2 应触发 error 级 A2');
  assert.ok(hits[0].delta > 0.15);
});

test('M06 连续 80 小时 0.99 → A3 长期贴边', () => {
  const trace = cloneTrace();
  for (let offset = 0; offset < 80; offset += 1) trace[50 + offset].stress.level = 0.99;
  const result = analyze(trace);
  const hits = findByCode(result, 'A3').filter((anomaly) => anomaly.path === 'stress.level');
  assert.ok(hits.length >= 1, '80 小时贴边应触发 A3');
  assert.ok(hits[0].hours >= 72, `贴边时长 ${hits[0].hours} 应 ≥72 小时`);
});

test('M07 12 小时内来回抖动 → A4 振荡', () => {
  const trace = cloneTrace();
  for (let offset = 0; offset < 13; offset += 1) {
    trace[300 + offset].stress.level = offset % 2 === 0 ? 0.4 : 0.5;
  }
  const result = analyze(trace);
  const hits = findByCode(result, 'A4').filter((anomaly) => anomaly.path === 'stress.level');
  assert.ok(hits.length >= 1, '12 小时内 11 次符号翻转应触发 A4');
  assert.ok(hits[0].flips >= 6);
});

test('M08 冲突后 24 小时不恢复 → A5', () => {
  const trace = cloneTrace();
  const events = [{ at: trace[100].t }];
  const targetMs = Date.parse(trace[100].t) + 24 * 3_600_000;
  const row = trace.find((item) => Date.parse(item.t) >= targetMs);
  assert.ok(row, 'trace 应覆盖事件后 24 小时');
  row.mood.stability = 0;
  assert.ok(Math.abs(0 - MOOD_HOME.stability) > 0.3, '注入值应偏离 home >0.3');
  const result = analyze(trace, { events });
  const hits = findByCode(result, 'A5').filter((anomaly) => anomaly.path === 'mood.stability');
  assert.ok(hits.length >= 1, '24 小时后仍偏离 home 应触发 A5');
  assert.ok(hits[0].deviation > 0.3);
});

test('M09 连续清醒 46 小时 → A6', () => {
  const trace = cloneTrace();
  for (let offset = 0; offset < 46; offset += 1) trace[200 + offset].sleep.state = 'awake';
  const result = analyze(trace);
  const hits = findByCode(result, 'A6').filter((anomaly) => anomaly.path === 'sleep.state');
  assert.ok(hits.length >= 1, '连续清醒 46 小时应触发 A6');
  assert.ok(hits.some((anomaly) => anomaly.hours >= 36));
});

test('M10 无事件 9 小时压力不降 → A7', () => {
  const trace = cloneTrace();
  for (let offset = 0; offset < 9; offset += 1) trace[400 + offset].stress.level = 0.5;
  const result = analyze(trace, { events: [] });
  const hits = findByCode(result, 'A7').filter((anomaly) => anomaly.path === 'stress.level');
  assert.ok(hits.length >= 1, '无事件 6 小时后压力不降应触发 A7');
  assert.ok(hits[0].drop < 0.02);
});

test('M11 篡改某步 contributions → A8；未篡改的 trace 不报 A8', () => {
  const clean = analyze(BASE_TRACE, { contributions: BASE.sim.contributionSums });
  assert.equal(findByCode(clean, 'A8').length, 0, '真实 trace 的贡献必须闭合');

  const contributions = BASE.sim.contributionSums.map((step) => ({ ...step }));
  const index = 120;
  contributions[index]['mood.energy'] = (contributions[index]['mood.energy'] ?? 0) + 0.1;
  const tampered = analyze(BASE_TRACE, { contributions });
  const hits = findByCode(tampered, 'A8').filter((anomaly) => anomaly.path === 'mood.energy');
  assert.ok(hits.length >= 1, '贡献和与 Δ 差 0.1 应触发 A8');
  assert.ok(Math.abs(hits[0].gap - 0.1) < 1e-6);
  assert.equal(hits[0].t, BASE_TRACE[index].t);
});
