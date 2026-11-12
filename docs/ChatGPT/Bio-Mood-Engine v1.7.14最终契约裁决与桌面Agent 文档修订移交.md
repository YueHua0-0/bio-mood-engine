# Bio-Mood Engine v1.7.14 最终契约裁决与实施方案

> 文档性质：最终裁决、契约收口与实施移交\
> 目标版本：`v1.7.14`\
> 状态：待完成正式文档修订与一致性审查后冻结；冻结前不得启动 C1
> 代码实施。

## 1. 最终裁决摘要

本轮设计方向通过审查，以下决定作为最终实施依据：

1.  `schema_version=1`
    保持不变；`interface_version=2`；`config_version=2`；`cycle.model_version=2`
    独立迁移。
2.  周期向量从旧四维扩展为九维。
3.  黄体期矩阵以正式任务书 05
    为唯一依据：`pain_load=0.35`、`anxiety_delta=+0.12`、`irritability_delta=+0.18`。移交稿中的
    `0.20/+0.30/+0.35` 废止。
4.  唯一阶段权重接口为 `phaseWeights(progress, cycleLengthDays)`；删除
    `lutealWeight()` 固定阶段权重表。
5.  `cycleLutealSensitivity` 只调制黄体阶段的焦虑、易激惹分量，并在
    crossfade 中按黄体实际权重连续生效。
6.  D1：插件设置使用四个扁平键；仅在引擎内部组装为
    `config.cycle.profile`。
7.  D2：旧四维不乘 profile；profile 只调制明确授权的新五维分量。
8.  09 对周期 `phase_vector` 执行独立严格校验，优先于通用
    clamp、`INPUT_CLAMPED` 或 `INVALID_REQUEST` 规则。
9.  `phaseInfluence()`
    保持现有调用参数签名和插值机制，但返回结构扩展为九维。
10. `phaseWeights()` 仅作为可测试导出，不进入
    `phase_impact`、`ModuleResult.derived` 或持久化状态。
11. 05 不得用 `clamp()` 静默修复非法 profile；配置层负责规范化。
12. P-15-08、P-15-09
    与周期扩展独立管理；不阻止契约冻结和模块开发，但仍是发布门禁。

## 2. 版本与迁移

  字段                      最终值    说明
  ----------------------- ----------- -----------------------------------
  `schema_version`            `1`     本轮不改变持久化 schema 主版本
  `interface_version`         `2`     九维周期接口升级
  `config_version`            `2`     profile 配置迁移
  `cycle.model_version`       `2`     周期模型独立升级
  文档契约版本             `v1.7.14`  00 文件头、变更记录、台账引用同步

`config_version` 与 `cycle.model_version` 是独立版本维度。合法中间态包括
`config_version=2, cycle.model_version=1`。不得因文档版本升级而把
`schema_version` 改为 2。

`migrateConfigVersion(state)` 建议放在 `lib/core/models.mjs`，在
`createDefaultState()` 和 repository load/deserialize
后、状态进入引擎前执行。迁移必须幂等。

周期模型迁移必须覆盖
`updateCycle()`、`advanceCycleDays()`、`applyManualCorrection()`，包括
coarse advance path。

## 3. 九维周期向量与阶段矩阵

九维字段：

``` js
{
  physical_comfort,
  energy,
  sensitivity,
  social_drive,
  pain_load,
  anxiety_delta,
  irritability_delta,
  positive_affect_delta,
  intimacy_need_delta
}
```

前四维为旧维度，后五维为新增维度。`physical_comfort`
表示非疼痛因素导致的身体舒适度；`pain_load` 独立表示疼痛负担。

### 3.1 黄体矩阵定版

  阶段              `pain_load`   `anxiety_delta`   `irritability_delta`
  --------------- ------------- ----------------- ----------------------
  `luteal_like`          `0.35`           `+0.12`                `+0.18`

以正式任务书 05 为唯一矩阵数据源。移交稿中的黄体值 `0.20/+0.30/+0.35`
全部废止。其他阶段矩阵值沿用正式 05
已裁决内容，不得在实现时自行推导或调整。

### 3.1.1 本轮新增及重定义的六维×四阶段核对表

