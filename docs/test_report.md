# 测试基线与长期仿真报告（W3 / P-14-02）

> 本文件由 W3 波次维护。所有数字均为本机实测，命令见 §2；`node tools/check-docs.mjs` 只校验编号与路径，不校验本文件数字。
> 全部数据为虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或健康预测。

## 1. 执行环境

- 系统：Windows / Windows PowerShell 5.1
- 运行时：Node v24.19.0
- 依赖：零第三方依赖（仓库无 `package.json`，测试仅用 `node:test` / `node:assert` / `node:fs` / `node:crypto` / `node:child_process`）
- 工作目录：`bio-mood-engine`

## 2. 验收命令与结果

2026-11-14 P2-C 复核（Node v24.19.0，`--test-concurrency=1`）。P2-B 新增 M-C15 独立小时级速率门禁 6 例与 M-C18 探索性统计 1 例；全量一次通过。

| 命令 | 结果 |
| --- | --- |
| `node --test --test-concurrency=1`（全量） | 614 通过 / 0 失败 / 0 跳过，55.830 s |
| `node --test tests/unit/cycle_hourly_rate.test.mjs` | 6 通过 / 0 失败，185.09 ms |
| `node --test tests/simulation/prompt_ratio_exploratory.test.mjs` | 1 通过 / 0 失败，2 614.69 ms |
| `node tools/check-docs.mjs` | PASS（17 篇文档；缺失路径 0，缺失用例编号 0） |

- 总用例：614
- 通过：614
- 失败：0
- 无失败用例。M-C15 / M-C17 / M-C18 的当前门禁状态见 §7.1。

2026-11-14 P6-D 文档收尾复核（Node `v24.19.0`，`--test-concurrency=1`）：全量 614 通过 / 0 失败 / 0 跳过，51.7749 s；`node tools/check-docs.mjs` PASS（17 篇文档）。本轮仅修改文档，复跑用于确认文档改动未影响仓库状态，不改变上述 P2-C 记录。

2026-11-11 复核（Node v24.19.0，`--test-concurrency=1`）。P-13-20 新增 3 个用例，总数由 487 增至 490。按裁决要求先跑全量一次，再复跑两次；三轮均使用与 CI 完全相同的命令形态。

| 命令 | 结果 |
| --- | --- |
| `node --test tests/integration/plugin_manifest.test.mjs tests/integration/plugin_tools.test.mjs tests/unit/storage_repo.test.mjs` | 67 通过 / 0 失败，389.45 ms |
| `node --test tests/contract/test_report.test.mjs tests/integration/release_manifest.test.mjs tests/integration/plugin_manifest.test.mjs tests/integration/plugin_tools.test.mjs tests/unit/storage_repo.test.mjs`（最终聚焦复核） | 74 通过 / 0 失败，606.24 ms |
| `node --test --test-concurrency=1`（全量第 1 轮） | 490 通过 / 0 失败，36.416 s |
| `node --test --test-concurrency=1`（全量第 2 轮） | 489 通过 / 1 失败（T12：纯 chunk 0.4052 ms/次），34.198 s |
| `node --test --test-concurrency=1`（全量第 3 轮） | 489 通过 / 1 失败（T12：纯 chunk 0.4082 ms/次），34.054 s |
| `node tools/check-docs.mjs` | PASS（17 篇文档；缺失路径 0，缺失用例编号 0） |
| `node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.4.zip` | **历史候选包快照（2026-11-11，不代表当前正式候选包）**：157 587 B / 解压 422 915 B / 53 条目；当时三轮全量中的 V15 均确认与 `packPlugin()` 字节一致。当前正式候选包为 164 688 B / 444 250 B / SHA-256 `9EEE29FC…8DBB9`，见 §2.1 |

- 总用例：490
- 通过：489
- 失败：1
- 上述总数取第 3 轮；三轮依次为 **490/490、489/490、489/490**。唯一失败项为第 2、3 轮的 T12 纯 chunk 墙钟门禁；三轮 M03 与 T17 均通过，详见 §7。
- 本地三轮不是「CI 连续两次绿色」，也不替代 CI 的 10 轮稳定性任务；§8 的 CI 项保持未完成。
- 说明：目录形式 `node --test tests/unit` 在 Node 24 会报 `MODULE_NOT_FOUND`，统一使用带引号的 glob 或不带参数。
- 说明：默认并发会抢占比对 CPU，性能门禁与全量回归统一用 `--test-concurrency=1` 串行执行；未为通过测试修改任何性能阈值。
- 说明：`node tools/check-docs.mjs` 只校验文档中的文件路径与用例编号，**不校验版本号、用例数量、哈希与发布数据**（见 P-15-07）。

