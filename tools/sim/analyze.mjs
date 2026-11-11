/**
 * 16 §4.2：A1–A10 异常检测与断言评估（纯函数，不推进引擎）。
 *
 * 输入是 `.trace.jsonl` 的行数组；可选传入本步贡献分解、事件列表与
 * behavior 的 `reply_likelihood`（A10 需要）。所有检测只读，不修改 trace。
 */

import { parseTime } from '../../lib/core/clock.mjs';
import { MOOD_HOME, MOOD_KEYS, REGULATION_KEYS } from '../../lib/core/constants.mjs';

export const TRACE_PATHS = Object.freeze([
  ...MOOD_KEYS.map((key) => `mood.${key}`),
  ...REGULATION_KEYS.map((key) => `regulation.${key}`),
  'sleep.sleepiness',
  'sleep.sleep_debt',
  'stress.level',
  'cycle.phase_progress'
]);

const MOOD_PATHS = Object.freeze(MOOD_KEYS.map((key) => `mood.${key}`));
const HOUR_MS = 3_600_000;

/** A2 阈值（09 §5.6 / 00 §7.3）。 */
export const A2_LIMITS = Object.freeze({ normal: 0.06, high: 0.12, hard: 0.15 });
/** A3 贴边阈值与最短时长。 */
export const A3_LIMITS = Object.freeze({ high: 0.98, low: 0.02, hours: 72 });
/** A4 振荡：12 小时窗口内同维符号翻转次数与幅度。 */
export const A4_LIMITS = Object.freeze({ window_hours: 12, flips: 6, amplitude: 0.05 });
/** A5 恢复：事件结束 24 小时后仍偏离 home 的阈值。 */
export const A5_LIMITS = Object.freeze({ hours: 24, deviation: 0.3 });
/** A6 睡眠：连续清醒 / 单次睡眠小时数。 */
export const A6_LIMITS = Object.freeze({ awake_hours: 36, sleep_hours: 14 });
/** A7 压力：无事件窗口与最小下降量。 */
export const A7_LIMITS = Object.freeze({ hours: 6, drop: 0.02, start_level: 0.25 });
/**
 * A8 闭合容差。trace 与模块贡献都按 6 位小数落盘，且一个仿真步内可能有
 * 多次 advance（事件 + 步末），每次各自的 round6 会累积最多约 0.5e-6；
 * 这里给 1e-5 的舍入预算，仍能可靠抓住 0.1 量级的篡改。
 */
export const A8_TOLERANCE = 1e-5;

const AWAKE_STATES = new Set(['awake', 'sleepy', 'trying_to_sleep', 'waking_up']);

