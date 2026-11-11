/**
 * 14 §5.7 / §5.8 的报告数据辅助：把仿真序列压成可回归比对的数字。
 *
 * 只做统计与格式化，不读时钟（`performance.now()` 只在 tests/simulation 中出现），不写文件。
 */

import { MOOD_KEYS } from '../../lib/core/constants.mjs';
import { stateFingerprint } from '../../lib/core/models.mjs';

/** 线性插值分位数（输入会被复制排序，不改原数组）。 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function stats(series) {
  return {
    min: Math.min(...series),
    max: Math.max(...series),
    mean: series.reduce((sum, value) => sum + value, 0) / series.length
  };
}

/**
 * 仿真摘要：每个维度的 min/max/mean、最终指纹、版本区间、耗时。
 * @param {object[]} states 按时间顺序的状态序列
 * @param {{durationMs?:number, label?:string}} [meta]
 */
export function summarizeStates(states, meta = {}) {
  if (!Array.isArray(states) || states.length === 0) throw new Error('summarizeStates needs at least one state');
  const mood = {};
  for (const key of MOOD_KEYS) {
    mood[key] = stats(states.map((state) => state.mood[key]));
  }
  const versions = states.map((state) => state.state_version);
  const activeCounts = states.map((state) => state.stress.active_events.length);
  return {
    label: meta.label ?? 'simulation',
    steps: states.length,
    state_summary: {
      first_version: versions[0],
      last_version: versions[versions.length - 1],
      min_version: Math.min(...versions),
      max_version: Math.max(...versions),
      monotonic: versions.every((value, index) => index === 0 || value === versions[index - 1] + 1)
    },
    stress: {
      level: stats(states.map((state) => state.stress.level)),
      max_active_events: Math.max(...activeCounts)
    },
    sleep: {
      debt: stats(states.map((state) => state.sleep.sleep_debt)),
      sleepiness: stats(states.map((state) => state.sleep.sleepiness))
    },
    mood,
    fingerprint: stateFingerprint(states[states.length - 1]),
    duration_ms: meta.durationMs ?? null
  };
}

/** 报告表格行：`| SIM01 | 平静一周 | 指纹 | 耗时 |`。 */
export function formatRow({ id, name, fingerprint, durationMs, steps }) {
  return `| ${id} | ${name} | ${steps} | \`${fingerprint}\` | ${Number(durationMs).toFixed(1)} |`;
}

/** 任意 7 日窗口（按步数对齐）的标准差，用于 S6。 */
export function windowStdDev(values, windowSize) {
  const out = [];
  for (let start = 0; start + windowSize <= values.length; start += 1) {
    const window = values.slice(start, start + windowSize);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;
    out.push(Math.sqrt(variance));
  }
  return out;
}
