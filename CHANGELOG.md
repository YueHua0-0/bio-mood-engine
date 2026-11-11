# CHANGELOG

本项目的全部数值、文案与行为均为**虚构角色状态模拟**，不是人体医学模型，不用于诊断、治疗或现实健康预测。

## 0.1.4 — 未发布候选（2026-11-11）

### 修改
- P-13-20 按裁决 A 恢复**单主会话**：`primaryChatId` 只接受一个 chat id；逗号/空白分隔的多值或多项数组均触发 `FASTCFG_INVALID`，回退为空主会话并显示「v1 只支持单主会话；多主会话需账号级共享存储（见 P-13-20 裁决）」。空值仍表示 `PRIMARY_UNBOUND`。
- 内部仍保留 `primaryChatIds` 数组形状，但仓库、钩子与调试回显只承认首项；即使绕过清单传入多个 ID，第二个聊天也只能只读，不写状态。不引入跨聊天读写或共享状态。
- 新增 Node 20 / 22 / 24 CI 全量测试矩阵与 Node 24 连续 10 轮稳定性任务；稳定性 artifact 记录每轮结果与失败次数，任一失败使任务失败，不使用 `continue-on-error` 掩盖。
- 修复插件状态页时钟显示：时间按 `state_summary.timezone` 渲染（此前用查看者本地时区，时区不一致会整体偏移）；改用 `hourCycle: 'h23'`，零点不再显示为 24 点；「更新于」补上日期，避免数天未推进的旧状态被误读为当前时间。

### 发布证据（尚未完成）
- CI 矩阵与连续 10 轮稳定性：**未完成**，需两次连续绿色后才能把结果写入 `docs/test_report.md` §8；T17 不能替代全量稳定性门禁。
- 真实宿主跨聊天共享状态 E2E：**N/A**。P-13-20 采用单主会话后，跨聊天共享不属于 v1 验收能力。
- 真机灰度 C1–C3 与回滚演练 R1–R4：**未完成**。本地聚焦测试 67/67 通过，不构成真实宿主验收证据。
- 本地三轮全量（Node 24.19.0）依次为 490/490、489/490、489/490；第 2/3 轮仅 T12 纯 chunk 墙钟门禁失败（0.4052 / 0.4082 ms vs 0.4 ms），M03 与 T17 三轮均通过。未修改阈值，详见 `docs/test_report.md` §2 / §7。

### 候选包与回滚
- 本地未发布候选 `release/bio-mood-engine-0.1.4.zip`：157 587 B，解压 422 915 B，53 个条目，SHA-256 `BD9F8722328A927A4D5835E6F5F5684D980E518D6F02D5A8B2F542E028B39DC6`。
- 回滚：上一可用包 `release/bio-mood-engine-0.1.3.zip`；生产只保留单个 `primaryChatId`。0.1.3 的已发布记录与 ZIP 原样保留，本节明确取代其多主会话口径。

## 0.1.3 — 2026-11-11

### 新增
- 多主会话共享引擎（P-13-19）：`primaryChatId` 现在接受逗号或空白分隔的多个 chat id（最多 8 项，合计 ≤ 512 字符）；任一命中的会话都能 observe/tick 写盘、都能注入模型上下文。

### 语义变更
- 之前：单 primary。非主会话一律 `NON_PRIMARY_READONLY`，`before-context` 返回空、`bio-mood-engine__state` 与 `bio-mood-engine__tick` 全部降级。
- 现在：多个主会话共享同一个角色的 state —— 群里被 @ 和私聊里被问，情绪都会被推动，更接近真人。非主会话依旧只读。

### 实现要点
- `normalizeConfig` 把 `primaryChatId` 逗号分隔字符串归一成运行期的 `primaryChatIds: string[]`。
- `createChatScopedRepo` 接受 `primaryChatIds` 数组；`primary_chat_id` meta 字段记逗号拼接的完整列表；`admin_source_key` 改用**当前 chatId**（admin 操作应当记在它实际发生的那个聊天上）。
- `hooks.mjs` 的上下文注入、`repo.mjs` / `tools.mjs` 的 scope 判定全部改成 `.includes(chatId)`。

### 发布包
- `release/bio-mood-engine-0.1.3.zip`：157 005 B，解压 421 738 B，53 个条目，SHA-256 `CCAA70057EB2DFD1D9BB16FA62581585EF3DF4E10B62D511BDFACB9EEE2941DA`（`packPlugin()` 可逐字节复现）。
- 回滚：上一可用包 `release/bio-mood-engine-0.1.2.zip`（155 766 B）。

### 已知问题
- 多主会话共享状态与宿主「账号 + 插件 + 聊天」隔离存储冲突，多聊天不共享权威状态（P-13-20，待裁决）。生产建议只配一个 `primaryChatId`。
- 本机性能门禁 T12 / T17 / M03 未达标（同 0.1.1、0.1.2，非本次回归），见台账 §8。

