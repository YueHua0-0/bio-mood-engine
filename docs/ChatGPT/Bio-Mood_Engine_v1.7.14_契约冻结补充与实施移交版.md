# Bio-Mood Engine：月经周期情绪参数扩展方案

## v1.7.14 契约冻结补充与实施移交版

> 文档用途：交给桌面 Agent / 实施 Agent，作为 v1.7.14
> 契约修订与后续分阶段实现依据。\
> 项目：`YueHua0-0/bio-mood-engine`\
> 版本目标：统一契约 `v1.7.14`\
> 状态：**算法设计冻结；完成本文规定的契约修订和一致性审查后，方可正式冻结并实施。**\
> 本文只规定设计、边界、接口、迁移和验收要求，不授权 Agent
> 擅自扩大范围。

------------------------------------------------------------------------

## 0. 移交总指令

本轮设计不再扩展参数、不重新讨论算法主体。实施 Agent
必须按本文和正式统一契约工作；遇到代码与契约不一致时，先记录差异，不得自行选择一种解释继续实现。

必须遵守以下架构边界：

-   **WeChatAgent
    插件**负责事件采集、参数规范化、转发、接收策略和执行发送/排队/静默/唤醒候选，并回报投递结果。
-   **Bio-Mood
    Engine**是唯一权威状态源，负责时间推进、周期、睡眠、压力、调节、情绪及行为倾向的状态计算。
-   **DSH**消费角色卡、关系、上下文、群规则和引擎状态摘要，负责是否回应及自然语言生成。
-   插件只执行交付，不计算情绪；DSH
    不计算或持久化引擎状态；引擎不生成自然语言。
-   角色卡硬规则和安全规则优先于模拟状态。
-   周期、睡眠和情绪参数均为虚构角色状态模拟，不是医学模型、诊断或真实生理预测模型。
-   本轮未经明确授权，不修改仓库、不提交、不发布、不擅自改变既有 API
    行为。

### 0.1 实施顺序

``` text
契约修订与版本冻结
    ↓
05 周期模块实现
    ↓
05 契约测试
    ↓
09 情绪模块实现
    ↓
09 契约测试
    ↓
全局 interface_version 迁移
    ↓
插件设置配置传递
    ↓
config_version 状态迁移
    ↓
集成测试与长期仿真
    ↓
基线差异审查
    ↓
项目负责人审批新基线
```

插件设置传递和 `config_version`
迁移是两条独立路径，工程上可以分别准备，但必须分别测试和验收。不得把其中一项通过视为另一项已完成。

------------------------------------------------------------------------

## 1. 本轮冻结的模型设计

### 1.1 修改范围

第一波只修改：

-   `05` 周期模块：扩展 `derived.phase_impact`
    从四维到九维，并增加角色级参数配置。
-   `09`
    情绪模块：消费九维向量，将疼痛、焦虑、易怒、积极情绪和亲密需求映射到情绪维度。

第一波不修改：

-   `08` regulation 调节模块；
-   `10` behavior 行为模块；
-   `07` stress/event 模块；
-   `12` API 错误详情公开策略；
-   角色卡自然语言生成规则；
-   插件投递决策逻辑。

### 1.2 周期阶段枚举和边界保持不变

现有四个阶段字符串必须原样保留：

-   `menstrual_like`
-   `follicular_like`
-   `ovulatory_like`
-   `luteal_like`

阶段边界和周期长度模型不变：

  阶段                归一化进度
  ------------------- ----------------
  `menstrual_like`    `[0, 0.18)`
  `follicular_like`   `[0.18, 0.44)`
  `ovulatory_like`    `[0.44, 0.53)`
  `luteal_like`       `[0.53, 1.00)`

自动周期长度默认值保持：

-   `base_days = 28.4`
-   `sd_days = 1.2`
-   `min_days = 24`
-   `max_days = 34`

不得新增运行时 `cycle_day` 输入，不新增独立
`luteal_length`，不重命名阶段枚举。`schema_version` 保持 `1`。

### 1.3 角色级周期配置

配置由插件设置承载，采用方案 A。建议设置对象：

``` json
{
  "cycleProfile": {
    "pain_sensitivity": 1.0,
    "luteal_sensitivity": 1.0,
    "mood_variability": 1.0,
    "intimacy_variability": 1.0
  }
}
```

引擎内部映射为：

``` js
config.cycle.profile
```

四个参数的合法范围均为 `[0, 1.5]`，默认值均为 `1.0`。

  ----------------------------------------------------------------------------------------------------
  参数                                唯一作用范围
  ----------------------------------- ----------------------------------------------------------------
  `pain_sensitivity`                  仅影响 `pain_load`

  `luteal_sensitivity`                仅影响黄体期权重对应的 `anxiety_delta`、`irritability_delta`
                                      分量

  `mood_variability`                  影响
                                      `anxiety_delta`、`irritability_delta`、`positive_affect_delta`

  `intimacy_variability`              仅影响 `intimacy_need_delta`
  ----------------------------------------------------------------------------------------------------

