/**
 * 02 / 03 共用的契约常量。
 *
 * 本文件是 lib/core 内唯一允许出现"魔法数字"的位置。所有上限、默认值、枚举
 * 都必须来自 00-统一契约.md，禁止在下游模块里重复定义。
 */

export const SCHEMA_VERSION = 1;
export const INTERFACE_VERSION = 2;
export const ENGINE_VERSION = '0.1.0';
/** 00 契约文档版本（docs/00 标题行的 vX.Y.Z），仅供装配软检查比对，不参与任何计算。 */
export const CONTRACT_VERSION = 'v1.7.14';

/** v1.7.14 周期情绪参数扩展：cycle.model_version 独立迁移至 2；mood.model_version 同步至 2。 */
export const CYCLE_MODEL_VERSION = 2;
export const MOOD_MODEL_VERSION = 2;
/** 当前配置契约版本：新状态默认值与写路径迁移目标；schema_version 独立保持 1。 */
export const CONFIG_VERSION_AFTER_MIGRATION = 2;

/** 00 §5.4 的固定流水线顺序，调用方不得重排。 */
export const MODULE_ORDER = Object.freeze([
  'cycle',
  'sleep',
  'stress',
  'event',
  'regulation',
  'mood',
  'behavior',
  'delivery'
]);

/** 写回 state 子对象的模块；behavior / delivery 只产出上下文，不写 state。 */
export const MODULE_STATE_KEY = Object.freeze({
  cycle: 'cycle',
  sleep: 'sleep',
  stress: 'stress',
  event: 'stress',
  regulation: 'regulation',
  mood: 'mood',
  behavior: null,
  delivery: null
});

export const LIMITS = Object.freeze({
  maxSteps: 4320,
  maxChunkSeconds: 3600,
  maxSubdivisionsPerChunk: 8,
  clockToleranceMs: 300_000,
  eventTooOldMs: 180 * 86_400_000,
  maxActiveEvents: 32,
  maxWarnings: 16,
  maxReasonCodes: 16,
  eventPruneThreshold: 0.005,
  maxCycleLengthDays: 45,
  minCycleLengthDays: 20
});

/** 00 §7.3 / 02 §5.6：单步变化上限（裁剪档）与硬上限（断言档）。 */
export const DELTA_LIMITS = Object.freeze({
  mood: Object.freeze({ normal: 0.06, severe: 0.12, hard: 0.15 }),
  regulation: Object.freeze({ normal: 0.05, severe: 0.05 }),
  sleepiness: Object.freeze({ normal: 0.20, severe: 0.20 }),
  stress: Object.freeze({ normal: 0.30, severe: 0.30 })
});

/** 09 §4.3：情绪七维的 home 值（粗推进与默认状态共用）。 */
export const MOOD_HOME = Object.freeze({
  energy: 0.60,
  stability: 0.65,
  sensitivity: 0.45,
  social_drive: 0.55,
  stress: 0.15,
  physical_comfort: 0.70,
  closeness_need: 0.45
});

export const MOOD_KEYS = Object.freeze(Object.keys(MOOD_HOME));

/** 08：六个中性调节特征，初始化取 0.5。 */
export const REGULATION_KEYS = Object.freeze([
  'reward_sensitivity',
  'arousal',
  'threat_sensitivity',
  'calm_regulation',
  'social_reassurance_drive',
  'fatigue_load'
]);

export const SLEEP_STATES = Object.freeze([
  'awake',
  'sleepy',
  'trying_to_sleep',
  'sleeping',
  'interrupted',
  'waking_up'
]);

export const CYCLE_PHASES = Object.freeze([
  'menstrual_like',
  'follicular_like',
  'ovulatory_like',
  'luteal_like'
]);

export const CYCLE_LENGTH_SOURCES = Object.freeze(['sampled', 'manual', 'default']);

/**
 * 08 §5.1 周期映射（冻结表）：阶段 -> 四个标量。
 *
 * 02 只用 `cycle_sensitivity` 填充 09 的 `inputs.cycle.scalars`；
 * 08 的 `cycleScalars()` 必须复用本表，禁止另存一份副本（否则两处会漂）。
 */
