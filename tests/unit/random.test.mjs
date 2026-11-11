import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  BASE_STREAM_SEEDS,
  CHARACTER_ID,
  CYCLE_VECTOR,
  MASTER_SEED,
  REFERENCE
} from './_random_vectors.mjs';

import {
  MAX_FAST_FORWARD,
  Pcg32,
  RandomProvider,
  blake2b512Hex,
  createMasterSeed,
  deriveSeed
} from '../../lib/core/random.mjs';

function approx(actual, expected, digits = 9) {
  assert.equal(Number(actual.toFixed(digits)), expected, `${actual} != ${expected}`);
}

test('R00 P-13-16 纯 JS BLAKE2b-512 与 node:crypto 逐位一致', () => {
  // 宿主 Electron 的 BoringSSL 无 OpenSSL（openssl 0.0.0），blake2b512 不可用，
  // deriveSeed 会退回 blake2b512Hex；两者必须在所有分组边界上完全相同。
  const messages = ['', 'abc', 'x'.repeat(127), 'x'.repeat(128), 'x'.repeat(129), 'x'.repeat(1000)];
  for (const message of messages) {
    const native = createHash('blake2b512').update(message, 'utf8').digest('hex');
    assert.equal(blake2b512Hex(message), native, `length=${message.length}`);
  }
  assert.equal(
    blake2b512Hex('abc'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    'RFC 7693 abc 向量'
  );
});

test('R01 PCG 官方参考向量 42/54', () => {
  const pcg = new Pcg32({ initstate: REFERENCE.initstate, initseq: REFERENCE.initseq });
  const got = [];
  for (let i = 0; i < 6; i += 1) got.push(pcg.nextU32());
  assert.deepEqual(got, REFERENCE.u32);
});

test('R02 派生 cycle 流的 seed_hex', () => {
  const { seed_hex } = deriveSeed({
    master_seed_hex: MASTER_SEED,
    character_id: CHARACTER_ID,
    stream_label: 'cycle'
  });
  assert.equal(seed_hex, CYCLE_VECTOR.seed_hex);
});

test('R03 cycle 流前 5 个 u32', () => {
  const pcg = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  const got = [];
  for (let i = 0; i < 5; i += 1) got.push(pcg.nextU32());
  assert.deepEqual(got, CYCLE_VECTOR.u32);
});

test('R04 cycle 流前 5 个 float（9 位小数）', () => {
  const pcg = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  for (let i = 0; i < CYCLE_VECTOR.floats.length; i += 1) {
    approx(pcg.nextFloat(), CYCLE_VECTOR.floats[i]);
  }
});

test('R05 其余四条基础流的 seed_hex', () => {
  for (const [label, expected] of Object.entries(BASE_STREAM_SEEDS)) {
    const { seed_hex } = deriveSeed({
      master_seed_hex: MASTER_SEED,
      character_id: CHARACTER_ID,
      stream_label: label
    });
    assert.equal(seed_hex, expected, `stream ${label}`);
  }
});

test('R06 deriveSeed 是纯函数', () => {
  const args = { master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID, stream_label: 'mood' };
  assert.deepEqual(deriveSeed(args), deriveSeed(args));
});

test('R07 改变 character_id 会改变 seed_hex', () => {
  const base = deriveSeed({ master_seed_hex: MASTER_SEED, character_id: 'whale_character', stream_label: 'mood' });
  const other = deriveSeed({ master_seed_hex: MASTER_SEED, character_id: 'otter_character', stream_label: 'mood' });
  assert.notEqual(base.seed_hex, other.seed_hex);
});

test('R08 改变 algorithm_version 会改变 seed_hex 或拒绝对应版本', () => {
  const v1 = deriveSeed({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID, stream_label: 'mood' });
  assert.throws(
    () => deriveSeed({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID, stream_label: 'mood', algorithm_version: 2 }),
    /unsupported algorithm_version/
  );
  assert.equal(v1.seed_hex, BASE_STREAM_SEEDS.mood);
});

test('R09 流隔离：先消耗 mood 100 个数不影响 cycle', () => {
  const provider = new RandomProvider({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID });
  const mood = provider.stream('mood');
  for (let i = 0; i < 100; i += 1) mood.nextU32();
  const cycle = provider.stream('cycle');
  const got = [];
  for (let i = 0; i < 5; i += 1) got.push(cycle.nextU32());
  assert.deepEqual(got, CYCLE_VECTOR.u32);
});

test('R10 counter 语义：播种后 0，一次 nextU32 后 1', () => {
  const pcg = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  assert.equal(pcg.counter, 0);
  pcg.nextU32();
  assert.equal(pcg.counter, 1);
});

test('R11 exportState → restore → 下一个数一致', () => {
  const pcg = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  pcg.nextU32();
  const restored = Pcg32.fromSeedHex(pcg.exportState().seed_hex);
  restored.fastForward(pcg.exportState().counter);
  assert.equal(restored.nextU32(), pcg.nextU32());
  assert.equal(restored.counter, pcg.counter);
});

test('R12 快进 10 万次后恢复一致且 < 300ms', () => {
  const started = process.hrtime.bigint();
  const pcg = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  pcg.fastForward(100_000);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(pcg.counter, 100_000);
  assert.ok(elapsedMs < 300, `fast-forward took ${elapsedMs.toFixed(1)}ms`);

  const replay = Pcg32.fromSeedHex(CYCLE_VECTOR.seed_hex);
  for (let i = 0; i < 100_000; i += 1) replay.nextU32();
  assert.equal(replay.nextU32(), pcg.nextU32());
});

test('R13 nextNormal 10 万次的均值/标准差/范围', () => {
  const pcg = Pcg32.fromSeedHex(BASE_STREAM_SEEDS.mood);
  const n = 100_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const z = pcg.nextNormal();
    assert.ok(z >= -3.5 && z <= 3.5, `out of range: ${z}`);
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const sd = Math.sqrt(variance);
  assert.ok(mean >= -0.02 && mean <= 0.02, `mean ${mean}`);
  assert.ok(sd >= 0.97 && sd <= 1.03, `sd ${sd}`);
});

test('R13b nextNormal 每次恰好消耗 2 个 u32', () => {
  const pcg = Pcg32.fromSeedHex(BASE_STREAM_SEEDS.mood);
  for (let i = 0; i < 1000; i += 1) pcg.nextNormal();
  assert.equal(pcg.counter, 2000);
});

test('R14 nextFloat 100 万次全部落在 [0,1)', () => {
  const pcg = Pcg32.fromSeedHex(BASE_STREAM_SEEDS.event);
  for (let i = 0; i < 1_000_000; i += 1) {
    const value = pcg.nextFloat();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test('R15 nextInt(1,6) 分布均匀（6 万次，偏差 < 8%）', () => {
  const pcg = Pcg32.fromSeedHex(BASE_STREAM_SEEDS.delivery);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const n = 60_000;
  for (let i = 0; i < n; i += 1) counts[pcg.nextInt(1, 6)] += 1;
  for (const [face, count] of Object.entries(counts)) {
    const deviation = Math.abs(count - n / 6) / (n / 6);
    assert.ok(deviation < 0.08, `face ${face} deviation ${(deviation * 100).toFixed(2)}%`);
  }
});

test('R16 nextRange 全部落在区间内', () => {
  const pcg = Pcg32.fromSeedHex(BASE_STREAM_SEEDS.sleep);
  for (let i = 0; i < 1000; i += 1) {
    const value = pcg.nextRange(0.2, 0.8);
    assert.ok(value >= 0.2 && value < 0.8, `out of range: ${value}`);
  }
  assert.throws(() => pcg.nextRange(1, 1), /finite min < max/);
});

test('R17 counter 超过快进上限时抛 MODULE_FAILED', () => {
  assert.throws(
    () => new RandomProvider({
      master_seed_hex: MASTER_SEED,
      character_id: CHARACTER_ID,
      streams: {
        cycle: { seed_hex: CYCLE_VECTOR.seed_hex, counter: MAX_FAST_FORWARD + 1 },
        sleep: { seed_hex: BASE_STREAM_SEEDS.sleep, counter: 0 },
        mood: { seed_hex: BASE_STREAM_SEEDS.mood, counter: 0 },
        event: { seed_hex: BASE_STREAM_SEEDS.event, counter: 0 },
        delivery: { seed_hex: BASE_STREAM_SEEDS.delivery, counter: 0 }
      }
    }),
    (err) => err.code === 'MODULE_FAILED' && err.details.reason === 'counter_too_large'
  );
});

test('R18 非法种子/标签抛 INVALID_REQUEST', () => {
  assert.throws(
    () => deriveSeed({ master_seed_hex: 'zz', character_id: CHARACTER_ID, stream_label: 'mood' }),
    (err) => err.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => deriveSeed({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID, stream_label: 'Bad Label' }),
    (err) => err.code === 'INVALID_REQUEST'
  );
});

test('R19 toPersisted 与 00 §3.1 的 random 同形且可序列化', () => {
  const provider = new RandomProvider({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID });
  provider.stream('mood').nextU32();
  provider.stream('cycle:3').nextU32();
  const persisted = provider.toPersisted();
  assert.deepEqual(Object.keys(persisted).sort(), ['algorithm', 'algorithm_version', 'master_seed_hex', 'streams']);
  assert.deepEqual(Object.keys(persisted.streams).sort(), ['cycle', 'delivery', 'event', 'mood', 'sleep']);
  assert.equal(persisted.streams.mood.counter, 1);
  assert.doesNotThrow(() => JSON.stringify(persisted));

  const snapshot = provider.serialize();
  assert.equal(snapshot.character_id, CHARACTER_ID);
  assert.ok(snapshot.streams['cycle:3']);
  // 临时流不进入持久化形状
  assert.equal(persisted.streams['cycle:3'], undefined);
});

test('R20 五个流各自独立计数', () => {
  const provider = new RandomProvider({ master_seed_hex: MASTER_SEED, character_id: CHARACTER_ID });
  provider.stream('sleep').nextU32();
  provider.stream('sleep').nextU32();
  provider.stream('mood').nextU32();
  assert.deepEqual(provider.snapshotCounters(), { sleep: 2, mood: 1 });
  assert.equal(provider.toPersisted().streams.delivery.counter, 0);
});

test('createMasterSeed 只接受调用方提供的熵源', () => {
  const bytes = new Uint8Array(16).fill(0xab);
  assert.equal(createMasterSeed(bytes), 'ab'.repeat(16));
  assert.equal(createMasterSeed('00112233445566778899AABBCCDDEEFF'), '00112233445566778899aabbccddeeff');
  assert.throws(() => createMasterSeed(new Uint8Array(4)), /at least 16 bytes/);
});

test('R21 04/13 的种子生成入口输出恒为 32 位小写十六进制（P-04-02）', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(createMasterSeed(randomBytes(16)), /^[0-9a-f]{32}$/);
  }
});