旧配置没有 `cycleProfile`
时使用默认值；显式合法配置必须保留。不得把这四个参数持久化到状态对象中；它们是角色级运行时配置。

### 1.4 九维 `phase_impact`

新向量字段及范围：

``` js
{
  physical_comfort: [-1, 1], // v2 语义：不含疼痛的身体舒适度
  energy: [-1, 1],
  sensitivity: [-1, 1],
  social_drive: [-1, 1],
  pain_load: [0, 1],
  anxiety_delta: [-1, 1],
  irritability_delta: [-1, 1],
  positive_affect_delta: [-1, 1],
  intimacy_need_delta: [-1, 1]
}
```

`physical_comfort` 的语义在 v2 中明确为**非疼痛身体舒适度**，疼痛独立由
`pain_load` 表示。

原四维矩阵中 `physical_comfort` 的数值调整如下：

  阶段                 旧值   v2 新值
  ----------------- ------- ---------
  menstrual_like      -0.10     -0.04
  follicular_like     +0.05     +0.05
  ovulatory_like      +0.03     +0.03
  luteal_like         -0.07     -0.05

旧矩阵的 `energy`、`sensitivity`、`social_drive` 保持不变。

新增五维初始矩阵如下（属于首轮待仿真校准参数，不代表真实生理数据）：

  -----------------------------------------------------------------------------------------------------------------
  阶段                 pain_load   anxiety_delta   irritability_delta   positive_affect_delta   intimacy_need_delta
  ----------------- ------------ --------------- -------------------- ----------------------- ---------------------
  menstrual_like            0.60           +0.15                +0.20                   -0.15                 -0.10

  follicular_like           0.05           -0.10                -0.10                   +0.20                 +0.05

  ovulatory_like            0.05           -0.05                -0.05                   +0.25                 +0.35

  luteal_like               0.20           +0.30                +0.35                   -0.10                 -0.05
  -----------------------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 2. 05：阶段权重与向量计算契约

### 2.1 已核实的 crossfade 实现事实

当前 `phase.mjs` 的 `phaseInfluence()` 使用线性插值：

``` text
result = (1 - w) * previous + w * next
w = clamp((progress - (boundary - window)) / (2 * window), 0, 1)
```

`w` 位于 `[0,1]`，边界两侧各有 `0.5` 天 crossfade，总过渡窗口为 `1`
天。只混合相邻两个阶段。

因此相邻阶段权重天然满足：

``` text
w_previous = 1 - w
w_next = w

∀p: w_p(progress) >= 0
Σ_p w_p(progress) = 1
```

阶段向量必须保持确定性：不读墙钟、不使用随机数、不写状态。周期长度采样使用的确定性随机流与阶段向量计算分离，随机数不得影响阶段权重或九维向量。

### 2.2 `phaseWeights()` 的接口裁决

必须新增导出函数：

``` js
phaseWeights(progress, cycleLengthDays)
```

具体参数和返回值结构应与当前 `phaseInfluence()`
的进度/周期长度计算约定一致，并在实现记录中写出精确结构。

约束：

1.  `phaseWeights()` 是 05 模块的可测试导出。
2.  `phaseInfluence()` 内部调用 `phaseWeights()`。
3.  `phaseInfluence()` 对现有调用方的外部签名和返回语义保持不变。
4.  不得把权重加入 `phase_impact`。
5.  不得将权重写入持久化状态。
6.  不得为了测试而改变生产 `ModuleResult.derived` 结构。
7.  M-C15 和权重约束测试直接调用 `phaseWeights()`，不通过 `phase_impact`
    反推权重。

### 2.3 九维向量完整公式

令 `M[p][k]` 表示阶段 `p` 对维度 `k` 的矩阵值，`w_p(progress)` 为
`phaseWeights()` 返回的阶段权重。

``` text
pain_load =
  clamp(
    pain_sensitivity * Σ_p w_p * M[p][pain],
    0, 1
  )

anxiety_delta =
  clamp(
    mood_variability *
    [
      Σ_(p != luteal_like) w_p * M[p][anxiety]
      + w_luteal_like * M[luteal_like][anxiety] * luteal_sensitivity
    ],
    -1, 1
  )

irritability_delta =
  clamp(
    mood_variability *
    [
      Σ_(p != luteal_like) w_p * M[p][irritability]
      + w_luteal_like * M[luteal_like][irritability] * luteal_sensitivity
    ],
    -1, 1
  )

positive_affect_delta =
  clamp(
    mood_variability * Σ_p w_p * M[p][positive_affect],
    -1, 1
  )

intimacy_need_delta =
  clamp(
    intimacy_variability * Σ_p w_p * M[p][intimacy_need],
    -1, 1
  )
```

`luteal_sensitivity` 只乘黄体阶段本身的 anxiety/irritability
矩阵分量，不乘混合后的最终结果；不影响疼痛、积极情绪或亲密需求。

