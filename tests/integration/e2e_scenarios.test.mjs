/**
 * 15 §4.2 / §5.8：E01–E07 七个端到端场景（G5 验收）。
 *
 * 走真实插件入口（setup + 四个工具 + 两个钩子）+ 真实 04 仓库（内存存储）；
 * 睡眠类场景直接写 v0 状态构造，不绕过状态校验。
 *
 * 注意：`observe` 不接受 `event_id`，事件标识由
 * `SHA-256(conversation_id|sender_id|occurred_at|text_hash)` 前 24 位派生（13 §5.3），
 * 因此重复事件用完全相同的入参复现，队列断言用响应回传的 `event_id`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultState } from '../../lib/core/models.mjs';
import { createChatScopedRepo } from '../../lib/storage/plugin-storage.mjs';
import { pendingQueue } from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/tools.mjs';
import { POLICIES } from '../../lib/modules/delivery/policy.mjs';
import { urgencyOf } from '../../lib/modules/delivery/urgency.mjs';
import { AFFECTION_TIERS } from '../../lib/modules/behavior/index.mjs';
import {
  CHARACTER_ID,
  FIXED_SEED,
  PRIMARY_CHAT,
  T0,
  eventParams,
  install,
  makeCtx
} from './_plugin_helpers.mjs';

const SLEEP_START = '2026-11-09T14:00:00.000Z';
const SLEEP_NOW = '2026-11-09T14:10:00.000Z';
const PLANNED_WAKE = '2026-11-09T23:30:00.000Z';

function seedRepo(harness) {
  return createChatScopedRepo({
    storage: harness.storage,
    characterId: CHARACTER_ID,
    chatId: PRIMARY_CHAT,
    primaryChatId: PRIMARY_CHAT,
    clock: () => T0
  });
}

async function seedSleeping(harness) {
  const base = createDefaultState({
    character_id: CHARACTER_ID,
    timezone: 'Asia/Shanghai',
    now: SLEEP_START,
    master_seed_hex: FIXED_SEED
  });
  const state = {
    ...base,
    updated_at: SLEEP_START,
    last_tick_at: SLEEP_START,
    sleep: {
      ...base.sleep,
      state: 'sleeping',
      state_since: SLEEP_START,
      sleep_started_at: SLEEP_START,
      last_wake_at: null,
      planned_wake_at: PLANNED_WAKE,
      sleep_debt: 0.2,
      sleep_quality: 0.8,
      sleepiness: 0.5,
      interruption_count: 0,
      recovery_progress: 0,
      interrupted_at: null
    }
  };
  const saved = await seedRepo(harness).saveState(state, 0);
  assert.equal(saved.ok, true, `seed sleeping failed: ${saved.code}`);
}

test('E01 普通群消息 → deliver_now，state_version +1（V08）', async () => {
  const harness = makeCtx();
  const { tools } = install(harness.ctx);

  const result = await tools.observe(
    eventParams({ event_type: 'group_message', is_mentioned: false, relationship_tag: 'ordinary', occurred_at: T0 })
  );
  assert.equal(result.ok, true);
  assert.equal(result.state_version, 1);
  assert.equal(result.duplicate, false);
  assert.equal(result.delivery.policy, 'deliver_now');
  assert.ok(POLICIES.includes(result.delivery.policy));
});

test('E02 被 @ → 紧急度 ≥0.60，回复概率与延迟为合法范围/枚举', async () => {
  const harness = makeCtx();
  const { tools } = install(harness.ctx);

  const result = await tools.observe(eventParams({ occurred_at: T0, is_mentioned: true }));
  assert.equal(result.ok, true);
  assert.equal(result.delivery.policy, 'deliver_now');

  // 15 §4.2 E02：urgency 取自 11 §5.1。11 §4.1 明确 delivery 不输出 `urgency`，
  // 因此用冻结基表核对下限，再由 wake_cost 反证该 urgency 已参与策略计算。
  const urgency = urgencyOf({ event_type: 'mention', is_mentioned: true });
  assert.ok(urgency >= 0.6, `urgency=${urgency}`);
  assert.equal(result.delivery.urgency, undefined);
  const sleepSummary = result.state_summary.sleep;
  const expectedCost =
    Math.round(
      (0.30 + 0.45 * sleepSummary.sleep_debt + 0.30 * sleepSummary.sleepiness - 0.20 * urgency) * 1e6
    ) / 1e6;
  assert.ok(Math.abs(result.delivery.wake_cost - expectedCost) <= 1e-6, `wake_cost=${result.delivery.wake_cost}`);

  const context = result.behavior_context;
  assert.ok(context.reply_likelihood >= 0 && context.reply_likelihood <= 1);
  assert.equal(Math.round(context.reply_likelihood * 1e6) / 1e6, context.reply_likelihood);

  const range = context.response_latency_range_seconds;
  assert.ok(Array.isArray(range) && range.length === 2);
  assert.ok(Number.isInteger(range[0]) && Number.isInteger(range[1]));
  assert.ok(range[0] <= range[1]);
});

test('E03 睡眠中冲突 → urgent_interrupt + waking_up，版本只 +1', async () => {
  const harness = makeCtx();
  await seedSleeping(harness);
  const { tools } = install(harness.ctx);

  const result = await tools.observe(
    eventParams({ event_type: 'conflict', is_mentioned: true, relationship_tag: 'intimate', occurred_at: SLEEP_NOW })
  );

  assert.equal(result.ok, true);
  assert.equal(result.delivery.policy, 'urgent_interrupt');
  assert.equal(result.state_version, 1);
  assert.equal(result.state_summary.sleep.state, 'waking_up');
});

test('E04 安慰事件 → stress 不升，一个 chunk 后 affection_expression 不低于事件前', async () => {
  const harness = makeCtx();
  const { tools } = install(harness.ctx);

  const before = await tools.observe(eventParams({ occurred_at: T0 }));
  assert.equal(before.ok, true);
  const stressBefore = before.state_summary.stress.level;
  const affectionBefore = before.behavior_context.affection_expression;

  const event = await tools.observe(
    eventParams({
      event_type: 'comfort_received',
      is_mentioned: true,
      relationship_tag: 'intimate',
      occurred_at: '2026-11-09T09:10:00.000Z'
    })
  );
  assert.equal(event.ok, true);
  assert.ok(event.state_summary.stress.level <= stressBefore + 1e-6);

  // 15 §4.2 E04：事件当轮 dt=0、mood 不变，必须显式推进至少 1 个 chunk（≥3600 s）后再读。
  const ticked = await tools.tick({ now: '2026-11-09T10:30:00.000Z' });
  assert.equal(ticked.ok, true);
  assert.equal(ticked.dry_run, false);

  const after = await tools.state({});
  assert.equal(after.ok, true);
  const affectionAfter = after.behavior_context.affection_expression;
  assert.ok(
    AFFECTION_TIERS.indexOf(affectionAfter) >= AFFECTION_TIERS.indexOf(affectionBefore),
    `affection ${affectionBefore} -> ${affectionAfter}`
  );

  const { hooks } = install(harness.ctx);
  const injected = await hooks['before-context']({});
  assert.equal(typeof injected.context, 'string');
  assert.ok(injected.context.length > 0);
});

test('E05 同 event_id 连发 3 次 → 只推进一次，evlog 不重复', async () => {
  const harness = makeCtx();
  const { tools } = install(harness.ctx);
  const params = eventParams({ occurred_at: T0 });

  const first = await tools.observe(params);
  const second = await tools.observe(params);
  const third = await tools.observe(params);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.state_version, first.state_version);
  assert.equal(third.state_version, first.state_version);

  const evlog = harness.storage.json('evlog');
  const matched = evlog.filter((entry) => entry.event_id === first.event_id);
  assert.equal(matched.length, 1);
});

test('E06 引擎不可用 → DEGRADED，不写状态', async () => {
  const harness = makeCtx();
  await seedSleeping(harness);
  const before = harness.storage.raw('state');
  const { tools, hooks } = install(harness.ctx);

  const result = await tools.observe(
    eventParams({ event_type: 'conflict', occurred_at: SLEEP_NOW }),
    { signal: AbortSignal.abort() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEGRADED');
  assert.equal(harness.storage.raw('state'), before);

  const injected = await hooks['before-context']({});
  assert.equal(typeof injected.context, 'string');
});

test('E07 睡眠中同会话 3 条群消息 → silent_ignore + coalesced_into，队列只剩 1 条', async () => {
  const harness = makeCtx();
  await seedSleeping(harness);
  const { tools, settings } = install(harness.ctx);

  // 15 §4.2 E07：同会话 3 条、间隔 <600 s（窗口 (now-600s, now] 必须覆盖前两条）。
  const first = await tools.observe(
    eventParams({
      event_type: 'group_message',
      is_mentioned: false,
      relationship_tag: 'ordinary',
      occurred_at: '2026-11-09T14:10:00.000Z'
    })
  );
  const second = await tools.observe(
    eventParams({
      event_type: 'group_message',
      is_mentioned: false,
      relationship_tag: 'ordinary',
      occurred_at: '2026-11-09T14:14:00.000Z'
    })
  );
  const third = await tools.observe(
    eventParams({
      event_type: 'group_message',
      is_mentioned: false,
      relationship_tag: 'ordinary',
      occurred_at: '2026-11-09T14:18:00.000Z'
    })
  );

  assert.equal(first.delivery.policy, 'queue_until_awake');
  assert.equal(second.delivery.policy, 'queue_until_awake');
  assert.equal(third.delivery.policy, 'silent_ignore');
  assert.equal(third.delivery.coalesced_into.merged_count, 3);
  assert.equal(third.delivery.coalesced_into.event_id, first.event_id);
  assert.ok(third.delivery.reason_codes.includes('sleeping'));
  assert.ok(third.delivery.reason_codes.includes('coalesced'));

  const queue = pendingQueue(harness.ctx, settings);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].event_id, first.event_id);
  assert.equal(queue[0].merged_count, 3);
});

test('E08 排队项过 expires_at → 入口清理，队列为空且 evlog 含 expired', async () => {
  const harness = makeCtx();
  await seedSleeping(harness);
  const { tools, settings } = install(harness.ctx);

  const queued = await tools.observe(
    eventParams({
      event_type: 'group_message',
      is_mentioned: false,
      relationship_tag: 'ordinary',
      occurred_at: SLEEP_NOW
    })
  );
  assert.equal(queued.delivery.policy, 'queue_until_awake');

  // 13 §5.9 / P-13-07：队列项必须带 11 §5.6 的过期判定时刻。
  const queue = pendingQueue(harness.ctx, settings);
  assert.equal(queue.length, 1);
  const expiresAt = queue[0].expires_at;
  assert.equal(typeof expiresAt, 'string');
  assert.equal(queue[0].deliver_after, PLANNED_WAKE);
  assert.equal(queue[0].event_type, 'group_message');
  assert.equal(typeof queue[0].source_key, 'string');

  // 推进到 expires_at 之后：tick 入口清理过期项，队列为空并补写 evlog。
  const tick = await tools.tick({ now: '2026-11-11T00:00:00.000Z' });
  assert.equal(tick.ok, true);
  assert.equal(pendingQueue(harness.ctx, settings).length, 0);

  const expired = harness.storage.json('evlog').filter((entry) => {
    const codes = Array.isArray(entry.reason_codes) ? entry.reason_codes : [];
    return codes.includes('expired');
  });
  assert.equal(expired.length, 1, 'evlog 必须保留一条 expired 记录（11 §5.7）');
  assert.equal(expired[0].policy, 'silent_ignore');
  assert.equal(expired[0].event_type, 'group_message');
  assert.ok(expired[0].event_id.startsWith('exp_'));
});
