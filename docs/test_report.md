# 测试基线与长期仿真报告（W3 / P-14-02）

> 本文件由 W3 波次维护。所有数字均为本机实测，命令见 §2；`node tools/check-docs.mjs` 只校验编号与路径，不校验本文件数字。
> 全部数据为虚构角色状态模拟，不是人体医学模型，不用于诊断、治疗或健康预测。

## 1. 执行环境

- 系统：Windows / Windows PowerShell 5.1
- 运行时：Node v24.19.0
- 依赖：零第三方依赖（仓库无 `package.json`，测试仅用 `node:test` / `node:assert` / `node:fs` / `node:crypto` / `node:child_process`）
- 工作目录：`bio-mood-engine`

## 2. 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test "tests/contract/*.test.mjs" "tests/integration/*.test.mjs"` | 76 通过 / 0 失败，4.71 s |
| `node --test --test-concurrency=1`（全量） | 475 通过 / 0 失败，33.23 s |
| `node --test "tests/unit/*.test.mjs"` | 375 通过 / 0 失败，2.00 s |
| `node --test "tests/contract/*.test.mjs"` | 13 通过 / 0 失败，0.79 s |
| `node --test "tests/integration/*.test.mjs"` | 63 通过 / 0 失败，3.92 s |
| `node --test "tests/simulation/*.test.mjs"` | 22 通过 / 0 失败，20.11 s |
| `node --test --experimental-test-coverage` | 475 通过 / 0 失败；all files 行覆盖 90.40% / 分支 79.08% / 函数 90.17% |
| `node tools/check-docs.mjs` | PASS（缺失路径 0，缺失用例编号 0） |

- 总用例：475
- 通过：475
- 失败：0
- 失败项复现种子：无（无失败用例）
- 说明：目录形式 `node --test tests/unit` 在 Node 24 会报 `MODULE_NOT_FOUND`，统一使用带引号的 glob。
- 说明：默认并发（每文件并行）下 T12 的「纯 chunk <0.4 ms/次」会被同机其它测试抢占 CPU 而偶发超限（实测 0.50 ms/次），故性能门禁与全量回归统一用 `--test-concurrency=1` 串行执行；串行实测 0.36 ms/次。
- 说明：`--experimental-test-coverage` 会注入 V8 插桩（实测纯 chunk 由 0.28 ms/次升至约 0.41 ms/次），因此 T12 在 `NODE_V8_COVERAGE` 存在时只记录数值、不判定性能阈值；性能门禁以无插桩的 `node --test` 为准。

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
| 纯 chunk 计算（8 模块，2000 次均值） | 0.2801 ms/次 | 0.4 ms/次 | 达标（余量 30%） |
| 端到端 advance（含事务与存储，1000 次 P95） | 0.341 ms | 15 ms | 达标 |
| 4320 步离线推进（含 10 年粗推进） | 960.2 ms | 2000 ms | 达标，且给出 LONG_OFFLINE_COARSE |
| nextU32 100 万次 | 98.6 ms | 2000 ms | 达标 |
| 插件包构建 | 18.2 ms（仅模块加载 + setup 代理，不含 ZIP 打包） | 30 s | 达标（打包见 `scripts/pack-plugin.mjs` 与 `release_manifest.test.mjs`；ZIP 打包墙钟单独执行） |
| node --test 全量 | 33.23 s | 120 s | 达标（串行 `--test-concurrency=1`，475 用例） |

## 5. 长期仿真

| 场景 | 步数 | 最终版本 | 指纹 | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 90 天 | 2160 | — | `34207ec79b7d53dc` | 779.4 ms | S1–S8 全部满足（<2 s） |
| 365 天 | 8760 | — | `8fef794e59cde3bd` | 2965.1 ms | S1–S8 全部满足（<8 s） |
| SIM01 平静一周 | 504 | v546 | `3db9b69d2a477d84` | 274.10 ms | 无贴边、无越界 |
| SIM02 高强度冲突日 | 24 | v66 | `bf7214c73c4e8ae5` | 16.07 ms | stress 峰值高于末尾 |
| SIM03 连续熬夜 | 120 | v162 | `fc7b088c4e5e0a10` | 45.37 ms | 睡眠债单调、无 NaN |
| SIM04 长期离线 30 天 | 720 | v43 | `c39fca8066f28c24` | 195.67 ms | 单次粗推进，无重复事件 |
| SIM05 睡眠中连续 @ | 12 | v54 | `e55c411b54e85953` | 9.19 ms | 未唤醒（sleepy），无跳跃 |
| SIM06 跨时区旅行 | 24 | v66 | `5034c2fc039b95e3` | 7.62 ms | 时区切换无非法转换 |
| SIM07 种子重置 | — | v43 | `7295a7d72e8adcfd` | 1.24 ms | 流计数器归零，其余状态不变 |
| SIM08 手工校正周期 | — | v43 | `2a5014fab708ee89` | 0.37 ms | 相位重算、版本 +1、审计 1 条 |

