/**
 * 12 §4.2 / §4.3 / §5.10：错误码 → HTTP 映射与信封构造。
 *
 * 硬规则（v1.7.9 W6-2 + 12 第 4 步交底）：
 * - 200 类码（DUPLICATE_EVENT / CLOCK_REGRESSION / DEGRADED）一律走成功信封，
 *   不得出现在 `error` 分支；业务层若抛出这些码，说明装配错误，转 INTERNAL 并记日志。
 * - `error.details` 只允许白名单键，其他键丢弃并记 `DETAILS_KEY_DROPPED`。
 */

export const API_VERSION = 'v1';

/** 00 §9.2 / 12 §5.10 的完整映射表。 */
const ERROR_TABLE = Object.freeze({
  INVALID_REQUEST: { status: 400, retryable: false },
  INVALID_TIME: { status: 400, retryable: false },
  UNAUTHORIZED: { status: 401, retryable: false },
  FORBIDDEN_CHARACTER: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  DUPLICATE_EVENT: { status: 200, retryable: false },
  STATE_VERSION_CONFLICT: { status: 409, retryable: true },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  CLOCK_REGRESSION: { status: 200, retryable: false },
  MODULE_FAILED: { status: 500, retryable: false },
  STORAGE_FAILED: { status: 503, retryable: true },
  DEGRADED: { status: 200, retryable: true },
  INTERNAL: { status: 500, retryable: false }
});

/** 00 §9.2：有 HTTP 200 但必须走成功信封的三个码。 */
const SUCCESS_CODES = new Set(['DUPLICATE_EVENT', 'CLOCK_REGRESSION', 'DEGRADED']);

/** 12 §4.3 / 第 4 步交底 3.3：可公开的 details 键。 */
const DETAILS_ALLOWLIST = new Set([
  'unknown_fields',
  'path',
  'expected',
  'retry_after_seconds',
  'recovery_required',
  'client_request_id',
  'reason',
  'warnings'
]);

export function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function isSuccessCode(code) {
  return SUCCESS_CODES.has(code);
}

export function httpStatusFor(code) {
  return ERROR_TABLE[code]?.status ?? 500;
}

export function retryableFor(code) {
  return ERROR_TABLE[code]?.retryable ?? false;
}

export function successEnvelope(requestId, data) {
  return { ok: true, api_version: API_VERSION, request_id: requestId, data };
}

/** 只保留白名单键；非对象一律视为空 details。 */
export function filterDetails(details, { logger, requestId } = {}) {
  const out = {};
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return out;
  for (const [key, value] of Object.entries(details)) {
    if (DETAILS_ALLOWLIST.has(key)) {
      if (value !== undefined) out[key] = value;
    } else {
      logger?.warn?.({ code: 'DETAILS_KEY_DROPPED', key, request_id: requestId });
    }
  }
  return out;
}

export function errorEnvelope(requestId, code, message, details, options = {}) {
  return {
    ok: false,
    api_version: API_VERSION,
    request_id: requestId,
    error: {
      code,
      message,
      retryable: retryableFor(code),
      details: filterDetails(details, { ...options, requestId })
    }
  };
}

/**
 * 把业务层抛出的任意错误转成 `{ status, body }`。
 * 未知码与 200 类码都收敛为 INTERNAL；后者记 `MISROUTED_200_CODE`。
 */
export function toErrorResponse(err, requestId, { logger, clientRequestId } = {}) {
  let code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
  let message = typeof err?.message === 'string' && err.message.length > 0 ? err.message : 'internal error';

  if (isSuccessCode(code)) {
    logger?.warn?.({ code: 'MISROUTED_200_CODE', original_code: code, request_id: requestId });
    code = 'INTERNAL';
    message = 'internal error';
  } else if (!(code in ERROR_TABLE)) {
    code = 'INTERNAL';
    message = 'internal error';
  } else if (code === 'INTERNAL') {
    // 内部错误不回显堆栈、路径或原始 message（12 §5.11 / §10.5）。
    message = 'internal error';
  }

  const details = { ...(err?.details ?? {}) };
  if (clientRequestId !== undefined && clientRequestId !== null) {
    details.client_request_id = String(clientRequestId);
  }

  return { status: httpStatusFor(code), body: errorEnvelope(requestId, code, message, details, { logger }) };
}