正式九维矩阵以 `docs/05-生理周期模块.md` §5.3.1
为唯一数据源。本表仅摘录本轮新增或重新定义的六个维度，不构成第二份完整矩阵。表中数值必须与
05 §5.3.1 逐项核对；若本表与 05 冲突，以 05 为准，并修正本表。

**新增五维**

  ----------------------------------------------------------------------------------------------------------------------------
  阶段                  `pain_load`   `anxiety_delta`   `irritability_delta`   `positive_affect_delta`   `intimacy_need_delta`
  ------------------- ------------- ----------------- ---------------------- ------------------------- -----------------------
  `menstrual_like`           `0.60`           `+0.15`                `+0.20`                   `−0.15`                 `−0.10`

  `follicular_like`          `0.05`           `−0.10`                `−0.10`                   `+0.20`                 `+0.05`

  `ovulatory_like`           `0.05`           `−0.05`                `−0.05`                   `+0.25`                 `+0.35`

  `luteal_like`              `0.35`           `+0.12`                `+0.18`                   `−0.10`                 `−0.05`
  ----------------------------------------------------------------------------------------------------------------------------

**`physical_comfort` 重定义后的四阶段值（非疼痛语义）**

  阶段                  `physical_comfort`
  ------------------- --------------------
  `menstrual_like`                 `−0.04`
  `follicular_like`                `+0.05`
  `ovulatory_like`                 `+0.03`
  `luteal_like`                    `−0.05`

`energy`、`sensitivity`、`social_drive` 沿用 `docs/05` §5.3.1
的正式矩阵值，本文件不复制。实施时必须读取 05
的完整九维矩阵，不得将本核对表误认为完整九维矩阵。

### 3.2 旧四维兼容

旧版四字段输入兼容时： - 保留四个旧字段的旧语义； - 新增五维补 `0`； -
不因旧四维输入额外扣减 `pain_load`； - 旧四维不乘任何 profile。

新版九字段输入采用九维新语义。不得把旧四维 `physical_comfort`
误解释为已经包含疼痛的总舒适度。

## 4. 阶段权重与 crossfade

唯一正式导出接口：

``` js
phaseWeights(progress, cycleLengthDays)
```

返回值必须是**普通对象**，键恰为
`menstrual_like`、`follicular_like`、`ovulatory_like`、`luteal_like`，值为非负有限
`number`。四个键始终存在，零权重字段不得省略。不得返回
`Map`、数组或其他结构。

`phaseInfluence()` 内部调用它。`phaseInfluence()`
保持原有调用参数签名与插值机制，但返回九维向量。

权重必须返回四个阶段的完整对象，零权重字段也不得省略：

``` js
{
  menstrual_like: 0,
  follicular_like: 0,
  ovulatory_like: 0,
  luteal_like: 1
}
```

此对象仅示意非过渡区的返回形状。权重不变量： 1. 四个权重均为有限数值且
`>=0`。 2. 权重总和为 1，允许 `1e-9` 容差。 3.
非过渡区只有当前阶段权重为 1。 4. 过渡区仅允许相邻两个阶段权重非零。 5.
周期首尾 wrap 边界正确且连续。 6. 相同输入得到相同输出。 7.
不读取系统时间、不调用随机数、不写状态。 8. 权重不进入
`phase_impact`、`ModuleResult.derived` 或持久化状态。

删除 `lutealWeight()` 及其固定映射表，禁止并存两套权重定义。

### 4.1 黄体敏感度

`cycleLutealSensitivity` 只作用于黄体阶段的 `anxiety_delta` 与
`irritability_delta`
分量，不得影响非黄体阶段分量、旧四维、`pain_load`、`positive_affect_delta`
或 `intimacy_need_delta`。

crossfade 中必须使用 `phaseWeights()` 的实际
`w_luteal_like`，不得根据阶段枚举做二值开关，也不得在最终混合向量上对总值二次乘权重。

概念公式：

``` text
A_effective = A_non_luteal
  + w_luteal_like * cycleLutealSensitivity * M_luteal_anxiety

I_effective = I_non_luteal
  + w_luteal_like * cycleLutealSensitivity * M_luteal_irritability
```

