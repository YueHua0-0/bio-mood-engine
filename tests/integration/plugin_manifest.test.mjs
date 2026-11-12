import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  validateManifest,
  normalizeConfig,
  collectToolSchemaErrors
} from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/manifest.mjs';
import { TOOL_DEFINITIONS } from '../../plugins/bio-mood-engine/index.mjs';
import { makeCtx, install, FIXED_SEED, T0 } from './_plugin_helpers.mjs';

const MANIFEST_URL = new URL('../../plugins/bio-mood-engine/plugin.json', import.meta.url);
const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));

test('P01 清单逐字段合法：id/version/apiVersion/host/permissions、configSchema ≤24、默认值合法', () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.id, 'bio-mood-engine');
  assert.equal(manifest.host, 'wechatagent');
  // 宿主契约：apiVersion 必须是数字 2（字符串 "2" 会被安装期拒绝，见 P-13-08）。
  assert.equal(manifest.apiVersion, 2);
  assert.equal(typeof manifest.apiVersion, 'number');
  assert.match(manifest.id, /^[a-z][a-z0-9-]{0,39}$/);
  assert.ok(!manifest.id.startsWith('native-'));
  assert.ok(manifest.description.length >= 1 && manifest.description.length <= 1024);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions], ['storage', 'history_read', 'reply']);
  // configSchema 是「字段名 → Schema」扁平映射，不得带 type/additionalProperties/properties 外壳。
  assert.equal(Object.hasOwn(manifest.configSchema, 'type'), false);
  assert.equal(Object.hasOwn(manifest.configSchema, 'properties'), false);
  assert.equal(Object.hasOwn(manifest.configSchema, 'additionalProperties'), false);
  assert.ok(Object.keys(manifest.configSchema).length <= 24);
  assert.deepEqual(Object.keys(manifest.configSchema).sort(), [...SETTINGS_KEYS].sort());
  assert.deepEqual(Object.keys(manifest.settings).sort(), [...SETTINGS_KEYS].sort());
  for (const key of SETTINGS_KEYS) {
    assert.deepEqual(manifest.settings[key], DEFAULT_SETTINGS[key], `默认值必须与契约一致: ${key}`);
  }
});

test('P-13-11 adminActorIds 接受逗号分隔字符串并归一成小写数组', () => {
  const ok = normalizeConfig({ adminActorIds: 'D4C0C02F72C6, 0123456789ab' });
  assert.deepEqual(ok.settings.adminActorIds, ['d4c0c02f72c6', '0123456789ab']);
  assert.deepEqual(ok.warnings, []);

  // 空格分隔、数组旧形状都要继续可用。
  assert.deepEqual(normalizeConfig({ adminActorIds: 'a'.repeat(12) }).settings.adminActorIds, [
    'a'.repeat(12)
  ]);
  assert.deepEqual(normalizeConfig({ adminActorIds: ['b'.repeat(12)] }).settings.adminActorIds, [
    'b'.repeat(12)
  ]);

  // 非法：长度不足 3、含非法字符、超过 8 个（P-13-17 起普通字符串按 wxid 处理，不再要求 12 hex）。
  assert.ok(normalizeConfig({ adminActorIds: 'ab' }).warnings.includes('FASTCFG_INVALID'));
  assert.ok(normalizeConfig({ adminActorIds: '<x>' }).warnings.includes('FASTCFG_INVALID'));
  const nine = Array.from({ length: 9 }, (_, i) => String(i).repeat(12)).join(',');
  assert.ok(normalizeConfig({ adminActorIds: nine }).warnings.includes('FASTCFG_INVALID'));
});

