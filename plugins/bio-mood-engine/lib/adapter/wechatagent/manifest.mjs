/**
 * 13 §4.2 / §4.3 / §5.1：清单校验、配置规范化与默认值。
 *
 * 这里只做"纯数据校验"：不读文件、不读 ctx.storage、不联网、不读系统时间。
 * `setup(api)` 用 `normalizeConfig(ctx.config())`，非法值回退默认并记 `FASTCFG_INVALID`。
 */

import { createHash } from 'node:crypto';

import { assertTimeZone } from '../../../../../lib/core/clock.mjs';

export const PLUGIN_ID = 'bio-mood-engine';
export const API_VERSION = 2;
export const HOST = 'wechatagent';
export const PERMISSIONS = Object.freeze(['storage', 'history_read', 'reply']);

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ACTOR_HASH_RE = /^[0-9a-f]{12}$/;
/** P-13-17：wxid 明文形态（含 `wxid_` 前缀的完整 wxid，或剥掉前缀的主体）。 */
const WXID_RE = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const ADMIN_IDS_MAX = 8;

/**
 * P-13-11 / P-13-17：`adminActorIds` 在宿主设置页只能存成字符串，这里统一归一成数组。
 * 接受 `"a,b"` / `"a b"` / `["a","b"]`；非法形状返回 `null`，由 `settingProblem` 报 `range`。
 * 不转小写：wxid 区分大小写，只有 12 位哈希才是小写。
 */
function adminIdsOf(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
  if (typeof value !== 'string') return null;
  return value
    .split(/[,\s]+/)
    .filter((item) => item.length > 0);
}

function adminHashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

/**
 * P-13-17：设置里填 **wxid 明文**，插件内部自行哈希，明文不落盘、不回显。
 * 双候选：完整 wxid + 剥掉 `wxid_` 前缀后的主体 —— 宿主 `ctx.actor.id` 实测是带前缀的
 * 完整 wxid，保留裸主体候选是为了让「按字面删掉前缀」的填法同样可用，两种输入都能命中自己。
 * 已经是 12 位十六进制的旧值原样接受，避免存量配置失效。
 */
function adminHashCandidates(item) {
  if (ACTOR_HASH_RE.test(item)) return [item];
  // 存量配置可能写成大写哈希，先归一，避免被当成 wxid 再哈希一次（P-13-11 的既有行为）。
  if (/^[0-9a-fA-F]{12}$/.test(item)) return [item.toLowerCase()];
  const out = [adminHashOf(item)];
  const bare = item.replace(/^wxid_/i, '');
  if (bare !== item && bare.length > 0) {
    const hash = adminHashOf(bare);
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/** 把若干 wxid/哈希展开成去重后的候选哈希列表（授权时逐个比较）。 */
export function adminHashesOf(list) {
  const out = [];
  for (const item of list) {
    for (const hash of adminHashCandidates(item)) {
      if (!out.includes(hash)) out.push(hash);
    }
  }
  return out;
}

/** 00 §10.2.1 的持久化字段名。 */
export const STATE_SEED_FIELD = 'master_seed_hex';

/** 把字符串或数组的 chat ids 归一成去重数组；逗号/空白分隔。 */
function primaryIdsOf(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
  if (typeof value !== 'string') return [];
  const parts = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(parts)];
}

/** 13 §4.3：设置默认值（唯一来源）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  primaryChatId: '',
  // P-13-11：清单里是逗号分隔字符串（宿主设置页只存字符串），运行期归一成数组。
  adminActorIds: '',
  characterId: 'whale_character',
  timezone: 'Asia/Shanghai',
  masterSeedHex: '',
  behaviorContextMaxChars: 800,
  debugLogging: false,
  shadowMode: false,
  engineMode: 'embedded',
  engineRemoteUrl: '',
  engineRemoteToken: '',
  afterResponseMode: 'off',
  // 00 §8 / 13 §4.3：profile 调制系数，扁平 number，范围 [0,1.5]，默认 1.0。
  cyclePainSensitivity: 1,
  cycleLutealSensitivity: 1,
  cycleMoodVariability: 1,
  cycleIntimacyVariability: 1
});

export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS);
/** 00 §8 规则 4：只有四个 profile 系数按非法种类去重，其余设置沿用按码去重。 */
const PROFILE_SETTING_KEYS = new Set([
  'cyclePainSensitivity',
  'cycleLutealSensitivity',
  'cycleMoodVariability',
  'cycleIntimacyVariability'
]);

/**
 * 宿主受限子集（WeChatAgent-plugin-api-v2.md 第 80 行）：关键词与类型都不许越界，
 * 否则安装期报「Schema 使用了不支持的类型或字段」（P-13-09）。
 */
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'title',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'secret'
]);
const ALLOWED_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