裁剪只在 05 执行。09 不得再次静默裁剪九维向量。

### 2.4 05 配置读取与兼容

-   `config.cycle.profile` 缺失时，四个参数使用默认值 `1.0`。
-   参数存在但不是有限数值或超出 `[0,1.5]`
    时，按契约拒绝配置，不得静默钳制。
-   `phase_impact` 始终输出完整九维结构。
-   新向量不包含随机抖动。
-   新增的阶段权重不得作为 `derived` 字段输出。

------------------------------------------------------------------------

## 3. 09：情绪映射契约

### 3.1 既有通道保持

09 原有四维周期向量通道的 `0.6` 系数保持不变：

-   `energy`
-   `sensitivity`
-   `social_drive`
-   `physical_comfort`

原有 `cycle_sensitivity` → `stability` 通道保持：

``` text
-0.3 * (cycle_sensitivity - 0.5)
```

不得将 `cycle_sensitivity` 与新 `anxiety_delta` 混为同一参数或相互替代。

09
的其他来源（sleep、stress、regulation、recovery、noise、event、clamp）及其归属保持不变。

### 3.2 新映射权重

以下为第一轮初始权重，后续只能经仿真、差异审查和项目负责人批准调整：

  -------------------------------------------------------------------------------------
  权重              映射                                  允许范围               初始值
  ----------------- ------------------------- -------------------- --------------------
  `w_pain_pc`       `pain_load` →                      \[0, 0.30\]                 0.20
                    `physical_comfort` 负向                        

  `w_pain_energy`   `pain_load` → `energy`             \[0, 0.20\]                 0.10
                    负向                                           

  `w_anx_stab`      `anxiety_delta` →                  \[0, 0.25\]                 0.15
                    `stability` 负向                               

  `w_anx_sens`      `anxiety_delta` →                  \[0, 0.20\]                 0.10
                    `sensitivity` 正向                             

  `w_irr_stab`      `irritability_delta` →             \[0, 0.20\]                 0.12
                    `stability` 负向                               

  `w_irr_sens`      `irritability_delta` →             \[0, 0.20\]                 0.12
                    `sensitivity` 正向                             

  `w_pos_stab`      `positive_affect_delta` →          \[0, 0.20\]                 0.10
                    `stability` 正向                               

  `w_pos_social`    `positive_affect_delta` →          \[0, 0.20\]                 0.10
                    `social_drive` 正向                            

  `w_intimacy`      `intimacy_need_delta` →            \[0, 0.35\]                 0.25
                    `closeness_need` 正向                          
  -------------------------------------------------------------------------------------

### 3.3 完整周期贡献公式

``` text
cycle_contrib.physical_comfort =
    + 0.6 * phase_impact.physical_comfort
    - w_pain_pc * phase_impact.pain_load

cycle_contrib.energy =
    + 0.6 * phase_impact.energy
    - w_pain_energy * phase_impact.pain_load

cycle_contrib.stability =
    - 0.3 * (cycle_sensitivity - 0.5)
    - w_anx_stab * phase_impact.anxiety_delta
    - w_irr_stab * phase_impact.irritability_delta
    + w_pos_stab * phase_impact.positive_affect_delta

cycle_contrib.sensitivity =
    + 0.6 * phase_impact.sensitivity
    + w_anx_sens * phase_impact.anxiety_delta
    + w_irr_sens * phase_impact.irritability_delta

cycle_contrib.social_drive =
    + 0.6 * phase_impact.social_drive
    + w_pos_social * phase_impact.positive_affect_delta

cycle_contrib.closeness_need =
    + w_intimacy * phase_impact.intimacy_need_delta

cycle_contrib.stress = 0
```

所有周期直接贡献仍归属
`contributions['mood.<dimension>'].cycle`，不新增贡献来源。

### 3.4 `closeness_need` 的现有来源：不可覆盖

代码核查确认，当前 `closeness_need` 并非只有一个来源：

  来源         当前计算
  ------------ -------------------------------------------
  cycle        当前为 0；本轮新增 intimacy 映射
  sleep        当前为 0
  stress       `0.1 * stress.level`
  regulation   `0.08 * (social_reassurance_drive - 0.5)`
  recovery     `(home - previous) * 0.6`，再乘 alpha
  noise        既有噪声项
  event        0
  clamp        用于吸收裁剪/边界差额

`social_reassurance_drive` 对 `social_drive` 和 `closeness_need`
是并行直接贡献，不是先改变 `social_drive` 再间接传导。

因此：

-   新增 `w_intimacy * intimacy_need_delta` 只加入 cycle 来源。
-   不替换 stress、regulation、recovery、noise 等既有来源。
-   不改变 `social_drive` 与 `closeness_need` 的并行计算关系。
-   M-C05 只验证新增的 cycle 直接贡献及原有来源保留，不得把最终
    `closeness_need` 非零作为唯一通过条件。

