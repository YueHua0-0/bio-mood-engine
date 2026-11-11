/**
 * T14：隐私扫描——fixture、日志、报告。
 *
 * 允许的例外只有两处，且都由 00 §10.2.1 明确授权：
 * - `tests/fixtures/state.valid.json` 的 `random.master_seed_hex`（state 键是唯一允许完整保存的位置）；
 * - `tests/fixtures/vectors.random.json`（03 §6 的测试金向量，种子为文档示例种子）。
 * 其余文件不得出现完整种子、原始 wxid、令牌、手机号或消息正文。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { isoAfter } from '../helpers/clock.mjs';
import { makeState } from '../helpers/state.mjs';

const ROOT = new URL('../../', import.meta.url);
const rel = (path) => new URL(path, ROOT);

const SEED_FILES = new Set(['tests/fixtures/state.valid.json', 'tests/fixtures/vectors.random.json']);
const SENSITIVE = [
  { name: '原始 wxid', pattern: /wxid_[A-Za-z0-9_-]{4,}/i },
  { name: 'Bearer 令牌', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/ },
  { name: 'API Key', pattern: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '完整种子的十六进制串', pattern: /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/ }
];

function fixtureFiles() {
  return [
    'tests/fixtures/state.valid.json',
    'tests/fixtures/timezones.json',
    'tests/fixtures/vectors.random.json',
    'tests/fixtures/contract.snapshot.json',
    'tests/fixtures/assembly.shape.json',
    ...readdirSync(rel('tests/fixtures/events')).map((name) => `tests/fixtures/events/${name}`),
    'docs/test_report.md'
  ];
}

test('T14 隐私扫描：fixture 与报告不含正文、wxid、令牌、完整种子', () => {
  for (const path of fixtureFiles()) {
    const text = readFileSync(rel(path), 'utf8');
    for (const { name, pattern } of SENSITIVE) {
      if (name === '完整种子的十六进制串' && SEED_FILES.has(path)) continue;
      assert.doesNotMatch(text, pattern, `${path} 命中 ${name}`);
    }
  }
});

test('T14 事件夹具：只保留 text_hash / text_summary，不含正文与原文', () => {
  for (const name of readdirSync(rel('tests/fixtures/events'))) {
    const event = JSON.parse(readFileSync(rel(`tests/fixtures/events/${name}`), 'utf8'));
    assert.deepEqual(Object.keys(event.payload).sort(), [
      'is_direct_question',
      'message_type',
      'text_hash',
      'text_summary'
    ]);
    assert.match(event.payload.text_hash, /^[0-9a-f]{64}$/, 'text_hash 必须是 SHA-256');
    assert.equal(event.payload.text_summary, '', 'text_summary 默认必须为空串');
    for (const forbidden of ['text', 'content', 'message', 'body', 'raw', 'wxid']) {
      assert.equal(forbidden in event.payload, false, `${name} 不得包含 payload.${forbidden}`);
    }
  }
});

test('T14 运行日志：一次真实推进的诊断与交付上下文不含完整种子', () => {
  const state = makeState();
  const seed = state.random.master_seed_hex;
  const out = advance({
    state,
    event: null,
    now: isoAfter(state.last_tick_at, 60),
    rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
    modules: [cycleModule, sleepModule, stressModule, eventModule, regulationModule, moodModule, behaviorModule, deliveryModule]
  });
  const surfaces = [
    JSON.stringify(out.diagnostics),
    JSON.stringify(out.delivery),
    JSON.stringify(out.behavior_context)
  ];
  for (const surface of surfaces) {
    assert.equal(surface.includes(seed), false, '诊断/交付/行为上下文不得泄露 master_seed_hex');
    assert.doesNotMatch(surface, /wxid_/i);
  }
});
