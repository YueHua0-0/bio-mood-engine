/**
 * T01：14 §7 的交付文件清单核对。
 *
 * 只断言"该有的都有、helpers 目录不多不少"，不扫描 lib/**。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const rel = (path) => new URL(path, ROOT);

const REQUIRED_FIXTURES = [
  'tests/fixtures/state.valid.json',
  'tests/fixtures/timezones.json',
  'tests/fixtures/vectors.random.json',
  'tests/fixtures/contract.snapshot.json'
];

const REQUIRED_HELPERS = ['assert.mjs', 'state.mjs', 'clock.mjs', 'repo.mjs', 'random.mjs', 'report.mjs'];

const REQUIRED_EVENT_TYPES = [
  'group_message',
  'mention',
  'important_person_appear',
  'comfort_received',
  'conflict',
  'long_silence',
  'direct_question',
  'admin_command',
  'system_event'
];

const REQUIRED_CONTRACT_TESTS = [
  'file_manifest.test.mjs',
  'contract_snapshot.test.mjs',
  'module_shape.test.mjs',
  'privacy_scan.test.mjs',
  'test_report.test.mjs'
];

const REQUIRED_INTEGRATION_TESTS = [
  'determinism.test.mjs',
  'idempotency_concurrency.test.mjs',
  'clock_timezone.test.mjs',
  'persistence_restart.test.mjs',
  'migrations.test.mjs',
  'fault_injection.test.mjs',
  'storage_adapters.test.mjs'
];

test('T01 交付清单：fixture / helpers / contract / integration / 报告齐全', () => {
  for (const path of REQUIRED_FIXTURES) {
    assert.ok(existsSync(rel(path)), `缺少 fixture：${path}`);
  }
  for (const type of REQUIRED_EVENT_TYPES) {
    assert.ok(existsSync(rel(`tests/fixtures/events/${type}.json`)), `缺少事件夹具：${type}.json`);
  }
  const helperFiles = readdirSync(rel('tests/helpers')).sort();
  assert.deepEqual(helperFiles, [...REQUIRED_HELPERS].sort(), 'tests/helpers 必须恰好是 §7 的六个文件');

  const contractFiles = readdirSync(rel('tests/contract')).filter((name) => name.endsWith('.test.mjs'));
  for (const name of REQUIRED_CONTRACT_TESTS) {
    assert.ok(contractFiles.includes(name), `缺少契约用例：tests/contract/${name}`);
  }
  const integrationFiles = readdirSync(rel('tests/integration')).filter((name) => name.endsWith('.test.mjs'));
  for (const name of REQUIRED_INTEGRATION_TESTS) {
    assert.ok(integrationFiles.includes(name), `缺少集成用例：tests/integration/${name}`);
  }
  const simulationFiles = readdirSync(rel('tests/simulation')).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(simulationFiles.length >= 2, 'tests/simulation 至少包含夜间打断与基线两份用例');
  assert.ok(existsSync(rel('docs/test_report.md')), '缺少 docs/test_report.md');
});

test('T01 事件夹具：九种 event_type 各一条，且 is_mentioned 覆盖真假', () => {
  const events = REQUIRED_EVENT_TYPES.map((type) => ({
    type,
    event: JSON.parse(readFileSync(rel(`tests/fixtures/events/${type}.json`), 'utf8'))
  }));
  assert.deepEqual(
    events.map(({ event }) => event.event_type),
    REQUIRED_EVENT_TYPES,
    '文件名与 event_type 必须一一对应'
  );
  const mentioned = new Set(events.filter(({ event }) => event.source.is_mentioned === true).map(({ type }) => type));
  const silent = events.filter(({ event }) => event.source.is_mentioned === false);
  assert.ok(mentioned.size >= 1, '至少一条 is_mentioned=true');
  assert.ok(silent.length >= 1, '至少一条 is_mentioned=false');
  for (const { event, type } of events) {
    assert.equal(event.character_id, 'whale_character', `${type} 的 character_id 不符`);
    assert.deepEqual(Object.keys(event.source).sort(), [
      'conversation_id',
      'conversation_kind',
      'is_mentioned',
      'platform',
      'relationship_tag',
      'sender_id'
    ]);
  }
});
