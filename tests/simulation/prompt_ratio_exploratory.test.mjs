/**
 * M-C18（探索性核查，非正式门禁）：2160 小时 / 90 个 24 小时窗口的提示占比。
 *
 * 统计口径（P2-B 裁决）：
 *   - 总时长 2160 小时，1 小时 tick；
 *   - 固定 90 个连续 24 小时窗口，每窗口最多计 1 次命中；
 *   - 命中判定 = 该窗口内任意 tick 的 behavior_notes 精确包含目标文案；
 *   - 分母固定 90，数据不完整则不视为正式门禁结果；
 *   - 3 个固定种子分别统计，分子分母不合并。
 *
 * 门限说明：文档中的 31/90 尚无设计依据可追溯，因此本文件只断言统计口径与数据完整性，
 * 不对命中数设置通过/失败阈值，也不得被当作理论门禁的证据。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { loadValidState } from '../helpers/state.mjs';

const MODULES = [
  cycleModule,
  sleepModule,
  stressModule,
  eventModule,
  regulationModule,
  moodModule,
  behaviorModule,
  deliveryModule
];

const HOURS = 2160;
const WINDOW_HOURS = 24;
const WINDOW_COUNT = HOURS / WINDOW_HOURS;
const TARGET_NOTE = '身体状态不太舒服';
const SEEDS = [
  '00000000000000000000000000000001',
  '00000000000000000000000000000002',
  '00000000000000000000000000000003'
];

function runSeed(seed) {
  let state = loadValidState();
  const provider = new RandomProvider({ master_seed_hex: seed, character_id: state.character_id });
  let now = state.last_tick_at;
  const windows = [];
  const phaseOfHits = {};
  let targetTicks = 0;
  let missingContext = 0;

  for (let hour = 0; hour < HOURS; hour += 1) {
    now = new Date(Date.parse(now) + 3600_000).toISOString();
    const out = advance({ state, event: null, now, rngProvider: provider, modules: MODULES });
    state = out.state;

    const notes = out.behavior_context?.behavior_notes;
    if (!Array.isArray(notes)) {
      missingContext += 1;
      continue;
    }
    const hit = notes.includes(TARGET_NOTE);
    if (hit) {
      targetTicks += 1;
      const phase = state.cycle?.phase ?? 'unknown';
      phaseOfHits[phase] = (phaseOfHits[phase] ?? 0) + 1;
    }
    if (hour % WINDOW_HOURS === 0) windows.push(false);
    if (hit) windows[windows.length - 1] = true;
  }

  return {
    seed,
    ticks: HOURS,
    windows: windows.length,
    windowHits: windows.filter(Boolean).length,
    ratio: windows.filter(Boolean).length / WINDOW_COUNT,
    targetTicks,
    missingContext,
    phaseOfHits
  };
}

test('M-C18 探索性：3 个固定种子的 90 窗口提示占比（分别统计，不设门限）', (t) => {
  const results = SEEDS.map((seed) => runSeed(seed));

  for (const result of results) {
    assert.equal(result.ticks, HOURS, `种子 ${result.seed} 推进步数不足`);
    assert.equal(result.missingContext, 0, `种子 ${result.seed} 存在缺失 behavior_context 的 tick，数据不完整`);
    assert.equal(result.windows, WINDOW_COUNT, `种子 ${result.seed} 窗口数应为 ${WINDOW_COUNT}`);
    assert.ok(result.windowHits >= 0 && result.windowHits <= WINDOW_COUNT);
    t.diagnostic(
      `seed=${result.seed.slice(-2)} 命中窗口=${result.windowHits}/${WINDOW_COUNT} ` +
        `占比=${(result.ratio * 100).toFixed(1)}% 命中 tick=${result.targetTicks} ` +
        `阶段分布=${JSON.stringify(result.phaseOfHits)}`
    );
  }

  // 口径自检：至少一个种子出现命中，否则“任意 tick 命中”的判定可能失效。
  assert.ok(
    results.some((result) => result.windowHits > 0),
    '三个种子均未命中目标提示，统计口径或触发链路可能失效'
  );
});
