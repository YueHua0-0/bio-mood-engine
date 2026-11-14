import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { normalizeEvent, buildEventFromMessage } from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/events.mjs';
import {
  normalizeConfig,
  collectSchemaErrors
} from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/manifest.mjs';
import { FICTION_DISCLAIMER } from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/hooks.mjs';
import { createTools } from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/tools.mjs';
import { setup } from '../../plugins/bio-mood-engine/index.mjs';
import {
  makeCtx,
  install,
  eventParams,
  actorHash,
  ADMIN_ACTOR,
  PRIMARY_CHAT,
  OTHER_CHAT,
  FIXED_SEED,
  T0
} from './_plugin_helpers.mjs';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

test('P-13-10 入口契约：registerTool 对象式 + 单参钩子（对齐官方样例）', async () => {
  const h = makeCtx();
  const defs = [];
  const hookHandlers = {};
  setup({
    apiVersion: 2,
    ctx: h.ctx,
    registerTool(def) {
      defs.push(def);
    },
    registerHook(name, handler) {
      hookHandlers[name] = handler;
    }
  });

  assert.deepEqual(defs.map((def) => def.id), ['observe', 'state', 'tick', 'admin']);
  assert.equal(new Set(defs.map((def) => def.id)).size, 4, '工具 id 不得重复');
  for (const def of defs) {
    assert.match(def.id, /^[a-z][a-z0-9-]{0,19}$/, `${def.id} 超出宿主 id 规则`);
    assert.ok(def.description.length >= 1 && def.description.length <= 2000, `${def.id} description 长度`);
    assert.equal(def.parameters?.type, 'object', `${def.id} parameters 必须是 object Schema`);
    assert.equal(def.parameters.additionalProperties, false, `${def.id} 必须显式拒绝未知参数`);
    const errors = [];
    collectSchemaErrors(def.parameters, `parameters.${def.id}`, errors);
    assert.deepEqual(errors, [], `${def.id} parameters 越出宿主受限子集`);
  }

  // execute 只接收宿主 ctx 与 args，返回值只能是字符串或 {content,isError}。
  const observed = await defs[0].execute(h.ctx, eventParams());
  assert.equal(typeof observed.content, 'string');
  assert.equal(JSON.parse(observed.content).ok, true);

  // 钩子按宿主形状调用：单参 ctx，before-context 带 ctx.message、after-response 带 ctx.text。
  const hookCtx = { ...h.ctx, message: { text: '在吗' }, text: 'RESPOND: 你好' };
  const injected = await hookHandlers['before-context'](hookCtx);
  assert.equal(typeof injected.context, 'string');
  assert.ok(injected.context.includes(FICTION_DISCLAIMER));
  assert.deepEqual(hookHandlers['after-response'](hookCtx), {});
});

test('P05a adminActorIds 为空时 tick / admin 均 UNAUTHORIZED，state_version 不变', async () => {
  const h = makeCtx({ config: { adminActorIds: [] } });
  const { tools } = install(h.ctx);
  const first = await tools.observe(eventParams());
  assert.equal(first.ok, true);
  const before = h.storage.raw('state');

  const tick = await tools.tick({ now: '2026-11-09T10:00:00.000Z' });
  assert.equal(tick.code, 'UNAUTHORIZED');
  const bind = await tools.admin({ action: 'bind_primary' });
  assert.equal(bind.code, 'UNAUTHORIZED');
  const reset = await tools.admin({ action: 'reset_state', confirm: true });
  assert.equal(reset.code, 'UNAUTHORIZED');

  assert.equal(h.storage.raw('state'), before, '未授权不得改动 state');
});

test('P05b sha256(actor.id) 命中 adminActorIds 后 tick 放行并 +1', async () => {
  const h = makeCtx();
  assert.deepEqual(h.config.adminActorIds, [actorHash(ADMIN_ACTOR)]);
  const { tools } = install(h.ctx);
  const first = await tools.observe(eventParams());
  assert.equal(first.state_version, 1);

  const tick = await tools.tick({ now: '2026-11-09T10:00:00.000Z' });
  assert.equal(tick.ok, true);
  assert.equal(tick.state_version, 2);
  assert.equal(tick.dry_run, false);
});

