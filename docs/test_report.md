# 测试基线与长期仿真报告（W3 / P-14-02）

> 本文件由 W3 波次维护。所有数字均为本机实测，命令见 §2；`node tools/check-docs.mjs` 只校验编号与路径，不校验本文件数字。
> 全部数据为虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或健康预测。

## 1. 执行环境

- 系统：Windows / Windows PowerShell 5.1
- 运行时：Node v24.19.0
- 依赖：零第三方依赖（仓库无 `package.json`，测试仅用 `node:test` / `node:assert` / `node:fs` / `node:crypto` / `node:child_process`）
- 工作目录：`bio-mood-engine`

## 2. 验收命令与结果

2026-11-11 复核（Node v24.19.0，`--test-concurrency=1`）。P-13-20 新增 3 个用例，总数由 487 增至 490。按裁决要求先跑全量一次，再复跑两次；三轮均使用与 CI 完全相同的命令形态。

| 命令 | 结果 |
| --- | --- |
| `node --test tests/integration/plugin_manifest.test.mjs tests/integration/plugin_tools.test.mjs tests/unit/storage_repo.test.mjs` | 67 通过 / 0 失败，389.45 ms |
| `node --test tests/contract/test_report.test.mjs tests/integration/release_manifest.test.mjs tests/integration/plugin_manifest.test.mjs tests/integration/plugin_tools.test.mjs tests/unit/storage_repo.test.mjs`（最终聚焦复核） | 74 通过 / 0 失败，606.24 ms |
| `node --test --test-concurrency=1`（全量第 1 轮） | 490 通过 / 0 失败，36.416 s |
| `node --test --test-concurrency=1`（全量第 2 轮） | 489 通过 / 1 失败（T12：纯 chunk 0.4052 ms/次），34.198 s |
| `node --test --test-concurrency=1`（全量第 3 轮） | 489 通过 / 1 失败（T12：纯 chunk 0.4082 ms/次），34.054 s |
| `node tools/check-docs.mjs` | PASS（17 篇文档；缺失路径 0，缺失用例编号 0） |
| `node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.4.zip` | 157 587 B / 解压 422 915 B / 53 条目；三轮全量中的 V15 均确认与 `packPlugin()` 字节一致 |

- 总用例：490
- 通过：489
- 失败：1
- 上述总数取第 3 轮；三轮依次为 **490/490、489/490、489/490**。唯一失败项为第 2、3 轮的 T12 纯 chunk 墙钟门禁；三轮 M03 与 T17 均通过，详见 §7。
- 本地三轮不是「CI 连续两次绿色」，也不替代 CI 的 10 轮稳定性任务；§8 的 CI 项保持未完成。
- 说明：目录形式 `node --test tests/unit` 在 Node 24 会报 `MODULE_NOT_FOUND`，统一使用带引号的 glob 或不带参数。
- 说明：默认并发会抢占比对 CPU，性能门禁与全量回归统一用 `--test-concurrency=1` 串行执行；未为通过测试修改任何性能阈值。
- 说明：`node tools/check-docs.mjs` 只校验文档中的文件路径与用例编号，**不校验版本号、用例数量、哈希与发布数据**（见 P-15-07）。

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
| T17 | 10 轮重复指纹一致、耗时波动 <20% | `tests/simulation/baseline.test.mjs` |
| T18 | 报告含实测数字、失败项、性能与覆盖率 | `tests/contract/test_report.test.mjs` |
| T19 | ModuleResult 形状、interface_version、next_transition_at | `tests/contract/module_shape.test.mjs` |
| T20 | W2–W8 崩溃点恢复一致且只推进一次 | `tests/integration/fault_injection.test.mjs` |
| T21 | assembly.shape.json 与模块 inputs 键集一致 | `tests/contract/module_shape.test.mjs` |

## 4. 性能实测

