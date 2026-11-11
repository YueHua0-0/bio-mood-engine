/** 03 §6 的金向量常量，供多个模块的单元测试复用。 */

export const MASTER_SEED = '000102030405060708090a0b0c0d0e0f';
export const CHARACTER_ID = 'whale_character';

/** PCG 官方参考向量（03 §6.1）。 */
export const REFERENCE = Object.freeze({
  initstate: 42n,
  initseq: 54n,
  u32: [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e]
});

/** 项目派生向量：cycle 流（03 §6.2）。 */
export const CYCLE_VECTOR = Object.freeze({
  stream_label: 'cycle',
  seed_hex: '764d289e285a86b68df58ef666b4c9ab',
  initstate: 0x764d289e285a86b6n,
  initseq: 0x8df58ef666b4c9abn,
  u32: [0x3e60b694, 0x5b31491f, 0x28f715f3, 0x15b85784, 0x3803ea34],
  floats: [0.243663226, 0.356220789, 0.160020229, 0.084844084, 0.218809736]
});

/** 其余四条基础流的期望 seed_hex（03 §6.3）。 */
export const BASE_STREAM_SEEDS = Object.freeze({
  sleep: '2a335db9e807acd15ced81dd3d031dd0',
  mood: 'ecf6bd05e6e6f015b0a1d365b8c07051',
  event: '9398027bcf759ae763ab788570dbeb47',
  delivery: '09a2ee87bac47513794a69b42e3b6e80'
});