### 2.1 当前正式候选包（P1 重建后）

| 字段 | 值 |
| --- | --- |
| 文件名 | `release/bio-mood-engine-0.1.4.zip` |
| ZIP 大小 | 164 688 B |
| 解压大小 | 444 250 B |
| 条目 | 53 |
| SHA-256 | `9EEE29FC3B9BD935F4404E7567CBF1B1B77CCC6F4FB7B87106C5A1A9F868DBB9` |
| 构建时间 | 2026-11-14 16:36:32（本机） |

该包由 P1 的文本 EOL 归一化修复后重建。P6 只读复核确认：大小与 SHA-256 与上表一致，53 个条目按名升序，条目集合与 `manifest.files` 一致，且与当前工作区 `packPlugin()` 输出逐字节相同。§2 中 2026-11-11 的 157 587 B / `BD9F8722…39DC6` 为历史候选包快照，不代表当前正式候选包。

### 2.2 P3 跨 Node 版本验证（2026-11-14，本机便携运行时）

| Node | 测试总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| v20.20.2 | 614 | 613 | 0 | 1 |
| v22.23.5 | 614 | 614 | 0 | 0 |
| v24.19.0（系统） | 614 | 614 | 0 | 0 |

- Node 20 的唯一跳过为 **SA-S1**：该运行时不存在 `node:sqlite`，属运行时能力差异，不是测试失败；SA-S2 回退路径用例仍然执行并通过。
- 打包验证：每个 Node 版本各执行 2 次打包，共 6 次；6 次产物大小均为 164 688 B，SHA-256 均为 `9EEE29FC3B9BD935F4404E7567CBF1B1B77CCC6F4FB7B87106C5A1A9F868DBB9`。
- **本记录是本机便携运行时验证，不是 GitHub Actions 的真实 CI 记录**；CI 侧对应证据见 §8（Run #27）。

### 2.3 P4 三十轮稳定性验证（2026-11-14，本机）

运行时：Node v20.20.2 / v22.23.5 / v24.19.0；命令 `node --test --test-concurrency=1`；每轮结束后各执行 2 次打包。

**Node 20**：10 轮，每轮 613 通过 / 0 失败 / 1 个预期跳过（SA-S1），10 轮均完成。

**Node 22**：

| 轮次 | 通过 | 失败 | 跳过 | T17 波动 |
| --- | ---: | ---: | ---: | ---: |
| r1 | 614 | 0 | 0 | 1.03× |
| r2 | 613 | 1 | 0 | 1.22× |
| r3 | 614 | 0 | 0 | 1.11× |
| r4 | 614 | 0 | 0 | 1.02× |
| r5 | 614 | 0 | 0 | 1.05× |
| r6 | 614 | 0 | 0 | 1.04× |
| r7 | 614 | 0 | 0 | 1.03× |
| r8 | 614 | 0 | 0 | 1.04× |
| r9 | 614 | 0 | 0 | 1.03× |
| r10 | 614 | 0 | 0 | 1.03× |

r2 的 T17 实测 1.22×，门禁为 < 1.2×，因此 **r2 是真实历史失败**，原样保留。r6–r10 是按补充授权执行的补齐验证，**不是对 r2 的修复或替代**；不得删除、弱化或隐藏该失败。

**Node 24**：10 轮，每轮 614 通过 / 0 失败 / 0 跳过。

**打包稳定性**：30 轮 × 每轮 2 次 = 60 次；60/60 产物大小均为 164 688 B，SHA-256 均为 `9EEE29FC3B9BD935F4404E7567CBF1B1B77CCC6F4FB7B87106C5A1A9F868DBB9`。

**P4 最终裁决：Conditional Pass（有条件通过）。**

遗留事项：

