/**
 * 角色状态页 · 只读。
 *
 * 数据只经宿主 SDK 的 `wa.actions.call('read-state')` 获取；不写盘、不推进状态。
 * 主题：宿主注入的 `--wa-*` 优先，缺失时使用罗德岛深色工业底板。
 */

import wa from './__sdk.mjs';

const REFRESH_MS = 30000;

const PHASE_LABELS = {
  menstrual_like: '月经期',
  follicular_like: '卵泡期',
  ovulatory_like: '排卵期',
  luteal_like: '黄体期'
};

const SLEEP_LABELS = {
  awake: '清醒',
  sleepy: '困倦',
  trying_to_sleep: '准备入睡',
  sleeping: '睡眠中',
  interrupted: '睡眠中断',
  waking_up: '正在醒来'
};

const MOOD_ROWS = [
  ['energy', '精力'],
  ['stability', '情绪稳定'],
  ['sensitivity', '敏感度'],
  ['social_drive', '社交驱动'],
  ['stress', '压力'],
  ['physical_comfort', '身体舒适'],
  ['closeness_need', '亲密需求']
];

const REGULATION_ROWS = [
  ['reward_sensitivity', '奖赏敏感'],
  ['arousal', '唤醒度'],
  ['threat_sensitivity', '威胁敏感'],
  ['calm_regulation', '平静调节'],
  ['social_reassurance_drive', '社交安抚驱动'],
  ['fatigue_load', '疲劳负荷']
];

const VERBOSITY_LABELS = { low: '简短', normal: '适中', high: '详细' };
const AFFECTION_LABELS = { reserved: '克制', normal: '自然', warm: '温暖' };

const FIELD_IDS = [
  'm-cycle-day', 'm-sleep-debt', 'm-stress', 'm-energy',
  'cycle-phase', 'cycle-day', 'cycle-progress-text', 'cycle-confidence',
  'sleep-state', 'sleep-wake', 'sleep-debt-text', 'sleepiness-text',
  'stress-level', 'stress-events', 'stress-note'
];

const pageState = {
  key: '',
  timer: 0,
  loading: false
};

const byId = (id) => document.getElementById(id);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = value;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fmt(value, digits = 3) {
  return isNumber(value) ? value.toFixed(digits) : '—';
}

function pct(value) {
  return isNumber(value) ? `${Math.round(clamp01(value) * 100)}%` : '—';
}

function labelOf(map, key) {
  if (key === undefined || key === null || key === '') return '—';
  return map[key] ?? String(key);
}

/**
 * 时钟文本。时间一律按角色声明的时区（`summary.timezone`）呈现：浏览器本地时区
 * 与服务端时区不一致时，直接 `toLocaleString` 会整体偏移若干小时。
 * `hourCycle: 'h23'` 用于防止部分引擎在 `hour12:false` 下把零点输出成 24 点（02 §4.2）。
 */
function timeText(value, { withDate = false, withSeconds = true, timeZone = '' } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withDate) {
    options.month = '2-digit';
    options.day = '2-digit';
  }
  if (withSeconds) options.second = '2-digit';
  if (timeZone) options.timeZone = timeZone;
  try {
    return date.toLocaleString('zh-CN', options);
  } catch {
    // 时区名非法时退回查看者本地时区，避免整页因格式化抛错而空白。
    delete options.timeZone;
    return date.toLocaleString('zh-CN', options);
  }
}

function setLink(text, tone = '') {
  const tag = byId('link-state');
  setText('link-text', text);
  if (!tag) return;
  tag.classList.remove('ok', 'warn', 'danger', 'info');
  if (tone) tag.classList.add(tone);
}

function setTag(id, text, tone = '') {
  const tag = byId(id);
  if (!tag) return;
  tag.textContent = text;
  tag.classList.remove('ok', 'warn', 'danger', 'info');
  if (tone) tag.classList.add(tone);
}

function showNotice(message, tone = 'warn') {
  const notice = byId('notice');
  if (!notice) return;
  notice.hidden = false;
  notice.textContent = message;
  notice.dataset.tone = tone;
}

function hideNotice() {
  const notice = byId('notice');
  if (!notice) return;
  notice.hidden = true;
  notice.textContent = '';
}

