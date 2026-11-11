/**
 * 12 §8：A05–A09（严格校验）、A16（信封，第 4 步部分通过）、A17（request_id）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { toErrorResponse } from '../../lib/api/errors.mjs';
import {
  CHARACTER_ID,
  OTHER_CHARACTER_ID,
  authHeaders,
  createRepoStub,
  send,
  startTestServer,
  validEvent
} from './_api_helpers.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;

test('A05 顶层未知字段 → 400，details.unknown_fields 含 foo', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({ foo: 'bar' })
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'INVALID_REQUEST');
  assert.equal(res.json.error.retryable, false);
  assert.deepEqual(res.json.error.details.unknown_fields, ['foo']);
});

test('A05 嵌套未知字段给出点号路径', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const base = validEvent();
  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: { ...base, payload: { ...base.payload, foo: 'bar' } }
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json.error.details.unknown_fields, ['payload.foo']);
});

test('A06 超过 64 KiB → 413 且连接被关闭（不读完再判）', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const body = JSON.stringify(validEvent({ pad: 'x'.repeat(70000) }));
  assert.ok(Buffer.byteLength(body, 'utf8') > 70000);

  // ① 带 Content-Length：读 body 之前直接 413（P-12-04）。
  const res = await send({ port, method: 'POST', path: '/v1/events', headers: authHeaders(), body });
  assert.equal(res.socketError, undefined, `期望收到 413，实际连接异常: ${res.socketError}`);
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(res.headers.connection, 'close');

  // ② 无 Content-Length（分块传输）：累计超限后 pause + 413 + close。
  const chunked = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body,
    chunked: true
  });
  assert.equal(chunked.socketError, undefined, `分块路径应收到 413，实际连接异常: ${chunked.socketError}`);
  assert.equal(chunked.status, 413);
  assert.equal(chunked.json.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(chunked.headers.connection, 'close');
});

test('A07 Content-Type: text/plain → 415，不读 body', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: { Authorization: `Bearer ${'test-business-token-0123456789'}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(validEvent())
  });
  assert.equal(res.status, 415);
  assert.equal(res.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(res.headers.connection, 'close');
});

test('A08 occurred_at 缺毫秒 / 无 Z → INVALID_TIME', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const noMs = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({ occurred_at: '2026-11-09T09:20:00Z' })
  });
  assert.equal(noMs.status, 400);
  assert.equal(noMs.json.error.code, 'INVALID_TIME');
  assert.equal(noMs.json.error.details.path, 'occurred_at');

  const noZ = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({ received_at: '2026-11-09T09:20:01.000' })
  });
  assert.equal(noZ.status, 400);
  assert.equal(noZ.json.error.code, 'INVALID_TIME');
});

test('A09 event_type: chat → 400，不回退为 group_message', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({ event_type: 'chat' })
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'INVALID_REQUEST');
  assert.equal(res.json.error.details.path, 'event_type');
  assert.ok(Array.isArray(res.json.error.details.expected));
  assert.ok(res.json.error.details.expected.includes('group_message'));
});

test('A09b JSON 语法错误 → 400 INVALID_REQUEST', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: '{"character_id":'
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'INVALID_REQUEST');
});

test('A16 信封字段完整（第 4 步：400/401/403/404/413/415/429/500）', async (t) => {
  // 500 样本由"存储读取抛错"触发（业务已接入 W2，不再依赖 not_implemented）。
  const { port, close } = await startTestServer({
    repo: createRepoStub({
      loadState: async () => {
        throw new Error('storage unavailable');
      }
    })
  });
  t.after(close);

  const samples = [];
  samples.push({
    label: '400',
    res: await send({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders(),
      body: validEvent({ foo: 1 })
    })
  });
  samples.push({ label: '401', res: await send({ port, path: `/v1/state/${CHARACTER_ID}` }) });
  samples.push({
    label: '403',
    res: await send({ port, path: `/v1/state/${OTHER_CHARACTER_ID}`, headers: authHeaders() })
  });
  samples.push({ label: '404', res: await send({ port, path: '/v1/unknown', headers: authHeaders() }) });
  samples.push({
    label: '413',
    res: await send({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders(),
      body: JSON.stringify(validEvent({ pad: 'x'.repeat(70000) }))
    })
  });
  samples.push({
    label: '415',
    res: await send({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
      body: '{}'
    })
  });
  samples.push({ label: '500', res: await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() }) });

  // 429：耗尽"其余端点"60 次额度后的第 61 次。
  let limited;
  for (let i = 0; i < 61; i += 1) {
    limited = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  }
  samples.push({ label: '429', res: limited });

  for (const { label, res } of samples) {
    assert.equal(res.json.ok, false, `${label}: ok 必须为 false`);
    assert.equal(res.json.api_version, 'v1', `${label}: api_version`);
    assert.equal(typeof res.json.request_id, 'string', `${label}: request_id 必须是字符串`);
    assert.ok(res.json.request_id.length > 0, `${label}: request_id 不能为空`);
    assert.equal('data' in res.json, false, `${label}: error 分支不得有 data`);
    assert.equal(typeof res.json.error.code, 'string', `${label}: error.code`);
    assert.equal(typeof res.json.error.message, 'string', `${label}: error.message`);
    assert.equal(typeof res.json.error.retryable, 'boolean', `${label}: error.retryable`);
    assert.equal(typeof res.json.error.details, 'object', `${label}: error.details`);
    assert.equal(res.json.error.details !== null, true, `${label}: error.details 不能为 null`);
  }

  const expected = { '400': 400, '401': 401, '403': 403, '404': 404, '413': 413, '415': 415, '429': 429, '500': 500 };
  for (const { label, res } of samples) {
    assert.equal(res.status, expected[label], `${label}: HTTP 状态`);
  }
});

test('A17 连续 100 次请求的 request_id 互不相同，X-Request-Id 不影响服务端', async (t) => {
  const { port, close } = await startTestServer();
  t.after(close);

  const ids = new Set();
  for (let i = 0; i < 100; i += 1) {
    const res = await send({
      port,
      path: '/health',
      headers: { ...authHeaders(), 'X-Request-Id': 'client-fixed-id' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const id = res.json.request_id;
    assert.ok(UUID_V4.test(id) || HEX32.test(id), `request_id 格式非法: ${id}`);
    assert.notEqual(id, 'client-fixed-id');
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});

test('errors：200 类码不得进 error 信封，转 INTERNAL 并记 MISROUTED_200_CODE', async () => {
  const warnings = [];
  const logger = { info() {}, warn(entry) { warnings.push(entry); } };
  for (const code of ['DUPLICATE_EVENT', 'CLOCK_REGRESSION', 'DEGRADED']) {
    const { status, body } = toErrorResponse({ code, message: 'x' }, 'req-1', { logger });
    assert.equal(status, 500, `${code} 不得映射为 200`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'INTERNAL');
    assert.equal(body.error.retryable, false);
  }
  assert.equal(warnings.filter((entry) => entry.code === 'MISROUTED_200_CODE').length, 3);
});

test('errors：details 只保留白名单键，其他键丢弃并记 DETAILS_KEY_DROPPED', async () => {
  const warnings = [];
  const logger = { info() {}, warn(entry) { warnings.push(entry); } };
  const { body } = toErrorResponse(
    {
      code: 'INVALID_REQUEST',
      message: 'bad body',
      details: { unknown_fields: ['foo'], path: 'foo', body: '{}', stack: 'at x', token: 't' }
    },
    'req-2',
    { logger }
  );
  assert.deepEqual(body.error.details, { unknown_fields: ['foo'], path: 'foo' });
  const dropped = warnings.filter((entry) => entry.code === 'DETAILS_KEY_DROPPED').map((entry) => entry.key);
  assert.deepEqual(dropped.sort(), ['body', 'stack', 'token']);
});
