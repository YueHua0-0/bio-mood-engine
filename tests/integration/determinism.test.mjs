/**
 * T04：同一 fixture、同一 seed、同一 now：两次推进指纹必须完全一致；
 * 子进程两次运行的摘要也必须一致（排除进程内缓存与模块级可变状态）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { advance } from '../../lib/core/coordinator.mjs';
import { stateFingerprint } from '../../lib/core/models.mjs';
import { RandomProvider } from '../../lib/core/random.mjs';
import { behaviorModule } from '../../lib/modules/behavior/index.mjs';
import { cycleModule } from '../../lib/modules/cycle/index.mjs';
import { deliveryModule } from '../../lib/modules/delivery/index.mjs';
import { moodModule } from '../../lib/modules/mood/index.mjs';
import { regulationModule } from '../../lib/modules/regulation/index.mjs';
import { sleepModule } from '../../lib/modules/sleep/index.mjs';
import { eventModule, stressModule } from '../../lib/modules/stress/index.mjs';

import { isoAfter } from '../helpers/clock.mjs';
import { loadValidState } from '../helpers/state.mjs';

const ROOT = new URL('../../', import.meta.url).href;
const MODULES = [
  cycleModule,
  sleepModule,
  stressModule,
  eventModule,
  regulationModule,
  moodModule,
  behaviorModule,
  deliveryModule
];
const CHILD_SCRIPT = `
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const root = payload.root;
const { advance } = await import(root + 'lib/core/coordinator.mjs');
const { stateFingerprint } = await import(root + 'lib/core/models.mjs');
const { RandomProvider } = await import(root + 'lib/core/random.mjs');
const mods = await Promise.all([
  import(root + 'lib/modules/cycle/index.mjs'),
  import(root + 'lib/modules/sleep/index.mjs'),
  import(root + 'lib/modules/stress/index.mjs'),
  import(root + 'lib/modules/regulation/index.mjs'),
  import(root + 'lib/modules/mood/index.mjs'),
  import(root + 'lib/modules/behavior/index.mjs'),
  import(root + 'lib/modules/delivery/index.mjs')
]);
const modules = [
  mods[0].cycleModule,
  mods[1].sleepModule,
  mods[2].stressModule,
  mods[2].eventModule,
  mods[3].regulationModule,
  mods[4].moodModule,
  mods[5].behaviorModule,
  mods[6].deliveryModule
];
const state = payload.state;
const out = advance({
  state,
  event: payload.event,
  now: payload.now,
  rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
  modules
});
process.stdout.write(JSON.stringify({
  fingerprint: stateFingerprint(out.state),
  state: out.state,
  behavior_context: out.behavior_context,
  delivery: out.delivery,
  warnings: out.diagnostics.warnings
}));
`;

function runOnce() {
  const state = loadValidState();
  const now = isoAfter(state.last_tick_at, 300);
  return advance({
    state,
    event: JSON.parse(readFileSync(new URL('../fixtures/events/direct_question.json', import.meta.url), 'utf8')),
    now,
    rngProvider: RandomProvider.fromPersisted({ random: state.random, character_id: state.character_id }),
    modules: MODULES
  });
}

function runInChild() {
  const state = loadValidState();
  const payload = {
    root: ROOT,
    state,
    now: isoAfter(state.last_tick_at, 300),
    event: JSON.parse(readFileSync(new URL('../fixtures/events/direct_question.json', import.meta.url), 'utf8'))
  };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(child.status, 0, `子进程失败：${child.stderr}`);
  return JSON.parse(child.stdout);
}

test('T04 确定性：同 fixture 两次推进 → 状态指纹相等且逐字节一致', () => {
  const first = runOnce();
  const second = runOnce();
  assert.equal(stateFingerprint(first.state), stateFingerprint(second.state));
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.delivery, second.delivery);
  assert.deepEqual(first.behavior_context, second.behavior_context);
});

test('T04 确定性：子进程两次摘要相等，且与进程内结果一致', () => {
  const local = runOnce();
  const a = runInChild();
  const b = runInChild();
  assert.equal(a.fingerprint, b.fingerprint, '两次子进程指纹必须一致');
  assert.deepEqual(a.state, b.state);
  assert.equal(a.fingerprint, stateFingerprint(local.state), '子进程与进程内结果必须一致');
  assert.deepEqual(a.delivery, local.delivery);
});