- **P4-C01**：Node 22 r2 T17 波动 1.22× 超限（门禁 <1.2×）。
- **P4-C02**：Node 22 后半程 4320 步耗时上升，仍需观察。
- **P4-C03**：Node 20 SA-S1 预期跳过（运行时无 `node:sqlite`）。
- **P4-C04**：GitHub Actions 跨版本 CI 已于 Run #27 验证通过（Node 20 / 22 / 24 与 Node 24 连续十轮，`head_sha = 4821c82…`），P4 裁决仍为 Conditional Pass，原因见 P4-C01 / P4-C02。

## 3. 用例矩阵 T01–T21

| 编号 | 内容 | 位置 |
| --- | --- | --- |
| T01 | 六目录存在、fixture 与 helpers 清单、无越界文件 | `tests/contract/file_manifest.test.mjs` |
| T02 | `forRandom(12345,1000)` 两次序列一致，失败输出 seed/i/value | `tests/unit/property_invariants.test.mjs` |
| T03 | 1000 组随机状态 I1/I2/I7，`mood.event` 贡献恒 0 | `tests/unit/property_invariants.test.mjs` |
| T04 | 两次推进与两次子进程摘要一致 | `tests/integration/determinism.test.mjs` |
| T05 | 同 idempotency_key 并发 10 次只推进一次 | `tests/integration/idempotency_concurrency.test.mjs` |
| T06 | 同角色并行 20 次全部串行完成、版本 +1 | `tests/integration/idempotency_concurrency.test.mjs` |
| T07 | 四时区 DST 本地小时、跨日、日长 | `tests/integration/clock_timezone.test.mjs` |
| T08 | 时钟回拨 -10min/-2min 的钳制与告警 | `tests/integration/clock_timezone.test.mjs` |
| T09 | 写入 → 子进程读取 → 指纹一致；损坏态明确报错 | `tests/integration/persistence_restart.test.mjs` |
| T10 | 迁移 1→2→3、幂等、失败整链回滚、缺步骤报错 | `tests/integration/migrations.test.mjs` |
| T11 | 契约快照：字段/枚举/错误码/警告码/日志字段 | `tests/contract/contract_snapshot.test.mjs` |
| T12 | 五项性能基线 | `tests/simulation/baseline.test.mjs` |
| T13 | set/get/delete 故障注入 → STORAGE_FAILED 无半写 | `tests/integration/fault_injection.test.mjs` |
| T14 | fixture/日志/报告隐私扫描 | `tests/contract/privacy_scan.test.mjs` |
| T15 | 边界值 0/1、越界拒绝、时间分块 | `tests/unit/boundary_values.test.mjs` |
| T16 | 8 个场景 + 2160/8760 步，S1–S8 | `tests/simulation/baseline.test.mjs` |
| T17 | 15 轮重复指纹一致、耗时波动 <20% | `tests/simulation/baseline.test.mjs` |
| T18 | 报告含实测数字、失败项、性能与覆盖率 | `tests/contract/test_report.test.mjs` |
| T19 | ModuleResult 形状、interface_version、next_transition_at | `tests/contract/module_shape.test.mjs` |
| T20 | W2–W8 崩溃点恢复一致且只推进一次 | `tests/integration/fault_injection.test.mjs` |
| T21 | assembly.shape.json 与模块 inputs 键集一致 | `tests/contract/module_shape.test.mjs` |

## 4. 性能实测

2026-11-14 A1–A3 / D1–D7 收尾复测，环境为 Windows / Windows PowerShell 5.1、Node v24.19.0。下表数据来自 `node --test --test-concurrency=1` 完整串行套件；T12 测试项耗时 8.929 s，全量耗时 51.577 s。

| 基线 | 实测 | 上限 | 结论 |
| --- | --- | --- | --- |
| 纯 chunk 计算（8 模块，5 轮归一化） | min / 中位 / max = 0.3177 / 0.3344 / 0.4560 ms/次；归一化比值 min / 中位 = 2900 / 3052 | 归一化比值 ≤3400 | 达标 |
| 端到端 advance（含事务与存储，1000 次 P95） | 0.567 ms | 15 ms | 达标 |
| 4320 步离线推进（含 10 年粗推进，连续 3 轮） | min / max = 1276.8 / 1471.5 ms；门禁采用最小值 1276.8 ms | 2200 ms | 达标，且给出 LONG_OFFLINE_COARSE |
| nextU32 100 万次 | 109.6 ms | 2000 ms | 达标 |
| 插件包构建 | 25.3 ms（仅模块加载 + setup 代理，不含 ZIP 打包） | 30 s | 达标（ZIP 由 V15 单独校验） |
| node --test 全量 | 604 用例：603 通过 / 1 失败 / 0 跳过；51.577 s | 120 s | 时长达标；唯一失败为既有 V15 候选包字节不一致，本阶段未处理 |

