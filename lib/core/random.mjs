/**
 * 03 · 随机种子与 PRNG（PCG32 / XSH RR）。
 *
 * 实现选项声明（03 §5.7 要求二选一并在文件顶部声明）：
 *   本实现选择「快进 counter 次」恢复，不额外保存 pcg_state_hex。
 *   单流快进上限 MAX_FAST_FORWARD = 5_000_000，超过视为数据损坏。
 *
 * 不变量：
 * - 播种期间的两次步进不计入 counter；播种结束后 counter === 0。
 * - nextU32() 先自增 counter 再返回，故调用后 counter 表示"已消耗的业务随机数个数"。
 * - 所有 64 位运算使用 BigInt。
 */

import { createHash } from 'node:crypto';

import {
  BASE_STREAMS,
  RANDOM_ALGORITHM,
  RANDOM_ALGORITHM_VERSION
} from './constants.mjs';

const MASK64 = (1n << 64n) - 1n;
const MULT = 6364136223846793005n;
const MASK32 = 0xFFFFFFFFn;
const U32_RANGE = 4_294_967_296;

/**
 * LCG 状态跳跃（pcg_advance_lcg_64 的 BigInt 等价实现）。
 *
 * 状态转移是仿射变换 `state ↦ state·MULT + inc`，可直接做二进制幂：
 * 组合 (a, b) 表示 `state ↦ state·a + b`，与单步 (MULT, inc) 复合得到
 * n 步后的状态。O(log n) 次 BigInt 运算，结果与循环调用 `_step()` n 次
 * 逐位一致（同一条 PCG32 输出序列），仅把 O(n) 恢复降到 O(log n)。
 */
function advanceState(state, inc, delta) {
  let accMult = 1n;
  let accPlus = 0n;
  let curMult = MULT;
  let curPlus = inc;
  let remaining = BigInt(delta);
  while (remaining > 0n) {
    if (remaining & 1n) {
      accMult = (accMult * curMult) & MASK64;
      accPlus = (accPlus * curMult + curPlus) & MASK64;
    }
    curPlus = ((curMult + 1n) * curPlus) & MASK64;
    curMult = (curMult * curMult) & MASK64;
    remaining >>= 1n;
  }
  return (accMult * state + accPlus) & MASK64;
}

export const MAX_FAST_FORWARD = 5_000_000;

/**
 * P-13-16 / RFC 7693：BLAKE2b-512 的纯 JS 实现（仅在宿主 runtime 不提供
 * `blake2b512` 摘要时启用）。宿主 Electron 的 BoringSSL 报告 `openssl 0.0.0`，
 * `createHash('blake2b512')` 会抛 "Digest method not supported"，导致首次
 * observe 在播种阶段以 MODULE_FAILED 降级。本实现与 OpenSSL 输出逐位一致。
 */
const BLAKE2B_IV = Object.freeze([
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
]);

const BLAKE2B_SIGMA = Object.freeze([
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
]);

const BLAKE2B_BLOCK = 128;

function rotr64(value, shift) {
  return ((value >> shift) | (value << (64n - shift))) & MASK64;
}

function blake2bCompress(h, block, counter, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i += 1) {
    let word = 0n;
    for (let j = 7; j >= 0; j -= 1) word = (word << 8n) | BigInt(block[i * 8 + j]);
    m[i] = word;
  }
  const v = new Array(16);
  for (let i = 0; i < 8; i += 1) {
    v[i] = h[i];
    v[i + 8] = BLAKE2B_IV[i];
  }
  v[12] ^= counter & MASK64;
  v[13] ^= (counter >> 64n) & MASK64;
  if (last) v[14] ^= MASK64;

  const mix = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };

  for (let r = 0; r < 12; r += 1) {
    const s = BLAKE2B_SIGMA[r % 10];
    mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i += 1) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b-512 → 128 位小写十六进制；与 `createHash('blake2b512')` 逐位一致。 */