export const CYCLE_SCALARS = Object.freeze({
  menstrual_like: Object.freeze({
    cycle_reward: 0.35,
    cycle_energy: 0.40,
    cycle_sensitivity: 0.60,
    cycle_social: 0.40
  }),
  follicular_like: Object.freeze({
    cycle_reward: 0.65,
    cycle_energy: 0.62,
    cycle_sensitivity: 0.45,
    cycle_social: 0.60
  }),
  ovulatory_like: Object.freeze({
    cycle_reward: 0.70,
    cycle_energy: 0.58,
    cycle_sensitivity: 0.50,
    cycle_social: 0.65
  }),
  luteal_like: Object.freeze({
    cycle_reward: 0.40,
    cycle_energy: 0.42,
    cycle_sensitivity: 0.62,
    cycle_social: 0.42
  })
});

/** 08 §5.1：阶段缺失或非法时的标量默认值。 */
export const CYCLE_SCALARS_FALLBACK = 0.50;

export const BASE_STREAMS = Object.freeze(['cycle', 'sleep', 'mood', 'event', 'delivery']);

/**
 * 05 §5.3.1 九维阶段矩阵（v1.7.14，周期扩展唯一数据源）。
 *
 * 四阶段 × 九维度：physical_comfort / energy / sensitivity / social_drive
 * （旧四维，energy/sensitivity/social_drive 沿用旧值，physical_comfort 重定义为"非疼痛"语义）
 * + pain_load / anxiety_delta / irritability_delta / positive_affect_delta / intimacy_need_delta（新增五维）。
 *
 * 黄体阶段定版（线上 AI §3.1）：pain_load=0.35 / anxiety_delta=+0.12 / irritability_delta=+0.18。
 */
export const PHASE_IMPACT_MATRIX = Object.freeze({
  menstrual_like: Object.freeze({
    physical_comfort: -0.04, energy: -0.06, sensitivity: +0.05, social_drive: -0.03,
    pain_load: 0.60, anxiety_delta: +0.15, irritability_delta: +0.20, positive_affect_delta: -0.15, intimacy_need_delta: -0.10
  }),
  follicular_like: Object.freeze({
    physical_comfort: +0.05, energy: +0.06, sensitivity: -0.02, social_drive: +0.05,
    pain_load: 0.05, anxiety_delta: -0.10, irritability_delta: -0.10, positive_affect_delta: +0.20, intimacy_need_delta: +0.05
  }),
  ovulatory_like: Object.freeze({
    physical_comfort: +0.03, energy: +0.04, sensitivity: +0.01, social_drive: +0.06,
    pain_load: 0.05, anxiety_delta: -0.05, irritability_delta: -0.05, positive_affect_delta: +0.25, intimacy_need_delta: +0.35
  }),
  luteal_like: Object.freeze({
    physical_comfort: -0.05, energy: -0.04, sensitivity: +0.07, social_drive: -0.02,
    pain_load: 0.35, anxiety_delta: +0.12, irritability_delta: +0.18, positive_affect_delta: -0.10, intimacy_need_delta: -0.05
  })
});

/** 九维字段有序列表（旧四维在前，新五维在后）。 */
export const PHASE_VECTOR_KEYS_V2 = Object.freeze([
  'physical_comfort', 'energy', 'sensitivity', 'social_drive',
  'pain_load', 'anxiety_delta', 'irritability_delta', 'positive_affect_delta', 'intimacy_need_delta'
]);

/** 旧四维字段有序列表（兼容模式）。 */
export const PHASE_VECTOR_KEYS_V1 = Object.freeze([
  'physical_comfort', 'energy', 'sensitivity', 'social_drive'
]);

/** v1.7.14 D1：插件层四个扁平设置键（type=number, 默认 1.0, 范围 [0, 1.5]）。 */
export const CYCLE_PROFILE_DEFAULTS = Object.freeze({
  cyclePainSensitivity: 1.0,
  cycleLutealSensitivity: 1.0,
  cycleMoodVariability: 1.0,
  cycleIntimacyVariability: 1.0
});
export const CYCLE_PROFILE_BOUNDS = Object.freeze({ min: 0, max: 1.5 });

/** 引擎内部 profile 命名（cyclePainSensitivity → pain_sensitivity 等）。 */
export const CYCLE_PROFILE_INTERNAL_KEYS = Object.freeze([
  'pain_sensitivity', 'luteal_sensitivity', 'mood_variability', 'intimacy_variability'
]);

/**
 * 09 §5.2 九个映射系数（v1.7.14 周期扩展）。
 *
 * 这些值来自 09 契约文档，首轮为仿真初值（线上 AI §6.2），后续校准必须走契约变更流程。
 * 集中维护，禁止在 05/09 等多个模块中复制不同数值。
 */