function getPath(obj, path) {
  let cursor = obj;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function round6(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseMs(iso) {
  try {
    return parseTime(iso, 'trace.t');
  } catch {
    return null;
  }
}

function eventMsOf(event) {
  if (typeof event === 'string') return parseMs(event);
  if (!event || typeof event !== 'object') return null;
  return parseMs(event.at ?? event.occurred_at);
}

function push(anomalies, code, severity, message, detail = {}) {
  anomalies.push({ code, severity, message, ...detail });
}

/** 按时间轴统计每个维度贴边运行的时长（小时）。 */
export function edgeRuns(trace, { high = A3_LIMITS.high, low = A3_LIMITS.low } = {}) {
  const runs = [];
  for (const path of TRACE_PATHS) {
    let current = null;
    let worst = { hours: 0 };
    for (const row of trace) {
      const value = getPath(row, path);
      const t = parseMs(row.t);
      if (typeof value !== 'number' || !Number.isFinite(value) || t === null) {
        current = null;
        continue;
      }
      const edge = value > high || value < low;
      if (!edge) {
        current = null;
        continue;
      }
      if (current && t - current.lastMs <= HOUR_MS * 1.5) {
        current.lastMs = t;
        current.hours = (current.lastMs - current.firstMs) / HOUR_MS;
      } else {
        current = { path, firstMs: t, lastMs: t, hours: 0, value };
      }
      if (current.hours > worst.hours) worst = { ...current };
    }
    if (worst.hours > 0) runs.push(worst);
  }
  return runs;
}

function detectA1(trace, anomalies) {
  for (const row of trace) {
    for (const path of TRACE_PATHS) {
      const value = getPath(row, path);
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        push(anomalies, 'A1', 'error', `${path} 越界或非有限值`, {
          t: row.t,
          path,
          value: Number.isFinite(value) ? value : String(value)
        });
      }
    }
  }
}

function deriveA2Samples(trace) {
  const samples = [];
  for (let i = 1; i < trace.length; i += 1) {
    for (const path of MOOD_PATHS) {
      const prev = getPath(trace[i - 1], path);
      const next = getPath(trace[i], path);
      if (typeof prev !== 'number' || typeof next !== 'number') continue;
      samples.push({ t: trace[i].t, path, delta: Math.abs(round6(next - prev)) });
    }
  }
  return samples;
}

function detectA2(samples, anomalies, maxima) {
  for (const sample of samples) {
    const { path, t } = sample;
    const delta = sample.delta;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
    if (delta > (maxima[path]?.delta ?? 0)) maxima[path] = { delta, t };
    if (delta > A2_LIMITS.hard + 1e-9) {
      push(anomalies, 'A2', 'error', `${path} 单步变化 ${delta} 超过实现上限 ${A2_LIMITS.hard}`, {
        t,
        path,
        delta
      });
    } else if (delta > A2_LIMITS.high + 1e-9) {
      push(anomalies, 'A2', 'high', `${path} 单步变化 ${delta} 超过高严重度阈值`, {
        t,
        path,
        delta
      });
    } else if (delta > A2_LIMITS.normal + 1e-9) {
      push(anomalies, 'A2', 'warn', `${path} 单步变化 ${delta} 超过普通阈值`, {
        t,
        path,
        delta
      });
    }
  }
}

function detectA3(trace, anomalies) {
  for (const run of edgeRuns(trace)) {
    if (run.hours >= A3_LIMITS.hours) {
      push(anomalies, 'A3', 'high', `${run.path} 连续贴边 ${run.hours.toFixed(1)} 小时`, {
        t: trace.find((row) => parseMs(row.t) === run.firstMs)?.t ?? null,
        path: run.path,
        hours: run.hours,
        value: run.value
      });
    }
  }
}

function detectA4(trace, anomalies) {
  for (const path of TRACE_PATHS) {
    let flagged = false;
    for (let i = 0; i < trace.length && !flagged; i += 1) {
      const startMs = parseMs(trace[i].t);
      if (startMs === null) continue;
      const signs = [];
      for (let j = i + 1; j < trace.length; j += 1) {
        const nowMs = parseMs(trace[j].t);
        if (nowMs === null || nowMs - startMs > A4_LIMITS.window_hours * HOUR_MS) break;
        const prev = getPath(trace[j - 1], path);
        const next = getPath(trace[j], path);
        if (typeof prev !== 'number' || typeof next !== 'number') continue;
        const delta = round6(next - prev);
        if (Math.abs(delta) <= A4_LIMITS.amplitude) continue;
        signs.push({ sign: Math.sign(delta), t: trace[j].t, delta });
      }
      let flips = 0;
      for (let k = 1; k < signs.length; k += 1) {
        if (signs[k].sign !== signs[k - 1].sign) flips += 1;
      }
      if (flips >= A4_LIMITS.flips) {
        flagged = true;
        push(anomalies, 'A4', 'high', `${path} 在 12 小时内符号翻转 ${flips} 次`, {
          t: trace[i].t,
          path,
          flips
        });
      }
    }
  }
}

function detectA5(trace, events, anomalies) {
  const times = events.map(eventMsOf).filter((value) => value !== null);
  if (times.length === 0) return;
  const lastEventMs = Math.max(...times);
  const targetMs = lastEventMs + A5_LIMITS.hours * HOUR_MS;
  let sample = null;
  for (const row of trace) {
    const t = parseMs(row.t);
    if (t !== null && t >= targetMs) {
      sample = row;
      break;
    }
  }
  if (!sample) return;
  for (const key of MOOD_KEYS) {
    const value = getPath(sample, `mood.${key}`);
    if (typeof value !== 'number') continue;
    const deviation = round6(Math.abs(value - MOOD_HOME[key]));
    if (deviation > A5_LIMITS.deviation) {
      push(anomalies, 'A5', 'high', `冲突结束 24 小时后 mood.${key} 仍偏离 home ${deviation}`, {
        t: sample.t,
        path: `mood.${key}`,
        deviation
      });
    }
  }
}

function detectA6(trace, anomalies) {
  let awakeRun = null;
  let sleepRun = null;
  const closeAwake = () => {
    if (awakeRun && awakeRun.hours >= A6_LIMITS.awake_hours) {
      push(anomalies, 'A6', 'high', `连续清醒 ${awakeRun.hours.toFixed(1)} 小时`, {
        t: awakeRun.firstIso,
        path: 'sleep.state',
        hours: awakeRun.hours
      });
    }
  };
  const closeSleep = () => {
    if (sleepRun && sleepRun.hours > A6_LIMITS.sleep_hours) {
      push(anomalies, 'A6', 'high', `单次睡眠 ${sleepRun.hours.toFixed(1)} 小时`, {
        t: sleepRun.firstIso,
        path: 'sleep.state',
        hours: sleepRun.hours
      });
    }
  };
  for (const row of trace) {
    const state = getPath(row, 'sleep.state');
    const t = parseMs(row.t);
    if (t === null) continue;
    if (AWAKE_STATES.has(state)) {
      closeSleep();
      sleepRun = null;
      if (awakeRun && t - awakeRun.lastMs <= HOUR_MS * 1.5) {
        awakeRun.lastMs = t;
        awakeRun.hours = (t - awakeRun.firstMs) / HOUR_MS;
      } else {
        awakeRun = { firstMs: t, lastMs: t, hours: 0, firstIso: row.t };
      }
    } else if (state === 'sleeping' || state === 'interrupted') {
      closeAwake();
      awakeRun = null;
      if (sleepRun && t - sleepRun.lastMs <= HOUR_MS * 1.5) {
        sleepRun.lastMs = t;
        sleepRun.hours = (t - sleepRun.firstMs) / HOUR_MS;
      } else {
        sleepRun = { firstMs: t, lastMs: t, hours: 0, firstIso: row.t };
      }
    }
  }
  closeAwake();
  closeSleep();
}

/** 已升序时间轴上的 `(fromMs, toMs]` 命中判断（二分，避免 n×events 全表扫描）。 */
function hasEventBetween(sortedTimes, fromMs, toMs) {
  let low = 0;
  let high = sortedTimes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedTimes[mid] <= fromMs) low = mid + 1;
    else high = mid;
  }
  return low < sortedTimes.length && sortedTimes[low] <= toMs;
}

