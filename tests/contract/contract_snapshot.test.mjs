/**
 * T11：契约快照比对（字段名 / 枚举 / 错误码 / 日志字段 / 警告码）。
 *
 * 快照来源：`tests/fixtures/contract.snapshot.json`；
 * 对照来源：`lib/**` 的运行时常量 + `docs/00-统一契约.md` §9.2 / §9.2.1 / §10.1。
 * 多一个、少一个、改名都会失败。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { httpStatusFor, retryableFor } from '../../lib/api/errors.mjs';
import {
  CONTRACT_VERSION,
  CYCLE_LENGTH_SOURCES,
  CYCLE_PHASES,
  INTERFACE_VERSION,
  MODULE_ORDER,
  SCHEMA_VERSION,
  SLEEP_STATES,
  STATE_KEYS
} from '../../lib/core/constants.mjs';
import { createDefaultState } from '../../lib/core/models.mjs';
import { AFFECTION_TIERS, VERBOSITY_TIERS } from '../../lib/modules/behavior/tone.mjs';
import { POLICIES } from '../../lib/modules/delivery/policy.mjs';
import { EVENT_TYPES, RELATIONSHIP_TAGS } from '../../lib/modules/stress/event.mjs';

const SNAPSHOT = JSON.parse(
  readFileSync(new URL('../fixtures/contract.snapshot.json', import.meta.url), 'utf8')
);
const DOC = readFileSync(new URL('../../docs/00-统一契约.md', import.meta.url), 'utf8').split(/\r?\n/);

function section(from, to) {
  const start = DOC.findIndex((line) => line.startsWith(from));
  const end = DOC.findIndex((line) => line.startsWith(to));
  assert.ok(start >= 0 && end > start, `docs/00 缺少章节 ${from}..${to}`);
  return DOC.slice(start, end);
}

function docErrorCodes() {
  return section('### 9.2 错误码表', '### 9.2.1').flatMap((line) => {
    const match = line.match(/^\| `([A-Z_]+)` \| (\d{3}) \| (true|false) \|/);
    return match
      ? [{ code: match[1], status: Number(match[2]), retryable: match[3] === 'true' }]
      : [];
  });
}

function docWarningCodes() {
  return section('### 9.2.1', '### 9.3').flatMap((line) => {
    const match = line.match(/^\| `([A-Z_<>]+)` \|/);
    return match && match[1] !== '警告码' ? [match[1]] : [];
  });
}

function docLogFields() {
  const block = section('### 10.1', '### 10.2');
  const start = block.findIndex((line) => line.startsWith('```json'));
  const end = block.findIndex((line, index) => index > start && line.startsWith('```'));
  assert.ok(start >= 0 && end > start, 'docs/00 §10.1 缺少日志字段 JSON 示例');
  return Object.keys(JSON.parse(block.slice(start + 1, end).join('\n'))).sort();
}

function freshState() {
  return createDefaultState({
    character_id: 'whale_character',
    timezone: 'Asia/Shanghai',
    now: '2026-11-09T09:20:01.000Z',
    master_seed_hex: '000102030405060708090a0b0c0d0e0f'
  });
}

test('T11 契约快照：版本 / 状态字段 / 枚举 / 错误码 / 警告码 / 日志字段逐项一致', () => {
  assert.equal(SNAPSHOT.contract_version, CONTRACT_VERSION);
  assert.equal(SNAPSHOT.schema_version, SCHEMA_VERSION);
  assert.equal(SNAPSHOT.interface_version, INTERFACE_VERSION);
  assert.deepEqual(SNAPSHOT.module_order, [...MODULE_ORDER]);

  const state = freshState();
  assert.deepEqual(SNAPSHOT.state_keys, [...STATE_KEYS].sort(), 'state 顶层字段集不一致');
  for (const key of ['cycle', 'sleep', 'stress', 'regulation', 'mood', 'random']) {
    assert.deepEqual(
      SNAPSHOT.state_sections[key],
      Object.keys(state[key]).sort(),
      `${key} 子字段集不一致`
    );
  }

  assert.deepEqual(SNAPSHOT.enums.event_type, [...EVENT_TYPES]);
  assert.deepEqual(SNAPSHOT.enums.relationship_tag, [...RELATIONSHIP_TAGS]);
  assert.deepEqual(SNAPSHOT.enums.cycle_phase, [...CYCLE_PHASES]);
  assert.deepEqual(SNAPSHOT.enums.cycle_length_source, [...CYCLE_LENGTH_SOURCES]);
  assert.deepEqual(SNAPSHOT.enums.sleep_state, [...SLEEP_STATES]);
  assert.deepEqual(SNAPSHOT.enums.delivery_policy, [...POLICIES]);
  assert.deepEqual(SNAPSHOT.enums.verbosity_bias, [...VERBOSITY_TIERS]);
  assert.deepEqual(SNAPSHOT.enums.affection_expression, [...AFFECTION_TIERS]);

  assert.deepEqual(SNAPSHOT.error_codes, docErrorCodes(), '错误码表与 00 §9.2 不一致');
  for (const { code, status, retryable } of SNAPSHOT.error_codes) {
    assert.equal(httpStatusFor(code), status, `${code} 的 HTTP 映射不一致`);
    assert.equal(retryableFor(code), retryable, `${code} 的 retryable 不一致`);
  }
  assert.deepEqual(SNAPSHOT.warning_codes, docWarningCodes(), '警告码表与 00 §9.2.1 不一致');
  assert.deepEqual(SNAPSHOT.log_fields, docLogFields(), '日志字段与 00 §10.1 不一致');
});

test('T11 警告码扫描：使用放宽正则（允许 <CODE>:<param>），不复用 reason_code 正则', () => {
  // 00 §9.2.1：参数化警告使用 `<CODE>:<param>`；reason_code 只允许 `^[a-z][a-z0-9_]{0,63}$`。
  const warningPattern = /^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_.:+-]+)?$/;
  const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
  for (const code of SNAPSHOT.warning_codes) {
    if (code.includes('<')) continue; // MISSING_<MODULE>_DATA 是模板，不是字面量
    assert.match(code, warningPattern, `警告码 ${code} 不符合放宽正则`);
    assert.doesNotMatch(code, reasonPattern, '警告码不得被 reason_code 正则约束');
  }
  assert.match('LONG_OFFLINE_COARSE:720h', warningPattern);
  assert.doesNotMatch('LONG_OFFLINE_COARSE:720h', reasonPattern, 'reason_code 正则不应接受警告参数');
  assert.ok(SNAPSHOT.warning_codes.includes('MISSING_<MODULE>_DATA'), '缺少模板警告码');
});