test('P-13-17 设置填 wxid 明文即可授权；清空后沿用落盘白名单', async () => {
  const wxid = 'wxid_b47wq155j24u22';
  const h = makeCtx({ actorId: wxid, config: { adminActorIds: wxid } });
  const { tools } = install(h.ctx);
  assert.equal((await tools.observe(eventParams())).ok, true);
  assert.equal((await tools.tick({ now: '2026-11-09T10:00:00.000Z' })).ok, true);

  // 设置被清空：沿用 observe 时落盘的 meta.admin_hashes，tick 仍放行（「留空不修改」）。
  h.config.adminActorIds = '';
  assert.equal((await tools.tick({ now: '2026-11-09T11:00:00.000Z' })).ok, true);

  // 全新环境 + 留空：从未落盘过非空值，保持 fail-closed。
  const h2 = makeCtx({ actorId: wxid, config: { adminActorIds: '' } });
  const tools2 = install(h2.ctx).tools;
  await tools2.observe(eventParams());
  assert.equal((await tools2.tick({ now: '2026-11-09T10:00:00.000Z' })).code, 'UNAUTHORIZED');
});


test('P09 同一消息标准化两次：text_hash 64 / sender_id 12 / event_id 24，且完全相等', () => {
  const params = eventParams();
  const a = normalizeEvent(params);
  const b = normalizeEvent(params);
  assert.equal(a.event.payload.text_hash.length, 64);
  assert.equal(a.event.source.sender_id.length, 12);
  assert.equal(a.event_id.length, 24);
  assert.deepEqual(a, b);
  assert.equal(a.idempotency_key, a.event_id);
  assert.match(a.source_key, new RegExp(`^wechat:${PRIMARY_CHAT}:`));
});

test('P-13-12 模型只传 text + event_type：入口内哈希、ctx 派生标识、正文不落盘', async () => {
  const text = '今天开会好累-不要落盘-P1312';
  const h = makeCtx();
  const { tools } = install(h.ctx);

  const first = await tools.observe({ event_type: 'group_message', text });
  assert.equal(first.ok, true);
  assert.equal(first.state_version, 1);

  // 入口按 13 §5.3 从 ctx 派生 occurred_at / conversation_id / sender_id，并只把正文哈希一次。
  const expected = buildEventFromMessage({
    text,
    sender_id: actorHash(ADMIN_ACTOR),
    event_type: 'group_message',
    occurred_at: T0,
    conversation_id: PRIMARY_CHAT
  });
  assert.equal(first.event_id, expected.event_id);
  assert.equal(expected.event.payload.text, undefined);
  assert.equal(
    expected.event.payload.text_hash,
    createHash('sha256').update(text, 'utf8').digest('hex')
  );
  assert.match(expected.event.payload.text_hash, /^[0-9a-f]{64}$/);
  assert.equal(expected.event.source.sender_id, actorHash(ADMIN_ACTOR));
  assert.equal(expected.event.source.conversation_id, PRIMARY_CHAT);
  assert.equal(expected.event.source.relationship_tag, 'unknown', '缺省关系标签按 unknown');

  // 同一句原文再提交一次：哈希稳定 → 幂等命中，版本不推进。
  const again = await tools.observe({ event_type: 'group_message', text });
  assert.equal(again.duplicate, true);
  assert.equal(again.state_version, first.state_version);

  // 正文不得进入任何持久化、日志或工具返回。
  assert.doesNotMatch(JSON.stringify(h.storage.dump()), /不要落盘|P1312/);
  assert.doesNotMatch(JSON.stringify(h.logs), /不要落盘|P1312/);
  assert.doesNotMatch(JSON.stringify(first), /不要落盘|P1312/);
  assert.doesNotMatch(JSON.stringify(again), /不要落盘|P1312/);
});

test('P-13-15 宿主保存设置后无需重载插件：每次调用读最新 ctx.config()', async () => {
  // 复现宿主现场：插件在设置为空时加载，随后用户在设置页保存 primaryChatId。
  const h = makeCtx({ config: { primaryChatId: '' } });
  const { tools } = install(h.ctx);

  const before = await tools.state();
  assert.equal(before.code, 'DEGRADED');
  assert.ok(before.details.warnings.includes('PRIMARY_UNBOUND'));

  h.config.primaryChatId = PRIMARY_CHAT;

  const after = await tools.state();
  assert.equal(after.ok, true, '保存设置后应立即生效，不依赖插件重载');
  assert.equal(after.code, undefined);
});