test('P-13-20 v1 单主会话：两项 FASTCFG_INVALID，一项有效，空值保持未绑定', () => {
  for (const value of ['chat_a,chat_b', 'chat_a chat_b', ['chat_a', 'chat_b']]) {
    const result = normalizeConfig({ primaryChatId: value });
    assert.ok(result.warnings.includes('FASTCFG_INVALID'));
    assert.equal(result.settings.primaryChatId, '');
    assert.deepEqual(result.settings.primaryChatIds, []);
    const error = result.errors.find((item) => item.field === 'primaryChatId');
    assert.equal(error?.code, 'FASTCFG_INVALID');
    assert.match(error?.message ?? '', /v1 只支持单主会话；多主会话需账号级共享存储（见 P-13-20 裁决）/);
  }

  for (const value of ['chat_a', ['chat_a']]) {
    const result = normalizeConfig({ primaryChatId: value });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.settings.primaryChatIds, ['chat_a']);
  }

  const empty = normalizeConfig({ primaryChatId: '' });
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(empty.settings.primaryChatIds, []);
});

test('P-13-17 设置里填 wxid 明文，插件内部转双候选哈希', () => {
  // 完整 wxid：sha256("wxid_b47wq155j24u22")[:12] === d4c0c02f72c6（现网 S4 靠它通过）。
  const full = normalizeConfig({ adminActorIds: 'wxid_b47wq155j24u22' }).settings.adminActorIds;
  assert.deepEqual(full, ['d4c0c02f72c6', '8b32891f8575']);

  // 只填裸主体：两个候选里必须有一个等于 sha256(裸主体) 前 12 位，否则「删掉 wxid_」的填法会失效。
  const bare = normalizeConfig({ adminActorIds: 'b47wq155j24u22' }).settings.adminActorIds;
  assert.deepEqual(bare, ['8b32891f8575']);

  // 留空：不产生任何候选，由 authorize 沿用落盘白名单（见 tools.mjs）。
  assert.deepEqual(normalizeConfig({ adminActorIds: '' }).settings.adminActorIds, []);
  // 明文不得回显到脱敏配置以外的任何字段：adminActorIds 里只有哈希。
  assert.ok(full.every((item) => /^[0-9a-f]{12}$/.test(item)));
});

test('P-13-14 工具 parameters 与 configSchema 用同一受限子集（自检不再有盲区）', () => {
  // 现网四个工具必须零越界——宿主会用同一校验器拒绝整个插件。
  assert.deepEqual(collectToolSchemaErrors(TOOL_DEFINITIONS), []);

  const bad = [
    {
      id: 'probe',
      parameters: {
        type: 'object',
        properties: { h: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        additionalProperties: false
      }
    }
  ];
  const errors = collectToolSchemaErrors(bad);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'tools.probe.parameters.h.pattern');
  assert.equal(errors[0].reason, 'unsupported_keyword');

  // parameters 不是 object Schema 也要拦。
  assert.equal(collectToolSchemaErrors([{ id: 'p2', parameters: { type: 'string' } }]).length, 1);
});

test('P02 注入未知字段 entry/enabledByDefault/scripts/foo 均被拒绝并指出字段名', () => {
  for (const field of ['entry', 'enabledByDefault', 'scripts', 'foo']) {
    const result = validateManifest({ ...manifest, [field]: true });
    assert.equal(result.ok, false, `${field} 必须被拒绝`);
    assert.ok(
      result.errors.some((item) => item.field === field),
      `错误必须指出字段名: ${field}`
    );
  }
});

test('P02b 受限 Schema 子集：maxItems 等未支持关键词必须被自检拒绝', () => {
  const withMaxItems = {
    ...manifest,
    configSchema: {
      ...manifest.configSchema,
      adminActorIds: { ...manifest.configSchema.adminActorIds, maxItems: 8 }
    }
  };
  const result = validateManifest(withMaxItems);
  assert.equal(result.ok, false, 'maxItems 不在宿主受限子集内，必须拒绝');
  assert.ok(result.errors.some((item) => item.reason === 'unsupported_keyword'));

  const withBadType = {
    ...manifest,
    configSchema: { ...manifest.configSchema, primaryChatId: { type: 'uri' } }
  };
  const typeResult = validateManifest(withBadType);
  assert.equal(typeResult.ok, false, 'uri 不是宿主支持的 type');
  assert.ok(typeResult.errors.some((item) => item.reason === 'unsupported_type'));
});

