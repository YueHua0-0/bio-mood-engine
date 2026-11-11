/**
 * 16 §3.2 / §5：仿真回放 CLI。
 *
 *   node tools/sim/run.mjs tools/sim/scenarios/quiet_week.json --out out
 *
 * 输出：
 *   <out>/<scenario_id>.trace.jsonl
 *   <out>/<scenario_id>.report.json
 *   <out>/<scenario_id>.html
 *   <out>/<scenario_id>.contrib.json
 *
 * 确定性：不读取系统时间、不使用 Math.random；同脚本两次运行四个文件逐字节一致。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENGINE_VERSION, MOOD_KEYS, REGULATION_KEYS, RANDOM_ALGORITHM_VERSION, SCHEMA_VERSION } from '../../lib/core/constants.mjs';
import { parseTime, toIso } from '../../lib/core/clock.mjs';
import { advance } from '../../lib/core/coordinator.mjs';
import { createDefaultState, stateFingerprint, stateSummary } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';

import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';

import { MODULE_ORDER } from '../../lib/core/constants.mjs';
import { analyzeTrace, hasFatalAnomaly } from './analyze.mjs';
import { loadScenarioFile, SimError } from './parse.mjs';
import { renderHtml } from './render.mjs';

export const MODULES = Object.freeze([
  cycleModule,
  sleepModule,
  stressModule,
  eventModule,
  regulationModule,
  moodModule,
  behaviorModule,
  deliveryModule
]);

MODULE_ORDER.forEach((name, index) => {
  if (MODULES[index]?.name !== name) {
    throw new Error(`module order mismatch at ${index}: expected ${name}, got ${MODULES[index]?.name}`);
  }
});

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ASSERTION_FAILED: 1,
  NON_DETERMINISTIC: 2,
  INVALID_INPUT: 3
});

const HOUR_MS = 3_600_000;
const COALESCE_WINDOW_MS = 10 * 60 * 1000;

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function round6(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function seedId(seed) {
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8);
}

function traceRow({ t, state, delivery }) {
  const row = {
    t,
    state_version: state.state_version,
    cycle: {
      phase: state.cycle.phase,
      cycle_day: state.cycle.cycle_day,
      phase_progress: state.cycle.phase_progress
    },
    sleep: {
      state: state.sleep.state,
      sleepiness: state.sleep.sleepiness,
      sleep_debt: state.sleep.sleep_debt
    },
    stress: { level: state.stress.level },
    mood: Object.fromEntries(MOOD_KEYS.map((key) => [key, state.mood[key]])),
    regulation: Object.fromEntries(REGULATION_KEYS.map((key) => [key, state.regulation[key]]))
  };
  if (delivery && typeof delivery.policy === 'string') {
    row.delivery = { policy: delivery.policy };
    const merged = delivery.coalesced_into?.merged_count;
    if (Number.isInteger(merged) && merged > 1) row.delivery.coalesced_merged = merged;
  }
  return row;
}

function accumulateRaw(target, contributions) {
  for (const [path, sources] of Object.entries(contributions ?? {})) {
    if (!sources || typeof sources !== 'object') continue;
    const bucket = (target[path] ??= {});
    for (const [name, value] of Object.entries(sources)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      bucket[name] = (bucket[name] ?? 0) + value;
    }
  }
}

function flattenContributions(stepRaw) {
  const sums = {};
  for (const [path, sources] of Object.entries(stepRaw)) {
    let sum = 0;
    for (const value of Object.values(sources)) {
      if (typeof value === 'number' && Number.isFinite(value)) sum += value;
    }
    sums[path] = sum;
  }
  return sums;
}

/**
 * 纯推进：只把事件 + 步长送进 `advance`，不实现队列消费/重试/交付判断。
 * `observedPending` 仅用于把本步已排队事件作为只读输入，以便观测
 * 11 的 `coalesced_into.merged_count`（SIM05），不跨步持久化。
 */