test('P10 同 event_id 连续 observe 两次：duplicate:true、版本不变、evlog 不重复', async () => {
  const h = makeCtx();
  const { tools } = install(h.ctx);
  const first = await tools.observe(eventParams());
  const second = await tools.observe(eventParams());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.state_version, first.state_version);
  assert.equal(second.state_summary, null);
  const evlog = h.storage.json('evlog');
  assert.equal(evlog.length, 1);
  assert.equal(evlog[0].event_id, first.event_id);
});

test('P11 扫描 storage 与日志：无正文、无原始账号、无令牌、无完整种子', async () => {
  const text = '绝密消息正文-不要落盘-7f3c';
  const rawSender = 'raw_sender_ABC_9876';
  const token = 'tok_live_SECRET_123';
  const h = makeCtx({ config: { engineRemoteToken: token } });
  const { tools } = install(h.ctx);

  const built = buildEventFromMessage({
    text,
    sender_key: rawSender,
    event_type: 'group_message',
    occurred_at: T0,
    conversation_id: PRIMARY_CHAT,
    relationship_tag: 'ordinary'
  });
  // 标准事件不是 observe 入参；用原始参数走真实入口。
  const observed = await tools.observe({
    event_type: 'group_message',
    occurred_at: T0,
    conversation_id: PRIMARY_CHAT,
    sender_id: built.event.source.sender_id,
    relationship_tag: 'ordinary',
    text_hash: built.event.payload.text_hash
  });
  assert.equal(observed.ok, true);

  const state = h.storage.json('state');
  const seed = state.random.master_seed_hex;
  assert.equal(seed, FIXED_SEED);
  const dump = h.storage.dump();
  for (const [key, value] of Object.entries(dump)) {
    assert.doesNotMatch(value, /绝密消息正文/, `storage.${key} 不得含正文`);
    assert.doesNotMatch(value, /raw_sender_ABC_9876/, `storage.${key} 不得含原始账号`);
    assert.doesNotMatch(value, /tok_live_SECRET_123/, `storage.${key} 不得含令牌`);
    if (key !== 'state') {
      assert.doesNotMatch(value, new RegExp(seed), `storage.${key} 不得含完整种子`);
    }
  }
  const logs = JSON.stringify(h.logs);
  assert.doesNotMatch(logs, /绝密消息正文|raw_sender_ABC_9876|tok_live_SECRET_123/);
  assert.doesNotMatch(logs, new RegExp(seed));
  assert.doesNotMatch(JSON.stringify(observed), /绝密消息正文|raw_sender_ABC_9876/);
});

test('P12 非 primaryChatId：observe/state 均 DEGRADED，不写不推进，冷快照为 null', async () => {
  const h = makeCtx({ chatId: OTHER_CHAT });
  const { tools } = install(h.ctx);

  const observed = await tools.observe(eventParams());
  assert.equal(observed.ok, false);
  assert.equal(observed.code, 'DEGRADED');
  assert.ok(observed.details.warnings.includes('NON_PRIMARY_READONLY'));
  assert.equal(observed.cold_snapshot, null);

  const state = await tools.state();
  assert.equal(state.code, 'DEGRADED');
  assert.ok(state.details.warnings.includes('NON_PRIMARY_READONLY'));
  assert.deepEqual(h.storage.keys(), [], '非主聊天不得写任何键');

  const unbound = makeCtx({ config: { primaryChatId: '' } });
  const unboundTools = install(unbound.ctx).tools;
  const result = await unboundTools.observe(eventParams());
  assert.equal(result.code, 'DEGRADED');
  assert.ok(result.details.warnings.includes('PRIMARY_UNBOUND'));
});