test('P03 setup(api) ≤2000 ms，且零网络、零 storage 写、零定时器', () => {
  const h = makeCtx();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalFetch = globalThis.fetch;
  let timers = 0;
  let fetches = 0;
  globalThis.setTimeout = (...args) => {
    timers += 1;
    return originalSetTimeout(...args);
  };
  globalThis.clearTimeout = (...args) => {
    timers += 1;
    return originalClearTimeout(...args);
  };
  globalThis.fetch = (...args) => {
    fetches += 1;
    return originalFetch(...args);
  };

  const before = h.storage.ops;
  const started = Date.now();
  try {
    install(h.ctx);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.fetch = originalFetch;
  }
  const elapsed = Date.now() - started;

  assert.ok(elapsed <= 2000, `setup 耗时 ${elapsed} ms`);
  assert.equal(timers, 0, 'setup 不得起定时器');
  assert.equal(fetches, 0, 'setup 不得联网');
  assert.equal(h.storage.ops - before, 0, 'setup 不得读写 storage');
});

test('P04 非法 observe 入参三次均 INVALID_REQUEST 且状态不变', async () => {
  const h = makeCtx();
  const { tools } = install(h.ctx);
  const ok = await tools.observe({
    event_type: 'mention',
    occurred_at: T0,
    conversation_id: 'chat_primary',
    sender_id: 'a1b2c3d4e5f6',
    text_hash: 'c'.repeat(64)
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.state_version, 1);

  const before = h.storage.raw('state');
  const cases = [
    { event_type: 'mention', occurred_at: T0, conversation_id: 'chat_primary', sender_id: 'a1b2c3d4e5f6' },
    { event_type: 'not_an_event', occurred_at: T0, conversation_id: 'chat_primary', sender_id: 'a1b2c3d4e5f6', text_hash: 'c'.repeat(64) },
    { event_type: 'mention', occurred_at: T0, conversation_id: 'x'.repeat(129), sender_id: 'a1b2c3d4e5f6', text_hash: 'c'.repeat(64) }
  ];
  for (const params of cases) {
    const result = await tools.observe(params);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_REQUEST');
  }
  assert.equal(h.storage.raw('state'), before, '失败请求不得改动 state');
});

test('配置规范化：非法值回退默认并记 FASTCFG_INVALID，未知键记 UNKNOWN_CONFIG_KEY', () => {
  const { settings, warnings } = normalizeConfig({
    enabled: 'yes',
    behaviorContextMaxChars: 9999,
    masterSeedHex: 'not-a-seed',
    unknownKey: 1
  });
  assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(settings.behaviorContextMaxChars, DEFAULT_SETTINGS.behaviorContextMaxChars);
  assert.equal(settings.masterSeedHex, '');
  assert.ok(warnings.includes('FASTCFG_INVALID'));
  assert.ok(warnings.includes('UNKNOWN_CONFIG_KEY'));

  const good = normalizeConfig({ masterSeedHex: FIXED_SEED, adminActorIds: [] });
  assert.deepEqual(good.warnings, []);
  assert.equal(good.settings.masterSeedHex, FIXED_SEED);
});

// ---- C2-E / E-A：四个周期 profile 设置（00 §8 规则 4、13 §4.3/§4.4） ----

const PROFILE_KEYS = Object.freeze([
  'cyclePainSensitivity',
  'cycleLutealSensitivity',
  'cycleMoodVariability',
  'cycleIntimacyVariability'
]);

function countCode(warnings, code) {
  return warnings.filter((item) => item === code).length;
}

test('E-A 设置定义：四键默认 1.0，且 SETTINGS_KEYS / plugin.json settings / configSchema 三者一致', () => {
  for (const key of PROFILE_KEYS) {
    assert.ok(SETTINGS_KEYS.includes(key), `${key} 必须在 SETTINGS_KEYS`);
    assert.equal(DEFAULT_SETTINGS[key], 1, `${key} 默认值`);
    assert.equal(manifest.settings[key], 1, `${key} plugin.json settings`);
    assert.equal(typeof manifest.settings[key], 'number', `${key} 必须是扁平 number（P-13-08）`);
    const schema = manifest.configSchema[key];
    assert.equal(schema.type, 'number', `${key} schema.type`);
    assert.equal(schema.default, 1, `${key} schema.default`);
    assert.equal(schema.minimum, 0, `${key} schema.minimum`);
    assert.equal(schema.maximum, 1.5, `${key} schema.maximum`);
  }
});

test('E-A 合法边界：0 / 1.5 / 0.8 / -0 全部接受，无警告无错误', () => {
  for (const [value, expected] of [[0, 0], [1.5, 1.5], [0.8, 0.8], [-0, 0]]) {
    const out = normalizeConfig({ cyclePainSensitivity: value });
    // -0 按 0 处理：数值上等价，不要求区分符号位。
    assert.ok(out.settings.cyclePainSensitivity === expected, `${String(value)} 应为 ${expected}`);
    assert.deepEqual(out.warnings, [], `${String(value)} 不得产生警告`);
    assert.deepEqual(out.errors, [], `${String(value)} 不得产生错误`);
  }
  const negZero = normalizeConfig({ cyclePainSensitivity: -0 });
  assert.equal(Object.is(negZero.settings.cyclePainSensitivity, 0), true, '-0 必须规范为正 0');
});

test('E-A 非法值：类型错误 / 非有限 / 越界分别归类，回退 1.0 且逐键记录 errors', () => {
  const cases = [
    ['range', -0.01],
    ['range', 1.51],
    ['non_finite', NaN],
    ['non_finite', Infinity],
    ['non_finite', -Infinity],
    ['type', null],
    ['type', undefined],
    ['type', '-0.01'],
    ['type', '1.5'],
    ['type', true],
    ['type', new Number(0)]
  ];
  for (const key of PROFILE_KEYS) {
    for (const [reason, value] of cases) {
      const out = normalizeConfig({ [key]: value });
      assert.equal(out.settings[key], 1, `${key}=${String(value)} 回退默认`);
      assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 1, `${key}=${String(value)} 警告`);
      assert.equal(out.errors.length, 1, `${key}=${String(value)} errors 条数`);
      assert.equal(out.errors[0].field, key);
      assert.equal(out.errors[0].reason, reason, `${key}=${String(value)} reason`);
    }
  }
});