/** 递归校验 Schema 是否落在宿主受限子集内；工具 `parameters` 复用同一套规则（P-13-10）。 */
export function collectSchemaErrors(node, path, errors) {
  if (!isPlainObject(node)) return;
  for (const [keyword, value] of Object.entries(node)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
      errors.push(manifestError(`${path}.${keyword}`, 'unsupported_keyword'));
      continue;
    }
    if (keyword === 'type' && !ALLOWED_SCHEMA_TYPES.has(value)) {
      errors.push(manifestError(`${path}.type`, 'unsupported_type'));
    }
    if (keyword === 'properties' && isPlainObject(value)) {
      for (const [name, child] of Object.entries(value)) collectSchemaErrors(child, `${path}.${name}`, errors);
    }
    if (keyword === 'items') collectSchemaErrors(value, `${path}.items`, errors);
  }
}

/**
 * P-13-14：工具 `parameters` 也必须过同一套受限子集。
 * `configSchema` 与 `parameters` 由宿主用同一校验器检查，任何一侧越界都会让**整个插件被拒装**。
 */
export function collectToolSchemaErrors(definitions) {
  const errors = [];
  for (const def of Array.isArray(definitions) ? definitions : []) {
    const id = typeof def?.id === 'string' && def.id.length > 0 ? def.id : '?';
    const path = `tools.${id}.parameters`;
    if (!isPlainObject(def?.parameters) || def.parameters.type !== 'object') {
      errors.push(manifestError(path, 'unsupported_type'));
      continue;
    }
    collectSchemaErrors(def.parameters, path, errors);
  }
  return errors;
}

/** 13 §4.2：允许的顶层字段；其余一律安装拒绝。 */
export const MANIFEST_FIELDS = Object.freeze([
  'id',
  'name',
  'version',
  'apiVersion',
  'host',
  'description',
  'permissions',
  'settings',
  'configSchema'
]);

const MANIFEST_FIELD_SET = new Set(MANIFEST_FIELDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function manifestError(field, reason) {
  return { field, reason, code: 'PLUGIN_MANIFEST_INVALID' };
}

function depthOf(value, depth = 1) {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value)
    ? value
    : Object.values(value);
  let max = depth;
  for (const child of children) max = Math.max(max, depthOf(child, depth + 1));
  return max;
}