test('P-13-20 多主会话设置在保存校验时失效：FASTCFG_INVALID + PRIMARY_UNBOUND，零写入', async () => {
  const h = makeCtx({ config: { primaryChatId: `${PRIMARY_CHAT},${OTHER_CHAT}` } });
  const { tools, settings } = install(h.ctx);
  assert.equal(settings.primaryChatId, '');
  assert.deepEqual(settings.primaryChatIds, []);

  const configError = h.logs.find((entry) => entry.code === 'FASTCFG_INVALID');
  assert.equal(configError?.errors?.[0]?.field, 'primaryChatId');
  assert.match(configError?.errors?.[0]?.message ?? '', /v1 只支持单主会话；多主会话需账号级共享存储/);

  for (const result of [await tools.observe(eventParams()), await tools.state()]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DEGRADED');
    assert.ok(result.details.warnings.includes('PRIMARY_UNBOUND'));
  }
  assert.deepEqual(h.storage.keys(), [], '非法多主会话不得退化成多写者或写入任何键');
});

test('P13 键名合法、单次 ≤40 次操作、set 抛错降级、超限 DEGRADED 且下次 observe 淘汰', async () => {
  const h = makeCtx();
  const { tools } = install(h.ctx);

  let before = h.storage.log.length;
  const first = await tools.observe(eventParams());
  assert.equal(first.ok, true);
  assert.ok(h.storage.log.length - before <= 40, `observe 操作数 ${h.storage.log.length - before}`);

  before = h.storage.log.length;
  const state = await tools.state();
  assert.equal(state.ok, true);
  assert.ok(h.storage.log.length - before <= 40, `state 操作数 ${h.storage.log.length - before}`);

  before = h.storage.log.length;
  const tick = await tools.tick({ now: '2026-11-09T10:00:00.000Z' });
  assert.equal(tick.ok, true);
  assert.ok(h.storage.log.length - before <= 40, `tick 操作数 ${h.storage.log.length - before}`);

  for (const key of h.storage.keys()) assert.match(key, KEY_RE);

  // storage.set 抛错：必须 DEGRADED，不得把异常抛给宿主。
  const failing = makeCtx();
  const failingTools = install(failing.ctx).tools;
  const originalSet = failing.storage.set;
  failing.storage.set = async () => {
    const err = new Error('disk full');
    err.code = 'STORAGE_FAILED';
    throw err;
  };
  const degraded = await failingTools.observe(eventParams());
  assert.equal(degraded.ok, false);
  assert.equal(degraded.code, 'DEGRADED');
  failing.storage.set = originalSet;
  const recovered = await failingTools.observe(eventParams());
  assert.equal(recovered.ok, true, '存储恢复后聊天应继续');

  // 构造 >64 KiB：state + 16 KiB evlog + 32 KiB idem + 大量 meta.snapshots。
  const meta = h.storage.json('meta') ?? {};
  meta.snapshots = Array.from({ length: 30 }, (_, i) => ({
    state_version: i + 1,
    captured_at: T0,
    summary: { padding: 'x'.repeat(900) }
  }));
  await h.storage.set('meta', JSON.stringify(meta));
  const evlog = Array.from({ length: 120 }, (_, i) => ({
    event_id: `evt_${i}`,
    event_type: 'group_message',
    occurred_at: T0,
    padding: 'y'.repeat(80)
  }));
  await h.storage.set('evlog', JSON.stringify(evlog));
  const idem = Array.from({ length: 300 }, (_, i) => ({
    key: `k_${i}`,
    character_id: 'whale_character',
    state_version: 1,
    expires_at: '2099-01-01T00:00:00.000Z',
    padding: 'z'.repeat(60)
  }));
  await h.storage.set('idem', JSON.stringify(idem));

  const over = await tools.state();
  assert.equal(over.code, 'DEGRADED');
  assert.ok(over.details.warnings.includes('STORAGE_OVER_BUDGET'));

  const snapshotsBefore = (h.storage.json('meta') ?? {}).snapshots?.length ?? 0;
  const afterEvict = await tools.observe(eventParams({ text_hash: 'd'.repeat(64) }));
  assert.ok(afterEvict.ok || afterEvict.code === 'DEGRADED', '超限后不得抛出');
  const snapshotsAfter = (h.storage.json('meta') ?? {}).snapshots?.length ?? 0;
  assert.ok(snapshotsAfter < snapshotsBefore, 'ensureReady 必须淘汰 meta.snapshots');
});