test('E-A 缺键与显式非法区分：缺键走默认且无警告，显式非法不得静默吞掉', () => {
  const missing = normalizeConfig({});
  for (const key of PROFILE_KEYS) assert.equal(missing.settings[key], 1);
  assert.deepEqual(missing.warnings, []);

  const explicit = normalizeConfig({ cycleLutealSensitivity: null });
  assert.equal(explicit.settings.cycleLutealSensitivity, 1);
  assert.equal(countCode(explicit.warnings, 'FASTCFG_INVALID'), 1);
  assert.equal(explicit.errors[0].reason, 'type');
});

test('E-A warnings 按非法种类去重：同种多键只记一次，异种分别保留', () => {
  const sameKind = normalizeConfig({
    cyclePainSensitivity: 'x',
    cycleLutealSensitivity: null,
    cycleMoodVariability: true
  });
  assert.equal(countCode(sameKind.warnings, 'FASTCFG_INVALID'), 1, '同种 type 只记一次');
  assert.equal(sameKind.errors.length, 3, 'errors 仍逐键保留明细');

  const mixed = normalizeConfig({
    cyclePainSensitivity: 'x',
    cycleLutealSensitivity: NaN,
    cycleMoodVariability: 2
  });
  assert.equal(countCode(mixed.warnings, 'FASTCFG_INVALID'), 3, 'type / non_finite / range 各一次');
  assert.deepEqual(
    mixed.errors.map((item) => item.reason).sort(),
    ['non_finite', 'range', 'type']
  );
});