实际实现应沿用阶段矩阵混合结构，避免对已混合总量重复加权。当
`w_luteal_like=0`
时，改变黄体敏感度不得改变结果；黄体权重增加时，其影响连续增加。

> 上述概念公式省略了 `mood_variability` 因子，仅用于说明
> `luteal_sensitivity`
> 的作用位置。完整计算规则如下；正式权威定义应同步写入
> `docs/05-生理周期模块.md` §5.3.2，本方案引用该定义，不另设第二套公式。

``` text
anxiety_delta = clamp(mood_variability *
  [ Σ_{p≠luteal_like} w_p * M[p][anxiety]
    + w_luteal_like * luteal_sensitivity * M[luteal_like][anxiety] ], -1, 1)

irritability_delta = clamp(mood_variability *
  [ Σ_{p≠luteal_like} w_p * M[p][irritability]
    + w_luteal_like * luteal_sensitivity * M[luteal_like][irritability] ], -1, 1)

positive_affect_delta = clamp(
  mood_variability * Σ_p w_p * M[p][positive_affect], -1, 1)
```

`mood_variability`
作用于焦虑、易激惹各自括号内的整体结果，也作用于正向情绪加权结果；`luteal_sensitivity`
只作用于焦虑和易激惹的黄体阶段分量，不作用于
`positive_affect_delta`。`clamp` 的具体边界及执行位置以 05
正式契约为准，不得据本段自行改变其他输入校验规则。

## 5. Profile 配置契约（D1 / D2）

### 5.1 D1：插件层扁平键

  插件设置键                   类型      默认值    合法范围
  ---------------------------- -------- -------- ------------
  `cyclePainSensitivity`       number    `1.0`    `[0, 1.5]`
  `cycleLutealSensitivity`     number    `1.0`    `[0, 1.5]`
  `cycleMoodVariability`       number    `1.0`    `[0, 1.5]`
  `cycleIntimacyVariability`   number    `1.0`    `[0, 1.5]`

插件层不得使用嵌套 `cycleProfile` 对象。进入引擎后才映射为：

``` js
config.cycle.profile = {
  pain_sensitivity,
  luteal_sensitivity,
  mood_variability,
  intimacy_variability
}
```

映射关系： - `cyclePainSensitivity` → `pain_sensitivity` -
`cycleLutealSensitivity` → `luteal_sensitivity` - `cycleMoodVariability`
→ `mood_variability` - `cycleIntimacyVariability` →
`intimacy_variability`

### 5.2 规范化责任

`normalizeConfig()` 负责类型、有限性及 `[0,1.5]`
范围校验。非法插件设置回退默认值 `1.0` 并记录 `FASTCFG_INVALID`。

05 引擎公式不得通过 `clamp(profile.x, 0, 1.5)` 静默吞掉非法值。若非法
profile 绕过配置层进入引擎，应按模块输入契约失败，不得静默裁剪或回退。

### 5.3 配置传递链路

``` text
settingsOfRuntime()
  → normalizeConfig()
  → engineConfigOf(state)
  → runAdvance()
  → advance({ config })
  → updateCycle({ config })
```

要求： - 每次运行读取最新 `ctx.config()`，不得只在初始化时读取。 -
`engineConfigOf(state)` 必须传递 profile，不能只返回 timezone。 - 现有
`advance()`、`updateCycle()`、`advanceCycleDays()` 已有 config
参数时，优先沿用现有签名，只补齐传递。 - HTTP 不开放 profile
请求体参数，固定使用默认 profile `1.0`。

### 5.4 D2：旧四维不乘 profile

D2 仅表示旧四维不受 profile 调制。新五维授权范围：

  -----------------------------------------------------------------------------------------
  Profile 参数             允许影响
  ------------------------ ----------------------------------------------------------------
  `pain_sensitivity`       `pain_load`

  `luteal_sensitivity`     黄体阶段的 `anxiety_delta`、`irritability_delta` 分量

  `mood_variability`       `anxiety_delta`、`irritability_delta`、`positive_affect_delta`

  `intimacy_variability`   `intimacy_need_delta`
  -----------------------------------------------------------------------------------------

profile 不得跨维度串扰。`pain_load` 在 09 层可按既定映射同时影响
`physical_comfort` 与 `energy`，因此 profile 隔离测试应在 05 的
`phase_impact` 输出层做。