`tools/sim` 的 `offline_30d` 在 P-16-04 改窗后重跑：720 步、指纹 `e18285b9c7bfcc9f`、`assertions_failed=0`、`anomaly_counts={}`；`no_edge_run_hours` 最大 7 小时（改窗前为 39 小时，A6 告警 10 次），`sleep.sleepiness` 峰值 0.780916，`sleep.sleep_debt` 区间 `[0.067375, 0.416]`。

稳定性代理（T17）：同一 168 步确定性场景连续 10 轮（每轮 5 次共 50 次）指纹全部一致，为 `31e0436c9f8bde0f`；批次耗时 287.5 / 284.9 / 273.4 / 277.4 / 267.7 / 286.6 / 279.9 / 278.7 / 281.1 / 281.4 ms，去掉预热批与各两个极值后波动 1.01×（<1.2×）。

## 6. 覆盖率

| 范围 | 行覆盖 | 分支覆盖 | 函数覆盖 | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 全仓 all files（475 用例） | 90.40% | 79.08% | 90.17% | 行 ≥85% / 分支 ≥75% | 达标 |

> 表格只登记该命令 `all files` 行的实测值；目录级明细（`lib/core`、`lib/modules`、`lib/storage`、`lib/api`、`lib/adapters`）可在同一命令输出的 `file` 行按目录汇总，本版不再维护易漂移的逐目录数字。`lib/**` 行覆盖 90.40% 已高于 14 §5 要求的 85%，分支 79.08% 高于 75%。

## 7. 失败项

无失败用例（全量 475 / 0 fail）。实现缺陷在测试期被发现并已修复，但改动涉及 `lib/**`，与 14 §7 "不得修改 `lib/**`" 冲突，按用户授权"文件真实可执行优先"保留，需台账登记：

1. `lib/modules/cycle/index.mjs` 周期回绕舍入：`cycle_day` 以 6 位小数落盘，同一次推进的 predict 轮会读到 ±1e-6 天噪声，原逻辑把负向噪声判为 "cycle_day is ahead of elapsed" 并抛 `MODULE_FAILED`。复现：任意 `cycle.cycle_day` 非整数且 anchor 与 now 跨越回绕点时推进一次。建议在契约层明确容差（当前实现取 1e-5 天）。
2. `lib/storage/repository.mjs` 读取失败分类：`ensureReady` 的 `catch` 把宿主 `STORAGE_FAILED` 吞成 `INTERNAL`（T13 断言失败）。已改为原样上抛。建议 04 §5 明确"读失败 = STORAGE_FAILED，解析失败才走备份路径"。
3. `lib/storage/migrations.mjs` 迁移失败回滚粒度：04 §5.6 要求"用备份恢复"，原实现只回退一步，多步链会留下半迁移状态。已改为回滚到链首并保留 `state_backup`。建议 04 写明"恢复链首状态"。

## 8. 未解决项

1. `FUTURE_OCCURRED_AT` 已由 **P-02-02** 关闭：`POST /v1/events` 入口钳制 `occurred_at > received_at + 5min`，`data.diagnostics.warnings` 追加该码，`evlog` 写钳制值；正向断言在 A21（恰好 `+5min` 不钳制）。
2. 插件包构建基线：`scripts/pack-plugin.mjs` 已落地（P-13-06），T12 的"模块加载 + setup"仍作为 setup 耗时基线保留，打包墙钟由 `node scripts/pack-plugin.mjs` 单独执行（包清单自包含校验见 `release_manifest.test.mjs`）。
3. T17 为稳定性代理：在测试内重复 10 轮确定性场景；"全量套件连续执行 10 次"需人工按 §2 执行（串行单次 33.23 s，10 次约 332 s），本波次未跑。
4. Node v20 / v22 版本矩阵未执行，当前仅有 v24.19.0 证据。
5. W2 遗留测试文件的静态检索命中已由 **P-14-05** 允许清单处理（14 §10.2 列明 5 个 `tests/**` 文件与注释行规则，14 §9 检索命令改用 `Where-Object` 过滤，实测零输出）；引擎 `lib/core` / `lib/modules` 零命中，`lib/api`、`lib/storage`、`plugins/**` 属宿主边界不在门禁内。
6. `tests/simulation/perf.test.mjs`（14 §9 旧名）不存在，性能与仿真用例实际在 `tests/simulation/baseline.test.mjs`；14 §9 已同步更新。