test('E-A 单个非法设置不影响其他键规范化，未知键行为不变', () => {
  const out = normalizeConfig({
    cyclePainSensitivity: 9,
    cycleIntimacyVariability: 1.2,
    masterSeedHex: FIXED_SEED,
    unknownKey: 1
  });
  assert.equal(out.settings.cyclePainSensitivity, 1);
  assert.equal(out.settings.cycleIntimacyVariability, 1.2);
  assert.equal(out.settings.masterSeedHex, FIXED_SEED);
  assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 1);
  assert.equal(countCode(out.warnings, 'UNKNOWN_CONFIG_KEY'), 1);
});

test('E-A 回归：既有设置的 FASTCFG_INVALID 仍按码全局去重一次', () => {
  const out = normalizeConfig({
    enabled: 'yes',                 // type
    behaviorContextMaxChars: 9999,  // range
    masterSeedHex: 'invalid'        // pattern
  });
  assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 1, '既有设置不得因种类不同而重复');
  assert.equal(out.errors.length, 3, 'errors 仍逐键保留');
  assert.deepEqual(
    out.errors.map((item) => item.reason).sort(),
    ['pattern', 'range', 'type']
  );
});

test('E-A 混合：既有设置按码去重与 profile 按种类去重互不干扰', () => {
  // 输入顺序固定为「既有键在前、profile 键在后」，与宿主配置对象的自然顺序一致。
  const out = normalizeConfig({
    enabled: 'yes',                 // 既有 type
    behaviorContextMaxChars: 9999,  // 既有 range
    cyclePainSensitivity: 'x',      // profile type
    cycleLutealSensitivity: NaN,    // profile non_finite
    cycleMoodVariability: 2         // profile range
  });
  // 1 次来自既有设置（按码）+ 3 次来自 profile（type / non_finite / range 各一次）。
  assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 4);
  assert.equal(out.errors.length, 5, 'errors 逐键保留，不因去重丢失明细');
  assert.deepEqual(
    out.errors.map((item) => `${item.field}:${item.reason}`).sort(),
    [
      'behaviorContextMaxChars:range',
      'cycleLutealSensitivity:non_finite',
      'cycleMoodVariability:range',
      'cyclePainSensitivity:type',
      'enabled:type'
    ]
  );
  assert.equal(out.settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(out.settings.cyclePainSensitivity, 1);
  assert.equal(out.settings.cycleLutealSensitivity, 1);
  assert.equal(out.settings.cycleMoodVariability, 1);
});

test('E-A 混合顺序无关：profile 在前、既有设置在后仍为 4 条', () => {
  const out = normalizeConfig({
    cyclePainSensitivity: 'x',      // profile type
    cycleLutealSensitivity: NaN,    // profile non_finite
    cycleMoodVariability: 2,        // profile range
    enabled: 'yes'                  // 既有 type
  });
  assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 4, '既有设置的 1 条不得被 profile 抑制');
  assert.equal(out.errors.length, 4, 'errors 逐键保留');
  assert.equal(out.errors.filter((item) => item.field === 'enabled').length, 1);
});

test('E-A 混合交错顺序：两类去重互不抑制', () => {
  const out = normalizeConfig({
    cyclePainSensitivity: 'x',      // profile type
    enabled: 'yes',                 // 既有 type
    cycleLutealSensitivity: NaN,    // profile non_finite
    behaviorContextMaxChars: 9999,  // 既有 range
    cycleMoodVariability: 2         // profile range
  });
  assert.equal(countCode(out.warnings, 'FASTCFG_INVALID'), 4);
  assert.equal(out.errors.length, 5);
  assert.deepEqual(
    out.errors.map((item) => `${item.field}:${item.reason}`).sort(),
    [
      'behaviorContextMaxChars:range',
      'cycleLutealSensitivity:non_finite',
      'cycleMoodVariability:range',
      'cyclePainSensitivity:type',
      'enabled:type'
    ]
  );
});