默认值性质要求：`f(input, profile=all_ones) == f_baseline(input)`，其中四个参数均为
`1.0`。

## 6. 09 情绪计算引擎

### 6.1 计算规则

-   旧四维仍按既有 `0.6` 系数进入对应情绪维度。
-   旧 `cycle_sensitivity` 通道保留，不得删除或替换。
-   新五维通过九个既定映射系数进入情绪状态。
-   新增 `closeness_need` 的 cycle 来源是 additive，不替换
    stress、regulation、recovery、noise 等既有来源。
-   `contributions` 记录经过 alpha 加权后的实际贡献。
-   alpha 公式保持：

``` text
alpha = 1 - 2 ** (-dt_hours / tau)
```

不得替换为 `1 - exp(-dt/tau)`。

### 6.2 九个映射系数

  -----------------------------------------------------------------------------
  系数              映射                            范围            初始值
  ----------------- ------------------------- ---------------- ----------------
  `w_pain_pc`       `pain_load` →               `[0, 0.30]`         `0.20`
                    `physical_comfort` 负向                    

  `w_pain_energy`   `pain_load` → `energy`      `[0, 0.20]`         `0.10`
                    负向                                       

  `w_anx_stab`      `anxiety_delta` →           `[0, 0.25]`         `0.15`
                    `stability` 负向                           

  `w_anx_sens`      `anxiety_delta` →           `[0, 0.20]`         `0.10`
                    `sensitivity` 正向                         

  `w_irr_stab`      `irritability_delta` →      `[0, 0.20]`         `0.12`
                    `stability` 负向                           

  `w_irr_sens`      `irritability_delta` →      `[0, 0.20]`         `0.12`
                    `sensitivity` 正向                         

  `w_pos_stab`      `positive_affect_delta` →   `[0, 0.20]`         `0.10`
                    `stability` 正向                           

  `w_pos_social`    `positive_affect_delta` →   `[0, 0.20]`         `0.10`
                    `social_drive` 正向                        

  `w_intimacy`      `intimacy_need_delta` →     `[0, 0.35]`         `0.25`
                    `closeness_need` 正向                      
  -----------------------------------------------------------------------------

系数应集中维护，不得在多个模块中复制不同数值。

### 6.3 closeness_need additive 来源

``` text
cycle_contrib.closeness_need =
  w_intimacy * phase_impact.intimacy_need_delta

contributions['mood.closeness_need'].cycle =
  w_intimacy * phase_impact.intimacy_need_delta * alpha
```

stress、regulation、recovery、noise
等既有来源保持不变。`social_reassurance_drive` 对 `social_drive` 和
`closeness_need` 的既有并行影响关系保持不变。

### 6.4 周期向量严格校验

`MODULE_FAILED` 为既有错误码，本轮不新增。当前代码已有 `coordinator.mjs`
的 `moduleFailed()`、`mood/inertia.mjs` 中的既有使用，以及
`api/errors.mjs` 错误码表定义。周期向量严格校验由
`lib/modules/mood/index.mjs` 主动构造 `code='MODULE_FAILED'`
的异常，并在内部异常 `details` 中保留 `module='mood'`、`path` 和原始
`got`。coordinator 对带 `code` 的异常原样透传，不会自动把
`INVALID_REQUEST` 转换为 `MODULE_FAILED`。

本轮必须将当前 `readPhaseVector()` 的旧行为迁移到本节严格契约：不得将
`null` 当作缺失，不得对部分对象补零，不得对越界数值裁剪，也不得继续以
`INVALID_REQUEST` 代替本节要求的
`MODULE_FAILED`。这属于后续代码实施要求；本轮文档修订阶段不修改 `lib/`
代码。

09 只接受两种合法形状： - 恰好四字段：旧版； - 恰好九字段：新版。

