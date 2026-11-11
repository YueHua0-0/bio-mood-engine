/**
 * 16 §3.2：单文件 HTML 可视化（内联 CSS + 内联 SVG，无外链、无脚本）。
 * 6 张图：周期、睡眠、压力、情绪、调节、交付策略；异常时段用红色竖带高亮。
 */

import { localParts } from '../../lib/core/clock.mjs';

const WIDTH = 960;
const HEIGHT = 240;
const MARGIN = { left: 58, right: 18, top: 34, bottom: 30 };

const PALETTES = {
  cycle: ['#f59e0b', '#8b5cf6'],
  sleep: ['#2563eb', '#0ea5e9'],
  stress: ['#dc2626'],
  mood: [
    '#2563eb',
    '#0ea5e9',
    '#10b981',
    '#eab308',
    '#f97316',
    '#ef4444',
    '#8b5cf6'
  ],
  regulation: ['#2563eb', '#0ea5e9', '#10b981', '#eab308', '#f97316', '#8b5cf6']
};

const POLICY_ORDER = ['deliver_now', 'queue_until_awake', 'silent_ignore', 'urgent_interrupt'];
const POLICY_COLORS = {
  deliver_now: '#10b981',
  queue_until_awake: '#2563eb',
  silent_ignore: '#94a3b8',
  urgent_interrupt: '#dc2626'
};
const POLICY_LABELS = {
  deliver_now: '立即交付',
  queue_until_awake: '醒来后排队',
  silent_ignore: '静默',
  urgent_interrupt: '紧急打断'
};

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(value) {
  return Number(value).toFixed(2);
}

function xAt(index, count) {
  const plot = WIDTH - MARGIN.left - MARGIN.right;
  if (count <= 1) return MARGIN.left + plot / 2;
  return MARGIN.left + (index / (count - 1)) * plot;
}

function yAt(value, yMin, yMax) {
  const plot = HEIGHT - MARGIN.top - MARGIN.bottom;
  const ratio = (value - yMin) / (yMax - yMin || 1);
  return MARGIN.top + (1 - Math.min(1, Math.max(0, ratio))) * plot;
}

function labelAt(iso, timeZone) {
  try {
    const parts = localParts(iso, timeZone);
    return `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:00`;
  } catch {
    return iso;
  }
}

function anomalyBands(indexes, total) {
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const unique = [...new Set(indexes)].filter((index) => index >= 0 && index < total).slice(0, 60);
  return unique
    .map(
      (index) =>
        `<rect x="${(xAt(index, total) - 1.5).toFixed(1)}" y="${MARGIN.top}" width="3" height="${plotH}" fill="#ef4444" opacity="0.16" />`
    )
    .join('');
}

function lineChart({ title, subtitle, series, times, timeZone, anomalyIndexes, yMin = 0, yMax = 1 }) {
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const count = times.length;
  const grids = [];
  for (let k = 0; k <= 4; k += 1) {
    const value = yMin + ((yMax - yMin) * k) / 4;
    const y = yAt(value, yMin, yMax);
    grids.push(
      `<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + plotW}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />`,
      `<text x="${MARGIN.left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${fmt(value)}</text>`
    );
  }
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1]
    .map((ratio) => Math.min(count - 1, Math.round(ratio * (count - 1))))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const xLabels = ticks
    .map((index) => {
      const x = xAt(index, count);
      const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="${HEIGHT - 8}" text-anchor="${anchor}" font-size="10" fill="#64748b">${esc(
        labelAt(times[index], timeZone)
      )}</text>`;
    })
    .join('');

  const lines = series
    .map((item, seriesIndex) => {
      const color = item.color ?? PALETTES.mood[seriesIndex % PALETTES.mood.length];
      const points = item.values
        .map((value, index) =>
          typeof value === 'number' && Number.isFinite(value)
            ? `${xAt(index, count).toFixed(2)},${yAt(value, yMin, yMax).toFixed(2)}`
            : null
        )
        .filter(Boolean)
        .join(' ');
      return `<polyline fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" points="${points}" />`;
    })
    .join('');

  const legend = series
    .map((item, index) => {
      const color = item.color ?? PALETTES.mood[index % PALETTES.mood.length];
      return `<span class="legend-item"><i style="background:${color}"></i>${esc(item.name)}</span>`;
    })
    .join('');

  return `<figure class="chart">
  <figcaption><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></figcaption>
  <div class="legend">${legend}</div>
  <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(title)}">
    ${grids.join('')}
    ${anomalyBands(anomalyIndexes.indexes, count)}
    ${lines}
    ${xLabels}
  </svg>
</figure>`;
}