> P2-C 复核时同一命令为 614 例全部通过，耗时 55.830 s（T12 未单独计时），见 §2。

4320 步的 2200 ms 是 CI 环境校准值，不是算法或测量口径变更：提交 `563be5d`、CI run `116927688686`（2026-11-12）的历史 CI 最小值为 Node 20 **2058.0 ms**、Node 22 **2039.9 ms**、Node 24 **1246.5 ms**。这些 CI 数字与上述本机实测分开记录；连续 3 轮取最小值、4320 步上限及粗推进语义均未改变。

## 5. 长期仿真

| 场景 | 步数 | 最终版本 | 指纹 | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 90 天 | 2160 | — | `ff21aa8fbaeb8e74` | 810.5 ms | S1–S8 全部满足（<2 s） |
| 365 天 | 8760 | — | `e7b3c0aa0374f249` | 3516.8 ms | S1–S8 全部满足（<8 s） |
| SIM01 平静一周 | 504 | v546 | `7b69128ad15a5b5c` | 317.42 ms | 无贴边、无越界 |
| SIM02 高强度冲突日 | 24 | v66 | `b72bf074c2c22f6e` | 22.02 ms | stress 峰值高于末尾 |
| SIM03 连续熬夜 | 120 | v162 | `bb622576a0630e99` | 54.90 ms | 睡眠债单调、无 NaN |
| SIM04 长期离线 30 天 | 720 | v43 | `aeb8be8e96a95aa8` | 241.19 ms | 单次粗推进，无重复事件 |
| SIM05 睡眠中连续 @ | 12 | v54 | `c694aa968ee527b5` | 9.30 ms | 未唤醒（sleepy），无跳跃 |
| SIM06 跨时区旅行 | 24 | v66 | `6fea7698a548b835` | 9.96 ms | 时区切换无非法转换 |
| SIM07 种子重置 | — | v43 | `d8cbf01de0bb32ef` | 1.80 ms | 流计数器归零，其余状态不变 |
| SIM08 手工校正周期 | — | v43 | `152fda3e9cd05f9e` | 0.49 ms | 相位重算、版本 +1、审计 1 条 |

`tools/sim` 的 `offline_30d` 在 P-16-04 改窗后重跑：720 步、指纹 `e18285b9c7bfcc9f`、`assertions_failed=0`、`anomaly_counts={}`；`no_edge_run_hours` 最大 7 小时（改窗前为 39 小时，A6 告警 10 次），`sleep.sleepiness` 峰值 0.780916，`sleep.sleep_debt` 区间 `[0.067375, 0.416]`。

稳定性代理（T17）：本轮连续 15 轮指纹全部一致，为 `b36cb8a6f591abdb`；去极值后波动 1.05×（<1.2×），测试通过。T17 仍不能替代全量套件连续 10 次稳定性证据。

## 6. 覆盖率

| 范围 | 行覆盖 | 分支覆盖 | 函数覆盖 | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 全仓 all files（475 用例，W3 记录） | 90.40% | 79.08% | 90.17% | 行 ≥85% / 分支 ≥75% | 达标（W3 时点；当前 614 用例未重跑覆盖率） |

> 表格只登记该命令 `all files` 行的实测值；目录级明细（`lib/core`、`lib/modules`、`lib/storage`、`lib/api`、`lib/adapters`）可在同一命令输出的 `file` 行按目录汇总，本版不再维护易漂移的逐目录数字。`lib/**` 行覆盖 90.40% 已高于 14 §5 要求的 85%，分支 79.08% 高于 75%。

## 7. 失败项

2026-11-14 P2-C 全量串行复核：614 通过 / 0 失败 / 0 跳过，耗时 55.830 s，无失败用例。V15 在本机持有重建候选包时通过；该断言在 CI 与干净克隆中仍显式 skip（见 §8），不计为 CI 通过。