function detectA7(trace, events, anomalies) {
  const times = events.map(eventMsOf).filter((value) => value !== null).sort((a, b) => a - b);
  const rowTimes = trace.map((row) => parseMs(row.t));
  let flagged = 0;
  // `endMs` 随 i 单调递增，用游标复用定位，避免每个采样点全表 find（O(n²)）。
  let endCursor = 0;
  for (let i = 0; i < trace.length && flagged < 5; i += 1) {
    const level = getPath(trace[i], 'stress.level');
    const startMs = rowTimes[i];
    if (typeof level !== 'number' || level <= A7_LIMITS.start_level || startMs === null) continue;
    const endMs = startMs + A7_LIMITS.hours * HOUR_MS;
    if (hasEventBetween(times, startMs, endMs)) continue;
    if (endCursor < i + 1) endCursor = i + 1;
    while (endCursor < rowTimes.length && (rowTimes[endCursor] === null || rowTimes[endCursor] < endMs)) {
      endCursor += 1;
    }
    if (endCursor >= rowTimes.length) continue;
    const endLevel = getPath(trace[endCursor], 'stress.level');
    if (typeof endLevel !== 'number') continue;
    const drop = round6(level - endLevel);
    if (drop < A7_LIMITS.drop) {
      flagged += 1;
      push(anomalies, 'A7', 'high', `无事件 6 小时后 stress.level 仅下降 ${drop}`, {
        t: trace[i].t,
        path: 'stress.level',
        drop
      });
    }
  }
}