严格校验必须先于通用 `INPUT_CLAMPED`、上游限幅或 NaN/Infinity 处理。

  -----------------------------------------------------------------------------
  输入                       行为                 path
  -------------------------- -------------------- -----------------------------
  `phase_vector` 属性不存在  周期缺失降级         ---

  属性存在且值为 `undefined` 周期缺失降级         ---

  `phase_vector: null`       `MODULE_FAILED`      `inputs.cycle.phase_vector`

  `phase_vector: {}`         `MODULE_FAILED`      `inputs.cycle.phase_vector`

  非对象或数组               `MODULE_FAILED`      `inputs.cycle.phase_vector`

  缺字段、多字段或未知字段   `MODULE_FAILED`      `inputs.cycle.phase_vector`

  字段类型错误               `MODULE_FAILED`      对应字段

  `NaN` / `Infinity`         `MODULE_FAILED`      对应字段

  数值越界                   `MODULE_FAILED`      对应字段
  -----------------------------------------------------------------------------

所有非法情况 `module='mood'`。数值越界的 `got`
保留原始非法值；形状错误的 `got`
保留原始对象值，按项目既有异常对象约定处理。

只有属性不存在或值为 `undefined`
时，才按周期缺失降级规则生成全零周期向量并记录
`MISSING_CYCLE_DATA`。`null`、空对象、部分对象均非法，不得静默补零、裁剪、字符串转数值或把
null 当缺失。

### 6.5 API 错误边界

-   内部异常对象保留 `module/path/got`。
-   本轮不修改 `api/errors.mjs` 的 `DETAILS_ALLOWLIST`。
-   M-C14 在 mood 模块内部测试原始异常对象，不经过 API 序列化。
-   API 对外是否公开 `module`、`got` 由 12 的错误契约决定。
-   不得为了通过 M-C14 而扩大公开错误信息范围。

## 7. phaseInfluence() 调用兼容

必须区分调用兼容与返回结构兼容：

  项目                            裁决
  ------------------------------- -------------------------------------
  现有调用参数签名                保持不变
  既有阶段边界及 crossfade 机制   保持已冻结规则
  旧四维字段                      保留，按新语义定义 physical_comfort
  返回结构                        扩展为九维
  新权重接口                      独立导出 `phaseWeights()`
  权重进入生产派生结果            不允许
  权重持久化                      不允许

正式文档不得再写"返回语义完全不变"。正确表述为：`phaseInfluence()`
保持现有调用参数签名与既有插值机制，返回结构扩展为九维；旧字段按本轮契约定义，新字段按九维矩阵生成。

## 8. 测试与验收

### 8.1 Profile 性质与隔离

必须验证： 1. 四个 profile 均为 `1.0` 时，输出与默认基线一致。 2.
单独改变每个 profile，只影响其授权分量（M-C06a：05 `phase_impact`
输出层隔离）。 2b. **09 贡献层隔离（M-C06b）**：在 09
贡献层，`pain_load` 的变化只改变 `physical_comfort` 和 `energy` 的 cycle
贡献，不改变
`stability`、`sensitivity`、`social_drive`、`closeness_need` 的 cycle
贡献。M-C06b 与 M-C06a 分开验收，不得合并为一条笼统断言。 3.
`w_luteal_like=0` 时，改变 `cycleLutealSensitivity`
不改变焦虑/易激惹分量。 4. 黄体权重增加时，黄体敏感度影响连续增加。 5.
旧四维不受 profile 影响。 6. 配置层非法值回退默认并记录
`FASTCFG_INVALID`；非法值绕过配置层进入引擎时不得静默 clamp。

### 8.2 权重测试

直接测试 `phaseWeights()`：权重有限、非负、和为 1（`1e-9`
容差）、非过渡区只有当前阶段为 1、过渡区仅相邻阶段非零、周期首尾 wrap
正确、相同输入输出一致，且不依赖随机数或系统时间。

### 8.3 严格输入测试

M-C14 至少覆盖： -
`pain_load=1.2`、`pain_load=-0.1`、`anxiety_delta=1.1`； -
`physical_comfort=null`、`energy="0.2"`； -
`sensitivity=NaN`、`social_drive=Infinity`； -
缺失必需字段、多出未知字段、五至八字段的部分对象； - `phase_vector`
不存在、`undefined`、`null`、`{}`。

逐项检查 `MODULE_FAILED`、`module='mood'`、精确 path 和原始
got；缺失与非法输入不得混淆。

### 8.4 M-C15 理论基线

