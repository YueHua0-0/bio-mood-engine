# 集成报告（0.1.3）

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.1.3 |
| 日期 | 2026-11-11 |
| 结论 | 本机端到端链路自测通过（P-13-19 多主会话 + P-13-18 状态页 + E01–E08） |
| 证据 | `tests/integration/e2e_scenarios.test.mjs`、`e2e_chain.test.mjs`、`release_manifest.test.mjs`、`tests/contract/plugin_ui.test.mjs` |

> 全部数值、文案与行为均为**虚构角色状态模拟**，不是人体医学模型，不用于诊断、治疗或现实健康预测。

## 1. 链路

微信消息 → 适配层（`text_hash` / `sender_id` / 事件标识派生）→ 引擎推进（`state_version + 1`）→ 交付策略与行为上下文 → DSH 生成 → 宿主发送 → 事件回报。

硬规则复核：
- 发送只由宿主/DSH 完成，插件不调用 `ctx.reply`（`tests/integration/plugin_hooks.test.mjs`）。
- `after-response` 为 `off` 时无第二次发送（`plugin_hooks` 用例）。
- 工具与钩子共享同一份只读快照，权威状态只在主聊天 `state` 键（`e2e_chain` 用同一 storage 串联插件与 HTTP 服务）。

## 2. 七个场景（15 §4.2）

| 编号 | 结果 | 关键断言 |
| --- | --- | --- |
| E01 普通群消息 | 通过 | `deliver_now`；`state_version` 0→1；`duplicate false` |
| E02 被 @ | 通过 | 冻结基表紧急度 0.60；`wake_cost` 与 11 §5.2 公式一致；回复概率 ∈[0,1] 且 6 位整数；延迟区间为整数二元组 |
| E03 睡眠冲突 | 通过 | `urgent_interrupt`；`sleep.state=waking_up`；版本只 +1 |
| E04 安慰事件 | 通过 | `stress` 不升；补 1 个 chunk（≥3600 s）后 `affection_expression` 不低于事件前 |
| E05 重复事件 | 通过 | 三次同参只有首次推进；`evlog` 中该事件仅 1 条 |
| E06 引擎不可用 | 通过 | 中止信号 → `DEGRADED`；`state` 原始值不变 |
| E07 睡眠中 3 条群消息 | 通过 | 第 3 条 `silent_ignore` + `coalesced_into.merged_count=3`；队列只剩最早 1 条；`reason_codes` 含 `sleeping`/`coalesced` |
| E08 排队项过期 | 通过 | 入队项带 `deliver_after`/`expires_at`；`tick` 过 `expires_at` 后队列清空，`evlog` 恰 1 条 `expired`（`silent_ignore`）；`dry_run` 不清理 |

## 3. 信息流串联（`e2e_chain`）

1. 插件 `observe` 写入 v1。
2. `GET /v1/state/{id}` 读到 v1，响应不含完整种子。
3. `POST /v1/events` 推进到 v2；同幂等键重放 `duplicate=true` 且 `processed_at` 不变。
4. `POST /v1/tick`（`dry_run=true`）只算不写，磁盘状态仍为 v2。
5. `POST /v1/admin/reset`（`reset_state`）返回新版本。
6. 插件"重启"（新 ctx、同一 storage）读回同一版本。
7. 日志与 `meta` 均不含完整种子；完整种子只存在于 `state.random`。

## 4. 发布包

| 项 | 实测 | 限额 |
| --- | --- | --- |
| ZIP | 155 766 B | ≤8 MiB |
| 解压 | 418 398 B | ≤16 MiB |
| 单文件 | ≤ 41 653 B | ≤4 MiB |
| 条目 | 53 | — |
| SHA-256 | `B02E641D1F488E51CFD145F4B89E368BD97D8F8054D3A221DD5DAD8BACFEBFDE` | — |

- 权限仅 `storage` / `history_read` / `reply`；`configSchema` 13 项（≤24），为「字段名 → Schema」扁平映射，`apiVersion` 为数字 `2`，含 `description`（P-13-08 修正）；Schema 关键词严格落在宿主受限子集内，已移除 `maxItems`（P-13-09）。
- 入口按官方样例对齐（P-13-10）：`api.registerTool({id, description, parameters, execute(ctx,args)})`，`execute` 仅返回 `{content}`；`hooks` 以宿主单参 `ctx` 调用（`ctx.message` / `ctx.text`）。
- 包内不含 `tests/`、`docs/`、`package.json`、`node_modules/`、sourcemap。
- 自包含：适配层与引擎统一放在包内 `lib/`，`index.mjs` 与 `lib/adapter/**` 的引用在打包时重写，测试逐条解析包内相对引用。
- 插件页面（P-13-18）：`ui.json`（216 B）+ `ui/{page.html,page.js,style.css}` 随包发布；页面只 import 宿主 `__sdk.mjs`，无内联脚本、无外网地址、无 `fetch`/`eval`，数据只走只读 action `read-state`。
- `release/bio-mood-engine-0.1.2.zip` 与打包器输出逐字节一致（可复现）；`0.1.1` / `0.1.0` / `0.0.9` 作为历史回滚包保留。0.1.2 起打包器放行 `ui/**`，旧包不再参与逐字节复现。

## 5. 未覆盖 / 已知限制

- 本机未接入真实微信宿主，E2E 使用宿主上下文替身（`tests/integration/_plugin_helpers.mjs`）。
- `engineMode=remote` 只有开关与降级映射，未接远程传输。
- 灰度 C1–C3 与 R1–R4 实机演练需在宿主环境执行，本机只验证了 R2/R4 的等价路径（`enabled=false`、`shadowMode=true`）。
- 状态页只读：页面 action 的 ctx 没有 `actor.id`，不提供 `tick` / `admin`；状态仍只从主会话读取，非主会话显示降级提示。
- 其余问题以 `docs/冲突报告与问题台账.md` 为准。
