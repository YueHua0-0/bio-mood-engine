/**
 * 12 §8：A10（限流）与 A18（/health、/version 的存储健康）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHARACTER_ID,
  authHeaders,
  createRepoStub,
  send,
  startTestServer
} from './_api_helpers.mjs';

test('A10 /v1/events 第 121 次 429，前 120 次正常计入', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  let last;
  for (let i = 0; i < 121; i += 1) {
    // body 故意非法（缺必填字段）：限流在 schema 校验之前，因此仍可稳定触发。
    last = await send({ port, method: 'POST', path: '/v1/events', headers: authHeaders(), body: {} });
    if (i < 120) {
      assert.equal(last.status, 400, `第 ${i + 1} 次应为 400`);
      assert.equal(last.json.error.code, 'INVALID_REQUEST');
    }
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'RATE_LIMITED');
  assert.equal(last.json.error.retryable, true);
  const retry = last.json.error.details.retry_after_seconds;
  assert.ok(Number.isInteger(retry) && retry >= 1, `retry_after_seconds 必须是 >=1 的整数: ${retry}`);
  assert.equal(last.headers['retry-after'], String(retry));
});

test('A10 /v1/state 第 61 次 429，且 events 计数独立', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
    if (i < 60) {
      // 业务已接入（W2）：替身无状态 → 404 证明请求进入业务层且未被限流。
      assert.equal(last.status, 404, `第 ${i + 1} 次应进入业务层`);
      assert.equal(last.json.error.code, 'NOT_FOUND');
    }
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'RATE_LIMITED');
  assert.ok(Number.isInteger(last.json.error.details.retry_after_seconds));
  assert.ok(last.json.error.details.retry_after_seconds >= 1);

  // 两个计数器独立：events 额度不受影响。
  const events = await send({ port, method: 'POST', path: '/v1/events', headers: authHeaders(), body: {} });
  assert.equal(events.status, 400);
  assert.equal(events.json.error.code, 'INVALID_REQUEST');
});

test('A10 /health 与 /version 永不计入限流', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  for (let i = 0; i < 70; i += 1) {
    const health = await send({ port, path: '/health', headers: authHeaders() });
    assert.equal(health.status, 200, `/health 第 ${i + 1} 次不应被限流`);
    const version = await send({ port, path: '/version', headers: authHeaders() });
    assert.equal(version.status, 200, `/version 第 ${i + 1} 次不应被限流`);
  }

  // 健康检查不消耗业务额度：随后仍可用满 state 的 60 次。
  let last;
  for (let i = 0; i < 60; i += 1) {
    last = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
    assert.notEqual(last.status, 429, `第 ${i + 1} 次不应被限流`);
  }
});

test('A18 存储读取抛错 → /health storage=degraded，且不泄露内部信息', async (t) => {
  const repo = createRepoStub({
    loadState: async () => {
      throw new Error('EIO: cannot read C:\\secret\\store.json');
    }
  });
  const { port, close } = await startTestServer({ repo });
  t.after(close);

  const res = await send({ port, path: '/health', headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.data, { status: 'ok', storage: 'degraded' });
  assert.equal(res.text.includes('secret'), false);
  assert.equal(res.text.includes('EIO'), false);
});

test('A18 存储正常（state===null）→ storage=ok；/version 字段完整', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const health = await send({ port, path: '/health', headers: authHeaders() });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.api_version, 'v1');
  assert.deepEqual(health.json.data, { status: 'ok', storage: 'ok' });

  const version = await send({ port, path: '/version', headers: authHeaders() });
  assert.equal(version.status, 200);
  assert.equal(version.json.data.api_version, 'v1');
  assert.equal(typeof version.json.data.engine_version, 'string');
  assert.ok(version.json.data.engine_version.length > 0);
  assert.equal(version.json.data.schema_version, 1);

  // 健康探测不得写入：loadState 走只读选项。
  assert.equal(version.json.request_id.length > 0, true);
});

test('A18 /health 使用 loadState({readOnly:true}) 探测', async (t) => {
  const calls = [];
  const repo = createRepoStub({
    loadState: async (id, options) => {
      calls.push({ id, options });
      return { state: null, warnings: [] };
    }
  });
  const { port, close } = await startTestServer({ repo });
  t.after(close);

  const res = await send({ port, path: '/health', headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.readOnly, true);
  assert.equal(calls[0].id, undefined);
});