### 7.1 理论门禁状态（P2-B / P2-C）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| M-C15 | 已增加独立门禁，6 例通过 | `tests/unit/cycle_hourly_rate.test.mjs`：oracle 不读生产矩阵；覆盖四档 profile、21/28.4/35 天周期、阶段边界与环绕，并含两个负向对照；只适用于 1 小时 tick。理论上界 `0.55×1.5÷24 = 0.034375`，实测 0.034356（28.4 天折 681.6 h 的整点采样误差） |
| M-C17 | 仍阻塞 | `docs/14` 只给出结论性数值（`sensitivity` 增 ≤0.125、`stability` 降 ≤0.162）；未找到可核验的推导、实验脚本或历史测试，稳态口径与基线未定义，本轮未新增断言 |
| M-C18 | 探索性统计完成，暂不设正式门限 | `tests/simulation/prompt_ratio_exploratory.test.mjs` 只做结构断言，不设命中阈值；三个固定种子分别为 30/29/31 个窗口（33.3% / 32.2% / 34.4%）。`docs/14` 的"窗口数 ≥31"与台账"提示占比上限 35%"方向相反（`35%×90 = 31.5`），口径未裁决前不升级为正式门禁 |

> `physical_comfort < 0.45` 的阈值命中率只作为诊断项，不等价于 `behavior_notes` 的实际提示频率。

2026-11-14 A1–A3 / D1–D7 收尾全量串行复核（历史记录）：604 用例，603 通过 / 1 失败 / 0 跳过，耗时 51.577 s。唯一失败为历史 V15；该轮未处理该失败，也未修改或重建候选包。

| 编号 | 本机实测 | 门禁 | 判读 |
| --- | --- | --- | --- |
| V15 | `bio-mood-engine-0.1.4.zip` 与 `packPlugin()` 输出不一致 | 当前候选包与打包器逐字节一致 | 该轮失败源于候选包与检出状态的文本 EOL 漂移（P0 只读取证）；P1 在打包入口归一化 EOL 并重建候选包后，本机该断言通过 |

除 V15 外的 603 项全部通过，其中 T12、T16、T17、M03 均通过；M03 实测 5531.1639 ms（<8000 ms）。本轮新增 6 项测试全部通过，未出现本次修改引入的新失败。

**历史记录（2026-11-11）**：三轮全量串行复核：第 1 轮 490/490 通过；第 2、3 轮各 489 通过 / 1 失败。唯一失败为 T12 的纯 chunk 单核墙钟门禁，三轮**功能性断言均 0 失败**：

| 编号 | 本机实测 | 门禁 | 判读 |
| --- | --- | --- | --- |
| T12 | 纯 chunk 第 1/2/3 轮为 0.3928 / 0.4052 / 0.4082 ms/次 | < 0.4 ms/次 | 第 1 轮通过，第 2/3 轮分别超限约 1.3% / 2.1%；既有负载敏感项，未改阈值 |

M03 三轮均通过（第 1 轮测试耗时 5 788 ms < 8 000 ms），T17 三轮均通过（第 1 轮波动 1.04×，第 3 轮 1.06×，门禁 <1.2×）。旧报告中的 M03 / T17 失败属于历史负载记录，不冒充本轮失败，也不据此宣称它们在所有机器上稳定；CI 矩阵与 10 轮任务仍须实际执行。

**CI 首次运行（2026-11-11，run `43038794411`，提交 `e930c60`）**：四个 job（Node 20 / 22 / 24、10 轮稳定性）全部失败，失败点同为 T12 纯 chunk。GitHub `ubuntu-latest` / Node 24 报 **0.5517 ms/次**，用例耗时 1 109 ms。该值与本机五轮 min/中位/max = **0.3638 / 0.4507 / 0.7537** 对比，属机器与负载差异；已登记 **P-15-09**（当时为待裁决），本轮只把测量口径改为「5 轮、丢弃预热、取中位数」，阈值 0.4 ms 未动。同批在本机跑该文件时，T17 亦因负载波动 1.35× 失败，说明这组墙钟门禁对并发负载敏感。