硬阈值保持：

``` text
max_hourly_delta <= 0.04 + 1e-6
```

采用 05 定版矩阵、四个 profile 均为 `1.5` 时：

``` text
irritability_delta（ovulatory_like → luteal_like）
= (0.18 * 1.5 * 1.5) - (-0.05 * 1.5)
= 0.48

每小时变化 = 0.48 / 24
           = 0.020000
```

``` text
pain_load（menstrual_like → follicular_like）
= (0.60 - 0.05) * 1.5
= 0.825

每小时变化 = 0.825 / 24
           = 0.034375
```

当前矩阵下 pain_load 理论变化率约 `0.034375/小时`，低于 `0.04`
门槛。理论计算不替代实际逐小时采样测试。

移交稿原有 `0.8625/24=0.0359375` 的 irritability
基线依赖旧黄体矩阵，必须废止。不得因理论值降低而放宽阈值。若实测超限，记录维度、阶段边界、采样时间、前值、后值和差值，先排查权重及插值实现。

### 8.5 其他回归

-   14 中所有用于断言**当前接口版本**的 `interface_version === 1`
    测试、fixture、stub 和 diagnostics 预期值更新为 `2`，包括
    T19。为旧版本迁移或兼容性测试而有意构造的历史输入允许保留
    `1`，不得机械清除。
-   当前有效的 05 文档、代码、测试及正式契约中，`lutealWeight()`
    旧接口引用清零；已标注为历史稿的 `docs/ChatGPT/`
    正文和专门测试旧接口迁移的历史输入不要求清零。
-   `schema_version === 1` 断言保持不变。
-   08 regulation 输入、公式、输出不变，`model_version` 保持 1。
-   10 behavior 不改。
-   旧 `cycle_sensitivity → stability` 通道保留，并与新周期通道叠加。

## 9. 必须同步的文档

  ---------------------------------------------------------------------------------------------------------------------------------
  文件                                                                 修订要求
  -------------------------------------------------------------------- ------------------------------------------------------------
  `docs/00-统一契约.md`                                                文件头、变更记录升级
                                                                       `v1.7.14`；版本定义及九维契约同步；schema_version 保持 1

  `docs/05-生理周期模块.md`                                            黄体矩阵、`phaseWeights()`、profile 公式、移除
                                                                       `lutealWeight()` 和静默 clamp

  `docs/09-情绪计算引擎.md`                                            九维映射、四/九字段兼容、严格校验优先级及缺失/非法边界

  `docs/12-API服务与接口契约.md`                                       HTTP 不开放 profile 入参，默认 1.0；错误 allowlist
                                                                       本轮不扩大

  `docs/13-WeChatAgent插件适配层.md`                                   四个扁平设置项、类型、默认、范围、规范化、运行时读取与映射

  `docs/14-测试基线与长期仿真.md`                                      interface version 断言、矩阵、M-C06、M-C13、M-C14、M-C15
                                                                       同步

  `docs/ChatGPT/Bio-Mood_Engine_v1.7.14_契约冻结补充与实施移交版.md`   仅在文件头标注"历史稿 ·
                                                                       不具实施效力"，正文保留，不作为实施依据

  `docs/ChatGPT/月经周期情绪参数扩展方案_v1.7.14.md`                   仅在文件头标注"历史稿 ·
                                                                       不具实施效力"，正文保留，不作为实施依据

  `docs/冲突报告与问题台账_未裁决.md`                                  更新已裁决项状态及对应文档/测试编号
  ---------------------------------------------------------------------------------------------------------------------------------

职责边界：05 是阶段矩阵唯一数据源；00 定义总体契约；09
定义情绪计算和校验；13 定义插件配置与传递；14
定义测试验收。其他文档引用正式定义，不得维护第二套独立矩阵。

## 10. 实施顺序

### 10.1 契约收口：先改文档，不改代码

1.  00：版本头、变更记录与总体契约。
2.  05：黄体矩阵、`phaseWeights()`、profile 公式、移除 clamp。
3.  09：严格校验优先级、缺失与非法边界、九维贡献规则。
4.  13：四个扁平设置项与配置传递链路。
5.  14：接口版本、测试基线和 M-C15 理论计算。
6.  12：核对 HTTP 默认 profile 与错误边界。
7.  `docs/ChatGPT/`：统一或标注历史稿。
8.  未裁决台账：关闭已裁决冲突并记录依据。

