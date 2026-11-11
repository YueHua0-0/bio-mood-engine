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