test('P14 enabled=false：三工具 DEGRADED、两钩子空注入、版本不变（V06）', async () => {
  const h = makeCtx({ config: { enabled: false } });
  const { tools, hooks } = install(h.ctx);
  for (const result of [
    await tools.observe(eventParams()),
    await tools.state(),
    await tools.tick({ now: '2026-11-09T10:00:00.000Z' })
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DEGRADED');
  }
  assert.deepEqual(await hooks['before-context']({}), { context: '' });
  assert.deepEqual(hooks['after-response']({ text: 'RESPOND: 你好' }), {});
  assert.deepEqual(h.storage.keys(), [], '关闭时不得初始化或写入');
});

test('P-13-02 ensureReady 期间 abort 映射为 DEGRADED，日志 migrated:true 且不含状态/种子', async () => {
  const h = makeCtx();
  const bootstrap = install(h.ctx).tools;
  await bootstrap.observe(eventParams());

  const state = h.storage.json('state');
  state.schema_version = 1;
  await h.storage.set('state', JSON.stringify(state));

  const controller = new AbortController();
  const originalSet = h.storage.set;
  h.storage.set = async (key, value) => {
    if (key === 'state' && !controller.signal.aborted) controller.abort();
    return originalSet(key, value);
  };

  const settings = normalizeConfig(h.config).settings;
  const tools = createTools({
    ctx: h.ctx,
    settings,
    clock: () => T0,
    logger: h.logger,
    migrations: { target_version: 2, steps: { 1: [(s) => s] } }
  });

  const result = await tools.observe(
    eventParams({ text_hash: 'e'.repeat(64) }),
    { signal: controller.signal }
  );
  assert.equal(result.code, 'DEGRADED');
  const abortLog = h.logs.find((entry) => entry.code === 'ABORTED_AFTER_READY');
  assert.ok(abortLog, '必须记录 ABORTED_AFTER_READY');
  assert.equal(abortLog.migrated, true);
  assert.deepEqual(Object.keys(abortLog).sort(), ['code', 'migrated']);
  assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(FIXED_SEED));
  assert.doesNotMatch(JSON.stringify(h.logs), /schema_version|"mood"|"sleep"/);

  h.storage.set = originalSet;
});

test('P13-02 补充：主聊天/未绑定配置不伪造 primaryChatId', async () => {
  const h = makeCtx({ chatId: OTHER_CHAT });
  const { tools } = install(h.ctx);
  const tick = await tools.tick({ now: '2026-11-09T10:00:00.000Z' });
  assert.equal(tick.code, 'DEGRADED');
  assert.ok(tick.details.warnings.includes('NON_PRIMARY_READONLY'));
  assert.deepEqual(h.storage.keys(), []);
});

/* ---------------------------------- E-B ---------------------------------- */
/*
 * 验证扁平设置 cyclePainSensitivity / cycleLutealSensitivity / cycleMoodVariability /
 * cycleIntimacyVariability → config.cycle.profile 的运行时透传。
 *
 * 口径（二期审查要求）：
 * - 只观察 `state.mood`：九维 `phase_vector` 不进入持久化 state，不能拿 `state.cycle` 证明 profile 生效。
 * - 方向来自 phase.mjs 的实际调制路径与冻结映射，不假设四个参数都推动同一个维度。
 *   pain_sensitivity → pain_load（仅映射 physical_comfort / energy）；
 *   luteal_sensitivity → 黄体分量 × 焦虑/易怒增量；
 *   mood_variability → 焦虑/易怒/正性情感整体；
 *   intimacy_variability → intimacy_need_delta。
 * - 固定种子 + 12h 步长 × 56 步（672h = 28 天），覆盖四个周期相位（含 luteal_like）。
 */

const EB_PROFILE_KEYS = Object.freeze([
  'cyclePainSensitivity',
  'cycleLutealSensitivity',
  'cycleMoodVariability',
  'cycleIntimacyVariability'
]);
const EB_STEP_HOURS = 12;
const EB_TICKS = 56;

function ebSequenceKey(overrides) {
  return EB_PROFILE_KEYS.map(
    (key) => `${key}=${typeof overrides[key]}:${String(overrides[key])}`
  ).join('|');
}

const EB_SEQUENCE_CACHE = new Map();

