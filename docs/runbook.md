# 运维手册（0.1.2）

> 本手册适用于 `bio-mood-engine` 0.1.2。全部数值与文案均为**虚构角色状态模拟**，不用于诊断、治疗或现实健康预测。

## 1. 安装与 bootstrap

1. 安装 `release/bio-mood-engine-0.1.2.zip`，确认未启用时零代码执行。
2. 在宿主设置中**同时**预置：
   - `primaryChatId`：主聊天会话 ID；
   - `adminActorIds`：管理员 wxid 明文（可带 `wxid_` 前缀，最多 8 个，逗号分隔）；插件内部转哈希，留空表示不修改、沿用上次填写；
   - `masterSeedHex`：32 位十六进制；留空则由首次 `observe` 生成。
3. 白名单为空时 `tick` 与全部 `admin` 动作返回 `UNAUTHORIZED`；`bind_primary` 不能用于 bootstrap，必须先手工预置 `primaryChatId`。
4. 启用后依次验证：`observe` 返回 `ok:true` → `state` 可读 → `before-context` 注入非空。

## 2. 日常操作

| 操作 | 步骤 | 注意 |
| --- | --- | --- |
| 查看状态 | `state` 工具或 `GET /v1/state/{character_id}` | 不返回正文 |
| 图形化状态页 | 控制台插件卡片 →「打开」→ 选择已授权会话 | 只读、30 秒刷新；非主会话显示降级提示，不会写盘 |
| 手动推进 | `POST /v1/tick`（`dry_run` 只算不写） | `now` 必须 ≥ 上次推进时间 |
| 手工校正周期 | `admin` + `manual_cycle_correction` | 版本 +1，写审计日志 |
| 重置状态 | `admin` + `reset_state` | 迁移失败后的唯一逃生舱 |
| 重置种子 | `admin` + `reset_seed` | 所有流计数器归零；先导出旧状态 |
| 导出/导入 | 导出 `state` + `meta`；导入前校验 `schema_version` | 导入失败不得半写 |

## 3. 开关与回滚

| 级别 | 动作 | 预期 |
| --- | --- | --- |
| R1 | 控制台关闭"允许此插件运行" | 工具不再被调用，聊天正常 |
| R2 | `settings.enabled=false` | 工具 `DEGRADED`、钩子空注入、不写状态 |
| R3 | 用 `state_backup` 覆盖 `state`，`state_version` 取备份值 | 校验通过、指纹等于备份 |
| R4 | `shadowMode=true` 或卸载插件 | 不注入上下文，回复链路不受影响 |

R1/R2 目标 1 分钟内完成；R3 覆盖前必须先备份当前状态；R4 不得删除数据。上一可用包 `release/bio-mood-engine-0.0.9.zip` 保留 ≥30 天。

## 4. 监控与阈值

| 指标 | 阈值 | 动作 |
| --- | --- | --- |
| 失败率 | >2% | 回滚上一阶段 |
| P95 延迟 | >3 s | 回滚并保留慢调用样本 |
| `DEGRADED` 比例 | >10% 排查，>25% 回滚 | 检查存储/引擎可用性 |
| `STATE_VERSION_CONFLICT` | >5 次/小时 | 回滚，排查多实例写同角色 |
| 存储占用 | 五键合计 >64 KiB | 触发摘要淘汰 |
| 幂等命中率 | 异常升高 | 检查上游重投 |

日志字段严格按 `00 §10.1`：`ts` / `level` / `event_id` / `state_version_before` / `state_version_after` / `elapsed_seconds` / `module_ms` / `reason_codes` / `error_code`。

## 5. 隐私与保留

| 项 | 要求 |
| --- | --- |
| 正文 | 不存、不传、不写日志 |
| wxid | 只存 `sha256` 前 12 位 |
| 种子 | 完整值只写 `state.random.master_seed_hex`，`meta` 只存 `master_seed_id`，不打印 |
| 应用日志 | ≤7 天或 20 MiB 滚动 |
| 事件日志 | 90 天 |
| 状态历史 | 插件模式仅 12 条摘要（`meta.snapshots`） |

## 6. 故障处置

| 现象 | 处理 |
| --- | --- |
| 安装后未启用即被调用 | 视为宿主缺陷，记录并停用 |
| 远程模式不可达 | 自动 `DEGRADED`，不阻塞聊天 |
| 回滚时备份损坏 | 停止 R3，改用 R4 |
| 升级后设置不兼容 | 版本回退 + 旧包重装，数据保留 |
| 用户投诉回复异常 | 先停插件，再定位 |

## 7. 常用命令

```powershell
node --test tests                       # 全量回归
node --test tests/integration/e2e_chain.test.mjs
node --test tests/integration/e2e_scenarios.test.mjs
node --test tests/integration/release_manifest.test.mjs
node tools/check-docs.mjs               # 文档与测试路径一致性
node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.2.zip
```