export async function simulateScenario(scenario) {
  const config = deepMerge(
    { timezone: scenario.timezone },
    scenario.config_overrides
  );
  config.timezone = scenario.timezone;

  let state = createDefaultState({
    character_id: scenario.character_id,
    timezone: scenario.timezone,
    now: scenario.start_at,
    master_seed_hex: scenario.master_seed_hex,
    config
  });

  const trace = [];
  const contributionSums = [];
  const keyCandidates = {};
  const behaviorSeries = [];
  const a2Samples = [];
  const errors = [];
  const deliveryStats = { policies: {}, coalesced_steps: 0, coalesced_merged_total: 0 };
  const stepMs = scenario.step_seconds * 1000;
  let eventIndex = 0;
  let eventsApplied = 0;
  let appended = 0;
  let incomplete = false;

  const moodSnapshot = () => Object.fromEntries(MOOD_KEYS.map((key) => [key, state.mood[key]]));
  const recordA2 = (t, before) => {
    for (const key of MOOD_KEYS) {
      const path = `mood.${key}`;
      a2Samples.push({ t, path, delta: Math.abs(round6(state.mood[key] - before[key])) });
    }
  };

  for (let cursor = scenario.start_ms; cursor < scenario.end_ms; cursor += stepMs) {
    const stepEnd = Math.min(cursor + stepMs, scenario.end_ms);
    const stepEvents = [];
    while (eventIndex < scenario.events.length && scenario.events[eventIndex].atMs < stepEnd) {
      if (scenario.events[eventIndex].atMs >= cursor) stepEvents.push(scenario.events[eventIndex]);
      eventIndex += 1;
    }

    const stepRaw = {};
    let lastEventDelivery = null;
    let observedPending = [];

    for (const item of stepEvents) {
      const nowMs = item.atMs;
      observedPending = observedPending.filter(
        (pending) => nowMs - parseTime(pending.queued_at, 'queued_at') <= COALESCE_WINDOW_MS
      );
      const rng = RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
      const beforeMood = moodSnapshot();
      try {
        const result = await advance({
          state,
          event: item.engine,
          now: item.at,
          rngProvider: rng,
          config,
          modules: MODULES,
          queue: observedPending
        });
        state = result.state;
        eventsApplied += 1;
        recordA2(item.at, beforeMood);
        accumulateRaw(stepRaw, result.diagnostics?.contributions);
        if (result.delivery) {
          lastEventDelivery = result.delivery;
          const policy = result.delivery.policy;
          deliveryStats.policies[policy] = (deliveryStats.policies[policy] ?? 0) + 1;
          const merged = result.delivery.coalesced_into?.merged_count;
          if (Number.isInteger(merged) && merged > 1) {
            deliveryStats.coalesced_steps += 1;
            deliveryStats.coalesced_merged_total += merged;
          }
          if (policy === 'queue_until_awake') {
            observedPending = [
              ...observedPending,
              {
                event_id: item.engine.event_id,
                conversation_id: item.engine.source.conversation_id,
                queued_at: item.at
              }
            ].slice(-8);
          }
        }
        if (result.behavior_context) {
          behaviorSeries.push(result.behavior_context.reply_likelihood ?? null);
        }
      } catch (cause) {
        errors.push({
          t: item.at,
          event_id: item.engine.event_id,
          code: cause?.code ?? 'MODULE_FAILED',
          message: cause?.message ?? String(cause)
        });
        incomplete = true;
        break;
      }
    }

    if (incomplete) break;

    const endRng = RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id });
    const beforeStepEndMood = moodSnapshot();
    try {
      const result = await advance({
        state,
        event: null,
        now: toIso(stepEnd),
        rngProvider: endRng,
        config,
        modules: MODULES
      });
      state = result.state;
      recordA2(toIso(stepEnd), beforeStepEndMood);
      accumulateRaw(stepRaw, result.diagnostics?.contributions);
      if (result.behavior_context) {
        behaviorSeries.push(result.behavior_context.reply_likelihood ?? null);
      }
    } catch (cause) {
      errors.push({
        t: toIso(stepEnd),
        event_id: null,
        code: cause?.code ?? 'MODULE_FAILED',
        message: cause?.message ?? String(cause)
      });
      incomplete = true;
      break;
    }

    const index = trace.length;
    const row = traceRow({ t: toIso(stepEnd), state, delivery: lastEventDelivery });
    trace.push(row);
    contributionSums.push(flattenContributions(stepRaw));
    if (index === 0) keyCandidates.first = { index, reason: 'first_step', raw: stepRaw };
    keyCandidates.last = { index, reason: 'last_step', raw: stepRaw };
    if (!keyCandidates.max_stress || row.stress.level > trace[keyCandidates.max_stress.index].stress.level) {
      keyCandidates.max_stress = { index, reason: 'max_stress', raw: stepRaw };
    }
    if (!keyCandidates.min_energy || row.mood.energy < trace[keyCandidates.min_energy.index].mood.energy) {
      keyCandidates.min_energy = { index, reason: 'min_mood_energy', raw: stepRaw };
    }
    if (!keyCandidates.max_energy || row.mood.energy > trace[keyCandidates.max_energy.index].mood.energy) {
      keyCandidates.max_energy = { index, reason: 'max_mood_energy', raw: stepRaw };
    }
    appended += 1;
    if (appended % 64 === 0) {
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
  }

  return {
    state,
    trace,
    contributionSums,
    keyCandidates,
    behaviorSeries,
    a2Samples,
    deliveryStats,
    errors,
    incomplete,
    eventsApplied,
    eventsTotal: scenario.events.length
  };
}

