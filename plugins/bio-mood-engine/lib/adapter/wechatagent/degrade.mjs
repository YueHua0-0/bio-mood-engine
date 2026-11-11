/**
 * 13 §5.7 / §5.8 / P-13-01：降级语义的唯一出口。
 *
 * 原则：适配层任何内部失败都不能打断聊天。已知的入参错误原样返回，
 * 其余（ABORTED、存储失败、引擎异常、迁移等待）统一映射为 `DEGRADED`。
 */

const PASSTHROUGH = new Set([
  'INVALID_REQUEST',
  'INVALID_TIME',
  'UNAUTHORIZED',
  'STATE_VERSION_CONFLICT',
  'NOT_FOUND'
]);

/** 引擎/存储错误码 → 安全的降级原因，绝不回传原始 message（可能含状态内容）。 */
const DEGRADE_REASON = Object.freeze({
  ABORTED: 'aborted',
  STORAGE_FAILED: 'storage',
  MODULE_FAILED: 'engine',
  DEGRADED: 'readonly_scope',
  INTERNAL: 'internal',
  CONFIG_INVALID: 'config'
});

/** 13 §5.7：DEGRADED 时的中性行为上下文，不含任何数值或评分维度。 */
export function neutralBehaviorContext() {
  return {
    behavior_notes: ['本轮按中性方式回应，不额外调整语气。'],
    reason_codes: ['degraded'],
    hard_rule_precedence: true
  };
}

/** 13 §5.4：DEGRADED 工具结果；状态与交付字段显式为 null，调用方按无状态处理。 */
export function degradedResult(warnings = [], extra = {}) {
  return {
    ok: false,
    code: 'DEGRADED',
    state_summary: null,
    delivery: null,
    behavior_context: neutralBehaviorContext(),
    details: { warnings: [...warnings] },
    ...extra
  };
}

/** 13 §5.7：内部错误 → 契约错误；ABORTED 永远不是 5xx。 */
export function errorToResult(error, extraWarnings = []) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  if (PASSTHROUGH.has(code)) {
    return {
      ok: false,
      code,
      details: error?.details ?? {}
    };
  }
  const reason = DEGRADE_REASON[code] ?? 'unknown';
  return degradedResult(extraWarnings, {
    details: { warnings: [...extraWarnings], reason }
  });
}

export function isReadOnlyWarning(warnings) {
  return warnings.includes('PRIMARY_UNBOUND') || warnings.includes('NON_PRIMARY_READONLY');
}

export function isStorageDegradeWarning(warnings) {
  return (
    warnings.includes('MIGRATION_DEFERRED') ||
    warnings.includes('STORAGE_OVER_BUDGET') ||
    warnings.includes('RECOVERY_DEFERRED')
  );
}

export default errorToResult;