## 0.1.2 — 2026-11-11

### 新增
- 插件状态页：`ui.json` + `ui/{page.html,page.js,style.css}`，按周期 / 睡眠 / 压力 / 情绪四块展示，另附行为倾向与调节参数；只读、30 秒自动刷新（P-13-18）。
- 页面 action `read-state`：转调 `state` 工具，空参数 Schema，与模型工具共用同一套受限 Schema 自检。

### 修改
- `scripts/pack-plugin.mjs` 放行 `ui.json` 与 `ui/**`，发布包开始包含页面静态文件。
- 视觉按 `.trae/documents/明日方舟_罗德岛_UI设计主题规范.md` 落地：深色工业底板、1px 细线、切角、编号与状态灯；颜色优先继承宿主 `--wa-*`。

### 已知问题
- 宿主 `public/console/plugin-frame.mjs` 只透传 20 个 `--wa-*`，且 `MutationObserver` 只观察 `data-theme|style|class`；切换三个主题预设不会推送 `theme`。页面以宿主变量为主，并按 `--wa-bg` 底色识别罗德岛深色预设。
- 本机性能门禁 T12 / T16-90d / M03 未达标（同 0.1.1，非本次回归）。

### 发布包
- `release/bio-mood-engine-0.1.2.zip`：155 766 B，SHA-256 `B02E641D1F488E51CFD145F4B89E368BD97D8F8054D3A221DD5DAD8BACFEBFDE`。
- 回滚：上一可用包 `release/bio-mood-engine-0.1.1.zip`（144 879 B）。

## 0.1.1 — 2026-11-11

### 修改
- `adminActorIds` 改填**wxid 明文**（可带 `wxid_` 前缀），插件内部立即转 12 位候选哈希，明文不落盘、不回显（P-13-17）。
- 每项生成两个候选哈希（完整 wxid / 剥前缀主体，去重），任一命中即授权；已写成 12 位十六进制的存量值原样接受，大写归一为小写。
- **留空 = 不修改**：设置留空时沿用落盘的 `meta.admin_hashes`（最近一次非空设置，`observe` 事务内写入）；从未落盘过非空值仍 fail-closed 全拒。
- 生命周期版本号递增至 `0.1.1`，`plugin.json` 中 `adminActorIds` 的标题/描述/`maxLength`（160 → 512）同步。

### 已知问题
- 本机性能门禁 T12 / T16-90d / M03 未达标，判为整机单核性能约为阈值参考机 40%，非代码回归（见台账 §9 第二十六轮）。

## 0.1.0 — 2026-11-10

### 新增
- 引擎核心：`lib/core/{clock,random,models,coordinator,invariants}.mjs`，八模块按 `MODULE_ORDER` 装配，`advance()` 纯函数推进。
- 业务模块：周期（05）、睡眠（06）、压力（07）、事件（08）、调节（09）、情绪（10）、交付（11）、行为（13 §5.7）。
- 持久化：`lib/storage/{repository,plugin-storage,sqlite-store,file-store}.mjs`，五键单事务、乐观锁与迁移备份。
- HTTP 服务：`lib/api/*`，`/v1/events`、`/v1/state/{id}`、`/v1/tick`、`/v1/admin/reset`、`/health`、`/version`。
- WeChatAgent 插件：`plugins/bio-mood-engine/*`，四个工具（`observe`/`state`/`tick`/`admin`）与两个钩子（`before-context`/`after-response`）。
- 仿真回放：`tools/sim/*`，≥8 个确定性场景与 `diff` 对比。
- 发布工具：`scripts/pack-plugin.mjs`（自研 ZIP，零第三方依赖）。

### 修改
- `observe` 的进程内待交付队列改为以 `event.source.conversation_id` 为准；合并后同会话只保留 1 条保留项（`merged_count` 累加）。
- `tx.putMeta` 合并写入 `meta`，支持 ≤12 条状态摘要回放（C-12-01）。
- 事务中止判定移到 `ensureReady()` 之后，保证迁移日志 `migrated` 不丢失（P-13-02）。

### 已知问题
- `docs/冲突报告与问题台账.md` §3 为唯一问题清单；未裁决项与已验证项以台账为准。
- `engineMode=remote` 仅做开关与降级映射，未接入远程传输实现。
- `FUTURE_OCCURRED_AT` 目前按钳制处理，未独立返回专用错误码。

### 回滚方式
- R1：控制台关闭"允许此插件运行"。
- R2：`settings.enabled=false`（零注入、零写入）。
- R3：用 `state_backup` 覆盖 `state` 键，`state_version` 取备份值。
- R4：`shadowMode=true` 或卸载插件（回复链路不受影响）。
- 上一可用包：`release/bio-mood-engine-0.0.9.zip`（保留 ≥30 天）。