全部完成后进行跨文档一致性审查。审查由项目负责人指定执行者；可由线上模型进行只读审查，由项目负责人最终签署。审查至少覆盖：

-   00 文件头、变更记录、九维白名单与 05/09 字段一致；
-   05 完整矩阵与 14 测试基线一致，`luteal_like` 的
    `pain_load/anxiety_delta/irritability_delta` 为 `0.35/+0.12/+0.18`；
-   05 中 `lutealWeight()` 及固定阶段表引用已从当前有效契约清除；
-   05 §5.3.2 的 profile
    公式与本方案公式说明一致，黄体敏感度仅调制黄体焦虑/易激惹分量；
-   09 严格校验边界表与 14 M-C14 覆盖项一致；
-   13 四个扁平设置键与 05 §5.3.2 的 profile 映射一致；
-   12 HTTP 默认 profile 与 05 §5.3.5 一致，且未开放 profile
    请求体参数；
-   所有用于断言当前接口版本的 `interface_version=1` 残留预期值已更新为
    `2`；旧版本迁移/兼容测试中的历史输入除外；
-   `docs/ChatGPT/` 两份文档均已标注历史稿，正文未被改写；
-   未裁决台账已更新，已裁决事项均有正式文档或测试依据。

审查通过并由项目负责人签署后，方可宣布 `v1.7.14` 契约冻结并启动
C3。此前不得启动 C1/C2/C4/C6。

### 10.2 代码实施：依赖顺序

``` text
C3：constants 常量与版本定义
  ↓
C1：05 周期模块
  ↓
C2：09 情绪模块
  ↓
C4：插件配置链路（含 13 对应实现）
  ↓
C6：测试、性质验证与长期仿真
```

C3 前置是为避免 C1/C2
引用尚未建立的矩阵常量、系数常量或版本定义。实施前检查实际 import
依赖；如存在额外依赖，应补充说明，但不得改变模块逻辑依赖顺序。

每阶段必须记录实际修改文件、测试命令、测试结果和未解决问题。不得把未运行测试写成通过；不得顺手修改
08、10 或 API allowlist。

### 10.3 发布门禁

P-15-08 与 P-15-09 独立于 C1--C6：

-   P-15-08：CI 两次连续绿色、真机灰度 C1--C3、回滚演练 R1--R4。
-   P-15-09：CI 复跑 T12 同进程归一化比值门禁，阈值 `3400`。

周期扩展可在两项关闭前开发和测试；正式发布仍必须满足两项门禁。周期扩展测试通过不等于
P-15-08/P-15-09 关闭。

## 11. 最终冻结检查表

-   [ ] 00 文件头、变更记录均为 `v1.7.14`。
-   [ ] `schema_version=1`、`interface_version=2`、`config_version=2`
    已明确。
-   [ ] `cycle.model_version` 独立迁移至 2。
-   [ ] 黄体矩阵统一为 `0.35/+0.12/+0.18`。
-   [ ] `phaseWeights(progress, cycleLengthDays)` 是唯一权重接口。
-   [ ] `lutealWeight()` 固定映射表已删除。
-   [ ] `phaseInfluence()` 保持调用签名，返回九维。
-   [ ] 黄体敏感度使用实际黄体权重，只调制黄体焦虑/易激惹分量。
-   [ ] 05 公式不再静默 clamp profile。
-   [ ] 插件层使用四个扁平设置键。
-   [ ] 13 已定义并传递四个设置项。
-   [ ] 09 周期向量严格校验优先于通用降级与限幅。
-   [ ] 缺失、undefined、null、空对象、错误形状、非法字段边界均已写清。
-   [ ] 12 未开放 HTTP profile 入参，默认值为 1.0。
-   [ ] 14 中 interface version 测试已更新为 2。
-   [ ] M-C15 理论基线按新矩阵重算，阈值仍为 `0.04 + 1e-6`。
-   [ ] `docs/ChatGPT/` 两份方案稿均已加"历史稿 ·
    不具实施效力"标注，正文保留。