注意：09 对外 `contributions` 中记录的是乘过惯性系数 `alpha`
的实际贡献。M-C05 若验证最终贡献，应使用：

``` text
contributions['mood.closeness_need'].cycle
  = w_intimacy * phase_impact.intimacy_need_delta * alpha
```

若直接测试乘 alpha 之前的原始周期项，则应明确测试 `cycleTerms()`
或等效纯计算函数，不得混淆两种口径。

### 3.5 输入校验与旧四维兼容

09 对 `phase_vector` 的合法结构：

-   允许完整旧四维键集合，作为历史 v1 语义输入。
-   允许完整新九维键集合，作为 v2 语义输入。
-   拒绝只包含部分新字段的 5--8 维混合结构。
-   拒绝缺少任何旧四维必需字段的结构。
-   拒绝未知额外字段。
-   拒绝 `null`、字符串、`NaN`、`Infinity` 等非法数值。
-   拒绝超出字段约定范围的值；不得静默裁剪。

旧四维输入按历史语义处理：新五维字段补为 0；旧 `physical_comfort`
仍按旧语义解释。不得把旧向量直接当作新九维向量，也不得对旧数据再次叠加疼痛，造成双重计入。

新九维输入按 v2 语义处理：`physical_comfort` 不含疼痛，疼痛独立由
`pain_load` 进入映射。

### 3.6 惯性公式

当前代码实际使用的惯性公式是：

``` text
alpha = 1 - 2 ** (-dt_hours / tau)
```

不得误写成 `1 - exp(-dt_hours / tau)`。

例如 `dt = 3600s`、`tau = 4h` 时：

``` text
alpha ≈ 0.1591035847
```

按默认 menstrual_like profile：

``` text
raw cycle physical_comfort
  = 0.6 * (-0.04) - 0.20 * 0.60
  = -0.144
```

乘以 `alpha` 后，单步周期实际贡献约为：

``` text
-0.144 * 0.1591035847 ≈ -0.02291
```

------------------------------------------------------------------------

## 4. 版本、迁移与兼容性

### 4.1 版本目标

  项目                         目标
  ---------------------------- ---------------------------------------
  统一契约                     `v1.7.14`
  `schema_version`             保持 `1`
  阶段枚举                     保持原四个字符串
  插件 `apiVersion`            保持 `2`
  `interface_version`          全局迁移至 `2`
  `cycle.model_version`        升级至 `2`
  `mood.model_version`         升级至 `2`
  `regulation.model_version`   保持 `1`
  `config_version`             新状态为 `2`；旧状态从 `1` 迁移到 `2`

`interface_version` 是引擎模块接口版本，不等同于插件
`apiVersion`。仓库内部需要统一迁移；外部独立消费者是否存在不能仅凭仓库搜索证明不存在，实施记录不得作绝对断言。

### 4.2 `config_version` 的语义

`config_version`
是**持久化状态已完成配置语义迁移的标记**，不是运行时配置内容，也不随角色设置每次修改而递增。

-   新建状态直接初始化为 `config_version = 2`。
-   旧状态 `config_version = 1` 时，迁移一次至 `2`。
-   `cycle.profile` 来自当前插件运行时设置，不写入状态。
-   修改 `cycleProfile` 设置不触发 `config_version` 递增。

### 4.3 迁移函数与调用点

为避免"统一迁移入口"含糊，契约指定以下函数：

``` js
migrateConfigVersion(state)
```

函数归属：`lib/core/models.mjs`。

调用点必须有两个：

1.  `createDefaultState()`：新状态创建路径直接得到
    `config_version = 2`；若内部调用迁移函数，必须保证新状态不经历错误的旧版语义分支。
2.  状态加载路径：repository 完成状态读取/反序列化后、状态首次进入
    coordinator/engine 推进前，调用 `migrateConfigVersion(state)`。

`repository.mjs`
不改变持久化数据结构，只负责将读取到的状态交给迁移函数处理。若当前
repository 结构与上述调用点不一致，Agent
必须在实施记录中指出实际加载入口、调用位置及调用顺序，再按本契约完成接入；不得把迁移推迟到周期推进时才执行。

迁移必须幂等：

-   `config_version = 2`：不重复改写。
-   `config_version = 1`：完成 v1→v2 配置语义迁移并标记为 2。
-   未知版本或非法版本：按状态/契约错误处理，不得静默当作最新版本。

### 4.4 `config_version` 与 `cycle.model_version` 独立迁移

两个版本号语义独立，不要求同一时刻升级。

合法中间状态：

``` text
config_version = 2
cycle.model_version = 1
```

含义：配置语义迁移已完成，但周期计算模型尚未在周期状态变更路径中升级。

要求：

-   `config_version` 在状态加载/初始化阶段迁移。
-   `cycle.model_version` 在周期状态变更入口升级。
-   必须覆盖
    `updateCycle()`、`advanceCycleDays()`、`applyManualCorrection()`
    三条变更路径。