/** 确定性执行：同一组设置整文件只跑一次。 */
function profileSequence(overrides = {}) {
  const key = ebSequenceKey(overrides);
  if (!EB_SEQUENCE_CACHE.has(key)) {
    EB_SEQUENCE_CACHE.set(key, executeProfileSequence(overrides));
  }
  return EB_SEQUENCE_CACHE.get(key);
}

async function executeProfileSequence(overrides) {
  const h = makeCtx({ config: overrides });
  const { tools } = install(h.ctx);
  const first = await tools.observe(eventParams());
  assert.equal(first.ok, true, 'observe 必须成功');
  const state = h.storage.json('state');
  const states = [state];
  const phases = [state.cycle.phase];
  for (let step = 1; step <= EB_TICKS; step += 1) {
    const now = new Date(Date.parse(T0) + step * EB_STEP_HOURS * 3600 * 1000).toISOString();
    const tick = await tools.tick({ now });
    assert.equal(tick.ok, true, `tick ${step} 必须成功，实际 ${tick.code ?? 'unknown'}`);
    const next = h.storage.json('state');
    states.push(next);
    phases.push(next.cycle.phase);
  }
  return { h, tools, states, phases };
}

/** 按维度求差：`to - from`。 */
function moodDiff(from, to) {
  const diff = {};
  for (const dim of Object.keys(from.mood)) diff[dim] = to.mood[dim] - from.mood[dim];
  return diff;
}

function assertDirectionalDiff(diff, { targets, others, targetFloor }, label) {
  for (const [dim, sign] of Object.entries(targets)) {
    assert.ok(
      diff[dim] * sign > targetFloor,
      `${label}：${dim} 预期${sign > 0 ? '上升' : '下降'}超过 ${targetFloor}，实际 Δ=${diff[dim]}`
    );
  }
  for (const dim of others) {
    assert.ok(
      Math.abs(diff[dim]) < 0.01,
      `${label}：非目标维 ${dim} 应保持稳定（|Δ| < 0.01），实际 Δ=${diff[dim]}`
    );
  }
}

const EB2_CASES = Object.freeze([
  {
    key: 'cyclePainSensitivity',
    // pain_load × pain_sensitivity；冻结映射只触及 physical_comfort / energy。
    targets: { physical_comfort: -1, energy: -1 },
    others: ['stability', 'sensitivity', 'social_drive', 'closeness_need', 'stress'],
    targetFloor: 0.005
  },
  {
    key: 'cycleLutealSensitivity',
    // 黄体分量 × luteal_sensitivity 只放大焦虑/易怒增量，观测到 stability 下降、sensitivity 上升。
    targets: { stability: -1, sensitivity: 1 },
    others: ['energy', 'social_drive', 'closeness_need', 'physical_comfort', 'stress'],
    targetFloor: 0.005
  },
  {
    key: 'cycleMoodVariability',
    // 焦虑/易怒/正性情感整体 × mood_variability。
    targets: { stability: -1, sensitivity: 1, social_drive: -1 },
    others: ['energy', 'closeness_need', 'physical_comfort', 'stress'],
    targetFloor: 0.002
  },
  {
    key: 'cycleIntimacyVariability',
    // intimacy_need_delta × intimacy_variability。
    targets: { closeness_need: -1 },
    others: ['energy', 'stability', 'sensitivity', 'social_drive', 'physical_comfort', 'stress'],
    targetFloor: 0.003
  }
]);

test('E-B EB1 未配置与显式四键 1.0 完全等价：同初始状态、同种子、逐 tick 全量比对', async () => {
  const base = await profileSequence({});
  const explicit = await profileSequence({
    cyclePainSensitivity: 1,
    cycleLutealSensitivity: 1,
    cycleMoodVariability: 1,
    cycleIntimacyVariability: 1
  });
  assert.deepEqual(explicit.states, base.states, '显式四键 1.0 必须与缺省逐 tick 完全一致');
  assert.deepEqual(explicit.phases, base.phases);
});

