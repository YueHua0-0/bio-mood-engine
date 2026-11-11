/**
 * 12 §5.1：Bearer 解析、常量时间比较、角色白名单。
 *
 * - 令牌只来自部署方的注入（server.mjs 读环境变量），本模块不读环境变量。
 * - 比较前先各自 SHA-256，等长后 timingSafeEqual，禁止 `===` 短路。
 * - 管理端点（/v1/admin/reset）只与管理员令牌比较；失败一律 401，不提示"是管理接口"。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const MIN_TOKEN_LENGTH = 16;
const SCHEME = 'bearer';
/** 头名（Node 已小写化）。12 §9 已把该字面量移出零输出检索式（P-12-01）。 */
const HEADER = 'authorization';

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function tokenFingerprint(token) {
  return digest(token).toString('hex').slice(0, 16);
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(digest(left), digest(right));
}

/** @returns {string|null} token，格式不符返回 null（含空 Bearer）。 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const separator = headerValue.indexOf(' ');
  if (separator <= 0) return null;
  if (headerValue.slice(0, separator).toLowerCase() !== SCHEME) return null;
  const token = headerValue.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

/** @returns {string|undefined} 原始头值（Node 会把头名小写）。 */
export function readAuthHeader(headers) {
  return headers?.[HEADER];
}

/**
 * 启动期校验（12 §5.1 / §5.8）：缺失、过短、或业务令牌等于管理令牌 → 拒绝启动。
 * 错误信息不含令牌本身。
 */
export function assertTokenConfig({ businessToken, adminToken } = {}) {
  if (typeof businessToken !== 'string' || businessToken.length < MIN_TOKEN_LENGTH) {
    throw new Error('BM_API_TOKEN is missing or shorter than 16 characters');
  }
  if (typeof adminToken !== 'string' || adminToken.length < MIN_TOKEN_LENGTH) {
    throw new Error('BM_ADMIN_TOKEN is missing or shorter than 16 characters');
  }
  if (constantTimeEqual(businessToken, adminToken)) {
    throw new Error('BM_ADMIN_TOKEN must differ from BM_API_TOKEN');
  }
}

export function isCharacterAllowed(allowedCharacterIds, characterId) {
  if (!Array.isArray(allowedCharacterIds) || allowedCharacterIds.length === 0) return false;
  return allowedCharacterIds.includes(characterId);
}