-   粗推进路径会直接调用 `advanceCycleDays()`，不得漏掉。
-   推荐使用共享 finalize/helper，避免不同入口版本号处理不一致。
-   测试必须覆盖：旧状态加载后 `config_version=2` 且
    `cycle.model_version=1`；推进一天后 `cycle.model_version=2`。

### 4.5 旧四维到新九维语义迁移

这是语义迁移，不是简单追加五个字段。

旧版 `physical_comfort` 包含疼痛影响；新版 `physical_comfort`
仅表示非疼痛身体舒适度，疼痛由 `pain_load` 独立表示。

迁移矩阵：

-   menstrual_like：`physical_comfort -0.10` 改为 `-0.04`，新增
    `pain_load = 0.60`。
-   luteal_like：`physical_comfort -0.07` 改为 `-0.05`，新增
    `pain_load = 0.20`。
-   follicular_like、ovulatory_like 的 `physical_comfort` 保持原值。
-   其他旧维度保持既定矩阵。
-   不得保留旧 `-0.10` / `-0.07` 再叠加 pain_load，否则会重复计算疼痛。

对旧四维输入的兼容规则见 §3.5：新维度按 0 处理，旧 `physical_comfort`
保持历史语义。

------------------------------------------------------------------------

## 5. 插件设置配置传递

### 5.1 已核实基础设施

当前插件已有以下配置基础设施：

-   `plugin.json` 中存在 `settings` 和 `configSchema`。
-   `manifest.mjs` 中存在
    `DEFAULT_SETTINGS`、`SETTINGS_KEYS`、`settingProblem()`、`normalizeConfig()`。
-   `tools.mjs` 中的 `settingsOfRuntime()` 每次调用读取最新运行时配置。
-   当前 `engineConfigOf(state)` 只返回
    `{ timezone: state.timezone }`，周期 profile 尚未传入引擎。

因此采用方案 A，不另建外部配置存储，也不把角色参数固定写死为 1.0。

### 5.2 必须补齐的传递链路

``` text
settingsOfRuntime()
    ↓
normalizeConfig()
    ↓
engineConfigOf(state)
    ↓
runAdvance()
    ↓
advance({ config })
    ↓
updateCycle({ config })
```

要求：

1.  插件设置定义 `cycleProfile`，包含四个参数。
2.  `normalizeConfig()` 对缺省值、类型、有限性和范围进行校验。
3.  `engineConfigOf(state)` 或等效配置组装函数将插件设置映射为
    `config.cycle.profile`。
4.  `runAdvance()`
    使用本次调用获取的最新设置，不得只使用插件初始化时缓存的旧值。
5.  `advance()`、`updateCycle()` 当前已接受 `config`
    参数，本轮不修改它们的签名；只补齐传递。
6.  若设置读取失败或参数非法，按插件现有配置错误策略处理，不得静默回退到任意数值。
7.  配置传递测试与 `config_version` 迁移测试分开。

### 5.3 当前签名核查结果

已核查当前默认分支：

-   `advance(params)` 从参数对象解构 `config = {}`。
-   `updateCycle({ previous, inputs = {}, now, rng, config = {}, rngProvider = null })`
    已接受 `config`。
-   `advanceCycleDays({ cycle, deltaDays, rngProvider = null, config = {}, warnings = null })`
    已接受 `config`。

因此不需要增加上述函数的 `config`
参数。实施记录仍应注明核查的分支/提交和文件位置，避免桌面工作区与远端默认分支不一致。

------------------------------------------------------------------------

## 6. 错误处理边界

### 6.1 `MODULE_FAILED` 已存在

代码核查确认：

-   `MODULE_FAILED` 已在现有模块/协调器错误处理中使用。
-   `coordinator.mjs` 对带有 `code` 的异常会直接透传；没有 `code`
    的异常才包装为模块失败。
-   因此本轮不新增错误码注册。

09 对九维向量非法输入必须主动抛出
`MODULE_FAILED`，异常对象内部至少包含：

``` js
{
  code: 'MODULE_FAILED',
  details: {
    module: 'mood',
    path: '...',
    got: '...'
  }
}
```

具体错误构造方式应复用项目现有错误约定。

### 6.2 `DETAILS_ALLOWLIST` 不在本轮修改

当前 `api/errors.mjs` 的 `DETAILS_ALLOWLIST` 不包含 `module` 和
`got`。内部异常对象可保留完整 `module/path/got`，但 API
对外响应会过滤未允许字段。

本轮明确：

-   **不修改 `api/errors.mjs` 的 `DETAILS_ALLOWLIST`。**
-   M-C14 直接测试 mood 模块抛出的原始异常对象，不经过 API 响应序列化。
-   API 对外错误详情是否公开 `module`、`got`，由 12 的错误契约另行决定。
-   不得为了通过 M-C14 而扩大公开错误信息范围。

------------------------------------------------------------------------