-   [ ] §3.1.1 六维核对表已与 05 §5.3.1
    逐项核对一致，且未被误称为完整九维矩阵。
-   [ ] 未裁决台账已更新。
-   [ ] 跨文档一致性审查完成。

全部勾选并审查通过后，方可宣布 `v1.7.14` 契约冻结并启动 C3 → C1 → C2 →
C4 → C6。

## 12. 本方案不授权的事项

本文件是交给桌面 Agent
的文档修订与后续实施依据。本轮执行第一阶段仅限文档收口：不得修改 `lib/`
下任何代码，不得声称代码已经修改或测试已经通过，也不授权自动提交仓库。

本轮不授权： - 修改 08 regulation 公式或版本； - 修改 10 behavior
人格映射； - 扩大 `api/errors.mjs` 的 `DETAILS_ALLOWLIST`； - 将 profile
暴露为 HTTP 请求体参数； - 改变 P-15-08/P-15-09 的门禁阈值或关闭条件； -
未经仿真、差异审查与项目负责人批准调整九个映射系数； -
将阶段权重暴露为生产 API 或持久化字段。

**最终结论：** 采用本文件作为 v1.7.14
最终契约收口方案。先完成正式文档同步与跨文档一致性审查，再按 C3 → C1 →
C2 → C4 → C6 实施。P-15-08/P-15-09 保持独立，发布门禁不变。

## 13. 本轮桌面 Agent 执行指令（文档收口阶段）

本轮只执行文档修订，不启动代码实施。按以下顺序操作：

1.  对
    `docs/ChatGPT/Bio-Mood_Engine_v1.7.14_契约冻结补充与实施移交版.md`
    和
    `docs/ChatGPT/月经周期情绪参数扩展方案_v1.7.14.md`，仅在第一行标题之前插入以下历史稿声明；不删除、不重写正文：

    > **历史稿 · 不具实施效力**
    >
    > 本文件为 v1.7.14 设计讨论过程中的历史稿，仅用于追溯设计脉络。
    > 其中阶段矩阵、配置键结构、阶段权重接口、理论基线与正式任务书存在差异，**不得作为实施依据**。
    > 实施以
    > `docs/00-统一契约.md`、`docs/05-生理周期模块.md`、`docs/09-情绪计算引擎.md`、`docs/13-WeChatAgent插件适配层.md`、`docs/14-测试基线与长期仿真.md`
    > 为准。
    > 若本文件与上述正式文档冲突，以正式文档为准，且不得回写本文件。

2.  仅修改本方案对应的正式章节，完成本文件
    §3.1.1、§4、§4.1、§6.4、§8.1、§8.5、§9、§10.1、§11
    的补写和措辞修正。保留本文件其他已裁决内容；如发现与正式 05
    冲突，先记录冲突并停止，不得自行选值。

3.  同步正式文档：`00 → 05 → 09 → 13 → 14 → 12`。05 必须正式写入完整
    profile 公式，包括 `positive_affect_delta` 的 `mood_variability`
    规则；本方案不替代 05 的权威定义。

4.  更新
    `docs/冲突报告与问题台账_未裁决.md`，将本轮已裁决项关闭并记录正式依据。

5.  按 §10.1
    完成只读跨文档一致性审查，由项目负责人签署。审查通过后才能宣布契约冻结。

本轮明确禁止：

-   修改 `lib/`、测试实现代码或运行时逻辑；
-   修改 08 regulation、10 behavior；
-   扩大 `api/errors.mjs` 的 `DETAILS_ALLOWLIST`；
-   将 profile 暴露为 HTTP 请求体参数；
-   改变 P-15-08 / P-15-09 的阈值或关闭条件；
-   在冻结签署前启动 C1、C2、C4、C6；
-   未核对正式 05 就自行修改矩阵、系数、公式或 M-C15 理论基线。

冻结签署后，代码实施顺序为：

``` text
C3 → C1 → C2 → C4 → C6
```

C3
的常量新增/迁移范围须在开工前列明具体常量名、导出名、引用模块和依赖关系；不得以"先改
constants"为由顺手改变模块逻辑。P-15-08 / P-15-09 继续作为独立发布门禁。
