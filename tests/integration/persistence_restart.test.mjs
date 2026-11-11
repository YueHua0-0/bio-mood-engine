/**
 * T09：写入 → 新进程读取 → 指纹一致；损坏 state 明确报错；meta 丢失不覆盖已有 state。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { stateFingerprint } from '../../lib/core/models.mjs';

import { CHARACTER_ID, FIXED_NOW, memoryRepo } from '../helpers/repo.mjs';
import { loadValidState } from '../helpers/state.mjs';

const ROOT = new URL('../../', import.meta.url).href;
const CHILD_SCRIPT = `
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const root = payload.root;
const { createRepository } = await import(root + 'lib/storage/repository.mjs');
const { stateFingerprint } = await import(root + 'lib/core/models.mjs');
const data = new Map(Object.entries(payload.dump));
const storage = {
  async get(key) { return data.has(key) ? data.get(key) : null; },
  async set(key, value) { data.set(key, value); },
  async delete(key) { data.delete(key); }
};
const repo = createRepository({
  storage,
  character_id: payload.character_id,
  clock: () => payload.now,
  id_factory: (() => { let n = 0; return () => 'tx_' + String((n += 1)).padStart(4, '0'); })()
});
const loaded = await repo.loadState(payload.character_id);
const evlog = JSON.parse(data.get('evlog') ?? '[]');
const idem = JSON.parse(data.get('idem') ?? '[]');
process.stdout.write(JSON.stringify({
  fingerprint: stateFingerprint(loaded),
  version: loaded.state_version,
  evlog: evlog.length,
  idem: idem.length
}));
`;

function bumped(state) {
  return {
    ...state,
    state_version: state.state_version + 1,
    updated_at: FIXED_NOW,
    last_tick_at: FIXED_NOW
  };
}

async function writeOne(repo) {
  return repo.transaction(async (tx) => {
    const current = await tx.getState(CHARACTER_ID);
    await tx.putState(bumped(current.state), current.version);
    await tx.appendEvent({
      event_id: 'evt_20261109_restart01',
      event_type: 'group_message',
      occurred_at: '2026-11-09T09:19:00.000Z',
      processed_at: FIXED_NOW,
      source_key: 'wechat:group_123:sender_a1',
      intensity: 0.02,
      idempotency_key: 'evt_20261109_restart01',
      state_version_before: current.version,
      state_version_after: current.version + 1
    });
    await tx.appendIdempotency({
      key: 'evt_20261109_restart01',
      character_id: CHARACTER_ID,
      result: { delivery: { policy: 'deliver_now' } },
      expires_at: '2026-11-16T09:20:01.000Z'
    });
    return { version: current.version + 1 };
  });
}

test('T09 持久化：写入后由子进程读取，版本、指纹、evlog、idem 均一致', async () => {
  const { repo, storage } = memoryRepo({ initial: { state: loadValidState() } });
  const written = await writeOne(repo);
  assert.equal(written.version, 43);

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    input: JSON.stringify({
      root: ROOT,
      dump: storage.dump(),
      character_id: CHARACTER_ID,
      now: FIXED_NOW
    }),
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(child.status, 0, `子进程失败：${child.stderr}`);
  const out = JSON.parse(child.stdout);
  assert.equal(out.version, 43);
  assert.equal(out.fingerprint, stateFingerprint(storage.json('state')));
  assert.equal(out.evlog, 1);
  assert.equal(out.idem, 1);

  const reopened = memoryRepo({ initial: storage.dump() });
  const loaded = await reopened.repo.loadState(CHARACTER_ID);
  assert.equal(loaded.state_version, 43);
  assert.equal(stateFingerprint(loaded), out.fingerprint);
});

test('T09 损坏 state：读取必须明确报错，不得静默重建', async () => {
  const { repo, storage } = memoryRepo();
  await storage.set('state', '{"schema_version":1,');
  await assert.rejects(
    () => repo.loadState(CHARACTER_ID),
    (err) => {
      assert.ok(err && typeof err.code === 'string', '错误必须带稳定 code');
      assert.notEqual(err.code, 'INVALID_REQUEST', '损坏数据不能伪装成请求参数错误');
      return true;
    }
  );
  assert.equal(storage.raw('state'), '{"schema_version":1,', '失败路径不得覆盖原始损坏数据');
});

test('T09 meta 丢失：首次打开已有 state 时按已有版本继续，不覆盖状态', async () => {
  const initial = loadValidState();
  const { repo, storage } = memoryRepo({ initial: { state: initial } });
  const loaded = await repo.loadState(CHARACTER_ID);
  assert.equal(loaded.state_version, initial.state_version);
  assert.deepEqual(loaded, initial);
  assert.deepEqual(storage.json('state'), initial);
});