## 7. 确定性、连续性与测试口径

### 7.1 确定性

05 的 `phaseWeights()` 和九维 `phase_impact` 必须是纯确定性计算：

-   不读系统时间；
-   不调用随机数；
-   不写状态；
-   相同输入得到相同输出。

周期长度采样的随机流与阶段向量计算隔离。不得将随机周期长度采样误写成阶段向量随机抖动。

### 7.2 连续性测试边界

M-C07、M-C15 的连续性检查对象是 05 新九维 `phase_impact`，不检查旧
`cycle_sensitivity` 通道。

原因：旧 `cycle_sensitivity` 是 08
的离散阶段查表通道，可能在阶段切换处变化；它不属于本轮 05 crossfade
向量连续性验收范围。

### 7.3 阶段权重测试

必须直接调用 `phaseWeights()` 验证：

-   所有权重有限；
-   每个权重 `>= 0`；
-   权重总和为 `1`，允许 `1e-9` 数值容差；
-   非过渡区只有当前阶段权重为 1；
-   过渡区仅相邻两个阶段权重非零；
-   周期首尾 wrap 边界正确；
-   相同输入输出一致。

生产 `phase_impact`
不暴露权重。生产代码是否保留运行时断言由性能规范决定，但测试必须验证上述约束。

### 7.4 M-C15 超限处理

每小时采样差值硬阈值：

``` text
max_hourly_delta <= 0.04 + 1e-6
```

`1e-6` 仅用于浮点比较。

-   `0.0400005`：可视为浮点容差内。
-   `0.0401`：失败。
-   `0.045`：失败。

超限时不得先放宽阈值。必须记录维度、阶段边界、采样时间、前值、后值、差值，并排查权重计算和插值实现。确认是实现偏离线性插值假设时，修实现，不改验收阈值。

理论最大变化率参考：

-   irritability：`0.8625 / 24 = 0.0359375` 每小时；
-   pain_load：`0.825 / 24 = 0.034375` 每小时。

测试仍必须实际采样，不能只通过端点理论计算代替。

------------------------------------------------------------------------

## 8. 测试矩阵 M-C01～M-C16

### M-C01：疼痛参数及原始贡献

默认 menstrual_like profile：

``` text
raw physical_comfort cycle contribution
= 0.6 * (-0.04) - 0.20 * 0.60
= -0.144
```

-   M-C01a：`pain_sensitivity = 1.0`，原始贡献约 `-0.144`，容差 `1e-6`。
-   M-C01b：`pain_sensitivity = 1.5`，原始贡献约 `-0.204`，容差 `1e-6`。
-   M-C01c：`pain_sensitivity = 0`，原始贡献约 `-0.024`，容差 `1e-6`。

注意：以上是乘 alpha 前的 raw cycle contribution。09
最终单步贡献还要乘对应维度 alpha，并受现有变化上限约束。

### M-C02：黄体焦虑

验证 luteal_like 的 `anxiety_delta` 经 `w_anx_stab` 对 stability
产生负向周期贡献。

### M-C03：黄体易怒

验证 luteal_like 的 `irritability_delta` 经 `w_irr_sens` 对 sensitivity
产生正向周期贡献。

### M-C04：卵泡期积极情绪

验证 follicular_like 的 `positive_affect_delta` 经 `w_pos_stab` 对
stability 产生正向周期贡献。

### M-C05：排卵期亲密需求

验证：

``` text
cycle raw closeness_need
= w_intimacy * intimacy_need_delta
```

以及最终已乘 alpha 的贡献：

``` text
contributions['mood.closeness_need'].cycle
= w_intimacy * intimacy_need_delta * alpha
```

同时验证 stress、regulation、recovery、noise
等原有来源未被覆盖或错误归入 cycle。不得仅断言最终 `closeness_need`
非零。

### M-C06：参数单调性与隔离

在 **05 `phase_impact` 输出层**验证四个 profile 参数的作用范围与隔离：

-   `pain_sensitivity` 只改变 pain_load。
-   `luteal_sensitivity` 只改变黄体阶段 anxiety/irritability 对应分量。
-   `mood_variability` 只改变 anxiety/irritability/positive_affect。
-   `intimacy_variability` 只改变 intimacy_need。

注意：在 09 层，pain_load 会按设计同时影响 `physical_comfort` 和
`energy`；因此不能要求 pain_sensitivity 在 09
的所有维度上只改变一个维度。隔离测试必须在 05 输出层做。

### M-C07：crossfade 连续性

对新 `phase_impact` 九维向量检查所有阶段边界连续性。排除旧
`cycle_sensitivity` 离散通道。

### M-C08：惯性和变化上限

验证真实 `alpha` 公式：

``` text
alpha = 1 - 2 ** (-dt_hours / tau)
```

验证正常单步、严重事件单步、硬上限和 clamp
归属。不得用指数自然常数公式替代。

### M-C09：08 regulation 不变

