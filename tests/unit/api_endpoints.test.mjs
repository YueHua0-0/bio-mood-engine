/**
 * 12 §8：A01 / A11 / A12a / A12b / A13 / A14 / A15 / A19（W2 补齐 P-12-08）。
 *
 * 真实 04 仓库（内存存储）+ 真实 HTTP 端口；不使用 not_implemented 兜底。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { contractError } from '../../lib/api/errors.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { POLICIES } from '../../lib/modules/delivery/policy.mjs';
import { createRepository } from '../../lib/storage/repository.mjs';
import { MASTER_SEED } from './_random_vectors.mjs';
import {
  ADMIN_TOKEN,
  CHARACTER_ID,
  FIXED_NOW,
  authHeaders,
  createMemoryStorage,
  send,
  startTestServer,
  validEvent
} from './_api_helpers.mjs';

const TICK_NOW = '2026-11-09T10:00:00.000Z';

async function seeded(t, { withServer = true } = {}) {
  const storage = createMemoryStorage();
  const repo = createRepository({
    storage,
    character_id: CHARACTER_ID,
    clock: () => FIXED_NOW
  });
  await repo.saveState(
    createDefaultState({ character_id: CHARACTER_ID, timezone: 'Asia/Shanghai', now: FIXED_NOW, master_seed_hex: MASTER_SEED }),
    0
  );
  if (!withServer) return { storage, repo };
  const { port, close } = await startTestServer({ repo });
  t.after(close);
  return { storage, repo, port };
}

function eventWith({ eventId, key }) {
  return validEvent({ event_id: eventId, idempotency_key: key });
}

test('A01 合法事件 → 200，信封完整且 delivery.policy 合法', async (t) => {
  const { port } = await seeded(t);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent()
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.api_version, 'v1');
  assert.equal(typeof res.json.request_id, 'string');
  assert.ok(POLICIES.includes(res.json.data.delivery.policy), `policy=${res.json.data.delivery.policy}`);
  assert.equal(res.json.data.duplicate, false);
  assert.equal(res.json.data.state_version, 1);
  assert.equal(res.json.data.state_summary.state_version, 1);
  assert.equal(typeof res.json.data.processed_at, 'string');
});

test('A11 同 Idempotency-Key 连发两次 → 第二次 duplicate，版本与时间戳不变', async (t) => {
  const { port } = await seeded(t);
  // 只用头部幂等键：头与 body 同时出现且不同会被 12 §5.4 判为冲突。
  const { idempotency_key: _omit, ...body } = validEvent();

  const first = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: { ...authHeaders(), 'Idempotency-Key': 'idem_20261109_0001' },
    body
  });
  const second = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: { ...authHeaders(), 'Idempotency-Key': 'idem_20261109_0001' },
    body
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.data.duplicate, true);
  assert.equal(second.json.data.state_version, first.json.data.state_version);
  assert.equal(second.json.data.processed_at, first.json.data.processed_at);
  assert.equal('snapshot_evicted' in second.json.data, false);
  assert.equal(second.json.data.state_summary.state_version, first.json.data.state_summary.state_version);
});

test('A12a 并发两次推进同一角色 → 版本集合为 {1,2}', async (t) => {
  const { port } = await seeded(t);

  const [a, b] = await Promise.all([
    send({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: { ...authHeaders(), 'Idempotency-Key': 'idem_concurrent_a' },
      body: eventWith({ eventId: 'evt_20261109_0000a1', key: 'idem_concurrent_a' })
    }),
    send({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: { ...authHeaders(), 'Idempotency-Key': 'idem_concurrent_b' },
      body: eventWith({ eventId: 'evt_20261109_0000b1', key: 'idem_concurrent_b' })
    })
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual([a.json.data.state_version, b.json.data.state_version].sort(), [1, 2]);
});

test('A12b putState 持续冲突 → 409 STATE_VERSION_CONFLICT，evlog 为空', async (t) => {
  const { storage, repo } = await seeded(t, { withServer: false });
  const sabotaged = {
    ...repo,
    transaction: (fn, opts) =>
      repo.transaction(async (tx) => {
        const wrapped = Object.create(tx);
        wrapped.putState = async () => {
          throw contractError('STATE_VERSION_CONFLICT', 'state version conflict');
        };
        return fn(wrapped);
      }, opts)
  };
  const { port, close } = await startTestServer({ repo: sabotaged });
  t.after(close);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent()
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'STATE_VERSION_CONFLICT');
  assert.equal(res.json.error.retryable, true);
  const raw = storage.data.get('evlog');
  const entries = raw === undefined ? [] : JSON.parse(raw);
  assert.equal(entries.length, 0);
});

test('A13 GET /v1/state 成功 / 不存在', async (t) => {
  const { port } = await seeded(t);

  const found = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  assert.equal(found.status, 200);
  assert.equal(found.json.data.state_summary.character_id, CHARACTER_ID);
  assert.equal(found.json.data.state_version, found.json.data.state_summary.state_version);
  assert.equal(found.json.data.updated_at, found.json.data.state_summary.updated_at);

  const storage = createMemoryStorage();
  const emptyRepo = createRepository({ storage, character_id: CHARACTER_ID, clock: () => FIXED_NOW });
  const empty = await startTestServer({ repo: emptyRepo });
  t.after(empty.close);

  const missing = await send({ port: empty.port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('A14 tick dry_run:true → 版本 +1、无写入、无 details', async (t) => {
  const { port, storage } = await seeded(t);
  const before = new Map(storage.data);

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/tick',
    headers: authHeaders(),
    body: { character_id: CHARACTER_ID, now: TICK_NOW, dry_run: true }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.dry_run, true);
  assert.equal(res.json.data.state_version, 1);
  assert.equal('details' in res.json.data, false);
  assert.equal(JSON.stringify(res.json).includes('"details"'), false);
  assert.deepEqual([...storage.data.entries()], [...before.entries()]);
  assert.equal(storage.data.has('evlog'), false);
});

test('A15 admin/reset 三种操作、审计不含状态内容、缺令牌 401', async (t) => {
  const logs = [];
  const storage = createMemoryStorage();
  const repo = createRepository({ storage, character_id: CHARACTER_ID, clock: () => FIXED_NOW });
  await repo.saveState(
    createDefaultState({ character_id: CHARACTER_ID, timezone: 'Asia/Shanghai', now: FIXED_NOW, master_seed_hex: MASTER_SEED }),
    0
  );
  const { port, close } = await startTestServer({
    repo,
    logger: { info: (entry) => logs.push(entry), warn() {} }
  });
  t.after(close);

  const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };

  const resetState = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: adminHeaders,
    body: { character_id: CHARACTER_ID, operation: 'reset_state', now: TICK_NOW }
  });
  assert.equal(resetState.status, 200);
  assert.equal(resetState.json.data.operation, 'reset_state');
  assert.equal(resetState.json.data.accepted_at, TICK_NOW);

  const resetSeed = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: adminHeaders,
    body: { character_id: CHARACTER_ID, operation: 'reset_seed', now: TICK_NOW }
  });
  assert.equal(resetSeed.status, 200);
  assert.equal(resetSeed.json.data.operation, 'reset_seed');

  const correction = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: adminHeaders,
    body: {
      character_id: CHARACTER_ID,
      operation: 'manual_cycle_correction',
      now: TICK_NOW,
      payload: { anchor_at: '2026-11-01T00:00:00.000Z', cycle_length_days: 28 }
    }
  });
  assert.equal(correction.status, 200);
  assert.equal(correction.json.data.operation, 'manual_cycle_correction');

  const futureAnchor = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: adminHeaders,
    body: {
      character_id: CHARACTER_ID,
      operation: 'manual_cycle_correction',
      now: TICK_NOW,
      payload: { anchor_at: '2026-11-10T00:00:00.000Z' }
    }
  });
  assert.equal(futureAnchor.status, 400);
  assert.equal(futureAnchor.json.error.code, 'INVALID_REQUEST');

  const noToken = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: authHeaders(),
    body: { character_id: CHARACTER_ID, operation: 'reset_state', now: TICK_NOW }
  });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'UNAUTHORIZED');

  const audits = logs.filter((entry) => entry.audit === 'admin_reset');
  assert.equal(audits.length, 3);
  for (const entry of audits) {
    assert.equal(typeof entry.operation, 'string');
    assert.equal(typeof entry.at, 'string');
    assert.equal('payload' in entry, false);
    assert.equal('state' in entry, false);
    assert.equal('state_summary' in entry, false);
  }
});

test('A19 响应、错误详情与日志不含种子 / 计数器 / 正文', async (t) => {
  const logs = [];
  const storage = createMemoryStorage();
  const repo = createRepository({ storage, character_id: CHARACTER_ID, clock: () => FIXED_NOW });
  await repo.saveState(
    createDefaultState({ character_id: CHARACTER_ID, timezone: 'Asia/Shanghai', now: FIXED_NOW, master_seed_hex: MASTER_SEED }),
    0
  );
  const { port, close } = await startTestServer({
    repo,
    logger: { info: (entry) => logs.push(entry), warn() {} }
  });
  t.after(close);

  const state = await send({ port, path: `/v1/state/${CHARACTER_ID}`, headers: authHeaders() });
  assert.equal(state.status, 200);
  const summary = state.json.data.state_summary;
  assert.deepEqual(Object.keys(summary.random).sort(), ['algorithm', 'algorithm_version', 'master_seed_id']);
  assert.match(summary.random.master_seed_id, /^[0-9a-f]{8}$/);
  assert.equal(state.text.includes(MASTER_SEED), false);

  const missing = await send({ port, path: '/v1/state/unknown_character', headers: authHeaders() });
  assert.equal(missing.status, 403);

  const bad = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: { ...validEvent(), occurred_at: 'not-a-time' }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.text.includes(MASTER_SEED), false);

  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(MASTER_SEED), false);
  assert.equal(serialized.includes('master_seed_hex'), false);
  assert.equal(serialized.includes('"streams"'), false);
  assert.equal(state.text.includes('"streams"'), false);
});

test('A21 事件 occurred_at 超前 >5min → 钳制到 received_at、warnings 含 FUTURE_OCCURRED_AT、evlog 写钳制值', async (t) => {
  const { port, storage } = await seeded(t);
  const receivedAt = '2026-11-09T09:20:01.000Z';

  const res = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({
      event_id: 'evt_20261109_fu000001',
      idempotency_key: 'evt_20261109_fu000001',
      received_at: receivedAt,
      occurred_at: '2026-11-09T09:26:01.000Z'
    })
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.data.duplicate, false);
  assert.ok(
    res.json.data.diagnostics.warnings.includes('FUTURE_OCCURRED_AT'),
    `warnings=${JSON.stringify(res.json.data.diagnostics.warnings)}`
  );
  const entries = JSON.parse(storage.data.get('evlog'));
  const record = entries.find((entry) => entry.event_id === 'evt_20261109_fu000001');
  assert.equal(record.occurred_at, receivedAt, 'evlog 必须写钳制后的 occurred_at');

  // 边界：恰好 +5min 不钳制、不告警（容差为闭区间）。
  const edge = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: validEvent({
      event_id: 'evt_20261109_fu000002',
      idempotency_key: 'evt_20261109_fu000002',
      received_at: receivedAt,
      occurred_at: '2026-11-09T09:25:01.000Z'
    })
  });
  assert.equal(edge.status, 200);
  assert.equal(edge.json.data.diagnostics.warnings.includes('FUTURE_OCCURRED_AT'), false);
});