export const CYCLE_CONTRIB_WEIGHTS = Object.freeze({
  w_pain_pc:       { range: [0, 0.30], initial: 0.20 },
  w_pain_energy:   { range: [0, 0.20], initial: 0.10 },
  w_anx_stab:      { range: [0, 0.25], initial: 0.15 },
  w_anx_sens:      { range: [0, 0.20], initial: 0.10 },
  w_irr_stab:      { range: [0, 0.20], initial: 0.12 },
  w_irr_sens:      { range: [0, 0.20], initial: 0.12 },
  w_pos_stab:      { range: [0, 0.20], initial: 0.10 },
  w_pos_social:    { range: [0, 0.20], initial: 0.10 },
  w_intimacy:      { range: [0, 0.35], initial: 0.25 }
});

/** phase_vector 合法形状：恰好四字段（旧版）或恰好九字段（新版）。 */
export const PHASE_VECTOR_ALLOWED_SHAPES = Object.freeze([
  PHASE_VECTOR_KEYS_V1,
  PHASE_VECTOR_KEYS_V2
]);

/** 00 §3.1 的 random 段固定形状。 */
export const RANDOM_ALGORITHM = 'pcg32';
export const RANDOM_ALGORITHM_VERSION = 1;

/**
 * 02 §5.1 的默认状态（首次初始化）。
 *
 * 说明：
 * - cycle 的初始值在 05 接入前使用契约默认（长度 28 天、第 1 天、menstrual_like）；
 *   05 接入后由 05 的初始化逻辑覆盖，本模块只负责形状合法。
 * - planned_wake_at 由 createDefaultState 按本地 07:30 计算（06 §4.3），不放在本常量里。
 * - behavior_context / delivery 不持久化，因此不在默认状态内。
 */
export const DEFAULT_STATE = Object.freeze({
  cycle: Object.freeze({
    cycle_index: 0,
    cycle_length_days: 28,
    // 00 v1.7.6 §3.2：02 不能调用 05 的采样函数，初始态用 default 占位；
    // 首次 updateCycle 必须采样并转 sampled，02 在 advance 末尾断言不得残留 default。
    cycle_length_source: 'default',
    cycle_day: 1,
    phase: 'menstrual_like',
    phase_progress: 0,
    confidence: 0.5,
    model_version: CYCLE_MODEL_VERSION
  }),
  sleep: Object.freeze({
    state: 'awake',
    sleep_debt: 0.15,
    sleep_quality: 0.7,
    sleepiness: 0.25,
    interruption_count: 0,
    recovery_progress: 1,
    last_transition_reason: 'init'
  }),
  stress: Object.freeze({
    level: 0.15,
    model_version: 1
  }),
  regulation: Object.freeze({
    reward_sensitivity: 0.5,
    arousal: 0.5,
    threat_sensitivity: 0.5,
    calm_regulation: 0.5,
    social_reassurance_drive: 0.5,
    fatigue_load: 0.5,
    model_version: 1
  }),
  mood: Object.freeze({
    energy: MOOD_HOME.energy,
    stability: MOOD_HOME.stability,
    sensitivity: MOOD_HOME.sensitivity,
    social_drive: MOOD_HOME.social_drive,
    stress: MOOD_HOME.stress,
    physical_comfort: MOOD_HOME.physical_comfort,
    closeness_need: MOOD_HOME.closeness_need,
    model_version: MOOD_MODEL_VERSION
  })
});

/** 00 §3.1 的顶层键集合（顺序即规范化输出顺序）。 */
export const STATE_KEYS = Object.freeze([
  'schema_version',
  'engine_version',
  'character_id',
  'state_version',
  'created_at',
  'updated_at',
  'last_tick_at',
  'timezone',
  'config_version',
  'cycle',
  'sleep',
  'stress',
  'regulation',
  'mood',
  'random'
]);

/** 00 §3.3 禁止字段（小写精确匹配键名）。 */
export const FORBIDDEN_KEYS = Object.freeze([
  'text',
  'content',
  'body',
  'message_text',
  'wxid',
  'token',
  'access_token',
  'api_key',
  'apikey',
  'password',
  'cookie',
  'secret',
  'diagnosis',
  'hormone_level',
  'phone',
  'address'
]);