验证 08 输出与本轮之前一致；本轮不修改 regulation 模型。

### M-C10：确定性

相同输入、相同种子、相同配置得到相同 05 向量和 09
结果。阶段向量不消耗随机数。

### M-C11：旧配置与旧四维兼容

-   旧配置缺少 `cycle.profile` 时使用默认参数。
-   旧四维输入按历史语义处理，新五维为 0。
-   新九维输入按 v2 语义处理。
-   非完整结构、未知字段和非法值按契约拒绝。

### M-C12：长期仿真无漂移

执行多周期长期仿真，验证状态范围、周期推进、阶段切换和贡献累计没有非预期漂移。

### M-C13：黄体敏感度作用范围

`luteal_sensitivity` 从 `0.3` 调整到 `1.5` 时，不改变 follicular_like 的
anxiety/irritability 分量；只改变 luteal_like 分量及其 crossfade
中的黄体权重部分。

### M-C14：非法向量错误

非法九维向量由 mood 模块主动抛出 `MODULE_FAILED`，原始异常对象包含
`module/path/got`。测试直接捕获模块异常，不经过 API 层。不得要求本轮修改
`DETAILS_ALLOWLIST`。

### M-C15：逐小时变化率与权重约束

-   对完整周期按 3600 秒间隔实际采样。
-   覆盖 menstrual→follicular、ovulatory→luteal、周期 wrap 等边界。
-   九维向量中需要限制的独立维度逐项检查。
-   每小时变化硬阈值 `0.04 + 1e-6`。
-   权重非负且总和为 1 的检查直接调用 `phaseWeights()`。
-   记录所有超限点的具体维度、边界、时间和值。
-   不以理论端点计算代替实际采样。

### M-C16：旧 cycle_sensitivity 通道保留

验证旧 `cycle_sensitivity` 对 stability 的贡献仍为：

``` text
-0.3 * (cycle_sensitivity - 0.5)
```

并与新 anxiety/irritability/positive-affect
项按公式叠加，不替换、不覆盖。

------------------------------------------------------------------------

## 9. 全局接口版本迁移检查清单

`interface_version` 升级到 2 时必须全局一致，不得只改常量。

至少检查：

-   `constants.mjs`
-   cycle 模块硬编码的 interface/model version
-   regulation 模块本地 `INTERFACE_VERSION`
-   所有模块 `diagnostics.interface_version`
-   `coordinator.mjs` 模块结果校验
-   `docs/00-统一契约.md` 中接口版本声明
-   `CONTRACT_VERSION`
-   测试、fixture、stub、snapshot
-   `module_shape.test.mjs`
-   `contract.snapshot.json`
-   `_stubs.mjs`
-   `cycle_advance.test.mjs`
-   `assembly.shape.json`
-   其他仓库内搜索到的版本断言和模拟模块

必须先全仓搜索旧值，再逐项更新。不得只改 `constants.mjs`
后宣布迁移完成。

------------------------------------------------------------------------

## 10. 基线与验收

### 10.1 基线变化

默认 profile 虽然四个 gain 均为 1.0，但由于 `physical_comfort`
矩阵从旧语义改为非疼痛语义，默认周期贡献也会发生变化。

因此：

-   旧仿真输出不能直接视为新基线。
-   需要重新运行完整仿真和测试。
-   更新 `out/*.json` 或其他基线文件前，先生成差异报告。
-   项目负责人审批后才接受新基线。
-   Agent 不得为了让测试通过而直接覆盖旧基线、删除差异或降低断言。

### 10.2 完成标准

v1.7.14 实施完成至少需要：

1.  统一契约修订并通过一致性审查。
2.  05 实现和 05 契约测试通过。
3.  09 实现和 09 契约测试通过。
4.  全局 `interface_version` 迁移完成。
5.  插件设置运行时传递测试通过。
6.  `config_version` 初始化与旧状态迁移测试通过。
7.  集成测试和长期仿真通过。
8.  基线差异报告经项目负责人审批。

不得把单元测试通过描述为真实设备灰度、回滚演练或发布验收完成。

------------------------------------------------------------------------

## 11. Agent 分阶段执行要求

### 阶段 0：契约修订

只修改正式文档和测试计划，不改实现代码。将本文决策写入对应章节，至少包括：

-   §A.3：已核实事实、配置承载和版本目标；
-   §D.1：`phaseWeights()`、九维向量、完整公式和确定性；
-   §G：09 映射、`closeness_need` 来源和旧四维兼容；
-   §H：版本迁移、错误边界、配置传递；
-   测试章节：M-C01～M-C16 的精确口径。

完成后执行一次仓库代码与契约一致性审查。审查通过后再正式冻结 v1.7.14。

### 阶段 1：05

只实现 05：

-   新增 `phaseWeights()` 导出；
-   `phaseInfluence()` 内部调用它，保持原签名；
-   扩展九维 `phase_impact`；
-   实现四个 profile 参数；
-   完成周期状态各变更入口的 `cycle.model_version = 2`；
-   不改 09、08、10、API 错误详情和插件设置传递。