function applyBar(id, value, tone = '') {
  const node = byId(id);
  if (!node) return;
  if (isNumber(value)) {
    node.style.width = `${Math.round(clamp01(value) * 100)}%`;
    node.classList.remove('is-empty');
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  } else {
    node.style.width = '0%';
    node.classList.add('is-empty');
  }
}

function toneForValue(key, value) {
  if (!isNumber(value)) return '';
  if (key === 'stress' || key === 'fatigue_load' || key === 'threat_sensitivity') {
    if (value >= 0.75) return 'danger';
    if (value >= 0.5) return 'warn';
  }
  if (key === 'energy' || key === 'stability' || key === 'physical_comfort') {
    if (value <= 0.25) return 'danger';
    if (value <= 0.4) return 'warn';
  }
  if (key === 'sleep_debt' || key === 'sleepiness') {
    if (value >= 0.7) return 'warn';
  }
  return '';
}

function makeRow(label, value, options = {}) {
  const row = document.createElement('div');
  row.className = 'row';

  const name = document.createElement('span');
  name.className = 'row-label';
  name.textContent = label;

  const track = document.createElement('span');
  track.className = 'row-bar';
  const fill = document.createElement('i');

  const numeric = isNumber(value);
  if (numeric) {
    fill.style.width = `${Math.round(clamp01(value) * 100)}%`;
    const tone = options.tone ?? toneForValue(options.key, value);
    if (tone) fill.dataset.tone = tone;
  } else {
    track.classList.add('is-text');
    fill.classList.add('is-empty');
  }
  track.append(fill);

  const out = document.createElement('b');
  out.className = 'row-value';
  if (numeric) {
    out.textContent = value.toFixed(3);
  } else {
    out.classList.add('is-text');
    out.textContent = options.text ?? '—';
  }

  row.append(name, track, out);
  return row;
}

function renderRows(id, rows) {
  const box = byId(id);
  if (box) box.replaceChildren(...rows);
}

function clearFields() {
  for (const id of FIELD_IDS) setText(id, '—');
  for (const id of ['cycle-progress', 'sleep-debt-bar', 'sleepiness-bar', 'stress-bar']) applyBar(id, null);
  for (const id of ['cycle-tag', 'sleep-tag', 'stress-tag', 'mood-tag']) setTag(id, '—');
  renderRows('mood-rows', []);
  renderRows('behavior-rows', []);
  renderRows('regulation-rows', []);
  renderPageTags(null);
}

function renderPageTags(summary) {
  const box = byId('page-tags');
  if (!box) return;
  const tags = [];
  const timezone = summary?.timezone;
  if (timezone) tags.push(`TZ ${timezone}`);
  const seed = summary?.random?.master_seed_id;
  if (seed) tags.push(`SEED ${seed}`);

  box.replaceChildren(...tags.map((text) => {
    const tag = document.createElement('span');
    tag.className = 'status-tag';
    tag.textContent = text;
    return tag;
  }));
}

function confidenceTag(confidence) {
  if (!isNumber(confidence)) return ['—', ''];
  if (confidence >= 0.7) return ['高置信', 'ok'];
  if (confidence >= 0.4) return ['中置信', 'info'];
  return ['低置信', 'warn'];
}

function sleepTagOf(stateValue) {
  if (stateValue === 'sleeping' || stateValue === 'trying_to_sleep') return ['休息中', 'info'];
  if (stateValue === 'interrupted') return ['睡眠中断', 'warn'];
  if (stateValue === 'sleepy') return ['困倦', 'warn'];
  if (stateValue === 'waking_up') return ['正在醒来', 'info'];
  if (stateValue === 'awake') return ['清醒', 'ok'];
  return ['—', ''];
}

function stressTagOf(level) {
  if (!isNumber(level)) return ['—', ''];
  if (level >= 0.75) return ['高危', 'danger'];
  if (level >= 0.5) return ['偏高', 'warn'];
  if (level >= 0.3) return ['轻度', 'info'];
  return ['平稳', 'ok'];
}

function stressNoteOf(level) {
  if (!isNumber(level)) return '—';
  if (level >= 0.75) return '压力处于高位，建议优先降低刺激与负荷，避免继续叠加事件。';
  if (level >= 0.5) return '压力偏高，回复与互动可能更保守，适合先做低强度交流。';
  if (level >= 0.3) return '存在轻度压力，行为倾向会略微收敛。';
  return '压力平稳，当前没有明显的应激负荷。';
}