export function blake2b512Hex(message) {
  const data = new TextEncoder().encode(String(message));
  const h = BLAKE2B_IV.slice();
  // digest_length=64, key_length=0, fanout=1, depth=1。
  h[0] ^= 0x01010040n;

  const total = data.length;
  const blocks = Math.max(1, Math.ceil(total / BLAKE2B_BLOCK));
  let counter = 0n;
  for (let i = 0; i < blocks; i += 1) {
    const start = i * BLAKE2B_BLOCK;
    const len = Math.max(0, Math.min(BLAKE2B_BLOCK, total - start));
    const block = new Uint8Array(BLAKE2B_BLOCK);
    block.set(data.subarray(start, start + len));
    counter += BigInt(len);
    blake2bCompress(h, block, counter, i === blocks - 1);
  }

  let hex = '';
  for (const word of h) {
    for (let j = 0; j < 8; j += 1) {
      hex += ((word >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/** 优先用 OpenSSL；宿主 runtime 缺摘要算法时退回纯 JS（P-13-16）。 */
function blake2b512Of(message) {
  try {
    return createHash('blake2b512').update(message, 'utf8').digest('hex');
  } catch {
    return blake2b512Hex(message);
  }
}


const HEX32_RE = /^[0-9a-f]{32}$/;
const CHARACTER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const STREAM_LABEL_RE = /^[a-z0-9:_-]{1,96}$/;

const ALGORITHM = RANDOM_ALGORITHM;
const ALGORITHM_VERSION = RANDOM_ALGORITHM_VERSION;

function randomError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

function assertMasterSeed(value) {
  if (typeof value !== 'string' || !HEX32_RE.test(value)) {
    throw randomError('INVALID_REQUEST', 'master_seed_hex must be 32 lowercase hex characters', {
      path: 'master_seed_hex'
    });
  }
}

function assertCharacterId(value) {
  if (typeof value !== 'string' || !CHARACTER_ID_RE.test(value)) {
    throw randomError('INVALID_REQUEST', 'character_id must match ^[a-z][a-z0-9_-]{0,63}$', {
      path: 'character_id'
    });
  }
}

function assertStreamLabel(value) {
  if (typeof value !== 'string' || !STREAM_LABEL_RE.test(value)) {
    throw randomError('INVALID_REQUEST', 'stream_label must match ^[a-z0-9:_-]{1,96}$', {
      path: 'stream_label',
      got: String(value)
    });
  }
}

function assertSeedHex(value) {
  if (typeof value !== 'string' || !HEX32_RE.test(value)) {
    throw randomError('MODULE_FAILED', 'seed_hex must be 32 lowercase hex characters', {
      path: 'seed_hex',
      reason: 'corrupted_state'
    });
  }
}

/**
 * 00 §6.2 / 03 §5.5：BLAKE2b-512 派生，取前 32 个十六进制字符。
 * @returns {{seed_hex:string, message:string}}
 */
export function deriveSeed({ master_seed_hex, character_id, stream_label, algorithm_version = ALGORITHM_VERSION }) {
  assertMasterSeed(master_seed_hex);
  assertCharacterId(character_id);
  assertStreamLabel(stream_label);
  if (algorithm_version !== ALGORITHM_VERSION) {
    throw randomError('MODULE_FAILED', `unsupported algorithm_version: ${algorithm_version}`, {
      algorithm_version,
      supported: ALGORITHM_VERSION
    });
  }
  const message = `${master_seed_hex}|${character_id}|${stream_label}|${algorithm_version}`;
  const digest = blake2b512Of(message);
  return { seed_hex: digest.slice(0, 32), message };
}

export class Pcg32 {
  /**
   * @param {{initstate:bigint|number|string, initseq:bigint|number|string, seed_hex?:string}} params
   */
  constructor({ initstate, initseq, seed_hex = null }) {
    this._state = 0n;
    this._inc = ((BigInt(initseq) << 1n) | 1n) & MASK64;
    this._counter = 0;
    this._seedHex = seed_hex;
    // 播种两次步进不计入业务计数（03 §5.2）。
    this._step();
    this._state = (this._state + BigInt(initstate)) & MASK64;
    this._step();
  }

  static fromSeedHex(seed_hex) {
    assertSeedHex(seed_hex);
    return new Pcg32({
      initstate: BigInt(`0x${seed_hex.slice(0, 16)}`),
      initseq: BigInt(`0x${seed_hex.slice(16)}`),
      seed_hex
    });
  }

  _step() {
    const old = this._state;
    this._state = (old * MULT + this._inc) & MASK64;
    const xorshifted = (((old >> 18n) ^ old) >> 27n) & MASK32;
    const rot = Number(old >> 59n);
    const value = ((xorshifted >> BigInt(rot)) | (xorshifted << BigInt((-rot) & 31))) & MASK32;
    return Number(value);
  }

  nextU32() {
    this._counter += 1;
    return this._step();
  }

  nextFloat() {
    return this.nextU32() / U32_RANGE;
  }

  nextRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
      throw randomError('INVALID_REQUEST', 'nextRange requires finite min < max', {
        min,
        max
      });
    }
    return min + (max - min) * this.nextFloat();
  }

  nextInt(minInclusive, maxInclusive) {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive) || minInclusive > maxInclusive) {
      throw randomError('INVALID_REQUEST', 'nextInt requires integers with min <= max', {
        min: minInclusive,
        max: maxInclusive
      });
    }
    return minInclusive + Math.floor(this.nextFloat() * (maxInclusive - minInclusive + 1));
  }

  /** 均值 0、标准差 1；固定消耗 2 个 u32，结果裁剪到 [-3.5, 3.5]（03 §5.4）。 */
  nextNormal() {
    let u1 = this.nextFloat();
    const u2 = this.nextFloat();
    if (u1 < 1e-12) u1 = 1e-12;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(3.5, Math.max(-3.5, z));
  }

  get counter() {
    return this._counter;
  }

  get seedHex() {
    return this._seedHex;
  }

  /** 快进 n 次 nextU32，消耗计入 counter。等价于循环 `_step()` n 次，但为 O(log n)。 */
  fastForward(steps) {
    if (!Number.isInteger(steps) || steps < 0) {
      throw randomError('MODULE_FAILED', 'counter must be a non-negative integer', {
        reason: 'corrupted_counter',
        got: steps
      });
    }
    if (steps > MAX_FAST_FORWARD) {
      throw randomError('MODULE_FAILED', 'counter exceeds the fast-forward limit', {
        reason: 'counter_too_large',
        counter: steps,
        max: MAX_FAST_FORWARD
      });
    }
    if (steps > 0) this._state = advanceState(this._state, this._inc, steps);
    this._counter = steps;
  }

  exportState() {
    return { seed_hex: this._seedHex, counter: this._counter };
  }
}

/**
 * RandomProvider 是单次 advance() 内唯一可变状态持有者（00 §11.4 方案 A）。
 */
export class RandomProvider {
  /**
   * @param {{master_seed_hex:string, character_id:string, algorithm_version?:number,
   *          streams?:Record<string,{seed_hex:string,counter:number}>}} params
   */
  constructor({ master_seed_hex, character_id, algorithm_version = ALGORITHM_VERSION, streams = null }) {
    assertMasterSeed(master_seed_hex);
    assertCharacterId(character_id);
    if (algorithm_version !== ALGORITHM_VERSION) {
      throw randomError('MODULE_FAILED', `unsupported algorithm_version: ${algorithm_version}`, {
        algorithm_version,
        supported: ALGORITHM_VERSION
      });
    }
    this.master_seed_hex = master_seed_hex;
    this.character_id = character_id;
    this.algorithm_version = algorithm_version;
    this._streams = new Map();
    if (streams) {
      for (const [label, entry] of Object.entries(streams)) {
        assertStreamLabel(label);
        assertSeedHex(entry?.seed_hex);
        const pcg = Pcg32.fromSeedHex(entry.seed_hex);
        pcg.fastForward(entry.counter ?? 0);
        this._streams.set(label, pcg);
      }
    }
  }

  stream(label) {
    assertStreamLabel(label);
    const cached = this._streams.get(label);
    if (cached) return cached;
    const { seed_hex } = deriveSeed({
      master_seed_hex: this.master_seed_hex,
      character_id: this.character_id,
      stream_label: label,
      algorithm_version: this.algorithm_version
    });
    const pcg = Pcg32.fromSeedHex(seed_hex);
    this._streams.set(label, pcg);
    return pcg;
  }

  /** 完整内存快照（含 character_id），仅用于同一次 advance 内的丢弃重算。 */
  serialize() {
    return {
      algorithm: ALGORITHM,
      algorithm_version: this.algorithm_version,
      character_id: this.character_id,
      master_seed_hex: this.master_seed_hex,
      streams: this._dumpStreams()
    };
  }

  static restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw randomError('MODULE_FAILED', 'random snapshot must be an object', {
        reason: 'invalid_snapshot'
      });
    }
    return new RandomProvider({
      master_seed_hex: snapshot.master_seed_hex,
      character_id: snapshot.character_id,
      algorithm_version: snapshot.algorithm_version ?? ALGORITHM_VERSION,
      streams: snapshot.streams
    });
  }

  _dumpStreams() {
    const out = {};
    for (const [label, pcg] of this._streams.entries()) {
      out[label] = pcg.exportState();
    }
    return out;
  }

  /**
   * 与 00 §3.1 的 state.random 同形：只包含五条基础流。
   * 临时流（cycle:3 / event:evt_x）不持久化（03 §5.6）。
   */
  toPersisted() {
    const streams = {};
    for (const label of BASE_STREAMS) {
      const pcg = this.stream(label);
      streams[label] = pcg.exportState();
    }
    return {
      algorithm: ALGORITHM,
      algorithm_version: this.algorithm_version,
      master_seed_hex: this.master_seed_hex,
      streams
    };
  }

  static fromPersisted({ random, character_id }) {
    if (!random || typeof random !== 'object') {
      throw randomError('INVALID_REQUEST', 'random is required to restore a provider', {
        path: 'random'
      });
    }
    if (random.algorithm !== undefined && random.algorithm !== ALGORITHM) {
      throw randomError('MODULE_FAILED', `unsupported algorithm: ${random.algorithm}`, {
        algorithm: random.algorithm
      });
    }
    return new RandomProvider({
      master_seed_hex: random.master_seed_hex,
      character_id,
      algorithm_version: random.algorithm_version ?? ALGORITHM_VERSION,
      streams: random.streams
    });
  }

  snapshotCounters() {
    const out = {};
    for (const [label, pcg] of this._streams.entries()) out[label] = pcg.counter;
    return out;
  }
}

/**
 * 仅在初始化时由调用方提供熵源（Uint8Array 或 32 位十六进制字符串）。
 * 本模块不读取系统熵（03 §2 非目标）。
 */
export function createMasterSeed(entropy) {
  if (entropy instanceof Uint8Array) {
    if (entropy.length < 16) {
      throw randomError('INVALID_REQUEST', 'entropy must provide at least 16 bytes', {
        length: entropy.length
      });
    }
    let hex = '';
    for (let i = 0; i < 16; i += 1) hex += entropy[i].toString(16).padStart(2, '0');
    return hex;
  }
  if (typeof entropy === 'string') {
    const lower = entropy.toLowerCase();
    assertMasterSeed(lower);
    return lower;
  }
  throw randomError('INVALID_REQUEST', 'entropy must be a 16-byte Uint8Array or 32 hex characters', {
    got: typeof entropy
  });
}
