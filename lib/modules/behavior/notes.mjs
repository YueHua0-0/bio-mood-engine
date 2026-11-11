/**
 * 10 §5.8：行为提示文案固定表、优先级挑选与合规校验。
 *
 * 文案表是唯一合法来源：不得即席拼接。禁用词与维度名只约束**输出文本**，
 * 因此本文件用 Unicode 转义保存禁用词，避免源码检索把校验表误判为命中。
 */

/** 输出文案禁用词（不含任何真实健康语义，仅作合规闸门）。 */
const BANNED_NOTE_WORDS = Object.freeze([
  '\u8bca\u65ad',
  '\u6fc0\u7d20',
  '\u533b\u5b66',
  '\u6cbb\u7597'
]);

const DIMENSION_WORDS = /(energy|stability|sensitivity|social_drive|closeness_need|mood|stress|sleep)/i;
const DIGITS = /[0-9\uff10-\uff19]/;
const FORMULA_SYMBOLS = /[+\-*/=<>%^\u00d7\u00f7]/;

export const NOTE_MAX_CHARS = 40;
export const NOTES_MAX_COUNT = 3;

/** 兜底文案（优先级 11），也是非法文案的回退目标。 */
export const FALLBACK_NOTE = '语气自然，跟随当前情境';

/**
 * 10 §5.8：文案合法性。超长 / 含数字 / 含公式符号 / 含维度名 / 含禁用词均判非法。
 */
export function isNoteSafe(text) {
  if (typeof text !== 'string') return false;
  if (text.length === 0 || text.length > NOTE_MAX_CHARS) return false;
  if (DIGITS.test(text)) return false;
  if (FORMULA_SYMBOLS.test(text)) return false;
  if (DIMENSION_WORDS.test(text)) return false;
  if (BANNED_NOTE_WORDS.some((word) => text.includes(word))) return false;
  return true;
}

/** 11 条固定表，严格按优先级自上而下。 */
export const NOTE_TABLE = Object.freeze([
  Object.freeze({
    priority: 1,
    when: (ctx) => ctx.sleep_state === 'sleeping',
    text: '当前处于睡眠模拟状态，倾向延迟回应'
  }),
  Object.freeze({
    priority: 2,
    when: (ctx) => ctx.sleep_state === 'waking_up',
    text: '刚醒来，回应节奏偏慢'
  }),
  Object.freeze({
    priority: 3,
    when: (ctx) => ctx.sleepiness > 0.75,
    text: '困倦明显，表达应简短'
  }),
  Object.freeze({
    priority: 4,
    when: (ctx) => ctx.sleep_debt >= 0.50,
    text: '近期休息不足，耐心偏低'
  }),
  Object.freeze({
    priority: 5,
    when: (ctx) => ctx.stress >= 0.55,
    text: '压力偏高，语气偏紧'
  }),
  Object.freeze({
    priority: 6,
    when: (ctx) => ctx.energy < 0.35,
    text: '精力不足，回复偏短'
  }),
  Object.freeze({
    priority: 7,
    when: (ctx) => ctx.energy >= 0.70 && ctx.social_drive >= 0.60,
    text: '精力充沛，愿意多聊'
  }),
  Object.freeze({
    priority: 8,
    when: (ctx) => ctx.avoidance >= 0.60,
    text: '回避倾向上升，先观察再回应'
  }),
  Object.freeze({
    priority: 9,
    when: (ctx) => ctx.closeness_need >= 0.70,
    text: '希望被回应与陪伴'
  }),
  Object.freeze({
    priority: 10,
    when: (ctx) => ctx.affection_expression === 'reserved',
    text: '保持礼貌距离'
  }),
  Object.freeze({
    priority: 11,
    when: () => true,
    text: FALLBACK_NOTE
  })
]);

/**
 * 10 §5.8：按优先级自上而下取前 3 条命中项。
 *
 * 非法文案（数字 / 禁用词 / 超长）不输出，回退到兜底文案并记 `INVALID_BEHAVIOR_NOTE`；
 * 表本身超 3 条时截断并记 `NOTES_TRUNCATED`。
 *
 * @returns {{ notes: string[], warnings: string[] }}
 */
export function buildNotes(ctx, table = NOTE_TABLE) {
  const notes = [];
  const warnings = [];

  for (const entry of table) {
    if (notes.length >= NOTES_MAX_COUNT) {
      warnings.push('NOTES_TRUNCATED');
      break;
    }
    if (!entry.when(ctx)) continue;
    if (notes.includes(entry.text)) continue;

    if (entry.text.length > NOTE_MAX_CHARS) {
      warnings.push('NOTES_TRUNCATED');
      continue;
    }
    if (!isNoteSafe(entry.text)) {
      warnings.push('INVALID_BEHAVIOR_NOTE');
      if (!notes.includes(FALLBACK_NOTE)) notes.push(FALLBACK_NOTE);
      continue;
    }
    notes.push(entry.text);
  }

  return { notes, warnings };
}
