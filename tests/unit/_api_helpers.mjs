/**
 * 12 A01–A19 的公共夹具：真实 HTTP server（port 0）+ 最小 repo 桩。
 * 文件名以下划线开头，不会被 `tests/unit/*.test.mjs` 收集。
 */

import { request as httpRequest } from 'node:http';

import { createApiServer } from '../../lib/api/server.mjs';

export const BUSINESS_TOKEN = 'test-business-token-0123456789';
export const ADMIN_TOKEN = 'test-admin-token-0123456789';
export const FIXED_NOW = '2026-11-09T09:00:00.000Z';
export const CHARACTER_ID = 'whale_character';
export const OTHER_CHARACTER_ID = 'other_character';

export const NOOP_LOGGER = { info() {}, warn() {} };

export function createRepoStub(overrides = {}) {
  return {
    loadState: async () => ({ state: null, warnings: [] }),
    ...overrides
  };
}

/** 04 §5.2 的宿主单键接口替身：值为 JSON 字符串，键固定五个。 */
export function createMemoryStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    }
  };
}

export function authHeaders(token = BUSINESS_TOKEN) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function validEvent(overrides = {}) {
  return {
    api_version: 'v1',
    event_id: 'evt_20261109_ab12cd34',
    idempotency_key: 'evt_20261109_ab12cd34',
    character_id: CHARACTER_ID,
    event_type: 'group_message',
    occurred_at: '2026-11-09T09:20:00.000Z',
    received_at: '2026-11-09T09:20:01.000Z',
    source: {
      platform: 'wechat',
      conversation_id: 'group_123',
      conversation_kind: 'group',
      sender_id: 'sender_a1',
      is_mentioned: false,
      relationship_tag: 'ordinary'
    },
    payload: {
      message_type: 'text',
      text_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      text_summary: '',
      is_direct_question: false
    },
    tags: [],
    ...overrides
  };
}

export async function startTestServer({ repo, config = {}, clock = () => FIXED_NOW, logger = NOOP_LOGGER } = {}) {
  const server = createApiServer({
    repo: repo ?? createRepoStub(),
    config: {
      businessToken: BUSINESS_TOKEN,
      adminToken: ADMIN_TOKEN,
      allowedCharacterIds: [CHARACTER_ID],
      requestTimeoutMs: 1000,
      tickTimeoutMs: 2000,
      ...config
    },
    clock,
    logger
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * 发送一次请求。socket 被对端中止时以 `socketError` 返回，便于 A06 区分
 * "读到 413" 与 "连接被直接中止"。
 */
export function send({ port, method = 'GET', path, headers = {}, body, timeoutMs = 5000, chunked = false }) {
  return new Promise((resolve) => {
    const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const payload = raw === undefined ? undefined : Buffer.from(raw, 'utf8');
    const finalHeaders = { ...headers };
    // chunked=true 时不写 Content-Length，走分块传输（A06 的 ② 路径）。
    if (payload !== undefined && !chunked) finalHeaders['Content-Length'] = String(payload.length);

    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client timeout')));
    req.on('error', (err) => {
      resolve({ status: 0, headers: {}, text: '', json: undefined, socketError: err.code ?? err.message });
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