function buildContribFile(scenario, trace, keyCandidates) {
  const nodes = [];
  const seen = new Set();
  const order = ['first_step', 'last_step', 'max_stress', 'min_mood_energy', 'max_mood_energy'];
  for (const reason of order) {
    const candidate = Object.values(keyCandidates).find((item) => item.reason === reason);
    if (!candidate || seen.has(candidate.index)) continue;
    seen.add(candidate.index);
    nodes.push({
      t: trace[candidate.index].t,
      state_version: trace[candidate.index].state_version,
      reason,
      contributions: Object.fromEntries(
        Object.entries(candidate.raw).map(([path, sources]) => [
          path,
          Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, round6(value)]))
        ])
      )
    });
  }
  return {
    scenario_id: scenario.scenario_id,
    engine_version: ENGINE_VERSION,
    schema_version: SCHEMA_VERSION,
    key_nodes: nodes
  };
}

function buildReport({ scenario, sim, analysis, fingerprint }) {
  return {
    scenario_id: scenario.scenario_id,
    description: scenario.description,
    character_id: scenario.character_id,
    timezone: scenario.timezone,
    seed_id: seedId(scenario.master_seed_hex),
    engine_version: ENGINE_VERSION,
    schema_version: SCHEMA_VERSION,
    algorithm_version: RANDOM_ALGORITHM_VERSION,
    start_at: scenario.start_at,
    end_at: scenario.end_at,
    step_seconds: scenario.step_seconds,
    steps: sim.trace.length,
    events_total: sim.eventsTotal,
    events_applied: sim.eventsApplied,
    config_overrides: scenario.config_overrides,
    fingerprint,
    state_summary: stateSummary(sim.state),
    statistics: analysis.statistics,
    delivery: sim.deliveryStats,
    anomaly_counts: analysis.counts,
    anomalies: analysis.anomalies,
    assertions: analysis.assertions,
    assertions_failed: analysis.assertions_failed,
    incomplete: sim.incomplete,
    errors: sim.errors
  };
}