function deliveryChart({ trace, anomalyIndexes, timeZone }) {
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const count = trace.length;
  const counts = Object.fromEntries(POLICY_ORDER.map((policy) => [policy, 0]));
  let drawn = 0;
  const bars = [];
  for (let index = 0; index < trace.length; index += 1) {
    const policy = trace[index].delivery?.policy;
    if (!policy) continue;
    counts[policy] = (counts[policy] ?? 0) + 1;
    drawn += 1;
    const slot = POL_POS[policy];
    if (slot === undefined) continue;
    const x = xAt(index, count);
    const y = MARGIN.top + (slot / (POLICY_ORDER.length - 1)) * (plotH - 18) + 9;
    bars.push(
      `<rect x="${(x - 1).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="2.4" height="14" fill="${POLICY_COLORS[policy]}" opacity="0.8" />`
    );
  }
  const rows = POLICY_ORDER.map((policy, index) => {
    const y = MARGIN.top + (index / (POLICY_ORDER.length - 1)) * (plotH - 18) + 9;
    return (
      `<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + plotW}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />` +
      `<text x="${MARGIN.left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${esc(
        POLICY_LABELS[policy]
      )}</text>`
    );
  }).join('');
  const legend = POLICY_ORDER.map(
    (policy) =>
      `<span class="legend-item"><i style="background:${POLICY_COLORS[policy]}"></i>${esc(
        POLICY_LABELS[policy]
      )} <b>${counts[policy]}</b></span>`
  ).join('');
  const empty = drawn === 0
    ? `<text x="${MARGIN.left + plotW / 2}" y="${MARGIN.top + plotH / 2}" text-anchor="middle" font-size="13" fill="#94a3b8">该场景没有事件驱动交付</text>`
    : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => Math.min(count - 1, Math.round(ratio * (count - 1))))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const xLabels = ticks
    .map((index) => {
      const x = xAt(index, count);
      const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="${HEIGHT - 8}" text-anchor="${anchor}" font-size="10" fill="#64748b">${esc(
        labelAt(trace[index].t, timeZone)
      )}</text>`;
    })
    .join('');

  return `<figure class="chart">
  <figcaption><strong>交付策略</strong><span>11 只读消费；合并次数见报告 delivery</span></figcaption>
  <div class="legend">${legend}</div>
  <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="交付策略">
    ${rows}
    ${anomalyBands(anomalyIndexes.indexes, count)}
    ${bars.join('')}
    ${empty}
    ${xLabels}
  </svg>
</figure>`;
}

const POL_POS = Object.fromEntries(POLICY_ORDER.map((policy, index) => [policy, index]));

function rangeOf(trace, path) {
  let min = 0;
  let max = 1;
  for (const row of trace) {
    const value = path.split('.').reduce((cursor, part) => (cursor ? cursor[part] : undefined), row);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const pad = Math.max(0.04, (max - min) * 0.12);
  return [Math.max(-0.05, min - pad), Math.min(1.05, max + pad)];
}

function seriesOf(trace, keys, base) {
  return keys.map((key) => ({
    name: base ? `${base}.${key}` : key,
    values: trace.map((row) => (base ? row[base][key] : row[key]))
  }));
}

function summaryRows(report) {
  const rows = [
    ['场景', report.scenario_id],
    ['角色 / 时区', `${report.character_id} / ${report.timezone}`],
    ['窗口', `${report.start_at} → ${report.end_at}`],
    ['步数 / 事件', `${report.steps} / ${report.events_applied}`],
    ['stateFingerprint', report.fingerprint],
    ['异常', `${report.anomalies.length} 条`],
    ['断言失败', report.assertions_failed.length ? report.assertions_failed.join(', ') : '无']
  ];
  return rows
    .map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value)}</td></tr>`)
    .join('');
}

function anomalyList(anomalies) {
  if (anomalies.length === 0) return '<p class="empty">A1–A10 均未触发。</p>';
  const items = anomalies
    .slice(0, 80)
    .map(
      (item) =>
        `<li><code>${esc(item.code)}</code><span class="sev ${esc(item.severity)}">${esc(
          item.severity
        )}</span>${esc(item.message)}${item.t ? ` <em>${esc(item.t)}</em>` : ''}</li>`
    )
    .join('');
  return `<ul class="anomalies">${items}</ul>`;
}

function assertionList(assertions) {
  return assertions
    .map(
      (item) =>
        `<li class="${item.ok ? 'ok' : 'fail'}"><span>${item.ok ? 'PASS' : 'FAIL'}</span> ${esc(
          item.name
        )} <code>${esc(JSON.stringify(item.detail))}</code></li>`
    )
    .join('');
}

