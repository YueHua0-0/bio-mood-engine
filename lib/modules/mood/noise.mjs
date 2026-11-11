/**
 * 09 §5.4：`mood` 流的确定性噪声。
 *
 * 固定顺序、每维 2 个 float、每 tick 共 14 个；噪声不乘 alpha，
 * 因此 dt = 0 时仍消耗 14 个 float（事件阶段也要消耗，保证幂等回放）。
 */

import { MOOD_KEYS } from '../../core/constants.mjs';

export const NOISE_AMPLITUDE = 0.008;
export const FLOATS_PER_TICK = MOOD_KEYS.length * 2;

function contractError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  if (details) err.details = details;
  return err;
}

/**
 * @param {{nextFloat:Function}} rng `mood` 流
 * @returns {Record<string, number>} 七维噪声，每维 ∈ [-0.008, 0.008]
 */
export function noiseFor(rng) {
  if (!rng || typeof rng.nextFloat !== 'function') {
    throw contractError('MODULE_FAILED', 'mood noise requires a mood rng stream', {
      module: 'mood',
      path: 'rng'
    });
  }
  const out = {};
  for (const key of MOOD_KEYS) {
    const u1 = rng.nextFloat();
    const u2 = rng.nextFloat();
    out[key] = (u1 + u2 - 1) * NOISE_AMPLITUDE;
  }
  return out;
}