/**
 * 兼容两种落盘形状：
 * - 嵌套：`{path: {source: value}}`（`contrib.json` 的关键节点）；
 * - 扁平：`{path: Σvalue}`（`run.mjs` 的 `contributionSums`，逐步骤累积）。
 * 早期实现只认嵌套形状，导致 CLI 传扁平数组时 A8 永不触发（P-16-02）。
 */
function contributionsFor(step) {
  if (!step || typeof step !== 'object') return null;
  const out = {};
  for (const [path, sources] of Object.entries(step)) {
    if (typeof sources === 'number' && Number.isFinite(sources)) {
      out[path] = round6(sources);
      continue;
    }
    if (!sources || typeof sources !== 'object') continue;
    let sum = 0;
    for (const value of Object.values(sources)) {
      if (typeof value === 'number' && Number.isFinite(value)) sum += value;
    }
    out[path] = round6(sum);
  }
  return out;
}

function detectA8(trace, contributions, anomalies) {
  if (!Array.isArray(contributions)) return;
  // contributions[i] 是把状态推进到 trace[i] 的那一步的贡献分解，
  // 首行没有可比较的上一行，跳过。
  for (let i = 1; i < trace.length; i += 1) {
    const sums = contributionsFor(contributions[i]);
    if (!sums) continue;
    for (const [path, sum] of Object.entries(sums)) {
      const prev = getPath(trace[i - 1], path);
      const next = getPath(trace[i], path);
      if (typeof prev !== 'number' || typeof next !== 'number') continue;
      const delta = round6(next - prev);
      const gap = round6(Math.abs(delta - sum));
      if (gap > A8_TOLERANCE) {
        push(anomalies, 'A8', 'error', `${path} 贡献和 ${sum} 与 Δ ${delta} 不闭合`, {
          t: trace[i].t,
          path,
          sum,
          delta,
          gap
        });
      }
    }
  }
}

function detectA10(trace, behaviorSeries, anomalies) {
  for (let i = 0; i < trace.length; i += 1) {
    const sleepiness = getPath(trace[i], 'sleep.sleepiness');
    const reply = Array.isArray(behaviorSeries) ? behaviorSeries[i] : null;
    if (typeof sleepiness === 'number' && typeof reply === 'number' && sleepiness > 0.85 && reply > 0.7) {
      push(anomalies, 'A10', 'warn', '困倦度 >0.85 但回复概率 >0.7，组合不自然', {
        t: trace[i].t,
        path: 'behavior.reply_likelihood',
        sleepiness,
        reply_likelihood: reply
      });
    }
    const stress = getPath(trace[i], 'stress.level');
    const stability = getPath(trace[i], 'mood.stability');
    const energy = getPath(trace[i], 'mood.energy');
    if (
      typeof stress === 'number' &&
      typeof stability === 'number' &&
      typeof energy === 'number' &&
      stress > 0.8 &&
      stability > 0.9 &&
      energy > 0.8
    ) {
      push(anomalies, 'A10', 'warn', '高压力下稳定性与精力同时 >0.9/0.8，组合不自然', {
        t: trace[i].t,
        path: 'mood.*',
        stress,
        stability,
        energy
      });
    }
  }
}