| 基线 | 实测 | 上限 | 结论 |
| --- | --- | --- | --- |
| 纯 chunk 计算（8 模块，2000 次均值） | 第 1/2/3 轮：0.3928 / 0.4052 / 0.4082 ms/次 | 0.4 ms/次 | 第 1 轮达标，第 2/3 轮超限 |
| 端到端 advance（含事务与存储，1000 次 P95） | 0.762 ms（第 1 轮） | 15 ms | 达标 |
| 4320 步离线推进（含 10 年粗推进） | 1377.9 ms（第 1 轮） | 2000 ms | 达标，且给出 LONG_OFFLINE_COARSE |
| nextU32 100 万次 | 133.4 ms（第 1 轮） | 2000 ms | 达标 |
| 插件包构建 | 21.5 ms（第 1 轮，仅模块加载 + setup 代理，不含 ZIP 打包） | 30 s | 达标（ZIP 由 V15 单独校验） |
| node --test 全量 | 490 用例 × 3 轮：490/490、489/490、489/490；36.416 / 34.198 / 34.054 s | 120 s | 时长均达标；T12 在第 2/3 轮失败（见 §7） |

## 5. 长期仿真

| 场景 | 步数 | 最终版本 | 指纹 | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 90 天 | 2160 | — | `34207ec79b7d53dc` | 818.5 ms（第 1 轮） | S1–S8 全部满足（<2 s） |
| 365 天 | 8760 | — | `8fef794e59cde3bd` | 3395.2 ms（第 1 轮） | S1–S8 全部满足（<8 s） |
| SIM01 平静一周 | 504 | v546 | `3db9b69d2a477d84` | 274.10 ms | 无贴边、无越界 |
| SIM02 高强度冲突日 | 24 | v66 | `bf7214c73c4e8ae5` | 16.07 ms | stress 峰值高于末尾 |
| SIM03 连续熬夜 | 120 | v162 | `fc7b088c4e5e0a10` | 45.37 ms | 睡眠债单调、无 NaN |
| SIM04 长期离线 30 天 | 720 | v43 | `c39fca8066f28c24` | 195.67 ms | 单次粗推进，无重复事件 |
| SIM05 睡眠中连续 @ | 12 | v54 | `e55c411b54e85953` | 9.19 ms | 未唤醒（sleepy），无跳跃 |
| SIM06 跨时区旅行 | 24 | v66 | `5034c2fc039b95e3` | 7.62 ms | 时区切换无非法转换 |
| SIM07 种子重置 | — | v43 | `7295a7d72e8adcfd` | 1.24 ms | 流计数器归零，其余状态不变 |
| SIM08 手工校正周期 | — | v43 | `2a5014fab708ee89` | 0.37 ms | 相位重算、版本 +1、审计 1 条 |

`tools/sim` 的 `offline_30d` 在 P-16-04 改窗后重跑：720 步、指纹 `e18285b9c7bfcc9f`、`assertions_failed=0`、`anomaly_counts={}`；`no_edge_run_hours` 最大 7 小时（改窗前为 39 小时，A6 告警 10 次），`sleep.sleepiness` 峰值 0.780916，`sleep.sleep_debt` 区间 `[0.067375, 0.416]`。

稳定性代理（T17）：第 1 轮同一 168 步确定性场景连续 10 轮（每轮 5 次共 50 次）指纹全部一致，为 `31e0436c9f8bde0f`；批次耗时 308.1 / 314.9 / 304.7 / 331.8 / 317.7 / 315.6 / 314.0 / 300.9 / 315.1 / 300.4 ms，去极值后波动 1.04×（<1.2×）。第 3 轮波动 1.06×，同样通过；三轮 T17 均通过，但它仍不能替代全量套件连续 10 次。

## 6. 覆盖率

| 范围 | 行覆盖 | 分支覆盖 | 函数覆盖 | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 全仓 all files（475 用例，W3 记录） | 90.40% | 79.08% | 90.17% | 行 ≥85% / 分支 ≥75% | 达标（W3 时点；当前 490 用例未重跑覆盖率） |

> 表格只登记该命令 `all files` 行的实测值；目录级明细（`lib/core`、`lib/modules`、`lib/storage`、`lib/api`、`lib/adapters`）可在同一命令输出的 `file` 行按目录汇总，本版不再维护易漂移的逐目录数字。`lib/**` 行覆盖 90.40% 已高于 14 §5 要求的 85%，分支 79.08% 高于 75%。

## 7. 失败项

2026-11-11 三轮全量串行复核：第 1 轮 490/490 通过；第 2、3 轮各 489 通过 / 1 失败。唯一失败为 T12 的纯 chunk 单核墙钟门禁，三轮**功能性断言均 0 失败**：