function moodTagOf(stability) {
  if (!isNumber(stability)) return ['—', ''];
  if (stability >= 0.65) return ['稳定', 'ok'];
  if (stability >= 0.4) return ['一般', 'info'];
  return ['波动', 'warn'];
}

function renderSummary(result) {
  const summary = result.state_summary ?? {};
  const cycle = summary.cycle ?? {};
  const sleep = summary.sleep ?? {};
  const stress = summary.stress ?? {};
  const mood = summary.mood ?? {};
  const regulation = summary.regulation ?? {};
  const behavior = result.behavior_context ?? {};

  const character = result.character_id ?? summary.character_id ?? '—';
  const timeZone = summary.timezone ?? '';
  // 带日期：状态可能数天未推进，只显示时分秒会让人误读成"当前时间"。
  const updated = timeText(summary.updated_at, { withDate: true, timeZone });
  setText('identity', `虚构角色 ${character} · 状态版本 v${result.state_version ?? '—'} · 更新于 ${updated}`);
  renderPageTags(summary);

  setText('m-cycle-day', fmt(cycle.cycle_day, 1));
  setText('m-cycle-note', `阶段 ${labelOf(PHASE_LABELS, cycle.phase)}`);
  setText('m-sleep-debt', fmt(sleep.sleep_debt, 3));
  setText('m-sleep-note', `睡眠状态 ${labelOf(SLEEP_LABELS, sleep.state)}`);
  setText('m-stress', fmt(stress.level, 3));
  setText('m-stress-note', `活跃事件 ${isNumber(stress.active_event_count) ? stress.active_event_count : '—'} 项`);
  setText('m-energy', fmt(mood.energy, 3));
  setText('m-energy-note', `情绪稳定 ${fmt(mood.stability, 3)}`);

  setText('cycle-phase', labelOf(PHASE_LABELS, cycle.phase));
  setText('cycle-day', fmt(cycle.cycle_day, 1));
  setText('cycle-progress-text', pct(cycle.phase_progress));
  setText('cycle-confidence', fmt(cycle.confidence, 2));
  applyBar('cycle-progress', cycle.phase_progress);
  setTag('cycle-tag', ...confidenceTag(cycle.confidence));

  setText('sleep-state', labelOf(SLEEP_LABELS, sleep.state));
  setText('sleep-wake', timeText(sleep.planned_wake_at, { withDate: true, withSeconds: false, timeZone }));
  applyBar('sleep-debt-bar', sleep.sleep_debt, toneForValue('sleep_debt', sleep.sleep_debt));
  setText('sleep-debt-text', fmt(sleep.sleep_debt, 2));
  applyBar('sleepiness-bar', sleep.sleepiness, toneForValue('sleepiness', sleep.sleepiness));
  setText('sleepiness-text', fmt(sleep.sleepiness, 2));
  setTag('sleep-tag', ...sleepTagOf(sleep.state));

  setText('stress-level', fmt(stress.level, 3));
  setText('stress-events', isNumber(stress.active_event_count) ? String(stress.active_event_count) : '—');
  applyBar('stress-bar', stress.level, toneForValue('stress', stress.level));
  setTag('stress-tag', ...stressTagOf(stress.level));
  setText('stress-note', stressNoteOf(stress.level));

  renderRows('mood-rows', MOOD_ROWS.map(([key, text]) => makeRow(text, mood[key], { key })));
  setTag('mood-tag', ...moodTagOf(mood.stability));

  renderRows('behavior-rows', [
    makeRow('回复意愿', behavior.reply_likelihood, { key: 'reply_likelihood' }),
    makeRow('主动社交', behavior.social_initiative, { key: 'social_initiative' }),
    makeRow('安抚需求', behavior.need_for_reassurance, { key: 'need_for_reassurance' }),
    makeRow('回避倾向', behavior.avoidance_tendency, { key: 'avoidance_tendency' }),
    makeRow('表达密度', undefined, { text: labelOf(VERBOSITY_LABELS, behavior.verbosity_bias) }),
    makeRow('情感表达', undefined, { text: labelOf(AFFECTION_LABELS, behavior.affection_expression) })
  ]);

  renderRows('regulation-rows', REGULATION_ROWS.map(([key, text]) => makeRow(text, regulation[key], { key })));
}