/** 单个设置项的合法性：返回 null 表示合法，否则返回原因字符串。 */
export function settingProblem(key, value) {
  switch (key) {
    case 'enabled':
    case 'debugLogging':
    case 'shadowMode':
      return typeof value === 'boolean' ? null : 'type';
    case 'primaryChatId': {
      // P-13-20 裁决 A：v1 只有单主会话；空字符串仍表示未绑定。
      if (Array.isArray(value)) {
        if (value.length !== 1) return 'range';
        if (!value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)) return 'range';
        return null;
      }
      if (typeof value !== 'string') return 'type';
      if (value.length > 128) return 'range';
      const ids = primaryIdsOf(value);
      if (ids.length > 1) return 'range';
      if (!ids.every((item) => item.length <= 128)) return 'range';
      return null;
    }
    case 'adminActorIds': {
      // P-13-11：宿主设置页把 array 存成了字符串，这里同时接受 `a,b` 文本与数组两种形状。
      // P-13-17：每项可以是 wxid 明文（插件内部哈希），也可以是已算好的 12 位哈希。
      const list = adminIdsOf(value);
      if (list === null || list.length > ADMIN_IDS_MAX) return 'range';
      return list.every((item) => ACTOR_HASH_RE.test(item) || WXID_RE.test(item)) ? null : 'pattern';
    }
    case 'characterId':
      return typeof value === 'string' && CHARACTER_ID_RE.test(value) ? null : 'pattern';
    case 'timezone':
      if (typeof value !== 'string' || value.length === 0) return 'type';
      try {
        assertTimeZone(value);
        return null;
      } catch {
        return 'timezone';
      }
    case 'masterSeedHex':
      if (typeof value !== 'string') return 'type';
      return value === '' || HEX32_RE.test(value) ? null : 'pattern';
    case 'behaviorContextMaxChars':
      return Number.isInteger(value) && value >= 200 && value <= 1500 ? null : 'range';
    case 'engineMode':
      return value === 'embedded' || value === 'remote' ? null : 'enum';
    case 'engineRemoteUrl':
      if (typeof value !== 'string' || value.length > 200) return 'range';
      return value === '' || value.startsWith('https://') ? null : 'pattern';
    case 'engineRemoteToken':
      return typeof value === 'string' && value.length <= 512 ? null : 'range';
    case 'afterResponseMode':
      return value === 'off' || value === 'protocol' ? null : 'enum';
    case 'cyclePainSensitivity':
    case 'cycleLutealSensitivity':
    case 'cycleMoodVariability':
    case 'cycleIntimacyVariability': {
      // 00 §8 规则 4：类型错误 / 非有限数值 / 超出 [0,1.5] 是三种不同非法种类。
      if (typeof value !== 'number') return 'type';
      if (!Number.isFinite(value)) return 'non_finite';
      return value >= 0 && value <= 1.5 ? null : 'range';
    }
    default:
      return 'unknown_key';
  }
}

/**
 * 13 §4.2 / P01 / P02：逐字段核对清单。
 * @returns {{ok:boolean, errors:Array<{field:string, reason:string, code:string}>}}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, errors: [manifestError('$', 'not_object')] };
  }

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELD_SET.has(key)) errors.push(manifestError(key, 'unknown_field'));
  }

  if (manifest.id !== PLUGIN_ID) errors.push(manifestError('id', 'mismatch'));
  else if (!ID_RE.test(manifest.id) || manifest.id.startsWith('native-')) {
    errors.push(manifestError('id', 'pattern'));
  }

  if (typeof manifest.name !== 'string' || manifest.name.length < 1 || manifest.name.length > 80) {
    errors.push(manifestError('name', 'range'));
  }
  if (
    typeof manifest.description !== 'string' ||
    manifest.description.length < 1 ||
    manifest.description.length > 1024
  ) {
    errors.push(manifestError('description', 'range'));
  }
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    errors.push(manifestError('version', 'semver'));
  }
  if (manifest.apiVersion !== API_VERSION) errors.push(manifestError('apiVersion', 'mismatch'));
  if (manifest.host !== HOST) errors.push(manifestError('host', 'mismatch'));

  const permissions = manifest.permissions;
  if (
    !Array.isArray(permissions) ||
    permissions.length !== PERMISSIONS.length ||
    !PERMISSIONS.every((item) => permissions.includes(item))
  ) {
    errors.push(manifestError('permissions', 'mismatch'));
  }

  if (!isPlainObject(manifest.settings)) {
    errors.push(manifestError('settings', 'not_object'));
  } else {
    for (const key of Object.keys(manifest.settings)) {
      if (!SETTINGS_KEY_SET.has(key)) errors.push(manifestError(`settings.${key}`, 'unknown_field'));
    }
    for (const key of SETTINGS_KEYS) {
      if (!(key in manifest.settings)) {
        errors.push(manifestError(`settings.${key}`, 'missing'));
        continue;
      }
      const problem = settingProblem(key, manifest.settings[key]);
      if (problem) errors.push(manifestError(`settings.${key}`, problem));
    }
  }

  const schema = manifest.configSchema;
  if (!isPlainObject(schema)) {
    errors.push(manifestError('configSchema', 'not_object'));
  } else {
    // 宿主契约：configSchema 是「设置字段名 → Schema」的扁平映射，不是 JSON Schema 文档。
    const keys = Object.keys(schema);
    if (keys.length === 0) errors.push(manifestError('configSchema', 'missing'));
    if (keys.length > 24) errors.push(manifestError('configSchema', 'too_many'));
    if (depthOf(schema) > 12) errors.push(manifestError('configSchema', 'too_deep'));
    for (const key of keys) {
      if (!SETTINGS_KEY_SET.has(key)) errors.push(manifestError(`configSchema.${key}`, 'unknown_field'));
      if (!isPlainObject(schema[key])) errors.push(manifestError(`configSchema.${key}`, 'not_object'));
      else collectSchemaErrors(schema[key], `configSchema.${key}`, errors);
    }
    if (isPlainObject(manifest.settings)) {
      for (const key of SETTINGS_KEYS) {
        if (!(key in schema)) errors.push(manifestError(`configSchema.${key}`, 'missing'));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertManifest(manifest) {
  const result = validateManifest(manifest);
  if (result.ok) return manifest;
  const first = result.errors[0];
  const err = new Error(`invalid plugin manifest: ${first.field}`);
  err.code = 'PLUGIN_MANIFEST_INVALID';
  err.details = { field: first.field, errors: result.errors };
  throw err;
}

function pushUnique(list, code) {
  if (!list.includes(code)) list.push(code);
}

/**
 * 13 §5.1：把宿主配置规范化为设置对象；非法值回退默认，未知键只告警。
 * 不读取任何 secret 之外的外部资源，也不回写宿主配置。
 */