test('E-B EB2 四个 profile 设置分别单独生效：目标维改变、非目标维稳定', async () => {
  const base = await profileSequence({});
  const baseState = base.states.at(-1);
  for (const item of EB2_CASES) {
    const run = await profileSequence({ [item.key]: 1.5 });
    assertDirectionalDiff(moodDiff(baseState, run.states.at(-1)), item, item.key);
  }

  // luteal_sensitivity 专项：窗口确实经过黄体相位，并且黄体区间本身贡献了主要差异。
  // 注意 phaseWeights 对 boundary=0 取前一段（luteal）做 crossfade，所以周期起点会有一个
  // 与黄体权重同源的小瞬态，随后在卵泡期衰减；真正的黄体贡献集中在 luteal_like 区间。
  const luteal = await profileSequence({ cycleLutealSensitivity: 1.5 });
  const covered = new Set(luteal.phases);
  assert.deepEqual(
    [...covered].sort(),
    ['follicular_like', 'luteal_like', 'menstrual_like', 'ovulatory_like'],
    '28 天窗口必须覆盖四个周期相位'
  );
  const stabilitySeries = luteal.states.map((state, index) => moodDiff(base.states[index], state).stability);
  const follicularStart = luteal.phases.indexOf('follicular_like');
  assert.ok(
    Math.abs(stabilitySeries[follicularStart + 5]) < 1e-5,
    `卵泡期应衰减到无差异，实际 Δ=${stabilitySeries[follicularStart + 5]}`
  );
  const firstLuteal = luteal.phases.indexOf('luteal_like');
  const lastLuteal = luteal.phases.lastIndexOf('luteal_like');
  const entry = stabilitySeries[firstLuteal - 1];
  const plateau = stabilitySeries[lastLuteal];
  assert.ok(
    plateau < entry - 0.01,
    `黄体区间必须产生主要贡献：进入前 Δ=${entry}，黄体末 Δ=${plateau}`
  );
  for (let index = firstLuteal + 1; index <= lastLuteal; index += 1) {
    assert.ok(
      stabilitySeries[index] <= stabilitySeries[index - 1] + 1e-9,
      `黄体区间 stability 差异应单调累积，第 ${index} 步 Δ=${stabilitySeries[index]}`
    );
  }
  assert.ok(plateau < -0.01, `黄体末 stability 应显著下降，实际 Δ=${plateau}`);
});

test('E-B EB3 非法值经真实 E-A 规范化入口回退 1.0：不抛错、与缺省完全一致', async () => {
  const base = await profileSequence({});
  const illegal = await profileSequence({
    cyclePainSensitivity: '2', // type
    cycleLutealSensitivity: NaN, // non_finite
    cycleMoodVariability: null, // type
    cycleIntimacyVariability: 99 // range
  });
  assert.deepEqual(illegal.states, base.states, '回退后必须与缺省逐 tick 完全一致');
  assert.equal(
    illegal.h.logs.some((entry) => entry.code === 'INVALID_REQUEST'),
    false,
    '回退后的配置不得触发 resolveProfile 的 INVALID_REQUEST'
  );
  const configLog = illegal.h.logs.find((entry) => entry.code === 'FASTCFG_INVALID');
  assert.ok(configLog, 'setup 必须记录 FASTCFG_INVALID');
  assert.equal(configLog.warnings.length, 3, 'type / non_finite / range 各去重一条');
  assert.equal(configLog.errors.length, 4, 'errors 仍逐键保留明细');
});

test('E-B EB4 pain=0 与 pain=1.5 差异可重复、可解释，周期相位与长度不变', async () => {
  const base = await profileSequence({});
  const low = await profileSequence({ cyclePainSensitivity: 0 });
  const high = await profileSequence({ cyclePainSensitivity: 1.5 });

  for (let step = 0; step < low.states.length; step += 1) {
    assert.equal(low.states[step].cycle.phase, high.states[step].cycle.phase, `第 ${step} 步相位`);
    assert.equal(
      low.states[step].cycle.cycle_length_days,
      high.states[step].cycle.cycle_length_days,
      `第 ${step} 步周期长度`
    );
  }
  assert.ok(high.phases.includes('luteal_like'), '窗口必须覆盖黄体相位');

  const diff = moodDiff(high.states.at(-1), low.states.at(-1));
  assert.ok(diff.physical_comfort > 0.05, `pain=0 应显著抬升 physical_comfort，实际 Δ=${diff.physical_comfort}`);
  assert.ok(diff.energy > 0.02, `pain=0 应显著抬升 energy，实际 Δ=${diff.energy}`);

  // 可重复：同配置从零再跑一遍，逐 tick 全量一致；且与缺省确有差异。
  const repeat = await executeProfileSequence({ cyclePainSensitivity: 1.5 });
  assert.deepEqual(repeat.states, high.states, '同配置重复执行必须逐步一致');
  assert.notDeepEqual(high.states.at(-1).mood, base.states.at(-1).mood);
});