function statisticsOf(trace) {
  const stats = {};
  for (const path of TRACE_PATHS) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (const row of trace) {
      const value = getPath(row, path);
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count += 1;
    }
    if (count > 0) {
      stats[path] = {
        min: round6(min),
        max: round6(max),
        mean: round6(sum / count)
      };
    }
  }
  return stats;
}

function evaluateAssertions(trace, assertions, maxima, statistics) {
  const failed = [];
  const results = [];
  const maxDelta = Math.max(0, ...Object.values(maxima).map((entry) => entry.delta));
  const worstPath = Object.entries(maxima).sort((a, b) => b[1].delta - a[1].delta)[0];
  const deltaLimit = assertions?.max_abs_delta_per_step ?? 0.15;
  results.push({
    name: 'max_abs_delta_per_step',
    ok: maxDelta <= deltaLimit + 1e-9,
    detail: {
      limit: deltaLimit,
      max: round6(maxDelta),
      path: worstPath ? worstPath[0] : null,
      at: worstPath ? worstPath[1].t : null
    }
  });

  const ranges = assertions?.mean_ranges ?? {};
  for (const [path, range] of Object.entries(ranges)) {
    const mean = statistics?.[path]?.mean;
    const ok = typeof mean === 'number' && mean >= range[0] && mean <= range[1];
    results.push({
      name: `mean_range:${path}`,
      ok,
      detail: { path, mean: typeof mean === 'number' ? mean : null, range }
    });
  }

  const edgeHours = Math.max(0, ...edgeRuns(trace).map((run) => run.hours));
  const edgeLimit = assertions?.no_edge_run_hours ?? 72;
  results.push({
    name: 'no_edge_run_hours',
    ok: edgeHours <= edgeLimit,
    detail: { limit: edgeLimit, max_hours: round6(edgeHours) }
  });

  for (const result of results) {
    if (!result.ok) failed.push(result.name);
  }
  return { results, failed };
}

/**
 * 主入口。
 *
 * @param {{trace:Array, events?:Array, assertions?:object, contributions?:Array|null,
 *          behaviorSeries?:Array|null, timezone?:string}} params
 */
export function analyzeTrace({
  trace,
  events = [],
  assertions = {},
  contributions = null,
  behaviorSeries = null,
  a2Samples = null
} = {}) {
  if (!Array.isArray(trace) || trace.length === 0) {
    throw new Error('analyzeTrace requires a non-empty trace array');
  }
  const anomalies = [];
  const maxima = {};
  detectA1(trace, anomalies);
  detectA2(Array.isArray(a2Samples) ? a2Samples : deriveA2Samples(trace), anomalies, maxima);
  detectA3(trace, anomalies);
  detectA4(trace, anomalies);
  detectA5(trace, events, anomalies);
  detectA6(trace, anomalies);
  detectA7(trace, events, anomalies);
  detectA8(trace, contributions, anomalies);
  detectA10(trace, behaviorSeries, anomalies);

  const statistics = statisticsOf(trace);
  const { results, failed } = evaluateAssertions(trace, assertions, maxima, statistics);
  const counts = {};
  for (const anomaly of anomalies) counts[anomaly.code] = (counts[anomaly.code] ?? 0) + 1;

  return {
    anomalies,
    counts,
    assertions: results,
    assertions_failed: failed,
    statistics,
    max_abs_delta: Object.fromEntries(
      Object.entries(maxima).map(([path, entry]) => [path, entry.delta])
    )
  };
}

/** A1/A2(error)/A8/A9 属实现错误，CLI 据此返回非零退出码。 */
export function hasFatalAnomaly(analysis) {
  return analysis.anomalies.some(
    (anomaly) =>
      anomaly.code === 'A1' ||
      anomaly.code === 'A8' ||
      anomaly.code === 'A9' ||
      (anomaly.code === 'A2' && anomaly.severity === 'error')
  );
}
