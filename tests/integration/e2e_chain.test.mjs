/**
 * 15 §4.1 / §8 V06：信息流端到端链路（插件 → 持久化 → HTTP 服务 → 重启）。
 *
 * 同一份存储上先后跑：
 *   1. 插件 `observe`（真实引擎 + 真实 04 仓库）
 *   2. `12` HTTP 服务（真实 04 仓库、真实端口）：state / events / 幂等 / tick dry_run / admin reset
 *   3. 插件"重启"（新 ctx、同一 storage）读回同一份权威状态
 *
 * 同时校验：响应与日志不含完整种子；`meta` 只存 `master_seed_id`；dry_run 不写状态。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRepository } from '../../lib/storage/repository.mjs';
import { pendingQueue } from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/tools.mjs';
import {
  CHARACTER_ID,
  FIXED_SEED,
  T0,
  eventParams,
  install,
  makeCtx
} from './_plugin_helpers.mjs';
import {
  ADMIN_TOKEN,
  authHeaders,
  send,
  startTestServer,
  validEvent
} from '../unit/_api_helpers.mjs';

const TICK_NOW = '2026-11-09T11:00:00.000Z';
const RESET_NOW = '2026-11-09T11:10:00.000Z';

test('信息流：插件 observe → HTTP state/events/幂等/tick/admin → 重启读回一致（V05）', async (t) => {
  const harness = makeCtx();
  const { tools: pluginTools, settings } = install(harness.ctx);

  const observed = await pluginTools.observe(
    eventParams({ event_type: 'group_message', is_mentioned: false, relationship_tag: 'ordinary', occurred_at: T0 })
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.state_version, 1);
  assert.equal(pendingQueue(harness.ctx, settings).length, 0);

  const repo = createRepository({
    storage: harness.storage,
    character_id: CHARACTER_ID,
    clock: () => T0
  });
  const { port, close } = await startTestServer({ repo });
  t.after(close);

  // ② 插件写下的状态可被 HTTP 服务读到（同一条信息流，无第二状态源）。
  const stateRes = await send({
    port,
    method: 'GET',
    path: `/v1/state/${CHARACTER_ID}`,
    headers: authHeaders()
  });
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.json.data.state_version, 1);
  assert.equal(stateRes.json.data.state_summary.state_version, 1);
  assert.ok(!stateRes.text.includes(FIXED_SEED), 'state 响应不得含完整种子');

  // ③ HTTP 事件推进同一条状态。
  const eventBody = validEvent({ event_id: 'evt_chain_0001', idempotency_key: 'idem_chain_0001' });
  const eventRes = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: eventBody
  });
  assert.equal(eventRes.status, 200);
  assert.equal(eventRes.json.data.duplicate, false);
  assert.equal(eventRes.json.data.state_version, 2);

  // ④ 同一幂等键重放：版本与时间戳都不变。
  const replay = await send({
    port,
    method: 'POST',
    path: '/v1/events',
    headers: authHeaders(),
    body: eventBody
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.duplicate, true);
  assert.equal(replay.json.data.state_version, 2);
  assert.equal(replay.json.data.processed_at, eventRes.json.data.processed_at);

  // ⑤ dry_run 只算不写。
  const dry = await send({
    port,
    method: 'POST',
    path: '/v1/tick',
    headers: authHeaders(),
    body: { character_id: CHARACTER_ID, now: TICK_NOW, dry_run: true }
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.data.dry_run, true);
  const afterDry = JSON.parse(harness.storage.raw('state'));
  assert.equal(afterDry.state_version, 2);

  // ⑥ 管理重置：允许在引擎侧逃生，版本继续单调。
  const reset = await send({
    port,
    method: 'POST',
    path: '/v1/admin/reset',
    headers: authHeaders(ADMIN_TOKEN),
    body: {
      character_id: CHARACTER_ID,
      operation: 'reset_state',
      now: RESET_NOW
    }
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.data.operation, 'reset_state');
  const resetVersion = reset.json.data.state_version;
  assert.equal(typeof resetVersion, 'number');

  // ⑦ 插件"重启"：新 ctx、同一 storage，读回的是同一份权威状态。
  const restarted = makeCtx({ storage: harness.storage });
  const { tools: restartedTools } = install(restarted.ctx);
  const readBack = await restartedTools.state({});
  assert.equal(readBack.ok, true);
  assert.equal(readBack.state_version, resetVersion);

  // ⑧ 隐私：日志与 meta 不得出现完整种子。
  for (const entry of [...harness.logs, ...restarted.logs]) {
    assert.ok(!JSON.stringify(entry).includes(FIXED_SEED), '日志不得含完整种子');
  }
  const metaRaw = harness.storage.raw('meta');
  if (metaRaw !== null) {
    assert.ok(!metaRaw.includes(FIXED_SEED), 'meta 不得含完整种子');
  }
  assert.ok(harness.storage.raw('state').includes(FIXED_SEED), '完整种子只允许留在 state.random');
});