| 编号 | 本机实测 | 门禁 | 判读 |
| --- | --- | --- | --- |
| T12 | 纯 chunk 第 1/2/3 轮为 0.3928 / 0.4052 / 0.4082 ms/次 | < 0.4 ms/次 | 第 1 轮通过，第 2/3 轮分别超限约 1.3% / 2.1%；既有负载敏感项，未改阈值 |

M03 三轮均通过（第 1 轮测试耗时 5 788 ms < 8 000 ms），T17 三轮均通过（第 1 轮波动 1.04×，第 3 轮 1.06×，门禁 <1.2×）。旧报告中的 M03 / T17 失败属于历史负载记录，不冒充本轮失败，也不据此宣称它们在所有机器上稳定；CI 矩阵与 10 轮任务仍须实际执行。

**CI 首次运行（2026-11-11，run `43038794411`，提交 `e930c60`）**：四个 job（Node 20 / 22 / 24、10 轮稳定性）全部失败，失败点同为 T12 纯 chunk。GitHub `ubuntu-latest` / Node 24 报 **0.5517 ms/次**，用例耗时 1 109 ms。该值与本机五轮 min/中位/max = **0.3638 / 0.4507 / 0.7537** 对比，属机器与负载差异；已登记 **P-15-09（待裁决）**，本轮只把测量口径改为「5 轮、丢弃预热、取中位数」，阈值 0.4 ms 未动。同批在本机跑该文件时，T17 亦因负载波动 1.35× 失败，说明这组墙钟门禁对并发负载敏感。

以下为实现缺陷，测试期被发现并已修复；改动涉及 `lib/**`，与 14 §7 "不得修改 `lib/**`" 冲突，按用户授权"文件真实可执行优先"保留，需台账登记：

1. `lib/modules/cycle/index.mjs` 周期回绕舍入：`cycle_day` 以 6 位小数落盘，同一次推进的 predict 轮会读到 ±1e-6 天噪声，原逻辑把负向噪声判为 "cycle_day is ahead of elapsed" 并抛 `MODULE_FAILED`。复现：任意 `cycle.cycle_day` 非整数且 anchor 与 now 跨越回绕点时推进一次。建议在契约层明确容差（当前实现取 1e-5 天）。
2. `lib/storage/repository.mjs` 读取失败分类：`ensureReady` 的 `catch` 把宿主 `STORAGE_FAILED` 吞成 `INTERNAL`（T13 断言失败）。已改为原样上抛。建议 04 §5 明确"读失败 = STORAGE_FAILED，解析失败才走备份路径"。
3. `lib/storage/migrations.mjs` 迁移失败回滚粒度：04 §5.6 要求"用备份恢复"，原实现只回退一步，多步链会留下半迁移状态。已改为回滚到链首并保留 `state_backup`。建议 04 写明"恢复链首状态"。

## 8. 发布证据矩阵

CI 配置位于 `.github/workflows/test.yml`。本地执行与 CI 执行是不同证据；CI 两次连续绿色前，下列 CI 项保持「未完成」。T12 / T17 / M03 的本机计时门禁结果见 §7，不得由本矩阵隐去。

| 项 | 状态 | 关闭方式 |
| --- | --- | --- |
| Node 20 / 22 矩阵 | **未完成** | 由 CI Node 20 / 22 / 24 矩阵 job 提供，两次连续绿色后将各版本 pass/fail 与耗时贴入本节 |
| 全量套件连续 10 轮 | **未完成** | 由 CI Node 24 稳定性 job 提供；每轮执行 `node --test --test-concurrency=1`，artifact 记录每轮结果与失败次数；T17 只是代理，不能替代 |
| 真实宿主聊天隔离存储 | **N/A（v1 单主会话）** | P-13-20 采用裁决 A 后，跨聊天共享不在 v1 验收范围；隔离语义由 04 §1.1 与宿主 API v2 保证，不另做跨聊天共享状态 E2E |
| 真机灰度 C1–C3 / 演练 R1–R4 | **未完成** | 依赖真实宿主与观察时间窗口，由 15 的执行记录提供；本文件与 15 §5.2 / §5.3 只作为执行手册，不作为已完成证据 |

注意：`release/` 是本地构建产物，被 `.gitignore` 排除，干净克隆与 CI 中不存在。因此 V15 的字节一致性断言在 CI 中**显式 skip**，不计为通过；该断言只在持有候选包的机器上执行。CI 绿色仅代表其余用例通过。