export function normalizeConfig(raw) {
  const warnings = [];
  const errors = [];
  const invalidKinds = new Set();
  // 既有设置（非 profile）仍按 warning code 全局去重一次，与 profile 的种类去重互不抑制。
  let legacyInvalidSeen = false;
  const input = isPlainObject(raw) ? raw : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    adminActorIds: [],
    // P-13-19：运行期的权威值；从 primaryChatId 字符串解析而来。
    primaryChatIds: []
  };

  for (const key of Object.keys(input)) {
    if (!SETTINGS_KEY_SET.has(key)) {
      pushUnique(warnings, 'UNKNOWN_CONFIG_KEY');
      continue;
    }
    const value = input[key];
    const problem = settingProblem(key, value);
    if (problem) {
      // 00 §8 规则 4：profile 系数按非法值种类去重（type / non_finite / range 各至多一次）；
      // 其他既有设置保持原行为（按 warning code 去重）。errors 仍逐键保留明细。
      if (PROFILE_SETTING_KEYS.has(key)) {
        if (!invalidKinds.has(problem)) {
          invalidKinds.add(problem);
          warnings.push('FASTCFG_INVALID');
        }
      } else if (!legacyInvalidSeen) {
        legacyInvalidSeen = true;
        warnings.push('FASTCFG_INVALID');
      }
      const multiplePrimary = key === 'primaryChatId' && primaryIdsOf(value).length > 1;
      errors.push({
        code: 'FASTCFG_INVALID',
        field: key,
        reason: problem,
        message: multiplePrimary
          ? 'v1 只支持单主会话；多主会话需账号级共享存储（见 P-13-20 裁决）'
          : `配置项 ${key} 非法（${problem}），已回退默认值`
      });
      continue;
    }
    // P-13-17：设置里填 wxid 明文，这里立即转成 12 位候选哈希，明文只活在 `input` 里。
    // P-13-20：primaryChatId 运行期同时写字符串原值（debug 用）和至多一项的数组（判定用）。
    if (key === 'adminActorIds') {
      settings.adminActorIds = adminHashesOf(adminIdsOf(value));
    } else if (key === 'primaryChatId') {
      settings.primaryChatId = Array.isArray(value) ? value.join(',') : value;
      settings.primaryChatIds = primaryIdsOf(value);
    } else {
      // 规范化负零：-0 与 0 数值等价，但统一写正 0 避免符号位进入后续计算。
      settings[key] = typeof value === 'number' && Object.is(value, -0) ? 0 : value;
    }
  }

  // 13 §4.3：remote 模式缺地址属于运行时降级，不是配置错误；这里只做快照。
  return { settings, warnings, errors };
}

/** 13 §5.4 / §5.9：`cfg` 快照必须脱敏，种子与远程令牌不得落盘。 */
export function redactConfig(settings) {
  return {
    ...settings,
    adminActorIds: [...(settings.adminActorIds ?? [])],
    masterSeedHex: '',
    engineRemoteToken: settings.engineRemoteToken ? '***' : ''
  };
}

export default validateManifest;
