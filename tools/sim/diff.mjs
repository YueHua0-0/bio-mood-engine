/**
 * 16 §4.4：两条 trace 的差异定位。
 *
 *   node tools/sim/diff.mjs out/a.trace.jsonl out/b.trace.jsonl
 *
 * 输出首个差异时刻与字段、最大/平均数值差、差异持续时长，以及
 * 两份报告中的 `config_overrides` 键差异（判断差异是否仅由配置引起）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NUMERIC_EPS = 1e-9;

function flatten(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out.set(path, child);
    }
  }
  return out;
}

function readTrace(filePath) {
  const text = readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new Error(`${filePath}:${index + 1} is not valid JSON: ${cause.message}`);
      }
    });
}

function readConfig(filePath) {
  const reportPath = filePath.replace(/\.trace\.jsonl$/, '.report.json');
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, 'utf8'));
    return raw?.config_overrides ?? {};
  } catch {
    return null;
  }
}

function configDiffKeys(a, b, prefix = '', out = []) {
  if (a === b) return out;
  const aObj = a && typeof a === 'object' && !Array.isArray(a);
  const bObj = b && typeof b === 'object' && !Array.isArray(b);
  if (aObj && bObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      configDiffKeys(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function isSame(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= NUMERIC_EPS;
  return a === b;
}

/**
 * 纯函数 diff，便于测试。
 *
 * @param {Array<object>} left
 * @param {Array<object>} right
 * @param {{configA?:object|null, configB?:object|null}} [options]
 */
export function diffTraces(left, right, { configA = null, configB = null } = {}) {
  const limit = Math.max(left.length, right.length);
  let first = null;
  let lastDiffMs = null;
  let divergedSteps = 0;
  let maxAbs = 0;
  let sumAbs = 0;
  let numericPairs = 0;
  const fieldCounts = {};

  for (let index = 0; index < limit; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      const t = a?.t ?? b?.t ?? null;
      first ??= { index, t, field: '<row>', a: a ? 'present' : 'missing', b: b ? 'present' : 'missing' };
      divergedSteps += 1;
      fieldCounts['<row>'] = (fieldCounts['<row>'] ?? 0) + 1;
      lastDiffMs = t ? Date.parse(t) : lastDiffMs;
      continue;
    }
    const flatA = flatten(a);
    const flatB = flatten(b);
    const fields = new Set([...flatA.keys(), ...flatB.keys()]);
    let rowDiff = false;
    for (const field of fields) {
      const va = flatA.get(field);
      const vb = flatB.get(field);
      if (isSame(va, vb)) continue;
      rowDiff = true;
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
      if (typeof va === 'number' && typeof vb === 'number') {
        const abs = Math.abs(va - vb);
        maxAbs = Math.max(maxAbs, abs);
        sumAbs += abs;
        numericPairs += 1;
      }
      if (!first) {
        first = { index, t: a.t ?? b.t ?? null, field, a: va ?? null, b: vb ?? null };
      }
      lastDiffMs = Date.parse(a.t ?? b.t ?? '') || lastDiffMs;
    }
    if (rowDiff) divergedSteps += 1;
  }

  const configAObj = configA ?? {};
  const configBObj = configB ?? {};
  const configKeys = configDiffKeys(configAObj, configBObj);
  const durationHours =
    first && lastDiffMs !== null && Number.isFinite(lastDiffMs)
      ? Math.max(0, (lastDiffMs - Date.parse(first.t)) / 3_600_000)
      : 0;

  return {
    identical: first === null,
    first_divergence: first,
    diverged_steps: divergedSteps,
    divergent_fields: fieldCounts,
    max_abs_diff: Number(maxAbs.toFixed(6)),
    mean_abs_diff: numericPairs === 0 ? 0 : Number((sumAbs / numericPairs).toFixed(6)),
    numeric_pairs: numericPairs,
    duration_hours: Number(durationHours.toFixed(3)),
    config_diff_keys: configKeys,
    config_only: configKeys.length > 0
  };
}

export function diffFiles(leftPath, rightPath) {
  return diffTraces(readTrace(leftPath), readTrace(rightPath), {
    configA: readConfig(leftPath),
    configB: readConfig(rightPath)
  });
}

function printResult(result, leftPath, rightPath) {
  const lines = [`left=${leftPath}`, `right=${rightPath}`];
  if (result.identical) {
    lines.push('无差异（0 个字段不同）');
  } else {
    const first = result.first_divergence;
    lines.push(
      `首个差异：t=${first.t} step=${first.index} field=${first.field} left=${JSON.stringify(
        first.a
      )} right=${JSON.stringify(first.b)}`
    );
    lines.push(`差异步数=${result.diverged_steps} 最大数值差=${result.max_abs_diff} 平均数值差=${result.mean_abs_diff}`);
    lines.push(`差值持续时长=${result.duration_hours}h`);
    lines.push(
      `仅由 config_overrides 引起=${result.config_only ? '是' : '否'}` +
        (result.config_diff_keys.length > 0
          ? `（差异配置：${result.config_diff_keys.join(', ')}）`
          : '')
    );
    const fields = Object.entries(result.divergent_fields)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([field, count]) => `${field}×${count}`)
      .join(', ');
    lines.push(`差异字段 Top：${fields}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const paths = argv.filter((arg) => !arg.startsWith('-'));
  if (paths.length !== 2) {
    process.stderr.write('usage: node tools/sim/diff.mjs <left.trace.jsonl> <right.trace.jsonl>\n');
    return 3;
  }
  let result;
  try {
    result = diffFiles(paths[0], paths[1]);
  } catch (cause) {
    process.stderr.write(`[INVALID_REQUEST] ${cause.message}\n`);
    return 3;
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printResult(result, paths[0], paths[1]);
  }
  return result.identical ? 0 : 1;
}

const isCli = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  process.exitCode = main();
}
