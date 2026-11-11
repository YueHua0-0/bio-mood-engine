/**
 * 13 §5.5 / §5.6 / P06 / P07 / P08 / P17：两个宿主动作。
 *
 * `before-context` 只读快照，绝不推进、绝不写盘，超时预算 800 ms。
 * `after-response` 只在显式开启协议模式时原样确认前缀，不做任何改写。
 */

import { isNoteSafe, NOTES_MAX_COUNT } from '../../../../../lib/modules/behavior/notes.mjs';
import { updateBehavior } from '../../../../../lib/modules/behavior/index.mjs';
import { normalizeConfig } from './manifest.mjs';
import { chatIdOf, createChatRepo, readOnlySnapshot } from './repo.mjs';
import { isReadOnlyWarning, isStorageDegradeWarning } from './degrade.mjs';

/** 00 §1.1 的完整免责声明（必须整句出现，不得拆分或缩写）。 */
export const FICTION_DISCLAIMER =
  '本引擎中的生理周期、睡眠、神经调节和情绪数据均为虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或现实健康预测。';

export const CONTEXT_MAX_CHARS = 1500;
export const CONTEXT_BUDGET_MS = 800;

const CONTEXT_TIMEOUT_MS = 700;

const DIMENSION_WORDS =
  /(energy|stability|sensitivity|social_drive|closeness_need|physical_comfort|mood|stress|sleep|reply_likelihood|avoidance|wake_cost)/gi;
const DIGITS = /[0-9\uff10-\uff19]/g;
const FORMULA_SYMBOLS = /[+\-*/=<>%^\u00d7\u00f7]/g;
const SENTENCE_END = /[。！？!?]$/;

function settingsOf(ctx) {
  return normalizeConfig(ctx?.config?.()).settings;
}

/** 13 §5.5：删除数字、维度名与公式符号；仍为空则丢弃该条。 */
export function sanitizeNote(note) {
  if (typeof note !== 'string') return '';
  const cleaned = note
    .replace(DIGITS, '')
    .replace(DIMENSION_WORDS, '')
    .replace(FORMULA_SYMBOLS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  return cleaned;
}

function cutAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const index = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  if (index >= 0) return head.slice(0, index + 1);
  return `${head}。`;
}

/**
 * P08：固定免责声明 + ≤3 条无数字/无维度名的定性提示，总长受配置约束。
 */
export function composeContext({ notes = [], maxChars = 800 } = {}) {
  const limit = Math.max(0, Math.min(CONTEXT_MAX_CHARS, Number.isFinite(maxChars) ? maxChars : 800));
  const kept = [];
  for (const raw of Array.isArray(notes) ? notes : []) {
    if (kept.length >= NOTES_MAX_COUNT) break;
    const note = sanitizeNote(raw);
    if (!note || !isNoteSafe(note)) continue;
    if (!kept.includes(note)) kept.push(note);
  }

  if (limit === 0) return '';
  if (limit <= FICTION_DISCLAIMER.length) return cutAtSentence(FICTION_DISCLAIMER, limit);

  const body = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  const text = body + FICTION_DISCLAIMER;
  if (text.length <= limit) return text;

  const notesBudget = Math.max(0, limit - FICTION_DISCLAIMER.length - 1);
  const shortened = notesBudget > 0 ? `${cutAtSentence(kept.join('\n'), notesBudget)}\n` : '';
  return (shortened + FICTION_DISCLAIMER).slice(0, limit);
}

/** 10 的输入映射：只取 behavior 模块声明的字段。 */
export function behaviorInputsFromState(state) {
  return {
    mood: {
      energy: state.mood.energy,
      stability: state.mood.stability,
      sensitivity: state.mood.sensitivity,
      social_drive: state.mood.social_drive,
      closeness_need: state.mood.closeness_need
    },
    stress: { level: state.stress.level },
    sleep: {
      state: state.sleep.state,
      sleepiness: state.sleep.sleepiness,
      sleep_debt: state.sleep.sleep_debt
    }
  };
}

export function behaviorNotesFromState(state) {
  const result = updateBehavior({
    previous: null,
    inputs: behaviorInputsFromState(state)
  });
  const notes = result?.state?.behavior_notes ?? result?.context?.behavior_notes ?? [];
  return Array.isArray(notes) ? notes : [];
}

function withTimeout(task, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function readContext(input, ctx, settings) {
  if (!settings.enabled) return { context: '' };
  if (settings.shadowMode) return { context: '' };
  if (settings.engineMode !== 'embedded') return { context: '' };
  const chatId = chatIdOf(ctx);
  const ids = settings.primaryChatIds || [];
  if (ids.length === 0 || !ids.includes(chatId)) return { context: '' };

  const repo = createChatRepo({ ctx, settings });
  if (repo.readOnly) return { context: '' };

  const snapshot = await readOnlySnapshot(repo, settings.characterId);
  if (!snapshot.state) return { context: '' };
  if (isReadOnlyWarning(snapshot.warnings) || isStorageDegradeWarning(snapshot.warnings)) {
    return { context: '' };
  }

  const maxChars = Math.min(settings.behaviorContextMaxChars, CONTEXT_MAX_CHARS);
  const notes = behaviorNotesFromState(snapshot.state);
  return { context: composeContext({ notes, maxChars }) };
}

/**
 * 13 §5.5：`before-context`。
 * 任何异常、超时、只读或未初始化都返回空字符串，由宿主按无提示继续。
 */
export async function beforeContextHook(input = {}, ctx = {}) {
  const settings = settingsOf(ctx);
  try {
    const result = await withTimeout(readContext(input, ctx, settings), CONTEXT_TIMEOUT_MS);
    return result ?? { context: '' };
  } catch {
    return { context: '' };
  }
}

/**
 * 13 §5.6：`after-response`。仅在 protocol 模式且文本以精确大写前缀开头时确认。
 * 返回 `{}` 表示不接管；绝不重复发送。
 */
export function afterResponseHook(input = {}, ctx = {}) {
  const settings = settingsOf(ctx);
  if (settings.afterResponseMode !== 'protocol') return {};
  const text = input?.text;
  if (typeof text !== 'string') return {};
  if (text.startsWith('SILENT') || text.startsWith('RESPOND:')) return { text };
  return {};
}

/** 与 §4.1 的模块级 `hooks` 导出同形；带 ctx 时按宿主配置求值。 */
export const hooks = Object.freeze({
  'before-context': beforeContextHook,
  'after-response': afterResponseHook
});

export default hooks;