export function renderHtml({ scenario, trace, report, analysis }) {
  const anomalyIndex = new Map();
  for (const anomaly of analysis.anomalies) {
    if (!anomaly.t) continue;
    const index = trace.findIndex((row) => row.t === anomaly.t);
    if (index >= 0) anomalyIndex.set(index, true);
  }
  const anomalyIndexes = { indexes: [...anomalyIndex.keys()] };

  const moodKeys = Object.keys(trace[0]?.mood ?? {});
  const regulationKeys = Object.keys(trace[0]?.regulation ?? {});

  const [cycleMin, cycleMax] = rangeOf(trace, 'cycle.phase_progress');
  const [sleepMin, sleepMax] = rangeOf(trace, 'sleep.sleepiness');
  const [stressMin, stressMax] = rangeOf(trace, 'stress.level');

  const charts = [
    lineChart({
      title: '周期',
      subtitle: 'phase_progress 与 cycle_day/28 归一化',
      series: [
        { name: 'phase_progress', values: trace.map((row) => row.cycle.phase_progress), color: PALETTES.cycle[0] },
        {
          name: 'cycle_day/28',
          values: trace.map((row) => row.cycle.cycle_day / 28),
          color: PALETTES.cycle[1]
        }
      ],
      times: trace.map((row) => row.t),
      timeZone: scenario.timezone,
      anomalyIndexes,
      yMin: cycleMin,
      yMax: cycleMax
    }),
    lineChart({
      title: '睡眠',
      subtitle: 'sleepiness 与 sleep_debt',
      series: [
        { name: 'sleepiness', values: trace.map((row) => row.sleep.sleepiness), color: PALETTES.sleep[0] },
        { name: 'sleep_debt', values: trace.map((row) => row.sleep.sleep_debt), color: PALETTES.sleep[1] }
      ],
      times: trace.map((row) => row.t),
      timeZone: scenario.timezone,
      anomalyIndexes,
      yMin: sleepMin,
      yMax: sleepMax
    }),
    lineChart({
      title: '压力',
      subtitle: 'stress.level',
      series: [{ name: 'stress.level', values: trace.map((row) => row.stress.level), color: PALETTES.stress[0] }],
      times: trace.map((row) => row.t),
      timeZone: scenario.timezone,
      anomalyIndexes,
      yMin: stressMin,
      yMax: stressMax
    }),
    lineChart({
      title: '情绪',
      subtitle: '7 个 mood 维度',
      series: seriesOf(trace, moodKeys, 'mood').map((item, index) => ({
        ...item,
        color: PALETTES.mood[index % PALETTES.mood.length]
      })),
      times: trace.map((row) => row.t),
      timeZone: scenario.timezone,
      anomalyIndexes
    }),
    lineChart({
      title: '调节',
      subtitle: '6 个 regulation 维度',
      series: seriesOf(trace, regulationKeys, 'regulation').map((item, index) => ({
        ...item,
        color: PALETTES.regulation[index % PALETTES.regulation.length]
      })),
      times: trace.map((row) => row.t),
      timeZone: scenario.timezone,
      anomalyIndexes
    }),
    deliveryChart({ trace, anomalyIndexes, timeZone: scenario.timezone })
  ];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>仿真回放 ${esc(scenario.scenario_id)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 56px; background: #f8fafc; color: #0f172a; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 1020px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #475569; margin: 0 0 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
  .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 18px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; width: 160px; color: #475569; font-weight: 600; padding: 5px 0; vertical-align: top; }
  td { padding: 5px 0; word-break: break-all; }
  .chart { margin: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px 8px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  figcaption { display: flex; align-items: baseline; gap: 10px; font-size: 14px; }
  figcaption span { color: #64748b; font-size: 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 4px; font-size: 11px; color: #334155; }
  .legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .legend-item i { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
  .legend-item b { font-weight: 600; color: #0f172a; }
  svg { width: 100%; height: auto; display: block; }
  h2 { font-size: 16px; margin: 26px 0 10px; }
  .anomalies { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
  .anomalies code { background: #f1f5f9; border-radius: 4px; padding: 0 4px; margin-right: 6px; }
  .anomalies em { color: #94a3b8; font-style: normal; font-size: 11px; }
  .sev { display: inline-block; min-width: 42px; margin-right: 6px; font-size: 10px; text-transform: uppercase; color: #64748b; }
  .sev.error { color: #b91c1c; }
  .sev.high { color: #c2410c; }
  ul.assertions { margin: 0; padding-left: 0; list-style: none; font-size: 12px; line-height: 1.9; }
  ul.assertions span { display: inline-block; width: 46px; font-weight: 700; }
  ul.assertions .ok span { color: #047857; }
  ul.assertions .fail span { color: #b91c1c; }
  ul.assertions code { color: #475569; }
  .empty { color: #64748b; font-size: 13px; margin: 0; }
  footer { margin-top: 26px; color: #94a3b8; font-size: 11px; }
</style>
</head>
<body>
<main>
  <h1>仿真回放：${esc(scenario.scenario_id)}</h1>
  <p class="sub">${esc(scenario.description || '16 仿真回放与可视化')}</p>
  <section class="panel"><table>${summaryRows(report)}</table></section>
  <h2>曲线</h2>
  <div class="grid">${charts.join('\n')}</div>
  <h2>异常</h2>
  <section class="panel">${anomalyList(analysis.anomalies)}</section>
  <h2>断言</h2>
  <section class="panel"><ul class="assertions">${assertionList(analysis.assertions)}</ul></section>
  <footer>engine ${esc(report.engine_version)} · schema ${esc(report.schema_version)} · 本文件不包含任何外部资源或脚本</footer>
</main>
</body>
</html>
`;
}
