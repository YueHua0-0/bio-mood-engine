/**
 * 12 §5.11 / §7：监听与生命周期。
 *
 * - 默认只监听 127.0.0.1（禁止 0.0.0.0），端口取 BM_PORT（默认 8787）。
 * - 令牌只在这里从环境变量读取并交给 handler；缺失/过短/两者相同 → 拒绝启动。
 * - 本文件是 `lib/api` 内唯一允许触碰 `process.env` 的位置（12 §9）。
 */

import { createServer } from 'node:http';

import { assertTokenConfig } from './auth.mjs';
import { createHandler } from './handler.mjs';

function parseNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCharacterList(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 部署配置（不属于引擎配置，12 §5.6）。 */
export function readConfigFromEnv(env = process.env) {
  const config = {
    businessToken: env.BM_API_TOKEN,
    adminToken: env.BM_ADMIN_TOKEN,
    allowedCharacterIds: parseCharacterList(env.BM_ALLOWED_CHARACTER_IDS),
    requestTimeoutMs: parseNumber(env.BM_REQUEST_TIMEOUT_MS, 5000),
    tickTimeoutMs: parseNumber(env.BM_TICK_TIMEOUT_MS, 10000),
    host: env.BM_HOST && env.BM_HOST.length > 0 ? env.BM_HOST : '127.0.0.1',
    port: parseNumber(env.BM_PORT, 8787)
  };
  assertTokenConfig(config);
  return config;
}

/** 单行 JSON 结构化日志（12 §5.9）；不写请求/响应正文、令牌或完整种子。 */
function createStdoutLogger() {
  return {
    info(entry) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    },
    warn(entry) {
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', ...entry })}\n`);
    }
  };
}

export function createApiServer({ repo, config, clock, idFactory, logger } = {}) {
  const handler = createHandler({ repo, config, clock, idFactory, logger: logger ?? createStdoutLogger() });
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end('{"ok":false,"api_version":"v1","request_id":"","error":{"code":"INTERNAL","message":"internal error","retryable":false,"details":{}}}');
      }
    });
  });
  return server;
}

/**
 * 从环境变量启动（远程模式的入口）。
 * @returns {Promise<import('node:http').Server>}
 */
export async function startApiServer({ repo, env = process.env, logger, clock, idFactory } = {}) {
  const config = readConfigFromEnv(env);
  // 12 §5.11：存储由部署方注入，服务不构造默认 repo；缺失即拒绝启动（fail-closed）。
  if (!repo) throw new Error('startApiServer requires an injected repo (see docs/12 §5.11)');
  const server = createApiServer({ repo, config, clock, idFactory, logger: logger ?? createStdoutLogger() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