function renderEmpty(result) {
  clearFields();
  const character = result?.character_id ?? '—';
  setText('identity', `虚构角色 ${character} · 状态版本 v0 · 尚无状态`);
  showNotice('还没有状态。先在主会话里让模型调用一次 observe，再回到本页刷新。', 'info');
  setLink('无数据', 'warn');
}

function explainFailure(result, error) {
  if (!result) return `读取失败：${error?.message ?? '未知错误'}`;
  const reason = result.details?.reason;
  if (result.code === 'DEGRADED' && reason === 'readonly_scope') {
    return '当前不是主会话，或主会话未绑定：只读快照不可用。请切换到主会话后刷新。';
  }
  if (result.code === 'DEGRADED' && reason === 'disabled') {
    return '插件已在设置中停用，状态读取被拒绝。';
  }
  if (result.code === 'DEGRADED' && reason === 'remote_not_implemented') {
    return '当前为远程引擎模式，本页仅支持内置引擎。';
  }
  if (result.code === 'DEGRADED') {
    const warnings = Array.isArray(result.details?.warnings) ? result.details.warnings.join(' / ') : '';
    return `引擎降级：${warnings || '未知原因'}`;
  }
  return `读取失败：${result.code ?? 'UNKNOWN'}${result.message ? ` · ${result.message}` : ''}`;
}

function renderFailure(result, error) {
  setLink('读取失败', 'danger');
  showNotice(explainFailure(result, error), 'danger');
}

async function load({ silent = false } = {}) {
  if (pageState.loading || !pageState.key) return;
  pageState.loading = true;
  if (!silent) {
    setLink('读取中', '');
    const refresh = byId('refresh');
    if (refresh) refresh.disabled = true;
  }
  try {
    const result = await wa.actions.call('read-state', {}, { key: pageState.key });
    if (!result || result.ok !== true) {
      renderFailure(result);
      return;
    }
    if (result.state_version === 0 || !result.state_summary) {
      renderEmpty(result);
      return;
    }
    hideNotice();
    renderSummary(result);
    setLink('引擎正常', 'ok');
  } catch (error) {
    renderFailure(null, error);
  } finally {
    pageState.loading = false;
    const refresh = byId('refresh');
    if (refresh) refresh.disabled = false;
  }
}

function setupChats(info) {
  const chats = Array.isArray(info?.chats) ? info.chats.filter((chat) => chat && chat.key) : [];
  const select = byId('chat');
  if (select) {
    select.replaceChildren(...chats.map((chat) => {
      const option = document.createElement('option');
      option.value = chat.key;
      option.textContent = chat.name || chat.key;
      return option;
    }));
  }
  pageState.key = chats[0]?.key ?? '';
  const picker = byId('chat-picker');
  if (picker) picker.hidden = chats.length <= 1;
}

/** 宿主只透传 `--wa-*`；用底色特征识别罗德岛深色预设。 */
function detectArk() {
  const root = document.documentElement;
  const bg = getComputedStyle(root).getPropertyValue('--wa-bg').trim().toLowerCase();
  const arkColors = ['#101519', '#171f24', '#202a30', 'rgb(16, 21, 25)', 'rgb(23, 31, 36)', 'rgb(32, 42, 48)'];
  root.dataset.ark = !bg || arkColors.includes(bg) ? '1' : '0';
}

async function boot() {
  detectArk();
  wa.on('theme', detectArk);

  const refresh = byId('refresh');
  if (refresh) refresh.addEventListener('click', () => load());

  const select = byId('chat');
  if (select) {
    select.addEventListener('change', (event) => {
      pageState.key = event.target.value;
      load();
    });
  }

  try {
    const info = await wa.info();
    setupChats(info);

    if (info?.enabled !== true) {
      setLink('未启用', 'warn');
      showNotice('插件尚未启用。请先在控制台允许运行并分配聊天，然后刷新本页。', 'warn');
      return;
    }
    if (!pageState.key) {
      setLink('未连接', 'warn');
      showNotice('此插件还没有分配聊天，请先在控制台分配后再打开本页。', 'warn');
      return;
    }

    await load();
    pageState.timer = window.setInterval(() => {
      if (!document.hidden) load({ silent: true });
    }, REFRESH_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      if (pageState.timer) window.clearInterval(pageState.timer);
    });
  } catch (error) {
    setLink('连接失败', 'danger');
    showNotice(`无法连接宿主：${error?.message ?? error}`, 'danger');
  }
}

boot();