**P-15-09 裁决 A 已落地（2026-11-11）**：chunk 门禁改为「每步耗时 / 同进程 `nextU32` 每次耗时」的归一化比值，5 轮丢弃预热取最小比值，门禁 **≤3400**；4320 步离线推进改为连续 3 轮取最小值，预算仍 2 s。本机三次单跑最小比值 **2572 / 3040 / 3121**，全部通过。本机 4320 步在 43% 持续后台负载下为 **2365–3092 ms**（同等代码空载记录 1377.9 ms），故本地绝对值不再用于判定。CI 复跑结果待补。

以下为实现缺陷，测试期被发现并已修复；改动涉及 `lib/**`，与 14 §7 "不得修改 `lib/**`" 冲突，按用户授权"文件真实可执行优先"保留，需台账登记：

1. `lib/modules/cycle/index.mjs` 周期回绕舍入：`cycle_day` 以 6 位小数落盘，同一次推进的 predict 轮会读到 ±1e-6 天噪声，原逻辑把负向噪声判为 "cycle_day is ahead of elapsed" 并抛 `MODULE_FAILED`。复现：任意 `cycle.cycle_day` 非整数且 anchor 与 now 跨越回绕点时推进一次。建议在契约层明确容差（当前实现取 1e-5 天）。
2. `lib/storage/repository.mjs` 读取失败分类：`ensureReady` 的 `catch` 把宿主 `STORAGE_FAILED` 吞成 `INTERNAL`（T13 断言失败）。已改为原样上抛。建议 04 §5 明确"读失败 = STORAGE_FAILED，解析失败才走备份路径"。
3. `lib/storage/migrations.mjs` 迁移失败回滚粒度：04 §5.6 要求"用备份恢复"，原实现只回退一步，多步链会留下半迁移状态。已改为回滚到链首并保留 `state_backup`。建议 04 写明"恢复链首状态"。

## 8. 发布证据矩阵

CI 配置位于 `.github/workflows/test.yml`。本地执行与 CI 执行是不同证据；CI 前两行已于 2026-11-14 取得首次绿色记录（Run #27），仓库原定关闭口径要求两次连续绿色，第 2 次待后续提交确认。T12 / T17 / M03 的本机计时门禁结果见 §7，不得由本矩阵隐去。

| 项 | 状态 | 关闭方式 |
| --- | --- | --- |
| Node 20 / 22 / 24 矩阵 | **已通过（Run #27，2026-11-14）** | GitHub Actions run [#27](https://github.com/YueHua0-0/bio-mood-engine/actions/runs/43586101525)：`completed / success`，`head_sha = 4821c825570c62d4c215f2e2031c037eede0e9c8`；Node 20 / 22 / 24 三个 job 均 success（65 s / 52 s / 77 s）。本机 P3 记录见 §2.2，不替代 CI |
| 全量套件连续 10 轮 | **已通过（Run #27，2026-11-14）** | 同一 run 的 `10 consecutive full-suite runs (Node 24)` job success（535 s），artifact `stability-node-24` 记录每轮结果与失败次数；T17 只是代理，不能替代。本机 P4 三十轮记录见 §2.3（Conditional Pass），同样不替代 CI |
| 真实宿主聊天隔离存储 | **N/A（v1 单主会话）** | P-13-20 采用裁决 A 后，跨聊天共享不在 v1 验收范围；隔离语义由 04 §1.1 与宿主 API v2 保证，不另做跨聊天共享状态 E2E |
| 真机灰度 C1–C3 / 演练 R1–R4 | **未完成** | 依赖真实宿主与观察时间窗口，由 15 的执行记录提供；本文件与 15 §5.2 / §5.3 只作为执行手册，不作为已完成证据 |

注意：`release/` 是本地构建产物，被 `.gitignore` 排除，干净克隆与 CI 中不存在。因此 V15 的字节一致性断言在 CI 中**显式 skip**，不计为通过；该断言只在持有候选包的机器上执行。CI 绿色仅代表其余用例通过。

**CI 与发布 ZIP 的边界**：Run #27 只执行源码测试，未构建、未比对发布包。正式候选包 `release/bio-mood-engine-0.1.4.zip`（164 688 B，SHA-256 `9EEE29FC3B9BD935F4404E7567CBF1B1B77CCC6F4FB7B87106C5A1A9F868DBB9`）与发布候选提交 `4821c825570c62d4c215f2e2031c037eede0e9c8` 的提交树重建结果逐字节一致，这一项是本机对提交树的验证，**不是 CI 的验证结果**。