交付：改动文件列表、接口说明、M-C01～M-C07/M-C10/M-C11/M-C13/M-C15
对应测试结果。

### 阶段 2：09

只实现 09：

-   读取完整九维向量；
-   保留旧四维兼容；
-   实现新周期贡献映射；
-   严格校验向量；
-   mood 主动抛 `MODULE_FAILED`；
-   不改 `DETAILS_ALLOWLIST`；
-   保留 `cycle_sensitivity` 旧通道；
-   更新 mood model_version 至 2。

交付：改动文件列表、贡献公式、M-C01～M-C16 测试结果。

### 阶段 3：全局接口版本迁移

统一
`interface_version = 2`，检查所有模块、诊断、协调器、文档、fixture、stub、snapshot
和测试。

### 阶段 4：插件配置传递

完成 `cycleProfile` 设置定义、规范化、运行时读取和传递至
`config.cycle.profile`。验证每次调用读取最新设置。

### 阶段 5：状态配置迁移

实现
`migrateConfigVersion(state)`，在新状态创建和状态加载后、首次进入引擎前调用。验证独立版本中间态合法。

### 阶段 6：集成、仿真与基线审批

执行完整测试、长期仿真、基线差异审查。等待项目负责人审批，不得自行宣布基线冻结。

------------------------------------------------------------------------

## 12. 已核实代码事实与核查边界

以下事实已针对 GitHub 仓库当前默认分支进行代码核对：

1.  `phase.mjs` 的 `phaseInfluence()` 使用线性 crossfade。
2.  阶段权重只涉及相邻两个阶段，权重为 `1-w` 和 `w`，天然非负且和为 1。
3.  当前 `phaseInfluence()` 尚未暴露独立
    `phaseWeights()`，本轮按契约新增。
4.  `MODULE_FAILED` 已存在；coordinator 对带 `code` 的异常透传。
5.  `api/errors.mjs` 的 `DETAILS_ALLOWLIST` 不含 `module` 和
    `got`；本轮不修改。
6.  `phase.mjs` 的阶段影响计算是确定性纯计算，不使用随机数。
7.  插件已有 settings/configSchema、`normalizeConfig()` 等基础设施。
8.  `settingsOfRuntime()` 每次读取最新运行时配置。
9.  当前 `engineConfigOf(state)` 只返回
    `{ timezone: state.timezone }`，尚未传递 `cycle.profile`。
10. `advance()`、`updateCycle()`、`advanceCycleDays()` 当前均已接受
    `config` 参数，本轮不修改这些函数的参数签名。
11. 当前 09 的 `closeness_need` 已有
    stress、regulation、recovery、noise、clamp 等来源；cycle 当前为 0。
12. `social_reassurance_drive` 对 `social_drive` 和 `closeness_need`
    是并行直接贡献，不是串联传导。
13. 当前 09 惯性公式是 `1 - 2 ** (-dt_hours / tau)`。

核查边界：以上针对 GitHub
默认分支，不保证桌面工作区尚未推送的修改与远端一致。Agent
开始实施前必须核对当前分支、提交号和工作区状态，并在实施记录中注明。

------------------------------------------------------------------------

## 13. 禁止事项

-   不得重新命名四个周期阶段。
-   不得新增运行时 `cycle_day` 或独立 `luteal_length`。
-   不得将阶段权重加入 `phase_impact` 或持久化状态。
-   不得对阶段向量引入随机抖动。
-   不得在 09 静默裁剪非法九维输入。
-   不得将旧四维 `physical_comfort` 直接当成新语义并叠加疼痛。
-   不得覆盖 `closeness_need` 的 stress/regulation/recovery/noise
    等既有来源。
-   不得修改 08、10 或 API `DETAILS_ALLOWLIST`，除非另有明确变更授权。
-   不得把 `config_version` 与 `cycle.model_version` 合并为同一个迁移。
-   不得只升级一个周期入口而遗漏粗推进或人工校正入口。
-   不得只修改一个接口版本常量而遗漏全局引用。
-   不得未经审批覆盖基线。
-   不得把单元测试结果夸大为设备灰度、回滚演练或正式发布完成。

------------------------------------------------------------------------

## 14. 移交给 Agent 的首条任务

请先读取仓库当前分支、提交号、工作区状态及统一契约。将本文决策逐条映射到正式契约章节，列出文档差异和代码差异。**第一阶段只做契约修订与一致性审查，不修改实现代码。**

如发现本文与当前仓库代码不一致：

1.  给出文件路径、函数名和当前行为；
2.  说明与本文哪条契约冲突；
3.  提出最小修正方案；
4.  等待项目负责人确认后再改。

契约冻结后，严格按 §11
分阶段执行。每个阶段只修改该阶段授权范围内的文件，并提交测试结果和未完成事项。
