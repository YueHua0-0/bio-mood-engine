/**
 * 14 §5.1 的属性生成器（不引第三方库）。
 *
 * 固定 LC-G 常量，禁止使用系统随机源与系统时钟。失败时必须抛出带
 * `{seed, i, value}` 的可复现信息（14 §6）。
 */

const MULTIPLIER = 1103515245;
const INCREMENT = 12345;
const MODULUS = 0x100000000;

/** 返回第 i 个 `[0,1)` 值，纯函数，不持有全局状态。 */
export function lcgAt(seed, i) {
  let s = seed >>> 0;
  for (let n = 0; n <= i; n += 1) {
    s = (Math.imul(MULTIPLIER, s) + INCREMENT) >>> 0;
  }
  return s / MODULUS;
}

/**
 * @param {number} seed 32 位无符号种子（用例常量，禁止随机）
 * @param {number} n 迭代次数
 * @param {(value:number, index:number) => void} fn
 */
export function forRandom(seed, n, fn) {
  if (!Number.isInteger(seed)) throw new TypeError('seed must be an integer');
  if (!Number.isInteger(n) || n < 0) throw new TypeError('n must be a non-negative integer');
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    s = (Math.imul(MULTIPLIER, s) + INCREMENT) >>> 0;
    const value = s / MODULUS;
    try {
      fn(value, i);
    } catch (err) {
      err.repro = { seed, i, value };
      err.message = `${err.message} [seed=${seed} i=${i} value=${value}]`;
      throw err;
    }
  }
}

/** 固定种子的完整序列，便于断言"同一 seed + n 产生完全相同序列"。 */
export function randomSeries(seed, n) {
  const out = [];
  forRandom(seed, n, (value) => out.push(value));
  return out;
}

/** 把 `[0,1)` 映射到闭区间整数 `[min,max]`。 */
export function randomInt(value, min, max) {
  return min + Math.floor(value * (max - min + 1));
}

/** 把 `[0,1)` 映射到 `[min,max]` 浮点。 */
export function randomFloat(value, min, max) {
  return min + value * (max - min);
}
