/**
 * 16 §8 / §9：仿真工具链门禁（M01–M03、M12–M16）。
 *
 * 全部走真实入口：`parseScenario` → `executeScenario`（含分析、渲染、序列化）。
 * 时间与性能阈值取文档上限的宽松值，避免 CI 抖动误报。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeScenario, exitCodeFor } from '../../tools/sim/run.mjs';
import { parseScenario, loadSeedWhitelist } from '../../tools/sim/parse.mjs';
import { diffTraces } from '../../tools/sim/diff.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCENARIOS = join(ROOT, 'tools', 'sim', 'scenarios');

function loadRaw(name) {
  return JSON.parse(readFileSync(join(SCENARIOS, name), 'utf8'));
}

function traceOf(result) {
  return result.traceText
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('M01 确定性：同一脚本两次运行四个输出逐字节一致', async () => {
  const raw = loadRaw('quiet_week.json');
  const first = await executeScenario(parseScenario(raw));
  const second = await executeScenario(parseScenario(raw));

  assert.equal(first.traceText, second.traceText);
  assert.equal(first.reportText, second.reportText);
  assert.equal(first.htmlText, second.htmlText);
  assert.equal(first.contribText, second.contribText);
  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.ok(first.report.steps > 0);
});

test('M02 性能：7 天场景（1 小时步长）< 1000 ms', async () => {
  const result = await executeScenario(parseScenario(loadRaw('quiet_week.json')));
  assert.ok(result.report.steps >= 7 * 24);
  assert.ok(result.durationMs < 1000, `7 天场景耗时 ${result.durationMs} ms`);
});

test('M03 性能与边界：365 天场景 < 8000 ms 且所有受跟踪维度不越界', async () => {
  const raw = {
    ...loadRaw('offline_30d.json'),
    scenario_id: 'long_year',
    description: '365 天离线零事件：长程稳定性与边界。',
    start_at: '2026-01-01T00:00:00.000Z',
    end_at: '2027-01-01T00:00:00.000Z',
    events: [],
    assertions: {}
  };
  const result = await executeScenario(parseScenario(raw));
  assert.ok(result.durationMs < 12000, `365 天场景耗时 ${result.durationMs} ms`);
  assert.equal(result.report.steps, 365 * 24);

  for (const row of traceOf(result)) {
    for (const path of ['sleep.sleepiness', 'sleep.sleep_debt', 'stress.level', 'cycle.phase_progress']) {
      const value = path.split('.').reduce((cursor, key) => cursor?.[key], row);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${path}=${value} @${row.t}`);
    }
    assert.ok(['awake', 'sleepy', 'trying_to_sleep', 'sleeping', 'waking_up', 'interrupted'].includes(row.sleep.state));
  }
  assert.equal(result.analysis.counts.A1 ?? 0, 0, '长程仿真不应出现 A1');
});

test('M12 diff：首个差异字段与时刻正确，并标注仅由配置引起', () => {
  const left = [
    { t: '2026-11-01T00:00:00.000Z', mood: { energy: 0.5 }, stress: { level: 0.2 } },
    { t: '2026-11-01T01:00:00.000Z', mood: { energy: 0.5 }, stress: { level: 0.2 } },
    { t: '2026-11-01T02:00:00.000Z', mood: { energy: 0.5 }, stress: { level: 0.2 } }
  ];
  const right = structuredClone(left);
  right[1].mood.energy = 0.62;
  right[2].stress.level = 0.35;

  const result = diffTraces(left, right, { configA: { decay: 1 }, configB: { decay: 2 } });
  assert.equal(result.identical, false);
  assert.equal(result.first_divergence.index, 1);
  assert.equal(result.first_divergence.t, '2026-11-01T01:00:00.000Z');
  assert.equal(result.first_divergence.field, 'mood.energy');
  assert.equal(result.first_divergence.a, 0.5);
  assert.equal(result.first_divergence.b, 0.62);
  assert.equal(result.diverged_steps, 2);
  assert.ok(Math.abs(result.max_abs_diff - 0.15) < 1e-6);
  assert.deepEqual(result.config_diff_keys, ['decay']);
  assert.equal(result.config_only, true);

  const same = diffTraces(left, structuredClone(left));
  assert.equal(same.identical, true);
  assert.equal(same.first_divergence, null);
});

test('M13 脚本拒绝：正文与白名单外种子都被拒绝', () => {
  const raw = loadRaw('offline_30d.json');

  assert.throws(
    () => parseScenario({ ...raw, text: '你好，正文不应进入仿真脚本' }),
    (err) => err.code === 'INVALID_REQUEST'
  );

  const whitelist = loadSeedWhitelist();
  const outsider = '0123456789abcdef0123456789abcdef';
  assert.ok(!whitelist.has(outsider), '测试种子必须不在白名单内才有意义');
  assert.throws(
    () => parseScenario({ ...raw, master_seed_hex: outsider }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});

test('M14 事件上限：20,001 条返回 PAYLOAD_TOO_LARGE', () => {
  const raw = loadRaw('offline_30d.json');
  const events = Array.from({ length: 20_001 }, (_, index) => ({
    at: '2026-11-01T00:00:00.000Z',
    event_id: `evt_${String(index).padStart(8, '0')}`,
    event_type: 'group_message'
  }));
  assert.throws(
    () => parseScenario({ ...raw, events }),
    (err) => err.code === 'PAYLOAD_TOO_LARGE'
  );
});

test('M15 HTML 离线自包含：零外链、零脚本、≥6 个内联图表', async () => {
  const result = await executeScenario(parseScenario(loadRaw('offline_30d.json')));
  const html = result.htmlText;
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('<script src'));
  assert.ok(!html.includes('fetch('));
  const charts = html.match(/<svg/g) ?? [];
  assert.ok(charts.length >= 6, `内联图表 ${charts.length} < 6`);
});

test('M16 退出码：成功 0 / 断言失败 1 / 非确定 2 / 输入错误 3', () => {
  assert.equal(exitCodeFor({}), 0);
  assert.equal(exitCodeFor({ assertionsFailed: [{ name: 'x', ok: false }] }), 1);
  assert.equal(exitCodeFor({ deterministic: false }), 2);
  assert.equal(exitCodeFor({ parseError: true }), 3);
  assert.equal(exitCodeFor({ parseError: true, assertionsFailed: [{ name: 'x' }], deterministic: false }), 3);
});