test('E-B EB5 profile 透传不改持久化结构，也不回写宿主设置', async () => {
  const base = await profileSequence({});
  const pain = await profileSequence({ cyclePainSensitivity: 1.5 });
  const baseState = base.states.at(-1);
  const painState = pain.states.at(-1);

  assert.deepEqual(Object.keys(painState).sort(), Object.keys(baseState).sort(), 'state 顶层键集');
  assert.deepEqual(Object.keys(painState.mood).sort(), Object.keys(baseState.mood).sort(), 'mood 键集');
  assert.deepEqual(Object.keys(painState.cycle).sort(), Object.keys(baseState.cycle).sort(), 'cycle 键集');

  const serialized = JSON.stringify(painState);
  assert.equal(serialized.includes('pain_sensitivity'), false, 'profile 不得落入持久化 state');
  assert.equal(serialized.includes('"profile"'), false, 'config.cycle.profile 不得落入持久化 state');

  // 引擎配置只在调用栈内构造：不新增宿主配置键，也不回写设置值。
  assert.equal('cycle' in pain.h.config, false, '宿主配置不得出现引擎专用的 cycle 键');
  assert.equal(pain.h.config.cyclePainSensitivity, 1.5, '宿主设置值不得被引擎改写');
  assert.equal(
    pain.h.config.cycleIntimacyVariability,
    undefined,
    '未显式设置的扁平键不得被引擎补写进宿主配置'
  );

  // 连续调用不污染后续执行：同一进程内重跑缺省配置，逐步仍与首次一致。
  const replay = await executeProfileSequence({});
  assert.deepEqual(replay.states, base.states, '缺省配置重跑必须与首次逐 tick 一致');
});

test('E-B EB6 组合配置逐键隔离：四键同时设置时不覆盖、不遗漏', async () => {
  // 四键同时非默认值；每次只把其中一个键退回 1，比较两条完整 56 tick 序列的终态。
  // 若任一键未进入 config.cycle.profile（被覆盖/遗漏/错误归一化），该键的定向差值会归零。
  const combo = {
    cyclePainSensitivity: 0,
    cycleLutealSensitivity: 1.5,
    cycleMoodVariability: 1.5,
    cycleIntimacyVariability: 1.5
  };
  const run = await profileSequence(combo);
  const finalState = run.states.at(-1);

  const cases = [
    {
      label: 'pain=0',
      reference: { ...combo, cyclePainSensitivity: 1 },
      targets: { physical_comfort: 1, energy: 1 },
      others: ['stability', 'sensitivity', 'social_drive', 'closeness_need', 'stress'],
      targetFloor: 0.005
    },
    {
      label: 'luteal=1.5',
      reference: { ...combo, cycleLutealSensitivity: 1 },
      targets: { stability: -1, sensitivity: 1 },
      others: ['energy', 'social_drive', 'closeness_need', 'physical_comfort', 'stress'],
      targetFloor: 0.003
    },
    {
      label: 'mood=1.5',
      reference: { ...combo, cycleMoodVariability: 1 },
      targets: { stability: -1, sensitivity: 1, social_drive: -1 },
      others: ['energy', 'closeness_need', 'physical_comfort', 'stress'],
      targetFloor: 0.002
    },
    {
      label: 'intimacy=1.5',
      reference: { ...combo, cycleIntimacyVariability: 1 },
      targets: { closeness_need: -1 },
      others: ['energy', 'stability', 'sensitivity', 'social_drive', 'physical_comfort', 'stress'],
      targetFloor: 0.003
    }
  ];

  for (const item of cases) {
    const reference = await profileSequence(item.reference);
    assertDirectionalDiff(
      moodDiff(reference.states.at(-1), finalState),
      item,
      `EB6 ${item.label}（其余三键固定为非默认值）`
    );
  }
});
