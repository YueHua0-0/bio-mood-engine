/**
 * 12 §8：A02 / A03 / A04（鉴权与角色白名单）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUSINESS_TOKEN,
  CHARACTER_ID,
  OTHER_CHARACTER_ID,
  authHeaders,
  send,
  startTestServer
} from './_api_helpers.mjs';
import { readConfigFromEnv } from '../../lib/api/server.mjs';

const AUTH_HEADER = 'authorization';

test('A02 缺鉴权头 → 401，无 data，details 不回显令牌', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({ port, path: `/v1/state/${CHARACTER_ID}` });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.api_version, 'v1');
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
  assert.equal(res.json.error.retryable, false);
  assert.equal('data' in res.json, false);
  assert.equal(typeof res.json.request_id, 'string');
  // details 里不得出现令牌片段。
  assert.equal(JSON.stringify(res.json.error.details).includes(BUSINESS_TOKEN), false);
});

test('A03 错误令牌与空 Bearer 同码，details 为空对象且不含令牌', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const wrong = await send({
    port,
    path: `/v1/state/${CHARACTER_ID}`,
    headers: { [AUTH_HEADER]: 'Bearer wrong-token-value' }
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'UNAUTHORIZED');
  assert.deepEqual(wrong.json.error.details, {});

  const empty = await send({
    port,
    path: `/v1/state/${CHARACTER_ID}`,
    headers: { [AUTH_HEADER]: 'Bearer ' }
  });
  assert.equal(empty.status, 401);
  assert.equal(empty.json.error.code, 'UNAUTHORIZED');
  assert.deepEqual(empty.json.error.details, {});

  // 业务令牌不能当管理员令牌使用：管理端点只与 BM_ADMIN_TOKEN 比较。
  const asAdmin = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: authHeaders(BUSINESS_TOKEN),
    body: { character_id: CHARACTER_ID, operation: 'reset_state', now: '2026-11-09T09:00:00.000Z' }
  });
  assert.equal(asAdmin.status, 401);
  assert.equal(asAdmin.json.error.code, 'UNAUTHORIZED');
});

test('A04 空白名单 → 除 /health、/version 外全部 403', async (t) => {
  const { port, close } = await startTestServer({ config: { allowedCharacterIds: [] } });
  t.after(close);

  const state = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  assert.equal(state.status, 403);
  assert.equal(state.json.error.code, 'FORBIDDEN_CHARACTER');

  const events = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: {}
  });
  assert.equal(events.status, 403);
  assert.equal(events.json.error.code, 'FORBIDDEN_CHARACTER');

  const health = await send({ port, path: '/health', headers: authHeaders() });
  assert.equal(health.status, 200);
  const version = await send({ port, path: '/version', headers: authHeaders() });
  assert.equal(version.status, 200);
});

test('A04 含 A 不含 B：B 被 403，A 进入业务层', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const denied = await send({ port, path: `/v1/state/${OTHER_CHARACTER_ID}`, headers: authHeaders() });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'FORBIDDEN_CHARACTER');

  const allowed = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  // 业务已接入（W2）：通过白名单后进入 04 仓库；替身没有状态 → 404 NOT_FOUND，而不是 403。
  assert.notEqual(allowed.status, 403);
  assert.equal(allowed.status, 404);
  assert.equal(allowed.json.error.code, 'NOT_FOUND');

  // POST 的 character_id 在 body 里，解析后同样受白名单约束。
  const deniedBody = await send({
    port,
    method: 'POST',
    path: '/v1/tick',
    headers: authHeaders(),
    body: { character_id: OTHER_CHARACTER_ID, now: '2026-11-09T09:00:00.000Z' }
  });
  assert.equal(deniedBody.status, 403);
  assert.equal(deniedBody.json.error.code, 'FORBIDDEN_CHARACTER');
});

test('A04 管理端点使用管理员令牌，业务令牌 401', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: authHeaders(),
    body: { character_id: CHARACTER_ID, operation: 'reset_state', now: '2026-11-09T09:00:00.000Z' }
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
});

test('A20 BM_ADMIN_TOKEN 缺失 / 过短 / 与业务令牌相同 → 启动前拒绝（P-12-02）', () => {
  const base = { BM_API_TOKEN: BUSINESS_TOKEN };

  // 缺失。
  assert.throws(() => readConfigFromEnv({ ...base }), /BM_ADMIN_TOKEN is missing/);
  // 过短。
  assert.throws(() => readConfigFromEnv({ ...base, BM_ADMIN_TOKEN: 'too-short' }), /BM_ADMIN_TOKEN is missing/);
  // 与业务令牌相同。
  assert.throws(
    () => readConfigFromEnv({ ...base, BM_ADMIN_TOKEN: BUSINESS_TOKEN }),
    /BM_ADMIN_TOKEN must differ from BM_API_TOKEN/
  );

  // 错误串不得出现令牌值。
  try {
    readConfigFromEnv({ ...base, BM_ADMIN_TOKEN: BUSINESS_TOKEN });
    assert.fail('应当抛错');
  } catch (err) {
    assert.equal(err.message.includes(BUSINESS_TOKEN), false);
  }

  // 合法配置正常返回，不进入 listen 也能验证。
  const config = readConfigFromEnv({ ...base, BM_ADMIN_TOKEN: 'test-admin-token-0123456789' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.adminToken, 'test-admin-token-0123456789');
});