/** 运行一次（含分析、渲染、序列化），测试可直接调用。 */
export async function executeScenario(scenario) {
  const started = Date.now();
  const sim = await simulateScenario(scenario);
  const analysis = analyzeTrace({
    trace: sim.trace,
    events: scenario.events,
    assertions: scenario.assertions,
    contributions: sim.contributionSums,
    behaviorSeries: sim.behaviorSeries,
    a2Samples: sim.a2Samples
  });
  const fingerprint = stateFingerprint(sim.state);
  const report = buildReport({ scenario, sim, analysis, fingerprint });
  const contrib = buildContribFile(scenario, sim.trace, sim.keyCandidates);
  const html = renderHtml({ scenario, trace: sim.trace, report, analysis });
  const traceText = `${sim.trace.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const contribText = `${JSON.stringify(contrib, null, 2)}\n`;
  return {
    scenario,
    sim,
    analysis,
    report,
    contrib,
    html,
    traceText,
    reportText,
    contribText,
    htmlText: html,
    durationMs: Date.now() - started
  };
}

export function exitCodeFor({ parseError = false, deterministic = true, assertionsFailed = [] } = {}) {
  if (parseError) return EXIT_CODES.INVALID_INPUT;
  if (!deterministic) return EXIT_CODES.NON_DETERMINISTIC;
  if (Array.isArray(assertionsFailed) && assertionsFailed.length > 0) {
    return EXIT_CODES.ASSERTION_FAILED;
  }
  return EXIT_CODES.OK;
}

export function writeOutputs(outDir, scenarioId, result) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const files = {
    trace: resolve(dir, `${scenarioId}.trace.jsonl`),
    report: resolve(dir, `${scenarioId}.report.json`),
    html: resolve(dir, `${scenarioId}.html`),
    contrib: resolve(dir, `${scenarioId}.contrib.json`)
  };
  writeFileSync(files.trace, result.traceText, 'utf8');
  writeFileSync(files.report, result.reportText, 'utf8');
  writeFileSync(files.html, result.htmlText, 'utf8');
  writeFileSync(files.contrib, result.contribText, 'utf8');
  return files;
}

function parseArgs(argv) {
  const args = { file: null, outDir: 'out', verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      args.outDir = argv[i + 1];
      i += 1;
    } else if (arg === '--no-verify') {
      args.verify = false;
    } else if (!arg.startsWith('-')) {
      args.file = arg;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.file) {
    process.stderr.write('usage: node tools/sim/run.mjs <scenario.json> [--out <dir>] [--no-verify]\n');
    return EXIT_CODES.INVALID_INPUT;
  }

  let scenario;
  try {
    scenario = loadScenarioFile(args.file);
  } catch (cause) {
    const code = cause instanceof SimError ? cause.code : 'INVALID_REQUEST';
    process.stderr.write(`[${code}] ${cause.message}\n`);
    return EXIT_CODES.INVALID_INPUT;
  }

  let first;
  try {
    first = await executeScenario(scenario);
  } catch (cause) {
    process.stderr.write(`[${cause?.code ?? 'MODULE_FAILED'}] ${cause?.message ?? String(cause)}\n`);
    return EXIT_CODES.INVALID_INPUT;
  }

  let deterministic = true;
  if (args.verify) {
    const second = await executeScenario(scenario);
    deterministic =
      first.traceText === second.traceText &&
      first.reportText === second.reportText &&
      first.htmlText === second.htmlText &&
      first.contribText === second.contribText;
    if (!deterministic) {
      first.analysis.anomalies.push({
        code: 'A9',
        severity: 'error',
        message: '同脚本两次运行的输出不一致',
        t: null
      });
      first.report.anomalies = first.analysis.anomalies;
      first.report.anomaly_counts.A9 = 1;
      first.reportText = `${JSON.stringify(first.report, null, 2)}\n`;
    }
  }

  const files = writeOutputs(args.outDir, scenario.scenario_id, first);
  process.stdout.write(
    `scenario=${scenario.scenario_id} steps=${first.report.steps} events=${first.report.events_applied}/${first.report.events_total} ` +
      `fingerprint=${first.report.fingerprint} anomalies=${first.analysis.anomalies.length} ` +
      `assertions_failed=${first.report.assertions_failed.length} deterministic=${deterministic} ` +
      `duration_ms=${first.durationMs}\n`
  );
  process.stdout.write(`trace=${files.trace}\nreport=${files.report}\nhtml=${files.html}\ncontrib=${files.contrib}\n`);

  if (!deterministic) return EXIT_CODES.NON_DETERMINISTIC;
  if (first.report.assertions_failed.length > 0 || hasFatalAnomaly(first.analysis)) {
    return EXIT_CODES.ASSERTION_FAILED;
  }
  return EXIT_CODES.OK;
}

const isCli = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause) => {
      process.stderr.write(`[${cause?.code ?? 'MODULE_FAILED'}] ${cause?.message ?? String(cause)}\n`);
      process.exitCode = EXIT_CODES.INVALID_INPUT;
    });
}
